// Self-test for oauth.js, the Phase 0b authorization server.
//
// Every step drives a REAL listening http server built from oauth.js plus a tiny protected /mcp route
// (401 + challengeHeader without a valid bearer, 200 with one). Only ephemeral localhost ports and a
// temp directory are used; the CIMD fetch is a local stub, so nothing here touches the network.
// The clock is injected, which is how token expiry, the refresh grace window and the absolute refresh
// lifetime are exercised in milliseconds.
import realAssert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import dns from 'node:dns'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOAuthServer, OAuthError } from './oauth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ISSUER = 'https://bridge-lab.lullascape.com'
const RESOURCE = `${ISSUER}/mcp`
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const REDIRECT_B = 'https://chatgpt.com/connector/oauth/AbC_123-xyz'
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'"
const CHALLENGE = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="handoff"`

let passed = 0
let assertions = 0
// Counts every assertion so the summary line is honest about how much was actually checked.
const assert = new Proxy(realAssert, {
  apply(target, thisArg, args) {
    assertions += 1
    return Reflect.apply(target, thisArg, args)
  },
  get(target, prop) {
    const value = target[prop]
    if (typeof value !== 'function') return value
    return (...args) => {
      assertions += 1
      return value.apply(target, args)
    }
  },
})

async function step(name, fn) {
  try {
    await fn()
  } catch (err) {
    console.error(`  ✗ ${passed + 1}. ${name}`)
    throw err
  }
  passed += 1
  console.log(`  ✓ ${passed}. ${name}`)
}

// Every token, code, secret, verifier, pairing code and transaction id the test ever sees. The last step
// proves none of them reached the captured log output.
const seen = new Set()
const allLogs = []
const note = (...values) => {
  for (const v of values) if (typeof v === 'string' && v.length >= 8) seen.add(v)
}

function makeClock(start = Date.UTC(2026, 8, 26, 12, 0, 0)) {
  let t = start
  const clock = () => t
  clock.advance = ms => {
    t += ms
  }
  return clock
}

// ---------------------------------------------------------------- harness

const envs = new Set()

async function boot({ clock = makeClock(), fetcher = null, noFetcher = false, oauth: extra = {} } = {}) {
  const consents = []
  const logs = []
  const fetchCalls = []
  const counters = { random: 0 }
  const options = {
    issuer: ISSUER,
    resourcePath: '/mcp',
    now: clock,
    log: (kind, fields) => {
      logs.push({ kind, fields })
      allLogs.push({ kind, fields })
    },
    onConsentRequested: info => {
      consents.push(info)
    },
    random: n => {
      counters.random += 1
      return crypto.randomBytes(n)
    },
    ...extra,
  }
  if (!noFetcher && !extra.clientMetadataFetch) {
    options.clientMetadataFetch = async url => {
      fetchCalls.push(url)
      if (!fetcher) throw new Error('no fetcher in this environment')
      return fetcher(url)
    }
  }
  const oauth = createOAuthServer(options)
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://local.test')
      if (await oauth.handle(req, res, pathname)) return
      if (pathname === '/mcp') {
        try {
          const info = oauth.authenticate(req)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ...info }))
        } catch (err) {
          res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': oauth.challengeHeader(err) })
          res.end('{"error":"unauthorized"}')
        }
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('passthrough')
    } catch (err) {
      // A bug in the module under test must fail the run loudly, not hide behind a 500.
      res.writeHead(599)
      res.end(String(err && err.stack))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { oauth, server, clock, consents, logs, fetchCalls, counters, base: `http://127.0.0.1:${server.address().port}` }
  env.close = async () => {
    oauth.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    envs.delete(env)
  }
  envs.add(env)
  return env
}

async function call(env, method, target, { headers = {}, body } = {}) {
  const res = await fetch(env.base + target, { method, headers, body, redirect: 'manual' })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, text, json, location: res.headers.get('location') }
}

const shaHexOf = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The debounced writer lands about 50 ms after a change; poll instead of trusting one fixed sleep.
async function eventually(check, what) {
  for (let i = 0; i < 150; i += 1) {
    if (check()) return
    await sleep(20)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
// An unsigned three-part token: the server reads the subject and never verifies the signature.
const fakeJwt = claims => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'c2ln'].join('.')
// Anything invisible or reorderable that must never survive into a page or a callback.
const INVISIBLE_TEXT = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u

const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined)).toString()
const formEncode = text => new URLSearchParams({ x: text }).toString().slice(2)
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const postForm = (env, target, obj, headers = {}) => call(env, 'POST', target, { headers: { ...FORM, ...headers }, body: form(obj) })
const postJson = (env, target, obj, headers = {}) => call(env, 'POST', target, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) })
const basic = (id, secret, encode = true) => `Basic ${Buffer.from(`${encode ? formEncode(id) : id}:${encode ? formEncode(secret) : secret}`).toString('base64')}`

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  note(verifier)
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

// The authorize page only exists while a pairing session is open on the Mac, so the helper opens one first
// unless a live code is already there (or a test wants the unarmed refusal itself).
function getAuthorize(env, params, { unarmed = false } = {}) {
  if (!unarmed && env.oauth.pendingPairings() === 0) note(env.oauth.openPairing())
  return call(env, 'GET', `/oauth/authorize?${form({ response_type: 'code', code_challenge_method: 'S256', resource: RESOURCE, ...params })}`)
}

async function register(env, body = {}) {
  const r = await postJson(env, '/oauth/register', { redirect_uris: [REDIRECT], client_name: 'Test Client', ...body })
  if (r.json && r.json.client_secret) note(r.json.client_secret)
  return r
}

async function newClient(env, body) {
  const r = await register(env, body)
  assert.equal(r.status, 201, r.text)
  return r.json
}

function txnOf(html) {
  const m = /name="txn" value="([^"]+)"/.exec(html)
  return m ? m[1] : null
}

// Opens a pairing session on the Mac (that is what returns the code the operator would read off the screen),
// then loads the consent page. `pairing` is that code.
async function startConsent(env, o) {
  const pairing = env.oauth.openPairing()
  note(pairing)
  const pk = o.pk || pkce()
  const state = o.state === undefined ? `st-${crypto.randomBytes(6).toString('hex')}` : o.state
  const page = await getAuthorize(env, {
    client_id: o.clientId, redirect_uri: o.redirectUri || REDIRECT, state, code_challenge: pk.challenge, scope: o.scope, ...(o.extra || {}),
  })
  assert.equal(page.status, 200, page.text.slice(0, 300))
  const txn = txnOf(page.text)
  assert.ok(txn, 'consent page carries a txn')
  note(txn)
  return { page, txn, pairing, pk, state }
}

const consent = (env, txn, pairing, action = 'approve') => postForm(env, '/oauth/authorize', { txn, pairing_code: pairing, action })

// Runs consent and returns the authorization code plus the redirect parameters.
async function approve(env, o) {
  const c = await startConsent(env, o)
  const r = await consent(env, c.txn, c.pairing)
  assert.equal(r.status, 302, r.text.slice(0, 300))
  const params = new URL(r.location).searchParams
  const code = params.get('code')
  assert.ok(code, 'redirect carries a code')
  note(code)
  return { ...c, code, params, redirect: r }
}

async function tokenPost(env, obj, headers) {
  const r = await postForm(env, '/oauth/token', obj, headers)
  if (r.json) note(r.json.access_token, r.json.refresh_token)
  return r
}

// Full authorization for a public client; returns the token response.
async function grant(env, clientId, o = {}) {
  const a = await approve(env, { clientId, ...o })
  const t = await tokenPost(env, {
    grant_type: 'authorization_code', code: a.code, redirect_uri: o.redirectUri || REDIRECT, code_verifier: a.pk.verifier, client_id: clientId, ...(o.tokenExtra || {}),
  }, o.tokenHeaders)
  assert.equal(t.status, 200, t.text)
  return { ...a, tokens: t.json, response: t }
}

const refresh = (env, clientId, token, extra = {}, headers) =>
  tokenPost(env, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId, ...extra }, headers)

const mcp = (env, token, viaQuery = false) => viaQuery
  ? call(env, 'GET', `/mcp?access_token=${token}`)
  : call(env, 'GET', '/mcp', { headers: token ? { authorization: `Bearer ${token}` } : {} })

function assertPage(r, status = 400) {
  assert.equal(r.status, status, r.text.slice(0, 200))
  assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8$/)
  assert.equal(r.location, null, 'an error before redirect_uri validation must never redirect')
}

function assertRedirectError(r, code, { state, base = REDIRECT } = {}) {
  assert.equal(r.status, 302, r.text.slice(0, 200))
  assert.ok(r.location.startsWith(`${base}?`), r.location)
  const p = new URL(r.location).searchParams
  assert.equal(p.get('error'), code)
  assert.equal(p.get('iss'), ISSUER)
  assert.ok(p.get('error_description'))
  if (state === null) assert.equal(p.get('state'), null)
  else if (state !== undefined) assert.equal(p.get('state'), state)
}

const assertOAuthJson = (r, status, code) => {
  assert.equal(r.status, status, r.text.slice(0, 200))
  assert.equal(r.json.error, code)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.ok(!/\bat [\w./<>]+:\d+/.test(r.text), 'no stack traces in error bodies')
}

// Fires `count` requests in small concurrent batches: a frozen clock keeps every bucket draining exactly
// as it would under one big burst, without overflowing the loopback listen backlog.
async function burst(count, make, width = 40) {
  const out = []
  for (let i = 0; i < count; i += width) {
    out.push(...await Promise.all(Array.from({ length: Math.min(width, count - i) }, () => make())))
  }
  return out
}

// The default CIMD fetcher is the one piece that would need the real network. It calls https.request and
// dns.lookup through their module objects, so a scripted stand-in lets its response handling and its
// address guard be exercised offline. `script` decides what the "server" answers per URL path.
async function withFakeHttps(script, fn) {
  const original = https.request
  const calls = []
  https.request = (url, options, callback) => {
    const request = new EventEmitter()
    const call = { url, options, destroyed: false }
    calls.push(call)
    request.destroy = err => {
      call.destroyed = true
      if (err) request.emit('error', err)
      request.emit('close')
    }
    request.end = () => setImmediate(() => script(call, request, callback))
    return request
  }
  try {
    await fn(calls)
  } finally {
    https.request = original
  }
}

function fakeResponse(statusCode, headers, chunks) {
  const res = Readable.from(chunks.map(c => Buffer.from(c)))
  res.statusCode = statusCode
  res.headers = headers
  return res
}

