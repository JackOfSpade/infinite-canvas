import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';
import { isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../../src/utils/jobBoardAiProvider.js';
import { attachCompensationRemoteResidences, emptyReplacementIneligibilityReason, moduleFingerprint, normalizeJobMatchScore, unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';

export default [
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
      assert(moduleFingerprint([base]).startsWith('5:'), 'fit-audit-aware fingerprints use the current v5 format');

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
      const releasesBeforeCancellation = (section) => section.indexOf('combineRunRef.current = null;') >= 0
        && section.indexOf('compensationRequestIdRef.current = null;') >= 0
        && section.indexOf('combineRunRef.current = null;') < section.indexOf('window.electronAPI?.cancelNodeTask?.(id)')
        && section.indexOf('compensationRequestIdRef.current = null;') < section.indexOf('window.electronAPI?.cancelNodeTask?.(id)');
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
