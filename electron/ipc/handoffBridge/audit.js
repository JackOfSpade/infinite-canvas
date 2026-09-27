export const SECURITY_LEDGER_NAME = 'security.jsonl';
export const SERVE_LEDGER_NAME = 'serve.jsonl';

export const SECURITY_AUDIT_EVENTS = Object.freeze([
  'link_created', 'link_replaced', 'link_revoked', 'refresh_reuse', 'code_reuse',
  'pause', 'resume', 'pairing_opened', 'pairing_closed', 'release', 'unrelease',
  'new_chat', 'continue', 'epoch_closed', 'restart_confirmed', 'hostname_change',
  'source_mismatch', 'permit_leak', 'anonymous_summary', 'origin_seen',
]);

export const SERVE_AUDIT_EVENTS = Object.freeze([
  'served', 'accepted', 'rejected', 'transition',
]);

const AUDIT_EVENTS = new Set([...SECURITY_AUDIT_EVENTS, ...SERVE_AUDIT_EVENTS]);
const AUDIT_FIELDS = new Set([
  'tool', 'outcome', 'stage', 'argBytes', 'resultBytes', 'ms', 'grantFp',
  'epochFp', 'source', 'tokenLeftSec', 'reason', 'cause', 'code', 'kind',
  'route', 'statusClass', 'count', 'from', 'to', 'clientAuth',
]);
const SAFE_VALUE = /^[a-z0-9_.:/-]{1,64}$/;

function copyAuditFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('Audit fields must be an object');
  }
  const safe = {};
  for (const key of Object.keys(fields)) {
    if (!AUDIT_FIELDS.has(key)) throw new TypeError('Unknown audit field');
    const value = fields[key];
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      throw new TypeError('Unsafe audit field');
    }
    safe[key] = value;
  }
  return Object.freeze(safe);
}

export function makeAuditLine({ at = 0, event, fields = {} } = {}) {
  if (!Number.isFinite(at) || !AUDIT_EVENTS.has(event)) throw new TypeError('Invalid audit event');
  return Object.freeze({ t: at, ev: event, fields: copyAuditFields(fields) });
}

// Persistence is intentionally added with the ledger writer, not at module
// import time.  B0 only provides the inert schema boundary.
export function createAuditSink() {
  return Object.freeze({ append: () => undefined });
}
