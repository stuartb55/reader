'use strict';
const $ = (id) => document.getElementById(id);
const grid = $('grid'), statusEl = $('status'), feedSel = $('feed'), dialog = $('article');
const state = { stream: 'reading-list', unread: true, continuation: null, loading: false, done: false, items: new Map(), newest: 0, open: null, gen: 0 };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function ago(sec) {
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.round(d / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

function card(item) {
  const c = el('button', { type: 'button', className: 'card' + (item.read ? ' read' : '') });
  c.dataset.id = item.id;
  if (item.image) {
    const img = el('img', { src: item.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    img.addEventListener('error', () => (img.src !== item.image ? (img.src = item.image) : img.remove()));
    img.addEventListener('load', () => sharpen(item, img));
    c.append(img);
  }
  const meta = el('span', { className: 'meta' }, `${item.feed} · ${ago(item.published)}`);
  if (item.starred) meta.append(el('span', { className: 'star' }, ' ★'));
  c.append(el('div', { className: 'inner' }, meta, el('h3', {}, item.title), el('p', {}, item.snippet)));
  c.addEventListener('click', () => openItem(item.id));
  return c;
}

// Some feeds only supply a tiny thumbnail; swap in the article's own lead image.
function sharpen(item, img) {
  if (item.sharp || img.naturalWidth >= 480) return;
  item.sharp = true;
  api(`/api/thumb?id=${encodeURIComponent(item.id)}`).then((r) => {
    if (!r.image || r.image === item.image) return;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => {
      if (probe.naturalWidth <= img.naturalWidth) return;
      item.image = r.image;
      img.src = r.image;
    };
    probe.src = r.image;
  }).catch(() => {});
}

async function loadFeeds() {
  const data = await api('/api/feeds');
  const current = feedSel.value || state.stream;
  feedSel.replaceChildren(
    el('option', { value: 'reading-list' }, `All feeds (${data.total})`),
    el('option', { value: 'starred' }, 'Starred'),
    ...data.feeds.map((f) => el('option', { value: f.id }, f.unread ? `${f.title} (${f.unread})` : f.title)),
  );
  feedSel.value = [...feedSel.options].some((o) => o.value === current) ? current : 'reading-list';
  $('count').textContent = data.total ? `${data.total} unread` : '';
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const gen = state.gen;
  statusEl.textContent = 'Loading…';
  try {
    const q = new URLSearchParams({ stream: state.stream, n: '30' });
    if (state.unread && state.stream !== 'starred') q.set('unread', '1');
    if (state.continuation) q.set('c', state.continuation);
    const data = await api(`/api/items?${q}`);
    if (gen !== state.gen) return;
    for (const item of data.items) {
      if (state.items.has(item.id)) continue;
      state.items.set(item.id, item);
      state.newest = Math.max(state.newest, item.published);
      grid.append(card(item));
    }
    state.continuation = data.continuation;
    state.done = !data.continuation || !data.items.length;
    statusEl.textContent = state.items.size ? (state.done ? 'That’s everything.' : '') : state.unread ? 'Nothing unread.' : 'No items.';
  } catch (err) {
    if (gen === state.gen) statusEl.textContent = `Could not load items: ${err.message}`;
    state.done = true;
  } finally {
    if (gen === state.gen) state.loading = false;
    // The observer only fires on changes, so keep filling while the end is still on screen.
    if (gen === state.gen && !state.done && $('sentinel').getBoundingClientRect().top < innerHeight + 800) loadMore();
  }
}

function reset() {
  state.gen++;
  Object.assign(state, { continuation: null, loading: false, done: false, newest: 0 });
  state.items.clear();
  grid.replaceChildren();
  loadMore();
  loadFeeds().catch((err) => { statusEl.textContent = `Could not load feeds: ${err.message}`; });
}

function paint(item) {
  const c = grid.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (c) c.replaceWith(card(item));
}

async function setTag(item, tag, on) {
  const before = item[tag];
  item[tag] = on;
  paint(item);
  try {
    await api('/api/tag', { ids: [item.id], tag, on });
    if (tag === 'read') loadFeeds().catch(() => {});
  } catch (err) {
    item[tag] = before;
    paint(item);
    statusEl.textContent = `Could not update item: ${err.message}`;
  }
}

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
    if (still()) note.textContent = `Showing the feed summary: ${err.message}.`;
  }
}

function openItem(id) {
  const item = state.items.get(id);
  if (!item) return;
  state.open = item;
  $('a-meta').textContent = [item.feed, item.author, new Date(item.published * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ');
  $('a-title').textContent = item.title;
  render(item.html);
  loadFull(item);
  const link = $('a-link');
  link.hidden = !item.url;
  if (item.url) link.href = item.url;
  $('a-star').textContent = item.starred ? '★ Starred' : '☆ Star';
  $('a-unread').hidden = false;
  dialog.showModal();
  dialog.scrollTop = 0;
  if (!item.read) setTag(item, 'read', true);
}

$('a-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
$('a-star').addEventListener('click', async () => {
  const item = state.open;
  await setTag(item, 'starred', !item.starred);
  $('a-star').textContent = item.starred ? '★ Starred' : '☆ Star';
});
$('a-unread').addEventListener('click', () => { setTag(state.open, 'read', false); dialog.close(); });
feedSel.addEventListener('change', () => { state.stream = feedSel.value; reset(); });
for (const [id, unread] of [['show-unread', true], ['show-all', false]]) {
  $(id).addEventListener('click', () => {
    state.unread = unread;
    $('show-unread').classList.toggle('on', unread);
    $('show-all').classList.toggle('on', !unread);
    reset();
  });
}
$('refresh').addEventListener('click', reset);
$('mark-all').addEventListener('click', async () => {
  if (state.stream === 'starred') return;
  const label = feedSel.selectedOptions[0]?.textContent || 'this view';
  if (!confirm(`Mark everything in “${label}” as read?`)) return;
  try {
    // Only up to now, so items fetched after this page loaded stay unread.
    await api('/api/mark-all-read', { stream: state.stream, before: Date.now() });
    reset();
  } catch (err) {
    statusEl.textContent = `Could not mark as read: ${err.message}`;
  }
});
new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '800px' }).observe($('sentinel'));

// An installed app can sit in the background for hours: reload when it comes
// back, unless the reader is part-way down the list or in an article.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 && !dialog.open && scrollY < 200) reset();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
reset();
