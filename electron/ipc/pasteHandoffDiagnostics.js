// Process-local, privacy-safe receipts for the Local Application JSON
// copy/paste handoff. Do not add prompts, responses, job identifiers, handoff
// codes, validation text, or field names here: this data is exported in bug
// reports. The one exception is echoMatch below: its four keys are the fixed
// protocol envelope's own names (jobId, stage, handoffCode, baseHashes —
// constants of the schema, not anything read out of one response), and every
// value under them is a boolean, never a value copied from a response.
// checkIds below stands on the same ground: a check id is the pipeline's own
// name for a rule (PASTE_CHECK_PROSE_UNITS in electron/ipc/localAiApplication.js
// is the frozen, total enumeration, and the caller filters to it), never the
// detail text that names a paragraph, a quote, or a field. checkFingerprints
// stands on the same ground too, one rung further down: a check id alone
// cannot say WHICH BRANCH of a multi-branch check fired (measured on
// coverLetterChecks.js's checkDirectWelcomeClosing, which has four), so the
// caller (pasteRejectionCheckIds, checkObservationFingerprint, both in
// electron/ipc/localAiApplication.js) also derives a short digest per id from
// the observation's detail — but only after stripping every curly-quoted
// span (the letter's own quoted evidence, which changes every revision) and
// collapsing the varying paragraph/passage ordinal. What is stored here is
// that digest alone: eight hex characters, never the detail text it was
// computed from.
const RING_LIMIT = 40;
const MAX_CHECK_IDS = 16;
// A backstop on the shape the caller already guarantees by vocabulary.
const CHECK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/u;
// checkObservationFingerprint (electron/ipc/localAiApplication.js) truncates
// its digest to this many hex characters; restated here rather than imported
// because this file deliberately carries zero imports (see its own header,
// "Do not add prompts, responses, ... here" — a dependency-free module is
// easier to audit for exactly that promise). A cross-file test pins the two
// widths together.
const CHECK_FINGERPRINT_HEX_CHARS = 8;
const CHECK_FINGERPRINT_RE = new RegExp(`^[0-9a-f]{${CHECK_FINGERPRINT_HEX_CHARS}}$`, 'u');
const REPORT_LIMIT = 20;

const SAFE_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const SAFE_OUTCOMES = new Set(['accepted', 'rejected']);
const SAFE_REASONS = new Set([
  'INVALID_JSON',
  // The residual classification, and only the residual classification: what a
  // rejected round gets when some validator failed and the caller's own named
  // check id vocabulary (checkIds below) names none of them — pasteRejectionCheckIds's
  // own header in electron/ipc/localAiApplication.js. Before pasteRejectionReason
  // existed, every content-rule rejection landed here regardless of whether a
  // check id was known, which is how 16 consecutive rejections of a measured
  // incident (PASTE_REJECTION_ESCALATION_STREAK's own header in
  // electron/ipc/localAiApplication.js) were filed under "unknown cause" while
  // every one of them named check id "direct-welcome-closing" by exact id. A
  // round whose items name a known check now takes VALIDATION_FAILED instead
  // (below); this code means what it always said it meant: nothing about the
  // failure was named.
  'SCHEMA_INVALID',
  'DOMAIN_VALIDATION_FAILED',
  // Replaces the single overloaded STALE_HANDOFF (nothing else in the tree
  // read that literal value, so it was retired outright): the two gates that
  // used to share it fail for different reasons and need different repairs.
  // STALE_HANDOFF_ARGUMENT is the IPC-argument envelope gate throwing before
  // any response is parsed; STALE_HANDOFF_ECHO is validatePasteResponse
  // rejecting a parsed response whose echoed jobId/stage/handoffCode/
  // baseHashes do not match and were not a tolerated stale code. Collapsing
  // them back into one value is exactly what hid a live handoff deadlock: the
  // renderer's own code was current the whole time, and only the pasted
  // reply's echo was stale — a report that could not tell the two apart could
  // not tell that apart either.
  'STALE_HANDOFF_ARGUMENT',
  'STALE_HANDOFF_ECHO',
  // Recorded on an ACCEPTED outcome, not a rejection: the pasted reply echoed
  // a handoffCode this job minted for an earlier round of the SAME job and
  // stage, with baseHashes current, so the app accepted it and rewrote the
  // stale nonce rather than failing an otherwise-correct response.
  'STALE_ECHO_TOLERATED',
  'RESPONSE_TOO_LARGE',
  // The job ended because app-owned frozen state failed, not because the
  // pasted response did. Collapsing it into VALIDATION_FAILED would hide the
  // one distinction a reader of this report needs: no round was reopened.
  'JOB_INTEGRITY_FAULT',
  // A reply cut off by the chat's own output-length limit is invalid JSON
  // for a different reason than a malformed paste, and the fix is different
  // too -- get a complete reply, not paste more carefully. Keeping it out of
  // INVALID_JSON lets a reader of this report see that distinction without
  // re-deriving it from parser positions.
  'TRUNCATED_JSON',
  // A validator failed AND the caller can name which rule: pasteRejectionReason
  // (electron/ipc/localAiApplication.js) assigns this whenever the rejected
  // round's items name at least one id from the frozen check-id vocabulary,
  // reserving SCHEMA_INVALID (above) for the genuinely nameless case. Before
  // that function existed this value was assigned nowhere in the app —
  // reachable only as recordPasteHandoffDiagnostic's own defensive fallback
  // for a `reason` string outside this whole enum, which no caller ever
  // passed.
  'VALIDATION_FAILED',
]);

