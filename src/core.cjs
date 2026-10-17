const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const PDFDocument = require('pdfkit');

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
  const delay = Number(input.delay ?? 500);
  const overlap = Number(input.overlap ?? 10);
  if (!Number.isFinite(delay) || delay < 500 || delay > 60000) throw new Error('待ち時間は0.5〜60秒です。');
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > 40) throw new Error('重なりは0〜40%です。');
  if (input.mode === 'key' && !['Right', 'Left', 'PageDown', 'Space'].includes(input.key)) throw new Error('利用できないキーです。');
  const nextSelector = String(input.nextSelector || '').trim();
  if (nextSelector.length > 500) throw new Error('次へボタンの指定が長すぎます。');
  return { mode: input.mode, delay, overlap, key: input.key || 'Right', nextSelector };
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
  let previousHash, previousMarker;
  const recent = [];
  let reason = 'unchanged';
  let error;
  try {
    await driver.settle(options.delay, signal);
    while (!signal.aborted) {
      let probe = await driver.inspect?.(options) || {};
      let frame = await driver.capture();
      let hash = createHash('sha256').update(frame.bytes).digest('hex');
      const unchanged = () => previousHash && ((probe.reliable && probe.marker === previousMarker) || (hash === previousHash && (probe.marker === undefined || probe.marker === previousMarker)));
      // Retry without advancing: a slow render must not cause another page to be skipped.
      for (let retry = 0; unchanged() && retry < 3 && !signal.aborted; retry++) {
        await driver.settle(options.delay, signal);
        probe = await driver.inspect?.(options) || {};
        frame = await driver.capture();
        hash = createHash('sha256').update(frame.bytes).digest('hex');
      }
      if (signal.aborted) break;
      if (unchanged()) { reason = probe.atEnd ? 'end' : 'unchanged'; break; }
      const signature = `${hash}|${probe.marker ?? ''}`;
      if (!probe.reliable && recent.includes(signature)) { reason = 'cycle'; break; }
      const filename = path.join(directory, `${String(frames.length + 1).padStart(4, '0')}.jpg`);
      await fs.writeFile(filename, frame.bytes);
      frames.push({ filename, width: frame.width, height: frame.height });
      previousHash = hash;
      previousMarker = probe.marker;
      recent.push(signature);
      if (recent.length > 12) recent.shift();
      onProgress(frames.length);
      if (signal.aborted) break;
      // A disabled next control is explicit; scroll bottoms are retried for lazy loading.
      if (probe.explicitEnd) { reason = 'end'; break; }
      const advanced = await driver.advance(options);
      if (advanced === false) { reason = 'end'; break; }
      await driver.settle(options.delay, signal);
    }
  } catch (e) { error = e; reason = 'error'; }
  if (signal.aborted) reason = 'stopped';
  return { frames, reason, error };
}

async function writePdf(frames, output, title) {
  if (!frames.length) throw new Error('保存できる画面がありません。');
  const temp = `${output}.${randomUUID()}.tmp`;
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: false, info: { Title: title || 'Pagefolio capture', Creator: 'Pagefolio' } });
  const completion = pipeline(doc, createWriteStream(temp, { flags: 'wx' }));
  completion.catch(() => {});
  try {
    for (const frame of frames) {
      if (doc.destroyed) { await completion; throw new Error('PDFの書き込みが中断されました。'); }
      const width = frame.width * 0.75, height = frame.height * 0.75;
      doc.addPage({ size: [width, height], margin: 0 });
      doc.image(await fs.readFile(frame.filename), 0, 0, { width, height });
      // PDFKit pushes into a readable stream; respect slow disks instead of buffering the whole book.
      while (doc.readableLength > 16 * 1024 * 1024 && !doc.destroyed) await wait(10);
    }
    doc.end();
    await completion;
    await fs.rename(temp, output);
  } finally { doc.destroy(); await completion.catch(() => {}); await fs.rm(temp, { force: true }); }
}

module.exports = { normalizeUrl, validateOptions, wait, collectFrames, writePdf };
