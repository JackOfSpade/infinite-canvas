// A bounded subset of Nuxt's JSON devalue format. This reads typed, URL-bound
// posting data; it never executes JavaScript or establishes employer ownership.
import { parse, parseFragment } from 'parse5';
import { normalizeLocationInput } from '../../src/utils/jobLocation.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 32_768;
const MAX_DEPTH = 50;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WRAPPERS = new Set(['Reactive', 'ShallowReactive']);
const plain = value => typeof value === 'string' ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function route(value) {
  try {
    if (typeof value !== 'string' || !value || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const source = new URL(value);
    const id = /^(?:\/company)?\/careers\/roles\/([1-9]\d{0,15})\/?$/u.exec(source.pathname)?.[1];
    if (!id || source.protocol !== 'https:' || source.username || source.password || source.port || source.hash || source.hostname.endsWith('.')) return null;
    if (source.search && (source.searchParams.getAll('gh_jid').length !== 1 || source.searchParams.get('gh_jid') !== id
      || [...source.searchParams.keys()].length !== 1)) return null;
    return { source, id };
  } catch { return null; }
}

function jsonScript(body) {
  const pending = [{ node: parse(body), depth: 0 }]; const scripts = []; let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop(); const children = node.childNodes || [];
    if (++count + pending.length + children.length > MAX_NODES || depth > MAX_DEPTH) return null;
    const attrs = new Map((node.attrs || []).map(item => [item.name, item.value]));
    if (node.tagName === 'script' && attrs.get('id') === '__NUXT_DATA__') {
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || attrs.get('type') !== 'application/json' || attrs.has('src')) return null;
      scripts.push(children.map(child => child.nodeName === '#text' ? child.value || '' : '').join(''));
    }
    for (let at = children.length - 1; at >= 0; at--) pending.push({ node: children[at], depth: depth + 1 });
  }
  if (scripts.length !== 1) return null;
  try { return JSON.parse(scripts[0]); } catch { return null; }
}

function validGraph(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_NODES) return false;
  const edges = []; let count = values.length;
  for (const node of values) {
    let refs = [];
    if (Array.isArray(node)) {
      if (typeof node[0] === 'string') {
        if (WRAPPERS.has(node[0])) { if (node.length !== 2) return false; }
        // Nuxt's unrelated `once` state is serialized as a Set. Its references
        // are validated, but it is never consulted for posting facts.
        else if (node[0] !== 'Set') return false;
        refs = node.slice(1);
      } else refs = node;
    } else if (object(node)) {
      if (Object.keys(node).some(key => FORBIDDEN_KEYS.has(key))) return false;
      refs = Object.values(node);
    } else if (!['string', 'number', 'boolean'].includes(typeof node) && node !== null) return false;
    if ((count += refs.length) > MAX_NODES || refs.some(ref => !Number.isInteger(ref) || ref < -1 || ref >= values.length)) return false;
    edges.push(refs.filter(ref => ref !== -1));
  }
  const done = new Set(); const active = new Set(); const depths = [];
  for (let start = 0; start < values.length; start++) {
    const pending = [{ index: start, exit: false, depth: 0 }];
    while (pending.length) {
      const item = pending.pop();
      if (item.exit) {
        let depth = 0;
        for (const child of edges[item.index]) depth = Math.max(depth, depths[child] + 1);
        if (depth > MAX_DEPTH) return false;
        depths[item.index] = depth; active.delete(item.index); done.add(item.index); continue;
      }
      if (active.has(item.index) || item.depth > MAX_DEPTH) return false;
      if (done.has(item.index)) continue;
      active.add(item.index); pending.push({ ...item, exit: true });
      const refs = edges[item.index];
      for (let at = refs.length - 1; at >= 0; at--) pending.push({ index: refs[at], exit: false, depth: item.depth + 1 });
    }
  }
  return true;
}

function unwrap(values, index) {
  let value = values[index]; let depth = 0;
  while (Array.isArray(value) && WRAPPERS.has(value[0])) {
    if (++depth > MAX_DEPTH) return null;
    value = values[value[1]];
  }
  return value;
}

