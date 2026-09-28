import { CONSTANTS } from './constants.js';
import net from 'node:net';
import { methodNotAllowed, notFound, sendJson } from './respond.js';
import { KeyedBuckets, makeBucket, mimeOf, readBody } from './wire.js';

const PUBLIC_ROUTES = new Map([
  ['/.well-known/oauth-authorization-server', 'GET,HEAD'], ['/.well-known/oauth-authorization-server/mcp', 'GET,HEAD'],
  ['/.well-known/openid-configuration', 'GET,HEAD'], ['/.well-known/openid-configuration/mcp', 'GET,HEAD'],
  ['/.well-known/oauth-protected-resource', 'GET,HEAD'], ['/.well-known/oauth-protected-resource/mcp', 'GET,HEAD'],
  ['/oauth/authorize', 'GET,POST'], ['/oauth/token', 'POST'], ['/oauth/revoke', 'POST'], ['/mcp', 'POST'],
]);
const WELL_KNOWN = new Set([...PUBLIC_ROUTES].filter(([p]) => p.startsWith('/.well-known/')).map(([p]) => p));
const SERVER_ROUTES = new Set(['/mcp', '/oauth/token', '/oauth/revoke']);
const unread = req => Number(req.headers?.['content-length'] || 0) > 0 || Boolean(req.headers?.['transfer-encoding']);
const OAUTH_CONSENT_POLICY_VERSION = 'document-navigation-v2';

function hostMatches(req, hostname) {
  const raw = req.headers?.host;
  const count = Array.isArray(req.rawHeaders) ? req.rawHeaders.filter((_, i) => i % 2 === 0 && String(req.rawHeaders[i]).toLowerCase() === 'host').length : 1;
  if (typeof raw !== 'string' || count !== 1) return false;
  const normalize = value => value.toLowerCase().replace(/\.(?::443)?$/, match => match === '.' ? '' : ':443');
  const expected = normalize(hostname);
  const actual = normalize(raw);
  return actual === expected || actual === `${expected}:443`;
}

function sourceAddress(req) {
  const value = String(req.headers?.['cf-connecting-ip'] || req.socket?.remoteAddress || '').trim();
  return net.isIP(value) ? value.toLowerCase() : null;
}

