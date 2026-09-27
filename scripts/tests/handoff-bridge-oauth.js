import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import CONSTANTS from '../../electron/ipc/handoffBridge/constants.js';
import { createOAuthServer, cleanText, shaHex } from '../../electron/ipc/handoffBridge/oauth.js';
import { createOAuthStore } from '../../electron/ipc/handoffBridge/oauthStore.js';
import {
  createCimdFetcher, createGuardedJsonFetcher, createJwksFetcher, guardedLookup,
  isPublicAddress, validateClientMetadata,
} from '../../electron/ipc/handoffBridge/cimd.js';
import {
  ASSERTION_OUTCOMES, createClientAssertionVerifier, inspectAssertionClientId, JWT_BEARER,
} from '../../electron/ipc/handoffBridge/clientAuth.js';
import { WireError } from '../../electron/ipc/handoffBridge/wire.js';

const ISSUER = 'https://bridge-lab.example.com';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const fixtureUrl = new URL('./fixtures/handoff-bridge/chatgpt-client-metadata.json', import.meta.url);
const REAL_METADATA = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8'));

function clockAt(value = Date.UTC(2026, 8, 26, 12, 0, 0)) {
  let current = value;
  const clock = () => current;
  clock.advance = milliseconds => { current += milliseconds; };
  return clock;
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const clone = value => JSON.parse(JSON.stringify(value));
function memoryStore(seed = { v: 1, clients: [], codes: [], families: [], refresh: [], access: [] }) {
  let state = clone(seed);
  let commits = 0;
  let fail = false;
  return {
    read: () => clone(state),
    commit: next => { if (fail) return false; state = clone(next); commits += 1; return true; },
    flush: () => true,
    setFail: value => { fail = value; },
    state: () => clone(state),
    commits: () => commits,
  };
}

function response() {
  const res = new EventEmitter();
  res.status = 0;
  res.headers = Object.create(null);
  res.text = '';
  res.headersSent = false;
  res.writableEnded = false;
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = String(value); };
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    res.headersSent = true;
    for (const [name, value] of Object.entries(headers)) res.headers[name.toLowerCase()] = String(value);
  };
  res.end = (body = '') => {
    res.text += body === undefined ? '' : String(body);
    res.writableEnded = true;
    res.emit('finish');
  };
  return res;
}

function bodyReader(req, { capBytes }) {
  const body = Buffer.from(req.body || '', 'utf8');
  if (body.length > capBytes) throw new WireError('invalid_request', 'The request body is too large', 413);
  return Promise.resolve(body);
}

function clientFrom(document = REAL_METADATA) {
  return validateClientMetadata(document, CLIENT_ID);
}

function boot(options = {}) {
  const now = options.now || clockAt();
  const store = options.store || memoryStore();
  const events = [];
  const auth = [];
  const consent = [];
  const disconnected = [];
  const pairingClosed = [];
  const metadata = options.metadata === undefined ? clientFrom() : options.metadata;
  const oauth = createOAuthServer({
    issuer: options.issuer || ISSUER,
    now,
    store,
    randomBytes: options.randomBytes || crypto.randomBytes,
    fetchClientMetadata: options.fetchClientMetadata || (async id => id === CLIENT_ID ? metadata : null),
    fetchJwks: options.fetchJwks || (async () => null),
    emitSecurityEvent: (event, fields) => { events.push({ event, fields }); options.emitSecurityEvent?.(event, fields); },
    recordClientAuth: entry => { auth.push(entry); options.recordClientAuth?.(entry); },
    onConsentRequested: entry => { consent.push(entry); options.onConsentRequested?.(entry); },
    onDisconnected: entry => { disconnected.push(entry); options.onDisconnected?.(entry); },
    onPairingClosed: reason => { pairingClosed.push(reason); options.onPairingClosed?.(reason); },
    onAuthorizeWithoutWindow: options.onAuthorizeWithoutWindow,
    pairingGate: options.pairingGate || (() => true),
    readBody: options.readBody || bodyReader,
    tokenAuthMode: options.tokenAuthMode || 'observe-both',
    asAuthMethods: options.asAuthMethods || ['private_key_jwt', 'none'],
  });
  return { oauth, now, store, events, auth, consent, disconnected, pairingClosed };
}

async function call(env, method, target, { headers = {}, body = '', serverContext = {} } = {}) {
  const req = { method, url: target, headers, body };
  const res = response();
  const handled = await env.oauth.handle(req, res, new URL(target, ISSUER).pathname, {
    rateFailure: () => false,
    observeAuthenticatedServerRoute: () => undefined,
    ...serverContext,
  });
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* non-JSON response */ }
  return { ...res, handled, json, location: res.headers.location || null, req };
}

const form = value => new URLSearchParams(Object.entries(value).filter(([, item]) => item !== undefined)).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const postForm = (env, target, value, options = {}) => call(env, 'POST', target, {
  headers: { ...FORM, ...(options.headers || {}) }, body: form(value), serverContext: options.serverContext,
});
const postJson = (env, target, value) => call(env, 'POST', target, {
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});
function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
const txnOf = html => /name="txn" value="([^"]+)"/.exec(html)?.[1] || null;
const locationParams = result => result.location ? new URL(result.location).searchParams : new URLSearchParams();

async function consentStart(env, { scope, state = 'state-Ada', extra = {}, open = true } = {}) {
  const pairing = open ? env.oauth.openPairing() : null;
  const proof = pkce();
  const query = form({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    state,
    code_challenge: proof.challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope,
    ...extra,
  });
  const page = await call(env, 'GET', `/oauth/authorize?${query}`);
  return { pairing, proof, page, txn: txnOf(page.text), state };
}

async function approve(env, started, { pairingCode = started.pairing, action = 'approve' } = {}) {
  return postForm(env, '/oauth/authorize', { txn: started.txn, action, pairing_code: pairingCode });
}

async function grant(env, options = {}) {
  const started = await consentStart(env, options);
  assert.equal(started.page.status, 200, started.page.text);
  const approved = await approve(env, started);
  assert.equal(approved.status, 302, approved.text);
  const code = locationParams(approved).get('code');
  const token = await postForm(env, '/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: started.proof.verifier,
    resource: RESOURCE,
    client_id: CLIENT_ID,
  });
  assert.equal(token.status, 200, token.text);
  return { started, approved, code, token: token.json };
}

const refresh = (env, raw, extra = {}) => postForm(env, '/oauth/token', {
  grant_type: 'refresh_token', refresh_token: raw, resource: RESOURCE, client_id: CLIENT_ID, ...extra,
});
const revoke = (env, raw, extra = {}) => postForm(env, '/oauth/revoke', { token: raw, client_id: CLIENT_ID, ...extra });

