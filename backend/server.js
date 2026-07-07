const express = require('express');
const basicAuth = require('express-basic-auth');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
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

// ── Instance configuration: env first, file fallback ────────────────────────
// Secrets can live in the persistent volume (like Claude's own credentials in
// ~/.claude) so an instance can be configured from its own terminal without
// touching platform env or redeploying. Env vars always win. The file is read
// lazily on every use, so edits take effect without a restart.
const RAGENT_CONFIG_PATH = path.join(WORKSPACE_DIR, '.ragent', 'config.json');
function fileConfig() {
  try { return JSON.parse(fs.readFileSync(RAGENT_CONFIG_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function ghToken() {
  return process.env.DISPATCH_GITHUB_TOKEN || String(fileConfig().github_token || '');
}
function webhookSecret() {
  return process.env.GITHUB_WEBHOOK_SECRET || String(fileConfig().webhook_secret || '');
}
// First boot with no secret anywhere → generate one into the config file, so
// onboarding never requires inventing a secret by hand (read it from the file
// when configuring the GitHub webhook).
(function ensureWebhookSecret() {
  if (webhookSecret()) return;
  try {
    fs.mkdirSync(path.dirname(RAGENT_CONFIG_PATH), { recursive: true });
    const cfg = fileConfig();
    cfg.webhook_secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(RAGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    console.log(`Webhook secret generated → ${RAGENT_CONFIG_PATH}`);
  } catch (e) {
    console.error('Could not generate webhook secret:', e.message);
  }
})();

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
const DISPATCH_AUTHOR_NAME = process.env.DISPATCH_GIT_AUTHOR_NAME || 'ragent';
const DISPATCH_AUTHOR_EMAIL = process.env.DISPATCH_GIT_AUTHOR_EMAIL || 'ragent@users.noreply.github.com';

app.post('/api/dispatch', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!DISPATCH_SECRET || !ghToken()) {
    return res.status(503).json({ error: 'dispatch not configured (set PROBE_DISPATCH_SECRET + a GitHub token via DISPATCH_GITHUB_TOKEN or /workspace/.ragent/config.json)' });
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
  } else if (p.kind === 'converse') {
    if (!Number.isInteger(p.issue_number)) {
      return res.status(400).json({ error: 'malformed converse payload (issue_number)' });
    }
  } else if (!/^[\w./-]+$/.test(p.branch || '') || !Number.isInteger(p.pr_number)) {
    return res.status(400).json({ error: 'malformed payload (repo/branch/pr_number)' });
  }

  const r = enqueueDispatch(p);
  res.status(r.status === 'rejected' ? 429 : 202).json({ accepted: r.status !== 'rejected', ...r });
});

// ── GitHub webhook: Ragent owns the issue surface (origination + conversation) ──
// Probe (the acceptance agent) no longer routes issue events; Ragent receives
// them directly here. `issues` (labeled with the trigger label) → implement;
// `issue_comment` starting with "/ragent" on a real issue → converse. PR-comment
// `/probe` adjudication and deployment_status stay on Probe's own webhook.
const ISSUE_LABEL = process.env.DISPATCH_ISSUE_LABEL || 'agent';

app.post('/webhooks/github', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const secret = webhookSecret();
  if (!secret || !ghToken()) {
    return res.status(503).json({ error: 'webhook not configured (need a webhook secret + a GitHub token, via env or /workspace/.ragent/config.json)' });
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok = typeof sig === 'string' && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'invalid signature' });

  const event = req.headers['x-github-event'];
  let pl;
  try { pl = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid JSON' }); }
  res.status(202).json({ accepted: true });

  try {
    const repo = pl.repository && pl.repository.full_name;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return;

    if (event === 'issues') {
      const issue = pl.issue;
      if (!issue || issue.pull_request) return;            // PRs arrive as issues — not ours
      if (pl.action !== 'opened' && pl.action !== 'labeled') return;
      const hasLabel = pl.action === 'labeled'
        ? (pl.label && pl.label.name === ISSUE_LABEL)
        : (issue.labels || []).some((l) => l && l.name === ISSUE_LABEL);
      if (!hasLabel) return;
      // Carry delegation metadata (if this issue was opened by another agent's
      // ragent-request or a spin-off) so depth counting survives the hop.
      const meta = parseMeta(issue.body);
      enqueueDispatch({
        kind: 'implement', repo, issue_number: issue.number,
        title: issue.title || '', body: issue.body || '',
        base_branch: (pl.repository && pl.repository.default_branch) || 'main',
        depth: meta.depth, origin: meta.origin,
      });
    } else if (event === 'issue_comment') {
      if (pl.action !== 'created') return;
      const issue = pl.issue;
      if (!issue) return;
      const body = String((pl.comment && pl.comment.body) || '');
      if (/🤖 Ragent/.test(body)) return;                   // never answer our own reply
      const m = body.match(/^\s*\/ragent\b[ \t]*([\s\S]*)$/i);
      if (!m) return;
      const request = (m[1] || '').trim();
      if (issue.pull_request) {
        // /ragent on a PR → MANUAL fix request on the PR branch. The manual
        // counterpart to Probe's automatic verdict→fix — needed when the
        // automated loop can't help (e.g. the preview build FAILED, so Probe
        // never gets a deployment_status=success to verify). Resolve the PR's
        // head branch, then dispatch a fix carrying the user's instruction.
        getPullBranch(repo, issue.number).then((branch) => {
          if (!branch) { console.error(`[webhook] PR #${issue.number}: could not resolve head branch`); return; }
          enqueueDispatch({
            kind: 'fix', repo, pr_number: issue.number, branch,
            head_sha: '', target_url: '', round: 0,
            summary: request || 'User asked Ragent to fix this PR.',
            findings: [{ severity: 'high', title: request || 'Fix the reported problem on this PR.', detail: '', repro_steps: [] }],
          });
        }).catch((e) => console.error('[webhook] PR fix error:', e.message));
      } else {
        // /ragent on an issue → conversation.
        const meta = parseMeta(issue.body);
        enqueueDispatch({
          kind: 'converse', repo, issue_number: issue.number,
          comment_id: (pl.comment && pl.comment.id) || 0,
          title: issue.title || '', body: issue.body || '',
          request,
          depth: meta.depth, origin: meta.origin,
        });
      }
    }
  } catch (e) {
    console.error('[webhook] handler error:', e.message);
  }
});

// ── Per-repo agents: registry + persistent notes (memory) ──────────────────
// /workspace/agents/agents.json maps "owner/repo" → { name, persona }. A
// registered repo gets a named agent identity and a notes file at
// /workspace/agents/<slug>/notes.md — its only memory across runs. Notes are
// injected into every prompt and updated ONLY by the server, from a
// ```ragent-notes``` block in the agent's output: agents never hold a write
// path to memory files (theirs or anyone else's), so one agent can't poison
// another's memory. Unregistered repos keep the anonymous default behavior.
const AGENTS_DIR = path.join(WORKSPACE_DIR, 'agents');
const NOTES_INJECT_MAX = 8 * 1024;   // prompt budget
const NOTES_STORE_MAX = 16 * 1024;   // on-disk cap

function agentRegistry() {
  try { return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'agents.json'), 'utf8')) || {}; }
  catch (_) { return {}; }
}

