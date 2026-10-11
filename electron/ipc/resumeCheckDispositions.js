/**
 * What each résumé-side check is allowed to DO with a failure.
 *
 * The redesign principle: the career file is a fixed hand and the system plays
 * it as well as it can. TRUTH (facts, ownership and strength, scope, dates,
 * metrics, skills, evidence grounding) and HYGIENE (schema, safety, identity
 * and host-owned fields) reject a document. TASTE (cadence, wording, opening
 * forms, how a block is laid out, how complete a selection is) never does:
 * a deterministic wording gate cannot be satisfied naturally, so it pushes a
 * writer toward filler, and the gate audit measured exactly that.
 *
 * A check therefore carries one of three dispositions:
 *   'gate'     a failure blocks the document and is returned for correction;
 *   'advisory' a failure is reported to the writer and the reviewer as
 *              guidance and never blocks;
 *   'off'      the check is not reported at all.
 *
 * This module is import-free ON PURPOSE. jobApplication.js (the rendered
 * résumé prose checks) and structuredResume.js (the structured-résumé rules)
 * both read the same table, and structuredResume.js already imports
 * jobApplication.js, so the table cannot live in either of them without a
 * module cycle. The table is keyed by check id: the `id` of a prose check
 * result, and the `rule` of a structured-résumé offense, which share one
 * namespace so one helper partitions both.
 *
 * An id this table does not list is a GATE. A rule added without being
 * classified therefore fails closed (it rejects, as every rule did before the
 * redesign) until someone decides; the drift test in
 * scripts/tests/gapfix-v17-resume-dispositions.js fails on that omission
 * instead of letting it ship silently.
 */

export const RESUME_CHECK_DISPOSITION_VALUES = Object.freeze(['gate', 'advisory', 'off']);

// [id, disposition, class, why]. The class is the audit's (TRUTH / HYGIENE /
// TASTE / MIXED); where the disposition departs from the class's usual one the
// `why` says so. One list builds all three frozen maps, so no id can have a
// disposition without a stated reason.
const ROWS = Object.freeze([
  // ---- rendered-résumé prose checks (jobApplication.js evaluateResumeProseChecks)
  ['resume-bullet-self-containment', 'advisory', 'TASTE', 'a bullet that opens on a pronoun or leans on "that <noun>" reads worse out of context; the free-form résumés were rejected here although the referent sat in the preceding bullet. No fact is at stake.'],
  ['resume-bullet-focus', 'off', 'TASTE', 'relational-word heuristic over the skills block; it never fired on a real résumé and judges taste.'],
  ['resume-bullet-length', 'advisory', 'TASTE', 'the 180-character cap is a proxy for page fit, which the renderer measures on the rendered page and the fit loop corrects with real overflow numbers. Dense bullets are a true readability defect, so the writer is still told.'],
  ['resume-role-bullet-budget', 'advisory', 'HYGIENE', 'a layout proxy for the same measured page fit; the hard schema ceiling (STRUCTURED_RESUME_LIMITS.bulletsPerRole) still bounds a pathological response. Reported as guidance because fewer, stronger bullets read better.'],
  ['resume-bullet-opening-variety', 'off', 'TASTE', 'a cadence rule: three true "Built ..." bullets were rejected, and rotating the verb passes while making the claim vaguer. It trades accuracy for variety.'],
  ['compound-hyphenation', 'off', 'TASTE', 'closed orthography list reused from the letter; spelling preference, not a fact.'],
  ['parallel-structure', 'off', 'TASTE', 'grammar preference reused from the letter.'],
  ['reference-clarity', 'off', 'TASTE', 'a plural pronoun with a coordinated antecedent in the same sentence was rejected; grammar preference.'],
  ['modifier-attachment', 'off', 'TASTE', 'one single-shape grammar pattern reused from the letter.'],

  // ---- structured-résumé rules (structuredResume.js): TRUTH and HYGIENE stay gates
  ['evidence-id-is-verified', 'gate', 'HYGIENE', 'an evidence id the host never issued cannot ground anything.'],
  ['evidence-includes-career-data', 'gate', 'TRUTH', 'a posting quote alone cannot support a claim about the candidate.'],
  ['approved-skill-spelling', 'gate', 'HYGIENE', 'a mis-cased approved name would reach the HTML and the PDF unchanged.'],
  ['prose-names-approved-skill-its-evidence-does-not-state', 'gate', 'TRUTH', 'naming a skill says the work used it; the cited quote must state it.'],
  ['bullet-cites-own-role-career-section', 'gate', 'TRUTH', 'attributes one employer’s work to another otherwise.'],
  ['bullet-cites-past-its-section-opening-block', 'advisory', 'TASTE', 'a bullet that restates the role header is a weak bullet, not a false one; a citation-quality preference.'],
  ['bullet-cites-evidence-already-spent-in-role', 'advisory', 'MIXED', 'anti-fragmentation guidance: the same accomplishment as two bullets is redundancy, not a fabrication.'],
  ['project-field-occurs-in-cited-career-evidence', 'gate', 'TRUTH', 'a project name or metric the cited evidence never states is invented.'],
  ['project-description-shares-career-evidence-terms', 'gate', 'TRUTH', 'the only grounding a project description gets: a description with no countable term in common with its cited evidence asserts nothing the evidence supports.'],
  ['project-cites-job-listing-evidence', 'advisory', 'TASTE', 'relevance selection, which the contract itself says is not grounding.'],
  ['project-shares-job-listing-evidence-terms', 'advisory', 'TASTE', 'relevance selection, not grounding.'],
  ['project-is-work-done-for-a-listed-employer', 'advisory', 'MIXED', 'a project the approved record links to a role this résumé lists reads as personal work when filed under Projects; precise only as far as the record’s own link, so it advises.'],
  ['skill-item-occurs-in-cited-career-evidence', 'gate', 'TRUTH', 'a skill the cited evidence never states is invented.'],
  ['skill-item-is-a-filterable-name', 'gate', 'TRUTH', 'an item that is not an exact, index-eligible approved skill is not a source-backed skill.'],
  ['skill-item-looks-like-a-filterable-name', 'advisory', 'TASTE', 'the pre-snapshot capitalisation heuristic (an uppercase letter or digit) rejected a lowercase tool name that is a perfectly good keyword; the grounding rule already proves the item is true.'],
  ['skill-group-is-neutral-or-in-career-data', 'advisory', 'TASTE', 'label vocabulary. The part of it that is a claim (a skill level the evidence never states) is the separate gate below.'],
  ['skill-group-label-claims-a-level', 'gate', 'TRUTH', 'a label such as a proficiency tier is a strength claim about the candidate; it must be stated by the evidence the group cites.'],
  ['skills-block-big-enough-to-split-is-split', 'advisory', 'TASTE', 'design-system layout proxy; page fit is measured downstream.'],
  ['skills-block-within-design-row-budget', 'advisory', 'TASTE', 'design-system layout proxy; page fit is measured downstream.'],
  ['skills-block-within-design-term-budget', 'advisory', 'TASTE', 'design-system layout proxy; page fit is measured downstream.'],
  ['skills-row-within-design-character-budget', 'advisory', 'TASTE', 'design-system layout proxy; a long row wraps and the fit loop measures what that costs.'],
  ['skill-block-omits-posting-named-attested-term', 'advisory', 'TASTE', 'completeness of a selection, not truth: nothing false is rendered when a true skill is left out.'],
  ['skills-block-omits-prioritized-career-attested-term', 'advisory', 'TASTE', 'completeness of a selection, not truth.'],
  ['education-field-occurs-in-cited-career-evidence', 'gate', 'TRUTH', 'a degree, institution or date the evidence never states is invented.'],
  ['certification-field-occurs-in-cited-career-evidence', 'gate', 'TRUTH', 'a credential, issuer or date the evidence never states is invented.'],
  ['education-dates-state-one-end-of-a-range', 'gate', 'TRUTH', 'one end of a stated range is not the date of the thing.'],
  ['certification-dates-state-one-end-of-a-range', 'gate', 'TRUTH', 'one end of a stated range is not the date of the thing.'],
]);

