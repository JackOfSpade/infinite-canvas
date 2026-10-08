import { sanitizeActivityItem } from './log.js';
import {
  DEFAULT_HANDOFF_CONCURRENCY,
  MAX_HANDOFF_CONCURRENCY,
} from '../../../src/utils/handoffScheduler.js';

// A single redacted failed-start receipt survives runtime disposal so a FULL
// bug report can distinguish a rejected tunnel configuration from a readiness
// timeout. This module deliberately accepts and retains only closed values.

const PHASES = new Set(['listener-start', 'listener-probe', 'tunnel-start', 'tunnel-readiness']);
const CAUSES = new Set([
  'socket-unavailable', 'startup-timeout', 'readiness-timeout',
  'config-rejected', 'spawn-failed', 'flag-rejected', 'credentials-invalid',
  'tunnel-auth-rejected', 'hostname-not-public', 'network-unreachable',
  'binary-untrusted', 'binary-not-found', 'binary-changed', 'binary-copy-failed',
  'binary-copy-missing', 'binary-quarantined', 'binary-signature-invalid',
  'binary-unrecognized', 'binary-unsafe-path', 'binary-command-failed', 'owned-elsewhere',
  'metrics-port-in-use', 'unrequested-exit-loop', 'crash-loop', 'exited-early',
  'exited-unrequested', 'exited', 'stop-stuck', 'orphan-stuck', 'pid-reused', 'cancelled',
  // These can be surfaced by the supervisor's public-probe/restart path or
  // by a startup port that returns a closed supervisor result directly.
  'bad-hostname', 'bad-socket-path', 'not-ready', 'tunnel-not-serving',
  'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'edge-unreachable',
  'dns-not-found', 'offline', 'wrong-origin', 'unexpected-redirect', 'timeout',
  'too_large', 'refused', 'probe-failed', 'probe-restart', 'ps-failed', 'busy',
]);
const STATES = new Set(['off', 'blocked', 'needs-setup', 'needs-trust', 'starting', 'connecting', 'checking-public', 'online', 'degraded', 'backoff', 'paused', 'stopping', 'failed']);
const PROBE_STATES = new Set(['unknown', 'ok', 'failing']);
const PROBE_REASONS = new Set(['wrong-origin', 'unexpected-redirect', 'tunnel-not-serving', 'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'edge-unreachable', 'dns-not-found', 'hostname-not-public', 'offline', 'timeout', 'too_large', 'refused', 'other']);
const OAUTH_REJECTION_ROUTES = new Set(['authorize', 'token', 'revoke', 'mcp']);
const OAUTH_REJECTION_METHODS = new Set(['GET', 'POST']);
const OAUTH_REJECTION_REASONS = new Set(['origin-mismatch', 'fetch-site']);
const FETCH_SITES = new Set(['none', 'same-origin', 'same-site', 'cross-site', 'other']);
const OAUTH_REJECTION_STAGES = new Set(['http', 'consent']);
const FETCH_MODES = new Set(['navigate', 'other', 'absent']);
const FETCH_DESTINATIONS = new Set(['document', 'other', 'absent']);
const ORIGIN_SHAPES = new Set(['absent', 'self-exact', 'self-canonical', 'chatgpt-exact', 'opaque-null', 'https-other', 'invalid']);
const CONSENT_ACTIONS = new Set(['approve', 'deny', 'other', 'uninspected']);
const TRANSACTION_PRESENCE = new Set(['yes', 'no', 'uninspected']);
const CONSENT_POLICY_VERSIONS = new Set(['document-navigation-v2']);
const SOURCE_REJECTION_ROUTES = new Set(['mcp', 'token', 'revoke']);
const SOURCE_REJECTION_MODES = new Set(['enforce', 'alert']);
// The caller's network, placed in a closed class. A source prefix is sensitive
// link metadata, so the prefix itself never reaches this sink.
const SOURCE_CLASSES = new Set(['link-family', 'connector-range', 'other-public', 'private', 'unknown']);
const LINK_PRESENCE = new Set(['none', 'one', 'many', 'unreadable']);
// Exactly the token-endpoint outcome vocabulary from clientAuth.js. This is
// the MG1 measurement: which client authentication ChatGPT actually used.
const CLIENT_AUTH_OUTCOMES = new Set(['none', 'assertion_ok', 'assertion_bad_signature',
  'assertion_bad_claims', 'assertion_replay', 'assertion_unknown_kid', 'other']);
// Which grant was authenticated. Requiring an assertion is only justified once
// `refresh_token` has been seen signed; the code exchange alone is not enough.
const CLIENT_AUTH_GRANTS = new Set(['authorization_code', 'refresh_token', 'other']);

let latest = null;
let latestOAuthRejection = null;
let latestSourceRejection = null;
let latestClientAuth = null;
// Authenticated MCP throttles are an operational signal, not an identity
// signal. Keep only a bounded aggregate so a burst of ordinary waiting logs
// cannot evict the one fact needed to explain why workers stopped polling.
// In particular, this receipt never accepts a grant/link id, session key,
// source address, token, request body, or tool arguments.
let latestMcpRateLimit = null;
const finite = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? Math.round(value) : null;
const enumOr = (value, allowed, fallback = 'unknown') => allowed.has(value) ? value : fallback;

export function clearFailedStartDiagnostic() { latest = null; }

export function recordFailedStartDiagnostic({ telemetry = false, phase, cause, tunnel, startedAt = null, at = Date.now() } = {}) {
  const rawTunnel = tunnel && typeof tunnel === 'object' ? tunnel : {};
  const stamp = finite(at) ?? Date.now();
  const began = finite(startedAt);
  const probe = rawTunnel.probe && typeof rawTunnel.probe === 'object' ? rawTunnel.probe : {};
  const readiness = rawTunnel.readiness && typeof rawTunnel.readiness === 'object' ? rawTunnel.readiness : {};
  latest = Object.freeze({
    telemetry: telemetry === true,
    phase: enumOr(phase, PHASES),
    cause: enumOr(cause ?? rawTunnel.lastExit, CAUSES),
    tunnel: Object.freeze({
      state: enumOr(rawTunnel.state, STATES),
      lastExit: enumOr(rawTunnel.lastExit, CAUSES, null),
      probe: Object.freeze({
        state: enumOr(probe.state, PROBE_STATES),
        reason: enumOr(probe.reason, PROBE_REASONS),
        consecutiveFailures: Math.max(0, Math.min(999, finite(probe.consecutiveFailures) ?? 0)),
      }),
      readiness: Object.freeze({
        configurationValidated: readiness.configurationValidated === true,
        environmentHealthy: readiness.environmentHealthy === true,
        localReadinessPassed: readiness.localReadinessPassed === true,
        registeredConnectionCount: Math.max(0, Math.min(8, finite(readiness.registeredConnectionCount) ?? 0)),
      }),
    }),
    at: stamp,
    elapsedMs: began === null ? null : Math.max(0, Math.min(10 * 60_000, stamp - began)),
  });
  return latest;
}

export function getFailedStartDiagnostic() { return latest; }

// A rejected browser-origin check is useful support evidence, but its raw
// request data is never safe to retain. Keep one bounded, opt-in aggregate of
// fixed policy categories instead. In particular, this accepts no URL,
// hostname, Origin value, header, body, OAuth state, code, pairing value, or
// credential. Header values are classified inside http.js before this sink.
export function clearOAuthRejectionDiagnostic() { latestOAuthRejection = null; }

export function recordOAuthRejectionDiagnostic({ telemetry = false, route, method, reason, stage, fetchSite, fetchMode, fetchDest, originShape, consentAction, hasTxn, consentPolicyVersion, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  latestOAuthRejection = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestOAuthRejection?.telemetry === true ? latestOAuthRejection.count : 0) + 1),
    at: stamp,
    last: Object.freeze({
      route: enumOr(route, OAUTH_REJECTION_ROUTES),
      method: enumOr(method, OAUTH_REJECTION_METHODS),
      reason: enumOr(reason, OAUTH_REJECTION_REASONS),
      stage: enumOr(stage, OAUTH_REJECTION_STAGES),
      fetchSite: enumOr(fetchSite, FETCH_SITES),
      fetchMode: enumOr(fetchMode, FETCH_MODES),
      fetchDest: enumOr(fetchDest, FETCH_DESTINATIONS),
      originShape: enumOr(originShape, ORIGIN_SHAPES),
      consentAction: enumOr(consentAction, CONSENT_ACTIONS),
      hasTxn: enumOr(hasTxn, TRANSACTION_PRESENCE),
      consentPolicyVersion: enumOr(consentPolicyVersion, CONSENT_POLICY_VERSIONS),
      status: 403,
    }),
  });
  return latestOAuthRejection;
}

