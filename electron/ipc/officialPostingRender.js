// Careers sites sometimes construct their ATS links in JavaScript. Render only
// public, host-fetched bytes in a disposable browser: Chromium never performs
// its own network requests, and no authenticated browser profile is involved.
import fs from 'node:fs/promises';
import { fetchOfficialPosting, officialPostingFetchUrl, OfficialPostingFetchError, OFFICIAL_FETCH_MAX_BYTES, OFFICIAL_FETCH_SCRIPT_MAX_BYTES } from './officialPostingFetch.js';
import { extractAtsTenant } from './officialSourceHosts.js';
import { officialPostingResourceHeaders } from './officialPostingResourceHeaders.js';
import { deriveOfficialPostingReadOnlyAjaxRequest, validateOfficialPostingReadOnlyAjaxResponse } from './officialPostingReadOnlyAjax.js';
import { deriveOfficialPostingReadOnlySearchRequest, isOfficialPostingReadOnlySearchUrl, parseOfficialPostingReadOnlySearchResponse,
  officialPostingReadOnlySearchCoverageIncomplete } from './officialPostingReadOnlySearch.js';
import { scanOfficialPostingFetchPreloads } from './officialPostingFetchPreloads.js';

export const OFFICIAL_RENDER_MAX_REQUESTS = 128;
export const OFFICIAL_RENDER_MAX_BYTES = 18 * 1024 * 1024;
export const OFFICIAL_RENDER_TIMEOUT_MS = 25_000;
// Post-response hydration settle: quiet window, poll step and hard cap (virtual ms, advanced only by page waits).
const SETTLE_QUIET_MS = 300; const SETTLE_STEP_MS = 100; const SETTLE_CAP_MS = 3_500;
const ALLOWED_TYPES = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
const TRACKER_HOSTS = ['googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'googleadservices.com',
  'facebook.net', 'facebook.com', 'bing.com', 'clarity.ms', 'segment.com', 'segment.io', 'amplitude.com',
  'hotjar.com', 'hotjar.io', 'fullstory.com', 'hubspot.com', 'hs-scripts.com', 'hs-analytics.net',
  'pardot.com', 'pingdom.net', 'demandbase.com', 'clearbit.com', '6sense.com', 'heapanalytics.com', 'adroll.com'];
const MEDIA_EMBED_HOSTS = ['player.vimeo.com', 'youtube.com', 'youtube-nocookie.com', 'youtu.be',
  'fast.wistia.net', 'fast.wistia.com', 'videodelivery.net'];
