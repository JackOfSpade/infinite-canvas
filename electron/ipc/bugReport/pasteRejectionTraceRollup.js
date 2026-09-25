import fs from 'fs';
import path from 'path';
import { isWithinDirectory } from '../../utils/pathSafety.js';
import { shortId } from './helpers.js';

/**
 * Durable, per-job rejection history rendered from each job's own
 * `Paste Rejections.json` sidecar (electron/ipc/localAiApplication.js's
 * PASTE_REJECTION_TRACE_FILE — appendPasteRejectionTrace appends one row per
 * rejected paste round, oldest-dropped-first). It is the ONLY record of a
 * rejection loop that survives an app restart: the process-local ring in
 * pasteHandoffDiagnostics.js is wiped on restart, and so is
 * localAiApplication.js's own in-memory pasteRejectionStreakByJob Map that
 * computes the `rejectionStreak` field stored in each row — a restart
 * mid-loop resets that counter to 1 on the very next rejection even though
 * the same cause never actually stopped failing. This section answers "is it
 * looping?" straight from the durable rows, independent of that counter, by
 * recomputing the longest run of consecutive same-cause rejections itself
 * (see longestRun below).
 *
 * Job discovery is NOT reinvented here: `localApplications` is the exact
 * array "Local AI Job State (live card snapshot)" (buildJobsPipelineSnapshot,
 * ./jobsSnapshot.js) already receives as a parameter — sourced by bugReport.js
 * from either payload.localApplications (the renderer's deep node scan) or a
 * top-level-node fallback — naming every job id relevant to the current
 * report. Each entry's own `localApplication.canvasFilePath` — the exact
 * field JobCardNode.jsx itself falls back to when it needs to resolve THIS
 * job's folder (its "Open Local AI Job Folder" / "Open saved folder"
 * handlers) — locates the job on disk; the report's own current canvas path
 * is the fallback for an older card that never stamped one.
 */

// Mirrors localAiApplication.js's own JOB_ID_RE exactly. Restated here rather
// than imported for the same reason pasteHandoffDiagnostics.js restates
// CHECK_FINGERPRINT_HEX_CHARS in its own header: this reader must never
// import from a file another agent owns, and a job id that does not match
// this shape can never have a real job folder, so treating it as
// undiscoverable rather than building a path from it is strictly safer.
const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Mirrors pasteHandoffDiagnostics.js's own CHECK_ID_RE / CHECK_FINGERPRINT_RE
// (CHECK_FINGERPRINT_HEX_CHARS = 8), restated for the same reason.
const CHECK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/u;
const CHECK_FINGERPRINT_RE = /^[0-9a-f]{8}$/u;
const MAX_CHECK_IDS = 16;

// How many current job cards' sidecars this section will open, and how many
// rejection rows it prints per job. The job cap matches "Local AI Job State
// (live card snapshot)" above's own 20-card cap, so this durable section can
// never claim to cover more current cards than the live section it augments.
// The row cap is tighter — this is a loop-detection aid, not a full audit
// trail — but wide enough to show a run longer than the incident this
// section exists to diagnose (4 consecutive rounds) without truncating it.
const MAX_JOBS_SCANNED = 20;
const MAX_ROWS_PER_JOB = 8;
// Mirrors localAiApplication.js's own MAX_PASTE_REJECTION_TRACE_BYTES
// (512_000) exactly: generous headroom over a realistically full 200-row
// trace (a few hundred bytes/row), so a legitimately full file is never
// mistaken for a tampered one. Restated for the same reason as JOB_ID_RE.
const MAX_TRACE_FILE_BYTES = 512_000;
// The exact filename appendPasteRejectionTrace writes
// (localAiApplication.js's own PASTE_REJECTION_TRACE_FILE), restated for the
// same reason.
const PASTE_REJECTION_TRACE_FILE = 'Paste Rejections.json';

function boundedInt(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

function boundedCheckIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === 'string' && CHECK_ID_RE.test(id)))].sort().slice(0, MAX_CHECK_IDS);
}

function boundedCheckFingerprints(value, allowedIds) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const id of allowedIds) {
    if (typeof value[id] === 'string' && CHECK_FINGERPRINT_RE.test(value[id])) out[id] = value[id];
  }
  return out;
}

