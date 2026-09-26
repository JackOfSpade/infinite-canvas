// Fake handoff queue for the ChatGPT-MCP feasibility spike.
//
// Everything here is invented. Nothing reads the app's career data, canvases
// or any other app file, and nothing is imported from the app: the handoff-code
// format is copied from electron/ipc/nonApiAi.js on purpose so the model sees
// the same shape it sees in production.
import crypto from 'node:crypto'

export const STAGES = ['evidence_plan', 'resume', 'cover_letter', 'review']

export const HANDOFF_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const HANDOFF_CODE_SHAPE = /^HANDOFF-[2-9A-HJ-NP-Z]{6}$/

export const RESUME_MIN_BULLET_CHARS = 250
export const RESUME_MIN_TOTAL_BYTES = 12000

export const CORPUS = [
  ['E01', 'Led the migration of a 40-service monorepo to Kubernetes at Brightline Logistics, cutting deploy time from 45 to 6 minutes.'],
  ['E02', 'Built an internal feature-flag service used by 120 engineers at Brightline Logistics.'],
  ['E03', 'Reduced p99 API latency by 38% by adding read-through caching in front of the orders database.'],
  ['E04', 'Designed the on-call rotation and runbook system adopted by four product teams.'],
  ['E05', 'Automated quarterly access reviews, saving the security team about 200 hours per year.'],
  ['E06', 'Mentored six junior engineers; four were promoted within 18 months.'],
  ['E07', 'Shipped a warehouse-robot telemetry pipeline processing 2 million events per minute.'],
  ['E08', 'Cut cloud spend 22% ($410k per year) through right-sizing and spot-instance scheduling.'],
  ['E09', 'Wrote the incident postmortem template now used company-wide.'],
  ['E10', 'Led a zero-downtime Postgres 11 to 15 upgrade across 14 databases.'],
  ['E11', 'Built a self-service staging-environment provisioner (one command, under 3 minutes).'],
  ['E12', 'Introduced contract testing between 18 services, eliminating a class of integration outages.'],
  ['E13', 'Owned the CI system and reduced the flaky-test rate from 9% to under 1%.'],
  ['E14', 'Ran an internal talk series on distributed-systems failure modes (12 sessions).'],
  ['E15', 'Rolled out OpenTelemetry tracing across the checkout path, exposing a 700 ms serialization bottleneck.'],
  ['E16', 'Partnered with finance to build per-team cloud-cost dashboards.'],
  ['E17', 'Created an onboarding curriculum that cut time-to-first-PR for new hires from 9 days to 3.'],
  ['E18', 'Led the design of multi-region failover for the routing service (4-minute recovery-time objective).'],
  ['E19', 'Replaced a cron-based batch system with an event-driven workflow engine.'],
  ['E20', 'Drove infrastructure-as-code adoption; 95% of resources under Terraform within a year.'],
  ['E21', 'Built an anomaly-detection alerting layer that cut noisy pages by 60%.'],
  ['E22', 'Renegotiated a vendor contract, saving $90k per year.'],
  ['E23', 'Authored the API deprecation policy and tooling covering 30 public endpoints.'],
  ['E24', 'Ran a security-hardening sprint that closed 47 high-severity findings.'],
  ['E25', 'Prototyped a route-optimization service that improved delivery density by 8%.'],
  ['E26', 'Built a data-retention framework that fulfils GDPR deletion requests within 72 hours.'],
  ['E27', 'Led hiring for the platform team: 9 hires in 12 months with an 89% offer-accept rate.'],
  ['E28', 'Added load testing to the release process, catching 5 capacity regressions before release.'],
  ['E29', 'Maintains an open-source Kubernetes operator for job scheduling (1.1k GitHub stars).'],
  ['E30', 'Coordinated a company-wide disaster-recovery exercise involving 11 teams.'],
].map(([id, fact]) => ({ id, fact }))

export const CORPUS_IDS = CORPUS.map(item => item.id)

const JOB_TEMPLATES = [
  { company: 'Northwind Robotics', role: 'Senior Platform Engineer' },
  { company: 'Lumen Freight', role: 'Staff Infrastructure Engineer' },
  { company: 'Harbor Analytics', role: 'Principal Reliability Engineer' },
  { company: 'Cobalt Health Systems', role: 'Senior DevOps Engineer' },
]
export const MAX_JOBS = JOB_TEMPLATES.length

