// Renderer-side crash shield for the bridge IPC snapshot.  This is deliberately
// dependency-free: it must remain safe to import before Electron's preload is
// present (and against an older preload).
export const BRIDGE_STATUS_VERSION = 1;

export const AVAILABILITY_REASONS = Object.freeze(['e2e', 'env-disabled', 'dev-build']);
export const SERVING_STATES = Object.freeze(['off', 'starting', 'live', 'paused', 'error']);
export const PAUSE_CAUSES = Object.freeze(['user', 'idle', 'anomaly', 'revoked', 'quit']);
export const HOLDS = Object.freeze(['no-window', 'restart']);
export const TUNNEL_STATES = Object.freeze(['off', 'blocked', 'needs-setup', 'needs-trust', 'starting', 'connecting', 'checking-public', 'up', 'degraded', 'backoff', 'paused', 'stopping', 'failed', 'unknown']);
export const LINK_STATES = Object.freeze(['unlinked', 'pairing', 'linked', 'needs-renewal', 'unknown']);
export const CHAT_STATES = Object.freeze(['none', 'awaiting-first-call', 'working', 'idle', 'full', 'ended', 'unknown']);
export const JOB_PHASES = Object.freeze(['unread', 'awaiting', 'host', 'done', 'needs_user', 'held', 'gone', 'unknown']);
export const JOB_REASONS = Object.freeze([
  'user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap',
  'job_broken', 'render_retry', 'canvas_unavailable', 'read_failed', 'write_failed',
  'submit_stuck', 'host_silent', 'lapsed', 'restart', 'app_only_handoffs',
  'commit_failed', 'person_editing', 'hub_not_selected', 'task_disabled',
  // Renderer-local compatibility values used by the existing dock projector.
  'integrity_fault', 'failed', 'render_retry_required', 'user', 'answered_in_dock',
]);
export const PUSH_EXCLUSION_REASONS = Object.freeze([
  'ending', 'settling', 'attachment', 'free_text',
  'task_not_allowed', 'node_not_allowed', 'person_editing',
]);
// Status crosses Electron's renderer boundary.  These are deliberately closed:
// never turn a diagnostic, request field, or error text into visible copy.
export const FAULT_CODES = Object.freeze([
  'socket_unavailable', 'tunnel_failed', 'state_unreadable', 'persist_failed',
  'internal_error',
]);
// Keep these in lock-step with the controller's explicitly redacted status
// vocabulary.  They are not free-form cloudflared output.
export const TUNNEL_EXIT_CODES = Object.freeze([
  'spawn-failed', 'flag-rejected', 'tunnel-auth-rejected', 'credentials-invalid',
  'network-unreachable', 'metrics-port-in-use', 'exited-unrequested', 'exited',
  'exited-early', 'unrequested-exit-loop', 'crash-loop', 'hostname-not-public',
  'config-rejected', 'owned-elsewhere', 'binary-untrusted', 'binary-not-found',
  'binary-changed',
]);
export const PROBE_STATES = Object.freeze([
  'off', 'checking', 'ok', 'failing', 'offline', 'wrong-origin', 'tunnel-not-serving',
  'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'unexpected-redirect',
  'dns-not-found', 'edge-unreachable', 'hostname-not-public', 'unknown',
]);
// The controller reports an aggregate state separately from the fixed,
// redacted reason for a failed public probe.  Keep this list closed: probe
// transports and errors must never become renderer-visible copy.
export const PROBE_REASONS = Object.freeze([
  'wrong-origin', 'unexpected-redirect', 'tunnel-not-serving', 'origin-unreachable',
  'ingress-mismatch', 'edge-blocked', 'edge-unreachable', 'dns-not-found',
  'hostname-not-public', 'offline', 'timeout', 'too_large', 'refused', 'other',
]);
const RENEWAL_CAUSES = Object.freeze(['refresh_expired', 'invalid_grant', 'revoked']);
const ALARM_KINDS = Object.freeze(['unknown_key', 'unknown_handoff', 'refresh_reuse', 'code_reuse', 'rate_limited', 'held_caps']);
const APPLICATION_STAGES = Object.freeze(['evidence-plan', 'resume', 'cover-letter', 'review']);
const MAX_STRING = 200;
const MAX_JOBS = 50;
const MAX_ALARMS = 5;
const MAX_PREVIOUS = 5;
const MAX_TASKS = 20;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = value => isObject(value) ? value : {};
const string = (value, fallback = '') => typeof value === 'string' ? value.slice(0, MAX_STRING) : fallback;
const bool = value => value === true;
const number = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : fallback;
const nullableNumber = value => Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : null;
const progressValue = value => value === true ? true : nullableNumber(value);
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
const nullableOneOf = (value, values) => values.includes(value) ? value : null;
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i;
const SOURCE_PREFIX_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]{2,64}\/\d{1,3})$/i;
const safeUuid = value => typeof value === 'string' && UUID_RE.test(value) ? value : null;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) ? value : null;
const safeSourcePrefix = value => typeof value === 'string' && SOURCE_PREFIX_RE.test(value) ? value : null;

