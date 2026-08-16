import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { ExternalLink, X, Sparkles, Check } from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { languageLabel } from '../utils/jobLanguageLabels';
import { NodeHandles } from './_shared/NodeHandles';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { computeJobTreeView } from './jobsearch/buildJobTree';
import { deriveBoardCardStats } from './jobboard/mergeJobs';
import { formatSalaryCurrencyLabel } from '../utils/salaryCurrency';

// Accent color encodes the match score (interview-likelihood) band, so the
// card's color reinforces the single metric: greener = better odds. Bands match
// the scoring prompt (85+ strong, 65-84 good chance, 40-64 stretch, <40 unlikely).
function scoreColor(score) {
  if (score >= 85) return '#22c55e'; // green  — genuinely strong
  if (score >= 65) return '#3b82f6'; // blue   — good chance of interview
  if (score >= 40) return '#eab308'; // amber  — stretch / longshot
  return '#6b7280';                  // gray   — unlikely
}

// A cached ledger's in-flight marker (data.achievementsMining, a ms timestamp)
// older than this is treated as stale rather than "still mining" — a crashed
// generation must not wedge the hub into permanently skipping its own mine.
// docs/resume-achievement-mining-design.md §3.6.
const MINING_MARKER_STALE_MS = 5 * 60 * 1000;

/**
 * JobCardNode — a transient, scored job result on the canvas.
 *
 * The workflow is deliberately disposable: search → decide → generate an
 * application (or dismiss the card). There is no status / notes / monitoring CRM
 * here. Whether a job was already *shown* is tracked in a canvas-scoped
 * jobs-history CSV sidecar (written at discovery), so dismissing cards never
 * re-surfaces them on the next search.
 *
 * data shape:
 *   title, company, location, salary, snippet, url, source, posted,
 *   matchScore, reasoning, careerDirection,
 *   hubId,       // the Job Board that spawned this card (owns the cascade)
 *   originHubId, // the Job Search Module whose search found it (owns careerData)
 *   language (optional 2-letter code, set only when non-English → shows a chip)
 */
