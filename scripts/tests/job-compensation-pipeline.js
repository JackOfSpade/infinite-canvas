import { assert, canonicalizeGeneratedUntrustedBoundaryNonces, COMPENSATION_MIN_FIT_SCORE, compensationAssessmentCacheMatchesResearch, compensationCohortAssessmentFits, compensationCohortAssessmentMaxTokens, compensationResearchFingerprint, buildRoleFamilyBatchResearchPrompt, getRoleFamilyExperienceBandCache, packCompensationAssessmentBatches, packCompensationResearchBatches, parseCompensationResearchSections, planRoleFamilyAssessmentBatches, planRoleFamilyResearchBatches, roleFamilyAssessmentMaxTokens, saveRoleFamilyExperienceBandsBatch, tryGetStore, validateCompensationEvidenceBatchSubmission, validateRoleFamilyExperienceBandsBatchSubmission } from '../test-dependencies.js';
import { readFileSync } from 'node:fs';
import { compensationContextForSalary, researchCompensationAssessments } from '../../electron/ipc/jobs.js';
import { createDependencyReadyQueue, mapAutomaticHandoffs, runAutomaticHandoffWorkers } from '../../src/utils/handoffScheduler.js';
import {
  classifyCompensationFitEligibility,
  parseGuaranteedCashOffer,
  mergeCompetitiveRanges,
  compensationAssessment,
  compensationMarketCurrency,
  resolveCompensationMarketCurrency,
  resolveCompensationLocation,
  compensationResidencesForJob,
  canonicalizeCompensationLocation,
  compensationCohortKey,
  selectCompensationExperienceYears,
  estimateCompensationExperienceYearsFromDescription,
  isValidCompensationExperienceBandLadder,
  selectCompensationExperienceBand,
  isAuditableCompensationSource,
  selectComparableEvidence,
  sourcesPresentInGroundedResearch,
} from '../../electron/ipc/jobCompensation.js';
import { normalizeRemoteResidences } from '../../src/utils/jobSearchLocations.js';
import { JOB_COMPENSATION_EVIDENCE_BATCH_SCHEMA, ROLE_FAMILY_EXPERIENCE_BANDS_BATCH_SCHEMA, ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA } from '../../electron/ipc/aiSchemas.js';

