const { app, Tray, Menu, nativeImage, shell, dialog, BrowserWindow } = require('electron');
const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration — override these via environment or edit defaults for your setup
// ---------------------------------------------------------------------------
const ENV_FILE = path.join(os.homedir(), '.config', 'bili-tray-env');
function readEnvFile() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    const match = raw.match(/BILI_PATH="([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
const BILI = readEnvFile() || path.join(os.homedir(), '.local', 'bin', 'bili');  // default binary path
const PROXY_PORT = process.env.PROXY_PORT || '8787';
const LOG_FILE = path.join(os.tmpdir(), 'bili-proxy-console.log');

// Sensitive env vars to *never* pass through to the proxy.
// bili itself may leak these in logs; we filter them out of our env passthrough.
const SENSITIVE_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN',
  'GOOGLE_API_KEY', 'DASHSCOPE_API_KEY', 'HUGGING_FACE_API_KEY',
  'MONGODB_URI', 'REDIS_URL', 'DATABASE_URL', 'JWT_SECRET',
  'SESSION_SECRET', 'MAGIC_STRING', 'BILI_TOKEN',
  'AZURE_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID',
  'GOOGLE_APPLICATION_CREDENTIALS', 'MCP_SERVER_URL',
]);

// Sanitize arbitrary data chunks (binary-safe) by redacting known sensitive patterns.
function sanitizeChunk(chunk) {
  return String(chunk)
    .replace(/"(sk-[a-zA-Z0-9]{20,})"/g, '"$1***"')
    .replace(/"(sk-ant-[a-zA-Z0-9]{20,})"/g, '"$1***"')
    .replace(/(api[_\-]?key["\s:=]+)([A-Za-z0-9_\-+=]{20,})/gi, '$1"***"')
    .replace(/(token["\s:=]+)([A-Za-z0-9_\-+=]{40,})/gi, '$1"***"')
    .replace(/(secret["\s:=]+)([A-Za-z0-9_\-+=]{20,})/gi, '$1"***"')
    .replace(/(key["\s:=]+)([A-Za-z0-9_\-+=]{24,})/gi, '$1"***"');
}

const sanitizeLine = sanitizeChunk;

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
            `proxy port: ${PROXY_PORT}`,
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
      const filePath = result.filePaths[0];
      try { fs.accessSync(filePath, fs.X_OK); } catch {
        dialog.showMessageBox({ type: 'error', title: 'Not executable', message: `"${filePath}" is not executable.` });
        return;
      }
      const envFile = path.join(os.homedir(), '.config', 'bili-tray-env');
      const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      fs.writeFileSync(envFile, `BILI_PATH="${escaped}"\n`);
      dialog.showMessageBox({
        type: 'info',
        title: 'Settings saved',
        message: `bili path set to ${filePath}`,
        detail: 'A restart is required for the new path to take effect.',
      });
    }
  }).catch(() => {});
}

function checkProxy() {
  const socket = new net.Socket();
  socket.setTimeout(2000);
  const onSocketError = () => { socket.destroy(); };
  socket.on('error', onSocketError);
  socket.on('connect', () => {
    socket.destroy();
    const wasRunning = isProxyRunning;
    isProxyRunning = true;
    if (isProxyRunning !== wasRunning) {
      const tray = trayRef.current;
      if (tray) buildMenu(tray);
    }
  });
  socket.on('timeout', () => {
    socket.destroy();
    const wasRunning = isProxyRunning;
    isProxyRunning = false;
    if (isProxyRunning !== wasRunning) {
      const tray = trayRef.current;
      if (tray) buildMenu(tray);
    }
  });
  try {
    socket.connect(Number(PROXY_PORT), '127.0.0.1');
  } catch {}
}

let trayRef = { current: null };

function appendLog(msg) {
  logLines.push(msg);
  if (logLines.length > 500) logLines = logLines.slice(-300);
  try {
    fs.writeFileSync(LOG_FILE, logLines.map(sanitizeChunk).join(''));
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
  if (!fs.existsSync(BILI)) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Proxy not found',
      message: `bili binary not found at ${BILI}`,
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

  const proc = spawn(BILI, ['start', `--port=${PROXY_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(),  // filtered env — no API keys / tokens leaked to proxy
  });

  proxyProcess = proc;

  proc.stdout.on('data', (d) => appendLog(d.toString()));
  proc.stderr.on('data', (d) => appendLog(d.toString()));
  proc.on('error', (err) => {
    isProxyRunning = false;
    proxyProcess = null;
    dialog.showMessageBox({
      type: 'error',
      title: 'Proxy error',
      message: `Failed to start proxy: ${err.message}`,
    });
    const tray = trayRef.current;
    if (tray) buildMenu(tray);
  });
  proc.on('close', (code) => {
    isProxyRunning = false;
    proxyProcess = null;
    const tray = trayRef.current;
    if (tray) buildMenu(tray);
  });

  const tray = trayRef.current;
  if (tray) buildMenu(tray);

  // Notify user (skip dialog during restart to avoid double notifications)
  if (!startProxy.skipDialog) {
    setTimeout(() => {
      if (proxyProcess && proxyProcess.exitCode === null) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Proxy started',
          message: `proxy started on port ${PROXY_PORT}`,
        });
      }
    }, 1000);
  }
}

function stopProxy() {
  if (!proxyProcess) {
    exec(`lsof -ti :${PROXY_PORT} 2>/dev/null | xargs -r kill -9 2>/dev/null; true`, () => {});
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
    message: `bili proxy on port ${PROXY_PORT} has been stopped.`,
  });
}

function restartProxy() {
  stopProxy();
  startProxy.skipDialog = true;
  const logTimer = setTimeout(() => {
    startProxy();
    startProxy.skipDialog = false;
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
  // Create a hidden window, then immediately register the tray (the window close is async).
  const hiddenWin = new BrowserWindow({ show: false, width: 1, height: 1 });
  hiddenWin.setVisibleOnAllWorkspaces(false);
  hiddenWin.close();

  const trayIcon = createIcon();
  const tray = new Tray(trayIcon);
  trayRef.current = tray;
  tray.setToolTip('bili proxy — stopped');
  buildMenu(tray);
  setInterval(checkProxy, 10000);
});

app.on('before-quit', cleanup);
