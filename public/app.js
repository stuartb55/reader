'use strict';
const $ = (id) => document.getElementById(id);
const grid = $('grid'), statusEl = $('status'), feedsEl = $('feeds'), dialog = $('article');
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const state = {
  stream: 'reading-list', unread: true, continuation: null, loading: null, done: false, gen: 0,
  items: new Map(), open: null, total: null, feeds: [],
  // Feeds whose own thumbnails are too small to show; remembered so cards never flash a blurry one.
  lowres: new Set(store.get('lowres', [])),
};
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const explain = (err) => (err instanceof TypeError ? 'you appear to be offline, or the server can’t be reached' : err.message);

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

function ago(sec) {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.round(d / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// "Articles | Mail Online" -> "Mail Online"; "The Register: Biting the hand…" -> "The Register".
const GENERIC = /^(news|articles?|home|latest|rss|feed|top stories)$/i;
function shortName(title) {
  const parts = title.split(/\s+[|–—-]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => !GENERIC.test(p)) || title;
}

// ---- Toast -----------------------------------------------------------------
let toastTimer;
function toast(text, actionLabel, action) {
  const box = $('toast'), btn = $('toast-action');
  $('toast-text').textContent = text;
  btn.textContent = actionLabel || '';
  btn.onclick = action ? () => { box.hidden = true; action(); } : null;
  // Sit above whichever dialog is open.
  (document.querySelector('dialog[open]') || document.body).append(box);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 7000 : 4500);
}

// ---- Card images -----------------------------------------------------------
function sharpImage(item) {
  item.sharp ??= api(`/api/thumb?id=${encodeURIComponent(item.id)}`).then((r) => r.image || null, () => null);
  return item.sharp;
}
const nearScreen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    nearScreen.unobserve(e.target);
    e.target.dispatchEvent(new Event('near'));
  }
}, { rootMargin: '700px' });

function cardImage(item) {
  const img = el('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
  img.addEventListener('error', () => {
    if (img.dataset.fallback || img.src === item.image) return img.remove();
    img.dataset.fallback = '1';
    img.src = item.image;
  });
  if (state.lowres.has(item.feedId)) {
    // Known-small thumbnails: wait for the article's own image rather than flash a blurry one.
    img.addEventListener('near', async () => { img.src = (await sharpImage(item)) || item.image; });
    nearScreen.observe(img);
  } else {
    img.src = item.image;
    img.addEventListener('load', async () => {
      if (img.naturalWidth >= 480 || img.dataset.fallback) return;
      state.lowres.add(item.feedId);
      store.set('lowres', [...state.lowres]);
      const better = await sharpImage(item);
      if (better && better !== item.image && img.isConnected) img.src = better;
    }, { once: true });
  }
  return img;
}

// ---- Swipe -----------------------------------------------------------------
function swipeable(node, commit, { drag = true } = {}) {
  let id = null, x0 = 0, y0 = 0, dx = 0, active = false;
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('pre, table')) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; active = false;
  });
  node.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    dx = e.clientX - x0;
    if (!active) {
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(e.clientY - y0) * 1.5) return;
      active = true;
      node.classList.add('swiping');
    }
    if (drag) {
      node.style.transform = `translateX(${dx}px)`;
      node.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 320));
    }
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!active) return;
    active = false;
    node.classList.remove('swiping');
    node.style.transform = node.style.opacity = '';
    // The finger lifting would otherwise also count as a tap.
    node.dataset.swiped = '1';
    setTimeout(() => delete node.dataset.swiped, 400);
    if (e.type === 'pointerup' && Math.abs(dx) > 80) commit(dx);
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

