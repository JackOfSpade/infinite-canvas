import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { officialPostingResourceHeaders } from '../../electron/ipc/officialPostingResourceHeaders.js';
import { fetchOfficialPosting, OfficialPostingFetchError, OFFICIAL_FETCH_HOP_CAPABILITY } from '../../electron/ipc/officialPostingFetch.js';
import { createOfficialPostingFetchSession } from '../../electron/ipc/officialPostingFetchSession.js';

const url = 'https://careers.synthetic-employer.com/careers';
const stateTree = '["",{"children":["careers",{}]}]';
const rsc = { rsc: '1', 'next-router-state-tree': stateTree, 'next-url': '/careers' };
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
function transport(contentType, requests, body = '1:{"synthetic":"public framework data"}\n') {
  return (_url, options, callback) => {
    requests.push(options);
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      options.lookup('careers.synthetic-employer.com', {}, error => {
        assert.equal(error, null);
        const response = new PassThrough(); response.statusCode = 200;
        response.headers = { 'content-type': contentType };
        callback(response); response.end(body);
      });
    });
    return request;
  };
}
const page = (value, body, contentType = 'text/html') => ({
  url: value, sourceUrl: value, statusCode: 200, body, contentType,
});
function immediateClock() {
  let time = 0;
  return { now: () => time, sleep: async milliseconds => { time += milliseconds; } };
}

