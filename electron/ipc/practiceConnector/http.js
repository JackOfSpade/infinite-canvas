import net from 'node:net';
import { CONSTANTS } from './constants.js';

// The per-source key used for rate limiting.  Cloudflare puts the caller in Cf-Connecting-IP.
function sourceAddress(req) {
  const value = String(req.headers?.['cf-connecting-ip'] || req.socket?.remoteAddress || '').trim();
  return net.isIP(value) ? value.toLowerCase() : null;
}

function addressParts(address) {
  const family = net.isIP(address);
  if (family === 4) return { family, parts: address.split('.').map(Number) };
  if (family !== 6) return null;
  const [leftText, rightText = ''] = address.toLowerCase().split('::');
  if (address.split('::').length > 2) return null;
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if (left.length + right.length > 8 || [...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return { family, parts: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(part => parseInt(part, 16)) };
}

function prefixForAddress(address, bits) {
  const parsed = addressParts(address);
  if (!parsed || !Number.isInteger(bits) || bits < 0 || bits > parsed.family * 32) return null;
  if (parsed.family === 4) {
    const octets = parsed.parts.slice();
    const whole = Math.floor(bits / 8); const rest = bits % 8;
    for (let index = whole + (rest ? 1 : 0); index < 4; index += 1) octets[index] = 0;
    if (rest) octets[whole] &= (0xff << (8 - rest));
    return `${octets.join('.')}/${bits}`;
  }
  const groups = parsed.parts.slice();
  const whole = Math.floor(bits / 16); const rest = bits % 16;
  for (let index = whole + (rest ? 1 : 0); index < 8; index += 1) groups[index] = 0;
  if (rest) groups[whole] &= (0xffff << (16 - rest));
  return `${groups.slice(0, Math.max(1, Math.ceil(bits / 16))).map(part => part.toString(16)).join(':')}::/${bits}`;
}

export function sourceKey(req) {
  const address = sourceAddress(req);
  if (!address) return 'unknown';
  return net.isIP(address) === 4 ? address : prefixForAddress(address, CONSTANTS.BUCKET_SOURCE_V6_BITS) || 'unknown';
}
