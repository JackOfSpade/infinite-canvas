import { createHash } from 'node:crypto';

// Project host validation messages to a closed vocabulary immediately. Never
// retain prompts, answers, prose, citation IDs, paths or the messages themselves.
const rows = [];
const stages = new Set(['convert', 'verify-correction', 'fit-correction', 'fact-correction']);
const causes = [
  ['listing-closing', /listing-grounded closing|structural final-paragraph listing-grounding rule/iu],
  ['missing-career-citation', /needs at least one career-data evidence ID/iu],
  ['unknown-evidence', /references unknown evidence/iu],
  ['source-grounding', /^unit-source-grounding:/u],
  ['figure-discipline', /^figure-discipline:/u],
  ['page-overflow', /^measured-one-page-fit:/u],
];

export function recordApplicationCorrectionCheck({ jobId, stage, errors = [] }) {
  if (!stages.has(stage)) return;
  const unique = [...new Set(errors.filter(error => typeof error === 'string'))];
  const counts = {};
  for (const error of unique) {
    let matched = false;
    for (const [code, pattern] of causes) {
      if (!pattern.test(error)) continue;
      counts[code] = (counts[code] || 0) + 1;
      matched = true;
    }
    if (!matched) counts.other = (counts.other || 0) + 1;
  }
  rows.push({ at: new Date().toISOString(), stage,
    job: typeof jobId === 'string' && jobId ? createHash('sha256').update(jobId).digest('hex').slice(0, 10) : 'unknown',
    outcome: unique.length ? 'rejected' : 'passed',
    findings: unique.length, repeated: errors.length - unique.length, counts });
  if (rows.length > 60) rows.shift();
}

export function applicationCorrectionDiagnosticsMarkdown() {
  return '\n## Application Correction Causes (APPCORRECT)\n'
    + '> Process-local, newest first, at most 60 document checks. Fixed cause codes and counts only; job IDs are one-way digests. Causes may overlap. Passed means this document check passed, not that the application was saved. Earlier reports cannot reconstruct these causes.\n'
    + (rows.length ? [...rows].reverse().map(row => `- ${row.at} · job #${row.job} · stage \`${row.stage}\` · ${row.outcome} · distinct findings ${row.findings} · duplicate findings suppressed ${row.repeated}`
      + (row.findings ? ` · causes ${Object.entries(row.counts).map(([code, count]) => `${code}=${count}`).join(', ')}` : '')).join('\n')
      : '- No document correction check retained in this process.') + '\n';
}