function addressParts(address) {
  const family = net.isIP(address);
  if (family === 4) return { family, parts: address.split('.').map(Number) };
  if (family !== 6) return null;
  const [leftText, rightText = ''] = address.toLowerCase().split('::');
  if (address.split('::').length > 2) return null;
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if (left.length + right.length > 8 || [...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return { family, parts: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(part => parseInt(part, 16)) };
}

function prefixForAddress(address, bits) {
  const parsed = addressParts(address);
  if (!parsed || !Number.isInteger(bits) || bits < 0 || bits > parsed.family * 32) return null;
  if (parsed.family === 4) {
    const octets = parsed.parts.slice();
    const whole = Math.floor(bits / 8); const rest = bits % 8;
    for (let index = whole + (rest ? 1 : 0); index < 4; index += 1) octets[index] = 0;
    if (rest) octets[whole] &= (0xff << (8 - rest));
    return `${octets.join('.')}/${bits}`;
  }
  const groups = parsed.parts.slice();
  const whole = Math.floor(bits / 16); const rest = bits % 16;
  for (let index = whole + (rest ? 1 : 0); index < 8; index += 1) groups[index] = 0;
  if (rest) groups[whole] &= (0xffff << (16 - rest));
  return `${groups.slice(0, Math.max(1, Math.ceil(bits / 16))).map(part => part.toString(16)).join(':')}::/${bits}`;
}

function cidrContains(address, cidr) {
  if (typeof cidr !== 'string') return false;
  const slash = cidr.lastIndexOf('/');
  if (slash < 1 || !/^\d{1,3}$/.test(cidr.slice(slash + 1))) return false;
  const network = cidr.slice(0, slash); const bits = Number(cidr.slice(slash + 1));
  const parsed = addressParts(address); const base = addressParts(network);
  if (!parsed || !base || parsed.family !== base.family || bits < 0 || bits > parsed.family * 32) return false;
  const unit = parsed.family === 4 ? 8 : 16;
  let remaining = bits;
  for (let index = 0; index < parsed.parts.length && remaining > 0; index += 1) {
    const take = Math.min(unit, remaining);
    const mask = take === unit ? (unit === 16 ? 0xffff : 0xff) : ((1 << take) - 1) << (unit - take);
    if ((parsed.parts[index] & mask) !== (base.parts[index] & mask)) return false;
    remaining -= take;
  }
  return true;
}

function sourceKey(req) {
  const address = sourceAddress(req);
  if (!address) return 'unknown';
  return net.isIP(address) === 4 ? address : prefixForAddress(address, CONSTANTS.BUCKET_SOURCE_V6_BITS) || 'unknown';
}

export function sourcePrefix(req) {
  const address = sourceAddress(req);
  if (!address) return 'unknown';
  return prefixForAddress(address, net.isIP(address) === 4 ? CONSTANTS.SOURCE_PREFIX_V4_BITS : CONSTANTS.SOURCE_PREFIX_V6_BITS) || 'unknown';
}

export function isConnectorSource(req, ranges = CONSTANTS.OPENAI_CONNECTOR_RANGES) {
  const address = sourceAddress(req);
  return Boolean(address && Array.isArray(ranges) && ranges.some(range => cidrContains(address, range)));
}

function closeEarly(req, res) {
  res.setHeader?.('Connection', 'close');
  if (unread(req) && req.readableEnded !== true) res.once?.('finish', () => req.destroy?.());
}
function requestTarget(req) {
  const raw = req.url;
  if (typeof raw !== 'string' || raw.length > 8192 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('#') || raw.includes('\\')) return null;
  const query = raw.indexOf('?');
  return query < 0 ? raw : raw.slice(0, query);
}
function declaredTooLarge(req, cap) {
  const value = req.headers?.['content-length'];
  return value !== undefined && (!/^(?:0|[1-9]\d*)$/.test(String(value)) || Number(value) > cap);
}
function sendMcp(res, result) {
  if (result.status === 202) { res.writeHead(202, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': '0' }); res.end(); return; }
  sendJson(res, result.status, result.body);
}
const publicOrigin = hostname => `https://${hostname.toLowerCase().replace(/\.$/, '')}`;
const originHost = value => { try { return new URL(value).host.toLowerCase(); } catch { return 'invalid'; } };
const bearerPresented = req => typeof req.headers?.authorization === 'string' && /^bearer\b/i.test(req.headers.authorization);
const classifiedMethod = value => value === 'GET' || value === 'POST' ? value : 'unknown';
const classifiedRejectionReason = value => value === 'origin-mismatch' || value === 'fetch-site' ? value : 'unknown';
const classifiedRejectionStage = value => value === 'http' || value === 'consent' ? value : 'unknown';
const classifiedConsentAction = value => value === 'approve' || value === 'deny' || value === 'other' || value === 'uninspected' ? value : 'unknown';
const classifiedTransactionPresence = value => value === 'yes' || value === 'no' || value === 'uninspected' ? value : 'unknown';
const classifiedFetchSite = value => {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return normalized === 'same-origin' || normalized === 'same-site' || normalized === 'cross-site' || normalized === 'none'
    ? normalized : normalized ? 'other' : 'none';
};
// Place the caller's network in a closed class. The prefix itself is link
// metadata and never leaves this scope.
const classifiedSourceClass = (address, ranges) => {
  if (!address) return 'unknown';
  if (Array.isArray(ranges) && ranges.some(range => cidrContains(address, range))) return 'connector-range';
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return 'private';
  } else if (/^(?:::1|f[cd])/i.test(address) || /^fe80:/i.test(address)) return 'private';
  return 'other-public';
};
const classifiedFetchHeader = (value, expected) => {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (!normalized) return 'absent';
  return normalized === expected ? expected : 'other';
};
// A browser may serialize an equivalent origin with an explicit default port,
// a trailing slash, or a different host case, and an intermediary may
// re-serialize it again on the way here. Compare what an Origin MEANS rather
// than how it was spelled: a raw string comparison refuses genuine same-origin
// consent submissions. A value that is not a bare https origin -- `null`,
// a credentialed or pathful URL, anything unparseable -- has no canonical form
// and therefore never compares equal to this origin.
const canonicalOrigin = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch { return null; }
};
function classifiedOriginShape(value, self) {
  if (value === undefined) return 'absent';
  if (value === 'null') return 'opaque-null';
  if (value === self) return 'self-exact';
  if (value === 'https://chatgpt.com') return 'chatgpt-exact';
  // Inspect a bounded origin-shaped value only to place it in a closed
  // category. Its value never leaves this request scope.
  const canonical = canonicalOrigin(value);
  if (!canonical) return 'invalid';
  return canonical === self ? 'self-canonical' : 'https-other';
}
function rawHeaderCount(req, name) {
  const rawHeaders = req?.rawHeaders;
  if (!Array.isArray(rawHeaders)) return Object.hasOwn(req?.headers || {}, name.toLowerCase()) ? 1 : 0;
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === name.toLowerCase()) count += 1;
  }
  return count;
}
const hasDuplicateAuthorization = req => rawHeaderCount(req, 'authorization') > 1;

