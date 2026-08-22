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
import { handleSafe } from './ipcUtils.js';
import { formatOriginalJobListingMarkdown } from './applicationBundle.js';
import { assertCandidateDashPunctuation, buildCoverLetterDocument, buildResumeDocument, neutralizeHighlightTextEmphasis, sanitizeDocumentMainHtml } from './resumeHtml.js';
import { renderPdf, applyDualPdf } from './resumeRender.js';
import { applicationVariantAttrsForJob, assertRetainedResumeRoleBullets, extractResumeEvidence, normalizeApplicationAdditionalNotes, normalizeCoverLetterParagraphs, recordApplicationTelemetry, registerPendingApplicationWorkspace, resumeIsMateriallyUnderfilled, resumeTypeAreaUtilization, targetPageCountForJob } from './jobApplication.js';
import { applicationConvergenceInstruction, expectedApplicationQualityDecision, isApplicationQualityDecision } from './applicationConvergence.js';
import { authorCoverLetterEnvelope, checkGenericPhrases, checkLegalStatus, formatCoverLetterDate } from './coverLetterChecks.js';
import { ensureDirectoryWithinRoot, isWithinDirectory } from '../utils/pathSafety.js';
import { logger } from '../logger.js';

const { shell } = electronPkg;

export const LOCAL_AI_APPLICATION_VERSION = 1;
const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_CAREER_DATA_CHARS = 240_000;
const MAX_RESUME_HTML_CHARS = 220_000;
const MAX_RESULT_BYTES = 1_000_000;
const LOCAL_AI_STALE_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LOCAL_AI_UNFINISHED_JOBS = 20;
const LOCAL_AI_FIT_FEEDBACK_FILE = 'fit-feedback.json';
const LOCAL_AI_HANDOFF_RECEIPTS_DIR = 'handoff-receipts';
const MAX_LOCAL_AI_HANDOFF_EVENTS = 12;
const COVER_LETTER_COHESION_REVISION_RULE = 'For the cover letter, preserve one controlling throughline and use minimum-sufficient evidence; the résumé owns breadth. Cut or consolidate before introducing another employer, project, or tool merely to cover a different requirement. A new evidence block is justified only when it deepens, corroborates, extends, or honestly qualifies that same throughline, with its relationship clear before the details. Never follow a thesis with a standalone background fact whose relevance arrives later. Name an ordinary prior employer once, then use the role, system, project, organization, or “there” when unambiguous. Preserve facts while varying repeated source wording across the résumé and letter; avoid “built from scratch” when a natural supported alternative such as “designed and implemented,” “created,” “developed,” or “delivered” says the same thing. Use temporal contrast words such as “now,” “still,” “again,” “before,” or “after” only when the contrasted state or sequence is already explicit. Prefer common contemporary wording: close or address a gap, never answer a gap. Honest qualification prevents a misleading claim or answers an explicit application question; it is not permission to volunteer a weakness. Otherwise state the strongest supported adjacent experience positively and stop at its evidence boundary. Reject unclear antecedents, unexplained employer or time-period shifts, unjustified chronological backtracking, inventory-style paragraphs, evidence dumps unloaded after a colon, semicolon, or dash, sentences that compress several résumé bullets, repeated organizing metaphors, delayed relevance, and a second thesis. Assert explicit career facts and use narrow evidence-derived connective or causal language when it improves flow; never add a candidate fact, outcome, scope, tool, sequence, or motivation. Keep general domain principles distinct from personal experience; omit or verify plausible-but-unverified steps.';

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

// The private job folder is removed as soon as a completed application is
// saved. Keep this compact, app-authored receipt beside it so the same Claude
// Code session can observe the terminal import and its final measurements.
// It intentionally contains no candidate or document content.
function localAiHandoffReceiptsRoot(canvasRoot) {
  return path.join(canvasRoot, '.local-ai', LOCAL_AI_HANDOFF_RECEIPTS_DIR);
}

async function ensureLocalAiHandoffReceiptsRoot(canvasRoot) {
  const receiptsRoot = localAiHandoffReceiptsRoot(canvasRoot);
  return ensureDirectoryWithinRoot(canvasRoot, receiptsRoot, {
    mode: 0o700,
    label: 'Local AI handoff receipts',
  });
}

async function writeLocalAiTerminalReceipt({ canvasRoot, jobId, resultRaw, resumeFit, coverLetterFit, targetPageCount }) {
  const receiptsRoot = await ensureLocalAiHandoffReceiptsRoot(canvasRoot);
  const receipt = {
    version: 1,
    jobId,
    status: 'imported',
    resultSha256: contentHash(resultRaw),
    importedAt: new Date().toISOString(),
    resume: {
      pageCount: Number.isFinite(resumeFit?.pageCount) ? resumeFit.pageCount : null,
      targetPageCount: Number.isFinite(targetPageCount) ? targetPageCount : null,
      attempts: Array.isArray(resumeFit?.attempts) ? resumeFit.attempts.map(attempt => ({
        density: attempt?.density === 'compact' ? 'compact' : 'default',
        pageCount: Number.isFinite(attempt?.pageCount) ? attempt.pageCount : null,
      })).slice(0, 4) : [],
    },
    coverLetter: {
      pageCount: Number.isFinite(coverLetterFit?.pageCount) ? coverLetterFit.pageCount : null,
      targetPageCount: 1,
    },
    message: `Both documents met their measured targets (résumé ${resumeFit.pageCount}/${targetPageCount} pages; cover letter ${coverLetterFit.pageCount}/1 pages).`,
  };
  await atomicJson(path.join(receiptsRoot, `${jobId}.json`), receipt);
  return receipt;
}