const receipts = [];

function boundedInteger(value, maximum) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : null;
}

// Booleans only, per this file's own header: which of the four echoed
// envelope fields matched the host's current state. Never the values
// themselves, only whether each one agreed — enough for a reader to tell "the
// renderer's code was current, only the reply's own echo was stale" apart
// from a genuinely different job or a genuinely different round, without any
// of the four values ever leaving this process.
function boundedEchoMatch(value) {
  if (!value || typeof value !== 'object') return null;
  const pick = key => (typeof value[key] === 'boolean' ? value[key] : null);
  const jobId = pick('jobId');
  const stage = pick('stage');
  const handoffCode = pick('handoffCode');
  const baseHashes = pick('baseHashes');
  return jobId === null && stage === null && handoffCode === null && baseHashes === null
    ? null : { jobId, stage, handoffCode, baseHashes };
}

// Which named rules a rejected round broke. Without this a streak of
// same-stage rejections is unreadable: every cover-letter round prints
// SCHEMA_INVALID, the residual code for "some validator failed", so a report
// can show six wasted handoffs at one revision and still not say which rule
// kept failing. Ids only, deduped, sorted, capped — no detail, no unit label,
// no field path, nothing read out of a pasted response.
function boundedCheckIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.filter(id => typeof id === 'string' && CHECK_ID_RE.test(id)))].sort();
  return ids.length ? ids.slice(0, MAX_CHECK_IDS) : null;
}

