// Public search clients use POST for read operations. Translate only the
// bounded Algolia query protocols to their equivalent GET searches.
// Plans contain public credentials for transport only, never source proof.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_QUERIES = 8;
const APP = /^[a-z0-9]{10}$/iu;
const INDEX = /^[a-z0-9][a-z0-9_.-]{0,127}$/iu;
const KEY = /^[a-z0-9+/=_-]{16,4096}$/iu;
const AUTH_NAMES = new Set(['x-algolia-application-id', 'x-algolia-api-key']);
const URL_KEYS = new Set([...AUTH_NAMES, 'x-algolia-agent']);
const SEARCH_KEYS = new Set(['query', 'page', 'hitsPerPage', 'facets', 'facetFilters', 'filters', 'numericFilters',
  'tagFilters', 'optionalFilters', 'sumOrFiltersScores', 'maxValuesPerFacet', 'sortFacetValuesBy', 'facetingAfterDistinct',
  'attributesToRetrieve', 'attributesToHighlight', 'attributesToSnippet', 'restrictHighlightAndSnippetArrays',
  'highlightPreTag', 'highlightPostTag', 'snippetEllipsisText', 'responseFields', 'getRankingInfo', 'analytics',
  'clickAnalytics', 'distinct', 'enableRules', 'ruleContexts', 'advancedSyntax', 'typoTolerance', 'queryType',
  'removeWordsIfNoResults', 'optionalWords', 'disableTypoToleranceOnAttributes', 'disableTypoToleranceOnWords',
  'restrictSearchableAttributes', 'enablePersonalization', 'personalizationImpact', 'enableReRanking',
  'relevancyStrictness', 'minWordSizefor1Typo', 'minWordSizefor2Typos', 'allowTyposOnNumericTokens', 'ignorePlurals',
  'removeStopWords', 'alternativesAsExact', 'exactOnSingleWordQuery', 'aroundLatLng', 'aroundLatLngViaIP',
  'aroundRadius', 'aroundPrecision', 'minimumAroundRadius', 'insideBoundingBox', 'insidePolygon']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeText = (value, limit) => typeof value === 'string' && value.length <= limit
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function algoliaUrl(value) {
  if (!safeText(value, 20_000) || /\s/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || url.port && url.port !== '443' || url.hostname.endsWith('.')) return null;
    const host = url.hostname.toLowerCase();
    const id = /^([a-z0-9]{10})(?:-dsn)?\.algolia\.net$/u.exec(host)?.[1]
      || /^([a-z0-9]{10})-[123]\.algolianet\.com$/u.exec(host)?.[1];
    return id ? { url, applicationId: id } : null;
  } catch { return null; }
}

function requestUrl(value) {
  const parsed = algoliaUrl(value);
  if (!parsed) return null;
  const multi = /^\/1\/indexes\/(?:\*|%2a)\/queries$/iu.test(parsed.url.pathname);
  const facet = /^\/1\/indexes\/([a-z0-9][a-z0-9_.-]{0,127})\/facets\/([a-z0-9][a-z0-9_.-]{0,127})\/query$/iu.exec(parsed.url.pathname);
  const single = /^\/1\/indexes\/([a-z0-9][a-z0-9_.-]{0,127})\/query$/iu.exec(parsed.url.pathname);
  if (!multi && !facet && !single) return null;
  const seen = new Set();
  for (const [name, value] of parsed.url.searchParams) {
    if (!URL_KEYS.has(name) || seen.has(name) || !safeText(value, 4096)) return null;
    seen.add(name);
    if (name === 'x-algolia-application-id' && (!APP.test(value) || value.toLowerCase() !== parsed.applicationId)) return null;
    if (name === 'x-algolia-api-key' && !KEY.test(value)) return null;
  }
  return { ...parsed, ...(facet ? { indexName: facet[1], facetName: facet[2] } : single ? { indexName: single[1] } : {}) };
}

/** URL-only recognition is for local OPTIONS handling. The subsequent POST
 * still needs the full body and credential validation below. */
