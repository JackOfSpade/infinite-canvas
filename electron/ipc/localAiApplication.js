/**
 * Human-in-the-loop Local AI application jobs.
 *
 * This module deliberately does not launch, scrape, or automate a local AI agent.
 * The app writes a private, app-owned job folder; the user runs the supplied
 * routine in any local coding agent; that agent writes one constrained result.json; then this
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
import { applicationVariantAttrsForJob, assertRetainedResumeRoleBullets, evaluateResumeProseChecks, extractResumeEvidence, normalizeApplicationAdditionalNotes, normalizeCoverLetterParagraphs, recordApplicationTelemetry, registerPendingApplicationWorkspace, resumeIsMateriallyUnderfilled, resumeTypeAreaUtilization, targetPageCountForJob } from './jobApplication.js';
import { applicationConvergenceInstruction, expectedApplicationQualityDecision, isApplicationQualityDecision } from './applicationConvergence.js';
import { authorCoverLetterEnvelope, checkEvidenceGrounding, checkMappingNarrativeStructure, checkRoleThesis, evaluateCoverLetterChecks, formatCoverLetterDate } from './coverLetterChecks.js';
import { atomicWriteJson, ensureDirectoryWithinRoot, isWithinDirectory } from '../utils/pathSafety.js';
import { logger } from '../logger.js';

const { shell } = electronPkg;

export const LOCAL_AI_APPLICATION_VERSION = 1;
const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_CAREER_DATA_CHARS = 240_000;
const MAX_RESUME_HTML_CHARS = 220_000;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_SOURCE_GROUNDING_QUOTE_CHARS = 2_000;
// Allows one-time recovery of pre-ring manifests, after which append trims
// them back to the compact bounded form. This is not a handoff-round limit.
const MAX_LOCAL_AI_MANIFEST_BYTES = 8_000_000;
const LOCAL_AI_STALE_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCAL_AI_FIT_FEEDBACK_FILE = 'fit-feedback.json';
const LOCAL_AI_HANDOFF_RECEIPTS_DIR = 'handoff-receipts';
// Handoff diagnostics must never become an implicit limit on authoring rounds.
// Keep enough recent observations to investigate a live handoff, while the
// monotonic counter preserves the fact that older observations existed.
const MAX_LOCAL_AI_HANDOFF_HISTORY = 32;
const COVER_LETTER_COHESION_REVISION_RULE = 'For the cover letter, preserve one controlling throughline and use minimum-sufficient evidence; the résumé owns breadth. Give every paragraph one argumentative job. Cut or consolidate before introducing another employer, project, or tool merely to cover a different requirement. Each additional proof must have one explicit supporting role in the same argument, with that relationship clear before its details. Within a paragraph, do not place distinct systems or responsibilities side by side merely because they occurred in the same role or job. Before shifting to the new proof, name the shared responsibility, constraint, or outcome; adjacency and “the same job” are not a bridge. If the evidence supplies no relationship, split the paragraph or omit the weaker proof. Never delay the relevance of a background fact. When the thesis names multiple decision branches, make each evidence paragraph identify the branch it develops; do not replace an established branch with a new abstraction at the transition. The last sentence of each non-final paragraph must conclude that paragraph or explicitly name the exact subject carried into the next one; otherwise develop, move, or delete it. On first mention, frame an unfamiliar prior employer with the candidate’s role or relationship, then use the shortest unambiguous reference; frame an unfamiliar named project, product, or system as a concise artifact the candidate built, led, or maintained before relying on its name. Describe cross-domain evidence through the concrete artifact, system, or responsibility, without implying broader domain or operational scope. Exclude application logistics entirely: availability, start date, schedule, location, relocation, commute, travel willingness, citizenship, work authorization, residency, visa, and sponsorship belong in application fields, not a cover letter. Treat an employer, team, product, or operational assertion that comes only from the job listing as the listing’s description rather than independently verified fact; use an unqualified assertion about the employer only when reliable research verifies it, without turning this source framing into repetitive hedging. Refer to the target scope as this role or the work itself; use job-listing attribution only when it establishes the provenance of an unverified employer or company assertion. When source attribution is required, make the source document—not the target position—the grammatical subject of its reporting verb. Refer to the position attached to the application with a proximal determiner unless the sentence explicitly contrasts it with another role. Name actors and referents explicitly wherever pronouns would be ambiguous, and place modifiers beside the actions they govern. Preserve facts while varying distinctive source wording across documents. Use contrast, causal, and connective language only when the necessary premise or sequence is already supported. Prefer ordinary contemporary diction. Honest qualification prevents a misleading claim or answers an explicit application question; it is not permission to volunteer a weakness. Reject unexplained shifts, chronological backtracking without a stated purpose, inventory-style paragraphs, overloaded sentences, repeated organizing metaphors, delayed relevance, detached synthesis, category-restatement bridge sentences that add no decision, mechanism, constraint, or result, and a second thesis. Conclusions and transitions must name the concrete responsibility or mechanism they synthesize and remain within the evidence’s scope. The final paragraph may synthesize established evidence but must not introduce a new decision frame or ask the employer to choose between initiatives. Never add a candidate fact, outcome, scope, tool, sequence, or motivation, and keep general domain principles distinct from personal experience.';
const COVER_LETTER_COPY_PRECISION_RULE = 'Punctuate introductory phrases so the transition into the main subject is immediately clear. Read every sentence once as a recruiter seeing it for the first time; reject idiom, figurative personification, or an implied actor, artifact, or action when the reader must translate it or reconstruct what it literally means. Also scan each clause boundary for an accidental familiar compound or alternate parse: if adjacent words can first read as a different unit, recast the sentence instead of using punctuation to force its intended grammar. In interface or ownership claims, name the concrete actor, artifact, and action instead. Keep communication verbs attached to an actual document or speaker rather than assigning them to the work or position being described. Give each named technology a governing verb that describes its actual role, and never group technologies with distinct roles under one operation. When describing interface guidance, distinguish metaphorical reference from visible on-screen indication and state only the literal limitation. When a closing invites further conversation, use direct present-tense language and connect the candidate’s relevant contribution to the specific target work; do not end solely on what the candidate wants to learn, hear, or discuss, and reject conditional or deferential boilerplate, including would welcome a conversation or discussion.';

export const APPLICATION_QUALITY_CHECKLIST_VERSION = 2;
const LEGACY_APPLICATION_QUALITY_CHECKLIST_VERSION = 1;
const SUPPORTED_APPLICATION_QUALITY_CHECKLIST_VERSIONS = new Set([
  LEGACY_APPLICATION_QUALITY_CHECKLIST_VERSION,
  APPLICATION_QUALITY_CHECKLIST_VERSION,
]);

function expectedApplicationQualityChecklistVersion(inputVersion = null) {
  if (inputVersion == null) return APPLICATION_QUALITY_CHECKLIST_VERSION;
  if (SUPPORTED_APPLICATION_QUALITY_CHECKLIST_VERSIONS.has(inputVersion)) return inputVersion;
  throw new Error(`Local AI job input has an unsupported quality checklist version: ${String(inputVersion)}.`);
}

// Stable writer-facing acceptance contract. Each final handoff must explicitly
// account for every item; the host separately runs every deterministic check
// it can prove. The evidence strings are concise audit notes, never hidden
// reasoning or intermediate drafts.
export const APPLICATION_QUALITY_CRITERIA = Object.freeze([
  { id: 'resume-source-grounding', document: 'resume', requirement: 'Every candidate fact preserves the supplied source, scope, employer, date, and attribution.' },
  { id: 'resume-priority-alignment', document: 'resume', requirement: 'The strongest truthful evidence addresses the job’s highest-priority requirements first.' },
  { id: 'resume-role-completeness', document: 'resume', requirement: 'Every documented role remains present with at least one factual highlight.' },
  { id: 'resume-evidence-quality', document: 'resume', requirement: 'Highlights prefer concrete actions, judgment, outcomes, scale, and differentiators over generic claims.' },
  { id: 'resume-bullet-independence', document: 'resume', requirement: 'Every highlight is understandable by itself and names its concrete referents.' },
  { id: 'resume-concision', document: 'resume', requirement: 'Copy is concise, nonredundant, scannable, and free of raw career-note wording; each bullet has one principal achievement, and trailing implementation detail remains only when it adds a material mechanism, constraint, scope, or result.' },
  { id: 'resume-copy-editing', document: 'resume', requirement: 'Grammar, parallel structure, modifier attachment, compounds, and reference clarity are correct.' },
  { id: 'resume-structure', document: 'resume', requirement: 'Markup uses exactly one bare design-system main and valid peer section and role structures.' },
  { id: 'resume-ats-safety', document: 'resume', requirement: 'The document contains no unsafe, hidden, decorative, or non-parseable content.' },
  { id: 'cover-source-grounding', document: 'coverLetter', requirement: 'Every candidate claim is supported and does not broaden scope, causality, chronology, or attribution.' },
  { id: 'cover-single-argument', document: 'coverLetter', requirement: 'One specific controlling argument organizes the entire letter.' },
  { id: 'cover-minimum-evidence', document: 'coverLetter', requirement: 'Only minimum-sufficient evidence is used; each additional proof has an explicit supporting role.' },
  { id: 'cover-priority-alignment', document: 'coverLetter', requirement: 'The argument connects distinctive candidate evidence to an emphasized employer need.' },
  { id: 'cover-opening', document: 'coverLetter', requirement: 'The first sentence adds substantive information and advances the argument immediately.' },
  { id: 'cover-continuity', document: 'coverLetter', requirement: 'Every paragraph has one argumentative job and advances the same argument with clear transitions and no delayed relevance. Within a paragraph, a shift between distinct systems or responsibilities names its shared responsibility, constraint, or outcome before the new proof; shared role or job context alone is not a bridge. When the thesis names multiple decision branches, each evidence paragraph identifies the branch it develops instead of replacing it with a new abstraction. Each non-final paragraph ends by concluding its point or explicitly carrying the next subject forward, and bridge sentences add a decision, mechanism, constraint, or result rather than restating a category.' },
  { id: 'cover-reference-clarity', document: 'coverLetter', requirement: 'Employers, actors, systems, comparisons, causal links, and temporal references are unambiguous; target scope is stated as this role or the work itself and the selected position is referenced proximally, while listing-only employer context is attributed only when provenance is necessary, with its source document—not the target position—as the reporting subject.' },
  { id: 'cover-register', document: 'coverLetter', requirement: 'Prose is direct and natural, without generic, bureaucratic, additive, advertisement-facing, or conditional/deferential closing language; a final invitation uses direct present tense, and the close synthesizes established evidence, introduces no new frame, never asks the employer to choose between initiatives, and connects the candidate’s contribution to target work.' },
  { id: 'cover-sentence-craft', document: 'coverLetter', requirement: 'Sentences are concise, grammatical, parallel, and punctuated for immediate parsing; they pass a literal first-read and word-boundary parse, use concrete actors, artifacts, and actions where needed, give every named technology a role-accurate governing verb without grouping distinct roles under one operation, and contain no semicolon or dash clause splices.' },
  { id: 'cover-figure-discipline', document: 'coverLetter', requirement: 'Every figure is necessary and appears in the selected résumé evidence.' },
  { id: 'cover-legal-status', document: 'coverLetter', requirement: 'The letter contains no application logistics: availability, start date, schedule, work location, relocation, commute, travel willingness, citizenship, residency, visa, sponsorship, or work-authorization statement.' },
  { id: 'cover-envelope', document: 'coverLetter', requirement: 'The host-owned identity, contact, salutation, and closing are not contradicted or inferred.' },
  { id: 'cross-document-consistency', document: 'bundle', requirement: 'Résumé, cover letter, and argument contract agree on identity, facts, terminology, and scope.' },
  { id: 'requirement-coverage', document: 'bundle', requirement: 'Every high-priority requirement is deliberately addressed or honestly omitted without invention.' },
  { id: 'adversarial-final-review', document: 'bundle', requirement: 'A final adversarial pass found no concrete factual, relevance, clarity, structural, or compliance defect.' },
]);

function cleanText(value, max = 20_000) {
  return Array.from(String(value ?? ''), char => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\t' ? ' ' : char;
  }).join('').replace(/\r\n?/g, '\n').slice(0, max);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Local AI job creation was cancelled.');
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
  // still hand jobs to the source project the local coding agent is scoped to. A copied,
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

// The job folder intentionally holds private career context while a local coding agent
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
  // Local AI polling race after a successful save. Expire them with the
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
    let active = false;
    try {
      const manifest = JSON.parse(await readOwnedFile(realRoot, path.join(dir, 'manifest.json'), { maxBytes: MAX_LOCAL_AI_MANIFEST_BYTES }));
      const parsedCreatedAt = Date.parse(manifest?.createdAt || '');
      if (Number.isFinite(parsedCreatedAt)) createdAt = parsedCreatedAt;
      // A queued job is also the manifest state of every active Local AI
      // revision. Its age says nothing about whether a user has an ongoing
      // high-quality authoring session, so retention must not delete it.
      active = manifest?.version === LOCAL_AI_APPLICATION_VERSION
        && manifest?.id === entry.name
        && ['queued', 'revision-required', 'render-retry-required', 'invalid'].includes(manifest?.status);
    } catch { /* malformed jobs may be pruned once their directory ages out */ }
    if (active) {
      retained += 1;
      continue;
    }
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

