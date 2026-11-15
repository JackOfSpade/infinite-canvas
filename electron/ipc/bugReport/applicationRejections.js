import {
  redactReportLocalPathsInText,
  redactReportLogSecrets,
  redactReportOpaqueIds,
  redactReportUrlsInText,
} from './helpers.js';

export const APPLICATION_REJECTION_FILTER_CODE = 'APPREJECT';

// A rejection message quotes generated application prose. Like APPOUTPUT, only
// an explicit FULL or its own narrow code consents to exporting it; the empty
// default report and every other code stay metadata-only.
export function codeIncludesApplicationRejections(filterCode) {
  const codes = String(filterCode || '').trim().toUpperCase().split(/[+\s,]+/).filter(Boolean);
  return codes.includes(APPLICATION_REJECTION_FILTER_CODE) || codes.includes('FULL');
}

function sanitizeRejectionText(value) {
  if (typeof value !== 'string') return '';
  return redactReportOpaqueIds(redactReportLogSecrets(redactReportLocalPathsInText(redactReportUrlsInText(value))))
    .replace(/\r\n?/g, '\n')
    .split('').filter(char => char === '\n' || char === '\t' || (char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127)).join('')
    .trim();
}

// Indented code cannot be closed by its content, so model-authored markup in a
// quoted sentence stays literal.
const indentedCode = text => text.split('\n').map(line => `      ${line}`).join('\n');

export function buildApplicationRejectionTextMarkdown(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const header = '\n## Application Rejection Text (APPREJECT)\n'
    + '> Process-local, newest first: the wording of each host check that rejected a résumé or cover-letter draft, so a rejection can be judged as a real defect or a false alarm. Each message may quote the sentence it rejected. Redacted again at this boundary; job IDs are one-way digests. Selected only by `FULL` or `APPREJECT`. Earlier processes cannot be reconstructed here; each saved bundle keeps the same wording in its own `Generation Log.jsonl`.\n';
  if (!list.length) return `${header}- No rejected document check retained in this process.\n`;
  const lines = [];
  for (const row of list) {
    const shown = Array.isArray(row?.messages) ? row.messages : [];
    const total = Number.isSafeInteger(row?.total) ? row.total : shown.length;
    lines.push(`- ${String(row?.at || '')} · job #${String(row?.job || 'unknown')} · stage \`${String(row?.stage || '').replace(/[^a-z-]/giu, '')}\` · ${total} distinct finding(s)${total > shown.length ? ` (${shown.length} shown)` : ''}`);
    shown.forEach((message, index) => {
      const text = sanitizeRejectionText(message);
      if (!text) return;
      lines.push(`  - Finding ${index + 1}:`);
      lines.push(indentedCode(text));
    });
  }
  return `${header}${lines.join('\n')}\n`;
}
