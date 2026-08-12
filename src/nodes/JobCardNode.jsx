import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { ExternalLink, X, Sparkles, Check } from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { languageLabel } from '../utils/jobLanguageLabels';
import { NodeHandles } from './_shared/NodeHandles';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { computeJobTreeView } from './jobsearch/buildJobTree';

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
  const { deleteElements, getNode, setNodes, updateNodeData } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const { addToast } = useToast();

  const [showFullReasoning, setShowFullReasoning] = useState(false);
  const [generatingApp, setGeneratingApp] = useState(false);
  const [applied, setApplied] = useState(false);
  const [markingApplied, setMarkingApplied] = useState(false);

  // Cache id for closure safety + a mounted flag so async settlements after
  // unmount don't setState.
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]);
  const isMountedRef = useIsMountedRef();

  // Folder the last successful generation actually wrote artifacts to, so
  // "Mark applied" can record where the résumé/cover letter live. Not part of
  // `data` — the card stays disposable (no status/notes fields persisted), so
  // this is scratch state that resets if the card remounts, matching the
  // "generation ≠ applied" split: nothing here implies an application exists
  // until the user explicitly marks it.
  const lastSavedFolderRef = useRef(null);

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
    await deleteElements({ nodes: [{ id }] });
    const hubData = getNode(data.hubId)?.data || {};
    const filter = { scoreThreshold: hubData.scoreThreshold ?? 0, sourceFilter: hubData.sourceFilter ?? null };
    setNodes((nodes) => computeJobTreeView(nodes, data.hubId, filter));
  }, [id, data.locked, data.hubId, deleteElements, getNode, setNodes]);

  // ── Full application (tailored résumé + cover letter HTML) ─────────────────
  // Reads the merged career data from the ORIGIN Job Search Module — the
  // module whose search produced this job (cards are spawned by the Job Board,
  // which merges several modules and holds no career data itself; data.hubId
  // is the board). Not stored per-card, to avoid bloating the canvas file.
  // The backend researches the company, fills the design system, builds both
  // self-contained HTML documents, then writes them straight into
  //   <canvas dir>/Applied Jobs/<company>/<location>/<job title>/
  // and opens that folder in Finder — no save dialog. (Location is part of the
  // path because same title + same company + different city is a DIFFERENT job
  // — see src/utils/locationIdentity.js.)
  const generateApplication = useCallback(async () => {
    if (!window.electronAPI?.generateApplication) return;
    if (getNode(data.hubId)?.data?.locked) return; // board lock freezes cards too
    const originHubId = data.originHubId || data.hubId;
    const originHub = getNode(originHubId);
    const careerData = originHub?.data?.careerData;
    if (!careerData) {
      addToast({
        title: 'No Career Data',
        description: data.originHubId && !originHub
          ? 'The Job Search Module this card came from was deleted, so its career files are gone. Re-run a search and re-combine the board.'
          : 'The origin Job Search Module has no stored career data. Drop your career files on it, re-run the search, then re-combine the board.',
        type: 'error',
      });
      return;
    }
    // Applications are written relative to the saved canvas file, so it must be
    // saved first. Fail loudly rather than dropping the documents somewhere arbitrary.
    const canvasFilePath = nav?.currentFile || null;
    if (!canvasFilePath) {
      addToast({
        title: 'Save Your Canvas First',
        description: 'Applications are saved next to your canvas in an "Applied Jobs" folder. Save the canvas to a file, then try again.',
        type: 'error',
      });
      return;
    }
    // Achievement ledger pass-through (design doc §3.6). Mining is job-independent
    // and cached on the ORIGIN hub, not per-card, so the same derived figures
    // ("cut debt 74%") are reused by every application generated from this hub
    // instead of being re-derived — and potentially re-derived DIFFERENTLY —
    // each time. If two cards from the same hub hit Generate around the same
    // moment, both would otherwise see no cached ledger, both mine, and the hub
    // would keep whichever write lands last: the two applications would then
    // carry independently-derived numbers for the same underlying fact, which
    // is exactly the failure hub-caching exists to prevent. The in-flight
    // marker (data.achievementsMining, a ms timestamp) makes the second card
    // see mining already underway and skip it, falling back to careerData alone
    // for that one application rather than racing. A marker older than
    // MINING_MARKER_STALE_MS is ignored so a crashed run can't wedge the hub.
    const cachedAchievements = originHub?.data?.achievements || null;
    const miningMarkerAt = originHub?.data?.achievementsMining;
    const markerFresh = typeof miningMarkerAt === 'number' && (Date.now() - miningMarkerAt) < MINING_MARKER_STALE_MS;
    const mineAllowed = !cachedAchievements && !markerFresh;
    // Fencing token, not a boolean: the exact timestamp THIS call writes.
    // Compared against the hub's CURRENT marker at clear-time (below) so a
    // call only ever removes the marker it itself owns — see the finally
    // block's comment for the concurrent-mine window this closes.
    let myMarker = null;
    if (mineAllowed) {
      myMarker = Date.now();
      updateGlobal(originHubId, { achievementsMining: myMarker });
    }

    setGeneratingApp(true);
    try {
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
        },
        careerData,
        achievements: cachedAchievements,
        mineAllowed,
      });
      if (!isMountedRef.current) return;
      if (!result.success) {
        addToast({ title: 'Generation Failed', description: result.error, type: 'error' });
        return;
      }
      // A freshly mined ledger comes back on the result — cache it on the
      // origin hub so every later application from this hub reuses it instead
      // of re-mining (§2/§3.6).
      if (result.achievements) {
        updateGlobal(originHubId, { achievements: result.achievements });
      }
      // Write both HTML documents into ./Applied Jobs/<company>/<location>/<job>/
      // next to the canvas, then reveal that folder in Finder. No picker.
      const saved = await window.electronAPI.saveApplication({
        resumeHtmlPath: result.resumeHtmlPath,
        coverHtmlPath: result.coverHtmlPath,
        workDir: result.workDir,
        company: result.company,
        candidateName: result.candidateName,
        jobTitle: data.title,
        location: data.location,
        canvasFilePath,
      });
      if (!isMountedRef.current) return;
      if (saved?.success && saved.saved) {
        // Remembered so "Mark applied" can record where the artifacts went —
        // see lastSavedFolderRef's doc-comment.
        lastSavedFolderRef.current = saved.dir || null;
        addToast({ title: 'Application Saved', description: `Résumé + cover letter saved to ${saved.dir} — opening in Finder.`, type: 'success' });
      } else if (saved?.success === false) {
        addToast({ title: 'Save Error', description: saved.error || 'Could not save files', type: 'error' });
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      EventLogger.error('Application generation failed:', e);
      addToast({ title: 'Generation Error', description: e?.message || String(e), type: 'error' });
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
      if (isMountedRef.current) setGeneratingApp(false);
    }
  }, [data.hubId, data.originHubId, data.title, data.company, data.snippet, data.location, data.salary, data.url, getNode, nav, updateGlobal, addToast, isMountedRef]);

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
      // setApplied(true) on every failure: the button would read "Applied ✓"
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
          {data.salary && <div className="text-emerald-400/80 text-xs mt-0.5">{data.salary}</div>}

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
          onClick={(e) => { e.stopPropagation(); setShowFullReasoning(v => !v); }}
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
          disabled={generatingApp || !!data.locked}
          className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
            data.locked
              ? 'bg-white/5 text-white/20 cursor-default'
              : 'bg-gradient-to-r from-emerald-500/15 to-blue-500/15 text-emerald-300 hover:from-emerald-500/25 hover:to-blue-500/25 hover:text-emerald-200 disabled:opacity-50'
          }`}
          title="AI researches the company, then writes a tailored résumé + cover letter and saves both to your Applied Jobs folder"
        >
          <Sparkles size={13} className={generatingApp ? 'animate-pulse' : ''} />
          {generatingApp ? 'Generating…' : 'Generate'}
        </button>

        {/* "Applied ✓ · undo" IS the undo affordance — it must stay visible
            after marking, not collapse to a plain checkmark, because this store
            is permanent and global: one misclick makes a posting invisible
            across every canvas forever with no way to reach it once the card
            is gone (design doc §6.2). */}
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
          {applied ? <><Check size={12} /> Applied ✓ · undo</> : 'Mark applied'}
        </button>
      </div>
    </div>
  );
});
