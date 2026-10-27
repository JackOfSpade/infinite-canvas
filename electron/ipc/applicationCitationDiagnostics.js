// Bounded, process-local metadata only. No document text, source quotes,
// evidence IDs, job IDs, paths or validation messages enter this ring.
const receipts = [];
export function recordApplicationCitationFlow({ phase, paragraphs, citations, v2 }) {
  const count = Math.min(1000, Array.isArray(paragraphs) ? paragraphs.length : 0);
  receipts.push({ at: new Date().toISOString(), phase: phase === 'draft' ? 'draft' : 'completion',
    protocol: v2 === true ? 'v2' : 'legacy', paragraphs: count,
    bindings: Array.isArray(citations) ? 'available' : 'unavailable',
    cited: Array.isArray(citations) ? citations.slice(0, count).filter(row => Array.isArray(row) && row.length).length : 0,
  });
  if (receipts.length > 40) receipts.shift();
}

export function applicationCitationDiagnosticsMarkdown() {
  return '\n## Application Citation Flow (APPCITE)\n'
    + '> Process-local, newest first, at most 40 checks. Counts only; no prose, quotes, citation IDs or paths. Compare draft and completion to detect lost citation bindings.\n'
    + (receipts.length ? [...receipts].reverse().map(row => `- ${row.at} · ${row.protocol} · ${row.phase} · paragraphs ${row.paragraphs} · bindings ${row.bindings} · career-cited paragraphs ${row.cited}`).join('\n')
      : '- No citation check retained in this process.') + '\n';
}
