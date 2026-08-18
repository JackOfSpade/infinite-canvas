/**
 * Human-in-the-loop Local AI application jobs.
 *
 * This module deliberately does not launch, scrape, or automate Claude Code.
 * The app writes a private, app-owned job folder; the user runs the supplied
 * routine in Claude Code; Claude writes one constrained result.json; then this
 * process validates and imports it through the same application-save capability
 * used by API generation. A subscription UI must never be treated as an API.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { JSDOM } from 'jsdom';
import { handleSafe } from './ipcUtils.js';
import { formatOriginalJobListingMarkdown } from './applicationBundle.js';
import { buildCoverLetterDocument, buildResumeDocument } from './resumeHtml.js';
import { renderPdf, applyDualPdf } from './resumeRender.js';
import { applicationVariantAttrsForJob, normalizeApplicationAdditionalNotes, normalizeCoverLetterParagraphs, recordApplicationTelemetry, registerPendingApplicationWorkspace, targetPageCountForJob } from './jobApplication.js';
import { applicationConvergenceInstruction, expectedApplicationQualityDecision, isApplicationQualityDecision } from './applicationConvergence.js';
import { isWithinDirectory } from '../utils/pathSafety.js';
import { logger } from '../logger.js';

const { shell } = electronPkg;

export const LOCAL_AI_APPLICATION_VERSION = 1;
const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_CAREER_DATA_CHARS = 240_000;
const MAX_RESUME_HTML_CHARS = 220_000;
const MAX_PARAGRAPH_CHARS = 4_000;
const MAX_RESULT_BYTES = 1_000_000;
const LOCAL_AI_STALE_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LOCAL_AI_UNFINISHED_JOBS = 20;
const LOCAL_AI_FIT_FEEDBACK_FILE = 'fit-feedback.json';
const MAX_LOCAL_AI_HANDOFF_EVENTS = 12;

function cleanText(value, max = 20_000) {
  return Array.from(String(value ?? ''), char => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\t' ? ' ' : char;
  }).join('').replace(/\r\n?/g, '\n').slice(0, max);
}

function safeJob(raw = {}) {
  return {
    title: cleanText(raw.title, 500).trim(), company: cleanText(raw.company, 500).trim(),
    snippet: cleanText(raw.snippet, 80_000).trim(), location: cleanText(raw.location, 500).trim(),
    salary: cleanText(raw.salary, 500).trim(), url: cleanText(raw.url, 2_000).trim(),
    source: cleanText(raw.source, 500).trim(), posted: cleanText(raw.posted, 500).trim(),
    language: cleanText(raw.language, 120).trim(),
  };
}

function safeJson(value, fallback = null) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function localAiProjectRoot(canvasFilePath = '') {
  // The canonical launcher runs the packaged .app from <project>/release/.
  // Walk upward from both cwd and the executable so that packaged local builds
  // still hand jobs to the source project Claude Code is scoped to. A copied,
  // standalone .app falls back to the saved canvas's folder.
  const seeds = [process.env.INFINITE_CANVAS_PROJECT_ROOT, process.cwd(), path.dirname(process.execPath || '')]
    .filter(Boolean);
  for (const seed of seeds) {
    let candidate = path.resolve(seed);
    for (let depth = 0; depth < 8; depth += 1) {
      if (fs.existsSync(path.join(candidate, 'package.json'))
        && fs.existsSync(path.join(candidate, 'Job Application Design System'))) return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return canvasFilePath ? path.dirname(path.resolve(canvasFilePath)) : path.resolve(process.cwd());
}

async function resolveCanvasProject(canvasFilePath) {
  if (typeof canvasFilePath !== 'string' || !canvasFilePath.trim() || !path.isAbsolute(canvasFilePath)) {
    throw new Error('Save this canvas to a file before using Local AI.');
  }
  const requested = path.resolve(canvasFilePath);
  const stat = await fs.promises.lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The active canvas must be a regular saved file for Local AI.');
  const canonicalCanvasFilePath = await fs.promises.realpath(requested);
  return { canonicalCanvasFilePath, canvasRoot: await fs.promises.realpath(path.dirname(canonicalCanvasFilePath)) };
}

function localJobsRoot(canvasRoot) {
  return path.join(canvasRoot, '.local-ai', 'jobs');
}

// The job folder intentionally holds private career context while Claude Code
// works. A completed application is promoted into its final bundle and then
// removed by save-application; this guard is for abandoned/manual jobs only.
// It runs on the next Generate, never while an existing job is being used.
async function pruneAndCountLocalAiJobs(canvasRoot) {
  const root = localJobsRoot(canvasRoot);
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  const realRoot = await fs.promises.realpath(root);
  if (realRoot !== root || !isWithinDirectory(canvasRoot, realRoot)) {
    throw new Error('The canvas .local-ai/jobs folder must not be a symbolic link or leave the canvas folder.');
  }
  const cutoff = Date.now() - LOCAL_AI_STALE_JOB_RETENTION_MS;
  let retained = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue;
    const dir = path.join(realRoot, entry.name);
    let stat;
    try { stat = await fs.promises.lstat(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let createdAt = stat.mtimeMs;
    try {
      const manifest = JSON.parse(await readOwnedFile(realRoot, path.join(dir, 'manifest.json'), { maxBytes: 64_000 }));
      const parsedCreatedAt = Date.parse(manifest?.createdAt || '');
      if (Number.isFinite(parsedCreatedAt)) createdAt = parsedCreatedAt;
    } catch { /* malformed jobs are retained until their directory ages out */ }
    if (createdAt < cutoff) {
      const realDir = await fs.promises.realpath(dir).catch(() => null);
      if (realDir && isWithinDirectory(realRoot, realDir) && realDir !== realRoot) {
        await fs.promises.rm(realDir, { recursive: true, force: true });
      }
      continue;
    }
    retained += 1;
  }
  return retained;
}