const blankCounts = () => ({
  anonymousRequests: 0, sourceRejected: 0, assertionRejected: 0, permitLeaks: 0,
  getServed: 0, getWaiting: 0, getEmpty: 0, getPaused: 0, getUnauthorized: 0,
  submitAccepted: 0, submitRejected: 0, submitDuplicate: 0, submitJunk: 0,
  submitSuperseded: 0, submitMisrouted: 0, submitHeld: 0, submitTooLarge: 0,
  stallNotices: 0, chatsStarted: 0, chatsContinued: 0, linksPaired: 0,
  refreshFailures: 0, tunnelRestarts: 0, probeFailures: 0, pauses: 0, alarms: 0,
  revokes: 0, acceptedByStage: { 'evidence-plan': 0, resume: 0, 'cover-letter': 0, review: 0 },
  lastErrorCode: null, lastCallAt: null, lastAcceptedAt: null,
});

export const EMPTY_BRIDGE_STATUS = Object.freeze({
  v: BRIDGE_STATUS_VERSION, seq: 0, at: 0,
  availability: Object.freeze({ ok: false, reason: 'dev-build' }),
  enabled: false, autoStart: false, autoRelease: false, serving: 'off', paused: false,
  pauseCause: null, hold: null, fault: null,
  config: Object.freeze({ hostname: null, pluginName: 'infinite_canvas', mcpUrl: null, scope: Object.freeze({ applications: false, scoring: false, marketplace: false }), telemetryInBugReports: false }),
  limits: Object.freeze({ releaseTtlHours: 0, chatKeyMaxAgeHours: 0, idlePauseMinutes: 1440, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 900000 }), prefs: Object.freeze({ sourcePolicy: 'enforce', pairingNetworkCheck: true }),
  setup: Object.freeze({ hostnameOk: false, binaryApproved: false, credentialsOk: false, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false }),
  tunnel: Object.freeze({ state: 'off', binary: null, tunnelId: null, credentialsMode: null, certPemPresent: false, restarts: 0, lastExit: null, nextRetryAt: null, probe: Object.freeze({ state: 'unknown', okAt: null, failingSince: null, consecutiveFailures: 0, reason: null }) }),
  link: Object.freeze({ state: 'unlinked', pairing: Object.freeze({ open: false, expiresAt: null }), progress: Object.freeze({ discoveryFetched: null, authorizeRequested: null, approved: null, tokenIssued: null, toolsListed: null }), linkedAt: null, lastUsedAt: null, expiresAt: null, clientAuth: null, expiresSoon: false, renewalCause: null, unarmedRequests: Object.freeze({ count: 0, lastAt: null }), toolsStale: false, sources: Object.freeze([]) }),
  chat: Object.freeze({ ordinal: null, startedAt: null, firstCallAt: null, lastCallAt: null, lastCallKind: null, calls: 0, state: 'none', jobsAssigned: 0, jobsCap: 0, expiresInMs: 0, outstanding: null, servedTwice: false, previous: Object.freeze([]) }),
  queue: Object.freeze({ applications: Object.freeze({ ready: 0, working: 0, needsYou: 0, held: 0, done: 0 }), scoring: Object.freeze({ pending: 0, withChat: 0, tasks: Object.freeze([]) }), jobs: Object.freeze([]) }),
  push: Object.freeze({ selectedHubs: Object.freeze([]), discovered: Object.freeze([]) }), alarms: Object.freeze([]), counts: Object.freeze(blankCounts()), activityVersion: 0, windows: Object.freeze({ canvasOpen: false }), power: Object.freeze({ keepAwake: false }),
});

function normalizeJob(raw) {
  const value = object(raw);
  return Object.freeze({ jobId: safeUuid(value.jobId), phase: oneOf(value.phase, JOB_PHASES, 'unknown'), stage: nullableOneOf(value.stage, APPLICATION_STAGES), reason: nullableOneOf(value.reason, JOB_REASONS), servedToChat: nullableNumber(value.servedToChat), changedAt: nullableNumber(value.changedAt), servedAt: nullableNumber(value.servedAt), answeredAt: nullableNumber(value.answeredAt), awaitingAnswer: bool(value.awaitingAnswer), stalled: bool(value.stalled), stalledSince: nullableNumber(value.stalledSince) });
}

