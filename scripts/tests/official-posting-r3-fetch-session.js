import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOfficialPostingFetchSession } from '../../electron/ipc/officialPostingFetchSession.js';
import { fetchOfficialPosting, OfficialPostingFetchError, OFFICIAL_FETCH_HOP_CAPABILITY } from '../../electron/ipc/officialPostingFetch.js';
import { resolveOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const page = url => ({ url, sourceUrl: url, body: '<main>Official posting</main>', contentType: 'text/html', statusCode: 200 });
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  let value = 0; const waits = new Set();
  return {
    now: () => value,
    set: next => { value = next; },
    sleep(ms, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const item = { at: value + ms, resolve, reject };
        const cleanup = () => { waits.delete(item); signal?.removeEventListener('abort', onAbort); };
        const onAbort = () => { cleanup(); reject(new Error('Canceled test clock wait')); };
        item.finish = () => { cleanup(); resolve(); };
        if (signal?.aborted) { reject(new Error('Canceled test clock wait')); return; }
        signal?.addEventListener('abort', onAbort, { once: true }); waits.add(item);
      });
    },
    async tick(ms) { value += ms; for (const item of [...waits]) if (item.at <= value) item.finish(); await flush(); },
  };
}
function transport(pages, timer, starts = []) {
  return (url, options, callback) => {
    starts.push({ url: url.href, time: timer.now() });
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      options.lookup(url.hostname, {}, error => {
        assert.equal(error, null);
        const value = pages[url.href];
        if (!value) { req.emit('error', new Error('Missing synthetic transport response')); return; }
        const response = new PassThrough(); response.statusCode = value.status || 200;
        response.headers = { 'content-type': 'text/html', ...value.headers };
        callback(response);
        value.onResponse?.();
        if (value.pending) { value.finish = () => response.end(value.body || 'Posting'); return; }
        response.end(value.body || 'Posting');
      });
    });
    return req;
  };
}
function forwarded(pages, timer, starts = [], lookup = async () => [{ address: '1.1.1.1', family: 4 }]) {
  const request = transport(pages, timer, starts);
  const fetch = (url, options) => fetchOfficialPosting(url, { ...options, lookup, request });
  fetch[OFFICIAL_FETCH_HOP_CAPABILITY] = true;
  return fetch;
}

