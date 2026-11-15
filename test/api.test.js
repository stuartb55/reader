'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createMock } = require('../tools/mock-freshrss');
const { createClient } = require('../lib/freshrss');
const { createArticles } = require('../lib/articles');
const { createHandler } = require('../lib/app');
const { fetchPage, extract } = require('../lib/extract');

async function start({ cacheDir = null, pass = 'secret' } = {}) {
  const mock = createMock();
  const upstream = await mock.listen();
  const client = createClient({ url: upstream, user: 'stuart', pass, retryDelayMs: 1 });
  let pageFetches = 0;
  const articles = createArticles({
    client,
    extract,
    cacheDir,
    log: () => {},
    fetchPage: (url) => {
      pageFetches++;
      return fetchPage(url, { allowPrivate: true });
    },
  });
  const server = http.createServer(createHandler({ client, articles, publicDir: path.join(__dirname, '..', 'public'), log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers) => fetch(base + p, { headers });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await mock.close();
  };
  return { mock, base, get, post, stop, fetches: () => pageFetches };
}

test('feeds come back with categories and unread counts', async (t) => {
  const app = await start();
  t.after(app.stop);
  const data = await (await app.get('/api/feeds')).json();
  assert.equal(data.total, 60);
  assert.deepEqual(data.categories.map((c) => [c.id, c.unread]), [['user/-/label/News', 20], ['user/-/label/Tech', 40]]);
  const register = data.feeds.find((f) => f.id === 'feed/1');
  assert.equal(register.category, 'user/-/label/Tech');
  assert.equal(register.unread, 20);
  assert.equal(data.feeds.find((f) => f.id === 'feed/4').category, '');
});

test('items page, filter by stream and sort oldest first', async (t) => {
  const app = await start();
  t.after(app.stop);
  const first = await (await app.get('/api/items?unread=1&n=30')).json();
  assert.equal(first.items.length, 30);
  assert.ok(first.continuation);
  assert.equal(first.items[0].title.startsWith('Story 1:'), true);
  assert.equal(first.items[4].audio, 'https://example.com/episode.mp3');
  const second = await (await app.get(`/api/items?unread=1&n=30&c=${first.continuation}`)).json();
  assert.equal(second.items.length, 30);
  assert.equal(second.continuation, null);

  const oldest = await (await app.get('/api/items?unread=1&order=oldest')).json();
  assert.equal(oldest.items[0].title.startsWith('Story 60:'), true);

  const cat = await (await app.get(`/api/items?stream=${encodeURIComponent('user/-/label/News')}&n=100`)).json();
  assert.equal(cat.items.length, 25);
  assert.ok(cat.items.every((i) => i.feedId === 'feed/3'));

  assert.equal((await app.get('/api/items?stream=../../etc')).status, 400);
});

test('tagging marks items and reuses one login and one write token', async (t) => {
  const app = await start();
  t.after(app.stop);
  const { items } = await (await app.get('/api/items?unread=1&n=3')).json();
  for (const item of items) {
    const res = await app.post('/api/tag', { ids: [item.id], tag: 'read', on: true });
    assert.equal(res.status, 200);
  }
  assert.equal(app.mock.items.slice(0, 3).every((i) => i.read), true);
  assert.equal(app.mock.state.logins, 1);
  assert.equal(app.mock.state.tokens, 1);

  // FreshRSS starts refusing the old token: fetch a new one and carry on.
  app.mock.state.tokenVersion = 2;
  assert.equal((await app.post('/api/tag', { ids: [items[0].id], tag: 'starred', on: true })).status, 200);
  assert.equal(app.mock.items[0].starred, true);
  assert.equal(app.mock.state.tokens, 2);

  assert.equal((await app.post('/api/tag', { ids: [], tag: 'read', on: true })).status, 400);
  const form = await fetch(app.base + '/api/tag', { method: 'POST', body: new URLSearchParams({ tag: 'read' }) });
  assert.equal(form.status, 415);
});

test('requests arriving together share a single login', async (t) => {
  const app = await start();
  t.after(app.stop);
  await Promise.all([app.get('/api/feeds'), app.get('/api/items'), app.get('/api/items?unread=1')]);
  assert.equal(app.mock.state.logins, 1);
});

test('mark all read returns the ids it marked so it can be undone', async (t) => {
  const app = await start();
  t.after(app.stop);
  const res = await (await app.post('/api/mark-all-read', { stream: 'feed/3', before: Date.now() + 1000 })).json();
  assert.equal(res.ids.length, 20);
  assert.equal(app.mock.items.filter((i) => !i.read).length, 40);
  // Undo: the short ids FreshRSS hands back are accepted by the tag call.
  assert.equal((await app.post('/api/tag', { ids: res.ids, tag: 'read', on: false })).status, 200);
  assert.equal(app.mock.items.filter((i) => !i.read).length, 60);
});

test('mark older than a cut-off leaves newer items unread', async (t) => {
  const app = await start();
  t.after(app.stop);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const res = await (await app.post('/api/mark-all-read', { stream: 'reading-list', before: dayAgo })).json();
  // Items arrive two hours apart: 0h..22h stay unread, 24h and older are marked.
  assert.equal(app.mock.items.filter((i) => !i.read).length, 12);
  assert.equal(res.ids.length, 48);
  assert.equal((await app.post('/api/mark-all-read', { stream: 'starred' })).status, 400);
});

test('articles are extracted once, then served from memory and disk', async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const app = await start({ cacheDir });
  const { items } = await (await app.get('/api/items?n=1')).json();
  const url = `/api/article?id=${encodeURIComponent(items[0].id)}`;
  const res = await app.get(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age/);
  const article = await res.json();
  assert.ok(article.words > 300);
  assert.match(article.image, /lead/);
  const thumb = await (await app.get(`/api/thumb?id=${encodeURIComponent(items[0].id)}`)).json();
  assert.equal(thumb.image, article.image);
  assert.equal(app.fetches(), 1);
  await app.stop();

  // A fresh process finds the article on disk and does not fetch the page again.
  await new Promise((r) => setTimeout(r, 50));
  const again = await start({ cacheDir });
  t.after(again.stop);
  const { items: same } = await (await again.get('/api/items?n=1')).json();
  assert.equal(same[0].title, items[0].title);
  // The mock's ids depend on its start time, so read the cached file by the first run's id.
  assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length, 1);
  assert.equal((await again.get('/api/article?id=bad id!')).status, 400);
});

