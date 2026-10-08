/**
 * Deterministic patch/merge engine for SCOPED REVIEW ROUNDS of a Local AI
 * paste-handoff application.
 *
 * MEASURED DEFECT this exists to fix (see the job that motivated it,
 * eeb6303c-1c62-4819-97ae-544d8e62fdbd): an ACCEPTED review response of
 * 24,147 bytes contained NO documents at all — generationAudit 9,916 bytes
 * (coverLetterPlan alone re-quotes every letter paragraph and every sentence
 * verbatim), qualityReview 5,669 bytes (24 criteria x measured evidence),
 * checklist 5,008 bytes (24 entries x detail). A REVISION round adds the two
 * documents (~5,100 bytes) for ~29.8k total, so the documents are ~23% of a
 * revision and the bookkeeping — retyped verbatim every round — is ~77%. The
 * host already holds the accepted prior review in state.reviewBaseline.review
 * (see THE BASELINE below); this module lets a round send only what changed
 * and reconstructs the rest.
 *
 * Both documents this overlays are already fully addressable, so no
 * addressing scheme needed inventing:
 *   - resume is structured-resume.v1 JSON: roles[].id, roles[].bullets[].id,
 *     projects[].id, skills[].id (electron/ipc/structuredResume.js, ID_RE and
 *     normalizeRole).
 *   - cover letter: paragraphs[].id, plus roleThesis and
 *     coverLetterArgument.<dotted path> field paths.
 *
 * THE BASELINE CAN GO STALE — THE SECOND MEASURED DEFECT (2026-09-22
 * adversarial review; reproduced end to end in
 * scripts/tests/paste-application-fit-save.js, "THE STALE BASELINE"). The
 * original version of this module keyed carry-forward on
 * manifest.paste.finalReview, which localAiApplication.js's
 * submitLocalApplicationHandoff writes on decision:'pass' ONLY (exactly one
 * assignment site). A 'revised' round between two passes can accept fresh,
 * doc-accurate fields — a résumé patch plus a rationale re-authored against
 * the new bullet — and none of it reached finalReview, because the round
 * that carried it was not a pass. A LATER round then measured "did THIS
 * round's own patches touch the résumé", found it false for its own
 * empty-patch pass, demanded nothing, and the merge carried qualityReview
 * .resume forward from finalReview — not the immediately-prior round's fresh
 * rationale, but whatever the LAST PASS said, arbitrarily many rounds back,
 * describing a bullet that no longer existed.
 *
 * The fix gives the baseline its own identity, refreshed on EVERY accepted
 * review round — revised or pass, never pass alone — instead of overloading
 * finalReview to mean two things: state.reviewBaseline = { review,
 * documentHashes }, where `review` is an explicit, fixed-key {decision,
 * findings, checklist, qualityReview, generationAudit} built from that
 * round's own assembled review — never the round's raw response object,
 * whose resume/coverLetter fields (present whenever that round replaced
 * either) land at a different key position depending on whether the round
 * took the full-response path or the delta-reassembly path, which is all a
 * byte-level comparison of two equivalent rounds would see — and
 * `documentHashes` are pasteJsonHash(resume) / pasteJsonHash(coverLetter)
 * for the documents THAT REVIEW WAS AUTHORED AGAINST — the accepted résumé
 * and cover letter as they stood the moment this round was accepted. This
 * module reads
 * `baselineReview` (state.reviewBaseline.review), never finalReview:
 * finalReview keeps its own narrower meaning elsewhere (the accepted PASSING
 * review a rejection is bound to for repeat detection, and the source of the
 * final assembled package) and must not also carry this module's meaning. A
 * job with a finalReview but no reviewBaseline — an in-flight job that
 * reached its first pass before this field existed — degrades safely:
 * localAiApplication.js's isDeltaEligibleRound now tests reviewBaseline, not
 * finalReview, so such a job simply gets no delta round (a full,
 * whole-document round, never a silently-unguarded delta) until an accepted
 * round mints its first baseline.
 *
 * TWO SIGNALS, computed independently and never conflated:
 *   - `changed` (applyPasteDocumentPatches' own return value: what THIS
 *     round's patches touched, measured against the documents at the START
 *     of this round) is fine-grained — which bullet/paragraph/argument-path
 *     ids, whether roleThesis moved. It is what
 *     requiredPasteReviewDeltaEntries uses to scope WHICH checklist and
 *     qualityReview.criteria ids a round should resupply and WHICH
 *     coverLetterPlan.paragraphs position needs a fresh entry — a courtesy,
 *     safe to get wrong (SAFETY ARGUMENT below) because doing so only ever
 *     costs an extra round, never a bad document.
 *   - `staleSinceBaseline` (localAiApplication.js's
 *     pasteReviewBaselineStaleness: state.reviewBaseline.documentHashes —
 *     durable, stored, read fresh every round — compared against the
 *     CURRENT, post-patch documents) answers a different question: does the
 *     résumé/cover letter right now differ from what state.reviewBaseline
 *     .review was AUTHORED against, regardless of which round's patches
 *     caused that. This is measured from data at rest rather than trusted
 *     from one round's own patch list, which is what makes it safe even if
 *     some future accept path forgets to refresh the baseline — the next
 *     round's staleness check still catches the drift instead of assuming it
 *     away. Both requiredPasteReviewDeltaEntries and mergePasteReviewDelta
 *     gate the UNVERIFIABLE FIELDS below on this signal, never on `changed`.
 *   In ordinary operation (every accepted round refreshes the baseline, this
 *   module's own contract now) the two agree; they stay two named parameters
 *   anyway so a future bug in one is never silently laundered through the
 *   other. Collapsing them back into one "changed" for convenience is
 *   exactly how the stale-baseline defect above hid.
 *
 * SAFETY ARGUMENT (do not weaken): carry-forward is safe by CONSTRUCTION, not
 * by trust, for a field a downstream check actually grades against document
 * content. generationAudit.coverLetterPlan.controllingThesis must equal
 * coverLetterArgument.roleThesis; .paragraphs[].paragraph must equal the final
 * paragraph text; .sentences[] must match the host's own sentence split of
 * that text; argumentMapping spans are graded as exact spans of the paragraph
 * by checkParagraphArgumentLinks. A carried-forward entry among THESE that a
 * patch actually invalidated is still caught, by name, once the merged review
 * this module produces is graded against the real, current documents — the
 * same validator that grades a full resend grades a merged one exactly the
 * same way. requiredPasteReviewDeltaEntries's `changed`-scoped fields
 * (checklistIds, criterionIds, auditParagraphIndexes) exist only to spend a
 * round of the user's time less often — asking for an entry before the
 * expensive validation battery runs, instead of after — never as the thing
 * that makes a merged review sound. checklist needs no such backstop at all:
 * pasteApplicationAssembly.js never reads finalReview.checklist, so a stale
 * entry there cannot reach the shipped result by any path.
 *
 * PRINCIPLE — the rule a field is judged by, including one added later:
 *   A field the host CAN re-verify against the documents may be carried
 *   forward, because a stale carry-forward is caught after merge (the SAFETY
 *   ARGUMENT above), or is simply never read again (checklist).
 *   A field the host CANNOT re-verify is never carried across a change to the
 *   document it describes.
 *   "Changed", for this purpose, is staleSinceBaseline — measured against the
 *   document state state.reviewBaseline.review was AUTHORED against — never
 *   against one round's own patch list (TWO SIGNALS above).
 *
 * THE UNVERIFIABLE SET — confirmed by checking, for every field
 * mergePasteReviewDelta can carry forward, whether any post-merge validator
 * grades it against document content. None of these six do; each is graded
 * only for shape, a length floor, or internal consistency with the
 * (immutable) evidence plan:
 *   - qualityReview.resume / qualityReview.coverLetter — documentReview()
 *     (localAiApplication.js) grades the rationale for length and a
 *     page-fit-only heuristic, never against the résumé or letter it
 *     attests to.
 *   - generationAudit.resumePlan — cleanGenerationAuditText floors only.
 *   - generationAudit.jobPriorities — generationAuditPlanCoverageFailures
 *     grades coverage, duplication, and priority against the IMMUTABLE
 *     evidence plan; it never compares a disposition like 'addressed-resume'
 *     against the document that round actually produced, so a requirement
 *     whose only supporting bullet was just deleted keeps a stale
 *     'addressed-resume' disposition undetected. Unlike the other fields
 *     here, a disposition cannot be scoped to "its own" document — either
 *     document can address any requirement — so it cannot be merged
 *     per-requirement at all once stale: mergePasteReviewDelta resupplies it
 *     WHOLE from the delta or refuses it whole, never interleaved with the
 *     baseline (see its own merge site below).
 *   - generationAudit.finalDecisionSummary — a length floor only, and no
 *     needs* field even existed to ask for it before this fix.
 *   - qualityReview.criteria (a SIXTH, found while confirming the other five
 *     rather than named by the review round that ordered this fix — reported
 *     as instructed). sanitizeApplicationQualityCriteria grades each entry's
 *     evidence for length, uniqueness, and boilerplate overlap only — never
 *     against the document the criterion's own `document` field scopes it
 *     to. Unlike checklist (never read again downstream), qualityReview
 *     .criteria DOES ship in the assembled result. Its `changed`-scoped
 *     required-list (criterionIds) stays courtesy-only and patch-level, same
 *     as checklist, per the TWO SIGNALS split above — but mergePasteReviewDelta
 *     additionally refuses a stale, unsupplied entry outright
 *     (mergeGradedCriteria below), a BACKSTOP independent of that courtesy
 *     list, the same way the other five are refused.
 * Every field above is refused as a carry-forward by mergePasteReviewDelta
 * once staleSinceBaseline says the document it describes changed (fail
 * closed; the error names the field and why) — see each field's own comment
 * at its merge site below.
 *
 * WIRED IN at the review stage only (Task B2): pastePrompt prints the patch
 * envelope and the required-entries list this module computes, and
 * submitLocalApplicationHandoff applies a response's patches, checks its
 * required entries, and merges it onto state.reviewBaseline.review — all
 * BEFORE the assembled result reaches the existing validatePasteResponse and
 * every other gate a full resend already passes through unchanged. See
 * localAiApplication.js's submitLocalApplicationHandoff for the call sites.
 */