export function getOAuthRejectionDiagnostic() { return latestOAuthRejection; }

// A refused source answers ONE question a generic 401 cannot: the caller
// authenticated fine but reached us from a network this link was not paired
// from. Without it the failure reads as an expired token and the real cause --
// the connector's egress moving outside the pinned prefixes -- is invisible.
// Closed classes only: no address, prefix, hostname, header, or credential.
export function clearSourceRejectionDiagnostic() { latestSourceRejection = null; }

export function recordSourceRejectionDiagnostic({ telemetry = false, route, mode, sourceClass, links, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  latestSourceRejection = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestSourceRejection?.telemetry === true ? latestSourceRejection.count : 0) + 1),
    at: stamp,
    last: Object.freeze({
      route: enumOr(route, SOURCE_REJECTION_ROUTES),
      mode: enumOr(mode, SOURCE_REJECTION_MODES),
      sourceClass: enumOr(sourceClass, SOURCE_CLASSES),
      links: enumOr(links, LINK_PRESENCE),
    }),
  });
  return latestSourceRejection;
}

export function getSourceRejectionDiagnostic() { return latestSourceRejection; }

// Which client authentication the connector actually used at the token
// endpoint. The outcome was already computed there and then discarded, so the
// choice between pinning `private_key_jwt` and accepting `none` had no
// evidence behind it. Closed outcome vocabulary only: no assertion, key,
// header, claim, or credential.
export function clearClientAuthDiagnostic() { latestClientAuth = null; }

