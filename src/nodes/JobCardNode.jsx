import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { ExternalLink, X, Sparkles, ChevronDown } from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { formatPostedForDisplay } from '../utils/jobPostedDate';
import { languageLabel } from '../utils/jobLanguageLabels';
import { NodeHandles } from './_shared/NodeHandles';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { computeJobTreeView, normalizeCompensationAssessment, shouldReflowMeasuredJobCard } from './jobsearch/buildJobTree';
import { deriveBoardCardStats } from './jobboard/mergeJobs';
import { formatSalaryCurrencyLabel } from '../utils/salaryCurrency';
import { normalizeExternalHttpUrl } from '../utils/urlSafety';
import { openExternalFailureMessage, openExternalUrl } from '../utils/openExternal';
import { normalizeJobListingExternalUrl, summarizeJobListingUrl } from '../utils/jobListingUrl';
import { LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_RESULT_SETTLE_MS, LOCAL_AI_STATUS_ERROR_STREAK_LIMIT, registerMountedJobCard, unregisterMountedJobCard } from '../utils/localAiFallback';
import { hubCardFilter } from '../utils/jobCardFilters';
import { canRegenerateLocalApplication, canSaveImportedLocalApplication, queuedLocalApplicationSettlement, replacedLocalApplicationForCleanup } from '../utils/localAiApplicationLifecycle';
import { ApplicationLaunchPromptDialog } from '../components/ApplicationLaunchPromptDialog';

// Accent color encodes the hiring-fit band: a compact evidence-based assessment
// of full-process fit, not a guaranteed hiring outcome.
function scoreColor(score) {
  if (score >= 85) return '#22c55e'; // green  — strong hiring fit
  if (score >= 70) return '#3b82f6'; // blue   — solid hiring fit
  if (score >= 40) return '#eab308'; // amber  — partial/stretch hiring fit
  return '#6b7280';                  // gray   — limited hiring fit
}

const COMPENSATION_BORDER_COLORS = {
  competitive: '#22c55e',
  below_market: '#ef4444',
};

