import { waitForJobRendererCommit } from '../../src/utils/jobRendererCommit.js';
import { dedupJobsAcrossSources } from '../../src/utils/jobIdentity.js';
import { hasLegacyPageScoring, JOB_SCORING_CONTRACT } from '../../src/utils/jobScoringContract.js';
import { jobBoardHasSavedAiContinuation } from '../../src/utils/jobBoardSavedAiContinuation.js';
import assert from 'node:assert';

import {
  SAVED_JOBS_RESCORE_VERSION,
  buildJobHubCareerOnlyClearPatch,
  buildJobHubScrapeClearPatch,
  buildSavedJobsRescoreMarker,
  hubRetainsSavedJobs,
  isCareerClearedWithSavedJobs,
  jobHubClearAvailability,
  pendingSavedJobsRescore,
  savedJobCount,
  savedJobsRescoreCompletionPatch,
} from '../../src/utils/jobSearchSplitClear.js';
import {
  classifyJobBoardSourceAdmission,
  partitionJobBoardSourceAdmissions,
} from '../../src/utils/jobBoardSourceAdmission.js';
import {
  JOBHUB_CAREER_IDENTITY_FIELDS,
  getHubDropLockReason,
  hubHasAcceptedInitialDrop,
} from '../../src/utils/hubDropEligibility.js';
import { prepareBackgroundBoardChildRequest } from '../../src/utils/jobBoardBackgroundRecovery.js';
import { buildJobCareerQueryCacheKey } from '../../src/utils/jobCareerSnapshotBinding.js';
import { jobSearchNextAnchor } from '../../src/utils/jobSearchDateWindow.js';
import { jobBoardSelectionPresentation } from '../../src/utils/jobBoardSearchSelection.js';
import { approveCareerImportCompilation, beginCareerImportCompilation } from '../../src/utils/jobCareerCompilationReceipt.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobAnalysisInputDigest } from '../../src/utils/jobAnalysisInputDigest.js';
import { createJobAnalysisOperationLedger, jobAnalysisOperationMatches } from '../../src/utils/jobAnalysisOperationLedger.js';
import { claimJobAnalysisOperationAuthority, clearJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

// Slice one top-level hook/function body: from its declaration to the next
// line that starts a sibling `const … = useCallback` (or the given end marker).
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `missing ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const SNAPSHOT = 'a'.repeat(64);
const OTHER_SNAPSHOT = 'c'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

const JOBS = [
  { title: 'Product Manager', company: 'Example', url: 'https://jobs.example.test/pm', matchScore: 88 },
  { title: 'Designer', company: 'Example', url: 'https://jobs.example.test/design', matchScore: 70 },
];

function capabilityFor(nodeId, suffix = '11111111-1111-4111-8111-111111111111') {
  return `career-import:${nodeId}:${suffix}`;
}

function approvedReceipt(generation, careerSnapshotId = SNAPSHOT) {
  return { version: 1, generation, attemptId: 'attempt-1', status: 'approved', careerSnapshotId };
}

// A done hub that kept its career files and saved jobs (an ordinary terminal Search).
function terminalHub(id = 'hub-1', extra = {}) {
  return {
    id,
    type: 'jobhub',
    data: {
      hubState: 'done',
      jobRunId: 'terminal-run',
      resultDisposition: 'scored',
      scoredJobs: JOBS,
      inputLocked: true,
      ...extra,
    },
  };
}

// A done hub whose career data was cleared and re-imported, awaiting a re-score.
function rescoreHub(id = 'hub-1', { dataExtra = {}, marker } = {}) {
  const generation = capabilityFor(id);
  return terminalHub(id, {
    careerSnapshotId: SNAPSHOT,
    careerImportGeneration: generation,
    careerImportFreshCapability: generation,
    careerImportConsumption: null,
    careerImportCompilation: approvedReceipt(generation),
    savedJobsRescore: marker === undefined
      ? buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation, now: 5 })
      : marker,
    ...dataExtra,
  });
}

function applyPatch(data, patch) {
  return { ...data, ...patch };
}

const RESULT_RESET_KEYS = [
  'hubState', 'scoredJobs', 'finalSourceCounts', 'resultCount', 'totalScoredCount', 'scrapedCount',
  'gatheredCount', 'scoreThreshold', 'jobRunId', 'jobCount', 'scoreRangeMin', 'scoreRangeMax',
  'aiSkipped', 'collectionOnly', 'testMode', 'resultDisposition', 'searchWindow', 'pendingJobs',
  'pendingTargetRole', 'scrapeWarnings', 'collectionScopeCaveats', 'preferenceMatchedCount',
  'preferenceFilteredCount', 'preferenceEvaluation', 'preferenceCandidatePool',
  'preferenceCareerSnapshotId', 'scoringCareerSnapshotId', 'savedJobsRescore', 'errorMessage',
  'rerunOutcome', 'rerunNotice', 'reanalysisNotice', 'testModeNote', 'queuedModuleRun',
  'analysisOperation', 'retryOperation', 'retryOperationFor', 'pendingCollectionCompletion',
  'partialCollectionRunId', 'terminalFinalizationRecovery', 'manualAiResume', 'dragHover',
  'savedJobsCareerClearedAt',
  'jobAnalysisClearedAt', 'jobAnalysisClearedRunId',
];

export default [
  { name: 'Board offers explicit saved AI continuation only for its connected exact re-score owner', run: async () => {
    const node = { id: 'hub', type: 'jobhub', data: { manualAiResume: { runId: 'manual', recoveryMode: 'reanalyze-saved-jobs', orchestratorNodeId: 'board', boardRunId: 'run' } } };
    const plan = { phase: 'searches', boardRunId: 'run', activeSourceIds: ['hub'], activeSourceManualAiRunIds: { hub: 'manual' } };
    const args = { plan, boardNodeId: 'board', node, connected: true };
    assert.equal(jobBoardHasSavedAiContinuation(args), true);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, connected: false }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, boardNodeId: 'other' }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, plan: { ...plan, boardRunId: 'other' } }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, plan: { ...plan, phase: 'combine' } }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, plan: { ...plan, activeSourceIds: [] } }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, plan: { ...plan, activeSourceManualAiRunIds: { hub: 'newer' } } }), false);
    assert.equal(jobBoardHasSavedAiContinuation({ ...args, node: { ...node, data: { manualAiResume: { ...node.data.manualAiResume, retirementPending: true } } } }), false);
  } },

  {
    name: 'Search outcomes preserve explicit AI continuation and compilation wait reasons',
    run: async () => {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('function searchRunOutcome(');
      const end = search.indexOf('\n// A hub-scoped manifest', start);
      const outcome = new Function(search.slice(start, end) + '; return searchRunOutcome;')();
      assert.strictEqual(outcome('paused', { reason: 'awaiting-explicit-ai-continue' }).reason, 'awaiting-explicit-ai-continue');
      assert.strictEqual(outcome('deferred', { reason: 'career-compiling' }).reason, 'career-compiling');
      assert.strictEqual(outcome('failed', { error: 'failure' }).error, 'failure');
      assert.strictEqual('reason' in outcome('completed'), false);
    },
  },
  {
    name: 'Analysis admission waits for exact renderer publication and fails closed on missing, revoked, replaced, or deleted owners',
    run: async () => {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const marker = 'const claimAnalysisOperation = useCallback(';
      const start = search.indexOf(marker) + marker.length;
      const body = search.slice(start, search.indexOf('\n  }, [', start) + '\n  }'.length);
      for (const scenario of [0, 2, 8, 9, Infinity, 'revoked', 'replaced', 'deleted']) {
        const ledger = createJobAnalysisOperationLedger();
        let node = { data: { careerSnapshotId: SNAPSHOT } };
        let publish; let frames = 0;
        const env = {
          id: 'hub', canvasFilePath: '/fixture/canvas.json',
          analysisOperationLedgerRef: { current: ledger },
          analysisOperationClaimTailRef: { current: Promise.resolve() },
          resumeOperationAuthorityRef: { current: null },
          normalizedJobCareerSnapshotId: value => value,
          getNode: () => node, jobAnalysisOperationMatches,
          updateGlobal: (_id, patch) => {
            publish = () => { if (node) node.data = { ...node.data, ...patch() }; };
            if (scenario === 0) publish();
          },
          waitForRendererCommitFrame: async () => {
            frames++;
            if (scenario === 'revoked') { ledger.revoke(); publish(); }
            if (scenario === 'deleted') node = null;
            if (scenario === 'replaced') {
              const newer = ledger.claim({ hubId: 'hub', disposition: 'search' });
              node.data.analysisOperation = ledger.receiptFor(newer);
              publish();
            }
            if (typeof scenario === 'number' && frames >= scenario) publish();
          },
          EventLogger: { log() {} },
          window: { electronAPI: { claimJobAnalysisOperation: async () => ({ admitted: true, receipt: { revision: 1 } }) } },
        };
        const claim = new Function(...Object.keys(env), `return (${body});`)(...Object.values(env));
        const result = await claim('search');
        if (typeof scenario === 'number' && scenario <= 8) {
          assert(result, `receipt should become observable after ${scenario} frames`);
          assert(jobAnalysisOperationMatches(node.data, result));
        } else {
          assert.strictEqual(result, null, `must fail closed for ${scenario}`);
        }
        assert(frames <= 8, 'receipt visibility wait must be bounded');
      }
    },
  },
  {
    name: 'Board saved-job re-score crosses real host admission after career clear for empty and populated results without advancing scan history',
    run: async () => {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const callback = (name) => {
        const start = search.indexOf(`const ${name} = useCallback(`) + `const ${name} = useCallback(`.length;
        return search.slice(start, search.indexOf('\n  }, [', start) + '\n  }'.length);
      };
      for (const existingRunId of [null, 'original-scrape']) {
        for (const mode of ['filtered', 'scored', 'scoring-repair', 'scoring-repair-failed']) {
          const filtered = mode === 'filtered';
          const scoringRepair = mode.startsWith('scoring-repair');
          const incompleteRepair = mode === 'scoring-repair-failed';
          const hub = rescoreHub('legacy', { dataExtra: {
            jobRunId: existingRunId,
            resumeProfile: { name: 'Replacement' },
            lastCompletedRunAt: 1_790_500_000_000,
            lastSearchCoverageStartedAt: 1_790_400_000_000,
          } });
          if (scoringRepair) {
            hub.data.savedJobsRescore = null;
            hub.data.scoredJobs = JOBS.map(job => ({ ...job, careerSnapshotId: SNAPSHOT,
              fitAssessment: { confidence: { reported: 'unknown' }, requirementRows: Array(6).fill({}) },
            }));
            hub.data.preferenceCandidatePool = [...JOBS, { title: 'Previously excluded job', url: 'https://jobs.example.test/excluded' }];
            hub.data.searchBriefPlan = { titles: ['Product Manager'] };
          }
          let preferenceCalls = 0;
          const history = jobSearchNextAnchor(hub.data, hub.id);
          const manualAiRunId = 'job-search:legacy:score-only';
          const expectedRunId = existingRunId || manualAiRunId;
          let savedSnapshot;
          let claimedRunId;
          const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rescore-admission-'));
          const canvasFilePath = path.join(directory, 'canvas.json');
          fs.writeFileSync(canvasFilePath, '{}');
          try {
            // Career-only clear leaves a tombstone. A fresh score pass must be
            // admitted without borrowing the revoked career's lineage.
            await clearJobAnalysisOperationAuthority({ canvasFilePath, hubId: hub.id });
            const ref = (current = null) => ({ current });
            let pendingAuthorityPatch;
            let pendingAuthorityFrames = 2;
            let pendingNodeUpdates = [];
            const ledger = createJobAnalysisOperationLedger();
            const bindings = {
              id: hub.id, data: hub.data, getNode: () => hub,
              getNodes: () => [hub], getEdges: () => [],
              updateGlobal: (_id, update) => {
                // Mirror React batching for EVERY functional update, not just
                // the authority receipt. A synchronous mock hid false
                // supersession at the preference/scoring/terminal commits.
                pendingNodeUpdates.push(update);
              },
              safeClone: structuredClone, addToast() {}, hasLegacyPageScoring, dedupJobsAcrossSources,
              searchRunOutcome: (status, fields = {}) => ({ status, ...fields }),
              isJobWorkflowDeletionPending: () => false,
              isSavedJobReanalysisManualAiResume: () => false,
              hasPendingManualAiRetirement: () => false,
              staleOrdinaryManualAiResumeBlocksAdmission: () => false,
              reanalysisInputFingerprint: new Function(search.slice(search.indexOf('function reanalysisInputFingerprint('), search.indexOf('\n// --- Title derivation')) + '; return reanalysisInputFingerprint;')(),
              jobAnalysisInputDigest,
              reanalysisRestorePatch: () => ({}),
              createManualAiRunId: () => manualAiRunId,
              REANALYZE_SAVED_JOBS_MANUAL_AI_RECOVERY_MODE: 'reanalyze-saved-jobs',
              processingRunsRef: ref({ start: () => 'processing-token', finish() {} }),
              localQueueAdmissionRef: ref(), epoch: { start: () => () => false },
              canCommitAnalysisOperation: capability => ledger.canCommit(capability) && jobAnalysisOperationMatches(hub.data, capability),
              jobAnalysisOperationMatches,
              waitForJobRendererCommit,
              waitForRendererCommitFrame: async () => {
                const updates = pendingNodeUpdates;
                pendingNodeUpdates = [];
                for (const update of updates) {
                  const patch = typeof update === 'function' ? update(hub) : update;
                  if (patch?.analysisOperation) pendingAuthorityPatch = patch;
                  else if (patch) hub.data = { ...hub.data, ...patch };
                }
                if (pendingAuthorityPatch && --pendingAuthorityFrames <= 0) {
                  hub.data = { ...hub.data, ...pendingAuthorityPatch };
                  pendingAuthorityPatch = null;
                }
              },
              analysisOperationLedgerRef: ref(ledger),
              analysisOperationClaimTailRef: ref(Promise.resolve()),
              resumeOperationAuthorityRef: ref(),
              reanalysisRestoreRef: ref(), activeManualAiRunIdRef: ref(),
              isMountedRef: ref(true), canvasFilePath,
              getSearchLocation: () => ({}), normalizeRemoteResidences: () => ({}),
              normalizedJobCareerSnapshotId: value => value || null,
              careerSnapshotBindingMatches: (data, snapshot) => data.careerSnapshotId === snapshot,
              evaluatePreferencesForRun: async () => {
                preferenceCalls++;
                return {
                  jobs: filtered ? [] : JOBS, candidatePool: JOBS,
                  matchedCount: filtered ? 0 : JOBS.length,
                  filteredCount: filtered ? JOBS.length : 0,
                };
              },
              operationAuthorityFor: () => ({}), buildResumeSummary: () => '',
              collectionScopeCaveatsForSavedJobReanalysis: () => [],
              completeManualAiRun: async () => true,
              savedJobsRescoreCompletionPatch,
              setScoringProgress() {},
              stampJobsWithCareerSnapshot: (jobs, careerSnapshotId) => jobs.map(job => ({ ...job, careerSnapshotId })),
              normalizeCollectionScopeCaveats: value => value,
              terminalFinalizationError: () => null,
              completeJobRun: () => { throw new Error('A re-score must not complete a provider run'); },
              EventLogger: { log() {}, error() {} }, isNodeDeletedAbort: () => false,
              window: { electronAPI: {
                claimJobAnalysisOperation: async request => {
                  claimedRunId = request.semanticBase.runId;
                  assert.match(request.semanticBase.fingerprint, /^[a-f0-9]{64}$/);
                  assert.strictEqual(request.semanticBase.kind, 'saved-jobs-reanalysis');
                  assert.strictEqual(request.semanticBase.sourceArtifactFingerprint, request.semanticBase.fingerprint);
                  return claimJobAnalysisOperationAuthority(request);
                },
                saveJobAnalysisSnapshot: async request => { savedSnapshot = request.snapshotContext; return { saved: true }; },
                scoreJobs: async request => {
                  savedSnapshot = request.snapshotContext;
                  if (scoringRepair) {
                    assert.strictEqual(request.jobs.length, JOBS.length);
                    assert.strictEqual(request.preferenceCandidatePool.length, JOBS.length + 1);
                    assert.deepStrictEqual(request.jobPreferencePlan, hub.data.searchBriefPlan);
                  }
                  return { success: true, scoringComplete: !incompleteRepair, scoredJobs: JOBS.map(job => ({ ...job, scoringEvidenceReceipt: { contract: JOB_SCORING_CONTRACT } })) };
                },
              } },
            };
            const instantiate = (body) => new Function(...Object.keys(bindings), `return (${body});`)(...Object.values(bindings));
            bindings.claimAnalysisOperation = instantiate(callback('claimAnalysisOperation'));
            bindings.finishScoringAndSpawn = instantiate(callback('finishScoringAndSpawn'));
            Object.assign(bindings, {
              classifyJobBoardSourceAdmission,
              findJobSearchBoardActiveRecoveryOwner: () => null,
              isExactPausedBoardScoringContinuation: () => false,
              isSavedScrapeManualAiResume: () => false,
              boardRunReadiness: () => null,
              platformsVerifyingRef: ref(false), boardRunControlRef: ref(),
              captureJobSourceGraph: () => ({ nodes: [], edges: [] }),
              isJobBoardUserCancellation: () => false,
              waitForCommittedSearchOutcome: async ({ outcome }) => outcome,
            });
            bindings.handleReanalyzeRef = ref(instantiate(callback('handleReanalyze')));
            const outcome = await instantiate(callback('runForJobBoard'))({
              orchestratorNodeId: 'board', boardRunId: 'board-run', isCancelled: () => false,
            });
            if (incompleteRepair) {
              assert.strictEqual(outcome.status, 'failed');
              assert.strictEqual(hub.data.hubState, 'done');
              assert.strictEqual(hasLegacyPageScoring(hub.data), true);
              assert.strictEqual(hub.data.preferenceCandidatePool.length, JOBS.length + 1);
              assert.deepStrictEqual(jobSearchNextAnchor(hub.data, hub.id), history);
              continue;
            }
            assert.strictEqual(outcome.status, 'completed');
            assert.strictEqual(outcome.runId, expectedRunId);
            assert.strictEqual(claimedRunId, expectedRunId);
            assert.strictEqual(savedSnapshot.runId, expectedRunId);
            assert.strictEqual(classifyJobBoardSourceAdmission(hub).kind, 'reuse-terminal');
            assert.strictEqual(hub.data.savedJobsRescore, null);
            assert.strictEqual(preferenceCalls, scoringRepair ? 0 : 1);
            if (scoringRepair) {
              assert.strictEqual(hub.data.preferenceCandidatePool.length, JOBS.length + 1);
              assert.strictEqual(hasLegacyPageScoring(hub.data), false);
            }
            assert.deepStrictEqual(jobSearchNextAnchor(hub.data, hub.id), history);
          } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        }
      }
    },
  },
  {
    name: 'savedJobCount / hubRetainsSavedJobs count only truthy entries of an array scoredJobs',
    run: async () => {
      assert.strictEqual(SAVED_JOBS_RESCORE_VERSION, 1);
      assert.strictEqual(savedJobCount({ scoredJobs: JOBS }), 2);
      assert.strictEqual(savedJobCount({ scoredJobs: [null, JOBS[0], undefined] }), 1);
      assert.strictEqual(savedJobCount({ scoredJobs: [] }), 0);
      assert.strictEqual(savedJobCount({ scoredJobs: [null] }), 0);
      assert.strictEqual(savedJobCount({ scoredJobs: { length: 3 } }), 0);
      assert.strictEqual(savedJobCount({}), 0);
      assert.strictEqual(savedJobCount(null), 0);
      assert.strictEqual(hubRetainsSavedJobs({ scoredJobs: JOBS }), true);
      assert.strictEqual(hubRetainsSavedJobs({ scoredJobs: [] }), false);
      assert.strictEqual(hubRetainsSavedJobs(undefined), false);
    },
  },
  {
    name: 'isCareerClearedWithSavedJobs is true only for a done jobhub with jobs and no accepted drop',
    run: async () => {
      const cleared = { type: 'jobhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1 } };
      assert.strictEqual(isCareerClearedWithSavedJobs(cleared), true);
      assert.strictEqual(isCareerClearedWithSavedJobs({ ...cleared, type: 'sellhub' }), false);
      assert.strictEqual(isCareerClearedWithSavedJobs({ ...cleared, data: { ...cleared.data, hubState: 'empty' } }), false);
      assert.strictEqual(isCareerClearedWithSavedJobs({ ...cleared, data: { ...cleared.data, scoredJobs: [] } }), false);
      assert.strictEqual(isCareerClearedWithSavedJobs({ ...cleared, data: { ...cleared.data, inputLocked: true } }), false);
      // Without the explicit Clear Career Data stamp, an identity-less legacy
      // result is not "awaiting files" — it keeps combining as before.
      assert.strictEqual(isCareerClearedWithSavedJobs({ ...cleared, data: { ...cleared.data, savedJobsCareerClearedAt: null } }), false);
      for (const field of JOBHUB_CAREER_IDENTITY_FIELDS) {
        const value = field.endsWith('s') && field !== 'careerData' ? ['/tmp/x.pdf'] : 'x';
        assert.strictEqual(
          isCareerClearedWithSavedJobs({ ...cleared, data: { ...cleared.data, [field]: value } }),
          false,
          `identity field ${field} must mean career is not cleared`,
        );
      }
      assert.strictEqual(isCareerClearedWithSavedJobs(null), false);
    },
  },
  {
    name: 'jobHubClearAvailability reports each clear independently',
    run: async () => {
      assert.deepStrictEqual(jobHubClearAvailability(terminalHub()), {
        savedJobCount: 2, careerClearedWithJobs: false, canClearScrape: true, canClearCareer: true,
      });
      assert.deepStrictEqual(
        jobHubClearAvailability({ type: 'jobhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1 } }),
        { savedJobCount: 2, careerClearedWithJobs: true, canClearScrape: true, canClearCareer: false },
      );
      assert.deepStrictEqual(
        jobHubClearAvailability({ type: 'jobhub', data: { hubState: 'empty', inputLocked: true } }),
        { savedJobCount: 0, careerClearedWithJobs: false, canClearScrape: false, canClearCareer: true },
      );
      assert.deepStrictEqual(
        jobHubClearAvailability({ type: 'jobhub', data: { hubState: 'scoring', scoredJobs: JOBS, careerSnapshotId: SNAPSHOT } }),
        { savedJobCount: 2, careerClearedWithJobs: false, canClearScrape: false, canClearCareer: true },
      );
      assert.deepStrictEqual(jobHubClearAvailability(null), {
        savedJobCount: 0, careerClearedWithJobs: false, canClearScrape: false, canClearCareer: false,
      });
    },
  },
  {
    name: 'buildSavedJobsRescoreMarker requires a 64-hex snapshot and a non-empty generation and trims them',
    run: async () => {
      const generation = capabilityFor('hub-1');
      assert.deepStrictEqual(
        buildSavedJobsRescoreMarker({ careerSnapshotId: ` ${SNAPSHOT} `, generation: `  ${generation} `, now: 42 }),
        { version: 1, careerSnapshotId: SNAPSHOT, generation, requestedAt: 42 },
      );
      const stamped = buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation });
      assert.strictEqual(typeof stamped.requestedAt, 'number');
      assert.strictEqual(buildSavedJobsRescoreMarker({ careerSnapshotId: 'a'.repeat(63), generation }), null);
      assert.strictEqual(buildSavedJobsRescoreMarker({ careerSnapshotId: 'A'.repeat(64), generation }), null);
      assert.strictEqual(buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation: '   ' }), null);
      assert.strictEqual(buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT }), null);
      assert.strictEqual(buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation: 7 }), null);
      assert.strictEqual(buildSavedJobsRescoreMarker(), null);
    },
  },
  {
    name: 'pendingSavedJobsRescore returns the marker only while every binding still holds',
    run: async () => {
      const hub = rescoreHub();
      assert.strictEqual(pendingSavedJobsRescore(hub.data), hub.data.savedJobsRescore);
      assert.strictEqual(pendingSavedJobsRescore(hub.data).careerSnapshotId, SNAPSHOT);

      const negatives = [
        ['wrong version', { savedJobsRescore: { ...hub.data.savedJobsRescore, version: 2 } }],
        ['no marker', { savedJobsRescore: null }],
        ['hub not done', { hubState: 'empty' }],
        ['no saved jobs', { scoredJobs: [] }],
        ['generation drifted', { careerImportGeneration: capabilityFor('hub-1', '22222222-2222-4222-8222-222222222222') }],
        ['no receipt', { careerImportCompilation: null }],
        ['receipt compiling', { careerImportCompilation: { ...hub.data.careerImportCompilation, status: 'compiling' } }],
        ['receipt snapshot differs from marker', { careerImportCompilation: approvedReceipt(hub.data.careerImportGeneration, OTHER_SNAPSHOT), careerSnapshotId: OTHER_SNAPSHOT }],
        ['hub snapshot differs from receipt', { careerSnapshotId: OTHER_SNAPSHOT }],
      ];
      for (const [label, patch] of negatives) {
        assert.strictEqual(pendingSavedJobsRescore(applyPatch(hub.data, patch)), null, label);
      }
      assert.strictEqual(pendingSavedJobsRescore(null), null);
    },
  },
  {
    name: 'savedJobsRescoreCompletionPatch clears the marker and spends the fresh capability for the exact snapshot only',
    run: async () => {
      const hub = rescoreHub();
      const generation = hub.data.careerImportGeneration;
      const patch = savedJobsRescoreCompletionPatch(hub.data, SNAPSHOT, { nodeId: 'hub-1' });
      assert.strictEqual(patch.savedJobsRescore, null);
      assert.strictEqual(patch.careerImportFreshCapability, null);
      assert.strictEqual(patch.careerImportConsumption.capability, generation);
      assert.strictEqual(patch.careerImportConsumption.generation, generation);
      assert.strictEqual(patch.careerImportConsumption.origin, 'saved-jobs-rescore');

      // Capability owned by another node, or no node named: marker cleared, nothing spent.
      assert.deepStrictEqual(
        savedJobsRescoreCompletionPatch(hub.data, SNAPSHOT, { nodeId: 'other-hub' }),
        { savedJobsRescore: null },
      );
      assert.deepStrictEqual(savedJobsRescoreCompletionPatch(hub.data, SNAPSHOT), { savedJobsRescore: null });
      // An already spent capability is not spent again.
      const spent = applyPatch(hub.data, { careerImportFreshCapability: null, careerImportConsumption: { capability: generation } });
      assert.deepStrictEqual(savedJobsRescoreCompletionPatch(spent, SNAPSHOT, { nodeId: 'hub-1' }), { savedJobsRescore: null });

      assert.strictEqual(savedJobsRescoreCompletionPatch(hub.data, OTHER_SNAPSHOT, { nodeId: 'hub-1' }), null);
      assert.strictEqual(savedJobsRescoreCompletionPatch(hub.data, '', { nodeId: 'hub-1' }), null);
      assert.strictEqual(savedJobsRescoreCompletionPatch(applyPatch(hub.data, { savedJobsRescore: null }), SNAPSHOT, { nodeId: 'hub-1' }), null);
    },
  },
  {
    name: 'buildJobHubCareerOnlyClearPatch drops identity and plan caches but keeps results, pool and settings',
    run: async () => {
      const patch = buildJobHubCareerOnlyClearPatch({ jobAnalysisClearedAt: 99, jobAnalysisClearedRunId: 'run-9', now: 321 });
      assert.strictEqual(patch.savedJobsCareerClearedAt, 321);
      assert.strictEqual(Object.hasOwn(patch, 'preferenceCandidatePool'), false);
      for (const key of ['savedJobsRescore', 'searchBriefPlan', 'resolvedRoles', 'resolvedRolesMeta', 'pinnedTitles']) {
        assert.strictEqual(patch[key], null, `${key} must be reset to null`);
      }
      assert.strictEqual(patch.careerSnapshotId, null);
      assert.strictEqual(patch.jobAnalysisClearedAt, 99);
      for (const key of [
        'hubState', 'scoredJobs', 'jobRunId', 'resultDisposition', 'resultCount', 'gatheredCount', 'scrapedCount',
        'totalScoredCount', 'lastCompletedRunAt', 'lastSearchCoverageStartedAt', 'targetRole', 'jobPreferences',
        'preferredLocation', 'searchLocation', 'remoteResidences', 'initialLookbackDays', 'collectionLimits',
        'enabledSourceIds',
      ]) {
        assert.strictEqual(Object.hasOwn(patch, key), false, `${key} must not be written by the career-only clear`);
      }

      const pool = [{ url: 'https://jobs.example.test/pm' }];
      const hub = terminalHub('hub-1', {
        careerSnapshotId: SNAPSHOT,
        careerData: { name: 'x' },
        resumeProfile: { name: 'x' },
        filePath: '/tmp/a.pdf',
        filePaths: ['/tmp/a.pdf'],
        careerFilePaths: ['/tmp/a.pdf'],
        preferenceCandidatePool: pool,
        targetRole: 'PM',
      });
      assert.strictEqual(hubHasAcceptedInitialDrop(hub), true);
      const after = { ...hub, data: applyPatch(hub.data, patch) };
      assert.strictEqual(hubHasAcceptedInitialDrop(after), false);
      assert.strictEqual(after.data.preferenceCandidatePool, pool);
      assert.strictEqual(after.data.scoredJobs, JOBS);
      assert.strictEqual(after.data.hubState, 'done');
      assert.strictEqual(after.data.targetRole, 'PM');
      assert.strictEqual(isCareerClearedWithSavedJobs(after), true);
    },
  },
  {
    name: 'buildJobHubScrapeClearPatch resets exactly the scrape results and mints a rescan capability on the same snapshot',
    run: async () => {
      const nodeId = 'hub-1';
      const history = { lastCompletedRunAt: 1234, lastSearchCoverageStartedAt: 1000 };
      const hub = terminalHub(nodeId, {
        careerSnapshotId: SNAPSHOT,
        resumeFingerprint: FINGERPRINT,
        resumeProfile: { name: 'x' },
        careerFilePaths: ['/tmp/b.pdf'],
        targetRole: 'PM',
        searchBriefPlan: { titles: ['PM'] },
        enabledSourceIds: ['linkedin'],
        savedJobsRescore: { version: 1 },
      });
      const patch = buildJobHubScrapeClearPatch(hub.data, {
        nodeId,
        jobAnalysisClearedAt: 77,
        jobAnalysisClearedRunId: 'run-7',
        materializedSearchHistory: history,
        now: 555,
      });

      const capability = patch.careerImportGeneration;
      assert.match(capability, /^career-import:hub-1:.+/);
      assert.strictEqual(patch.careerImportFreshCapability, capability);
      assert.strictEqual(patch.careerImportConsumption, null);
      assert.strictEqual(patch.careerImportCompilation.status, 'approved');
      assert.strictEqual(patch.careerImportCompilation.generation, capability);
      assert.strictEqual(patch.careerImportCompilation.attemptId, 'rescan-555');
      assert.strictEqual(patch.careerImportCompilation.careerSnapshotId, SNAPSHOT);
      assert.strictEqual(patch.careerImportCompilation.profileFingerprint, FINGERPRINT);

      // Exactly the documented keys: results, history and rescan authority; nothing else.
      assert.deepStrictEqual(
        Object.keys(patch).sort(),
        [...RESULT_RESET_KEYS, ...Object.keys(history),
          'careerImportGeneration', 'careerImportFreshCapability', 'careerImportConsumption', 'careerImportCompilation'].sort(),
      );
      assert.strictEqual(patch.hubState, 'empty');
      assert.strictEqual(patch.scoredJobs, null);
      assert.deepStrictEqual(patch.finalSourceCounts, {});
      assert.deepStrictEqual(patch.scrapeWarnings, []);
      assert.deepStrictEqual(patch.collectionScopeCaveats, []);
      assert.strictEqual(patch.resultCount, 0);
      assert.strictEqual(patch.jobRunId, null);
      assert.strictEqual(patch.savedJobsRescore, null);
      assert.strictEqual(patch.jobAnalysisClearedAt, 77);
      assert.strictEqual(patch.jobAnalysisClearedRunId, 'run-7');
      assert.strictEqual(patch.lastCompletedRunAt, 1234);
      assert.strictEqual(patch.lastSearchCoverageStartedAt, 1000);

      // Identity and settings are untouched.
      const merged = applyPatch(hub.data, patch);
      for (const key of ['careerSnapshotId', 'resumeProfile', 'inputLocked', 'careerFilePaths', 'targetRole', 'searchBriefPlan', 'enabledSourceIds']) {
        assert.strictEqual(merged[key], hub.data[key], `${key} must survive Clear Scrape`);
        assert.strictEqual(Object.hasOwn(patch, key), false, `${key} must not be in the scrape-clear patch`);
      }
      assert.strictEqual(hubHasAcceptedInitialDrop({ type: 'jobhub', data: merged }), true);

      // The Board sees a fresh, scannable input again.
      const admission = classifyJobBoardSourceAdmission({ id: nodeId, type: 'jobhub', data: merged });
      assert.strictEqual(admission.kind, 'fresh-imported-input');
      assert.strictEqual(admission.freshImportCapability, capability);
    },
  },
  {
    name: 'buildJobHubScrapeClearPatch migrates a legacy filePath, uses an injected capability and omits rescan keys without a snapshot',
    run: async () => {
      const nodeId = 'hub-2';
      const legacy = terminalHub(nodeId, {
        careerSnapshotId: SNAPSHOT,
        filePath: '/tmp/legacy.pdf',
        careerFilePaths: ['/tmp/modern.pdf'],
      });
      const injected = capabilityFor(nodeId, '33333333-3333-4333-8333-333333333333');
      const calls = [];
      const patch = buildJobHubScrapeClearPatch(legacy.data, {
        nodeId,
        createCapability: id => { calls.push(id); return injected; },
      });
      assert.deepStrictEqual(calls, [nodeId]);
      assert.strictEqual(patch.careerImportGeneration, injected);
      assert.strictEqual(patch.careerImportFreshCapability, injected);
      assert.strictEqual(patch.filePath, null);
      assert.deepStrictEqual(patch.careerFilePaths, ['/tmp/modern.pdf', '/tmp/legacy.pdf']);
      assert.match(patch.careerImportCompilation.attemptId, /^rescan-\d+$/);
      const merged = applyPatch(legacy.data, patch);
      assert.strictEqual(merged.filePath, null);
      assert.strictEqual(classifyJobBoardSourceAdmission({ id: nodeId, type: 'jobhub', data: merged }).kind, 'fresh-imported-input');

      // No legacy filePath => the path keys are not written.
      const modern = buildJobHubScrapeClearPatch(terminalHub(nodeId, { careerSnapshotId: SNAPSHOT }).data, { nodeId });
      assert.strictEqual(Object.hasOwn(modern, 'filePath'), false);
      assert.strictEqual(Object.hasOwn(modern, 'careerFilePaths'), false);

      // Invalid / missing snapshot id, or missing node id: no rescan authority at all.
      const capabilityKeys = ['careerImportGeneration', 'careerImportFreshCapability', 'careerImportConsumption', 'careerImportCompilation'];
      const noSnapshotCases = [
        ['no snapshot', terminalHub(nodeId).data, nodeId],
        ['short snapshot', terminalHub(nodeId, { careerSnapshotId: 'abc' }).data, nodeId],
        ['uppercase snapshot', terminalHub(nodeId, { careerSnapshotId: 'A'.repeat(64) }).data, nodeId],
        ['empty node id', terminalHub(nodeId, { careerSnapshotId: SNAPSHOT }).data, ''],
        ['missing node id', terminalHub(nodeId, { careerSnapshotId: SNAPSHOT }).data, undefined],
      ];
      for (const [label, data, id] of noSnapshotCases) {
        const noAuthority = buildJobHubScrapeClearPatch(data, {
          nodeId: id,
          createCapability: () => { throw new Error('must not mint'); },
        });
        for (const key of capabilityKeys) {
          assert.strictEqual(Object.hasOwn(noAuthority, key), false, `${label}: ${key} must be omitted`);
        }
        assert.strictEqual(noAuthority.hubState, 'empty', label);
      }
    },
  },
  {
    name: 'Board admission: career-cleared-awaiting-files, compiling, failed, rescore and approval branches in order',
    run: async () => {
      const gen = capabilityFor('hub-1');
      const compiling = { version: 1, generation: gen, attemptId: 'a1', status: 'compiling' };
      const failed = { version: 1, generation: gen, attemptId: 'a1', status: 'failed', error: 'boom' };
      const kind = hub => classifyJobBoardSourceAdmission(hub).kind;

      // An ordinary terminal hub (career identity present, no marker) is unchanged.
      const ordinary = classifyJobBoardSourceAdmission(terminalHub('hub-1'));
      assert.strictEqual(ordinary.kind, 'reuse-terminal');
      assert.strictEqual(ordinary.outcome.runId, 'terminal-run');

      // 1. Cleared career with saved jobs wins over a marker and a compiling receipt.
      const cleared = { id: 'hub-1', type: 'jobhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1, savedJobsRescore: rescoreHub().data.savedJobsRescore, careerImportGeneration: gen, careerImportCompilation: compiling } };
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(cleared), {
        kind: 'career-cleared-awaiting-files',
        reason: 'Career data was cleared. Drop new career files on this Job Search to re-score its saved jobs.',
      });
      // ...but a done hub with no jobs and no identity does not take the new branch.
      assert.notStrictEqual(kind({ id: 'hub-1', type: 'jobhub', data: { hubState: 'done', scoredJobs: [] } }), 'career-cleared-awaiting-files');

      // 2. Compiling / failed receipt for the current generation (with or without a marker).
      const withReceipt = (receipt, marker) => rescoreHub('hub-1', { dataExtra: { careerImportCompilation: receipt }, marker });
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(withReceipt(compiling)), {
        kind: 'career-import-compiling',
        reason: 'New career files are still being compiled and audited.',
      });
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(withReceipt(failed)), {
        kind: 'career-import-failed',
        reason: 'Career compilation failed. Retry it on the Job Search card, then re-score its saved jobs from the Board.',
      });
      assert.strictEqual(kind(withReceipt(compiling, null)), 'career-import-compiling');
      assert.strictEqual(kind(withReceipt(failed, null)), 'career-import-failed');
      // A compiling receipt for a different generation is not consulted.
      const staleReceipt = { ...compiling, generation: capabilityFor('hub-1', '99999999-9999-4999-8999-999999999999') };
      assert.strictEqual(kind(withReceipt(staleReceipt, null)), 'reuse-terminal');

      // 3. Pending re-score.
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(rescoreHub()), {
        kind: 'rescore-saved-jobs', careerSnapshotId: SNAPSHOT, savedJobCount: 2,
      });

      // 4. Marker present but no longer pending.
      const approval = {
        kind: 'career-import-requires-approval',
        reason: 'The new career data no longer matches its approved snapshot. Clear career data and import it again.',
      };
      const staleMarker = buildSavedJobsRescoreMarker({ careerSnapshotId: OTHER_SNAPSHOT, generation: gen });
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(rescoreHub('hub-1', { marker: staleMarker })), approval);
      const wrongGeneration = buildSavedJobsRescoreMarker({
        careerSnapshotId: SNAPSHOT, generation: capabilityFor('hub-1', '44444444-4444-4444-8444-444444444444'),
      });
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(rescoreHub('hub-1', { marker: wrongGeneration })), approval);
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(rescoreHub('hub-1', { marker: { ...rescoreHub().data.savedJobsRescore, version: 9 } })), approval);

      // Non-done and non-jobhub shapes are unchanged.
      assert.deepStrictEqual(classifyJobBoardSourceAdmission({ id: 'x', type: 'sellhub', data: {} }), { kind: 'invalid' });
      assert.deepStrictEqual(
        classifyJobBoardSourceAdmission({ id: 'x', type: 'jobhub', data: { hubState: 'scoring', savedJobsRescore: rescoreHub().data.savedJobsRescore } }),
        { kind: 'intermediate-or-setup' },
      );
    },
  },
  {
    name: 'partitionJobBoardSourceAdmissions has a rescore bucket and blocks career-cleared-awaiting-files',
    run: async () => {
      const cleared = { id: 'cleared', type: 'jobhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1 } };
      const rescore = rescoreHub('rescore');
      const reusable = terminalHub('reusable');
      const failing = rescoreHub('failing', { dataExtra: { careerImportCompilation: { version: 1, generation: capabilityFor('failing'), attemptId: 'a', status: 'failed' } } });
      const partition = partitionJobBoardSourceAdmissions([cleared, rescore, reusable, failing, { type: 'jobhub', data: {} }]);
      const ids = bucket => partition[bucket].map(entry => entry.sourceId);
      assert.deepStrictEqual(ids('rescore'), ['rescore']);
      assert.strictEqual(partition.rescore[0].admission.kind, 'rescore-saved-jobs');
      assert.deepStrictEqual(ids('blocked'), ['cleared', 'failing']);
      assert.deepStrictEqual(ids('reusable'), ['reusable']);
      assert.deepStrictEqual(ids('fresh'), []);
      assert.deepStrictEqual(ids('continuations'), []);
      assert.deepStrictEqual(ids('other'), []);
      assert.strictEqual(partition.invalid.length, 1);
      assert.deepStrictEqual(Object.keys(partition).sort(), ['blocked', 'continuations', 'fresh', 'invalid', 'other', 'rescore', 'reusable']);
      assert.deepStrictEqual(Object.keys(partitionJobBoardSourceAdmissions([])).sort(), Object.keys(partition).sort());
    },
  },
  {
    name: 'getHubDropLockReason lets a done jobhub with saved jobs and no career identity accept a drop',
    run: async () => {
      const cleared = { type: 'jobhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1 } };
      assert.strictEqual(getHubDropLockReason(cleared), null);
      // The explicit stamp is required; an identity-less legacy result stays started.
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { ...cleared.data, savedJobsCareerClearedAt: null } }), 'started');
      // Identity present: still started.
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { ...cleared.data, careerSnapshotId: SNAPSHOT } }), 'started');
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { ...cleared.data, inputLocked: true } }), 'started');
      // Locked / busy checks above still win.
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { ...cleared.data, locked: true } }), 'locked');
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { ...cleared.data, manualAiResume: { retirementPending: true } } }), 'busy');
      // No saved jobs, other states, and other hub types are unchanged.
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { hubState: 'done', scoredJobs: [] } }), 'started');
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { hubState: 'done' } }), 'started');
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { hubState: 'error', scoredJobs: JOBS } }), 'started');
      assert.strictEqual(getHubDropLockReason({ ...cleared, data: { hubState: 'scoring', scoredJobs: JOBS } }), 'busy');
      assert.strictEqual(getHubDropLockReason({ type: 'sellhub', data: { hubState: 'done', scoredJobs: JOBS, savedJobsCareerClearedAt: 1 } }), 'started');
      assert.strictEqual(getHubDropLockReason({ type: 'jobhub', data: {} }), null);
    },
  },
  {
    name: 'prepareBackgroundBoardChildRequest returns null whenever a saved-jobs re-score is requested',
    run: async () => {
      const preferences = 'Software engineering roles';
      const preferredLocation = 'Toronto, Ontario, Canada';
      const data = {
        hubState: 'empty',
        resumeProfile: { name: 'Candidate' },
        resumeFingerprint: FINGERPRINT,
        careerSnapshotId: SNAPSHOT,
        careerDerivedSnapshotId: SNAPSHOT,
        queryCareerSnapshotId: SNAPSHOT,
        jobPreferences: preferences,
        searchBriefPlan: { titles: ['Software Engineer'] },
        jobPreferencePlan: { titles: ['Software Engineer'] },
        resolvedRoles: ['Software Engineer'],
        resolvedRolesMeta: { derivedAt: '2026-10-01T00:00:00.000Z', careerSnapshotId: SNAPSHOT },
        queries: {
          targetRoleQueries: ['software engineer'],
          titleQueries: ['backend engineer'],
          suggestedRoleQueries: [],
          skillsOnlyQueries: [],
        },
        queryCacheKey: buildJobCareerQueryCacheKey({
          careerSnapshotId: SNAPSHOT,
          resumeFingerprint: FINGERPRINT,
          jobPreferences: preferences,
          preferredLocation,
        }),
        preferredLocation,
        canonicalLocation: preferredLocation,
        canonicalCountry: 'Canada',
        enabledSourceIds: ['linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs'],
        collectionLimits: { jobsPerPlatform: 50, pagesPerPlatform: 3 },
      };
      const request = node => prepareBackgroundBoardChildRequest({
        node,
        boardNodeId: 'board',
        boardRunId: 'board-run',
        startedAt: Date.now(),
        canvasFilePath: '/tmp/board.json',
      });
      // Control: without a marker this exact hub is admitted, so the null below is the marker's doing.
      const baseline = request({ id: 'child', type: 'jobhub', data });
      assert.strictEqual(baseline?.request?.providerPhaseOnly, true);
      const marker = buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation: capabilityFor('child') });
      assert.strictEqual(request({ id: 'child', type: 'jobhub', data: { ...data, savedJobsRescore: marker } }), null);
      assert.notStrictEqual(request({ id: 'child', type: 'jobhub', data: { ...data, savedJobsRescore: null } }), null);
    },
  },
  {
    name: 'career swap flow: Clear Career Data keeps jobs, a new compile owes a Board re-score, and completing it restores ordinary reuse',
    run: async () => {
      const nodeId = 'swap-hub';
      const oldGeneration = capabilityFor(nodeId, '55555555-5555-4555-8555-555555555555');
      const pool = [...JOBS, { title: 'Extra', company: 'Pool', url: 'https://jobs.example.test/extra' }];
      const start = terminalHub(nodeId, {
        careerSnapshotId: OTHER_SNAPSHOT,
        careerImportGeneration: oldGeneration,
        careerImportConsumption: { capability: oldGeneration, generation: oldGeneration, origin: 'standalone' },
        careerImportCompilation: approvedReceipt(oldGeneration, OTHER_SNAPSHOT),
        resumeProfile: { name: 'Old' },
        careerFilePaths: ['/career/old.md'],
        preferenceCandidatePool: pool,
        lastCompletedRunAt: 1_790_000_000_000,
      });
      assert.strictEqual(classifyJobBoardSourceAdmission(start).kind, 'reuse-terminal');

      // 1. Clear Career Data: identity gone, jobs/pool/run/history kept, Board blocks Combine-reuse.
      const cleared = { ...start, data: applyPatch(start.data, buildJobHubCareerOnlyClearPatch({ jobAnalysisClearedAt: 10, now: 11 })) };
      assert.strictEqual(cleared.data.scoredJobs, JOBS);
      assert.strictEqual(cleared.data.preferenceCandidatePool, pool);
      assert.strictEqual(cleared.data.jobRunId, 'terminal-run');
      assert.strictEqual(cleared.data.lastCompletedRunAt, 1_790_000_000_000);
      assert.strictEqual(classifyJobBoardSourceAdmission(cleared).kind, 'career-cleared-awaiting-files');
      assert.strictEqual(getHubDropLockReason(cleared), null);

      // 2. Drop + compile (what acceptCareerFiles/compileCareerFiles write in keep-jobs mode).
      const generation = capabilityFor(nodeId);
      const begun = beginCareerImportCompilation({ generation, attemptId: 'attempt-x' });
      const dropped = { ...cleared, data: applyPatch(cleared.data, {
        inputLocked: true, careerFilePaths: ['/career/new.md'], careerImportGeneration: generation,
        careerImportFreshCapability: generation, careerImportConsumption: null, careerImportCompilation: begun,
      }) };
      assert.strictEqual(classifyJobBoardSourceAdmission(dropped).kind, 'career-import-compiling');
      const approved = approveCareerImportCompilation(begun, { generation, attemptId: 'attempt-x', careerSnapshotId: SNAPSHOT });
      const compiled = { ...dropped, data: applyPatch(dropped.data, {
        hubState: 'done', careerSnapshotId: SNAPSHOT, resumeProfile: { name: 'New' }, careerImportCompilation: approved,
        savedJobsRescore: buildSavedJobsRescoreMarker({ careerSnapshotId: SNAPSHOT, generation }), savedJobsCareerClearedAt: null,
      }) };
      assert.deepStrictEqual(classifyJobBoardSourceAdmission(compiled), { kind: 'rescore-saved-jobs', careerSnapshotId: SNAPSHOT, savedJobCount: 2 });
      assert.deepStrictEqual(partitionJobBoardSourceAdmissions([compiled]).rescore.map(entry => entry.sourceId), [nodeId]);

      // 3. A successful re-score retires the marker and spends the import exactly once.
      const done = { ...compiled, data: applyPatch(compiled.data, savedJobsRescoreCompletionPatch(compiled.data, SNAPSHOT, { nodeId })) };
      assert.strictEqual(done.data.savedJobsRescore, null);
      assert.strictEqual(done.data.careerImportFreshCapability, null);
      assert.strictEqual(done.data.careerImportConsumption.origin, 'saved-jobs-rescore');
      const reuse = classifyJobBoardSourceAdmission(done);
      assert.strictEqual(reuse.kind, 'reuse-terminal');
      assert.strictEqual(reuse.outcome.runId, 'terminal-run');
    },
  },
  {
    name: 'scrape flow: Clear Scrape keeps career and scan history, so the next scan continues from the last completed scrape, not the lookback',
    run: async () => {
      const nodeId = 'scrape-hub';
      const lastCompletedRunAt = 1_790_500_000_000;
      const start = terminalHub(nodeId, {
        careerSnapshotId: SNAPSHOT,
        resumeFingerprint: FINGERPRINT,
        resumeProfile: { name: 'Kept' },
        careerFilePaths: ['/career/kept.md'],
        lastCompletedRunAt,
        initialLookbackDays: 3,
      });
      const patch = buildJobHubScrapeClearPatch(start.data, { nodeId, jobAnalysisClearedAt: 20 });
      const cleared = { ...start, data: applyPatch(start.data, patch) };
      assert.strictEqual(cleared.data.hubState, 'empty');
      assert.strictEqual(cleared.data.scoredJobs, null);
      assert.strictEqual(cleared.data.resumeProfile, start.data.resumeProfile);
      assert.deepStrictEqual(jobSearchNextAnchor(cleared.data, nodeId), { timestamp: lastCompletedRunAt, source: 'last-completed' });
      assert.strictEqual(classifyJobBoardSourceAdmission(cleared).kind, 'fresh-imported-input');
      // Then Clear Career Data on the scrape-cleared hub (both halves cleared)
      // must still keep the scan date: history is module history.
      const both = applyPatch(cleared.data, buildJobHubCareerOnlyClearPatch({ jobAnalysisClearedAt: 21 }));
      assert.deepStrictEqual(jobSearchNextAnchor(both, nodeId), { timestamp: lastCompletedRunAt, source: 'last-completed' });
    },
  },
  {
    name: 'Board selection label: a re-score-only selection reads Re-score & combine; mixed with fresh scans it continues',
    run: async () => {
      assert.strictEqual(jobBoardSelectionPresentation([{ boardAction: 'rescore' }]).runLabel, 'Re-score & combine');
      assert.strictEqual(jobBoardSelectionPresentation([{ boardAction: 'rescore' }]).rescoreCount, 1);
      assert.strictEqual(jobBoardSelectionPresentation([{ boardAction: 'rescore' }, { boardAction: 'scan' }]).runLabel, 'Continue & combine');
      assert.strictEqual(jobBoardSelectionPresentation([{ boardAction: 'scan' }]).runLabel, 'Search & combine');
      assert.strictEqual(jobBoardSelectionPresentation([{ boardAction: 'reuse' }]).runLabel, 'Combine saved results');
    },
  },
  {
    name: 'Job Search integration: Board re-score child is score-only, never claims the scrape run, and precedes the interrupted-run probe',
    run: async () => {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const runner = sliceBetween(search, 'const runForJobBoard = useCallback(async ({', 'const handleReanalyze = useCallback');
      const rescoreAt = runner.indexOf("liveImportAdmission.kind === 'rescore-saved-jobs'\n");
      const probeAt = runner.indexOf('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun) {');
      const freshAt = runner.indexOf('const runFreshBoardImport = () => {');
      assert(rescoreAt > freshAt && probeAt > rescoreAt, 'the re-score branch must be dispatched before the interrupted-run probe can fall through to runFreshBoardImport');
      const branch = runner.slice(rescoreAt, runner.indexOf('} else if (exactInterruptedRecovery) {', rescoreAt));
      assert(branch.includes('handleReanalyzeRef.current?.({') && branch.includes('boardRun: { orchestratorNodeId, boardRunId, parentCancelled: cancelled }'),
        'a Board re-score must run handleReanalyze inside the Board transaction');
      assert(!branch.includes('ownsExistingRecoveryRun = true'), 'claiming the existing run would let a cancel discard the completed scrape run files');
      assert(!branch.includes('runFreshBoardImport') && !branch.includes('handleRerun'), 'a re-score must never reach a provider scan');
      assert(runner.includes("savedJobsRescore: liveImportAdmission.kind === 'rescore-saved-jobs',"), 'readiness must not demand platforms/location for a score-only child');
    },
  },
  {
    name: 'Job Search integration: career-only clear uses no exact-run tombstone; compile keeps jobs listed; re-score commit retires its marker',
    run: async () => {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const clear = sliceBetween(search, "const handleClearCareerFiles = useCallback(async (e, requestedMode = 'all') => {", 'const handleClearCareerData = useCallback');
      assert(clear.includes('const jobAnalysisClearedRunId = clearsResults ? normalizeJobAnalysisClearRunId(runId) : null;'),
        'kept jobs re-score under their scrape run id, so a career-only clear must fence by timestamp only');
      assert(clear.includes('if (runId && clearsResults) {'), 'a career-only clear must keep the completed run files');
      assert(clear.indexOf('if (clearsResults) {\n      // Source cards belong to the cleared scrape.') > clear.indexOf('processingRunsRef.current.cancel();'),
        'only clears that remove results may delete source cards');
      const compile = sliceBetween(search, 'const compileCareerFiles = useCallback', 'const startProcessingWithProfile = useCallback');
      assert(compile.includes("hubState: retainSavedJobs ? 'done' : 'parsing'") && compile.includes("hubState: retainSavedJobs ? 'done' : 'empty',"),
        'a keep-jobs compile must hold the completed state so the saved jobs stay listed');
      assert(compile.includes('...(retainSavedJobs ? { savedJobsRescore: rescoreMarker, savedJobsCareerClearedAt: null } : {}),'),
        'the approved keep-jobs compile must record the owed re-score in the same commit');
      const reanalyze = sliceBetween(search, 'const handleReanalyze = useCallback', "// Drop the hub's career identity");
      assert((reanalyze.match(/savedJobsRescoreCompletionPatch\(node\?\.data, admittedReanalysisCareerSnapshotId, \{ nodeId: currentId \}\)/g) || []).length === 2,
        'both the scored and the all-filtered re-score commits must retire the marker');
      assert(reanalyze.includes('if (!boardManaged && !queueManagedExternally) lease = await moduleRunQueue.acquireModuleRun({'),
        'a Board-managed re-score must not take the lane its Board already holds');
      const followUp = sliceBetween(search, 'const continueSavedJobsRescore = useCallback', 'const acceptCareerFiles = useCallback');
      assert(followUp.indexOf('isJobSearchConnectedToBoard(id, getNodes(), getEdges())') < followUp.indexOf('handleReanalyzeRef.current?.({ savedJobsRescore: true, ...queueOptions })'),
        'a Board-connected hub must leave the re-score to its Board rather than starting it standalone');
    },
  },
  {
    name: 'Job Board integration: hubs awaiting replacement career data are excluded from Combine input',
    run: async () => {
      const board = readSource('../../src/nodes/JobBoardNode.jsx');
      const combine = sliceBetween(board, 'function liveCombineInputs(boardId, nodes, edges) {', 'function boardInputSignature');
      assert(combine.includes('&& !isSavedJobsCareerReplacementPending(node),'), 'Combine must skip rows scored under a replaced or cleared career snapshot');
      for (const kind of ['career-cleared-awaiting-files', 'rescore-saved-jobs', 'career-import-compiling', 'career-import-failed', 'career-import-requires-approval']) {
        assert(board.includes(`  '${kind}',\n`), `${kind} must be a replacement-pending admission`);
      }
    },
  },
];