function jobDirectory(jobId, canvasRoot) {
  if (!JOB_ID_RE.test(String(jobId || ''))) throw new Error('Invalid Local AI job id.');
  const root = path.resolve(localJobsRoot(canvasRoot));
  const dir = path.resolve(root, jobId);
  if (!isWithinDirectory(root, dir) || dir === root) throw new Error('Local AI job path escaped its app-owned folder.');
  return { root, dir };
}

async function assertRealJobDirectory(jobId, canvasFilePath) {
  const canvas = await resolveCanvasProject(canvasFilePath);
  const { root, dir } = jobDirectory(jobId, canvas.canvasRoot);
  const [realRoot, realDir] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(dir)]);
  if (realRoot !== root || !isWithinDirectory(canvas.canvasRoot, realRoot)
    || !isWithinDirectory(realRoot, realDir) || realDir === realRoot) {
    throw new Error('Local AI job directory is not trusted.');
  }
  return { root: realRoot, dir: realDir, ...canvas };
}

export function resolveLocalOutputBundleRoot(value, projectRoot) {
  const raw = cleanText(value || 'Applied Jobs', 500).trim().replace(/\\/g, '/');
  if (!projectRoot || !raw || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error('Local AI outputBundleRoot must be a non-empty path relative to the canvas folder.');
  }
  if (raw.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Local AI outputBundleRoot cannot contain traversal segments.');
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolved = path.resolve(resolvedProjectRoot, raw);
  if (resolved === resolvedProjectRoot || !isWithinDirectory(resolvedProjectRoot, resolved)) {
    throw new Error('Local AI outputBundleRoot must stay inside the canvas folder.');
  }
  return { relative: path.relative(resolvedProjectRoot, resolved), resolved };
}

async function materializeTrustedOutputRoot(value, projectRoot) {
  const output = resolveLocalOutputBundleRoot(value, projectRoot);
  await fs.promises.mkdir(output.resolved, { recursive: true, mode: 0o700 });
  const [realProjectRoot, realOutputRoot] = await Promise.all([
    fs.promises.realpath(projectRoot),
    fs.promises.realpath(output.resolved),
  ]);
  if (realOutputRoot === realProjectRoot || !isWithinDirectory(realProjectRoot, realOutputRoot)) {
    throw new Error('Local AI outputBundleRoot resolves outside the canvas folder.');
  }
  return { relative: output.relative, resolved: realOutputRoot };
}

async function readOwnedFile(root, candidate, { maxBytes = MAX_RESULT_BYTES } = {}) {
  const resolved = path.resolve(candidate);
  if (!isWithinDirectory(root, resolved)) throw new Error('Local AI result escaped its job folder.');
  const stat = await fs.promises.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local AI result must be a regular file, not a link.');
  if (stat.size > maxBytes) throw new Error('Local AI result is too large.');
  return fs.promises.readFile(resolved, 'utf8');
}

async function atomicJson(target, data) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temp, target);
}

async function ensureProjectRoutine(projectRoot) {
  const target = path.join(projectRoot, 'local_ai', 'CLAUDE_CODE_ROUTINE.md');
  try { await fs.promises.access(target, fs.constants.R_OK); return target; }
  catch { /* a standalone packaged app copies its bundled default below */ }
  const bundled = process.resourcesPath
    ? path.join(process.resourcesPath, 'local_ai', 'CLAUDE_CODE_ROUTINE.md')
    : '';
  if (!bundled || !fs.existsSync(bundled)) {
    throw new Error('Local AI routine is missing. Restore local_ai/CLAUDE_CODE_ROUTINE.md in the project.');
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(bundled, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function promptFor(jobId) {
  return `# Run Local AI application job ${jobId}\n\nRead and follow the project routine at \`local_ai/CLAUDE_CODE_ROUTINE.md\`. Process only the folder containing this prompt; it is job \`${jobId}\` under the routine's configured \`INPUT_JOBS_ROOT\`. Copy the effective \`OUTPUT_BUNDLE_ROOT\` value exactly into \`result.json.outputBundleRoot\`. Write no other files.\n`;
}

function sanitizeResumeMainHtml(raw) {
  const html = String(raw || '').trim();
  if (!html || html.length > MAX_RESUME_HTML_CHARS) throw new Error('Local AI résumé markup is missing or too large.');
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const body = dom.window.document.body;
  const mains = [...body.querySelectorAll('main')];
  if (mains.length !== 1 || !mains[0].classList.contains('page') || body.children.length !== 1) {
    throw new Error('Local AI résumé must be exactly one <main class="page"> block.');
  }
  const forbidden = 'script,style,link,iframe,object,embed,base,meta,form,input,button,svg,math';
  if (body.querySelector(forbidden)) throw new Error('Local AI résumé contains a forbidden element.');
  for (const el of body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '').trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style' || name === 'xmlns'
        || (['href', 'src', 'xlink:href'].includes(name) && (value.startsWith('javascript:') || value.startsWith('data:') || /^https?:/.test(value)))) {
        throw new Error('Local AI résumé contains an unsafe attribute.');
      }
    }
  }
  return mains[0].outerHTML;
}

