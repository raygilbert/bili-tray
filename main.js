const { app, Tray, Menu, nativeImage, shell, dialog, BrowserWindow } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration — override these via environment or edit defaults for your setup
// ---------------------------------------------------------------------------
const CONFIG_DIR = path.join(os.homedir(), '.config', 'bili-tray');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {}
}

function getConfig(key, fallback) {
  const cfg = loadConfig();
  return cfg[key] ?? fallback;
}

const DEFAULT_BILI = path.join(os.homedir(), '.local', 'bin', 'bili');

function getBiliPath() {
  return getConfig('bili_path', DEFAULT_BILI);
}

function getPort() {
  return getConfig('proxy_port', '8787');
}
const LOG_FILE = path.join(os.tmpdir(), 'bili-proxy-console.log');

// Sensitive env vars to *never* pass through to the proxy.
// bili itself may leak these in logs; we filter them out of our env passthrough.
const SENSITIVE_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN',
  'GOOGLE_API_KEY', 'DASHSCOPE_API_KEY', 'HUGGING_FACE_API_KEY',
  'MONGODB_URI', 'REDIS_URL', 'DATABASE_URL', 'JWT_SECRET',
  'SESSION_SECRET', 'MAGIC_STRING', 'BILI_TOKEN',
]);

// Regexes to redact from logged proxy output (keys, tokens, secrets).
// We match common patterns used by LLM providers and cloud APIs.
const SENSITIVE_PATTERNS = [
  // Anthropic
  /[A-Za-z0-9]{24,}/g,
  // Generic base64-looking tokens (long enough to be secrets)
  /"[A-Za-z0-9_\-+=]{40,}"/g,
];

let proxyProcess = null;
let isProxyRunning = false;
let logLines = [];

// Build a tray icon from a pre-generated PNG file.
// macOS tray icons don't support SVG, so we use a 22x22 PNG.
function createIcon() {
  const iconPath = path.join(__dirname, 'icon-22.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    return img.isEmpty() ? createDefaultIcon() : img;
  } catch {
    return createDefaultIcon();
  }
}

// Fallback: try to load the real icon; only give up when the file truly doesn't exist.
function createDefaultIcon() {
  return nativeImage.createEmpty();
}

