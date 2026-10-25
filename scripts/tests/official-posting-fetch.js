import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchOfficialPosting, isPublicOfficialAddress, OFFICIAL_FETCH_MAX_BYTES } from '../../electron/ipc/officialPostingFetch.js';
import { normalizeApplyOptions, normalizeOfficialLocation, normalizeOfficialPosting, OFFICIAL_POSTING_ROW_FIELDS } from '../../electron/ipc/officialPostingFields.js';

const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
function transport(pages, requests = []) {
  return (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      options.lookup(url.hostname, {}, (error, address, family) => {
        assert.equal(error, null); requests.push({ url: url.href, address, family, options });
        const page = pages.shift();
        if (!page) { req.emit('error', new Error('unexpected request')); return; }
        const response = new PassThrough(); response.statusCode = page.status || 200;
        response.headers = { 'content-type': 'text/html; charset=utf-8', ...page.headers };
        callback(response);
        if (page.pending) return;
        for (const chunk of page.chunks || [page.body || 'posting']) response.write(chunk);
        response.end();
      });
    });
    return req;
  };
}

export default [
  {
    name: 'Official posting fetch pins every validated DNS hop and preserves TLS hostname through redirects',
    async run() {
      const requests = []; const hosts = [];
      const result = await fetchOfficialPosting('https://careers.northwind.test/role', {
        lookup: async host => { hosts.push(host); return [{ address: hosts.length === 1 ? '1.1.1.1' : '8.8.8.8', family: 4 }]; },
        request: transport([{ status: 302, headers: { location: 'https://jobs.northwind.test/position' } }, { body: '<main>Raw posting</main>' }], requests),
      });
      assert.deepEqual(hosts, ['careers.northwind.test', 'jobs.northwind.test']);
      assert.deepEqual(requests.map(row => row.address), ['1.1.1.1', '8.8.8.8']);
      assert.equal(requests[0].url, 'https://careers.northwind.test/role');
      assert.equal(requests[0].options.agent, false);
      assert.equal(result.body, '<main>Raw posting</main>');
      assert.equal(result.url, 'https://jobs.northwind.test/position');
    },
  },
  {
    name: 'Official posting fetch rejects internal addresses, credentials, non-HTTPS, LinkedIn and hostile redirect hops',
    async run() {
      for (const ip of ['0.0.0.0', '10.1.2.3', '127.1.2.3', '169.254.1.2', '172.16.2.1', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1',
        '192.0.0.1', '192.0.2.1', '192.88.99.2', '198.51.100.1', '203.0.113.1', '2001::1', '2001:0::1', '2001:2::1', '2001:db8::1', '2002::1', '3fff::1', '3fff:fff::1']) {
        assert.equal(isPublicOfficialAddress(ip), false, ip);
      }
      assert.equal(isPublicOfficialAddress('2606:4700:4700::1111'), true);
      assert.equal(isPublicOfficialAddress('2001:4860:4860::8888'), true);
      for (const url of ['http://northwind.test/job', 'https://user:pass@northwind.test/job', 'https://127.0.0.1/job', 'https://[::1]/job', 'https://www.linkedin.com/jobs/view/123',
        'https://www.linkedin.com./jobs/view/123', 'https://linkedin.com./jobs/view/123', 'https://northwind.test:8443/job']) {
        await assert.rejects(fetchOfficialPosting(url, { lookup: publicLookup, request: () => { throw new Error('must not request'); } }), /unsafe-(?:url|address)/u);
      }
      await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', {
        lookup: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
      }), /unsafe-address/u);
      await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', {
        lookup: publicLookup, request: transport([{ status: 302, headers: { location: 'https://169.254.169.254/latest' } }]),
      }), /unsafe-address/u);
    },
  },
  {
    name: 'Official posting fetch aborts oversize streams, bad MIME and encoding, expired deadlines, loops and cancellation',
    async run() {
      const fetchPage = page => fetchOfficialPosting('https://careers.northwind.test/job', { lookup: publicLookup, request: transport([page]) });
      await assert.rejects(fetchPage({ chunks: [Buffer.alloc(OFFICIAL_FETCH_MAX_BYTES), Buffer.from('x')] }), /oversize/u);
      await assert.rejects(fetchPage({ headers: { 'content-length': OFFICIAL_FETCH_MAX_BYTES + 1 } }), /oversize/u);
      await assert.rejects(fetchPage({ headers: { 'content-type': 'application/pdf' } }), /unsupported-content-type/u);
      await assert.rejects(fetchPage({ headers: { 'content-encoding': 'gzip' } }), /unsupported-content-type/u);
      await assert.rejects(fetchPage({ chunks: [Buffer.from([0xc3, 0x28])] }), /invalid-text/u);
      await assert.rejects(fetchPage({ body: '\0' }), /invalid-text/u);
      await assert.rejects(fetchPage({ body: 'Posting\u001b[2Jtext' }), /invalid-text/u);
      await assert.rejects(fetchPage({ status: 410 }), /closed/u);
      await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', {
        lookup: publicLookup, request: transport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } }))),
      }), /unsafe-url/u);
      let clock = 0;
      await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', { now: () => { clock += 16_000; return clock; } }), /fetch-timeout/u);
      const controller = new AbortController();
      const pending = fetchOfficialPosting('https://careers.northwind.test/job', {
        lookup: () => new Promise(() => {}), signal: controller.signal,
      });
      controller.abort(); await assert.rejects(pending, /bridge-aborted/u);
    },
  },
  {
    name: 'Official posting fetch rechecks the DNS deadline and destroys canceled or prematurely closed streams with no retained caller abort listener',
    async run() {
      let clock = 0; let requests = 0;
      await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', {
        now: () => clock,
        lookup: async () => { clock = 15_000; return publicLookup(); },
        request: () => { requests += 1; throw new Error('deadline must precede transport'); },
      }), /fetch-timeout/u);
      assert.equal(requests, 0);
      for (const canceled of [true, false]) {
        const controller = new AbortController(); let response; let destroys = 0;
        const request = (_url, _options, callback) => {
          const req = new EventEmitter(); req.destroy = () => { destroys += 1; };
          req.end = () => queueMicrotask(() => {
            response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'text/html' };
            callback(response); response.write('partial');
            if (canceled) controller.abort(); else response.destroy();
          });
          return req;
        };
        await assert.rejects(fetchOfficialPosting('https://careers.northwind.test/job', { lookup: publicLookup, request, signal: controller.signal }),
          canceled ? /bridge-aborted/u : /fetch-failed/u);
        assert.equal(response.destroyed, true); assert.equal(destroys, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      }
      const requestsAtCap = [];
      const atCap = await fetchOfficialPosting('https://careers.northwind.test/job', {
        lookup: publicLookup,
        request: transport([...Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/next' } })), { body: 'At the redirect cap.' }], requestsAtCap),
      });
      assert.equal(atCap.body, 'At the redirect cap.'); assert.equal(requestsAtCap.length, 6);
    },
  },
  {
    name: 'Official posting fetch gives a reused hop transfer this request\'s own requestedUrl while keeping the reused bytes and final URL',
    async run() {
      const shared = { body: '<main>Shared</main>', url: 'https://www.northwind.test/', sourceUrl: 'https://www.northwind.test/',
        contentType: 'text/html', statusCode: 200, requestedUrl: 'https://northwind.test/' };
      const result = await fetchOfficialPosting('https://www.northwind.test/', { lookup: publicLookup,
        request: () => { throw new Error('a reused hop must not request'); },
        hopHooks: { beforeRequest: async () => ({ reuse: Promise.resolve(shared) }) } });
      assert.equal(result.requestedUrl, 'https://www.northwind.test/'); assert.equal(result.url, shared.url); assert.equal(result.body, shared.body);
      assert.equal(shared.requestedUrl, 'https://northwind.test/', 'the shared transfer is not mutated for its other subscribers');
    },
  },
  {
    name: 'Official posting remote schema requires a stated restriction and consistent remote flags without inferring a location',
    run() {
      assert.deepEqual(normalizeOfficialLocation({ display: '', workMode: 'remote', remoteCountry: 'Canada' }), {
        display: '', workMode: 'remote', remote: true, remoteCountry: 'Canada', remoteRegion: '',
      });
      assert.deepEqual(normalizeOfficialLocation({ display: '', remote: true, remoteRegion: 'North America' }), {
        display: '', workMode: 'remote', remote: true, remoteCountry: '', remoteRegion: 'North America',
      });
      for (const location of [
        { display: '', workMode: 'remote', remote: false, remoteCountry: 'Canada' },
        { display: '', workMode: 'onsite', remote: true, remoteCountry: 'Canada' },
        { display: '', workMode: 'remote' },
        { display: '', workMode: 'remote', remoteCountry: 'unknown' },
        { display: '', workMode: 'hybrid', remoteCountry: 'Canada' },
      ]) assert.equal(normalizeOfficialLocation(location), null);
    },
  },
  {
    name: 'Official posting shared wire schema is exact and bounded and never carries a row applyUrl',
    run() {
      assert.deepEqual(OFFICIAL_POSTING_ROW_FIELDS, ['postedBy', 'applyOptions', 'salaryProvenance', 'officialPosting', 'boardClosed']);
      const valid = { level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Engineer',
        location: { display: 'Lakeview', remote: false, workMode: 'onsite' }, salary: { text: '$50/hr', provenance: 'posted' },
        sourceUrl: 'https://jobs.northwind.test/1', officialApplyUrl: 'https://jobs.northwind.test/1/apply', trail: ['careers-page', 'salary-anchor'],
        contentHash: 'a'.repeat(64), fetchedAt: '2026-10-24T00:00:00.000Z' };
      assert.equal(normalizeOfficialPosting(valid).level, 'L2');
      for (const row of [{ ...valid, untrusted: true }, { ...valid, level: 'L7' }, { ...valid, trail: ['page text'] },
        { ...valid, officialApplyUrl: 'javascript:alert(1)' }, { ...valid, contentHash: '../outside' },
        { ...valid, location: { display: 'Lakeview', injected: true } }, { ...valid, salary: { text: 'estimate', provenance: 'guessed' } }]) {
        assert.equal(normalizeOfficialPosting(row), null);
      }
      const options = normalizeApplyOptions([{ label: 'Apply', href: 'https://jobs.northwind.test/1?utm_source=board' },
        { label: 'Duplicate', href: 'https://jobs.northwind.test/1' }, { label: 'Bad', href: 'http://jobs.northwind.test/2' },
        ...Array.from({ length: 20 }, (_, i) => ({ label: 'x'.repeat(200), href: `https://jobs.northwind.test/${i + 2}` }))]);
      assert.equal(options.length, 8); assert.equal(options[0].href, 'https://jobs.northwind.test/1');
      assert.equal(options[1].label.length, 120);
    },
  },
];
