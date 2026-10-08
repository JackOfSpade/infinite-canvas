/**
 * Final, host-owned assembly for the application paste-back workflow.
 *
 * This module deliberately has no filesystem or IPC access.  It receives the
 * frozen job state after a final AI review and creates the legacy result shape
 * consumed by the existing validation/render/save pipeline.  The AI provides
 * only structured copy and its editorial notes; it never provides markup,
 * output locations, source-grounding quotes, or invented checklist evidence.
 */
import { assertTrustedSourceRoles, isUnsafeControlCharacter, projectContactChannels, projectTrustedIdentity, renderStructuredResume } from './structuredResume.js';
import { resolveAuthorityEvidence, resolveAuthorityRole } from './applicationCareerAuthority.js';
export { MAX_FROZEN_SOURCE_CHARS } from './applicationSourceLimits.js';
import { MAX_FROZEN_SOURCE_CHARS } from './applicationSourceLimits.js';

const DEFAULT_OUTPUT_BUNDLE_ROOT = 'Applied Jobs';

/** Enforces the host-selected drafting view without discarding the complete
 * pinned authority catalog used for source verification. */
export function assertAuthorityDraftSelection({ fullAuthority, selection, acceptedNonAuthorityEvidenceIds = [], resume, coverLetter } = {}) {
  const selectedRoles = new Set(selection?.selectedRoleIds || []);
  const selectedEvidence = new Set(selection?.selectedEvidenceIds || []);
  const selectedProjects = new Set(selection?.selectedProjectIds || []);
  const resumeProjectObligation = selection?.resumeProjectObligation ?? null;
  const selectedEducation = new Set(selection?.selectedEducationIds || []);
  const selectedCredentials = new Set(selection?.selectedCertificationIds || []);
  const selectedSkillIds = new Set(selection?.selectedSkillIds || []);
  const catalogById = new Map((fullAuthority?.catalog || []).map(item => [item?.id, item]));
  // The current-authority selection is deliberately about the pinned career
  // catalog. A frozen draft plan may additionally carry host-accepted listing
  // evidence, but it must arrive as an explicit allowlist rather than through
  // an ID shape or a fallback that makes every unknown citation permissible.
  if (!Array.isArray(acceptedNonAuthorityEvidenceIds)
    || acceptedNonAuthorityEvidenceIds.some(id => typeof id !== 'string' || !id)
    || new Set(acceptedNonAuthorityEvidenceIds).size !== acceptedNonAuthorityEvidenceIds.length
    || acceptedNonAuthorityEvidenceIds.some(id => catalogById.has(id))) {
    throw new Error('Application non-authority evidence allowlist is invalid.');
  }
  const acceptedNonAuthorityEvidence = new Set(acceptedNonAuthorityEvidenceIds);
  const projectIdForEvidence = (evidenceId) => {
    const item = catalogById.get(evidenceId);
    return typeof item?.projectId === 'string' && item.projectId
      ? item.projectId
      : item?.owner?.type === 'project' && typeof item.owner.id === 'string' && item.owner.id
        ? item.owner.id
        : null;
  };
  const typedEntityIdForEvidence = (evidenceId, type) => {
    const item = catalogById.get(evidenceId);
    const match = new RegExp(`^host\\.career\\.${type}\\.([a-z][a-z0-9-]{0,79})\\.`).exec(String(item?.id || ''));
    return match?.[1] || (item?.owner?.type === type && typeof item.owner.id === 'string' ? item.owner.id : null);
  };
  if ([...selectedEvidence].some(id => !catalogById.has(id))) throw new Error('Application selection references evidence outside pinned authority.');
  // Project authority is host-derived from typed selected evidence, never a
  // model-authored project/source ID.  Its ordered projection is persisted in
  // the selection receipt and checked here again before final assembly.
  const derivedSelectedProjectIds = [];
  for (const evidenceId of selection?.selectedEvidenceIds || []) {
    const projectId = projectIdForEvidence(evidenceId);
    if (projectId && !derivedSelectedProjectIds.includes(projectId)) derivedSelectedProjectIds.push(projectId);
  }
  if (JSON.stringify(derivedSelectedProjectIds) !== JSON.stringify(selection?.selectedProjectIds || [])
    || selectedProjects.size !== derivedSelectedProjectIds.length) {
    throw new Error('Application selection has an invalid typed project-authority projection.');
  }
  if (resumeProjectObligation !== null) {
    if (!resumeProjectObligation || typeof resumeProjectObligation !== 'object'
      || resumeProjectObligation.version !== 1
      || resumeProjectObligation.priority !== 'highest'
      || !['projectId', 'evidenceId', 'requirementId'].every(key => typeof resumeProjectObligation[key] === 'string' && resumeProjectObligation[key])) {
      throw new Error('Application selection has an invalid host-required résumé project obligation.');
    }
    if (!selectedProjects.has(resumeProjectObligation.projectId)
      || !selectedEvidence.has(resumeProjectObligation.evidenceId)
      || projectIdForEvidence(resumeProjectObligation.evidenceId) !== resumeProjectObligation.projectId) {
      throw new Error('Application selection has an unbound host-required résumé project obligation.');
    }
  }
  // Like project authority, education and certification authority is derived
  // from the selected evidence stream. A response may choose phrasing and
  // order, but cannot smuggle in an unselected credential or a source-order
  // item that never matched this job.
  const deriveTypedSelection = type => [...new Set((selection?.selectedEvidenceIds || []).map(id => typedEntityIdForEvidence(id, type)).filter(Boolean))];
  const derivedEducationIds = deriveTypedSelection('education');
  const derivedCertificationIds = deriveTypedSelection('certification');
  if (JSON.stringify(derivedEducationIds) !== JSON.stringify(selection?.selectedEducationIds || [])
    || selectedEducation.size !== derivedEducationIds.length
    || JSON.stringify(derivedCertificationIds) !== JSON.stringify(selection?.selectedCertificationIds || [])
    || selectedCredentials.size !== derivedCertificationIds.length) {
    throw new Error('Application selection has an invalid typed education or certification authority projection.');
  }
  const roles = Array.isArray(resume?.roles) ? resume.roles : [];
  // Structured résumés use the immutable source role ID as role.id; unknown
  // response properties are intentionally discarded by their normalizer.
  if (roles.some(role => !selectedRoles.has(role?.id))) throw new Error('Application draft contains an unselected source role.');
  const projects = Array.isArray(resume?.projects) ? resume.projects : [];
  for (const project of projects) {
    const projectEvidenceIds = Array.isArray(project?.evidenceIds) ? project.evidenceIds : [];
    const typedProjectIds = [...new Set(projectEvidenceIds.map(projectIdForEvidence).filter(Boolean))];
    if (typedProjectIds.length !== 1 || !selectedProjects.has(typedProjectIds[0])) {
      throw new Error('Application draft contains a project without one selected typed project authority.');
    }
  }
  if (resumeProjectObligation !== null) {
    // The project ID alone is not sufficient here: a selected project can
    // have several evidence rows, only one of which may be the direct match
    // for the highest-priority requirement. Requiring that exact immutable
    // citation keeps the rendered project tied to the match receipt rather
    // than letting another selected row from the same project satisfy it.
    const renderedRequiredProject = projects.some(project => {
      const evidenceIds = Array.isArray(project?.evidenceIds) ? project.evidenceIds : [];
      return evidenceIds.includes(resumeProjectObligation.evidenceId)
        && projectIdForEvidence(resumeProjectObligation.evidenceId) === resumeProjectObligation.projectId;
    });
    if (!renderedRequiredProject) {
      throw new Error('Application draft omits the exact host-required project evidence selected for a highest-priority requirement.');
    }
  }
  for (const education of (Array.isArray(resume?.education) ? resume.education : [])) {
    const typed = [...new Set((education?.evidenceIds || []).map(id => typedEntityIdForEvidence(id, 'education')).filter(Boolean))];
    if (typed.length !== 1 || !selectedEducation.has(typed[0])) throw new Error('Application draft contains education without one selected typed education authority.');
  }
  for (const credential of (Array.isArray(resume?.credentials) ? resume.credentials : [])) {
    const typed = [...new Set((credential?.evidenceIds || []).map(id => typedEntityIdForEvidence(id, 'certification')).filter(Boolean))];
    if (typed.length !== 1 || !selectedCredentials.has(typed[0])) throw new Error('Application draft contains a credential without one selected typed certification authority.');
  }
  // An empty current-authority skill selection is meaningful: no selected
  // evidence supports an ATS skill row, so the truthful bounded document
  // omits that block. Do not treat an empty set as "unrestricted" and let
  // source-order inventory terms leak back into the draft.
  if (Array.isArray(selection?.selectedSkillIds)) {
    const allowedTerms = new Set((fullAuthority?.skills || []).filter(skill => selectedSkillIds.has(skill.id)).map(skill => String(skill.name || skill.term || '').normalize('NFKC').toLocaleLowerCase()).filter(Boolean));
    const renderedTerms = (Array.isArray(resume?.skills) ? resume.skills : []).flatMap(group => Array.isArray(group?.items) ? group.items : []).map(item => String(item).normalize('NFKC').toLocaleLowerCase());
    if (renderedTerms.some(term => !allowedTerms.has(term))) throw new Error('Application draft contains an unselected skill term.');
  }
  // Read citations only from the response schema's known, bounded leaves.
  // Arbitrary recursion made a hostile nested object both a stack/memory risk
  // and an implicit alternate citation channel outside the document schema.
  const citations = [];
  const addEvidenceIds = (value, label) => {
    if (value == null || !Object.hasOwn(value, 'evidenceIds')) return;
    if (!Array.isArray(value.evidenceIds)) throw new Error(`${label}.evidenceIds must be an array.`);
    citations.push(...value.evidenceIds);
  };
  const boundedRoles = Array.isArray(resume?.roles) ? resume.roles : [];
  for (const role of boundedRoles) for (const bullet of (Array.isArray(role?.bullets) ? role.bullets : [])) addEvidenceIds(bullet, 'resume role bullet');
  for (const project of (Array.isArray(resume?.projects) ? resume.projects : [])) addEvidenceIds(project, 'resume project');
  for (const education of (Array.isArray(resume?.education) ? resume.education : [])) addEvidenceIds(education, 'resume education');
  for (const credential of (Array.isArray(resume?.credentials) ? resume.credentials : [])) addEvidenceIds(credential, 'resume credential');
  for (const group of (Array.isArray(resume?.skills) ? resume.skills : [])) addEvidenceIds(group, 'resume skill group');
  for (const paragraph of (Array.isArray(coverLetter?.paragraphs) ? coverLetter.paragraphs : [])) addEvidenceIds(paragraph, 'cover letter paragraph');
  if (citations.some(id => !selectedEvidence.has(id) && !acceptedNonAuthorityEvidence.has(id))) throw new Error('Application draft cites unselected authority evidence.');
}

