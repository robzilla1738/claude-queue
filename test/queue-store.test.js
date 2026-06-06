'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