export function createPermitPool(limit, { timers = globalThis, watchdogMs = 0, onLeak = () => undefined } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('permit limit must be positive');
  let held = 0;
  const acquire = () => {
    if (held >= limit) return null;
    held++;
    let released = false;
    let timer = null;
    try { timer = watchdogMs > 0 ? timers.setTimeout?.(() => { if (!released) { released = true; held--; try { onLeak(); } catch { /* leak reporting is best effort */ } } }, watchdogMs) : null; }
    catch { held--; return null; }
    timer?.unref?.();
    return () => {
      if (released) return;
      released = true;
      try { if (timer !== null) timers.clearTimeout?.(timer); } catch { /* held still decrements */ }
      held--;
    };
  };
  return Object.freeze({ acquire, get held() { return held; }, get limit() { return limit; } });
}

function createKeyedPermitPool(limit, { maxKeys = CONSTANTS.BUCKET_LRU_KEYS, timers = globalThis, watchdogMs = 0, onLeak = () => undefined } = {}) {
  const held = new Map();
  const acquire = key => {
    const current = held.get(key) || 0;
    if (current >= limit) return null;
    if (!held.has(key) && held.size >= maxKeys) held.delete(held.keys().next().value);
    held.delete(key); held.set(key, current + 1);
    let released = false;
    let timer = null;
    const release = (leaked = false) => {
      if (released) return;
      released = true;
      try { if (timer !== null) timers.clearTimeout?.(timer); } catch { /* held still decrements */ }
      const next = (held.get(key) || 1) - 1;
      if (next <= 0) held.delete(key); else held.set(key, next);
      if (leaked) { try { onLeak(); } catch { /* leak reporting is best effort */ } }
    };
    try { timer = watchdogMs > 0 ? timers.setTimeout?.(() => release(true), watchdogMs) : null; }
    catch {
      const next = (held.get(key) || 1) - 1;
      if (next <= 0) held.delete(key); else held.set(key, next);
      return null;
    }
    timer?.unref?.();
    return release;
  };
  return Object.freeze({ acquire, get size() { return held.size; } });
}

const busy = (req, res, seconds = 2) => { closeEarly(req, res); return sendJson(res, 503, { error: 'temporarily_unavailable', error_description: 'The handoff bridge is busy.' }, { 'Retry-After': String(seconds) }); };
const throttled = (req, res, seconds = 1) => { closeEarly(req, res); return sendJson(res, 429, { error: 'rate_limited', error_description: 'Request rate is limited.' }, { 'Retry-After': String(seconds) }); };
const mcpFailure = (res, status, message, headers = undefined) => sendJson(res, status, {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32000, message },
}, headers);
const mcpBodyFailure = (res, status) => mcpFailure(res, status, status === 413 ? 'Request body too large' : 'Request body timed out');