/**
 * The character ceiling this module grades a frozen source against.
 *
 * Exported because the queue WRITES those sources: localAiApplication.js
 * rejects an oversized career corpus or listing before freezing it beside the
 * job. The two numbers used to be chosen independently — 240,000 written,
 * 120,000 accepted — so a corpus between them froze a job that no response
 * could finish and that pressing Generate reproduced exactly. One constant
 * read by the writer and by this grader keeps the accepted envelope aligned
 * without silently omitting evidence.
 */

// `repairs` names what a defect requires a change to, in the host's repair
// vocabulary, and travels on the error the way every other paste validator
// reports it. This module runs BEFORE the result validator, so a defect it
// raises in what the review returned would otherwise reach the host with no
// repair attached and fall to the host's unattributed default — enforceable,
// but weaker than the check's own knowledge. A failure about the app's own
// frozen state passes none and is raised through frozenState() instead: no
// repair target can name it, because no response can repair it.
function fail(message, repairs = null) {
  const error = new Error(`Paste application assembly: ${message}`);
  if (repairs) error.failureRecords = [{ message: error.message, repairs }];
  throw error;
}

/**
 * A defect the responder CANNOT repair, because what it grades is state this
 * job already holds and no response it can still take supplies: the career
 * corpus, the job listing, the evidence plan an earlier stage accepted and no
 * later stage can replace, the candidate identity that plan carried, and the
 * job's own input record. Two of those reached the job THROUGH a response —
 * the first stage returns the evidence plan and the identity — so the class is
 * not "state the app authored"; it is state whose authoring stage has closed.
 *
 * It is a class, not a repair target and not a flag on a failure record, for
 * three reasons. Every repair target is a promise that the NEXT RESPONSE can
 * come back different in that respect — a reserved target would have to be
 * threaded through the required-change gate and printed to the responder in
 * PASTE_REPAIR_TARGET_RULES, which is routing a responder to an answer that
 * cannot work. A flag on a record still travels inside the collected failure
 * list, so any collector that did not learn about it would silently re-admit
 * the correction round. And this app already has the shape: a host
 * configuration fault (LOCAL_AI_VALIDATION_CONFIGURATION,
 * STRUCTURED_RESUME_CONFIGURATION) travels as its own class precisely so every
 * collector rethrows it instead of listing it as a finding. The precedent was
 * completedResultValidationOptions, held outside the submit's catch so a
 * mismatched app-owned contract could not be reported as an invalid response;
 * that exit stopped at "no correction round" and left the job queued holding
 * its handoff code, so it now raises this class from inside the catch and
 * takes the one route that ends the job. Every gate the completion pass
 * reaches does the same, whichever module it lives in.
 */
