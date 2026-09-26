// Authorization server for the Phase 0b OAuth lab: ChatGPT (client) -> this Mac (resource server).
//
// ONE standalone module, Node built-ins only. It answers /.well-known/* and /oauth/* and offers
// authenticate() for the protected /mcp route. Everything here is fake-data lab plumbing, but it is
// written the way a real authorization server would be so that what Phase 0b measures (how ChatGPT
// links, refreshes and loses a grant) is not confounded by a sloppy server.
//
// Design choices that are not obvious from the code:
//  - Refresh rotation must be idempotent inside the grace window ("the SAME successor pair again")
//    while only hashes are stored. Successors are random. What lets a replay of the predecessor return
//    the identical pair is a sealed blob kept on the predecessor's record: AES-256-GCM of the pair, keyed
//    by SHA-256 of the predecessor's raw token, deleted once the grace window has passed. The state file
//    alone therefore yields no token; a holder of a superseded token can recover only its direct
//    successor, and only inside the window. There is no server key.
//  - The pairing code is the human gate, and it is armed-only: the operator opens a pairing session on
//    the Mac (openPairing() returns the code to display) and /oauth/authorize refuses to start a
//    transaction while no live code exists, so an anonymous caller cannot make the Mac show anything.
//    Codes are single use, accepted for any transaction, never given to log(), checked in constant time.
//  - Rate limiting isolates the caller from the noise. /oauth/token and /oauth/revoke evaluate a request
//    first and only a FAILED one draws from the shared bucket (an empty bucket turns the failure into a
//    429), so anonymous junk cannot starve a valid refresh. The consent POST works the same way. Secrets are
//    256-bit (a pre-registered client's secret must be 32+ characters), so failure-only limiting loses no
//    guessing protection; the successful token path is bounded per client instead. The authorize page
//    is still one anonymous-reachable surface while a pairing session is open: a caller who knows the
//    hostname and ChatGPT's public client_id can churn transactions then. Isolating that needs the caller's
//    address, which only the HTTP front end can supply.
//  - Everything an anonymous caller can grow is capped (transactions per client and overall, codes,
//    clients, pairings) and eviction never takes a client, transaction or code that is mid-flight.
//  - Acknowledged state is durable: token issuance and every revocation are flushed to disk before the
//    response, and one process at a time may own a state file (pid lock).
import crypto from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'

const BODY_CAP = 64 * 1024
const DRAIN_CAP = 1024 * 1024
const BODY_TIMEOUT_MS = 15000
const MAX_PARAM_CHARS = 8192
const MAX_TXNS = 100
const MAX_TXNS_PER_CLIENT = 5
const MAX_CODES = 500
const MAX_CLIENTS = 200
const MAX_FAMILIES = 200
const MAX_PAIRINGS = 200
const CHAIN_KEEP = 64
const TXN_TTL_MS = 10 * 60 * 1000
const PAIRING_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 60 * 1000
const CODE_RETAIN_MS = 10 * 60 * 1000
const REVOKED_KEEP_MS = 60 * 60 * 1000
const EXPIRED_KEEP_MS = 24 * 60 * 60 * 1000
const MAX_WRONG_CODES = 5
const MIN_STATIC_SECRET_CHARS = 32
const MAX_STATE_CHARS = 4096
const PERSIST_DEBOUNCE_MS = 50
const SWEEP_EVERY_MS = 5000
const CIMD_TIMEOUT_MS = 3000
const CIMD_CAP = 16 * 1024
const CIMD_CONCURRENCY = 4
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no I/O/0/1: one random byte maps without bias
const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post']
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const GRANTS = ['authorization_code', 'refresh_token']
const OFFLINE = 'offline_access'
// Scope tokens ChatGPT sends for OpenID reasons. This server ignores them, and a refresh request may repeat them.
const OIDC_SCOPES = ['openid', 'email', 'profile', OFFLINE]
const CIMD_USER_AGENT = 'infinite-canvas-oauth/1'
const DEFAULT_REDIRECTS = [
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/,
]
const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"

// ------------------------------------------------------------------ primitives

const b64u = buf => Buffer.from(buf).toString('base64url')
const sha = value => crypto.createHash('sha256').update(String(value)).digest()
const shaHex = value => sha(value).toString('hex')
const fingerprint = value => shaHex(value).slice(0, 8)
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// Hashing both sides first makes the comparison length-independent as well as constant-time.
function sameSecret(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b))
}

function hexEqual(a, b) {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export class OAuthError extends Error {
  constructor(code, description = '', status = 400, headers = null) {
    super(description || code)
    this.name = 'OAuthError'
    this.code = code
    this.description = description
    this.status = status
    this.headers = headers
    // Set by authenticate(): true when a bearer token was actually presented and failed.
    this.presented = false
  }
}

// An error shown to a human as a plain HTML page. Used for everything decided BEFORE the redirect_uri
// is validated, because redirecting to an unvalidated URI would be an open redirect.
class PageError extends Error {
  constructor(message, status = 400, headers = null) {
    super(message)
    this.name = 'PageError'
    this.status = status
    this.headers = headers
  }
}

// Escapes for HTML text and double-quoted attributes: every reflected value goes through this.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = value => String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c])

// Everything invisible, reorderable or unassigned: controls, format characters (bidi, joiners, Unicode TAG
// characters), lone surrogates, private use, unassigned code points, line/paragraph separators and every
// default-ignorable code point (combining grapheme joiner, Hangul fillers, variation selectors), plus the
// braille blank and the two halfwidth/fullwidth Hangul fillers, which Unicode classes as letters or symbols
// but which render as nothing. Built with fromCodePoint so no invisible character is ever typed into source.
const BLANK_LOOKALIKES = String.fromCodePoint(0x2800, 0x3164, 0xffa0)
const INVISIBLE = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}${BLANK_LOOKALIKES}]`, 'gu',
)
const MAX_COMBINING_RUN = 3

// Text an anonymous caller chose (a client name) that must reach a page or the Mac screen. NFKC first, so
// compatibility forms fold to plain ones before anything invisible is stripped.
function cleanText(value, max, fallback) {
  if (typeof value !== 'string') return fallback
  const plain = value.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  const stacked = plain.replace(new RegExp(`(\\p{M}{${MAX_COMBINING_RUN}})\\p{M}+`, 'gu'), '$1')
  const chars = Array.from(stacked).slice(0, max)
  return chars.join('').trim() || fallback
}

function makeBucket(capacity, perSecond, now) {
  let tokens = capacity
  let last = now()
  const refill = () => {
    const t = now()
    tokens = Math.min(capacity, tokens + Math.max(0, t - last) / 1000 * perSecond)
    last = t
  }
  const wait = () => Math.max(1, Math.ceil((1 - tokens) / perSecond))
  // Returns 0 when a request may proceed, otherwise the whole seconds to wait.
  const take = () => {
    refill()
    if (tokens >= 1) {
      tokens -= 1
      return 0
    }
    return wait()
  }
  // Same answer without spending anything: lets a caller check first and pay only when the work succeeds.
  take.peek = () => {
    refill()
    return tokens >= 1 ? 0 : wait()
  }
  return take
}

// ------------------------------------------------------------------ request parsing

function formDecode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    throw new OAuthError('invalid_request', 'Malformed percent-encoding')
  }
}

// Splits an application/x-www-form-urlencoded string. Repeats are collected in `dups` (RFC 6749 3.1:
// parameters MUST NOT repeat) and the first value is kept; callers decide how to report them.
function parseForm(text) {
  const values = Object.create(null)
  const dups = new Set()
  if (text === '') return { values, dups }
  const pairs = text.split('&')
  if (pairs.length > 100) throw new OAuthError('invalid_request', 'Too many parameters')
  for (const pair of pairs) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = formDecode(eq < 0 ? pair : pair.slice(0, eq))
    const value = formDecode(eq < 0 ? '' : pair.slice(eq + 1))
    if (value.length > MAX_PARAM_CHARS) throw new OAuthError('invalid_request', 'A parameter is too long')
    if (key in values) {
      // RFC 8707 lets a client repeat resource; the same value twice is still one value.
      if (!(key === 'resource' && values[key] === value)) dups.add(key)
    } else values[key] = value
  }
  return { values, dups }
}

function parseJsonObject(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw new OAuthError('invalid_request', 'The body is not valid JSON')
  }
  if (!isObject(doc)) throw new OAuthError('invalid_request', 'The body must be a JSON object')
  return doc
}

// Token and revocation bodies may be JSON: flatten to the same shape as a form (strings only).
function jsonToParams(text) {
  const doc = parseJsonObject(text)
  const values = Object.create(null)
  for (const [key, value] of Object.entries(doc)) {
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' || value.length > MAX_PARAM_CHARS) {
      throw new OAuthError('invalid_request', 'Every parameter must be a string of reasonable length')
    }
    values[key] = value
  }
  return values
}

const mimeOf = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()

function tooLarge() {
  return new OAuthError('invalid_request', 'The request body is too large', 413)
}

// Reads at most BODY_CAP bytes. On excess it rejects at once (so the 413 goes out promptly) but keeps
// draining and discarding the rest of the upload, so the client sees the response instead of a reset.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    let dropped = false
    const timer = setTimeout(() => finish(new OAuthError('invalid_request', 'The request body timed out', 408)), BODY_TIMEOUT_MS)
    timer.unref()
    function finish(err, value) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > BODY_CAP) {
      dropped = true
      finish(tooLarge())
    }
    req.on('data', chunk => {
      size += chunk.length
      if (dropped) {
        if (size > DRAIN_CAP) req.destroy()
        return
      }
      if (size > BODY_CAP) {
        dropped = true
        chunks.length = 0
        finish(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(null, Buffer.concat(chunks)))
    req.on('error', () => finish(new OAuthError('invalid_request', 'The request body could not be read')))
    req.on('close', () => finish(new OAuthError('invalid_request', 'The request ended early')))
  })
}

// ------------------------------------------------------------------ responses

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(data)
}

function sendOAuthError(res, err) {
  const body = { error: err.code }
  if (err.description) body.error_description = err.description
  sendJson(res, err.status, body, err.headers || {})
}

// No Cross-Origin-Opener-Policy on purpose: this page is opened by ChatGPT in a popup and must keep
// window.opener semantics intact.
function sendHtml(res, status, html, csp, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(html)
}

function sendRedirect(res, target, pairs) {
  const query = pairs
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
  const location = target + (target.includes('?') ? '&' : '?') + query
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Length': '0',
  })
  res.end()
}

function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' }, { Allow: allow })
}

function notFound(res) {
  sendJson(res, 404, { error: 'not_found', error_description: 'No such resource' })
}

function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;background:#f6f6f4;color:#1b1b1b}
main{max-width:30rem;margin:0 auto;background:#fff;border:1px solid #d9d9d4;border-radius:10px;padding:1.5rem}
h1{font-size:1.25rem;margin:0 0 1rem}
.who{font-weight:600;word-break:break-word}
.uri{word-break:break-all}
.err{color:#9b1c1c;font-weight:600}
input[type=text]{font:inherit;font-family:ui-monospace,monospace;letter-spacing:.15em;width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 1rem}
button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem;border-radius:6px;border:1px solid #888;cursor:pointer}
button.go{background:#1b1b1b;color:#fff;border-color:#1b1b1b}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}main{background:#1e1e1e;border-color:#444}button{background:#2a2a2a;color:#eee}button.go{background:#eee;color:#111}}
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>
`
}

