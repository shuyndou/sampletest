const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');

function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('URLを入力してください。');
  const text = input.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('認証情報を含まない http / https のURLを指定してください。');
  }
  return url.href;
}

function validateOptions(input) {
  if (!input || !['scroll', 'click', 'key'].includes(input.mode)) throw new Error('ページ送り方式を選んでください。');
  const maxPages = Number(input.maxPages);
  const delay = Number(input.delay);
  const overlap = Number(input.overlap);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new Error('上限枚数は1〜500枚です。');
  if (!Number.isFinite(delay) || delay < 500 || delay > 60000) throw new Error('待ち時間は0.5〜60秒です。');
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > 40) throw new Error('重なりは0〜40%です。');
  if (input.mode === 'key' && !['Right', 'Left', 'PageDown', 'Space'].includes(input.key)) throw new Error('利用できないキーです。');
  return { mode: input.mode, maxPages, delay, overlap, key: input.key || 'Right' };
}

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Only the injected driver interacts with the browser. A stopped run keeps its frames.
async function collectFrames({ driver, options, directory, signal, onProgress = () => {} }) {
  const frames = [];
  let previousHash;
  let reason = 'limit';
  let error;
  try {
    await driver.settle(options.delay, signal);
    while (!signal.aborted && frames.length < options.maxPages) {
      let frame = await driver.capture();
      let hash = createHash('sha256').update(frame.bytes).digest('hex');
      // Allow a slow page another full interval, without clicking again and skipping a page.
      if (hash === previousHash) {
        await driver.settle(options.delay, signal);
        if (signal.aborted) break;
        frame = await driver.capture();
        hash = createHash('sha256').update(frame.bytes).digest('hex');
        if (hash === previousHash) { reason = 'unchanged'; break; }
      }
      if (signal.aborted) break;
      const filename = path.join(directory, `${String(frames.length + 1).padStart(4, '0')}.jpg`);
      await fs.writeFile(filename, frame.bytes);
      frames.push({ filename, width: frame.width, height: frame.height });
      previousHash = hash;
      onProgress(frames.length);
      if (signal.aborted || frames.length >= options.maxPages) break;
      await driver.advance(options);
      await driver.settle(options.delay, signal);
    }
  } catch (e) { error = e; reason = 'error'; }
  if (signal.aborted) reason = 'stopped';
  return { frames, reason, error };
}

async function writePdf(frames, output, title) {
  if (!frames.length) throw new Error('保存できる画面がありません。');
  const doc = await PDFDocument.create();
  doc.setTitle(title || 'Pagefolio capture');
  doc.setCreator('Pagefolio');
  for (const frame of frames) {
    const jpg = await doc.embedJpg(await fs.readFile(frame.filename));
    const width = frame.width * 0.75;
    const height = frame.height * 0.75;
    doc.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
  }
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, await doc.save(), { flag: 'wx' });
    await fs.rename(temp, output);
  } finally { await fs.rm(temp, { force: true }); }
}

module.exports = { normalizeUrl, validateOptions, wait, collectFrames, writePdf };
