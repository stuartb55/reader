// Card reader for FreshRSS. Holds the API credentials server-side and exposes a
// small JSON API to the page in ./public. No dependencies.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.FRESHRSS_URL || 'http://freshrss').replace(/\/$/, '') + '/api/greader.php';
const USER = process.env.FRESHRSS_USER;
const PASS = process.env.FRESHRSS_API_PASSWORD;
const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';

if (!USER || !PASS) {
  console.error('FRESHRSS_USER and FRESHRSS_API_PASSWORD must be set');
  process.exit(1);
}

let auth = null;

async function login() {
  const res = await fetch(`${BASE}/accounts/ClientLogin`, {
    method: 'POST',
    body: new URLSearchParams({ Email: USER, Passwd: PASS }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const m = text.match(/^Auth=(.+)$/m);
  if (!res.ok || !m) throw new Error(`FreshRSS login failed (${res.status})`);
  auth = m[1].trim();
}

async function greader(pathname, { params, body } = {}, retry = true) {
  if (!auth) await login();
  const url = `${BASE}/reader/api/0/${pathname}${params ? `?${params}` : ''}`;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `GoogleLogin auth=${auth}` },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && retry) {
    auth = null;
    return greader(pathname, { params, body }, false);
  }
  if (!res.ok) throw new Error(`FreshRSS ${pathname} returned ${res.status}`);
  return res;
}

async function write(pathname, fields) {
  const token = (await (await greader('token')).text()).trim();
  const body = new URLSearchParams(fields);
  body.append('T', token);
  await greader(pathname, { body });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function httpsOnly(u) {
  if (!u) return null;
  u = decode(u.trim());
  if (u.startsWith('//')) u = 'https:' + u;
  return /^https?:\/\//i.test(u) ? u : null;
}

function toCard(item) {
  const html = item.summary?.content || item.content?.content || '';
  const text = decode(html.replace(/<(script|style|figure)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const enclosure = (item.enclosure || []).find((e) => (e.type || '').startsWith('image/'));
  const inline = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const cats = item.categories || [];
  return {
    id: item.id,
    title: decode(item.title || '(untitled)'),
    url: httpsOnly(item.canonical?.[0]?.href || item.alternate?.[0]?.href),
    feed: decode(item.origin?.title || ''),
    feedId: item.origin?.streamId || '',
    author: item.author || '',
    published: item.published || 0,
    image: httpsOnly(enclosure?.href) || httpsOnly(inline?.[1]),
    snippet: text.length > 260 ? text.slice(0, 260).replace(/\s+\S*$/, '') + '…' : text,
    html,
    read: cats.includes(READ),
    starred: cats.includes(STARRED),
  };
}

const STREAM = /^(reading-list|starred|feed\/\d+|user\/-\/label\/[^?#]{1,200})$/;
function streamPath(s) {
  if (!STREAM.test(s)) throw Object.assign(new Error('bad stream'), { status: 400 });
  if (s === 'reading-list') return 'reading-list';
  if (s === 'starred') return STARRED;
  return s.split('/').map(encodeURIComponent).join('/');
}

const routes = {
  'GET /api/feeds': async () => {
    const [subs, counts] = await Promise.all([
      greader('subscription/list', { params: 'output=json' }).then((r) => r.json()),
      greader('unread-count', { params: 'output=json' }).then((r) => r.json()),
    ]);
    const unread = Object.fromEntries((counts.unreadcounts || []).map((c) => [c.id, Number(c.count) || 0]));
    return {
      total: unread['user/-/state/com.google/reading-list'] || 0,
      feeds: (subs.subscriptions || [])
        .map((s) => ({
          id: s.id,
          title: decode(s.title || ''),
          category: s.categories?.[0]?.label || '',
          unread: unread[s.id] || 0,
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  },
  'GET /api/items': async (q) => {
    const params = new URLSearchParams({ output: 'json', n: String(Math.min(Number(q.get('n')) || 30, 100)) });
    if (q.get('unread') === '1') params.set('xt', READ);
    if (q.get('c')) params.set('c', q.get('c'));
    const data = await (
      await greader(`stream/contents/${streamPath(q.get('stream') || 'reading-list')}`, { params })
    ).json();
    return { items: (data.items || []).map(toCard), continuation: data.continuation || null };
  },
  'POST /api/tag': async (_q, body) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((i) => typeof i === 'string').slice(0, 500) : [];
    const tag = { read: READ, starred: STARRED }[body.tag];
    if (!ids.length || !tag) throw Object.assign(new Error('bad request'), { status: 400 });
    const fields = ids.map((i) => ['i', i]);
    fields.push([body.on ? 'a' : 'r', tag]);
    await write('edit-tag', fields);
    return { ok: true };
  },
  'POST /api/mark-all-read': async (_q, body) => {
    const s = String(body.stream || 'reading-list');
    if (!STREAM.test(s) || s === 'starred') throw Object.assign(new Error('bad stream'), { status: 400 });
    const fields = [['s', s === 'reading-list' ? 'user/-/state/com.google/reading-list' : s]];
    if (Number(body.before) > 0) fields.push(['ts', String(Math.floor(Number(body.before)) * 1000)]);
    await write('mark-all-as-read', fields);
    return { ok: true };
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: http: data:; media-src https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) reject(Object.assign(new Error('too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...HEADERS, ...extra });
      res.end(body);
    };
    try {
      if (url.pathname === '/healthz') return send(200, 'text/plain', 'ok');
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        // Writes must come from the page itself (JSON body), not a cross-site form post.
        if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(415, 'application/json', '{"error":"json only"}');
        }
        const body = req.method === 'POST' ? await readBody(req) : {};
        return send(200, 'application/json', JSON.stringify(await route(url.searchParams, body)), {
          'Cache-Control': 'no-store',
        });
      }
      if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
      const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(404, 'text/plain', 'not found');
      }
      send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file), {
        'Cache-Control': 'no-cache',
      });
    } catch (err) {
      console.error(`${req.method} ${url.pathname}: ${err.message}`);
      send(err.status || 502, 'application/json', JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, () => console.log(`freshrss-reader listening on ${PORT}, upstream ${BASE}`));