function errorHtml(message) {
  return pageShell('Cannot continue', `<h1>Cannot continue</h1>\n<p>${esc(message)}</p>`)
}

// What the page claims about the asker is only what was verified. A metadata document fetched from an
// allowlisted host proves the host; a dynamically registered client proves nothing beyond the name it chose,
// so the page says it is unverified instead of naming a product.
function consentSentence(txn) {
  const what = 'to read and answer job-application handoffs on this Mac'
  if (txn.clientKind === 'cimd') return `${txn.clientHost} is asking ${what}`
  if (txn.clientKind === 'static') return `A pre-registered client is asking ${what}`
  return `An unverified client is asking ${what}`
}

function consentHtml(txn, message) {
  const problem = message ? `<p class="err" role="alert">${esc(message)}</p>\n` : ''
  return pageShell('Approve access', `<h1>Approve access</h1>
<p class="who">${esc(txn.clientName)}</p>
<p>${esc(consentSentence(txn))}</p>
<p>Returns to <span class="uri">${esc(txn.redirectUri)}</span></p>
${problem}<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="txn" value="${esc(txn.id)}">
<label for="pairing_code">Pairing code shown on this Mac</label>
<input type="text" id="pairing_code" name="pairing_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16">
<button type="submit" name="action" value="approve" class="go">Approve</button>
<button type="submit" name="action" value="deny" formnovalidate>Deny</button>
</form>`)
}

