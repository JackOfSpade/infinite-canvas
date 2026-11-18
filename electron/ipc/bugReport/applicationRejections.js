import { indentedReportCode, reportFilterCodes, sanitizeReportProse } from './helpers.js';

const APPLICATION_REJECTION_FILTER_CODE = 'APPREJECT';

// A rejection message quotes generated application prose. Like APPOUTPUT, only
// an explicit FULL or its own narrow code consents to exporting it; the empty
// default report and every other code stay metadata-only.
export function codeIncludesApplicationRejections(filterCode) {
  const codes = reportFilterCodes(filterCode);
  return codes.includes(APPLICATION_REJECTION_FILTER_CODE) || codes.includes('FULL');
}

const sanitizeRejectionText = value => sanitizeReportProse(value);

const indentedCode = text => indentedReportCode(text, 6);

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
