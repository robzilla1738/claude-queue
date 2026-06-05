#!/usr/bin/env node
'use strict';

/**
 * stop-hook.js — Claude Code `Stop` hook.
 *
 * Fires when Claude finishes a turn. Reads the hook payload from stdin, looks
 * up the session's queue, and if there's a pending task, pops the head and asks
 * Claude to keep going by emitting:
 *
 *   { "decision": "block", "reason": "Next queued task:\n<text>" }
 *
 * The `block` decision prevents the session from going idle and feeds `reason`
 * to Claude as its next instruction. When the queue is empty we print nothing
 * and exit 0, so the session idles normally.
 *
 * Safety: the queue strictly shrinks (one pop per Stop), so this can never loop
 * forever. Any malformed input or unexpected error exits 0 silently so a bad
 * state can never wedge the session.
 */

const store = require('./lib/queue-store');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
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

  let item;
  try {
    item = store.popHead(sessionId);
  } catch (_err) {
    // Never block the session on a queue error.
    process.exit(0);
  }

  if (!item) {
    // Empty queue → allow the session to go idle.
    process.exit(0);
  }

  const out = {
    decision: 'block',
    reason: `Next queued task:\n${item.text}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main();
