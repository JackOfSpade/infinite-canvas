import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { ExternalLink, X, Sparkles, Check, ChevronDown } from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { languageLabel } from '../utils/jobLanguageLabels';
import { NodeHandles } from './_shared/NodeHandles';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { computeJobTreeView, normalizeCompensationAssessment } from './jobsearch/buildJobTree';
import { deriveBoardCardStats } from './jobboard/mergeJobs';
import { formatSalaryCurrencyLabel } from '../utils/salaryCurrency';
import { normalizeExternalHttpUrl } from '../utils/urlSafety';
import { LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_RESULT_SETTLE_MS, LOCAL_AI_STATUS_ERROR_STREAK_LIMIT, registerMountedJobCard, unregisterMountedJobCard } from '../utils/localAiFallback';
import { canRegenerateLocalApplication, canSaveImportedLocalApplication, queuedLocalApplicationSettlement } from '../utils/localAiApplicationLifecycle';

// Accent color encodes the hiring-fit band: a compact evidence-based assessment
// of full-process fit, not a guaranteed hiring outcome.
function scoreColor(score) {
  if (score >= 85) return '#22c55e'; // green  — strong hiring fit
  if (score >= 65) return '#3b82f6'; // blue   — solid hiring fit
  if (score >= 40) return '#eab308'; // amber  — partial/stretch hiring fit
  return '#6b7280';                  // gray   — limited hiring fit
}

const COMPENSATION_BORDER_COLORS = {
  competitive: '#22c55e',
  below_market: '#ef4444',
};

function compensationLabel(status) {
  if (status === 'competitive') return 'Competitive cash pay';
  if (status === 'below_market') return 'Likely below-market cash pay';
  if (status === 'uncertain') return 'Cash-pay comparison uncertain';
  return 'Cash pay not evaluated';
}

function cashRangeLabel(range) {
  const min = typeof range?.min === 'number' && Number.isFinite(range.min) ? range.min : null;
  const max = typeof range?.max === 'number' && Number.isFinite(range.max) ? range.max : null;
  if (min === null && max === null) return '';
  const currency = String(range?.currency || '').trim().toUpperCase();
  const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (amount) => `${currency ? `${currency} ` : ''}${formatter.format(amount)}`;
  const values = min !== null && max !== null && min !== max
    ? `${money(min)}–${money(max)}`
    : money(max ?? min);
  const period = String(range?.period || '').trim().toLowerCase();
  return `${values}${period ? ` / ${period}` : ''}`;
}

function researchedDateLabel(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function compactAuditLabels(rows, limit) {
  const unique = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = String(row?.requirement || row?.requirementText || '').replace(/\s+/g, ' ').trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    unique.push(label.slice(0, 180));
  }
  return { items: unique.slice(0, limit), overflow: Math.max(0, unique.length - limit), total: unique.length };
}

function materialGapStatus(row) {
  const status = String(row?.status || row?.effectiveStatus || '').trim().toLowerCase().replace(/-/g, '_');
  // Prior audited cards used "missing" to mean that the supplied career data
  // did not establish the requirement. Preserve that evidence-based meaning;
  // it was never proof that the candidate did not have the experience.
  if (status === 'not_documented' || status === 'missing') return 'not_documented';
  if (status === 'contradicted') return 'contradicted';
  if (status === 'unclear') return 'unclear';
  return 'review';
}

function compactMaterialGaps(rows, limit) {
  const groups = {
    not_documented: [],
    contradicted: [],
    unclear: [],
    review: [],
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const requirement = String(row?.requirement || row?.requirementText || '').replace(/\s+/g, ' ').trim();
    if (!requirement) continue;
    const status = materialGapStatus(row);
    const duplicate = groups[status].some(item => item.requirement.toLowerCase() === requirement.toLowerCase());
    if (!duplicate) groups[status].push({ requirement: requirement.slice(0, 180) });
  }
  return Object.fromEntries(Object.entries(groups).map(([status, items]) => [status, {
    items: items.slice(0, limit),
    overflow: Math.max(0, items.length - limit),
    total: items.length,
  }]));
}

function evidenceConfirmationQuestion(requirement) {
  const cleanRequirement = String(requirement).replace(/[?.!]+$/, '').trim();
  return `Do you have experience with ${cleanRequirement} that is not yet included in your career data?`;
}

// Only the normalized audit is eligible for this disclosure. In particular,
// raw model reasoning and rejected evidence never reach this presentation.
function compactHiringFitAudit(data) {
  const assessment = data?.fitAssessment;
  if (!assessment || typeof assessment !== 'object' || assessment.auditStatus !== 'audited') return null;
  const strengths = compactAuditLabels(assessment.strengths, 2);
  const materialGaps = compactMaterialGaps(assessment.materialGaps, 3);
  const effectiveConfidence = String(assessment.confidence?.effective || data?.confidence?.effective || '').toLowerCase();
  const confidence = ['high', 'medium', 'low'].includes(effectiveConfidence) ? effectiveConfidence : '';
  const rawScore = Number(assessment.rawScore ?? data?.rawScore);
  const adjustedScore = Number(assessment.adjustedScore ?? data?.adjustedScore ?? data?.matchScore);
  const calibrated = Number.isFinite(rawScore) && Number.isFinite(adjustedScore) && rawScore !== adjustedScore
    ? { rawScore, adjustedScore }
    : null;
  const materialGapTotal = Object.values(materialGaps).reduce((total, group) => total + group.total, 0);
  if (!strengths.total && !materialGapTotal && !confidence && !calibrated) return null;
  return { strengths, materialGaps, confidence, calibrated };
}

