import { api, explain, unreachable } from './modules/api.js';
import { prefs } from './modules/prefs.js';
import * as db from './modules/db.js';
import { clean } from './modules/sanitize.js';
import { el, ago, shortName, groupChanges } from './modules/util.js';

const $ = (id) => document.getElementById(id);
const grid = $('grid'), statusEl = $('status'), dialog = $('article');
const STREAM = /^(reading-list|starred|feed\/\d+|user\/-\/label\/.+)$/;
const query = new URLSearchParams(location.search);
const startStream = [query.get('s'), prefs.get('stream', '')].find((s) => s && STREAM.test(s)) || 'reading-list';
const saved = prefs.get('feeds', null);

const state = {
  stream: startStream,
  // The top-row chip that is selected; a feed is picked inside it.
  scope: startStream.startsWith('feed/') ? prefs.get('scope', 'reading-list') : startStream,
  unread: query.has('show') ? query.get('show') !== 'all' : prefs.get('unread', true),
  order: prefs.get('order', 'newest'),
  continuation: null, loading: null, done: false, gen: 0,
  items: new Map(), open: null,
  total: saved?.total ?? null, feeds: saved?.feeds ?? [], categories: saved?.categories ?? [],
  // Set while the list on screen is a saved copy, with when it was saved.
  offline: null, pending: 0,
  // Feeds whose own thumbnails are too small to show; remembered so cards never flash a blurry one.
  lowres: new Set(prefs.get('lowres', [])),
};
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- Toast -----------------------------------------------------------------
let toastTimer;
function toast(text, actionLabel, action, ms) {
  const box = $('toast'), btn = $('toast-action');
  $('toast-text').textContent = text;
  btn.textContent = actionLabel || '';
  btn.onclick = action ? () => { box.hidden = true; action(); } : null;
  // Sit above whichever dialog is on top.
  ([...document.querySelectorAll('dialog[open]')].pop() || document.body).append(box);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms || (action ? 7000 : 4500));
}

// ---- Offline copy and queued changes ----------------------------------------
const listKey = () => `${state.stream}|${state.unread ? 1 : 0}|${state.order}`;

