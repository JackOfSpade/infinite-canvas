// Public board inventory supplies navigation only. Each derived detail page
// still needs the ordinary fetched-body, account ownership and match checks.
import { parse } from 'parse5';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 32_768;
const MAX_JOBS = 512;
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const positiveId = value => (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value))
  && /^[1-9]\d{0,15}$/u.test(String(value)) ? String(value) : '';

function publicUrl(value, base) {
  try {
    if (typeof value !== 'string' || !value || value.length > 2_048 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
    const url = new URL(value, base);
    return url.protocol === 'https:' && url.hostname === 'recruiting.paylocity.com' && !url.username && !url.password && !url.port && !url.hash ? url : null;
  } catch { return null; }
}

function boardRoute(value) {
  const url = publicUrl(value); if (!url) return null;
  const account = new RegExp(`^/Recruiting/Jobs/All/(${UUID})(?:/[a-z0-9-]{1,250})?/?$`, 'iu').exec(url.pathname)?.[1];
  if (!account) return null;
  for (const key of url.searchParams.keys()) {
    const filter = url.searchParams.get(key);
    if (!['location', 'department'].includes(key) || url.searchParams.getAll(key).length !== 1 || filter.length > 256
      || [...filter].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  }
  return { url, account: account.toLowerCase() };
}

function scriptsIn(body) {
  const pending = [{ node: parse(body), depth: 0 }]; const scripts = []; let count = 0; let coverageIncomplete = false;
  while (pending.length) {
    const { node, depth } = pending.pop(); const children = node.childNodes || [];
    if (++count > MAX_NODES || depth > 50) { coverageIncomplete = true; continue; }
    if (node.tagName === 'script' && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const attrs = new Map((node.attrs || []).map(item => [item.name, item.value]));
      if (!attrs.has('src') && ['', 'text/javascript', 'application/javascript'].includes((attrs.get('type') || '').trim().toLowerCase())) {
        scripts.push(children.map(child => child.nodeName === '#text' ? child.value || '' : '').join(''));
      }
    }
    const remaining = Math.max(0, MAX_NODES - count - pending.length);
    if (children.length > remaining) coverageIncomplete = true;
    for (let at = Math.min(children.length, remaining) - 1; at >= 0; at--) pending.push({ node: children[at], depth: depth + 1 });
  }
  return { scripts, coverageIncomplete };
}

function boundedJson(value) {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++count > MAX_NODES || item.depth > 50) return 'limited';
    if (!item.value || typeof item.value !== 'object') continue;
    const entries = Object.entries(item.value);
    if (entries.some(([key]) => forbidden.has(key))) return 'invalid';
    if (count + pending.length + entries.length > MAX_NODES) return 'limited';
    for (let at = entries.length - 1; at >= 0; at--) pending.push({ value: entries[at][1], depth: item.depth + 1 });
  }
  return 'valid';
}

// This small lexer only locates a literal configuration assignment. Strings
// and comments are inert. Templates and slash expressions fail closed rather
// than attempting to interpret JavaScript or its regular-expression grammar.
function configTokens(text) {
  if (text.length > 65_536) return null;
  const tokens = []; let at = 0;
  while (at < text.length) {
    if (tokens.length >= MAX_NODES) return null;
    const char = text[at];
    if (/\s/u.test(char)) { at++; continue; }
    if (text.startsWith('//', at)) { const end = text.indexOf('\n', at + 2); at = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith('/*', at)) { const end = text.indexOf('*/', at + 2); if (end < 0) return null; at = end + 2; continue; }
    if (char === '`' || char === '/') return null;
    if (char === '"' || char === "'") {
      const quote = char; const start = ++at; let escaped = false; let end = -1;
      while (at < text.length) {
        if (text[at] === '\\') { escaped = true; at += 2; continue; }
        if (text[at] === quote) { end = at++; break; }
        if (text[at] === '\n' || text[at] === '\r') return null;
        at++;
      }
      if (end < 0) return null;
      tokens.push({ type: 'string', value: text.slice(start, end), escaped }); continue;
    }
    if (/[a-z0-9_$]/iu.test(char)) {
      const start = at++;
      while (at < text.length && /[a-z0-9_$]/iu.test(text[at])) at++;
      tokens.push({ type: 'word', value: text.slice(start, at) }); continue;
    }
    tokens.push({ type: 'punctuation', value: char }); at++;
  }
  return tokens;
}