// Which BRANCH of a named rule fired, keyed by the same check id boundedCheckIds
// already validated. Validated with the same discipline as every other field
// this file keeps: only a plain object, only entries whose key is itself a
// valid check id and whose value is exactly CHECK_FINGERPRINT_HEX_CHARS lowercase
// hex characters (checkObservationFingerprint's own output shape, never
// re-derived here, only pattern-checked), and capped at MAX_CHECK_IDS entries —
// the same ceiling boundedCheckIds applies, since there is never more than one
// fingerprint per id.
function boundedCheckFingerprints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .filter(([id, fingerprint]) => CHECK_ID_RE.test(id) && typeof fingerprint === 'string' && CHECK_FINGERPRINT_RE.test(fingerprint))
    .slice(0, MAX_CHECK_IDS);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Record a Local Application paste handoff result.
 *
 * The caller must supply only the declared fields. `syntaxLine` and
 * `syntaxColumn` are parser positions, never response excerpts. `responseChars`
 * is the original pasted-string length. `revision` and `logCount` are the
 * handoff's own round/log counters, not response content. `delta` and
 * `patchCount` are small integers only (0/1, and a patch array length) — see
 * this file's own header: no text, code, or identifier belongs here, and a
 * scoped review-round delta carries none of those anyway
 * (electron/ipc/pasteReviewDelta.js). `errorCount` is how many validation
 * items the round produced, `checkIds` names the rules behind them, drawn by
 * the caller from the pipeline's own frozen check vocabulary, `checkFingerprints`
 * names WHICH BRANCH of each of those rules fired (an object keyed by check
 * id, each value an 8-hex-char digest computed by the caller's
 * checkObservationFingerprint — never detail text, never the letter's own
 * wording), and `uncodedErrors` counts the items that named no rule — counts,
 * rule names, and opaque digests, never the items themselves. `rejectionStreak`
 * is the caller's own already-computed consecutive-rejection count
 * (electron/ipc/localAiApplication.js's bumpPasteRejectionStreak — the SET-
 * keyed streak, an integer like every other count here) and `escalated` is a
 * plain boolean: whether this same round's correction prompt carried an
 * escalation block at all (a check id individually crossed
 * PASTE_REJECTION_ESCALATION_STREAK) — never the escalation text itself, and
 * never assumed from `rejectionStreak` reaching that threshold, because the
 * two can diverge (see this file's own SAFE_REASONS header on VALIDATION_FAILED
 * for the incident: a failing-check SET that shrinks while the one check that
 * matters keeps failing can escalate before the set-keyed count catches up).
 * This does not persist across restart.
 */
export function recordPasteHandoffDiagnostic({
  stage,
  outcome,
  reason,
  responseChars,
  syntaxLine,
  syntaxColumn,
  artifactCandidates,
  truncated,
  revision,
  logCount,
  echoMatch,
  delta,
  patchCount,
  errorCount,
  checkIds,
  checkFingerprints,
  uncodedErrors,
  rejectionStreak,
  escalated,
} = {}) {
  const item = {
    at: Date.now(),
    stage: SAFE_STAGES.has(stage) ? stage : 'unknown',
    outcome: SAFE_OUTCOMES.has(outcome) ? outcome : 'rejected',
    // The parser's own truncation diagnostic decides this regardless of what
    // the caller passed for `reason`: the caller only ever forwards a rejected
    // JSON parse as INVALID_JSON, and truncation is a fact the parser found,
    // not a fact the caller can know without re-deriving it.
    reason: truncated ? 'TRUNCATED_JSON' : (SAFE_REASONS.has(reason) ? reason : 'VALIDATION_FAILED'),
    responseChars: boundedInteger(responseChars, 10_000_000),
    syntaxLine: boundedInteger(syntaxLine, 1_000_000),
    syntaxColumn: boundedInteger(syntaxColumn, 1_000_000),
    artifactCandidates: boundedInteger(artifactCandidates, 1_000),
    revision: boundedInteger(revision, 1_000_000),
    logCount: boundedInteger(logCount, 1_000_000),
    echoMatch: boundedEchoMatch(echoMatch),
    // 1 for a scoped delta round, 0 for a whole-document round, null when the
    // round was never delta-eligible (every non-review stage, and a first
    // review round with no accepted prior review to overlay).
    delta: boundedInteger(delta, 1),
    patchCount: boundedInteger(patchCount, 1_000),
    errorCount: boundedInteger(errorCount, 10_000),
    checkIds: boundedCheckIds(checkIds),
    // Which branch of each id in checkIds fired, so a repeated rejection at
    // one revision can be read as "the same branch again" versus "a different
    // branch of the same rule" — see this file's own header and
    // pasteRejectionCheckIds' header in electron/ipc/localAiApplication.js.
    checkFingerprints: boundedCheckFingerprints(checkFingerprints),
    // How many of those items named no rule at all. Without it, "6 items ·
    // failed checks redundancy" cannot be read: six instances of one rule and
    // one rule plus five unnamed structural failures need different repairs.
    uncodedErrors: boundedInteger(uncodedErrors, 10_000),
    // The caller's own consecutive-rejection count for this job/stage, and
    // whether this round's correction prompt actually carried an escalation
    // block — this file's own header on the two params explains why
    // `escalated` is read from the caller rather than derived here by
    // comparing `rejectionStreak` to a threshold.
    rejectionStreak: boundedInteger(rejectionStreak, 10_000),
    escalated: typeof escalated === 'boolean' ? escalated : null,
  };
  // Successful submissions need no rejection metadata — except the one reason
  // value an acceptance can itself carry: STALE_ECHO_TOLERATED records that
  // this acceptance silently repaired a stale echoed nonce, which is exactly
  // the fact a reader needs to distinguish "answered cleanly" from "answered
  // correctly but from a chat still quoting an earlier round's envelope".
  if (item.outcome === 'accepted') {
    item.reason = item.reason === 'STALE_ECHO_TOLERATED' ? 'STALE_ECHO_TOLERATED' : null;
    item.syntaxLine = null;
    item.syntaxColumn = null;
    item.artifactCandidates = null;
    item.errorCount = null;
    item.checkIds = null;
    item.checkFingerprints = null;
    item.uncodedErrors = null;
    item.rejectionStreak = null;
    item.escalated = null;
  }
  receipts.push(item);
  if (receipts.length > RING_LIMIT) receipts.shift();
}