function descriptionText(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) return '';
  const pending = [{ node: parseFragment(html), depth: 0, exit: false }]; const parts = []; let count = 0;
  const blocks = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|h[1-6]|hr|li|ol|p|section|table|td|th|tr|ul)$/u;
  while (pending.length) {
    const item = pending.pop(); const { node } = item;
    if (item.exit) { if (blocks.test(node.tagName || '')) parts.push('\n'); continue; }
    const children = node.childNodes || [];
    if (++count + pending.length + children.length > MAX_NODES || item.depth > MAX_DEPTH) return '';
    if (/^(?:script|style|template|noscript)$/u.test(node.tagName || '')) continue;
    if (node.nodeName === '#text') parts.push(node.value || '');
    if (blocks.test(node.tagName || '')) parts.push('\n');
    pending.push({ ...item, exit: true });
    for (let at = children.length - 1; at >= 0; at--) pending.push({ node: children[at], depth: item.depth + 1, exit: false });
  }
  return parts.join('').replace(/[\t\f\v ]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function locationFacts(values, job, locationRecord) {
  const read = (record, key) => object(record) && Object.hasOwn(record, key) ? unwrap(values, record[key]) : undefined;
  const display = object(locationRecord) ? plain(read(locationRecord, 'name')) : plain(locationRecord);
  if (display.length > 500) return null;
  const facts = { display, workMode: '', remoteCountry: '', remoteRegion: '' };
  for (const key of ['remote', 'workMode', 'remoteCountry', 'remoteRegion']) {
    const declared = [read(locationRecord, key), read(job, key)].filter(value => value !== undefined && value !== null);
    if (key === 'remote') {
      if (declared.some(value => typeof value !== 'boolean')) return null;
    } else if (declared.some(value => typeof value !== 'string' || value.length > (key === 'remoteRegion' ? 160 : 120)
      || /[<>]/u.test(value))) return null;
    const normalized = declared.map(value => key === 'remote' ? value : key === 'workMode'
      ? value.trim().toLowerCase().replace(/^on-site$/u, 'onsite') : value.trim()).filter(value => value !== '');
    if (new Set(normalized).size > 1) return null;
    if (normalized.length) facts[key] = normalized[0];
  }
  if (!['', 'remote', 'hybrid', 'onsite'].includes(facts.workMode)) return null;
  const remoteDisplay = /^Remote\s*[-–—]\s*([^<>]{1,120})$/iu.exec(display);
  if (remoteDisplay) {
    const restriction = normalizeLocationInput(remoteDisplay[1]);
    // A known country must be literally present; a city/subdivision inference
    // must never turn an unstated country into an advertised remote restriction.
    if (restriction.scope === 'country' && restriction.countryExplicit && !restriction.countryConflict) {
      if (facts.remote === false || facts.workMode && facts.workMode !== 'remote'
        || facts.remoteCountry && facts.remoteCountry !== restriction.country) return null;
      facts.remote = true; facts.workMode = 'remote'; facts.remoteCountry = restriction.country;
    }
  }
  if (facts.remote === true && facts.workMode && facts.workMode !== 'remote'
    || facts.remote === false && facts.workMode === 'remote') return null;
  if (facts.workMode) facts.remote = facts.workMode === 'remote';
  else if (facts.remote === true) facts.workMode = 'remote';
  // Absence of a remote declaration remains absent. Semantic evidence renders
  // it as unspecified rather than turning a location name into an onsite claim.
  return facts;
}

/** Returns source facts only. Ownership and matching remain host decisions. */
export function extractOfficialPostingNuxtData({ body, sourceUrl, employer = '', now = Date.now() } = {}) {
  if (typeof body !== 'string' || body.includes('\0') || Buffer.byteLength(body) > MAX_BYTES) return [];
  const current = route(sourceUrl); if (!current) return [];
  const values = jsonScript(body); if (!validGraph(values)) return [];
  if (!Array.isArray(values[0]) || !WRAPPERS.has(values[0][0])) return [];
  const root = unwrap(values, 0); const data = object(root) && unwrap(values, root.data);
  if (!object(root) || !Array.isArray(values[root.data]) || !WRAPPERS.has(values[root.data][0])) return [];
  if (!object(data)) return [];
  const keys = Object.keys(data).filter(key => /^greenhouse-job-[1-9]\d{0,15}-auto$/u.test(key));
  if (keys.length !== 1 || keys[0] !== `greenhouse-job-${current.id}-auto`) return [];
  const record = unwrap(values, data[keys[0]]); const job = object(record) && unwrap(values, record.job);
  if (!object(job)) return [];
  const field = key => Object.hasOwn(job, key) ? unwrap(values, job[key]) : undefined;
  const id = field('id'); const declared = route(field('absolute_url'));
  if (!['number', 'string'].includes(typeof id) || typeof id === 'number' && !Number.isSafeInteger(id) || String(id) !== current.id
    || !declared || declared.id !== current.id || declared.source.origin !== current.source.origin
    || declared.source.pathname !== current.source.pathname) return [];
  const title = plain(field('title')); const company = plain(field('company_name')) || plain(employer);
  const description = descriptionText(field('content'));
  const location = locationFacts(values, job, field('location'));
  const identifier = plain(field('requisition_id')) || current.id;
  if (!title || title.length > 500 || /[<>]/u.test(title) || !company || company.length > 500 || /[<>]/u.test(company)
    || description.length < 500 || !location || identifier.length > 200) return [];
  const flags = ['isListed', 'is_listed', 'live', 'is_live', 'published', 'is_published', 'active'].map(field);
  if (flags.some(value => value !== undefined && typeof value !== 'boolean')) return [];
  const closedFlags = ['closed', 'is_closed'].map(field);
  if (closedFlags.some(value => value !== undefined && typeof value !== 'boolean')) return [];
  const status = field('status');
  if (status !== undefined && (typeof status !== 'string' || !/^(?:open|published|active|closed|unpublished|inactive|archived)$/iu.test(status))) return [];
  const deadlines = ['validThrough', 'application_deadline'].map(field).filter(value => value !== undefined && value !== null && value !== '');
  if (deadlines.some(value => typeof value !== 'string' || value.length > 100 || !Number.isFinite(Date.parse(value)))) return [];
  const validThrough = deadlines.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || '';
  const isListed = !flags.includes(false) && !closedFlags.includes(true) && !/^(?:closed|unpublished|inactive|archived)$/iu.test(status || '');
  const instant = typeof now === 'function' ? now() : now;
  return [{ title, employer: company, hiringOrganization: { name: company, sameAs: '' }, sameAs: '',
    location,
    salary: { text: '', provenance: 'unknown' }, identifier, validThrough, description,
    sourceUrl: declared.source.href, officialApplyUrl: declared.source.href, ats: '', tenant: '',
    isListed, live: isListed && Number.isFinite(instant) && (!validThrough || Date.parse(validThrough) >= instant) }];
}