// ---- Cards -----------------------------------------------------------------
function card(item) {
  const c = el('article', { className: 'card' + (item.read ? ' read' : '') + (item.image ? '' : ' noimg') });
  c.dataset.id = item.id;
  const open = el('button', { type: 'button', className: 'open' });
  if (item.image) open.append(cardImage(item));
  const meta = el('span', { className: 'meta' }, `${shortName(item.feed)} · ${ago(item.published)}`);
  if (item.starred) meta.prepend(el('span', { className: 'star', title: 'Starred' }, '★ '));
  open.append(el('div', { className: 'inner' }, meta, el('h3', {}, item.title), el('p', {}, item.snippet)));
  open.addEventListener('click', () => { if (!c.dataset.swiped) openItem(item.id); });
  const label = item.read ? 'Mark as unread' : 'Mark as read';
  const done = el('button', { type: 'button', className: 'done', title: label, innerHTML: item.read ? UNDO : CHECK });
  done.setAttribute('aria-label', `${label}: ${item.title}`);
  done.addEventListener('click', () => dismiss(item));
  swipeable(c, () => dismiss(item));
  c.append(open, done);
  return c;
}

const cardFor = (item) => grid.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
function paint(item) {
  cardFor(item)?.replaceWith(card(item));
}

let countsTimer;
async function setTag(item, tag, on) {
  const before = item[tag];
  item[tag] = on;
  paint(item);
  try {
    await api('/api/tag', { ids: [item.id], tag, on });
    if (tag === 'read') {
      clearTimeout(countsTimer);
      countsTimer = setTimeout(() => loadFeeds().catch(() => {}), 700);
    }
    return true;
  } catch (err) {
    item[tag] = before;
    paint(item);
    toast(`Couldn’t update that item: ${explain(err)}.`);
    return false;
  }
}

// The tick on a card, or a swipe: mark read and clear it out of an unread list.
async function dismiss(item) {
  if (item.read) return setTag(item, 'read', false);
  const clears = state.unread && state.stream !== 'starred';
  const next = cardFor(item)?.nextElementSibling;
  const saving = setTag(item, 'read', true);
  // setTag has already redrawn the card as read; fade that one out.
  const c = clears && cardFor(item);
  if (c) {
    c.offsetWidth;
    c.classList.add('gone');
    setTimeout(() => c.remove(), 180);
  }
  const ok = await saving;
  const restore = () => {
    if (!clears || !state.items.has(item.id) || cardFor(item)) return;
    const again = card(item);
    next?.isConnected ? next.before(again) : grid.prepend(again);
  };
  if (!ok) return restore();
  toast('Marked as read', 'Undo', async () => { await setTag(item, 'read', false); restore(); });
}

// ---- Feeds -----------------------------------------------------------------
function chip(stream, label, count) {
  const b = el('button', { type: 'button', className: 'chip' + (stream === state.stream ? ' on' : '') }, label);
  b.dataset.stream = stream;
  b.setAttribute('aria-pressed', String(stream === state.stream));
  if (count) b.append(el('span', { className: 'n' }, String(count)));
  b.addEventListener('click', () => {
    if (state.stream === stream) return scrollTo({ top: 0, behavior: 'smooth' });
    state.stream = stream;
    reset();
  });
  return b;
}

function renderFeeds() {
  const left = feedsEl.scrollLeft;
  feedsEl.replaceChildren(
    chip('reading-list', 'All feeds', state.total),
    ...state.feeds.map((f) => chip(f.id, shortName(f.title), f.unread)),
    chip('starred', '★ Starred'),
  );
  feedsEl.scrollLeft = left;
  $('count').textContent = state.total ? `${state.total} unread` : '';
  $('mark-all').hidden = state.stream === 'starred';
}

async function loadFeeds() {
  const data = await api('/api/feeds');
  state.total = data.total;
  state.feeds = data.feeds;
  renderFeeds();
  if (navigator.setAppBadge) (data.total ? navigator.setAppBadge(data.total) : navigator.clearAppBadge()).catch(() => {});
  return data.total;
}