function sanitizeCoverLetter(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Local AI coverLetter must be an object.');
  const paragraphs = normalizeCoverLetterParagraphs(raw.paragraphs)
    .map(value => cleanText(value, MAX_PARAGRAPH_CHARS).trim()).filter(Boolean).slice(0, 4);
  if (!paragraphs.length) throw new Error('Local AI cover letter needs at least one paragraph.');
  const text = (value, max = 500) => cleanText(value, max).replace(/\s+/g, ' ').trim();
  return {
    name: text(raw.name, 240), contact: (Array.isArray(raw.contact) ? raw.contact : []).map(item => text(item, 300)).filter(Boolean).slice(0, 6),
    salutation: text(raw.salutation), recipient: text(raw.recipient), paragraphs,
    closing: text(raw.closing), signatureTitle: text(raw.signatureTitle),
  };
}

function sanitizeQualityReview(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI result must include qualityReview for both documents.');
  }
  const documentReview = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !isApplicationQualityDecision(value.decision)) {
      throw new Error(`Local AI qualityReview.${label}.decision is invalid.`);
    }
    const rationale = cleanText(value.rationale, 800).replace(/\s+/g, ' ').trim();
    if (rationale.length < 20) throw new Error(`Local AI qualityReview.${label}.rationale is too vague.`);
    // This is only a shallow guard against a completely page-fit-only review;
    // it must not reject a concrete structural rationale just because it also
    // cites the measured overflow that prompted the revision.  The old narrow
    // keyword list rejected valid explanations such as "dropped the weakest
    // role" and left an otherwise import-ready Local AI job permanently
    // invalid.  Hash/decision consistency below remains the authoritative
    // machine-verifiable quality-review check.
    if (/\b(?:fits?|fit|page|pages|one-page|1-page)\b/i.test(rationale)
      && !/\b(?:relevan|eviden|argument|fact|specific|redundan|quality|priorit|requirement|structural|role|bullet|project|align)/i.test(rationale)) {
      throw new Error(`Local AI qualityReview.${label}.rationale cannot use page fit as its only quality reason.`);
    }
    return { decision: value.decision, rationale };
  };
  return {
    resume: documentReview(raw.resume, 'resume'),
    coverLetter: documentReview(raw.coverLetter, 'coverLetter'),
  };
}

export function validateLocalApplicationResult(raw, jobId, projectRoot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Local AI result must be a JSON object.');
  if (raw.version !== LOCAL_AI_APPLICATION_VERSION || raw.jobId !== jobId || raw.status !== 'completed') {
    throw new Error('Local AI result does not belong to this job or uses an unsupported version.');
  }
  if (typeof raw.outputBundleRoot !== 'string') throw new Error('Local AI result must include outputBundleRoot.');
  const output = resolveLocalOutputBundleRoot(raw.outputBundleRoot, projectRoot);
  return {
    resumeMainHtml: sanitizeResumeMainHtml(raw.resumeMainHtml),
    coverLetter: sanitizeCoverLetter(raw.coverLetter),
    qualityReview: sanitizeQualityReview(raw.qualityReview),
    outputBundleRoot: output.relative,
    outputBundleRootPath: output.resolved,
  };
}

function localAiDocumentHashes(result) {
  return {
    resume: contentHash(result.resumeMainHtml),
    coverLetter: contentHash(JSON.stringify(result.coverLetter)),
  };
}

function assertLocalAiQualityReviewConsistency(result, priorFeedback) {
  const hashes = localAiDocumentHashes(result);
  const priorHashes = priorFeedback?.documentSha256;
  for (const [key, label] of [['resume', 'resume'], ['coverLetter', 'coverLetter']]) {
    const expected = expectedApplicationQualityDecision({
      priorHash: priorHashes?.[key] || '',
      currentHash: hashes[key],
    });
    if (result.qualityReview[key].decision !== expected) {
      const reason = expected === 'drafted'
        ? 'has no prior measured version'
        : expected === 'changed_materially' ? 'changed' : 'is byte-for-byte unchanged';
      throw new Error(`Local AI qualityReview.${label}.decision must be ${expected} because that document ${reason}.`);
    }
  }
  return hashes;
}

// Local AI has no API model available for the normal prose-revision pass, but
// it still gets the free compact-density retry. If that does not fit, do NOT
// truncate bullets mechanically: a Local AI revision can rank them against the
// target job far better than source-order deletion can. The app writes trusted
// fit feedback and waits for that revision instead.
async function renderLocalResumeWithFit({ resumeMainHtml, ledger, docId, targetPageCount, job, signal }) {
  const attempts = [];
  let mainHtml = resumeMainHtml;
  const baseVariantAttrs = applicationVariantAttrsForJob(job);
  // Layout density is app-owned. A model never has a measured page count at
  // draft time, so ignore any `data-density` it supplied and establish the
  // default-density baseline first. Only this loop may enable compact after
  // that baseline measurably overflows the requested page count.
  let density = null;
  let compactApplied = false;
  let bytes = null;
  let pageCount = null;
  let fontsLoaded = true;
  let renderError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const variantAttrs = density === 'compact'
      ? `${baseVariantAttrs} data-density="compact"`
      : baseVariantAttrs;
    try {
      const rendered = await renderPdf(buildResumeDocument({ resumeMainHtml: mainHtml, variantAttrs, ledger, docId }), { signal });
      pageCount = rendered.pageCount;
      fontsLoaded = rendered.fontsLoaded !== false;
      bytes = fontsLoaded ? rendered.bytes : null;
      renderError = null;
      attempts.push({ attempt, density, pageCount, fontsLoaded });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      bytes = null;
      pageCount = null;
      renderError = error?.message || String(error);
      attempts.push({ attempt, density, pageCount: null, error: renderError });
      logger.warn(`[LocalAI] Résumé PDF render failed (attempt ${attempt}/2, density=${density || 'default'}): ${renderError}`);
      break;
    }

    if (!fontsLoaded || pageCount <= targetPageCount) break;
    if (density !== 'compact') {
      density = 'compact';
      compactApplied = true;
      continue;
    }
    break;
  }

  const variantAttrs = density === 'compact'
    ? `${baseVariantAttrs} data-density="compact"`
    : baseVariantAttrs;
  return {
    mainHtml, variantAttrs, bytes, pageCount, fontsLoaded, renderError,
    attempts, compactApplied,
  };
}