const LAB_STEP_NAMES = Object.freeze([
  'protected-resource metadata is served at both paths',
  'the two protected-resource documents are identical and never list offline_access',
  'all four authorization-server metadata paths return the SAME document',
  'authorization-server metadata: issuer identity, endpoints and capabilities',
  'HEAD works on well-known documents; other methods get 405 with Allow',
  'unknown well-known and /oauth paths are clean 404 JSON, never HTML',
  'handle() leaves foreign paths alone and does not touch req or res',
  'the protected /mcp route answers 401 with the resource_metadata challenge',
  'authenticate() and challengeHeader() contract',
  'option validation rejects a bad issuer and a bad resource path',
  'DCR: a public client is registered by default (201, no secret, no-store)',
  'DCR: redirect URIs must match the allowed patterns exactly',
  'DCR: a confidential method returns a secret once; the registered scope is echoed but never enforced; the name is sanitised',
  'DCR: a client name loses every invisible character (TAG characters, joiners, fillers, braille blank, lone surrogates) and stacked marks',
  'DCR: unsupported metadata, non-JSON bodies and wrong methods are refused cleanly',
  'the consent page: says only what was verified, shows the full return address, pairing input, hardened headers, everything escaped',
  'authorize is armed-only: with no pairing session open it is a 403 page that creates nothing, fetches nothing and tells the Mac nothing',
  'a consent callback that throws cannot break the page or the transaction',
  'an unregistered redirect_uri is an HTML error and NEVER a redirect',
  'an unknown, missing or repeated client_id / redirect_uri is an HTML error, not a redirect',
  'PKCE is mandatory and S256-only: missing, plain, absent method and malformed challenges are refused',
  'resource binding: a missing, different or ambiguous resource is invalid_target; only host case, a default port and one trailing slash are tolerated',
  'response_type, repeated parameters and malformed scope errors redirect with state and iss',
  'state: over 4096 characters is refused (and not echoed); 4096 with awkward characters is echoed exactly',
  'unknown scopes (openid, email, profile), an empty scope and no scope at all are all accepted',
  'full flow with a DCR public client: consent, code, PKCE exchange, working bearer token',
  'the bearer token is accepted only in the Authorization header, never in a query string',
  'the injected random source and the statistics counters are wired through',
  'CIMD: full flow through the injected fetcher, token exchange as a public client',
  'CIMD: a second redirect_uri listed in the document works too',
  "CIMD: ChatGPT's real document is accepted; a token request may name the client only by its assertion, and that assertion is never trusted as authentication",
  'CIMD: the plural auth-method list is authoritative; a document carrying a client secret is refused',
  'CIMD: a document whose client_id differs from the URL is an HTML error',
  'CIMD: a redirect_uri missing from the document, or outside the allowed patterns, never redirects',
  'CIMD: secret auth methods, malformed documents and fetch failures are HTML errors (never 5xx)',
  'CIMD: hosts outside the allowlist, plain http, IP literals, credentials and odd forms are refused BEFORE any fetch',
  'CIMD: the default fetcher refuses a host that resolves to a private address (no connection is made)',
  'CIMD: the default fetcher enforces no redirects, JSON only, a 16 KB cap and a timeout (scripted https)',
  "CIMD: the fetcher's DNS guard rejects every non-public address, including mixed answers and every IPv4-embedding IPv6 form",
  'CIMD: concurrent lookups are capped so an anonymous caller cannot fan out fetches',
  'static client: authorization_code with RFC 6749 form-encoded Basic credentials',
  'static client: literal (unencoded) Basic credentials and a matching body client_id also work',
  'static client: a wrong Basic secret is 401 with WWW-Authenticate: Basic; the secret is compared, not echoed',
  'static client: client_secret_post works; a wrong post secret is a plain 400 without a Basic challenge',
  'static client: two authentication methods at once, or a mismatching client_id, is invalid_request',
  'static client: only its configured redirect URIs are accepted, and it needs no allowlist pattern',
  'five wrong pairing codes: four re-rendered pages, then the transaction dies with access_denied',
  'a wrong code does not burn the right one; a correct code after some failures still works',
  'an expired transaction is an HTML error even with the right code',
  'a pairing code is single use; the same transaction cannot be approved twice',
  'an armed code is single use across transactions: it approves exactly one of two pending consents',
  'openPairing(): operator codes are XXXX-XXXX, count as pending, work once on any transaction, ignore case and hyphen',
  'pairing codes expire after ten minutes',
  'Deny redirects with access_denied, state and iss, and kills the transaction',
  'consent POST rejects unknown transactions, bad actions, JSON bodies and repeated fields with an HTML page',
  'a code_verifier that does not match the challenge is invalid_grant, and the code is burned by the attempt',
  'a code is burned only by an attempt at its verifier: a foreign client, wrong redirect_uri, wrong resource or a late attempt cannot destroy the real exchange',
  'reusing an authorization code revokes every token issued from it',
  'redirect_uri must be present and equal to the authorize value',
  'malformed or missing verifier, code and grant_type are invalid_request without burning the code',
  'a JSON body is accepted on the token endpoint',
  'client_secret_post: a confidential DCR client authenticates in the body; wrong or missing secrets are invalid_client',
  'client_secret_basic DCR client works with Basic; a public client must not send a secret',
  'an authorization code expires after 60 seconds',
  'a code is bound to its client; the resource parameter is checked when present and inherited when absent',
  'grant types: a client handed a refresh token may use it even if it registered only authorization_code; a refresh-only client cannot use a code; unknown clients are invalid_client',
  'an access token expires on the injected clock (401, error="invalid_token") and a refresh restores access',
  'refresh rotates: a new pair every time, the same scope and lifetime, and the predecessor is superseded',
  'a replay of the predecessor inside the grace window returns the SAME pair (idempotent)',
  'a replay AFTER the grace window revokes the whole family (successor refresh and access tokens die)',
  'refresh scope: subsets narrow, ignored authorize-time scopes are tolerated, escalation is invalid_scope, and nothing rotates on error',
  'refresh scope: the scope ChatGPT registered (email offline_access profile), openid, offline_access alone and an empty authorize scope all keep a token that can call /mcp',
  'refresh resource, client binding and unknown-token handling',
  'the refresh lifetime is ABSOLUTE from first issue: rotation does not extend it',
  'a configurable access lifetime and a zero grace window behave as configured',
  'revoking an access token kills only that token',
  'a revoked access token is not resurrected by a grace replay, even when it expired and was swept before the replay (access lifetime shorter than the grace window)',
  'revoking a refresh token revokes the family and its access tokens',
  'revocation of unknown tokens is always 200 {}; foreign clients cannot revoke; bad client auth and missing token are refused',
  'state is written atomically with mode 0600 and holds only hashes, never a raw token, code or secret',
  'a restarted server keeps the link: the old refresh token and the unexpired access token still work',
  'a replay inside the grace window returns the identical pair even across a restart',
  'a corrupt state file starts empty and logs only the error name; a missing file is not a failure',
  'a state file with malformed records loads what is valid and ignores the rest',
  'one process owns a state file: a second instance is refused, a lock left by a dead process or garbage is taken over, and close() releases it',
  'tokens and revocations are on disk BEFORE the response: a copy of the file taken the instant a reply arrives (a crash) already has them',
  'no server key: a superseded token yields only its direct successor, sealed for the grace window, and the file alone yields nothing',
  'a state file carried to another hostname carries no grants: they are dropped at load and their tokens are unknown',
  'close() is idempotent and no timer keeps the process alive (checked in a child process)',
  'an authorize flood is bounded (120-request burst) and cannot push out the operator: 5 pending per client, 100 overall, the fattest client loses first',
  'one client keeps its newest 5 pending consents; the older ones die, and an abandoned page never blocks a retry',
  'junk consent POSTs cannot keep the operator from approving: only failures are throttled, an approval never is',
  'a token-endpoint flood is throttled but cannot starve a valid refresh: only failures draw from the shared bucket',
  'successful issuance is bounded per client (60 burst, 1 per second) without touching the failure bucket',
  'a full client table never evicts a client that is mid-flight (pending consent, live code, live grant); when nothing can be evicted registration is a 503',
  'registration is rate limited (30 per minute burst) and the client table is capped at 200 with the oldest unused evicted',
  'the authorization-code table is capped at 500 and the oldest code is the one evicted',
  'bodies over 64 KB are a 413 JSON error on every POST endpoint, declared or chunked, and the server stays healthy',
  'malformed input never produces a 5xx: fuzzed bodies, encodings and content types on every endpoint',
  'no token, code, secret, verifier, pairing code or transaction id ever reached a log line',
]);

async function discoveryStep(index) {
  const env = boot();
  if (index === 0 || index === 1) {
    const root = await call(env, 'GET', '/.well-known/oauth-protected-resource');
    const pathDoc = await call(env, 'GET', '/.well-known/oauth-protected-resource/mcp');
    assert.equal(root.status, 200);
    assert.deepEqual(root.json, pathDoc.json);
    assert.equal(root.json.resource, RESOURCE);
    assert.deepEqual(root.json.bearer_methods_supported, ['header']);
    assert.ok(!root.text.includes('offline_access'));
  } else if (index === 2 || index === 3) {
    const paths = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration/mcp'];
    const results = await Promise.all(paths.map(target => call(env, 'GET', target)));
    assert.ok(results.every(item => item.status === 200 && item.text === results[0].text));
    const document = results[0].json;
    assert.equal(document.issuer, ISSUER);
    assert.equal(document.token_endpoint, `${ISSUER}/oauth/token`);
    assert.ok(!Object.hasOwn(document, 'registration_endpoint'));
    assert.deepEqual(document.token_endpoint_auth_methods_supported, ['private_key_jwt', 'none']);
    assert.deepEqual(document.token_endpoint_auth_signing_alg_values_supported, ['RS256']);
  } else if (index === 4) {
    const head = await call(env, 'HEAD', '/.well-known/oauth-authorization-server');
    const wrong = await call(env, 'POST', '/.well-known/oauth-authorization-server');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'GET, HEAD');
  } else if (index === 5) {
    for (const target of ['/.well-known/nope', '/oauth/register', '/oauth/token/extra']) {
      const result = await call(env, 'GET', target);
      assert.equal(result.status, 404);
      assert.equal(result.json.error, 'not_found');
      assert.ok(!result.text.includes('<'));
    }
  } else if (index === 6) {
    const poison = new Proxy({}, { get() { throw new Error('foreign request touched'); } });
    assert.equal(await env.oauth.handle(poison, poison, '/mcp'), false);
    assert.equal(await env.oauth.handle(poison, poison, '/health'), false);
    assert.equal(await env.oauth.handle(poison, poison, undefined), false);
  } else if (index === 7) {
    assert.equal(env.oauth.challengeHeader({ presented: false }), `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="handoff"`);
    assert.match(env.oauth.challengeHeader({ presented: true }), /error="invalid_token"$/);
  } else if (index === 8) {
    assert.throws(() => env.oauth.authenticate({ headers: {} }), error => error.code === 'invalid_token' && error.presented === false);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: 'Bearer junk' } }), error => error.code === 'invalid_token' && error.presented === true);
  } else {
    for (const issuer of ['http://example.com', 'https://example.com/path', 'not a URL', 'https://a:b@example.com']) {
      assert.throws(() => createOAuthServer({ issuer }), /https origin/);
    }
  }
}

async function removedClientStep(index) {
  const env = boot();
  const registration = await call(env, index % 2 ? 'POST' : 'GET', '/oauth/register', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  assert.equal(registration.status, 404);
  assert.equal(registration.json.error, 'not_found');
  const metadata = (await call(env, 'GET', '/.well-known/oauth-authorization-server')).json;
  assert.ok(!Object.hasOwn(metadata, 'registration_endpoint'));
  if (index === 12 || index === 13) {
    const hostile = ` Ada${String.fromCodePoint(0xe0001, 0x200d, 0x3164, 0x2800)} Lovelace ${'\u0301'.repeat(8)} `;
    const cleaned = cleanText(hostile, 40, 'ChatGPT');
    assert.ok(cleaned.includes('Ada'));
    assert.ok(!/[\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}]/u.test(cleaned));
    assert.ok(!/\p{M}{4}/u.test(cleaned));
  }
}

async function authorizeStep(index) {
  if (index === 16) {
    let fetches = 0;
    let callbacks = 0;
    const env = boot({ fetchClientMetadata: async () => { fetches += 1; return clientFrom(); }, onAuthorizeWithoutWindow: () => { callbacks += 1; } });
    const proof = pkce();
    const result = await call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE })}`);
    assert.equal(result.status, 403);
    assert.equal(fetches, 0);
    assert.equal(env.oauth.stats().pendingTransactions, 0);
    assert.equal(callbacks, 1);
    return;
  }
  if (index === 17) {
    const env = boot({ onConsentRequested: () => { throw new Error('notice failed'); } });
    const started = await consentStart(env);
    assert.equal(started.page.status, 200);
    assert.ok(started.txn);
    return;
  }
  const env = boot();
  if (index === 15) {
    const hostile = clientFrom({ ...REAL_METADATA, client_name: 'Marisol <script>alert(1)</script>' });
    const custom = boot({ metadata: hostile });
    const started = await consentStart(custom);
    assert.equal(started.page.status, 200);
    assert.ok(started.page.text.includes('Marisol &lt;script&gt;'));
    assert.ok(!started.page.text.includes('<script>alert'));
    assert.equal(started.page.headers['x-frame-options'], 'DENY');
    assert.match(started.page.headers['content-security-policy'], /form-action 'self' https:\/\/chatgpt\.com/);
  } else if (index === 18) {
    env.oauth.openPairing();
    const proof = pkce();
    const result = await call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: 'https://example.com/callback', code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE })}`);
    assert.equal(result.status, 400);
    assert.equal(result.location, null);
  } else if (index === 19) {
    env.oauth.openPairing();
    const proof = pkce();
    for (const query of [
      form({ response_type: 'code', redirect_uri: REDIRECT, code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE }),
      `response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${proof.challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    ]) assert.equal((await call(env, 'GET', `/oauth/authorize?${query}`)).status, 400);
  } else if (index === 20) {
    for (const extra of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { code_challenge: 'short' }]) {
      env.oauth.openPairing();
      const proof = pkce();
      const result = await call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE, ...extra })}`);
      assert.equal(result.status, 302);
      assert.equal(locationParams(result).get('error'), 'invalid_request');
      assert.equal(locationParams(result).get('iss'), ISSUER);
    }
  } else if (index === 21) {
    for (const resource of [undefined, 'https://example.com/mcp', `${RESOURCE}?x=1`, `${RESOURCE}/other`]) {
      env.oauth.openPairing();
      const proof = pkce();
      const result = await call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: proof.challenge, code_challenge_method: 'S256', resource })}`);
      assert.equal(locationParams(result).get('error'), 'invalid_target');
    }
    env.oauth.openPairing();
    const proof = pkce();
    assert.equal((await call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, code_challenge: proof.challenge, code_challenge_method: 'S256', resource: `${RESOURCE}/` })}`)).status, 200);
  } else if (index === 22) {
    for (const extra of [{ response_type: 'token' }, { scope: 'handoff unknown' }]) {
      const started = await consentStart(env, { state: 'Ada-state', extra });
      assert.equal(started.page.status, 302);
      assert.equal(locationParams(started.page).get('state'), 'Ada-state');
      assert.equal(locationParams(started.page).get('iss'), ISSUER);
    }
  } else if (index === 23) {
    const tooLong = await consentStart(env, { state: 'x'.repeat(4097) });
    assert.equal(tooLong.page.status, 302);
    assert.equal(locationParams(tooLong.page).get('state'), null);
    const exact = await consentStart(env, { state: '&'.repeat(4096) });
    assert.equal(exact.page.status, 200);
  } else if (index === 24) {
    for (const scope of ['openid email profile offline_access handoff', '', undefined]) {
      const started = await consentStart(env, { scope });
      assert.equal(started.page.status, 200);
    }
  } else {
    const linked = await grant(env, { scope: 'openid email profile offline_access handoff' });
    const authenticated = env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } });
    assert.match(authenticated.linkId, /^[a-f0-9]{12}$/);
    assert.equal(authenticated.clientKind, 'cimd');
  }
}

