// Realistic-payload fixture generator for the ChatGPT-MCP handoff spike.
//
//   node gen/gen-fixtures.js          (from scripts/chatgpt-handoff-spike)
//
// GENERATION-TIME ONLY. It loads the app's real prompt builder and validators in
// memory (see app-bridge.js), builds every stage prompt with the real
// pastePrompt(), builds a reference answer per stage, and checks each answer
// with the app's real validators before writing anything. The spike server only
// ever reads the static files this script writes under fixtures/realistic/.
//
// Nothing here reads user data: every input is synthetic (synthetic.js).
// Knobs (environment): SEED, OUT_DIR, GENERATED_AT (an ISO string, or "now"),
// ALLOW_VALIDATION_FAILURES=1 (write files even if a real validator objects).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCoverLetter, buildEvidencePlan, buildResume, buildReview, STAGE_NAMES, withEnvelope } from './answers.js'
import { createJobModel, gitDirtyPaths, gitHead, gitHeadDate, loadApp } from './app-bridge.js'
import { AS_OF, buildVariantContent, DEFAULT_SEED, PERSONA, SENTINELS, VARIANTS } from './synthetic.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const spikeDir = path.resolve(here, '..')
const repoRoot = path.resolve(spikeDir, '..', '..')
const outDir = path.resolve(process.env.OUT_DIR || path.join(spikeDir, 'fixtures', 'realistic'))
const seed = process.env.SEED === undefined ? DEFAULT_SEED : Number(process.env.SEED)
if (!Number.isSafeInteger(seed)) throw new Error(`SEED must be an integer, got ${JSON.stringify(process.env.SEED)}`)
const allowFailures = process.env.ALLOW_VALIDATION_FAILURES === '1'

const ENVELOPE_KEYS = ['protocol', 'jobId', 'stage', 'handoffCode', 'baseHashes']
const CONTACT_STRINGS = [PERSONA.name, PERSONA.email, PERSONA.phone, PERSONA.city, PERSONA.linkedin, PERSONA.github, PERSONA.portfolio]

// What a good answer for each stage has to carry, and how big it should be.
const EXPECT = {
  'evidence-plan': {
    requiredTopLevelKeys: [...ENVELOPE_KEYS, 'identity', 'evidence', 'requirements'],
    identityContact: CONTACT_STRINGS, quoteArrayPath: 'evidence', quoteField: 'quote', targetAnswerChars: [10000, 30000],
  },
  resume: {
    requiredTopLevelKeys: [...ENVELOPE_KEYS, 'resume'],
    identityContact: CONTACT_STRINGS, quoteArrayPath: null, quoteField: null, targetAnswerChars: [4000, 5000],
  },
  'cover-letter': {
    requiredTopLevelKeys: [...ENVELOPE_KEYS, 'coverLetter'],
    identityContact: CONTACT_STRINGS, quoteArrayPath: null, quoteField: null, targetAnswerChars: [4000, 5000],
  },
  // A passing review carries no identity block (only a replacement document
  // would), so there is nothing identity-shaped to require.
  review: {
    requiredTopLevelKeys: [...ENVELOPE_KEYS, 'decision', 'checklist', 'findings', 'qualityReview', 'generationAudit'],
    identityContact: [], quoteArrayPath: null, quoteField: null, targetAnswerChars: [22000, 32000],
  },
}

const problems = []
const note = (message) => problems.push(message)

function generatedAt() {
  const wanted = process.env.GENERATED_AT
  if (wanted === 'now') return new Date().toISOString()
  if (wanted) return new Date(wanted).toISOString()
  // Deterministic by design: the commit the prompts were built from, so two
  // runs on one commit are byte-identical.
  try { return gitHeadDate(repoRoot) } catch { return `${AS_OF}T00:00:00.000Z` }
}

function commit() {
  try { return gitHead(repoRoot) } catch { return 'unknown' }
}

const count = (text, needle) => text.split(needle).length - 1

