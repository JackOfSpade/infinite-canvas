#!/usr/bin/env node
/*
 * Offline application simulator.
 *
 * A development tool that lets a stand-in writer (an LLM agent, or a scripted
 * writer) drive the REAL host stages of one application end to end, in
 * process, with no Electron app, no ChatGPT and no bridge. The host side is
 * the production code, not a copy of it:
 *
 *   - the handoff is read and the response is submitted through the exact two
 *     functions the bridge's application source calls
 *     (getLocalApplicationHandoff / submitLocalApplicationHandoff in
 *     electron/ipc/localAiApplication.js), via the bridge's own
 *     createApplicationSource adapter and handoff-code guard;
 *   - what a chat would be served (status, instructions, code, corrections,
 *     correctionPrompt) is built by the bridge's own framing
 *     (makeServedBody / makeRejectedBody / makeResultBody), and a submission is
 *     classified by the bridge's own pre-source classifier
 *     (classifySubmission: junk / misrouted / superseded) before the app sees it;
 *   - after an accepted answer that carries no successor the simulator does what
 *     the engine does for a host lane: poll localApplicationStatus, map it with
 *     mapApplicationStatus, and read again when the app reopened a round.
 *
 * It is a SIMULATOR: a stand-in writer is not ChatGPT, nothing renders a PDF
 * (no Electron print), and one writer serves one lane serially (the engine's
 * parallel career-match workers are played one task at a time). See the README
 * section "Offline simulator" for the limits.
 *
 * Run it under the Electron test stub, from the repository root:
 *
 *   node --import ./scripts/test-stubs/register.mjs \
 *     .test-artifacts/blackbox-run/offline-simulator.mjs <command> [options]
 *
 * Commands (exit codes: 0 ok, 1 tool error, 2 usage, 3 the host rejected the answer):
 *   init   --card affirm|anthropic|node:<id>|synthetic[:key] --dir DIR
 *   next   --dir DIR [--auto-ack] [--reread] [--json]
 *   submit --dir DIR --file response.json [--code CODE] [--auto-ack] [--json]
 *   status --dir DIR [--json]
 *   docs   --dir DIR
 *   log    --dir DIR [--json]
 *   serve  --dir DIR [--auto-ack] [--spool]
 *   autoplay --dir DIR [--max-handoffs N] [--findings-cycles N] [--allow-rejections]
 *
 * SAFETY. init refuses a DIR that is not empty, that sits inside (or contains)
 * the real Electron user-data root, the folder of the real canvas, or any
 * "Applied Jobs" / ".local-ai" folder. Every command points the Electron
 * stub's userData at DIR/userData before any production module is imported, and
 * installs a deny-list write guard over the node fs APIs: a write into a
 * protected real location throws instead of happening. The real career snapshot
 * file and the real canvas are only ever READ (a byte copy of one snapshot
 * file and a JSON read of one card).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const REPO_ROOT = path.resolve(HERE, '..', '..');

const RUN_MANIFEST = 'simulator.json';
const RUN_STATE = 'sim-state.json';
const EVENT_LOG = 'events.jsonl';
const INIT_MARKER = '.simulator-init-incomplete';
const LOCK_FILE = '.simulator.lock';
const WRITER_MEMORY = 'scripted-writer.json';
const RUN_VERSION = 1;
const SIMULATOR_V2_DEFAULT_CANDIDATES = 5;

// The real, read-only sources. Both are overridable (the test suite points
// them at synthetic fixtures); neither is ever written.
const REAL_USER_DATA = '/Users/jack/Library/Application Support/infinite-canvas';
const REAL_CANVAS = '/Users/jack/Desktop/Job Search/canvas.json';
const DEFAULT_SNAPSHOT_ID = '83d5f0e28d56b0ba072041a475ae906e15818033ef1852d539d221168b0eb1c5';
// The saved job cards the one-card live acceptance fixture copies, by node id.
// Only ids live here; the posting itself is read from the canvas at run time.
const REAL_CARD_IDS = Object.freeze({
  anthropic: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-9',
  affirm: 'board-1c3589c5-0bbd-4552-a031-8a0836776b33-1791309926380-job-13',
});
const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/u;

export class SimError extends Error {
  constructor(message, { code = 'sim_error', exit = 1 } = {}) {
    super(message);
    this.name = 'SimError';
    this.code = code;
    this.exit = exit;
  }
}
const usageError = message => new SimError(message, { code: 'usage', exit: 2 });

// ---------------------------------------------------------------------------
// Small file helpers.
// ---------------------------------------------------------------------------
function writeFileAtomic(file, data, mode = 0o600) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
function readJson(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new SimError(`${label} is missing or unreadable (${error?.code || error?.message}): ${file}`); }
  try { return JSON.parse(raw); }
  catch { throw new SimError(`${label} is not valid JSON: ${file}`); }
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nearestExisting(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}
// realpath of the deepest existing ancestor plus the not-yet-created tail, so a
// directory that does not exist yet is still compared in canonical form.
function canonicalPath(target) {
  const absolute = path.resolve(target);
  const base = nearestExisting(absolute);
  return path.join(fs.realpathSync(base), path.relative(base, absolute));
}
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const hasProtectedSegment = target => target.split(path.sep).some(part => part === 'Applied Jobs' || part === '.local-ai');

// ---------------------------------------------------------------------------
// Write guard: a DENY-list over the node fs write APIs. A write whose target
// is inside a protected real location (or inside any "Applied Jobs"/".local-ai"
// folder that is not under the run directory) throws. It is defense in depth;
// the primary isolation is that userData and the canvas root are inside DIR.
// ---------------------------------------------------------------------------
let installedGuard = null;
export function installWriteGuard({ protectedRoots, allowedRoots = [] }) {
  if (installedGuard) {
    installedGuard.protectedRoots.push(...protectedRoots.map(canonicalPath));
    installedGuard.allowedRoots.push(...allowedRoots.map(canonicalPath));
    return installedGuard;
  }
  const state = { protectedRoots: protectedRoots.map(canonicalPath), allowedRoots: allowedRoots.map(canonicalPath), blocked: [] };
  const deny = (target, api) => {
    if (typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return;
    let resolved;
    try {
      resolved = canonicalPath(target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : target);
    } catch { return; }
    const allowed = state.allowedRoots.some(root => isInside(root, resolved));
    const protectedHit = state.protectedRoots.some(root => isInside(root, resolved)) || (!allowed && hasProtectedSegment(resolved));
    if (protectedHit && !allowed) {
      state.blocked.push({ api, target: resolved });
      throw new SimError(`Refusing ${api} on a protected real location: ${resolved}`, { code: 'write_guard' });
    }
  };
  const isWriteFlag = flags => {
    if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0;
    return typeof flags === 'string' ? /[wa+]/u.test(flags) : false;
  };
  // [api name, which argument positions are paths, optional flag position]
  const targets = [
    ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['rename', [0, 1]], ['rm', [0]], ['rmdir', [0]], ['unlink', [0]],
    ['copyFile', [1]], ['cp', [1]], ['truncate', [0]], ['utimes', [0]], ['chmod', [0]], ['chown', [0]], ['symlink', [1]], ['link', [1]],
    ['mkdtemp', [0]], ['createWriteStream', [0]],
  ];
  const wrap = (owner, name, positions, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function guarded(...args) {
      for (const position of positions) deny(args[position], `${label}${name}`);
      return original.apply(this, args);
    };
  };
  for (const [name, positions] of targets) {
    wrap(fs, name, positions, 'fs.');
    wrap(fs, `${name}Sync`, positions, 'fs.');
    wrap(fs.promises, name, positions, 'fs.promises.');
  }
  for (const [owner, name, label] of [[fs, 'open', 'fs.'], [fs, 'openSync', 'fs.'], [fs.promises, 'open', 'fs.promises.']]) {
    const original = owner[name];
    owner[name] = function guardedOpen(...args) {
      if (isWriteFlag(args[1])) deny(args[0], `${label}${name}`);
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  installedGuard = state;
  return state;
}

// ---------------------------------------------------------------------------
// The electron stub (scripts/test-stubs). Production modules read userData
// through app.getPath() at call time; this points it at the run directory.
// ---------------------------------------------------------------------------
let electronApp = null;
let stubChecked = false;
async function electronStub() {
  if (stubChecked) return electronApp;
  stubChecked = true;
  try {
    const mod = await import('electron');
    const app = mod.app ?? mod.default?.app;
    electronApp = app && typeof app.getVersion === 'function' && app.getVersion() === '0.0.0-test' ? app : null;
  } catch { electronApp = null; }
  return electronApp;
}
async function isolateElectron(userData) {
  const app = await electronStub();
  if (!app) {
    throw new SimError('The Electron test stub is not loaded. Run: node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/offline-simulator.mjs <command> ...');
  }
  app.getPath = name => (name === 'userData' ? userData : path.join(userData, String(name)));
}

// ---------------------------------------------------------------------------
// Production modules, imported only after userData is isolated.
// ---------------------------------------------------------------------------
let productionCache = null;
async function loadProduction() {
  if (productionCache) return productionCache;
  const ipc = rel => import(new URL(`../../electron/ipc/${rel}`, import.meta.url).href);
  const la = await ipc('localAiApplication.js');
  const source = await ipc('handoffBridge/sources/application.js');
  const framing = await ipc('handoffBridge/framing.js');
  const preflight = await ipc('handoffBridge/preflight.js');
  const lanes = await ipc('handoffBridge/lanes.js');
  productionCache = { la, source, framing, preflight, lanes };
  return productionCache;
}

// ---------------------------------------------------------------------------
// Synthetic careers. Invented, unrelated domains; nothing here is a fact about
// a real candidate. `gap`/`lowGap` are posting requirements the approved
// evidence does not support (one high priority, one supporting); `matchGap`
// flips the evidence verdict for the high-priority one.
// ---------------------------------------------------------------------------
export const SYNTHETIC_SPECS = Object.freeze([
  { key: 'freight', id: 'sim-freight', name: 'Dara Okafor', email: 'dara@example.test', title: 'Dispatch Planner', employer: 'Meridian Freight', tech: 'Routing', users: 40, start: 'March 2019',
    gap: 'Hazardous materials endorsement', gapQuote: 'A hazardous materials endorsement is required.', lowGap: 'Forklift licensing', lowQuote: 'Forklift licensing is a plus.' },
  { key: 'clinic', id: 'sim-clinic', name: 'Imani Rahman', email: 'imani@example.test', title: 'Scheduling Coordinator', employer: 'Harborview Clinic', tech: 'Booking', users: 65, start: 'June 2018',
    gap: 'Insurance pre-authorization experience', gapQuote: 'Insurance pre-authorization experience is required.', lowGap: 'Spanish fluency', lowQuote: 'Spanish fluency is a plus.' },
  { key: 'library', id: 'sim-library', name: 'Tomas Lindqvist', email: 'tomas@example.test', title: 'Collections Cataloguer', employer: 'Eastgate Library', tech: 'Cataloguing', users: 30, start: 'January 2017',
    gap: 'Rare book conservation training', gapQuote: 'Rare book conservation training is required.', lowGap: 'Grant writing', lowQuote: 'Grant writing is a plus.' },
  { key: 'survey', id: 'sim-survey', name: 'Odalys Whitcombe', email: 'odalys@example.test', title: 'Land Survey Technician', employer: 'Ridgeline Surveying', tech: 'Plotting', users: 22, start: 'August 2016',
    gap: 'Drone pilot certification', gapQuote: 'Drone pilot certification is required.', lowGap: 'Bilingual field reports', lowQuote: 'Bilingual field reports are a plus.' },
]);

function syntheticTexts(spec) {
  const need = `Reliable ${spec.tech} service delivery`;
  const bullet = `Built ${spec.tech} service used by ${spec.users} users.`;
  const paragraph = `I built ${spec.tech} service used by ${spec.users} users. The engineering was in matching the constraints those teams set rather than my own preferences. I would apply that delivery work to the reliable ${spec.tech} service delivery this role requires.`;
  return {
    need, bullet, paragraph,
    listing: `${need} is required. ${spec.gapQuote} ${spec.lowQuote}`,
    thesis: `${need} is the supported capability this engineering role needs.`,
    roleId: `role-${spec.employer.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
    skillId: `skill-${spec.tech.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------------------
// Prompt parsing the way a writer reads it (the prompt carries the shared
// fields and the authoritative context).
// ---------------------------------------------------------------------------
const CONTEXT_MARKER = '\n\nAuthoritative context:\n';
export function contextOfPrompt(prompt) {
  const index = prompt.lastIndexOf(CONTEXT_MARKER);
  if (index < 0) throw new SimError('The prompt carries no "Authoritative context" block.');
  return JSON.parse(prompt.slice(index + CONTEXT_MARKER.length));
}
export function sharedFieldsOfPrompt(prompt) {
  const marker = 'Shared fields (copy exactly):\n';
  const start = prompt.indexOf(marker);
  if (start < 0) throw new SimError('The prompt carries no "Shared fields (copy exactly)" block.');
  const open = prompt.indexOf('{', start + marker.length);
  let depth = 0; let inString = false; let escaped = false;
  for (let index = open; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(prompt.slice(open, index + 1));
    }
  }
  throw new SimError('The prompt\'s shared-fields block is not a complete JSON object.');
}
const envelopeFor = (shared, fields) => ({
  protocol: shared.protocol, jobId: shared.jobId, stage: shared.stage, handoffCode: shared.handoffCode, baseHashes: shared.baseHashes, ...fields,
});
const digestInPrompt = (prompt, key) => {
  const match = new RegExp(`${key}:"([a-f0-9]{64})"`, 'u').exec(prompt);
  if (!match) throw new SimError(`The prompt does not expose ${key}.`);
  return match[1];
};

// Acknowledgement-only stages: the answer is mechanical, derived from the page
// the host issued. --auto-ack answers these so a driver does not spend turns.
const ACK_BUILDERS = Object.freeze({
  'blind-repair-context': prompt => {
    const context = contextOfPrompt(prompt);
    return {
      version: 1, planDigest: context.planDigest, pageIndex: context.pageIndex, pageDigest: context.pageDigest,
      acknowledgedFindingIds: context.packets.map(packet => packet.finding.id),
    };
  },
});
export const ACK_ONLY_STAGES = Object.freeze(Object.keys(ACK_BUILDERS));

// ---------------------------------------------------------------------------
// The scripted stand-in writer (synthetic careers only). It answers each stage
// the way gapfix-repair-convergence.js / gapfix-v16-prompts.js script a model:
// plain replies to the prompt the host actually issued. `kit` is the shared
// currentAuthorityFlowKit from scripts/tests/local-ai-application.js.
// ---------------------------------------------------------------------------
export function createScriptedWriter({ spec, kit, criteria, matchGap = false, findingsCycles = 0, memory = {} }) {
  const texts = syntheticTexts(spec);
  const identity = { name: spec.name, contact: [spec.email] };
  const requirementEvidence = [
    { id: 'p1-listing', sourceId: 'job-listing', quote: `${texts.need} is required.`, requirement: texts.need, priority: 'highest' },
    { id: 'p1-gap-listing', sourceId: 'job-listing', quote: spec.gapQuote, requirement: spec.gap, priority: 'high' },
    { id: 'p1-low-listing', sourceId: 'job-listing', quote: spec.lowQuote, requirement: spec.lowGap, priority: 'supporting' },
  ];
  const requirementRecords = [
    { id: 'p1-requirement', text: texts.need, priority: 'highest', evidenceIds: ['p1-listing'] },
    { id: 'p1-gap', text: spec.gap, priority: 'high', evidenceIds: ['p1-gap-listing'] },
    { id: 'p1-low', text: spec.lowGap, priority: 'supporting', evidenceIds: ['p1-low-listing'] },
  ];
  const auditFor = paragraph => {
    const audit = kit.generationAuditFor({ paragraphs: [paragraph], controllingThesis: texts.thesis });
    audit.coverLetterPlan.paragraphs[0].argumentMapping.jobNeedQuote = `${texts.need} is required.`;
    delete audit.jobPriorities;
    return audit;
  };
  const quality = (paragraph, bullet) => ({
    decision: 'pass',
    checklist: criteria.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the exact final documents.` })),
    findings: [],
    qualityReview: kit.groundedQualityReview(kit.sourceGroundingFor({ resumeBullets: [bullet], coverLetterParagraphs: [paragraph], resumeQuotes: [bullet], coverLetterQuotes: [bullet] })),
    generationAudit: auditFor(paragraph),
  });
  const resumeDocument = bullet => ({
    schemaVersion: 'structured-resume.v1', identity,
    roles: [{ id: texts.roleId, title: spec.title, company: spec.employer, dates: `${spec.start} – Present`, location: '', bullets: [{ id: 'bullet-1', text: bullet, evidenceIds: [memory.achievementId] }] }],
    skills: [{ id: 'skills-main', group: 'Languages', items: [spec.tech], evidenceIds: [memory.skillEvidenceId] }],
  });
  const letterDocument = (paragraph, bullet) => ({
    name: spec.name, contact: [spec.email],
    paragraphs: [{ id: 'paragraph-1', text: paragraph, evidenceIds: [memory.achievementId] }], roleThesis: texts.thesis,
    coverLetterArgument: { primaryEvidence: { evidence: bullet, evidenceRole: `${spec.title} at ${spec.employer}`, relationToThesis: `The ${spec.tech} service delivery establishes the supported capability this role needs.` } },
  });
  const requireIds = stage => {
    if (!memory.achievementId || !memory.skillEvidenceId) throw new SimError(`The scripted writer has not seen the career-match catalog yet, so it cannot write the ${stage}.`);
  };
  let cyclesRaised = memory.findingsCyclesRaised || 0;

  async function respond({ stage, prompt }) {
    const context = stage === 'blind-review' || stage === 'cover-letter' ? null : contextOfPrompt(prompt);
    switch (stage) {
      case 'requirements':
        return { storeDigest: context.authorityStore.digest, complete: true, identity: context.trustedIdentity, evidence: requirementEvidence, requirements: requirementRecords,
          ...kit.listingCoverageFields(context, requirementEvidence, requirementRecords) };
      case 'requirements-audit':
        return kit.listingSemanticAuditFields(context, requirementEvidence, requirementRecords);
      case 'career-match': {
        for (const item of context.catalog) {
          if (!memory.achievementId && new RegExp(`${spec.tech} service used by ${spec.users} users`, 'iu').test(item.quote)) memory.achievementId = item.id;
          if (!memory.skillEvidenceId && String(item?.id || '').startsWith(`host.career.skill.${texts.skillId}.`)) memory.skillEvidenceId = item.id;
        }
        return { version: 1, rootDigest: context.pair.rootDigest, pairDigest: context.pair.digest,
          rows: context.requirements.map(requirement => {
            const matched = requirement.id === 'p1-requirement' || (matchGap && requirement.id === 'p1-gap');
            return { requirementId: requirement.id, localStatus: matched ? 'matched' : 'no-match', candidateEvidenceIds: matched ? context.catalog.map(item => item.id) : [] };
          }) };
      }
      case 'resume':
        requireIds(stage);
        return { resume: resumeDocument(texts.bullet) };
      case 'cover-letter':
        requireIds(stage);
        return { coverLetter: letterDocument(texts.paragraph, texts.bullet) };
      case 'requirement-disposition':
        return { version: 1, rootDigest: digestInPrompt(prompt, 'rootDigest'), requirementPageDigest: digestInPrompt(prompt, 'requirementPageDigest'),
          reductionDigest: digestInPrompt(prompt, 'reductionDigest'), finalReferencesDigest: digestInPrompt(prompt, 'finalReferencesDigest'),
          rows: context.requirements.map(requirement => {
            const unsupported = context.reduction.find(row => row.requirementId === requirement.id)?.finalStatus === 'unsupported';
            return unsupported
              ? { requirementId: requirement.id, priority: requirement.priority, disposition: 'omitted-no-evidence', justification: 'No approved career evidence supports this requirement, so neither document claims it.', documentRefs: [], proofs: [] }
              : { requirementId: requirement.id, priority: requirement.priority, disposition: 'addressed-both', justification: 'The final résumé and letter each cite the exact selected service evidence for this requirement.', documentRefs: ['resume', 'cover-letter'], proofs: context.proofCandidates.find(row => row.requirementId === requirement.id).candidates };
          }) };
      case 'review': {
        requireIds(stage);
        const paragraph = context.coverLetter.paragraphs[0].text;
        const bullet = context.resume.roles[0].bullets[0].text;
        if (!context.blindRepairBrief) return quality(paragraph, bullet);
        // A repair round: answer the flagged paragraph with a minimal local edit.
        const edited = paragraph.replace(`I built ${spec.tech} service`, `I built the ${spec.tech} service`);
        return { ...quality(edited, bullet), decision: 'revised',
          findings: [{ id: 'writer-note-1', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Reworked the flagged text.', fix: 'Replaced it with a tighter supported statement.' }],
          coverLetter: letterDocument(edited, bullet) };
      }
      case 'blind-review': {
        const track = /TRACK: ([^\n]+)/u.exec(prompt)[1];
        const scopeDigest = /"scopeDigest":"([a-f0-9]{64})"/u.exec(prompt)[1];
        const pageIndex = Number(/"pageIndex":(\d+)/u.exec(prompt)[1]);
        const predecessor = /"previousPageDigest":(null|"[a-f0-9]{64}")/u.exec(prompt)[1];
        const scopeOrdinal = Number(/Each finding id (?:MUST begin|begins) "(\d+)-\d+-"/u.exec(prompt)[1]);
        const evidence = JSON.parse(/<untrusted-evidence-json>\n([\s\S]*?)\n<\/untrusted-evidence-json>/u.exec(prompt)[1]);
        const letterClaim = [evidence.claim, ...(evidence.claims || [])].find(claim => String(claim?.id || '').startsWith('letter-'));
        const raise = cyclesRaised < findingsCycles && track === 'fact-fidelity' && Boolean(letterClaim);
        const found = raise ? [{ document: 'cover-letter', targetId: letterClaim.id, issue: 'The paragraph repeats one delivery claim without a distinct proof.', fix: 'Rephrase the paragraph using only the cited evidence.' }] : [];
        if (raise) { cyclesRaised += 1; memory.findingsCyclesRaised = cyclesRaised; }
        const findings = found.map((finding, index) => ({ id: `${scopeOrdinal}-${pageIndex}-${index + 1}`, ruleId: 'review-rule', ...finding }));
        return { version: 1, scopeDigest, pageIndex, previousPageDigest: predecessor === 'null' ? null : JSON.parse(predecessor),
          complete: true, decision: findings.length ? 'issues' : 'pass', findings };
      }
      default:
        if (ACK_BUILDERS[stage]) return ACK_BUILDERS[stage](prompt);
        throw new SimError(`The scripted writer has no answer for the "${stage}" stage.`);
    }
  }
  return { respond, memory, texts };
}

// ---------------------------------------------------------------------------
// Run directory lifecycle.
// ---------------------------------------------------------------------------
function protectedRootsFor(options = {}) {
  const roots = [options['real-user-data'] || REAL_USER_DATA, path.dirname(options['real-canvas'] || REAL_CANVAS)];
  return [...new Set(roots.map(canonicalPath))];
}

function assertSafeRunDir(dirArg, options) {
  if (!dirArg) throw usageError('--dir DIR is required.');
  const dir = canonicalPath(dirArg);
  if (dir === path.parse(dir).root) throw new SimError('Refusing to use the filesystem root as a run directory.');
  if (isInside(dir, REPO_ROOT)) throw new SimError(`The run directory must not contain the repository: ${dir}`);
  for (const root of protectedRootsFor(options)) {
    if (isInside(root, dir) || isInside(dir, root)) {
      throw new SimError(`The run directory ${dir} overlaps a protected real location (${root}). Use a scratch directory elsewhere.`);
    }
  }
  if (hasProtectedSegment(dir)) throw new SimError(`The run directory ${dir} sits inside an "Applied Jobs" or ".local-ai" folder.`);
  return dir;
}

function prepareEmptyDir(dir) {
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SimError(`${dir} exists and is not a plain directory.`);
    const entries = fs.readdirSync(dir);
    if (entries.length) {
      const reason = entries.includes(RUN_MANIFEST)
        ? 'it already holds an initialized simulator run (init is for an empty directory only; pick a new --dir)'
        : entries.includes(INIT_MARKER) ? 'it holds a partially initialized run from an interrupted init (delete it and retry)' : 'it is not empty';
      throw new SimError(`Refusing to initialize ${dir}: ${reason}.`);
    }
    return { createdDir: false };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { createdDir: true };
}

function cleanupFailedInit(dir, { createdDir }) {
  try {
    if (createdDir) fs.rmSync(dir, { recursive: true, force: true });
    else for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  } catch { /* best effort: the marker file keeps a leftover visibly incomplete */ }
}

