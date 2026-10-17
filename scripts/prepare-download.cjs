// Prepare GitHub's source ZIP delivery without storing a single blob over 50 MiB.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');

async function main() {
  const root = path.resolve(__dirname, '..');
  const input = path.join(root, 'dist', `Pagefolio-${version}-Windows-x64.zip`);
  const target = path.join(root, 'windows-package');
  const cache = path.join(root, '.cache');
  await fs.mkdir(cache, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cache, 'download-'));
  const hash = createHash('sha256');
  const parts = [];
  try {
    for await (const data of createReadStream(input, { highWaterMark: 40 * 1024 * 1024 })) {
      if (!parts.length && data.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('The Windows build is not a ZIP archive.');
      const name = `Pagefolio.zip.part${String(parts.length + 1).padStart(3, '0')}`;
      hash.update(data);
      await fs.writeFile(path.join(staging, name), data);
      parts.push({ name, size: data.length });
    }
    if (!parts.length) throw new Error('The Windows ZIP is empty.');
    const manifest = { version, sha256: hash.digest('hex'), parts };
    await fs.mkdir(target, { recursive: true });
    for (const part of parts) await fs.copyFile(path.join(staging, part.name), path.join(target, part.name));
    for (const name of await fs.readdir(target)) {
      if (/^Pagefolio\.zip\.part\d+$/.test(name) && !parts.some(part => part.name === name)) await fs.rm(path.join(target, name));
    }
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Prepared Pagefolio ${version}: ${parts.length} parts; SHA-256 ${manifest.sha256}`);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