/** Build, verify and return everything one variant needs. */
function buildVariant(app, variantId) {
  const content = buildVariantContent(seed, variantId)
  const model = createJobModel(app, content, { handoffCode: SENTINELS.handoffCode, createdAt: `${AS_OF}T14:00:00.000Z` })
  const plan = buildEvidencePlan(content)
  const resume = buildResume(content, plan)
  const letter = buildCoverLetter(content, plan)
  const review = buildReview(content, plan, resume, letter, {
    criteria: app.local.APPLICATION_QUALITY_CRITERIA,
    auditVersion: app.local.LOCAL_AI_GENERATION_AUDIT_VERSION,
    checklistVersion: app.local.APPLICATION_QUALITY_CHECKLIST_VERSION,
  })
  const bodies = [plan.body, resume, { coverLetter: letter.coverLetter }, review]

  const stages = []
  let state = model.initialState()
  model.assertFrozen(state)
  STAGE_NAMES.forEach((stage, index) => {
    const prompt = model.prompt(state)
    const answer = withEnvelope({
      jobId: content.jobId, stage, handoffCode: SENTINELS.handoffCode, baseHashes: state.baseHashes,
    }, bodies[index])
    const validatorErrors = model.validate(state, answer)
    validatorErrors.forEach(error => note(`${variantId} ${stage}: the app's validator rejects the reference answer: ${error}`))
    const next = model.accept(state, answer)
    let completionErrors = null
    if (stage === 'review') {
      completionErrors = model.completionErrors(next)
      completionErrors.forEach(error => note(`${variantId} ${stage}: the app's completion gate rejects the package: ${error}`))
    } else {
      model.assertFrozen(next)
    }
    stages.push({ stage, prompt, answer, answerText: JSON.stringify(answer), baseHashes: state.baseHashes, validatorErrors, completionErrors })
    state = next
  })
  return { content, model, stages }
}