function compensationLabel(status, currency = '') {
  if (status === 'competitive') return 'Competitive cash pay';
  if (status === 'below_market') return 'Likely below-market cash pay';
  if (status === 'market_recommendation') return `Recommended salary range${currency ? ` (${currency})` : ''}`;
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

function normalizedStatus(row) {
  const status = String(row?.effectiveStatus || row?.status || '').trim().toLowerCase().replace(/-/g, '_');
  return ['direct', 'adjacent', 'not_documented', 'contradicted', 'unclear'].includes(status) ? status : '';
}

function compactRows(rows, limit) {
  return compactAuditLabels(rows, limit);
}

function auditCountLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compactAuditSummary(audit) {
  if (!audit?.isAudited) return 'Verified requirement detail unavailable';
  const parts = [];
  if (audit.directStrengths.total) parts.push(auditCountLabel(audit.directStrengths.total, 'direct match'));
  if (audit.adjacentMatches.total) parts.push(auditCountLabel(audit.adjacentMatches.total, 'transferable match'));
  if (audit.verifiedGapTotal) parts.push(auditCountLabel(audit.verifiedGapTotal, 'verified gap'));
  if (audit.unverifiedItems.total) parts.push(auditCountLabel(audit.unverifiedItems.total, 'unverified item'));
  return parts.join(' · ') || 'Verified audit available';
}

// Only the deterministic, normalized fitAssessment may reach this disclosure.
// Do not fall back to legacy top-level score fields or any provider narrative:
// neither is safe evidence for explaining an assessed score.
function compactHiringFitAudit(assessment) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) return null;
  const rows = Array.isArray(assessment.requirementRows) ? assessment.requirementRows : [];
  // Older audited cards predate scoreImpact. Treat only an explicit
  // informational marker as non-scoring so their verified rows remain useful.
  const groundedScoredRows = rows.filter((row) => (
    row?.grounding?.requirementGrounded === true && row?.scoreImpact !== 'informational'
  ));
  const directStrengths = compactRows(groundedScoredRows.filter((row) => (
    normalizedStatus(row) === 'direct' && row?.grounding?.candidateClaimGrounded === true
  )), 3);
  const adjacentMatches = compactRows(groundedScoredRows.filter((row) => (
    normalizedStatus(row) === 'adjacent' && row?.grounding?.candidateClaimGrounded === true
  )), 3);
  const verifiedGapRows = groundedScoredRows.filter((row) => (
    row?.materialGap === true && ['not_documented', 'contradicted', 'unclear'].includes(normalizedStatus(row))
  ));
  const verifiedGaps = {
    notDocumented: compactRows(verifiedGapRows.filter((row) => normalizedStatus(row) === 'not_documented'), 3),
    contradicted: compactRows(verifiedGapRows.filter((row) => normalizedStatus(row) === 'contradicted'), 3),
    unclear: compactRows(verifiedGapRows.filter((row) => normalizedStatus(row) === 'unclear'), 3),
  };

  // Rejected rows are intentionally limited to their normalized requirement
  // labels. Never surface the rejected quotes or the model's original prose.
  const rejectedRows = [
    ...(Array.isArray(assessment.rejectedRequirementRows) ? assessment.rejectedRequirementRows : []),
    ...rows.filter((row) => row?.grounding?.requirementGrounded === false
      || (Array.isArray(row?.grounding?.rejectedJobEvidence) && row.grounding.rejectedJobEvidence.length > 0)
      || (Array.isArray(row?.grounding?.rejectedCandidateEvidence) && row.grounding.rejectedCandidateEvidence.length > 0)),
  ];
  const unverifiedItems = compactRows(rejectedRows, 3);
  const confidenceValue = String(assessment.confidence?.effective || '').trim().toLowerCase();
  const confidence = ['high', 'medium', 'low', 'unknown'].includes(confidenceValue) ? confidenceValue : '';
  const groundedRequirementCount = Number(assessment.confidence?.groundedRequirementCount);
  const requirementCount = Number(assessment.confidence?.requirementCount);
  const coverage = Number.isFinite(groundedRequirementCount) && Number.isFinite(requirementCount)
    && groundedRequirementCount >= 0 && requirementCount >= 0
    ? { groundedRequirementCount, requirementCount }
    : null;
  const modelScore = Number(assessment.rawScore);
  const calibratedScore = Number(assessment.adjustedScore);
  const provenance = Number.isFinite(modelScore) || Number.isFinite(calibratedScore)
    ? { modelScore: Number.isFinite(modelScore) ? modelScore : null, calibratedScore: Number.isFinite(calibratedScore) ? calibratedScore : null }
    : null;
  return {
    isAudited: assessment.auditStatus === 'audited',
    directStrengths,
    adjacentMatches,
    verifiedGaps,
    verifiedGapTotal: verifiedGapRows.length,
    unverifiedItems,
    confidence,
    coverage,
    provenance,
  };
}