export function closingSentence(company) {
  return `I would welcome the chance to discuss how ${company} and I can build this together.`
}

export function newHandoffCode(taken = new Set()) {
  for (;;) {
    const bytes = crypto.randomBytes(6)
    let chars = ''
    for (let i = 0; i < 6; i++) chars += HANDOFF_CODE_ALPHABET[bytes[i] & 31]
    const code = `HANDOFF-${chars}`
    if (!taken.has(code)) return code
  }
}

function normalizeCode(value) {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return HANDOFF_CODE_SHAPE.test(code) ? code : null
}

// ---------------------------------------------------------------- prompts

function corpusBlock() {
  return CORPUS.map(item => `${item.id} — ${item.fact}`).join('\n')
}

function header(handoff) {
  const { job } = handoff
  return [
    `=== ${handoff.code} · ${handoff.stage} · job ${job.index + 1}/${job.total} ===`,
    `Handoff code: ${handoff.code}`,
    '',
    'SPIKE TEST — every name, number and employer below is fictional.',
    `Target role: ${job.role} at ${job.company}.`,
  ].join('\n')
}

const JSON_ONLY = 'Reply with ONE JSON object and nothing else: no code fence, no commentary before or after it.'

function buildPrompt(handoff) {
  const { job, code } = handoff
  switch (handoff.stage) {
    case 'evidence_plan':
      return [
        header(handoff),
        '',
        'TASK: from the evidence corpus below, choose the 8 to 12 items most relevant to the target role.',
        '',
        'EVIDENCE CORPUS',
        corpusBlock(),
        '',
        'RESPONSE FORMAT',
        JSON_ONLY,
        '{',
        `  "handoffCode": "${code}",`,
        '  "selectedEvidenceIds": ["E03", "E07"],   // 8 to 12 DISTINCT ids taken from the corpus above',
        '  "rationale": "one or two sentences on why these items fit (at least 40 characters)"',
        '}',
      ].join('\n')
    case 'resume':
      return [
        header(handoff),
        '',
        'TASK: write one résumé bullet for EVERY evidence item, E01 through E30. All 30, not only the ones you selected earlier.',
        `Each bullet must be at least ${RESUME_MIN_BULLET_CHARS} characters; aim for about 400. Expand the evidence with concrete scope, method and outcome, staying consistent with the fact given.`,
        `The whole response must be at least ${RESUME_MIN_TOTAL_BYTES.toLocaleString('en-US')} bytes. Write it out in full; do not abbreviate, elide or say "and so on".`,
        '',
        'EVIDENCE CORPUS',
        corpusBlock(),
        '',
        'RESPONSE FORMAT',
        JSON_ONLY,
        '{',
        `  "handoffCode": "${code}",`,
        '  "bullets": [',
        '    { "evidenceId": "E01", "text": "…bullet of at least 250 characters…" },',
        '    { "evidenceId": "E02", "text": "…" }',
        '    // …one entry per id, E01 to E30, in order',
        '  ]',
        '}',
      ].join('\n')
    case 'cover_letter': {
      const plan = job.data.plan ? job.data.plan.join(', ') : '(none recorded)'
      return [
        header(handoff),
        '',
        `TASK: write a cover letter for the role above, 3 or 4 paragraphs, each at least 150 characters. Draw on the evidence you selected earlier (${plan}).`,
        '',
        'RESPONSE FORMAT',
        JSON_ONLY,
        '{',
        `  "handoffCode": "${code}",`,
        '  "paragraphs": ["first paragraph…", "second paragraph…", "closing paragraph…"]',
        '}',
      ].join('\n')
    }
    case 'review': {
      const letter = (job.data.letter || []).join('\n\n')
      return [
        header(handoff),
        '',
        'TASK: review the cover letter below and return a verdict. "approve" if it is ready to send, otherwise "revise".',
        '',
        'COVER LETTER',
        letter,
        '',
        'RESPONSE FORMAT',
        JSON_ONLY,
        '{',
        `  "handoffCode": "${code}",`,
        '  "verdict": "approve",   // or "revise"',
        '  "notes": "at least 20 characters explaining the verdict"',
        '}',
      ].join('\n')
    }
    default:
      throw new Error(`unknown stage ${handoff.stage}`)
  }
}

