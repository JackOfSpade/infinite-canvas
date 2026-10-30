import assert from 'node:assert/strict';
import { deriveOfficialPostingReadOnlySearchRequest as derive,
  isOfficialPostingReadOnlySearchUrl as recognized,
  normalizeOfficialPostingPublicSearchHeaders as publicHeaders,
  parseOfficialPostingReadOnlySearchResponse as parse,
  officialPostingReadOnlySearchCoverageIncomplete as incomplete } from '../../electron/ipc/officialPostingReadOnlySearch.js';

const app = 'ABCDEF1234'; const key = 'public_search_fixture_1234567890';
const host = 'abcdef1234-dsn.algolia.net';
const url = `https://${host}/1/indexes/*/queries`;
const headers = { 'x-algolia-application-id': app, 'x-algolia-api-key': key };
const request = (params = 'query=&hitsPerPage=12&page=0&facets=%5B%22department%22%5D') => ({ indexName: 'careers_en-US_production', params });
const read = (requests = [request()], extra = {}) => derive({ url, headers, body: JSON.stringify({ requests }), ...extra });
const response = (plan, value = { hits: [{ name: 'Synthetic role', url: 'https://ats.rippling.com/synthetic/jobs/one' }], nbHits: 1, page: 0 }, extra = {}) =>
  ({ url: plan.requests[0].url, statusCode: 200, contentType: 'application/json', body: JSON.stringify(value), ...extra });
const facetUrl = `https://${host}/1/indexes/careers_en-US_production/facets/department/query`;
const facetPlan = (extra = {}) => derive({ url: facetUrl, headers, body: '{}', ...extra });
const facetValue = (extra = {}) => ({ hits: [], nbHits: 500, page: 0,
  facets: { department: { Engineering: 9, Operations: 3 } }, exhaustiveFacetsCount: true, processingTimeMS: 7, ...extra });
const singleUrl = `https://${host}/1/indexes/careers_en-US_production/query`;
const singlePlan = (extra = {}) => derive({ url: singleUrl, headers,
  body: JSON.stringify({ query: '', facetFilters: [[], [], []], page: 0, hitsPerPage: 100 }), ...extra });