export function createRequestHandler({ hostname, oauth = {}, mcp, authenticate = oauth.authenticate, counters = { increment() {} }, now = Date.now, originServerRoutes = CONSTANTS.ORIGIN_SERVER_ROUTES, connectorOriginList = CONSTANTS.OPENAI_CONNECTOR_ORIGINS, sourcePolicy = CONSTANTS.SOURCE_POLICY, connectorRanges = CONSTANTS.OPENAI_CONNECTOR_RANGES, setTimeoutImpl, clearTimeoutImpl, timers = { setTimeout: setTimeoutImpl || globalThis.setTimeout, clearTimeout: clearTimeoutImpl || globalThis.clearTimeout }, audit = { write() {} }, diagnostics = { recordOAuthRejection() {}, recordSourceRejection() {} }, accepting = () => true } = {}) {
  if (typeof hostname !== 'string' || !hostname) throw new TypeError('public hostname is required');
  if (typeof mcp !== 'function') throw new TypeError('MCP handler is required');
  const connectorOrigins = new Set(Array.isArray(connectorOriginList) ? connectorOriginList : []);
  const increment = (...args) => { try { counters.increment?.(...args); } catch { /* anonymous accounting is best effort */ } };
  const writeAudit = entry => { try { audit.write?.(entry); } catch { /* audit failure must not strand a request */ } };
  const recordOAuthRejection = (pathname, req, { stage = 'http', reason, consentAction = 'uninspected', hasTxn = 'uninspected' } = {}) => {
    // This boundary intentionally translates before it records: no raw target,
    // Origin value, hostname, header, body, OAuth parameter, or credential can
    // reach the optional diagnostic sink.
    const route = pathname === '/oauth/authorize' ? 'authorize'
      : pathname === '/oauth/token' ? 'token'
        : pathname === '/oauth/revoke' ? 'revoke'
          : pathname === '/mcp' ? 'mcp' : 'unknown';
    try {
      diagnostics.recordOAuthRejection?.({
        route,
        method: classifiedMethod(req?.method),
        reason: classifiedRejectionReason(reason),
        stage: classifiedRejectionStage(stage),
        fetchSite: classifiedFetchSite(req?.headers?.['sec-fetch-site']),
        fetchMode: classifiedFetchHeader(req?.headers?.['sec-fetch-mode'], 'navigate'),
        fetchDest: classifiedFetchHeader(req?.headers?.['sec-fetch-dest'], 'document'),
        originShape: classifiedOriginShape(req?.headers?.origin, publicOrigin(hostname)),
        consentAction: classifiedConsentAction(consentAction),
        hasTxn: classifiedTransactionPresence(hasTxn),
        consentPolicyVersion: OAUTH_CONSENT_POLICY_VERSION,
      });
    } catch { /* diagnostics are never a request dependency */ }
  };
  const policyMode = async (req, route, source) => {
    let value = sourcePolicy;
    try { if (typeof value === 'function') value = await value({ request: req, route, source }); } catch { return 'enforce'; }
    return value === 'alert' || value === 'off' ? value : 'enforce';
  };
  const activeFamilies = () => {
    try {
      const links = oauth.linkStatus?.();
      return Array.isArray(links) ? links.filter(link => link?.revoked !== true) : [];
    } catch {
      // A failed link-state read must not silently turn an existing link's
      // network boundary into an allow-all rule.
      return null;
    }
  };
  const familyAllowsSource = (family, source) => source !== 'unknown'
    && Array.isArray(family?.sources) && family.sources.includes(source);
  const sourceAllowedForActiveFamily = (source, grant = null) => {
    const families = activeFamilies();
    if (!families) return false;
    if (typeof grant?.linkId === 'string') {
      const exact = families.filter(family => family?.linkId === grant.linkId);
      return exact.length === 1 && familyAllowsSource(exact[0], source);
    }
    // OAuth maintains one active family. Before bearer handling we can admit
    // only that sole family (or a separately pinned connector range below);
    // a corrupted/multi-family state is deliberately fail-closed.
    if (families.length === 0) return true;
    return families.length === 1 && familyAllowsSource(families[0], source);
  };
  const enforceSourcePolicy = async (req, res, route, grant = null) => {
    const source = sourcePrefix(req);
    const mode = await policyMode(req, route, source);
    if (mode === 'off') return true;
    const allowed = sourceAllowedForActiveFamily(source, grant) || isConnectorSource(req, connectorRanges);
    if (allowed) return true;
    increment('source_mismatch');
    // A source prefix is sensitive link metadata. The ledger deliberately
    // records only the closed event, route, and response-class vocabulary.
    writeAudit({ ev: 'source_mismatch', route, statusClass: mode === 'alert' ? '2xx' : '4xx' });
    // The wire answer below is a deliberately generic 401, so nothing in it
    // distinguishes a refused network from an expired token. Record the closed
    // classification locally, or this failure is undiagnosable from a report.
    const families = activeFamilies();
    try {
      diagnostics.recordSourceRejection?.({
        route: route === 'mcp' || route === 'token' || route === 'revoke' ? route : 'mcp',
        mode: mode === 'alert' ? 'alert' : 'enforce',
        sourceClass: classifiedSourceClass(sourceAddress(req), connectorRanges),
        links: families === null ? 'unreadable' : families.length === 0 ? 'none' : families.length === 1 ? 'one' : 'many',
      });
    } catch { /* diagnostics are never a request dependency */ }
    if (mode === 'alert') return true;
    closeEarly(req, res);
    if (route === 'mcp') {
      sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid access token is required.' }, { 'WWW-Authenticate': challenge({ presented: bearerPresented(req) }) });
      return false;
    }
    sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid access token is required.' });
    return false;
  };
  const reportLeak = pool => { increment('permit_leak'); writeAudit({ ev: 'permit_leak', pool }); };
  const authPool = createPermitPool(CONSTANTS.MCP_AUTH_INFLIGHT, { timers, watchdogMs: CONSTANTS.AUTHENTICATED_BODY_TIMEOUT_MS * 2, onLeak: () => reportLeak('mcp_auth') });
  const mcpBodyPool = createPermitPool(CONSTANTS.MCP_BODY_READ, { timers, watchdogMs: CONSTANTS.AUTHENTICATED_BODY_TIMEOUT_MS * 2, onLeak: () => reportLeak('mcp_body') });
  const anonBodyPool = createPermitPool(CONSTANTS.ANON_BODY_READ, { timers, watchdogMs: CONSTANTS.ANONYMOUS_OAUTH_BODY_DEADLINE_MS * 2, onLeak: () => reportLeak('anon_body') });
  const anonBodyBySource = createKeyedPermitPool(CONSTANTS.ANON_BODY_READ_PER_SOURCE, { timers, watchdogMs: CONSTANTS.ANONYMOUS_OAUTH_BODY_DEADLINE_MS * 2, onLeak: () => reportLeak('anon_body_source') });
  const anonGetPool = createPermitPool(CONSTANTS.ANON_GET_INFLIGHT, { timers, watchdogMs: CONSTANTS.ANONYMOUS_OAUTH_BODY_DEADLINE_MS * 2, onLeak: () => reportLeak('anon_get') });
  const sourceBuckets = Object.fromEntries([
    ['well_known', CONSTANTS.WELLKNOWN_BUCKET_CAPACITY, CONSTANTS.WELLKNOWN_BUCKET_REFILL_PER_SECOND], ['authorize', CONSTANTS.AUTHORIZE_BUCKET_CAPACITY, CONSTANTS.AUTHORIZE_BUCKET_REFILL_PER_SECOND],
    ['token_fail', CONSTANTS.TOKEN_FAIL_BUCKET_CAPACITY, CONSTANTS.TOKEN_FAIL_BUCKET_REFILL_PER_SECOND], ['revoke_fail', CONSTANTS.REVOKE_FAIL_BUCKET_CAPACITY, CONSTANTS.REVOKE_FAIL_BUCKET_REFILL_PER_SECOND], ['mcp_anon', CONSTANTS.MCP_ANON_BUCKET_CAPACITY, CONSTANTS.MCP_ANON_BUCKET_REFILL_PER_SECOND],
  ].map(([kind, capacity, perSecond]) => [kind, new KeyedBuckets({ capacity, perSecond, now })]));
  const grantBuckets = new KeyedBuckets({ capacity: CONSTANTS.AUTHENTICATED_GRANT_BUCKET_CAPACITY, perSecond: CONSTANTS.AUTHENTICATED_GRANT_BUCKET_REFILL_PER_SECOND, now });
  const aggregate = makeBucket(CONSTANTS.UNAUTHENTICATED_AGGREGATE_BURST, CONSTANTS.UNAUTHENTICATED_AGGREGATE_RATE_PER_SECOND, now);
  let aggregateOnly = false;
  const charge = (kind, source, credentialless = true) => {
    const bucket = sourceBuckets[kind];
    if (!aggregateOnly && bucket.evictionsInLastMinute() > CONSTANTS.BUCKET_EVICTIONS_PER_MINUTE) { aggregateOnly = true; writeAudit({ ev: 'rate_lru_aggregate_only', kind }); }
    const perSource = aggregateOnly ? 0 : bucket.take(source);
    // The aggregate is a second layer, not a fallback after the source bucket
    // empties: rotating source keys must not mint an unlimited global budget.
    const global = credentialless ? aggregate() : 0;
    return perSource || global;
  };
  const challenge = error => oauth.challengeHeader?.(error) || `Bearer resource_metadata="${publicOrigin(hostname)}/.well-known/oauth-protected-resource/mcp", scope="handoff"${error?.presented ? ', error="invalid_token"' : ''}`;
  const rejectToken = (req, res, error) => {
    // An expired/revoked bearer whose family was identified is intentionally
    // isolated with that family's grant bucket.  It must still receive 401,
    // but a rotating anonymous source cannot make ChatGPT's refresh path pay
    // the anonymous or aggregate limiter.
    const knownFamily = error?.knownFamily === true && typeof error.linkId === 'string' && error.linkId;
    if (knownFamily) {
      const grantWait = grantBuckets.take(error.linkId);
      if (grantWait) return throttled(req, res, grantWait);
      closeEarly(req, res);
      const knownChallenge = Object.assign(Object.create(null), error, { presented: true });
      return sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid access token is required.' }, { 'WWW-Authenticate': challenge(knownChallenge) });
    }
    increment('mcp_anon');
    // A malformed/unknown bearer is still credential-less for the aggregate.
    // Only an authenticator that positively recognizes its family may exempt
    // an expired or revoked bearer from the anonymous aggregate.
    const wait = charge('mcp_anon', sourceKey(req), !knownFamily);
    if (wait) return throttled(req, res, wait);
    closeEarly(req, res);
    const challengeError = error ? Object.assign(Object.create(null), error, { presented: Boolean(error.presented || bearerPresented(req)) }) : { presented: bearerPresented(req) };
    return sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid access token is required.' }, { 'WWW-Authenticate': challenge(challengeError) });
  };

  const validate = async (req, res) => {
    const pathname = requestTarget(req);
    if (!pathname) { closeEarly(req, res); sendJson(res, 400, { error: 'bad_request' }); return null; }
    if (!hostMatches(req, hostname)) { increment('host_mismatch'); closeEarly(req, res); sendJson(res, 421, { error: 'misdirected_request', error_description: 'Public host required.' }); return null; }
    const knownRoute = PUBLIC_ROUTES.has(pathname);
    const allowed = knownRoute ? PUBLIC_ROUTES.get(pathname).split(',') : [];
    const origin = req.headers?.origin; const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
    // OAuth clients may use a browser form POST for an authorization request
    // or the resulting consent decision.  The top-level navigation tuple is
    // allowed through to OAuth, where a transaction-bearing decision is
    // restricted to the exact ChatGPT navigation capability (or same-origin)
    // before it can issue a code. Keep the Origin/Fetch-Metadata guard on
    // every other POST.
    // Require the complete Chromium navigation tuple so an ordinary cross-site
    // fetch cannot use this exception.  Older or non-browser callers that do
    // not send it continue to use GET for authorization requests.
    const topLevelAuthorizeNavigation = knownRoute && pathname === '/oauth/authorize' && req.method === 'POST'
      && String(req.headers?.['sec-fetch-mode'] || '').toLowerCase() === 'navigate'
      && String(req.headers?.['sec-fetch-dest'] || '').toLowerCase() === 'document';
    const browserPost = knownRoute && pathname === '/oauth/authorize' && req.method === 'POST' && !topLevelAuthorizeNavigation;
    const serverEnforce = knownRoute && SERVER_ROUTES.has(pathname) && originServerRoutes === 'enforce';
    // The consent POST is authorized by this origin alone. The authenticated
    // server routes additionally accept the connector's own origin, because
    // whether it sends one at all is not settled and a 403 there would strand
    // a live link mid-drain.
    const canonical = origin ? canonicalOrigin(origin) : null;
    const originAllowed = canonical === publicOrigin(hostname)
      || (serverEnforce && !browserPost && canonical !== null && connectorOrigins.has(canonical));
    if ((browserPost || serverEnforce) && origin && !originAllowed) { recordOAuthRejection(pathname, req, { reason: 'origin-mismatch' }); closeEarly(req, res); sendJson(res, 403, { error: 'invalid_request', error_description: 'Cross-origin request refused.' }); return null; }
    if ((browserPost || serverEnforce) && (fetchSite === 'cross-site' || fetchSite === 'same-site')) { recordOAuthRejection(pathname, req, { reason: 'fetch-site' }); closeEarly(req, res); sendJson(res, 403, { error: 'invalid_request', error_description: 'Cross-origin request refused.' }); return null; }
    if (!accepting()) { closeEarly(req, res); sendJson(res, 503, { error: 'temporarily_unavailable', error_description: 'The handoff bridge is unavailable.' }, { 'Retry-After': '5' }); return null; }
    if (!knownRoute) { closeEarly(req, res); notFound(res); return null; }
    // Node exposes a coalesced `headers.authorization` value, which cannot
    // safely represent multiple raw Authorization fields. Treat that
    // ambiguity as an invalid presented credential before source accounting,
    // authentication, or body admission.
    if (hasDuplicateAuthorization(req)) {
      closeEarly(req, res);
      sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid access token is required.' }, { 'WWW-Authenticate': challenge({ presented: true }) });
      return null;
    }
    const source = sourceKey(req);
    if (pathname === '/mcp') {
      // This boundary intentionally precedes bearer parsing/lookup: a caller
      // outside the sole active family cannot exercise token reuse, key, or
      // anomaly paths. The exact-family check below remains a defense against
      // a state change between this decision and authentication.
      if (!await enforceSourcePolicy(req, res, 'mcp')) return null;
      let grant;
      try { grant = req.__icHandoffGrant || await authenticate?.(req); if (!grant || typeof grant.linkId !== 'string') throw new Error('invalid bearer'); } catch (error) {
        const releaseGet = anonGetPool.acquire();
        if (!releaseGet) { busy(req, res); return null; }
        let retained = false;
        try {
          rejectToken(req, res, error);
          if (typeof res.once === 'function') {
            let released = false;
            const release = () => { if (!released) { released = true; releaseGet(); } };
            res.once('finish', release); res.once('close', release); retained = true;
          }
        } finally { if (!retained) releaseGet(); }
        return null;
      }
      // A valid bearer identifies the exact family whose link-time prefix is
      // relevant. Anonymous or malformed credentials must take the ordinary
      // challenge/limiter path and never create a source-policy ledger event.
      if (!await enforceSourcePolicy(req, res, 'mcp', grant)) return null;
      // Recorded under enforcement too: a request that reaches here was allowed,
      // and which Origin the connector actually sends is the open MG5 question.
      // Silence is itself the finding. The ledger rotates, so this is bounded.
      if (origin || fetchSite) writeAudit({ ev: 'origin_seen', origin: origin ? originHost(origin) : undefined, secFetchSite: fetchSite || undefined, route: 'mcp' });
      const wait = grantBuckets.take(grant.linkId); if (wait) { closeEarly(req, res); mcpFailure(res, 429, 'Request rate is limited', { 'Retry-After': String(wait) }); return null; }
      if (!allowed.includes(req.method)) { closeEarly(req, res); methodNotAllowed(res, 'POST'); return null; }
      if (mimeOf(req) !== 'application/json') { closeEarly(req, res); mcpFailure(res, 415, 'application/json is required'); return null; }
      if (declaredTooLarge(req, CONSTANTS.MCP_BODY_CAP_BYTES)) { closeEarly(req, res); mcpBodyFailure(res, 413); return null; }
      const releaseAuth = authPool.acquire(); if (!releaseAuth) { busy(req, res); return null; }
      const releaseBody = mcpBodyPool.acquire(); if (!releaseBody) { releaseAuth(); busy(req, res); return null; }
      return { kind: 'mcp', pathname, source, grant, releaseAuth, releaseBody };
    }
    if (!allowed.includes(req.method)) { closeEarly(req, res); methodNotAllowed(res, allowed.join(', ')); return null; }
    if (WELL_KNOWN.has(pathname)) { const wait = charge('well_known', source); if (wait) { throttled(req, res, wait); return null; } }
    if (pathname === '/oauth/authorize') { const wait = charge('authorize', source); if (wait) { throttled(req, res, wait); return null; } }
    if (req.method === 'POST') {
      if ((pathname === '/oauth/token' || pathname === '/oauth/revoke') && !await enforceSourcePolicy(req, res, pathname.slice(1))) return null;
      if (declaredTooLarge(req, CONSTANTS.OAUTH_BODY_CAP_BYTES)) { closeEarly(req, res); sendJson(res, 413, { error: 'invalid_request', error_description: 'The request body is too large.' }); return null; }
      const releaseBody = anonBodyPool.acquire(); const releaseSource = releaseBody && anonBodyBySource.acquire(source);
      if (!releaseBody || !releaseSource) { releaseBody?.(); releaseSource?.(); busy(req, res); return null; }
      return { kind: 'oauth-post', pathname, source, releaseBody, releaseSource };
    }
    const releaseGet = anonGetPool.acquire(); if (!releaseGet) { busy(req, res); return null; }
    return { kind: 'oauth-get', pathname, source, releaseGet };
  };
  const dispatch = async (req, res, state) => {
    try {
      if (state.kind === 'mcp') {
        let bytes;
        try { bytes = await readBody(req, { capBytes: CONSTANTS.MCP_BODY_CAP_BYTES, timeoutMs: CONSTANTS.AUTHENTICATED_BODY_TIMEOUT_MS, drainOnOverflow: true, response: res, setTimeoutImpl, clearTimeoutImpl }); } finally { state.releaseBody(); }
        let body; try { body = JSON.parse(bytes.toString('utf8')); } catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        if (Array.isArray(body) || !body || typeof body !== 'object') return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        const controller = new AbortController();
        const abortOnClose = () => { if (!res.writableFinished) controller.abort(); };
        res.once?.('close', abortOnClose);
        try { return sendMcp(res, await mcp(body, { grant: state.grant, signal: controller.signal })); }
        finally { res.off?.('close', abortOnClose); }
      }
      let result;
      const serverContext = {
        hostname,
        source: state.source,
        sourcePrefix: sourcePrefix(req),
        now,
        // OAuth calls this before it writes a client-auth failure. Returning
        // true means the HTTP layer has written the 429 and OAuth must stop.
        rateFailure: kind => {
          const bucket = kind === 'revoke_fail' ? 'revoke_fail' : 'token_fail';
          const wait = charge(bucket, state.source, false);
          if (!wait) return false;
          throttled(req, res, wait);
          return true;
        },
        observeAuthenticatedServerRoute: () => {
          if ((state.pathname === '/oauth/token' || state.pathname === '/oauth/revoke') && (req.headers?.origin || req.headers?.['sec-fetch-site'])) writeAudit({ ev: 'origin_seen', origin: req.headers?.origin ? originHost(req.headers.origin) : undefined, secFetchSite: String(req.headers?.['sec-fetch-site'] || '').toLowerCase() || undefined, route: state.pathname.slice(1) });
        },
        // OAuth may reject a transaction-bearing consent POST after the outer
        // HTTP navigation exception has admitted it. Accept only its fixed
        // reason vocabulary; request data stays in this private HTTP scope.
        recordOAuthRejection: event => {
          // OAuth passes its parsed decision through only as fixed literals.
          // This closure captures the request and adds header classifications;
          // no raw header, body, or OAuth value crosses the module boundary.
          if (!event || typeof event !== 'object') return;
          if ((event.reason === 'origin-mismatch' || event.reason === 'fetch-site')
            && ['approve', 'deny', 'other'].includes(event.consentAction)
            && event.hasTxn === 'yes') {
            recordOAuthRejection(state.pathname, req, { ...event, stage: 'consent' });
          }
        },
      };
      if (typeof oauth.handle === 'function') result = await oauth.handle(req, res, state.pathname, serverContext);
      else {
        const target = state.pathname === '/.well-known/oauth-protected-resource' || state.pathname === '/.well-known/oauth-protected-resource/mcp' ? oauth.protectedResource
          : state.pathname === '/.well-known/oauth-authorization-server' || state.pathname === '/.well-known/oauth-authorization-server/mcp' || state.pathname === '/.well-known/openid-configuration' || state.pathname === '/.well-known/openid-configuration/mcp' ? oauth.authorizationServer
            : state.pathname === '/oauth/authorize' ? oauth.authorize : state.pathname === '/oauth/token' ? oauth.token : state.pathname === '/oauth/revoke' ? oauth.revoke : null;
        result = typeof target === 'function' ? await target(req, res, serverContext) : notFound(res);
      }
      return result;
    } catch (error) {
      if (!res.headersSent) {
        closeEarly(req, res);
        if (error?.status === 408 || error?.status === 413) return state.kind === 'mcp'
          ? mcpBodyFailure(res, error.status)
          : sendJson(res, error.status, { error: 'invalid_request', error_description: error.status === 413 ? 'The request body is too large.' : 'The request body timed out.' });
        return sendJson(res, 500, { error: 'server_error', error_description: 'The handoff bridge could not complete that request.' });
      }
      try { res.destroy?.(); } catch { try { req.destroy?.(); } catch { /* no safe response remains */ } }
      return undefined;
    } finally { state.releaseBody?.(); state.releaseSource?.(); state.releaseGet?.(); state.releaseAuth?.(); }
  };
  const releasePrepared = req => {
    const state = req?.__icHandoffPrepared;
    if (!state) return;
    for (const release of [state.releaseBody, state.releaseSource, state.releaseGet, state.releaseAuth]) {
      try { release?.(); } catch { /* attempt every holder */ }
    }
    try { delete req.__icHandoffPrepared; } catch { /* request objects are normally extensible */ }
  };
  const fixed500 = (req, res) => {
    try { releasePrepared(req); } catch { /* a broken release must not escape */ }
    try { closeEarly(req, res); } catch { /* response path below still tries */ }
    try {
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error', error_description: 'The handoff bridge could not complete that request.' });
      else if (!res.writableEnded) res.destroy?.();
    } catch { try { res.destroy?.(); } catch { /* no further safe action */ } }
  };
  const handler = async (req, res) => {
    try {
      req.on?.('error', () => undefined);
      res.on?.('error', () => undefined);
      const state = req.__icHandoffPrepared || await validate(req, res);
      delete req.__icHandoffPrepared;
      return state ? await dispatch(req, res, state) : undefined;
    } catch { fixed500(req, res); return undefined; }
  };
  handler.preflight = async (req, res) => {
    try { const state = await validate(req, res); if (!state) return false; req.__icHandoffPrepared = state; return true; }
    catch { fixed500(req, res); return false; }
  };
  Object.defineProperty(handler, 'pools', { value: Object.freeze({ authPool, mcpBodyPool, anonBodyPool, anonGetPool }) });
  return handler;
}

export { PUBLIC_ROUTES, sourceKey };
