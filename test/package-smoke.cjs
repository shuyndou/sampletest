const { app, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');

app.setPath('userData', path.resolve('test-results/package-profile'));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const archive = path.resolve('dist/win-unpacked/resources/app.asar');
  const manifest = require(path.join(archive, 'package.json'));
  assert.equal(manifest.version, require('../package.json').version);
  for (const name of await fs.readdir(path.resolve('src'))) {
    assert.deepEqual(await fs.readFile(path.join(archive, 'src', name)), await fs.readFile(path.resolve('src', name)));
  }
  const { writePdf } = require(path.join(archive, 'src/core.cjs'));
  const output = path.resolve('test-results/packaged-smoke.pdf');
  const jpeg = path.resolve('test-results/packaged-smoke.jpg');
  const image = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 });
  await fs.writeFile(jpeg, image.toJPEG(92));
  await writePdf([{ filename: jpeg, width: 64, height: 64 }], output, '配布版PDF確認');
  const pdf = await PDFDocument.load(await fs.readFile(output));
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), '配布版PDF確認');
  console.log('PASS: packaged version and source match; packaged PDF engine and font resources generate a valid PDF');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