function showBanner() {
  const parts = [];
  if (state.offline) {
    const at = new Date(state.offline.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    parts.push(`Showing items saved ${at}: ${state.offline.why}.`);
  }
  if (state.pending) parts.push(`${plural(state.pending, 'change')} will sync when FreshRSS is reachable again.`);
  $('banner').textContent = parts.join(' ');
  $('banner').hidden = !parts.length;
}

// Keep a copy of what is on screen so it can be shown without a connection.
let saveTimer;
function saveListSoon() {
  if (state.offline) return;
  clearTimeout(saveTimer);
  const key = listKey(), hideRead = state.unread && state.stream !== 'starred';
  saveTimer = setTimeout(() => {
    const items = [...state.items.values()]
      .filter((i) => !(hideRead && i.read))
      .slice(0, 150)
      .map(({ sharp: _sharp, full: _full, ...plain }) => plain);
    db.putList(key, items).catch(() => {});
  }, 800);
}

async function showSaved(err) {
  const [list, waiting] = await Promise.all([db.getList(listKey()), db.outbox()]).catch(() => []);
  if (!list?.items.length) return false;
  const byId = new Map(list.items.map((i) => [i.id, i]));
  for (const change of waiting || []) if (byId.has(change.id)) byId.get(change.id)[change.tag] = change.on;
  const hideRead = state.unread && state.stream !== 'starred';
  for (const item of list.items) {
    if (hideRead && item.read) continue;
    state.items.set(item.id, item);
    grid.append(card(item));
  }
  state.done = true;
  state.offline = { at: list.at, why: explain(err) };
  statusEl.textContent = state.items.size ? '' : 'Nothing unread in the saved copy.';
  showBanner();
  return true;
}

// Send changes made while FreshRSS could not be reached. Resolves to how many
// were sent, or -1 if it still cannot be reached.
let flushing = null;
function flush() {
  flushing ??= (async () => {
    const entries = await db.outbox().catch(() => []);
    try {
      for (const group of groupChanges(entries)) {
        for (let i = 0; i < group.ids.length; i += 500) {
          await api('/api/tag', { ids: group.ids.slice(i, i + 500), tag: group.tag, on: group.on });
        }
      }
    } catch (err) {
      if (unreachable(err)) return -1;
      // FreshRSS answered and refused: drop the changes instead of retrying forever.
      toast(`Some saved changes could not be applied: ${explain(err)}.`);
    }
    await db.clearOutbox(entries.map((e) => e.key)).catch(() => {});
    state.pending = 0;
    return entries.length;
  })().finally(() => { flushing = null; });
  return flushing;
}

async function sync() {
  if (!state.pending && !state.offline) return;
  // With nothing to send, ask the server whether FreshRSS is back before reloading the list.
  const sent = state.pending ? await flush() : await api('/api/status').then(() => 0, (err) => (unreachable(err) ? -1 : 0));
  showBanner();
  if (sent > 0) toast(`${plural(sent, 'change')} synced`);
  if (sent >= 0 && (sent > 0 || state.offline)) reset();
}

// Fetch article text ahead of time so the first screen of items can be read offline.
let prefetching = 0;
async function prefetch(items) {
  if (!prefs.get('offlineArticles', true) || navigator.connection?.saveData || !navigator.onLine) return;
  const mine = ++prefetching;
  for (const item of items) {
    if (mine !== prefetching) return;
    if (!item.url || item.read || item.full) continue;
    try {
      await fullText(item);
    } catch (err) {
      if (unreachable(err)) return;
    }
  }
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
      prefs.set('lowres', [...state.lowres]);
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
    if (e.pointerType === 'mouse' || e.target.closest('pre, table, audio')) return;
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
  open.append(el('div', { className: 'inner' }, meta, el('h3', {}, item.title), el('p', {}, item.snippet)));
  open.addEventListener('click', () => { if (!c.dataset.swiped) openItem(item.id); });
  const label = item.read ? 'Mark as unread' : 'Mark as read';
  const done = el('button', { type: 'button', className: 'done', title: label, innerHTML: item.read ? UNDO : CHECK });
  done.setAttribute('aria-label', `${label}: ${item.title}`);
  done.addEventListener('click', () => dismiss(item));
  const starLabel = item.starred ? 'Remove star' : 'Star';
  const fav = el('button', { type: 'button', className: 'fav' + (item.starred ? ' on' : ''), title: starLabel }, item.starred ? '★' : '☆');
  fav.setAttribute('aria-label', `${starLabel}: ${item.title}`);
  fav.setAttribute('aria-pressed', String(item.starred));
  fav.addEventListener('click', () => setTag(item, 'starred', !item.starred));
  swipeable(c, () => dismiss(item));
  c.append(open, fav, done);
  return c;
}

const cardFor = (item) => grid.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
function paint(item) {
  const old = cardFor(item);
  if (!old) return;
  // Keep the keyboard's place: redrawing would otherwise drop the focus.
  const focused = [...old.children].indexOf(document.activeElement);
  const fresh = card(item);
  old.replaceWith(fresh);
  if (focused !== -1) fresh.children[focused]?.focus();
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
    saveListSoon();
    return true;
  } catch (err) {
    // No connection: keep the change and send it later.
    const queued = unreachable(err) && (await db.queue({ id: item.id, tag, on }).then(() => true, () => false));
    if (queued) {
      state.pending++;
      showBanner();
      return true;
    }
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
  const old = cardFor(item);
  const next = old?.nextElementSibling;
  if (clears && old?.contains(document.activeElement)) (next || old.previousElementSibling)?.querySelector('.open')?.focus();
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
    if (next?.isConnected) next.before(again);
    else grid.prepend(again);
  };
  if (!ok) return restore();
  toast('Marked as read', 'Undo', async () => { await setTag(item, 'read', false); restore(); });
}