export const RESUME_CHECK_DISPOSITIONS = Object.freeze(Object.fromEntries(ROWS.map(([id, disposition]) => [id, disposition])));
export const RESUME_CHECK_CLASSES = Object.freeze(Object.fromEntries(ROWS.map(([id, , checkClass]) => [id, checkClass])));
export const RESUME_CHECK_RATIONALES = Object.freeze(Object.fromEntries(ROWS.map(([id, , , why]) => [id, why])));

const VALID_DISPOSITIONS = new Set(RESUME_CHECK_DISPOSITION_VALUES);

/**
 * The disposition of one check id. Anything this table does not list, or lists
 * with a value that is not one of the three, is a gate: the safe answer for a
 * rule nobody has classified is the one it had before there was a table.
 * `table` is injectable so a test can flip one entry and prove the outcome
 * flips with it.
 */
export function resumeCheckDisposition(id, table = RESUME_CHECK_DISPOSITIONS) {
  if (typeof id !== 'string' || !table || typeof table !== 'object' || !Object.hasOwn(table, id)) return 'gate';
  const value = table[id];
  return VALID_DISPOSITIONS.has(value) ? value : 'gate';
}

/**
 * Split check results by what a failure is allowed to do.
 *
 * Accepts the shape both families already use: `{ id, passed, detail }`
 * (rendered prose checks) and `{ rule, ... }` (a structured-résumé offense,
 * read as the id). Returns copies carrying their `disposition`:
 *   blocking  failed gates, to be returned for correction;
 *   advisory  failed advisories, to be reported and never block;
 *   off       failed checks switched off (kept only so a test can see them);
 *   passed    every check that passed, whatever its disposition.
 * A failed entry that names no id at all is a gate: an unattributable
 * failure must not be waved through.
 */
export function partitionResumeCheckResults(checks, table = RESUME_CHECK_DISPOSITIONS) {
  const partition = { blocking: [], advisory: [], off: [], passed: [] };
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || typeof check !== 'object') continue;
    const id = typeof check.id === 'string' ? check.id : (typeof check.rule === 'string' ? check.rule : '');
    const disposition = resumeCheckDisposition(id, table);
    const stamped = { ...check, disposition };
    if (check.passed === true) partition.passed.push(stamped);
    else if (disposition === 'advisory') partition.advisory.push(stamped);
    else if (disposition === 'off') partition.off.push(stamped);
    else partition.blocking.push(stamped);
  }
  return partition;
}
