# Reader

A card-view reader for [FreshRSS](https://github.com/FreshRSS/FreshRSS). A small Node server holds the FreshRSS API credentials and serves a single page that lists items as cards
(or a compact headline list), lets you tick or swipe them away as read,
opens them in a reading panel with the full article text fetched from the source site, and syncs read and starred state back to FreshRSS.

The page is an installable web app (manifest, icons and a service worker). It opens from a saved
copy of itself, keeps the last lists and article text on the device, and queues read and star
changes made without a connection until FreshRSS can be reached again. Installing needs HTTPS.

## What it does

- Feeds grouped by FreshRSS category, with unread counts; quiet feeds stay out of the way.
- Cards or a compact list, newest or oldest first. The view you were in is restored on the next launch.
- Pull down at the top of the list to refresh it.
- Tick or swipe to mark read, with undo. Optionally, items are marked read as they scroll past (Options, off by default). Star from a card or the article. Share an article's link.
- Mark all read for everything, a category or a feed, optionally only items that arrived over a
  day or a week ago, with undo.
- Full article text, a choice of font, text size and light or dark theme. Audio enclosures play in the article.
- Keyboard: `j` `k` move, `Enter` open, `m` mark read, `s` star, `r` refresh, `?` options.

## Configuration

| Variable | Meaning |
|---|---|
| `FRESHRSS_URL` | Base URL of FreshRSS as seen from this container. Default `http://freshrss`. |
| `FRESHRSS_USER` | FreshRSS username. |
| `FRESHRSS_API_PASSWORD` | That user's API password (FreshRSS: Profile, API management). API access must be enabled under Authentication. |
| `PORT` | Listen port. Default `8080`. |
| `CACHE_DIR` | Where extracted articles are kept between restarts. The image sets `/cache`, a volume. Unset or unwritable means memory only. |
| `ALLOW_PRIVATE_FETCH` | Set to `1` to let the article fetcher follow links to private network addresses. Off by default. |

The app has no login of its own: anyone who can reach it reads and marks items as the configured
user. Keep it on a private network.

## Run

Each push to `main` that passes the tests publishes `ghcr.io/stuartb55/reader:latest`, plus a tag
for the commit. A `v1.2.3` git tag also publishes `:1.2.3`.

```yaml
  freshrss-reader:
    image: ghcr.io/stuartb55/reader:latest
    restart: unless-stopped
    environment:
      - FRESHRSS_URL=http://freshrss
      - FRESHRSS_USER=stuart
      - FRESHRSS_API_PASSWORD=${FRESHRSS_API_PASSWORD:?Set FRESHRSS_API_PASSWORD in .env}
    volumes:
      - reader-cache:/cache
    read_only: true
```

To update: `docker compose pull freshrss-reader && docker compose up -d freshrss-reader`.

`/healthz` says the process is up. `/readyz` also checks that FreshRSS answers and accepts the
credentials, and the same check is logged at startup.

## Develop

```sh
npm ci
npm run mock    # a stand-in FreshRSS on :8081 (user stuart, API password secret)
FRESHRSS_URL=http://127.0.0.1:8081 FRESHRSS_USER=stuart FRESHRSS_API_PASSWORD=secret ALLOW_PRIVATE_FETCH=1 npm start
npm test        # the API against the mock, plus unit tests
npm run lint
```

## Layout

- `server.js`: reads the environment, starts the server, shuts down cleanly on SIGTERM.
- `lib/app.js`: the page's files plus `/api/feeds`, `/api/items`, `/api/article`, `/api/thumb`,
  `/api/tag`, `/api/mark-all-read` and `/api/status`, which translate to FreshRSS's Google Reader API.
- `lib/freshrss.js`: the FreshRSS client (shared login, kept write token, one retry).
- `lib/articles.js`, `lib/extract.js`, `lib/netguard.js`: fetch an item's page and reduce it to
  article text and images (Mozilla Readability on linkedom), cached in memory and on disk. The page
  asks by item id, so only links from subscribed feeds are fetched, and never private addresses.
- `public/`: the page. Feed HTML is untrusted, so `modules/sanitize.js` rebuilds it from an
  allowlist and the server sends a strict Content-Security-Policy.
- `test/`, `tools/mock-freshrss.js`: the tests and the mock they run against.
