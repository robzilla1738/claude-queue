'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-store-'));
  process.env.CLAUDE_QUEUE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CLAUDE_QUEUE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshStore() {
  // Re-require fresh each test so there is no cross-test state.
  delete require.cache[require.resolve('../scripts/lib/queue-store')];
  return require('../scripts/lib/queue-store');
}

test('read() returns an empty state when no file exists', () => {
  const store = freshStore();
  const state = store.read('s1');
  assert.deepStrictEqual(state.queue, []);
  assert.deepStrictEqual(state.done, []);
});

test('append() adds items in order and persists them', () => {
  const store = freshStore();
  store.append('s1', 'first');
  store.append('s1', 'second');
  const state = store.read('s1');
  assert.strictEqual(state.queue.length, 2);
  assert.strictEqual(state.queue[0].text, 'first');
  assert.strictEqual(state.queue[1].text, 'second');
  assert.ok(state.queue[0].id, 'item has an id');
  assert.ok(state.queue[0].addedAt, 'item has a timestamp');
});

test('append() ignores blank / whitespace-only input', () => {
  const store = freshStore();
  assert.strictEqual(store.append('s1', '   '), null);
  assert.strictEqual(store.append('s1', ''), null);
  assert.strictEqual(store.read('s1').queue.length, 0);
});

test('popHead() returns items FIFO and moves them to done', () => {
  const store = freshStore();
  store.append('s1', 'a');
  store.append('s1', 'b');

  const first = store.popHead('s1');
  assert.strictEqual(first.text, 'a');

  let state = store.read('s1');
  assert.strictEqual(state.queue.length, 1);
  assert.strictEqual(state.queue[0].text, 'b');
  assert.strictEqual(state.done.length, 1);
  assert.strictEqual(state.done[0].text, 'a');
  assert.ok(state.done[0].doneAt, 'done item is timestamped');

  const second = store.popHead('s1');
  assert.strictEqual(second.text, 'b');
  assert.strictEqual(store.popHead('s1'), null, 'empty queue returns null');

  state = store.read('s1');
  assert.strictEqual(state.queue.length, 0);
  assert.strictEqual(state.done.length, 2);
});

test('removeAt() drops a pending item without moving it to done', () => {
  const store = freshStore();
  store.append('s1', 'a');
  store.append('s1', 'b');
  store.append('s1', 'c');

  const removed = store.removeAt('s1', 1);
  assert.strictEqual(removed.text, 'b');

  const state = store.read('s1');
  assert.deepStrictEqual(state.queue.map((i) => i.text), ['a', 'c']);
  assert.strictEqual(state.done.length, 0);
  assert.strictEqual(store.removeAt('s1', 99), null, 'out-of-range returns null');
});

test('reorder() moves an item between positions', () => {
  const store = freshStore();
  ['a', 'b', 'c'].forEach((t) => store.append('s1', t));

  store.reorder('s1', 0, 2); // move 'a' to the end
  assert.deepStrictEqual(store.read('s1').queue.map((i) => i.text), ['b', 'c', 'a']);

  assert.strictEqual(store.reorder('s1', 0, 9), null, 'bad index returns null');
});

test('reorderById() moves the item with that id, clamps, and rejects unknown ids', () => {
  const store = freshStore();
  ['a', 'b', 'c'].forEach((t) => store.append('s1', t));
  const idOfA = store.read('s1').queue[0].id;

  store.reorderById('s1', idOfA, 2); // drag 'a' to the end
  assert.deepStrictEqual(store.read('s1').queue.map((i) => i.text), ['b', 'c', 'a']);

  store.reorderById('s1', idOfA, 99); // out-of-range clamps to the last slot
  assert.deepStrictEqual(store.read('s1').queue.map((i) => i.text), ['b', 'c', 'a']);

  // An id that is no longer pending (e.g. popped mid-drag) moves nothing.
  assert.strictEqual(store.reorderById('s1', 'no-such-id', 0), null);
  assert.deepStrictEqual(store.read('s1').queue.map((i) => i.text), ['b', 'c', 'a']);
});

