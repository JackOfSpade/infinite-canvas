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
// Keep the closing gate's reason visible without retaining its validation
// message or the sentence that triggered it. These identify checks, not whether
// the rejected claim was actually false.
const closingChecks = [
  ['work-gerund', /no work gerund/u],
  ['past-work', /no past-work word|no have-or-had participle frame/u],
  ['figure', /no figure, number or year/u],
  ['credential', /no credential word/u],
  ['qualifier', /no qualifier word/u],
  ['candidate-frame', /no candidate-experience term|no as-a-role candidate frame|no continuity or return-to-work frame|no second first-person subject|no first-person possessive|no first-person candidate reference|no candidate claim frame|no candidate-career assertion/u],
  ['vocabulary', /every meaningful term in the closed intent vocabulary/u],
  ['name', /every capitalized or acronym term|every named term/u],
  ['position', /the last paragraph position/u],
  ['earlier-career-proof', /an earlier paragraph that passes/u],
  ['citation', /one to four distinct accepted job-listing evidence IDs|every cited quote inside/u],
  ['employer-clause', /an employer-facing clause|an employer-facing target|no opening verb/u],
  ['source-overlap', /meaningful terms shared with its cited listing quotes/u],
  ['empty-prose', /nonempty final paragraph prose/u],
];

export function recordApplicationCorrectionCheck({ jobId, stage, errors = [] }) {
  if (!stages.has(stage)) return;
  const unique = [...new Set(errors.filter(error => typeof error === 'string'))];
  const counts = {};
  const closingCounts = {};
  for (const error of unique) {
    let matched = false;
    for (const [code, pattern] of causes) {
      if (!pattern.test(error)) continue;
      counts[code] = (counts[code] || 0) + 1;
      matched = true;
    }
    if (!matched) counts.other = (counts.other || 0) + 1;
    if (/listing-grounded closing requires /u.test(error)) {
      let closingMatched = false;
      for (const [code, pattern] of closingChecks) {
        if (!pattern.test(error)) continue;
        closingCounts[code] = (closingCounts[code] || 0) + 1;
        closingMatched = true;
      }
      if (!closingMatched) closingCounts.other = (closingCounts.other || 0) + 1;
    }
  }
  rows.push({ at: new Date().toISOString(), stage,
    job: typeof jobId === 'string' && jobId ? createHash('sha256').update(jobId).digest('hex').slice(0, 10) : 'unknown',
    outcome: unique.length ? 'rejected' : 'passed',
    findings: unique.length, repeated: errors.length - unique.length, counts, closingCounts });
  if (rows.length > 60) rows.shift();
}

export function applicationCorrectionDiagnosticsMarkdown() {
  return '\n## Application Correction Causes (APPCORRECT)\n'
    + '> Process-local, newest first, at most 60 document checks. Fixed cause codes and counts only; job IDs are one-way digests. Causes may overlap. Closing checks identify the rejecting gate, not whether its conclusion was factually correct. Passed means this document check passed, not that the application was saved. Earlier reports cannot reconstruct these causes.\n'
    + (rows.length ? [...rows].reverse().map(row => `- ${row.at} · job #${row.job} · stage \`${row.stage}\` · ${row.outcome} · distinct findings ${row.findings} · duplicate findings suppressed ${row.repeated}`
      + (row.findings ? ` · causes ${Object.entries(row.counts).map(([code, count]) => `${code}=${count}`).join(', ')}` : '')
      + (Object.keys(row.closingCounts).length ? ` · closing checks ${Object.entries(row.closingCounts).map(([code, count]) => `${code}=${count}`).join(', ')}` : '')).join('\n')
      : '- No document correction check retained in this process.') + '\n';
}
