import crypto from 'node:crypto';
import { officialPostingSemanticInputHash } from './officialPostingSemantic.js';
import { RESEARCH_UNSETTLED_TRAIL } from './officialPostingFields.js';

// Process-local latest observations, never a history of private listing data.
// Only the double-hashed input correlation, fixed enums, counts and host time
// enter this store. The source input and its semantic proof hash are discarded.
export const OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT = 200;
const MAX_COUNT = 1_000_000_000;
const REJECTION_REASONS = Object.freeze(['source-unproven', 'aggregator-source', 'unsafe-url', 'invalid-source']);
export const OFFICIAL_POSTING_RENDER_FAILURE_REASONS = Object.freeze([
  'renderer-unavailable', 'timeout', 'unsafe-source', 'oversize', 'fetch-failed', 'other',
]);
const OUTCOMES = new Set(['found', 'link-only', 'not-found', 'ambiguous', 'closed', 'unreadable', 'failed']);
export const OFFICIAL_POSTING_HANDOFF_FAILURE_CODES = Object.freeze([
  'bridge-timeout', 'bridge-aborted', 'bridge-unavailable', 'comparative-unavailable', 'comparative-invalid',
  'worker-lost', 'worker-replaced', 'comparison-contaminated', 'fresh-context-required', 'requeue-exhausted',
  'renderer-unavailable', 'sender-destroyed', 'renderer-stopped', 'renderer-navigated', 'request-timeout',
  'type-error', 'syntax-error', 'range-error', 'abort-error', 'unexpected-error',
]);
const HANDOFF_ERROR_CODES = new Map([
  ...OFFICIAL_POSTING_HANDOFF_FAILURE_CODES.map(code => [code, code]),
  ['OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE', 'comparative-unavailable'],
  ['OFFICIAL_POSTING_COMPARATIVE_INVALID', 'comparative-invalid'],
  ['OFFICIAL_POSTING_RESPONSE_INVALID', 'comparative-invalid'],
  ['BRIDGE_WORKER_LOST', 'worker-lost'], ['BRIDGE_WORKER_REPLACED', 'worker-replaced'],
  ['BRIDGE_COMPARISON_CONTAMINATED', 'comparison-contaminated'],
  ['BRIDGE_FRESH_CONTEXT_REQUIRED', 'fresh-context-required'], ['BRIDGE_REQUEUE_EXHAUSTED', 'requeue-exhausted'],
  ['BRIDGE_RENDERER_UNAVAILABLE', 'renderer-unavailable'], ['IPC_SENDER_DESTROYED', 'sender-destroyed'],
  ['IPC_RENDERER_STOPPED', 'renderer-stopped'], ['IPC_RENDERER_NAVIGATED', 'renderer-navigated'],
  ['IPC_REQUEST_TIMEOUT', 'request-timeout'],
]);
const HANDOFF_ERROR_NAMES = new Map([['TypeError', 'type-error'], ['SyntaxError', 'syntax-error'],
  ['RangeError', 'range-error'], ['AbortError', 'abort-error']]);
const observations = new Map();
const attempts = new WeakMap();

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(MAX_COUNT, value) : null;
}

function renderCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ attempts: count(value.attempts), successes: count(value.successes),
    cacheReuses: count(value.cacheReuses), failures: Object.freeze(Object.fromEntries(
      OFFICIAL_POSTING_RENDER_FAILURE_REASONS.map(reason => [reason, count(value.failures?.[reason]) ?? 0]))) });
}

function chatCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze(Object.fromEntries(['finderCalls', 'judgeRounds', 'judgeCalls', 'snapshotReads',
    'snapshotFailures', 'truncatedSnapshots'].map(key => [key, count(value[key])])));
}

/** Closed error classes only: arbitrary codes, messages and names may contain private data. */
export function officialPostingHandoffFailureCode(error, signal) {
  try {
    if (signal?.aborted) return HANDOFF_ERROR_CODES.get(signal.reason?.code) || 'bridge-aborted';
    if (HANDOFF_ERROR_CODES.has(error?.code)) return HANDOFF_ERROR_CODES.get(error.code);
    if (Array.isArray(error?.correctionDetails)) return 'comparative-invalid';
    return HANDOFF_ERROR_NAMES.get(error?.name) || 'unexpected-error';
  } catch { return 'unexpected-error'; }
}

function handoffFailureCodes(value) {
  return Object.freeze([...new Set((Array.isArray(value) ? value : [])
    .filter(code => OFFICIAL_POSTING_HANDOFF_FAILURE_CODES.includes(code)))]);
}

