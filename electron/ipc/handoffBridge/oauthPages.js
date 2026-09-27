// Deliberately small, dependency-free consent pages.  Reflected values are
// escaped before entering either text or attributes.
const HTML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
const esc = value => String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

export const ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

export function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;background:#f6f6f4;color:#1b1b1b}main{max-width:30rem;margin:0 auto;background:#fff;border:1px solid #d9d9d4;border-radius:10px;padding:1.5rem}h1{font-size:1.25rem;margin:0 0 1rem}.who{font-weight:600;word-break:break-word}.uri{word-break:break-all}.err{color:#9b1c1c;font-weight:600}input[type=text]{font:inherit;font-family:ui-monospace,monospace;letter-spacing:.15em;width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 1rem}button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem;border-radius:6px;border:1px solid #888;cursor:pointer}button.go{background:#1b1b1b;color:#fff;border-color:#1b1b1b}</style>
</head><body><main>${inner}</main></body></html>`;
}

export const errorHtml = message => pageShell('Cannot continue', `<h1>Cannot continue</h1>\n<p>${esc(message)}</p>`);

export function consentSentence(txn) {
  const what = 'to read and answer job-application handoffs on this Mac';
  if (txn.clientKind === 'cimd') return `${txn.clientHost} is asking ${what}`;
  return 'ChatGPT is asking ' + what;
}

export function consentHtml(txn, message = '') {
  const problem = message ? `<p class="err" role="alert">${esc(message)}</p>\n` : '';
  return pageShell('Approve access', `<h1>Approve access</h1>
<p class="who">${esc(txn.clientName)}</p><p>${esc(consentSentence(txn))}</p>
<p>Returns to <span class="uri">${esc(txn.redirectUri)}</span></p>${problem}<form method="post" action="/oauth/authorize" autocomplete="off">
<input type="hidden" name="txn" value="${esc(txn.id)}"><label for="pairing_code">Pairing code shown on this Mac</label>
<input type="text" id="pairing_code" name="pairing_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16">
<button type="submit" name="action" value="approve" class="go">Approve</button><button type="submit" name="action" value="deny" formnovalidate>Deny</button></form>`);
}

export const consentCsp = txn => `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(txn.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`;
