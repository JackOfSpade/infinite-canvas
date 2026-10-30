// Framework payloads are data, not executable evidence. These links still need
// the resolver's ordinary employer and tenant ownership checks.
import { parse } from 'parse5';
import { extractAtsTenant, isHostedAtsSurface } from './officialSourceHosts.js';

export const OFFICIAL_EMBEDDED_LINK_MAX_BYTES = 3 * 1024 * 1024;
export const OFFICIAL_EMBEDDED_LINK_MAX_NODES = 4096;
export const OFFICIAL_EMBEDDED_LINK_MAX_LINKS = 512;
const MAX_VALUES = 32768;
const MAX_STRING_LAYERS = 3;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clean = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[<>]/u.test(value) && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function postingUrl(value, sourceUrl) {
  if (!clean(value, 2000) || /\s/u.test(value)) return null;
  try {
    const url = new URL(value, sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !isHostedAtsSurface(url.hostname)) return null;
    const route = extractAtsTenant(url.href);
    if (!route) return null;
    url.hash = '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const detail = parts.at(-1).toLowerCase();
    if (['jobs', 'job', 'careers', 'career', 'apply', 'application', 'embed'].includes(detail)
      && parts.length < 3) return null;
    let path = url.pathname.replace(/\/(?:application|apply)\/?$/iu, '').replace(/\/+$/u, '');
    // A provider may use two public board host spellings for the same posting.
    if (route.ats === 'greenhouse') {
      const id = /\/jobs\/(\d+)$/u.exec(path)?.[1];
      if (!id) return null;
      path = id;
    }
    return { url: url.href, identity: `${route.ats}|${route.tenant}|${path}|${url.search}` };
  } catch { return null; }
}

/** Read typed job links from bounded JSON scripts and Next Flight envelopes.
 * Arbitrary JavaScript strings and URL-shaped text never become links. */
export function scanEmbeddedOfficialJobLinks(html, sourceUrl) {
  if (typeof html !== 'string' || html.includes('\0')
    || Buffer.byteLength(html, 'utf8') > OFFICIAL_EMBEDDED_LINK_MAX_BYTES) return [];
  try {
    const base = new URL(sourceUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.port && base.port !== '443') return [];
  } catch { return []; }
  const links = []; const seen = new Set();
  let nodes = 0; let values = 0; let decodedBytes = 0; let exhausted = false;
  const readJson = text => {
    if (typeof text !== 'string') return null;
    decodedBytes += Buffer.byteLength(text, 'utf8');
    if (decodedBytes > OFFICIAL_EMBEDDED_LINK_MAX_BYTES) { exhausted = true; return null; }
    try { return JSON.parse(text); } catch { return null; }
  };
  const record = value => {
    if (!own(value, 'title') || !clean(value.title, 500)) return;
    const fields = ['jobUrl', 'applyUrl'].filter(key => own(value, key));
    if (!fields.length) return;
    const urls = fields.map(key => postingUrl(value[key], sourceUrl));
    // A title from one row cannot lend authority to a sibling URL or to two
    // conflicting posting identities. Reject the complete malformed record.
    if (urls.some(url => !url) || new Set(urls.map(url => url.identity)).size !== 1) return;
    for (let index = 0; index < urls.length; index++) {
      const url = urls[index].url;
      if (seen.has(url)) continue;
      if (links.length >= OFFICIAL_EMBEDDED_LINK_MAX_LINKS) { exhausted = true; return; }
      seen.add(url); links.push({ url, tag: 'data', attribute: fields[index] });
    }
  };
  const walk = root => {
    const stack = [{ value: root, depth: 0 }];
    while (stack.length && !exhausted) {
      const { value, depth } = stack.pop();
      if (++values > MAX_VALUES || depth > 64) { exhausted = true; break; }
      if (!value || typeof value !== 'object') continue;
      if (++nodes > OFFICIAL_EMBEDDED_LINK_MAX_NODES) { exhausted = true; break; }
      if (!Array.isArray(value)) record(value);
      // Strings inside objects remain inert text. Only the recognized outer
      // transport envelopes below may introduce another JSON decoding layer.
      const children = Object.values(value);
      values += children.length;
      if (values > MAX_VALUES) { exhausted = true; break; }
      for (let index = children.length - 1; index >= 0; index--) {
        if (children[index] && typeof children[index] === 'object') stack.push({ value: children[index], depth: depth + 1 });
      }
    }
  };
  const jsonPayload = (text, layer = 0) => {
    if (layer >= MAX_STRING_LAYERS || exhausted) return;
    const value = readJson(text);
    if (typeof value === 'string') jsonPayload(value, layer + 1);
    else walk(value);
  };
  const document = parse(html); const stack = [document]; let htmlNodes = 0;
  while (stack.length && !exhausted) {
    if (++htmlNodes > MAX_VALUES) { exhausted = true; break; }
    const node = stack.pop();
    if (node.tagName === 'script' && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const attrs = Object.fromEntries((node.attrs || []).filter(attr => !attr.prefix).map(attr => [attr.name, attr.value]));
      if (!own(attrs, 'src')) {
        const type = (attrs.type || '').trim().toLowerCase();
        const text = (node.childNodes || []).map(child => child.nodeName === '#text' ? child.value || '' : '').join('');
        if (['application/json', 'application/ld+json'].includes(type)
          || attrs.id === '__NEXT_DATA__' && !type) jsonPayload(text);
        else if (['', 'text/javascript', 'application/javascript'].includes(type)) {
          const argument = /^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/u.exec(text)?.[1];
          if (argument) {
            const envelope = readJson(argument);
            if (Array.isArray(envelope) && envelope.length === 2 && envelope[0] === 1 && typeof envelope[1] === 'string') {
              for (const line of envelope[1].split('\n')) {
                const value = /^[0-9a-f]+:((?:\{|\[)[\s\S]*)$/iu.exec(line)?.[1];
                if (value) jsonPayload(value, 1);
                if (exhausted) break;
              }
            }
          }
        }
      }
    }
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return exhausted ? [] : links;
}