// Claude Code often makes a sequence of atomic edits while composing one
// revision. Import only after the same complete result has survived a few poll
// cycles, otherwise a valid intermediate JSON document can be measured as if
// it were the author's final revision. (LOCAL_AI_RESULT_SETTLE_MS lives in
// utils/localAiFallback.js — the canvas-level fallback manager shares it.)

/**
 * JobCardNode — a transient, scored job result on the canvas.
 *
 * The workflow is deliberately disposable: search → decide → generate an
 * application (or dismiss the card). There is no status / monitoring CRM here;
 * an optional job-specific note is carried only into that application's prompt.
 * Whether a job was already *shown* is tracked in a canvas-scoped
 * jobs-history CSV sidecar (written at discovery), so dismissing cards never
 * re-surfaces them on the next search.
 *
 * data shape:
 *   title, company, location, salary, snippet, url, source, posted,
 *   matchScore, reasoning, careerDirection,
 *   requirementAssessments, materialGaps, strengths, experienceAssessment,
 *   confidence, fitAssessment, rawScore, adjustedScore, adjustments, calibration,
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
  const [showCompensationDetails, setShowCompensationDetails] = useState(false);
  const [applicationRun, setApplicationRun] = useState({ state: 'idle', position: null });
  // Local AI is deliberately a human-in-the-loop workflow. The durable job
  // folder is authoritative; this persisted pointer lets a remounted card
  // reconnect without implying that an application was submitted.
  const [localApplication, setLocalApplication] = useState(() => {
    const saved = data.localApplication || null;
    // An Electron restart can interrupt the renderer after status changed but
    // before import settled. The on-disk job/result remains safe to validate
    // again, so resume it as a retryable completed job rather than leaving the
    // card permanently stuck on a transient "importing" label.
    return saved?.status === 'importing'
      ? { ...saved, status: 'completed', message: 'Resuming Local AI result import after restart…' }
      : saved;
  });
  const [applied, setApplied] = useState(false);
  const [markingApplied, setMarkingApplied] = useState(false);
  // Per-job context, deliberately separate from the originating hub's career
  // data: a candidate can add a relevant personal project or team-fit detail
  // without mutating the career corpus used by every other job card.
  const [additionalNotes, setAdditionalNotes] = useState(data.additionalNotes || '');
  const measuredHeight = useStore(
    useCallback((store) => store.nodeLookup.get(id)?.measured?.height ?? null, [id])
  );
  const previousMeasuredHeightRef = useRef(measuredHeight);

  // Cache id for closure safety + a mounted flag so async settlements after
  // unmount don't setState.
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]);
  const isMountedRef = useIsMountedRef();
  // React Flow only knows the active canvas level. A card can unmount because
  // its parent level is no longer active while still existing in the global
  // navigation stack, so async lifecycle checks must prefer that complete
  // graph over a current-level getNode lookup.
  const getLiveJobCard = useCallback((nodeId) => {
    const globalNode = nav?.enumerateAllNodes?.().find((node) => node.id === nodeId);
    return globalNode || getNode(nodeId);
  }, [nav, getNode]);

  // While mounted, this card is the sole driver of its Local AI job — the
  // canvas-level fallback manager (useLocalAiFallbackManager) consults this
  // registry and stands down. Registration must span the whole mounted
  // lifetime, not just phases with a pending job.
  useEffect(() => {
    registerMountedJobCard(id);
    return () => unregisterMountedJobCard(id);
  }, [id]);

  const localApplicationKey = JSON.stringify(localApplication);
  useEffect(() => {
    if (JSON.stringify(data.localApplication || null) !== localApplicationKey) {
      // Ownership handover: if the fallback manager finished a save while this
      // card was unmounted-or-racing, the terminal 'saved' state arrives via
      // data. Adopt it — clobbering it back would resurrect a job whose
      // directory the completed save already removed.
      const external = data.localApplication;
      if (external?.status === 'saved' && external?.id && external.id === localApplication?.id && localApplication?.status !== 'saved') {
        setLocalApplication(external);
        return;
      }
      // Functional patch: this effect runs after paint, so `data` here is
      // commit-stale — the manager's terminal 'saved' can land in the gap and
      // both writes batch on the same store. Deciding against the LIVE node
      // (deepUpdateNode runs function patches at apply time; null = no-op)
      // makes the clobber impossible; the adoption branch above then picks the
      // 'saved' up on the next effect pass.
      const cardState = localApplication || null;
      updateGlobal(id, (node) => {
        const live = node?.data?.localApplication;
        if (live?.status === 'saved' && live?.id && live.id === cardState?.id && cardState?.status !== 'saved') return null;
        return { localApplication: cardState };
      });
    }
  }, [id, data.localApplication, localApplication, localApplicationKey, updateGlobal]);

  // Match and compensation disclosures change the card's DOM height
  // asynchronously through ResizeObserver. Re-run the tree layout only after a
  // *subsequent* visible measurement change lands in ReactFlow, otherwise a
  // tall card can overlap the card/root below it. Skipping a null →
  // first-measurement transition avoids N reflows when a fresh cascade initially
  // mounts. The same guard also fixes collapse → re-expand: hidden cards unmount
  // and reset this local disclosure state, so an old 308px measurement can
  // legitimately become the normal 210px measurement when the card returns.
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
    EventLogger.registerNodeState(id, {
      reasoningExpanded: showFullReasoning,
      compensationExpanded: showCompensationDetails,
    });
  }, [id, showFullReasoning, showCompensationDetails]);
  useEffect(() => () => EventLogger.unregisterNodeState(id), [id]);

  // Folder the last successful generation actually wrote artifacts to, so
  // "Mark applied" can record where the résumé/cover letter live. Not part of
  // `data` — the card stays disposable (no status/notes fields persisted), so
  // this is scratch state that resets if the card remounts, matching the
  // "generation ≠ applied" split: nothing here implies an application exists
  // until the user explicitly marks it.
  const lastSavedFolderRef = useRef(null);
  // Poll ticks and React state propagation can overlap by a frame. This latch
  // ensures a completed local result is imported exactly once.
  const localImportingRef = useRef(new Set());
  const localResultSettlingRef = useRef(new Map());
  // jobId → consecutive status-poll failures. The visible `status-error`
  // state remains pollable, so a transient filesystem/IPC issue cannot orphan
  // a pending handoff.
  const localStatusErrorStreakRef = useRef(new Map());
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
  const localJobPending = !!localApplication && !canRegenerateLocalApplication(localApplication);
  const salaryCurrencyLabel = useMemo(
    () => formatSalaryCurrencyLabel(data.salary, data.location),
    [data.salary, data.location]
  );
  const compensationAssessment = useMemo(
    () => normalizeCompensationAssessment(data.compensationAssessment),
    [data.compensationAssessment]
  );
  const compensationSourceLinks = useMemo(() => compensationAssessment.sourceLinks
    .map((source) => ({ ...source, safeUrl: normalizeExternalHttpUrl(source.url) }))
    .filter((source) => source.safeUrl), [compensationAssessment]);
  const hiringFitAudit = useMemo(() => compactHiringFitAudit(data), [data]);

  const score = data.matchScore || 0;
  const accentColor = scoreColor(score);
  const compensationBorderColor = COMPENSATION_BORDER_COLORS[compensationAssessment.status] || 'rgba(255,255,255,0.12)';
  const hasExpandedDisclosure = showFullReasoning || showCompensationDetails;
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
    const url = normalizeExternalHttpUrl(data.url);
    if (url && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    }
  }, [data.url]);

  const openResearchSource = useCallback((rawUrl) => {
    const url = normalizeExternalHttpUrl(rawUrl);
    if (url && window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
  }, []);

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

  // A completed Local AI job is converted into the exact same capability-bound
  // workspace that the API flow creates, then saved through saveApplication.
  // The renderer never receives a raw arbitrary path to save.
  const importCompletedLocalApplication = useCallback(async (jobId, expectedResultSha256 = '') => {
    if (!jobId || !window.electronAPI?.importLocalApplication || !window.electronAPI?.saveApplication) return;
    // The queued job remains owned by the canvas location that created it.
    // Preserve that path across app restarts and Save As operations so polling
    // cannot accidentally jump to another canvas's .local-ai folder.
    const queuedCanvasFilePath = localApplication?.canvasFilePath || null;
    const canvasFilePath = nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile ?? null;
    if (!canvasFilePath) {
      setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: 'Save this canvas, then reopen this card to import the completed result.' } : current);
      return;
    }
    setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'importing', message: 'Importing Claude Code result…' } : current);
    try {
      const imported = await window.electronAPI.importLocalApplication({
        jobId,
        canvasFilePath: queuedCanvasFilePath || canvasFilePath,
        expectedResultSha256,
      });
      if (!imported?.success || !imported.localApplication) {
        const importError = new Error(imported?.error || 'Could not import the Local AI result.');
        if (imported?.errorCode) importError.code = imported.errorCode;
        throw importError;
      }
      const local = imported.localApplication;
      if (local.status === 'revision-required') {
        if (isMountedRef.current) {
          setLocalApplication((current) => current?.id === jobId ? {
            ...current, ...local.localJob,
            status: 'revision-required',
            message: local.fitMessage || 'The résumé or cover letter exceeded its measured page target. Re-run the Local AI routine; it will use fit-feedback.json to prioritize the strongest evidence and argument.',
          } : current);
          addToast({
            title: 'Local AI Document Revision Needed',
            description: 'No bundle was saved. Reopen the Local AI job and revise result.json using the app’s measured fit feedback.',
            type: 'error',
          });
        }
        return;
      }
      if (local.status === 'render-retry-required') {
        if (isMountedRef.current) {
          setLocalApplication((current) => current?.id === jobId ? {
            ...current, ...local.localJob,
            status: 'render-retry-required',
            message: local.renderMessage || 'The app could not verify both final page layouts. Retry the render; the AI draft does not need another rewrite.',
          } : current);
          addToast({
            title: 'Local AI Layout Check Unavailable',
            description: 'No bundle was saved and no AI revision was requested. Retry when PDF rendering and web fonts are available.',
            type: 'error',
          });
        }
        return;
      }
      if (local.status === 'revision-exhausted') {
        if (isMountedRef.current) {
          setLocalApplication((current) => current?.id === jobId ? {
            ...current, ...local.localJob,
            status: 'revision-exhausted',
            message: local.fitMessage || 'The overflowing document remained unchanged after an explicit diminishing-returns review. No bundle was saved.',
          } : current);
          addToast({
            title: 'Local AI Diminishing Returns Reached',
            description: 'No bundle was saved. The overflowing document was unchanged and its quality review found no remaining material improvement.',
            type: 'error',
          });
        }
        return;
      }
      const missingArtifacts = Array.isArray(local.missingArtifacts) ? local.missingArtifacts : [];
      const resumeFit = local.resumeFit || null;
      const resumeOverflow = Number.isFinite(resumeFit?.pageCount)
        && Number.isFinite(resumeFit?.targetPageCount)
        && resumeFit.pageCount > resumeFit.targetPageCount;
      // Import can take long enough for a user to dismiss this card. Hiding a
      // card merely unmounts it and its node remains live; an explicit delete
      // must instead discard the exact sender-owned workspace before it can
      // be promoted into Applied Jobs.
      if (!canSaveImportedLocalApplication(getLiveJobCard(idRef.current), jobId)) {
        await window.electronAPI.discardApplication?.({ workDir: local.workDir });
        EventLogger.log(`[LocalAI] discarded imported workspace job=${jobId}: card was removed before save`);
        return;
      }
      const saved = await window.electronAPI.saveApplication({
        resumeHtmlPath: local.resumeHtmlPath,
        resumePdfPath: local.resumePdfPath,
        coverLetterPdfPath: local.coverLetterPdfPath,
        jobListingPath: local.jobListingPath,
        workDir: local.workDir,
        company: local.company,
        candidateName: local.candidateName,
        jobTitle: data.title,
        location: data.location,
        canvasFilePath,
      });
      if (!saved?.success || !saved.saved) throw new Error(saved?.error || 'Could not save the imported application.');
      if (isMountedRef.current) {
        lastSavedFolderRef.current = saved.dir || null;
        setLocalApplication((current) => current?.id === jobId ? {
          ...current,
          status: 'saved',
          message: missingArtifacts.length
            ? `Saved to ${saved.dir}, but ${missingArtifacts.join(' and ')} could not be rendered. Use Repair bundle to retry.`
            : resumeOverflow
              ? `Saved to ${saved.dir}, but the résumé is ${resumeFit.pageCount} pages against its ${resumeFit.targetPageCount}-page layout target.`
            : `Saved to ${saved.dir}`,
          missingArtifacts,
          intermediateCleaned: !missingArtifacts.length,
        } : current);
        addToast({
          title: missingArtifacts.length ? 'Local AI Bundle Saved with Missing PDFs' : resumeOverflow ? 'Local AI Application Saved with Length Warning' : 'Local AI Application Saved',
          description: missingArtifacts.length
            ? `Saved editable HTML and listing to ${saved.dir}; ${missingArtifacts.join(' and ')} were unavailable. Use Repair bundle to retry.`
            : resumeOverflow
              ? `Saved the bundle to ${saved.dir}, but the résumé remained ${resumeFit.pageCount} pages after the layout-fit safeguards (target: ${resumeFit.targetPageCount}).`
            : `Saved editable HTML, résumé, cover letter, and listing to ${saved.dir} — opening its folder.`,
          type: missingArtifacts.length || resumeOverflow ? 'error' : 'success',
        });
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      if (error?.code === 'LOCAL_AI_RESULT_CHANGED') {
        setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: 'Claude Code saved a newer result — waiting briefly for the final save…' } : current);
        return;
      }
      if (error?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT') {
        // The canvas-level fallback manager (or an earlier request) already
        // holds the per-job import lock in the main process. Wait quietly —
        // its terminal 'saved' state arrives through data and is adopted.
        setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: 'Another import of this result is already running — waiting for it to finish.' } : current);
        return;
      }
      setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: error?.message || String(error) } : current);
      addToast({ title: 'Local AI Import Failed', description: error?.message || String(error), type: 'error' });
    }
  }, [nav, data.title, data.location, localApplication?.canvasFilePath, addToast, getLiveJobCard, isMountedRef]);

  // Claude Code writes result.json manually/asynchronously. Polling only reads
  // that app-owned job; after a short stable-result window, the import happens
  // once the result validates.
  useEffect(() => {
    const jobId = localApplication?.id;
    if (!jobId || !window.electronAPI?.getLocalApplicationStatus || LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes(localApplication.status)) return undefined;
    const canvasFilePath = localApplication?.canvasFilePath
      || (nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile ?? null);
    let cancelled = false;
    const check = async () => {
      try {
        const result = await window.electronAPI.getLocalApplicationStatus({ jobId, canvasFilePath });
        if (cancelled || !isMountedRef.current) return;
        if (!result?.success || !result.localJob) throw new Error(result?.error || 'Could not check Local AI job status.');
        localStatusErrorStreakRef.current.delete(jobId);
        const next = result.localJob;
        if (next.status === 'importing') {
          // Manifest reports a fresh 'imported': another driver's import
          // finished and its bundle save is in its time-bounded window. Keep
          // polling in a waiting state — adopting 'importing' into card state
          // would stop this poll — until the terminal 'saved' arrives via data
          // adoption or the window resolves the status.
          localResultSettlingRef.current.delete(jobId);
          setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: next.message || 'Another import of this result is finishing — waiting…' } : current);
          return;
        }
        if (next.status === 'completed') {
          const resultSha256 = String(next.resultSha256 || '');
          // Status always supplies the exact file hash. Without it, stay in a
          // safe ready state instead of treating an unknown snapshot as final.
          if (!resultSha256) {
            setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'completed', message: 'Claude Code result found — waiting for a stable file snapshot…' } : current);
            return;
          }
          const settled = localResultSettlingRef.current.get(jobId);
          const now = Date.now();
          if (!settled || settled.resultSha256 !== resultSha256) {
            localResultSettlingRef.current.set(jobId, { resultSha256, observedAt: now });
            setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'completed', message: 'Claude Code result found — waiting briefly for the final save…' } : current);
            return;
          }
          if (now - settled.observedAt < LOCAL_AI_RESULT_SETTLE_MS) return;
          if (localImportingRef.current.has(jobId)) return;
          localImportingRef.current.add(jobId);
          setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'importing', message: 'Claude Code result found — importing…' } : current);
          try {
            await importCompletedLocalApplication(jobId, resultSha256);
          } finally {
            localImportingRef.current.delete(jobId);
            localResultSettlingRef.current.delete(jobId);
          }
        } else {
          localResultSettlingRef.current.delete(jobId);
          setLocalApplication((current) => current?.id === jobId ? { ...current, ...next } : current);
        }
      } catch (error) {
        if (cancelled || !isMountedRef.current) return;
        // Same transient tolerance as the fallback manager: one status hiccup
        // (e.g. a canvas re-save renaming files under the resolver) must not
        // park the handoff in a terminal state.
        const streak = (localStatusErrorStreakRef.current.get(jobId) || 0) + 1;
        localStatusErrorStreakRef.current.set(jobId, streak);
        if (streak < LOCAL_AI_STATUS_ERROR_STREAK_LIMIT) return;
        localStatusErrorStreakRef.current.delete(jobId);
        setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'status-error', message: `${error?.message || String(error)} Retrying automatically…` } : current);
      }
    };
    check();
    const interval = window.setInterval(check, 2500);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [localApplication?.id, localApplication?.status, localApplication?.canvasFilePath, nav, importCompletedLocalApplication, isMountedRef]);

  // ── Full application (tailored résumé + cover letter HTML) ─────────────────
  // Reads the merged career data from the ORIGIN Job Search Module — the
  // module whose search produced this job (cards are spawned by the Job Board,
  // which merges several modules and holds no career data itself; data.hubId
  // is the board). Not stored per-card, to avoid bloating the canvas file.
  // Application Generate always writes a self-contained Local AI handoff next
  // to the saved canvas. The Claude Code routine produces the documents, then
  // the existing polling/import path validates and saves the final bundle.
  const generateApplication = useCallback(async () => {
    if (!window.electronAPI?.queueLocalApplication || applicationSubmissionRef.current || hasApplicationRun || localJobPending) return;
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
    let cancelledBeforeStart = false;

    setApplicationRun({ state: 'generating', position: null });
    try {
      // Handoff creation uses the same app-wide capacity-one queue as searches
      // and marketplace runs. Crucially, every mutable input below is read
      // only after the lease starts, so queued work sees the latest canvas
      // state before it materializes its durable job folder.
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
          if (!getLiveJobCard(idRef.current)) {
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

      // Preserve an already-mined achievement ledger in the handoff context.
      // Local application generation never runs the API achievement-mining
      // pass; the routine can use this durable context when it is available.
      const cachedAchievements = originHub.data?.achievements || null;
      const mineAllowed = !cachedAchievements;
      // A terminal handoff remains on the card as the audit/repair pointer.
      // Snapshot the exact one this click intends to replace; settlement will
      // accept it only if the live card still owns the same terminal id/status.
      // That permits regeneration without allowing a late response to clobber
      // a genuinely newer in-flight handoff.
      const expectedPriorLocalApplication = getLiveJobCard(idRef.current)?.data?.localApplication || null;
      const queued = await window.electronAPI.queueLocalApplication({
        nodeId: idRef.current,
        canvasFilePath,
        job: {
          title: data.title, company: data.company, snippet: data.snippet,
          location: data.location, salary: data.salary, url: data.url,
          source: data.source, posted: data.posted, language: data.language,
        },
        careerData,
        additionalNotes: additionalNotes.trim(),
        reasoning: data.reasoning,
        matchScore: data.matchScore,
        achievements: cachedAchievements,
        mineAllowed,
      });
      if (!queued?.success || !queued.localJob) {
        throw new Error(queued?.error || 'Could not prepare the local application job.');
      }
      // Hiding/collapsing unmounts this component but leaves its canvas node
      // intact. Persist the durable pointer directly into the live node before
      // consulting mounted state, so the canvas-level fallback manager can
      // keep driving that handoff. A card genuinely deleted during this IPC
      // owns neither the pointer nor its private job directory, so delete the
      // exact app-owned handoff rather than leaving private career context
      // behind until retention pruning.
      const settlement = queuedLocalApplicationSettlement(
        getLiveJobCard(idRef.current),
        queued.localJob,
        expectedPriorLocalApplication,
      );
      if (settlement.action !== 'persist') {
        await window.electronAPI.discardLocalApplication?.({
          jobId: queued.localJob.id,
          canvasFilePath: queued.localJob.canvasFilePath || canvasFilePath,
        });
        EventLogger.log(`[LocalAI] discarded queued handoff job=${queued.localJob.id}: ${settlement.reason || 'card no longer owns it'}`);
        return;
      }
      EventLogger.log(`[LocalAI] accepted queued handoff job=${queued.localJob.id} replacing=${expectedPriorLocalApplication?.id || 'none'} priorStatus=${expectedPriorLocalApplication?.status || 'none'}`);
      updateGlobal(idRef.current, (node) => {
        const liveSettlement = queuedLocalApplicationSettlement(node, queued.localJob, expectedPriorLocalApplication);
        return liveSettlement.action === 'persist' ? { localApplication: queued.localJob } : null;
      });
      if (isMountedRef.current) {
        setLocalApplication(queued.localJob);
        addToast({
          title: 'Application Job Ready',
          description: 'The job is beside this canvas under .local-ai/jobs. Run your Claude Code routine there; this card will import the completed application automatically.',
          type: 'success',
        });
      }
    } catch (e) {
      // Explicit dismissal/cancellation is normal control flow, not an error
      // toast.
      if (cancelledBeforeStart) return;
      EventLogger.error('Application generation failed:', e);
      if (isMountedRef.current) {
        addToast({ title: 'Generation Error', description: e?.message || String(e), type: 'error' });
      }
    } finally {
      // The lease only covers durable handoff creation. Claude Code execution,
      // polling, validation, and final save continue independently.
      lease?.release();
      applicationSubmissionRef.current = false;
      if (isMountedRef.current) setApplicationRun({ state: 'idle', position: null });
    }
  }, [data.hubId, data.originHubId, data.title, data.company, data.snippet, data.location, data.salary, data.url, data.source, data.posted, data.language, data.reasoning, data.matchScore, additionalNotes, id, getNode, getLiveJobCard, nav, addToast, isMountedRef, acquireModuleRun, hasApplicationRun, localJobPending, updateGlobal]);

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
      className={`${hasExpandedDisclosure ? 'w-[420px]' : 'w-[280px]'} rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden group`}
      style={{ borderColor: compensationBorderColor }}
    >
      <NodeHandles className="w-2 h-2" style={handleStyle} />

      {/* Header */}
      <div className="px-3 py-2 flex items-start gap-2 border-b border-white/5">
        <div
          className="shrink-0 mt-0.5 w-[52px] h-10 rounded-lg flex flex-col items-center justify-center leading-none"
          style={{ backgroundColor: accentColor + '20', color: accentColor }}
          title={`Hiring fit: ${score}%. A comparative evidence-based score, not a statistical probability or guaranteed outcome.`}
          aria-label={`Hiring fit ${score} percent. A comparative evidence-based score, not a statistical probability or guaranteed outcome.`}
        >
          <span className="text-[9px] font-medium uppercase tracking-wide">Hiring fit</span>
          <span className="mt-0.5 text-xs font-bold">{score}%</span>
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
            className={`absolute top-0 -right-2 rounded-full p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70 transition-all ${
              data.locked ? 'hidden' : 'text-white/30 hover:text-red-400 hover:bg-white/10'
            }`}
            title="Dismiss Job"
            aria-label="Dismiss job"
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
            aria-label="Open job listing"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      {/* Compensation is deliberately separate from the hiring-fit score.
          Its border is semantic (green/red only for a confident cash-pay
          verdict); unknown, old, and incomplete research remains neutral. */}
      <div className="border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`nodrag w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left text-[11px] transition-colors hover:bg-white/[0.035] ${
            compensationAssessment.status === 'competitive'
              ? 'text-emerald-300/90'
              : compensationAssessment.status === 'below_market'
                ? 'text-red-300/90'
                : 'text-white/45'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            const nextExpanded = !showCompensationDetails;
            setShowCompensationDetails(nextExpanded);
            EventLogger.log(`[JobCard] compensation ${nextExpanded ? 'expanded' : 'collapsed'} id=${id} status=${compensationAssessment.status}`);
          }}
          aria-expanded={showCompensationDetails}
          title={showCompensationDetails ? 'Hide cash-pay research' : 'Show cash-pay research'}
        >
          <span className="min-w-0 truncate">{compensationLabel(compensationAssessment.status)}</span>
          <ChevronDown size={13} className={`shrink-0 transition-transform ${showCompensationDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>

        {showCompensationDetails && (
          <div className="px-3 pb-2.5 text-xs leading-relaxed text-white/55">
            <p className="text-white/70">{compensationAssessment.justification}</p>
            {(cashRangeLabel(compensationAssessment.offered) || data.salary) && (
              <div className="mt-1.5"><span className="text-white/35">Advertised cash:</span> {cashRangeLabel(compensationAssessment.offered) || data.salary}</div>
            )}
            {cashRangeLabel(compensationAssessment.competitiveRange) && (
              <div><span className="text-white/35">Competitive cash range:</span> {cashRangeLabel(compensationAssessment.competitiveRange)}</div>
            )}
            {compensationAssessment.comparisonLocation && (
              <div><span className="text-white/35">Compared for:</span> {compensationAssessment.comparisonLocation}</div>
            )}
            {researchedDateLabel(compensationAssessment.researchedAt) && (
              <div><span className="text-white/35">Researched:</span> {researchedDateLabel(compensationAssessment.researchedAt)}</div>
            )}
            {compensationSourceLinks.length > 0 && (
              <div className="mt-2 border-t border-white/5 pt-1.5">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/35">Research sources</div>
                <div className="space-y-1">
                  {compensationSourceLinks.map((source, index) => {
                    const sourceRange = cashRangeLabel(source.range);
                    return (
                      <div key={`${source.url}-${index}`} className="min-w-0">
                        <button
                          type="button"
                          className="nodrag flex max-w-full items-center gap-1 text-left text-[11px] text-blue-300/80 hover:text-blue-200"
                          onClick={(e) => { e.stopPropagation(); openResearchSource(source.safeUrl); }}
                          title={`Open research source: ${source.label}`}
                        >
                          <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
                          <span className="truncate">{source.label}{sourceRange ? ` · ${sourceRange}` : ''}</span>
                        </button>
                        {source.details && (
                          <p className="mt-0.5 pl-4 text-[10px] leading-snug text-white/35">{source.details}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* AI match justification — the full text from the scorer is preserved; we
          clamp it so every card keeps a consistent height, and let the user click
          to expand and read it all (then click again to collapse). */}
      {data.reasoning && (
        <button
          type="button"
          className={`nodrag block w-full px-3 py-1.5 text-left text-white/45 text-xs leading-relaxed border-t border-white/5 cursor-pointer hover:text-white/60 focus-visible:text-white/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-300/70 transition-colors ${showFullReasoning ? '' : 'line-clamp-3'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const nextExpanded = !showFullReasoning;
            setShowFullReasoning(nextExpanded);
            EventLogger.log(`[JobCard] reasoning ${nextExpanded ? 'expanded' : 'collapsed'} id=${id}`);
          }}
          aria-expanded={showFullReasoning}
          title={showFullReasoning ? 'Show less' : 'Show full reasoning'}
        >
          {data.reasoning}
        </button>
      )}

      {showFullReasoning && hiringFitAudit && (
        <div className="px-3 pb-2.5 text-[11px] leading-snug text-white/50 border-t border-white/5" aria-label="Hiring fit audit">
          {hiringFitAudit.strengths.items.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-300/70">Grounded strengths</div>
              <ul className="mt-1 space-y-0.5">
                {hiringFitAudit.strengths.items.map((strength) => <li key={strength}>• {strength}</li>)}
              </ul>
              {hiringFitAudit.strengths.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.strengths.overflow} more</div>}
            </div>
          )}
          {hiringFitAudit.materialGaps.not_documented.items.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-sky-300/75">Evidence to confirm ({hiringFitAudit.materialGaps.not_documented.total})</div>
              <ul className="mt-1 space-y-0.5">
                {hiringFitAudit.materialGaps.not_documented.items.map(({ requirement }) => <li key={requirement}>• {evidenceConfirmationQuestion(requirement)}</li>)}
              </ul>
              {hiringFitAudit.materialGaps.not_documented.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.materialGaps.not_documented.overflow} more to confirm</div>}
            </div>
          )}
          {hiringFitAudit.materialGaps.contradicted.items.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-rose-300/75">Documented conflicts ({hiringFitAudit.materialGaps.contradicted.total})</div>
              <ul className="mt-1 space-y-0.5">
                {hiringFitAudit.materialGaps.contradicted.items.map(({ requirement }) => <li key={requirement}>• {requirement}</li>)}
              </ul>
              {hiringFitAudit.materialGaps.contradicted.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.materialGaps.contradicted.overflow} more documented conflicts</div>}
            </div>
          )}
          {hiringFitAudit.materialGaps.unclear.items.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-amber-300/75">Unclear evidence ({hiringFitAudit.materialGaps.unclear.total})</div>
              <ul className="mt-1 space-y-0.5">
                {hiringFitAudit.materialGaps.unclear.items.map(({ requirement }) => <li key={requirement}>• {requirement}</li>)}
              </ul>
              {hiringFitAudit.materialGaps.unclear.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.materialGaps.unclear.overflow} more unclear items</div>}
            </div>
          )}
          {hiringFitAudit.materialGaps.review.items.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-white/50">Evidence to review ({hiringFitAudit.materialGaps.review.total})</div>
              <ul className="mt-1 space-y-0.5">
                {hiringFitAudit.materialGaps.review.items.map(({ requirement }) => <li key={requirement}>• {requirement}</li>)}
              </ul>
              {hiringFitAudit.materialGaps.review.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.materialGaps.review.overflow} more to review</div>}
            </div>
          )}
          {(hiringFitAudit.materialGaps.not_documented.total > 0 || hiringFitAudit.materialGaps.unclear.total > 0) && (
            <div className="mt-2 text-white/40">Add any omitted relevant experience to your career data and rescore; the assessment can change.</div>
          )}
          {(hiringFitAudit.confidence || hiringFitAudit.calibrated) && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-white/40">
              {hiringFitAudit.confidence && <span>Assessment confidence: {hiringFitAudit.confidence}</span>}
              {hiringFitAudit.calibrated && <span>Score calibrated: {hiringFitAudit.calibrated.rawScore}% → {hiringFitAudit.calibrated.adjustedScore}%</span>}
            </div>
          )}
        </div>
      )}

      {/* Job-specific context is persisted on this card, never merged into the
          source hub's career files. It remains available if this branch is
          collapsed before the user is ready to generate. */}
      <div className="px-3 py-2 border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
        <label className="block text-[10px] font-medium uppercase tracking-wider text-white/45" htmlFor={`job-notes-${id}`}>
          Additional notes for AI <span className="normal-case tracking-normal text-white/25">(optional)</span>
        </label>
        <textarea
          id={`job-notes-${id}`}
          value={additionalNotes}
          maxLength={2000}
          rows={2}
          placeholder="Anything relevant before generating — e.g. personal C# experience or a shared team interest."
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setAdditionalNotes(e.target.value)}
          onBlur={() => updateGlobal(id, { additionalNotes: additionalNotes.trim() })}
          disabled={!!data.locked || hasApplicationRun || localJobPending}
          className="nodrag nowheel mt-1.5 block w-full resize-y rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs leading-relaxed text-white/75 placeholder:text-white/25 outline-none transition-colors focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 disabled:cursor-default disabled:opacity-50"
        />
      </div>

      {localApplication && (
        <div className="px-3 py-2 border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-start gap-2 text-[10px] leading-snug">
            <span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              localApplication.status === 'saved' ? 'bg-emerald-400' : ['failed', 'invalid', 'revision-exhausted'].includes(localApplication.status) ? 'bg-red-400' : 'bg-amber-400 animate-pulse'
            }`} />
            <div className="min-w-0 text-white/55">
              <div className="font-medium text-white/70">
                {localApplication.status === 'queued' ? 'Local AI queued — run Claude Code' :
                  localApplication.status === 'importing' ? 'Importing Local AI result…' :
                    localApplication.status === 'saved' ? 'Local AI application saved' :
                      localApplication.status === 'status-error' ? 'Local AI reconnecting…' :
                      localApplication.status === 'completed' ? 'Local AI result ready' : 'Local AI needs attention'}
              </div>
              <div className="mt-0.5 text-white/35">{localApplication.message || (localApplication.status === 'queued' ? 'Open this canvas’s .local-ai job folder, run your Claude Code routine, and write its result there. This card checks for it automatically.' : '')}</div>
            </div>
          </div>
          {localApplication.id && window.electronAPI?.openLocalApplicationFolder && !['saved', 'failed'].includes(localApplication.status) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const canvasFilePath = localApplication.canvasFilePath
                  || (nav?.getCurrentFile ? nav.getCurrentFile() : nav?.currentFile ?? null);
                window.electronAPI.openLocalApplicationFolder({ jobId: localApplication.id, canvasFilePath });
              }}
              className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-400/15"
            >
              Open Local AI Job Folder
            </button>
          )}
          {localApplication.status === 'saved' && !localApplication.intermediateCleaned && (
            <button
              onClick={(e) => { e.stopPropagation(); importCompletedLocalApplication(localApplication.id); }}
              className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-400/15"
              title="Rebuild the final bundle from this Local AI result, including any missing PDFs."
            >
              Repair bundle
            </button>
          )}
          {localApplication.status === 'render-retry-required' && (
            <button
              onClick={(e) => { e.stopPropagation(); importCompletedLocalApplication(localApplication.id); }}
              className="mt-2 ml-1.5 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-400/15"
              title="Render and measure both PDFs again without asking the AI to rewrite them."
            >
              Retry layout check
            </button>
          )}
          {localApplication.status === 'invalid' && (
            <button
              onClick={(e) => { e.stopPropagation(); importCompletedLocalApplication(localApplication.id); }}
              className="mt-2 ml-1.5 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-400/15"
              title="Revalidate and import this Local AI result after correcting its reported issue."
            >
              Retry import
            </button>
          )}
        </div>
      )}

      {/* Generate full application (always visible, tailored résumé + cover letter)
          beside Mark Applied — an explicit, separate action recording that the
          user actually submitted it. Generation never flips this on its own. */}
      <div className="px-3 py-2 border-t border-white/5 flex items-center gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
        <button
          onClick={data.locked ? undefined : (e) => { e.stopPropagation(); generateApplication(); }}
          disabled={hasApplicationRun || localJobPending || !!data.locked}
          className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
            data.locked
              ? 'bg-white/5 text-white/20 cursor-default'
              : 'bg-gradient-to-r from-emerald-500/15 to-blue-500/15 text-emerald-300 hover:from-emerald-500/25 hover:to-blue-500/25 hover:text-emerald-200 disabled:opacity-50'
          }`}
          title={localJobPending
            ? 'A Local AI job is waiting for your Claude Code routine or is being imported.'
            : displayedApplicationRun.state === 'queued'
            ? `Queued at position ${displayedApplicationRun.position} — application generation runs one at a time to protect model quota and document rendering.`
            : 'AI researches the company, then writes a tailored résumé + cover letter and saves both to your Applied Jobs folder'}
        >
          <Sparkles size={13} className={hasApplicationRun ? 'animate-pulse' : ''} />
          {localJobPending
            ? localApplication.status === 'importing' ? 'Importing…' : 'Local AI queued'
            : displayedApplicationRun.state === 'queued'
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
