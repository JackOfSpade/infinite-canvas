// MCP server for the ChatGPT handoff feasibility spike.
//
// Streamable HTTP, STATELESS: every POST builds a fresh McpServer and
// transport (sessionIdGenerator: undefined), so ChatGPT's backend can hit it
// from any connection with no session to lose. The only state is the fake
// handoff queue, held in this process.
//
//   npm start                 -> 127.0.0.1:8787, one fake job
//   JOBS=2 npm start          -> two fake jobs, to test draining across jobs
//   PORT=9000 SSE=1 npm start -> other port / SSE instead of plain-JSON replies
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createQueue, MAX_JOBS } from './jobs.js'
import { buildReport, clock, createLogger, fmtBytes, fmtMs } from './spike-log.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 2 * 1024 * 1024

const GET_DESCRIPTION = [
  'Returns the next pending Infinite Canvas handoff as { handoffCode, stage, prompt }, or { status: "queue_empty" } when there is nothing left.',
  'Follow the returned prompt EXACTLY: it defines the required output format. Then send your complete answer with submit_handoff.',
  'Work through the queue continuously. After each accepted submission the next handoff comes back inline, so keep going immediately and never stop to ask the user anything until the queue is empty.',
].join(' ')

const SUBMIT_DESCRIPTION = [
  'Submits the complete answer to a handoff. `handoffCode` is the code from the prompt header (HANDOFF-XXXXXX); copy it exactly.',
  '`response` is the full answer text exactly as it would have been pasted back; for these prompts that is the single JSON object and nothing else.',
  'Returns { accepted: true, next: <the next handoff, inline, or queue_empty> } or { accepted: false, correction: "<specific fix>" }.',
  'If rejected, apply the correction and call submit_handoff again with the same handoffCode and the complete corrected answer.',
  'If accepted, continue IMMEDIATELY with the `next` handoff: do not ask the user, do not summarize, do not wait, until the result says queue_empty.',
].join(' ')

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    const tooLarge = () => Object.assign(new Error('request body too large'), { statusCode: 413 })
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(tooLarge())
      return
    }
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', chunk => {
      if (rejected) return
      size += chunk.length
      if (size > limit) {
        rejected = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', err => {
      if (!rejected) reject(err)
    })
  })
}

// Notes what an incoming JSON-RPC body is, for the access log: methods,
// tool names and the byte size of every string argument as it arrived.
function describeRpc(body, meta, state) {
  for (const message of Array.isArray(body) ? body : [body]) {
    if (!message || typeof message.method !== 'string') continue
    const entry = { method: message.method }
    if (message.method === 'initialize') {
      meta.clientInfo = message.params?.clientInfo ?? null
      meta.protocolVersion = message.params?.protocolVersion ?? null
      state.clientInfo = meta.clientInfo
    }
    if (message.method === 'tools/call') {
      entry.tool = message.params?.name ?? null
      entry.argBytes = Object.fromEntries(
        Object.entries(message.params?.arguments ?? {}).map(([key, value]) => [key, Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))]),
      )
    }
    meta.rpc.push(entry)
  }
}