// ------------------------------------------------------------- validators

// A model often wraps JSON in a ```json fence despite being told not to. The
// app's own parser would have to cope with that too, so tolerate it — but
// report it so RESULTS.md can say how often it happened.
export function parseJsonResponse(text) {
  let body = String(text).trim()
  let fenced = false
  const fence = /^```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n?```$/.exec(body)
  if (fence) {
    body = fence[1].trim()
    fenced = true
  }
  try {
    return { ok: true, value: JSON.parse(body), fenced }
  } catch (err) {
    return { ok: false, error: err.message, fenced }
  }
}

const fail = (reason, problems, code) => ({
  ok: false,
  reason,
  correction: `Rejected. ${problems.join(' ')} Fix exactly this and resubmit the complete JSON for ${code} (the whole object, not a patch).`,
})

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validateEvidencePlan(obj, handoff) {
  const problems = []
  const ids = obj.selectedEvidenceIds
  if (!Array.isArray(ids)) {
    problems.push('"selectedEvidenceIds" must be an array of evidence ID strings.')
  } else {
    const unknown = ids.filter(id => !CORPUS_IDS.includes(id))
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    const distinctValid = new Set(ids.filter(id => CORPUS_IDS.includes(id))).size
    if (unknown.length) problems.push(`Unknown evidence IDs: ${unknown.join(', ')} (valid IDs are E01 to E30).`)
    if (dupes.length) problems.push(`Duplicate IDs: ${dupes.join(', ')}.`)
    if (distinctValid < 8 || distinctValid > 12) problems.push(`Select 8 to 12 distinct valid IDs; you sent ${distinctValid}.`)
  }
  if (typeof obj.rationale !== 'string' || obj.rationale.trim().length < 40) {
    problems.push('"rationale" must be a string of at least 40 characters.')
  }
  if (problems.length) return fail('plan_invalid', problems, handoff.code)
  return { ok: true, data: { plan: [...new Set(obj.selectedEvidenceIds)] } }
}

function validateResume(obj, handoff, responseBytes) {
  const problems = []
  const bullets = obj.bullets
  if (!Array.isArray(bullets)) {
    return fail('resume_invalid', ['"bullets" must be an array of { evidenceId, text } objects.'], handoff.code)
  }
  const seen = new Map()
  const malformed = []
  const short = []
  const unknown = []
  bullets.forEach((entry, i) => {
    if (!isObject(entry) || typeof entry.evidenceId !== 'string' || typeof entry.text !== 'string') {
      malformed.push(i + 1)
      return
    }
    if (!CORPUS_IDS.includes(entry.evidenceId)) unknown.push(entry.evidenceId)
    seen.set(entry.evidenceId, (seen.get(entry.evidenceId) || 0) + 1)
    const len = entry.text.trim().length
    if (len < RESUME_MIN_BULLET_CHARS) short.push(`${entry.evidenceId} (${len})`)
  })
  const missing = CORPUS_IDS.filter(id => !seen.has(id))
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
  const reasons = []
  if (malformed.length) {
    problems.push(`Entries at positions ${malformed.join(', ')} are not { "evidenceId": string, "text": string }.`)
    reasons.push('malformed')
  }
  if (unknown.length) {
    problems.push(`Unknown evidence IDs: ${[...new Set(unknown)].join(', ')}.`)
    reasons.push('unknown_ids')
  }
  if (missing.length) {
    problems.push(`Missing evidence IDs (${missing.length}): ${missing.join(', ')}. All 30 IDs E01 to E30 must each appear once.`)
    reasons.push('missing_ids')
  }
  if (dupes.length) {
    problems.push(`Duplicate evidence IDs: ${dupes.join(', ')}.`)
    reasons.push('duplicate_ids')
  }
  if (short.length) {
    problems.push(`Bullets shorter than ${RESUME_MIN_BULLET_CHARS} characters (id, length): ${short.join(', ')}.`)
    reasons.push('short_bullets')
  }
  if (responseBytes < RESUME_MIN_TOTAL_BYTES) {
    problems.push(`The response is ${responseBytes.toLocaleString('en-US')} bytes but must be at least ${RESUME_MIN_TOTAL_BYTES.toLocaleString('en-US')}; lengthen the bullets (aim for about 400 characters each).`)
    reasons.push('too_small')
  }
  if (problems.length) return fail(`resume:${reasons.join('+')}`, problems, handoff.code)
  return { ok: true, data: { bulletCount: bullets.length } }
}

