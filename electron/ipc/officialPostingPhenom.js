import { https, MAX_BYTES } from './officialPostingCareersCms.js';

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