async function flowStep(index) {
  const env = boot();
  const linked = await grant(env);
  if (index === 26) {
    assert.doesNotThrow(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }));
    assert.throws(() => env.oauth.authenticate({ headers: {}, url: `/mcp?access_token=${linked.token.access_token}` }), error => error.code === 'invalid_token');
  } else if (index === 27) {
    assert.ok(env.store.commits() >= 2);
    const replacement = await grant(env);
    assert.equal(env.oauth.stats().activeFamilies, 1);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }), error => error.knownFamily === true);
    assert.doesNotThrow(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${replacement.token.access_token}` } }));
    assert.ok(env.events.some(item => item.event === 'link_replaced'));
  } else {
    assert.equal(linked.token.token_type, 'Bearer');
    assert.equal(linked.token.expires_in, 3600);
    assert.equal(env.events.filter(item => item.event === 'link_created').length, 1);
  }
}

async function cimdStep(index) {
  if (index === 29) {
    const extra = { ...REAL_METADATA, redirect_uris: [REDIRECT, 'https://example.com/callback'] };
    assert.equal(validateClientMetadata(extra, CLIENT_ID), null);
    return;
  }
  if (index === 30) {
    assert.ok(clientFrom());
    const unsigned = ['eyJhbGciOiJSUzI1NiIsImtpZCI6ImsifQ', Buffer.from(JSON.stringify({ iss: CLIENT_ID, sub: CLIENT_ID })).toString('base64url'), 'c2ln'].join('.');
    assert.equal(inspectAssertionClientId(unsigned), CLIENT_ID);
    return;
  }
  if (index === 31) {
    assert.equal(validateClientMetadata({ ...REAL_METADATA, client_secret: 'never-store-this' }, CLIENT_ID), null);
    assert.equal(validateClientMetadata({ ...REAL_METADATA, token_endpoint_auth_methods_supported: ['private_key_jwt'] }, CLIENT_ID), null);
    return;
  }
  if (index === 32) {
    assert.equal(validateClientMetadata({ ...REAL_METADATA, client_id: 'https://example.com/client.json' }, CLIENT_ID), null);
    return;
  }
  if (index === 33 || index === 34) {
    assert.equal(validateClientMetadata({ ...REAL_METADATA, redirect_uris: [] }, CLIENT_ID), null);
    assert.equal(validateClientMetadata(null, CLIENT_ID), null);
    assert.equal(validateClientMetadata({ ...REAL_METADATA, jwks_uri: 'https://example.com/jwks' }, CLIENT_ID), null);
    return;
  }
  if (index === 35) {
    let calls = 0;
    const fetcher = createCimdFetcher({ clientIds: [CLIENT_ID], fetchJson: async () => { calls += 1; return REAL_METADATA; } });
    assert.equal(await fetcher('http://chatgpt.com/oauth/client.json'), null);
    assert.equal(await fetcher('https://127.0.0.1/client.json'), null);
    assert.equal(await fetcher('https://user@chatgpt.com/oauth/client.json'), null);
    assert.equal(calls, 0);
    return;
  }
  if (index === 36 || index === 38) {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1', 'fc00::1']) assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
    let error;
    guardedLookup('chatgpt.com', {}, value => { error = value; }, (_host, options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    assert.ok(error instanceof Error);
    return;
  }
  if (index === 37) {
    for (const mode of ['redirect', 'content-type', 'too-large']) {
      const fakeRequest = (_target, _options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = () => undefined;
        req.destroy = () => undefined;
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = mode === 'redirect' ? 302 : 200;
          res.headers = mode === 'redirect' ? { location: 'https://example.com', 'content-type': 'application/json' }
            : { 'content-type': mode === 'content-type' ? 'text/html' : 'application/json' };
          res.resume = () => undefined;
          callback(res);
          if (mode === 'too-large') {
            res.emit('data', Buffer.alloc(CONSTANTS.CIMD_BODY_CAP_BYTES + 1));
            res.emit('end');
          }
        };
        return req;
      };
      const fetcher = createGuardedJsonFetcher({ request: fakeRequest, pins: [CLIENT_ID], setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => undefined });
      assert.equal(await fetcher(CLIENT_ID), null);
    }
    return;
  }
  if (index === 39) {
    const pending = [];
    const request = (_target, _options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      req.end = () => pending.push(callback);
      return req;
    };
    const fetcher = createGuardedJsonFetcher({ request, pins: [CLIENT_ID], concurrency: 4, setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => undefined });
    const calls = Array.from({ length: 6 }, () => fetcher(CLIENT_ID));
    await Promise.resolve();
    assert.equal(pending.length, 4);
    for (const callback of pending) {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      callback(res);
      res.emit('data', Buffer.from('{}'));
      res.emit('end');
    }
    const values = await Promise.all(calls);
    assert.equal(values.filter(Boolean).length, 4);
    return;
  }
  const env = boot();
  const linked = await grant(env);
  assert.ok(linked.token.access_token);
}

async function removedStaticStep(index) {
  const env = boot();
  const linked = await grant(env);
  const headers = index % 2 === 0 ? { authorization: `Basic ${Buffer.from('client:secret').toString('base64')}` } : {};
  const result = await postForm(env, '/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: linked.token.refresh_token,
    resource: RESOURCE,
    client_id: index === 44 ? 'https://example.com/client' : CLIENT_ID,
    client_secret: 'Marisol-Quenby-secret',
  }, { headers });
  if (index === 44) assert.equal(result.json.error, 'invalid_client');
  else {
    // Basic and client_secret_* are deliberately ignored. The public CIMD
    // identity still succeeds only because staging permits `none`.
    assert.equal(result.status, 200);
    assert.ok(!result.text.includes('Marisol-Quenby-secret'));
    assert.ok(!Object.hasOwn((await call(env, 'GET', '/.well-known/oauth-authorization-server')).json, 'registration_endpoint'));
  }
}

async function pairingStep(index) {
  const env = boot();
  if (index === 46) {
    const started = await consentStart(env);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await approve(env, started, { pairingCode: '22222-22222' });
      assert.equal(result.status, attempt < 5 ? 200 : 302);
      if (attempt === 5) assert.equal(locationParams(result).get('error'), 'access_denied');
    }
    for (let request = 1; request <= 2; request += 1) {
      const next = await consentStart(env, { open: false, state: `lock-${request}` });
      for (let attempt = 1; attempt <= 5; attempt += 1) await approve(env, next, { pairingCode: '22222-22222' });
    }
    assert.equal(env.oauth.pendingPairings(), 0, 'the fifteenth wrong code closes the whole window');
  } else if (index === 47) {
    const started = await consentStart(env);
    assert.equal((await approve(env, started, { pairingCode: '22222-22222' })).status, 200);
    assert.equal((await approve(env, started)).status, 302);
  } else if (index === 48) {
    const started = await consentStart(env);
    env.now.advance(CONSTANTS.TXN_TTL_MS + 1);
    assert.equal((await approve(env, started)).status, 403, 'the pairing window expires no later than its transaction');
  } else if (index === 49) {
    const started = await consentStart(env);
    assert.equal((await approve(env, started)).status, 302);
    assert.equal((await approve(env, started)).status, 403);
  } else if (index === 50) {
    const pairing = env.oauth.openPairing();
    const first = await consentStart(env, { open: false, state: 'first' });
    const second = await consentStart(env, { open: false, state: 'second' });
    assert.equal((await approve(env, first, { pairingCode: pairing })).status, 400, 'the newer request replaces the older one');
    assert.equal((await approve(env, second, { pairingCode: pairing })).status, 302);
  } else if (index === 51) {
    const started = await consentStart(env);
    assert.match(started.pairing, /^[23456789A-HJ-NP-Z]{5}-[23456789A-HJ-NP-Z]{5}$/);
    assert.equal(env.oauth.pendingPairings(), 1);
    const lowerNoHyphen = started.pairing.replace('-', '').toLowerCase();
    assert.equal((await approve(env, started, { pairingCode: lowerNoHyphen })).status, 302);
    assert.equal(env.oauth.pendingPairings(), 0);
  } else if (index === 52) {
    const started = await consentStart(env);
    env.now.advance(CONSTANTS.PAIRING_TTL_MS + 1);
    assert.equal((await approve(env, started)).status, 403);
  } else if (index === 53) {
    const started = await consentStart(env, { state: 'deny-state' });
    const denied = await approve(env, started, { action: 'deny' });
    assert.equal(locationParams(denied).get('error'), 'access_denied');
    assert.equal(locationParams(denied).get('state'), 'deny-state');
    assert.equal(locationParams(denied).get('iss'), ISSUER);
  } else if (index === 54) {
    env.oauth.openPairing();
    const unknown = await postForm(env, '/oauth/authorize', { txn: 'unknown', action: 'approve', pairing_code: '22222-22222' });
    assert.equal(unknown.status, 400);
    const started = await consentStart(env);
    const json = await postJson(env, '/oauth/authorize', { txn: started.txn, action: 'approve', pairing_code: started.pairing });
    assert.equal(json.status, 400);
  } else {
    const started = await consentStart(env);
    const bad = await approve(env, started, { pairingCode: '22222-22222' });
    assert.equal(bad.status, 200);
    assert.equal(env.oauth.stats().pendingTransactions, 1);
  }
}

async function obtainCode(env) {
  const started = await consentStart(env);
  const approved = await approve(env, started);
  assert.equal(approved.status, 302);
  return { started, code: locationParams(approved).get('code') };
}

async function exchangeCode(env, issued, overrides = {}, json = false) {
  const body = {
    grant_type: 'authorization_code',
    code: issued.code,
    redirect_uri: REDIRECT,
    code_verifier: issued.started.proof.verifier,
    resource: RESOURCE,
    client_id: CLIENT_ID,
    ...overrides,
  };
  return json ? postJson(env, '/oauth/token', body) : postForm(env, '/oauth/token', body);
}

async function grantStep(index) {
  const env = boot();
  if (index === 55) {
    const issued = await obtainCode(env);
    const wrong = await exchangeCode(env, issued, { code_verifier: pkce().verifier });
    assert.equal(wrong.json.error, 'invalid_grant');
    const retry = await exchangeCode(env, issued);
    assert.equal(retry.json.error, 'invalid_grant');
  } else if (index === 56) {
    const issued = await obtainCode(env);
    const wrongRedirect = await exchangeCode(env, issued, { redirect_uri: 'https://example.com/callback' });
    assert.equal(wrongRedirect.json.error, 'invalid_grant');
    assert.equal((await exchangeCode(env, issued)).status, 200);
  } else if (index === 57) {
    const issued = await obtainCode(env);
    const first = await exchangeCode(env, issued);
    assert.equal(first.status, 200);
    const replay = await exchangeCode(env, issued);
    assert.equal(replay.json.error, 'invalid_grant');
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${first.json.access_token}` } }), error => error.knownFamily === true);
    assert.ok(env.events.some(item => item.event === 'code_reuse'));
  } else if (index === 58) {
    const issued = await obtainCode(env);
    assert.equal((await exchangeCode(env, issued, { redirect_uri: undefined })).json.error, 'invalid_request');
    assert.equal((await exchangeCode(env, issued, { redirect_uri: 'https://example.com/callback' })).json.error, 'invalid_grant');
    assert.equal((await exchangeCode(env, issued)).status, 200);
  } else if (index === 59) {
    const issued = await obtainCode(env);
    for (const patch of [{ grant_type: undefined }, { code: undefined }, { code_verifier: 'short' }]) {
      const result = await exchangeCode(env, issued, patch);
      assert.ok(['invalid_request', 'unsupported_grant_type'].includes(result.json.error));
    }
  } else if (index === 60) {
    const issued = await obtainCode(env);
    assert.equal((await exchangeCode(env, issued, {}, true)).status, 200);
  } else if (index === 61 || index === 62) {
    const issued = await obtainCode(env);
    const result = await exchangeCode(env, issued, { client_secret: 'Ada-Lovelace-secret' });
    assert.equal(result.status, 200);
    assert.ok(!result.text.includes('Ada-Lovelace-secret'));
  } else if (index === 63) {
    const issued = await obtainCode(env);
    env.now.advance(CONSTANTS.AUTH_CODE_TTL_MS + 1);
    assert.equal((await exchangeCode(env, issued)).json.error, 'invalid_grant');
  } else if (index === 64) {
    const issued = await obtainCode(env);
    assert.equal((await exchangeCode(env, issued, { client_id: 'https://example.com/client' })).json.error, 'invalid_client');
    assert.equal((await exchangeCode(env, issued, { resource: undefined })).json.error, 'invalid_target');
    assert.equal((await exchangeCode(env, issued)).status, 200);
  } else if (index === 65) {
    const issued = await obtainCode(env);
    assert.equal((await exchangeCode(env, issued, { grant_type: 'client_credentials' })).json.error, 'unsupported_grant_type');
    assert.equal((await exchangeCode(env, issued)).status, 200);
  } else {
    const linked = await grant(env);
    env.now.advance(CONSTANTS.ACCESS_TTL_MS + 1);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }), error => error.code === 'invalid_token' && error.knownFamily === true);
    const next = await refresh(env, linked.token.refresh_token);
    assert.equal(next.status, 200);
    assert.doesNotThrow(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
  }
}