export const LOCAL_AI_JOB_INTEGRITY_CODE = 'LOCAL_AI_JOB_INTEGRITY';

// The action is named, not described: "Generate" is the button on the job card
// that queues a replacement, and rebuilding is the only thing that can replace
// frozen state. Naming an action that does not exist would be the same
// anti-disclosure as naming a repair that cannot work.
const JOB_INTEGRITY_ACTION = 'Press Generate on the job card to build this application again from current career data and the current listing.';

export class LocalAiJobIntegrityError extends Error {
  constructor({ subject, observation }) {
    super(`This application job cannot be completed, and no pasted response can repair it. ${observation} The value it names is held in ${subject}, and no response this job can still take supplies it. ${JOB_INTEGRITY_ACTION}`);
    this.name = 'LocalAiJobIntegrityError';
    this.code = LOCAL_AI_JOB_INTEGRITY_CODE;
    // The two halves kept apart from the sentence, so a log or a manifest
    // record can report what was observed without re-parsing the prose.
    this.jobIntegrity = { subject, observation };
  }
}

export function isJobIntegrityFault(error) {
  return error?.code === LOCAL_AI_JOB_INTEGRITY_CODE;
}

/**
 * Run a check that reads only app-owned frozen state, and convert anything it
 * raises into a job-integrity fault. The conversion is at the CALL SITE rather
 * than inside the leaf checks because the leaves (`record`, `text`,
 * `sourceQuote`) grade both frozen state and the pasted response; what decides
 * the class is which of the two the value came from, and only the caller knows
 * that.
 *
 * Exported because the same question is asked past this module. The completion
 * gate that runs immediately after this assembly re-grades the job's own input
 * record — its format version, its quality-checklist version, its
 * generation-audit contract — and the poll and import paths re-grade the
 * assembled package again later. Those are the same fault about the same
 * frozen values, so they take this wrapper and this class rather than a second
 * one that every collector would have to learn separately.
 */
export function frozenState(subject, run) {
  try {
    return run();
  } catch (error) {
    if (isJobIntegrityFault(error)) throw error;
    throw new LocalAiJobIntegrityError({ subject, observation: String(error?.message || error) });
  }
}

// The structured renderer raises its own errors from another module. A defect
// it finds in a replacement résumé — a bullet citing evidence from another
// role's section — is repaired in that résumé, by rewriting the bullet or by
// citing different evidence, and this target accepts either. Its configuration
// fault is a host defect and stays untagged so it keeps travelling as one, a
// job-integrity fault raised inside this closure is not about the document
// wrapping it, and an error that already carries a finer answer keeps it.
function withRepairs(repairs, run) {
  try {
    return run();
  } catch (error) {
    if (error?.code === 'STRUCTURED_RESUME_CONFIGURATION' || isJobIntegrityFault(error) || Array.isArray(error?.failureRecords)) throw error;
    error.failureRecords = [{ message: String(error?.message || error), repairs }];
    throw error;
  }
}

function record(value, label, repairs = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`, repairs);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text.`);
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if ([...cleaned].some(character => isUnsafeControlCharacter(character))) fail(`${label} contains an unsafe control character.`);
  return cleaned;
}

