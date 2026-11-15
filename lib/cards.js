// Turns FreshRSS (Google Reader API) items into the cards the page shows.
'use strict';

const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';
const READING_LIST = 'user/-/state/com.google/reading-list';

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

function webUrl(u) {
  if (!u) return null;
  u = decode(u.trim());
  if (u.startsWith('//')) u = 'https:' + u;
  return /^https?:\/\//i.test(u) ? u : null;
}

function itemUrl(item) {
  return webUrl(item?.canonical?.[0]?.href || item?.alternate?.[0]?.href);
}

function toCard(item) {
  const html = item.summary?.content || item.content?.content || '';
  const text = decode(html.replace(/<(script|style|figure)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const enclosures = item.enclosure || [];
  const picture = enclosures.find((e) => (e.type || '').startsWith('image/'));
  const sound = enclosures.find((e) => (e.type || '').startsWith('audio/'));
  const inline = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const cats = item.categories || [];
  const audio = webUrl(sound?.href);
  return {
    id: item.id,
    title: decode(item.title || '(untitled)'),
    url: itemUrl(item),
    feed: decode(item.origin?.title || ''),
    feedId: item.origin?.streamId || '',
    author: item.author || '',
    published: item.published || 0,
    image: webUrl(picture?.href) || webUrl(inline?.[1]),
    // The page's security policy only plays media over HTTPS.
    audio: audio && audio.startsWith('https://') ? audio : null,
    snippet: text.length > 260 ? text.slice(0, 260).replace(/\s+\S*$/, '') + '…' : text,
    html,
    read: cats.includes(READ),
    starred: cats.includes(STARRED),
  };
}

module.exports = { READ, STARRED, READING_LIST, decode, webUrl, itemUrl, toCard };
