import electronPkg from 'electron';
const { app } = electronPkg;
import fs from 'fs';
import path from 'path';
import { getJobsTelemetry, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS } from '../jobs.js';
import { getNonApiAiHandoffLifecycle } from '../nonApiAi.js';
import { getApplicationTelemetry } from '../jobApplication.js';
import { getApplicationSyncTelemetry } from '../applicationSync.js';
import { getManualScraperTelemetry } from '../browser/manualScraper.js';
import { getJobsSettings, getGlassdoorLocIdCache, hasStoredDiceApiKey } from '../settings.js';
import { modelResolutionSnapshot } from '../modelResolver.js';
import { getJobAnalysisPaths, snapshotOwnedByCanvas } from '../jobAnalysisPaths.js';
import { readLastRunReceiptSync, sanitizeLastRunReceipt } from '../jobRunStaging.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { isGoogleJobsInternalUrl } from '../../../src/utils/jobListingUrl.js';
import { ago, modelTag, pipelineScope, formatAge, redactReportUrl, redactReportUrlsInText } from './helpers.js';
import { classifyUnparseableSalary, hasMojibake, mojibakeExcerpt } from './jobQualityChecks.js';
// The real annualizer the app buckets jobs with (JobSearchNode's Job Tree +
// electron/ipc/jobs.js both use it) — imported directly rather than
// reimplemented so the bug report's salary field-quality signal can never
// drift from what the app actually does with a salary string. Cross-boundary
// import into electron/ from src/ is an established pattern (electron/ipc/
// jobs.js line ~50 already does the same for this exact module).
import { parseSalaryToNumeric } from '../../../src/nodes/jobsearch/buildJobTree.js';
import { JOB_COLLECTION_PAGE_CEILING } from '../../../src/utils/jobCollectionLimits.js';
// Legacy/synthetic snapshots can still contain title-drop telemetry from older
// builds. Keep the old decision helper only to explain those historical rejected
// samples; current provider-trust runs do not execute a local title gate.
import { jobRelevanceRejection } from '../../extractors/apiExtractors.js';

export function buildJobsConfigSnapshot() {
  let jobs = {};
  try { jobs = getJobsSettings() || {}; } catch { /* settings store may not be ready */ }

  const usajobsKey = jobs.usajobsApiKey;
  const usajobsEmail = jobs.usajobsEmail;
  const keyPrefix = usajobsKey ? `${String(usajobsKey).slice(0, 5)}…` : '(none)';

  return {
    hasUsajobsKey: !!usajobsKey,
    hasUsajobsEmail: !!usajobsEmail,
    usajobsKeyPrefix: keyPrefix,
    // A live key captured from dice.com, not the bootstrap default — the plain
    // getter never returns empty, so truthiness on it would always read green.
    hasCapturedDiceKey: hasStoredDiceApiKey(),
    testMode: {
      enabled: JOB_SEARCH_TEST_MODE.enabled,
      sourceId: JOB_SEARCH_TEST_MODE.sourceId || null,
      skipAI: JOB_SEARCH_TEST_MODE.skipAI || false,
    },
  };
}

function collectJobLinkRows(nodes) {
  const rows = [];
  const seenObjects = new WeakSet();
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (!Array.isArray(value)) {
      const source = String(value.source || '').trim().toLowerCase();
      const title = String(value.title || '').replace(/\s+/g, ' ').trim();
      const looksLikeJob = source && title && (
        value.company != null || value.location != null || value.posted != null
        || value.matchScore != null || value.googleCardUrl != null
      );
      if (looksLikeJob) rows.push(value);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(nodes);
  const unique = new Map();
  for (const row of rows) {
    const key = [row.source, row.title, row.company, row.location, row.url || row.googleCardUrl]
      .map(value => String(value || '').trim())
      .join('\u0000');
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function googleLinkShape(row) {
  const publicUrl = String(row?.url || '').trim();
  const identityUrl = String(row?.googleCardUrl || publicUrl).trim();
  let parsed = null;
  try { parsed = new URL(identityUrl); } catch { /* reported below as invalid */ }
  const fragment = parsed ? new URLSearchParams(String(parsed.hash || '').replace(/^#/, '')) : null;
  const queryPresent = !!(parsed?.searchParams.get('q') || fragment?.get('htiq'));
  const idPresent = !!(parsed?.searchParams.get('htidocid') || fragment?.get('htidocid')
    || /(?:^|\/)docid=/i.test((() => { try { return decodeURIComponent(parsed?.hash || ''); } catch { return ''; } })()));
  return {
    publicMissing: !publicUrl,
    publicInternal: isGoogleJobsInternalUrl(publicUrl),
    direct: !!publicUrl && !isGoogleJobsInternalUrl(publicUrl),
    legacy: parsed?.searchParams.get('ibp') === 'htl;jobs',
    blankQuery: !!parsed && !queryPresent,
    missingId: !!parsed && !idPresent,
    webhp: parsed?.pathname === '/webhp',
    route: parsed ? `${parsed.hostname}${parsed.pathname}` : '(invalid)',
  };
}

/**
 * Compact structural listing-link audit for FULL/JOBLINK reports. Query and
 * fragment values are never rendered; only presence/route facts are exported.
 */
export function buildJobLinkSnapshot(nodes) {
  const rows = collectJobLinkRows(nodes);
  if (rows.length === 0) return '';
  const bySource = new Map();
  for (const row of rows) {
    const source = String(row.source || 'unknown').trim().toLowerCase() || 'unknown';
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(row);
  }
  const lines = [`- Unique job rows inspected: ${rows.length}`];
  for (const [source, sourceRows] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (source !== 'google') {
      const missing = sourceRows.filter(row => !String(row.url || '').trim()).length;
      lines.push(`- \`${source}\`: ${sourceRows.length} total · ${missing} missing public URL`);
      continue;
    }
    const shapes = sourceRows.map(row => ({ row, ...googleLinkShape(row) }));
    const count = field => shapes.filter(shape => shape[field]).length;
    lines.push(`- \`google\`: ${sourceRows.length} total · ${count('direct')} direct Apply-on URL(s) · ${count('publicInternal')} internal Google route(s) exposed as public · ${count('publicMissing')} missing public URL(s)`);
    lines.push(`  - Identity-route health: ${count('legacy')} legacy \`ibp=htl;jobs\` · ${count('blankQuery')} blank search query · ${count('missingId')} missing htidocid/docid · ${count('webhp')} \`/webhp\` route`);
    const affected = shapes.filter(shape => shape.publicInternal || shape.blankQuery || shape.webhp).slice(0, 3);
    for (const shape of affected) {
      const title = historyReportValue(shape.row.title, '(untitled)', 100);
      lines.push(`  - ⚠️ "${title.replace(/"/g, "'")}" — route \`${shape.route}\` · q=${shape.blankQuery ? 'empty' : 'present'} · htidocid=${shape.missingId ? 'missing' : 'present'} · public=${shape.publicInternal ? 'internal-google' : shape.publicMissing ? 'missing' : 'direct'}`);
    }
  }
  return `
## Job Listing Link Diagnostics
> Structural link health from the current canvas. Query/fragment values and tracking tokens are never exported. New Google rows should keep their internal card identity separate from the direct employer/apply URL.

${lines.join('\n')}
`;
}

// Recovery data deliberately lives beside a saved canvas rather than in the
// canvas itself: processing hub state is stripped during save so an interrupted
// run cannot reopen as a permanently-pending card.  This compact reader is
// intentionally independent of the in-memory jobs telemetry singleton, which
// is empty after an app restart — the precise time recovery evidence matters.
const JOB_RUN_MANIFEST_SUFFIX = '.jobs-run.json';
const JOB_RUN_STAGING_SUFFIX = '.jobs-staging.jsonl';
function recoveryPathsForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  const analysis = getJobAnalysisPaths(canvasFilePath, path.join(app.getPath('userData'), 'job-search'));
  return {
    manifest: path.join(dir, `${base}${JOB_RUN_MANIFEST_SUFFIX}`),
    staging: path.join(dir, `${base}${JOB_RUN_STAGING_SUFFIX}`),
    currentSnapshot: analysis.jsonPath,
    lastSuccessSnapshot: analysis.lastSuccessJsonPath,
    legacyCurrentSnapshot: analysis.legacyJsonPath,
    legacyLastSuccessSnapshot: analysis.legacyLastSuccessJsonPath,
  };
}

// Terminal receipts are deliberately compact, persisted independently of the
// manifest/staging pair, and read synchronously with the rest of this report.
// Run every on-disk object back through the staging module's whitelist before
// rendering: a support report must never turn a modified sidecar into a path
// for exporting a job, query, URL, prompt, response, profile, or error body.
function readLastRunReceiptSnapshot(canvasFilePath) {
  const raw = readLastRunReceiptSync(canvasFilePath);
  if (!raw) return { exists: false };
  const status = raw?.terminal?.status;
  const outcome = raw?.terminal?.outcome;
  if (!receiptIdentifier(raw.runId, '')
    || !['completed', 'failed', 'aborted'].includes(status)
    || !['zero', 'populated', 'collection-only', 'incomplete', 'unknown'].includes(outcome)) return { exists: true, invalid: true };
  const receipt = sanitizeLastRunReceipt(raw);
  return { exists: true, receipt };
}

function receiptIdentifier(value, fallback = 'not recorded') {
  const text = String(value || '').trim();
  // IDs in app-created receipts are UUID-like. Do not render arbitrary strings
  // from a file beside the canvas even though the persistence sanitizer kept
  // them for ownership checks.
  return /^[A-Za-z0-9_.:-]{1,180}$/.test(text) ? text : fallback;
}

function receiptTime(value) {
  const ts = Number(value);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : 'not recorded';
}

function receiptElapsed(startedAt, completedAt) {
  const start = Number(startedAt);
  const end = Number(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const ms = end - start;
  if (ms < 1_000) return ` · elapsed ${Math.round(ms)}ms`;
  if (ms < 60_000) return ` · elapsed ${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return ` · elapsed ${minutes}m${seconds}s`;
}

function receiptHubCorrelation(nodeId, currentNodeIds) {
  const safeId = receiptIdentifier(nodeId, '');
  if (!safeId) return 'hub identifier omitted';
  return currentNodeIds?.has?.(safeId)
    ? `hub \`${safeId}\` is present in this canvas`
    : `⚠️ hub \`${safeId}\` is not present in this canvas`;
}

function formatLastRunReceipt(receiptState, currentNodeIds, livePipeline) {
  if (!receiptState?.exists) {
    return '- Last terminal run receipt: absent — completion of any prior-process run is **unknown**; this build has no durable terminal evidence for it.';
  }
  if (receiptState.invalid || !receiptState.receipt) {
    return '- Last terminal run receipt: ⚠️ present but invalid — completion is **unknown**.';
  }

  const receipt = receiptState.receipt;
  const status = receipt.terminal?.status === 'completed'
    ? '✅ completed'
    : receipt.terminal?.status === 'failed'
      ? '❌ failed'
      : '⏹️ aborted';
  const outcome = receipt.terminal?.outcome === 'zero'
    ? 'zero score-ready jobs'
    : receipt.terminal?.outcome === 'populated'
      ? 'score-ready jobs retained'
      : receipt.terminal?.outcome === 'collection-only'
        ? 'collection-only; scoring intentionally skipped'
        : receipt.terminal?.outcome === 'incomplete'
          ? 'incomplete; no authoritative scored result'
      : 'result count unknown';
  const livePhase = livePipeline?.phase || null;
  const liveRunId = receiptIdentifier(livePipeline?.runId, '');
  const provenance = !livePhase
    ? 'previous-process receipt — live pipeline telemetry is unavailable in this process'
    : liveRunId && liveRunId === receipt.runId
      ? `this-process receipt — live pipeline phase \`${String(livePhase).replace(/`/g, "'")}\` belongs to this run`
      : `prior/other-run receipt — this process retains an uncorrelated pipeline phase \`${String(livePhase).replace(/`/g, "'")}\`${liveRunId ? ` for run \`${liveRunId}\`` : ''}`;
  const cleanup = receipt.cleanup?.attempted
    ? receipt.cleanup.cleared === true
      ? 'staging cleanup cleared'
      : receipt.cleanup.cleared === false
        ? '⚠️ staging cleanup attempted but not cleared'
        : 'staging cleanup attempted; result not recorded'
    : 'staging cleanup was not attempted';
  const lines = [
    `- Last terminal run receipt: ${status} · ${outcome} · run \`${receiptIdentifier(receipt.runId)}\` · started ${receiptTime(receipt.startedAt)} · ended ${receiptTime(receipt.completedAt)}${receiptElapsed(receipt.startedAt, receipt.completedAt)} · ${receipt.stagingStarted ? 'staging started' : 'staging not recorded'} · ${cleanup} · ${receiptHubCorrelation(receipt.nodeId, currentNodeIds)} · ${provenance}`,
  ];

  const funnel = receipt.funnel;
  if (funnel) {
    lines.push(`  - Funnel: ${funnel.raw} raw → ${funnel.deduped} deduped → ${funnel.kept} kept · dropped: relevance ${funnel.relevanceDropped}, age ${funnel.ageDropped}, role ${funnel.roleDropped}, history ${funnel.historyDropped}, description evidence ${funnel.descriptionEvidenceDropped}`);
  }
  const sources = Object.entries(receipt.sources || {});
  if (sources.length) {
    const rows = sources.map(([sourceId, source]) => {
      const parts = [`${source.count} returned`, `${source.providerGathered} provider-gathered`, `${source.relevanceDropped} relevance-dropped`];
      if (source.sponsoredDropped) parts.push(`${source.sponsoredDropped} sponsored-dropped`);
      if (source.stopReason) parts.push(`stop ${receiptIdentifier(source.stopReason, 'omitted')}`);
      if (source.warning?.code) parts.push(`warning ${receiptIdentifier(source.warning.code, 'omitted')}${source.warning.severity ? ` (${receiptIdentifier(source.warning.severity, 'omitted')})` : ''}`);
      return `\`${receiptIdentifier(sourceId, 'unknown')}\`: ${parts.join(' · ')}`;
    });
    lines.push(`  - Sources (${sources.length}): ${rows.join('; ')}`);
  }
  return lines.join('\n');
}

function readRecoveryText(filePath) {
  try {
    return { exists: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: true, errorCode: error?.code || 'READ_ERROR' };
  }
}

function parseRecoveryJson(filePath) {
  const read = readRecoveryText(filePath);
  if (!read.exists || read.errorCode) return read;
  try { return { ...read, value: JSON.parse(read.text) }; }
  catch { return { ...read, parseError: true }; }
}

function recoveryTimestampLabel(value) {
  // Snapshots persist ISO strings while run staging persists epoch milliseconds.
  // Coerce both formats before handing the value to formatAge; Number(ISO) is
  // NaN and previously made every healthy saved snapshot read "not recorded".
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? formatAge(timestamp) : 'not recorded';
}

function recoveryCanvasCorrelation(recordedCanvasPath, canvasFilePath) {
  if (!recordedCanvasPath) return 'canvas not recorded';
  try {
    return path.resolve(recordedCanvasPath) === path.resolve(canvasFilePath)
      ? 'canvas matches this report'
      : '⚠️ canvas differs from this report';
  } catch {
    return 'canvas correlation unavailable';
  }
}

function recoveryHubCorrelation(nodeId, currentNodeIds) {
  if (!nodeId) return 'hub not recorded';
  return currentNodeIds?.has?.(nodeId)
    ? `hub \`${nodeId}\` is present in this canvas`
    : `⚠️ hub \`${nodeId}\` is not present in this canvas`;
}

function profileCountLabel(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return 'profile absent';
  const fields = Object.keys(profile).length;
  const roles = Array.isArray(profile.workHistory) ? profile.workHistory.length : 0;
  const skills = Array.isArray(profile.skills) ? profile.skills.length : 0;
  return `profile present (${fields} field(s) · ${roles} work-history row(s) · ${skills} skill(s))`;
}

function snapshotRecoveryLine(label, filePath, legacyFilePath, canvasFilePath, currentNodeIds) {
  let parsed = parseRecoveryJson(filePath);
  let legacyIgnored = false;
  const legacyIgnoredLabel = () => legacyIgnored ? ' · ⚠️ unowned legacy artifact ignored' : '';
  // New namespaced records take precedence. A legacy directory-scoped record
  // is a fallback only when it explicitly identifies this same saved canvas;
  // otherwise another canvas in the folder could leak stale recovery facts.
  if ((parsed.exists === false || parsed.parseError) && legacyFilePath) {
    const legacy = parseRecoveryJson(legacyFilePath);
    if (legacy.value && snapshotOwnedByCanvas(legacy.value, canvasFilePath)) {
      parsed = { ...legacy, legacyOwned: true };
    } else if (legacy.exists) {
      legacyIgnored = true;
    }
  }
  if (!parsed.exists) return `- ${label}: absent${legacyIgnoredLabel()}`;
  if (parsed.errorCode) return `- ${label}: ⚠️ unreadable (\`${parsed.errorCode}\`)${legacyIgnoredLabel()}`;
  if (parsed.parseError || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return `- ${label}: ⚠️ present but not parseable JSON${legacyIgnoredLabel()}`;
  }
  const snapshot = parsed.value;
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.length : 0;
  const sourceFoundRaw = Number(snapshot.sourceGatheredCount);
  const legacySourceFoundRaw = Number(
    snapshot.searchFunnel?.relevanceKept ?? snapshot.searchFunnel?.raw,
  );
  const sourceFoundCandidate = Number.isFinite(sourceFoundRaw)
    ? sourceFoundRaw
    : legacySourceFoundRaw;
  const sourceFound = Number.isFinite(sourceFoundCandidate)
    ? Math.max(jobs, Math.max(0, Math.floor(sourceFoundCandidate)))
    : jobs;
  const jobCountLabel = sourceFound !== jobs
    ? `${sourceFound} found → ${jobs} score-ready job(s)`
    : `${jobs} score-ready job(s)`;
  const recoveryJobs = Array.isArray(snapshot.descriptionRecoveryJobs) ? snapshot.descriptionRecoveryJobs.length : 0;
  const nodeId = snapshot.sourceHubId || snapshot.nodeId || null;
  const recordedCanvas = snapshot.canvasFilePath || snapshot.snapshotContext?.canvasFilePath || null;
  return `- ${label}: parseable${parsed.legacyOwned ? ' (legacy ownership verified)' : ''} · ${jobCountLabel} · ${recoveryJobs} recovery-pool job(s) · ${profileCountLabel(snapshot.profile)} · created ${recoveryTimestampLabel(snapshot.createdAt)} · run \`${snapshot.runId || 'not recorded'}\` · ${recoveryHubCorrelation(nodeId, currentNodeIds)} · ${recoveryCanvasCorrelation(recordedCanvas, canvasFilePath)}${legacyIgnoredLabel()}`;
}

/**
 * File-backed crash/quit recovery facts for FULL and the focused RECOVERY
 * report lens.  Never render a prompt, AI response, job title, or job body:
 * this is strictly metadata/counts required to establish whether a restart can
 * recover an interrupted collection/scoring handoff.
 */
export function buildJobRecoverySnapshot(canvasFilePath, currentNodeIds = new Set()) {
  const paths = recoveryPathsForCanvas(canvasFilePath);
  if (!paths) {
    return `
## Job Recovery Diagnostics
> Durable crash/quit-recovery metadata. Job contents and AI prompt/response text are never included.

- No saved canvas path is available, so canvas-scoped recovery sidecars cannot be inspected.
`;
  }

  const manifest = parseRecoveryJson(paths.manifest);
  const staging = readRecoveryText(paths.staging);
  const lastReceipt = readLastRunReceiptSnapshot(canvasFilePath);
  // There is no 'done' stage: a clean finish DELETES both sidecars, so "absent"
  // is the expected success state. Printed bare, it is indistinguishable from
  // "staging silently never ran" — the reading that sends the next investigation
  // at crash-recovery when nothing is wrong. The report already holds the
  // disambiguating fact (the pipeline's own phase); say which case this is.
  let livePipeline = null;
  try {
    const telemetry = getJobsTelemetry();
    // jobsTelemetry is process-global. Attribute it only when its owning hub is
    // present in this canvas; another window's completed run must not turn this
    // canvas's absent sidecars into a claimed clean finish.
    if (telemetry?.nodeId && currentNodeIds?.has?.(telemetry.nodeId)) {
      livePipeline = telemetry.pipeline || null;
    }
  } catch { /* telemetry may not be ready */ }
  const lastRunPhase = livePipeline?.phase || null;
  const cleanFinish = lastRunPhase === 'completed';
  const absentNote = cleanFinish
    ? ' — expected: a clean finish deletes both sidecars (there is no `done` stage), and this process\'s last pipeline phase is `completed`'
    : lastRunPhase
      ? ` — ⚠️ last pipeline phase in this process is \`${String(lastRunPhase).replace(/`/g, "'")}\`, not \`completed\`, so this is either a pre-restart run or staging did not write`
      : ' — no pipeline phase recorded in this process, so this cannot be attributed to a clean finish rather than staging never running';
  const lines = [];
  // The manifest/staging pair is intentionally removed after a clean finish.
  // The receipt is the sole durable answer for a prior-process run; render it
  // before the transient recovery artifacts so a reader does not mistake their
  // absence for either success or failure.
  lines.push(formatLastRunReceipt(lastReceipt, currentNodeIds, livePipeline));
  if (!manifest.exists) {
    lines.push(`- Run manifest: absent${absentNote}`);
  } else if (manifest.errorCode) {
    lines.push(`- Run manifest: ⚠️ unreadable (\`${manifest.errorCode}\`)`);
  } else if (manifest.parseError || !manifest.value || typeof manifest.value !== 'object' || Array.isArray(manifest.value)) {
    lines.push('- Run manifest: ⚠️ present but not parseable JSON');
  } else {
    const run = manifest.value;
    const sourceEntries = Object.entries(run.sources || {});
    const sourceSummary = sourceEntries
      .slice(0, 20)
      .map(([sourceId, source]) => `\`${sourceId}\`=${source?.status || 'unknown'}`)
      .join(', ');
    const extraSources = sourceEntries.length > 20 ? ` · ${sourceEntries.length - 20} more` : '';
    lines.push(`- Run manifest: parseable · stage **${String(run.stage || 'unknown').replace(/`/g, "'")}** · run \`${run.runId || 'not recorded'}\` · updated ${recoveryTimestampLabel(run.lastUpdated)} · ${recoveryHubCorrelation(run.inputs?.nodeId, currentNodeIds)} · canvas is this report`);
    lines.push(`- Sources (${sourceEntries.length}): ${sourceSummary || '(none recorded)'}${extraSources}`);
  }

  if (!staging.exists) {
    lines.push(`- Staging ledger: absent${cleanFinish ? ' — expected after a clean finish (see above)' : absentNote}`);
  } else if (staging.errorCode) {
    lines.push(`- Staging ledger: ⚠️ unreadable (\`${staging.errorCode}\`)`);
  } else {
    const rows = staging.text.split(/\r?\n/).filter(line => line.trim());
    let parsedRows = 0;
    let tornRows = 0;
    for (const row of rows) {
      try { JSON.parse(row); parsedRows += 1; } catch { tornRows += 1; }
    }
    lines.push(`- Staging ledger: present · ${parsedRows} parseable row(s) · ${tornRows} torn/unparseable row(s)`);
  }

  lines.push(snapshotRecoveryLine('Current saved scrape', paths.currentSnapshot, paths.legacyCurrentSnapshot, canvasFilePath, currentNodeIds));
  lines.push(snapshotRecoveryLine('Last successful saved scrape', paths.lastSuccessSnapshot, paths.legacyLastSuccessSnapshot, canvasFilePath, currentNodeIds));
  return `
## Job Recovery Diagnostics
> Durable crash/quit-recovery and terminal-run metadata read from the saved canvas directory. Job contents, search inputs, URLs, profile data, and AI prompt/response text are never included. A clean canvas state after restart is expected; the terminal receipt is the durable completion fact, while the manifest/staging sidecars determine whether recovery is possible.

${lines.join('\n')}
`;
}

/**
 * One source-progress entry as text. A paced source's repeated heartbeats are
 * folded by emitProgress into a single entry carrying a repeat count and a
 * last-seen offset — printing both is what separates "still working, last seen
 * 12s in" from "stopped emitting at +0s and never spoke again", which is the
 * whole question when a run looks stuck.
 *
 * Exported for unit testing (formatting is otherwise only reachable through a
 * full pipeline-snapshot render).
 */
export function formatSourceEvent(event) {
  const status = event?.status || 'unknown';
  const code = event?.code ? `⚠${event.code}` : '';
  const start = Math.round((event?.t || 0) / 1000);
  const lastSeen = event?.lastT == null ? start : Math.round(event.lastT / 1000);
  const span = lastSeen !== start ? `→+${lastSeen}s` : '';
  const repeats = event?.repeats > 1 ? ` ×${event.repeats}` : '';
  const detail = event?.detail ? ` (${historyReportValue(event.detail, '', 60)})` : '';
  return `${status}${code}@+${start}s${span}${repeats}${detail}`;
}

export function formatPipelineState(pipeline = {}) {
  if (pipeline.active) return '🔄 active';
  const phase = String(pipeline.phase || '').toLowerCase();
  if (phase === 'completed') return '✅ complete';
  if (phase === 'aborted' || phase === 'cancelled') return '⏹️ cancelled';
  if (phase.includes('fail') || phase === 'error') return '❌ failed';
  return '⚠️ stopped';
}

function handoffElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/**
 * Bounded process-local receipt for manual job-AI work. It deliberately names
 * lifecycle state only — never the prompt, pasted response, attachment path,
 * or validator error text — so an exported bug report can establish whether a
 * handoff completed cleanly without copying career data into the report.
 */
export function buildNonApiAiHandoffLifecycleMarkdown(currentNodeIds, reportWindowId) {
  let lifecycles = [];
  try { lifecycles = getNonApiAiHandoffLifecycle({ windowId: reportWindowId }); }
  catch { return ''; }
  if (!Array.isArray(lifecycles) || lifecycles.length === 0) return '';

  const currentIds = currentNodeIds instanceof Set ? currentNodeIds : new Set(currentNodeIds || []);
  const settled = lifecycles.filter(item => item?.settledAt).length;
  const pending = lifecycles.length - settled;
  const lines = [
    `- Retained: ${lifecycles.length} request(s) · ${settled} settled · ${pending} pending (newest 20, current Electron process only)`,
  ];
  for (const item of lifecycles) {
    const issuedAt = Number(item?.issuedAt) || 0;
    const settledAt = Number(item?.settledAt) || 0;
    const acceptedAt = Number(item?.acceptedAt) || 0;
    const node = item?.nodeId
      ? `node \`${String(item.nodeId).replace(/`/g, "'")}\`${currentIds.size > 0 && !currentIds.has(item.nodeId) ? ' ⚠ not in this report canvas' : ''}`
      : 'node not recorded';
    const batch = item?.batch && item?.batchTotal
      ? ` · batch ${item.batch}/${item.batchTotal}`
      : '';
    const count = Number.isFinite(Number(item?.itemCount))
      ? ` · ${item.itemCount} item(s)`
      : '';
    const attempt = item?.attemptKind === 'partial-recovery'
      ? ` · **partial-row recovery**${Number.isFinite(Number(item?.rootBatchSize)) ? ` from ${item.rootBatchSize}-item root batch` : ''}`
      : item?.attemptKind === 'split'
        ? ` · split retry${Number.isFinite(Number(item?.rootBatchSize)) ? ` from ${item.rootBatchSize}-item root batch` : ''}`
        : '';
    const promptSize = Number.isFinite(Number(item?.promptChars))
      ? ` · prompt ${item.promptChars} chars`
      : '';
    // Absolute UTC clock, not just an elapsed span. Every other field here is
    // relative, so a settled row carried no timestamp that could be lined up
    // against the main-process log (UTC) or Event History (renderer-local) —
    // which is precisely what is needed to see the ORDER prompts were issued in.
    const issuedClock = issuedAt
      ? ` · issued ${new Date(issuedAt).toISOString().slice(11, 23)}Z`
      : '';
    const deliveries = `delivered ${Math.max(0, Number(item?.deliveries) || 0)} time(s)`;
    const retries = [];
    if (item?.rejected) retries.push(`${item.rejected} paste rejection(s)`);
    if (item?.reissues) retries.push(`${item.reissues} reissued`);
    if (item?.replays) retries.push(`${item.replays} replayed after dialog remount`);
    const accepted = acceptedAt && issuedAt
      ? ` · accepted after ${handoffElapsed(acceptedAt - issuedAt)}`
      : '';
    const terminal = settledAt && issuedAt
      ? ` · **${item.outcome || 'settled'}** in ${handoffElapsed(settledAt - issuedAt)}`
      : ` · **pending** for ${handoffElapsed(Date.now() - issuedAt)}`;
    lines.push(`- \`${String(item?.requestId || '?').replace(/`/g, "'")}\` · task \`${String(item?.task || 'unknown').replace(/`/g, "'")}\` · ${node}${batch}${count}${attempt}${promptSize}${issuedClock} · ${deliveries}${retries.length ? ` · ${retries.join(', ')}` : ''}${accepted}${terminal}`);
  }
  // Top-level `##`, and emitted BEFORE the Job Search Pipeline section rather
  // than appended to its tail. The clipboard cap truncates the base by document
  // position (a prefix slice), so the last content of the single largest
  // section is structurally the first thing dropped — which is exactly what
  // hid the receipts that record manual-handoff issue ORDER. A `###` is also
  // invisible to the cap's `/^## (.+)$/gm` heading scan, so it was dropped
  // without even being named in the truncation notice.
  return `
## Non-API AI Handoff Lifecycle
> Redacted delivery/validation receipts for manual job-AI copy/paste, in the order
> the prompts were ISSUED. Prompts, pasted responses, attachment paths, and
> validation-error text are never exported.

${lines.join('\n')}
`;
}

// A source's initial search row can remain at zero after a Continue/Solve path
// completes in an already-running process that predates the resume telemetry
// producer. Do not let that stale row override the newer, terminal resume fact.
function latestResolvedResumeAttempt(telemetry, sourceId, searchTs = 0) {
  const attempts = telemetry?.resumeAttempts?.[sourceId];
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  const latest = attempts.at(-1);
  const attemptTs = Number(latest?.t) || 0;
  return latest?.outcome === 'resolved' && attemptTs > (Number(searchTs) || 0)
    ? latest
    : null;
}

// Generic inline Solve sources do not write resumeAttempts; their durable
// resolve snapshot is the equivalent terminal recovery fact. Accept older
// snapshots with kept>0, while never hiding a newer blocking warning.
function latestResolvedRecovery(telemetry, sourceId, searchTs = 0) {
  const attempt = latestResolvedResumeAttempt(telemetry, sourceId, searchTs);
  if (attempt) return { kind: 'resume-attempt', ts: Number(attempt.t) || 0, count: resolvedResumeCount(attempt), attempt };
  const resolve = telemetry?.resolves?.[sourceId];
  const resolveTs = Number(resolve?.ts) || 0;
  const warning = resolve?.warning;
  const successful = resolve?.resolved === true || Number(resolve?.kept) > 0;
  if (resolveTs > (Number(searchTs) || 0) && successful && !warning) {
    return { kind: 'resolve', ts: resolveTs, count: Math.max(0, Number(resolve?.kept) || 0), resolve };
  }
  return null;
}

