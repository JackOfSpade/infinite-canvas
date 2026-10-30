import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { fetchOfficialPosting, OfficialPostingFetchError, OFFICIAL_FETCH_MAX_BYTES, OFFICIAL_FETCH_SCRIPT_MAX_BYTES } from '../../electron/ipc/officialPostingFetch.js';
import { renderOfficialCareersPage, OFFICIAL_RENDER_MAX_REQUESTS, OFFICIAL_RENDER_MAX_BYTES, OFFICIAL_RENDER_TIMEOUT_MS } from '../../electron/ipc/officialPostingRender.js';

// No network or installed browser is needed. Requests still traverse the real
// renderer route handler, including its host-fetch path and resource budgets.
const url = 'https://careers.northwind-labs.com/jobs';
const source = (body = '<html>Careers</html>', sourceUrl = url) => ({
  url: sourceUrl, sourceUrl, statusCode: 200, contentType: 'text/html', body,
});
function browserHarness({ resources = [], content = '<html>Rendered careers</html>', evaluate = false,
  scrollResources = [], backgroundResources = [], navigationFailureAt, domLength, onDelay, evaluationError = 'Execution context was destroyed, most likely because of a navigation.' } = {}) {
  const state = { launched: 0, contextClosed: 0, browserClosed: 0, routes: [], socketClosed: 0,
    scrollFractions: [], scrollPositions: [], loadStates: [], delays: [], backgroundRoutes: [] };
  let routeHandler; let socketHandler; let currentUrl;
  let mainDocumentUrl = url;
  const mainFrame = { parentFrame: () => null, url: () => mainDocumentUrl };
  const childFrame = { parentFrame: () => mainFrame };
  const popupFrame = { parentFrame: () => null };
  const route = async ({ url: requestUrl = url, method = 'GET', type = 'document', main = false, popup = false, navigation = false,
    rootFrame = false, documentUrl, headers = {}, body } = {}) => {
    const previousDocumentUrl = mainDocumentUrl;
    if (documentUrl) mainDocumentUrl = documentUrl;
    const record = { url: requestUrl, method, type, main, popup, rootFrame, headers, aborted: false, fulfilled: null };
    state.routes.push(record);
    await routeHandler({
      request: () => ({ url: () => requestUrl, method: () => method, resourceType: () => type, headers: () => headers, postData: () => body,
        isNavigationRequest: () => main || popup || navigation, frame: () => main || rootFrame ? mainFrame : popup ? popupFrame : childFrame }),
      abort: async () => { record.aborted = true; },
      fulfill: async value => { record.fulfilled = value; },
      continue: () => { throw new Error('Browser network requests must never continue'); },
    });
    mainDocumentUrl = previousDocumentUrl;
    return record;
  };
  const page = {
    on() {},
    async goto(value) {
      currentUrl = value;
      mainDocumentUrl = value;
      const document = await route({ url: value, main: true });
      if (document.aborted) throw new Error('Navigation was blocked');
      for (const resource of resources) await route(resource);
      for (const resource of backgroundResources) state.backgroundRoutes.push(route(resource));
    },
    async waitForLoadState(value) { state.loadStates.push(value); },
    async waitForTimeout(value) { state.delays.push(value); await onDelay?.(state.delays.length, route); },
    mainFrame: () => mainFrame, url: () => currentUrl, content: async () => content,
  };
  if (evaluate) page.evaluate = async (callback, fraction) => {
    if (typeof fraction === 'number') {
      state.scrollFractions.push(fraction);
      if (fraction === navigationFailureAt) throw new Error(evaluationError);
      for (const request of scrollResources.filter(item => item.fraction === fraction)) await route(request);
    }
    return runInNewContext('(' + callback.toString() + ')(fraction)', {
      fraction, URL, window: { innerHeight: 400, scrollTo: (_x, y) => { state.scrollPositions.push(y); } },
      document: { documentElement: { scrollHeight: 1800, ...(domLength ? { outerHTML: { length: domLength(state.delays.length) } } : {}) }, baseURI: url,
        querySelectorAll: () => [{ getAttribute: () => 'https://jobs.ashbyhq.com/synthetic-employer/synthetic-role' }] },
    });
  };
  const context = {
    async addInitScript(script) { state.initScript = script; },
    async route(_pattern, handler) { routeHandler = handler; },
    async routeWebSocket(_pattern, handler) { socketHandler = handler; },
    newPage: async () => page,
    async close() { state.contextClosed++; },
  };
  const browser = {
    async newContext(options) { state.contextOptions = options; return context; },
    async close() { state.browserClosed++; },
  };
  return { state, launch: async () => { state.launched++; return browser; },
    closeSocket: async () => socketHandler({ close: async () => { state.socketClosed++; } }) };
}
const code = expected => error => error instanceof OfficialPostingFetchError && error.code === expected;

