// The page's own modules that do not need a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

const load = (name) => import(`../public/modules/${name}.js`);

function sanitise(clean, html) {
  const { document } = parseHTML('<!doctype html><html><body><div id="in"></div><div id="out"></div></body></html>');
  document.getElementById('in').innerHTML = html;
  const out = document.getElementById('out');
  clean(document.getElementById('in'), out, document);
  return out.innerHTML;
}

test('the sanitiser keeps safe markup and drops everything else', async () => {
  const { clean } = await load('sanitize');
  const out = sanitise(
    clean,
    `<p onclick="x()" style="color:red">Hi <b>there</b></p><script>alert(1)</script><iframe src="https://e.com"></iframe>
     <a href="javascript:alert(1)">bad</a><a href="https://e.com/a" onmouseover="x()">good</a>
     <img src="data:image/png;base64,AAAA" onerror="x()"><img src="https://e.com/i.png" onerror="x()" alt="pic">
     <custom-tag><em>kept text</em></custom-tag><h1>Title</h1><form><input name="q"></form>`,
  );
  assert.ok(!/script|iframe|onclick|onerror|onmouseover|style=|javascript:|data:|<form|<input|custom-tag/i.test(out), out);
  assert.match(out, /<p>Hi <b>there<\/b><\/p>/);
  assert.match(out, /<a>bad<\/a>/);
  const link = /<a ([^>]*)>good<\/a>/.exec(out)[1].split(' ').sort();
  assert.deepEqual(link, ['href="https://e.com/a"', 'rel="noopener', 'noreferrer"', 'target="_blank"'].sort());
  const img = /<img ([^>]*)>/.exec(out)[1].split(' ').sort();
  assert.deepEqual(img, ['alt="pic"', 'loading="lazy"', 'referrerpolicy="no-referrer"', 'src="https://e.com/i.png"']);
  assert.match(out, /<em>kept text<\/em>/);
  assert.match(out, /<h3>Title<\/h3>/);
});

test('webUrl refuses anything that is not an absolute web address', async () => {
  const { webUrl } = await load('sanitize');
  assert.equal(webUrl('https://e.com/x'), 'https://e.com/x');
  assert.equal(webUrl('/relative'), null);
  assert.equal(webUrl('javascript:alert(1)'), null);
  assert.equal(webUrl('data:text/html,hi'), null);
});

test('feed names are shortened and times are relative', async () => {
  const { shortName, ago } = await load('util');
  assert.equal(shortName('Articles | Mail Online'), 'Mail Online');
  assert.equal(shortName('The Register: Biting the hand'), 'The Register');
  assert.equal(shortName('Plain'), 'Plain');
  const now = Date.UTC(2026, 0, 10, 12);
  assert.equal(ago(now / 1000 - 120, now), '2m ago');
  assert.equal(ago(now / 1000 - 3 * 3600, now), '3h ago');
  assert.equal(ago(now / 1000 - 2 * 86400, now), '2d ago');
});

test('queued changes collapse to the last one per item and group for sending', async () => {
  const { groupChanges } = await load('util');
  const groups = groupChanges([
    { id: 'a', tag: 'read', on: true },
    { id: 'b', tag: 'read', on: true },
    { id: 'a', tag: 'read', on: false },
    { id: 'a', tag: 'starred', on: true },
  ]);
  assert.deepEqual(groups, [
    { tag: 'read', on: false, ids: ['a'] },
    { tag: 'read', on: true, ids: ['b'] },
    { tag: 'starred', on: true, ids: ['a'] },
  ]);
});
