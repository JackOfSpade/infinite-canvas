const FIXED_MESSAGES = Object.freeze({
  env_disabled: 'The handoff bridge is disabled by environment policy.',
  e2e: 'The handoff bridge is unavailable during the Electron smoke test.',
  unpackaged: 'The handoff bridge is unavailable in this unpackaged build.',
  not_enabled: 'The handoff bridge is turned off.',
  no_hostname: 'A bridge hostname is required.',
  no_binary: 'Choose cloudflared before starting the bridge.',
  binary_untrusted: 'Approve the selected cloudflared binary before starting the bridge.',
  no_credentials: 'Choose tunnel credentials before starting the bridge.',
  config_invalid: 'Bridge configuration is invalid.',
  socket_unavailable: 'The bridge socket is unavailable.',
  tunnel_failed: 'The tunnel could not be started.',
  state_unreadable: 'Bridge state cannot be read safely.',
  unavailable: 'The handoff bridge is unavailable.',
  internal_error: 'The handoff bridge could not complete that request.',
});

export const ERROR_MESSAGES = FIXED_MESSAGES;

export function fixedError(code) {
  return Object.freeze({ code, message: FIXED_MESSAGES[code] || FIXED_MESSAGES.internal_error });
}

// Error text and stacks can carry untrusted request data.  Classification is
// intentionally based only on the small, caller-owned code field.
export function classifyThrow(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(FIXED_MESSAGES, error.code)
    ? error.code
    : 'internal_error';
  return fixedError(code);
}