export function recordClientAuthDiagnostic({ telemetry = false, outcome, grant, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  const resolved = enumOr(outcome, CLIENT_AUTH_OUTCOMES);
  const resolvedGrant = enumOr(grant, CLIENT_AUTH_GRANTS);
  const priorRefresh = latestClientAuth?.telemetry === true && latestClientAuth.refreshSigned === true;
  latestClientAuth = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestClientAuth?.telemetry === true ? latestClientAuth.count : 0) + 1),
    at: stamp,
    outcome: resolved,
    grant: resolvedGrant,
    // Sticky: the decisive fact is whether a refresh has EVER been seen signed,
    // not whether the most recent exchange happened to be one.
    refreshSigned: priorRefresh || (resolvedGrant === 'refresh_token' && resolved === 'assertion_ok'),
    // The single fact the pin decision needs, stated without inference.
    method: resolved === 'none' ? 'none' : resolved === 'assertion_ok' ? 'assertion' : 'unknown',
  });
  return latestClientAuth;
}

export function getClientAuthDiagnostic() { return latestClientAuth; }

export function clearMcpRateLimitDiagnostic() { latestMcpRateLimit = null; }

export function recordMcpRateLimitDiagnostic({ telemetry = false, retryAfterSeconds, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  const retry = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1
    ? Math.min(3600, retryAfterSeconds)
    : null;
  latestMcpRateLimit = Object.freeze({
    telemetry: true,
    count: Math.min(999999, (latestMcpRateLimit?.telemetry === true ? latestMcpRateLimit.count : 0) + 1),
    at: stamp,
    retryAfterSeconds: retry,
  });
  return latestMcpRateLimit;
}

export function getMcpRateLimitDiagnostic() { return latestMcpRateLimit; }

// Copying a starter or continuation is a user-visible bridge transition, but
// neither the clipboard payload nor the prepared-chat capability is safe
// report data. Retain a short, opt-in trace of only the action and its closed
// terminal result. In particular this deliberately has no session code,
// prompt, path, job/lane identity, renderer input, or failure text.
const CHAT_COPY_ACTIONS = new Set(['new', 'continue']);
const CHAT_COPY_OUTCOMES = new Set([
  'copied', 'clipboard-failed', 'declined', 'no-window', 'not-ready',
  'not-linked', 'paused', 'internal',
]);
const CHAT_COPY_RESTART_PATHS = new Set(['ui-ack', 'native']);
const CHAT_COPY_TRACE_LIMIT = 20;
let chatCopyTrace = [];

export function clearBridgeChatCopyDiagnostic() { chatCopyTrace = []; }

export function recordBridgeChatCopyDiagnostic({ telemetry = false, action, outcome, restartPath, chatOrdinal, at = Date.now() } = {}) {
  if (telemetry !== true || !CHAT_COPY_ACTIONS.has(action) || !CHAT_COPY_OUTCOMES.has(outcome)) return null;
  const entry = Object.freeze({
    at: finite(at) ?? Date.now(),
    action,
    outcome,
    ...(CHAT_COPY_RESTART_PATHS.has(restartPath) ? { restartPath } : {}),
    ...(Number.isSafeInteger(chatOrdinal) && chatOrdinal >= 1 && chatOrdinal <= 999 ? { chatOrdinal } : {}),
  });
  chatCopyTrace = [...chatCopyTrace, entry].slice(-CHAT_COPY_TRACE_LIMIT);
  return entry;
}

// ui.js keeps the IPC reply shape stable. It can pass that reply here without
// expanding the trace boundary: this mapper reads only the fixed success/code
// fields, projects them to the vocabulary above, and returns the original
// reply untouched. Any error detail or unexpected field is discarded.
function chatCopyOutcomeFromReply(reply) {
  try {
    if (reply?.success === true && reply?.copied === true) return 'copied';
    switch (reply?.code) {
      case 'CLIPBOARD_FAILED': return 'clipboard-failed';
      case 'DECLINED': return 'declined';
      case 'NO_WINDOW': return 'no-window';
      case 'NOT_LINKED': return 'not-linked';
      case 'PAUSED': return 'paused';
      case 'NOT_READY': case 'NO_CHAT': case 'TUNNEL_NOT_READY':
      case 'TUNNEL_NOT_SERVING': case 'UNAVAILABLE': case 'DISABLED': case 'BUSY': return 'not-ready';
      default: return 'internal';
    }
  } catch { return 'internal'; }
}

export function recordBridgeChatCopyResult({ telemetry = false, action, restartPath, result, at = Date.now() } = {}) {
  let chatOrdinal;
  try {
    chatOrdinal = result?.success === true && result?.copied === true ? result.chatOrdinal : undefined;
  } catch { chatOrdinal = undefined; }
  recordBridgeChatCopyDiagnostic({
    telemetry,
    action,
    restartPath,
    outcome: chatCopyOutcomeFromReply(result),
    chatOrdinal,
    at,
  });
  return result;
}

export function getBridgeChatCopyDiagnostic() {
  return Object.freeze(chatCopyTrace.map(entry => ({ ...entry })));
}

// The live supervisor owns a redacted output ring, but a failed startup tears
// that owner down before the renderer can ask for it.  Preserve a short
// *structured* substitute rather than copying arbitrary child output into a
// longer-lived store.  Every interpolated value below has already passed a
// closed enum gate in recordFailedStartDiagnostic(), so this cannot disclose a
// path, hostname, tunnel/connector id, credential, or secret.
export function getFailedStartDiagnosticLines() {
  if (latest?.telemetry !== true) return Object.freeze([]);
  const tunnel = latest.tunnel || {};
  const probe = tunnel.probe || {};
  const readiness = tunnel.readiness || {};
  const lines = [
    `Bridge startup failed: ${latest.phase}.`,
    `Startup cause: ${latest.cause}.`,
    `Tunnel state: ${tunnel.state}; last exit: ${tunnel.lastExit || 'none'}.`,
    `Configuration validation: ${readiness.configurationValidated === true ? 'passed' : 'not completed'}; environment check: ${readiness.environmentHealthy === true ? 'healthy' : 'not observed'}; local readiness: ${readiness.localReadinessPassed === true ? 'passed' : 'not confirmed'}.`,
    `Observed registered tunnel connections: ${readiness.registeredConnectionCount || 0}.`,
  ];
  if (probe.state === 'failing') {
    lines.push(`Public probe: ${probe.reason}; consecutive failures: ${probe.consecutiveFailures}.`);
  }
  return Object.freeze(lines);
}

// ---------------------------------------------------------------------------
// Application lane queue, for FULL bug reports.
//
// The report used to carry no lane state at all, so a released lane whose
// bundle had been discarded could not be told apart from a healthy one. This
// is a PULL: the composition registers a provider, the report asks for a view
// when it is generated, and everything is reduced here to closed enums,
// integers and an 8-hex job prefix. No path, title, company, prompt, handoff
// code, chat key or hostname can pass through it. The provider returns null
// when the person's report-telemetry opt-in is off.
const QUEUE_PHASES = new Set(['unread', 'awaiting', 'host', 'needs_user', 'held', 'done', 'gone']);
const QUEUE_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const QUEUE_REASONS = new Set(['user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap', 'job_broken', 'render_retry', 'app_fix_required', 'canvas_unavailable', 'read_failed', 'write_failed', 'submit_stuck', 'host_silent', 'lapsed', 'restart']);
const QUEUE_SERVING = new Set(['off', 'live', 'paused', 'stopping', 'starting', 'failed', 'error']);
const QUEUE_PAUSE_CAUSES = new Set(['user', 'idle', 'anomaly', 'network', 'expiry', 'sleep', 'quit', 'tunnel', 'other']);
const QUEUE_FAULTS = new Set(['persist_failed', 'source_failed', 'other']);
const QUEUE_CHAT_STATES = new Set(['none', 'awaiting-first-call', 'reached', 'working', 'idle', 'full', 'ended']);
const QUEUE_COUNT_KEYS = [
  'releaseCalls', 'releaseNoops', 'unreleaseCalls', 'lanesDropped', 'droppedDiscarded', 'droppedPruned', 'droppedMissing', 'droppedSaved',
  // These are engine-owned aggregate verdict totals. They make a rejected
  // submit visible even when a later flood of waiting GETs displaced its log
  // line, without retaining response text, handoff codes, or worker keys.
  'submitAccepted', 'submitRejected', 'submitDuplicate', 'submitJunk', 'submitSuperseded', 'submitMisrouted', 'submitHeld', 'submitTooLarge',
];
const QUEUE_MAX_LANES = 20;
// Worker lifecycle is intentionally a closed, capability-free diagnostic.
// The engine must never send a worker key, prompt, handoff code, or task label
// through this seam. These states are sufficient to tell an unstarted worker
// from a copied starter, a connected chat, and a chat currently processing
// work without turning the report into a transcript.
const QUEUE_WORKER_STATES = new Set(['available', 'ready', 'working', 'quiet', 'waiting', 'idle']);
const QUEUE_WORKER_OUTCOMES = new Set(['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended']);
const QUEUE_WORKER_QUIET_REASONS = new Set(['polling_stopped', 'answer_silent', 'fresh_context_required']);
const QUEUE_POOL_CLOSE_REASONS = new Set(['drained', 'source_ended', 'continued', 'rotated', 'link_changed', 'revoked', 'quit', 'disabled', 'other']);
const QUEUE_MAX_WORKERS = MAX_HANDOFF_CONCURRENCY;
const QUEUE_ACTIVITY_LIMIT = 20;
const QUEUE_PUSH_TASKS = new Set([
  'price-synthesis', 'price-synthesis-batch', 'bundle-price-synthesis', 'platform-fit-assessment',
  'resume-parse', 'career-profile-compile', 'career-profile-audit-completeness', 'career-profile-audit-grounding',
  'career-profile-audit-attribution', 'career-profile-audit-metrics', 'career-profile-audit-skills',
  'career-profile-audit-conflicts', 'career-profile-repair',
  'job-compensation-research', 'job-compensation-research-batch',
  'job-preference-research', 'job-preference-research-batch', 'job-query-generation', 'job-scoring',
  'job-taxonomy-plan', 'job-taxonomy-classify', 'job-taxonomy-classify-batch',
  'job-compensation-assessment', 'job-compensation-assessment-batch',
  'job-preference-interpretation', 'job-preference-evaluation',
  'job-preference-research-assessment', 'job-preference-research-batch-assessment',
  'job-location-consolidation-confirmation', 'job-role-audit', 'job-role-screen', 'job-role-screen-batch',
]);
const QUEUE_PUSH_EXCLUSION_REASONS = ['ending', 'settling', 'attachment', 'free_text', 'task_not_allowed', 'node_not_allowed', 'person_editing'];
const QUEUE_MAX_PUSH_HUBS = 50;
const QUEUE_CLAIM_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

let queueProvider = null;
let retiredQueue = null;

const smallInt = (value, max = 999999) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;

function reduceWorkerPool(rawPool) {
  const pool = rawPool && typeof rawPool === 'object' ? rawPool : {};
  const active = pool.active === true;
  const workers = active && Number.isSafeInteger(pool.workerCount)
    && pool.workerCount >= 1 && pool.workerCount <= QUEUE_MAX_WORKERS
    ? pool.workerCount
    : 0;
  const stateCounts = { available: 0, ready: 0, working: 0, quiet: 0, waiting: 0, idle: 0 };
  const seenOrdinals = new Set();
  const roster = [];
  let completed = 0;
  // This remains a reduction boundary even though engine.snapshot() already
  // projects it: a diagnostic provider is optional and must not inject an
  // arbitrary object into a retained bug report.
  if (active && workers > 0) for (const candidate of (Array.isArray(pool.workers) ? pool.workers : []).slice(0, QUEUE_MAX_WORKERS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const ordinal = candidate.ordinal;
    const state = candidate.state;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > workers || seenOrdinals.has(ordinal)
      || !QUEUE_WORKER_STATES.has(state)) continue;
    seenOrdinals.add(ordinal);
    const workerCompleted = smallInt(candidate.completed);
    completed = Math.min(999999, completed + workerCompleted);
    stateCounts[state] += 1;
    roster.push(Object.freeze({
      ordinal, state, completed: workerCompleted,
      firstCallAt: finite(candidate.firstCallAt), lastCallAt: finite(candidate.lastCallAt),
      lastCallKind: candidate.lastCallKind === 'get' || candidate.lastCallKind === 'submit' ? candidate.lastCallKind : null,
      lastOutcome: QUEUE_WORKER_OUTCOMES.has(candidate.lastOutcome) ? candidate.lastOutcome : null,
      lastOutcomeAt: finite(candidate.lastOutcomeAt),
      quietReason: QUEUE_WORKER_QUIET_REASONS.has(candidate.quietReason) ? candidate.quietReason : null,
      restarts: smallInt(candidate.restarts),
    }));
  }
  roster.sort((left, right) => left.ordinal - right.ordinal);
  const connected = stateCounts.working + stateCounts.quiet + stateCounts.waiting + stateCounts.idle;
  const rawPlan = pool.plan && typeof pool.plan === 'object' ? pool.plan : {};
  const recommended = Math.min(QUEUE_MAX_WORKERS, smallInt(rawPlan.recommended));
  // Backlog is a durable diagnostic total, not a live-worker allocation.
  // Preserve every safe integer; only recommended/expand values below are
  // constrained by the live-worker ceiling.
  const queued = smallInt(rawPlan.queued, Number.MAX_SAFE_INTEGER);
  const materialized = Number.isSafeInteger(rawPlan.materialized) && rawPlan.materialized >= 0
    ? Math.min(queued, Number.MAX_SAFE_INTEGER, rawPlan.materialized)
    : queued;
  const expandBy = Math.min(QUEUE_MAX_WORKERS, smallInt(rawPlan.expandBy));
  const reason = ['empty', 'one_work_item', 'maximum_parallelism', 'preserved_live_workers'].includes(rawPlan.reason)
    ? rawPlan.reason
    : 'empty';
  const expansionCount = Math.min(999, smallInt(rawPlan.expansionCount));
  const lastExpansionAt = finite(rawPlan.lastExpansionAt);
  const lastExpansionAdded = Math.min(QUEUE_MAX_WORKERS, smallInt(rawPlan.lastExpansionAdded));
  const history = (Array.isArray(pool.history) ? pool.history : []).slice(-3).flatMap(item => {
    if (!item || typeof item !== 'object' || !QUEUE_POOL_CLOSE_REASONS.has(item.reason)) return [];
    const workerCount = Number.isSafeInteger(item.workerCount) && item.workerCount >= 1 && item.workerCount <= QUEUE_MAX_WORKERS ? item.workerCount : 0;
    if (!workerCount) return [];
    const prior = reduceWorkerPool({ active: true, workerCount, workers: item.workers, plan: item.plan });
    return [Object.freeze({
      endedAt: finite(item.endedAt), reason: item.reason,
      workerCount, workers: prior.roster, plan: prior.plan,
    })];
  });
  return Object.freeze({
    active,
    // `workers` is the plan/capacity, never a claim that every chat connected.
    workers,
    observed: roster.length,
    unreported: Math.max(0, workers - roster.length),
    readyToCopy: stateCounts.available,
    starterCopied: stateCounts.ready,
    connected,
    working: stateCounts.working,
    quiet: stateCounts.quiet,
    waiting: stateCounts.waiting,
    idle: stateCounts.idle,
    completed,
    roster: Object.freeze(roster),
    // Aggregate-only planner evidence: safe to retain in a FULL report and
    // enough to distinguish a six-chat starter plan from later queued work.
    plan: Object.freeze({ recommended, queued, materialized, expandBy, reason, expansionCount, lastExpansionAt, lastExpansionAdded }),
    history: Object.freeze(history),
  });
}

export function reduceBridgeQueue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = finite(raw.at) ?? Date.now();
  const applications = raw.queue && typeof raw.queue === 'object' ? raw.queue : {};
  const chat = raw.chat && typeof raw.chat === 'object' ? raw.chat : {};
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const liveLaneCapacity = Number.isSafeInteger(limits.maxConcurrentHandoffs)
    && limits.maxConcurrentHandoffs >= 1
    ? Math.min(QUEUE_MAX_WORKERS, limits.maxConcurrentHandoffs)
    : DEFAULT_HANDOFF_CONCURRENCY;
  const setup = raw.setup && typeof raw.setup === 'object' ? raw.setup : {};
  const lanes = [];
  // Live lanes are what a report is FOR, so they are kept first and in full;
  // the room left over goes to the most recently changed finished lanes. (The
  // first-N-in-array-order this replaced kept the OLDEST lanes and could drop a
  // live one behind finished ones.)
  const rawLanes = Array.isArray(raw.lanes) ? raw.lanes.filter(lane => lane && typeof lane === 'object') : [];
  const isTerminal = lane => lane.phase === 'done' || lane.phase === 'gone';
  const changedAtOf = lane => finite(lane.changedAt) ?? 0;
  const ordered = [
    ...rawLanes.filter(lane => !isTerminal(lane)),
    ...rawLanes.filter(isTerminal).sort((a, b) => changedAtOf(b) - changedAtOf(a)),
  ].slice(0, QUEUE_MAX_LANES);
  for (const lane of ordered) {
    const match = typeof lane.jobId === 'string' ? /^([a-f0-9]{8})-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.exec(lane.jobId) : null;
    if (!match) continue;
    const changed = finite(lane.changedAt);
    lanes.push(Object.freeze({
      job: match[1].toLowerCase(),
      phase: enumOr(lane.phase, QUEUE_PHASES, 'unread'),
      stage: enumOr(lane.stage, QUEUE_STAGES, null),
      reason: enumOr(lane.reason, QUEUE_REASONS, null),
      servedToChat: Number.isSafeInteger(lane.servedToChat) && lane.servedToChat >= 0,
      ageSeconds: changed === null ? null : Math.max(0, Math.floor((at - changed) / 1000)),
    }));
  }
  const counts = {};
  for (const key of QUEUE_COUNT_KEYS) counts[key] = smallInt(raw.counts?.[key]);
  // Chat keys the engine did not recognise: counts and one time, nothing more.
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const lastUnrecognisedAt = finite(keys.lastUnrecognisedAt);
  // Push/MCP state has already been projected by engine.snapshot(), but reduce
  // it again here: a diagnostic provider is an optional seam and must not be
  // able to put a hub key, path, node id, request id, prompt, or arbitrary
  // label into a report. Only closed task/reason enums and aggregate counts
  // survive. In particular, unselected pending work is kept as a count so a
  // live bridge can be distinguished from work left in the manual dock.
  const rawScope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const rawPush = raw.push && typeof raw.push === 'object' ? raw.push : {};
  const selectedKeys = new Set((Array.isArray(rawPush.selectedHubs) ? rawPush.selectedHubs : [])
    .filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)).slice(0, QUEUE_MAX_PUSH_HUBS).map(key => key.toLowerCase()));
  const pushTasks = new Map();
  let discoveredHubs = 0;
  let discoveredPending = 0;
  let selectedDiscoveredHubs = 0;
  let selectedPending = 0;
  for (const hub of (Array.isArray(rawPush.discovered) ? rawPush.discovered : [])) {
    if (discoveredHubs >= QUEUE_MAX_PUSH_HUBS || !hub || typeof hub !== 'object'
        || typeof hub.key !== 'string' || !/^[a-f0-9]{64}$/i.test(hub.key)) continue;
    discoveredHubs += 1;
    const pending = smallInt(hub.pending);
    discoveredPending += pending;
    if (selectedKeys.has(hub.key.toLowerCase())) { selectedDiscoveredHubs += 1; selectedPending += pending; }
    for (const task of (Array.isArray(hub.tasks) ? hub.tasks : [])) {
      if (!task || typeof task !== 'object' || !QUEUE_PUSH_TASKS.has(task.task)) continue;
      pushTasks.set(task.task, Math.min(999999, (pushTasks.get(task.task) || 0) + smallInt(task.pending)));
    }
  }
  const rawPushDiagnostics = rawPush.diagnostics && typeof rawPush.diagnostics === 'object' ? rawPush.diagnostics : {};
  // Claim UUIDs are renderer-only correlation values. The report may state
  // only how many current claims exist, and only when they have the exact
  // opaque UUID shape; neither their text nor any arbitrary provider value
  // crosses this reduction boundary.
  const claimed = (Array.isArray(rawPush.claimed) ? rawPush.claimed : [])
    .filter(value => typeof value === 'string' && QUEUE_CLAIM_ID.test(value)).slice(0, 100).length;
  const available = (Array.isArray(rawPush.available) ? rawPush.available : [])
    .filter(value => typeof value === 'string' && QUEUE_CLAIM_ID.test(value)).slice(0, 100).length;
  const pushAtAge = value => {
    const stamp = finite(value);
    return stamp === null ? null : Math.max(0, Math.floor((at - stamp) / 1000));
  };
  const pushExclusions = Object.fromEntries(QUEUE_PUSH_EXCLUSION_REASONS.map(reason => [reason, smallInt(rawPushDiagnostics.exclusions?.[reason])]));
  const activity = (Array.isArray(raw.activity) ? raw.activity : []).slice(-QUEUE_ACTIVITY_LIMIT).flatMap(item => {
    const safe = sanitizeActivityItem(item);
    return safe ? [Object.freeze({ ...safe })] : [];
  });
  return Object.freeze({
    at,
    enabled: raw.enabled === true,
    serving: enumOr(raw.serving, QUEUE_SERVING, 'unknown'),
    // Counted from the whole queue, never from the (possibly truncated) list.
    liveLanes: smallInt(smallInt(applications.ready) + smallInt(applications.working) + smallInt(applications.needsYou)),
    // This is a live scheduler capacity, never a total-backlog limit. It is
    // closed numeric diagnostic data, constrained by the reviewed hard cap.
    liveLaneCapacity,
    autoRelease: raw.autoRelease === true,
    paused: raw.paused === null || raw.paused === undefined ? null : enumOr(raw.paused, QUEUE_PAUSE_CAUSES, 'other'),
    fault: raw.fault === null || raw.fault === undefined ? null : enumOr(raw.fault, QUEUE_FAULTS, 'other'),
    applications: Object.freeze({
      ready: smallInt(applications.ready), working: smallInt(applications.working), needsYou: smallInt(applications.needsYou),
      held: smallInt(applications.held), done: smallInt(applications.done),
    }),
    chat: Object.freeze({
      state: enumOr(chat.state, QUEUE_CHAT_STATES, 'none'),
      jobsAssigned: smallInt(chat.jobsAssigned, 99),
      startedAt: finite(chat.startedAt), firstCallAt: finite(chat.firstCallAt), lastCallAt: finite(chat.lastCallAt),
      lastCallKind: chat.lastCallKind === 'get' || chat.lastCallKind === 'submit' ? chat.lastCallKind : null,
      calls: smallInt(chat.calls),
      pool: reduceWorkerPool(chat.pool),
      bytes: smallInt(smallInt(chat.bytesServed, 100_000_000) + smallInt(chat.bytesReceived, 100_000_000), 100_000_000),
      // Cumulative traffic is diagnostic-only. A response-size limit protects
      // each call, but no per-chat traffic budget may retire a healthy worker.
      byteBudget: null,
    }),
    activity: Object.freeze(activity),
    lanes: Object.freeze(lanes),
    counts: Object.freeze(counts),
    keys: Object.freeze({
      unrecognisedRecent: smallInt(keys.unrecognisedRecent, 1000),
      unrecognisedWindowMinutes: smallInt(keys.unrecognisedWindowMinutes, 1440) || 10,
      lastUnrecognisedAt: lastUnrecognisedAt === null || lastUnrecognisedAt < 0 ? null : lastUnrecognisedAt,
      ended: smallInt(keys.ended),
    }),
    scope: Object.freeze({
      applications: rawScope.applications === true,
      scoring: rawScope.scoring === true,
      marketplace: rawScope.marketplace === true,
    }),
    readiness: Object.freeze({
      linked: setup.linked === true,
      tunnelReachable: setup.tunnelReachable === true,
    }),
    push: Object.freeze({
      discoveredHubs,
      selectedHubs: selectedKeys.size,
      optedOutHubs: smallInt(rawPush.optedOutHubs, QUEUE_MAX_PUSH_HUBS),
      selectedDiscoveredHubs,
      discoveredPending: Math.min(999999, discoveredPending),
      selectedPending: Math.min(999999, selectedPending),
      unselectedPending: Math.max(0, Math.min(999999, discoveredPending - selectedPending)),
      served: smallInt(rawPush.served),
      held: smallInt(rawPush.held),
      claimed,
      available,
      tasks: Object.freeze([...pushTasks.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([task, pending]) => Object.freeze({ task, pending }))),
      exclusions: Object.freeze(pushExclusions),
      exclusionScope: rawPushDiagnostics.exclusionScope === 'all' || rawPushDiagnostics.exclusionScope === 'selected' ? rawPushDiagnostics.exclusionScope : 'none',
      refreshAttempts: smallInt(rawPushDiagnostics.refreshAttempts),
      refreshFailures: smallInt(rawPushDiagnostics.refreshFailures),
      lastRefresh: rawPushDiagnostics.lastRefreshOk === true ? 'succeeded' : rawPushDiagnostics.lastRefreshOk === false ? 'failed' : 'none',
      lastRefreshAt: finite(rawPushDiagnostics.lastRefreshAt),
      lastRefreshAgeSeconds: pushAtAge(rawPushDiagnostics.lastRefreshAt),
      selectedPolls: smallInt(rawPushDiagnostics.selectedPolls),
      selectedPollFailures: smallInt(rawPushDiagnostics.selectedPollFailures),
      lastSelectedPoll: rawPushDiagnostics.lastSelectedPollOk === true ? 'succeeded' : rawPushDiagnostics.lastSelectedPollOk === false ? 'failed' : 'none',
      lastSelectedPollAt: finite(rawPushDiagnostics.lastSelectedPollAt),
      lastSelectedPollAgeSeconds: pushAtAge(rawPushDiagnostics.lastSelectedPollAt),
    }),
  });
}

export function setBridgeQueueDiagnosticProvider(provider) {
  queueProvider = typeof provider === 'function' ? provider : null;
  retiredQueue = null;
}

// Called when a runtime is torn down: remember its final view (still evidence
// for a report generated afterwards) and stop reading the dead engine.
export function retireBridgeQueueDiagnosticProvider(provider = queueProvider) {
  // Only the provider that is still current may retire: a late teardown of an
  // old runtime must not blank the replacement's live view.
  if (queueProvider && queueProvider === provider) {
    try { retiredQueue = reduceBridgeQueue(queueProvider()); } catch { /* keep the previous view */ }
    queueProvider = null;
  }
}

export function clearBridgeQueueDiagnostic() { queueProvider = null; retiredQueue = null; }

export function getBridgeQueueDiagnostic() {
  if (queueProvider) {
    try { return reduceBridgeQueue(queueProvider()); } catch { return null; }
  }
  return retiredQueue;
}
