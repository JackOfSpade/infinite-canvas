import crypto from 'node:crypto';
import { CONSTANTS } from './constants.js';
import { createClientAssertionVerifier, inspectAssertionClientId } from './clientAuth.js';
import { sendHtml, sendJson, sendRedirect, methodNotAllowed, notFound } from './respond.js';
import { jsonToParams, mimeOf, parseForm, readBody, WireError } from './wire.js';
import { consentCsp, consentHtml, errorHtml, ERROR_CSP } from './oauthPages.js';

const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const OIDC_SCOPES = new Set(['openid', 'email', 'profile', 'offline_access']);
const AUTHORIZATION_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';
const REVOKE_PATH = '/oauth/revoke';
const CODE_RETAIN_MS = CONSTANTS.REFRESH_ABSOLUTE_MS;
const MAX_CODES = 64;
const RENEWAL_CAUSES = new Set(['refresh_expired', 'invalid_grant']);
const UNARMED_STATUS_CAP = 999;
// Durable OAuth state contains only hashes, but it must still have a hard
// memory/disk ceiling.  Rather than silently forget a rotation (which would
// weaken refresh-reuse detection), a family at the ceiling is fail-closed and
// made to re-pair.  The values leave ample room for normal client retries.
const MAX_TOKEN_RECORDS_PER_FAMILY = 1024;
const MAX_REVOKED_FAMILIES = 8;
const MAX_REVOKED_TOKEN_RECORDS_PER_FAMILY = 8;
const MAX_RETAINED_FAMILIES = 1 + MAX_REVOKED_FAMILIES + 1;
const MAX_RENEWAL_MARKERS = 1;
const RENEWAL_MARKER_MS = 30 * 60_000;
const REVOKED_FAMILY_RETENTION_MS = CONSTANTS.REFRESH_ABSOLUTE_MS;
const b64u = value => Buffer.from(value).toString('base64url');
const sha = value => crypto.createHash('sha256').update(String(value)).digest();
const shaHex = value => sha(value).toString('hex');
const fingerprint = value => shaHex(value).slice(0, 8);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finiteTime = value => Number.isSafeInteger(value) && value >= 0;
const safeRenewalCause = value => RENEWAL_CAUSES.has(value) ? value : null;
// This is a canonical network prefix supplied by http.js, never a raw IP.
// Keeping its validation here avoids accepting arbitrary persisted text into
// linkStatus or the security ledger while preserving oauth.js's crypto-only
// node-import boundary.
function safeSourcePrefix(value) {
  if (typeof value !== 'string') return null;
  const ipv4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.0\/24$/.exec(value);
  if (ipv4) return ipv4.slice(1).every(part => Number(part) <= 255) ? value : null;
  const hextet = '(?:0|[1-9a-f][0-9a-f]{0,3})';
  return new RegExp(`^${hextet}:${hextet}:${hextet}::/48$`).test(value) ? value : null;
}

const BLANK_LOOKALIKES = String.fromCodePoint(0x2800, 0x3164, 0xffa0);
const INVISIBLE = new RegExp(`[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}${BLANK_LOOKALIKES}]`, 'gu');
export function cleanText(value, maximum, fallback) {
  if (typeof value !== 'string') return fallback;
  const plain = value.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  const stacked = plain.replace(/(\p{M}{3})\p{M}+/gu, '$1');
  return Array.from(stacked).slice(0, maximum).join('').trim() || fallback;
}

export class OAuthError extends Error {
  constructor(code, description = '', status = 400, headers = null) {
    super(description || code);
    this.name = 'OAuthError';
    this.code = code;
    this.description = description;
    this.status = status;
    this.headers = headers;
    this.presented = false;
    this.knownFamily = false;
    this.linkId = undefined;
  }
}

class PageError extends Error {
  constructor(message, status = 400, headers = null) {
    super(message);
    this.name = 'PageError';
    this.status = status;
    this.headers = headers;
  }
}

export function sameSecret(left, right) {
  return crypto.timingSafeEqual(sha(left), sha(right));
}

export function hexEqual(left, right) {
  if (!validHash(left) || !validHash(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

// Token maps are keyed by digest for bounded storage and deletion, but a
// digest made from caller input must never select a map bucket directly. Scan
// every bounded record and compare the fixed-size digests in constant time.
function fixedDigestLookup(records, digest) {
  let match = null;
  for (const candidate of records.values()) {
    if (hexEqual(digest, candidate.hash)) match = candidate;
  }
  return match;
}

export function sendOAuthError(res, error) {
  sendJson(res, error.status || 400, {
    error: error.code,
    error_description: error.description || error.code,
  }, error.headers || {});
}

function strictIssuer(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('issuer must be an https origin'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('issuer must be an https origin');
  }
  return parsed.origin;
}

// Origin normally uses its serialized form, but same-origin callers can
// preserve an equivalent default port or trailing slash. Parse only a bounded,
// syntactically origin-shaped HTTPS value for the no-Fetch-Metadata legacy
// path; document navigations intentionally do not authorize by Origin.
function strictHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && parsed.pathname === '/'
    && !parsed.search
    && !parsed.hash) return parsed;
  return null;
}

function canonicalSelfOrigin(value, base) {
  const parsed = strictHttpsOrigin(value);
  return Boolean(parsed && parsed.origin === base);
}

function normalizePairingCode(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/-/g, '').toUpperCase();
  return compact.length === CONSTANTS.PAIRING_CODE_LENGTH_CHARS
    && Array.from(compact).every(symbol => CONSTANTS.PAIRING_CODE_ALPHABET.includes(symbol)) ? compact : null;
}

function parseScope(value, requiredScope) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 1024) return null;
  const tokens = value.split(' ');
  if (tokens.some(token => !/^[A-Za-z0-9._:-]{1,128}$/.test(token))) return null;
  const unique = [...new Set(tokens)];
  return unique.every(token => token === requiredScope || OIDC_SCOPES.has(token)) ? unique : null;
}

function sealPair(predecessor, refresh, access, randomBytes) {
  const nonce = randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sha(`grace\n${predecessor}`), nonce);
  const body = Buffer.concat([cipher.update(`${refresh}\n${access}`, 'utf8'), cipher.final()]);
  return `${b64u(nonce)}.${b64u(cipher.getAuthTag())}.${b64u(body)}`;
}

function openPair(predecessor, sealed) {
  if (typeof sealed !== 'string') return null;
  try {
    const pieces = sealed.split('.');
    if (pieces.length !== 3) return null;
    const nonce = Buffer.from(pieces[0], 'base64url');
    const tag = Buffer.from(pieces[1], 'base64url');
    const body = Buffer.from(pieces[2], 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || body.length === 0) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', sha(`grace\n${predecessor}`), nonce);
    decipher.setAuthTag(tag);
    const values = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8').split('\n');
    if (values.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]) || !/^[A-Za-z0-9_-]{43}$/.test(values[1])) return null;
    return { refresh: values[0], access: values[1] };
  } catch { return null; }
}

function emptyPersistedState() {
  return { v: 1, clients: [], codes: [], families: [], refresh: [], access: [] };
}