export function isOfficialPostingReadOnlySearchUrl(value) { return Boolean(requestUrl(value)); }

function searchParams(value) {
  let entries;
  if (typeof value === 'string') {
    if (!safeText(value, 8192) || /%(?![a-f0-9]{2})/iu.test(value)) return null;
    entries = [...new URLSearchParams(value)];
  } else if (plain(value)) {
    entries = Object.entries(value);
  } else return null;
  if (entries.length > 64) return null;
  let nodes = 0;
  const validValue = (value, depth = 0) => {
    if (++nodes > 512 || depth > 4) return false;
    if (typeof value === 'string') return safeText(value, 8192);
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return Array.isArray(value) && value.length <= 256 && value.every(item => validValue(item, depth + 1));
  };
  const params = new URLSearchParams(); const seen = new Set();
  for (const [name, value] of entries) {
    if ((!SEARCH_KEYS.has(name) && name !== 'userToken') || seen.has(name) || !validValue(value)) return null;
    seen.add(name);
    if (name === 'userToken') {
      if (!safeText(value, 512)) return null;
      continue;
    }
    if (['page', 'hitsPerPage', 'maxValuesPerFacet'].includes(name)
      && (!/^\d+$/u.test(String(value)) || Number(value) > (name === 'page' ? 10_000 : 1000))) return null;
    params.set(name, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  // These source-page searches inspect anonymous public inventory. Preserve
  // its filters while preventing browser visitor identifiers or analytics.
  for (const name of ['analytics', 'clickAnalytics', 'enablePersonalization']) params.set(name, 'false');
  return params.toString().length <= 16_384 ? params : null;
}

/** Only resource GETs to an exact Algolia index search root may receive these
 * two public headers. Transport must call this again after each redirect. */
export function normalizeOfficialPostingPublicSearchHeaders(value, input) {
  const parsed = algoliaUrl(value);
  if (!parsed || !/^\/1\/indexes\/[a-z0-9][a-z0-9_.-]{0,127}$/iu.test(parsed.url.pathname)
    || parsed.url.searchParams.has('userToken')
    || ['analytics', 'clickAnalytics', 'enablePersonalization'].some(name => parsed.url.searchParams.has(name) && parsed.url.searchParams.get(name) !== 'false')
    || !searchParams(parsed.url.search.slice(1)) || !plain(input)) return null;
  const headers = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (!AUTH_NAMES.has(key) || own(headers, key) || typeof value !== 'string') return null;
    headers[key] = value;
  }
  const id = headers['x-algolia-application-id']; const key = headers['x-algolia-api-key'];
  if (!APP.test(id || '') || id.toLowerCase() !== parsed.applicationId || !KEY.test(key || '')) return null;
  return { 'x-algolia-application-id': id, 'x-algolia-api-key': key };
}

export function deriveOfficialPostingReadOnlySearchRequest({ url, headers = {}, body } = {}) {
  const parsed = requestUrl(url);
  if (!parsed || !plain(headers) || typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
  const auth = {}; const seenAuthHeaders = new Set();
  for (const name of AUTH_NAMES) if (parsed.url.searchParams.has(name)) auth[name] = parsed.url.searchParams.get(name);
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (['authorization', 'proxy-authorization', 'cookie', 'set-cookie'].includes(key)) return null;
    if (!AUTH_NAMES.has(key)) continue;
    if (typeof value !== 'string' || seenAuthHeaders.has(key) || own(auth, key) && auth[key] !== value) return null;
    seenAuthHeaders.add(key);
    auth[key] = value;
  }
  let input; try { input = JSON.parse(body); } catch { return null; }
  if (parsed.facetName) {
    // This observed SDK operation supplies exactly {}: no query, filters,
    // visitor state or arbitrary facet-search parameters are translated.
    if (!plain(input) || Object.keys(input).length) return null;
    const target = new URL(`/1/indexes/${parsed.indexName}`, parsed.url.origin);
    target.search = new URLSearchParams({ facets: JSON.stringify([parsed.facetName]), hitsPerPage: '0',
      maxValuesPerFacet: '10', sortFacetValuesBy: 'count', analytics: 'false', clickAnalytics: 'false', enablePersonalization: 'false' }).toString();
    const publicHeaders = normalizeOfficialPostingPublicSearchHeaders(target.href, auth);
    return publicHeaders ? { kind: 'algolia-empty-facet-v1', indexName: parsed.indexName, facetName: parsed.facetName,
      requests: [{ url: target.href, headers: publicHeaders }] } : null;
  }
  if (parsed.indexName) {
    // The observed native client supplies flat search fields. Legacy wrappers
    // and body-selected indexes do not participate in this route.
    if (!plain(input) || Object.keys(input).some(name => !SEARCH_KEYS.has(name) && name !== 'userToken')) return null;
    const params = searchParams(input); if (!params) return null;
    const target = new URL(`/1/indexes/${parsed.indexName}`, parsed.url.origin); target.search = params.toString();
    const publicHeaders = normalizeOfficialPostingPublicSearchHeaders(target.href, auth);
    return publicHeaders ? { kind: 'algolia-single-search-v1', indexName: parsed.indexName,
      requests: [{ url: target.href, headers: publicHeaders }] } : null;
  }
  if (!plain(input) || Object.keys(input).some(key => key !== 'requests') || !Array.isArray(input.requests)
    || !input.requests.length || input.requests.length > MAX_QUERIES) return null;
  const requests = [];
  for (const item of input.requests) {
    if (!plain(item) || typeof item.indexName !== 'string' || !INDEX.test(item.indexName)) return null;
    const wrapped = own(item, 'params');
    if (Object.keys(item).some(key => key !== 'indexName' && (wrapped ? key !== 'params' : !SEARCH_KEYS.has(key) && key !== 'userToken'))) return null;
    const params = searchParams(wrapped ? item.params : Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'indexName')));
    if (!params) return null;
    const target = new URL(`/1/indexes/${item.indexName}`, parsed.url.origin);
    target.search = params.toString();
    const publicHeaders = normalizeOfficialPostingPublicSearchHeaders(target.href, auth);
    if (!publicHeaders) return null;
    requests.push({ url: target.href, headers: publicHeaders });
  }
  return { kind: 'algolia-search-v1', requests };
}