function validateCoverLetter(obj, handoff) {
  const problems = []
  const paragraphs = obj.paragraphs
  if (!Array.isArray(paragraphs) || paragraphs.some(p => typeof p !== 'string')) {
    return fail('letter_invalid', ['"paragraphs" must be an array of strings.'], handoff.code)
  }
  if (paragraphs.length < 3 || paragraphs.length > 4) problems.push(`Use 3 or 4 paragraphs; you sent ${paragraphs.length}.`)
  const short = paragraphs.map((p, i) => [i + 1, p.trim().length]).filter(([, n]) => n < 150)
  if (short.length) problems.push(`Paragraphs shorter than 150 characters (position, length): ${short.map(([i, n]) => `${i} (${n})`).join(', ')}.`)
  if (problems.length) return fail('letter_invalid', problems, handoff.code)
  return { ok: true, data: { letter: paragraphs.map(p => p.trim()) } }
}

function validateReview(obj, handoff) {
  const problems = []
  if (obj.verdict !== 'approve' && obj.verdict !== 'revise') problems.push('"verdict" must be exactly "approve" or "revise".')
  if (typeof obj.notes !== 'string' || obj.notes.trim().length < 20) problems.push('"notes" must be a string of at least 20 characters.')
  if (problems.length) return fail('review_invalid', problems, handoff.code)
  return { ok: true, data: { verdict: obj.verdict } }
}

const VALIDATORS = {
  evidence_plan: validateEvidencePlan,
  resume: validateResume,
  cover_letter: validateCoverLetter,
  review: validateReview,
}

// ------------------------------------------------------------------ queue