async function readLocalAiTerminalReceipt(canvasRoot, jobId) {
  const receiptsRoot = path.resolve(localAiHandoffReceiptsRoot(canvasRoot));
  try {
    const raw = await readOwnedFile(receiptsRoot, path.join(receiptsRoot, `${jobId}.json`), { maxBytes: 64_000 });
    let receipt;
    try { receipt = JSON.parse(raw); }
    catch { return null; }
    return receipt?.version === 1 && receipt?.jobId === jobId && receipt?.status === 'imported'
      ? receipt
      : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
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
  // Terminal receipts have no candidate content and exist solely to bridge the
  // Claude Code polling race after a successful save. Expire them with the
  // same retention window as abandoned jobs.
  const receiptsRoot = await ensureLocalAiHandoffReceiptsRoot(canvasRoot);
  const receiptEntries = await fs.promises.readdir(receiptsRoot, { withFileTypes: true });
  await Promise.all(receiptEntries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && JOB_ID_RE.test(entry.name.slice(0, -5)))
    .map(async (entry) => {
      const receiptPath = path.join(receiptsRoot, entry.name);
      const stat = await fs.promises.lstat(receiptPath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(receiptPath).catch(() => {});
      }
    }));
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
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  const realOutputRoot = await ensureDirectoryWithinRoot(realProjectRoot, output.resolved, {
    mode: 0o700,
    label: 'Local AI output bundle root',
  });
  if (realOutputRoot === realProjectRoot || !isWithinDirectory(realProjectRoot, realOutputRoot)) {
    throw new Error('Local AI outputBundleRoot resolves outside the canvas folder.');
  }
  return { relative: output.relative, resolved: realOutputRoot };
}

async function readOwnedFile(root, candidate, { maxBytes = MAX_RESULT_BYTES } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!isWithinDirectory(resolvedRoot, resolved)) throw new Error('Local AI result escaped its job folder.');
  const [rootStat, stat] = await Promise.all([
    fs.promises.lstat(resolvedRoot),
    fs.promises.lstat(resolved),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Local AI job root is not trusted.');
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local AI result must be a regular file, not a link.');
  if (stat.size > maxBytes) throw new Error('Local AI result is too large.');
  const [realRoot, realFile] = await Promise.all([
    fs.promises.realpath(resolvedRoot),
    fs.promises.realpath(resolved),
  ]);
  if (realRoot !== resolvedRoot || !isWithinDirectory(realRoot, realFile)) {
    throw new Error('Local AI result resolved outside its trusted job folder.');
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()
      || openedStat.dev !== stat.dev
      || openedStat.ino !== stat.ino) {
      throw new Error('Local AI result changed while it was being validated.');
    }
    if (openedStat.size > maxBytes) throw new Error('Local AI result is too large.');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicJson(target, data) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temp, target);
  } finally {
    await fs.promises.unlink(temp).catch(() => {});
  }
}

async function ensureProjectRoutine(projectRoot) {
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  const routineDir = await ensureDirectoryWithinRoot(realProjectRoot, path.join(realProjectRoot, 'local_ai'), {
    mode: 0o700,
    label: 'Local AI routine folder',
  });
  const target = path.join(routineDir, 'CLAUDE_CODE_ROUTINE.md');
  try {
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Local AI routine must be a regular file, not a link.');
    }
    const realTarget = await fs.promises.realpath(target);
    if (!isWithinDirectory(realProjectRoot, realTarget)) {
      throw new Error('Local AI routine escaped its project folder.');
    }
    await fs.promises.access(target, fs.constants.R_OK);
    return target;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // A standalone packaged app copies its bundled default below.
  }
  const bundled = process.resourcesPath
    ? path.join(process.resourcesPath, 'local_ai', 'CLAUDE_CODE_ROUTINE.md')
    : '';
  let bundledStat = null;
  try { bundledStat = bundled ? await fs.promises.lstat(bundled) : null; } catch { /* handled below */ }
  if (!bundledStat?.isFile() || bundledStat.isSymbolicLink()) {
    throw new Error('Local AI routine is missing. Restore local_ai/CLAUDE_CODE_ROUTINE.md in the project.');
  }
  await fs.promises.copyFile(bundled, target, fs.constants.COPYFILE_EXCL);
  await fs.promises.chmod(target, 0o600);
  return target;
}

function promptFor(jobId) {
  return `# Run Local AI application job ${jobId}\n\nRead and follow the project routine at \`local_ai/CLAUDE_CODE_ROUTINE.md\`. Process only the folder containing this prompt; it is job \`${jobId}\` under the routine's configured \`INPUT_JOBS_ROOT\`. Copy the effective \`OUTPUT_BUNDLE_ROOT\` value exactly into \`result.json.outputBundleRoot\`. Write no other files.\n`;
}

function sanitizeResumeMainHtml(raw) {
  const html = String(raw || '').trim();
  if (!html || html.length > MAX_RESUME_HTML_CHARS) throw new Error('Local AI résumé markup is missing or too large.');
  const sanitized = sanitizeDocumentMainHtml(html, {
    documentKind: 'resume',
    allowHostState: false,
  });
  // Enforce the same uniform-weight bullet contract as API generation at the
  // Local AI import boundary. The shared normalizer only changes <b>/<strong>
  // within .highlights list items and keeps child text and receipt attributes.
  return neutralizeHighlightTextEmphasis(sanitized);
}

