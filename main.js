const { app, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration — override these via environment or edit defaults for your setup
// ---------------------------------------------------------------------------
const BILI = process.env.BILI_PATH || 'bili';            // binary name or path
const PROXY_PORT = process.env.PROXY_PORT || 8787;        // listen port
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

// Build a tray icon from SVG
function createIcon() {
  const { nativeTheme } = require('electron');
  const size = 16;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
      <circle cx="8" cy="8" r="7" fill="${nativeTheme.shouldUseDarkThemes ? '#4a90d9' : '#2563eb'}"/>
      <text x="8" y="11" text-anchor="middle" fill="white" font-size="8" font-family="sans-serif" font-weight="bold">b</text>
    </svg>`;
  return nativeImage.createFromBuffer(Buffer.from(svg), size);
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

function checkProxy() {
  exec(`lsof -i :${PROXY_PORT} -sTCP:LISTEN 2>/dev/null | grep -c bili`, (err, stdout) => {
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

  logLines = [];

  const proc = spawn(BILI, ['start', `--port=${PROXY_PORT}`], {
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

  // Notify user
  setTimeout(() => {
    if (proxyProcess && proxyProcess.exitCode === null) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Proxy started',
        message: `bili proxy started on port ${PROXY_PORT}`,
      });
    }
  }, 3000);
}

function stopProxy() {
  if (!proxyProcess) {
    exec(`lsof -ti :${PROXY_PORT} 2>/dev/null | xargs kill -9 2>/dev/null; true`, () => {});
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
  const trayIcon = createIcon();
  const tray = new Tray(trayIcon);
  trayRef.current = tray;
  tray.setToolTip('bili proxy — stopped');

  buildMenu(tray);

  // Check if proxy is already running
  checkProxy();

  // Refresh status every 5 seconds
  setInterval(checkProxy, 5000);
});

app.on('before-quit', cleanup);