// Thin wrapper over the shared atomic-write helper: every call site here
// relies on its target directory already having been created via
// ensureDirectoryWithinRoot, so ensureDir stays off (mode/pretty match this
// module's prior standalone implementation exactly).
async function atomicJson(target, data) {
  await atomicWriteJson(target, data, { mode: 0o600, pretty: true, ensureDir: false });
}

async function ensureProjectRoutine(projectRoot) {
  const realProjectRoot = await fs.promises.realpath(projectRoot);
  const routineDir = await ensureDirectoryWithinRoot(realProjectRoot, path.join(realProjectRoot, 'local_ai'), {
    mode: 0o700,
    label: 'Local AI routine folder',
  });
  const routineTarget = path.join(routineDir, 'LOCAL_AI_APPLICATION_ROUTINE.md');
  const waitHelperTarget = path.join(routineDir, 'wait-for-handoff.mjs');
  const bundledDir = process.resourcesPath ? path.join(process.resourcesPath, 'local_ai') : '';

  const validateExisting = async (target, label) => {
    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a link.`);
      const realTarget = await fs.promises.realpath(target);
      if (!isWithinDirectory(realProjectRoot, realTarget)) throw new Error(`${label} escaped its project folder.`);
      await fs.promises.access(target, fs.constants.R_OK);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const copyBundledIfMissing = async (target, sourceName, label) => {
    if (await validateExisting(target, label)) return;
    const bundled = bundledDir ? path.join(bundledDir, sourceName) : '';
    let bundledStat = null;
    try { bundledStat = bundled ? await fs.promises.lstat(bundled) : null; } catch { /* handled below */ }
    if (!bundledStat?.isFile() || bundledStat.isSymbolicLink()) {
      throw new Error(`${label} is missing. Restore local_ai/${sourceName} in the project.`);
    }
    await fs.promises.copyFile(bundled, target, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(target, 0o600);
  };

  // The editable routine and app-owned wait helper travel together. The helper
  // makes the terminal receipt/folder-cleanup race deterministic for standalone
  // builds where the project initially has no local_ai directory.
  await copyBundledIfMissing(routineTarget, 'LOCAL_AI_APPLICATION_ROUTINE.md', 'Local AI routine');
  await copyBundledIfMissing(waitHelperTarget, 'wait-for-handoff.mjs', 'Local AI handoff wait helper');
  return routineTarget;
}

function promptFor({ jobId, workingFolder, canvasRoot, routinePath }) {
  const inputJobsRoot = localJobsRoot(canvasRoot);
  const outputBundlePath = path.join(canvasRoot, 'Applied Jobs');
  return `Run exactly one actionable Local AI application job from the Infinite Canvas project.

Use any local coding agent with filesystem and shell access. This workflow is provider-neutral; do not switch to a vendor API or require a particular vendor's CLI.

These launch values are authoritative and override placeholders in the routine:

WORKING_FOLDER: ${workingFolder}
ROOT_LOCATION: ${canvasRoot}
ROUTINE_PATH: ${routinePath}
INPUT_JOBS_ROOT: ${inputJobsRoot}
OUTPUT_BUNDLE_ROOT: Applied Jobs
OUTPUT_BUNDLE_PATH: ${outputBundlePath}
JOB_ID: ${jobId}

Start in WORKING_FOLDER, then read and follow the complete routine at ROUTINE_PATH. ROOT_LOCATION is the folder containing the currently saved canvas. Resolve OUTPUT_BUNDLE_ROOT relative to ROOT_LOCATION, so the final hierarchy remains ./Applied Jobs/<Company>/<Location>/<Role>/.

Process only JOB_ID. Do not select a different queued job. If that job is no longer actionable, stop without changing any files.

Keep this same local-agent run active for the complete measured handoff. Handle every matching \`revision-required\`, legacy \`revision-exhausted\`, and \`invalid\` response exactly as prescribed. After every \`result.json\` write, invoke the app-owned handoff helper immediately and continue waiting without a timeout or iteration limit.

Stop only upon a matching terminal receipt, matching \`render-retry-required\` feedback, disappearance of the job folder without a matching receipt, or explicit user interruption. Report acceptance and measured page counts only when supported by the matching terminal receipt.

Write only the selected job's UTF-8 \`result.json\`. Do not modify project source, canvas data, input/context files, feedback, or generated bundles directly. Infinite Canvas owns validation, rendering, and the final save beneath OUTPUT_BUNDLE_PATH.

No response needs to be pasted back into Infinite Canvas. Completion is communicated through the routine's local filesystem handoff.
`;
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
    subtitleRole: authored.subtitleRole,
    credential: authored.credential,
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
    subtitleRole: String(coverLetter.subtitleRole || ''),
    credential: String(coverLetter.credential || ''),
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
  // Legacy handoffs may retain an empty logistics object. Keep that shape
  // compatible, but never let availability/location promises enter letter
  // prose through the non-rendered argument contract.
  if (raw.logistics != null) {
    if (!raw.logistics || typeof raw.logistics !== 'object' || Array.isArray(raw.logistics)) {
      throw new Error('Local AI coverLetterArgument.logistics must be an object when present.');
    }
    const statement = cleanText(raw.logistics.statement, 700).replace(/\s+/g, ' ').trim();
    if (statement) {
      throw new Error('Local AI coverLetterArgument.logistics must be empty: availability, location, relocation, commute, travel, schedule, and legal work status belong in application fields, never the cover letter.');
    }
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

function sanitizeApplicationQualityCriteria(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('Local AI qualityReview.criteria must be the complete application quality checklist.');
  }
  const expected = new Map(APPLICATION_QUALITY_CRITERIA.map(criterion => [criterion.id, criterion]));
  const seen = new Set();
  if (raw.length !== APPLICATION_QUALITY_CRITERIA.length) {
    throw new Error('Local AI qualityReview.criteria must contain the canonical checklist exactly once and in order.');
  }
  const normalizedNotes = new Set();
  const normalizedNoteCores = new Set();
  const sanitized = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Local AI qualityReview.criteria[${index}] must be an object.`);
    }
    const id = cleanText(entry.id, 120).trim();
    const expectedId = APPLICATION_QUALITY_CRITERIA[index]?.id;
    if (id !== expectedId) {
      throw new Error(`Local AI qualityReview.criteria[${index}] must be canonical criterion “${expectedId}” in checklist order.`);
    }
    if (!expected.has(id)) throw new Error(`Local AI qualityReview.criteria contains unknown criterion “${id || '(missing)'}”.`);
    if (seen.has(id)) throw new Error(`Local AI qualityReview.criteria repeats criterion “${id}”.`);
    seen.add(id);
    if (entry.status !== 'pass') {
      throw new Error(`Local AI quality criterion “${id}” did not pass; regenerate the affected draft, rerun the entire checklist, and submit only after every criterion passes.`);
    }
    const evidence = cleanText(entry.evidence, 600).replace(/\s+/g, ' ').trim();
    const noteWords = evidence.match(/[\p{L}\p{N}]+/gu) || [];
    if (evidence.length < 24 || noteWords.length < 5) {
      throw new Error(`Local AI quality criterion “${id}” needs a specific verification note.`);
    }
    const normalizedEvidence = evidence.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (normalizedNotes.has(normalizedEvidence)) {
      throw new Error(`Local AI qualityReview.criteria repeats a verification note at criterion “${id}”.`);
    }
    normalizedNotes.add(normalizedEvidence);
    const criterionWords = id.split('-');
    const noteCore = normalizedEvidence.split(' ').filter(word => !new Set([
      ...criterionWords, 'a', 'an', 'and', 'application', 'applications', 'against', 'all', 'bundle', 'bundles',
      'checked', 'check', 'criterion', 'criteria', 'document', 'documents', 'final', 'for', 'in', 'of', 'on',
      'pass', 'passed', 'review', 'the', 'this', 'verified', 'was', 'with',
    ]).has(word)).join(' ');
    if (noteCore.split(' ').filter(Boolean).length < 3 || normalizedNoteCores.has(noteCore)) {
      throw new Error(`Local AI quality criterion “${id}” uses a repeated or boilerplate verification note.`);
    }
    normalizedNoteCores.add(noteCore);
    return { id, status: 'pass', evidence };
  });
  const missing = [...expected.keys()].filter(id => !seen.has(id));
  if (missing.length) {
    throw new Error(`Local AI qualityReview.criteria is incomplete; missing: ${missing.join(', ')}.`);
  }
  return sanitized;
}

function normalizeSourceGroundingText(value) {
  return cleanText(value, MAX_RESULT_BYTES).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function sourceQuoteIsSpecific(quote) {
  return quote.length >= 12 && (quote.match(/[\p{L}\p{N}]+/gu) || []).length >= 3;
}

const SOURCE_GROUNDING_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on',
  'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'with', 'while', 'within', 'worked', 'work',
  'build', 'built', 'create', 'created', 'design', 'designed', 'develop', 'developed', 'deliver', 'delivered',
  'implement', 'implemented', 'lead', 'led', 'manage', 'managed', 'support', 'supported', 'improve', 'improved',
  'use', 'used', 'using', 'provide', 'provided', 'help', 'helped', 'make', 'made',
]);

const SOURCE_GROUNDING_IDENTITY_STOPWORDS = new Set([
  ...SOURCE_GROUNDING_STOPWORDS,
  'software', 'engineer', 'engineering', 'data', 'developer', 'development', 'project', 'personal',
]);

// These are deliberately high-precision rather than a general semantic
// similarity model. They cover modifiers that materially broaden a career
// claim and therefore need literal support in that unit's bound quotes.
const SOURCE_GROUNDING_QUALIFIER_RULES = Object.freeze([
  { label: 'daily frequency', claim: /\bdaily\b/iu, source: /\b(?:daily|each day|every day|day-to-day)\b/iu },
  { label: 'weekly frequency', claim: /\bweekly\b/iu, source: /\b(?:weekly|each week|every week|week-to-week)\b/iu },
  { label: 'monthly frequency', claim: /\bmonthly\b/iu, source: /\b(?:monthly|each month|every month|month-to-month)\b/iu },
  { label: 'routine frequency', claim: /\b(?:routinely|regularly|repeatedly|consistently)\b/iu, source: /\b(?:routinely|regularly|repeatedly|consistently)\b/iu },
  { label: 'absolute frequency', claim: /\b(?:always|never)\b/iu, source: /\b(?:always|never)\b/iu },
  { label: 'comparative superiority', claim: /\b(?:beat|beats|beating|outperform(?:ed|s|ing)?|superior)\b/iu, source: /\b(?:beat|beats|beating|outperform(?:ed|s|ing)?|superior|better than)\b/iu },
  { label: 'leadership ownership', claim: /\b(?:led|leading)\b/iu, source: /\b(?:led|lead|leading)\b/iu },
  { label: 'direct ownership', claim: /\bown(?:ed|ing)?\b/iu, source: /\b(?:own|owned|owning|ownership|responsible for)\b/iu },
  { label: 'management ownership', claim: /\bmanaged\b/iu, source: /\b(?:managed|managing|responsible for)\b/iu },
  { label: 'decision authority', claim: /\b(?:decided|approved|authorized)\b/iu, source: /\b(?:decided|decision|approved|approval|authorized|authorization|chose|selected|made the call)\b/iu },
  { label: 'production status', claim: /\bproduction(?:-grade)?\b/iu, source: /\bproduction(?:-grade)?\b/iu },
  { label: 'at-scale status', claim: /\bat scale\b/iu, source: /\bat scale\b/iu },
  { label: 'organization-wide scope', claim: /\b(?:district|company|organization|enterprise)-wide\b/iu, source: /\b(?:(?:district|company|organization|enterprise)-wide|(?:entire|whole) (?:district|company|organization|enterprise)|across the (?:district|company|organization|enterprise))\b/iu },
  { label: 'improvement outcome', claim: /\bimprov(?:e|ed|es|ing|ement|ements)\b/iu, source: /\bimprov(?:e|ed|es|ing|ement|ements)\b/iu },
  { label: 'reduction outcome', claim: /\b(?:reduc(?:e|ed|es|ing|tion|tions)|lower(?:ed|ing)?|cut)\b/iu, source: /\b(?:reduc(?:e|ed|es|ing|tion|tions)|lower(?:ed|ing)?|cut)\b/iu },
  { label: 'increase outcome', claim: /\b(?:increas(?:e|ed|es|ing)|grew|raised)\b/iu, source: /\b(?:increas(?:e|ed|es|ing)|grew|raised)\b/iu },
  { label: 'savings outcome', claim: /\b(?:saved|savings)\b/iu, source: /\b(?:saved|savings)\b/iu },
  { label: 'acceleration outcome', claim: /\b(?:accelerat(?:e|ed|es|ing|ion)|faster)\b/iu, source: /\b(?:accelerat(?:e|ed|es|ing|ion)|faster)\b/iu },
  { label: 'optimization outcome', claim: /\boptimiz(?:e|ed|es|ing|ation)\b/iu, source: /\boptimiz(?:e|ed|es|ing|ation)\b/iu },
  { label: 'guaranteed outcome', claim: /\b(?:ensur(?:e|ed|es|ing)|guarantee(?:d|s|ing)?)\b/iu, source: /\b(?:ensur(?:e|ed|es|ing)|guarantee(?:d|s|ing)?)\b/iu },
]);

const CAREER_ASSERTION_ACTION_RE = /\b(?:am|was|were|had|worked|built|created|developed|delivered|implemented|used|applied|evaluated|handled|ran|wrote|designed|maintained|migrated|automated|researched|tested|modified|packaged|containerized|integrated|led|managed|owned|decided|approved|authorized|improved|reduced|increased|saved|accelerated|optimized|ensured)\b/iu;
const CAREER_ASSERTION_REGULAR_PAST_RE = /\b[\p{L}]{5,}(?:ed|ized|ised|ated)\b/iu;

function meaningfulSourceTokens(value) {
  return [...new Set(normalizedTokens(value).filter(token =>
    !SOURCE_GROUNDING_STOPWORDS.has(token) && (token.length > 1 || /\d/u.test(token)),
  ))];
}

function groundingSentences(value) {
  const normalized = normalizeSourceGroundingText(value);
  if (!normalized) return [];
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(normalized)]
      .map(part => normalizeSourceGroundingText(part.segment)).filter(Boolean);
  }
  return normalized.match(/[^.!?]+(?:[.!?]+|$)/gu)?.map(part => part.trim()).filter(Boolean) || [normalized];
}

function careerIdentityTokens(resumeEvidence = {}) {
  return [...new Set((Array.isArray(resumeEvidence.roles) ? resumeEvidence.roles : []).flatMap(role =>
    normalizedTokens(`${role?.title || ''} ${role?.company || ''}`)
      .filter(token => !SOURCE_GROUNDING_IDENTITY_STOPWORDS.has(token) && token.length > 2),
  ))];
}

function isCandidateCareerSentence(sentence, identityTokens = []) {
  const hasCareerAction = CAREER_ASSERTION_ACTION_RE.test(sentence) || CAREER_ASSERTION_REGULAR_PAST_RE.test(sentence);
  if (!hasCareerAction) return false;
  const firstPerson = /\b(?:i|we|my|our)\b/iu.test(sentence);
  if (firstPerson) return true;
  const tokens = new Set(normalizedTokens(sentence));
  return identityTokens.some(token => tokens.has(token));
}

function assertSupportedSourceQualifiers(finalText, sourceQuotes, unit) {
  const sourceText = sourceQuotes.join(' ');
  for (const rule of SOURCE_GROUNDING_QUALIFIER_RULES) {
    const match = finalText.match(rule.claim);
    if (match && !rule.source.test(sourceText)) {
      throw new Error(`${unit} uses unsupported ${rule.label} (\u201c${match[0]}\u201d); its bound career-data quotes must state that qualifier.`);
    }
  }
}

export function assertSourceQuoteLinksFinalText(finalText, sourceQuotes, label, index, { identityTokens = [] } = {}) {
  const finalTokens = meaningfulSourceTokens(finalText);
  const quoteTokens = new Set(meaningfulSourceTokens(sourceQuotes.join(' ')));
  const shared = finalTokens.filter(token => quoteTokens.has(token));
  const minimumShared = finalTokens.length === 1 ? 1 : 2;
  if (!finalTokens.length || shared.length < minimumShared) {
    const unit = label === 'resumeBullets' ? 'résumé bullet' : 'cover-letter paragraph';
    const ordinal = `${unit} ${index + 1}`;
    const detail = shared.length ? `shared meaningful token(s): ${shared.slice(0, 4).join(', ')}` : 'no shared meaningful tokens';
    throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] (${ordinal}) has career-data quotes unrelated to its final ${unit} (${detail}; need ${minimumShared}).`);
  }
  const unit = `${label === 'resumeBullets' ? 'résumé bullet' : 'cover-letter paragraph'} ${index + 1}`;
  if (label === 'resumeBullets') {
    assertSupportedSourceQualifiers(finalText, sourceQuotes, unit);
    return;
  }
  for (const [sentenceIndex, sentence] of groundingSentences(finalText).entries()) {
    if (!isCandidateCareerSentence(sentence, identityTokens)) continue;
    const sentenceTokens = meaningfulSourceTokens(sentence);
    const sentenceShared = sentenceTokens.filter(token => quoteTokens.has(token));
    const sentenceMinimum = sentenceTokens.length === 1 ? 1 : 2;
    if (!sentenceTokens.length || sentenceShared.length < sentenceMinimum) {
      throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] (${unit}, sentence ${sentenceIndex + 1}) is unrelated to its bound career-data quotes.`);
    }
    assertSupportedSourceQualifiers(sentence, sourceQuotes, `${unit}, sentence ${sentenceIndex + 1}`);
  }
}

function resumeBulletsWithRoles(resumeEvidence = {}) {
  return (Array.isArray(resumeEvidence.roles) ? resumeEvidence.roles : []).flatMap(role =>
    (Array.isArray(role?.bullets) ? role.bullets : []).map(bullet => ({
      text: normalizeSourceGroundingText(bullet?.text),
      title: normalizeSourceGroundingText(role?.title),
      company: normalizeSourceGroundingText(role?.company),
    })),
  ).filter(entry => entry.text);
}

function normalizedTokens(value) {
  return normalizeSourceGroundingText(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function tokenCoverage(needle, haystack) {
  const expected = [...new Set(normalizedTokens(needle))];
  if (!expected.length) return 0;
  const available = new Set(normalizedTokens(haystack));
  return expected.filter(token => available.has(token)).length / expected.length;
}

function argumentEvidenceMatchesBullet(evidence, bullet) {
  const candidate = normalizeSourceGroundingText(evidence).toLowerCase();
  const finalText = normalizeSourceGroundingText(bullet).toLowerCase();
  return candidate === finalText || candidate.includes(finalText) || finalText.includes(candidate)
    || (normalizedTokens(candidate).length >= 5 && tokenCoverage(candidate, finalText) >= 0.6);
}

function argumentRoleMatchesResumeRole(evidenceRole, role) {
  const descriptor = normalizeSourceGroundingText(evidenceRole).toLowerCase();
  if (!descriptor || !role?.title) return false;
  if (tokenCoverage(role.title, descriptor) < 0.6) return false;
  // A personal or open-source project can be a valid résumé role without an
  // employer. In that case the project title is the complete role identity;
  // requiring a company forces the writer to invent a label merely to satisfy
  // non-rendered provenance. Employment roles still require the full company.
  return !role.company || tokenCoverage(role.company, descriptor) >= 1;
}

function sanitizeSourceGrounding(raw, { careerData, resumeEvidence, coverLetter, coverLetterArgument }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI qualityReview.sourceGrounding must cover every final résumé bullet and cover-letter paragraph.');
  }
  const trustedSource = normalizeSourceGroundingText(careerData);
  if (!trustedSource) throw new Error('Local AI cannot validate source grounding because trusted career data is empty.');
  const validateEntries = (entries, expectedTexts, label, finalField, quotesField) => {
    if (!Array.isArray(entries) || entries.length !== expectedTexts.length) {
      const unit = label === 'resumeBullets' ? 'résumé bullet' : 'cover-letter paragraph';
      throw new Error(`Local AI qualityReview.sourceGrounding.${label} must bind every final ${unit} exactly once.`);
    }
    return entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] must be an object.`);
      }
      const finalText = normalizeSourceGroundingText(entry[finalField]);
      if (!finalText || finalText !== expectedTexts[index]) {
        throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] must bind the exact normalized final text.`);
      }
      if (!Array.isArray(entry[quotesField]) || !entry[quotesField].length || entry[quotesField].length > 4) {
        throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] needs one to four exact trusted source quotes.`);
      }
      const sourceQuotes = entry[quotesField].map((value, quoteIndex) => {
        const quote = normalizeSourceGroundingText(value);
        if (!sourceQuoteIsSpecific(quote)) {
          throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}].careerDataQuotes[${quoteIndex}] is not specific enough.`);
        }
        if (quote.length > MAX_SOURCE_GROUNDING_QUOTE_CHARS) {
          throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}].careerDataQuotes[${quoteIndex}] exceeds ${MAX_SOURCE_GROUNDING_QUOTE_CHARS} characters; cite the specific supporting passage.`);
        }
        if (!trustedSource.includes(quote)) {
          throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}].careerDataQuotes[${quoteIndex}] is not an exact quote from trusted career data.`);
        }
        return quote;
      });
      if (new Set(sourceQuotes).size !== sourceQuotes.length) {
        throw new Error(`Local AI qualityReview.sourceGrounding.${label}[${index}] repeats a trusted career-data quote.`);
      }
      assertSourceQuoteLinksFinalText(finalText, sourceQuotes, label, index, {
        identityTokens: careerIdentityTokens(resumeEvidence),
      });
      return { [finalField]: finalText, [quotesField]: sourceQuotes };
    });
  };
  const resumeBullets = resumeBulletsWithRoles(resumeEvidence);
  const resumeBulletsGrounding = validateEntries(raw.resumeBullets, resumeBullets.map(item => item.text), 'resumeBullets', 'bullet', 'careerDataQuotes');
  const coverLetterParagraphs = validateEntries(raw.coverLetterParagraphs,
    (Array.isArray(coverLetter?.paragraphs) ? coverLetter.paragraphs : []).map(normalizeSourceGroundingText),
    'coverLetterParagraphs', 'paragraph', 'careerDataQuotes');
  const argumentEntries = [coverLetterArgument?.primaryEvidence, coverLetterArgument?.secondaryEvidence].filter(Boolean);
  for (const [index, argument] of argumentEntries.entries()) {
    const matched = resumeBullets.find(bullet => argumentEvidenceMatchesBullet(argument.evidence, bullet.text));
    if (!matched) {
      throw new Error(`Local AI coverLetterArgument evidence ${index + 1} does not match a final résumé bullet.`);
    }
    if (!argumentRoleMatchesResumeRole(argument.evidenceRole, matched)) {
      const matchedRole = matched.company ? `${matched.title} at ${matched.company}` : matched.title;
      throw new Error(`Local AI coverLetterArgument evidenceRole ${index + 1} must identify the matched résumé role (${matchedRole}).`);
    }
  }
  return { resumeBullets: resumeBulletsGrounding, coverLetterParagraphs };
}

function sanitizeQualityReview(raw = {}, sourceContext = null, expectedChecklistVersion = APPLICATION_QUALITY_CHECKLIST_VERSION) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Local AI result must include qualityReview for both documents.');
  }
  if (raw.checklistVersion !== expectedChecklistVersion) {
    throw new Error(`Local AI qualityReview.checklistVersion must be ${expectedChecklistVersion}.`);
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
  const qualityReview = {
    checklistVersion: expectedChecklistVersion,
    criteria: sanitizeApplicationQualityCriteria(raw.criteria),
    resume: documentReview(raw.resume, 'resume'),
    coverLetter,
  };
  if (sourceContext?.required) {
    qualityReview.sourceGrounding = sanitizeSourceGrounding(raw.sourceGrounding, sourceContext);
  }
  return qualityReview;
}

// Feedback, telemetry, and the bounded manifest ring need revision decisions,
// not a second copy of every provenance quote and checklist note. Keeping this
// representation compact prevents a valid result.json from producing a
// fit-feedback.json too large for the handoff reader's 64 KB safety cap.
function compactLocalAiQualityReview(review = {}) {
  return {
    checklistVersion: SUPPORTED_APPLICATION_QUALITY_CHECKLIST_VERSIONS.has(review?.checklistVersion)
      ? review.checklistVersion
      : null,
    criteria: Array.isArray(review?.criteria) ? review.criteria.slice(0, APPLICATION_QUALITY_CRITERIA.length).map(item => ({
      id: cleanText(item?.id, 120),
      status: item?.status === 'pass' ? 'pass' : 'invalid',
    })) : [],
    resume: {
      decision: cleanText(review?.resume?.decision, 80),
      rationale: cleanText(review?.resume?.rationale, 400),
    },
    coverLetter: {
      decision: cleanText(review?.coverLetter?.decision, 80),
      rationale: cleanText(review?.coverLetter?.rationale, 400),
    },
  };
}

function localCoverLetterPlan(argument) {
  const mappings = [{
    evidence: argument.primaryEvidence.evidence,
    evidenceRole: argument.primaryEvidence.evidenceRole,
    narrativeRole: 'primary',
    relationToPrevious: argument.primaryEvidence.relationToThesis,
  }];
  if (argument.secondaryEvidence) {
    mappings.push({
      evidence: argument.secondaryEvidence.evidence,
      evidenceRole: argument.secondaryEvidence.evidenceRole,
      narrativeRole: argument.secondaryEvidence.narrativeRole,
      relationToPrevious: argument.secondaryEvidence.relationToPrimary,
    });
  }
  return {
    roleThesis: argument.roleThesis,
    mappings,
    companyHook: { detail: '', source: '', whyItMattersToCandidate: '' },
    logistics: argument.logistics?.statement || '',
  };
}

export function validateLocalApplicationResult(raw, jobId, projectRoot, job = {}, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Local AI result must be a JSON object.');
  if (raw.version !== LOCAL_AI_APPLICATION_VERSION || raw.jobId !== jobId || raw.status !== 'completed') {
    throw new Error('Local AI result does not belong to this job or uses an unsupported version.');
  }
  if (typeof raw.outputBundleRoot !== 'string') throw new Error('Local AI result must include outputBundleRoot.');
  const output = resolveLocalOutputBundleRoot(raw.outputBundleRoot, projectRoot);
  const resumeMainHtml = assertRetainedResumeRoleBullets(sanitizeResumeMainHtml(raw.resumeMainHtml));
  const resumeProseFailures = evaluateResumeProseChecks(resumeMainHtml).filter(check => !check.passed);
  if (resumeProseFailures.length) {
    throw new Error(`Local AI résumé failed editorial checks: ${resumeProseFailures.map(check => `${check.id}: ${check.detail}`).join(' | ')}`);
  }
  const resumeEvidence = extractResumeEvidence(resumeMainHtml);
  const coverLetter = authorLocalCoverLetterEnvelope(
    sanitizeCoverLetter(raw.coverLetter),
    resumeMainHtml,
    job,
  );
  const coverLetterArgument = sanitizeCoverLetterArgument(raw.coverLetterArgument);
  const coverPlan = localCoverLetterPlan(coverLetterArgument);
  const hasTrustedCareerData = Object.prototype.hasOwnProperty.call(options || {}, 'careerData');
  const careerData = hasTrustedCareerData ? cleanText(options.careerData, MAX_CAREER_DATA_CHARS) : '';
  const expectedChecklistVersion = expectedApplicationQualityChecklistVersion(options?.qualityChecklistVersion);
  const coverFailures = [
    checkRoleThesis(coverPlan),
    checkMappingNarrativeStructure(coverPlan),
    checkEvidenceGrounding(coverPlan, resumeEvidence),
    ...evaluateCoverLetterChecks({
      plan: coverPlan,
      paragraphs: coverLetter.paragraphs,
      evidence: resumeEvidence,
      jobText: [job?.title, job?.company, job?.location, job?.snippet].filter(Boolean).join('\n'),
      researchText: '',
      companyName: job?.company || '',
    }),
  ].filter(check => !check.passed);
  if (coverFailures.length) {
    throw new Error(`Local AI cover letter failed required checks: ${coverFailures.map(check => `${check.id}: ${check.detail}`).join(' | ')}`);
  }
  assertCandidateDashPunctuation({ resumeMainHtml, coverLetter });
  return {
    resumeMainHtml,
    coverLetter,
    coverLetterArgument,
    qualityReview: sanitizeQualityReview(raw.qualityReview, {
      required: hasTrustedCareerData,
      careerData,
      resumeEvidence,
      coverLetter,
      coverLetterArgument,
    }, expectedChecklistVersion),
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

function finiteMetric(value) {
  return Number.isFinite(value) ? value : null;
}

function safeMeasuredDocumentHashes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resume = typeof value.resume === 'string' && /^[a-f0-9]{64}$/i.test(value.resume) ? value.resume : null;
  const coverLetter = typeof value.coverLetter === 'string' && /^[a-f0-9]{64}$/i.test(value.coverLetter) ? value.coverLetter : null;
  return resume || coverLetter ? { resume, coverLetter } : null;
}

function safeMeasuredLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null;
  return {
    contentHeightPx: finiteMetric(layout.contentHeightPx),
    typeAreaHeightPx: finiteMetric(layout.typeAreaHeightPx),
    utilization: finiteMetric(layout.utilization),
  };
}

// An invalid result has no measurements of its own. Preserve the last app
// measurement inside an explicit snapshot so a validation rejection cannot
// erase the hard-layout invariant for the next submitted bytes.
function measuredFeedbackSnapshot(feedback) {
  const source = ['revision-required', 'revision-exhausted'].includes(feedback?.status)
    ? feedback
    : feedback?.priorMeasured;
  if (!source || !['revision-required', 'revision-exhausted'].includes(source.status)) return null;
  const documentSha256 = safeMeasuredDocumentHashes(source.documentSha256);
  if (!documentSha256) return null;
  return {
    status: source.status,
    documentSha256,
    revisionRound: Number.isSafeInteger(source.revisionRound) && source.revisionRound >= 0 ? source.revisionRound : 0,
    targetPageCount: finiteMetric(source.targetPageCount),
    resume: {
      pageCount: finiteMetric(source?.resume?.pageCount),
      targetPageCount: finiteMetric(source?.resume?.targetPageCount),
      layout: safeMeasuredLayout(source?.resume?.layout),
    },
    coverLetter: {
      pageCount: finiteMetric(source?.coverLetter?.pageCount),
      targetPageCount: finiteMetric(source?.coverLetter?.targetPageCount),
      layout: safeMeasuredLayout(source?.coverLetter?.layout),
    },
  };
}

function assertLocalAiQualityReviewConsistency(result, priorFeedback) {
  const hashes = localAiDocumentHashes(result);
  const measuredPrior = measuredFeedbackSnapshot(priorFeedback);
  const priorHashes = measuredPrior?.documentSha256;
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
  if (measuredPrior) {
    const resumePageCount = Number(measuredPrior?.resume?.pageCount);
    const resumeTarget = Number(measuredPrior?.resume?.targetPageCount ?? measuredPrior?.targetPageCount);
    const resumeStillFails = Number.isFinite(resumePageCount) && Number.isFinite(resumeTarget)
      && (resumePageCount > resumeTarget || resumeIsMateriallyUnderfilled({
        pageCount: resumePageCount,
        targetPageCount: resumeTarget,
        layout: measuredPrior?.resume?.layout || null,
      }));
    const coverPageCount = Number(measuredPrior?.coverLetter?.pageCount);
    const coverTarget = Number(measuredPrior?.coverLetter?.targetPageCount) || 1;
    const coverStillFails = Number.isFinite(coverPageCount) && coverPageCount > coverTarget;
    const unchangedFailures = [
      ...(resumeStillFails && priorHashes?.resume === hashes.resume ? ['résumé'] : []),
      ...(coverStillFails && priorHashes?.coverLetter === hashes.coverLetter ? ['cover letter'] : []),
    ];
    if (unchangedFailures.length) {
      throw new Error(`Local AI must materially regenerate the ${unchangedFailures.join(' and ')} because its prior app-measured layout criterion is still unsatisfied; diminishing returns cannot override a failed hard criterion.`);
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
  const source = await readOwnedFile(root, path.join(root, 'manifest.json'), { maxBytes: MAX_LOCAL_AI_MANIFEST_BYTES });
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
    qualityReview: qualityReview ? compactLocalAiQualityReview(qualityReview) : null,
    detail: detail ? cleanText(detail, 500) : '',
  };
}

async function appendLocalAiHandoffEvent(dir, manifest, event) {
  const prior = Array.isArray(manifest?.handoffHistory) ? manifest.handoffHistory : [];
  const allEvents = [...prior, event]
    .filter(item => item && typeof item === 'object' && !Array.isArray(item));
  const priorEventCount = Number.isSafeInteger(manifest?.handoffEventCount) && manifest.handoffEventCount >= 0
    ? manifest.handoffEventCount
    : prior.length;
  const history = allEvents.slice(-MAX_LOCAL_AI_HANDOFF_HISTORY);
  const nextManifest = {
    ...manifest,
    handoffEventCount: Math.max(priorEventCount + 1, allEvents.length),
    handoffHistory: history,
  };
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
// renderer, but per local_ai/LOCAL_AI_APPLICATION_ROUTINE.md step 7 the waiting local agent
// Code session may read only fit-feedback.json, manifest.json, result.json and
// the handoff receipt — so a rejected result is indistinguishable from an app
// that never ran. The rejection record below gives the same active session a
// bounded, exact repair target while it waits without a production deadline.
//
// This record is deliberately NOT a measurement. The routine acts on
// 'revision-required' (and resumes legacy 'revision-exhausted' records as
// revision-required); 'invalid' plus `measured:
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
    const priorMeasured = measuredFeedbackSnapshot(prior);
    await atomicJson(path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), {
      version: 1,
      jobId,
      status: 'invalid',
      measured: false,
      resultSha256,
      // Untrusted: a validation message can quote model-authored prose (the
      // generic-language check embeds the offending phrase verbatim). Bound and
      // strip it exactly like every other echoed string in this module.
      error: cleanText(error?.message || error, 12_000).replace(/\s+/g, ' ').trim(),
      rejectedAt: new Date().toISOString(),
      // Retain legacy top-level fields for older writer sessions, and preserve
      // the complete trusted measurement in priorMeasured for the host's
      // unchanged-hard-failure check.
      documentSha256: priorMeasured?.documentSha256 || null,
      revisionRound: priorMeasured?.revisionRound || 0,
      priorMeasured,
      message: 'Infinite Canvas rejected this result.json during validation. Nothing was rendered, saved, or measured. Correct the reported problem and overwrite only result.json.',
    });
  } catch (writeError) {
    // The advisory must never turn a clean 'invalid' status into an IPC
    // failure — the renderer's own message stays the authoritative report.
    logger.warn(`[LocalAI] Could not record the result rejection for job ${jobId}: ${writeError?.message || writeError}`);
  }
}