// `codes` lets a restarted server reissue the codes it handed out before, so a
// chat that is mid-flight when the server is bounced can carry on.
export function createQueue({ jobs = 1, now = Date.now, codes = null } = {}) {
  const count = Math.max(1, Math.min(MAX_JOBS, Number.isFinite(jobs) ? Math.floor(jobs) : 1))
  const handoffs = []
  const taken = new Set()
  for (let j = 0; j < count; j++) {
    const template = JOB_TEMPLATES[j]
    const job = { index: j, total: count, company: template.company, role: template.role, data: {} }
    for (const stage of STAGES) {
      const forced = codes ? normalizeCode(codes[handoffs.length]) : null
      if (codes && !forced) throw new Error(`CODES entry ${handoffs.length + 1} is missing or not a valid handoff code`)
      const code = forced ?? newHandoffCode(taken)
      if (taken.has(code)) throw new Error(`duplicate handoff code ${code}`)
      taken.add(code)
      handoffs.push({
        code, stage, job,
        status: 'pending',
        prompt: null,
        issuedAt: null,
        firstSubmitAt: null,
        acceptedAt: null,
        acceptedBytes: null,
        forcedRejectionDone: false,
        lastRejection: null,
        submits: [],
      })
    }
  }

  const current = () => handoffs.find(h => h.status !== 'accepted') || null
  const remaining = () => handoffs.filter(h => h.status !== 'accepted').length

  // The handoff to work on now, with its prompt built on first use. Serving it
  // is what starts its "issued" clock.
  function next() {
    const h = current()
    if (!h) return null
    if (h.prompt === null) h.prompt = buildPrompt(h)
    if (h.issuedAt === null) h.issuedAt = now()
    return h
  }

  function payload(h) {
    if (!h) {
      return {
        status: 'queue_empty',
        message: 'All handoffs are complete. Stop here and tell the user the queue is empty.',
      }
    }
    return {
      handoffCode: h.code,
      stage: h.stage,
      prompt: h.prompt,
      remainingHandoffs: remaining(),
      ...(h.lastRejection ? { lastRejection: h.lastRejection } : {}),
      howToFinish: 'Follow the prompt exactly, then call submit_handoff with this handoffCode and your complete answer as `response`.',
    }
  }

  // Returns { accepted, duplicate?, reason, correction?, handoff, flags }.
  // `flags` is observations for the report (fenced JSON, code rewritten...).
  function submit(codeArg, responseText) {
    const t = now()
    const flags = []
    const code = normalizeCode(codeArg)
    const target = code ? handoffs.find(h => h.code === code) : null
    const cur = current()
    const bytes = Buffer.byteLength(responseText, 'utf8')

    // `record: false` keeps a submit for the wrong handoff out of that
    // handoff's attempt history (it never got a real attempt).
    const reject = (handoff, reason, correction, record = true) => {
      if (handoff && record) {
        handoff.submits.push({ ts: t, bytes, accepted: false, reason, detail: correction })
        handoff.lastRejection = correction
      }
      return { accepted: false, reason, correction, handoff, flags }
    }

    if (!target) {
      flags.push('unknown_code')
      return reject(null, 'unknown_code', `"${String(codeArg).slice(0, 40)}" is not a known handoff code. ${cur ? `The pending handoff is ${cur.code} (${cur.stage}); use that exact code.` : 'The queue is empty.'}`)
    }
    if (target.status === 'accepted') {
      return { accepted: true, duplicate: true, reason: 'duplicate', handoff: target, flags: ['duplicate_submit'] }
    }
    if (target !== cur) {
      return reject(target, 'not_pending', `${target.code} is not the pending handoff yet. The pending handoff is ${cur.code} (${cur.stage}); submit that one.`, false)
    }
    if (target.firstSubmitAt === null) target.firstSubmitAt = t

    const parsed = parseJsonResponse(responseText)
    if (parsed.fenced) flags.push('fenced_json')
    if (!parsed.ok) {
      return reject(target, 'json_parse', `Rejected. The response is not valid JSON (${parsed.error}). Send only the single JSON object for ${target.code}, exactly as specified in the prompt.`)
    }
    if (!isObject(parsed.value)) {
      return reject(target, 'json_not_object', `Rejected. The response must be a single JSON object, not ${Array.isArray(parsed.value) ? 'an array' : typeof parsed.value}.`)
    }
    const stamped = parsed.value.handoffCode
    if (stamped === undefined) {
      flags.push('code_missing_in_json')
      return reject(target, 'code_missing', `Rejected. The JSON is missing the required "handoffCode" property; it must be "${target.code}".`)
    }
    if (normalizeCode(stamped) !== target.code) {
      flags.push('code_mismatch_in_json')
      return reject(target, 'code_mismatch', `Rejected. The JSON is stamped ${JSON.stringify(stamped)} but this handoff is ${target.code}. Copy the code exactly as printed in the prompt header.`)
    }

    const result = VALIDATORS[target.stage](parsed.value, target, bytes)
    if (!result.ok) return reject(target, result.reason, result.correction)

    if (target.stage === 'cover_letter') {
      const sentence = closingSentence(target.job.company)
      if (!target.forcedRejectionDone) {
        target.forcedRejectionDone = true
        return reject(target, 'forced_closing_sentence', `Rejected by the closing-line rule: the final paragraph must END with this exact sentence, verbatim (same words, same punctuation, nothing after it): "${sentence}" Fix the last paragraph and resubmit the complete JSON for ${target.code}.`)
      }
      const last = result.data.letter[result.data.letter.length - 1]
      if (!last.endsWith(sentence)) {
        return reject(target, 'closing_sentence_missing', `Rejected. The final paragraph must end with this exact sentence, verbatim: "${sentence}" It currently ends with: "${last.slice(-90)}"`)
      }
    }

    Object.assign(target.job.data, result.data)
    target.status = 'accepted'
    target.acceptedAt = t
    target.acceptedBytes = bytes
    target.lastRejection = null
    target.submits.push({ ts: t, bytes, accepted: true, reason: 'accepted', detail: null })
    return { accepted: true, reason: 'accepted', handoff: target, flags }
  }

  return {
    handoffs,
    current,
    next,
    payload,
    remaining,
    submit,
    isDrained: () => current() === null,
  }
}
