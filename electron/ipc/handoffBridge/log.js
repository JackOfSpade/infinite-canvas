export const CREDENTIAL_LOG_CODES = Object.freeze([
  'listener_started', 'listener_stopped', 'listener_error', 'link_created', 'link_replaced',
  'link_revoked', 'refresh_reuse', 'code_reuse', 'pause', 'resume', 'pairing_opened',
  'pairing_closed', 'consent_requested', 'refresh_rotated', 'persist_failed', 'state_version',
  'tool_call', 'tool_deadline', 'port_error', 'probe', 'permit_leak', 'restart_confirmed', 'epoch_closed',
  'release', 'unrelease', 'new_chat', 'continue', 'source_mismatch',
]);

const FIELD_VALUE = /^[a-z0-9_.:-]{1,40}$/;

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
  return Object.freeze({ code, fields: Object.freeze({ ...fields }) });
}

export function emitCredentialLog(logger, code, fields = {}) {
  const record = makeLogRecord(code, fields);
  if (typeof logger?.record === 'function') logger.record(record.code, record.fields);
  return record;
}