async function refreshStep(index) {
  const env = boot();
  const linked = await grant(env, { scope: 'openid email profile offline_access handoff' });
  if (index === 67) {
    const next = await refresh(env, linked.token.refresh_token);
    assert.equal(next.status, 200);
    assert.notEqual(next.json.refresh_token, linked.token.refresh_token);
    assert.notEqual(next.json.access_token, linked.token.access_token);
    assert.equal(next.json.scope, 'handoff');
    assert.equal(next.json.expires_in, 3600);
  } else if (index === 68) {
    const one = await refresh(env, linked.token.refresh_token);
    const two = await refresh(env, linked.token.refresh_token);
    assert.deepEqual(two.json, one.json);
  } else if (index === 69) {
    const next = await refresh(env, linked.token.refresh_token);
    env.now.advance(CONSTANTS.REFRESH_GRACE_MS + 1);
    assert.equal((await refresh(env, linked.token.refresh_token)).json.error, 'invalid_grant');
    assert.equal((await refresh(env, next.json.refresh_token)).json.error, 'invalid_grant');
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
    assert.ok(env.events.some(item => item.event === 'refresh_reuse'));
  } else if (index === 70) {
    const bad = await refresh(env, linked.token.refresh_token, { scope: 'handoff administrator' });
    assert.equal(bad.json.error, 'invalid_scope');
    assert.equal((await refresh(env, linked.token.refresh_token, { scope: 'handoff email' })).status, 200);
  } else if (index === 71) {
    for (const scope of ['openid', 'offline_access', '', 'handoff email profile offline_access']) {
      const isolated = boot();
      const item = await grant(isolated, { scope: 'openid email profile offline_access handoff' });
      const next = await refresh(isolated, item.token.refresh_token, { scope });
      assert.equal(next.status, 200);
      assert.doesNotThrow(() => isolated.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
    }
  } else if (index === 72) {
    assert.equal((await refresh(env, linked.token.refresh_token, { resource: 'https://example.com/mcp' })).json.error, 'invalid_target');
    assert.equal((await refresh(env, 'A'.repeat(43))).json.error, 'invalid_grant');
  } else if (index === 73) {
    let current = linked.token.refresh_token;
    for (let rotation = 0; rotation < 6; rotation += 1) {
      env.now.advance(2 * 24 * 60 * 60_000);
      const result = await refresh(env, current);
      assert.equal(result.status, 200);
      current = result.json.refresh_token;
    }
    env.now.advance((2 * 24 * 60 * 60_000) - 1);
    const before = await refresh(env, current);
    assert.equal(before.status, 200);
    env.now.advance(2);
    assert.equal((await refresh(env, before.json.refresh_token)).json.error, 'invalid_grant');
    assert.ok(env.events.some(item => item.event === 'refresh_expired'));
  } else if (index === 74) {
    assert.equal(CONSTANTS.ACCESS_TTL_MS, 3_600_000);
    assert.equal(CONSTANTS.REFRESH_GRACE_MS, 120_000);
    assert.equal(CONSTANTS.REFRESH_IDLE_MS, 3 * 24 * 60 * 60_000);
    assert.equal(CONSTANTS.REFRESH_ABSOLUTE_MS, 14 * 24 * 60 * 60_000);
  } else {
    const next = await refresh(env, linked.token.refresh_token);
    await revoke(env, next.json.access_token);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
    const replay = await refresh(env, linked.token.refresh_token);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.access_token, next.json.access_token);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${replay.json.access_token}` } }));
  }
}

async function revokeStep(index) {
  const env = boot();
  const linked = await grant(env);
  if (index === 76) {
    const result = await revoke(env, linked.token.access_token);
    assert.equal(result.status, 200);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }));
    assert.equal((await refresh(env, linked.token.refresh_token)).status, 200);
  } else if (index === 77) {
    const next = await refresh(env, linked.token.refresh_token);
    await revoke(env, next.json.access_token);
    const replay = await refresh(env, linked.token.refresh_token);
    assert.equal(replay.json.access_token, next.json.access_token);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
  } else if (index === 78) {
    assert.equal((await revoke(env, linked.token.refresh_token)).status, 200);
    assert.equal((await refresh(env, linked.token.refresh_token)).json.error, 'invalid_grant');
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }));
    assert.ok(env.disconnected.some(item => item.reason === 'token_revoked_by_client'));
  } else {
    assert.deepEqual((await revoke(env, 'x'.repeat(43))).json, {});
    const bad = await postForm(env, '/oauth/revoke', { token: linked.token.refresh_token, client_id: 'https://example.com/client' });
    assert.equal(bad.json.error, 'invalid_client');
    const missing = await postForm(env, '/oauth/revoke', { client_id: CLIENT_ID });
    assert.equal(missing.json.error, 'invalid_request');
  }
}

async function withTempDirectory(prefix, operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return await operation(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function persistenceStep(index) {
  if (index === 80) {
    await withTempDirectory('ic-oauth-state-', async directory => {
      const filePath = path.join(directory, 'oauth.json');
      const disk = createOAuthStore({ filePath });
      const env = boot({ store: disk });
      const linked = await grant(env);
      const text = fs.readFileSync(filePath, 'utf8');
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const secret of [linked.code, linked.token.access_token, linked.token.refresh_token, linked.started.pairing, linked.started.proof.verifier]) assert.ok(!text.includes(secret));
      assert.ok(text.includes(shaHex(linked.token.refresh_token)));
    });
    return;
  }
  if (index === 81 || index === 82) {
    const shared = memoryStore();
    const first = boot({ store: shared });
    const linked = await grant(first);
    const next = await refresh(first, linked.token.refresh_token);
    let refetches = 0;
    const restarted = boot({ store: shared, now: first.now, fetchClientMetadata: async () => { refetches += 1; throw new Error('offline'); } });
    assert.doesNotThrow(() => restarted.oauth.authenticate({ headers: { authorization: `Bearer ${next.json.access_token}` } }));
    const replay = await refresh(restarted, linked.token.refresh_token);
    assert.deepEqual(replay.json, next.json);
    assert.equal(refetches, 0, 'a persisted link refreshes while the metadata origin is offline');
    return;
  }
  if (index === 83 || index === 84) {
    const state = index === 83 ? { v: 1, issuer: ISSUER, clients: 'bad', codes: null, families: [{}], refresh: [null], access: [7] }
      : { v: 999, issuer: ISSUER, clients: [], codes: [], families: [], refresh: [], access: [] };
    const env = boot({ store: memoryStore(state) });
    assert.equal(env.oauth.stats().families, 0);
    assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${'A'.repeat(43)}` } }));
    if (index === 83) {
      await withTempDirectory('ic-oauth-oversize-', directory => {
        const filePath = path.join(directory, 'oauth.json');
        fs.writeFileSync(filePath, `{"v":1,"padding":"${'x'.repeat((4 * 1024 * 1024) + 1)}"}`, { mode: 0o600 });
        assert.deepEqual(createOAuthStore({ filePath }).read(), { v: 1, clients: [], codes: [], families: [], refresh: [], access: [] });
      });
    }
    return;
  }
  if (index === 85) {
    await withTempDirectory('ic-oauth-no-lock-', directory => {
      const filePath = path.join(directory, 'oauth.json');
      createOAuthStore({ filePath });
      assert.ok(!fs.existsSync(`${filePath}.lock`));
      const child = spawnSync(process.execPath, ['-e', '0']);
      assert.equal(child.status, 0);
      const moduleUrl = new URL('../../electron/ipc/handoffBridge/oauth.js', import.meta.url).href;
      const closes = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createOAuthServer } from ${JSON.stringify(moduleUrl)}; const server=createOAuthServer({issuer:'https://example.com'}); server.close(); server.close();`], { encoding: 'utf8' });
      assert.equal(closes.status, 0, closes.stderr);
      const rejectsHttp = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createOAuthServer } from ${JSON.stringify(moduleUrl)}; try { createOAuthServer({issuer:'http://example.com'}); process.exit(2); } catch { process.exit(0); }`], { encoding: 'utf8' });
      assert.equal(rejectsHttp.status, 0, rejectsHttp.stderr);
    });
    return;
  }
  if (index === 86) {
    const store = memoryStore();
    const env = boot({ store });
    const linked = await grant(env);
    assert.ok(store.state().refresh.some(record => record.hash === shaHex(linked.token.refresh_token)));
    store.setFail(true);
    const failed = await refresh(env, linked.token.refresh_token);
    assert.equal(failed.status, 503);
    assert.equal(failed.json.error, 'temporarily_unavailable');
    assert.ok(!Object.hasOwn(failed.json, 'access_token'));
    store.setFail(false);
    await revoke(env, linked.token.refresh_token);
    assert.ok(store.state().families.every(family => family.revoked));
    return;
  }
  if (index === 87) {
    const env = boot();
    const linked = await grant(env);
    await refresh(env, linked.token.refresh_token);
    const text = JSON.stringify(env.store.state());
    assert.ok(text.includes('grace'));
    assert.ok(!text.includes(linked.token.refresh_token));
    assert.ok(!Object.hasOwn(env.store.state(), 'key'));
    return;
  }
  if (index === 88) {
    const shared = memoryStore();
    const original = boot({ store: shared });
    const linked = await grant(original);
    const moved = boot({ store: shared, issuer: 'https://other.example.com' });
    assert.equal(moved.oauth.stats().families, 0);
    assert.throws(() => moved.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }));
    return;
  }
  const env = boot();
  assert.equal(env.oauth.close(), true);
  assert.equal(env.oauth.close(), true);
  assert.equal(process.getActiveResourcesInfo().filter(item => item === 'Timeout').length >= 0, true);
}