import { STRUCTURED_RESUME_ID_PATTERN } from './structuredResume.js';

// The same stable-id shape structuredResume.js's ID_RE enforces and
// localAiApplication.js's PASTE_STABLE_ID_RE restates for every other paste
// identifier. Deriving the RegExp from the exported pattern STRING (rather
// than a second hand-typed literal) is what stops this module's own id check
// from drifting out of step with the one downstream actually applies.
const STABLE_ID_RE = new RegExp(STRUCTURED_RESUME_ID_PATTERN);

// Exported so the review-stage prompt interpolates the engine's own op
// vocabulary instead of hand-typing a second list that could name an op this
// module does not implement.
export const VALID_OPS = Object.freeze(['replace', 'insert-after', 'remove']);
const VALID_OPS_SET = new Set(VALID_OPS);
// roleThesis and a coverLetterArgument field are single scalar values, not
// entries in a collection: there is no "position" for insert-after to name
// and no array slot for remove to empty, so only replace applies to them.
const SCALAR_KINDS = new Set(['roleThesis', 'argument']);

// The closed set of coverLetterArgument leaf fields a delta may replace.
// secondaryEvidence is optional, so a path under it resolves only when the
// accepted letter already carries a secondaryEvidence block — a delta cannot
// introduce that block's shape (narrativeRole's enum, all four sibling
// fields together) through a single scalar replace, so it is left to a full
// document replacement instead, the same as any other structural change.
const ARGUMENT_PATHS = Object.freeze([
  'primaryEvidence.evidence', 'primaryEvidence.evidenceRole', 'primaryEvidence.relationToThesis',
  'secondaryEvidence.evidence', 'secondaryEvidence.evidenceRole',
  'secondaryEvidence.narrativeRole', 'secondaryEvidence.relationToPrimary',
]);
const ARGUMENT_PATHS_SET = new Set(ARGUMENT_PATHS);

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function emptyChanged() {
  return {
    resume: false, coverLetter: false,
    changedBulletIds: [], changedRoleIds: [], changedParagraphIds: [], changedArgumentPaths: [],
    roleThesisChanged: false,
  };
}

// --- target parsing -------------------------------------------------------

function parseTarget(target) {
  if (typeof target !== 'string' || !target) return null;
  if (target === 'coverLetter:roleThesis') return { doc: 'coverLetter', kind: 'roleThesis' };
  let match = /^resume:(bullet|role|project|skill):(.+)$/.exec(target);
  if (match) return { doc: 'resume', kind: match[1], id: match[2] };
  match = /^coverLetter:paragraph:(.+)$/.exec(target);
  if (match) return { doc: 'coverLetter', kind: 'paragraph', id: match[1] };
  match = /^coverLetter:argument:(.+)$/.exec(target);
  if (match) return { doc: 'coverLetter', kind: 'argument', path: match[1] };
  return null;
}

// Exported for the same reason as VALID_OPS above: the review-stage prompt
// states this exact rule rather than a hand-kept paraphrase of it.
export const TARGET_FORMS_RULE = 'resume:bullet:<id>, resume:role:<id>, resume:project:<id>, resume:skill:<id>, '
  + 'coverLetter:paragraph:<id>, coverLetter:roleThesis, or coverLetter:argument:<field under coverLetterArgument>';

// --- per-unit shape validation ---------------------------------------------
// Each of these checks only the STRUCTURAL shape a downstream validator would
// reject outright (missing required field, wrong type, empty required
// array). None of them re-implements a downstream BUSINESS rule (evidence
// grounding, term overlap, the narrativeRole enum, career-data provenance) —
// those already have a validator, this module's shape checks exist only to
// return a fast, attributable error before the expensive battery runs, and
// the safety argument above is what makes skipping them here harmless.

function idShapeErrors(value, label) {
  if (!isNonEmptyString(value)) return [`${label} must be a nonempty id.`];
  if (!STABLE_ID_RE.test(value.trim())) {
    return [`${label} must match ${STRUCTURED_RESUME_ID_PATTERN} (start with a letter or digit; letters, digits, "_", ".", ":", "-" only; 120 characters max).`];
  }
  return [];
}

function evidenceIdsErrors(value, label) {
  if (!isStringArray(value)) return [`${label} must be a nonempty array of evidence id strings.`];
  if (!hasUniqueValues(value)) return [`${label} must not repeat an evidence id.`];
  return [];
}

function bulletContentErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with text and evidenceIds.`];
  const errors = [];
  if (!isNonEmptyString(value.text)) errors.push(`${label}.text must be nonempty text.`);
  errors.push(...evidenceIdsErrors(value.evidenceIds, `${label}.evidenceIds`));
  return errors;
}

// Shared by both role shapes: title/company/dates/location, the fields a
// role carries beside its bullets and its (separately checked) id.
function roleFieldErrors(value, label) {
  const errors = [];
  if (!isNonEmptyString(value.title)) errors.push(`${label}.title must be nonempty text.`);
  for (const field of ['company', 'dates', 'location']) {
    if (value[field] != null && typeof value[field] !== 'string') errors.push(`${label}.${field} must be text.`);
  }
  return errors;
}

function roleMetadataErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with title, company, dates, location.`];
  const errors = roleFieldErrors(value, label);
  // A role's bullets have their own target kind (resume:bullet:<id>).
  // Accepting them here too would give one round two ways to change the same
  // bullet, with no rule for which one wins — so a role-metadata replace
  // simply cannot carry bullets, and the shape error says why.
  if (Object.prototype.hasOwnProperty.call(value, 'bullets')) {
    errors.push(`${label} must not carry bullets; edit a role's bullets through resume:bullet:<id> targets instead.`);
  }
  return errors;
}

function roleUnitErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with id, title, company, dates, location, bullets.`];
  const errors = [
    ...idShapeErrors(value.id, `${label}.id`),
    ...roleFieldErrors(value, label),
  ];
  if (!Array.isArray(value.bullets) || !value.bullets.length) {
    errors.push(`${label}.bullets must be a nonempty array.`);
  } else {
    value.bullets.forEach((bullet, index) => {
      errors.push(...idShapeErrors(bullet?.id, `${label}.bullets[${index}].id`));
      errors.push(...bulletContentErrors(bullet, `${label}.bullets[${index}]`));
    });
    const ids = value.bullets.map(bullet => bullet?.id).filter(isNonEmptyString);
    if (ids.length === value.bullets.length && !hasUniqueValues(ids)) {
      errors.push(`${label}.bullets must use unique ids.`);
    }
  }
  return errors;
}

function projectContentErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with name and evidenceIds.`];
  const errors = [];
  if (!isNonEmptyString(value.name)) errors.push(`${label}.name must be nonempty text.`);
  for (const field of ['description', 'metrics']) {
    if (value[field] != null && typeof value[field] !== 'string') errors.push(`${label}.${field} must be text.`);
  }
  errors.push(...evidenceIdsErrors(value.evidenceIds, `${label}.evidenceIds`));
  return errors;
}

function skillContentErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with group, items, and evidenceIds.`];
  const errors = [];
  if (!isNonEmptyString(value.group)) errors.push(`${label}.group must be nonempty text.`);
  if (!isStringArray(value.items)) errors.push(`${label}.items must be a nonempty array of item strings.`);
  else if (!hasUniqueValues(value.items)) errors.push(`${label}.items must not repeat a value.`);
  errors.push(...evidenceIdsErrors(value.evidenceIds, `${label}.evidenceIds`));
  return errors;
}

function paragraphContentErrors(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${label} must be an object with text and evidenceIds.`];
  const errors = [];
  if (!isNonEmptyString(value.text)) errors.push(`${label}.text must be nonempty text.`);
  errors.push(...evidenceIdsErrors(value.evidenceIds, `${label}.evidenceIds`));
  return errors;
}

// --- document indexing -----------------------------------------------------

function collectResumeIds(resume) {
  const ids = new Set();
  for (const role of resume?.roles || []) {
    ids.add(role.id);
    for (const bullet of role.bullets || []) ids.add(bullet.id);
  }
  for (const project of resume?.projects || []) ids.add(project.id);
  for (const skill of resume?.skills || []) ids.add(skill.id);
  return ids;
}

function findBullet(resume, id) {
  const roles = resume?.roles || [];
  for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
    const bullets = roles[roleIndex].bullets || [];
    const bulletIndex = bullets.findIndex(bullet => bullet.id === id);
    if (bulletIndex !== -1) return { roleIndex, bulletIndex };
  }
  return null;
}

function findByIdIndex(list, id) {
  const index = (list || []).findIndex(item => item.id === id);
  return index === -1 ? -1 : index;
}

// --- validation + resolution ------------------------------------------------
// Every patch is resolved against a FIXED snapshot of the documents as they
// stood before this round's patches — never against a copy other patches in
// the same round have already mutated. That is what makes the result
// independent of the order the caller happened to list patches in: each
// patch's target is anchored to something that either exists in the
// original documents or does not, regardless of what any sibling patch does.

