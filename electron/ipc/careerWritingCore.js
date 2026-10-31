/**
 * Career-grounded writing core shared by application bundle generation and the
 * Interview Helper Q&A. Quality for "is this first-person career claim
 * supported by its cited quotes" is tested once, here.
 *
 * - Stage model profiles (Claude CLI aliases resolve to the newest release).
 * - The fact-check inflation rules and the verbatim-span finding contract.
 * - The "every flagged span must change" correction contract.
 * - The fact-correction round transition.
 *
 * Callers supply document-specific unit text through a `unitText(id)` lookup,
 * so résumé/letter units and interview card claims share one validator.
 * Application prompts and error strings are pinned byte-for-byte by
 * scripts/tests/career-writing-core.js against a pre-extraction golden capture.
 */

export const CLAUDE_SONNET_MODEL = 'sonnet';
export const CLAUDE_OPUS_MODEL = 'opus';
export const CAREER_WRITING_DEFAULT_PROFILE = Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' });

// Opus where a stage decides the writing (write) or picks it (pick); Sonnet
// for rule-following repair, trim, fact and conversion stages.
export const APPLICATION_STAGE_PROFILES = Object.freeze({
  'editorial-plan': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  write: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  pick: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  convert: Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  'verify-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fit-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-check': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-recheck': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
});
// Interview Q&A uses the same split: Opus researches and writes, and the
// fact stages are the application's own profile objects, not copies.
export const INTERVIEW_QA_STAGE_PROFILES = Object.freeze({
  'qa-research': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  'qa-brief': APPLICATION_STAGE_PROFILES.pick,
  'qa-write': APPLICATION_STAGE_PROFILES.write,
  'qa-fact-check': APPLICATION_STAGE_PROFILES['fact-check'],
  'qa-fact-correction': APPLICATION_STAGE_PROFILES['fact-correction'],
  'qa-fact-recheck': APPLICATION_STAGE_PROFILES['fact-recheck'],
});
export const CAREER_WRITING_STAGE_PROFILES = Object.freeze({ ...APPLICATION_STAGE_PROFILES, ...INTERVIEW_QA_STAGE_PROFILES });

export function careerWritingStageProfile(stage) {
  return CAREER_WRITING_STAGE_PROFILES[stage] || CAREER_WRITING_DEFAULT_PROFILE;
}

/**
 * The inflation taxonomy a fact checker applies to first-person career claims.
 * `target` is the already-quoted employer name (or a descriptive phrase) the
 * writing is addressed to; employment/affiliation implications toward it are
 * inflation unless it is one of the candidate's own role companies.
 */
export function careerInflationRules(target) {
  return `List only actual inflation of ownership, scope, metrics, dates, tools or employment. Employment inflation is any statement or implication that the candidate works at, worked at, joined, left, or was otherwise employed by or affiliated with ${target}, unless ${target} is one of the résumé role companies. Applying to ${target}, wanting to join it, or describing what you would do there is not employment.`;
}