export default [
  { name: 'Public Algolia multi-query plans contain only fixed read GETs and scoped headers while preserving query order', run() {
    const plan = read([request(), request({ query: 'software', hitsPerPage: 0, facets: ['locations'], facetFilters: [['department:Engineering']] })]);
    assert.equal(plan.kind, 'algolia-search-v1'); assert.equal(plan.requests.length, 2);
    assert.equal(plan.requests[0].url, `https://${host}/1/indexes/careers_en-US_production?query=&hitsPerPage=12&page=0&facets=%5B%22department%22%5D&analytics=false&clickAnalytics=false&enablePersonalization=false`);
    for (const item of plan.requests) {
      assert.deepEqual(item.headers, headers); assert.ok(!item.url.includes(key)); assert.ok(!item.url.includes('api-key'));
      assert.equal(new URL(item.url).pathname, '/1/indexes/careers_en-US_production');
      assert.equal(item.tenantProven, undefined);
    }
    assert.equal(new URL(plan.requests[1].url).searchParams.get('facetFilters'), '[["department:Engineering"]]');
    assert.equal(read([request()], { url: `${url}?x-algolia-application-id=${app}&x-algolia-api-key=${key}`, headers: {} }).requests.length, 1);
  } },
  { name: 'Modern flat search requests retain public filters but remove visitor tokens and disable personalization and analytics', run() {
    const visitor = 'anonymous-12345678-1234-4123-8123-123456789001';
    const flat = { indexName: 'careers_en-US_production', query: '', hitsPerPage: 50,
      facets: ['departmentName', 'locationNames'], maxValuesPerFacet: 100, userToken: visitor,
      highlightPreTag: '__ais-highlight__', highlightPostTag: '__/ais-highlight__', clickAnalytics: true };
    for (const item of [flat, request({ userToken: visitor, enablePersonalization: true, analytics: true, clickAnalytics: true }),
      request(`userToken=${visitor}&analytics=true`)]) {
      const plan = read([item]); const target = new URL(plan.requests[0].url);
      assert.equal(target.searchParams.has('userToken'), false);
      assert.ok(!JSON.stringify(plan).includes(visitor));
      for (const name of ['analytics', 'clickAnalytics', 'enablePersonalization']) assert.equal(target.searchParams.get(name), 'false');
    }
    assert.equal(read([{ ...flat, params: 'query=ignored' }]), null, 'mixed legacy and flat layouts are ambiguous');
    assert.equal(read([{ ...flat, userToken: 'x'.repeat(513) }]), null);
    assert.equal(read([{ ...flat, unrelatedOperation: 'delete' }]), null);
  } },
  { name: 'Read-only search recognition rejects non-Algolia hosts mutating paths credentials ambiguous URLs and application mismatch', run() {
    for (const target of [`https://${app.toLowerCase()}.algolia.net/1/indexes/*/queries`,
      `https://${app.toLowerCase()}-1.algolianet.com/1/indexes/%2A/queries`]) assert.equal(recognized(target), true);
    for (const target of [url.replace('https:', 'http:'), url.replace(host, `${host}.attacker.test`),
      url.replace(host, `user@${host}`), url.replace(host, `${host}:444`), url.replace(host, `${host}.`),
      url.replace('*/queries', 'careers/batch'), url.replace('*/queries', 'careers/settings'),
      url.replace('*/queries', 'careers/deleteByQuery'), `${url}#fragment`, `${url}?actions=delete`,
      `${url}?x-algolia-application-id=DIFFERENT0`, `${url}?x-algolia-agent=a&x-algolia-agent=b`]) {
      assert.equal(recognized(target), false, target); assert.equal(read([request()], { url: target }), null, target);
    }
    assert.equal(read([request()], { headers: { ...headers, 'x-algolia-application-id': 'DIFFERENT0' } }), null);
  } },
  { name: 'Search request bodies reject actions unknown operations excessive queries malformed names and unbounded parameters', run() {
    for (const body of ['{}', '{invalid}', JSON.stringify({ requests: [], actions: [] }),
      JSON.stringify({ requests: Array.from({ length: 9 }, () => request()) }),
      JSON.stringify({ requests: [{ ...request(), action: 'deleteObject' }] }),
      JSON.stringify({ requests: [{ ...request(), indexName: '../settings' }] }),
      JSON.stringify({ requests: [{ ...request(), indexName: 'https://attacker.test' }] }),
      JSON.stringify({ requests: [{ ...request(), indexName: 123 }] }),
      JSON.stringify({ requests: [request('query=a&query=b')] }),
      JSON.stringify({ requests: [request('action=deleteObject')] }),
      JSON.stringify({ requests: [request('x-algolia-api-key=other')] }),
      JSON.stringify({ requests: [request('query=%ZZ')] }),
      JSON.stringify({ requests: [request('query=%00')] }),
      JSON.stringify({ requests: [request('hitsPerPage=1001')] }),
      JSON.stringify({ requests: [request({ query: { action: 'delete' } })] }),
      JSON.stringify({ requests: [request('query=' + 'x'.repeat(16 * 1024))] })]) assert.equal(read([], { body }), null, body.slice(0, 120));
    const plan = read([request({ query: 'https://127.0.0.1/private', hitsPerPage: 1 })]);
    assert.equal(new URL(plan.requests[0].url).host, host, 'query text cannot choose a network destination');
  } },
  { name: 'Public header normalization cannot forward cookies bearer credentials or search keys to other hosts or paths', run() {
    const target = read().requests[0].url;
    assert.deepEqual(publicHeaders(target, { 'X-Algolia-Application-Id': app, 'X-Algolia-Api-Key': key }), headers);
    for (const extra of [{ Cookie: 'session=private' }, { Authorization: 'Bearer private' }, { 'Proxy-Authorization': 'private' }]) {
      assert.equal(read([request()], { headers: { ...headers, ...extra } }), null);
      assert.equal(publicHeaders(target, { ...headers, ...extra }), null);
    }
    for (const changed of [target.replace(host, 'attacker.test'), target.replace(host, '9999999999-dsn.algolia.net'),
      target.replace('/careers_en-US_production?', '/careers_en-US_production/settings?'),
      `${target}&query=duplicate`, `${target}&x-algolia-api-key=other`, `${target}&userToken=visitor`,
      target.replace('analytics=false', 'analytics=true')]) assert.equal(publicHeaders(changed, headers), null);
    assert.equal(publicHeaders(target, { ...headers, 'X-Algolia-Api-Key': key }), null);
    assert.equal(read([request()], { url: `${url}?x-algolia-api-key=conflicting_public_key_123` }), null);
  } },
  { name: 'Search responses synthesize the multi-query results envelope only after every bounded GET succeeds', run() {
    const plan = read(); const page = response(plan); const result = parse(plan, [page]);
    assert.deepEqual(JSON.parse(result), { results: [JSON.parse(page.body)] });
    assert.ok(!result.includes(key));
    for (const changed of [{ statusCode: 403 }, { contentType: 'text/html' }, { body: '{invalid}' }, { url: undefined },
      { url: 'https://attacker.test/' }, { body: JSON.stringify({ hits: [], nbHits: -1, page: 0 }) },
      { body: JSON.stringify({ hits: 'invalid', nbHits: 0, page: 0 }) },
      { body: JSON.stringify({ hits: [null], nbHits: 1, page: 0 }) },
      { body: JSON.stringify({ message: 'Invalid search key', status: 403 }) },
      { body: JSON.stringify({ hits: [], nbHits: 0, page: 0, oversized: 'x'.repeat(3 * 1024 * 1024) }) }]) {
      assert.equal(parse(plan, [{ ...page, ...changed }]), null);
    }
    assert.equal(parse(plan, []), null);
    assert.equal(parse({ ...plan, kind: 'another-operation' }, [page]), null);
  } },
  { name: 'Observed empty facet query derives one fixed anonymous GET using only actual index and facet names', run() {
    const plan = facetPlan(); const target = new URL(plan.requests[0].url);
    assert.equal(plan.kind, 'algolia-empty-facet-v1'); assert.equal(plan.indexName, 'careers_en-US_production'); assert.equal(plan.facetName, 'department');
    assert.equal(plan.requests.length, 1); assert.equal(target.pathname, '/1/indexes/careers_en-US_production');
    assert.equal(target.searchParams.get('facets'), '["department"]'); assert.equal(target.searchParams.get('hitsPerPage'), '0');
    assert.equal(target.searchParams.get('maxValuesPerFacet'), '10'); assert.equal(target.searchParams.get('sortFacetValuesBy'), 'count');
    for (const name of ['analytics', 'clickAnalytics', 'enablePersonalization']) assert.equal(target.searchParams.get(name), 'false');
    assert.equal(target.searchParams.has('userToken'), false); assert.equal(target.href.includes(key), false);
    assert.deepEqual(plan.requests[0].headers, headers); assert.equal(recognized(facetUrl), true);
    assert.ok(facetPlan({ url: facetUrl.replace(host, 'abcdef1234-2.algolianet.com') }));
    assert.ok(facetPlan({ url: `${facetUrl}?x-algolia-application-id=${app}&x-algolia-api-key=${key}`, headers: {} }));
  } },
  { name: 'Facet translation rejects every nonempty body or unsupported facet mutation route', run() {
    for (const body of ['[]', 'null', '"{}"', '{invalid}', '{"facetQuery":""}', '{"params":""}', '{"maxFacetHits":10}',
      '{"userToken":"visitor"}', '{"requests":[]}', '{"actions":[]}', '{"__proto__":{}}']) assert.equal(facetPlan({ body }), null, body);
    for (const target of [facetUrl.replace('/department/query', '/department/settings'), facetUrl.replace('/facets/', '/objects/'),
      facetUrl.replace('/department/query', '/department/query/batch'), facetUrl.replace('/department/query', '/%2Fquery/query'),
      facetUrl.replace(host, '0000000000-dsn.algolia.net')]) {
      assert.equal(facetPlan({ url: target }), null, target);
    }
  } },
  { name: 'Facet response derives count-sorted native values from the exact actual map and safely escapes empty-query highlighting', run() {
    const plan = facetPlan(); const dangerous = '<a href="https://foreign.test/">&\'value</a>';
    const value = facetValue({ facets: { department: { Operations: 3, [dangerous]: 7, Engineering: 9 }, unrelated: { Ignored: 999 } } });
    const parsed = JSON.parse(parse(plan, [response(plan, value)]));
    assert.deepEqual(parsed.facetHits.map(item => item.count), [9, 7, 3]); assert.equal(parsed.facetHits[1].value, dangerous);
    assert.equal(parsed.facetHits[1].highlighted, '&lt;a href=&quot;https://foreign.test/&quot;&gt;&amp;&#39;value&lt;/a&gt;');
    assert.equal(parsed.exhaustiveFacetsCount, true); assert.equal(parsed.processingTimeMS, 7);
    assert.equal(parsed.hits, undefined); assert.equal(parsed.results, undefined); assert.equal(parsed.facetHits.some(item => item.value === 'Ignored'), false);
    assert.equal(incomplete(plan, JSON.stringify(parsed)), false, 'facet metadata is not a truncated job inventory despite nbHits500');
    for (const exhaustive of [false, undefined]) {
      const result = JSON.parse(parse(plan, [response(plan, facetValue({ exhaustiveFacetsCount: exhaustive, processingTimeMS: undefined }))]));
      assert.equal(result.exhaustiveFacetsCount, false); assert.equal(result.processingTimeMS, undefined);
    }
  } },
  { name: 'Facet response validation rejects fabricated empties, wrong maps, count overflow and failed or unbounded transport', run() {
    const plan = facetPlan();
    for (const value of [facetValue({ facets: {} }), facetValue({ facets: { department: [] } }), facetValue({ hits: [{ unexpected: true }] }),
      facetValue({ facets: { department: { A: -1 } } }), facetValue({ facets: { department: { A: 1.5 } } }),
      facetValue({ facets: { department: { A: '2' } } }), facetValue({ facets: { department: { A: Number.MAX_SAFE_INTEGER + 1 } } }),
      facetValue({ facets: { department: Object.fromEntries(Array.from({ length: 11 }, (_, at) => ['Value' + at, at])) } }),
      facetValue({ facets: { department: { ['x'.repeat(1001)]: 1 } } }), facetValue({ exhaustiveFacetsCount: 'true' }),
      facetValue({ processingTimeMS: -1 }), { message: 'Denied', status: 403 }]) assert.equal(parse(plan, [response(plan, value)]), null);
    assert.equal(parse(plan, [response(plan, facetValue(), { statusCode: 403 })]), null);
    assert.equal(parse(plan, [response(plan, facetValue(), { url: 'https://foreign.test/' })]), null);
    assert.equal(parse({ ...plan, facetName: 'another' }, [response(plan, facetValue())]), null);
    let deep = {}; for (let at = 0; at < 70; at++) deep = { child: deep };
    assert.equal(parse(plan, [response(plan, facetValue({ extra: deep }))]), null);
    assert.equal(parse(plan, [response(plan, facetValue({ extra: 'x'.repeat(3 * 1024 * 1024) }))]), null);
  } },
  { name: 'Typed search coverage retains multi-query truncation checks and fails closed for malformed response kinds', run() {
    const plan = read(); const full = parse(plan, [response(plan)]);
    assert.equal(incomplete(plan, full), false);
    assert.equal(incomplete(plan, parse(plan, [response(plan, { hits: [], nbHits: 7, page: 0 })])), true);
    assert.equal(incomplete(plan, '{"results":[]}'), true); assert.equal(incomplete(plan, '{invalid}'), true);
    assert.equal(incomplete({ kind: 'unknown' }, full), true); assert.equal(incomplete(facetPlan(), '{"hits":[]}'), true);
  } },
  { name: 'Observed single-index flat query maps its exact index and filters to one bounded anonymous GET', run() {
    const plan = singlePlan(); const target = new URL(plan.requests[0].url);
    assert.equal(plan.kind, 'algolia-single-search-v1'); assert.equal(plan.indexName, 'careers_en-US_production'); assert.equal(plan.requests.length, 1);
    assert.equal(target.pathname, '/1/indexes/careers_en-US_production'); assert.equal(target.searchParams.get('query'), '');
    assert.equal(target.searchParams.get('facetFilters'), '[[],[],[]]'); assert.equal(target.searchParams.get('page'), '0');
    assert.equal(target.searchParams.get('hitsPerPage'), '100'); assert.deepEqual(plan.requests[0].headers, headers);
    for (const name of ['analytics', 'clickAnalytics', 'enablePersonalization']) assert.equal(target.searchParams.get(name), 'false');
    assert.equal(recognized(singleUrl), true); assert.equal(target.href.includes(key), false);
    const withoutVisitor = singlePlan({ body: JSON.stringify({ query: '', userToken: 'public-visitor', analytics: true }) });
    assert.equal(new URL(withoutVisitor.requests[0].url).searchParams.has('userToken'), false);
  } },
  { name: 'Single-index query rejects wrappers body-selected destinations mutating paths and unsupported flat keys', run() {
    for (const body of ['[]', 'null', '{"params":"query="}', '{"requests":[]}', '{"indexName":"other"}', '{"actions":[]}',
      '{"operation":"deleteObject"}', '{"hitsPerPage":1001}', '{"query":{"url":"https://foreign.test"}}']) assert.equal(singlePlan({ body }), null, body);
    for (const target of [singleUrl.replace('/query', '/batch'), singleUrl.replace('/query', '/settings'),
      singleUrl.replace('/query', '/deleteByQuery'), singleUrl + '/extra', singleUrl.replace(host, 'foreign.test')]) assert.equal(singlePlan({ url: target }), null, target);
  } },
  { name: 'Native single-index responses preserve actual hits and retain partial job-inventory coverage', run() {
    const plan = singlePlan(); const value = { hits: Array.from({ length: 100 }, (_, at) => ({ objectID: `synthetic-role-${at}`, title: 'Synthetic Engineer',
      apply: `https://job-boards.greenhouse.io/synthetic/jobs/${10000 + at}` })), nbHits: 2548, page: 0, hitsPerPage: 100, nbPages: 26 };
    const body = parse(plan, [response(plan, value)]);
    assert.deepEqual(JSON.parse(body), value); assert.equal(JSON.parse(body).results, undefined);
    assert.equal(incomplete(plan, body), true, '100-result pagination cannot imply all2548postings were inspected');
    assert.equal(incomplete(plan, parse(plan, [response(plan, { ...value, nbHits: 100, nbPages: 1 })])), false);
    assert.equal(parse(plan, [response(plan, value, { statusCode: 403 })]), null);
    assert.equal(parse(plan, [response(plan, value, { url: 'https://foreign.test/' })]), null);
    assert.equal(parse({ ...plan, indexName: 'other' }, [response(plan, value)]), null);
    assert.equal(parse(plan, [response(plan, { message: 'Denied', status: 403 })]), null);
    assert.equal(incomplete(plan, '{"results":[]}'), true);
  } },
  { name: 'Explicit nonexhaustive, conflicting or malformed hit-count declarations keep single and multi inventories partial', run() {
    for (const plan of [read(), singlePlan()]) {
      const value = { hits: [{ objectID: 'synthetic-role' }], nbHits: 1, page: 0 };
      for (const extra of [{ exhaustiveNbHits: false }, { exhaustive: { nbHits: false } },
        { exhaustiveNbHits: true, exhaustive: { nbHits: false } }, { exhaustiveNbHits: false, exhaustive: { nbHits: true } },
        { exhaustiveNbHits: 'true' }, { exhaustiveNbHits: null }, { exhaustive: { nbHits: 'false' } }, { exhaustive: null }]) {
        assert.equal(incomplete(plan, parse(plan, [response(plan, { ...value, ...extra })])), true, JSON.stringify(extra));
      }
      assert.equal(incomplete(plan, parse(plan, [response(plan, { ...value, exhaustiveNbHits: true, exhaustive: { nbHits: true } })])), false);
      assert.equal(incomplete(plan, parse(plan, [response(plan, { ...value, exhaustive: { facetsCount: false } })])), false,
        'unrelated facet metadata is not a hit-count assertion');
    }
  } },
];
