// A stand-in for FreshRSS's Google Reader API, for the tests and for running
// the app locally without a FreshRSS: `node tools/mock-freshrss.js`.
'use strict';
const http = require('node:http');

const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';
const LONG = 'tag:google.com,2005:reader/item/';
const longId = (n) => LONG + BigInt(n).toString(16).padStart(16, '0');
const shortId = (id) => (id.startsWith(LONG) ? BigInt('0x' + id.slice(LONG.length)).toString() : id);

const WORDS = 'the quick brown fox jumps over a lazy dog while reading feeds on a quiet sunday afternoon with tea and biscuits'.split(' ');
const prose = (seed, n) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');

function createMock({ user = 'stuart', pass = 'secret', itemCount = 75 } = {}) {
  const feeds = [
    { id: 'feed/1', title: 'The Register: Biting the hand', category: 'Tech' },
    { id: 'feed/2', title: 'Ars Technica', category: 'Tech' },
    { id: 'feed/3', title: 'News | BBC', category: 'News' },
    { id: 'feed/4', title: 'Quiet Blog', category: '' },
  ];
  const now = Date.now();
  const items = Array.from({ length: itemCount }, (_, i) => {
    const feed = feeds[i % 3];
    // Ids are arrival times in microseconds, newest first, one every two hours.
    const at = now - i * 2 * 3600 * 1000;
    return {
      num: String(BigInt(at) * 1000n),
      at,
      feed,
      title: `Story ${i + 1}: ${prose(i, 6)}`,
      read: i >= 60,
      starred: i === 2,
      audio: i === 4,
    };
  });
  const state = { logins: 0, tokens: 0, requests: [], failLoginWith: 0, tokenVersion: 1, port: 0 };
  const origin = () => `http://127.0.0.1:${state.port}`;

  const toApi = (it) => ({
    id: longId(it.num),
    title: it.title,
    published: Math.floor(it.at / 1000),
    canonical: [{ href: `${origin()}/site/${it.num}` }],
    origin: { streamId: it.feed.id, title: it.feed.title },
    author: 'A. Writer',
    summary: { content: `<p>${prose(Number(BigInt(it.num) % 97n) + 3, 40)}</p><img src="https://example.com/img/${it.num}.jpg">` },
    enclosure: it.audio ? [{ href: 'https://example.com/episode.mp3', type: 'audio/mpeg' }] : [],
    categories: ['user/-/state/com.google/reading-list', ...(it.read ? [READ] : []), ...(it.starred ? [STARRED] : [])],
  });

  function select(stream, q) {
    let list = items.filter((it) => {
      if (stream === STARRED) return it.starred;
      if (stream.startsWith('feed/')) return it.feed.id === stream;
      if (stream.startsWith('user/-/label/')) return it.feed.category === stream.slice('user/-/label/'.length);
      return true;
    });
    if (q.get('xt') === READ) list = list.filter((it) => !it.read);
    if (q.get('r') === 'o') list = [...list].reverse();
    return list;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      state.requests.push(`${req.method} ${url.pathname}`);

      const site = /^\/site\/(\d+)$/.exec(url.pathname);
      if (site) {
        const it = items.find((x) => x.num === site[1]);
        if (!it) return send(404, 'nope', 'text/plain');
        const body = Array.from({ length: 8 }, (_, i) => `<p>${prose(i + 1, 60)}.</p>`).join('');
        return send(
          200,
          `<!doctype html><html><head><title>${it.title}</title><meta property="og:image" content="https://example.com/lead/${it.num}.jpg"></head><body><article><h1>${it.title}</h1>${body}</article></body></html>`,
          'text/html; charset=utf-8',
        );
      }

      if (url.pathname === '/api/greader.php/accounts/ClientLogin') {
        state.logins++;
        if (state.failLoginWith) return send(state.failLoginWith, 'Unauthorized', 'text/plain');
        if (form.get('Email') !== user || form.get('Passwd') !== pass) return send(401, 'Unauthorized', 'text/plain');
        return send(200, `SID=x\nLSID=null\nAuth=${user}/abc123\n`, 'text/plain');
      }
      const m = /^\/api\/greader\.php\/reader\/api\/0\/(.+)$/.exec(url.pathname);
      if (!m) return send(404, 'not found', 'text/plain');
      if (req.headers.authorization !== `GoogleLogin auth=${user}/abc123`) return send(401, 'Unauthorized', 'text/plain');
      const path = decodeURIComponent(m[1]);
      const q = url.searchParams;

      if (path === 'token') {
        state.tokens++;
        return send(200, `token-${state.tokenVersion}\n`, 'text/plain');
      }
      if (path === 'subscription/list') {
        return send(200, {
          subscriptions: feeds.map((f) => ({
            id: f.id,
            title: f.title,
            categories: f.category ? [{ id: `user/-/label/${f.category}`, label: f.category }] : [],
          })),
        });
      }
      if (path === 'unread-count') {
        const count = (pred) => items.filter((it) => !it.read && pred(it)).length;
        const cats = [...new Set(feeds.map((f) => f.category).filter(Boolean))];
        return send(200, {
          unreadcounts: [
            { id: 'user/-/state/com.google/reading-list', count: count(() => true) },
            ...feeds.map((f) => ({ id: f.id, count: count((it) => it.feed === f) })),
            ...cats.map((c) => ({ id: `user/-/label/${c}`, count: count((it) => it.feed.category === c) })),
          ],
        });
      }
      if (path.startsWith('stream/contents/')) {
        const list = select(path.slice('stream/contents/'.length), q);
        const n = Number(q.get('n')) || 20;
        const start = Number(q.get('c')) || 0;
        const page = list.slice(start, start + n);
        return send(200, { items: page.map(toApi), ...(start + n < list.length ? { continuation: String(start + n) } : {}) });
      }
      if (path === 'stream/items/ids') {
        const list = select(q.get('s') || '', q).slice(0, Number(q.get('n')) || 20);
        return send(200, { itemRefs: list.map((it) => ({ id: it.num })) });
      }
      if (path === 'stream/items/contents') {
        const wanted = form.getAll('i').map(shortId);
        return send(200, { items: items.filter((it) => wanted.includes(it.num)).map(toApi) });
      }
      if (path === 'edit-tag' || path === 'mark-all-as-read') {
        if (form.get('T') !== `token-${state.tokenVersion}`) return send(401, 'bad token', 'text/plain');
        if (path === 'edit-tag') {
          const wanted = form.getAll('i').map(shortId);
          const tag = form.get('a') || form.get('r');
          const key = tag === READ ? 'read' : tag === STARRED ? 'starred' : null;
          if (!key) return send(400, 'bad tag', 'text/plain');
          for (const it of items) if (wanted.includes(it.num)) it[key] = form.has('a');
        } else {
          const ts = form.get('ts');
          for (const it of select(form.get('s') || '', new URLSearchParams())) {
            if (!ts || BigInt(it.num) <= BigInt(ts)) it.read = true;
          }
        }
        return send(200, 'OK', 'text/plain');
      }
      send(404, 'not found', 'text/plain');
    });
  });

  return {
    items,
    feeds,
    state,
    longId,
    listen: (port = 0) =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          state.port = server.address().port;
          resolve(origin());
        });
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createMock };

if (require.main === module) {
  createMock()
    .listen(Number(process.env.MOCK_PORT || 8081))
    .then((url) => console.log(`mock FreshRSS on ${url} (user stuart, API password secret)`));
}
