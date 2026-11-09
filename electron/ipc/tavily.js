// Tavily for web research: the API key from the login keychain, the Tavily MCP server
// a research call may use, and a plain (no-AI) search that turns a job into posting leads.
// Measured 2026-11-08 on official-posting research (30 confirmed postings): Claude with
// Tavily found 21, Claude's built-in search 17, both 25, and adding these plain leads 26.
// The key is never logged, never put in an error, and only ever leaves this module inside
// the MCP server URL or the request header Tavily requires.
import { execFile as nodeExecFile } from 'node:child_process';

export const TAVILY_KEYCHAIN_SERVICE = 'infinite-canvas-tavily-api-key';
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
export const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
export const TAVILY_MCP_URL = 'https://mcp.tavily.com/mcp/';
export const TAVILY_RESEARCH_TOOLS = Object.freeze(['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract']);
const SECURITY_BIN = '/usr/bin/security';
const PLAIN_LEADS = 4;
const SEARCH_TIMEOUT_MS = 20_000;

// Job boards and aggregators that only mirror an employer's posting. A plain lead list
// drops them; the employer site or its applicant system is what the lookup is after.
const MIRROR_DOMAINS = Object.freeze([
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'glassdoor.ca', 'ziprecruiter.com', 'monster.com', 'simplyhired.com',
  'talent.com', 'jooble.org', 'builtin.com', 'wellfound.com', 'dice.com', 'careerbuilder.com', 'jobgether.com',
  'remoterocketship.com', 'levels.fyi', 'otta.com', 'welcometothejungle.com', 'bebee.com', 'jobrapido.com', 'adzuna.com',
  'adzuna.ca', 'workopolis.com', 'eluta.ca', 'jobbank.gc.ca', 'himalayas.app', 'remotive.com', 'weworkremotely.com',
  'jobleads.com', 'lensa.com', 'tealhq.com', 'hiring.cafe', 'startup.jobs', 'workatastartup.com', 'jobs.google.com',
  'learn4good.com', 'jobilize.com', 'careerjet.com', 'careerjet.ca', 'recruit.net', 'trabajo.org', 'whatjobs.com',
  'theladders.com', 'applymaster.ai', 'jobright.ai', 'teal.com',
]);

/** True for a known job board or aggregator domain (or a subdomain of one), never for an employer site. */
export function isMirrorHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/u, '');
  return MIRROR_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/** The key, or '' when none is stored (Tavily is then simply not used). */
export function readTavilyKey({ execFile = nodeExecFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(SECURITY_BIN, ['find-generic-password', '-s', TAVILY_KEYCHAIN_SERVICE, '-w'], { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? '' : String(stdout ?? '').trim());
      });
    } catch { resolve(''); }
  });
}

/** The one MCP server a Tavily research call is given. */
export function tavilyMcpServers(key) {
  return { tavily: { type: 'http', url: `${TAVILY_MCP_URL}?tavilyApiKey=${encodeURIComponent(key)}` } };
}

/**
 * Up to 4 employer-side https links for one research member, from a plain Tavily search:
 * no AI. Mirror job boards are dropped. Any failure returns [] (the AI lookups still run).
 */
export async function tavilyPlainLeads({ key, member, fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  const title = String(member?.title ?? '').trim();
  const poster = String(member?.poster ?? '').trim();
  if (!key || !title) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(abort, SEARCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: `${title} ${poster} job posting`.trim(), search_depth: 'advanced', max_results: 10 }),
    });
    if (!response?.ok) return [];
    const body = await response.json();
    const leads = [];
    for (const result of Array.isArray(body?.results) ? body.results : []) {
      let url;
      try { url = new URL(String(result?.url ?? '')); } catch { continue; }
      if (url.protocol !== 'https:' || url.username || url.password || isMirrorHost(url.hostname)) continue;
      if (!leads.includes(url.href)) leads.push(url.href);
      if (leads.length >= PLAIN_LEADS) break;
    }
    return leads;
  } catch { return []; } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

/**
 * The text of one page Tavily's extract API read, or '' when it could not read it. No AI: the
 * API returns the page's own text. A site that blocks the app's download (a bot challenge, a
 * 403) often serves this reader the page anyway. Any failure is '' and the key never leaks.
 */
export async function tavilyExtract({ key, url, fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = 20_000 } = {}) {
  if (!key) return '';
  let page;
  try { page = new URL(String(url ?? '')); } catch { return ''; }
  if (page.protocol !== 'https:' || page.username || page.password) return '';
  if (signal?.aborted) return '';
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, Number(timeoutMs) || 20_000));
  try {
    const response = await fetchImpl(TAVILY_EXTRACT_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ urls: [page.href], extract_depth: 'advanced', format: 'markdown' }),
    });
    if (!response?.ok) return '';
    const body = await response.json();
    const failed = Array.isArray(body?.failed_results) ? body.failed_results : [];
    // A url the API could not read comes back under failed_results, not as text.
    if (failed.some(entry => entry?.url && String(entry.url) === page.href)) return '';
    const result = Array.isArray(body?.results) ? body.results.find(entry => String(entry?.url ?? '') === page.href) || body.results[0] : null;
    const text = String(result?.raw_content ?? '').trim();
    return text || '';
  } catch { return ''; } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}