// ---- Feeds -----------------------------------------------------------------
const feedById = (id) => state.feeds.find((f) => f.id === id);
function streamName(stream) {
  if (stream === 'reading-list') return 'every feed';
  const feed = feedById(stream);
  if (feed) return `“${shortName(feed.title)}”`;
  const cat = state.categories.find((c) => c.id === stream);
  return cat ? `the ${cat.label} category` : 'this list';
}
function unreadIn(stream) {
  if (stream === 'reading-list') return state.total;
  return (feedById(stream) || state.categories.find((c) => c.id === stream))?.unread ?? null;
}

function select(stream, scope) {
  if (state.stream === stream) return scrollTo({ top: 0, behavior: 'smooth' });
  state.stream = stream;
  state.scope = scope;
  reset();
}

function chip(stream, scope, label, count) {
  const on = stream === state.stream || (stream === state.scope && stream === scope);
  const b = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, label);
  b.dataset.stream = stream;
  b.setAttribute('aria-pressed', String(on));
  if (count) b.append(el('span', { className: 'n' }, String(count)));
  b.addEventListener('click', () => select(stream, scope));
  return b;
}

function renderFeeds() {
  const scopes = $('scopes'), feeds = $('feeds');
  const left = [scopes.scrollLeft, feeds.scrollLeft];
  // Categories only earn a row when there is more than one of them.
  const cats = state.categories.length > 1 ? state.categories : [];
  if (state.scope !== 'reading-list' && state.scope !== 'starred' && !cats.some((c) => c.id === state.scope)) state.scope = 'reading-list';
  scopes.replaceChildren(
    chip('reading-list', 'reading-list', 'All feeds', state.total),
    ...cats.map((c) => chip(c.id, c.id, c.label, c.unread)),
    chip('starred', 'starred', '★ Starred'),
  );
  // The feeds inside the chosen category, busiest first; quiet ones stay out of the way.
  const inside = state.scope === 'starred' ? [] : state.feeds
    .filter((f) => state.scope === 'reading-list' || f.category === state.scope)
    .filter((f) => !state.unread || f.unread || f.id === state.stream)
    .sort((a, b) => b.unread - a.unread || shortName(a.title).localeCompare(shortName(b.title)));
  feeds.replaceChildren(...inside.map((f) => chip(f.id, state.scope, shortName(f.title), f.unread)));
  feeds.hidden = !inside.length;
  scopes.scrollLeft = left[0];
  feeds.scrollLeft = left[1];
  $('count').textContent = state.total ? `${state.total} unread` : '';
  $('mark-all').hidden = state.stream === 'starred';
}

