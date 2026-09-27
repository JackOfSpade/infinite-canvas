export const CREDENTIAL_LOG_CODES = Object.freeze([
  'listener_started', 'listener_stopped', 'listener_error', 'link_created', 'link_replaced',
  'link_revoked', 'refresh_reuse', 'code_reuse', 'pause', 'resume', 'pairing_opened',
  'pairing_closed', 'consent_requested', 'refresh_rotated', 'persist_failed', 'state_version',
  'tool_call', 'tool_deadline', 'port_error', 'probe', 'permit_leak', 'restart_confirmed', 'epoch_closed',
  'release', 'unrelease', 'new_chat', 'continue', 'source_mismatch',
]);

const FIELD_VALUE = /^[a-z0-9_.:-]{1,40}$/;
const ACTIVITY_LIMIT = 200;

// Activity is a renderer-facing, deliberately smaller projection of the
// credential/control log. Keep it closed independently from the log-code
// vocabulary: a new diagnostic code must never become renderer copy merely
// because somebody added it to CREDENTIAL_LOG_CODES.
export const ACTIVITY_KINDS = Object.freeze([
  'link-paired', 'link-revoked', 'link-refresh-failed', 'chat-started',
  'chat-continued', 'get-served', 'get-waiting', 'get-empty',
  'submit-accepted', 'submit-rejected', 'submit-duplicate', 'submit-junk',
  'submit-superseded', 'submit-held', 'stall', 'paused', 'resumed',
  'tunnel-up', 'tunnel-down', 'tunnel-restart', 'alarm', 'enabled', 'disabled',
]);

// Outcome is intentionally optional. It can help a future local UI sort or
// aggregate an already-safe Activity item, but it is never free text and it
// never carries an engine error, an OAuth field, or request-derived content.
export const ACTIVITY_OUTCOMES = Object.freeze([
  'served', 'waiting', 'empty', 'accepted', 'rejected', 'duplicate', 'junk',
  'superseded', 'held', 'paused', 'retry', 'full', 'needs-user', 'other',
  'linked', 'revoked', 'failed', 'up', 'down', 'restart',
]);

const ACTIVITY_KIND_SET = new Set(ACTIVITY_KINDS);
const ACTIVITY_OUTCOME_SET = new Set(ACTIVITY_OUTCOMES);

// The field vocabulary is deliberately closed per event.  A globally safe-
// looking key is still unsafe here: it can become an accidental identifier in
// the application log and therefore in bug reports.
export const LOG_FIELDS_BY_CODE = Object.freeze({
  listener_started: Object.freeze(['state']),
  listener_stopped: Object.freeze(['cause']),
  listener_error: Object.freeze(['code']),
  link_created: Object.freeze(['clientKind', 'clientAuth']),
  link_replaced: Object.freeze(['clientKind', 'clientAuth']),
  link_revoked: Object.freeze(['cause', 'clientKind']),
  refresh_reuse: Object.freeze(['cause', 'clientKind']),
  code_reuse: Object.freeze(['cause', 'clientKind']),
  pause: Object.freeze(['cause']),
  resume: Object.freeze(['cause']),
  pairing_opened: Object.freeze(['cause']),
  pairing_closed: Object.freeze(['cause']),
  consent_requested: Object.freeze(['clientKind']),
  refresh_rotated: Object.freeze(['clientAuth', 'clientKind']),
  persist_failed: Object.freeze(['code', 'store']),
  state_version: Object.freeze(['store', 'version']),
  tool_call: Object.freeze(['tool', 'outcome', 'ms']),
  tool_deadline: Object.freeze(['tool', 'ms']),
  port_error: Object.freeze(['port', 'code']),
  probe: Object.freeze(['code']),
  permit_leak: Object.freeze(['pool', 'ms']),
  restart_confirmed: Object.freeze(['count']),
  epoch_closed: Object.freeze(['cause', 'count']),
  release: Object.freeze(['kind', 'count']),
  unrelease: Object.freeze(['kind', 'count']),
  new_chat: Object.freeze(['chatOrdinal']),
  continue: Object.freeze(['chatOrdinal']),
  source_mismatch: Object.freeze(['clientKind', 'source']),
});

export function isSafeLogField(value) {
  return typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && FIELD_VALUE.test(value);
}

export function makeLogRecord(code, fields = {}) {
  if (!CREDENTIAL_LOG_CODES.includes(code)) throw new TypeError('Unknown handoff bridge log code');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('Log fields must be an object');
  const allowed = new Set(LOG_FIELDS_BY_CODE[code]);
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key) || !isSafeLogField(value)) throw new TypeError('Unsafe handoff bridge log field');
  }
  // Use the frozen per-code field ordering for deterministic app-log lines.
  // It also avoids preserving a surprising own-key order from an injected
  // object; validation above remains the authority for whether a key exists.
  const safe = {};
  for (const key of LOG_FIELDS_BY_CODE[code]) if (Object.hasOwn(fields, key)) safe[key] = fields[key];
  return Object.freeze({ code, fields: Object.freeze(safe) });
}

