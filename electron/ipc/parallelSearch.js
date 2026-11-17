// Parallel Search for web research: the free keyless MCP server a research call may use, a
// plain (no-AI) search that turns a job into posting leads, and a plain page reader.
// Replaced Tavily 2026-11-14. Parallel's free MCP needs no key and publishes no rate limit or
// quota, and its tools never report remaining usage, so every call here fails soft (an empty
// result) and nothing polls for quota. The server is mcp.parallel.ai (the older
// search.parallel.ai is announced for discontinuation). With a platform API key the plain calls
// use the documented REST API (/v1/search, /v1/extract, x-api-key); without one they use the
// anonymous MCP. A rejected key (401/403) is dropped for ten minutes and the anonymous MCP is used. When a reply says Parallel itself is limiting (HTTP 429
// or 402, or limit wording in a tool-level error) the module stops calling it for ten minutes and
// web research pauses with its queued work kept (PARALLEL_SEARCH_EXHAUSTED). There is no fallback:
// this app never lets Claude use its built-in WebSearch/WebFetch, so research waits for credits.
// Measured 2026-11-14 (docs/ai-test-runs.md): Parallel alone matched built-in and Parallel merged, so research runs Parallel alone.
// The plain page reader (parallelExtract) only accepts a fresh read: Parallel otherwise falls back to a stored copy of a
// page whose live fetch failed, which can show a removed posting as live (measured 2026-11-15, docs/ai-test-runs.md entry
// 2026-11-15-render-vs-parallel). Never use that reader to decide whether a posting is open.
import crypto from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';

export const PARALLEL_MCP_URL = 'https://mcp.parallel.ai/mcp';
export const PARALLEL_REST_URL = 'https://api.parallel.ai';
// Optional: a Parallel API key from platform.parallel.ai. With one the plain calls use the REST API; without one the anonymous MCP is used.
export const PARALLEL_KEYCHAIN_SERVICE = 'infinite-canvas-parallel-api-key';
const SECURITY_BIN = '/usr/bin/security';
// The six research tools the server offers (tools/list, 2026-11-14: the same six with and without
// an API key). send_feedback is deliberately absent: it files a report with a third party.
export const PARALLEL_RESEARCH_TOOLS = Object.freeze([
  'mcp__parallel__web_search',
  'mcp__parallel__web_fetch',
  'mcp__parallel__web_decisions',
  'mcp__parallel__find_verticals',
  'mcp__parallel__search_vertical',
  'mcp__parallel__image_search',
]);
// Every tool of the Parallel MCP server carries this prefix.
const PARALLEL_TOOL_PREFIX = 'mcp__parallel__';
/** True for any tool of the Parallel MCP server: a limit in its result means research is paused. */
export function isParallelToolName(name) { return typeof name === 'string' && name.startsWith(PARALLEL_TOOL_PREFIX); }
export const PARALLEL_EXHAUSTED_CODE = 'PARALLEL_SEARCH_EXHAUSTED';
/** The error a Parallel limit turns into: the worker pauses and the queued work is kept. */
export function parallelExhaustedError() {
  return Object.assign(new Error('Parallel Search is out of usage. Research is paused.'), { code: PARALLEL_EXHAUSTED_CODE });
}
const PLAIN_LEADS = 4;
const QUERY_WORDS = 6;
const SEARCH_TIMEOUT_MS = 20_000;
const COOLDOWN_MS = 10 * 60_000;
// Limit wording. Deliberately not a bare "exceeded", which also appears in unrelated timeouts.
const LIMIT_WORDS = /rate[\s_-]*limit|quota|too many requests|usage limit|limit (?:reached|exceeded)/iu;
// Seen 2026-11-14 as a JSON-RPC error (code -32000): "You've hit the free-tier rate limit for Parallel MCP. ..."
export const PARALLEL_LIMIT_NOTICE = 'Parallel Search is out of usage (rate limit or credits), so web research is paused and queued work is kept. Add credits or an API key at platform.parallel.ai (Keychain item infinite-canvas-parallel-api-key), then press Resume; it also tries again every 10 minutes.';
export const PARALLEL_KEY_NOTICE = 'The Parallel API key in the Keychain item infinite-canvas-parallel-api-key was rejected, so research is using the free anonymous Parallel search. Replace the key (platform.parallel.ai). It tries the key again in about 10 minutes.';
let blockedUntil = 0;
let keyRejectedUntil = 0;
// Parallel uses this id for its free-tier rate limiting. One per app run, never derived from the user.
const SESSION_ID = crypto.randomBytes(16).toString('hex');

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

