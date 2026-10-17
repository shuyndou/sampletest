const $ = id => document.getElementById(id);
let mode = 'scroll', scope = 'single', lastMessage = '', queueSignature = '', current = {};
const statuses = { pending: '待機', opening: '読込中', recording: '取得中', done: '保存済', review: '末尾要確認', partial: '一部保存', stopped: '停止', failed: 'エラー' };

function notify(message) { $('notice-text').textContent = message; $('notice').hidden = false; }
async function call(promise) {
  try { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
  catch (error) { notify(error.message); }
}
function render(state) {
  current = state;
  const busy = state.batchActive || ['recording', 'saving', 'choosing', 'picking', 'scanning', 'opening'].includes(state.phase);
  document.querySelectorAll('.settings button,.settings input,.settings select,.address-bar button,.address-bar input,.scope-switch button,.batch-controls button,.batch-controls input,.batch-controls textarea,.batch-controls select,.queue-list input').forEach(el => { el.disabled = busy; });
  const count = (state.queue || []).filter(item => item.selected !== false).length;
  $('start').disabled = busy || (scope === 'single' ? !state.url || state.loading : !count);
  $('start').hidden = state.batchActive || ['recording', 'scanning', 'opening'].includes(state.phase);
  $('stop').hidden = !(state.batchActive || ['recording', 'scanning', 'opening'].includes(state.phase));
  $('reveal').hidden = !state.output;
  $('empty-state').hidden = Boolean(state.url || state.loading || state.batchActive);
  $('pick-label').textContent = state.picked ? '位置を選び直す ✓' : '「次へ」の位置を選ぶ';
  $('counter').textContent = `${state.batchActive ? `${state.batchIndex || 0}/${count}件 · ` : ''}${state.count || 0} ページ`;
  $('status-dot').classList.toggle('busy', busy || state.loading);
  const labels = { choosing: '保存先を選択中…', picking: 'ページ内のクリック位置を選択してください', scanning: '絞り込み済み一覧を読み取り中…', opening: `開いています: ${state.batchTitle || ''}`, recording: state.batchActive ? `取得中: ${state.batchTitle}` : '取得中 · ページを操作せずお待ちください', saving: 'PDFを作成しています…', done: '保存処理が終了しました', error: '保存を完了できませんでした' };
  $('status-text').textContent = labels[state.phase] || (state.loading ? 'サイトを読み込んでいます…' : state.url ? state.title || '保存する最初の画面を表示してください' : 'サイトを開くか、URLを一覧に登録してください');
  if (state.url && document.activeElement !== $('url')) $('url').value = state.url;
  if (state.message && state.message !== lastMessage) notify(state.message);
  if (!state.message && lastMessage) $('notice').hidden = true;
  lastMessage = state.message;
  $('queue-panel').hidden = scope === 'single' || !(state.queue || []).length;
  $('queue-count').textContent = `${count} / ${(state.queue || []).length}件`;
  const signature = JSON.stringify([state.queue, busy]);
  if (signature !== queueSignature) {
    queueSignature = signature; $('queue-list').replaceChildren();
    for (const item of state.queue || []) {
      const row = document.createElement('label'); row.className = 'queue-item'; row.title = [item.title || item.url, item.error || '', item.output || ''].filter(Boolean).join('\n');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected !== false; checkbox.disabled = busy;
      checkbox.addEventListener('change', () => call(window.pagefolio.selectItem(item.id, checkbox.checked)));
      const name = document.createElement('span'); name.textContent = item.title || item.url;
      const status = document.createElement('small'); status.textContent = statuses[item.status] || ''; status.className = item.status;
      row.append(checkbox, name, status); $('queue-list').append(row);
    }
  }
}
function setMode(value) {
  mode = value;
  document.querySelectorAll('[data-mode]').forEach(el => { el.classList.toggle('active', el.dataset.mode === mode); el.setAttribute('aria-pressed', String(el.dataset.mode === mode)); });
  for (const value of ['scroll', 'click', 'key']) $(`${value}-options`).hidden = value !== mode;
  $('mode-description').textContent = { scroll: '画面を下にスクロールしながら保存します。', click: '「次へ」など、同じ位置をクリックして送ります。', key: '閲覧サイトのキーボード操作でページを送ります。' }[mode];
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-scope]').forEach(button => button.addEventListener('click', async () => {
  const next = button.dataset.scope;
  if (next === scope) return;
  await call(window.pagefolio.clearQueue());
  scope = next;
  document.querySelectorAll('[data-scope]').forEach(el => { el.classList.toggle('active', el.dataset.scope === scope); el.setAttribute('aria-pressed', String(el.dataset.scope === scope)); });
  $('kindle-batch').hidden = scope !== 'kindle'; $('web-batch').hidden = scope !== 'web';
  setMode(scope === 'kindle' ? 'key' : 'scroll');
  $('start').textContent = scope === 'single' ? 'PDFに保存する →' : '選択した対象を一括保存 →';
  render(current);
}));
$('overlap').addEventListener('input', () => { $('overlap-value').value = `${$('overlap').value}%`; });
$('url-form').addEventListener('submit', event => { event.preventDefault(); void call(window.pagefolio.open($('url').value)); $('url').blur(); });
$('back').addEventListener('click', () => call(window.pagefolio.back()));
$('reload').addEventListener('click', () => call(window.pagefolio.reload()));
$('pick').addEventListener('click', () => call(window.pagefolio.pick()));
$('open-library').addEventListener('click', () => call(window.pagefolio.open('https://read.amazon.co.jp/kindle-library?itemView=row')));
$('scan-library').addEventListener('click', () => call(window.pagefolio.scanLibrary()));
$('import-urls').addEventListener('click', () => call(window.pagefolio.importUrls($('urls').value)));
$('start').addEventListener('click', () => {
  if (!$('delay').reportValidity()) return;
  const options = { mode, delay: Number($('delay').value) * 1000, overlap: Number($('overlap').value), key: $('key').value, nextSelector: mode === 'click' ? $('next-selector').value : '', fromStart: $('from-start').value === 'start' };
  void call(scope === 'single' ? window.pagefolio.start(options) : window.pagefolio.startBatch(options));
});
$('stop').addEventListener('click', () => call(window.pagefolio.stop()));
$('reveal').addEventListener('click', () => call(window.pagefolio.reveal()));
$('dismiss').addEventListener('click', () => { $('notice').hidden = true; });
window.pagefolio.onState(render);
void call(window.pagefolio.getState()).then(state => { if (state) render(state); });
