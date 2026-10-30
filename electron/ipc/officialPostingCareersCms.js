// Typed authoring fields in Angular's server transfer state can declare job
// navigation even when the page implements its button with window.open.
// These are source declarations, not HTML anchors or ownership verdicts.
import { parse } from 'parse5';
import { officialPostingVendorRoute } from './officialPostingVendorAdapters.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 32_768;
const ALT_KEY = /^CAREERS_SECTION-\d+(?:_(?:SLIDE|HOVER-BLOCK)-\d+)?_IMAGE-ALT-TEXT$/u;
const LINK_KEY = /^CAREERS_SECTION-\d+(?:_(?:SLIDE|HOVER-BLOCK)-\d+)?_(?:LINK|BUTTON)-\d+_URL$/u;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function https(value) {
  try {
    const u = new URL(value);
    if (typeof value !== 'string' || u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')
      || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || u.hostname.endsWith('.')) return null;
    u.hash = ''; return u;
  } catch { return null; }
}
function boundedJson(value) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++count > MAX_NODES || item.depth > 50) return false;
    if (!item.value || typeof item.value !== 'object') continue;
    const entries = Object.values(item.value);
    if (entries.length + pending.length + count > MAX_NODES) return false;
    for (let at = entries.length - 1; at >= 0; at--) pending.push({ value: entries[at], depth: item.depth + 1 });
  }
  return true;
}

