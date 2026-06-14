const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Claude Code stores sessions at ~/.claude/projects/{project-dir}/{session-id}.jsonl
// For /workspace, project-dir is "-workspace"
const CLAUDE_PROJECT_DIR = '-workspace';

class SessionStore {
  constructor(options = {}) {
    this.storePath = options.storePath || process.env.SESSION_STORE_PATH || '/workspace/data/sessions';
    this.claudeBase = options.claudeBase || path.join(process.env.HOME || '/workspace', '.claude', 'projects', CLAUDE_PROJECT_DIR);
    this.indexPath = path.join(this.storePath, 'index.json');

    // Ensure directories exist
    fs.mkdirSync(this.storePath, { recursive: true });
    fs.mkdirSync(this.claudeBase, { recursive: true });

    // Initialize index if it doesn't exist
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '[]', 'utf-8');
    }
  }

  _readIndex() {
    try {
      const data = fs.readFileSync(this.indexPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  _writeIndex(index) {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * Create a new session entry.
   * sdkSessionId is initially null — set when SDK returns its session_id.
   */
  createSession(userId = 'default', title = '') {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const meta = {
      sessionId,        // our internal ID (used as API key)
      sdkSessionId: null, // SDK's session ID (set after first query)
      userId,
      title: title || `Session ${sessionId.slice(0, 8)}`,
      createdAt: now,
      lastActive: now,
    };

    const index = this._readIndex();
    index.push(meta);
    this._writeIndex(index);

    return meta;
  }

  /**
   * List all sessions, optionally filtered by userId.
   * Sorted by lastActive descending.
   */
  listSessions(userId) {
    const index = this._readIndex();
    let sessions = userId ? index.filter(s => s.userId === userId) : index;
    sessions.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
    return sessions;
  }

  /**
   * Get metadata for a single session.
   */
  getSessionMeta(sessionId) {
    const index = this._readIndex();
    return index.find(s => s.sessionId === sessionId) || null;
  }

  /**
   * Update session metadata fields (title, lastActive, sdkSessionId, etc.)
   */
  updateSessionMeta(sessionId, updates) {
    const index = this._readIndex();
    const session = index.find(s => s.sessionId === sessionId);
    if (!session) return null;

    Object.assign(session, updates);
    this._writeIndex(index);
    return session;
  }

  /**
   * Backup session files from ~/.claude/projects/{project-dir}/
   * to the persistent store using the SDK session ID.
   *
   * Claude Code stores:
   *   {sdkSessionId}.jsonl           - main conversation
   *   {sdkSessionId}/                - subdirectory with tool-results, subagents, etc.
   */
  saveSession(sessionId) {
    const meta = this.getSessionMeta(sessionId);
    if (!meta || !meta.sdkSessionId) return false;

    const sdkId = meta.sdkSessionId;
    const sessionDir = path.join(this.storePath, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy main JSONL file
    const jsonlSrc = path.join(this.claudeBase, `${sdkId}.jsonl`);
    const jsonlDst = path.join(sessionDir, `${sdkId}.jsonl`);
    if (fs.existsSync(jsonlSrc)) {
      fs.copyFileSync(jsonlSrc, jsonlDst);
    }

    // Copy session subdirectory (tool-results, subagents, etc.)
    const subDirSrc = path.join(this.claudeBase, sdkId);
    const subDirDst = path.join(sessionDir, sdkId);
    if (fs.existsSync(subDirSrc) && fs.statSync(subDirSrc).isDirectory()) {
      // Remove old copy first to avoid stale files
      if (fs.existsSync(subDirDst)) {
        fs.rmSync(subDirDst, { recursive: true, force: true });
      }
      fs.cpSync(subDirSrc, subDirDst, { recursive: true });
    }

    // Update lastActive
    this.updateSessionMeta(sessionId, { lastActive: new Date().toISOString() });

    return true;
  }

  /**
   * Restore session files from persistent store back to
   * ~/.claude/projects/{project-dir}/ so that `resume` can find them.
   */
  loadSession(sessionId) {
    const meta = this.getSessionMeta(sessionId);
    if (!meta || !meta.sdkSessionId) return false;

    const sdkId = meta.sdkSessionId;
    const sessionDir = path.join(this.storePath, sessionId);
    if (!fs.existsSync(sessionDir)) {
      return false;
    }

    // Restore main JSONL file
    const jsonlSrc = path.join(sessionDir, `${sdkId}.jsonl`);
    const jsonlDst = path.join(this.claudeBase, `${sdkId}.jsonl`);
    if (fs.existsSync(jsonlSrc)) {
      fs.copyFileSync(jsonlSrc, jsonlDst);
    }

    // Restore session subdirectory
    const subDirSrc = path.join(sessionDir, sdkId);
    const subDirDst = path.join(this.claudeBase, sdkId);
    if (fs.existsSync(subDirSrc) && fs.statSync(subDirSrc).isDirectory()) {
      fs.cpSync(subDirSrc, subDirDst, { recursive: true });
    }

    return true;
  }

  /**
   * Delete a session from both persistent store and index.
   * Also removes the SDK files from ~/.claude/ if present.
   */
  deleteSession(sessionId) {
    const meta = this.getSessionMeta(sessionId);

    // Clean up SDK files from ~/.claude/
    if (meta && meta.sdkSessionId) {
      const sdkId = meta.sdkSessionId;
      const jsonlPath = path.join(this.claudeBase, `${sdkId}.jsonl`);
      const subDir = path.join(this.claudeBase, sdkId);
      try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch {}
      try { if (fs.existsSync(subDir)) fs.rmSync(subDir, { recursive: true, force: true }); } catch {}
    }

    // Remove from persistent store
    const sessionDir = path.join(this.storePath, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    // Remove from index
    const index = this._readIndex();
    const filtered = index.filter(s => s.sessionId !== sessionId);
    this._writeIndex(filtered);

    return true;
  }

  /**
   * Check if a session's JSONL exists in Claude's local directory
   * (i.e., it's already loaded / ready for resume).
   */
  isSessionLocal(sessionId) {
    const meta = this.getSessionMeta(sessionId);
    if (!meta || !meta.sdkSessionId) return false;
    const jsonlPath = path.join(this.claudeBase, `${meta.sdkSessionId}.jsonl`);
    return fs.existsSync(jsonlPath);
  }
}

module.exports = SessionStore;