// One row, validated field-by-field against the exact shape
// appendPasteRejectionTrace writes (localAiApplication.js's
// submitLocalApplicationHandoff, the `await appendPasteRejectionTrace(root,
// dir, {...})` call) — never trusting the file's own claimed `jobId` (the
// job id this reader already resolved the folder from is authoritative), and
// never passing any field through unvalidated, because this data is folded
// straight into a bug report a user may share. A row missing both `at` and
// `stage` carries nothing a reader could act on and is dropped rather than
// rendered as blank fields.
function boundedRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
  const stage = typeof raw.stage === 'string' ? raw.stage.slice(0, 40) : '';
  if (!Number.isFinite(atMs) || !stage) return null;
  const checkIds = boundedCheckIds(raw.checkIds);
  return {
    at: raw.at,
    atMs,
    stage,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : 'unknown',
    revision: boundedInt(raw.revision, 1_000_000),
    errorCount: boundedInt(raw.errorCount, 10_000),
    uncodedErrors: boundedInt(raw.uncodedErrors, 10_000),
    rejectionStreak: boundedInt(raw.rejectionStreak, 10_000),
    checkIds,
    checkFingerprints: boundedCheckFingerprints(raw.checkFingerprints, checkIds),
  };
}

// Longest run of CONSECUTIVE rows (file order, which is oldest-first —
// appendPasteRejectionTrace only ever pushes onto the end and drops from the
// front) that all name one particular (stage, check id, fingerprint) —
// tracked PER CHECK ID, not per whole-row signature. A row can fail more than
// one check at once, and that row's OTHER failing check(s) must never
// interrupt the run of a check that kept failing on every row regardless.
// Measured — this is the filed incident, not a hypothetical: round 1 failed
// {direct-welcome-closing, redundancy} together, then rounds 2-4 failed
// {direct-welcome-closing} alone. direct-welcome-closing never stopped
// failing across all four rounds, so the correct answer is a run of 4; a
// whole-row-signature comparison (round 1's signature != round 2's, since one
// carries an extra check) would report only 3 and silently drop the very
// round the incident started on. Per-check-id fingerprints (not just ids)
// are still required for the run to extend, for the same reason the row's
// own stored `rejectionStreak` (bumpPasteRejectionStreak, localAiApplication.js)
// is not trusted here instead: that counter compares check id SETS only, so
// it cannot tell a repeated check apart from the SAME check id failing on a
// DIFFERENT branch (measured: checkDirectWelcomeClosing, coverLetterChecks.js,
// has four branches that all report check id "direct-welcome-closing" with
// different fingerprints) — and it lives in a process-local map that a
// restart wipes, resetting to 1 on the very next rejection even though the
// same cause kept failing before and after the restart. Re-deriving every
// run from what is durably on disk, per check id, is restart-proof and
// branch-precise by construction.
//
// A row naming no check id at all (SCHEMA_INVALID, a nameless structural
// failure) can never be proven "the same cause" as anything: it contributes
// no key to extend, and the "drop any key this row didn't repeat" step below
// clears every run in progress on exactly that row -- a nameless row still
// breaks a streak, it just cannot be shown to be the SAME streak continuing.
function longestRun(rowsOldestFirst) {
  const runLengthByKey = new Map(); // "<stage> <checkId>:<fingerprint>" -> consecutive rows ending at the last row processed
  let best = { length: 0, stage: null, checkId: null, fingerprint: null };
  for (const row of rowsOldestFirst) {
    const seenThisRow = new Set();
    for (const checkId of row.checkIds) {
      const fingerprint = row.checkFingerprints[checkId] || '';
      const key = `${row.stage} ${checkId}:${fingerprint}`;
      seenThisRow.add(key);
      const length = (runLengthByKey.get(key) || 0) + 1;
      runLengthByKey.set(key, length);
      if (length > best.length) best = { length, stage: row.stage, checkId, fingerprint };
    }
    // Any key already in flight that this row did NOT repeat stops here --
    // delete it (rather than leave it stale) so a later, unrelated recurrence
    // of the same tuple starts counting a fresh run instead of resuming this
    // one across the gap.
    for (const key of runLengthByKey.keys()) {
      if (!seenThisRow.has(key)) runLengthByKey.delete(key);
    }
  }
  if (best.length === 0) return { length: 0, row: null };
  // Synthesize a single-check "row" for the caller to render -- deliberately
  // narrower than any actual stored row, since the run this reports may have
  // run through rows that also carried an unrelated second check (round 1
  // above) that was never part of the streak being described.
  return {
    length: best.length,
    row: { stage: best.stage, checkIds: [best.checkId], checkFingerprints: { [best.checkId]: best.fingerprint } },
  };
}