function loadRunManifest(dirArg) {
  if (!dirArg) throw usageError('--dir DIR is required.');
  const dir = canonicalPath(dirArg);
  const manifestFile = path.join(dir, RUN_MANIFEST);
  if (!fs.existsSync(manifestFile)) {
    throw new SimError(fs.existsSync(path.join(dir, INIT_MARKER))
      ? `${dir} holds an interrupted init. Delete it and run init again.`
      : `${dir} is not an initialized simulator run (no ${RUN_MANIFEST}). Run init first.`);
  }
  const run = readJson(manifestFile, 'Run manifest');
  if (run.version !== RUN_VERSION || run.complete !== true) throw new SimError('The run manifest is not a complete version-1 simulator run.');
  if (run.dir !== dir) throw new SimError(`The run was initialized at ${run.dir} and has been moved to ${dir}; its job state binds absolute paths, so it cannot be moved. Re-run init.`);
  return run;
}

// Exclusive per-run lock with stale-owner recovery.
async function withRunLock(dir, fn, { timeoutMs = Number(process.env.OFFLINE_SIM_LOCK_TIMEOUT_MS) || 60_000 } = {}) {
  const lockFile = path.join(dir, LOCK_FILE);
  const started = Date.now();
  for (;;) {
    try {
      const handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(handle, String(process.pid));
      fs.closeSync(handle);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = NaN;
      try { owner = Number(fs.readFileSync(lockFile, 'utf8')); } catch { /* released meanwhile */ }
      let alive = false;
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); alive = true; } catch (killError) { alive = killError?.code === 'EPERM'; }
      }
      if (!alive) { fs.rmSync(lockFile, { force: true }); continue; }
      if (Date.now() - started > timeoutMs) throw new SimError(`Another simulator command (pid ${owner}) has held ${lockFile} for over ${timeoutMs / 1000}s.`);
      await sleep(100);
    }
  }
  try { return await fn(); }
  finally { fs.rmSync(lockFile, { force: true }); }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function parseCardArg(value) {
  if (!value) throw usageError('--card is required: affirm, anthropic, node:<job card node id>, or synthetic[:key].');
  if (REAL_CARD_IDS[value]) return { kind: 'real', name: value, nodeId: REAL_CARD_IDS[value] };
  if (value.startsWith('node:') && value.length > 5) return { kind: 'real', name: 'node', nodeId: value.slice(5) };
  if (value === 'synthetic' || value.startsWith('synthetic:')) {
    const key = value === 'synthetic' ? SYNTHETIC_SPECS[0].key : value.slice('synthetic:'.length);
    const spec = SYNTHETIC_SPECS.find(item => item.key === key);
    if (!spec) throw usageError(`Unknown synthetic career "${key}". Known: ${SYNTHETIC_SPECS.map(item => item.key).join(', ')}.`);
    return { kind: 'synthetic', name: `synthetic:${key}`, spec };
  }
  throw usageError(`Unknown --card "${value}". Use affirm, anthropic, node:<job card node id>, or synthetic[:key].`);
}

