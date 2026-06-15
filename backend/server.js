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
const SessionStore = require('./utils/session-store');

// Agent SDK — lazy-loaded since it's an optional ESM module
let claudeQuery = null;
async function getClaudeQuery() {
  if (!claudeQuery) {
    try {
      const sdk = await import('@anthropic-ai/claude-code');
      claudeQuery = sdk.query;
    } catch (err) {
      console.error('Failed to load @anthropic-ai/claude-code:', err.message);
      throw new Error('Agent SDK not available');
    }
  }
  return claudeQuery;
}

// Track active chat abort controllers per session
const activeChatAborts = new Map();

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

// ── Probe dispatch endpoint (the "wake glue") ──────────────────────────────
// Probe POSTs a signed change-request here when its acceptance finds issues on
// a PR. Ragent clones the PR branch, runs Claude Code headless to fix the
// reported findings, and pushes — closing the loop in Ragent's environment.
// Mounted before basic-auth: authenticated by HMAC signature, not credentials.
const DISPATCH_SECRET = process.env.PROBE_DISPATCH_SECRET;
const DISPATCH_GH_TOKEN = process.env.DISPATCH_GITHUB_TOKEN;
const DISPATCH_AUTHOR_NAME = process.env.DISPATCH_GIT_AUTHOR_NAME || 'ragent';
const DISPATCH_AUTHOR_EMAIL = process.env.DISPATCH_GIT_AUTHOR_EMAIL || '';

app.post('/api/dispatch', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!DISPATCH_SECRET || !DISPATCH_GH_TOKEN) {
    return res.status(503).json({ error: 'dispatch not configured (set PROBE_DISPATCH_SECRET + DISPATCH_GITHUB_TOKEN)' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = req.headers['x-probe-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', DISPATCH_SECRET).update(raw).digest('hex');
  const ok = typeof sig === 'string' && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'invalid signature' });

  let p;
  try { p = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid JSON' }); }
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo || '')) {
    return res.status(400).json({ error: 'malformed payload (repo)' });
  }
  if (p.kind === 'implement') {
    if (!Number.isInteger(p.issue_number) || !/^[\w./-]+$/.test(p.base_branch || '')) {
      return res.status(400).json({ error: 'malformed implement payload (issue_number/base_branch)' });
    }
  } else if (!/^[\w./-]+$/.test(p.branch || '') || !Number.isInteger(p.pr_number)) {
    return res.status(400).json({ error: 'malformed payload (repo/branch/pr_number)' });
  }

  const r = enqueueDispatch(p);
  res.status(r.status === 'rejected' ? 429 : 202).json({ accepted: r.status !== 'rejected', ...r });
});

// ── Dispatch scheduler: in-process semaphore + queue + per-PR dedup ─────────
// Single Node process, so concurrency is a counter, not an external queue.
// Default serial (DISPATCH_CONCURRENCY=1): one small container + one shared
// Claude subscription rate limit — running fixes in parallel would double both
// container pressure and subscription-rate burn (and could throttle the web
// terminal, which shares the same OAuth session).
const DISPATCH_MAX = Number(process.env.DISPATCH_CONCURRENCY || 1);
const DISPATCH_QUEUE_MAX = Number(process.env.DISPATCH_QUEUE_MAX || 20);
let dispatchActive = 0;
const dispatchQueue = [];
const dispatchInflight = new Set(); // "repo#pr" — dedup key (queued or running)

