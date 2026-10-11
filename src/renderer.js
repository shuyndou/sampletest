const $ = id => document.getElementById(id);
let mode = 'scroll';
let lastMessage = '';

function notify(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = false;
}

async function call(promise) {
  try {
    const result = await promise;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } catch (error) { notify(error.message); }
}

function render(state) {
  const busy = ['recording', 'saving', 'choosing', 'picking'].includes(state.phase);
  document.querySelectorAll('.settings button,.settings input,.settings select,.address-bar button,.address-bar input').forEach(el => { el.disabled = busy; });
  $('start').disabled = busy || !state.url || state.loading;
  $('start').hidden = state.phase === 'recording';
  $('stop').hidden = state.phase !== 'recording';
  $('reveal').hidden = !state.output;
  $('empty-state').hidden = Boolean(state.url || state.loading);
  $('pick-label').textContent = state.picked ? '位置を選び直す ✓' : '「次へ」の位置を選ぶ';
  $('counter').textContent = `${state.count || 0} ページ`;
  $('status-dot').classList.toggle('busy', busy || state.loading);
  const labels = { choosing: '保存先を選択中…', picking: 'ページ内のクリック位置を選択してください', recording: '取得中 · ページを操作せずお待ちください', saving: 'PDFを作成しています…', done: 'PDFを保存しました', error: '保存を完了できませんでした' };
  $('status-text').textContent = labels[state.phase] || (state.loading ? 'サイトを読み込んでいます…' : state.url ? (state.title || '保存する最初の画面を表示してください') : 'サイトを開くと、保存を開始できます');
  if (state.url && document.activeElement !== $('url')) $('url').value = state.url;
  if (state.message && state.message !== lastMessage) notify(state.message);
  if (!state.message && lastMessage) $('notice').hidden = true;
  lastMessage = state.message;
}

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(el => { el.classList.toggle('active', el.dataset.mode === mode); el.setAttribute('aria-pressed', String(el.dataset.mode === mode)); });
  for (const value of ['scroll', 'click', 'key']) $(`${value}-options`).hidden = value !== mode;
  $('mode-description').textContent = { scroll: '画面を下にスクロールしながら保存します。', click: '「次へ」など、同じ位置をクリックして送ります。', key: '閲覧サイトのキーボード操作でページを送ります。' }[mode];
}));
$('overlap').addEventListener('input', () => { $('overlap-value').value = `${$('overlap').value}%`; });
$('url-form').addEventListener('submit', event => { event.preventDefault(); void call(window.pagefolio.open($('url').value)); $('url').blur(); });
$('back').addEventListener('click', () => call(window.pagefolio.back()));
$('reload').addEventListener('click', () => call(window.pagefolio.reload()));
$('pick').addEventListener('click', () => call(window.pagefolio.pick()));
$('start').addEventListener('click', () => {
  const maxPages = Number($('max-pages').value);
  const delay = Number($('delay').value) * 1000;
  if (!$('max-pages').reportValidity() || !$('delay').reportValidity()) return;
  void call(window.pagefolio.start({ mode, maxPages, delay, overlap: Number($('overlap').value), key: $('key').value }));
});
$('stop').addEventListener('click', () => call(window.pagefolio.stop()));
$('reveal').addEventListener('click', () => call(window.pagefolio.reveal()));
$('dismiss').addEventListener('click', () => { $('notice').hidden = true; });
window.pagefolio.onState(render);
void call(window.pagefolio.getState()).then(state => { if (state) render(state); });
