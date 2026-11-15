export function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

export function ago(sec, now = Date.now()) {
  const d = Math.max(0, now / 1000 - sec);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 7 * 86400) return `${Math.round(d / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// "Articles | Mail Online" -> "Mail Online"; "The Register: Biting the hand…" -> "The Register".
const GENERIC = /^(news|articles?|home|latest|rss|feed|top stories)$/i;
export function shortName(title) {
  const parts = title.split(/\s+[|–—-]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => !GENERIC.test(p)) || title;
}

// Collapses queued changes to the last one per item and tag, grouped so each
// group can be sent to the server in one call.
export function groupChanges(entries) {
  const last = new Map();
  for (const e of entries) last.set(`${e.tag} ${e.id}`, e);
  const groups = new Map();
  for (const e of last.values()) {
    const key = `${e.tag} ${e.on}`;
    if (!groups.has(key)) groups.set(key, { tag: e.tag, on: e.on, ids: [] });
    groups.get(key).ids.push(e.id);
  }
  return [...groups.values()];
}
