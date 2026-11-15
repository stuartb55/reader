// Fetches a web page and reduces it to its article text and images.
'use strict';
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { assertPublicHost } = require('./netguard');

const JUNK =
  'script, style, noscript, iframe, form, aside, [class*="share"], [class*="related"], [class*="advert"], [class*="newsletter"], [class*="promo"], [class*="comments"]';
const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_PAGE_BYTES = 6e6;

// Feeds are not always UTF-8: take the encoding from the response header, or
// failing that from the page's own <meta> tag.
function decodeHtml(buffer, contentType) {
  let charset = /charset=["']?\s*([\w.:-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

async function fetchPage(url, { allowPrivate = false } = {}) {
  let res;
  // Redirects are followed by hand so every hop can be checked.
  for (let hop = 0; ; hop++) {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('the link is not a web address');
    if (!allowPrivate) await assertPublicHost(target.hostname);
    res = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!next) break;
    await res.arrayBuffer().catch(() => {});
    if (hop >= 5) throw new Error('the link redirects too many times');
    url = new URL(next, target).href;
  }
  if (!res.ok) throw new Error(`the site returned ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/html/i.test(type)) throw new Error('the link is not a web page');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) throw new Error('the page is too large');
    chunks.push(chunk);
  }
  return { html: decodeHtml(Buffer.concat(chunks), type), url };
}

function absolute(value, base) {
  try {
    const u = new URL(value, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function firstOfSrcset(srcset) {
  // Prefer the largest candidate; entries look like "url 640w" or "url 2x".
  let best = null;
  for (const part of (srcset || '').split(/,\s+/)) {
    const [url, size] = part.trim().split(/\s+/);
    const n = parseFloat(size) || 1;
    if (url && (!best || n > best.n)) best = { url, n };
  }
  return best?.url || null;
}

function extract(html, url) {
  const { document } = parseHTML(html);
  // Lazy-loaded images keep the real address in data attributes or srcset.
  for (const img of document.querySelectorAll('img')) {
    const real =
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') ||
      firstOfSrcset(img.getAttribute('data-srcset')) ||
      (!img.getAttribute('src') || /^data:/.test(img.getAttribute('src'))
        ? firstOfSrcset(img.getAttribute('srcset')) ||
          firstOfSrcset(img.closest('picture')?.querySelector('source[srcset]')?.getAttribute('srcset'))
        : null);
    if (real) img.setAttribute('src', real);
  }
  const lead = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  // Some sites mark the body up explicitly; keep it in case Readability misses.
  const marked = document.querySelector('[itemprop="articleBody"]');
  for (const junk of marked?.querySelectorAll(JUNK) || []) junk.remove();
  const markedHtml = marked?.innerHTML || '';
  const markedText = squash(marked?.textContent);
  const parsed = new Readability(document, { charThreshold: 300 }).parse();
  let content = parsed?.content || '';
  let text = squash(parsed?.textContent);
  if (markedText.length > text.length * 1.5) {
    content = markedHtml;
    text = markedText;
  }
  const image = absolute(lead || '', url);
  if (!content || text.length < 400) {
    throw Object.assign(new Error('no article text could be found on the page'), { image });
  }
  const { document: out } = parseHTML(`<!doctype html><html><body>${content}</body></html>`);
  for (const el of out.querySelectorAll('img')) {
    const src = absolute(el.getAttribute('src') || '', url);
    if (src) el.setAttribute('src', src);
    else el.remove();
  }
  for (const el of out.querySelectorAll('a[href]')) {
    const href = absolute(el.getAttribute('href'), url);
    if (href) el.setAttribute('href', href);
    else el.removeAttribute('href');
  }
  return {
    html: out.body.innerHTML,
    byline: (parsed?.byline || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    image,
    leadImage: out.querySelector('img') ? null : image,
    words: text.split(' ').length,
  };
}

module.exports = { fetchPage, extract, decodeHtml };
