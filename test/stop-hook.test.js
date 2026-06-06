'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'stop-hook.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-hook-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the hook with the given stdin payload, returning { stdout }. A short
 * CQ_MAX_WAIT_MS keeps a regression in any exit condition from hanging the
 * suite for the production wait (24h).
 */
function runHook(payload) {
  const stdout = execFileSync('node', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_QUEUE_DIR: tmpDir, CQ_MAX_WAIT_MS: '3000' },
    encoding: 'utf8',
  });
  return stdout;
}

/** Spawn the hook without blocking, for the wait-while-window-open tests. */
function runHookAsync(payload, env = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, CLAUDE_QUEUE_DIR: tmpDir, CQ_MAX_WAIT_MS: '5000', ...env },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stdin.end(JSON.stringify(payload));
  return new Promise((resolve) => child.on('exit', () => resolve(stdout)));
}

function seed(sessionId, texts) {
  delete require.cache[require.resolve('../scripts/lib/queue-store')];
  process.env.CLAUDE_QUEUE_DIR = tmpDir;
  const store = require('../scripts/lib/queue-store');
  texts.forEach((t) => store.append(sessionId, t));
  delete process.env.CLAUDE_QUEUE_DIR;
  return store;
}

/** Run a store function against the temp queue dir (the env juggling in one place). */
function inStore(fn) {
  process.env.CLAUDE_QUEUE_DIR = tmpDir;
  try {
    delete require.cache[require.resolve('../scripts/lib/queue-store')];
    return fn(require('../scripts/lib/queue-store'));
  } finally {
    delete process.env.CLAUDE_QUEUE_DIR;
  }
}

/** Pretend a queue window is open: a ui pid file holding a live pid (ours). */
function openWindow(sessionId) {
  fs.writeFileSync(path.join(tmpDir, `ui-${sessionId}.pid`), String(process.pid));
}

function closeWindow(sessionId) {
  fs.rmSync(path.join(tmpDir, `ui-${sessionId}.pid`), { force: true });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('a consumed item is active during its turn, done only after the next Stop', () => {
  seed('s1', ['only task']);

  runHook({ session_id: 's1' });
  let state = inStore((s) => s.read('s1'));
  assert.strictEqual(state.queue.length, 0);
  assert.strictEqual(state.active.text, 'only task', 'in progress, not done');
  assert.strictEqual(state.done.length, 0);

  runHook({ session_id: 's1' }); // the turn after: the task actually finished
  state = inStore((s) => s.read('s1'));
  assert.strictEqual(state.active, null);
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

// ---------------------------------------------------------------------------
// Wait-while-window-open (auto-pickup)
// ---------------------------------------------------------------------------

test('empty queue with no window exits promptly, not after the max wait', () => {
  const start = Date.now();
  const out = runHook({ session_id: 's1' }); // CQ_MAX_WAIT_MS is 3000 here
  assert.strictEqual(out.trim(), '');
  assert.ok(Date.now() - start < 2000, 'must not enter the wait loop');
});

test('window open: a task added mid-wait is picked up immediately', async () => {
  openWindow('s1');
  const hook = runHookAsync({ session_id: 's1' });
  await delay(800); // hook is now waiting on the empty queue
  inStore((s) => s.append('s1', 'added while idle'));
  const out = await hook;
  const decision = JSON.parse(out);
  assert.strictEqual(decision.decision, 'block');
  assert.match(decision.reason, /added while idle/);
  const state = inStore((s) => s.read('s1'));
  assert.strictEqual(state.active.text, 'added while idle');
});

test('window closing mid-wait lets the session idle', async () => {
  openWindow('s1');
  const start = Date.now();
  const hook = runHookAsync({ session_id: 's1' }, { CQ_MAX_WAIT_MS: '10000' });
  await delay(800);
  closeWindow('s1');
  const out = await hook;
  assert.strictEqual(out.trim(), '', 'no decision — session idles');
  assert.ok(Date.now() - start < 5000, 'exited on window close, not max wait');
});

test('paused: nothing is consumed until unpaused, then pickup resumes', async () => {
  seed('s1', ['held task']);
  inStore((s) => s.setPaused('s1', true));
  openWindow('s1');

  const hook = runHookAsync({ session_id: 's1' });
  await delay(1200); // several poll ticks while paused
  let state = inStore((s) => s.read('s1'));
  assert.strictEqual(state.queue.length, 1, 'paused queue is untouched');
  assert.strictEqual(state.active, null);

  inStore((s) => s.setPaused('s1', false));
  const out = await hook;
  assert.match(JSON.parse(out).reason, /held task/, 'unpausing resumes pickup');
});

test('SIGTERM mid-wait exits silently (user took over the session)', async () => {
  openWindow('s1');
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, CLAUDE_QUEUE_DIR: tmpDir, CQ_MAX_WAIT_MS: '10000' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const exited = new Promise((r) => child.on('exit', r)); // subscribe before the kill
  child.stdin.end(JSON.stringify({ session_id: 's1' }));
  await delay(800);
  child.kill('SIGTERM');
  const code = await exited;
  assert.strictEqual(code, 0, 'clean exit');
  assert.strictEqual(stdout.trim(), '', 'no decision emitted');
});
