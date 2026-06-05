'use strict';

/**
 * queue-store.js — the single source of truth for the per-session task queue.
 *
 * The queue for a session lives at:  ~/.claude-queue/queue-<session_id>.json
 *
 * It is shared between three processes:
 *   - the Stop hook (scripts/stop-hook.js)  — pops the head item
 *   - the terminal UI (ui/queue-ui.js)      — appends / removes / reorders items
 *   - the test suite                        — exercises every operation
 *
 * Because the UI and the hook can touch the file at the same moment, two things
 * protect it: (1) every read-modify-write runs under a short-lived cross-process
 * lock (withLock) so concurrent mutations can't lose each other's updates, and
 * (2) each write goes through a temp file + atomic rename() so a reader never
 * sees a half-written file. The format is also resilient: a missing, empty, or
 * corrupt file is treated as an empty queue rather than throwing.
 *
 * File shape:
 *   {
 *     "version": 1,
 *     "sessionId": "<id>",
 *     "queue": [ { "id", "text", "addedAt" }, ... ],   // pending, head = next
 *     "done":  [ { "id", "text", "addedAt", "doneAt" }, ... ]  // consumed
 *   }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Directory holding the queue files. Defaults to ~/.claude-queue but can be
 * overridden with the CLAUDE_QUEUE_DIR env var (used by tests, and handy if a
 * user wants the queues somewhere else). Resolved lazily so the override can be
 * set after this module is required.
 */
function queueDir() {
  return process.env.CLAUDE_QUEUE_DIR || path.join(os.homedir(), '.claude-queue');
}

/** Sanitize a session id so it is always a safe single path segment. */
function safeSessionId(sessionId) {
  const s = String(sessionId || 'default');
  return s.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
}

/** Absolute path to the queue file for a given session. */
function queuePath(sessionId) {
  return path.join(queueDir(), `queue-${safeSessionId(sessionId)}.json`);
}

function ensureDir() {
  fs.mkdirSync(queueDir(), { recursive: true });
}

/** Synchronous millisecond sleep (these helpers run in short-lived CLI processes). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding a per-session cross-process lock, so a read-modify-write
 * in one process (e.g. the UI appending) can't be clobbered by a concurrent one
 * in another (e.g. the Stop hook popping). The lock is an O_EXCL lock file next
 * to the queue file; a lock older than 5s is assumed stale (crashed holder) and
 * stolen, and after 2s of contention we proceed anyway so we can never deadlock.
 */
function withLock(sessionId, fn) {
  ensureDir();
  const lock = queuePath(sessionId) + '.lock';
  const deadline = Date.now() + 2000;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
          fs.unlinkSync(lock); // steal a stale lock
          continue;
        }
      } catch (_e) {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() > deadline) break; // give up waiting rather than hang
      sleepMs(20);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_e) {}
      try { fs.unlinkSync(lock); } catch (_e) {}
    }
  }
}

function emptyState(sessionId) {
  return { version: 1, sessionId: safeSessionId(sessionId), queue: [], done: [] };
}

/** Read the full state for a session. Never throws; returns an empty state on any problem. */
function read(sessionId) {
  const file = queuePath(sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return emptyState(sessionId);
  }
  if (!raw || !raw.trim()) {
    return emptyState(sessionId);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    // Corrupt file — treat as empty rather than wedging the hook/UI.
    return emptyState(sessionId);
  }
  const state = emptyState(sessionId);
  if (Array.isArray(parsed.queue)) state.queue = parsed.queue.filter(isItem);
  if (Array.isArray(parsed.done)) state.done = parsed.done.filter(isItem);
  return state;
}

function isItem(it) {
  return it && typeof it === 'object' && typeof it.text === 'string';
}

/** Atomically persist a state object to the session's queue file. */
function write(sessionId, state) {
  ensureDir();
  const file = queuePath(sessionId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    version: 1,
    sessionId: safeSessionId(sessionId),
    queue: Array.isArray(state.queue) ? state.queue : [],
    done: Array.isArray(state.done) ? state.done : [],
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file); // atomic on POSIX
  return payload;
}

function newItem(text) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'),
    text: String(text),
    addedAt: new Date().toISOString(),
  };
}

/** Append a new task to the end of the queue. Returns the created item. */
function append(sessionId, text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return null;
  return withLock(sessionId, () => {
    const state = read(sessionId);
    const item = newItem(trimmed);
    state.queue.push(item);
    write(sessionId, state);
    return item;
  });
}

/**
 * Remove and return the head (next) item, moving it into `done`.
 * Returns the popped item, or null if the queue is empty.
 */
function popHead(sessionId) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    if (state.queue.length === 0) return null;
    const item = state.queue.shift();
    state.done.push({ ...item, doneAt: new Date().toISOString() });
    write(sessionId, state);
    return item;
  });
}

/** Remove a pending item by index (does not move it to done). Returns the removed item or null. */
function removeAt(sessionId, index) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    if (index < 0 || index >= state.queue.length) return null;
    const [removed] = state.queue.splice(index, 1);
    write(sessionId, state);
    return removed;
  });
}

/** Move a pending item from one index to another. Returns the updated queue or null on bad index. */
function reorder(sessionId, from, to) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    const n = state.queue.length;
    if (from < 0 || from >= n || to < 0 || to >= n) return null;
    const [moved] = state.queue.splice(from, 1);
    state.queue.splice(to, 0, moved);
    write(sessionId, state);
    return state.queue;
  });
}

/** Clear everything (pending + done) for a session. */
function clear(sessionId) {
  return withLock(sessionId, () => write(sessionId, emptyState(sessionId)));
}

module.exports = {
  queueDir,
  safeSessionId,
  queuePath,
  read,
  write,
  append,
  popHead,
  removeAt,
  reorder,
  clear,
};