function resolvePatches(patches, resumeSnapshot, coverLetterSnapshot) {
  const errors = [];
  if (!Array.isArray(patches)) {
    return { errors: ['patches must be an array of {op, target, value} objects.'], resolved: [] };
  }

  const seenTargets = new Set();
  const parsed = [];
  patches.forEach((patch, index) => {
    const label = `patches[${index}]`;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      errors.push(`${label} must be an object with op and target.`);
      return;
    }
    const { op, target, value } = patch;
    if (!VALID_OPS_SET.has(op)) {
      errors.push(`${label} has an unknown op ${JSON.stringify(op ?? null)}; valid ops are ${VALID_OPS.join(', ')}.`);
      return;
    }
    if (typeof target !== 'string' || !target) {
      errors.push(`${label} must name a target string; valid target forms are ${TARGET_FORMS_RULE}.`);
      return;
    }
    const info = parseTarget(target);
    if (!info) {
      errors.push(`${label} names an unknown target ${JSON.stringify(target)}; valid target forms are ${TARGET_FORMS_RULE}.`);
      return;
    }
    // "Reject two patches touching one target rather than letting order
    // decide": identity is the target STRING alone, regardless of op, so a
    // replace and an insert-after both naming resume:bullet:X in one round
    // are rejected together rather than silently ordered against each other.
    if (seenTargets.has(target)) {
      errors.push(`${label} repeats target ${JSON.stringify(target)}; a round may patch a given target at most once.`);
      return;
    }
    seenTargets.add(target);
    parsed.push({ index, op, target, value, info });
  });

  const resumeIds = collectResumeIds(resumeSnapshot);
  const paragraphIds = new Set((coverLetterSnapshot?.paragraphs || []).map(paragraph => paragraph.id));
  // New ids reserved by an insert-after already validated earlier in this
  // same pass, so two inserts in one round cannot both mint the same id.
  const reservedResumeIds = new Set();
  const reservedParagraphIds = new Set();

  const resolved = [];
  for (const patch of parsed) {
    const label = `patches[${patch.index}]`;
    const { op, target, info } = patch;
    // Cloned once here, so every `resolved` entry below owns its own copy —
    // a nested array like evidenceIds is never a reference back into the
    // caller's own `patches` argument, which is what PURE actually requires:
    // a caller that mutates its patches array after this call must not be
    // able to reach back into the résumé/letter this function already
    // returned.
    const value = clone(patch.value);
    if (SCALAR_KINDS.has(info.kind)) {
      if (op !== 'replace') {
        errors.push(`${label} uses op "${op}" on target ${JSON.stringify(target)}; only "replace" applies to a scalar field, because there is no position for insert-after to name and no array slot for remove to empty.`);
        continue;
      }
      if (info.kind === 'roleThesis') {
        if (!isNonEmptyString(value)) { errors.push(`${label} value must be nonempty text for coverLetter:roleThesis.`); continue; }
        resolved.push({ kind: 'roleThesis', value });
        continue;
      }
      // argument
      if (!ARGUMENT_PATHS_SET.has(info.path)) {
        errors.push(`${label} names an unknown coverLetterArgument field "${info.path}"; valid fields are ${ARGUMENT_PATHS.join(', ')}.`);
        continue;
      }
      const [group] = info.path.split('.');
      if (!coverLetterSnapshot?.coverLetterArgument?.[group]) {
        errors.push(`${label} targets coverLetterArgument.${info.path}, but the accepted letter has no coverLetterArgument.${group} block to edit; a delta cannot introduce that block, only replace a field already in it.`);
        continue;
      }
      if (!isNonEmptyString(value)) { errors.push(`${label} value must be nonempty text for coverLetter:argument:${info.path}.`); continue; }
      resolved.push({ kind: 'argument', path: info.path, value });
      continue;
    }

    if (info.doc === 'resume') {
      if (info.kind === 'role') {
        const roleIndex = findByIdIndex(resumeSnapshot?.roles, info.id);
        if (roleIndex === -1) { errors.push(`${label} names unknown target id "${info.id}"; no resume role has that id.`); continue; }
        if (op === 'replace') {
          const shapeErrors = roleMetadataErrors(value, `${label} value`);
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          resolved.push({ kind: 'roleMeta', roleIndex, value });
        } else if (op === 'insert-after') {
          const shapeErrors = roleUnitErrors(value, `${label} value`);
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          const allNewIds = [value.id, ...value.bullets.map(bullet => bullet.id)];
          const duplicate = allNewIds.find(id => resumeIds.has(id) || reservedResumeIds.has(id));
          if (duplicate) { errors.push(`${label} would insert id "${duplicate}", which already identifies another unit in this résumé.`); continue; }
          allNewIds.forEach(id => reservedResumeIds.add(id));
          resolved.push({ kind: 'roleUnit', op: 'insert-after', anchorRoleIndex: roleIndex, value });
        } else {
          resolved.push({ kind: 'roleUnit', op: 'remove', anchorRoleIndex: roleIndex });
        }
        continue;
      }
      if (info.kind === 'bullet') {
        const location = findBullet(resumeSnapshot, info.id);
        if (!location) { errors.push(`${label} names unknown target id "${info.id}"; no résumé bullet has that id.`); continue; }
        if (op === 'replace') {
          const shapeErrors = bulletContentErrors(value, `${label} value`);
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          resolved.push({ kind: 'bullet', op, roleIndex: location.roleIndex, bulletIndex: location.bulletIndex, value });
        } else if (op === 'insert-after') {
          const shapeErrors = [...idShapeErrors(value?.id, `${label} value.id`), ...bulletContentErrors(value, `${label} value`)];
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          if (resumeIds.has(value.id) || reservedResumeIds.has(value.id)) {
            errors.push(`${label} would insert id "${value.id}", which already identifies another unit in this résumé.`);
            continue;
          }
          reservedResumeIds.add(value.id);
          resolved.push({ kind: 'bullet', op, roleIndex: location.roleIndex, bulletIndex: location.bulletIndex, value });
        } else {
          resolved.push({ kind: 'bullet', op, roleIndex: location.roleIndex, bulletIndex: location.bulletIndex });
        }
        continue;
      }
      if (info.kind === 'project') {
        const projectIndex = findByIdIndex(resumeSnapshot?.projects, info.id);
        if (projectIndex === -1) { errors.push(`${label} names unknown target id "${info.id}"; no résumé project has that id.`); continue; }
        if (op === 'replace') {
          const shapeErrors = projectContentErrors(value, `${label} value`);
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          resolved.push({ kind: 'project', op, projectIndex, value });
        } else if (op === 'insert-after') {
          const shapeErrors = [...idShapeErrors(value?.id, `${label} value.id`), ...projectContentErrors(value, `${label} value`)];
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          if (resumeIds.has(value.id) || reservedResumeIds.has(value.id)) {
            errors.push(`${label} would insert id "${value.id}", which already identifies another unit in this résumé.`);
            continue;
          }
          reservedResumeIds.add(value.id);
          resolved.push({ kind: 'project', op, projectIndex, value });
        } else {
          resolved.push({ kind: 'project', op, projectIndex });
        }
        continue;
      }
      if (info.kind === 'skill') {
        const skillIndex = findByIdIndex(resumeSnapshot?.skills, info.id);
        if (skillIndex === -1) { errors.push(`${label} names unknown target id "${info.id}"; no résumé skill group has that id.`); continue; }
        if (op === 'replace') {
          const shapeErrors = skillContentErrors(value, `${label} value`);
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          resolved.push({ kind: 'skill', op, skillIndex, value });
        } else if (op === 'insert-after') {
          const shapeErrors = [...idShapeErrors(value?.id, `${label} value.id`), ...skillContentErrors(value, `${label} value`)];
          if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
          if (resumeIds.has(value.id) || reservedResumeIds.has(value.id)) {
            errors.push(`${label} would insert id "${value.id}", which already identifies another unit in this résumé.`);
            continue;
          }
          reservedResumeIds.add(value.id);
          resolved.push({ kind: 'skill', op, skillIndex, value });
        } else {
          resolved.push({ kind: 'skill', op, skillIndex });
        }
        continue;
      }
    }

    if (info.doc === 'coverLetter' && info.kind === 'paragraph') {
      const paragraphIndex = findByIdIndex(coverLetterSnapshot?.paragraphs, info.id);
      if (paragraphIndex === -1) { errors.push(`${label} names unknown target id "${info.id}"; no cover-letter paragraph has that id.`); continue; }
      if (op === 'replace') {
        const shapeErrors = paragraphContentErrors(value, `${label} value`);
        if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
        resolved.push({ kind: 'paragraph', op, paragraphIndex, value });
      } else if (op === 'insert-after') {
        const shapeErrors = [...idShapeErrors(value?.id, `${label} value.id`), ...paragraphContentErrors(value, `${label} value`)];
        if (shapeErrors.length) { errors.push(...shapeErrors); continue; }
        if (paragraphIds.has(value.id) || reservedParagraphIds.has(value.id)) {
          errors.push(`${label} would insert id "${value.id}", which already identifies another paragraph in this letter.`);
          continue;
        }
        reservedParagraphIds.add(value.id);
        resolved.push({ kind: 'paragraph', op, paragraphIndex, value });
      } else {
        resolved.push({ kind: 'paragraph', op, paragraphIndex });
      }
      continue;
    }
  }

  return { errors, resolved };
}

// --- application -------------------------------------------------------

function applyListOps(originalList, ops, kind) {
  const removals = new Set();
  const replacements = new Map();
  const insertions = new Map();
  for (const entry of ops) {
    const item = originalList[entry[`${kind}Index`]];
    if (entry.op === 'remove') removals.add(item.id);
    else if (entry.op === 'replace') replacements.set(item.id, entry.value);
    else insertions.set(item.id, entry.value);
  }
  const result = [];
  for (const item of originalList) {
    if (removals.has(item.id)) continue;
    result.push(replacements.has(item.id) ? { ...item, ...replacements.get(item.id), id: item.id } : item);
    if (insertions.has(item.id)) result.push({ ...insertions.get(item.id) });
  }
  return result;
}

function applyResolvedPatches(resumeSnapshot, coverLetterSnapshot, resolved) {
  const resume = clone(resumeSnapshot) || {};
  const coverLetter = clone(coverLetterSnapshot) || {};
  const errors = [];

  // Bullets first, grouped by their OWNING role — a role can be removed or
  // inserted-after in the same round as one of its own bullets is edited
  // (different target strings, so not rejected as a duplicate target), and
  // resolving bullets while role indexes still match the snapshot keeps that
  // safe regardless of which the caller listed first.
  const bulletsByRole = new Map();
  for (const entry of resolved) {
    if (entry.kind !== 'bullet') continue;
    if (!bulletsByRole.has(entry.roleIndex)) bulletsByRole.set(entry.roleIndex, []);
    bulletsByRole.get(entry.roleIndex).push(entry);
  }
  const roleMetaByIndex = new Map(resolved.filter(entry => entry.kind === 'roleMeta').map(entry => [entry.roleIndex, entry.value]));

  const roles = (resume.roles || []).map((role, index) => {
    const bullets = bulletsByRole.has(index) ? applyListOps(role.bullets || [], bulletsByRole.get(index), 'bullet') : role.bullets;
    const meta = roleMetaByIndex.get(index);
    return meta ? { ...role, ...meta, id: role.id, bullets } : { ...role, bullets };
  });

  // Whole-role insert-after/remove, applied against the ORIGINAL role array
  // positions (already resolved above) so a bullet edit inside a role being
  // removed is simply discarded along with the rest of that role — the
  // bullet-level replacement above still ran, harmlessly, against a copy
  // that is now dropped.
  const roleUnitOps = resolved.filter(entry => entry.kind === 'roleUnit');
  const removedRoleIndexes = new Set(roleUnitOps.filter(entry => entry.op === 'remove').map(entry => entry.anchorRoleIndex));
  const insertAfterRoleIndex = new Map(roleUnitOps.filter(entry => entry.op === 'insert-after').map(entry => [entry.anchorRoleIndex, entry.value]));
  const finalRoles = [];
  roles.forEach((role, index) => {
    if (!removedRoleIndexes.has(index)) finalRoles.push(role);
    if (insertAfterRoleIndex.has(index)) {
      const newRole = insertAfterRoleIndex.get(index);
      finalRoles.push({ id: newRole.id, title: newRole.title, company: newRole.company || '', dates: newRole.dates || '', location: newRole.location || '', bullets: newRole.bullets.map(bullet => ({ ...bullet })) });
    }
  });
  resume.roles = finalRoles;
  for (const role of finalRoles) {
    if (!role.bullets.length) errors.push(`résumé role "${role.id}" would be left with no bullets; a role must keep at least one bullet.`);
  }

  const projectOps = resolved.filter(entry => entry.kind === 'project');
  if (projectOps.length) resume.projects = applyListOps(resume.projects || [], projectOps, 'project');

  const skillOps = resolved.filter(entry => entry.kind === 'skill');
  if (skillOps.length) resume.skills = applyListOps(resume.skills || [], skillOps, 'skill');

  const paragraphOps = resolved.filter(entry => entry.kind === 'paragraph');
  if (paragraphOps.length) coverLetter.paragraphs = applyListOps(coverLetter.paragraphs || [], paragraphOps, 'paragraph');
  if (!(coverLetter.paragraphs || []).length) errors.push('cover letter would be left with no paragraphs; the letter must keep at least one paragraph.');

  const roleThesisEntry = resolved.find(entry => entry.kind === 'roleThesis');
  if (roleThesisEntry) coverLetter.roleThesis = roleThesisEntry.value;

  const argumentEntries = resolved.filter(entry => entry.kind === 'argument');
  for (const entry of argumentEntries) {
    const [group, field] = entry.path.split('.');
    coverLetter.coverLetterArgument = {
      ...coverLetter.coverLetterArgument,
      [group]: { ...coverLetter.coverLetterArgument[group], [field]: entry.value },
    };
  }

  return { resume, coverLetter, errors, argumentEntries };
}