function getAgent(repo) {
  const a = agentRegistry()[repo];
  if (!a) return null;
  const slug = repo.replace('/', '-');
  return {
    repo, slug,
    name: a.name || slug,
    persona: typeof a.persona === 'string' ? a.persona : '',
    notesPath: path.join(AGENTS_DIR, slug, 'notes.md'),
  };
}

// Identity + memory + peers preamble, prepended to every prompt of a
// registered repo. `p` supplies the delegation depth of the current task.
function agentPreamble(agent, p) {
  if (!agent) return '';
  let notes = '';
  try { notes = fs.readFileSync(agent.notesPath, 'utf8').slice(0, NOTES_INJECT_MAX); } catch (_) {}
  const depth = Number((p && p.depth) || 0);
  const peers = Object.keys(agentRegistry()).filter((r) => r !== agent.repo);
  const peersBlock = peers.length ? `

PEER REPOSITORIES, each maintained by its own agent: ${peers.join(', ')}.
You can NEVER touch their code. If your task genuinely requires a change in one of them, file a work request — emit (before any notes block):
\`\`\`ragent-request
{"repo": "<one of the peers>", "title": "<concise title>", "body": "<self-contained spec the other agent can act on without extra context>"}
\`\`\`
The server opens a labeled issue in that repo, waking its agent; the outcome will be reported back here.` : '';
  const depthNote = depth > 0
    ? `\nThis task was delegated to you by another agent (delegation depth ${depth}/${MAX_REQUEST_DEPTH}).`
    : '';
  return `You are "${agent.name}", the dedicated maintainer agent of this repository (${agent.repo}). You have worked on it before and will work on it again.${agent.persona ? '\n' + agent.persona : ''}${depthNote}${peersBlock}

YOUR NOTES from previous runs (your only memory across runs):
${notes.trim() || '(none yet — this is your first remembered run)'}

If this run taught you something durable about the repo (build quirks, conventions, pitfalls, in-flight work), end your final message with a fenced block containing the COMPLETE UPDATED notes — it replaces the whole file, so keep whatever above is still true and stay under ${NOTES_STORE_MAX} bytes:
\`\`\`ragent-notes
<full updated notes>
\`\`\`
Otherwise omit the block entirely.

--- THE TASK ---

`;
}

