# Reader

A card-view reader for [FreshRSS](https://github.com/FreshRSS/FreshRSS). A small Node server holds the FreshRSS API credentials and serves a single page that lists items as cards,
(or a compact headline list), lets you tick or swipe them away as read,
opens them in a reading panel with the full article text fetched from the source site, and syncs read and starred state back to FreshRSS.

The page is an installable web app (manifest, icons and a service worker that keeps the shell
available offline; feed data is never cached). Installing needs HTTPS.

## Configuration

| Variable | Meaning |
|---|---|
| `FRESHRSS_URL` | Base URL of FreshRSS as seen from this container. Default `http://freshrss`. |
| `FRESHRSS_USER` | FreshRSS username. |
| `FRESHRSS_API_PASSWORD` | That user's API password (FreshRSS: Profile, API management). API access must be enabled under Authentication. |
| `PORT` | Listen port. Default `8080`. |

The app has no login of its own: anyone who can reach it reads and marks items as the configured
user. Keep it on a private network.

## Run

```yaml
  freshrss-reader:
    build: ./freshrss-reader
    environment:
      - FRESHRSS_URL=http://freshrss
      - FRESHRSS_USER=stuart
      - FRESHRSS_API_PASSWORD=${FRESHRSS_API_PASSWORD:?Set FRESHRSS_API_PASSWORD in .env}
    read_only: true
```

Locally: `FRESHRSS_URL=... FRESHRSS_USER=... FRESHRSS_API_PASSWORD=... node server.js`, then open
http://localhost:8080.

## Layout

- `server.js`: static files plus `/api/feeds`, `/api/items`, `/api/article`, `/api/tag`, `/api/mark-all-read`,
  which translate to FreshRSS's Google Reader API.
- `extract.js`: fetches an item's page and reduces it to article text and images (Mozilla
  Readability on linkedom). The page asks by item id, so only links from subscribed feeds are fetched.
- `public/`: the page. Feed HTML is untrusted, so `app.js` rebuilds it from an allowlist and the
  server sends a strict Content-Security-Policy.