function roleMetaKey(role) {
  return JSON.stringify({ title: role?.title, company: role?.company, dates: role?.dates, location: role?.location });
}

function bulletKey(bullet) {
  return JSON.stringify({ text: bullet?.text, evidenceIds: bullet?.evidenceIds });
}

function computeChanged(oldResume, newResume, oldCoverLetter, newCoverLetter, argumentEntries) {
  const oldBulletById = new Map();
  for (const role of oldResume?.roles || []) for (const bullet of role.bullets || []) oldBulletById.set(bullet.id, bullet);
  const oldRoleById = new Map((oldResume?.roles || []).map(role => [role.id, role]));

  const changedBulletIds = [];
  const changedRoleIds = [];
  for (const role of newResume?.roles || []) {
    const oldRole = oldRoleById.get(role.id);
    if (!oldRole || roleMetaKey(oldRole) !== roleMetaKey(role)) changedRoleIds.push(role.id);
    for (const bullet of role.bullets || []) {
      const oldBullet = oldBulletById.get(bullet.id);
      if (!oldBullet || bulletKey(oldBullet) !== bulletKey(bullet)) changedBulletIds.push(bullet.id);
    }
  }

  // Projects and skills have no dedicated `changed*Ids` output field in this
  // module's contract (the task names only bullets/roles/paragraphs/argument
  // paths/roleThesis); a project or skill change is still visible through the
  // whole-object `resume` comparison below, which is what
  // requiredPasteReviewDeltaEntries and mergePasteReviewDelta key off of.

  const oldParagraphById = new Map((oldCoverLetter?.paragraphs || []).map(paragraph => [paragraph.id, paragraph]));
  const changedParagraphIds = [];
  for (const paragraph of newCoverLetter?.paragraphs || []) {
    const oldParagraph = oldParagraphById.get(paragraph.id);
    const key = value => JSON.stringify({ text: value?.text, evidenceIds: value?.evidenceIds });
    if (!oldParagraph || key(oldParagraph) !== key(paragraph)) changedParagraphIds.push(paragraph.id);
  }

  const changedArgumentPaths = argumentEntries
    .filter(entry => {
      const [group, field] = entry.path.split('.');
      return (oldCoverLetter?.coverLetterArgument?.[group]?.[field]) !== entry.value;
    })
    .map(entry => entry.path);

  return {
    resume: JSON.stringify(oldResume ?? null) !== JSON.stringify(newResume ?? null),
    coverLetter: JSON.stringify(oldCoverLetter ?? null) !== JSON.stringify(newCoverLetter ?? null),
    changedBulletIds,
    changedRoleIds,
    changedParagraphIds,
    changedArgumentPaths,
    roleThesisChanged: (oldCoverLetter?.roleThesis ?? null) !== (newCoverLetter?.roleThesis ?? null),
  };
}

/**
 * Applies a scoped-review delta's patches to the accepted prior résumé and
 * cover letter. PURE: never mutates `documents.resume` / `documents.coverLetter`.
 *
 * Ops: 'replace' | 'insert-after' | 'remove'.
 * Targets: resume:bullet:<id> | resume:role:<id> | resume:project:<id> |
 * resume:skill:<id> | coverLetter:paragraph:<id> | coverLetter:roleThesis |
 * coverLetter:argument:<dotted path under coverLetterArgument>.
 *
 * Every failure is returned in `errors`, never thrown. When `errors` is
 * non-empty the round is rejected as a whole: `resume`/`coverLetter` are
 * returned unchanged (deep-cloned) and `changed` reports nothing moved, so a
 * caller never has to guess whether a partially-applied document is safe to
 * use — it never is partially applied.
 */
export function applyPasteDocumentPatches(documents, patches) {
  const originalResume = documents?.resume ?? null;
  const originalCoverLetter = documents?.coverLetter ?? null;
  const resumeSnapshot = clone(originalResume) || {};
  const coverLetterSnapshot = clone(originalCoverLetter) || {};

  const { errors: resolveErrors, resolved } = resolvePatches(patches, resumeSnapshot, coverLetterSnapshot);
  if (resolveErrors.length) {
    return { resume: clone(originalResume), coverLetter: clone(originalCoverLetter), changed: emptyChanged(), errors: resolveErrors };
  }

  const { resume, coverLetter, errors: applyErrors, argumentEntries } = applyResolvedPatches(resumeSnapshot, coverLetterSnapshot, resolved);
  if (applyErrors.length) {
    return { resume: clone(originalResume), coverLetter: clone(originalCoverLetter), changed: emptyChanged(), errors: applyErrors };
  }

  const changed = computeChanged(resumeSnapshot, resume, coverLetterSnapshot, coverLetter, argumentEntries);
  return { resume, coverLetter, changed, errors: [] };
}

// --- review merge ------------------------------------------------------

// Merges one list of {id, ...} entries by id: the delta's entry wins where
// supplied, the prior review's entry carries forward otherwise, and a slot
// neither side carries is reported by name rather than silently dropped —
// "never invent a value" applies here as much as to a document field.
//
// Sourcing `ids` from `priorList` (rather than a canonical catalog, the way
// mergeGradedCriteria's own comment explains it had to stop doing) is checked
// safe for this function's one caller — checklist — and ONLY for that caller:
// validatePasteResponse requires a complete, canonically-ordered checklist on
// EVERY accepted review round, revised or pass alike (its `!checklist.length`
// check runs unconditionally, unlike qualityReview's, which is gated on
// decision:'pass'), so a baseline's own checklist can never be missing or
// short an id the way qualityReview.criteria can — by the time a checklist is
// a baseline, it is already the canonical list in canonical order, and
// `priorList` IS the canonical id source here. A future second caller of this
// function must re-check that same premise before reusing it as-is.
function mergeById(priorList, deltaList, label) {
  const priorById = new Map((Array.isArray(priorList) ? priorList : []).map(entry => [entry.id, entry]));
  const deltaById = new Map((Array.isArray(deltaList) ? deltaList : []).map(entry => [entry.id, entry]));
  const ids = (Array.isArray(priorList) ? priorList : []).map(entry => entry.id);
  const errors = [];
  const merged = ids.map(id => {
    if (deltaById.has(id)) return deltaById.get(id);
    if (priorById.has(id)) return priorById.get(id);
    errors.push(`${label} "${id}" was not supplied by the delta and the prior review has no entry to carry forward.`);
    return null;
  });
  return { merged, errors };
}

