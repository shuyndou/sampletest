const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeUrl } = require('./core.cjs');

function safeFilename(title) {
  let name = String(title || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[.\s]+$/g, '').trim();
  name = [...name].slice(0, 90).join('').replace(/[.\s]+$/g, '') || 'Untitled';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function parseUrlList(text) {
  const seen = new Set();
  return String(text || '').split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    // Optional: title<TAB>URL. Bare URLs use the loaded document title later.
    const parts = line.split('\t');
    let url;
    try { url = normalizeUrl(parts.at(-1)); } catch { throw new Error(`${i + 1}行目のURLを確認してください。`); }
    const title = parts.length > 1 ? parts.slice(0, -1).join(' ').trim() : '';
    return { id: randomUUID(), url, title, source: 'web', status: 'pending' };
  }).filter(item => { if (seen.has(item.url)) return false; seen.add(item.url); return true; });
}

async function reserveOutput(directory, title) {
  const stem = safeFilename(title);
  for (let n = 1; ; n++) {
    const filename = path.join(directory, `${stem}${n === 1 ? '' : ` (${n})`}.pdf`);
    try {
      const handle = await fs.open(filename, 'wx');
      await handle.close();
      return filename;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

module.exports = { safeFilename, parseUrlList, reserveOutput };
