'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toCard, decode, webUrl } = require('../lib/cards');
const { extract, decodeHtml } = require('../lib/extract');
const { isPrivateAddress, assertPublicHost } = require('../lib/netguard');

test('decode handles named and numeric entities', () => {
  assert.equal(decode('Fish &amp; chips &#8217;n&#x27; &nope;'), 'Fish & chips ’n\' &nope;');
});

test('webUrl only lets web addresses through', () => {
  assert.equal(webUrl('//cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
  assert.equal(webUrl('javascript:alert(1)'), null);
  assert.equal(webUrl('https://a.example/?a=1&amp;b=2'), 'https://a.example/?a=1&b=2');
  assert.equal(webUrl(''), null);
});

test('toCard builds a card from a feed item', () => {
  const card = toCard({
    id: 'tag:google.com,2005:reader/item/0001',
    title: 'Tom &amp; Jerry',
    canonical: [{ href: 'https://example.com/a' }],
    origin: { streamId: 'feed/9', title: 'Example' },
    published: 100,
    summary: { content: '<p>Hello <b>there</b></p><script>bad()</script><img src="https://example.com/p.jpg">' + ' word'.repeat(100) },
    enclosure: [{ href: 'http://example.com/a.mp3', type: 'audio/mpeg' }],
    categories: ['user/-/state/com.google/read'],
  });
  assert.equal(card.title, 'Tom & Jerry');
  assert.equal(card.image, 'https://example.com/p.jpg');
  assert.equal(card.audio, null, 'plain http audio is not offered');
  assert.equal(card.read, true);
  assert.equal(card.starred, false);
  assert.ok(card.snippet.startsWith('Hello there'));
  assert.ok(card.snippet.endsWith('…') && card.snippet.length <= 261);
  assert.ok(!card.snippet.includes('bad()'));
});

test('extract finds the article, fixes links and reports its length', () => {
  const body = Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i} ${'lorem ipsum dolor sit amet '.repeat(12)}</p>`).join('');
  const html = `<html><head><meta property="og:image" content="/lead.jpg"></head><body><nav>menu</nav><article><h1>T</h1>${body}<p><a href="/more">more</a><img data-src="/pic.jpg"></p></article></body></html>`;
  const out = extract(html, 'https://example.com/story');
  assert.ok(out.words > 300);
  assert.equal(out.image, 'https://example.com/lead.jpg');
  assert.match(out.html, /href="https:\/\/example\.com\/more"/);
  assert.match(out.html, /src="https:\/\/example\.com\/pic\.jpg"/);
  assert.equal(out.leadImage, null);
});

test('extract reports a page with no article, keeping its image', () => {
  assert.throws(
    () => extract('<html><head><meta property="og:image" content="https://e.com/i.png"></head><body><p>Short.</p></body></html>', 'https://e.com/'),
    (err) => err.image === 'https://e.com/i.png',
  );
});

test('decodeHtml honours the header, then the meta tag, then falls back to UTF-8', () => {
  const latin = Buffer.from('<p>caf\xe9</p>', 'latin1');
  assert.equal(decodeHtml(latin, 'text/html; charset=ISO-8859-1'), '<p>café</p>');
  assert.equal(decodeHtml(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin]), 'text/html'), '<meta charset="windows-1252"><p>café</p>');
  assert.equal(decodeHtml(Buffer.from('<p>café</p>'), 'text/html'), '<p>café</p>');
  assert.equal(decodeHtml(Buffer.from('<p>ok</p>'), 'text/html; charset=made-up'), '<p>ok</p>');
});

test('private and local addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.5', '169.254.169.254', '100.100.1.1', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:192.168.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertPublicHost('192.168.1.1'), /private network/);
  await assert.rejects(assertPublicHost('[::1]'), /private network/);
  await assert.rejects(assertPublicHost('freshrss.local'), /private network/);
  await assert.rejects(assertPublicHost('rebind.example', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]), /private network/);
  await assert.doesNotReject(assertPublicHost('ok.example', async () => [{ address: '93.184.216.34' }]));
});