// Never throw: this handles hostile main-process values as well as partially
// upgraded snapshots.  Every output key is intentional; unknown input keys die
// here rather than becoming renderer state.
export function normalizeBridgeStatus(raw) {
  try {
    if (!isObject(raw) || raw.v !== BRIDGE_STATUS_VERSION) return EMPTY_BRIDGE_STATUS;
    const value = raw;
    const availability = object(value.availability); const config = object(value.config); const scope = object(config.scope);
    const setup = object(value.setup); const tunnel = object(value.tunnel); const probe = object(tunnel.probe);
    const link = object(value.link); const pairing = object(link.pairing); const progress = object(link.progress);
    const chat = object(value.chat); const queue = object(value.queue); const applications = object(queue.applications); const scoring = object(queue.scoring);
    const push = object(value.push); const limits = object(value.limits); const prefs = object(value.prefs); const power = object(value.power); const countInput = object(value.counts);
    const availabilityOk = bool(availability.ok);
    const normalized = {
      v: BRIDGE_STATUS_VERSION, seq: number(value.seq), at: number(value.at),
      availability: { ok: availabilityOk, reason: availabilityOk ? null : nullableOneOf(availability.reason, AVAILABILITY_REASONS) || 'dev-build' },
      enabled: bool(value.enabled), autoStart: bool(value.autoStart), autoRelease: bool(value.autoRelease), serving: oneOf(value.serving, SERVING_STATES, 'off'), paused: bool(value.paused), pauseCause: nullableOneOf(value.pauseCause, PAUSE_CAUSES), hold: nullableOneOf(value.hold, HOLDS), fault: isObject(value.fault) && nullableOneOf(value.fault.code, FAULT_CODES) ? { code: value.fault.code } : null,
      config: { hostname: typeof config.hostname === 'string' ? string(config.hostname) : null, pluginName: string(config.pluginName, '') || 'infinite_canvas', mcpUrl: typeof config.mcpUrl === 'string' ? string(config.mcpUrl) : null, scope: { applications: bool(scope.applications), scoring: bool(scope.scoring), marketplace: bool(scope.marketplace) }, telemetryInBugReports: bool(config.telemetryInBugReports) },
      limits: { releaseTtlHours: number(limits.releaseTtlHours), chatKeyMaxAgeHours: number(limits.chatKeyMaxAgeHours), idlePauseMinutes: number(limits.idlePauseMinutes, 1440), jobsPerChat: number(limits.jobsPerChat, 2), epochSoftBytes: number(limits.epochSoftBytes, 500000), epochHardBytes: number(limits.epochHardBytes, 900000) }, prefs: { sourcePolicy: oneOf(prefs.sourcePolicy, ['enforce', 'alert', 'off'], 'enforce'), pairingNetworkCheck: prefs.pairingNetworkCheck !== false },
      setup: { hostnameOk: bool(setup.hostnameOk), binaryApproved: bool(setup.binaryApproved), credentialsOk: bool(setup.credentialsOk), tunnelReachable: bool(setup.tunnelReachable), linked: bool(setup.linked), toolsListed: bool(setup.toolsListed), firstCallSeen: bool(setup.firstCallSeen) },
      tunnel: { state: oneOf(tunnel.state, TUNNEL_STATES, 'unknown'), binary: isObject(tunnel.binary) ? { path: null, version: typeof tunnel.binary.version === 'string' && SAFE_KEY_RE.test(tunnel.binary.version) ? string(tunnel.binary.version) : null, sha256Prefix: typeof tunnel.binary.sha256Prefix === 'string' && /^[a-f0-9]{8,64}$/i.test(tunnel.binary.sha256Prefix) ? string(tunnel.binary.sha256Prefix) : null, approved: bool(tunnel.binary.approved) } : null, tunnelId: typeof tunnel.tunnelId === 'string' && TUNNEL_ID_RE.test(tunnel.tunnelId) ? tunnel.tunnelId : null, credentialsMode: nullableOneOf(tunnel.credentialsMode, ['ok', 'too-open', 'unknown']), certPemPresent: bool(tunnel.certPemPresent), restarts: number(tunnel.restarts), lastExit: nullableOneOf(tunnel.lastExit, TUNNEL_EXIT_CODES), nextRetryAt: nullableNumber(tunnel.nextRetryAt), probe: { state: oneOf(probe.state, PROBE_STATES, 'unknown'), okAt: nullableNumber(probe.okAt), failingSince: nullableNumber(probe.failingSince), consecutiveFailures: number(probe.consecutiveFailures), reason: nullableOneOf(probe.reason, PROBE_REASONS) } },
      link: { state: oneOf(link.state, LINK_STATES, 'unknown'), pairing: { open: bool(pairing.open), expiresAt: nullableNumber(pairing.expiresAt) }, progress: { discoveryFetched: progressValue(progress.discoveryFetched), authorizeRequested: progressValue(progress.authorizeRequested), approved: progressValue(progress.approved), tokenIssued: progressValue(progress.tokenIssued), toolsListed: progressValue(progress.toolsListed) }, linkedAt: nullableNumber(link.linkedAt), lastUsedAt: nullableNumber(link.lastUsedAt), expiresAt: nullableNumber(link.expiresAt), clientAuth: nullableOneOf(link.clientAuth, ['none', 'assertion']), expiresSoon: bool(link.expiresSoon), renewalCause: nullableOneOf(link.renewalCause, RENEWAL_CAUSES), unarmedRequests: { count: number(object(link.unarmedRequests).count), lastAt: nullableNumber(object(link.unarmedRequests).lastAt) }, toolsStale: bool(link.toolsStale), sources: list(link.sources, MAX_TASKS).map(safeSourcePrefix).filter(Boolean) },
      chat: { ordinal: nullableNumber(chat.ordinal), startedAt: nullableNumber(chat.startedAt), firstCallAt: nullableNumber(chat.firstCallAt), lastCallAt: nullableNumber(chat.lastCallAt), lastCallKind: nullableOneOf(chat.lastCallKind, ['get', 'submit']), calls: number(chat.calls), state: oneOf(chat.state, CHAT_STATES, 'unknown'), jobsAssigned: number(chat.jobsAssigned), jobsCap: number(chat.jobsCap), expiresInMs: number(chat.expiresInMs), outstanding: isObject(chat.outstanding) ? { servedAt: nullableNumber(chat.outstanding.servedAt), kind: nullableOneOf(chat.outstanding.kind, ['application', 'push']), stage: nullableOneOf(chat.outstanding.stage, APPLICATION_STAGES), task: string(chat.outstanding.task) || null, stalled: bool(chat.outstanding.stalled), stalledSince: nullableNumber(chat.outstanding.stalledSince), stallsLastHour: number(chat.outstanding.stallsLastHour) } : null, servedTwice: bool(chat.servedTwice), previous: list(chat.previous, MAX_PREVIOUS).map(item => { const prior = object(item); return { ordinal: nullableNumber(prior.ordinal), endedAt: nullableNumber(prior.endedAt), reason: nullableOneOf(prior.reason, ['replaced', 'revoked', 'disabled', 'full', 'queue_empty', 'restart', 'session_ended']) }; }) },
      queue: { applications: { ready: number(applications.ready), working: number(applications.working), needsYou: number(applications.needsYou), held: number(applications.held), done: number(applications.done) }, scoring: { pending: number(scoring.pending), withChat: number(scoring.withChat), tasks: list(scoring.tasks, MAX_TASKS).map(item => ({ task: string(object(item).task) || null, pending: number(object(item).pending) })).filter(item => item.task) }, jobs: list(queue.jobs, MAX_JOBS).map(normalizeJob).filter(item => item.jobId) },
      push: { selectedHubs: list(push.selectedHubs, MAX_TASKS).map(safeKey).filter(Boolean), discovered: list(push.discovered, MAX_TASKS).map(item => { const source = object(item); const excludedInput = object(source.excluded); const excluded = {}; for (const reason of PUSH_EXCLUSION_REASONS) excluded[reason] = number(excludedInput[reason]); return { key: safeKey(source.key), pending: number(source.pending), tasks: list(source.tasks, MAX_TASKS).map(task => ({ task: string(object(task).task) || null, pending: number(object(task).pending) })).filter(task => task.task), excluded }; }).filter(item => item.key) },
      alarms: list(value.alarms, MAX_ALARMS).map(item => ({ id: safeKey(object(item).id), kind: nullableOneOf(object(item).kind, ALARM_KINDS), at: number(object(item).at), acknowledged: bool(object(item).acknowledged) })).filter(item => item.id && item.kind),
      counts: blankCounts(), activityVersion: number(value.activityVersion), windows: { canvasOpen: bool(object(value.windows).canvasOpen) }, power: { keepAwake: bool(power.keepAwake) },
    };
    for (const key of Object.keys(normalized.counts)) {
      if (key === 'acceptedByStage') continue;
      if (key === 'lastErrorCode') normalized.counts[key] = nullableOneOf(countInput[key], FAULT_CODES);
      else if (key === 'lastCallAt' || key === 'lastAcceptedAt') normalized.counts[key] = nullableNumber(countInput[key]);
      else normalized.counts[key] = number(countInput[key]);
    }
    const accepted = object(countInput.acceptedByStage);
    for (const key of Object.keys(normalized.counts.acceptedByStage)) normalized.counts.acceptedByStage[key] = number(accepted[key]);
    return normalized;
  } catch { return EMPTY_BRIDGE_STATUS; }
}
