/**
 * Career-grounded writing core for application bundle generation. Quality for "is this first-person career claim
 * supported by its cited quotes" is tested once, here.
 *
 * - Stage model profiles (Claude CLI aliases resolve to the newest release).
 * - The fact-check inflation rules and the verbatim-span finding contract.
 * - The "every flagged span must change" correction contract.
 * - The fact-correction round transition.
 *
 * Callers supply document-specific unit text through a `unitText(id)` lookup,
 * so résumé and letter units share one validator.
 * Application prompts and error strings are pinned byte-for-byte by
 * scripts/tests/career-writing-core.js against a pre-extraction golden capture.
 */

export const CLAUDE_SONNET_MODEL = 'sonnet';
export const CLAUDE_OPUS_MODEL = 'opus';
export const CLAUDE_HAIKU_MODEL = 'haiku';
export const CAREER_WRITING_DEFAULT_PROFILE = Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' });

// Chosen on cost and quality, 2026-11-01 (docs/application-improvement-sessions.md).
// docs/ai-model-selection.md holds the selection policy, results and open gaps.
// Writing at Opus low cost a quarter of xhigh with no measurable loss in blind
// panels; Opus high fact-checks catch ownership overstatements Sonnet passes.
export const APPLICATION_STAGE_PROFILES = Object.freeze({
  // editorial-plan, 2026-11-21: Opus xhigh. Moved to Haiku high on 2026-11-20 on pooled panels judged with older writers; confirmed with the
  // current Opus low writer, Haiku high outlines' letters trailed the xhigh control by 1.3-1.5 mean rank (floor 1.2) and never ranked
  // first in 9, so it returned to xhigh (docs/ai-model-selection.md).
  'editorial-plan': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  write: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' }),
  pick: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  convert: Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  // requirements-adjudication, 2026-11-10: Sonnet low matched a production rerun (Sonnet high) at 91.3% decision agreement on 54 real prompts at 7% less; every Haiku setting failed (68-77%) (docs/ai-model-selection.md).
  'requirements-adjudication': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'low' }),
  // verify-correction, 2026-11-10: Haiku medium matched production in blind judging of final bundles over 7 jobs (mean 7.57 vs 7.43 and 7.29 for two Sonnet high runs) with acceptance within the production pair and 30-43% lower stage cost; Haiku low failed (docs/ai-model-selection.md).
  'verify-correction': Object.freeze({ model: CLAUDE_HAIKU_MODEL, effort: 'medium' }),
  'fit-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-check': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  'fact-correction': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  // fact-recheck, 2026-11-21: Opus high. Haiku high matched it on planted claims (14/18) and passed on flag counts, but three blind judges
  // found none of its 7 extra flags on real prompts real (5 defensible, 2 false alarms) and it missed the one real flag Opus raised, at
  // $0.017 vs $0.30 a call; every extra flag sends a correct document back for another round (docs/ai-model-selection.md).
  'fact-recheck': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
});
// The writer on a cover-letter-only run (it also reads the saved résumé), measured on its own prompt. 2026-11-20: on all
// 5 cover-only jobs, 2 runs each, a blind 6-way judge ranked Opus low 2.80 against Opus medium's 3.60 (within the
// rep-to-rep floor), at $0.40 against $0.50 a call, so it runs on Opus low like the other writers; the 2026-11-15
// Opus medium choice rested on one job (docs/ai-model-selection.md).
export const COVER_ONLY_WRITE_PROFILE = Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'low' });
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