// Quotes are copied from a frozen source. Do not normalize their whitespace
// before checking membership: a valid multi-line quote must remain valid.
function sourceQuote(value, label, max = 8_000) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text.`);
  if (value.length > max) fail(`${label} exceeds ${max} characters.`);
  if ([...value].some(character => isUnsafeControlCharacter(character))) fail(`${label} contains an unsafe control character.`);
  return value.trim();
}

function normalizedSourceIncludes(source, value) {
  return String(source).replace(/\s+/g, ' ').includes(String(value).replace(/\s+/g, ' '));
}

/**
 * The one comparison used wherever a submitted field has to repeat document
 * text back verbatim.
 *
 * Two validators read the generation audit's paragraph text: this module binds
 * it to the final letter, and localAiApplication.js's sanitizeGenerationAudit
 * binds the same field to the same paragraphs a moment later. They disagreed —
 * this one collapsed whitespace, that one collapsed whitespace AFTER NFKC — so
 * a paragraph repeated back with a compatibility-equivalent character (a “ﬁ”
 * ligature, a full-width digit) failed here and would have passed there. The
 * failure it produced named the wrong repair as well: “stale after a review
 * edit” sends a responder looking for prose it changed, when nothing about the
 * prose changed. Both now read this helper, so a field cannot pass one binding
 * check and fail the other.
 */
export function normalizeBoundDocumentText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function boundDocumentTextMatches(a, b) {
  return normalizeBoundDocumentText(a) === normalizeBoundDocumentText(b);
}

/**
 * The one membership test for a quote a frozen evidence plan supplies.
 *
 * Two of them existed. This module asked `source.includes(quote)` on the
 * corpus exactly as the file holds it; localAiApplication.js's
 * sanitizeSourceGrounding asked the same question after NFKC, a whitespace
 * collapse and a control-character scrub. One quote could therefore be absent
 * here and present there — and since this module raises a job-integrity fault
 * where that one raises a repairable document defect, the two answers were not
 * merely different strictnesses, they were different verdicts about whether
 * the job could be finished at all.
 *
 * The normalizing side wins, and both sides now take it. A plan quote is
 * accepted at the evidence-plan stage against a RAW substring test, which is
 * the strict gate and the one whose rejection a responder can still answer; by
 * the time the plan is frozen the only question left is whether the same
 * passage is still there, and a compatibility-equivalent character or a
 * reflowed line break is not a different passage. Normalizing both sides also
 * keeps a multi-line quote valid, which is what the raw test was protecting.
 */
export function frozenSourceQuoteTest(source) {
  // Built once per source rather than once per quote: one grade asks this of
  // every item a plan holds — up to 160 — against a corpus that may run to
  // MAX_FROZEN_SOURCE_CHARS, and a status poll repeats the whole grade every
  // few seconds. Normalizing the corpus inside the predicate would be the same
  // pass over the same 240,000 characters 160 times.
  const normalized = normalizeBoundDocumentText(source);
  return quote => normalized.includes(normalizeBoundDocumentText(quote));
}

/**
 * The one judgement about that comparison.
 *
 * A plan quote that no longer occurs in the source it names is a defect in
 * state whose authoring stage has closed, and no citation change reaches it:
 * evidenceCatalog grades EVERY item the plan holds, not only the items a
 * document happens to cite, so a response that stops citing the broken item
 * still fails here. That is why this is the integrity class and not a repair
 * target, and why the answer must not depend on which surface noticed.
 */
export function assertFrozenPlanQuoteOccursIn(occursInSource, quote, observation) {
  frozenState(FROZEN_EVIDENCE_PLAN, () => {
    if (!occursInSource(quote)) throw new Error(`Paste application assembly: ${observation}`);
  });
}

/**
 * Grade one of the two frozen source files this job carries.
 *
 * Exported because the status poll and the import path read the same two files
 * and used to scrub them through cleanText() first, which replaces an unsafe
 * control character with a space and silently truncates at the ceiling. A
 * corpus this module refuses at submit was therefore invisible at both of the
 * later surfaces: the same bytes ended one job and finished another. One
 * reader, three surfaces, one verdict.
 */
export function gradeFrozenSource(value, label, subject) {
  return frozenState(subject, () => sourceQuote(value, label, MAX_FROZEN_SOURCE_CHARS));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// The résumé contract prints this number: a bullet that cites five distinct
// career-data quotes clears the résumé stage and dies here, three stages
// later, so the cap has to be stated where the bullets are written.
export const MAX_UNIT_CAREER_DATA_QUOTES = 4;

function careerQuotesForIds(ids, evidenceById, occursInCareerData, label) {
  if (!Array.isArray(ids) || !ids.length) fail(`${label} needs at least one evidence ID.`);
  const quotes = [];
  const seen = new Set();
  for (const id of ids) {
    const evidence = evidenceById.get(id);
    if (!evidence) fail(`${label} references unknown evidence ID "${String(id)}".`);
    // Job-listing evidence can establish target relevance, but it cannot
    // ground a candidate claim. Every document unit therefore needs at least
    // one exact career-data quote at final assembly.
    if (evidence.sourceId !== 'career-data') continue;
    // The quote is the plan's, not the document's — the document chose only
    // the ID. evidenceCatalog has already graded every one of these against
    // the frozen corpus, so these two are a second reading of the same frozen
    // value and belong to the same subject, not to the citing document.
    const quote = frozenState(FROZEN_EVIDENCE_PLAN, () => sourceQuote(evidence.quote, `${label} evidence ${String(id)} quote`));
    assertFrozenPlanQuoteOccursIn(occursInCareerData, quote, `${label} evidence ${String(id)} no longer occurs in frozen career data.`);
    if (!seen.has(quote)) { seen.add(quote); quotes.push(quote); }
    if (quotes.length > MAX_UNIT_CAREER_DATA_QUOTES) fail(`${label} uses more than ${MAX_UNIT_CAREER_DATA_QUOTES} distinct career-data quotes; retain only the most relevant evidence IDs.`);
  }
  if (!quotes.length) fail(`${label} needs at least one career-data evidence ID; job-listing evidence alone cannot support candidate copy.`);
  return quotes;
}

// A renderer still needs a small text surface for legacy presentation/prose
// helpers. Never hand it the approved snapshot projection: derive this
// ephemeral, citation-bounded surface from the authority IDs the accepted
// documents actually cite. Authority validation above remains the source of
// truth for ownership and exact quote membership.
function authorityRenderCareerData(authority, sourceRoles, evidenceById) {
  const quoteByRole = new Map((sourceRoles || []).map(role => [role.id, []]));
  const otherQuotes = [];
  for (const evidence of evidenceById.values()) {
    if (evidence.sourceId !== 'career-data') continue;
    const unit = resolveAuthorityEvidence(authority, evidence.id, evidence.quote);
    let owners = [];
    if (unit.kind === 'role') owners = [unit.entityId];
    else if (unit.kind === 'achievement') owners = (sourceRoles || []).filter(role => (resolveAuthorityRole(authority, role.id).achievementIds || []).includes(unit.entityId)).map(role => role.id);
    else if (unit.kind === 'skill') owners = (sourceRoles || []).filter(role => (resolveAuthorityRole(authority, role.id).skillIds || []).includes(unit.entityId)).map(role => role.id);
    if (owners.length) owners.forEach(id => quoteByRole.get(id)?.push(unit.quote));
    else otherQuotes.push(unit.quote);
  }
  const sections = (sourceRoles || []).map(role => [
    `### ${role.title} — ${role.company} [Role ID: ${role.id}]`,
    ...(role.location ? [`${role.company} — ${role.location}`] : []),
    `Dates: ${role.dates}`,
    ...[...new Set(quoteByRole.get(role.id) || [])],
  ].join('\n'));
  return [...sections, ...(otherQuotes.length ? ['## Selected authority evidence', ...new Set(otherQuotes)] : [])].join('\n\n');
}