// Reads and bounds one job's durable trace. Every failure mode — absent file,
// a symlink where a regular file belongs, a file too large to trust, an
// unparsable or non-array body — collapses to the same 'unreadable'/'absent'
// state rather than throwing or rendering an empty-but-successful list: a
// report must never let "the sidecar could not be read" read as "nothing
// happened" (this file's own header rule, restated at the call site below).
function readJobTrace(traceFilePath) {
  let stat;
  try {
    stat = fs.lstatSync(traceFilePath);
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRACE_FILE_BYTES) return { state: 'unreadable' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(traceFilePath, 'utf8'));
  } catch {
    return { state: 'unreadable' };
  }
  if (!Array.isArray(parsed)) return { state: 'unreadable' };
  return { state: 'ok', rows: parsed.map(boundedRow).filter(Boolean) };
}

function formatRow(row) {
  const checks = row.checkIds.length
    ? ` · failed checks ${row.checkIds.map(id => `${id}${row.checkFingerprints[id] ? ` (${row.checkFingerprints[id]})` : ''}`).join(', ')}`
    : '';
  const uncoded = row.uncodedErrors ? ` · ${row.uncodedErrors} item(s) named no rule` : '';
  const errorCount = Number.isInteger(row.errorCount) ? ` · ${row.errorCount} validation item(s)` : '';
  const revision = Number.isInteger(row.revision) ? ` · revision ${row.revision}` : '';
  const streak = Number.isInteger(row.rejectionStreak) ? ` · streak ${row.rejectionStreak}` : '';
  return `  - ${row.at} · stage \`${row.stage}\` · ${row.reason}${revision}${errorCount}${checks}${uncoded}${streak}`;
}

function jobLabel(item) {
  const title = item.title || '(untitled)';
  const company = item.company || '(no company)';
  return `${title} @ ${company} · job \`${shortId(item.localApplication.id)}\``;
}

