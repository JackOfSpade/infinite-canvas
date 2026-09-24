// Coverage for electron/ipc/pasteReviewDelta.js — the deterministic
// patch/merge engine for SCOPED REVIEW ROUNDS (see that file's header for the
// measured defect it fixes: an accepted review response with no documents at
// all was ~77% bookkeeping the host already held). Wired into the review
// stage of localAiApplication.js's submitLocalApplicationHandoff (Task B2);
// end-to-end delta-round coverage against the real handoff flow lives in
// scripts/tests/paste-application-fit-save.js, while this file exercises the
// engine's own pure functions in isolation.
import fs from 'node:fs';
import { assert } from './testHelpers.js';
import {
  applyPasteDocumentPatches,
  mergePasteReviewDelta,
  requiredPasteReviewDeltaEntries,
  TARGET_FORMS_RULE,
  VALID_OPS,
} from '../../electron/ipc/pasteReviewDelta.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION } from '../../electron/ipc/localAiApplication.js';

function baseResume() {
  return {
    schemaVersion: 'structured-resume.v1',
    identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], credential: '' },
    roles: [
      {
        id: 'role-1', title: 'Software Engineer', company: 'Acme', dates: '2020 - 2024', location: '',
        bullets: [
          { id: 'bullet-1', text: 'Built reporting systems.', evidenceIds: ['cd-1'] },
          { id: 'bullet-2', text: 'Improved reliability.', evidenceIds: ['cd-2'] },
        ],
      },
    ],
    projects: [{ id: 'proj-1', name: 'Widget', description: 'A widget project.', metrics: '', evidenceIds: ['cd-3'] }],
    skills: [{ id: 'skill-1', group: 'Languages', items: ['JavaScript'], evidenceIds: ['cd-1'] }],
  };
}

function baseCoverLetter() {
  return {
    name: 'Ada Lovelace', contact: ['ada@example.test'], salutation: 'Dear Team,', recipient: 'Acme',
    paragraphs: [
      { id: 'p1', text: 'Opening paragraph text here.', evidenceIds: ['cd-1'] },
      { id: 'p2', text: 'Closing paragraph text here.', evidenceIds: ['cd-2'] },
    ],
    closing: 'Sincerely,', signatureTitle: 'Software Engineer',
    roleThesis: 'Reporting systems judgment is the capability this role needs.',
    coverLetterArgument: {
      primaryEvidence: { evidence: 'Built reporting systems.', evidenceRole: 'Software Engineer at Acme', relationToThesis: 'Proves it directly.' },
    },
  };
}

function baseDocuments() { return { resume: baseResume(), coverLetter: baseCoverLetter() }; }

function noChange() {
  return { resume: false, coverLetter: false, changedBulletIds: [], changedRoleIds: [], changedParagraphIds: [], changedArgumentPaths: [], roleThesisChanged: false };
}

