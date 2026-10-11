const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeUrl, validateOptions, collectFrames, wait } = require('../src/core.cjs');

const options = { mode: 'scroll', maxPages: 10, delay: 500, overlap: 10, key: 'Right' };
async function run(t, screenshots, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pagefolio-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let captures = 0, advances = 0;
  const controller = new AbortController();
  const driver = {
    settle: async () => {},
    capture: async () => ({ bytes: Buffer.from(screenshots[Math.min(captures++, screenshots.length - 1)]), width: 100, height: 200 }),
    advance: async () => { advances++; }
  };
  Object.assign(driver, overrides.driver);
  const result = await collectFrames({ driver, options: { ...options, ...overrides.options }, directory, signal: controller.signal,
    onProgress: count => overrides.onProgress?.(count, controller) });
  return { ...result, captures, advances };
}

test('accepts normal web URLs and rejects dangerous protocols or embedded credentials', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('https://read.amazon.co.jp/?asin=B09PY2DW15'), 'https://read.amazon.co.jp/?asin=B09PY2DW15');
  for (const input of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,a', 'https://user:pass@example.com', '']) assert.throws(() => normalizeUrl(input));
});

test('enforces bounded capture settings', () => {
  assert.deepEqual(validateOptions(options), options);
  for (const invalid of [{ maxPages: 0 }, { maxPages: 501 }, { maxPages: 1.5 }, { delay: 0 }, { delay: Infinity }, { overlap: -1 }, { mode: 'other' }, { mode: 'key', key: 'F12' }]) {
    assert.throws(() => validateOptions({ ...options, ...invalid }));
  }
});

test('writes unique frames in order and stops at an unchanged screen', async t => {
  const result = await run(t, ['page 1', 'page 2', 'page 2']);
  assert.equal(result.reason, 'unchanged');
  assert.equal(result.frames.length, 2);
  assert.equal(result.captures, 4);
  assert.deepEqual(await Promise.all(result.frames.map(f => fs.readFile(f.filename, 'utf8'))), ['page 1', 'page 2']);
});

test('waits again for delayed rendering without an extra page turn', async t => {
  const result = await run(t, ['first', 'first', 'second'], { options: { maxPages: 2 } });
  assert.equal(result.reason, 'limit');
  assert.equal(result.frames.length, 2);
  assert.equal(result.advances, 1);
});

test('page limit does not advance beyond the final requested frame', async t => {
  const result = await run(t, ['1', '2', '3'], { options: { maxPages: 2 } });
  assert.equal(result.frames.length, 2);
  assert.equal(result.advances, 1);
  assert.equal(result.reason, 'limit');
});

test('stopping preserves captured pages', async t => {
  const result = await run(t, ['first', 'second'], { onProgress: (_, controller) => controller.abort() });
  assert.equal(result.reason, 'stopped');
  assert.equal(result.frames.length, 1);
  assert.equal(result.advances, 0);
});

test('a browser failure keeps previously captured pages for partial export', async t => {
  const result = await run(t, ['first'], { driver: { advance: async () => { throw new Error('Browser failed'); } } });
  assert.equal(result.reason, 'error');
  assert.equal(result.error.message, 'Browser failed');
  assert.equal(result.frames.length, 1);
});

test('cancellation interrupts a long wait promptly', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const waiting = wait(10000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - start < 1000);
});
