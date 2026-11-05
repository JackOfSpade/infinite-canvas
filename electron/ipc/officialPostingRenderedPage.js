import dns from 'node:dns/promises';
import net from 'node:net';
import { detectAntiBotSignal } from './antiBotDetector.js';
import { isPublicOfficialAddress } from './officialPostingFetch.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { withSharedProfileLock } from './sharedProfileLock.js';

// Many careers pages arrive empty until JavaScript runs, and neither a plain download nor the judges' WebFetch runs it.
// This opens one lead in a real browser and returns what a person would see. Transport only: the judges still decide.
// The page is untrusted and its address came from an AI or another page, so it gets a throwaway session with none of the
// user's logins and the plain download's public-address rule for its requests. Chrome resolves addresses itself, so what
// actually answered is checked too, and a page that reached a non-public address returns nothing.

export const RENDER_FAILURES = Object.freeze(['aborted', 'blocked', 'browser-unavailable', 'busy', 'empty', 'load-failed', 'unsafe-address']);
const LOCK_WAIT_MS = 90_000;
const BUSY_COOLDOWN_MS = 5 * 60_000;
const VISIT_MS = 45_000;
const NAVIGATION_MS = 25_000;
const SETTLE_MAX_MS = 15_000;
const QUIET_MS = 1_500;
const STUCK_REQUEST_QUIET_MS = 5_000;
const POLL_MS = 250;
export const MIN_RENDERED_CHARS = 200;
const MAX_TEXT_CHARS = 300_000;
const MAX_FRAMES = 20;
const MAX_FRAME_CHARS = 40_000;
const MIN_FRAME_WIDTH = 100;
const MIN_FRAME_HEIGHT = 50;
const READ_ATTEMPTS = 4;
const READ_RETRY_MS = 1_000;
const MAX_HTML_CHARS = 3_000_000;
const SKIPPED_TYPES = new Set(['image', 'media', 'font', 'ping', 'eventsource', 'websocket', 'manifest']);
const WATCHED_TYPES = new Set(['xhr', 'fetch', 'document', 'script']);

const failure = reason => ({ ok: false, reason });
const codeError = code => Object.assign(new Error(code), { code });

async function abortable(promise, signal) {
  if (signal?.aborted) { promise?.catch?.(() => {}); throw codeError('aborted'); }
  let onAbort;
  const cancelled = new Promise((_, reject) => { onAbort = () => reject(codeError('aborted')); signal?.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal?.removeEventListener('abort', onAbort); promise?.catch?.(() => {}); }
}

/** The plain download's rule, per host, remembered for one visit. Fails closed. */
export function publicHostCheck({ lookup = dns.lookup } = {}) {
  const hosts = new Map();
  const check = async host => {
    const name = host.replace(/^\[|\]$/gu, '');
    if (net.isIP(name)) return isPublicOfficialAddress(name);
    try {
      const rows = await lookup(name, { all: true, verbatim: true });
      const list = Array.isArray(rows) ? rows : [rows];
      return list.length > 0 && list.every(row => isPublicOfficialAddress(row?.address));
    } catch { return false; }
  };
  return value => {
    let url;
    try { url = new URL(value); } catch { return Promise.resolve(false); }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.href === 'about:blank') return Promise.resolve(true);
    if (url.protocol !== 'https:') return Promise.resolve(false);
    if (!hosts.has(url.hostname)) hosts.set(url.hostname, check(url.hostname));
    return hosts.get(url.hostname);
  };
}

/** Waits until the visible text stops changing and the page's data requests are done. Pure timing, so it takes its readers. */
export async function waitForPageToSettle({ textLength, pendingRequests, signal, now = Date.now, sleep,
  maxMs = SETTLE_MAX_MS, quietMs = QUIET_MS, stuckQuietMs = STUCK_REQUEST_QUIET_MS, pollMs = POLL_MS } = {}) {
  const pause = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(); let length = -1; let changedAt = started;
  while (now() - started < maxMs) {
    const current = await abortable(textLength(), signal);
    if (current !== length) { length = current; changedAt = now(); }
    const quiet = now() - changedAt;
    // Some pages keep a request open forever, so a long quiet spell with real text also counts.
    if (length > 0 && ((quiet >= quietMs && pendingRequests() === 0) || (quiet >= stuckQuietMs && length >= MIN_RENDERED_CHARS))) return true;
    await abortable(pause(pollMs), signal);
  }
  return false;
}