const FACT_FINDING_MAX_LINES = 20;
const clip = (value, max) => {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}${String.fromCharCode(0x2026)}`;
};
const foldFinding = value => value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');

/**
 * Validate fact-check findings: each names a checkable unit id, quotes a
 * verbatim span of that unit's text as `claim`, and gives a reason.
 * `unitText(id)` returns the unit's checkable text, or null when `id` is not a
 * checkable unit.
 */
export function careerFactFindingErrors(findings, unitText) {
  if (!Array.isArray(findings)) return [`fact-findings-shape: The reply needs a "findings" array (an empty array when every claim is supported); it has ${findings === undefined ? 'no "findings" field' : `a ${findings === null ? 'null' : typeof findings}`}.`];
  const errors = [];
  for (const [i, finding] of findings.entries()) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`fact-finding-shape: findings[${i}] is ${finding === null ? 'null' : Array.isArray(finding) ? 'an array' : `a ${typeof finding}`}, not an object with id, claim and reason.`);
      continue;
    }
    const { id, claim, reason } = finding;
    const unit = unitText(id);
    const segments = [];
    if (unit === null) segments.push(`fact-finding-unit: findings[${i}].id ${typeof id === 'string' ? JSON.stringify(clip(id, 60)) : `(${id === undefined ? 'missing' : typeof id})`} is not a unit id of the documents (use only the ids under CHECKABLE UNITS).`);
    if (typeof claim !== 'string' || !claim.trim()) segments.push(`fact-finding-claim: findings[${i}].claim is missing or empty.`);
    else if (unit !== null && !unit.includes(claim)) {
      let k = 0;
      let upper = claim.length;
      while (k + 1 < upper) {
        const middle = Math.floor((k + upper) / 2);
        if (unit.includes(claim.slice(0, middle))) k = middle;
        else upper = middle;
      }
      const cause = /…|\.\.\./u.test(claim)
        ? ` A claim is one unbroken span; it cannot contain "${String.fromCharCode(0x2026)}" or "...".`
        : foldFinding(unit).includes(foldFinding(claim))
          ? " It matches once whitespace, quote marks and dashes are ignored; copy the span character for character, with the unit's own spacing and marks."
          : ' Copy the span character for character from that unit in the DOCUMENTS block; do not paraphrase.';
      segments.push(`fact-finding-span: findings[${i}].claim ${JSON.stringify(clip(claim, 80))} is not a verbatim span of unit ${id}: its first ${k} of ${claim.length} characters appear in the unit and character ${k + 1} does not.${cause}`);
    }
    if (typeof reason !== 'string' || !reason.trim()) segments.push(`fact-finding-reason: findings[${i}].reason is missing or empty.`);
    if (segments.length) errors.push(segments.join(' | '));
  }
  return errors.length > FACT_FINDING_MAX_LINES ? [...errors.slice(0, FACT_FINDING_MAX_LINES), `fact-finding-shape: ${errors.length - FACT_FINDING_MAX_LINES} more findings also failed these checks; correct the lines above first.`] : errors;
}

/** After a correction, every flagged span must be gone from its unit. */
export function careerChangedFindingErrors(findings, unitText) {
  return findings.flatMap(finding => {
    const unit = unitText(finding.id);
    return unit && unit.includes(finding.claim)
      ? [`fact-check-unchanged: ${finding.id} still contains ${JSON.stringify(finding.claim)}.`] : [];
  });
}

/** The findings block a fact-correction prompt shows the writer. */
export function careerFactFindingsSection(findings) {
  if (!Array.isArray(findings) || !findings.length) throw new Error('Fact correction requires the fact-check findings.');
  return `\n\nFACT-CHECK FINDINGS TO CORRECT (every flagged span must change; a span returned unchanged is rejected):\n${findings.map(finding => `- ${finding?.id}: the span ${JSON.stringify(finding?.claim)} is not supported. ${finding?.reason}${typeof finding?.quote === 'string' && finding.quote.trim() ? ` Cited quote: ${JSON.stringify(finding.quote)}` : ''}`).join('\n')}`;
}

/**
 * Next step after a fact-correction round: recheck when it passed, correct
 * again while rounds remain, otherwise fall to the next-ranked candidate (or a
 * human stop when none remain).
 */
export function careerFactTransition({ priorRound = 0, failed, factIndex, rankedCount, maxRounds }) {
  if (!Number.isInteger(priorRound) || priorRound < 0 || !Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('Invalid fact-correction round state.');
  }
  if (!failed) return { round: priorRound + 1, factIndex, nextStage: 'fact-recheck' };
  const round = priorRound + 1;
  if (round < maxRounds) return { round, factIndex, nextStage: 'fact-correction' };
  const nextIndex = factIndex + 1;
  return { round, factIndex: nextIndex, nextStage: nextIndex < rankedCount ? 'fact-check' : 'write-verify-human-stop' };
}
