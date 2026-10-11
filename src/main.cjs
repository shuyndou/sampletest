const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeUrl, validateOptions, wait, collectFrames, writePdf } = require('./core.cjs');

const UI = path.join(__dirname, 'index.html');
let window, browser, controller, job, point, closeAfterSave = false;
let state = { phase: 'idle', count: 0, url: '', title: '', loading: false, picked: false, output: '', message: '', reason: '' };
const active = () => ['choosing', 'recording', 'saving', 'picking'].includes(state.phase);

function update(patch = {}) {
  state = { ...state, ...patch };
  if (window && !window.isDestroyed()) window.webContents.send('app:state', state);
}

function layout() {
  if (!window || !browser) return;
  const [width, height] = window.getContentSize();
  browser.setBounds({ x: 336, y: 88, width: Math.max(1, width - 352), height: Math.max(1, height - 128) });
}

function guardIdle() {
  if (active()) throw new Error('現在の操作が終わってから実行してください。');
}

async function openUrl(input) {
  guardIdle();
  const url = normalizeUrl(input);
  point = null;
  update({ phase: 'idle', message: '', picked: false });
  await browser.webContents.loadURL(url);
  return true;
}

async function pickPoint() {
  guardIdle();
  if (!state.url) throw new Error('先にサイトを開いてください。');
  update({ phase: 'picking', message: '右のページで「次へ」の位置をクリック。Escで取消（30秒）。' });
  try {
    const result = await browser.webContents.executeJavaScript(`new Promise(resolve => {
      const tip = document.createElement('div');
      tip.textContent = '保存時にクリックする位置を選択 · Escで取消';
      tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 20px;background:#102824;color:white;font:14px sans-serif;border-radius:8px;pointer-events:none;box-shadow:0 4px 24px #0004';
      document.documentElement.appendChild(tip);
      const finish = value => { clearTimeout(timer); window.removeEventListener('click', click, true); window.removeEventListener('keydown', key, true); tip.remove(); resolve(value); };
      const click = e => { e.preventDefault(); e.stopImmediatePropagation(); finish({ x: e.clientX / innerWidth, y: e.clientY / innerHeight }); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
      const timer = setTimeout(() => finish(null), 30000);
      window.addEventListener('click', click, true);
      window.addEventListener('keydown', key, true);
    })`, true);
    if (result && Number.isFinite(result.x) && Number.isFinite(result.y) && result.x >= 0 && result.x <= 1 && result.y >= 0 && result.y <= 1) {
      point = result;
      update({ picked: true, message: 'クリック位置を登録しました。' });
    } else update({ message: '位置の選択を取り消しました。' });
  } finally { update({ phase: 'idle' }); }
}

function driverFor(view) {
  const contents = view.webContents;
  return {
    async settle(delay, signal) {
      await wait(delay, signal);
      const deadline = Date.now() + 30000;
      while (!signal.aborted && contents.isLoading()) {
        if (Date.now() > deadline) throw new Error('読み込みが30秒以内に完了しませんでした。');
        await wait(100, signal);
      }
      if (contents.isDestroyed()) throw new Error('ページが閉じられました。');
    },
    async capture() {
      const image = await contents.capturePage();
      if (image.isEmpty()) throw new Error('このページの画面を取得できません。');
      const { width, height } = image.getSize();
      return { bytes: image.toJPEG(92), width, height };
    },
    async advance(options) {
      contents.focus();
      const bounds = view.getBounds();
      const target = options.mode === 'click' ? point : null;
      const x = Math.min(bounds.width - 1, Math.round(bounds.width * (target?.x ?? 0.5)));
      const y = Math.min(bounds.height - 1, Math.round(bounds.height * (target?.y ?? 0.5)));
      if (options.mode === 'scroll') {
        contents.sendInputEvent({ type: 'mouseMove', x, y });
        contents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -Math.round(bounds.height * (1 - options.overlap / 100)), canScroll: true });
      } else if (options.mode === 'click') {
        contents.sendInputEvent({ type: 'mouseMove', x, y });
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else {
        contents.sendInputEvent({ type: 'keyDown', keyCode: options.key });
        contents.sendInputEvent({ type: 'keyUp', keyCode: options.key });
      }
    }
  };
}