export async function queueLocalApplicationJob(args = {}, signal = null) {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const canvas = await resolveCanvasProject(args.canvasFilePath);
  throwIfAborted(signal);
  // The shared routine is source-project scoped; the per-canvas job data is
  // deliberately NOT. This separation keeps a portable canvas self-contained
  // without creating a second editable routine beside every canvas.
  const routineProjectRoot = localAiProjectRoot(canvas.canonicalCanvasFilePath);
  const routinePath = await ensureProjectRoutine(routineProjectRoot);
  throwIfAborted(signal);
  const realRoot = await ensureDirectoryWithinRoot(canvas.canvasRoot, localJobsRoot(canvas.canvasRoot), {
    mode: 0o700,
    label: 'The canvas .local-ai/jobs folder',
  });
  await pruneAndCountLocalAiJobs(canvas.canvasRoot);
  throwIfAborted(signal);
  const dir = path.join(realRoot, id);
  try {
    await ensureDirectoryWithinRoot(realRoot, dir, { mode: 0o700, label: 'Local AI job folder' });
    throwIfAborted(signal);
    const job = safeJob(args.job);
    const careerData = cleanText(args.careerData, MAX_CAREER_DATA_CHARS);
    if (!sourceQuoteIsSpecific(normalizeSourceGroundingText(careerData))) {
      throw new Error('Local AI needs career data with at least 12 characters and 3 alphanumeric words so every final claim can cite a trusted source quote.');
    }
    const input = {
      version: LOCAL_AI_APPLICATION_VERSION, jobId: id, createdAt: new Date().toISOString(),
      canvasFilePath: canvas.canonicalCanvasFilePath, canvasRoot: canvas.canvasRoot, job,
      additionalNotes: normalizeApplicationAdditionalNotes(args.additionalNotes),
      reasoning: cleanText(args.reasoning, 8_000), matchScore: Number.isFinite(args.matchScore) ? args.matchScore : null,
      achievements: safeJson(args.achievements), mineAllowed: Boolean(args.mineAllowed),
      targetPageCount: Number.isFinite(args.targetPageCount) && args.targetPageCount > 0 ? Math.round(args.targetPageCount) : targetPageCountForJob(job.title),
      qualityChecklist: {
        version: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA,
      },
    };
    const manifest = {
      version: LOCAL_AI_APPLICATION_VERSION, id, status: 'queued', createdAt: input.createdAt,
      canvasFilePath: canvas.canonicalCanvasFilePath, canvasRoot: canvas.canvasRoot,
      files: ['input.json', 'context/job-listing.md', 'context/career-data.txt', 'LOCAL_AI_PROMPT.md', 'result.json'],
    };
    const launchPrompt = promptFor({
      jobId: id,
      workingFolder: routineProjectRoot,
      canvasRoot: canvas.canvasRoot,
      routinePath,
    });
    await ensureDirectoryWithinRoot(dir, path.join(dir, 'context'), { mode: 0o700, label: 'Local AI context folder' });
    await Promise.all([
      atomicJson(path.join(dir, 'input.json'), input), atomicJson(path.join(dir, 'manifest.json'), manifest),
      fs.promises.writeFile(path.join(dir, 'context', 'job-listing.md'), formatOriginalJobListingMarkdown(job), { encoding: 'utf8', mode: 0o600 }),
      fs.promises.writeFile(path.join(dir, 'context', 'career-data.txt'), careerData, { encoding: 'utf8', mode: 0o600 }),
      fs.promises.writeFile(path.join(dir, 'LOCAL_AI_PROMPT.md'), launchPrompt, { encoding: 'utf8', mode: 0o600 }),
    ]);
    throwIfAborted(signal);
    return { id, status: 'queued', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, prompt: launchPrompt, message: 'Local AI job is ready beside this canvas in .local-ai/jobs. Paste LOCAL_AI_PROMPT.md into any local coding agent with filesystem access.' };
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function assertManifestCanvasOwnership(manifest, input, canvas) {
  if (path.resolve(String(manifest?.canvasFilePath || '')) !== canvas.canonicalCanvasFilePath
    || path.resolve(String(input?.canvasFilePath || '')) !== canvas.canonicalCanvasFilePath
    || path.resolve(String(manifest?.canvasRoot || '')) !== canvas.canvasRoot
    || path.resolve(String(input?.canvasRoot || '')) !== canvas.canvasRoot) {
    throw new Error('Local AI job belongs to a different saved canvas.');
  }
}

async function discardLocalAiTerminalReceipt(canvasRoot, jobId) {
  const root = path.resolve(localAiHandoffReceiptsRoot(canvasRoot));
  const receiptPath = path.resolve(root, `${jobId}.json`);
  if (!isWithinDirectory(root, receiptPath) || receiptPath === root) {
    throw new Error('Local AI receipt path escaped its trusted folder.');
  }
  let rootStat;
  try { rootStat = await fs.promises.lstat(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Local AI handoff receipt folder is not trusted.');
  }
  const realRoot = await fs.promises.realpath(root);
  if (realRoot !== root || !isWithinDirectory(canvasRoot, realRoot)) {
    throw new Error('Local AI handoff receipt folder resolved outside the canvas folder.');
  }
  let receiptStat;
  try { receiptStat = await fs.promises.lstat(receiptPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
    throw new Error('Local AI handoff receipt is not a regular file.');
  }
  const realReceipt = await fs.promises.realpath(receiptPath);
  if (!isWithinDirectory(realRoot, realReceipt)) {
    throw new Error('Local AI handoff receipt resolved outside its trusted folder.');
  }
  await fs.promises.unlink(receiptPath);
  return true;
}

// Delete one exact app-authored Local AI job after its owning card was
// deleted. This is deliberately separate from discard-application: the latter
// may only remove a main-process-registered post-import workspace, while this
// capability is restricted to a UUID directory below the canonical canvas.
export async function discardLocalApplicationJob(jobId, canvasFilePath) {
  if (!JOB_ID_RE.test(String(jobId || ''))) throw new Error('Invalid Local AI job id.');
  if (importsInFlight.has(jobId)) {
    const error = new Error('Local AI result import is still running; wait for it to settle before discarding this job.');
    error.code = 'LOCAL_AI_IMPORT_IN_FLIGHT';
    throw error;
  }
  const canvas = await resolveCanvasProject(canvasFilePath);
  let removedJob = false;
  try {
    const { root, dir } = await assertRealJobDirectory(jobId, canvas.canonicalCanvasFilePath);
    const [manifest, inputRaw] = await Promise.all([
      loadManifest(dir),
      readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }),
    ]);
    const input = JSON.parse(inputRaw);
    assertManifestCanvasOwnership(manifest, input, canvas);
    // Revalidate the precise regular directory immediately before mutation.
    const current = await fs.promises.lstat(dir);
    const currentRealPath = await fs.promises.realpath(dir);
    if (!current.isDirectory() || current.isSymbolicLink() || currentRealPath !== dir
      || !isWithinDirectory(root, currentRealPath) || currentRealPath === root) {
      throw new Error('Local AI job directory changed before it could be discarded.');
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    removedJob = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const removedReceipt = await discardLocalAiTerminalReceipt(canvas.canvasRoot, jobId);
  return { discarded: true, removedJob, removedReceipt };
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
  const [inputRaw, careerDataRaw] = await Promise.all([
    readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }),
    readOwnedFile(root, path.join(dir, 'context', 'career-data.txt'), { maxBytes: MAX_RESULT_BYTES }),
  ]);
  const input = JSON.parse(inputRaw);
  const careerData = cleanText(careerDataRaw, MAX_CAREER_DATA_CHARS);
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
  let status = 'queued'; let message = 'Awaiting result.json from Local AI.'; let resultSha256 = null;
  try {
    const rawText = await readOwnedFile(root, path.join(dir, 'result.json'));
    resultSha256 = contentHash(rawText);
    try {
      const raw = JSON.parse(rawText);
      const validated = validateLocalApplicationResult(raw, jobId, canvas.canvasRoot, input.job, {
        careerData,
        qualityChecklistVersion: input?.qualityChecklist?.version,
      });
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
        status = 'revision-required';
        message = String(feedback.message || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine to revise result.json using fit-feedback.json.');
      }
    } catch (error) {
      // HARD rejection: nothing is rendered, saved, or measured, and the error
      // otherwise reaches only the renderer. Record it in the one job-folder
      // file the waiting local coding agent is allowed to read, then rethrow
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
    // The renderer uses this to distinguish a genuinely new Local AI save
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
  const [manifest, inputRaw, careerDataRaw] = await Promise.all([
    loadManifest(dir), readOwnedFile(root, path.join(dir, 'input.json'), { maxBytes: 700_000 }),
    readOwnedFile(root, path.join(dir, 'context', 'career-data.txt'), { maxBytes: MAX_RESULT_BYTES }),
  ]);
  const input = JSON.parse(inputRaw);
  const careerData = cleanText(careerDataRaw, MAX_CAREER_DATA_CHARS);
  if (manifest.id !== jobId || input?.jobId !== jobId || input?.version !== LOCAL_AI_APPLICATION_VERSION) throw new Error('Local AI job input is invalid.');
  assertManifestCanvasOwnership(manifest, input, canvas);
  const expectedChecklistVersion = expectedApplicationQualityChecklistVersion(input?.qualityChecklist?.version);
  // Gate on the manifest BEFORE touching result.json: during the save window
  // the settling verdict must not depend on the result file's presence.
  if (manifestImportFreshlySettling(manifest)) {
    const error = new Error('This result was already imported and its bundle save is finishing. Waiting for it to complete.');
    error.code = 'LOCAL_AI_IMPORT_IN_FLIGHT';
    throw error;
  }
  const resultRaw = await readOwnedFile(root, path.join(dir, 'result.json'));
  if (expectedResultSha256 && contentHash(resultRaw) !== expectedResultSha256) {
    const error = new Error('Local AI saved a newer result while the prior result was settling. Waiting for the final save before import.');
    error.code = 'LOCAL_AI_RESULT_CHANGED';
    throw error;
  }
  let result;
  try {
    result = validateLocalApplicationResult(JSON.parse(resultRaw), jobId, canvas.canvasRoot, input.job, {
      careerData,
      qualityChecklistVersion: expectedChecklistVersion,
    });
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
  // A renderer can retry an IPC request after a slow render, and a local coding agent
  // can leave the card mounted while it is reading the app's feedback. Once a
  // particular result has already produced trusted measured feedback, never
  // render it again: doing so would inflate revision rounds and overwrite the
  // original observation with an identical one. A changed result has a new
  // hash and intentionally continues below for a fresh measurement.
  if (measuredPriorFeedback) {
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
    const fitMessage = priorFeedback.status === 'revision-exhausted'
      ? `${fitIssues.join('; ') || 'A measured layout criterion remains unsatisfied'}. This legacy diminishing-returns result is resumable: make a material correction, rerun the complete checklist, and continue without a fixed revision limit.`
      : String(priorFeedback.message || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine to revise result.json using fit-feedback.json.');
    return {
      id: jobId, status: 'revision-required',
      company: input.job?.company || '', candidateName: result.coverLetter.name,
      resumeFit: { targetPageCount, pageCount: resumePageCount, targetMet, compactApplied: Boolean(priorFeedback?.resume?.attempts?.some(attempt => attempt?.density === 'compact')), layout: resumeLayout, contentUtilization: resumeTypeAreaUtilization(resumeLayout) },
      coverLetterFit: { targetPageCount: 1, pageCount: coverLetterPageCount, targetMet: coverLetterTargetMet, layout: coverLetterLayout, contentUtilization: resumeTypeAreaUtilization(coverLetterLayout) },
      fitIssues, fitMessage, revisionRound: Number.isFinite(priorFeedback.revisionRound) ? priorFeedback.revisionRound : null,
      localJob: { id: jobId, status: 'revision-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: fitMessage },
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
    // Renderer errors can include unbounded engine output. This feedback is
    // read through a 64 KB trusted-file cap by both the app and the waiting
    // handoff helper, so bound it before persistence rather than parking the
    // job behind an unreadable advisory.
    const boundedVerificationIssues = verificationIssues
      .map(issue => cleanText(issue, 2_000).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4);
    const renderMessage = cleanText(`${boundedVerificationIssues.join('; ')}. No final bundle was saved. Retry the measured import when rendering is available; the AI draft does not need another rewrite.`, 10_000)
      .replace(/\s+/g, ' ').trim();
    const priorMeasured = measuredFeedbackSnapshot(priorFeedback);
    // The handoff helper follows hash-bound feedback, not telemetry. Persist a
    // non-measured render-retry record before returning so an indefinite
    // authoring session never waits forever when PDF verification is down.
    await atomicJson(path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), {
      version: 1,
      jobId,
      status: 'render-retry-required',
      measured: false,
      resultSha256: contentHash(resultRaw),
      requestedAt: new Date().toISOString(),
      revisionRound: priorMeasured?.revisionRound || 0,
      documentSha256: priorMeasured?.documentSha256 || null,
      priorMeasured,
      verificationIssues: boundedVerificationIssues,
      message: renderMessage,
      instruction: 'Retry the measured import when rendering is available. Keep result.json unchanged unless a separate quality correction is needed; this record contains no layout measurement.',
    });
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
      localAi: { jobId, verificationIssues: boundedVerificationIssues, qualityReview: compactLocalAiQualityReview(result.qualityReview), handoffHistory: handoffManifest.handoffHistory },
    });
    return {
      id: jobId, status: 'render-retry-required', company: input.job?.company || '', candidateName: result.coverLetter.name,
      renderMessage, verificationIssues: boundedVerificationIssues,
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
    const unchangedUnsatisfiedDocuments = [
      ...(!targetMet && result.qualityReview.resume.decision === 'kept_diminishing_returns' ? ['résumé'] : []),
      ...(!coverLetterTargetMet && result.qualityReview.coverLetter.decision === 'kept_diminishing_returns' ? ['cover letter'] : []),
    ];
    const fitMessage = `${fitIssues.join('; ')}. Continue the Local AI routine with measured revision ${revisionRound} using fit-feedback.json; there is no fixed revision limit.${unchangedUnsatisfiedDocuments.length ? ` The ${unchangedUnsatisfiedDocuments.join(' and ')} cannot remain unchanged while its measured layout criterion is unsatisfied; make a material correction and run the complete quality checklist again.` : ''}`;
    const feedback = {
      version: 1,
      jobId,
      status: 'revision-required',
      revisionRound,
      resultSha256: contentHash(resultRaw),
      documentSha256,
      qualityReview: compactLocalAiQualityReview(result.qualityReview),
      qualityChecklistVersion: expectedChecklistVersion,
      requestedAt: new Date().toISOString(),
      targetPageCount,
      resume: { pageCount: resumeFit.pageCount, targetPageCount, attempts: resumeFit.attempts, layout: resumeFit.layout ? { ...resumeFit.layout, utilization: resumeFit.contentUtilization } : null },
      coverLetter: { pageCount: coverLetterFit.pageCount, targetPageCount: 1, layout: coverLetterFit.layout ? { ...coverLetterFit.layout, utilization: coverLetterFit.contentUtilization } : null },
      instruction: `Before overwriting result.json, compare both documents with the strongest concrete improvement identified by a private quality critique, then rerun every item in the version ${expectedChecklistVersion} quality checklist. Page fit is a hard acceptance criterion, not a quality-completion signal. ${applicationConvergenceInstruction({ revisionAttempt: revisionRound, unchangedSignal: 'keep an already-satisfied document byte-for-byte unchanged and record kept_diminishing_returns with a concrete rationale' })} An unsatisfied document must change materially; a diminishing-returns declaration never overrides a failed hard criterion. For the résumé, preserve direct matches to the job’s highest-priority requirements, concrete outcomes and scale, and credible differentiators. ${resumeUnderfilled ? 'The app measured an underfilled one-page résumé. Reassess omitted, source-supported evidence and add only distinct facts that materially improve this job-specific résumé; do not add generic filler, unsupported detail, or repetition merely to occupy space.' : 'Cut generic, redundant, weakly related, or low-evidence content first.'} ${COVER_LETTER_COHESION_REVISION_RULE} ${COVER_LETTER_COPY_PRECISION_RULE} For a cover letter that already fits, improve it when the comparison finds a material argument or relevance gain; do not rewrite it merely because the résumé overflowed. The cover letter's reported type-area utilization is informational only: a short letter is a supported outcome with no minimum utilization, so never lengthen it to fill its page. Treat only the page counts, render attempts, and type-area utilization in this feedback as app measurements. Do not claim that the app confirmed bullet line counts, page fullness, or the cause of overflow; label markup-based conclusions as your own diagnosis. Do not infer candidate contact details, preserve text merely because it appears earlier, or invent facts. Overwrite only result.json when done.`,
      message: fitMessage,
    };
    await atomicJson(path.join(dir, LOCAL_AI_FIT_FEEDBACK_FILE), feedback);
    const handoffManifest = await appendLocalAiHandoffEvent(dir, manifest, localAiHandoffEvent({
      type: 'fit-revision-requested',
      resultRaw, revisionRound, resumeFit: resumeHandoffFit, coverLetterFit: coverLetterHandoffFit,
      qualityReview: result.qualityReview, detail: fitMessage,
    }));
    recordApplicationTelemetry({
      source: 'local-ai', status: 'revision-required', phase: 'fit revision requested', attemptId: `local-${jobId}`,
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
      localAi: { jobId, targetMet: false, coverLetterTargetMet, revisionRequested: true, revisionRound, fitIssues, qualityReview: compactLocalAiQualityReview(result.qualityReview), handoffHistory: handoffManifest.handoffHistory },
    });
    return {
      id: jobId, status: 'revision-required', company: input.job?.company || '', candidateName: result.coverLetter.name,
      resumeFit: { targetPageCount, pageCount: resumeFit.pageCount, targetMet, compactApplied: resumeFit.compactApplied, layout: resumeFit.layout, contentUtilization: resumeFit.contentUtilization },
      coverLetterFit: { targetPageCount: 1, pageCount: coverLetterFit.pageCount, targetMet: coverLetterTargetMet, layout: coverLetterFit.layout, contentUtilization: coverLetterFit.contentUtilization },
      fitIssues, fitMessage,
      revisionRound,
      localJob: { id: jobId, status: 'revision-required', folder: dir, canvasFilePath: canvas.canonicalCanvasFilePath, message: fitMessage },
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
  const applicationHtml = buildResumeDocument({ resumeMainHtml: resumeFit.mainHtml, variantAttrs: resumeFit.variantAttrs, ledger, docId, coverLetter: result.coverLetter, jobContext: { title: input.job?.title || '', company: input.job?.company || '', location: input.job?.location || '' }, downloadBundle: { company: input.job?.company || '', candidateName: result.coverLetter.name, jobUrl: input.job?.url || '', jobMarkdown: jobListingMarkdown } });
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
    localAi: { jobId, targetMet, coverLetterTargetMet, qualityReview: compactLocalAiQualityReview(result.qualityReview), handoffHistory: importedManifest.handoffHistory },
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

/**
 * Return only Local AI jobs that are demonstrably owned by `canvasFilePath`.
 *
 * A JobCard is renderer state and can be explicitly deleted while the private
 * app-owned handoff folder remains active.  The canvas-level recovery driver
 * uses this enumeration to finish those jobs without resurrecting a deleted
 * card.  Do not trust directory names or a manifest alone: every candidate is
 * a regular directory below the canonical jobs root and must have matching
 * manifest + input ownership before it is returned.
 */
export async function discoverLocalApplicationJobs(canvasFilePath) {
  const canvas = await resolveCanvasProject(canvasFilePath);
  const root = path.resolve(localJobsRoot(canvas.canvasRoot));
  let rootStat;
  try { rootStat = await fs.promises.lstat(root); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('The canvas .local-ai/jobs folder is not a trusted directory.');
  }
  const realRoot = await fs.promises.realpath(root);
  if (realRoot !== root || !isWithinDirectory(canvas.canvasRoot, realRoot)) {
    throw new Error('The canvas .local-ai/jobs folder resolved outside the canvas folder.');
  }

  const entries = await fs.promises.readdir(realRoot, { withFileTypes: true });
  const discovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue;
    const dir = path.join(realRoot, entry.name);
    try {
      const stat = await fs.promises.lstat(dir);
      const realDir = await fs.promises.realpath(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realDir !== dir
        || !isWithinDirectory(realRoot, realDir) || realDir === realRoot) {
        throw new Error('job directory is not a trusted regular directory');
      }
      const [manifest, inputRaw] = await Promise.all([
        loadManifest(dir),
        readOwnedFile(realRoot, path.join(dir, 'input.json'), { maxBytes: 700_000 }),
      ]);
      const input = JSON.parse(inputRaw);
      if (manifest.id !== entry.name || input?.jobId !== entry.name || input?.version !== LOCAL_AI_APPLICATION_VERSION) {
        throw new Error('job manifest and input do not agree');
      }
      assertManifestCanvasOwnership(manifest, input, canvas);
      discovered.push({
        id: entry.name,
        canvasFilePath: canvas.canonicalCanvasFilePath,
        createdAt: manifest.createdAt || null,
        job: safeJob(input.job),
      });
    } catch (error) {
      // A malformed or foreign folder must never gain recovery ownership. It
      // is left untouched for explicit diagnostics/recovery, while healthy
      // app-owned siblings continue to be discoverable.
      logger.warn(`[LocalAI] Ignored untrusted discovered job ${entry.name}: ${error?.message || error}`);
    }
  }
  return discovered.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
}

export function registerLocalAiApplicationHandlers() {
  handleSafe('queue-local-application', async (_event, args, signal) => {
    // queueLocalApplicationJob cooperates at every durable-write boundary.
    // Keep an abort listener through this handler's return as a final guard:
    // handleSafe may observe a node-deletion abort after the job was created
    // but before it is reported to the renderer, in which case no card can
    // own the returned id and the exact private job must be removed here.
    let localJob = null;
    let discardPromise = null;
    const discardQueuedJob = () => {
      if (!localJob) return Promise.resolve();
      if (!discardPromise) {
        discardPromise = discardLocalApplicationJob(localJob.id, localJob.canvasFilePath)
          .catch((error) => logger.warn(`[LocalAI] Could not discard aborted queued job ${localJob.id}: ${error?.message || error}`));
      }
      return discardPromise;
    };
    const onAbort = () => { void discardQueuedJob(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      localJob = await queueLocalApplicationJob(args, signal);
      if (signal?.aborted) {
        await discardQueuedJob();
        throwIfAborted(signal);
      }
      const { prompt, ...durableLocalJob } = localJob;
      return { localJob: durableLocalJob, prompt };
    } catch (error) {
      if (signal?.aborted) await discardQueuedJob();
      throw error;
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
  });
  handleSafe('get-local-application-status', async (_event, { jobId, canvasFilePath } = {}) => ({ localJob: await localApplicationStatus(jobId, canvasFilePath) }));
  handleSafe('discover-local-applications', async (_event, { canvasFilePath } = {}) => ({
    localJobs: await discoverLocalApplicationJobs(canvasFilePath),
  }));
  handleSafe('discard-local-application', async (_event, { jobId, canvasFilePath } = {}) =>
    discardLocalApplicationJob(jobId, canvasFilePath));
  handleSafe('open-local-application-folder', async (_event, { jobId, canvasFilePath } = {}) => {
    const { dir } = await assertRealJobDirectory(jobId, canvasFilePath);
    const error = await shell.openPath(dir);
    return { opened: !error, error: error || null };
  });
  handleSafe('import-local-application', async (event, { jobId, canvasFilePath, expectedResultSha256 } = {}, signal) => ({ localApplication: await importLocalApplicationJob({ jobId, canvasFilePath, expectedResultSha256, senderId: event.sender.id, signal }) }));
}