function resolvedResumeCount(attempt) {
  const detail = String(attempt?.detail || '');
  // Newer telemetry records the complete funnel (`… new=19`); older builds
  // recorded only `19 item(s)`. Both are diagnostic observations, never a
  // guessed reconstruction from a source warning.
  const match = detail.match(/\bnew\s*=\s*(\d+)\b/i)
    || detail.match(/\b(\d+)\s+item\(s\)/i);
  return match ? Math.max(0, Number(match[1]) || 0) : null;
}

function postPipelineResumePassCount(telemetry, pipeline) {
  if (pipeline?.active || !pipeline?.ts) return 0;
  const completedAt = Number(pipeline.ts) || 0;
  let count = 0;
  const sourcesWithResolvedAttempt = new Set();
  for (const [sourceId, attempts] of Object.entries(telemetry?.resumeAttempts || {})) {
    const resolved = (Array.isArray(attempts) ? attempts : [])
      .filter(attempt => attempt?.outcome === 'resolved' && (Number(attempt?.t) || 0) > completedAt);
    if (resolved.length > 0) {
      count += resolved.length;
      sourcesWithResolvedAttempt.add(sourceId);
    }
  }
  // Some older paths emitted a resolve row but not a resume-attempt row. Count
  // that newer completion once, while avoiding double-counting the normal pair.
  for (const [sourceId, resolve] of Object.entries(telemetry?.resolves || {})) {
    if (!sourcesWithResolvedAttempt.has(sourceId) && (Number(resolve?.ts) || 0) > completedAt) count++;
  }
  return count;
}

export function formatGlassdoorCacheProvenance(entry = {}) {
  if (!entry.country) {
    return '⚠️ no country provenance — will be upgraded only if it is an exact known nation root; otherwise re-resolved';
  }
  return `country ${entry.country}${entry.verifiedAt ? ` · verified ${formatAge(entry.verifiedAt)}` : ''}`;
}

function historyReportValue(value, fallback, max = 240) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// Job detail/search URLs commonly carry opaque provider IDs, tracking values,
// or short-lived challenge tokens in their query string. The report only needs
// the host/path that was reached; keeping the raw query both wastes the
// clipboard budget and risks exporting data that should stay in the browser.
function reportUrl(value, fallback = '(no URL)', max = 240) {
  return historyReportValue(redactReportUrl(value), fallback, max);
}

function reportText(value, fallback, max = 240) {
  return historyReportValue(redactReportUrlsInText(value), fallback, max);
}

function historyJobReportValue(job, { includeSeenDate = false } = {}) {
  const row = job || {};
  const seen = includeSeenDate
    ? `seen_date=${historyReportValue(row.seen_date, '(unknown date)', 32)}; `
    : '';
  return `${seen}source=${historyReportValue(row.source, '?', 60)}; ` +
    `title="${historyReportValue(row.title, '(untitled)')}"; ` +
    `company="${historyReportValue(row.company, '(unknown company)')}"; ` +
    `location="${historyReportValue(row.location, '(no location)')}"; ` +
    `url=${reportUrl(row.url, '(no URL)', 500)}`;
}

function historyKeyKindLabel(kind) {
  if (kind === 'url') return 'URL';
  if (kind === 'title-company-location') return 'title + company + location';
  if (kind === 'title-company') return 'title + company';
  return 'unknown';
}

function historyDropEvidenceLines(samples, totalDropped, indent = '') {
  const bounded = (Array.isArray(samples) ? samples : []).slice(0, 5);
  if (!(Number(totalDropped) > 0) || bounded.length === 0) return [];
  const plural = bounded.length === 1 ? '' : 's';
  const total = Math.max(0, Number(totalDropped) || 0);
  return [
    `${indent}- History suppression evidence (${bounded.length}/${total} bounded sample${plural}):`,
    ...bounded.map((sample) => {
      const kind = historyKeyKindLabel(sample?.keyKind);
      const key = sample?.keyKind === 'url'
        ? reportUrl(sample?.key, '(unknown key)', 320)
        : reportText(sample?.key, '(unknown key)', 320);
      return `${indent}  - Dropped {${historyJobReportValue(sample?.dropped)}} → matched ${kind} key \`${key}\` against history {${historyJobReportValue(sample?.history, { includeSeenDate: true })}}`;
    }),
  ];
}

/**
 * Renders the last job-search pipeline funnel (search → scoring → bucketing).
 *
 * This is the load-bearing section for "did we analyze all the jobs we found?"
 * reports. The in-memory node tallies that would otherwise answer it
 * (totalScoredCount / finalSourceCounts on the hub) evaporate the moment the
 * user deletes the hub — which is exactly when these reports get filed — and
 * the raw funnel numbers otherwise live only in the 60-line log ring buffer,
 * which scrolls. getJobsTelemetry() captures them in the main process so they
 * survive both.
 *
 * Crucially, it separates *expected* drops (dedup / too-old / already-seen
 * history) from *unexpected* losses: jobs that reached the scorer but came
 * back as placeholder filler (matchScore=50, "AI format error"), and jobs the
 * abort signal cut off before they were ever scored. A bare "Scored N jobs"
 * log line hides both.
 */