function buildMcpServer({ queue, logger, state, onDrain }) {
  const mcp = new McpServer({ name: 'infinite-canvas-spike', version: '0.0.0' })

  mcp.registerTool(
    'get_handoff',
    {
      title: 'Get next handoff',
      description: GET_DESCRIPTION,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ts = Date.now()
      const handoff = queue.next()
      const text = JSON.stringify(queue.payload(handoff))
      const ms = Date.now() - ts
      logger.record('tool', {
        ts, ms,
        tool: 'get_handoff',
        argBytes: {},
        handoffCode: handoff?.code ?? null,
        stage: handoff?.stage ?? null,
        accepted: null,
        reason: handoff ? 'served' : 'queue_empty',
        resultBytes: Buffer.byteLength(text),
        clientInfo: state.clientInfo,
        flags: [],
      })
      logger.say(`${clock(ts)}  get_handoff     ${(handoff?.stage ?? '(queue empty)').padEnd(13)} ${handoff?.code ?? ''}  → ${handoff ? `served ${fmtBytes(Buffer.byteLength(text))}` : 'queue_empty'}  (${fmtMs(ms)})`)
      return { content: [{ type: 'text', text }] }
    },
  )

  mcp.registerTool(
    'submit_handoff',
    {
      title: 'Submit handoff answer',
      description: SUBMIT_DESCRIPTION,
      inputSchema: {
        handoffCode: z.string().describe('The handoff code from the prompt header, e.g. HANDOFF-K7Q3M2. Copy it exactly.'),
        response: z.string().describe('The complete answer text exactly as it would have been pasted back: for these prompts, the single JSON object and nothing else.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ handoffCode, response }) => {
      const ts = Date.now()
      const outcome = queue.submit(handoffCode, response)
      let body
      let nextHandoff = null
      if (outcome.accepted) {
        nextHandoff = queue.next()
        body = {
          accepted: true,
          ...(outcome.duplicate ? { duplicate: true, note: 'This handoff was already accepted; do not resubmit it.' } : {}),
          next: queue.payload(nextHandoff),
        }
      } else {
        body = {
          accepted: false,
          handoffCode: outcome.handoff?.code ?? queue.current()?.code ?? null,
          correction: outcome.correction,
        }
      }
      const text = JSON.stringify(body)
      const drained = outcome.accepted && !outcome.duplicate && queue.isDrained()
      const ms = Date.now() - ts
      const argBytes = { handoffCode: Buffer.byteLength(handoffCode), response: Buffer.byteLength(response) }
      const code = outcome.handoff?.code ?? handoffCode.slice(0, 40)
      logger.record('tool', {
        ts, ms,
        tool: 'submit_handoff',
        argBytes,
        handoffCode: code,
        stage: outcome.handoff?.stage ?? null,
        accepted: outcome.accepted,
        duplicate: Boolean(outcome.duplicate),
        reason: outcome.reason,
        correction: outcome.correction ?? null,
        nextStage: nextHandoff?.stage ?? null,
        resultBytes: Buffer.byteLength(text),
        clientInfo: state.clientInfo,
        flags: outcome.flags,
      })
      const verdict = outcome.accepted
        ? `✓ ACCEPTED${outcome.duplicate ? ' (duplicate)' : ''}${nextHandoff ? ` · next: ${nextHandoff.stage}` : ''}`
        : `✗ REJECTED (${outcome.reason})`
      logger.say(`${clock(ts)}  submit_handoff  ${(outcome.handoff?.stage ?? '?').padEnd(13)} ${code}  code ${argBytes.handoffCode} B, response ${fmtBytes(argBytes.response)}  → ${verdict}  (${fmtMs(ms)})`)
      if (drained) onDrain()
      return { content: [{ type: 'text', text }] }
    },
  )

  return mcp
}

export async function startServer(options = {}) {
  const {
    port = 8787,
    host = '127.0.0.1',
    token = crypto.randomBytes(16).toString('hex'),
    jobs = 1,
    logPath = path.join(HERE, 'spike-log.jsonl'),
    reportPath = path.join(HERE, 'spike-report.md'),
    quiet = false,
    sse = false,
    maxBodyBytes = MAX_BODY_BYTES,
  } = options

  const mcpPath = `/mcp/${token}`
  const startedAt = Date.now()
  const logger = createLogger({ logPath, token, quiet })
  const queue = createQueue({ jobs })
  const state = { clientInfo: null }

  function writeReport(trigger) {
    const markdown = buildReport({
      events: logger.events,
      handoffs: queue.handoffs,
      startedAt,
      endedAt: Date.now(),
      trigger,
      config: { jobs: queue.handoffs[queue.handoffs.length - 1].job.total, sse },
    })
    fs.writeFileSync(reportPath, markdown)
    return markdown
  }

  function onDrain() {
    logger.record('note', { message: 'queue_drained' })
    writeReport('queue drained')
    logger.say(`${clock(Date.now())}  *** QUEUE DRAINED: every handoff accepted. spike-report.md written; Ctrl+C rewrites it with anything that happens later. ***`)
  }

  async function handle(req, res) {
    const ts = Date.now()
    const url = new URL(req.url || '/', 'http://local')
    const meta = {
      method: req.method,
      path: url.pathname,
      route: url.pathname === mcpPath ? 'mcp' : 'other',
      ua: req.headers['user-agent'] ?? null,
      bytesIn: Number(req.headers['content-length']) || 0,
      rpc: [],
      clientInfo: null,
      protocolVersion: null,
    }

    res.once('close', () => {
      const status = res.statusCode
      logger.record('http', { ts, ms: Date.now() - ts, status, aborted: !res.writableFinished, ...meta })
      const isToolCall = meta.rpc.some(r => r.method === 'tools/call')
      if (status >= 400) {
        logger.say(`${clock(ts)}  ! ${meta.method} ${meta.path} → ${status}${meta.ua ? `  (${meta.ua})` : ''}`)
      } else if (!isToolCall) {
        logger.say(`${clock(ts)}  ${meta.method} ${meta.path} → ${status}  ${meta.rpc.map(r => r.method).join(', ')}${meta.clientInfo ? `  client: ${meta.clientInfo.name} ${meta.clientInfo.version ?? ''}`.trimEnd() : ''}`)
      }
    })

    if (meta.route !== 'mcp') {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
      return
    }

    let body
    try {
      body = JSON.parse(await readBody(req, maxBodyBytes))
    } catch (err) {
      if (err.statusCode === 413) {
        sendJson(res, 413, { jsonrpc: '2.0', error: { code: -32000, message: `Request body over ${maxBodyBytes} bytes.` }, id: null })
      } else {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      }
      return
    }
    describeRpc(body, meta, state)

    const mcp = buildMcpServer({ queue, logger, state, onDrain })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !sse })
    res.once('close', () => {
      mcp.close().catch(() => {})
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      logger.record('note', { message: 'handler_error', error: String(err?.stack || err) })
      logger.say(`${clock(Date.now())}  ! handler error: ${err?.message || err}`)
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
      else res.end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  logger.record('note', { message: 'server_start', port: server.address().port, jobs: queue.handoffs[queue.handoffs.length - 1].job.total, sse, handoffs: queue.handoffs.length })

  return {
    server,
    host,
    port: server.address().port,
    token,
    mcpPath,
    queue,
    logger,
    logPath,
    reportPath,
    writeReport,
    stop: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

function printBanner(spike, sse) {
  const local = `http://${spike.host}:${spike.port}${spike.mcpPath}`
  console.log(`
Infinite Canvas ChatGPT-handoff spike (fake data only)
======================================================
Listening on ${spike.host}:${spike.port}   ${spike.queue.handoffs.length} handoffs queued (JOBS=${spike.queue.handoffs[spike.queue.handoffs.length - 1].job.total}, max ${MAX_JOBS}), ${sse ? 'SSE' : 'plain-JSON'} replies

  MCP path (secret; regenerated every start):  ${spike.mcpPath}
  Local URL:                                   ${local}

Setup
  1. In another terminal:   cloudflared tunnel --url http://127.0.0.1:${spike.port}
       (brew install cloudflared, if missing). It prints https://<random>.trycloudflare.com
  2. The plugin URL is that address + ${spike.mcpPath}
  3. ChatGPT: https://chatgpt.com/plugins -> Add -> Create MCP App
       Name "Infinite Canvas Spike", the URL above, Authentication: No auth.
       (If your account has a Developer mode toggle: Settings -> Security and login.)
  4. Note your Codex/Work usage first: desktop app -> Settings -> Usage & billing.
  5. In the ChatGPT DESKTOP app: new chat -> enable the plugin (tools menu or @-mention), choose your
     usual model, then send:
       Use Infinite Canvas Spike: call get_handoff, follow the prompt exactly, submit with submit_handoff,
       fix and resubmit anything rejected, and keep going until the queue is empty. Don't stop to ask me
       between steps.
  6. Approve the first write confirmation with "remember for this conversation".
  7. Afterwards: Ctrl+C here (writes spike-report.md), stop cloudflared, delete the plugin in ChatGPT,
     and re-check Codex/Work usage.

Live log below. Full detail: spike-log.jsonl
`)
}

async function main() {
  const jobs = Number(process.env.JOBS || 1)
  const port = Number(process.env.PORT || 8787)
  const sse = process.env.SSE === '1'
  let spike
  try {
    spike = await startServer({ port, jobs, sse })
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or set PORT=<free port>.` : err)
    process.exit(1)
  }
  printBanner(spike, sse)

  let stopping = false
  const shutdown = async signal => {
    if (stopping) return
    stopping = true
    spike.writeReport(signal)
    console.log(`\n${signal}: wrote ${path.basename(spike.reportPath)}`)
    await spike.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