// The frozen state this module grades, named once. A subject completes the
// sentence "The value it names is held in …" in LocalAiJobIntegrityError, so
// each one names WHERE the value sits and when this job fixed it — never who
// wrote it. Two of these arrive in the first stage's response.
//
// Every one of them is exported, because the status poll and the import path
// grade the same frozen values from the same files and a fault about one of
// them must name the same place wherever it is observed. A second subject
// written at another call site is the same defect as a second rule set: two
// sentences about one value that can drift apart.
export const FROZEN_CAREER_DATA = 'the career corpus this job froze when it was queued';
export const FROZEN_JOB_LISTING = 'the job listing this job froze when it was queued';
// The plan is accepted in the first stage and no later stage can replace it:
// a review response carries a résumé, a letter and its own review fields, and
// the host never reads an evidencePlan back out of one.
export const FROZEN_EVIDENCE_PLAN = 'the evidence plan this job accepted in its first stage';
// result.json, for a paste job: assembled by this app out of the frozen state
// above and never written by a responder. It is its own subject because
// reporting a value READ OUT OF IT as held in the input record asserts a
// location instead of stating one — the input record is intact, and a reader
// told to look there finds the value it names reading correctly.
export const FROZEN_COMPLETED_PACKAGE = 'the completed application package this job already assembled';
const FROZEN_IDENTITY = 'the candidate identity this job froze';
// Exported: the completion gate, the status poll and the import path all
// re-read this same record, and a fault about it must name the same subject
// wherever it is observed.
export const FROZEN_JOB_RECORD = "this job's own input record";
// The mutable half of the same record: the stage, the handoff code, the
// accepted plan, the recorded fault. This module never reads it, but it is
// named here with the others so a fault about it reads in the same voice
// wherever it is observed.
export const FROZEN_JOB_MANIFEST = "this job's own manifest";
const FROZEN_PASTE_RECORD = "this job's own stored paste record";

/**
 * Grade the candidate identity this job froze against the frozen corpus.
 *
 * Exported for the same reason assertFrozenEvidencePlan is. This value is
 * written when the first stage's response is accepted and no later stage
 * replaces it, yet every surface after that grades a RESPONSE against it: the
 * cover-letter stage refuses a letter whose envelope does not repeat it
 * exactly, and this module's own letter check does it again at completion. A
 * malformed frozen identity therefore reads as a defect in whichever document
 * happened to be graded next, which asks a responder to rewrite a document
 * over a value it never supplied. One reader, every surface, one verdict.
 *
 * The shape asserted is the one normalizedCoverLetter and the renderer both
 * already require, so this changes WHICH failure is raised, never whether one
 * is.
 */
export function assertFrozenTrustedIdentity(trustedIdentity, frozenCareerData, { authority = null } = {}) {
  frozenState(FROZEN_IDENTITY, () => {
    const trusted = record(trustedIdentity, 'trusted candidate identity');
    text(trusted.name, 'trusted candidate identity name');
    if (!Array.isArray(trusted.contact)) fail('trusted candidate identity contact must be a list.');
    trusted.contact.forEach((value, index) => text(value, `trusted candidate identity contact[${index}]`));
    if (authority) {
      const expected = projectTrustedIdentity(authority.identity);
      if (JSON.stringify(trustedIdentity) !== JSON.stringify(expected)) fail('trusted candidate identity does not exactly match pinned career authority identity.');
    } else assertTrustedIdentity(trustedIdentity, frozenCareerData, 'trusted candidate identity');
  });
}