// Extract a ```ragent-notes``` block from the agent's output: persist it (if
// the repo has a registered agent) and return the output with the block
// stripped, so it never leaks into issue replies.
function absorbNotes(agent, out) {
  const s = String(out || '');
  // End-anchored: the notes block is instructed to be last, and the anchor
  // makes the match run to the FINAL fence — notes containing inner ``` fences
  // would otherwise be truncated at the first one and leak into the reply.
  const m = s.match(/```ragent-notes\s*\n([\s\S]*?)\n?```\s*$/i);
  if (!m) return s;
  const stripped = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  if (!agent) return stripped;
  try {
    fs.mkdirSync(path.dirname(agent.notesPath), { recursive: true });
    fs.writeFileSync(agent.notesPath, m[1].slice(0, NOTES_STORE_MAX));
    console.error(`[agent] ${agent.name}: notes updated (${m[1].length}B)`);
  } catch (e) {
    console.error(`[agent] ${agent.name}: notes write failed: ${e.message}`);
  }
  return stripped;
}

// ── Cross-repo requests: GitHub as the message bus ──────────────────────────
// An agent never touches another repo directly. Its only cross-repo action is
// emitting a ```ragent-request``` block, which the server turns into a labeled
// issue in the target repo — waking that repo's own agent, the only write path
// to it. Every such issue carries origin+depth metadata in an HTML comment;
// past MAX_REQUEST_DEPTH the server refuses to open further issues, so
// delegation chains terminate instead of looping.
const MAX_REQUEST_DEPTH = Number(process.env.RAGENT_MAX_DEPTH || 3);

function metaComment(origin, depth) {
  return `<!-- ragent-meta ${JSON.stringify({ origin, depth })} -->`;
}

// Read the LAST ragent-meta comment: the server always appends its own meta
// at the end of a body it composes, and agent-authored request text (which
// could embed a forged, lower-depth meta) is stripped in stripMeta — both are
// needed, or an injected agent could reset the depth counter and loop forever.
function parseMeta(body) {
  const all = [...String(body || '').matchAll(/<!--\s*ragent-meta\s*(\{[\s\S]*?\})\s*-->/g)];
  if (!all.length) return { origin: null, depth: 0 };
  try {
    const j = JSON.parse(all[all.length - 1][1]);
    return { origin: typeof j.origin === 'string' ? j.origin : null, depth: Number(j.depth) || 0 };
  } catch (_) { return { origin: null, depth: 0 }; }
}

function stripMeta(text) {
  return String(text || '').replace(/<!--\s*ragent-meta[\s\S]*?-->/g, '').trim();
}

// Extract ```ragent-request``` blocks from the agent's output; open a labeled
// issue in each valid target repo. Returns the output with blocks stripped and
// human-readable result lines to append to any posted reply. Requests are only
// honored from registered agents, toward registered peers, within the depth cap.
async function absorbRequests(agent, p, out) {
  let text = String(out || '');
  const blocks = [...text.matchAll(/```ragent-request\s*\n([\s\S]*?)```/gi)];
  const results = [];
  if (!blocks.length) return { text, results };
  const registry = agentRegistry();
  const srcRef = `${p.repo}#${p.issue_number || p.pr_number}`;
  const depth = (Number(p.depth) || 0) + 1;
  for (const b of blocks.slice(0, 3)) { // hard cap on requests per run
    text = text.replace(b[0], '').trim();
    let req; try { req = JSON.parse(b[1]); } catch (_) { req = null; }
    const target = req ? String(req.repo || '') : '';
    if (!req || !/^[\w.-]+\/[\w.-]+$/.test(target)) { results.push('⚠️ malformed ragent-request (need JSON {repo,title,body})'); continue; }
    if (!agent) { results.push(`⚠️ ragent-request refused: this repo has no registered agent`); continue; }
    if (target === p.repo) { results.push('⚠️ ragent-request to own repo ignored'); continue; }
    if (!registry[target]) { results.push(`⚠️ ragent-request to ${target} refused: no registered agent there`); continue; }
    if (depth > MAX_REQUEST_DEPTH) {
      console.error(`[request] ${srcRef} → ${target} refused (delegation depth ${depth} > ${MAX_REQUEST_DEPTH})`);
      results.push(`⚠️ ragent-request to ${target} refused: delegation depth limit (${MAX_REQUEST_DEPTH}) reached`);
      continue;
    }
    const title = String(req.title || `Request from ${srcRef}`).slice(0, 200);
    const body = `${stripMeta(req.body)}\n\n— requested by 🤖 Ragent[${agent.name}] from ${srcRef}\n\n${metaComment(srcRef, depth)}`;
    const num = await openIssue(target, title, body, [ISSUE_LABEL]);
    results.push(num
      ? `📨 requested work from ${target}'s agent → ${target}#${num}`
      : `⚠️ ragent-request to ${target} failed (could not open issue)`);
  }
  return { text, results };
}