async function visit(browser, url, { signal, isPublicUrl }) {
  let context;
  try {
    // A context that arrives after the visit gave up still has to close.
    const creating = browser.createBrowserContext();
    try { context = await abortable(creating, signal); }
    catch (error) { creating.then(late => late.close()).catch(() => {}); throw error; }
    const page = await abortable(context.newPage(), signal);
    // Request interception does not reach shared workers or service workers, so the page cannot have them.
    await abortable(page.evaluateOnNewDocument(() => {
      delete window.SharedWorker;
      delete window.Navigator.prototype.serviceWorker;
    }), signal);
    page.on('dialog', dialog => { dialog.dismiss().catch(() => {}); });
    await abortable(page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }), signal);
    await abortable(page.setBypassServiceWorker(true), signal);
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable');
      // Request interception cannot see these.
      await cdp.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] });
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
    } catch { /* A protocol change only loses these two extra limits. */ }
    const pending = new Set(); let unsafeNavigation = false; let reachedNonPublic = false;
    // A page can navigate itself after it starts loading (a challenge, a locale redirect), so the last document answer counts.
    let documentStatus = 0;
    page.on('response', response => {
      const address = response.remoteAddress?.()?.ip;
      if (address && !isPublicOfficialAddress(address.replace(/^\[|\]$/gu, ''))) reachedNonPublic = true;
      const request = response.request?.();
      if (request?.isNavigationRequest?.() && request.frame?.() === page.mainFrame()) documentStatus = response.status();
    });
    await abortable(page.setRequestInterception(true), signal);
    page.on('request', request => {
      const type = request.resourceType();
      const finish = async () => {
        if (SKIPPED_TYPES.has(type)) return request.abort('blockedbyclient');
        if (!(await isPublicUrl(request.url()))) {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) unsafeNavigation = true;
          return request.abort('blockedbyclient');
        }
        if (WATCHED_TYPES.has(type)) pending.add(request);
        return request.continue();
      };
      finish().catch(() => { pending.delete(request); });
    });
    const done = request => pending.delete(request);
    page.on('requestfinished', done); page.on('requestfailed', done);
    let response = null;
    try { response = await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_MS }), signal); }
    catch (error) {
      if (error?.code === 'aborted') throw error;
      return failure(unsafeNavigation || reachedNonPublic ? 'unsafe-address' : 'load-failed');
    }
    if (unsafeNavigation || reachedNonPublic) return failure('unsafe-address');
    const currentStatus = () => documentStatus || (typeof response?.status === 'function' ? response.status() : 0);
    const finalUrl = officialHttpsUrl(page.url());
    if (!finalUrl) return failure('load-failed');
    if (currentStatus() === 404 || currentStatus() === 410) return { ok: true, status: currentStatus(), finalUrl, settled: true, title: '', text: '', html: '' };
    // A navigation destroys the document being read, which only means there is more page to wait for.
    const settled = await waitForPageToSettle({ signal, pendingRequests: () => pending.size,
      textLength: () => page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0) });
    let seen = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS && !seen; attempt += 1) {
      if (attempt) await abortable(new Promise(resolve => setTimeout(resolve, READ_RETRY_MS)), signal);
      seen = await abortable(page.evaluate(limits => ({ title: document.title || '',
        text: (document.body?.innerText || '').slice(0, limits.text),
        html: (document.documentElement?.outerHTML || '').slice(0, limits.html) }),
      { text: MAX_TEXT_CHARS, html: MAX_HTML_CHARS }).catch(() => null), signal);
    }
    if (!seen) return failure('load-failed');
    const status = currentStatus();
    if (reachedNonPublic) return failure('unsafe-address');
    // Application forms are often embedded. The page's own text, unedited, frame by frame.
    for (const frame of (page.frames?.() || []).filter(item => item !== page.mainFrame()).slice(0, MAX_FRAMES)) {
      try {
        // Only what a person can see: pages also carry hidden frames full of tracking and consent data.
        const box = await abortable(frame.frameElement().then(element => element?.boundingBox() ?? null), signal);
        if (!box || box.width < MIN_FRAME_WIDTH || box.height < MIN_FRAME_HEIGHT) continue;
        const framed = await abortable(frame.evaluate(() => document.body?.innerText || ''), signal);
        if (framed.trim()) seen.text = `${seen.text}\n\n[Embedded frame: ${frame.url()}]\n${framed.slice(0, MAX_FRAME_CHARS)}`.slice(0, MAX_TEXT_CHARS);
      } catch { /* A frame that navigated away holds nothing to read. */ }
    }
    const wall = detectAntiBotSignal({ status, finalUrl, html: seen.html, title: seen.title });
    if (wall?.severity === 'block') return failure('blocked');
    return { ok: true, status, finalUrl: officialHttpsUrl(page.url()) || finalUrl, settled, ...seen };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

