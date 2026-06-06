#!/usr/bin/env node
'use strict';

/**
 * stop-hook.js — Claude Code `Stop` hook.
 *
 * Fires when Claude finishes a turn. Reads the hook payload from stdin, then
 * advances the session's queue: the task Claude just finished (the `active`
 * item) moves to done, and if a pending task exists it becomes active and is
 * fed back to Claude by emitting:
 *
 *   { "decision": "block", "reason": "Next queued task:\n<text>" }
 *
 * The `block` decision prevents the session from going idle and feeds `reason`
 * to Claude as its next instruction.
 *
 * When the queue is empty the behavior depends on the queue window:
 *   - window closed (no live ui-<session>.pid) → exit 0, session idles, same
 *     as before;
 *   - window open → WAIT, polling the queue file, so a task typed into the
 *     window while the session would otherwise sit idle is picked up at once.
 *     The wait ends when an item arrives (block), the window closes (idle),
 *     a signal arrives (the user submitted a message / interrupted — idle),
 *     or MAX_WAIT_MS passes (idle). hooks.json gives this hook a timeout
 *     larger than MAX_WAIT_MS so the exit is always ours, never a kill.
 *
 * Safety: each block consumes exactly one queued item, so feeding can never
 * loop on its own — it only continues while the user keeps adding tasks. Any
 * malformed input or unexpected error exits 0 silently so a bad state can
 * never wedge the session.
 */

const store = require('./lib/queue-store');

// How long to wait for new tasks while the queue window is open. Just under
// the 24h hooks.json timeout so this process always exits on its own terms.
// CQ_MAX_WAIT_MS overrides for tests.
const MAX_WAIT_MS = Number(process.env.CQ_MAX_WAIT_MS) > 0
  ? Number(process.env.CQ_MAX_WAIT_MS)
  : 24 * 60 * 60 * 1000 - 30 * 1000;
const POLL_MS = 400;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    if (process.stdin.isTTY) {
      finish();
      return;
    }
    // Safety valve: never let a caller that holds stdin open hang the turn.
    const timer = setTimeout(finish, 3000);
    if (timer.unref) timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function emitBlock(item) {
  const out = {
    decision: 'block',
    reason: `Next queued task:\n${item.text}`,
  };
  process.stdout.write(JSON.stringify(out));
}

// NOT unref'd on purpose: while waiting, this timer is the only thing keeping
// the process alive — an unref'd timer would let node exit mid-wait.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const raw = await readStdin();

  let payload = {};
  try {
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (_err) {
    // Unparseable hook input — do nothing, let Claude stop.
    process.exit(0);
  }

  const sessionId = payload.session_id || payload.sessionId || 'default';

  // Finish whatever was active and start the next task if one is pending
  // (advance respects `paused`: it finishes but starts nothing while paused).
  let item;
  try {
    item = store.advance(sessionId);
  } catch (_err) {
    // Never block the session on a queue error.
    process.exit(0);
  }

  if (item) {
    emitBlock(item);
    process.exit(0);
  }

  // Nothing to start. If the queue window is closed, idle as before.
  let ui;
  try {
    ui = store.readUiPid(sessionId);
  } catch (_err) {
    process.exit(0);
  }
  if (!ui || !ui.alive) {
    process.exit(0);
  }

  // The window is open — wait for the next task instead of idling, so items
  // added now are picked up immediately. A signal means the user took over
  // (submitted a message, or interrupted): get out of the way silently.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    await delay(POLL_MS);
    try {
      ui = store.readUiPid(sessionId);
      if (!ui || !ui.alive) process.exit(0); // window closed → idle

      // Cheap read gate so polling doesn't take the lock or touch the file's
      // mtime every tick; advance() only when there is something to start.
      const state = store.read(sessionId);
      if (state.paused || state.queue.length === 0) continue;
      const next = store.advance(sessionId);
      if (next) {
        emitBlock(next);
        process.exit(0);
      }
    } catch (_err) {
      process.exit(0);
    }
  }
  process.exit(0);
}

main();