function enqueueDispatch(p) {
  const key = p.kind === 'implement' ? `${p.repo}#issue-${p.issue_number}` : `${p.repo}#${p.pr_number}`;
  if (dispatchInflight.has(key)) {
    // Same PR already queued/running → keep newest payload (latest findings),
    // don't schedule a duplicate run.
    const q = dispatchQueue.find((j) => j.key === key);
    if (q) q.payload = p;
    console.error(`[dispatch] ${key} deduped (already in flight)`);
    return { status: 'deduped', key };
  }
  if (dispatchQueue.length >= DISPATCH_QUEUE_MAX) {
    console.error(`[dispatch] ${key} rejected (queue full: ${dispatchQueue.length})`);
    return { status: 'rejected', reason: 'queue full', key };
  }
  dispatchInflight.add(key);
  dispatchQueue.push({ key, payload: p });
  console.error(`[dispatch] ${key} queued (active=${dispatchActive}/${DISPATCH_MAX}, depth=${dispatchQueue.length})`);
  pumpDispatch();
  return { status: 'queued', key, depth: dispatchQueue.length };
}

function pumpDispatch() {
  while (dispatchActive < DISPATCH_MAX && dispatchQueue.length) {
    const job = dispatchQueue.shift();
    dispatchActive++;
    const runner = job.payload.kind === 'implement' ? runImplement : runDispatch;
    runner(job.payload)
      .catch((e) => console.error(`[dispatch] ${job.key} failed:`, e.message))
      .finally(() => { dispatchActive--; dispatchInflight.delete(job.key); pumpDispatch(); });
  }
}

async function runDispatch(p) {
  const slug = p.repo.replace('/', '-');
  const cacheDir = path.join(WORKSPACE_DIR, 'dispatch', '.cache', slug);
  const dir = path.join(WORKSPACE_DIR, 'dispatch', `${slug}-pr${p.pr_number}`);
  const cloneUrl = `https://x-access-token:${DISPATCH_GH_TOKEN}@github.com/${p.repo}.git`;
  console.error(`[dispatch] ${p.repo}#${p.pr_number} → ${dir} (branch ${p.branch}, active=${dispatchActive})`);

  // Per-repo cache clone, created once; subsequent dispatches only fetch the
  // branch (incremental, reuses the object store) instead of re-downloading.
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    execSync(`rm -rf '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
    execSync(`mkdir -p '${shellEscape(path.dirname(cacheDir))}'`, { stdio: 'ignore' });
    execSync(`git clone --filter=blob:none --no-checkout '${cloneUrl}' '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
  }
  execSync(`git -C '${shellEscape(cacheDir)}' remote set-url origin '${cloneUrl}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' fetch --no-tags origin '${shellEscape(p.branch)}'`, { stdio: 'ignore' });

  // Per-PR worktree off the shared cache: isolated working tree, near-zero disk
  // (shares the cache object store), safe for concurrent PRs of the same repo.
  execSync(`git -C '${shellEscape(cacheDir)}' worktree prune`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}' 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree add --force -B '${shellEscape(p.branch)}' '${shellEscape(dir)}' 'origin/${shellEscape(p.branch)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(dir)}' config user.name '${shellEscape(DISPATCH_AUTHOR_NAME)}'`, { stdio: 'ignore' });
  if (DISPATCH_AUTHOR_EMAIL) execSync(`git -C '${shellEscape(dir)}' config user.email '${shellEscape(DISPATCH_AUTHOR_EMAIL)}'`, { stdio: 'ignore' });

  const findingsText = (p.findings || [])
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}\n   ${f.detail || ''}${f.repro_steps && f.repro_steps.length ? `\n   Repro: ${f.repro_steps.join(' → ')}` : ''}`)
    .join('\n');
  const prompt = `You are fixing a pull request. Probe (an acceptance agent) tested PR #${p.pr_number} on its preview deployment and found these issues:

${findingsText}

Summary: ${p.summary || ''}

