// Serves the page's files from memory, compressed ahead of time, with ETags
// so the browser only downloads a file again when it has changed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.webmanifest']);

function loadStatic(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // package.json only tells Node the page's modules are ES modules; it is not part of the page.
      else if (entry.isFile() && entry.name !== 'package.json') {
        const body = fs.readFileSync(full);
        const ext = path.extname(entry.name);
        const text = TEXT.has(ext);
        files.set('/' + path.relative(root, full).split(path.sep).join('/'), {
          body,
          type: TYPES[ext] || 'application/octet-stream',
          etag: `"${crypto.createHash('sha1').update(body).digest('base64url')}"`,
          br: text ? zlib.brotliCompressSync(body) : null,
          gzip: text ? zlib.gzipSync(body, { level: 9 }) : null,
        });
      }
    }
  };
  walk(root);
  return files;
}

function encodingFor(req) {
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

module.exports = { loadStatic, encodingFor };