async function record(options, output) {
  controller = new AbortController();
  update({ phase: 'recording', count: 0, output: '', message: '', reason: '' });
  window.setResizable(false);
  let directory;
  try {
    const root = path.join(app.getPath('userData'), 'captures');
    await fs.mkdir(root, { recursive: true });
    directory = await fs.mkdtemp(path.join(root, 'run-'));
    await fs.writeFile(path.join(directory, 'info.json'), JSON.stringify({ created: new Date().toISOString(), output, title: state.title }));
    const result = await collectFrames({ driver: driverFor(browser), options, directory, signal: controller.signal,
      onProgress: count => update({ count }) });
    if (!result.frames.length) {
      if (result.error) throw result.error;
      update({ phase: 'idle', reason: 'stopped', message: '画面取得前に停止しました。PDFは作成していません。' });
      await fs.rm(directory, { recursive: true, force: true });
      if (closeAfterSave) window.close();
      return;
    }
    update({ phase: 'saving', reason: result.reason, message: 'PDFを作成しています…' });
    await writePdf(result.frames, output, state.title);
    const messages = { limit: '上限枚数に達したため終了しました。', unchanged: '画面が変化しなくなったため終了しました。末尾まで取得できたかPDFをご確認ください。', stopped: '停止しました。取得済みの画面を保存しました。', error: `途中でエラーが発生しました。取得済みの画面を保存しました。${result.error?.message || ''}` };
    update({ phase: 'done', output, message: messages[result.reason] });
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (closeAfterSave) window.close();
  } catch (error) {
    closeAfterSave = false;
    update({ phase: 'error', message: `${error.message}${directory ? ` 取得済み画像の保管先: ${directory}` : ''}` });
  } finally {
    controller = null;
    if (!window.isDestroyed()) window.setResizable(true);
  }
}

async function start(options) {
  guardIdle();
  const checked = validateOptions(options);
  if (!state.url || browser.webContents.isLoading()) throw new Error('サイトを開き、読み込み完了後に開始してください。');
  if (checked.mode === 'click' && !point) throw new Error('「位置を選ぶ」で次へボタンの位置を選んでください。');
  update({ phase: 'choosing' });
  try {
    const result = await dialog.showSaveDialog(window, { title: 'PDFの保存先', defaultPath: `Pagefolio-${new Date().toISOString().slice(0, 10)}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) { update({ phase: 'idle' }); return false; }
    const output = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`;
    job = record(checked, output);
    return true;
  } catch (error) { update({ phase: 'idle' }); throw error; }
}

function registerHandlers() {
  const handlers = {
    'browser:open': (_, url) => openUrl(url),
    'browser:back': () => { guardIdle(); if (browser.webContents.navigationHistory.canGoBack()) browser.webContents.navigationHistory.goBack(); },
    'browser:reload': () => { guardIdle(); browser.webContents.reload(); },
    'browser:pick': () => pickPoint(),
    'capture:start': (_, options) => start(options),
    'capture:stop': () => controller?.abort(),
    'capture:reveal': () => { if (state.output) shell.showItemInFolder(state.output); },
    'app:state': () => state
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(UI).href) throw new Error('Unauthorized IPC');
      try { return { ok: true, value: await handler(event, ...args) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
  }
}

async function boot() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1320, height: 880, minWidth: 1040, minHeight: 720, backgroundColor: '#f5f6f3', title: 'Pagefolio', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const webSession = session.fromPartition('persist:pagefolio-sites');
  webSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', event => { event.preventDefault(); update({ message: 'サイトからのファイルダウンロードは無効です。PDF保存機能をご利用ください。' }); });
  browser = new WebContentsView({ webPreferences: { session: webSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.contentView.addChildView(browser);
  browser.setBackgroundColor('#ffffff');
  layout();
  browser.setVisible(false);
  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (!active()) { try { void openUrl(url).catch(error => update({ message: error.message })); } catch {} }
    return { action: 'deny' };
  });
  const allowNavigation = (event, url) => {
    try { normalizeUrl(url); } catch { event.preventDefault(); }
  };
  browser.webContents.on('will-navigate', allowNavigation);
  browser.webContents.on('will-redirect', allowNavigation);
  browser.webContents.on('did-start-loading', () => { browser.setVisible(true); update({ loading: true }); });
  browser.webContents.on('did-stop-loading', () => update({ loading: false }));
  browser.webContents.on('did-navigate', (_, url) => update({ url }));
  browser.webContents.on('did-navigate-in-page', (_, url, main) => { if (main) update({ url }); });
  browser.webContents.on('page-title-updated', (_, title) => update({ title }));
  browser.webContents.on('did-fail-load', (_, code, description, __, main) => { if (main && code !== -3) update({ loading: false, message: `ページを開けませんでした: ${description}` }); });
  browser.webContents.on('render-process-gone', () => { controller?.abort(); update({ message: 'ページの表示プロセスが終了しました。再読み込みしてください。' }); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('resize', layout);
  window.on('close', event => {
    if (!active()) return;
    event.preventDefault();
    if (state.phase === 'recording') {
      const choice = dialog.showMessageBoxSync(window, { type: 'question', message: '停止して取得済みの画面をPDFに保存しますか？', buttons: ['続ける', '停止して保存'], defaultId: 0, cancelId: 0 });
      if (choice === 1) { closeAfterSave = true; controller?.abort(); }
    }
  });
  window.on('closed', () => { if (!browser.webContents.isDestroyed()) browser.webContents.close(); });
  registerHandlers();
  await window.loadFile(UI);
  return { window, browser };
}

app.on('window-all-closed', () => app.quit());
if (require.main === module) boot().catch(error => { console.error(error); app.quit(); });
module.exports = { boot, getState: () => state, getJob: () => job, driverFor };
