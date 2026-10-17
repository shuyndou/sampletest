// These functions run in the site's sandbox. Only DOM data is returned to the main process.
function inspectPage({ mode, nextSelector, point, scroll, overlap }) {
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  let next;
  if (nextSelector) {
    for (const doc of docs) { next = doc.querySelector(nextSelector); if (visible(next)) break; }
    if (!visible(next)) throw new Error('指定された「次へ」ボタンが見つかりません。');
  } else if (mode === 'click' && point) {
    next = document.elementFromPoint(innerWidth * point.x, innerHeight * point.y)?.closest('button,a,[role="button"]');
  } else if (mode === 'key') {
    for (const doc of docs) {
      next = [...doc.querySelectorAll('button,[role="button"],a[rel="next"]')].find(el => visible(el) && /^(次へ|次のページ|next|next page)$/i.test((el.getAttribute('aria-label') || el.title || el.textContent).trim()));
      if (next) break;
    }
  }
  const explicitEnd = Boolean(next && (next.disabled || next.getAttribute('aria-disabled') === 'true'));
  if (mode !== 'scroll') {
    const progress = docs.map(doc => doc.querySelector('#kindleReader_footer,[data-testid="reader-progress"]')?.textContent?.trim() || '').join('|');
    return { explicitEnd, atEnd: explicitEnd, marker: `${location.href}|${progress}` };
  }
  let doc = document;
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  if (el?.tagName === 'IFRAME') {
    return { childFrame: { url: el.src, name: el.name } };
  }
  for (; el && el !== doc.body; el = el.parentElement) {
    const css = doc.defaultView.getComputedStyle(el);
    if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(css.overflowY)) break;
  }
  const target = el && el !== doc.body ? el : doc.scrollingElement;
  if (!target) return {};
  if (scroll) target.scrollBy({ top: Math.round(target.clientHeight * (1 - overlap / 100)), behavior: 'instant' });
  return { reliable: true, marker: `${location.href}|${Math.round(target.scrollTop)}|${target.scrollHeight}|${target.clientHeight}`, viewportHeight: target.clientHeight, atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 2 };
}

function clickNext(selector) {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  for (const doc of docs) {
    const el = doc.querySelector(selector);
    if (el?.getClientRects().length) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      el.click(); return true;
    }
  }
  throw new Error('指定された「次へ」ボタンが見つかりません。');
}