Fix ONLY these reported issues in this repository. Do not make unrelated changes. When done, commit with a clear message and push to the current branch (\`${p.branch}\`):

  git commit -am "Fix: <what you fixed>"
  git push origin ${p.branch}

The git remote is already authenticated.`;

  // Drive the Claude Code CLI in headless print mode (already installed in the
  // container; the SDK npm package isn't in the production deps). Prompt via
  // stdin; the CLI uses the container's existing Claude auth.
  const claudeBin = fs.existsSync('/workspace/.local/bin/claude') ? '/workspace/.local/bin/claude' : 'claude';
  try {
    const out = execSync(`${claudeBin} -p --dangerously-skip-permissions`, {
      cwd: dir,
      input: prompt,
      env: { ...process.env, PATH: `/workspace/.local/bin:${process.env.PATH || ''}` },
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    console.error(`[dispatch] ${p.repo}#${p.pr_number} claude finished: ${String(out).slice(-300)}`);
  } catch (e) {
    console.error(`[dispatch] ${p.repo}#${p.pr_number} claude error: ${e.message}${e.stdout ? ' | out: ' + String(e.stdout).slice(-300) : ''}`);
    throw e;
  } finally {
    // Release the worktree (and its disk) on every path; the cache object store
    // is kept for the next dispatch of this repo.
    try {
      execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}'`, { stdio: 'ignore' });
    } catch (_) {
      execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
    }
  }
}

// Origination path: implement an issue on a NEW branch and open a PR. The
// existing deployment→acceptance loop then takes over on that PR.
async function runImplement(p) {
  const slug = p.repo.replace('/', '-');
  const cacheDir = path.join(WORKSPACE_DIR, 'dispatch', '.cache', slug);
  const base = p.base_branch || 'main';
  const branch = `probe/issue-${p.issue_number}`;
  const dir = path.join(WORKSPACE_DIR, 'dispatch', `${slug}-issue${p.issue_number}`);
  const cloneUrl = `https://x-access-token:${DISPATCH_GH_TOKEN}@github.com/${p.repo}.git`;
  console.error(`[implement] ${p.repo} issue#${p.issue_number} → ${dir} (new branch ${branch} off ${base})`);

  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    execSync(`rm -rf '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
    execSync(`mkdir -p '${shellEscape(path.dirname(cacheDir))}'`, { stdio: 'ignore' });
    execSync(`git clone --filter=blob:none --no-checkout '${cloneUrl}' '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
  }
  execSync(`git -C '${shellEscape(cacheDir)}' remote set-url origin '${cloneUrl}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' fetch --no-tags origin '${shellEscape(base)}'`, { stdio: 'ignore' });

  execSync(`git -C '${shellEscape(cacheDir)}' worktree prune`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}' 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree add --force -B '${shellEscape(branch)}' '${shellEscape(dir)}' 'origin/${shellEscape(base)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(dir)}' config user.name '${shellEscape(DISPATCH_AUTHOR_NAME)}'`, { stdio: 'ignore' });
  if (DISPATCH_AUTHOR_EMAIL) execSync(`git -C '${shellEscape(dir)}' config user.email '${shellEscape(DISPATCH_AUTHOR_EMAIL)}'`, { stdio: 'ignore' });

  const prompt = `You are responding to a GitHub issue in this repository. Decide which case applies:

ISSUE #${p.issue_number}: ${p.title}

${p.body || '(no description provided)'}

CASE A — the issue asks for a CODE CHANGE you can make:
  Implement it (focused edits only, no unrelated changes), then commit (do NOT push, do NOT open a PR — that is handled for you):
    git add -A && git commit -m "Implement: <what you did> (#${p.issue_number})"
  A PR will be opened automatically.

CASE B — the issue is a QUESTION, a status/progress request, a discussion, or otherwise needs NO code change (or you cannot make a meaningful change):
  Do NOT commit anything. Instead, write your COMPLETE answer as your final message — it will be posted verbatim as a comment on the issue. Read the actual code/docs to ground your answer and reference specifics. Be concise and useful.

Pick exactly one. Committing ⇒ a PR is opened. No commit ⇒ your final message is posted as an issue comment.`;

  const claudeBin = fs.existsSync('/workspace/.local/bin/claude') ? '/workspace/.local/bin/claude' : 'claude';
  try {
    const out = execSync(`${claudeBin} -p --dangerously-skip-permissions`, {
      cwd: dir,
      input: prompt,
      env: { ...process.env, PATH: `/workspace/.local/bin:${process.env.PATH || ''}` },
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    console.error(`[implement] issue#${p.issue_number} claude finished: ${String(out).slice(-300)}`);

    const ahead = execSync(`git -C '${shellEscape(dir)}' rev-list --count 'origin/${shellEscape(base)}..HEAD'`, { encoding: 'utf8' }).trim();
    if (ahead === '0' || ahead === '') {
      // No code change (Case B: question / status / can't act) → reply on the
      // issue with the agent's final message instead of opening an empty PR.
      console.error(`[implement] issue#${p.issue_number}: no commits → replying as issue comment`);
      const reply = String(out || '').trim() || '(the agent produced no actionable change and no response)';
      await postIssueComment(p, reply);
      return;
    }
    execSync(`git -C '${shellEscape(dir)}' push --force origin '${shellEscape(branch)}'`, { stdio: 'ignore' });
    await openPullRequest(p, branch, base);
  } catch (e) {
    console.error(`[implement] issue#${p.issue_number} error: ${e.message}${e.stdout ? ' | out: ' + String(e.stdout).slice(-300) : ''}`);
    throw e;
  } finally {
    try {
      execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}'`, { stdio: 'ignore' });
    } catch (_) {
      execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
    }
  }
}

// Post a comment on the issue (Case B: question/status, no PR). https module.
function postIssueComment(p, body) {
  const https = require('https');
  const capped = body.length > 60000 ? body.slice(0, 60000) + '\n\n…(truncated)' : body;
  const payload = JSON.stringify({ body: `${capped}\n\n— 🤖 Ragent (replied to #${p.issue_number}; no code change needed)` });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${p.repo}/issues/${p.issue_number}/comments`, method: 'POST',
      headers: {
        Authorization: `Bearer ${DISPATCH_GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ragent-dispatch',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) console.error(`[implement] issue#${p.issue_number} → posted reply comment`);
        else console.error(`[implement] issue#${p.issue_number} comment → ${res.statusCode}: ${b.slice(0, 200)}`);
        resolve();
      });
    });
    req.on('error', (e) => { console.error(`[implement] comment error: ${e.message}`); resolve(); });
    req.write(payload); req.end();
  });
}