function authorizationQuery(req) {
  const target = typeof req.url === 'string' ? req.url : '';
  const question = target.indexOf('?');
  try { return parseForm(question < 0 ? '' : target.slice(question + 1)); }
  catch { throw new PageError('The authorization request is malformed.'); }
}

function redirectError(res, redirectUri, state, issuer, code, description) {
  sendRedirect(res, redirectUri, [
    ['error', code], ['error_description', description], ['state', state], ['iss', issuer],
  ]);
}

function copyClient(client) {
  return {
    id: client.id,
    clientKind: client.clientKind,
    clientHost: client.clientHost,
    name: client.name,
    redirectUris: client.redirectUris.slice(),
    grantTypes: client.grantTypes.slice(),
    authMethods: client.authMethods.slice(),
    jwksUri: client.jwksUri,
    metadataHash: client.metadataHash,
  };
}

export function createOAuthServer({
  issuer,
  store = { read: emptyPersistedState, commit: () => true, flush: () => true },
  fetchClientMetadata = async () => null,
  fetchJwks = async () => null,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  emitSecurityEvent = () => undefined,
  recordClientAuth = () => undefined,
  onAuthorizeWithoutWindow = () => undefined,
  onConsentRequested = () => undefined,
  onLinked = () => undefined,
  onDisconnected = () => undefined,
  onPairingClosed = () => undefined,
  pairingGate = () => true,
  readBody: readBodyImpl = readBody,
  tokenAuthMode = CONSTANTS.TOKEN_AUTH_MODE,
  asAuthMethods = CONSTANTS.AS_AUTH_METHODS,
} = {}) {
  const base = strictIssuer(issuer);
  if (typeof fetchClientMetadata !== 'function' || typeof fetchJwks !== 'function') throw new TypeError('OAuth metadata ports are required');
  if (!['observe-both', 'require-assertion'].includes(tokenAuthMode)) throw new TypeError('unknown token authentication mode');
  if (!Array.isArray(asAuthMethods) || asAuthMethods.some(method => method !== 'none' && method !== 'private_key_jwt')) throw new TypeError('unknown authorization method');

  const resource = `${base}${CONSTANTS.MCP_PATH}`;
  const tokenEndpoint = `${base}${TOKEN_PATH}`;
  const pinnedClientId = CONSTANTS.CIMD_CLIENT_IDS[0];
  const verifier = createClientAssertionVerifier({ fetchJwks, now, issuer: base, tokenEndpoint, clientId: pinnedClientId });
  const clients = new Map();
  const transactions = new Map();
  const codes = new Map();
  const families = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Map();
  const counters = {
    authorizeWithoutWindow: 0,
    codeReuseRevocations: 0,
    reuseRevocations: 0,
    refreshExpired: 0,
    revocations: 0,
    clientAuthFailures: 0,
  };
  let pairing = null;
  // Anonymous authorize attempts are status-only diagnostics. They are never
  // persisted, logged, audited, or used as a remote notification trigger.
  let unarmedRequests = { count: 0, lastAt: null };

  const safeCall = (fn, ...args) => {
    try { return fn(...args); } catch { return undefined; }
  };
  const emit = (event, fields) => safeCall(emitSecurityEvent, event, fields);
  const newSecret = () => b64u(randomBytes(32));
  const newId = () => b64u(randomBytes(18));

  function load() {
    let normalized = false;
    let state;
    try { state = store.read?.(); } catch { state = null; }
    if (!isObject(state) || state.v !== 1 || state.issuer !== base) return normalized;
    for (const item of Array.isArray(state.clients) ? state.clients : []) {
      if (!isObject(item) || item.id !== pinnedClientId || item.clientKind !== 'cimd' || item.clientHost !== 'chatgpt.com'
        || typeof item.name !== 'string' || !Array.isArray(item.redirectUris) || item.redirectUris.length !== 1 || item.redirectUris[0] !== REDIRECT_URI
        || !Array.isArray(item.grantTypes) || !item.grantTypes.includes('authorization_code') || !item.grantTypes.includes('refresh_token')
        // A persisted client may be assertion-only now that production no
        // longer accepts `none`. It still has to advertise at least one of
        // the two closed methods; an empty or foreign-only list is invalid.
        || !Array.isArray(item.authMethods) || (!item.authMethods.includes('none') && !item.authMethods.includes('private_key_jwt'))
        || item.authMethods.some(method => method !== 'none' && method !== 'private_key_jwt')
        || (item.authMethods.includes('private_key_jwt') && item.jwksUri !== CONSTANTS.JWKS_URL)
        || typeof item.metadataHash !== 'string') continue;
      clients.set(item.id, {
        id: item.id,
        clientKind: 'cimd',
        clientHost: 'chatgpt.com',
        name: cleanText(item.name, 120, 'ChatGPT'),
        redirectUris: Object.freeze([REDIRECT_URI]),
        grantTypes: Object.freeze(['authorization_code', 'refresh_token']),
        authMethods: Object.freeze([...item.authMethods]),
        jwksUri: item.authMethods.includes('private_key_jwt') ? CONSTANTS.JWKS_URL : null,
        metadataHash: item.metadataHash,
      });
    }
    for (const item of Array.isArray(state.families) ? state.families : []) {
      if (!isObject(item) || typeof item.id !== 'string' || item.clientId !== pinnedClientId || typeof item.clientKind !== 'string'
        || !finiteTime(item.createdAt) || !finiteTime(item.lastRefreshedAt) || !finiteTime(item.idleExpiresAt) || !finiteTime(item.absoluteExpiresAt)) continue;
      const renewalCause = safeRenewalCause(item.renewalCause);
      const renewalAt = finiteTime(item.renewalAt) ? item.renewalAt : null;
      // A renewal marker is an explicit proof that the credential family must
      // no longer authenticate. Treat a malformed durable combination
      // (`renewalCause` plus `revoked:false`) as revoked during load, before
      // access hashes are ever made available to authenticate().
      const renewalRevoked = Boolean(renewalCause);
      if (renewalRevoked && item.revoked !== true) normalized = true;
      families.set(item.id, {
        id: item.id,
        linkId: shaHex(`link\n${item.id}`).slice(0, 12),
        clientId: pinnedClientId,
        clientKind: item.clientKind,
        resource,
        scope: CONSTANTS.SCOPE,
        requested: Array.isArray(item.requested) ? item.requested.filter(token => typeof token === 'string').slice(0, 16) : [],
        createdAt: item.createdAt,
        lastRefreshedAt: item.lastRefreshedAt,
        idleExpiresAt: item.idleExpiresAt,
        absoluteExpiresAt: item.absoluteExpiresAt,
        sourcePrefix: safeSourcePrefix(item.sourcePrefix),
        renewalCause,
        renewalAt,
        revoked: item.revoked === true || renewalRevoked,
        // A corrupt live family has no trustworthy prior revocation time; the
        // marker's own time becomes its conservative revocation boundary.
        revokedAt: renewalRevoked && item.revoked !== true
          ? (renewalAt ?? now())
          : (finiteTime(item.revokedAt) ? item.revokedAt : (renewalRevoked ? (renewalAt ?? now()) : 0)),
      });
    }
    for (const item of Array.isArray(state.codes) ? state.codes : []) {
      if (!isObject(item) || !validHash(item.hash) || item.clientId !== pinnedClientId || typeof item.redirectUri !== 'string'
        || typeof item.challenge !== 'string' || !finiteTime(item.expiresAt) || !finiteTime(item.retainUntil)) continue;
      codes.set(item.hash, {
        hash: item.hash,
        clientId: pinnedClientId,
        redirectUri: item.redirectUri,
        challenge: item.challenge,
        requested: Array.isArray(item.requested) ? item.requested.filter(token => typeof token === 'string').slice(0, 16) : [],
        expiresAt: item.expiresAt,
        retainUntil: item.retainUntil,
        used: item.used === true,
        familyId: typeof item.familyId === 'string' ? item.familyId : null,
      });
    }
    for (const item of Array.isArray(state.refresh) ? state.refresh : []) {
      if (!isObject(item) || !validHash(item.hash) || !families.has(item.familyId)) continue;
      refreshTokens.set(item.hash, {
        hash: item.hash,
        familyId: item.familyId,
        supersededAt: item.supersededAt === null || finiteTime(item.supersededAt) ? item.supersededAt : null,
        successor: validHash(item.successor) ? item.successor : null,
        grace: typeof item.grace === 'string' ? item.grace : null,
      });
    }
    for (const item of Array.isArray(state.access) ? state.access : []) {
      if (!isObject(item) || !validHash(item.hash) || !families.has(item.familyId) || !finiteTime(item.expiresAt)) continue;
      accessTokens.set(item.hash, {
        hash: item.hash,
        familyId: item.familyId,
        scope: CONSTANTS.SCOPE,
        expiresAt: item.expiresAt,
        revoked: item.revoked === true,
      });
    }
    return normalized;
  }
  const loadWasNormalized = load();
  // Function declarations below are hoisted.  Compact immediately after load
  // as well as on every route so a malformed/old durable file cannot create an
  // unbounded in-memory map for the lifetime of a process.
  const loadWasCompacted = sweep() || loadWasNormalized;

  function persistedState() {
    // Commit only the bounded projection. This also catches a revoked family
    // produced by a just-completed grant before its hashes reach disk again.
    sweep();
    return {
      v: 1,
      issuer: base,
      clients: [...clients.values()].map(copyClient),
      codes: [...codes.values()].map(record => ({
        hash: record.hash,
        clientId: record.clientId,
        redirectUri: record.redirectUri,
        challenge: record.challenge,
        requested: record.requested.slice(),
        expiresAt: record.expiresAt,
        retainUntil: record.retainUntil,
        used: record.used,
        familyId: record.familyId,
      })),
      families: [...families.values()].map(family => ({
        id: family.id,
        clientId: family.clientId,
        clientKind: family.clientKind,
        requested: family.requested.slice(),
        createdAt: family.createdAt,
        lastRefreshedAt: family.lastRefreshedAt,
        idleExpiresAt: family.idleExpiresAt,
        absoluteExpiresAt: family.absoluteExpiresAt,
        sourcePrefix: family.sourcePrefix,
        renewalCause: safeRenewalCause(family.renewalCause),
        renewalAt: finiteTime(family.renewalAt) ? family.renewalAt : null,
        revoked: family.revoked,
        revokedAt: family.revokedAt,
      })),
      refresh: [...refreshTokens.values()].map(record => ({
        hash: record.hash,
        familyId: record.familyId,
        supersededAt: record.supersededAt,
        successor: record.successor,
        grace: record.grace,
      })),
      access: [...accessTokens.values()].map(record => ({
        hash: record.hash,
        familyId: record.familyId,
        scope: record.scope,
        expiresAt: record.expiresAt,
        revoked: record.revoked,
      })),
    };
  }

  const commit = () => {
    try { return store.commit?.(persistedState()) === true; } catch { return false; }
  };
  // A successful compaction is a safe, smaller projection of the validated
  // state we just read. Failure remains fail-closed in memory and is retried by
  // the next normal durable OAuth transition.
  if (loadWasCompacted) { try { commit(); } catch { /* durable writes are checked by mutations */ } }
  const persistOrThrow = () => {
    if (!commit()) throw new OAuthError('temporarily_unavailable', 'State could not be saved', 503, { 'Retry-After': '5' });
  };
  const sweepAndCommit = () => {
    if (!sweep()) return false;
    // Sweep-only expiry/GC is a safe reduction. If disk happens to be
    // unavailable, retain the smaller in-memory state and retry on the next
    // mutation; it must never resurrect an expired or revoked family here.
    try { return commit(); } catch { return false; }
  };
  const knownGrantError = (code, description, family) => {
    const error = new OAuthError(code, description);
    if (family) { error.knownFamily = true; error.linkId = family.linkId; }
    return error;
  };
  const unarmedStatus = () => Object.freeze({
    count: Math.max(0, Math.min(UNARMED_STATUS_CAP, Number(unarmedRequests.count) || 0)),
    lastAt: finiteTime(unarmedRequests.lastAt) ? unarmedRequests.lastAt : null,
  });
  const activeRenewalFamily = () => [...families.values()].find(family => safeRenewalCause(family.renewalCause)
    && finiteTime(family.renewalAt)
    && now() - family.renewalAt <= RENEWAL_MARKER_MS) || null;
  const boundedSource = value => typeof value === 'string' && value.length <= 128 && /^[0-9a-f.:/]+$/i.test(value) ? value : null;
  function noteUnarmedAuthorize(serverContext = {}) {
    unarmedRequests = {
      count: Math.min(UNARMED_STATUS_CAP, (Number(unarmedRequests.count) || 0) + 1),
      lastAt: now(),
    };
    counters.authorizeWithoutWindow += 1;
    const family = activeRenewalFamily();
    // This port carries only a bounded source shape and closed status enums.
    // It never has authority to open a sheet, display a notice, or write an
    // audit/log entry; pairing's maybeHint applies the final own-egress gate.
    safeCall(onAuthorizeWithoutWindow, {
      source: boundedSource(serverContext.source),
      linkState: family ? 'needs-renewal' : ([...families.values()].some(item => !item.revoked) ? 'linked' : 'unlinked'),
      knownFamily: Boolean(family),
    });
  }
  function markNeedsRenewal(family, cause) {
    if (!family || !safeRenewalCause(cause)) return false;
    // A renewal marker is retained only as safe status metadata. The expired
    // family itself is no longer authenticatable or source-authoritative:
    // recovery is a new authorization-code exchange, never an old access or
    // refresh bearer from a newly permitted network.
    if (family.revoked && !safeRenewalCause(family.renewalCause)) return false;
    family.renewalCause = cause;
    family.renewalAt = now();
    markRevoked(family);
    persistOrThrow();
    safeCall(onDisconnected, { linkId: family.linkId, reason: cause });
    return true;
  }
  const activePairing = () => pairing && pairing.expiresAt > now() ? pairing : null;

  function deleteFamilyTokens(familyId) {
    for (const [hash, record] of refreshTokens) if (record.familyId === familyId) refreshTokens.delete(hash);
    for (const [hash, record] of accessTokens) if (record.familyId === familyId) accessTokens.delete(hash);
  }

  function tokenCount(records, familyId) {
    let count = 0;
    for (const record of records.values()) if (record.familyId === familyId) count += 1;
    return count;
  }

  function capacityFor(family, { access = 0, refresh = 0 } = {}) {
    if (!family || family.revoked) return false;
    return tokenCount(accessTokens, family.id) + access <= MAX_TOKEN_RECORDS_PER_FAMILY
      && tokenCount(refreshTokens, family.id) + refresh <= MAX_TOKEN_RECORDS_PER_FAMILY;
  }

  function trimRevokedFamilyTokens(familyId) {
    let changed = false;
    for (const records of [accessTokens, refreshTokens]) {
      const owned = [...records.entries()].filter(([, record]) => record.familyId === familyId);
      while (owned.length > MAX_REVOKED_TOKEN_RECORDS_PER_FAMILY) {
        const [hash] = owned.shift();
        records.delete(hash);
        changed = true;
      }
    }
    return changed;
  }

  function compactDurableState(current) {
    let changed = false;
    // Expired access hashes cannot authenticate. Keep a revoked-but-unexpired
    // record while its family is retained: authenticate() can then classify a
    // known revoked credential without weakening reuse/grace semantics.
    for (const [hash, record] of accessTokens) {
      const family = families.get(record.familyId);
      if (!family || record.expiresAt <= current) {
        accessTokens.delete(hash); changed = true;
      }
    }
    const active = [...families.values()].filter(family => !family.revoked)
      .sort((left, right) => right.createdAt - left.createdAt || right.lastRefreshedAt - left.lastRefreshedAt);
    // Normal code grants already enforce one active family. A corrupted state
    // with more than one is reduced fail-closed to its newest one.
    for (const family of active.slice(1)) {
      family.renewalCause = 'invalid_grant';
      family.renewalAt = current;
      markRevoked(family);
      changed = true;
    }
    for (const family of active.slice(0, 1)) {
      if (tokenCount(accessTokens, family.id) > MAX_TOKEN_RECORDS_PER_FAMILY
          || tokenCount(refreshTokens, family.id) > MAX_TOKEN_RECORDS_PER_FAMILY) {
        family.renewalCause = 'invalid_grant';
        family.renewalAt = current;
        markRevoked(family);
        changed = true;
      }
    }
    // A reconnect marker is short-lived UI/pairing state, not a second
    // durable link. Once its hint window closes, retain at most the ordinary
    // revoked forensic family but remove the marker so linkStatus cannot keep
    // advertising a stale renewal path forever.
    for (const family of families.values()) {
      if (!family.revoked || !safeRenewalCause(family.renewalCause)) continue;
      if (!finiteTime(family.renewalAt) || family.renewalAt > current || current - family.renewalAt > RENEWAL_MARKER_MS) {
        family.renewalCause = null;
        family.renewalAt = null;
        changed = true;
      }
    }
    const renewal = [...families.values()]
      .filter(family => family.revoked && safeRenewalCause(family.renewalCause)
        && finiteTime(family.renewalAt) && family.renewalAt <= current
        && current - family.renewalAt <= RENEWAL_MARKER_MS)
      .sort((left, right) => right.renewalAt - left.renewalAt);
    const keepMarkers = new Set(renewal.slice(0, MAX_RENEWAL_MARKERS).map(family => family.id));
    const retainedRevoked = [...families.values()]
      .filter(family => family.revoked && !keepMarkers.has(family.id)
        && finiteTime(family.revokedAt) && family.revokedAt <= current
        && current - family.revokedAt <= REVOKED_FAMILY_RETENTION_MS)
      .sort((left, right) => right.revokedAt - left.revokedAt);
    const keepRevoked = new Set(retainedRevoked.slice(0, MAX_REVOKED_FAMILIES).map(family => family.id));
    for (const family of [...families.values()]) {
      if (!family.revoked) continue;
      if (keepMarkers.has(family.id)) {
        const hadTokens = tokenCount(accessTokens, family.id) > 0 || tokenCount(refreshTokens, family.id) > 0;
        deleteFamilyTokens(family.id);
        if (hadTokens) changed = true;
        continue;
      }
      if (keepRevoked.has(family.id)) {
        // Retain a tiny bounded set so a recently revoked/replaced bearer can
        // still be classified as a known family (and isolated by HTTP's grant
        // limiter), while preventing relink/rotation history from expanding
        // either durable token map. Grace replay is only meaningful for the
        // active family and is never trimmed here.
        if (trimRevokedFamilyTokens(family.id)) changed = true;
        continue;
      }
      if (!keepRevoked.has(family.id)) {
        deleteFamilyTokens(family.id);
        families.delete(family.id);
        changed = true;
      }
    }
    // Keep at most the one active family plus the newest renewal marker. This
    // last belt applies when a hostile durable file supplied odd timestamps.
    if (families.size > MAX_RETAINED_FAMILIES) {
      const removable = [...families.values()].filter(family => family.revoked)
        .sort((left, right) => left.createdAt - right.createdAt);
      while (families.size > MAX_RETAINED_FAMILIES && removable.length) {
        const family = removable.shift();
        deleteFamilyTokens(family.id);
        families.delete(family.id);
        changed = true;
      }
    }
    return changed;
  }

  function sweep() {
    const current = now();
    let changed = false;
    for (const [id, transaction] of transactions) if (transaction.expiresAt <= current) { transactions.delete(id); changed = true; }
    for (const [hash, code] of codes) if (code.retainUntil <= current) { codes.delete(hash); changed = true; }
    while (codes.size > MAX_CODES) { codes.delete(codes.keys().next().value); changed = true; }
    if (pairing && pairing.expiresAt <= current) { endPairing(); changed = true; }
    return compactDurableState(current) || changed;
  }

  async function clientFor(clientId, { forceFetch = false } = {}) {
    if (clientId !== pinnedClientId) return null;
    if (!forceFetch && clients.has(clientId)) return clients.get(clientId);
    try {
      const client = await fetchClientMetadata(clientId);
      if (!isObject(client) || client.id !== clientId || client.clientKind !== 'cimd' || !Array.isArray(client.redirectUris)
        || !client.redirectUris.includes(REDIRECT_URI) || !Array.isArray(client.authMethods)) return null;
      const persisted = copyClient(client);
      clients.set(client.id, persisted);
      return persisted;
    } catch { return null; }
  }

  const gateAllows = req => {
    try { return pairingGate(req) === true; } catch { return false; }
  };

  function sameResource(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
      const path = parsed.pathname.length > 1 && parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
      return parsed.origin === base && path === CONSTANTS.MCP_PATH;
    } catch { return false; }
  }

  function openPairing() {
    let compact = '';
    while (compact.length < CONSTANTS.PAIRING_CODE_LENGTH_CHARS) {
      const bytes = randomBytes(CONSTANTS.PAIRING_CODE_LENGTH_CHARS - compact.length);
      for (const byte of bytes) {
        if (byte < 224) compact += CONSTANTS.PAIRING_CODE_ALPHABET[byte % CONSTANTS.PAIRING_CODE_ALPHABET.length];
        if (compact.length === CONSTANTS.PAIRING_CODE_LENGTH_CHARS) break;
      }
    }
    pairing = { hash: shaHex(compact), expiresAt: now() + CONSTANTS.PAIRING_TTL_MS, wrong: 0 };
    transactions.clear();
    return `${compact.slice(0, 5)}-${compact.slice(5)}`;
  }

  // The only browser-side terminal pairing outcomes that need to close the
  // native sheet are fixed enums.  The normal main-process close path remains
  // silent so pairing can call it without a callback cycle.
  function endPairing(reason = null) {
    pairing = null;
    transactions.clear();
    if (reason === 'denied' || reason === 'locked') safeCall(onPairingClosed, reason);
  }

  function closePairing() {
    endPairing();
    return true;
  }

  async function beginAuthorization(req, res, serverContext, parsed) {
    sweep();
    if (!activePairing() || !gateAllows(req)) {
      noteUnarmedAuthorize(serverContext);
      throw new PageError('No pairing session is open on this Mac. Open pairing, then try again from ChatGPT.', 403);
    }
    const query = parsed.values;
    if (!query.client_id || !query.redirect_uri || parsed.dups.has('client_id') || parsed.dups.has('redirect_uri')) {
      throw new PageError('The request is missing a client or a redirect address.');
    }
    const client = await clientFor(query.client_id, { forceFetch: true });
    // Client metadata is the only awaited step before a consent transaction.
    // A native cancel/expiry while it is in flight must not resurrect the
    // pairing or enqueue a notice once that request eventually returns.
    if (!activePairing() || !gateAllows(req)) throw new PageError('This pairing window is closed.', 403);
    if (!client || query.redirect_uri !== REDIRECT_URI || !client.redirectUris.includes(query.redirect_uri)) {
      throw new PageError('The authorization request is not recognised.');
    }
    const safeState = typeof query.state === 'string' && query.state.length <= 4096 ? query.state : undefined;
    let error = null;
    let description = '';
    if (query.response_type !== 'code') { error = 'unsupported_response_type'; description = 'Only the code response type is supported'; }
    else if (parsed.dups.size > 0) { error = 'invalid_request'; description = 'A parameter was repeated'; }
    else if (query.state !== undefined && safeState === undefined) { error = 'invalid_request'; description = 'state is too long'; }
    else if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge || '')) {
      error = 'invalid_request'; description = 'PKCE S256 is required';
    } else if (!sameResource(query.resource)) { error = 'invalid_target'; description = 'resource does not match this server'; }
    const requested = error ? null : parseScope(query.scope, CONSTANTS.SCOPE);
    if (!error && requested === null) { error = 'invalid_scope'; description = 'The requested scope is not supported'; }
    if (error) return redirectError(res, REDIRECT_URI, safeState, base, error, description);

    transactions.clear();
    const transaction = {
      id: newId(),
      clientId: client.id,
      clientKind: client.clientKind,
      clientHost: client.clientHost,
      clientName: cleanText(client.name, 120, 'ChatGPT'),
      redirectUri: REDIRECT_URI,
      state: safeState || '',
      challenge: query.code_challenge,
      requested,
      expiresAt: now() + CONSTANTS.TXN_TTL_MS,
      wrong: 0,
    };
    transactions.set(transaction.id, transaction);
    safeCall(onConsentRequested, { clientKind: transaction.clientKind });
    return sendHtml(res, 200, consentHtml(transaction), consentCsp(transaction));
  }

  async function authorizeGet(req, res, serverContext = {}) {
    return beginAuthorization(req, res, serverContext, authorizationQuery(req));
  }

  async function authorizePost(req, res, serverContext = {}) {
    sweep();
    const body = await readBodyImpl(req, {
      capBytes: CONSTANTS.OAUTH_BODY_CAP_BYTES,
      timeoutMs: CONSTANTS.ANONYMOUS_OAUTH_BODY_DEADLINE_MS,
      response: res,
    });
    if (mimeOf(req) !== 'application/x-www-form-urlencoded') throw new PageError('Unsupported form encoding.');
    let parsed;
    try { parsed = parseForm(body.toString('utf8')); } catch { throw new PageError('The form could not be read.'); }
    // A top-level cross-site navigation can carry a standards-compliant
    // authorization request as form data. It has no transaction identifier;
    // a transaction-bearing request is necessarily a consent decision and is
    // checked below against the narrow capability-bound consent policy.
    if (!Object.hasOwn(parsed.values, 'txn')) return beginAuthorization(req, res, serverContext, parsed);
    // Browser popup and tunnel layers do not preserve a stable Origin or
    // Sec-Fetch-Site value for a document form submission.  They are therefore
    // transport hints, not authorization credentials.  A complete document
    // navigation may submit a decision regardless of those serializations.
    // The decision is instead capability-bound to the 144-bit transaction,
    // active short-lived pairing window, and local pairing code for either
    // terminal decision. The transaction is not exposed cross-origin: responses have
    // no-referrer, no-store, frame denial, and a pinned form-action allowlist.
    //
    // Also admit a caller whose Origin provably serializes to this very origin,
    // whatever the Fetch-Metadata tuple looks like. A partial tuple is what an
    // intermediary produces when it drops a Sec-Fetch-* field in transit, and
    // refusing our own consent page over a dropped transport hint is exactly
    // the failure this policy exists to stop. It is also strictly narrower
    // than the document-navigation path above, which accepts any Origin: no
    // cross-site caller can set Origin to this origin. A caller with no Origin
    // and no metadata is the remaining non-browser legacy shape. Anything else
    // is rejected before touching the transaction or wrong-code counters.
    const origin = req.headers?.origin;
    const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
    const fetchMode = String(req.headers?.['sec-fetch-mode'] || '').toLowerCase();
    const fetchDest = String(req.headers?.['sec-fetch-dest'] || '').toLowerCase();
    const documentNavigation = fetchMode === 'navigate' && fetchDest === 'document';
    const hasFetchMetadata = Boolean(fetchSite || fetchMode || fetchDest);
    const ownOriginConsent = origin ? canonicalSelfOrigin(origin, base) : !hasFetchMetadata;
    if (!documentNavigation && !ownOriginConsent) {
      // http.js captures request headers and reduces them into closed
      // classifications. Do not pass a header, body, OAuth value, pairing
      // value, or transaction identifier across this boundary.
      const reason = origin && !canonicalSelfOrigin(origin, base)
        ? 'origin-mismatch' : 'fetch-site';
      const rawAction = parsed.values.action;
      const consentAction = rawAction === 'approve' ? 'approve' : rawAction === 'deny' ? 'deny' : 'other';
      safeCall(serverContext?.recordOAuthRejection, { reason, consentAction, hasTxn: 'yes' });
      throw new PageError('Cross-origin request refused.', 403);
    }
    const currentPairing = activePairing();
    if (!currentPairing || !gateAllows(req)) throw new PageError('This pairing window is closed.', 403);
    const transaction = parsed.dups.size === 0 && typeof parsed.values.txn === 'string' ? transactions.get(parsed.values.txn) : null;
    if (!transaction || transaction.expiresAt <= now()) {
      if (transaction) transactions.delete(transaction.id);
      throw new PageError('This approval request expired or was already used. Start again from ChatGPT.');
    }
    // Browsers normally include the clicked submit button's name.  Normalize
    // the implicit Enter submission only when it contains a pairing code, so
    // it is an approval attempt rather than an unlabelled terminal action.
    const action = parsed.values.action === undefined && parsed.values.pairing_code ? 'approve' : parsed.values.action;
    if (action !== 'approve' && action !== 'deny') throw new PageError('Unknown action.');
    const compact = normalizePairingCode(parsed.values.pairing_code);
    const matched = compact && hexEqual(currentPairing.hash, shaHex(compact));
    if (!matched) {
      transaction.wrong += 1;
      currentPairing.wrong += 1;
      const requestLocked = transaction.wrong >= CONSTANTS.PAIRING_WRONG_TRIES_PER_REQUEST;
      const windowLocked = currentPairing.wrong >= CONSTANTS.PAIRING_WRONG_TRIES_PER_WINDOW;
      if (requestLocked) transactions.delete(transaction.id);
      if (windowLocked) endPairing('locked');
      if (requestLocked || windowLocked) {
        return redirectError(res, transaction.redirectUri, transaction.state, base, 'access_denied', 'Too many wrong pairing codes');
      }
      const left = CONSTANTS.PAIRING_WRONG_TRIES_PER_REQUEST - transaction.wrong;
      return sendHtml(res, 200, consentHtml(transaction, `That pairing code did not match. ${left} ${left === 1 ? 'try' : 'tries'} left.`), consentCsp(transaction));
    }

    if (action === 'deny') {
      endPairing('denied');
      return redirectError(res, transaction.redirectUri, transaction.state, base, 'access_denied', 'The operator denied the request');
    }

    endPairing();
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value);
    const raw = newSecret();
    const record = {
      hash: shaHex(raw),
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      challenge: transaction.challenge,
      requested: transaction.requested.slice(),
      expiresAt: now() + CONSTANTS.AUTH_CODE_TTL_MS,
      retainUntil: now() + CODE_RETAIN_MS,
      used: false,
      familyId: null,
    };
    codes.set(record.hash, record);
    if (!commit()) {
      codes.delete(record.hash);
      return redirectError(res, transaction.redirectUri, transaction.state, base, 'temporarily_unavailable', 'State could not be saved');
    }
    return sendRedirect(res, transaction.redirectUri, [['code', raw], ['state', transaction.state], ['iss', base]]);
  }

  async function requestParams(req, res) {
    const body = await readBodyImpl(req, {
      capBytes: CONSTANTS.OAUTH_BODY_CAP_BYTES,
      timeoutMs: CONSTANTS.ANONYMOUS_OAUTH_BODY_DEADLINE_MS,
      response: res,
    });
    const type = mimeOf(req);
    if (type === 'application/x-www-form-urlencoded') {
      const parsed = parseForm(body.toString('utf8'));
      if (parsed.dups.size > 0) throw new OAuthError('invalid_request', 'A parameter was repeated');
      return parsed.values;
    }
    if (type === 'application/json') {
      return jsonToParams(body.toString('utf8'), [
        'grant_type', 'code', 'redirect_uri', 'code_verifier', 'resource', 'refresh_token', 'scope',
        'client_id', 'token', 'token_type_hint', 'client_assertion', 'client_assertion_type',
      ]);
    }
    throw new OAuthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded or application/json');
  }

  function required(params, name) {
    const value = params[name];
    if (typeof value !== 'string' || value === '') throw new OAuthError('invalid_request', `${name} is required`);
    return value;
  }

  async function authenticateClient(params, serverContext) {
    const assertion = params.client_assertion;
    const inspected = inspectAssertionClientId(assertion);
    const clientId = params.client_id || inspected;
    const client = await clientFor(clientId);
    if (!client) {
      counters.clientAuthFailures += 1;
      throw new OAuthError('invalid_client', 'Client is not recognised', 401);
    }
    const outcome = await verifier.verify({
      assertion,
      assertionType: params.client_assertion_type,
      assertedClientId: params.client_id,
    });
    // Name the grant: this runs for refresh_token as well as
    // authorization_code, and only a refresh observation can justify requiring
    // an assertion. A code-exchange observation alone would pin a policy that
    // kills the link at the first refresh.
    const authenticatedGrant = params.grant_type === 'authorization_code' || params.grant_type === 'refresh_token'
      ? params.grant_type : 'other';
    safeCall(recordClientAuth, {
      outcome: outcome.outcome,
      grant: authenticatedGrant,
      assertionSize: outcome.assertionSize,
      jtiPresent: outcome.jtiPresent,
      audience: outcome.audience,
    });
    const noneAllowed = outcome.outcome === 'none' && tokenAuthMode === 'observe-both' && client.authMethods.includes('none');
    const assertionAllowed = outcome.ok && client.authMethods.includes('private_key_jwt');
    if (!noneAllowed && !assertionAllowed) {
      counters.clientAuthFailures += 1;
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    safeCall(serverContext?.observeAuthenticatedServerRoute);
    return client;
  }

  function markRevoked(family) {
    if (!family || family.revoked) return false;
    family.revoked = true;
    family.revokedAt = now();
    for (const record of accessTokens.values()) if (record.familyId === family.id) record.revoked = true;
    return true;
  }

  function issueAccess(raw, family, scope = CONSTANTS.SCOPE) {
    accessTokens.set(shaHex(raw), {
      hash: shaHex(raw), familyId: family.id, scope, expiresAt: now() + CONSTANTS.ACCESS_TTL_MS, revoked: false,
    });
  }

  function issueRefresh(raw, family) {
    refreshTokens.set(shaHex(raw), {
      hash: shaHex(raw), familyId: family.id, supersededAt: null, successor: null, grace: null,
    });
  }

  const tokenBody = (access, refresh, scope) => ({
    access_token: access,
    token_type: 'Bearer',
    expires_in: CONSTANTS.ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope,
  });

  function refreshScope(family, value) {
    const requested = parseScope(value, CONSTANTS.SCOPE);
    if (requested === null) throw new OAuthError('invalid_scope', 'scope is malformed or exceeds the original grant');
    if (requested.some(scope => scope !== CONSTANTS.SCOPE && !OIDC_SCOPES.has(scope) && !family.requested.includes(scope))) {
      throw new OAuthError('invalid_scope', 'scope exceeds the original grant');
    }
    return CONSTANTS.SCOPE;
  }

  function codeGrant(client, params, sourcePrefix) {
    const raw = required(params, 'code');
    const redirectUri = required(params, 'redirect_uri');
    const codeVerifier = required(params, 'code_verifier');
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) throw new OAuthError('invalid_request', 'code_verifier is malformed');
    const record = fixedDigestLookup(codes, shaHex(raw));
    if (!record) throw new OAuthError('invalid_grant', 'The authorization code is unknown or expired');
    if (record.used) {
      const family = record.familyId ? families.get(record.familyId) : null;
      if (markRevoked(family)) {
        persistOrThrow();
        counters.codeReuseRevocations += 1;
        emit('code_reuse', { linkId: family.linkId, clientKind: family.clientKind });
        safeCall(onDisconnected, { linkId: family.linkId, reason: 'code_reuse' });
      }
      throw knownGrantError('invalid_grant', 'The authorization code was already used', family);
    }
    if (record.clientId !== client.id) throw new OAuthError('invalid_grant', 'The authorization code was issued to another client');
    if (record.expiresAt <= now()) throw new OAuthError('invalid_grant', 'The authorization code expired');
    if (!sameSecret(redirectUri, record.redirectUri)) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (!sameResource(params.resource)) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    record.used = true;
    if (!sameSecret(b64u(sha(codeVerifier)), record.challenge)) {
      persistOrThrow();
      throw new OAuthError('invalid_grant', 'The code_verifier does not match the code_challenge');
    }

    const replaced = [];
    for (const family of families.values()) {
      if (!family.revoked && markRevoked(family)) replaced.push(family);
      // A successful authorization-code exchange is the only recovery from a
      // renewal marker. It consumes that marker immediately, preventing an
      // old closed authorize request from continuing to produce reconnect
      // hints after the fresh linked family exists.
      if (family.revoked && safeRenewalCause(family.renewalCause)) {
        family.renewalCause = null;
        family.renewalAt = null;
      }
    }
    const current = now();
    const id = newId();
    const family = {
      id,
      linkId: shaHex(`link\n${id}`).slice(0, 12),
      clientId: client.id,
      clientKind: client.clientKind,
      resource,
      scope: CONSTANTS.SCOPE,
      requested: record.requested.slice(),
      createdAt: current,
      lastRefreshedAt: current,
      idleExpiresAt: current + CONSTANTS.REFRESH_IDLE_MS,
      absoluteExpiresAt: current + CONSTANTS.REFRESH_ABSOLUTE_MS,
      sourcePrefix: safeSourcePrefix(sourcePrefix),
      renewalCause: null,
      renewalAt: null,
      revoked: false,
      revokedAt: 0,
    };
    families.set(family.id, family);
    record.familyId = family.id;
    const access = newSecret();
    const refresh = newSecret();
    issueAccess(access, family);
    issueRefresh(refresh, family);
    persistOrThrow();
    for (const old of replaced) {
      emit('link_replaced', { linkId: old.linkId, clientKind: old.clientKind });
      safeCall(onDisconnected, { linkId: old.linkId, reason: 'link_replaced' });
    }
    emit('link_created', { linkId: family.linkId, clientKind: family.clientKind });
    safeCall(onLinked, { linkId: family.linkId, clientKind: family.clientKind });
    return tokenBody(access, refresh, family.scope);
  }

  function refreshGrant(client, params) {
    const raw = required(params, 'refresh_token');
    if (!sameResource(params.resource)) throw new OAuthError('invalid_target', 'resource does not match the grant');
    const record = fixedDigestLookup(refreshTokens, shaHex(raw));
    const family = record ? families.get(record.familyId) : null;
    if (!record || !family || family.revoked) throw knownGrantError('invalid_grant', 'The refresh token is unknown, expired or revoked', family);
    if (family.clientId !== client.id) {
      markNeedsRenewal(family, 'invalid_grant');
      throw knownGrantError('invalid_grant', 'The refresh token was issued to another client', family);
    }
    const current = now();
    if (current >= family.absoluteExpiresAt || current >= family.idleExpiresAt) {
      counters.refreshExpired += 1;
      markNeedsRenewal(family, 'refresh_expired');
      emit('refresh_expired', { linkId: family.linkId, clientKind: family.clientKind });
      throw knownGrantError('invalid_grant', 'The refresh token expired', family);
    }
    const scope = refreshScope(family, params.scope);
    if (record.supersededAt !== null) {
      if (current - record.supersededAt > CONSTANTS.REFRESH_GRACE_MS) {
        markRevoked(family);
        persistOrThrow();
        counters.reuseRevocations += 1;
        emit('refresh_reuse', { linkId: family.linkId, clientKind: family.clientKind });
        safeCall(onDisconnected, { linkId: family.linkId, reason: 'refresh_reuse' });
        throw knownGrantError('invalid_grant', 'The refresh token was already used', family);
      }
      const pair = openPair(raw, record.grace);
      const successorDigest = pair ? shaHex(pair.refresh) : '';
      const successor = pair ? fixedDigestLookup(refreshTokens, successorDigest) : null;
      if (!pair || !hexEqual(record.successor, successorDigest) || !successor) {
        markNeedsRenewal(family, 'invalid_grant');
        throw knownGrantError('invalid_grant', 'The refresh token is invalid', family);
      }
      const existing = fixedDigestLookup(accessTokens, shaHex(pair.access));
      if (!existing) {
        if (!capacityFor(family, { access: 1 })) {
          markNeedsRenewal(family, 'invalid_grant');
          throw knownGrantError('invalid_grant', 'The refresh token is invalid', family);
        }
        issueAccess(pair.access, family, scope);
      }
      else if (!existing.revoked) existing.expiresAt = current + CONSTANTS.ACCESS_TTL_MS;
      persistOrThrow();
      return tokenBody(pair.access, pair.refresh, existing?.scope || scope);
    }

    if (!capacityFor(family, { access: 1, refresh: 1 })) {
      markNeedsRenewal(family, 'invalid_grant');
      throw knownGrantError('invalid_grant', 'The refresh token is invalid', family);
    }
    const refresh = newSecret();
    const access = newSecret();
    record.supersededAt = current;
    record.successor = shaHex(refresh);
    record.grace = sealPair(raw, refresh, access, randomBytes);
    family.lastRefreshedAt = current;
    family.idleExpiresAt = current + CONSTANTS.REFRESH_IDLE_MS;
    issueRefresh(refresh, family);
    issueAccess(access, family, scope);
    persistOrThrow();
    return tokenBody(access, refresh, scope);
  }

  async function tokenRoute(req, res, serverContext) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const params = await requestParams(req, res);
    const grant = required(params, 'grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
    }
    const client = await authenticateClient(params, serverContext);
    const body = grant === 'authorization_code' ? codeGrant(client, params, serverContext?.sourcePrefix) : refreshGrant(client, params);
    return sendJson(res, 200, body);
  }

  async function revokeRoute(req, res, serverContext) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const params = await requestParams(req, res);
    const client = await authenticateClient(params, serverContext);
    const raw = required(params, 'token');
    const digest = shaHex(raw);
    const refresh = fixedDigestLookup(refreshTokens, digest);
    const access = fixedDigestLookup(accessTokens, digest);
    let family = refresh ? families.get(refresh.familyId) : (access ? families.get(access.familyId) : null);
    let changed = false;
    let disconnected = false;
    if (family && family.clientId === client.id) {
      if (refresh) { changed = markRevoked(family); disconnected = changed; }
      else if (access && !access.revoked) { access.revoked = true; changed = true; }
    } else family = null;
    if (changed) {
      persistOrThrow();
      counters.revocations += 1;
      emit('token_revoked_by_client', { linkId: family.linkId, clientKind: family.clientKind });
      if (disconnected) safeCall(onDisconnected, { linkId: family.linkId, reason: 'token_revoked_by_client' });
    }
    return sendJson(res, 200, {});
  }

  function discoveryDocument(pathname) {
    if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp') {
      return {
        resource,
        authorization_servers: [base],
        scopes_supported: [CONSTANTS.SCOPE],
        bearer_methods_supported: ['header'],
      };
    }
    if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/oauth-authorization-server/mcp'
      || pathname === '/.well-known/openid-configuration' || pathname === '/.well-known/openid-configuration/mcp') {
      const document = {
        issuer: base,
        authorization_endpoint: `${base}${AUTHORIZATION_PATH}`,
        token_endpoint: tokenEndpoint,
        revocation_endpoint: `${base}${REVOKE_PATH}`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [...asAuthMethods],
        revocation_endpoint_auth_methods_supported: [...asAuthMethods],
        scopes_supported: [CONSTANTS.SCOPE, 'offline_access'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      };
      if (asAuthMethods.includes('private_key_jwt')) document.token_endpoint_auth_signing_alg_values_supported = [CONSTANTS.JWT_ALGORITHM];
      return document;
    }
    return null;
  }

  function wellKnownRoute(req, res, pathname) {
    const document = discoveryDocument(pathname);
    if (!document) return notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    if (req.method === 'GET') return sendJson(res, 200, document);
    const data = JSON.stringify(document);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end();
  }

  function authenticate(req) {
    const header = req.headers?.authorization;
    const fail = (presented, family = null) => {
      const error = new OAuthError('invalid_token', 'The access token is missing, malformed, unknown, expired or revoked', 401);
      error.presented = presented;
      if (family) { error.knownFamily = true; error.linkId = family.linkId; }
      throw error;
    };
    if (typeof header !== 'string' || !/^bearer(?:\s|$)/i.test(header)) return fail(false);
    const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
    if (!match || match[1].length > 512) return fail(true);
    const presented = sha(match[1]);
    let record = null;
    for (const [hash, candidate] of accessTokens) {
      if (crypto.timingSafeEqual(presented, Buffer.from(hash, 'hex'))) record = candidate;
    }
    const family = record ? families.get(record.familyId) : null;
    if (!record || !family || family.revoked || record.revoked || record.expiresAt <= now() || family.resource !== resource) return fail(true, family);
    return { linkId: family.linkId, clientKind: family.clientKind, expiresAt: record.expiresAt };
  }

  async function handle(req, res, pathname, serverContext = {}) {
    if (typeof pathname !== 'string') return false;
    const known = discoveryDocument(pathname) !== null || pathname === AUTHORIZATION_PATH || pathname === TOKEN_PATH || pathname === REVOKE_PATH;
    if (!known && !pathname.startsWith('/.well-known/') && !pathname.startsWith('/oauth/')) return false;
    try {
      sweepAndCommit();
      if (pathname.startsWith('/.well-known/')) { wellKnownRoute(req, res, pathname); return true; }
      if (pathname === AUTHORIZATION_PATH) {
        if (req.method === 'GET') await authorizeGet(req, res, serverContext);
        else if (req.method === 'POST') await authorizePost(req, res, serverContext);
        else methodNotAllowed(res, 'GET, POST');
        return true;
      }
      if (pathname === TOKEN_PATH) { await tokenRoute(req, res, serverContext); return true; }
      if (pathname === REVOKE_PATH) { await revokeRoute(req, res, serverContext); return true; }
      notFound(res);
      return true;
    } catch (error) {
      if (error instanceof WireError && (error.status === 408 || error.status === 413)) throw error;
      if (res.writableEnded) return true;
      if ((pathname === TOKEN_PATH || pathname === REVOKE_PATH) && error instanceof OAuthError) {
        let limited = false;
        try { limited = serverContext.rateFailure?.(pathname === REVOKE_PATH ? 'revoke_fail' : 'token_fail') === true; } catch { limited = false; }
        if (limited) return true;
      }
      if (error instanceof WireError) sendOAuthError(res, new OAuthError(error.code, error.description, error.status, error.headers));
      else if (error instanceof OAuthError) sendOAuthError(res, error);
      else if (error instanceof PageError) sendHtml(res, error.status, errorHtml(error.message), ERROR_CSP, error.headers || {});
      else sendJson(res, 500, { error: 'server_error', error_description: 'Unexpected error' });
      return true;
    }
  }

  function revokeLink(linkId) {
    const family = [...families.values()].find(candidate => candidate.linkId === linkId && !candidate.revoked);
    if (!family) return false;
    markRevoked(family);
    if (!commit()) return false;
    emit('link_revoked', { linkId: family.linkId, clientKind: family.clientKind });
    safeCall(onDisconnected, { linkId: family.linkId, reason: 'link_revoked' });
    return true;
  }

  return Object.freeze({
    handle,
    authenticate,
    openPairing,
    closePairing,
    revokeLink,
    pendingPairings: () => activePairing() ? 1 : 0,
    flush: () => { try { return store.flush?.() !== false; } catch { return false; } },
    close: () => { closePairing(); try { return store.flush?.() !== false; } catch { return false; } },
    stats: () => {
      sweepAndCommit();
      return {
        ...counters,
        pendingTransactions: transactions.size,
        pairings: activePairing() ? 1 : 0,
        clients: clients.size,
        codes: codes.size,
        families: families.size,
        activeFamilies: [...families.values()].filter(family => !family.revoked).length,
        accessTokens: accessTokens.size,
        refreshTokens: refreshTokens.size,
      };
    },
    linkStatus: () => {
      sweepAndCommit();
      return [...families.values()]
      // A renewal marker remains visible to the UI but is deliberately marked
      // revoked for the HTTP source-policy reader. That permits the new
      // authorization-code exchange from a changed network while never
      // treating an expired credential's old prefix as an allow rule.
      .filter(family => !family.revoked || safeRenewalCause(family.renewalCause))
      .map(family => {
        const renewalCause = safeRenewalCause(family.renewalCause);
        return {
          linkId: family.linkId,
          clientKind: family.clientKind,
          createdAt: family.createdAt,
          idleExpiresAt: family.idleExpiresAt,
          absoluteExpiresAt: family.absoluteExpiresAt,
          state: renewalCause ? 'needs-renewal' : 'linked',
          renewalCause,
          revoked: family.revoked === true || Boolean(renewalCause),
          sources: renewalCause ? [] : (family.sourcePrefix ? [family.sourcePrefix] : []),
          unarmedRequests: unarmedStatus(),
        };
      });
    },
    unarmedStatus,
    challengeHeader: error => {
      let value = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${CONSTANTS.SCOPE}"`;
      if (error?.presented) value += ', error="invalid_token"';
      return value;
    },
    issuer: base,
    resource,
  });
}

export { b64u, sha, shaHex, fingerprint, isObject, REDIRECT_URI };
