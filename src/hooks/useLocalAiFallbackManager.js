import { useEffect, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';
import {
  LOCAL_AI_POLL_INTERVAL_MS,
  LOCAL_AI_RESULT_SETTLE_MS,
  brokenLocalAiJobDriveState,
  LOCAL_AI_STATUS_ERROR_STREAK_LIMIT,
  isJobCardMounted,
  selectFallbackLocalAiJobs,
  selectOrphanedLocalAiJobs,
} from '../utils/localAiFallback';

const LOCAL_AI_RETRY_NOTICE_INTERVAL_MS = 30_000;

/**
 * Canvas-level driver for pending Local AI application jobs whose JobCardNode
 * is NOT mounted. Mounted cards poll and import on their own; but hidden cards
 * unmount — a board hiding stale results, a collapsed group, or nested-canvas
 * navigation — which used to silently kill the poll while a local coding agent sat
 * waiting for the app's measured feedback on the result.json it had written.
 * This manager keeps every pending handoff alive from Canvas.jsx, which stays
 * mounted for the life of the window.
 *
 * Ownership contract (see localAiFallback.js): at any moment exactly one
 * driver runs a job — the mounted card if there is one, otherwise this
 * manager. The manager re-checks mount state at every async boundary and
 * abandons a job the moment its card mounts. Writes go through
 * updateNodeDataGlobally with a FUNCTIONAL patch that merges into the LIVE
 * node state and declines (no-op, identity preserved) when the job was
 * replaced, already terminal 'saved', or the content is unchanged — so ticks
 * never dirty the workspace and stale snapshots can never downgrade a fresher
 * outcome. While a card is mounted the manager writes nothing except the
 * terminal 'saved', which the card explicitly adopts. Concurrent-import races
 * that slip through are rejected by the main process's per-job
 * LOCAL_AI_IMPORT_IN_FLIGHT mutex and the manifest 'imported' save window.
 */
export function useLocalAiFallbackManager({ navigation, getCurrentFile, addToast, nudgePersistence, quitGateRef = null }) {
  const ctxRef = useRef({ navigation, getCurrentFile, addToast, nudgePersistence, quitGateRef });
  useEffect(() => {
    ctxRef.current = { navigation, getCurrentFile, addToast, nudgePersistence, quitGateRef };
  }, [navigation, getCurrentFile, addToast, nudgePersistence, quitGateRef]);

  // jobId → { resultSha256, observedAt }: same two-poll settle window the card
  // uses, so a result.json mid-write is never imported.
  const settlingRef = useRef(new Map());
  // jobId → consecutive status-poll failures (cleared on any success).
  const statusErrorStreakRef = useRef(new Map());
  // jobId → the terminal 'saved' patch this manager committed. A terminal
  // write can be discarded by a same-flush navigation swap (dive-in/out
  // rebuild nodes/stack non-functionally); without a record, the next tick
  // would poll the save-deleted job dir and misdiagnose a successful save as
  // terminal 'failed'. driveJob re-asserts from this map until the write
  // sticks or the card is gone.
  const savedTerminalRef = useRef(new Map());
  // Throttle re-offers after a user closes the persistent action or another
  // toast evicts it. The notice remains recoverable this session without
  // flashing back into view every 2.5-second status tick.
  const retryOfferedAtRef = useRef(new Map());
  const tickBusyRef = useRef(false);
  // One measured import at a time across all jobs — each renders PDFs.
  const importBusyRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const currentQuitGeneration = () => ctxRef.current.quitGateRef?.current?.generation;
    const isCurrentQuitGeneration = (generation) => {
      const gate = ctxRef.current.quitGateRef?.current;
      return !gate?.frozen && (generation === undefined || gate?.generation === generation);
    };

    // Fresh read of the card node straight from the navigation refs — the
    // per-tick snapshot can be minutes old by the time an earlier job's
    // import+save completes.
    const findLiveJobNode = (nodeId, jobId) => {
      const all = ctxRef.current.navigation?.enumerateAllNodes?.() || [];
      const node = all.find((n) => n.id === nodeId);
      return node?.data?.localApplication?.id === jobId ? node : null;
    };

    // Merge `patch` into the LIVE localApplication. Declines (null → identity
    // preserved, nothing dirtied) when the node/job is gone, a terminal
    // 'saved' would be downgraded, or the content is unchanged. Returns
    // whether a real write was dispatched so callers can nudge persistence —
    // a write that lands only in navigation-stack state never passes through
    // the dirty-flag effect (it watches active nodes only), and without the
    // nudge a terminal 'saved' could miss the canvas file entirely.
    const writeState = (nodeId, jobId, patch, { terminal = false, generation } = {}) => {
      if (disposed || !isCurrentQuitGeneration(generation)) return false;
      if (!terminal && isJobCardMounted(nodeId)) return false;
      const nav = ctxRef.current.navigation;
      if (!nav?.updateNodeDataGlobally) return false;
      // Pre-read decides the no-op skip; the in-updater guard below re-decides
      // against the node state at apply time and is the race-proof authority.
      const liveNode = findLiveJobNode(nodeId, jobId);
      const current = liveNode?.data?.localApplication;
      if (!current || current.status === 'saved') return false;
      if (JSON.stringify({ ...current, ...patch }) === JSON.stringify(current)) return false;
      nav.updateNodeDataGlobally(nodeId, (node) => {
        const live = node?.data?.localApplication;
        if (!live || live.id !== jobId) return null;
        if (live.status === 'saved') return null;
        const next = { ...live, ...patch };
        if (JSON.stringify(next) === JSON.stringify(live)) return null;
        return { localApplication: next };
      });
      ctxRef.current.nudgePersistence?.();
      return true;
    };

    // A hidden card and an orphaned on-disk job both lack a visible retry
    // button. Keep their recovery explicit (never poll-triggered), bind it to
    // the exact result hash, and re-offer it if the user closes or a later
    // toast evicts the durable notice.
    const offerRenderRetry = ({
      node, jobId, resultSha256, orphanJob = null, message = '', allowCurrentImport = false,
    }) => {
      const exactResultSha256 = String(resultSha256 || '');
      if (!exactResultSha256 || (!allowCurrentImport && importBusyRef.current)) return;
      const retryKey = `${jobId}:${exactResultSha256}`;
      const now = Date.now();
      const lastOfferedAt = retryOfferedAtRef.current.get(retryKey) || 0;
      if (now - lastOfferedAt < LOCAL_AI_RETRY_NOTICE_INTERVAL_MS) return;
      retryOfferedAtRef.current.set(retryKey, now);
      ctxRef.current.addToast?.({
        title: 'Local AI bundle needs a retry',
        description: message || 'The app consumed this result but could not finish PDF verification or save. The draft does not need another rewrite.',
        type: 'error',
        duration: 0,
        dedupeKey: `local-ai-retry:${jobId}:${exactResultSha256}`,
        actionLabel: 'Retry layout check',
        onAction: async () => {
          // The toast is removed before its action runs. Re-arm the offer so a
          // busy/no-op click or another retryable failure cannot leave this
          // hidden job without recovery UI for the throttle interval.
          retryOfferedAtRef.current.delete(retryKey);
          // A retry is a fresh user action after any cancelled quit, so bind it
          // to the generation current at click time rather than the stale toast.
          await importJob(node, jobId, exactResultSha256, orphanJob, currentQuitGeneration());
        },
      });
    };

    const importJob = async (node, jobId, resultSha256, orphanJob = null, generation = currentQuitGeneration()) => {
      const { addToast: toast, getCurrentFile: currentFile } = ctxRef.current;
      const nodeId = node.id;
      const isOrphan = Boolean(orphanJob);
      const writeImportState = (patch, options = {}) => writeState(nodeId, jobId, patch, {
        ...options,
        generation,
      });
      if (disposed || importBusyRef.current || !isCurrentQuitGeneration(generation)) return;
      // Liveness: the card may have been dismissed/deleted since this tick's
      // enumeration — never import (and auto-save into Applied Jobs) a job the
      // user discarded.  A discovered on-disk job deliberately has no card:
      // its private folder remains app-owned and is its durable ownership
      // record, so it must proceed without trying to recreate the deleted UI.
      const liveNode = findLiveJobNode(nodeId, jobId);
      if (!isOrphan && (!liveNode || isJobCardMounted(nodeId))) return;
      const local = isOrphan ? orphanJob : liveNode.data.localApplication;
      // The save writes the bundle beside the currently open canvas file, the
      // same way the card does; without one there is nowhere to save.
      const activeCanvasFilePath = currentFile ? currentFile() : null;
      const saveCanvasFilePath = isOrphan ? local.canvasFilePath : activeCanvasFilePath;
      if (!saveCanvasFilePath) {
        if (!isOrphan) writeImportState({ status: 'completed', message: 'Save this canvas, then reopen this card to import the completed result.' });
        return;
      }
      // Do not let an orphan discovered for one canvas finish after this
      // window switches to another file. It remains safely on disk and will
      // be rediscovered if its owning canvas is reopened.
      if (isOrphan && activeCanvasFilePath !== saveCanvasFilePath) {
        return;
      }
      importBusyRef.current = true;
      if (!isOrphan) writeImportState({ status: 'importing', message: 'Local AI result found — importing…' });
      EventLogger.log(`[LocalAI] fallback import start job=${jobId} ${isOrphan ? 'orphaned-card' : `card=${nodeId} (card unmounted)`}`);
      try {
        const imported = await window.electronAPI.importLocalApplication({
          jobId,
          canvasFilePath: local.canvasFilePath || saveCanvasFilePath,
          expectedResultSha256: resultSha256,
        });
        if (disposed || !isCurrentQuitGeneration(generation)) return;
        if (!imported?.success || !imported.localApplication) {
          const importError = new Error(imported?.error || 'Could not import the Local AI result.');
          if (imported?.errorCode) importError.code = imported.errorCode;
          throw importError;
        }
        const result = imported.localApplication;
        if (result.status === 'revision-required') {
          const pasteRevision = result.localJob?.mode === 'paste' || result.localJob?.transport === 'paste';
          if (!isOrphan) writeImportState({
            ...result.localJob,
            status: pasteRevision ? (result.localJob?.status || 'queued') : 'revision-required',
            message: pasteRevision
              ? (result.fitMessage || 'The measured layout check requested another review. Reopen the AI handoff to review and edit the structured documents.')
              : (result.fitMessage || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine; it will use fit-feedback.json to prioritize the strongest evidence and argument.'),
          });
          EventLogger.log(`[LocalAI] fallback revision-required job=${jobId} card=${nodeId}`);
          toast?.({
            title: pasteRevision ? 'Application Review and Edit Needed' : 'Local AI Document Revision Needed',
            description: pasteRevision
              ? 'No bundle was saved. Reopen the AI handoff; the next review prompt asks the AI to make the measured-fit edits in its JSON response.'
              : 'No bundle was saved. Reopen the Local AI job and revise result.json using the app’s measured fit feedback.',
            type: 'error',
          });
          return;
        }
        if (result.status === 'render-retry-required') {
          const retryMessage = result.renderMessage || 'The app could not verify both final page layouts. Retry the render; the AI draft does not need another rewrite.';
          if (!isOrphan) writeImportState({
            ...result.localJob, status: 'render-retry-required',
            message: retryMessage,
          });
          EventLogger.log(`[LocalAI] fallback render-retry-required job=${jobId} card=${nodeId}`);
          offerRenderRetry({
            node,
            jobId,
            resultSha256: result.resultSha256 || result.localJob?.resultSha256 || resultSha256,
            orphanJob,
            message: retryMessage,
            // This is the import currently producing the retry response. Its
            // finally block releases the lock before a rendered action can be
            // clicked, so the durable action can be offered immediately.
            allowCurrentImport: true,
          });
          return;
        }
        if (result.status === 'revision-exhausted') {
          if (!isOrphan) writeImportState({
            ...result.localJob, status: 'revision-exhausted',
            message: result.fitMessage || 'The overflowing document remained unchanged after an explicit diminishing-returns review. No bundle was saved.',
          });
          EventLogger.log(`[LocalAI] fallback revision-exhausted job=${jobId} card=${nodeId}`);
          toast?.({
            title: 'Local AI Diminishing Returns Reached',
            description: 'No bundle was saved. The overflowing document was unchanged and its quality review found no remaining material improvement.',
            type: 'error',
          });
          return;
        }
        const missingArtifacts = Array.isArray(result.missingArtifacts) ? result.missingArtifacts : [];
        const resumeFit = result.resumeFit || null;
        const resumeOverflow = Number.isFinite(resumeFit?.pageCount)
          && Number.isFinite(resumeFit?.targetPageCount)
          && resumeFit.pageCount > resumeFit.targetPageCount;
        // Liveness AGAIN before the save: the measured import can take a
        // minute, and the user may have dismissed the card meanwhile — never
        // auto-save a bundle into Applied Jobs for a job the user discarded.
        if (!isOrphan && !findLiveJobNode(nodeId, jobId)) {
          // importLocalApplication registered this exact workspace under this
          // renderer's sender id. Dispose of that capability-bound workspace
          // now; otherwise a deleted card leaves its private Local AI job
          // folder and imported artifacts behind until retention pruning.
          await window.electronAPI.discardApplication?.({ workDir: result.workDir });
          EventLogger.log(`[LocalAI] fallback abandoning save job=${jobId} card=${nodeId}: card no longer exists`);
          return;
        }
        const saved = await window.electronAPI.saveApplication({
          resumeHtmlPath: result.resumeHtmlPath,
          resumePdfPath: result.resumePdfPath,
          coverLetterPdfPath: result.coverLetterPdfPath,
          jobListingPath: result.jobListingPath,
          generationAuditPath: result.generationAuditPath,
          generationLogPath: result.generationLogPath,
          workDir: result.workDir,
          company: result.company,
          candidateName: result.candidateName,
          jobTitle: isOrphan ? local.job?.title : liveNode.data?.title,
          location: isOrphan ? local.job?.location : liveNode.data?.location,
          canvasFilePath: saveCanvasFilePath,
          // An automatic recovery must not steal focus from the work the user
          // is doing merely because its deleted card's handoff completed.
          suppressReveal: isOrphan,
        });
        if (!saved?.success || !saved.saved) {
          const saveError = new Error(saved?.error || 'Could not save the imported application.');
          if (saved?.errorCode) saveError.code = saved.errorCode;
          throw saveError;
        }
        if (!isCurrentQuitGeneration(generation)) return;
        const savedPatch = {
          status: 'saved',
          message: missingArtifacts.length
            ? `Saved to ${saved.dir}, but ${missingArtifacts.join(' and ')} could not be rendered. Use Repair bundle to retry.`
            : resumeOverflow
              ? `Saved to ${saved.dir}, but the résumé is ${resumeFit.pageCount} pages against its ${resumeFit.targetPageCount}-page layout target.`
              : `Saved to ${saved.dir}`,
          missingArtifacts,
          intermediateCleaned: !missingArtifacts.length,
        };
        if (!isOrphan) {
          savedTerminalRef.current.set(jobId, savedPatch);
          writeImportState(savedPatch, { terminal: true });
        }
        EventLogger.log(`[LocalAI] fallback saved job=${jobId} ${isOrphan ? 'orphaned-card' : `card=${nodeId}`} dir=${saved.dir}`);
        toast?.({
          title: missingArtifacts.length ? 'Local AI Bundle Saved with Missing PDFs' : resumeOverflow ? 'Local AI Application Saved with Length Warning' : 'Local AI Application Saved',
          description: missingArtifacts.length
            ? `Saved editable HTML and listing to ${saved.dir}; ${missingArtifacts.join(' and ')} were unavailable. Use Repair bundle to retry.`
            : resumeOverflow
              ? `Saved the bundle to ${saved.dir}, but the résumé remained ${resumeFit.pageCount} pages after the layout-fit safeguards (target: ${resumeFit.targetPageCount}).`
              : `Saved editable HTML, résumé, cover letter, and listing to ${saved.dir}.`,
          type: missingArtifacts.length || resumeOverflow ? 'error' : 'success',
        });
      } catch (error) {
        if (disposed || !isCurrentQuitGeneration(generation)) return;
        // Read before every branch below, because each of them — including the
        // generic tail — parks this job at 'completed', which is in neither
        // driver's idle list: the next tick would poll the same broken job and
        // start the settle/import cycle again, while the card it belongs to
        // reads as a finished result. Same judgement as the status poll above,
        // from the same helper.
        const broken = brokenLocalAiJobDriveState(error);
        if (broken) {
          statusErrorStreakRef.current.delete(jobId);
          if (!isOrphan) writeImportState(broken);
          EventLogger.log(`[LocalAI] fallback job ended job=${jobId} ${isOrphan ? 'orphaned-card' : `card=${nodeId}`}: ${broken.message}`);
          // The card driving this job is unmounted by definition, so the toast
          // is the only surface that can carry the sentence. Not for an
          // orphan: its card was deleted, and that sentence names an action on
          // a job card — offering it for a folder with no card routes a person
          // to something they cannot press. The log line above keeps the
          // ended folder diagnosable without saying so.
          if (!isOrphan) ctxRef.current.addToast?.({ title: 'Local AI Job Cannot Be Completed', description: broken.message, type: 'error', dedupeKey: `local-ai-broken:${jobId}` });
          return;
        }
        if (error?.code === 'LOCAL_AI_RESULT_CHANGED') {
          settlingRef.current.delete(jobId);
          if (!isOrphan) writeImportState({ status: 'completed', message: 'Local AI saved a newer result — waiting briefly for the final save…' });
          return;
        }
        if (error?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT') {
          if (!isOrphan) writeImportState({ status: 'completed', message: 'Another import of this result is already running — waiting for it to finish.' });
          return;
        }
        if (!isOrphan) writeImportState({ status: 'completed', message: error?.message || String(error) });
        EventLogger.log(`[LocalAI] fallback import failed job=${jobId} ${isOrphan ? 'orphaned-card' : `card=${nodeId}`}: ${error?.message || error}`);
        ctxRef.current.addToast?.({ title: 'Local AI Import Failed', description: error?.message || String(error), type: 'error' });
      } finally {
        importBusyRef.current = false;
        settlingRef.current.delete(jobId);
      }
    };

    const driveJob = async (node, orphanJob = null, generation = currentQuitGeneration()) => {
      const { getCurrentFile: currentFile } = ctxRef.current;
      const local = node.data.localApplication;
      const jobId = local.id;
      const nodeId = node.id;
      const isOrphan = Boolean(orphanJob);
      const writeDriveState = (patch, options = {}) => writeState(nodeId, jobId, patch, {
        ...options,
        generation,
      });
      if (!isCurrentQuitGeneration(generation)) return;
      // A terminal 'saved' this manager already committed may have been lost
      // from state (same-flush navigation swap). Re-assert it rather than
      // polling the save-deleted job dir and misdiagnosing the outcome.
      const savedTerminal = savedTerminalRef.current.get(jobId);
      if (savedTerminal) {
        const live = findLiveJobNode(nodeId, jobId);
        if (!live || live.data.localApplication.status === 'saved') {
          savedTerminalRef.current.delete(jobId);
          return;
        }
        writeDriveState(savedTerminal, { terminal: true });
        return;
      }
      const canvasFilePath = local.canvasFilePath || (currentFile ? currentFile() : null);
      if (!canvasFilePath) return;
      try {
        const statusResult = await window.electronAPI.getLocalApplicationStatus({ jobId, canvasFilePath });
        // The card may have mounted while the IPC round-trip was in flight —
        // it owns the job now.
        if (disposed || !isCurrentQuitGeneration(generation) || isJobCardMounted(nodeId)) return;
        // Same rule as the mounted card: a broken job is terminal, and the
        // throw below would park it in the transient retry loop instead.
        const broken = brokenLocalAiJobDriveState(statusResult);
        if (broken) {
          statusErrorStreakRef.current.delete(jobId);
          settlingRef.current.delete(jobId);
          if (!isOrphan) writeDriveState(broken);
          return;
        }
        if (!statusResult?.success || !statusResult.localJob) throw new Error(statusResult?.error || 'Could not check Local AI job status.');
        statusErrorStreakRef.current.delete(jobId);
        const next = statusResult.localJob;
        if (next.status === 'importing') {
          // Manifest reports a fresh 'imported': a prior import's bundle save
          // is in its time-bounded window. Hold in a waiting state — writing
          // 'importing' into data would misread as a resumable orphan.
          settlingRef.current.delete(jobId);
          writeDriveState({ status: 'completed', message: next.message || 'Another import of this result is finishing — waiting…' });
          return;
        }
        if (next.status === 'render-retry-required') {
          settlingRef.current.delete(jobId);
          const resultSha256 = String(next.resultSha256 || '');
          if (!isOrphan) writeDriveState({ ...next });
          offerRenderRetry({
            node, jobId, resultSha256, orphanJob, message: next.message,
          });
          return;
        }
        if (next.status !== 'completed') {
          settlingRef.current.delete(jobId);
          writeDriveState({ ...next });
          return;
        }
        const resultSha256 = String(next.resultSha256 || '');
        if (!resultSha256) {
          writeDriveState({ ...next, status: 'completed', message: 'Local AI result found — waiting for a stable file snapshot…' });
          return;
        }
        const settled = settlingRef.current.get(jobId);
        const now = Date.now();
        if (!settled || settled.resultSha256 !== resultSha256) {
          settlingRef.current.set(jobId, { resultSha256, observedAt: now });
          writeDriveState({ ...next, status: 'completed', message: 'Local AI result found — waiting briefly for the final save…' });
          return;
        }
        if (now - settled.observedAt < LOCAL_AI_RESULT_SETTLE_MS) return;
        await importJob(node, jobId, resultSha256, orphanJob, generation);
      } catch (error) {
        if (disposed || !isCurrentQuitGeneration(generation)) return;
        const streak = (statusErrorStreakRef.current.get(jobId) || 0) + 1;
        statusErrorStreakRef.current.set(jobId, streak);
        if (streak < LOCAL_AI_STATUS_ERROR_STREAK_LIMIT) return;
        statusErrorStreakRef.current.delete(jobId);
        EventLogger.log(`[LocalAI] fallback poll failed ${LOCAL_AI_STATUS_ERROR_STREAK_LIMIT}x job=${jobId} ${isOrphan ? 'orphaned-card' : `card=${nodeId}`}; retrying: ${error?.message || error}`);
        if (!isOrphan) writeDriveState({ status: 'status-error', message: `${error?.message || String(error)} Retrying automatically…` });
      }
    };

    const tick = async () => {
      if (disposed || tickBusyRef.current) return;
      const generation = currentQuitGeneration();
      if (!isCurrentQuitGeneration(generation)) return;
      const nav = ctxRef.current.navigation;
      if (!nav?.enumerateAllNodes || !window.electronAPI?.getLocalApplicationStatus || !window.electronAPI?.importLocalApplication) return;
      tickBusyRef.current = true;
      try {
        const allNodes = nav.enumerateAllNodes();
        const pending = selectFallbackLocalAiJobs(allNodes);
        // Drive every pending job's status poll CONCURRENTLY rather than one
        // `await` per node in sequence. A poll is a cheap per-jobId read (the
        // main process holds no cross-job lock on it), but driveJob can end in
        // a multi-second measured PDF import; a sequential loop let that one
        // job's import stall every other job's poll for the rest of the tick,
        // and the next tick's no-op on tickBusyRef meant they got NO poll at
        // all until it finished. Concurrency here does not add a second import
        // in flight: importBusyRef still admits exactly one, and every other
        // concurrent driveJob call finds it already claimed and defers to a
        // later tick instead of blocking on this one.
        await Promise.allSettled(pending.map((node) => driveJob(node, null, generation)));
        if (!isCurrentQuitGeneration(generation)) return;
        const canvasFilePath = ctxRef.current.getCurrentFile?.();
        if (!canvasFilePath || !window.electronAPI?.discoverLocalApplications) return;
        let discovery;
        try {
          discovery = await window.electronAPI.discoverLocalApplications({ canvasFilePath });
        } catch (error) {
          EventLogger.log(`[LocalAI] fallback orphan discovery failed: ${error?.message || error}`);
          return;
        }
        if (!discovery?.success || !Array.isArray(discovery.localJobs)) {
          EventLogger.log(`[LocalAI] fallback orphan discovery failed: ${discovery?.error || 'unknown error'}`);
          return;
        }
        // Any card in the full graph owns its exact job, whether mounted or
        // hidden. Only folders with no canvas owner are eligible for automatic
        // recovery; this preserves an explicit card dismissal as a dismissal,
        // not an instruction to recreate UI state.
        const knownJobIds = new Set(allNodes
          .map((node) => node?.data?.localApplication?.id)
          .filter(Boolean));
        const orphaned = selectOrphanedLocalAiJobs(discovery.localJobs, knownJobIds);
        // Same head-of-line hazard applies to orphaned folders discovered for
        // this canvas: nothing about one card-less job's import should hold up
        // another's poll.
        await Promise.allSettled(orphaned.map((orphanJob) => (
          driveJob({ id: null, data: { localApplication: orphanJob } }, orphanJob, generation)
        )));
      } finally {
        tickBusyRef.current = false;
      }
    };

    const interval = window.setInterval(tick, LOCAL_AI_POLL_INTERVAL_MS);
    tick();
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);
}
