// Logging and the end-of-run report for the ChatGPT-MCP handoff spike.
import fs from 'node:fs'

const pad = n => String(n).padStart(2, '0')

export function clock(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60000)
  return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`
}

export const fmtBytes = n => (n === null || n === undefined ? '—' : `${n.toLocaleString('en-US')} B`)

// The URL token is the only secret. It is stripped from every line before it
// reaches the log file, the terminal status lines or the in-memory events the
// report is built from, so nothing derived from a run can leak it.
export function createLogger({ logPath = null, token = null, quiet = false, print = console.log } = {}) {
  const events = []
  const redact = text => (token ? String(text).split(token).join('<token>') : String(text))

  function record(kind, fields = {}) {
    const ts = fields.ts ?? Date.now()
    const line = redact(JSON.stringify({ t: new Date(ts).toISOString(), ts, kind, ...fields }))
    events.push(JSON.parse(line))
    if (logPath) fs.appendFileSync(logPath, `${line}\n`)
    return events[events.length - 1]
  }

  const say = line => {
    if (!quiet) print(redact(line))
  }

  return { events, record, say, redact }
}

// ----------------------------------------------------------------- report

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

export function table(headers, rows) {
  if (!rows.length) return '_none_\n'
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
  ]
  return `${lines.join('\n')}\n`
}

export const count = (items, pick) => {
  const tally = new Map()
  for (const item of items) {
    const key = pick(item)
    tally.set(key, (tally.get(key) || 0) + 1)
  }
  return [...tally]
}

export function buildReport({ events, handoffs, startedAt, endedAt, trigger, config }) {
  const tools = events.filter(e => e.kind === 'tool').sort((a, b) => a.ts - b.ts)
  const https = events.filter(e => e.kind === 'http')
  const submits = tools.filter(e => e.tool === 'submit_handoff')
  const gets = tools.filter(e => e.tool === 'get_handoff')
  const accepted = submits.filter(e => e.accepted && !e.duplicate)
  const rejected = submits.filter(e => !e.accepted)
  const duplicates = submits.filter(e => e.duplicate)
  const done = handoffs.filter(h => h.status === 'accepted')

  const out = []
  out.push('# Spike report')
  out.push('')
  out.push(`Generated ${new Date(endedAt).toISOString()} · trigger: ${trigger} · server up ${fmtMs(endedAt - startedAt)} · JOBS=${config.jobs} · ${config.sse ? 'SSE' : 'JSON'} responses`)
  out.push('')

  // ---- summary
  out.push('## Summary')
  out.push('')
  const largest = done.reduce((best, h) => (!best || h.acceptedBytes > best.acceptedBytes ? h : best), null)
  const firstCall = tools[0]
  const lastCall = tools[tools.length - 1]
  const byStage = ['evidence_plan', 'resume', 'cover_letter', 'review']
    .map(stage => `${stage} ${done.filter(h => h.stage === stage).length}/${handoffs.filter(h => h.stage === stage).length}`)
    .join(', ')
  out.push(`- Stages completed: **${done.length} of ${handoffs.length}** (${byStage})${done.length === handoffs.length ? ' — queue fully drained' : ' — queue NOT drained'}`)
  out.push(`- Total \`submit_handoff\` calls: **${submits.length}** (accepted ${accepted.length}, rejected ${rejected.length}, duplicate ${duplicates.length}); \`get_handoff\` calls: ${gets.length}`)
  out.push(`- Largest accepted \`response\`: **${largest ? fmtBytes(largest.acceptedBytes) : '—'}**${largest ? ` (${largest.stage}, ${largest.code})` : ''}`)
  const wireResponses = submits.map(e => e.argBytes?.response ?? 0)
  out.push(`- Largest \`response\` argument seen on submit calls: ${fmtBytes(wireResponses.length ? Math.max(...wireResponses) : null)}`)
  if (firstCall && lastCall) {
    out.push(`- Tool-call window: ${clock(firstCall.ts)} → ${clock(lastCall.ts + (lastCall.ms || 0))} (${fmtMs(lastCall.ts + (lastCall.ms || 0) - firstCall.ts)}); this excludes any time you spent setting up before the first call`)
  } else {
    out.push('- No tool calls were made.')
  }
  const flagCounts = count(tools.flatMap(e => (e.flags || []).map(flag => ({ flag }))), item => item.flag)
  if (flagCounts.length) out.push(`- Observations: ${flagCounts.map(([flag, n]) => `${flag} ×${n}`).join(', ')}`)
  const httpToolCalls = https.flatMap(e => (e.rpc || []).filter(r => r.method === 'tools/call'))
  out.push(`- \`tools/call\` requests on the wire: ${httpToolCalls.length}; tool handler invocations: ${tools.length}${httpToolCalls.length === tools.length ? '' : ' — **mismatch** (a call the SDK rejected before the handler ran, e.g. bad arguments)'}`)
  out.push('')

  // ---- per stage
  out.push('## Per-stage timing')
  out.push('')
  out.push(table(
    ['Job', 'Stage', 'Code', 'Attempts', 'Issued → first submit', 'First submit → accepted', 'Issued → accepted', 'Accepted size'],
    handoffs.map(h => [
      `${h.job.index + 1}/${h.job.total}`,
      h.stage,
      h.code,
      h.submits.length,
      h.issuedAt && h.firstSubmitAt ? fmtMs(h.firstSubmitAt - h.issuedAt) : '—',
      h.firstSubmitAt && h.acceptedAt ? fmtMs(h.acceptedAt - h.firstSubmitAt) : '—',
      h.issuedAt && h.acceptedAt ? fmtMs(h.acceptedAt - h.issuedAt) : '—',
      h.status === 'accepted' ? fmtBytes(h.acceptedBytes) : h.issuedAt ? 'not accepted' : 'never issued',
    ]),
  ))

  // ---- rejections
  out.push('## Rejections')
  out.push('')
  const fixedCodes = new Set(done.map(h => h.code))
  out.push(table(
    ['Time', 'Stage', 'Code', 'Size', 'Reason', 'Fixed?', 'Correction sent (first 220 chars)'],
    rejected.map(e => [
      clock(e.ts),
      e.stage || '—',
      e.handoffCode || '—',
      fmtBytes(e.argBytes?.response),
      e.reason,
      !e.stage ? 'n/a — not tied to a handoff' : fixedCodes.has(e.handoffCode) ? 'yes — later accepted' : 'no — never accepted',
      (e.correction || '').slice(0, 220),
    ]),
  ))

  // ---- gaps
  out.push('## Gaps of more than 60 s between tool calls')
  out.push('')
  out.push('A long gap can mean the model stopped and waited for you (or a confirmation prompt sat unanswered).')
  out.push('')
  const gaps = []
  for (let i = 1; i < tools.length; i++) {
    const gap = tools[i].ts - (tools[i - 1].ts + (tools[i - 1].ms || 0))
    if (gap > 60000) {
      gaps.push([
        clock(tools[i - 1].ts + (tools[i - 1].ms || 0)),
        clock(tools[i].ts),
        fmtMs(gap),
        `${tools[i - 1].tool} ${tools[i - 1].stage || ''} → ${tools[i].tool} ${tools[i].stage || ''}`.replace(/\s+/g, ' '),
      ])
    }
  }
  out.push(table(['From', 'To', 'Gap', 'Between'], gaps))

  // ---- unknown / 4xx
  out.push('## Unknown paths and 4xx/5xx requests')
  out.push('')
  const odd = https.filter(e => e.status >= 400 || e.route === 'other')
  out.push(table(
    ['Method', 'Path', 'Status', 'Count', 'First seen', 'User-Agent'],
    count(odd, e => `${e.method} ${e.path} ${e.status}`).map(([key]) => {
      const first = odd.find(e => `${e.method} ${e.path} ${e.status}` === key)
      return [first.method, first.path, first.status, odd.filter(e => `${e.method} ${e.path} ${e.status}` === key).length, clock(first.ts), first.ua || '—']
    }),
  ))

  // ---- clients
  out.push('## Clients seen')
  out.push('')
  const infos = count(https.filter(e => e.clientInfo), e => JSON.stringify({ clientInfo: e.clientInfo, protocolVersion: e.protocolVersion }))
  out.push(infos.length ? infos.map(([info, n]) => `- initialize ×${n}: \`${info}\``).join('\n') : '_no initialize request seen_')
  out.push('')
  const agents = count(https.filter(e => e.ua), e => e.ua)
  out.push(agents.length ? agents.map(([ua, n]) => `- User-Agent ×${n}: \`${ua}\``).join('\n') : '_no User-Agent headers_')
  out.push('')

  return `${out.join('\n')}\n`
}