async function loadFeeds() {
  const data = await api('/api/feeds');
  state.total = data.total;
  state.feeds = data.feeds;
  state.categories = data.categories || [];
  prefs.set('feeds', data);
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
      const first = !state.continuation;
      const q = new URLSearchParams({ stream: state.stream, n: '30' });
      if (state.unread && state.stream !== 'starred') q.set('unread', '1');
      if (state.order === 'oldest') q.set('order', 'oldest');
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
      saveListSoon();
      if (first) prefetch(data.items);
    } catch (err) {
      if (gen !== state.gen) return;
      const usable = unreachable(err) && !state.items.size && (await showSaved(err));
      if (gen !== state.gen) return;
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      state.done = true;
      if (usable) return;
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

function remember() {
  prefs.set('stream', state.stream);
  prefs.set('scope', state.scope);
  prefs.set('unread', state.unread);
  // Keep the address in step so a reload, bookmark or shared link opens the same view.
  const q = new URLSearchParams();
  if (state.stream !== 'reading-list') q.set('s', state.stream);
  if (!state.unread) q.set('show', 'all');
  history.replaceState(null, '', q.size ? `?${q}` : location.pathname);
}

function reset() {
  state.gen++;
  prefetching++;
  clearTimeout(saveTimer);
  Object.assign(state, { continuation: null, loading: null, done: false, offline: null });
  state.items.clear();
  statusEl.textContent = '';
  showBanner();
  grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', { className: 'card skeleton' })));
  scrollTo(0, 0);
  remember();
  renderFeeds();
  loadMore();
  loadFeeds().catch((err) => {
    // With a saved list on screen the banner already says why.
    if (!unreachable(err) || !state.feeds.length) toast(`Couldn’t load your feeds: ${explain(err)}.`);
  });
}

// ---- Article ---------------------------------------------------------------
function render(item, html, leadImage) {
  const body = $('a-body');
  body.replaceChildren();
  if (item.audio) body.append(el('audio', { controls: true, preload: 'none', src: item.audio }));
  if (leadImage) body.append(el('img', { src: leadImage, alt: '', referrerPolicy: 'no-referrer' }));
  clean(new DOMParser().parseFromString(html, 'text/html').body, body);
}

// The full article text: from this device if it was saved, else from the server.
async function fullText(item) {
  if (item.full) return item.full;
  const kept = await db.getArticle(item.id).catch(() => null);
  if (kept) return (item.full = kept.full);
  item.full = await api(`/api/article?id=${encodeURIComponent(item.id)}`);
  db.putArticle(item.id, item.full).catch(() => {});
  return item.full;
}

// Show the feed's summary straight away, then swap in the full article text.
async function loadFull(item) {
  const note = $('a-note');
  const still = () => state.open === item && dialog.open;
  if (!item.url) { note.textContent = ''; return; }
  note.textContent = 'Loading full article…';
  try {
    const full = await fullText(item);
    if (!still()) return;
    render(item, full.html, full.leadImage);
    note.textContent = `${Math.max(1, Math.round(full.words / 230))} min read`;
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
  render(item, item.html);
  const link = $('a-link');
  link.hidden = !item.url;
  if (item.url) link.href = item.url;
  $('a-share').hidden = !item.url;
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

async function toggleStar(item) {
  await setTag(item, 'starred', !item.starred);
  if (state.open === item) showStar(item);
}

async function share(item) {
  try {
    if (navigator.share) return await navigator.share({ title: item.title, url: item.url });
    await navigator.clipboard.writeText(item.url);
    toast('Link copied');
  } catch (err) {
    // Closing the share sheet is not a failure.
    if (err.name !== 'AbortError') toast('Couldn’t share that link.');
  }
}

$('a-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { state.open = null; $('a-body').replaceChildren(); });
$('a-prev').addEventListener('click', () => step(-1));
$('a-next').addEventListener('click', () => step(1));
swipeable($('a-scroll'), (dx) => step(dx < 0 ? 1 : -1), { drag: false });
dialog.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || $('options').open) return;
  if (e.key === 'ArrowRight' || e.key === 'j') step(1);
  else if (e.key === 'ArrowLeft' || e.key === 'k') step(-1);
  else if (e.key === 's') toggleStar(state.open);
});
$('a-star').addEventListener('click', () => toggleStar(state.open));
$('a-share').addEventListener('click', () => share(state.open));
$('a-unread').addEventListener('click', () => { setTag(state.open, 'read', false); dialog.close(); });

// ---- Options ---------------------------------------------------------------
const DEFAULTS = { compact: false, order: 'newest', theme: 'auto', font: 'sans', size: 0, offlineArticles: true };
const THEME_COLOURS = { light: '#f4f2ee', dark: '#151413' };

function applyOptions() {
  const get = (key) => prefs.get(key, DEFAULTS[key]);
  document.body.classList.toggle('compact', get('compact'));
  dialog.dataset.size = String(get('size'));
  dialog.dataset.font = get('font');
  const theme = get('theme');
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // The browser's own bars follow the page: one colour when chosen, the system's otherwise.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const system = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = THEME_COLOURS[theme === 'auto' ? system : theme];
  }
  for (const group of document.querySelectorAll('.seg[data-pref]')) {
    for (const b of group.children) {
      const on = JSON.parse(b.dataset.v) === get(group.dataset.pref);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  if (state.order !== get('order')) {
    state.order = get('order');
    reset();
  }
}
for (const group of document.querySelectorAll('.seg[data-pref]')) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.set(group.dataset.pref, JSON.parse(b.dataset.v));
    applyOptions();
  });
}
const openOptions = () => $('options').showModal();
$('options-open').addEventListener('click', openOptions);
$('a-options').addEventListener('click', openOptions);
$('o-close').addEventListener('click', () => $('options').close());
$('options').addEventListener('click', (e) => { if (e.target === $('options')) $('options').close(); });