async function renderLocalCoverLetter({ letter, variantAttrs, docId, signal }) {
  try {
    const rendered = await renderPdf(buildCoverLetterDocument({ letter, variantAttrs, docId }), { signal });
    const fontsLoaded = rendered.fontsLoaded !== false;
    return {
      bytes: fontsLoaded ? rendered.bytes : null,
      pageCount: Number.isFinite(rendered.pageCount) ? rendered.pageCount : null,
      fontsLoaded,
      renderError: fontsLoaded ? null : 'Web fonts were unavailable while rendering the cover-letter PDF.',
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const renderError = error?.message || String(error);
    logger.warn(`[LocalAI] Cover-letter PDF render failed: ${renderError}`);
    return { bytes: null, pageCount: null, fontsLoaded: null, renderError };
  }
}

async function loadManifest(root) {
  const source = await readOwnedFile(root, path.join(root, 'manifest.json'));
  const manifest = JSON.parse(source);
  if (manifest?.version !== LOCAL_AI_APPLICATION_VERSION || !JOB_ID_RE.test(manifest?.id || '')) throw new Error('Local AI job manifest is invalid.');
  return manifest;
}

// Keep a compact, app-authored trail beside the private job context. Claude
// may read manifest.json while waiting, but never writes it; this means FULL
// diagnostics can prove each observed result hash/page count without leaking
// candidate content or relying on the short general log ring.
function localAiHandoffEvent({ type, resultRaw, revisionRound = null, resumeFit = null, coverLetterFit = null, qualityReview = null, detail = '' } = {}) {
  return {
    at: new Date().toISOString(),
    type: cleanText(type, 80),
    resultSha256: contentHash(resultRaw).slice(0, 16),
    revisionRound: Number.isFinite(revisionRound) ? revisionRound : null,
    resume: resumeFit ? {
      pageCount: Number.isFinite(resumeFit.pageCount) ? resumeFit.pageCount : null,
      targetPageCount: Number.isFinite(resumeFit.targetPageCount) ? resumeFit.targetPageCount : null,
      attempts: (Array.isArray(resumeFit.attempts) ? resumeFit.attempts : []).map(attempt => ({
        attempt: Number.isFinite(attempt?.attempt) ? attempt.attempt : null,
        density: attempt?.density === 'compact' ? 'compact' : 'default',
        pageCount: Number.isFinite(attempt?.pageCount) ? attempt.pageCount : null,
        fontsLoaded: attempt?.fontsLoaded === false ? false : attempt?.fontsLoaded === true ? true : null,
        error: attempt?.error ? cleanText(attempt.error, 280) : null,
      })).slice(0, 4),
    } : null,
    coverLetter: coverLetterFit ? {
      pageCount: Number.isFinite(coverLetterFit.pageCount) ? coverLetterFit.pageCount : null,
      targetPageCount: Number.isFinite(coverLetterFit.targetPageCount) ? coverLetterFit.targetPageCount : null,
      fontsLoaded: coverLetterFit.fontsLoaded === false ? false : coverLetterFit.fontsLoaded === true ? true : null,
      error: coverLetterFit.renderError ? cleanText(coverLetterFit.renderError, 280) : null,
    } : null,
    qualityReview: qualityReview ? {
      resume: {
        decision: cleanText(qualityReview.resume?.decision, 80),
        rationale: cleanText(qualityReview.resume?.rationale, 800),
      },
      coverLetter: {
        decision: cleanText(qualityReview.coverLetter?.decision, 80),
        rationale: cleanText(qualityReview.coverLetter?.rationale, 800),
      },
    } : null,
    detail: detail ? cleanText(detail, 500) : '',
  };
}

async function appendLocalAiHandoffEvent(dir, manifest, event) {
  const prior = Array.isArray(manifest?.handoffHistory) ? manifest.handoffHistory : [];
  const history = [...prior, event]
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .slice(-MAX_LOCAL_AI_HANDOFF_EVENTS);
  const nextManifest = { ...manifest, handoffHistory: history };
  await atomicJson(path.join(dir, 'manifest.json'), nextManifest);
  return nextManifest;
}

async function readLocalFitFeedback(root, dir) {
  try {
    const raw = await readOwnedFile(root, path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), { maxBytes: 64_000 });
    const feedback = JSON.parse(raw);
    return feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // A malformed app-generated advisory must never hide an otherwise usable
    // result.json. The next render/import will replace it if feedback is needed.
    logger.warn(`[LocalAI] Ignoring unreadable fit feedback: ${error?.message || error}`);
    return null;
  }
}

