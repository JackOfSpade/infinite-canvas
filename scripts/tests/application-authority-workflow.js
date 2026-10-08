import assert from 'node:assert/strict';
import {
  APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE,
  APPLICATION_AUTHORITY_WORKFLOW_VERSION,
  aggregateBlindFindings,
  assertDispositionCoverage,
  assertMatchCoverage,
  assertReviewConverges,
  authorityDigest,
  createAuthorityWorkflowRoot,
  createBlindReviewerReceipt,
  createBlindReviewerScopes,
  createDispositionPlan,
  createDispositionReceipt,
  createMatchReceipt,
  createStoreAuthorityWorkflowRoot,
  createStoreDispositionReceipt,
  createStoreMatchReceipt,
  createStoreReductionPage,
  createStoreReductionPageFromReceiptAt,
  enumerateRequirementCatalogPairs,
  invalidateBlindReviewerReceipts,
  reduceRequirementMatches,
  reviewConvergenceState,
  selectDraftEvidence,
  selectDraftRoles,
  selectDraftSkills,
  storeRequirementCatalogPairDescriptor,
  validateBlindReviewCoverage,
} from '../test-dependencies.js';

const requirements = Array.from({ length: 13 }, (_unused, index) => ({ id: `req-${index + 1}`, text: `Requirement ${index + 1}`, priority: index === 12 ? 'highest' : 'supporting' }));
const catalog = [
  ...Array.from({ length: 49 }, (_unused, index) => ({ id: `ev-${index + 1}`, roleId: `role-${(index % 33) + 1}` })),
  { id: 'project-evidence', projectId: 'project-1' },
  { id: 'skill-evidence', skillId: 'skill-1' },
  { id: 'education-evidence', owner: { type: 'education', id: 'degree-1' } },
];
const roles = Array.from({ length: 33 }, (_unused, index) => ({ id: `role-${index + 1}`, title: `Role ${index + 1}` }));
const skills = Array.from({ length: 14 }, (_unused, index) => ({ id: `skill-${index + 1}`, evidenceIds: [index === 0 ? 'ev-24' : `ev-${index + 1}`], indexEligible: true }));

function answerPair(root, pair, { lateMatch = false } = {}) {
  return {
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION,
    rootDigest: root.digest,
    pairDigest: pair.digest,
    rows: pair.requirementIds.map(requirementId => {
      const match = (requirementId === 'req-1' && pair.catalogPageIndex === 0)
        || (lateMatch && requirementId === 'req-13' && pair.catalogPageIndex === root.catalogPages.length - 1);
      return { requirementId, localStatus: match ? 'matched' : 'no-match', candidateEvidenceIds: match ? [pair.catalogEvidenceIds.at(-1)] : [] };
    }),
  };
}

function allReceipts(root) {
  return [...enumerateRequirementCatalogPairs(root)].reverse().map(pair => createMatchReceipt({ root, pair, response: answerPair(root, pair, { lateMatch: true }) }));
}