/**
 * Grade the frozen evidence plan against the two frozen sources it quotes.
 *
 * Exported and re-run wherever a completed package is graded — not only here.
 * The submit path reaches this through the assembly; the status poll and the
 * import path never assemble anything, because the package is already built,
 * so the first gate either of them reached that noticed a broken plan quote
 * was the source-grounding arm of the result validator, which calls the same
 * corruption a repairable document defect and mints another review round for
 * it. Two human handoffs were spent that way before the next pass re-ran the
 * assembly and ended the job on the fault the submit surface raises two
 * handoffs earlier. The plan is frozen state at all three surfaces, so all
 * three ask this one function.
 */
export function assertFrozenEvidencePlan(evidencePlan, careerData, jobListing, { authority = null, authorityListingReceiptValidated = false } = {}) {
  return frozenState(FROZEN_EVIDENCE_PLAN, () => evidenceCatalog(evidencePlan, careerData, jobListing, authority, authorityListingReceiptValidated));
}

function evidenceCatalog(evidencePlan, careerData, jobListing, authority = null, authorityListingReceiptValidated = false) {
  if (authorityListingReceiptValidated && !authority) fail('authorityListingReceiptValidated requires a pinned career authority.');
  const plan = record(evidencePlan, 'evidencePlan');
  if (!Array.isArray(plan.evidence) || !plan.evidence.length) fail('evidencePlan.evidence must be nonempty.');
  const occursInCareerData = frozenSourceQuoteTest(careerData);
  const occursInJobListing = frozenSourceQuoteTest(jobListing);
  const result = new Map();
  for (const item of plan.evidence) {
    const evidence = record(item, 'evidencePlan item');
    const id = text(evidence.id, 'evidencePlan item id');
    if (result.has(id)) fail(`evidencePlan repeats ID "${id}".`);
    if (!['career-data', 'job-listing'].includes(evidence.sourceId)) fail(`evidence ${id} has an invalid sourceId.`);
    const quote = sourceQuote(evidence.quote, `evidence ${id} quote`);
    if (evidence.sourceId === 'career-data' && authority) {
      // Authority quotes are byte-exact catalog values. sourceQuote() above
      // validates shape/limits, but its display-oriented trim must not turn a
      // legitimate terminal space in a canonical projection row into a new
      // quote before this exact comparison.
      frozenState(FROZEN_EVIDENCE_PLAN, () => resolveAuthorityEvidence(authority, id, evidence.quote));
    } else if (!(authorityListingReceiptValidated && evidence.sourceId === 'job-listing')) {
      const occursInSource = evidence.sourceId === 'career-data' ? occursInCareerData : occursInJobListing;
      assertFrozenPlanQuoteOccursIn(occursInSource, quote, `evidence ${id} quote no longer occurs in its frozen ${evidence.sourceId} source.`);
    }
    result.set(id, { id, sourceId: evidence.sourceId, quote: evidence.sourceId === 'career-data' && authority ? evidence.quote : quote });
  }
  return result;
}

// Two different fields are graded by this one check: the résumé's own identity
// block, which a replacement résumé carries again, and the identity the job
// froze, which no response supplies. The label travels so the observation names
// the field that was actually read — reporting the app's frozen identity as
// "resume identity" described the wrong value to whoever has to act on it.
function assertTrustedIdentity(identity, careerData, label = 'resume identity') {
  const candidate = record(identity, `${label} record`);
  const values = [candidate.name, ...(Array.isArray(candidate.contact) ? candidate.contact : []), candidate.subtitleRole, candidate.credential]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.replace(/\s+/g, ' ').trim());
  if (!values.length) fail(`${label} has no verifiable values.`);
  for (const value of values) {
    if (!normalizedSourceIncludes(careerData, value)) fail(`${label} value "${value}" is absent from frozen career data.`);
  }
}

function normalizedCoverLetter(raw, trustedIdentity = null) {
  const letter = record(raw, 'coverLetter');
  if (!Array.isArray(letter.paragraphs) || !letter.paragraphs.length) fail('coverLetter.paragraphs must be nonempty.');
  const ids = new Set();
  const paragraphs = letter.paragraphs.map((paragraph, index) => {
    const id = text(paragraph?.id, `coverLetter.paragraphs[${index}].id`);
    if (ids.has(id)) fail(`coverLetter repeats paragraph ID "${id}".`);
    ids.add(id);
    if (!Array.isArray(paragraph?.evidenceIds) || !paragraph.evidenceIds.length) fail(`coverLetter paragraph ${id} needs evidence IDs.`);
    return { id, text: text(paragraph?.text, `coverLetter.paragraphs[${index}].text`), evidenceIds: paragraph.evidenceIds };
  });
  const name = typeof letter.name === 'string' ? text(letter.name, 'coverLetter.name') : '';
  // Projected on both sides of the comparison below and in what renders. The
  // frozen identity is already projected, so a responder that repeated it
  // matches unchanged; one that carried an application-logistics value anyway
  // is not failed here for something the letterhead was never going to show.
  const contact = projectContactChannels(Array.isArray(letter.contact)
    ? letter.contact.map((value, index) => text(value, `coverLetter.contact[${index}]`))
    : []);
  if (trustedIdentity) {
    // Reading the frozen identity and comparing the letter against it are two
    // different questions. The letter answers the comparison by changing its
    // envelope; it can do nothing about a frozen identity that is malformed,
    // so that half is graded as frozen state even though the enclosing call
    // is attributed to the letter.
    const { trustedName, trustedContact } = frozenState(FROZEN_IDENTITY, () => {
      const trusted = record(trustedIdentity, 'trustedIdentity');
      return {
        trustedName: text(trusted.name, 'trustedIdentity.name'),
        trustedContact: Array.isArray(trusted.contact)
          ? projectContactChannels(trusted.contact.map((value, index) => text(value, `trustedIdentity.contact[${index}]`)))
          : fail('trustedIdentity.contact must be an array.'),
      };
    });
    if (name !== trustedName) fail('coverLetter.name must exactly match the trusted candidate identity.');
    if (contact.length !== trustedContact.length || contact.some((value, index) => value !== trustedContact[index])) {
      fail('coverLetter.contact must exactly match the trusted candidate identity.');
    }
  }
  return {
    name,
    contact,
    salutation: typeof letter.salutation === 'string' ? letter.salutation : '',
    recipient: typeof letter.recipient === 'string' ? letter.recipient : '',
    closing: typeof letter.closing === 'string' ? letter.closing : '',
    signatureTitle: typeof letter.signatureTitle === 'string' ? letter.signatureTitle : '',
    paragraphs,
  };
}

