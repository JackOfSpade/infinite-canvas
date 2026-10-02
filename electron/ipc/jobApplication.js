/**
 * Job-application import and export IPCs.
 *
 * Application authoring is a Local AI handoff. This module owns the
 * shared document helpers plus sender-bound import/export capabilities used
 * after localAiApplication validates an app-owned result. `save-application`
 * writes the resulting bundle beside the saved canvas; it never accepts
 * arbitrary renderer filesystem paths.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import electronPkg from 'electron';
import { PDFDocument } from 'pdf-lib';
import { JSDOM } from 'jsdom';
import { handleSafe } from './ipcUtils.js';
import { embedApplicationSyncConfig, extractVariantAttrs, isDualMode } from './resumeHtml.js';
import { reconcileApplicationHtmlFromPdf } from './applicationPdfReconcile.js';
import { applyDualPdf, pdfHasDualModeBackground, renderPdf } from './resumeRender.js';
import { LEDGER_VERSION, MINING_TARGET } from '../../src/utils/achievementLedger.js';
import { logger } from '../logger.js';
import { sanitizeApplicationBundlePart } from './applicationBundle.js';
import { applicationSyncConfig, applicationSyncStatusSnapshot, registerApplicationSyncWorkspace, withApplicationSyncWorkspaceLock } from './applicationSync.js';
import { replaceApplicationBundleAtomically } from './applicationFileTransaction.js';
import { ensureDirectoryWithinRoot, isWithinDirectory } from '../utils/pathSafety.js';
import { isBackgroundE2E } from '../utils/backgroundE2e.js';
import {
  checkCompoundHyphenation,
  checkModifierAttachment,
  checkParallelStructure,
  checkReferenceClarity,
} from './coverLetterChecks.js';

const { shell } = electronPkg;

// Cover-letter authoring rules deliberately do not live here. This module
// validates and saves an application; the retired API authoring path that
// once consumed opening, parallel-structure, register, cohesion, and diction
// rule constants is gone, and five of them survived it unreferenced, so a
// letter defect could be “fixed” in a string no prompt ever read. The writer
// contract is local_ai/LOCAL_AI_APPLICATION_ROUTINE.md plus
// APPLICATION_QUALITY_CRITERIA and the revision rules in
// localAiApplication.js; enforcement is coverLetterChecks.js.

// Per-card notes are user-authored context for ONE application, not a second
// résumé source or a prompt-control channel. Keep the same cap as the renderer
// at the IPC boundary: a renderer can be stale, modified, or invoked directly.
export function normalizeApplicationAdditionalNotes(value) {
  return Array.from(String(value || ''), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

// A renderer must not be able to substitute arbitrary filesystem paths into
// save-application. Generation registers the exact temp artifacts here; save
// consumes only that record and removes it after a durable bundle/recovery save.
const pendingApplicationArtifacts = new Map();
const applicationWorkspacePruneClaims = new Set();
export const GENERATION_AUDIT_VERSION = 1;
const GENERATION_AUDIT_SCHEMA = 'infinite-canvas-generation-audit';
const GENERATION_AUDIT_TOP_LEVEL_KEYS = new Set([
  'version',
  'schema',
  'jobId',
  'createdAt',
  'scope',
  'job',
  'inputSummary',
  'finalArtifacts',
  'savedArtifacts',
  'writerAudit',
  'coverLetterArgument',
  'writerQualityReview',
  'hostValidation',
  'measuredFit',
  'handoff',
]);
const GENERATION_AUDIT_SHA256_RE = /^[a-f0-9]{64}$/iu;

function applicationArtifactSha256(data) {
  if (data == null) return null;
  return crypto.createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
    .digest('hex');
}

/**
 * Verify that one generated PDF is actually derived from the selected HTML
 * panel and carries the paper treatment declared on the root element. Hashes
 * alone prove identity, not that two independently produced artifacts match.
 */
export async function inspectGeneratedApplicationPdf({ html, pdf, documentKind }) {
  const expectedDualMode = isDualMode(extractVariantAttrs(html));
  const actualDualMode = await pdfHasDualModeBackground(pdf);
  const reconciliation = await reconcileApplicationHtmlFromPdf({
    html,
    pdfBytes: pdf,
    documentKind,
  });
  const textMatches = reconciliation?.success === true && reconciliation?.changed === false;
  const variantMatches = expectedDualMode === actualDualMode;
  return {
    valid: textMatches && variantMatches,
    textMatches,
    variantMatches,
    expectedVariant: expectedDualMode ? 'dual-pdf' : 'ink-only',
    actualVariant: actualDualMode ? 'dual-pdf' : 'ink-only',
    reason: !textMatches
      ? String(reconciliation?.error || reconciliation?.reason || 'PDF text does not match its HTML panel.')
      : (!variantMatches ? 'PDF paper treatment does not match the HTML root variant.' : ''),
  };
}

// A generated-PDF mismatch that a fresh render from the same HTML reproduces
// exactly. Exported so the Local AI job folder's response can say so instead
// of prescribing a retry that is already known to reach the same answer.
export const APPLICATION_PDF_MISMATCH_IS_DETERMINISTIC = 'APPLICATION_PDF_MISMATCH_IS_DETERMINISTIC';

async function ensureGeneratedApplicationPdf({ html, pdf, documentKind }) {
  if (pdf == null) return null;
  const inspection = await inspectGeneratedApplicationPdf({ html, pdf, documentKind });
  if (inspection.valid) return pdf;
  logger.warn(`[JobApplication] Regenerating mismatched ${documentKind} PDF before export: ${inspection.reason}`);
  const rendered = await renderPdf(html, { document: documentKind });
  if (rendered.fontsLoaded === false) {
    // Name the faces the predicate rejected rather than diagnosing a cause the
    // app never observed — the same correction made in resumeRender.js and
    // applicationSync.js.
    const faces = (Array.isArray(rendered.missingFontFaces) ? rendered.missingFontFaces : []).filter(Boolean);
    throw new Error(
      `The render window could not resolve the ${documentKind === 'cover' ? 'cover-letter' : 'résumé'} fonts`
      + `${faces.length ? ` (${faces.join(', ')})` : ''} while repairing an inconsistent generated PDF.`,
    );
  }
  let repaired = rendered.bytes;
  if (isDualMode(extractVariantAttrs(html))) repaired = await applyDualPdf(repaired);
  const repairedInspection = await inspectGeneratedApplicationPdf({ html, pdf: repaired, documentKind });
  if (!repairedInspection.valid) {
    // A PDF rendered fresh from this exact HTML, rejected for the exact same
    // reason as the one it replaced, did not fail because of its bytes — so
    // pressing the card's retry runs this same comparison to this same
    // answer. Say that here: the card's standing guidance is to retry the
    // app-side save, and on 2026-09-23 that cost three identical attempts
    // against a deterministic mismatch.
    const unchangedByRerender = repairedInspection.reason === inspection.reason;
    const error = new Error(`Could not produce a ${documentKind} PDF consistent with Application.html: ${repairedInspection.reason}`
      + (unchangedByRerender
        ? ' A freshly rendered PDF was rejected for the same reason, so retrying this save reproduces it.'
        : ''));
    // Carry that verdict as a code, not only as a sentence. Everything
    // downstream — the IPC envelope, the card, and the hash-bound response
    // written back into the job folder — otherwise has to re-derive it by
    // matching on this message, and the one that mattered went on telling the
    // candidate to retry while the message beside it said a retry reproduces.
    if (unchangedByRerender) error.code = APPLICATION_PDF_MISMATCH_IS_DETERMINISTIC;
    throw error;
  }
  return Buffer.from(repaired);
}

/**
 * Remove destination directories this attempt created but never populated.
 *
 * The `Company/Location/Role` tree is created before the generated artifacts
 * are read and validated, so a save that fails after that point leaves an
 * empty folder in "Applied Jobs" that reads exactly like an application the
 * candidate already sent — the folder tree IS the durable record of what was
 * applied to. Only an empty directory is removed, and only below the
 * registered output root, so a real bundle, a previous generation being
 * replaced, or any folder the user put something in is never touched.
 */
async function pruneEmptyExportDirectories(outputRoot, exportDir) {
  if (typeof outputRoot !== 'string' || !outputRoot || typeof exportDir !== 'string' || !exportDir) return;
  const root = path.resolve(outputRoot);
  let current = path.resolve(exportDir);
  while (current !== root && isWithinDirectory(root, current)) {
    try {
      if ((await fs.promises.readdir(current)).length) return;
      await fs.promises.rmdir(current);
    } catch (error) {
      // Best-effort: ENOENT is nothing to prune, and anything else (a
      // concurrent writer winning the directory, a permission change) means
      // this cleanup stops rather than competing with it.
      if (error?.code !== 'ENOENT') return;
    }
    current = path.dirname(current);
  }
}

// Test seam: exercises the exact best-effort cleanup save-application uses
// for a resolveApplicationExportDirectory candidate it did not end up
// choosing, without registering a real pending workspace or driving a full
// save through the IPC handler.
export function __pruneEmptyExportDirectoriesForTests(outputRoot, exportDir) {
  return pruneEmptyExportDirectories(outputRoot, exportDir);
}

/**
 * Register an already-built, app-owned application workspace for the normal
 * save-application IPC. Local-AI imports use this after *this process* has
 * validated the model result and built its HTML/PDF files. The renderer never
 * gets to register paths itself.
 *
 * Local AI registers its complete job folder as this workspace. Once the
 * final bundle has been durably promoted, normal cleanup removes that private
 * intermediate context; an import/save failure leaves its on-disk job intact
 * and retryable because no discard occurs on the failed save path.
 */
export function registerPendingApplicationWorkspace({
  workDir, senderId, company = '', candidateName = '', resumeHtmlPath,
  resumePdfPath = null, coverLetterPdfPath = null, jobListingPath,
  generationAuditPath = null, generationAuditJobId = null, generationAuditRequired = null,
  generationLogPath = null,
  attemptId = null, cleanupOnDiscard = true, applicationRoot = null,
  artifactData = {}, cleanupOnSaveFailure = true, onBeforeSave = null, onBeforeDiscard = null,
  onSuccessfulSave = null, onBeforeSuccessfulCleanup = null, onSaveFailure = null,
} = {}) {
  if (typeof workDir !== 'string' || !workDir.trim()
    || typeof resumeHtmlPath !== 'string' || !resumeHtmlPath.trim()
    || typeof jobListingPath !== 'string' || !jobListingPath.trim()
    || !Number.isInteger(senderId)) {
    throw new Error('Cannot register an incomplete application workspace.');
  }
  const resolvedWorkDir = path.resolve(String(workDir || ''));
  const required = [resumeHtmlPath, jobListingPath].map(value => path.resolve(String(value || '')));
  const optional = [resumePdfPath, coverLetterPdfPath, generationAuditPath, generationLogPath]
    .map(value => value ? path.resolve(String(value)) : null);
  const paths = [...required, ...optional.filter(Boolean)];
  if (paths.some(value => !isWithinDirectory(resolvedWorkDir, value))) {
    throw new Error('Application artifact escaped its registered workspace.');
  }
  const workspaceStat = fs.lstatSync(resolvedWorkDir);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error('Application workspace must be a regular app-owned directory.');
  }
  const workspaceIdentity = {
    realPath: fs.realpathSync(resolvedWorkDir),
    dev: workspaceStat.dev,
    ino: workspaceStat.ino,
  };
  const artifactSha256 = {
    resumeHtml: applicationArtifactSha256(artifactData.resumeHtml),
    resumePdf: applicationArtifactSha256(artifactData.resumePdf),
    coverLetterPdf: applicationArtifactSha256(artifactData.coverLetterPdf),
    jobListing: applicationArtifactSha256(artifactData.jobListing),
    generationAudit: applicationArtifactSha256(artifactData.generationAudit),
    generationLog: applicationArtifactSha256(artifactData.generationLog),
  };
  if (!artifactSha256.resumeHtml || !artifactSha256.jobListing
    || (optional[0] && !artifactSha256.resumePdf)
    || (optional[1] && !artifactSha256.coverLetterPdf)
    || (optional[2] && !artifactSha256.generationAudit)
    || (optional[3] && !artifactSha256.generationLog)) {
    throw new Error('Cannot register application artifacts without trusted source fingerprints.');
  }
  const expectedGenerationAuditJobId = String(generationAuditJobId || '').trim();
  if (optional[2]) {
    if (!expectedGenerationAuditJobId || expectedGenerationAuditJobId.length > 80) {
      throw new Error('Cannot register Generation Audit.json without its app-owned job id.');
    }
    if (typeof generationAuditRequired !== 'boolean') {
      throw new Error('Cannot register Generation Audit.json without its app-owned requiredness marker.');
    }
    assertGenerationAuditData(artifactData.generationAudit, {
      expectedJobId: expectedGenerationAuditJobId,
      expectedGenerationAuditRequired: generationAuditRequired,
      expectedStagedArtifacts: {
        applicationHtml: artifactData.resumeHtml,
        resumePdf: artifactData.resumePdf,
        coverLetterPdf: artifactData.coverLetterPdf,
        jobListing: artifactData.jobListing,
      },
    });
  }
  // The same Local-AI directory can be offered again after the imported-save
  // recovery window. Never let that recovery registration replace a save that
  // is still actively consuming the existing capability: doing so would let
  // both handlers promote the same bundle and race each other's callbacks.
  const existing = pendingApplicationArtifacts.get(resolvedWorkDir);
  if (existing?.saveInFlight) {
    const error = new Error('This generated application workspace is already being saved.');
    error.code = 'APPLICATION_SAVE_IN_FLIGHT';
    throw error;
  }
  if (applicationWorkspacePruneClaims.has(resolvedWorkDir)) {
    const error = new Error('This generated application workspace is being retired; retry the import from its current job state.');
    error.code = 'APPLICATION_WORKSPACE_PRUNING';
    throw error;
  }
  pendingApplicationArtifacts.set(resolvedWorkDir, {
    attemptId, senderId, company: String(company || ''), candidateName: String(candidateName || ''),
    resumeHtmlPath: required[0], resumePdfPath: optional[0], coverLetterPdfPath: optional[1],
    generationAuditPath: optional[2],
    generationLogPath: optional[3],
    generationAuditJobId: optional[2] ? expectedGenerationAuditJobId : null,
    generationAuditRequired: optional[2] ? generationAuditRequired : null,
    jobListingPath: required[1], cleanupOnDiscard: cleanupOnDiscard !== false,
    cleanupOnSaveFailure: cleanupOnSaveFailure !== false,
    onBeforeSave: typeof onBeforeSave === 'function' ? onBeforeSave : null,
    onBeforeDiscard: typeof onBeforeDiscard === 'function' ? onBeforeDiscard : null,
    onSuccessfulSave: typeof onSuccessfulSave === 'function' ? onSuccessfulSave : null,
    onBeforeSuccessfulCleanup: typeof onBeforeSuccessfulCleanup === 'function'
      ? onBeforeSuccessfulCleanup
      : null,
    onSaveFailure: typeof onSaveFailure === 'function' ? onSaveFailure : null,
    saveInFlight: false,
    workspaceIdentity,
    artifactSha256,
    // Only trusted main-process generation/import code can register this
    // override. The renderer never supplies an output root to save-application.
    applicationRoot: applicationRoot ? path.resolve(String(applicationRoot)) : null,
  });
  return resolvedWorkDir;
}

