import crypto from 'node:crypto';
import { officialPostingSemanticInputHash } from './officialPostingSemantic.js';

// Process-local latest observations, never a history of private listing data.
// Only the double-hashed input correlation, fixed enums, counts and host time
// enter this store. The source input and its semantic proof hash are discarded.
export const OFFICIAL_POSTING_DISCOVERY_DIAGNOSTIC_LIMIT = 200;
const MAX_COUNT = 1_000_000_000;
const REJECTION_REASONS = Object.freeze(['source-unproven', 'aggregator-source', 'unsafe-url', 'invalid-source']);
export const OFFICIAL_POSTING_RENDER_FAILURE_REASONS = Object.freeze([
  'renderer-unavailable', 'timeout', 'unsafe-source', 'oversize', 'fetch-failed', 'other',
]);
const OUTCOMES = new Set(['found', 'not-found', 'ambiguous', 'closed', 'unreadable', 'failed']);
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
      renderStats: row.renderStats ? { ...row.renderStats, failures: { ...row.renderStats.failures } } : null })),
  };
}

export function buildOfficialPostingDiscoveryMarkdown() {
  const snapshot = getOfficialPostingDiscoveryDiagnosticsSnapshot();
  const rows = snapshot.observations;
  const lines = [
    '## Official Posting Discovery Diagnostics (OFFDISC)',
    '> Process-local, latest observation per source input, newest first; at most 200 inputs. Earlier attempts are replaced, not added to totals. No prior-process reconstruction is available after a restart.',
    '> Counts, fixed rejection reasons and opaque input digests only. No listing identities, URLs, prompts, candidate text, raw errors or semantic proof hashes are retained.',
    '> Validated comparison runs count responses that passed host validation, not attempted calls, failed responses or research calls.',
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
      lines.push(`- ${row.at} · input #${row.input.slice(0, 10)} · candidates ${row.candidateCount ?? 'not recorded'} · eligible ${row.eligibleCount ?? 'not recorded'} · rejected ${reasons} · validated comparison runs ${row.comparisonRuns ?? 'not recorded'} · outcome ${row.outcome} · settled ${row.settled === null ? row.stage === 'semantic' ? 'pending' : 'not recorded' : row.settled ? 'yes' : 'no'} · stage ${row.stage} · semantic settled ${row.semanticSettled === null ? 'not recorded' : row.semanticSettled ? 'yes' : 'no'}`);
      if (row.renderStats) {
        const render = row.renderStats;
        const failures = OFFICIAL_POSTING_RENDER_FAILURE_REASONS.map(reason => `${reason}=${render.failures[reason]}`).join(', ');
        lines.push(`  - Rendering: attempts ${render.attempts ?? 'not recorded'} · successes ${render.successes ?? 'not recorded'} · cache reuses ${render.cacheReuses ?? 'not recorded'} · failures ${failures}`);
      }
    }
  }
  return `\n${lines.join('\n')}\n`;
}

export function _resetOfficialPostingDiscoveryDiagnosticsForTests() {
  observations.clear();
}