/** True while Parallel is being left alone after a limit signal. */
export function parallelBlocked(now = Date.now()) { return now < blockedUntil; }
/** True while a rejected API key is being left unused. */
export function parallelKeyRejected(now = Date.now()) { return now < keyRejectedUntil; }
/** The dock line while Parallel is blocked or its key was rejected, or null. */
export function parallelSearchNotice(now = Date.now()) {
  if (parallelBlocked(now)) return PARALLEL_LIMIT_NOTICE;
  return parallelKeyRejected(now) ? PARALLEL_KEY_NOTICE : null;
}
/** Forget a block and a rejected key (tests, and a manual retry). */
export function resetParallelLimit() { blockedUntil = 0; keyRejectedUntil = 0; }
/**
 * True when a reply says Parallel itself is limiting: HTTP 429 or 402, or limit wording in the
 * error text. A page that fails inside a normal reply (the `errors` list) never reaches this.
 */
export function isParallelLimitSignal({ status = 0, text = '' } = {}) {
  return status === 429 || status === 402 || LIMIT_WORDS.test(String(text ?? '').slice(0, 2000));
}
/**
 * Remember a limit signal: Parallel is left alone for ten minutes. `now` is the moment it was seen
 * (the worker passes it so its injected clock is honoured), defaulting to the real clock.
 */
export function noteParallelLimit({ status = 0, text = '' } = {}, now = Date.now()) {
  if (isParallelLimitSignal({ status, text })) blockedUntil = Math.max(blockedUntil, now + COOLDOWN_MS);
}

// A real key is one printable token. Anything else stored in the Keychain (a pasted sentence, a stray newline) is not a key and must never reach a header.
const validKey = text => (/^[\x21-\x7e]{16,200}$/u.test(text) ? text : '');

/** The API key from the login keychain, or '' when none is stored or the stored value is not key-shaped (the anonymous free endpoint is used then). */
export function readParallelKey({ execFile = nodeExecFile } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(SECURITY_BIN, ['find-generic-password', '-s', PARALLEL_KEYCHAIN_SERVICE, '-w'], { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? '' : validKey(String(stdout ?? '').trim()));
      });
    } catch { resolve(''); }
  });
}

/** The one MCP server a Parallel research call is given. A key goes in the Authorization header, never the URL. */
export function parallelMcpServers(key = '') {
  const useKey = validKey(String(key ?? '')) && !parallelKeyRejected();
  return { parallel: { type: 'http', url: PARALLEL_MCP_URL, ...(useKey ? { headers: { Authorization: `Bearer ${key}` } } : {}) } };
}

/** The tool result's JSON ({ payload }) or the text of a tool-level failure ({ error }), from a plain JSON reply or a one-event stream. */
function parseToolReply(text) {
  let message = null;
  try { message = JSON.parse(text); } catch {
    const events = String(text ?? '').split('\n').filter(line => line.startsWith('data:'));
    for (let index = events.length - 1; index >= 0 && !message; index -= 1) {
      try { message = JSON.parse(events[index].slice(5).trim()); } catch { /* try the previous event */ }
    }
  }
  const result = message?.result;
  const body = (Array.isArray(result?.content) ? result.content : []).map(part => String(part?.text ?? '')).join('');
  if (message?.error) return { error: String(message.error?.message ?? 'error') };
  if (!result) return {};
  if (result.isError === true) return { error: body || 'error' };
  try { return { payload: JSON.parse(body) }; } catch { return {}; }
}

/** Runs `run(abortSignal)` under the caller's abort signal and a timeout; both are released afterwards. */
async function withAbortAndTimeout({ signal, timeoutMs }, run) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, Number(timeoutMs) || SEARCH_TIMEOUT_MS));
  try {
    return await run(controller.signal);
  } catch { return null; } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

/** One anonymous Parallel MCP tool call, or null on any failure (network, non-ok, tool error, bad JSON). */
async function callTool({ name, args, fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS, now = Date.now }) {
  if (signal?.aborted || parallelBlocked(now())) return null;
  return withAbortAndTimeout({ signal, timeoutMs }, async (abortSignal) => {
    const response = await fetchImpl(PARALLEL_MCP_URL, {
      method: 'POST', signal: abortSignal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, session_id: SESSION_ID } } }),
    });
    const text = await Promise.resolve(response?.text?.()).catch(() => '');
    if (!response?.ok) { noteParallelLimit({ status: Number(response?.status) || 0, text }, now()); return null; }
    const { payload, error } = parseToolReply(text);
    if (error !== undefined) noteParallelLimit({ text: error }, now());
    return payload ?? null;
  });
}

const KEY_REJECTED = Symbol('parallel key rejected');