function boundedResponse(value) {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 262_144 || depth > 64) return false;
    if (value && typeof value === 'object') {
      const children = Object.values(value);
      if (nodes + pending.length + children.length > 262_144) return false;
      for (let at = children.length - 1; at >= 0; at--) pending.push({ value: children[at], depth: depth + 1 });
    }
  }
  return true;
}

export function parseOfficialPostingReadOnlySearchResponse(plan, responses) {
  const facet = plan?.kind === 'algolia-empty-facet-v1';
  const single = plan?.kind === 'algolia-single-search-v1';
  if (!facet && !single && plan?.kind !== 'algolia-search-v1' || !Array.isArray(plan.requests) || !plan.requests.length
    || plan.requests.length > MAX_QUERIES || !Array.isArray(responses) || responses.length !== plan.requests.length) return null;
  if (single && (plan.requests.length !== 1 || typeof plan.indexName !== 'string' || !INDEX.test(plan.indexName))) return null;
  if (facet && (plan.requests.length !== 1 || typeof plan.indexName !== 'string' || typeof plan.facetName !== 'string'
    || !INDEX.test(plan.indexName) || !INDEX.test(plan.facetName))) return null;
  const results = []; let bytes = 0;
  for (const [at, page] of responses.entries()) {
    const request = plan.requests[at];
    if (!normalizeOfficialPostingPublicSearchHeaders(request?.url, request?.headers)
      || typeof page?.body !== 'string' || page.statusCode !== 200 || !/^(?:application\/json|application\/[^;]+\+json)(?:;|$)/iu.test(page.contentType || '')
      || (page.url || page.sourceUrl) !== request.url) return null;
    const size = Buffer.byteLength(page.body, 'utf8'); bytes += size;
    if (size > MAX_RESPONSE_BYTES || bytes > 8 * 1024 * 1024) return null;
    let result; try { result = JSON.parse(page.body); } catch { return null; }
    if (!plain(result) || !Array.isArray(result.hits) || result.hits.length > 1000 || !result.hits.every(plain)
      || !Number.isSafeInteger(result.nbHits) || result.nbHits < 0 || !Number.isSafeInteger(result.page) || result.page < 0) return null;
    if (facet) {
      const target = new URL(request.url);
      const expected = new URLSearchParams({ facets: JSON.stringify([plan.facetName]), hitsPerPage: '0', maxValuesPerFacet: '10',
        sortFacetValuesBy: 'count', analytics: 'false', clickAnalytics: 'false', enablePersonalization: 'false' });
      if (!boundedResponse(result) || target.pathname !== `/1/indexes/${plan.indexName}` || target.searchParams.toString() !== expected.toString()
        || result.hits.length || !plain(result.facets) || !own(result.facets, plan.facetName) || !plain(result.facets[plan.facetName])) return null;
      const counts = Object.entries(result.facets[plan.facetName]);
      if (counts.length > 10 || counts.some(([value, count]) => !safeText(value, 1_000) || !Number.isSafeInteger(count) || count < 0)
        || result.exhaustiveFacetsCount !== undefined && typeof result.exhaustiveFacetsCount !== 'boolean'
        || result.processingTimeMS !== undefined && (!Number.isSafeInteger(result.processingTimeMS) || result.processingTimeMS < 0)) return null;
      const escape = value => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      const facetHits = counts.map(([value, count]) => ({ value, count, highlighted: escape(value) })).sort((left, right) => right.count - left.count);
      return JSON.stringify({ facetHits, exhaustiveFacetsCount: result.exhaustiveFacetsCount === true,
        ...(result.processingTimeMS !== undefined ? { processingTimeMS: result.processingTimeMS } : {}) });
    }
    if (single) return new URL(request.url).pathname === `/1/indexes/${plan.indexName}` && boundedResponse(result) ? JSON.stringify(result) : null;
    results.push(result);
  }
  if (!boundedResponse(results)) return null;
  return JSON.stringify({ results });
}

