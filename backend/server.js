const express = require('express');
const basicAuth = require('express-basic-auth');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { detectOpenPorts, isValidPort, isBlockedPort } = require('./utils/port-detection');

// Shell path escaping to prevent command injection
function shellEscape(str) {
  return str.replace(/'/g, "'\\''");
}

const app = express();
const PORT = process.env.PORT || 3001;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ||
  (fs.existsSync('/workspace') ? '/workspace' : process.cwd());

// Health check endpoint (before auth middleware)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// HTTP Basic Authentication (Optional)
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

if (AUTH_USERNAME && AUTH_PASSWORD) {
  console.log('HTTP Basic Authentication enabled');
  app.use(basicAuth({
    users: { [AUTH_USERNAME]: AUTH_PASSWORD },
    challenge: true,
    realm: 'Web Claude Code',
    unauthorizedResponse: (req) => {
      return 'Unauthorized. Please provide valid credentials.';
    }
  }));
} else {
  console.log('HTTP Basic Authentication disabled (no AUTH_USERNAME/AUTH_PASSWORD set)');
}

// JSON body parser (8MB limit for base64 image uploads)
app.use(express.json({ limit: '8mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (!req.path.startsWith('/preview/')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  next();
});

// Static file serving
const staticCandidates = [
  process.env.FRONTEND_DIR,
  path.join(__dirname, '../frontend'),
  '/app/frontend',
  path.join(__dirname, 'public'),
].filter(Boolean);

const staticRoot = staticCandidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch (_) {
    return false;
  }
}) || path.join(__dirname, '../frontend');

app.use(express.static(staticRoot));

// ==================== Image Paste API ====================

const PASTE_IMAGE_DIR = '/tmp';
const PASTE_IMAGE_PREFIX = 'ragent-paste-';
const PASTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB raw (matches Claude Code's internal limit)

// Valid image magic bytes
const IMAGE_SIGNATURES = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], ext: 'png' },  // PNG
  { bytes: [0xFF, 0xD8, 0xFF], ext: 'jpg' },          // JPEG
  { bytes: [0x47, 0x49, 0x46], ext: 'gif' },           // GIF
  { bytes: [0x42, 0x4D], ext: 'bmp' },                 // BMP
];

function detectImageType(buffer) {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.ext;
  }
  // WebP: RIFF....WEBP
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  return null;
}

// Cleanup old paste images on startup
try {
  const files = fs.readdirSync(PASTE_IMAGE_DIR);
  for (const file of files) {
    if (file.startsWith(PASTE_IMAGE_PREFIX)) {
      fs.unlinkSync(path.join(PASTE_IMAGE_DIR, file));
    }
  }
} catch (_) {}