export function getPasteHandoffDiagnosticsSnapshot() {
  const total = receipts.length;
  const shown = receipts.slice(-REPORT_LIMIT).map(item => ({
    ...item,
    checkIds: item.checkIds ? [...item.checkIds] : null,
    checkFingerprints: item.checkFingerprints ? { ...item.checkFingerprints } : null,
  }));
  return { receipts: shown, total, omitted: Math.max(0, total - shown.length), limit: REPORT_LIMIT, sourceLimit: RING_LIMIT };
}

export function buildPasteHandoffDiagnosticsMarkdown() {
  const snapshot = getPasteHandoffDiagnosticsSnapshot();
  if (snapshot.receipts.length === 0) return '';
  const accepted = snapshot.receipts.filter(item => item.outcome === 'accepted').length;
  const rejected = snapshot.receipts.length - accepted;
  const retention = snapshot.omitted > 0
    ? ` · ${snapshot.omitted} older receipt(s) omitted (newest ${snapshot.receipts.length} of ${snapshot.total} shown)`
    : ` · ${snapshot.receipts.length} of ${snapshot.total} process receipt(s) shown`;
  const lines = [
    '## Local Application Paste Handoff Lifecycle',
    '> Process-local, metadata-only receipts. Prompts, pasted responses, handoff codes, job IDs, validation text, contact details, and source quotes are never retained here.',
    // `log N` is the job's own Generation Log sequence number, and that
    // sequence is shared with entries this list does not show — a
    // host-authored `host-fit-revision-requested` consumes an index exactly
    // as a paste receipt does. So its numbers skip, and on 2026-09-23 a run
    // went "revision 3 · log 3" straight to "revision 4 · log 5", which reads
    // as a lost receipt rather than an index spent on a system event. Say
    // which number it is instead of leaving the gap to be interpreted.
    '> `log N` is the shared Generation Log sequence number, not a count of these receipts: system events (for example a host-requested fit revision) consume indices too, so gaps in `log N` are expected and are not missing receipts.',
    `- Retained: ${snapshot.receipts.length} receipt(s) · ${accepted} accepted · ${rejected} rejected${retention} · source keeps newest ${snapshot.sourceLimit} receipt(s) per process`,
  ];
  for (const item of snapshot.receipts) {
    const at = Number.isFinite(item.at) ? new Date(item.at).toISOString() : 'time not recorded';
    const size = Number.isInteger(item.responseChars) ? ` · ${item.responseChars} chars` : '';
    // Unlike the old rejected-only ternary, `item.reason` alone decides this
    // now: it is null for an ordinary acceptance and 'STALE_ECHO_TOLERATED'
    // for one that silently repaired a stale echoed nonce, so the same
    // expression prints both without special-casing outcome.
    const reason = item.reason ? ` · ${item.reason}` : '';
    const location = item.outcome === 'rejected' && Number.isInteger(item.syntaxLine)
      ? ` · syntax line ${item.syntaxLine}${Number.isInteger(item.syntaxColumn) ? `, column ${item.syntaxColumn}` : ''}`
      : '';
    const artifacts = item.outcome === 'rejected' && Number.isInteger(item.artifactCandidates)
      ? ` · content-reference candidates ${item.artifactCandidates}`
      : '';
    const revision = Number.isInteger(item.revision) ? ` · revision ${item.revision}` : '';
    const logCount = Number.isInteger(item.logCount) ? ` · log ${item.logCount}` : '';
    // Proves the scoped-review-delta optimization (electron/ipc/pasteReviewDelta.js)
    // is actually being taken, not merely wired in: delta:1 is a round that
    // sent patches instead of whole documents, with the patch count beside
    // it; delta:0 is a whole-document round on a stage where a delta was
    // legal to send. Absent entirely on every round where delta was never
    // eligible (every non-review stage, and a first review round).
    const delta = item.delta === 1 ? ` · delta round, ${Number.isInteger(item.patchCount) ? item.patchCount : 0} patch(es)`
      : item.delta === 0 ? ' · whole-document round' : '';
    // Booleans only (this file's own header rule): whether the renderer's
    // current jobId/stage/handoffCode/baseHashes each matched what the pasted
    // reply echoed. This is the one piece FULL previously had no way to show:
    // a reader can see the renderer's own code was current (handoffCode:
    // true, or STALE_ECHO_TOLERATED above) while everything else about the
    // envelope also checks out, rather than guessing from a rejection count.
    const echo = item.echoMatch
      ? ` · echo jobId=${item.echoMatch.jobId} stage=${item.echoMatch.stage} handoffCode=${item.echoMatch.handoffCode} baseHashes=${item.echoMatch.baseHashes}`
      : '';
    // The failing rules, by the pipeline's own check ids. SCHEMA_INVALID is a
    // residual classification — it says a validator failed, not which — so
    // without these a repeated rejection at one revision reads as an
    // undiagnosable streak. `errorCount` larger than the id list means the
    // round also produced structural items that carry no check id.
    const errorCount = item.outcome === 'rejected' && Number.isInteger(item.errorCount)
      ? ` · ${item.errorCount} validation item(s)` : '';
    // Each id carries its fingerprint in parens when one was recorded, so a
    // reader sees which rule AND which of that rule's branches fired — e.g.
    // "failed checks direct-welcome-closing (a1b2c3d4)" — without disturbing
    // the base "failed checks <id>, <id>" shape existing reports and tests
    // already recognize when no fingerprint was supplied.
    const checks = item.outcome === 'rejected' && item.checkIds?.length
      ? ` · failed checks ${item.checkIds.map(id => `${id}${item.checkFingerprints?.[id] ? ` (${item.checkFingerprints[id]})` : ''}`).join(', ')}` : '';
    const uncoded = item.outcome === 'rejected' && item.uncodedErrors
      ? ` · ${item.uncodedErrors} item(s) named no rule` : '';
    // The consecutive-rejection count, and whether THIS round's correction
    // prompt actually carried an escalation block — the field a filed report
    // of a stuck streak never had (recordPasteHandoffDiagnostic's own header:
    // `grep -c streak` on one such report was 0). "(escalation sent)" prints
    // only when `escalated` is true, never derived from `rejectionStreak`
    // reaching a threshold here — the two are read from the caller
    // independently because they can diverge (same header). Without the
    // marker, a reader cannot tell "escalation fired and the writer still
    // repeated the branch" from "escalation never fired" — both look like a
    // rising streak number on their own.
    const streak = item.outcome === 'rejected' && Number.isInteger(item.rejectionStreak)
      ? ` · streak ${item.rejectionStreak}${item.escalated ? ' (escalation sent)' : ''}` : '';
    lines.push(`- ${at} · stage \`${item.stage}\` · ${item.outcome}${reason}${size}${revision}${logCount}${delta}${echo}${errorCount}${checks}${uncoded}${streak}${location}${artifacts}`);
  }
  return `\n${lines.join('\n')}\n`;
}

export function _resetPasteHandoffDiagnostics() {
  receipts.length = 0;
}