export function extractOfficialCareersCmsFacts({ body, sourceUrl } = {}) {
  if (typeof body !== 'string' || body.includes('\0') || Buffer.byteLength(body, 'utf8') > MAX_BYTES) return null;
  const source = https(sourceUrl); if (!source) return null;
  let path;
  try { path = source.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  const [region, language, section] = path;
  if (!/^[a-z]{2}$/u.test(region || '') || !/^[a-z]{2,3}$/u.test(language || '') || !/^(?:careers?|jobs?|hiring)$/u.test(section || '')) return null;
  const scripts = []; const pending = [parse(body)]; let count = 0;
  while (pending.length) {
    const node = pending.pop(); const nested = node.childNodes || [];
    if (++count + pending.length + nested.length > MAX_NODES) return null;
    const attrs = new Map((node.attrs || []).map(item => [item.name, item.value]));
    if (node.tagName === 'script' && attrs.get('id') === 'ng-state' && attrs.get('type') === 'application/json' && !attrs.has('src')) {
      scripts.push(nested.filter(child => child.nodeName === '#text').map(child => child.value || '').join(''));
    }
    for (let at = nested.length - 1; at >= 0; at--) pending.push(nested[at]);
  }
  if (scripts.length !== 1) return null;
  let state;
  try { state = JSON.parse(scripts[0]); } catch { return null; }
  if (!plainObject(state) || !boundedJson(state) || state.region !== region || state.language !== language) return null;
  const locale = `${language}-${region.toUpperCase()}`; const records = new Map();
  for (const [cacheKey, entry] of Object.entries(state)) {
    if (!/^\d+$/u.test(cacheKey) || !plainObject(entry?.b) || !plainObject(entry.b[locale])) continue;
    for (const [key, record] of Object.entries(entry.b[locale])) {
      if (!ALT_KEY.test(key) && !LINK_KEY.test(key) && !LINK_KEY.test(key.replace(/_TEXT$/u, '_URL'))) continue;
      if (!plainObject(record) || record.key !== key || typeof record.value !== 'string' || record.value.length > 2_048) return null;
      if (records.has(key) && records.get(key) !== record.value) return null;
      records.set(key, record.value);
    }
  }
  const accounts = new Map(); const branding = [];
  for (const [key, value] of records) {
    if (ALT_KEY.test(key)) {
      if (/[<>]/u.test(value)) return null;
      if (value.trim() && value.length <= 1_000) branding.push({ text: value.trim(), key,
        role: 'image-alt-text', provenance: 'angular-transfer-state' });
    }
    if (!LINK_KEY.test(key)) continue;
    const label = records.get(key.replace(/_URL$/u, '_TEXT'));
    const linked = https(value); const account = linked && officialPostingVendorRoute(linked.href);
    // A careers dictionary also contains social links and older unsupported
    // navigation forms. Only a complete job-labelled account pair is a fact.
    if (account?.ats !== 'paylocity') continue;
    if (typeof label !== 'string') return null;
    if (label.replace(/\s+/gu, ' ').trim().toLowerCase() !== 'view job openings') continue;
    if (!accounts.has(account.tenant)) accounts.set(account.tenant, { url: linked.href, key, label,
      role: 'job-openings', provenance: 'angular-transfer-state' });
  }
  if (accounts.size !== 1 || !branding.length) return null;
  return { links: [...accounts.values()], branding };
}

// Phenom careers sites share one structure: a `phApp` bootstrap object naming the site's own locale base URL, a
// `search-results` route, and the first result page as JSON in `phApp.ddo`. Both outputs are navigation leads only;
// the resolver's proven-host gate and every ownership/match check still apply to whatever they lead to.
const PHENOM_BASE = /\bphApp\s*=\s*phApp\s*\|\|\s*\{[^\n]{0,4000}?"baseUrl"\s*:\s*"(https:[^"\\]{1,200})"/u;
function phenomSite(html, sourceUrl) {
  if (typeof html !== 'string' || html.length > MAX_BYTES || html.includes('\0')) return null;
  const base = PHENOM_BASE.exec(html)?.[1];
  if (!base || !/"search-results"\s*:\s*"search-results"/u.test(html)) return null;
  const root = https(base); const source = https(sourceUrl);
  // The base must be this page's own origin and a locale prefix (global/en), never a path elsewhere.
  if (!root || !source || root.origin !== source.origin || root.search || !/^\/(?:[a-z0-9-]{1,16}\/){1,2}$/iu.test(root.pathname)) return null;
  return { origin: root.origin, prefix: root.pathname };
}
/** The site's own keyword search page (without the keyword), or null when the page is not a Phenom site. */
export function phenomSearchForm(html, sourceUrl) {
  const site = phenomSite(html, sourceUrl);
  return site ? { url: `${site.origin}${site.prefix}search-results`, param: 'keywords' } : null;
}
/** Job-detail links for the first result page embedded in a Phenom search-results page. */
export function phenomSearchJobLinks(html, sourceUrl) {
  const site = phenomSite(html, sourceUrl); const source = https(sourceUrl);
  if (!site || source.pathname.replace(/\/+$/u, '') !== `${site.prefix}search-results`.replace(/\/+$/u, '') || !source.searchParams.get('keywords')) return [];
  const at = html.indexOf('"eagerLoadRefineSearch"'); const start = at < 0 ? -1 : html.indexOf('"jobs":[', at);
  if (start < 0) return [];
  // String-aware bracket scan of the jobs array, then ordinary JSON.parse.
  let depth = 0; let inString = false; let end = -1;
  for (let index = start + 7; index < html.length && index - start < 2 * 1024 * 1024; index++) {
    const char = html[index];
    if (inString) { if (char === '\\') index++; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) { end = index + 1; break; }
  }
  let jobs; try { jobs = end > 0 ? JSON.parse(html.slice(start + 7, end)) : null; } catch { return []; }
  if (!Array.isArray(jobs)) return [];
  const links = []; const seen = new Set();
  for (const job of jobs.slice(0, 25)) {
    const id = job?.jobId ?? job?.reqId; const title = job?.title;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/u.test(id) || typeof title !== 'string' || !title.trim() || title.length > 300) continue;
    const slug = title.normalize('NFKD').replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'job';
    const url = `${site.origin}${site.prefix}job/${id}/${slug}`;
    if (!seen.has(url)) { seen.add(url); links.push({ url, tag: 'a', attribute: 'data-phenom-job' }); }
  }
  return links;
}
