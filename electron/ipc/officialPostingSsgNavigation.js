// Typed native CMS navigation is a source declaration, never employer proof.
import { parse } from 'parse5';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_NODES = 32_768;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const visible = value => value?.hidden !== true && value?.isHidden !== true
  && (value?.hidden === undefined || value.hidden === false) && (value?.isHidden === undefined || value.isHidden === false);
const segment = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 120;

function https(value, base) {
  try {
    if (typeof value !== 'string' || !value || value.length > 2_048 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && !url.hostname.endsWith('.') ? url : null;
  } catch { return null; }
}

function bounded(value, budget) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop();
    if (++budget.count > MAX_NODES || item.depth > 50) return false;
    if (!item.value || typeof item.value !== 'object') continue;
    const entries = Object.entries(item.value);
    if (entries.some(([key]) => forbidden.has(key)) || budget.count + pending.length + entries.length > MAX_NODES) return false;
    for (let at = entries.length - 1; at >= 0; at--) pending.push({ value: entries[at][1], depth: item.depth + 1 });
  }
  return true;
}

function declarations(body) {
  const scripts = new Map(); const canonicals = []; const pending = [{ node: parse(body), depth: 0 }]; let count = 0; let recognized = false;
  const failure = () => ({ data: null, coverageIncomplete: recognized });
  while (pending.length) {
    const { node, depth } = pending.pop(); const children = node.childNodes || [];
    if (++count + pending.length + children.length > MAX_NODES || depth > 50) return { data: null, coverageIncomplete: true };
    const attrs = new Map((node.attrs || []).map(item => [item.name, item.value]));
    const id = attrs.get('id');
    if (node.tagName === 'script' && ['ssgSiteSettings', 'ssgContent'].includes(id)) {
      recognized = true;
      if (node.namespaceURI !== HTML_NAMESPACE || scripts.has(id) || attrs.get('type') !== 'application/json' || attrs.has('src')) return failure();
      const raw = children.map(child => child.nodeName === '#text' ? child.value || '' : '').join('');
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) return failure();
      try { scripts.set(id, JSON.parse(raw)); } catch { return failure(); }
    }
    if (node.namespaceURI === HTML_NAMESPACE && node.tagName === 'link' && (attrs.get('rel') || '').split(/\s+/u).includes('canonical')) {
      canonicals.push(attrs.get('href'));
    }
    for (let at = children.length - 1; at >= 0; at--) pending.push({ node: children[at], depth: depth + 1 });
  }
  if (scripts.size !== 2 || canonicals.length !== 1) return recognized ? failure() : { data: null, coverageIncomplete: false };
  const budget = { count: 0 };
  if (![...scripts.values()].every(value => bounded(value, budget))) return failure();
  return { data: { settings: scripts.get('ssgSiteSettings'), content: scripts.get('ssgContent'), canonical: canonicals[0] }, coverageIncomplete: false };
}

/** Same-origin navigation only; the normal host/root ownership gates still run. */
export function scanOfficialPostingSsgNavigationInventory({ body, sourceUrl } = {}) {
  const empty = coverageIncomplete => ({ links: [], coverageIncomplete });
  const source = https(sourceUrl); if (!source || typeof body !== 'string') return empty(false);
  if (Buffer.byteLength(body) > MAX_BYTES) return empty(true);
  const receipt = declarations(body); const { data } = receipt;
  if (body.includes('\0')) return empty(Boolean(data) || receipt.coverageIncomplete);
  if (!data) return empty(receipt.coverageIncomplete);
  const { settings, content } = data;
  if (!object(settings) || settings._type !== 'settings' || !object(content) || content._type !== 'page'
    || content.parent !== null || content.language !== undefined && content.language !== null || !visible(content)
    || !object(content.slug) || content.slug._type !== 'slug') return empty(true);
  const corporate = https(settings.orgUrl); const canonical = https(data.canonical, source);
  if (!corporate || corporate.origin !== source.origin || corporate.pathname !== '/' || canonical?.href !== source.href) return empty(true);
  if (source.pathname === '/') {
    if (content.path !== '' || content.slug.current !== 'home') return empty(true);
  } else if (!segment(content.path) || content.path === 'home' || content.slug.current !== content.path || source.pathname !== `/${content.path}`) return empty(true);
  const lists = [];
  if (object(settings.companySection) && settings.companySection._type === 'menuSection' && visible(settings.companySection)
    && Array.isArray(settings.companySection.linkLists)) for (const list of settings.companySection.linkLists) lists.push(list);
  if (Array.isArray(settings.footerLinks)) for (const list of settings.footerLinks) lists.push(list);
  const links = []; const seen = new Set();
  for (const list of lists) {
    if (!object(list) || list._type !== 'linkList' || !visible(list) || !Array.isArray(list.links)) continue;
    for (const link of list.links) {
      if (!object(link) || link._type !== 'internalLink' || link.targetBlank !== false || !visible(link)) continue;
      const reference = link.reference;
      if (!object(reference) || reference._type !== 'page' || reference.parent !== null || reference.language !== null || !visible(reference)
        || !object(reference.slug) || reference.slug._type !== 'slug') continue;
      const slug = reference.slug.current; const label = slug === 'careers' ? 'Careers' : slug === 'open-roles' ? 'Open Roles' : '';
      if (!label || !segment(slug) || reference.title !== label || link.text !== label) continue;
      const url = new URL(`/${slug}`, source).href;
      if (!seen.has(url)) { seen.add(url); links.push({ url, tag: 'declaration', attribute: 'url' }); }
    }
  }
  return { links, coverageIncomplete: false };
}

/** Compatibility wrapper: callers needing finality must consume the receipt. */
export function scanOfficialPostingSsgNavigation(input) {
  return scanOfficialPostingSsgNavigationInventory(input).links;
}
