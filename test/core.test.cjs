const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeUrl, validateOptions, collectFrames, wait } = require('../src/core.cjs');
const { safeFilename, parseUrlList, reserveOutput } = require('../src/batch.cjs');

const options = { mode: 'scroll', delay: 500, overlap: 10, key: 'Right', nextSelector: '' };
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

test('validates pacing and operations, with no page limit and a 500 ms default', () => {
  assert.deepEqual(validateOptions(options), options);
  assert.equal(validateOptions({ mode: 'scroll' }).delay, 500);
  assert.equal('maxPages' in validateOptions({ ...options, maxPages: 500 }), false);
  for (const invalid of [{ delay: 0 }, { delay: Infinity }, { overlap: -1 }, { mode: 'other' }, { mode: 'key', key: 'F12' }]) {
    assert.throws(() => validateOptions({ ...options, ...invalid }));
  }
});

test('writes unique frames in order and stops at an unchanged screen', async t => {
  const result = await run(t, ['page 1', 'page 2', 'page 2']);
  assert.equal(result.reason, 'unchanged');
  assert.equal(result.frames.length, 2);
  assert.equal(result.captures, 6);
  assert.deepEqual(await Promise.all(result.frames.map(f => fs.readFile(f.filename, 'utf8'))), ['page 1', 'page 2']);
});

test('waits again for delayed rendering without an extra page turn', async t => {
  const result = await run(t, ['first', 'first', 'second']);
  assert.equal(result.reason, 'unchanged');
  assert.equal(result.frames.length, 2);
  assert.equal(result.advances, 2);
});

test('continues past the former 500-page cap', async t => {
  const result = await run(t, Array.from({ length: 510 }, (_, i) => `page ${i}`));
  assert.equal(result.frames.length, 510);
  assert.equal(result.reason, 'unchanged');
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

test('a disabled next button ends after the final frame without advancing', async t => {
  const result = await run(t, ['last'], { driver: { inspect: async () => ({ explicitEnd: true }) } });
  assert.equal(result.frames.length, 1);
  assert.equal(result.advances, 0);
  assert.equal(result.reason, 'end');
});

test('stable scroll position stops at the bottom despite animated pixels', async t => {
  let count = 0;
  const result = await run(t, ['unused'], { driver: {
    capture: async () => ({ bytes: Buffer.from(`animated ${count++}`), width: 100, height: 200 }),
    inspect: async () => ({ reliable: true, marker: 'bottom', atEnd: true })
  } });
  assert.equal(result.reason, 'end');
  assert.equal(result.frames.length, 1);
});

test('navigation cycles stop instead of endlessly saving the same pages', async t => {
  const result = await run(t, ['first', 'second', 'first']);
  assert.equal(result.reason, 'cycle');
  assert.equal(result.frames.length, 2);
});

test('identical-looking pages are kept when the reader reports different positions', async t => {
  let page = 0;
  const result = await run(t, ['blank page'], { driver: {
    inspect: async () => ({ marker: `position ${page}`, explicitEnd: page === 2 }),
    advance: async () => { page++; }
  } });
  assert.equal(result.frames.length, 3);
  assert.equal(result.reason, 'end');
});

test('batch URLs are validated, deduplicated, and can carry explicit titles', () => {
  const items = parseUrlList('本の題名\thttps://example.com/a\nhttps://example.com/b\nhttps://example.com/a\n');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '本の題名');
  assert.equal(items[1].title, '');
  assert.throws(() => parseUrlList('https://example.com\nfile:///tmp/private'), /2行目/);
});

test('filenames are valid on Windows and preserve Japanese titles', () => {
  assert.equal(safeFilename('本: A/B?*'), '本_ A_B__');
  assert.equal(safeFilename('CON'), '_CON');
  assert.equal(safeFilename('LPT1.txt'), '_LPT1.txt');
  assert.equal(safeFilename('...'), 'Untitled');
  assert.ok([...safeFilename('長いタイトル'.repeat(100))].length <= 90);
});

test('batch naming never overwrites existing PDFs or identical titles', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagefolio-names-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '本.pdf'), 'existing');
  assert.equal(path.basename(await reserveOutput(dir, '本')), '本 (2).pdf');
  assert.equal(path.basename(await reserveOutput(dir, '本')), '本 (3).pdf');
  assert.equal(await fs.readFile(path.join(dir, '本.pdf'), 'utf8'), 'existing');
});