// ---- List ------------------------------------------------------------------
function loadMore() {
  if (state.loading) return state.loading;
  if (state.done) return Promise.resolve();
  const gen = state.gen;
  const run = (async () => {
    try {
      const q = new URLSearchParams({ stream: state.stream, n: '30' });
      if (state.unread && state.stream !== 'starred') q.set('unread', '1');
      if (state.continuation) q.set('c', state.continuation);
      const data = await api(`/api/items?${q}`);
      if (gen !== state.gen) return;
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      for (const item of data.items) {
        if (state.items.has(item.id)) continue;
        state.items.set(item.id, item);
        grid.append(card(item));
      }
      state.continuation = data.continuation;
      state.done = !data.continuation || !data.items.length;
      statusEl.textContent = state.items.size ? (state.done ? 'That’s everything.' : '') : state.unread ? 'Nothing unread here.' : 'No items.';
    } catch (err) {
      if (gen !== state.gen) return;
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      state.done = true;
      const retry = el('button', { type: 'button' }, 'Try again');
      retry.addEventListener('click', () => { state.done = false; statusEl.textContent = 'Loading…'; loadMore(); });
      statusEl.replaceChildren(`Couldn’t load items: ${explain(err)}.`, retry);
    }
  })();
  state.loading = run;
  run.finally(() => {
    if (state.loading !== run) return;
    state.loading = null;
    // The observer only fires on changes, so keep filling while the end is still on screen.
    if (!state.done && $('sentinel').getBoundingClientRect().top < innerHeight + 800) loadMore();
  });
  return run;
}

function reset() {
  state.gen++;
  Object.assign(state, { continuation: null, loading: null, done: false });
  state.items.clear();
  statusEl.textContent = '';
  grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', { className: 'card skeleton' })));
  scrollTo(0, 0);
  renderFeeds();
  loadMore();
  loadFeeds().catch((err) => toast(`Couldn’t load your feeds: ${explain(err)}.`));
}