// The BACKSTOP for the SIXTH unverifiable field (module header). Shares
// mergeById's id-keyed shape but adds two things mergeById deliberately does
// not have: a REFUSAL, and — THE DEFECT this fix closes — an id list sourced
// from the CATALOG rather than from `priorList`.
//
// mergeById is safe sourcing `ids` from `priorList` only because checklist is
// UNCONDITIONALLY required on every accepted review round (validatePasteResponse
// checks `!checklist.length` regardless of decision), so a baseline's own
// checklist can never be missing or incomplete — by the time it is a baseline,
// it already equals the canonical id list in canonical order. qualityReview has
// no such guarantee: validatePasteResponse requires it only for decision:'pass'
// (its `if (response.decision === 'pass')` block), so a full, non-delta
// 'revised' round can mint a baseline whose qualityReview — and so
// qualityReview.criteria — is entirely absent. Sourcing `ids` from that empty
// `priorList` (the old code) then produced an EMPTY merged array no matter
// what the delta supplied, rejected by validatePasteResponse's own "every
// canonical criterion, in order" gate for a shape nothing in this module or
// its required-entries counterpart ever told the writer to fix — the exact
// "rejected by a rule it was never told" class this file exists to eliminate.
// `criteriaCatalog` is the SAME list (localAiApplication.js's
// pasteCurrentCriteria(input.qualityChecklist.criteria)) validatePasteResponse
// itself compares the assembled checklist against, so sourcing `ids` from it —
// in ITS order — makes this merge and that gate agree by construction, and
// requiredPasteReviewDeltaEntries scopes checklistIds/criterionIds against the
// identical list.
//
// A priorList entry whose id the catalog no longer carries is dropped, never
// kept: ids come ONLY from the catalog now, so such an entry is simply never
// iterated. This is correct, not merely convenient — a frozen job's
// input.qualityChecklist.criteria is reconciled through pasteCurrentCriteria
// (RENAMED ids forwarded to current wording, an id the canon withdrew kept as
// frozen text) before it ever reaches this function as `criteriaCatalog`, so
// the catalog already IS the frozen id list validatePasteResponse compares
// against; an id outside it cannot appear in a response that gate accepts
// either, so keeping it here would only ever produce a checklist entry the
// gate rejects for carrying an extra id.
//
// Falls back to sourcing `ids` from `priorList` ONLY when no catalog was
// supplied at all (an absent or empty 3rd argument) — this function's
// existing "no catalog ⇒ the staleness backstop is inert" contract, which a
// direct caller (this file's own tests) may still rely on. This is a
// deliberate, narrower fallback than "trust priorList whenever it looks
// short": failing an id-list source that is UNCONDITIONALLY absent back to
// the only other list available is not inventing a value, where reading an
// EMPTY priorList as "nothing to merge" — this function's THE DEFECT — is
// exactly that.
function mergeGradedCriteria(priorList, deltaList, criteriaCatalog, staleSinceBaseline) {
  const catalog = Array.isArray(criteriaCatalog) ? criteriaCatalog : [];
  const documentById = new Map(catalog.map(criterion => [criterion?.id, criterion?.document]));
  const isStaleId = (id) => {
    const document = documentById.get(id);
    if (document === 'resume') return Boolean(staleSinceBaseline?.resume);
    if (document === 'coverLetter') return Boolean(staleSinceBaseline?.coverLetter);
    if (document === 'bundle') return Boolean(staleSinceBaseline?.resume) || Boolean(staleSinceBaseline?.coverLetter);
    return false;
  };
  const priorById = new Map((Array.isArray(priorList) ? priorList : []).map(entry => [entry.id, entry]));
  const deltaById = new Map((Array.isArray(deltaList) ? deltaList : []).map(entry => [entry.id, entry]));
  const ids = catalog.length
    ? catalog.map(criterion => criterion?.id)
    : (Array.isArray(priorList) ? priorList : []).map(entry => entry.id);
  const errors = [];
  const merged = ids.map(id => {
    if (deltaById.has(id)) return deltaById.get(id);
    if (!priorById.has(id)) {
      errors.push(`qualityReview.criteria "${id}" was not supplied by the delta and the prior review has no entry to carry forward.`);
      return null;
    }
    if (isStaleId(id)) {
      errors.push(`qualityReview.criteria "${id}" must be resupplied by the delta because the document it grades has changed since this review was authored; its prior evidence note cannot be verified against the changed document and cannot be carried forward.`);
      return null;
    }
    return priorById.get(id);
  });
  return { merged, errors };
}

/**
 * Produces the COMPLETE review object a full resend would have produced, by
 * overlaying a scoped delta on the baseline review
 * (state.reviewBaseline.review). Never invents a value: a slot the delta
 * omits and the baseline lacks is reported in `errors` by name, and `review`
 * is null whenever `errors` is non-empty.
 *
 * `staleSinceBaseline` — {resume, coverLetter} — is the ONLY signal this
 * function reads to decide whether a document changed; it is measured by
 * the caller against state.reviewBaseline.documentHashes (module header, TWO
 * SIGNALS), never against one round's own patch list. `criteria` is the
 * {id, document} catalog (localAiApplication.js's pasteCurrentCriteria
 * output) mergeGradedCriteria needs for TWO things: to scope
 * qualityReview.criteria's own staleness backstop, and — THE DEFECT
 * mergeGradedCriteria's own comment describes — to source the merged array's
 * id list itself, in canonical order, instead of trusting a baseline's own
 * `priorList`, which a full 'revised' round is free to have minted empty.
 * Omit `criteria` and mergeGradedCriteria degrades to its pre-fix shape
 * exactly: ids fall back to `priorList` and the staleness backstop goes inert
 * (every id scoped to neither document, so nothing is ever refused) — the
 * FIVE fields named in the module header are unaffected either way.
 *
 * generationAudit.coverLetterPlan.paragraphs is bound POSITIONALLY to the
 * final letter and carries no id of its own (unlike every other merged
 * list), so its delta shape mirrors that: when supplied,
 * `delta.generationAudit.coverLetterPlan.paragraphs` is a dense array the
 * length of the FINAL letter's paragraph count, holding a fresh entry at an
 * index that needs one and `null`/`undefined` at an index to carry forward
 * from the same position in the baseline. This module carries that slot
 * forward OPTIMISTICALLY — it does not itself recompute the host's sentence
 * split or compare the carried text against the final paragraph — because
 * the SAFETY ARGUMENT above means a wrong carry-forward here is still caught,
 * by name, when the existing validators grade this merged review against the
 * real final documents. requiredPasteReviewDeltaEntries is what keeps that
 * caught case rare, not what makes it safe.
 */