export default [{
  name: 'Automatic handoff scheduler refills a compensation worker slot before a slow sibling settles',
  run: async () => {
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const started = [];
    let active = 0;
    let peak = 0;
    const run = mapAutomaticHandoffs(Array.from({ length: 11 }, (_, index) => index), 10, async (index) => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      if (index === 0) await slow;
      active -= 1;
      return index;
    });
    for (let attempt = 0; attempt < 20 && !started.includes(10); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert(started.slice(0, 10).join(',') === '0,1,2,3,4,5,6,7,8,9'
      && started.includes(10) && active === 1 && peak <= 10,
    `a completed automatic handoff slot must start descriptor 11 before slow descriptor 1 settles: ${JSON.stringify({ started, active, peak })}`);
    releaseSlow();
    const output = await run;
    assert(output.join(',') === '0,1,2,3,4,5,6,7,8,9,10' && active === 0,
      'the rolling scheduler preserves descriptor-order output after refilling an early slot');
    return { startedBeforeSlowSettlement: started.length, peak };
  },
}, {
  name: 'Role-family and compensation dependency queues prioritize ready assessments ahead of a slow raw tail',
  run: async () => {
    const exercise = async (name, rawCount, unlockAfter) => {
      const queue = createDependencyReadyQueue(Array.from({ length: rawCount }, (_unused, index) => ({ kind: 'raw', index })));
      const started = [];
      const releases = new Map();
      const settledRaw = new Set();
      let completedRaw = 0;
      const run = runAutomaticHandoffWorkers({
        workerCount: 10,
        claim: context => queue.claim(context),
        work: async descriptor => {
          started.push(descriptor);
          if (descriptor.kind === 'assessment') {
            queue.complete();
            return;
          }
          await new Promise(resolve => releases.set(descriptor.index, () => {
            settledRaw.add(descriptor.index);
            resolve();
          }));
          completedRaw++;
          if (completedRaw === unlockAfter) queue.add({ kind: 'assessment', index: 1 }, { front: true });
          queue.complete();
        },
      });
      for (let attempt = 0; attempt < 100 && releases.size < 10; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(releases.size === 10, `${name} must initially occupy the ten shared raw slots`);
      for (let index = 0; index < unlockAfter; index++) releases.get(index)();
      for (let attempt = 0; attempt < 100 && !started.some(item => item.kind === 'assessment'); attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(started.some(item => item.kind === 'assessment') && !settledRaw.has(9),
        `${name} must start its ready assessment before unrelated slow raw descriptor 10 settles`);
      for (const release of releases.values()) release();
      await run;
      return started.findIndex(item => item.kind === 'assessment');
    };
    const roleAssessmentAt = await exercise('role-family', 11, 3);
    const compensationAssessmentAt = await exercise('compensation', 12, 2);
    const source = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    assert(source.includes('async function runFreshRoleFamilyPipeline')
      && source.includes('async function runFreshCompensationPipeline')
      && source.match(/queue\.add\(\{ kind: 'assessment', assessmentBatch \}, \{ front: true \}\)/g)?.length === 2,
    'both production fresh pipelines use the centralized ready queue with assessment priority');
    assert(source.includes('const hasLegacyCompensationSteps =')
      && source.includes("await durableRunHasAnyTask(manualAiRunId, [")
      && source.includes("'job-compensation-research',")
      && source.includes('legacyResearchStepProbe: activeLegacyResearchStepProbe'),
    'fresh durable runs gate legacy prompt reconstruction once at run scope before either role or compensation work begins');
    return { roleAssessmentAt, compensationAssessmentAt };
  },
}, {
  name: 'Compensation batch contracts bind every role/cohort to an opaque raw-research section',
  run: () => {
    const roleId = 'a'.repeat(24);
    const otherId = 'b'.repeat(24);
    const raw = `BEGIN COMPENSATION RESEARCH ${roleId}\nEngineering framework: Senior engineers lead work. Updated 2026-01-01. https://roles.example.test/engineering\nEND COMPENSATION RESEARCH ${roleId}\nBEGIN COMPENSATION RESEARCH ${otherId}\nDesign framework: Principal designers lead design. Updated 2026-02-02. https://roles.example.test/design\nEND COMPENSATION RESEARCH ${otherId}`;
    const sections = parseCompensationResearchSections(raw, [roleId, otherId]);
    const ladders = validateRoleFamilyExperienceBandsBatchSubmission({ ladders: [{
      researchId: roleId, roleFamily: 'Engineering', reusedFrom: '',
      bands: [{ label: 'Early', minYears: 0, maxYears: 2 }, { label: 'Senior', minYears: 3, maxYears: 99 }],
      sources: [{ name: 'Engineering framework', url: 'https://roles.example.test/engineering' }],
      evidenceQuote: 'Senior engineers lead work', sourceDate: '2026-01-01',
    }, {
      researchId: otherId, roleFamily: 'Design', reusedFrom: '',
      bands: [{ label: 'Early', minYears: 0, maxYears: 2 }, { label: 'Principal', minYears: 3, maxYears: 99 }],
      sources: [{ name: 'Design framework', url: 'https://roles.example.test/design' }],
      evidenceQuote: 'Principal designers lead design', sourceDate: '2026-02-02',
    }] }, [{ researchId: roleId, role: 'Engineering' }, { researchId: otherId, role: 'Design' }], sections);
    assert(ladders.size === 2 && ROLE_FAMILY_EXPERIENCE_BANDS_BATCH_SCHEMA.properties.ladders.maxItems === 20,
      'role-family assessment batching must preserve one independently validated ladder per raw section and cap at twenty');
    const cachedRequest = [{ researchId: roleId, role: 'Engineering', cached: { roleFamily: 'Engineering' } }];
    const inertCached = validateRoleFamilyExperienceBandsBatchSubmission({ ladders: [{
      researchId: roleId, roleFamily: 'Engineering', reusedFrom: '', bands: [], sources: [], evidenceQuote: '', sourceDate: '',
    }] }, cachedRequest, sections);
    let cachedEvidenceRejected = false;
    try {
      validateRoleFamilyExperienceBandsBatchSubmission({ ladders: [{
        researchId: roleId, roleFamily: 'Engineering', reusedFrom: '',
        bands: [{ label: 'Early', minYears: 0, maxYears: 99 }], sources: [], evidenceQuote: '', sourceDate: '',
      }] }, cachedRequest, sections);
    } catch { cachedEvidenceRejected = true; }
    assert(inertCached.get(roleId)?.available === false && cachedEvidenceRejected,
      'partial stable assessment slices retain cached identities only as inert rows, never reconstructed or model-authored provenance');

    const cohortId = 'c'.repeat(24);
    const cohortOtherId = 'd'.repeat(24);
    const cohortSections = new Map([
      [cohortId, 'Salary source says $100,000 to $120,000 base pay. Updated 2026-03-03. https://salary.example.test/engineering'],
      [cohortOtherId, 'Salary source says $150,000 to $170,000 base pay. Updated 2026-04-04. https://salary.example.test/design'],
    ]);
    const requests = [
      { researchId: cohortId, group: { jobs: [{ marketCurrency: 'USD' }] } },
      { researchId: cohortOtherId, group: { jobs: [{ marketCurrency: 'USD' }] } },
    ];
    let crossSectionRejected = false;
    let crossSectionDiagnostic = null;
    try {
      validateCompensationEvidenceBatchSubmission({ cohorts: [{ researchId: cohortId, assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [{ min: 150000, max: 170000, currency: 'USD', comparable: true, sourceName: 'Design source', sourceUrl: 'https://salary.example.test/design', evidenceQuote: '$150,000 to $170,000 base pay', sourceDate: '2026-04-04' }] }] }, { researchId: cohortOtherId, assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [] }] }] }, requests, cohortSections);
    } catch (error) {
      crossSectionRejected = true;
      crossSectionDiagnostic = error?.validationDiagnostic;
      assert(error?.code === 'JOB_COMPENSATION_RESPONSE_INVALID',
        'a compensation semantic rejection must retain its fixed non-API handoff error code');
    }
    let coverageDiagnostic = null;
    try {
      validateCompensationEvidenceBatchSubmission({ cohorts: [{ researchId: cohortId, assessments: [] }, { researchId: cohortOtherId, assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [] }] }] }, requests, cohortSections);
    } catch (error) { coverageDiagnostic = error?.validationDiagnostic; }
    let provenanceDiagnostic = null;
    try {
      validateCompensationEvidenceBatchSubmission({ cohorts: [{ researchId: cohortId, assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [{ min: 100000, max: 120000, currency: 'USD', comparable: true, sourceName: 'Engineering source', sourceUrl: 'https://salary.example.test/engineering', evidenceQuote: '$150,000 to $170,000 base pay', sourceDate: '2026-04-04' }] }] }, { researchId: cohortOtherId, assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [] }] }] }, requests, cohortSections);
    } catch (error) { provenanceDiagnostic = error?.validationDiagnostic; }
    assert(crossSectionRejected
      && crossSectionDiagnostic?.stage === 'compensation-assessment'
      && crossSectionDiagnostic?.reason === 'COMPENSATION_RANGE_INVALID'
      && coverageDiagnostic?.reason === 'COMPENSATION_ASSESSMENT_COVERAGE_INVALID'
      && coverageDiagnostic?.expectedCount === 1
      && coverageDiagnostic?.receivedCount === 0
      && provenanceDiagnostic?.reason === 'COMPENSATION_EVIDENCE_NOT_GROUNDED'
      && JOB_COMPENSATION_EVIDENCE_BATCH_SCHEMA.properties.cohorts.maxItems === 6,
    'salary contract rejections stay fail-closed while carrying only fixed, correction-safe diagnostics through the manual handoff');

    let outsideSectionRejected = false;
    let nestedMarkerRejected = false;
    let foreignSourceLinkAccepted = false;
    try { parseCompensationResearchSections(`Preface must not be accepted\n${raw}`, [roleId, otherId]); } catch { outsideSectionRejected = true; }
    try {
      parseCompensationResearchSections(
        `BEGIN COMPENSATION RESEARCH ${roleId}\nfirst\nBEGIN COMPENSATION RESEARCH ${otherId}\nsecond\nEND COMPENSATION RESEARCH ${otherId}\nEND COMPENSATION RESEARCH ${roleId}`,
        [roleId, otherId],
      );
    } catch { nestedMarkerRejected = true; }
    try {
      const accepted = validateCompensationEvidenceBatchSubmission({ cohorts: [{
        researchId: cohortId,
        assessments: [{ index: 0, justification: 'x', sourceLinks: ['https://salary.example.test/design'], comparableRanges: [] }],
      }, {
        researchId: cohortOtherId,
        assessments: [{ index: 0, justification: 'x', sourceLinks: [], comparableRanges: [] }],
      }] }, requests, cohortSections);
      foreignSourceLinkAccepted = accepted.get(cohortId)?.[0]?.sourceLinks?.[0] === 'https://salary.example.test/design';
    } catch { foreignSourceLinkAccepted = false; }
    const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    const normalizerStart = jobsSource.indexOf('function applyCompensationEvidenceToGroup(');
    const normalizerEnd = jobsSource.indexOf('\nasync function processCompensationCohortBatches(', normalizerStart);
    const normalizer = jobsSource.slice(normalizerStart, normalizerEnd);
    assert(outsideSectionRejected && nestedMarkerRejected && foreignSourceLinkAccepted
      && normalizerStart >= 0 && normalizerEnd > normalizerStart
      && normalizer.includes('const links = comparable.map(')
      && !normalizer.includes('answer?.sourceLinks'),
    'raw compensation sections remain identity-bound while optional display-only sourceLinks cannot reject, display, or persist from a valid cohort batch');
    return { roleSections: ladders.size, crossSectionRejected, outsideSectionRejected, nestedMarkerRejected, foreignSourceLinkAccepted, cachedEvidenceRejected };
  },
}, {
  name: 'Role-family v2 cache batch commits valid rows in one atomic Settings write',
  run: () => {
    const store = tryGetStore();
    assert(store, 'the test Settings store must be available');
    const cachePath = 'jobs.roleFamilyExperienceBands';
    const before = store.get(cachePath);
    const originalSet = store.set;
    let cacheWrites = 0;
    store.set = function countedSet(key, value) {
      if (key === cachePath) cacheWrites++;
      return originalSet.call(this, key, value);
    };
    const ladder = (roleFamily) => ({
      roleFamily,
      bands: [{ label: 'Early', minYears: 0, maxYears: 2 }, { label: 'Senior', minYears: 3, maxYears: 99 }],
      sources: [{ name: 'Framework', url: `https://roles.example.test/${encodeURIComponent(roleFamily)}` }],
      verifiedDate: '2026-09-18T00:00:00.000Z',
    });
    try {
      const saved = saveRoleFamilyExperienceBandsBatch([
        { roleFamily: '__proto__', value: ladder('__proto__') },
        { roleFamily: 'Fresh V2 Role', value: ladder('Fresh V2 Role') },
        { roleFamily: 'Unavailable Role', value: { bands: [], sources: [] } },
      ]);
      const cache = getRoleFamilyExperienceBandCache();
      assert(cacheWrites === 1 && saved.length === 2
        && Object.hasOwn(cache, '__proto__')
        && Object.hasOwn(cache, 'fresh v2 role')
        && !Object.hasOwn(cache, 'unavailable role'),
      'one v2 assessment writes every valid prototype-safe ladder together while unavailable rows remain uncached');
    } finally {
      store.set = originalSet;
      if (before === undefined) store.delete(cachePath);
      else store.set(cachePath, before);
    }
    return { atomicWrites: cacheWrites };
  },
}, {
  name: 'Compensation assessment phases pack independently of their smaller raw-research phases',
  run: () => {
    const roles = Array.from({ length: 21 }, (_, index) => ({ key: `role-${index}`, role: `Role ${index}`, researchId: `id-${index}`, cached: null }));
    const rolePlan = planRoleFamilyAssessmentBatches(roles);
    const cohorts = Array.from({ length: 6 }, (_, index) => ({ researchKey: `market-${index}`, researchId: `cohort-${index}`, group: { jobs: [{}] } }));
    const rawPlan = packCompensationResearchBatches(cohorts);
    const assessmentPlan = packCompensationAssessmentBatches(cohorts);
    assert(rolePlan.length === 2 && rolePlan[0].batch.length === 20 && rolePlan[1].batch.length === 1
      && roleFamilyAssessmentMaxTokens(20) === 15024,
    'twenty compact role ladders fit one 15,024-token assessment even though raw research remains seven at a time');
    assert(rawPlan.length === 2 && rawPlan[0].length === 4 && assessmentPlan.length === 1 && assessmentPlan[0].length === 6,
      'six one-row salary assessments share one prompt while raw market research remains four cohorts per prompt');
    return { roleAssessment: rolePlan[0].batch.length, cohortAssessment: assessmentPlan[0].length };
  },
}, {
  name: 'Role-family cache preserves later durable batch membership and ordinal after restart',
  run: () => {
    const roles = Array.from({ length: 9 }, (_, index) => ({
      key: `role-${index + 1}`,
      role: `Role ${index + 1}`,
      researchId: `role-id-${index + 1}`,
      // Model an app restart after batch one was accepted and persisted:
      // its seven ladders are cache hits while batch two remains pending.
      cached: index < 7 ? { roleFamily: `Role ${index + 1}`, cacheHit: true } : null,
    }));
    const plan = planRoleFamilyResearchBatches(roles);
    const first = plan[0];
    const pendingSecond = plan[1];
    assert(plan.length === 2 && first.batchNumber === 1 && first.batchTotal === 2
      && first.missingEntries.length === 0,
    'the accepted first role-family slice may be skipped only as a whole');
    assert(pendingSecond.batchNumber === 2 && pendingSecond.batchTotal === 2
      && pendingSecond.batch.map(entry => entry.researchId).join(',') === 'role-id-8,role-id-9'
      && pendingSecond.missingEntries.length === 2,
    'the formerly pending second slice must keep its original batch=2/total=2 prompt metadata and exact membership');
    const beforeRestartPrompt = buildRoleFamilyBatchResearchPrompt(pendingSecond.batch.map(entry => ({ ...entry, cached: null })));
    const afterRestartPrompt = buildRoleFamilyBatchResearchPrompt(pendingSecond.batch.map((entry, index) => ({
      ...entry,
      // Simulate a cache that changed while an earlier slice completed; the
      // role prompt must remain a function of only this stable slice's ids.
      cached: index === 0 ? { roleFamily: entry.role, cacheHit: true } : null,
    })));
    assert(canonicalizeGeneratedUntrustedBoundaryNonces(beforeRestartPrompt) === canonicalizeGeneratedUntrustedBoundaryNonces(afterRestartPrompt)
      && !afterRestartPrompt.includes('known-role-family-ladders'),
      'a newly cached first slice must not alter the literal raw prompt/hash of the pending second role-family handoff');

    const partial = planRoleFamilyResearchBatches(roles.map((entry, index) => ({ ...entry, cached: index < 2 ? entry.cached : null })))[0];
    assert(partial.batch.length === 7 && partial.cachedEntries.length === 2 && partial.missingEntries.length === 5,
      'a partial stable slice must be reissued intact while retaining its cached rows for non-overwriting merge');
    return { preservedBatch: `${pendingSecond.batchNumber}/${pendingSecond.batchTotal}`, partialCachedRows: partial.cachedEntries.length };
  },
}, {
  name: 'Compensation raw and assessment plans keep later handoff membership when earlier slices become cached',
  run: () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      researchKey: `market-${index + 1}`,
      researchId: `cohort-${index + 1}`,
      group: { jobs: [{}] },
    }));
    const rawPlan = packCompensationResearchBatches(entries);
    const assessmentPlan = packCompensationAssessmentBatches(entries);
    // Cache state is deliberately not an input to either plan. The pipeline
    // marks completed entries only after these exact slices have been derived.
    const cacheAfterFirstRaw = new Set(rawPlan[0].map(entry => entry.researchKey));
    const rawLater = rawPlan.slice(1).flat().map(entry => entry.researchId).join(',');
    const assessmentLater = assessmentPlan.slice(1).flat().map(entry => entry.researchId).join(',');
    assert(rawPlan.length === 3 && rawPlan[1].map(entry => entry.researchId).join(',') === 'cohort-5,cohort-6,cohort-7,cohort-8'
      && cacheAfterFirstRaw.size === 4
      && rawLater === 'cohort-5,cohort-6,cohort-7,cohort-8,cohort-9'
      && assessmentLater === 'cohort-7,cohort-8,cohort-9',
    'later raw and assessment handoff identities are derived from the full ordered plan, not a cache-filtered remainder');
    return { rawBatches: rawPlan.length, assessmentBatches: assessmentPlan.length };
  },
}, {
  name: 'Oversized compensation cohort researches its market once, then reuses it across bounded assessment batches',
  run: () => {
    // 39 rows become [19, 19, 1] assessment parts.  The fresh raw planner
    // deliberately keeps a researchKey unique within each batch; after the
    // first accepted part, the remaining parts read its raw cache and issue
    // only their JSON assessment handoffs.
    const parts = [19, 19, 1].map((count, index) => ({
      researchKey: 'same-market-cohort',
      researchId: `part-${index + 1}`,
      group: { jobs: Array.from({ length: count }, () => ({})) },
    }));
    const rawPlan = packCompensationResearchBatches(parts);
    const assessmentPlan = packCompensationAssessmentBatches(parts);
    const cachedRaw = new Set();
    const rawResearchCalls = rawPlan.flatMap(batch => batch.filter(entry => {
      if (cachedRaw.has(entry.researchKey)) return false;
      cachedRaw.add(entry.researchKey);
      return true;
    }));
    assert(rawResearchCalls.length === 1 && rawResearchCalls[0].researchId === 'part-1',
      'all row parts of one original cohort must issue one raw market-research section, not duplicate lookups');
    assert(assessmentPlan.length === 3 && assessmentPlan.flat().length === 3,
      'the same oversized cohort must still retain separately bounded exact-index assessment batches');
    return { rawResearchCalls: rawResearchCalls.length, assessmentBatches: assessmentPlan.length };
  },
}, {
  name: 'Compensation batching uses bounded multi-batch task IDs while exact legacy prompts retain only their own one-item IDs',
  run: () => {
    const source = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    assert(source.includes('ROLE_FAMILY_HANDOFF_BATCH_SIZE = 7')
      && source.includes('COMPENSATION_COHORT_HANDOFF_BATCH_SIZE = 4')
      && source.includes("task: 'job-compensation-research-batch'")
      && source.includes("task: 'job-compensation-assessment-batch'"),
      'raw research remains bounded while its downstream assessment phase has separate deterministic batches');
    assert(source.includes('legacyResearchStepProbe')
      && source.includes('legacyAssessmentStepProbe')
      && source.includes('hasExactDurableRawHandoff(prompt')
      && source.includes('hasExactDurableTextHandoff(prompt')
      && source.includes('buildLegacyRoleFamilyResearchPrompt')
      && source.includes('buildLegacyCompensationResearchPrompt')
      && source.includes('const legacyCompleteKeys = new Set(prepared')
      && source.includes("mode === 'v1-complete'")
      && source.includes('const legacyRawV2Keys = new Set(prepared')
      && source.includes("mode === 'raw-v2'")
      && source.includes('recallRunMigration(manualAiRunId')
      && source.includes('rememberRunMigration(manualAiRunId')
      && source.includes('hints: { itemCount: group.jobs.length }')
      && source.includes("const rawDescriptors = [")
      && source.includes("...legacyRawCandidates.map(candidate => ({ kind: 'legacy', ...candidate }))")
      && source.includes("...freshRawPlans.map(rawBatch => ({ kind: 'fresh', rawBatch }))")
      && source.includes('const rawPhase = await mapAutomaticHandoffs(rawDescriptors, HANDOFF_CONCURRENCY')
      && source.includes('const legacyAssessmentCandidates = []')
      && source.includes('await mapAutomaticHandoffs(legacyAssessmentCandidates, HANDOFF_CONCURRENCY')
      && source.includes('const completedRawDescriptors = await mapAutomaticHandoffs(rawDescriptors, HANDOFF_CONCURRENCY')
      && source.includes('const legacyAssessmentDescriptors = completedRawDescriptors')
      && !source.includes('getExperienceBandsForRoleFamily(')
      && !source.includes('useLegacyIndividualCompensation'),
    'exact legacy and fresh raw prompts share the rolling automatic scheduler, while their dependent legacy/current extractions remain later phases');
    assert(source.includes('MAX_COMPENSATION_ROWS_PER_ASSESSMENT_COHORT')
      && source.includes('compensationCohortAssessmentFits(nextCohorts, nextRows)')
      && source.includes('const rawFirstParts = []')
      && source.includes('const stableRawBatches = packCompensationResearchBatches(rawFirstParts)')
      && source.includes('const stableAssessmentBatches = packCompensationAssessmentBatches(freshAll)')
      && source.includes('propagate its exact section to later parts below'),
    'boundary-size and oversized cohorts must use the shared 15,360 assessment formula and reuse their completed raw research');
    assert(source.includes('mapAutomaticHandoffs(roleResearchBatches, HANDOFF_CONCURRENCY,')
      && source.includes('mapAutomaticHandoffs(roleAssessmentBatches, HANDOFF_CONCURRENCY,')
      && source.includes('mapAutomaticHandoffs(assessmentBatchPlans, HANDOFF_CONCURRENCY,'),
    'independent role-family, salary-research, and salary-assessment batches refill the automatic worker pool while later row parts reuse their first market lookup');
    assert(compensationCohortAssessmentMaxTokens(4, 13) === 15074
      && compensationCohortAssessmentFits(4, 13)
      && !compensationCohortAssessmentFits(4, 14),
    'the shared compensation cap must match the batcher boundary exactly');
    const restartLayout = Array.from({ length: 8 }, (_, index) => ({ key: `role-${index}`, legacy: index === 0, cached: index === 0 }));
    const firstPassV2 = restartLayout.filter(entry => !entry.legacy).map(entry => entry.key);
    const restartedV2 = restartLayout.filter(entry => !(entry.cached && entry.legacy)).map(entry => entry.key);
    assert(firstPassV2.join(',') === restartedV2.join(','),
      'a completed legacy role must remain outside the v2 layout after restart rather than inserting a newly cached identity before a pending batch');
    // A raw-only v1 role can be one member of an accepted v2 twenty-role
    // extraction.  On restart it is now cached, just like its fresh-v2
    // siblings, so the whole completed slice disappears rather than issuing a
    // different prompt with nineteen CACHED markers and one raw legacy row.
    const mixedAcceptedRestart = Array.from({ length: 21 }, (_, index) => ({
      key: `mixed-role-${index}`,
      researchId: `mixed-id-${index}`,
      legacyRawV2: index === 0,
      cached: index < 20 ? { roleFamily: `Mixed Role ${index}` } : null,
    }));
    const mixedRestartPlan = planRoleFamilyAssessmentBatches(mixedAcceptedRestart);
    assert(mixedRestartPlan.length === 2
      && mixedRestartPlan[0].missingEntries.length === 0
      && mixedRestartPlan[1].batchNumber === 2
      && mixedRestartPlan[1].batchTotal === 2
      && mixedRestartPlan[1].batch.map(entry => entry.researchId).join(',') === 'mixed-id-20',
    'an accepted mixed raw-v1 + fresh-v2 assessment slice must be skipped as a whole while the later pending slice keeps its ordinal and membership');
    assert(source.includes('const legacyCachedRawV2 = new Map(prepared')
      && source.includes('if (!missing.length) return results;')
      && source.includes('!legacyCachedRawV2.has(entry.key)')
      && source.includes("if (entry.legacyRawResearch && !entry.cached)")
      && source.includes('saveRoleFamilyExperienceBandsBatch(validEntries.map')
      && source.includes('saveRoleFamilyExperienceBandsBatch,'),
    'a cached raw-only v1 role stays a cached annotated v2-plan member, and all valid rows from an accepted v2 slice are persisted in one Settings write');
    return { roleRawBatch: 7, roleAssessmentBatch: 20, cohortRawBatch: 4, cohortAssessmentBatch: 6, exactLegacyMigration: true, restartLayoutStable: true, mixedAcceptedSliceSkipped: true, atomicV2CacheSave: true, maxRowsSingleCohort: 19 };
  },
}, {
  name: 'classifyCompensationFitEligibility: the configured boundary is inclusive and an unscored job is not a low-scoring job',
  run: () => {
    const opts = { minScore: COMPENSATION_MIN_FIT_SCORE, unscoredSentinel: 50 };
    const justBelowThreshold = COMPENSATION_MIN_FIT_SCORE - 1;
    // The configured boundary must be INCLUSIVE — an off-by-one here silently
    // denies the check to exactly the jobs sitting on the bar. The user asked
    // for "70% hiring fit or above", so this pins the constant itself too.
    assert(COMPENSATION_MIN_FIT_SCORE === 70, `COMPENSATION_MIN_FIT_SCORE must be 70 per the shared contract, got ${COMPENSATION_MIN_FIT_SCORE}`);
    assert(classifyCompensationFitEligibility(COMPENSATION_MIN_FIT_SCORE, opts) === 'eligible',
      `${COMPENSATION_MIN_FIT_SCORE} must be eligible (threshold is inclusive)`);
    assert(classifyCompensationFitEligibility(justBelowThreshold, opts) === 'below-threshold',
      `${justBelowThreshold} must be below the threshold`);
    assert(classifyCompensationFitEligibility(100, opts) === 'eligible', '100 must be eligible');
    assert(classifyCompensationFitEligibility(0, opts) === 'below-threshold', '0 must be below the threshold');
    // An unscored job must NEVER be reported as a weak match. The scorer's
    // sentinel marks "no assessment happened", so reading it as a real 50
    // would tell the user their job was judged and found wanting when it was
    // never judged at all.
    assert(classifyCompensationFitEligibility(50, opts) === 'score-unavailable',
      'the unscored sentinel must read as score-unavailable, never as a genuine mid score');
    for (const missing of [null, undefined, NaN, Infinity, '82', {}]) {
      assert(classifyCompensationFitEligibility(missing, opts) === 'score-unavailable',
        `a non-numeric score must read as score-unavailable → ${String(missing)}`);
    }
    // With no sentinel configured, 50 is an ordinary score like any other.
    assert(classifyCompensationFitEligibility(50, { minScore: COMPENSATION_MIN_FIT_SCORE }) === 'below-threshold',
      'with no sentinel configured, 50 is an ordinary below-threshold score');
    return { threshold: COMPENSATION_MIN_FIT_SCORE };
  },
}, {
  name: 'A JD-derived experience band produces a salary verdict from researched cash evidence',
  run: () => {
    const job = {
      location: 'Toronto, Ontario, Canada',
      salary: 'C$120,000 per year',
      description: 'This role requires at least 5 years of relevant experience.',
    };
    const estimate = estimateCompensationExperienceYearsFromDescription(job);
    const band = selectCompensationExperienceBand([
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Experienced', minYears: 3, maxYears: 6 },
      { label: 'Senior+', minYears: 7, maxYears: 99 },
    ], estimate.years);
    const offer = parseGuaranteedCashOffer(job);
    const result = compensationAssessment({
      offer,
      competitiveRanges: [{ min: 100_000, max: 110_000, currency: 'CAD' }],
      marketCurrency: 'CAD',
      comparisonLocation: job.location,
      justification: 'Comparable current market ranges were researched.',
    });
    assert(estimate.years === 5 && estimate.basis === 'description-stated-minimum'
      && band?.label === 'Experienced' && result.status === 'competitive',
    'a listing-only experience estimate must select a real research band, and a compatible researched range must still yield the normal cash-pay verdict');
    return { estimate: estimate.years, band: band.label, verdict: result.status };
  },
}, {
  name: 'Salary research derives seniority from the listing title before an untrusted scoring context',
  run: () => {
    const junior = compensationContextForSalary({ title: 'Junior Engineer' }, { seniority: 'senior' });
    const seniorManager = compensationContextForSalary({ title: 'Senior Engineering Manager' }, { seniority: 'senior' });
    const principal = compensationContextForSalary({ title: 'Principal Engineer' }, { seniority: 'junior' });
    assert(junior.seniority === 'entry'
      && seniorManager.seniority === 'manager'
      && principal.seniority === 'director',
    'the title must set the salary-market seniority so a stale or ungrounded scoring context cannot move a listing into the wrong pay market');
    return { junior: junior.seniority, seniorManager: seniorManager.seniority, principal: principal.seniority };
  },
}, {
  name: 'Compensation sends no-numeric-years listings through JD-derived role-band and market analysis',
  run: async () => {
    const progress = [];
    const jobs = [{
      title: 'Product Designer',
      location: 'Toronto, Ontario, Canada',
      salary: 'C$120,000 per year',
      matchScore: 91,
      description: 'Work with product and engineering partners to improve a well-established customer experience.',
      compensationContext: { roleFamily: 'Product Design', seniority: 'unspecified', employmentType: 'full-time' },
      experienceAssessment: { categorySpecificExperience: [] },
    }];
    const event = { sender: { isDestroyed: () => false, send: (_channel, payload) => progress.push(payload) } };
    await researchCompensationAssessments(jobs, {
      event,
      nodeId: 'jd-estimate-abort-regression',
      signal: { aborted: true },
    });
    const { getJobsTelemetry } = await import('../test-dependencies.js');
    const telemetry = getJobsTelemetry().compensation;
    assert(jobs[0].compensationAssessment?.reasonCode === 'research_interrupted',
      'a JD-derived estimate must enter the role-band stage; an aborted run reports interruption rather than experience_band_unavailable');
    assert(telemetry?.eligible === 1 && telemetry?.preResearchCandidates === 1
      && telemetry?.roleBandInterruptedJobs === 1 && telemetry?.skippedNoExperience === 0
      && telemetry?.marketCandidates === 0 && telemetry?.cohorts === 0,
    `a fit-qualified listing with no numeric years must reach the role-band prerequisite through its JD estimate, got ${JSON.stringify(telemetry)}`);
    assert(progress.at(-1)?.processed === 1 && progress.at(-1)?.total === 1,
      'the interrupted JD-estimate path must complete the card progress exactly once');
    return { preResearchCandidates: telemetry.preResearchCandidates, interrupted: telemetry.roleBandInterruptedJobs };
  },
}, {
  name: 'Compensation early abort keeps role-band interruption distinct from failed lookup and market cohorts',
  run: async () => {
    const jobs = [{
      title: 'Senior Platform Engineer',
      location: 'Toronto, Ontario, Canada',
      salary: 'C$130,000 per year',
      matchScore: 88,
      compensationContext: { roleFamily: 'Platform Engineering', seniority: 'senior', employmentType: 'full-time' },
      experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 5 }] },
    }];
    await researchCompensationAssessments(jobs, {
      nodeId: 'role-band-early-abort',
      signal: { aborted: true },
    });
    const { getJobsTelemetry } = await import('../test-dependencies.js');
    const telemetry = getJobsTelemetry().compensation;
    assert(jobs[0].compensationAssessment?.reasonCode === 'research_interrupted',
      'an already-aborted role-band candidate must receive the explicit interruption fallback');
    assert(telemetry?.preResearchCandidates === 1 && telemetry.roleBandInterruptedJobs === 1
      && telemetry.roleBandFailures === 0 && telemetry.roleBandFailureJobs === 0
      && telemetry.marketCandidates === 0 && telemetry.cohorts === 0
      && telemetry.failedCohorts === 0 && telemetry.marketCohortFailures === 0,
    `pre-group interruption must not fabricate lookup/market failures, got ${JSON.stringify(telemetry)}`);
    return { interrupted: telemetry.roleBandInterruptedJobs };
  },
}, {
  name: 'Role-family band extraction permits honest empty evidence and retains only grounded URLs',
  run: () => {
    assert(!('minItems' in ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.bands)
      && !('minItems' in ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.sources),
    'role-band schema must permit empty arrays so insufficient research blocks honestly instead of forcing fabricated rows');
    const bandSchema = ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.bands.items.properties;
    assert(bandSchema.minYears.type === 'integer' && bandSchema.maxYears.type === 'integer',
      'the provider schema requires the same whole-year boundaries enforced by the persisted contiguous-ladder validator');
    const retained = sourcesPresentInGroundedResearch([
      { name: 'Grounded framework', url: 'https://careers.example.test/framework' },
      { name: 'Invented but plausible', url: 'https://invented.example.test/ladder' },
      { name: 'Unsafe scheme', url: 'file:///etc/passwd' },
    ], 'The grounded search found https://careers.example.test/framework.');
    assert(retained.length === 1 && retained[0].url === 'https://careers.example.test/framework',
      'only a direct HTTP URL actually present in grounded raw research may enter the experience-band cache');
    const salaryRanges = sourcesPresentInGroundedResearch([
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Grounded salary source', sourceUrl: 'https://salary.example.test/role' },
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'Invented salary source', sourceUrl: 'https://invented.example.test/pay' },
    ], 'The grounded search found https://salary.example.test/role.');
    assert(salaryRanges.length === 1 && salaryRanges[0].sourceUrl === 'https://salary.example.test/role'
      && selectComparableEvidence(salaryRanges, 5, 'USD').length === 1,
    'a schema-valid salary URL absent from the grounded response cannot drive a compensation verdict');
    const metadataOnly = sourcesPresentInGroundedResearch([
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Provider citation', sourceUrl: 'https://provider.example.test/cited' },
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'Prose-only URL', sourceUrl: 'https://prose.example.test/untrusted' },
    ], `Grounded source URLs (provider metadata):
- https://provider.example.test/cited — Provider citation

Model prose happens to mention https://prose.example.test/untrusted.`);
    assert(metadataOnly.length === 1 && metadataOnly[0].sourceUrl === 'https://provider.example.test/cited',
      'when provider metadata exists, a URL mentioned only in model prose cannot satisfy compensation provenance');
    assert(sourcesPresentInGroundedResearch(
      [{ sourceUrl: 'https://prose.example.test/untrusted' }],
      'Grounded source URLs (provider metadata):\n\nMalformed metadata with https://prose.example.test/untrusted.',
    ).length === 0,
    'a present but malformed provider appendix fails closed instead of falling back to model prose');
    return { retained: retained.length, salaryRanges: salaryRanges.length, metadataOnly: metadataOnly.length };
  },
}, {
  name: 'Compensation extraction cache is bound to its exact grounded research',
  run: () => {
    const originalResearch = 'Source A: https://example.test/pay — USD 100,000–120,000';
    const correctedResearch = 'Source A: https://example.test/pay — USD 120,000–140,000';
    const cached = {
      researchFingerprint: compensationResearchFingerprint(originalResearch),
      entries: [{ index: 0 }],
    };
    assert(compensationAssessmentCacheMatchesResearch(cached, originalResearch),
      'an extraction remains reusable with the exact raw evidence it parsed');
    assert(!compensationAssessmentCacheMatchesResearch(cached, correctedResearch)
      && !compensationAssessmentCacheMatchesResearch({ entries: cached.entries }, originalResearch)
      && !compensationAssessmentCacheMatchesResearch(cached, ''),
    'corrected, legacy-unbound, or missing research cannot reuse an older extraction even when source URLs overlap');
    return { exactMatch: true, correctedRejected: true };
  },
}, {
  name: 'Role-family experience-band lookup keeps grounded research separate from schema extraction',
  run: () => {
    const source = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function getExperienceBandsForRoleFamilies');
    const end = source.indexOf('\n/**\n * Research cash salary', start);
    const resolver = source.slice(start, end);
    assert(start >= 0 && end > start, 'the role-family experience-band resolver must remain a distinct audited path');
    assert(/callLLMRaw\([\s\S]*?grounding:\s*true/.test(resolver),
      'experience-band research must use the raw grounded path; structured calls cannot activate Claude web search');
    assert(/callLLMText\([\s\S]*?responseSchema:\s*ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA/.test(resolver)
      && resolver.includes('const rawPhase = await mapAutomaticHandoffs(rawDescriptors, HANDOFF_CONCURRENCY')
      && resolver.includes('await mapAutomaticHandoffs(legacyAssessmentCandidates, HANDOFF_CONCURRENCY'),
      'grounded role-family prose must still go through schema-constrained extraction before persistence');
    return { grounded: true };
  },
}, {
  name: 'Cash compensation parsing, source union, and exact market-floor verdict',
  run: () => {
    const canadian = parseGuaranteedCashOffer({ salary: 'C$70,000–C$95,000 per year' });
    assert(canadian.usable && canadian.max === 95000 && canadian.currency === 'CAD', 'must parse annual stated cash range');
    const oneSymbolRange = parseGuaranteedCashOffer({ salary: '$80,000–100,000 per year', location: 'Austin, Texas, USA' });
    assert(oneSymbolRange.usable && oneSymbolRange.min === 80000 && oneSymbolRange.max === 100000, 'one currency symbol must still preserve both range endpoints');
    const shorthandRange = parseGuaranteedCashOffer({ salary: '$80–100k per year', location: 'Austin, Texas, USA' });
    assert(shorthandRange.usable && shorthandRange.min === 80000 && shorthandRange.max === 100000, 'a shared k suffix must apply to both range endpoints');
    assert(!parseGuaranteedCashOffer({ salary: 'Commission only, uncapped earnings' }).usable, 'variable-only pay cannot be evaluated');
    assert(!parseGuaranteedCashOffer({ salary: 'Equity worth $100k' }).usable, 'equity cannot be converted into guaranteed cash');
    const baseOnly = parseGuaranteedCashOffer({ salary: '$150k OTE, base salary $80k', location: 'Austin, Texas, USA' });
    assert(baseOnly.usable && baseOnly.min === 80000 && baseOnly.max === 80000, 'OTE must not inflate a separately stated base salary');
    const trailingBase = parseGuaranteedCashOffer({ salary: '$80k–$100k base salary + bonus', location: 'Austin, Texas, USA' });
    assert(trailingBase.usable && trailingBase.min === 80000 && trailingBase.max === 100000, 'a base marker after the range must retain both base endpoints');
    const leadingBase = parseGuaranteedCashOffer({ salary: 'Base salary $80k–$100k + bonus', location: 'Austin, Texas, USA' });
    assert(leadingBase.usable && leadingBase.min === 80000 && leadingBase.max === 100000, 'a base marker before the range must retain both base endpoints');
    const trailingOte = parseGuaranteedCashOffer({ salary: 'Base salary $80k, $150k OTE', location: 'Austin, Texas, USA' });
    assert(trailingOte.usable && trailingOte.min === 80000 && trailingOte.max === 80000, 'an OTE label after its amount must not inflate base pay');
    const totalComp = parseGuaranteedCashOffer({ salary: 'Total compensation $150k, base salary $100k', location: 'Austin, Texas, USA' });
    assert(totalComp.usable && totalComp.max === 100000, 'total compensation cannot inflate a separately stated base salary');
    for (const salary of [
      'Commission plus base salary $80k',
      'commission + $80k base salary',
      'base salary $80k and commission',
      'commission + base salary $80k + $20k bonus',
    ]) {
      const mixedPay = parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' });
      assert(mixedPay.usable && mixedPay.min === 80000 && mixedPay.max === 80000,
        `a stated base must survive variable-pay wording on either side: ${salary}`);
    }
    const hourlyBase = parseGuaranteedCashOffer({ salary: 'base pay $45/hour plus commission', description: '40 hours per week', location: 'Austin, Texas, USA' });
    assert(hourlyBase.usable && hourlyBase.max === 93600 && hourlyBase.annualized, 'an extracted base hourly rate must retain its cadence');
    const weeklyBase = parseGuaranteedCashOffer({ salary: 'base pay $2,000/week + bonus', location: 'Austin, Texas, USA' });
    assert(weeklyBase.usable && weeklyBase.max === 104000 && weeklyBase.annualized, 'an extracted base weekly rate must retain its cadence');
    const monthlyBase = parseGuaranteedCashOffer({ salary: 'base salary $8,000/month + equity', location: 'Austin, Texas, USA' });
    assert(monthlyBase.usable && monthlyBase.max === 96000 && monthlyBase.annualized, 'an extracted base monthly rate must retain its cadence');
    for (const salary of ['from $80k', 'minimum $80k', 'starting salary $80k']) {
      assert(parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' }).reasonCode === 'salary_maximum_unstated',
        `a one-sided lower bound cannot be treated as a fixed offer: ${salary}`);
    }
    assert(parseGuaranteedCashOffer({ salary: 'up to $100k', location: 'Austin, Texas, USA' }).max === 100000,
      'an explicit upper bound remains usable for the maximum-vs-floor comparison');
    const bareAnnual = parseGuaranteedCashOffer({ salary: 'Salary: 100000 per year', location: 'Austin, Texas, USA' });
    assert(bareAnnual.usable && bareAnnual.max === 100000 && bareAnnual.currency === 'USD', 'a single annual number uses the unambiguous comparison-location currency');
    const fallbackCompensation = parseGuaranteedCashOffer({ salary: '   ', compensation: '$90k/year', location: 'Austin, Texas, USA' });
    assert(fallbackCompensation.usable && fallbackCompensation.max === 90000, 'a blank primary salary field must not hide a scraper compensation fallback');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Part-time flexible' }).reasonCode === 'hourly_hours_unclear', 'must not invent annual hours');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Full-time, 40 hours per week', location: 'Austin, Texas, USA' }).max === 93600, 'known full-time hourly pay annualizes deterministically');
    const merged = mergeCompetitiveRanges([
      { min: 100000, max: 130000, currency: 'CAD' },
      { min: '85000', max: '115000', currency: ' cad ' },
    ], 'CAD');
    assert(merged.min === 85000 && merged.max === 130000 && merged.currency === 'CAD', 'conflicting comparable sources must union A–D despite normalized currency/numeric strings');
    assert(mergeCompetitiveRanges([{ min: 85000, max: 110000, currency: '' }], 'CAD') === null,
      'market evidence with no currency cannot be treated as the listing currency');
    assert(isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'https://example.test/pay' }), 'an http(s) source with a title is auditable');
    assert(!isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'file:///etc/passwd' }) && !isAuditableCompensationSource({ min: 1, max: 2 }), 'unlinked or unsafe source evidence cannot drive a verdict');
    assert(!isAuditableCompensationSource({ sourceName: 'Leaked session', sourceUrl: 'https://secret-token@example.test/pay' }),
      'credential-bearing URLs must never become auditable compensation evidence');
    const evidence = [
      { comparable: true, min: 100000, max: 120000, sourceName: 'one', sourceUrl: 'https://example.test/one' },
      { comparable: true, min: 95000, max: 125000, sourceName: 'two', sourceUrl: 'https://example.test/two' },
      { comparable: true, min: 80000, max: 110000, sourceName: 'floor', sourceUrl: 'https://example.test/floor' },
      { comparable: true, min: 110000, max: 180000, sourceName: 'ceiling', sourceUrl: 'https://example.test/ceiling' },
      { comparable: true, min: 105000, max: 130000, sourceName: 'five', sourceUrl: 'https://example.test/five' },
      { comparable: true, min: 101000, max: 121000, sourceName: 'six', sourceUrl: 'https://example.test/six' },
    ];
    const displayedEvidence = selectComparableEvidence(evidence, 5);
    assert(displayedEvidence.length === 5 && displayedEvidence.some(item => item.sourceName === 'floor') && displayedEvidence.some(item => item.sourceName === 'ceiling'),
      'the capped card evidence must retain the ranges that set the merged floor and ceiling');
    const currencyCompetition = [
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'wrong floor', sourceUrl: 'https://example.test/us-floor' },
      { comparable: true, min: 2, max: 1000000, currency: 'EUR', sourceName: 'wrong ceiling', sourceUrl: 'https://example.test/eur-ceiling' },
      ...Array.from({ length: 6 }, (_unused, index) => ({
        comparable: true, min: 85000 + index * 1000, max: 105000 + index * 1000, currency: ' cad ',
        sourceName: `cad-${index}`, sourceUrl: `https://example.test/cad-${index}`,
      })),
    ];
    const cadEvidence = selectComparableEvidence(currencyCompetition, 5, 'CAD');
    assert(cadEvidence.length === 5 && cadEvidence.every(item => item.currency.trim().toUpperCase() === 'CAD'),
      'wrong-currency extrema must not consume capped target-currency evidence slots');
    const canonicalDuplicateEvidence = selectComparableEvidence([
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Canonical', sourceUrl: 'https://example.test/pay' },
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Same source spelling', sourceUrl: 'HTTPS://EXAMPLE.TEST/pay' },
    ], 5, 'USD');
    assert(canonicalDuplicateEvidence.length === 1,
      'canonical-equivalent source URLs must not occupy multiple evidence slots');
    assert(compensationAssessment({ offer: canadian, competitiveRanges: [merged] }).status === 'competitive', 'offer maximum reaching floor is competitive');
    assert(compensationAssessment({ offer: { ...canadian, max: 84999 }, competitiveRanges: [merged] }).status === 'below_market', 'no hidden buffer below floor');
    const withEvidence = compensationAssessment({
      offer: canadian,
      competitiveRanges: [merged],
      sourceLinks: [{ title: 'Salary survey', url: 'https://example.test/pay', min: 85000, max: 130000, currency: 'CAD', note: 'Senior role in Toronto.' }],
    });
    assert(withEvidence.sourceLinks[0]?.note === 'Senior role in Toronto.' && withEvidence.justification.includes('reaches or exceeds'), 'auditable source details and deterministic verdict must be retained');
    const unsafeEvidence = compensationAssessment({
      offer: canadian, competitiveRanges: [merged],
      sourceLinks: ['https://secret-token@example.test/pay', 'https://example.test/pay'],
    });
    assert(unsafeEvidence.sourceLinks.length === 1 && unsafeEvidence.sourceLinks[0] === 'https://example.test/pay',
      'credential-bearing compensation links must be removed before assessments are persisted');
    const noOfferNoResearch = compensationAssessment({ offer: parseGuaranteedCashOffer({ salary: '' }), competitiveRanges: [] });
    const noOfferResearchEmpty = compensationAssessment({ offer: parseGuaranteedCashOffer({ salary: '' }), competitiveRanges: [], researchAttempted: true });
    const noOfferResearchEmptyExplicit = compensationAssessment({ offer: parseGuaranteedCashOffer({ salary: '' }), competitiveRanges: [], researchAttempted: true, reasonCode: 'market_evidence_unavailable' });
    assert(noOfferNoResearch.reasonCode === 'no_cash_salary'
      && noOfferResearchEmpty.reasonCode === 'market_range_unavailable' && noOfferResearchEmpty.status === 'not_evaluated'
      && noOfferResearchEmptyExplicit.reasonCode === 'market_evidence_unavailable',
      'a no-offer job whose market research found no range must not be labelled as if nothing was researched; explicit codes still win');
    const missingOfferRecommendation = compensationAssessment({
      offer: parseGuaranteedCashOffer({ salary: '' }),
      competitiveRanges: [merged],
      marketCurrency: 'CAD',
      comparisonLocation: { display: 'Toronto, Ontario, Canada' },
      justification: 'Current comparable base-pay evidence supports this range.',
    });
    assert(missingOfferRecommendation.status === 'market_recommendation'
      && missingOfferRecommendation.offered === null
      && missingOfferRecommendation.competitiveRange.min === 85000
      && missingOfferRecommendation.competitiveRange.currency === 'CAD'
      && missingOfferRecommendation.reasonCode === 'market_range_recommended'
      && missingOfferRecommendation.justification.includes('researched CAD market range')
      && missingOfferRecommendation.justification.includes('no listing comparison was made'),
    'a listing without usable salary must retain researched market evidence as a neutral recommendation without fabricating an offer comparison');
    assert(compensationAssessment({
      offer: parseGuaranteedCashOffer({ salary: '' }),
      competitiveRanges: [{ min: 85_000, max: 110_000, currency: 'CAD' }],
    }).status === 'not_evaluated',
    'market-only ranges without an established target currency must not be unioned into a recommendation');
    assert(compensationMarketCurrency({ display: 'Toronto, Ontario, Canada' }) === 'CAD'
      && compensationMarketCurrency({ display: 'Austin, Texas, United States' }) === 'USD',
    'market-only recommendations infer their target currency from the same resolved compensation location');
    const locationFallbackCurrency = resolveCompensationMarketCurrency(
      { salary: 'Competitive salary' },
      { display: 'Toronto, Ontario, Canada' },
    );
    const explicitListingCurrency = resolveCompensationMarketCurrency(
      { compensation: 'Variable compensation paid in USD' },
      { display: 'Toronto, Ontario, Canada' },
    );
    assert(locationFallbackCurrency.currency === 'CAD' && locationFallbackCurrency.inferredFromLocation
      && explicitListingCurrency.currency === 'USD' && !explicitListingCurrency.inferredFromLocation,
    'an explicit listing currency wins, while absent or ambiguous currency falls back to the job location currency');
    const loc = resolveCompensationLocation({}, { workMode: 'remote', remoteRegion: 'canada' }, { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } });
    assert(loc?.display === 'Toronto, Ontario, Canada', 'remote Canada work uses Canada residence');
    const inferredRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: 'United States' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    );
    assert(inferredRemote?.display === 'Denver, Colorado, United States', 'an explicit permitted country repairs an unknown remote-region classification');
    const worldwideCanadianRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'worldwide' },
      { other: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    );
    assert(worldwideCanadianRemote?.display === 'Toronto, Ontario, Canada',
      'a worldwide outside-region remote role may use a Canadian residence for compensation');
    const originScopedResidence = compensationResidencesForJob(
      { compensationRemoteResidences: { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } } },
      { usa: { city: 'Austin', subdivision: 'Texas', country: 'United States' } },
    );
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'usa' },
      originScopedResidence,
    )?.display === 'Denver, Colorado, United States',
    'a board job uses its transient origin-hub residence before a board-level fallback');
    const conflictingRemoteResidence = normalizeRemoteResidences({
      other: { city: 'Toronto', subdivision: 'Ontario', country: 'United States' },
    });
    assert(conflictingRemoteResidence.other.countryConflict, 'the compensation fixture carries a deterministic residence conflict');
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'worldwide' },
      conflictingRemoteResidence,
    ) === null, 'a selected conflicting residence remains unavailable for salary comparison');
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'Germany' },
      { other: { city: 'London', subdivision: 'England', country: 'United Kingdom' } },
    ) === null, 'an incompatible other-country residence must stay uncertain');
    const contradictoryRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'onsite', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    );
    assert(contradictoryRemote?.display === 'Denver, Colorado, United States'
      && contradictoryRemote.level === 'city',
    'affirmative scraped remote evidence overrides contradictory onsite context and uses the saved residence');
    assert(resolveCompensationLocation(
      { location: 'Toronto, ON (Remote)' },
      { workMode: 'onsite', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.display === 'Denver, Colorado, United States',
    'a compact location with an explicit remote marker uses the residence even when context says onsite');
    assert(resolveCompensationLocation(
      { location: 'Austin, TX', snippet: 'Remote work is not available for this onsite position.' },
      { workMode: 'unknown', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.display === 'Austin, Texas, United States',
    'a prose mention of remote work must not override an onsite listing location when structured work mode is unknown');
    assert(resolveCompensationLocation(
      { location: 'Hybrid' },
      { workMode: 'onsite' },
    ) === null, 'a non-geographic work-mode token must not become a city-level compensation cohort');
    const hybridToronto = resolveCompensationLocation({ location: 'Hybrid - Toronto, ON' }, { workMode: 'hybrid' });
    const onsiteAustin = resolveCompensationLocation({ location: 'On-site: Austin, TX' }, { workMode: 'onsite' });
    assert(hybridToronto?.value === 'Toronto, Ontario, Canada'
      && onsiteAustin?.value === 'Austin, Texas, United States',
    'hybrid/on-site prefixes are removed before canonical city grouping');
    const trailingHybridToronto = resolveCompensationLocation({ location: 'Toronto, ON (Hybrid)' }, { workMode: 'hybrid' });
    const trailingOnsiteAustin = resolveCompensationLocation({ location: 'Austin, TX - On-site' }, { workMode: 'onsite' });
    assert(trailingHybridToronto?.value === 'Toronto, Ontario, Canada'
      && trailingOnsiteAustin?.value === 'Austin, Texas, United States',
    'parenthesized and trailing hybrid/on-site labels cannot fragment a city cohort');
    for (const placeholder of ['Multiple Locations', 'Location Negotiable After Selection', 'TBD', 'Not specified']) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' }) === null,
        `${placeholder} is not a compensation market`);
    }
    assert(resolveCompensationLocation({ location: 'Anywhere in Canada' }, { workMode: 'onsite' })?.value === 'Canada',
      'an explicit anywhere-in-country listing safely uses the country cohort');
    assert(resolveCompensationLocation({ location: 'Anywhere in Atlantis' }, { workMode: 'onsite' }) === null,
      'an unrecognized anywhere-in-country phrase cannot become a fictional city cohort');
    for (const [placeholder, country] of [
      ['Nationwide, Canada', 'Canada'],
      ['Multiple Locations, United States', 'United States'],
      ['Various Locations - Canada', 'Canada'],
    ]) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' })?.value === country,
        `${placeholder} retains its explicit country boundary without inventing a city`);
    }
    for (const placeholder of ['Multiple Locations', 'Various Locations - Atlantis', 'Nationwide, El Dorado']) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' }) === null,
        `${placeholder} cannot become a fake country or city cohort`);
    }
    assert(resolveCompensationLocation(
      { location: 'Remote - Canada' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    )?.value === 'Toronto, Ontario, Canada',
    'an explicit raw remote-country marker repairs an otherwise unknown remote restriction');
    assert(resolveCompensationLocation(
      { location: 'Remote, U.S.' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.value === 'Denver, Colorado, United States',
    'U.S. aliases in raw remote locations select the U.S. residence');
    assert(resolveCompensationLocation(
      { location: 'Remote' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    ) === null,
    'a bare Remote listing stays unavailable without a structured or raw country restriction');
    assert(resolveCompensationLocation(
      { location: 'Remote - Canada' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'UK' },
      { other: { city: 'London', subdivision: 'England', country: 'United Kingdom' } },
    )?.country === 'United Kingdom',
    'structured UK restrictions override contradictory raw location hints and normalize country aliases');
    const cohortCommon = { job: { title: 'Senior Designer' }, location: loc, offer: canadian, context: { seniority: 'senior' } };
    const roleBands = [
      { label: 'Entry (0–2 years)', minYears: 0, maxYears: 2 },
      { label: 'Mid-level (3–6 years)', minYears: 3, maxYears: 6 },
      { label: 'Senior (7–11 years)', minYears: 7, maxYears: 11 },
      { label: 'Lead+ (12+ years)', minYears: 12, maxYears: 99 },
    ];
    const fiveYearHeadline = selectCompensationExperienceYears({ categorySpecificExperience: [{ requiredMinimumYears: 5 }] });
    const sixYearHeadline = selectCompensationExperienceYears({ categorySpecificExperience: [{ requiredMinimumYears: 6 }] });
    const fiveYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, fiveYearHeadline.years) });
    const sixYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, sixYearHeadline.years) });
    const sevenYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, 7) });
    assert(fiveYearHeadline.years === 5 && sixYearHeadline.years === 6
      && fiveYearKey === sixYearKey && fiveYearKey !== sevenYearKey,
      'jobs at 5y and 6y in one researched band share a cohort, while a different band does not');
    const fullLadder = [
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Mid', minYears: 3, maxYears: 6 },
      { label: 'Senior+', minYears: 7, maxYears: 99 },
    ];
    assert(isValidCompensationExperienceBandLadder(fullLadder), 'a 0–99 ordered contiguous ladder is cacheable');
    assert(!isValidCompensationExperienceBandLadder([
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Senior+', minYears: 4, maxYears: 99 },
    ]), 'a gap invalidates a persisted role-family ladder rather than assigning a nearest band');
    assert(!isValidCompensationExperienceBandLadder([
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Mid', minYears: 3, maxYears: 6 },
    ]), 'a ladder that does not reach the open-ended 99 bucket is invalid');
    assert(selectCompensationExperienceBand(fullLadder, 100) === null
      && selectCompensationExperienceBand(fullLadder, 2.5) === null,
    'out-of-range and uncontained fractional experience returns no band instead of a nearest one');
    const reportedOnly = selectCompensationExperienceYears({ categorySpecificExperience: [
      { requiredMinimumYears: null, reportedYears: '3 years' },
      { requiredMinimumYears: null, reportedYears: '4–6.5 years' },
    ] });
    assert(reportedOnly.years === 6.5 && reportedOnly.basis === 'candidate-reported-material-category',
      'when no category states a minimum, the highest material reported years is used');
    const statedWins = selectCompensationExperienceYears({ categorySpecificExperience: [
      { requiredMinimumYears: 2, reportedYears: '12' },
      { requiredMinimumYears: 5, reportedYears: '3' },
    ] });
    assert(statedWins.years === 5 && statedWins.basis === 'job-stated-minimum',
      'the highest job-stated category minimum wins over reported and total tenure');
    const city = canonicalizeCompensationLocation({ display: 'Denver, Colorado, United States' });
    const state = canonicalizeCompensationLocation({ display: 'Colorado, United States' });
    const country = canonicalizeCompensationLocation({ display: 'Canada' });
    assert(city?.level === 'city' && city.value === 'Denver, Colorado, United States'
      && state?.level === 'state' && state.value === 'Colorado, United States'
      && country?.level === 'country' && country.value === 'Canada',
    'location cohorts use deterministic city → state → country canonical ladder');
    const torontoForms = [
      canonicalizeCompensationLocation({ display: 'Toronto, ON' }),
      canonicalizeCompensationLocation({ display: 'Toronto, ON M5V 1K4' }),
      canonicalizeCompensationLocation({ display: 'Toronto, Ontario, Canada' }),
    ];
    assert(torontoForms.every(place => place?.level === 'city' && place.value === 'Toronto, Ontario, Canada'),
      'trailing Canadian postal codes cannot split an otherwise identical city cohort');
    const austinForms = [
      canonicalizeCompensationLocation({ display: 'Austin, TX' }),
      canonicalizeCompensationLocation({ display: 'Austin, TX 78701-1234' }),
      canonicalizeCompensationLocation({ display: 'Austin, Texas, United States' }),
    ];
    assert(austinForms.every(place => place?.level === 'city' && place.value === 'Austin, Texas, United States'),
      'trailing US ZIP and ZIP+4 forms cannot split an otherwise identical city cohort');
    return { unionFloor: merged.min };
  },
}, {
  name: 'Competitive-salary report labels the fit gate separately from nested pre-research skips',
  run: () => {
    const snapshotSource = readFileSync(new URL('../../electron/ipc/bugReport/jobsSnapshot.js', import.meta.url), 'utf8');
    assert(snapshotSource.includes('Scored input: ${rec(c.scoredInput)} job(s) = ${rec(c.skippedBelowFit)} below the fit threshold + ${rec(c.eligible)} fit-qualified at or above ${rec(c.minFitScore)}'),
      'the report must reconcile its input into the below-threshold and fit-qualified partitions, rather than imply eligible is a final research candidate count');
    assert(snapshotSource.includes('Of the fit-qualified jobs, skipped before market research: ${rec(c.skippedNoLocation)} with no resolvable location, ${rec(c.skippedNoCurrency)} with no resolvable market currency')
      && snapshotSource.includes('${rec(c.preResearchCandidates)} passed to experience-band/cohort preparation'),
    'location/currency skips must be labeled as nested pre-research filters, so they are not added to the below-threshold count');
    const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    assert(/scoredInput:\s*total,[\s\S]*?eligible,[\s\S]*?preResearchCandidates:\s*candidates\.length,/.test(jobsSource),
      'compensation telemetry must retain the reconciled input and post-salary/location candidate counts');
    return { stagedFunnel: true };
  },
}, {
  // Contracts A + C: the compensation-research fit gate. The gate's boundary
  // check itself (rawScore >= COMPENSATION_MIN_FIT_SCORE, and the unscored-vs-
  // known-low-score branch) lives inline in the non-exported async
  // researchCompensationAssessments (electron/ipc/jobs.js ~1939-1963) — it is
  // not exposed as an importable pure function, so it cannot be exercised
  // directly here (see the accompanying risk note). This test instead pins the
  // two things that ARE exported and load-bearing: the threshold constant
  // itself, and — via compensationAssessment(), the same helper jobs.js calls
  // to build the skip's fallback card — that a below-threshold skip and an
  // unscored skip retain distinct reason codes as well as distinct prose.
  name: 'Compensation fit gate: threshold constant and distinct skip shapes',
  run: () => {
    const justBelowThreshold = COMPENSATION_MIN_FIT_SCORE - 1;
    assert(COMPENSATION_MIN_FIT_SCORE === 70, `COMPENSATION_MIN_FIT_SCORE must be 70 per the shared contract, got ${COMPENSATION_MIN_FIT_SCORE}`);

    // Mirrors jobs.js's compensationFallback(job, 'below_fit_threshold', ...)
    // for a job that DOES have a real, parseable salary but scored below the
    // gate — offer.usable is true, so `offered` on the card is the real offer,
    // never null, and no market range was ever requested for it.
    const knownLowOffer = parseGuaranteedCashOffer({ salary: '$90,000 per year', location: 'Austin, Texas, USA' });
    assert(knownLowOffer.usable, 'fixture salary must itself be a usable stated cash offer');
    const knownLowScoreSkip = compensationAssessment({
      offer: knownLowOffer,
      reasonCode: 'below_fit_threshold',
      justification: `The competitive-pay check is reserved for stronger matches (fit score ${COMPENSATION_MIN_FIT_SCORE} or above); this job scored ${justBelowThreshold}.`,
    });
    assert(knownLowScoreSkip.reasonCode === 'below_fit_threshold' && knownLowScoreSkip.offered?.max === 90000,
      'a known below-threshold score must be skipped with reasonCode below_fit_threshold while still carrying the real parsed offer');
    assert(knownLowScoreSkip.justification.includes(String(justBelowThreshold)),
      'a known below-threshold score justification must name the actual score so it reads as a real assessment, not a missing one');

    // Mirrors the sibling branch for a job whose score is unknown/null
    // (unscored, or the UNSCORED_FALLBACK_SCORE sentinel) — a distinct
    // reasonCode and justification must say the score was unavailable rather
    // than imply a real low score was measured.
    const unknownScoreSkip = compensationAssessment({
      offer: knownLowOffer,
      reasonCode: 'fit_score_unavailable',
      justification: `The competitive-pay check is reserved for stronger matches (fit score ${COMPENSATION_MIN_FIT_SCORE} or above); this job's fit score was unavailable, so no comparison was made.`,
    });
    assert(unknownScoreSkip.reasonCode === 'fit_score_unavailable', 'an unscored job must retain its own fit_score_unavailable reason code');
    assert(unknownScoreSkip.justification.includes('unavailable') && !unknownScoreSkip.justification.includes('scored'),
      'an unscored skip must read as "score unavailable", not be confused with a known below-threshold score');
    assert(knownLowScoreSkip.justification !== unknownScoreSkip.justification,
      'a known-low-score skip and an unscored skip must never render identical text on the card — that would erase the only signal that distinguishes them');

    // Pin this fallback-shape test to the same importable gate used by the
    // pipeline instead of restating the configured numeric boundary here.
    assert(classifyCompensationFitEligibility(COMPENSATION_MIN_FIT_SCORE, {
      minScore: COMPENSATION_MIN_FIT_SCORE,
    }) === 'eligible'
      && classifyCompensationFitEligibility(justBelowThreshold, {
        minScore: COMPENSATION_MIN_FIT_SCORE,
      }) === 'below-threshold',
    'the fit gate must be boundary-inclusive at the shared threshold and reject one point below it');

    return { minFitScore: COMPENSATION_MIN_FIT_SCORE };
  },
}];
