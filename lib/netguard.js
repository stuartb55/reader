// Stops the article fetcher being pointed at this machine or the private
// network it sits on. Feed items supply the links, and feeds are not trusted.
'use strict';
const net = require('node:net');
const dns = require('node:dns/promises');

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

function isPrivateAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublicHost(hostname, lookup = dns.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const refuse = () => Object.assign(new Error('the link points at a private network address'), { status: 422 });
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw refuse();
    return;
  }
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/i.test(host)) throw refuse();
  let found;
  try {
    found = await lookup(host, { all: true });
  } catch {
    throw new Error('the site’s address could not be found');
  }
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw refuse();
}

module.exports = { isPrivateAddress, assertPublicHost };
