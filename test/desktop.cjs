const { app, dialog } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { boot, getState, getJob } = require('../src/main.cjs');

const outputRoot = path.resolve('test-results');
app.setPath('userData', path.join(outputRoot, 'electron-data'));
app.commandLine.appendSwitch('disable-gpu');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>Pagefolio Test Book</title><style>
    *{box-sizing:border-box}html,body{margin:0;font-family:sans-serif;scroll-behavior:auto}body{background:#faf9ef;color:#203a30}
    section{height:100vh;padding:80px;font-size:22px}h1{font-size:48px}button{position:fixed;right:30px;bottom:30px;padding:15px 25px;background:#176b54;color:white;border:0;border-radius:7px}
    </style></head><body>${req.url === '/scroll' ? [1,2,3].map(n => `<section style="background:${['#f8ead3','#dce9e2','#e1e8f2'][n-1]}"><h1>Chapter ${n}</h1><p>A page worth keeping.</p><p>スクロールの動作を検証するサンプル ${n}</p></section>`).join('') : `<section><h1 id="title">Chapter 1</h1><p>Turn the page to collect the next chapter.</p><p>クリック・キー操作のサンプルページ</p></section><button id="next">Next chapter →</button><script>let page=1;const next=()=>{if(page<3)document.getElementById('title').textContent='Chapter '+(++page)};document.getElementById('next').onclick=next;document.addEventListener('keydown',e=>{if(e.key==='ArrowRight')next()});</script>`}</body></html>`);
});

async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}; ${JSON.stringify(getState())}`);
}

async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { window, browser } = await boot();
  const ui = source => window.webContents.executeJavaScript(source, true);
  const url = `http://127.0.0.1:${server.address().port}`;
  await until(() => ui('Boolean(window.pagefolio)'), 'preload');
  await fs.writeFile(path.join(outputRoot, 'desktop-home.png'), (await window.webContents.capturePage()).toPNG());

  const open = async route => {
    const result = await ui(`window.pagefolio.open(${JSON.stringify(url + route)})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(() => !getState().loading, 'load');
  };
  const run = async (name, mode, maxPages = 10) => {
    const output = path.join(outputRoot, `${name}.pdf`);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    const result = await ui(`window.pagefolio.start(${JSON.stringify({ mode, maxPages, delay: 500, overlap: 0, key: 'Right' })})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(() => !['choosing', 'recording', 'saving'].includes(getState().phase), name);
    await getJob();
    assert.equal(getState().phase, 'done', JSON.stringify(getState()));
    const pdf = await PDFDocument.load(await fs.readFile(output));
    return pdf;
  };

  await open('/scroll');
  assert.equal(await browser.webContents.executeJavaScript('typeof process'), 'undefined');
  assert.equal(await browser.webContents.executeJavaScript('typeof window.pagefolio'), 'undefined');
  console.log('PASS: site renderer is isolated from Node and app IPC');
  let pdf = await run('scroll', 'scroll');
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(getState().reason, 'unchanged');
  console.log('PASS: native scrolling, bottom detection, 3-page PDF');

  await open('/click');
  // Position picking goes through the actual sandboxed UI bridge and a real mouse click.
  const picking = ui('window.pagefolio.pick()');
  await until(() => getState().phase === 'picking', 'picker');
  await new Promise(resolve => setTimeout(resolve, 200));
  const rect = await browser.webContents.executeJavaScript('(()=>{const r=document.getElementById("next").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  browser.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  browser.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
  assert.equal((await picking).ok, true);
  assert.equal(getState().picked, true);
  assert.equal(await browser.webContents.executeJavaScript('document.getElementById("title").textContent'), 'Chapter 1');
  pdf = await run('click', 'click');
  assert.equal(pdf.getPageCount(), 3);
  console.log('PASS: click-position selection, pagination, 3-page PDF');

  await open('/key');
  pdf = await run('keyboard', 'key');
  assert.equal(pdf.getPageCount(), 3);
  console.log('PASS: keyboard page turn, 3-page PDF');

  await open('/key');
  pdf = await run('limited', 'key', 2);
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(getState().reason, 'limit');
  console.log('PASS: requested page limit');

  await open('/scroll');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(outputRoot, 'stopped.pdf') });
  await ui('window.pagefolio.start({mode:"scroll",maxPages:100,delay:5000,overlap:0,key:"Right"})');
  await until(() => getState().count === 1, 'first frame');
  await ui('window.pagefolio.stop()');
  await getJob();
  assert.equal(getState().reason, 'stopped');
  pdf = await PDFDocument.load(await fs.readFile(path.join(outputRoot, 'stopped.pdf')));
  assert.equal(pdf.getPageCount(), 1);
  console.log('PASS: stop cancels wait and saves partial PDF');

  dialog.showSaveDialog = async () => ({ canceled: true });
  await ui('window.pagefolio.start({mode:"scroll",maxPages:10,delay:500,overlap:0,key:"Right"})');
  assert.equal(getState().phase, 'idle');
  console.log('PASS: save dialog cancellation');

  const earlyOutput = path.join(outputRoot, 'stopped-before-first.pdf');
  await fs.rm(earlyOutput, { force: true });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: earlyOutput });
  await ui('window.pagefolio.start({mode:"scroll",maxPages:10,delay:5000,overlap:0,key:"Right"})');
  await ui('window.pagefolio.stop()');
  await getJob();
  assert.equal(getState().phase, 'idle');
  await assert.rejects(fs.access(earlyOutput), { code: 'ENOENT' });
  console.log('PASS: stop before first frame creates no empty PDF');

  const blocked = await ui('window.pagefolio.open("file:///etc/passwd")');
  assert.equal(blocked.ok, false);
  assert.equal(new URL(getState().url).protocol, 'http:');
  console.log('PASS: app bridge rejects non-web navigation');

  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(outputRoot, 'missing-directory', 'failed.pdf') });
  await ui('window.pagefolio.start({mode:"scroll",maxPages:1,delay:500,overlap:0,key:"Right"})');
  await getJob();
  assert.equal(getState().phase, 'error');
  const captureRoot = path.join(app.getPath('userData'), 'captures');
  const remaining = await fs.readdir(captureRoot);
  assert.ok(remaining.length > 0);
  const retained = getState().message.split('取得済み画像の保管先: ')[1];
  assert.ok((await fs.stat(path.join(retained, '0001.jpg'))).size > 0);
  console.log('PASS: PDF write failure preserves recovery images');
  await until(() => ui('document.getElementById("status-text").textContent === "保存を完了できませんでした"'), 'UI error status');
  await fs.writeFile(path.join(outputRoot, 'desktop-browser.png'), (await window.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(outputRoot, 'captured-page.png'), (await browser.webContents.capturePage()).toPNG());
  window.close();
}

const watchdog = setTimeout(() => { console.error('Desktop test timed out'); app.exit(1); }, 90000);
main().then(() => { clearTimeout(watchdog); server.close(); app.exit(0); }).catch(error => { clearTimeout(watchdog); console.error(error); server.close(); app.exit(1); });
