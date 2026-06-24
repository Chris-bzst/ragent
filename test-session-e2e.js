#!/usr/bin/env node
/**
 * Session Persistence E2E Test
 *
 * 在 Claude Code 外面运行：
 *   cd /workspace/ragent
 *   node test-session-e2e.js
 *
 * 前提：
 *   1. ANTHROPIC_API_KEY 已设置（或 claude CLI 已登录）
 *   2. 没有其他服务占用 TEST_PORT（默认 4002）
 *
 * 测试流程：
 *   1. 启动 ragent 服务器
 *   2. 创建 session
 *   3. 发送第一条消息（让 AI 记住一个随机数）
 *   4. 等待回复完成 → session 自动保存
 *   5. 删除 ~/.claude/ 下的 session 文件（模拟重启）
 *   6. 发送第二条消息（让 AI 回忆那个数字）→ 触发 resume
 *   7. 检查回复中是否包含那个数字
 *   8. 清理并退出
 */

const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load ws from backend's node_modules
const WebSocket = require(path.join(__dirname, 'backend', 'node_modules', 'ws'));

const TEST_PORT = process.env.TEST_PORT || 4002;
const SERVER_DIR = path.join(__dirname, 'backend');
const TIMEOUT = 120_000; // 2 min per chat round
const MAGIC_NUMBER = Math.floor(Math.random() * 9000) + 1000; // 4-digit random

// ── Helpers ──────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function httpJSON(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForServer(maxWait = 15_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      httpJSON('GET', '/health')
        .then((r) => {
          if (r.status === 200) return resolve();
          throw new Error('not ready');
        })
        .catch(() => {
          if (Date.now() - start > maxWait) return reject(new Error('Server start timeout'));
          setTimeout(check, 500);
        });
    };
    check();
  });
}

/**
 * Send a chat message and collect all responses until chat_end.
 * Returns the concatenated assistant text.
 */
function chat(ws, sessionId, prompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chat timeout (${TIMEOUT / 1000}s)`)), TIMEOUT);
    let assistantText = '';

    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.sessionId !== sessionId) return;

      if (msg.type === 'chat_message') {
        const ev = msg.message;
        // Collect assistant text from content blocks
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text') assistantText += block.text;
          }
        }
        // Also check for result messages
        if (ev.type === 'result' && ev.result) {
          assistantText += '\n' + (typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result));
        }
      }

      if (msg.type === 'chat_end') {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(assistantText);
      }

      if (msg.type === 'chat_error') {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        reject(new Error(`Chat error: ${msg.error}`));
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'chat', sessionId, prompt }));
  });
}

function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  let serverProc = null;
  let ws = null;
  let sessionId = null;
  let exitCode = 1;

  try {
    // 1. Start server
    log(`Starting ragent server on port ${TEST_PORT}...`);
    serverProc = spawn('node', ['server.js'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        AUTH_USERNAME: '',
        AUTH_PASSWORD: '',
        SESSION_AUTO_SAVE: 'true',
        CLAUDECODE: '',  // bypass nesting check for SDK
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

    await waitForServer();
    log('Server is up.');

    // 2. Create session
    const createRes = await httpJSON('POST', '/api/sessions', { title: 'E2E Persistence Test' });
    if (createRes.status !== 201) throw new Error(`Create session failed: ${JSON.stringify(createRes)}`);
    sessionId = createRes.body.sessionId;
    log(`Created session: ${sessionId}`);

    // 3. Connect WebSocket
    ws = await connectWS();
    log('WebSocket connected.');

    // 4. Round 1: Ask AI to remember a number
    log(`Round 1: Asking AI to remember number ${MAGIC_NUMBER}...`);
    const reply1 = await chat(
      ws,
      sessionId,
      `Remember this exact number: ${MAGIC_NUMBER}. Just confirm you've noted it. Do NOT use any tools. Reply in one short sentence.`
    );
    log(`Round 1 reply: ${reply1.slice(0, 200)}`);

    // 5. Verify session was saved
    const metaAfterR1 = (await httpJSON('GET', `/api/sessions/${sessionId}`)).body;
    if (!metaAfterR1.sdkSessionId) throw new Error('sdkSessionId not captured after round 1');
    log(`SDK session ID captured: ${metaAfterR1.sdkSessionId}`);

    // 6. Simulate restart: delete local SDK files
    const claudeBase = path.join(
      process.env.HOME || '/workspace',
      '.claude', 'projects', '-workspace'
    );
    const jsonlPath = path.join(claudeBase, `${metaAfterR1.sdkSessionId}.jsonl`);
    const subDir = path.join(claudeBase, metaAfterR1.sdkSessionId);

    log('Deleting local SDK session files (simulating restart)...');
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
    if (fs.existsSync(subDir)) fs.rmSync(subDir, { recursive: true, force: true });
    log(`  Deleted: ${jsonlPath} (existed: ${fs.existsSync(jsonlPath) ? 'still there!' : 'gone'})`);

    // Verify files are gone
    if (fs.existsSync(jsonlPath)) throw new Error('Failed to delete local JSONL');

    // 7. Verify backup exists
    const backupDir = path.join(
      process.env.SESSION_STORE_PATH || '/workspace/data/sessions',
      sessionId
    );
    const backupJsonl = path.join(backupDir, `${metaAfterR1.sdkSessionId}.jsonl`);
    if (!fs.existsSync(backupJsonl)) throw new Error(`Backup JSONL not found at ${backupJsonl}`);
    log(`Backup verified at: ${backupJsonl}`);

    // 8. Round 2: Ask AI to recall the number (triggers load + resume)
    log('Round 2: Asking AI to recall the number (resume from backup)...');
    const reply2 = await chat(
      ws,
      sessionId,
      `What exact number did I ask you to remember? Reply with ONLY the number, nothing else.`
    );
    log(`Round 2 reply: "${reply2.trim()}"`);

    // 9. Check if the number is in the response
    if (reply2.includes(String(MAGIC_NUMBER))) {
      log(`✅ SUCCESS: AI correctly recalled ${MAGIC_NUMBER} after session restore!`);
      exitCode = 0;
    } else {
      log(`❌ FAIL: Expected ${MAGIC_NUMBER} in response, got: "${reply2.trim()}"`);
    }

    // 10. Verify local files were restored
    if (fs.existsSync(jsonlPath)) {
      log('✅ Local JSONL was restored from backup before resume.');
    } else {
      log('⚠️  Local JSONL not found after resume (may have been cleaned up).');
    }

  } catch (err) {
    log(`❌ ERROR: ${err.message}`);
    console.error(err);
  } finally {
    // Cleanup
    if (ws) try { ws.close(); } catch {}
    if (sessionId) {
      try { await httpJSON('DELETE', `/api/sessions/${sessionId}`); } catch {}
    }
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // Give it a moment to shut down
      await new Promise((r) => setTimeout(r, 1000));
      if (!serverProc.killed) serverProc.kill('SIGKILL');
    }
    log(`Done. Exit code: ${exitCode}`);
    process.exit(exitCode);
  }
}

main();