// ---- Article ---------------------------------------------------------------
// Feed HTML is untrusted: rebuild it from an allowlist instead of inserting it.
const ALLOWED = new Set(['P', 'BR', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP', 'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'DIV', 'SPAN', 'SMALL', 'TIME', 'DL', 'DT', 'DD']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
const webUrl = (u) => { try { const p = new URL(u, 'https://invalid.invalid'); return /^https?:$/.test(p.protocol) && p.hostname !== 'invalid.invalid' ? p.href : null; } catch { return null; } };

function clean(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out.append(child.textContent); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE || DROP.has(child.tagName.toUpperCase())) continue;
    const tag = child.tagName.toUpperCase();
    if (!ALLOWED.has(tag)) { clean(child, out); continue; }
    const n = document.createElement(tag === 'H1' ? 'h3' : tag);
    if (tag === 'A') {
      const href = webUrl(child.getAttribute('href'));
      if (href) Object.assign(n, { href, target: '_blank', rel: 'noopener noreferrer' });
    } else if (tag === 'IMG') {
      const src = webUrl(child.getAttribute('src'));
      if (!src) continue;
      Object.assign(n, { src, alt: child.getAttribute('alt') || '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    }
    clean(child, n);
    out.append(n);
  }
}

function render(html, leadImage) {
  const body = $('a-body');
  body.replaceChildren();
  if (leadImage) body.append(el('img', { src: leadImage, alt: '', referrerPolicy: 'no-referrer' }));
  clean(new DOMParser().parseFromString(html, 'text/html').body, body);
}

// Show the feed's summary straight away, then swap in the full article text.
async function loadFull(item) {
  const note = $('a-note');
  const still = () => state.open === item && dialog.open;
  if (!item.url) { note.textContent = ''; return; }
  note.textContent = 'Loading full article…';
  try {
    item.full ??= await api(`/api/article?id=${encodeURIComponent(item.id)}`);
    if (!still()) return;
    render(item.full.html, item.full.leadImage);
    note.textContent = `${Math.max(1, Math.round(item.full.words / 230))} min read`;
  } catch (err) {
    if (still()) note.textContent = `Showing the feed’s summary: ${explain(err)}.`;
  }
}

const listIds = () => [...grid.querySelectorAll('.card[data-id]')].map((c) => c.dataset.id);
function updateNav() {
  const ids = listIds(), i = ids.indexOf(state.open?.id);
  $('a-prev').disabled = i <= 0;
  $('a-next').disabled = i === -1 || (i === ids.length - 1 && state.done);
}

function showStar(item) {
  $('a-star').textContent = item.starred ? '★' : '☆';
  $('a-star').setAttribute('aria-pressed', String(item.starred));
  $('a-star').setAttribute('aria-label', item.starred ? 'Remove star' : 'Star');
}

function openItem(id) {
  const item = state.items.get(id);
  if (!item) return;
  state.open = item;
  $('a-meta').textContent = [shortName(item.feed), item.author, new Date(item.published * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ');
  $('a-title').textContent = item.title;
  render(item.html);
  const link = $('a-link');
  link.hidden = !item.url;
  if (item.url) link.href = item.url;
  showStar(item);
  if (!dialog.open) dialog.showModal();
  $('a-scroll').scrollTop = 0;
  updateNav();
  loadFull(item);
  if (!item.read) setTag(item, 'read', true);
  cardFor(item)?.scrollIntoView({ block: 'nearest' });
}

async function step(dir) {
  if (!state.open) return;
  let ids = listIds(), i = ids.indexOf(state.open.id);
  if (i === -1) return;
  if (dir > 0 && i === ids.length - 1 && !state.done) {
    $('a-next').disabled = true;
    await loadMore();
    ids = listIds();
    i = ids.indexOf(state.open.id);
  }
  const target = ids[i + dir];
  if (target) openItem(target);
  else updateNav();
}

$('a-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { state.open = null; });
$('a-prev').addEventListener('click', () => step(-1));
$('a-next').addEventListener('click', () => step(1));
swipeable($('a-scroll'), (dx) => step(dx < 0 ? 1 : -1), { drag: false });
dialog.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowRight' || e.key === 'j') step(1);
  else if (e.key === 'ArrowLeft' || e.key === 'k') step(-1);
});
$('a-star').addEventListener('click', async () => {
  const item = state.open;
  await setTag(item, 'starred', !item.starred);
  if (state.open === item) showStar(item);
});
$('a-unread').addEventListener('click', () => { setTag(state.open, 'read', false); dialog.close(); });
dialog.dataset.size = String(store.get('size', 0));
$('a-size').addEventListener('click', () => {
  const size = (Number(dialog.dataset.size) + 1) % 3;
  dialog.dataset.size = String(size);
  store.set('size', size);
});

// ---- Header ----------------------------------------------------------------
for (const [id, unread] of [['show-unread', true], ['show-all', false]]) {
  $(id).addEventListener('click', () => {
    if (state.unread === unread) return;
    state.unread = unread;
    for (const [other, on] of [['show-unread', unread], ['show-all', !unread]]) {
      $(other).classList.toggle('on', on);
      $(other).setAttribute('aria-pressed', String(on));
    }
    reset();
  });
}
$('refresh').addEventListener('click', reset);

function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('view').setAttribute('aria-pressed', String(on));
  store.set('compact', on);
}
setCompact(store.get('compact', false));
$('view').addEventListener('click', () => setCompact(!document.body.classList.contains('compact')));

$('mark-all').addEventListener('click', () => {
  const feed = state.feeds.find((f) => f.id === state.stream);
  const n = feed ? feed.unread : state.total;
  if (!n) return toast('Nothing unread here.');
  const where = feed ? `“${shortName(feed.title)}”` : 'every feed';
  $('c-text').textContent = `Mark all ${n} unread ${n === 1 ? 'item' : 'items'} in ${where} as read? This includes items you haven’t scrolled to, and can’t be undone.`;
  $('confirm').showModal();
});
$('c-cancel').addEventListener('click', () => $('confirm').close());
$('c-ok').addEventListener('click', async () => {
  $('confirm').close();
  try {
    // Only up to now, so anything fetched after this stays unread.
    await api('/api/mark-all-read', { stream: state.stream, before: Date.now() });
    reset();
  } catch (err) {
    toast(`Couldn’t mark them as read: ${explain(err)}.`);
  }
});

new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '800px' }).observe($('sentinel'));

// An installed app can sit in the background for hours. Coming back, reload if
// the reader is at the top; otherwise keep their place and offer the new items.
let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!hiddenAt || Date.now() - hiddenAt < 5 * 60 * 1000) return;
  if (!dialog.open && scrollY < 200) return reset();
  const before = state.total;
  const now = await loadFeeds().catch(() => null);
  if (now !== null && before !== null && now > before) toast(`${now - before} new ${now - before === 1 ? 'item' : 'items'}`, 'Show', () => { dialog.close(); reset(); });
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
reset();