function findCardNode(canvas, nodeId) {
  const found = [];
  const walk = nodes => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.id === nodeId) found.push(node);
      if (Array.isArray(node?.data?.canvasData?.nodes)) walk(node.data.canvasData.nodes);
    }
  };
  walk(canvas?.nodes);
  if (!found.length) throw new SimError(`The source canvas has no node ${nodeId}.`);
  if (found.length > 1) throw new SimError(`The source canvas has ${found.length} nodes with id ${nodeId}.`);
  if (found[0].type !== 'jobcard') throw new SimError(`Node ${nodeId} is a "${found[0].type}", not a saved job card.`);
  return found[0];
}

async function initFromSavedCard({ userData, canvasRoot, card, options }) {
  const prod = await loadProduction();
  const snapshots = await import(new URL('../../electron/ipc/careerSnapshot.js', import.meta.url).href);
  const harness = await import(new URL('./application-acceptance-harness.mjs', import.meta.url).href);
  const sourceCanvas = path.resolve(options['real-canvas'] || REAL_CANVAS);
  const sourceUserData = path.resolve(options['real-user-data'] || REAL_USER_DATA);
  const snapshotId = String(options['snapshot-id'] || DEFAULT_SNAPSHOT_ID);
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw usageError('--snapshot-id must be 64 lowercase hex characters.');
  const canvasStat = fs.lstatSync(sourceCanvas);
  if (!canvasStat.isFile() || canvasStat.isSymbolicLink()) throw new SimError(`The source canvas must be a regular file: ${sourceCanvas}`);
  const canvasBytes = fs.readFileSync(sourceCanvas); // read-only
  const node = JSON.parse(JSON.stringify(findCardNode(JSON.parse(canvasBytes.toString('utf8')), card.nodeId)));
  const listing = node?.data?.snippet;
  if (typeof listing !== 'string' || !listing.trim()) throw new SimError(`Card ${card.nodeId} carries no job listing text.`);

  // The approved snapshot: a byte copy of one file, then the production reader
  // proves it parses and validates inside the isolated store.
  const sourceSnapshot = snapshots.careerSnapshotPath(snapshots.careerSnapshotStorageRoot(sourceUserData), snapshotId);
  const sourceStat = fs.lstatSync(sourceSnapshot);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new SimError(`The source snapshot must be a regular file: ${sourceSnapshot}`);
  const snapshotBytes = fs.readFileSync(sourceSnapshot);
  const destRoot = snapshots.careerSnapshotStorageRoot(userData);
  const destSnapshot = snapshots.careerSnapshotPath(destRoot, snapshotId);
  fs.mkdirSync(path.dirname(destSnapshot), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destSnapshot, snapshotBytes, { mode: 0o600, flag: 'wx' });
  let validated = null;
  try { validated = await snapshots.readPinnedCareerSnapshot(destRoot, snapshotId); }
  catch (error) { throw new SimError(`The copied snapshot ${snapshotId} does not validate under the production reader: ${error?.message || error}`); }
  if (!validated) {
    throw new SimError(`The copied snapshot ${snapshotId} does not validate under the production reader (wrong id, or it predates a supported schema).`);
  }

  const canvasFilePath = path.join(canvasRoot, 'canvas.json');
  const fixture = { schemaVersion: 0, nodes: [node], edges: [], drawings: [] };
  const parsedSource = JSON.parse(canvasBytes.toString('utf8'));
  if (Number.isInteger(parsedSource.schemaVersion)) fixture.schemaVersion = parsedSource.schemaVersion;
  writeJsonAtomic(canvasFilePath, fixture);
  const job = harness.projectSavedJobCardForAcceptanceHarness(node.data);
  const queueApplication = options.legacy === true
    ? prod.la.__queueLegacyLocalApplicationFixtureForTests : prod.la.queueLocalApplicationJob;
  const queued = await queueApplication({
    nodeId: node.id, canvasFilePath, transport: 'paste', careerSnapshotId: snapshotId, job,
    ...(options['application-protocol'] === 'v2' ? { applicationProtocol: 'write-then-verify.v2', candidateCount: SIMULATOR_V2_DEFAULT_CANDIDATES } : {}),
    additionalNotes: String(node.data.additionalNotes || ''), reasoning: node.data.reasoning, matchScore: node.data.matchScore,
  });
  node.data.careerSnapshotId = snapshotId;
  node.data.localApplication = { ...queued };
  delete node.data.localApplication.prompt;
  writeJsonAtomic(canvasFilePath, fixture);
  return {
    queued, canvasFilePath, snapshotId,
    job: { company: job.company || null, title: job.title || null, listingChars: listing.length },
    source: {
      canvas: sourceCanvas, canvasSha256: sha256(canvasBytes), cardSha256: sha256(JSON.stringify(findCardNode(parsedSource, card.nodeId))),
      userData: sourceUserData, snapshotFile: sourceSnapshot, snapshotSha256: sha256(snapshotBytes),
    },
  };
}