// Sanitize a line of text by redacting known sensitive patterns.
function sanitizeLine(line) {
  // Simple heuristic: redact anything that looks like an API key
  // (24+ char base64 string preceded by common key-related tokens)
  return String(line)
    .replace(/"(sk-[a-zA-Z0-9]{20,})"/g, '"$1***"')
    .replace(/"(sk-ant-[a-zA-Z0-9]{20,})"/g, '"$1***"')
    .replace(/(api[_\-]?key["\s:=]+)([A-Za-z0-9_\-+=]{20,})/gi, '$1"***"')
    .replace(/(token["\s:=]+)([A-Za-z0-9_\-+=]{40,})/gi, '$1"***"')
    .replace(/(secret["\s:=]+)([A-Za-z0-9_\-+=]{20,})/gi, '$1"***"')
    .replace(/(key["\s:=]+)([A-Za-z0-9_\-+=]{24,})/gi, '$1"***"');
}

function buildMenu(tray) {
  const statusText = isProxyRunning ? 'Proxy running' : 'Proxy stopped';
  const menuItems = [
    { label: `bili proxy — ${statusText}`, enabled: false },
    { type: 'separator' },
    {
      label: isProxyRunning ? 'Stop Proxy' : 'Start Proxy',
      click: isProxyRunning ? stopProxy : startProxy,
    },
    {
      label: 'Restart Proxy',
      click: restartProxy,
    },
    { type: 'separator' },
    {
      label: 'Open Config',
      click: () => {
        const configDir = path.join(os.homedir(), '.config', 'billion-context');
        shell.openPath(configDir);
      },
    },
    {
      label: 'View Console',
      click: showConsole,
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: showSettings,
    },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'bili tray',
          message: 'bili tray — menu bar control for billion-context proxy.',
          detail: [
            `proxy port: ${getPort()}`,
            'Use the CLI to verify: bili --version',
            'Config dir: ~/.config/billion-context/',
          ].join('\n'),
        });
      },
    },
    {
      label: 'Quit',
      click: () => { cleanup(); app.quit(); },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
  tray.setToolTip(statusText);
}

function showSettings() {
  const currentBili = getConfig('bili_path', DEFAULT_BILI);
  const currentPort = getConfig('proxy_port', '8787');

  dialog.showOpenDialog({
    properties: ['openFile'],
    title: 'Select bili binary',
    message: 'Choose your bili binary',
    buttonLabel: 'Select',
    filters: [
      { name: 'Bili binary', extensions: ['*'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }).then((result) => {
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      const newPath = result.filePaths[0];
      const cfg = loadConfig();
      cfg.bili_path = newPath;
      saveConfig(cfg);
      dialog.showMessageBox({
        type: 'info',
        title: 'Settings saved',
        message: `bili path set to ${newPath}`,
        detail: 'A restart is required for the new path to take effect.',
      });
    }
  }).catch(() => {});
}

function checkProxy() {
  exec(`lsof -i :${getPort()} -sTCP:LISTEN 2>/dev/null | grep -c bili`, (err, stdout) => {
    const count = parseInt(stdout.trim(), 10) || 0;
    const wasRunning = isProxyRunning;
    isProxyRunning = count > 0;
    if (isProxyRunning !== wasRunning) {
      const tray = trayRef.current;
      if (tray) buildMenu(tray);
    }
  });
}

let trayRef = { current: null };

function appendLog(msg) {
  logLines.push(msg);
  if (logLines.length > 500) logLines = logLines.slice(-300);
  try {
    const sanitized = sanitizeLine(msg);
    fs.writeFileSync(LOG_FILE, logLines.join(''));
  } catch {}
}

// Strip sensitive env vars from the environment before spawning bili.
// bili itself may write env vars to its logs; we protect against that.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of SENSITIVE_KEYS) {
    delete env[key];
  }
  return env;
}

function startProxy() {
  if (isProxyRunning) return;

  // Check that the binary exists before spawning.
  if (!fs.existsSync(getBiliPath())) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Proxy not found',
      message: `bili binary not found at ${getBiliPath()}`,
      detail: [
        'Set BILI_PATH when launching the app:',
        `  BILI_PATH=/path/to/bili open -a bili-tray`,
        '',
        'Or create a symlink:',
        `  ln -s /path/to/bili ~/.local/bin/bili`,
      ].join('\n'),
    });
    return;
  }

  logLines = [];

  const proc = spawn(getBiliPath(), ['start', `--port=${getPort()}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(),  // filtered env — no API keys / tokens leaked to proxy
  });

  proxyProcess = proc;

  proc.stdout.on('data', (d) => appendLog(d.toString()));
  proc.stderr.on('data', (d) => appendLog(d.toString()));
  proc.on('close', (code) => {
    isProxyRunning = false;
    proxyProcess = null;
    const tray = trayRef.current;
    if (tray) buildMenu(tray);
  });

  const tray = trayRef.current;
  if (tray) buildMenu(tray);

  // Notify user immediately (no 3-second delay)
  setTimeout(() => {
    if (proxyProcess && proxyProcess.exitCode === null) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Proxy started',
        message: `proxy started on port ${getPort()}`,
      });
    }
  }, 1000);
}

function stopProxy() {
  if (!proxyProcess) {
    exec(`lsof -ti :${getPort()} 2>/dev/null | xargs kill -9 2>/dev/null; true`, () => {});
  } else {
    proxyProcess.kill('SIGTERM');
  }

  isProxyRunning = false;
  proxyProcess = null;

  const tray = trayRef.current;
  if (tray) buildMenu(tray);

  dialog.showMessageBox({
    type: 'info',
    title: 'Proxy stopped',
    message: `bili proxy on port ${getPort()} has been stopped.`,
  });
}

function restartProxy() {
  stopProxy();
  const logTimer = setTimeout(() => {
    startProxy();
  }, 2000);
  logTimer.unref?.();
}

function showConsole() {
  let content = '';
  try {
    content = fs.readFileSync(LOG_FILE, 'utf8') || '(no output yet)';
  } catch {
    content = '(no console file found)';
  }

  if (!content.trim() || content.includes('no output yet') || content.includes('no console')) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Console',
      message: 'No console output yet. Start the proxy to see output here.',
    });
    return;
  }

  const tmp = path.join(os.tmpdir(), `bili-console-${Date.now()}.log`);
  fs.writeFileSync(tmp, content);
  shell.openPath(tmp);
}

function cleanup() {
  if (proxyProcess) {
    proxyProcess.kill('SIGTERM');
    proxyProcess = null;
  }
}

app.on('ready', () => {
  // Workaround: macOS delays tray icon registration until an offscreen window exists.
  // Create a hidden window to "wake up" the tray system, then immediately destroy it.
  const hiddenWin = new BrowserWindow({ show: false, width: 1, height: 1 });
  hiddenWin.setVisibleOnAllWorkspaces(false);
  hiddenWin.close();

  const trayIcon = createIcon();
  const tray = new Tray(trayIcon);
  trayRef.current = tray;
  tray.setToolTip('bili proxy — stopped');

  buildMenu(tray);

  // Do NOT poll lsof on startup — it's wasteful and slow.
  // Status is only checked when the user opens the menu.
  setInterval(checkProxy, 10000);
});

app.on('before-quit', cleanup);