export function officialPostingHandoffFailureCause(error) {
  try { return HANDOFF_ERROR_CODES.get(error?.recoveryCode) || null; }
  catch { return null; }
}

/** Never retain a renderer error, its message, module path or requested URL. */
export function officialPostingRenderFailureReason(error) {
  try {
    const codes = [error?.code, error?.cause?.code];
    if (codes.some(code => ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(code))) return 'renderer-unavailable';
    if (error?.name === 'TimeoutError' || codes.some(code => ['fetch-timeout', 'bridge-timeout', 'ETIMEDOUT', 'ERR_TIMED_OUT'].includes(code))) return 'timeout';
    if (codes.some(code => ['unsafe-source', 'unsafe-url', 'unsafe-address'].includes(code))) return 'unsafe-source';
    if (codes.some(code => ['oversize', 'ERR_BUFFER_TOO_LARGE'].includes(code))) return 'oversize';
    if (codes.some(code => ['fetch-failed', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED'].includes(code))) return 'fetch-failed';
  } catch { /* Unknown diagnostic inputs retain no details. */ }
  return 'other';
}

function record(job, metadata, stage) {
  try {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return null;
    const { candidateCount, eligibleCount, rejected, outcome, settled, comparisonRuns } =
      metadata && typeof metadata === 'object' ? metadata : {};
    const input = crypto.createHash('sha256')
      .update(`official-posting-discovery-v1\0${officialPostingSemanticInputHash(job)}`)
      .digest('hex').slice(0, 16);
    const reasons = Object.fromEntries(REJECTION_REASONS.map(reason =>
      [reason, count(rejected?.[reason]) ?? 0]));
    const observation = Object.freeze({
      input,
      at: new Date().toISOString(),
      candidateCount: count(candidateCount),
      eligibleCount: count(eligibleCount),
      rejected: Object.freeze(reasons),
      outcome: OUTCOMES.has(outcome) ? outcome : 'unknown',
      stage,
      semanticSettled: stage === 'semantic' && typeof settled === 'boolean' ? settled : null,
      settled: stage === 'final' && typeof settled === 'boolean' ? settled : null,
      comparisonRuns: count(comparisonRuns),
      renderStats: renderCounts(metadata?.renderStats),
      chatStats: chatCounts(metadata?.chatStats),
      failureCodes: handoffFailureCodes(metadata?.failureCodes),
      resolutionReasons: Object.freeze([...new Set((Array.isArray(metadata?.resolutionReasons) ? metadata.resolutionReasons : [])
        .filter(code => RESEARCH_UNSETTLED_TRAIL.includes(code)))]),
    });
    observations.delete(input);
    observations.set(input, observation);
    while (observations.size > OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT) {
      observations.delete(observations.keys().next().value);
    }
    const attempt = Object.freeze({});
    attempts.set(attempt, { input, observation });
    return attempt;
  } catch {
    // A malformed source or diagnostic must never interrupt a lookup.
    return null;
  }
}

/** Counts describe one resolution attempt; repeated input observations replace it. */
export function recordOfficialPostingDiscovery(job, metadata = {}) {
  return Boolean(record(job, metadata, 'final'));
}

/** A semantic decision cannot establish that fetching and persistence finished. */
export function recordOfficialPostingSemanticDiscovery(job, metadata = {}) {
  return record(job, metadata, 'semantic');
}

/** Only this exact, still-current attempt may finalize its retained counts. */
export function finalizeOfficialPostingDiscovery(attempt, metadata = {}) {
  try {
    const receipt = attempts.get(attempt);
    if (!receipt || observations.get(receipt.input) !== receipt.observation) return false;
    const { outcome, settled, renderStats } = metadata && typeof metadata === 'object' ? metadata : {};
    attempts.delete(attempt);
    observations.set(receipt.input, Object.freeze({ ...receipt.observation, stage: 'final',
      outcome: OUTCOMES.has(outcome) ? outcome : 'unknown', settled: typeof settled === 'boolean' ? settled : null,
      renderStats: renderStats === undefined ? receipt.observation.renderStats : renderCounts(renderStats) }));
    return true;
  } catch { return false; }
}

export function getOfficialPostingDiscoveryDiagnosticsSnapshot() {
  return {
    limit: OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT,
    observations: [...observations.values()].map(row => ({ ...row, rejected: { ...row.rejected },
      renderStats: row.renderStats ? { ...row.renderStats, failures: { ...row.renderStats.failures } } : null,
      chatStats: row.chatStats ? { ...row.chatStats } : null, failureCodes: [...row.failureCodes], resolutionReasons: [...row.resolutionReasons] })),
  };
}

export function buildOfficialPostingDiscoveryMarkdown() {
  const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
  const rows = snapshot.observations;
  const lines = [
    '## Official Posting Discovery Diagnostics (OFFDISC)',
    '> Process-local, latest observation per source input, newest first; at most 200 inputs. Earlier attempts are replaced, not added to totals. No prior-process reconstruction is available after a restart.',
    '> Counts, fixed rejection reasons, closed handoff error classes and opaque input digests only. No listing identities, URLs, prompts, candidate text, raw errors or semantic proof hashes are retained.',
    '> Validated comparison runs count responses that passed host validation, not attempted calls, failed responses or research calls.',
    '> Source-eligibility rejection counts apply to host crawls only. Chat lookups report supplied leads as candidates; host eligibility is not assessed. Chat resolution reasons retain final unsettled trail codes only. Chat counts include service calls across all review rounds, not transport-owned correction attempts. Snapshot failures do not prove the judges could not read a page themselves. Cache reuse does not create or relabel an observation.',
    '> Semantic settled describes candidate comparison only. Final settled describes the host resolution after fetch coverage, cancellation and durability checks; it does not report a later, separate service save. A pending semantic observation is not a completed lookup. Cache reuse does not create or relabel an attempt.',
    '> Render counts cover this host resolution: attempts invoke the renderer, successes return valid completed HTML, cache reuses scan a previously rendered receipt, and failures retain fixed reasons only. Incomplete rendered HTML counts as an other failure. No error messages, paths or URLs are retained.',
    `- Captured: ${new Date().toISOString()} · ${rows.length} input observation(s) retained`,
  ];
  if (!rows.length) {
    lines.push('- No discovery observation retained in this process. Saved card outcomes do not reconstruct which candidates were discovered or rejected.');
  } else {
    lines.push(`- Latest observations: zero candidates ${rows.filter(row => row.candidateCount === 0).length} · candidates without eligible sources ${rows.filter(row => row.candidateCount > 0 && row.eligibleCount === 0).length} · inputs with validated comparisons ${rows.filter(row => row.comparisonRuns > 0).length} · settled ${rows.filter(row => row.settled === true).length}`);
    for (const row of [...rows].reverse()) {
      const reasons = REJECTION_REASONS.map(reason => `${reason}=${row.rejected[reason]}`).join(', ');
      const eligibility = row.chatStats ? 'eligible not assessed · source eligibility rejections not assessed'
        : `eligible ${row.eligibleCount ?? 'not recorded'} · rejected ${reasons}`;
      lines.push(`- ${row.at} · input #${row.input.slice(0, 10)} · candidates ${row.candidateCount ?? 'not recorded'} · ${eligibility} · validated comparison runs ${row.comparisonRuns ?? 'not recorded'} · outcome ${row.outcome} · settled ${row.settled === null ? row.stage === 'semantic' ? 'pending' : 'not recorded' : row.settled ? 'yes' : 'no'} · stage ${row.stage} · semantic settled ${row.semanticSettled === null ? 'not recorded' : row.semanticSettled ? 'yes' : 'no'}`);
      if (row.renderStats) {
        const render = row.renderStats;
        const failures = OFFICIAL_POSTING_RENDER_FAILURE_REASONS.map(reason => `${reason}=${render.failures[reason]}`).join(', ');
        lines.push(`  - Rendering: attempts ${render.attempts ?? 'not recorded'} · successes ${render.successes ?? 'not recorded'} · cache reuses ${render.cacheReuses ?? 'not recorded'} · failures ${failures}`);
      }
      if (row.chatStats) {
        const chat = row.chatStats;
        lines.push(`  - Chat discovery: finder calls ${chat.finderCalls ?? 'not recorded'} · judge rounds ${chat.judgeRounds ?? 'not recorded'} · judge calls ${chat.judgeCalls ?? 'not recorded'} · snapshots read ${chat.snapshotReads ?? 'not recorded'} · snapshot failures ${chat.snapshotFailures ?? 'not recorded'} · truncated snapshots ${chat.truncatedSnapshots ?? 'not recorded'}`);
        lines.push(`  - Chat resolution reasons: ${row.resolutionReasons.length ? row.resolutionReasons.join(', ') : 'none'}`);
      }
      if (row.failureCodes.length) lines.push(`  - Handoff failure classes: ${row.failureCodes.join(', ')}`);
    }
  }
  return `\n${lines.join('\n')}\n`;
}

export function _resetOfficialPostingDiscoveryDiagnosticsForTests() {
  observations.clear();
}