// `omitJobAudit` (XJOBAUDIT filter code, bugReportCodes.js) collapses the five
// bulky PER-JOB/PER-LOCATION audit enumerations below — taxonomy placement,
// scoring evidence, all-source role relevance, the Glassdoor location cache,
// and the deferred-listing samples — into a one-line marker each. It never touches the funnel numbers,
// stop reasons, warnings, or per-source outcomes that surround them: those are
// exactly what a reader debugging a clipboard-capped job report still needs.
export function buildJobsPipelineSnapshot(currentNodeIds, reportWindowId, canvasFilePath, localApplications = [], omitJobAudit = false) {
  let t;
  try { t = getJobsTelemetry(); } catch { return ''; }
  // Local AI card state is renderer-owned and can be diagnostically useful
  // even before the job-search telemetry store has recorded a pipeline run.
  if (!t) t = {};
  let browserScrape = null;
  try { browserScrape = getManualScraperTelemetry(); } catch { /* scraper may not be loaded */ }
  // recordManualScraperTelemetry writes an ORIGIN_PHASES row to BOTH the 30-slot
  // `events` recency ring and the longer-lived `origins` ring. The three sections
  // below filtered `events` only, so a long walk evicted them and the sections
  // silently vanished: a 30-page Glassdoor run that logged "country scope not
  // enforced" at 04:00:03 produced a report with no such section anywhere, while
  // the location section went on asserting "Verified location filter". Retention
  // that no renderer reads is not retention — consult the union.
  const originPool = (() => {
    const seen = new Set();
    const out = [];
    for (const e of [...(browserScrape?.origins || []), ...(browserScrape?.events || [])]) {
      const key = `${e?.ts}|${e?.phase}|${e?.sourceId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out.sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
  })();

  let hasResolves = t && t.resolves && Object.keys(t.resolves).length > 0;
  let hasLinkedInEnrich = Array.isArray(t?.linkedinEnrich) && t.linkedinEnrich.length > 0;
  let hasBrowserScrape = !!browserScrape?.active || (browserScrape?.events || []).length > 0;
  // NOTE: the manual-handoff receipt is no longer built or emitted here — it is
  // its own top-level section, rendered ahead of this one by bugReport.js so a
  // clipboard cap cannot shear it off this section's tail.
  let appGen = null;
  try { appGen = getApplicationTelemetry(); } catch { /* generator may not be loaded */ }
  // Application telemetry is a last-one-wins main-process singleton. Scope it
  // independently from the jobs funnel: a window can generate an application
  // after another window most recently searched for jobs, and neither report
  // may borrow the other's evidence. Older attempts without windowId remain
  // local for backward compatibility, matching pipelineScope's policy.
  const applicationScope = appGen ? pipelineScope(appGen.nodeId, appGen.windowId, currentNodeIds, reportWindowId, {
    label: 'Application card',
    deletedNoun: 'card',
  }) : null;
  const scopedApplication = applicationScope?.foreign ? null : appGen;
  let applicationSync = null;
  try { applicationSync = getApplicationSyncTelemetry(); } catch { /* Sync service may not be loaded */ }
  // Sync is initiated by a file:// document rather than an Electron window, so
  // it has no webContents id. Attribute it to the saved canvas by requiring its
  // workspace to live below that canvas's deterministic Applied Jobs root.
  if (applicationSync?.workspaceDir && canvasFilePath) {
    const appliedRoot = path.resolve(path.dirname(canvasFilePath), 'Applied Jobs');
    const relative = path.relative(appliedRoot, path.resolve(applicationSync.workspaceDir));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) applicationSync = null;
  } else {
    applicationSync = null;
  }
  // Model resolution is app-global rather than scoped to a job run, so it can
  // carry signal even when no fresh search ran in this session.
  let modelRes = null;
  try { modelRes = modelResolutionSnapshot(); } catch { /* resolver may not be loaded */ }
  const hasModelRes = !!(modelRes && (modelRes.fetchedAt > 0 || (modelRes.skipped || []).length > 0));
  const visibleLocalApplications = Array.isArray(localApplications)
    ? localApplications.filter(item => item?.localApplication?.id)
    : [];
  // indeedSession / resumeAttempts are stamped by resume-job-source, which can
  // run with NO search telemetry at all: jobsTelemetry is an in-memory singleton,
  // so after a restart a still-persisted needs-login source card can be actioned
  // (its warning + resumeState are saved with the canvas) without any search
  // having stamped `search`/`pipeline`/`resolves` this process. Leaving them out
  // of this gate returned '' and dropped the WHOLE Job Search Pipeline section —
  // including the two blocks that exist to explain what that click did — from
  // every report, FULL included.
  const hasResumeAttempts = !!(t.resumeAttempts && Object.keys(t.resumeAttempts).length > 0);
  // t.compensation (Competitive salary check, rendered below) is its own
  // telemetry object stamped independently of scoring/bucketing — a run can in
  // principle reach compensation research with those absent (e.g. replayed from
  // a batch-reconcile path). Omitting it here would risk the same silent
  // whole-section drop the resumeAttempts comment above already documents.
  if (!t.search && !t.pipeline && !hasResolves && !hasLinkedInEnrich && !t.scoring && !t.scoringHeartbeat && !t.bucketing && !t.compensation && !t.history && !hasBrowserScrape && !scopedApplication && !applicationSync && !hasModelRes && !t.indeedSession && !hasResumeAttempts && visibleLocalApplications.length === 0) return '';

  const scope = pipelineScope(t.nodeId, t.windowId, currentNodeIds, reportWindowId, {
    label: 'Source hub',
    deletedNoun: 'hub',
  });
  if (scope.foreign) {
    if (!scopedApplication && !applicationSync && visibleLocalApplications.length === 0) return `\n## Job Search Pipeline\n${scope.note}`;
    // A local application generation/Sync must remain reportable even when a
    // different window owns the process-global last jobs run. Drop only that
    // foreign funnel rather than returning before the local sections render.
    t = {};
    browserScrape = null;
    hasResolves = false;
    hasLinkedInEnrich = false;
    hasBrowserScrape = false;
  }
  const boardScope = pipelineScope(t.boardNodeId, t.windowId, currentNodeIds, reportWindowId, {
    label: 'Job Board node',
    deletedNoun: 'board',
  });
  const attributionNote = scope.foreign ? '' : `${scope.note}${boardScope.note}`;

  // Read session cache once — used to annotate pagination warnings with login status.
  let sessionCache = {};
  try {
    const cachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
    sessionCache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) || {};
  } catch { /* cache absent is fine — treat all platforms as unconfirmed */ }

  const lines = [];
  if (t.careerParseCache) {
    const cache = t.careerParseCache;
    const cacheScope = !cache.nodeId || !Array.isArray(currentNodeIds) || currentNodeIds.includes(cache.nodeId);
    if (cacheScope) {
      const outcomes = {
        checking: 'checking',
        hit: 'hit — reused the prior parsed career data',
        miss: 'miss — parsing was started',
        saved: 'miss → saved — the completed parse was accepted by the local cache store',
        'save-failed': 'miss → cache write failed — parse results were still returned',
      };
      lines.push('\n### Career Parse Cache');
      lines.push(`- ${outcomes[cache.outcome] || cache.outcome || 'unknown'} · ${cache.fileCount || 0} file(s) · fingerprint \`${cache.fingerprint || 'unknown'}\`${ago(cache.ts)}`);
      if (cache.error) lines.push(`- ⚠️ Cache write error: \`${historyReportValue(cache.error, '', 240)}\``);
    }
  }
  if (visibleLocalApplications.length) {
    lines.push('\n### Local AI Job State (live card snapshot)');
    for (const item of visibleLocalApplications.slice(0, 20)) {
      const local = item.localApplication;
      const title = item.title || '(untitled)';
      const company = item.company || '(no company)';
      const message = historyReportValue(local.message, '', 500);
      lines.push(`- ${title} @ ${company}${item.nodeId ? ` · node ${item.nodeId}` : ''} · job \`${local.id}\` · status: **${local.status || 'unknown'}**${message ? ` — ${message}` : ''}`);
    }
    if (visibleLocalApplications.length > 20) lines.push(`- _${visibleLocalApplications.length - 20} additional Local AI card state(s) omitted._`);
  }
  // Populated by the saved-snapshot quality pass and reused by the LinkedIn
  // residual verdict. `jobs` is the scoring-safe set; v2 snapshots additionally
  // retain the pre-filter recovery universe so source completion is judged
  // against the same candidates Solve can actually revisit.
  let savedSnapshotJobs = [];
  let savedRecoveryJobs = [];

  const postCompletionResumePasses = t.pipeline
    ? postPipelineResumePassCount(t, t.pipeline)
    : 0;

  if (t.pipeline) {
    const p = t.pipeline;
    const stageAge = p.ts ? Math.max(0, Date.now() - p.ts) : null;
    const runAge = p.startedAt ? Math.max(0, Date.now() - p.startedAt) : null;
    const elapsedLabel = runAge == null
      ? null
      : runAge < 60_000 ? `${Math.round(runAge / 1000)}s`
        : `${Math.floor(runAge / 60_000)}m${Math.round((runAge % 60_000) / 1000)}s`;
    const state = formatPipelineState(p);
    const durationMs = Number.isFinite(Number(p.durationMs)) ? Math.max(0, Number(p.durationMs)) : null;
    const durationLabel = durationMs == null
      ? null
      : durationMs < 1000 ? `${Math.round(durationMs)}ms`
        : durationMs < 60_000 ? `${(durationMs / 1000).toFixed(1)}s`
          : `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`;
    lines.push(`### Live Search Stage`);
    const supersedingResumes = postCompletionResumePasses;
    lines.push(`- ${state} · phase: **${p.phase || 'unknown'}**${p.active && elapsedLabel != null ? ` · run age ${elapsedLabel}` : ''}${!p.active && durationLabel != null ? ` · completed in ${durationLabel}` : ''}${supersedingResumes > 0 ? ` · superseded by ${supersedingResumes} post-completion resume pass${supersedingResumes === 1 ? '' : 'es'}` : ''}${stageAge == null ? '' : ` · last heartbeat ${Math.round(stageAge / 1000)}s ago`}`);
    if (p.runOrigin || p.profileInputMode) {
      const runOriginLabel = {
        initial: 'Initial career-file run',
        'rerun-button': 'Re-run Search button',
        'crash-resume': 'Crash-recovery Resume',
        unknown: 'Unknown/legacy caller',
      }[p.runOrigin] || String(p.runOrigin || 'Unknown/legacy caller');
      // Describes the INPUT this run was given, not that a parse action
      // occurred — 'fresh-files' means file paths were supplied (JobSearchNode.jsx:
      // profileInputMode: paths.length > 0 ? 'fresh-files' : 'stored-profile'),
      // and whether those files were actually re-parsed or served from the
      // fingerprint cache is a SEPARATE fact reported by "Career Parse Cache"
      // above. Labelling this 'career files reparsed' asserted the parse
      // happened even on a cache HIT, contradicting a "Career Parse Cache: hit
      // — reused the prior parsed career data" line printed one section earlier.
      const profileInputLabel = {
        'fresh-files': 'career files supplied',
        'stored-profile': 'stored career profile reused',
        unknown: 'career-input mode not recorded',
      }[p.profileInputMode] || String(p.profileInputMode || 'career-input mode not recorded');
      lines.push(`- Trigger: **${runOriginLabel}** · ${profileInputLabel}`);
    }
    if (p.error) lines.push(`- Last stage error: \`${historyReportValue(p.error, '', 300)}\``);
    if (Array.isArray(p.pendingSources) && p.pendingSources.length > 0) {
      lines.push(`- Pending source(s): ${p.pendingSources.map(sourceId => `\`${sourceId}\``).join(', ')}${p.lastSource ? ` · last progress from \`${p.lastSource}\`` : ''}`);
      lines.push('- Active source progress (status@+s from search start):');
      for (const sourceId of p.pendingSources) {
        const events = t.sourceEvents?.[sourceId] || [];
        const trail = events.length > 0
          ? events.map(formatSourceEvent).join(' → ')
          : '(no progress event retained)';
        lines.push(`  - \`${sourceId}\`: ${trail}`);
      }
    } else if (p.active) {
      lines.push(`- Pending source(s): none reported${p.lastSource ? ` · last progress from \`${p.lastSource}\`` : ''}`);
    }
  }

  if (t.search) {
    const s = t.search;
    lines.push(`### ${postCompletionResumePasses > 0 ? 'Initial Search Pass' : 'Search'}${ago(s.ts)}`);
    lines.push(`- Queries: ${s.queries}`);
    const relevanceStage = s.relevanceDropped > 0
      ? ` → title-relevance-dropped ${s.relevanceDropped}`
      : '';
    const descriptionDeferred = Number(s.descriptionEvidenceDropped?.total) || 0;
    const evidenceStage = descriptionDeferred > 0
      ? ` → evidence-deferred: ${descriptionDeferred} → **scoring-eligible: ${s.kept}**`
      : ` → **new: ${s.kept}**`;
    // The pinned-target-role gate sits between the age and history stages. It is
    // usually the LARGEST drop in a role-pinned run, so omitting it left the
    // funnel with an unexplained hole between "age-dropped" and "history-dropped".
    const roleStage = Number(s.roleDropped) > 0
      ? ` → role-gate-dropped: ${s.roleDropped}`
      : '';
    lines.push(
      `- Found (raw): ${s.raw}${relevanceStage} → after dedup: ${s.deduped} → age-dropped: ${s.ageDropped}${roleStage} → ` +
      `history-dropped: ${s.historyDropped}${evidenceStage}`,
    );
    if (Number(s.roleDropped) > 0) {
      const tokens = Array.isArray(s.roleTokens) ? s.roleTokens.join(' + ') : '';
      const bySource = s.roleDroppedBySource && typeof s.roleDroppedBySource === 'object'
        ? Object.entries(s.roleDroppedBySource).map(([id, n]) => `${id} ${n}`).join(', ')
        : '';
      lines.push(`- Target-role gate${tokens ? ` [every title had to contain: ${tokens}]` : ''}: dropped ${s.roleDropped}${bySource ? ` (${bySource})` : ''}`);
      const samples = Array.isArray(s.roleDroppedSamples) ? s.roleDroppedSamples.slice(0, 6) : [];
      if (samples.length > 0) {
        // Verbatim rejected titles, so the rule's effect is checkable rather than
        // asserted. Nothing here explains WHY a board returned them.
        lines.push(`  - Rejected titles (sample): ${samples.map(x => `\`${historyReportValue(x?.title, '', 60)}\` (${x?.source || '?'})`).join(', ')}`);
      }
    }
    if (postCompletionResumePasses > 0) {
      lines.push(`- _Initial-pass counters only — ${postCompletionResumePasses} later recovery pass${postCompletionResumePasses === 1 ? '' : 'es'} superseded this result. Final recovered-source funnels are reported under Resume attempts and Captcha-resolve / Solve below._`);
    }
    lines.push(s.relevanceDropped > 0
      ? '- _(title-relevance / dedup / age / history drops are by-design — not jobs we failed to analyze)_'
      : Number(s.roleDropped) > 0
        ? '- _(dedup / age / role-gate / history drops are by-design — not jobs we failed to analyze; the role gate is the pinned target role, not a relevance heuristic)_'
        : '- _(dedup / age / history drops are by-design — not jobs we failed to analyze; provider-returned rows are not locally title-filtered)_');
    const dedup = s.dedupProvenance;
    if (dedup?.total > 0) {
      const summary = Object.entries(dedup.counts || {}).map(([reason, count]) => `${reason}=${count}`).join(', ');
      lines.push(`- Dedup provenance: ${dedup.total} drop(s)${summary ? ` · ${summary}` : ''}.`);
      for (const item of Array.isArray(dedup.entries) ? dedup.entries : []) {
        const kept = item.kept || {};
        const dropped = item.dropped || {};
        const keptId = kept.nativeId || kept.url || '(no listing ID)';
        const droppedId = dropped.nativeId || dropped.url || '(no listing ID)';
        lines.push(`  - \`${item.reason || 'unknown'}\`: kept ${kept.source || '?'} "${kept.title || '?'}" — ${kept.location || '(no location)'} [${keptId}] · dropped ${dropped.source || '?'} [${droppedId}]`);
      }
      if (dedup.omitted > 0) lines.push(`  - _${dedup.omitted} additional dedup drop(s) omitted from this bounded trace._`);
    }
    lines.push(...historyDropEvidenceLines(s.historyDropSamples, s.historyDropped));
    // Look-back window the run actually used + a per-platform verdict on whether
    // it bound each source. The window is enforced two ways: a server-side date
    // param (the source never serves out-of-window rows) AND a global client-side
    // filterJobsByAge over the merged results — but the client filter KEEPS any
    // job with an unparseable `posted`, so a source with neither a server param
    // nor a parseable per-job date is only bounded by its own query limits.
    // This block makes "did 7 days apply to ALL platforms?" answerable at a glance.
    if (s.maxAgeDays != null) {
      lines.push(`- **Look-back window: ${s.maxAgeDays} day(s)** — enforced server-side where the source takes a date param, and re-applied as a global client-side filter (the client filter can only bound a source that carries a parseable \`posted\` date).`);
    }
    const collectionLimits = s.collectionLimits;
    if (collectionLimits && typeof collectionLimits === 'object') {
      const jobs = Number.isFinite(collectionLimits.jobsPerPlatform) && collectionLimits.jobsPerPlatform > 0
        ? `${Math.floor(collectionLimits.jobsPerPlatform)} job(s)/platform`
        : 'unlimited jobs/platform';
      const pages = Number.isFinite(collectionLimits.pagesPerPlatform) && collectionLimits.pagesPerPlatform > 0
        ? `${Math.floor(collectionLimits.pagesPerPlatform)} browser page(s)/search`
        : `all browser pages/search (safety backstop ${JOB_COLLECTION_PAGE_CEILING})`;
      lines.push(`- **Collection limits: ${jobs}; ${pages}** — set on this Job Search card for the run. The job limit is applied per platform; page depth applies to each generated search on browser platforms (API/feed platforms do not paginate).`);
    }
    if (s.ageBySource && Object.keys(s.ageBySource).length > 0) {
      lines.push(`- Per-source age outcome (dropped → kept · oldest surviving posting):`);
      for (const [k, a] of Object.entries(s.ageBySource)) {
        if ((a.kept || 0) === 0 && (a.dropped || 0) === 0) continue;
        const oldest = a.oldestKeptRaw ? `"${a.oldestKeptRaw}" (${a.oldestKeptDays}d)` : '—';
        let flag;
        if (a.oldestKeptDays != null && s.maxAgeDays != null && a.oldestKeptDays > s.maxAgeDays) {
          // A survivor older than the window means the client filter and the parse
          // disagree, or a source bypassed both — a genuine leak worth chasing.
          flag = ` 🔥 LEAK — kept a posting older than the ${s.maxAgeDays}d window`;
        } else if (a.kept > 0 && a.unparseableKept === a.kept) {
          // Every survivor had an unparseable/empty date — the client-side filter
          // was blind to this source, so its window is enforced SERVER-SIDE ONLY.
          flag = ` ⚠️ no parseable per-job date on any survivor — window enforced by the source's date param only (client backstop blind here)`;
        } else if (a.unparseableKept > 0) {
          flag = ` (${a.unparseableKept} survivor(s) had no parseable date — not client-checkable)`;
        } else {
          flag = ' ✅';
        }
        const boundDetail = s.dateBounds?.[k]
          || (k === 'dice' ? s.diceDateBound : null); // old-report compatibility
        const bound = boundDetail ? ` · bound: ${boundDetail}` : '';
        lines.push(`  - \`${k}\`: ${a.dropped} dropped → ${a.kept} kept · oldest kept ${oldest}${bound}${flag}`);
      }
    }
    // Target location: the typo-correction (raw → canonical), how each source
    // applied it (real param vs keyword-only vs remote-board), and an adherence
    // tally over the KEPT jobs — so "did 'denvr' get corrected?" and "was the
    // location adhered to per platform / why is a Miami role here?" are answerable.
    const loc = s.location;
    if (loc && (loc.rawInput || loc.canonical)) {
      if (loc.rawInput && loc.canonical && loc.rawInput.toLowerCase() !== loc.canonical.toLowerCase()) {
        lines.push(`- **Target location: "${loc.rawInput}" → "${loc.canonical}"** ${loc.corrected ? '(typo-corrected ✅)' : ''}`);
      } else {
        const inferred = loc.inferredFromCareerData
          ? ' (inferred from career data because Preferred location was blank)'
          : '';
        lines.push(`- **Target location: ${loc.canonical || loc.rawInput || '(none)'}**${inferred}${loc.rawInput && !loc.canonical ? ' ⚠️ raw input did not resolve to a canonical place' : ''}`);
      }
      if (loc.perSource && Object.keys(loc.perSource).length > 0) {
        lines.push('- Per-source location treatment (how each platform received the target):');
        // `perSource` is STATIC pre-run metadata, derived from the target string
        // alone — it cannot see what tier the locId actually resolved to. A run
        // that resolved "United States" to a nation-tier locId logged "the board
        // does not enforce nation-tier scopes" and still printed "Verified
        // location filter" here, with the contradiction parked in a different
        // section. Join the runtime fact to the claim that depends on it.
        const nationTierBySource = new Set(
          originPool.filter(e => e?.phase === 'location-nation-tier-unenforced').map(e => e?.sourceId).filter(Boolean),
        );
        for (const [k, treat] of Object.entries(loc.perSource)) {
          const caveat = nationTierBySource.has(k)
            ? ' — ⚠️ **but this run resolved a nation-tier locId, which this board accepts and echoes without filtering on it**, so these rows follow this machine\'s browsing region; the adherence tally below is the authority, not this line'
            : '';
          lines.push(`  - \`${k}\`: ${treat}${caveat}`);
        }
      }
      const ad = loc.adherence;
      if (ad && ad.total > 0) {
        const pct = Math.round((ad.matched / ad.total) * 100);
        // Attribute off-targets to the RIGHT cause. A "soft" source (keyword-only
        // like Google, or a remote board) legitimately spills nearby/unrelated
        // roles. A "hard" source carrying a real location= param returning an
        // out-of-area role is either that source's own search radius (e.g. Dice
        // +30mi → metro suburbs, which are on-target in practice) or a genuine
        // leak — don't hand-wave it as "keyword-only".
        // Shared by the off-target attribution AND the in-area caveat below:
        // "soft" means the source never received a location param, so its
        // location strings are the provider's own rendering either way.
        const isSoft = (id) => /keyword-only|best-effort|remote board|global remote/i.test(loc.perSource?.[id] || '');
        let offFlag = '';
        if (ad.offTarget > 0) {
          if (ad.country) {
            // Country-level target: an off-target is now only counted when the
            // listing names a DIFFERENT country's subdivision, so this figure is
            // a real cross-border leak and safe to state plainly. Locations with
            // no country signal at all land in `unclear` below instead.
            offFlag = ` — ⚠️ ${ad.offTarget} provably OUTSIDE ${ad.country} (cross-border leak; check the samples below)`;
          } else {
            const hard = Object.keys(ad.offBySource || {}).filter(id => !isSoft(id));
            offFlag = hard.length > 0
              ? ` — ⚠️ ${ad.offTarget} OUT-OF-AREA, incl. from real-param source(s) [${hard.join(', ')}] — likely that source's own search radius (e.g. Dice +30mi → nearby metro suburbs) or a genuine leak; check the samples below`
              : ` — ⚠️ ${ad.offTarget} OUT-OF-AREA (all from keyword-only / remote sources — best-effort; location-free query variants can surface these)`;
          }
        }
        // For a country target, "in-area" only means inside that country — say so,
        // so the reader doesn't read 50% as a city-level miss (it isn't).
        const scopeNote = ad.country ? ` (in-area = anywhere in ${ad.country})` : '';
        const unclearPart = ad.unclear > 0 ? `, ${ad.unclear} unclear` : '';
        // "remote-by-location", not "remote": this bucket counts LOCATION FIELDS
        // carrying a remote token (plus remote-only boards), which is not a census
        // of remote-eligible roles — a listing whose work arrangement lives only
        // in its title or description is not in it.
        lines.push(`- Location adherence over ${ad.total} kept job(s)${scopeNote}: ${ad.matched} in-area (${pct}%), ${ad.remote} remote-by-location, ${ad.offTarget} off-target${unclearPart}, ${ad.unknown} no-location${offFlag}`);
        if (ad.country) {
          // State the detector's reach with the figure it qualifies. We can only
          // enumerate subdivisions for the countries in foreignDetectable, so a
          // listing naming any other country lands in `unclear` and can never
          // reach the off-target count.
          const detectable = Array.isArray(ad.foreignDetectable) ? ad.foreignDetectable : [];
          const reach = detectable.length > 0
            ? ` Cross-border detection covers ${detectable.join(', ')} only — a listing naming any other country lands in "unclear", so "0 off-target" means "no ${detectable.join('/')} token seen", not "no foreign listings".`
            : '';
          lines.push(`  - ℹ️ Country-level target — "in-area" just means inside ${ad.country}. Search a city/province (e.g. "Toronto, Ontario") to tighten results and get city-level adherence.${reach}`);
        }
        // An in-area figure sourced entirely from location-param-less platforms is
        // an echo of the query, not corroboration of it: the same run produced one
        // listing fanned across five distinct locality cards, and a "Canada" stamp
        // on a posting whose title named a German city.
        const matchedSources = Object.keys(ad.matchedBySource || {});
        if (pct >= 90 && matchedSources.length > 0 && matchedSources.every(isSoft)) {
          const targetLabel = ad.country || ad.target;
          lines.push(`  - ⚠️ ${pct}% in-area rests entirely on keyword-only source(s) [${matchedSources.join(', ')}] that take no location parameter — their location strings come from the provider's own search-results rendering, so a high in-area figure is not independent confirmation of location targeting. Read it as "${ad.matched} location string(s) carried a ${targetLabel} token".`);
        }
        if (ad.unclear > 0) {
          // Deliberately NOT counted as a leak. We can enumerate a country's
          // provinces/states but not its cities, so a bare city name ("Nanaimo")
          // is unclassifiable rather than foreign — calling it a leak sent a past
          // investigation after a bug that wasn't there. A HIGH unclear count
          // concentrated in one source is still worth a look: that source is
          // returning locations too bare to verify.
          const bySrc = Object.entries(ad.unclearBySource || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          lines.push(`  - ℹ️ ${ad.unclear} unclear: the listing names a place with no ${ad.country} or foreign region token (usually a bare city name), so membership can't be decided either way — NOT counted as a leak${bySrc ? ` · by source: ${bySrc}` : ''}`);
          if (Array.isArray(ad.unclearSamples) && ad.unclearSamples.length > 0) {
            for (const ex of ad.unclearSamples) lines.push(`    - ${ex}`);
          }
        }
        if (Array.isArray(ad.offSamples) && ad.offSamples.length > 0) {
          lines.push('  - Off-target sample(s):');
          for (const ex of ad.offSamples) lines.push(`    - ${ex}`);
        }
      }
      if (Array.isArray(s.queryStrings) && s.queryStrings.length > 0) {
        lines.push('- Raw role queries (shared across sources):');
        for (const q of s.queryStrings) lines.push(`  - \`${q}\``);
      }
      if (Array.isArray(s.googleQueryStrings) && s.googleQueryStrings.length > 0) {
        lines.push('- Google keyword queries sent (canonical location appended when absent):');
        for (const q of s.googleQueryStrings) lines.push(`  - \`${q}\``);
      }
    }
    // Exact admission evidence where available, plus a bounded retrospective
    // title audit for sources that trust a board's own relevance ranking. This
    // exposes source-consistency leaks without embedding the full scored-job
    // payload (which is far too large for clipboard reports).
    const relevanceAudit = s.relevanceAudit || (s.remoteRelevance
      ? Object.fromEntries(Object.entries(s.remoteRelevance).map(([sourceId, rows]) => [sourceId, { mode: 'admission', rows }]))
      : null);
    if (relevanceAudit && Object.keys(relevanceAudit).length > 0) {
      if (omitJobAudit) {
        const relevanceRowCount = Object.values(relevanceAudit).reduce((sum, audit) => {
          const rows = Array.isArray(audit) ? audit : audit?.rows;
          return sum + (Array.isArray(rows) ? rows.length : 0);
        }, 0);
        lines.push(`- All-source role relevance audit (${relevanceRowCount} row(s) across ${Object.keys(relevanceAudit).length} source(s)) omitted by filter code — XJOBAUDIT.`);
      } else {
        lines.push('- All-source role relevance audit (surviving jobs; `service→support` denotes an adjacent role synonym):');
        for (const [sourceId, audit] of Object.entries(relevanceAudit)) {
          const rows = Array.isArray(audit) ? audit : audit?.rows;
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            const title = row?.title ? `"${row.title}"` : '(untitled)';
            const company = row?.company ? ` — ${row.company}` : '';
            const matches = Array.isArray(row?.matched) ? row.matched : [];
            const targetRoleTokens = Array.isArray(row?.targetRoleTokens)
              ? row.targetRoleTokens.filter(token => typeof token === 'string' && token).slice(0, 12)
              : [];
            const targetRoleGate = row?.targetRoleTitleMatch && targetRoleTokens.length > 0
              ? `target-role title gate → [${targetRoleTokens.join(' + ')}] (the query audit uses separate exact/synonym matching)`
              : '';
            const why = matches.map(m => {
              const terms = Array.isArray(m?.matchedConcepts)
                ? m.matchedConcepts.map(concept => `${concept?.queryTerm || '?'}${concept?.kind === 'synonym' ? `→${concept.matched || '?'}` : ''}`).join(', ')
                : (Array.isArray(m?.matchedTerms) ? m.matchedTerms.join(', ') : '—');
              const required = m?.requiredMatches ? `/${m.requiredMatches} required` : '';
              return `\`${m?.query || '?'}\` → [${terms}]${required}`;
            }).join('; ') || targetRoleGate || '(no match evidence recorded)';
            const tags = Array.isArray(row?.tags) && row.tags.length ? ` · tags: ${row.tags.join(', ')}` : '';
            const mode = audit?.mode === 'post-hoc-title-audit' ? ' · post-hoc title audit' : ' · admission evidence';
            const bypass = row?.providerAcceptedWithoutLocalTitleMatch
              ? ' · no local query-title match; accepted from provider ranking by design'
              : '';
            lines.push(`  - [${sourceId}] ${title}${company}: ${why}${tags}${mode}${bypass}`);
          }
        }
      }
    }
    // Listing language: how many kept jobs came through in a non-English language
    // (e.g. fr.glassdoor.ca / Québec / EU postings). They're kept & scored as-is —
    // this is observability, not a filter — so a foreign listing that scored low
    // is explained by its language, not a scoring bug.
    const langs = s.languages;
    if (langs && langs.total > 0) {
      if (langs.nonEnglish > 0) {
        const parts = Object.entries(langs.byLang).map(([l, n]) => `${l}=${n}`).join(', ');
        lines.push(`- Listing language: ${langs.nonEnglish}/${langs.total} non-English (${parts}) — kept & scored as-is (the AI reads them; applying is the user's call)`);
        for (const l of Object.keys(langs.samples || {})) {
          const sample = langs.samples[l];
          if (sample && typeof sample === 'object') {
            lines.push(`  - ${l}: ${sample.label || '(unknown listing)'}${sample.evidence ? ` · evidence: “${sample.evidence}”` : ''}`);
          } else {
            lines.push(`  - ${l}: ${sample}`);
          }
        }
      } else {
        lines.push(`- Listing language: all ${langs.total} kept job(s) English`);
      }
    }

    // Browser-scrape order this run + the per-source manual-solve history that
    // produced it. Sources that recently made the user solve a captcha/login run
    // first (so they're cleared while watched); clean/auto-handling sources sink.
    // Answers "why did Google scrape before Indeed?" — score = recent manual-solve
    // rate (EMA); needs ≥2 runs of data before it reorders off the default.
    if (Array.isArray(s.browserOrder) && s.browserOrder.length) {
      const v = s.verification || {};
      const annotated = s.browserOrder.map((id) => {
        const st = v[id];
        return st && st.samples >= 2 ? `${id}(${Math.round((st.score || 0) * 100)}% manual)` : id;
      });
      lines.push(`- Browser scrape order (manual-verification-first): ${annotated.join(' → ')}`);
    }

    // Per-source provider rows versus the subset retained for this pipeline.
    // `count` is post whole-feed admission (and post card-level cap), while
    // providerGathered/gathered is what the source actually returned. Showing
    // both is essential for a keyword-less feed: 100 provider rows rejected by
    // title relevance must never render as "provider-returned: (none)".
    if (s.bySource && Object.keys(s.bySource).length > 0) {
      const entries = Object.entries(s.bySource);
      const providerReturned = (v) => {
        const raw = v?.providerGathered ?? v?.gathered ?? v?.count ?? 0;
        const count = Number(raw);
        return Number.isFinite(count) ? Math.max(0, count) : 0;
      };
      const got = entries
        .filter(([, v]) => providerReturned(v) > 0 || Number(v?.count || 0) > 0)
        .map(([k, v]) => `${k}=${providerReturned(v)} → ${Math.max(0, Number(v?.count) || 0)}`);
      // Preserve a terminal post-search resume outcome when the original row
      // still says 0/0. This prevents a genuine resolved source from becoming
      // the misleading `(none)` fallback until the main process is restarted.
      const resumed = entries
        .filter(([, value]) => providerReturned(value) === 0 && Number(value?.count || 0) === 0)
        .map(([sourceId]) => [sourceId, latestResolvedRecovery(t, sourceId, s.ts)])
        .filter(([, recovery]) => recovery)
        .map(([sourceId, recovery]) => {
          const label = recovery.kind === 'resolve' ? 'Solve resolved' : 'resume resolved';
          return `${sourceId}=${label}${recovery.count == null ? '' : ` → ${recovery.count}`}`;
        });
      const renderedSources = [...got, ...resumed];
      lines.push(`- Per source (provider returned → retained before target-role/history/evidence gates): ${renderedSources.length ? renderedSources.join(', ') : '(none)'}`);
      for (const [sourceId, value] of entries) {
        const enrichment = value?.enrichment;
        if (!enrichment || !(Number(enrichment.attempted) > 0)) continue;
        const stageSummary = Object.entries(enrichment.stages || {})
          .map(([stage, counts]) => `${stage} ${counts.recovered || 0}/${counts.attempted || 0}`)
          .join(', ');
        lines.push(`  - \`${sourceId}\` description enrichment: ${enrichment.enriched || 0}/${enrichment.attempted || 0} full · ${enrichment.empty || 0} blank/short · ${enrichment.challenge || 0} challenged · ${enrichment.unavailable || 0} unavailable · ${enrichment.error || 0} error${stageSummary ? ` (${stageSummary})` : ''}`);
      }
      // Date-bounded deep pagination: how deep each paginating source walked and
      // why it stopped. `empty-page` = the source ran out of results.
      // `page-turn-stalled` = our own page turn never landed (NOT exhaustion).
      // `blocked`
      // = an anti-bot wall cut it short. `page-cap` = hit this card's requested
      // page depth with jobs still coming. `per-source-cap` = its intentional
      // per-platform job limit (not an exhausted source). One-shot/API sources
      // have no walk and don't appear here.
      // Completeness against the board's OWN advertised total, where that number
      // is trustworthy. Only ZipRecruiter publishes one that matched its
      // reachable count exactly when walked to the end; the figure drifts a unit
      // or two between requests, hence the "~". ZipRecruiter may use the gap to
      // probe an unlinked next page, which is reported explicitly below.
      for (const [sid, v] of entries) {
        if (v.claimedTotal == null) continue;
        const got = Number(v.count) || 0;
        // State both numbers; do NOT call the difference a loss. The kept count
        // is already past the age filter, the per-platform cap and cross-source
        // dedup, so a source correctly capped at 50 of 520 is not missing 470.
        // The "~" is literal: the advertised number drifts a unit or two between
        // requests from live index churn.
        // `count` is the RAW rows this source's scraper returned — it is taken
        // before the run's client-side age, seen-history and target-role
        // filtering, so calling it "kept" and blaming those filters for the
        // shortfall would attribute the gap to stages that never touched this
        // number. What CAN separate the two is the per-platform cap, the board's
        // own server-side date filter, and paging stopping early.
        lines.push(
          `  - \`${sid}\` completeness: collected ${got} raw row(s); the board advertised ~${v.claimedTotal} for this query`
          + ' (pre-filter count — the gap reflects the per-platform cap, the board-side date filter, or a walk that ended early)',
        );
        if (v.directContinuation) {
          const continuation = v.directContinuation;
          const span = Number(continuation.pages) > 0
            ? `page ${continuation.fromPage}→${continuation.lastPage}`
            : `page ${continuation.fromPage}`;
          lines.push(`    - Direct unlinked-page continuation: ${span} · ${continuation.pages || 0} page(s) reached · stopped: ${continuation.stop || 'unknown'}`);
        }
      }
      const walked = entries.filter(([, v]) => v.pagesWalked > 0);
      for (const [k, v] of walked) {
        let flag = '';
        if (v.stopReason === 'blocked') {
          // A bare glyph stated severity and nothing else. This reason only
          // reaches this line when the block hit on page 2+ — a page-1 block
          // leaves pagesWalked at 0 and is filtered out above.
          flag = ' ⚠️ (an anti-bot wall ended the walk mid-source — later pages were not read; see the source warning/evidence above.)';
        } else if (v.stopReason === 'pagination-unhandled') {
          // Deliberately names both control families: this reason now also
          // fires for an in-place "Show more jobs" append (see clickLoadMore in
          // manualScraper.js), and naming only a pager would send a reader
          // hunting for a Next button that this source never had.
          flag = ' ⚠️ (the page exposed an enabled "next page" or "show more jobs" control that the scraper did not follow — later results may be missing; see the source warning/evidence above)';
        } else if (v.stopReason === 'page-turn-stalled') {
          // Distinct from `empty-page`: nothing established that the board ran
          // out. Only that our own next-page click never changed the URL, so the
          // walk stopped rather than re-extract the page it was already on.
          flag = ' ⚠️ (the next-page click never landed on a new URL, so the walk stopped early — this is NOT an exhausted source, and later pages were not read)';
        } else if (v.stopReason === 'per-source-cap') {
          const limit = v.cap?.limit;
          const capLabel = Number.isFinite(limit) ? ` (${limit})` : '';
          flag = ` ⚠️ (stopped by this card's per-platform job limit${capLabel} — this source may have additional in-window jobs; increase or clear the Jobs per platform setting on the Job Search card to widen.)`;
        } else if (v.stopReason === 'page-cap') {
          // A page-ceiling where most rows deduped away means the page param
          // re-served the same page (clamping) — NOT genuine depth, so "may be
          // more" would mislead. The raw↔unique gap is the tell.
          const raw = v.count || 0, uniq = v.unique;
          const notLoggedIn = !sessionCache[k]?.connected;
          const isReserved = uniq != null && raw > 0 && uniq <= raw / 2;
          const loginNote = notLoggedIn ? ` Not logged in at search time — platform may ignore pagination without a session.` : '';
          // Re-served pages while cache says connected is a red flag: the most
          // common cause of silent re-serving is an invalid/expired session that
          // the verifier mistakenly accepted (false positive). Surface it so the
          // user knows to re-verify their login rather than chase a code bug.
          const falsePosNote = (!notLoggedIn && isReserved)
            ? ` Cache says logged in — but re-served pages are the signature of a blocked (unauthenticated) session. The verify URL may be producing a false positive; try logging out and back in via Settings → Job Platform Logins.`
            : '';
          if (isReserved) {
            flag = ` ⚠️ (hit page cap, but ${raw} gathered → only ${uniq} unique: re-served/clamped pages, likely NOT more — the page-param is probably repeating.${loginNote}${falsePosNote})`;
          } else {
            flag = ` ⚠️ (hit page cap — may be more.${loginNote})`;
          }
        } else if (v.stopReason === 'completed' && Number(v.pagesWalked || 0) > 0) {
          // `completed` is the FALL-THROUGH of resolveManualSourceStopReason, not
          // an observation: it is what a walk reports when none of the specific
          // terminal conditions fired. For a load-more board that simply stops
          // rendering its "show more" control at its own result ceiling, the
          // click fails, the label probe finds nothing enabled to report, and the
          // loop breaks setting no flag — emitting the same `completed` as a
          // genuinely exhausted source. Only SCROLL_SOURCES (Google) carry a real
          // end-of-list oracle, and readClaimedResultTotal returns a comparable
          // total for ZipRecruiter alone, so most browser sources have nothing
          // that could distinguish the two. Say so: this word is the one a reader
          // is most likely to mistake for "we got everything".
          flag = ' ℹ️ (`completed` = the walk ended without any specific stop condition firing — it is NOT positive evidence the source was exhausted.'
            + ' A board that stops offering its next-page/show-more control at its own result ceiling ends the same way.'
            + ' Compare pages walked against the board\'s known cap before reading this as full coverage.)';
        } else if (v.stopReason === 'challenge-recovery-loop') {
          flag = ' ⚠️ (an anti-bot challenge bounced the walk back to page 1 twice; the scraper gave up rather than loop — pages past the challenge were never read.)';
        } else if (v.stopReason === 'provider-result-window') {
          flag = ' ℹ️ (the visible pager ended and a direct request for the next numbered page was redirected or clamped elsewhere — the provider’s reachable result window ended before its advertised count.)';
        } else if (v.stopReason === 'user-done') {
          // Misnamed: a user-initiated stop sets signal.aborted and resolves to
          // `aborted`. This is the abort-free early exit, and because earlyExit
          // is run-scoped it also ends every source after this one.
          flag = ' ⚠️ (NOT a user action — `user-done` is the abort-free early exit: a browser crash, or repeated extractor failures including the site-changed/anti-bot give-up. The run stopped here, so later pages and later sources were never read.)';
        } else if (v.stopReason === 'detail-enrichment-failed') {
          // Distinct from the detailBlock note below, which does NOT stop the walk.
          flag = ' ⚠️ (the description/detail fetch failed hard and stopped this source mid-walk — later pages were not read, and the run ended here, so any source after it never ran.)';
        } else if (v.stopReason === 'aborted') {
          flag = ' ⚠️ (the search was cancelled while this source was still walking — later pages were not read and later sources never ran.)';
        } else if (v.stopReason === 'empty-page') {
          flag = ' ℹ️ (a page extracted zero rows after a clean extraction, or a "show more" click added none — the end of this board\'s results for at least one of this source\'s queries.)';
        } else if (v.stopReason === 'end-of-results') {
          flag = ' ℹ️ (no cards on a page AFTER earlier pages of the same query extracted cleanly, so stale selectors are ruled out — read as the end of this board\'s results, not a broken extractor.)';
        } else if (v.stopReason === 'age-window') {
          // Only that two consecutive served pages held nothing in-window —
          // nothing here establishes that deeper pages exist.
          flag = ' ℹ️ (stopped by design: two consecutive pages were conclusively outside the look-back window. The walk stopped while the board was still serving rows — this is NOT an exhausted board.)';
        } else if (v.stopReason === 'no-new-jobs') {
          flag = ' ⚠️ (two consecutive pages returned only rows already gathered, so the pager stopped advancing. Whether the board ran out or re-served a page is NOT established — later results may be missing.)';
        } else if (v.stopReason === 'data-stop') {
          flag = ' ⚠️ (the per-page stop hook ended the walk without naming a reason; the shipped hook always names one, so coverage here is unknown.)';
        }
        // A detail-enrichment block is invisible to stopReason (the walk ran to
        // completion; only description fetching stopped). State it on the same
        // line, or a run that gathered 897 rows and could score 61 of them
        // reads as `completed` with no flag at all.
        const db = v.detailBlock;
        // A successful re-probe resets `firstPage`/`reprobes` on the scraper side,
        // and `skippedCards` never counted the triggering page at all — so a run
        // that lost 21 rows on page 29 and recovered on page 30 rendered as a bare
        // "enrichment resumed", which reads as "nothing was lost". Prefer the
        // recovery-surviving fields and always state the row cost, including when
        // it is zero: "resumed" is only reassuring if the loss is quantified.
        const blockPage = db?.firstPage != null ? db.firstPage : db?.everBlockedPage;
        const reprobeCount = Number(db?.reprobesTotal ?? db?.reprobes ?? 0);
        // Distinguish "counted zero" from "this telemetry shape has no counter".
        // A report generated by an already-running older main process carries no
        // unenrichedRows, and claiming "every retained row still carries a
        // description" there would assert something the data cannot support.
        const unenrichedKnown = db != null && db.unenrichedRows != null;
        const unenriched = Number(db?.unenrichedRows || 0);
        const blockFlag = db
          ? ` ⚠️ (detail enrichment ${db.active ? 'blocked' : 'was blocked'} by ${db.code || 'a source throttle'}`
            + `${blockPage != null ? ` from page ${blockPage}` : ''}`
            + `${db.skippedCards ? ` — ${db.skippedCards} card(s) got no panel request` : ''}`
            + `${reprobeCount ? `; ${reprobeCount} cooldown re-probe(s), ${db.recovered || 0} recovered` : ''}`
            + `${!db.active && db.recovered ? '; enrichment resumed' : ''}`
            + `${unenrichedKnown
              ? (unenriched > 0
                ? `; **${unenriched} row(s) ended the walk with no description** and are held back from scoring by the evidence gate before scoring and before seen-history (so they stay eligible for a later run)`
                : '; every retained row still carries a description')
              : (db.active ? '; those rows carry no description and are held back from scoring' : '')}`
            + `${db.active ? '; the block was still armed when the walk ended' : ''})`
          : '';
        // "Found (raw)" in the funnel above is computed from what the scraper
        // RETURNED, so it is already net of this per-source dedup. Stating the
        // drop here is what makes "after dedup: N (0 dropped)" readable as
        // "the LATER cross-source stage dropped none" rather than "nothing was
        // ever deduplicated" — a 30-page walk silently shed ~118 cards here.
        const dupDropped = Number(v.providerDuplicatesDropped || 0);
        const dupNote = dupDropped > 0
          ? ` · ${dupDropped} duplicate card(s) dropped in-scraper before the funnel's raw count`
          : '';
        lines.push(`  - \`${k}\`: walked ${v.pagesWalked} page${v.pagesWalked === 1 ? '' : 's'}${v.stopReason ? ` → stopped: ${v.stopReason}` : ''}${dupNote}${flag}${blockFlag}`);
      }
      // API/feed sources don't paginate. If a source matched more than it
      // surfaced, its per-platform Jobs setting truncated that run. `gathered`
      // is set only for API sources; > count = truncated.
      // NOTE: `finalRelevanceDropped` has had no live producer since the final
      // title-relevance gate was removed (provider-trust admission is
      // deliberate) — jobs.js no longer emits it, so these reads only ever see
      // it in synthetic/fixture telemetry. Kept so an older saved report still
      // renders, not because a scrape can still set it.
      const capOverflowFor = (v) => Number.isFinite(v.capOverflow)
        ? Math.max(0, v.capOverflow)
        : Math.max(0, Number(v.gathered || 0) - Number(v.count || 0) - Number(v.finalRelevanceDropped || 0));
      const apiCapped = entries.filter(([, v]) => v.gathered != null && capOverflowFor(v) > 0);
      for (const [k, v] of apiCapped) {
        const overflow = capOverflowFor(v);
        const collectedBeforeFinalAudit = Number(v.count || 0) + Number(v.finalRelevanceDropped || 0);
        const limit = v.cap?.limit;
        const capLabel = Number.isFinite(limit) ? ` (${limit})` : '';
        lines.push(`  - \`${k}\`: collected ${collectedBeforeFinalAudit} of ${v.gathered} in-window provider-returned candidate(s) ⚠️ (per-platform job limit${capLabel} — ${overflow} more were not gathered; increase or clear the Jobs per platform setting on the Job Search card to widen.)`);
      }
      const relevanceFiltered = entries.filter(([, v]) => v.relevanceDropped > 0);
      // jobRelevanceRejection is a pure function of (title, query): same inputs,
      // same output every time. So replaying it here against the run's own role
      // queries (the same ones printed above as "Raw role queries") is an EXACT
      // recomputation of what the gate did, not a guess — no new data channel
      // needed from the pipeline. A title is only rejected when every query
      // rejects it, so report the query that came closest to admitting it (the
      // one with the most matched concepts) as the representative reason.
      const roleQueries = Array.isArray(s.queryStrings) ? s.queryStrings : [];
      const explainRejection = (title) => {
        let closest = null;
        for (const q of roleQueries) {
          const rejection = jobRelevanceRejection(title, q);
          if (!rejection) continue; // an admitting query would contradict "every query rejects" — skip rather than assert one
          if (!closest || rejection.matched.length > closest.matched.length) closest = rejection;
        }
        if (!closest) return '';
        const matched = closest.matched.length ? closest.matched.join('+') : '(none)';
        switch (closest.reason) {
          case 'no-usable-query-terms': return ' [query had no usable terms]';
          case 'ambiguous-domain-conflict': return ` [matched ${matched}, but an ambiguous-domain guard term was present]`;
          case 'too-few-matched-concepts': return ` [matched ${matched} — ${closest.matched.length}/${closest.required} required]`;
          case 'not-one-title-phrase': return ` [matched ${matched}, but not within one title phrase]`;
          default: return ` [${closest.reason}]`;
        }
      };
      for (const [k, v] of relevanceFiltered) {
        const early = Number(v.admissionRelevanceDropped || 0);
        const final = Number(v.finalRelevanceDropped || 0);
        const phase = early && final
          ? ` (${early} during source admission; ${final} after collection)`
          : final ? ' after collection' : ' during source admission';
        lines.push(`  - \`${k}\`: provider returned ${v.providerGathered ?? v.count}; app rejected ${v.relevanceDropped} title-irrelevant row(s)${phase}.`);
        // RemoteOK has no search endpoint: its bounded bare/tag feed fan-out is
        // the source corpus that the title gate judged. Preserve only compact
        // scope/count provenance so a historical all-rejected result is
        // explainable without retaining rejected listing data.
        if (k === 'remoteok' && Array.isArray(v.remoteFeedProvenance) && v.remoteFeedProvenance.length > 0) {
          const scopes = v.remoteFeedProvenance.slice(0, 4).map((entry) => {
            const scope = entry?.scope === 'tag' ? `tag:${historyReportValue(entry?.tag, '', 32)}` : 'bare';
            const received = Number.isFinite(entry?.received) ? entry.received : '?';
            const added = Number.isFinite(entry?.added) ? entry.added : '?';
            return `${scope} ${received} received/${added} new`;
          });
          lines.push(`    - RemoteOK feed scopes: ${scopes.join('; ')} (tag scopes are derived from the raw role queries above; “new” excludes prior-feed duplicates).`);
        }
        // The count alone can't separate a gate doing its job from one that is
        // over-rejecting and starving the source — and a high reject ratio is
        // normal for keyword APIs that search the whole announcement (USAJobs),
        // so the ratio isn't the tell either. The discarded titles, now each with
        // WHY the gate rejected it, are.
        if (Array.isArray(v.relevanceRejected) && v.relevanceRejected.length > 0) {
          const sample = v.relevanceRejected.map(t => `"${historyReportValue(t, '', 60)}"${explainRejection(t)}`).join(', ');
          lines.push(`    - rejected sample: ${sample} — if these read as ON-target for the search, the relevance gate is too strict.`);
        }
      }
      // Scope/configuration skips are deliberate non-requests, not failed
      // searches. Keep them visible, but never put them under the alarming
      // "real miss" label used for blocks, selector failures, and safety skips
      // that unexpectedly prevented a configured source from running.
      //
      // NOTE on resumeState: a warning's `resumeState.mode` (what the card's
      // Continue/Log-in button will actually do) is NOT rendered on the lines
      // below even though `w` on the scrape side can carry it — jobs.js's
      // resume-job-source handler builds `bySource[sid].warning` as exactly
      // `{code, severity, evidence}` (see its per-source warning construction),
      // so the mode never survives to this builder. Adding a read for it here
      // would be dead code pretending to show data that can't arrive. The
      // "Resume attempts" trail below (sourced from jobsTelemetry.resumeAttempts,
      // a separate top-level field) is what actually answers "what did each
      // Continue click do" — that's the fix for "the Continue button is a
      // no-op was invisible", not this line.
      // Evidence/suggestion are free text authored by the scraper. A bare
      // .slice(0, 220) cut one mid-word ("…the scraper stopped befor"), which
      // reads as a corrupted report rather than a truncated one; historyReportValue
      // (above) is the marker-appending idiom this file already uses elsewhere.
      // `suggestion` was never rendered by ANY report path, so the one sentence
      // stating what the run did with the affected rows was dropped every time.
      const warningDetail = (warning) => {
        if (!warning) return '';
        const evidence = historyReportValue(warning.evidence, '', 220);
        const suggestion = historyReportValue(warning.suggestion, '', 160);
        const parts = [evidence, suggestion && `Suggested: ${suggestion}`].filter(Boolean);
        return parts.length > 0 ? ` — ${parts.join(' ')}` : '';
      };
      const expectedSkipCodes = new Set(['country-source-skipped', 'config-missing']);
      const zeroExpectedSkip = entries
        .filter(([, v]) => v.count === 0 && v.warning && expectedSkipCodes.has(v.warning.code))
        .map(([k, v]) => {
          return `${k} (${v.warning.code})${warningDetail(v.warning)}`;
        });
      const zeroWarn = entries
        .filter(([sourceId, v]) => v.count === 0 && v.warning && !expectedSkipCodes.has(v.warning.code)
          && !latestResolvedRecovery(t, sourceId, s.ts))
        .map(([k, v]) => {
          return `${k} (${v.warning.code})${warningDetail(v.warning)}`;
        });
      const zeroTitleFiltered = entries
        .filter(([, v]) => v.count === 0 && !v.warning && Number(v.relevanceDropped || 0) > 0)
        .map(([k, v]) => `${k} (${v.relevanceDropped} gathered, then title-filtered)`);
      const zeroClean = entries
        .filter(([, v]) => v.count === 0 && !v.warning && Number(v.relevanceDropped || 0) === 0)
        .map(([k]) => k);
      if (zeroWarn.length) {
        lines.push(`  - ⚠️ 0 results + flagged (real miss to investigate): ${zeroWarn.join(', ')}`);
      }
      if (zeroExpectedSkip.length) {
        lines.push(`  - ℹ️ intentionally not queried (scope/configuration): ${zeroExpectedSkip.join(', ')}`);
      }
      if (zeroTitleFiltered.length) {
        lines.push(`  - 0 retained after the title relevance gate: ${zeroTitleFiltered.join(', ')}`);
      }
      if (zeroClean.length) {
        lines.push(`  - 0 results, no warning (genuinely empty / off-category): ${zeroClean.join(', ')}`);
      }
      // Every branch above is gated on `count === 0`, so a source that returned
      // rows carried its warning silently — a Glassdoor run that gathered 897
      // listings and had panel enrichment throttled off after page 11 showed no
      // warning anywhere. A warning on a PRODUCTIVE source is exactly the case
      // where nothing else in the report flags it, so surface it on its own
      // line rather than reusing the "0 results" wording.
      const nonZeroWarn = entries
        .filter(([sourceId, v]) => v.count > 0 && v.warning && !expectedSkipCodes.has(v.warning.code)
          && !latestResolvedRecovery(t, sourceId, s.ts))
        .map(([k, v]) => {
          return `${k} (${v.warning.code}${v.warning.severity ? `/${v.warning.severity}` : ''}, ${v.count} row(s) still returned)${warningDetail(v.warning)}`;
        });
      if (nonZeroWarn.length) {
        lines.push(`  - ⚠️ returned results BUT flagged (partial success — check what the warning cost): ${nonZeroWarn.join(', ')}`);
      }
    }
    // Per-source progress-event trail — the sequence of status/warning events the
    // backend sent for each source, with timing relative to search start. This is
    // what diagnoses "a source was blocked but its resolve card vanished": the
    // renderer Event History shows WHEN a card node was removed, but only this
    // shows whether the source ever emitted a clean 'done' (which auto-dismisses
    // the card) or sat 'error'-without-warning for a long stretch (a card that
    // looks idle). Shown only for sources that ended non-clean or flip-flopped
    // between clean and failed — a plain searching→done source needs no trail.
    if (t.sourceEvents && Object.keys(t.sourceEvents).length > 0) {
      const interesting = Object.entries(t.sourceEvents).filter(([sourceId, evs]) => {
        if (latestResolvedRecovery(t, sourceId, s.ts)) return false;
        const statuses = new Set((evs || []).map(e => e.status));
        const lastStatus = evs?.[evs.length - 1]?.status;
        return (t.pipeline?.active && lastStatus === 'searching') ||
          lastStatus === 'error' || lastStatus === 'skipped' ||
          (statuses.has('done') && (statuses.has('error') || statuses.has('skipped')));
      });
      if (interesting.length > 0) {
        lines.push('- Source progress-event trail (status@+s from search start; ⚠ = warning carried):');
        for (const [sid, evs] of interesting) {
          const trail = (evs || []).map(formatSourceEvent).join(' → ');
          lines.push(`  - \`${sid}\`: ${trail}`);
        }
      }
    }
    const descriptionDropped = s.descriptionEvidenceDropped;
    if (descriptionDropped?.total > 0) {
      const bySource = Object.entries(descriptionDropped.bySource || {})
        .map(([source, q]) => `${source}=${q.deferred || 0} explicitly deferred/${q.empty || 0} empty/${q.short || 0} brief`)
        .join(', ');
      lines.push(`- ℹ️ **Description-evidence filter:** deferred ${descriptionDropped.total} unresolved listing(s) (${descriptionDropped.deferred || 0} explicitly deferred after a source response failure, ${descriptionDropped.empty || 0} empty, ${descriptionDropped.short || 0} below 400 characters) before scoring and before seen-history; they remain recoverable by Solve or a later run when full posting evidence is available${bySource ? ` · ${bySource}` : ''}.`);
      // Fifth per-job enumeration under the XJOBAUDIT collapse. Its four
      // siblings (taxonomy placement, scoring evidence, role relevance, the
      // Glassdoor location cache) already honour the flag; this one did not,
      // so a report asking to shed per-job audit prose still carried it.
      if (omitJobAudit) {
        const sampleCount = Array.isArray(descriptionDropped.samples) ? descriptionDropped.samples.length : 0;
        if (sampleCount > 0) {
          lines.push(`- Deferred-listing samples (${sampleCount} bounded row(s)) omitted by filter code — XJOBAUDIT.`);
        }
      } else {
        for (const sample of Array.isArray(descriptionDropped.samples) ? descriptionDropped.samples : []) {
          lines.push(`  - [${sample.source || '?'}] "${sample.title || '(untitled)'}" — ${sample.length || 0} chars${sample.deferredReason ? ` · deferred=${reportText(sample.deferredReason, '(unrecorded)', 160)}` : ''}${sample.url ? ` · ${reportUrl(sample.url)}` : ''}`);
        }
      }
    }

    // Snippet length stats — answers "did we get full descriptions?" without
    // requiring a separate file read outside the bug report. Reads the saved
    // snapshot (written by SKIP_AI_FOR_TESTING and the normal scoring path)
    // and reports min/median/max per source. Empty-snippet jobs are flagged
    // with ⚠️ so truncated or unenriched sources surface immediately.
    // Also runs field-quality checks for salary/posted to catch selector
    // regressions (e.g. salary="Monday to Friday", posted all-empty).
    try {
      const analysisPaths = getJobAnalysisPaths(
        canvasFilePath,
        path.join(app.getPath('userData'), 'job-search'),
      );
      let snapData;
      try {
        snapData = JSON.parse(fs.readFileSync(analysisPaths.jsonPath, 'utf8'));
      } catch (primaryError) {
        // Old artifacts shared one directory filename. Use one only after its
        // JSON proves ownership; otherwise a same-folder canvas can never
        // contaminate live field-quality diagnostics.
        if (!canvasFilePath || !analysisPaths.legacyJsonPath) throw primaryError;
        const legacyData = JSON.parse(fs.readFileSync(analysisPaths.legacyJsonPath, 'utf8'));
        if (!snapshotOwnedByCanvas(legacyData, canvasFilePath)) throw primaryError;
        snapData = legacyData;
      }
      const snapJobs = Array.isArray(snapData?.jobs) ? snapData.jobs : [];
      const recoveryJobs = Array.isArray(snapData?.descriptionRecoveryJobs)
        ? snapData.descriptionRecoveryJobs
        : [];
      const currentRunId = t.search?.runId || null;
      const snapshotRunId = snapData?.runId || null;
      const currentHubId = t.nodeId || null;
      const snapshotHubId = snapData?.sourceHubId || snapData?.nodeId || null;
      // A modern current run must have an exact snapshot token. Older snapshots
      // did not carry one, so only enforce the token when the live funnel has
      // it; the hub identity remains a useful guard for all versions.
      const runMatches = !currentRunId || snapshotRunId === currentRunId;
      const hubMatches = !currentHubId || !snapshotHubId || snapshotHubId === currentHubId;
      if (!runMatches || !hubMatches) {
        const currentLabel = currentRunId || currentHubId || '(unknown current run)';
        const snapshotLabel = snapshotRunId || snapshotHubId || '(legacy snapshot without run ID)';
        lines.push(`- ⚠️ Saved scrape snapshot does not match the current search run (current: \`${currentLabel}\`; snapshot: \`${snapshotLabel}\`). Snippet, salary, and field-quality checks were skipped to avoid stale evidence.`);
      } else if (snapJobs.length === 0) {
        savedSnapshotJobs = snapJobs;
        savedRecoveryJobs = recoveryJobs;
        lines.push('- Saved scrape snapshot (current run): 0 jobs — no snippet, salary, or field-quality rows to report.');
        const linkedInRecovery = recoveryJobs.filter(job => job?.source === 'linkedin');
        if (linkedInRecovery.length > 0) {
          const linkedInDeferred = linkedInRecovery.filter(job =>
            String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim().length < JOB_DESCRIPTION_EVIDENCE_MIN_CHARS,
          );
          lines.push(`- ⚠️ LinkedIn recovery pool: ${linkedInRecovery.length} candidate(s) retained separately from scoring; ${linkedInDeferred.length} still below the ${JOB_DESCRIPTION_EVIDENCE_MIN_CHARS}-character evidence threshold and remain available to Solve.`);
        }
      } else {
        savedSnapshotJobs = snapJobs;
        savedRecoveryJobs = recoveryJobs;
        if (recoveryJobs.length > 0) {
          const linkedInRecovery = recoveryJobs.filter(job => job?.source === 'linkedin');
          const linkedInDeferred = linkedInRecovery.filter(job =>
            String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim().length < JOB_DESCRIPTION_EVIDENCE_MIN_CHARS,
          );
          if (linkedInRecovery.length > 0) {
            lines.push(linkedInDeferred.length > 0
              ? `- ⚠️ LinkedIn recovery pool: ${linkedInRecovery.length} candidate(s) retained separately from scoring; ${linkedInDeferred.length} still below the ${JOB_DESCRIPTION_EVIDENCE_MIN_CHARS}-character evidence threshold and remain available to Solve.`
              : `- ✅ LinkedIn recovery pool: ${linkedInRecovery.length} candidate(s), all at or above the ${JOB_DESCRIPTION_EVIDENCE_MIN_CHARS}-character evidence threshold.`);
          }
        }
        const bySource = {};
        for (const j of snapJobs) {
          const src = j.source || 'unknown';
          if (!bySource[src]) bySource[src] = [];
          bySource[src].push((j.snippet || '').length);
        }
        const entries = Object.entries(bySource);
        if (entries.length === 1) {
          const [[, lens]] = entries;
          lens.sort((a, b) => a - b);
          const min = lens[0], median = lens[Math.floor(lens.length / 2)], max = lens[lens.length - 1];
          const empty = lens.filter(l => l === 0).length;
          const emptyFlag = empty > 0 ? ` ⚠️ ${empty} empty` : '';
          lines.push(`- Snippet lengths (saved snapshot): min ${min} / median ${median} / max ${max} chars${emptyFlag}`);
        } else {
          lines.push('- Snippet lengths per source (saved snapshot):');
          for (const [src, lens] of entries) {
            lens.sort((a, b) => a - b);
            const min = lens[0], median = lens[Math.floor(lens.length / 2)], max = lens[lens.length - 1];
            const empty = lens.filter(l => l === 0).length;
            const emptyFlag = empty > 0 ? ` ⚠️ ${empty} empty` : '';
            lines.push(`  - \`${src}\`: min ${min} / median ${median} / max ${max} chars${emptyFlag}`);
          }
        }

        // ── Field-quality checks ───────────────────────────────────────────
        // Salary: judged against the REAL annualizer (parseSalaryToNumeric —
        // the same function the app uses to bucket jobs into salary ranges),
        // not a lookalike regex. A present value that annualizes to 0 silently
        // dropped the job into the "Unspecified" bucket — that's the number
        // that matters, regardless of whether the raw string "looks monetary".
        // looksLikeMoney (via classifyUnparseableSalary) only comes in AFTER
        // that to split the unparseable ones into two different remedies:
        // still money-shaped but the extractor lost the cadence (fixable, our
        // bug) vs pure prose/benefit text with nothing to extract (not our
        // bug). See jobQualityChecks.js for the full rationale — a source can
        // pass looksLikeMoney on every value it carries and still be quietly
        // dropping a quarter of its pay data (USAJobs' "X / PH" rates).
        // Posted: 100% empty on a source means the date selector broke.
        // URL: any missing URLs means jobs can't be opened or deduped properly.
        // Description: the full JD is stored in `snippet` on the saved
        // snapshot (existing snippet-length stats above already flag empty
        // counts). The additional signal here is "non-empty but very short" —
        // typically means the per-card description expansion silently fell
        // back to the listing-card excerpt. Per-query `X/Y expanded` log
        // lines otherwise need to be eyeballed to notice.
        // Fields like title/company/location are too free-form to validate here.
        // looksLikeMoney / classifyUnparseableSalary / MOJIBAKE_RE live in
        // jobQualityChecks.js (extracted pure functions, unit-testable
        // directly instead of only via a full bug-report payload).
        const SHORT_DESC_THRESHOLD = 400; // listing snippets are typically <300 chars
        // Per-source salary expectation — gates the "0 salaries at all" alarm so it
        // never cries wolf on sources that structurally omit salary. Grounded in
        // the extractors (electron/extractors/apiExtractors.js + electron/extractors/jobs.js):
        //   NEVER  — extractor has no pay path at all (hardcoded salary:''):
        //            linkedin (guest API), greenhouse, lever boards.
        //   ALWAYS — carry comp on ~every posting (PositionRemuneration): usajobs.
        //   else   — OPTIONAL: postings legitimately omit pay, so 0% is only suspicious
        //            on a sample big enough that a normal batch would surface ≥1. This
        //            now INCLUDES ziprecruiter (DOM "Estimated pay" chip), weworkremotely
        //            (parsed from the RSS description), and google (aria-label salary) —
        //            all gained best-effort extraction, so a clean 0% IS worth flagging.
        const SALARY_NEVER = new Set(['linkedin', 'greenhouse', 'lever']);
        const SALARY_ALWAYS = new Set(['usajobs']);
        const ZERO_SALARY_MIN_SAMPLE = 20;

        const qualBySource = {};
        for (const j of snapJobs) {
          const src = j.source || 'unknown';
          const q = qualBySource[src] || (qualBySource[src] = {
            total: 0,
            salaryPresent: 0,
            salaryUnparseable: 0,
            salaryLostCadence: 0, salaryLostCadenceEx: [], salaryCadenceContextEx: [],
            salaryImplausibleAnnual: 0, salaryImplausibleAnnualEx: [],
            salaryProse: 0, salaryProseEx: [],
            postedEmpty: 0,
            urlMissing: 0,
            companyEmpty: 0,
            titleEmpty: 0,
            descEmpty: 0, descShort: 0, descShortLens: [], descShortEx: [],
            mojibake: 0, mojibakeEx: [],
          });
          q.total++;
          // Encoding corruption (C1 controls) in any user-facing field.
          const blob = `${j.title || ''} ${j.company || ''} ${j.snippet || ''}`;
          if (hasMojibake(blob)) {
            q.mojibake++;
            if (q.mojibakeEx.length < 1) {
              const excerpt = mojibakeExcerpt(blob);
              if (excerpt) q.mojibakeEx.push(excerpt);
            }
          }
          const sal = (j.salary || '').trim();
          if (sal) {
            q.salaryPresent++;
            // The annualizer, not looksLikeMoney, decides pass/fail: a value can
            // look perfectly monetary and still fail to become usable pay (see
            // the field-quality comment block above for the USAJobs example).
            if (parseSalaryToNumeric(sal) === 0) {
              q.salaryUnparseable++;
              const salaryClass = classifyUnparseableSalary(sal);
              if (salaryClass === 'implausible-annual') {
                q.salaryImplausibleAnnual++;
                if (q.salaryImplausibleAnnualEx.length < 3) q.salaryImplausibleAnnualEx.push(`"${historyReportValue(sal, '', 50)}"`);
              } else if (salaryClass === 'lost-cadence') {
                q.salaryLostCadence++;
                if (q.salaryLostCadenceEx.length < 3) q.salaryLostCadenceEx.push(`"${historyReportValue(sal, '', 50)}"`);
                // The list/card salary can lose its unit even when the recovered
                // full description states the same pay with an explicit cadence.
                // Keep one bounded same-job excerpt so FULL/QUALITY can tell
                // "the provider omitted it everywhere" from "our list-field
                // extraction failed to reconcile evidence we already captured."
                if (q.salaryCadenceContextEx.length < 3) {
                  const payLine = String(j.snippet || '')
                    .split(/\r?\n/)
                    .map(line => line.replace(/\s+/g, ' ').trim())
                    .find(line => line.length > 0 && line.length <= 180
                      && /[$€£]\s*\d/.test(line)
                      && /\b(?:pay|salary|compensation|wage|rate)\b/i.test(line)
                      && /\b(?:year|yr|yearly|annual|annually|annum|hour|hr|hourly|week|wk|weekly|month|mo|monthly|day|daily)s?\b|\/\s*(?:yr|hr|wk|mo|day)\b/i.test(line));
                  if (payLine) {
                    q.salaryCadenceContextEx.push({
                      raw: historyReportValue(sal, '', 80),
                      context: payLine.slice(0, 180),
                    });
                  }
                }
              } else {
                q.salaryProse++;
                if (q.salaryProseEx.length < 3) q.salaryProseEx.push(`"${historyReportValue(sal, '', 50)}"`);
              }
            }
          }
          if (!(j.posted || '').trim())  q.postedEmpty++;
          if (!(j.url || '').trim())     q.urlMissing++;
          if (!(j.company || '').trim()) q.companyEmpty++;
          if (!(j.title || '').trim())   q.titleEmpty++;
          // Full JD lives in `snippet` on the saved snapshot (the field is named
          // for the original list-card excerpt but is overwritten with the
          // expanded description). Two distinct failure modes:
          //   • empty  → enrichment never populated it (e.g. LinkedIn guest
          //     authwall hit mid-run, leaving the rest with no description),
          //   • short  → snippet-leak (listing-card text mistaken for full JD).
          const desc = (j.snippet || '').trim();
          if (!desc) {
            q.descEmpty++;
          } else if (desc.length < SHORT_DESC_THRESHOLD) {
            q.descShort++;
            if (q.descShortLens.length < 3) q.descShortLens.push(desc.length);
            if (q.descShortEx.length < 3) q.descShortEx.push({
              title: historyReportValue(j.title, '(untitled)', 100),
              url: String(j.url || '(no URL)').slice(0, 240),
              length: desc.length,
            });
          }
        }

        let anyQualityIssue = false;
        for (const [src, q] of Object.entries(qualBySource)) {
          const issues = [];
          // Salary: reported against POPULATED count, not total — 158/158
          // unparseable is the alarming signal; 158/686 of total dilutes it. A
          // source where salary is legitimately rare (e.g. LinkedIn API) lights
          // up correctly only when the values it DOES carry fail to annualize.
          // Split the two observed shapes (see jobQualityChecks.js): cadence-lost
          // values are money-shaped but lack a recoverable unit; prose values
          // mean there was never anything to extract. A source can
          // have both at once, so both counts + samples are always shown when
          // present rather than collapsing into one bucket.
          if (q.salaryUnparseable > 0) {
            const pct = Math.round((q.salaryUnparseable / q.salaryPresent) * 100);
            const sev = pct >= 80 ? '🔥' : '⚠';
            const breakdown = [];
            if (q.salaryLostCadence > 0) {
              // A money-shaped value without a unit is observable; its cause and
              // recoverability are not. Dice exposes a cadence on some detail
              // pages and omits it on others, so never promise an extractor fix
              // or imply a cadence that the source did not actually provide.
              breakdown.push(`${q.salaryLostCadence} money-shaped but cadence missing — extractor could not recover a unit, so these remain Unspecified rather than guessing — e.g. ${q.salaryLostCadenceEx.join(', ')}`);
              if (q.salaryCadenceContextEx.length > 0) {
                const contexts = q.salaryCadenceContextEx
                  .map(sample => `raw ${JSON.stringify(sample.raw)} ↔ JD ${JSON.stringify(sample.context)}`)
                  .join('; ');
                breakdown.push(`recovered-description pay context exists for ${q.salaryCadenceContextEx.length} bounded sample(s), so cadence reconciliation is possible without guessing — ${contexts}`);
              }
            }
            if (q.salaryImplausibleAnnual > 0) {
              breakdown.push(`${q.salaryImplausibleAnnual} implausibly tiny explicit annual amount — rejected rather than interpreting a likely mislabeled hourly rate — e.g. ${q.salaryImplausibleAnnualEx.join(', ')}`);
            }
            if (q.salaryProse > 0) {
              breakdown.push(`${q.salaryProse} pure prose, nothing to extract (not our bug) — e.g. ${q.salaryProseEx.join(', ')}`);
            }
            issues.push(
              `${sev} salary unparseable: ${q.salaryUnparseable}/${q.salaryPresent} (${pct}%) of present salaries never became a usable annual figure (parseSalaryToNumeric → 0, job lands in "Unspecified") — ${breakdown.join(' · ')}`,
            );
          }
          // Zero-salary alarm — scoped to what THIS source is expected to carry.
          // Skipped entirely for NEVER sources (0% is correct there). Hard for
          // ALWAYS sources (0% means the parse broke). Soft for OPTIONAL sources,
          // and only above a sample size where a healthy batch would surface ≥1.
          if (q.salaryPresent === 0 && !SALARY_NEVER.has(src)) {
            if (SALARY_ALWAYS.has(src)) {
              issues.push(`🔥 salary: 0/${q.total} present — this source carries pay on ~every posting, so a clean sweep means the salary parse/selector broke`);
            } else if (q.total >= ZERO_SALARY_MIN_SAMPLE) {
              issues.push(`⚠ salary: 0/${q.total} present — a source that normally surfaces some pay returned NONE across the whole batch; salary selector likely regressed`);
            }
          }
          if (q.postedEmpty === q.total) {
            issues.push(`🔥 posted: ALL ${q.total} empty — date selector broken`);
          } else if (q.postedEmpty > 0 && q.postedEmpty / q.total >= 0.8) {
            issues.push(`⚠ posted: ${q.postedEmpty}/${q.total} (${Math.round((q.postedEmpty / q.total) * 100)}%) empty — date selector may be broken`);
          }
          if (q.titleEmpty > 0) {
            issues.push(`🔥 title missing: ${q.titleEmpty}/${q.total} — title selector broken`);
          }
          if (q.companyEmpty > 0 && q.companyEmpty / q.total >= 0.2) {
            issues.push(`⚠ company missing: ${q.companyEmpty}/${q.total} (${Math.round((q.companyEmpty / q.total) * 100)}%) — company selector may be intermittent`);
          }
          if (q.urlMissing > 0) {
            issues.push(`🔥 url missing: ${q.urlMissing}/${q.total} — broken card link, breaks dedup`);
          }
          // Empty descriptions: a high rate means enrichment broke for most jobs
          // (e.g. LinkedIn's guest authwall stops enrichment after a few requests,
          // leaving the remainder with no description). Reported as a hard issue so
          // the field-quality line can't bless a source that's 99% empty while the
          // snippet-length line above already screams "N empty".
          // Below ~10% empty is within normal enrichment-miss tolerance (and the
          // snippet-length line above still shows the exact empty count); only a
          // meaningful fraction warrants a field-quality flag.
          if (q.descEmpty / q.total >= 0.5) {
            issues.push(`🔥 description missing: ${q.descEmpty}/${q.total} (${Math.round((q.descEmpty / q.total) * 100)}%) empty — enrichment failed for most jobs (e.g. authwall mid-run)`);
          } else if (q.descEmpty / q.total >= 0.1) {
            issues.push(`⚠ description missing: ${q.descEmpty}/${q.total} (${Math.round((q.descEmpty / q.total) * 100)}%) empty — some jobs never got a description`);
          }
          if (q.descShort > 0) {
            const lensStr = q.descShortLens.join(', ');
            const samples = q.descShortEx.map(ex => `"${ex.title}" (${ex.length} chars) [${reportUrl(ex.url)}]`).join('; ');
            issues.push(`⚠ description short (<${SHORT_DESC_THRESHOLD} chars): ${q.descShort}/${q.total} — likely got the listing snippet instead of the full JD (sample lengths: ${lensStr})${samples ? ` · samples: ${samples}` : ''}`);
          }
          // Encoding corruption — UTF-8 read as Latin-1 ("'"→"â€™", em-dash→"â€"",
          // 𝗯𝗼𝗹𝗱-Unicode). Corrupts the text fed to scoring AND the generated
          // résumé, and (before the gate fix) tricked language detection. NOT legit
          // accents (é/à/ç) — only C1 control bytes that never occur in real text.
          if (q.mojibake > 0) {
            const pct = Math.round((q.mojibake / q.total) * 100);
            const ex = q.mojibakeEx[0] ? ` — e.g. "…${q.mojibakeEx[0]}…"` : '';
            issues.push(`⚠ mojibake / encoding corruption: ${q.mojibake}/${q.total} (${pct}%) descriptions contain UTF-8-as-Latin-1 artifacts — corrupts scoring + generated résumé text${ex}`);
          }
          // Truncation/cap signature: non-empty descriptions clustered in a TIGHT
          // band at a modest length — e.g. Dice's ~500-char list `summary` when
          // detail enrichment silently falls back. Distinct from `descShort`
          // (<400): a 500-char cap clears that threshold but still isn't a full JD.
          // Real JDs vary widely (1k–10k), so a tight cluster across several jobs
          // is a cap, not natural variance.
          const lens = (bySource[src] || []).filter(l => l > 0).slice().sort((a, b) => a - b);
          if (lens.length >= 3) {
            const lo = lens[0], hi = lens[lens.length - 1];
            if (hi >= 200 && hi <= 1200 && (hi - lo) <= 40) {
              issues.push(`⚠ descriptions look capped/uniform: ${lens.length} non-empty all ~${hi} chars (${lo}–${hi}) — likely a length cap or summary-fallback, not full JDs`);
            }
          }
          if (issues.length > 0) {
            if (!anyQualityIssue) {
              lines.push('- ⚠️ **Field quality issues (scrape selectors may be broken):**');
              anyQualityIssue = true;
            }
            for (const msg of issues) {
              lines.push(`  - \`${src}\`: ${msg}`);
            }
          }
        }
        // Salary coverage — always surfaced, NOT gated on an unparseable warning.
        // That check only fires on PRESENT salaries the real annualizer rejects,
        // so "no warning" is vacuous when a source carries no salary at all (e.g.
        // LinkedIn's guest API never returns salary — fetch hardcodes salary='',
        // and enrichment extracts only the description, not baseSalary). Printing
        // present/total makes "selector fine, source just omits salary" distinct
        // from "we're silently dropping salaries we should have". "All monetary"
        // used to mean "passed a regex" and could be true while a quarter of a
        // source's salaries silently annualized to 0 (USAJobs) — this now means
        // every present salary actually turned into a usable annual figure.
        const covParts = [];
        for (const [src, q] of Object.entries(qualBySource)) {
          const pct = q.total ? Math.round((q.salaryPresent / q.total) * 100) : 0;
          let note;
          if (q.salaryPresent === 0) {
            note = SALARY_NEVER.has(src)
              // Say only what's known. This used to assert the cause was ours
              // ("our extractor doesn't capture pay for this source yet"), naming
              // ZR/WWR/Google — sources since REMOVED from SALARY_NEVER once they
              // gained extraction, so the explanation outlived the set it explained.
              // Worse, it was wrong for the one source that matters here: LinkedIn
              // guest job pages were checked live across 10 real postings and carry
              // no baseSalary in their JSON-LD at all, and the only pay elements on
              // the page belong to the "Similar jobs" rail — i.e. ANOTHER posting's
              // pay, which we must never attribute to this one. So 0% here is not a
              // proven extractor gap, and stating it as one sends a reader hunting a
              // bug that may not exist. Report the observation, not a root cause.
              ? 'none carried — pay is not exposed to the scraper on this source (not a regression; see SALARY_NEVER)'
              : 'none carried — no salary values to validate';
          }
          else if (q.salaryUnparseable === 0) note = 'all annualized ✅';
          else note = `${q.salaryUnparseable} unparseable ⚠ (see field-quality issue above)`;
          covParts.push(`\`${src}\`: ${q.salaryPresent}/${q.total} present (${pct}%) — ${note}`);
        }
        if (covParts.length === 1) {
          lines.push(`- Salary coverage (saved snapshot): ${covParts[0]}`);
        } else if (covParts.length > 1) {
          lines.push('- Salary coverage (saved snapshot):');
          for (const p of covParts) lines.push(`  - ${p}`);
        }
        if (!anyQualityIssue && Object.keys(qualBySource).length > 0) {
          lines.push('- Field quality (saved snapshot): ✅ posted, url, and snippet look correct (salary coverage above)');
        }
      }
    } catch { /* snapshot absent or unreadable — omit silently */ }
  } else {
    lines.push('### Search\n- (no search recorded this session — e.g. scoring resumed from a captcha-resolve)');
  }
  // Indeed browser-session preflight (contract: jobsTelemetry.indeedSession,
  // electron/ipc/jobs.js) — recorded once the Indeed scrape browser has
  // navigated far enough to inspect its own cookie jar. A logged-out user is
  // NOT distinguishable from a bot challenge by URL alone (both redirect to
  // secure.indeed.com/auth), and a login that used a different Chrome
  // profile/binary than the scrape cannot share cookies with it — this block
  // is the only place either fact was ever visible. Rendered as observations
  // only: which URL the scrape landed on, whether the session cookie was
  // present, and which binary/profile ran it — never an asserted cause.
  if (t.indeedSession) {
    const isess = t.indeedSession;
    const ppidLabel = isess.hasPPID === true ? 'yes' : isess.hasPPID === false ? 'no' : 'not recorded';
    const cookieList = Array.isArray(isess.cookieNames) && isess.cookieNames.length
      ? isess.cookieNames.map(n => `\`${n}\``).join(', ')
      : '(none observed)';
    lines.push(`\n### Browser session preflight — Indeed${ago(isess.ts)}`);
    lines.push('> Was the browser that ran the scrape actually logged in, and which profile/binary did it use? Observations only — never an asserted cause.');
    lines.push(`- Landed URL: \`${reportUrl(isess.landedUrl, '(unrecorded)')}\``);
    lines.push(`- Preflight status: ${isess.preflightStatus || '(unrecorded)'}${isess.preflightReason ? ` · reason: \`${reportText(isess.preflightReason, '(unrecorded)')}\`` : ''}`);
    lines.push(`- PPID session cookie present: ${ppidLabel}`);
    lines.push(`- Cookie names observed: ${cookieList}`);
    lines.push(`- Chrome executable: \`${String(isess.executablePath || '(unrecorded)').replace(/`/g, "'")}\``);
    lines.push(`- Profile dir: \`${String(isess.userDataDir || '(unrecorded)').replace(/`/g, "'")}\``);
    if (isess.host) lines.push(`- Host: \`${String(isess.host).replace(/`/g, "'")}\``);
  }
  // Resume ("Continue" / "Log in") attempts per source (contract: jobsTelemetry.
  // resumeAttempts, electron/ipc/jobs.js — newest-12-capped per source). This is
  // what makes "I clicked Continue three times and nothing happened" visible: a
  // card only ever shows its CURRENT state, not the history of what each click
  // actually did (which mode ran, and whether it changed anything).
  if (t.resumeAttempts && Object.keys(t.resumeAttempts).length > 0) {
    lines.push('\n### Resume attempts');
    lines.push('> What each Continue / Log in / Solve click on a source card actually did. A card only ever shows its CURRENT state, so a click that changed nothing is otherwise indistinguishable from one that was never made.');
    lines.push('- Per source, newest first:');
    for (const [sid, attempts] of Object.entries(t.resumeAttempts)) {
      const list = Array.isArray(attempts) ? attempts : [];
      if (!list.length) continue;
      const rendered = list.slice().reverse().map(a => {
        const mode = a?.mode || '(no mode recorded)';
        const outcome = a?.outcome || '(no outcome recorded)';
        const detail = a?.detail ? ` — ${historyReportValue(a.detail, '', 120)}` : '';
        return `\`${mode}\`→${outcome}${detail}${ago(a?.t)}`;
      }).join('; ');
      lines.push(`  - \`${sid}\` (${list.length} attempt${list.length === 1 ? '' : 's'}): ${rendered}`);
    }
  }

  if (hasBrowserScrape) {
    lines.push('\n### Active Browser Scrape');
    const a = browserScrape.active;
    if (a) {
      const ageMs = Date.now() - (a.ts || Date.now());
      const bits = [
        a.phase ? `phase ${a.phase}` : null,
        a.srcName || a.sourceId ? `source ${a.srcName || a.sourceId}` : null,
        a.queryIndex && a.queryTotal ? `query ${a.queryIndex}/${a.queryTotal}` : null,
        a.pageNum ? `page ${a.pageNum}` : null,
        a.count != null ? `count ${a.count}` : null,
        `updated ${Math.max(0, Math.round(ageMs / 1000))}s ago`,
      ].filter(Boolean);
      lines.push(`- Current: ${bits.join(' · ')}`);
      if (a.url) lines.push(`  - URL: ${reportUrl(a.url)}`);
      if (a.reason) lines.push(`  - Reason: ${reportText(a.reason, '(unrecorded)', 360)}`);
      if (a.key) lines.push(`  - Key: ${a.key}`);
      if (a.evidence) lines.push(`  - Evidence: ${reportText(a.evidence, '(unrecorded)', 360)}`);
      // Anti-bot challenge diagnostics — present when a challenge fired. These rank
      // the cause: a datacenter/hosting egress IP points at IP reputation; the
      // browser profile rules out "wasn't headful"; the incident ID aids vendor
      // cross-reference. Without these, diagnosing a block needs source + a screenshot.
      if (a.browserProfile) lines.push(`  - Browser: ${a.browserProfile}`);
      if (a.egressIp) {
        // isp/org is the real datacenter-vs-residential tell (a VPN like Proton
        // shows isp "Proton AG" even though ip-api's hosting flag says false). The
        // ⚠ flag fires only on a positive hosting hit; we never assert "residential".
        const who = [a.egressIsp, a.egressOrg]
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .join(' · ');
        const hostingNote = a.egressHosting === true ? ' · **datacenter/hosting ⚠** (anti-bots flag these on sight)' : '';
        lines.push(`  - Egress IP: ${a.egressIp}${who ? ` · ${historyReportValue(who, '', 90)}` : ''}${hostingNote}`);
      }
      if (a.blockId) lines.push(`  - Anti-bot incident ID: ${a.blockId}`);
      if (a.pageState) {
        lines.push(`  - Page state: ${JSON.stringify(a.pageState).slice(0, 360)}`);
      }
    } else {
      lines.push('- Current: (no active scrape)');
    }

    // ── Liveness ─────────────────────────────────────────────────────────────
    // `active` above only advances on telemetry PHASES, and the per-card
    // description walk that dominates a Glassdoor/Google run emits a phase only
    // when something goes WRONG. So a perfectly healthy walk pins `active` to
    // `page-extract` for minutes, and its "updated Ns ago" was the only number a
    // reader had — which made healthy work and a wedged renderer identical.
    // These three lines are what separate them.
    const scrapeIsRunning = !!a && !['idle', 'finished', 'aborted'].includes(a.phase);
    if (browserScrape.paused && scrapeIsRunning) {
      lines.push('- ⏸️ **Scrape is PAUSED by the user** (overlay Pause button) — the silence below is intentional, not a hang.');
    }
    const beat = browserScrape.beat;
    if (beat) {
      const beatAge = Math.max(0, Math.round((Date.now() - (beat.ts || Date.now())) / 1000));
      const beatBits = [
        beat.status ? `“${historyReportValue(beat.status, '', 120)}”` : '(no status text)',
        beat.srcName || beat.sourceId ? `source ${beat.srcName || beat.sourceId}` : null,
        beat.count != null ? `count ${beat.count}` : null,
        `${beatAge}s ago`,
      ].filter(Boolean);
      lines.push(`- Last activity beat: ${beatBits.join(' · ')}`);
      lines.push(scrapeIsRunning
        ? '  - This is the scraper\'s own on-screen progress line, refreshed on every overlay paint (per card, per page, per pagination step). A RECENT beat with a stale phase above means the scrape is working normally and simply has no phase to report. If the beat is stale too, inspect the in-flight operation and active-task age below; staleness alone is not proof of a hang.'
        : '  - Historical final beat only: the scrape is no longer active, so its age must not be interpreted as a stall.');
    } else if (a) {
      lines.push('- Last activity beat: (none recorded — this build\'s scraper predates activity beats, or no overlay paint has happened yet)');
    }
    const inFlight = browserScrape.inFlight;
    if (inFlight) {
      const waitedMs = Math.max(0, Date.now() - (inFlight.since || Date.now()));
      const waited = waitedMs < 60_000 ? `${Math.round(waitedMs / 1000)}s` : `${Math.floor(waitedMs / 60_000)}m${Math.round((waitedMs % 60_000) / 1000)}s`;
      lines.push(`- ⏳ Awaiting right now: **${inFlight.label}**${inFlight.detail ? ` (${inFlight.detail})` : ''} — for ${waited}`);
      // puppeteer-core's Connection default is the only backstop on a wedged
      // renderer; naming it here stops a reader from concluding "hangs forever".
      if (waitedMs > 30_000) {
        lines.push('  - Past 30s. A `page.evaluate` that never returns is abandoned by puppeteer at its 180s protocolTimeout, after which the extractor is retried (3 strikes, then the source stops with an `extractor-error` warning).');
      }
    }
    const scrapeBrowser = browserScrape.browser;
    if (scrapeBrowser) {
      // The "Scrape/stealth browser" line elsewhere in this report is derived
      // from the stealthBrowser singleton, which scrapeManualSources CLOSES
      // before launching its own process. Reporting this one explicitly is what
      // stops that line from reading "not running" mid-scrape.
      const launchedAgo = scrapeBrowser.launchedAt ? `${Math.max(0, Math.round((Date.now() - scrapeBrowser.launchedAt) / 1000))}s ago` : 'unknown';
      lines.push(`- Manual-scrape Chrome: ${scrapeBrowser.running ? '🟢 running' : '⚪ closed'} · launched ${launchedAgo}${scrapeBrowser.pid ? ` · pid ${scrapeBrowser.pid}` : ''}`);
      if (scrapeBrowser.profileDir) {
        const dir = String(scrapeBrowser.profileDir);
        lines.push(`  - Profile: \`${dir.length > 48 ? `…${dir.slice(-48)}` : dir}\``);
      }
      if (scrapeBrowser.running) {
        lines.push('  - This process is separate from the stealthBrowser singleton and holds the SHARED profile directory, so the singleton-derived browser line elsewhere in this report can read "not running" while this one is live.');
      }
    }
    const allScrapeEvents = browserScrape.events || [];
    // Per-listing extraction misses and confirmed unavailable details are the
    // actionable recovery evidence, not ordinary progress. A multi-source run
    // easily pushes an early ZipRecruiter outcome out of the trailing phase
    // slice with later Google events, which made a FULL report less useful than
    // the telemetry it already retained. Render these separately so the compact
    // progress trail can stay bounded without discarding recovery evidence.
    // New telemetry keeps these in a dedicated ring. Fall back to the legacy
    // phase ring for reports generated by an already-running older process.
    const fieldAnomalies = Array.isArray(browserScrape.fieldAnomalies)
      ? browserScrape.fieldAnomalies
      : allScrapeEvents.filter(e => ['desc-miss', 'date-miss', 'detail-unavailable', 'detail-challenge', 'detail-navigation-abort', 'detail-panel-rate-limit', 'detail-panel-http-error', 'detail-block-reprobe', 'detail-block-reprobe-failed', 'detail-block-cleared'].includes(e?.phase));
    // getManualScraperTelemetry deliberately returns defensive entry copies, so
    // object identity cannot distinguish the dedicated anomaly ring from the
    // ordinary event ring here. Classify by the retained phase contract instead
    // of rendering every detail anomaly twice (once bare in Recent phases and
    // once with its full diagnostic evidence below).
    const isDetailAnomaly = e => ['desc-miss', 'date-miss', 'detail-unavailable', 'detail-challenge', 'detail-navigation-abort', 'detail-panel-rate-limit', 'detail-panel-http-error', 'detail-block-reprobe', 'detail-block-reprobe-failed', 'detail-block-cleared'].includes(e?.phase);
    // Run-origin rows (source-start / query-start / the location resolution and
    // host-redirect trail) are emitted at most once per source, so on a long run
    // the 30-slot recency ring evicts them behind per-job chatter — taking the
    // query, the requested location, and any geo-redirect with them. They are
    // retained separately now; render them so the reader keeps the run's
    // identity no matter how long the walk got.
    const origins = Array.isArray(browserScrape.origins) ? browserScrape.origins : [];
    const originsNotInRecent = origins.filter(o => !allScrapeEvents.slice(-8).some(e => e.ts === o.ts && e.phase === o.phase));
    if (originsNotInRecent.length > 0) {
      lines.push('- Source/query origin phases (retained — these are emitted once per source and would otherwise age out of the ring below):');
      for (const e of originsNotInRecent) {
        const ageMs = Date.now() - (e.ts || Date.now());
        const bits = [
          e.phase || 'event',
          e.srcName || e.sourceId || null,
          e.queryIndex && e.queryTotal ? `q${e.queryIndex}/${e.queryTotal}` : null,
          e.url ? `url=${reportUrl(e.url, '(no URL)', 200)}` : null,
          e.intendedHost && e.landedHost ? `${e.intendedHost}→${e.landedHost}` : null,
        ].filter(Boolean).join(' ');
        lines.push(`  - ${bits} -${Math.max(0, Math.round(ageMs / 1000))}s`);
      }
    }
    const recent = allScrapeEvents.filter(e => !isDetailAnomaly(e)).slice(-8);
    if (recent.length > 0) {
      lines.push('- Recent browser-scrape phases:');
      for (const e of recent) {
        const ageMs = Date.now() - (e.ts || Date.now());
        // Chrome-spawn/connect phases get extra fields surfaced directly in the
        // report so the reader immediately knows pid/alive/poll-count without
        // having to cross-reference the raw log.
        const isChromephase = typeof e.phase === 'string' && e.phase.startsWith('chrome-');
        const isChallengePhase = typeof e.phase === 'string' && e.phase.startsWith('challenge-');
        const label = [
          e.phase || 'event',
          e.srcName || e.sourceId || null,
          e.queryIndex && e.queryTotal ? `q${e.queryIndex}/${e.queryTotal}` : null,
          e.pageNum ? `p${e.pageNum}` : null,
          e.itemIndex && e.itemTotal ? `detail${e.itemIndex}/${e.itemTotal}` : null,
          e.key ? `key=${e.key}` : null,
          e.descriptionSource ? `via=${e.descriptionSource}` : null,
          // query-start records the REQUESTED url (task.url); source-finished
          // records the LANDED url (page.url()) — printing whichever is present
          // makes host drift (e.g. requested .com, landed on a regional .ca
          // redirect) visible directly in the phase trail instead of requiring
          // a manual cross-reference against a separate section. reportUrl
          // applies the same query/fragment redaction as every other URL in
          // this file and bounds the length so one long url can't dominate a line.
          e.url ? `url=${reportUrl(e.url, '(unrecorded)', 140)}` : null,
          isChromephase && e.pid != null    ? `pid=${e.pid}`                                    : null,
          isChromephase && e.outcome        ? `outcome=${e.outcome}`                             : null,
          isChromephase && e.alive != null  ? `alive=${e.alive}`                                 : null,
          isChromephase && e.polls != null  ? `polls=${e.polls}`                                 : null,
          isChromephase && e.elapsedMs != null ? `elapsed=${(e.elapsedMs / 1000).toFixed(1)}s`  : null,
          isChromephase && e.error          ? `err=${e.error}`                                   : null,
          isChromephase && e.stderr         ? `stderr=${historyReportValue(e.stderr, '', 200)}`          : null,
          isChallengePhase && e.reason      ? `reason=${historyReportValue(e.reason, '', 80)}`           : null,
          isChallengePhase && e.repeatCount ? `repeat=${e.repeatCount}`                           : null,
          isChallengePhase && e.title       ? `title=${JSON.stringify(historyReportValue(e.title, '', 100))}` : null,
          isChallengePhase && e.pageState   ? `signals=${JSON.stringify(e.pageState).slice(0, 240)}` : null,
          isChallengePhase && e.bodyHead    ? `body=${JSON.stringify(historyReportValue(e.bodyHead, '', 160))}` : null,
          // A skipped source has to say WHY on its own line. Without this the
          // phase read "location-resolution-failed Glassdoor q1/12" and the
          // actual per-endpoint result lived only in the raw log tail.
          e.phase === 'location-resolution-failed' && e.location ? `location="${e.location}"`     : null,
          e.phase === 'location-resolution-failed' && e.failureKind ? `kind=${e.failureKind}`     : null,
          e.phase === 'location-resolution-failed' && e.reason ? `reason=${historyReportValue(e.reason, '', 300)}` : null,
          `-${Math.max(0, Math.round(ageMs / 1000))}s`,
        ].filter(Boolean).join(' ');
        lines.push(`  - ${label}`);
      }
    }
    if (fieldAnomalies.length > 0) {
      const shown = fieldAnomalies.slice(-12);
      lines.push('- Detail-recovery diagnostics (retained independently of recent phases):');
      for (const e of shown) {
        const ageMs = Date.now() - (e.ts || Date.now());
        const label = [
          e.phase,
          e.srcName || e.sourceId || null,
          e.key ? `key=${e.key}` : null,
          e.reason ? `reason=${e.reason}` : null,
          e.repeatCount ? `repeat=${e.repeatCount}` : null,
          e.hardBlock ? 'hardBlock=yes' : null,
          e.title ? `title=${JSON.stringify(historyReportValue(e.title, '', 100))}` : null,
          e.pageState ? `signals=${JSON.stringify(e.pageState).slice(0, 240)}` : null,
          e.status != null ? `HTTP=${e.status}` : null,
          // The panel rate-limit / HTTP-error phases record `url`, not
          // `finalUrl`; reading only the latter printed a bare `HTTP=429` with
          // no endpoint. Page/item position is what shows how far into the walk
          // the throttle landed.
          e.pageNum != null ? `page=${e.pageNum}` : null,
          e.itemIndex != null ? `card=${e.itemIndex}${e.itemTotal != null ? `/${e.itemTotal}` : ''}` : null,
          e.waitedMs != null ? `waited=${Math.round(e.waitedMs / 1000)}s` : null,
          e.attempt != null ? `attempt=${e.attempt}${e.maxAttempts != null ? `/${e.maxAttempts}` : ''}` : null,
          e.expanded != null ? `expanded=${e.expanded}${e.attempted != null ? `/${e.attempted}` : ''}` : null,
          (e.finalUrl || e.url) ? `url=${reportUrl(e.finalUrl || e.url, '(unrecorded)', 140)}` : null,
          e.bodyHead ? `body=${JSON.stringify(historyReportValue(e.bodyHead, '', 180))}` : null,
          e.error ? `err=${historyReportValue(e.error, '', 160)}` : null,
          `-${Math.max(0, Math.round(ageMs / 1000))}s`,
        ].filter(Boolean).join(' ');
        lines.push(`  - ⚠️ ${label}`);
      }
      if (fieldAnomalies.length > shown.length) {
        lines.push(`  - _${fieldAnomalies.length - shown.length} earlier detail-recovery diagnostic(s) omitted from the bounded trail._`);
      }
    }

    // Card traversal is distinct from listing-field quality. A browser can
    // ultimately retain every row yet visibly jump over cards while trying to
    // target them (for example when a board owns an inner scroll container).
    // The old `N/N descriptions expanded` aggregate alone could not prove which
    // positions were recovered or missed, and only a third *consecutive* miss
    // reached the old stale-selector warning. One bounded summary per expansion
    // batch gives a FULL/CARDWALK report the actual walk without printing every
    // successful card or making report size proportional to result count.
    const cardWalks = allScrapeEvents.filter(e => e?.phase === 'card-walk');
    if (cardWalks.length > 0) {
      lines.push('- Browser card traversal (bounded batch summaries):');
      for (const e of cardWalks.slice(-8)) {
        const total = Number(e.total ?? e.itemTotal ?? 0);
        const attempted = Number(e.attempted ?? 0);
        const expanded = Number(e.expanded ?? 0);
        const missing = Number(e.missing ?? 0);
        const panelTimeouts = Number(e.panelTimeouts ?? 0);
        const panelRateLimits = Number(e.panelRateLimits ?? 0);
        const panelHttpFailures = Number(e.panelHttpFailures ?? 0);
        const panelRequestsIssued = Number(e.panelRequestsIssued ?? 0);
        const proactivePanelCooldowns = Number(e.proactivePanelCooldowns ?? 0);
        const panelJsonResponses = Number(e.panelJsonResponses ?? 0);
        const panelJsonPayloads = Number(e.panelJsonPayloads ?? 0);
        const panelJsonDescriptionFallbacks = Number(e.panelJsonDescriptionFallbacks ?? 0);
        const panelJsonFieldRecoveries = e.panelJsonFieldRecoveries && typeof e.panelJsonFieldRecoveries === 'object'
          ? e.panelJsonFieldRecoveries
          : {};
        const panelJsonFieldRecoveryTotal = ['salary', 'posted', 'company']
          .reduce((sum, field) => sum + Number(panelJsonFieldRecoveries[field] ?? 0), 0);
        const panelPacing = e.panelPacing && typeof e.panelPacing === 'object' ? e.panelPacing : null;
        const titleBypassed = Number(e.titleBypassed ?? 0);
        // A modal can cover an otherwise-correct card without changing the
        // card selector or panel selector. Keep that distinct from stale
        // markup: the browser walker records both successful dismissals and
        // cases where it found a blocker but could not clear it.
        const blockingModalsDismissed = Number(e.blockingModalsDismissed ?? 0);
        const blockingModalFailures = Number(e.blockingModalFailures ?? 0);
        // The post-click selected-card probe is separate from the pre-click
        // hit-test. A correct physical hit does not, by itself, prove that the
        // board activated that same row after its event handler ran.
        const selectionMismatches = Number(e.selectionMismatches);
        // A cancellation is a normal terminal state, but it is very different
        // from a missing card or selector failure. Keep its position/reason on
        // the same bounded walk line so a partial walk cannot be mistaken for a
        // recurring every-Nth-card miss.
        const aborted = e.aborted === true || e.interrupted === true || e.cancelled === true;
        // `interruptedAt` is the next 1-based target the walker did not reach;
        // report it as "before" rather than falsely claiming that card was
        // attempted. Older/alternate producers may provide an actual completed
        // `abortedAt` / `abortIndex`, which is correctly phrased as "after".
        const interruptedAt = Number(e.interruptedAt);
        const completedAt = Number(e.abortedAt ?? e.abortIndex ?? e.stopIndex ?? attempted);
        const abortPosition = Number.isFinite(interruptedAt) && interruptedAt > 0
          ? ` before #${interruptedAt}`
          : Number.isFinite(completedAt) && completedAt > 0 ? ` after #${completedAt}` : '';
        const abortReason = e.abortReason ?? e.interruptReason ?? e.stopReason ?? e.reason;
        const abortLabel = aborted
          ? `${e.aborted === true || e.cancelled === true ? 'aborted' : 'interrupted'}${abortPosition}${abortReason ? ` (${historyReportValue(abortReason, '', 160)})` : ''}`
          : null;
        const label = [
          e.srcName || e.sourceId || 'source',
          e.strategy ? `strategy=${String(e.strategy).slice(0, 80)}` : null,
          e.panelSelector ? `panel=${JSON.stringify(String(e.panelSelector).slice(0, 180))}` : null,
          e.queryIndex && e.queryTotal ? `q${e.queryIndex}/${e.queryTotal}` : null,
          e.pageNum ? `p${e.pageNum}` : null,
          `attempted ${attempted}/${total}`,
          `expanded ${expanded}/${total}`,
          missing > 0 ? `missing-target ${missing}` : null,
          panelTimeouts > 0 ? `panel-timeout ${panelTimeouts}` : null,
          panelRateLimits > 0 ? `panel-http-429 ${panelRateLimits} (source throttle; walk stopped)` : null,
          panelHttpFailures > 0 ? `panel-http-other ${panelHttpFailures} (source response; walk stopped)` : null,
          panelPacing?.requestDelayMs
            ? `panel-pace ${Math.round(Number(panelPacing.requestDelayMs) / 100) / 10}s${panelPacing.checkpointEvery && panelPacing.checkpointCooldownMs ? ` + ${Math.round(Number(panelPacing.checkpointCooldownMs) / 100) / 10}s/${panelPacing.checkpointEvery}` : ''}`
            : null,
          proactivePanelCooldowns > 0 ? `proactive-panel-cooldowns ${proactivePanelCooldowns}` : null,
          panelRequestsIssued > 0 ? `panel-requests ${panelRequestsIssued}` : null,
          panelJsonResponses > 0 ? `same-request-json ${panelJsonPayloads}/${panelJsonResponses} usable` : null,
          panelJsonDescriptionFallbacks > 0 ? `json-description-fallback ${panelJsonDescriptionFallbacks}` : null,
          panelJsonFieldRecoveryTotal > 0
            ? `json-field-recovery ${['salary', 'posted', 'company'].filter(field => Number(panelJsonFieldRecoveries[field] ?? 0) > 0).map(field => `${field}=${Number(panelJsonFieldRecoveries[field])}`).join(',')}`
            : null,
          Number.isFinite(selectionMismatches) ? `selection-mismatches ${selectionMismatches}` : null,
          blockingModalsDismissed > 0 ? `blocking-popup-dismissed ${blockingModalsDismissed}` : null,
          blockingModalFailures > 0 ? `blocking-popup-dismiss-failed ${blockingModalFailures}` : null,
          titleBypassed > 0 ? `title-bypassed ${titleBypassed} (intentional, page-local)` : null,
          abortLabel,
        ].filter(Boolean).join(' · ');
        lines.push(`  - ${label}`);
        const samples = Array.isArray(e.failureSamples) ? e.failureSamples.slice(0, 6) : [];
        for (const sample of samples) {
          const index = Number(sample?.itemIndex);
          const position = Number.isFinite(index) && index > 0 ? `#${index}` : '#?';
          const key = sample?.key ? ` key=${String(sample.key).slice(0, 100)}` : '';
          const reason = sample?.reason ? ` reason=${historyReportValue(sample.reason, '', 160)}` : '';
          lines.push(`    - ⚠️ ${position}${key}${reason}`);
        }
        const modalSamples = Array.isArray(e.modalSamples) ? e.modalSamples.slice(0, 6) : [];
        if (modalSamples.length > 0) {
          lines.push('    - Blocking popup handling:');
          for (const sample of modalSamples) {
            const index = Number(sample?.itemIndex);
            const position = Number.isFinite(index) && index > 0 ? `#${index}` : '#?';
            const stage = sample?.stage ? ` · stage=${String(sample.stage).slice(0, 80)}` : '';
            const signature = sample?.signature ? ` · signature=${String(sample.signature).slice(0, 120)}` : '';
            const control = sample?.control ? ` · control=${String(sample.control).slice(0, 100)}` : '';
            const outcome = sample?.outcome ? ` · outcome=${String(sample.outcome).slice(0, 100)}` : '';
            const failed = sample?.outcome && sample.outcome !== 'dismissed';
            lines.push(`      - ${failed ? '⚠️ ' : ''}${position}${stage}${signature}${control}${outcome}`);
          }
          if (Array.isArray(e.modalSamples) && e.modalSamples.length > modalSamples.length) {
            lines.push(`      - _${e.modalSamples.length - modalSamples.length} additional popup-handling sample(s) omitted from the bounded trace._`);
          }
        }
        // Failures alone cannot diagnose a visible "every other card" jump:
        // all clicks can succeed while the browser resolves a neighbouring
        // virtualized card. Preserve a small transition trace with both the
        // requested identity and the element actually hit. Accept `resolved*`
        // aliases because the browser walker records a resolved DOM identity;
        // `hit*` makes the report's meaning clearer to the person reading it.
        const transitions = Array.isArray(e.transitionSamples) ? e.transitionSamples.slice(-8) : [];
        // An all-matching sample set costs ~6 lines x ~135 chars per batch and
        // asserts exactly what the summary line's `selection-mismatches 0`
        // already states for free. Across the 8 retained batches that was ~7k
        // chars of the 50k clipboard budget — enough, on a 30-page Glassdoor
        // run, to push six whole sections out of the export entirely. Collapse
        // the confirming case to one line that still carries the proof these
        // samples exist for (the walk's first->last physical span); a mismatch
        // is never collapsed, so the diagnostic case loses nothing.
        const transitionMismatched = (sample) => {
          const expectedKey = sample?.expectedKey ?? sample?.expected?.key ?? sample?.key;
          const hitKey = sample?.hitKey ?? sample?.resolvedKey ?? sample?.resolved?.key;
          return sample?.mismatch === true
            || sample?.selectionMismatch === true
            || (!!expectedKey && !!hitKey && String(expectedKey) !== String(hitKey));
        };
        const collapseTransitions = transitions.length > 2 && !transitions.some(transitionMismatched);
        if (collapseTransitions) {
          const firstPhys = Number(transitions[0]?.physicalIndex);
          const lastPhys = Number(transitions[transitions.length - 1]?.physicalIndex);
          const physTotal = Number(transitions[transitions.length - 1]?.physicalTotal);
          const span = Number.isFinite(firstPhys) && Number.isFinite(lastPhys) && firstPhys > 0
            ? ` · physical #${firstPhys}→#${lastPhys}${Number.isFinite(physTotal) && physTotal > 0 ? ` of ${physTotal}` : ''}`
            : '';
          const lookups = [...new Set(transitions.map(t => t?.lookup).filter(Boolean))].map(v => String(v).slice(0, 40));
          const via = lookups.length > 0 ? ` · via ${lookups.slice(0, 3).join('/')}` : '';
          const verified = transitions.filter(t => t?.selectionVerified === true).length;
          const verifiedNote = verified > 0 ? ` · ${verified} selection-verified` : '';
          lines.push(`    - Click transition samples: all ${transitions.length} sampled click(s) hit the expected card${span}${via}${verifiedNote} — collapsed; a mismatch is always listed individually.`);
          const collapsedTotal = e.transitionSamples.length;
          if (collapsedTotal > transitions.length) {
            lines.push(`      - _${collapsedTotal - transitions.length} earlier transition sample(s) omitted from the bounded trace._`);
          }
        }
        if (transitions.length > 0 && !collapseTransitions) {
          lines.push('    - Click transition samples (expected → hit):');
          for (const sample of transitions) {
            const index = Number(sample?.itemIndex ?? sample?.index);
            const position = Number.isFinite(index) && index > 0 ? `#${index}` : '#?';
            const physicalIndex = Number(sample?.physicalIndex);
            const physicalTotal = Number(sample?.physicalTotal);
            const physicalPosition = Number.isFinite(physicalIndex) && physicalIndex > 0
              ? ` · physical #${physicalIndex}${Number.isFinite(physicalTotal) && physicalTotal > 0 ? `/${physicalTotal}` : ''}`
              : '';
            const skippedSincePrevious = Number(sample?.skippedSincePrevious);
            const physicalGap = Number.isFinite(skippedSincePrevious) && skippedSincePrevious > 0
              ? ` · ${skippedSincePrevious} physical card${skippedSincePrevious === 1 ? '' : 's'} skipped since previous`
              : '';
            const expectedKey = sample?.expectedKey ?? sample?.expected?.key ?? sample?.key;
            const expectedTitle = sample?.expectedTitle ?? sample?.expected?.title;
            const hitKey = sample?.hitKey ?? sample?.resolvedKey ?? sample?.resolved?.key;
            const hitTitle = sample?.hitTitle ?? sample?.resolvedTitle ?? sample?.resolved?.title;
            const selectedTitle = sample?.selectedTitle ?? sample?.selected?.title;
            const lookup = sample?.lookup ? ` via ${String(sample.lookup).slice(0, 80)}` : '';
            const identityMismatch = sample?.mismatch === true
              || (!!expectedKey && !!hitKey && String(expectedKey) !== String(hitKey));
            const selectionMismatch = sample?.selectionMismatch === true;
            const selectionVerified = sample?.selectionVerified === true;
            const expected = [
              expectedKey ? `key=${String(expectedKey).slice(0, 100)}` : null,
              expectedTitle ? `title=${historyReportValue(expectedTitle, '', 100)}` : null,
            ].filter(Boolean).join(' ');
            const hit = [
              hitKey ? `key=${String(hitKey).slice(0, 100)}` : null,
              hitTitle ? `title=${historyReportValue(hitTitle, '', 100)}` : null,
            ].filter(Boolean).join(' ');
            const selected = selectedTitle
              ? ` → selected title=${historyReportValue(selectedTitle, '', 100)}`
              : '';
            const selectionStatus = selectionMismatch
              ? ' [SELECTION MISMATCH]'
              : selectionVerified ? ' [selection verified]'
                : '';
            lines.push(`      - ${identityMismatch ? '⚠️ ' : ''}${position}${physicalPosition}${physicalGap} expected ${expected || '(identity unavailable)'} → hit ${hit || '(identity unavailable)'}${lookup}${identityMismatch ? ' [MISMATCH]' : ''}${selected}${selectionStatus}`);
          }
          const totalTransitions = e.transitionSamples.length;
          if (totalTransitions > transitions.length) {
            lines.push(`      - _${totalTransitions - transitions.length} earlier transition sample(s) omitted from the bounded trace._`);
          }
        }
      }
      if (cardWalks.length > 8) {
        lines.push(`  - _${cardWalks.length - 8} earlier card-walk batch summary(s) omitted from the bounded trail._`);
      }
    }
  }

  // Glassdoor's location filter is keyed by a numeric locId that has to be
  // resolved through a Cloudflare-gated in-browser autocomplete, and a failed
  // resolve SKIPS the whole source. Whether a cached, country-verified entry
  // existed is therefore the difference between "this run had to make that
  // fragile call" and "it should never have needed to" — unanswerable from the
  // rest of the report, so it is printed whenever the question can come up.
  // Glassdoor ACCEPTS a nation-tier locId and echoes the requested country in
  // its page header, but does not filter on it (measured: `_IN1` returned
  // Ontario listings titled "United States jobs"; one province out-counted all
  // of Canada). Reported from telemetry rather than as a source warning — the
  // warning channel would both occupy the single per-source slot ahead of a real
  // block and, because any info-severity warning maps to terminal status
  // 'skipped', make a fully successful run read as skipped.
  // Scroll-source reveal outcome. Rendered because the failure it detects is
  // SILENT by construction: Google's list only loads on trusted wheel input, and
  // scrolling it any other way produces a clean run of ~20 cards that terminates
  // without complaint and is indistinguishable from a genuinely small result
  // set. The one tell is that it ends on a no-growth plateau rather than the
  // board's own end-of-list marker. Measured bound for context: six unrelated
  // high-volume roles all exhausted between 174 and 194 cards, so a reveal that
  // plateaus in the low tens has almost certainly not seen the whole list.
  const revealRuns = originPool.filter(e => e?.phase === 'reveal-finished');
  if (revealRuns.length > 0) {
    lines.push('\n### Scroll reveal');
    for (const e of revealRuns.slice(0, 6)) {
      const count = Number(e.count) || 0;
      const viaMarker = e.exit === 'end-of-list';
      // State the observation; do NOT assert the cause. A small corpus plateaus
      // legitimately, and only the board's marker proves completeness.
      const note = viaMarker
        ? 'ended on the board\'s end-of-list marker — the full list was revealed'
        : e.exit === 'plateau'
          ? `ended on a no-growth plateau, NOT the board's end-of-list marker — completeness is unproven${count > 0 && count < 60 ? ' (and this count is far below the 174-194 range every high-volume query exhausted at, which is the signature of a reveal that never loaded)' : ''}`
          : `ended: ${e.exit || 'unknown'}`;
      lines.push(`- \`${e.sourceId || '?'}\`: revealed ${count} card(s) over ${Number(e.iterations) || 0} pass(es) — ${note}`);
    }
  }

  const nationTierNotes = originPool.filter(e => e?.phase === 'location-nation-tier-unenforced');
  if (nationTierNotes.length > 0) {
    lines.push('\n### Country scope not enforced');
    for (const e of nationTierNotes.slice(0, 4)) {
      lines.push(
        `- \`${e.sourceId || '?'}\` requested country "${e.location || '?'}" (locId ${e.locId || '?'}, nation tier)`
        + ' — the board accepts and echoes it but does not filter on it, so these rows follow this machine\'s'
        + ' browsing region. The header naming the country is NOT evidence of scoping; the location adherence'
        + ' summary above is. Set a state/province or city to actually scope this source — those tiers ARE enforced.',
      );
    }
  }

  const locationSkips = originPool.filter(e => e?.phase === 'location-resolution-failed');
  let glassdoorLocCache = {};
  try { glassdoorLocCache = getGlassdoorLocIdCache() || {}; } catch { /* store may not be ready */ }
  const cacheKeys = Object.keys(glassdoorLocCache);
  if (locationSkips.length > 0 || cacheKeys.length > 0) {
    lines.push('\n### Glassdoor Location Cache');
    lines.push('> Persisted location → locId map. `country` is the ISO the entry was validated');
    lines.push('> against; an entry WITHOUT one predates that field and is normally re-resolved');
    lines.push('> on a country-scoped run. Exact Canada/US nation roots are safely upgraded in place.');
    if (cacheKeys.length === 0) {
      lines.push('- (empty — every location resolve this run had to go to the live autocomplete)');
    } else if (omitJobAudit) {
      lines.push(`- ${cacheKeys.length} cached location(s) omitted by filter code — XJOBAUDIT.`);
    } else {
      for (const key of cacheKeys.slice(0, 12)) {
        const entry = glassdoorLocCache[key] || {};
        const provenance = formatGlassdoorCacheProvenance(entry);
        lines.push(`- \`${key}\` → locId ${entry.locId ?? '(none)'}/${entry.locT ?? '?'} · ${provenance}`);
      }
      if (cacheKeys.length > 12) lines.push(`- _${cacheKeys.length - 12} further cached location(s) omitted._`);
    }
    for (const skip of locationSkips.slice(-3)) {
      const cached = glassdoorLocCache[String(skip.location || '').trim().toLowerCase()];
      lines.push(`- Skipped \`${skip.srcName || skip.sourceId}\` for "${skip.location}" (${skip.failureKind || 'kind not recorded'}): `
        + `${cached ? `a cached entry ${cached.country ? `(country ${cached.country}) ` : '(no country provenance) '}was present` : 'no cached entry was present'}`
        + `${skip.attempts ? ` · ${skip.attempts} lookup attempt(s) recorded` : ''}`);
    }
  }

  // Browser-side console errors / network failures captured by the Puppeteer
  // stealth page — the signals that used to require manual DevTools export.
  const consoleLogs   = browserScrape?.consoleLogs   || [];
  const networkErrors = browserScrape?.networkErrors || [];
  if (consoleLogs.length > 0 || networkErrors.length > 0) {
    lines.push('\n### Browser Console & Network Errors');
    lines.push('> Captured automatically from the Puppeteer stealth page. Timestamps are seconds before this report was generated.');
    if (networkErrors.length > 0) {
      lines.push('**Network:**');
      for (const e of networkErrors.slice(-20)) {
        const ageS = Math.max(0, Math.round((Date.now() - e.ts) / 1000));
        const detail = e.status ? `HTTP ${e.status}` : e.errorText;
        lines.push(`- [-${ageS}s] ${e.method} ${reportUrl(e.url, '(unrecorded)')} → ${reportText(detail, '(unrecorded)', 240)}`);
      }
    }
    if (consoleLogs.length > 0) {
      lines.push('**Console:**');
      for (const e of consoleLogs.slice(-40)) {
        const ageS = Math.max(0, Math.round((Date.now() - e.ts) / 1000));
        // Use the redacted source path, never the raw query string. This keeps
        // console provenance while avoiding opaque provider/challenge tokens.
        const tail = e.url ? reportUrl(e.url, '', 180).split('/').pop() : '';
        const src = e.url ? ` (${tail.slice(0, 60)}${tail.length > 60 ? '…' : ''}${e.line != null ? `:${e.line}` : ''})` : '';
        lines.push(`- [-${ageS}s] [${e.type}] ${reportText(e.text, '(no message)', 300)}${src}`);
      }
    }
  }

  // Captcha-resolve / Solve path. Indeed (and other captcha-walled sources)
  // only ever reach scoring through here, so this is where their "found →
  // analyzed" accounting lives — and the line a "did we re-show old jobs?"
  // report turns on. historyDropped>0 with kept=0 is the healthy answer to
  // "I solved the captcha again and saw the same jobs": now they're suppressed.
  if (hasResolves) {
    // One line per resolved source (newest first) so a multi-source recovery
    // — e.g. Indeed then LinkedIn — shows every resolve, not just the last.
    const entries = Object.entries(t.resolves).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
    lines.push('\n### Captcha-resolve / Solve');
    for (const [sourceId, r] of entries) {
      // LinkedIn's Solve isn't a captcha-extract — it's an anonymous description
      // re-fetch (no login: descriptions come from cookieless guest pages, so the
      // session is irrelevant). Its own outcome fields render on a dedicated line.
      if (r.kind === 'linkedin-reenrich') {
        const rot = r.contextRotations != null ? `, ${r.contextRotations} ctx-rotation(s)` : '';
        if (r.skippedSameIp) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → **immediate retry deferred; observed IP unchanged**${r.warmIp ? ` (still ${r.warmIp})` : ''} — wait about 1 minute, then Solve on this IP, or switch VPN to a different working egress and Solve now.`);
        } else if (r.browserUnavailable) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → **browser/profile contention — retryable**${r.stillEmpty != null ? ` (${r.stillEmpty} still empty)` : ''}. Close the other captcha/login window, then Solve again; no LinkedIn descriptions were fetched in this pass.`);
        } else if (r.walled) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetch **hit a guest wall** after +${r.enrichSuccess ?? 0}/${r.needEnrich ?? '?'}${rot}${r.stillEmpty != null ? `, ${r.stillEmpty} still empty` : ''}${r.warmIp ? `, observed IP ${r.warmIp}` : ''}. _Anonymous guest limit, not a login issue — its key may be IP, guest context, or fingerprint/session. Wait about 1 minute then Solve on this IP, or switch VPN to a different working egress and Solve now._`);
        } else if (r.needEnrich != null) {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetched +${r.enrichSuccess ?? 0}/${r.needEnrich}${rot}${r.stillEmpty != null ? `, ${r.stillEmpty} still empty` : ''}`);
        } else {
          lines.push(`- \`${sourceId}\`${ago(r.ts)}: Solve → re-fetch (no jobs needed descriptions)`);
        }
        if (r.merge && Number.isFinite(Number(r.cumulativeMergeNet))) {
          const latestNet = Number(r.merge.pendingAfter) - Number(r.merge.pendingBefore);
          const cumulative = Number(r.cumulativeMergeNet);
          lines.push(`  - Queue merge: latest ${latestNet >= 0 ? '+' : ''}${latestNet} (${r.merge.pendingBefore}→${r.merge.pendingAfter}); cumulative net from this source's Solve passes: ${cumulative >= 0 ? '+' : ''}${cumulative}.`);
        }
        continue;
      }
      if (r.kind === 'description-retry') {
        const unavailable = Array.isArray(r.unavailableDescriptions) ? r.unavailableDescriptions : [];
        lines.push(`- \`${sourceId}\`${ago(r.ts)}: description retry → recovered ${r.recoveredDescriptions || 0}/${r.attemptedDescriptions || 0} · ${r.remainingDescriptions || 0} still below scoring threshold${unavailable.length ? ` · **${unavailable.length} unavailable listing(s) removed**` : ''}${r.challengeReason ? ` · stopped by ${r.challengeReason}` : ''}`);
        for (const item of unavailable.slice(0, 5)) {
          lines.push(`  - Removed unavailable listing: "${historyReportValue(item?.title, '(untitled)', 140)}"${item?.url ? ` · ${reportUrl(item.url, '(no URL)', 500)}` : ''}${item?.reason ? ` (${reportText(item.reason, '(unrecorded)', 180)})` : ''}`);
        }
        continue;
      }
      // If the renderer reported the actual merge outcome, show net pendingJobs
      // change. Without it, "new: N" from the IPC side overstates the contribution
      // when the resolver re-opened a page the initial scrape already captured
      // (same-source jobs are replaced, so the net change may be 0 even if kept=N).
      const m = r.merge;
      let mergeNote;
      if (m != null) {
        const netChange = m.pendingAfter - m.pendingBefore;
        const netStr = netChange >= 0 ? `+${netChange}` : `${netChange}`;
        mergeNote = ` → replaced ${m.replacedExisting} existing → **net pendingJobs ${netStr} (${m.pendingBefore}→${m.pendingAfter})**`;
      } else {
        mergeNote = ` → **new (to history): ${r.kept}**`;
      }
      const extractionLabel = r.enrichment ? 'score-safe returned' : 'inline-extracted';
      lines.push(
        `- \`${sourceId}\`${ago(r.ts)}: ${extractionLabel} ${r.extracted}${r.relevanceDropped > 0 ? ` → title-relevance-dropped ${r.relevanceDropped}` : ''} → age-dropped ${r.ageDropped} → ` +
        `already-seen/history ${r.historyDropped}${mergeNote}`,
      );
      if (r.relevanceDropped > 0) {
        const samples = (Array.isArray(r.relevanceRejected) ? r.relevanceRejected : []).slice(0, 8);
        lines.push(`  - Rejected resolved recommendation(s) before history/scoring${samples.length ? `: ${samples.map(title => `"${title}"`).join(', ')}` : '.'}`);
      }
      lines.push(...historyDropEvidenceLines(r.historyDropSamples, r.historyDropped, '  '));
      if (r.enrichment) {
        const e = r.enrichment;
        const verdict = (e.empty || 0) === 0 ? '✅' : '⚠️';
        const failureNote = e.failed ? ' (detail pass failed; only already-description-complete rows were retained)' : '';
        const targetNote = Number.isFinite(e.targeted) && e.targeted !== e.attempted
          ? ` of ${e.targeted} deferred target(s)` : '';
        const providerNote = Number.isFinite(e.providerRowsLoaded)
          ? ` · provider rows loaded ${e.providerRowsLoaded}` : '';
        const completeNote = Number.isFinite(e.completeTotal)
          ? ` · complete source total ${e.completeTotal}` : '';
        const unavailableNote = Number(e.unavailable) > 0
          ? ` · **not in current provider list ${e.unavailable}**` : '';
        const recommendationNote = Number(e.consecutiveNoMatchPasses) > 0
          ? ` · **${e.recoveryRecommendation === 'skip' ? 'Skip' : 'Retry'} recommended after ${e.consecutiveNoMatchPasses} unchanged full-list check${e.consecutiveNoMatchPasses === 1 ? '' : 's'}**`
          : '';
        lines.push(`  - Resolve detail enrichment: attempted ${e.attempted || 0}${targetNote} → recovered this attempt ${e.succeeded ?? e.enriched ?? 0} → still empty ${e.empty || 0} ${verdict}${providerNote}${completeNote}${unavailableNote}${recommendationNote}${failureNote}`);
        for (const sample of Array.isArray(e.unavailableSamples) ? e.unavailableSamples : []) {
          lines.push(`    - unavailable now: "${sample?.title || '(untitled)'}"${sample?.url ? ` · ${reportUrl(sample.url)}` : ''}`);
        }
        for (const sample of Array.isArray(e.emptySamples) ? e.emptySamples : []) {
          lines.push(`    - missing: "${sample?.title || '(untitled)'}"${sample?.url ? ` · ${reportUrl(sample.url)}` : ''}`);
        }
      }
      if (r.extracted > 0 && r.kept === 0) {
        lines.push('  - _(every extracted job was already shown on a prior run — correctly suppressed, not re-analyzed)_');
      }
      // Net change = 0 means the resolve refreshed existing same-source jobs but
      // added nothing to the scoring queue. Explains "new: N" vs "scored: M" gaps.
      if (m != null && m.pendingAfter === m.pendingBefore && m.replacedExisting > 0) {
        lines.push(`  - _(replaced ${m.replacedExisting} existing ${sourceId} jobs with fresh data; net pendingJobs unchanged — these count toward scoring already)_`);
      }
      // The "why" behind a 0-extract — turns "Solve did nothing" into a named
      // cause: how the window closed, what the inline extractor returned, and
      // whether a wall was up. Without it a 0 could be a stale extractor, a
      // thrown extractor, a genuinely empty page, or a window closed too early.
      const d = r.diag;
      if (d) {
        const bits = [`closed: ${d.closeReason}`, `extractor: ${d.extractOutcome}`];
        if (d.postprocessOutcome) bits.push(`detail postprocess: ${d.postprocessOutcome}`);
        if (d.textLen != null) bits.push(`page textLen ${d.textLen}`);
        if (d.sawChallenge) bits.push('challenge seen');
        if (d.sawConsent) bits.push('consent wall seen');
        if (d.finalHost) bits.push(`host ${d.finalHost}`);
        // The host alone cannot distinguish a user who successfully reached
        // Glassdoor's results/home page from one who closed on the login or
        // challenge URL. These are captured by the visible resolve window
        // immediately before close (when available), and make a manual close
        // actionable instead of the ambiguous "never-extracted, textLen 0".
        if (d.finalUrl) bits.push(`final URL: \`${reportUrl(d.finalUrl, '(unrecorded)', 500)}\``);
        if (d.finalTitle) bits.push(`final title: "${historyReportValue(d.finalTitle, '', 180).replace(/"/g, "'")}"`);
        if (d.hostMismatch) bits.push(`probe skipped: ${d.probeSkippedReason || 'host-mismatch'}`);
        lines.push(`  - resolve detail: ${bits.join(' · ')}`);
        // Stale-selector / changed-layout fingerprint: the extractor matched 0
        // on a page that had real text and no challenge/consent that would have
        // hidden the results — i.e. the page rendered but the selectors missed it.
        if (r.extracted === 0 && d.extractOutcome === 'matched 0' && !d.sawChallenge && !d.sawConsent && (d.textLen || 0) > 0) {
          lines.push('  - ⚠️ extractor matched 0 on a content-bearing page with no challenge/consent up — the source\'s layout likely changed (stale selectors), NOT a genuinely empty result. This is the "I solved it and saw jobs, but it failed" case.');
        }
      }
    }
  }

  // LinkedIn enrichment egress-IP trail. It records whether a verified profile
  // session was attempted before the guest fallback, plus egress/browser process
  // for each pass. IP/browser observations alone do NOT identify the quota key:
  // every completed pass shrinks the remaining job pool, and a changed IP can
  // independently be warmer/cooler. The report must preserve that uncertainty.
  const enrichTrail = Array.isArray(t.linkedinEnrich) ? t.linkedinEnrich : [];
  if (enrichTrail.length > 0) {
    lines.push('\n### LinkedIn enrichment — egress IP / browser trail');
    lines.push('> The IP/browser columns document observations; they do not by themselves prove whether a guest limit is IP- or browser/session-scoped. Per-pass yield is not comparable when the remaining pool changes.');
    lines.push('> A cooldown can be bounded only by a re-attempt on the **same observed IP and browser process** after a wall. The "idle" column is the gap before each pass, not proof that an IP change recovered by waiting.');
    // Compact gap formatter: minutes once past 60s, else seconds.
    const fmtGap = (ms) => ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
    let prevIp = null;
    let prevTs = null;
    for (const e of enrichTrail) {
      const kind = e.kind === 'solve' ? 'Solve' : e.kind === 'probe' ? 'probe' : 'search';
      // Idle gap before this pass = time the limit was left to cool = this pass's
      // START minus the previous pass's END. Using startedAt (not ts, the end)
      // excludes a clean pass's own multi-minute enrichment from the gap.
      const idleMs = prevTs != null ? ((e.startedAt ?? e.ts) - prevTs) : null;
      const idleStr = idleMs != null ? ` · +${fmtGap(Math.max(0, idleMs))} idle` : '';
      let ipStr;
      if (e.ipOk === false) ipStr = '**IP lookup FAILED** (null)';
      else if (e.ip) {
        const changed = prevIp == null ? '' : (e.ip === prevIp ? ' **(unchanged ⚠)**' : ' (changed ✓)');
        ipStr = `IP ${e.ip}${changed}`;
      } else ipStr = 'IP not looked up (clean pass)';
      // Per-pass no-desc, split soft-block (recoverable) vs genuine (permanent).
      // Surfacing it here is what makes cross-pass transience visible — e.g. a pass
      // reporting "40 no-desc [38 soft-block]" followed by one reporting "8 no-desc"
      // proves the soft-blocks were rate-limit artifacts, not missing descriptions.
      const nd = e.noDesc ?? 0;
      const ndStr = nd > 0
        ? `, ${nd} no-desc${e.noDescSoftBlock != null ? ` [${e.noDescSoftBlock} soft-block${e.noDescGenuine ? `, ${e.noDescGenuine} genuine` : ''}]` : ''}`
        : '';
      const attemptedStr = e.attempted != null
        ? `, attempted ${e.attempted}${e.remainingBefore != null && e.remainingBefore !== e.attempted ? `/${e.remainingBefore} remaining` : ''}`
        : '';
      let outcome;
      if (e.skippedSameIp) outcome = 'immediate retry deferred — observed IP unchanged';
      else if (e.browserUnavailable) outcome = `**browser/profile contention — retryable**${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''} · close the other captcha/login window, then Solve`;
      // Dead egress (VPN landed on a server with no internet) — distinct from a
      // rate-limit wall: every fetch failed at the transport layer. The remedy is
      // a DIFFERENT (working) VPN server, not waiting out a cooldown.
      else if (e.noInternet) outcome = `🔌 **no internet on this IP** (egress offline) — +${e.enriched ?? 0}${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''}${ndStr} · switch to a WORKING VPN server, then Solve`;
      else if (e.walled) outcome = `walled, +${e.enriched ?? 0}${attemptedStr}${e.stillEmpty != null ? `, ${e.stillEmpty} still empty` : ''}${ndStr}${e.contextRotations != null ? `, ${e.contextRotations} rot` : ''}`;
      // No URL wall, but soft-blocks (gutted pages) mean it was still rate-limited —
      // don't call that a "clean finish", it overstates what happened.
      else if ((e.noDescSoftBlock || 0) > 0) outcome = `**soft-blocked finish** (no URL wall, but gutted pages), +${e.enriched ?? 0}${attemptedStr}${e.stillEmpty ? `, ${e.stillEmpty} still empty` : ''}${ndStr}${e.contextRotations != null ? `, ${e.contextRotations} rot` : ''}`;
      else outcome = `**clean finish**, +${e.enriched ?? 0}${attemptedStr}${e.stillEmpty ? `, ${e.stillEmpty} still empty` : ''}${ndStr}`;
      // Browser identity and lifetime are descriptive context only. A rising
      // lifetime and falling yield are expected as earlier passes consume work.
      let browserStr = '';
      if (e.browserGen != null) {
        const ageS = e.browserAgeMs != null ? `${Math.round(e.browserAgeMs / 1000)}s old` : 'age ?';
        browserStr = ` · browser#${e.browserGen} (${ageS}, lifetime ${e.browserLifetimeBefore ?? 0}→${e.browserLifetimeAfter ?? 0})`;
      }
      const modeStr = e.usedAuthenticated
        ? (e.authenticatedFallback ? ' · profile session → guest fallback' : ' · profile session')
        : ' · guest context';
      lines.push(`- ${kind}${ago(e.ts)}${idleStr}: ${ipStr} → ${outcome}${modeStr}${browserStr}`);
      if (e.ip) prevIp = e.ip;
      prevTs = e.ts;
    }
    // Cross-pass verdict — "did the IP change work, and is the limit IP- or
    // browser-scoped?".
    const solves = enrichTrail.filter(e => e.kind === 'solve');
    const seenIps = enrichTrail.filter(e => e.ip).map(e => e.ip);
    const distinctIps = new Set(seenIps);
    const nullLookups = enrichTrail.filter(e => e.ipOk === false).length;
    // Real enrichment passes (tied to a browser generation) — the skip pass has none.
    const realPasses = enrichTrail.filter(e => e.browserGen != null);
    const gens = new Set(realPasses.map(e => e.browserGen));
    const ipChangedAcrossPasses = new Set(realPasses.filter(e => e.ip).map(e => e.ip)).size > 1;
    if (nullLookups > 0) {
      lines.push(`- ⚠️ **egress IP lookup failed on ${nullLookups} pass(es)** — api.ipify.org unreachable (a VPN may block it). The same-IP guard needs a non-null IP, so with these it silently proceeds every time and can NOT catch "you haven't switched yet."`);
    }
    // IP/browser observations, deliberately not a scope verdict. A later pass
    // has fewer candidates to enrich, so yield collapse is expected even when
    // the limit is entirely IP-scoped. Likewise, a changed IP may simply be a
    // colder shared exit. Neither is a controlled A/B test.
    const hasShrinkingPool = realPasses.some((e, i) => i > 0
      && e.remainingBefore != null && realPasses[i - 1].remainingBefore != null
      && e.remainingBefore < realPasses[i - 1].remainingBefore);
    if (realPasses.length >= 2 && gens.size === 1 && ipChangedAcrossPasses) {
      const poolNote = hasShrinkingPool
        ? ' The remaining input pool also shrank between passes, so raw yields are not comparable.'
        : '';
      lines.push(`- 🔬 **Same browser process (gen #${[...gens][0]}) was observed across changing egress IPs.** This trail cannot identify whether the ceiling is IP- or browser/session-scoped:${poolNote} A controlled reset/retry on the same observed IP with a fixed test batch is required.`);
    } else if (solves.length >= 1 && seenIps.length >= 2 && distinctIps.size === 1) {
      lines.push(`- 🔥 **Observed egress IP never changed across ${seenIps.length} recorded pass(es) (${[...distinctIps][0]}).** A VPN switch may not have taken effect; retrying it would not test a different IP.`);
    } else if (solves.length >= 2 && distinctIps.size > 1 && solves.every(e => e.walled || e.skippedSameIp)) {
      lines.push(`- ℹ️ **${distinctIps.size} observed IPs and every Solve walled.** This is inconclusive: exits can be shared/pre-warmed, and the same browser process was reused. It does not establish either quota scope.`);
    }
    // Cooldown observations are valid only within one observed IP/browser
    // identity. Never pair a wall on IP A with a clean result on IP B: that
    // would mistake a changed egress for elapsed-time recovery.
    const cooldownByIdentity = new Map();
    let previousActual = null;
    for (const e of enrichTrail) {
      if (e.browserGen == null || !e.ip || e.skippedSameIp || e.noInternet || e.browserUnavailable || e.kind === 'probe') continue;
      const isRateLimited = e.walled || (e.noDescSoftBlock || 0) > 0;
      if (previousActual) {
        const sameIdentity = e.ip === previousActual.ip && e.browserGen === previousActual.browserGen;
        const previousWasRateLimited = previousActual.walled || (previousActual.noDescSoftBlock || 0) > 0;
        if (sameIdentity && previousWasRateLimited) {
          const key = `${e.ip}\u0000${e.browserGen}`;
          if (!cooldownByIdentity.has(key)) cooldownByIdentity.set(key, { ip: e.ip, browserGen: e.browserGen, walled: [], clean: [] });
          const sample = cooldownByIdentity.get(key);
          const idle = Math.max(0, (e.startedAt ?? e.ts) - previousActual.ts);
          if (isRateLimited) sample.walled.push(idle);
          else sample.clean.push(idle);
        }
      }
      previousActual = e;
    }
    const cooldownSamples = [...cooldownByIdentity.values()];
    const boundedCooldowns = cooldownSamples.filter(sample => sample.clean.length > 0);
    if (boundedCooldowns.length > 0) {
      for (const sample of boundedCooldowns) {
        const minClean = Math.min(...sample.clean);
        const walledBelow = sample.walled.filter(wait => wait < minClean);
        const identity = `IP ${sample.ip}, browser#${sample.browserGen}`;
        if (walledBelow.length > 0) {
          const loStr = fmtGap(Math.max(...walledBelow));
          const hiStr = fmtGap(minClean);
          lines.push(`- 🧊 **Cooldown on ${identity}: between ${loStr} and ${hiStr}.** A same-IP/browser retry still walled after ${loStr}, then one finished clean after ${hiStr}.`);
        } else {
          lines.push(`- 🧊 **Cooldown on ${identity}: ≤ ${fmtGap(minClean)}.** A same-IP/browser retry finished clean after that idle; test shorter waits to tighten the bound.`);
        }
      }
    } else if (realPasses.some(e => e.walled || (e.noDescSoftBlock || 0) > 0)) {
      lines.push('- ⏳ **Cooldown cannot be estimated from this trail.** No clean retry followed a wall on the same observed IP and browser process; passes that changed IP or browser are excluded because they can represent a different quota state.');
    }
    // Automated cooldown-probe result (JOB_SEARCH_PROBE_COOLDOWN) — the crisp
    // answer when the probe ran the wait-and-test loop unattended.
    const cd = t.linkedinCooldown;
    if (cd) {
      if (cd.running) {
        lines.push(`- ⏳ **Cooldown probe in progress** — ${cd.attempts} attempt(s) so far${cd.aborted ? ' (aborted)' : ''}.`);
      } else if (cd.foundMs != null) {
        lines.push(`- ✅ **Cooldown confirmed: ~${fmtGap(cd.foundMs)}** — initial probe + confirmations all clean after ${fmtGap(cd.foundMs)} idle on the same IP/browser (${cd.attempts} attempt(s) total). Wait ≥ that between enrichment batches to keep going without switching anything.`);
      } else if (cd.identityChanged || cd.identityUnverified) {
        const expected = cd.expectedIdentity?.ip
          ? `expected IP ${cd.expectedIdentity.ip}, browser#${cd.expectedIdentity.browserGen ?? '?'}`
          : 'the original wall identity was not fully recorded';
        const observed = (cd.observedIdentity?.ip || cd.observedIdentity?.browserGen != null)
          ? `; observed IP ${cd.observedIdentity?.ip || '?'}, browser#${cd.observedIdentity?.browserGen ?? '?'}`
          : '';
        lines.push(`- ⚠️ **Cooldown probe invalid — IP/browser identity ${cd.identityChanged ? 'changed' : 'could not be verified'}.** ${expected}${observed}; this does not measure a cooldown. Keep the same VPN egress and browser process, then retry.`);
      } else if (cd.browserUnavailable) {
        lines.push(`- ⏸️ **Cooldown probe paused — browser/profile contention.** A visible captcha/login window held the shared browser profile at attempt ${cd.attempts}; close it and retry. This result says nothing about LinkedIn's cooldown.`);
      } else if (cd.aborted) {
        lines.push(`- ⏹️ **Cooldown probe aborted** after ${cd.attempts} attempt(s) — no clearing wait found yet.`);
      } else {
        const maxMs = Array.isArray(cd.waitsMs) && cd.waitsMs.length ? Math.max(...cd.waitsMs) : 0;
        lines.push(`- ❌ **Cooldown probe exhausted** ${cd.attempts} attempt(s) (idle waits up to ${fmtGap(maxMs)}) without clearing — the cooldown is longer than that, or idle alone won't clear it (try a longer schedule / Reset browser session / residential IP).`);
      }
    }
    // Residual verdict — the durable answer to "did we get every description?".
    // Derived from the LAST real pass so it survives the log ring buffer rolling.
    //
    // The decisive split is soft-block vs genuine no-desc. A real LinkedIn job page
    // ALWAYS carries JobPosting JSON-LD, so a no-desc with title="" + 0 JSON-LD
    // (noDescSoftBlock) is a rate-limit artifact — recoverable on a later pass —
    // NOT a posting that lacks a description. Only noDescGenuine is permanent.
    // The earlier version of this verdict treated ALL no-desc as permanent and
    // declared "complete" on any clean finish; that was wrong — soft-blocks don't
    // trip the URL wall, so a "clean finish" can still be strangling recoverable
    // jobs. evalErrors is NOT used (it counts failed ATTEMPTS, not empty jobs).
    const lastAttempt = enrichTrail[enrichTrail.length - 1];
    if (lastAttempt?.browserUnavailable) {
      lines.push(`- ⚠️ **Residual: ${lastAttempt.stillEmpty ?? '?'} still empty — retryable browser/profile contention.** The final enrichment pass could not start because another visible captcha/login window held the shared browser profile. Close that window, then Solve; this was not a clean finish or a guest-limit result.`);
    } else {
      const lastReal = [...enrichTrail].reverse().find(e => e.browserGen != null);
      if (lastReal && lastReal.stillEmpty != null) {
      const completionSnapshotJobs = savedRecoveryJobs.length > 0
        ? savedRecoveryJobs
        : savedSnapshotJobs;
      const snapshotLinkedInIncomplete = completionSnapshotJobs.filter(job =>
        job?.source === 'linkedin'
          && String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim().length < JOB_DESCRIPTION_EVIDENCE_MIN_CHARS,
      );
      const telemetryEmpty = Number(lastReal.stillEmpty) || 0;
      const hasSavedLinkedIn = completionSnapshotJobs.some(job => job?.source === 'linkedin');
      const empty = hasSavedLinkedIn
        ? Math.max(telemetryEmpty, snapshotLinkedInIncomplete.length)
        : telemetryEmpty;
      if (hasSavedLinkedIn && snapshotLinkedInIncomplete.length !== telemetryEmpty) {
        const samples = snapshotLinkedInIncomplete.slice(0, 3).map(job =>
          `"${historyReportValue(job.title, '(untitled)', 100)}" (${String(job.snippet || '').trim().length} chars)${job?.url ? ` — ${reportUrl(job.url)}` : ''}`,
        ).join('; ');
        const universe = savedRecoveryJobs.length > 0 ? 'saved recovery pool' : 'legacy scoring snapshot';
        lines.push(`- ⚠️ **Completion telemetry disagrees with the ${universe}:** final pass recorded ${telemetryEmpty} below-threshold description(s), but the saved pool contains ${snapshotLinkedInIncomplete.length}${samples ? ` — ${samples}` : ''}. Do not treat this as a clean full-description finish.`);
      }
      if (empty === 0) {
        lines.push(`- ✅ **Residual: 0 below enrichment threshold** — every retained LinkedIn recovery candidate has at least ${JOB_DESCRIPTION_EVIDENCE_MIN_CHARS} characters of description evidence.`);
      } else if (lastReal.noDescSoftBlock != null) {
        const soft = lastReal.noDescSoftBlock || 0;
        const genuine = lastReal.noDescGenuine || 0;
        const genuineNote = genuine > 0 ? ` (${genuine} are genuinely description-less)` : '';
        if (lastReal.walled) {
          lines.push(`- ⚠️ **Residual: ${empty} still empty — NOT complete.** The final pass **walled** (stopped early) so some jobs were never attempted; the last pass also saw ${soft} soft-block(s) (gutted pages under rate-limit — recoverable). Wait the cooldown and re-enrich${genuineNote}.`);
        } else if (soft > 0) {
          lines.push(`- ⚠️ **Residual: ${empty} still empty — likely NOT complete.** The final pass was a "clean finish" (no URL wall) but still returned **${soft} soft-block(s)** — gutted pages served under rate-limit, NOT missing descriptions, and recoverable on another pass. Enrichment stopped before these cleared; re-run or extend passes to recover them${genuineNote}.`);
        } else {
          lines.push(`- ✅ **Residual: ${empty} still empty — complete.** Clean finish, **0 soft-blocks** — the remainder is genuinely description-less (real pages with no JobPosting description) or a few transient load failures. Nothing recoverable by waiting; a re-run would only retry transient errors.`);
        }
      } else if (lastReal.noDesc != null) {
        // Pre-split telemetry: noDesc present but not classified. Can't tell
        // soft-block from genuine, so DON'T claim "complete" on a clean finish.
        const noDesc = Math.min(lastReal.noDesc, empty);
        const other = Math.max(0, empty - noDesc);
        lines.push(`- ⚠️ **Residual: ${empty} still empty** (final pass ${lastReal.walled ? 'walled — stopped early' : 'clean finish'}): ${noDesc} no-desc${other > 0 ? ` · ${other} other` : ''}. ⚠ This build predates the soft-block split, so it's unknown how many no-desc are rate-limit soft-blocks (recoverable) vs genuinely description-less — re-run on a current build to classify.`);
      } else {
        // No no-desc telemetry at all — fall back to the wall flag.
        lines.push(`- ${lastReal.walled ? '⚠️' : '✅'} **Residual: ${empty} still empty** (final pass ${lastReal.walled ? 'walled — stopped early, some jobs unreached' : 'clean finish — every job attempted'}).`);
      }
      }
    }
  }

  if (t.scoringHeartbeat?.active) {
    const h = t.scoringHeartbeat;
    const age = h.ts ? Math.max(0, Date.now() - h.ts) : null;
    const phase = h.phase === 'splitting' ? 'splitting into smaller batches'
      : h.phase === 'running' ? 'awaiting model response'
        : h.phase === 'recovering-missing-rows' ? 'recovering unresolved score rows'
          : h.phase || 'starting';
    const batch = h.batch != null && h.batchTotal != null ? ` · batch ${h.batch}/${h.batchTotal}` : '';
    const size = h.attemptSize != null ? ` · current attempt ${h.attemptSize} job(s)` : '';
    lines.push(`\n### Live Scoring`);
    lines.push(`- ${h.scored || 0}/${h.total || 0} complete${batch}${size} · **${phase}**${age == null ? '' : ` · heartbeat ${Math.round(age / 1000)}s ago`}`);
  } else if (t.scoringHeartbeat?.phase === 'aborted') {
    const h = t.scoringHeartbeat;
    const batch = h.batch != null && h.batchTotal != null ? ` · batch ${h.batch}/${h.batchTotal}` : '';
    const size = h.attemptSize != null ? ` · interrupted attempt ${h.attemptSize} job(s)` : '';
    const handoff = h.transport === 'manual-ai-handoff';
    const interruptedPhase = h.interruptedPhase === 'running'
      ? (handoff ? 'while awaiting the manually pasted AI response' : 'while awaiting the model response')
      : h.interruptedPhase ? `during ${h.interruptedPhase}` : '';
    lines.push('\n### Scoring Cancellation');
    lines.push(`- ⏹️ Cancelled at ${h.scored || 0}/${h.total || 0} complete${batch}${size}${interruptedPhase ? ` · ${interruptedPhase}` : ''}${ago(h.ts)}`);
    if (h.cancellationReason) lines.push(`- Cancellation reason: \`${historyReportValue(h.cancellationReason, '', 240)}\``);
  }

  if (t.scoring) {
    const s = t.scoring;
    const clean = s.placeholders === 0 && s.unscored === 0;
    const inputQuality = s.inputQuality || null;
    const incompleteDescriptions = (inputQuality?.empty || 0) + (inputQuality?.short || 0);
    const fullEvidence = clean && !!inputQuality && incompleteDescriptions === 0;
    // A model can successfully return a score for an empty listing-card row.
    // Keep that transport success distinct from the quality of the evidence it
    // received; otherwise the green score count reads as a clean analysis.
    const scoreVerdict = fullEvidence
      ? '✅ all analyzed with full descriptions'
      : clean && incompleteDescriptions > 0
        ? '⚠️ scored but low-evidence'
        : clean
          ? '✅ all received real model scores'
          : '';
    const selectedScoreVerdict = fullEvidence
      ? '✅ all selected jobs analyzed with full descriptions'
      : clean && incompleteDescriptions > 0
        ? '⚠️ scored but low-evidence'
        : clean
          ? '✅ all selected jobs received real model scores'
          : '';
    const selected = s.selectedForScoring ?? s.input; // back-compat with pre-cap telemetry
    lines.push(`\n### Scoring${ago(s.ts)}`);
    if (s.cappedForBudget > 0) {
      // The budget cap is an intentional drop, surfaced so it's not silent:
      // a wider gather means the kept jobs are the best slice across sources,
      // not all of them. Widening the scrape improves WHICH jobs make this cut.
      lines.push(`- Gathered: ${s.input} → pre-ranked to top **${selected}** across sources for scoring (${s.cappedForBudget} lower-priority overflow not scored — by-design budget cap to bound LLM cost, not a failure).`);
      lines.push(`- Scored: ${s.scored}/${selected} ${selectedScoreVerdict}`);
    } else {
      lines.push(`- Input: ${s.input} → scored: ${s.scored} ${scoreVerdict}`);
    }
    // Reconcile the scorer's input against what was actually gathered THIS session
    // (search + paste + captcha-resolves). When input exceeds that, the surplus was
    // carried over from a PRIOR run — job cards persisted on the canvas, re-scored
    // alongside this session's gather. They weren't gathered this session, so their
    // scrape funnel isn't in this report. Surfaced so a "99 scored but only 65
    // gathered here" gap reads as carry-over, not jobs appearing from nowhere.
    // Use the cumulative renderer-side queue delta when available. It accounts
    // for same-source replacement and every retry: a sequence such as
    // 3→7→7→15→52→54 contributes +51, while latest-attempt-only
    // telemetry would contribute +2 and falsely label 49 jobs as carry-over.
    const resumeOnlyGathered = Object.entries(t.resumeAttempts || {}).reduce((sum, [sourceId]) => {
      if (t.resolves?.[sourceId]) return sum;
      const attempt = latestResolvedResumeAttempt(t, sourceId, t.search?.ts);
      return sum + (resolvedResumeCount(attempt) || 0);
    }, 0);
    const sessionGathered = (t.search?.kept || 0) +
      Object.values(t.resolves || {}).reduce((sum, r) => {
        const m = r?.merge;
        const cumulative = Number(r?.cumulativeMergeNet);
        return sum + (r?.hasMergeTelemetry === true && Number.isFinite(cumulative)
          ? cumulative
          : (m != null ? (m.pendingAfter - m.pendingBefore) : (r?.kept || 0)));
      }, 0) + resumeOnlyGathered;
    const carried = s.input - sessionGathered;
    if (carried > 0) {
      lines.push(`  - _(${sessionGathered} gathered this session; the other **${carried}** were carried over from a prior run — already on the canvas, re-scored here. Not gathered this session, so their scrape funnel isn't above — and not silently added.)_`);
    }
    const providerCalls = Number(s.providerCalls || 0);
    const recoveryCalls = Number(s.partialRecoveryCalls || 0);
    const recoveryRows = Number(s.partialRecoveryRowAttempts || 0);
    const callDetail = providerCalls > 0 && providerCalls !== Number(s.batches || 0)
      ? ` · ${providerCalls} provider call(s)${recoveryCalls > 0 ? `, including ${recoveryCalls} targeted partial-row recovery call(s) covering ${recoveryRows} row-attempt(s)` : ''}`
      : '';
    lines.push(`- Batches: ${s.batches} (${s.failedBatches} failed)${callDetail}${modelTag(s.models?.length ? s.models.join(', ') : null)}`);
    if (inputQuality && incompleteDescriptions > 0) {
      const bySource = Object.entries(inputQuality.bySource || {})
        .map(([source, q]) => `${source}=${q.empty || 0} empty/${q.short || 0} short`)
        .join(', ');
      lines.push(`- ⚠️ **Low-evidence scoring inputs:** ${inputQuality.empty || 0} empty description(s), ${inputQuality.short || 0} short (<400 chars). These rows received real model responses, but were NOT fully evidenced by a complete JD${bySource ? ` · by source: ${bySource}` : ''}.`);
      for (const sample of Array.isArray(inputQuality.samples) ? inputQuality.samples : []) {
        lines.push(`  - [${sample.source || '?'}] "${sample.title || '(untitled)'}" — ${sample.length || 0} chars${sample.url ? ` · ${reportUrl(sample.url)}` : ''}`);
      }
    }
    if (Array.isArray(s.fallbacks) && s.fallbacks.length > 0) {
      lines.push('- Model fallback routes (successful scoring calls):');
      for (const [index, fallback] of s.fallbacks.entries()) {
        const servedTag = modelTag(fallback.servedModel, fallback).replace(/^ · model: /, '');
        lines.push(`  - call ${index + 1}: preferred \`${fallback.preferredModel || '?'}\` → served ${servedTag}`);
      }
      if (s.fallbackOmitted > 0) lines.push(`  - _${s.fallbackOmitted} additional fallback call(s) omitted from the bounded trail._`);
    }
    if (s.failureReason) {
      // Persisted from the scoring loop so the cause survives even after the raw
      // log line scrolls out of the main-process ring buffer.
      lines.push(`  - ↳ batch failure reason: \`${s.failureReason}\``);
    }
    if (s.placeholders > 0) {
      lines.push(`- ⚠️ **${s.placeholders} placeholder score(s)** — these jobs reached the scorer but came back unusable and were given a default matchScore=50. They were NOT genuinely analyzed.`);
    }
    if (s.unscored > 0) {
      lines.push(`- ⚠️ **${s.unscored} job(s) never scored** — the abort signal cut the batch loop short before they were sent to the scorer.`);
    }
    const audit = s.audit;
    if (audit && Array.isArray(audit.rows) && audit.rows.length > 0) {
      const anomalies = Array.isArray(audit.anomalies) ? audit.anomalies : [];
      lines.push('- Scoring consistency audit (bounded; original batch retained before score sorting):');
      if (anomalies.length === 0) {
        lines.push('  - ✅ No cross-batch score delta ≥15 among same-title/company jobs with effectively identical descriptions.');
      } else {
        for (const anomaly of anomalies) {
          // Priority rows (placeholders) are deliberately moved to the front
          // of the bounded audit, so original source indices no longer equal
          // their display-array positions.
          const findAuditRow = reference => audit.rows.find(row => row.index === reference?.index)
            // Pre-priority telemetry did not persist row indices; retain its
            // original positional contract for saved/legacy reports.
            || audit.rows[reference?.index];
          const a = findAuditRow(anomaly.first);
          const b = findAuditRow(anomaly.second);
          if (!a || !b) continue;
          lines.push(`  - ⚠️ **${anomaly.delta}-point cross-batch drift** for "${anomaly.title}" — ${anomaly.company}: batch ${a.batch} scored ${a.score} (${a.location || 'location ?'}; ${a.direction || 'direction ?'}) vs batch ${b.batch} scored ${b.score} (${b.location || 'location ?'}; ${b.direction || 'direction ?'}); identical JD fingerprint \`${anomaly.descriptionFingerprint}\`.`);
          lines.push(`    - first: ${reportUrl(a.url)} · reason: "${reportText(a.reason, '(none)')}"`);
          lines.push(`    - second: ${reportUrl(b.url)} · reason: "${reportText(b.reason, '(none)')}"`);
        }
      }
      if (audit.omitted > 0) lines.push(`  - _${audit.omitted} additional scored job(s) omitted from the bounded audit._`);

      // SCORE promises ordinary per-job evidence too, not only rows involved in
      // a rare cross-batch anomaly. Keep the normal sample compact so FULL still
      // reaches the later history/taxonomy sections.
      const totalEvidence = audit.rows.length + (audit.omitted || 0);
      if (omitJobAudit) {
        lines.push(`- Scoring evidence (${totalEvidence} bounded row(s)) omitted by filter code — XJOBAUDIT.`);
      } else {
        const evidence = [
          ...audit.rows.filter(row => row.placeholder),
          ...audit.rows.filter(row => !row.placeholder),
        ].slice(0, 10);
        lines.push(`- Scoring evidence (${evidence.length}/${totalEvidence} bounded row(s)):`);
        for (const row of evidence) {
          const placeholder = row.placeholder ? ' · ⚠️ placeholder (not analyzed)' : '';
          const url = row.placeholder && row.url ? ` · URL: ${reportUrl(row.url, '(no URL)', 240)}` : '';
          lines.push(`  - batch ${row.batch || '?'} · score ${row.score ?? '?'}${placeholder} · [${historyReportValue(row.source, '?', 40)}] "${historyReportValue(row.title, '(untitled)', 120)}" — ${historyReportValue(row.direction, '(no direction)', 100)} · input ${row.descriptionChars ?? '?'} chars · reason: "${historyReportValue(row.reason, '(none)', 240)}"${url}`);
        }
        if (totalEvidence > evidence.length) {
          lines.push(`  - _${totalEvidence - evidence.length} additional scoring-evidence row(s) omitted._`);
        }
      }
    }
  } else {
    lines.push('\n### Scoring\n- (no scoring recorded this session)');
  }

  // Competitive salary check (contract: jobsTelemetry.compensation, stamped by
  // jobs.js researchCompensationAssessments, which runs during board Combine
  // after taxonomy generation on every merged scored job). This is the only place the compensation
  // funnel is visible at all — there is no per-cohort card or log line that
  // survives past the ~60-line main-process ring buffer, and each cohort costs
  // TWO LLM calls (a grounded research call + an assessment call) that share
  // the SAME Gemini free-tier quota as scoring/bucketing. Absent entirely →
  // render nothing (no guessed zeros); a present-but-null field prints "not
  // recorded" rather than a misleading 0, since 0 is itself a real, meaningful
  // value here (e.g. "0 cohorts failed").
  if (t.compensation) {
    const c = t.compensation;
    const rec = (v) => (v === null || v === undefined) ? 'not recorded' : v;
    lines.push(`\n### Competitive salary check${ago(c.ts)}`);
    lines.push('> What this answers: whether the competitive-salary check is what exhausted this run\'s AI quota. Every fit-qualified job proceeds toward a cohort by role/seniority/experience/employment type/location/currency — a job needs only a resolvable comparison location and a resolvable market currency to reach that stage, an advertised salary is not required — and EACH researched cohort costs two LLM calls — one grounded research call plus one assessment call — on the same quota fit-scoring and bucketing draw from. Cohorts can fragment by location, so a broad multi-employer search can multiply into many cohorts. The numbers below describe what happened this run, not a diagnosis of why.');
    // `eligible` is deliberately the *fit-gate* pass count, not the number
    // that ultimately reached market research. Salary and location checks run
    // afterward, so presenting every number as a peer "Skipped" count makes
    // a valid funnel look impossible (for example 51 below fit + 8
    // fit-qualified, all 8 then lacking a salary, on 59 input jobs). Name
    // the stages so these counters are visibly nested rather than additive.
    lines.push(`- Scored input: ${rec(c.scoredInput)} job(s) = ${rec(c.skippedBelowFit)} below the fit threshold + ${rec(c.eligible)} fit-qualified at or above ${rec(c.minFitScore)}`);
    // Location/currency are the two structural gates that actually remove a
    // fit-qualified job from the candidate pool before cohorting; a missing
    // advertised salary alone does NOT (it can still reach research on an
    // inferred market currency), so it is reported separately below rather
    // than folded into this "skipped before market research" stage.
    lines.push(`- Of the fit-qualified jobs, skipped before market research: ${rec(c.skippedNoLocation)} with no resolvable location, ${rec(c.skippedNoCurrency)} with no resolvable market currency; ${rec(c.preResearchCandidates)} passed to experience-band/cohort preparation`);
    lines.push(`- Missing/unusable advertised salary: ${rec(c.missingOffer)} · market recommendations produced: ${rec(c.recommendedNoOffer)}`);
    lines.push(`- Cohorts: ${rec(c.cohorts)} → researched ${rec(c.researched)}, failed ${rec(c.failedCohorts)}`);
    lines.push(`- Jobs assessed: ${rec(c.assessed)} · cache hit(s): ${rec(c.cacheHits)}`);
    if (Array.isArray(c.failures) && c.failures.length > 0) {
      lines.push(`- Failed cohort(s) (bounded; capped at 5 of ${rec(c.failedCohorts)}):`);
      for (const f of c.failures.slice(0, 5)) {
        const cohort = historyReportValue(f?.cohort, '(unknown cohort)', 200);
        const reason = historyReportValue(f?.reason, '(no reason recorded)', 240);
        lines.push(`  - \`${cohort}\`: ${reason}`);
      }
    }
  }

  if (t.history && typeof t.history === 'object') {
    lines.push('\n### Seen-history persistence');
    const stages = [
      ['preScoring', 'Pre-results write'],
      ['boardDisplay', 'Board-displayed write'],
    ];
    for (const [key, label] of stages) {
      const h = t.history[key];
      if (!h) continue;
      const age = ago(h.ts);
      if (h.error) {
        lines.push(`- ❌ ${label}${age}: ${h.input} job(s) → history write failed: \`${h.error}\``);
      } else if (h.skipped) {
        lines.push(`- ℹ️ ${label}${age}: ${h.input} job(s) → skipped (${h.skipped})`);
      } else {
        lines.push(`- ✅ ${label}${age}: ${h.input} job(s) → ${h.written || 0} new history row(s)${h.pruned ? `, ${h.pruned} expired row(s) pruned` : ''}`);
        // WHY the rest produced no row. "59 jobs → 50 rows" on an EMPTY history
        // is the shape of a dedup key that can't tell two listings apart, and
        // without this breakdown it reads as ordinary dedup: it took replaying a
        // saved run to find that all 10 Google jobs shared one normalized URL.
        // `in-batch` is the tell — a collision with an earlier job in the SAME
        // write, i.e. over-collapsing, not a genuine already-seen repost.
        const sk = h.skips;
        if (sk && (sk.url || sk.titleCompany || sk.noKey)) {
          const parts = [];
          if (sk.url) parts.push(`${sk.url} by url-key`);
          if (sk.titleCompany) parts.push(`${sk.titleCompany} by title+company[+location]`);
          if (sk.noKey) parts.push(`${sk.noKey} with no usable key`);
          const bySrc = Object.entries(sk.bySource || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          const total = (sk.url || 0) + (sk.titleCompany || 0) + (sk.noKey || 0);
          lines.push(`  - ${total} job(s) wrote no row: ${parts.join(', ')}${bySrc ? ` · by source: ${bySrc}` : ''}`);
          if (sk.inBatch > 0) {
            lines.push(`    - ⚠️ ${sk.inBatch} of those collided with an earlier job in THIS SAME WRITE, not with prior history. See the bounded collision samples below to distinguish an expected duplicate from an identity-key defect.`);
            for (const sample of Array.isArray(sk.collisionSamples) ? sk.collisionSamples : []) {
              const first = sample?.first || {};
              const duplicate = sample?.duplicate || {};
              const esc = value => String(value ?? '').replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
              const describe = job => `\`${esc(job.source || '?')}\` "${esc(job.title || '(untitled)')}" — ${esc(job.company || '(unknown company)')} · ${esc(job.location || '(no location)')} [${esc(reportUrl(job.url || '(no URL)'))}]`;
              const verdict = sample.sameListing
                ? '✅ likely the same listing surfaced twice (same source/title/company/location)'
                : '🔥 conflicting listings share one history key — inspect the normalizer';
              lines.push(`      - ${verdict} · key \`${esc(sample.key || '?')}\``);
              lines.push(`        - kept: ${describe(first)}`);
              lines.push(`        - skipped: ${describe(duplicate)}`);
            }
          }
        }
        if (h.unreadable > 0) {
          lines.push(`  - ⚠️ ${h.unreadable} row(s) already in the CSV could not be parsed back (a legacy row containing a newline, e.g. a Glassdoor company captured as "Marshalls\\n3.4"). They are invisible to dedup and are dropped by this rewrite; the jobs re-append cleanly, so the file self-heals from here.`);
        }
      }
    }
  }

  if (t.bucketing) {
    const b = t.bucketing;
    // The taxonomy = the labels for the 3-level results tree (hiring-fit band →
    // salary range → role). A successful taxonomy is required before the
    // renderer mutates the board; failed combines leave its prior results intact.
    lines.push(`\n### Taxonomy (hiring fit → salary → role)${ago(b.ts)}`);
    if (b.strategy === 'bounded-plan-chunks') {
      const input = Math.max(0, Number(b.input) || 0);
      const chunkCount = Math.max(0, Number(b.taxonomyChunkCount) || 0);
      const plannedAssignments = Math.max(0, Number(b.taxonomyPlannedAssignments) || 0);
      const classifiedAssignments = Math.max(0, Number(b.taxonomyClassifiedAssignments) || 0);
      const plannerOnlyComplete = b.taxonomyStage === 'complete' && !chunkCount
        && input > 0 && plannedAssignments === input;
      const chunkProgress = chunkCount > 0
        ? `${Number(b.taxonomyChunksCompleted || 0)}/${chunkCount} chunk(s)`
        : plannerOnlyComplete
          ? `classification not needed — planner assigned ${plannedAssignments}/${input}`
          : 'classification not started';
      const assignmentProgress = chunkCount > 0 && (plannedAssignments || classifiedAssignments)
        ? ` · planner assigned ${plannedAssignments}/${input || '?'}; classifier assigned ${classifiedAssignments}/${input || '?'}`
        : '';
      const provider = b.provider ? ` · provider \`${String(b.provider).replace(/`/g, '')}\`` : '';
      lines.push(`- Bounded taxonomy: stage ${b.taxonomyStage || 'unknown'} · ${chunkProgress}${assignmentProgress} · max ${Number(b.taxonomyChunkSize || 0) || '?'} jobs/request · ${Number(b.taxonomyRepresentativeCount || 0)} planning sample(s) · ${Number(b.taxonomyVocabularySize || 0)} role label(s)${provider}.`);
    }
    if (b.error) {
      // Taxonomy is a transactional prerequisite. A provider failure must not
      // imply that a renderer-side fallback created results from an incomplete
      // response.
      lines.push(`- ❌ **Job Board combine aborted** on ${b.input} scored job(s)${modelTag(b.model, b.fallback)} — taxonomy did not complete; no new job results were added and the existing board was left unchanged.`);
      lines.push(`  - Captured taxonomy-provider error: ${b.error}`);
      const shape = b.roleShape && typeof b.roleShape === 'object' ? b.roleShape : null;
      if (shape) {
        const defects = [];
        if (Number(shape.missingCount || 0) > 0) defects.push(`${shape.missingCount} missing`);
        if (Number(shape.blankCount || 0) > 0) defects.push(`${shape.blankCount} blank`);
        if (Number(shape.nonStringCount || 0) > 0) defects.push(`${shape.nonStringCount} non-string`);
        if (Number(shape.extraCount || 0) > 0) defects.push(`${shape.extraCount} extra`);
        lines.push(`  - Provider role payload: ${shape.type || 'unknown'} · ${shape.receivedCount ?? 0}/${shape.expectedCount ?? b.input} required entries received${defects.length ? ` · ${defects.join(', ')}` : ''}.`);
        const indexParts = [];
        if (Array.isArray(shape.missingIndices) && shape.missingIndices.length) indexParts.push(`missing [${shape.missingIndices.join(', ')}]`);
        if (Array.isArray(shape.blankIndices) && shape.blankIndices.length) indexParts.push(`blank [${shape.blankIndices.join(', ')}]`);
        if (Array.isArray(shape.nonStringIndices) && shape.nonStringIndices.length) indexParts.push(`non-string [${shape.nonStringIndices.join(', ')}]`);
        if (Array.isArray(shape.extraKeys) && shape.extraKeys.length) indexParts.push(`extra keys [${shape.extraKeys.join(', ')}]`);
        if (indexParts.length) lines.push(`  - Affected role positions (bounded, 0-based): ${indexParts.join(' · ')}${shape.omittedIssueIndices > 0 ? ` · ${shape.omittedIssueIndices} more omitted` : ''}.`);
      }
      const coverage = b.modelRoleCoverage && typeof b.modelRoleCoverage === 'object' ? b.modelRoleCoverage : null;
      if (coverage) {
        lines.push(`  - Usable role coverage: ${coverage.placed || 0}/${b.input} placed · ${coverage.missing || 0} missing · ${coverage.duplicated || 0} duplicate · ${coverage.invalid || 0} invalid index(es) · ${coverage.malformedNames || 0} malformed role name(s).`);
      }
      if (Array.isArray(b.failureSamples) && b.failureSamples.length > 0) {
        lines.push('  - Affected job samples (bounded; no descriptions/model output retained):');
        for (const sample of b.failureSamples) {
          const clean = value => String(value || '').replace(/`/g, '\\`').replace(/\s+/g, ' ').trim();
          lines.push(`    - #${sample.index} [${clean(sample.source) || '?'}] "${clean(sample.title) || '(untitled)'}" · scorer direction: ${clean(sample.suggestedDirection) || '(none)'}`);
        }
      }
    } else {
      const clean = b.missing === 0 && b.duplicated === 0;
      lines.push(`- Input: ${b.input} → ${b.roleCount} role(s), ${Array.isArray(b.bandSummary) ? b.bandSummary.length : 0} hiring-fit band(s), ${Array.isArray(b.salaryRangeLabels) ? b.salaryRangeLabels.length : 0} salary range(s)${clean ? ' · ✅ every job placed in a role' : ''}${modelTag(b.model, b.fallback)}`);
      const dirs = t.scoring?.directions;
      if (typeof dirs === 'number' && dirs > 0 && b.roleCount > 0) {
        const note = dirs > b.roleCount
          ? ` (merged ${dirs - b.roleCount} away — ${dirs} scorer directions → ${b.roleCount} roles)`
          : ' (no merging needed)';
        lines.push(`  - Roles consolidated from ${dirs} distinct scorer careerDirection(s)${note}.`);
      }
      const modelCoverage = b.modelRoleCoverage && typeof b.modelRoleCoverage === 'object'
        ? b.modelRoleCoverage
        : null;
      const malformedNameCount = Array.isArray(modelCoverage?.malformedNameIndices)
        ? modelCoverage.malformedNameIndices.length
        : 0;
      const modelDefect = modelCoverage && (
        Number(modelCoverage.unassigned || 0) > 0
        || malformedNameCount > 0
        || Number(modelCoverage.duplicated || 0) > 0
        || Number(modelCoverage.invalid || 0) > 0
        || Number(modelCoverage.missing || 0) > 0
      );
      if (modelDefect) {
        const defects = [];
        if (Number(modelCoverage.unassigned || 0) > 0) defects.push(`${modelCoverage.unassigned} unassigned job(s)`);
        if (malformedNameCount > 0) defects.push(`${malformedNameCount} job(s) under malformed role name(s)`);
        if (Number(modelCoverage.duplicated || 0) > 0) defects.push(`${modelCoverage.duplicated} duplicated assignment(s)`);
        if (Number(modelCoverage.invalid || 0) > 0) defects.push(`${modelCoverage.invalid} invalid job index(es)`);
        // Defensive fallback for a future telemetry shape that exposes only the
        // aggregate raw gap rather than its unassigned/malformed breakdown.
        if (defects.length === 0 && Number(modelCoverage.missing || 0) > 0) {
          defects.push(`${modelCoverage.missing} job(s) without a usable role assignment`);
        }
        lines.push(`  - ❌ AI role-partition invalid: ${defects.join(', ')}. The combine must abort without adding new results; the existing board remains unchanged.`);
      } else if (b.missing > 0) {
        const idxNote = Array.isArray(b.missingIndices) && b.missingIndices.length > 0
          ? ` Missing indices (0-based): [${b.missingIndices.join(', ')}]`
          : '';
        lines.push(`  - ❌ **${b.missing} job(s) NOT placed in any role by the AI.** The combine must abort without adding new results; the existing board remains unchanged.${idxNote}`);
      }
      if (b.duplicated > 0) {
        lines.push(`  - ❌ ${b.duplicated} job(s) were placed in more than one role by the AI. The combine must abort without adding new results; the existing board remains unchanged.`);
      }
      // Hiring-fit bands (top level, ordered high→low) with deterministic counts.
      if (Array.isArray(b.bandSummary) && b.bandSummary.length > 0) {
        lines.push('- Hiring-fit bands (top level — evidence-based full-process fit, not a guaranteed hiring outcome):');
        for (const band of b.bandSummary) {
          lines.push(`  - **${band.label}** — ${band.count} job${band.count === 1 ? '' : 's'}`);
        }
      }
      // Salary ranges (second level) — just the labels the AI chose.
      if (Array.isArray(b.salaryRangeLabels) && b.salaryRangeLabels.length > 0) {
        lines.push(`- Salary ranges (second level): ${b.salaryRangeLabels.map(s => `"${s}"`).join(', ')}`);
      }
      if (Array.isArray(b.taxonomyRepairs) && b.taxonomyRepairs.length > 0) {
        lines.push(`- ⚠️ Taxonomy validation repaired: ${b.taxonomyRepairs.join('; ')}.`);
      }
      if (Array.isArray(b.taxonomyAudit) && b.taxonomyAudit.length > 0) {
        if (omitJobAudit) {
          const taxonomyAuditTotal = b.taxonomyAudit.length + (b.taxonomyAuditOmitted || 0);
          lines.push(`- Taxonomy placement audit (${taxonomyAuditTotal} job row(s)) omitted by filter code — XJOBAUDIT.`);
        } else {
          lines.push('- Taxonomy placement audit (raw salary → annualized pay → deterministic buckets):');
          for (const item of b.taxonomyAudit) {
            const title = item.title ? `"${item.title}"` : '(untitled)';
            const source = item.source ? ` [${item.source}]` : '';
            const raw = item.rawSalary ? `"${item.rawSalary}"` : '(none)';
            const annual = item.annualSalary > 0 ? `$${Number(item.annualSalary).toLocaleString('en-US')}/yr` : 'unparseable';
            lines.push(`  - #${item.index} ${title}${source} — ${raw} → ${annual} → **${item.salaryRange || 'Unspecified'}**; ${item.fitBand || item.likelihood || 'Hiring fit'}; ${item.role || 'Other'}`);
            // `salaryRange` remains the deterministic bucket label. Endpoint
            // provenance is deliberately separate so normal ranges are disclosed
            // without turning every range into a warning; older telemetry only
            // has the wide-range `salaryAnomaly` payload.
            const rangeMetadata = item.salaryRangeMetadata || item.salaryAnomaly || item;
            const lowerAnnual = Number(rangeMetadata?.lowerAnnual);
            const upperAnnual = Number(rangeMetadata?.upperAnnual);
            if (Number.isFinite(lowerAnnual) && Number.isFinite(upperAnnual) && upperAnnual > lowerAnnual) {
              const lo = lowerAnnual.toLocaleString('en-US');
              const hi = upperAnnual.toLocaleString('en-US');
              const isWide = upperAnnual / lowerAnnual >= 5;
              lines.push(`    - ${isWide ? '⚠️ ' : ''}salary range disclosed: $${lo}–$${hi}/yr. Kept the lower endpoint for deterministic placement${isWide ? `; ${item.salaryAnomaly?.reason || 'implausibly wide range'} — verify the source chip` : ''}.`);
            }
            // Only for values mined out of the description body: shows whether the
            // figure was actually the role's pay or a bonus/equity/revenue number
            // that happened to sit next to a cadence word.
            if (item.salaryContext) lines.push(`    - in-JD context: …${item.salaryContext}…`);
          }
          if (b.taxonomyAuditOmitted > 0) lines.push(`  - _${b.taxonomyAuditOmitted} additional job(s) omitted from this compact audit._`);
        }
      }
      // Roles (third level) — the AI's creative partition; the part most worth
      // auditing ("are these the right labels, with the right jobs?").
      if (Array.isArray(b.roleSummary) && b.roleSummary.length > 0) {
        lines.push('- Roles (third level — is each label a sensible home for its jobs?):');
        for (const r of b.roleSummary) {
          const samples = Array.isArray(r.sampleTitles) && r.sampleTitles.length
            ? ` · e.g. ${r.sampleTitles.map(s => `"${s}"`).join(', ')}`
            : '';
          lines.push(`  - **${r.name}** — ${r.count} job${r.count === 1 ? '' : 's'}${samples}`);
        }
      }
      if (b.roleCount === 0 && b.input > 0) {
        lines.push('- ❌ AI taxonomy returned 0 roles — the combine must abort without adding new results; the existing board remains unchanged.');
      }
    }
  } else {
    lines.push('\n### Taxonomy (hiring fit → salary → role)\n- (no taxonomy recorded this session)');
  }

  // ── Application generation (last) ──────────────────────────────────────────
  // The model's actual résumé markup + cover-letter fields — the one place an
  // application rendering bug shows (stray mid-sentence newline, literal \n/\t,
  // broken structure). Fields are JSON.stringify'd so whitespace/escapes are
  // visible literally (a real newline shows as \n, a double-escaped one as \\n).
  if (scopedApplication) {
    const a = scopedApplication;
    const cl = a.coverLetter || a.localAi?.coverLetterEnvelope || {};
    const escScan = (s) => /\\[a-z]/.test(String(s ?? '')) ? ' ⚠️ literal backslash-escape present' : '';
    lines.push(`\n### Application Generation (last)${ago(a.ts)}`);
    if (applicationScope?.note) lines.push(applicationScope.note.trimEnd());
    lines.push(`- Job: ${a.jobTitle || '(untitled)'} @ ${a.company || '(no company)'}${a.nodeId ? ` · node ${a.nodeId}` : ''}`);
    if (a.source === 'local-ai') {
      lines.push(`- Route: Local AI manual handoff${a.localAi?.jobId ? ` · job \`${a.localAi.jobId}\`` : ''}`);
      const handoffHistory = Array.isArray(a.localAi?.handoffHistory) ? a.localAi.handoffHistory : [];
      if (handoffHistory.length) {
        lines.push('- Local AI handoff trace (app-authored event/hash/page measurements; AI-authored quality review):');
        for (const event of handoffHistory.slice(-12)) {
          const resume = event?.resume || {};
          const cover = event?.coverLetter || {};
          const attempts = Array.isArray(resume.attempts) && resume.attempts.length
            ? ` · résumé attempts ${resume.attempts.map(attempt => `#${attempt?.attempt ?? '?'}${attempt?.density === 'compact' ? '[compact]' : ''}=${attempt?.error ? 'error' : `${attempt?.pageCount ?? '?'}p`}`).join(', ')}`
            : '';
          const round = Number.isFinite(event?.revisionRound) ? ` · revision ${event.revisionRound}` : '';
          const resultHash = event?.resultSha256 ? ` · result ${String(event.resultSha256).slice(0, 16)}` : '';
          const resumePages = resume.pageCount != null ? ` · résumé ${resume.pageCount}/${resume.targetPageCount ?? '?'}p` : '';
          const resumeUtilization = Number.isFinite(resume?.layout?.utilization)
            ? ` · résumé type area ${Math.round(resume.layout.utilization * 100)}%`
            : '';
          const coverPages = cover.pageCount != null ? ` · cover ${cover.pageCount}/${cover.targetPageCount ?? '?'}p` : '';
          const detail = event?.detail ? ` — ${historyReportValue(event.detail, '', 320)}` : '';
          lines.push(`  - ${event?.at || '?'} · ${event?.type || 'unknown'}${round}${resultHash}${resumePages}${resumeUtilization}${coverPages}${attempts}${detail}`);
          const qualityReview = event?.qualityReview;
          if (qualityReview?.resume || qualityReview?.coverLetter) {
            const formatReview = (label, review) => `${label} ${review?.decision || 'unknown'}${review?.rationale ? ` — ${historyReportValue(review.rationale, '', 320)}` : ''}`;
            lines.push(`    - AI-authored quality review: ${formatReview('résumé', qualityReview.resume)}; ${formatReview('cover letter', qualityReview.coverLetter)}`);
          }
        }
      }
    }
    // A generation failure commonly happens before any document markup exists
    // (for example, a provider quota error during company research). Render the
    // lifecycle first so FULL reports name the exact attempted job/task/stage
    // instead of reducing that case to the provider's app-global last error.
    if (a.status) {
      const outcome = {
        running: 'in progress', completed: 'completed', failed: '⚠️ failed', cancelled: 'cancelled',
      }[a.status] || a.status;
      lines.push(`- Outcome: **${outcome}**${a.stage ? ` · current/final stage: ${a.stage}` : ''}`);
      if (Array.isArray(a.taskRoutes) && a.taskRoutes.length > 0) {
        lines.push(`- Intended task route: ${a.taskRoutes.map(route => `${route.task || '?'} → ${route.provider || '?'} / \`${route.model || '?'}\``).join('; ')}`);
      }
      if (Array.isArray(a.stages) && a.stages.length > 0) {
        lines.push(`- Lifecycle: ${a.stages.map(item => item?.stage).filter(Boolean).join(' → ')}`);
      }
      if (Array.isArray(a.taskOutcomes) && a.taskOutcomes.length > 0) {
        const outcomes = a.taskOutcomes.map((outcome) => {
          const actual = outcome?.model ? ` / \`${outcome.model}\`` : '';
          const fallback = outcome?.fallback?.attempts
            ? ` (fallback after ${outcome.fallback.attempts}: ${outcome.fallback.reason || 'unknown'})`
            : '';
          const failure = outcome?.error ? ` — ${historyReportValue(outcome.error, '', 180)}` : '';
          return `${outcome?.task || '?'} → ${outcome?.provider || '?'}${actual} [${outcome?.status || 'unknown'}]${fallback}${failure}`;
        });
        lines.push(`- Actual task outcomes: ${outcomes.join('; ')}`);
      }
      if (a.status === 'failed' || a.status === 'cancelled') {
        if (a.error) lines.push(`- ${a.status === 'failed' ? 'Error' : 'Cancellation'}: \`${historyReportValue(a.error, '', 800)}\``);
        // There is intentionally no fake blank résumé/cover-letter snapshot
        // here: those artifacts were never generated. The lifecycle, model
        // route, and terminal error are the actionable diagnostics.
      }
    }
    if (a.companyResearch) {
      if (a.companyResearch.available === false) {
        const descriptionMissing = a.jobContext?.scrapedDescriptionAvailable === false;
        lines.push(descriptionMissing
          ? `- ⚠️ **Limited application context:** company/role research unavailable AND no scraped job description was captured — generation used only job metadata plus candidate career data${a.companyResearch.error ? `: \`${historyReportValue(a.companyResearch.error, '', 300)}\`` : ''}`
          : `- ⚠️ Company/role research unavailable — generation used only the scraped job description${a.companyResearch.error ? `: \`${historyReportValue(a.companyResearch.error, '', 300)}\`` : ''}`);
      } else if (a.companyResearch.available === true) {
        lines.push('- Company/role research: live web context available.');
      }
    }
    if (a.jobContext) {
      lines.push(`- Job-context evidence: scraped description ${a.jobContext.scrapedDescriptionChars ?? '?'} char(s)${a.jobContext.scrapedDescriptionAvailable === false ? ' (missing)' : ''} · live research ${a.jobContext.researchAvailable === true ? 'available' : a.jobContext.researchAvailable === false ? 'unavailable' : 'not resolved'}`);
    }
    if (a.status !== 'failed' && a.status !== 'cancelled') {
    // Achievement ledger (résumé design §3.6) — reused-vs-mined tells apart the
    // amortized-cost case from the pay-once-per-hub case; the stats line is the
    // only place a silent refute-drop or evidence-miss is visible at all.
    const ach = a.achievements || {};
    const achSourceLabel = {
      reused: 'reused from hub cache', mined: 'freshly mined this generation',
      unavailable: 'unavailable — careerData-only fallback', none: 'not passed by renderer',
    }[ach.source] || ach.source || 'unknown';
    lines.push(`- Achievement ledger: ${achSourceLabel} · kept ${ach.kept ?? 0} item(s)${ach.suppressedWeakened ? ` · ${ach.suppressedWeakened} refute-weakened item(s) withheld from application prompts` : ''}${ach.minedBy ? ` · miner \`${ach.minedBy.miner || '?'}\` refuter \`${ach.minedBy.refuter || '?'}\`` : ''}`);
    // These are sub-bullets OF the ledger line above, so they have to be pushed
    // here — emitted after the résumé-render block below they would nest under
    // whichever render bullet happened to be last.
    if (ach.stats) {
      const s = ach.stats;
      lines.push(`  - mined ${s.mined ?? 0} → dropped-by-refute ${s.droppedByRefute ?? 0}, demoted-by-check ${s.demotedByCheck ?? 0}, evidence-misses ${s.evidenceMisses ?? 0}`);
      // claim-figure-leaks (§3.2 telemetry, achievementLedger.js) never demotes
      // confidence and touches no other counter above — without its own line
      // a miner that leaked a self-computed figure into `claim` text would be
      // invisible in every report despite the check running and catching it.
      // date/direction misses surfaced alongside it for the same reason: both
      // are advisory-only (never gate, per computeLedger's doc-comment) so
      // neither shows up anywhere else either.
      lines.push(`  - claim-figure-leaks ${s.claimFigureLeaks ?? 0}, date-misses ${s.dateMisses ?? 0}, direction-misses ${s.directionMisses ?? 0}`);
    }
    if (ach.skipped) lines.push(`  - ⚠️ ${ach.skipped}`);
    // Local render → page-count → fit loop (jobApplication.js's
    // renderResumeWithFit / resumeRender.js, SKILL.md §5) — the only place a
    // "why did I get a 2-page résumé" or "why is there no PDF" question is
    // answerable: attempts shows exactly what was tried (density per attempt,
    // measured page count or the error that aborted it) in generation order.
    if (a.render) {
      const r = a.render;
      // fontsLoaded is per-attempt (renderPdf's document.fonts.ready-plus-
      // display-family check, resumeRender.js) and absent on error-path
      // entries (never got far enough to check) — folded into each attempt so
      // a "#1=3p" that actually rendered in fallback fonts doesn't look
      // identical to a genuine good render.
      const attemptsStr = (Array.isArray(r.attempts) ? r.attempts : [])
        .map((att) => {
          const markup = att.markup;
          const shape = markup
            ? ` {${markup.chars ?? '?'} chars, ${markup.roles ?? '?'} roles/${markup.bullets ?? '?'} bullets/${markup.skillRows ?? '?'} skill rows, ${markup.hash || '?'}}`
            : '';
          return `#${att.attempt}${att.density ? `[${att.density}]` : ''}=${att.error ? `error(${att.error})` : `${att.pageCount}p${att.fontsLoaded === false ? '[fonts-unloaded]' : ''}`}${shape}`;
        })
        .join(', ');
      // renderResumeWithFit (jobApplication.js) deliberately measures the
      // WORST CASE — every candidate skill visible, so a later all-verified
      // export still fits — never what actually ships. Label it as such: the
      // shipped baseline (candidates start hidden) can legitimately be fewer
      // pages, since a hidden skill takes zero layout space.
      const resumeRevisionLabel = r.revisionApplied
        ? ` · ${r.revisionAttempts ?? 1} length-revision call(s)`
        : '';
      lines.push(`- Résumé fit-loop (worst case, ALL candidate skills shown — NOT the shipped page count): target ${r.targetPageCount ?? '?'}p · ${r.initialPageCount ?? '?'}→${r.finalPageCount ?? '?'}p${r.compactApplied ? ' · compact applied' : ''}${resumeRevisionLabel}`);
      if (attemptsStr) lines.push(`  - attempts: ${attemptsStr}`);
      if (r.revisionDiagnostics?.input && r.revisionDiagnostics?.output) {
        const before = r.revisionDiagnostics.input;
        const after = r.revisionDiagnostics.output;
        lines.push(`  - length revision: ${before.chars ?? '?'}→${after.chars ?? '?'} chars · bullets ${before.bullets ?? '?'}→${after.bullets ?? '?'} · role summaries ${before.roleSummaries ?? '?'}→${after.roleSummaries ?? '?'} · skill rows ${before.skillRows ?? '?'}→${after.skillRows ?? '?'} · hash ${before.hash || '?'}→${after.hash || '?'}`);
        // No source-order structural clamp runs after a revision: the model
        // retains the evidence it ranked highest for this specific job.
        const editor = r.revisionDiagnostics.editorOutput;
        if (editor) {
          lines.push(`    - AI editor output: ${editor.chars ?? '?'} chars · bullets ${editor.bullets ?? '?'} · role summaries ${editor.roleSummaries ?? '?'} · skill rows ${editor.skillRows ?? '?'} · hash ${editor.hash || '?'}`);
        }
      }
      if (Array.isArray(r.revisionHistory) && r.revisionHistory.length > 1) {
        lines.push(`  - revision history: ${r.revisionHistory.map(item => `#${item.attempt ?? '?'} ${item.input?.hash || '?'}→${item.output?.hash || '?'}`).join(' · ')}`);
      }
      if (r.revisionError) lines.push(`  - revision stopped: ${historyReportValue(r.revisionError, '', 400)}`);
      if (r.error) lines.push(`  - ⚠️ ${r.error}`);
      // The single most important line in this section: without it, "no PDF
      // because fonts never loaded" renders identically to "no PDF because
      // rendering broke" (both show fontsLoaded:false, error:null) — a reader
      // would go hunting for a render bug that doesn't exist instead of
      // recognizing a web-font connectivity/content-blocking problem rather
      // than a generic renderer failure.
      if (r.fontsLoaded === false) {
        lines.push('  - ⚠️ Google-hosted web fonts failed to load — likely unavailable network access, content blocking, or a browser font-load failure. Any PDF from this run was discarded (fallback-typeface PDFs never ship) and the fit loop skipped straight to ship (a page count measured in fallback fonts is meaningless). Inspect the missing-face detail in ResumeRender logs, restore access to fonts.googleapis.com/fonts.gstatic.com, and retry.');
      }
      // The shipped baseline is a SEPARATE render (candidates start hidden,
      // buildApplicationDocument() below) — its page count comes free from
      // that render (renderPdf always returns pageCount alongside the bytes),
      // so it is recorded here rather than adding a second render pass just
      // for this diagnostic. `not measured` means the baseline render itself
      // never completed (see the error line below), not that the number was
      // skipped to save time.
      lines.push(`- Résumé shipped baseline: ${r.baselinePageCount != null ? `${r.baselinePageCount}p` : 'not measured'}${r.baselinePdfProduced ? ' · PDF produced' : ' · ⚠️ no PDF (HTML-only)'}${r.baselineFontsLoaded === false ? ' · web fonts failed to load (page count measured against fallback typefaces — unreliable)' : ''}`);
      if (r.coverLetterPageCount != null || r.coverLetterPdfProduced != null || r.coverLetterPdfError) {
        lines.push(`- Cover-letter final render: ${r.coverLetterPageCount != null ? `${r.coverLetterPageCount}p` : 'not measured'}${r.coverLetterPdfProduced ? ' · PDF produced' : ' · ⚠️ no PDF'}${r.coverLetterFontsLoaded === false ? ' · web fonts failed to load' : ''}${r.coverLetterPdfError ? ` · ⚠️ ${historyReportValue(r.coverLetterPdfError, '', 300)}` : ''}`);
      }
      if (r.locationReviewRequired) {
        lines.push(`  - ⚠️ Work-location confirmation required before Sync: candidate \`${String(r.candidateLocation || 'unknown').replace(/`/g, "'")}\` → job \`${String(r.jobLocation || 'unknown').replace(/`/g, "'")}\``);
      }
      if (!r.baselinePdfProduced && r.baselinePdfError) lines.push(`  - ⚠️ ${historyReportValue(r.baselinePdfError, '', 300)}`);
    }
    // Skill-opportunity analysis (jobApplication.js's analyzeSkillOpportunities
    // → resumeHtml.js's injectInferredSkills) — the one place a "why did this
    // verified skill file under the wrong Skills heading" question is
    // answerable at all. canonicalSkillName/resumeCategory are model-supplied
    // (APPLICATION_SKILL_OPPORTUNITY_SCHEMA), so verifyItems is bounded and
    // shown as plain quoted text, not interpolated into anything structural —
    // same treatment as every other model string in this report.
    if (a.skillOpportunities) {
      const so = a.skillOpportunities;
      lines.push(`- Skill-opportunity analysis: ${so.itemCount ?? 0} item(s) — ${so.verifyCount ?? 0} verify, ${so.learnCount ?? 0} learn · histogram ${so.histogramRoleCount ?? 0} role(s)${so.recordedAfterArtifacts != null ? ` · demand ${so.recordedAfterArtifacts ? 'recorded' : 'NOT recorded'} after artifacts` : ''}`);
      if (so.error) lines.push(`  - ⚠️ ${historyReportValue(so.error, '', 300)}`);
      const vi = so.verifyItems;
      if (vi && Array.isArray(vi.sample) && vi.sample.length) {
        lines.push('  - verify items (canonical skill → résumé category, model-supplied, shown verbatim):');
        for (const item of vi.sample) {
          lines.push(`    - "${item.canonicalSkillName || '(empty)'}" → "${item.resumeCategory || '(empty)'}"`);
        }
        if (vi.truncated) lines.push(`    - _${vi.total - vi.sample.length} additional verify item(s) omitted from this bounded sample._`);
      } else if ((so.verifyCount ?? 0) > 0) {
        lines.push('  - ⚠️ verify items counted but no per-item detail was captured this run.');
      }
    }
    if (a.variantAttrs) lines.push(`- Résumé variant: \`${String(a.variantAttrs).slice(0, 200)}\``);
    lines.push(`- Résumé markup: ${a.resumeHtmlLen || 0} chars${escScan(a.resumeHtmlSample)}`);
    if (cl.needsAvailable != null || Array.isArray(cl.checks)) {
      const checks = Array.isArray(cl.checks) ? cl.checks : [];
      const unmet = checks.filter(check => check?.passed === false);
      const proseRevisionLabel = cl.revised
        ? `revised ${cl.revisionAttempts ?? 1} time(s)`
        : 'not revised';
      lines.push(`- Cover-letter harness: needs ${cl.needsAvailable ? 'available' : 'unavailable'} (${cl.needsCount ?? 0}) · top need ${cl.topNeedArgued ? 'argued' : 'not argued'} · ${cl.mappingCount ?? 0} mapping(s) · plan ${cl.planRetried ? 'retried once' : 'not retried'}${cl.planDegraded ? ' · direct-prose degrade used' : ''} · prose ${proseRevisionLabel} · page count ${cl.pageCount ?? 'not measured'}`);
      if (Array.isArray(cl.revisionHistory) && cl.revisionHistory.length) {
        lines.push(`  - prose revision history: ${cl.revisionHistory.map(item => `#${item.attempt ?? '?'} ${item.beforeChars ?? '?'}→${item.afterChars ?? '?'} chars · ${item.observationCount ?? '?'} observation(s) · ${item.beforeSha256 || '?'}→${item.afterSha256 || '?'}`).join(' · ')}`);
      }
      if (cl.revisionError) lines.push(`  - prose revision stopped: ${historyReportValue(cl.revisionError, '', 400)}`);
      const hasDescription = a.jobContext?.scrapedDescriptionAvailable === true;
      const hasResearch = a.jobContext?.researchAvailable === true;
      const needsSource = hasDescription && hasResearch
        ? 'scraped job description + live research'
        : hasDescription
          ? 'scraped job description (research unavailable)'
          : hasResearch
            ? 'live research + job metadata'
            : 'job metadata only (title/company/location/salary; no scraped description or research)';
      lines.push(`  - needs evidence source: ${needsSource}`);
      if (cl.needsError) lines.push(`  - needs observation: ${historyReportValue(cl.needsError, '', 300)}`);
      if (cl.planRetryReason) lines.push(`  - plan retry observation: ${historyReportValue(cl.planRetryReason, '', 500)}`);
      lines.push(`  - checks: ${checks.length - unmet.length}/${checks.length} passed${unmet.length ? ` · ${unmet.length} unmet` : ''}`);
      for (const check of unmet.slice(0, 8)) {
        lines.push(`    - ${String(check?.id || 'unknown').slice(0, 80)}: ${historyReportValue(check?.detail, '', 500)}`);
      }
      if (unmet.length > 8) lines.push(`    - _${unmet.length - 8} additional unmet check(s) omitted from this bounded report._`);
      const dropped = Array.isArray(cl.droppedNeeds) ? cl.droppedNeeds : [];
      for (const item of dropped.slice(0, 6)) {
        lines.push(`  - dropped need: ${JSON.stringify(String(item?.need || ''))} — ${JSON.stringify(String(item?.reason || ''))}`);
      }
      if (dropped.length > 6) lines.push(`  - _${dropped.length - 6} additional dropped need(s) omitted from this bounded report._`);
    }
    if (a.coverLetterPlan) {
      const planJson = JSON.stringify(a.coverLetterPlan, null, 2);
      const planCap = 8000;
      lines.push(`- Cover-letter argument plan${planJson.length > planCap ? ' — truncated' : ''}:`);
      lines.push('```json');
      lines.push(planJson.slice(0, planCap));
      lines.push('```');
      if (planJson.length > planCap) lines.push(`  - _Plan truncated: ${planJson.length - planCap} character(s) omitted._`);
    } else if (cl.planDegraded) {
      lines.push('- Cover-letter argument plan: unavailable; direct evidence-backed prose degradation path used.');
    }
    lines.push('- Cover-letter fields (JSON.stringify — whitespace/escapes shown literally):');
    if (cl.tagline) lines.push(`  - tagline: ${JSON.stringify(cl.tagline)}`);
    lines.push(`  - salutation: ${JSON.stringify(cl.salutation || '')}`);
    lines.push(`  - recipient: ${JSON.stringify(cl.recipient || '')}`);
    if (Array.isArray(cl.contact) && cl.contact.length) lines.push(`  - contact: ${JSON.stringify(cl.contact)}`);
    const paras = Array.isArray(cl.paragraphs) ? cl.paragraphs : [];
    paras.forEach((p, i) => lines.push(`  - paragraph[${i}]: ${JSON.stringify(String(p ?? ''))}`));
    lines.push(`  - closing: ${JSON.stringify(cl.closing || '')}`);
    if (cl.signatureTitle) lines.push(`  - signatureTitle: ${JSON.stringify(cl.signatureTitle)}`);
    if (a.resumeHtmlSample) {
      lines.push('- Résumé markup sample (first 1500 chars — head only; covers the <main> tag + variant attrs and part of Experience, but never reaches Skills):');
      lines.push('```html');
      lines.push(a.resumeHtmlSample);
      lines.push('```');
    }
    // The Skills `<dl>` is where skill-opportunity injection actually lands
    // (resumeHtml.js's injectInferredSkills) — captured separately from the
    // head-slice sample above because that slice never reaches it. Pulled
    // from the FINAL document, so a merge/create decision that filed a
    // verified skill under an unexpected heading is visible here.
    if (a.resumeSkillsDlSample) {
      if (a.resumeSkillsDlSample.found) {
        lines.push(`- Résumé Skills block (\`<dl class="skills">\`, from the final document)${a.resumeSkillsDlSample.truncated ? ' — truncated' : ''}:`);
        lines.push('```html');
        lines.push(a.resumeSkillsDlSample.sample);
        lines.push('```');
        if (a.resumeSkillsDlSample.truncated) lines.push('  - _Sample truncated at the bound above; full markup exists on disk in the saved workspace._');
      } else {
        lines.push('- ⚠️ Résumé Skills block (`<dl class="skills">`) was not found in the final document.');
      }
    }
    // The head slice starts at <main> and runs out inside the first role's
    // header, so the repeating Experience block — where the fit loop's
    // structural edits actually land — had no representation in this report
    // at all. One whole role shows what shipped: bullet count per role,
    // whether a role-meta row survived the summary cut, and where the
    // location ended up.
    if (a.resumeRoleBlockSample) {
      if (a.resumeRoleBlockSample.found) {
        lines.push(`- Résumé role block (first of ${a.resumeRoleBlockSample.roleCount || '?'} \`<article class="role">\`, from the model's final \`<main>\`)${a.resumeRoleBlockSample.truncated ? ' — truncated' : ''}:`);
        lines.push('```html');
        lines.push(a.resumeRoleBlockSample.sample);
        lines.push('```');
        if (a.resumeRoleBlockSample.truncated) lines.push('  - _Sample truncated at the bound above; full markup exists on disk in the saved workspace._');
      } else {
        lines.push('- ⚠️ Résumé role block (`<article class="role">`) was not found in the final résumé markup.');
      }
    }
    if (a.applicationExport) {
      const ex = a.applicationExport;
      const exportOutcome = ex.status === 'saved'
        ? (ex.integrityVerified ? 'saved + integrity verified' : 'saved and read back')
        : ex.status === 'failed' ? '⚠️ failed' : ex.status || 'unknown';
      lines.push(`\n### Application Export (last)${ago(ex.savedAt || ex.failedAt)}`);
      lines.push(`- Outcome: **${exportOutcome}**${ex.phase ? ` · phase: ${ex.phase}` : ''}`);
      if (ex.destination) lines.push(`- Destination: \`${String(ex.destination).replace(/`/g, "'").slice(0, 1000)}\``);
      if (ex.error) lines.push(`- Error: \`${historyReportValue(ex.error, '', 800)}\``);
      if (ex.bundleError) lines.push(`- ⚠️ Bundle warning: ${historyReportValue(ex.bundleError, '', 500)}`);
      if (Array.isArray(ex.manifest) && ex.manifest.length) {
        lines.push('- Destination readback manifest:');
        for (const item of ex.manifest.slice(0, 8)) {
          const state = item.exists
            ? `${item.readable ? 'readable' : 'NOT readable'} · ${item.bytes ?? 0} bytes${item.mtimeMs ? ` · mtime ${new Date(item.mtimeMs).toISOString()}` : ''}${item.sha256 ? ` · sha256 ${item.sha256}` : ''}${item.matchesSource != null ? ` · source bytes ${item.matchesSource ? 'exact' : 'MISMATCH'}` : ''}${item.pdfHeaderValid != null ? ` · PDF header ${item.pdfHeaderValid ? 'valid' : 'INVALID'}` : ''}${item.pdfParsed != null ? ` · PDF parse ${item.pdfParsed ? `valid (${item.pageCount ?? '?'}p${item.firstPagePoints ? `, ${item.firstPagePoints}pt` : ''})` : 'INVALID'}` : ''}${item.htmlStructureValid != null ? ` · HTML workspace ${item.htmlStructureValid ? `valid (${item.htmlPanelCount ?? '?'} panels, Sync config ${item.syncConfigValid ? 'valid' : 'INVALID'})` : 'INVALID'}` : ''}${item.markdownNonEmpty != null ? ` · listing ${item.markdownNonEmpty ? 'non-empty' : 'EMPTY'}` : ''}`
            : item.expected === false ? 'not generated · stale sibling absent' : 'MISSING';
          lines.push(`  - ${item.name || '(unnamed artifact)'}: ${state}${item.error ? ` · ${historyReportValue(item.error, '', 300)}` : ''}`);
        }
      }
      if (ex.sync) {
        const sync = ex.sync;
        const serviceState = sync.serverListening ? 'listening' : sync.serverStarting ? 'starting (not listening yet)' : 'NOT listening';
        lines.push(`- Local edit Sync: ${sync.registered ? 'workspace registered' : 'NOT registered'} · service ${serviceState}${sync.endpoint ? ` · ${String(sync.endpoint).slice(0, 200)}` : ''}${sync.error ? ` · ${historyReportValue(sync.error, '', 300)}` : ''}`);
      }
      if (ex.revealSucceeded != null) lines.push(`- Opened destination folder: ${ex.revealSucceeded ? '✅' : `❌${ex.revealError ? ` — ${historyReportValue(ex.revealError, '', 300)}` : ''}`}`);
      lines.push('- Submission state: not tracked — use this bundle to apply manually on the employer site.');
    } else if (a.status === 'completed') {
      lines.push('- Application export: not recorded — generation completed, but this process has no verified destination readback for the last attempt.');
    }
    }
  }

  if (applicationSync) {
    const syncOutcome = applicationSync.status === 'completed'
      ? 'completed + integrity verified'
      : applicationSync.status === 'failed' ? '⚠️ failed' : applicationSync.status || 'unknown';
    lines.push(`\n### Application Sync (last)${ago(applicationSync.finishedAt || applicationSync.failedAt || applicationSync.startedAt || applicationSync.ts)}`);
    lines.push(`- Outcome: **${syncOutcome}**${applicationSync.phase ? ` · phase: ${applicationSync.phase}` : ''}`);
    lines.push(`- Document: ${applicationSync.document === 'cover' ? 'cover letter' : applicationSync.document === 'resume' ? 'résumé' : applicationSync.document || 'unknown'}`);
    lines.push(`- Workspace: \`${String(applicationSync.workspaceDir).replace(/`/g, "'").slice(0, 1000)}\``);
    if (applicationSync.error) lines.push(`- Error: \`${historyReportValue(applicationSync.error, '', 500)}\``);
    if (Array.isArray(applicationSync.manifest) && applicationSync.manifest.length) {
      lines.push('- Revision readback manifest:');
      for (const item of applicationSync.manifest.slice(0, 4)) {
        const state = `${item.readable ? 'readable' : 'NOT readable'} · ${item.bytes ?? 0} bytes${item.mtimeMs ? ` · mtime ${new Date(item.mtimeMs).toISOString()}` : ''}${item.sha256 ? ` · sha256 ${item.sha256}` : ''}${item.matchesSource != null ? ` · source bytes ${item.matchesSource ? 'exact' : 'MISMATCH'}` : ''}${item.pdfParsed != null ? ` · PDF parse ${item.pdfParsed ? `valid (${item.pageCount ?? '?'}p${item.firstPagePoints ? `, ${item.firstPagePoints}pt` : ''})` : 'INVALID'}` : ''}${item.htmlStructureValid != null ? ` · HTML workspace ${item.htmlStructureValid ? `valid (Sync config ${item.syncConfigValid ? 'valid' : 'INVALID'})` : 'INVALID'}` : ''}`;
        lines.push(`  - ${item.name || '(unnamed artifact)'}: ${state}${item.error ? ` · ${historyReportValue(item.error, '', 300)}` : ''}`);
      }
    }
  }

  // ── Model resolution (§8) ───────────────────────────────────────────────────
  // Kept to a line or two on purpose (clipboard-cap discipline — see
  // clipboardCap.js's logs+events tail floor; this section sits ahead of that
  // floor so it must stay cheap). The skip list is the whole point: a model
  // that silently failed the capability gate and fell to next-newest looks
  // IDENTICAL to "no new generation happened" unless it's named here.
  if (modelRes) {
    const r = modelRes.resolved || {};
    const age = modelRes.fetchedAt ? formatAge(modelRes.fetchedAt) : 'never resolved this run — pinned floor in use';
    lines.push(`\n### Model Resolution (Claude family tokens)`);
    lines.push(`- OPUS \`${r.OPUS || '?'}\` · SONNET \`${r.SONNET || '?'}\` · HAIKU \`${r.HAIKU || '?'}\` · source: ${modelRes.source || 'floor'} · resolved ${age} · epoch ${modelRes.epoch ?? 0}`);
    if (Array.isArray(modelRes.skipped) && modelRes.skipped.length > 0) {
      lines.push(`  - ⚠️ Skipped: ${modelRes.skipped.map(s => `\`${s.id}\` (${s.family}: ${s.reason})`).join('; ')}`);
    }
  }

  return `
## Job Search Pipeline
${attributionNote}> Last run's funnel, captured in the main process so it survives hub deletion
> and log-buffer scroll. The "found → analyzed" gap answers "did we analyze all
> the jobs?": dedup / age / already-seen drops are expected; placeholder or
> unscored jobs are not. Each stage stamps independently — a captcha-resolve
> can score pending jobs with no fresh search this session.

${lines.join('\n')}
`;
}