// Resolve a generated workspace only when the caller names an exact record
// owned by its sender. Exported to keep the capability boundary directly
// testable without exposing the production Map itself.
export function resolvePendingApplicationWorkspaceForOwner(workDir, pendingArtifacts, senderId) {
  const resolvedWorkDir = typeof workDir === 'string' ? path.resolve(workDir) : '';
  const pending = pendingArtifacts.get(resolvedWorkDir);
  if (!pending) {
    throw new Error('Generated application session is no longer available — please regenerate.');
  }
  if (pending.senderId !== senderId) {
    throw new Error('Generated application session belongs to a different window — please regenerate.');
  }
  return { resolvedWorkDir, pending };
}

// Main-process lifecycle query only: Local AI uses this exact workspace flag
// to distinguish a genuinely long save from a crashed renderer after the
// manifest's ordinary recovery window expires. Never expose the capability
// record or use filesystem existence as a substitute for this in-memory claim.
export function isPendingApplicationWorkspaceSaveInFlight(workDir) {
  if (typeof workDir !== 'string' || !workDir.trim()) return false;
  return pendingApplicationArtifacts.get(path.resolve(workDir))?.saveInFlight === true;
}

/**
 * Serialize retention deletion against synchronous capability registration.
 * If registration wins first, pruning declines. If pruning wins first, a
 * concurrent registration receives a typed retry instead of creating a save
 * capability for a directory already being removed.
 */
export async function withUnregisteredApplicationWorkspacePruneClaim(workDir, operation) {
  if (typeof workDir !== 'string' || !workDir.trim() || typeof operation !== 'function') return false;
  const resolvedWorkDir = path.resolve(workDir);
  if (pendingApplicationArtifacts.has(resolvedWorkDir)
    || applicationWorkspacePruneClaims.has(resolvedWorkDir)) return false;
  applicationWorkspacePruneClaims.add(resolvedWorkDir);
  try {
    // No await occurs between the first Map check and claiming the path, but
    // keep the second check as the invariant if this helper is later refactored.
    if (pendingApplicationArtifacts.has(resolvedWorkDir)) return false;
    await operation(resolvedWorkDir);
    return true;
  } finally {
    applicationWorkspacePruneClaims.delete(resolvedWorkDir);
  }
}

