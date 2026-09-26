// End-to-end self-test for the spike server.
//
// Starts the real server (JOBS=2) on an ephemeral port and drives the whole
// flow with the MCP SDK's own Client + StreamableHTTPClientTransport: routing
// rules, tool metadata, every stage, a deliberately bad résumé, the forced
// cover-letter rejection, draining across two jobs, and the log/report files.
// Every step opens a NEW client, which also proves the server is stateless.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from './server.js'
import { CORPUS, CORPUS_IDS, RESUME_MIN_TOTAL_BYTES, closingSentence } from './jobs.js'

const CODE_SHAPE = /^HANDOFF-[2-9A-HJ-NP-Z]{6}$/
let passed = 0

async function step(name, fn) {
  try {
    await fn()
  } catch (err) {
    console.error(`  ✗ ${name}`)
    throw err
  }
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ------------------------------------------------------------ fixtures

const FILLER = ' The work was scoped with stakeholders, delivered in increments behind safeguards, measured against a baseline, and handed off with documentation so the improvement outlasted the project.'

function bulletText(id, len) {
  let text = CORPUS.find(item => item.id === id).fact
  while (text.length < len) text += FILLER
  return `${text.slice(0, len - 1).trimEnd()}.`
}

const goodPlan = code => ({
  handoffCode: code,
  selectedEvidenceIds: ['E01', 'E03', 'E07', 'E08', 'E10', 'E15', 'E18', 'E20'],
  rationale: 'These items show platform depth, cost control and reliability work that match the role.',
})

function resume(code, { len = 420, drop = [], shortId = null } = {}) {
  return {
    handoffCode: code,
    bullets: CORPUS_IDS.filter(id => !drop.includes(id)).map(id => ({ evidenceId: id, text: bulletText(id, id === shortId ? 120 : len) })),
  }
}

function letter(code, company, { closing }) {
  const body = n => `Paragraph ${n}: ${'I have spent years making infrastructure boring in the best sense, and I would like to bring that to the team. '.repeat(2)}`
  const paragraphs = [body(1), body(2), `${body(3)}${closing ? closingSentence(company) : 'Thank you for your time.'}`]
  return { handoffCode: code, paragraphs }
}

const review = (code, verdict = 'approve') => ({ handoffCode: code, verdict, notes: 'Reads well, the evidence is specific, and the closing lands.' })

// -------------------------------------------------------------- client

let mcpUrl
async function withClient(fn) {
  const client = new Client({ name: 'selftest-client', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(mcpUrl))
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

const call = (name, args = {}) => withClient(async client => {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, `tool error: ${JSON.stringify(result.content)}`)
  return JSON.parse(result.content[0].text)
})

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const getHandoff = () => call('get_handoff')
const submit = (handoffCode, response) => call('submit_handoff', { handoffCode, response: typeof response === 'string' ? response : JSON.stringify(response) })

async function main() {
  const watchdog = setTimeout(() => {
    console.error('selftest timed out')
    process.exit(2)
  }, 90000)
  watchdog.unref()

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-selftest-'))
  const logPath = path.join(workDir, 'spike-log.jsonl')
  const reportPath = path.join(workDir, 'spike-report.md')
  const token = crypto.randomBytes(16).toString('hex')
  const spike = await startServer({ port: 0, token, jobs: 2, logPath, reportPath, quiet: true })
  const base = `http://127.0.0.1:${spike.port}`
  mcpUrl = new URL(`${base}${spike.mcpPath}`)
  console.log(`selftest: server on ${base}, 2 jobs, ${spike.queue.handoffs.length} handoffs`)

  try {
    console.log('\nRouting and limits')
    await step('/.well-known probes and unknown paths return 404', async () => {
      for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/', '/mcp', `/mcp/${'0'.repeat(32)}`]) {
        const res = await fetch(`${base}${p}`)
        assert.equal(res.status, 404, p)
      }
    })
    await step('GET and DELETE on the MCP path return 405', async () => {
      for (const method of ['GET', 'DELETE']) {
        const res = await fetch(mcpUrl, { method })
        assert.equal(res.status, 405, method)
      }
    })
    await step('a body over 2 MB is refused with 413', async () => {
      const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(2.5 * 1024 * 1024) }) })
      assert.equal(res.status, 413)
    })
    await step('malformed JSON is refused with 400', async () => {
      const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
      assert.equal(res.status, 400)
    })

    console.log('\nTools')
    await step('server advertises both tools with the required annotations and instructions', async () => {
      await withClient(async client => {
        assert.equal(client.getServerVersion().name, 'infinite-canvas-spike')
        const { tools } = await client.listTools()
        const byName = Object.fromEntries(tools.map(t => [t.name, t]))
        assert.deepEqual(Object.keys(byName).sort(), ['get_handoff', 'submit_handoff'])
        assert.equal(byName.get_handoff.annotations.readOnlyHint, true)
        assert.equal(byName.submit_handoff.annotations.readOnlyHint, false)
        assert.equal(byName.submit_handoff.annotations.destructiveHint, false)
        assert.equal(byName.submit_handoff.annotations.openWorldHint, false)
        assert.deepEqual(Object.keys(byName.submit_handoff.inputSchema.properties).sort(), ['handoffCode', 'response'])
        for (const t of tools) {
          assert.match(t.description, /never stop to ask the user|do not ask the user/i, `${t.name} must say not to ask`)
        }
        assert.match(byName.get_handoff.description, /EXACTLY/)
        assert.match(byName.submit_handoff.description, /submit_handoff again/)
      })
    })

    console.log('\nJob 1')
    let plan
    await step('get_handoff serves evidence_plan with a well-formed code, idempotently', async () => {
      plan = await getHandoff()
      assert.equal(plan.stage, 'evidence_plan')
      assert.match(plan.handoffCode, CODE_SHAPE)
      assert.ok(plan.prompt.includes(`=== ${plan.handoffCode} · evidence_plan`))
      for (const id of CORPUS_IDS) assert.ok(plan.prompt.includes(`${id} —`), `corpus ${id}`)
      const again = await getHandoff()
      assert.equal(again.handoffCode, plan.handoffCode)
      assert.equal(again.prompt, plan.prompt)
    })
    await step('unknown code, non-JSON, wrong stamped code and a short plan are all rejected specifically', async () => {
      let r = await submit('HANDOFF-ZZZZZZ', goodPlan(plan.handoffCode))
      assert.equal(r.accepted, false)
      assert.ok(r.correction.includes(plan.handoffCode), 'names the pending code')
      r = await submit(plan.handoffCode, 'Sure! Here is my plan: E01, E03')
      assert.equal(r.accepted, false)
      assert.match(r.correction, /not valid JSON/)
      r = await submit(plan.handoffCode, { ...goodPlan(plan.handoffCode), handoffCode: 'HANDOFF-AAAAAA' })
      assert.equal(r.accepted, false)
      assert.ok(r.correction.includes('HANDOFF-AAAAAA') && r.correction.includes(plan.handoffCode))
      r = await submit(plan.handoffCode, { ...goodPlan(plan.handoffCode), selectedEvidenceIds: ['E01', 'E02', 'E99'] })
      assert.equal(r.accepted, false)
      assert.match(r.correction, /E99/)
      assert.match(r.correction, /8 to 12 distinct valid IDs; you sent 2/)
    })
    let resumeHandoff
    await step('a fenced but otherwise valid plan is accepted and returns the résumé inline', async () => {
      const r = await submit(plan.handoffCode, `\`\`\`json\n${JSON.stringify(goodPlan(plan.handoffCode), null, 2)}\n\`\`\``)
      assert.equal(r.accepted, true)
      resumeHandoff = r.next
      assert.equal(resumeHandoff.stage, 'resume')
      assert.match(resumeHandoff.handoffCode, CODE_SHAPE)
      assert.notEqual(resumeHandoff.handoffCode, plan.handoffCode)
      assert.ok(resumeHandoff.prompt.includes('EVERY evidence item'))
    })
    await step('a résumé missing E30 with one short bullet is rejected naming exactly those, and not the size', async () => {
      const r = await submit(resumeHandoff.handoffCode, resume(resumeHandoff.handoffCode, { drop: ['E30'], shortId: 'E05' }))
      assert.equal(r.accepted, false)
      assert.match(r.correction, /Missing evidence IDs \(1\): E30/)
      assert.match(r.correction, /E05 \(\d+\)/)
      assert.ok(!/bytes but must be/.test(r.correction), 'size was fine, so it must not be mentioned')
    })
    await step('a résumé with valid bullets but under 12,000 bytes is rejected for size only', async () => {
      const r = await submit(resumeHandoff.handoffCode, resume(resumeHandoff.handoffCode, { len: 260 }))
      assert.equal(r.accepted, false)
      assert.match(r.correction, /bytes but must be at least 12,000/)
      assert.ok(!/Missing/.test(r.correction) && !/shorter than/.test(r.correction))
    })
    let coverHandoff
    let resumeBytes
    await step('a full 30-bullet résumé over 12 KB is accepted intact', async () => {
      const body = JSON.stringify(resume(resumeHandoff.handoffCode))
      resumeBytes = Buffer.byteLength(body)
      assert.ok(resumeBytes >= RESUME_MIN_TOTAL_BYTES, `fixture is ${resumeBytes} bytes`)
      const r = await submit(resumeHandoff.handoffCode, body)
      assert.equal(r.accepted, true)
      coverHandoff = r.next
      assert.equal(coverHandoff.stage, 'cover_letter')
      assert.ok(coverHandoff.prompt.includes('E01, E03, E07'), 'cover-letter prompt carries the accepted plan')
    })
    let reviewHandoff
    await step('cover letter: first valid submission is rejected with the exact closing sentence, then enforced, then accepted', async () => {
      const company = 'Northwind Robotics'
      const sentence = closingSentence(company)
      let r = await submit(coverHandoff.handoffCode, letter(coverHandoff.handoffCode, company, { closing: false }))
      assert.equal(r.accepted, false)
      assert.ok(r.correction.includes(sentence), 'correction quotes the sentence')
      r = await submit(coverHandoff.handoffCode, letter(coverHandoff.handoffCode, company, { closing: false }))
      assert.equal(r.accepted, false)
      assert.match(r.correction, /It currently ends with/)
      r = await submit(coverHandoff.handoffCode, letter(coverHandoff.handoffCode, company, { closing: true }))
      assert.equal(r.accepted, true)
      reviewHandoff = r.next
      assert.equal(reviewHandoff.stage, 'review')
      assert.ok(reviewHandoff.prompt.includes(sentence), 'review prompt embeds the accepted letter')
    })
    let job2
    await step('review: bad verdict rejected, approve accepted, and job 2 starts inline', async () => {
      let r = await submit(reviewHandoff.handoffCode, review(reviewHandoff.handoffCode, 'maybe'))
      assert.equal(r.accepted, false)
      assert.match(r.correction, /"approve" or "revise"/)
      r = await submit(reviewHandoff.handoffCode, review(reviewHandoff.handoffCode))
      assert.equal(r.accepted, true)
      job2 = r.next
      assert.equal(job2.stage, 'evidence_plan')
      assert.ok(job2.prompt.includes('Lumen Freight'))
      assert.ok(job2.prompt.includes('job 2/2'))
    })
    await step('resubmitting an accepted handoff is a harmless duplicate that still returns the pending one', async () => {
      const r = await submit(reviewHandoff.handoffCode, review(reviewHandoff.handoffCode))
      assert.equal(r.accepted, true)
      assert.equal(r.duplicate, true)
      assert.equal(r.next.handoffCode, job2.handoffCode)
    })

    console.log('\nJob 2 (drain)')
    await step('job 2 drains; even a first cover letter that already has the closing sentence is rejected once', async () => {
      let r = await submit(job2.handoffCode, goodPlan(job2.handoffCode))
      assert.equal(r.accepted, true)
      const resume2 = r.next
      r = await submit(resume2.handoffCode, resume(resume2.handoffCode))
      assert.equal(r.accepted, true)
      const cover2 = r.next
      assert.equal(cover2.stage, 'cover_letter')
      r = await submit(cover2.handoffCode, letter(cover2.handoffCode, 'Lumen Freight', { closing: true }))
      assert.equal(r.accepted, false, 'the first otherwise-valid submission is always rejected')
      assert.ok(r.correction.includes(closingSentence('Lumen Freight')))
      r = await submit(cover2.handoffCode, letter(cover2.handoffCode, 'Lumen Freight', { closing: true }))
      assert.equal(r.accepted, true)
      const review2 = r.next
      r = await submit(review2.handoffCode, review(review2.handoffCode, 'revise'))
      assert.equal(r.accepted, true)
      assert.equal(r.next.status, 'queue_empty')
      assert.match(r.next.message, /queue is empty/)
    })
    await step('get_handoff now reports queue_empty', async () => {
      assert.equal((await getHandoff()).status, 'queue_empty')
    })

    console.log('\nLog and report')
    // The drain report is written just after the last response is sent.
    await waitFor(() => fs.existsSync(reportPath))
    const log = fs.readFileSync(logPath, 'utf8')
    const events = log.trim().split('\n').map(line => JSON.parse(line))
    const report = fs.readFileSync(reportPath, 'utf8')
    await step('nothing secret reaches the log or report', () => {
      assert.ok(!log.includes(token), 'token in log')
      assert.ok(!report.includes(token), 'token in report')
      assert.ok(log.includes('/mcp/<token>'))
    })
    await step('log records HTTP requests, tool calls, sizes, client info and user-agent', () => {
      const tools = events.filter(e => e.kind === 'tool')
      const https = events.filter(e => e.kind === 'http')
      assert.ok(https.some(e => e.status === 404 && e.route === 'other'), 'a logged 404')
      assert.ok(https.some(e => e.status === 405), 'a logged 405')
      assert.ok(https.some(e => e.status === 413), 'a logged 413')
      assert.ok(https.some(e => e.clientInfo?.name === 'selftest-client'), 'initialize clientInfo')
      assert.ok(https.some(e => e.ua), 'user-agent')
      assert.ok(https.some(e => e.rpc?.some(r => r.tool === 'submit_handoff' && r.argBytes.response >= RESUME_MIN_TOTAL_BYTES)), 'wire-level arg size')
      assert.ok(tools.some(e => e.tool === 'submit_handoff' && e.argBytes.response >= RESUME_MIN_TOTAL_BYTES && e.accepted === true), 'accepted large submit')
      assert.ok(tools.some(e => e.flags?.includes('fenced_json')), 'fenced JSON flagged')
      assert.ok(tools.some(e => e.reason === 'forced_closing_sentence'), 'forced rejection logged')
    })
    await step('report was written on drain with every required section and correct figures', () => {
      for (const heading of ['## Summary', '## Per-stage timing', '## Rejections', '## Gaps of more than 60 s', '## Unknown paths and 4xx/5xx requests', '## Clients seen']) {
        assert.ok(report.includes(heading), heading)
      }
      assert.match(report, /Stages completed: \*\*8 of 8\*\*/)
      assert.match(report, /queue fully drained/)
      // The final submit's own HTTP event must already be in the drain report,
      // otherwise the wire-vs-handler comparison cries "mismatch" on a clean run.
      assert.ok(!report.includes('**mismatch**'), 'drain report raced the last request')
      assert.match(report, /`tools\/call` requests on the wire: (\d+); tool handler invocations: \1\b/)
      const largest = /Largest accepted `response`: \*\*([\d,]+) B\*\*/.exec(report)
      assert.ok(largest, 'largest accepted line')
      assert.equal(Number(largest[1].replace(/,/g, '')), resumeBytes, 'largest accepted is the 30-bullet résumé')
      assert.match(report, /forced_closing_sentence[^\n]*yes — later accepted/)
      assert.match(report, /selftest-client/)
      const manual = spike.writeReport('manual')
      assert.ok(manual.includes('trigger: manual'))
    })

    console.log('\nRestart support')
    await step('a restarted server can reissue the same token and handoff codes', async () => {
      const codes = ['HANDOFF-LPSJR4', 'HANDOFF-PXPTPX', 'HANDOFF-97URVA', 'HANDOFF-SY3FGK', 'HANDOFF-CJQ5WX', 'HANDOFF-WVJ5F4', 'HANDOFF-HPTHGJ', 'HANDOFF-WQY7FH']
      const fixedToken = crypto.randomBytes(16).toString('hex')
      const again = await startServer({ port: 0, jobs: 2, token: fixedToken, codes, logPath: path.join(workDir, 'again-log.jsonl'), reportPath: path.join(workDir, 'again-report.md'), quiet: true })
      try {
        assert.equal(again.mcpPath, `/mcp/${fixedToken}`)
        assert.deepEqual(again.queue.handoffs.map(h => h.code), codes)
      } finally {
        await again.stop()
      }
      await assert.rejects(
        startServer({ port: 0, jobs: 2, codes: ['HANDOFF-LPSJR4'], logPath: path.join(workDir, 'bad-log.jsonl'), reportPath: path.join(workDir, 'bad-report.md'), quiet: true }),
        /CODES entry 2 is missing or not a valid handoff code/,
      )
    })

    console.log('\nSSE mode')
    await step('the same server also works with SSE responses (SSE=1)', async () => {
      const sseSpike = await startServer({ port: 0, jobs: 1, logPath: path.join(workDir, 'sse-log.jsonl'), reportPath: path.join(workDir, 'sse-report.md'), quiet: true, sse: true })
      try {
        const client = new Client({ name: 'selftest-sse', version: '0.0.1' })
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sseSpike.port}${sseSpike.mcpPath}`)))
        const result = await client.callTool({ name: 'get_handoff', arguments: {} })
        assert.equal(JSON.parse(result.content[0].text).stage, 'evidence_plan')
        await client.close()
      } finally {
        await sseSpike.stop()
      }
    })
  } finally {
    await spike.stop()
    fs.rmSync(workDir, { recursive: true, force: true })
  }

  console.log(`\nselftest passed: ${passed} steps`)
}

main().then(
  () => process.exit(0),
  err => {
    console.error(`\nselftest FAILED after ${passed} passing steps:\n`, err)
    process.exit(1)
  },
)
