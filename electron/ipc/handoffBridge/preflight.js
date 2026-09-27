import {
  DUPLICATE_RESPONSE_MIN_CHARS,
  extractPasteEnvelopeIdentity,
  normalizePastedResponse,
  responseFingerprint,
} from '../../../src/utils/pasteIdentityGuard.js';
import { createHandoffCodeGuard, isHandoffCodeGuard, trimHandoffCode } from './lanes.js';

export {
  DUPLICATE_RESPONSE_MIN_CHARS,
  extractPasteEnvelopeIdentity,
  normalizePastedResponse,
  responseFingerprint,
};

// Keep these literals in step with localAiApplication.js. They are source-
// drift tested because the frozen app module does not export either value.
export const APPLICATION_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;
export const MAX_RESPONSE_BYTES = 1_000_000;

export { trimHandoffCode };

export function normalizePushCode(value) {
  const trimmed = trimHandoffCode(value);
  return /^HANDOFF-[2-9A-HJ-NP-Z]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

export function unwrapJsonFence(text) {
  const value = typeof text === 'string' ? text : '';
  return APPLICATION_FENCE_RE.exec(value)?.[1] ?? value;
}

export function stringifySubmission(response) {
  if (typeof response === 'string') return { ok: true, text: response };
  if (response && typeof response === 'object') {
    try {
      const text = JSON.stringify(response);
      return typeof text === 'string' ? { ok: true, text } : { ok: false, text: '' };
    }
    catch { return { ok: false, text: '' }; }
  }
  return { ok: false, text: '' };
}

export function responseBytes(response) {
  const normalized = stringifySubmission(response);
  return normalized.ok ? Buffer.byteLength(normalized.text, 'utf8') : 0;
}

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(unwrapJsonFence(text)) }; }
  catch { return { ok: false, value: null }; }
}

function hasAcceptedFingerprint(lane, fingerprint) {
  const values = lane?.acceptedFingerprints;
  return values instanceof Set ? values.has(fingerprint) : Array.isArray(values) && values.includes(fingerprint);
}

/**
 * Pure, post-authentication submission classifier. It never calls a source
 * adapter and returns only the fixed routing vocabulary.
 */
export function classifySubmission({ response, lane, lanes = [], kind = 'application', codeEnforced = true, codeGuard: injectedCodeGuard = null } = {}) {
  const codeGuard = isHandoffCodeGuard(injectedCodeGuard) ? injectedCodeGuard : createHandoffCodeGuard();
  const normalized = stringifySubmission(response);
  if (!normalized.ok) return 'junk';
  const text = normalized.text;

  if (kind === 'push') {
    const stamps = extractPasteEnvelopeIdentity(text).pushStamps;
    const expected = normalizePushCode(lane?.current?.code ?? lane?.code ?? '');
    if (stamps.some(stamp => !codeGuard.equal(normalizePushCode(stamp), expected))) return 'misrouted';
    const short = ['', '{}', '[]', 'null', '""'].includes(text.trim());
    return codeEnforced && short ? 'junk' : 'pass';
  }

  const parsed = parseJson(text);
  const identity = extractPasteEnvelopeIdentity(text);
  if (!parsed.ok) {
    if (identity.jobId && identity.jobId !== lane?.jobId) return 'misrouted';
    return text.trim().length >= 64 && text.includes('{') ? 'pass' : 'junk';
  }

  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'junk';
  if (typeof value.jobId !== 'string'
      || typeof value.stage !== 'string'
      || typeof value.handoffCode !== 'string') return 'junk';
  if (value.jobId !== lane?.jobId || (identity.jobId && identity.jobId !== lane?.jobId)) return 'misrouted';
  if (value.stage !== lane?.current?.stage) return 'superseded';

  const fingerprint = responseFingerprint(text);
  if (fingerprint && lanes.some(other => other !== lane && hasAcceptedFingerprint(other, fingerprint))) return 'misrouted';
  return 'pass';
}