export default [
  {
    name: 'applyPasteDocumentPatches: replace covers every target kind, updates changed precisely, and a no-op replace reports nothing changed',
    run: () => {
      const documents = baseDocuments();
      const result = applyPasteDocumentPatches(documents, [
        { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'Built reporting systems end to end.', evidenceIds: ['cd-1'] } },
        { op: 'replace', target: 'resume:role:role-1', value: { title: 'Senior Software Engineer', company: 'Acme', dates: '2020 - 2024', location: '' } },
        { op: 'replace', target: 'resume:project:proj-1', value: { name: 'Widget 2.0', description: 'Updated.', metrics: '', evidenceIds: ['cd-3'] } },
        { op: 'replace', target: 'resume:skill:skill-1', value: { group: 'Languages', items: ['JavaScript', 'TypeScript'], evidenceIds: ['cd-1'] } },
        { op: 'replace', target: 'coverLetter:paragraph:p1', value: { text: 'A rewritten opening paragraph.', evidenceIds: ['cd-1'] } },
        { op: 'replace', target: 'coverLetter:roleThesis', value: 'A rewritten controlling thesis about systems judgment.' },
        { op: 'replace', target: 'coverLetter:argument:primaryEvidence.evidenceRole', value: 'Senior Software Engineer at Acme' },
      ]);
      assert(result.errors.length === 0, `expected no errors, got ${JSON.stringify(result.errors)}`);
      assert(result.resume.roles[0].bullets[0].text === 'Built reporting systems end to end.', 'bullet replace must land');
      assert(result.resume.roles[0].title === 'Senior Software Engineer', 'role-metadata replace must land');
      assert(result.resume.roles[0].bullets[1].text === 'Improved reliability.', 'a role-metadata replace must not disturb sibling bullets');
      assert(result.resume.projects[0].name === 'Widget 2.0', 'project replace must land');
      assert(result.resume.skills[0].items.length === 2, 'skill replace must land');
      assert(result.coverLetter.paragraphs[0].text === 'A rewritten opening paragraph.', 'paragraph replace must land');
      assert(result.coverLetter.roleThesis.startsWith('A rewritten controlling thesis'), 'roleThesis replace must land');
      assert(result.coverLetter.coverLetterArgument.primaryEvidence.evidenceRole === 'Senior Software Engineer at Acme', 'argument replace must land');
      assert(result.changed.resume === true && result.changed.coverLetter === true, 'both documents must report changed');
      assert(result.changed.changedBulletIds.join(',') === 'bullet-1', 'only the edited bullet is reported changed');
      assert(result.changed.changedRoleIds.join(',') === 'role-1', 'only the edited role is reported changed');
      assert(result.changed.changedParagraphIds.join(',') === 'p1', 'only the edited paragraph is reported changed');
      assert(result.changed.changedArgumentPaths.join(',') === 'primaryEvidence.evidenceRole', 'only the edited argument path is reported changed');
      assert(result.changed.roleThesisChanged === true, 'roleThesis change must be reported');

      // "derive it by comparing before/after values, not by trusting the
      // patch list": a replace that supplies the SAME value the unit
      // already had must not appear as changed anywhere.
      const noop = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'Built reporting systems.', evidenceIds: ['cd-1'] } },
        { op: 'replace', target: 'coverLetter:roleThesis', value: 'Reporting systems judgment is the capability this role needs.' },
      ]);
      assert(noop.errors.length === 0, 'a same-value replace is not itself an error');
      assert(JSON.stringify(noop.changed) === JSON.stringify(noChange()), `a same-value replace must report nothing changed, got ${JSON.stringify(noop.changed)}`);
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: insert-after covers every collection kind and rejects an id that would duplicate an existing one',
    run: () => {
      const bulletInsert = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'resume:bullet:bullet-1', value: { id: 'bullet-1b', text: 'Added a bullet.', evidenceIds: ['cd-1'] } },
      ]);
      assert(bulletInsert.errors.length === 0, `bullet insert-after failed: ${JSON.stringify(bulletInsert.errors)}`);
      assert(bulletInsert.resume.roles[0].bullets.map(b => b.id).join(',') === 'bullet-1,bullet-1b,bullet-2', 'inserted bullet must land immediately after its anchor');
      assert(bulletInsert.changed.changedBulletIds.join(',') === 'bullet-1b', 'a newly inserted bullet is reported changed');

      const roleInsert = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'resume:role:role-1', value: { id: 'role-2', title: 'Engineer', company: 'Beta', dates: '2018 - 2020', location: '', bullets: [{ id: 'role-2-b1', text: 'Did prior work.', evidenceIds: ['cd-9'] }] } },
      ]);
      assert(roleInsert.errors.length === 0, `role insert-after failed: ${JSON.stringify(roleInsert.errors)}`);
      assert(roleInsert.resume.roles.map(r => r.id).join(',') === 'role-1,role-2', 'inserted role must land after its anchor');
      assert(roleInsert.changed.changedRoleIds.join(',') === 'role-2', 'a newly inserted role is reported changed');
      assert(roleInsert.changed.changedBulletIds.join(',') === 'role-2-b1', 'bullets of a newly inserted role are reported changed');

      const projectInsert = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'resume:project:proj-1', value: { id: 'proj-2', name: 'Gadget', description: 'Another project.', metrics: '', evidenceIds: ['cd-3'] } },
      ]);
      assert(projectInsert.errors.length === 0 && projectInsert.resume.projects.map(p => p.id).join(',') === 'proj-1,proj-2', 'project insert-after must land');

      const skillInsert = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'resume:skill:skill-1', value: { id: 'skill-2', group: 'Tools', items: ['Git'], evidenceIds: ['cd-1'] } },
      ]);
      assert(skillInsert.errors.length === 0 && skillInsert.resume.skills.map(s => s.id).join(',') === 'skill-1,skill-2', 'skill insert-after must land');

      const paragraphInsert = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'coverLetter:paragraph:p1', value: { id: 'p1b', text: 'An inserted paragraph.', evidenceIds: ['cd-1'] } },
      ]);
      assert(paragraphInsert.errors.length === 0 && paragraphInsert.coverLetter.paragraphs.map(p => p.id).join(',') === 'p1,p1b,p2', 'paragraph insert-after must land');

      const duplicateId = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'insert-after', target: 'resume:bullet:bullet-1', value: { id: 'bullet-2', text: 'dup', evidenceIds: ['cd-1'] } },
      ]);
      assert(duplicateId.errors.length === 1 && /already identifies another unit/.test(duplicateId.errors[0]), `expected a duplicate-id error, got ${JSON.stringify(duplicateId.errors)}`);
      assert(JSON.stringify(duplicateId.resume) === JSON.stringify(baseResume()), 'a rejected round must leave the résumé completely unchanged');
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: remove covers every collection kind and enforces the bullet-floor and paragraph-floor',
    run: () => {
      const removeProject = applyPasteDocumentPatches(baseDocuments(), [{ op: 'remove', target: 'resume:project:proj-1' }]);
      assert(removeProject.errors.length === 0 && removeProject.resume.projects.length === 0, 'projects may be emptied; no floor applies');

      const removeSkill = applyPasteDocumentPatches(baseDocuments(), [{ op: 'remove', target: 'resume:skill:skill-1' }]);
      assert(removeSkill.errors.length === 0 && removeSkill.resume.skills.length === 0, 'skill groups may be emptied; no floor applies');

      const removeBullet = applyPasteDocumentPatches(baseDocuments(), [{ op: 'remove', target: 'resume:bullet:bullet-1' }]);
      assert(removeBullet.errors.length === 0 && removeBullet.resume.roles[0].bullets.map(b => b.id).join(',') === 'bullet-2', 'one bullet may be removed while another remains');

      const emptyRole = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'remove', target: 'resume:bullet:bullet-1' },
        { op: 'remove', target: 'resume:bullet:bullet-2' },
      ]);
      assert(emptyRole.errors.length === 1 && /must keep at least one bullet/.test(emptyRole.errors[0]), `expected the bullet-floor error, got ${JSON.stringify(emptyRole.errors)}`);
      assert(JSON.stringify(emptyRole.resume) === JSON.stringify(baseResume()), 'a floor violation must reject the whole round, not just the offending patch');

      const emptyLetter = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'remove', target: 'coverLetter:paragraph:p1' },
        { op: 'remove', target: 'coverLetter:paragraph:p2' },
      ]);
      assert(emptyLetter.errors.length === 1 && /must keep at least one paragraph/.test(emptyLetter.errors[0]), `expected the paragraph-floor error, got ${JSON.stringify(emptyLetter.errors)}`);

      const removeRole = applyPasteDocumentPatches(baseDocuments(), [{ op: 'remove', target: 'resume:role:role-1' }]);
      assert(removeRole.errors.length === 0 && removeRole.resume.roles.length === 0, 'a whole role may be removed (no role-count floor in this module)');
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: unknown targets are rejected by name, including an argument path with no block to edit',
    run: () => {
      const badForm = applyPasteDocumentPatches(baseDocuments(), [{ op: 'replace', target: 'resume:widget:x', value: {} }]);
      assert(badForm.errors.length === 1 && /unknown target "resume:widget:x"/.test(badForm.errors[0]), `expected an unknown-target-form error, got ${JSON.stringify(badForm.errors)}`);

      const badBulletId = applyPasteDocumentPatches(baseDocuments(), [{ op: 'replace', target: 'resume:bullet:nope', value: { text: 'x', evidenceIds: ['cd-1'] } }]);
      assert(badBulletId.errors.length === 1 && /unknown target id "nope"/.test(badBulletId.errors[0]), `expected an unknown-id error, got ${JSON.stringify(badBulletId.errors)}`);

      const badArgumentPath = applyPasteDocumentPatches(baseDocuments(), [{ op: 'replace', target: 'coverLetter:argument:primaryEvidence.notAField', value: 'x' }]);
      assert(badArgumentPath.errors.length === 1 && /unknown coverLetterArgument field/.test(badArgumentPath.errors[0]), `expected an unknown-field error, got ${JSON.stringify(badArgumentPath.errors)}`);

      // secondaryEvidence is optional and this fixture's letter has none, so
      // a delta cannot replace a field inside a block that does not exist.
      const noSecondary = applyPasteDocumentPatches(baseDocuments(), [{ op: 'replace', target: 'coverLetter:argument:secondaryEvidence.evidence', value: 'x' }]);
      assert(noSecondary.errors.length === 1 && /no coverLetterArgument.secondaryEvidence block/.test(noSecondary.errors[0]), `expected a missing-block error, got ${JSON.stringify(noSecondary.errors)}`);

      // The same path succeeds once the letter actually carries the block.
      const withSecondary = baseDocuments();
      withSecondary.coverLetter.coverLetterArgument.secondaryEvidence = { evidence: 'Improved reliability.', evidenceRole: 'Software Engineer at Acme', narrativeRole: 'deepens', relationToPrimary: 'Extends the same argument.' };
      const editSecondary = applyPasteDocumentPatches(withSecondary, [{ op: 'replace', target: 'coverLetter:argument:secondaryEvidence.relationToPrimary', value: 'Deepens the primary example.' }]);
      assert(editSecondary.errors.length === 0, `expected the secondary-evidence edit to succeed, got ${JSON.stringify(editSecondary.errors)}`);
      assert(editSecondary.coverLetter.coverLetterArgument.secondaryEvidence.relationToPrimary === 'Deepens the primary example.', 'the secondary-evidence field must be updated');
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: an op that does not apply to a scalar target kind is rejected for both roleThesis and argument',
    run: () => {
      for (const target of ['coverLetter:roleThesis', 'coverLetter:argument:primaryEvidence.evidence']) {
        for (const op of ['insert-after', 'remove']) {
          const value = op === 'insert-after' ? 'x' : undefined;
          const result = applyPasteDocumentPatches(baseDocuments(), [{ op, target, value }]);
          assert(result.errors.length === 1 && /only "replace" applies to a scalar field/.test(result.errors[0]),
            `expected a scalar-op rejection for ${op} on ${target}, got ${JSON.stringify(result.errors)}`);
        }
      }
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: a duplicate target in one round is rejected regardless of which two ops it mixes',
    run: () => {
      const sameOp = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'a', evidenceIds: ['cd-1'] } },
        { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'b', evidenceIds: ['cd-1'] } },
      ]);
      assert(sameOp.errors.length === 1 && /repeats target/.test(sameOp.errors[0]), `expected a duplicate-target error, got ${JSON.stringify(sameOp.errors)}`);

      const mixedOps = applyPasteDocumentPatches(baseDocuments(), [
        { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'a', evidenceIds: ['cd-1'] } },
        { op: 'remove', target: 'resume:bullet:bullet-1' },
      ]);
      assert(mixedOps.errors.length === 1 && /repeats target/.test(mixedOps.errors[0]), `expected a duplicate-target error across ops, got ${JSON.stringify(mixedOps.errors)}`);
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: a value whose shape is wrong for its unit is rejected and names the field',
    run: () => {
      const cases = [
        [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { evidenceIds: ['cd-1'] } }, /\.text must be nonempty text/],
        [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'ok', evidenceIds: [] } }, /\.evidenceIds must be a nonempty array/],
        [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'ok', evidenceIds: ['cd-1', 'cd-1'] } }, /\.evidenceIds must not repeat/],
        [{ op: 'replace', target: 'resume:role:role-1', value: { title: 'X', company: '', dates: '', location: '', bullets: [] } }, /must not carry bullets/],
        [{ op: 'replace', target: 'resume:skill:skill-1', value: { group: 'Languages', items: [], evidenceIds: ['cd-1'] } }, /\.items must be a nonempty array/],
        [{ op: 'replace', target: 'resume:project:proj-1', value: { description: 'x', evidenceIds: ['cd-1'] } }, /\.name must be nonempty text/],
        [{ op: 'replace', target: 'coverLetter:paragraph:p1', value: { text: '', evidenceIds: ['cd-1'] } }, /\.text must be nonempty text/],
        [{ op: 'replace', target: 'coverLetter:roleThesis', value: '' }, /must be nonempty text/],
        [{ op: 'insert-after', target: 'resume:bullet:bullet-1', value: { id: 'not a valid id!', text: 'x', evidenceIds: ['cd-1'] } }, /must match/],
      ];
      for (const [patch, pattern] of cases) {
        const result = applyPasteDocumentPatches(baseDocuments(), [patch]);
        assert(result.errors.length >= 1 && result.errors.some(message => pattern.test(message)),
          `expected an error matching ${pattern} for target ${patch.target}, got ${JSON.stringify(result.errors)}`);
      }
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: the result never depends on the order patches were listed in',
    run: () => {
      const patchesInOrder = [
        { op: 'insert-after', target: 'resume:bullet:bullet-1', value: { id: 'bullet-1b', text: 'New bullet.', evidenceIds: ['cd-1'] } },
        { op: 'remove', target: 'resume:bullet:bullet-2' },
        { op: 'replace', target: 'resume:role:role-1', value: { title: 'Staff Engineer', company: 'Acme', dates: '2020 - 2024', location: '' } },
        { op: 'replace', target: 'coverLetter:paragraph:p2', value: { text: 'A different closing paragraph.', evidenceIds: ['cd-2'] } },
      ];
      const reversed = [...patchesInOrder].reverse();
      const shuffled = [patchesInOrder[2], patchesInOrder[0], patchesInOrder[3], patchesInOrder[1]];
      const forward = applyPasteDocumentPatches(baseDocuments(), patchesInOrder);
      const backward = applyPasteDocumentPatches(baseDocuments(), reversed);
      const mixed = applyPasteDocumentPatches(baseDocuments(), shuffled);
      assert(forward.errors.length === 0, `unexpected errors: ${JSON.stringify(forward.errors)}`);
      assert(JSON.stringify(forward) === JSON.stringify(backward), 'reversing the patch array must not change the result');
      assert(JSON.stringify(forward) === JSON.stringify(mixed), 'shuffling the patch array must not change the result');
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: malformed patches input and malformed patch entries are reported, never thrown',
    run: () => {
      const notArray = applyPasteDocumentPatches(baseDocuments(), 'not-an-array');
      assert(notArray.errors.length === 1 && /patches must be an array/.test(notArray.errors[0]), `expected a patches-must-be-array error, got ${JSON.stringify(notArray.errors)}`);
      assert(JSON.stringify(notArray.changed) === JSON.stringify(noChange()), 'a rejected round must report nothing changed');

      const missingOp = applyPasteDocumentPatches(baseDocuments(), [{ target: 'resume:bullet:bullet-1', value: {} }]);
      assert(missingOp.errors.length === 1 && /unknown op/.test(missingOp.errors[0]), `expected an unknown-op error, got ${JSON.stringify(missingOp.errors)}`);

      const missingTarget = applyPasteDocumentPatches(baseDocuments(), [{ op: 'replace', value: {} }]);
      assert(missingTarget.errors.length === 1, `expected exactly one error for a missing target, got ${JSON.stringify(missingTarget.errors)}`);

      const notObject = applyPasteDocumentPatches(baseDocuments(), ['just a string']);
      assert(notObject.errors.length === 1 && /must be an object with op and target/.test(notObject.errors[0]), `expected an object-shape error, got ${JSON.stringify(notObject.errors)}`);
      return { ok: true };
    },
  },
  {
    name: 'applyPasteDocumentPatches: PURE — mutating the caller’s patches array afterward never reaches the returned documents',
    run: () => {
      const evidenceIds = ['cd-1'];
      const patches = [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'Built reporting systems end to end.', evidenceIds } }];
      const result = applyPasteDocumentPatches(baseDocuments(), patches);
      assert(result.errors.length === 0, `unexpected errors: ${JSON.stringify(result.errors)}`);
      // Mutate the SAME array object the caller passed in, after the call
      // returned. Deep-clone-on-input means this must be invisible.
      evidenceIds.push('cd-99');
      patches[0].value.text = 'mutated after the call';
      assert(result.resume.roles[0].bullets[0].text === 'Built reporting systems end to end.', 'a later mutation of the caller’s patch value must not reach the returned résumé');
      assert(result.resume.roles[0].bullets[0].evidenceIds.length === 1, 'a later mutation of the caller’s evidenceIds array must not reach the returned résumé');
      return { ok: true };
    },
  },
  {
    name: 'mergePasteReviewDelta: a delta supplying only the invalidated slots reconstructs the full review, carrying the rest forward byte-identical',
    run: () => {
      const priorReview = {
        checklist: [
          { id: 'resume-crit', status: 'pass', detail: 'Resume detail.' },
          { id: 'cover-crit', status: 'pass', detail: 'Cover detail.' },
          { id: 'bundle-crit', status: 'pass', detail: 'Bundle detail.' },
        ],
        qualityReview: {
          checklistVersion: 3,
          criteria: [
            { id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' },
            { id: 'cover-crit', status: 'pass', evidence: 'Cover evidence measured directly.' },
            { id: 'bundle-crit', status: 'pass', evidence: 'Bundle evidence measured directly.' },
          ],
          resume: { decision: 'drafted', rationale: 'Resume rationale text.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale text.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [
            { requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text for req-1.' },
            { requirement: 'req-2', priority: 'high', disposition: 'addressed-resume', justification: 'Justification text for req-2.' },
          ],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale text.' },
          coverLetterPlan: {
            controllingThesis: 'Reporting systems judgment is the capability this role needs.',
            paragraphs: [
              { paragraph: 'Opening paragraph text here.', argumentativeJob: 'Opens the argument.', relationToThesis: 'Introduces the branch.', relationToPreviousParagraph: 'opening', sentences: [] },
              { paragraph: 'Closing paragraph text here.', argumentativeJob: 'Closes the argument.', relationToThesis: 'Closes the branch.', relationToPreviousParagraph: 'Carries the branch forward.', sentences: [] },
            ],
          },
          finalDecisionSummary: 'Final decision summary text.',
        },
      };

      // Only bullet-1 changed; everything scoped to an unchanged document, or
      // bound to an unchanged paragraph, must carry forward untouched.
      // staleSinceBaseline (the 3rd argument) is the baseline-relative signal
      // this test's scenario also happens to agree with `changed` on — see
      // the resupply-whole/refusal tests below for a scenario where they are
      // measured independently.
      const staleSinceBaseline = { resume: true, coverLetter: false };
      const delta = {
        decision: 'pass', findings: [], patches: [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'x', evidenceIds: ['cd-1'] } }],
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Updated resume detail.' }],
        qualityReview: {
          criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Updated resume evidence measured.' }],
          resume: { decision: 'drafted', rationale: 'Updated resume rationale text.' },
        },
        generationAudit: {
          // jobPriorities is resupplied WHOLE (covering req-1 AND req-2), not
          // per-requirement: a résumé change makes every disposition
          // unverifiable, since a disposition can address either document
          // regardless of which one a patch touched (pasteReviewDelta.js's
          // header) — there is no "req-2 didn't change" carry-forward for
          // this field the way there is for checklist/criteria.
          jobPriorities: [
            { requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Updated justification for req-1.' },
            { requirement: 'req-2', priority: 'high', disposition: 'addressed-resume', justification: 'Re-confirmed justification for req-2 against the patched résumé.' },
          ],
          resumePlan: { strategy: 'Updated strategy text.', selectionRationale: 'Updated selection rationale.' },
          finalDecisionSummary: 'Updated final decision summary reflecting the patched résumé.',
        },
      };
      const { review, errors } = mergePasteReviewDelta(priorReview, delta, staleSinceBaseline);
      assert(errors.length === 0, `expected no errors, got ${JSON.stringify(errors)}`);
      assert(review.checklist.find(entry => entry.id === 'resume-crit').detail === 'Updated resume detail.', 'the delta-supplied checklist entry must win');
      assert(review.checklist.find(entry => entry.id === 'cover-crit').detail === 'Cover detail.', 'an untouched checklist entry must carry forward byte-identical');
      assert(review.qualityReview.criteria.find(entry => entry.id === 'resume-crit').evidence === 'Updated resume evidence measured.', 'the delta-supplied criterion must win');
      assert(review.qualityReview.criteria.find(entry => entry.id === 'cover-crit').evidence === 'Cover evidence measured directly.', 'an untouched criterion must carry forward byte-identical');
      assert(review.qualityReview.resume.rationale === 'Updated resume rationale text.', 'the delta-supplied qualityReview.resume must win');
      assert(review.qualityReview.coverLetter.rationale === 'Cover rationale text.', 'an unsupplied qualityReview.coverLetter must carry forward from the prior review');
      assert(review.generationAudit.jobPriorities.find(entry => entry.requirement === 'req-1').justification === 'Updated justification for req-1.', 'jobPriorities is resupplied whole from the delta once stale');
      assert(review.generationAudit.jobPriorities.find(entry => entry.requirement === 'req-2').justification === 'Re-confirmed justification for req-2 against the patched résumé.', 'jobPriorities is taken WHOLE from the delta, never merged per-requirement with the baseline, once either document is stale');
      assert(review.generationAudit.resumePlan.strategy === 'Updated strategy text.', 'a supplied resumePlan must win outright (replaced, not merged field-by-field)');
      assert(JSON.stringify(review.generationAudit.coverLetterPlan.paragraphs) === JSON.stringify(priorReview.generationAudit.coverLetterPlan.paragraphs),
        'coverLetterPlan.paragraphs must carry forward completely when the delta omits it and the letter did not change');
      assert(review.generationAudit.finalDecisionSummary === 'Updated final decision summary reflecting the patched résumé.', 'finalDecisionSummary must be resupplied fresh once either document is stale, never carried forward');
      assert(review.decision === 'pass' && Array.isArray(review.findings) && review.findings.length === 0, 'decision and findings are taken from the delta as-is');
      assert(review.patches.length === 1, 'patches are taken from the delta as-is, for the host’s own record');
      return { ok: true };
    },
  },
  {
    name: 'mergePasteReviewDelta: a slot neither the delta nor the prior review carries is reported by name, never invented',
    run: () => {
      const priorReview = {
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Resume detail.' }],
        qualityReview: { checklistVersion: 3, criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' }], resume: { decision: 'drafted', rationale: 'Resume rationale text.' }, coverLetter: { decision: 'drafted', rationale: 'Cover rationale text.' } },
        generationAudit: {
          version: 3,
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Summary.',
        },
      };

      // No decision at all: this has no prior-round value to fall back to.
      const missingDecision = mergePasteReviewDelta(priorReview, { findings: [], patches: [] }, noChange());
      assert(missingDecision.review === null, 'a missing decision must null out the review, not guess one');
      assert(missingDecision.errors.some(message => /decision must be supplied/.test(message)), `expected a decision error, got ${JSON.stringify(missingDecision.errors)}`);

      // A brand-new paragraph beyond the prior review's own paragraph count,
      // where the delta supplies a dense array but leaves that new slot
      // null: there is nothing in the prior review to carry forward there.
      const insertedParagraphGap = mergePasteReviewDelta(priorReview, {
        decision: 'pass', findings: [], patches: [],
        generationAudit: { coverLetterPlan: { paragraphs: [null, null] } },
      }, { ...noChange(), coverLetter: true, changedParagraphIds: ['p2'] });
      assert(insertedParagraphGap.review === null, 'an unfillable paragraph slot must null out the review');
      assert(insertedParagraphGap.errors.some(message => /coverLetterPlan\.paragraphs\[1\]/.test(message)), `expected a paragraph[1] error, got ${JSON.stringify(insertedParagraphGap.errors)}`);

      // Neither the delta nor the (deliberately incomplete) prior review
      // carries qualityReview.coverLetter: reported by name, not invented.
      const incompletePrior = { ...priorReview, qualityReview: { ...priorReview.qualityReview, coverLetter: undefined } };
      const missingCoverReview = mergePasteReviewDelta(incompletePrior, { decision: 'pass', findings: [], patches: [] }, noChange());
      assert(missingCoverReview.review === null, 'a slot missing from both sides must null out the review');
      assert(missingCoverReview.errors.some(message => /qualityReview\.coverLetter/.test(message)), `expected a qualityReview.coverLetter error, got ${JSON.stringify(missingCoverReview.errors)}`);
      return { ok: true };
    },
  },
  {
    // Coverage for the FINDING this fixes: qualityReview.resume/.coverLetter
    // are two of THE UNVERIFIABLE SET (pasteReviewDelta.js's header) — no
    // text-bound validator downstream (a stale rationale describing a bullet
    // a patch just deleted would otherwise sail through every existing
    // check). mergePasteReviewDelta must refuse the carry-forward itself
    // once the document a rationale attests to is stale relative to the
    // baseline — even though the baseline has a value sitting right there —
    // while an unchanged document's rationale is still true and may carry
    // forward exactly as before.
    name: 'mergePasteReviewDelta: qualityReview.resume/coverLetter is refused as a carry-forward once its own document changed, even though the prior review still has a value',
    run: () => {
      const priorReview = {
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Resume detail.' }],
        qualityReview: {
          checklistVersion: 3,
          criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' }],
          resume: { decision: 'drafted', rationale: 'Stale rationale describing the résumé before the patch.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale text, still true.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Summary.',
        },
      };
      // staleSinceBaseline: the résumé is stale relative to this baseline,
      // the cover letter is not — the same shape `changed` has, since this
      // scenario does not need the two signals to diverge (the tests further
      // below in this file exercise that).
      const resumeStaleOnly = { resume: true, coverLetter: false };
      const baseDelta = {
        decision: 'pass', findings: [], patches: [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: 'x', evidenceIds: ['cd-1'] } }],
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Updated resume detail.' }],
        qualityReview: { criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Updated resume evidence measured.' }] },
        generationAudit: {
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Updated justification.' }],
          resumePlan: { strategy: 'Updated strategy.', selectionRationale: 'Updated selection.' },
          finalDecisionSummary: 'Updated summary describing the patched résumé.',
        },
      };

      // Résumé changed, qualityReview.resume omitted: the prior value exists
      // but must be REFUSED, not silently reused — this is the hole the
      // finding names, closed.
      const omitted = mergePasteReviewDelta(priorReview, baseDelta, resumeStaleOnly);
      assert(omitted.review === null, 'a résumé change with no fresh qualityReview.resume must null out the review');
      assert(omitted.errors.some(message => /qualityReview\.resume/.test(message) && /résumé/.test(message)),
        `expected an error naming qualityReview.resume and the résumé change, got ${JSON.stringify(omitted.errors)}`);
      assert(!omitted.errors.some(message => /qualityReview\.coverLetter/.test(message)),
        'an unchanged cover letter must not also demand a fresh qualityReview.coverLetter');

      // Same delta, qualityReview.resume supplied: accepted, and the fresh
      // rationale wins.
      const supplied = mergePasteReviewDelta(priorReview, {
        ...baseDelta,
        qualityReview: { ...baseDelta.qualityReview, resume: { decision: 'drafted', rationale: 'Fresh rationale describing the patched résumé.' } },
      }, resumeStaleOnly);
      assert(supplied.errors.length === 0, `expected no errors once qualityReview.resume is supplied, got ${JSON.stringify(supplied.errors)}`);
      assert(supplied.review.qualityReview.resume.rationale === 'Fresh rationale describing the patched résumé.', 'the delta-supplied qualityReview.resume must win');
      // The cover letter never changed: its rationale is still true, so it
      // carries forward exactly like any other untouched slot.
      assert(supplied.review.qualityReview.coverLetter.rationale === 'Cover rationale text, still true.', 'an unchanged document’s qualityReview rationale must still carry forward');
      return { ok: true };
    },
  },
  {
    name: 'mergePasteReviewDelta: generationAudit.resumePlan is refused as a carry-forward once the résumé changed, even though the prior review still has a value',
    run: () => {
      const priorReview = {
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Resume detail.' }],
        qualityReview: {
          checklistVersion: 3,
          criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' }],
          resume: { decision: 'drafted', rationale: 'Resume rationale text.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale text.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
          resumePlan: { strategy: 'Stale strategy describing the résumé before the patch.', selectionRationale: 'Stale selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Summary.',
        },
      };
      const baseDelta = {
        decision: 'pass', findings: [], patches: [],
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Updated resume detail.' }],
        qualityReview: { criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Updated resume evidence measured.' }], resume: { decision: 'drafted', rationale: 'Updated resume rationale.' } },
        generationAudit: { jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed.' }], finalDecisionSummary: 'Updated summary.' },
      };
      const resumeStaleOnly = { resume: true, coverLetter: false };

      const omitted = mergePasteReviewDelta(priorReview, baseDelta, resumeStaleOnly);
      assert(omitted.review === null, 'a résumé change with no fresh resumePlan must null out the review');
      assert(omitted.errors.some(message => /resumePlan/.test(message) && /résumé/.test(message)),
        `expected a resumePlan error naming the résumé change, got ${JSON.stringify(omitted.errors)}`);

      const supplied = mergePasteReviewDelta(priorReview, {
        ...baseDelta,
        generationAudit: { ...baseDelta.generationAudit, resumePlan: { strategy: 'Fresh strategy describing the patched résumé.', selectionRationale: 'Fresh selection rationale.' } },
      }, resumeStaleOnly);
      assert(supplied.errors.length === 0, `expected no errors once resumePlan is supplied, got ${JSON.stringify(supplied.errors)}`);
      assert(supplied.review.generationAudit.resumePlan.strategy === 'Fresh strategy describing the patched résumé.', 'the delta-supplied resumePlan must win');
      return { ok: true };
    },
  },
  {
    name: 'mergePasteReviewDelta: generationAudit.finalDecisionSummary is refused as a carry-forward once EITHER document changed, because it describes both',
    run: () => {
      const priorReview = {
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Resume detail.' }, { id: 'cover-crit', status: 'pass', detail: 'Cover detail.' }],
        qualityReview: {
          checklistVersion: 3,
          criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' }, { id: 'cover-crit', status: 'pass', evidence: 'Cover evidence measured directly.' }],
          resume: { decision: 'drafted', rationale: 'Resume rationale text.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale text.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Original summary describing both documents.',
        },
      };
      const baseDelta = {
        decision: 'pass', findings: [], patches: [],
        checklist: [{ id: 'cover-crit', status: 'pass', detail: 'Updated cover detail.' }],
        qualityReview: { criteria: [{ id: 'cover-crit', status: 'pass', evidence: 'Updated cover evidence measured.' }], coverLetter: { decision: 'drafted', rationale: 'Updated cover rationale.' } },
        generationAudit: { jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed.' }] },
      };
      const coverLetterStaleOnly = { resume: false, coverLetter: true };

      const omitted = mergePasteReviewDelta(priorReview, baseDelta, coverLetterStaleOnly);
      assert(omitted.review === null, 'a cover-letter-only change with no fresh finalDecisionSummary must null out the review');
      assert(omitted.errors.some(message => /finalDecisionSummary/.test(message)),
        `expected a finalDecisionSummary error even though only the cover letter changed (it describes both documents), got ${JSON.stringify(omitted.errors)}`);

      const supplied = mergePasteReviewDelta(priorReview, {
        ...baseDelta,
        generationAudit: { ...baseDelta.generationAudit, finalDecisionSummary: 'Updated summary reflecting the patched cover letter.' },
      }, coverLetterStaleOnly);
      assert(supplied.errors.length === 0, `expected no errors once finalDecisionSummary is supplied, got ${JSON.stringify(supplied.errors)}`);
      assert(supplied.review.generationAudit.finalDecisionSummary === 'Updated summary reflecting the patched cover letter.', 'the delta-supplied finalDecisionSummary must win');
      return { ok: true };
    },
  },
  {
    name: 'mergePasteReviewDelta: generationAudit.jobPriorities cannot be merged per requirement once stale — resupplied WHOLE from the delta, or refused whole',
    run: () => {
      const priorReview = {
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Resume detail.' }],
        qualityReview: {
          checklistVersion: 3,
          criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Resume evidence measured directly.' }],
          resume: { decision: 'drafted', rationale: 'Resume rationale text.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale text.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [
            { requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text for req-1.' },
            { requirement: 'req-2', priority: 'high', disposition: 'addressed-cover-letter', justification: 'Justification text for req-2.' },
          ],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Summary.',
        },
      };
      const baseDelta = {
        decision: 'pass', findings: [], patches: [],
        checklist: [{ id: 'resume-crit', status: 'pass', detail: 'Updated resume detail.' }],
        qualityReview: { criteria: [{ id: 'resume-crit', status: 'pass', evidence: 'Updated resume evidence measured.' }], resume: { decision: 'drafted', rationale: 'Updated resume rationale.' } },
        generationAudit: { resumePlan: { strategy: 'Updated strategy.', selectionRationale: 'Updated selection.' }, finalDecisionSummary: 'Updated summary.' },
      };
      const resumeStale = { resume: true, coverLetter: false };

      // Stale, jobPriorities omitted entirely: refused. The prior array
      // exists but is not silently reused — unlike checklist/criteria, there
      // is no "req-2 didn't change" carry-forward for a field whose entries
      // can address either document regardless of which one a patch touched.
      const omitted = mergePasteReviewDelta(priorReview, baseDelta, resumeStale);
      assert(omitted.review === null, 'a stale jobPriorities with no delta value must null out the review');
      assert(omitted.errors.some(message => /jobPriorities/.test(message) && /resupplied whole/.test(message)),
        `expected a jobPriorities resupply-whole error, got ${JSON.stringify(omitted.errors)}`);

      // Stale, jobPriorities supplied but covering only ONE of the two prior
      // requirements: this function does not itself check coverage (that is
      // missingPasteReviewDeltaEntries's job, in localAiApplication.js) — it
      // takes the delta's array WHOLE, dropping req-2 rather than reaching
      // back into the (once-stale, now unverifiable) prior entry for it.
      const partial = mergePasteReviewDelta(priorReview, {
        ...baseDelta,
        generationAudit: { ...baseDelta.generationAudit, jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed for req-1 against the patched résumé.' }] },
      }, resumeStale);
      assert(partial.errors.length === 0, `a non-empty resupply must be accepted by this function; coverage is a different gate's job: ${JSON.stringify(partial.errors)}`);
      assert(partial.review.generationAudit.jobPriorities.length === 1 && partial.review.generationAudit.jobPriorities[0].requirement === 'req-1',
        'jobPriorities is taken WHOLE from the delta once stale — req-2 is dropped, never silently reached back into the baseline for');

      // Not stale: the prior array carries forward whole, exactly as before
      // this fix.
      const notStale = mergePasteReviewDelta(priorReview, baseDelta, { resume: false, coverLetter: false });
      assert(notStale.errors.length === 0, `expected no errors when nothing is stale, got ${JSON.stringify(notStale.errors)}`);
      assert(notStale.review.generationAudit.jobPriorities.length === 2, 'an unstale jobPriorities carries forward from the baseline whole when the delta omits it');
      return { ok: true };
    },
  },
  {
    // THE SIXTH unverifiable field (pasteReviewDelta.js's header): found
    // while confirming the other five, not named by the review round that
    // ordered this fix — reported as instructed. Unlike checklist (never
    // read again downstream, so it needs no backstop at all),
    // qualityReview.criteria DOES ship in the assembled result, so it gets
    // the same fail-closed backstop as the other five — independent of, and
    // in addition to, its own (unchanged, patch-level) courtesy
    // required-list.
    name: 'mergePasteReviewDelta: qualityReview.criteria refuses a stale, unsupplied entry once its own scoped document changed — a BACKSTOP independent of checklist',
    run: () => {
      const criteriaCatalog = [
        { id: 'resume-only', document: 'resume' },
        { id: 'cover-only', document: 'coverLetter' },
        { id: 'bundle-wide', document: 'bundle' },
      ];
      const priorReview = {
        checklist: [
          { id: 'resume-only', status: 'pass', detail: 'Resume detail.' },
          { id: 'cover-only', status: 'pass', detail: 'Cover detail.' },
          { id: 'bundle-wide', status: 'pass', detail: 'Bundle detail.' },
        ],
        qualityReview: {
          checklistVersion: 3,
          criteria: [
            { id: 'resume-only', status: 'pass', evidence: 'Resume evidence measured directly.' },
            { id: 'cover-only', status: 'pass', evidence: 'Cover evidence measured directly.' },
            { id: 'bundle-wide', status: 'pass', evidence: 'Stale bundle evidence describing the résumé before the patch.' },
          ],
          resume: { decision: 'drafted', rationale: 'Resume rationale.' },
          coverLetter: { decision: 'drafted', rationale: 'Cover rationale.' },
        },
        generationAudit: {
          version: 3,
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
          resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
          coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
          finalDecisionSummary: 'Summary.',
        },
      };
      const baseDelta = {
        decision: 'pass', findings: [], patches: [],
        checklist: [{ id: 'resume-only', status: 'pass', detail: 'Updated resume detail.' }],
        qualityReview: { criteria: [{ id: 'resume-only', status: 'pass', evidence: 'Updated resume evidence measured.' }], resume: { decision: 'drafted', rationale: 'Updated resume rationale.' } },
        generationAudit: {
          jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed.' }],
          resumePlan: { strategy: 'Updated strategy.', selectionRationale: 'Updated selection.' },
          finalDecisionSummary: 'Updated summary.',
        },
      };
      const resumeStaleOnly = { resume: true, coverLetter: false };

      // Without the catalog, the backstop is INERT: every id resolves to no
      // known document, so bundle-wide's stale entry carries forward
      // unrefused, exactly as checklist's sibling entry does (checklist has
      // no backstop at all, catalog or not).
      const inert = mergePasteReviewDelta(priorReview, baseDelta, resumeStaleOnly);
      assert(inert.errors.length === 0, `omitting the criteria catalog must leave the backstop inert, got ${JSON.stringify(inert.errors)}`);
      assert(inert.review.checklist.find(entry => entry.id === 'bundle-wide').detail === 'Bundle detail.', 'checklist always carries a stale entry forward; it has no backstop');
      assert(inert.review.qualityReview.criteria.find(entry => entry.id === 'bundle-wide').evidence === 'Stale bundle evidence describing the résumé before the patch.',
        'without a criteria catalog the backstop cannot resolve any id to a document, so it refuses nothing');

      // With the catalog: bundle-wide is scoped to 'bundle', invalidated by
      // EITHER document changing (matching requiredPasteReviewDeltaEntries's
      // own bundle handling) — refused outright, not silently carried
      // forward.
      const guarded = mergePasteReviewDelta(priorReview, baseDelta, resumeStaleOnly, criteriaCatalog);
      assert(guarded.review === null, 'a stale bundle-scoped criterion with no fresh delta entry must null out the review once a catalog is supplied');
      assert(guarded.errors.some(message => /qualityReview\.criteria "bundle-wide"/.test(message)),
        `expected a qualityReview.criteria error naming bundle-wide, got ${JSON.stringify(guarded.errors)}`);
      assert(!guarded.errors.some(message => /qualityReview\.criteria "cover-only"/.test(message)),
        'an unstale cover-only criterion must not be refused by a résumé-only change');

      // Supplying bundle-wide fresh is accepted, and the untouched cover-only
      // entry still carries forward byte-identical.
      const suppliedFresh = mergePasteReviewDelta(priorReview, {
        ...baseDelta,
        qualityReview: { ...baseDelta.qualityReview, criteria: [...baseDelta.qualityReview.criteria, { id: 'bundle-wide', status: 'pass', evidence: 'Fresh bundle evidence describing the patched résumé.' }] },
      }, resumeStaleOnly, criteriaCatalog);
      assert(suppliedFresh.errors.length === 0, `expected no errors once bundle-wide is resupplied, got ${JSON.stringify(suppliedFresh.errors)}`);
      assert(suppliedFresh.review.qualityReview.criteria.find(entry => entry.id === 'bundle-wide').evidence === 'Fresh bundle evidence describing the patched résumé.',
        'the delta-supplied bundle-wide criterion must win');
      assert(suppliedFresh.review.qualityReview.criteria.find(entry => entry.id === 'cover-only').evidence === 'Cover evidence measured directly.',
        'an unstale cover-only criterion still carries forward byte-identical');
      return { ok: true };
    },
  },
  {
    name: 'requiredPasteReviewDeltaEntries: criterion scope follows each criterion’s own document field, and paragraph indexes are flagged only once a paragraph actually changed',
    run: () => {
      const criteria = [
        { id: 'resume-only', document: 'resume', requirement: 'x' },
        { id: 'cover-only', document: 'coverLetter', requirement: 'y' },
        { id: 'bundle-wide', document: 'bundle', requirement: 'z' },
      ];
      // A COMPLETE baseline on purpose: this test isolates what staleness
      // alone scopes (needs* must follow staleSinceBaseline, not `changed`)
      // from FINDING B's own concern (a baseline slot simply ABSENT also
      // forces a needs* signal, covered by its own dedicated test below) —
      // a baseline missing resumePlan/finalDecisionSummary/qualityReview
      // here would make the "no change" assertions below fail for the
      // wrong reason. qualityReview.criteria covers all three catalog ids for
      // the identical reason: criterionIds now ALSO widens for a baseline id
      // with no entry at all (mirroring FINDING B one level down — its own
      // dedicated test lives below, next to FINDING B's), and this test's
      // "no change invalidates nothing" assertions would fail for that
      // unrelated reason if left uncovered here.
      const priorReview = {
        qualityReview: {
          resume: { rationale: 'Resume rationale.' }, coverLetter: { rationale: 'Cover rationale.' },
          criteria: criteria.map(({ id }) => ({ id, status: 'pass', evidence: `Existing evidence for ${id}.` })),
        },
        generationAudit: {
          coverLetterPlan: { paragraphs: [{}, {}, {}] },
          jobPriorities: [{ requirement: 'req-1' }, { requirement: 'req-2' }],
          resumePlan: { strategy: 'Strategy.' },
          finalDecisionSummary: 'Summary.',
        },
      };

      // In every case below, `changed` and `staleSinceBaseline` are passed
      // the SAME object: these scenarios test what each signal scopes, not
      // whether they can diverge — the divergent case at the end of this
      // test covers that.
      const nothing = requiredPasteReviewDeltaEntries(priorReview, noChange(), criteria, noChange());
      assert(nothing.checklistIds.length === 0 && nothing.criterionIds.length === 0, 'no change invalidates nothing');
      assert(nothing.auditParagraphIndexes.length === 0, 'no paragraph change means no paragraph index is required');
      assert(nothing.needsResumePlan === false && nothing.needsJobPriorityRequirements === false, 'no change needs no plan/priority resupply');
      assert(nothing.needsFinalDecisionSummary === false, 'no change needs no finalDecisionSummary resupply');
      assert(nothing.needsResumeQualityReview === false && nothing.needsCoverLetterQualityReview === false, 'no change needs no qualityReview.resume/coverLetter resupply');
      assert(nothing.jobPriorityRequirements.length === 0, 'jobPriorityRequirements is only populated when a resupply is actually needed');

      const resumeChanged = { ...noChange(), resume: true, changedBulletIds: ['bullet-1'] };
      const resumeOnly = requiredPasteReviewDeltaEntries(priorReview, resumeChanged, criteria, resumeChanged);
      // [...].sort() — never resumeOnly.checklistIds.sort() in place: Array#sort
      // mutates its receiver, and the equality check below (resumeOnly
      // .checklistIds vs .criterionIds) needs checklistIds untouched. Before
      // this fix the two fields were literally the same array reference
      // (`criterionIds: invalidatedIds`), so an in-place sort here silently
      // reordered both and the check below could never catch it; now that
      // they are genuinely separate arrays, a destructive sort on one alone
      // would desync them from under that check.
      assert([...resumeOnly.checklistIds].sort().join(',') === 'bundle-wide,resume-only', `resume-scoped and bundle-scoped criteria must be required, got ${resumeOnly.checklistIds}`);
      assert(!resumeOnly.checklistIds.includes('cover-only'), 'a criterion scoped only to the unchanged document must carry forward');
      assert(resumeOnly.auditParagraphIndexes.length === 0, 'a résumé-only change must not require any paragraph audit entry');
      assert(resumeOnly.needsResumePlan === true, 'a résumé change requires resumePlan resupply');
      assert(resumeOnly.needsJobPriorityRequirements === true, 'a résumé change requires jobPriorities resupply');
      assert(resumeOnly.needsFinalDecisionSummary === true, 'a résumé change requires finalDecisionSummary resupply — it describes both documents');
      assert(resumeOnly.needsResumeQualityReview === true, 'a résumé change requires qualityReview.resume resupply');
      assert(resumeOnly.needsCoverLetterQualityReview === false, 'a résumé-only change must not require qualityReview.coverLetter resupply');
      assert(JSON.stringify(resumeOnly.jobPriorityRequirements) === JSON.stringify(['req-1', 'req-2']),
        `jobPriorityRequirements must name every requirement the baseline covered, got ${JSON.stringify(resumeOnly.jobPriorityRequirements)}`);

      const coverChanged = { ...noChange(), coverLetter: true, changedParagraphIds: ['p2'] };
      const coverOnly = requiredPasteReviewDeltaEntries(priorReview, coverChanged, criteria, coverChanged);
      assert([...coverOnly.checklistIds].sort().join(',') === 'bundle-wide,cover-only', `cover-scoped and bundle-scoped criteria must be required, got ${coverOnly.checklistIds}`);
      assert(coverOnly.needsResumePlan === false, 'a cover-letter-only change does not require resumePlan resupply');
      assert(coverOnly.auditParagraphIndexes.join(',') === '0,1,2', 'any paragraph change conservatively flags every prior paragraph index');
      assert(coverOnly.needsFinalDecisionSummary === true, 'a cover-letter change also requires finalDecisionSummary resupply — it describes both documents');
      assert(coverOnly.needsCoverLetterQualityReview === true, 'a cover-letter change requires qualityReview.coverLetter resupply');
      assert(coverOnly.needsResumeQualityReview === false, 'a cover-letter-only change must not require qualityReview.resume resupply');

      // Same criteria/id lists appear on both output fields, since checklist
      // and qualityReview.criteria merge as two separately-shaped arrays
      // over the identical invalidated id set.
      assert(JSON.stringify(resumeOnly.checklistIds) === JSON.stringify(resumeOnly.criterionIds), 'checklistIds and criterionIds must agree on the invalidated set');

      // THE TWO SIGNALS ARE INDEPENDENT (pasteReviewDelta.js's header): a
      // round with no patches of its own (`changed` all false — the shape
      // every accepted 'pass' round reports) can still find the résumé
      // stale relative to the baseline, because staleSinceBaseline is
      // measured from durable hashes, not from this round's own patch list.
      // checklistIds/criterionIds/auditParagraphIndexes must follow
      // `changed` regardless; needs* must follow staleSinceBaseline
      // regardless. This is the exact shape of THE STALE BASELINE repro
      // (module header) once mid-fixed: round B's own patches touch
      // nothing, but the résumé is still stale from round A.
      const divergent = requiredPasteReviewDeltaEntries(priorReview, noChange(), criteria, { resume: true, coverLetter: false });
      assert(divergent.checklistIds.length === 0 && divergent.criterionIds.length === 0 && divergent.auditParagraphIndexes.length === 0,
        `checklistIds/criterionIds/auditParagraphIndexes must follow \`changed\`, which reports nothing touched here, got ${JSON.stringify(divergent)}`);
      assert(divergent.needsResumePlan === true && divergent.needsJobPriorityRequirements === true
        && divergent.needsFinalDecisionSummary === true && divergent.needsResumeQualityReview === true && divergent.needsCoverLetterQualityReview === false,
      `needs* fields must follow staleSinceBaseline, which reports the résumé stale here even though \`changed\` reports nothing touched, got ${JSON.stringify(divergent)}`);
      return { ok: true };
    },
  },
  {
    // FINDING B (2026-09-22 adversarial review): a FULL (non-delta)
    // 'revised' round is structurally allowed to omit
    // generationAudit/qualityReview entirely — validatePasteResponse
    // requires them only for decision:'pass' — so the baseline it mints can
    // lack these five slots with NEITHER document stale. Before this fix,
    // requiredPasteReviewDeltaEntries asked staleSinceBaseline alone, so it
    // told the NEXT round's prompt to omit a slot mergePasteReviewDelta's
    // own `== null` check was always going to refuse regardless — rejecting
    // a round for a field its own printed contract never asked for. A
    // baseline slot that is simply ABSENT must be required on the same
    // terms as one that went stale, with no document needing to have
    // changed at all.
    name: 'requiredPasteReviewDeltaEntries: a baseline missing a slot entirely (never stale) requires it exactly as staleness would, and never invents a jobPriorityRequirements list it cannot name',
    run: () => {
      const criteria = [
        { id: 'resume-only', document: 'resume', requirement: 'x' },
        { id: 'cover-only', document: 'coverLetter', requirement: 'y' },
      ];
      // The exact shape a FULL 'revised' round's baseline takes when it
      // omits generationAudit/the qualityReview RATIONALES outright:
      // checklist/decision survive (checklist is required on every review
      // round, revised or pass — pasteReviewDelta.js's header does not name
      // it as optional), and generationAudit is absent, not merely partially
      // filled. qualityReview.criteria is deliberately kept FULL here (unlike
      // resume/coverLetter, both absent): criterionIds now widens for a
      // baseline criterion id with no entry at all, the identical shape one
      // level down (its own dedicated test sits right after this one), and
      // this test isolates the ORIGINAL five FINDING-B fields from that
      // extension rather than conflating the two.
      const baselineMissingAudit = {
        decision: 'revised', findings: [], checklist: [{ id: 'resume-only', status: 'pass', detail: 'x' }],
        qualityReview: { criteria: criteria.map(({ id }) => ({ id, status: 'pass', evidence: `Existing evidence for ${id}.` })) },
      };

      // No patches, nothing stale — the exact signal shape a confirming
      // 'pass' round with an empty patch list reports.
      const required = requiredPasteReviewDeltaEntries(baselineMissingAudit, noChange(), criteria, noChange());
      assert(required.checklistIds.length === 0 && required.criterionIds.length === 0 && required.auditParagraphIndexes.length === 0,
        `an absent baseline slot must not affect the change-scoped courtesy lists, only the needs* signals, got ${JSON.stringify(required)}`);
      assert(required.needsResumePlan === true, 'a baseline with no resumePlan at all must require one, even with nothing stale');
      assert(required.needsJobPriorityRequirements === true, 'a baseline with no jobPriorities at all must require resupply, even with nothing stale');
      assert(required.needsFinalDecisionSummary === true, 'a baseline with no finalDecisionSummary at all must require one, even with nothing stale');
      assert(required.needsResumeQualityReview === true, 'a baseline with no qualityReview.resume at all must require one, even with nothing stale');
      assert(required.needsCoverLetterQualityReview === true, 'a baseline with no qualityReview.coverLetter at all must require one, even with nothing stale');
      // There is nothing in this baseline to name: missingPasteReviewDeltaEntries
      // must still demand the resupply (needsJobPriorityRequirements is
      // true), but cannot ask a round to "cover" requirements the baseline
      // never recorded in the first place.
      assert(Array.isArray(required.jobPriorityRequirements) && required.jobPriorityRequirements.length === 0,
        `jobPriorityRequirements must be empty when the baseline has no jobPriorities to name, got ${JSON.stringify(required.jobPriorityRequirements)}`);

      // A delta that follows the OLD (pre-fix) instruction — "nothing
      // changed, so omit everything" — must be refused by the merge exactly
      // as it would be refused for genuine staleness: the printed contract
      // and the merge's own refusal must never disagree about what a round
      // owes.
      const compliantOldInstruction = { decision: 'pass', findings: [], patches: [] };
      const { review: refusedReview, errors: refusalErrors } = mergePasteReviewDelta(baselineMissingAudit, compliantOldInstruction, noChange(), criteria);
      assert(refusedReview === null, 'a delta that omits every absent slot must still be refused by the merge, not silently accepted with invented values');
      for (const field of ['qualityReview.resume', 'qualityReview.coverLetter', 'generationAudit.jobPriorities', 'generationAudit.resumePlan', 'generationAudit.finalDecisionSummary']) {
        assert(refusalErrors.some(message => message.includes(field)), `expected the merge to name ${field} among its errors, got ${JSON.stringify(refusalErrors)}`);
      }

      // Resupplying every slot required's needs* flags name is accepted —
      // the prompt/gate agreement this fix exists for: nothing is demanded
      // that requiredPasteReviewDeltaEntries did not already flag.
      const compliantFix = {
        decision: 'pass', findings: [], patches: [],
        qualityReview: { resume: { rationale: 'Fresh resume rationale.' }, coverLetter: { rationale: 'Fresh cover rationale.' } },
        generationAudit: {
          jobPriorities: [{ requirement: 'x', priority: 'highest', disposition: 'addressed-resume', justification: 'Fresh justification.' }],
          resumePlan: { strategy: 'Fresh strategy.' },
          // controllingThesis is outside FINDING B's five fields — it has no
          // needs* signal at all, carried forward or refused purely on
          // whether EITHER side supplies it (module doc comment above
          // mergePasteReviewDelta) — so a baseline missing it, same as here,
          // demands it regardless, independent of this fix.
          coverLetterPlan: { controllingThesis: 'Fresh thesis.' },
          finalDecisionSummary: 'Fresh summary.',
        },
      };
      const { review: acceptedReview, errors: acceptedErrors } = mergePasteReviewDelta(baselineMissingAudit, compliantFix, noChange(), criteria);
      assert(acceptedErrors.length === 0, `supplying exactly what needs* demanded must merge cleanly, got ${JSON.stringify(acceptedErrors)}`);
      assert(acceptedReview.qualityReview.resume.rationale === 'Fresh resume rationale.', 'the freshly-supplied qualityReview.resume must win');
      assert(acceptedReview.generationAudit.finalDecisionSummary === 'Fresh summary.', 'the freshly-supplied finalDecisionSummary must win');
      return { ok: true };
    },
  },
  {
    // THE DEFECT (found independently by two reviewers, confirmed by reading
    // the code): mergeGradedCriteria used to source its merged array's id
    // list from `priorList` — the baseline's OWN qualityReview.criteria —
    // instead of the criteria catalog. validatePasteResponse requires
    // qualityReview only for decision:'pass' (module header, THE UNVERIFIABLE
    // SET), so a full, non-delta 'revised' round can legally mint a baseline
    // with NO qualityReview.criteria at all. `ids` sourced from that empty
    // `priorList` was then always empty too, so the merge returned an EMPTY
    // criteria array no matter what the delta supplied — even the complete
    // canonical list — rejected by validatePasteResponse's "every canonical
    // criterion, in order" gate for a shape nothing in this module ever named
    // as a defect to fix. Sourcing `ids` from the catalog instead (this
    // file's mergeGradedCriteria, current version) makes a baseline missing
    // qualityReview.criteria entirely — or merely holding an empty array,
    // checked separately below — resolvable by resupplying it, and makes the
    // "not supplied by the delta and the prior review has no entry to carry
    // forward" branch name exactly the ids a short resupply left out, instead
    // of staying permanently unreachable (its old, pre-fix condition could
    // never be true: every id it iterated already came from priorById's own
    // keys).
    name: 'mergePasteReviewDelta: a baseline with no qualityReview.criteria to carry forward still merges a delta supplying the full canonical list to the complete canonical array, in canonical order; a short resupply is rejected by name',
    run: () => {
      const criteriaCatalog = APPLICATION_QUALITY_CRITERIA.map(({ id, document }) => ({ id, document }));
      const canonicalIds = APPLICATION_QUALITY_CRITERIA.map(criterion => criterion.id);
      const fullCriteria = () => APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `Confirmed directly: ${requirement}` }));
      const fullChecklist = () => APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id}.` }));
      const fullGenerationAudit = {
        version: LOCAL_AI_GENERATION_AUDIT_VERSION,
        jobPriorities: [{ requirement: 'req-1', priority: 'highest', disposition: 'addressed-both', justification: 'Justification text.' }],
        resumePlan: { strategy: 'Strategy text.', selectionRationale: 'Selection rationale.' },
        coverLetterPlan: { controllingThesis: 'Thesis.', paragraphs: [{ paragraph: 'Only paragraph.', argumentativeJob: 'Job.', relationToThesis: 'Relation.', relationToPreviousParagraph: 'opening', sentences: [] }] },
        finalDecisionSummary: 'Summary.',
      };
      // checklist/generationAudit are COMPLETE on both baselines below — this
      // test isolates qualityReview.criteria's own id-sourcing defect from
      // every other merged field, which already has its own dedicated
      // coverage above.
      const baselineNoQualityReview = { checklist: fullChecklist(), generationAudit: fullGenerationAudit };
      const baselineEmptyCriteria = {
        ...baselineNoQualityReview,
        qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: [], resume: { decision: 'approved', rationale: 'Resume rationale.' }, coverLetter: { decision: 'approved', rationale: 'Cover rationale.' } },
      };
      const noChangeSignal = { resume: false, coverLetter: false };

      for (const [label, baseline] of [['qualityReview entirely absent', baselineNoQualityReview], ['qualityReview.criteria present but empty', baselineEmptyCriteria]]) {
        const fullDelta = {
          decision: 'pass', findings: [], patches: [],
          qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: fullCriteria(), resume: { decision: 'approved', rationale: 'Fresh résumé rationale.' }, coverLetter: { decision: 'approved', rationale: 'Fresh cover rationale.' } },
        };
        const { review, errors } = mergePasteReviewDelta(baseline, fullDelta, noChangeSignal, criteriaCatalog);
        assert(errors.length === 0, `[${label}] a delta supplying the full canonical criteria list must merge cleanly, got ${JSON.stringify(errors)}`);
        assert(JSON.stringify(review.qualityReview.criteria.map(entry => entry.id)) === JSON.stringify(canonicalIds),
          `[${label}] the merged qualityReview.criteria must list every canonical criterion, in canonical order, got ${JSON.stringify(review?.qualityReview?.criteria?.map(entry => entry.id))}`);

        // A delta supplying only SOME of the canonical ids: rejected, naming
        // exactly the ones it left out — never silently merged to a short
        // array (THE DEFECT: the pre-fix code merged this case to [], with no
        // error at all, because `ids` was always priorList's own, empty, keys).
        const partialIds = new Set(canonicalIds.slice(0, 3));
        const partialDelta = { ...fullDelta, qualityReview: { ...fullDelta.qualityReview, criteria: fullCriteria().filter(entry => partialIds.has(entry.id)) } };
        const partial = mergePasteReviewDelta(baseline, partialDelta, noChangeSignal, criteriaCatalog);
        assert(partial.review === null, `[${label}] a delta supplying only 3 of ${canonicalIds.length} canonical criteria ids must null out the review, not silently accept a short array`);
        const missingIds = canonicalIds.filter(id => !partialIds.has(id));
        for (const id of missingIds) {
          assert(partial.errors.some(message => message.includes(`qualityReview.criteria "${id}"`)),
            `[${label}] expected an error naming missing criterion "${id}", got ${JSON.stringify(partial.errors)}`);
        }
      }
      return { ok: true };
    },
  },
  {
    // The prompt/gate agreement half of THE DEFECT above, one level up:
    // requiredPasteReviewDeltaEntries must ask for a baseline-missing
    // criterion id on the SAME terms mergeGradedCriteria's own "no entry to
    // carry forward" branch already refuses it on — the identical shape
    // FINDING B gave the five unverifiable fields (staleSinceBaseline OR
    // baseline-slot-is-null), applied here per criterion id instead of per
    // whole slot.
    name: 'requiredPasteReviewDeltaEntries: a baseline with no qualityReview.criteria entry for an id requires that id, even with nothing stale and `changed` invalidating nothing',
    run: () => {
      const criteria = [
        { id: 'resume-only', document: 'resume', requirement: 'x' },
        { id: 'cover-only', document: 'coverLetter', requirement: 'y' },
        { id: 'bundle-wide', document: 'bundle', requirement: 'z' },
      ];
      const canonicalIds = criteria.map(criterion => criterion.id);

      // qualityReview.criteria entirely absent: every catalog id is
      // required, even though `changed`/staleSinceBaseline report nothing.
      const baselineNoCriteria = { checklist: [], generationAudit: {} };
      const required = requiredPasteReviewDeltaEntries(baselineNoCriteria, noChange(), criteria, noChange());
      assert(JSON.stringify(required.criterionIds) === JSON.stringify(canonicalIds),
        `a baseline with no qualityReview.criteria at all must require every canonical id even with nothing stale, got ${JSON.stringify(required.criterionIds)}`);
      assert(required.checklistIds.length === 0,
        'checklistIds must stay scoped to `changed` alone — checklist has no equivalent "baseline never captured this id" gap (mergeById\'s own comment)');

      // A baseline that holds an entry for every id but one: only that one
      // id is required.
      const baselineMissingOne = { ...baselineNoCriteria, qualityReview: { criteria: criteria.slice(1).map(({ id }) => ({ id, status: 'pass', evidence: 'Existing evidence.' })) } };
      const partialRequired = requiredPasteReviewDeltaEntries(baselineMissingOne, noChange(), criteria, noChange());
      assert(JSON.stringify(partialRequired.criterionIds) === JSON.stringify([canonicalIds[0]]),
        `a baseline missing exactly one criterion id must require exactly that id, got ${JSON.stringify(partialRequired.criterionIds)}`);

      // A baseline that holds every id: nothing is required, and `changed`
      // invalidating one id still requires exactly that one (unaffected by
      // this fix — the ordinary courtesy-scoping path).
      const baselineComplete = { ...baselineNoCriteria, qualityReview: { criteria: criteria.map(({ id }) => ({ id, status: 'pass', evidence: 'Existing evidence.' })) } };
      const completeRequired = requiredPasteReviewDeltaEntries(baselineComplete, noChange(), criteria, noChange());
      assert(completeRequired.criterionIds.length === 0, 'a baseline holding every canonical id must require nothing when nothing changed');
      const resumeChanged = { ...noChange(), resume: true };
      const changedRequired = requiredPasteReviewDeltaEntries(baselineComplete, resumeChanged, criteria, resumeChanged);
      assert([...changedRequired.criterionIds].sort().join(',') === 'bundle-wide,resume-only',
        `a complete baseline with a résumé change must still require exactly the résumé/bundle-scoped ids, got ${changedRequired.criterionIds}`);
      return { ok: true };
    },
  },
  {
    // FINDING 3 coverage (2026-09-22 adversarial review): every other test in
    // this file scopes checklist/qualityReview.criteria/generationAudit down
    // to a 2-3 entry toy fixture, and paste-application-fit-save.js's own
    // delta-vs-full test deliberately supplies those three IN FULL on both
    // sides "precisely so this test isolates document reconstruction" — so
    // nothing shipped ever proved the sparse path's actual byte savings at
    // realistic scale against the REAL 24-entry APPLICATION_QUALITY_CRITERIA.
    // A change that broke the sparse-entry omission (requiredPasteReviewDeltaEntries
    // scoping, or a caller that stopped trimming to it) while still producing
    // correct documents would pass every other test in this suite.
    name: 'a résumé-only delta at realistic scale omits every coverLetter-scoped entry, reconstructs the canonical arrays by merge, and saves a material fraction of the round',
    run: () => {
      // Two roles, six bullets on the current one, a project, two skill
      // groups, four cover-letter paragraphs with a two-part
      // coverLetterArgument — the same shape and rough proportions as the
      // job that motivated this module (this file's own header: a real
      // accepted review response was 24,147 bytes, 77% bookkeeping).
      const bullets = Array.from({ length: 6 }, (unused, index) => ({
        id: `bullet-${index}`,
        text: `Led a cross-functional initiative to modernize the internal reporting pipeline, cutting manual reconciliation effort by a measurable double-digit percentage across three quarters, item ${index}.`,
        evidenceIds: [`cd-${index}`, `cd-${index}-b`],
      }));
      const resume = {
        schemaVersion: 'structured-resume.v1',
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test', '555-0100'], credential: 'B.S. Computer Science' },
        roles: [
          { id: 'role-1', title: 'Senior Software Engineer', company: 'Acme Systems', dates: '2020 - 2024', location: 'Remote', bullets },
          { id: 'role-2', title: 'Software Engineer', company: 'Prior Co', dates: '2017 - 2020', location: 'New York, NY', bullets: bullets.slice(0, 3).map((bullet, index) => ({ ...bullet, id: `old-bullet-${index}` })) },
        ],
        projects: [{ id: 'proj-1', name: 'Widget Platform', description: 'A cross-team internal tooling platform used by 40 engineers.', metrics: 'Cut onboarding time by 30%.', evidenceIds: ['cd-proj-1'] }],
        skills: [
          { id: 'skill-1', group: 'Languages', items: ['JavaScript', 'TypeScript', 'Python'], evidenceIds: ['cd-skill-1'] },
          { id: 'skill-2', group: 'Infrastructure', items: ['AWS', 'Kubernetes', 'Terraform'], evidenceIds: ['cd-skill-2'] },
        ],
      };
      const paragraphs = Array.from({ length: 4 }, (unused, index) => ({
        id: `paragraph-${index}`,
        text: `My experience delivering reliable, supported systems is a directly relevant capability for this role. In my engineering role at Acme, I modernized reporting infrastructure for internal users across three teams. I would apply this same experience delivering reliable systems to the reliable-delivery responsibilities this role requires, paragraph ${index}.`,
        evidenceIds: [`letter-proof-${index}`, 'job-proof'],
      }));
      const coverLetter = {
        name: 'Ada Lovelace', contact: ['ada@example.test'], salutation: 'Dear Hiring Team,', recipient: 'Acme Systems', paragraphs,
        closing: 'Sincerely,', signatureTitle: 'Senior Software Engineer',
        roleThesis: 'Reporting-systems judgment under real delivery constraints is the capability this role needs most.',
        coverLetterArgument: {
          primaryEvidence: { evidence: 'Modernized the internal reporting pipeline at Acme.', evidenceRole: 'Senior Software Engineer at Acme', relationToThesis: 'Proves the judgment directly, under the same delivery constraints.' },
          secondaryEvidence: { evidence: 'Cut onboarding time by 30% on the Widget Platform.', evidenceRole: 'Project lead on Widget Platform', narrativeRole: 'reinforcing', relationToPrimary: 'Extends the same delivery judgment to a second, independent system.' },
        },
      };

      // The production checklist/criteria shape: one entry per REAL
      // criterion (not a 2-3 entry toy list), so the resume/coverLetter/bundle
      // split this test measures is the split writers actually face.
      const fullChecklist = () => APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents: ${requirement}` }));
      const fullCriteria = () => APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `Confirmed directly against the final documents: ${requirement}` }));
      const planParagraph = (paragraph, index) => {
        const sentences = paragraph.text.split(/(?<=\.)\s+/u);
        return {
          paragraph: paragraph.text,
          argumentativeJob: index === 0 ? 'Establish the controlling evidence-to-need connection.' : `Extend the controlling argument with independent proof ${index}.`,
          relationToThesis: 'Connects the source-supported proof to reliable system delivery.',
          relationToPreviousParagraph: index === 0 ? 'opening' : 'Carries the prior paragraph’s claim forward with a new proof.',
          sentences: sentences.map((sentence, sentenceIndex) => ({
            sentence,
            function: sentenceIndex === 0 ? 'States the general candidate capability.' : sentenceIndex === 1 ? 'Supplies the source-supported candidate proof.' : 'Connects the proof to the target responsibility.',
            relationToPreviousSentence: sentenceIndex === 0 ? 'opening' : 'Develops the preceding argument step.',
          })),
          argumentMapping: { claim: sentences[0], proof: sentences[1] || sentences[0], relevance: sentences[sentences.length - 1], jobNeedQuote: 'reliable system delivery' },
        };
      };
      const fullGenerationAudit = () => ({
        version: LOCAL_AI_GENERATION_AUDIT_VERSION,
        jobPriorities: [
          { requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both', justification: 'The selected systems evidence directly addresses the stated delivery requirement across both documents.' },
          { requirement: 'Cross-team collaboration', priority: 'high', disposition: 'addressed-resume', justification: 'The Widget Platform bullet and project entry evidence cross-team delivery at measurable scale.' },
          { requirement: 'Infrastructure ownership', priority: 'medium', disposition: 'addressed-resume', justification: 'The infrastructure skill group and AWS/Kubernetes/Terraform items evidence direct ownership.' },
        ],
        resumePlan: { strategy: 'Lead with the strongest supported systems evidence for the role, ordered by requirement priority.', selectionRationale: 'The retained roles preserve direct factual support, concise relevance, and full role-completeness.' },
        coverLetterPlan: { controllingThesis: coverLetter.roleThesis, paragraphs: paragraphs.map(planParagraph) },
        finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument, and every high-priority requirement is deliberately addressed.',
      });

      const priorFinalReview = {
        decision: 'pass', findings: [], patches: [],
        checklist: fullChecklist(),
        qualityReview: {
          checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
          criteria: fullCriteria(),
          resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance and full role completeness across both roles.' },
          coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery, reinforced by one independent secondary proof.' },
        },
        generationAudit: fullGenerationAudit(),
      };

      // One bullet fixed; nothing in the cover letter moved. `changed` also
      // stands in for `staleSinceBaseline` below — this test measures byte
      // savings at realistic scale, not signal divergence (covered above).
      const changed = { resume: true, coverLetter: false, changedBulletIds: ['bullet-0'], changedRoleIds: [], changedParagraphIds: [], changedArgumentPaths: [], roleThesisChanged: false };
      const required = requiredPasteReviewDeltaEntries(priorFinalReview, changed, APPLICATION_QUALITY_CRITERIA, changed);
      // 9 resume-scoped + 3 bundle-scoped criteria; the 12 coverLetter-scoped
      // criteria must NOT be required, because nothing they grade changed.
      assert(required.checklistIds.length === 12, `a résumé-only change must invalidate exactly the 9 resume + 3 bundle criteria, got ${required.checklistIds.length}`);
      const coverLetterScopedIds = new Set(APPLICATION_QUALITY_CRITERIA.filter(criterion => criterion.document === 'coverLetter').map(criterion => criterion.id));
      assert(!required.checklistIds.some(id => coverLetterScopedIds.has(id)), 'no coverLetter-scoped criterion may be required by a résumé-only change');
      assert(required.auditParagraphIndexes.length === 0, 'a résumé-only change must not require any coverLetterPlan.paragraphs entry');

      const requiredIds = new Set(required.checklistIds);
      const revisedResume = structuredClone(resume);
      revisedResume.roles[0].bullets[0] = { id: 'bullet-0', text: 'Directed a cross-functional initiative that modernized the internal reporting pipeline end to end, cutting manual reconciliation effort by a measurable double-digit percentage.', evidenceIds: ['cd-0', 'cd-0-b', 'cd-0-c'] };
      const delta = {
        decision: 'pass', findings: [],
        patches: [{ op: 'replace', target: 'resume:bullet:bullet-0', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } }],
        // Trimmed to exactly what requiredPasteReviewDeltaEntries demanded —
        // the shape a real writer follows, not the full 24-entry list
        // paste-application-fit-save.js's test deliberately keeps whole.
        checklist: fullChecklist().filter(entry => requiredIds.has(entry.id)),
        qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: fullCriteria().filter(entry => requiredIds.has(entry.id)), resume: { decision: 'approved', rationale: 'Updated: the résumé still preserves direct source-supported systems evidence with clear relevance.' } },
        // coverLetter and coverLetterPlan are both absent: neither the
        // document-level rationale nor the per-paragraph plan describes
        // anything a résumé-only patch could have invalidated. jobPriorities
        // is resupplied WHOLE (it cannot be merged per-requirement once
        // stale — pasteReviewDelta.js's header) and finalDecisionSummary is
        // resupplied fresh (it describes both documents, so a résumé-only
        // change still invalidates it) — both required once resume is stale,
        // neither optional the way a per-document field would be.
        generationAudit: {
          jobPriorities: fullGenerationAudit().jobPriorities,
          resumePlan: { strategy: 'Updated strategy text reflecting the tightened bullet.', selectionRationale: 'Updated selection rationale.' },
          finalDecisionSummary: 'Updated: the final documents still use the strongest supported evidence without introducing a second cover-letter argument.',
        },
      };
      assert(!('coverLetter' in delta.qualityReview), 'a résumé-only delta must omit qualityReview.coverLetter — its own document did not change');
      assert(!('coverLetterPlan' in delta.generationAudit), 'a résumé-only delta must omit generationAudit.coverLetterPlan entirely, paragraphs included');
      assert(!delta.checklist.some(entry => coverLetterScopedIds.has(entry.id)), 'a résumé-only delta must omit every coverLetter-scoped checklist entry');
      assert(!delta.qualityReview.criteria.some(entry => coverLetterScopedIds.has(entry.id)), 'a résumé-only delta must omit every coverLetter-scoped criterion');

      // Assertion 1: the merge reconstructs the COMPLETE canonical arrays —
      // the property validatePasteResponse's "checklist must list every
      // canonical criterion" gate actually depends on — from a delta that
      // supplied only 12 of the 24 entries. The real criteria catalog is
      // passed too, proving qualityReview.criteria's own backstop
      // (mergeGradedCriteria) does not spuriously refuse a correctly-scoped
      // delta at this realistic scale: every resume/bundle-scoped id this
      // delta omits is stale-free (coverLetter did not change), and every
      // one it must resupply, it does.
      const { review: mergedReview, errors } = mergePasteReviewDelta(priorFinalReview, delta, changed, APPLICATION_QUALITY_CRITERIA);
      assert(errors.length === 0, `a correctly-scoped résumé-only delta must merge cleanly, got ${JSON.stringify(errors)}`);
      const canonicalIds = APPLICATION_QUALITY_CRITERIA.map(criterion => criterion.id);
      assert(JSON.stringify(mergedReview.checklist.map(entry => entry.id)) === JSON.stringify(canonicalIds),
        'the merged checklist must list every canonical criterion, in canonical order, despite the delta supplying only 12 of them');
      assert(JSON.stringify(mergedReview.qualityReview.criteria.map(entry => entry.id)) === JSON.stringify(canonicalIds),
        'the merged qualityReview.criteria must list every canonical criterion, in canonical order, despite the delta supplying only 12 of them');
      assert(JSON.stringify(mergedReview.generationAudit.coverLetterPlan.paragraphs) === JSON.stringify(priorFinalReview.generationAudit.coverLetterPlan.paragraphs),
        'every coverLetterPlan paragraph must carry forward byte-identical when the delta omits the block entirely and no paragraph changed');

      // Assertion 2: the round is materially smaller than the equivalent
      // full resend, at THIS realistic scale — never a hard-coded byte
      // count, which would rot the moment fixture text above is edited, but
      // a SAVINGS RATIO measured from these same fixtures at run time.
      const fullResponse = {
        decision: 'pass', findings: [], resume: revisedResume, coverLetter,
        checklist: fullChecklist(),
        qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: fullCriteria(), resume: delta.qualityReview.resume, coverLetter: priorFinalReview.qualityReview.coverLetter },
        generationAudit: { ...fullGenerationAudit(), jobPriorities: delta.generationAudit.jobPriorities, resumePlan: delta.generationAudit.resumePlan, finalDecisionSummary: delta.generationAudit.finalDecisionSummary },
      };
      const fullBytes = Buffer.byteLength(JSON.stringify(fullResponse), 'utf8');
      const deltaBytes = Buffer.byteLength(JSON.stringify(delta), 'utf8');
      const measuredSavings = 1 - deltaBytes / fullBytes;
      // ALSO FIX (2026-09-22 adversarial review): the floor used to be a
      // hard-coded SAVINGS_FLOOR = 0.45, chosen from an out-of-band manual
      // measurement recorded only in a comment — a fixture edit could move
      // fullBytes/deltaBytes without anyone re-deriving whether 0.45 still
      // meant anything. Derive it here instead: build the exact regression
      // this guard exists to catch — a delta that reverted the sparse-entry
      // trim, resending the FULL checklist/criteria/generationAudit while
      // still omitting the two whole documents (the pre-Task-B2 shape; a
      // document replacement was never the bulk of the measured waste) —
      // from these SAME fixtures, and require the real delta to beat that
      // regression's own savings ratio by a stated, fixture-independent
      // margin. A fixture-text edit now moves measuredSavings and
      // regressionSavings together, so it can never silently rot the guard;
      // a regression in requiredPasteReviewDeltaEntries's scoping (or a
      // caller that stops trimming to it) collapses measuredSavings toward
      // regressionSavings and trips the margin.
      const regressionDelta = {
        ...delta,
        checklist: fullChecklist(),
        qualityReview: { ...delta.qualityReview, criteria: fullCriteria() },
        generationAudit: fullGenerationAudit(),
      };
      const regressionBytes = Buffer.byteLength(JSON.stringify(regressionDelta), 'utf8');
      const regressionSavings = 1 - regressionBytes / fullBytes;
      const SAVINGS_MARGIN = 0.15;
      assert(measuredSavings > regressionSavings + SAVINGS_MARGIN,
        `a résumé-only delta at realistic scale must beat the sparse-entry-trim regression by a material margin (measured ${(measuredSavings * 100).toFixed(1)}% vs regression ${(regressionSavings * 100).toFixed(1)}% + ${(SAVINGS_MARGIN * 100).toFixed(0)}pt margin; full=${fullBytes}, delta=${deltaBytes}, regression=${regressionBytes} bytes)`);
      return {
        fullBytes, deltaBytes, regressionBytes,
        measuredSavingsPct: Number((measuredSavings * 100).toFixed(1)),
        regressionSavingsPct: Number((regressionSavings * 100).toFixed(1)),
      };
    },
  },
  {
    name: 'TARGET_FORMS_RULE names exactly the target forms parseTarget() implements, in both directions',
    run: () => {
      // pastePrompt (localAiApplication.js) interpolates TARGET_FORMS_RULE
      // straight from this module's own export, so the PROMPT can never
      // disagree with this STRING — but the string itself is hand-authored,
      // separately from parseTarget()'s own regex grammar, and nothing kept
      // the two in step. The same class of gap is what PASTE_CHECK_PROSE_UNITS
      // guards against in paste-application-flow.js: enumerate the real
      // implementation from its own source rather than trusting a second
      // hand-kept list, so a form added to one side without the other fails
      // loudly here instead of silently promising a target the engine
      // rejects, or silently accepting one the contract never told a
      // responder about.
      const source = fs.readFileSync(new URL('../../electron/ipc/pasteReviewDelta.js', import.meta.url), 'utf8');
      const resumeKindsMatch = source.match(/resume:\(([a-z|]+)\):/);
      assert(resumeKindsMatch, 'parseTarget must still parse resume:<kind>:<id> from a single alternation this test can read');
      const resumeKinds = resumeKindsMatch[1].split('|');
      assert(resumeKinds.length >= 2, `expected a real alternation of résumé target kinds, got ${JSON.stringify(resumeKinds)}`);
      assert(source.includes("target === 'coverLetter:roleThesis'"),
        'parseTarget must still special-case coverLetter:roleThesis by this exact literal');
      assert(source.includes('coverLetter:paragraph:(.+)$/'),
        'parseTarget must still parse coverLetter:paragraph:<id> from this exact regex');
      assert(source.includes('coverLetter:argument:(.+)$/'),
        'parseTarget must still parse coverLetter:argument:<path> from this exact regex');

      // The real engine grammar, read off the source above — never a second
      // hand-typed mirror of TARGET_FORMS_RULE.
      const implementedForms = new Set([
        ...resumeKinds.map(kind => `resume:${kind}:#`),
        'coverLetter:paragraph:#', 'coverLetter:roleThesis', 'coverLetter:argument:#',
      ]);
      // TARGET_FORMS_RULE's own declared list, normalized the same way:
      // every "<...>" placeholder collapses to the same marker so the two
      // sides compare on FORM alone, not on the id token's spelling.
      const declaredForms = new Set(TARGET_FORMS_RULE
        .replace(', or ', ', ')
        .split(', ')
        .map(form => form.replace(/<[^>]+>/g, '#')));
      assert(implementedForms.size === resumeKinds.length + 3 && declaredForms.size === implementedForms.size,
        `expected the same number of forms on both sides (implemented=${[...implementedForms].join('|')}, declared=${[...declaredForms].join('|')})`);
      const missingFromRule = [...implementedForms].filter(form => !declaredForms.has(form));
      const missingFromEngine = [...declaredForms].filter(form => !implementedForms.has(form));
      assert(!missingFromRule.length,
        `parseTarget implements a target form TARGET_FORMS_RULE never advertises to a responder: ${JSON.stringify(missingFromRule)}`);
      assert(!missingFromEngine.length,
        `TARGET_FORMS_RULE advertises a target form parseTarget does not implement: ${JSON.stringify(missingFromEngine)}`);
      return { forms: implementedForms.size };
    },
  },
  {
    name: 'VALID_OPS names exactly the ops every collection target kind implements',
    run: () => {
      // VALID_OPS gates resolvePatches before any kind-specific branch runs
      // (`if (!VALID_OPS_SET.has(op))`), and pastePrompt interpolates this
      // same export rather than a hand-typed op list — so an op named here
      // that no branch below implements is the one way this table could
      // still drift from the engine: silently falling through to the
      // "remove" branch (the un-narrowed `else`) as some collection kinds
      // are written, rather than failing loudly. Total over the module's own
      // source: every collection kind (résumé role/bullet/project/skill,
      // cover-letter paragraph) must spell out "replace" and "insert-after"
      // by name, leaving only "remove" to the shared else branch.
      assert(JSON.stringify(VALID_OPS) === JSON.stringify(['replace', 'insert-after', 'remove']),
        `VALID_OPS is the exact closed set the prompt promises and resolvePatches's early gate enforces, got ${JSON.stringify(VALID_OPS)}`);
      const source = fs.readFileSync(new URL('../../electron/ipc/pasteReviewDelta.js', import.meta.url), 'utf8');
      const replaceBranches = (source.match(/op === 'replace'/g) || []).length;
      const insertBranches = (source.match(/op === 'insert-after'/g) || []).length;
      // One pair of branches per collection kind in resolvePatches (role,
      // bullet, project, skill, paragraph) plus one further pair in
      // applyListOps/roleUnit application below it.
      assert(replaceBranches === 6 && insertBranches === 6,
        `every collection kind must spell out "replace" and "insert-after" explicitly rather than falling through to the shared "remove" else branch (replace=${replaceBranches}, insert-after=${insertBranches})`);
      return { ok: true };
    },
  },
];