export default [
  {
    name: 'render snapshot waits for hydration: quiet requests and a stable DOM settle without incomplete, and readiness follows the fulfilled response',
    async run() {
      const api = 'https://careers.northwind-labs.com/v1/boards/acme/jobs';
      const late = { url: 'https://careers.northwind-labs.com/late.json', type: 'fetch', rootFrame: true };
      const quiet = browserHarness({ evaluate: true, resources: [{ url: api, type: 'fetch', rootFrame: true }], domLength: () => 500 });
      const result = await renderOfficialCareersPage(url, { launch: quiet.launch,
        fetch: async value => ({ ...source(value === url ? '<html></html>' : '{"jobs":[]}', value), contentType: value === url ? 'text/html' : 'application/json' }) });
      assert.equal(result.incomplete, false);
      assert.ok(quiet.state.delays.filter(value => value === 100).length >= 3, 'a quiet window of polls precedes the snapshot');
      // A late request after the first poll restarts the quiet window and is awaited.
      const hydrate = browserHarness({ evaluate: true, domLength: () => 500, content: '<script type="application/ld+json">{}</script>',
        onDelay: async (_count, route) => { if (hydrate.state.delays.filter(value => value === 100).length === 1 && !hydrate.state.late) hydrate.state.late = await route(late); } });
      const hydrated = await renderOfficialCareersPage(url, { launch: hydrate.launch,
        fetch: async value => ({ ...source('{}', value), contentType: value === url ? 'text/html' : 'application/json' }) });
      assert.equal(hydrate.state.late.fulfilled.status, 200); assert.equal(hydrated.incomplete, false);
      assert.ok(hydrate.state.delays.filter(value => value === 100).length >= 4, 'new routed requests extend the settle window');
      assert.match(hydrated.body, /application\/ld\+json/u);
    },
  },
  {
    name: 'render snapshot marks incomplete when the settle cap is hit with a request in flight or a still-changing DOM, without discarding content',
    async run() {
      const stuck = browserHarness({ content: '<html>Partial but real</html>', backgroundResources: [{ url: 'https://careers.northwind-labs.com/slow.json', type: 'fetch', rootFrame: true }] });
      const waiting = await renderOfficialCareersPage(url, { launch: stuck.launch,
        fetch: async (value, { signal }) => value === url ? source() : new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new OfficialPostingFetchError('bridge-aborted')), { once: true }); }) });
      assert.equal(waiting.incomplete, true); assert.equal(waiting.body, '<html>Partial but real</html>');
      assert.ok(stuck.state.delays.reduce((sum, value) => sum + value, 0) <= 4_000 + 8_000, 'the settle wait is capped');
      const churn = browserHarness({ evaluate: true, content: '<html>Carousel</html>', domLength: count => 1_000 + count });
      const changing = await renderOfficialCareersPage(url, { launch: churn.launch, fetch: async () => source() });
      assert.equal(changing.incomplete, true); assert.equal(changing.body, '<html>Carousel</html>');
      assert.ok(churn.state.delays.filter(value => value === 100).length <= 40);
    },
  },
  {
    name: 'render settle wait stays inside the abort signal',
    async run() {
      const controller = new AbortController();
      const test = browserHarness({ evaluate: true, domLength: count => 1_000 + count, onDelay: () => { if (test.state.delays.filter(value => value === 100).length === 2) controller.abort(); } });
      await assert.rejects(renderOfficialCareersPage(url, { launch: test.launch, signal: controller.signal, fetch: async () => source() }),
        error => error instanceof OfficialPostingFetchError);
    },
  },
  {
    name: 'authored anonymous same-origin fetch preloads admit exact main-frame GET other resources without creating source receipts',
    async run() {
      const shader = new URL('/assets/shader.vs', url).href; const data = new URL('/assets/public.json', url).href;
      const body = `<base href="/"><link rel="preload" as="fetch" crossorigin="anonymous" href="/assets/shader.vs">
        <link rel="preload" as="fetch" crossorigin href="/assets/public.json">
        <link rel="preload" as="fetch" crossorigin="anonymous" href="https://unrelated.example.com/data.json">`;
      const resources = [{ url: shader, type: 'other', rootFrame: true }, { url: data, type: 'other', rootFrame: true },
        { url: shader, type: 'other' }, { url: shader, type: 'other', rootFrame: true, documentUrl: 'https://unrelated.example.com/' },
        { url: shader, type: 'font', rootFrame: true }, { url: shader, type: 'image', rootFrame: true },
        { url: shader, type: 'other', method: 'POST', rootFrame: true },
        { url: shader + '?different=1', type: 'other', rootFrame: true },
        { url: 'https://unrelated.example.com/data.json', type: 'other', rootFrame: true }];
      for (const initial of [true, false]) {
        const test = browserHarness({ resources }); const fetched = [];
        const result = await renderOfficialCareersPage(url, { launch: test.launch, ...(initial ? { initialPage: source(body) } : {}),
          fetch: async (value, options) => { fetched.push({ value, options }); return value === url ? source(body) : {
            ...source(value === shader ? 'void main() {}' : '{"boot":"data"}', value), contentType: value === shader ? 'text/plain' : 'application/json' }; } });
        assert.deepEqual(fetched.map(item => item.value), [...(initial ? [] : [url]), shader, data]);
        assert.ok(fetched.every(item => item.options.resource === true && item.options.signal instanceof AbortSignal));
        assert.ok(test.state.routes.slice(1, 3).every(item => item.fulfilled?.status === 200));
        assert.ok(test.state.routes.slice(3).every(item => item.aborted && !item.fulfilled));
        assert.deepEqual(result.resourceLinks, []); assert.equal(result.incomplete, false);
      }
    },
  },
  {
    name: 'failed pending or ambiguous required fetch preloads keep loader DOMs incomplete',
    async run() {
      const data = new URL('/assets/public.json', url).href;
      const body = '<base href="/"><link rel="preload" as="fetch" crossorigin="anonymous" href="/assets/public.json">';
      const request = { url: data, type: 'other', rootFrame: true };
      const failed = browserHarness({ resources: [request], content: '<html>Loading careers</html>' });
      const result = await renderOfficialCareersPage(url, { launch: failed.launch, initialPage: source(body),
        fetch: async () => { throw new OfficialPostingFetchError('unsupported-content-type'); } });
      assert.equal(result.incomplete, true); assert.equal(failed.state.routes[1].aborted, true); assert.deepEqual(result.resourceLinks, []);
      const pending = browserHarness({ backgroundResources: [request], content: '<html>Loading careers</html>' });
      const waiting = await renderOfficialCareersPage(url, { launch: pending.launch, initialPage: source(body),
        fetch: async (_value, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new OfficialPostingFetchError('bridge-aborted')), { once: true });
        }) });
      await Promise.all(pending.state.backgroundRoutes);
      assert.equal(waiting.incomplete, true, 'an outstanding required preload is incomplete before DOM capture and final cleanup');
      const ambiguous = browserHarness({ resources: [request] }); let calls = 0;
      const uncertain = await renderOfficialCareersPage(url, { launch: ambiguous.launch, initialPage: source('<base href="/">' + body),
        fetch: async () => { calls++; throw new Error('ambiguous document must not authorize a preload'); } });
      assert.equal(calls, 0); assert.equal(uncertain.incomplete, true);
    },
  },
  {
    name: 'authored fetch preloads share the existing request and byte budgets',
    async run() {
      const asset = new URL('/assets/public.json', url).href;
      const body = '<link rel="preload" as="fetch" crossorigin="anonymous" href="/assets/public.json">';
      const resource = { url: asset, type: 'other', rootFrame: true };
      const capped = browserHarness({ resources: Array.from({ length: OFFICIAL_RENDER_MAX_REQUESTS }, () => resource) });
      await assert.rejects(renderOfficialCareersPage(url, { launch: capped.launch, initialPage: source(body),
        fetch: async value => ({ ...source('{}', value), contentType: 'application/json' }) }), code('crawl-budget'));
      const oversized = browserHarness({ resources: Array.from({ length: 10 }, () => resource) });
      await assert.rejects(renderOfficialCareersPage(url, { launch: oversized.launch, initialPage: source(body),
        fetch: async value => ({ ...source('x'.repeat(2 * 1024 * 1024), value), contentType: 'text/plain' }) }), code('oversize'));
    },
  },
  {
    name: 'official careers rendering sends allowed resources through host fetch and blocks writes, workers and sockets',
    async run() {
      const test = browserHarness({ resources: [
        { url: `${url}/app.js`, type: 'script' }, { url: `${url}/data`, type: 'xhr' },
        { url: `${url}/submit`, method: 'POST', type: 'fetch' },
        { url: `${url}/worker.js`, type: 'worker' }, { url: `${url}/image.png`, type: 'image' },
        { url: 'http://127.0.0.1/private', type: 'fetch' },
        { url: 'https://popup.northwind-labs.com/', popup: true },
      ] });
      const calls = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => { calls.push({ value, options }); return source('/* synthetic script */', value); } });
      assert.equal(result.rendered, true); assert.equal(result.url, url);
      assert.equal(result.body, '<html>Rendered careers</html>');
      assert.deepEqual(test.state.contextOptions, { serviceWorkers: 'block', acceptDownloads: false });
      const realm = { RTCPeerConnection() {}, webkitRTCPeerConnection() {}, WebTransport() {} };
      runInNewContext(`(${test.state.initScript.toString()})();`, realm);
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        const descriptor = Object.getOwnPropertyDescriptor(realm, key);
        assert.equal(descriptor.value, undefined); assert.equal(descriptor.configurable, false); assert.equal(descriptor.writable, false);
      }
      assert.deepEqual(calls.map(call => call.value), [`${url}/app.js`, `${url}/data`]);
      assert.ok(calls.every(call => call.options.resource === true && call.options.signal instanceof AbortSignal));
      assert.ok(test.state.routes.slice(0, 3).every(record => record.fulfilled?.status === 200));
      assert.ok(test.state.routes.slice(3).every(record => record.aborted && !record.fulfilled));
      await test.closeSocket(); assert.equal(test.state.socketClosed, 1);
      assert.ok(test.state.contextClosed > 0 && test.state.browserClosed > 0);
    },
  },
  {
    name: 'official careers rendering rejects unsafe initial URLs before launching and host-fetch rejects private resource addresses',
    async run() {
      for (const value of ['http://careers.northwind-labs.com/jobs', 'https://user:secret@careers.northwind-labs.com/jobs',
        'https://careers.northwind-labs.com:444/jobs', 'https://linkedin.com/jobs/one', 'https://careers.example/jobs']) {
        const test = browserHarness();
        await assert.rejects(renderOfficialCareersPage(value, { launch: test.launch }), code('unsafe-url'));
        assert.equal(test.state.launched, 0);
      }
      const privateUrl = 'https://127.0.0.1/private';
      const test = browserHarness({ resources: [{ url: privateUrl, type: 'fetch' }] });
      let hostFetches = 0; let networkRequests = 0;
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => {
          hostFetches++; assert.equal(value, privateUrl); assert.equal(options.resource, true);
          return fetchOfficialPosting(value, { ...options,
            lookup: async () => { throw new Error('Private literal must fail before DNS'); },
            request: () => { networkRequests++; throw new Error('Private resource must never request'); } });
        } });
      assert.equal(result.rendered, true); assert.equal(hostFetches, 1); assert.equal(networkRequests, 0);
      assert.equal(test.state.routes[1].aborted, true); assert.equal(test.state.routes[1].fulfilled, null);
    },
  },
  {
    name: 'official careers rendering retains only successful JSON receipts from its own main document',
    async run() {
      const test = browserHarness({ resources: [
        { url: `${url}/data`, type: 'fetch', rootFrame: true },
        { url: `${url}/linked-data`, type: 'xhr', rootFrame: true },
        { url: `${url}/data`, type: 'fetch', rootFrame: true },
        { url: `${url}/child-data`, type: 'fetch' },
        { url: `${url}/script-data`, type: 'script', rootFrame: true },
        { url: `${url}/script`, type: 'fetch', rootFrame: true },
        { url: `${url}/failed-data`, type: 'fetch', rootFrame: true },
        { url: `${url}/foreign-document-data`, type: 'fetch', rootFrame: true, documentUrl: 'https://unrelated.example.com/' },
      ] });
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => ({ ...source('{"synthetic":"bounded public data"}', value),
          contentType: value.endsWith('/linked-data') ? 'application/ld+json' : value.endsWith('/script') ? 'text/javascript' : 'application/json',
          statusCode: value.endsWith('/failed-data') ? 503 : 200 }) });
      assert.deepEqual(result.resourceLinks, [`${url}/data`, `${url}/linked-data`]);
      assert.ok(result.resourceLinks.every(value => typeof value === 'string'));
      assert.equal(test.state.routes.find(record => record.url.endsWith('/failed-data')).aborted, true);
    },
  },
  {
    name: 'official careers rendered JSON receipts share the request cap and never retain response bodies',
    async run() {
      const resources = Array.from({ length: OFFICIAL_RENDER_MAX_REQUESTS - 1 }, (_, index) => ({
        url: `${url}/data-${index}`, type: 'fetch', rootFrame: true,
      }));
      const test = browserHarness({ resources });
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => ({ ...source('{"neverRetainedInReceipt":true}', value), contentType: 'application/json' }) });
      assert.equal(result.resourceLinks.length, OFFICIAL_RENDER_MAX_REQUESTS - 1);
      assert.deepEqual(result.resourceLinks, resources.map(resource => resource.url));
      assert.equal(JSON.stringify(result.resourceLinks).includes('neverRetainedInReceipt'), false);
    },
  },
  {
    name: 'official careers rendering preserves its real request budget by skipping trackers and speculative Next requests',
    async run() {
      assert.equal(OFFICIAL_RENDER_MAX_REQUESTS, 128);
      assert.equal(OFFICIAL_RENDER_MAX_BYTES, 18 * 1024 * 1024);
      assert.equal(OFFICIAL_RENDER_TIMEOUT_MS, 25_000);
      const speculativeHeaders = [{ purpose: 'prefetch' }, { 'sec-purpose': 'prefetch;prerender' },
        { 'next-router-prefetch': '1' }, { 'x-middleware-prefetch': '1' }];
      const speculative = Array.from({ length: 256 }, (_, index) => ({
        url: url + '/prefetch-' + index, type: 'fetch', rootFrame: true, headers: speculativeHeaders[index % speculativeHeaders.length],
      }));
      const trackers = ['https://www.googletagmanager.com/gtm.js', 'https://connect.facebook.net/analytics.js',
        'https://www.google-analytics.com/analytics.js', 'https://scripts.clarity.ms/tag'].map(value => ({ url: value, type: 'script' }));
      const real = Array.from({ length: OFFICIAL_RENDER_MAX_REQUESTS - 2 }, (_, index) => ({
        url: url + '/real-' + index + '.js', type: 'script',
      }));
      const jobs = 'https://api.ashbyhq.com/posting-api/job-board/synthetic-employer';
      const test = browserHarness({ resources: [...speculative, ...trackers, ...real,
        { url: jobs, type: 'fetch', rootFrame: true }] });
      const fetched = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => { fetched.push(value); return { ...source('{}', value),
          contentType: value === jobs ? 'application/json' : 'text/javascript' }; } });
      assert.deepEqual(fetched, [...real.map(item => item.url), jobs]);
      assert.equal(fetched.length, OFFICIAL_RENDER_MAX_REQUESTS - 1);
      assert.deepEqual(result.resourceLinks, [jobs], 'the later authoritative JSON still fits after speculative traffic was skipped');
      assert.ok(test.state.routes.slice(1, speculative.length + trackers.length + 1).every(item => item.aborted && !item.fulfilled));
    },
  },
  {
    name: 'official careers rendering skips embedded media before its budget while admitting hosted ATS iframes',
    async run() {
      const mediaHosts = ['player.vimeo.com', 'www.youtube.com', 'www.youtube-nocookie.com', 'youtu.be',
        'fast.wistia.net', 'fast.wistia.com', 'customer.videodelivery.net'];
      const media = Array.from({ length: OFFICIAL_RENDER_MAX_REQUESTS * 2 }, (_, index) => ({
        url: `https://${mediaHosts[index % mediaHosts.length]}/embed/${index}`, type: 'document', navigation: true,
      }));
      const ats = 'https://boards.greenhouse.io/synthetic-employer';
      const jobs = 'https://api.ashbyhq.com/posting-api/job-board/synthetic-employer';
      const resources = [...media,
        { url: ats, type: 'document', navigation: true },
        { url: ats + '/board.js', type: 'script' },
        { url: ats + '/child-data', type: 'fetch' },
        { url: jobs, type: 'fetch', rootFrame: true }];
      const test = browserHarness({ resources });
      const fetched = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => {
          fetched.push(value);
          return { ...source(value === ats ? '<html>Hosted careers</html>' : '{}', value),
            contentType: value === ats ? 'text/html' : value.endsWith('.js') ? 'text/javascript' : 'application/json' };
        } });
      assert.deepEqual(fetched, resources.slice(media.length).map(item => item.url));
      assert.ok(test.state.routes.slice(1, media.length + 1).every(item => item.aborted && !item.fulfilled));
      assert.ok(test.state.routes.slice(media.length + 1).every(item => item.fulfilled?.status === 200 && !item.aborted));
      assert.equal(result.incomplete, false, 'ignored media does not make the careers inventory partial');
      assert.deepEqual(result.resourceLinks, [jobs], 'a child ATS frame remains readable without acquiring main-document receipt authority');
    },
  },
  {
    name: 'official careers rendering admits bounded large JavaScript while retaining the smaller JSON and document caps',
    async run() {
      assert.equal(OFFICIAL_FETCH_SCRIPT_MAX_BYTES, 8 * 1024 * 1024);
      assert.equal(OFFICIAL_FETCH_MAX_BYTES, 3 * 1024 * 1024);
      const bundle = browserHarness({ resources: [{ url: url + '/large.js', type: 'script' }] });
      const accepted = await renderOfficialCareersPage(url, { launch: bundle.launch, initialPage: source(),
        fetch: async value => ({ ...source('x'.repeat(OFFICIAL_FETCH_SCRIPT_MAX_BYTES), value), contentType: 'text/javascript' }) });
      assert.equal(accepted.rendered, true);
      const hugeScript = browserHarness({ resources: [{ url: url + '/oversized.js', type: 'script' }] });
      await assert.rejects(renderOfficialCareersPage(url, { launch: hugeScript.launch, initialPage: source(),
        fetch: async value => ({ ...source('x'.repeat(OFFICIAL_FETCH_SCRIPT_MAX_BYTES + 1), value), contentType: 'application/javascript' }) }), code('oversize'));
      const hugeJson = browserHarness({ resources: [{ url: url + '/oversized-data', type: 'fetch', rootFrame: true }] });
      await assert.rejects(renderOfficialCareersPage(url, { launch: hugeJson.launch, initialPage: source(),
        fetch: async value => ({ ...source('x'.repeat(OFFICIAL_FETCH_MAX_BYTES + 1), value), contentType: 'application/json' }) }), code('oversize'));
      const aggregate = browserHarness({ resources: [1, 2, 3].map(index => ({ url: url + '/bundle-' + index + '.js', type: 'script' })) });
      await assert.rejects(renderOfficialCareersPage(url, { launch: aggregate.launch, initialPage: source(),
        fetch: async value => ({ ...source('x'.repeat(OFFICIAL_FETCH_SCRIPT_MAX_BYTES), value), contentType: 'text/javascript' }) }), code('oversize'));
    },
  },
  {
    name: 'official careers rendering scrolls bounded viewport positions and tolerates navigation context replacement',
    async run() {
      const jobs = 'https://api.ashbyhq.com/posting-api/job-board/synthetic-employer';
      for (const message of ['Execution context was destroyed, most likely because of a navigation.',
        'Cannot find context with specified id', 'Frame was detached']) {
        const test = browserHarness({ evaluate: true, navigationFailureAt: 0.25, evaluationError: message,
          scrollResources: [{ fraction: 0.75, url: jobs, type: 'fetch', rootFrame: true }] });
        const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
          fetch: async value => ({ ...source('{}', value), contentType: 'application/json' }) });
        assert.deepEqual(test.state.scrollFractions, [0.25, 0.5, 0.75, 1]);
        assert.deepEqual(test.state.scrollPositions, [700, 1050, 1400]);
        assert.ok(test.state.loadStates.includes('domcontentloaded'));
        assert.deepEqual(result.resourceLinks, [jobs], 'the lazy job list is discovered after scrolling despite a replaced context');
      }
      const broken = browserHarness({ evaluate: true, navigationFailureAt: 0.25, evaluationError: 'Unexpected browser failure' });
      await assert.rejects(renderOfficialCareersPage(url, { launch: broken.launch, initialPage: source() }), /Unexpected browser failure/u);
    },
  },
  {
    name: 'official careers rendering preserves same-URL RSC representation and skips speculative requests for another Next page',
    async run() {
      const tree = '["",{"children":["careers",{}]}]';
      const jobs = 'https://api.ashbyhq.com/posting-api/job-board/synthetic-employer';
      const test = browserHarness({ resources: [
        { url: url + '/other-page?_rsc=speculative', type: 'fetch', rootFrame: true,
          headers: { rsc: '1', 'next-router-prefetch': '1', 'next-url': '/other-page' } },
        { url, type: 'fetch', rootFrame: true, headers: { rsc: '1', accept: 'text/x-component',
          'next-router-state-tree': tree, 'next-url': '/jobs', cookie: 'SYNTHETIC_COOKIE',
          authorization: 'SYNTHETIC_TOKEN', 'next-action': 'SYNTHETIC_ACTION' } },
        { url: jobs, type: 'fetch', rootFrame: true },
      ] });
      const calls = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => {
          calls.push({ value, options });
          return { ...source(value === url ? '1:{"synthetic":"RSC data"}' : '{}', value),
            contentType: value === url ? 'text/x-component' : 'application/json' };
        } });
      assert.deepEqual(calls.map(call => call.value), [url, jobs], 'a header-varying same-URL fetch must not reuse the initial HTML document');
      assert.deepEqual(calls[0].options.resourceHeaders, { rsc: '1', accept: 'text/x-component',
        'next-router-state-tree': tree, 'next-url': '/jobs' });
      assert.equal(test.state.routes[1].aborted, true);
      assert.equal(test.state.routes[2].fulfilled.contentType, 'text/x-component');
      assert.deepEqual(result.resourceLinks, [jobs], 'RSC and skipped speculative pages are not JSON ownership receipts');
    },
  },
  {
    name: 'official careers rendering fulfills public stylesheets without treating CSS as an ownership receipt',
    async run() {
      const styleUrl = url + '/careers.css';
      const fetchedStyle = url + '/theme.css';
      const test = browserHarness({ resources: [
        { url: styleUrl, type: 'stylesheet', rootFrame: true },
        { url: fetchedStyle, type: 'fetch', rootFrame: true },
      ] });
      const calls = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => {
          calls.push({ value, options }); return { ...source('body { display: block; }', value), contentType: 'text/css' };
        } });
      assert.deepEqual(calls.map(call => call.value), [styleUrl, fetchedStyle]);
      assert.ok(calls.every(call => call.options.resource === true));
      assert.equal(test.state.routes[1].fulfilled.contentType, 'text/css');
      assert.equal(test.state.routes[1].fulfilled.body, 'body { display: block; }');
      assert.deepEqual(result.resourceLinks, [], 'stylesheets and fetched CSS do not attest any ATS source');
      const oversized = browserHarness({ resources: [{ url: styleUrl, type: 'stylesheet' }] });
      await assert.rejects(renderOfficialCareersPage(url, { launch: oversized.launch, initialPage: source(),
        fetch: async value => ({ ...source('x'.repeat(OFFICIAL_FETCH_MAX_BYTES + 1), value), contentType: 'text/css' }) }), code('oversize'));
    },
  },
  {
    name: 'official careers rendering marks failed application reads incomplete instead of reporting an empty finished lookup',
    async run() {
      for (const type of ['script', 'stylesheet', 'xhr', 'fetch']) {
        const test = browserHarness({ resources: [{ url: url + '/required-resource', type, rootFrame: true }] });
        const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
          fetch: async () => { throw new OfficialPostingFetchError('fetch-failed'); } });
        assert.equal(result.incomplete, true, type);
        assert.deepEqual(result.resourceLinks, []);
      }
      const cdn = browserHarness({ resources: [{ url: 'https://cdn.synthetic-employer.com/app.js', type: 'script', rootFrame: true }] });
      assert.equal((await renderOfficialCareersPage(url, { launch: cdn.launch, initialPage: source(),
        fetch: async () => { throw new OfficialPostingFetchError('fetch-failed'); } })).incomplete, true);
      const blocked = browserHarness({ resources: [{ url: url + '/unrecognized-action', type: 'fetch', method: 'POST', rootFrame: true, body: 'action=unknown' }] });
      assert.equal((await renderOfficialCareersPage(url, { launch: blocked.launch, initialPage: source(),
        fetch: () => { throw new Error('An unrecognized POST must not leave the browser'); } })).incomplete, true);
      const noncritical = browserHarness({ resources: [
        { url: url + '/next-prefetch', type: 'fetch', rootFrame: true, headers: { purpose: 'prefetch' } },
        { url: 'https://www.googletagmanager.com/gtm.js', type: 'script', rootFrame: true },
      ] });
      assert.equal((await renderOfficialCareersPage(url, { launch: noncritical.launch, initialPage: source(),
        fetch: () => { throw new Error('Skipped speculative and tracking requests must not fetch'); } })).incomplete, false);
    },
  },
  {
    name: 'official careers rendering rewrites strict public searches to bounded GETs and answers recognized preflight locally',
    async run() {
      const endpoint = 'https://abcdefghij-dsn.algolia.net/1/indexes/*/queries';
      const key = 'a'.repeat(32);
      const test = browserHarness({ resources: [
        { url: endpoint, type: 'fetch', rootFrame: true, method: 'OPTIONS',
          headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-algolia-api-key,x-algolia-application-id' } },
        { url: endpoint, type: 'fetch', rootFrame: true, method: 'POST',
          headers: { 'content-type': 'application/json', 'x-algolia-api-key': key, 'x-algolia-application-id': 'ABCDEFGHIJ' },
          body: JSON.stringify({ requests: [{ indexName: 'synthetic_jobs', params: 'query=engineer&hitsPerPage=10' }] }) },
      ] });
      const calls = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => {
          calls.push({ value, options });
          return { ...source(JSON.stringify({ hits: [{ title: 'Synthetic job' }], nbHits: 1, page: 0 }), value), contentType: 'application/json' };
        } });
      assert.equal(calls.length, 1);
      assert.equal(new URL(calls[0].value).pathname, '/1/indexes/synthetic_jobs');
      assert.equal(new URL(calls[0].value).searchParams.get('query'), 'engineer');
      assert.equal(new URL(calls[0].value).searchParams.has('x-algolia-api-key'), false);
      assert.deepEqual(calls[0].options.publicSearchHeaders, { 'x-algolia-application-id': 'ABCDEFGHIJ', 'x-algolia-api-key': key });
      assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
      assert.equal(calls[0].options.resource, true);
      assert.equal(test.state.routes[1].fulfilled.status, 204);
      assert.equal(test.state.routes[2].fulfilled.status, 200);
      assert.equal(JSON.parse(test.state.routes[2].fulfilled.body).results[0].nbHits, 1);
      assert.deepEqual(result.resourceLinks, [], 'generated search URLs and keys are never ownership receipts');
      assert.equal(result.incomplete, false);
    },
  },
  {
    name: 'official careers rendering handles typed empty-facet metadata without assuming it is a multi-query posting inventory',
    async run() {
      const endpoint = 'https://abcdefghij-dsn.algolia.net/1/indexes/synthetic_jobs/facets/location/query';
      const test = browserHarness({ resources: [{ url: endpoint, type: 'fetch', rootFrame: true, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-algolia-api-key': 'a'.repeat(32), 'x-algolia-application-id': 'ABCDEFGHIJ' }, body: '{}' }] });
      const calls = [];
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async (value, options) => { calls.push({ value, options }); return {
          ...source(JSON.stringify({ hits: [], nbHits: 100, page: 0, facets: { location: { 'Lakeview <HQ>': 10, Harbor: 4 } },
            exhaustiveFacetsCount: true, processingTimeMS: 1 }), value), contentType: 'application/json' }; } });
      assert.equal(calls.length, 1); assert.equal(new URL(calls[0].value).pathname, '/1/indexes/synthetic_jobs');
      assert.equal(new URL(calls[0].value).searchParams.get('hitsPerPage'), '0');
      assert.equal(new URL(calls[0].value).searchParams.get('facets'), '["location"]');
      assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
      const metadata = JSON.parse(test.state.routes[1].fulfilled.body);
      assert.deepEqual(metadata.facetHits, [{ value: 'Lakeview <HQ>', count: 10, highlighted: 'Lakeview &lt;HQ&gt;' },
        { value: 'Harbor', count: 4, highlighted: 'Harbor' }]);
      assert.equal(metadata.results, undefined); assert.equal(result.incomplete, false);
      assert.deepEqual(result.resourceLinks, [], 'facet metadata and generated public GET URLs are not source receipts');
    },
  },
  {
    name: 'official careers rendering preserves native single-index responses and their job inventory coverage',
    async run() {
      const endpoint = 'https://abcdefghij-dsn.algolia.net/1/indexes/synthetic_jobs/query';
      const request = { url: endpoint, type: 'fetch', rootFrame: true, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-algolia-api-key': 'a'.repeat(32), 'x-algolia-application-id': 'ABCDEFGHIJ' },
        body: JSON.stringify({ query: '', facetFilters: [[], [], []], page: 0, hitsPerPage: 100 }) };
      for (const nbHits of [1, 2]) {
        const test = browserHarness({ resources: [request] }); const calls = [];
        const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
          fetch: async (value, options) => { calls.push({ value, options }); return {
            ...source(JSON.stringify({ hits: [{ title: 'Synthetic job' }], nbHits, page: 0 }), value), contentType: 'application/json' }; } });
        assert.equal(calls.length, 1); assert.equal(new URL(calls[0].value).pathname, '/1/indexes/synthetic_jobs');
        assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
        const native = JSON.parse(test.state.routes[1].fulfilled.body);
        assert.deepEqual(native.hits, [{ title: 'Synthetic job' }]); assert.equal(native.nbHits, nbHits); assert.equal(native.results, undefined);
        assert.equal(result.incomplete, nbHits > 1); assert.deepEqual(result.resourceLinks, []);
      }
    },
  },
  {
    name: 'official careers rendering keeps a paginated public inventory incomplete even when its first page succeeds',
    async run() {
      const resource = { url: 'https://abcdefghij-dsn.algolia.net/1/indexes/*/queries', type: 'fetch', rootFrame: true, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-algolia-api-key': 'a'.repeat(32), 'x-algolia-application-id': 'ABCDEFGHIJ' },
        body: JSON.stringify({ requests: [{ indexName: 'synthetic_jobs', params: 'query=&hitsPerPage=1' }] }) };
      const test = browserHarness({ resources: [resource] });
      const result = await renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => ({ ...source(JSON.stringify({ hits: [{ title: 'Synthetic job' }], nbHits: 3, page: 0 }), value), contentType: 'application/json' }) });
      assert.equal(result.incomplete, true);
      assert.equal(test.state.routes[1].fulfilled.status, 200, 'the read remains usable while an empty match stays retryable');
    },
  },
  {
    name: 'official careers rendering charges search fan-out GETs and aborts malformed read responses',
    async run() {
      const endpoint = 'https://abcdefghij-dsn.algolia.net/1/indexes/*/queries';
      const query = { url: endpoint, type: 'fetch', rootFrame: true, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-algolia-api-key': 'a'.repeat(32), 'x-algolia-application-id': 'ABCDEFGHIJ' },
        body: JSON.stringify({ requests: Array.from({ length: 8 }, (_, index) => ({ indexName: 'synthetic_jobs_' + index, params: 'query=engineer' })) }) };
      const resources = Array.from({ length: 118 }, (_, index) => ({ url: url + '/app-' + index + '.js', type: 'script' }));
      const test = browserHarness({ resources: [...resources, query, query] }); let calls = 0;
      await assert.rejects(renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => { calls++; return { ...source(JSON.stringify({ hits: [], nbHits: 0, page: 0 }), value), contentType: 'application/json' }; } }), code('crawl-budget'));
      assert.ok(calls <= OFFICIAL_RENDER_MAX_REQUESTS - 1, 'batch fan-out cannot exceed the host request cap');
      const malformed = browserHarness({ resources: [query] });
      await assert.rejects(renderOfficialCareersPage(url, { launch: malformed.launch, initialPage: source(),
        fetch: async value => ({ ...source('{"success":false}', value), contentType: 'application/json' }) }), code('fetch-failed'));
    },
  },
  {
    name: 'official careers rendering translates only the exact first-party PHP read schema without forwarding request credentials',
    async run() {
      const documentUrl = url + '/careers';
      const endpoint = documentUrl + '/greenhouse_api.php';
      const test = browserHarness({ resources: [{ url: endpoint, type: 'xhr', rootFrame: true, method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', cookie: 'SYNTHETIC_COOKIE', authorization: 'SYNTHETIC_TOKEN' },
        body: 'limit=-1' }] });
      const calls = [];
      const body = JSON.stringify({ success: true, jobs: '<div class="jobs_wrapper"><div class="single_job_wrapper"><a href="single-job.html?job_id=123">Synthetic job</a></div></div>' });
      const result = await renderOfficialCareersPage(documentUrl, { launch: test.launch, initialPage: source('<html>Careers</html>', documentUrl),
        fetch: async (value, options) => { calls.push({ value, options }); return source(body, value); } });
      assert.equal(calls.length, 1); assert.equal(calls[0].value, endpoint + '?limit=-1');
      assert.equal(calls[0].options.resourceHeaders, undefined);
      assert.equal(calls[0].options.publicSearchHeaders, undefined);
      assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
      assert.equal(JSON.stringify(calls).includes('SYNTHETIC_'), false);
      assert.equal(test.state.routes[1].fulfilled.body, body);
      assert.equal(test.state.routes[1].fulfilled.contentType, 'text/html');
      assert.equal(result.incomplete, false); assert.deepEqual(result.resourceLinks, []);
    },
  },
  {
    name: 'official careers rendering stops request floods and closes its disposable context',
    async run() {
      const resources = Array.from({ length: OFFICIAL_RENDER_MAX_REQUESTS }, (_, index) => ({
        url: `${url}/resource-${index}.js`, type: 'script',
      }));
      const test = browserHarness({ resources }); let calls = 0;
      await assert.rejects(renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(),
        fetch: async value => { calls++; return source('', value); } }), code('crawl-budget'));
      assert.equal(calls, OFFICIAL_RENDER_MAX_REQUESTS - 1);
      assert.equal(test.state.routes.at(-1).aborted, true);
      assert.ok(test.state.contextClosed > 0 && test.state.browserClosed > 0);
    },
  },
  {
    name: 'official careers rendering enforces document, resource, aggregate and final DOM byte caps',
    async run() {
      const huge = 'x'.repeat(OFFICIAL_FETCH_MAX_BYTES + 1);
      const document = browserHarness();
      await assert.rejects(renderOfficialCareersPage(url, { launch: document.launch, initialPage: source(huge) }), code('oversize'));
      const dom = browserHarness({ content: huge });
      await assert.rejects(renderOfficialCareersPage(url, { launch: dom.launch, initialPage: source() }), code('oversize'));
      const resource = browserHarness({ resources: [{ url: `${url}/huge.js`, type: 'script' }] });
      await assert.rejects(renderOfficialCareersPage(url, { launch: resource.launch, initialPage: source(),
        fetch: async value => source(huge, value) }), code('oversize'));
      const total = browserHarness({ resources: Array.from({ length: Math.ceil(OFFICIAL_RENDER_MAX_BYTES / OFFICIAL_FETCH_MAX_BYTES) },
        (_, index) => ({ url: `${url}/chunk-${index}.js`, type: 'script' })) });
      await assert.rejects(renderOfficialCareersPage(url, { launch: total.launch, initialPage: source(),
        fetch: async value => source('x'.repeat(OFFICIAL_FETCH_MAX_BYTES), value) }), code('oversize'));
    },
  },
  {
    name: 'official careers rendering cancellation reaches host fetch and closes resources without leaking caller listeners',
    async run() {
      const already = new AbortController(); already.abort(); const early = browserHarness();
      await assert.rejects(renderOfficialCareersPage(url, { launch: early.launch, signal: already.signal }), code('bridge-aborted'));
      assert.equal(early.state.launched, 0); assert.equal(getEventListeners(already.signal, 'abort').length, 0);
      const controller = new AbortController();
      const test = browserHarness({ resources: [{ url: `${url}/pending.js`, type: 'script' }] });
      let fetchStarted; const started = new Promise(resolve => { fetchStarted = resolve; });
      let fetchAborted = false;
      const pending = renderOfficialCareersPage(url, { launch: test.launch, initialPage: source(), signal: controller.signal,
        fetch: (_value, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { fetchAborted = true; reject(new OfficialPostingFetchError('bridge-aborted')); }, { once: true });
          fetchStarted();
        }) });
      await started; controller.abort();
      await assert.rejects(pending, code('bridge-aborted'));
      assert.equal(fetchAborted, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.ok(test.state.contextClosed > 0 && test.state.browserClosed > 0);
    },
  },
  {
    name: 'official careers rendering cancellation bounds browser launch and closes a late browser',
    async run() {
      const controller = new AbortController(); let finishLaunch; let launchStarted;
      const started = new Promise(resolve => { launchStarted = resolve; }); let closed = 0;
      const pending = renderOfficialCareersPage(url, { signal: controller.signal,
        launch: () => { launchStarted(); return new Promise(resolve => { finishLaunch = resolve; }); } });
      await started; controller.abort();
      await assert.rejects(pending, code('bridge-aborted'));
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      finishLaunch({ close: async () => { closed++; } });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(closed, 1);
    },
  },
];