export function buildPasteRejectionTraceMarkdown(canvasFilePath, localApplications) {
  const candidates = (Array.isArray(localApplications) ? localApplications : [])
    .filter(item => typeof item?.localApplication?.id === 'string' && JOB_ID_RE.test(item.localApplication.id));
  if (candidates.length === 0) return '';

  // Dedupe by job id (a card could in principle be listed twice across the
  // deep-node scan this array is built from) while preserving first-seen
  // order, then apply the scanned-jobs cap stated in the rendered section.
  // The two drop reasons are counted separately (not folded into one
  // `candidates.length - jobs.length` delta) because they mean different
  // things to a reader: a dedup drop is a duplicate of a job already fully
  // represented in `jobs` — nothing was left out — while a cap drop is a
  // distinct job this report genuinely never looked at. Continuing the scan
  // past MAX_JOBS_SCANNED (rather than breaking, as this loop used to) is
  // required for that split to be correct: a duplicate id can appear AFTER
  // the cap was already hit, and only still walking the rest of `candidates`
  // can tell that later entry apart from a genuinely-unscanned distinct job.
  const seen = new Set();
  const jobs = [];
  let dedupDropped = 0;
  let capDropped = 0;
  for (const item of candidates) {
    if (seen.has(item.localApplication.id)) {
      dedupDropped += 1;
      continue;
    }
    seen.add(item.localApplication.id);
    if (jobs.length >= MAX_JOBS_SCANNED) {
      capDropped += 1;
      continue;
    }
    jobs.push(item);
  }
  // "Report safety limit" is a specific, load-bearing claim: it tells a
  // reader that real data exists but this report chose not to include it.
  // That wording must only appear when MAX_JOBS_SCANNED actually turned away
  // a distinct job (capDropped > 0) — a dedup drop is not withheld data, it
  // is the same job this report already shows, listed twice by the scan that
  // built `candidates`, and gets its own plain sentence instead.
  const scanNoteParts = [];
  if (dedupDropped > 0) {
    scanNoteParts.push(`${dedupDropped} duplicate-id entr${dedupDropped === 1 ? 'y' : 'ies'} (same job card listed twice by the source scan) already represented above`);
  }
  if (capDropped > 0) {
    scanNoteParts.push(`⚠️ ${capDropped} additional job card(s) with a Local AI id were not scanned (report safety limit ${MAX_JOBS_SCANNED})`);
  }
  const scanNote = scanNoteParts.length ? ` · ${scanNoteParts.join(' · ')}` : '';

  const lines = [];
  for (const item of jobs) {
    const jobId = item.localApplication.id;
    const ownerCanvasFilePath = typeof item.localApplication.canvasFilePath === 'string' && item.localApplication.canvasFilePath
      ? item.localApplication.canvasFilePath
      : canvasFilePath;
    if (typeof ownerCanvasFilePath !== 'string' || !ownerCanvasFilePath || !path.isAbsolute(ownerCanvasFilePath)) {
      lines.push(`- ${jobLabel(item)}: not retained (no saved canvas path to resolve this job's folder).`);
      continue;
    }
    const canvasRoot = path.dirname(path.resolve(ownerCanvasFilePath));
    const jobsRoot = path.join(canvasRoot, '.local-ai', 'jobs');
    const traceFilePath = path.join(jobsRoot, jobId, PASTE_REJECTION_TRACE_FILE);
    // Defense in depth alongside JOB_ID_RE above: even a validated id must
    // still resolve inside the exact folder this canvas owns.
    if (!isWithinDirectory(jobsRoot, traceFilePath)) {
      lines.push(`- ${jobLabel(item)}: not retained (job path escaped its canvas folder).`);
      continue;
    }
    let trace;
    try {
      trace = readJobTrace(traceFilePath);
    } catch {
      trace = { state: 'unreadable' };
    }
    if (trace.state === 'absent') {
      lines.push(`- ${jobLabel(item)}: not retained (no rejection trace on disk — either no paste round for this job was ever rejected, or the job folder is gone).`);
      continue;
    }
    if (trace.state === 'unreadable' || trace.rows.length === 0) {
      lines.push(`- ${jobLabel(item)}: not retained (rejection trace file could not be read as a trusted, well-formed record).`);
      continue;
    }
    const rows = trace.rows;
    const run = longestRun(rows);
    const runLabel = run.length > 1
      ? `longest same-cause run: ${run.length} consecutive rejection(s) — stage \`${run.row.stage}\`, check${run.row.checkIds.length > 1 ? 's' : ''} ${run.row.checkIds.map(id => `${id}${run.row.checkFingerprints[id] ? ` (${run.row.checkFingerprints[id]})` : ''}`).join(', ')}`
      : 'no repeated cause — every retained rejection differs in stage, check id, or branch';
    lines.push(`- ${jobLabel(item)} · ${rows.length} rejection(s) retained · ${runLabel}`);
    const newestFirst = [...rows].sort((a, b) => b.atMs - a.atMs).slice(0, MAX_ROWS_PER_JOB);
    for (const row of newestFirst) lines.push(formatRow(row));
    if (rows.length > newestFirst.length) {
      lines.push(`  - _${rows.length - newestFirst.length} older rejection(s) omitted (cap ${MAX_ROWS_PER_JOB} shown of ${rows.length} total)._`);
    }
  }

  return `
## Local Application Paste Rejection Trace (durable)
> Reads each current job card's own \`Paste Rejections.json\` sidecar (localAiApplication.js's PASTE_REJECTION_TRACE_FILE) — a durable, per-job record that survives an app restart, unlike the process-local Lifecycle section above. It exists to answer one question a restart mid-loop otherwise erases: is a paste handoff stuck repeating the SAME cause? "Longest same-cause run" is recomputed from these rows directly rather than trusted from any single row's own stored counter, because that counter is kept in a process-local map a restart resets.
> Metadata only: at/stage/reason/revision/errorCount/checkIds/checkFingerprints/rejectionStreak. Never the letter text, prompts, pasted responses, handoff codes, or validation detail text — the same privacy rule pasteHandoffDiagnostics.js states for the process-local section above.
- Scanned ${jobs.length} of ${candidates.length} current job card(s) carrying a Local AI id (cap ${MAX_JOBS_SCANNED})${scanNote} · rows shown newest-first, capped at ${MAX_ROWS_PER_JOB} per job.
${lines.join('\n')}
`;
}
