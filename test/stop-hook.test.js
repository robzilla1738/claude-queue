'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'stop-hook.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-hook-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the hook with the given stdin payload, returning { stdout }. */
function runHook(payload) {
  const stdout = execFileSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_QUEUE_DIR: tmpDir },
    encoding: 'utf8',
  });
  return stdout;
}

function seed(sessionId, texts) {
  delete require.cache[require.resolve('../scripts/lib/queue-store')];
  process.env.CLAUDE_QUEUE_DIR = tmpDir;
  const store = require('../scripts/lib/queue-store');
  texts.forEach((t) => store.append(sessionId, t));
  delete process.env.CLAUDE_QUEUE_DIR;
  return store;
}

test('empty queue → hook emits nothing (session idles)', () => {
  const out = runHook({ session_id: 's1', hook_event_name: 'Stop' });
  assert.strictEqual(out.trim(), '');
});

test('non-empty queue → hook blocks and injects the head task', () => {
  seed('s1', ['do the first thing', 'do the second thing']);

  const out = runHook({ session_id: 's1', hook_event_name: 'Stop' });
  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /Next queued task:/);
  assert.match(decision.reason, /do the first thing/);
});

test('repeated Stops drain the queue FIFO, then idle', () => {
  seed('s1', ['one', 'two']);

  let out = runHook({ session_id: 's1' });
  assert.match(JSON.parse(out).reason, /one/);

  out = runHook({ session_id: 's1' });
  assert.match(JSON.parse(out).reason, /two/);

  out = runHook({ session_id: 's1' });
  assert.strictEqual(out.trim(), '', 'queue drained → no further blocking');
});

test('the consumed item is recorded under done', () => {
  const store = seed('s1', ['only task']);
  runHook({ session_id: 's1' });
  process.env.CLAUDE_QUEUE_DIR = tmpDir;
  const state = store.read('s1');
  delete process.env.CLAUDE_QUEUE_DIR;
  assert.strictEqual(state.queue.length, 0);
  assert.strictEqual(state.done.length, 1);
  assert.strictEqual(state.done[0].text, 'only task');
});

test('malformed stdin does not block the session', () => {
  const out = runHook('{ this is : not json');
  assert.strictEqual(out.trim(), '');
});

test('missing session_id falls back to the default queue', () => {
  seed('default', ['fallback task']);
  const out = runHook({ hook_event_name: 'Stop' });
  assert.match(JSON.parse(out).reason, /fallback task/);
});
