function requestUrlValue(input) {
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return input;
}

/**
 * Describe an unexpected request without copying credentials, path IDs, query
 * parameters, or fragments into CI logs.
 */
export function describeUnexpectedNetworkTarget(input) {
  try {
    const url = new URL(String(requestUrlValue(input) || ''));
    if (url.origin === 'null') return `${url.protocol}<non-network target>`;
    return `${url.origin}${url.pathname === '/' ? '/' : '/<path redacted>'}`;
  } catch {
    return '<unparseable request target>';
  }
}

export function blockUnexpectedNetworkRequest(input) {
  throw new Error(`Unexpected network request during test:unit: ${describeUnexpectedNetworkTarget(input)}`);
}
