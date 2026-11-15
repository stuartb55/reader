// On-device storage for reading without a connection: the last lists that
// were loaded, article text, and changes waiting to be sent. Every function
// rejects when IndexedDB is unavailable; callers treat that as "nothing saved".
const MAX_ARTICLES = 400;
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('reader', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lists', { keyPath: 'key' });
      db.createObjectStore('articles', { keyPath: 'id' }).createIndex('at', 'at');
      db.createObjectStore('outbox', { keyPath: 'key', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => { opening = null; });
  return opening;
}

async function run(store, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const req = work(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const putList = (key, items) => run('lists', 'readwrite', (s) => s.put({ key, at: Date.now(), items }));
export const getList = (key) => run('lists', 'readonly', (s) => s.get(key));

export const putArticle = (id, full) => run('articles', 'readwrite', (s) => s.put({ id, at: Date.now(), full }));
export const getArticle = (id) => run('articles', 'readonly', (s) => s.get(id));

// Keeps the newest articles and drops the rest.
export async function pruneArticles() {
  const count = await run('articles', 'readonly', (s) => s.count());
  let extra = count - MAX_ARTICLES;
  if (extra <= 0) return;
  await run('articles', 'readwrite', (s) => {
    s.index('at').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || extra-- <= 0) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export const queue = (change) => run('outbox', 'readwrite', (s) => s.add(change));
export const outbox = () => run('outbox', 'readonly', (s) => s.getAll());
export const clearOutbox = (keys) => run('outbox', 'readwrite', (s) => { for (const k of keys) s.delete(k); });
