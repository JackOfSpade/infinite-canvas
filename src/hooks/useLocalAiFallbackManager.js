import { useEffect, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';
import {
  LOCAL_AI_POLL_INTERVAL_MS,
  LOCAL_AI_RESULT_SETTLE_MS,
  LOCAL_AI_STATUS_ERROR_STREAK_LIMIT,
  isJobCardMounted,
  selectFallbackLocalAiJobs,
} from '../utils/localAiFallback';

/**
 * Canvas-level driver for pending Local AI application jobs whose JobCardNode
 * is NOT mounted. Mounted cards poll and import on their own; but hidden cards
 * unmount — a board hiding stale results, a collapsed group, or nested-canvas
 * navigation — which used to silently kill the poll while Claude Code sat
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
export function useLocalAiFallbackManager({ navigation, getCurrentFile, addToast, nudgePersistence }) {
  const ctxRef = useRef({ navigation, getCurrentFile, addToast, nudgePersistence });
  useEffect(() => {
    ctxRef.current = { navigation, getCurrentFile, addToast, nudgePersistence };
  }, [navigation, getCurrentFile, addToast, nudgePersistence]);

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
  const tickBusyRef = useRef(false);
  // One measured import at a time across all jobs — each renders PDFs.
  const importBusyRef = useRef(false);

  useEffect(() => {
    let disposed = false;

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
    const writeState = (nodeId, jobId, patch, { terminal = false } = {}) => {
      if (disposed) return false;
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

    const importJob = async (node, jobId, resultSha256) => {
      const { addToast: toast, getCurrentFile: currentFile } = ctxRef.current;
      const nodeId = node.id;
      if (importBusyRef.current) return;
      // Liveness: the card may have been dismissed/deleted since this tick's
      // enumeration — never import (and auto-save into Applied Jobs) a job the
      // user discarded.
      const liveNode = findLiveJobNode(nodeId, jobId);
      if (!liveNode || isJobCardMounted(nodeId)) return;
      const local = liveNode.data.localApplication;
      // The save writes the bundle beside the currently open canvas file, the
      // same way the card does; without one there is nowhere to save.
      const saveCanvasFilePath = currentFile ? currentFile() : null;
      if (!saveCanvasFilePath) {
        writeState(nodeId, jobId, { status: 'completed', message: 'Save this canvas, then reopen this card to import the completed result.' });
        return;
      }
      importBusyRef.current = true;
      writeState(nodeId, jobId, { status: 'importing', message: 'Claude Code result found — importing…' });
      EventLogger.log(`[LocalAI] fallback import start job=${jobId} card=${nodeId} (card unmounted)`);
      try {
        const imported = await window.electronAPI.importLocalApplication({
          jobId,
          canvasFilePath: local.canvasFilePath || saveCanvasFilePath,
          expectedResultSha256: resultSha256,
        });
        if (disposed) return;
        if (!imported?.success || !imported.localApplication) {
          const importError = new Error(imported?.error || 'Could not import the Local AI result.');
          if (imported?.errorCode) importError.code = imported.errorCode;
          throw importError;
        }
        const result = imported.localApplication;
        if (result.status === 'revision-required') {
          writeState(nodeId, jobId, {
            ...result.localJob, status: 'revision-required',
            message: result.fitMessage || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine; it will use fit-feedback.json to prioritize the strongest evidence and argument.',
          });
          EventLogger.log(`[LocalAI] fallback revision-required job=${jobId} card=${nodeId}`);
          toast?.({
            title: 'Local AI Document Revision Needed',
            description: 'No bundle was saved. Reopen the Local AI job and revise result.json using the app’s measured fit feedback.',
            type: 'error',
          });
          return;
        }
        if (result.status === 'render-retry-required') {
          writeState(nodeId, jobId, {
            ...result.localJob, status: 'render-retry-required',
            message: result.renderMessage || 'The app could not verify both final page layouts. Retry the render; the AI draft does not need another rewrite.',
          });
          EventLogger.log(`[LocalAI] fallback render-retry-required job=${jobId} card=${nodeId}`);
          toast?.({
            title: 'Local AI Layout Check Unavailable',
            description: 'No bundle was saved and no AI revision was requested. Retry when PDF rendering and web fonts are available.',
            type: 'error',
          });
          return;
        }
        if (result.status === 'revision-exhausted') {
          writeState(nodeId, jobId, {
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
        if (!findLiveJobNode(nodeId, jobId)) {
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
          workDir: result.workDir,
          company: result.company,
          candidateName: result.candidateName,
          jobTitle: liveNode.data?.title,
          location: liveNode.data?.location,
          canvasFilePath: saveCanvasFilePath,
        });
        if (!saved?.success || !saved.saved) throw new Error(saved?.error || 'Could not save the imported application.');
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
        savedTerminalRef.current.set(jobId, savedPatch);
        writeState(nodeId, jobId, savedPatch, { terminal: true });
        EventLogger.log(`[LocalAI] fallback saved job=${jobId} card=${nodeId} dir=${saved.dir}`);
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
        if (disposed) return;
        if (error?.code === 'LOCAL_AI_RESULT_CHANGED') {
          settlingRef.current.delete(jobId);
          writeState(nodeId, jobId, { status: 'completed', message: 'Claude Code saved a newer result — waiting briefly for the final save…' });
          return;
        }
        if (error?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT') {
          writeState(nodeId, jobId, { status: 'completed', message: 'Another import of this result is already running — waiting for it to finish.' });
          return;
        }
        writeState(nodeId, jobId, { status: 'completed', message: error?.message || String(error) });
        EventLogger.log(`[LocalAI] fallback import failed job=${jobId} card=${nodeId}: ${error?.message || error}`);
        ctxRef.current.addToast?.({ title: 'Local AI Import Failed', description: error?.message || String(error), type: 'error' });
      } finally {
        importBusyRef.current = false;
        settlingRef.current.delete(jobId);
      }
    };

    const driveJob = async (node) => {
      const { getCurrentFile: currentFile } = ctxRef.current;
      const local = node.data.localApplication;
      const jobId = local.id;
      const nodeId = node.id;
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
        writeState(nodeId, jobId, savedTerminal, { terminal: true });
        return;
      }
      const canvasFilePath = local.canvasFilePath || (currentFile ? currentFile() : null);
      if (!canvasFilePath) return;
      try {
        const statusResult = await window.electronAPI.getLocalApplicationStatus({ jobId, canvasFilePath });
        // The card may have mounted while the IPC round-trip was in flight —
        // it owns the job now.
        if (disposed || isJobCardMounted(nodeId)) return;
        if (!statusResult?.success || !statusResult.localJob) throw new Error(statusResult?.error || 'Could not check Local AI job status.');
        statusErrorStreakRef.current.delete(jobId);
        const next = statusResult.localJob;
        if (next.status === 'importing') {
          // Manifest reports a fresh 'imported': a prior import's bundle save
          // is in its time-bounded window. Hold in a waiting state — writing
          // 'importing' into data would misread as a resumable orphan.
          settlingRef.current.delete(jobId);
          writeState(nodeId, jobId, { status: 'completed', message: next.message || 'Another import of this result is finishing — waiting…' });
          return;
        }
        if (next.status !== 'completed') {
          settlingRef.current.delete(jobId);
          writeState(nodeId, jobId, { ...next });
          return;
        }
        const resultSha256 = String(next.resultSha256 || '');
        if (!resultSha256) {
          writeState(nodeId, jobId, { ...next, status: 'completed', message: 'Claude Code result found — waiting for a stable file snapshot…' });
          return;
        }
        const settled = settlingRef.current.get(jobId);
        const now = Date.now();
        if (!settled || settled.resultSha256 !== resultSha256) {
          settlingRef.current.set(jobId, { resultSha256, observedAt: now });
          writeState(nodeId, jobId, { ...next, status: 'completed', message: 'Claude Code result found — waiting briefly for the final save…' });
          return;
        }
        if (now - settled.observedAt < LOCAL_AI_RESULT_SETTLE_MS) return;
        await importJob(node, jobId, resultSha256);
      } catch (error) {
        if (disposed) return;
        const streak = (statusErrorStreakRef.current.get(jobId) || 0) + 1;
        statusErrorStreakRef.current.set(jobId, streak);
        if (streak < LOCAL_AI_STATUS_ERROR_STREAK_LIMIT) return;
        statusErrorStreakRef.current.delete(jobId);
        EventLogger.log(`[LocalAI] fallback poll failed ${LOCAL_AI_STATUS_ERROR_STREAK_LIMIT}x job=${jobId} card=${nodeId}; retrying: ${error?.message || error}`);
        writeState(nodeId, jobId, { status: 'status-error', message: `${error?.message || String(error)} Retrying automatically…` });
      }
    };

    const tick = async () => {
      if (disposed || tickBusyRef.current) return;
      const nav = ctxRef.current.navigation;
      if (!nav?.enumerateAllNodes || !window.electronAPI?.getLocalApplicationStatus || !window.electronAPI?.importLocalApplication) return;
      tickBusyRef.current = true;
      try {
        const pending = selectFallbackLocalAiJobs(nav.enumerateAllNodes());
        for (const node of pending) {
          if (disposed) return;
          await driveJob(node);
        }
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