export const JobCardNode = React.memo(function JobCardNode({ id, data }) {
  const { deleteElements, getNode, getNodes, setNodes, updateNodeData } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const { addToast } = useToast();
  const { acquireModuleRun, cancelQueuedRunsForNode, snapshot: moduleRunSnapshot } = useModuleRunQueue();

  const [showFullReasoning, setShowFullReasoning] = useState(false);
  const [applicationRun, setApplicationRun] = useState({ state: 'idle', position: null });
  const [applied, setApplied] = useState(false);
  const [markingApplied, setMarkingApplied] = useState(false);
  const measuredHeight = useStore(
    useCallback((store) => store.nodeLookup.get(id)?.measured?.height ?? null, [id])
  );
  const previousMeasuredHeightRef = useRef(measuredHeight);

  // Cache id for closure safety + a mounted flag so async settlements after
  // unmount don't setState.
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]);
  const isMountedRef = useIsMountedRef();

  // Reasoning disclosure changes the card's DOM height asynchronously through
  // ResizeObserver. Re-run the tree layout only after a *subsequent* visible
  // measurement change lands in ReactFlow, otherwise a tall card can overlap
  // the card/root below it. Skipping a null → first-measurement transition
  // avoids N reflows when a fresh cascade initially mounts. The same guard also
  // fixes collapse → re-expand: hidden cards unmount and reset this local
  // disclosure state, so an old 308px measurement can legitimately become the
  // normal 210px measurement when the card returns.
  useEffect(() => {
    const previousMeasuredHeight = previousMeasuredHeightRef.current;
    previousMeasuredHeightRef.current = measuredHeight;
    const isVisible = !getNode(id)?.hidden;
    if (!isVisible
      || !Number.isFinite(previousMeasuredHeight)
      || !Number.isFinite(measuredHeight)
      || previousMeasuredHeight === measuredHeight) return;
    const frame = requestAnimationFrame(() => {
      const hubData = getNode(data.hubId)?.data || {};
      setNodes((nodes) => computeJobTreeView(nodes, data.hubId, {
        scoreThreshold: hubData.scoreThreshold ?? 0,
        sourceFilter: hubData.sourceFilter ?? null,
      }, undefined, true));
    });
    return () => cancelAnimationFrame(frame);
  }, [id, measuredHeight, data.hubId, getNode, setNodes]);

  // Local disclosure state is intentionally non-persistent, but report it while
  // mounted so a bug report can explain a measured-height/layout discrepancy.
  useEffect(() => {
    EventLogger.registerNodeState(id, { reasoningExpanded: showFullReasoning });
  }, [id, showFullReasoning]);
  useEffect(() => () => EventLogger.unregisterNodeState(id), [id]);

  // Folder the last successful generation actually wrote artifacts to, so
  // "Mark applied" can record where the résumé/cover letter live. Not part of
  // `data` — the card stays disposable (no status/notes fields persisted), so
  // this is scratch state that resets if the card remounts, matching the
  // "generation ≠ applied" split: nothing here implies an application exists
  // until the user explicitly marks it.
  const lastSavedFolderRef = useRef(null);
  // React state does not disable a button until the next render. Keep a
  // synchronous latch too, so two click events in the same render frame cannot
  // enqueue duplicate applications for this one card.
  const applicationSubmissionRef = useRef(false);
  // Local state is only the fast feedback for this mounted view. The global
  // snapshot is authoritative across a hidden-card unmount/remount, preventing
  // a remounted card from accidentally enqueueing a second application.
  const queuedApplicationRun = moduleRunSnapshot.queued.find((entry) => entry.nodeId === id && entry.kind === 'application');
  const activeApplicationRun = moduleRunSnapshot.active?.nodeId === id && moduleRunSnapshot.active?.kind === 'application';
  const displayedApplicationRun = queuedApplicationRun
    ? { state: 'queued', position: queuedApplicationRun.position }
    : activeApplicationRun ? { state: 'generating', position: null } : applicationRun;
  const hasApplicationRun = displayedApplicationRun.state !== 'idle';
  const salaryCurrencyLabel = useMemo(
    () => formatSalaryCurrencyLabel(data.salary, data.location),
    [data.salary, data.location]
  );

  const score = data.matchScore || 0;
  const accentColor = scoreColor(score);
  // NodeHandles is React.memo'd; an inline object literal here would create a
  // new reference every render and defeat that memoization, unlike every
  // other caller of NodeHandles, which pass only a stable className.
  const handleStyle = useMemo(() => ({ backgroundColor: accentColor }), [accentColor]);

  // Hydrate `applied` from the permanent store on mount (design doc §6.2).
  // `applied` otherwise starts false on every mount and is set ONLY by this
  // card's own optimistic markApplied/unmarkApplied calls — but the store is
  // app-global and outlives the card (a save/reload or app restart remounts
  // the card with fresh, false-defaulting state). Without this check, a job
  // marked applied in a PRIOR session shows "Mark applied" again even though
  // applied-jobs.json still holds the record — silently misrepresenting
  // persisted state back to the user, the exact thing the undo affordance's
  // "never silent" design (§6.2) exists to prevent. Best-effort: a failed
  // check just leaves the optimistic-default false state; it never blocks
  // the card or shows an error, since "not yet confirmed applied" is the
  // safe default to render while unsure.
  useEffect(() => {
    if (!window.electronAPI?.isJobApplied) return;
    let cancelled = false;
    window.electronAPI.isJobApplied({
      job: { title: data.title, company: data.company, location: data.location, url: data.url, source: data.source },
    }).then((result) => {
      if (cancelled || !isMountedRef.current) return;
      if (result?.success && result.applied) setApplied(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [data.title, data.company, data.location, data.url, data.source, isMountedRef]);

  const openJobUrl = useCallback(() => {
    if (data.url && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(data.url);
    }
  }, [data.url]);

  // Dismiss = delete this card, then re-derive the tree view so the column
  // tightens and the role leaf's pagination window backfills the next matching
  // card (the group badges are live via their own store selector). Lock is
  // checked at click time against BOTH this card and the owning board — a
  // render-time read would go stale on already-mounted cards.
  const dismissCard = useCallback(async () => {
    if (data.locked || getNode(data.hubId)?.data?.locked) return;
    // A hidden/collapsed card may unmount while it remains a canvas node, so
    // unmount is not cancellation. Explicit dismissal is: remove only this
    // card's waiting lease; an already-running IPC operation is left intact.
    cancelQueuedRunsForNode(id, 'Job card dismissed before generation started');
    await deleteElements({ nodes: [{ id }] });
    const hubData = getNode(data.hubId)?.data || {};
    const filter = { scoreThreshold: hubData.scoreThreshold ?? 0, sourceFilter: hubData.sourceFilter ?? null };
    setNodes((nodes) => computeJobTreeView(nodes, data.hubId, filter));
    const stats = deriveBoardCardStats(getNodes().filter((node) => node.id !== id), data.hubId, hubData);
    updateGlobal(data.hubId, stats);
    EventLogger.log(`[JobCard] dismissed id=${id} board=${data.hubId} remaining=${stats.resultCount}`);
  }, [id, data.locked, data.hubId, deleteElements, getNode, getNodes, setNodes, updateGlobal, cancelQueuedRunsForNode]);

  // ── Full application (tailored résumé + cover letter HTML) ─────────────────
  // Reads the merged career data from the ORIGIN Job Search Module — the
  // module whose search produced this job (cards are spawned by the Job Board,
  // which merges several modules and holds no career data itself; data.hubId
  // is the board). Not stored per-card, to avoid bloating the canvas file.
  // The backend researches the company, fills the design system, builds the
  // single-file HTML workspace, then writes it straight into
  //   <canvas dir>/Applied Jobs/<company>/<location>/<job title>/
  // and opens that folder in Finder — no save dialog. (Location is part of the
  // path because same title + same company + different city is a DIFFERENT job
  // — see src/utils/locationIdentity.js.)
  const generateApplication = useCallback(async () => {
    if (!window.electronAPI?.generateApplication || applicationSubmissionRef.current || hasApplicationRun) return;
    if (getNode(data.hubId)?.data?.locked) return; // board lock freezes cards too
    const originHubId = data.originHubId || data.hubId;
    // Fast, non-queued validation prevents a known-invalid card from taking a
    // queue turn. This is intentionally re-read after the lease as well: the
    // preflight is only user feedback, never the data used for generation.
    const preflightOriginHub = getNode(originHubId);
    if (!preflightOriginHub?.data?.careerData) {
      addToast({
        title: 'No Career Data',
        description: data.originHubId && !preflightOriginHub
          ? 'The Job Search Module this card came from was deleted, so its career files are gone. Re-run a search and re-combine the board.'
          : 'The origin Job Search Module has no stored career data. Drop your career files on it, re-run the search, then re-combine the board.',
        type: 'error',
      });
      return;
    }
    // Applications are written relative to the saved canvas file, so it must be
    // saved first. Fail loudly rather than dropping the documents somewhere arbitrary.
    if (!(nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile)) {
      addToast({
        title: 'Save Your Canvas First',
        description: 'Applications are saved next to your canvas in an "Applied Jobs" folder. Save the canvas to a file, then try again.',
        type: 'error',
      });
      return;
    }
    applicationSubmissionRef.current = true;
    let lease = null;
    let myMarker = null;
    let cancelledBeforeStart = false;

    setApplicationRun({ state: 'generating', position: null });
    try {
      // Application generation uses the same app-wide capacity-one queue as
      // searches and marketplace runs. LLM quota, Chromium/PDF rendering, and
      // the shared achievement cache make parallel bundles unsafe. Crucially,
      // every mutable input below is read only *after* the lease starts: a
      // card which waited behind another application sees that application's
      // newly cached achievement ledger instead of re-mining it.
      lease = await acquireModuleRun({
        nodeId: id,
        kind: 'application',
        label: `Application: ${data.company || data.title || 'job'}`,
        onQueued: ({ position }) => {
          if (isMountedRef.current) setApplicationRun({ state: 'queued', position });
        },
        onQueueUpdate: ({ position }) => {
          if (isMountedRef.current) setApplicationRun({ state: 'queued', position });
        },
        onStart: () => {
          // Hidden card views can unmount while their node remains valid. Only
          // cancellation/deletion of the actual canvas node skips the work.
          if (!getNode(idRef.current)) {
            cancelledBeforeStart = true;
            throw new Error('Job card was removed before application generation started');
          }
          if (isMountedRef.current) setApplicationRun({ state: 'generating', position: null });
        },
        onCancel: () => {
          cancelledBeforeStart = true;
          if (isMountedRef.current) setApplicationRun({ state: 'idle', position: null });
        },
      });

      // The user could have used Save As while this card was waiting. Re-read
      // only after it owns the lease, then keep this path for the whole save.
      const canvasFilePath = nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile ?? null;
      if (!canvasFilePath) {
        if (isMountedRef.current) {
          addToast({
            title: 'Save Your Canvas First',
            description: 'Applications are saved next to your canvas in an "Applied Jobs" folder. Save the canvas to a file, then try again.',
            type: 'error',
          });
        }
        return;
      }

      const originHub = getNode(originHubId);
      const careerData = originHub?.data?.careerData;
      if (!careerData) {
        addToast({
          title: 'No Career Data',
          description: data.originHubId && !originHub
            ? 'The Job Search Module this card came from was deleted while this application was waiting, so its career files are gone. Re-run a search and re-combine the board.'
            : 'The origin Job Search Module has no stored career data. Drop your career files on it, re-run the search, then re-combine the board.',
          type: 'error',
        });
        return;
      }

      // Achievement ledger pass-through (design doc §3.6). The read and the
      // fencing marker belong inside the lease so the next FIFO card reuses a
      // ledger produced by the previous one rather than racing it.
      const cachedAchievements = originHub.data?.achievements || null;
      const miningMarkerAt = originHub.data?.achievementsMining;
      const markerFresh = typeof miningMarkerAt === 'number' && (Date.now() - miningMarkerAt) < MINING_MARKER_STALE_MS;
      const mineAllowed = !cachedAchievements && !markerFresh;
      if (mineAllowed) {
        myMarker = Date.now();
        updateGlobal(originHubId, { achievementsMining: myMarker });
      }

      addToast({
        title: 'Generating Application',
        description: `Researching ${data.company} and writing your résumé + cover letter…`,
        type: 'info',
      });
      const result = await window.electronAPI.generateApplication({
        nodeId: idRef.current,
        job: {
          title: data.title, company: data.company, snippet: data.snippet,
          location: data.location, salary: data.salary, url: data.url,
          source: data.source, posted: data.posted, language: data.language,
        },
        careerData,
        reasoning: data.reasoning,
        matchScore: data.matchScore,
        achievements: cachedAchievements,
        mineAllowed,
      });
      if (!result.success) {
        if (isMountedRef.current) {
          addToast({ title: 'Generation Failed', description: result.error, type: 'error' });
        }
        return;
      }
      // A freshly mined ledger comes back on the result — cache it on the
      // origin hub so every later application from this hub reuses it instead
      // of re-mining (§2/§3.6).
      if (result.achievements && getNode(originHubId)) {
        updateGlobal(originHubId, { achievements: result.achievements });
      }
      // A view can unmount simply because its branch was hidden; that must not
      // abandon a valid queued application. Only actual card deletion stops
      // post-generation work (the active IPC is independently cancelled by
      // the canvas task cleanup).
      if (!getNode(idRef.current)) {
        // Generation registered this exact workDir with the main process.
        // Dispose it through the sender-bound IPC instead of leaving a temp
        // workspace/pending-artifact entry behind; the renderer cannot pass a
        // raw deletion path to the filesystem.
        try {
          await window.electronAPI.discardApplication?.({ workDir: result.workDir });
        } catch (error) {
          EventLogger.error('Could not discard application workspace after card deletion:', error);
        }
        return;
      }
      // Write the generated documents into ./Applied Jobs/<company>/<location>/<job>/
      // next to the canvas, then reveal that folder in Finder. No picker.
      // The workspace is written as normal sibling files (not a ZIP), so the
      // generated HTML can later Sync a selected edit back into this folder.
      const saved = await window.electronAPI.saveApplication({
        resumeHtmlPath: result.resumeHtmlPath,
        resumePdfPath: result.resumePdfPath,
        coverLetterPdfPath: result.coverLetterPdfPath,
        jobListingPath: result.jobListingPath,
        workDir: result.workDir,
        company: result.company,
        candidateName: result.candidateName,
        jobTitle: data.title,
        location: data.location,
        canvasFilePath,
      });
      if (saved?.success && saved.saved) {
        // Remembered so "Mark applied" can record where the artifacts went —
        // see lastSavedFolderRef's doc-comment.
        if (isMountedRef.current) lastSavedFolderRef.current = saved.dir || null;
        const analysisNote = result.skillOpportunityError
          ? ' The skill-demand analysis was unavailable; the résumé workspace includes the error so this generation is not silently counted.'
          : '';
        if (isMountedRef.current && !saved.bundleError) {
          addToast({
            title: 'Application Workspace Saved',
            description: `Saved editable HTML, résumé, cover letter, and listing to ${saved.dir} — opening its folder.${analysisNote}`,
            type: 'success',
          });
        } else if (isMountedRef.current) {
          addToast({
            title: 'Application Workspace Incomplete',
            description: `${saved.bundleError} The editable HTML was saved to ${saved.dir}.${analysisNote}`,
            type: 'error',
          });
        }
      } else if (saved?.success === false && isMountedRef.current) {
        addToast({ title: 'Save Error', description: saved.error || 'Could not save files', type: 'error' });
      }
    } catch (e) {
      // Explicit dismissal/cancellation is normal control flow, not an error
      // toast. It must also never touch a different card's mining marker.
      if (cancelledBeforeStart) return;
      EventLogger.error('Application generation failed:', e);
      if (isMountedRef.current) {
        addToast({ title: 'Generation Error', description: e?.message || String(e), type: 'error' });
      }
    } finally {
      // Compare-and-clear, not an unconditional clear: only remove the marker
      // if the hub's CURRENT marker still equals the one this call wrote. A
      // boolean "did I set it" flag isn't enough — if this call's mining
      // outlives MINING_MARKER_STALE_MS while still in flight, a second card
      // reads the (still-live) marker as stale and overwrites it with its
      // OWN fresh marker; an unconditional clear here would then null out
      // that second card's marker out from under it the instant this call
      // finishes, opening a window for a THIRD card to see no marker at all
      // and start a third concurrent mine. Only a call that still owns the
      // marker (fencing-token match) may clear it — see myMarker above.
      if (myMarker != null && getNode(originHubId)?.data?.achievementsMining === myMarker) {
        updateGlobal(originHubId, { achievementsMining: null });
      }
      // Release only after both LLM generation and artifact save settle, so a
      // FIFO successor cannot collide with the shared render/save resources.
      lease?.release();
      applicationSubmissionRef.current = false;
      if (isMountedRef.current) setApplicationRun({ state: 'idle', position: null });
    }
  }, [data.hubId, data.originHubId, data.title, data.company, data.snippet, data.location, data.salary, data.url, data.source, data.posted, data.language, data.reasoning, data.matchScore, id, getNode, nav, updateGlobal, addToast, isMountedRef, acquireModuleRun, hasApplicationRun]);

  // ── Mark applied (design doc §6.2) ──────────────────────────────────────
  // Generate NEVER auto-marks: generating a résumé is not the same as
  // submitting it, so this is a separate explicit action. Marking does not
  // delete the card — the user deletes when they want. The store this writes
  // to is permanent and app-global (unlike the canvas-scoped, self-expiring
  // seen-jobs CSV), so a misclick makes a posting invisible across every
  // canvas forever with no way to reach it again once the card is gone —
  // which is why the undo affordance stays visible on the button itself
  // rather than being tucked behind a confirm dialog or a second click target.
  const markApplied = useCallback(async () => {
    if (!window.electronAPI?.markJobApplied || data.locked) return;
    setMarkingApplied(true);
    try {
      // handleSafe (electron/ipc/ipcUtils.js) converts a THROWN backend error
      // (e.g. a full disk, a permissions error, or appliedJobs.js's own
      // deliberate throw on a corrupt hand-edited store) into a RESOLVED
      // `{ success: false, error }` — it never rejects the promise. Awaiting
      // without checking `result.success` used to fall straight through to
      // setApplied(true) on every failure: the button would read "Applied"
      // while the on-disk record was never written, so the job would keep
      // resurfacing in future searches despite the UI's explicit claim that
      // it never would again.
      const result = await window.electronAPI.markJobApplied({
        job: { title: data.title, company: data.company, location: data.location, url: data.url, source: data.source },
        folder: lastSavedFolderRef.current || undefined,
      });
      if (!isMountedRef.current) return;
      if (!result?.success) {
        addToast({ title: 'Could Not Mark Applied', description: result?.error || 'Unknown error', type: 'error' });
        return;
      }
      setApplied(true);
    } catch (e) {
      if (!isMountedRef.current) return;
      EventLogger.error('Mark applied failed:', e);
      addToast({ title: 'Could Not Mark Applied', description: e?.message || String(e), type: 'error' });
    } finally {
      if (isMountedRef.current) setMarkingApplied(false);
    }
  }, [data.locked, data.title, data.company, data.location, data.url, data.source, addToast, isMountedRef]);

  const unmarkApplied = useCallback(async () => {
    if (!window.electronAPI?.unmarkJobApplied || data.locked) return;
    setMarkingApplied(true);
    try {
      // Same result-check as markApplied above, mirrored — a failed undo must
      // not silently report success either (the button would read "Mark
      // applied" while the permanent record is still on disk, hiding the job
      // from every future search with no indication anything went wrong).
      const result = await window.electronAPI.unmarkJobApplied({
        job: { title: data.title, company: data.company, location: data.location, url: data.url, source: data.source },
      });
      if (!isMountedRef.current) return;
      if (!result?.success) {
        addToast({ title: 'Could Not Undo', description: result?.error || 'Unknown error', type: 'error' });
        return;
      }
      setApplied(false);
    } catch (e) {
      if (!isMountedRef.current) return;
      EventLogger.error('Unmark applied failed:', e);
      addToast({ title: 'Could Not Undo', description: e?.message || String(e), type: 'error' });
    } finally {
      if (isMountedRef.current) setMarkingApplied(false);
    }
  }, [data.locked, data.title, data.company, data.location, data.url, data.source, addToast, isMountedRef]);

  return (
    <div
      className="w-[280px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden group"
      style={{ borderColor: accentColor + '55' }}
    >
      <NodeHandles className="w-2 h-2" style={handleStyle} />

      {/* Header */}
      <div className="px-3 py-2 flex items-start gap-2 border-b border-white/5">
        <div
          className="shrink-0 mt-0.5 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ backgroundColor: accentColor + '20', color: accentColor }}
        >
          {score}%
        </div>
        <div className="flex-1 min-w-0 pr-6 relative">
          <div className="text-white/90 text-sm font-semibold leading-tight truncate">{data.title || 'Untitled'}</div>
          <div className="text-white/50 text-xs mt-0.5 truncate">{data.company}{data.location ? ` · ${data.location}` : ''}</div>
          {data.salary && (
            <div className="text-emerald-400/80 text-xs mt-0.5">
              <span>{data.salary}</span>
              <span className="text-emerald-300/60" title={salaryCurrencyLabel.includes('inferred') ? 'Salary currency inferred from the job location' : 'Salary currency stated explicitly in the listing, when available'}>
                {' · '}{salaryCurrencyLabel}
              </span>
            </div>
          )}

          <button
            onClick={data.locked ? undefined : () => dismissCard()}
            disabled={!!data.locked}
            className={`absolute top-0 -right-2 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-all ${
              data.locked ? 'hidden' : 'text-white/30 hover:text-red-400 hover:bg-white/10'
            }`}
            title="Dismiss Job"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Source + posted + open listing */}
      <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px]">
        {data.source && (
          <span className="text-white/30 uppercase tracking-wider">{data.source}</span>
        )}
        {data.language && data.language !== 'en' && (
          <span
            className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300/90 uppercase tracking-wider"
            title={`Listing is in ${languageLabel(data.language)} — kept & scored as-is; applying is your call`}
          >
            {data.language}
          </span>
        )}
        {data.posted && <span className="text-white/20">{data.posted}</span>}
        {data.url && (
          <button
            onClick={(e) => { e.stopPropagation(); openJobUrl(); }}
            className="ml-auto -my-1 p-1 text-white/30 hover:text-white/70 transition-colors"
            title="Open job listing"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      {/* AI match justification — the full text from the scorer is preserved; we
          clamp it so every card keeps a consistent height, and let the user click
          to expand and read it all (then click again to collapse). */}
      {data.reasoning && (
        <div
          className={`px-3 py-1.5 text-white/45 text-xs leading-relaxed border-t border-white/5 cursor-pointer hover:text-white/60 transition-colors ${showFullReasoning ? '' : 'line-clamp-3'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const nextExpanded = !showFullReasoning;
            setShowFullReasoning(nextExpanded);
            EventLogger.log(`[JobCard] reasoning ${nextExpanded ? 'expanded' : 'collapsed'} id=${id}`);
          }}
          title={showFullReasoning ? 'Show less' : 'Show full reasoning'}
        >
          {data.reasoning}
        </div>
      )}

      {/* Generate full application (always visible, tailored résumé + cover letter)
          beside Mark Applied — an explicit, separate action recording that the
          user actually submitted it. Generation never flips this on its own. */}
      <div className="px-3 py-2 border-t border-white/5 flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
        <button
          onClick={data.locked ? undefined : (e) => { e.stopPropagation(); generateApplication(); }}
          disabled={hasApplicationRun || !!data.locked}
          className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
            data.locked
              ? 'bg-white/5 text-white/20 cursor-default'
              : 'bg-gradient-to-r from-emerald-500/15 to-blue-500/15 text-emerald-300 hover:from-emerald-500/25 hover:to-blue-500/25 hover:text-emerald-200 disabled:opacity-50'
          }`}
          title={displayedApplicationRun.state === 'queued'
            ? `Queued at position ${displayedApplicationRun.position} — application generation runs one at a time to protect model quota and document rendering.`
            : 'AI researches the company, then writes a tailored résumé + cover letter and saves both to your Applied Jobs folder'}
        >
          <Sparkles size={13} className={hasApplicationRun ? 'animate-pulse' : ''} />
          {displayedApplicationRun.state === 'queued'
            ? `Queued · #${displayedApplicationRun.position}`
            : displayedApplicationRun.state === 'generating' ? 'Generating…' : 'Generate'}
        </button>

        {/* The trailing "Undo" IS the undo affordance — it must stay visible
            after marking, not collapse to a plain checkmark and not hide behind
            hover, because this store is permanent and global: one misclick
            makes a posting invisible across every canvas forever with no way to
            reach it once the card is gone (design doc §6.2). State and action
            are split by a hairline rule and carried by ONE glyph (the Check
            icon) — the label says what is true, the rule says the rest of the
            button is a second thing you can do to it, and the red hover says
            which direction that goes. */}
        <button
          onClick={data.locked ? undefined : (e) => { e.stopPropagation(); applied ? unmarkApplied() : markApplied(); }}
          disabled={markingApplied || !!data.locked}
          className={`shrink-0 flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50 ${
            data.locked
              ? 'bg-white/5 text-white/20 cursor-default'
              : applied
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-red-500/15 hover:text-red-300'
                : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70'
          }`}
          title={applied
            ? 'Marked applied — this is remembered permanently across every canvas so this posting never resurfaces in a future search. Click to undo.'
            : 'Record that you actually submitted this application (separate from generating it) — remembered permanently so it never resurfaces in a future search'}
        >
          {applied ? (
            <>
              <Check size={12} className="shrink-0" />
              Applied
              <span className="shrink-0 w-px h-3 bg-current opacity-25" aria-hidden="true" />
              <span className="opacity-70">Undo</span>
            </>
          ) : 'Mark applied'}
        </button>
      </div>
    </div>
  );
});