// form-action must include the redirect target, or browsers block the final 302 of the consent POST.
const consentCsp = txn =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(txn.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`

// ------------------------------------------------------------------ CIMD fetching

// Everything a client metadata document must never be allowed to point the server at.
const NON_PUBLIC = new net.BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC.addSubnet(address, bits, 'ipv4')
// Includes every prefix that can carry or translate to an IPv4 address (IPv4-compatible, SIIT, NAT64 in both
// forms, 6to4, Teredo), the IETF-reserved and documentation blocks, site-local, unique-local, link-local and multicast.
for (const [address, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC.addSubnet(address, bits, 'ipv6')

function isPublicAddress(ip) {
  const family = net.isIP(ip)
  return family !== 0 && !NON_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

// Resolution is where a public-looking name can be steered at an internal address, so the check lives
// in the lookup that the socket itself uses (no window between "checked" and "connected").
function guardedLookup(host, options, callback) {
  dns.lookup(host, options, (err, address, family) => {
    if (err) return callback(err)
    const list = Array.isArray(address) ? address : [{ address, family }]
    if (list.length === 0 || list.some(entry => !isPublicAddress(entry.address))) {
      return callback(new Error('address is not public'))
    }
    return callback(null, address, family)
  })
}

function createCimdFetcher(allowedHosts) {
  return url => new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error('malformed url'))
      return
    }
    const host = target.hostname.toLowerCase()
    if (target.protocol !== 'https:' || target.username || target.password || target.port
      || net.isIP(host.replace(/^\[|\]$/g, '')) || !allowedHosts.includes(host)) {
      reject(new Error('refused'))
      return
    }
    const request = https.request(target, {
      method: 'GET', headers: { accept: 'application/json', 'user-agent': CIMD_USER_AGENT }, lookup: guardedLookup, agent: false, timeout: CIMD_TIMEOUT_MS,
    }, response => {
      // No redirects: a 3xx from an allowlisted host must not be able to move the fetch elsewhere.
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('status'))
        return
      }
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (type !== 'application/json' && !type.endsWith('+json')) {
        response.resume()
        reject(new Error('content type'))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > CIMD_CAP) {
          request.destroy()
          reject(new Error('too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('json'))
        }
      })
      response.on('error', reject)
    })
    const hard = setTimeout(() => request.destroy(new Error('timeout')), CIMD_TIMEOUT_MS)
    hard.unref()
    request.on('close', () => clearTimeout(hard))
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
}

// A client metadata document may list several token-endpoint auth methods. The plural list is the set the
// client can use, so it is authoritative; the singular member is only its preferred or legacy value. ChatGPT's
// real document says private_key_jwt in the singular and offers ["none", "private_key_jwt"] in the plural.
function cimdAllowsNone(doc) {
  const supported = doc.token_endpoint_auth_methods_supported
  if (supported !== undefined) return Array.isArray(supported) && supported.includes('none')
  return doc.token_endpoint_auth_method === undefined || doc.token_endpoint_auth_method === 'none'
}

// Returns a machine reason when the client_id may not be fetched as a metadata document, else null.
function cimdRefusal(id, allowedHosts) {
  if (id.length > 2048 || id.includes('#')) return 'malformed'
  let url
  try {
    url = new URL(id)
  } catch {
    return 'malformed'
  }
  if (url.protocol !== 'https:') return 'scheme'
  if (url.username || url.password) return 'credentials'
  if (url.port) return 'port'
  if (url.href !== id) return 'not_canonical'
  const host = url.hostname.toLowerCase()
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return 'ip_literal'
  if (!allowedHosts.includes(host)) return 'host'
  if (url.pathname === '/') return 'no_path'
  return null
}

// ------------------------------------------------------------------ scope and persistence shapes

// RFC 6749 3.3 scope-token, space separated. null = malformed. Unknown tokens are kept (and ignored later).
function parseScope(text) {
  if (text === undefined || text === '') return []
  const tokens = [...new Set(text.split(' ').filter(Boolean))]
  if (tokens.length > 20) return null
  return tokens.every(t => /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(t)) ? tokens : null
}

// s string, n number, b boolean, a array of strings, sn string|null, nn number|null
const SHAPES = {
  client: { id: 's', kind: 's', name: 's', redirectUris: 'a', authMethod: 's', secretHash: 'sn', grantTypes: 'a', createdAt: 'n', lastUsedAt: 'n', used: 'n' },
  code: { clientId: 's', redirectUri: 's', challenge: 's', resource: 's', scope: 's', requested: 'a', subject: 's', issuedAt: 'n', expiresAt: 'n', retainUntil: 'n', used: 'b', familyId: 'sn' },
  family: { id: 's', clientId: 's', resource: 's', scope: 's', requested: 'a', subject: 's', createdAt: 'n', refreshExpiresAt: 'n', revoked: 'b', revokedAt: 'n', chain: 'a' },
  refresh: { familyId: 's', supersededAt: 'nn', successor: 'sn', grace: 'sn' },
  access: { familyId: 's', expiresAt: 'n', scope: 's', revoked: 'b' },
}
const TYPE_CHECKS = {
  s: v => typeof v === 'string',
  n: v => typeof v === 'number' && Number.isFinite(v),
  b: v => typeof v === 'boolean',
  a: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  sn: v => v === null || typeof v === 'string',
  nn: v => v === null || (typeof v === 'number' && Number.isFinite(v)),
}
const fits = (record, shape) => isObject(record) && Object.entries(shape).every(([key, type]) => TYPE_CHECKS[type](record[key]))

// ------------------------------------------------------------------ options

function resolveOptions(o) {
  if (typeof o.issuer !== 'string' || !/^https?:\/\/[^/?#\s]+$/.test(o.issuer)) {
    throw new TypeError('issuer must be an origin with no trailing slash')
  }
  if (typeof o.resourcePath !== 'string' || !o.resourcePath.startsWith('/') || o.resourcePath.length < 2) {
    throw new TypeError('resourcePath must start with /')
  }
  const positive = (value, fallback, name) => {
    const v = value === undefined ? fallback : value
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new TypeError(`${name} must be a positive number`)
    return v
  }
  const grace = o.refreshGraceSec === undefined ? 120 : o.refreshGraceSec
  if (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0) throw new TypeError('refreshGraceSec must be >= 0')
  const scope = o.scope === undefined ? 'handoff' : o.scope
  if (typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope)) throw new TypeError('scope must be one scope token')
  const hosts = (o.cimdAllowedHosts === undefined ? ['chatgpt.com'] : o.cimdAllowedHosts).map(h => String(h).toLowerCase())
  // Sticky/global flags would make .test() stateful; strip them.
  const patterns = (o.allowedRedirectPatterns === undefined ? DEFAULT_REDIRECTS : o.allowedRedirectPatterns)
    .map(re => new RegExp(re.source, re.flags.replace(/[gy]/g, '')))
  return {
    issuer: o.issuer,
    resourcePath: o.resourcePath,
    resource: o.issuer + o.resourcePath,
    scope,
    accessTtlSec: positive(o.accessTtlSec, 300, 'accessTtlSec'),
    refreshTtlSec: positive(o.refreshTtlSec, 7 * 24 * 3600, 'refreshTtlSec'),
    graceMs: grace * 1000,
    persistPath: o.persistPath || null,
    now: o.now || Date.now,
    clientMetadataFetch: o.clientMetadataFetch || createCimdFetcher(hosts),
    cimdAllowedHosts: hosts,
    redirectPatterns: patterns,
    staticClient: o.staticClient || null,
    log: o.log || (() => {}),
    onConsentRequested: o.onConsentRequested || (() => {}),
    random: o.random || crypto.randomBytes,
  }
}

// ------------------------------------------------------------------ one owner per state file

// Two live instances on one state file would each flush a stale view over the other's, which can bring a
// revoked grant back to life. A pid lock makes the second one refuse to start. The lock is created by
// linking a fully written temp file (so a reader never sees an empty lock) and is taken over only when its
// owner process is gone.
const heldLocks = new Set()
let exitHookInstalled = false

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err) && err.code === 'EPERM'
  }
}

function releaseLock(lockPath) {
  heldLocks.delete(lockPath)
  try {
    if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath, { force: true })
  } catch {
    // already gone
  }
}

function lockedError(lockPath, owner) {
  const err = new Error(`OAuth state is in use by process ${owner}; if that is not an OAuth server, delete ${lockPath}`)
  err.code = 'ELOCKED'
  return err
}

function acquireLock(lockPath) {
  const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.linkSync(tmp, lockPath)
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err
        let text = ''
        try {
          text = fs.readFileSync(lockPath, 'utf8')
        } catch {
          // it vanished between the link and the read: try again
        }
        const owner = Number.parseInt(text, 10)
        if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) throw lockedError(lockPath, owner)
        // Stale (owner gone) or unreadable. Removed only if it is still the same file: a starter racing us may
        // have just replaced it, and that one must not lose its lock.
        try {
          if (fs.readFileSync(lockPath, 'utf8') === text) fs.rmSync(lockPath, { force: true })
        } catch {
          // already gone
        }
        continue
      }
      heldLocks.add(lockPath)
      if (!exitHookInstalled) {
        exitHookInstalled = true
        process.on('exit', () => {
          for (const held of [...heldLocks]) releaseLock(held)
        })
      }
      return
    }
    throw lockedError(lockPath, 'unknown')
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// ------------------------------------------------------------------ the server

export function createOAuthServer(options = {}) {
  const cfg = resolveOptions(options)
  const { issuer } = cfg
  const now = cfg.now
  const accessTtlMs = cfg.accessTtlSec * 1000
  const grantedScope = `${cfg.scope} ${OFFLINE}`

  const clients = new Map()
  const txns = new Map()
  const pairings = new Map() // sha256 hex of the normalised code -> { expiresAt }
  const codes = new Map() // sha256 hex -> record
  const families = new Map()
  const refreshTokens = new Map() // sha256 hex -> { familyId, supersededAt, successor, grace }
  const accessTokens = new Map() // sha256 hex -> { familyId, expiresAt, scope, revoked }
  const clientBuckets = new Map() // client id -> bucket for SUCCESSFUL token issuance
  const lockPath = cfg.persistPath ? `${cfg.persistPath}.lock` : null
  let dirty = false
  let locked = false
  let closed = false
  let timer = null
  let nextSweep = 0
  let cimdInflight = 0
  let lastUnarmedLog = -Infinity
  const counters = {
    registrations: 0, authorizations: 0, codesIssued: 0, tokensIssued: 0, refreshes: 0, replaysWithinGrace: 0,
    reuseRevocations: 0, codeReuseRevocations: 0, revocations: 0, consentDenied: 0, lockouts: 0, rateLimited: 0, unarmedAuthorize: 0,
  }
  // authorize: armed page views. consent, token, revoke: FAILED requests only (see the header comment).
  const buckets = {
    authorize: makeBucket(120, 2, now),
    consent: makeBucket(120, 2, now),
    token: makeBucket(120, 2, now),
    revoke: makeBucket(120, 2, now),
    register: makeBucket(30, 0.5, now),
  }

  // A broken logger must never break authorization. Callers pass only ids and static reasons.
  function log(kind, fields = {}) {
    try {
      cfg.log(kind, fields)
    } catch {
      // logging is best effort
    }
  }

  function rnd(n) {
    const bytes = cfg.random(n)
    if (!Buffer.isBuffer(bytes) || bytes.length !== n) throw new TypeError('random() must return a Buffer of the requested length')
    return bytes
  }

  const newId = () => b64u(rnd(18))
  const newSecret = () => b64u(rnd(32))

  // ---------------------------------------------------------------- persistence

  function snapshot() {
    return {
      v: 2,
      clients: [...clients.values()].filter(c => c.kind !== 'static'),
      codes: [...codes],
      families: [...families.values()],
      refresh: [...refreshTokens],
      access: [...accessTokens],
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!cfg.persistPath || !dirty) return
    dirty = false
    const tmp = `${cfg.persistPath}.${process.pid}.tmp`
    try {
      const data = JSON.stringify(snapshot())
      // 'wx' refuses a leftover file or a planted symlink; rename makes the swap atomic.
      fs.rmSync(tmp, { force: true })
      const fd = fs.openSync(tmp, 'wx', 0o600)
      try {
        fs.writeSync(fd, data)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, cfg.persistPath)
    } catch (err) {
      dirty = true
      log('persist_write_failed', { error: err && err.name, code: err && err.code })
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // nothing left to clean
      }
    }
  }

  function markDirty() {
    if (!cfg.persistPath || closed) return
    dirty = true
    if (timer) return
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS)
    timer.unref()
  }

  // For state a caller has been told about (tokens issued, anything revoked): on disk before the response,
  // so a crash right after cannot lose a link or bring a revoked grant back.
  function commit() {
    markDirty()
    flush()
  }

  // Keys of the token/code tables are SHA-256 digests; anything else in a state file is dropped so a
  // hand-edited file can never reach the constant-time comparison with the wrong length.
  function restoreMap(target, entries, shape) {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && /^[0-9a-f]{64}$/.test(entry[0]) && fits(entry[1], shape)) target.set(entry[0], entry[1])
    }
  }

  function load() {
    if (!cfg.persistPath) return
    let data
    try {
      data = JSON.parse(fs.readFileSync(cfg.persistPath, 'utf8'))
      if (!isObject(data)) throw new TypeError('not an object')
    } catch (err) {
      if (err && err.code === 'ENOENT') return // first boot: nothing to load, not a failure
      log('persist_load_failed', { error: err && err.name })
      return
    }
    if (Array.isArray(data.clients)) {
      for (const c of data.clients) if (fits(c, SHAPES.client) && c.kind !== 'static') clients.set(c.id, c)
    }
    restoreMap(codes, data.codes, SHAPES.code)
    // A grant is bound to the resource it was issued for. A state file carried to another hostname must not
    // carry the grants along: those families and codes are dropped, and their tokens become unknown.
    for (const [hash, rec] of codes) if (rec.resource !== cfg.resource) codes.delete(hash)
    if (Array.isArray(data.families)) {
      for (const f of data.families) if (fits(f, SHAPES.family) && f.resource === cfg.resource) families.set(f.id, f)
    }
    if (Array.isArray(data.refresh)) {
      for (const entry of data.refresh) if (Array.isArray(entry) && isObject(entry[1]) && entry[1].grace === undefined) entry[1].grace = null
    }
    restoreMap(refreshTokens, data.refresh, SHAPES.refresh)
    restoreMap(accessTokens, data.access, SHAPES.access)
    for (const [hash, rec] of refreshTokens) if (!families.has(rec.familyId)) refreshTokens.delete(hash)
  }

  // ---------------------------------------------------------------- housekeeping

  function dropTxn(id) {
    txns.delete(id)
  }

  function dropFamily(id) {
    const family = families.get(id)
    if (!family) return
    for (const hash of family.chain) refreshTokens.delete(hash)
    families.delete(id)
  }

  function revokeFamily(family) {
    if (family.revoked) return
    family.revoked = true
    family.revokedAt = now()
    commit()
  }

  // Bounded state: anything an anonymous caller can create is swept on a schedule and capped on insert.
  function sweep(force = false) {
    const t = now()
    if (!force && t < nextSweep) return
    nextSweep = t + SWEEP_EVERY_MS
    let changed = false
    for (const [id, txn] of txns) if (txn.expiresAt <= t) dropTxn(id)
    for (const [hash, pairing] of pairings) if (pairing.expiresAt <= t) pairings.delete(hash)
    for (const [hash, rec] of codes) {
      if (rec.retainUntil <= t) {
        codes.delete(hash)
        changed = true
      }
    }
    for (const [hash, rec] of accessTokens) {
      // A revoked access token is kept for one grace window past its expiry: until then a replay of the
      // refresh token that minted it could re-create it, and the tombstone is what keeps it revoked.
      const keepUntil = rec.revoked ? rec.expiresAt + cfg.graceMs : rec.expiresAt
      if (keepUntil <= t || !families.has(rec.familyId)) {
        accessTokens.delete(hash)
        changed = true
      }
    }
    for (const [hash, rec] of refreshTokens) {
      if (!families.has(rec.familyId)) {
        refreshTokens.delete(hash)
        changed = true
      } else if (rec.grace !== null && rec.supersededAt !== null && t - rec.supersededAt > cfg.graceMs) {
        rec.grace = null // past the window nobody may replay it, so the sealed successor is deleted
        changed = true
      }
    }
    for (const [id, family] of families) {
      const gone = family.revoked ? t >= family.revokedAt + REVOKED_KEEP_MS : t >= family.refreshExpiresAt + EXPIRED_KEEP_MS
      if (gone) {
        dropFamily(id)
        changed = true
      }
    }
    if (changed) markDirty()
  }

  function limited(name) {
    const wait = buckets[name]()
    if (wait === 0) return 0
    counters.rateLimited += 1
    log('rate_limited', { endpoint: name })
    return wait
  }

  // ---------------------------------------------------------------- clients

  // A client is busy while anything of it is mid-flight: a pending consent page, a code that can still be
  // exchanged, or a grant that can still refresh. Busy clients are never evicted.
  function clientBusy(id) {
    const t = now()
    for (const txn of txns.values()) if (txn.clientId === id) return true
    for (const rec of codes.values()) if (rec.clientId === id && !rec.used && rec.expiresAt > t) return true
    for (const family of families.values()) if (family.clientId === id && !family.revoked && family.refreshExpiresAt > t) return true
    return false
  }

  // Oldest never-used client first, then the oldest used one. Returns false when everything is busy.
  function evictClient() {
    let victim = null
    for (const [id, c] of clients) {
      if (c.kind === 'static' || clientBusy(id)) continue
      if (c.used === 0) {
        victim = id
        break
      }
      if (victim === null) victim = id
    }
    if (victim === null) return false
    clients.delete(victim)
    clientBuckets.delete(victim)
    return true
  }

  // False when the table is full of clients that cannot be evicted; the caller answers 503.
  function addClient(record) {
    if (!clients.has(record.id) && clients.size >= MAX_CLIENTS && !evictClient()) return false
    clients.set(record.id, record)
    markDirty()
    return true
  }

  // Printable ASCII only: the value goes straight into a Location header, so no custom pattern may let a
  // control character or a non-ASCII byte through.
  const allowedRedirect = uri => typeof uri === 'string' && uri.length <= 2048 && /^[\x21-\x7e]+$/.test(uri)
    && cfg.redirectPatterns.some(re => re.test(uri))

  function touchClient(client) {
    client.used += 1
    client.lastUsedAt = now()
  }

  function setupStaticClient() {
    const s = cfg.staticClient
    if (!s) return
    const parsable = u => {
      try {
        return Boolean(new URL(u).origin)
      } catch {
        return false
      }
    }
    const okUris = Array.isArray(s.redirectUris) && s.redirectUris.length > 0
      && s.redirectUris.every(u => typeof u === 'string' && /^https?:\/\/[\x21\x22\x24-\x7e]+$/.test(u) && parsable(u))
    if (typeof s.clientId !== 'string' || !s.clientId || typeof s.clientSecret !== 'string' || !s.clientSecret || !okUris) {
      throw new TypeError('staticClient needs clientId, clientSecret and absolute redirectUris without fragments')
    }
    // The token endpoint throttles FAILED requests but still evaluates them, so guessing is only as hard as
    // the secret is long: generate it randomly (256-bit secrets are what the module itself issues).
    if (s.clientSecret.length < MIN_STATIC_SECRET_CHARS) {
      throw new TypeError(`staticClient.clientSecret must be at least ${MIN_STATIC_SECRET_CHARS} characters; generate it randomly`)
    }
    clients.set(s.clientId, {
      id: s.clientId, kind: 'static', name: cleanText(s.clientName, 100, 'Pre-registered client'), redirectUris: [...s.redirectUris],
      authMethod: 'client_secret_basic', secretHash: shaHex(s.clientSecret), grantTypes: [...GRANTS], createdAt: now(), lastUsedAt: now(), used: 0,
    })
  }

  // ---------------------------------------------------------------- pairing and transactions

  function pairingCode() {
    const bytes = rnd(8)
    let text = ''
    for (let i = 0; i < 8; i += 1) text += PAIRING_ALPHABET[bytes[i] & 31]
    return `${text.slice(0, 4)}-${text.slice(4)}`
  }

  const normalizePairing = value => (typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '')

  function addPairing() {
    while (pairings.size >= MAX_PAIRINGS) pairings.delete(pairings.keys().next().value)
    for (;;) {
      const code = pairingCode()
      const hash = shaHex(normalizePairing(code))
      if (pairings.has(hash)) continue
      pairings.set(hash, { expiresAt: now() + PAIRING_TTL_MS })
      return code
    }
  }

  // Walks every live code without an early exit, so timing does not reveal which entry matched.
  function consumePairing(presented) {
    const wanted = shaHex(normalizePairing(presented))
    const t = now()
    let hit = null
    for (const [hash, pairing] of pairings) {
      if (pairing.expiresAt <= t) continue
      if (hexEqual(wanted, hash)) hit = hash
    }
    if (hit === null) return false
    pairings.delete(hit)
    return true
  }

  // The operator opens a pairing session on the Mac; the returned code is what the Mac displays.
  function openPairing() {
    sweep()
    return addPairing()
  }

  function pendingPairings() {
    const t = now()
    let live = 0
    for (const pairing of pairings.values()) if (pairing.expiresAt > t) live += 1
    return live
  }

  // A client's newest attempt replaces its own oldest, so an abandoned page never blocks a retry. When the
  // whole table is full, the victim is the oldest transaction of whichever client holds the most, so a
  // flood from many clients cannot push out a lone client's pending consent.
  function dropFattestTxn() {
    const counts = new Map()
    for (const txn of txns.values()) counts.set(txn.clientId, (counts.get(txn.clientId) || 0) + 1)
    let victimClient = null
    let most = 0
    for (const [id, n] of counts) {
      if (n > most) {
        most = n
        victimClient = id
      }
    }
    for (const [id, txn] of txns) {
      if (txn.clientId === victimClient) {
        dropTxn(id)
        return
      }
    }
  }

  function createTxn(fields) {
    const own = [...txns.values()].filter(txn => txn.clientId === fields.clientId)
    while (own.length >= MAX_TXNS_PER_CLIENT) dropTxn(own.shift().id)
    while (txns.size >= MAX_TXNS) dropFattestTxn()
    const id = b64u(rnd(24))
    const txn = { id, ...fields, wrong: 0, expiresAt: now() + TXN_TTL_MS }
    txns.set(id, txn)
    return txn
  }

  // ---------------------------------------------------------------- tokens

  // The successor pair, sealed so that only the holder of the predecessor can read it back: AES-256-GCM keyed
  // by SHA-256 of the predecessor's raw token. Stored on the predecessor's record for the grace window only.
  function sealPair(predecessorRaw, refreshRaw, accessRaw) {
    const iv = rnd(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', sha(`grace\n${predecessorRaw}`), iv)
    const body = Buffer.concat([cipher.update(`${refreshRaw}\n${accessRaw}`, 'utf8'), cipher.final()])
    return `${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(body)}`
  }

  function openPair(predecessorRaw, sealed) {
    if (typeof sealed !== 'string') return null
    try {
      const [iv, tag, body] = sealed.split('.').map(part => Buffer.from(part, 'base64url'))
      if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return null
      const decipher = crypto.createDecipheriv('aes-256-gcm', sha(`grace\n${predecessorRaw}`), iv)
      decipher.setAuthTag(tag)
      const [refresh, access, ...extra] = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8').split('\n')
      const secret = /^[A-Za-z0-9_-]{43}$/
      return extra.length === 0 && secret.test(refresh) && secret.test(access) ? { refresh, access } : null
    } catch {
      return null
    }
  }

  function addFamily(family) {
    while (families.size >= MAX_FAMILIES) {
      let victim = null
      for (const [id, f] of families) {
        if (f.revoked || f.refreshExpiresAt <= now()) {
          victim = id
          break
        }
        if (victim === null) victim = id
      }
      dropFamily(victim)
    }
    families.set(family.id, family)
  }

  function storeAccess(raw, family, scope) {
    accessTokens.set(shaHex(raw), { familyId: family.id, expiresAt: now() + accessTtlMs, scope, revoked: false })
  }

  function storeRefresh(raw, family) {
    const hash = shaHex(raw)
    refreshTokens.set(hash, { familyId: family.id, supersededAt: null, successor: null, grace: null })
    family.chain.push(hash)
    // Old generations are kept only so a stale replay is recognised; past this depth they are just unknown.
    while (family.chain.length > CHAIN_KEEP) refreshTokens.delete(family.chain.shift())
  }

  const tokenBody = (access, refresh, scope) => ({
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.ceil(accessTtlMs / 1000),
    refresh_token: refresh,
    scope,
  })

  // ---------------------------------------------------------------- discovery documents

  const prmDoc = {
    resource: cfg.resource,
    authorization_servers: [issuer],
    scopes_supported: [cfg.scope],
    bearer_methods_supported: ['header'],
  }
  const asDoc = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: [...GRANTS],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [cfg.scope, OFFLINE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  }
  // RFC 8707 resource identifiers are compared as the exact server URL, tolerating only what cannot change
  // which server is meant: host case, a default port, and one trailing slash. The path is case-sensitive,
  // and a query, fragment or userinfo is never accepted.
  const issuerOrigin = new URL(issuer).origin
  const trimSlash = text => (text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text)
  function sameResource(value) {
    if (typeof value !== 'string' || value.length > 2048) return false
    if (value === cfg.resource) return true
    const m = /^(https?:\/\/[^/?#@]+)(\/[^?#]*)?$/i.exec(value)
    if (!m) return false
    let origin
    try {
      origin = new URL(m[1]).origin
    } catch {
      return false
    }
    return origin === issuerOrigin && trimSlash(m[2] || '') === trimSlash(cfg.resourcePath)
  }

  // Root protected-resource metadata carries the MCP resource, not the bare origin RFC 9728 3.3 would
  // strictly want for the suffix-less URL. That is a deliberate lenient fallback: a client that guessed
  // the root URL still learns which resource to ask for.
  const wellKnown = new Map([
    ['/.well-known/oauth-protected-resource', prmDoc],
    [`/.well-known/oauth-protected-resource${cfg.resourcePath}`, prmDoc],
    ['/.well-known/oauth-authorization-server', asDoc],
    ['/.well-known/openid-configuration', asDoc],
    [`/.well-known/oauth-authorization-server${cfg.resourcePath}`, asDoc],
    [`/.well-known/openid-configuration${cfg.resourcePath}`, asDoc],
  ])

  function wellKnownRoute(req, res, pathname) {
    const doc = wellKnown.get(pathname)
    if (!doc) return notFound(res)
    if (req.method === 'OPTIONS') {
      // The documents are public; a browser-based client (an inspector) needs its preflight answered.
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store', 'Content-Length': '0',
      })
      return res.end()
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    return sendJson(res, 200, doc, { 'Access-Control-Allow-Origin': '*' })
  }

  // ---------------------------------------------------------------- request bodies and client authentication

  async function readParams(req) {
    const buf = await readBody(req)
    const type = mimeOf(req)
    const text = buf.toString('utf8')
    if (type === 'application/x-www-form-urlencoded') {
      const { values, dups } = parseForm(text)
      if (dups.size === 1 && dups.has('resource')) throw new OAuthError('invalid_target', 'Only one resource is supported')
      if (dups.size > 0) throw new OAuthError('invalid_request', 'A parameter was repeated')
      return values
    }
    if (type === 'application/json') return jsonToParams(text)
    throw new OAuthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded or application/json')
  }

  const decodeOrNull = text => {
    try {
      return formDecode(text)
    } catch {
      return null
    }
  }

  function secretMatches(client, secret) {
    return client.secretHash !== null && hexEqual(shaHex(secret), client.secretHash)
  }

  // A private_key_jwt request may carry no client_id at all (RFC 7521/7523): the client is then named by the
  // assertion's subject. The signature is deliberately NOT verified. This server advertises no such method, so
  // the assertion is only a way to learn which PUBLIC client is speaking; PKCE and the pairing code remain the
  // gates, exactly as when client_id is sent in the body. A confidential client can never authenticate this way.
  function assertionSubject(params) {
    const assertion = params.client_assertion
    if (params.client_assertion_type !== JWT_BEARER || typeof assertion !== 'string' || assertion.length > 8192) return undefined
    const parts = assertion.split('.')
    if (parts.length !== 3) return undefined
    try {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (!isObject(claims)) return undefined
      if (typeof claims.sub === 'string') return claims.sub
      return typeof claims.iss === 'string' ? claims.iss : undefined
    } catch {
      return undefined
    }
  }

  // none (public, client_id in the body or named by an assertion), client_secret_basic and client_secret_post.
  // Both secret methods are accepted for any confidential client because the metadata advertises both.
  function authenticateClient(req, params) {
    const header = req.headers.authorization
    const basic = typeof header === 'string' && /^basic\s/i.test(header)
    const failure = why => new OAuthError(
      'invalid_client', why || 'Client authentication failed', basic ? 401 : 400,
      basic ? { 'WWW-Authenticate': 'Basic realm="oauth", charset="UTF-8"' } : null,
    )
    let ids = []
    let secrets = []
    if (basic) {
      if (params.client_secret !== undefined) throw new OAuthError('invalid_request', 'Use only one client authentication method')
      const decoded = Buffer.from(header.slice(5).trim(), 'base64').toString('utf8')
      const colon = decoded.indexOf(':')
      if (colon < 0) throw failure()
      const rawId = decoded.slice(0, colon)
      const rawSecret = decoded.slice(colon + 1)
      // RFC 6749 2.3.1 says both are form-urlencoded; some clients skip that, so try the literal too.
      ids = [decodeOrNull(rawId), rawId]
      secrets = [decodeOrNull(rawSecret), rawSecret]
    } else {
      ids = [params.client_id === undefined ? assertionSubject(params) : params.client_id]
      secrets = params.client_secret === undefined ? [] : [params.client_secret]
    }
    ids = ids.filter(v => typeof v === 'string' && v !== '')
    if (ids.length === 0) throw new OAuthError('invalid_request', 'client_id is required')
    const id = ids.find(candidate => clients.has(candidate))
    if (basic && params.client_id !== undefined && id !== undefined && params.client_id !== id) {
      throw new OAuthError('invalid_request', 'client_id does not match the Authorization header')
    }
    const client = id === undefined ? null : clients.get(id)
    if (!client) throw failure()
    const presented = secrets.filter(v => typeof v === 'string')
    if (client.authMethod === 'none') {
      if (presented.some(v => v !== '')) throw failure('This client is public and must not send a secret')
    } else if (!presented.some(v => v !== '' && secretMatches(client, v))) {
      throw failure()
    }
    // Recorded so Phase 0b can see whether ChatGPT authenticates with an assertion at all.
    if (params.client_assertion !== undefined) log('client_assertion_ignored', { client: client.id })
    return client
  }

  // ---------------------------------------------------------------- /oauth/register

  function cleanRegistration(doc) {
    const uris = doc.redirect_uris
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 5 URIs')
    }
    if (!uris.every(allowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'A redirect_uri is not allowed for this server')
    // Default is a PUBLIC client (none): ChatGPT authenticates with PKCE, and a secret it would have to
    // keep adds nothing here. A client that asks for a secret method still gets one.
    const method = doc.token_endpoint_auth_method === undefined ? 'none' : doc.token_endpoint_auth_method
    if (!AUTH_METHODS.includes(method)) throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method')
    const grants = doc.grant_types === undefined ? [...GRANTS] : doc.grant_types
    if (!Array.isArray(grants) || grants.length === 0 || !grants.every(g => GRANTS.includes(g))) {
      throw new OAuthError('invalid_client_metadata', 'grant_types must be a non-empty subset of authorization_code, refresh_token')
    }
    const types = doc.response_types
    if (types !== undefined && (!Array.isArray(types) || types.length === 0 || !types.every(t => t === 'code'))) {
      throw new OAuthError('invalid_client_metadata', 'response_types must be ["code"]')
    }
    if (doc.client_name !== undefined && typeof doc.client_name !== 'string') {
      throw new OAuthError('invalid_client_metadata', 'client_name must be a string')
    }
    // The registered scope string is echoed back (RFC 7591 3.2.1) but never enforced: ChatGPT registers
    // "email offline_access profile" and later authorizes with openid, so scope is not checked against it.
    const scope = typeof doc.scope === 'string' ? cleanText(doc.scope, 200, '') : ''
    return { uris: [...new Set(uris)], method, grants: [...new Set(grants)], name: cleanText(doc.client_name, 100, 'Unnamed client'), scope }
  }

  async function registerRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    const wait = limited('register')
    if (wait) throw new OAuthError('temporarily_unavailable', 'Too many registrations; try again shortly', 429, { 'Retry-After': String(wait) })
    const buf = await readBody(req)
    if (mimeOf(req) !== 'application/json') throw new OAuthError('invalid_client_metadata', 'Content-Type must be application/json')
    const spec = cleanRegistration(parseJsonObject(buf.toString('utf8')))
    const t = now()
    const secret = spec.method === 'none' ? null : newSecret()
    const record = {
      id: newId(), kind: 'dcr', name: spec.name, redirectUris: spec.uris, authMethod: spec.method,
      secretHash: secret === null ? null : shaHex(secret), grantTypes: spec.grants, createdAt: t, lastUsedAt: t, used: 0,
    }
    if (!addClient(record)) {
      log('client_table_full', {})
      throw new OAuthError('temporarily_unavailable', 'Too many clients are in use; try again later', 503, { 'Retry-After': '60' })
    }
    counters.registrations += 1
    log('client_registered', { client: record.id, method: record.authMethod })
    const body = {
      client_id: record.id,
      client_id_issued_at: Math.floor(t / 1000),
      client_name: record.name,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: record.authMethod,
      grant_types: record.grantTypes,
      response_types: ['code'],
    }
    if (spec.scope) body.scope = spec.scope
    if (secret !== null) {
      body.client_secret = secret
      body.client_secret_expires_at = 0
    }
    return sendJson(res, 201, body)
  }

  // ---------------------------------------------------------------- /oauth/authorize

  async function loadCimdClient(clientId, redirectUri) {
    const refusal = cimdRefusal(clientId, cfg.cimdAllowedHosts)
    if (refusal) {
      log('cimd_failed', { reason: refusal })
      throw new PageError('This client cannot be used with this server.')
    }
    if (cimdInflight >= CIMD_CONCURRENCY) throw new PageError('Too many client lookups at once. Try again in a moment.', 429, { 'Retry-After': '2' })
    let doc
    cimdInflight += 1
    try {
      doc = await cfg.clientMetadataFetch(clientId)
    } catch {
      log('cimd_failed', { reason: 'fetch' })
      throw new PageError('The client metadata document could not be read.')
    } finally {
      cimdInflight -= 1
    }
    const uris = isObject(doc) ? doc.redirect_uris : null
    let reason = null
    if (!isObject(doc) || doc.client_id !== clientId) reason = 'client_id_mismatch'
    else if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(u => typeof u === 'string' && u.length <= 2048)) reason = 'malformed'
    else if (!cimdAllowsNone(doc)) reason = 'auth_method'
    else if (doc.client_secret !== undefined || doc.client_secret_expires_at !== undefined) reason = 'has_secret'
    else if (!uris.includes(redirectUri)) reason = 'redirect_not_listed'
    else if (!allowedRedirect(redirectUri)) reason = 'redirect_pattern'
    if (reason) {
      log('cimd_failed', { reason })
      throw new PageError('This client metadata document is not acceptable.')
    }
    const t = now()
    const existing = clients.get(clientId)
    return {
      id: clientId, kind: 'cimd', name: cleanText(doc.client_name, 100, 'Unnamed client'), redirectUris: uris.filter(allowedRedirect),
      authMethod: 'none', secretHash: null, grantTypes: [...GRANTS], createdAt: existing ? existing.createdAt : t, lastUsedAt: t, used: existing ? existing.used : 0,
    }
  }

  // Stage 1: nothing is trusted yet, so every failure is a plain page and never a redirect.
  async function resolveAuthorizeClient(clientId, redirectUri) {
    const known = clients.get(clientId)
    if (known && known.kind !== 'cimd') {
      if (!known.redirectUris.includes(redirectUri) || (known.kind === 'dcr' && !allowedRedirect(redirectUri))) {
        throw new PageError('This redirect address is not registered for the client.')
      }
      return known
    }
    if (/^https:\/\//i.test(clientId)) return loadCimdClient(clientId, redirectUri)
    throw new PageError('Unknown client.')
  }

  // Stage 2 (redirect_uri already trusted): returns an OAuth error to redirect with, or the parsed scope.
  function checkAuthorizeParams(q, dups) {
    const refuse = (code, description, keepState = true) => ({ error: code, description, keepState })
    if ([...dups].some(key => key !== 'resource')) return refuse('invalid_request', 'A parameter was repeated', !dups.has('state'))
    if (q.state !== undefined && q.state.length > MAX_STATE_CHARS) return refuse('invalid_request', 'state is too long', false)
    if (q.response_type !== 'code') return refuse('unsupported_response_type', 'Only response_type=code is supported')
    if (q.code_challenge === undefined) return refuse('invalid_request', 'code_challenge is required (PKCE S256)')
    if (q.code_challenge_method !== 'S256') return refuse('invalid_request', 'code_challenge_method must be S256')
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return refuse('invalid_request', 'code_challenge is malformed')
    // RFC 8707: a missing, wrong or ambiguous (several different values) resource is invalid_target.
    if (dups.has('resource')) return refuse('invalid_target', 'Only one resource is supported')
    if (!sameResource(q.resource)) return refuse('invalid_target', 'resource must be the MCP endpoint of this server')
    const requested = parseScope(q.scope)
    if (requested === null) return refuse('invalid_scope', 'scope is malformed')
    return { requested }
  }

  const issRedirect = (res, target, pairs) => sendRedirect(res, target, [...pairs, ['iss', issuer]])

  function redirectError(res, target, state, code, description) {
    issRedirect(res, target, [['error', code], ['error_description', description], ['state', state]])
  }

  async function authorizeGet(req, res) {
    // Armed-only, and decided before anything else (no rate-limit charge, no metadata fetch, no state): the
    // operator opens a pairing session on the Mac, and until then nobody can start a transaction or make
    // the Mac display anything. The refusal is logged once a minute, not once per request.
    if (pendingPairings() === 0) {
      counters.unarmedAuthorize += 1
      const t = now()
      if (t - lastUnarmedLog >= 60000) {
        lastUnarmedLog = t
        log('authorize_unarmed', { total: counters.unarmedAuthorize })
      }
      throw new PageError('No pairing session is open on the Mac. Start one there, then try again from ChatGPT.', 403)
    }
    const wait = limited('authorize')
    if (wait) throw new PageError('Too many requests. Try again shortly.', 429, { 'Retry-After': String(wait) })
    const at = req.url.indexOf('?')
    let parsed
    try {
      parsed = parseForm(at < 0 ? '' : req.url.slice(at + 1))
    } catch {
      throw new PageError('The authorization request is malformed.')
    }
    const { values: q, dups } = parsed
    if (!q.client_id || !q.redirect_uri || dups.has('client_id') || dups.has('redirect_uri')) {
      throw new PageError('The request is missing a client or a redirect address.')
    }
    const client = await resolveAuthorizeClient(q.client_id, q.redirect_uri)
    const target = q.redirect_uri
    const checked = checkAuthorizeParams(q, dups)
    if (checked.error) {
      log('authorize_rejected', { client: client.id, reason: checked.error })
      return redirectError(res, target, checked.keepState ? q.state : undefined, checked.error, checked.description)
    }
    if (client.kind === 'cimd' && !addClient(client)) {
      log('client_table_full', {})
      throw new PageError('Too many clients are in use. Try again later.', 503, { 'Retry-After': '60' })
    }
    const txn = createTxn({
      clientId: client.id, clientName: client.name, clientKind: client.kind, clientHost: client.kind === 'cimd' ? new URL(client.id).hostname : '',
      redirectUri: target, state: q.state, challenge: q.code_challenge, resource: cfg.resource, requested: checked.requested,
    })
    counters.authorizations += 1
    log('authorize_started', { client: client.id, txn: fingerprint(txn.id) })
    // Tells the Mac that a consent page is waiting for the code the operator already holds. Sanitised text only.
    try {
      cfg.onConsentRequested({ clientId: client.id, clientName: client.name, clientKind: client.kind, redirectOrigin: new URL(target).origin })
    } catch (err) {
      log('consent_callback_failed', { error: err && err.name })
    }
    return sendHtml(res, 200, consentHtml(txn), consentCsp(txn))
  }

  function issueAuthCode(txn) {
    const raw = newSecret()
    const t = now()
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value)
    codes.set(shaHex(raw), {
      clientId: txn.clientId, redirectUri: txn.redirectUri, challenge: txn.challenge, resource: txn.resource, scope: grantedScope,
      requested: txn.requested, subject: 'operator', issuedAt: t, expiresAt: t + CODE_TTL_MS, retainUntil: t + CODE_RETAIN_MS, used: false, familyId: null,
    })
    markDirty()
    return raw
  }

  // A failed consent attempt draws from the shared failure bucket, and an empty bucket makes it a 429. An
  // approval that works never touches the bucket, so junk POSTs cannot keep the operator from approving.
  const consentFailure = (message, status = 400) => {
    const wait = limited('consent')
    return wait ? new PageError('Too many requests. Try again shortly.', 429, { 'Retry-After': String(wait) }) : new PageError(message, status)
  }

  async function authorizePost(req, res) {
    const buf = await readBody(req)
    if (mimeOf(req) !== 'application/x-www-form-urlencoded') throw consentFailure('Unsupported form encoding.')
    let parsed
    try {
      parsed = parseForm(buf.toString('utf8'))
    } catch {
      throw consentFailure('The form could not be read.')
    }
    const { values: form, dups } = parsed
    const txn = typeof form.txn === 'string' ? txns.get(form.txn) : undefined
    if (dups.size > 0 || !txn || txn.expiresAt <= now()) {
      if (txn) dropTxn(txn.id)
      throw consentFailure('This approval request expired or was already used. Start again from ChatGPT.')
    }
    if (form.action === 'deny') {
      dropTxn(txn.id)
      counters.consentDenied += 1
      log('consent_denied', { client: txn.clientId })
      return redirectError(res, txn.redirectUri, txn.state, 'access_denied', 'The operator denied the request')
    }
    if (form.action !== 'approve') throw consentFailure('Unknown action.')
    if (!consumePairing(form.pairing_code)) {
      txn.wrong += 1
      log('consent_wrong_code', { client: txn.clientId, txn: fingerprint(txn.id), attempts: txn.wrong })
      const wait = limited('consent')
      const locked = txn.wrong >= MAX_WRONG_CODES
      if (locked) {
        dropTxn(txn.id)
        counters.lockouts += 1
        log('consent_lockout', { client: txn.clientId })
      }
      if (wait) throw new PageError('Too many requests. Try again shortly.', 429, { 'Retry-After': String(wait) })
      if (locked) return redirectError(res, txn.redirectUri, txn.state, 'access_denied', 'Too many wrong pairing codes')
      const left = MAX_WRONG_CODES - txn.wrong
      return sendHtml(res, 200, consentHtml(txn, `That pairing code did not match. ${left} ${left === 1 ? 'try' : 'tries'} left.`), consentCsp(txn))
    }
    dropTxn(txn.id)
    const client = clients.get(txn.clientId)
    if (client) touchClient(client)
    const code = issueAuthCode(txn)
    counters.codesIssued += 1
    log('code_issued', { client: txn.clientId })
    return issRedirect(res, txn.redirectUri, [['code', code], ['state', txn.state]])
  }

  async function authorizeRoute(req, res) {
    if (req.method === 'GET') return authorizeGet(req, res)
    if (req.method === 'POST') return authorizePost(req, res)
    return methodNotAllowed(res, 'GET, POST')
  }

  // ---------------------------------------------------------------- /oauth/token

  function required(params, name) {
    const value = params[name]
    if (typeof value !== 'string' || value === '') throw new OAuthError('invalid_request', `${name} is required`)
    return value
  }

  const invalidGrant = why => new OAuthError('invalid_grant', why)

  function codeGrant(client, params) {
    const code = required(params, 'code')
    const redirectUri = required(params, 'redirect_uri')
    const verifier = required(params, 'code_verifier')
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier is malformed')
    const record = codes.get(shaHex(code))
    if (!record) throw invalidGrant('The authorization code is unknown or expired')
    if (record.used) {
      // RFC 6749 4.1.2: a replayed code means it may have leaked, so whatever it produced is revoked.
      // A code burned by a failed attempt never produced tokens, so there is nothing to revoke (or count).
      const family = record.familyId ? families.get(record.familyId) : null
      if (family && !family.revoked) {
        revokeFamily(family)
        counters.codeReuseRevocations += 1
        log('code_reuse_revoked', { client: record.clientId })
      } else {
        log('code_reuse_rejected', { client: record.clientId })
      }
      throw invalidGrant('The authorization code was already used')
    }
    // Checks that need no secret come first and do NOT burn the code: someone who merely holds a leaked code
    // (another client, a wrong redirect_uri, a late attempt) must not be able to destroy the real exchange.
    if (record.clientId !== client.id) throw invalidGrant('The authorization code was issued to another client')
    if (now() >= record.expiresAt) throw invalidGrant('The authorization code expired')
    if (!sameSecret(redirectUri, record.redirectUri)) throw invalidGrant('redirect_uri does not match the authorization request')
    if (params.resource !== undefined && !sameResource(params.resource)) throw new OAuthError('invalid_target', 'resource does not match the authorization request')
    // From here the attempt is against the code itself: burned right or wrong, so a verifier is guessed once.
    record.used = true
    markDirty()
    if (!sameSecret(b64u(sha(verifier)), record.challenge)) throw invalidGrant('The code_verifier does not match the code_challenge')
    const t = now()
    const family = {
      id: newId(), clientId: client.id, resource: record.resource, scope: record.scope, requested: record.requested, subject: record.subject,
      createdAt: t, refreshExpiresAt: t + cfg.refreshTtlSec * 1000, revoked: false, revokedAt: 0, chain: [],
    }
    addFamily(family)
    const access = newSecret()
    const refresh = newSecret()
    storeAccess(access, family, family.scope)
    storeRefresh(refresh, family)
    record.familyId = family.id
    counters.tokensIssued += 1
    touchClient(client)
    commit()
    log('token_issued', { client: client.id, grant: 'authorization_code' })
    return tokenBody(access, refresh, family.scope)
  }

  // A refresh request may repeat any scope token the client originally asked for, and any OpenID scope token
  // (ChatGPT registers "email offline_access profile" and authorizes with openid, none of which this server
  // acts on); anything else is an escalation. It may narrow the grant, but only down to a set that still holds
  // the main scope: a token that could not call the MCP route is never minted.
  function refreshScope(family, requestedText) {
    const tokens = parseScope(requestedText)
    if (tokens === null) throw new OAuthError('invalid_scope', 'scope is malformed')
    if (tokens.length === 0) return family.scope
    const granted = family.scope.split(' ')
    if (!tokens.every(t => granted.includes(t) || family.requested.includes(t) || OIDC_SCOPES.includes(t))) {
      throw new OAuthError('invalid_scope', 'The requested scope exceeds the original grant')
    }
    const narrowed = granted.filter(t => tokens.includes(t))
    return narrowed.includes(cfg.scope) ? narrowed.join(' ') : family.scope
  }

  function refreshGrant(client, params) {
    const raw = required(params, 'refresh_token')
    const record = refreshTokens.get(shaHex(raw))
    const family = record ? families.get(record.familyId) : null
    if (!record || !family || family.revoked) throw invalidGrant('The refresh token is unknown, expired or revoked')
    if (family.clientId !== client.id) throw invalidGrant('The refresh token was issued to another client')
    const t = now()
    if (t >= family.refreshExpiresAt) {
      log('refresh_expired', { client: client.id, ageSec: Math.round((t - family.createdAt) / 1000) })
      throw invalidGrant('The refresh token expired')
    }
    if (record.supersededAt !== null && t - record.supersededAt > cfg.graceMs) {
      // A rotated-out token showing up after the grace window is a stolen copy or a broken client: end the family.
      revokeFamily(family)
      counters.reuseRevocations += 1
      log('refresh_reuse_revoked', { client: client.id, staleSec: Math.round((t - record.supersededAt) / 1000) })
      throw invalidGrant('The refresh token was already used')
    }
    if (params.resource !== undefined && !sameResource(params.resource)) throw new OAuthError('invalid_target', 'resource does not match the grant')
    const scope = refreshScope(family, params.scope)
    if (record.supersededAt !== null) {
      // Inside the grace window: hand back the identical pair, unsealed with the predecessor the caller holds.
      const pair = openPair(raw, record.grace)
      if (!pair || record.successor !== shaHex(pair.refresh) || !refreshTokens.has(record.successor)) throw invalidGrant('The refresh token is unknown, expired or revoked')
      const existing = accessTokens.get(shaHex(pair.access))
      let granted = scope
      if (!existing) {
        storeAccess(pair.access, family, scope)
      } else {
        // Keep the scope it was first issued with; extend it unless someone revoked that very token.
        granted = existing.scope
        if (!existing.revoked) existing.expiresAt = t + accessTtlMs
      }
      counters.replaysWithinGrace += 1
      markDirty()
      log('refresh_replay_within_grace', { client: client.id })
      return tokenBody(pair.access, pair.refresh, granted)
    }
    const nextRefresh = newSecret()
    const nextAccess = newSecret()
    record.supersededAt = t
    record.successor = shaHex(nextRefresh)
    record.grace = sealPair(raw, nextRefresh, nextAccess)
    storeRefresh(nextRefresh, family)
    storeAccess(nextAccess, family, scope)
    counters.refreshes += 1
    counters.tokensIssued += 1
    touchClient(client)
    commit()
    log('refresh_rotated', { client: client.id })
    return tokenBody(nextAccess, nextRefresh, scope)
  }

  // A client that was handed a refresh token by the code grant may use it, whatever grant_types it listed.
  const grantAllowed = (client, grant) => client.grantTypes.includes(grant)
    || (grant === 'refresh_token' && client.grantTypes.includes('authorization_code'))

  // Successful issuance is bounded per client (far above what ChatGPT needs), and only successes pay, so
  // junk that names a client cannot use up that client's allowance.
  function clientBucket(id) {
    let bucket = clientBuckets.get(id)
    if (!bucket) {
      bucket = makeBucket(60, 1, now)
      clientBuckets.set(id, bucket)
    }
    return bucket
  }

  const tooMany = wait => new OAuthError('temporarily_unavailable', 'Too many requests; try again shortly', 429, { 'Retry-After': String(wait) })

  // Evaluated first, throttled second: only a request that FAILS draws from the shared bucket, and an empty
  // bucket turns that failure into a 429. A request that succeeds never touches it, so anonymous junk cannot
  // starve a valid refresh. Secrets are 256-bit, so failure-only limiting gives up no guessing protection.
  function throttledFailure(name, err) {
    const wait = limited(name)
    return wait ? tooMany(wait) : err
  }

  async function tokenRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    let body
    try {
      const params = await readParams(req)
      const grant = params.grant_type
      if (!grant) throw new OAuthError('invalid_request', 'grant_type is required')
      if (!GRANTS.includes(grant)) throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported')
      const client = authenticateClient(req, params)
      if (!grantAllowed(client, grant)) throw new OAuthError('unauthorized_client', 'This client may not use that grant type')
      const bucket = clientBucket(client.id)
      const wait = bucket.peek()
      if (wait) {
        counters.rateLimited += 1
        log('rate_limited', { endpoint: 'token_client' })
        throw tooMany(wait)
      }
      body = grant === 'authorization_code' ? codeGrant(client, params) : refreshGrant(client, params)
      bucket()
    } catch (err) {
      throw err instanceof OAuthError && err.status === 429 ? err : throttledFailure('token', err)
    }
    return sendJson(res, 200, body)
  }

  // ---------------------------------------------------------------- /oauth/revoke

  async function revokeRoute(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    try {
      const params = await readParams(req)
      const client = authenticateClient(req, params)
      const token = required(params, 'token')
      const hash = shaHex(token)
      const refresh = refreshTokens.get(hash)
      if (refresh) {
        const family = families.get(refresh.familyId)
        if (family && family.clientId === client.id && !family.revoked) {
          revokeFamily(family)
          counters.revocations += 1
          log('token_revoked', { client: client.id, type: 'refresh' })
        }
      } else {
        const access = accessTokens.get(hash)
        const family = access ? families.get(access.familyId) : null
        if (access && family && family.clientId === client.id && !access.revoked) {
          access.revoked = true
          counters.revocations += 1
          commit()
          log('token_revoked', { client: client.id, type: 'access' })
        }
      }
    } catch (err) {
      throw throttledFailure('revoke', err)
    }
    // RFC 7009: unknown, foreign and already-revoked tokens all look identical to the caller.
    return sendJson(res, 200, {})
  }

  // ---------------------------------------------------------------- protected resource helpers

  function authenticate(req) {
    const header = req.headers.authorization
    const fail = presented => {
      const err = new OAuthError('invalid_token', 'The access token is missing, malformed, unknown, expired or revoked', 401)
      err.presented = presented
      return err
    }
    if (typeof header !== 'string' || !/^bearer(\s|$)/i.test(header)) throw fail(false)
    const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header)
    if (!match || match[1].length > 512) throw fail(true)
    // This is the one secret check that any anonymous caller can probe on the public /mcp route, so it
    // compares the presented digest against EVERY live digest with no early exit. The table is small
    // (swept on expiry, bounded by the family cap), and every key is a validated 64-hex digest.
    const presented = sha(match[1])
    let record = null
    for (const [hash, candidate] of accessTokens) {
      if (crypto.timingSafeEqual(presented, Buffer.from(hash, 'hex'))) record = candidate
    }
    const family = record ? families.get(record.familyId) : null
    if (!record || !family || family.revoked || record.revoked || now() >= record.expiresAt) throw fail(true)
    // Audience binding: a grant issued for another resource (a state file carried to another host) is not valid here.
    if (family.resource !== cfg.resource) throw fail(true)
    return { clientId: family.clientId, scope: record.scope, expiresAt: record.expiresAt, resource: family.resource }
  }

  function challengeHeader(error) {
    const code = typeof error === 'string' ? error : (error && error.presented ? error.code : '')
    let value = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource${cfg.resourcePath}", scope="${cfg.scope}"`
    if (/^[a-z_]{1,40}$/.test(code)) value += `, error="${code}"`
    return value
  }

  // ---------------------------------------------------------------- dispatch

  const oauthRoutes = new Map([
    ['/oauth/authorize', authorizeRoute],
    ['/oauth/token', tokenRoute],
    ['/oauth/register', registerRoute],
    ['/oauth/revoke', revokeRoute],
  ])

  function fail(res, err) {
    if (res.writableEnded) return
    if (res.headersSent) {
      res.end()
      return
    }
    if (err instanceof OAuthError) {
      log('oauth_error', { error: err.code, status: err.status })
      sendOAuthError(res, err)
    } else if (err instanceof PageError) {
      sendHtml(res, err.status, errorHtml(err.message), ERROR_CSP, err.headers || {})
    } else {
      log('internal_error', { error: err && err.name })
      sendJson(res, 500, { error: 'server_error', error_description: 'Unexpected error' })
    }
  }

  async function handle(req, res, pathname) {
    if (typeof pathname !== 'string') return false
    const inWellKnown = pathname.startsWith('/.well-known/')
    if (!inWellKnown && !pathname.startsWith('/oauth/')) return false
    sweep()
    try {
      if (inWellKnown) wellKnownRoute(req, res, pathname)
      else if (oauthRoutes.has(pathname)) await oauthRoutes.get(pathname)(req, res)
      else notFound(res)
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  function stats() {
    return {
      ...counters,
      // Recorded so a Phase 0b run can say which lifetimes it measured.
      config: { accessTtlSec: cfg.accessTtlSec, refreshTtlSec: cfg.refreshTtlSec, refreshGraceSec: cfg.graceMs / 1000 },
      clients: clients.size,
      pendingTransactions: txns.size,
      pairings: pendingPairings(),
      codes: codes.size,
      families: families.size,
      accessTokens: accessTokens.size,
      refreshTokens: refreshTokens.size,
    }
  }

  function close() {
    flush()
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (locked) {
      locked = false
      releaseLock(lockPath)
    }
  }

  try {
    if (cfg.persistPath) {
      fs.mkdirSync(path.dirname(cfg.persistPath), { recursive: true })
      acquireLock(lockPath)
      locked = true
    }
    load()
    setupStaticClient()
    sweep(true)
  } catch (err) {
    if (locked) releaseLock(lockPath)
    throw err
  }
  log('server_started', { accessTtlSec: cfg.accessTtlSec, refreshTtlSec: cfg.refreshTtlSec, refreshGraceSec: cfg.graceMs / 1000, persistent: Boolean(cfg.persistPath) })

  return { handle, authenticate, challengeHeader, openPairing, pendingPairings, stats, close }
}