function sanitizeCoverLetter(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Local AI coverLetter must be an object.');
  const paragraphs = normalizeCoverLetterParagraphs(raw.paragraphs)
    // MAX_RESULT_BYTES already bounds the complete untrusted payload. Preserve
    // every paragraph and its full text so PDF fit, not importer truncation,
    // is the cover letter's sole length constraint.
    .map(value => cleanText(value, MAX_RESULT_BYTES).trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error('Local AI cover letter needs at least one paragraph.');
  const text = (value, max = 500) => cleanText(value, max).replace(/\s+/g, ' ').trim();
  return {
    name: text(raw.name, 240), contact: (Array.isArray(raw.contact) ? raw.contact : []).map(item => text(item, 300)).filter(Boolean).slice(0, 6),
    salutation: text(raw.salutation), recipient: text(raw.recipient), paragraphs,
    closing: text(raw.closing), signatureTitle: text(raw.signatureTitle),
  };
}

// The model owns the letter's argument, not its envelope.  Deriving the
// letterhead from the accepted résumé and the selected job keeps Local AI on
// the same contract as API generation, and stops a model-supplied company
// name in the addressee row from repeating the salutation.
function authorLocalCoverLetterEnvelope(coverLetter, resumeMainHtml, job = {}) {
  const today = formatCoverLetterDate();
  const authored = authorCoverLetterEnvelope({
    job,
    evidence: extractResumeEvidence(resumeMainHtml),
    today,
  });
  return {
    ...coverLetter,
    name: authored.name || coverLetter.name,
    contact: authored.contact.length ? authored.contact : coverLetter.contact,
    tagline: authored.tagline,
    date: authored.date,
    recipient: authored.recipient,
    salutation: authored.salutation,
    closing: authored.closing,
    signatureTitle: authored.signatureTitle,
  };
}

function localAiCoverLetterTelemetry(coverLetter = {}) {
  return {
    tagline: String(coverLetter.tagline || ''),
    salutation: String(coverLetter.salutation || ''),
    recipient: String(coverLetter.recipient || ''),
    closing: String(coverLetter.closing || ''),
    signatureTitle: String(coverLetter.signatureTitle || ''),
    contact: Array.isArray(coverLetter.contact) ? [...coverLetter.contact] : [],
    paragraphs: Array.isArray(coverLetter.paragraphs) ? [...coverLetter.paragraphs] : [],
  };
}

function cleanArgumentText(value, label, { min = 12, max = 700 } = {}) {
  if (typeof value !== 'string') throw new Error(`Local AI coverLetterArgument.${label} must be text.`);
  const text = cleanText(value, max).replace(/\s+/g, ' ').trim();
  if (text.length < min) throw new Error(`Local AI coverLetterArgument.${label} must be specific.`);
  return text;
}

function sanitizeCoverLetterArgument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI result must include a non-rendered coverLetterArgument object.');
  }
  if (!raw.primaryEvidence || typeof raw.primaryEvidence !== 'object' || Array.isArray(raw.primaryEvidence)) {
    throw new Error('Local AI coverLetterArgument.primaryEvidence is required.');
  }
  const primaryEvidence = {
    evidence: cleanArgumentText(raw.primaryEvidence.evidence, 'primaryEvidence.evidence'),
    evidenceRole: cleanArgumentText(raw.primaryEvidence.evidenceRole, 'primaryEvidence.evidenceRole', { min: 2, max: 240 }),
    relationToThesis: cleanArgumentText(raw.primaryEvidence.relationToThesis, 'primaryEvidence.relationToThesis'),
  };
  let secondaryEvidence = null;
  if (raw.secondaryEvidence != null) {
    if (!raw.secondaryEvidence || typeof raw.secondaryEvidence !== 'object' || Array.isArray(raw.secondaryEvidence)) {
      throw new Error('Local AI coverLetterArgument.secondaryEvidence must be an object when present.');
    }
    const narrativeRole = cleanText(raw.secondaryEvidence.narrativeRole, 80).replace(/\s+/g, ' ').trim();
    if (!['foundation', 'corroborates', 'deepens', 'extends', 'qualifies'].includes(narrativeRole)) {
      throw new Error('Local AI coverLetterArgument.secondaryEvidence.narrativeRole is invalid.');
    }
    secondaryEvidence = {
      evidence: cleanArgumentText(raw.secondaryEvidence.evidence, 'secondaryEvidence.evidence'),
      evidenceRole: cleanArgumentText(raw.secondaryEvidence.evidenceRole, 'secondaryEvidence.evidenceRole', { min: 2, max: 240 }),
      narrativeRole,
      relationToPrimary: cleanArgumentText(raw.secondaryEvidence.relationToPrimary, 'secondaryEvidence.relationToPrimary'),
    };
  }
  return {
    roleThesis: cleanArgumentText(raw.roleThesis, 'roleThesis'),
    primaryEvidence,
    ...(secondaryEvidence ? { secondaryEvidence } : {}),
  };
}

function assertCoverLetterReviewAttestsToArgument(rationale) {
  const hasSingleArgument = /\b(?:one|single)\s+(?:controlling\s+)?(?:argument|throughline)\b|\bcontrolling\s+(?:argument|throughline)\b/i.test(rationale);
  const hasMinimumEvidence = /\bminimum[-\s]sufficient\s+evidence\b|\bminimum\s+evidence\b/i.test(rationale);
  if (!hasSingleArgument || !hasMinimumEvidence) {
    throw new Error('Local AI qualityReview.coverLetter.rationale must attest to one controlling argument and minimum-sufficient evidence.');
  }
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
  const coverLetter = documentReview(raw.coverLetter, 'coverLetter');
  assertCoverLetterReviewAttestsToArgument(coverLetter.rationale);
  return {
    resume: documentReview(raw.resume, 'resume'),
    coverLetter,
  };
}