let busyUntil = 0;
// One page at a time asks for the browser, so the wait below measures other work holding it, not this lookup's own queue.
const renderQueue = [];
let rendering = false;
async function drainRenderQueue() {
  if (rendering) return;
  rendering = true;
  try {
    while (renderQueue.length) {
      const next = renderQueue.shift();
      try { next.resolve(await renderOnePage(next.url, next.options)); } catch (error) { next.reject(error); }
    }
  } finally { rendering = false; }
}
/** For tests. */
export function _resetOfficialPostingRenderForTests() { busyUntil = 0; renderQueue.length = 0; }

/**
 * One lead, opened in a browser. Never throws: a failure means only that this attempt saw nothing.
 * Browser work is shared with Job Search and marketplace scraping, so it queues; when that work holds the browser for a
 * long time the lookup carries on with the plain downloads rather than waiting behind every lead.
 */
export async function renderOfficialPostingPage(value, options = {}) {
  const url = officialHttpsUrl(value);
  if (!url) return failure('unsafe-address');
  const turn = new Promise((resolve, reject) => {
    const entry = { url, options, resolve, reject };
    // Someone waiting on one card goes ahead of a queued Board, behind others also waiting.
    const at = options.priority ? renderQueue.findIndex(item => !item.options.priority) : -1;
    if (at >= 0) renderQueue.splice(at, 0, entry); else renderQueue.push(entry);
  });
  void drainRenderQueue();
  try { return await abortable(turn, options.signal); }
  catch { return failure(options.signal?.aborted ? 'aborted' : 'load-failed'); }
}

async function renderOnePage(url, { signal, now = Date.now, getBrowser, isPublicUrl = publicHostCheck(), withLock = withSharedProfileLock } = {}) {
  if (signal?.aborted) return failure('aborted');
  if (now() < busyUntil) return failure('busy');
  if (!(await isPublicUrl(url))) return failure('unsafe-address');
  const waiting = new AbortController();
  const stopWaiting = () => waiting.abort();
  signal?.addEventListener('abort', stopWaiting, { once: true });
  const lockTimer = setTimeout(stopWaiting, LOCK_WAIT_MS);
  try {
    return await withLock(async () => {
      clearTimeout(lockTimer);
      const browse = getBrowser || (async () => (await import('./stealthBrowser.js')).getStealthBrowser());
      let browser;
      try { browser = await abortable(browse(), signal); }
      catch (error) { return failure(error?.code === 'aborted' ? 'aborted' : 'browser-unavailable'); }
      const visitLimit = new AbortController();
      const stopVisit = () => visitLimit.abort();
      signal?.addEventListener('abort', stopVisit, { once: true });
      const visitTimer = setTimeout(stopVisit, VISIT_MS);
      try { return await visit(browser, url, { signal: visitLimit.signal, isPublicUrl }); }
      catch (error) { return failure(error?.code === 'aborted' && signal?.aborted ? 'aborted' : 'load-failed'); }
      finally { clearTimeout(visitTimer); signal?.removeEventListener('abort', stopVisit); }
    }, waiting.signal, 'official-posting-render');
  } catch {
    if (signal?.aborted) return failure('aborted');
    busyUntil = now() + BUSY_COOLDOWN_MS;
    return failure('busy');
  } finally {
    clearTimeout(lockTimer);
    signal?.removeEventListener('abort', stopWaiting);
  }
}

/** One lookup opens each address once, however many rows share it (a company's careers page, usually). Failures are not kept. */
export function createOfficialPostingRenderSession(render) {
  const opened = new Map();
  return (url, options) => {
    if (!opened.has(url)) {
      const visit = Promise.resolve().then(() => render(url, options)).catch(() => failure('load-failed'));
      opened.set(url, visit);
      visit.then(result => { if (!result?.ok) opened.delete(url); });
    }
    return opened.get(url);
  };
}