/** Facet metadata is never evidence that a posting inventory was fetched. */
export function officialPostingReadOnlySearchCoverageIncomplete(plan, body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 8 * 1024 * 1024) return true;
  let value; try { value = JSON.parse(body); } catch { return true; }
  if (plan?.kind === 'algolia-empty-facet-v1') return !plain(value) || !Array.isArray(value.facetHits) || value.facetHits.length > 10
    || value.facetHits.some(item => !plain(item) || typeof item.value !== 'string' || typeof item.highlighted !== 'string'
      || !Number.isSafeInteger(item.count) || item.count < 0);
  const searchIncomplete = result => {
    if (!plain(result) || !Array.isArray(result.hits) || !Number.isSafeInteger(result.nbHits)
      || result.nbHits < 0 || result.nbHits > result.hits.length) return true;
    // Both documented variants describe whether the hit count is exhaustive.
    // An approximate count cannot establish absence, even when it happens to
    // fit in this page. Invalid or contradictory typed declarations stay partial.
    if (own(result, 'exhaustiveNbHits') && (typeof result.exhaustiveNbHits !== 'boolean' || result.exhaustiveNbHits === false)) return true;
    if (own(result, 'exhaustive') && (!plain(result.exhaustive) || own(result.exhaustive, 'nbHits')
      && (typeof result.exhaustive.nbHits !== 'boolean' || result.exhaustive.nbHits === false))) return true;
    return false;
  };
  if (plan?.kind === 'algolia-single-search-v1') return searchIncomplete(value);
  if (plan?.kind !== 'algolia-search-v1' || !plain(value) || !Array.isArray(value.results)
    || !Array.isArray(plan.requests) || value.results.length !== plan.requests.length || !value.results.length) return true;
  return value.results.some(searchIncomplete);
}
