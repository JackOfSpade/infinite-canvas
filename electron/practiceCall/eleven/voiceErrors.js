/**
 * Error codes, failure classification and key redaction shared by the ElevenLabs voice files.
 * Nothing here touches the network.
 */
export const VOICE_ERROR_CODES = Object.freeze(['voice-auth', 'voice-quota', 'voice-network', 'voice-protocol']);

export function voiceError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = VOICE_ERROR_CODES.includes(code) ? code : 'voice-protocol';
  Object.assign(error, extra);
  return error;
}

const AUTH_WORDS = /(invalid|missing|expired|incorrect).?(api.?key|token)|unauthor|authentication|not.?(authorised|authorized)|permission/i;
const QUOTA_WORDS = /quota|credit|rate.?limit|usage.?limit|too.?many.?requests/i;

export const isAuthText = text => AUTH_WORDS.test(String(text ?? ''));
export const isQuotaText = text => QUOTA_WORDS.test(String(text ?? ''));

/** Maps an HTTP failure, close reason or server error frame onto the small code set. */
export function classifyFailure({ status, reason, message, code } = {}) {
  if (status === 401 || status === 403) return isQuotaText(message) ? 'voice-quota' : 'voice-auth';
  if (status === 429) return 'voice-quota';
  const text = `${reason ?? ''} ${message ?? ''}`;
  if (isQuotaText(text)) return 'voice-quota';
  if (isAuthText(text)) return 'voice-auth';
  if (!status && (code === 1006 || code === 1005)) return 'voice-network';
  return 'voice-protocol';
}

/** Never let the API key reach an error message. */
export function redact(value, key) {
  const text = String(value ?? '');
  if (!key) return text;
  return text.split(String(key)).join('[redacted]');
}