// Remove only a workspace that this process previously registered.  The
// renderer never gets arbitrary temp-directory deletion: callers must first
// prove ownership with the exact Map entry (and, at the IPC boundary, sender
// identity) before this helper is reached.
function restoreRelocatedApplicationWorkspace(cleanupWorkDir, resolvedWorkDir, pending) {
  if (cleanupWorkDir === resolvedWorkDir) return { restored: false, error: null };
  try {
    try {
      fs.lstatSync(resolvedWorkDir);
      throw new Error('The original application workspace path was recreated before cleanup recovery.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const current = fs.lstatSync(cleanupWorkDir);
    const currentRealPath = fs.realpathSync(cleanupWorkDir);
    const expected = pending.workspaceIdentity;
    if (!current.isDirectory() || current.isSymbolicLink()
      || currentRealPath !== cleanupWorkDir
      || (expected && (current.dev !== expected.dev || current.ino !== expected.ino))) {
      throw new Error('The relocated application workspace changed before cleanup recovery.');
    }
    // Both paths have the same parent, and the absence check immediately above
    // keeps this recovery from intentionally replacing another workspace.
    fs.renameSync(cleanupWorkDir, resolvedWorkDir);
    const restored = fs.lstatSync(resolvedWorkDir);
    if (!restored.isDirectory() || restored.isSymbolicLink()
      || (expected && (restored.dev !== expected.dev || restored.ino !== expected.ino))) {
      throw new Error('The restored application workspace did not retain its registered identity.');
    }
    return { restored: true, error: null };
  } catch (error) {
    return { restored: false, error };
  }
}

async function discardPendingApplicationArtifacts(resolvedWorkDir, pending, reason = 'discarded') {
  if (pendingApplicationArtifacts.get(resolvedWorkDir) !== pending) return false;
  let cleanupWorkDir = resolvedWorkDir;
  const shouldDeleteWorkspace = pending.cleanupOnDiscard !== false;
  const cleanupGuard = reason === 'successful save'
    ? pending.onBeforeSuccessfulCleanup
    : pending.onBeforeDiscard;
  // Local-AI cleanup guards atomically move the job directory out of the
  // writer-visible pathname and then verify its exact result hash. Accept a
  // relocated workspace only when it is the same inode in the same parent;
  // this preserves the renderer capability boundary while eliminating the
  // check -> lstat/realpath -> rm window in which newer bytes could land.
  if (shouldDeleteWorkspace && cleanupGuard) {
    try {
      const prepared = await cleanupGuard({ workDir: resolvedWorkDir, reason });
      if (prepared?.workDir) {
        const candidate = path.resolve(String(prepared.workDir));
        if (path.dirname(candidate) !== path.dirname(resolvedWorkDir)) {
          throw new Error('Prepared application cleanup workspace escaped its registered parent.');
        }
        const [candidateStat, candidateRealPath] = await Promise.all([
          fs.promises.lstat(candidate),
          fs.promises.realpath(candidate),
        ]);
        const expected = pending.workspaceIdentity;
        if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()
          || candidateRealPath !== candidate
          || (expected && (candidateStat.dev !== expected.dev || candidateStat.ino !== expected.ino))) {
          throw new Error('Prepared application cleanup workspace did not match its registered identity.');
        }
        cleanupWorkDir = candidate;
      }
      if (pendingApplicationArtifacts.get(resolvedWorkDir) !== pending) return false;
    } catch (error) {
      if (error?.code === 'LOCAL_AI_RESULT_CHANGED') {
        // The guard restored the newer writer-visible job. Revoke only the
        // stale one-shot capability so that exact new bytes can import again.
        pendingApplicationArtifacts.delete(resolvedWorkDir);
      }
      throw error;
    }
  }
  pendingApplicationArtifacts.delete(resolvedWorkDir);
  if (!shouldDeleteWorkspace) return true;
  try {
    const current = await fs.promises.lstat(cleanupWorkDir);
    const currentRealPath = await fs.promises.realpath(cleanupWorkDir);
    const expected = pending.workspaceIdentity;
    if (!current.isDirectory() || current.isSymbolicLink()
      || (expected && (current.dev !== expected.dev || current.ino !== expected.ino))
      || currentRealPath !== cleanupWorkDir) {
      logger.warn(`[JobApplication] Refused to remove a replaced application workspace after ${reason}`);
      return false;
    }
    await fs.promises.rm(cleanupWorkDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (cleanupWorkDir !== resolvedWorkDir) {
      const recovery = restoreRelocatedApplicationWorkspace(cleanupWorkDir, resolvedWorkDir, pending);
      const cleanupError = new Error(recovery.restored
        ? `Could not clean the relocated application workspace after ${reason}; its original path was restored for recovery.`
        : `Could not clean or restore the relocated application workspace after ${reason}.`);
      cleanupError.code = 'APPLICATION_WORKSPACE_CLEANUP_FAILED';
      cleanupError.cause = error;
      cleanupError.workspaceRestored = recovery.restored;
      if (recovery.error) cleanupError.restoreError = recovery.error;
      logger.warn(`[JobApplication] ${cleanupError.message}${recovery.error ? ` Restore error: ${recovery.error?.message || recovery.error}` : ''}`);
      throw cleanupError;
    }
    logger.warn(`[JobApplication] Could not clean temporary application workspace after ${reason}: ${error?.message || error}`);
    return false;
  }
  return true;
}

/**
 * Read one main-process-registered generation artifact without following a
 * renderer- or Local-AI-created final symlink. The realpath containment check
 * also catches a linked parent that redirects the registered lexical path.
 */
export async function readRegisteredApplicationArtifact(workDir, filePath, {
  optional = false,
  encoding = null,
  workspaceIdentity = null,
  expectedSha256 = null,
} = {}) {
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!isWithinDirectory(resolvedWorkDir, resolvedFilePath) || resolvedFilePath === resolvedWorkDir) {
    throw new Error('Generated application artifact escaped its registered workspace.');
  }

  let sourceStat;
  let workspaceStat;
  try {
    workspaceStat = await fs.promises.lstat(resolvedWorkDir);
    sourceStat = await fs.promises.lstat(resolvedFilePath);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Generated application artifacts must be regular files, not links.');
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error('Generated application workspace was replaced by a link or non-directory.');
  }

  const [realWorkDir, realFilePath] = await Promise.all([
    fs.promises.realpath(resolvedWorkDir),
    fs.promises.realpath(resolvedFilePath),
  ]);
  if (!isWithinDirectory(realWorkDir, realFilePath) || realFilePath === realWorkDir) {
    throw new Error('Generated application artifact resolved outside its registered workspace.');
  }
  if (workspaceIdentity && (
    workspaceStat.dev !== workspaceIdentity.dev
    || workspaceStat.ino !== workspaceIdentity.ino
    || realWorkDir !== workspaceIdentity.realPath
  )) {
    throw new Error('Generated application workspace changed after it was registered.');
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.promises.open(resolvedFilePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()
      || openedStat.dev !== sourceStat.dev
      || openedStat.ino !== sourceStat.ino) {
      throw new Error('Generated application artifact changed while it was being validated.');
    }
    const data = await handle.readFile();
    if (expectedSha256) {
      const actualSha256 = crypto.createHash('sha256').update(data).digest('hex');
      if (actualSha256 !== expectedSha256) {
        throw new Error('Generated application artifact changed after it was registered.');
      }
    }
    return encoding ? data.toString(encoding) : data;
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shared pure page-fit helpers used by Local AI import and deterministic tests.
// ---------------------------------------------------------------------------

/**
 * The default résumé target is one page regardless of the job title. Seniority
 * in a posting says nothing reliable about the candidate's relevant breadth;
 * a longer résumé is an explicit user/host decision via `targetPageCount`,
 * never a heuristic inferred from the title.
 */
export function targetPageCountForJob() {
  return 1;
}

const INK_MONO_COMPANIES = /\b(?:ibm|accenture|deloitte|pwc|ey|ernst\s*&?\s*young|kpmg|mckinsey|boston\s+consulting|bain)\b/i;
const INK_ONLY_COMPANIES = /\b(?:google|meta|amazon|microsoft|apple|salesforce|oracle|atlassian|shopify)\b/i;
const CONSERVATIVE_RECIPIENT_SIGNALS = /\b(?:regulated|audit|clearance|fedramp|underwriting|actuarial|defen[cs]e|government|public sector|banking)\b/gi;
const ENTERPRISE_RECIPIENT_SIGNALS = /\b(?:enterprise[- ]scale|governance|compliance|stakeholders?|matrix(?:ed)?\s+organi[sz]ation|global)\b/gi;
const A4_LOCATION_SIGNALS = /\b(?:canada|united kingdom|england|scotland|wales|ireland|germany|france|spain|italy|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|australia|new zealand|singapore|india|japan|south korea)\b/i;

function matchingSignalCount(pattern, text) {
  pattern.lastIndex = 0;
  return [...String(text || '').matchAll(pattern)].length;
}

/**
 * Resolve the host-owned document variants from the job record. Models return
 * bare <main> markup and never control document-shell attributes. Default to
 * dual-pdf when the recipient cannot be classified confidently.
 */
export function applicationVariantAttrsForJob(job = {}) {
  const company = String(job?.company || '');
  const recipientText = [company, job?.title, job?.snippet, job?.description]
    .filter(Boolean)
    .join('\n');
  const conservative = INK_MONO_COMPANIES.test(company)
    || matchingSignalCount(CONSERVATIVE_RECIPIENT_SIGNALS, recipientText) > 0;
  const enterprise = INK_ONLY_COMPANIES.test(company)
    || matchingSignalCount(ENTERPRISE_RECIPIENT_SIGNALS, recipientText) >= 5;
  const attrs = [`data-print="${conservative || enterprise ? 'ink-only' : 'dual-pdf'}"`];
  if (conservative) attrs.push('data-mono');
  if (A4_LOCATION_SIGNALS.test(String(job?.location || ''))) attrs.push('data-page="a4"');
  return attrs.join(' ');
}

/**
 * One step of SKILL.md §5's page-count algorithm, as a pure state → action
 * decision — no rendering, no LLM call, just "given what's already been
 * tried, what should happen next."
 *
 * SKILL.md gates compact density on overflow SIZE ("~1-9 lines, or the final
 * page <30% full"). `pdf-lib` gives a page count, not final-page occupancy,
 * so a one-page overrun remains genuinely ambiguous: it can be one line or an
 * almost-full second page. We use compact first in that ambiguous case because
 * it is deterministic and free. More than one whole page beyond target is
 * unambiguously large from the count alone, so it skips straight to the one
 * content revision instead of wasting a compact render that cannot close it.
 *
 * @param {object} args
 * @param {number} args.pageCount     the just-rendered page count
 * @param {number} args.target        target page count (targetPageCountForJob or an override)
 * @param {boolean} args.compactTried    whether data-density="compact" has already been applied+rendered
 * @param {number} [args.revisionAttempts] number of prior length revisions
 * @param {boolean} [args.fontsLoaded=true] whether the render window actually loaded the design
 *   system's web fonts (renderPdf reports this)
 * @returns {{action: 'ship'|'compact'|'revise', reason: string}}
 */
// Plain percentage formatter. There is no minimum utilization to compare
// against, so this only rounds for display.
export function formatTypeAreaUtilization(utilization) {
  if (!Number.isFinite(utilization)) return null;
  const roundedPercent = Math.round(utilization * 10_000) / 100;
  return `${roundedPercent}%`;
}

// Deliberately UNBOUNDED above. A value over 1 is the overflow MAGNITUDE —
// the text spans 1.37 type areas — and it is the only size signal the fit
// feedback, the handoff trace, and the bug report have; `pdf-lib` reports a
// page count, never final-page occupancy. Clamping to 1 made every
// overflowing résumé report exactly 100% and threw that signal away.
// It is a text-span ratio, NOT a page count: the screen preview flows
// continuously, so it omits the @page margins a real second page adds and
// therefore UNDERSTATES the printed overrun. This is a pure, reported
// measurement — it gates nothing; there is no minimum utilization for either
// document.
export function resumeTypeAreaUtilization(layout) {
  const contentHeight = Number(layout?.contentHeightPx);
  const typeAreaHeight = Number(layout?.typeAreaHeightPx);
  if (!Number.isFinite(contentHeight) || !Number.isFinite(typeAreaHeight)
    || contentHeight <= 0 || typeAreaHeight <= 0) return null;
  return contentHeight / typeAreaHeight;
}

// The generator returns a raw design-system <main>, not a built document.
// Keep parsing deliberately regex-based: packaged Electron has no DOM parser,
// and these model-markup blocks follow the fixed design-system component
// shapes. Do not point this at buildResumeDocument output — its inlined CSS
// contains commented <main> examples that are decoys for a first-main scan.
const ROLE_ARTICLE_RE = /<article\b[^>]*class=(?:"[^"]*\brole\b[^"]*"|'[^']*\brole\b[^']*')[^>]*>([\s\S]*?)<\/article>/gi;
const PROJECT_ARTICLE_RE = /<article\b[^>]*class=(?:"[^"]*\bproject\b[^"]*"|'[^']*\bproject\b[^']*')[^>]*>([\s\S]*?)<\/article>/gi;
const HIGHLIGHTS_RE = /<ul\b[^>]*class=(?:"[^"]*\bhighlights\b[^"]*"|'[^']*\bhighlights\b[^']*')[^>]*>([\s\S]*?)<\/ul>/i;
const LIST_ITEM_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const SKILLS_RE = /<dl\b[^>]*class=(?:"[^"]*\bskills\b[^"]*"|'[^']*\bskills\b[^']*')[^>]*>([\s\S]*?)<\/dl>/i;
const SKILL_PAIR_RE = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
const EDU_LINE_RE = /<div\b[^>]*class=(?:"[^"]*\bedu-line\b[^"]*"|'[^']*\bedu-line\b[^']*')[^>]*>([\s\S]*?)<\/div>/gi;

// The 180/100 budget counts VISIBLE characters, and the design system's own
// gate (build/annotation-budget-test.js) strips tags to the empty string.
// resumeTextFromHtml replaces every tag with a space so block boundaries do not
// glue words together — correct for its other consumers, but it inflates the
// count by one for every mid-token tag, which is exactly where `.nowrap` and a
// `data-achievement-id` span sit. Measure the budget with the gate's own rule.
function resumeTextDocument(markup) {
  // `new JSDOM()` creates a complete Window realm. These helpers run once per
  // text-bearing résumé field (and several times per bullet), so retaining
  // those realms until a later GC made one validation pass consume gigabytes.
  // A fragment has the same HTML-parser/entity-decoding behavior we need here
  // without allocating a browsing context. It also keeps this parser-backed:
  // malformed tags and entities are interpreted by jsdom, never by a regex.
  const root = JSDOM.fragment(String(markup || ''));
  const document = root.ownerDocument;
  // `<br>` and `<hr>` are visible separators even though DOM textContent does
  // not include a character for them.
  for (const separator of root.querySelectorAll('br, hr')) {
    separator.replaceWith(document.createTextNode(' '));
  }
  return root;
}

function resumeBudgetTextFromHtml(markup) {
  return resumeTextDocument(markup).textContent
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function resumeTextFromHtml(markup) {
  const root = resumeTextDocument(markup);
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const text = [];
  while (walker.nextNode()) text.push(walker.currentNode.nodeValue);
  // Separating text nodes retains the old extractor's block and inline-tag
  // boundary semantics without relying on an incomplete HTML regex.
  return text.join(' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

// A whole class token, not `\b<class>\b`: hyphens are non-word characters, so
// `\btitle\b` also matches the wrapper `.role-title-line` that encloses the
// `.title` span and would return "Title · Company" as the role title.
const CLASS_TOKEN_START = '(?<![\\w-])';
const CLASS_TOKEN_END = '(?![\\w-])';

// Depth-counted, not a non-greedy same-tag match. `.tradeoff` legitimately
// wraps other spans — `.annotation-label` and the allowlisted `.nowrap` that
// the design system uses to keep a value and its unit together — and a lazy
// `([\s\S]*?)</\1>` stops at the FIRST nested close tag, so an over-budget
// clause measured as a fragment and passed.
function firstResumeClassHtml(html, className) {
  const source = String(html || '');
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*class=(?:"[^"]*${CLASS_TOKEN_START}${escaped}${CLASS_TOKEN_END}[^"]*"|'[^']*${CLASS_TOKEN_START}${escaped}${CLASS_TOKEN_END}[^']*')[^>]*>`, 'i');
  const match = open.exec(source);
  if (!match) return '';
  const tag = match[1].toLowerCase();
  const start = match.index + match[0].length;
  const boundary = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  boundary.lastIndex = start;
  let depth = 1;
  let step;
  while ((step = boundary.exec(source))) {
    depth += step[1] ? -1 : 1;
    if (depth === 0) return source.slice(start, step.index);
  }
  // Unbalanced markup: measure the rest rather than silently reporting a
  // fragment that would understate a budget.
  return source.slice(start);
}

function firstResumeClassText(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*class=(?:"[^"]*${CLASS_TOKEN_START}${escaped}${CLASS_TOKEN_END}[^"]*"|'[^']*${CLASS_TOKEN_START}${escaped}${CLASS_TOKEN_END}[^']*')[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  return resumeTextFromHtml(re.exec(String(html || ''))?.[2] || '');
}

function resumeAchievementIds(markup) {
  const ids = [];
  const idRe = /<[a-z][\w:-]*\b[^>]*\bdata-achievement-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))[^>]*>/gi;
  let match;
  while ((match = idRe.exec(String(markup || '')))) {
    const id = String(match[1] || match[2] || match[3] || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * A role header without a factual bullet looks unfinished and makes an older
 * job appear accidentally truncated. Keep this independent of page fitting:
 * it describes the minimum evidence contract for every role that remains.
 */
export function retainedResumeRolesWithoutBullets(mainHtml) {
  const roles = [];
  let roleMatch;
  ROLE_ARTICLE_RE.lastIndex = 0;
  while ((roleMatch = ROLE_ARTICLE_RE.exec(String(mainHtml || '')))) {
    const roleHtml = roleMatch[1];
    const highlights = HIGHLIGHTS_RE.exec(roleHtml)?.[1] || '';
    let hasBullet = false;
    let bulletMatch;
    LIST_ITEM_RE.lastIndex = 0;
    while ((bulletMatch = LIST_ITEM_RE.exec(highlights))) {
      if (resumeTextFromHtml(bulletMatch[1])) {
        hasBullet = true;
        break;
      }
    }
    if (!hasBullet) {
      roles.push({
        title: firstResumeClassText(roleHtml, 'title'),
        company: firstResumeClassText(roleHtml, 'company'),
      });
    }
  }
  return roles;
}

export function assertRetainedResumeRoleBullets(mainHtml) {
  // A zero-match result is not proof that every role has evidence. It means the
  // design-system role contract was not recognized at all (for example, after
  // its owner renamed `.role` or changed the article structure). Fail loudly
  // and distinctly so this safety net cannot silently open during a reconnect.
  ROLE_ARTICLE_RE.lastIndex = 0;
  const matchedRole = ROLE_ARTICLE_RE.test(String(mainHtml || ''));
  ROLE_ARTICLE_RE.lastIndex = 0;
  if (!matchedRole) {
    throw new Error('Résumé structural validation failed: no role elements matched the expected <article class="role"> contract. The design-system role markup may have changed.');
  }
  const missing = retainedResumeRolesWithoutBullets(mainHtml);
  if (!missing.length) return String(mainHtml || '');
  const labels = missing.map((role, index) => role.company || role.title || `role ${index + 1}`).join(', ');
  throw new Error(`Every retained résumé role must include at least one factual bullet; missing evidence for ${labels}.`);
}

// A role's employment location has two legal homes (STYLE.md §5.2b): its own
// `.role-location` cell, or — when the role carries no `.role-summary` to share
// that row with — folded into the `.role-dates` cell after the standard `·`
// separator, `May 2023 – Jun 2026 · Loveland, CO`. Read both so every consumer
// sees the same fact regardless of which shape the writer chose, and so the
// fold does not read as a missing location to the gate below.
function resumeRoleDatesAndLocation(roleHtml) {
  const dates = firstResumeClassText(roleHtml, 'role-dates');
  const explicit = firstResumeClassText(roleHtml, 'role-location');
  if (explicit) return { dates, location: explicit };
  // Split on the LAST separator by hand rather than with a regex. The obvious
  // pattern for this — /^(.*\d.*?)\s*·\s*([^·]+)$/ — backtracks quadratically
  // when the cell holds digits and no separator at all: a 24k-char role-dates
  // cell cost 2.4s per pass here, and this runs per role inside the synchronous
  // Local AI import on the main process. indexOf/slice is linear and does the
  // same job.
  const at = dates.lastIndexOf('·');
  if (at < 0) return { dates, location: '' };
  const head = dates.slice(0, at).trim();
  const tail = dates.slice(at + 1).trim();
  // The date range is the year-bearing half, and it has to be there — otherwise
  // this is some other use of the separator, not a fold. A trailing cell
  // carrying its own year is more of the range, not a city; a house number or a
  // route number in a place name is fine, so test for a year, not any digit.
  if (!head || !tail || !/\d/.test(head) || /\b\d{4}\b/.test(tail)) return { dates, location: '' };
  return { dates: head, location: tail };
}

// US states, DC and the inhabited territories, plus Canadian provinces —
// full names and postal codes. A closed, stable set, not a heuristic: its only
// job is to let `careerDataRoleLocation` be CERTAIN that an employer line ends
// in a place. An employer line that does not end in a recognized region simply
// yields nothing and the location gate stays silent for that role, because a
// requirement the career data did not actually state is worse than a miss.
const CAREER_DATA_REGIONS = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
  'puerto rico': 'PR', guam: 'GU', 'american samoa': 'AS',
  'us virgin islands': 'VI', 'northern mariana islands': 'MP',
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', 'québec': 'QC',
  saskatchewan: 'SK', 'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
}));
const CAREER_DATA_REGION_CODES = new Set(CAREER_DATA_REGIONS.values());

function normalizeCareerDataText(value) {
  // Career data reaches us as the transcribed corpus, so headings keep their
  // markdown emphasis. Strip only the decoration; never the words.
  return String(value || '')
    .replace(/[*_`#]+/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function careerDataRegionCode(region) {
  const key = normalizeCareerDataText(region).toLowerCase().replace(/\./g, '').trim();
  if (CAREER_DATA_REGIONS.has(key)) return CAREER_DATA_REGIONS.get(key);
  const upper = key.toUpperCase();
  return CAREER_DATA_REGION_CODES.has(upper) ? upper : '';
}

/**
 * Do two written forms of an employer name refer to the same employer? The
 * résumé legitimately shortens or extends what the corpus wrote — `FliteX` for
 * `FliteX (Plan de Vol International)`, `Thomson School District (K-12)` for
 * `Thomson School District` — so one name must be a WHOLE-WORD prefix of the
 * other. A bare substring test is what made `Horizon Health` read its city out
 * of `Alliance — Getzville`, rejecting a correct résumé and telling the writer
 * to render that string. `Health` matches neither name.
 */
function careerDataNamesMatch(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (!longer.startsWith(shorter)) return false;
  // The prefix must end on a word boundary, so `Acme` never matches `Acmetrics`.
  return /[\s(,.:;\u2014\u2013-]/.test(longer.charAt(shorter.length));
}

// One `Employer — City, Region` heading from the corpus. The separator must be
// whitespace-delimited so a hyphenated name (`K-12`, `Foo-Bar Inc`) is not read
// as one, and the split is GREEDY: the location is the tail, so an employer
// whose own name contains a spaced dash (`Baker - Whitfield Consulting`) keeps
// all of it. A non-greedy split cut at the first dash and produced the city
// `Whitfield Consulting — Denver`.
const CAREER_DATA_HEADING_RE = /^(.*)\s+[\u2014\u2013-]\s+([^\u2014\u2013]+)$/;

function careerDataLocationHeadings(careerData) {
  const headings = [];
  for (const rawLine of String(careerData || '').split(/\r?\n/)) {
    const split = CAREER_DATA_HEADING_RE.exec(normalizeCareerDataText(rawLine));
    if (!split) continue;
    const employer = split[1].trim();
    const parts = split[2].split(',');
    if (!employer || parts.length !== 2) continue;
    const city = parts[0].trim();
    const code = careerDataRegionCode(parts[1]);
    // A city is words, not a date, a metric, or a sentence.
    if (!code || !city || city.length > 40 || /[\d;:()]/.test(city)) continue;
    headings.push({ employer, city, region: parts[1].trim(), code, text: `${city}, ${code}` });
  }
  return headings;
}

/**
 * Find the employment location the career data states for one employer, by
 * reading the employer's own heading line — `Thomson School District —
 * Loveland, Colorado`. Returns `null` unless the corpus names this employer
 * UNAMBIGUOUSLY AND gives it a `City, Region` whose region is recognized, so a
 * role the corpus never located produces no requirement.
 */
export function careerDataRoleLocation(careerData, company) {
  const employer = normalizeCareerDataText(company);
  if (employer.length < 3) return null;
  const headings = careerDataLocationHeadings(careerData);
  // An exact heading wins outright: a corpus listing both `Acme` and
  // `Acme Health` must give `Acme` its own city, not its longer neighbour's.
  const exact = headings.filter(entry => entry.employer.toLowerCase() === employer.toLowerCase());
  // One employer, two stints, two cities: which one THIS role is cannot be told
  // from the name, so require agreement here exactly as below.
  const unambiguous = (matches) => {
    if (!matches.length) return null;
    return new Set(matches.map(entry => entry.text)).size === 1 ? matches[0] : null;
  };
  if (exact.length) return unambiguous(exact);
  // Two different employers could both extend this name. Which one the role
  // means is genuinely unknown, and a guess here is a fabricated requirement.
  return unambiguous(headings.filter(entry => careerDataNamesMatch(entry.employer, employer)));
}

// A project category can carry factual provenance just as an employer heading
// does. Calling source-labelled work merely "Projects" or "Selected Projects"
// erases the distinction between independent, employer-owned, academic, and
// community work. Keep this parser deliberately conservative: it recognizes
// only an explicit attribution-bearing project heading and only associates a
// rendered project when its displayed name begins a source line inside that
// heading's own region. A generic `Projects` heading is deliberately not a
// provenance category, so the validator never invents an attribution.
const PROJECT_PROVENANCE_HEADING_RE = /^(?:personal|professional|academic|school|coursework|student|volunteer(?:ing)?|work|client|employer(?:[-\s]owned)?|open[-\s]?source)\s+projects?$/iu;
const OPEN_SOURCE_PROJECTS_HEADING_RE = /^open[-\s]?source(?:\s+projects?)?$/iu;
const PROJECT_SHAPED_SECTION_HEADING_RE = /^(?:(?:selected|featured)\s+)?(?:(?:personal|professional|academic|school|coursework|student|volunteer(?:ing)?|work|client|employer(?:[-\s]owned)?|open[-\s]?source)\s+)?(?:projects?|systems?)$/iu;
const CAREER_DATA_FILE_BOUNDARY_RE = /^={3,}\s*FILE\s*:/iu;
const PLAIN_CAREER_SECTION_HEADING_RE = /^(?:summary|profile|experience|work experience|professional experience|employment|skills|education|certifications?|awards?|publications?|volunteer(?:ing)?|projects?|selected projects?|personal projects?)$/iu;

function isProjectProvenanceHeading(label) {
  return PROJECT_PROVENANCE_HEADING_RE.test(label) || OPEN_SOURCE_PROJECTS_HEADING_RE.test(label);
}

function cleanCareerDataHeading(value) {
  return normalizeCareerDataText(value)
    .replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/gu, '')
    .replace(/\s*[:：]\s*$/u, '')
    .trim();
}

function careerDataMarkdownHeading(value) {
  const match = /^\s{0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/.exec(String(value || ''));
  if (!match) return null;
  const label = cleanCareerDataHeading(match[2]);
  return label ? { level: match[1].length, label } : null;
}

function careerDataProjectProvenanceRegions(careerData) {
  const lines = String(careerData || '').split(/\r?\n/);
  const regions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const markdownHeading = careerDataMarkdownHeading(lines[index]);
    const plainLabel = markdownHeading ? '' : cleanCareerDataHeading(lines[index]);
    const heading = markdownHeading || (isProjectProvenanceHeading(plainLabel)
      ? { level: null, label: plainLabel }
      : null);
    if (!heading || !isProjectProvenanceHeading(heading.label)) continue;

    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidateLine = lines[cursor];
      if (CAREER_DATA_FILE_BOUNDARY_RE.test(normalizeCareerDataText(candidateLine))) {
        end = cursor;
        break;
      }
      const nextMarkdownHeading = careerDataMarkdownHeading(candidateLine);
      if (nextMarkdownHeading && (heading.level == null || nextMarkdownHeading.level <= heading.level)) {
        end = cursor;
        break;
      }
      if (heading.level == null) {
        const nextPlainLabel = cleanCareerDataHeading(candidateLine);
        if (PLAIN_CAREER_SECTION_HEADING_RE.test(nextPlainLabel) || isProjectProvenanceHeading(nextPlainLabel)) {
          end = cursor;
          break;
        }
      }
    }
    regions.push({ label: heading.label, lines: lines.slice(index + 1, end) });
  }
  return regions;
}

function projectIdentityKey(value) {
  return normalizeCareerDataText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function projectProvenanceRegionContainsName(region, renderedName) {
  const needle = projectIdentityKey(renderedName);
  if (!needle || needle.length < 3) return false;
  return region.lines.some((rawLine) => {
    const sourceLine = String(rawLine || '')
      .replace(/^\s{0,3}#{1,6}[\t ]+/u, '')
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '');
    const sourceKey = projectIdentityKey(sourceLine);
    return sourceKey === needle || sourceKey.startsWith(`${needle} `);
  });
}

// A title alone is only enforceable when it maps to exactly one source
// attribution. The same name can legitimately occur under Personal Projects
// and Open Source (or in separate imported files), and guessing which one the
// writer meant would turn a provenance guard into a false rejection.
function projectProvenanceRegionForRenderedName(regions, renderedName) {
  const matches = regions.filter(region => projectProvenanceRegionContainsName(region, renderedName));
  const labels = new Set(matches.map(region => projectIdentityKey(region.label)));
  return labels.size === 1 ? matches[0] : null;
}

/**
 * Return the exact, source-owned project provenance heading for a displayed
 * name when it is unambiguous. The structured paste renderer uses this same
 * parser as final import, preventing divergent treatment of nested Markdown,
 * plain section boundaries, and multi-file career-data imports.
 */
export function careerDataProjectProvenanceHeadingForName(careerData, renderedName) {
  return projectProvenanceRegionForRenderedName(
    careerDataProjectProvenanceRegions(careerData),
    renderedName,
  )?.label || '';
}

function directSectionHeading(section) {
  for (const child of Array.from(section?.children || [])) {
    if (child.classList?.contains('section-head')) {
      const heading = child.querySelector('h2');
      if (heading) return normalizeCareerDataText(heading.textContent);
    }
    if (child.tagName === 'H2') return normalizeCareerDataText(child.textContent);
  }
  return '';
}

function projectCandidateNamesForSection(section, renderedHeading) {
  const selector = '.project-name, .project > h3, .project > .title';
  const candidates = Array.from(section.querySelectorAll(selector));
  // Some older writers used role-shaped markup for projects. Keep catching
  // that malformed project section, but never treat a genuine Experience role
  // title as a project simply because it shares a name with one.
  if (PROJECT_SHAPED_SECTION_HEADING_RE.test(renderedHeading)) {
    candidates.push(...section.querySelectorAll('article.role .title'));
  }
  return [...new Set(candidates
    .map(node => normalizeCareerDataText(node.textContent))
    .filter(Boolean))];
}

/**
 * Reject a résumé that strips explicit source attribution from a retained
 * project. Optional projects may still be omitted; this gate applies only when
 * a displayed project name maps unambiguously to a source line under an
 * explicit provenance-bearing project heading.
 */
export function resumeProjectProvenanceFailures(mainHtml, careerData) {
  const projectRegions = careerDataProjectProvenanceRegions(careerData);
  if (!projectRegions.length) return [];

  const dom = new JSDOM(String(mainHtml || ''));
  const problems = [];
  try {
    const main = dom.window.document.querySelector('main.page') || dom.window.document.querySelector('main');
    if (!main) return [];
    const sections = Array.from(main.children).filter(child => child.matches?.('section.section'));
    for (const section of sections) {
      const renderedHeading = directSectionHeading(section);
      const renderedHeadingKey = projectIdentityKey(renderedHeading);
      const candidateNames = projectCandidateNamesForSection(section, renderedHeading);
      if (!candidateNames.length) continue;

      const mismatchesByRegion = new Map();
      for (const name of candidateNames) {
        const region = projectProvenanceRegionForRenderedName(projectRegions, name);
        if (!region || renderedHeadingKey === projectIdentityKey(region.label)) continue;
        const regionKey = projectIdentityKey(region.label);
        const names = mismatchesByRegion.get(regionKey) || { region, names: [] };
        names.names.push(name);
        mismatchesByRegion.set(regionKey, names);
      }
      for (const { region, names: matchedNames } of mismatchesByRegion.values()) {
        const shown = renderedHeading ? `“${renderedHeading}”` : 'a section with no heading';
        problems.push(
          `${matchedNames.join(', ')} ${matchedNames.length === 1 ? 'is' : 'are'} identified under “${region.label}” in the career data but presented under ${shown}. `
          + `Preserve the provenance-bearing heading exactly as “${region.label}”; selecting only some projects does not erase their source attribution or make them generic selected work.`,
        );
      }
    }
  } finally {
    dom.window.close();
  }
  return [...new Set(problems)];
}

/**
 * The résumé must show the employment location the career data supplied with a
 * role (STYLE.md §5.2, routine step 4). This is the deterministic half of that
 * rule: the contract tells the writer to render it, and this catches the writer
 * that did not. It only ever asserts what the corpus actually states — a role
 * with no located employer line is not required to show anything, and nothing
 * here invents, infers, or backfills a location.
 */
export function resumeRoleLocationFailures(roles, careerData) {
  const missing = [];
  const wrong = [];
  for (const role of Array.isArray(roles) ? roles : []) {
    const stated = careerDataRoleLocation(careerData, role?.company);
    if (!stated) continue;
    const shown = normalizeCareerDataText(role?.location);
    const label = `${role?.title || 'role'} at ${role.company}`;
    if (!shown) {
      missing.push(`${label} (career data states ${stated.city}, ${stated.region})`);
      continue;
    }
    const comma = shown.lastIndexOf(',');
    const shownCity = comma < 0 ? shown : shown.slice(0, comma).trim();
    // The region may legitimately be abbreviated, or left off entirely — but a
    // region that is present and names a DIFFERENT place is a contradiction,
    // not a formatting choice. Never require a region the résumé omitted:
    // supplying the missing half is the fabrication this rule exists to stop.
    // The city is matched by the same whole-word prefix relation as the
    // employer, which DELIBERATELY tolerates one name extending the other
    // ("New York" for a stated "New York City"). That also lets a fabricated
    // neighbour through ("Loveland Heights" for "Loveland"), and that trade is
    // intended: the alternative rejects a correct résumé and tells the writer
    // its own city is wrong, which is the worse failure for this gate to have.
    const shownRegion = comma < 0 ? '' : careerDataRegionCode(shown.slice(comma + 1));
    if (!careerDataNamesMatch(shownCity, stated.city) || (shownRegion && shownRegion !== stated.code)) {
      wrong.push(`${label} shows "${shown}" but the career data states ${stated.city}, ${stated.region}`);
    }
  }
  const problems = [];
  if (missing.length) {
    problems.push(`Every role must show the work location its career-data entry states, in a <p class="role-location"> inside <div class="role-meta meta-row"> or folded into the .role-dates cell after a <span class="sep" aria-hidden="true">·</span>. Missing for: ${missing.join('; ')}.`);
  }
  if (wrong.length) {
    problems.push(`A role's work location must be the one the career data states: ${wrong.join('; ')}.`);
  }
  return problems;
}

// Reports need to know whether the repeating Experience structure survived,
// but the markup itself can carry career history and locations. Keep only
// structural metadata: role count and whether the former bounded sample would
// have been truncated before it was deliberately withheld.
const ROLE_BLOCK_SAMPLE_MAX_CHARS = 1_800;

export function resumeRoleBlockSample(mainHtml, maxChars = ROLE_BLOCK_SAMPLE_MAX_CHARS) {
  const html = String(mainHtml || '');
  let roleCount = 0;
  let firstLength = 0;
  let match;
  ROLE_ARTICLE_RE.lastIndex = 0;
  while ((match = ROLE_ARTICLE_RE.exec(html))) {
    roleCount += 1;
    if (!firstLength) firstLength = match[0].length;
  }
  ROLE_ARTICLE_RE.lastIndex = 0;
  if (!firstLength) return { found: false, roleCount: 0, truncated: false };
  return { found: true, roleCount, truncated: firstLength > maxChars };
}

/**
 * Extract the final model-authored résumé markup into the letter's small,
 * inspectable evidence base. Annotation spans intentionally remain in each
 * bullet's text: their trade-off/scope reasoning is valuable letter context.
 */
export function extractResumeEvidence(mainHtml) {
  // A built document inlines stylesheet comments containing illustrative
  // `<main>` snippets. Stripping comments up front makes this safe in
  // diagnostics/tests too, although production deliberately feeds raw markup.
  const html = String(mainHtml || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const contactText = firstResumeClassText(html, 'contact');
  const contact = contactText
    .split(/\s*·\s*/)
    .map(item => item.trim())
    .filter(Boolean);
  const roles = [];
  const projects = [];
  const achievementIds = [];
  const bulletTexts = [];
  let roleMatch;
  ROLE_ARTICLE_RE.lastIndex = 0;
  while ((roleMatch = ROLE_ARTICLE_RE.exec(html))) {
    const roleHtml = roleMatch[1];
    const bullets = [];
    const highlights = HIGHLIGHTS_RE.exec(roleHtml)?.[1] || '';
    let bulletMatch;
    LIST_ITEM_RE.lastIndex = 0;
    while ((bulletMatch = LIST_ITEM_RE.exec(highlights))) {
      const text = resumeTextFromHtml(bulletMatch[1]);
      const ids = resumeAchievementIds(bulletMatch[1]);
      if (text) {
        // The `.tradeoff` clause carries its own STYLE.md §5.4 sub-budget, so
        // it is captured separately from the bullet's full visible text. Its
        // `.annotation-label` prefix is excluded, matching how the design
        // system's own budget checker measures the clause.
        // The label span is removed BEFORE the clause is extracted: it nests
        // inside `.tradeoff`, and a non-greedy same-tag match would otherwise
        // stop at the label's own closing tag and measure nothing.
        const withoutLabels = String(bulletMatch[1]).replace(
          /<([a-z][\w:-]*)\b[^>]*class=(?:"[^"]*\bannotation-label\b[^"]*"|'[^']*\bannotation-label\b[^']*')[^>]*>[\s\S]*?<\/\1>/gi, ' ',
        );
        const tradeoff = resumeBudgetTextFromHtml(firstResumeClassHtml(withoutLabels, 'tradeoff'));
        bullets.push({ text, tradeoff, budgetText: resumeBudgetTextFromHtml(bulletMatch[1]), achievementIds: ids });
        bulletTexts.push(text);
      }
      for (const id of ids) if (!achievementIds.includes(id)) achievementIds.push(id);
    }
    const { dates, location } = resumeRoleDatesAndLocation(roleHtml);
    roles.push({
      title: firstResumeClassText(roleHtml, 'title'),
      company: firstResumeClassText(roleHtml, 'company'),
      dates,
      location,
      summary: firstResumeClassText(roleHtml, 'role-summary'),
      bullets,
    });
  }

  let projectMatch;
  PROJECT_ARTICLE_RE.lastIndex = 0;
  while ((projectMatch = PROJECT_ARTICLE_RE.exec(html))) {
    const projectHtml = projectMatch[1];
    const name = firstResumeClassText(projectHtml, 'project-name');
    if (name) {
      projects.push({
        name,
        description: firstResumeClassText(projectHtml, 'project-desc'),
        metrics: firstResumeClassText(projectHtml, 'project-metrics'),
      });
    }
  }

  const skills = [];
  const skillsBlock = SKILLS_RE.exec(html)?.[1] || '';
  let skillMatch;
  SKILL_PAIR_RE.lastIndex = 0;
  while ((skillMatch = SKILL_PAIR_RE.exec(skillsBlock))) {
    const group = resumeTextFromHtml(skillMatch[1]);
    const items = resumeTextFromHtml(skillMatch[2])
      .split(/\s*·\s*/)
      .map(item => item.trim())
      .filter(Boolean);
    if (group || items.length) skills.push({ group, items });
  }

  // The current design system places the degree in the header credential,
  // not in a bottom section. Preserve it as structured evidence so
  // degree-sensitive cover-letter checks retain the same truthful input.
  const subtitleRole = firstResumeClassText(html, 'subtitle-role');
  const credential = firstResumeClassText(html, 'credential');
  const education = [];
  if (credential) education.push(credential);
  let educationMatch;
  EDU_LINE_RE.lastIndex = 0;
  while ((educationMatch = EDU_LINE_RE.exec(html))) {
    const line = resumeTextFromHtml(educationMatch[1]);
    if (line && !education.includes(line)) education.push(line);
  }

  return {
    identity: {
      name: firstResumeClassText(html, 'name'),
      tagline: firstResumeClassText(html, 'tagline'),
      // Keep the semantic pieces as well as the legacy flattened tagline.
      // The cover letter reuses these nodes so its letterhead has the same
      // separator metrics as the accepted résumé rather than merely similar
      // text with ordinary whitespace around a dot.
      subtitleRole,
      credential,
      contact,
    },
    roles,
    projects,
    skills,
    education,
    achievementIds,
    bulletTexts,
  };
}

const DEPENDENT_RESUME_SYSTEM_REFERENCE = /\b(?:that|those|these)\s+(APIs?|applications?|databases?|datasets?|feeds?|integrations?|pipelines?|platforms?|services?|systems?|tools?)\b/iu;
const LEADING_RESUME_REFERENCE = /^(?:This|That|These|Those|It|They|Such)\b/u;

// The bullet checks below already collect every offending bullet rather than
// stopping at the first, and then printed only the first eight with nothing
// said about the rest — so a résumé with ten overlong bullets read as a
// résumé with eight, and the round spent fixing those eight discovered the
// other two. The count stays bounded; what it left out is now disclosed, the
// same way coverLetterChecks.js's observationResult discloses it.
const MAX_RESUME_CHECK_OBSERVATIONS = 8;

function resumeCheckDetail(observations) {
  const visible = observations.slice(0, MAX_RESUME_CHECK_OBSERVATIONS);
  const omitted = observations.length - visible.length;
  return `${visible.join('; ')}${omitted ? `; ${omitted} additional observation(s) omitted` : ''}`;
}

/**
 * Résumé bullets are independently scanned by recruiters and ATS previews.
 * Reject only high-confidence backward references here; broader antecedent
 * ambiguity remains an editorial review concern.
 */
export function checkResumeBulletSelfContainment(mainHtml) {
  const evidence = extractResumeEvidence(mainHtml);
  const observations = [];
  evidence.roles.forEach((role, roleIndex) => {
    (Array.isArray(role.bullets) ? role.bullets : []).forEach((bullet, bulletIndex) => {
      const text = String(bullet?.text || '').replace(/\s+/g, ' ').trim();
      const dependent = DEPENDENT_RESUME_SYSTEM_REFERENCE.exec(text);
      const leading = LEADING_RESUME_REFERENCE.exec(text);
      const earlierText = dependent ? text.slice(0, dependent.index) : '';
      const repeatedReferent = dependent
        ? new RegExp(`\\b${dependent[1]}\\b`, 'iu').test(earlierText)
        : false;
      const match = (!repeatedReferent && dependent?.[0]) || leading?.[0] || '';
      if (!match) return;
      const label = role.company || role.title || `role ${roleIndex + 1}`;
      observations.push(`${label} bullet ${bulletIndex + 1} uses “${match}”; name the concrete referent inside the bullet`);
    });
  });
  return observations.length
    ? { id: 'resume-bullet-self-containment', passed: false, detail: resumeCheckDetail(observations) }
    : { id: 'resume-bullet-self-containment', passed: true, detail: `${evidence.bulletTexts.length} résumé bullet(s) are self-contained` };
}

// Containerization and runtime topology are related deployment facts, but a
// trailing participial topology clause usually turns one concise résumé point
// into an implementation inventory. Keep this check narrow: an explicit
// second predicate with a result or constraint remains legal.
const RESUME_CONTAINERIZATION_TOPOLOGY_TAIL = /\bcontaineri[sz](?:e|ed|ing)\b[^.!?]{0,180},\s*(?:while\s+)?(?:running|serving|routing|proxying|hosting)\b[^.!?]{0,180}\b(?:Nginx|Gunicorn|uWSGI|Apache|Tomcat|Caddy|HAProxy|Traefik|IIS|Passenger|Puma|Unicorn|mod_wsgi)\b/iu;

/** Keeps each résumé highlight focused on one principal achievement. */
export function checkResumeBulletFocus(mainHtml) {
  const evidence = extractResumeEvidence(mainHtml);
  const observations = [];
  evidence.roles.forEach((role, roleIndex) => {
    (Array.isArray(role.bullets) ? role.bullets : []).forEach((bullet, bulletIndex) => {
      const value = String(bullet?.text || '').replace(/\s+/g, ' ').trim();
      const match = RESUME_CONTAINERIZATION_TOPOLOGY_TAIL.exec(value);
      if (!match) return;
      const label = role.company || role.title || `role ${roleIndex + 1}`;
      observations.push(`${label} bullet ${bulletIndex + 1} appends runtime topology to a containerization point (“${match[0]}”); keep the principal containerization claim, or retain topology only in a separate result- or constraint-bearing predicate`);
    });
  });
  return observations.length
    ? { id: 'resume-bullet-focus', passed: false, detail: resumeCheckDetail(observations) }
    : { id: 'resume-bullet-focus', passed: true, detail: `${evidence.bulletTexts.length} résumé bullet(s) keep one principal achievement` };
}

// STYLE.md §5.4 states one number for every bullet, annotated or not: 180
// visible characters, with a `.tradeoff` clause's own text under 100. Until
// now nothing in this pipeline measured it. The design system's checker
// (build/annotation-budget-test.js) reads a filled.html the Local AI routine
// forbids producing, so a budget the writer is told to respect was enforced
// only by the writer's own arithmetic — and an overlong bullet reached the
// renderer as an unexplained page overflow instead of a named defect.
export const RESUME_BULLET_CHARACTER_BUDGET = 180;
export const RESUME_TRADEOFF_CHARACTER_BUDGET = 100;

export function checkResumeBulletLength(mainHtml) {
  const evidence = extractResumeEvidence(mainHtml);
  const observations = [];
  evidence.roles.forEach((role, roleIndex) => {
    const label = role.company || role.title || `role ${roleIndex + 1}`;
    (Array.isArray(role.bullets) ? role.bullets : []).forEach((bullet, bulletIndex) => {
      const visible = String(bullet?.budgetText ?? bullet?.text ?? '').replace(/\s+/g, ' ').trim();
      if (visible.length > RESUME_BULLET_CHARACTER_BUDGET) {
        observations.push(`${label} bullet ${bulletIndex + 1} is ${visible.length} visible characters (budget ${RESUME_BULLET_CHARACTER_BUDGET}); cut it to ${RESUME_BULLET_CHARACTER_BUDGET} or fewer`);
      }
      // The annotation's own text, excluding its label span, carries the
      // tighter sub-budget so it reads as a subordinate clause.
      const tradeoff = String(bullet?.tradeoff || '').replace(/\s+/g, ' ').trim();
      if (tradeoff.length > RESUME_TRADEOFF_CHARACTER_BUDGET) {
        observations.push(`${label} bullet ${bulletIndex + 1} carries a ${tradeoff.length}-character tradeoff annotation (budget ${RESUME_TRADEOFF_CHARACTER_BUDGET}); shorten it`);
      }
    });
  });
  return observations.length
    ? { id: 'resume-bullet-length', passed: false, detail: resumeCheckDetail(observations) }
    : { id: 'resume-bullet-length', passed: true, detail: `${evidence.bulletTexts.length} résumé bullet(s) fit the ${RESUME_BULLET_CHARACTER_BUDGET}-character budget` };
}

// STYLE.md §5.3 / SKILL.md: "3–6 bullets per role. Fewer reads thin; more
// reads as a list." Nothing in this pipeline read bullet COUNT before now, so
// a role a starved evidence plan could not fill honestly had no ceiling
// stopping it from being padded past six — a shipped résumé once carried nine
// bullets in one role by splitting four real accomplishments apart
// (structuredResume.js's ROLE_BULLET_EVIDENCE_EXCLUSIVITY_RULE is the other
// half of that same fix, catching the citation reuse a bullet COUNT ceiling
// alone cannot see). Only the ceiling is enforced here: the documented
// emergency fitting move (STYLE.md) allows cutting a role to a single bullet
// when a page must shed a line, and a floor in this battery would deadlock
// that move against the very check meant to let it through.
export const RESUME_ROLE_BULLET_CEILING = 6;

export function checkResumeRoleBulletBudget(mainHtml) {
  const evidence = extractResumeEvidence(mainHtml);
  const observations = [];
  evidence.roles.forEach((role, roleIndex) => {
    const label = role.company || role.title || `role ${roleIndex + 1}`;
    const count = Array.isArray(role.bullets) ? role.bullets.length : 0;
    if (count > RESUME_ROLE_BULLET_CEILING) {
      observations.push(`${label} carries ${count} bullets (ceiling ${RESUME_ROLE_BULLET_CEILING}); cut it to ${RESUME_ROLE_BULLET_CEILING} or fewer`);
    }
  });
  return observations.length
    ? { id: 'resume-role-bullet-budget', passed: false, detail: resumeCheckDetail(observations) }
    : { id: 'resume-role-bullet-budget', passed: true, detail: `${evidence.roles.length} résumé role(s) fit the ${RESUME_ROLE_BULLET_CEILING}-bullet ceiling` };
}

/** Shared pre-publication prose checks for the résumé's generated copy. */
export function evaluateResumeProseChecks(mainHtml) {
  const evidence = extractResumeEvidence(mainHtml);
  const prose = evidence.roles.flatMap(role => [
    role.summary,
    ...(Array.isArray(role.bullets) ? role.bullets.map(bullet => bullet.text) : []),
  ]).filter(Boolean);
  return [
    checkResumeBulletSelfContainment(mainHtml),
    checkResumeBulletFocus(mainHtml),
    checkResumeBulletLength(mainHtml),
    checkResumeRoleBulletBudget(mainHtml),
    checkCompoundHyphenation(prose),
    checkParallelStructure(prose),
    checkReferenceClarity(prose),
    checkModifierAttachment(prose),
  ];
}

export function normalizeCoverLetterParagraphs(paragraphs) {
  return Array.isArray(paragraphs)
    ? paragraphs.map(paragraph => String(paragraph || '').trim()).filter(Boolean)
    : [];
}

function sanitizeFilePart(s, fallback) {
  return sanitizeApplicationBundlePart(s, fallback);
}

// sanitizeApplicationBundlePart caps every part at 100 code points
// ([...cleaned].slice(0, 100), electron/ipc/applicationBundle.js:23) and
// does not re-export that number. resolveApplicationExportDirectory's
// disambiguation suffix (below) needs it to reserve room for the suffix
// BEFORE concatenating, not after — see that function for why.
const SANITIZED_PART_CAP = 100;

function isGenerationAuditObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function generationAuditHashMatches(value, data) {
  return data == null
    ? value == null
    : GENERATION_AUDIT_SHA256_RE.test(String(value || ''))
      && value === applicationArtifactSha256(data);
}

function inspectGenerationAuditData(data, {
  expectedVersion = GENERATION_AUDIT_VERSION,
  expectedJobId = null,
  expectedGenerationAuditRequired = null,
  expectedStagedArtifacts = null,
  expectedSavedArtifacts = null,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return {
      generationAuditParsed: false,
      generationAuditVersion: null,
      generationAuditVersionValid: false,
      generationAuditSchemaValid: false,
      generationAuditJobIdValid: false,
      generationAuditRequirednessValid: false,
      generationAuditStructureValid: false,
      generationAuditTopLevelKeysValid: false,
      generationAuditStagedArtifactsValid: false,
      generationAuditSavedArtifactsValid: false,
      generationAuditError: 'invalid JSON',
    };
  }
  const objectRoot = isGenerationAuditObject(parsed);
  const version = objectRoot ? parsed.version : null;
  const schemaValid = objectRoot && parsed.schema === GENERATION_AUDIT_SCHEMA;
  const jobIdValid = objectRoot && typeof parsed.jobId === 'string' && parsed.jobId.trim()
    && (!expectedJobId || parsed.jobId === expectedJobId);
  const unexpectedTopLevelKeys = objectRoot
    ? Object.keys(parsed).filter(key => !GENERATION_AUDIT_TOP_LEVEL_KEYS.has(key))
    : [];
  const requiredObjectKeys = [
    'scope', 'job', 'inputSummary', 'finalArtifacts',
    'coverLetterArgument', 'writerQualityReview', 'hostValidation',
    'measuredFit', 'handoff',
  ];
  const auditRequired = parsed?.inputSummary?.generationAuditRequired === true;
  const requirednessValid = typeof parsed?.inputSummary?.generationAuditRequired === 'boolean'
    && (typeof expectedGenerationAuditRequired !== 'boolean'
      || parsed.inputSummary.generationAuditRequired === expectedGenerationAuditRequired);
  const writerAuditValid = auditRequired
    ? isGenerationAuditObject(parsed?.writerAudit)
    : parsed?.writerAudit == null || isGenerationAuditObject(parsed?.writerAudit);
  const structureValid = objectRoot
    && typeof parsed.createdAt === 'string' && Boolean(parsed.createdAt.trim())
    && requiredObjectKeys.every(key => isGenerationAuditObject(parsed[key]))
    && writerAuditValid;
  const stagedArtifactsValid = !expectedStagedArtifacts || (isGenerationAuditObject(parsed?.finalArtifacts)
    && generationAuditHashMatches(parsed.finalArtifacts.stagedApplicationHtmlSha256, expectedStagedArtifacts.applicationHtml)
    && generationAuditHashMatches(parsed.finalArtifacts.resumePdfSha256, expectedStagedArtifacts.resumePdf)
    && generationAuditHashMatches(parsed.finalArtifacts.coverLetterPdfSha256, expectedStagedArtifacts.coverLetterPdf)
    && generationAuditHashMatches(parsed.finalArtifacts.originalJobListingSha256, expectedStagedArtifacts.jobListing));
  const savedArtifactsValid = !expectedSavedArtifacts || (isGenerationAuditObject(parsed?.savedArtifacts)
    && generationAuditHashMatches(parsed.savedArtifacts.applicationHtmlSha256, expectedSavedArtifacts.applicationHtml)
    && generationAuditHashMatches(parsed.savedArtifacts.resumePdfSha256, expectedSavedArtifacts.resumePdf)
    && generationAuditHashMatches(parsed.savedArtifacts.coverLetterPdfSha256, expectedSavedArtifacts.coverLetterPdf)
    && generationAuditHashMatches(parsed.savedArtifacts.originalJobListingSha256, expectedSavedArtifacts.jobListing));
  return {
    generationAuditParsed: objectRoot,
    generationAuditVersion: version ?? null,
    generationAuditVersionValid: objectRoot && version === expectedVersion,
    generationAuditSchemaValid: schemaValid,
    generationAuditJobIdValid: Boolean(jobIdValid),
    generationAuditRequirednessValid: requirednessValid,
    generationAuditStructureValid: structureValid,
    generationAuditTopLevelKeysValid: objectRoot && unexpectedTopLevelKeys.length === 0,
    generationAuditUnexpectedTopLevelKeys: unexpectedTopLevelKeys,
    generationAuditStagedArtifactsValid: stagedArtifactsValid,
    generationAuditSavedArtifactsValid: savedArtifactsValid,
    ...(!objectRoot ? { generationAuditError: 'root must be an object' } : {}),
  };
}

function assertGenerationAuditData(data, options = {}) {
  const inspection = inspectGenerationAuditData(data, options);
  if (!inspection.generationAuditParsed) {
    throw new Error(`Generation Audit.json is invalid: ${inspection.generationAuditError}.`);
  }
  if (!inspection.generationAuditVersionValid) {
    throw new Error(`Generation Audit.json has unsupported version “${String(inspection.generationAuditVersion)}”; expected ${GENERATION_AUDIT_VERSION}.`);
  }
  if (!inspection.generationAuditSchemaValid) {
    throw new Error(`Generation Audit.json must use schema “${GENERATION_AUDIT_SCHEMA}”.`);
  }
  if (!inspection.generationAuditJobIdValid) {
    throw new Error('Generation Audit.json does not belong to the registered Local AI job.');
  }
  if (!inspection.generationAuditRequirednessValid) {
    throw new Error('Generation Audit.json does not match the registered generation-audit requiredness contract.');
  }
  if (!inspection.generationAuditStructureValid) {
    throw new Error('Generation Audit.json is missing required app-owned sections.');
  }
  if (!inspection.generationAuditTopLevelKeysValid) {
    throw new Error(`Generation Audit.json contains unexpected top-level fields: ${inspection.generationAuditUnexpectedTopLevelKeys.join(', ')}.`);
  }
  if (!inspection.generationAuditStagedArtifactsValid) {
    throw new Error('Generation Audit.json does not match the registered staged application artifacts.');
  }
  if (!inspection.generationAuditSavedArtifactsValid) {
    throw new Error('Generation Audit.json does not match the final saved application artifacts.');
  }
  return JSON.parse(Buffer.from(data).toString('utf8'));
}

function finalizeGenerationAuditData(data, {
  expectedJobId,
  generationAuditRequired,
  stagedArtifacts,
  savedArtifacts,
} = {}) {
  const parsed = assertGenerationAuditData(data, {
    expectedJobId,
    expectedGenerationAuditRequired: generationAuditRequired,
    expectedStagedArtifacts: stagedArtifacts,
  });
  const finalized = {
    ...parsed,
    scope: {
      ...parsed.scope,
      hashSemantics: 'finalArtifacts records the validated producer-stage bytes; savedArtifacts records the exact durable sibling files after save-time transformations.',
    },
    savedArtifacts: {
      applicationHtmlSha256: applicationArtifactSha256(savedArtifacts?.applicationHtml),
      resumePdfSha256: applicationArtifactSha256(savedArtifacts?.resumePdf),
      coverLetterPdfSha256: applicationArtifactSha256(savedArtifacts?.coverLetterPdf),
      originalJobListingSha256: applicationArtifactSha256(savedArtifacts?.jobListing),
    },
  };
  return `${JSON.stringify(finalized, null, 2)}\n`;
}

function generationLogEventId(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Generation Log.jsonl ${label} must be a JSON object.`);
  }
  const jobId = String(entry.jobId || '').trim();
  const sequence = entry.sequence;
  if (!jobId || jobId.length > 120 || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Generation Log.jsonl ${label} must contain a jobId and nonnegative integer sequence.`);
  }
  return `${jobId}\u0000${sequence}`;
}

// The log identity deliberately excludes its clock value. A process can crash
// after appending an event and before recording the next manifest state; a
// retry can serialize the same JSON with a different object-key order (and a
// new timestamp). Preserve the original durable line in that case, while
// still rejecting a genuinely conflicting event for the stable identity.
function canonicalGenerationLogEvent(entry) {
  if (Array.isArray(entry)) return `[${entry.map(canonicalGenerationLogEvent).join(',')}]`;
  if (entry && typeof entry === 'object') {
    return `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${canonicalGenerationLogEvent(entry[key])}`).join(',')}}`;
  }
  return JSON.stringify(entry);
}

function generationLogComparableEvent(entry) {
  const { at: _at, ...withoutTimestamp } = entry;
  return canonicalGenerationLogEvent(withoutTimestamp);
}

function parseGenerationLog(data, label) {
  if (data == null) return [];
  const text = Buffer.from(data).toString('utf8');
  const entries = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { throw new Error(`Generation Log.jsonl ${label} line ${index + 1} is not valid JSON.`); }
    entries.push({
      id: generationLogEventId(value, `${label} line ${index + 1}`),
      line,
      comparable: generationLogComparableEvent(value),
    });
  }
  return entries;
}

/**
 * Append newly staged app-owned generation events to the durable bundle log.
 * It runs while the destination lock is held, keeping concurrent saves from
 * dropping a revision. Stable jobId+sequence IDs make save retries idempotent.
 */
async function mergeApplicationGenerationLogs(destination, sourceData) {
  let existing = null;
  let handle;
  try {
    const expected = await fs.promises.lstat(destination);
    // The transaction below replaces a final-name symlink as a filesystem
    // object without following it. Treat it as no retained history here so a
    // legacy save can safely remove a stale link, and a paste save can safely
    // replace it with a new regular log file. Directories remain invalid.
    if (expected.isSymbolicLink()) {
      // A link cannot be trusted as prior history. The atomic replacement
      // either removes it (no staged log) or promotes a regular log beside
      // it, without ever opening its target.
      existing = null;
    } else if (!expected.isFile()) {
      throw new Error('Generation Log.jsonl destination must be a regular file.');
    } else {
      const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
      handle = await fs.promises.open(destination, fs.constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new Error('Generation Log.jsonl destination changed while it was being read.');
      }
      existing = await handle.readFile();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  const retained = parseGenerationLog(existing, 'destination');
  const appended = parseGenerationLog(sourceData, 'staged source');
  if (!retained.length && !appended.length) return null;
  const seen = new Map();
  const lines = [];
  for (const entry of [...retained, ...appended]) {
    if (seen.has(entry.id)) {
      if (seen.get(entry.id) !== entry.comparable) {
        throw new Error(`Generation Log.jsonl has conflicting content for stable event ${entry.id.replace('\u0000', ':')}.`);
      }
      continue;
    }
    seen.set(entry.id, entry.comparable);
    lines.push(entry.line);
  }
  const merged = `${lines.join('\n')}\n`;
  return merged;
}

export async function inspectApplicationExport(files) {
  const manifest = [];
  for (const file of files) {
    const row = {
      name: path.basename(file.path), expected: file.expected !== false,
      exists: false, readable: false, bytes: 0, mtimeMs: null,
      sourceExpected: file.expectedData != null,
    };
    try {
      const stat = await fs.promises.stat(file.path);
      row.exists = stat.isFile();
      row.bytes = stat.size;
      row.mtimeMs = stat.mtimeMs;
      if (row.exists) {
        const data = await fs.promises.readFile(file.path);
        row.readable = true;
        row.bytes = data.length;
        row.sha256 = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
        if (file.expectedData != null) {
          const expectedData = typeof file.expectedData === 'string'
            ? Buffer.from(file.expectedData, 'utf8')
            : Buffer.from(file.expectedData);
          row.matchesSource = data.equals(expectedData);
        }
        const kind = file.kind || (/\.pdf$/i.test(file.path) ? 'pdf' : /\.html?$/i.test(file.path) ? 'html' : /\.md$/i.test(file.path) ? 'markdown' : 'file');
        if (kind === 'pdf') {
          row.pdfHeaderValid = data.subarray(0, 5).toString('ascii') === '%PDF-';
          row.pdfParsed = false;
          if (row.pdfHeaderValid) {
            const pdf = await PDFDocument.load(data);
            row.pageCount = pdf.getPageCount();
            if (row.pageCount > 0) {
              const { width, height } = pdf.getPage(0).getSize();
              row.firstPagePoints = `${Math.round(width)}x${Math.round(height)}`;
              row.pdfParsed = true;
            }
          }
        } else if (kind === 'html') {
          const text = data.toString('utf8');
          const dom = new JSDOM(text);
          try {
            const document = dom.window.document;
            const resumePanels = document.querySelectorAll('[data-ic-document-panel="resume"]');
            const coverPanels = document.querySelectorAll('[data-ic-document-panel="cover"]');
            row.htmlPanelCount = resumePanels.length + coverPanels.length;
            let bundle = {};
            try { bundle = JSON.parse(document.getElementById('ic-application-bundle-data')?.textContent || '{}'); }
            catch { bundle = {}; }
            row.syncConfigValid = /^http:\/\/127\.0\.0\.1:\d+\/application-sync$/.test(String(bundle?.sync?.endpoint || ''))
              && /^[a-f0-9]{64}$/i.test(String(bundle?.sync?.token || ''));
            row.htmlStructureValid = document.doctype?.name?.toLowerCase() === 'html'
              && document.documentElement?.tagName === 'HTML'
              && resumePanels.length === 1
              && coverPanels.length === 1
              && !!resumePanels[0].querySelector('main.page')
              && !!coverPanels[0].querySelector('main.page')
              && row.syncConfigValid;
          } finally {
            dom.window.close();
          }
        } else if (kind === 'markdown') {
          row.markdownNonEmpty = data.toString('utf8').trim().length > 0;
        } else if (kind === 'generation-audit') {
          Object.assign(row, inspectGenerationAuditData(data, {
            expectedVersion: file.expectedVersion ?? GENERATION_AUDIT_VERSION,
            expectedJobId: file.expectedJobId ?? null,
            expectedGenerationAuditRequired: file.expectedGenerationAuditRequired ?? null,
            expectedStagedArtifacts: file.expectedStagedArtifacts ?? null,
            expectedSavedArtifacts: file.expectedSavedArtifacts ?? null,
          }));
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') row.error = String(error?.message || error).slice(0, 300);
    }
    manifest.push(row);
  }
  const invalid = manifest.filter(row => row.expected
    ? (!row.exists || !row.readable || row.bytes <= 0
      || !row.sourceExpected || row.matchesSource !== true
      || row.pdfHeaderValid === false || row.pdfParsed === false
      || row.htmlStructureValid === false || row.markdownNonEmpty === false
      || row.generationAuditParsed === false || row.generationAuditVersionValid === false
      || row.generationAuditSchemaValid === false || row.generationAuditJobIdValid === false
      || row.generationAuditRequirednessValid === false
      || row.generationAuditStructureValid === false || row.generationAuditTopLevelKeysValid === false
      || row.generationAuditStagedArtifactsValid === false || row.generationAuditSavedArtifactsValid === false)
    : row.exists);
  if (invalid.length) throw new Error(`Application export readback failed for: ${invalid.map(row => row.name).join(', ')}`);
  for (const row of manifest) row.integrityVerified = row.expected
    ? row.sourceExpected && row.matchesSource === true
    : !row.exists;
  return manifest;
}

// Last application lifecycle record, captured for bug reports. Local AI imports
// record their result/hash/fit trace here; keeping it in memory makes rendering
// and export issues diagnosable without persisting extra candidate data.
let lastApplication = null;
export function getApplicationTelemetry() {
  return lastApplication;
}
// Exported for the deterministic bug-report fixtures. Production callers keep
// this private to the generation lifecycle below; tests use it to assert the
// report renders failed attempts just as faithfully as completed ones.
export function recordApplicationTelemetry(data) {
  if (data == null) {
    lastApplication = null;
    return;
  }
  lastApplication = { ts: Date.now(), ...data };
}

function updateApplicationTelemetryForAttempt(attemptId, changes = {}) {
  if (!attemptId || !lastApplication || lastApplication.attemptId !== attemptId) return false;
  recordApplicationTelemetry({ ...lastApplication, ...changes });
  return true;
}

/**
 * Resolve the ACTUAL directory one save should write into, disambiguating it
 * from a different job's already-saved bundle when the sanitized
 * company/location/title path collides.
 *
 * VERIFIED (filed bug report, 2026-09-24 13:08–13:10 UTC): two distinct job
 * cards — job c48be7de… (status: saved) and job eeb6303c… (status: failed) —
 * were both "Software Development Engineer 2, Amazon Kids, Amazon Kids @
 * Amazon" at "Toronto, Ontario, Canada", and sanitizeFilePart(company) /
 * sanitizeFilePart(location) / sanitizeFilePart(jobTitle) reduced them to the
 * identical destination directory. Had the second job's save reached this
 * far, it would have silently overwritten the first job's already-saved
 * Application.html / Resume.pdf / Cover Letter.pdf with no warning — it did
 * not happen here only because the second job failed earlier in the
 * pipeline, by chance, before reaching save.
 *
 * The identity this compares by is deliberately the ORIGINAL JOB LISTING
 * bytes about to be saved (formatOriginalJobListingMarkdown's output), not a
 * per-generation job id: queueLocalApplicationJob mints a brand-new id on
 * every call, including an intentional Local AI regeneration of a card
 * that is already 'saved' (canRegenerateLocalApplication in
 * src/utils/localAiApplicationLifecycle.js allows exactly that) — so an
 * id-keyed check would treat every ordinary regenerate-and-resave of the
 * SAME card as a different job and reshuffle its already-saved folder on
 * every save, which is the one thing the design constraint below forbids.
 * The job listing content, by contrast, is built from the card's OWN job
 * fields and is unchanged across a regeneration (only the AI's résumé/letter
 * output differs); a genuinely different job posting almost always differs
 * somewhere in that text (title, company, location, url, or description),
 * even when it happens to sanitize to the identical file-path.
 *
 * Regenerating and re-saving THE SAME job must keep landing on its existing
 * folder: that folder is reported back to the card as its "Saved to …" state
 * and drives the discard/cleanup pairing, so relocating it on every save
 * would break both. A destination whose own saved "Original Job Listing.md"
 * already matches these exact bytes is a re-save of the same job and reuses
 * the folder unchanged; one whose saved listing differs is a genuine
 * collision and gets a deterministic, listing-derived sibling folder
 * instead — one short enough to stay legible, widened once if even that
 * exact suffix happens to already belong to a THIRD distinct job. A
 * destination with no readable listing at all (nothing saved there yet, or a
 * folder predating this check, or one this save cannot itself compare
 * against) is left exactly as it is today — not treated as a collision — so
 * nothing already on disk gets reshuffled the next time it is resaved; only
 * a job this function CAN identify is protected from silently replacing a
 * different one.
 *
 * The check above and the write it gates are only atomic if the CALLER holds
 * a lock across both, keyed on `baseDir` (the deterministic sanitized path,
 * before disambiguation) — this function only ever reads what is on disk at
 * the instant it is called, so two unsynchronized calls for two different
 * jobs that share a baseDir can both observe it as empty/matching and both
 * "safely" choose it. See save-application's own comment at its call site.
 *
 * Returns `{ dir, abandonedCandidates }`: every candidate directory this
 * call created-or-touched (via ensureCandidateDir) that was NOT the one
 * returned. Every one of them is, by construction, non-empty (that is
 * exactly why it was rejected — see collidesWithADifferentJob), so it is
 * always safe for the caller to best-effort prune them: a real occupant is
 * never at risk, and this only ever removes a candidate the SAME resolve
 * call itself created and then superseded.
 */
async function resolveApplicationExportDirectory(applicationOutputRoot, baseDir, currentJobListingData) {
  const currentListing = currentJobListingData == null ? null
    : Buffer.isBuffer(currentJobListingData) ? currentJobListingData : Buffer.from(currentJobListingData);
  const probedCandidates = [];
  // ensureDirectoryWithinRoot both creates a not-yet-existing candidate and
  // rejects one that escapes the root or traverses a symlink component, so
  // every readdir/readFile below runs only on an already-validated path —
  // never on a component this save has not itself proven safe.
  const ensureCandidateDir = async (candidateDir) => {
    await ensureDirectoryWithinRoot(applicationOutputRoot, candidateDir, {
      mode: 0o700,
      label: 'Application destination',
    });
    probedCandidates.push(candidateDir);
    return fs.promises.readdir(candidateDir);
  };
  const resolved = (dir) => ({ dir, abandonedCandidates: probedCandidates.filter(candidate => candidate !== dir) });
  if (!currentListing) {
    // No content to compare an occupant against or to disambiguate a
    // collision by — collision detection cannot run at all, so this falls
    // back to exactly the pre-existing behavior (reuse the sanitized path
    // as-is). Never expected in practice: registerPendingApplicationWorkspace
    // requires a job listing for every registered workspace.
    await ensureCandidateDir(baseDir);
    return resolved(baseDir);
  }
  const collidesWithADifferentJob = async (candidateDir) => {
    const entries = await ensureCandidateDir(candidateDir);
    if (entries.length === 0) return false; // Freshly created, or a pruned failed save.
    let occupantListing;
    try {
      occupantListing = await fs.promises.readFile(path.join(candidateDir, 'Original Job Listing.md'));
    } catch (error) {
      if (error?.code === 'ENOENT') return false; // No readable listing — see the comment above.
      throw error;
    }
    return !occupantListing.equals(currentListing);
  };
  if (!(await collidesWithADifferentJob(baseDir))) return resolved(baseDir);
  const baseName = path.basename(baseDir);
  for (const hexLength of [8, 16]) {
    const suffix = crypto.createHash('sha256').update(currentListing).digest('hex').slice(0, hexLength);
    const suffixWrapper = ` (${suffix})`;
    // Reserve room for the suffix BEFORE sanitizeFilePart's cap runs, not
    // after: concatenating an already-100-code-point baseName with
    // suffixWrapper and letting the CONCATENATED result get re-capped to 100
    // chops the suffix off instead of the (already over-length) base — at
    // exactly 100 base chars both hexLength candidates below collapsed onto
    // the identical, still-colliding name and a genuinely resolvable
    // collision hard-failed (filed report: "Software Development Engineer 2,
    // Amazon Kids, Amazon Kids" is long enough to hit this). Slicing by code
    // point (not by UTF-16 unit) matches sanitizeApplicationBundlePart's own
    // [...cleaned].slice(...), so a surrogate pair is never split either.
    const truncatedBase = [...baseName].slice(0, Math.max(0, SANITIZED_PART_CAP - suffixWrapper.length)).join('');
    const disambiguated = path.join(path.dirname(baseDir), sanitizeFilePart(`${truncatedBase}${suffixWrapper}`, `Application (${suffix})`));
    if (!(await collidesWithADifferentJob(disambiguated))) return resolved(disambiguated);
  }
  throw new Error('A different job’s saved application already occupies this destination, and no distinct folder name could be found for this job either.');
}

// Test seam: exercises collision resolution and disambiguation directly —
// including the abandonedCandidates it hands back for cleanup — without
// registering a pending workspace or driving a full save through the IPC
// handler. Does NOT reproduce the save-application call site's own
// baseDir-keyed lock; a caller testing that atomicity must go through the
// real 'save-application' handler instead (see resume-download-bundle.js).
export function __resolveApplicationExportDirectoryForTests(applicationOutputRoot, baseDir, currentJobListingData) {
  return resolveApplicationExportDirectory(applicationOutputRoot, baseDir, currentJobListingData);
}

export function registerJobApplicationHandlers() {
  // A card may be deleted after generation has produced a registered temp
  // workspace but before the renderer can save it.  Dispose of that exact
  // sender-owned workspace without accepting arbitrary filesystem paths.
  handleSafe('discard-application', async (event, { workDir } = {}) => {
    const { resolvedWorkDir, pending } = resolvePendingApplicationWorkspaceForOwner(
      workDir, pendingApplicationArtifacts, event.sender.id,
    );
    if (pending.saveInFlight) {
      const error = new Error('This generated application workspace is currently being saved.');
      error.code = 'APPLICATION_SAVE_IN_FLIGHT';
      throw error;
    }
    await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'renderer discard');
    logger.info('[JobApplication] Discarded generated application workspace before save');
    return { discarded: true };
  });

  // Write the generated documents into
  // "Applied Jobs/<company>/<location>/<job>" next to the SAVED canvas file,
  // then open that folder in Finder. No picker — the location is deterministic
  // so the user's applications stay organized with the project. Cleans up the
  // temp working directory afterward.
  handleSafe('save-application', async (event, { resumeHtmlPath, resumePdfPath, coverLetterPdfPath, jobListingPath, generationAuditPath, generationLogPath, workDir, jobTitle, location, canvasFilePath, suppressReveal = false }) => {
    const { resolvedWorkDir, pending } = resolvePendingApplicationWorkspaceForOwner(
      workDir, pendingApplicationArtifacts, event.sender.id,
    );
    const matchesPending = path.resolve(String(resumeHtmlPath || '')) === pending.resumeHtmlPath
      && path.resolve(String(jobListingPath || '')) === pending.jobListingPath
      && (resumePdfPath ? path.resolve(resumePdfPath) : null) === pending.resumePdfPath
      && (coverLetterPdfPath ? path.resolve(coverLetterPdfPath) : null) === pending.coverLetterPdfPath
      && (generationAuditPath ? path.resolve(generationAuditPath) : null) === pending.generationAuditPath
      && (generationLogPath ? path.resolve(generationLogPath) : null) === pending.generationLogPath;
    if (!matchesPending) {
      throw new Error('Generated application paths did not match this generation session — please regenerate.');
    }
    // Claim synchronously, before the first await below. Electron can dispatch
    // two invokes in the same turn; without this flag both resolve the same
    // one-shot Map entry and independently save/callback before cleanup runs.
    if (pending.saveInFlight) {
      const error = new Error('This generated application workspace is already being saved.');
      error.code = 'APPLICATION_SAVE_IN_FLIGHT';
      throw error;
    }
    pending.saveInFlight = true;
    resumeHtmlPath = pending.resumeHtmlPath;
    resumePdfPath = pending.resumePdfPath;
    coverLetterPdfPath = pending.coverLetterPdfPath;
    jobListingPath = pending.jobListingPath;
    generationAuditPath = pending.generationAuditPath;
    generationLogPath = pending.generationLogPath;
    const company = pending.company;
    let exportPhase = 'validating generated sources';
    let exportDir = null;
    let exportRoot = null;
    try {
    // Local-AI workspaces bind this one-shot save capability to the exact
    // result bytes that were rendered. Recheck after the synchronous claim and
    // before creating or changing anything in the destination bundle.
    if (pending.onBeforeSave) {
      exportPhase = 'verifying current generated result';
      await pending.onBeforeSave({ workDir: resolvedWorkDir });
    }
    // The destination is relative to the canvas JSON, so it must be saved first.
    if (!canvasFilePath || typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath)) {
      throw new Error('Save your canvas to a file first — applications are written to an "Applied Jobs" folder next to your saved canvas.');
    }

    const where = sanitizeFilePart(company, 'Company');
    // Location is a hard part of job identity (§6.3) but here it's just a path
    // segment — a missing/unresolvable value degrades to a sane folder name
    // rather than collapsing the path (e.g. "Company//Role" if left empty).
    const whereLocation = sanitizeFilePart(location, 'Unknown Location');
    const role = sanitizeFilePart(jobTitle, 'Role');
    // Local AI registers a pre-validated project-relative root chosen in its
    // editable provider-neutral routine. The canvas-adjacent root remains a safe
    // compatibility fallback for an already-registered workspace.
    let applicationOutputRoot;
    if (pending.applicationRoot) {
      const registeredRoot = path.resolve(pending.applicationRoot);
      applicationOutputRoot = await ensureDirectoryWithinRoot(registeredRoot, registeredRoot, {
        mode: 0o700,
        label: 'Registered Local AI application root',
      });
    } else {
      let canvasStat;
      try { canvasStat = await fs.promises.lstat(canvasFilePath); }
      catch { throw new Error('The saved canvas is no longer available — save it again before exporting the application.'); }
      if (!canvasStat.isFile() || canvasStat.isSymbolicLink()) {
        throw new Error('The application destination requires a regular saved canvas file, not a link.');
      }
      const canonicalCanvasFile = await fs.promises.realpath(canvasFilePath);
      const canvasRoot = path.dirname(canonicalCanvasFile);
      applicationOutputRoot = await ensureDirectoryWithinRoot(canvasRoot, path.join(canvasRoot, 'Applied Jobs'), {
        mode: 0o700,
        label: 'Applied Jobs folder',
      });
    }
    const listingSource = jobListingPath || (workDir ? path.join(workDir, 'original-job-listing.md') : '');
    // A quick, unverified peek at the job listing's current bytes, read
    // before the destination directory below is resolved. This is
    // deliberately separate from the sha256-verified, workspace-bound read of
    // the same file in the Promise.all further down — that authoritative read
    // still runs in its existing position and still decides whether the save
    // itself succeeds. A miss or an error here only means
    // resolveApplicationExportDirectory cannot compare content, so it leaves
    // collision detection off for this save (see its own comment) rather than
    // surfacing a second, earlier failure for the same file.
    let precheckJobListingData = null;
    if (listingSource) {
      try { precheckJobListingData = await fs.promises.readFile(listingSource); }
      catch { precheckJobListingData = null; }
    }
    const baseDir = path.join(applicationOutputRoot, where, whereLocation, role);
    exportRoot = applicationOutputRoot;
    // Collision resolution and the destination write must be ONE atomic unit
    // under a single lock keyed on this deterministic BASE path (the
    // sanitized company/location/title, before disambiguation) — not on
    // whichever directory resolveApplicationExportDirectory ends up
    // choosing. That function's occupant check only reads whatever is on
    // disk at the instant it runs, so resolving it outside a lock (the prior
    // design) left the read-then-decide window unlocked: two concurrent
    // saves of two DIFFERENT jobs sharing this baseDir could both observe
    // the destination as empty or matching and both "safely" choose to
    // write there, and the later writer would silently overwrite the
    // earlier one's already-saved bundle — exactly the collision this whole
    // mechanism exists to close (see resolveApplicationExportDirectory's own
    // header). The dock runs up to 10 handoffs concurrently, so that window
    // is reachable, not theoretical. Locking only the final write (below, as
    // before) closed nothing: both savers would already have committed to
    // the same `dir` before either one ever reached it.
    let dir, applicationFile, resumeFile, coverLetterFile, jobListingFile,
      generationAuditFile, generationLogFile, hasPdf, hasCoverLetterPdf,
      hasListing, hasGenerationAudit;
    const manifest = await withApplicationSyncWorkspaceLock(baseDir, async () => {
    // resolveApplicationExportDirectory both validates/creates whichever
    // candidate it returns and disambiguates it from a different job's
    // bundle already sitting at the sanitized path — see its own comment for
    // the collision this closes. No separate ensureDirectoryWithinRoot call
    // is needed here: every candidate it inspects is validated internally.
    const resolution = await resolveApplicationExportDirectory(applicationOutputRoot, baseDir, precheckJobListingData);
    dir = resolution.dir;
    exportDir = dir;
    // Best-effort: remove any sibling candidate this resolution touched but
    // did not choose, if it is still empty. resolveApplicationExportDirectory
    // guarantees every one of them is non-empty BY CONSTRUCTION (that is why
    // it was rejected), so this can only ever remove a directory THIS exact
    // attempt created and then superseded — never another job's real bundle.
    // pruneEmptyExportDirectories in the catch block below already covers
    // the chosen `dir` on a FAILED save; this covers every OTHER probed
    // candidate, regardless of how this save ultimately turns out.
    await Promise.all(resolution.abandonedCandidates.map(
      candidate => pruneEmptyExportDirectories(applicationOutputRoot, candidate),
    ));

    applicationFile = path.join(dir, 'Application.html');
    resumeFile = path.join(dir, 'Resume.pdf');
    coverLetterFile = path.join(dir, 'Cover Letter.pdf');
    jobListingFile = path.join(dir, 'Original Job Listing.md');
    generationAuditFile = path.join(dir, 'Generation Audit.json');
    generationLogFile = path.join(dir, 'Generation Log.jsonl');
    exportPhase = 'reading generated artifacts';
    const registeredReadOptions = {
      workspaceIdentity: pending.workspaceIdentity,
    };
    const [sourceHtml, sourceResumePdfData, sourceCoverLetterPdfData, jobListingData, generationAuditData, generationLogData] = await Promise.all([
      readRegisteredApplicationArtifact(resolvedWorkDir, resumeHtmlPath, {
        ...registeredReadOptions,
        encoding: 'utf8',
        expectedSha256: pending.artifactSha256?.resumeHtml,
      }),
      resumePdfPath ? readRegisteredApplicationArtifact(resolvedWorkDir, resumePdfPath, {
        ...registeredReadOptions,
        optional: true,
        expectedSha256: pending.artifactSha256?.resumePdf,
      }) : null,
      coverLetterPdfPath ? readRegisteredApplicationArtifact(resolvedWorkDir, coverLetterPdfPath, {
        ...registeredReadOptions,
        optional: true,
        expectedSha256: pending.artifactSha256?.coverLetterPdf,
      }) : null,
      listingSource ? readRegisteredApplicationArtifact(resolvedWorkDir, listingSource, {
        ...registeredReadOptions,
        optional: true,
        expectedSha256: pending.artifactSha256?.jobListing,
      }) : null,
      generationAuditPath ? readRegisteredApplicationArtifact(resolvedWorkDir, generationAuditPath, {
        ...registeredReadOptions,
        encoding: 'utf8',
        expectedSha256: pending.artifactSha256?.generationAudit,
      }) : null,
      generationLogPath ? readRegisteredApplicationArtifact(resolvedWorkDir, generationLogPath, {
        ...registeredReadOptions,
        encoding: 'utf8',
        expectedSha256: pending.artifactSha256?.generationLog,
      }) : null,
    ]);
    if (generationAuditData != null) {
      assertGenerationAuditData(generationAuditData, {
        expectedJobId: pending.generationAuditJobId,
        expectedGenerationAuditRequired: pending.generationAuditRequired,
        expectedStagedArtifacts: {
          applicationHtml: sourceHtml,
          resumePdf: sourceResumePdfData,
          coverLetterPdf: sourceCoverLetterPdfData,
          jobListing: jobListingData,
        },
      });
    }
    const [resumePdfData, coverLetterPdfData] = await Promise.all([
      ensureGeneratedApplicationPdf({ html: sourceHtml, pdf: sourceResumePdfData, documentKind: 'resume' }),
      ensureGeneratedApplicationPdf({ html: sourceHtml, pdf: sourceCoverLetterPdfData, documentKind: 'cover' }),
    ]);
    hasPdf = resumePdfData != null;
    hasCoverLetterPdf = coverLetterPdfData != null;
    hasListing = jobListingData != null;
    hasGenerationAudit = generationAuditData != null;
    // Embed a fresh capability before the transaction, but do not revoke the
    // previous saved workspace until every file has been promoted and passed
    // readback. Registration runs inside the transaction verifier, so a
    // persistence failure rolls the visible bundle back too.
    const syncToken = crypto.randomBytes(32).toString('hex');
    const sync = applicationSyncConfig(syncToken, {
      html: sourceHtml,
      resumePdf: resumePdfData,
      coverPdf: coverLetterPdfData,
    });
    const generatedHtml = embedApplicationSyncConfig(sourceHtml, sync);
    const savedArtifactData = {
      applicationHtml: generatedHtml,
      resumePdf: resumePdfData,
      coverLetterPdf: coverLetterPdfData,
      jobListing: jobListingData,
    };
    const finalizedGenerationAuditData = generationAuditData == null
      ? null
      : finalizeGenerationAuditData(generationAuditData, {
        expectedJobId: pending.generationAuditJobId,
        generationAuditRequired: pending.generationAuditRequired,
        stagedArtifacts: {
          applicationHtml: sourceHtml,
          resumePdf: sourceResumePdfData,
          coverLetterPdf: sourceCoverLetterPdfData,
          jobListing: jobListingData,
        },
        savedArtifacts: savedArtifactData,
      });

    // The workspace is deliberately unzipped and predictable. Treat all six
    // siblings as one transaction: unavailable optional artifacts remove stale
    // predecessors, while any promotion/readback failure restores the complete
    // prior generation instead of leaving a mixed bundle.
    exportPhase = 'writing and verifying destination bundle';
    const writeBundle = async () => {
      const finalizedGenerationLogData = await mergeApplicationGenerationLogs(generationLogFile, generationLogData);
      return replaceApplicationBundleAtomically([
        { destination: applicationFile, data: generatedHtml },
        { destination: resumeFile, data: resumePdfData },
        { destination: coverLetterFile, data: coverLetterPdfData },
        { destination: jobListingFile, data: jobListingData },
        { destination: generationAuditFile, data: finalizedGenerationAuditData },
        { destination: generationLogFile, data: finalizedGenerationLogData },
      ], {
        verify: async () => {
          const readback = await inspectApplicationExport([
            { path: applicationFile, expected: true, expectedData: generatedHtml, kind: 'html' },
            { path: resumeFile, expected: hasPdf, expectedData: resumePdfData, kind: 'pdf' },
            { path: coverLetterFile, expected: hasCoverLetterPdf, expectedData: coverLetterPdfData, kind: 'pdf' },
            { path: jobListingFile, expected: hasListing, expectedData: jobListingData, kind: 'markdown' },
            {
              path: generationAuditFile,
              expected: hasGenerationAudit,
              expectedData: finalizedGenerationAuditData,
              kind: 'generation-audit',
              expectedVersion: GENERATION_AUDIT_VERSION,
              expectedJobId: pending.generationAuditJobId,
              expectedGenerationAuditRequired: pending.generationAuditRequired,
              expectedStagedArtifacts: {
                applicationHtml: sourceHtml,
                resumePdf: sourceResumePdfData,
                coverLetterPdf: sourceCoverLetterPdfData,
                jobListing: jobListingData,
              },
              expectedSavedArtifacts: savedArtifactData,
            },
            {
              path: generationLogFile,
              expected: finalizedGenerationLogData != null,
              expectedData: finalizedGenerationLogData,
              kind: 'generation-log',
            },
          ]);
          await registerApplicationSyncWorkspace(dir, syncToken);
          return readback;
        },
      });
    };
    // `dir` equals `baseDir` whenever this save did not need to disambiguate
    // (the common case) — the outer acquire above already serializes that
    // exact key, and calling withApplicationSyncWorkspaceLock again with the
    // SAME key from inside its own still-pending callback would await a
    // tail that cannot settle until this very callback returns: a permanent
    // self-deadlock. Only a genuinely disambiguated `dir` (a different key)
    // needs its own acquire here, to still serialize against a Sync edit
    // already in flight on that sibling job's existing saved folder.
    return dir === baseDir ? await writeBundle() : await withApplicationSyncWorkspaceLock(dir, writeBundle);
    });
    const missingFiles = [!hasPdf && 'résumé PDF', !hasCoverLetterPdf && 'cover-letter PDF', !hasListing && 'original job listing'].filter(Boolean);
    const syncStatus = applicationSyncStatusSnapshot();
    const bundleWarnings = [
      missingFiles.length ? `Saved the editable workspace, but the ${missingFiles.join(', ')} was unavailable.` : '',
      !syncStatus.serverListening ? 'The local Sync service is unavailable; relaunch Infinite Canvas before editing and syncing this workspace.' : '',
    ].filter(Boolean);
    const bundleError = bundleWarnings.length ? bundleWarnings.join(' ') : null;
    if (bundleError) logger.warn(`[JobApplication] ${bundleError}`);

    // Local-AI handoffs use this app-owned callback to publish their terminal
    // receipt. It runs only after the destination transaction passed readback,
    // but before intermediate cleanup can remove the Local-AI job folder.
    // The writer's helper checks the receipt before the folder, so this order
    // cannot briefly report a durable save as an unconfirmed vanished job.
    // For Local AI this receipt is the only hash-bound terminal response the
    // waiting writer can observe. If publication fails, enter the normal
    // failure path before cleanup: the destination stays durable, while the
    // retained source workspace can publish retry evidence and try again.
    if (pending.onSuccessfulSave) {
      exportPhase = 'publishing terminal handoff receipt';
      await pending.onSuccessfulSave({ dir, manifest });
    }

    // Clean up the temporary output dir only after the terminal callback had
    // its chance to publish durable handoff evidence.
    exportPhase = 'cleaning generated source workspace';
    await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'successful save');

    // A visible card save reveals its destination as a convenience.  An
    // orphaned Local AI handoff has no card (and may finish while the user is
    // working elsewhere), so its recovery path explicitly suppresses this
    // focus-stealing side effect.
    const revealSkipped = suppressReveal || isBackgroundE2E();
    let openErr = '';
    if (!revealSkipped) {
      try { openErr = await shell.openPath(dir); }
      catch (error) { openErr = String(error?.message || error); }
    }
    if (openErr) logger.warn(`[JobApplication] Could not open ${dir}: ${openErr}`);

    updateApplicationTelemetryForAttempt(pending.attemptId, {
      applicationExport: {
        status: 'saved', destination: dir, savedAt: Date.now(), manifest,
        bundleError,
        revealSucceeded: revealSkipped ? null : !openErr,
        revealError: openErr || null,
        revealSkipped,
        integrityVerified: manifest.every(item => item.integrityVerified),
        sync: {
          registered: true,
          serverListening: syncStatus.serverListening,
          serverStarting: syncStatus.serverStarting,
          endpoint: syncStatus.endpoint,
          error: syncStatus.lastError,
        },
      },
    });
    logger.info(`[JobApplication] Saved unzipped application workspace to ${dir}`);
    return {
      saved: true,
      dir,
      applicationFile,
      resumeFile: hasPdf ? resumeFile : null,
      coverLetterFile: hasCoverLetterPdf ? coverLetterFile : null,
      jobListingFile: hasListing ? jobListingFile : null,
      generationAuditFile: hasGenerationAudit ? generationAuditFile : null,
      generationLogFile: manifest.some(row => row.name === 'Generation Log.jsonl' && row.expected) ? generationLogFile : null,
      bundleError,
    };
    } catch (error) {
      updateApplicationTelemetryForAttempt(pending.attemptId, {
        applicationExport: {
          status: 'failed', destination: exportDir, failedAt: Date.now(),
          phase: exportPhase, error: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 800),
        },
      });
      logger.error(`[JobApplication] save-application failed during "${exportPhase}": ${error?.stack || error?.message || error}`);
      // Telemetry above has already recorded the destination this attempt
      // chose, so the empty tree has nothing left to report and a retry
      // recreates it deterministically.
      await pruneEmptyExportDirectories(exportRoot, exportDir);
      // A Local-AI import has already consumed and measured one exact result
      // hash before this follow-up save begins. Give that trusted producer a
      // best-effort failure hook so it can publish hash-bound retry evidence;
      // otherwise the same hash becomes importable again when the short save
      // window lapses and silently repeats the full render/save cycle forever.
      const localAiResultChanged = error?.code === 'LOCAL_AI_RESULT_CHANGED';
      const sourceCleanupFailed = error?.code === 'APPLICATION_WORKSPACE_CLEANUP_FAILED';
      if (!localAiResultChanged && !sourceCleanupFailed && pending.onSaveFailure) {
        try { await pending.onSaveFailure({ phase: exportPhase, error }); }
        catch (callbackError) {
          logger.warn(`[JobApplication] Could not publish application save failure: ${callbackError?.message || callbackError}`);
        }
      }
      // Non-retryable trusted workspaces are removed after a terminal save
      // failure. Local-AI jobs opt out: their result/context remains on disk
      // for the explicit app-side retry published by the callback (with the
      // imported-window timeout still covering a failed callback/crash).
      // Validation failures above this try block deliberately discard nothing,
      // so a malformed IPC request can never erase a valid session it does not
      // own.
      if (pending.cleanupOnSaveFailure && !localAiResultChanged && !sourceCleanupFailed) {
        await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'terminal save failure');
      } else {
        // Release the one-shot capability without deleting the Local-AI job.
        // A retry revalidates and registers a new capability for these exact
        // result bytes; automatic status polling remains parked.
        pendingApplicationArtifacts.delete(resolvedWorkDir);
        logger.warn(`[JobApplication] Preserved retryable Local AI workspace after ${
          localAiResultChanged ? 'its result changed' : sourceCleanupFailed ? 'source cleanup failure' : 'save failure'
        }`);
      }
      throw error;
    }
  });
}
