import { TRANSIENT_PROCESSING_HUB_STATES } from './persistenceTransientState.js';
import { createManualAiPreSearchRecovery } from './manualAiRecovery.js';

export function jobWorkflowNeedsQuitPause(node) {
  const data = node?.data || {};
  if (node?.type === 'jobboard') return !!(data.boardScanResume || data.manualAiResume || data.boardCancellation || data.queuedModuleRun);
  if (node?.type !== 'jobhub') return false;
  return TRANSIENT_PROCESSING_HUB_STATES.includes(data.hubState) || data.hubState === 'sources-ready'
    || !!(data.manualAiResume || data.queuedModuleRun || data.pendingJobs || data.terminalFinalizationRecovery)
    || data.careerImportCompilation?.status === 'compiling';
}

export function savedWorkflowQuitPausePatch(node, acknowledgement = {}, now = Date.now()) {
  const data = node.data || {};
  const existingMarker = data.manualAiResume;
  const runId = existingMarker?.runId || data.careerImportCompilation?.manualAiRunId
    || acknowledgement.manualAiRunIds?.[0] || null;
  let marker = existingMarker;
  if (runId && !marker) {
    marker = { runId, ...(node.type === 'jobhub'
      ? { task: data.careerImportCompilation?.task || (data.resumeProfile ? 'job-search' : 'resume-parse') } : {}) };
    if (node.type === 'jobhub' && !acknowledgement.paused) {
      const recovery = createManualAiPreSearchRecovery({ manualAiRunId: runId, nodeId: node.id,
        searchWindow: data.searchWindow, profileFingerprint: data.resumeFingerprint, startedAt: now });
      if (recovery) marker.preSearchRecovery = recovery;
    }
  }
  const patch = {
    queuedModuleRun: null,
    ...(marker ? { manualAiResume: { ...marker, pausedByUser: true, autoResumeEligible: false, updatedAt: now } } : {}),
  };
  if (node.type === 'jobboard') {
    if (data.boardScanResume) patch.boardScanResume = { ...data.boardScanResume, pausedByUser: true, autoResumeEligible: false, updatedAt: now };
  } else if (acknowledgement.paused && data.analysisOperation) {
    patch.analysisOperation = { ...data.analysisOperation, tombstoned: true };
  }
  // Keep the full sources-ready universe intact. Transient processing labels
  // cannot own a worker after shutdown; the existing rows remain its restore
  // state and the exact manual/provider receipt remains its continuation.
  if (node.type === 'jobhub' && TRANSIENT_PROCESSING_HUB_STATES.includes(data.hubState)) {
    patch.hubState = Array.isArray(data.pendingJobs) ? 'sources-ready' : data.scoredJobs?.length ? 'done' : 'empty';
  }
  return patch;
}