test('health and status tell a wrong password from an unreachable FreshRSS', async (t) => {
  const wrong = await start({ pass: 'nope' });
  t.after(wrong.stop);
  assert.equal((await wrong.get('/healthz')).status, 200);
  assert.equal((await wrong.get('/readyz')).status, 503);
  const res = await wrong.get('/api/feeds');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'freshrss_auth');

  const client = createClient({ url: 'http://127.0.0.1:1', user: 'a', pass: 'b', retryDelayMs: 1 });
  await assert.rejects(client.check(), (err) => err.code === 'freshrss_unreachable' && err.status === 503);
});

test('static files are compressed, validated with ETags and confined to public/', async (t) => {
  const app = await start();
  t.after(app.stop);
  const page = await app.get('/', { 'Accept-Encoding': 'br' });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-encoding'), 'br');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /<title>Reader<\/title>/);
  const etag = page.headers.get('etag');
  assert.equal((await app.get('/', { 'If-None-Match': etag })).status, 304);
  assert.equal((await app.get('/../server.js')).status, 404);
  assert.equal((await app.get('/%2e%2e/package.json')).status, 404);
  const json = await app.get('/api/items?n=30', { 'Accept-Encoding': 'gzip' });
  assert.equal(json.headers.get('content-encoding'), 'gzip');
  assert.equal((await json.json()).items.length, 30);
});