// Close the delegation loop: after handling a requested issue, report the
// outcome on the origin issue. The literal 🤖 Ragent marker keeps the origin
// repo's webhook from re-triggering on this comment (no comment ping-pong);
// the origin agent picks it up from the thread on its next run.
async function notifyOrigin(p, message) {
  if (!p.origin) return;
  const m = String(p.origin).match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!m) return;
  const payload = JSON.stringify({ body: `${message}\n\n— 🤖 Ragent (update from ${p.repo}#${p.issue_number})` });
  const r = await githubPost(`/repos/${m[1]}/issues/${m[2]}/comments`, payload);
  if (r.ok) console.error(`[request] notified origin ${p.origin}`);
  else console.error(`[request] notify ${p.origin} failed → ${r.status || r.error}: ${(r.body || '').slice(0, 200)}`);
}

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
const activeRepos = new Set();      // per-repo serialization: one run per repo at
                                    // a time (worktrees share the repo's cache
                                    // clone; concurrent fetch/worktree ops on it
                                    // would race), different repos in parallel.

function enqueueDispatch(p) {
  const key = p.kind === 'implement' ? `${p.repo}#issue-${p.issue_number}`
    : p.kind === 'converse' ? `${p.repo}#issue-${p.issue_number}#c${p.comment_id || Date.now()}`
    : `${p.repo}#${p.pr_number}`;
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
  let i = 0;
  while (dispatchActive < DISPATCH_MAX && i < dispatchQueue.length) {
    if (activeRepos.has(dispatchQueue[i].payload.repo)) { i++; continue; }
    const job = dispatchQueue.splice(i, 1)[0];
    dispatchActive++;
    activeRepos.add(job.payload.repo);
    const runner = job.payload.kind === 'implement' ? runImplement
      : job.payload.kind === 'converse' ? runConverse
      : runDispatch;
    runner(job.payload)
      .catch((e) => console.error(`[dispatch] ${job.key} failed:`, scrubToken(e.message)))
      .finally(() => {
        dispatchActive--;
        activeRepos.delete(job.payload.repo);
        dispatchInflight.delete(job.key);
        pumpDispatch();
      });
  }
}

// The agent process gets a MINIMAL env: shell basics + Claude auth only —
// never the server's full env (GITHUB_WEBHOOK_SECRET, PROBE_DISPATCH_SECRET,
// AUTH_PASSWORD stay server-side). The repo credential reaches the agent via
// its worktree's authenticated remote instead: each agent owns the full git
// workflow for ITS OWN repository, pushes included. Trust model: this
// instance manages the operator's own private repos with trusted issue
// authors — cross-repo discipline is structural (a job's worktree contains
// only its own repo) plus a prompt contract, not a runtime gate. If a repo
// ever goes public, switch to per-repo tokens in the registry instead.
const AGENT_ENV_KEYS = ['HOME', 'TERM', 'LANG', 'LC_ALL', 'USER',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  // network plumbing the CLI needs in proxied/corporate deployments
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS'];
function agentEnv() {
  const env = { PATH: `/workspace/.local/bin:${process.env.PATH || ''}` };
  for (const k of AGENT_ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  return env;
}

// Authenticated remote URL for a repo. scrubToken keeps the token out of
// logged error messages.
function authUrl(repo) {
  return `https://x-access-token:${ghToken()}@github.com/${repo}.git`;
}
function scrubToken(s) {
  const t = ghToken();
  if (!t) return String(s || '');
  return String(s || '').split(t).join('***');
}

// Run `claude -p` ASYNCHRONOUSLY (spawn, not execSync) so it never blocks the
// Node event loop. This process also serves the web terminal (WebSocket + pty);
// a synchronous multi-minute dispatch would freeze it for the whole run. Writes
// the prompt to stdin, resolves stdout; rejects on non-zero exit (with .stdout
// attached, matching the old execSync error shape) or a 20-minute timeout.
function runClaudeP(prompt, cwd) {
  const claudeBin = fs.existsSync('/workspace/.local/bin/claude') ? '/workspace/.local/bin/claude' : 'claude';
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, ['-p', '--dangerously-skip-permissions'], {
      cwd,
      env: agentEnv(),
    });
    let out = '', err = '';
    const MAX = 64 * 1024 * 1024;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('claude -p timed out (20m)')); }, 20 * 60 * 1000);
    child.stdout.on('data', (d) => { out += d; if (out.length > MAX) out = out.slice(-MAX); });
    child.stderr.on('data', (d) => { err += d; if (err.length > MAX) err = err.slice(-MAX); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const e = new Error(`claude -p exited with code ${code}`); e.stdout = out; e.stderr = err; reject(e);
    });
    child.stdin.on('error', () => {}); // ignore EPIPE if the child exits early
    child.stdin.write(prompt); child.stdin.end();
  });
}