app.post('/api/paste-image', (req, res) => {
  const { data } = req.body || {};

  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'Missing base64 image data' });
  }

  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }

  if (buffer.length === 0) {
    return res.status(400).json({ error: 'Empty image data' });
  }

  if (buffer.length > PASTE_IMAGE_MAX_BYTES) {
    return res.status(413).json({ error: 'Image too large (max 5MB)' });
  }

  const ext = detectImageType(buffer);
  if (!ext) {
    return res.status(400).json({ error: 'Unsupported image format' });
  }

  const filename = `${PASTE_IMAGE_PREFIX}${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(PASTE_IMAGE_DIR, filename);

  try {
    fs.writeFileSync(filepath, buffer);
    res.json({ path: filepath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save image' });
  }
});

// ==================== Tmux Window Management API ====================

const TMUX_SESSION = process.env.TMUX_SESSION_NAME || 'claude-workspace';
const tmuxEnv = { ...process.env, TMPDIR: '/tmp', TMUX: '' };

app.get('/api/tmux/windows', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.json({ enabled: false, windows: [] });
  }

  try {
    const output = execSync(
      `tmux list-windows -t '${shellEscape(TMUX_SESSION)}' -F "#{window_index}:#{window_name}:#{window_active}"`,
      { env: tmuxEnv, encoding: 'utf-8' }
    );

    const windows = output.trim().split('\n').map(line => {
      const [index, name, active] = line.split(':');
      return { index: parseInt(index), name, active: active === '1' };
    });

    res.json({ enabled: true, windows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getActivePaneCwdPath() {
  try {
    const panePath = execSync(
      `tmux display-message -t '${shellEscape(TMUX_SESSION)}' -p '#{pane_current_path}'`,
      { env: tmuxEnv, encoding: 'utf-8' }
    ).trim();
    return panePath || WORKSPACE_DIR;
  } catch (error) {
    return WORKSPACE_DIR;
  }
}

app.post('/api/tmux/window', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  try {
    const startPath = getActivePaneCwdPath();
    execSync(`tmux new-window -t '${shellEscape(TMUX_SESSION)}' -c '${shellEscape(startPath)}'`, { env: tmuxEnv });
    execSync(`tmux send-keys -t '${shellEscape(TMUX_SESSION)}' 'source /etc/profile.d/claude-env.sh 2>/dev/null; export PATH=/workspace/.local/bin:$' 'PATH' Enter`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/tmux/window/:index', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  const windowIndex = parseInt(req.params.index);
  if (isNaN(windowIndex)) {
    return res.status(400).json({ error: 'Invalid window index' });
  }

  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Window name cannot be empty' });
  }

  const safeName = name.replace(/['"\\:]/g, '').substring(0, 32);

  try {
    execSync(`tmux rename-window -t '${shellEscape(TMUX_SESSION)}':${windowIndex} '${shellEscape(safeName)}'`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/tmux/window/:index', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  const windowIndex = parseInt(req.params.index);
  if (isNaN(windowIndex)) {
    return res.status(400).json({ error: 'Invalid window index' });
  }

  try {
    const windowCount = execSync(
      `tmux display -t '${shellEscape(TMUX_SESSION)}' -p '#{session_windows}'`,
      { env: tmuxEnv, encoding: 'utf-8' }
    ).trim();

    if (parseInt(windowCount) <= 1) {
      return res.status(400).json({ error: 'Cannot close the last window' });
    }

    execSync(`tmux kill-window -t '${shellEscape(TMUX_SESSION)}':${windowIndex}`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tmux/window/:index', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  const windowIndex = parseInt(req.params.index);
  if (isNaN(windowIndex)) {
    return res.status(400).json({ error: 'Invalid window index' });
  }

  try {
    execSync(`tmux select-window -t '${shellEscape(TMUX_SESSION)}':${windowIndex}`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tmux/split', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  try {
    const paneCount = execSync(
      `tmux display -t '${shellEscape(TMUX_SESSION)}' -p '#{window_panes}'`,
      { env: tmuxEnv, encoding: 'utf-8' }
    ).trim();

    if (parseInt(paneCount) >= 2) {
      return res.status(400).json({ error: 'Maximum 2 panes per window' });
    }

    const { direction } = req.body || {};
    const flag = direction === 'horizontal' ? '-h' : '-v';
    const startPath = getActivePaneCwdPath();
    execSync(`tmux split-window -t '${shellEscape(TMUX_SESSION)}' ${flag} -c '${shellEscape(startPath)}'`, { env: tmuxEnv });
    execSync(`tmux send-keys -t '${shellEscape(TMUX_SESSION)}' 'source /etc/profile.d/claude-env.sh 2>/dev/null; export PATH=/workspace/.local/bin:$' 'PATH' Enter`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tmux/panes', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.json({ enabled: false, count: 0, activeIndex: 0, panes: [] });
  }

  try {
    const output = execSync(
      `tmux list-panes -t '${shellEscape(TMUX_SESSION)}' -F "#{pane_index}:#{pane_active}"`,
      { env: tmuxEnv, encoding: 'utf-8' }
    );

    const panes = output.trim().split('\n').map(line => {
      const [index, active] = line.split(':');
      return { id: parseInt(index), active: active === '1' };
    });

    const activePane = panes.find(p => p.active);
    res.json({ enabled: true, count: panes.length, activeIndex: activePane ? activePane.id : 0, panes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tmux/pane/switch', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  try {
    const { direction } = req.body || {};
    const target = direction === 'prev' ? ':.-' : ':.+';
    execSync(`tmux select-pane -t '${shellEscape(TMUX_SESSION)}'${target}`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/tmux/pane/close', (req, res) => {
  if (!process.env.TMUX_SESSION_NAME) {
    return res.status(400).json({ error: 'Tmux mode not enabled' });
  }

  try {
    const paneCount = execSync(
      `tmux display -t '${shellEscape(TMUX_SESSION)}' -p '#{window_panes}'`,
      { env: tmuxEnv, encoding: 'utf-8' }
    ).trim();

    if (parseInt(paneCount) <= 1) {
      return res.status(400).json({ error: 'Cannot close the only pane' });
    }

    execSync(`tmux kill-pane -t '${shellEscape(TMUX_SESSION)}'`, { env: tmuxEnv });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== Preview API ====================

app.get('/api/ports', async (req, res) => {
  try {
    const openPorts = await detectOpenPorts();
    res.json({ ports: openPorts, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to detect ports', message: error.message });
  }
});

app.use('/preview/:port', (req, res, next) => {
  const port = parseInt(req.params.port);

  if (isNaN(port) || !isValidPort(port)) {
    return res.status(400).json({ error: 'Invalid port' });
  }

  if (isBlockedPort(port)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const proxy = createProxyMiddleware({
    target: `http://localhost:${port}`,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(new RegExp(`^/preview/${port}`), ''),
    onError: (err, req, res) => {
      if (res && typeof res.status === 'function') {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Bad Gateway', message: 'Unable to connect to the development server', port });
        }
      } else if (res && typeof res.end === 'function') {
        try { res.end(); } catch (_) {}
      }
    },
    onProxyReq: (proxyReq) => {
      proxyReq.removeHeader('accept-encoding');
    },
    onProxyRes: (proxyRes, req, res) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        const _write = res.write;
        const _end = res.end;
        let body = '';
        delete proxyRes.headers['content-length'];
        delete proxyRes.headers['content-encoding'];

        res.write = function(chunk) { body += chunk.toString(); };
        res.end = function(chunk) {
          if (chunk) body += chunk.toString();
          body = body.replace(/src="\/(?!\/)/g, `src="/preview/${port}/`);
          body = body.replace(/href="\/(?!\/)/g, `href="/preview/${port}/`);
          body = body.replace(/from\s+["']\/(?!\/)/g, `from "/preview/${port}/`);
          body = body.replace(/import\s*\(\s*["']\/(?!\/)/g, `import("/preview/${port}/`);
          res.write = _write;
          res.end = _end;
          res.end(body);
        };
      }
    }
  });

  proxy(req, res, next);
});