// Open a PR via the GitHub API (https module — works on node 16+). Idempotent:
// a 422 (PR already exists for this head) on a re-run is fine.
function openPullRequest(p, head, base) {
  const https = require('https');
  const payload = JSON.stringify({
    title: p.title || `Implement issue #${p.issue_number}`,
    head, base,
    body: `Implements #${p.issue_number}.\n\nCloses #${p.issue_number}\n\n— generated by Ragent from the issue; Probe will verify the preview.`,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${p.repo}/pulls`, method: 'POST',
      headers: {
        Authorization: `Bearer ${DISPATCH_GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ragent-dispatch',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let num; try { num = JSON.parse(body).number; } catch (_) {}
          console.error(`[implement] issue#${p.issue_number} → opened PR #${num} (${head} → ${base})`);
        } else {
          console.error(`[implement] issue#${p.issue_number} open PR → ${res.statusCode}: ${body.slice(0, 200)}`);
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.error(`[implement] open PR error: ${e.message}`); resolve(); });
    req.write(payload); req.end();
  });
}

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

// ==================== Session Management API ====================

const sessionStore = new SessionStore();

// List all sessions
app.get('/api/sessions', (req, res) => {
  try {
    const userId = req.query.userId || undefined;
    const sessions = sessionStore.listSessions(userId);
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single session details
app.get('/api/sessions/:id', (req, res) => {
  try {
    const meta = sessionStore.getSessionMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    res.json(meta);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new session
app.post('/api/sessions', (req, res) => {
  try {
    const { userId, title } = req.body || {};
    const meta = sessionStore.createSession(userId || 'default', title || '');
    res.status(201).json(meta);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save (backup) a session from ~/.claude/ to persistent store
app.post('/api/sessions/:id/save', (req, res) => {
  try {
    const meta = sessionStore.getSessionMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Session not found' });

    // Allow updating title on save
    if (req.body && req.body.title) {
      sessionStore.updateSessionMeta(req.params.id, { title: req.body.title });
    }

    const saved = sessionStore.saveSession(req.params.id);
    if (!saved) return res.status(500).json({ error: 'Save failed' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load (restore) a session from persistent store to ~/.claude/
app.post('/api/sessions/:id/load', (req, res) => {
  try {
    const meta = sessionStore.getSessionMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Session not found' });

    const loaded = sessionStore.loadSession(req.params.id);
    if (!loaded) return res.status(500).json({ error: 'Load failed' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a session
app.delete('/api/sessions/:id', (req, res) => {
  try {
    sessionStore.deleteSession(req.params.id);
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

// ==================== Agent SDK Chat Handler ====================

async function handleChatMessage(ws, clientId, msg) {
  const { sessionId, prompt } = msg;
  if (!sessionId || !prompt) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat_error', sessionId, error: 'Missing sessionId or prompt' }));
    }
    return;
  }

  // Prevent concurrent queries on the same session
  if (activeChatAborts.has(sessionId)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat_error', sessionId, error: 'Session is busy' }));
    }
    return;
  }

  const meta = sessionStore.getSessionMeta(sessionId);
  if (!meta) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat_error', sessionId, error: 'Session not found' }));
    }
    return;
  }

  // Restore session files so resume can find them
  const isResume = !!meta.sdkSessionId;
  if (isResume) {
    sessionStore.loadSession(sessionId);
  }

  const abortController = new AbortController();
  activeChatAborts.set(sessionId, { abortController, clientId });

  try {
    const query = await getClaudeQuery();

    const isRoot = process.getuid && process.getuid() === 0;
    const options = {
      abortController,
      cwd: WORKSPACE_DIR,
      // bypassPermissions is blocked when running as root; fall back to default mode
      ...(isRoot ? {} : { permissionMode: 'bypassPermissions' }),
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit'],
      maxTurns: 30,
    };

    // Resume existing session using the SDK's session ID
    if (isResume) {
      options.resume = meta.sdkSessionId;
    }

    // SDK expects { prompt, options } as a single object argument
    const conversation = query({ prompt, options });

    for await (const event of conversation) {
      if (ws.readyState !== WebSocket.OPEN) break;

      // Capture SDK session ID from the first message that carries it
      if (event.session_id && !meta.sdkSessionId) {
        sessionStore.updateSessionMeta(sessionId, { sdkSessionId: event.session_id });
        meta.sdkSessionId = event.session_id;
      }

      ws.send(JSON.stringify({
        type: 'chat_message',
        sessionId,
        message: event,
      }));
    }

    // Conversation round ended — send completion signal
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat_end', sessionId }));
    }

    // Auto-save after round completes
    if (process.env.SESSION_AUTO_SAVE !== 'false') {
      try { sessionStore.saveSession(sessionId); } catch (e) {
        console.error(`Auto-save failed for session ${sessionId}:`, e.message);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat_end', sessionId, aborted: true }));
      }
    } else {
      console.error(`Chat error for session ${sessionId}:`, error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat_error', sessionId, error: error.message }));
      }
    }
  } finally {
    activeChatAborts.delete(sessionId);
  }
}

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

      const parsed = JSON.parse(message);
      const { type, data } = parsed;

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
        case 'chat':
          handleChatMessage(ws, clientId, parsed);
          break;
        case 'chat_abort':
          if (parsed.sessionId) {
            const entry = activeChatAborts.get(parsed.sessionId);
            if (entry) { entry.abortController.abort(); activeChatAborts.delete(parsed.sessionId); }
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
      // Abort only this client's active chat sessions
      for (const [sid, entry] of activeChatAborts) {
        if (entry.clientId === id) {
          entry.abortController.abort();
          activeChatAborts.delete(sid);
        }
      }

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
