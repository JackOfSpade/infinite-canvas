// Shared HTTP responders.  These intentionally do not add CORS headers: the
// bridge is a server-to-server surface, not a browser API.

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

// Do not set Cross-Origin-Opener-Policy here. The OAuth consent page must
// retain window.opener semantics when ChatGPT opens it in a popup.
export function sendHtml(res, status, html, csp, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(html);
}

export function sendRedirect(res, target, pairs) {
  const query = pairs
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
  const location = target + (target.includes('?') ? '&' : '?') + query;
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': '0',
  });
  res.end();
}

export function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' }, { Allow: allow });
}

export function notFound(res) {
  sendJson(res, 404, { error: 'not_found', error_description: 'No such resource' });
}