// ==================== Server Start ====================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Serving static assets from: ${staticRoot}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

// WebSocket upgrade handler for preview proxy (HMR support)
server.on('upgrade', (req, socket, head) => {
  const url = req.url;

  if (url.startsWith('/preview/')) {
    const match = url.match(/^\/preview\/(\d+)/);
    if (match) {
      const port = parseInt(match[1]);
      if (isValidPort(port) && !isBlockedPort(port)) {
        const proxy = createProxyMiddleware({
          target: `http://localhost:${port}`,
          ws: true,
          changeOrigin: true
        });
        try {
          proxy.upgrade(req, socket, head);
        } catch (error) {
          socket.destroy();
        }
        return;
      } else {
        socket.destroy();
        return;
      }
    }
  }
});

// WebSocket server for terminal connections
const wss = new WebSocket.Server({ server, perMessageDeflate: false, clientTracking: true });

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

const connections = new Map();
let activeClientId = null;

wss.on('connection', (ws, req) => {
  const origin = (req && req.headers && req.headers.origin) || '';

  if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes('*')) {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      try { ws.close(1008, 'Origin not allowed'); } catch (_) {}
      return;
    }
  }

  const clientId = Math.random().toString(36).substring(7);
  console.log(`Client ${clientId} connected`);

  const TMUX_SESSION = process.env.TMUX_SESSION_NAME;
  let shell, shellArgs, cwd;

  if (TMUX_SESSION) {
    let sessionExists = false;
    try {
      execSync(`tmux has-session -t '${shellEscape(TMUX_SESSION)}' 2>/dev/null`, { env: tmuxEnv, stdio: 'ignore' });
      sessionExists = true;
    } catch (e) {
      sessionExists = false;
    }

    if (!sessionExists) {
      try {
        execSync(`tmux new-session -d -s '${shellEscape(TMUX_SESSION)}' -c '${shellEscape(WORKSPACE_DIR)}'`, { env: tmuxEnv });
        execSync(`tmux send-keys -t '${shellEscape(TMUX_SESSION)}' 'source /etc/profile.d/claude-env.sh 2>/dev/null; export PATH=/workspace/.local/bin:$' 'PATH' Enter`, { env: tmuxEnv });
      } catch (e) {
        console.error(`Failed to create tmux session: ${e.message}`);
      }
    }

    try {
      execSync(`tmux set-option -t '${shellEscape(TMUX_SESSION)}' status off`, { env: tmuxEnv, stdio: 'ignore' });
      execSync(`tmux set-window-option -t '${shellEscape(TMUX_SESSION)}' aggressive-resize on`, { env: tmuxEnv, stdio: 'ignore' });
      execSync(`tmux set-option -t '${shellEscape(TMUX_SESSION)}' mouse on`, { env: tmuxEnv, stdio: 'ignore' });
      execSync(`tmux set-option -t '${shellEscape(TMUX_SESSION)}' history-limit 10000`, { env: tmuxEnv, stdio: 'ignore' });
    } catch (e) {}

    shell = 'tmux';
    shellArgs = ['attach-session', '-t', TMUX_SESSION];
    cwd = process.cwd();
  } else {
    shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
    shellArgs = process.platform === 'win32' ? [] : ['-i'];
    cwd = WORKSPACE_DIR;
  }

  let ptyProcess;

  try {
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
        ...(TMUX_SESSION ? {} : {
          ...(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN } : {}),
          ...(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY } : {}),
          ...(process.env.CLAUDE_BASE_URL || process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.CLAUDE_BASE_URL || process.env.ANTHROPIC_BASE_URL } : {}),
        }),
        PATH: [
          `${WORKSPACE_DIR}/.local/bin`,
          `${process.env.HOME || ''}/.local/bin`,
          process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        ].filter(Boolean).join(':')
      }
    });

    connections.set(clientId, { ws, ptyProcess });
  } catch (error) {
    console.error(`Failed to create PTY process for ${clientId}:`, error);
    ws.close(1011, 'Internal server error');
    return;
  }

  ptyProcess.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'data', data })); } catch (error) {}
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); } catch (error) {}
    }
  });

  ws.on('message', (message) => {
    try {
      if (message.length > 1024 * 1024) return;

      const { type, data } = JSON.parse(message);

      switch (type) {
        case 'input':
          activeClientId = clientId;
          if (typeof data === 'string' && data.length <= 1000) {
            ptyProcess.write(data);
          }
          break;
        case 'resize':
          if (activeClientId && activeClientId !== clientId) break;
          if (data && typeof data.cols === 'number' && typeof data.rows === 'number' &&
              data.cols > 0 && data.cols <= 1000 && data.rows > 0 && data.rows <= 1000) {
            ptyProcess.resize(data.cols, data.rows);
            if (TMUX_SESSION) {
              try { exec(`tmux refresh-client -t '${shellEscape(TMUX_SESSION)}'`); } catch (e) {}
            }
          }
          break;
        case 'ping':
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          break;
      }
    } catch (error) {}
  });

  ws.on('close', () => cleanup(clientId));
  ws.on('error', () => cleanup(clientId));

  function cleanup(id) {
    if (activeClientId === id) activeClientId = null;
    const connection = connections.get(id);
    if (connection) {
      if (TMUX_SESSION) {
        // Preserve tmux session on disconnect
      } else {
        try { if (connection.ptyProcess) connection.ptyProcess.kill(); } catch (error) {}
      }
      connections.delete(id);
    }
  }
});

process.on('SIGINT', () => {
  for (const [clientId, connection] of connections) {
    try {
      if (connection.ptyProcess) connection.ptyProcess.kill();
      if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1001, 'Server shutdown');
      }
    } catch (error) {}
  }
  connections.clear();
  server.close(() => process.exit(0));
});