// Per-repo cache clone, created once; subsequent dispatches only fetch
// (incremental, reuses the object store) instead of re-downloading. Origin is
// the authenticated URL (re-set every time so token changes take effect);
// worktrees share this config, which is intentional: the agent owns pushes to
// its own repo.
function prepareCache(repo) {
  const slug = repo.replace('/', '-');
  const cacheDir = path.join(WORKSPACE_DIR, 'dispatch', '.cache', slug);
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    execSync(`rm -rf '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
    execSync(`mkdir -p '${shellEscape(path.dirname(cacheDir))}'`, { stdio: 'ignore' });
    execSync(`git clone --filter=blob:none --no-checkout '${shellEscape(authUrl(repo))}' '${shellEscape(cacheDir)}'`, { stdio: 'ignore' });
  }
  execSync(`git -C '${shellEscape(cacheDir)}' remote set-url origin '${shellEscape(authUrl(repo))}'`, { stdio: 'ignore' });
  return cacheDir;
}

// Fetch a branch into the cache's remote-tracking ref. Forced refspec: the
// remote branch may have been rewritten.
function fetchBranch(cacheDir, branch) {
  execSync(`git -C '${shellEscape(cacheDir)}' fetch --no-tags origin '+refs/heads/${shellEscape(branch)}:refs/remotes/origin/${shellEscape(branch)}'`, { stdio: 'ignore' });
}

async function runDispatch(p) {
  const slug = p.repo.replace('/', '-');
  const dir = path.join(WORKSPACE_DIR, 'dispatch', `${slug}-pr${p.pr_number}`);
  console.error(`[dispatch] ${p.repo}#${p.pr_number} → ${dir} (branch ${p.branch}, active=${dispatchActive})`);

  const cacheDir = prepareCache(p.repo);
  fetchBranch(cacheDir, p.branch);

  // Per-PR worktree off the shared cache: isolated working tree, near-zero disk
  // (shares the cache object store), safe for concurrent PRs of the same repo.
  execSync(`git -C '${shellEscape(cacheDir)}' worktree prune`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}' 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree add --force -B '${shellEscape(p.branch)}' '${shellEscape(dir)}' 'origin/${shellEscape(p.branch)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(dir)}' config user.name '${shellEscape(DISPATCH_AUTHOR_NAME)}'`, { stdio: 'ignore' });
  if (DISPATCH_AUTHOR_EMAIL) execSync(`git -C '${shellEscape(dir)}' config user.email '${shellEscape(DISPATCH_AUTHOR_EMAIL)}'`, { stdio: 'ignore' });

  const agent = getAgent(p.repo);
  const findingsText = (p.findings || [])
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}\n   ${f.detail || ''}${f.repro_steps && f.repro_steps.length ? `\n   Repro: ${f.repro_steps.join(' → ')}` : ''}`)
    .join('\n');
  const prompt = agentPreamble(agent, p) + `You are fixing a pull request. Probe (an acceptance agent) tested PR #${p.pr_number} on its preview deployment and found these issues:

${findingsText}

Summary: ${p.summary || ''}

Fix ONLY these reported issues in this repository. Do not make unrelated changes. THIS repository is your only scope — never use your git credentials against any other repository; if the fix requires changes elsewhere, say so instead. When done, commit with a clear message and push to the current branch (\`${p.branch}\`):

  git add -A && git commit -m "Fix: <what you fixed>"
  git push origin ${p.branch}

The remote is already authenticated. If the push is rejected because the branch moved, run \`git pull --rebase origin ${p.branch}\` and push again.`;

  // Drive the Claude Code CLI in headless print mode (already installed in the
  // container; the SDK npm package isn't in the production deps). Prompt via
  // stdin; the CLI uses the container's existing Claude auth.
  try {
    const reqs = await absorbRequests(agent, p, absorbNotes(agent, await runClaudeP(prompt, dir)));
    reqs.results.forEach((r) => console.error(`[dispatch] ${p.repo}#${p.pr_number} ${r}`));
    console.error(`[dispatch] ${p.repo}#${p.pr_number} claude finished: ${reqs.text.slice(-300)}`);
  } catch (e) {
    console.error(`[dispatch] ${p.repo}#${p.pr_number} claude error: ${scrubToken(e.message)}${e.stdout ? ' | out: ' + String(e.stdout).slice(-300) : ''}`);
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
  const base = p.base_branch || 'main';
  const branch = `probe/issue-${p.issue_number}`;
  const dir = path.join(WORKSPACE_DIR, 'dispatch', `${slug}-issue${p.issue_number}`);
  console.error(`[implement] ${p.repo} issue#${p.issue_number} → ${dir} (new branch ${branch} off ${base})`);

  const cacheDir = prepareCache(p.repo);
  fetchBranch(cacheDir, base);

  execSync(`git -C '${shellEscape(cacheDir)}' worktree prune`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}' 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree add --force -B '${shellEscape(branch)}' '${shellEscape(dir)}' 'origin/${shellEscape(base)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(dir)}' config user.name '${shellEscape(DISPATCH_AUTHOR_NAME)}'`, { stdio: 'ignore' });
  if (DISPATCH_AUTHOR_EMAIL) execSync(`git -C '${shellEscape(dir)}' config user.email '${shellEscape(DISPATCH_AUTHOR_EMAIL)}'`, { stdio: 'ignore' });

  const agent = getAgent(p.repo);
  const prompt = agentPreamble(agent, p) + `You are responding to a GitHub issue in this repository. Decide which case applies:

ISSUE #${p.issue_number}: ${p.title}

${p.body || '(no description provided)'}

CASE A — the issue asks for a CODE CHANGE you can make:
  Implement it (focused edits only, no unrelated changes), then commit (do NOT push, do NOT open a PR — that is handled for you):
    git add -A && git commit -m "Implement: <what you did> (#${p.issue_number})"
  A PR will be opened automatically.

CASE B — the issue is a QUESTION, a status/progress request, a discussion, or otherwise needs NO code change (or you cannot make a meaningful change):
  Do NOT commit anything. Instead, write your COMPLETE answer as your final message — it will be posted VERBATIM as a comment on the issue. Read the actual code/docs to ground your answer and reference specifics. Be concise and useful.
  Your final message must contain ONLY the answer itself, written directly to the issue reader. NO preamble or meta-commentary — do not say things like "this is a question", "CASE B", "here is my answer", or describe what you are about to do. Start straight with the substantive response.

Pick exactly one. Committing ⇒ a PR is opened. No commit ⇒ your final message is posted as an issue comment.

THIS repository is your only scope — never use your git credentials against any other repository. If the task requires changes elsewhere, say so (or file a ragent-request if you have peers) instead of doing it yourself.`;

  try {
    const reqs = await absorbRequests(agent, p, absorbNotes(agent, await runClaudeP(prompt, dir)));
    const out = reqs.text;
    reqs.results.forEach((r) => console.error(`[implement] issue#${p.issue_number} ${r}`));
    console.error(`[implement] issue#${p.issue_number} claude finished: ${String(out).slice(-300)}`);

    const ahead = execSync(`git -C '${shellEscape(dir)}' rev-list --count 'origin/${shellEscape(base)}..HEAD'`, { encoding: 'utf8' }).trim();
    if (ahead === '0' || ahead === '') {
      // No code change (Case B: question / status / can't act) → reply on the
      // issue with the agent's final message instead of opening an empty PR.
      console.error(`[implement] issue#${p.issue_number}: no commits → replying as issue comment`);
      let reply = String(out || '').trim() || '(the agent produced no actionable change and no response)';
      if (reqs.results.length) reply += '\n\n' + reqs.results.join('\n');
      await postIssueComment(p, reply, `replied to #${p.issue_number}; no code change needed`, agent);
      await notifyOrigin(p, `Replied on ${p.repo}#${p.issue_number} — no code change was needed.`);
      return;
    }
    // probe/issue-N is owned by this flow — a re-run legitimately rewrites it.
    execSync(`git -C '${shellEscape(dir)}' push --force origin 'HEAD:refs/heads/${shellEscape(branch)}'`, { stdio: 'ignore' });
    const prNum = await openPullRequest(p, branch, base, agent);
    // Surface any cross-repo requests filed during the run on the issue, so
    // the humans watching it can see a dependent task now exists elsewhere.
    if (reqs.results.length) {
      await postIssueComment(p, reqs.results.join('\n'), `while implementing #${p.issue_number}`, agent);
    }
    await notifyOrigin(p, (prNum
      ? `Handled ${p.repo}#${p.issue_number}: opened PR https://github.com/${p.repo}/pull/${prNum}`
      : `Handled ${p.repo}#${p.issue_number}: pushed branch \`${branch}\` (PR may already exist)`)
      + (reqs.results.length ? '\n' + reqs.results.join('\n') : ''));
  } catch (e) {
    console.error(`[implement] issue#${p.issue_number} error: ${scrubToken(e.message)}${e.stdout ? ' | out: ' + String(e.stdout).slice(-300) : ''}`);
    // Don't leave the requesting agent waiting on a silent failure.
    notifyOrigin(p, `⚠️ Failed to handle ${p.repo}#${p.issue_number}: ${scrubToken(e.message)}`).catch(() => {});
    throw e;
  } finally {
    try {
      execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}'`, { stdio: 'ignore' });
    } catch (_) {
      execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
    }
  }
}

// POST to the GitHub API with a small retry on transient network errors
// (EPIPE / ECONNRESET / socket hang up) so a flake doesn't silently drop the
// call (e.g. an issue reply or an opened PR). Returns { ok, status, body }.
function githubPost(apiPath, payload, attempt = 1) {
  const https = require('https');
  const MAX = 3;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method: 'POST',
      headers: {
        Authorization: `Bearer ${ghToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ragent-dispatch',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () =>
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: b }));
    });
    req.on('error', (e) => {
      if (attempt < MAX) {
        console.error(`[dispatch] github POST ${apiPath} ${e.code || e.message} — retry ${attempt + 1}/${MAX}`);
        setTimeout(() => resolve(githubPost(apiPath, payload, attempt + 1)), attempt * 800);
      } else {
        resolve({ ok: false, status: 0, body: '', error: e.message });
      }
    });
    req.write(payload); req.end();
  });
}

// Post a comment on the issue (Case B reply, or a converse reply). The
// signature keeps the literal "🤖 Ragent" marker — the webhook's self-reply
// filter matches on it — and adds the agent's name for registered repos so
// humans can tell which agent is speaking.
async function postIssueComment(p, body, footer, agent) {
  const capped = body.length > 60000 ? body.slice(0, 60000) + '\n\n…(truncated)' : body;
  const note = footer || `replied to #${p.issue_number}`;
  const who = agent ? `Ragent[${agent.name}]` : 'Ragent';
  const payload = JSON.stringify({ body: `${capped}\n\n— 🤖 ${who} (${note})` });
  const r = await githubPost(`/repos/${p.repo}/issues/${p.issue_number}/comments`, payload);
  if (r.ok) console.error(`[dispatch] issue#${p.issue_number} → posted reply comment`);
  else console.error(`[dispatch] issue#${p.issue_number} comment failed → ${r.status || r.error}: ${(r.body || '').slice(0, 200)}`);
}

// Open a PR via the GitHub API. Idempotent: a 422 (PR already exists for this
// head) on a re-run is fine.
async function openPullRequest(p, head, base, agent) {
  const who = agent ? `Ragent[${agent.name}]` : 'Ragent';
  const payload = JSON.stringify({
    title: p.title || `Implement issue #${p.issue_number}`,
    head, base,
    body: `Implements #${p.issue_number}.\n\nCloses #${p.issue_number}\n\n— generated by ${who} from the issue; Probe will verify the preview.`,
  });
  const r = await githubPost(`/repos/${p.repo}/pulls`, payload);
  if (r.ok) {
    let num; try { num = JSON.parse(r.body).number; } catch (_) {}
    console.error(`[implement] issue#${p.issue_number} → opened PR #${num} (${head} → ${base})`);
    return num || null;
  }
  console.error(`[implement] issue#${p.issue_number} open PR → ${r.status || r.error}: ${(r.body || '').slice(0, 200)}`);
  return null;
}

// Conversation path: read the repo + the whole issue thread, answer the latest
// "/ragent" request as an issue comment. No commit, no PR — read-only worktree.
async function runConverse(p) {
  const slug = p.repo.replace('/', '-');
  const dir = path.join(WORKSPACE_DIR, 'dispatch', `${slug}-converse-${p.issue_number}`);
  console.error(`[converse] ${p.repo} issue#${p.issue_number} → reading repo + thread`);

  const cacheDir = prepareCache(p.repo);
  execSync(`git -C '${shellEscape(cacheDir)}' fetch --no-tags origin HEAD`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree prune`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}' 2>/dev/null || true`, { stdio: 'ignore', shell: '/bin/bash' });
  execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
  execSync(`git -C '${shellEscape(cacheDir)}' worktree add --force --detach '${shellEscape(dir)}' FETCH_HEAD`, { stdio: 'ignore' });

  try {
    const agent = getAgent(p.repo);
    const thread = await getIssueThread(p);
    const threadText = thread.map((c) => `[@${c.author}]: ${c.body}`).join('\n\n---\n\n');
    const prompt = agentPreamble(agent, p) + `You are taking part in an ongoing discussion on a GitHub issue in this repository. Read the repo (code/docs) to ground your answer.

ISSUE #${p.issue_number}: ${p.title}

${p.body || '(no description)'}

--- CONVERSATION SO FAR (oldest first) ---
${threadText || '(no prior comments)'}

--- LATEST REQUEST (respond to this) ---
${p.request || '(see the latest comment above)'}

Write your reply to the latest request. Read code/docs as needed to be specific and correct. Be concise.

If — and ONLY if — the user asks you to open a new development issue (e.g. "open an issue to build X", "把这个开成开发 issue"), append at the VERY END of your reply this exact fenced block (nothing after it):

\`\`\`ragent:open-issue
TITLE: <a concise issue title>
BODY: <a clear, self-contained spec a coding agent can implement directly — what to build, acceptance criteria, relevant files/paths>
\`\`\`

Otherwise output ONLY the reply itself — no preamble, no meta-commentary, no block.`;

    const reqs = await absorbRequests(agent, p, absorbNotes(agent, await runClaudeP(prompt, dir)));
    let reply = reqs.text.trim() || '(no response generated)';

    // Spin-off: if the agent emitted a ragent:open-issue block, open a new
    // development issue (auto-labeled so Ragent's own webhook then implements it),
    // strip the block from the reply, and link the new issue. The spin-off
    // carries origin/depth metadata like a cross-repo request: chains that pass
    // through same-repo spin-offs still count against the delegation cap.
    const blk = reply.match(/```ragent:open-issue\s*([\s\S]*?)```/i);
    if (blk) {
      const t = blk[1].match(/TITLE:\s*(.+)/i);
      const b = blk[1].match(/BODY:\s*([\s\S]*)/i);
      const title = (t && t[1].trim()) || `Task from #${p.issue_number}`;
      const spinDepth = (Number(p.depth) || 0) + 1;
      const issueBody = stripMeta((b && b[1].trim()) || '') +
        `\n\n— spun off from #${p.issue_number} by 🤖 Ragent\n\n${metaComment(`${p.repo}#${p.issue_number}`, spinDepth)}`;
      reply = reply.replace(blk[0], '').trim();
      const num = spinDepth > MAX_REQUEST_DEPTH ? null
        : await openIssue(p.repo, title, issueBody, [ISSUE_LABEL]);
      reply += num
        ? `\n\n📋 已开 #${num}（已打 \`${ISSUE_LABEL}\` label，将自动实现）。`
        : spinDepth > MAX_REQUEST_DEPTH
          ? `\n\n⚠️ 想开发开 issue，但委托链已达深度上限（${MAX_REQUEST_DEPTH}），未创建。`
          : `\n\n⚠️ 想开发开 issue，但创建失败了（token 需 Issues:write，label \`${ISSUE_LABEL}\` 需存在）。`;
    }
    if (reqs.results.length) reply += '\n\n' + reqs.results.join('\n');
    await postIssueComment(p, reply, `replied to #${p.issue_number}`, agent);
    console.error(`[converse] issue#${p.issue_number} replied${blk ? ' (+ spun off issue)' : ''}`);
  } catch (e) {
    console.error(`[converse] issue#${p.issue_number} error: ${scrubToken(e.message)}${e.stdout ? ' | out: ' + String(e.stdout).slice(-200) : ''}`);
    throw e;
  } finally {
    try {
      execSync(`git -C '${shellEscape(cacheDir)}' worktree remove --force '${shellEscape(dir)}'`, { stdio: 'ignore' });
    } catch (_) {
      execSync(`rm -rf '${shellEscape(dir)}'`, { stdio: 'ignore' });
    }
  }
}

// Open a new issue (spin-off from a discussion). Labels are applied at creation
// so Ragent's own webhook picks it up and implements it. Returns the number.
async function openIssue(repo, title, body, labels) {
  const payload = JSON.stringify({ title, body, labels: labels || [] });
  const r = await githubPost(`/repos/${repo}/issues`, payload);
  if (r.ok) {
    let num; try { num = JSON.parse(r.body).number; } catch (_) {}
    console.error(`[converse] spun off issue #${num} on ${repo} (labels: ${(labels || []).join(',')})`);
    return num;
  }
  console.error(`[converse] open issue failed → ${r.status || r.error}: ${(r.body || '').slice(0, 200)}`);
  return null;
}

// Resolve a PR's head branch name (https GET) — needed to fix the right branch
// when a /ragent fix request comes in on a PR.
function getPullBranch(repo, prNumber) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${repo}/pulls/${prNumber}`, method: 'GET',
      headers: {
        Authorization: `Bearer ${ghToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ragent-dispatch',
      },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        try { const pr = JSON.parse(b); resolve(pr && pr.head && pr.head.ref); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Fetch the issue's comment thread (https GET). Returns [{author, body}] oldest-first.
function getIssueThread(p) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${p.repo}/issues/${p.issue_number}/comments?per_page=100`, method: 'GET',
      headers: {
        Authorization: `Bearer ${ghToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ragent-dispatch',
      },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        try {
          const arr = JSON.parse(b);
          resolve(Array.isArray(arr) ? arr.map((c) => ({ author: c.user && c.user.login, body: c.body || '' })) : []);
        } catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
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