async function loadKit() {
  const tests = await import(new URL('../../scripts/tests/local-ai-application.js', import.meta.url).href);
  return tests.currentAuthorityFlowKit;
}

// Writes the approved career snapshot of one synthetic career into `snapshotRoot`
// (the career-snapshot-store of some userData) and returns its id.
export async function writeSyntheticSnapshot({ spec, snapshotRoot }) {
  const snapshots = await import(new URL('../../electron/ipc/careerSnapshot.js', import.meta.url).href);
  const kit = await loadKit();
  const texts = syntheticTexts(spec);
  const sourceText = `${spec.name}\n${spec.email}\n${spec.title} at ${spec.employer}\n${spec.start} to Present\n${texts.bullet}\n${texts.paragraph}\n`;
  const corpus = snapshots.buildCareerSourceCorpus([{ name: `${spec.id} career.md`, contentHash: kit.sha256(sourceText), text: sourceText, legacyText: sourceText, transcriptionAudit: snapshots.verbatimCareerTranscriptionAuditReceipt() }]);
  const evidence = corpus.segments.map(segment => segment.id);
  const achievementKey = `achievement-${spec.id}`;
  const profile = {
    identity: { name: spec.name, contacts: [spec.email], evidenceSegmentIds: evidence },
    roles: [{ id: texts.roleId, title: spec.title, employer: spec.employer, startDate: spec.start, endDate: 'Present', location: '', achievementIds: [achievementKey], skillIds: [texts.skillId], evidenceSegmentIds: evidence }],
    achievements: [{ id: achievementKey, roleId: texts.roleId, claim: texts.paragraph, technologies: [spec.tech],
      technologyReferences: [{ technology: spec.tech, disposition: 'skill', skillId: texts.skillId, relationship: 'independent', relationshipGroup: '', relationshipEvidence: texts.paragraph, evidenceSegmentIds: evidence }],
      metrics: [{ label: 'users', value: String(spec.users), unit: 'users', evidenceSegmentIds: evidence }], evidenceSegmentIds: evidence }],
    projects: [],
    skills: [{ id: texts.skillId, name: spec.tech, category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: [texts.roleId], evidenceSegmentIds: evidence }],
    education: [], certifications: [], otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds: ['identity', texts.roleId, achievementKey, texts.skillId] })),
  };
  const snapshotId = snapshots.careerSnapshotId(corpus);
  fs.mkdirSync(path.dirname(snapshotRoot), { recursive: true, mode: 0o700 });
  const pages = snapshots.partitionCareerSourcePages(corpus);
  await snapshots.writeCareerSnapshotAtomically(snapshotRoot, {
    schemaVersion: snapshots.CAREER_SNAPSHOT_SCHEMA_VERSION, status: snapshots.CAREER_SNAPSHOT_STATUS_APPROVED, snapshotId,
    inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint, compilationContract: snapshots.CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: kit.sha256(kit.canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: snapshots.emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
    profile, auditHistory: kit.cleanCareerSnapshotAuditHistory(corpus, profile),
  });
  return { snapshotId, texts };
}

async function initSynthetic({ userData, canvasRoot, card, options }) {
  const prod = await loadProduction();
  const snapshots = await import(new URL('../../electron/ipc/careerSnapshot.js', import.meta.url).href);
  const spec = card.spec;
  const canvasFilePath = path.join(canvasRoot, 'canvas.json');
  fs.writeFileSync(canvasFilePath, '{"version":1}', { mode: 0o600, flag: 'wx' });
  const { snapshotId, texts } = await writeSyntheticSnapshot({ spec, snapshotRoot: snapshots.careerSnapshotStorageRoot(userData) });
  const queueApplication = options.legacy === true
    ? prod.la.__queueLegacyLocalApplicationFixtureForTests : prod.la.queueLocalApplicationJob;
  const queued = await queueApplication({ transport: 'paste', canvasFilePath, careerSnapshotId: snapshotId,
    ...(options['application-protocol'] === 'v2' ? { applicationProtocol: 'write-then-verify.v2', candidateCount: SIMULATOR_V2_DEFAULT_CANDIDATES } : {}),
    job: { title: spec.title, company: spec.employer, snippet: texts.listing } });
  return {
    queued, canvasFilePath, snapshotId, job: { company: spec.employer, title: spec.title, listingChars: texts.listing.length }, source: null,
    synthetic: { key: spec.key, matchGap: options['match-gap'] === true },
  };
}