export default [
  {
    name: 'Official session shares host limits while separating rendered-resource admission from posting bytes',
    async run() {
      const calls = [];
      const fetch = async (url, options) => {
        calls.push(options.resource);
        if (!options.resource) throw new OfficialPostingFetchError('unsupported-content-type');
        return { ...page(url), body: 'window.jobs = true;', contentType: 'application/javascript' };
      };
      const session = createOfficialPostingFetchSession({ fetch });
      try {
        const url = 'https://careers.northwind.test/careers.js';
        await assert.rejects(session.fetch(url), { code: 'unsupported-content-type' });
        assert.equal((await session.fetch(url, { resource: true })).body, 'window.jobs = true;');
        await assert.rejects(session.fetch(url), { code: 'unsupported-content-type' });
        assert.equal((await session.fetch(url, { resource: true })).contentType, 'application/javascript');
        assert.deepEqual(calls, [false, true]);
        assert.equal(session.telemetry().fetches, 2); assert.equal(session.telemetry().uniqueUrls, 1);
      } finally { session.dispose(); }
    },
  },
  {
    name: 'research can retry one settled transient URL failure without evicting good bytes or resetting host safety limits',
    async run() {
      const timer = clock(); const attempts = new Map();
      const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: async url => {
        const count = (attempts.get(url) || 0) + 1; attempts.set(url, count);
        if (url.endsWith('/retry') && count === 1 || new URL(url).hostname === 'fails.test') throw new OfficialPostingFetchError('fetch-timeout');
        if (url.endsWith('/closed')) throw new OfficialPostingFetchError('closed', { statusCode: 404 });
        return page(url);
      } });
      const retry = 'https://retry.test/retry';
      await assert.rejects(session.fetch(retry), /fetch-timeout/u);
      assert.equal(session.retryFailedUrls([retry]), 1);
      const recovered = session.fetch(retry); await timer.tick(250); await recovered;
      assert.equal(attempts.get(retry), 2);
      assert.equal(session.retryFailedUrls([retry]), 0);
      await session.fetch(retry); assert.equal(attempts.get(retry), 2, 'success bytes stay cached');
      const closed = 'https://closed.test/closed';
      await assert.rejects(session.fetch(closed), /closed/u);
      assert.equal(session.retryFailedUrls([closed]), 0, 'definitive gone pages are not retried');
      const fails = 'https://fails.test/fails';
      await assert.rejects(session.fetch(fails), /fetch-timeout/u);
      assert.equal(session.retryFailedUrls([fails]), 1);
      const again = assert.rejects(session.fetch(fails), /fetch-timeout/u); await timer.tick(250); await again;
      assert.equal(session.retryFailedUrls([fails]), 0, 'one URL cannot retry repeatedly');
      const third = assert.rejects(session.fetch('https://fails.test/other'), /fetch-timeout/u);
      await timer.tick(250); await third;
      assert.equal(session.telemetry().breakerTrips, 1, 'retrying does not reset consecutive host failures');
      await assert.rejects(session.fetch('https://fails.test/fourth'), /fetch-failed/u);
      assert.equal(attempts.size, 4, 'the tripped host admits no fourth transfer');
      session.dispose();
    },
  },
  {
    name: 'R3 fetch session coalesces subscribers and final aliases while a row abort leaves the shared request usable',
    async run() {
      const wait = deferred(); let calls = 0; const first = new AbortController(); const second = new AbortController();
      const session = createOfficialPostingFetchSession({ fetch: async () => { calls++; return wait.promise; } });
      const a = session.fetch('https://northwind.test/start', { signal: first.signal });
      const b = session.fetch('https://northwind.test/start', { signal: second.signal });
      const rejected = assert.rejects(a, /bridge-aborted/u);
      await flush(); first.abort(); await rejected;
      assert.equal(calls, 1);
      wait.resolve(page('https://northwind.test/final'));
      const shared = await b;
      assert.equal(shared.url, 'https://northwind.test/final');
      assert.equal(shared.requestedUrl, 'https://northwind.test/start');
      const alias = await session.fetch('https://northwind.test/final');
      assert.equal(alias.url, 'https://northwind.test/final');
      assert.equal(alias.requestedUrl, 'https://northwind.test/final', 'a cache alias reports the asking caller\'s own URL, never another chain\'s');
      assert.equal(calls, 1);
      assert.deepEqual(session.telemetry(), { fetches: 1, uniqueUrls: 1, cacheHits: 2, maxPerHostRate: 1, breakerTrips: 0 });
      assert.equal(getEventListeners(first.signal, 'abort').length, 0); assert.equal(getEventListeners(second.signal, 'abort').length, 0);
      const snapshot = session.telemetry(); snapshot.fetches = 500; assert.equal(session.telemetry().fetches, 1);
    },
  },
  {
    name: 'R3 fetch session caches failures for ten minutes without turning a detached row timeout into a cached failure',
    async run() {
      const timer = clock(); let calls = 0;
      const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep,
        fetch: async () => { calls++; throw new OfficialPostingFetchError('closed'); } });
      await assert.rejects(session.fetch('https://northwind.test/closed'), /closed/u);
      await assert.rejects(session.fetch('https://northwind.test/closed'), /closed/u);
      assert.equal(calls, 1);
      await timer.tick(600_001);
      await assert.rejects(session.fetch('https://northwind.test/closed'), /closed/u); assert.equal(calls, 2);
      const wait = deferred(); const row = new AbortController();
      const shared = createOfficialPostingFetchSession({ fetch: async () => wait.promise });
      const abandoned = shared.fetch('https://northwind.test/one', { signal: row.signal });
      const rejected = assert.rejects(abandoned, /fetch-timeout/u);
      row.abort(Object.assign(new Error('Row host budget expired'), { code: 'fetch-timeout' })); await rejected;
      wait.resolve(page('https://northwind.test/one'));
      assert.equal((await shared.fetch('https://northwind.test/one')).statusCode, 200);
    },
  },
  {
    name: 'R3 fetch session limits eight concurrent requests globally and two per host with at least 250ms between starts',
    async run() {
      const timer = clock(); const starts = []; const pending = []; let active = 0; let maximum = 0;
      const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: url => {
        starts.push({ url, time: timer.now() }); active++; maximum = Math.max(maximum, active);
        return new Promise(resolve => pending.push(() => { active--; resolve(page(url)); }));
      } });
      const all = Array.from({ length: 10 }, (_, index) => session.fetch(`https://host${index}.test/one`));
      await flush(); assert.equal(starts.length, 8); assert.equal(maximum, 8);
      pending.shift()(); await flush(); assert.equal(starts.length, 9); assert.equal(maximum, 8);
      while (pending.length) { pending.shift()(); await flush(); }
      await Promise.all(all); assert.equal(maximum, 8);
      const sameHost = []; const hostWaits = []; let hostActive = 0; let hostMaximum = 0;
      const limited = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: url => {
        sameHost.push(timer.now()); hostActive++; hostMaximum = Math.max(hostMaximum, hostActive);
        return new Promise(resolve => hostWaits.push(() => { hostActive--; resolve(page(url)); }));
      } });
      const rows = [1, 2, 3].map(index => limited.fetch(`https://northwind.test${index === 2 ? '.' : ''}/${index}`));
      await flush(); assert.deepEqual(sameHost, [0]);
      await timer.tick(249); assert.equal(sameHost.length, 1);
      await timer.tick(1); assert.deepEqual(sameHost, [0, 250]);
      await timer.tick(250); assert.equal(sameHost.length, 2, 'the third request cannot exceed the per-host active limit');
      hostWaits.shift()(); await flush(); assert.deepEqual(sameHost, [0, 250, 500]);
      while (hostWaits.length) hostWaits.shift()(); await Promise.all(rows); assert.equal(hostMaximum, 2);
    },
  },
  {
    name: 'R3 production fetch schedules every redirect hop and deduplicates different in-flight aliases before a shared final transfer',
    async run() {
      const timer = clock(); const starts = [];
      const final = { pending: true, body: '<main>Bound final posting</main>' };
      const pages = { 'https://northwind.test/a': { status: 302, headers: { location: '/final' } },
        'https://northwind.test/b': { status: 302, headers: { location: '/final' } }, 'https://northwind.test/final': final };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts), now: timer.now, sleep: timer.sleep });
      const both = [session.fetch('https://northwind.test/a'), session.fetch('https://northwind.test/b')];
      await flush(); assert.equal(starts.length, 1);
      await timer.tick(250); await timer.tick(250);
      assert.deepEqual(starts.map(item => item.url), ['https://northwind.test/a', 'https://northwind.test/b', 'https://northwind.test/final']);
      assert.deepEqual(starts.map(item => item.time), [0, 250, 500]);
      final.finish(); const [a, b] = await Promise.all(both);
      assert.equal(a.body, final.body); assert.equal(b.url, 'https://northwind.test/final');
      await session.fetch('https://northwind.test/final');
      assert.equal(starts.length, 3); assert.equal(session.telemetry().fetches, 3); assert.equal(session.telemetry().cacheHits, 2);
    },
  },
  {
    name: 'R3 Retry-After caps at thirty seconds and pauses only scheduler waiting while active transport retains fifteen seconds',
    async run() {
      for (const activeTimeout of [false, true]) {
        const timer = clock(); const starts = [];
        const pages = { 'https://northwind.test/busy': { status: 429, headers: { 'retry-after': '120' } },
          'https://northwind.test/next': { body: 'Next posting', onResponse: () => { if (activeTimeout) timer.set(timer.now() + 15_001); } } };
        const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts), now: timer.now, sleep: timer.sleep });
        await assert.rejects(session.fetch('https://northwind.test/busy'), error => error.statusCode === 429 && error.retryAfter === '120');
        const next = session.fetch('https://northwind.test/next');
        const outcome = next.then(value => ({ value }), error => ({ error }));
        await flush(); await timer.tick(29_999); assert.equal(starts.length, 1);
        await timer.tick(1); const result = await outcome;
        assert.equal(starts[1].time, 30_000, 'the request neither starts early nor spends its transport budget waiting');
        if (activeTimeout) assert.equal(result.error.code, 'fetch-timeout'); else assert.equal(result.value.statusCode, 200);
      }
    },
  },
  {
    name: 'R3 fetch session honors Retry-After dates and trips only three consecutive request failures for the rest of that run',
    async run() {
      const timer = clock(); const starts = [];
      const pages = { 'https://northwind.test/one': { status: 503, headers: { 'retry-after': new Date(2_000).toUTCString() } },
        'https://northwind.test/two': { status: 503 }, 'https://northwind.test/three': { status: 503 },
        'https://northwind.test/four': { body: 'Must not request' }, 'https://other.test/one': { body: 'Another host works' } };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts), now: timer.now, sleep: timer.sleep });
      await assert.rejects(session.fetch('https://northwind.test/one'));
      const two = assert.rejects(session.fetch('https://northwind.test/two')); await flush(); await timer.tick(1_999); assert.equal(starts.length, 1);
      await timer.tick(1); await two;
      const three = assert.rejects(session.fetch('https://northwind.test/three')); await flush(); await timer.tick(250); await three;
      await timer.tick(600_001); await assert.rejects(session.fetch('https://northwind.test/four'));
      assert.equal(starts.length, 3, 'the breaker lasts beyond negative-cache expiry');
      await session.fetch('https://other.test/one'); assert.equal(session.telemetry().breakerTrips, 1);
      assert.equal(session.telemetry().fetches, 4);
    },
  },
  {
    name: 'R3 fetch session success resets consecutive failures rather than accumulating unrelated failures',
    async run() {
      const timer = clock(); let calls = 0;
      const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: async url => {
        calls++; if (calls !== 3) throw new OfficialPostingFetchError('fetch-failed'); return page(url);
      } });
      for (let index = 0; index < 5; index++) {
        const result = session.fetch(`https://northwind.test/${index}`).catch(error => error);
        await flush(); if (index) await timer.tick(250); await result;
      }
      assert.equal(session.telemetry().breakerTrips, 0); assert.equal(calls, 5);
      const sixth = session.fetch('https://northwind.test/6').catch(error => error); await flush(); await timer.tick(250); await sixth;
      assert.equal(session.telemetry().breakerTrips, 1);
    },
  },
  {
    name: 'R3 host breaker decisions follow start order and hold admission gaps when responses complete in opposite orders',
    async run() {
      const histories = [];
      for (const secondFirst of [false, true]) {
        const timer = clock(); const requests = new Map(); const starts = [];
        const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: url => {
          const key = new URL(url).pathname.slice(1); const wait = deferred(); requests.set(key, wait); starts.push(key);
          return wait.promise;
        } });
        const rows = [1, 2, 3, 4, 5].map(key => session.fetch(`https://northwind.test/${key}`).then(() => 'found', () => 'failed'));
        await flush(); await timer.tick(250);
        if (secondFirst) {
          requests.get('2').resolve(page('https://northwind.test/2')); await flush(); await timer.tick(250);
          assert.deepEqual(starts, ['1', '2'], 'a later completion cannot admit another request while an earlier start is unresolved');
          requests.get('1').reject(new OfficialPostingFetchError('fetch-failed')); await flush();
          await timer.tick(250);
          requests.get('4').reject(new OfficialPostingFetchError('fetch-failed')); await flush();
          assert.equal(starts.length, 4);
          requests.get('3').reject(new OfficialPostingFetchError('fetch-failed')); await flush();
        } else {
          requests.get('1').reject(new OfficialPostingFetchError('fetch-failed')); await flush(); await timer.tick(250);
          requests.get('3').reject(new OfficialPostingFetchError('fetch-failed')); await flush();
          assert.equal(starts.length, 3, 'another later completion also waits on the earlier success');
          requests.get('2').resolve(page('https://northwind.test/2')); await flush(); await timer.tick(250);
          requests.get('4').reject(new OfficialPostingFetchError('fetch-failed')); await flush();
        }
        await timer.tick(250); requests.get('5').resolve(page('https://northwind.test/5'));
        const outcomes = await Promise.all(rows);
        assert.deepEqual(starts, ['1', '2', '3', '4', '5']);
        assert.deepEqual(outcomes, ['failed', 'found', 'failed', 'failed', 'found']);
        assert.equal(session.telemetry().breakerTrips, 0);
        histories.push(outcomes); session.dispose();
      }
      assert.deepEqual(histories[0], histories[1]);
    },
  },
  {
    name: 'R3 session preserves URL DNS and redirect guards even on cache hits and rejects cyclic alias waits',
    async run() {
      const timer = clock(); const starts = [];
      const pages = { 'https://northwind.test/one': { body: 'Valid' },
        'https://other.test/redirect': { status: 302, headers: { location: 'https://private.test/one' } } };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts,
        async host => [{ address: host === 'private.test' ? '127.0.0.1' : '1.1.1.1', family: 4 }]), now: timer.now, sleep: timer.sleep });
      await session.fetch('https://northwind.test/one');
      await assert.rejects(session.fetch(' https://northwind.test/one'), /unsafe-url/u);
      await assert.rejects(session.fetch('https://user:pass@northwind.test/one'), /unsafe-url/u);
      await assert.rejects(session.fetch('https://other.test/redirect'), /unsafe-address/u);
      assert.equal(starts.length, 2, 'the unsafe redirect never reaches transport');
      const loops = { 'https://alpha.test/one': { status: 302, headers: { location: 'https://beta.test/one' } },
        'https://beta.test/one': { status: 302, headers: { location: 'https://alpha.test/one' } } };
      const cyclic = createOfficialPostingFetchSession({ fetch: forwarded(loops, timer), now: timer.now, sleep: timer.sleep });
      const outcomes = await Promise.allSettled([cyclic.fetch('https://alpha.test/one'), cyclic.fetch('https://beta.test/one')]);
      assert.ok(outcomes.every(result => result.status === 'rejected' && result.reason.code === 'unsafe-url'));
    },
  },
  {
    name: 'R3 session disposal removes only its run listener and retires owned pending work without aborting the caller run',
    async run() {
      const run = new AbortController();
      for (let index = 0; index < 12; index++) {
        const session = createOfficialPostingFetchSession({ signal: run.signal, fetch: () => new Promise(() => {}) });
        assert.equal(getEventListeners(run.signal, 'abort').length, 1);
        const pending = assert.rejects(session.fetch('https://northwind.test/one'), /bridge-aborted/u);
        await flush(); session.dispose(); await pending;
        assert.equal(getEventListeners(run.signal, 'abort').length, 0);
        assert.equal(run.signal.aborted, false);
        await assert.rejects(session.fetch('https://northwind.test/two'), /bridge-aborted/u);
      }
    },
  },
  {
    name: 'R3 run Stop cancels queued and active transport while row subscriptions release all caller listeners',
    async run() {
      const timer = clock(); const starts = []; const run = new AbortController();
      const pages = { 'https://northwind.test/one': { pending: true }, 'https://northwind.test/two': { pending: true } };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts), signal: run.signal, now: timer.now, sleep: timer.sleep });
      const one = assert.rejects(session.fetch('https://northwind.test/one'), /bridge-aborted/u);
      const two = assert.rejects(session.fetch('https://northwind.test/two'), /bridge-aborted/u);
      await flush(); run.abort(); await Promise.all([one, two]); await timer.tick(1_000);
      assert.equal(starts.length, 1); await assert.rejects(session.fetch('https://other.test/one'), /bridge-aborted/u);
      assert.equal(session.telemetry().fetches, 1);
    },
  },
  {
    name: 'R3 host breaker counts only transport failures timeouts 429 and 5xx and ignores closed pages and per-URL rejections',
    async run() {
      const sequence = async (steps, count) => {
        const timer = clock(); let calls = 0; const outcomes = [];
        const session = createOfficialPostingFetchSession({ now: timer.now, sleep: timer.sleep, fetch: async url => {
          const step = steps[calls++]; if (step) throw new OfficialPostingFetchError(step[0], { statusCode: step[1] }); return page(url);
        } });
        for (let index = 0; index < count; index++) {
          const result = session.fetch(`https://northwind.test/${index}`).then(() => 'ok', error => error.code);
          await flush(); if (index) await timer.tick(250); outcomes.push(await result);
        }
        return { outcomes, calls, trips: session.telemetry().breakerTrips };
      };
      // A page that is gone, mistyped, oversized, unsafe or forbidden says nothing about the host. Four in a row must not stop it.
      for (const step of [['closed', 404], ['closed', 410], ['unsupported-content-type'], ['oversize'], ['invalid-text'],
        ['unsafe-url'], ['unsafe-address'], ['fetch-failed', 403], ['fetch-failed', 401]]) {
        const run = await sequence([step, step, step, step], 5);
        assert.equal(run.calls, 5, `${step.join(' ')} must not stop later requests to the host`);
        assert.equal(run.trips, 0); assert.equal(run.outcomes.at(-1), 'ok');
      }
      // Host health signals still trip after three consecutive occurrences.
      for (const step of [['fetch-failed'], ['fetch-timeout'], ['fetch-failed', 408], ['fetch-failed', 429], ['fetch-failed', 500], ['fetch-failed', 503]]) {
        const run = await sequence([step, step, step], 4);
        assert.equal(run.calls, 3, `${step.join(' ')} stops the fourth request without touching the network`);
        assert.equal(run.trips, 1); assert.equal(run.outcomes.at(-1), 'fetch-failed');
      }
      // A closed page neither adds to nor clears the consecutive host-failure count.
      const mixed = await sequence([['fetch-failed', 503], ['closed', 404], ['fetch-failed', 503], ['fetch-failed', 503]], 5);
      assert.equal(mixed.calls, 4); assert.equal(mixed.trips, 1);
      // The production transport maps real statuses and content types the same way.
      const timer = clock(); const starts = [];
      const pages = { 'https://jobs.northwind.test/a': { status: 404 }, 'https://jobs.northwind.test/b': { status: 410 },
        'https://jobs.northwind.test/c': { headers: { 'content-type': 'image/png' } }, 'https://jobs.northwind.test/d': { status: 403 },
        'https://jobs.northwind.test/e': { body: 'Live posting' } };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer, starts), now: timer.now, sleep: timer.sleep });
      const codes = [];
      for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
        const result = session.fetch(`https://jobs.northwind.test/${id}`).then(value => value.statusCode, error => error.code);
        await flush(); if (index) await timer.tick(250); codes.push(await result);
      }
      assert.deepEqual(codes, ['closed', 'closed', 'unsupported-content-type', 'fetch-failed', 200]);
      assert.equal(starts.length, 5, 'the live posting on the same host is still requested'); assert.equal(session.telemetry().breakerTrips, 0);
    },
  },
  {
    name: 'R3 every caller of a shared request or cached alias reports its own requestedUrl including apex and www redirects',
    async run() {
      const pages = { 'https://northwind.test/': { status: 301, headers: { location: 'https://www.northwind.test/' } },
        'https://www.northwind.test/': { body: '<title>Northwind Labs</title>' } };
      const apex = 'https://northwind.test/'; const www = 'https://www.northwind.test/';
      for (const order of [[apex, www], [www, apex]]) {
        const timer = clock();
        const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer), now: timer.now, sleep: timer.sleep });
        for (const requested of order) {
          const result = await session.fetch(requested);
          assert.equal(result.url, www); assert.equal(result.requestedUrl, requested, `asked for ${requested} after ${order[0]}`);
        }
        const again = await session.fetch(order[0]); assert.equal(again.requestedUrl, order[0], 'a plain cache hit keeps the caller\'s URL');
      }
      // Two in-flight chains that converge on one final transfer: each subscriber keeps the URL it asked for.
      const timer = clock(); const starts = [];
      const final = { pending: true, body: '<main>Bound final posting</main>' };
      const redirects = { 'https://northwind.test/a': { status: 302, headers: { location: '/final' } },
        'https://northwind.test/b': { status: 302, headers: { location: '/final' } }, 'https://northwind.test/final': final };
      const session = createOfficialPostingFetchSession({ fetch: forwarded(redirects, timer, starts), now: timer.now, sleep: timer.sleep });
      const both = [session.fetch('https://northwind.test/a'), session.fetch('https://northwind.test/b')];
      await flush(); await timer.tick(250); await timer.tick(250); final.finish();
      const [a, b] = await Promise.all(both);
      assert.equal(a.requestedUrl, 'https://northwind.test/a'); assert.equal(b.requestedUrl, 'https://northwind.test/b');
      assert.equal(a.url, 'https://northwind.test/final'); assert.equal(b.url, 'https://northwind.test/final');
      assert.equal((await session.fetch('https://northwind.test/final')).requestedUrl, 'https://northwind.test/final');
    },
  },
  {
    name: 'R3 root ownership through a shared fetch session does not depend on whether another row read the apex or the www alias first',
    async run() {
      const employer = 'Northwind Labs'; const location = 'Lakeview, Ontario, Canada';
      const description = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
      const jsonLd = title => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, hiringOrganization: { name: employer },
        description, jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`;
      const pages = { 'https://nwlhq.test/': { status: 301, headers: { location: 'https://www.nwlhq.test/' } },
        'https://www.nwlhq.test/': { body: `<html><head><title>${employer}</title></head><body>Welcome</body></html>` },
        'https://nwlhq.test/jobs/1': { body: jsonLd('Engineer 1') }, 'https://www.nwlhq.test/jobs/2': { body: jsonLd('Engineer 2') } };
      const rows = { A: { title: 'Engineer 1', company: employer, location, snippet: description, url: 'https://nwlhq.test/jobs/1', salaryProvenance: 'unknown' },
        B: { title: 'Engineer 2', company: employer, location, snippet: description, url: 'https://www.nwlhq.test/jobs/2', salaryProvenance: 'unknown' } };
      const results = [];
      for (const order of [['A', 'B'], ['B', 'A'], ['B']]) {
        let value = 0; const timer = { now: () => value, sleep: async ms => { value += ms; } };
        const session = createOfficialPostingFetchSession({ fetch: forwarded(pages, timer), now: timer.now, sleep: timer.sleep });
        const levels = {};
        for (const name of order) {
          const { officialPosting } = await resolveOfficialPosting(rows[name], { fetch: session.fetch, store: null });
          levels[name] = `${officialPosting.level}/${officialPosting.outcome}/${officialPosting.trail.join(',')}`;
        }
        session.dispose(); results.push(levels);
      }
      assert.match(results[2].B, /^L1\/found\//u, 'the www posting proves its own root when it runs alone');
      assert.equal(results[0].B, results[2].B, 'an apex reader running first cannot change the www row');
      assert.equal(results[1].B, results[2].B);
      assert.equal(results[0].A, results[1].A, 'the apex row resolves the same whichever order the rows ran');
    },
  },
];
