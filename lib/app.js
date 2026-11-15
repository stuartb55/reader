// The HTTP handler: the page's files plus a small JSON API that translates to
// FreshRSS's Google Reader API.
'use strict';
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { READ, STARRED, READING_LIST, decode, toCard } = require('./cards');
const { loadStatic, encodingFor } = require('./static');

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: http: data:; media-src https:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const ITEM_ID = /^[\w:.,/-]{1,120}$/;
const STREAM = /^(reading-list|starred|feed\/\d+|user\/-\/label\/[^?#]{1,200})$/;
// Undo for "mark all read" is offered up to this many items.
const UNDO_LIMIT = 5000;

function checkStream(s) {
  if (!STREAM.test(s)) throw fail(400, 'bad stream');
  return s;
}
function streamId(s) {
  if (s === 'reading-list') return READING_LIST;
  if (s === 'starred') return STARRED;
  return s;
}
const streamPath = (s) => (s === 'reading-list' ? s : streamId(s).split('/').map(encodeURIComponent).join('/'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) reject(fail(413, 'too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(fail(400, 'bad json'));
      }
    });
    req.on('error', reject);
  });
}

function createHandler({ client, articles, publicDir, log = console.error }) {
  const files = loadStatic(publicDir);

  // The ids of everything unread in a stream that arrived before a moment in
  // time, so "mark all read" can be undone. FreshRSS item ids are the time the
  // item arrived, in microseconds, which is also how it applies the cut-off.
  async function unreadIds(stream, beforeMs) {
    const params = new URLSearchParams({ output: 'json', s: streamId(stream), xt: READ, n: String(UNDO_LIMIT + 1) });
    const data = await client.json('stream/items/ids', { params });
    const refs = data.itemRefs || [];
    if (refs.length > UNDO_LIMIT) return null;
    const limit = beforeMs ? BigInt(Math.floor(beforeMs)) * 1000n : null;
    return refs
      .map((r) => String(r.id))
      .filter((id) => /^\d{1,20}$/.test(id) && (limit === null || BigInt(id) <= limit));
  }

  const routes = {
    'GET /api/status': async () => {
      await client.check();
      return { ok: true };
    },
    'GET /api/feeds': async () => {
      const [subs, counts] = await Promise.all([
        client.json('subscription/list', { params: 'output=json' }),
        client.json('unread-count', { params: 'output=json' }),
      ]);
      const unread = Object.fromEntries((counts.unreadcounts || []).map((c) => [c.id, Number(c.count) || 0]));
      const categories = new Map();
      for (const s of subs.subscriptions || []) {
        for (const c of s.categories || []) if (c.id) categories.set(c.id, decode(c.label || ''));
      }
      return {
        total: unread[READING_LIST] || 0,
        categories: [...categories]
          .map(([id, label]) => ({ id, label, unread: unread[id] || 0 }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        feeds: (subs.subscriptions || [])
          .map((s) => ({
            id: s.id,
            title: decode(s.title || ''),
            category: s.categories?.[0]?.id || '',
            unread: unread[s.id] || 0,
          }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    },
    'GET /api/items': async (q) => {
      const params = new URLSearchParams({ output: 'json', n: String(Math.min(Number(q.get('n')) || 30, 100)) });
      if (q.get('unread') === '1') params.set('xt', READ);
      if (q.get('order') === 'oldest') params.set('r', 'o');
      if (q.get('c')) params.set('c', q.get('c'));
      const stream = checkStream(q.get('stream') || 'reading-list');
      const data = await client.json(`stream/contents/${streamPath(stream)}`, { params });
      return { items: (data.items || []).map(toCard), continuation: data.continuation || null };
    },
    'GET /api/article': async (q) => {
      const id = q.get('id') || '';
      if (!ITEM_ID.test(id)) throw fail(400, 'bad id');
      return articles.get(id);
    },
    // A sharper card image, for feeds that only supply a small thumbnail.
    'GET /api/thumb': async (q) => {
      const id = q.get('id') || '';
      if (!ITEM_ID.test(id)) throw fail(400, 'bad id');
      return { image: await articles.get(id).then((a) => a.image, (err) => err.image || null) };
    },
    'POST /api/tag': async (_q, body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string' && ITEM_ID.test(i)).slice(0, 1000) : [];
      const tag = { read: READ, starred: STARRED }[body.tag];
      if (!ids.length || !tag) throw fail(400, 'bad request');
      const fields = ids.map((i) => ['i', i]);
      fields.push([body.on ? 'a' : 'r', tag]);
      await client.write('edit-tag', fields);
      return { ok: true };
    },
    'POST /api/mark-all-read': async (_q, body) => {
      const stream = checkStream(String(body.stream || 'reading-list'));
      if (stream === 'starred') throw fail(400, 'bad stream');
      const before = Number(body.before) > 0 ? Math.floor(Number(body.before)) : 0;
      // Collected first, and never allowed to stop the marking itself.
      const ids = await unreadIds(stream, before).catch((err) => {
        log(`mark-all-read: no undo available (${err.message})`);
        return null;
      });
      const fields = [['s', streamId(stream)]];
      if (before) fields.push(['ts', String(before * 1000)]);
      await client.write('mark-all-as-read', fields);
      return { ok: true, ids };
    },
  };
  // Article text does not change, so the browser may keep it.
  const cacheable = (pathname, data) => pathname === '/api/article' || (pathname === '/api/thumb' && Boolean(data.image));

  async function sendJson(req, res, status, data, cache = 'no-store') {
    let body = Buffer.from(JSON.stringify(data));
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': cache, Vary: 'Accept-Encoding', ...HEADERS };
    const encoding = body.length > 1024 ? encodingFor(req) : null;
    if (encoding === 'br') {
      body = await brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    } else if (encoding === 'gzip') {
      body = await gzip(body);
    }
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendFile(req, res, file) {
    const headers = { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ETag: file.etag, Vary: 'Accept-Encoding', ...HEADERS };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const encoding = file.br ? encodingFor(req) : null;
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : encoding ? file[encoding] : file.body);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const plain = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS });
      res.end(text);
    };
    try {
      // Liveness: the process is up. Readiness: FreshRSS answers and accepts the login.
      if (url.pathname === '/healthz') return plain(200, 'ok');
      if (url.pathname === '/readyz') {
        return await client.check().then(
          () => plain(200, 'ok'),
          (err) => plain(503, err.message),
        );
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        // Writes must come from the page itself (JSON body), not a cross-site form post.
        if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
          return await sendJson(req, res, 415, { error: 'json only' });
        }
        const body = req.method === 'POST' ? await readBody(req) : {};
        const data = await route(url.searchParams, body);
        return await sendJson(req, res, 200, data, cacheable(url.pathname, data) ? 'private, max-age=86400' : 'no-store');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'method not allowed');
      const file = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!file) return plain(404, 'not found');
      sendFile(req, res, file);
    } catch (err) {
      log(`${req.method} ${url.pathname}: ${err.message}`);
      if (res.headersSent) return res.destroy();
      await sendJson(req, res, err.status || 502, { error: err.message, code: err.code || 'error' }).catch(() => res.destroy());
    }
  };
}

module.exports = { createHandler, HEADERS };