/** One REST call with the API key, the payload object, null on any failure, or KEY_REJECTED on a 401/403. */
async function callRest({ path, body, key, fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS, now = Date.now }) {
  if (signal?.aborted || parallelBlocked(now())) return null;
  return withAbortAndTimeout({ signal, timeoutMs }, async (abortSignal) => {
    const response = await fetchImpl(`${PARALLEL_REST_URL}${path}`, {
      method: 'POST', signal: abortSignal,
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ ...body, session_id: SESSION_ID }),
    });
    const text = await Promise.resolve(response?.text?.()).catch(() => '');
    const status = Number(response?.status) || 0;
    if (status === 401 || status === 403) { keyRejectedUntil = Math.max(keyRejectedUntil, now() + COOLDOWN_MS); return KEY_REJECTED; }
    if (!response?.ok) { noteParallelLimit({ status, text }, now()); return null; }
    try { const payload = JSON.parse(text); return payload && typeof payload === 'object' ? payload : null; } catch { return null; }
  });
}

/** One search or fetch: the REST API when a usable key is given, otherwise (or after the key is rejected) the anonymous MCP. */
async function callParallel({ tool, args, restPath, restBody, key = '', ...options }) {
  const usable = validKey(String(key ?? '')) && !parallelKeyRejected(options.now?.() ?? Date.now());
  if (usable) {
    const payload = await callRest({ path: restPath, body: restBody, key, ...options });
    if (payload !== KEY_REJECTED) return payload;
  }
  return callTool({ name: tool, args, ...options });
}

const firstWords = (text, count) => String(text ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, count).join(' ');

/**
 * Up to 4 employer-side https links for one research member, from a plain Parallel search:
 * no AI. Mirror job boards are dropped. Any failure returns [] (the AI lookups still run).
 */
export async function parallelPlainLeads({ member, key = '', fetch: fetchImpl = globalThis.fetch, signal, now } = {}) {
  const title = String(member?.title ?? '').trim();
  const poster = String(member?.poster ?? '').trim();
  if (!title) return [];
  const heading = firstWords(title, QUERY_WORDS);
  const search = {
    objective: `Find the employer's own job posting page for "${title}"${poster ? ` at ${poster}` : ''}, on the employer's careers site or its applicant system.`,
    search_queries: [`${heading} ${poster} job posting`.trim(), `${poster} careers ${heading}`.trim()],
  };
  const body = await callParallel({
    tool: 'web_search', args: search, restPath: '/v1/search', restBody: { ...search, mode: 'fast' }, key, fetch: fetchImpl, signal, now,
  });
  const leads = [];
  for (const result of Array.isArray(body?.results) ? body.results : []) {
    let url;
    try { url = new URL(String(result?.url ?? '')); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || isMirrorHost(url.hostname)) continue;
    if (!leads.includes(url.href)) leads.push(url.href);
    if (leads.length >= PLAIN_LEADS) break;
  }
  return leads;
}

/** Newest page copy the reader accepts: an older one is a stored copy, not a read. */
export const PARALLEL_EXTRACT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const pageMs = value => { if (typeof value !== 'string' || !value.trim()) return null; const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };

/**
 * The text of one page Parallel's fetch tool read, or '' when it could not read it. No AI: the
 * tool returns the page's own text. A site that blocks the app's download (a bot challenge, a
 * 403) often serves this reader the page anyway. A page that fails inside a successful reply
 * comes back under `errors`, not as a tool error, and is '' here too.
 * The reader only accepts a fresh read: Parallel otherwise falls back to a stored copy that can
 * show a removed posting as live (measured 2026-11-15, docs/ai-test-runs.md entry
 * 2026-11-15-render-vs-parallel). The REST call asks for a live fetch (fetch_policy, no cache
 * fallback); the anonymous MCP cannot, so the chosen result's `acquired_at` is checked against
 * PARALLEL_EXTRACT_MAX_AGE_MS here as well. Never use this reader to decide whether a posting is open.
 */
export async function parallelExtract({ url, key = '', fetch: fetchImpl = globalThis.fetch, signal, timeoutMs = 45_000, now } = {}) {
  let page;
  try { page = new URL(String(url ?? '')); } catch { return ''; }
  if (page.protocol !== 'https:' || page.username || page.password) return '';
  const objective = 'The full text of this job posting page.';
  const body = await callParallel({
    tool: 'web_fetch', args: { urls: [page.href], objective, full_content: true },
    restPath: '/v1/extract',
    restBody: { urls: [page.href], objective, advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true } } },
    key, fetch: fetchImpl, signal, timeoutMs, now,
  });
  if (!body) return '';
  const failed = Array.isArray(body.errors) ? body.errors : [];
  if (failed.some(entry => entry?.url && String(entry.url) === page.href)) return '';
  const results = Array.isArray(body.results) ? body.results : [];
  const result = results.find(entry => String(entry?.url ?? '') === page.href) || results[0];
  // An old stored copy is not a read; a missing or unparseable acquired_at is accepted as before.
  const acquiredAt = pageMs(result?.acquired_at);
  if (acquiredAt !== null && (typeof now === 'function' ? now() : Date.now()) - acquiredAt > PARALLEL_EXTRACT_MAX_AGE_MS) return '';
  return String(result?.full_content ?? '').trim();
}