function detailsBase(scripts, source) {
  const configs = scripts.filter(text => text.includes('ATSJobDetailsBaseUrl'));
  if (configs.length !== 1) return null;
  const tokens = configTokens(configs[0]); if (!tokens) return null;
  const positions = tokens.flatMap((token, index) => token.type === 'word' && token.value === 'ATSJobDetailsBaseUrl' ? [index] : []);
  if (positions.length !== 1) return null;
  const at = positions[0]; const value = tokens[at + 2];
  if (tokens[at - 2]?.type !== 'word' || tokens[at - 2]?.value !== 'window' || tokens[at - 1]?.value !== '.' || tokens[at + 1]?.value !== '='
    || value?.type !== 'string' || value.escaped || tokens[at + 3]?.value !== ';'
    || at > 2 && ![';', '{', '}'].includes(tokens[at - 3]?.value)) return null;
  const base = publicUrl(value.value, source);
  return base && base.origin === source.origin && /^\/Recruiting\/Jobs\/Details\/$/iu.test(base.pathname) && !base.search ? base : null;
}

/** Coverage uncertainty is not ownership, liveness or an exhaustive count. */
export function scanOfficialPostingPaylocityInventory({ body, sourceUrl } = {}) {
  const empty = () => ({ links: [], coverageIncomplete: false });
  const limited = () => ({ links: [], coverageIncomplete: true });
  if (typeof body !== 'string' || body.includes('\0') || Buffer.byteLength(body) > MAX_BYTES) return empty();
  const route = boardRoute(sourceUrl); if (!route) return empty();
  const parsed = scriptsIn(body); const { scripts } = parsed;
  const inventories = scripts.filter(text => /\bwindow\s*\.\s*pageData\b/u.test(text));
  if (inventories.length !== 1) return empty();
  const assignment = /^\s*window\.pageData\s*=\s*(\{[\s\S]*\})\s*;?\s*$/u.exec(inventories[0]);
  let data;
  try { data = assignment && JSON.parse(assignment[1]); } catch { return empty(); }
  if (!object(data) || data.ShowInternal !== false || !Array.isArray(data.Jobs)) return empty();
  const moduleId = positiveId(data.ModuleId); const lead = publicUrl(data.LeadJoinUrl, route.url);
  const account = lead && new RegExp(`^/Recruiting/PublicLeads/New/(${UUID})/?$`, 'iu').exec(lead.pathname)?.[1];
  if (!moduleId || !account || account.toLowerCase() !== route.account || lead.search) return empty();
  const base = detailsBase(scripts, route.url); if (!base) return empty();
  // Only an account-bound public inventory envelope can report a structural
  // limit. Do not inspect or export an unbounded subset as if it were complete.
  const structure = boundedJson(data);
  if (structure === 'invalid') return empty();
  if (parsed.coverageIncomplete || structure === 'limited' || data.Jobs.length > MAX_JOBS) return limited();
  const links = []; const ids = new Set();
  for (const job of data.Jobs) {
    const id = object(job) && positiveId(job.JobId);
    if (!id || job.IsInternal !== false || !object(job.JobLocation) || positiveId(job.JobLocation.ModuleId) !== moduleId || ids.has(id)) return empty();
    ids.add(id);
    links.push({ url: new URL(id, base).href, tag: 'data', attribute: 'Jobs.JobId' });
  }
  return { links, coverageIncomplete: false };
}

/** Ordered typed detail URLs, without a claim that a filtered board is complete. */
export function scanOfficialPostingPaylocityLinks(options) {
  return scanOfficialPostingPaylocityInventory(options).links;
}