export async function initRun(options) {
  if (options['application-protocol'] != null && !['legacy', 'v2'].includes(options['application-protocol'])) {
    throw new SimError('--application-protocol must be legacy or v2.');
  }
  const card = parseCardArg(options.card);
  const dir = assertSafeRunDir(options.dir, options);
  const guardRoots = protectedRootsFor(options);
  installWriteGuard({ protectedRoots: guardRoots, allowedRoots: [dir] });
  const state = prepareEmptyDir(dir);
  try {
    const realDir = fs.realpathSync(dir);
    fs.writeFileSync(path.join(realDir, INIT_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
    const userData = path.join(realDir, 'userData');
    const canvasRoot = path.join(realDir, 'canvas');
    fs.mkdirSync(userData, { mode: 0o700 });
    fs.mkdirSync(canvasRoot, { mode: 0o700 });
    await isolateElectron(userData);
    const built = card.kind === 'real'
      ? await initFromSavedCard({ userData, canvasRoot, card, options })
      : await initSynthetic({ userData, canvasRoot, card, options });
    const run = {
      version: RUN_VERSION, complete: true, createdAt: new Date().toISOString(), card: card.name, kind: card.kind,
      dir: realDir, userData, canvasRoot, canvasFilePath: built.canvasFilePath,
      jobId: built.queued.id, jobFolder: built.queued.folder, snapshotId: built.snapshotId, job: built.job,
      ...(built.source ? { source: built.source } : {}),
      ...(built.synthetic ? { synthetic: built.synthetic } : {}),
    };
    writeJsonAtomic(path.join(realDir, RUN_STATE), freshState());
    writeJsonAtomic(path.join(realDir, RUN_MANIFEST), run);
    fs.rmSync(path.join(realDir, INIT_MARKER), { force: true });
    return run;
  } catch (error) {
    cleanupFailedInit(dir, state);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Run state (the lane the engine would hold) and the event log.
// ---------------------------------------------------------------------------
function freshState() {
  return {
    version: 1, seq: 0, submits: 0,
    lane: {
      phase: 'unread', reason: null, current: null,
      counters: { rejections: 0, junkStreak: 0, errStreak: 0, attemptByStage: {} },
      acceptedFingerprints: [], tombstones: {}, terminal: null,
    },
  };
}
const stateFile = run => path.join(run.dir, RUN_STATE);
const loadState = run => readJson(stateFile(run), 'Simulator state');
const saveState = (run, state) => writeJsonAtomic(stateFile(run), state);
const logEvent = (run, event) => fs.appendFileSync(path.join(run.dir, EVENT_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
function readEvents(run) {
  const file = path.join(run.dir, EVENT_LOG);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function readRejectionTrace(run) {
  const file = path.join(run.jobFolder, 'Paste Rejections.json');
  if (!fs.existsSync(file)) return [];
  try { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}
function readJobManifest(run) {
  const file = path.join(run.jobFolder, 'manifest.json');
  return fs.existsSync(file) ? readJson(file, 'Job manifest') : null;
}

// ---------------------------------------------------------------------------
// The bridge, in miniature: one lane served to one writer.
// ---------------------------------------------------------------------------
async function openContext(dirArg) {
  const run = loadRunManifest(dirArg);
  installWriteGuard({ protectedRoots: protectedRootsFor({ 'real-user-data': run.source?.userData, 'real-canvas': run.source?.canvas }), allowedRoots: [run.dir] });
  await isolateElectron(run.userData);
  const prod = await loadProduction();
  const codeGuard = prod.lanes.createHandoffCodeGuard();
  const ctx = { run, prod, codeGuard, lastRawStatus: null, state: loadState(run) };
  ctx.source = prod.source.createApplicationSource({
    codeGuard,
    getStatus: async (...args) => {
      const raw = await prod.la.localApplicationStatus(...args);
      ctx.lastRawStatus = raw;
      return raw;
    },
  });
  return ctx;
}

const laneRef = (ctx, matchTaskId = null) => ({ jobId: ctx.run.jobId, canvasFilePath: ctx.run.canvasFilePath, matchTaskId });
const publicStatus = raw => (raw ? {
  status: raw.status ?? null, stage: raw.stage ?? null, revision: raw.revision ?? null, logCount: raw.logCount ?? null,
  message: raw.message ?? null, terminalKind: raw.terminalKind ?? null, retryReproducesFailure: raw.retryReproducesFailure ?? null,
} : null);

function describeTerminal(mapped, raw) {
  const status = publicStatus(raw);
  if (mapped.kind === 'done') return { kind: 'saved', status };
  if (mapped.kind === 'gone') return { kind: 'gone', status };
  if (mapped.kind === 'needs_user') {
    const kind = { review_stop: 'human-stop', job_broken: 'job-broken', render_retry: 'render-retry', app_fix_required: 'app-fix-required' }[mapped.reason] || mapped.reason;
    return { kind, reason: mapped.reason, status };
  }
  return { kind: raw?.status === 'importing' ? 'importing' : 'completed', status };
}

// Read the app until it offers an open handoff or reaches a terminal state,
// the way the engine's host-lane refresh does (status -> read when reopened).
async function readOpenHandoff(ctx) {
  const lane = laneRef(ctx);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const read = await ctx.source.read(lane);
    if (read.kind === 'open') return { kind: 'open', handoff: read.handoff };
    if (read.kind === 'busy') { await sleep(150); continue; }
    if (read.kind === 'threw') return { kind: 'error', error: read };
    const mapped = await ctx.source.status(lane);
    if (mapped.kind === 'busy') { await sleep(150); continue; }
    if (mapped.kind === 'threw') return { kind: 'error', error: mapped };
    if (mapped.kind === 'awaiting' || (mapped.kind === 'host' && mapped.read === true)) continue;
    return { kind: 'terminal', terminal: describeTerminal(mapped, ctx.lastRawStatus) };
  }
  return { kind: 'error', error: { kind: 'threw', code: 'unsettled' } };
}

function adoptHandoff(ctx, handoff, { carryServed = false } = {}) {
  const { state } = ctx;
  const normalized = ctx.prod.lanes.normalizeCurrentHandoff(handoff, Date.now());
  if (!normalized) throw new SimError('The app returned a handoff the bridge would not adopt (missing code, stage or prompt).');
  // A code the lane stops holding is dead: answering it later is "superseded", as in the engine.
  const previous = state.lane.current;
  if (previous?.code && !ctx.codeGuard.equal(previous.code, normalized.code)) state.lane.tombstones[ctx.codeGuard.key(previous.code)] ??= 'rotated';
  state.seq += 1;
  state.lane.current = {
    ...normalized, seq: state.seq, servedCount: carryServed ? (state.lane.current?.servedCount || 0) : 0,
    ...(handoff.matchTaskId ? { matchTaskId: handoff.matchTaskId } : {}),
    ...(Array.isArray(handoff.parallelTasks) ? { parallelTasks: handoff.parallelTasks } : {}),
  };
  state.lane.phase = 'awaiting';
  state.lane.reason = null;
  state.lane.terminal = null;
  return state.lane.current;
}

function terminalBody(ctx, terminal) {
  const { framing } = ctx.prod;
  if (['human-stop', 'job-broken', 'render-retry', 'app-fix-required'].includes(terminal.kind)) {
    return framing.makeResultBody('needs_user', { reason: terminal.reason, ...(terminal.kind === 'job-broken' ? { note: 'Infinite Canvas found an integrity problem in this application bundle.' } : {}) });
  }
  return framing.makeResultBody('queue_empty');
}

// What get_handoff returns for the lane's current handoff (and bumps its attempt).
function serveCurrent(ctx) {
  const { state, prod, run } = ctx;
  const current = state.lane.current;
  const key = `${current.stage}@${current.revision}`;
  const servedBefore = (current.servedCount || 0) > 0;
  current.attempt = (state.lane.counters.attemptByStage[key] ?? 0) + 1;
  state.lane.counters.attemptByStage[key] = current.attempt;
  current.servedCount = (current.servedCount || 0) + 1;
  const body = prod.framing.makeServedBody({ lane: { current }, remaining: { ready: 1, working: 0, needsYou: 0 }, servedBefore });
  const file = path.join(run.dir, `handoff-${current.seq}.txt`);
  const text = renderServedText(ctx, body, current.seq);
  writeFileAtomic(file, text);
  writeJsonAtomic(path.join(run.dir, `handoff-${current.seq}.json`), body);
  logEvent(run, { type: 'served', seq: current.seq, stage: current.stage, revision: current.revision, attempt: current.attempt, code: current.code, promptChars: current.prompt.length, corrections: current.corrections.length });
  return { body, meta: { seq: current.seq, file, jsonFile: path.join(run.dir, `handoff-${current.seq}.json`), stage: current.stage, text } };
}

function renderServedText(ctx, body, seq) {
  const lines = [
    `== offline-simulator handoff ${seq} | stage ${body.stage} | attempt ${body.attempt} | code ${body.handoffCode} ==`,
    `job ${ctx.run.jobId} | run ${ctx.run.dir}`,
    `Reply by writing the complete answer to a file and running: offline-simulator.mjs submit --dir ${ctx.run.dir} --file <file>`,
    '',
    'INSTRUCTIONS (as served to the chat):',
    body.instructions,
    '',
  ];
  if (body.corrections?.length) {
    lines.push('CORRECTIONS (your previous answer was rejected):', ...body.corrections.map((item, index) => `${index + 1}. ${item}`), '');
  }
  if (body.correctionPrompt) lines.push('CORRECTION PROMPT:', body.correctionPrompt, '');
  if (body.note) lines.push(`NOTE: ${body.note}`, '');
  lines.push('----- PROMPT (verbatim) -----', body.prompt, '----- END PROMPT -----', '');
  return lines.join('\n');
}

export async function getHandoff(ctx, { autoAck = false, reread = false } = {}) {
  const { state, run } = ctx;
  let acknowledged = 0;
  if (state.lane.pendingSubmit) {
    logEvent(run, { type: 'recovered-pending-submit', code: state.lane.pendingSubmit.code });
    delete state.lane.pendingSubmit;
    reread = true;
  }
  for (let guard = 0; guard < 400; guard += 1) {
    if (state.lane.current && !reread) {
      // fall through to serve the cached handoff
    } else {
      reread = false;
      const outcome = await readOpenHandoff(ctx);
      if (outcome.kind === 'terminal') {
        state.lane.current = null;
        state.lane.phase = ['human-stop', 'job-broken', 'render-retry', 'app-fix-required'].includes(outcome.terminal.kind) ? 'needs_user' : 'host';
        state.lane.terminal = outcome.terminal;
        saveState(run, state);
        logEvent(run, { type: 'terminal', terminal: outcome.terminal });
        return { body: terminalBody(ctx, outcome.terminal), meta: { terminal: outcome.terminal, autoAcknowledged: acknowledged } };
      }
      if (outcome.kind === 'error') {
        saveState(run, state);
        const integrity = outcome.error.integrity === true;
        const body = integrity
          ? ctx.prod.framing.makeResultBody('needs_user', { reason: 'job_broken', note: 'Infinite Canvas found an integrity problem in this application bundle.' })
          : ctx.prod.framing.makeResultBody('retry', { inFlight: false });
        logEvent(run, { type: 'read-error', code: outcome.error.code || 'internal_error' });
        return { body, meta: { error: outcome.error.code || 'internal_error', autoAcknowledged: acknowledged } };
      }
      adoptHandoff(ctx, outcome.handoff);
    }
    const served = serveCurrent(ctx);
    saveState(run, state);
    if (autoAck && ACK_BUILDERS[served.body.stage]) {
      const shared = sharedFieldsOfPrompt(served.body.prompt);
      const response = envelopeFor(shared, ACK_BUILDERS[served.body.stage](served.body.prompt));
      const result = await submitText(ctx, { code: served.body.handoffCode, text: JSON.stringify(response), auto: true });
      if (result.body.status !== 'accepted') {
        return { ...served, meta: { ...served.meta, autoAcknowledged: acknowledged, autoAckFailure: result.body } };
      }
      acknowledged += 1;
      continue;
    }
    return { ...served, meta: { ...served.meta, autoAcknowledged: acknowledged } };
  }
  throw new SimError('Auto-acknowledgement did not settle after 400 pages.');
}

function recordSubmit(ctx, entry) {
  ctx.state.submits += 1;
  logEvent(ctx.run, { type: 'submitted', n: ctx.state.submits, ...entry });
}

export async function submitText(ctx, { code, text, auto = false, responseFile = null }) {
  const { state, prod, run, codeGuard } = ctx;
  const { framing, preflight, lanes } = prod;
  const lane = state.lane;
  const stage = lane.current?.stage ?? null;
  const base = { stage, seq: lane.current?.seq ?? null, revision: lane.current?.revision ?? null, auto, responseFile };
  const finish = (body, extra = {}) => {
    recordSubmit(ctx, { ...base, outcome: body.status, ...extra });
    saveState(run, state);
    return { body, meta: { stage, ...extra } };
  };
  const normalized = preflight.stringifySubmission(text);
  if (!normalized.ok) { lane.counters.junkStreak += 1; return finish(framing.makeResultBody('junk')); }
  const bytes = Buffer.byteLength(normalized.text, 'utf8');
  if (bytes > preflight.MAX_RESPONSE_BYTES) return finish(framing.makeResultBody('too_large'), { bytes });
  const trimmed = lanes.trimHandoffCode(code);
  if (!lane.current || !codeGuard.equal(trimmed, lane.current.code)) {
    const tombstone = lane.tombstones[codeGuard.key(trimmed)];
    const body = !lane.current && !tombstone && lane.terminal ? framing.makeResultBody('queue_empty')
      : tombstone === 'accepted' ? framing.makeResultBody('duplicate')
        : tombstone ? framing.makeResultBody('superseded') : framing.makeResultBody('unknown_handoff');
    return finish(body, { bytes });
  }
  const classification = preflight.classifySubmission({
    response: normalized.text,
    lane: { jobId: run.jobId, current: lane.current, acceptedFingerprints: new Set(lane.acceptedFingerprints) },
    lanes: [], codeGuard,
  });
  if (classification !== 'pass') {
    if (classification === 'junk') lane.counters.junkStreak += 1;
    const got = preflight.extractPasteEnvelopeIdentity(normalized.text).stage;
    const body = framing.makeResultBody(classification, classification === 'superseded' && got ? { note: framing.supersededStageNote(got, lane.current.stage) } : {});
    return finish(body, { bytes, preflight: classification });
  }

  const submitLane = { ...laneRef(ctx, lane.current.matchTaskId ?? null) };
  let activeCode = lane.current.code;
  // If this process dies between the app's commit and our save, the next read must
  // not trust the cached handoff: the marker makes it re-ask the host.
  lane.pendingSubmit = { code: activeCode, at: new Date().toISOString() };
  saveState(run, state);
  let result = await ctx.source.submit(submitLane, { code: activeCode, text: normalized.text });
  // A thrown commit is re-read and retried up to twice, as the engine does.
  for (let retry = 0; result.kind === 'threw' && result.integrity !== true && retry < 2; retry += 1) {
    const reread = await readOpenHandoff(ctx);
    if (reread.kind !== 'open' || reread.handoff.stage !== lane.current.stage) break;
    adoptHandoff(ctx, reread.handoff, { carryServed: true });
    activeCode = lane.current.code;
    result = await ctx.source.submit(laneRef(ctx, lane.current.matchTaskId ?? null), { code: activeCode, text: normalized.text });
  }

  delete lane.pendingSubmit;
  if (result.kind === 'accepted') {
    const fingerprint = preflight.responseFingerprint(normalized.text);
    if (fingerprint) { lane.acceptedFingerprints.push(fingerprint); lane.acceptedFingerprints = lane.acceptedFingerprints.slice(-32); }
    lane.tombstones[codeGuard.key(activeCode)] = 'accepted';
    lane.counters.rejections = 0; lane.counters.junkStreak = 0; lane.counters.errStreak = 0;
    const priorStage = lane.current.stage;
    if (result.completed || !result.handoff) {
      lane.current = null; lane.phase = 'host';
      return finish(framing.makeResultBody('accepted', { jobComplete: true, next: null }), { bytes, priorStage, nextStage: null });
    }
    adoptHandoff(ctx, result.handoff);
    const served = serveCurrent(ctx);
    return finish(framing.makeResultBody('accepted', { jobComplete: false, next: served.body }), { bytes, priorStage, nextStage: served.body.stage, nextSeq: served.meta.seq });
  }

  if (result.kind === 'rejected') {
    lane.counters.rejections += 1; lane.counters.junkStreak = 0; lane.counters.errStreak = 0;
    const previousCode = activeCode;
    const returned = lanes.normalizeCurrentHandoff(result.handoff, Date.now());
    const errors = result.validationErrors?.length ? result.validationErrors : (returned?.corrections || []);
    if (!returned) throw new SimError('The app rejected the answer but returned no handoff to correct.');
    if (!codeGuard.equal(returned.code, previousCode)) lane.tombstones[codeGuard.key(previousCode)] = 'rotated';
    state.seq += 1;
    lane.current = {
      ...returned, corrections: errors, seq: state.seq, servedCount: lane.current.servedCount || 0,
      ...(result.handoff.matchTaskId ? { matchTaskId: result.handoff.matchTaskId } : {}),
      ...(Array.isArray(result.handoff.parallelTasks) ? { parallelTasks: result.handoff.parallelTasks } : {}),
    };
    const { checkIds, uncodedErrors } = prod.la.pasteRejectionCheckIds(errors);
    const trace = readRejectionTrace(run);
    const streak = trace.length ? trace[trace.length - 1].rejectionStreak ?? null : null;
    const body = framing.makeRejectedBody({
      handoffCode: lane.current.code, attempt: lane.counters.rejections + 1,
      validationErrors: errors, correctionPrompt: lane.current.correctionPrompt,
    });
    return finish(body, { bytes, validationErrors: errors, checkIds, uncodedErrors, rejectionStreak: streak, rotated: !codeGuard.equal(returned.code, previousCode), nextSeq: lane.current.seq });
  }

  // threw
  if (result.integrity === true) {
    lane.phase = 'needs_user'; lane.reason = 'job_broken';
    return finish(framing.makeResultBody('needs_user', { reason: 'job_broken', note: 'Infinite Canvas found an integrity problem in this application bundle.' }), { bytes, threw: result.code });
  }
  lane.counters.errStreak += 1;
  return finish(framing.makeResultBody('retry', { inFlight: false }), { bytes, threw: result.code || 'internal_error' });
}

// ---------------------------------------------------------------------------
// docs: the current résumé and letter as plain text.
// ---------------------------------------------------------------------------
async function htmlToText(html) {
  const { JSDOM } = await import('jsdom');
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const block = new Set(['P', 'DIV', 'SECTION', 'HEADER', 'MAIN', 'UL', 'OL', 'DL', 'ARTICLE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DT', 'DD', 'TR', 'BR']);
  const out = [];
  const flush = () => { if (out.length && out[out.length - 1] !== '\n') out.push('\n'); };
  const walk = node => {
    if (node.nodeType === 3) { const value = node.textContent.replace(/\s+/gu, ' '); if (value.trim()) out.push(value); return; }
    if (node.nodeType !== 1) return;
    if (['STYLE', 'SCRIPT'].includes(node.tagName)) return;
    const isBlock = block.has(node.tagName);
    if (isBlock) flush();
    if (node.tagName === 'LI') out.push('- ');
    for (const child of node.childNodes) walk(child);
    if (isBlock) flush();
  };
  walk(document.body);
  return out.join('').replace(/[ \t]+\n/gu, '\n').replace(/(\S)·(\S)/gu, '$1 · $2').replace(/\n{3,}/gu, '\n\n').trim();
}

function structuredResumeText(resume) {
  const lines = [];
  const identity = resume?.identity || {};
  if (identity.name) lines.push(identity.name);
  if (identity.contact?.length) lines.push(identity.contact.join(' | '));
  for (const key of ['subtitleRole', 'credential']) if (identity[key]) lines.push(identity[key]);
  const section = (title, rows) => { if (rows?.length) lines.push('', title.toUpperCase(), ...rows); };
  section('Experience', (resume?.roles || []).flatMap(role => [
    `${role.title || ''}${role.company ? ` - ${role.company}` : ''}${role.dates ? ` (${role.dates})` : ''}${role.location ? `, ${role.location}` : ''}`,
    ...(role.bullets || []).map(bullet => `  - ${bullet.text}`),
  ]));
  section('Projects', (resume?.projects || []).flatMap(project => [project.name || '', project.description ? `  ${project.description}` : ''].filter(Boolean)));
  section('Skills', (resume?.skills || []).map(group => `${group.group ? `${group.group}: ` : ''}${(group.items || []).join(', ')}`));
  for (const key of ['education', 'certifications']) {
    section(key, (resume?.[key] || []).map(item => (typeof item === 'string' ? item : Object.values(item).filter(value => typeof value === 'string' && value).join(' - '))));
  }
  return lines.join('\n');
}

function letterText(letter) {
  const lines = [];
  if (letter?.name) lines.push(letter.name);
  if (letter?.contact?.length) lines.push(letter.contact.join(' | '));
  if (letter?.recipient) lines.push('', letter.recipient);
  if (letter?.salutation) lines.push('', letter.salutation);
  for (const paragraph of letter?.paragraphs || []) lines.push('', typeof paragraph === 'string' ? paragraph : paragraph.text);
  if (letter?.closing) lines.push('', letter.closing);
  if (letter?.signatureTitle) lines.push(letter.signatureTitle);
  return lines.join('\n');
}

export async function writeDocs(run) {
  const manifest = readJobManifest(run);
  const resultFile = path.join(run.jobFolder, 'result.json');
  const docsDir = path.join(run.dir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true, mode: 0o700 });
  let source; let resume = null; let letter = null; let resumeHtml = null;
  if (fs.existsSync(resultFile)) {
    const result = readJson(resultFile, 'result.json');
    source = 'result.json (final, host-rendered)';
    resumeHtml = result.resumeMainHtml || null;
    resume = resumeHtml ? await htmlToText(resumeHtml) : null;
    letter = result.coverLetter ? letterText(result.coverLetter) : null;
    if (result.coverLetter) writeJsonAtomic(path.join(docsDir, 'cover-letter.json'), result.coverLetter);
  } else if (manifest?.paste) {
    source = `manifest (stage ${manifest.paste.stage}; accepted so far, not final)`;
    if (manifest.paste.resume) { resume = structuredResumeText(manifest.paste.resume); writeJsonAtomic(path.join(docsDir, 'resume.json'), manifest.paste.resume); }
    if (manifest.paste.coverLetter) { letter = letterText(manifest.paste.coverLetter); writeJsonAtomic(path.join(docsDir, 'cover-letter.json'), manifest.paste.coverLetter); }
  } else source = 'none';
  const files = {};
  if (resume !== null) { files.resume = path.join(docsDir, 'resume.txt'); writeFileAtomic(files.resume, `${resume}\n`); }
  if (resumeHtml) { files.resumeHtml = path.join(docsDir, 'resume.main.html'); writeFileAtomic(files.resumeHtml, resumeHtml); }
  if (letter !== null) { files.coverLetter = path.join(docsDir, 'cover-letter.txt'); writeFileAtomic(files.coverLetter, `${letter}\n`); }
  return { source, files, resumeChars: resume?.length ?? 0, coverLetterChars: letter?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// status / log
// ---------------------------------------------------------------------------
export async function runStatus(ctx) {
  const { run, state } = ctx;
  const manifest = readJobManifest(run);
  let status = null; let mapped = null;
  try {
    mapped = await ctx.source.status(laneRef(ctx));
    status = publicStatus(ctx.lastRawStatus);
  } catch (error) {
    status = { error: String(error?.message || error) };
  }
  const current = state.lane.current;
  return {
    run: { dir: run.dir, card: run.card, kind: run.kind, jobId: run.jobId, snapshotId: run.snapshotId, job: run.job },
    job: { manifestStatus: manifest?.status ?? null, stage: manifest?.paste?.stage ?? null, revision: manifest?.paste?.revision ?? null, logCount: manifest?.paste?.logCount ?? null },
    host: { status, bridgeStatus: mapped },
    lane: {
      phase: state.lane.phase, terminal: state.lane.terminal,
      current: current ? { seq: current.seq, stage: current.stage, revision: current.revision, code: current.code, corrections: current.corrections.length, servedCount: current.servedCount } : null,
    },
    counts: { handoffsAdopted: state.seq, submits: state.submits, rejectionsInARow: state.lane.counters.rejections },
  };
}

export function buildLog(run) {
  const events = readEvents(run);
  const stages = {};
  const bucket = stage => (stages[stage || 'unknown'] ||= { handoffs: 0, served: 0, submits: 0, accepted: 0, rejected: 0, bridgeRefused: 0, autoAck: 0 });
  const rejections = [];
  const seen = new Set();
  for (const event of events) {
    if (event.type === 'served') {
      const row = bucket(event.stage);
      row.served += 1;
      // A handoff is one (seq): the same one printed again by next is a re-serve, not new work.
      if (!seen.has(event.seq)) { seen.add(event.seq); row.handoffs += 1; }
    }
    if (event.type !== 'submitted') continue;
    const row = bucket(event.stage);
    row.submits += 1;
    if (event.auto) row.autoAck += 1;
    if (event.outcome === 'accepted') row.accepted += 1;
    else if (event.outcome === 'rejected') {
      row.rejected += 1;
      rejections.push({ n: event.n, stage: event.stage, revision: event.revision, checkIds: event.checkIds || [], uncodedErrors: event.uncodedErrors ?? 0,
        errorCount: (event.validationErrors || []).length, rejectionStreak: event.rejectionStreak ?? null,
        firstErrors: (event.validationErrors || []).slice(0, 3).map(item => String(item).slice(0, 240)) });
    } else row.bridgeRefused += 1;
  }
  const longestStreakByStage = {};
  for (const row of readRejectionTrace(run)) {
    longestStreakByStage[row.stage] = Math.max(longestStreakByStage[row.stage] || 0, row.rejectionStreak || 0);
  }
  const submitted = events.filter(event => event.type === 'submitted');
  return {
    totals: {
      handoffs: seen.size,
      servings: events.filter(event => event.type === 'served').length,
      submits: submitted.length,
      accepted: submitted.filter(event => event.outcome === 'accepted').length,
      rejected: submitted.filter(event => event.outcome === 'rejected').length,
      bridgeRefused: submitted.filter(event => !['accepted', 'rejected'].includes(event.outcome)).length,
      autoAcknowledged: submitted.filter(event => event.auto).length,
    },
    stages, rejections, longestRejectionStreakByStage: longestStreakByStage,
    terminal: [...events].reverse().find(event => event.type === 'terminal')?.terminal ?? null,
  };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function renderSubmit(result, run) {
  const { body, meta } = result;
  const lines = [];
  if (body.status === 'accepted') {
    lines.push(`ACCEPTED (stage ${meta.stage})`);
    if (body.next) lines.push(`next stage: ${body.next.stage} (handoff ${meta.nextSeq}) - run: next --dir ${run.dir}`);
    else lines.push('no successor handoff yet - run next to let the host settle (reopened round, next task, or terminal state)');
  } else if (body.status === 'rejected') {
    lines.push(`REJECTED (stage ${meta.stage}); nothing was saved. Fix every item and submit the complete corrected answer.`);
    lines.push(`rejection streak (host): ${meta.rejectionStreak ?? 'n/a'}${meta.rotated ? ' | the handoff code ROTATED - use the new code from next' : ' | same handoff code'}`);
    lines.push(`check ids: ${(meta.checkIds || []).join(', ') || '(none named)'}${meta.uncodedErrors ? ` | ${meta.uncodedErrors} uncoded` : ''}`);
    (body.validationErrors || []).forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push(`corrected handoff: run next --dir ${run.dir}`);
  } else {
    lines.push(`${String(body.status).toUpperCase()}: ${body.note || ''}`);
    if (meta.preflight) lines.push(`(refused by the bridge pre-source classifier: ${meta.preflight}; the app never saw this answer)`);
  }
  return lines.join('\n');
}
const out = text => process.stdout.write(`${text}\n`);
const exitForSubmit = body => (body.status === 'accepted' ? 0 : 3);

function usage() {
  return `Offline application simulator (see the header comment in offline-simulator.mjs).

  node --import ./scripts/test-stubs/register.mjs .test-artifacts/blackbox-run/offline-simulator.mjs <command> [options]

  init     --card affirm|anthropic|node:<id>|synthetic[:key] --dir DIR [--snapshot-id ID] [--match-gap]
           [--real-canvas FILE] [--real-user-data DIR] [--application-protocol legacy|v2] [--json]   (v2 uses five candidates; sources are read-only; DIR must be empty)
  next     --dir DIR [--auto-ack] [--reread] [--json]   print the next handoff (also written to DIR/handoff-<n>.txt/.json)
  submit   --dir DIR --file response.json [--code CODE] [--auto-ack] [--json]
  status   --dir DIR [--json]
  docs     --dir DIR                                     write DIR/docs/resume.txt and cover-letter.txt
  log      --dir DIR [--json]                            handoff counts per stage, rejections, check ids, streaks
  serve    --dir DIR [--auto-ack] [--spool]              JSON lines on stdin/stdout (or DIR/spool files)
  autoplay --dir DIR [--max-handoffs N] [--findings-cycles N] [--allow-rejections]   scripted writer (synthetic only)

Exit codes: 0 ok | 1 tool error | 2 usage | 3 the host rejected or refused the answer.
Synthetic careers: ${SYNTHETIC_SPECS.map(item => item.key).join(', ')}.`;
}

// ---------------------------------------------------------------------------
// serve: get_handoff / submit_handoff style JSON.
// ---------------------------------------------------------------------------
async function handleRequest(ctx, request, { autoAck }) {
  const tool = request?.tool;
  if (tool === 'get_handoff') {
    const served = await getHandoff(ctx, { autoAck: request.autoAck ?? autoAck, reread: request.reread === true });
    return { result: served.body, sim: { ...served.meta, text: undefined } };
  }
  if (tool === 'submit_handoff') {
    const code = request.handoffCode ?? ctx.state.lane.current?.code;
    const response = request.response;
    const result = await submitText(ctx, { code, text: typeof response === 'string' ? response : response === undefined ? undefined : JSON.stringify(response) });
    return { result: result.body, sim: result.meta };
  }
  if (tool === 'status') return { result: await runStatus(ctx) };
  if (tool === 'docs') return { result: await writeDocs(ctx.run) };
  if (tool === 'log') return { result: buildLog(ctx.run) };
  throw new SimError(`Unknown tool "${tool}". Use get_handoff, submit_handoff, status, docs or log.`);
}

async function serveLoop(dirArg, options) {
  const autoAck = options['auto-ack'] === true;
  const run = loadRunManifest(dirArg);
  const process1 = async request => {
    try {
      return await withRunLock(run.dir, async () => {
        const ctx = await openContext(run.dir);
        const handled = await handleRequest(ctx, request, { autoAck });
        return { id: request.id ?? null, ok: true, ...handled };
      });
    } catch (error) {
      return { id: request?.id ?? null, ok: false, error: String(error?.message || error), code: error?.code || 'sim_error' };
    }
  };
  if (options.spool) {
    const spool = path.join(run.dir, 'spool');
    fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
    process.stderr.write(`offline-simulator: serving ${spool} (write <id>.request.json; read <id>.response.json). Stop with SIGINT or by creating ${path.join(spool, 'STOP')}.\n`);
    for (;;) {
      if (fs.existsSync(path.join(spool, 'STOP'))) { fs.rmSync(path.join(spool, 'STOP'), { force: true }); return; }
      const pending = fs.readdirSync(spool).filter(name => name.endsWith('.request.json')).sort();
      for (const name of pending) {
        const id = name.slice(0, -'.request.json'.length);
        const requestFile = path.join(spool, name);
        let request;
        try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); }
        catch { await sleep(50); try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); } catch { request = null; } }
        const response = request ? await process1({ id, ...request }) : { id, ok: false, error: 'The request file is not valid JSON.', code: 'usage' };
        writeJsonAtomic(path.join(spool, `${id}.response.json`), response);
        fs.rmSync(requestFile, { force: true });
      }
      await sleep(100);
    }
  }
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  reader.on('line', line => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let request;
      try { request = JSON.parse(line); }
      catch { out(JSON.stringify({ id: null, ok: false, error: 'The line is not valid JSON.', code: 'usage' })); return; }
      out(JSON.stringify(await process1(request)));
    });
  });
  await new Promise(resolve => reader.on('close', resolve));
  await chain;
}

// ---------------------------------------------------------------------------
// autoplay: the scripted writer, through the same getHandoff/submitText path.
// ---------------------------------------------------------------------------
export async function autoplay(ctx, { maxHandoffs = 200, findingsCycles = 0, allowRejections = false, autoAck = true } = {}) {
  const { run } = ctx;
  if (run.kind !== 'synthetic') throw new SimError('autoplay drives synthetic careers only: a scripted writer cannot write for a real posting.');
  const spec = SYNTHETIC_SPECS.find(item => item.key === run.synthetic.key);
  if (!spec) throw new SimError(`Unknown synthetic career ${run.synthetic.key}.`);
  const kit = await loadKit();
  const memoryFile = path.join(run.dir, WRITER_MEMORY);
  const memory = fs.existsSync(memoryFile) ? readJson(memoryFile, 'Scripted-writer memory') : {};
  const writer = createScriptedWriter({ spec, kit, criteria: ctx.prod.la.APPLICATION_QUALITY_CRITERIA, matchGap: run.synthetic.matchGap === true, findingsCycles, memory });
  const responses = path.join(run.dir, 'responses');
  fs.mkdirSync(responses, { recursive: true, mode: 0o700 });
  let steps = 0;
  for (; steps < maxHandoffs; steps += 1) {
    const served = await getHandoff(ctx, { autoAck });
    if (!served.body.prompt) return { steps, ended: 'terminal', terminal: served.meta.terminal ?? null, body: served.body };
    const shared = sharedFieldsOfPrompt(served.body.prompt);
    const fields = await writer.respond({ stage: served.body.stage, prompt: served.body.prompt });
    writeJsonAtomic(memoryFile, writer.memory);
    const text = JSON.stringify(envelopeFor(shared, fields));
    const file = path.join(responses, `response-${served.meta.seq}-${ctx.state.submits + 1}.json`);
    writeFileAtomic(file, text);
    const result = await submitText(ctx, { code: served.body.handoffCode, text, responseFile: file });
    if (result.body.status !== 'accepted' && !(result.body.status === 'rejected' && allowRejections)) {
      return { steps: steps + 1, ended: 'stopped', stage: served.body.stage, body: result.body, meta: result.meta };
    }
  }
  return { steps, ended: 'max-handoffs' };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
const FLAGS = {
  init: { values: ['card', 'dir', 'snapshot-id', 'real-canvas', 'real-user-data', 'application-protocol'], booleans: ['match-gap', 'legacy', 'json'] },
  next: { values: ['dir'], booleans: ['auto-ack', 'reread', 'json'] },
  submit: { values: ['dir', 'file', 'code'], booleans: ['auto-ack', 'json'] },
  status: { values: ['dir'], booleans: ['json'] },
  docs: { values: ['dir'], booleans: ['json'] },
  log: { values: ['dir'], booleans: ['json'] },
  serve: { values: ['dir'], booleans: ['auto-ack', 'spool'] },
  autoplay: { values: ['dir', 'max-handoffs', 'findings-cycles'], booleans: ['allow-rejections', 'no-auto-ack', 'json'] },
};
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return { command: 'help', options: {} };
  const spec = FLAGS[command];
  if (!spec) throw usageError(`Unknown command "${command}". Run help.`);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument "${token}".`);
    const name = token.slice(2);
    if (spec.booleans.includes(name)) options[name] = true;
    else if (spec.values.includes(name)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw usageError(`--${name} needs a value.`);
      options[name] = value; index += 1;
    } else throw usageError(`Unknown option --${name} for ${command}.`);
  }
  return { command, options };
}

function printServed(served, options) {
  if (options.json) { out(JSON.stringify({ ...served.body, sim: { ...served.meta, text: undefined } })); return; }
  if (served.meta.text) { out(served.meta.text.trimEnd()); if (served.meta.autoAcknowledged) out(`(auto-acknowledged ${served.meta.autoAcknowledged} acknowledgement-only page(s) before this handoff)`); return; }
  const terminal = served.meta.terminal;
  out(terminal ? `NO OPEN HANDOFF: ${terminal.kind}${terminal.status?.message ? ` - ${terminal.status.message}` : ''}` : `NO OPEN HANDOFF: ${served.body.status}${served.body.note ? ` - ${served.body.note}` : ''}`);
  if (served.meta.autoAcknowledged) out(`(auto-acknowledged ${served.meta.autoAcknowledged} acknowledgement-only page(s))`);
}

export async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') { out(usage()); return 0; }
  for (const key of ['log', 'info', 'debug']) console[key] = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
  // A reader that closes early (| head) is not an error of ours.
  process.stdout.on('error', error => { if (error?.code !== 'EPIPE') throw error; });
  if (command === 'init') {
    const run = await initRun(options);
    if (options.json) { out(JSON.stringify(run)); return 0; }
    out(`initialized ${run.card} run in ${run.dir}`);
    out(`  job ${run.jobId}  snapshot ${run.snapshotId}`);
    out(`  posting: ${run.job.company || '(no company)'} / ${run.job.title || '(no title)'} (${run.job.listingChars} listing chars)`);
    out(`  isolated userData: ${run.userData}`);
    out(`  next: offline-simulator.mjs next --dir ${run.dir}`);
    return 0;
  }
  const run = loadRunManifest(options.dir);
  if (command === 'serve') { await serveLoop(options.dir, options); return 0; }
  return withRunLock(run.dir, async () => {
    const ctx = await openContext(options.dir);
    if (command === 'next') {
      const served = await getHandoff(ctx, { autoAck: options['auto-ack'] === true, reread: options.reread === true });
      printServed(served, options);
      return 0;
    }
    if (command === 'submit') {
      if (!options.file) throw usageError('--file response.json is required.');
      const stat = fs.statSync(options.file, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new SimError(`Response file not found: ${options.file}`);
      if (stat.size > 8 * 1024 * 1024) throw new SimError(`Response file is ${stat.size} bytes (the bridge refuses over ${ctx.prod.preflight.MAX_RESPONSE_BYTES}).`);
      const text = fs.readFileSync(options.file, 'utf8');
      if (!ctx.state.lane.current && !options.code) throw new SimError('No handoff is open. Run next first (a submit answers the handoff that next printed).');
      const code = options.code ?? ctx.state.lane.current.code;
      const result = await submitText(ctx, { code, text, responseFile: path.resolve(options.file) });
      let acknowledged = 0;
      if (options['auto-ack'] === true && result.body.status === 'accepted') {
        const served = await getHandoff(ctx, { autoAck: true });
        acknowledged = served.meta.autoAcknowledged || 0;
      }
      if (options.json) out(JSON.stringify({ ...result.body, sim: { ...result.meta, autoAcknowledged: acknowledged } }));
      else { out(renderSubmit(result, ctx.run)); if (acknowledged) out(`(auto-acknowledged ${acknowledged} page(s); run next for the open handoff)`); }
      return exitForSubmit(result.body);
    }
    if (command === 'status') {
      const status = await runStatus(ctx);
      out(options.json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
      return 0;
    }
    if (command === 'docs') {
      const docs = await writeDocs(ctx.run);
      out(options.json ? JSON.stringify(docs) : `documents from ${docs.source}\n${Object.entries(docs.files).map(([kind, file]) => `  ${kind}: ${file}`).join('\n') || '  (none yet)'}`);
      return 0;
    }
    if (command === 'log') {
      const log = buildLog(ctx.run);
      if (options.json) { out(JSON.stringify(log)); return 0; }
      out(`handoffs ${log.totals.handoffs} (${log.totals.servings} servings) | submits ${log.totals.submits} (accepted ${log.totals.accepted}, rejected ${log.totals.rejected}, refused by bridge ${log.totals.bridgeRefused}, auto-ack ${log.totals.autoAcknowledged})`);
      for (const [stage, row] of Object.entries(log.stages)) out(`  ${stage.padEnd(26)} submits ${String(row.submits).padStart(3)} accepted ${String(row.accepted).padStart(3)} rejected ${String(row.rejected).padStart(3)} handoffs ${String(row.handoffs).padStart(3)}${row.autoAck ? ` auto-ack ${row.autoAck}` : ''}`);
      for (const item of log.rejections) out(`  rejection #${item.n} ${item.stage}: ${item.errorCount} error(s); check ids [${item.checkIds.join(', ')}]; streak ${item.rejectionStreak ?? 'n/a'}${item.firstErrors[0] ? `\n      ${item.firstErrors[0]}` : ''}`);
      if (log.terminal) out(`terminal: ${log.terminal.kind}`);
      return 0;
    }
    if (command === 'autoplay') {
      const outcome = await autoplay(ctx, {
        maxHandoffs: options['max-handoffs'] ? Number(options['max-handoffs']) : 200,
        findingsCycles: options['findings-cycles'] ? Number(options['findings-cycles']) : 0,
        allowRejections: options['allow-rejections'] === true, autoAck: options['no-auto-ack'] !== true,
      });
      out(options.json ? JSON.stringify(outcome) : `autoplay ${outcome.ended} after ${outcome.steps} handoff(s)${outcome.terminal ? `: ${outcome.terminal.kind}` : ''}${outcome.stage ? ` at ${outcome.stage}: ${outcome.body.status}` : ''}`);
      if (outcome.body?.validationErrors) outcome.body.validationErrors.forEach((item, index) => out(`  ${index + 1}. ${item}`));
      return outcome.ended === 'stopped' ? 3 : 0;
    }
    throw usageError(`Unhandled command ${command}.`);
  });
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    error => {
      process.stderr.write(`offline-simulator: ${error?.message || error}\n`);
      process.exitCode = error?.exit || 1;
    },
  );
}