test('updateTextById() rewrites the pending item in place, trimming the text', () => {
  const store = freshStore();
  ['a', 'b', 'c'].forEach((t) => store.append('s1', t));
  const idOfB = store.read('s1').queue[1].id;

  const updated = store.updateTextById('s1', idOfB, '  b, revised  ');
  assert.strictEqual(updated.text, 'b, revised');

  const state = store.read('s1');
  assert.deepStrictEqual(state.queue.map((i) => i.text), ['a', 'b, revised', 'c']);
  assert.strictEqual(state.queue[1].id, idOfB, 'identity and position survive an edit');
});

test('updateTextById() rejects blank text, unknown ids, and consumed items', () => {
  const store = freshStore();
  store.append('s1', 'a');
  const id = store.read('s1').queue[0].id;

  assert.strictEqual(store.updateTextById('s1', id, '   '), null);
  assert.strictEqual(store.read('s1').queue[0].text, 'a', 'blank edit changes nothing');
  assert.strictEqual(store.updateTextById('s1', 'no-such-id', 'x'), null);

  store.popHead('s1'); // consumed mid-edit — no longer editable
  assert.strictEqual(store.updateTextById('s1', id, 'x'), null);
  assert.strictEqual(store.read('s1').done[0].text, 'a', 'done history is untouched');
});

test('sessions are isolated from one another', () => {
  const store = freshStore();
  store.append('alpha', 'a-task');
  store.append('beta', 'b-task');
  assert.strictEqual(store.read('alpha').queue.length, 1);
  assert.strictEqual(store.read('beta').queue.length, 1);
  assert.strictEqual(store.read('alpha').queue[0].text, 'a-task');
  assert.strictEqual(store.read('beta').queue[0].text, 'b-task');
});

test('a corrupt queue file is treated as empty, not fatal', () => {
  const store = freshStore();
  fs.writeFileSync(store.queuePath('s1'), '{not valid json');
  assert.deepStrictEqual(store.read('s1').queue, []);
  // and we can still append on top of it
  store.append('s1', 'recovered');
  assert.strictEqual(store.read('s1').queue[0].text, 'recovered');
});

test('session ids with unsafe characters map to a safe filename', () => {
  const store = freshStore();
  store.append('a/../../b id', 'x');
  const file = store.queuePath('a/../../b id');
  // The real invariant: the file is a single segment directly inside the queue
  // dir — no path separators survive sanitization, so no traversal is possible.
  assert.strictEqual(path.dirname(file), tmpDir, 'stays directly in the queue dir');
  assert.ok(!path.basename(file).includes('/'), 'no path separator in the name');
});

test('concurrent appends from many processes do not lose updates', async () => {
  const store = freshStore();
  const storePath = require.resolve('../scripts/lib/queue-store');
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve, reject) => {
        const code = `require(${JSON.stringify(storePath)}).append('cc','task-${i}')`;
        const p = spawn(process.execPath, ['-e', code], {
          env: { ...process.env, CLAUDE_QUEUE_DIR: tmpDir },
        });
        p.on('error', reject);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
      })
    )
  );
  // Without the cross-process lock, interleaved read-modify-write would drop
  // some of these; the lock guarantees all N survive.
  assert.strictEqual(store.read('cc').queue.length, N);
});

test('clear() empties both queue and done', () => {
  const store = freshStore();
  store.append('s1', 'a');
  store.popHead('s1');
  store.append('s1', 'b');
  store.clear('s1');
  const state = store.read('s1');
  assert.deepStrictEqual(state.queue, []);
  assert.deepStrictEqual(state.done, []);
});

test('advance() starts the head as active, then finishes it to done on the next call', () => {
  const store = freshStore();
  ['a', 'b'].forEach((t) => store.append('s1', t));

  const first = store.advance('s1');
  assert.strictEqual(first.text, 'a');
  let state = store.read('s1');
  assert.strictEqual(state.active.text, 'a');
  assert.deepStrictEqual(state.queue.map((i) => i.text), ['b']);
  assert.strictEqual(state.done.length, 0, 'in progress is not done');

  const second = store.advance('s1');
  assert.strictEqual(second.text, 'b');
  state = store.read('s1');
  assert.strictEqual(state.active.text, 'b');
  assert.deepStrictEqual(state.done.map((i) => i.text), ['a']);
  assert.ok(state.done[0].doneAt, 'finished item is timestamped');

  assert.strictEqual(store.advance('s1'), null, 'nothing left to start');
  state = store.read('s1');
  assert.strictEqual(state.active, null, 'the last task is flushed to done');
  assert.deepStrictEqual(state.done.map((i) => i.text), ['a', 'b']);
});