// A local coding agent often makes a sequence of atomic edits while composing one
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

  const [showScoreAudit, setShowScoreAudit] = useState(false);
  const [showCompensationDetails, setShowCompensationDetails] = useState(false);
  const [applicationRun, setApplicationRun] = useState({ state: 'idle', position: null });
  const [applicationLaunchPrompt, setApplicationLaunchPrompt] = useState('');
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
  // graph over a current-level getNode lookup. The same applies to the owning
  // hub/board this card points at (data.hubId, data.originHubId): nested-canvas
  // absorption can move a module to another level, and a level-scoped miss
  // there reads as "the module was deleted" when it is merely one level away.
  const getLiveNode = useCallback((nodeId) => {
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
  // asynchronously through ResizeObserver. A first measurement only needs a
  // reflow if it outgrows the row reserved by the initial tree layout; later
  // visible changes always reflow. This avoids fresh-cascade churn while still
  // making a newly opened tall card push lower siblings clear. The same guard
  // also fixes collapse → re-expand: hidden cards unmount and reset this local
  // disclosure state, so an old 308px measurement can legitimately become the
  // normal 210px measurement when the card returns.
  useEffect(() => {
    const previousMeasuredHeight = previousMeasuredHeightRef.current;
    previousMeasuredHeightRef.current = measuredHeight;
    const node = getNode(id);
    const shouldReflow = shouldReflowMeasuredJobCard({
      visible: !!node && !node.hidden,
      previousMeasuredHeight,
      measuredHeight,
    });
    if (!shouldReflow) return;
    const frame = requestAnimationFrame(() => {
      const hubData = getLiveNode(data.hubId)?.data || {};
      setNodes((nodes) => computeJobTreeView(nodes, data.hubId, hubCardFilter(hubData), undefined, true));
    });
    return () => cancelAnimationFrame(frame);
  }, [id, measuredHeight, data.hubId, getNode, getLiveNode, setNodes]);

  // Local disclosure state is intentionally non-persistent, but report it while
  // mounted so a bug report can explain a measured-height/layout discrepancy.
  useEffect(() => {
    EventLogger.registerNodeState(id, {
      scoreAuditExpanded: showScoreAudit,
      compensationExpanded: showCompensationDetails,
    });
  }, [id, showScoreAudit, showCompensationDetails]);
  useEffect(() => () => EventLogger.unregisterNodeState(id), [id]);

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
  const hiringFitAudit = useMemo(() => compactHiringFitAudit(data.fitAssessment), [data.fitAssessment]);

  const score = data.matchScore || 0;
  const accentColor = scoreColor(score);
  const compensationBorderColor = COMPENSATION_BORDER_COLORS[compensationAssessment.status] || 'rgba(255,255,255,0.12)';
  const hasExpandedDisclosure = showScoreAudit || showCompensationDetails;
  // NodeHandles is React.memo'd; an inline object literal here would create a
  // new reference every render and defeat that memoization, unlike every
  // other caller of NodeHandles, which pass only a stable className.
  const handleStyle = useMemo(() => ({ backgroundColor: accentColor }), [accentColor]);

  const openJobUrl = useCallback(async () => {
    const url = normalizeJobListingExternalUrl(data);
    const diagnostic = summarizeJobListingUrl(data, url);
    EventLogger.log(`[JobCard] external-link requested id=${id} source=${data.source || '?'} raw=${diagnostic.rawRoute} q=${diagnostic.rawQuery} htidocid=${diagnostic.documentId} target=${diagnostic.targetRoute} repaired=${diagnostic.repaired ? 'yes' : 'no'}`);
    if (!url || !window.electronAPI?.openExternal) {
      EventLogger.log(`[JobCard] external-link rejected id=${id} reason=${url ? 'dispatcher-unavailable' : 'invalid-or-missing-url'}`);
      addToast({
        title: 'Cannot Open Listing',
        description: 'No safe job-listing link is available for this card.',
        type: 'error',
      });
      return;
    }
    try {
      // handleSafe (electron/ipc/ipcUtils.js) always RESOLVES this invoke,
      // even on failure, with { success: false, error }. Check the payload
      // instead of relying on a rejection, or a failed open silently reads
      // as dispatched.
      const result = await window.electronAPI.openExternal(url);
      if (!result?.success) throw new Error(result?.error || 'Could not open the job listing.');
      EventLogger.log(`[JobCard] external-link dispatched id=${id} target=${diagnostic.targetRoute}`);
    } catch (error) {
      const reason = String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);
      EventLogger.log(`[JobCard] external-link failed id=${id} target=${diagnostic.targetRoute} reason=${reason}`);
      addToast({
        title: 'Cannot Open Listing',
        description: 'Could not open the job listing. Please try again.',
        type: 'error',
      });
    }
  }, [id, data, addToast]);

  const openResearchSource = useCallback(async (rawUrl) => {
    const opened = await openExternalUrl(rawUrl, {
      dispatcher: window.electronAPI?.openExternal,
      fallback: window.open,
    });
    if (!opened.ok) {
      addToast({
        title: 'Cannot Open Link',
        description: openExternalFailureMessage(opened),
        type: 'error',
        dedupeKey: `job-research-open-external:${id}`,
      });
    }
  }, [addToast, id]);

  // Dismiss = delete this card, then re-derive the tree view so the column
  // tightens and the role leaf's pagination window backfills the next matching
  // card (the group badges are live via their own store selector). Lock is
  // checked at click time against BOTH this card and the owning board — a
  // render-time read would go stale on already-mounted cards.
  const dismissCard = useCallback(async () => {
    if (data.locked || getLiveNode(data.hubId)?.data?.locked) return;
    // A hidden/collapsed card may unmount while it remains a canvas node, so
    // unmount is not cancellation. Explicit dismissal is: remove only this
    // card's waiting lease; an already-running IPC operation is left intact.
    cancelQueuedRunsForNode(id, 'Job card dismissed before generation started');
    await deleteElements({ nodes: [{ id }] });
    // Read the board's own config the same way the lock check above does, and
    // the same way `updateGlobal` below writes it back — cross-level. A
    // level-scoped miss here would silently degrade to `{}`, which changes
    // which cards the filter keeps and what the stats are derived from.
    const hubData = getLiveNode(data.hubId)?.data || {};
    const filter = hubCardFilter(hubData);
    setNodes((nodes) => computeJobTreeView(nodes, data.hubId, filter));
    // getNodes() stays level-scoped here on purpose: these stats count the
    // cards present on THIS board's level, and absorption's closure keeps a
    // board and its cards together, so widening this to the whole graph would
    // change what the statistic means rather than fix a bug.
    const stats = deriveBoardCardStats(getNodes().filter((node) => node.id !== id), data.hubId, hubData);
    updateGlobal(data.hubId, stats);
    EventLogger.log(`[JobCard] dismissed id=${id} board=${data.hubId} remaining=${stats.resultCount}`);
  }, [id, data.locked, data.hubId, deleteElements, getLiveNode, getNodes, setNodes, updateGlobal, cancelQueuedRunsForNode]);

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
    setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'importing', message: 'Importing Local AI result…' } : current);
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
      // be promoted into the durable application-bundle destination.
      if (!canSaveImportedLocalApplication(getLiveNode(idRef.current), jobId)) {
        await window.electronAPI.discardApplication?.({ workDir: local.workDir });
        EventLogger.log(`[LocalAI] discarded imported workspace job=${jobId}: card was removed before save`);
        return;
      }
      const saved = await window.electronAPI.saveApplication({
        resumeHtmlPath: local.resumeHtmlPath,
        resumePdfPath: local.resumePdfPath,
        coverLetterPdfPath: local.coverLetterPdfPath,
        jobListingPath: local.jobListingPath,
        generationAuditPath: local.generationAuditPath,
        workDir: local.workDir,
        company: local.company,
        candidateName: local.candidateName,
        jobTitle: data.title,
        location: data.location,
        canvasFilePath,
      });
      if (!saved?.success || !saved.saved) {
        const saveError = new Error(saved?.error || 'Could not save the imported application.');
        if (saved?.errorCode) saveError.code = saved.errorCode;
        throw saveError;
      }
      if (isMountedRef.current) {
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
        setLocalApplication((current) => current?.id === jobId ? { ...current, status: 'completed', message: 'Local AI saved a newer result — waiting briefly for the final save…' } : current);
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
  }, [nav, data.title, data.location, localApplication?.canvasFilePath, addToast, getLiveNode, isMountedRef]);

  // The local coding agent writes result.json manually/asynchronously. Polling only reads
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
            setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'completed', message: 'Local AI result found — waiting for a stable file snapshot…' } : current);
            return;
          }
          const settled = localResultSettlingRef.current.get(jobId);
          const now = Date.now();
          if (!settled || settled.resultSha256 !== resultSha256) {
            localResultSettlingRef.current.set(jobId, { resultSha256, observedAt: now });
            setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'completed', message: 'Local AI result found — waiting briefly for the final save…' } : current);
            return;
          }
          if (now - settled.observedAt < LOCAL_AI_RESULT_SETTLE_MS) return;
          if (localImportingRef.current.has(jobId)) return;
          localImportingRef.current.add(jobId);
          setLocalApplication((current) => current?.id === jobId ? { ...current, ...next, status: 'importing', message: 'Local AI result found — importing…' } : current);
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
  // to the saved canvas. A local coding agent produces the documents, then
  // the existing polling/import path validates and saves the final bundle.
  const generateApplication = useCallback(async () => {
    if (!window.electronAPI?.queueLocalApplication || applicationSubmissionRef.current || hasApplicationRun || localJobPending) return;
    if (getLiveNode(data.hubId)?.data?.locked) return; // board lock freezes cards too
    const originHubId = data.originHubId || data.hubId;
    // Fast, non-queued validation prevents a known-invalid card from taking a
    // queue turn. This is intentionally re-read after the lease as well: the
    // preflight is only user feedback, never the data used for generation.
    const preflightOriginHub = getLiveNode(originHubId);
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
        description: 'Application bundles are saved next to your canvas. Save the canvas to a file, then try again.',
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
          if (!getLiveNode(idRef.current)) {
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
            description: 'Application bundles are saved next to your canvas. Save the canvas to a file, then try again.',
            type: 'error',
          });
        }
        return;
      }

      const originHub = getLiveNode(originHubId);
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
      const expectedPriorLocalApplication = getLiveNode(idRef.current)?.data?.localApplication || null;
      const queued = await window.electronAPI.queueLocalApplication({
        nodeId: idRef.current,
        canvasFilePath,
        job: {
          title: data.title, company: data.company, snippet: data.snippet,
          // New Google rows keep the direct Apply-on URL in `url`; legacy
          // cards may only retain Google’s internal identity. Materialize the
          // same safe, user-facing target as the card’s Open Listing action so
          // the generated application bundle never embeds a brittle share URL.
          location: data.location, salary: data.salary, url: normalizeJobListingExternalUrl({
            title: data.title,
            company: data.company,
            location: data.location,
            url: data.url,
            googleCardUrl: data.googleCardUrl,
          }),
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
        getLiveNode(idRef.current),
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
      // updateGlobal applies this guarded patch against React's live store, so
      // the pre-write settlement above is not enough authority to retire the
      // prior handoff. Another update can win between the two checks. Confirm
      // that the replacement is the card's actual current pointer before
      // deleting the old private workspace; if React has not committed within
      // these turns, preserve it rather than risking a destructive cleanup.
      let replacementPersisted = false;
      for (let attempt = 0; attempt < 3 && !replacementPersisted; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
        replacementPersisted = getLiveNode(idRef.current)?.data?.localApplication?.id === queued.localJob.id;
      }
      const replacedLocalApplication = replacedLocalApplicationForCleanup(
        expectedPriorLocalApplication,
        queued.localJob,
        replacementPersisted,
      );
      if (replacedLocalApplication) {
        try {
          await window.electronAPI.discardLocalApplication?.({
            jobId: replacedLocalApplication.id,
            canvasFilePath: replacedLocalApplication.canvasFilePath || canvasFilePath,
          });
          EventLogger.log(`[LocalAI] cleaned replaced handoff job=${replacedLocalApplication.id} replacement=${queued.localJob.id}`);
        } catch (cleanupError) {
          EventLogger.error(`[LocalAI] Could not clean replaced handoff job=${replacedLocalApplication.id}:`, cleanupError);
        }
      }
      if (isMountedRef.current) {
        setLocalApplication(queued.localJob);
        setApplicationLaunchPrompt(queued.prompt || '');
        addToast({
          title: 'Launch Prompt Ready',
          description: 'Paste the prompt into any local coding agent with filesystem access. This card will import the completed application automatically.',
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
      // The lease only covers durable handoff creation. Local coding-agent execution,
      // polling, validation, and final save continue independently.
      lease?.release();
      applicationSubmissionRef.current = false;
      if (isMountedRef.current) setApplicationRun({ state: 'idle', position: null });
    }
  }, [data.hubId, data.originHubId, data.title, data.company, data.snippet, data.location, data.salary, data.url, data.googleCardUrl, data.source, data.posted, data.language, data.reasoning, data.matchScore, additionalNotes, id, getLiveNode, nav, addToast, isMountedRef, acquireModuleRun, hasApplicationRun, localJobPending, updateGlobal]);

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
          title={`Evidence-based hiring-fit score: ${score} out of 100. This is a comparative assessment, not a probability or guaranteed outcome.`}
          aria-label={`Evidence-based hiring-fit score ${score} out of 100. This is a comparative assessment, not a probability or guaranteed outcome.`}
        >
          <span className="text-[9px] font-medium uppercase tracking-wide">Hiring fit</span>
          <span className="mt-0.5 text-xs font-bold">{score}/100</span>
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
        {data.posted && <span className="text-white/20" title={data.posted}>{formatPostedForDisplay(data.posted)}</span>}
        {(data.url || data.googleCardUrl) && (
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
          <span className="min-w-0 truncate">{compensationLabel(
            compensationAssessment.status,
            compensationAssessment.competitiveRange.currency || compensationAssessment.offered.currency,
          )}</span>
          <ChevronDown size={13} className={`shrink-0 transition-transform ${showCompensationDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>

        {showCompensationDetails && (
          <div className="px-3 pb-2.5 text-xs leading-relaxed text-white/55">
            <p className="text-white/70">{compensationAssessment.justification}</p>
            {(cashRangeLabel(compensationAssessment.offered) || data.salary) && (
              <div className="mt-1.5"><span className="text-white/35">Advertised cash:</span> {cashRangeLabel(compensationAssessment.offered) || data.salary}</div>
            )}
            {cashRangeLabel(compensationAssessment.competitiveRange) && (
              <div><span className="text-white/35">{compensationAssessment.status === 'market_recommendation' ? 'Recommended cash range:' : 'Competitive cash range:'}</span> {cashRangeLabel(compensationAssessment.competitiveRange)}</div>
            )}
            {compensationAssessment.status === 'market_recommendation' && compensationAssessment.competitiveRange.currency && (
              <div><span className="text-white/35">Currency:</span> {compensationAssessment.competitiveRange.currency}{compensationAssessment.currencyInferredFromLocation ? ' (inferred from job location)' : ''}</div>
            )}
            {compensationAssessment.comparisonLocation && (
              <div><span className="text-white/35">{compensationAssessment.status === 'market_recommendation' ? 'Researched for:' : 'Compared for:'}</span> {compensationAssessment.comparisonLocation}</div>
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

      {/* This is deliberately a structured audit disclosure, not model prose.
          It remains useful for older cards: they can say that no verified audit
          was saved without turning an old narrative into new evidence. */}
      <div className="border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="nodrag w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left text-xs text-white/60 hover:bg-white/[0.035] hover:text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-300/70 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            const nextExpanded = !showScoreAudit;
            setShowScoreAudit(nextExpanded);
            EventLogger.log(`[JobCard] score audit ${nextExpanded ? 'expanded' : 'collapsed'} id=${id}`);
          }}
          aria-expanded={showScoreAudit}
          aria-controls={`job-score-audit-${id}`}
        >
          <span className="min-w-0">
            <span className="block font-medium">Why this score?</span>
            <span className="mt-0.5 block truncate text-[10px] font-normal text-white/35">
              {compactAuditSummary(hiringFitAudit)}
            </span>
          </span>
          <ChevronDown size={14} className={`shrink-0 transition-transform ${showScoreAudit ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>

        {showScoreAudit && (
          <div id={`job-score-audit-${id}`} className="px-3 pb-2.5 text-[11px] leading-snug text-white/50" aria-label="Evidence-based hiring-fit audit">
            {!hiringFitAudit?.isAudited ? (
              <div className="mt-1.5 text-white/45">
                No verified requirement audit is available for this saved score. It is shown for continuity, not as a probability.
              </div>
            ) : (
              <>
                {hiringFitAudit.directStrengths.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-300/70">Direct strengths ({hiringFitAudit.directStrengths.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.directStrengths.items.map((strength) => <li key={strength}>• {strength}</li>)}
                    </ul>
                    {hiringFitAudit.directStrengths.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.directStrengths.overflow} more</div>}
                  </div>
                )}
                {hiringFitAudit.adjacentMatches.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-sky-300/75">Adjacent / transferable matches ({hiringFitAudit.adjacentMatches.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.adjacentMatches.items.map((match) => <li key={match}>• {match}</li>)}
                    </ul>
                    {hiringFitAudit.adjacentMatches.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.adjacentMatches.overflow} more</div>}
                  </div>
                )}
                {hiringFitAudit.verifiedGaps.notDocumented.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-sky-300/75">Not documented in career data ({hiringFitAudit.verifiedGaps.notDocumented.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.verifiedGaps.notDocumented.items.map((gap) => <li key={gap}>• {gap}</li>)}
                    </ul>
                    {hiringFitAudit.verifiedGaps.notDocumented.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.verifiedGaps.notDocumented.overflow} more</div>}
                  </div>
                )}
                {hiringFitAudit.verifiedGaps.contradicted.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-rose-300/75">Documented conflicts ({hiringFitAudit.verifiedGaps.contradicted.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.verifiedGaps.contradicted.items.map((gap) => <li key={gap}>• {gap}</li>)}
                    </ul>
                    {hiringFitAudit.verifiedGaps.contradicted.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.verifiedGaps.contradicted.overflow} more</div>}
                  </div>
                )}
                {hiringFitAudit.verifiedGaps.unclear.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-amber-300/75">Inconclusive evidence ({hiringFitAudit.verifiedGaps.unclear.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.verifiedGaps.unclear.items.map((gap) => <li key={gap}>• {gap}</li>)}
                    </ul>
                    {hiringFitAudit.verifiedGaps.unclear.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.verifiedGaps.unclear.overflow} more</div>}
                  </div>
                )}
                {hiringFitAudit.unverifiedItems.items.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-white/50">Unverified / rejected assessment items ({hiringFitAudit.unverifiedItems.total})</div>
                    <ul className="mt-1 space-y-0.5">
                      {hiringFitAudit.unverifiedItems.items.map((item) => <li key={item}>• {item}</li>)}
                    </ul>
                    {hiringFitAudit.unverifiedItems.overflow > 0 && <div className="mt-0.5 text-white/35">+{hiringFitAudit.unverifiedItems.overflow} more</div>}
                  </div>
                )}
                {!hiringFitAudit.directStrengths.total && !hiringFitAudit.adjacentMatches.total && !hiringFitAudit.verifiedGapTotal && !hiringFitAudit.unverifiedItems.total && (
                  <div className="mt-2 text-white/45">The audit found no displayable requirement rows.</div>
                )}
                {(hiringFitAudit.confidence || hiringFitAudit.coverage || hiringFitAudit.provenance) && (
                  <div className="mt-2 pt-2 border-t border-white/5 space-y-1 text-white/40">
                    {hiringFitAudit.confidence && <div>Assessment confidence: {hiringFitAudit.confidence}</div>}
                    {hiringFitAudit.coverage && <div>Grounded coverage: {hiringFitAudit.coverage.groundedRequirementCount} of {hiringFitAudit.coverage.requirementCount} requirement{hiringFitAudit.coverage.requirementCount === 1 ? '' : 's'}</div>}
                    {hiringFitAudit.provenance && (
                      <div>
                        {hiringFitAudit.provenance.modelScore !== null && <>AI-assigned score: {hiringFitAudit.provenance.modelScore}/100</>}
                        {hiringFitAudit.provenance.modelScore !== null && hiringFitAudit.provenance.calibratedScore !== null && ' · '}
                        {hiringFitAudit.provenance.calibratedScore !== null && hiringFitAudit.provenance.modelScore === hiringFitAudit.provenance.calibratedScore
                          ? <>Validation: unchanged</>
                          : hiringFitAudit.provenance.calibratedScore !== null && <>Evidence-calibrated score: {hiringFitAudit.provenance.calibratedScore}/100</>}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

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
                {localApplication.status === 'queued' ? 'Local AI queued — run launch prompt' :
                  localApplication.status === 'importing' ? 'Importing Local AI result…' :
                    localApplication.status === 'saved' ? 'Local AI application saved' :
                      localApplication.status === 'status-error' ? 'Local AI reconnecting…' :
                      localApplication.status === 'completed' ? 'Local AI result ready' : 'Local AI needs attention'}
              </div>
              <div className="mt-0.5 text-white/35">{localApplication.message || (localApplication.status === 'queued' ? 'Open this canvas’s .local-ai job folder and run LOCAL_AI_PROMPT.md with a local coding agent. This card checks for its result automatically.' : '')}</div>
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
          {localApplication.status === 'saved' && !localApplication.intermediateCleaned
            && Array.isArray(localApplication.missingArtifacts) && localApplication.missingArtifacts.length > 0 && (
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
              onClick={(e) => {
                e.stopPropagation();
                importCompletedLocalApplication(localApplication.id, localApplication.resultSha256);
              }}
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

      {/* Generate the application bundle. Submission remains a manual action on
          the employer's site; this disposable hierarchy tracks no application state. */}
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
            ? 'A Local AI job is waiting for the local-agent routine or is being imported.'
            : displayedApplicationRun.state === 'queued'
            ? `Queued at position ${displayedApplicationRun.position} — application generation runs one at a time to protect model quota and document rendering.`
            : 'AI researches the company, then writes a tailored résumé + cover letter and saves the application bundle next to your canvas'}
        >
          <Sparkles size={13} className={hasApplicationRun ? 'animate-pulse' : ''} />
          {localJobPending
            ? localApplication.status === 'importing' ? 'Importing…' : 'Local AI queued'
            : displayedApplicationRun.state === 'queued'
            ? `Queued · #${displayedApplicationRun.position}`
            : displayedApplicationRun.state === 'generating' ? 'Generating…' : 'Generate'}
        </button>

      </div>
      <ApplicationLaunchPromptDialog
        prompt={applicationLaunchPrompt}
        onClose={() => setApplicationLaunchPrompt('')}
      />
    </div>
  );
});
