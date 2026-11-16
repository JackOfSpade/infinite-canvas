import { createHash } from 'node:crypto';

// Project host validation messages to a closed vocabulary immediately. The
// cause rows below never retain prompts, answers, prose, citation IDs, paths or
// the messages themselves.
const rows = [];
// The messages themselves, kept apart from the cause rows and never rendered
// with them. A rejection message quotes the sentence it rejects, so it is
// document prose: only an explicit FULL or APPREJECT report renders this ring
// (bugReport/applicationRejections.js), the same consent APPOUTPUT asks for.
// It exists because the cause codes say THAT a check failed and never why:
// whether a source-grounding rejection is a real defect or a false alarm can
// only be read from its wording.
export const MAX_REJECTION_TEXT_CHECKS = 80;
export const MAX_REJECTION_TEXT_MESSAGES = 8;
export const MAX_REJECTION_TEXT_CHARS = 900;
const rejectionTexts = [];
const stages = new Set(['convert', 'verify-correction', 'fit-correction', 'fact-correction']);
const causes = [
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
  if (unique.length) pushRejectionText({ at: rows.at(-1).at, stage, job: rows.at(-1).job, unique });
}

function pushRejectionText({ at, stage, job, unique }) {
  const messages = unique.slice(0, MAX_REJECTION_TEXT_MESSAGES).map(message => (message.length > MAX_REJECTION_TEXT_CHARS
    ? `${message.slice(0, MAX_REJECTION_TEXT_CHARS - 1)}…` : message));
  // The document gate and the round recorder both see a gate rejection. Keep
  // one row for it: the same job, stage and wording, back to back.
  const last = rejectionTexts.at(-1);
  if (last && last.job === job && last.stage === stage && last.total === unique.length
    && last.messages.length === messages.length && last.messages.every((message, index) => message === messages[index])) return;
  rejectionTexts.push({ at, stage, job, total: unique.length, messages });
  if (rejectionTexts.length > MAX_REJECTION_TEXT_CHECKS) rejectionTexts.shift();
}

/**
 * The wording of ANY rejected round, not only one the document gate judged. A
 * reply rejected before that gate (a unit patch that named a settled unit, a
 * reply that was not the asked-for shape, a rejected ranking or fact check)
 * appeared in the durable trace as a bare check id with no wording anywhere,
 * so it could not be told apart from a host fault.
 */
export function recordApplicationRejectionText({ jobId, stage, errors = [] }) {
  const unique = [...new Set((Array.isArray(errors) ? errors : []).filter(error => typeof error === 'string' && error))];
  if (!unique.length || typeof stage !== 'string' || !stage) return;
  pushRejectionText({ at: new Date().toISOString(), stage: stage.slice(0, 40),
    job: typeof jobId === 'string' && jobId ? createHash('sha256').update(jobId).digest('hex').slice(0, 10) : 'unknown', unique });
}

/** Newest first. Copies, so a renderer cannot change what the ring holds. */
export function applicationRejectionTextRows() {
  return [...rejectionTexts].reverse().map(row => ({ ...row, messages: [...row.messages] }));
}

export function applicationCorrectionDiagnosticsMarkdown() {
  return '\n## Application Correction Causes (APPCORRECT)\n'
    + '> Process-local, newest first, at most 60 document checks. Fixed cause codes and counts only; job IDs are one-way digests. Causes may overlap. Passed means this document check passed, not that the application was saved. Earlier reports cannot reconstruct these causes.\n'
    + (rows.length ? [...rows].reverse().map(row => `- ${row.at} · job #${row.job} · stage \`${row.stage}\` · ${row.outcome} · distinct findings ${row.findings} · duplicate findings suppressed ${row.repeated}`
      + (row.findings ? ` · causes ${Object.entries(row.counts).map(([code, count]) => `${code}=${count}`).join(', ')}` : '')).join('\n')
      : '- No document correction check retained in this process.') + '\n';
}