export function mergePasteReviewDelta(baselineReview, delta, staleSinceBaseline, criteria, { currentAuthority = false } = {}) {
  const errors = [];
  const prior = baselineReview && typeof baselineReview === 'object' ? baselineReview : {};
  const deltaObj = delta && typeof delta === 'object' ? delta : {};
  const resumeStale = Boolean(staleSinceBaseline?.resume);
  const coverLetterStale = Boolean(staleSinceBaseline?.coverLetter);
  const eitherStale = resumeStale || coverLetterStale;

  if (deltaObj.decision !== 'pass' && deltaObj.decision !== 'revised') {
    errors.push('decision must be supplied by the delta as "pass" or "revised"; a review round’s decision has no prior value to carry forward.');
  }

  const { merged: checklist, errors: checklistErrors } = mergeById(prior.checklist, deltaObj.checklist, 'checklist entry');
  errors.push(...checklistErrors);

  const priorQuality = prior.qualityReview || {};
  const deltaQuality = deltaObj.qualityReview || {};
  const { merged: criteriaEntries, errors: criteriaErrors } = mergeGradedCriteria(priorQuality.criteria, deltaQuality.criteria, criteria, staleSinceBaseline);
  errors.push(...criteriaErrors);
  // qualityReview.resume/.coverLetter are in the UNVERIFIABLE SET (module
  // header): their rationale prose is graded only for length and register,
  // never against the document it describes, so — unlike a checklist/criteria
  // entry — a stale carry-forward here cannot be caught later by any
  // text-bound validator. staleSinceBaseline therefore gates these two slots
  // directly: the prior value is refused outright rather than silently
  // reused, the same way a slot neither side supplies is refused.
  const resumeReview = resumeStale ? deltaQuality.resume : (deltaQuality.resume ?? priorQuality.resume);
  if (resumeReview == null) {
    errors.push(resumeStale
      ? 'qualityReview.resume must be resupplied by the delta because the résumé has changed since this review was authored; the prior rationale describes a document that no longer exists and cannot be carried forward.'
      : 'qualityReview.resume was not supplied by the delta and the prior review has none to carry forward.');
  }
  const coverLetterReview = coverLetterStale ? deltaQuality.coverLetter : (deltaQuality.coverLetter ?? priorQuality.coverLetter);
  if (coverLetterReview == null) {
    errors.push(coverLetterStale
      ? 'qualityReview.coverLetter must be resupplied by the delta because the cover letter has changed since this review was authored; the prior rationale describes a document that no longer exists and cannot be carried forward.'
      : 'qualityReview.coverLetter was not supplied by the delta and the prior review has none to carry forward.');
  }
  const checklistVersion = deltaQuality.checklistVersion ?? priorQuality.checklistVersion;

  const priorAudit = prior.generationAudit || {};
  const deltaAudit = deltaObj.generationAudit || {};
  if (currentAuthority && Object.prototype.hasOwnProperty.call(deltaAudit, 'jobPriorities')) {
    errors.push('Current-authority deltas must not include generationAudit.jobPriorities; immutable disposition receipts are host-owned.');
  }
  // jobPriorities cannot be scoped to "its own" document the way the other
  // unverifiable fields can — a disposition may name EITHER document
  // regardless of which one a patch touched — so it cannot be merged
  // per-requirement once stale (module header): resupplied WHOLE from the
  // delta, or refused whole, never interleaved with the baseline's own
  // entries the way checklist/criteria are. missingPasteReviewDeltaEntries
  // (localAiApplication.js) additionally checks the supplied array actually
  // COVERS every requirement the baseline covered, before this function ever
  // runs; this function only guards against an empty or missing one.
  const jobPriorities = currentAuthority ? null : eitherStale
    ? (Array.isArray(deltaAudit.jobPriorities) && deltaAudit.jobPriorities.length ? deltaAudit.jobPriorities : null)
    : (deltaAudit.jobPriorities ?? priorAudit.jobPriorities ?? null);
  if (!currentAuthority && jobPriorities == null) {
    errors.push(eitherStale
      ? 'generationAudit.jobPriorities must be resupplied whole because a patch changed a document its dispositions describe; a prior disposition cannot be verified against the changed document and none of them can be carried forward piecemeal.'
      : 'generationAudit.jobPriorities was not supplied by the delta and the prior review has none to carry forward.');
  }

  const resumePlan = resumeStale ? deltaAudit.resumePlan : (deltaAudit.resumePlan ?? priorAudit.resumePlan);
  if (resumePlan == null) {
    errors.push(resumeStale
      ? 'generationAudit.resumePlan must be resupplied by the delta because the résumé has changed since this review was authored; the prior plan describes a document that no longer exists and cannot be carried forward.'
      : 'generationAudit.resumePlan was not supplied by the delta and the prior review has none to carry forward.');
  }

  const priorCoverPlan = priorAudit.coverLetterPlan || {};
  const deltaCoverPlan = deltaAudit.coverLetterPlan || {};
  const controllingThesis = deltaCoverPlan.controllingThesis ?? priorCoverPlan.controllingThesis;
  if (controllingThesis == null) errors.push('generationAudit.coverLetterPlan.controllingThesis was not supplied by the delta and the prior review has none to carry forward.');

  const priorParagraphs = Array.isArray(priorCoverPlan.paragraphs) ? priorCoverPlan.paragraphs : [];
  const deltaParagraphs = Array.isArray(deltaCoverPlan.paragraphs) ? deltaCoverPlan.paragraphs : null;
  const paragraphCount = deltaParagraphs ? deltaParagraphs.length : priorParagraphs.length;
  const paragraphs = [];
  for (let index = 0; index < paragraphCount; index += 1) {
    const suppliedEntry = deltaParagraphs ? deltaParagraphs[index] : null;
    const entry = suppliedEntry ?? priorParagraphs[index] ?? null;
    if (entry == null) {
      errors.push(`generationAudit.coverLetterPlan.paragraphs[${index}] was not supplied by the delta and the prior review has no entry to carry forward at that position.`);
    }
    paragraphs.push(entry);
  }

  // finalDecisionSummary describes BOTH documents and the overall decision
  // (module header), so either one going stale invalidates it — the same
  // eitherStale gate jobPriorities uses, for the same reason.
  const finalDecisionSummary = eitherStale ? deltaAudit.finalDecisionSummary : (deltaAudit.finalDecisionSummary ?? priorAudit.finalDecisionSummary);
  if (finalDecisionSummary == null) {
    errors.push(eitherStale
      ? 'generationAudit.finalDecisionSummary must be resupplied by the delta because a document it describes has changed since this review was authored; the prior summary describes a document state that no longer exists and cannot be carried forward.'
      : 'generationAudit.finalDecisionSummary was not supplied by the delta and the prior review has none to carry forward.');
  }

  const auditVersion = deltaAudit.version ?? priorAudit.version;

  // staleSinceBaseline gates nothing else below the fields named above: which
  // OTHER slots are safe to carry forward is requiredPasteReviewDeltaEntries's
  // job, run by the host BEFORE it builds a delta, not this function's. Once
  // a delta exists, this merge is driven purely by what it supplies per slot;
  // a slot it left blank that SHOULD have been resupplied is not caught here
  // by design — it is caught by name, after merge, by the existing
  // text-bound validators the SAFETY ARGUMENT above describes. The fields in
  // THE UNVERIFIABLE SET have no such validator downstream, which is why they
  // alone are gated here instead.
  if (errors.length) return { review: null, errors };

  return {
    review: {
      decision: deltaObj.decision,
      findings: Array.isArray(deltaObj.findings) ? deltaObj.findings : [],
      patches: Array.isArray(deltaObj.patches) ? deltaObj.patches : [],
      checklist,
      qualityReview: { checklistVersion, criteria: criteriaEntries, resume: resumeReview, coverLetter: coverLetterReview },
      generationAudit: {
        version: auditVersion,
        ...(currentAuthority ? {} : { jobPriorities }),
        resumePlan,
        coverLetterPlan: { controllingThesis, paragraphs },
        finalDecisionSummary,
      },
    },
    errors: [],
  };
}