export async function queueLocalApplicationJob(args = {}) {
  const id = crypto.randomUUID();
  const canvas = await resolveCanvasProject(args.canvasFilePath);
  // The shared routine is source-project scoped; the per-canvas job data is
  // deliberately NOT. This separation keeps a portable canvas self-contained
  // without creating a second editable routine beside every canvas.
  const routineProjectRoot = localAiProjectRoot(canvas.canonicalCanvasFilePath);
  await ensureProjectRoutine(routineProjectRoot);
  const root = localJobsRoot(canvas.canvasRoot);
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.promises.realpath(root);
  if (realRoot !== root || !isWithinDirectory(canvas.canvasRoot, realRoot)) {
    throw new Error('The canvas .local-ai/jobs folder must not be a symbolic link or leave the canvas folder.');
  }
  const unfinishedCount = await pruneAndCountLocalAiJobs(canvas.canvasRoot);
  if (unfinishedCount >= MAX_LOCAL_AI_UNFINISHED_JOBS) {
    throw new Error(`This canvas already has ${MAX_LOCAL_AI_UNFINISHED_JOBS} unfinished Local AI jobs. Complete or remove an old .local-ai/jobs folder before generating another.`);
  }
  const dir = path.join(realRoot, id);
  await fs.promises.mkdir(dir, { mode: 0o700 });
  const job = safeJob(args.job);
  const careerData = cleanText(args.careerData, MAX_CAREER_DATA_CHARS);
  const input = {
    version: LOCAL_AI_APPLICATION_VERSION, jobId: id, createdAt: new Date().toISOString(),
    canvasFilePath: canvas.canonicalCanvasFilePath, canvasRoot: canvas.canvasRoot, job,
    additionalNotes: normalizeApplicationAdditionalNotes(args.additionalNotes),
    reasoning: cleanText(args.reasoning, 8_000), matchScore: Number.isFinite(args.matchScore) ? args.matchScore : null,
    achievements: safeJson(args.achievements), mineAllowed: Boolean(args.mineAllowed),
    targetPageCount: Number.isFinite(args.targetPageCount) && args.targetPageCount > 0 ? Math.round(args.targetPageCount) : targetPageCountForJob(job.title),
  };
  const manifest = {
    version: LOCAL_AI_APPLICATION_VERSION, id, status: 'queued', createdAt: input.createdAt,
    canvasFilePath: canvas.canonicalCanvasFilePath, canvasRoot: canvas.canvasRoot,
    files: ['input.json', 'context/job-listing.md', 'context/career-data.txt', 'CLAUDE_CODE_PROMPT.md', 'result.json'],
  };
  try {
    await fs.promises.mkdir(path.join(dir, 'context'), { recursive: true, mode: 0o700 });
    await Promise.all([
      atomicJson(path.join(dir, 'input.json'), input), atomicJson(path.join(dir, 'manifest.json'), manifest),
      fs.promises.writeFile(path.join(dir, 'context', 'job-listing.md'), formatOriginalJobListingMarkdown(job), { encoding: 'utf8', mode: 0o600 }),
      fs.promises.writeFile(path.join(dir, 'context', 'career-data.txt'), careerData, { encoding: 'utf8', mode: 0o600 }),
      fs.promises.writeFile(path.join(dir, 'CLAUDE_CODE_PROMPT.md'), promptFor(id), { encoding: 'utf8', mode: 0o600 }),
    ]);
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { id, status: 'queued', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: 'Local AI job is ready beside this canvas in .local-ai/jobs. Run CLAUDE_CODE_PROMPT.md with your subscription-authenticated Claude Code session.' };
}

function assertManifestCanvasOwnership(manifest, input, canvas) {
  if (path.resolve(String(manifest?.canvasFilePath || '')) !== canvas.canonicalCanvasFilePath
    || path.resolve(String(input?.canvasFilePath || '')) !== canvas.canonicalCanvasFilePath
    || path.resolve(String(manifest?.canvasRoot || '')) !== canvas.canvasRoot
    || path.resolve(String(input?.canvasRoot || '')) !== canvas.canvasRoot) {
    throw new Error('Local AI job belongs to a different saved canvas.');
  }
}

export async function localApplicationStatus(jobId, canvasFilePath) {
  const { root, dir, ...canvas } = await assertRealJobDirectory(jobId, canvasFilePath);
  const manifest = await loadManifest(dir);
  const input = JSON.parse(await readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }));
  assertManifestCanvasOwnership(manifest, input, canvas);
  let status = 'queued'; let message = 'Awaiting result.json from Claude Code.';
  try {
    const rawText = await readOwnedFile(root, path.join(dir, 'result.json'));
    const raw = JSON.parse(rawText);
    const validated = validateLocalApplicationResult(raw, jobId, canvas.canvasRoot);
    const feedback = await readLocalFitFeedback(root, dir);
    const matchingFeedback = feedback?.jobId === jobId && feedback?.resultSha256 === contentHash(rawText);
    if (!matchingFeedback) assertLocalAiQualityReviewConsistency(validated, feedback);
    status = 'completed'; message = 'Validated result.json is ready to import.';
    if (matchingFeedback) {
      status = feedback.status === 'revision-exhausted' ? 'revision-exhausted' : 'revision-required';
      message = String(feedback.message || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine to revise result.json using fit-feedback.json.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') { status = 'invalid'; message = String(error?.message || error); }
  }
  return { id: jobId, status, folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, createdAt: manifest.createdAt, message };
}

export async function importLocalApplicationJob({ jobId, canvasFilePath, senderId, signal }) {
  const { root, dir, ...canvas } = await assertRealJobDirectory(jobId, canvasFilePath);
  const [manifest, inputRaw, resultRaw] = await Promise.all([
    loadManifest(dir), readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }), readOwnedFile(root, path.join(dir, 'result.json')),
  ]);
  const input = JSON.parse(inputRaw);
  if (manifest.id !== jobId || input?.jobId !== jobId || input?.version !== LOCAL_AI_APPLICATION_VERSION) throw new Error('Local AI job input is invalid.');
  assertManifestCanvasOwnership(manifest, input, canvas);
  const result = validateLocalApplicationResult(JSON.parse(resultRaw), jobId, canvas.canvasRoot);
  const priorFeedback = await readLocalFitFeedback(root, dir);
  const matchingPriorFeedback = priorFeedback?.jobId === jobId && priorFeedback?.resultSha256 === contentHash(resultRaw);
  const documentSha256 = matchingPriorFeedback
    ? localAiDocumentHashes(result)
    : assertLocalAiQualityReviewConsistency(result, priorFeedback);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const docId = crypto.randomUUID();
  const ledger = Array.isArray(input?.achievements?.ledger) ? input.achievements.ledger : null;
  const targetPageCount = Number.isFinite(input?.targetPageCount) && input.targetPageCount > 0
    ? input.targetPageCount
    : targetPageCountForJob(input.job?.title);
  const resumeFit = await renderLocalResumeWithFit({
    resumeMainHtml: result.resumeMainHtml, ledger, docId, targetPageCount, job: input.job, signal,
  });
  const coverLetterFit = await renderLocalCoverLetter({
    letter: result.coverLetter, variantAttrs: resumeFit.variantAttrs, docId: `${docId}-cover`, signal,
  });
  const resumeHandoffFit = { ...resumeFit, targetPageCount };
  const coverLetterHandoffFit = { ...coverLetterFit, targetPageCount: 1 };
  const verificationIssues = [
    ...(!resumeFit.bytes || resumeFit.fontsLoaded !== true || resumeFit.pageCount == null
      ? [`résumé layout could not be verified${resumeFit.renderError ? `: ${resumeFit.renderError}` : resumeFit.fontsLoaded === false ? ': web fonts were unavailable' : ''}`] : []),
    ...(!coverLetterFit.bytes || coverLetterFit.fontsLoaded !== true || coverLetterFit.pageCount == null
      ? [`cover-letter layout could not be verified${coverLetterFit.renderError ? `: ${coverLetterFit.renderError}` : coverLetterFit.fontsLoaded === false ? ': web fonts were unavailable' : ''}`] : []),
  ];
  if (verificationIssues.length) {
    const renderMessage = `${verificationIssues.join('; ')}. No final bundle was saved. Retry the measured import when rendering is available; the AI draft does not need another rewrite.`;
    const handoffManifest = await appendLocalAiHandoffEvent(dir, manifest, localAiHandoffEvent({
      type: 'layout-verification-unavailable', resultRaw, resumeFit: resumeHandoffFit,
      coverLetterFit: coverLetterHandoffFit, qualityReview: result.qualityReview, detail: renderMessage,
    }));
    recordApplicationTelemetry({
      source: 'local-ai', status: 'render-retry-required', phase: 'layout verification unavailable', attemptId: `local-${jobId}`,
      jobTitle: input.job?.title || '', company: input.job?.company || '', jobLocation: input.job?.location || '',
      render: {
        targetPageCount, initialPageCount: resumeFit.attempts[0]?.pageCount ?? null,
        finalPageCount: resumeFit.pageCount, attempts: resumeFit.attempts,
        compactApplied: resumeFit.compactApplied, error: resumeFit.renderError,
        coverLetterPageCount: coverLetterFit.pageCount, coverLetterFontsLoaded: coverLetterFit.fontsLoaded,
        coverLetterPdfError: coverLetterFit.renderError,
      },
      localAi: { jobId, verificationIssues, qualityReview: result.qualityReview, handoffHistory: handoffManifest.handoffHistory },
    });
    return {
      id: jobId, status: 'render-retry-required', company: input.job?.company || '', candidateName: result.coverLetter.name,
      renderMessage, verificationIssues,
      localJob: { id: jobId, status: 'render-retry-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: renderMessage },
    };
  }
  const targetMet = resumeFit.pageCount != null && resumeFit.pageCount <= targetPageCount;
  const coverLetterTargetMet = coverLetterFit.pageCount != null && coverLetterFit.pageCount <= 1;
  const fitIssues = [
    ...(resumeFit.fontsLoaded !== false && resumeFit.pageCount != null && !targetMet
      ? [`résumé is ${resumeFit.pageCount} pages (target: ${targetPageCount})`] : []),
    ...(coverLetterFit.fontsLoaded !== false && coverLetterFit.pageCount != null && !coverLetterTargetMet
      ? [`cover letter is ${coverLetterFit.pageCount} pages (target: 1)`] : []),
  ];
  if (fitIssues.length) {
    const revisionRound = Math.max(0, Number(priorFeedback?.revisionRound) || 0) + 1;
    const diminishingReturnsDocuments = [
      ...(!targetMet && result.qualityReview.resume.decision === 'kept_diminishing_returns' ? ['résumé'] : []),
      ...(!coverLetterTargetMet && result.qualityReview.coverLetter.decision === 'kept_diminishing_returns' ? ['cover letter'] : []),
    ];
    const revisionExhausted = diminishingReturnsDocuments.length > 0;
    const fitMessage = revisionExhausted
      ? `${fitIssues.join('; ')}. ${diminishingReturnsDocuments.join(' and ')} remained unchanged after an explicit diminishing-returns quality review. No bundle was saved.`
      : `${fitIssues.join('; ')}. Continue the Local AI routine with measured revision ${revisionRound} using fit-feedback.json; there is no fixed revision limit.`;
    const feedback = {
      version: 1,
      jobId,
      status: revisionExhausted ? 'revision-exhausted' : 'revision-required',
      revisionRound,
      resultSha256: contentHash(resultRaw),
      documentSha256,
      qualityReview: result.qualityReview,
      requestedAt: new Date().toISOString(),
      targetPageCount,
      resume: { pageCount: resumeFit.pageCount, targetPageCount, attempts: resumeFit.attempts },
      coverLetter: { pageCount: coverLetterFit.pageCount, targetPageCount: 1 },
      instruction: revisionExhausted
        ? `Stop this measured revision loop. The app verified that the overflowing ${diminishingReturnsDocuments.join(' and ')} is byte-for-byte unchanged and its quality review explicitly recorded diminishing returns.`
        : `Before overwriting result.json, compare both documents with the strongest concrete improvement identified by a private quality critique. Page fit is a constraint, not a quality-completion signal. ${applicationConvergenceInstruction({ revisionAttempt: revisionRound, unchangedSignal: 'keep that document byte-for-byte unchanged and record kept_diminishing_returns with a concrete rationale' })} For the résumé, preserve direct matches to the job’s highest-priority requirements, concrete outcomes and scale, and credible differentiators. Cut generic, redundant, weakly related, or low-evidence content first. For a cover letter that already fits, improve it when the comparison finds a material argument or relevance gain; do not rewrite it merely because the résumé overflowed. Treat only the page counts and render attempts in this feedback as app measurements. Do not claim that the app confirmed bullet line counts, page fullness, or the cause of overflow; label markup-based conclusions as your own diagnosis. Do not infer candidate contact details, preserve text merely because it appears earlier, or invent facts. Overwrite only result.json when done.`,
      message: fitMessage,
    };
    await atomicJson(path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), feedback);
    const handoffManifest = await appendLocalAiHandoffEvent(dir, manifest, localAiHandoffEvent({
      type: revisionExhausted ? 'fit-revisions-exhausted' : 'fit-revision-requested',
      resultRaw, revisionRound, resumeFit: resumeHandoffFit, coverLetterFit: coverLetterHandoffFit,
      qualityReview: result.qualityReview, detail: fitMessage,
    }));
    recordApplicationTelemetry({
      source: 'local-ai', status: revisionExhausted ? 'revision-exhausted' : 'revision-required', phase: revisionExhausted ? 'fit revisions exhausted' : 'fit revision requested', attemptId: `local-${jobId}`,
      jobTitle: input.job?.title || '', company: input.job?.company || '', jobLocation: input.job?.location || '',
      render: {
        targetPageCount, initialPageCount: resumeFit.attempts[0]?.pageCount ?? null,
        finalPageCount: resumeFit.pageCount, baselinePageCount: resumeFit.pageCount,
        baselinePdfProduced: false, baselineFontsLoaded: resumeFit.fontsLoaded,
        attempts: resumeFit.attempts, compactApplied: resumeFit.compactApplied,
        revisionApplied: false, error: resumeFit.renderError,
        coverLetterPageCount: coverLetterFit.pageCount, coverLetterPdfProduced: false,
        coverLetterFontsLoaded: coverLetterFit.fontsLoaded, coverLetterPdfError: coverLetterFit.renderError,
      },
      localAi: { jobId, targetMet: false, coverLetterTargetMet, revisionRequested: !revisionExhausted, revisionRound, fitIssues, qualityReview: result.qualityReview, handoffHistory: handoffManifest.handoffHistory },
    });
    return {
      id: jobId, status: revisionExhausted ? 'revision-exhausted' : 'revision-required', company: input.job?.company || '', candidateName: result.coverLetter.name,
      resumeFit: { targetPageCount, pageCount: resumeFit.pageCount, targetMet, compactApplied: resumeFit.compactApplied },
      coverLetterFit: { targetPageCount: 1, pageCount: coverLetterFit.pageCount, targetMet: coverLetterTargetMet },
      fitIssues, fitMessage,
      revisionRound,
      localJob: { id: jobId, status: revisionExhausted ? 'revision-exhausted' : 'revision-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: fitMessage },
    };
  }
  const outputRoot = await materializeTrustedOutputRoot(result.outputBundleRoot, canvas.canvasRoot);
  const outDir = path.join(dir, 'imported-workspace');
  await fs.promises.mkdir(outDir, { recursive: true, mode: 0o700 });
  // Match the established API generation path: print a standalone résumé for
  // Resume.pdf, while Application.html remains the combined editable workspace.
  // Printing the tabbed workspace makes PDF production depend on injected tab
  // controls that are irrelevant to the document itself.
  const applicationHtml = buildResumeDocument({ resumeMainHtml: resumeFit.mainHtml, variantAttrs: resumeFit.variantAttrs, ledger, docId, coverLetter: result.coverLetter, jobContext: { title: input.job?.title || '', company: input.job?.company || '', location: input.job?.location || '' }, downloadBundle: { company: input.job?.company || '', candidateName: result.coverLetter.name, jobMarkdown: formatOriginalJobListingMarkdown(input.job) } });
  let resumePdf = resumeFit.bytes; let coverPdf = coverLetterFit.bytes;
  const missingArtifacts = [];
  if (!resumePdf) {
    missingArtifacts.push('résumé PDF');
    if (resumeFit.renderError) logger.warn(`[LocalAI] Resume PDF unavailable: ${resumeFit.renderError}`);
    else if (resumeFit.fontsLoaded === false) logger.warn('[LocalAI] Resume PDF unavailable: web fonts did not load.');
  }
  if (!coverPdf) {
    missingArtifacts.push('cover-letter PDF');
    if (coverLetterFit.renderError) logger.warn(`[LocalAI] Cover letter PDF unavailable: ${coverLetterFit.renderError}`);
  }
  if (resumeFit.variantAttrs.includes('data-print="dual-pdf"')) {
    if (resumePdf) { try { resumePdf = await applyDualPdf(resumePdf); } catch { /* HTML remains valid */ } }
    if (coverPdf) { try { coverPdf = await applyDualPdf(coverPdf); } catch { /* HTML remains valid */ } }
  }
  const resumeHtmlPath = path.join(outDir, 'Application.html');
  const resumePdfPath = resumePdf ? path.join(outDir, 'Resume.pdf') : null;
  const coverLetterPdfPath = coverPdf ? path.join(outDir, 'Cover Letter.pdf') : null;
  const jobListingPath = path.join(outDir, 'Original Job Listing.md');
  await Promise.all([
    fs.promises.writeFile(resumeHtmlPath, applicationHtml, { encoding: 'utf8', mode: 0o600 }),
    fs.promises.writeFile(jobListingPath, formatOriginalJobListingMarkdown(input.job), { encoding: 'utf8', mode: 0o600 }),
    resumePdfPath ? fs.promises.writeFile(resumePdfPath, resumePdf, { mode: 0o600 }) : Promise.resolve(),
    coverLetterPdfPath ? fs.promises.writeFile(coverLetterPdfPath, coverPdf, { mode: 0o600 }) : Promise.resolve(),
  ]);
  const importedManifest = await appendLocalAiHandoffEvent(dir, manifest, localAiHandoffEvent({
    type: 'result-imported', resultRaw, resumeFit: resumeHandoffFit,
    coverLetterFit: coverLetterHandoffFit, qualityReview: result.qualityReview,
    detail: `Both documents met their measured targets (résumé ${resumeFit.pageCount}/${targetPageCount} pages; cover letter ${coverLetterFit.pageCount}/1 pages).`,
  }));
  recordApplicationTelemetry({
    source: 'local-ai', status: 'completed', phase: 'imported', attemptId: `local-${jobId}`,
    jobTitle: input.job?.title || '', company: input.job?.company || '', jobLocation: input.job?.location || '',
    render: {
      targetPageCount, initialPageCount: resumeFit.attempts[0]?.pageCount ?? null,
      finalPageCount: resumeFit.pageCount, baselinePageCount: resumeFit.pageCount,
      baselinePdfProduced: Boolean(resumePdf), baselineFontsLoaded: resumeFit.fontsLoaded,
      attempts: resumeFit.attempts, compactApplied: resumeFit.compactApplied,
      // No local model call is made during import. A page overflow remains in
      // the job folder for the human-triggered Local AI revision cycle.
      revisionApplied: false,
      error: resumeFit.renderError,
      coverLetterPageCount: coverLetterFit.pageCount, coverLetterPdfProduced: Boolean(coverPdf),
      coverLetterFontsLoaded: coverLetterFit.fontsLoaded, coverLetterPdfError: coverLetterFit.renderError,
    },
    localAi: { jobId, targetMet, coverLetterTargetMet, qualityReview: result.qualityReview, handoffHistory: importedManifest.handoffHistory },
  });
  const workDir = registerPendingApplicationWorkspace({
    workDir: dir, senderId, company: input.job?.company, candidateName: result.coverLetter.name,
    resumeHtmlPath, resumePdfPath, coverLetterPdfPath, jobListingPath,
    attemptId: `local-${jobId}`, applicationRoot: outputRoot.resolved,
    // Keep a partial bundle's source job so the card can repair its missing
    // PDFs. Fully complete bundles use the default cleanup path.
    cleanupOnDiscard: missingArtifacts.length === 0,
  });
  await atomicJson(path.join(dir, 'manifest.json'), { ...importedManifest, status: 'imported', importedAt: new Date().toISOString() });
  return { id: jobId, status: 'imported', workDir, resumeHtmlPath, resumePdfPath, coverLetterPdfPath, jobListingPath, company: input.job?.company || '', candidateName: result.coverLetter.name, missingArtifacts, resumeFit: { targetPageCount, pageCount: resumeFit.pageCount, targetMet, compactApplied: resumeFit.compactApplied }, coverLetterFit: { targetPageCount: 1, pageCount: coverLetterFit.pageCount, targetMet: coverLetterTargetMet }, localJob: { id: jobId, status: 'imported', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath } };
}

export function registerLocalAiApplicationHandlers() {
  handleSafe('queue-local-application', async (_event, args) => ({ localJob: await queueLocalApplicationJob(args) }));
  handleSafe('get-local-application-status', async (_event, { jobId, canvasFilePath } = {}) => ({ localJob: await localApplicationStatus(jobId, canvasFilePath) }));
  handleSafe('open-local-application-folder', async (_event, { jobId, canvasFilePath } = {}) => {
    const { dir } = await assertRealJobDirectory(jobId, canvasFilePath);
    const error = await shell.openPath(dir);
    return { opened: !error, error: error || null };
  });
  handleSafe('import-local-application', async (event, { jobId, canvasFilePath } = {}, signal) => ({ localApplication: await importLocalApplicationJob({ jobId, canvasFilePath, senderId: event.sender.id, signal }) }));
}
