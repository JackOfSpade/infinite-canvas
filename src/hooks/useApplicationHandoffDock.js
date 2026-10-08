import { useEffect, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { LOCAL_AI_POLL_INTERVAL_MS, jobIntegrityFailureMessage } from '../utils/localAiFallback';
import {
  selectApplicationHandoffCandidates,
  applicationDockItemState,
  applicationDockRequest,
  brokenApplicationDockRequest,
  workingApplicationDockRequest,
  publishApplicationHandoffs,
  getApplicationHandoffs,
  retainUnreadableApplicationItems,
  subscribeApplicationHandoffRefresh,
} from '../utils/applicationHandoffDock';
import { HANDOFF_CONCURRENCY, mapAutomaticHandoffs } from '../utils/handoffScheduler';

// getLocalApplicationHandoff takes withLocalAiJobMutationLock on the job folder
// it reads (electron/ipc/localAiApplication.js) — a real filesystem lock, not an
// in-memory status check. LOCAL_AI_POLL_INTERVAL_MS (2.5s, localAiFallback.js) is
// tuned for that cheap in-memory poll; running the SAME cadence here would mean
// up to HANDOFF_CONCURRENCY lock round trips every 2.5 seconds even while
// nobody has touched the dock. Real-time pickup instead comes from the two other
// triggers below (a refresh event fires the instant a paste actually advances a
// stage, and the id-set check below reacts within one poll tick to a brand-new
// bundle) — this interval only has to catch what neither of those sees, such as
// a canvas reopened after its jobs progressed while the window was closed. 20
// seconds keeps that safety net cheap while still being far faster than the
// person's own copy/run/paste cycle in an external AI chat.
const APPLICATION_DISCOVERY_INTERVAL_MS = 20_000;

// A stable key for "which jobs are candidates right now", independent of their
// order. Used only to notice that the SET changed — comparing this needs no IPC,
// so it can run on every cheap poll tick without the lock cost noted above.
const candidateIdSignature = (candidates) => (
  candidates.map((node) => node.data.localApplication.id).sort().join(',')
);

/**
 * Canvas-level discovery for application bundles waiting on a pasted response.
 *
 * JobCardNode used to own a full-screen modal per job; that modal is gone, and
 * the global dock (NonApiAiDialog, mounted in App.jsx outside the canvas
 * provider tree) renders the queue instead. Something still has to find which
 * jobs are mid-handoff and read their current stage prompt, because the dock
 * has no canvas node data of its own — that is this hook's only job. It never
 * submits, validates, or mutates a job; see src/utils/applicationHandoffDock.js
 * for the shared item shape and the store this hook publishes into.
 *
 * Modeled on useLocalAiFallbackManager: a ctxRef holds live props so the
 * mount-once effect below always reads current values, and a busy ref keeps
 * two discovery passes from overlapping.
 */
export function useApplicationHandoffDock({ navigation, getCurrentFile }) {
  const ctxRef = useRef({ navigation, getCurrentFile });
  useEffect(() => {
    ctxRef.current = { navigation, getCurrentFile };
  }, [navigation, getCurrentFile]);

  const tickBusyRef = useRef(false);
  // The candidate id signature as of the last completed pass, so the cheap
  // per-tick check below can tell "a job newly needs a slot" apart from "the
  // same jobs are still pending" without paying for an IPC round trip.
  const knownCandidateIdsRef = useRef('');
  // Refresh requests that arrived while a discovery pass was already running.
  const queuedRefreshRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    // Ids of bundles the person just discarded, until no card points at them.
    const discardedJobIds = new Set();

    // Every field an IPC call needs, pre-resolved so the fan-out map below is
    // pure: `local.canvasFilePath` is preferred (an application job binds to
    // the canvas it was generated on, even if the person later opens another
    // window) and getCurrentFile() is the fallback for a job created before
    // that field existed.
    const resolveCanvasFilePath = (local) => local.canvasFilePath || ctxRef.current.getCurrentFile?.() || null;

    const discover = async (onlyJobId = null) => {
      if (disposed) return;
      if (tickBusyRef.current) {
        // A refresh raised while a pass is already running must not be
        // dropped: the dock asks for one the instant it submits a response,
        // and losing it strands the just-answered prompt on screen until the
        // slow safety interval comes round. Remember what was asked for and
        // run it when this pass finishes. A pending full refresh outranks a
        // single-job one, because it already covers that job.
        const queued = queuedRefreshRef.current;
        queuedRefreshRef.current = (queued && queued.all) || !onlyJobId
          ? { all: true, jobIds: new Set() }
          : { all: false, jobIds: new Set([...(queued?.jobIds || []), onlyJobId]) };
        return;
      }
      const nav = ctxRef.current.navigation;
      if (!nav?.enumerateAllNodes || !window.electronAPI?.getLocalApplicationHandoff) return;
      tickBusyRef.current = true;
      try {
        let allNodes;
        try {
          allNodes = nav.enumerateAllNodes();
        } catch (error) {
          // Leave the previously published queue untouched — an enumeration
          // hiccup is not evidence that every pending bundle vanished.
          EventLogger.log(`[ApplicationDock] node enumeration failed: ${error?.message || error}`);
          return;
        }
        let candidates = selectApplicationHandoffCandidates(allNodes);
        knownCandidateIdsRef.current = candidateIdSignature(candidates);
        // A bundle the person just discarded is gone from disk, but this pass
        // enumerates nodes from a ref that only catches up after React
        // commits the pointer clear, so the card can still look like a
        // candidate for a moment. Reading it logged a false ERROR in the main
        // process right after every normal discard. Once no card points at the
        // id any more, the guard has done its job and is dropped.
        const pointedAtIds = new Set(candidates.map((node) => node.data.localApplication.id));
        for (const id of discardedJobIds) if (!pointedAtIds.has(id)) discardedJobIds.delete(id);
        if (discardedJobIds.size) candidates = candidates.filter((node) => !discardedJobIds.has(node.data.localApplication.id));
        // A single-job refresh (the dock just submitted a response and asked
        // to re-read the outcome) only needs that one job re-fetched — every
        // other candidate keeps whatever was published for it last pass, so a
        // person mid-paste on a different prompt never sees their chip move.
        const toFetch = onlyJobId
          ? candidates.filter((node) => node.data.localApplication.id === onlyJobId)
          : candidates;

        const previousItems = getApplicationHandoffs();
        const previousByJobId = new Map(previousItems.map((item) => [item.jobId, item]));

        // Do not truncate backlog to the visible/live worker count. Reads use
        // the same rolling scheduler as automatic handoffs: a completed read
        // refills one slot while every later durable bundle remains queued.
        const fetched = await mapAutomaticHandoffs(toFetch, HANDOFF_CONCURRENCY, async (node) => {
          const local = node.data.localApplication;
          const canvasFilePath = resolveCanvasFilePath(local);
          try {
            const result = await window.electronAPI.getLocalApplicationHandoff({ jobId: local.id, canvasFilePath });
            // A job whose own frozen state is broken takes no further paste,
            // but it must not vanish either: the card still advertises a
            // pending bundle, so the dock has to say why it cannot be
            // finished and name the action that replaces it. The dock renders
            // this same state when submit() meets the identical fault.
            const integrityMessage = jobIntegrityFailureMessage(result);
            if (integrityMessage) {
              return [local.id, brokenApplicationDockRequest({ node, message: integrityMessage, canvasFilePath })];
            }
            // A genuinely failed read (the IPC resolved but reported no
            // success) is not evidence the bundle finished or changed state —
            // it contributes no item this pass, exactly as before. This is
            // distinct from a thrown IPC call, which the catch below flags
            // `unreadable` and carries the previous item forward instead.
            // The main process answered that this job's folder is gone (a
            // discard or prune it recorded itself). Nothing to show, and not
            // a failed read.
            if (result?.gone === true) return [local.id, null];
            // A read that resolved unsuccessfully is NOT the same as a thrown
            // IPC call: handleSafe turns every main-process error into a
            // resolved { success: false }, so the catch below can never see a
            // transient EBUSY/EACCES. Keep the previous prompt (flagged) so a
            // person mid-paste does not lose it to a momentary failure; only a
            // missing folder is evidence the bundle is really gone.
            if (!result?.success) {
              const stale = previousByJobId.get(local.id);
              return [local.id, stale && result?.errorCode !== 'ENOENT' ? { ...stale, unreadable: true } : null];
            }
            // The read succeeded but there is no prompt in it: either the
            // app's own post-accept work is running, or the result is
            // blocked on a card-side retry. Both are still candidates (this
            // job's own status was not idle), so both must keep occupying
            // their slot and their ordinal — a working item, not nothing —
            // or the number a person is watching for would come free the
            // instant a save started, mid-render, and could be handed to a
            // different bundle before this one is actually done.
            if (result.completed || !result.handoff) {
              // Classify on the status the MAIN PROCESS just read, never on
              // node.data's copy. That copy is written by a 2.5s card poll
              // that accepting a response does not trigger — so the refresh a
              // submit fires arrives while it still reads the PRE-submit
              // status, lands on 'waiting', and drops the chip for a whole
              // discovery interval. That is the exact disappearance this
              // branch exists to stop, and reading the stale copy would
              // reintroduce it while looking correct. `localJob.status` is
              // manifest.status, read from disk inside this same call.
              const freshStatus = result.localJob?.status || local.status;
              const workingState = applicationDockItemState(freshStatus);
              if (workingState === 'working' || workingState === 'blocked') {
                return [local.id, workingApplicationDockRequest({
                  node, canvasFilePath, status: freshStatus,
                  retryReproducesFailure: result.localJob?.retryReproducesFailure === true,
                })];
              }
              // Past the paste phase with no prompt, and a status that has
              // not caught up even in the manifest: the paste machine has
              // already said there is nothing left to paste, so the app is
              // working on it. Only an explicitly idle status ends the entry.
              if (result.completed && workingState !== 'idle') {
                return [local.id, workingApplicationDockRequest({ node, canvasFilePath, status: 'paste-completed' })];
              }
              // Idle: the job settled between the candidate scan above and
              // this read. Contributes nothing — the same outcome as a job
              // that was never a candidate at all.
              return [local.id, null];
            }
            return [local.id, applicationDockRequest({ node, handoff: result.handoff, canvasFilePath })];
          } catch (error) {
            EventLogger.log(`[ApplicationDock] discovery read failed job=${local.id}: ${error?.message || error}`);
            // The job is still on disk and still pending; only the read
            // failed. Carry the last published item forward, flagged, rather
            // than evicting a prompt the person may be mid-paste on.
            const stale = previousByJobId.get(local.id);
            return [local.id, stale ? { ...stale, unreadable: true } : null];
          }
        });
        if (disposed) return;
        const fetchedByJobId = new Map(fetched);

        const nextItems = [];
        for (const node of candidates) {
          const jobId = node.data.localApplication.id;
          if (fetchedByJobId.has(jobId)) {
            const item = fetchedByJobId.get(jobId);
            if (item) nextItems.push(item);
            // else: this pass actually read the job and found it genuinely
            // settled to idle (not merely working or blocked), or hit an
            // unrecoverable first-ever read with no stale item to carry
            // forward — contributes nothing, deliberately.
          } else {
            // Not part of this pass's fetch (a single-job refresh skipped
            // it, or the fan-out cap dropped it) — keep its last item as-is.
            const stale = previousByJobId.get(jobId);
            if (stale) nextItems.push(stale);
          }
        }

        // Safety net for the case the two loops above cannot see: a job that
        // was already flagged unreadable and then fell out of `candidates`
        // entirely this pass. retainUnreadableApplicationItems is the shared
        // rule for "keep it anyway" so this hook and any other reader of the
        // store agree on it.
        // Scoped to the jobs still pending this pass: a bundle that settled
        // through its own poll or import leaves the candidate list and is
        // never re-read here, so without this an unreadable flag would carry
        // it forward on every pass for the life of the canvas.
        const candidateJobIds = new Set(candidates.map((node) => node.data.localApplication.id));
        publishApplicationHandoffs(retainUnreadableApplicationItems(nextItems, previousItems, candidateJobIds));
      } finally {
        tickBusyRef.current = false;
        // Run whatever was asked for while this pass held the guard. Cleared
        // before dispatching so the follow-up pass can itself queue another.
        const queued = queuedRefreshRef.current;
        queuedRefreshRef.current = null;
        if (queued && !disposed) {
          if (queued.all) void discover(null);
          else for (const jobId of queued.jobIds) void discover(jobId);
        }
      }
    };

    // Cheap, IPC-free check: has the SET of pending jobs changed since the
    // last pass? A brand-new bundle (Generate just started one) or a
    // discarded one should not wait for the slow safety interval above to
    // appear or disappear from the dock.
    const checkCandidateIds = () => {
      if (disposed || tickBusyRef.current) return;
      const nav = ctxRef.current.navigation;
      if (!nav?.enumerateAllNodes) return;
      let signature;
      try {
        signature = candidateIdSignature(selectApplicationHandoffCandidates(nav.enumerateAllNodes()));
      } catch {
        return; // Same enumeration hiccup as above; the next tick retries.
      }
      if (signature !== knownCandidateIdsRef.current) void discover();
    };

    // Discarding a bundle is two halves: the dock removes the durable job
    // folder, and the card's pointer must be cleared or the fallback manager
    // keeps driving a job whose folder is gone. JobCardNode listens for this
    // too, but only while it is MOUNTED — and a card hidden by a collapsed
    // group, a board filter, or another nested-canvas level is exactly the
    // case the dock exists to serve. This manager is mounted for the whole
    // canvas, so it clears the pointer whether or not a card is watching.
    const handleDiscarded = (event) => {
      const { jobId, nodeId } = event?.detail || {};
      if (!jobId || !nodeId || disposed) return;
      discardedJobIds.add(jobId);
      const nav = ctxRef.current.navigation;
      if (!nav?.updateNodeDataGlobally) return;
      nav.updateNodeDataGlobally(nodeId, (node) => {
        const live = node?.data?.localApplication;
        // Only the bundle this discard targeted: a card that has already
        // queued a replacement must keep it. A mounted card may win this
        // race and clear it first, which makes this a no-op rather than a
        // second write.
        return live?.id === jobId ? { localApplication: null } : null;
      });
      void discover();
    };
    document.addEventListener('application-handoff-discarded', handleDiscarded);

    const idCheckInterval = window.setInterval(checkCandidateIds, LOCAL_AI_POLL_INTERVAL_MS);
    const safetyInterval = window.setInterval(() => { void discover(); }, APPLICATION_DISCOVERY_INTERVAL_MS);
    const unsubscribeRefresh = subscribeApplicationHandoffRefresh((jobId) => { void discover(jobId); });
    void discover();

    return () => {
      disposed = true;
      window.clearInterval(idCheckInterval);
      window.clearInterval(safetyInterval);
      unsubscribeRefresh();
      document.removeEventListener('application-handoff-discarded', handleDiscarded);
      // A stale queue must not outlive the canvas that discovered it — the
      // dock has no other signal that this canvas unmounted.
      publishApplicationHandoffs([]);
    };
  }, []);
}
