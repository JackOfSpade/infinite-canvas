import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';
import { isJobBoardUserCancellation, isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../../src/utils/jobBoardAiProvider.js';
import { attachCompensationRemoteResidences, combineSignature, emptyReplacementIneligibilityReason, moduleCombineFingerprint, moduleFingerprint, normalizeJobMatchScore, unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';
import { compareJobsByFitAndPreference } from '../../src/nodes/jobsearch/buildJobTree.js';
import { findJobSearchBoardActiveRecoveryOwner, findJobSearchBoardRecoveryOwner, getConnectedJobSearchIds, getSelectedConnectedJobSearchIds, isJobSearchConnectedToBoard, remapCopiedJobBoardSelections, remapCopiedJobModuleReferences, toggleSelectedJobSearchId } from '../../src/utils/jobBoardSearchSelection.js';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import { retireDeletedManualAiRuns } from '../../src/utils/canvasInteractions.js';
import { collectJobBoardsAffectedByDeletion, getClearCanvasRetainedNodes, getJobWorkflowDeletionLifecycleRevision, isClearCanvasDeletionFenceIntact, isJobWorkflowDeletionPending, jobBoardHasCancellableRecovery, markJobWorkflowDeletionPending, settleJobWorkflowDeletion, subscribeJobWorkflowDeletionLifecycle } from '../../src/utils/nodeDeletionLifecycle.js';
import { boundedCombinedSourceRuns } from '../../src/utils/jobBoardProvenance.js';

export default [
  {
    name: 'Job workflow deletion lifecycle wakes recovery on reversible mark and settle',
    run() {
      const before = getJobWorkflowDeletionLifecycleRevision();
      const notifications = [];
      const unsubscribe = subscribeJobWorkflowDeletionLifecycle(() => {
        notifications.push(getJobWorkflowDeletionLifecycleRevision());
      });
      const workflowNodes = [
        { id: 'deletion-board', type: 'jobboard', data: {} },
        {
          id: 'container', type: 'group', data: {
            canvasData: { nodes: [{ id: 'deletion-search', type: 'jobhub', data: {} }] },
          },
        },
      ];
      const ids = markJobWorkflowDeletionPending(workflowNodes);
      const overlappingIds = markJobWorkflowDeletionPending(workflowNodes);
      let firstTransactionSettled = false;
      try {
        assert(JSON.stringify(ids.sort()) === JSON.stringify(['deletion-board', 'deletion-search'])
          && JSON.stringify(overlappingIds.sort()) === JSON.stringify(ids)
          && isJobWorkflowDeletionPending('deletion-board')
          && isJobWorkflowDeletionPending('deletion-search')
          && notifications.length === 1
          && notifications[0] === before + 1,
        'marking a reversible deletion must synchronously publish every nested Board/Search guard without republishing an overlapping guard');
        settleJobWorkflowDeletion(ids);
        firstTransactionSettled = true;
        assert(isJobWorkflowDeletionPending('deletion-board')
          && isJobWorkflowDeletionPending('deletion-search')
          && notifications.length === 1,
        'settling one overlapping deletion transaction must not wake recovery while another boundary still owns the guard');
      } finally {
        if (!firstTransactionSettled) settleJobWorkflowDeletion(ids);
        settleJobWorkflowDeletion(overlappingIds);
        unsubscribe();
      }
      assert(!isJobWorkflowDeletionPending('deletion-board')
        && !isJobWorkflowDeletionPending('deletion-search')
        && notifications.length === 2
        && notifications[1] === before + 2,
      'aborting or committing the deletion must publish guard settlement so retained recovery effects can run again');
      const removedSearch = { id: 'removed-search', type: 'jobhub', data: {} };
      const idleLockedBoard = { id: 'idle-locked-board', type: 'jobboard', data: { locked: true } };
      const recoveredBoard = {
        id: 'recovered-board', type: 'jobboard', data: {
          boardScanResume: {
            boardRunId: 'board-run',
            selectedSearchModuleIds: ['removed-search'],
          },
        },
      };
      const cleanupOnlyBoard = {
        id: 'cleanup-only-board', type: 'jobboard', data: {
          manualAiResume: {
            runId: 'retired-run',
            retirementPending: true,
            combineSourceRuns: [{ sourceId: 'removed-search' }],
          },
        },
      };
      const deletedBoard = { id: 'deleted-board', type: 'jobboard', data: {} };
      const affected = collectJobBoardsAffectedByDeletion(
        [removedSearch, idleLockedBoard, recoveredBoard, cleanupOnlyBoard, deletedBoard],
        [{ source: 'idle-locked-board', target: 'removed-search' }],
        new Set(['removed-search', 'deleted-board']),
      ).map(board => board.id).sort();
      assert(JSON.stringify(affected) === JSON.stringify([
        'deleted-board', 'idle-locked-board', 'recovered-board',
      ])
        && !jobBoardHasCancellableRecovery(idleLockedBoard)
        && jobBoardHasCancellableRecovery(recoveredBoard)
        && !jobBoardHasCancellableRecovery(cleanupOnlyBoard),
      'deletion must elect a pre-marker edge-connected Board and a disconnected durable owner, always include a deleted Board, ignore a disconnected cleanup-only receipt, and allow a locked but genuinely idle Board to acknowledge none safely');
      const retainedAfterClear = getClearCanvasRetainedNodes([
        { id: 'locked-board', type: 'jobboard', data: { locked: true } },
        { id: 'board-group', type: 'jobgroup', data: { hubId: 'locked-board' } },
        { id: 'board-card', type: 'jobcard', data: { hubId: 'locked-board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'source-card', type: 'jobsourcecard', data: { hubId: 'locked-search' } },
        { id: 'removed-board', type: 'jobboard', data: {} },
        { id: 'orphan-lock', type: 'jobcard', data: { locked: true, hubId: 'removed-board' } },
        { id: 'locked-note', type: 'text', data: { locked: true } },
        { id: 'unlocked-note', type: 'text', data: {} },
      ]).map(node => node.id);
      assert(JSON.stringify(retainedAfterClear) === JSON.stringify([
        'locked-board', 'board-group', 'board-card', 'locked-search', 'source-card', 'locked-note',
      ]),
      'Clear Canvas must preserve a locked Board/Search together with every owned display child, retain ordinary locked nodes, and never leave a locked orphan whose workflow root was removed');
      const initialClearGraph = [
        { id: 'board', type: 'jobboard', data: {} },
        { id: 'board-card-before', type: 'jobcard', data: { hubId: 'board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
      ];
      assert(isClearCanvasDeletionFenceIntact(initialClearGraph, [
        { id: 'board', type: 'jobboard', data: { boardCancellation: { operationId: 'cancel' } } },
        { id: 'board-card-restored', type: 'jobcard', data: { hubId: 'board' } },
        { id: 'locked-search', type: 'jobhub', data: { locked: true } },
        { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
      ], [
        { source: 'board', target: 'board-card-before' },
        { source: 'board', target: 'locked-search' },
      ], [
        { source: 'board', target: 'board-card-restored' },
        { source: 'locked-search', target: 'board' },
      ])
        && !isClearCanvasDeletionFenceIntact(initialClearGraph, [
          ...initialClearGraph,
          { id: 'late-board', type: 'jobboard', data: {} },
        ])
        && !isClearCanvasDeletionFenceIntact(initialClearGraph, [
          { id: 'board', type: 'jobboard', data: {} },
          { id: 'board-card-before', type: 'jobcard', data: { hubId: 'board' } },
          { id: 'locked-search', type: 'jobhub', data: { locked: false } },
          { id: 'second-locked-search', type: 'jobhub', data: { locked: true } },
        ])
        && !isClearCanvasDeletionFenceIntact(
          initialClearGraph,
          initialClearGraph,
          [{ source: 'board', target: 'locked-search' }],
          [{ source: 'board', target: 'second-locked-search' }],
        ),
      'Clear Canvas must permit exact cancellation-owned child restoration but fail closed when a root/workflow is added, its retention lock changes, or a root connection is rewired during asynchronous cleanup');
      return { marked: ids.length, notifications, affected, retainedAfterClear };
    },
  },
  {
    name: 'Job Board search selection defaults legacy boards to all connections and preserves an explicit allow-list',
    run() {
      const graphOrder = getConnectedJobSearchIds(
        'board',
        [
          { id: 'search-b', type: 'jobhub' },
          { id: 'note', type: 'text' },
          { id: 'search-a', type: 'jobhub' },
          { id: 'board', type: 'jobboard' },
        ],
        [
          { source: 'search-a', target: 'board' },
          { source: 'board', target: 'search-b' },
          { source: 'note', target: 'board' },
          { source: 'search-b', target: 'board' },
        ],
      );
      assert(JSON.stringify(graphOrder) === JSON.stringify(['search-b', 'search-a']),
        'connected searches must accept either loose-edge direction, ignore other node types, deduplicate edges, and retain canvas-node order');

      const connected = ['search-b', 'search-a', 'search-b', '', null, 'search-c'];
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds(undefined, connected))
          === JSON.stringify(['search-b', 'search-a', 'search-c'])
        && JSON.stringify(getSelectedConnectedJobSearchIds(null, connected))
          === JSON.stringify(['search-b', 'search-a', 'search-c']),
        'a board saved before selection existed must scan every live connection once, in connection order',
      );
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds([], connected)) === JSON.stringify([]),
        'an explicit empty allow-list must remain scan-none rather than falling back to the legacy scan-all default',
      );
      assert(
        JSON.stringify(getSelectedConnectedJobSearchIds(
          ['search-a', 'disconnected-search', 'search-a', false, 'search-c'],
          connected,
        )) === JSON.stringify(['search-a', 'search-c']),
        'selection resolution must discard invalid, duplicate, and disconnected ids without letting saved order reorder the live queue',
      );

      const deselectedFromLegacyDefault = toggleSelectedJobSearchId(undefined, 'search-a', connected);
      const selectedFromExplicitEmpty = toggleSelectedJobSearchId([], 'search-c', connected);
      const ignoredDisconnectedToggle = toggleSelectedJobSearchId(['search-a'], 'disconnected-search', connected);
      assert(JSON.stringify(deselectedFromLegacyDefault) === JSON.stringify(['search-b', 'search-c']),
        'the first toggle on a legacy board must begin from all connected modules, then deselect only the requested one');
      assert(JSON.stringify(selectedFromExplicitEmpty) === JSON.stringify(['search-c']),
        'an explicit empty selection can add one connected module without selecting its siblings');
      assert(JSON.stringify(ignoredDisconnectedToggle) === JSON.stringify(['search-a']),
        'a stale UI action for a disconnected module must not add it to the board allow-list');
      assert(toggleSelectedJobSearchId(undefined, 'disconnected-search', connected) === undefined,
        'a stale disconnected toggle must preserve the missing/default-all representation instead of freezing today\'s connections into an explicit subset');

      const whileBDisconnected = toggleSelectedJobSearchId(
        ['search-a', 'search-b'],
        'search-c',
        ['search-a', 'search-c'],
      );
      const afterBReconnects = getSelectedConnectedJobSearchIds(
        whileBDisconnected,
        ['search-a', 'search-b', 'search-c'],
      );
      assert(JSON.stringify(whileBDisconnected) === JSON.stringify(['search-a', 'search-c', 'search-b'])
        && JSON.stringify(afterBReconnects) === JSON.stringify(['search-a', 'search-b', 'search-c']),
      'toggling a visible Search while another selected Search is disconnected must preserve that hidden intent and restore it on reconnect');

      const boardSource = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const toggleStart = boardSource.indexOf('const toggleSearchModule = useCallback');
      const toggleEnd = boardSource.indexOf('\n\n  // Positive scored jobs', toggleStart);
      const toggleHandler = boardSource.slice(toggleStart, toggleEnd);
      assert(toggleHandler.includes('const toggleSearchModule = useCallback((moduleId, checked) => {')
        && toggleHandler.includes('const connectedAtEvent = getConnectedJobSearchIds(id, getNodes(), getEdges());')
        && toggleHandler.includes('if (!connectedAtEvent.includes(moduleId)) return;')
        && toggleHandler.includes('updateGlobal(id, (node) => {')
        && toggleHandler.includes('const liveConnectedIds = getConnectedJobSearchIds(id, getNodes(), getEdges());')
        && toggleHandler.includes('if (!liveConnectedIds.includes(moduleId)) return null;')
        && toggleHandler.includes('const liveSelection = node?.data?.selectedSearchModuleIds;')
        && toggleHandler.includes('currentlySelected === checked')
        && toggleHandler.includes('liveSelection,')
        && toggleHandler.includes('moduleId,\n        liveConnectedIds,'),
      'the checkbox handler must reject an edge-removal race, derive rapid toggles from functional live node data, and idempotently honor each event\'s checked state');
      return { legacyDefault: 3, explicitEmpty: 0, selected: ['search-a', 'search-c'], reconnectPreserved: true };
    },
  },
  {
    name: 'Job Board search selector gives duplicate labels stable visible and accessible discriminators',
    run() {
      const selection = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');
      assert(selection.includes("'scoring-batch',")
        && selection.includes('const idsByLabel = new Map();')
        && selection.includes('const suffix = shortestUniqueIdSuffix(row.module.id, peerIds);')
        && selection.includes('if (peerIds.length < 2) return { ...row, discriminator: null };')
        && selection.includes('peerId.slice(-length) !== suffix')
        && selection.includes('{discriminator.visible}')
        && selection.includes('aria-label={discriminator?.accessibleName || `Scan ${label}`}'),
      'the selector must render every active Search phase consistently, and only colliding role/location labels receive a stable visible and accessible node-id suffix');
      return { collisionScoped: true, visible: true, accessible: true, scoringBatchActive: true };
    },
  },
  {
    name: 'Batch duplicate and paste remap explicit Job Board search selections',
    run() {
      const originals = [
        {
          id: 'board-subset', type: 'jobboard',
          data: {
            selectedSearchModuleIds: ['search-b', 'missing-search'],
            queuedModuleRun: { position: 1 },
            manualAiResume: { runId: 'old-manual-run' },
            boardScanResume: { boardRunId: 'old-board-run' },
          },
        },
        { id: 'board-none', type: 'jobboard', data: { selectedSearchModuleIds: [] } },
        { id: 'board-default', type: 'jobboard', data: {} },
        { id: 'search-a', type: 'jobhub', data: {} },
        { id: 'search-b', type: 'jobhub', data: {} },
      ];
      const clones = [
        { id: 'copy-board-subset', type: 'jobboard', data: { resultCount: 2 } },
        { id: 'copy-board-none', type: 'jobboard', data: {} },
        { id: 'copy-board-default', type: 'jobboard', data: {} },
        { id: 'copy-search-a', type: 'jobhub', data: {} },
        { id: 'copy-search-b', type: 'jobhub', data: {} },
      ];
      const idMap = new Map(originals.map((node, index) => [node.id, clones[index].id]));
      const copiedEdges = [
        { source: 'board-subset', target: 'search-a' },
        { source: 'search-b', target: 'board-subset' },
      ];
      const remapped = remapCopiedJobBoardSelections(originals, clones, idMap, copiedEdges);
      const subset = remapped.find(node => node.id === 'copy-board-subset');
      const none = remapped.find(node => node.id === 'copy-board-none');
      const defaultAll = remapped.find(node => node.id === 'copy-board-default');

      assert(JSON.stringify(subset.data.selectedSearchModuleIds) === JSON.stringify(['copy-search-b'])
        && subset.data.resultCount === 2
        && !('queuedModuleRun' in subset.data)
        && !('manualAiResume' in subset.data)
        && !('boardScanResume' in subset.data),
      'a copied Board must translate only selected Job Searches present in the same batch while preserving its sanitized durable data and never restoring original run markers');
      assert(Array.isArray(none.data.selectedSearchModuleIds) && none.data.selectedSearchModuleIds.length === 0,
        'an explicit scan-none Board selection must remain explicit after a batch copy');
      assert(!Object.prototype.hasOwnProperty.call(defaultAll.data, 'selectedSearchModuleIds'),
        'a missing Board allow-list must remain missing so legacy/default-all behavior is preserved');

      const boardOnly = remapCopiedJobBoardSelections(
        [{ id: 'board-only', type: 'jobboard', data: { selectedSearchModuleIds: ['old-search'] } }],
        [{ id: 'copy-board-only', type: 'jobboard', data: {} }],
        new Map([['board-only', 'copy-board-only']]),
        [],
      )[0];
      assert(!Object.prototype.hasOwnProperty.call(boardOnly.data, 'selectedSearchModuleIds'),
        'a Board copied without any connected Search must retain cloneNode default-all behavior for connections added later');

      const unselectedConnection = remapCopiedJobBoardSelections(
        [
          { id: 'board-with-a', type: 'jobboard', data: { selectedSearchModuleIds: ['search-b-not-copied'] } },
          { id: 'search-a-only', type: 'jobhub', data: {} },
        ],
        [
          { id: 'copy-board-with-a', type: 'jobboard', data: {} },
          { id: 'copy-search-a-only', type: 'jobhub', data: {} },
        ],
        new Map([['board-with-a', 'copy-board-with-a'], ['search-a-only', 'copy-search-a-only']]),
        [{ source: 'board-with-a', target: 'search-a-only' }],
      )[0];
      assert(Array.isArray(unselectedConnection.data.selectedSearchModuleIds)
        && unselectedConnection.data.selectedSearchModuleIds.length === 0,
      'a copied edge to an explicitly unselected Search must remain unselected instead of reverting to default-all');

      const temporarilyDisconnectedSelection = remapCopiedJobBoardSelections(
        [
          { id: 'board-reconnect', type: 'jobboard', data: { selectedSearchModuleIds: ['search-b-reconnect'] } },
          { id: 'search-a-reconnect', type: 'jobhub', data: {} },
          { id: 'search-b-reconnect', type: 'jobhub', data: {} },
        ],
        [
          { id: 'copy-board-reconnect', type: 'jobboard', data: {} },
          { id: 'copy-search-a-reconnect', type: 'jobhub', data: {} },
          { id: 'copy-search-b-reconnect', type: 'jobhub', data: {} },
        ],
        new Map([
          ['board-reconnect', 'copy-board-reconnect'],
          ['search-a-reconnect', 'copy-search-a-reconnect'],
          ['search-b-reconnect', 'copy-search-b-reconnect'],
        ]),
        [{ source: 'board-reconnect', target: 'search-a-reconnect' }],
      )[0];
      assert(JSON.stringify(temporarilyDisconnectedSelection.data.selectedSearchModuleIds)
        === JSON.stringify(['copy-search-b-reconnect']),
      'a copied selected Search must retain its allow-list identity while temporarily disconnected, so reconnecting the copy does not lose the user’s selection intent');

      const actions = readFileSync(new URL('../../src/hooks/useCanvasActions.js', import.meta.url), 'utf8');
      assert((actions.match(/remapCopiedJobModuleReferences\(/g) || []).length === 2,
        'both direct duplicate and clipboard paste must run the graph-aware Board selection remap after allocating the complete batch id map');
      return {
        subset: subset.data.selectedSearchModuleIds,
        explicitNone: none.data.selectedSearchModuleIds,
        defaultAll: true,
        boardOnlyDefaultAll: true,
        disconnectedCopiedSelection: temporarilyDisconnectedSelection.data.selectedSearchModuleIds,
      };
    },
  },
  {
    name: 'Batch duplicate and paste isolate copied Job Board and Job Search child ownership',
    run() {
      const remoteResidences = {
        canada: { city: 'Toronto', subdivision: 'ON', countryCode: 'CA' },
      };
      const originalScoredJobs = [{
        title: 'Platform Engineer',
        company: 'Acme',
        url: 'https://example.test/job/1',
        matchScore: 91,
        originHubId: 'search',
      }];
      const originalFingerprint = moduleCombineFingerprint(originalScoredJobs, remoteResidences);
      const originals = [
        {
          id: 'board', type: 'jobboard',
          data: {
            hubState: 'done',
            resultCount: 2,
            selectedSearchModuleIds: ['search'],
            combineSignature: combineSignature([{ id: 'search', fingerprint: originalFingerprint }]),
            combineSourceRuns: boundedCombinedSourceRuns([
              { id: 'search', runId: 'search-run' },
            ]),
          },
        },
        {
          id: 'search', type: 'jobhub',
          data: {
            hubState: 'done',
            scoredJobs: originalScoredJobs,
            preferenceCandidatePool: [{
              title: 'Saved candidate',
              company: 'Acme',
              originHubId: 'search',
            }],
            remoteResidences,
          },
        },
        { id: 'root-group', type: 'jobgroup', data: { hubId: 'board', childIds: ['role-group', 'job-card', 'not-copied'] } },
        { id: 'role-group', type: 'jobgroup', data: { hubId: 'board', childIds: ['job-card'] } },
        { id: 'job-card', type: 'jobcard', data: { hubId: 'board', originHubId: 'search' } },
        { id: 'source-card', type: 'jobsourcecard', data: { hubId: 'search', sourceId: 'indeed' } },
        { id: 'external-origin-card', type: 'jobcard', data: { hubId: 'board', originHubId: 'search-not-copied' } },
      ];
      const clones = originals.map(node => ({
        ...node,
        id: `copy-${node.id}`,
        data: { ...(node.data || {}) },
      }));
      const idMap = new Map(originals.map(node => [node.id, `copy-${node.id}`]));
      const remapped = remapCopiedJobModuleReferences(
        originals,
        clones,
        idMap,
        [
          { source: 'board', target: 'search' },
          { source: 'search', target: 'source-card' },
          { source: 'board', target: 'root-group' },
        ],
      );
      const byId = new Map(remapped.map(node => [node.id, node]));

      assert(byId.get('copy-root-group').data.hubId === 'copy-board'
        && byId.get('copy-role-group').data.hubId === 'copy-board'
        && byId.get('copy-job-card').data.hubId === 'copy-board'
        && byId.get('copy-external-origin-card').data.hubId === 'copy-board',
      'every copied result node must be owned by the copied Board rather than remain in the original Board cascade');
      assert(byId.get('copy-source-card').data.hubId === 'copy-search',
        'a copied source card must be owned by the copied Job Search rather than remain in the original Search lifecycle');
      assert(JSON.stringify(byId.get('copy-root-group').data.childIds) === JSON.stringify(['copy-role-group', 'copy-job-card'])
        && JSON.stringify(byId.get('copy-role-group').data.childIds) === JSON.stringify(['copy-job-card']),
      'copied group trees must translate copied child ids and drop references to children outside the batch');
      assert(byId.get('copy-job-card').data.originHubId === 'copy-search'
        && byId.get('copy-external-origin-card').data.originHubId === 'search-not-copied',
      'copied cards must follow copied origin Searches without destroying intentional external provenance');
      const copiedSearch = byId.get('copy-search');
      const copiedFingerprint = moduleCombineFingerprint(copiedSearch.data.scoredJobs, remoteResidences);
      assert(copiedSearch.data.scoredJobs[0].originHubId === 'copy-search'
        && copiedSearch.data.preferenceCandidatePool[0].originHubId === 'copy-search'
        && originalScoredJobs[0].originHubId === 'search'
        && originals[1].data.preferenceCandidatePool[0].originHubId === 'search',
      'stored scored and saved-preference candidate provenance must follow a copied Search without mutating the original result generation or letting later re-analysis restore old ownership');
      assert(byId.get('copy-board').data.combineSourceRuns[0].sourceHubId === 'copy-search'
        && !Object.hasOwn(byId.get('copy-board').data.combineSourceRuns[0], 'sourceId')
        && byId.get('copy-board').data.combineSourceRuns[0].runId === 'search-run'
        && byId.get('copy-board').data.combineSignature
          === combineSignature([{ id: 'copy-search', fingerprint: copiedFingerprint }]),
      'a fully copied completed cascade must remap its real bounded sourceHubId receipt and rebuild its versioned signature against copied Search ids, rather than mounting immediately stale or pointing Clear/report provenance back to the original Search');

      const legacyReceiptCopy = remapCopiedJobModuleReferences(
        [
          { id: 'legacy-board', type: 'jobboard', data: { combineSourceRuns: [{ sourceId: 'search', runId: 'legacy-run', fingerprint: originalFingerprint }] } },
          originals[1],
        ],
        [
          { id: 'copy-legacy-board', type: 'jobboard', data: {} },
          { id: 'copy-search', type: 'jobhub', data: copiedSearch.data },
        ],
        new Map([['legacy-board', 'copy-legacy-board'], ['search', 'copy-search']]),
      )[0];
      assert(legacyReceiptCopy.data.combineSourceRuns[0].sourceId === 'copy-search'
        && legacyReceiptCopy.data.combineSourceRuns[0].fingerprint === copiedFingerprint
        && !Object.hasOwn(legacyReceiptCopy.data.combineSourceRuns[0], 'sourceHubId'),
      'legacy sourceId recovery receipts must still remap and retain their legacy schema without being mistaken for bounded completed-Board provenance');

      const historicalFingerprint = '7:historical-search-fingerprint';
      const externalFingerprint = '7:historical-external-fingerprint';
      const clearedBoardCopy = remapCopiedJobModuleReferences(
        [
          {
            id: 'cleared-board', type: 'jobboard', data: {
              clearProvenance: {
                clearedAt: 1_750_000_000_000,
                priorResultCount: 3,
                priorSourceRuns: [
                  { sourceHubId: 'search', runId: 'search-run' },
                  { sourceHubId: 'external-search', runId: 'external-run' },
                ],
                priorCombineSignature: combineSignature([
                  { id: 'search', fingerprint: historicalFingerprint },
                  { id: 'external-search', fingerprint: externalFingerprint },
                ]),
              },
            },
          },
          originals[1],
        ],
        [
          { id: 'copy-cleared-board', type: 'jobboard', data: {} },
          { id: 'copy-search', type: 'jobhub', data: copiedSearch.data },
        ],
        new Map([['cleared-board', 'copy-cleared-board'], ['search', 'copy-search']]),
      )[0];
      assert(JSON.stringify(clearedBoardCopy.data.clearProvenance.priorSourceRuns) === JSON.stringify([
        { sourceHubId: 'copy-search', runId: 'search-run' },
        { sourceHubId: 'external-search', runId: 'external-run' },
      ])
        && clearedBoardCopy.data.clearProvenance.priorCombineSignature === combineSignature([
          { id: 'copy-search', fingerprint: historicalFingerprint },
          { id: 'external-search', fingerprint: externalFingerprint },
        ])
        && clearedBoardCopy.data.clearProvenance.clearedAt === 1_750_000_000_000
        && clearedBoardCopy.data.clearProvenance.priorResultCount === 3,
      'a copied cleared Board must remap only copied Search identities while preserving external source references and every historical fingerprint/count field exactly');

      const partialCopy = remapCopiedJobModuleReferences(
        originals.slice(0, 2),
        clones.slice(0, 2),
        new Map([['board', 'copy-board'], ['search', 'copy-search']]),
        [{ source: 'board', target: 'search' }],
      );
      assert(partialCopy[0].data.combineSignature === originals[0].data.combineSignature,
        'a Board copied without its complete result-card cascade must keep a stale historical signature instead of falsely claiming the missing cards are current');

      const actions = readFileSync(new URL('../../src/hooks/useCanvasActions.js', import.meta.url), 'utf8');
      assert((actions.match(/source: oldIdToNewId\.get\(eEdge\.source\)/g) || []).length === 2
        && (actions.match(/target: oldIdToNewId\.get\(eEdge\.target\)/g) || []).length === 2,
      'direct duplicate and clipboard paste must continue remapping every copied source-graph edge endpoint');
      return {
        boardChildren: 4,
        searchChildren: 1,
        treeReferencesIsolated: true,
        originSearchRemapped: true,
        completedSignatureRemapped: true,
      };
    },
  },
  {
    name: 'A pending Search recovery remains owned by its exact Job Board transaction',
    run() {
      const nodes = [
        {
          id: 'search', type: 'jobhub',
          data: { manualAiResume: { runId: 'manual-run', orchestratorNodeId: 'board-a', boardRunId: 'board-a-run' } },
        },
        {
          id: 'board-b', type: 'jobboard',
          data: { boardScanResume: { version: 1, boardRunId: 'board-b-run', phase: 'searches', activeSourceId: 'search', selectedSearchModuleIds: ['search'] } },
        },
        {
          id: 'board-a', type: 'jobboard',
          data: { boardScanResume: { version: 1, boardRunId: 'board-a-run', phase: 'searches', activeSourceId: 'search', selectedSearchModuleIds: ['search'] } },
        },
      ];
      const edges = [
        { source: 'search', target: 'board-a' },
        { source: 'board-b', target: 'search' },
      ];
      const owner = findJobSearchBoardRecoveryOwner('search', 'manual-run', nodes, edges);
      const mapOwner = findJobSearchBoardRecoveryOwner('search', 'manual-run', new Map(nodes.map(node => [node.id, node])), edges);
      assert(owner?.orchestratorNodeId === 'board-a' && owner?.boardRunId === 'board-a-run'
        && JSON.stringify(mapOwner) === JSON.stringify(owner),
      'the child marker must disambiguate competing durable Board plans regardless of node collection shape');
      assert(findJobSearchBoardRecoveryOwner('search', 'different-run', nodes, edges) === null,
        'a Board plan must never claim a different manual-AI generation');
      const mismatchedNodes = nodes.map(node => node.id === 'search'
        ? { ...node, data: { manualAiResume: { runId: 'manual-run', orchestratorNodeId: 'deleted-board', boardRunId: 'deleted-run' } } }
        : node);
      const missingOwner = findJobSearchBoardRecoveryOwner('search', 'manual-run', mismatchedNodes, edges);
      assert(missingOwner?.missingPlan === true
        && missingOwner.orchestratorNodeId === 'deleted-board'
        && missingOwner.boardRunId === 'deleted-run',
      'an explicit child owner that matches no live plan must fail closed instead of falling back to a competing Board');
      return owner;
    },
  },
  {
    name: 'Deleting a Board atomically retires every persisted child-cancellation manual-AI id',
    async run() {
      const deletedBoard = {
        id: 'board-delete',
        type: 'jobboard',
        data: {
          manualAiResume: { runId: 'primary-run' },
          boardScanResume: {
            combineManualAiRunId: 'combine-run',
            cancellationCleanup: {
              manualAiRunId: 'child-legacy-run',
              manualAiRunIds: ['child-ack-a', 'child-ack-b', 'child-legacy-run'],
            },
            recoverableFailure: { manualAiRunId: 'recovery-run' },
          },
          boardCancellation: {
            manualAiRunIds: ['board-cancel-run'],
            childCleanup: {
              manualAiRunId: 'board-child-legacy-run',
              manualAiRunIds: ['board-child-ack-run'],
            },
          },
          manualAiCleanupReceipts: [{ runId: 'superseded-run' }],
        },
      };
      const expectedRunIds = new Set([
        'primary-run',
        'combine-run',
        'child-legacy-run',
        'child-ack-a',
        'child-ack-b',
        'recovery-run',
        'board-cancel-run',
        'board-child-legacy-run',
        'board-child-ack-run',
        'superseded-run',
        'ack-only-run',
      ]);
      const cancellationCalls = [];
      let completedRunIds = null;
      const priorWindow = globalThis.window;
      try {
        globalThis.window = {
          electronAPI: {
            cancelNodeTaskAndWait: async (nodeId, reason) => {
              cancellationCalls.push({ nodeId, reason });
              return { settled: true, manualAiRunIds: ['ack-only-run', 'child-ack-b'] };
            },
            completeNonApiAiRuns: async (runIds) => {
              completedRunIds = [...runIds];
              return { completed: true, clearedRunIds: [...runIds], absentRunIds: [] };
            },
          },
        };
        const retired = await retireDeletedManualAiRuns([deletedBoard]);
        assert(cancellationCalls.length === 1
          && cancellationCalls[0].nodeId === 'board-delete'
          && cancellationCalls[0].reason === 'node-deleted',
        'Board deletion must first obtain an acknowledged cancellation for the exact workflow node');
        assert(completedRunIds?.length === expectedRunIds.size
          && completedRunIds.every(runId => expectedRunIds.has(runId))
          && retired.length === expectedRunIds.size
          && retired.every(({ runId }) => expectedRunIds.has(runId)),
        'Board deletion must atomically retire legacy ids, every persisted cancellationCleanup/childCleanup array id, cleanup receipts, and acknowledgement-only ids exactly once');
      } finally {
        globalThis.window = priorWindow;
      }
      return { retiredRunIds: expectedRunIds.size, cancellationAcknowledged: true };
    },
  },
  {
    name: 'A standalone pending Board Combine reserves its exact shared Search inputs',
    run() {
      const nodes = [
        { id: 'search', type: 'jobhub', data: { hubState: 'done' } },
        {
          id: 'board-a', type: 'jobboard', data: {
            manualAiResume: {
              runId: 'standalone-combine-a',
              updatedAt: 100,
              combineInputSignature: 'search=7:1:123',
              combineSourceRuns: [{ sourceId: 'search', runId: 'search-run-a', resultDisposition: 'scored', fingerprint: '7:1:123' }],
            },
          },
        },
        {
          id: 'board-b', type: 'jobboard', data: {
            boardScanResume: {
              version: 1,
              boardRunId: 'scan-b',
              startedAt: 200,
              phase: 'searches',
              activeSourceId: null,
              selectedSearchModuleIds: ['search'],
            },
          },
        },
      ];
      const edges = [
        { source: 'board-a', target: 'search' },
        { source: 'search', target: 'board-b' },
      ];
      const owner = findJobSearchBoardActiveRecoveryOwner('search', nodes, edges);
      assert(owner?.orchestratorNodeId === 'board-a' && owner.boardRunId === 'standalone-combine-a',
        `a pending standalone Combine must keep its shared Search reserved until recovery retires it, got ${JSON.stringify(owner)}`);
      const withoutExactInput = nodes.map(node => node.id === 'board-a'
        ? { ...node, data: { manualAiResume: { ...node.data.manualAiResume, combineSourceRuns: [] } } }
        : node);
      const fallback = findJobSearchBoardActiveRecoveryOwner('search', withoutExactInput, edges);
      assert(fallback?.orchestratorNodeId === 'board-b' && fallback.boardRunId === 'scan-b',
        'a malformed/empty manual marker must not reserve Searches it cannot prove were inputs');
      const committedCleanup = nodes.map(node => node.id === 'board-a'
        ? {
            ...node,
            data: {
              manualAiResume: {
                ...node.data.manualAiResume,
                retirementPending: true,
                committedResult: true,
              },
            },
          }
        : node);
      const ownerDuringCleanup = findJobSearchBoardActiveRecoveryOwner('search', committedCleanup, edges);
      assert(ownerDuringCleanup?.orchestratorNodeId === 'board-b'
        && ownerDuringCleanup.boardRunId === 'scan-b',
      'a cleanup-only marker for an already committed/superseded Combine must not reserve immutable Search inputs or block another Board while backend retirement is retried');
      return owner;
    },
  },
  {
    name: 'Connected Job Search modules defer fresh scans to their live Job Board owner',
    run() {
      const nodes = [
        { id: 'search-a', type: 'jobhub' },
        { id: 'search-b', type: 'jobhub' },
        { id: 'board-a', type: 'jobboard' },
        { id: 'board-b', type: 'jobboard' },
        { id: 'note', type: 'text' },
      ];
      const edges = [
        { source: 'search-a', target: 'board-a' },
        { source: 'board-b', target: 'search-b' },
        { source: 'search-a', target: 'note' },
        { source: 'note', target: 'board-b' },
        { source: 'search-a', target: 'missing-board' },
      ];
      assert(isJobSearchConnectedToBoard('search-a', nodes, edges)
        && isJobSearchConnectedToBoard('search-b', new Map(nodes.map(node => [node.id, node])), edges),
      'Board ownership must be detected in either edge direction from both React Flow node arrays and nodeLookup maps');
      assert(!isJobSearchConnectedToBoard('note', nodes, edges)
        && !isJobSearchConnectedToBoard('missing-search', nodes, edges)
        && !isJobSearchConnectedToBoard('search-a', nodes.filter(node => node.id !== 'board-a'), edges),
      'non-search nodes, missing searches, and dangling Board edges must not invent a live Board owner');

      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      const legacyAutoStart = search.slice(
        search.indexOf('const autoStartPath ='),
        search.indexOf('// Handle file drops directly onto this node'),
      );
      const retryStart = search.indexOf('const handleRetryFailed = useCallback');
      const retryEnd = search.indexOf('const savedAnalysisWarning', retryStart);
      const retry = search.slice(retryStart, retryEnd);
      assert(search.includes('store => isJobSearchConnectedToBoard(id, store.nodeLookup, store.edges)')
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Direct re-run')) {")
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Interrupted-run resume')) {")
        && search.includes("if (!queueManagedByBoard && deferDirectSearchToBoard('Saved-scrape resume')) {")
        && search.includes("deferDirectSearchToBoard(\n      'Career-file drop'")
        && search.includes('if (managedByJobBoard || activeBoardRecoveryOwnerKey) {\n      EventLogger.log(`[JobSearch][${id}] Legacy file auto-start suppressed')
        && search.includes('This Job Search is reserved by an interrupted Job Board run.')
        && search.includes('This interrupted Search is reserved by its Job Board.')
        && search.includes('This saved Search recovery is reserved by its Job Board.')
        && search.includes('onRetry={activeBoardRecoveryOwnerKey ? null : handleRetryFailed}')
        && search.includes('onRerun={managedByJobBoard ? null : handleRerun}')
        && search.includes('{hasRunnableCareerInput && !controlsLocked && !managedByJobBoard && (')
        && legacyAutoStart.indexOf('if (managedByJobBoard || activeBoardRecoveryOwnerKey)') >= 0
        && legacyAutoStart.indexOf('autoStartedFilePathRef.current = autoStartPath;') > legacyAutoStart.indexOf('if (managedByJobBoard || activeBoardRecoveryOwnerKey)')
        && legacyAutoStart.includes("const claimedByBoard = ['paused', 'not-ready'].includes(outcome?.status)")
        && legacyAutoStart.includes("outcome?.error === 'This Job Search is pending deletion.'")
        && legacyAutoStart.includes('findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())')
        && legacyAutoStart.includes('[activeBoardRecoveryOwnerKey, data.filePath, deletionLifecycleRevision, getEdges, getNodes, hubState, id, managedByJobBoard, startProcessing]')
        && retryStart >= 0 && retryEnd > retryStart
        && retry.indexOf('const supersededCleanupReceipts = normalizeManualAiCleanupReceipts') >= 0
        && retry.indexOf('if (manualRetirement?.runId && manualRetirement.retirementPending)')
          > retry.indexOf('const supersededCleanupReceipts = normalizeManualAiCleanupReceipts')
        && retry.indexOf("if (deferDirectSearchToBoard('Error retry')) return;")
          > retry.indexOf('if (manualRetirement?.runId && manualRetirement.retirementPending)')
        && done.includes('Fresh searches are queued from the connected Job Board.'),
      'connected modules must suppress every fresh direct start while still allowing cleanup-only retries, leaving Board recovery in the owning Board and retaining legacy input until its edge is removed');
      return { edgeDirections: 2, connectedStartsDeferred: true, standaloneCompatibility: true, disconnectRecovery: true };
    },
  },
  {
    name: 'Job Search explicit manual-AI cancellation cannot race its auto-retirement effect',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const settlementStart = search.indexOf('const settleManualAiRetirement = useCallback');
      const settlementEnd = search.indexOf('const completeManualAiRun = useCallback', settlementStart);
      const settlement = search.slice(settlementStart, settlementEnd);
      const intentClaimAt = settlement.indexOf('attemptedManualAiCleanupRunIdsRef.current.add(runId);');
      const intentPublishAt = settlement.indexOf('updateGlobal(id, (node) => {', intentClaimAt);

      const autoStart = search.indexOf('const autoResumedManualAiRunRef = useRef(null);');
      const autoEnd = search.indexOf('const handleDismissError = useCallback', autoStart);
      const autoRecovery = search.slice(autoStart, autoEnd);
      const retirementAt = autoRecovery.indexOf('if (resume.retirementPending) {');
      const inFlightGuardAt = autoRecovery.indexOf(
        'if (attemptedManualAiCleanupRunIdsRef.current.has(resume.runId)) return;',
        retirementAt,
      );
      const recoveryClaimAt = autoRecovery.indexOf(
        'attemptedManualAiCleanupRunIdsRef.current.add(resume.runId);',
        inFlightGuardAt,
      );
      const autoClaimAt = autoRecovery.indexOf(
        'autoResumedManualAiRunRef.current = resume.runId;',
        retirementAt,
      );
      const cleanupInvokeAt = autoRecovery.indexOf('void settleManualAiRetirement({', retirementAt);

      assert(settlementStart >= 0 && settlementEnd > settlementStart
        && intentClaimAt >= 0 && intentPublishAt > intentClaimAt
        && autoStart >= 0 && autoEnd > autoStart && retirementAt >= 0
        && inFlightGuardAt > retirementAt
        && recoveryClaimAt > inFlightGuardAt
        && autoClaimAt > recoveryClaimAt
        && cleanupInvokeAt > autoClaimAt,
      'explicit cancellation must claim the run before publishing its pending marker, and auto-retirement must refuse that in-flight run before starting duplicate cleanup');
      return { prePublishClaim: true, duplicateRetirementFenced: true };
    },
  },
  {
    name: 'Job Search shares active Board-child cancellation cleanup and releases failed reload leases',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const cancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const cancelEnd = search.indexOf('const runForJobBoard = useCallback', cancelStart);
      const cancellation = search.slice(cancelStart, cancelEnd);

      const noControlAt = cancellation.indexOf('if (!control) {');
      const leaseReservationAt = cancellation.indexOf(
        'const cancellationLeasePromise = queueManagedExternally',
        noControlAt,
      );
      const protectedTryAt = cancellation.indexOf('try {', leaseReservationAt);
      const initialIntentAt = cancellation.indexOf(
        'const boardCleanupIntentPersisted = await persistChildCancellationCleanup({',
        leaseReservationAt,
      );
      const failedLeaseCancelAt = cancellation.indexOf(
        'moduleRunQueue.cancelQueuedRunsForNode(',
        initialIntentAt,
      );
      const failedLeaseObserveAt = cancellation.indexOf(
        'cancellationLease = await cancellationLeasePromise;',
        failedLeaseCancelAt,
      );
      const leaseReleaseAt = cancellation.indexOf('cancellationLease?.release();', failedLeaseObserveAt);

      const alreadyRolledBackAt = cancellation.indexOf('if (control.rollbackApplied) {');
      const sharedRollbackAt = cancellation.indexOf('control.rollbackPromise,', alreadyRolledBackAt);
      const sharedRetryCallAt = cancellation.indexOf('control.cleanupArtifacts()', alreadyRolledBackAt);
      const performCleanupAt = cancellation.indexOf('const performCleanupArtifacts = async () => {');
      const cleanupFactoryAt = cancellation.indexOf('control.cleanupArtifacts = () => {', performCleanupAt);
      const reuseAt = cancellation.indexOf(
        'if (control.cleanupPromise) return control.cleanupPromise;',
        cleanupFactoryAt,
      );
      const createAttemptAt = cancellation.indexOf(
        'const cleanupAttempt = Promise.resolve().then(performCleanupArtifacts);',
        reuseAt,
      );
      const publishAttemptAt = cancellation.indexOf(
        'control.cleanupPromise = cleanupAttempt;',
        createAttemptAt,
      );
      const rejectedResetAt = cancellation.indexOf(
        'if (control.cleanupPromise === cleanupAttempt) control.cleanupPromise = null;',
        publishAttemptAt,
      );
      const firstSettlementAt = cancellation.indexOf(
        'const [rollbackResult, cleanupResult] = await Promise.allSettled([',
        rejectedResetAt,
      );
      const firstRollbackAt = cancellation.indexOf('control.rollbackPromise,', firstSettlementAt);
      const firstCleanupCallAt = cancellation.indexOf('control.cleanupArtifacts()', firstSettlementAt);
      const cleanupCallCount = cancellation.match(/control\.cleanupArtifacts\(\)/g)?.length || 0;

      assert(noControlAt >= 0 && leaseReservationAt > noControlAt
        && protectedTryAt > leaseReservationAt && initialIntentAt > protectedTryAt
        && failedLeaseCancelAt > initialIntentAt
        && failedLeaseObserveAt > failedLeaseCancelAt && leaseReleaseAt > failedLeaseObserveAt,
      'reload cancellation must reserve its safety lease before the first await, while protecting the initial durable-intent commit so every rejected path cancels/observes and releases that lease');
      assert(alreadyRolledBackAt >= 0 && sharedRollbackAt > alreadyRolledBackAt
        && sharedRetryCallAt > sharedRollbackAt
        && performCleanupAt > sharedRetryCallAt && cleanupFactoryAt > performCleanupAt
        && reuseAt > cleanupFactoryAt && createAttemptAt > reuseAt
        && publishAttemptAt > createAttemptAt && rejectedResetAt > publishAttemptAt
        && firstSettlementAt > rejectedResetAt && firstRollbackAt > firstSettlementAt
        && firstCleanupCallAt > firstRollbackAt
        && cleanupCallCount === 2,
      'the first caller and every concurrent cancellation surface must share one rollback and one memoized cleanup attempt; only rejection may clear that attempt for an explicit retry');
      return { sharedCleanupAttempt: true, rejectedAttemptRetryable: true, reloadLeaseReleased: true };
    },
  },
  {
    name: 'Job Board primary manual-AI retirement is attempted once until explicit Retry',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const autoStart = board.indexOf('useEffect(() => {\n    const resume = data.manualAiResume;');
      const autoEnd = board.indexOf('const handleRetryRecovery = useCallback', autoStart);
      const autoRecovery = board.slice(autoStart, autoEnd);
      const retirementAt = autoRecovery.indexOf('if (resume.retirementPending) {');
      const guardAt = autoRecovery.indexOf(
        'if (attemptedSupersededCleanupRunIdsRef.current.has(resume.runId)) return;',
        retirementAt,
      );
      const claimAt = autoRecovery.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.add(resume.runId);',
        guardAt,
      );
      const autoClaimAt = autoRecovery.indexOf(
        'autoResumedManualAiRunRef.current = resume.runId;',
        retirementAt,
      );
      const cleanupAt = autoRecovery.indexOf('void retireBoardCleanupReceipt(resume)', retirementAt);

      const retryStart = autoEnd;
      const retryEnd = board.indexOf('\n  const ', retryStart + 'const handleRetryRecovery'.length);
      const retry = board.slice(retryStart, retryEnd);
      const primaryRetryAt = retry.indexOf('if (liveData.manualAiResume?.retirementPending) {');
      const releaseAt = retry.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.delete(manualRunId);',
        primaryRetryAt,
      );
      const reclaimAt = retry.indexOf(
        'attemptedSupersededCleanupRunIdsRef.current.add(manualRunId);',
        releaseAt,
      );
      const retryCleanupAt = retry.indexOf(
        'void retireBoardCleanupReceipt(liveData.manualAiResume)',
        primaryRetryAt,
      );

      assert(autoStart >= 0 && autoEnd > autoStart && retirementAt >= 0
        && guardAt > retirementAt && claimAt > guardAt
        && autoClaimAt > claimAt && cleanupAt > autoClaimAt
        && primaryRetryAt >= 0 && releaseAt > primaryRetryAt
        && reclaimAt > releaseAt && retryCleanupAt > reclaimAt,
      'mount recovery must claim a primary retirement before cleanup, while explicit Retry must refresh and reclaim that exact id before invoking another attempt');
      return { automaticAttemptBounded: true, explicitRetryReclaims: true };
    },
  },
  {
    name: 'Job queue prioritizes paused-search continuations ahead of fresh Board requests without breaking FIFO classes',
    run: async () => {
      const queue = createModuleRunQueue();
      const starts = [];
      const positions = new Map();
      const callbacks = (nodeId) => ({
        onQueued: ({ position }) => positions.set(nodeId, position),
        onQueueUpdate: ({ position }) => positions.set(nodeId, position),
        onStart: () => starts.push(nodeId),
      });

      const active = await queue.acquireModuleRun({
        nodeId: 'active-board', lane: 'job-search', ...callbacks('active-board'),
      });
      const freshOnePromise = queue.acquireModuleRun({
        nodeId: 'fresh-board-1', lane: 'job-search', ...callbacks('fresh-board-1'),
      });
      const continuationOnePromise = queue.acquireModuleRun({
        nodeId: 'paused-search-1', lane: 'job-search', priority: 'continuation', ...callbacks('paused-search-1'),
      });
      const freshTwoPromise = queue.acquireModuleRun({
        nodeId: 'fresh-board-2', lane: 'job-search', ...callbacks('fresh-board-2'),
      });
      const continuationTwoPromise = queue.acquireModuleRun({
        nodeId: 'paused-search-2', lane: 'job-search', priority: 'continuation', ...callbacks('paused-search-2'),
      });

      const queuedOrder = queue.getSnapshot().lanes['job-search']?.queued.map(entry => entry.nodeId);
      assert(JSON.stringify(queuedOrder) === JSON.stringify([
        'paused-search-1', 'paused-search-2', 'fresh-board-1', 'fresh-board-2',
      ]),
      `continuations must overtake fresh work while remaining FIFO within both classes, got ${JSON.stringify(queuedOrder)}`);
      assert(positions.get('paused-search-1') === 1
        && positions.get('paused-search-2') === 2
        && positions.get('fresh-board-1') === 3
        && positions.get('fresh-board-2') === 4,
      `every queued UI marker must be renumbered after priority insertion, got ${JSON.stringify(Object.fromEntries(positions))}`);

      active.release();
      const continuationOne = await continuationOnePromise;
      continuationOne.release();
      const continuationTwo = await continuationTwoPromise;
      continuationTwo.release();
      const freshOne = await freshOnePromise;
      freshOne.release();
      const freshTwo = await freshTwoPromise;
      freshTwo.release();

      assert(JSON.stringify(starts) === JSON.stringify([
        'active-board', 'paused-search-1', 'paused-search-2', 'fresh-board-1', 'fresh-board-2',
      ]) && queue.getSnapshot().lanes['job-search'] == null,
      `the live lane must follow priority/FIFO order and fully drain, got ${JSON.stringify({ starts, snapshot: queue.getSnapshot() })}`);
      return { starts, finalPositions: Object.fromEntries(positions) };
    },
  },
  {
    name: 'Job Board owns the selected-search and combine queue transaction without nested leases',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const coordinator = readFileSync(new URL('../../src/contexts/JobSearchCoordinatorContext.jsx', import.meta.url), 'utf8');
      const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
      const selectionUi = readFileSync(new URL('../../src/nodes/jobboard/JobBoardSearchSelection.jsx', import.meta.url), 'utf8');

      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  useEffect(() => {', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      const combineStart = board.indexOf('const handleCombine = useCallback');
      const combineEnd = board.indexOf('const handleSearchSelected = useCallback', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      assert(scanStart >= 0 && scanEnd > scanStart,
        'the Board selected-search coordinator must have a bounded handler that this test can inspect');
      const connectedSigStart = board.indexOf('const connectedSig = useStore');
      const connectedSigEnd = board.indexOf('const boardRecoverySig = useStore', connectedSigStart);
      const connectedSig = board.slice(connectedSigStart, connectedSigEnd);
      const boardRecoverySigEnd = board.indexOf('const connectedModules = useMemo', connectedSigEnd);
      const boardRecoverySig = board.slice(connectedSigEnd, boardRecoverySigEnd);
      assert(connectedSig.includes('manualAiResumeTask: n.data?.manualAiResume?.task ||')
        && connectedSig.includes('manualAiRecoveryMode: n.data?.manualAiResume?.recoveryMode ||')
        && connectedSig.includes('manualAiRetirementPending: n.data?.manualAiResume?.retirementPending === true')
        && connectedSig.includes("pendingBatchId: n.data?.pendingBatch?.batchId || ''")
        && connectedSig.includes("pendingBatchJobRunId: n.data?.pendingBatch?.jobRunId || ''")
        && connectedSig.includes('cancellationPendingCleanupRunIds: normalizeManualAiCleanupReceipts(')
        && connectedSig.includes('.filter(receipt => receipt.cancellationPending === true)')
        && connectedSig.includes('canonicalLocation: n.data?.canonicalLocation ||'),
      'the reactive connected-Search key must wake readiness for same-run manual mode/cleanup transitions and legacy canonical-location changes');
      assert(boardRecoverySigEnd > connectedSigEnd
        && boardRecoverySig.includes('retirementPending: manual.retirementPending === true,'),
      'the global Board ownership key must wake a yielded shared-Search recovery when a standalone Combine becomes cleanup-only and stops reserving that Search');
      const readinessStart = board.indexOf('function moduleSearchReadiness');
      const readinessEnd = board.indexOf('\nfunction captureJobSearchRollback', readinessStart);
      const readiness = board.slice(readinessStart, readinessEnd);
      assert(readiness.includes('if (isJobWorkflowDeletionPending(node?.id))')
        && readiness.includes("statusLabel: 'Deletion pending'")
        && readiness.includes('legacyBatchRecovery = false,')
        && readiness.includes('const exactBoardLegacyBatchRecovery = isExactBoardLegacyBatchRecovery(')
        && readiness.includes('if (ACTIVE_SEARCH_STATES.has(hubState) && !exactBoardLegacyBatchRecovery)')
        && readiness.includes("statusLabel: 'Resume saved scoring'"),
      'a pending deletion must be non-runnable while the exact Board-owned legacy batch remains resumable inside the parent lane');
      const liveAdmissionAt = scan.indexOf('const liveBoardDataAtAdmission = getNode(id)?.data || data;');
      const liveLockGuardAt = scan.indexOf('|| liveBoardDataAtAdmission.locked', liveAdmissionAt);
      assert(liveAdmissionAt >= 0 && liveLockGuardAt > liveAdmissionAt
        && !scan.slice(liveAdmissionAt, liveLockGuardAt + 80).includes('|| data.locked'),
      'selected-search admission must read the Board lock from the live store so an invocation cannot start after a stale render was newly locked');

      const liveGraphAt = scan.indexOf('const liveNodes = getNodes();');
      const selectionAt = scan.indexOf('getSelectedConnectedJobSearchIds(liveBoardData.selectedSearchModuleIds, connectedIds)');
      const leaseAt = scan.indexOf('await moduleRunQueue.acquireModuleRun', selectionAt);
      const postLeaseLockAt = scan.indexOf('if (getNode(id)?.data?.locked) {', leaseAt);
      const loopAt = scan.indexOf('for (const sourceId of selectedIds)');
      const executionConnectionAt = scan.indexOf('const stillConnected = getEdges().some', loopAt);
      const turnReadinessAt = scan.indexOf('const turnReadiness = moduleSearchReadiness(sourceNode, verifyingPlatformsRef.current', executionConnectionAt);
      const rollbackPersistAt = scan.indexOf('persistScanResume({ activeSourceId: sourceId, activeSourceRollback });', turnReadinessAt);
      const childPlanCommitAt = scan.indexOf('const childPlanCommitted = await waitForBoardPlanCommit({', rollbackPersistAt);
      const childCancellationAt = scan.indexOf('const childCancelled = () => cancelled() || !getEdges().some', executionConnectionAt);
      const invokeAt = scan.indexOf('await jobSearchCoordinator.runSearchModule(sourceId', childCancellationAt);
      const completionGateAt = scan.indexOf("if (result?.status !== 'completed')", invokeAt);
      const combinePlanCommitAt = scan.indexOf('const combinePlanCommitted = await waitForBoardPlanCommit({', completionGateAt);
      const combineAt = scan.indexOf('const combineOutcome = await handleCombine({', completionGateAt);
      const releaseAt = scan.indexOf('lease?.release();', combineAt);
      assert(liveGraphAt >= 0 && selectionAt > liveGraphAt && leaseAt > selectionAt
        && postLeaseLockAt > leaseAt && loopAt > postLeaseLockAt
        && executionConnectionAt > loopAt && turnReadinessAt > executionConnectionAt
        && rollbackPersistAt > turnReadinessAt && childPlanCommitAt > rollbackPersistAt
        && childCancellationAt > childPlanCommitAt
        && invokeAt > childCancellationAt && completionGateAt > invokeAt
        && combinePlanCommitAt > completionGateAt && combineAt > combinePlanCommitAt && releaseAt > combineAt,
      'the Board must durably commit its admission and per-child rollback receipts, acquire one transaction lease, revalidate live readiness/connections, await selected modules serially, commit the exact Combine plan, and release only afterward');
      assert(scan.slice(postLeaseLockAt, loopAt).includes('autoResumedBoardScanRef.current = null;')
        && scan.slice(postLeaseLockAt, loopAt).includes('scan deferred because Board was locked at its lane turn'),
      'a Board locked while queued must yield before touching children and unlatch its durable recovery plan for an unlock retry');
      const scanRecoveryStart = board.indexOf('// A Board-owned child can survive an app restart');
      const scanRecoveryEnd = board.indexOf("document.addEventListener('non-api-ai-node-cancelled'", scanRecoveryStart);
      const scanRecovery = board.slice(scanRecoveryStart, scanRecoveryEnd);
      assert(scanRecovery.includes('const sourceRecoveryOwner = sourceData.manualAiResume?.runId')
        && scanRecovery.includes('const exactBoardLegacyBatchRecovery = isExactBoardLegacyBatchRecovery(')
        && scanRecovery.includes('ACTIVE_SEARCH_STATES.has(sourceData.hubState) && !exactBoardLegacyBatchRecovery')
        && scanRecovery.includes('connectedSig, data.boardCancellation'),
      'reload recovery must wake on child state changes and let only the exact plan owner retire a legacy scoring batch inside its reacquired Board lane');
      assert(scan.includes('legacyBatchRecovery: !!resumePlan')
        && scan.includes('&& resumePlan.activeSourceId === sourceId,'),
      'a fresh Board that merely reserves a selected Search must not adopt that Search\'s preexisting legacy batch as though it were the interrupted active child');
      assert(scan.includes('const boardRunId = resumePlan?.boardRunId || `job-board-scan:${id}:${entropy}`')
        && scan.includes('const admissionPlanCommitted = await waitForBoardPlanCommit({')
        && scan.includes('The Job Board scan recovery plan was not committed before queue admission.')
        && scan.includes('nodeId: id,')
        && scan.includes('cancellationNodeIds: transactionSelectedIds')
        && scan.includes("kind: 'job-board-search'")
        && scan.includes("lane: 'job-search'")
        && scan.includes('orchestratorNodeId: id,')
        && scan.includes('boardRunId,')
        && scan.includes('isCancelled: childCancelled,')
        && scan.includes('queueManagedByScan: true,')
        && scan.includes('expectedCombineSourceRuns: combineSourceRuns,')
        && scan.includes('The Job Board combine recovery plan was not committed before processing started.')
        && scan.indexOf('await moduleRunQueue.acquireModuleRun', leaseAt + 1) === -1,
      'the whole scan must be Board-owned in the shared lane, cancellable by either owner, correlated by an exact durable Board run id, and use no per-child lease');
      assert(scan.includes('scanRunRef.current')
        && scan.includes('stillConnected')
        && scan.includes('remainsConnected')
        && scan.includes('const incompleteSearches = Array.isArray(resumePlan?.incompleteSearches)')
        && scan.includes('scan module incomplete; continuing')
        && scan.includes('if (incompleteSearches.length > 0)')
        && scan.includes('then use Combine saved.')
        && scan.includes('const completedOutcomes = new Map(Object.entries(resumePlan?.completedSourceRuns || {}))')
        && scan.includes('const supersededSourceId = [...completedOutcomes.keys()].find')
        && scan.includes('(source.data?.jobRunId || null) !== expected.runId')
        && scan.includes('(source.data?.resultDisposition || null) !== expected.resultDisposition'),
      'duplicate admission and disconnects must be guarded, an attention-paused child must not starve later searches, and exact child outcomes must still match before auto-combine');
      assert(combineStart >= 0 && combineEnd > combineStart
        && combine.includes('const liveBoardDataAtAdmission = getNode(id)?.data || {};')
        && combine.includes('|| liveBoardDataAtAdmission.locked')
        && combine.includes('const queueManagedByScan = afterSearch')
        && combine.includes('if (!queueManagedByScan) {')
        && combine.includes('combine continuing inside scan queue turn'),
      'the final Combine must reject a live locked Board, reuse the active scan transaction, and let standalone Combine acquire its own lane turn');
      const recoveredTokenAt = combine.indexOf('const claimedManualAiRunId = createManualAiRunId(id);');
      const recoveredTokenClaimGuardAt = combine.indexOf('combineRecoveryTokenClaimRef.current = recoveryTokenClaim;');
      const recoveredTokenUpdateAt = combine.indexOf('updateGlobal(id, (node) => {', recoveredTokenAt);
      const recoveredTokenCommitAt = combine.indexOf('const recoveryTokenCommitted = await waitForBoardPlanCommit({', recoveredTokenUpdateAt);
      const activeCombineTokenAt = combine.indexOf("const combineToken = Symbol('job-board-combine');");
      const firstProviderAt = combine.indexOf('window.electronAPI.bucketJobs', activeCombineTokenAt);
      assert(recoveredTokenAt >= 0
        && recoveredTokenUpdateAt > recoveredTokenAt
        && recoveredTokenCommitAt > recoveredTokenUpdateAt
        && activeCombineTokenAt > recoveredTokenCommitAt
        && firstProviderAt > activeCombineTokenAt
        && combine.includes('if (combineRunRef.current || combineRecoveryTokenClaimRef.current)')
        && recoveredTokenClaimGuardAt >= 0
        && recoveredTokenClaimGuardAt < recoveredTokenAt
        && combine.includes('const durableManualAiRunId = recoveryPlanAtClaim.combineManualAiRunId || null;')
        && combine.includes('manualAiRunId = durableManualAiRunId;')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes("currentPlan.phase !== 'combine'")
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.boardRunId !== expectedBoardRunId')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.combineManualAiRunId')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('currentPlan.updatedAt !== recoveryPlanAtClaim.updatedAt')
        && combine.slice(recoveredTokenUpdateAt, recoveredTokenCommitAt).includes('combineManualAiRunId: claimedManualAiRunId')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('if (!recoveryTokenCommitted)')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('cancellationInFlightRef.current || liveDataAfterClaim.boardCancellation')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('liveDataAfterClaim.boardCancellation')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('liveDataAfterClaim.locked')
        && combine.slice(recoveredTokenCommitAt, activeCombineTokenAt).includes('combineRecoveryTokenClaimRef.current = null;'),
      'a recovered phase=combine receipt must adopt an already durable token, or exclusively claim, atomically install, and visibly verify one fresh token before it starts an in-memory Combine or any provider work');
      const scanQueueMarkerClearAt = scan.indexOf('updateGlobal(id, { queuedModuleRun: null });', leaseAt);
      const scanDeletionStartGuardAt = scan.indexOf('isJobWorkflowDeletionPending(id)', scanQueueMarkerClearAt);
      const combineLeaseAt = combine.indexOf('await moduleRunQueue.acquireModuleRun');
      const combineQueueMarkerClearAt = combine.indexOf('updateGlobal(id, { queuedModuleRun: null });', combineLeaseAt);
      const combineDeletionStartGuardAt = combine.indexOf('cancelled() || isJobWorkflowDeletionPending(id)', combineQueueMarkerClearAt);
      assert(scanQueueMarkerClearAt > leaseAt && scanDeletionStartGuardAt > scanQueueMarkerClearAt
        && scan.includes('transactionSelectedIds.some(sourceId => isJobWorkflowDeletionPending(sourceId))')
        && combineLeaseAt >= 0 && combineQueueMarkerClearAt > combineLeaseAt
        && combineDeletionStartGuardAt > combineQueueMarkerClearAt
        && combine.includes('inputsAtCombine.all.some(module => isJobWorkflowDeletionPending(module.id))')
        && combine.includes('const boardDeletionPending = isJobWorkflowDeletionPending(id);')
        && combine.includes('liveStateBeforeCommit.all.some(module => isJobWorkflowDeletionPending(module.id))')
        && combine.includes('await completeManualAiRun(manualAiRunId);'),
      'queued Boards must clear their queue marker and reject pending Board/selected-Search deletion at lane start, while Combine rejects connected Search deletion before provider work and durably retires its manual handoff before any Board/Search deletion can cross commit');
      assert(scan.includes("if (result?.status === 'cancelled')")
        && scan.includes('scan yielding after child deletion cancellation')
        && scan.includes('scan yielding after child deletion error')
        && scan.includes('scan yielding before combine while deletion is pending'),
      'a child cancellation caused by reversible deletion must retain the exact parent plan and never masquerade as a user cancellation or continue into Combine');
      assert(scan.includes("combineOutcome?.status === 'busy'")
        && scan.includes("combineOutcome?.status === 'not-ready'")
        && scan.includes("combineOutcome?.status === 'cancelled'")
        && scan.includes("combineOutcome?.status === 'superseded'")
        && scan.includes("combineOutcome?.status !== 'completed'")
        && scan.includes('scan combine deferred')
        && scan.includes('scan combine superseded')
        && scan.includes('autoResumedBoardScanRef.current = null;')
        && scan.includes('autoResumedManualAiRunRef.current = null;')
        && scan.includes("node?.data?.boardScanResume?.boardRunId === boardRunId"),
      'the parent scan must retain its exact Combine receipt for transient/cancelled outcomes, retire a superseded receipt without claiming success, and only log completion for an exact completed result');
      const settleStart = board.indexOf('const settleRecoveredCombine = useCallback');
      const settleEnd = board.indexOf('const handleCombineSaved = useCallback', settleStart);
      const settle = board.slice(settleStart, settleEnd);
      assert(settle.includes("outcome?.status === 'busy'")
        && settle.includes("outcome?.status === 'not-ready'")
        && settle.includes("outcome?.status === 'cancelled'")
        && settle.includes('autoResumedBoardScanRef.current = null;')
        && settle.includes('autoResumedManualAiRunRef.current = null;')
        && settle.includes('return false;'),
      'a queued/provider-time lock or other nonterminal recovered Combine outcome must release both one-shot recovery latches so the unchanged exact receipt can retry after the blocker changes');
      const recoveryEffectStart = board.indexOf('// A Board-owned child can survive an app restart');
      const recoveryEffectEnd = board.indexOf('const onManualAiNodeCancelled', recoveryEffectStart);
      const recoveryEffect = board.slice(recoveryEffectStart, recoveryEffectEnd);
      const manualRecoveryStart = board.indexOf('const resume = data.manualAiResume;', recoveryEffectEnd);
      const manualRecoveryEnd = board.indexOf('const handleRetryRecovery', manualRecoveryStart);
      const manualRecovery = board.slice(manualRecoveryStart, manualRecoveryEnd);
      assert(board.includes('function boardRecoveryTouchesPendingDeletion(')
        && recoveryEffect.includes('boardRecoveryTouchesPendingDeletion(id, plan, data.manualAiResume)')
        && recoveryEffect.includes('autoResumedBoardScanRef.current = null;')
        && recoveryEffect.includes('deletionLifecycleRevision')
        && manualRecovery.includes('boardRecoveryTouchesPendingDeletion(id, data.boardScanResume, resume)')
        && manualRecovery.includes('autoResumedManualAiRunRef.current = null;'),
      'Board scan/manual recovery must yield without consuming its one-shot latch while the Board or any exact input is pending reversible deletion, then wake on lifecycle settlement');
      const retryRecoveryStart = board.indexOf('const handleRetryRecovery = useCallback');
      const retryRecoveryEnd = board.indexOf('const durableRecoveryActive', retryRecoveryStart);
      const retryRecovery = board.slice(retryRecoveryStart, retryRecoveryEnd);
      assert(recoveryEffect.includes('expectedBoardRunId: plan.boardRunId,')
        && recoveryEffect.includes("plan.combineManualAiRunId || 'unclaimed'")
        && retryRecovery.includes('expectedBoardRunId: plan.boardRunId,'),
      'automatic and explicit phase=combine recovery must bind a newly claimed manual-AI token to the exact durable Board run and wake when that durable claim changes');

      const pipelineStart = search.indexOf('const runPipeline = useCallback');
      const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const childRunnerStart = search.indexOf('const runForJobBoard = useCallback');
      const childRunnerEnd = search.indexOf('// Re-score the currently displayed listings', childRunnerStart);
      const childRunner = search.slice(childRunnerStart, childRunnerEnd);
      const childCancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const childCancel = search.slice(childCancelStart, childRunnerStart);
      const activeChildCancelStart = childCancel.indexOf('control.cancelled = true;');
      const activeChildCancel = childCancel.slice(activeChildCancelStart);
      const activeAcknowledgementAt = activeChildCancel.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);',
      );
      const activeDiscoveryAt = activeChildCancel.indexOf(
        'for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])',
        activeAcknowledgementAt,
      );
      const activeSettlementAt = activeChildCancel.indexOf(
        'await settleManualAiRetirement({',
        activeDiscoveryAt,
      );
      const activeParentFenceAt = activeChildCancel.indexOf(
        'beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({',
        activeSettlementAt,
      );
      assert(pipelineStart >= 0 && pipelineEnd > pipelineStart
        && pipeline.includes('if (!queueManagedByBoard) {\n        lease = await moduleRunQueue.acquireModuleRun')
        && pipeline.includes("if (!orchestratorNodeId) throw new Error('A board-managed search requires an orchestrator node id.')")
        && childRunnerStart >= 0 && childRunnerEnd > childRunnerStart
        && childRunner.includes('queueManagedByBoard: true')
        && childRunner.includes("runOrigin: effectiveManualAiResume ? 'job-board-recovery' : 'job-board-scan'")
        && childRunner.includes('parentCancelled: cancelled')
        && childRunner.includes('jobSearchCoordinator.registerSearchModule(id, runForJobBoard, cancelBoardRun)'),
      'a Board-invoked child must bypass only its top-level lane acquisition while retaining exact orchestration identity and parent cancellation; otherwise it deadlocks behind the Board lease');

      const outcomeDeclarationAt = childRunner.indexOf('let outcome;');
      const savedRecoveryAt = childRunner.indexOf('if (isSavedScrapeManualAiResume(effectiveManualAiResume))', outcomeDeclarationAt);
      const savedRecoveryInvokeAt = childRunner.indexOf('outcome = await resumeSavedScrapeRef.current?.({', savedRecoveryAt);
      const interruptedRecoveryAt = childRunner.indexOf('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun)', savedRecoveryInvokeAt);
      const interruptedRecoveryInvokeAt = childRunner.indexOf('outcome = await resumeInterruptedRunRef.current?.({', interruptedRecoveryAt);
      const missingLedgerFallbackAt = childRunner.indexOf("if (outcome?.status === 'not-found')", interruptedRecoveryInvokeAt);
      const freshRunAt = childRunner.indexOf('} else {\n        outcome = await handleRerun({', missingLedgerFallbackAt);
      const terminalGateAt = childRunner.indexOf("if (!outcome || outcome.status !== 'completed')", freshRunAt);
      const committedWaitAt = childRunner.indexOf('const committed = await waitForCommittedSearchOutcome({', terminalGateAt);
      assert(childRunner.includes('const manualAiRunId = effectiveManualAiResume?.runId || createManualAiRunId(id);')
        && outcomeDeclarationAt >= 0 && savedRecoveryAt > outcomeDeclarationAt
        && savedRecoveryInvokeAt > savedRecoveryAt && interruptedRecoveryAt > savedRecoveryInvokeAt
        && interruptedRecoveryInvokeAt > interruptedRecoveryAt
        && missingLedgerFallbackAt > interruptedRecoveryInvokeAt && freshRunAt > missingLedgerFallbackAt
        && terminalGateAt > freshRunAt && committedWaitAt > terminalGateAt
        && childRunner.includes("runOrigin: 'job-board-recovery'")
        && childRunner.includes('outcome,')
        && !childRunner.includes('const liveAfter = getNode'),
      'the child runner must distinguish saved-manual, interrupted-ledger (with safe not-found fallback), and fresh execution, then wait until the exact terminal run/disposition is committed before the Board snapshots live inputs');
      assert(childCancelStart >= 0
        && childCancel.includes('control.orchestratorNodeId !== orchestratorNodeId')
        && childCancel.includes('control.boardRunId !== boardRunId')
        && childCancel.includes('control.cancelled = true;')
        && childCancel.includes('epoch.bump();')
        && childCancel.includes('processingRunsRef.current.cancel();')
        && childCancel.includes('boardRunRollbackPatch(control.previousData)')
        && childCancel.includes('cancelNodeTaskAndWait(id, reason)')
        && childCancel.includes('acknowledgement?.settled !== true')
        && activeChildCancelStart >= 0
        && activeChildCancel.includes('const controlManualAiRunIds = control.manualAiRunIds instanceof Set')
        && activeChildCancel.includes(': new Set([control.manualAiRunId].filter(Boolean));')
        && activeChildCancel.includes('manualAiRunIds: [...controlManualAiRunIds],')
        && activeAcknowledgementAt >= 0 && activeDiscoveryAt > activeAcknowledgementAt
        && activeSettlementAt > activeDiscoveryAt && activeParentFenceAt > activeSettlementAt
        && activeChildCancel.includes('manualAiRunIds: acknowledgedIds,')
        && activeChildCancel.includes('acknowledgedRunIds: [...controlManualAiRunIds],')
        && !activeChildCancel.includes('await retireManualAiRunDurably(control.manualAiRunId)')
        && childCancel.includes('liveRunId !== priorRunId')
        && childCancel.includes('pendingBatchRunId !== priorRunId')
        && childCancel.includes('cancelQueuedRunsForNode(\n            cancellationLeaseOwnerId,')
        && !childCancel.includes('cancelQueuedRunsForNode(id'),
      'child cancellation must verify exact Board ownership, invalidate late continuations, restore the pre-run snapshot, durably fan out every acknowledged manual-AI id through both Search and Board receipts before retirement, clean only the abandoned run artifacts, and leave other Boards’ queued turns intact');

      assert(coordinator.includes('const registrationsRef = useRef(new Map());')
        && coordinator.includes('const registration = { runner, canceller };')
        && coordinator.includes('registrationsRef.current.get(nodeId) === registration')
        && coordinator.includes("error.code = 'JOB_SEARCH_MODULE_UNAVAILABLE'")
        && coordinator.includes('return Promise.resolve().then(() => registration.runner(options));')
        && coordinator.includes('const cancelSearchModule = useCallback')
        && coordinator.includes('try {\n      return Promise.resolve(registration.canceller(options));')
        && coordinator.includes('return Promise.reject(error);'),
      'the coordinator registry must normalize runner settlement, start exact cancellation authorization synchronously, normalize cancellation throws, reject unavailable modules, and prevent stale effect cleanup from deleting a newer registration');
      assert(app.includes('<ModuleRunQueueProvider>')
        && app.includes('<JobSearchCoordinatorProvider>')
        && app.indexOf('<ModuleRunQueueProvider>') < app.indexOf('<JobSearchCoordinatorProvider>'),
      'the app must provide one canvas-wide search registry inside the shared module queue boundary');
      assert(board.includes('<JobBoardSearchSelection')
        && board.includes('selectedIds={selectedSearchModuleIds}')
        && board.includes('onRun={handleSearchSelected}')
        && board.includes('onCancel={handleCancelRun}')
        && board.includes('Selection controls which searches refresh. The board combines all completed connected results.')
        && selectionUi.includes('<input\n                  type="checkbox"')
        && selectionUi.includes('Search selected & combine')
        && selectionUi.includes("running ? 'Cancel current run'"),
      'the Board must expose controlled per-connection selection, a live cancellation action, and clear refresh-vs-combine scope');

      const userCancelStart = board.indexOf('const handleCancelRun = useCallback');
      const userCancelEnd = board.indexOf('const handleCombine = useCallback', userCancelStart);
      const userCancel = board.slice(userCancelStart, userCancelEnd);
      assert(userCancelStart >= 0 && userCancelEnd > userCancelStart
        && userCancel.includes('const cancellationIntentPromise = persistBoardCancellationIntent(reason);')
        && userCancel.includes('epoch.bump();')
        && userCancel.includes('const childCancellation = cancelActiveSearchModule(reason, { allowStale: true });')
        && userCancel.includes('const boardCancellation = cancelBoardTaskAndRetireManualAi(reason);')
        && userCancel.includes('await Promise.all([childCancellation, boardCancellation]);')
        && userCancel.includes("moduleRunQueue.cancelQueuedRunsForNode(id, 'Job Board run cancelled')")
        && userCancel.includes('node?.data?.boardCancellation?.operationId !== cancellationIntent.operationId')
        && userCancel.includes('boardCancellation: null,')
        && userCancel.includes('...(planOwned ? { boardScanResume: null } : {})')
        && !userCancel.includes('clearBoardChildren()'),
      'Cancel current run must first persist exact cancellation authority, then stop queued, child, and Board work, and retire only matching recovery receipts while preserving the existing result cascade');
      assert(board.includes('const activeCombineManualAiRunRef = useRef(null);')
        && board.includes('activeCombineManualAiRunRef.current = {')
        && board.includes('token: combineToken,')
        && board.includes('runId: manualAiRunId,')
        && board.includes('startedAt: combineStartedAt,')
        && board.includes('activeCombineManualAiRunRef.current?.token === combineToken')
        && board.includes('const retireActiveCombineManualAiRun = useCallback')
        && board.includes('const runIds = expectedRunId')
        && board.includes(': new Set([active?.runId, persistedRunId].filter(Boolean));')
        && board.includes('const retireBoardCleanupReceipt = useCallback')
        && board.includes('if (receipt.cancellationPending === true)')
        && board.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(')
        && board.includes('for (const runId of acknowledgement?.manualAiRunIds || [])')
        && board.includes('const persistAcknowledgedBoardManualAiRunIds = useCallback')
        && board.includes('manualAiRunIds: [...new Set([')
        && board.includes('const allCommitted = runIds.every(runId => (')
        && board.includes("throw new Error('The acknowledged Job Board manual-AI cleanup receipts were not committed.')"),
      'Board cancellation must synchronously retain and token-scope every known or acknowledgement-discovered manual-AI run id, and verify its durable cleanup receipt before retirement');

      const cleanupStart = board.indexOf('const cleanupBoard = useCallback');
      const cleanupEnd = board.indexOf('useUnmountEffect(cleanupBoard)', cleanupStart);
      const clearStart = board.indexOf('const handleClear = useCallback');
      const clearEnd = board.indexOf('const completeManualAiRun', clearStart);
      const cancelStart = board.indexOf('const cancelActiveSearchModule = useCallback');
      const cancelEnd = board.indexOf('const cleanupBoard = useCallback', cancelStart);
      const cancelActive = board.slice(cancelStart, cancelEnd);
      assert(cancelStart >= 0
        && cancelActive.includes('const liveBoardData = getNode(id)?.data || data;')
        && cancelActive.includes('const durablePlan = liveBoardData.boardScanResume || data.boardScanResume;')
        && cancelActive.includes('const durableCancellation = liveBoardData.boardCancellation || data.boardCancellation || null;')
        && cancelActive.includes("|| (durablePlan?.phase === 'searches' ? durablePlan.activeSourceId : null)")
        && cancelActive.includes('|| durableCancellation?.sourceId')
        && cancelActive.includes('|| durableCancellation?.boardRunId')
        && cancelActive.includes('jobSearchCoordinator.cancelSearchModule(sourceId')
        && cancelActive.includes('orchestratorNodeId: id,')
        && cancelActive.includes('boardRunId,')
        && cancelActive.includes('queueManagedExternally: !!scanLaneLeaseOwnerRef.current')
        && cancelActive.includes('durablePlanOverride: durablePlan ||')
        && cancelActive.includes("error?.code === 'JOB_SEARCH_MODULE_UNAVAILABLE' && !sourceExistsAnywhere")
        && cancelActive.includes('cancelNodeTaskAndWait(sourceId, reason)'),
      'Board cancellation must address the active child through the coordinator with the exact Board run identity, falling back to the durable recovery plan after reload');
      for (const section of [board.slice(cleanupStart, cleanupEnd), board.slice(clearStart, clearEnd)]) {
        assert(section.includes('cancelActiveSearchModule(')
          && section.includes('moduleRunQueue.cancelQueuedRunsForNode(id'),
        'Clear and unmount must remove the Board queue entry and roll back only the source module whose Board-owned turn is active');
      }
      return { selection: 'live allow-list', queueOwner: 'jobboard', nestedLeaseBypassed: true };
    },
  },
  {
    name: 'Job Search preserves Board ownership across queue, cancellation, and source-card rollback races',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const sourceCard = readFileSync(new URL('../../src/nodes/JobSourceCardNode.jsx', import.meta.url), 'utf8');
      const dialog = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      const resetStart = search.indexOf('const resetHandler = useCallback');
      const resetEnd = search.indexOf('// Non-API scoring is controlled', resetStart);
      const reset = search.slice(resetStart, resetEnd);
      const exactRouteStart = search.indexOf('const cancelActiveBoardChild = useCallback');
      const exactRoute = search.slice(exactRouteStart, resetStart);
      const ownedQueueCancelAt = reset.indexOf('moduleRunQueue.cancelQueuedRunsOwnedByNode(id)');
      const durableOwnerAt = reset.indexOf('let durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(');
      const durableParentCancelAt = reset.indexOf('jobSearchCoordinator.cancelBoardModule(', durableOwnerAt);
      const lockGuardAt = reset.indexOf('if (getNode(id)?.data?.locked ?? data.locked)');
      assert(exactRouteStart >= 0
        && exactRoute.includes('const control = boardRunControlRef.current;')
        && exactRoute.includes('orchestratorNodeId: control.orchestratorNodeId')
        && exactRoute.includes('boardRunId: control.boardRunId')
        && reset.indexOf("cancelActiveBoardChild('board-child-cancelled')") >= 0
        && reset.indexOf("cancelActiveBoardChild('board-child-cancelled')") < lockGuardAt
        && durableOwnerAt > reset.indexOf("cancelActiveBoardChild('board-child-cancelled')")
        && durableParentCancelAt > durableOwnerAt
        && ownedQueueCancelAt < durableParentCancelAt
        && reset.indexOf('while (durableBoardOwner)') > durableOwnerAt
        && reset.includes('const cancelledQueuedBoardOwners = new Set();')
        && reset.includes('await waitForRendererCommitFrame();')
        && reset.indexOf('durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(', durableParentCancelAt) > durableParentCancelAt
        && reset.includes('cancelledQueuedBoardOwners.has(durableOwnerKey)')
        && reset.includes('boardRunId: durableBoardOwner.boardRunId')
        && lockGuardAt > durableParentCancelAt
        && ownedQueueCancelAt > reset.indexOf('epoch.bump();')
        && reset.indexOf('processingRunsRef.current.cancel();') < durableParentCancelAt
        && reset.includes('const resetData = getNode(id)?.data || data;')
        && !reset.includes('moduleRunQueue.cancelQueuedRunsForNode(id)'),
      'the Search cancel button must route mounted and every durable A+B queued owner through exact Board identities, then cancel only Search-owned queued work so no uncancelled Board alias races the reset');

      const manualCancelStart = search.indexOf('const onManualAiNodeCancelled = (event) =>');
      const manualCancelEnd = search.indexOf("document.addEventListener('non-api-ai-node-cancelled'", manualCancelStart);
      const manualCancel = search.slice(manualCancelStart, manualCancelEnd);
      const unscopedCancelGuardAt = manualCancel.indexOf('if (!detail.runId)');
      const genericManualResetAt = manualCancel.indexOf('resetHandler()');
      assert(manualCancelStart >= 0
        && manualCancel.includes('cancelledBoardManualAiRunIdsRef.current.has(detail.runId)')
        && unscopedCancelGuardAt >= 0
        && genericManualResetAt > unscopedCancelGuardAt
        && manualCancel.slice(unscopedCancelGuardAt, genericManualResetAt).includes('return;')
        && dialog.includes('const cancelledRunId = activeRequest?.runId || null;')
        && dialog.includes('detail: { nodeId: cancelledNodeId, runId: cancelledRunId }'),
      'manual-AI cancellation must carry and correlate the exact run id, and an unscoped legacy event must fail closed before generic Reset so it cannot erase a newer Search or Board run');

      const pipelineStart = search.indexOf('const runPipeline = useCallback');
      const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
      const pipeline = search.slice(pipelineStart, pipelineEnd);
      const acquireAt = pipeline.indexOf('lease = await moduleRunQueue.acquireModuleRun');
      const ownershipAt = pipeline.indexOf('isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())', acquireAt);
      const refusalAt = pipeline.indexOf('if (standaloneBecameBoardManaged)', ownershipAt);
      const queueMarkerClearAt = pipeline.indexOf('updateGlobal(currentId, { queuedModuleRun: null });', refusalAt);
      const refusalReturnAt = pipeline.indexOf("return searchRunOutcome('not-ready'", queueMarkerClearAt);
      const processingStartAt = pipeline.indexOf('processingToken = processingRunsRef.current.start();', refusalReturnAt);
      const destructiveSetupAt = pipeline.indexOf('scrapeWarningsRef.current = [];', processingStartAt);
      const refusalBlock = pipeline.slice(refusalAt, processingStartAt);
      assert(acquireAt >= 0 && ownershipAt > acquireAt && refusalAt > ownershipAt
        && queueMarkerClearAt > refusalAt && refusalReturnAt > queueMarkerClearAt
        && processingStartAt > refusalReturnAt && destructiveSetupAt > processingStartAt
        && !pipeline.includes('restoreStandaloneQueueSnapshot')
        && !refusalBlock.includes('scoredJobs:') && !refusalBlock.includes('hubState:')
        && pipeline.indexOf('lease?.release();', destructiveSetupAt) > destructiveSetupAt,
      'a standalone Search that becomes Board-connected while queued must clear only its queue marker, preserve every live edit/result, refuse before processing or destructive setup, and still release its lane');

      const interruptedResumeStart = search.indexOf('const handleResumeRun = useCallback');
      const interruptedResumeEnd = search.indexOf('resumeInterruptedRunRef.current = handleResumeRun;', interruptedResumeStart);
      const interruptedResume = search.slice(interruptedResumeStart, interruptedResumeEnd);
      const savedResumeStart = search.indexOf('const handleResumeSavedScrape = useCallback');
      const savedResumeEnd = search.indexOf('resumeSavedScrapeRef.current = handleResumeSavedScrape;', savedResumeStart);
      const savedResume = search.slice(savedResumeStart, savedResumeEnd);
      assert((pipeline.match(/findJobSearchBoardActiveRecoveryOwner\(currentId, getNodes\(\), getEdges\(\)\)/g) || []).length >= 2
        && pipeline.indexOf('findJobSearchBoardActiveRecoveryOwner(\n        id,', pipeline.indexOf('const runPipeline'))
          < pipeline.indexOf('const liveData = getNode(id)?.data || data;')
        && (interruptedResume.match(/findJobSearchBoardActiveRecoveryOwner\(/g) || []).length >= 4
        && interruptedResume.includes('This interrupted Search was reserved by its Job Board while queued.')
        && (savedResume.match(/findJobSearchBoardActiveRecoveryOwner\(/g) || []).length >= 3
        && savedResume.includes('const activeBoardOwner = findJobSearchBoardActiveRecoveryOwner(')
        && savedResume.indexOf('findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())')
          < savedResume.indexOf('const admissionData = getNode(id)?.data || data;'),
      'fresh, interrupted-ledger, and saved-scrape direct entrypoints must honor disconnected durable Board reservations before admission and re-elect ownership after their queued lane turn');

      const deletionPendingStartChecks = search.match(
        /isJobWorkflowDeletionPending\((?:currentId|id)\)\) throw new Error\('Node deleted'\);/g,
      ) || [];
      const laneCommitBarriers = search.match(/if \(lease\) await waitForRendererCommitFrame\(\);/g) || [];
      assert(deletionPendingStartChecks.length >= 9
        && laneCommitBarriers.length >= 8
        && search.includes('if (emptyContinuationLease) await waitForRendererCommitFrame();')
        && pipeline.includes("node?.data?.queuedModuleRun?.label === 'Job search'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Resuming job search'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Re-evaluating saved jobs'")
        && search.includes("node?.data?.queuedModuleRun?.label === 'Resuming saved job search'")
        && sourceCard.includes('!hubNode || isJobWorkflowDeletionPending(data.hubId) || hubData.locked'),
      'every queued Job Search lane entrypoint and Source Solve must recheck a pending deletion at lease start, then retire only its own queue marker if an OS confirmation aborts the start');

      const continuationStart = search.indexOf('const resumeScoring = useCallback');
      const continuationEnd = search.indexOf('resumeScoringRef.current = resumeScoring;', continuationStart);
      const continuation = search.slice(continuationStart, continuationEnd);
      const continuationAdmissionAt = continuation.indexOf(
        'const boardConnectedAtContinuationAdmission = !queueManagedExternally',
      );
      const emptyFenceAt = continuation.indexOf(
        '!boardConnectedAtContinuationAdmission\n                && isJobSearchConnectedToBoard(id, getNodes(), getEdges())',
        continuationAdmissionAt,
      );
      const emptyRefusalAt = continuation.indexOf(
        'if (standaloneEmptyContinuationClaimedByBoard)',
        emptyFenceAt,
      );
      const emptySnapshotAt = continuation.indexOf(
        'await window.electronAPI?.saveJobAnalysisSnapshot?.({',
        emptyRefusalAt,
      );
      const scoringFenceAt = continuation.indexOf(
        '!boardConnectedAtContinuationAdmission\n              && isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())',
        emptySnapshotAt,
      );
      const scoringRefusalAt = continuation.indexOf(
        'if (standaloneContinuationClaimedByBoard)',
        scoringFenceAt,
      );
      const continuationProcessingAt = continuation.indexOf(
        'processingToken = processingRunsRef.current.start();',
        scoringRefusalAt,
      );
      const emptyRefusalBlock = continuation.slice(emptyRefusalAt, emptySnapshotAt);
      const scoringRefusalBlock = continuation.slice(scoringRefusalAt, continuationProcessingAt);
      assert(continuationStart >= 0 && continuationEnd > continuationStart
        && continuationAdmissionAt >= 0
        && emptyFenceAt > continuationAdmissionAt
        && emptyRefusalAt > emptyFenceAt && emptySnapshotAt > emptyRefusalAt
        && scoringFenceAt > emptySnapshotAt
        && scoringRefusalAt > scoringFenceAt
        && continuationProcessingAt > scoringRefusalAt
        && !emptyRefusalBlock.includes('pendingJobs:')
        && !emptyRefusalBlock.includes("hubState: 'done'")
        && !scoringRefusalBlock.includes('pendingJobs:')
        && !scoringRefusalBlock.includes('scrapeWarnings:')
        && !scoringRefusalBlock.includes('jobRunId:'),
      'both paused-scoring branches must reject a standalone continuation that becomes Board-connected at its lane turn before snapshots, processing, or pending-run state are changed');

      const continuationClaimAt = continuation.indexOf(
        'const priorContinuationAdmission = scoringContinuationAdmissionRef.current;',
      );
      const externalAdoptionAt = continuation.indexOf(
        'scoringContinuationAdmissionRef.current = {',
        continuationClaimAt,
      );
      const continuationLeaseAt = continuation.indexOf(
        'emptyContinuationLease = await moduleRunQueue.acquireModuleRun',
        externalAdoptionAt,
      );
      const supersededEmptyAt = continuation.indexOf(
        'if (!ownsContinuationAdmission())',
        continuationLeaseAt,
      );
      const emptyLiveReadAt = continuation.indexOf(
        'const continuationData = getNode(id)?.data || null;',
        supersededEmptyAt,
      );
      const emptyDurableOwnerAt = continuation.indexOf(
        'findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())',
        supersededEmptyAt,
      );
      const scoringLeaseAt = continuation.indexOf(
        'lease = await moduleRunQueue.acquireModuleRun',
        emptyLiveReadAt,
      );
      const supersededScoringAt = continuation.indexOf(
        'if (!ownsContinuationAdmission())',
        scoringLeaseAt,
      );
      const scoringLiveReadAt = continuation.indexOf(
        'const continuationData = getNode(currentId)?.data || null;',
        supersededScoringAt,
      );
      const scoringDurableOwnerAt = continuation.indexOf(
        'findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())',
        supersededScoringAt,
      );
      assert(search.includes('const scoringContinuationAdmissionRef = useRef(null);')
        && continuationClaimAt >= 0
        && externalAdoptionAt > continuationClaimAt
        && continuation.includes('if (queueManagedExternally && priorContinuationAdmission)')
        && continuation.includes('clearContinuationQueueMarker();')
        && continuationLeaseAt > externalAdoptionAt
        && supersededEmptyAt > continuationLeaseAt
        && emptyDurableOwnerAt > supersededEmptyAt
        && emptyDurableOwnerAt < emptyLiveReadAt
        && emptyLiveReadAt > supersededEmptyAt
        && scoringLeaseAt > emptyLiveReadAt
        && supersededScoringAt > scoringLeaseAt
        && scoringDurableOwnerAt > supersededScoringAt
        && scoringDurableOwnerAt < scoringLiveReadAt
        && scoringLiveReadAt > supersededScoringAt
        && continuation.slice(emptyLiveReadAt, scoringLeaseAt).includes("continuationData?.hubState !== 'sources-ready'")
        && continuation.slice(emptyLiveReadAt, scoringLeaseAt).includes('continuationRunId !== requestedJobRunId')
        && continuation.slice(scoringLiveReadAt).includes("continuationData?.hubState !== 'sources-ready'")
        && continuation.slice(scoringLiveReadAt).includes('continuationRunId !== requestedJobRunId')
        && (continuation.match(/if \(ownsContinuationAdmission\(\)\) scoringContinuationAdmissionRef\.current = null;/g) || []).length >= 2,
      'a Source-owned continuation must supersede rather than await a click queued behind that Source lease, while both stale queued branches re-read and match the exact live paused generation before mutating or scoring');

      const scoreCurrentStart = search.indexOf('const handleScoreCurrentResults = useCallback');
      const scoreCurrentEnd = search.indexOf('// Keep the ref up-to-date', scoreCurrentStart);
      const scoreCurrent = search.slice(scoreCurrentStart, scoreCurrentEnd);
      const sourceSkipStart = sourceCard.indexOf("onClick={(e) => {\n              e.stopPropagation();\n              if (\n                sourceActionDisabled");
      const sourceSkipEnd = sourceCard.indexOf("document.dispatchEvent(new CustomEvent('job-source-skip'", sourceSkipStart);
      const sourceSkip = sourceCard.slice(sourceSkipStart, sourceSkipEnd);
      const solveStart = sourceCard.indexOf('const handleSolve = async () =>');
      const solveEnd = sourceCard.indexOf('// Hub state via reactive store selectors', solveStart);
      const solve = sourceCard.slice(solveStart, solveEnd);
      const solveLeaseAt = solve.indexOf('lease = await acquireModuleRun({');
      const solveLiveOwnerAt = solve.indexOf('findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())', solveLeaseAt);
      const solveRetryMutationAt = solve.indexOf("new CustomEvent('job-source-retry-start'", solveLeaseAt);
      const resolveFailedStart = search.indexOf('const onResolveFailed = (e) =>');
      const resolveFailedEnd = search.indexOf("document.addEventListener('job-source-resolve-failed'", resolveFailedStart);
      const resolveFailed = search.slice(resolveFailedStart, resolveFailedEnd);
      assert(scoreCurrent.includes('if (isJobWorkflowDeletionPending(id)) return;')
        && scoreCurrent.indexOf('isJobWorkflowDeletionPending(id)') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && scoreCurrent.includes('findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())')
        && scoreCurrent.includes("const liveData = getNode(id)?.data || data;")
        && scoreCurrent.includes("if (liveData.hubState !== 'sources-ready') return;")
        && scoreCurrent.includes('if (processingRunsRef.current.active || scoringContinuationAdmissionRef.current) return;')
        && scoreCurrent.indexOf('scoringContinuationAdmissionRef.current') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && scoreCurrent.indexOf('findJobSearchBoardActiveRecoveryOwner') < scoreCurrent.indexOf('scrapeWarningsRef.current = [];')
        && sourceSkipStart >= 0 && sourceSkipEnd > sourceSkipStart
        && sourceSkip.includes('findJobSearchBoardActiveRecoveryOwner(data.hubId, getNodes(), getEdges())')
        && sourceSkip.indexOf('findJobSearchBoardActiveRecoveryOwner') < sourceSkip.indexOf('setDismissed(true);')
        && solveLeaseAt >= 0
        && solveLiveOwnerAt > solveLeaseAt
        && solveRetryMutationAt > solveLiveOwnerAt
        && solve.includes('restorative: true')
        && resolveFailed.includes("isJobWorkflowDeletionPending(id) && e.detail?.restorative !== true")
        && solve.includes('hubData.pendingTargetRole\n            ?? hubData.activeTargetRole\n            ?? hubData.targetRole'),
      'Score-current and source Skip/Dismiss must refuse before changing warnings or card state, and Solve must defer its hub-warning mutation until post-lease Board/run validation, restore it across a reversible deletion, and retain the paused run role');

      const rerunStart = search.indexOf('const handleRerun = useCallback');
      const rerunEnd = search.indexOf('const cancelBoardRun = useCallback', rerunStart);
      const rerun = search.slice(rerunStart, rerunEnd);
      assert(!rerun.includes('scrapeWarningsRef.current = []')
        && !rerun.includes("new CustomEvent('job-source-progress-reset'")
        && !rerun.includes('jobRunIdRef.current = null'),
      'handleRerun must not invalidate prior results, recovery, or source-card progress before queue admission');

      const runnerStart = search.indexOf('const runForJobBoard = useCallback');
      const runnerEnd = search.indexOf('// Re-score the currently displayed listings', runnerStart);
      const runner = search.slice(runnerStart, runnerEnd);
      const requestedFinalizationAt = runner.indexOf('const requestedFinalizationRecovery =');
      const requestedRetirementAt = runner.indexOf('const requestedManualRetirementRecovery =');
      const effectiveManualResumeAt = runner.indexOf('const effectiveManualAiResume =');
      const readinessAt = runner.indexOf('const notReady = boardRunReadiness(liveNode');
      const earlyParentCancellationAt = runner.indexOf("if (typeof isCancelled === 'function' && isCancelled())");
      const liveNodeAt = runner.indexOf('const liveNode = getNode(id);');
      const controlAt = runner.indexOf('const control = {');
      const invokeAt = runner.indexOf('let outcome;', controlAt);
      const readinessHelperStart = search.indexOf('function boardRunReadiness');
      const readinessHelperEnd = search.indexOf('function terminalCommitMismatchReason', readinessHelperStart);
      const readinessHelper = search.slice(readinessHelperStart, readinessHelperEnd);
      assert(requestedFinalizationAt >= 0
        && requestedRetirementAt > requestedFinalizationAt
        && effectiveManualResumeAt > requestedRetirementAt
        && earlyParentCancellationAt >= 0 && earlyParentCancellationAt < liveNodeAt
        && readinessAt > effectiveManualResumeAt
        && controlAt > readinessAt && invokeAt > controlAt
        && runner.includes('processing: processingRunsRef.current.active')
        && runner.includes('platformsVerifying,')
        && runner.includes('terminalFinalizationRecovery: !!effectiveFinalizationRecovery || !!requestedManualRetirementRecovery')
        && runner.includes('} else if (effectiveManualAiResume?.retirementPending)')
        && runner.includes('} else if (requestedManualRetirementRecovery)')
        && runner.includes('} else if (isSavedScrapeManualAiResume(effectiveManualAiResume))')
        && runner.includes('} else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun)')
        && readinessHelper.includes('if (hasCancellationPendingManualAiCleanup(liveData))')
        && readinessHelper.indexOf('if (hasCancellationPendingManualAiCleanup(liveData))')
          < readinessHelper.indexOf('if (!recoveryOwner || (')
        && search.includes("const BOARD_BUSY_SEARCH_STATES = new Set([...PROCESSING_STATES, 'scoring-batch'])")
        && search.includes("if (hubState === 'sources-ready' &&"),
      'the Board child executor must fence unfinished cancellation cleanup and revalidate live paused, batch, active, connection-verification, recovery, location, source, and career-input state before creating a run or clearing recovery');

      const exactCancelStart = search.indexOf('const cancelBoardRun = useCallback');
      const exactCancel = search.slice(exactCancelStart, runnerStart);
      const reloadCancellationStart = exactCancel.indexOf('if (!control) {');
      const reloadCancellationEnd = exactCancel.indexOf('if (control.rollbackApplied) {', reloadCancellationStart);
      const reloadCancellation = exactCancel.slice(reloadCancellationStart, reloadCancellationEnd);
      const retirementStart = search.indexOf('const settleManualAiRetirement = useCallback');
      const retirementEnd = search.indexOf('const completeManualAiRun = useCallback', retirementStart);
      const retirement = search.slice(retirementStart, retirementEnd);
      const intentCommitAt = retirement.indexOf(
        "throw new Error('The Job Search cancellation intent was not committed before task cancellation.')",
      );
      const acknowledgementAt = retirement.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(',
        intentCommitAt,
      );
      const discoveredAt = retirement.indexOf(
        'for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])',
        acknowledgementAt,
      );
      const durableIdsAt = retirement.indexOf('const acknowledgedRunIds = [...runIds];', discoveredAt);
      const durableCommitAt = retirement.indexOf(
        "'The acknowledged manual-AI cleanup receipts were not committed to the canvas.'",
        durableIdsAt,
      );
      const parentReceiptAt = retirement.indexOf(
        "if (!acknowledgementError && typeof beforeRetirement === 'function')",
        durableCommitAt,
      );
      const parentReceiptAwaitAt = retirement.indexOf(
        'await beforeRetirement([...runIds]);',
        parentReceiptAt,
      );
      const retireAllAt = retirement.indexOf(
        ': await Promise.all([...runIds].map(async (retirementRunId) => {',
        parentReceiptAwaitAt,
      );
      const reconciliationAt = retirement.indexOf('let reconciliationCommitted = false;', retireAllAt);
      assert(retirementStart >= 0 && retirementEnd > retirementStart
        && retirement.includes('const cancellationWasPreAcknowledged = Array.isArray(acknowledgedRunIds);')
        && retirement.includes('...(cancellationWasPreAcknowledged ? acknowledgedRunIds : [])')
        && retirement.includes('cancellationPending: true,')
        && intentCommitAt >= 0 && acknowledgementAt > intentCommitAt
        && discoveredAt > acknowledgementAt && durableIdsAt > discoveredAt
        && durableCommitAt > durableIdsAt && parentReceiptAt > durableCommitAt
        && parentReceiptAwaitAt > parentReceiptAt && retireAllAt > parentReceiptAwaitAt
        && retirement.includes('const successfulRunIds = new Set(')
        && retirement.includes("status: 'rejected', reason: error")
        && reconciliationAt > retireAllAt
        && retirement.includes('const failuresCommitted = failedResults.every(failed => (')
        && retirement.includes("throw new Error('The manual-AI cleanup result was not committed to the canvas.')"),
      'Search manual-AI retirement must durably record cancellation intent before acknowledgement, fan out every acknowledgement-discovered id to Search and parent receipts before completion, preserve per-id failures, and verify final cleanup reconciliation before releasing ownership');
      const restoreStart = search.indexOf('const restoreBoardSourceGraph = useCallback');
      const restoreEnd = search.indexOf('useUnmountEffect(cleanupAllJobChildren)', restoreStart);
      const sourceGraphRestore = search.slice(restoreStart, restoreEnd);
      assert(runner.includes('previousSourceGraph: durableRollbackAtAdmission')
        && runner.includes('? safeClone(durableRollbackAtAdmission.sourceGraph || { nodes: [], edges: [] })')
        && runner.includes(': captureJobSourceGraph(id, getNodes(), getEdges())')
        && exactCancel.includes('const durablePlanClaim = boardPlan?.version === 1')
        && exactCancel.includes("&& boardPlan.phase === 'searches'")
        && exactCancel.includes('&& boardPlan.activeSourceId === id')
        && exactCancel.includes('const persistChildCancellationCleanup = async (cleanupPatch = {}) => {')
        && exactCancel.includes('...(Array.isArray(liveCleanup.manualAiRunIds)')
        && exactCancel.includes('manualAiRunIds,\n              commitNonce,')
        && exactCancel.includes('requestedRunIds.every(runId => liveRunIds.has(runId))')
        && exactCancel.includes("throw new Error('The Job Board child-cancellation receipt was not committed to the canvas.')")
        && reloadCancellationStart >= 0 && reloadCancellationEnd > reloadCancellationStart
        && reloadCancellation.includes('const cancellationManualAiRunIds = new Set([')
        && reloadCancellation.includes('...(Array.isArray(persistedCleanup?.manualAiRunIds)')
        && exactCancel.includes('const cancellationLeasePromise = queueManagedExternally')
        && exactCancel.includes("kind: 'job-search-cancel'")
        && reloadCancellation.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);')
        && reloadCancellation.includes('for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])')
        && reloadCancellation.indexOf('await settleManualAiRetirement({')
          > reloadCancellation.indexOf('for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || [])')
        && reloadCancellation.includes('acknowledgedRunIds: [...cancellationManualAiRunIds],')
        && reloadCancellation.includes('beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({')
        && reloadCancellation.includes('manualAiRunIds: acknowledgedIds,')
        && reloadCancellation.indexOf('cancellationLease = await cancellationLeasePromise;')
          > reloadCancellation.indexOf('await settleManualAiRetirement({')
        && !reloadCancellation.includes('await retireManualAiRunDurably(cancellationManualAiRunId);')
        && exactCancel.includes('restoreBoardSourceGraph(control.previousSourceGraph, activeRunId)')
        && exactCancel.includes("const canRestoreCanvas = isMountedRef.current && getNode(id)?.type === 'jobhub';")
        && exactCancel.includes('control.rollbackPromise = Promise.resolve(true);')
        && exactCancel.includes('const performCleanupArtifacts = async () => {')
        && exactCancel.includes('control.cleanupArtifacts = () => {')
        && exactCancel.includes('if (control.cleanupPromise) return control.cleanupPromise;')
        && exactCancel.includes('await abortAndDiscoverRun();')
        && exactCancel.includes('const controlManualAiRunIds = control.manualAiRunIds instanceof Set')
        && exactCancel.includes('acknowledgedRunIds: [...controlManualAiRunIds],')
        && exactCancel.includes('beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({')
        && !exactCancel.includes('await retireManualAiRunDurably(control.manualAiRunId);')
        && runner.includes('const cancellation = await cancelBoardRun({')
        && pipeline.includes('await control.rollbackPromise;')
        && sourceGraphRestore.includes("if (!isMountedRef.current || getNode(id)?.type !== 'jobhub') return false;")
        && sourceGraphRestore.includes("current.some(node => node?.id === id && node.type === 'jobhub')")
        && search.includes("new CustomEvent('job-source-progress-restore'")
        && sourceCard.includes("document.addEventListener('job-source-progress-restore', onRestore)")
        && sourceCard.includes('progressRunGuardRef.current = restoredState.guard;')
        && sourceCard.includes('setProgress(restoredState.progress, { persistTerminal: false });')
        && sourceCard.includes('data._boardRollbackProgressRestore')
        && sourceCard.includes('appliedRollbackReceiptNonceRef.current === receipt.nonce'),
      'exact Board rollback must settle before the Board releases its lane, restore source nodes/edges only while the original canvas is mounted, and apply each local-progress receipt once without rewriting its terminal timestamp');

      return {
        exactChildCancellation: true,
        liveReadiness: true,
        standaloneQueueFence: true,
        sourceGraphRollback: true,
      };
    },
  },
  {
    name: 'Job Search automatic continuations honor Board ownership at admission and lane start',
    run() {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');

      const usaStart = search.indexOf('const triggerUSAJobsBackgroundSearch = useCallback');
      const usaEnd = search.indexOf('const handleJobsSettingsChange = useCallback', usaStart);
      const usa = search.slice(usaStart, usaEnd);
      const usaMarkerAt = usa.indexOf('const clearOwnQueueMarker = () => updateGlobal(currentId, (node) => (');
      const usaAdmissionAt = usa.indexOf('if (boardConnectionOwnsRefresh())', usaMarkerAt);
      const usaRecoveryAt = usa.indexOf('const recoveryReservation = () =>', usaAdmissionAt);
      const usaDuplicateGuardAt = usa.indexOf('if (usaJobsRefreshAdmissionRef.current)', usaRecoveryAt);
      const usaAdmissionGuardAt = usa.indexOf('if (localQueueAdmissionRef.current)', usaDuplicateGuardAt);
      const usaAdmissionTokenAt = usa.indexOf('const admissionToken = Symbol(`usajobs-refresh:${currentId}`);', usaAdmissionGuardAt);
      const usaRefreshClaimAt = usa.indexOf('usaJobsRefreshAdmissionRef.current = admissionToken;', usaAdmissionTokenAt);
      const usaAdmissionClaimAt = usa.indexOf('localQueueAdmissionRef.current = admissionToken;', usaRefreshClaimAt);
      const usaLeaseAt = usa.indexOf('lease = await moduleRunQueue.acquireModuleRun', usaAdmissionClaimAt);
      const usaStartFenceAt = usa.indexOf('if (boardConnectionOwnsRefresh())', usaLeaseAt);
      const usaClaimedAt = usa.indexOf('if (refreshClaimedByBoard)', usaStartFenceAt);
      const usaLiveReadAt = usa.indexOf('refreshData = getNode(currentId)?.data || null;', usaClaimedAt);
      const usaProviderAt = usa.indexOf('window.electronAPI.searchJobsSingleSource', usaLiveReadAt);
      const usaAdmissionRefusal = usa.slice(usaAdmissionAt, usaRecoveryAt);
      const usaQueuedRefusal = usa.slice(usaClaimedAt, usaLiveReadAt);
      const usaFinallyAt = usa.lastIndexOf('} finally {');
      const usaAdmissionReleaseAt = usa.indexOf(
        'if (localQueueAdmissionRef.current === admissionToken)',
        usaFinallyAt,
      );
      const usaRefreshReleaseAt = usa.indexOf(
        'if (usaJobsRefreshAdmissionRef.current === admissionToken)',
        usaAdmissionReleaseAt,
      );
      assert(usaStart >= 0 && usaEnd > usaStart
        && usaMarkerAt >= 0
        && search.includes('const usaJobsRefreshAdmissionRef = useRef(null);')
        && usa.includes("node?.data?.queuedModuleRun?.label === 'Refreshing USAJobs'")
        && usaAdmissionAt > usaMarkerAt && usaRecoveryAt > usaAdmissionAt
        && usaDuplicateGuardAt > usaRecoveryAt
        && usaAdmissionGuardAt > usaDuplicateGuardAt
        && usaAdmissionTokenAt > usaAdmissionGuardAt
        && usaRefreshClaimAt > usaAdmissionTokenAt
        && usaAdmissionClaimAt > usaRefreshClaimAt
        && usaLeaseAt > usaAdmissionClaimAt
        && usaStartFenceAt > usaLeaseAt
        && usaClaimedAt > usaStartFenceAt
        && usaLiveReadAt > usaClaimedAt
        && usaProviderAt > usaLiveReadAt
        && usa.slice(usaDuplicateGuardAt, usaAdmissionGuardAt).includes('return;')
        && usa.slice(usaDuplicateGuardAt, usaAdmissionGuardAt).includes('pendingUSAJobsRefreshRef.current = false;')
        && usa.slice(usaAdmissionGuardAt, usaAdmissionTokenAt).includes('return;')
        && usa.slice(usaAdmissionGuardAt, usaAdmissionTokenAt).includes('pendingUSAJobsRefreshRef.current = true;')
        && usaFinallyAt > usaProviderAt
        && usaAdmissionReleaseAt > usaFinallyAt
        && usaRefreshReleaseAt > usaAdmissionReleaseAt
        && usaAdmissionRefusal.includes('pendingUSAJobsRefreshRef.current = false;')
        && usaAdmissionRefusal.includes('clearOwnQueueMarker();')
        && usaQueuedRefusal.includes('pendingUSAJobsRefreshRef.current = false;')
        && usaQueuedRefusal.includes('clearOwnQueueMarker();')
        && !usaAdmissionRefusal.includes('scoredJobs:')
        && !usaAdmissionRefusal.includes('pendingJobs:')
        && !usaAdmissionRefusal.includes('hubState:')
        && !usaQueuedRefusal.includes('scoredJobs:')
        && !usaQueuedRefusal.includes('pendingJobs:')
        && !usaQueuedRefusal.includes('hubState:'),
      'USAJobs background refresh must coalesce only its own duplicate admission, preserve the latch behind unrelated local work, drop at both Board-ownership fences, and identity-release without changing results');

      const usaWakeEffectStart = search.indexOf('// A credentials change may arrive while a recovered Board owns this Search.');
      const usaWakeEffectEnd = search.indexOf('// (Results-cascade filters', usaWakeEffectStart);
      const usaWakeEffect = search.slice(usaWakeEffectStart, usaWakeEffectEnd);
      assert(usaWakeEffect.includes('if (processingRunsRef.current.active || localQueueAdmissionRef.current) return;')
        && usaWakeEffect.includes('data.queuedModuleRun?.label')
        && usaWakeEffect.includes('data.queuedModuleRun?.position')
        && usaWakeEffect.includes('hubState'),
      'a provider-refresh latch deferred by unrelated local work must react when that workflow leaves its queued/running state and retry after its admission ref is released');

      const batchStart = search.indexOf('const pollBatchOnce = useCallback');
      const batchEnd = search.indexOf("useEffect(() => {\n    if (\n      hubState !== 'scoring-batch'", batchStart);
      const legacyBatch = search.slice(batchStart, batchEnd);
      const admissionReadAt = legacyBatch.indexOf('const admissionData = getNode(id)?.data || null;');
      const durableOwnerAt = legacyBatch.indexOf(
        'findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())',
        admissionReadAt,
      );
      const claimedAt = legacyBatch.indexOf('batchCompletingRef.current = true;', durableOwnerAt);
      const batchLeaseAt = legacyBatch.indexOf('lease = await moduleRunQueue.acquireModuleRun', claimedAt);
      const liveTurnAt = legacyBatch.indexOf('const turnData = getNode(id)?.data || null;', batchLeaseAt);
      const pollAt = legacyBatch.indexOf('window.electronAPI.pollJobBatch', liveTurnAt);
      const admissionOwnerBlock = legacyBatch.slice(durableOwnerAt, claimedAt);
      const liveFenceBlock = legacyBatch.slice(liveTurnAt, pollAt);
      const batchEffect = search.slice(batchEnd, search.indexOf('/**', batchEnd));
      assert(batchStart >= 0 && batchEnd > batchStart
        && admissionReadAt >= 0 && durableOwnerAt > admissionReadAt
        && claimedAt > durableOwnerAt
        && batchLeaseAt > claimedAt
        && legacyBatch.includes("priority: 'continuation'")
        && liveTurnAt > batchLeaseAt && pollAt > liveTurnAt
        && admissionOwnerBlock.includes("return searchRunOutcome('paused'")
        && !admissionOwnerBlock.includes('updateGlobal(')
        && !admissionOwnerBlock.includes('pollJobBatch')
        && liveFenceBlock.includes("turnData.hubState !== 'scoring-batch'")
        && liveFenceBlock.includes('turnData.pendingBatch?.batchId !== admissionBatchId')
        && liveFenceBlock.includes('processingRunsRef.current.active')
        && liveFenceBlock.includes('boardRunControlRef.current')
        && liveFenceBlock.includes('findJobSearchBoardActiveRecoveryOwner')
        && legacyBatch.includes('if (!queueManagedExternally) lease = await moduleRunQueue.acquireModuleRun')
        && legacyBatch.includes('boardPlan.boardRunId !== boardRunId')
        && legacyBatch.includes('boardPlan.activeSourceId !== id')
        && legacyBatch.includes('const exactExternalControl = queueManagedExternally')
        && legacyBatch.includes('const exactExternalOwner = queueManagedExternally')
        && legacyBatch.indexOf('lease?.release();', pollAt) > pollAt
        && legacyBatch.includes('getNode, getNodes, getEdges, epoch')
        && batchEffect.includes('|| activeBoardRecoveryOwnerKey')
        && batchEffect.includes('deletionLifecycleRevision')
        && batchEffect.includes('[activeBoardRecoveryOwnerKey, data.pendingBatch?.batchId, deletionLifecycleRevision, hubState, pollBatchOnce]'),
      'legacy batch retirement must yield to a preexisting durable Board plan, otherwise acquire the continuation lane and re-read the exact batch plus active in-memory owner before its first sidecar mutation');

      return { usaJobsBoardFence: true, legacyBatchLaneFence: true };
    },
  },
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
    name: 'Interrupted Board scans retain exact child ownership through queue and reload recovery',
    run() {
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const scanStart = board.indexOf('const handleSearchSelected = useCallback');
      const scanEnd = board.indexOf('\n  useEffect(() => {', scanStart);
      const scan = board.slice(scanStart, scanEnd);
      const savedResumeStart = search.indexOf('const handleResumeSavedScrape = useCallback');
      const savedResumeEnd = search.indexOf('resumeSavedScrapeRef.current = handleResumeSavedScrape', savedResumeStart);
      const savedResume = search.slice(savedResumeStart, savedResumeEnd);

      assert(scan.includes('const queuedRecoverySourceId = resumePlan?.activeSourceId')
        && scan.includes('activeSourceId: queuedRecoverySourceId,')
        && scan.includes('findJobSearchBoardRecoveryOwner(sourceId, childManualAiResume.runId')
        && scan.includes('recoveryOwner.orchestratorNodeId === id && recoveryOwner.boardRunId === boardRunId')
        && scan.includes('manualAiResume: childManualAiResume,'),
      'a recovered Board must preserve its active child while queued and admit the saved handoff only for the exact parent run');
      assert(search.includes('orchestratorNodeId: boardControl.orchestratorNodeId')
        && search.includes('boardRunId: boardControl.boardRunId')
        && search.includes('findJobSearchBoardRecoveryOwner(id, resume.runId, getNodes(), getEdges())')
        && savedResume.includes('standaloneRecoveryClaimedByBoard = true;')
        && savedResume.includes('Queued saved recovery deferred to its durable Job Board owner'),
      'the child restart marker must persist its Board identity, suppress standalone auto-resume, and recheck that owner when a queued saved recovery starts');
      return { parentPlanDurable: true, exactOwner: true, standaloneRecoveryFenced: true };
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
      assert(moduleFingerprint([base]).startsWith('7:'), 'fit-audit-aware fingerprints use the current v7 format');

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
      assert(confirm.includes('const liveBoard = getNode(id);')
        && confirm.includes('liveBoardData.locked')
        && confirm.includes('const liveInputs = liveCombineInputs(id, getNodes(), getEdges());')
        && confirm.includes('const liveBlockReason = emptyReplacementIneligibilityReason({')
        && confirm.includes('readyModuleCount: liveInputs.ready.length')
        && confirm.includes('reason=${liveBlockReason}')
        && confirm.indexOf('if (liveBlockReason)') < confirm.indexOf('clearBoardChildren();'),
      'confirmation must re-read the live graph and refuse a newly locked, running, nonterminal, positive, or current Board before deleting its cascade');
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
      const combineBusyAt = combine.indexOf("if (combineRunRef.current || combineRecoveryTokenClaimRef.current) return { status: 'busy' };");
      const scanBusyAt = combine.indexOf("if (scanRunRef.current && options?.afterSearch !== true) return { status: 'busy' };");
      const combineTokenAt = combine.indexOf("const combineToken = Symbol('job-board-combine');");
      const combineClaimAt = combine.indexOf('combineRunRef.current = combineToken;', combineTokenAt);
      assert(combineBusyAt >= 0 && scanBusyAt > combineBusyAt
        && combineTokenAt > scanBusyAt && combineClaimAt > combineTokenAt,
      'Combine must synchronously report duplicate/competing scan admission as busy before claiming its ref token, so two same-turn calls cannot both start before React commits combining=true');
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
        const cancelAt = section.indexOf('cancelBoardTaskAndRetireManualAi(');
        return cancelAt >= 0
          && section.indexOf('combineRunRef.current = null;') >= 0
          && section.indexOf('compensationRequestIdRef.current = null;') >= 0
          && section.indexOf('combineRunRef.current = null;') < cancelAt
          && section.indexOf('compensationRequestIdRef.current = null;') < cancelAt;
      };
      assert(releasesBeforeCancellation(cleanupBlock) && releasesBeforeCancellation(clearBlock),
        'Clear and unmount cleanup must synchronously release the Combine lock and request id before starting acknowledged backend/manual-AI cancellation');
      assert(clearBlock.includes('if (getNode(id)?.data?.locked) {')
        && clearBlock.indexOf('if (getNode(id)?.data?.locked) {')
          < clearBlock.indexOf('const cancellationIntentPromise = persistBoardCancellationIntent'),
      'a stale or programmatic Clear invocation must recheck the live Board lock before cancelling work or deleting the frozen snapshot');
      const acknowledgedCancelStart = board.indexOf('const cancelBoardTaskAndRetireManualAi = useCallback');
      const acknowledgedCancelEnd = board.indexOf('const cleanupBoard = useCallback', acknowledgedCancelStart);
      const acknowledgedCancel = board.slice(acknowledgedCancelStart, acknowledgedCancelEnd);
      const acknowledgementAt = acknowledgedCancel.indexOf(
        'const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);',
      );
      const settledAt = acknowledgedCancel.indexOf('if (acknowledgement?.settled !== true)', acknowledgementAt);
      const discoveredAt = acknowledgedCancel.indexOf(
        'for (const runId of acknowledgement?.manualAiRunIds || [])',
        settledAt,
      );
      const durableIdsAt = acknowledgedCancel.indexOf(
        'await persistAcknowledgedBoardManualAiRunIds([...runIds], reason);',
        discoveredAt,
      );
      const retireAllAt = acknowledgedCancel.indexOf(
        'await Promise.all([...runIds].map(runId => (',
        durableIdsAt,
      );
      assert(acknowledgedCancel.includes('const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);')
        && acknowledgedCancel.includes('if (acknowledgement?.settled !== true)')
        && acknowledgedCancel.includes('for (const runId of acknowledgement?.manualAiRunIds || [])')
        && acknowledgementAt >= 0 && settledAt > acknowledgementAt
        && discoveredAt > settledAt && durableIdsAt > discoveredAt && retireAllAt > durableIdsAt,
      'the shared Board cancellation helper must wait for exact task settlement, include run ids discovered by acknowledgement, commit every id to durable cleanup ownership, and only then retire every handoff before Clear/unmount can finish');
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
  {
    name: 'Job Board Combine leases the job lane and snapshots live inputs before commit',
    run() {
      // The queue's executable FIFO/cancellation coverage lives in
      // job-run-staging. Pin this component's integration and ordering without
      // mounting a ReactFlow/Electron tree.
      const board = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const combineStart = board.indexOf('const handleCombine');
      const combineEnd = board.indexOf('\n  return (', combineStart);
      const combine = board.slice(combineStart, combineEnd);
      const cleanupStart = board.indexOf('const cleanupBoard');
      const clearStart = board.indexOf('const handleClear');
      const clearEnd = board.indexOf('const completeManualAiRun', clearStart);
      const cleanup = board.slice(cleanupStart, clearStart);
      const clear = board.slice(clearStart, clearEnd);
      const leaseAt = combine.indexOf('await moduleRunQueue.acquireModuleRun');
      const snapshotAt = combine.indexOf('const inputsAtCombine = liveCombineInputs(id, getNodes(), getEdges());');
      const guardAt = combine.indexOf('const liveStateBeforeCommit = liveCombineInputs(id, getNodes(), getEdges());');
      const clearChildrenAt = combine.indexOf('clearBoardChildren();', guardAt);
      const historyAt = combine.indexOf('appendJobsHistory', guardAt);
      const committedBoundaryAt = combine.indexOf(
        'committedCombineRef.current = { token: combineToken, manualAiRunId };',
        clearChildrenAt,
      );
      const manualCleanupAt = combine.indexOf(
        'await completeManualAiRun(manualAiRunId);',
        committedBoundaryAt,
      );
      assert(board.includes("import { useModuleRunQueue } from '../contexts/useModuleRunQueue';")
        && board.includes('const moduleRunQueue = useModuleRunQueue();')
        && leaseAt >= 0 && combine.includes("lane: 'job-search'")
        && snapshotAt > leaseAt && combine.includes('lease?.release()')
        && cleanup.includes("cancelQueuedRunsForNode(id, 'Job Board unmounted')")
        && clear.includes("cancelQueuedRunsForNode(id, 'Job Board cleared')"),
      'Combine holds one job-search lease and Clear/unmount remove an unstarted queued combine');
      assert(combine.includes('const completedAtCombine = inputsAtCombine.completed;')
        && combine.includes('const readyAtCombine = inputsAtCombine.ready;')
        && combine.indexOf("if (getNode(id)?.data?.locked) return { status: 'not-ready', error: 'Unlock this Job Board first.' };") > leaseAt
        && combine.indexOf("if (getNode(id)?.data?.locked) {", snapshotAt) > snapshotAt
        && combine.indexOf('await completeManualAiRun(manualAiRunId);', snapshotAt) < guardAt
        && combine.includes('boardInputSignature(\n          liveInputsBeforeCommit,\n          liveStateBeforeCommit.all,')
        && combine.includes('boundedCombinedSourceRuns(completedAtCombine)')
        && combine.includes('moduleCount: completedAtCombine.length')
        && guardAt > snapshotAt && clearChildrenAt > guardAt && historyAt > guardAt
        && combine.includes('combine superseded before commit'),
      'post-queue live inputs drive the union/provenance, live locks stop both queued and post-provider work, and a second signature check runs before card deletion or history writes');
      assert(combine.includes('const historyWrite = window.electronAPI?.appendJobsHistory?.({')
        && combine.includes('void Promise.resolve(historyWrite).then(')
        && !combine.includes('await window.electronAPI?.appendJobsHistory'),
      'history persistence must drain after the visible Board commit without leaving a cancellable run that can falsely report rollback success');
      const cancelStart = board.indexOf('const handleCancelRun = useCallback');
      const cancelEnd = board.indexOf('useEffect(() => jobSearchCoordinator.registerBoardModule', cancelStart);
      const cancel = board.slice(cancelStart, cancelEnd);
      const manualCancelledHandlerAt = board.indexOf('const onManualAiNodeCancelled = (event) =>');
      const manualPendingHandlerAt = board.indexOf('const onPending = (event) =>', manualCancelledHandlerAt);
      const manualCancelledHandler = board.slice(manualCancelledHandlerAt, manualPendingHandlerAt);
      const manualPendingHandler = board.slice(
        manualPendingHandlerAt,
        board.indexOf("document.addEventListener('non-api-ai-node-pending'", manualPendingHandlerAt),
      );
      const retirementStart = board.indexOf('const retireActiveCombineManualAiRun = useCallback');
      const retirementEnd = board.indexOf('const persistAcknowledgedBoardManualAiRunIds = useCallback', retirementStart);
      const retirement = board.slice(retirementStart, retirementEnd);
      assert(committedBoundaryAt > clearChildrenAt
        && manualCleanupAt > committedBoundaryAt
        && cancel.includes('const committedCombine = committedCombineRef.current;')
        && cancel.includes('combineRunRef.current === committedCombine.token')
        && cancel.includes('liveData.manualAiResume?.committedResult === true')
        && cancel.includes("const committedCleanupMustSettle = !!liveData.boardCancellation || reason === 'node-deleted';")
        && cancel.includes('if (committedResultAlreadyVisible && !committedCleanupMustSettle)')
        && cancel.includes('if (committedResultAlreadyVisible) {')
        && cancel.includes('committed-run cleanup completed without rollback')
        && cancel.includes("if (reason === 'node-deleted') {")
        && cancel.includes("return { status: 'cancelled', cancelled: true };")
        && cancel.includes("return { status: 'completed', cancelled: false };")
        && board.includes('setFinalizingCommittedCombine(true);')
        && board.includes('recoveryCanCancel={!cleanupOnlyRecovery && !cancellationCleanupActive && !finalizingCommittedCombine}'),
      'after the replacement cascade is committed, Combine must cross a synchronous non-cancellable boundary before awaiting durable manual-AI cleanup, and an imperative late Cancel must report completion instead of a false rollback');
      const durableCommitAt = combine.indexOf('manualAiResume: manualAiRunId ? {', committedBoundaryAt);
      const durablePlanClearAt = combine.indexOf('boardScanResume: null,', committedBoundaryAt);
      const retirementPendingAt = combine.indexOf('retirementPending: true,', durableCommitAt);
      const committedResultAt = combine.indexOf('committedResult: true,', durableCommitAt);
      assert(durableCommitAt > committedBoundaryAt
        && durablePlanClearAt > committedBoundaryAt
        && retirementPendingAt > durableCommitAt
        && committedResultAt > retirementPendingAt
        && manualCleanupAt > committedResultAt
        && board.indexOf('if (resume.retirementPending) {') >= 0,
      'the visible Board commit must atomically replace its replayable scan/manual markers with a durable cleanup-only receipt, so reload before completion retires the run instead of re-running Combine');
      const cleanupCommitGuardAt = retirement.indexOf('let cleanupRemovalCommitted = false;');
      const cleanupCommitErrorAt = retirement.indexOf(
        "throw new Error('The Job Board manual-AI cleanup result was not committed to the canvas.');",
        cleanupCommitGuardAt,
      );
      const retiredTombstoneAt = retirement.indexOf(
        'rememberBoundedRunId(retiredCombineManualAiRunIdsRef.current, runId);',
        cleanupCommitErrorAt,
      );
      assert(cleanupCommitGuardAt >= 0
        && retirement.includes('cleanupRemovalCommitted = true;')
        && cleanupCommitErrorAt > cleanupCommitGuardAt
        && retiredTombstoneAt > cleanupCommitErrorAt
        && retirement.includes('retirementReceipt.retryCombineAfterRetirement === true')
        && retirement.includes('combineManualAiRunId: null,')
        && retirement.includes('const retryPlanReleased = retirementReceipts.get(runId)?.retryCombineAfterRetirement !== true')
        && (combine.match(/completeManualAiRun\(manualAiRunId, \{ retryCombineAfterRetirement: true \}\)/g) || []).length === 2,
      'backend completion must not become a mount-local retired tombstone until marker/receipt removal is observable; a delayed canvas update must throw into the durable retry-receipt path');
      assert(combine.includes('rememberBoundedRunId(committedCombineManualAiRunIdsRef.current, manualAiRunId);')
        && manualCancelledHandler.includes('if (!cancelledRunId) {')
        && manualCancelledHandler.includes('ignored manual-AI cancellation without a run')
        && manualCancelledHandler.indexOf('if (!cancelledRunId) {')
          < manualCancelledHandler.indexOf('handleCancelRun();')
        && manualCancelledHandler.includes('committedCombineManualAiRunIdsRef.current.has(cancelledRunId)')
        && manualCancelledHandler.includes('liveData.manualAiResume?.committedResult === true')
        && manualCancelledHandler.includes("retireActiveCombineManualAiRun(cancelledRunId, 'post-commit-cleanup')")
        && manualCancelledHandler.indexOf('committedCombineManualAiRunIdsRef.current.has(cancelledRunId)')
          < manualCancelledHandler.indexOf('handleCancelRun();')
        && manualPendingHandler.includes('committedCombineManualAiRunIdsRef.current.has(detail.runId)')
        && manualPendingHandler.includes('liveData.manualAiResume?.committedResult === true')
        && manualPendingHandler.includes("retireActiveCombineManualAiRun(detail.runId, 'post-commit-cleanup')")
        && manualPendingHandler.indexOf('committedCombineManualAiRunIdsRef.current.has(detail.runId)')
          < manualPendingHandler.indexOf('updateGlobal(id,'),
      'late pending/cancel events must carry an exact run id, and committed runs stay tombstoned after the active token clears so they may only retry retirement, never recreate recovery or cancel the displayed Board');
      const noInputsAt = combine.indexOf('if (readyAtCombine.length === 0)');
      const noInputsBlock = combine.slice(noInputsAt, combine.indexOf('const exactSourceRunsAtCombine', noInputsAt));
      assert(noInputsAt > snapshotAt
        && noInputsBlock.includes('if (options?.manualAiRunId)')
        && noInputsBlock.includes('autoResumedManualAiRunRef.current = null;')
        && noInputsBlock.includes('completeManualAiRun(manualAiRunId);'),
      'a queued crash-recovery Combine whose live inputs disappeared must retire its obsolete manual-AI marker instead of suppressing that run forever');
      return {
        sharedLane: true,
        liveSnapshot: true,
        precommitGuard: true,
        committedCleanupNonCancellable: true,
        committedCleanupReloadSafe: true,
        cleanupRemovalCommitVerified: true,
        committedLateEventsRetiredOnly: true,
        obsoleteRecoveryRetired: true,
      };
    },
  },
];
