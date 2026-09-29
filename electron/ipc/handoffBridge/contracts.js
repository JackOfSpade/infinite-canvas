function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const IPC_CHANNELS = Object.freeze({
  GET_STATUS: 'handoff-bridge:get-status',
  SET_ENABLED: 'handoff-bridge:set-enabled',
  SAVE_CONFIG: 'handoff-bridge:save-config',
  CHOOSE_BINARY: 'handoff-bridge:choose-binary',
  APPROVE_BINARY: 'handoff-bridge:approve-binary',
  CHOOSE_CREDENTIALS: 'handoff-bridge:choose-credentials',
  RESTART_TUNNEL: 'handoff-bridge:restart-tunnel',
  STOP_ORPHAN: 'handoff-bridge:stop-orphan',
  GET_TUNNEL_LOG: 'handoff-bridge:get-tunnel-log',
  OPEN_PAIRING: 'handoff-bridge:open-pairing',
  CANCEL_PAIRING: 'handoff-bridge:cancel-pairing',
  NEW_CHAT: 'handoff-bridge:new-chat',
  CONTINUE_CHAT: 'handoff-bridge:continue-chat',
  PAUSE: 'handoff-bridge:pause',
  RESUME: 'handoff-bridge:resume',
  REVOKE_ALL: 'handoff-bridge:revoke-all',
  FORGET_SETUP: 'handoff-bridge:forget-setup',
  RELEASE: 'handoff-bridge:release',
  UNRELEASE: 'handoff-bridge:unrelease',
  RELEASE_PUSH: 'handoff-bridge:release-push',
  UNRELEASE_PUSH: 'handoff-bridge:unrelease-push',
  HOLD_JOB: 'handoff-bridge:hold-job',
  ACK_ALARM: 'handoff-bridge:ack-alarm',
  GET_ACTIVITY: 'handoff-bridge:get-activity',
  PUBLISH_JOBS: 'handoff-bridge:publish-jobs',
});

export const IPC_EVENTS = Object.freeze({
  STATUS: 'handoff-bridge:status',
  JOB_CHANGED: 'handoff-bridge:job-changed',
  OPEN_PANEL: 'handoff-bridge:open-panel',
});

export const ENGINE_PORT_SHAPE = Object.freeze(['get', 'submit', 'snapshot', 'close']);
export const SOURCE_ADAPTER_SHAPE = Object.freeze(['read', 'status', 'submit']);
export const TUNNEL_PORT_SHAPE = Object.freeze(['start', 'stop', 'status', 'reapOrphans']);

export const STATUS_SNAPSHOT_EXAMPLE = deepFreeze({
  v: 1, seq: 0, at: 0,
  availability: { ok: false, reason: null },
  enabled: false, autoStart: false, autoRelease: false, serving: 'off', paused: false,
  pauseCause: null, hold: null, fault: null,
  config: { hostname: null, pluginName: 'infinite_canvas', mcpUrl: null, scope: { applications: true, scoring: false, marketplace: false }, telemetryInBugReports: false },
  limits: { releaseTtlHours: 0, chatKeyMaxAgeHours: 0, idlePauseMinutes: 1440, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 900000 },
  prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true },
  setup: { hostnameOk: false, binaryApproved: false, credentialsOk: false, tunnelReachable: false, linked: false, toolsListed: false, firstCallSeen: false },
  tunnel: { state: 'off', binary: null, tunnelId: null, credentialsMode: null, certPemPresent: false, restarts: 0, lastExit: null, nextRetryAt: null, probe: { state: 'off', okAt: null, failingSince: null, consecutiveFailures: 0, reason: null } },
  link: { state: 'unlinked', pairing: { open: false, expiresAt: null }, progress: { discoveryFetched: false, authorizeRequested: false, approved: false, tokenIssued: false, toolsListed: false }, linkedAt: null, lastUsedAt: null, expiresAt: null, clientAuth: null, expiresSoon: false, renewalCause: null, unarmedRequests: { count: 0, lastAt: null }, toolsStale: false, sources: [] },
  chat: { ordinal: 0, startedAt: null, firstCallAt: null, lastCallAt: null, lastCallKind: null, calls: 0, state: 'none', jobsAssigned: 0, jobsCap: 2, expiresInMs: null, outstanding: null, servedTwice: false, previous: [] },
  queue: { applications: { ready: 0, working: 0, needsYou: 0, held: 0, done: 0 }, scoring: { pending: 0, withChat: 0, tasks: [] }, jobs: [] },
  push: { selectedHubs: [], discovered: [] }, alarms: [],
  counts: {
    anonymousRequests: 0, sourceRejected: 0, assertionRejected: 0, permitLeaks: 0,
    getServed: 0, getWaiting: 0, getEmpty: 0, getPaused: 0, getUnauthorized: 0,
    submitAccepted: 0, submitRejected: 0, submitDuplicate: 0, submitJunk: 0,
    submitSuperseded: 0, submitMisrouted: 0, submitHeld: 0, submitTooLarge: 0,
    stallNotices: 0, chatsStarted: 0, chatsContinued: 0, linksPaired: 0,
    refreshFailures: 0, tunnelRestarts: 0, probeFailures: 0, pauses: 0, alarms: 0,
    revokes: 0, acceptedByStage: { 'evidence-plan': 0, resume: 0, 'cover-letter': 0, review: 0 },
    lastErrorCode: null, lastCallAt: null, lastAcceptedAt: null,
  },
  activityVersion: 0,
  windows: { canvasOpen: false }, power: { keepAwake: false },
});

export const AUDIT_LINE_EXAMPLE = deepFreeze({
  t: 0, ev: 'served', tool: 'get_handoff', outcome: 'ok', stage: 'awaiting',
  argBytes: 0, resultBytes: 0, ms: 0, grantFp: '00000000', epochFp: '0000', source: 'unknown', tokenLeftSec: 0,
});

export const PUBLISH_JOBS_EXAMPLE = deepFreeze({
  v: 1, seq: 1, jobs: [{ jobId: '00000000-0000-4000-8000-000000000000', canvasFilePath: '/tmp/example.canvas', dockState: 'awaiting', sig: 'example' }],
});