function assertAuditBindsFinalParagraphs(audit, paragraphs) {
  // Every route back from a binding defect passes through the audit: a wrong
  // binding is corrected there, and rewriting the paragraph it names changes
  // it too, because the audit repeats that paragraph's exact text.
  const plan = record(audit?.coverLetterPlan, 'generationAudit.coverLetterPlan', ['generationAudit']);
  if (!Array.isArray(plan.paragraphs) || plan.paragraphs.length !== paragraphs.length) {
    fail('generationAudit.coverLetterPlan must bind every final cover-letter paragraph exactly once.', ['generationAudit']);
  }
  for (const [index, entry] of plan.paragraphs.entries()) {
    // text() still runs: it is what rejects an unsafe control character in a
    // field that is about to be copied into the durable audit. Only the
    // comparison moved onto the shared helper.
    const bound = text(entry?.paragraph, `generationAudit.coverLetterPlan.paragraphs[${index}].paragraph`);
    if (!boundDocumentTextMatches(bound, paragraphs[index].text)) {
      fail(`generationAudit paragraph ${index + 1} does not repeat the final cover-letter paragraph it binds.`, ['generationAudit']);
    }
  }
}

/**
 * Create the legacy structured result. The caller MUST subsequently run
 * validateLocalApplicationResult, which performs the full deterministic prose,
 * argument, audit, and PDF pipeline checks.
 */