/** Independent checks on the artifacts the server will rely on. */
function verifyVariant(variant) {
  const { content, model, stages } = variant
  const id = content.variant.id
  for (const item of stages) {
    const label = `${id} ${item.stage}`
    const expect = EXPECT[item.stage]
    if (count(item.prompt, SENTINELS.handoffCode) !== 1) note(`${label}: the prompt carries the handoff-code sentinel ${count(item.prompt, SENTINELS.handoffCode)} times, expected once`)
    const canaries = count(item.prompt, SENTINELS.canaryMarker) + count(item.prompt, SENTINELS.canaryUrl)
    if (content.variant.hostile ? canaries < 2 : canaries !== 0) note(`${label}: canary sentinels appear ${canaries} times in a ${content.variant.hostile ? 'hostile' : 'clean'} prompt`)
    if (count(item.answerText, SENTINELS.handoffCode) !== 1) note(`${label}: the answer carries the handoff-code sentinel ${count(item.answerText, SENTINELS.handoffCode)} times, expected once`)
    if (item.answerText.includes('@@')) note(`${label}: the reference answer contains a canary sentinel`)
    if (JSON.stringify(JSON.parse(item.answerText)) !== item.answerText) note(`${label}: the answer does not round-trip through JSON`)
    const keys = Object.keys(item.answer)
    if (JSON.stringify(keys.slice(0, 5)) !== JSON.stringify(ENVELOPE_KEYS)) note(`${label}: the five shared fields are not first, in order: ${keys.slice(0, 5).join(', ')}`)
    for (const key of expect.requiredTopLevelKeys) if (!(key in item.answer)) note(`${label}: missing required key ${key}`)
    for (const text of expect.identityContact) if (!item.answerText.includes(text)) note(`${label}: identity string ${JSON.stringify(text)} is absent from the answer`)
    const [min, max] = expect.targetAnswerChars
    if (item.answerText.length < min || item.answerText.length > max) note(`${label}: answer is ${item.answerText.length} chars, outside the target band ${min}-${max}`)
    if (expect.quoteArrayPath) {
      for (const entry of item.answer[expect.quoteArrayPath]) {
        const quote = entry[expect.quoteField]
        if (!model.careerData.includes(quote) && !model.jobListing.includes(quote)) note(`${label}: quote ${JSON.stringify(entry.id)} is not a raw substring of the corpus or the listing`)
      }
    }
  }
  const ids = new Set(content.roles.map(role => role.id))
  if (ids.size !== content.roles.length) note(`${id}: duplicate role ids`)
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function manifestEntry(variant) {
  const { content, stages } = variant
  const id = content.variant.id
  return {
    id,
    hostile: content.variant.hostile,
    jobId: content.jobId,
    persona: {
      name: PERSONA.name, email: PERSONA.email, phone: PERSONA.phone, city: PERSONA.city,
      linkedin: PERSONA.linkedin, github: PERSONA.github, portfolio: PERSONA.portfolio, degree: PERSONA.degree,
    },
    corpusFile: `${id}/career-corpus.txt`,
    listingFile: `${id}/listing.md`,
    stages: stages.map((item, index) => ({
      stage: item.stage,
      promptFile: `${id}/stage-${index + 1}-${item.stage}.txt`,
      promptChars: item.prompt.length,
      promptBytes: Buffer.byteLength(item.prompt, 'utf8'),
      baseHashes: item.baseHashes,
      answerFile: `${id}/answer-stage-${index + 1}-${item.stage}.json`,
      expect: EXPECT[item.stage],
    })),
  }
}

function writeVariant(entry, variant) {
  // Only this variant's own directory is replaced, so a regeneration leaves no stale files behind.
  fs.rmSync(path.join(outDir, entry.id), { recursive: true, force: true })
  writeFile(path.join(outDir, entry.corpusFile), variant.model.careerData)
  writeFile(path.join(outDir, entry.listingFile), variant.model.jobListing)
  entry.stages.forEach((stage, index) => {
    writeFile(path.join(outDir, stage.promptFile), variant.stages[index].prompt)
    writeFile(path.join(outDir, stage.answerFile), variant.stages[index].answerText)
  })
}

function sizeTable(variants) {
  const rows = [['variant', 'stage', 'prompt chars', 'prompt bytes', 'answer chars', 'validator', 'completion']]
  for (const variant of variants) {
    variant.stages.forEach((item) => {
      rows.push([
        variant.content.variant.id, item.stage, String(item.prompt.length), String(Buffer.byteLength(item.prompt, 'utf8')), String(item.answerText.length),
        item.validatorErrors.length ? `${item.validatorErrors.length} error(s)` : 'accepted',
        item.completionErrors === null ? '-' : item.completionErrors.length ? `${item.completionErrors.length} error(s)` : 'accepted',
      ])
    })
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)))
  return rows.map(row => row.map((cell, column) => (column >= 2 && column <= 4 ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ')).join('\n')
}

/** Read every written file back, the way the server will, and re-check what it relies on. */
function verifyWritten(manifest) {
  const read = (file) => fs.readFileSync(path.join(outDir, file), 'utf8')
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
  for (const variant of manifest.variants) {
    const corpus = read(variant.corpusFile)
    const listing = read(variant.listingFile)
    const answers = variant.stages.map(stage => JSON.parse(read(stage.answerFile)))
    // baseHashes recomputed from the written answers, the way the app derives them.
    const expectedHashes = [
      { evidencePlan: '', resume: '', coverLetter: '' },
      { evidencePlan: sha(JSON.stringify(answers[0])), resume: '', coverLetter: '' },
      { evidencePlan: sha(JSON.stringify(answers[0])), resume: sha(JSON.stringify(answers[1].resume)), coverLetter: '' },
      { evidencePlan: sha(JSON.stringify(answers[0])), resume: sha(JSON.stringify(answers[1].resume)), coverLetter: sha(JSON.stringify(answers[2].coverLetter)) },
    ]
    for (const [index, stage] of variant.stages.entries()) {
      if (JSON.stringify(stage.baseHashes) !== JSON.stringify(expectedHashes[index])) note(`${variant.id} ${stage.stage}: baseHashes do not match a recomputation from the written answers`)
      // The answer must echo the shared fields exactly as the prompt printed them.
      const printed = /Shared fields \(copy exactly\):\n([\s\S]*?)\n\nReproduce all/.exec(read(stage.promptFile))
      const shared = printed ? JSON.parse(printed[1]) : null
      const echoed = Object.fromEntries(ENVELOPE_KEYS.map(key => [key, answers[index][key]]))
      if (!shared || JSON.stringify(shared) !== JSON.stringify(echoed)) note(`${variant.id} ${stage.stage}: the answer does not echo the prompt's shared fields byte for byte`)
    }
    for (const stage of variant.stages) {
      const label = `${variant.id} ${stage.stage}`
      const prompt = read(stage.promptFile)
      if (prompt.length !== stage.promptChars || Buffer.byteLength(prompt, 'utf8') !== stage.promptBytes) note(`${label}: the prompt on disk does not match its manifest sizes`)
      if (!prompt.includes(`"jobId": "${variant.jobId}"`)) note(`${label}: the prompt does not carry the variant jobId in its shared fields`)
      const answer = answers[variant.stages.indexOf(stage)]
      if (answer.jobId !== variant.jobId || answer.stage !== stage.stage) note(`${label}: the answer's jobId or stage differs from the manifest`)
      if (JSON.stringify(answer.baseHashes) !== JSON.stringify(stage.baseHashes)) note(`${label}: the answer's baseHashes differ from the prompt's`)
      if (stage.expect.quoteArrayPath) {
        const bad = answer[stage.expect.quoteArrayPath].filter(item => !corpus.includes(item[stage.expect.quoteField]) && !listing.includes(item[stage.expect.quoteField]))
        if (bad.length) note(`${label}: ${bad.length} quote(s) are not raw substrings of the corpus or listing files as written`)
      }
    }
  }
}

async function main() {
  const app = await loadApp(repoRoot)
  try {
    const dirty = gitDirtyPaths(repoRoot, ['electron', 'src'])
    if (dirty.length) console.error(`note: uncommitted changes under electron/ or src/ (${dirty.length} file(s)); appSourceCommit names HEAD, not this working tree\n`)
  } catch { /* not a git checkout: the manifest records "unknown" */ }
  const variants = VARIANTS.map(({ id }) => buildVariant(app, id))
  variants.forEach(verifyVariant)
  console.log(sizeTable(variants))
  if (problems.length && !allowFailures) {
    console.error(`\n${problems.length} problem(s); nothing was written:`)
    problems.forEach(message => console.error(`  - ${message}`))
    process.exitCode = 1
    return
  }
  problems.forEach(message => console.error(`  WARNING (written anyway): ${message}`))

  const entries = variants.map(manifestEntry)
  const manifest = {
    generatedAt: generatedAt(),
    seed,
    appSourceCommit: commit(),
    sentinels: { handoffCode: SENTINELS.handoffCode, canaryMarker: SENTINELS.canaryMarker, canaryUrl: SENTINELS.canaryUrl },
    variants: entries,
  }
  entries.forEach((entry, index) => writeVariant(entry, variants[index]))
  writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  verifyWritten(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')))
  if (problems.length && !allowFailures) {
    console.error(`\n${problems.length} problem(s) found in the written files:`)
    problems.forEach(message => console.error(`  - ${message}`))
    process.exitCode = 1
    return
  }
  // What the app's own validators said about every reference answer.
  const verification = {
    appSourceCommit: manifest.appSourceCommit,
    seed,
    note: 'Each reference answer was checked in memory with validatePasteResponse(); the review answer also went through the completion gate (assemble + validateLocalApplicationResult). Empty lists mean accepted.',
    variants: variants.map(variant => ({
      id: variant.content.variant.id,
      stages: variant.stages.map(item => ({ stage: item.stage, validatorErrors: item.validatorErrors, completionErrors: item.completionErrors })),
    })),
  }
  writeFile(path.join(outDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`)
  console.log(`\nwrote ${VARIANTS.length} variants and manifest.json to ${outDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