async function runAuthorityWorkflowTest() {
  const root = createAuthorityWorkflowRoot({ requirements, catalog, roles, skills });
  assert.equal(root.catalogPageSize, APPLICATION_AUTHORITY_MATCH_PAGE_EVIDENCE);
  const receipts = allReceipts(root);
  assert.equal(assertMatchCoverage(root, receipts).length, root.requirementPages.length * root.catalogPages.length, 'out-of-order receipts retain exact Cartesian coverage');
  const reduction = reduceRequirementMatches(root, receipts);
  assert.equal(reduction.aggregates.find(row => row.requirementId === 'req-13').matchedEvidenceIds.length, 1, 'a final catalog page can support a late requirement');

  assert.throws(() => assertMatchCoverage(root, receipts.slice(1)), /incomplete/i, 'missing pair fails closed');
  assert.throws(() => assertMatchCoverage(root, [...receipts, receipts[0]]), /duplicate/i, 'duplicate pair fails closed');
  const tampered = structuredClone(receipts[0]); tampered.rows[0].candidateEvidenceIds = ['ev-not-displayed'];
  assert.throws(() => assertMatchCoverage(root, [tampered, ...receipts.slice(1)]), /digest|invalid|outside/i, 'tampered receipt fails closed');

  const rolesSelection = selectDraftRoles({ requirements, catalog, roles, reduction });
  assert(rolesSelection.selectedRoleIds.length <= 32 && rolesSelection.selectedRoleIds.length >= 1, 'role selection obeys the final layout bound');
  assert.equal(rolesSelection.omitted.length, 33 - rolesSelection.selectedRoleIds.length, 'every unselected role receives a trace row');
  assert.equal(new Set([...rolesSelection.selectedRoleIds, ...rolesSelection.omitted.map(row => row.id)]).size, 33, 'role trace exhaustively accounts for catalog IDs');
  const skillsSelection = selectDraftSkills({ skills, reduction });
  assert(skillsSelection.selectedSkillIds.length <= 10 && skillsSelection.omitted.length + skillsSelection.selectedSkillIds.length === skills.length, 'skill selection is finite and exhaustive');
  assert(skillsSelection.selectedSkillIds.includes('skill-1'), 'a skill is selected when one of its evidence IDs matched, not when its skill ID happens to equal evidence');
  assert(skillsSelection.omitted.some(row => row.reason === 'no selected frozen evidence supports this skill for the job'), 'unmatched skills receive an honest omission reason');
  const shortInventorySelection = selectDraftSkills({ skills: skills.slice(0, 3), reduction });
  assert.deepEqual(shortInventorySelection.selectedSkillIds, ['skill-1'], 'a short inventory cannot source-order-fill zero-match skill slots after its one positive evidence match');
  const noMatchSelection = selectDraftSkills({ skills: skills.slice(1, 4), reduction });
  assert.deepEqual(noMatchSelection.selectedSkillIds, [], 'when no frozen requirement evidence supports a skill, the truthful bounded draft omits the skill block rather than inventing a fallback');
  const typedReduction = structuredClone(reduction);
  typedReduction.aggregates.find(row => row.requirementId === 'req-13').matchedEvidenceIds.push('project-evidence', 'skill-evidence', 'education-evidence');
  const { digest: _typedDigest, ...typedUnsigned } = typedReduction;
  typedReduction.digest = authorityDigest(typedUnsigned);
  const evidenceSelection = selectDraftEvidence({ catalog, requirements, reduction: typedReduction, selectedRoleIds: rolesSelection.selectedRoleIds, selectedProjectIds: ['project-1'], selectedSkillIds: ['skill-1'], maxEvidence: 20 });
  assert.equal(evidenceSelection.selectedEvidenceIds.length + evidenceSelection.omitted.length, catalog.length, 'evidence omission pages retain the complete catalog trace');
  assert(evidenceSelection.selectedEvidenceIds.includes('project-evidence') && evidenceSelection.selectedEvidenceIds.includes('skill-evidence') && evidenceSelection.selectedEvidenceIds.includes('education-evidence'), 'selected project, skill, and standalone education evidence can reach drafting');

  const dispositionPlan = createDispositionPlan(requirements);
  const dispositionReceipts = dispositionPlan.pages.map((page, pageIndex) => createDispositionReceipt({
    plan: dispositionPlan,
    requirements,
    pageIndex,
    reduction,
    finalReferences: { documents: ['resume', 'cover-letter'], evidenceIds: reduction.aggregates.flatMap(row => row.matchedEvidenceIds) },
    response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, planDigest: dispositionPlan.digest, pageDigest: page.digest, reductionDigest: reduction.digest, finalReferencesDigest: authorityDigest({ documents: ['resume', 'cover-letter'], evidenceIds: reduction.aggregates.flatMap(row => row.matchedEvidenceIds) }),
      rows: page.ids.map(requirementId => ({ requirementId, priority: requirements.find(row => row.id === requirementId).priority, disposition: 'addressed-resume', justification: 'Bounded final document evidence addresses this requirement.', documentRefs: ['resume'] })), },
  }));
  const dispositionOptions = { reduction, finalReferences: { documents: ['resume', 'cover-letter'], evidenceIds: reduction.aggregates.flatMap(row => row.matchedEvidenceIds) } };
  assert.equal(assertDispositionCoverage(dispositionPlan, requirements, dispositionReceipts, dispositionOptions).length, 13, 'more than twelve requirement dispositions are exhaustive across pages');
  assert.throws(() => assertDispositionCoverage(dispositionPlan, requirements, dispositionReceipts.slice(1), dispositionOptions), /incomplete/i, 'missing disposition page fails closed');
  const firstPage = dispositionPlan.pages[0];
  const illegalResponse = rows => ({ version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, planDigest: dispositionPlan.digest, pageDigest: firstPage.digest, reductionDigest: reduction.digest, finalReferencesDigest: authorityDigest(dispositionOptions.finalReferences), rows });
  assert.throws(() => createDispositionReceipt({ plan: dispositionPlan, requirements, pageIndex: 0, reduction, finalReferences: dispositionOptions.finalReferences,
    response: illegalResponse(firstPage.ids.map(requirementId => ({ requirementId, priority: requirements.find(row => row.id === requirementId).priority, disposition: 'omitted-no-evidence', justification: 'Unsupported.', documentRefs: [] }))) }), /unsupported/i, 'supported requirement cannot claim omitted-no-evidence');
  assert.throws(() => createDispositionReceipt({ plan: dispositionPlan, requirements, pageIndex: 0, reduction, finalReferences: dispositionOptions.finalReferences,
    response: illegalResponse(firstPage.ids.map(requirementId => ({ requirementId, priority: requirements.find(row => row.id === requirementId).priority, disposition: 'addressed-resume', justification: 'Addressed.', documentRefs: ['unfrozen-document'] }))) }), /outside/i, 'disposition document references bind the final artifact');

  const scopes = createBlindReviewerScopes({ resumeDigest: authorityDigest('resume-v1'), coverLetterDigest: authorityDigest('letter-v1'), requirementPlan: dispositionPlan, citationPageDigests: ['citation-1', 'citation-2'] });
  assert.deepEqual([...new Set(scopes.map(scope => scope.track))].sort(), ['cross-document-coherence', 'fact-fidelity', 'letter-argument-editorial', 'resume-hiring-quality', 'tailoring-ats'], 'all five blind reviewer tracks receive independent descriptors');
  assert(scopes.every(scope => !scope.allowedContext.includes('peer-findings') && !scope.allowedContext.includes('author-review')), 'blind scopes exclude peer and author-review context');
  const reviewReceipts = scopes.map(scope => createBlindReviewerReceipt({ scope, response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: scope.digest, pageIndex: 0, complete: true, decision: 'pass', findings: [] } }));
  assert(validateBlindReviewCoverage(scopes, reviewReceipts).clean, 'exact clean reviewer coverage validates');
  assert.equal(invalidateBlindReviewerReceipts(scopes.slice(1), reviewReceipts).length, reviewReceipts.length - 1, 'restart/revision retains only exact unchanged scope digests');
  assert.throws(() => validateBlindReviewCoverage(scopes, reviewReceipts.slice(1)), /incomplete/i, 'reviewer restart with missing receipt fails closed');
  const firstFindings = Array.from({ length: 32 }, (_unused, index) => ({ id: `f-${index + 1}`, ruleId: 'fact', document: 'resume', targetId: `bullet-${index + 1}`, issue: 'Unsupported claim', fix: 'Remove unsupported wording.' }));
  const issue = createBlindReviewerReceipt({ scope: scopes[0], response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: scopes[0].digest, pageIndex: 0, complete: false, decision: 'issues', findings: firstFindings } });
  const finalIssue = createBlindReviewerReceipt({ scope: scopes[0], previousReceipt: issue, response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: scopes[0].digest, pageIndex: 1, previousPageDigest: issue.digest, complete: true, decision: 'issues', findings: [{ id: 'f-33', ruleId: 'fact', document: 'resume', targetId: 'bullet-33', issue: 'Unsupported claim', fix: 'Remove unsupported wording.' }] } });
  const pagedReviewReceipts = [issue, finalIssue, ...reviewReceipts.slice(1)];
  assert.equal(validateBlindReviewCoverage(scopes, pagedReviewReceipts).clean, false, 'more than one bounded findings page completes one reviewer scope');
  assert.equal(aggregateBlindFindings([issue, finalIssue]).findingCount, 33, 'findings aggregate across unlimited continuation pages without exposing peers to reviewers');
  assert.throws(() => createBlindReviewerReceipt({ scope: scopes[0], previousReceipt: issue, response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: scopes[0].digest, pageIndex: 1, previousPageDigest: issue.digest, complete: false, decision: 'issues', findings: firstFindings } }), /progress|repeat/i, 'repeated reviewer finding page halts instead of looping');
  assert.throws(() => createBlindReviewerReceipt({ scope: scopes[0], response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, scopeDigest: scopes[0].digest, pageIndex: 0, complete: true, decision: 'issues', findings: firstFindings } }), /full bounded finding page/i, 'a full finding page must request a continuation rather than silently certify exhaustive review');

  const state = reviewConvergenceState({ resumeDigest: 'r1', coverLetterDigest: 'l1', unresolvedFindingDigest: authorityDigest(['f-1']), selectionDigest: rolesSelection.digest, dispositionDigest: authorityDigest(dispositionReceipts) });
  assert.throws(() => assertReviewConverges([state], state), /NONCONVERGENT/, 'repeated unresolved review state halts');
  const noOp = reviewConvergenceState({ resumeDigest: 'r1', coverLetterDigest: 'l1', unresolvedFindingDigest: authorityDigest(['f-2']), selectionDigest: rolesSelection.digest, dispositionDigest: authorityDigest(dispositionReceipts) });
  assert.throws(() => assertReviewConverges([state], noOp), /unchanged/, 'no-op repair with unresolved findings halts');

  // Store roots carry only receipt heads/counts.  The active matching prompt
  // proves its two bounded pages directly and never needs a materialized
  // Cartesian descriptor list.
  const storeRootInput = {
    requirements: { count: 2, digest: authorityDigest('requirements-head') },
    catalog: { count: 2, digest: authorityDigest('catalog-head') },
    rolesDigest: authorityDigest(roles), skillsDigest: authorityDigest(skills),
  };
  const storeRootDefault = createStoreAuthorityWorkflowRoot(storeRootInput);
  const storeRootExplicitDefault = createStoreAuthorityWorkflowRoot({ ...storeRootInput, requirementsStream: 'requirements' });
  assert.deepEqual(storeRootDefault, storeRootExplicitDefault, 'omitted and explicit historical requirements streams retain the v1 root shape and digest');
  assert.equal(Object.hasOwn(storeRootDefault, 'requirementsStream'), false, 'historical requirements stream remains implicit in default roots');
  const { digest: _legacyStoreRootDigest, ...legacyStoreRoot } = storeRootDefault;
  assert.equal(storeRootDefault.digest, authorityDigest(legacyStoreRoot), 'default store roots retain the legacy canonical digest projection');
  const alternateStoreRoot = createStoreAuthorityWorkflowRoot({ ...storeRootInput,
    requirementsStream: 'job-requirements' });
  assert.notEqual(alternateStoreRoot.digest, storeRootDefault.digest, 'a nondefault active requirements stream is signed into the store root digest');
  assert.equal(alternateStoreRoot.requirementsStream, 'job-requirements', 'nondefault roots retain their active requirements stream');
  assert.throws(() => createStoreAuthorityWorkflowRoot({ ...storeRootInput, requirementsStream: 'Requirements' }), /requirementsStream is invalid/i, 'invalid active requirements stream names fail closed');
  const invalidStreamRoot = structuredClone(alternateStoreRoot);
  invalidStreamRoot.requirementsStream = 'bad_stream';
  const { digest: _invalidStreamDigest, ...invalidStreamUnsigned } = invalidStreamRoot;
  invalidStreamRoot.digest = authorityDigest(invalidStreamUnsigned);
  assert.throws(() => storeRequirementCatalogPairDescriptor(invalidStreamRoot, { requirementPage: { number: 0, digest: authorityDigest('invalid-requirement-page'), records: [{ kind: 'requirement', item: requirements[0] }] }, catalogPage: { number: 0, digest: authorityDigest('invalid-catalog-page'), records: [{ kind: 'catalog-evidence', item: catalog[0] }] } }), /requirements stream is invalid/i, 'a digest-recomputed but invalid stream field is rejected');
  const storeRoot = createStoreAuthorityWorkflowRoot({
    ...storeRootInput,
  });
  const requirementPage = { number: 1, digest: authorityDigest('requirement-page-1'), records: [{ kind: 'requirement', item: requirements[12] }] };
  const catalogPage = { number: 1, digest: authorityDigest('catalog-page-1'), records: [{ kind: 'catalog-evidence', item: catalog.at(-1) }] };
  const storePair = storeRequirementCatalogPairDescriptor(storeRoot, { requirementPage, catalogPage });
  assert.equal(Object.hasOwn(storePair, 'requirementsStream'), false, 'default store pair descriptors retain their historical shape');
  const alternateRequirementPage = { ...requirementPage, stream: 'job-requirements' };
  const alternateStorePair = storeRequirementCatalogPairDescriptor(alternateStoreRoot, { requirementPage: alternateRequirementPage, catalogPage });
  assert.equal(alternateStorePair.requirementsStream, 'job-requirements', 'nondefault store pair descriptors carry the active stream binding');
  const storeReceipt = createStoreMatchReceipt({ root: storeRoot, pair: storePair, response: {
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest, pairDigest: storePair.digest,
    rows: [{ requirementId: requirements[12].id, candidateEvidenceIds: [catalog.at(-1).id], localStatus: 'matched' }],
  } });
  const changedStreamRoot = createStoreAuthorityWorkflowRoot({ ...storeRootInput,
    requirements: { count: 2, digest: authorityDigest('requirements-new-head') }, requirementsStream: 'job-requirements' });
  assert.notEqual(changedStreamRoot.digest, storeRoot.digest, 'a changed active stream receipt creates a new root epoch even when page dimensions overlap');
  assert.throws(() => storeRequirementCatalogPairDescriptor(changedStreamRoot, { requirementPage: { ...requirementPage, stream: 'requirements' }, catalogPage }), /active requirements stream/i, 'an old requirements-stream page is rejected by a nondefault active stream even when its IDs, count, and page digest overlap');
  assert.throws(() => createStoreMatchReceipt({ root: changedStreamRoot, pair: storePair, response: {
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest, pairDigest: storePair.digest,
    rows: [{ requirementId: requirements[12].id, candidateEvidenceIds: [catalog.at(-1).id], localStatus: 'matched' }],
  } }), /invalid store pair descriptor/i, 'an old-stream page pair and receipt response cannot satisfy the new active stream root');
  assert.throws(() => createStoreReductionPage({ root: changedStreamRoot, requirementPage: alternateRequirementPage, receipts: [storeReceipt] }), /foreign|duplicate|missing/i, 'an old-stream match receipt cannot reduce against the new active stream root despite overlapping row IDs');
  const storeReduction = createStoreReductionPage({ root: storeRoot, requirementPage, receipts: [storeReceipt, createStoreMatchReceipt({ root: storeRoot,
    pair: storeRequirementCatalogPairDescriptor(storeRoot, { requirementPage, catalogPage: { number: 0, digest: authorityDigest('catalog-page-0'), records: [{ kind: 'catalog-evidence', item: catalog[0] }] } }),
    response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest,
      pairDigest: storeRequirementCatalogPairDescriptor(storeRoot, { requirementPage, catalogPage: { number: 0, digest: authorityDigest('catalog-page-0'), records: [{ kind: 'catalog-evidence', item: catalog[0] }] } }).digest,
      rows: [{ requirementId: requirements[12].id, candidateEvidenceIds: [], localStatus: 'no-match' }] },
  })] });
  assert.equal(storeReduction.rows[0].finalStatus, 'supported', 'late store catalog pages remain in the compact reduction frontier');
  const storeReceiptsByCatalog = [storeReceipt, createStoreMatchReceipt({ root: storeRoot,
    pair: storeRequirementCatalogPairDescriptor(storeRoot, { requirementPage, catalogPage: { number: 0, digest: authorityDigest('catalog-page-0'), records: [{ kind: 'catalog-evidence', item: catalog[0] }] } }),
    response: { version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest,
      pairDigest: storeRequirementCatalogPairDescriptor(storeRoot, { requirementPage, catalogPage: { number: 0, digest: authorityDigest('catalog-page-0'), records: [{ kind: 'catalog-evidence', item: catalog[0] }] } }).digest,
      rows: [{ requirementId: requirements[12].id, candidateEvidenceIds: [], localStatus: 'no-match' }] },
  })].sort((left, right) => left.catalogPageIndex - right.catalogPageIndex);
  const streamedStoreReduction = await createStoreReductionPageFromReceiptAt({ root: storeRoot, requirementPage,
    receiptAt: async index => storeReceiptsByCatalog[index] });
  assert.equal(streamedStoreReduction.rows[0].matchReceiptDigest, authorityDigest(storeReceiptsByCatalog.map(receipt => receipt.digest)),
    'streamed store reduction hashes the identical ordered receipt-digest sequence without retaining an array per requirement');
  assert.throws(() => createStoreReductionPage({ root: storeRoot, requirementPage, receipts: [storeReceipt] }), /coverage/i, 'store reduction rejects missing catalog receipt pages');
  const storeFinalReferences = { documents: ['resume', 'cover-letter'], evidenceIds: [catalog.at(-1).id], documentTexts: { resume: 'Built the selected supporting service.', 'cover-letter': 'I would bring the selected supporting service experience.' } };
  const storeDisposition = createStoreDispositionReceipt({ root: storeRoot, requirementPage, reduction: storeReduction,
    finalReferences: storeFinalReferences, response: {
      version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest, requirementPageDigest: requirementPage.digest,
      reductionDigest: storeReduction.digest, finalReferencesDigest: authorityDigest(storeFinalReferences),
      rows: [{ requirementId: requirements[12].id, priority: requirements[12].priority, disposition: 'addressed-resume', justification: 'The bounded résumé cites the selected supporting evidence.', documentRefs: ['resume', catalog.at(-1).id], proofs: [{ document: 'resume', documentDigest: authorityDigest(storeFinalReferences.documentTexts.resume), offset: 0, quote: storeFinalReferences.documentTexts.resume }] }],
    } });
  assert.equal(storeDisposition.requirementPageDigest, requirementPage.digest, 'store disposition receipts bind one exact requirement page');
  const baseStoreResponse = {
    version: APPLICATION_AUTHORITY_WORKFLOW_VERSION, rootDigest: storeRoot.digest, requirementPageDigest: requirementPage.digest,
    reductionDigest: storeReduction.digest, finalReferencesDigest: authorityDigest(storeFinalReferences),
    rows: [{ requirementId: requirements[12].id, priority: requirements[12].priority, disposition: 'addressed-resume', justification: 'The final résumé cites a direct proof.', documentRefs: ['resume'], proofs: [{ document: 'resume', documentDigest: authorityDigest(storeFinalReferences.documentTexts.resume), offset: 0, quote: storeFinalReferences.documentTexts.resume }] }],
  };
  assert.throws(() => createStoreDispositionReceipt({ root: storeRoot, requirementPage, reduction: storeReduction, finalReferences: storeFinalReferences,
    response: { ...baseStoreResponse, rows: [{ ...baseStoreResponse.rows[0], proofs: [] }] } }), /proof locator/i, 'bare addressed document references are rejected without a proof locator');
  assert.throws(() => createStoreDispositionReceipt({ root: storeRoot, requirementPage, reduction: storeReduction, finalReferences: storeFinalReferences,
    response: { ...baseStoreResponse, rows: [{ ...baseStoreResponse.rows[0], proofs: [{ ...baseStoreResponse.rows[0].proofs[0], quote: 'unrelated final text' }] }] } }), /exact substring/i, 'an unrelated or substituted proof quote is rejected');
  assert.throws(() => createStoreDispositionReceipt({ root: storeRoot, requirementPage, reduction: storeReduction, finalReferences: storeFinalReferences,
    response: { ...baseStoreResponse, rows: [{ ...baseStoreResponse.rows[0], proofs: [{ ...baseStoreResponse.rows[0].proofs[0], documentDigest: '0'.repeat(64) }] }] } }), /exact substring/i, 'a tampered final-document proof digest is rejected');
  assert.throws(() => createStoreDispositionReceipt({ root: storeRoot, requirementPage, reduction: storeReduction,
    finalReferences: { documents: ['resume'], evidenceIds: [], documentTexts: { resume: storeFinalReferences.documentTexts.resume } }, response: { ...storeDisposition, finalReferencesDigest: authorityDigest({ documents: ['resume'], evidenceIds: [], documentTexts: { resume: storeFinalReferences.documentTexts.resume } }), rows: [{ ...storeDisposition.rows[0], documentRefs: ['unfrozen'] }] } }), /unfrozen|stale/i, 'store disposition rejects unbound references');
  return { requirementPages: root.requirementPages.length, catalogPages: root.catalogPages.length, blindReviewTracks: scopes.length };
}

export default [{
  name: 'application authority workflow paginates matching, dispositions, and blind review receipts exhaustively',
  run: runAuthorityWorkflowTest,
}];
