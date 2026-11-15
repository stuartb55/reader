// Fetches and keeps the full text of articles. Extracted articles are held in
// memory and, when a cache directory is writable, on disk so they survive a
// restart. The page asks by item id, never by URL, so this only ever fetches
// links that came from a subscribed feed.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { itemUrl } = require('./cards');

function usableDir(dir, log) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.probe');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return dir;
  } catch (err) {
    log(`article cache: ${dir} is not writable (${err.code || err.message}); keeping articles in memory only`);
    return null;
  }
}

function createArticles({
  client,
  fetchPage,
  extract,
  cacheDir = null,
  ttlMs = 14 * 24 * 3600 * 1000,
  maxFiles = 3000,
  maxMemory = 600,
  concurrency = 4,
  log = console.log,
}) {
  const dir = usableDir(cacheDir, log);
  const memory = new Map(); // item id -> promise of an article, oldest first
  const fileFor = (id) => path.join(dir, crypto.createHash('sha1').update(id).digest('hex') + '.json');

  // At most a few source pages are fetched at a time.
  let running = 0;
  const waiting = [];
  function queue(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            waiting.shift()?.();
          });
      };
      if (running < concurrency) run();
      else waiting.push(run);
    });
  }

  async function readDisk(id) {
    if (!dir) return null;
    try {
      const saved = JSON.parse(await fsp.readFile(fileFor(id), 'utf8'));
      return saved.id === id && Date.now() - saved.at < ttlMs ? saved : null;
    } catch {
      return null;
    }
  }

  function writeDisk(id, entry) {
    if (!dir) return;
    const file = fileFor(id);
    const tmp = `${file}.${process.pid}.tmp`;
    fsp
      .writeFile(tmp, JSON.stringify({ id, at: Date.now(), ...entry }))
      .then(() => fsp.rename(tmp, file))
      .catch((err) => log(`article cache: could not save (${err.code || err.message})`));
  }

  async function load(id) {
    const saved = await readDisk(id);
    if (saved?.article) return saved.article;
    if (saved?.failure) throw Object.assign(new Error(saved.failure.message), { status: 422, image: saved.failure.image });
    return queue(async () => {
      const body = new URLSearchParams({ i: id, output: 'json' });
      const data = await client.json('stream/items/contents', { body });
      const url = itemUrl(data.items?.[0]);
      if (!url) throw Object.assign(new Error('this item has no link'), { status: 404 });
      const page = await fetchPage(url);
      try {
        const article = extract(page.html, page.url);
        writeDisk(id, { article });
        return article;
      } catch (err) {
        // A page with no article text will not change, so remember that too.
        if ('image' in err) {
          err.status = 422;
          writeDisk(id, { failure: { message: err.message, image: err.image } });
        }
        throw err;
      }
    });
  }

  function get(id) {
    if (memory.has(id)) return memory.get(id);
    // Keep the promise so a card's image lookup and opening the article share one fetch.
    const pending = load(id);
    memory.set(id, pending);
    if (memory.size > maxMemory) memory.delete(memory.keys().next().value);
    // Network failures may be temporary; a page with no article text is kept.
    pending.catch((err) => 'image' in err || memory.delete(id));
    return pending;
  }

  // Drops expired files, then the oldest ones beyond the limit.
  async function prune() {
    if (!dir) return 0;
    let removed = 0;
    try {
      const files = [];
      for (const name of await fsp.readdir(dir)) {
        const file = path.join(dir, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat?.isFile()) files.push({ file, at: stat.mtimeMs, stale: name.endsWith('.tmp') });
      }
      files.sort((a, b) => b.at - a.at);
      for (const [i, f] of files.entries()) {
        if (i >= maxFiles || Date.now() - f.at > (f.stale ? 3600 * 1000 : ttlMs)) {
          await fsp.rm(f.file, { force: true });
          removed++;
        }
      }
    } catch (err) {
      log(`article cache: could not tidy up (${err.code || err.message})`);
    }
    return removed;
  }

  if (dir) {
    prune();
    setInterval(prune, 6 * 3600 * 1000).unref();
  }

  return { get, prune, persistent: Boolean(dir) };
}

module.exports = { createArticles };