// ---- Header ----------------------------------------------------------------
function showFilter() {
  for (const [id, on] of [['show-unread', state.unread], ['show-all', !state.unread]]) {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-pressed', String(on));
  }
}
for (const [id, unread] of [['show-unread', true], ['show-all', false]]) {
  $(id).addEventListener('click', () => {
    if (state.unread === unread) return;
    state.unread = unread;
    showFilter();
    reset();
  });
}
$('refresh').addEventListener('click', reset);

$('mark-all').addEventListener('click', () => {
  const n = unreadIn(state.stream);
  if (n === 0) return toast('Nothing unread here.');
  $('c-text').textContent = `Mark unread items in ${streamName(state.stream)} as read? This includes items you haven’t scrolled to.`;
  $('c-all').textContent = n ? `All ${n} of them` : 'All of them';
  $('confirm').querySelector('input[value="all"]').checked = true;
  $('confirm').showModal();
});
$('c-cancel').addEventListener('click', () => $('confirm').close());
$('c-ok').addEventListener('click', async () => {
  $('confirm').close();
  const age = $('confirm').querySelector('input[name="age"]:checked').value;
  // Only up to now (or the chosen age), so anything fetched after this stays unread.
  const before = Date.now() - (age === 'all' ? 0 : Number(age) * 86400000);
  try {
    const { ids } = await api('/api/mark-all-read', { stream: state.stream, before });
    reset();
    if (!ids) return toast('Marked as read');
    if (!ids.length) return toast('Nothing that old was unread.');
    toast(`Marked ${plural(ids.length, 'item')} as read`, 'Undo', async () => {
      try {
        for (let i = 0; i < ids.length; i += 500) await api('/api/tag', { ids: ids.slice(i, i + 500), tag: 'read', on: false });
      } catch (err) {
        toast(`Couldn’t undo all of that: ${explain(err)}.`);
      }
      reset();
    }, 12000);
  } catch (err) {
    toast(`Couldn’t mark them as read: ${explain(err)}.`);
  }
});

// ---- Keyboard --------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
  if (e.key === '?') return openOptions();
  if (e.key === 'r') return reset();
  const cards = [...grid.querySelectorAll('.card[data-id]')];
  const at = cards.indexOf(document.activeElement?.closest('.card'));
  if (e.key === 'j' || e.key === 'k') {
    const next = cards[at === -1 ? 0 : Math.min(cards.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)))];
    next?.querySelector('.open').focus();
    next?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const item = at === -1 ? null : state.items.get(cards[at].dataset.id);
  if (!item) return;
  if (e.key === 'm') dismiss(item);
  else if (e.key === 's') setTag(item, 'starred', !item.starred);
});

// ---- Keeping up to date ----------------------------------------------------
new IntersectionObserver((entries) => { if (entries[0].isIntersecting) loadMore(); }, { rootMargin: '800px' }).observe($('sentinel'));

// Look for new items without disturbing the reader: reload if they are at the
// top of the list, otherwise keep their place and offer the new items.
async function checkForNew() {
  if (document.hidden || !navigator.onLine) return;
  if (state.offline || state.pending) return sync();
  const before = state.total;
  const now = await loadFeeds().catch(() => null);
  if (now === null || before === null || now <= before) return;
  if (!document.querySelector('dialog[open]') && scrollY < 200) return reset();
  toast(plural(now - before, 'new item'), 'Show', () => { dialog.close(); reset(); });
}
setInterval(checkForNew, 3 * 60 * 1000);

// An installed app can sit in the background for hours.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (state.offline || state.pending) return sync();
  if (!hiddenAt || Date.now() - hiddenAt < 5 * 60 * 1000) return;
  if (!dialog.open && scrollY < 200) return reset();
  checkForNew();
});
addEventListener('online', sync);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  let told = false;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'updated' || told) return;
    told = true;
    toast('A new version of Reader is ready', 'Reload', () => location.reload(), 15000);
  });
}

// ---- Start -----------------------------------------------------------------
showFilter();
applyOptions();
reset();
db.pruneArticles().catch(() => {});
db.outbox().then(async (entries) => {
  state.pending = entries.length;
  if (entries.length) sync();
}, () => {});