/**
 * Which entries a round should resupply, so the host can demand them in the
 * same delta response and reject one that omits them BEFORE running the
 * expensive validation battery — computed from TWO DELIBERATELY DIFFERENT
 * signals (module header):
 *
 *   - checklistIds / criterionIds / auditParagraphIndexes are scoped from
 *     `changed` — THIS round's own patches — because they are a COURTESY
 *     ONLY: every field they name is in the SAFETY ARGUMENT's re-verifiable
 *     set (module header), so getting the scoping wrong costs an extra
 *     correction round, never a bad document. Criterion/checklist scoping is
 *     derived from each criterion's own `document` field (the same field
 *     PASTE_STAGE_CRITERIA already selects on in localAiApplication.js),
 *     never from a second hand-kept id list. generationAudit
 *     .coverLetterPlan.paragraphs carries no id of its own — see
 *     mergePasteReviewDelta's doc comment — so this function cannot always
 *     tell WHICH final position a changed paragraph id landed at without
 *     seeing the final letter (a param it does not take, by design: derived
 *     only from `changed`). Rather than risk telling a delta "position 2 is
 *     fine to skip" when a sibling insert or removal actually shifted it,
 *     this is conservative: ANY paragraph change flags every position in the
 *     baseline's own paragraph count as needing a fresh entry.
 *   - needsResumePlan / needsJobPriorityRequirements / needsFinalDecisionSummary
 *     / needsResumeQualityReview / needsCoverLetterQualityReview are scoped
 *     from `staleSinceBaseline` OR from the baseline simply lacking the slot
 *     (module header's TWO SIGNALS and PRINCIPLE, plus FINDING B below),
 *     because every one of them names a field in THE UNVERIFIABLE SET:
 *     mergePasteReviewDelta refuses each one's stale carry-forward on its
 *     own once its document is stale, so getting these wrong here costs
 *     nothing either — a delta that omits one fails here with a plain
 *     "resupply" message, or fails in the merge with the same verdict, never
 *     silently. jobPriorityRequirements additionally names WHICH
 *     requirements the baseline covered, so missingPasteReviewDeltaEntries
 *     (localAiApplication.js) can reject a resupplied array that drops one
 *     of them by name, rather than only checking it is non-empty — empty
 *     itself whenever the baseline has no coverage to name (FINDING B).
 *
 *   FINDING B (2026-09-22 adversarial review): a FULL 'revised' round is
 *   structurally allowed to omit generationAudit/qualityReview entirely
 *   (validatePasteResponse requires them only for decision:'pass'), which
 *   mints a baseline missing one of these five slots with NEITHER document
 *   stale. staleSinceBaseline alone then told a later round it could omit a
 *   slot mergePasteReviewDelta's own `== null` check was always going to
 *   refuse — rejecting a round for a field its own printed contract never
 *   asked for. Each needs* signal below is therefore true whenever
 *   staleSinceBaseline says so OR the baseline's own value for that slot is
 *   null/undefined — the exact condition mergePasteReviewDelta already
 *   tests to decide whether a slot has anything to carry forward — so the
 *   printed contract and the merge's own refusal can never disagree.
 *
 * criterionIds carries the SAME FINDING-B shape one level down, per id rather
 * than per whole slot: mergeGradedCriteria (this file's own function above)
 * refuses an id the delta omits AND the baseline has no entry for,
 * unconditionally — the same "nothing to carry forward"
 * refusal mergeById already has, now actually reachable because that
 * function's `ids` are sourced from the canonical CATALOG (THE DEFECT its own
 * comment describes) rather than from the baseline's own, possibly-empty
 * list. A baseline minted by a qualityReview-omitting 'revised' round can
 * therefore lack an entry for every criterion id at once, with `changed`
 * naming nothing invalidated at all — criterionIds must ask for those ids too
 * or this function's printed demand and the merge's own refusal disagree,
 * which is precisely the round-wasting gap this fix closes. This is
 * DIFFERENT from mergeGradedCriteria's staleness backstop (isStaleId), which
 * stays independent of this courtesy list by design (module header) exactly
 * as before: a stale-but-present baseline entry is still refused by the merge
 * whether or not criterionIds happened to predict it.
 */
export function requiredPasteReviewDeltaEntries(baselineReview, changed, criteria, staleSinceBaseline) {
  const list = Array.isArray(criteria) ? criteria : [];
  const resumeChanged = Boolean(changed?.resume);
  const coverLetterChanged = Boolean(changed?.coverLetter);
  const invalidatedIds = list
    .filter(criterion => {
      if (!criterion || typeof criterion.document !== 'string') return false;
      if (criterion.document === 'bundle') return resumeChanged || coverLetterChanged;
      if (criterion.document === 'resume') return resumeChanged;
      if (criterion.document === 'coverLetter') return coverLetterChanged;
      return false;
    })
    .map(criterion => criterion.id);
  // The catalog id an accepted baseline has NO qualityReview.criteria entry
  // for at all — checked here, in canonical order, rather than the delta
  // being left to discover it only once mergeGradedCriteria's own "not
  // supplied by the delta and the prior review has no entry to carry
  // forward" branch runs against real patches.
  const invalidatedIdSet = new Set(invalidatedIds);
  const baselineCriteriaIds = new Set((Array.isArray(baselineReview?.qualityReview?.criteria)
    ? baselineReview.qualityReview.criteria : []).map(entry => entry?.id));
  const criterionIds = list
    .map(criterion => criterion?.id)
    .filter(id => typeof id === 'string' && id && (invalidatedIdSet.has(id) || !baselineCriteriaIds.has(id)));

  const priorParagraphs = Array.isArray(baselineReview?.generationAudit?.coverLetterPlan?.paragraphs)
    ? baselineReview.generationAudit.coverLetterPlan.paragraphs
    : [];
  const anyParagraphChanged = Array.isArray(changed?.changedParagraphIds) && changed.changedParagraphIds.length > 0;
  const auditParagraphIndexes = anyParagraphChanged ? priorParagraphs.map((_, index) => index) : [];

  const resumeStale = Boolean(staleSinceBaseline?.resume);
  const coverLetterStale = Boolean(staleSinceBaseline?.coverLetter);
  const baselineAudit = baselineReview?.generationAudit || {};
  const baselineQuality = baselineReview?.qualityReview || {};
  // FINDING B (2026-09-22 adversarial review of the delta work): a FULL
  // (non-delta) 'revised' round is structurally allowed to omit
  // generationAudit/qualityReview entirely — validatePasteResponse requires
  // them only when decision === 'pass' — so the baseline that round mints
  // can lack a slot with NO document having gone stale at all. Gating these
  // five needs* signals on staleSinceBaseline alone left that case
  // untold: the prompt said "omit it, nothing changed" for a slot
  // mergePasteReviewDelta's own `== null` check was always going to refuse
  // regardless of staleness, rejecting a round for a field its own contract
  // never asked for. A baseline slot that is simply ABSENT is therefore
  // "needed" on exactly the same terms as one that went stale — this is
  // what makes requiredPasteReviewDeltaEntries ask for precisely what the
  // merge will demand, never more, never less; it changes nothing about
  // what mergePasteReviewDelta itself accepts or refuses.
  const needsResumePlan = resumeStale || baselineAudit.resumePlan == null;
  const needsJobPriorityRequirements = resumeStale || coverLetterStale || baselineAudit.jobPriorities == null;
  const needsFinalDecisionSummary = resumeStale || coverLetterStale || baselineAudit.finalDecisionSummary == null;
  const needsResumeQualityReview = resumeStale || baselineQuality.resume == null;
  const needsCoverLetterQualityReview = coverLetterStale || baselineQuality.coverLetter == null;
  const baselineJobPriorities = Array.isArray(baselineAudit.jobPriorities) ? baselineAudit.jobPriorities : [];

  return {
    // checklistIds stays scoped to `changed` alone, never widened by a
    // baseline-missing check the way criterionIds is just below: checklist
    // is required on EVERY accepted review round regardless of decision
    // (validatePasteResponse's unconditional `!checklist.length` check), so a
    // baseline can never lack an entry for a canonical id the way
    // qualityReview.criteria can — there is no "baseline never captured
    // this checklist id" case for this signal to name.
    checklistIds: invalidatedIds,
    criterionIds,
    auditParagraphIndexes,
    needsResumePlan,
    needsJobPriorityRequirements,
    // The exact requirement set missingPasteReviewDeltaEntries checks a
    // resupplied jobPriorities array against — "the baseline covered", per
    // the module header, never "the evidence plan" directly: jobPriorities
    // is not re-verified against the plan until final completion
    // (generationAuditPlanCoverageFailures), so mid-chain the baseline's own
    // coverage is the only thing this round can be held to. Empty whenever
    // the baseline itself has nothing to name (FINDING B above) — there is
    // no prior coverage to demand naming, only the resupply itself.
    jobPriorityRequirements: needsJobPriorityRequirements
      ? baselineJobPriorities.map(entry => entry?.requirement).filter(requirement => typeof requirement === 'string' && requirement)
      : [],
    needsFinalDecisionSummary,
    needsResumeQualityReview,
    needsCoverLetterQualityReview,
  };
}