async function rawRequest(env, { method = 'POST', target, headers, chunks }) {
  return new Promise((resolve, reject) => {
    const req = http.request(env.base + target, { method, headers }, res => {
      let text = ''
      res.on('data', c => {
        text += c
      })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('oauth.js self-test')
  let env

  // ============================================================== discovery
  console.log('\nDiscovery documents and the protected-resource challenge')
  env = await boot()

  await step('protected-resource metadata is served at both paths', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await call(env, 'GET', p)
      assert.equal(r.status, 200)
      assert.match(r.headers.get('content-type'), /^application\/json/)
      assert.equal(r.json.resource, RESOURCE)
      assert.deepEqual(r.json.authorization_servers, [ISSUER])
      assert.deepEqual(r.json.scopes_supported, ['handoff'])
      assert.deepEqual(r.json.bearer_methods_supported, ['header'])
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.equal(r.headers.get('access-control-allow-origin'), '*')
    }
  })

  await step('the two protected-resource documents are identical and never list offline_access', async () => {
    const a = await call(env, 'GET', '/.well-known/oauth-protected-resource')
    const b = await call(env, 'GET', '/.well-known/oauth-protected-resource/mcp')
    assert.equal(a.text, b.text)
    assert.ok(!a.text.includes('offline_access'))
  })

  await step('all four authorization-server metadata paths return the SAME document', async () => {
    const paths = [
      '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration',
      '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration/mcp',
    ]
    const first = await call(env, 'GET', paths[0])
    assert.equal(first.status, 200)
    for (const p of paths.slice(1)) {
      const r = await call(env, 'GET', p)
      assert.equal(r.status, 200, p)
      assert.equal(r.text, first.text, p)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.equal(r.headers.get('access-control-allow-origin'), '*')
    }
  })

  await step('authorization-server metadata: issuer identity, endpoints and capabilities', async () => {
    const d = (await call(env, 'GET', '/.well-known/oauth-authorization-server')).json
    assert.equal(d.issuer, ISSUER)
    assert.equal(d.authorization_endpoint, `${ISSUER}/oauth/authorize`)
    assert.equal(d.token_endpoint, `${ISSUER}/oauth/token`)
    assert.equal(d.registration_endpoint, `${ISSUER}/oauth/register`)
    assert.equal(d.revocation_endpoint, `${ISSUER}/oauth/revoke`)
    assert.deepEqual(d.response_types_supported, ['code'])
    assert.deepEqual(d.grant_types_supported, ['authorization_code', 'refresh_token'])
    assert.deepEqual(d.code_challenge_methods_supported, ['S256'])
    assert.deepEqual(d.token_endpoint_auth_methods_supported, ['none', 'client_secret_basic', 'client_secret_post'])
    assert.deepEqual(d.revocation_endpoint_auth_methods_supported, d.token_endpoint_auth_methods_supported)
    assert.deepEqual(d.scopes_supported, ['handoff', 'offline_access'])
    assert.equal(d.authorization_response_iss_parameter_supported, true)
    assert.equal(d.client_id_metadata_document_supported, true)
    assert.ok(!JSON.stringify(d).includes('private_key_jwt'))
    assert.ok(!('subject_types_supported' in d), 'no OIDC claim without ID tokens')
  })

  await step('HEAD works on well-known documents; other methods get 405 with Allow', async () => {
    const head = await call(env, 'HEAD', '/.well-known/oauth-authorization-server')
    assert.equal(head.status, 200)
    assert.equal(head.text, '')
    const post = await call(env, 'POST', '/.well-known/oauth-authorization-server', { body: '{}' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET, HEAD')
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      const preflight = await call(env, 'OPTIONS', p, { headers: { 'access-control-request-method': 'GET' } })
      assert.equal(preflight.status, 204, 'a browser-based client needs its preflight answered')
      assert.equal(preflight.text, '')
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD')
    }
    assert.equal((await call(env, 'OPTIONS', '/.well-known/nope')).status, 404)
    for (const [method, target, allow] of [
      ['GET', '/oauth/token', 'POST'], ['GET', '/oauth/register', 'POST'], ['GET', '/oauth/revoke', 'POST'],
      ['PUT', '/oauth/authorize', 'GET, POST'], ['DELETE', '/oauth/token', 'POST'], ['HEAD', '/oauth/authorize', 'GET, POST'],
    ]) {
      const r = await call(env, method, target)
      assert.equal(r.status, 405, `${method} ${target}`)
      assert.equal(r.headers.get('allow'), allow)
      if (method !== 'HEAD') assert.equal(r.json.error, 'invalid_request')
    }
  })

  await step('unknown well-known and /oauth paths are clean 404 JSON, never HTML', async () => {
    for (const p of ['/.well-known/security.txt', '/.well-known/oauth-protected-resource/other', '/oauth/', '/oauth/nope', '/oauth/token/extra']) {
      const r = await call(env, 'GET', p)
      assert.equal(r.status, 404, p)
      assert.match(r.headers.get('content-type'), /^application\/json/)
      assert.equal(r.json.error, 'not_found')
      assert.ok(!r.text.includes('<'))
    }
  })

  await step('handle() leaves foreign paths alone and does not touch req or res', async () => {
    const passthrough = await call(env, 'GET', '/health')
    assert.equal(passthrough.text, 'passthrough')
    const boom = new Proxy({}, { get() { throw new Error('touched') } })
    for (const p of ['/mcp', '/oauthx', '/.well-known', '/']) assert.equal(await env.oauth.handle(boom, boom, p), false)
    assert.equal(await env.oauth.handle(boom, boom, undefined), false)
  })

  await step('the protected /mcp route answers 401 with the resource_metadata challenge', async () => {
    const none = await mcp(env, null)
    assert.equal(none.status, 401)
    assert.equal(none.headers.get('www-authenticate'), CHALLENGE)
    const junk = await mcp(env, 'not-a-real-token')
    assert.equal(junk.status, 401)
    assert.equal(junk.headers.get('www-authenticate'), `${CHALLENGE}, error="invalid_token"`)
  })

  await step('authenticate() and challengeHeader() contract', async () => {
    const check = headers => {
      try {
        env.oauth.authenticate({ headers })
      } catch (err) {
        return err
      }
      return assert.fail('expected authenticate to throw')
    }
    for (const [headers, presented] of [[{}, false], [{ authorization: 'Basic abc' }, false], [{ authorization: 'Bearer' }, true],
      [{ authorization: 'Bearer !!!' }, true], [{ authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, true]]) {
      const err = check(headers)
      assert.ok(err instanceof OAuthError)
      assert.equal(err.code, 'invalid_token')
      assert.equal(err.status, 401)
      assert.equal(err.presented, presented, JSON.stringify(headers))
    }
    assert.equal(env.oauth.challengeHeader(), CHALLENGE)
    assert.equal(env.oauth.challengeHeader('invalid_token'), `${CHALLENGE}, error="invalid_token"`)
    assert.equal(env.oauth.challengeHeader(check({})), CHALLENGE)
    assert.equal(env.oauth.challengeHeader(check({ authorization: 'Bearer !!!' })), `${CHALLENGE}, error="invalid_token"`)
    assert.equal(env.oauth.challengeHeader('x", evil="1'), CHALLENGE, 'no header injection through the error argument')
  })

  await step('option validation rejects a bad issuer and a bad resource path', async () => {
    assert.throws(() => createOAuthServer({ issuer: `${ISSUER}/`, resourcePath: '/mcp' }), TypeError)
    assert.throws(() => createOAuthServer({ issuer: ISSUER, resourcePath: 'mcp' }), TypeError)
    assert.throws(() => createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp', accessTtlSec: 0 }), TypeError)
    assert.throws(() => createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp', staticClient: { clientId: 'a', clientSecret: '', redirectUris: [] } }), TypeError)
    const shortSecret = { clientId: 'a', clientSecret: 'x'.repeat(31), redirectUris: [REDIRECT] }
    assert.throws(() => createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp', staticClient: shortSecret }), /at least 32 characters/)
    createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp', staticClient: { ...shortSecret, clientSecret: 'x'.repeat(32) } }).close()
  })
  await env.close()

  // ============================================================== registration
  console.log('\nDynamic client registration')
  env = await boot()

  await step('DCR: a public client is registered by default (201, no secret, no-store)', async () => {
    const r = await register(env)
    assert.equal(r.status, 201, r.text)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.match(r.json.client_id, /^[A-Za-z0-9_-]{20,}$/)
    assert.equal(r.json.token_endpoint_auth_method, 'none')
    assert.deepEqual(r.json.grant_types, ['authorization_code', 'refresh_token'])
    assert.deepEqual(r.json.response_types, ['code'])
    assert.deepEqual(r.json.redirect_uris, [REDIRECT])
    assert.ok(!('client_secret' in r.json))
    assert.equal(r.json.client_id_issued_at, Math.floor(env.clock() / 1000))
    assert.equal(env.oauth.stats().registrations, 1)
  })

  await step('DCR: redirect URIs must match the allowed patterns exactly', async () => {
    for (const uris of [['https://evil.example/cb'], ['https://chatgpt.com/connector_platform_oauth_redirect/'], ['https://chatgpt.com/connector_platform_oauth_redirect?x=1'],
      ['http://chatgpt.com/connector_platform_oauth_redirect'], [REDIRECT, 'https://evil.example/cb'], ['https://chatgpt.com.evil.example/connector/oauth/abc']]) {
      const r = await register(env, { redirect_uris: uris })
      assertOAuthJson(r, 400, 'invalid_redirect_uri')
    }
    for (const uris of [undefined, [], 'https://chatgpt.com/connector_platform_oauth_redirect', [REDIRECT, REDIRECT, REDIRECT, REDIRECT, REDIRECT, REDIRECT], [42]]) {
      assertOAuthJson(await register(env, { redirect_uris: uris }), 400, 'invalid_redirect_uri')
    }
    const both = await register(env, { redirect_uris: [REDIRECT, REDIRECT_B] })
    assert.equal(both.status, 201)
  })

  await step('DCR: a confidential method returns a secret once; the registered scope is echoed but never enforced; the name is sanitised', async () => {
    const r = await register(env, {
      token_endpoint_auth_method: 'client_secret_post', scope: 'email offline_access profile', client_name: `  Bad\u0000 name\u202e\n${'x'.repeat(200)}`,
    })
    assert.equal(r.status, 201, r.text)
    assert.equal(r.json.token_endpoint_auth_method, 'client_secret_post')
    assert.match(r.json.client_secret, /^[A-Za-z0-9_-]{40,}$/)
    assert.equal(r.json.client_secret_expires_at, 0)
    assert.equal(r.json.scope, 'email offline_access profile', 'RFC 7591 3.2.1: the response carries the registered metadata')
    assert.ok(!('scope' in (await register(env)).json), 'no scope in, none out')
    assert.ok(r.json.client_name.length <= 100)
    assert.ok([...r.json.client_name].every(ch => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x202e), 'no control or bidi characters survive')
    assert.ok(r.json.client_name.startsWith('Bad name'))
  })

  await step('DCR: a client name loses every invisible character (TAG characters, joiners, fillers, braille blank, lone surrogates) and stacked marks', async () => {
    env.clock.advance(60000) // the registration bucket is 30 deep; the earlier steps spent it
    // Unicode TAG characters mirror ASCII invisibly: "ABC ", then real letters, then " PREV".
    const tags = `${String.fromCodePoint(0xe0041, 0xe0042, 0xe0043, 0xe0020)}IGNORE${String.fromCodePoint(0xe0020, 0xe0050, 0xe0052, 0xe0045, 0xe0056)}`
    const hidden = String.fromCodePoint(0x34f, 0x3164, 0xffa0, 0x2800, 0x115f, 0x1160, 0xfe0f, 0xe0100, 0x1d173, 0x1d17a, 0x200b, 0x200d, 0x202e, 0xad, 0x2060, 0xfeff, 0x180e, 0x2028, 0x2029, 0x85)
    const lone = `a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdc00)}c`
    for (const [given, expected] of [
      [`Chat${tags}GPT`, 'Chat IGNORE GPT'],
      [`Chat${hidden}GPT`, 'Chat GPT'],
      [lone, 'a b c'],
      [String.fromCodePoint(0xff23, 0xff48, 0xff41, 0xff54), 'Chat'],
      [`${hidden}${String.fromCodePoint(0xe0041, 0xe0042, 0xe0020)}`, 'Unnamed client'],
    ]) {
      const r = await register(env, { client_name: given })
      assert.equal(r.status, 201, r.text)
      assert.equal(r.json.client_name, expected)
      assert.ok(!INVISIBLE_TEXT.test(r.json.client_name))
    }
    const zalgo = await register(env, { client_name: `e${'\u0301'.repeat(30)}x` })
    assert.ok([...zalgo.json.client_name].filter(ch => /\p{M}/u.test(ch)).length <= 3, 'stacked combining marks are capped')
    // The same text is what the consent page and the Mac-side callback see.
    const sneaky = await newClient(env, { client_name: `Chat${hidden}GPT` })
    const c = await startConsent(env, { clientId: sneaky.client_id })
    assert.ok(!INVISIBLE_TEXT.test(c.page.text), 'no invisible character on the page')
    assert.ok(c.page.text.includes('<p class="who">Chat GPT</p>'))
    const info = env.consents.at(-1)
    assert.equal(info.clientName, 'Chat GPT')
    assert.ok(!INVISIBLE_TEXT.test(JSON.stringify(info)))
  })

  await step('DCR: unsupported metadata, non-JSON bodies and wrong methods are refused cleanly', async () => {
    for (const body of [{ token_endpoint_auth_method: 'private_key_jwt' }, { grant_types: ['implicit'] }, { grant_types: [] },
      { grant_types: 'authorization_code' }, { response_types: ['token'] }, { client_name: 42 }]) {
      assertOAuthJson(await register(env, body), 400, 'invalid_client_metadata')
    }
    const notJson = await call(env, 'POST', '/oauth/register', { headers: FORM, body: 'redirect_uris=x' })
    assertOAuthJson(notJson, 400, 'invalid_client_metadata')
    const broken = await call(env, 'POST', '/oauth/register', { headers: { 'content-type': 'application/json' }, body: '{' })
    assertOAuthJson(broken, 400, 'invalid_request')
    const grantsOnly = await register(env, { grant_types: ['authorization_code'] })
    assert.deepEqual(grantsOnly.json.grant_types, ['authorization_code'])
  })
  await env.close()

  // ============================================================== authorize
  console.log('\nAuthorization endpoint: consent page, negative cases and the DCR flow')
  env = await boot()
  const dcr = await newClient(env, { redirect_uris: [REDIRECT, REDIRECT_B], client_name: 'Evil <script>alert(1)</script> "q" & co' })

  await step('the consent page: says only what was verified, shows the full return address, pairing input, hardened headers, everything escaped', async () => {
    const c = await startConsent(env, { clientId: dcr.client_id, scope: 'openid email profile' })
    const h = c.page.headers
    assert.equal(h.get('content-security-policy'), CSP)
    assert.equal(h.get('x-frame-options'), 'DENY')
    assert.equal(h.get('cache-control'), 'no-store')
    assert.equal(h.get('referrer-policy'), 'no-referrer')
    assert.equal(h.get('cross-origin-opener-policy'), null)
    assert.equal(h.get('content-type'), 'text/html; charset=utf-8')
    const html = c.page.text
    assert.ok(html.includes('An unverified client is asking to read and answer job-application handoffs on this Mac'))
    assert.ok(!html.includes('ChatGPT'), 'a page never names a product on the strength of a client-chosen name')
    assert.ok(html.includes(`Returns to <span class="uri">${REDIRECT}</span>`), 'the full return address, so the operator sees which callback')
    assert.ok(html.includes('name="pairing_code"'))
    assert.ok(html.includes('name="action" value="approve"') && html.includes('name="action" value="deny"'))
    assert.ok(html.includes('name="txn" value="'))
    assert.ok(!html.includes('<script>'), 'a reflected client name must not become markup')
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(!html.includes(c.pairing), 'the pairing code is never on the page itself')
    assert.match(c.pairing, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    assert.deepEqual(env.consents.at(-1), { clientId: dcr.client_id, clientName: dcr.client_name, clientKind: 'dcr', redirectOrigin: 'https://chatgpt.com' })
    const other = await startConsent(env, { clientId: dcr.client_id, redirectUri: REDIRECT_B })
    assert.ok(other.page.text.includes(`<span class="uri">${REDIRECT_B}</span>`), 'the connector callback id is visible')
    const lookalike = await newClient(env, { client_name: 'ChatGPT' })
    const l = await startConsent(env, { clientId: lookalike.client_id })
    assert.ok(l.page.text.includes('An unverified client is asking'), 'a dynamically registered client named ChatGPT is still unverified')
  })

  await step('authorize is armed-only: with no pairing session open it is a 403 page that creates nothing, fetches nothing and tells the Mac nothing', async () => {
    const cold = await boot({ fetcher: () => ({}) })
    const reg = await newClient(cold, { redirect_uris: [REDIRECT] })
    const pk = pkce()
    const dcrGet = { client_id: reg.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pk.challenge }
    const cimdGet = { client_id: 'https://chatgpt.com/oauth/clients/any.json', redirect_uri: REDIRECT, state: 's', code_challenge: pk.challenge }
    const flood = await burst(300, () => getAuthorize(cold, dcrGet, { unarmed: true }))
    for (const r of flood) assertPage(r, 403)
    assertPage(await getAuthorize(cold, cimdGet, { unarmed: true }), 403)
    assert.equal(cold.consents.length, 0, 'the Mac is never told')
    assert.equal(cold.fetchCalls.length, 0, 'no outbound metadata fetch for an unarmed request')
    let s = cold.oauth.stats()
    assert.deepEqual([s.pendingTransactions, s.authorizations, s.pairings, s.rateLimited], [0, 0, 0, 0])
    assert.equal(s.unarmedAuthorize, 301)
    assert.equal(cold.logs.filter(l => l.kind === 'authorize_unarmed').length, 1, 'logged once, not once per request')
    cold.clock.advance(61000)
    assertPage(await getAuthorize(cold, dcrGet, { unarmed: true }), 403)
    assert.equal(cold.logs.filter(l => l.kind === 'authorize_unarmed').length, 2)
    // Unarmed traffic never spent the bucket the operator needs once a session is open.
    const code = cold.oauth.openPairing()
    note(code)
    const armed = await getAuthorize(cold, dcrGet, { unarmed: true })
    assert.equal(armed.status, 200)
    assert.equal(cold.consents.length, 1)
    // Approving uses the code up: the session is over, and the next request is refused again.
    assert.equal((await consent(cold, txnOf(armed.text), code)).status, 302)
    assertPage(await getAuthorize(cold, dcrGet, { unarmed: true }), 403)
    // A session that nobody uses closes on its own after ten minutes.
    note(cold.oauth.openPairing())
    assert.equal((await getAuthorize(cold, dcrGet, { unarmed: true })).status, 200)
    cold.clock.advance(10 * 60 * 1000 + 1000)
    assertPage(await getAuthorize(cold, dcrGet, { unarmed: true }), 403)
    s = cold.oauth.stats()
    assert.equal(s.pairings, 0)
    await cold.close()
  })

  await step('a consent callback that throws cannot break the page or the transaction', async () => {
    const shaky = await boot({ oauth: { onConsentRequested: () => { throw new Error('boom') } } })
    const reg = await newClient(shaky, { redirect_uris: [REDIRECT] })
    const c = await startConsent(shaky, { clientId: reg.client_id })
    assert.equal((await consent(shaky, c.txn, c.pairing)).status, 302)
    assert.ok(shaky.logs.some(l => l.kind === 'consent_callback_failed' && l.fields.error === 'Error'))
    await shaky.close()
  })

  await step('an unregistered redirect_uri is an HTML error and NEVER a redirect', async () => {
    const pk = pkce()
    for (const uri of ['https://evil.example/cb', REDIRECT_B.replace('AbC', 'zzz') + '/x', 'javascript:alert(1)', '']) {
      const r = await getAuthorize(env, { client_id: dcr.client_id, redirect_uri: uri, state: 's', code_challenge: pk.challenge })
      assertPage(r)
    }
    const onlyOne = await newClient(env, { redirect_uris: [REDIRECT] })
    assertPage(await getAuthorize(env, { client_id: onlyOne.client_id, redirect_uri: REDIRECT_B, state: 's', code_challenge: pk.challenge }))
  })

  await step('an unknown, missing or repeated client_id / redirect_uri is an HTML error, not a redirect', async () => {
    const pk = pkce()
    assertPage(await getAuthorize(env, { client_id: 'nope-nope-nope', redirect_uri: REDIRECT, code_challenge: pk.challenge }))
    assertPage(await getAuthorize(env, { client_id: undefined, redirect_uri: REDIRECT, code_challenge: pk.challenge }))
    assertPage(await getAuthorize(env, { client_id: dcr.client_id, redirect_uri: undefined, code_challenge: pk.challenge }))
    const dup = await call(env, 'GET', `/oauth/authorize?${form({ client_id: dcr.client_id, redirect_uri: REDIRECT, code_challenge: pk.challenge })}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`)
    assertPage(dup)
    assertPage(await call(env, 'GET', '/oauth/authorize?client_id=%zz&redirect_uri=x'))
  })

  await step('PKCE is mandatory and S256-only: missing, plain, absent method and malformed challenges are refused', async () => {
    const pk = pkce()
    const base = { client_id: dcr.client_id, redirect_uri: REDIRECT, state: 'keep-me' }
    assertRedirectError(await getAuthorize(env, { ...base, code_challenge: undefined }), 'invalid_request', { state: 'keep-me' })
    assertRedirectError(await getAuthorize(env, { ...base, code_challenge: pk.challenge, code_challenge_method: 'plain' }), 'invalid_request', { state: 'keep-me' })
    assertRedirectError(await getAuthorize(env, { ...base, code_challenge: pk.challenge, code_challenge_method: undefined }), 'invalid_request', { state: 'keep-me' })
    assertRedirectError(await getAuthorize(env, { ...base, code_challenge: pk.challenge.slice(0, 42) }), 'invalid_request', { state: 'keep-me' })
    assertRedirectError(await getAuthorize(env, { ...base, code_challenge: `${pk.challenge.slice(0, 42)}!` }), 'invalid_request', { state: 'keep-me' })
  })

  await step('resource binding: a missing, different or ambiguous resource is invalid_target; only host case, a default port and one trailing slash are tolerated', async () => {
    const pk = pkce()
    const base = { client_id: dcr.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pk.challenge }
    for (const resource of [undefined, 'https://bridge-lab.lullascape.com/other', 'https://evil.example/mcp', RESOURCE.toUpperCase(), `${RESOURCE}/x`, `${RESOURCE}//`,
      `${RESOURCE}?x=1`, `${RESOURCE}#f`, 'https://user@bridge-lab.lullascape.com/mcp', 'https://bridge-lab.lullascape.com:8443/mcp', 'http://bridge-lab.lullascape.com/mcp',
      ISSUER, `${ISSUER}/`, 'bridge-lab.lullascape.com/mcp', 'https://bridge-lab.lullascape.com.evil.example/mcp']) {
      assertRedirectError(await getAuthorize(env, { ...base, resource }), 'invalid_target', { state: 's' })
    }
    for (const resource of [`${RESOURCE}/`, 'https://BRIDGE-LAB.lullascape.com/mcp', 'https://bridge-lab.lullascape.com:443/mcp']) {
      const r = await getAuthorize(env, { ...base, resource })
      assert.equal(r.status, 200, resource)
    }
    // RFC 8707 allows the parameter to repeat: the same value twice is one value, different values are ambiguous.
    const query = `${form({ response_type: 'code', code_challenge_method: 'S256', ...base, resource: RESOURCE })}`
    env.oauth.openPairing()
    assert.equal((await call(env, 'GET', `/oauth/authorize?${query}&resource=${encodeURIComponent(RESOURCE)}`)).status, 200)
    assertRedirectError(await call(env, 'GET', `/oauth/authorize?${query}&resource=${encodeURIComponent('https://evil.example/mcp')}`), 'invalid_target', { state: 's' })
    assertRedirectError(await call(env, 'GET', `/oauth/authorize?${query}&state=again`), 'invalid_request', { state: null })
  })

  await step('response_type, repeated parameters and malformed scope errors redirect with state and iss', async () => {
    const pk = pkce()
    const base = { client_id: dcr.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pk.challenge }
    assertRedirectError(await getAuthorize(env, { ...base, response_type: 'token' }), 'unsupported_response_type', { state: 's' })
    assertRedirectError(await getAuthorize(env, { ...base, response_type: undefined }), 'unsupported_response_type', { state: 's' })
    const dup = await call(env, 'GET', `/oauth/authorize?${form(base)}&response_type=code&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}&state=again`)
    assertRedirectError(dup, 'invalid_request', { state: null })
    assertRedirectError(await getAuthorize(env, { ...base, scope: Array.from({ length: 25 }, (_, i) => `s${i}`).join(' ') }), 'invalid_scope', { state: 's' })
    assertRedirectError(await getAuthorize(env, { ...base, scope: 'ok "bad"' }), 'invalid_scope', { state: 's' })
  })

  await step('state: over 4096 characters is refused (and not echoed); 4096 with awkward characters is echoed exactly', async () => {
    const pk = pkce()
    const base = { client_id: dcr.client_id, redirect_uri: REDIRECT, code_challenge: pk.challenge }
    assertRedirectError(await getAuthorize(env, { ...base, state: 'a'.repeat(4097) }), 'invalid_request', { state: null })
    const awkward = ('a+b c%20d/\u00e9\u20ac\u{1f600}?&=#;,:@!*\'()' + crypto.randomBytes(4000).toString('base64url')).slice(0, 4096)
    assert.equal(awkward.length, 4096)
    const a = await approve(env, { clientId: dcr.client_id, state: awkward })
    assert.equal(a.params.get('state'), awkward)
    const rawState = a.redirect.location.split('&').find(part => part.startsWith('state='))
    assert.equal(rawState, `state=${encodeURIComponent(awkward)}`, 'only URL-encoding is applied')
    assert.equal(a.params.get('iss'), ISSUER)
  })

  await step('unknown scopes (openid, email, profile), an empty scope and no scope at all are all accepted', async () => {
    for (const scope of ['openid email profile', 'offline_access', '', undefined, 'totally-unknown']) {
      const c = await startConsent(env, { clientId: dcr.client_id, scope })
      assert.ok(c.pairing)
    }
  })

  let flow
  await step('full flow with a DCR public client: consent, code, PKCE exchange, working bearer token', async () => {
    flow = await grant(env, dcr.client_id, { state: 'flow-state', scope: 'openid email profile offline_access' })
    assert.equal(flow.params.get('state'), 'flow-state')
    assert.equal(flow.params.get('iss'), ISSUER)
    assert.match(flow.code, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(flow.redirect.headers.get('cache-control'), 'no-store')
    assert.equal(flow.redirect.headers.get('referrer-policy'), 'no-referrer')
    const t = flow.tokens
    assert.deepEqual(Object.keys(t).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type'])
    assert.equal(t.token_type, 'Bearer')
    assert.equal(t.expires_in, 300)
    assert.equal(t.scope, 'handoff offline_access')
    assert.notEqual(t.access_token, t.refresh_token)
    assert.equal(flow.response.headers.get('cache-control'), 'no-store')
    assert.equal(flow.response.headers.get('pragma'), 'no-cache')
    const ok = await mcp(env, t.access_token)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.clientId, dcr.client_id)
    assert.equal(ok.json.scope, 'handoff offline_access')
    assert.equal(ok.json.resource, RESOURCE)
    assert.equal(ok.json.expiresAt, env.clock() + 300000)
    assert.deepEqual(Object.keys(ok.json).sort(), ['clientId', 'expiresAt', 'ok', 'resource', 'scope'])
  })

  await step('the bearer token is accepted only in the Authorization header, never in a query string', async () => {
    assert.equal((await mcp(env, flow.tokens.access_token, true)).status, 401)
    assert.equal((await call(env, 'GET', '/mcp', { headers: { authorization: `bearer ${flow.tokens.access_token}` } })).status, 200)
    assert.equal((await call(env, 'GET', '/mcp', { headers: { authorization: `Bearer  ${flow.tokens.access_token}` } })).status, 200, 'RFC 6750 allows 1*SP')
    assert.equal((await call(env, 'GET', '/mcp', { headers: { authorization: `Bearer ${flow.tokens.access_token}x` } })).status, 401)
  })

  await step('the injected random source and the statistics counters are wired through', async () => {
    assert.ok(env.counters.random > 10)
    const s = env.oauth.stats()
    assert.equal(s.registrations, 3)
    assert.ok(s.authorizations >= 3 && s.codesIssued >= 2 && s.tokensIssued >= 1)
    assert.deepEqual(s.config, { accessTtlSec: 300, refreshTtlSec: 7 * 24 * 3600, refreshGraceSec: 120 }, 'a run can say which lifetimes it measured')
    const started = env.logs.filter(l => l.kind === 'server_started')
    assert.deepEqual(started.map(l => l.fields), [{ accessTtlSec: 300, refreshTtlSec: 604800, refreshGraceSec: 120, persistent: false }])
    assert.equal(typeof s.unarmedAuthorize, 'number')
    assert.equal(typeof s.replaysWithinGrace, 'number')
    assert.equal(typeof s.reuseRevocations, 'number')
    assert.equal(typeof s.revocations, 'number')
    assert.equal(typeof s.consentDenied, 'number')
    assert.equal(typeof s.lockouts, 'number')
  })
  await env.close()

  // ============================================================== CIMD
  console.log('\nClient ID metadata documents (CIMD)')
  const GOOD = 'https://chatgpt.com/oauth/clients/good.json'
  // ChatGPT's real client document, byte for byte as https://chatgpt.com/oauth/client.json served it on 2026-09-26.
  // It names private_key_jwt in the singular and lists ["none","private_key_jwt"] in the plural.
  const CHATGPT_ID = 'https://chatgpt.com/oauth/client.json'
  const CHATGPT_DOC = JSON.parse('{"client_id":"https://chatgpt.com/oauth/client.json","client_uri":"https://chatgpt.com/","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"ChatGPT","logo_uri":"https://persistent.oaistatic.com/sonic/misc/openai-logo.png","token_endpoint_auth_signing_alg":"RS256","jwks_uri":"https://chatgpt.com/oauth/jwks.json"}')
  const cimdDoc = (name, extra) => [`https://chatgpt.com/oauth/clients/${name}.json`, { client_id: `https://chatgpt.com/oauth/clients/${name}.json`, redirect_uris: [REDIRECT], ...extra }]
  const docs = new Map([
    [CHATGPT_ID, CHATGPT_DOC],
    cimdDoc('plural-no-none', { token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
    cimdDoc('plural-junk', { token_endpoint_auth_methods_supported: 'none' }),
    cimdDoc('plural-only', { token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'] }),
    cimdDoc('has-secret', { token_endpoint_auth_method: 'none', client_secret: 'must-not-be-here' }),
    cimdDoc('has-secret-expiry', { client_secret_expires_at: 0 }),
    [GOOD, { client_id: GOOD, client_name: 'ChatGPT via CIMD', redirect_uris: [REDIRECT, REDIRECT_B], token_endpoint_auth_method: 'none' }],
    ['https://chatgpt.com/oauth/clients/mismatch.json', { client_id: 'https://chatgpt.com/oauth/clients/other.json', redirect_uris: [REDIRECT] }],
    ['https://chatgpt.com/oauth/clients/unlisted.json', { client_id: 'https://chatgpt.com/oauth/clients/unlisted.json', redirect_uris: [REDIRECT_B] }],
    ['https://chatgpt.com/oauth/clients/pattern.json', { client_id: 'https://chatgpt.com/oauth/clients/pattern.json', redirect_uris: ['https://evil.example/cb'] }],
    ['https://chatgpt.com/oauth/clients/secret.json', { client_id: 'https://chatgpt.com/oauth/clients/secret.json', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }],
    ['https://chatgpt.com/oauth/clients/array.json', ['not', 'an', 'object']],
    ['https://chatgpt.com/oauth/clients/nouris.json', { client_id: 'https://chatgpt.com/oauth/clients/nouris.json' }],
    ['https://evil.example/client.json', { client_id: 'https://evil.example/client.json', redirect_uris: [REDIRECT] }],
  ])
  env = await boot({ fetcher: url => {
    if (!docs.has(url)) throw new Error('not found')
    return docs.get(url)
  } })

  await step('CIMD: full flow through the injected fetcher, token exchange as a public client', async () => {
    const g = await grant(env, GOOD, { state: 'cimd-state', scope: 'openid' })
    assert.deepEqual(env.fetchCalls, [GOOD])
    assert.equal(g.params.get('state'), 'cimd-state')
    assert.ok(g.page.text.includes('ChatGPT via CIMD'))
    assert.ok(g.page.text.includes('chatgpt.com is asking to read and answer job-application handoffs on this Mac'), 'the host is verified by the fetch, so the page may name it')
    assert.ok(!g.page.text.includes('unverified'))
    assert.equal(env.consents.at(-1).clientKind, 'cimd')
    const ok = await mcp(env, g.tokens.access_token)
    assert.equal(ok.json.clientId, GOOD)
    const r = await refresh(env, GOOD, g.tokens.refresh_token)
    assert.equal(r.status, 200)
    assert.equal(env.oauth.stats().clients, 1)
  })

  await step('CIMD: a second redirect_uri listed in the document works too', async () => {
    const c = await startConsent(env, { clientId: GOOD, redirectUri: REDIRECT_B })
    const r = await consent(env, c.txn, c.pairing)
    assert.equal(r.status, 302)
    assert.ok(r.location.startsWith(`${REDIRECT_B}?`))
  })

  await step("CIMD: ChatGPT's real document is accepted; a token request may name the client only by its assertion, and that assertion is never trusted as authentication", async () => {
    const g = await grant(env, CHATGPT_ID, { state: 'real', scope: 'openid' })
    assert.ok(g.page.text.includes('chatgpt.com is asking'))
    assert.equal(env.consents.at(-1).clientName, 'ChatGPT')
    // private_key_jwt style: client_assertion and NO client_id anywhere.
    const assertion = fakeJwt({ iss: CHATGPT_ID, sub: CHATGPT_ID, aud: ISSUER, jti: 'j1' })
    const a = await approve(env, { clientId: CHATGPT_ID })
    const t = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_assertion_type: JWT_BEARER, client_assertion: assertion })
    assert.equal(t.status, 200, t.text)
    const r = await tokenPost(env, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token, client_assertion_type: JWT_BEARER, client_assertion: fakeJwt({ iss: CHATGPT_ID }) })
    assert.equal(r.status, 200, 'iss is used when sub is absent')
    const ignored = env.logs.filter(l => l.kind === 'client_assertion_ignored')
    assert.ok(ignored.length >= 2 && ignored.every(l => l.fields.client === CHATGPT_ID), 'Phase 0b can see that an assertion was sent and not verified')
    // Anything that does not name a known public client is refused, and it never authenticates a confidential one.
    const b = await approve(env, { clientId: CHATGPT_ID })
    const body = { grant_type: 'authorization_code', code: b.code, redirect_uri: REDIRECT, code_verifier: b.pk.verifier }
    assertOAuthJson(await tokenPost(env, { ...body, client_assertion_type: JWT_BEARER, client_assertion: fakeJwt({ sub: 'https://chatgpt.com/oauth/clients/other.json' }) }), 400, 'invalid_client')
    assertOAuthJson(await tokenPost(env, { ...body, client_assertion_type: JWT_BEARER, client_assertion: 'not.a-jwt' }), 400, 'invalid_request')
    assertOAuthJson(await tokenPost(env, { ...body, client_assertion_type: JWT_BEARER, client_assertion: fakeJwt({ sub: 42 }) }), 400, 'invalid_request')
    assertOAuthJson(await tokenPost(env, { ...body, client_assertion_type: 'urn:example:other', client_assertion: assertion }), 400, 'invalid_request')
    assertOAuthJson(await tokenPost(env, { ...body, client_assertion: assertion }), 400, 'invalid_request')
    const conf = await newClient(env, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' })
    const c = await approve(env, { clientId: conf.client_id })
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: c.pk.verifier, client_assertion_type: JWT_BEARER, client_assertion: fakeJwt({ sub: conf.client_id }) }), 400, 'invalid_client')
    assert.equal((await tokenPost(env, body)).status, 400, 'no client at all')
    assert.equal((await tokenPost(env, { ...body, client_id: CHATGPT_ID })).status, 200, 'and the code survived every refusal above')
  })

  await step('CIMD: the plural auth-method list is authoritative; a document carrying a client secret is refused', async () => {
    const ask = id => getAuthorize(env, { client_id: `https://chatgpt.com/oauth/clients/${id}.json`, redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    assert.equal((await ask('plural-only')).status, 200, 'none is listed among several')
    for (const id of ['plural-no-none', 'plural-junk', 'has-secret', 'has-secret-expiry']) assertPage(await ask(id))
    const reasons = env.logs.filter(l => l.kind === 'cimd_failed').slice(-4).map(l => l.fields.reason)
    assert.deepEqual(reasons, ['auth_method', 'auth_method', 'has_secret', 'has_secret'])
  })

  await step('CIMD: a document whose client_id differs from the URL is an HTML error', async () => {
    assertPage(await getAuthorize(env, { client_id: 'https://chatgpt.com/oauth/clients/mismatch.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
  })

  await step('CIMD: a redirect_uri missing from the document, or outside the allowed patterns, never redirects', async () => {
    assertPage(await getAuthorize(env, { client_id: 'https://chatgpt.com/oauth/clients/unlisted.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    assertPage(await getAuthorize(env, { client_id: 'https://chatgpt.com/oauth/clients/pattern.json', redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge }))
  })

  await step('CIMD: secret auth methods, malformed documents and fetch failures are HTML errors (never 5xx)', async () => {
    for (const name of ['secret', 'array', 'nouris', 'missing']) {
      assertPage(await getAuthorize(env, { client_id: `https://chatgpt.com/oauth/clients/${name}.json`, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    }
  })

  await step('CIMD: hosts outside the allowlist, plain http, IP literals, credentials and odd forms are refused BEFORE any fetch', async () => {
    const before = env.fetchCalls.length
    for (const id of ['https://evil.example/client.json', 'http://chatgpt.com/oauth/clients/good.json', 'https://127.0.0.1/client.json',
      'https://[::1]/client.json', 'https://user:pw@chatgpt.com/oauth/clients/good.json', 'https://chatgpt.com:8443/oauth/clients/good.json',
      'https://CHATGPT.com/oauth/clients/good.json', 'https://chatgpt.com/', 'https://chatgpt.com/oauth/clients/good.json#frag',
      'https://chatgpt.com.evil.example/x.json', 'ftp://chatgpt.com/x.json']) {
      assertPage(await getAuthorize(env, { client_id: id, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    }
    assert.equal(env.fetchCalls.length, before, 'the fetcher must not have been called for a refused id')
  })

  await step('CIMD: the default fetcher refuses a host that resolves to a private address (no connection is made)', async () => {
    const local = await boot({ noFetcher: true, oauth: { cimdAllowedHosts: ['localhost'] } })
    const r = await getAuthorize(local, { client_id: 'https://localhost/client.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    assertPage(r)
    assert.ok(local.logs.some(l => l.kind === 'cimd_failed' && l.fields.reason === 'fetch'))
    const notAllowed = await getAuthorize(local, { client_id: 'https://chatgpt.com/x.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    assertPage(notAllowed)
    assert.ok(local.logs.some(l => l.kind === 'cimd_failed' && l.fields.reason === 'host'))
    await local.close()
  })

  await step('CIMD: the default fetcher enforces no redirects, JSON only, a 16 KB cap and a timeout (scripted https)', async () => {
    const good = url => JSON.stringify({ client_id: url.href, client_name: 'Fetched Client', redirect_uris: [REDIRECT] })
    const json = { 'content-type': 'application/json; charset=utf-8' }
    const script = (call, request, respond) => {
      const url = call.url
      switch (url.pathname) {
        case '/cimd/ok.json': return respond(fakeResponse(200, json, [good(url)]))
        case '/cimd/redirect.json': return respond(fakeResponse(302, { location: 'https://evil.example/x.json' }, ['']))
        case '/cimd/html.json': return respond(fakeResponse(200, { 'content-type': 'text/html' }, ['<html>']))
        case '/cimd/big.json': return respond(fakeResponse(200, json, ['{"a":"', 'x'.repeat(20000), '"}']))
        case '/cimd/badjson.json': return respond(fakeResponse(200, json, ['{nope']))
        case '/cimd/timeout.json': return request.emit('timeout')
        case '/cimd/error.json': return request.emit('error', new Error('connection refused'))
        default: return respond(fakeResponse(404, json, ['{}']))
      }
    }
    const real = await boot({ noFetcher: true })
    await withFakeHttps(script, async calls => {
      const ok = await getAuthorize(real, { client_id: 'https://chatgpt.com/cimd/ok.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
      assert.equal(ok.status, 200, ok.text.slice(0, 200))
      assert.ok(ok.text.includes('Fetched Client'))
      const call = calls[0]
      assert.equal(call.url.href, 'https://chatgpt.com/cimd/ok.json')
      assert.equal(call.options.method, 'GET')
      assert.equal(call.options.agent, false, 'no shared keep-alive agent')
      assert.equal(call.options.headers.accept, 'application/json')
      assert.equal(call.options.headers['user-agent'], 'infinite-canvas-oauth/1', 'an edge bot rule may refuse a header-less request')
      assert.equal(typeof call.options.lookup, 'function', 'the socket resolves through the address guard')
      assert.ok(call.options.timeout <= 3000)
      for (const name of ['redirect', 'html', 'big', 'badjson', 'timeout', 'error', 'missing']) {
        const r = await getAuthorize(real, { client_id: `https://chatgpt.com/cimd/${name}.json`, redirect_uri: REDIRECT, code_challenge: pkce().challenge })
        assertPage(r)
      }
      const big = calls.find(c => c.url.pathname === '/cimd/big.json')
      assert.equal(big.destroyed, true, 'an oversized body aborts the connection')
      assert.equal(calls.find(c => c.url.pathname === '/cimd/timeout.json').destroyed, true)
      assert.equal(real.logs.filter(l => l.kind === 'cimd_failed' && l.fields.reason === 'fetch').length, 7)
    })
    await real.close()
  })

  await step('CIMD: the fetcher\'s DNS guard rejects every non-public address, including mixed answers and every IPv4-embedding IPv6 form', async () => {
    const real = await boot({ noFetcher: true })
    let lookup = null
    await withFakeHttps((call, request, respond) => respond(fakeResponse(404, {}, [''])), async calls => {
      await getAuthorize(real, { client_id: 'https://chatgpt.com/cimd/lookup.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
      lookup = calls[0].options.lookup
    })
    assert.equal(typeof lookup, 'function')
    const original = dns.lookup
    const attempt = (list, all = true) => new Promise(resolve => {
      dns.lookup = (host, options, cb) => {
        if (options && options.all) cb(null, list.map(([address, family]) => ({ address, family })))
        else cb(null, list[0][0], list[0][1])
      }
      lookup('chatgpt.com', { all }, (err, address) => resolve({ err, address }))
    })
    try {
      for (const [ip, family] of [['93.184.216.34', 4], ['8.8.8.8', 4], ['172.32.0.1', 4], ['2606:4700::1111', 6], ['2606:4700:4700::1111', 6], ['2001:4860:4860::8888', 6], ['::ffff:8.8.8.8', 6]]) {
        const r = await attempt([[ip, family]])
        assert.equal(r.err, null, `${ip} is public`)
        const single = await attempt([[ip, family]], false)
        assert.equal(single.err, null)
        assert.equal(single.address, ip)
      }
      for (const [ip, family] of [['127.0.0.1', 4], ['10.0.0.5', 4], ['172.16.0.1', 4], ['172.31.255.255', 4], ['192.168.1.1', 4], ['169.254.169.254', 4],
        ['100.64.0.1', 4], ['0.0.0.0', 4], ['224.0.0.1', 4], ['255.255.255.255', 4], ['::1', 6], ['::', 6], ['fd00::1', 6], ['fe80::1', 6],
        ['::ffff:10.0.0.1', 6], ['::ffff:127.0.0.1', 6], ['64:ff9b::a00:1', 6],
        // Forms that embed or translate to an IPv4 address, plus the reserved IPv6 blocks.
        ['::ffff:0:7f00:1', 6], ['64:ff9b:1::7f00:1', 6], ['2002:7f00:1::', 6], ['2002:a9fe:a9fe::1', 6], ['2001:0:4136:e378:8000:63bf:80ff:fefe', 6],
        ['::7f00:1', 6], ['::127.0.0.1', 6], ['fec0::1', 6], ['3fff::1', 6], ['5f00::1', 6], ['2001:db8::1', 6], ['100::1', 6]]) {
        const r = await attempt([[ip, family]])
        assert.ok(r.err instanceof Error, `${ip} must be refused`)
        assert.equal((await attempt([[ip, family]], false)).err instanceof Error, true)
      }
      assert.ok((await attempt([['93.184.216.34', 4], ['10.0.0.5', 4]])).err instanceof Error, 'one private answer poisons the whole set')
      assert.ok((await attempt([])).err instanceof Error, 'an empty answer is refused')
      dns.lookup = (host, options, cb) => cb(new Error('ENOTFOUND'))
      const failed = await new Promise(resolve => lookup('chatgpt.com', {}, err => resolve(err)))
      assert.equal(failed.message, 'ENOTFOUND')
    } finally {
      dns.lookup = original
    }
    await real.close()
  })

  await step('CIMD: concurrent lookups are capped so an anonymous caller cannot fan out fetches', async () => {
    const slow = await boot({ fetcher: () => new Promise(resolve => setTimeout(() => resolve({ client_id: 'x', redirect_uris: [] }), 150)) })
    const ids = Array.from({ length: 8 }, (_, i) => `https://chatgpt.com/oauth/clients/slow${i}.json`)
    const results = await Promise.all(ids.map(id => getAuthorize(slow, { client_id: id, redirect_uri: REDIRECT, code_challenge: pkce().challenge })))
    assert.equal(results.filter(r => r.status === 429).length, 4)
    assert.equal(results.filter(r => r.status === 400).length, 4)
    await slow.close()
  })
  await env.close()

  // ============================================================== static client
  console.log('\nPre-registered client with client_secret_basic')
  const STATIC_SECRET = 'p@ss:w+rd%41 x/y ~!*()\'" Zq9-Lm3_Rt7'
  note(STATIC_SECRET)
  env = await boot({ oauth: { staticClient: { clientId: 'lab-static', clientSecret: STATIC_SECRET, redirectUris: [REDIRECT] } } })

  await step('static client: authorization_code with RFC 6749 form-encoded Basic credentials', async () => {
    const a = await approve(env, { clientId: 'lab-static', state: 'static' })
    const t = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: basic('lab-static', STATIC_SECRET) })
    assert.equal(t.status, 200, t.text)
    assert.equal((await mcp(env, t.json.access_token)).json.clientId, 'lab-static')
    const r = await tokenPost(env, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token }, { authorization: basic('lab-static', STATIC_SECRET) })
    assert.equal(r.status, 200, r.text)
  })

  await step('static client: literal (unencoded) Basic credentials and a matching body client_id also work', async () => {
    const a = await approve(env, { clientId: 'lab-static' })
    const t = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: 'lab-static' }, { authorization: basic('lab-static', STATIC_SECRET, false) })
    assert.equal(t.status, 200, t.text)
  })

  await step('static client: a wrong Basic secret is 401 with WWW-Authenticate: Basic; the secret is compared, not echoed', async () => {
    const a = await approve(env, { clientId: 'lab-static' })
    const t = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: basic('lab-static', `${STATIC_SECRET}x`) })
    assertOAuthJson(t, 401, 'invalid_client')
    assert.match(t.headers.get('www-authenticate'), /^Basic /)
    const unknown = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: basic('nobody', 'x') })
    assertOAuthJson(unknown, 401, 'invalid_client')
    const malformed = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: 'Basic !!!' })
    assertOAuthJson(malformed, 401, 'invalid_client')
    const ok = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: basic('lab-static', STATIC_SECRET) })
    assert.equal(ok.status, 200, 'the code survived the failed client authentications')
  })

  await step('static client: client_secret_post works; a wrong post secret is a plain 400 without a Basic challenge', async () => {
    const a = await approve(env, { clientId: 'lab-static' })
    const bad = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: 'lab-static', client_secret: 'wrong' })
    assertOAuthJson(bad, 400, 'invalid_client')
    assert.equal(bad.headers.get('www-authenticate'), null)
    const ok = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: 'lab-static', client_secret: STATIC_SECRET })
    assert.equal(ok.status, 200, ok.text)
  })

  await step('static client: two authentication methods at once, or a mismatching client_id, is invalid_request', async () => {
    const a = await approve(env, { clientId: 'lab-static' })
    const both = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_secret: STATIC_SECRET }, { authorization: basic('lab-static', STATIC_SECRET) })
    assertOAuthJson(both, 400, 'invalid_request')
    const mismatch = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: 'other' }, { authorization: basic('lab-static', STATIC_SECRET) })
    assertOAuthJson(mismatch, 400, 'invalid_request')
  })

  await step('static client: only its configured redirect URIs are accepted, and it needs no allowlist pattern', async () => {
    assertPage(await getAuthorize(env, { client_id: 'lab-static', redirect_uri: REDIRECT_B, code_challenge: pkce().challenge }))
    const ok = await getAuthorize(env, { client_id: 'lab-static', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    assert.equal(ok.status, 200)
    assert.ok(ok.text.includes('A pre-registered client is asking to read and answer job-application handoffs on this Mac'))
    assert.equal(env.consents.at(-1).clientKind, 'static')
  })
  await env.close()

  // ============================================================== pairing
  console.log('\nPairing and consent')
  env = await boot()
  const pc = await newClient(env, { redirect_uris: [REDIRECT, REDIRECT_B] })

  await step('five wrong pairing codes: four re-rendered pages, then the transaction dies with access_denied', async () => {
    const c = await startConsent(env, { clientId: pc.client_id, state: 'lock' })
    for (let i = 1; i <= 4; i += 1) {
      const r = await consent(env, c.txn, 'AAAA-AAAA')
      assert.equal(r.status, 200)
      assert.ok(r.text.includes('did not match'))
      assert.ok(r.text.includes(`${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left`))
      assert.ok(r.text.includes(`name="txn" value="${c.txn}"`))
      assert.equal(r.headers.get('content-security-policy'), CSP)
    }
    const fifth = await consent(env, c.txn, 'AAAA-AAAA')
    assertRedirectError(fifth, 'access_denied', { state: 'lock' })
    assert.equal(env.oauth.stats().lockouts, 1)
    assertPage(await consent(env, c.txn, c.pairing))
  })

  await step('a wrong code does not burn the right one; a correct code after some failures still works', async () => {
    const c = await startConsent(env, { clientId: pc.client_id })
    assert.equal((await consent(env, c.txn, 'AAAA-AAAA')).status, 200)
    assert.equal((await consent(env, c.txn, '')).status, 200)
    assert.equal((await consent(env, c.txn, c.pairing)).status, 302)
  })

  await step('an expired transaction is an HTML error even with the right code', async () => {
    const c = await startConsent(env, { clientId: pc.client_id })
    env.clock.advance(10 * 60 * 1000 + 1)
    assertPage(await consent(env, c.txn, c.pairing))
  })

  await step('a pairing code is single use; the same transaction cannot be approved twice', async () => {
    const c = await startConsent(env, { clientId: pc.client_id })
    const first = await consent(env, c.txn, c.pairing)
    assert.equal(first.status, 302)
    assertPage(await consent(env, c.txn, c.pairing))
  })

  await step('an armed code is single use across transactions: it approves exactly one of two pending consents', async () => {
    const code = env.oauth.openPairing()
    note(code)
    const pk = pkce()
    const start = async () => {
      const page = await getAuthorize(env, { client_id: pc.client_id, redirect_uri: REDIRECT, state: 's', code_challenge: pk.challenge })
      assert.equal(page.status, 200)
      return txnOf(page.text)
    }
    const a = await start()
    const b = await start()
    assert.equal((await consent(env, a, code)).status, 302)
    assert.equal((await consent(env, b, code)).status, 200, 'the same code cannot approve a second transaction')
    const again = env.oauth.openPairing()
    note(again)
    assert.equal((await consent(env, b, again)).status, 302, 'a fresh code can')
  })

  await step('openPairing(): operator codes are XXXX-XXXX, count as pending, work once on any transaction, ignore case and hyphen', async () => {
    const base = env.oauth.pendingPairings()
    const op = env.oauth.openPairing()
    note(op)
    assert.match(op, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    assert.equal(env.oauth.pendingPairings(), base + 1)
    const c = await startConsent(env, { clientId: pc.client_id })
    assert.equal(env.oauth.pendingPairings(), base + 2, 'the consent page adds no code of its own: the operator arms, the page does not')
    assert.equal((await consent(env, c.txn, op.toLowerCase().replace('-', ''))).status, 302)
    assert.equal(env.oauth.pendingPairings(), base + 1, 'only the used code is gone')
    const d = await startConsent(env, { clientId: pc.client_id })
    assert.equal((await consent(env, d.txn, op)).status, 200, 'an operator code cannot be reused')
  })

  await step('pairing codes expire after ten minutes', async () => {
    const op = env.oauth.openPairing()
    note(op)
    const live = env.oauth.pendingPairings()
    assert.ok(live >= 1)
    env.clock.advance(10 * 60 * 1000 + 1000)
    assert.equal(env.oauth.pendingPairings(), 0)
    const c = await startConsent(env, { clientId: pc.client_id })
    assert.equal((await consent(env, c.txn, op)).status, 200)
  })

  await step('Deny redirects with access_denied, state and iss, and kills the transaction', async () => {
    const c = await startConsent(env, { clientId: pc.client_id, state: 'deny-state', redirectUri: REDIRECT_B })
    const r = await consent(env, c.txn, '', 'deny')
    assertRedirectError(r, 'access_denied', { state: 'deny-state', base: REDIRECT_B })
    assert.equal(env.oauth.stats().consentDenied, 1)
    assertPage(await consent(env, c.txn, c.pairing))
  })

  await step('consent POST rejects unknown transactions, bad actions, JSON bodies and repeated fields with an HTML page', async () => {
    assertPage(await postForm(env, '/oauth/authorize', { txn: 'unknown', pairing_code: 'AAAA-AAAA', action: 'approve' }))
    assertPage(await postForm(env, '/oauth/authorize', { pairing_code: 'AAAA-AAAA', action: 'approve' }))
    const c = await startConsent(env, { clientId: pc.client_id })
    assertPage(await postForm(env, '/oauth/authorize', { txn: c.txn, pairing_code: c.pairing, action: 'maybe' }))
    const json = await call(env, 'POST', '/oauth/authorize', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txn: c.txn, pairing_code: c.pairing, action: 'approve' }) })
    assertPage(json)
    const dup = await call(env, 'POST', '/oauth/authorize', { headers: FORM, body: `txn=${c.txn}&txn=x&pairing_code=${c.pairing}&action=approve` })
    assertPage(dup)
  })
  await env.close()

  // ============================================================== token endpoint
  console.log('\nToken endpoint')
  env = await boot()
  const tc = await newClient(env, { redirect_uris: [REDIRECT, REDIRECT_B] })

  await step('a code_verifier that does not match the challenge is invalid_grant, and the code is burned by the attempt', async () => {
    const a = await approve(env, { clientId: tc.client_id })
    const wrong = pkce()
    const bad = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: wrong.verifier, client_id: tc.client_id })
    assertOAuthJson(bad, 400, 'invalid_grant')
    const retry = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: tc.client_id })
    assertOAuthJson(retry, 400, 'invalid_grant')
  })

  await step('a code is burned only by an attempt at its verifier: a foreign client, wrong redirect_uri, wrong resource or a late attempt cannot destroy the real exchange', async () => {
    const other = await newClient(env, { redirect_uris: [REDIRECT] })
    const a = await approve(env, { clientId: tc.client_id })
    const good = { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: tc.client_id }
    assertOAuthJson(await tokenPost(env, { ...good, client_id: other.client_id }), 400, 'invalid_grant')
    assertOAuthJson(await tokenPost(env, { ...good, redirect_uri: REDIRECT_B }), 400, 'invalid_grant')
    assertOAuthJson(await tokenPost(env, { ...good, resource: 'https://evil.example/mcp' }), 400, 'invalid_target')
    assert.equal(env.oauth.stats().codeReuseRevocations, 0)
    const ok = await tokenPost(env, good)
    assert.equal(ok.status, 200, `the holder of the verifier still redeems it: ${ok.text}`)
    // Guessing the verifier still costs the code, exactly once.
    const b = await approve(env, { clientId: tc.client_id })
    const bodyB = { grant_type: 'authorization_code', code: b.code, redirect_uri: REDIRECT, code_verifier: b.pk.verifier, client_id: tc.client_id }
    assertOAuthJson(await tokenPost(env, { ...bodyB, code_verifier: pkce().verifier }), 400, 'invalid_grant')
    assertOAuthJson(await tokenPost(env, bodyB), 400, 'invalid_grant')
    // A code that expired is refused without being burned or revoking anything.
    const c = await approve(env, { clientId: tc.client_id })
    env.clock.advance(61000)
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: c.pk.verifier, client_id: tc.client_id }), 400, 'invalid_grant')
  })

  await step('reusing an authorization code revokes every token issued from it', async () => {
    const g = await grant(env, tc.client_id)
    assert.equal((await mcp(env, g.tokens.access_token)).status, 200)
    const again = await tokenPost(env, { grant_type: 'authorization_code', code: g.code, redirect_uri: REDIRECT, code_verifier: g.pk.verifier, client_id: tc.client_id })
    assertOAuthJson(again, 400, 'invalid_grant')
    const dead = await mcp(env, g.tokens.access_token)
    assert.equal(dead.status, 401)
    assert.equal(dead.headers.get('www-authenticate'), `${CHALLENGE}, error="invalid_token"`)
    assertOAuthJson(await refresh(env, tc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    assert.equal(env.oauth.stats().codeReuseRevocations, 1)
  })

  await step('redirect_uri must be present and equal to the authorize value', async () => {
    const a = await approve(env, { clientId: tc.client_id, redirectUri: REDIRECT })
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT_B, code_verifier: a.pk.verifier, client_id: tc.client_id }), 400, 'invalid_grant')
    const b = await approve(env, { clientId: tc.client_id })
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: b.code, code_verifier: b.pk.verifier, client_id: tc.client_id }), 400, 'invalid_request')
  })

  await step('malformed or missing verifier, code and grant_type are invalid_request without burning the code', async () => {
    const a = await approve(env, { clientId: tc.client_id })
    const base = { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: tc.client_id }
    for (const patch of [{ code_verifier: 'short' }, { code_verifier: `${'a'.repeat(42)}!` }, { code_verifier: 'a'.repeat(129) }, { code_verifier: undefined }, { code: undefined }]) {
      assertOAuthJson(await tokenPost(env, { ...base, ...patch }), 400, 'invalid_request')
    }
    assertOAuthJson(await tokenPost(env, { ...base, grant_type: undefined }), 400, 'invalid_request')
    assertOAuthJson(await tokenPost(env, { ...base, grant_type: 'password' }), 400, 'unsupported_grant_type')
    assertOAuthJson(await tokenPost(env, { ...base, grant_type: 'client_credentials' }), 400, 'unsupported_grant_type')
    assert.equal((await tokenPost(env, base)).status, 200, 'the code was still usable after those refusals')
  })

  await step('a JSON body is accepted on the token endpoint', async () => {
    const a = await approve(env, { clientId: tc.client_id })
    const r = await postJson(env, '/oauth/token', { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: tc.client_id })
    assert.equal(r.status, 200, r.text)
    note(r.json.access_token, r.json.refresh_token)
    const rr = await postJson(env, '/oauth/token', { grant_type: 'refresh_token', refresh_token: r.json.refresh_token, client_id: tc.client_id })
    assert.equal(rr.status, 200, rr.text)
    note(rr.json.access_token, rr.json.refresh_token)
    assertOAuthJson(await call(env, 'POST', '/oauth/token', { headers: { 'content-type': 'text/plain' }, body: 'grant_type=refresh_token' }), 400, 'invalid_request')
    assertOAuthJson(await call(env, 'POST', '/oauth/token', { headers: FORM, body: 'grant_type=refresh_token&grant_type=authorization_code' }), 400, 'invalid_request')
  })

  await step('client_secret_post: a confidential DCR client authenticates in the body; wrong or missing secrets are invalid_client', async () => {
    const conf = await newClient(env, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' })
    const a = await approve(env, { clientId: conf.client_id })
    const base = { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: conf.client_id }
    assertOAuthJson(await tokenPost(env, { ...base, client_secret: 'nope' }), 400, 'invalid_client')
    assertOAuthJson(await tokenPost(env, base), 400, 'invalid_client')
    assertOAuthJson(await tokenPost(env, { ...base, client_secret: '' }), 400, 'invalid_client')
    const ok = await tokenPost(env, { ...base, client_secret: conf.client_secret })
    assert.equal(ok.status, 200, ok.text)
  })

  await step('client_secret_basic DCR client works with Basic; a public client must not send a secret', async () => {
    const conf = await newClient(env, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })
    const a = await approve(env, { clientId: conf.client_id })
    const ok = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier }, { authorization: basic(conf.client_id, conf.client_secret) })
    assert.equal(ok.status, 200, ok.text)
    const b = await approve(env, { clientId: tc.client_id })
    const bad = await tokenPost(env, { grant_type: 'authorization_code', code: b.code, redirect_uri: REDIRECT, code_verifier: b.pk.verifier, client_id: tc.client_id, client_secret: 'anything' })
    assertOAuthJson(bad, 400, 'invalid_client')
  })

  await step('an authorization code expires after 60 seconds', async () => {
    const a = await approve(env, { clientId: tc.client_id })
    env.clock.advance(61000)
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: tc.client_id }), 400, 'invalid_grant')
    const b = await approve(env, { clientId: tc.client_id })
    env.clock.advance(59000)
    assert.equal((await tokenPost(env, { grant_type: 'authorization_code', code: b.code, redirect_uri: REDIRECT, code_verifier: b.pk.verifier, client_id: tc.client_id })).status, 200)
  })

  await step('a code is bound to its client; the resource parameter is checked when present and inherited when absent', async () => {
    const other = await newClient(env, { redirect_uris: [REDIRECT] })
    const a = await approve(env, { clientId: tc.client_id })
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: other.client_id }), 400, 'invalid_grant')
    const b = await approve(env, { clientId: tc.client_id })
    const wrong = await tokenPost(env, { grant_type: 'authorization_code', code: b.code, redirect_uri: REDIRECT, code_verifier: b.pk.verifier, client_id: tc.client_id, resource: 'https://evil.example/mcp' })
    assertOAuthJson(wrong, 400, 'invalid_target')
    const c = await approve(env, { clientId: tc.client_id })
    const ok = await tokenPost(env, { grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, code_verifier: c.pk.verifier, client_id: tc.client_id, resource: RESOURCE })
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await mcp(env, ok.json.access_token)).json.resource, RESOURCE)
    // The same tolerance as the authorize step, and the grant is still bound to THIS server's canonical resource.
    const d = await approve(env, { clientId: tc.client_id })
    const slash = await tokenPost(env, { grant_type: 'authorization_code', code: d.code, redirect_uri: REDIRECT, code_verifier: d.pk.verifier, client_id: tc.client_id, resource: `${RESOURCE}/` })
    assert.equal(slash.status, 200, slash.text)
    assert.equal((await mcp(env, slash.json.access_token)).json.resource, RESOURCE)
    const cased = await refresh(env, tc.client_id, slash.json.refresh_token, { resource: 'https://BRIDGE-LAB.lullascape.com/mcp' })
    assert.equal(cased.status, 200, cased.text)
    assertOAuthJson(await refresh(env, tc.client_id, cased.json.refresh_token, { resource: RESOURCE.toUpperCase() }), 400, 'invalid_target')
    const twice = await call(env, 'POST', '/oauth/token', { headers: FORM, body: `grant_type=refresh_token&client_id=${tc.client_id}&refresh_token=${cased.json.refresh_token}&resource=${encodeURIComponent(RESOURCE)}&resource=${encodeURIComponent(RESOURCE)}` })
    assert.equal(twice.status, 200, 'the same resource twice is one resource')
    note(twice.json.access_token, twice.json.refresh_token)
    const mixed = await call(env, 'POST', '/oauth/token', { headers: FORM, body: `grant_type=refresh_token&client_id=${tc.client_id}&refresh_token=x&resource=${encodeURIComponent(RESOURCE)}&resource=https%3A%2F%2Fevil.example%2Fmcp` })
    assertOAuthJson(mixed, 400, 'invalid_target')
  })

  await step('grant types: a client handed a refresh token may use it even if it registered only authorization_code; a refresh-only client cannot use a code; unknown clients are invalid_client', async () => {
    const codeOnly = await newClient(env, { redirect_uris: [REDIRECT], grant_types: ['authorization_code'] })
    const g = await grant(env, codeOnly.client_id)
    assert.ok(g.tokens.refresh_token, 'a refresh token is issued')
    const r = await refresh(env, codeOnly.client_id, g.tokens.refresh_token)
    assert.equal(r.status, 200, `the client that received it may use it: ${r.text}`)
    assert.equal((await mcp(env, r.json.access_token)).status, 200)
    const refreshOnly = await newClient(env, { redirect_uris: [REDIRECT], grant_types: ['refresh_token'] })
    const a = await approve(env, { clientId: refreshOnly.client_id })
    assertOAuthJson(await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: refreshOnly.client_id }), 400, 'unauthorized_client')
    assertOAuthJson(await refresh(env, refreshOnly.client_id, 'a'.repeat(43)), 400, 'invalid_grant') // a refresh-only client reaches the token check
    assertOAuthJson(await refresh(env, 'never-registered', 'whatever'), 400, 'invalid_client')
    assertOAuthJson(await tokenPost(env, { grant_type: 'refresh_token', refresh_token: 'x' }), 400, 'invalid_request')
  })
  await env.close()

  // ============================================================== expiry and refresh
  console.log('\nAccess expiry, refresh rotation, grace window and absolute lifetime')
  env = await boot()
  const rc = await newClient(env, { redirect_uris: [REDIRECT] })

  await step('an access token expires on the injected clock (401, error="invalid_token") and a refresh restores access', async () => {
    const g = await grant(env, rc.client_id, { scope: 'openid email profile' })
    env.clock.advance(299000)
    assert.equal((await mcp(env, g.tokens.access_token)).status, 200)
    env.clock.advance(2000)
    const expired = await mcp(env, g.tokens.access_token)
    assert.equal(expired.status, 401)
    assert.equal(expired.headers.get('www-authenticate'), `${CHALLENGE}, error="invalid_token"`)
    const r = await refresh(env, rc.client_id, g.tokens.refresh_token)
    assert.equal(r.status, 200, r.text)
    assert.equal((await mcp(env, r.json.access_token)).status, 200)
  })

  await step('refresh rotates: a new pair every time, the same scope and lifetime, and the predecessor is superseded', async () => {
    const g = await grant(env, rc.client_id)
    const r = await refresh(env, rc.client_id, g.tokens.refresh_token)
    assert.equal(r.status, 200)
    assert.notEqual(r.json.refresh_token, g.tokens.refresh_token)
    assert.notEqual(r.json.access_token, g.tokens.access_token)
    assert.equal(r.json.expires_in, 300)
    assert.equal(r.json.scope, 'handoff offline_access')
    assert.equal(r.json.token_type, 'Bearer')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.equal(env.oauth.stats().refreshes >= 2, true)
  })

  await step('a replay of the predecessor inside the grace window returns the SAME pair (idempotent)', async () => {
    const g = await grant(env, rc.client_id)
    const first = await refresh(env, rc.client_id, g.tokens.refresh_token)
    env.clock.advance(60000)
    const before = env.oauth.stats().replaysWithinGrace
    const replay = await refresh(env, rc.client_id, g.tokens.refresh_token)
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.json.access_token, first.json.access_token)
    assert.equal(replay.json.refresh_token, first.json.refresh_token)
    assert.equal(env.oauth.stats().replaysWithinGrace, before + 1)
    const again = await refresh(env, rc.client_id, g.tokens.refresh_token)
    assert.deepEqual(again.json, replay.json)
    assert.equal((await mcp(env, replay.json.access_token)).status, 200)
    const next = await refresh(env, rc.client_id, replay.json.refresh_token)
    assert.equal(next.status, 200, 'the successor is a real, usable refresh token')
  })

  await step('a replay AFTER the grace window revokes the whole family (successor refresh and access tokens die)', async () => {
    const g = await grant(env, rc.client_id)
    const first = await refresh(env, rc.client_id, g.tokens.refresh_token)
    const second = await refresh(env, rc.client_id, first.json.refresh_token)
    assert.equal(second.status, 200)
    env.clock.advance(120000)
    assert.equal((await refresh(env, rc.client_id, g.tokens.refresh_token)).json.refresh_token, first.json.refresh_token, 'exactly at the grace boundary is still a replay')
    env.clock.advance(1000)
    const before = env.oauth.stats().reuseRevocations
    assertOAuthJson(await refresh(env, rc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    assert.equal(env.oauth.stats().reuseRevocations, before + 1)
    const reuse = env.logs.filter(l => l.kind === 'refresh_reuse_revoked').at(-1)
    assert.ok(reuse.fields.staleSec >= 120 && reuse.fields.staleSec <= 122, 'the log says how stale the token was, so a server-caused loss is attributable')
    assertOAuthJson(await refresh(env, rc.client_id, second.json.refresh_token), 400, 'invalid_grant')
    assert.equal((await mcp(env, second.json.access_token)).status, 401)
    assert.equal((await mcp(env, first.json.access_token)).status, 401)
  })

  await step('refresh scope: subsets narrow, ignored authorize-time scopes are tolerated, escalation is invalid_scope, and nothing rotates on error', async () => {
    const g = await grant(env, rc.client_id, { scope: 'openid email profile' })
    let token = g.tokens.refresh_token
    assertOAuthJson(await refresh(env, rc.client_id, token, { scope: 'admin' }), 400, 'invalid_scope')
    assertOAuthJson(await refresh(env, rc.client_id, token, { scope: 'openid admin' }), 400, 'invalid_scope')
    const same = await refresh(env, rc.client_id, token, { scope: 'openid email profile offline_access handoff' })
    assert.equal(same.status, 200, same.text)
    assert.equal(same.json.scope, 'handoff offline_access')
    token = same.json.refresh_token
    const narrow = await refresh(env, rc.client_id, token, { scope: 'handoff' })
    assert.equal(narrow.status, 200, narrow.text)
    assert.equal(narrow.json.scope, 'handoff')
    assert.equal((await mcp(env, narrow.json.access_token)).json.scope, 'handoff')
    const opaque = await refresh(env, rc.client_id, narrow.json.refresh_token, { scope: '' })
    assert.equal(opaque.json.scope, 'handoff offline_access')
  })

  await step('refresh scope: the scope ChatGPT registered (email offline_access profile), openid, offline_access alone and an empty authorize scope all keep a token that can call /mcp', async () => {
    const g = await grant(env, rc.client_id, { scope: '' })
    let token = g.tokens.refresh_token
    for (const scope of ['email offline_access profile', 'openid', 'offline_access', 'openid email profile offline_access', 'profile']) {
      const r = await refresh(env, rc.client_id, token, { scope })
      assert.equal(r.status, 200, `${scope}: ${r.text}`)
      assert.equal(r.json.scope, 'handoff offline_access', scope)
      const seenByMcp = await mcp(env, r.json.access_token)
      assert.equal(seenByMcp.status, 200)
      assert.ok(seenByMcp.json.scope.split(' ').includes('handoff'), `${scope}: a token that lacks the main scope would be refused on every call`)
      token = r.json.refresh_token
    }
    const mixed = await refresh(env, rc.client_id, token, { scope: 'handoff openid' })
    assert.equal(mixed.json.scope, 'handoff', 'narrowing to the main scope is honoured')
    assertOAuthJson(await refresh(env, rc.client_id, mixed.json.refresh_token, { scope: 'handoff extra' }), 400, 'invalid_scope')
    assertOAuthJson(await refresh(env, rc.client_id, mixed.json.refresh_token, { scope: 'admin' }), 400, 'invalid_scope')
    assertOAuthJson(await refresh(env, rc.client_id, mixed.json.refresh_token, { scope: 'openid "x"' }), 400, 'invalid_scope')
    assert.equal((await refresh(env, rc.client_id, mixed.json.refresh_token)).status, 200, 'and no refusal rotated the token')
  })

  await step('refresh resource, client binding and unknown-token handling', async () => {
    const g = await grant(env, rc.client_id)
    assertOAuthJson(await refresh(env, rc.client_id, g.tokens.refresh_token, { resource: 'https://evil.example/mcp' }), 400, 'invalid_target')
    const other = await newClient(env, { redirect_uris: [REDIRECT] })
    assertOAuthJson(await refresh(env, other.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    assertOAuthJson(await refresh(env, rc.client_id, 'a'.repeat(43)), 400, 'invalid_grant')
    assertOAuthJson(await refresh(env, rc.client_id, undefined), 400, 'invalid_request')
    const ok = await refresh(env, rc.client_id, g.tokens.refresh_token, { resource: RESOURCE })
    assert.equal(ok.status, 200, 'a foreign client or a bad resource did not consume the token')
  })
  await env.close()

  env = await boot({ oauth: { refreshTtlSec: 1000, accessTtlSec: 300, refreshGraceSec: 120 } })
  const ac = await newClient(env, { redirect_uris: [REDIRECT] })

  await step('the refresh lifetime is ABSOLUTE from first issue: rotation does not extend it', async () => {
    const g = await grant(env, ac.client_id)
    env.clock.advance(500000)
    const one = await refresh(env, ac.client_id, g.tokens.refresh_token)
    assert.equal(one.status, 200, one.text)
    env.clock.advance(400000)
    const two = await refresh(env, ac.client_id, one.json.refresh_token)
    assert.equal(two.status, 200, two.text)
    env.clock.advance(101000)
    assertOAuthJson(await refresh(env, ac.client_id, two.json.refresh_token), 400, 'invalid_grant')
    const expired = env.logs.filter(l => l.kind === 'refresh_expired').at(-1)
    assert.ok(expired.fields.ageSec >= 1000, 'an expiry is logged as an expiry, with the age of the grant')
    assert.deepEqual(env.oauth.stats().config, { accessTtlSec: 300, refreshTtlSec: 1000, refreshGraceSec: 120 })
  })

  await step('a configurable access lifetime and a zero grace window behave as configured', async () => {
    const strict = await boot({ oauth: { accessTtlSec: 10, refreshGraceSec: 0 } })
    const sc = await newClient(strict, { redirect_uris: [REDIRECT] })
    const g = await grant(strict, sc.client_id)
    assert.equal(g.tokens.expires_in, 10)
    assert.deepEqual(strict.oauth.stats().config, { accessTtlSec: 10, refreshTtlSec: 604800, refreshGraceSec: 0 })
    assert.deepEqual(strict.logs.find(l => l.kind === 'server_started').fields, { accessTtlSec: 10, refreshTtlSec: 604800, refreshGraceSec: 0, persistent: false })
    strict.clock.advance(11000)
    assert.equal((await mcp(strict, g.tokens.access_token)).status, 401)
    const first = await refresh(strict, sc.client_id, g.tokens.refresh_token)
    strict.clock.advance(1)
    assertOAuthJson(await refresh(strict, sc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    assertOAuthJson(await refresh(strict, sc.client_id, first.json.refresh_token), 400, 'invalid_grant')
    await strict.close()
  })
  await env.close()

  // ============================================================== revocation
  console.log('\nRevocation (RFC 7009)')
  env = await boot()
  const vc = await newClient(env, { redirect_uris: [REDIRECT] })

  await step('revoking an access token kills only that token', async () => {
    const g = await grant(env, vc.client_id)
    const r = await postForm(env, '/oauth/revoke', { token: g.tokens.access_token, client_id: vc.client_id })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, {})
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.equal((await mcp(env, g.tokens.access_token)).status, 401)
    const next = await refresh(env, vc.client_id, g.tokens.refresh_token)
    assert.equal(next.status, 200, 'the refresh token survives an access-token revocation')
    assert.equal((await mcp(env, next.json.access_token)).status, 200)
  })

  await step('a revoked access token is not resurrected by a grace replay, even when it expired and was swept before the replay (access lifetime shorter than the grace window)', async () => {
    const short = await boot({ oauth: { accessTtlSec: 60 } }) // default grace is 120 s
    const sc = await newClient(short, { redirect_uris: [REDIRECT] })
    const g = await grant(short, sc.client_id)
    const first = await refresh(short, sc.client_id, g.tokens.refresh_token)
    assert.equal((await mcp(short, first.json.access_token)).status, 200)
    assert.equal((await postForm(short, '/oauth/revoke', { token: first.json.access_token, client_id: sc.client_id })).status, 200)
    assert.equal((await mcp(short, first.json.access_token)).status, 401)
    short.clock.advance(70000) // A1 has expired and the next sweep would have dropped it
    const replay = await refresh(short, sc.client_id, g.tokens.refresh_token)
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.json.access_token, first.json.access_token, 'idempotent replay hands back the same pair')
    assert.equal((await mcp(short, first.json.access_token)).status, 401, 'but the revoked token stays revoked')
    assert.equal((await mcp(short, replay.json.access_token)).status, 401)
    assert.equal((await refresh(short, sc.client_id, replay.json.refresh_token)).status, 200, 'the refresh chain itself is fine')
    // The tombstone is kept for one grace window past expiry and then dropped: state stays bounded.
    const before = short.oauth.stats().accessTokens
    short.clock.advance(200000)
    await call(short, 'GET', '/.well-known/oauth-authorization-server')
    assert.ok(short.oauth.stats().accessTokens < before, 'old access records are swept')
    await short.close()
  })

  await step('revoking a refresh token revokes the family and its access tokens', async () => {
    const g = await grant(env, vc.client_id)
    const next = await refresh(env, vc.client_id, g.tokens.refresh_token)
    const before = env.oauth.stats().revocations
    const r = await postJson(env, '/oauth/revoke', { token: next.json.refresh_token, token_type_hint: 'refresh_token', client_id: vc.client_id })
    assert.equal(r.status, 200)
    assert.equal(env.oauth.stats().revocations, before + 1)
    assert.equal((await mcp(env, next.json.access_token)).status, 401)
    assert.equal((await mcp(env, g.tokens.access_token)).status, 401)
    assertOAuthJson(await refresh(env, vc.client_id, next.json.refresh_token), 400, 'invalid_grant')
    assertOAuthJson(await refresh(env, vc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
  })

  await step('revocation of unknown tokens is always 200 {}; foreign clients cannot revoke; bad client auth and missing token are refused', async () => {
    const before = env.oauth.stats().revocations
    for (const token of ['a'.repeat(43), 'x', 'y'.repeat(600)]) {
      const r = await postForm(env, '/oauth/revoke', { token, client_id: vc.client_id })
      assert.equal(r.status, 200)
      assert.deepEqual(r.json, {})
    }
    assert.equal(env.oauth.stats().revocations, before)
    const g = await grant(env, vc.client_id)
    const other = await newClient(env, { redirect_uris: [REDIRECT] })
    const foreign = await postForm(env, '/oauth/revoke', { token: g.tokens.refresh_token, client_id: other.client_id })
    assert.equal(foreign.status, 200)
    assert.equal((await refresh(env, vc.client_id, g.tokens.refresh_token)).status, 200, 'the owner is unaffected')
    assertOAuthJson(await postForm(env, '/oauth/revoke', { token: 'x', client_id: 'never-registered' }), 400, 'invalid_client')
    assertOAuthJson(await postForm(env, '/oauth/revoke', { client_id: vc.client_id }), 400, 'invalid_request')
    const conf = await newClient(env, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })
    const bad = await postForm(env, '/oauth/revoke', { token: 'x' }, { authorization: basic(conf.client_id, 'wrong') })
    assertOAuthJson(bad, 401, 'invalid_client')
    const ok = await postForm(env, '/oauth/revoke', { token: 'x' }, { authorization: basic(conf.client_id, conf.client_secret) })
    assert.equal(ok.status, 200)
  })
  await env.close()

  // ============================================================== persistence
  console.log('\nPersistence across restarts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-'))
  const persistPath = path.join(dir, 'state', 'oauth.json')
  const clock = makeClock()
  let saved

  await step('state is written atomically with mode 0600 and holds only hashes, never a raw token, code or secret', async () => {
    env = await boot({ clock, oauth: { persistPath } })
    const client = await newClient(env, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' })
    const a = await approve(env, { clientId: client.client_id })
    const t = await tokenPost(env, { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, code_verifier: a.pk.verifier, client_id: client.client_id, client_secret: client.client_secret })
    assert.equal(t.status, 200)
    saved = { client, tokens: t.json }
    await env.close()
    assert.equal(fs.statSync(persistPath).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.dirname(persistPath)), ['oauth.json'], 'no temp file is left behind')
    const text = fs.readFileSync(persistPath, 'utf8')
    for (const secret of seen) assert.ok(!text.includes(secret), `the file must not contain a secret (${secret.slice(0, 4)}...)`)
    assert.ok(/[0-9a-f]{64}/.test(text), 'hashes are present')
    assert.ok(text.includes(client.client_id), 'client records are kept')
    const state = JSON.parse(text)
    assert.equal(state.v, 2)
    assert.ok(!('key' in state), 'no server key: nothing in the file can derive a token')
  })

  await step('a restarted server keeps the link: the old refresh token and the unexpired access token still work', async () => {
    env = await boot({ clock, oauth: { persistPath } })
    assert.equal((await mcp(env, saved.tokens.access_token)).status, 200)
    const r = await refresh(env, saved.client.client_id, saved.tokens.refresh_token, {}, undefined)
    assert.equal(r.status, 400, 'a confidential client must still authenticate after a restart')
    const ok = await tokenPost(env, { grant_type: 'refresh_token', refresh_token: saved.tokens.refresh_token, client_id: saved.client.client_id, client_secret: saved.client.client_secret })
    assert.equal(ok.status, 200, ok.text)
    saved.next = ok.json
    await env.close()
  })

  await step('a replay inside the grace window returns the identical pair even across a restart', async () => {
    env = await boot({ clock, oauth: { persistPath } })
    const replay = await tokenPost(env, { grant_type: 'refresh_token', refresh_token: saved.tokens.refresh_token, client_id: saved.client.client_id, client_secret: saved.client.client_secret })
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.json.refresh_token, saved.next.refresh_token)
    assert.equal(replay.json.access_token, saved.next.access_token)
    clock.advance(121000)
    const late = await tokenPost(env, { grant_type: 'refresh_token', refresh_token: saved.tokens.refresh_token, client_id: saved.client.client_id, client_secret: saved.client.client_secret })
    assertOAuthJson(late, 400, 'invalid_grant')
    assertOAuthJson(await tokenPost(env, { grant_type: 'refresh_token', refresh_token: saved.next.refresh_token, client_id: saved.client.client_id, client_secret: saved.client.client_secret }), 400, 'invalid_grant')
    await env.close()
  })

  await step('a corrupt state file starts empty and logs only the error name; a missing file is not a failure', async () => {
    fs.writeFileSync(persistPath, '{ this is not json', { mode: 0o600 })
    env = await boot({ clock, oauth: { persistPath } })
    const failed = env.logs.filter(l => l.kind === 'persist_load_failed')
    assert.equal(failed.length, 1)
    assert.deepEqual(failed[0].fields, { error: 'SyntaxError' })
    assertOAuthJson(await tokenPost(env, { grant_type: 'refresh_token', refresh_token: saved.tokens.refresh_token, client_id: saved.client.client_id, client_secret: saved.client.client_secret }), 400, 'invalid_client')
    const fresh = await newClient(env, { redirect_uris: [REDIRECT] })
    await env.close()
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(persistPath, 'utf8')))
    fs.rmSync(persistPath)
    env = await boot({ clock, oauth: { persistPath } })
    assert.equal(env.logs.filter(l => l.kind === 'persist_load_failed').length, 0)
    assertPage(await getAuthorize(env, { client_id: fresh.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    await env.close()
  })

  await step('a state file with malformed records loads what is valid and ignores the rest', async () => {
    fs.writeFileSync(persistPath, JSON.stringify({ v: 2, key: 'k'.repeat(43), clients: [{ id: 5 }, null, 'x'], codes: [['h', { nope: true }], 'z'], families: [{}, null], refresh: [null, 'x', [], ['h', null], [7, 7], ['a'.repeat(64), 5]],
      access: [['a', 1], ['short', { familyId: 'f', expiresAt: 9e15, scope: 'handoff', revoked: false }]] }), { mode: 0o600 })
    env = await boot({ clock, oauth: { persistPath } })
    assert.equal(env.logs.filter(l => l.kind === 'persist_load_failed').length, 0)
    const s = env.oauth.stats()
    assert.deepEqual([s.clients, s.codes, s.families, s.refreshTokens, s.accessTokens], [0, 0, 0, 0, 0])
    assert.equal((await mcp(env, 'a'.repeat(40))).status, 401, 'a hand-edited key cannot break the constant-time comparison')
    await env.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await step('one process owns a state file: a second instance is refused, a lock left by a dead process or garbage is taken over, and close() releases it', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-lock-'))
    const pp = path.join(lockDir, 'oauth.json')
    const lock = `${pp}.lock`
    const make = extra => createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp', persistPath: pp, ...extra })
    const first = make()
    assert.ok(fs.existsSync(lock), 'a running instance owns a lock file')
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid))
    assert.equal(fs.statSync(lock).mode & 0o777, 0o600)
    assert.throws(() => make(), err => err.code === 'ELOCKED' && err.message.includes(lock) && err.message.includes(String(process.pid)))
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid), 'the refused attempt left the owner\'s lock alone')
    assert.deepEqual(fs.readdirSync(lockDir).sort(), ['oauth.json.lock'], 'no temp file is left by the refused attempt')
    first.close()
    assert.ok(!fs.existsSync(lock), 'close releases the lock')
    first.close()
    // A lock whose owner has exited is stale: the next start takes it over.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid
    fs.writeFileSync(lock, String(deadPid))
    const second = make()
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid))
    second.close()
    for (const junk of ['', 'not a pid', '-7', '0']) {
      fs.writeFileSync(lock, junk)
      make().close()
      assert.ok(!fs.existsSync(lock), `garbage lock ${JSON.stringify(junk)} is taken over and released`)
    }
    // A live owner (the parent process) is never displaced.
    fs.writeFileSync(lock, String(process.ppid))
    assert.throws(() => make(), err => err.code === 'ELOCKED')
    assert.equal(fs.readFileSync(lock, 'utf8'), String(process.ppid))
    fs.rmSync(lock)
    // A start that fails after the lock was taken gives it back.
    assert.throws(() => make({ staticClient: { clientId: 'a', clientSecret: '', redirectUris: [] } }), TypeError)
    assert.ok(!fs.existsSync(lock), 'a failed start does not leak the lock')
    // No persistence, no lock file, and any number of instances.
    createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp' }).close()
    createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp' }).close()
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  await step('tokens and revocations are on disk BEFORE the response: a copy of the file taken the instant a reply arrives (a crash) already has them', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-durable-'))
    const pp = path.join(d, 'oauth.json')
    const crashCopy = name => {
      const target = path.join(d, name)
      fs.copyFileSync(pp, target)
      return target
    }
    const live = await boot({ oauth: { persistPath: pp } })
    const dc = await newClient(live, { redirect_uris: [REDIRECT] })
    const g = await grant(live, dc.client_id)
    const onDisk = () => {
      assert.ok(fs.existsSync(pp), 'the state file exists by the time the response has arrived')
      return JSON.parse(fs.readFileSync(pp, 'utf8'))
    }
    assert.ok(onDisk().refresh.some(([h]) => h === shaHexOf(g.tokens.refresh_token)), 'the refresh token issued by the code grant is durable')
    assert.ok(onDisk().access.some(([h]) => h === shaHexOf(g.tokens.access_token)))
    const r = await refresh(live, dc.client_id, g.tokens.refresh_token)
    assert.ok(onDisk().refresh.some(([h]) => h === shaHexOf(r.json.refresh_token)), 'a rotation is durable before the client can use the new token')
    // Crash after the rotation: a restart from the file at that instant still honours the new token.
    const afterRotation = crashCopy('after-rotation.json')
    const revived = await boot({ oauth: { persistPath: afterRotation } })
    assert.equal((await mcp(revived, r.json.access_token)).status, 200)
    assert.equal((await refresh(revived, dc.client_id, r.json.refresh_token)).status, 200)
    await revived.close()
    // Revoking an access token: on disk immediately, so a crash cannot bring it back.
    assert.equal((await postForm(live, '/oauth/revoke', { token: r.json.access_token, client_id: dc.client_id })).status, 200)
    assert.equal(onDisk().access.find(([h]) => h === shaHexOf(r.json.access_token))[1].revoked, true)
    const afterAccessRevoke = crashCopy('after-access-revoke.json')
    const revived2 = await boot({ oauth: { persistPath: afterAccessRevoke } })
    assert.equal((await mcp(revived2, r.json.access_token)).status, 401)
    await revived2.close()
    // Revoking the grant: same.
    assert.equal((await postForm(live, '/oauth/revoke', { token: r.json.refresh_token, client_id: dc.client_id })).status, 200)
    assert.equal(onDisk().families.every(f => f.revoked), true)
    const afterFamilyRevoke = crashCopy('after-family-revoke.json')
    const revived3 = await boot({ oauth: { persistPath: afterFamilyRevoke } })
    assertOAuthJson(await refresh(revived3, dc.client_id, r.json.refresh_token), 400, 'invalid_grant')
    await revived3.close()
    // Reuse detection revokes durably too.
    const g2 = await grant(live, dc.client_id)
    const r2 = await refresh(live, dc.client_id, g2.tokens.refresh_token)
    live.clock.advance(121000)
    assertOAuthJson(await refresh(live, dc.client_id, g2.tokens.refresh_token), 400, 'invalid_grant')
    assert.ok(onDisk().families.find(f => f.revoked && f.chain.includes(shaHexOf(r2.json.refresh_token))))
    await live.close()
    fs.rmSync(d, { recursive: true, force: true })
  })

  await step('no server key: a superseded token yields only its direct successor, sealed for the grace window, and the file alone yields nothing', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-seal-'))
    const pp = path.join(d, 'oauth.json')
    const live = await boot({ oauth: { persistPath: pp } })
    const sc = await newClient(live, { redirect_uris: [REDIRECT] })
    const g = await grant(live, sc.client_id)
    const one = await refresh(live, sc.client_id, g.tokens.refresh_token)
    const two = await refresh(live, sc.client_id, one.json.refresh_token)
    const state = () => JSON.parse(fs.readFileSync(pp, 'utf8'))
    const record = raw => state().refresh.find(([h]) => h === shaHexOf(raw))[1]
    assert.ok(!('key' in state()))
    assert.equal(typeof record(g.tokens.refresh_token).grace, 'string', 'the superseded token carries its sealed successor')
    assert.equal(record(two.json.refresh_token).grace, null, 'the live token carries nothing')
    // What the seal is: AES-256-GCM of "successorRefresh\nsuccessorAccess", keyed by SHA-256("grace\n" + predecessor).
    const open = (predecessor, sealed) => {
      const [iv, tag, body] = sealed.split('.').map(part => Buffer.from(part, 'base64url'))
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(`grace\n${predecessor}`).digest(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    }
    assert.equal(open(g.tokens.refresh_token, record(g.tokens.refresh_token).grace), `${one.json.refresh_token}\n${one.json.access_token}`)
    assert.throws(() => open(one.json.refresh_token, record(g.tokens.refresh_token).grace), 'only the predecessor opens it')
    assert.throws(() => open(two.json.refresh_token, record(g.tokens.refresh_token).grace))
    // Every string of the file, taken as a key, derives nothing that was ever issued (the old HMAC scheme's attack).
    const text = fs.readFileSync(pp, 'utf8')
    const issued = new Set([g, one, two].flatMap(t => [t.tokens?.refresh_token, t.tokens?.access_token, t.json?.refresh_token, t.json?.access_token]).filter(Boolean))
    for (const candidate of new Set(text.match(/[A-Za-z0-9_-]{30,}/g))) {
      for (const kind of ['refresh', 'access']) {
        const derived = crypto.createHmac('sha256', candidate).update(`${kind}\n${g.tokens.refresh_token}`).digest('base64url')
        assert.ok(!issued.has(derived), 'no string in the file derives the next token')
      }
    }
    // The blob is deleted once the window has passed (the sweep runs every 5 s), and no sooner.
    live.clock.advance(100000)
    await call(live, 'GET', '/.well-known/oauth-authorization-server')
    await sleep(150)
    assert.equal(typeof record(g.tokens.refresh_token).grace, 'string', 'still inside the window')
    live.clock.advance(26000)
    await call(live, 'GET', '/.well-known/oauth-authorization-server')
    await eventually(() => record(g.tokens.refresh_token).grace === null, 'the sealed successor to be removed from the file after the window')
    assertOAuthJson(await refresh(live, sc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    await live.close()
    // A tampered blob refuses the replay (it does not crash, and does not hand out anything).
    const h = await boot({ oauth: { persistPath: pp } })
    const fresh = await grant(h, sc.client_id)
    const next = await refresh(h, sc.client_id, fresh.tokens.refresh_token)
    h.oauth.close()
    await h.close()
    const tampered = state()
    const entry = tampered.refresh.find(([hash]) => hash === shaHexOf(fresh.tokens.refresh_token))[1]
    const parts = entry.grace.split('.')
    parts[2] = `${parts[2].slice(0, -2)}${parts[2].endsWith('AA') ? 'BB' : 'AA'}`
    entry.grace = parts.join('.')
    fs.writeFileSync(pp, JSON.stringify(tampered), { mode: 0o600 })
    const t = await boot({ oauth: { persistPath: pp } })
    assertOAuthJson(await refresh(t, sc.client_id, fresh.tokens.refresh_token), 400, 'invalid_grant')
    assert.equal((await refresh(t, sc.client_id, next.json.refresh_token)).status, 200, 'the successor itself is unaffected')
    await t.close()
    fs.rmSync(d, { recursive: true, force: true })
  })

  await step('a state file carried to another hostname carries no grants: they are dropped at load and their tokens are unknown', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-audience-'))
    const pp = path.join(d, 'oauth.json')
    const home = await boot({ oauth: { persistPath: pp } })
    const hc = await newClient(home, { redirect_uris: [REDIRECT] })
    const g = await grant(home, hc.client_id)
    const pending = await approve(home, { clientId: hc.client_id })
    assert.equal((await mcp(home, g.tokens.access_token)).json.resource, RESOURCE)
    await home.close()
    const elsewhere = await boot({ oauth: { persistPath: pp, issuer: 'https://other-host.example.com' } })
    const s2 = elsewhere.oauth.stats()
    assert.deepEqual([s2.families, s2.refreshTokens, s2.accessTokens, s2.codes], [0, 0, 0, 0])
    assert.equal(s2.clients, 1, 'the client registration itself is not audience-bound')
    assert.equal((await mcp(elsewhere, g.tokens.access_token)).status, 401)
    assertOAuthJson(await refresh(elsewhere, hc.client_id, g.tokens.refresh_token), 400, 'invalid_grant')
    assertOAuthJson(await tokenPost(elsewhere, { grant_type: 'authorization_code', code: pending.code, redirect_uri: REDIRECT, code_verifier: pending.pk.verifier, client_id: hc.client_id }), 400, 'invalid_grant')
    await elsewhere.close()
    const sibling = await boot({ oauth: { persistPath: pp, resourcePath: '/other' } })
    assert.equal(sibling.oauth.stats().families, 0, 'another resource path on the same host is another audience')
    await sibling.close()
    fs.rmSync(d, { recursive: true, force: true })
  })

  await step('close() is idempotent and no timer keeps the process alive (checked in a child process)', async () => {
    const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-selftest-child-'))
    const source = `
      import http from 'node:http'
      import { createOAuthServer } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'oauth.js')).href)}
      const oauth = createOAuthServer({ issuer: 'https://x.example', resourcePath: '/mcp', persistPath: ${JSON.stringify(path.join(childDir, 'c.json'))} })
      const timeouts = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
      const server = http.createServer(async (req, res) => {
        if (!(await oauth.handle(req, res, new URL(req.url, 'http://x').pathname))) res.end('no')
      })
      server.listen(0, '127.0.0.1', () => {
        const baseline = timeouts()
        const body = JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] })
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/oauth/register', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
          res.resume()
          res.on('close', () => setImmediate(() => {
            console.log(JSON.stringify({ status: res.statusCode, extraTimers: timeouts() - baseline }))
            server.close()
          }))
        })
        req.end(body)
      })
    `
    const started = Date.now()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 })
    assert.equal(child.status, 0, child.stderr)
    assert.ok(Date.now() - started < 10000, 'the child exited on its own')
    assert.deepEqual(JSON.parse(child.stdout.trim()), { status: 201, extraTimers: 0 })
    fs.rmSync(childDir, { recursive: true, force: true })
    const once = createOAuthServer({ issuer: ISSUER, resourcePath: '/mcp' })
    once.close()
    assert.doesNotThrow(() => once.close())
  })

  // ============================================================== floods and bounds
  console.log('\nFlood bounds, body caps and malformed input')
  env = await boot()
  const fc = await newClient(env, { redirect_uris: [REDIRECT] })

  await step('an authorize flood is bounded (120-request burst) and cannot push out the operator: 5 pending per client, 100 overall, the fattest client loses first', async () => {
    const g = await grant(env, fc.client_id)
    // The operator's page, opened first (so it is the OLDEST transaction in the table).
    const victim = await startConsent(env, { clientId: fc.client_id })
    const attackers = []
    for (let i = 0; i < 22; i += 1) attackers.push(await newClient(env, { redirect_uris: [REDIRECT] }))
    const aim = client => ({ client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    let sent = 0 // exactly five requests per attacker: 110 transactions offered to a table that holds 100
    const flood = await burst(110, () => getAuthorize(env, aim(attackers[sent++ % attackers.length])))
    assert.ok(flood.every(r => r.status === 200), 'served while the bucket still has tokens')
    let s = env.oauth.stats()
    assert.equal(s.pendingTransactions, 100, 'the table is full and holds exactly its cap')
    // The operator's consent survived a flood far larger than the table: approving it works.
    const approved = await consent(env, victim.txn, victim.pairing)
    assert.equal(approved.status, 302, 'the lone client is never the victim while a bigger one exists')
    // More than the burst: the surplus is refused with Retry-After, on the authorize bucket alone.
    const more = await burst(120, () => getAuthorize(env, aim(attackers[0])))
    const limited = more.filter(r => r.status === 429)
    assert.ok(limited.length >= 90, `limited ${limited.length}`)
    assertPage(limited[0], 429)
    assert.ok(Number(limited[0].headers.get('retry-after')) >= 1)
    s = env.oauth.stats()
    assert.ok(s.pendingTransactions <= 100 && s.pairings <= 200)
    assert.ok(s.rateLimited >= 90)
    const r = await refresh(env, fc.client_id, g.tokens.refresh_token)
    assert.equal(r.status, 200, 'a refresh still goes through while the authorize bucket is empty')
    env.clock.advance(60000)
    assert.equal((await getAuthorize(env, aim(attackers[0]))).status, 200)
  })

  await step('one client keeps its newest 5 pending consents; the older ones die, and an abandoned page never blocks a retry', async () => {
    const one = await newClient(env, { redirect_uris: [REDIRECT] })
    const code = env.oauth.openPairing()
    note(code)
    const txns = []
    for (let i = 0; i < 8; i += 1) {
      const page = await getAuthorize(env, { client_id: one.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge })
      assert.equal(page.status, 200)
      txns.push(txnOf(page.text))
    }
    const alive = async txn => (await consent(env, txn, 'AAAA-AAAA')).status === 200 // a wrong code re-renders only a live transaction
    for (const txn of txns.slice(0, 3)) assert.equal(await alive(txn), false, 'the three oldest were replaced')
    for (const txn of txns.slice(3)) assert.equal(await alive(txn), true, 'the newest five are live')
    assert.equal((await consent(env, txns[7], code)).status, 302, 'and the newest one approves')
  })

  await step('junk consent POSTs cannot keep the operator from approving: only failures are throttled, an approval never is', async () => {
    const quiet = await boot()
    const qc = await newClient(quiet, { redirect_uris: [REDIRECT] })
    const c = await startConsent(quiet, { clientId: qc.client_id, state: 'mine' })
    const junk = await burst(250, () => postForm(quiet, '/oauth/authorize', { txn: 'nope', pairing_code: 'x', action: 'approve' }))
    const throttled = junk.filter(r => r.status === 429)
    assert.ok(throttled.length >= 120, `throttled ${throttled.length}`)
    assertPage(throttled[0], 429)
    assert.ok(Number(throttled[0].headers.get('retry-after')) >= 1)
    assert.equal(junk.filter(r => r.status === 400).length + throttled.length, 250)
    const approved = await consent(quiet, c.txn, c.pairing)
    assert.equal(approved.status, 302, 'the bucket is empty, and the operator still gets through')
    assert.equal(new URL(approved.location).searchParams.get('state'), 'mine')
    // Wrong codes while the bucket is empty are 429s, and they still count toward the transaction's five tries.
    const d = await startConsent(quiet, { clientId: qc.client_id })
    for (let i = 0; i < 5; i += 1) assertPage(await consent(quiet, d.txn, 'AAAA-AAAA'), 429)
    assert.equal(quiet.oauth.stats().lockouts, 1, 'throttling does not give free guesses')
    quiet.clock.advance(2000)
    assertPage(await consent(quiet, d.txn, d.pairing), 400) // five tries used up: the transaction is gone
    const e = await startConsent(quiet, { clientId: qc.client_id })
    assert.equal((await consent(quiet, e.txn, e.pairing)).status, 302)
    await quiet.close()
  })

  await step('a token-endpoint flood is throttled but cannot starve a valid refresh: only failures draw from the shared bucket', async () => {
    const g = await grant(env, fc.client_id)
    let token = g.tokens.refresh_token
    const junkBody = () => ({ grant_type: 'refresh_token', refresh_token: crypto.randomBytes(8).toString('hex'), client_id: fc.client_id })
    const junk = await burst(250, () => postForm(env, '/oauth/token', junkBody()))
    const limited = junk.filter(r => r.status === 429)
    assert.ok(limited.length >= 120, `limited ${limited.length}`)
    assertOAuthJson(limited[0], 429, 'temporarily_unavailable')
    assert.ok(Number(limited[0].headers.get('retry-after')) >= 1)
    assert.equal(junk.filter(r => r.status === 400).length + limited.length, 250)
    // The failure bucket is empty right now, and the client's own refresh goes straight through.
    const r = await refresh(env, fc.client_id, token)
    assert.equal(r.status, 200, `a valid refresh is not throttled by junk: ${r.text}`)
    token = r.json.refresh_token
    // A sustained flood at twice the refill rate for ten simulated minutes; the client refreshes every ten seconds.
    let ok = 0
    let junkLimited = 0
    for (let second = 0; second < 600; second += 1) {
      for (let i = 0; i < 4; i += 1) {
        env.clock.advance(250)
        const j = await postForm(env, '/oauth/token', junkBody())
        if (j.status === 429) junkLimited += 1
      }
      if (second % 10 === 9) {
        const rr = await refresh(env, fc.client_id, token)
        assert.equal(rr.status, 200, `refresh at second ${second}: ${rr.text}`)
        token = rr.json.refresh_token
        ok += 1
      }
    }
    assert.equal(ok, 60)
    assert.ok(junkLimited > 1000, `the junk itself was still throttled (${junkLimited})`)
    // A junk request that names the client cannot use up that client's allowance for successful issuance either.
    assert.equal((await refresh(env, fc.client_id, token)).status, 200)
  })

  await step('successful issuance is bounded per client (60 burst, 1 per second) without touching the failure bucket', async () => {
    const solo = await boot()
    const sc = await newClient(solo, { redirect_uris: [REDIRECT] })
    const other = await newClient(solo, { redirect_uris: [REDIRECT] })
    const g = await grant(solo, sc.client_id)
    const og = await grant(solo, other.client_id)
    let token = g.tokens.refresh_token
    const statuses = []
    for (let i = 0; i < 70; i += 1) {
      const r = await refresh(solo, sc.client_id, token)
      statuses.push(r.status)
      if (r.status === 200) token = r.json.refresh_token
      else assertOAuthJson(r, 429, 'temporarily_unavailable')
    }
    assert.equal(statuses.filter(x => x === 200).length, 59, 'one token went on the code grant')
    assert.equal(statuses.filter(x => x === 429).length, 11)
    assert.equal((await refresh(solo, other.client_id, og.tokens.refresh_token)).status, 200, 'another client is unaffected')
    // Nothing above drew from the shared failure bucket: 120 junk requests are all plain 400s.
    const junk = await burst(100, () => postForm(solo, '/oauth/token', { grant_type: 'refresh_token', refresh_token: 'nope', client_id: other.client_id }))
    assert.equal(junk.filter(r => r.status === 400).length, 100)
    solo.clock.advance(2000)
    assert.equal((await refresh(solo, sc.client_id, token)).status, 200, 'the allowance refills')
    await solo.close()
  })
  await env.close()

  env = await boot()
  await step('a full client table never evicts a client that is mid-flight (pending consent, live code, live grant); when nothing can be evicted registration is a 503', async () => {
    const seat = async () => {
      env.clock.advance(2000) // the registration bucket refills 0.5 per second
      return newClient(env, { redirect_uris: [REDIRECT] })
    }
    const busyConsent = await seat() // the OLDEST client: first in line for eviction, but it has a pending consent page
    const page = await startConsent(env, { clientId: busyConsent.client_id })
    const busyCode = await seat() // the second oldest: it will get an exchangeable code only at the very end
    const idle = await seat() // the oldest client with nothing in flight
    for (let i = 0; i < 197; i += 1) await seat()
    assert.equal(env.oauth.stats().clients, 200)
    const withCode = await approve(env, { clientId: busyCode.client_id }) // a code lives 60 s; the next five seats take 10 s
    for (let i = 0; i < 5; i += 1) await seat() // five more registrations: five evictions
    assert.equal(env.oauth.stats().clients, 200)
    assertPage(await getAuthorize(env, { client_id: idle.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    assert.equal((await consent(env, page.txn, page.pairing)).status, 302, 'the oldest client survived because its consent page was open')
    const exchanged = await tokenPost(env, { grant_type: 'authorization_code', code: withCode.code, redirect_uri: REDIRECT, code_verifier: withCode.pk.verifier, client_id: busyCode.client_id })
    assert.equal(exchanged.status, 200, 'and so did the client whose code was still exchangeable')
    // Two hundred live grants: nothing can be evicted, so a new registration is refused, not allowed to push one out.
    const full = await boot()
    const grants = []
    for (let i = 0; i < 200; i += 1) {
      full.clock.advance(2000)
      const c = await newClient(full, { redirect_uris: [REDIRECT] })
      grants.push({ c, g: await grant(full, c.client_id) })
    }
    assert.equal(full.oauth.stats().families, 200)
    full.clock.advance(2000)
    const refused = await register(full)
    assertOAuthJson(refused, 503, 'temporarily_unavailable')
    assert.equal(refused.headers.get('retry-after'), '60')
    assert.ok(full.logs.some(l => l.kind === 'client_table_full'))
    // A CIMD client cannot squeeze in either (armed page, table full of busy clients).
    const cimdRefused = await getAuthorize(full, { client_id: 'https://chatgpt.com/oauth/clients/late.json', redirect_uri: REDIRECT, code_challenge: pkce().challenge })
    assert.ok(cimdRefused.status >= 400)
    // Revoking one grant frees exactly that client for eviction.
    assert.equal((await postForm(full, '/oauth/revoke', { token: grants[7].g.tokens.refresh_token, client_id: grants[7].c.client_id })).status, 200)
    full.clock.advance(2000)
    assert.equal((await register(full)).status, 201)
    assert.equal(full.oauth.stats().clients, 200)
    assertPage(await getAuthorize(full, { client_id: grants[7].c.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    assert.equal((await refresh(full, grants[8].c.client_id, grants[8].g.tokens.refresh_token)).status, 200, 'every other grant is untouched')
    await full.close()
  })
  await env.close()

  env = await boot()
  await step('registration is rate limited (30 per minute burst) and the client table is capped at 200 with the oldest unused evicted', async () => {
    const results = await burst(40, () => register(env))
    assert.equal(results.filter(r => r.status === 201).length, 30)
    const limited = results.filter(r => r.status === 429)
    assert.equal(limited.length, 10)
    assertOAuthJson(limited[0], 429, 'temporarily_unavailable')
    const first = results.find(r => r.status === 201).json.client_id
    let last = null
    for (let i = 0; i < 250; i += 1) {
      env.clock.advance(2000)
      const r = await register(env)
      assert.equal(r.status, 201)
      last = r.json.client_id
    }
    assert.equal(env.oauth.stats().clients, 200)
    env.clock.advance(60000)
    assertPage(await getAuthorize(env, { client_id: first, redirect_uri: REDIRECT, code_challenge: pkce().challenge }))
    assert.equal((await getAuthorize(env, { client_id: last, redirect_uri: REDIRECT, code_challenge: pkce().challenge })).status, 200)
  })
  await env.close()

  env = await boot()
  await step('the authorization-code table is capped at 500 and the oldest code is the one evicted', async () => {
    const client = await newClient(env, { redirect_uris: [REDIRECT] })
    const pk = pkce()
    const issued = []
    for (let i = 0; i < 510; i += 1) {
      env.clock.advance(1000)
      const a = await approve(env, { clientId: client.client_id, pk })
      issued.push(a.code)
    }
    assert.ok(env.oauth.stats().codes <= 500, `codes ${env.oauth.stats().codes}`)
    const body = code => ({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: pk.verifier, client_id: client.client_id })
    env.clock.advance(-59000)
    assertOAuthJson(await tokenPost(env, body(issued[0])), 400, 'invalid_grant')
    assert.equal((await tokenPost(env, body(issued[509]))).status, 200)
  })
  await env.close()

  env = await boot()
  const bc = await newClient(env, { redirect_uris: [REDIRECT] })
  await step('bodies over 64 KB are a 413 JSON error on every POST endpoint, declared or chunked, and the server stays healthy', async () => {
    const big = 'a=' + 'x'.repeat(70000)
    for (const target of ['/oauth/token', '/oauth/revoke', '/oauth/register', '/oauth/authorize']) {
      const r = await call(env, 'POST', target, { headers: FORM, body: big })
      assertOAuthJson(r, 413, 'invalid_request')
    }
    const chunked = await rawRequest(env, {
      target: '/oauth/token', headers: { ...FORM, 'transfer-encoding': 'chunked' }, chunks: Array.from({ length: 80 }, () => 'b='.padEnd(1024, 'y')),
    })
    assert.equal(chunked.status, 413)
    assert.equal(JSON.parse(chunked.text).error, 'invalid_request')
    const under = await call(env, 'POST', '/oauth/token', { headers: FORM, body: `a=${'x'.repeat(8000)}` })
    assertOAuthJson(under, 400, 'invalid_request')
    const many = await call(env, 'POST', '/oauth/token', { headers: FORM, body: Array.from({ length: 6000 }, (_, i) => `k${i}=1`).join('&') })
    assertOAuthJson(many, 400, 'invalid_request')
    assert.equal((await getAuthorize(env, { client_id: bc.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge })).status, 200)
  })

  await step('malformed input never produces a 5xx: fuzzed bodies, encodings and content types on every endpoint', async () => {
    const bodies = ['', '{', '[]', 'null', '"str"', '{"a":1}', '{"grant_type":["x"]}', '%', '%zz', 'a=%E0%A4%A', 'grant_type=refresh_token&refresh_token=%00',
      '\u0000\u0001\u0002', '{"__proto__":{"x":1}}', 'constructor=1&__proto__=2&hasOwnProperty=3', '['.repeat(3000), `a=${'y'.repeat(9000)}`,
      '=&=&=', '&&&', 'grant_type', `{"token":"${'z'.repeat(5000)}","client_id":"${bc.client_id}"}`, '\ud800', 'a=b'.repeat(2000)]
    const types = [FORM['content-type'], 'application/json', 'text/plain', 'application/json; charset=utf-16', '', 'multipart/form-data; boundary=x']
    let count = 0
    for (const target of ['/oauth/token', '/oauth/register', '/oauth/revoke', '/oauth/authorize']) {
      for (const type of types) {
        for (const body of bodies) {
          env.clock.advance(1000)
          const headers = type ? { 'content-type': type } : {}
          const r = await call(env, 'POST', target, { headers, body })
          assert.ok(r.status >= 200 && r.status < 500, `${target} ${type} ${JSON.stringify(body).slice(0, 40)} -> ${r.status} ${r.text.slice(0, 120)}`)
          assert.ok(!/\bat [\w./<>]+:\d+/.test(r.text))
          assert.ok(r.status !== 302 || target === '/oauth/authorize')
          count += 1
        }
      }
    }
    env.oauth.openPairing() // an unarmed page is a 403 before any parsing: arm it so the parser is what gets fuzzed
    for (const query of ['?', '?%', '?client_id=%zz', '?&&&', '?client_id=&redirect_uri=', '?client_id=x&redirect_uri=y', `?client_id=${'a'.repeat(9000)}`,
      '?__proto__=1&client_id=1', `?client_id=${bc.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=%00`, '?client_id=https%3A%2F%2Fchatgpt.com%2F..%2Fx&redirect_uri=z']) {
      env.clock.advance(1000)
      const r = await call(env, 'GET', `/oauth/authorize${query}`)
      assert.ok(r.status >= 200 && r.status < 500, `${query.slice(0, 40)} -> ${r.status}`)
      count += 1
    }
    assert.ok(count > 500)
  })
  await env.close()

  // ============================================================== logs
  await step('no token, code, secret, verifier, pairing code or transaction id ever reached a log line', async () => {
    assert.ok(seen.size > 300, `only ${seen.size} secrets were tracked`)
    const dump = JSON.stringify(allLogs)
    assert.ok(dump.length > 2000)
    for (const secret of seen) assert.ok(!dump.includes(secret), `a secret leaked into the logs (${secret.slice(0, 4)}...)`)
    const kinds = new Set(allLogs.map(l => l.kind))
    for (const kind of ['client_registered', 'authorize_started', 'code_issued', 'token_issued', 'refresh_rotated', 'refresh_replay_within_grace',
      'refresh_reuse_revoked', 'code_reuse_revoked', 'token_revoked', 'consent_wrong_code', 'consent_lockout', 'consent_denied', 'cimd_failed',
      'rate_limited', 'persist_load_failed', 'oauth_error', 'authorize_unarmed', 'client_assertion_ignored', 'refresh_expired', 'server_started',
      'client_table_full', 'consent_callback_failed']) {
      assert.ok(kinds.has(kind), `expected a ${kind} log line`)
    }
    assert.ok(!dump.includes('Bearer '), 'no Authorization header value is logged')
  })

  assert.equal(envs.size, 0, 'every server was closed')
  console.log(`\n${passed} steps, ${assertions} assertions passed`)
}

main().catch(async err => {
  console.error(err)
  for (const env of [...envs]) await env.close().catch(() => {})
  process.exitCode = 1
})