export function emitCredentialLog(logger, code, fields = {}) {
  const record = makeLogRecord(code, fields);
  if (typeof logger?.record === 'function') logger.record(record.code, record.fields);
  return record;
}

function safeActivityTime(now) {
  try {
    const value = Number(now());
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
  } catch { return Date.now(); }
}

/**
 * Strip an Activity item down to its frozen display contract. This is shared
 * by the controller and the IPC boundary so a hyphenated, valid kind is not
 * accidentally converted into an "unknown" renderer event.
 */
export function sanitizeActivityItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ACTIVITY_KIND_SET.has(value.kind)) return null;
  const at = Number(value.at);
  const item = {
    kind: value.kind,
    at: Number.isFinite(at) && at >= 0 ? Math.floor(at) : 0,
  };
  if (ACTIVITY_OUTCOME_SET.has(value.outcome)) item.outcome = value.outcome;
  return Object.freeze(item);
}

function activityForRecord(record) {
  const fields = record.fields;
  switch (record.code) {
    case 'link_created': case 'link_replaced': return { kind: 'link-paired', outcome: 'linked' };
    case 'link_revoked': return { kind: 'link-revoked', outcome: 'revoked' };
    case 'refresh_reuse': case 'code_reuse': return { kind: 'link-refresh-failed', outcome: 'failed' };
    case 'new_chat': return { kind: 'chat-started' };
    case 'continue': return { kind: 'chat-continued' };
    case 'pause': return { kind: 'paused', outcome: 'paused' };
    case 'resume': return { kind: 'resumed' };
    case 'listener_started': return { kind: 'tunnel-up', outcome: 'up' };
    case 'listener_stopped': case 'listener_error': return { kind: 'tunnel-down', outcome: 'down' };
    case 'probe': return { kind: fields.code === 'ok' ? 'tunnel-up' : 'tunnel-down', outcome: fields.code === 'ok' ? 'up' : 'down' };
    case 'tool_call': {
      const outcome = fields.outcome;
      if (fields.tool === 'get') {
        if (outcome === 'served') return { kind: 'get-served', outcome };
        if (outcome === 'waiting') return { kind: 'get-waiting', outcome };
        if (outcome === 'queue-empty' || outcome === 'empty') return { kind: 'get-empty', outcome: 'empty' };
      }
      if (fields.tool === 'submit') {
        if (outcome === 'accepted') return { kind: 'submit-accepted', outcome };
        if (outcome === 'rejected') return { kind: 'submit-rejected', outcome };
        if (outcome === 'duplicate') return { kind: 'submit-duplicate', outcome };
        if (outcome === 'junk' || outcome === 'too-large') return { kind: 'submit-junk', outcome: 'junk' };
        if (outcome === 'superseded' || outcome === 'misrouted') return { kind: 'submit-superseded', outcome: 'superseded' };
        if (outcome === 'held' || outcome === 'needs-user') return { kind: 'submit-held', outcome: 'held' };
      }
      return null;
    }
    default: return null;
  }
}

function formatLogRecord(record) {
  const parts = [`[HandoffBridge] ${record.code}`];
  for (const [key, value] of Object.entries(record.fields)) parts.push(`${key}=${String(value)}`);
  return parts.join(' ');
}

/**
 * Concrete production log owner. `logger` is injected from electron/main.js;
 * keeping this module Electron-free preserves B0 import inertness and lets
 * focused Node tests supply a recorder. Invalid input is rejected before
 * either the app-wide bug-report ring or this bridge Activity ring changes.
 */
export function createHandoffBridgeLog({ logger = null, now = Date.now, limit = ACTIVITY_LIMIT } = {}) {
  const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(ACTIVITY_LIMIT, limit)) : ACTIVITY_LIMIT;
  const items = [];
  let version = 0;

  function record(code, fields = {}) {
    const entry = makeLogRecord(code, fields);
    // The existing app logger owns its own bounded bug-report ring. A logger
    // failure must not change serving, but it must not bypass validation.
    try { logger?.info?.(formatLogRecord(entry)); } catch { /* logging is best effort */ }
    const activity = activityForRecord(entry);
    if (activity) {
      const safe = sanitizeActivityItem({ ...activity, at: safeActivityTime(now) });
      if (safe) {
        items.push(safe);
        if (items.length > max) items.splice(0, items.length - max);
        version += 1;
      }
    }
    return entry;
  }

  return Object.freeze({
    record,
    getRecent: () => items.map(item => ({ ...item })),
    getVersion: () => version,
  });
}
