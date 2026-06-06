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
 *     "version": 2,
 *     "sessionId": "<id>",
 *     "queue": [ { "id", "text", "addedAt" }, ... ],   // pending, head = next
 *     "active": { "id", "text", "addedAt" } | null,    // what Claude is working on now
 *     "done":  [ { "id", "text", "addedAt", "doneAt" }, ... ],  // finished (capped)
 *     "paused": false                                  // true = don't start new tasks
 *   }
 *
 * Version 1 files (no `active`/`paused`) read back with active:null,
 * paused:false — no migration step needed.
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

// `done` is a small visual history, not a log — cap it so the file (and the
// UI's done tail source) can't grow without bound across a long session.
const DONE_CAP = 50;

function emptyState(sessionId) {
  return {
    version: 2,
    sessionId: safeSessionId(sessionId),
    queue: [],
    active: null,
    done: [],
    paused: false,
  };
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
  if (isItem(parsed.active)) state.active = parsed.active;
  state.paused = parsed.paused === true;
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
    version: 2,
    sessionId: safeSessionId(sessionId),
    queue: Array.isArray(state.queue) ? state.queue : [],
    active: isItem(state.active) ? state.active : null,
    done: (Array.isArray(state.done) ? state.done : []).slice(-DONE_CAP),
    paused: state.paused === true,
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

/**
 * Advance the queue one step, atomically: the previously `active` item (if
 * any) is finished — moved into `done` — and, unless the queue is paused, the
 * head of `queue` becomes the new `active` item. Returns the new active item,
 * or null when there is nothing to start (empty queue, or paused).
 *
 * This is the Stop hook's entry point: one call per turn end keeps `active`
 * exactly in sync with what Claude is working on, so a crash mid-task leaves
 * the task visibly active rather than falsely done. The write is skipped when
 * nothing changed, so a polling caller doesn't churn the file's mtime (which
 * would make the UI re-render on every poll tick).
 */
function advance(sessionId) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    let changed = false;
    if (state.active) {
      state.done.push({ ...state.active, doneAt: new Date().toISOString() });
      state.active = null;
      changed = true;
    }
    if (!state.paused && state.queue.length > 0) {
      state.active = state.queue.shift();
      changed = true;
    }
    if (changed) write(sessionId, state);
    return state.active;
  });
}

/** Set the paused flag. While paused, advance() finishes the active item but starts nothing new. */
function setPaused(sessionId, paused) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    state.paused = paused === true;
    write(sessionId, state);
    return state.paused;
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

/**
 * Replace the text of the pending item with the given id. The id (not an
 * index) identifies the item, so a concurrent mutation (e.g. the Stop hook
 * popping the head mid-edit) can never retarget the edit. Returns the updated
 * item, or null when the text is blank or no pending item has that id (an
 * already-consumed item is not editable — Claude is working on it).
 */
function updateTextById(sessionId, id, text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return null;
  return withLock(sessionId, () => {
    const state = read(sessionId);
    const item = state.queue.find((it) => it.id === id);
    if (!item) return null;
    item.text = trimmed;
    write(sessionId, state);
    return item;
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

/**
 * Move the pending item with the given id to index `to` (clamped). The id is
 * resolved to an index under the lock, so a concurrent mutation (e.g. the Stop
 * hook popping the head mid-drag) can never make this move the wrong item.
 * Returns the updated queue, or null if no pending item has that id.
 */
function reorderById(sessionId, id, to) {
  return withLock(sessionId, () => {
    const state = read(sessionId);
    const from = state.queue.findIndex((it) => it.id === id);
    if (from === -1) return null;
    const clamped = Math.max(0, Math.min(state.queue.length - 1, to));
    if (from !== clamped) {
      const [moved] = state.queue.splice(from, 1);
      state.queue.splice(clamped, 0, moved);
      write(sessionId, state);
    }
    return state.queue;
  });
}

/** Clear everything (pending + done) for a session. */
function clear(sessionId) {
  return withLock(sessionId, () => write(sessionId, emptyState(sessionId)));
}

// ---------------------------------------------------------------------------
// UI pid file — single source of truth for "is the queue window open?".
//
// The UI claims `ui-<session>.pid` (O_EXCL) on startup and removes it on exit.
// Two consumers depend on it:
//   - a second UI for the same session sees the claim fail and exits at once,
//     so a duplicate window (whatever spawned it) self-closes;
//   - the Stop hook reads it to decide whether to wait for new tasks (window
//     open) or let the session go idle (window closed).
// ---------------------------------------------------------------------------

/** Absolute path to the UI pid file for a given session. */
function uiPidPath(sessionId) {
  return path.join(queueDir(), `ui-${safeSessionId(sessionId)}.pid`);
}

/** True when `pid` is a live process. EPERM means alive-but-not-ours. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Try to claim the UI pid file for this process. Returns true when this
 * process now owns it, false when a live UI already holds it. A pid file left
 * by a dead process is stolen. Bounded retries keep a racing steal from
 * looping forever — whichever O_EXCL create wins owns the file.
 */
function claimUiPid(sessionId) {
  ensureDir();
  const file = uiPidPath(sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      let holder = NaN;
      try {
        holder = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      } catch (_e) {
        continue; // vanished between open and read — retry the claim
      }
      if (isPidAlive(holder)) return false;
      try { fs.unlinkSync(file); } catch (_e) {} // stale — steal and retry
    }
  }
  return false;
}

/** Release the pid file, but only if this process is the one that owns it. */
function releaseUiPid(sessionId) {
  const file = uiPidPath(sessionId);
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(file);
    }
  } catch (_e) {}
}

/** Read the UI pid file. Returns { pid, alive } or null when absent/unreadable. */
function readUiPid(sessionId) {
  try {
    const pid = parseInt(fs.readFileSync(uiPidPath(sessionId), 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, alive: isPidAlive(pid) };
  } catch (_e) {
    return null;
  }
}

module.exports = {
  queueDir,
  safeSessionId,
  queuePath,
  read,
  write,
  append,
  popHead,
  advance,
  setPaused,
  removeAt,
  updateTextById,
  reorder,
  reorderById,
  clear,
  uiPidPath,
  claimUiPid,
  releaseUiPid,
  readUiPid,
};
