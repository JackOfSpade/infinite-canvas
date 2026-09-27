import crypto from 'node:crypto';
import { CONSTANTS } from './constants.js';

export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const ASSERTION_OUTCOMES = Object.freeze([
  'none', 'assertion_ok', 'assertion_bad_signature', 'assertion_bad_claims',
  'assertion_replay', 'assertion_unknown_kid', 'other',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalPart = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length > 0 && bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
};
const jsonPart = value => {
  const bytes = canonicalPart(value);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
};

function result(outcome, { assertionSize = 0, jtiPresent = false, audience = 'other' } = {}) {
  return Object.freeze({ ok: outcome === 'assertion_ok', outcome, assertionSize, jtiPresent, audience });
}

function audienceKind(aud, issuer, tokenEndpoint) {
  const values = typeof aud === 'string' ? [aud] : (Array.isArray(aud) && aud.every(item => typeof item === 'string') ? aud : []);
  const hasIssuer = values.includes(issuer);
  const hasToken = values.includes(tokenEndpoint);
  if (hasIssuer && hasToken) return 'both';
  if (hasToken) return 'token_endpoint';
  if (hasIssuer) return 'issuer';
  return 'other';
}

function rsaKeyFromJwk(jwk, minimumBits) {
  if (!isObject(jwk) || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) return null;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength) < minimumBits) return null;
    return key;
  } catch { return null; }
}

export function inspectAssertionClientId(assertion) {
  if (typeof assertion !== 'string' || assertion.length > CONSTANTS.ASSERTION_CAP_CHARS) return null;
  const parts = assertion.split('.');
  if (parts.length !== 3) return null;
  const claims = jsonPart(parts[1]);
  return claims && typeof claims.iss === 'string' && claims.iss === claims.sub ? claims.iss : null;
}

/**
 * Verifies private_key_jwt without owning network I/O. `fetchJwks` is the
 * single pinned, DNS-guarded port supplied by cimd.js.
 */
export function createClientAssertionVerifier({
  fetchJwks,
  now = Date.now,
  issuer,
  tokenEndpoint,
  clientId,
  constants = CONSTANTS,
} = {}) {
  if (typeof fetchJwks !== 'function') throw new TypeError('fetchJwks must be a function');
  if (typeof issuer !== 'string' || typeof tokenEndpoint !== 'string' || typeof clientId !== 'string') throw new TypeError('issuer, tokenEndpoint and clientId are required');

  let cachedKeys = null;
  let keysExpireAt = 0;
  let lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY;
  const jtis = new Map();

  const pruneJtis = current => {
    for (const [jti, expiresAt] of jtis) if (expiresAt <= current) jtis.delete(jti);
    while (jtis.size > constants.JWT_JTI_CACHE_ENTRIES) jtis.delete(jtis.keys().next().value);
  };
  const loadKeys = async current => {
    try {
      const response = await fetchJwks();
      const keys = Array.isArray(response) ? response : response?.keys;
      if (!Array.isArray(keys)) throw new TypeError('JWKS response must contain keys');
      cachedKeys = Object.freeze(keys.filter(isObject).slice());
      keysExpireAt = current + constants.JWKS_CACHE_MS;
    } catch {
      cachedKeys = Object.freeze([]);
      keysExpireAt = current + constants.JWKS_UNKNOWN_KID_REFETCH_MS;
    }
    return cachedKeys;
  };

  async function verify({ assertion, assertionType, assertedClientId } = {}) {
    if (assertion === undefined || assertion === null || assertion === '') {
      if (assertionType !== undefined && assertionType !== '') return result('assertion_bad_claims');
      return result('none');
    }
    const assertionSize = typeof assertion === 'string' ? assertion.length : 0;
    if (assertionType !== JWT_BEARER || typeof assertion !== 'string' || assertionSize > constants.ASSERTION_CAP_CHARS) {
      return result('assertion_bad_claims', { assertionSize });
    }
    const parts = assertion.split('.');
    if (parts.length !== 3) return result('assertion_bad_claims', { assertionSize });
    const header = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    const jtiPresent = typeof claims?.jti === 'string';
    const audience = claims ? audienceKind(claims.aud, issuer, tokenEndpoint) : 'other';
    if (!header || !claims || header.alg !== constants.JWT_ALGORITHM || typeof header.kid !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(header.kid)) {
      return result('assertion_bad_claims', { assertionSize, jtiPresent, audience });
    }
    const current = Number(now());
    if (!Number.isFinite(current)) return result('other', { assertionSize, jtiPresent, audience });

    let keys = cachedKeys;
    let loadedNow = false;
    if (!keys || keysExpireAt <= current) {
      keys = await loadKeys(current);
      loadedNow = true;
    }
    let jwk = keys.find(key => key.kid === header.kid) || null;
    if (!jwk && !loadedNow && current - lastUnknownKidFetchAt >= constants.JWKS_UNKNOWN_KID_REFETCH_MS) {
      lastUnknownKidFetchAt = current;
      keys = await loadKeys(current);
      jwk = keys.find(key => key.kid === header.kid) || null;
    }
    if (!jwk) {
      if (loadedNow) lastUnknownKidFetchAt = current;
      return result('assertion_unknown_kid', { assertionSize, jtiPresent, audience });
    }
    const key = rsaKeyFromJwk(jwk, constants.JWT_RSA_MIN_BITS);
    const signature = canonicalPart(parts[2]);
    if (!key || !signature || !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, signature)) {
      return result('assertion_bad_signature', { assertionSize, jtiPresent, audience });
    }

    const iat = claims.iat;
    const exp = claims.exp;
    const nowSeconds = current / 1000;
    const skew = constants.JWT_CLOCK_SKEW_MS / 1000;
    const maximumLife = constants.JWT_MAX_LIFETIME_MS / 1000;
    const claimsValid = (assertedClientId === undefined || assertedClientId === clientId)
      && claims.iss === clientId && claims.sub === clientId && audience !== 'other'
      && Number.isSafeInteger(iat) && Number.isSafeInteger(exp) && exp > iat && exp - iat <= maximumLife
      && exp >= nowSeconds - skew && iat <= nowSeconds + skew
      && (claims.jti === undefined || (typeof claims.jti === 'string' && /^[\x21-\x7e]{1,256}$/.test(claims.jti)));
    if (!claimsValid) return result('assertion_bad_claims', { assertionSize, jtiPresent, audience });

    pruneJtis(current);
    if (jtiPresent) {
      if (jtis.has(claims.jti)) return result('assertion_replay', { assertionSize, jtiPresent, audience });
      jtis.set(claims.jti, current + constants.JWT_JTI_CACHE_MS);
      pruneJtis(current);
    }
    return result('assertion_ok', { assertionSize, jtiPresent, audience });
  }

  return Object.freeze({
    verify,
    clear: () => { cachedKeys = null; keysExpireAt = 0; lastUnknownKidFetchAt = Number.NEGATIVE_INFINITY; jtis.clear(); },
    stats: () => ({ cachedKeys: cachedKeys?.length || 0, jtis: jtis.size, keysExpireAt }),
  });
}