/** Coordinate mounted owners and saved hidden nodes without cancellation. */
export function createQuitWorkflowPauseCoordinator({ enumerateNodes, updateNode, currentFile, queue, registry, api, waitForCommit }) {
  let heldAdmissions = null;
  let active = null;
  let lifecycleGeneration = 0;
  const release = () => { lifecycleGeneration += 1; heldAdmissions?.(); heldAdmissions = null; active = null; };
  const pause = ({ requestId = null } = {}) => {
    if (active) return active;
    heldAdmissions ||= queue.suspendAdmissions();
    const generation = lifecycleGeneration;
    const isCurrent = () => generation === lifecycleGeneration;
    active = (async () => {
      // Mounted refs can own admitted work before its first React patch. Ask
      // every owner; idle owners acknowledge without changing the canvas.
      const planned = enumerateNodes().filter(node => ['jobhub', 'jobboard'].includes(node.type));
      const results = new Map();
      const pauseNode = nodeId => {
        if (results.has(nodeId)) return results.get(nodeId);
        const node = enumerateNodes().find(candidate => candidate.id === nodeId);
        if (!isCurrent()) return Promise.resolve({ success: false, error: 'This quit request was released.' });
        if (!node || !['jobhub', 'jobboard'].includes(node.type)) return Promise.resolve({ success: true, idle: true });
        const task = (async () => {
          let result;
          let offer = null;
          const inspectSavedRun = async () => {
            if (node.type !== 'jobhub' || !currentFile() || !api.peekJobRun) return null;
            const inspected = await api.peekJobRun({ canvasFilePath: currentFile(), nodeId: node.id });
            if (!isCurrent()) throw new Error('This quit request was released.');
            if (inspected?.success === false) throw new Error(inspected.error || 'Could not inspect saved Job Search progress.');
            return inspected?.found && inspected.nodeId === node.id ? inspected : null;
          };
          try {
            const options = { lifecycleQuit: true, preserveAcceptedManualAi: true, requestId,
              pauseSearchModule: pauseNode, isQuitPauseCurrent: isCurrent };
            result = node.type === 'jobboard'
              ? await registry.pauseBoardModule(node.id, options)
              : await registry.pauseSearchModule(node.id, options);
            if (!isCurrent()) throw new Error('This quit request was released.');
            // Sanitized saved nodes can look idle while a sidecar still owns
            // unfinished provider work. Re-enter the mounted safe pauser only
            // after finding that exact saved node's manifest.
            if (result?.idle && (offer = await inspectSavedRun())) {
              result = await registry.pauseSearchModule(node.id, { ...options, forceSavedRecovery: true });
              if (!isCurrent()) throw new Error('This quit request was released.');
            }
          } catch (error) {
            if (!['JOB_BOARD_MODULE_UNAVAILABLE', 'JOB_SEARCH_MODULE_UNAVAILABLE'].includes(error?.code)) throw error;
            // Hidden levels have no mounted owner. The host validates the exact
            // current manifest; preserve every raw recovery field on its node.
            const canvasFilePath = currentFile();
            offer ||= await inspectSavedRun();
            const live = enumerateNodes().find(candidate => candidate.id === nodeId);
            if (!live) return { success: true, idle: true };
            if (!jobWorkflowNeedsQuitPause(live) && !offer) return { success: true, idle: true };
            const expectedIdentity = {
              runId: live.data?.jobRunId, operationId: live.data?.analysisOperation?.authority?.operationId,
              boardRunId: live.data?.boardScanResume?.boardRunId, manualRunId: live.data?.manualAiResume?.runId,
            };
            if (!api.pauseJobRunAndCancel) throw new Error('Saved workflow pause is unavailable.');
            const acknowledgement = await api.pauseJobRunAndCancel({ canvasFilePath, nodeId,
              runId: offer?.found && offer?.nodeId === nodeId ? offer.runId : null,
              operationAuthority: live.data?.analysisOperation?.authority || offer?.operationAuthority || null,
              cause: 'app-quit' });
            if (!isCurrent()) throw new Error('This quit request was released.');
            if (acknowledgement?.settled !== true || acknowledgement?.ok === false) throw new Error('The saved workflow did not confirm its pause.');
            let accepted = false;
            let expectedPatch = null;
            updateNode(nodeId, current => {
              if (!isCurrent() || current?.type !== live.type
                || current.data?.jobRunId !== expectedIdentity.runId
                || current.data?.analysisOperation?.authority?.operationId !== expectedIdentity.operationId
                || current.data?.boardScanResume?.boardRunId !== expectedIdentity.boardRunId
                || (current.data?.manualAiResume?.runId !== expectedIdentity.manualRunId
                  && !(acknowledgement.manualAiRunIds || []).includes(current.data?.manualAiResume?.runId))) return null;
              accepted = true;
              expectedPatch = savedWorkflowQuitPausePatch(current, acknowledgement);
              return expectedPatch;
            });
            await waitForCommit();
            const committed = enumerateNodes().find(candidate => candidate.id === nodeId)?.data;
            if (!accepted || !committed
              || (expectedPatch?.manualAiResume && (committed.manualAiResume?.runId !== expectedPatch.manualAiResume.runId || committed.manualAiResume?.pausedByUser !== true))
              || (expectedPatch?.boardScanResume && committed.boardScanResume?.autoResumeEligible !== false)) {
              throw new Error('The saved workflow pause was not committed.');
            }
            result = { success: true };
          }
          if (result?.success !== true) throw new Error(result?.error || `Workflow ${nodeId} could not pause.`);
          return result;
        })();
        results.set(nodeId, task);
        return task;
      };
      const failures = [];
      const owners = [];
      // Board pausers install their children’s saved-pause controls before
      // fencing the parent, so no child can mistake quit for Board rollback.
      for (const node of [...planned.filter(node => node.type === 'jobboard'), ...planned.filter(node => node.type === 'jobhub')]) {
        if (!isCurrent()) return { success: false, settled: false, requiresCanvasSave: true, requestId };
        owners.push({ nodeId: node.id, task: pauseNode(node.id) });
      }
      // Attach handlers in the same turn, before any pauser can reject while
      // another owner waits for a provider checkpoint.
      const outcomes = await Promise.allSettled(owners.map(owner => owner.task));
      let requiresCanvasSave = false;
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') failures.push({ nodeId: owners[index].nodeId, error: outcome.reason?.message || 'Workflow pause failed.' });
        else if (!outcome.value?.idle) requiresCanvasSave = true;
      });
      if (!isCurrent()) return { success: false, settled: false, requiresCanvasSave: true, requestId };
      // Unstarted queue work has no provider/AI state yet. Remove it while
      // admissions remain suspended, after active owners have fenced themselves.
      for (const entry of queue.getSnapshot().queued || []) {
        requiresCanvasSave = true;
        queue.cancelQueuedRunsOwnedByNode(entry.nodeId, 'App paused for quit');
      }
      // The application lane releases only after its newly created bundle
      // pointer is published to the card and committed. Host IPC settlement
      // alone does not cover that renderer continuation.
      if (queue.getSnapshot().activeRuns?.some(entry => entry.lane === 'application')) requiresCanvasSave = true;
      await queue.waitForActiveRunsToSettle({ lanes: ['application'], timeoutMs: 30000 });
      if (!isCurrent()) return { success: false, settled: false, requiresCanvasSave, requestId };
      await waitForCommit();
      return { success: failures.length === 0, settled: failures.length === 0,
        requiresCanvasSave, requestId,
        pausedNodeIds: [...results.keys()], failures };
    })();
    return active;
  };
  return { pause, release };
}
