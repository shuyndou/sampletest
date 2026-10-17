const { WebContentsView, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeUrl, wait } = require('./core.cjs');
const { parseUrlList, reserveOutput } = require('./batch.cjs');
const scripts = require('./page-scripts.cjs');

class BatchController {
  constructor(runtime) {
    Object.assign(this, runtime);
    this.queue = []; this.source = ''; this.running = false; this.view = null;
    this.emit({ batchActive: false });
  }
  emit(patch = {}) { this.update({ ...patch, queue: this.queue.map(item => ({ ...item })) }); }
  stop() { this.controller?.abort(); }
  clear() { this.queue = []; this.source = ''; this.emit({ batchTitle: '', batchIndex: 0 }); }
  select(id, selected) { const item = this.queue.find(entry => entry.id === id); if (item) item.selected = Boolean(selected); this.emit(); }
  importUrls(text) {
    const items = parseUrlList(text);
    if (!items.length) throw new Error('保存するURLを1行ずつ入力してください。');
    this.queue = items; this.source = 'web';
    this.emit({ phase: 'idle', message: `${items.length}件のURLを登録しました。` });
  }
  async scan() {
    const url = new URL(this.browser.webContents.getURL());
    if (url.hostname !== 'read.amazon.co.jp' || !url.pathname.startsWith('/kindle-library')) throw new Error('Kindleライブラリを開き、条件を絞り込んでから一覧を読み取ってください。');
    this.controller = new AbortController(); this.running = true;
    const signal = this.controller.signal, token = `__pagefolio_${randomUUID().replaceAll('-', '')}`;
    const found = new Map();
    this.update({ phase: 'scanning', message: '絞り込み済みの一覧を末尾まで読み取っています…', output: '' });
    const run = action => this.runScript(this.browser.webContents, scripts.scanPage, { kind: 'kindle', token, action });
    try {
      await run('init'); await wait(500, signal);
      let stable = 0, previous = '';
      while (!signal.aborted) {
        const result = await run('next');
        for (const item of result.items) {
          if (!/^(B[A-Z0-9]{9}|[0-9]{9}[0-9X])$/.test(item.asin) || typeof item.title !== 'string' || !item.title.trim()) continue;
          if (!found.has(item.asin)) found.set(item.asin, { id: randomUUID(), asin: item.asin, title: item.title.slice(0, 1000), url: `${url.origin}/?asin=${item.asin}`, source: 'kindle', status: 'pending' });
        }
        const marker = `${result.marker}:${found.size}`;
        stable = marker === previous ? stable + 1 : 0; previous = marker;
        this.update({ message: `一覧を読み取り中: ${found.size}冊` });
        if (stable >= 3) break;
        await wait(500, signal);
      }
      this.queue = [...found.values()]; this.source = 'kindle';
      this.emit({ phase: 'idle', message: signal.aborted ? `${this.queue.length}冊まで読み取りました（途中停止）。` : this.queue.length ? `${this.queue.length}冊を読み取りました。タイトルと対象を確認して開始してください。` : '本の識別情報を読み取れませんでした。行表示に切り替えて再試行してください。サイト側の構造に未対応の可能性があります。' });
    } finally {
      await run('restore').catch(() => {});
      this.controller = null; this.running = false;
      this.update({ phase: 'idle' });
      if (this.closeAfterSave) this.window.close();
    }
  }
  async load(url, signal) {
    if (signal.aborted) throw new Error('停止しました。');
    const contents = this.view.webContents;
    let timer, statusCode = 0;
    const navigated = (_, __, code) => { statusCode = code; };
    const stop = () => contents.stop();
    contents.on('did-navigate', navigated);
    signal.addEventListener('abort', stop, { once: true });
    try {
      await Promise.race([contents.loadURL(normalizeUrl(url)), new Promise((_, reject) => {
        timer = setTimeout(() => { contents.stop(); reject(new Error('サイトの読み込みが60秒以内に完了しませんでした。')); }, 60000);
      })]);
      if (statusCode >= 400) throw new Error(`サイトがHTTP ${statusCode}を返しました。PDFは作成していません。`);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); contents.removeListener('did-navigate', navigated); }
  }
  createView() {
    const view = new WebContentsView({ webPreferences: { session: this.browser.webContents.session, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    const allow = (event, url) => { try { normalizeUrl(url); } catch { event.preventDefault(); } };
    view.webContents.on('will-navigate', allow); view.webContents.on('will-redirect', allow);
    view.webContents.setWindowOpenHandler(({ url }) => {
      try { const target = normalizeUrl(url); void this.load(target, this.controller.signal).catch(() => {}); } catch {}
      return { action: 'deny' };
    });
    view.webContents.on('render-process-gone', () => this.stop());
    view.setBounds(this.browser.getBounds()); view.setBackgroundColor('#fff');
    this.window.contentView.addChildView(view);
    this.browser.setVisible(false); view.setVisible(true);
    return view;
  }
  async prepareKindle(signal, fromStart) {
    const contents = this.view.webContents, deadline = Date.now() + 60000;
    const run = action => this.runScript(contents, scripts.kindleStatus, { action });
    while (!signal.aborted) {
      const status = await run('status');
      if (status.auth) throw Object.assign(new Error('Kindleへのログインが必要です。一覧に戻ってログインし直してください。'), { code: 'AUTH_REQUIRED' });
      if (status.library) throw new Error('本文ではなく一覧に戻りました。この本をブラウザーで開けるか確認してください。');
      if (status.ready) break;
      if (Date.now() > deadline) throw new Error('Kindleの本文表示を確認できませんでした。この本は保存していません。');
      await wait(500, signal);
    }
    if (signal.aborted) return;
    if (!fromStart) { await run('focus'); return; }
    contents.sendInputEvent({ type: 'mouseMove', x: Math.round(this.view.getBounds().width / 2), y: 15 });
    await wait(500, signal);
    let result = await run('beginning');
    if (!result.clicked) { await run('menu'); await wait(500, signal); result = await run('beginning'); }
    if (!result.clicked) throw new Error('「本の先頭」への移動操作を検出できませんでした。個別保存で先頭を表示するか、開始位置を「前回の読書位置」に変更してください。');
    await this.driverFor(this.view).settle(1000, signal);
    await run('focus');
  }
  async start(options, fromStart) {
    if (!this.queue.some(item => item.selected !== false)) throw new Error('一覧の読み取り、またはURLの登録を行ってください。');
    this.update({ phase: 'choosing' });
    try {
      const result = await dialog.showOpenDialog(this.window, { title: '一括PDFの保存先フォルダー', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths[0]) { this.update({ phase: 'idle' }); return false; }
      this.job = this.run(options, result.filePaths[0], fromStart);
      return true;
    } catch (error) { this.update({ phase: 'idle' }); throw error; }
  }
  async run(options, directory, fromStart) {
    this.controller = new AbortController(); this.running = true;
    const signal = this.controller.signal;
    this.window.setResizable(false);
    const pending = this.queue.filter(item => item.selected !== false);
    for (const item of pending) Object.assign(item, { status: 'pending', error: '', output: '', count: 0, reason: '' });
    this.emit({ batchActive: true, output: directory, message: '', batchIndex: 0 });
    const report = { created: new Date().toISOString(), source: this.source, options, fromStart, items: [] };
    const reportPath = path.join(directory, `Pagefolio-result-${randomUUID()}.json`);
    try {
      this.view = this.createView();
      for (const [index, item] of pending.entries()) {
        if (signal.aborted) break;
        item.status = 'opening';
        this.emit({ phase: 'opening', count: 0, batchIndex: index + 1, batchTitle: item.title || item.url });
        let output;
        try {
          await this.load(item.url, signal);
          if (signal.aborted) break;
          if (item.source === 'kindle') await this.prepareKindle(signal, fromStart);
          if (signal.aborted) break;
          if (!item.title) item.title = this.view.webContents.getTitle() || new URL(item.url).hostname;
          output = await reserveOutput(directory, item.title);
          item.status = 'recording'; this.emit({ batchTitle: item.title });
          const result = await this.captureOne(this.view, options, output, item.title, signal);
          Object.assign(item, { ...result, status: result.error ? 'partial' : result.count ? (['unchanged', 'cycle'].includes(result.reason) ? 'review' : result.reason === 'stopped' ? 'stopped' : 'done') : 'stopped' });
          if (!result.count) { await fs.rm(output, { force: true }); output = null; }
        } catch (error) {
          Object.assign(item, { status: signal.aborted ? 'stopped' : 'failed', error: error.message });
          if (output) { const stat = await fs.stat(output).catch(() => null); if (stat?.size === 0) await fs.rm(output, { force: true }); }
          if (['AUTH_REQUIRED', 'ENOSPC', 'EACCES', 'EROFS'].includes(error.code)) this.controller.abort();
        } finally {
          if (item.status === 'opening' && signal.aborted) item.status = 'stopped';
          report.items = pending.map(entry => ({ ...entry }));
          await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
          this.emit();
        }
      }
      const saved = pending.filter(item => item.output).length;
      const failed = pending.filter(item => ['failed', 'partial'].includes(item.status)).length;
      const review = pending.filter(item => item.status === 'review').length;
      const unrun = pending.filter(item => item.status === 'pending').length;
      this.emit({ phase: 'done', message: `${signal.aborted ? '一括保存を停止しました。' : '一括保存が終了しました。'} 保存 ${saved}件・要末尾確認 ${review}件・エラー ${failed}件・未実行 ${unrun}件。保存先に結果JSONを出力しました。`, output: directory });
    } catch (error) { this.closeAfterSave = false; this.update({ phase: 'error', message: error.message }); }
    finally {
      this.running = false; this.controller = null;
      if (this.view) { this.window.contentView.removeChildView(this.view); this.view.webContents.close(); this.view = null; }
      if (!this.window.isDestroyed()) { this.browser.setVisible(true); this.window.setResizable(true); }
      this.update({ batchActive: false, loading: false });
      if (this.closeAfterSave) this.window.close();
    }
  }
}
module.exports = { BatchController };