test('advance() while paused finishes the active task but starts nothing', () => {
  const store = freshStore();
  ['a', 'b'].forEach((t) => store.append('s1', t));
  store.advance('s1'); // 'a' becomes active
  store.setPaused('s1', true);

  assert.strictEqual(store.advance('s1'), null);
  const state = store.read('s1');
  assert.strictEqual(state.active, null);
  assert.deepStrictEqual(state.done.map((i) => i.text), ['a'], 'finished work still lands in done');
  assert.deepStrictEqual(state.queue.map((i) => i.text), ['b'], "'b' stays pending");

  store.setPaused('s1', false);
  assert.strictEqual(store.advance('s1').text, 'b', 'unpausing resumes from the head');
});

test('advance() with nothing to do leaves the file untouched', () => {
  const store = freshStore();
  store.append('s1', 'a');
  store.removeAt('s1', 0); // file exists; queue empty, no active
  const before = fs.statSync(store.queuePath('s1')).mtimeMs;
  assert.strictEqual(store.advance('s1'), null);
  const after = fs.statSync(store.queuePath('s1')).mtimeMs;
  assert.strictEqual(after, before, 'a no-op advance must not churn the mtime');
});

test('setPaused() persists the flag', () => {
  const store = freshStore();
  assert.strictEqual(store.setPaused('s1', true), true);
  assert.strictEqual(store.read('s1').paused, true);
  assert.strictEqual(store.setPaused('s1', false), false);
  assert.strictEqual(store.read('s1').paused, false);
});

test('a version-1 file reads back with active:null and paused:false', () => {
  const store = freshStore();
  fs.writeFileSync(
    store.queuePath('s1'),
    JSON.stringify({
      version: 1,
      sessionId: 's1',
      queue: [{ id: 'x', text: 'old task', addedAt: '2026-01-01T00:00:00.000Z' }],
      done: [],
    })
  );
  const state = store.read('s1');
  assert.strictEqual(state.active, null);
  assert.strictEqual(state.paused, false);
  assert.strictEqual(state.queue[0].text, 'old task', 'v1 contents survive');
});

test('done history is capped', () => {
  const store = freshStore();
  for (let i = 0; i < 60; i++) store.append('s1', `t${i}`);
  for (let i = 0; i <= 60; i++) store.advance('s1'); // last call flushes t59
  const state = store.read('s1');
  assert.strictEqual(state.done.length, 50);
  assert.strictEqual(state.done[49].text, 't59', 'newest kept');
  assert.strictEqual(state.done[0].text, 't10', 'oldest dropped');
});

test('UI pid file: claim, duplicate claim, steal, release', () => {
  const store = freshStore();
  assert.strictEqual(store.claimUiPid('s1'), true, 'first claim wins');
  assert.strictEqual(fs.readFileSync(store.uiPidPath('s1'), 'utf8'), String(process.pid));

  // A live holder blocks any duplicate…
  assert.strictEqual(store.claimUiPid('s1'), false);
  assert.deepStrictEqual(store.readUiPid('s1'), { pid: process.pid, alive: true });

  // …but a dead holder's file is stolen.
  const dead = spawnSync(process.execPath, ['-e', '']).pid; // exited → pid is free
  fs.writeFileSync(store.uiPidPath('s1'), String(dead));
  assert.strictEqual(store.readUiPid('s1').alive, false);
  assert.strictEqual(store.claimUiPid('s1'), true, 'stale pid file is stolen');

  store.releaseUiPid('s1');
  assert.strictEqual(store.readUiPid('s1'), null);
  assert.ok(!fs.existsSync(store.uiPidPath('s1')), 'our own claim is removed');
});

test("releaseUiPid() leaves another process's claim alone", () => {
  const store = freshStore();
  fs.writeFileSync(store.uiPidPath('s1'), String(process.pid + 1));
  store.releaseUiPid('s1');
  assert.ok(fs.existsSync(store.uiPidPath('s1')), 'not ours — left in place');
});