export function validateLocalApplicationResult(raw, jobId, projectRoot, job = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Local AI result must be a JSON object.');
  if (raw.version !== LOCAL_AI_APPLICATION_VERSION || raw.jobId !== jobId || raw.status !== 'completed') {
    throw new Error('Local AI result does not belong to this job or uses an unsupported version.');
  }
  if (typeof raw.outputBundleRoot !== 'string') throw new Error('Local AI result must include outputBundleRoot.');
  const output = resolveLocalOutputBundleRoot(raw.outputBundleRoot, projectRoot);
  const resumeMainHtml = assertRetainedResumeRoleBullets(sanitizeResumeMainHtml(raw.resumeMainHtml));
  const coverLetter = authorLocalCoverLetterEnvelope(
    sanitizeCoverLetter(raw.coverLetter),
    resumeMainHtml,
    job,
  );
  const coverLetterArgument = sanitizeCoverLetterArgument(raw.coverLetterArgument);
  const proseCheck = checkGenericPhrases(coverLetter.paragraphs);
  if (!proseCheck.passed) {
    throw new Error(`Local AI cover letter failed the generic-language check: ${proseCheck.detail}`);
  }
  // Legal work status is application-form data; a letter stating it is a
  // policy violation, not a style observation, so it rejects the run the same
  // way generic phrases do and the local agent removes it and resubmits.
  const legalStatusCheck = checkLegalStatus(coverLetter.paragraphs);
  if (!legalStatusCheck.passed) {
    throw new Error(`Local AI cover letter failed the legal-status check: ${legalStatusCheck.detail}`);
  }
  assertCandidateDashPunctuation({ resumeMainHtml, coverLetter });
  return {
    resumeMainHtml,
    coverLetter,
    coverLetterArgument,
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
  let layout = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const variantAttrs = density === 'compact'
      ? `${baseVariantAttrs} data-density="compact"`
      : baseVariantAttrs;
    try {
      const rendered = await renderPdf(buildResumeDocument({ resumeMainHtml: mainHtml, variantAttrs, ledger, docId }), { signal });
      pageCount = rendered.pageCount;
      layout = rendered.layout || null;
      fontsLoaded = rendered.fontsLoaded !== false;
      bytes = fontsLoaded ? rendered.bytes : null;
      renderError = null;
      attempts.push({ attempt, density, pageCount, fontsLoaded, layout, contentUtilization: resumeTypeAreaUtilization(layout) });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      bytes = null;
      pageCount = null;
      layout = null;
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
    attempts, compactApplied, layout, contentUtilization: resumeTypeAreaUtilization(layout),
  };
}

async function renderLocalCoverLetter({ letter, variantAttrs, docId, signal }) {
  try {
    const rendered = await renderPdf(buildCoverLetterDocument({ letter, variantAttrs, docId }), { signal });
    const fontsLoaded = rendered.fontsLoaded !== false;
    const pageCount = Number.isFinite(rendered.pageCount) ? rendered.pageCount : null;
    return {
      bytes: fontsLoaded ? rendered.bytes : null,
      pageCount,
      fontsLoaded,
      renderError: fontsLoaded ? null : 'Web fonts were unavailable while rendering the cover-letter PDF.',
      centered: false,
      // The letter prints onto the same `main.page` surface as the résumé, so
      // the renderer's probe reports the letter's OWN type area and the shared
      // ratio helper applies unchanged. Utilization is reported for the letter,
      // never enforced: a short letter is a supported top-aligned outcome.
      layout: rendered.layout || null,
      contentUtilization: resumeTypeAreaUtilization(rendered.layout || null),
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const renderError = error?.message || String(error);
    logger.warn(`[LocalAI] Cover-letter PDF render failed: ${renderError}`);
    return { bytes: null, pageCount: null, fontsLoaded: null, renderError, centered: false, layout: null, contentUtilization: null };
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
      layout: resumeFit.layout ? {
        contentHeightPx: Number.isFinite(resumeFit.layout.contentHeightPx) ? resumeFit.layout.contentHeightPx : null,
        typeAreaHeightPx: Number.isFinite(resumeFit.layout.typeAreaHeightPx) ? resumeFit.layout.typeAreaHeightPx : null,
        utilization: Number.isFinite(resumeFit.contentUtilization) ? resumeFit.contentUtilization : null,
      } : null,
    } : null,
    coverLetter: coverLetterFit ? {
      pageCount: Number.isFinite(coverLetterFit.pageCount) ? coverLetterFit.pageCount : null,
      targetPageCount: Number.isFinite(coverLetterFit.targetPageCount) ? coverLetterFit.targetPageCount : null,
      fontsLoaded: coverLetterFit.fontsLoaded === false ? false : coverLetterFit.fontsLoaded === true ? true : null,
      error: coverLetterFit.renderError ? cleanText(coverLetterFit.renderError, 280) : null,
      layout: coverLetterFit.layout ? {
        contentHeightPx: Number.isFinite(coverLetterFit.layout.contentHeightPx) ? coverLetterFit.layout.contentHeightPx : null,
        typeAreaHeightPx: Number.isFinite(coverLetterFit.layout.typeAreaHeightPx) ? coverLetterFit.layout.typeAreaHeightPx : null,
        utilization: Number.isFinite(coverLetterFit.contentUtilization) ? coverLetterFit.contentUtilization : null,
      } : null,
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

// A HARD validation failure writes nothing at all today: no bundle, no fit
// feedback, no receipt, no manifest event. The error reaches only the
// renderer, but per local_ai/CLAUDE_CODE_ROUTINE.md step 7 the waiting Claude
// Code session may read only fit-feedback.json, manifest.json, result.json and
// the handoff receipt — so a rejected result is indistinguishable from an app
// that never ran, and the session can only burn its 6-minute wait.
//
// This record is deliberately NOT a measurement. The routine acts on
// 'revision-required' and 'revision-exhausted'; 'invalid' plus `measured:
// false` sits outside both, and the record carries no page counts, layout,
// utilization, or revision instruction that could be mistaken for one.
//
// `documentSha256` and `revisionRound` are copied forward from whatever
// feedback this overwrites. The rejected result was never rendered, so the
// last MEASURED document hashes are still the ones a later valid result must
// be compared against; dropping them would make
// assertLocalAiQualityReviewConsistency expect 'drafted' from a session that
// has genuinely revised, and that mismatch would throw forever. Overwriting a
// stale measured record is otherwise safe: the routine trusts feedback only
// while its resultSha256 equals the hash of the CURRENT result.json bytes, and
// those bytes are exactly the rejected ones recorded here.
async function writeLocalAiRejectionFeedback({ root, dir, jobId, resultRaw, error }) {
  try {
    const resultSha256 = contentHash(resultRaw);
    const prior = await readLocalFitFeedback(root, dir);
    // Both drivers poll a job parked on 'invalid' every 2.5s ('invalid' is in
    // neither idle set). Rewriting the identical record each tick would churn
    // the exact file the waiting session is hashing, so re-record only a
    // genuinely different rejection.
    if (prior?.jobId === jobId && prior?.status === 'invalid' && prior?.resultSha256 === resultSha256) return;
    // Never overwrite a measured verdict that still describes the bytes on
    // disk. A transient rejection — a poll catching result.json mid-rewrite,
    // or one unreadable fit-feedback.json — would otherwise replace a live
    // 'revision-required' record with 'invalid', and the job could never
    // recover: the same bytes then fail the quality-review assert forever.
    // The advisory is worth less than the measurement it would destroy.
    if (prior?.jobId === jobId && prior?.resultSha256 === resultSha256
      && ['revision-required', 'revision-exhausted'].includes(prior?.status)) {
      logger.warn(`[LocalAI] Keeping the measured ${prior.status} record for job ${jobId}; not recording a transient rejection over it.`);
      return;
    }
    const priorDocumentSha256 = prior?.documentSha256 && typeof prior.documentSha256 === 'object' && !Array.isArray(prior.documentSha256)
      ? prior.documentSha256
      : null;
    await atomicJson(path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), {
      version: 1,
      jobId,
      status: 'invalid',
      measured: false,
      resultSha256,
      // Untrusted: a validation message can quote model-authored prose (the
      // generic-language check embeds the offending phrase verbatim). Bound and
      // strip it exactly like every other echoed string in this module.
      error: cleanText(error?.message || error, 500).replace(/\s+/g, ' ').trim(),
      rejectedAt: new Date().toISOString(),
      documentSha256: priorDocumentSha256,
      revisionRound: Number.isFinite(prior?.revisionRound) ? prior.revisionRound : 0,
      message: 'Infinite Canvas rejected this result.json during validation. Nothing was rendered, saved, or measured. Correct the reported problem and overwrite only result.json.',
    });
  } catch (writeError) {
    // The advisory must never turn a clean 'invalid' status into an IPC
    // failure — the renderer's own message stays the authoritative report.
    logger.warn(`[LocalAI] Could not record the result rejection for job ${jobId}: ${writeError?.message || writeError}`);
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
  const realRoot = await ensureDirectoryWithinRoot(canvas.canvasRoot, localJobsRoot(canvas.canvasRoot), {
    mode: 0o700,
    label: 'The canvas .local-ai/jobs folder',
  });
  const unfinishedCount = await pruneAndCountLocalAiJobs(canvas.canvasRoot);
  if (unfinishedCount >= MAX_LOCAL_AI_UNFINISHED_JOBS) {
    throw new Error(`This canvas already has ${MAX_LOCAL_AI_UNFINISHED_JOBS} unfinished Local AI jobs. Complete or remove an old .local-ai/jobs folder before generating another.`);
  }
  const dir = path.join(realRoot, id);
  await ensureDirectoryWithinRoot(realRoot, dir, { mode: 0o700, label: 'Local AI job folder' });
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
    await ensureDirectoryWithinRoot(dir, path.join(dir, 'context'), { mode: 0o700, label: 'Local AI context folder' });
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
  // A successful bundle save deliberately removes the private job directory.
  // The renderer can briefly retain a pre-save card snapshot across a reload,
  // so probing that removed directory is an expected terminal condition—not an
  // IPC error. Return a terminal state that stops polling while still making
  // the recovery action clear to the user. Validate the identifier first so a
  // malformed direct IPC call is not mislabeled as a cleaned-up job.
  if (!JOB_ID_RE.test(String(jobId || ''))) throw new Error('Invalid Local AI job id.');
  const requestedCanvas = await resolveCanvasProject(canvasFilePath);
  const { root: requestedRoot } = jobDirectory(jobId, requestedCanvas.canvasRoot);
  // If this canvas has no Local AI root at all, it is not the owner of the
  // requested job. Preserve the ownership rejection instead of confusing a
  // cross-canvas request with the normal post-save cleanup race.
  const jobRootExists = await fs.promises.lstat(requestedRoot)
    .then(stat => stat.isDirectory() && !stat.isSymbolicLink())
    .catch(error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
  let trustedJob;
  try {
    trustedJob = await assertRealJobDirectory(jobId, canvasFilePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const receipt = await readLocalAiTerminalReceipt(requestedCanvas.canvasRoot, jobId);
      if (receipt) {
        return {
          id: jobId,
          status: 'saved',
          folder: null,
          canvasFilePath: requestedCanvas.canonicalCanvasFilePath,
          createdAt: receipt.importedAt || null,
          resultSha256: null,
          message: receipt.message
            ? `The Local AI application bundle was saved successfully. ${String(receipt.message)}`
            : 'The Local AI application bundle was saved successfully.',
          receipt,
        };
      }
    }
    if (error?.code === 'ENOENT' && jobRootExists) {
      return {
        id: jobId,
        status: 'failed',
        folder: null,
        canvasFilePath: typeof canvasFilePath === 'string' ? canvasFilePath : null,
        createdAt: null,
        resultSha256: null,
        message: 'This Local AI job folder is no longer available. It may have been cleaned up after a completed save; generate a new application to start another handoff.',
      };
    }
    throw error;
  }
  const { root, dir, ...canvas } = trustedJob;
  const manifest = await loadManifest(dir);
  const input = JSON.parse(await readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }));
  assertManifestCanvasOwnership(manifest, input, canvas);
  if (manifestImportFreshlySettling(manifest)) {
    return {
      id: jobId, status: 'importing', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath,
      createdAt: manifest.createdAt, resultSha256: null,
      // Attribution-neutral: the stalled save may be THIS caller's own (a
      // card whose save-application step failed) or another driver's active
      // one — the poller cannot tell, so the message must not claim either.
      message: 'Result imported — waiting for the bundle save to settle.',
    };
  }
  let status = 'queued'; let message = 'Awaiting result.json from Claude Code.'; let resultSha256 = null;
  try {
    const rawText = await readOwnedFile(root, path.join(dir, 'result.json'));
    resultSha256 = contentHash(rawText);
    try {
      const raw = JSON.parse(rawText);
      const validated = validateLocalApplicationResult(raw, jobId, canvas.canvasRoot, input.job);
      const feedback = await readLocalFitFeedback(root, dir);
      // Only the two MEASURED verdicts may hold a valid result back. The
      // rejection record shares this file and matches on hash, so the
      // fall-through ternary below must never see it: without this allow-list
      // an 'invalid' record would be reported to the renderer — and, through
      // the card, to the user — as a revision request the app never measured.
      const measuredFeedback = feedback?.jobId === jobId && feedback?.resultSha256 === resultSha256
        && ['revision-required', 'revision-exhausted'].includes(feedback.status);
      if (!measuredFeedback) assertLocalAiQualityReviewConsistency(validated, feedback);
      status = 'completed'; message = 'Validated result.json is ready to import.';
      if (measuredFeedback) {
        status = feedback.status === 'revision-exhausted' ? 'revision-exhausted' : 'revision-required';
        message = String(feedback.message || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine to revise result.json using fit-feedback.json.');
      }
    } catch (error) {
      // HARD rejection: nothing is rendered, saved, or measured, and the error
      // otherwise reaches only the renderer. Record it in the one job-folder
      // file the waiting Claude Code session is allowed to read, then rethrow
      // into the outer catch, which still owns the user-facing status message.
      // Mirror that catch's ENOENT rule so a stray missing-file error can never
      // leave a rejection record on a job still reported as 'queued'.
      if (error?.code !== 'ENOENT') await writeLocalAiRejectionFeedback({ root, dir, jobId, resultRaw: rawText, error });
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') { status = 'invalid'; message = String(error?.message || error); }
  }
  return {
    id: jobId, status, folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath,
    createdAt: manifest.createdAt, message,
    // The renderer uses this to distinguish a genuinely new Claude Code save
    // from another poll of the same valid result before beginning an expensive
    // measured import.
    resultSha256: status === 'completed' ? resultSha256 : null,
  };
}

// A measured import renders PDFs and ends by mutating (or, after the follow-up
// save, deleting) the job directory. Two concurrent imports of the same job —
// e.g. the canvas-level fallback manager and a card that remounted mid-import —
// would double-render and race that cleanup. Serialize per job id: the loser
// gets a typed, retriable rejection and its next poll observes the winner's
// terminal state instead.
const importsInFlight = new Set();

// The in-flight Set only covers the import IPC itself, but the winner's job
// directory stays on disk (manifest status 'imported') until its FOLLOW-UP
// save-application IPC deletes it — a window in which result.json still
// validates and a settled second driver would otherwise re-import in full.
// While the manifest reports a fresh 'imported', status reports the job as
// settling and import refuses to re-enter. The window is time-bounded so a
// crashed save never wedges the job: after it lapses, the still-valid
// result.json imports again normally.
const LOCAL_AI_IMPORTED_SAVE_WINDOW_MS = 90_000;
function manifestImportFreshlySettling(manifest, now = Date.now()) {
  if (manifest?.status !== 'imported') return false;
  const importedAt = Date.parse(manifest?.importedAt || '');
  return Number.isFinite(importedAt) && now - importedAt < LOCAL_AI_IMPORTED_SAVE_WINDOW_MS;
}

export async function importLocalApplicationJob(request) {
  const jobId = String(request?.jobId || '');
  if (importsInFlight.has(jobId)) {
    const error = new Error('A Local AI import for this job is already in progress. Waiting for it to finish.');
    error.code = 'LOCAL_AI_IMPORT_IN_FLIGHT';
    throw error;
  }
  importsInFlight.add(jobId);
  try {
    return await importLocalApplicationJobUnlocked(request);
  } finally {
    importsInFlight.delete(jobId);
  }
}

async function importLocalApplicationJobUnlocked({ jobId, canvasFilePath, senderId, signal, expectedResultSha256 = '' }) {
  const { root, dir, ...canvas } = await assertRealJobDirectory(jobId, canvasFilePath);
  const [manifest, inputRaw] = await Promise.all([
    loadManifest(dir), readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }),
  ]);
  const input = JSON.parse(inputRaw);
  if (manifest.id !== jobId || input?.jobId !== jobId || input?.version !== LOCAL_AI_APPLICATION_VERSION) throw new Error('Local AI job input is invalid.');
  assertManifestCanvasOwnership(manifest, input, canvas);
  // Gate on the manifest BEFORE touching result.json: during the save window
  // the settling verdict must not depend on the result file's presence.
  if (manifestImportFreshlySettling(manifest)) {
    const error = new Error('This result was already imported and its bundle save is finishing. Waiting for it to complete.');
    error.code = 'LOCAL_AI_IMPORT_IN_FLIGHT';
    throw error;
  }
  const resultRaw = await readOwnedFile(root, path.join(dir, 'result.json'));
  if (expectedResultSha256 && contentHash(resultRaw) !== expectedResultSha256) {
    const error = new Error('Claude Code saved a newer result while the prior result was settling. Waiting for the final save before import.');
    error.code = 'LOCAL_AI_RESULT_CHANGED';
    throw error;
  }
  let result;
  try {
    result = validateLocalApplicationResult(JSON.parse(resultRaw), jobId, canvas.canvasRoot, input.job);
  } catch (error) {
    // The poll path normally rejects first — an import only ever begins from
    // status 'completed' — so this covers the narrow race where result.json is
    // rewritten to rejectable bytes that still satisfy expectedResultSha256.
    // Recording here too means no rejection route leaves the job folder silent.
    await writeLocalAiRejectionFeedback({ root, dir, jobId, resultRaw, error });
    throw error;
  }
  const priorFeedback = await readLocalFitFeedback(root, dir);
  const matchingPriorFeedback = priorFeedback?.jobId === jobId && priorFeedback?.resultSha256 === contentHash(resultRaw);
  // Only a MEASURED verdict may stand in for the quality-review check below.
  // fit-feedback.json now has a second writer — writeLocalAiRejectionFeedback —
  // whose 'invalid' record carries, by construction, the hash of the CURRENT
  // result.json. Matching on jobId+hash alone would let that record satisfy
  // `matchingPriorFeedback` and skip assertLocalAiQualityReviewConsistency, so
  // a result the status poll just rejected would import cleanly on a Retry
  // click. Same allow-list the status path uses.
  const measuredPriorFeedback = matchingPriorFeedback
    && ['revision-required', 'revision-exhausted'].includes(priorFeedback?.status);
  // A renderer can retry an IPC request after a slow render, and Claude Code
  // can leave the card mounted while it is reading the app's feedback. Once a
  // particular result has already produced trusted measured feedback, never
  // render it again: doing so would inflate revision rounds and overwrite the
  // original observation with an identical one. A changed result has a new
  // hash and intentionally continues below for a fresh measurement.
  if (measuredPriorFeedback) {
    const revisionExhausted = priorFeedback.status === 'revision-exhausted';
    const targetPageCount = Number.isFinite(priorFeedback.targetPageCount) && priorFeedback.targetPageCount > 0
      ? priorFeedback.targetPageCount
      : (Number.isFinite(input?.targetPageCount) && input.targetPageCount > 0
        ? input.targetPageCount
        : targetPageCountForJob(input.job?.title));
    const resumePageCount = Number.isFinite(priorFeedback?.resume?.pageCount) ? priorFeedback.resume.pageCount : null;
    const coverLetterPageCount = Number.isFinite(priorFeedback?.coverLetter?.pageCount) ? priorFeedback.coverLetter.pageCount : null;
    const resumeLayout = priorFeedback?.resume?.layout || null;
    const coverLetterLayout = priorFeedback?.coverLetter?.layout || null;
    const resumeUnderfilled = resumeIsMateriallyUnderfilled({ pageCount: resumePageCount, targetPageCount, layout: resumeLayout });
    const targetMet = resumePageCount != null && resumePageCount <= targetPageCount && !resumeUnderfilled;
    const coverLetterTargetMet = coverLetterPageCount != null && coverLetterPageCount <= 1;
    const fitIssues = [
      ...(resumePageCount != null && resumePageCount > targetPageCount ? [`résumé is ${resumePageCount} pages (target: ${targetPageCount})`] : []),
      ...(resumeUnderfilled ? [`résumé content spans ${Math.round(resumeTypeAreaUtilization(resumeLayout) * 100)}% of the measured type area (minimum 90%)`] : []),
      ...(!coverLetterTargetMet && coverLetterPageCount != null ? [`cover letter is ${coverLetterPageCount} pages (target: 1)`] : []),
    ];
    const fitMessage = String(priorFeedback.message || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine to revise result.json using fit-feedback.json.');
    return {
      id: jobId, status: revisionExhausted ? 'revision-exhausted' : 'revision-required',
      company: input.job?.company || '', candidateName: result.coverLetter.name,
      resumeFit: { targetPageCount, pageCount: resumePageCount, targetMet, compactApplied: Boolean(priorFeedback?.resume?.attempts?.some(attempt => attempt?.density === 'compact')), layout: resumeLayout, contentUtilization: resumeTypeAreaUtilization(resumeLayout) },
      coverLetterFit: { targetPageCount: 1, pageCount: coverLetterPageCount, targetMet: coverLetterTargetMet, layout: coverLetterLayout, contentUtilization: resumeTypeAreaUtilization(coverLetterLayout) },
      fitIssues, fitMessage, revisionRound: Number.isFinite(priorFeedback.revisionRound) ? priorFeedback.revisionRound : null,
      localJob: { id: jobId, status: revisionExhausted ? 'revision-exhausted' : 'revision-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: fitMessage },
    };
  }
  // measuredPriorFeedback always returns above, so this always runs the assert.
  const documentSha256 = assertLocalAiQualityReviewConsistency(result, priorFeedback);
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
      coverLetter: localAiCoverLetterTelemetry(result.coverLetter),
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
  const pageTargetMet = resumeFit.pageCount != null && resumeFit.pageCount <= targetPageCount;
  const resumeUnderfilled = resumeIsMateriallyUnderfilled({ pageCount: resumeFit.pageCount, targetPageCount, layout: resumeFit.layout });
  const targetMet = pageTargetMet && !resumeUnderfilled;
  const coverLetterTargetMet = coverLetterFit.pageCount != null && coverLetterFit.pageCount <= 1;
  const fitIssues = [
    ...(resumeFit.fontsLoaded !== false && resumeFit.pageCount != null && !pageTargetMet
      ? [`résumé is ${resumeFit.pageCount} pages (target: ${targetPageCount})`] : []),
    ...(resumeFit.fontsLoaded !== false && resumeUnderfilled
      ? [`résumé content spans ${Math.round(resumeFit.contentUtilization * 100)}% of the measured type area (minimum 90%)`] : []),
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
      resume: { pageCount: resumeFit.pageCount, targetPageCount, attempts: resumeFit.attempts, layout: resumeFit.layout ? { ...resumeFit.layout, utilization: resumeFit.contentUtilization } : null },
      coverLetter: { pageCount: coverLetterFit.pageCount, targetPageCount: 1, layout: coverLetterFit.layout ? { ...coverLetterFit.layout, utilization: coverLetterFit.contentUtilization } : null },
      instruction: revisionExhausted
        ? `Stop this measured revision loop. The app verified that the unsatisfied ${diminishingReturnsDocuments.join(' and ')} is byte-for-byte unchanged and its quality review explicitly recorded diminishing returns.`
        : `Before overwriting result.json, compare both documents with the strongest concrete improvement identified by a private quality critique. Page fit is a constraint, not a quality-completion signal. ${applicationConvergenceInstruction({ revisionAttempt: revisionRound, unchangedSignal: 'keep that document byte-for-byte unchanged and record kept_diminishing_returns with a concrete rationale' })} For the résumé, preserve direct matches to the job’s highest-priority requirements, concrete outcomes and scale, and credible differentiators. ${resumeUnderfilled ? 'The app measured an underfilled one-page résumé. Reassess omitted, source-supported evidence and add only distinct facts that materially improve this job-specific résumé; do not add generic filler, unsupported detail, or repetition merely to occupy space.' : 'Cut generic, redundant, weakly related, or low-evidence content first.'} ${COVER_LETTER_COHESION_REVISION_RULE} For a cover letter that already fits, improve it when the comparison finds a material argument or relevance gain; do not rewrite it merely because the résumé overflowed. The cover letter's reported type-area utilization is informational only: a short letter is a supported outcome with no minimum utilization, so never lengthen it to fill its page. Treat only the page counts, render attempts, and type-area utilization in this feedback as app measurements. Do not claim that the app confirmed bullet line counts, page fullness, or the cause of overflow; label markup-based conclusions as your own diagnosis. Do not infer candidate contact details, preserve text merely because it appears earlier, or invent facts. Overwrite only result.json when done.`,
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
      coverLetter: localAiCoverLetterTelemetry(result.coverLetter),
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
      resumeFit: { targetPageCount, pageCount: resumeFit.pageCount, targetMet, compactApplied: resumeFit.compactApplied, layout: resumeFit.layout, contentUtilization: resumeFit.contentUtilization },
      coverLetterFit: { targetPageCount: 1, pageCount: coverLetterFit.pageCount, targetMet: coverLetterTargetMet, layout: coverLetterFit.layout, contentUtilization: coverLetterFit.contentUtilization },
      fitIssues, fitMessage,
      revisionRound,
      localJob: { id: jobId, status: revisionExhausted ? 'revision-exhausted' : 'revision-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: fitMessage },
    };
  }
  const outputRoot = await materializeTrustedOutputRoot(result.outputBundleRoot, canvas.canvasRoot);
  const outDir = await ensureDirectoryWithinRoot(dir, path.join(dir, 'imported-workspace'), {
    mode: 0o700,
    label: 'Local AI imported workspace',
  });
  // Match the established API generation path: print a standalone résumé for
  // Resume.pdf, while Application.html remains the combined editable workspace.
  // Printing the tabbed workspace makes PDF production depend on injected tab
  // controls that are irrelevant to the document itself.
  const jobListingMarkdown = formatOriginalJobListingMarkdown(input.job);
  const applicationHtml = buildResumeDocument({ resumeMainHtml: resumeFit.mainHtml, variantAttrs: resumeFit.variantAttrs, ledger, docId, coverLetter: result.coverLetter, jobContext: { title: input.job?.title || '', company: input.job?.company || '', location: input.job?.location || '' }, downloadBundle: { company: input.job?.company || '', candidateName: result.coverLetter.name, jobMarkdown: jobListingMarkdown } });
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
    fs.promises.writeFile(jobListingPath, jobListingMarkdown, { encoding: 'utf8', mode: 0o600 }),
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
    coverLetter: localAiCoverLetterTelemetry(result.coverLetter),
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
    // A failed destination transaction must never erase the only result/context
    // available for retry, even when both staged PDFs were complete.
    cleanupOnSaveFailure: false,
    onSuccessfulSave: async () => {
      await writeLocalAiTerminalReceipt({
        canvasRoot: canvas.canvasRoot, jobId, resultRaw, resumeFit,
        coverLetterFit, targetPageCount,
      });
    },
    artifactData: {
      resumeHtml: applicationHtml,
      resumePdf,
      coverLetterPdf: coverPdf,
      jobListing: jobListingMarkdown,
    },
  });
  await atomicJson(path.join(dir, 'manifest.json'), { ...importedManifest, status: 'imported', importedAt: new Date().toISOString() });
  // The only success-path log for an import: handleSafe logs failures only, so
  // without this a clean run leaves no import entry in the main-process log a
  // HANDOFF bug report could show.
  logger.info(`[LocalAI] Imported job ${jobId}: résumé ${resumeFit.pageCount}/${targetPageCount} page(s), cover letter ${coverLetterFit.pageCount}/1 — awaiting bundle save`);
  return { id: jobId, status: 'imported', workDir, resumeHtmlPath, resumePdfPath, coverLetterPdfPath, jobListingPath, company: input.job?.company || '', candidateName: result.coverLetter.name, missingArtifacts, resumeFit: { targetPageCount, pageCount: resumeFit.pageCount, targetMet, compactApplied: resumeFit.compactApplied, layout: resumeFit.layout, contentUtilization: resumeFit.contentUtilization }, coverLetterFit: { targetPageCount: 1, pageCount: coverLetterFit.pageCount, targetMet: coverLetterTargetMet }, localJob: { id: jobId, status: 'imported', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath } };
}

export function registerLocalAiApplicationHandlers() {
  handleSafe('queue-local-application', async (_event, args) => ({ localJob: await queueLocalApplicationJob(args) }));
  handleSafe('get-local-application-status', async (_event, { jobId, canvasFilePath } = {}) => ({ localJob: await localApplicationStatus(jobId, canvasFilePath) }));
  handleSafe('open-local-application-folder', async (_event, { jobId, canvasFilePath } = {}) => {
    const { dir } = await assertRealJobDirectory(jobId, canvasFilePath);
    const error = await shell.openPath(dir);
    return { opened: !error, error: error || null };
  });
  handleSafe('import-local-application', async (event, { jobId, canvasFilePath, expectedResultSha256 } = {}, signal) => ({ localApplication: await importLocalApplicationJob({ jobId, canvasFilePath, expectedResultSha256, senderId: event.sender.id, signal }) }));
}