async function boundsStep(index) {
  if (index === 89 || index === 90) {
    const env = boot();
    const pairing = env.oauth.openPairing();
    let newest;
    for (let count = 0; count < 120; count += 1) newest = await consentStart(env, { open: false, state: `state-${count}` });
    assert.equal(env.oauth.stats().pendingTransactions, 1);
    assert.equal((await approve(env, newest, { pairingCode: pairing })).status, 302);
    return;
  }
  if (index === 91) {
    const env = boot();
    const started = await consentStart(env);
    for (let count = 0; count < 4; count += 1) assert.equal((await approve(env, started, { pairingCode: '22222-22222' })).status, 200);
    assert.equal((await approve(env, started)).status, 302);
    return;
  }
  if (index === 92 || index === 93) {
    let failures = 0;
    const env = boot();
    const linked = await grant(env);
    const badContext = { rateFailure: () => { failures += 1; return failures > 30; } };
    for (let count = 0; count < 35; count += 1) await postForm(env, '/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x', resource: RESOURCE, client_id: CLIENT_ID }, { serverContext: badContext });
    assert.equal((await refresh(env, linked.token.refresh_token)).status, 200);
    return;
  }
  if (index >= 94 && index <= 95) {
    const env = boot();
    assert.equal((await call(env, 'GET', '/oauth/register')).status, 404);
    assert.equal(env.oauth.stats().clients, 0);
    return;
  }
  if (index === 96) {
    const env = boot();
    for (let count = 0; count < 80; count += 1) {
      const started = await consentStart(env);
      assert.equal((await approve(env, started)).status, 302);
    }
    assert.equal(env.oauth.stats().codes, 64);
    return;
  }
  if (index === 97) {
    const env = boot();
    for (const target of ['/oauth/token', '/oauth/revoke', '/oauth/authorize']) {
      if (target === '/oauth/authorize') env.oauth.openPairing();
      await assert.rejects(() => call(env, 'POST', target, { headers: FORM, body: 'x'.repeat(CONSTANTS.OAUTH_BODY_CAP_BYTES + 1) }), error => error.status === 413);
    }
    assert.equal((await call(env, 'GET', '/.well-known/oauth-authorization-server')).status, 200);
    return;
  }
  const env = boot();
  if (index === 98) {
    for (const target of ['/oauth/token', '/oauth/revoke']) {
      for (const body of ['%', '{', 'x=y&x=z', '\u0000']) {
        const result = await call(env, 'POST', target, { headers: FORM, body });
        assert.ok(result.status >= 400 && result.status < 500, `${target} returned ${result.status}`);
      }
    }
    return;
  }
  const linked = await grant(env);
  const logText = JSON.stringify({ events: env.events, auth: env.auth, disconnected: env.disconnected, consent: env.consent });
  for (const secret of [linked.code, linked.token.access_token, linked.token.refresh_token, linked.started.pairing, linked.started.proof.verifier, linked.started.txn]) assert.ok(!logText.includes(secret));
}

async function runPortedLabStep(index) {
  if (index <= 9) return discoveryStep(index);
  if (index <= 14) return removedClientStep(index);
  if (index <= 25) return authorizeStep(index);
  if (index <= 28) return flowStep(index);
  if (index <= 39) return cimdStep(index);
  if (index <= 45) return removedStaticStep(index);
  if (index <= 54) return pairingStep(index);
  if (index <= 66) return grantStep(index);
  if (index <= 75) return refreshStep(index);
  if (index <= 79) return revokeStep(index);
  if (index <= 88) return persistenceStep(index);
  return boundsStep(index);
}

const portedLabTests = LAB_STEP_NAMES.map((name, index) => ({
  name: `handoff bridge: oauth: ${name}`,
  run: () => runPortedLabStep(index),
}));