function scanPage({ kind, selector, token, action }) {
  const visible = el => Boolean(el?.getClientRects().length) && (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).visibility !== 'hidden');
  if (action === 'restore') {
    const saved = globalThis[token];
    if (saved) { saved.target.scrollTop = saved.top; delete globalThis[token]; }
    return null;
  }
  function findItems() {
    const result = new Map();
    if (kind === 'web') {
      for (const a of document.querySelectorAll(selector || 'main a[href], article a[href]')) {
        if (!visible(a) || !a.href || !/^https?:/.test(a.href)) continue;
        const title = (a.innerText || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt || '').trim();
        if (title && !result.has(a.href)) result.set(a.href, { title, url: a.href });
      }
    } else {
      const asinPattern = /(?:^|[^A-Z0-9])(B[A-Z0-9]{9}|[0-9]{9}[0-9X])(?:$|[^A-Z0-9])/i;
      const candidates = document.querySelectorAll('[data-asin],[data-asin-id],[data-book-id],[data-csa-c-item-id],[data-item-id],[id],a[href*="asin="],a[href*="/dp/"]');
      for (const el of candidates) {
        if (!visible(el)) continue;
        const raw = [el.getAttribute('data-asin'), el.getAttribute('data-asin-id'), el.getAttribute('data-book-id'), el.getAttribute('data-csa-c-item-id'), el.getAttribute('data-item-id'), el.id, el.getAttribute('href')].filter(Boolean).join(' ');
        const asin = raw.match(asinPattern)?.[1]?.toUpperCase();
        if (!asin) continue;
        let row = el.closest('[data-asin],[data-book-id],[data-csa-c-item-id],[data-item-id],[role="listitem"],article,li') || el;
        // ASIN is sometimes on the cover or its link, with the title in a sibling.
        for (let n = 0; n < 4 && row.parentElement && !row.querySelector('[class*="title" i],[data-testid*="title" i],h2,h3'); n++) {
          if (row.parentElement.querySelectorAll('img').length > 1) break;
          row = row.parentElement;
        }
        const titleNode = row.querySelector('[class*="title" i],[data-testid*="title" i],h2,h3');
        const title = (titleNode?.textContent || el.getAttribute('title') || row.innerText?.split('\n').find(s => s.trim()) || row.getAttribute('aria-label') || row.querySelector('img[alt]')?.alt || '').trim();
        if (!title || result.has(asin)) continue;
        result.set(asin, { title, asin, url: `${location.origin}/?asin=${encodeURIComponent(asin)}` });
      }
    }
    return [...result.values()];
  }
  if (action === 'init') {
    const scrollable = [...document.querySelectorAll('body *')].filter(el => visible(el) && el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    if (document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 4 || !scrollable.length) scrollable.push(document.scrollingElement);
    const target = scrollable.filter(Boolean).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    globalThis[token] = { target, top: target.scrollTop };
    target.scrollTop = 0;
    return null;
  }
  const target = globalThis[token]?.target;
  if (!target) throw new Error('一覧が更新されました。もう一度一覧を読み取ってください。');
  const items = findItems();
  const bottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 3;
  const marker = `${Math.round(target.scrollTop)}:${target.scrollHeight}`;
  if (action === 'next') target.scrollTop += Math.max(1, Math.round(target.clientHeight * 0.8));
  return { items, bottom, marker };
}

function kindleStatus({ action }) {
  const visible = el => el?.getClientRects().length && (el.checkVisibility ? el.checkVisibility() : true);
  if (/\/ap\/(signin|cvf)/.test(location.pathname) || document.querySelector('input[type="password"]')) return { auth: true };
  if (location.pathname.startsWith('/kindle-library')) return { library: true };
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {} }
  const controls = docs.flatMap(doc => [...doc.querySelectorAll('button,a,[role="button"],[role="menuitem"],input[type="button"]')]).filter(visible);
  const name = el => (el.getAttribute('aria-label') || el.title || el.value || el.textContent || '').trim();
  const beginning = controls.find(el => /^(本の先頭|先頭へ|最初から読む|最初のページ|表紙|beginning|go to beginning|go to start|cover)$/i.test(name(el)));
  if (action === 'beginning' && beginning) { beginning.click(); return { clicked: true }; }
  const goTo = controls.find(el => /^(移動|移動先|go to|go to…|go to\.\.\.)$/i.test(name(el)) || el.id === 'kindleReader_goToMenu');
  if (action === 'menu' && goTo) { goTo.click(); return { clicked: true }; }
  const surface = docs.some(doc => [...doc.querySelectorAll('#kindleReader_content,#kindleReader_book,#kindleReader_contentContainer,[id^="kindleReader_page"],[data-testid="reader"],canvas,[role="document"]')].some(visible));
  if (action === 'focus') {
    for (const doc of docs) {
      const target = [...doc.querySelectorAll('#kindleReader_content,#kindleReader_book,#kindleReader_contentContainer,[data-testid="reader"],canvas,[role="document"]')].find(visible);
      if (target) {
        doc.defaultView.focus();
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        return { focused: true };
      }
    }
  }
  const loading = docs.some(doc => [...doc.querySelectorAll('[aria-busy="true"],[role="progressbar"]:not([aria-valuenow])')].some(visible));
  return { ready: surface && !loading, auth: false };
}

module.exports = { inspectPage, clickNext, scanPage, kindleStatus };
