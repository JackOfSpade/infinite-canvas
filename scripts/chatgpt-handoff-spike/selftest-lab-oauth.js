// Integration test for plugin D: the lab server with the OAuth authorization server of oauth.js
// wired in (the protected /mcp path, the 401 challenge, the well-known documents, the consent
// page, token use, expiry, refresh, revocation, restart, the report section and secret redaction).
//
// oauth.js has its own 100-step suite (selftest-oauth.js); this file only checks the wiring in
// server.js and design-tools.js. It needs the generated fixtures (npm run gen) and skips without them.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from './server.js'
import { SURFACES } from './design-tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'realistic')
const ISSUER = 'https://lab.example.test'
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const b64u = buf => Buffer.from(buf).toString('base64url')
let passed = 0

async function step(name, fn) {
  try {
    await fn()
  } catch (err) {
    console.error(`  x ${name}`)
    throw err
  }
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  if (!fs.existsSync(path.join(FIXTURES, 'manifest.json'))) {
    console.log('selftest-lab-oauth: no generated fixtures (run "npm run gen"); skipped')
    return
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-oauth-'))
  const statePath = path.join(workDir, 'oauth-state.json')
  const logPath = path.join(workDir, 'log.jsonl')
  const reportPath = path.join(workDir, 'report.md')
  const secrets = []
  const options = () => ({
    port: 0, surface: 'design', fixturesDir: FIXTURES, plan: 'clean-medium:1:plugin=D', logPath, reportPath, quiet: true, publicBase: ISSUER,
    oauth: { surface: 'v2', issuer: ISSUER, accessTtlSec: 2, refreshTtlSec: 3600, refreshGraceSec: 30, persistPath: statePath },
  })
  let lab = await startServer(options())
  let base = `http://127.0.0.1:${lab.port}`
  const D = lab.plugins.find(p => p.id === 'D')

  // ---------------------------------------------------------------- helpers
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const form = (url, fields) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
  async function register() {
    const res = await post(`${base}/oauth/register`, { redirect_uris: [REDIRECT], client_name: 'ChatGPT', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'email offline_access profile' })
    assert.equal(res.status, 201)
    return (await res.json()).client_id
  }
  // The whole link: authorize page, pairing code, code, token exchange. Returns the token response.
  async function link(clientId) {
    const verifier = b64u(crypto.randomBytes(32))
    secrets.push(verifier)
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest())
    const state = `openai_platform_oauth_relay__${b64u(crypto.randomBytes(40))}`
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256', resource: `${ISSUER}/mcp`, scope: 'openid email offline_access' })
    // The operator arms a pairing session on the Mac first; only then does the authorize page start a link.
    const pairing = lab.oauth.openPairing()
    secrets.push(pairing)
    const page = await fetch(`${base}/oauth/authorize?${query}`)
    assert.equal(page.status, 200)
    const html = await page.text()
    const txn = /name="txn" value="([^"]+)"/.exec(html)[1]
    const approved = await form(`${base}/oauth/authorize`, { txn, pairing_code: pairing, action: 'approve' })
    assert.equal(approved.status, 302)
    const back = new URL(approved.headers.get('location'))
    assert.equal(back.origin + back.pathname, REDIRECT)
    assert.equal(back.searchParams.get('state'), state, 'long opaque state comes back byte for byte')
    assert.equal(back.searchParams.get('iss'), ISSUER)
    const code = back.searchParams.get('code')
    secrets.push(code)
    const tokenRes = await form(`${base}/oauth/token`, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId, resource: `${ISSUER}/mcp` })
    assert.equal(tokenRes.status, 200)
    const tokens = await tokenRes.json()
    secrets.push(tokens.access_token, tokens.refresh_token)
    return tokens
  }
  async function refresh(clientId, refreshToken) {
    const res = await form(`${base}/oauth/token`, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
    const body = await res.json()
    if (body.access_token) secrets.push(body.access_token, body.refresh_token)
    return { status: res.status, body }
  }
  const withBearer = async (token, fn) => {
    const client = new Client({ name: 'oauth-selftest', version: '0.0.1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    try {
      return await fn(client)
    } finally {
      await client.close()
    }
  }
  const rpc = (token, body) => post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, ...body }, token ? { Authorization: `Bearer ${token}` } : {})

  try {
    console.log('Protected path and discovery')
    await step('the OAuth plugin is the fixed path /mcp, registered alongside the secret-path plugins, and plugin A is untouched', async () => {
      assert.equal(D.mcpPath, '/mcp')
      assert.equal(D.auth, true)
      assert.equal(lab.oauthIssuer, ISSUER)
      const noAuthTools = await (async () => {
        const client = new Client({ name: 'oauth-selftest', version: '0.0.1' })
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${lab.mcpPath}`)))
        try {
          return (await client.listTools()).tools
        } finally {
          await client.close()
        }
      })()
      assert.equal(noAuthTools.length, 2, 'plugin A still answers without a token')
    })
    await step('no bearer token: POST and GET /mcp answer 401 with the WWW-Authenticate challenge ChatGPT needs, before the method or body is looked at', async () => {
      const wanted = `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="handoff"`
      const res = await rpc(null, { method: 'tools/list' })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('www-authenticate'), wanted)
      assert.equal((await res.json()).error, 'invalid_token')
      const get = await fetch(`${base}/mcp`)
      assert.equal(get.status, 401)
      assert.equal(get.headers.get('www-authenticate'), wanted)
      const junk = await post(`${base}/mcp`, 'not json at all', { Authorization: 'Bearer nonsense' })
      assert.equal(junk.status, 401)
      assert.equal(junk.headers.get('www-authenticate'), `${wanted}, error="invalid_token"`, 'a presented but unknown token adds error="invalid_token"')
    })
    await step('discovery: both protected-resource paths and both authorization-server paths answer, with iss support and CIMD advertised', async () => {
      const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()
      assert.equal(prm.resource, `${ISSUER}/mcp`)
      assert.deepEqual(prm.authorization_servers, [ISSUER])
      assert.deepEqual(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json(), prm)
      const as1 = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
      const as2 = await (await fetch(`${base}/.well-known/openid-configuration`)).json()
      assert.deepEqual(as1, as2)
      assert.equal(as1.issuer, ISSUER)
      assert.equal(as1.authorization_response_iss_parameter_supported, true)
      assert.equal(as1.client_id_metadata_document_supported, true)
      assert.ok(as1.code_challenge_methods_supported.includes('S256'))
      assert.equal(as1.token_endpoint, `${ISSUER}/oauth/token`)
      assert.equal((await fetch(`${base}/.well-known/nothing`)).status, 404)
    })

    console.log('\nLinking')
    await step('a link attempt with no pairing session open is refused and counted; nothing reaches the pairing table', async () => {
      const clientId = await register()
      const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's', code_challenge: b64u(crypto.randomBytes(32)), code_challenge_method: 'S256', resource: `${ISSUER}/mcp` })
      const res = await fetch(`${base}/oauth/authorize?${query}`)
      assert.equal(res.status, 403)
      assert.equal(lab.oauth.stats().unarmedAuthorize, 1)
      assert.equal(lab.oauth.pendingPairings(), 0)
    })
    let clientId
    let tokens
    await step('arm, register (DCR with the scope ChatGPT registers), approve on the consent page with the pairing code, exchange the code with PKCE', async () => {
      clientId = await register()
      tokens = await link(clientId)
      assert.equal(tokens.token_type, 'Bearer')
      assert.equal(tokens.expires_in, 2)
      assert.ok(tokens.refresh_token)
      assert.equal(lab.oauth.stats().pairings, 0, 'the pairing code was single use')
    })

    console.log('\nUsing the token')
    await step('a valid token lists the reworded tools with securitySchemes, and a call is tagged with plugin D, the client fingerprint and the time the token had left', async () => {
      await withBearer(tokens.access_token, async client => {
        const { tools } = await client.listTools()
        const by = Object.fromEntries(tools.map(t => [t.name, t]))
        assert.equal(by.submit_handoff.description, SURFACES.v2.submitDescription)
        assert.deepEqual(by.get_handoff._meta.securitySchemes, [{ type: 'oauth2', scopes: ['handoff'] }])
        const res = await client.callTool({ name: 'get_handoff', arguments: { session: lab.hub.sessions[0].code } })
        assert.equal(JSON.parse(res.content[0].text).status, 'served')
      })
      const ev = lab.logger.events.filter(e => e.kind === 'tool' && e.plugin === 'D').pop()
      assert.equal(ev.surfaceId, 'v2')
      assert.match(ev.authClient, /^[0-9a-f]{8}$/)
      assert.ok(ev.authRemainingSec >= 0 && ev.authRemainingSec <= 2, `remaining ${ev.authRemainingSec}`)
      assert.ok(lab.logger.events.some(e => e.kind === 'http' && e.plugin === 'D' && e.auth === 'ok' && e.status === 200))
    })
    await step('after the access token expires the same call is 401 (auth invalid) and a refresh returns a working pair', async () => {
      await sleep(2300)
      const expired = await rpc(tokens.access_token, { method: 'tools/list' })
      assert.equal(expired.status, 401)
      assert.match(expired.headers.get('www-authenticate'), /error="invalid_token"/)
      const r = await refresh(clientId, tokens.refresh_token)
      assert.equal(r.status, 200)
      assert.notEqual(r.body.access_token, tokens.access_token)
      tokens = { ...tokens, ...r.body, previous: tokens.refresh_token }
      const ok = await rpc(tokens.access_token, { method: 'tools/list' })
      assert.equal(ok.status, 200)
    })
    await step('a replay of the old refresh token inside the grace window returns the identical pair; the new refresh token rotates again', async () => {
      const replay = await refresh(clientId, tokens.previous)
      assert.equal(replay.status, 200)
      assert.equal(replay.body.access_token, tokens.access_token)
      assert.equal(replay.body.refresh_token, tokens.refresh_token)
      const again = await refresh(clientId, tokens.refresh_token)
      assert.equal(again.status, 200)
      assert.notEqual(again.body.refresh_token, tokens.refresh_token)
      tokens = { ...tokens, ...again.body }
    })
    await step('revoking the refresh token ends the grant: the access token is refused on the next call', async () => {
      const res = await form(`${base}/oauth/revoke`, { token: tokens.refresh_token, client_id: clientId })
      assert.equal(res.status, 200)
      assert.equal((await rpc(tokens.access_token, { method: 'tools/list' })).status, 401)
      assert.equal((await refresh(clientId, tokens.refresh_token)).status, 400)
    })

    console.log('\nReporting and restart')
    await step('the report has an OAuth section: lifetimes, events, 401s, token lifetime left, and refresh timing before and after expiry', () => {
      const markdown = lab.writeReport('manual')
      assert.match(markdown, /## OAuth \(plugin D\)/)
      assert.match(markdown, /Lifetimes measured in this run: access token 2 s, refresh token 3600 s absolute, refresh grace 30 s/)
      assert.match(markdown, /D "Infinite Canvas Lab D" \(tool text v2, OAuth|D "Infinite Canvas Lab D" \(tool text v2, /)
      for (const wanted of ['client_registered', 'token_issued', 'refresh_rotated', 'refresh_replay_within_grace', 'token_revoked', 'authorize_unarmed']) assert.ok(markdown.includes(wanted), wanted)
      assert.match(markdown, /POST \/mcp → 401 \(auth invalid\)/)
      assert.match(markdown, /POST \/mcp → 401 \(auth none\)/)
      assert.match(markdown, /Token lifetime left at each tool call: min \d+ s, median \d+ s, max \d+ s over 1 calls/)
      assert.match(markdown, /\| after expiry \|/, 'a refresh after the token had expired is named as such')
      assert.match(markdown, /\| before expiry \|/, 'and one before')
      assert.match(markdown, /Timeline \(first 80 rows\)/)
      assert.match(markdown, /\| mcp 401 \|/)
    })
    await step('the link survives a server restart: the refresh token issued before it still works after', async () => {
      const id2 = await register()
      const before = await link(id2)
      await lab.stop()
      lab = await startServer(options())
      base = `http://127.0.0.1:${lab.port}`
      const r = await refresh(id2, before.refresh_token)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal((await rpc(r.body.access_token, { method: 'tools/list' })).status, 200)
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600, 'the state file is private')
      const disk = fs.readFileSync(statePath, 'utf8')
      assert.ok(!disk.includes(r.body.refresh_token) && !disk.includes(r.body.access_token), 'no raw token on disk')
    })
    await step('a session can only be planned on plugin D when OAuth is configured, and D needs a known tool surface', async () => {
      await assert.rejects(startServer({ ...options(), oauth: null, logPath: path.join(workDir, 'x.jsonl'), reportPath: path.join(workDir, 'x.md') }), /asks for plugin D/)
      await assert.rejects(startServer({ ...options(), oauth: { surface: 'nope' }, logPath: path.join(workDir, 'y.jsonl'), reportPath: path.join(workDir, 'y.md') }), /Unknown tool surface/)
    })
    await step('no token, code, verifier or pairing code reached the log or the report', () => {
      const log = fs.readFileSync(logPath, 'utf8')
      const report = fs.readFileSync(reportPath, 'utf8')
      assert.ok(secrets.length >= 8)
      for (const secret of secrets) {
        assert.ok(!log.includes(secret) && !report.includes(secret), 'a secret value leaked')
      }
      assert.ok(log.includes('"oauthEvent"'), 'oauth events are recorded')
    })
  } finally {
    await lab.stop()
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  console.log(`\nselftest-lab-oauth passed: ${passed} steps`)
}

main().then(
  () => process.exit(0),
  err => {
    console.error(`\nselftest-lab-oauth FAILED after ${passed} passing steps:\n`, err)
    process.exit(1)
  },
)