export function assemblePasteApplicationResult({
  input,
  paste,
  careerData,
  jobListing,
  authority = null,
  // Current-authority requirements are checked quote-by-quote against the
  // immutable bounded listing pages before their receipt can advance.  Final
  // assembly must not concatenate those pages merely to repeat that check.
  // This opt-in is accepted only alongside a pinned authority; callers use it
  // only after their current-authority store validator has checked the exact
  // receipt root and every page.
  authorityListingReceiptValidated = false,
  outputBundleRoot = DEFAULT_OUTPUT_BUNDLE_ROOT,
} = {}) {
  const jobInput = frozenState(FROZEN_JOB_RECORD, () => record(input, 'input'));
  const state = frozenState(FROZEN_PASTE_RECORD, () => record(paste, 'paste'));
  // Preserve source whitespace for exact evidence quote membership. Display
  // fields are normalized separately by their own validators.
  const frozenCareerData = authority ? String(careerData || '') : gradeFrozenSource(careerData, 'careerData', FROZEN_CAREER_DATA);
  if (authorityListingReceiptValidated && !authority) {
    frozenState(FROZEN_JOB_RECORD, () => { throw new Error('authorityListingReceiptValidated requires a pinned career authority.'); });
  }
  const frozenJobListing = authorityListingReceiptValidated
    ? '[current-authority listing validated in immutable paged receipt]'
    : gradeFrozenSource(jobListing, 'jobListing', FROZEN_JOB_LISTING);
  // The accepted résumé, which a review answers by returning a replacement.
  const resume = withRepairs(['resume:authored'], () => record(state.resume, 'paste.resume'));
  const sourceRoles = frozenState(FROZEN_JOB_RECORD, () => {
    if (!Array.isArray(jobInput.sourceRoles)) fail('input.sourceRoles must be a trusted role list.');
    // Graded here as well as inside the renderer, because the renderer reaches
    // this list through a résumé: a malformed frozen role reported there reads
    // as a résumé defect and asks for a document change that cannot reach it.
    assertTrustedSourceRoles(jobInput.sourceRoles);
    return jobInput.sourceRoles;
  });
  // A backend-projected identity prevents an AI from choosing which contact
  // fragments to expose, and this is where that projection is applied: the row
  // is narrowed to values that are ways to reach the candidate. Exact
  // career-data membership still rejects arbitrary values on top of it.
  const trustedIdentity = authority
    ? projectTrustedIdentity(authority.identity)
    : projectTrustedIdentity(jobInput.trustedIdentity ?? state.trustedIdentity ?? null);
  // Graded here, before the renderer and the letter envelope grade it again,
  // because both of those reach it through a document and would report a
  // malformed frozen identity as that document's defect. The same call runs at
  // every earlier stage through the host's frozen-state gate, so reaching this
  // line means it has already passed once.
  if (trustedIdentity != null) assertFrozenTrustedIdentity(trustedIdentity, frozenCareerData, { authority });
  // The résumé's own identity block renders, and a replacement résumé carries
  // it again, so a defect here is repaired in that document. The separately
  // asserted trustedIdentity above is app-projected: no response can repair it,
  // and it is raised as a job-integrity fault so it does not claim otherwise.
  withRepairs(['resume:authored'], () => {
    if (authority) {
      if (JSON.stringify(projectTrustedIdentity(resume.identity)) !== JSON.stringify(trustedIdentity)) fail('resume identity does not exactly match pinned career authority identity.');
    } else assertTrustedIdentity(resume.identity, frozenCareerData);
  });

  const evidenceById = assertFrozenEvidencePlan(state.evidencePlan, frozenCareerData, frozenJobListing, { authority, authorityListingReceiptValidated });
  const renderedEvidenceIds = new Set([
    ...(resume.roles || []).flatMap(role => (role.bullets || []).flatMap(bullet => bullet.evidenceIds || [])),
    ...(resume.projects || []).flatMap(project => project.evidenceIds || []),
    ...(resume.education || []).flatMap(item => item.evidenceIds || []),
    ...(resume.credentials || []).flatMap(item => item.evidenceIds || []),
    ...(resume.skills || []).flatMap(group => group.evidenceIds || []),
  ]);
  const renderEvidenceById = authority
    ? new Map([...evidenceById].filter(([id]) => renderedEvidenceIds.has(id)))
    : evidenceById;
  const renderCareerData = authority ? authorityRenderCareerData(authority, sourceRoles, renderEvidenceById) : frozenCareerData;
  const rendered = withRepairs(['resume:authored'], () => renderStructuredResume(resume, {
    sourceRoles,
    evidenceCatalog: [...evidenceById.values()],
    careerData: renderCareerData,
    careerSkillEvidence: jobInput.careerSkillEvidence ?? null,
    authorityMode: Boolean(authority),
    ...(trustedIdentity != null ? { trustedIdentity } : {}),
  }));
  // The letter's envelope and its paragraph evidence citations: a defect in
  // either is repaired by replacing the letter, whether the repair moves its
  // rendered text or only which evidence a paragraph cites.
  const letter = withRepairs(['coverLetter:authored'], () => normalizedCoverLetter(state.coverLetter, trustedIdentity));
  // The only check in this module that still takes the host's unattributed
  // default, and honestly: paste.finalReview IS the response this round
  // returned, whole, so "return a different response" is exactly the repair.
  const finalReview = record(state.finalReview, 'paste.finalReview');
  const semanticQualityReview = record(finalReview.qualityReview, 'paste.finalReview.qualityReview', ['qualityReview']);

  // Which evidence each rendered part cites is a property of the document that
  // cites it, and citing different evidence is one of the two ways either
  // document is repaired.
  const occursInCareerData = authority
    ? quote => {
      try { return [...evidenceById.values()].some(item => item.sourceId === 'career-data' && item.quote === quote && Boolean(resolveAuthorityEvidence(authority, item.id, quote))); }
      catch { return false; }
    }
    : frozenSourceQuoteTest(frozenCareerData);
  const resumeBullets = withRepairs(['resume:authored'], () => rendered.draft.roles.flatMap(role => role.bullets.map(bullet => ({
    bullet: bullet.text,
    careerDataQuotes: careerQuotesForIds(bullet.evidenceIds, evidenceById, occursInCareerData, `résumé bullet ${bullet.id}`),
  }))));
  const coverLetterParagraphs = withRepairs(['coverLetter:authored'], () => letter.paragraphs.map(paragraph => ({
    paragraph: paragraph.text,
    careerDataQuotes: careerQuotesForIds(paragraph.evidenceIds, evidenceById, occursInCareerData, `cover-letter paragraph ${paragraph.id}`),
  })));
  // Preserve the model's canonical checklist notes verbatim. Host code only
  // projects exact source bindings from accepted evidence identifiers.
  const qualityReview = {
    ...deepClone(semanticQualityReview),
    // The paste sequence has completed editorial review before its first
    // legacy import. The existing measured-fit pipeline still needs to know
    // this is its initial rendering snapshot; later fit revisions are stamped
    // by that host-owned lifecycle, without changing model rationales/notes.
    resume: { ...deepClone(semanticQualityReview.resume), decision: 'drafted' },
    coverLetter: { ...deepClone(semanticQualityReview.coverLetter), decision: 'drafted' },
    sourceGrounding: { resumeBullets, coverLetterParagraphs },
  };

  const suppliedArgument = record(state.coverLetter.coverLetterArgument, 'coverLetter.coverLetterArgument', ['coverLetter:authored']);
  const coverLetterArgument = {
    ...deepClone(suppliedArgument),
    roleThesis: state.coverLetter.roleThesis || state.coverLetter.controllingThesis || suppliedArgument.roleThesis,
  };
  const generationAudit = finalReview.generationAudit || state.coverLetter.generationAudit;
  if (!generationAudit) fail('final review must retain a current generationAudit with exact paragraph and sentence bindings.', ['generationAudit']);
  // The two explicit failures inside already name the audit; the shape checks
  // on a bound paragraph — empty text, an unsafe control character in a field
  // about to be copied into the durable audit — are repaired in the same field
  // and were reaching the host with no repair at all.
  withRepairs(['generationAudit'], () => assertAuditBindsFinalParagraphs(generationAudit, letter.paragraphs));

  return {
    version: Number(jobInput.version || 1),
    jobId: frozenState(FROZEN_JOB_RECORD, () => text(jobInput.jobId, 'input.jobId')),
    status: 'completed',
    // App selected; never sourced from the paste response.
    outputBundleRoot,
    resumeMainHtml: rendered.resumeMainHtml,
    coverLetter: {
      ...letter,
      paragraphs: letter.paragraphs.map(paragraph => paragraph.text),
    },
    coverLetterArgument,
    qualityReview,
    generationAudit: deepClone(generationAudit),
  };
}