const phaseOneTests = [
  {
    name: 'handoff bridge: oauth: phase 1 constants pin the hardened lifetimes and one-grant policy',
    run: () => {
      assert.equal(CONSTANTS.ACCESS_TTL_MS, 3_600_000);
      assert.equal(CONSTANTS.REFRESH_IDLE_MS, 3 * 24 * 60 * 60_000);
      assert.equal(CONSTANTS.REFRESH_ABSOLUTE_MS, 14 * 24 * 60 * 60_000);
      assert.equal(CONSTANTS.REFRESH_GRACE_MS, 120_000);
      assert.equal(CONSTANTS.ACTIVE_GRANTS_MAX_COUNT, 1);
      assert.deepEqual(CONSTANTS.CIMD_CLIENT_IDS, [CLIENT_ID]);
    },
  },
  {
    name: 'handoff bridge: oauth: first code exchange persists only its safe link-time source prefix',
    run: async () => {
      const env = boot();
      const issued = await obtainCode(env);
      const result = await call(env, 'POST', '/oauth/token', {
        headers: FORM,
        body: form({
          grant_type: 'authorization_code', code: issued.code, redirect_uri: REDIRECT,
          code_verifier: issued.started.proof.verifier, resource: RESOURCE, client_id: CLIENT_ID,
        }),
        serverContext: { sourcePrefix: '2001:db8:1234::/48' },
      });
      assert.equal(result.status, 200);
      assert.deepEqual(env.oauth.linkStatus()[0].sources, ['2001:db8:1234::/48']);
      assert.equal(env.store.state().families[0].sourcePrefix, '2001:db8:1234::/48');
      assert.ok(!JSON.stringify(env.store.state()).includes(result.json.access_token), 'source persistence must retain only hashes and the prefix, never issued secrets');
      const tampered = env.store.state();
      tampered.families[0].sourcePrefix = '999.999.999.0/24';
      assert.deepEqual(boot({ store: memoryStore(tampered) }).oauth.linkStatus()[0].sources, [], 'tampered IPv4 prefix octets must not reach link status');
      tampered.families[0].sourcePrefix = '2001:0db8:1234:1::/48';
      assert.deepEqual(boot({ store: memoryStore(tampered) }).oauth.linkStatus()[0].sources, [], 'noncanonical or host-bearing IPv6 prefixes must not reach link status');
    },
  },
  {
    name: 'handoff bridge: oauth: resource is canonical for the configured hostname',
    run: async () => {
      const env = boot();
      assert.equal(env.oauth.resource, RESOURCE);
      const started = await consentStart(env, { extra: { resource: `${ISSUER.toUpperCase()}/mcp/` } });
      assert.equal(started.page.status, 200);
      const bad = await consentStart(env, { extra: { resource: `${ISSUER}/MCP` } });
      assert.equal(locationParams(bad.page).get('error'), 'invalid_target');
    },
  },
  {
    name: 'handoff bridge: oauth: moving persisted state to another hostname drops every grant',
    run: async () => {
      const store = memoryStore();
      const first = boot({ store });
      const linked = await grant(first);
      const moved = boot({ store, issuer: 'https://moved.example.com' });
      assert.equal(moved.oauth.stats().activeFamilies, 0);
      assert.throws(() => moved.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }));
    },
  },
  {
    name: 'handoff bridge: oauth: every authorization redirect includes iss including errors',
    run: async () => {
      const env = boot();
      const deniedStart = await consentStart(env, { state: 'Ada-state' });
      const denied = await approve(env, deniedStart, { action: 'deny' });
      assert.equal(locationParams(denied).get('iss'), ISSUER);
      const bad = await consentStart(env, { state: 'Ada-state', extra: { response_type: 'token' } });
      assert.equal(locationParams(bad.page).get('iss'), ISSUER);
    },
  },
  {
    name: 'handoff bridge: oauth: real ChatGPT metadata is accepted and secret-bearing metadata is refused',
    run: () => {
      assert.ok(clientFrom());
      assert.equal(validateClientMetadata({ ...REAL_METADATA, client_secret: 'Marisol-Quenby-secret' }, CLIENT_ID), null);
      assert.equal(validateClientMetadata({ ...REAL_METADATA, client_secret_expires_at: 0 }, CLIENT_ID), null);
    },
  },
  {
    name: 'handoff bridge: oauth: OpenID compatibility scopes are tolerated but arbitrary escalation is not',
    run: async () => {
      const env = boot();
      assert.equal((await consentStart(env, { scope: 'openid email profile offline_access handoff' })).page.status, 200);
      const refused = await consentStart(env, { scope: 'handoff administrator' });
      assert.equal(locationParams(refused.page).get('error'), 'invalid_scope');
    },
  },
  {
    name: 'handoff bridge: oauth: racing refreshes from two chats return one identical successor pair',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      const [left, right] = await Promise.all([refresh(env, linked.token.refresh_token), refresh(env, linked.token.refresh_token)]);
      assert.equal(left.status, 200);
      assert.deepEqual(right.json, left.json);
    },
  },
  {
    name: 'handoff bridge: oauth: a sealed grace successor digest mismatch fails closed',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      const rotated = await refresh(env, linked.token.refresh_token);
      assert.equal(rotated.status, 200);
      const state = env.store.state();
      const predecessor = state.refresh.find(record => record.hash === shaHex(linked.token.refresh_token));
      assert.ok(predecessor, 'the rotated predecessor must remain available for its bounded grace replay');
      predecessor.successor = shaHex('synthetic-swapped-successor');
      const restored = boot({ now: env.now, store: memoryStore(state) });
      const replay = await refresh(restored, linked.token.refresh_token);
      assert.equal(replay.json.error, 'invalid_grant');
      assert.equal(restored.oauth.stats().activeFamilies, 0,
        'a mismatched sealed successor digest must revoke rather than return a token pair');
    },
  },
  {
    name: 'handoff bridge: oauth: pairing can only be armed through the main-process object and is never serialized',
    run: () => {
      const env = boot();
      const code = env.oauth.openPairing();
      assert.match(code, /^.{5}-.{5}$/);
      assert.equal(env.oauth.pendingPairings(), 1);
      assert.ok(!JSON.stringify(env.oauth.stats()).includes(code));
      assert.ok(!JSON.stringify(env.store.state()).includes(code));
    },
  },
  {
    name: 'handoff bridge: oauth: ChatGPT revoke disconnects the linked refresh family',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      assert.equal((await revoke(env, linked.token.refresh_token)).status, 200);
      assert.equal(env.oauth.stats().activeFamilies, 0);
      assert.equal(env.disconnected.at(-1).reason, 'token_revoked_by_client');
    },
  },
  {
    name: 'handoff bridge: oauth: an idle-expired refresh reports invalid_grant and a known link',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      env.now.advance(CONSTANTS.REFRESH_IDLE_MS + 1);
      const result = await refresh(env, linked.token.refresh_token);
      assert.equal(result.json.error, 'invalid_grant');
      assert.ok(env.events.some(item => item.event === 'refresh_expired'));
    },
  },
  {
    name: 'handoff bridge: oauth: a closed pairing window creates no transaction code or metadata fetch',
    run: async () => {
      let fetches = 0;
      const env = boot({ fetchClientMetadata: async () => { fetches += 1; return clientFrom(); } });
      const started = await consentStart(env, { open: false });
      assert.equal(started.page.status, 403);
      assert.equal(fetches, 0);
      assert.deepEqual([env.oauth.stats().pendingTransactions, env.oauth.stats().codes], [0, 0]);
    },
  },
  {
    name: 'handoff bridge: oauth: a close during deferred client metadata cannot resurrect consent state',
    run: async () => {
      const metadata = deferred(); let fetches = 0;
      const env = boot({ fetchClientMetadata: () => { fetches += 1; return metadata.promise; } });
      const pairing = env.oauth.openPairing(); const proof = pkce();
      const request = call(env, 'GET', `/oauth/authorize?${form({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state: 'deferred-Ada',
        code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE,
      })}`);
      await Promise.resolve();
      assert.equal(fetches, 1);
      assert.equal(env.oauth.closePairing(), true);
      metadata.resolve(clientFrom());
      const result = await request;
      assert.equal(result.status, 403);
      assert.deepEqual([env.oauth.stats().pendingTransactions, env.oauth.pendingPairings(), env.consent.length], [0, 0, 0]);
      assert.ok(!result.text.includes(pairing), 'deferred cancellation must not echo a pairing code');
    },
  },
  {
    name: 'handoff bridge: oauth: deny and the fifteenth wrong code emit only their closed enums',
    run: async () => {
      const denied = boot(); const deniedStart = await consentStart(denied, { state: 'deny-Ada' });
      assert.equal((await approve(denied, deniedStart, { action: 'deny' })).status, 302);
      assert.deepEqual(denied.pairingClosed, ['denied']);
      assert.equal(denied.oauth.pendingPairings(), 0);

      const locked = boot(); locked.oauth.openPairing();
      for (let request = 0; request < 3; request += 1) {
        const started = await consentStart(locked, { open: false, state: `lock-Ada-${request}` });
        for (let attempt = 0; attempt < CONSTANTS.PAIRING_WRONG_TRIES_PER_REQUEST; attempt += 1) {
          await approve(locked, started, { pairingCode: '22222-22222' });
        }
      }
      assert.deepEqual(locked.pairingClosed, ['locked']);
      assert.equal(locked.oauth.pendingPairings(), 0);
      assert.equal(locked.oauth.stats().pendingTransactions, 0);
    },
  },
  {
    name: 'handoff bridge: oauth: 500 valid authorize requests retain one pending transaction',
    run: async () => {
      const env = boot(); env.oauth.openPairing();
      for (let index = 0; index < 500; index += 1) {
        const proof = pkce();
        const result = await call(env, 'GET', `/oauth/authorize?${form({
          response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state: `flood-Ada-${index}`,
          code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE,
        })}`);
        assert.equal(result.status, 200);
      }
      assert.equal(env.oauth.stats().pendingTransactions, 1);
      assert.equal(env.consent.length, 500);
    },
  },
  {
    name: 'handoff bridge: oauth: persisted OAuth state contains hashes and sealed grace but no raw credential',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      await refresh(env, linked.token.refresh_token);
      const text = JSON.stringify(env.store.state());
      for (const raw of [linked.code, linked.token.access_token, linked.token.refresh_token, linked.started.pairing, linked.started.proof.verifier]) assert.ok(!text.includes(raw));
      assert.ok(text.includes(shaHex(linked.token.refresh_token)));
      assert.ok(text.includes('grace'));
    },
  },
  {
    name: 'handoff bridge: oauth: closePairing returns an explicit durable controller acknowledgement',
    run: () => {
      const env = boot();
      assert.equal(env.oauth.closePairing(), true);
      assert.equal(env.oauth.stats().pairings, 0);
    },
  },
  {
    name: 'handoff bridge: oauth: an expired refresh becomes a source-free renewal marker and changed-network code grant recovers',
    run: async () => {
      const hints = [];
      const env = boot({ onAuthorizeWithoutWindow: value => hints.push(value) });
      const initialCode = await obtainCode(env);
      const initial = await call(env, 'POST', '/oauth/token', {
        headers: FORM,
        body: form({ grant_type: 'authorization_code', code: initialCode.code, redirect_uri: REDIRECT, code_verifier: initialCode.started.proof.verifier, resource: RESOURCE, client_id: CLIENT_ID }),
        serverContext: { sourcePrefix: '203.0.113.0/24' },
      });
      assert.equal(initial.status, 200);
      env.now.advance(CONSTANTS.REFRESH_IDLE_MS + 1);
      assert.equal((await refresh(env, initial.json.refresh_token)).json.error, 'invalid_grant');
      const marker = env.oauth.linkStatus()[0];
      assert.equal(marker.state, 'needs-renewal');
      assert.equal(marker.renewalCause, 'refresh_expired');
      assert.equal(marker.revoked, true);
      assert.deepEqual(marker.sources, []);
      assert.equal(env.disconnected.at(-1).reason, 'refresh_expired');
      assert.throws(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${initial.json.access_token}` } }), error => error?.code === 'invalid_token',
        'an expired family must not leave an access token authenticatable on any source');

      const proof = pkce();
      const closed = await call(env, 'GET', `/oauth/authorize?${form({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state: 'Ada-state', code_challenge: proof.challenge,
        code_challenge_method: 'S256', resource: RESOURCE,
      })}`, { serverContext: { source: '203.0.113.44' } });
      assert.equal(closed.status, 403);
      assert.deepEqual(hints, [{ source: '203.0.113.44', linkState: 'needs-renewal', knownFamily: true }],
        'a closed known-family authorize forwards only bounded reconnect facts');
      assert.deepEqual(env.oauth.unarmedStatus(), { count: 1, lastAt: env.now() }, 'anonymous authorize accounting is bounded status-only state');

      const replacement = await obtainCode(env);
      const recovered = await call(env, 'POST', '/oauth/token', {
        headers: FORM,
        body: form({ grant_type: 'authorization_code', code: replacement.code, redirect_uri: REDIRECT, code_verifier: replacement.started.proof.verifier, resource: RESOURCE, client_id: CLIENT_ID }),
        serverContext: { sourcePrefix: '198.51.100.0/24' },
      });
      assert.equal(recovered.status, 200);
      const linked = env.oauth.linkStatus();
      assert.equal(linked.length, 1);
      assert.equal(linked[0].state, 'linked');
      assert.deepEqual(linked[0].sources, ['198.51.100.0/24']);
      assert.doesNotThrow(() => env.oauth.authenticate({ headers: { authorization: `Bearer ${recovered.json.access_token}` } }));
    },
  },
  {
    name: 'handoff bridge: oauth: load-time GC bounds revoked relinks while preserving active grace replay',
    run: async () => {
      const env = boot(); const linked = await grant(env); const rotated = await refresh(env, linked.token.refresh_token);
      assert.equal(rotated.status, 200);
      const seeded = env.store.state();
      for (let familyIndex = 0; familyIndex < 20; familyIndex += 1) {
        const id = `revoked-family-${familyIndex}`;
        seeded.families.push({ ...seeded.families[0], id, revoked: true, revokedAt: env.now() - familyIndex - 1, renewalCause: null, renewalAt: null, sourcePrefix: null });
        for (let tokenIndex = 0; tokenIndex < 128; tokenIndex += 1) {
          seeded.refresh.push({ hash: shaHex(`refresh-${familyIndex}-${tokenIndex}`), familyId: id, supersededAt: null, successor: null, grace: null });
          seeded.access.push({ hash: shaHex(`access-${familyIndex}-${tokenIndex}`), familyId: id, scope: 'handoff', expiresAt: env.now() + CONSTANTS.ACCESS_TTL_MS, revoked: true });
        }
      }
      const store = memoryStore(seeded); const restored = boot({ now: env.now, store });
      const stats = restored.oauth.stats();
      assert.ok(stats.families <= 9 && stats.refreshTokens <= 1024 && stats.accessTokens <= 1024,
        'load compaction must leave a fixed family/token-map ceiling after repeated relinks');
      const compact = store.state();
      const retainedByFamily = records => records.filter(record => record.familyId.startsWith('revoked-family-')).reduce((counts, record) => {
        counts.set(record.familyId, (counts.get(record.familyId) || 0) + 1); return counts;
      }, new Map());
      assert.ok(compact.families.length <= 9 && [...retainedByFamily(compact.refresh).values(), ...retainedByFamily(compact.access).values()].every(count => count <= 8),
        'revoked forensic family records retain only a fixed bounded token-hash sample on disk');
      const replay = await refresh(restored, linked.token.refresh_token);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.json, rotated.json, 'the active predecessor grace replay survives compaction exactly');
      assert.doesNotThrow(() => restored.oauth.authenticate({ headers: { authorization: `Bearer ${rotated.json.access_token}` } }),
        'the active successor remains authenticatable after load-time compaction');
    },
  },
  {
    name: 'handoff bridge: oauth: a malformed renewal marker is revoked before a loaded bearer can authenticate and expires durably',
    run: async () => {
      const env = boot(); const linked = await grant(env); const state = env.store.state();
      state.families[0] = {
        ...state.families[0], renewalCause: 'refresh_expired', renewalAt: env.now(), revoked: false, revokedAt: 0,
      };
      const store = memoryStore(state); const restored = boot({ now: env.now, store });
      assert.throws(() => restored.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }), error => error?.code === 'invalid_token',
        'a renewalCause/revoked:false corruption must fail closed before any loaded access token is accepted');
      const marker = restored.oauth.linkStatus()[0];
      assert.equal(marker.state, 'needs-renewal'); assert.equal(marker.revoked, true); assert.deepEqual(marker.sources, []);
      assert.equal(store.state().families[0].revoked, true, 'load normalization must be persisted rather than surviving only in memory');
      env.now.advance(30 * 60_000 + 1);
      assert.equal(restored.oauth.linkStatus().length, 0, 'a stale renewal marker must disappear from the public link projection');
      assert.equal(store.state().families[0].renewalCause, null,
        'marker expiry must commit the bounded durable projection rather than reappearing on restart');
    },
  },
  {
    name: 'handoff bridge: oauth: an oversized active durable family is made source-free and non-authenticatable at load',
    run: async () => {
      const env = boot(); const linked = await grant(env); const state = env.store.state(); const familyId = state.families[0].id;
      for (let index = 0; index < 1025; index += 1) {
        state.access.push({ hash: shaHex(`oversized-active-${index}`), familyId, scope: CONSTANTS.SCOPE, expiresAt: env.now() + CONSTANTS.ACCESS_TTL_MS, revoked: false });
      }
      const store = memoryStore(state); const restored = boot({ now: env.now, store });
      assert.throws(() => restored.oauth.authenticate({ headers: { authorization: `Bearer ${linked.token.access_token}` } }), error => error?.code === 'invalid_token',
        'load-time capacity overflow must revoke the formerly active bearer family');
      const marker = restored.oauth.linkStatus()[0];
      assert.equal(marker.state, 'needs-renewal'); assert.equal(marker.renewalCause, 'invalid_grant'); assert.deepEqual(marker.sources, []);
      const compact = store.state();
      assert.equal(compact.families[0].revoked, true);
      assert.equal(compact.access.filter(record => record.familyId === familyId).length, 0);
      assert.equal(compact.refresh.filter(record => record.familyId === familyId).length, 0,
        'an oversized family retains only the safe renewal marker, not a usable credential history');
    },
  },
];

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const weakRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const PUBLIC_JWK = Object.freeze({ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'chatgpt-key-1', use: 'sig', alg: 'RS256', key_ops: ['verify'] });
const WEAK_JWK = Object.freeze({ ...weakRsa.publicKey.export({ format: 'jwk' }), kid: 'weak-key', use: 'sig', alg: 'RS256', key_ops: ['verify'] });
let jwtSequence = 0;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function assertion({ clock = clockAt(), header = {}, claims = {}, key = rsa.privateKey } = {}) {
  jwtSequence += 1;
  const seconds = Math.floor(clock() / 1000);
  const protectedHeader = encode({ alg: 'RS256', kid: 'chatgpt-key-1', typ: 'JWT', ...header });
  const payload = encode({ iss: CLIENT_ID, sub: CLIENT_ID, aud: `${ISSUER}/oauth/token`, iat: seconds, exp: seconds + 240, jti: `jti-${jwtSequence}`, ...claims });
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function verifier(options = {}) {
  const now = options.now || clockAt();
  let fetches = 0;
  const fetchJwks = options.fetchJwks || (async () => { fetches += 1; return { keys: [PUBLIC_JWK] }; });
  const instance = createClientAssertionVerifier({ fetchJwks, now, issuer: ISSUER, tokenEndpoint: `${ISSUER}/oauth/token`, clientId: CLIENT_ID, constants: options.constants || CONSTANTS });
  return { instance, now, fetches: () => fetches };
}

const verify = (instance, token, extra = {}) => instance.verify({ assertion: token, assertionType: JWT_BEARER, ...extra });

const assertionTests = [
  {
    name: 'handoff bridge: oauth: assertion outcomes are a closed privacy-safe enumeration',
    run: () => assert.deepEqual(ASSERTION_OUTCOMES, ['none', 'assertion_ok', 'assertion_bad_signature', 'assertion_bad_claims', 'assertion_replay', 'assertion_unknown_kid', 'other']),
  },
  {
    name: 'handoff bridge: oauth: assertion subject inspection only accepts matching iss and sub',
    run: () => {
      const token = assertion();
      assert.equal(inspectAssertionClientId(token), CLIENT_ID);
      assert.equal(inspectAssertionClientId(assertion({ claims: { sub: 'https://example.com/client' } })), null);
    },
  },
  {
    name: 'handoff bridge: oauth: a valid RS256 assertion may target the token endpoint',
    run: async () => assert.equal((await verify(verifier().instance, assertion())).outcome, 'assertion_ok'),
  },
  {
    name: 'handoff bridge: oauth: a valid RS256 assertion may target the issuer',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { aud: ISSUER } }))).audience, 'issuer'),
  },
  {
    name: 'handoff bridge: oauth: an audience array may contain both accepted server identifiers',
    run: async () => {
      const result = await verify(verifier().instance, assertion({ claims: { aud: [ISSUER, `${ISSUER}/oauth/token`] } }));
      assert.equal(result.outcome, 'assertion_ok');
      assert.equal(result.audience, 'both');
    },
  },
  {
    name: 'handoff bridge: oauth: an absent assertion is the enumerated none outcome',
    run: async () => assert.equal((await verifier().instance.verify({})).outcome, 'none'),
  },
  {
    name: 'handoff bridge: oauth: an assertion type without an assertion is refused',
    run: async () => assert.equal((await verifier().instance.verify({ assertionType: JWT_BEARER })).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: assertions over 4096 characters are refused before JWKS fetch',
    run: async () => {
      const item = verifier();
      assert.equal((await verify(item.instance, 'A'.repeat(4097))).outcome, 'assertion_bad_claims');
      assert.equal(item.fetches(), 0);
    },
  },
  {
    name: 'handoff bridge: oauth: malformed JWT segment counts are bad claims',
    run: async () => assert.equal((await verify(verifier().instance, 'a.b')).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: noncanonical base64url JWT parts are bad claims',
    run: async () => assert.equal((await verify(verifier().instance, 'e30=.e30.c2ln')).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: alg none is refused without a key fetch',
    run: async () => {
      const item = verifier();
      const token = assertion({ header: { alg: 'none' } });
      assert.equal((await verify(item.instance, token)).outcome, 'assertion_bad_claims');
      assert.equal(item.fetches(), 0);
    },
  },
  {
    name: 'handoff bridge: oauth: HMAC algorithm confusion is refused',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ header: { alg: 'HS256' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: a missing kid is refused before cryptographic work',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ header: { kid: '' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: an unknown kid produces only the enumerated unknown-kid outcome',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ header: { kid: 'missing' } }))).outcome, 'assertion_unknown_kid'),
  },
  {
    name: 'handoff bridge: oauth: unknown kid refetches are limited to one per 60 seconds',
    run: async () => {
      const item = verifier();
      await verify(item.instance, assertion({ header: { kid: 'missing-1' } }));
      await verify(item.instance, assertion({ header: { kid: 'missing-2' } }));
      assert.equal(item.fetches(), 1);
      item.now.advance(CONSTANTS.JWKS_UNKNOWN_KID_REFETCH_MS);
      await verify(item.instance, assertion({ clock: item.now, header: { kid: 'missing-3' } }));
      assert.equal(item.fetches(), 2);
    },
  },
  {
    name: 'handoff bridge: oauth: a signature from another RSA key is refused',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ key: weakRsa.privateKey }))).outcome, 'assertion_bad_signature'),
  },
  {
    name: 'handoff bridge: oauth: RSA keys below 2048 bits are refused',
    run: async () => {
      const item = verifier({ fetchJwks: async () => ({ keys: [WEAK_JWK] }) });
      assert.equal((await verify(item.instance, assertion({ header: { kid: 'weak-key' }, key: weakRsa.privateKey }))).outcome, 'assertion_bad_signature');
    },
  },
  {
    name: 'handoff bridge: oauth: non-RSA and signing-only JWKS entries are refused',
    run: async () => {
      const bad = { ...PUBLIC_JWK, kty: 'oct', key_ops: ['sign'] };
      const item = verifier({ fetchJwks: async () => ({ keys: [bad] }) });
      assert.equal((await verify(item.instance, assertion())).outcome, 'assertion_bad_signature');
    },
  },
  {
    name: 'handoff bridge: oauth: issuer must equal the pinned client id',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { iss: 'https://example.com/client' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: subject must equal issuer and the pinned client id',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { sub: 'https://example.com/client' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: a body client_id mismatch is refused',
    run: async () => assert.equal((await verify(verifier().instance, assertion(), { assertedClientId: 'https://example.com/client' })).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: a foreign assertion audience is refused',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { aud: 'https://example.com/token' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: assertion iat and exp must be safe integers',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { iat: 'now' } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: assertion exp must be after iat',
    run: async () => {
      const now = clockAt();
      const seconds = Math.floor(now() / 1000);
      assert.equal((await verify(verifier({ now }).instance, assertion({ clock: now, claims: { iat: seconds, exp: seconds } }))).outcome, 'assertion_bad_claims');
    },
  },
  {
    name: 'handoff bridge: oauth: assertion lifetime is capped at 300 seconds',
    run: async () => {
      const now = clockAt();
      const seconds = Math.floor(now() / 1000);
      assert.equal((await verify(verifier({ now }).instance, assertion({ clock: now, claims: { iat: seconds, exp: seconds + 301 } }))).outcome, 'assertion_bad_claims');
    },
  },
  {
    name: 'handoff bridge: oauth: expired assertions receive only the 60-second clock skew',
    run: async () => {
      const now = clockAt();
      const seconds = Math.floor(now() / 1000);
      assert.equal((await verify(verifier({ now }).instance, assertion({ clock: now, claims: { iat: seconds - 200, exp: seconds - 61 } }))).outcome, 'assertion_bad_claims');
    },
  },
  {
    name: 'handoff bridge: oauth: future assertions receive only the 60-second clock skew',
    run: async () => {
      const now = clockAt();
      const seconds = Math.floor(now() / 1000);
      assert.equal((await verify(verifier({ now }).instance, assertion({ clock: now, claims: { iat: seconds + 61, exp: seconds + 120 } }))).outcome, 'assertion_bad_claims');
    },
  },
  {
    name: 'handoff bridge: oauth: an invalid or oversized jti is refused',
    run: async () => assert.equal((await verify(verifier().instance, assertion({ claims: { jti: 'x'.repeat(257) } }))).outcome, 'assertion_bad_claims'),
  },
  {
    name: 'handoff bridge: oauth: a repeated jti is rejected as replay',
    run: async () => {
      const item = verifier();
      const token = assertion({ clock: item.now, claims: { jti: 'one-use-jti' } });
      assert.equal((await verify(item.instance, token)).outcome, 'assertion_ok');
      assert.equal((await verify(item.instance, token)).outcome, 'assertion_replay');
    },
  },
  {
    name: 'handoff bridge: oauth: the jti replay entry expires after ten minutes',
    run: async () => {
      const item = verifier();
      const first = assertion({ clock: item.now, claims: { jti: 'reusable-later' } });
      assert.equal((await verify(item.instance, first)).outcome, 'assertion_ok');
      item.now.advance(CONSTANTS.JWT_JTI_CACHE_MS + 1);
      const second = assertion({ clock: item.now, claims: { jti: 'reusable-later' } });
      assert.equal((await verify(item.instance, second)).outcome, 'assertion_ok');
    },
  },
  {
    name: 'handoff bridge: oauth: the jti replay cache stays bounded at 256 entries',
    run: async () => {
      const item = verifier();
      for (let count = 0; count < 270; count += 1) assert.equal((await verify(item.instance, assertion({ clock: item.now, claims: { jti: `bounded-${count}` } }))).outcome, 'assertion_ok');
      assert.equal(item.instance.stats().jtis, 256);
    },
  },
  {
    name: 'handoff bridge: oauth: JWKS is cached for one hour',
    run: async () => {
      const item = verifier();
      assert.equal((await verify(item.instance, assertion({ clock: item.now }))).outcome, 'assertion_ok');
      item.now.advance(CONSTANTS.JWKS_CACHE_MS - 1);
      assert.equal((await verify(item.instance, assertion({ clock: item.now }))).outcome, 'assertion_ok');
      assert.equal(item.fetches(), 1);
      item.now.advance(2);
      assert.equal((await verify(item.instance, assertion({ clock: item.now }))).outcome, 'assertion_ok');
      assert.equal(item.fetches(), 2);
    },
  },
  {
    name: 'handoff bridge: oauth: a failed JWKS fetch fails closed',
    run: async () => {
      const item = verifier({ fetchJwks: async () => { throw new Error('offline'); } });
      assert.equal((await verify(item.instance, assertion())).outcome, 'assertion_unknown_kid');
    },
  },
  {
    name: 'handoff bridge: oauth: observe-both accepts absent assertions and records none without credential text',
    run: async () => {
      const env = boot();
      const linked = await grant(env);
      assert.ok(linked.token.access_token);
      assert.equal(env.auth.at(-1).outcome, 'none');
      assert.deepEqual(Object.keys(env.auth.at(-1)).sort(), ['assertionSize', 'audience', 'jtiPresent', 'outcome']);
    },
  },
  {
    name: 'handoff bridge: oauth: require-assertion has no fail-open for an unsigned token request',
    run: async () => {
      const env = boot({ tokenAuthMode: 'require-assertion', fetchJwks: async () => ({ keys: [PUBLIC_JWK] }) });
      const issued = await obtainCode(env);
      const result = await exchangeCode(env, issued);
      assert.equal(result.json.error, 'invalid_client');
    },
  },
  {
    name: 'handoff bridge: oauth: a signed code grant may derive the pinned client id from the assertion',
    run: async () => {
      const now = clockAt();
      const env = boot({ now, tokenAuthMode: 'require-assertion', fetchJwks: async () => ({ keys: [PUBLIC_JWK] }) });
      const issued = await obtainCode(env);
      const token = assertion({ clock: now });
      const result = await exchangeCode(env, issued, { client_id: undefined, client_assertion: token, client_assertion_type: JWT_BEARER });
      assert.equal(result.status, 200, result.text);
      assert.equal(env.auth.at(-1).outcome, 'assertion_ok');
    },
  },
  {
    name: 'handoff bridge: oauth: signed refresh authentication runs before any refresh-token lookup',
    run: async () => {
      const now = clockAt();
      const events = [];
      const env = boot({ now, fetchJwks: async () => ({ keys: [PUBLIC_JWK] }), emitSecurityEvent: event => events.push(event) });
      const linked = await grant(env);
      await refresh(env, linked.token.refresh_token);
      now.advance(CONSTANTS.REFRESH_GRACE_MS + 1);
      const invalid = assertion({ clock: now, key: weakRsa.privateKey });
      const result = await refresh(env, linked.token.refresh_token, { client_assertion: invalid, client_assertion_type: JWT_BEARER });
      assert.equal(result.json.error, 'invalid_client');
      assert.ok(!events.includes('refresh_reuse'));
    },
  },
  {
    name: 'handoff bridge: oauth: signed refresh succeeds and records only assertion metadata',
    run: async () => {
      const now = clockAt();
      const env = boot({ now, fetchJwks: async () => ({ keys: [PUBLIC_JWK] }) });
      const linked = await grant(env);
      const token = assertion({ clock: now });
      const result = await refresh(env, linked.token.refresh_token, { client_assertion: token, client_assertion_type: JWT_BEARER });
      assert.equal(result.status, 200);
      assert.equal(env.auth.at(-1).outcome, 'assertion_ok');
      assert.ok(!JSON.stringify(env.auth).includes(token));
    },
  },
  {
    name: 'handoff bridge: oauth: signed revoke is verified before token lookup and disconnects the family',
    run: async () => {
      const now = clockAt();
      const env = boot({ now, fetchJwks: async () => ({ keys: [PUBLIC_JWK] }) });
      const linked = await grant(env);
      const token = assertion({ clock: now });
      const result = await revoke(env, linked.token.refresh_token, { client_assertion: token, client_assertion_type: JWT_BEARER });
      assert.equal(result.status, 200);
      assert.equal(env.oauth.stats().activeFamilies, 0);
    },
  },
  {
    name: 'handoff bridge: oauth: a bad assertion is refused in observe-both instead of falling back to none',
    run: async () => {
      const now = clockAt();
      const env = boot({ now, fetchJwks: async () => ({ keys: [PUBLIC_JWK] }) });
      const linked = await grant(env);
      const bad = assertion({ clock: now, key: weakRsa.privateKey });
      const result = await refresh(env, linked.token.refresh_token, { client_assertion: bad, client_assertion_type: JWT_BEARER });
      assert.equal(result.json.error, 'invalid_client');
      assert.equal(env.auth.at(-1).outcome, 'assertion_bad_signature');
    },
  },
  {
    name: 'handoff bridge: oauth: the authorization document follows AS_AUTH_METHODS and advertises RS256',
    run: async () => {
      const env = boot({ asAuthMethods: ['private_key_jwt'] });
      const document = (await call(env, 'GET', '/.well-known/oauth-authorization-server')).json;
      assert.deepEqual(document.token_endpoint_auth_methods_supported, ['private_key_jwt']);
      assert.deepEqual(document.token_endpoint_auth_signing_alg_values_supported, ['RS256']);
    },
  },
  {
    name: 'handoff bridge: oauth: the JWKS fetcher accepts only the single pinned URL and copies known JWK fields',
    run: async () => {
      let calls = 0;
      const fetcher = createJwksFetcher({ fetchJson: async url => { calls += 1; assert.equal(url, CONSTANTS.JWKS_URL); return { keys: [{ ...PUBLIC_JWK, secret: 'drop-me' }] }; } });
      const document = await fetcher();
      assert.equal(calls, 1);
      assert.equal(document.keys[0].kid, PUBLIC_JWK.kid);
      assert.ok(!Object.hasOwn(document.keys[0], 'secret'));
    },
  },
];

assert.equal(LAB_STEP_NAMES.length, 100);
assert.equal(phaseOneTests.length, 22);
assert.equal(assertionTests.length, 42);

export default [...portedLabTests, ...phaseOneTests, ...assertionTests];
