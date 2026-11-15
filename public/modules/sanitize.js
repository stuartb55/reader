// Feed and article HTML is untrusted: rebuild it from an allowlist instead of
// inserting it.
const ALLOWED = new Set(['P', 'BR', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP', 'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'DIV', 'SPAN', 'SMALL', 'TIME', 'DL', 'DT', 'DD']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
const TEXT_NODE = 3, ELEMENT_NODE = 1;

export function webUrl(u) {
  try {
    const p = new URL(u, 'https://invalid.invalid');
    return /^https?:$/.test(p.protocol) && p.hostname !== 'invalid.invalid' ? p.href : null;
  } catch {
    return null;
  }
}

// Copies the allowed parts of `node` into `out`. Nothing but the tag name, a
// link's address and an image's address and description is carried across.
export function clean(node, out, doc = document) {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) { out.append(child.textContent); continue; }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = child.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (!ALLOWED.has(tag)) { clean(child, out, doc); continue; }
    const n = doc.createElement(tag === 'H1' ? 'h3' : tag.toLowerCase());
    if (tag === 'A') {
      const href = webUrl(child.getAttribute('href'));
      if (href) {
        n.setAttribute('href', href);
        n.setAttribute('target', '_blank');
        n.setAttribute('rel', 'noopener noreferrer');
      }
    } else if (tag === 'IMG') {
      const src = webUrl(child.getAttribute('src'));
      if (!src) continue;
      n.setAttribute('src', src);
      n.setAttribute('alt', child.getAttribute('alt') || '');
      n.setAttribute('loading', 'lazy');
      n.setAttribute('referrerpolicy', 'no-referrer');
    }
    clean(child, n, doc);
    out.append(n);
  }
}