export default [
  {
    name: 'official resource headers preserve public framework presentation while stripping credentials and action headers',
    run() {
      const input = { RSC: '1', Accept: 'text/html', 'Next-Router-State-Tree': stateTree, 'Next-Url': '/careers',
        'X-Nextjs-Data': '1', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SYNTHETIC_COOKIE',
        Authorization: 'SYNTHETIC_TOKEN', Host: 'private.invalid', Origin: 'https://private.invalid',
        'Next-Action': 'SYNTHETIC_ACTION', Referer: 'https://private.invalid/profile', 'X-Arbitrary': 'SYNTHETIC_OTHER' };
      const before = structuredClone(input);
      const result = officialPostingResourceHeaders(input);
      assert.deepEqual(result, { rsc: '1', accept: 'text/x-component', 'next-router-state-tree': stateTree,
        'next-url': '/careers', 'x-nextjs-data': '1', 'accept-language': 'en-US,en;q=0.9' });
      assert.deepEqual(input, before);
      assert.equal(JSON.stringify(result).includes('SYNTHETIC_'), false);
      assert.deepEqual(officialPostingResourceHeaders({ accept: 'text/x-component', ...rsc, rsc: '0',
        'x-nextjs-data': '0', 'accept-language': 'en' }), { 'accept-language': 'en' });
      for (const value of [null, undefined, [], 'headers', 1]) assert.deepEqual(officialPostingResourceHeaders(value), {});
    },
  },
  {
    name: 'official resource headers enforce length, control and relative-path boundaries',
    run() {
      const output = value => officialPostingResourceHeaders({ rsc: '1', ...value });
      assert.equal(output({ 'next-router-state-tree': 'a'.repeat(16384) })['next-router-state-tree'].length, 16384);
      assert.equal(output({ 'next-router-state-tree': 'a'.repeat(16385) })['next-router-state-tree'], undefined);
      assert.equal(output({ 'next-url': '/' + 'a'.repeat(1999) })['next-url'].length, 2000);
      for (const value of ['/' + 'a'.repeat(2000), '//foreign.example/path', '/\\foreign.example/path',
        'https://foreign.example/path', 'careers', '/careers\n', '/careers\rheader:value', '/careers\t', '/careers\u007f']) {
        assert.equal(output({ 'next-url': value })['next-url'], undefined, JSON.stringify(value));
      }
      for (const value of ['tree\n', 'tree\r', 'tree\t', 'tree\u0000', 'tree\u007f', null, ['tree']]) {
        assert.equal(output({ 'next-router-state-tree': value })['next-router-state-tree'], undefined);
      }
      assert.equal(output({ 'accept-language': 'a'.repeat(160) })['accept-language'].length, 160);
      for (const value of ['a'.repeat(161), 'en\nInjected: yes', 'français', 'en_US', null, ['en']]) {
        assert.equal(output({ 'accept-language': value })['accept-language'], undefined);
      }
    },
  },
  {
    name: 'official fetch forwards only normalized resource headers and admits RSC bytes only in resource mode',
    async run() {
      const requests = [];
      const supplied = { ...rsc, cookie: 'SYNTHETIC_COOKIE', authorization: 'SYNTHETIC_TOKEN',
        'next-action': 'SYNTHETIC_ACTION', host: 'private.invalid' };
      const resource = await fetchOfficialPosting(url, { resource: true, resourceHeaders: supplied,
        lookup: publicLookup, request: transport('text/x-component', requests) });
      assert.equal(resource.contentType, 'text/x-component');
      const sent = Object.fromEntries(Object.entries(requests[0].headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(sent.rsc, '1'); assert.equal(sent.accept, 'text/x-component');
      assert.equal(sent['next-router-state-tree'], stateTree); assert.equal(sent['next-url'], '/careers');
      for (const name of ['cookie', 'authorization', 'next-action', 'host', 'origin']) assert.equal(sent[name], undefined);
      await assert.rejects(fetchOfficialPosting(url, { resourceHeaders: supplied,
        lookup: publicLookup, request: transport('text/x-component', requests) }), { code: 'unsupported-content-type' });
      const documentHeaders = Object.fromEntries(Object.entries(requests[1].headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(documentHeaders.rsc, undefined); assert.notEqual(documentHeaders.accept, 'text/x-component');
    },
  },
  {
    name: 'official fetch sessions isolate document, plain resource and header-varying RSC representations including aliases',
    async run() {
      const calls = []; const final = url + '/final';
      const timer = immediateClock();
      const session = createOfficialPostingFetchSession({ ...timer, fetch: async (value, options) => {
        calls.push({ value, options });
        const representation = options.resource ? options.resourceHeaders.rsc === '1'
          ? 'RSC:' + options.resourceHeaders['next-router-state-tree'] : 'PLAIN_RESOURCE' : 'DOCUMENT';
        return page(final, representation, options.resourceHeaders.rsc === '1' ? 'text/x-component' : 'text/html');
      } });
      try {
        assert.equal((await session.fetch(url, { resourceHeaders: rsc })).body, 'DOCUMENT');
        assert.equal((await session.fetch(url, { resource: true })).body, 'PLAIN_RESOURCE');
        const first = await session.fetch(url, { resource: true, resourceHeaders: { ...rsc, cookie: 'IGNORED' } });
        assert.equal(first.body, 'RSC:' + stateTree);
        const equivalent = { 'Next-Url': '/careers', 'Next-Router-State-Tree': stateTree, RSC: '1', authorization: 'IGNORED_TOO' };
        assert.equal((await session.fetch(final, { resource: true, resourceHeaders: equivalent })).body, first.body);
        const otherTree = '["",{"children":["other",{}]}]';
        assert.equal((await session.fetch(url, { resource: true, resourceHeaders: { ...rsc, 'next-router-state-tree': otherTree } })).body, 'RSC:' + otherTree);
        assert.equal((await session.fetch(final)).body, 'DOCUMENT');
        assert.equal((await session.fetch(final, { resource: true })).body, 'PLAIN_RESOURCE');
        assert.equal(calls.length, 4, 'ignored sensitive headers do not split the cache, while actual representations do');
        assert.ok(calls.every(call => !JSON.stringify(call.options.resourceHeaders).includes('IGNORED')));
        assert.equal(session.telemetry().uniqueUrls, 1);
      } finally { session.dispose(); }
    },
  },
  {
    name: 'official session production hop transport receives distinct server representations without credential forwarding',
    async run() {
      const timer = immediateClock(); const requests = [];
      const request = (_url, options, callback) => {
        const headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
        requests.push(headers);
        const req = new EventEmitter(); req.destroy = () => {};
        req.end = () => queueMicrotask(() => {
          options.lookup('careers.synthetic-employer.com', {}, (error, address) => {
            assert.equal(error, null); assert.equal(address, '1.1.1.1');
            const response = new PassThrough(); response.statusCode = 200;
            const rscMode = headers.rsc === '1';
            response.headers = { 'content-type': rscMode ? 'text/x-component' : 'text/html' };
            callback(response); response.end(rscMode ? 'RSC:' + headers['next-router-state-tree'] : '<html>Public document</html>');
          });
        });
        return req;
      };
      const fetch = (value, options) => fetchOfficialPosting(value, { ...options, request, lookup: publicLookup });
      fetch[OFFICIAL_FETCH_HOP_CAPABILITY] = true;
      const session = createOfficialPostingFetchSession({ ...timer, fetch });
      try {
        assert.equal((await session.fetch(url)).body, '<html>Public document</html>');
        assert.equal((await session.fetch(url, { resource: true, resourceHeaders: { ...rsc, cookie: 'SYNTHETIC_COOKIE' } })).body, 'RSC:' + stateTree);
        const different = { ...rsc, 'next-router-state-tree': '["",{"children":["other",{}]}]' };
        assert.equal((await session.fetch(url, { resource: true, resourceHeaders: different })).body, 'RSC:' + different['next-router-state-tree']);
        assert.equal((await session.fetch(url, { resource: true, resourceHeaders: { ...rsc, authorization: 'SYNTHETIC_TOKEN' } })).body, 'RSC:' + stateTree);
        assert.equal((await session.fetch(url)).contentType, 'text/html');
        assert.equal(requests.length, 3);
        assert.equal(session.telemetry().fetches, 3);
        assert.ok(requests.every(headers => headers.cookie === undefined && headers.authorization === undefined));
      } finally { session.dispose(); }
    },
  },
  {
    name: 'official fetch admits bounded CSS only as a public render resource, preserving posting document MIME restrictions',
    async run() {
      const requests = []; const css = 'body { display: block; }';
      const stylesheet = await fetchOfficialPosting(url + '/style.css', { resource: true,
        lookup: publicLookup, request: transport('text/css; charset=utf-8', requests, css) });
      assert.equal(stylesheet.contentType, 'text/css'); assert.equal(stylesheet.body, css);
      await assert.rejects(fetchOfficialPosting(url + '/style.css', {
        lookup: publicLookup, request: transport('text/css', requests, css) }), { code: 'unsupported-content-type' });
      await assert.rejects(fetchOfficialPosting(url + '/style.css', { resource: true,
        lookup: publicLookup, request: transport('text/css', requests, 'x'.repeat(3 * 1024 * 1024 + 1)) }), { code: 'oversize' });
    },
  },
  {
    name: 'public search credentials are sent only on scoped GET hops and are dropped on another application or host',
    async run() {
      const start = 'https://abcdefghij-dsn.algolia.net/1/indexes/synthetic_jobs?query=engineer';
      const publicSearchHeaders = { 'x-algolia-application-id': 'ABCDEFGHIJ', 'x-algolia-api-key': 'a'.repeat(32) };
      for (const [destination, retained] of [
        ['https://abcdefghij-1.algolianet.com/1/indexes/synthetic_jobs?query=engineer', true],
        ['https://0123456789-dsn.algolia.net/1/indexes/synthetic_jobs?query=engineer', false],
        ['https://public.synthetic-employer.com/jobs', false],
      ]) {
        const calls = [];
        const request = (target, options, callback) => {
          calls.push({ url: target.href, options });
          const req = new EventEmitter(); req.destroy = () => {};
          req.end = () => queueMicrotask(() => {
            options.lookup(target.hostname, {}, error => {
              assert.equal(error, null);
              const response = new PassThrough(); response.statusCode = calls.length === 1 ? 302 : 200;
              response.headers = { 'content-type': 'application/json', ...(calls.length === 1 ? { location: destination } : {}) };
              callback(response); response.end('{"hits":[],"nbHits":0,"page":0}');
            });
          });
          return req;
        };
        await fetchOfficialPosting(start, { resource: true, publicSearchHeaders, lookup: publicLookup, request });
        assert.equal(calls.length, 2);
        assert.ok(calls.every(call => call.options.method === 'GET'));
        const normalized = calls.map(call => Object.fromEntries(Object.entries(call.options.headers).map(([name, value]) => [name.toLowerCase(), value])));
        assert.equal(normalized[0]['x-algolia-api-key'], publicSearchHeaders['x-algolia-api-key']);
        assert.equal(normalized[1]['x-algolia-api-key'], retained ? publicSearchHeaders['x-algolia-api-key'] : undefined);
        assert.equal(normalized[1]['x-algolia-application-id'], retained ? 'ABCDEFGHIJ' : undefined);
        assert.ok(normalized.every(headers => headers.cookie === undefined && headers.authorization === undefined));
      }
    },
  },
  {
    name: 'public search keys partition the session cache while equivalent header casing shares a representation',
    async run() {
      const value = 'https://abcdefghij-dsn.algolia.net/1/indexes/synthetic_jobs?query=engineer';
      const headers = key => ({ 'x-algolia-application-id': 'ABCDEFGHIJ', 'x-algolia-api-key': key.repeat(32) });
      const calls = []; const timer = immediateClock();
      const session = createOfficialPostingFetchSession({ ...timer, fetch: async (target, options) => {
        calls.push(options);
        return page(target, options.publicSearchHeaders['x-algolia-api-key'] || 'NO_PUBLIC_KEY', 'application/json');
      } });
      try {
        assert.equal((await session.fetch(value, { resource: true, publicSearchHeaders: headers('a') })).body, 'a'.repeat(32));
        assert.equal((await session.fetch(value, { resource: true, publicSearchHeaders: headers('b') })).body, 'b'.repeat(32));
        assert.equal((await session.fetch(value, { resource: true, publicSearchHeaders: {
          'X-Algolia-API-Key': 'a'.repeat(32), 'X-Algolia-Application-Id': 'ABCDEFGHIJ' } })).body, 'a'.repeat(32));
        assert.equal((await session.fetch(value, { resource: true })).body, 'NO_PUBLIC_KEY');
        assert.equal((await session.fetch(value, { resource: true, publicSearchHeaders: {
          ...headers('a'), cookie: 'SYNTHETIC_COOKIE', authorization: 'SYNTHETIC_TOKEN' } })).body, 'NO_PUBLIC_KEY');
        assert.equal(calls.length, 3);
        assert.ok(calls.every(options => options.publicSearchHeaders.cookie === undefined && options.publicSearchHeaders.authorization === undefined));
      } finally { session.dispose(); }
    },
  },
  {
    name: 'official fetch session negative caches cannot poison another presentation mode',
    async run() {
      const calls = []; const timer = immediateClock();
      const session = createOfficialPostingFetchSession({ ...timer, fetch: async (value, options) => {
        calls.push(options);
        if (options.resourceHeaders.rsc === '1') throw new OfficialPostingFetchError('unsupported-content-type');
        return page(value, options.resource ? 'resource bytes' : 'document bytes');
      } });
      try {
        await assert.rejects(session.fetch(url, { resource: true, resourceHeaders: rsc }), { code: 'unsupported-content-type' });
        assert.equal((await session.fetch(url)).body, 'document bytes');
        assert.equal((await session.fetch(url, { resource: true })).body, 'resource bytes');
        await assert.rejects(session.fetch(url, { resource: true, resourceHeaders: { ...rsc, cookie: 'IGNORED' } }), { code: 'unsupported-content-type' });
        assert.equal(calls.length, 3);
        assert.equal(session.telemetry().breakerTrips, 0);
      } finally { session.dispose(); }
    },
  },
];