function trackingResource(value) {
  try { const host = new URL(value).hostname;
    return TRACKER_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`)); } catch { return false; }
}
function mediaEmbed(value) {
  try { const host = new URL(value).hostname;
    return MEDIA_EMBED_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`)); } catch { return false; }
}
function otherNextPageData(value, documentUrl) {
  try {
    const target = new URL(value); const current = new URL(documentUrl);
    if (target.origin !== current.origin) return false;
    const next = /^\/_next\/data\/[^/]+\/(.+)\.json$/u.exec(target.pathname)?.[1];
    if (!next) return false;
    const path = input => {
      const parts = input.split('/').filter(Boolean);
      if (/^[a-z]{2,3}(?:-[a-z]{2})?$/iu.test(parts[0] || '')) parts.shift();
      if (parts.at(-1) === 'index') parts.pop();
      return parts.join('/');
    };
    return path(next) !== path(current.pathname);
  } catch { return false; }
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  const paths = [chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  for (const executablePath of paths) {
    try { await fs.access(executablePath); }
    catch { continue; }
    return chromium.launch({ executablePath, headless: true,
      // Any route the interceptor does not handle fails closed at a dead local
      // proxy. Only the pinned Node transport below can reach public hosts.
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
        '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  }
  throw new OfficialPostingFetchError('fetch-failed');
}

export async function renderOfficialCareersPage(value, {
  fetch = fetchOfficialPosting, signal, initialPage, launch = launchBrowser,
} = {}) {
  const url = officialPostingFetchUrl(value).href;
  if (/(?:^|\.)(?:test|example|invalid|localhost)$/iu.test(new URL(url).hostname)) throw new OfficialPostingFetchError('unsafe-url');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new OfficialPostingFetchError('fetch-timeout')), OFFICIAL_RENDER_TIMEOUT_MS);
  timer.unref?.();
  let browser; let context; let mainPage; let requests = 0; let bytes = 0; let documentPage; let failure; let incomplete = false;
  const resourceLinks = new Set();
  const fetchPreloads = new Set();
  let pendingPreloads = 0;
  let usefulResource;
  const sourceReady = new Promise(resolve => { usefulResource = resolve; });
  const inFlight = new Set();
  let routed = 0; let active = 0;
  const fail = code => { failure ||= new OfficialPostingFetchError(code); controller.abort(failure); };
  const interrupted = () => controller.signal.reason instanceof OfficialPostingFetchError
    ? controller.signal.reason : new OfficialPostingFetchError('bridge-aborted');
  const close = () => { void context?.close().catch(() => {}); void browser?.close().catch(() => {}); };
  const bounded = promise => new Promise((resolve, reject) => {
    const stopped = () => { cleanup(); reject(interrupted()); };
    const cleanup = () => controller.signal.removeEventListener('abort', stopped);
    if (controller.signal.aborted) { reject(interrupted()); return; }
    controller.signal.addEventListener('abort', stopped, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  controller.signal.addEventListener('abort', close, { once: true });
  try {
    if (controller.signal.aborted) throw interrupted();
    const launching = Promise.resolve().then(launch);
    void launching.then(value => { if (controller.signal.aborted) void value?.close().catch(() => {}); }, () => {});
    browser = await bounded(launching);
    if (controller.signal.aborted) throw interrupted();
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.addInitScript(() => {
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const handleRoute = async route => {
      const request = route.request();
      const mainNavigation = request.isNavigationRequest() && request.frame() === mainPage?.mainFrame();
      const headers = request.headers?.() || {};
      const speculative = /\bprefetch\b/iu.test(`${headers.purpose || ''} ${headers['sec-purpose'] || ''}`)
        || headers['next-router-prefetch'] === '1' || headers['x-middleware-prefetch'] === '1';
      let unrelatedPageData = false;
      try { unrelatedPageData = otherNextPageData(request.url(), request.frame().url()); } catch { /* detached frame */ }
      // Capture the initiator before awaiting its transfer. A later top-level
      // navigation cannot reattribute another site's requests to this employer.
      let ownInitiator = false;
      try { ownInitiator = request.frame() === mainPage?.mainFrame() && new URL(request.frame().url()).origin === new URL(url).origin; } catch { /* about:blank or detached frame */ }
      let ownResource = false;
      try { ownResource = ownInitiator && new URL(request.url()).origin === new URL(url).origin; } catch { /* Invalid routes fail closed below. */ }
      const declaredFetchPreload = ownResource && request.method() === 'GET' && request.resourceType() === 'other'
        && fetchPreloads.has(request.url());
      // Preflights are answered locally. The ensuing POST still has to match
      // the complete public read schema, and only pinned GETs leave the host.
      if (ownInitiator && request.method() === 'OPTIONS' && isOfficialPostingReadOnlySearchUrl(request.url())
        && headers['access-control-request-method'] === 'POST'
        && String(headers['access-control-request-headers'] || '').split(',').every(name =>
          ['content-type', 'x-algolia-application-id', 'x-algolia-api-key', 'x-algolia-agent'].includes(name.trim().toLowerCase()))) {
        await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': new URL(url).origin,
          'access-control-allow-methods': 'POST', 'access-control-allow-headers': headers['access-control-request-headers'] || 'content-type' } });
        return;
      }
      let ajaxPlan; let searchPlan;
      if (ownInitiator && request.method() === 'POST' && ['xhr', 'fetch'].includes(request.resourceType())
        && !trackingResource(request.url())) {
        const input = { url: request.url(), documentUrl: request.frame().url(), headers, body: request.postData?.() };
        ajaxPlan = ownResource && deriveOfficialPostingReadOnlyAjaxRequest(input);
        searchPlan = !ajaxPlan && deriveOfficialPostingReadOnlySearchRequest(input);
      }
      const readPlan = ajaxPlan || searchPlan;
      const popupNavigation = request.isNavigationRequest() && !request.frame().parentFrame() && !mainNavigation;
      if (controller.signal.aborted || popupNavigation || request.method() !== 'GET' && !readPlan
        || !ALLOWED_TYPES.has(request.resourceType()) && !declaredFetchPreload
        || !mainNavigation && (speculative || unrelatedPageData || trackingResource(request.url()) || mediaEmbed(request.url()))) {
        if (ownInitiator && ['xhr', 'fetch'].includes(request.resourceType()) && request.method() !== 'GET'
          && !speculative && !trackingResource(request.url())) incomplete = true;
        if (declaredFetchPreload) incomplete = true;
        await route.abort().catch(() => {}); return;
      }
      if (++requests > OFFICIAL_RENDER_MAX_REQUESTS) { fail('crawl-budget'); await route.abort().catch(() => {}); return; }
      if (declaredFetchPreload) pendingPreloads++;
      const task = (async () => {
        try {
          const requestedUrl = officialPostingFetchUrl(request.url()).href;
          let source;
          if (readPlan) {
            const read = async (target, publicSearchHeaders) => {
              if (++requests > OFFICIAL_RENDER_MAX_REQUESTS) throw new OfficialPostingFetchError('crawl-budget');
              const page = await fetch(target, { signal: controller.signal, resource: true, publicSearchHeaders });
              if (typeof page?.body !== 'string' || page.statusCode !== 200) throw new OfficialPostingFetchError('fetch-failed');
              const size = Buffer.byteLength(page.body, 'utf8'); bytes += size;
              if (size > OFFICIAL_FETCH_MAX_BYTES || bytes > OFFICIAL_RENDER_MAX_BYTES) throw new OfficialPostingFetchError('oversize');
              return page;
            };
            if (ajaxPlan) source = validateOfficialPostingReadOnlyAjaxResponse(ajaxPlan, await read(ajaxPlan.url));
            else {
              const pages = [];
              for (const item of searchPlan.requests) pages.push(await read(item.url, item.headers));
              const body = parseOfficialPostingReadOnlySearchResponse(searchPlan, pages);
              if (body) {
                // A search page can expose valid links without exhausting the
                // employer's inventory. It cannot establish a settled miss.
                if (officialPostingReadOnlySearchCoverageIncomplete(searchPlan, body)) incomplete = true;
                source = { body, contentType: 'application/json', statusCode: 200 };
              }
            }
            if (!source) throw new OfficialPostingFetchError('fetch-failed');
            // This is the browser's original read response, not a redirect or
            // ownership receipt for a generated search URL or public key.
            source = { ...source, url: requestedUrl, sourceUrl: requestedUrl };
          } else source = initialPage && requestedUrl === url && mainNavigation && headers.rsc !== '1' && headers['x-nextjs-data'] !== '1' ? initialPage
            : await fetch(requestedUrl, { signal: controller.signal, resource: true, resourceHeaders: officialPostingResourceHeaders(headers) });
          const finalUrl = officialPostingFetchUrl(source?.url || source?.sourceUrl).href;
          if (source?.statusCode !== 200 || typeof source.body !== 'string') throw new OfficialPostingFetchError('fetch-failed');
          const size = Buffer.byteLength(source.body, 'utf8');
          if (!readPlan) bytes += size;
          const script = request.resourceType() === 'script' && /javascript|ecmascript/u.test(source.contentType);
          if (size > (script ? OFFICIAL_FETCH_SCRIPT_MAX_BYTES : OFFICIAL_FETCH_MAX_BYTES) || bytes > OFFICIAL_RENDER_MAX_BYTES) throw new OfficialPostingFetchError('oversize');
          if (finalUrl !== requestedUrl) {
            // The redirect target has already passed pinned fetch validation;
            // route it again so browser URL/origin semantics stay accurate.
            await route.fulfill({ status: 302, headers: { location: finalUrl } }); return;
          }
          if (mainNavigation) {
            documentPage = source;
            fetchPreloads.clear();
            if (/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(source.contentType || '')) {
              const preloads = scanOfficialPostingFetchPreloads({ body: source.body, sourceUrl: finalUrl });
              if (preloads.coverageIncomplete) incomplete = true;
              for (const target of preloads.urls) fetchPreloads.add(target);
            }
          }
          if (!readPlan && ownInitiator && ['xhr', 'fetch'].includes(request.resourceType())
            && /^(?:application\/(?:json|ld\+json))$/u.test(source.contentType)) {
            resourceLinks.add(finalUrl);
          }
          await route.fulfill({ status: 200, contentType: source.contentType, body: source.body,
            headers: { 'cache-control': 'no-store', ...(searchPlan ? { 'access-control-allow-origin': new URL(url).origin } : {}) } });
          // Ready only once the browser holds the response; the page still has to parse it.
          if (!readPlan && ownInitiator && ['xhr', 'fetch'].includes(request.resourceType())
            && /^(?:application\/(?:json|ld\+json))$/u.test(source.contentType) && extractAtsTenant(finalUrl)) usefulResource();
        } catch (error) {
          if (error?.code === 'oversize') fail('oversize');
          if (readPlan) fail(error?.code === 'crawl-budget' ? 'crawl-budget' : 'fetch-failed');
          if (mainNavigation) failure = error;
          else if (declaredFetchPreload || ownResource && ['script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())
            || ownInitiator && ['script', 'stylesheet'].includes(request.resourceType())) incomplete = true;
          await route.abort().catch(() => {});
        }
      })();
      inFlight.add(task);
      try { await task; } finally { inFlight.delete(task); if (declaredFetchPreload) pendingPreloads--; }
    };
    await context.route('**/*', async route => {
      routed++; active++;
      try { await handleRoute(route); } finally { active--; }
    });
    const page = await context.newPage(); mainPage = page;
    page.on('popup', popup => { void popup.close(); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OFFICIAL_RENDER_TIMEOUT_MS });
    // Job lists commonly hydrate only when their section enters the viewport.
    // Reading a few bounded positions activates that normal read-only path.
    if (page.evaluate) for (const fraction of [0.25, 0.5, 0.75, 1]) {
      if (controller.signal.aborted) throw interrupted();
      try {
        await page.evaluate(part => window.scrollTo(0, Math.max(0,
          (document.documentElement.scrollHeight - window.innerHeight) * part)), fraction);
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Frame was detached/iu.test(String(error?.message))) throw error;
        await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(80);
    }
    // Analytics can keep a careers page busy long after its authoritative job
    // link is ready. Finish on that evidence rather than waiting on trackers.
    const linkedSource = page.evaluate ? (async () => {
      const started = Date.now();
      while (!controller.signal.aborted && Date.now() - started < 8_000) {
        let links;
        try { links = await page.evaluate(() => [...document.querySelectorAll('a[href],iframe[src]')].slice(0, 2048).map(node => {
          try { return new URL(node.getAttribute('href') || node.getAttribute('src'), document.baseURI).href; } catch { return ''; }
        })); } catch {
          if (controller.signal.aborted) return;
          await page.waitForTimeout(200); continue;
        }
        if (links.some(link => extractAtsTenant(link))) return;
        await page.waitForTimeout(200);
      }
    })().catch(() => {}) : null;
    await Promise.race([sourceReady, page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {}),
      ...(linkedSource ? [linkedSource] : [])]);
    // Hydration (e.g. client-injected JobPosting JSON-LD) runs after the last
    // response. Wait for no routed request in flight or newly started and a
    // stable DOM for a quiet window; the cap, abort signal and request/byte
    // caps still apply. A cap hit while still busy only blocks negatives.
    const domSize = async () => {
      if (!page.evaluate) return null;
      try { const size = await page.evaluate(() => document.documentElement.outerHTML.length); return Number.isFinite(size) ? size : null; }
      catch { return null; }
    };
    let quiet = 0; let waited = 0; let seen = routed; let lastSize = await domSize();
    while (quiet < SETTLE_QUIET_MS) {
      if (controller.signal.aborted) throw interrupted();
      if (waited >= SETTLE_CAP_MS) { incomplete = true; break; }
      await page.waitForTimeout(SETTLE_STEP_MS); waited += SETTLE_STEP_MS;
      const size = await domSize();
      const busy = active > 0 || routed !== seen || size !== null && lastSize !== null && size !== lastSize;
      seen = routed; if (size !== null) lastSize = size;
      quiet = busy ? 0 : quiet + SETTLE_STEP_MS;
    }
    if (controller.signal.aborted) throw interrupted();
    if (!documentPage) throw failure || new OfficialPostingFetchError('fetch-failed');
    const finalUrl = officialPostingFetchUrl(page.url()).href;
    if (finalUrl !== officialPostingFetchUrl(documentPage.url || documentPage.sourceUrl).href) throw new OfficialPostingFetchError('unsafe-url');
    // A loader whose required authored resource is still pending cannot make
    // this DOM snapshot evidence of a complete empty inventory.
    if (pendingPreloads) incomplete = true;
    const body = await page.content();
    if (Buffer.byteLength(body, 'utf8') > OFFICIAL_FETCH_MAX_BYTES) throw new OfficialPostingFetchError('oversize');
    return { ...documentPage, body, url: finalUrl, sourceUrl: finalUrl, requestedUrl: url,
      contentType: 'text/html', rendered: true, incomplete, resourceLinks: [...resourceLinks] };
  } catch (error) {
    throw controller.signal.aborted ? interrupted() : failure || error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort();
    await Promise.allSettled([...inFlight]);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
