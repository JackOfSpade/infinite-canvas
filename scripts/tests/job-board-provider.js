import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';
import { isJobBoardUserCancellation, isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../../src/utils/jobBoardAiProvider.js';
import { attachCompensationRemoteResidences, emptyReplacementIneligibilityReason, moduleFingerprint, normalizeJobMatchScore, unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';
import { compareJobsByFitAndPreference } from '../../src/nodes/jobsearch/buildJobTree.js';

export default [
  {
    name: 'Job Board treats manual-AI cancellation as control flow, not a combine failure',
    run() {
      assert(isJobBoardUserCancellation({ success: false, error: 'Manual AI job cancelled' })
        && isJobBoardUserCancellation(new Error('Manual AI job cancelled'))
        && isJobBoardUserCancellation({ errorCode: 'JOB_TASK_CANCELLED' })
        && !isJobBoardUserCancellation({ success: false, error: 'Taxonomy response was invalid' }),
      'only explicit user-cancellation envelopes/errors may bypass board failure handling');

      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const taxonomyCancellation = board.indexOf('stage=taxonomy');
      const taxonomyFailure = board.indexOf('Bucketing failed; preserving prior board');
      const compensationCancellation = board.indexOf('stage=compensation');
      const compensationFailure = board.indexOf('Compensation research failed; preserving prior board');
      assert(taxonomyCancellation >= 0 && taxonomyCancellation < taxonomyFailure
        && compensationCancellation >= 0 && compensationCancellation < compensationFailure
        && board.includes('stage=pipeline'),
      'all board stages must recognize manual cancellation before logging a failure or raising the outer failure toast');
      return { neutralCancellation: true, stages: ['taxonomy', 'compensation', 'pipeline'] };
    },
  },
  {
    name: 'Job Board taxonomy validation rejects incomplete API output before board replacement',
    run() {
      const valid = validateJobBoardTaxonomy({
        roles: [{ name: 'Engineering', jobIndices: [0, 1] }],
      }, 2);
      assert(valid.valid, `complete role taxonomy should be valid: ${valid.reason}`);
      const missing = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0] }] }, 2);
      const duplicate = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0, 0] }] }, 1);
      assert(!missing.valid && !duplicate.valid,
        'incomplete or duplicate role assignment must abort before it can replace a board');
      return { completeAccepted: true, invalidRejected: true };
    },
  },
  {
    name: 'Job Board hides editable legacy flat cards until a successful Re-combine',
    run() {
      const flatNodes = [{ type: 'jobcard', data: { hubId: 'board' } }];
      assert(isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null }, flatNodes, 'board'),
        'an editable done board with direct cards and no taxonomy must be marked stale');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null, locked: true }, flatNodes, 'board'),
        'a locked snapshot must retain its historical view');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: { roles: [] } }, flatNodes, 'board'),
        'a board with persisted taxonomy is not the legacy flat-card case');
      return { legacyFlatBoardHidden: true, lockedSnapshotPreserved: true };
    },
  },
  {
    name: 'Job Board compensation context follows each union job’s origin without mutating scored-job storage',
    run() {
      const sourceJobs = [
        { title: 'Remote US role', originHubId: 'search-us' },
        { title: 'Remote CA role', originHubId: 'search-ca' },
        { title: 'Legacy origin', originHubId: 'missing' },
      ];
      const residences = {
        'search-us': { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
        'search-ca': { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
      };
      const attached = attachCompensationRemoteResidences(sourceJobs, residences);
      assert(attached !== sourceJobs && attached.every((job, index) => job !== sourceJobs[index]),
        'the per-origin attachment helper must clone the union and its jobs');
      assert(attached[0].compensationRemoteResidences === residences['search-us']
        && attached[1].compensationRemoteResidences === residences['search-ca'],
      'each job must receive the residence map owned by its originHubId');
      assert(Object.keys(attached[2].compensationRemoteResidences).length === 0,
        'an unknown legacy origin must fail safely with no invented residence');
      assert(sourceJobs.every(job => !Object.hasOwn(job, 'compensationRemoteResidences')),
        'attaching transient research context must not mutate source modules’ stored scored jobs');
      return { origins: attached.length, sourceUntouched: true };
    },
  },
  {
    name: 'Job Board merge retains unlinked requisitions and compares legacy numeric score strings numerically',
    run() {
      const higherLegacyScore = { title: 'Analyst', company: 'Acme', url: 'https://jobs.example/analyst', matchScore: '80' };
      const lowerLegacyScore = { ...higherLegacyScore, matchScore: '9' };
      const unlinkedA = { title: 'Developer', company: 'Acme', location: 'Toronto', originHubId: 'search-a', matchScore: 70 };
      const unlinkedB = { ...unlinkedA, originHubId: 'search-b', matchScore: 75 };
      const stats = {};
      const merged = unionScoredJobs([[lowerLegacyScore, unlinkedA], [higherLegacyScore, unlinkedB]], stats);

      assert(merged.length === 3, `separate rows without listing URLs must not collapse into one, got ${merged.length}`);
      assert(merged[0] === higherLegacyScore,
        'numeric-looking legacy scores must compare numerically, so 80 beats 9 rather than lexicographically losing to it');
      assert(stats.collisions === 1 && stats.collisionUpgrades === 1,
        `only the linked duplicate should register as a score-upgrade collision, got ${JSON.stringify(stats)}`);
      return { jobs: merged.length, scoreUpgrades: stats.collisionUpgrades };
    },
  },
  {
    name: 'Job Board taxonomy score projection preserves legacy numeric score strings',
    run() {
      assert(normalizeJobMatchScore('80') === 80,
        'a persisted numeric score string must reach taxonomy bucketing as 80, not a zero fallback');
      assert(normalizeJobMatchScore(' 72.5 ') === 72.5,
        'numeric strings retain fractional scores used by a legacy canvas');
      assert(normalizeJobMatchScore('not-a-score') === 0 && normalizeJobMatchScore(Infinity) === 0,
        'invalid/non-finite values still use the safe zero fallback');
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(board.includes('matchScore: normalizeJobMatchScore(j.matchScore)'),
        'the IPC taxonomy projection must use the shared score normalization boundary');
      return { numericString: normalizeJobMatchScore('80') };
    },
  },
  {
    name: 'Job Board fingerprint invalidates cards when their visible fit audit changes',
    run() {
      const base = {
        title: 'Engineer', company: 'Acme', matchScore: 82,
        fitAssessment: {
          auditStatus: 'audited',
          confidence: { effective: 'high', groundedRequirementCount: 2, requirementCount: 2 },
          requirementRows: [{
            requirement: 'Build services', effectiveStatus: 'direct', scoreImpact: 'scoring', materialGap: false,
            grounding: { requirementGrounded: true, candidateClaimGrounded: true },
          }],
        },
      };
      const changedGap = {
        ...base,
        fitAssessment: {
          ...base.fitAssessment,
          requirementRows: [{
            ...base.fitAssessment.requirementRows[0],
            effectiveStatus: 'not_documented', materialGap: true,
            grounding: { requirementGrounded: true, candidateClaimGrounded: false },
          }],
        },
      };
      assert(moduleFingerprint([base]) !== moduleFingerprint([changedGap]),
        'a changed rendered fit-audit status/gap must mark the board stale for Re-combine');
      assert(moduleFingerprint([base]).startsWith('6:'), 'fit-audit-aware fingerprints use the current v6 format');

      const rejectedEvidenceCountOnly = {
        ...base,
        fitAssessment: {
          ...base.fitAssessment,
          requirementRows: [{
            ...base.fitAssessment.requirementRows[0],
            grounding: {
              ...base.fitAssessment.requirementRows[0].grounding,
              rejectedJobEvidence: ['first', 'second'],
            },
          }],
        },
      };
      const rejectedEvidenceOneItem = {
        ...rejectedEvidenceCountOnly,
        fitAssessment: {
          ...rejectedEvidenceCountOnly.fitAssessment,
          requirementRows: [{
            ...rejectedEvidenceCountOnly.fitAssessment.requirementRows[0],
            grounding: {
              ...rejectedEvidenceCountOnly.fitAssessment.requirementRows[0].grounding,
              rejectedJobEvidence: ['first'],
            },
          }],
        },
      };
      assert(moduleFingerprint([rejectedEvidenceCountOnly]) === moduleFingerprint([rejectedEvidenceOneItem]),
        'the number of rejected evidence excerpts is not card-visible and must not stale a board');
      const hiddenCoverageA = {
        ...base,
        fitAssessment: { ...base.fitAssessment, confidence: { effective: 'high', groundedRequirementCount: -1, requirementCount: 2 } },
      };
      const hiddenCoverageB = {
        ...base,
        fitAssessment: { ...base.fitAssessment, confidence: { effective: 'high', groundedRequirementCount: -99, requirementCount: 2 } },
      };
      assert(moduleFingerprint([hiddenCoverageA]) === moduleFingerprint([hiddenCoverageB]),
        'malformed coverage values hidden by the card must not stale a board');
      return { fingerprintChanged: true };
    },
  },
  {
    name: 'Job Board keeps hiring fit primary and uses Job Preferences only as a stable within-fit tie-break',
    run() {
      const fitFirst = { title: 'Higher fit', matchScore: 91, preferenceAssessment: { preferenceScore: -50 } };
      const preferenceFirst = { title: 'Preferred equal fit', matchScore: 80, preferenceAssessment: { preferenceScore: 20 } };
      const neutralEqualFit = { title: 'Neutral equal fit', matchScore: 80, preferenceAssessment: { preferenceScore: 0 } };
      const stableA = { title: 'Original first', matchScore: 70, preferenceAssessment: { preferenceScore: 5 } };
      const stableB = { title: 'Original second', matchScore: 70, preferenceAssessment: { preferenceScore: 5 } };
      const ordered = [neutralEqualFit, stableA, preferenceFirst, fitFirst, stableB]
        .sort(compareJobsByFitAndPreference);
      assert(ordered[0] === fitFirst && ordered[1] === preferenceFirst && ordered[2] === neutralEqualFit,
        'a higher hiring fit must always win; only equal-fit rows are ordered by the preference score');
      assert(ordered[3] === stableA && ordered[4] === stableB,
        'a complete fit/preference tie must preserve source order without an invented lexical tie-break');
      const changedPreference = {
        ...neutralEqualFit,
        preferenceAssessment: {
          preferenceScore: 12, status: 'accepted', summary: 'Matches Job Preferences',
          matches: [{ preferenceId: 'free-lunch', outcome: 'confirmed', source: 'web', sourceDate: '2026-08-31', verifiedAt: '2026-09-03T12:00:00.000Z' }],
        },
      };
      assert(moduleFingerprint([neutralEqualFit]) !== moduleFingerprint([changedPreference]),
        'a changed card-visible Job Preferences assessment must make Re-combine available');
      const refreshedEvidence = {
        ...changedPreference,
        preferenceAssessment: {
          ...changedPreference.preferenceAssessment,
          matches: [{ ...changedPreference.preferenceAssessment.matches[0], verifiedAt: '2026-09-04T12:00:00.000Z' }],
        },
      };
      assert(moduleFingerprint([changedPreference]) !== moduleFingerprint([refreshedEvidence]),
        'updated independently verified preference evidence must make Re-combine available');
      const tree = readFileSync(new URL('../../src/nodes/jobsearch/buildJobTree.js', import.meta.url), 'utf8');
      assert(tree.includes('preferenceAssessment: job.preferenceAssessment')
        && tree.includes('.sort(compareJobsByFitAndPreference)'),
      'tree construction must preserve the preference assessment and use the shared comparator for cards');
      return { orderedTitles: ordered.map(job => job.title), preferenceFingerprintChanged: true };
    },
  },
  {
    name: 'Job Board asks to replace only a stale authoritative empty result and rechecks it on confirm',
    run() {
      const staleEmpty = {
        stale: true,
        allConnectedModulesDone: true,
        readyModuleCount: 0,
      };
      assert(emptyReplacementIneligibilityReason(staleEmpty) === null,
        'a stale board fed only by terminal zero-result searches may request confirmation');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, stale: false }) === 'the board is no longer stale',
        'a non-stale board with the same terminal zero result must not open a replacement confirmation');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, allConnectedModulesDone: false }) === 'one or more connected searches are no longer terminal',
        'a search that changes state while the prompt is open must block the destructive replacement');
      assert(emptyReplacementIneligibilityReason({ ...staleEmpty, readyModuleCount: 1 }) === 'one or more connected searches now have jobs',
        'fresh positive jobs arriving while the prompt is open must block the destructive replacement');

      // The full ReactFlow dialog is intentionally not unit-mounted here. Pin
      // that both UI transition points use the shared predicate: the initial
      // click must not open a doomed dialog and confirm must re-check current
      // inputs rather than trusting the state that opened it.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const confirmStart = board.indexOf('const confirmEmptyReplacement');
      const confirmEnd = board.indexOf('const cleanupBoard', confirmStart);
      const confirm = board.slice(confirmStart, confirmEnd);
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      assert(combine.includes('if (canReplaceWithEmpty) {\n        requestEmptyReplacement();')
        && combine.includes("title: 'Board already current'"),
      'the non-stale terminal-zero path must show an informational result instead of opening a confirmation');
      assert(confirm.includes('if (!canReplaceWithEmpty)')
        && confirm.includes('reason=${emptyReplacementBlockReason}'),
      'confirmation must re-check current eligibility and log the concrete reason it did not clear results');
      return { staleEmptyPrompts: true, currentEmptyDoesNotPrompt: true, changedInputsBlocked: true };
    },
  },
  {
    name: 'Job Board compensation seam stays ordered, node-scoped, bridged, and transient',
    run() {
      // A full ReactFlow + Electron IPC harness would test frameworks rather
      // than this small seam. Pin the exact source-level ordering and cleanup
      // contract, while the per-origin data transform above is exercised as
      // real executable code.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const preload = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
      const main = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      assert(combine.includes('if (combineRunRef.current) return;')
        && combine.includes("const combineToken = Symbol('job-board-combine');")
        && combine.includes('combineRunRef.current = combineToken;'),
      'Combine must use a synchronous ref token so two same-turn calls cannot both start before React commits combining=true');
      assert(combine.includes('if (combineRunRef.current === combineToken)')
        && combine.includes('combineRunRef.current = null;')
        && combine.indexOf('setCompensationProgress(null);', combine.indexOf('if (combineRunRef.current === combineToken)'))
          > combine.indexOf('if (combineRunRef.current === combineToken)'),
      'only the active Combine may release the synchronous run lock or clear its progress after settlement');
      const cleanupStart = board.indexOf('const cleanupBoard');
      const clearStart = board.indexOf('const handleClear');
      const clearEnd = board.indexOf('const handleCombine', clearStart);
      const cleanupBlock = board.slice(cleanupStart, clearStart);
      const clearBlock = board.slice(clearStart, clearEnd);
      // Match the call PREFIX, not the whole call: each cancel site now passes
      // its own cause label (`cancelNodeTask(id, 'board-cleared')`) so the bug
      // report can name why a run stopped. The ordering invariant is unchanged.
      const releasesBeforeCancellation = (section) => {
        const cancelAt = section.indexOf('window.electronAPI?.cancelNodeTask?.(id');
        return cancelAt >= 0
          && section.indexOf('combineRunRef.current = null;') >= 0
          && section.indexOf('compensationRequestIdRef.current = null;') >= 0
          && section.indexOf('combineRunRef.current = null;') < cancelAt
          && section.indexOf('compensationRequestIdRef.current = null;') < cancelAt;
      };
      assert(releasesBeforeCancellation(cleanupBlock) && releasesBeforeCancellation(clearBlock),
        'Clear and unmount cleanup must synchronously release the Combine lock and request id before cancelling backend work');
      const bucket = combine.indexOf('await window.electronAPI.bucketJobs');
      const taxonomy = combine.indexOf('validateJobBoardTaxonomy', bucket);
      const compensation = combine.indexOf('await window.electronAPI?.researchJobCompensation', taxonomy);
      const enrichedUnion = combine.indexOf('union = compensationResult.jobs', compensation);
      const build = combine.indexOf('buildJobTreeNodes', enrichedUnion);
      assert(bucket >= 0 && taxonomy > bucket && compensation > taxonomy && enrichedUnion > compensation && build > enrichedUnion,
        'Combine must validate bucketing before compensation, then build cards only from the enriched returned union');
      const snapshot = combine.indexOf("new CustomEvent('canvas-take-snapshot')", build);
      const clear = combine.indexOf('clearBoardChildren();', build);
      const add = combine.indexOf('addElementsGlobally(id, newNodes, newEdges', clear);
      const publish = combine.indexOf("hubState: 'done'", add);
      const completion = combine.indexOf('[JobBoard] combine completed', publish);
      assert(snapshot > build && clear > snapshot && add > clear && publish > add && completion > publish,
        'a successful Re-combine must build first, snapshot once, replace the old cascade, then publish/log the completed board');
      assert(combine.includes('union = attachCompensationRemoteResidences(union, remoteResidencesByOrigin)'),
        'Combine must attach each origin module’s residence map to the full union before the IPC call');
      assert(board.includes('const activeRequestId = compensationRequestIdRef.current;')
        && board.includes('if (!activeRequestId || payload?.nodeId !== id || payload?.requestId !== activeRequestId) return;'),
      'board compensation progress must require a truthy active request plus exact node/request ids, rejecting stale, unscoped, and idle null/null events');
      assert(preload.includes("researchJobCompensation: (args) => ipcRenderer.invoke('research-job-compensation', args)"),
        'the preload bridge must expose the board-stage compensation IPC');
      assert(combine.includes('requestId: compensationRequestId')
        && board.includes('const compensationRequestId = `board-compensation:${id}:${entropy}`;'),
      'each board Combine must create and send a unique compensation request id');

      const handlerStart = main.indexOf("handleSafe('research-job-compensation'");
      const handlerEnd = main.indexOf("handleSafe('bucket-jobs'", handlerStart);
      const handler = main.slice(handlerStart, handlerEnd);
      const finallyStart = handler.indexOf('} finally {');
      const cleanup = handler.indexOf('delete job?.compensationRemoteResidences', finallyStart);
      assert(handlerStart >= 0 && handlerEnd > handlerStart && finallyStart >= 0 && cleanup > finallyStart,
        'the main handler must strip renderer-injected residences in finally on success, failure, and cancellation');
      assert(handler.includes('{ jobs, nodeId, requestId = null, remoteResidences }')
        && handler.includes('event, nodeId, requestId, signal')
        && main.includes('requestId: requestId || null'),
      'the optional request id must travel through IPC and every compensation progress event without breaking non-board callers');
      const bucketHandlerStart = main.indexOf("handleSafe('bucket-jobs'");
      const bucketHandler = main.slice(bucketHandlerStart, main.indexOf("handleSafe('resolve-job-source'", bucketHandlerStart));
      assert(bucketHandler.includes('runBoundedJobTaxonomy(jobs')
        && bucketHandler.includes('strategy: \'bounded-plan-chunks\'')
        && bucketHandler.includes('inspectJobBoardRoleByIndex(result?.roleByIndex')
        && bucketHandler.includes('normalizeJobBoardRoleByIndex(result?.roleByIndex'),
      'Job Board bucketing uses bounded plan/classify calls and validates exact all-job coverage before normalization');
      assert(bucketHandler.includes('taxonomyChunksCompleted: taxonomyProgress.completedBatches')
        && bucketHandler.includes('taxonomyChunkCount: taxonomyProgress.batchCount')
        && bucketHandler.includes('taxonomyVocabularySize: taxonomyProgress.vocabularySize')
        && bucketHandler.includes('taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments')
        && bucketHandler.includes('taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments')
        && !bucketHandler.includes('taxonomyChunksCompleted: result?.batchCount'),
      'successful bucketing telemetry retains bounded-run progress instead of reading orchestration fields stripped by taxonomy sanitization');
      return {
        ordering: ['bucket', 'taxonomy', 'compensation', 'build', 'snapshot', 'clear', 'add', 'publish'],
        exactNodeProgress: true,
        transactionalReplacement: true,
        transientCleanup: true,
      };
    },
  },
];
