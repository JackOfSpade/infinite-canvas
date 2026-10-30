// The browser may classify authored fetch preloads as resourceType "other".
// These declarations authorize only exact, read-only resource transport; they
// never establish a job, tenant, employer or search-header receipt.
import { parse } from 'parse5';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 32_768;
const MAX_URLS = 64;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function https(value, base) {
  try {
    if (typeof value !== 'string' || !value || value.length > 2_048 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.hostname.endsWith('.') ? url : null;
  } catch { return null; }
}

export function scanOfficialPostingFetchPreloads({ body, sourceUrl } = {}) {
  const empty = () => ({ urls: [], coverageIncomplete: false });
  const limited = () => ({ urls: [], coverageIncomplete: true });
  if (typeof body !== 'string') return empty();
  if (body.includes('\0') || Buffer.byteLength(body) > MAX_BYTES) return limited();
  const source = https(sourceUrl); if (!source) return empty();
  const declarations = []; const bases = []; const pending = [{ node: parse(body), depth: 0 }]; let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop(); const children = node.childNodes || [];
    if (++count + pending.length + children.length > MAX_NODES || depth > 50) return limited();
    if (node.namespaceURI === HTML_NAMESPACE) {
      const attrs = new Map((node.attrs || []).filter(item => !item.prefix).map(item => [item.name, item.value]));
      if (node.tagName === 'base' && attrs.has('href')) bases.push(attrs.get('href'));
      if (node.tagName === 'link' && (attrs.get('rel') || '').toLowerCase().split(/\s+/u).includes('preload')
        && (attrs.get('as') || '').toLowerCase() === 'fetch' && attrs.has('crossorigin')
        && ['', 'anonymous'].includes(attrs.get('crossorigin').trim().toLowerCase())) declarations.push(attrs.get('href'));
    }
    for (let at = children.length - 1; at >= 0; at--) pending.push({ node: children[at], depth: depth + 1 });
  }
  if (bases.length > 1) return limited();
  const base = bases.length ? https(bases[0], source) : source;
  if (!base || base.origin !== source.origin || bases.length && base.search) return limited();
  const urls = []; const seen = new Set();
  for (const value of declarations) {
    const url = https(value, base);
    if (!url || url.origin !== source.origin) continue;
    if (seen.has(url.href)) continue;
    if (urls.length >= MAX_URLS) return limited();
    seen.add(url.href); urls.push(url.href);
  }
  return { urls, coverageIncomplete: false };
}
