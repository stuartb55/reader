// Card reader for FreshRSS. Holds the API credentials server-side and exposes a
// small JSON API to the page in ./public.
'use strict';
const http = require('node:http');
const path = require('node:path');
const { createClient } = require('./lib/freshrss');
const { createArticles } = require('./lib/articles');
const { createHandler } = require('./lib/app');
const { fetchPage, extract } = require('./lib/extract');

const { FRESHRSS_URL = 'http://freshrss', FRESHRSS_USER, FRESHRSS_API_PASSWORD, CACHE_DIR, ALLOW_PRIVATE_FETCH } = process.env;
const PORT = Number(process.env.PORT || 8080);

if (!FRESHRSS_USER || !FRESHRSS_API_PASSWORD) {
  console.error('FRESHRSS_USER and FRESHRSS_API_PASSWORD must be set');
  process.exit(1);
}

const client = createClient({ url: FRESHRSS_URL, user: FRESHRSS_USER, pass: FRESHRSS_API_PASSWORD });
const articles = createArticles({
  client,
  extract,
  fetchPage: (url) => fetchPage(url, { allowPrivate: ALLOW_PRIVATE_FETCH === '1' }),
  cacheDir: CACHE_DIR || null,
});
const server = http.createServer(createHandler({ client, articles, publicDir: path.join(__dirname, 'public') }));

server.listen(PORT, () => {
  console.log(`freshrss-reader listening on ${PORT}, upstream ${client.base}`);
  console.log(`article cache: ${articles.persistent ? CACHE_DIR : 'memory only'}`);
  // Say so in the log straight away if FreshRSS or the credentials are wrong.
  client.check().then(
    () => console.log('FreshRSS login ok'),
    (err) => console.error(`FreshRSS check failed: ${err.message}`),
  );
});

// As process 1 in a container Node ignores SIGTERM unless it is handled, which
// makes every stop wait for the kill timeout.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
