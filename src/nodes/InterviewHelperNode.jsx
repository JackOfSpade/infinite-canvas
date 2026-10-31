import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { BriefcaseBusiness, ChevronLeft, ChevronRight, CircleHelp, FileUp, RefreshCcw, Rocket, ShieldCheck } from 'lucide-react';

import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { CareerCanvasFileImportDialog } from '../components/CareerCanvasFileImportDialog';
import { INTERVIEW_HELPER_COLUMN_GAP, interviewHelperCardWidth, interviewHelperColumns } from '../utils/interviewHelperLayout';
import { InterviewApplicationPicker } from '../components/InterviewApplicationPicker';
import { InterviewQaPanel } from '../components/InterviewQaPanel';
import { InterviewPracticePanel } from '../components/InterviewPracticePanel';
import { NodeHandles } from './_shared/NodeHandles';
import { LockBadge } from './_shared/LockBadge';
import { canvasCareerImportCandidates, reconcileCareerCanvasFileSelections, selectedCareerCanvasFiles, toggleCareerCanvasFileSelection } from '../utils/careerCanvasFileImport';
import { filesToDropPayloads } from '../utils/fileDropUtils';
import { approveCareerImportCompilation, beginCareerImportCompilation, failCareerImportCompilation } from '../utils/jobCareerCompilationReceipt';
import { generateId } from '../utils/idGenerator';
import { buildInterviewPlan, canonicalInterviewJobUrl, interviewLaunchErrorMessage, interviewPreparationInputDigest, INTERVIEW_HELPER_MAX_STEPS, validInterviewPreparationBrief } from '../utils/interviewHelper';

const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/u;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const snapshotId = value => typeof value === 'string' && SNAPSHOT_ID_RE.test(value) ? value : null;
// File names and labels are retained in the shareable canvas document. Do not
// silently remove invisible characters: doing so can make the displayed value
// differ from the file/value that the user selected.
const hasUnsafeDisplayCharacters = value => /[\p{Cc}\p{Cf}]/u.test(value);
const boundedText = (value, limit = 512) => typeof value === 'string'
  && !hasUnsafeDisplayCharacters(value) && value.trim() && value.trim().length <= limit ? value.trim() : null;
// Plans can faithfully contain ordinary line breaks and tabs from approved
// career evidence. Keep labels/filenames stricter above, but reject the
// remaining control and formatting characters in persisted plan text.
const hasUnsafePlanCharacters = value => [...value].some(character => (character !== '\t' && character !== '\r' && character !== '\n' && /[\p{Cc}\p{Cf}]/u.test(character)));
const boundedPlanText = (value, limit = 512) => typeof value === 'string'
  && !hasUnsafePlanCharacters(value) && value.trim() && value.trim().length <= limit ? value.trim() : null;
const safeFilename = value => boundedText(value, 180);
const sameSafeFilenames = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);

function sourceLabel(node, index) {
  const title = boundedText(node?.data?.activeTargetRole) || boundedText(node?.data?.targetRole);
  const city = boundedText(node?.data?.searchLocation?.city);
  return title ? `${title}${city ? ` · ${city}` : ''}` : `Job Search ${index + 1}`;
}
function sourceCandidates(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter(node => node?.type === 'jobhub' && snapshotId(node?.data?.careerSnapshotId))
    .map((node, index) => ({ id: node.id, snapshotId: node.data.careerSnapshotId, label: sourceLabel(node, index) }));
}
function nodeSignature(nodes) {
  return JSON.stringify({ sources: sourceCandidates(nodes), files: canvasCareerImportCandidates(nodes).map(file => ({ nodeId: file.nodeId, filePath: file.filePath, filename: file.filename })) });
}
function stateFromSignature(signature) {
  try { const value = JSON.parse(signature || '{}'); return { sources: Array.isArray(value.sources) ? value.sources : [], files: Array.isArray(value.files) ? value.files : [] }; } catch { return { sources: [], files: [] }; }
}
function stableCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function roleAttribution(snapshot, roleId) {
  const role = roleId && Array.isArray(snapshot?.profile?.roles) ? snapshot.profile.roles.find(item => item?.id === roleId) : null;
  return role ? [role.title, role.employer].filter(value => boundedText(value)).join(' · ') || null : null;
}
const LOCKED_PLAN_MAX_TEXT = 12_000;
const LOCKED_PLAN_MAX_TERMS = 2_048;
const MISSING_COMPONENT_LABELS = { decision: 'decision/trade-off', outcome: 'outcome', lesson: 'lesson learned' };
const LOCKED_PLAN_ENTITY_TYPES = new Set(['role', 'achievement', 'project', 'skill', 'education', 'certification', 'otherEvidence']);
const LOCKED_PLAN_SOURCE_FIELDS = new Set(['title', 'employer', 'claim', 'description', 'name', 'credential', 'institution', 'issuer', 'label', 'text']);
const ownKeysAre = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
};
const lockedText = (value, limit = LOCKED_PLAN_MAX_TEXT) => !!boundedPlanText(value, limit);
const lockedStringList = (value, maxItems, limit = LOCKED_PLAN_MAX_TEXT) => Array.isArray(value)
  && value.length <= maxItems && value.every(item => lockedText(item, limit));
const validLockedPlanShape = plan => {
  if (!ownKeysAre(plan, ['status', 'message', 'snapshotId', 'analysis', 'missingComponents', 'steps', 'evidence'])
    || plan.status !== 'supported' || !lockedText(plan.message, 512) || !snapshotId(plan.snapshotId)
    || !ownKeysAre(plan.analysis, ['transcript', 'terms', 'intent', 'askedComponents'])
    || !lockedText(plan.analysis.transcript, INTERVIEW_QUESTION_MAX_LENGTH)
    || !lockedStringList(plan.analysis.terms, LOCKED_PLAN_MAX_TERMS, 256)
    || !lockedText(plan.analysis.intent, 64) || !lockedStringList(plan.analysis.askedComponents, 8, 64)
    || !lockedStringList(plan.missingComponents, 3, 64)
    || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > INTERVIEW_HELPER_MAX_STEPS
    || !Array.isArray(plan.evidence) || plan.evidence.length !== plan.steps.length) return false;
  const validProvenance = value => ownKeysAre(value, ['entityType', 'entityId', 'roleId', 'sourceField', 'evidenceSegmentIds', 'directEvidenceSegmentIds'])
    && LOCKED_PLAN_ENTITY_TYPES.has(value.entityType) && lockedText(value.entityId, 1024)
    && (value.roleId === null || lockedText(value.roleId, 1024)) && LOCKED_PLAN_SOURCE_FIELDS.has(value.sourceField)
    && lockedStringList(value.evidenceSegmentIds, 128, 1024) && lockedStringList(value.directEvidenceSegmentIds, 128, 1024);
  const validMatch = value => ownKeysAre(value, ['score', 'terms', 'phrases', 'concepts'])
    && Number.isSafeInteger(value.score) && value.score >= 0 && value.score <= 100_000
    && lockedStringList(value.terms, LOCKED_PLAN_MAX_TERMS, 256)
    && lockedStringList(value.phrases, LOCKED_PLAN_MAX_TERMS, 512)
    && lockedStringList(value.concepts, 16, 64);
  const validStep = value => ownKeysAre(value, ['id', 'label', 'cue', 'provenance', 'match'])
    && lockedText(value.id, 4096) && lockedText(value.label, 512) && lockedText(value.cue)
    && validProvenance(value.provenance) && validMatch(value.match);
  const validEvidence = value => ownKeysAre(value, ['id', 'entityId', 'entityType', 'score'])
    && lockedText(value.id, 4096) && lockedText(value.entityId, 1024) && LOCKED_PLAN_ENTITY_TYPES.has(value.entityType)
    && Number.isSafeInteger(value.score) && value.score >= 0 && value.score <= 100_000;
  return plan.steps.every(validStep) && plan.evidence.every(validEvidence);
};
function validLockedPlan(plan, activeSnapshotId, snapshot) {
  // Validate the entire persisted shape before stableCanonicalJson recurses.
  // This bounds work and rejects deep/cyclic or extra renderer state outright.
  if (!validLockedPlanShape(plan) || plan.snapshotId !== activeSnapshotId) return false;
  const question = boundedPlanText(plan.analysis?.transcript, INTERVIEW_QUESTION_MAX_LENGTH);
  const canonical = question && buildInterviewPlan({ question, profile: snapshot, snapshotId: activeSnapshotId });
  return canonical?.status === 'supported' && stableCanonicalJson(canonical) === stableCanonicalJson(plan);
}
const planStepIndex = (value, length) => Math.max(0, Math.min(Number.isInteger(value) ? value : 0, Math.max(0, length - 1)));
const clearPreparationState = () => ({ interviewHelperPreparation: null, interviewHelperPreparationRecordId: null, interviewHelperPreparationInputBinding: null, interviewHelperPreparationInputDigest: null, interviewHelperPreparationRunId: null });
const clearDependentState = () => ({ ...clearPreparationState(), interviewHelperLockedPlan: null, interviewHelperCurrentStep: 0 });
const clearCareerImportState = () => ({ interviewHelperCareerGeneration: null, interviewHelperCareerCompilation: null, interviewHelperCareerSnapshotId: null, interviewHelperCareerFingerprint: null, interviewHelperCareerFilenames: [] });
function projectBundle(reply) {
  const value = reply?.bundle || reply?.artifact || reply;
  const artifactId = boundedText(value?.artifactId, 256);
  const label = safeFilename(value?.label || value?.displayName || value?.filename || value?.name);
  const candidateDigest = value?.digest || value?.applicationArtifactDigest;
  const digest = typeof candidateDigest === 'string' && DIGEST_RE.test(candidateDigest) ? candidateDigest : null;
  const integritySummary = boundedText(value?.integritySummary || value?.integrity || value?.verification?.status, 500);
  return artifactId && DIGEST_RE.test(artifactId) && label && digest ? { artifactId, label, digest, ...(integritySummary ? { integritySummary } : {}) } : null;
}
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_MANUAL_AI_RETIREMENT_RECEIPTS = 32;
const INTERVIEW_QUESTION_MAX_LENGTH = 2000;
const safeReceiptError = () => 'Career compilation did not complete. Reselect the career files to resume safely.';
const safePreparationRecoveryError = () => 'Preparation did not complete. Resume or change setup to try again.';
function manualAiCleanupMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys.join(',') !== 'kind,runId,status,version') return null;
  return value.version === 1
    && (value.kind === 'career' || value.kind === 'preparation')
    && RUN_ID_RE.test(value.runId || '')
    && value.status === 'failed'
    ? { version: 1, kind: value.kind, runId: value.runId, status: 'failed' }
    : null;
}
function manualAiRetirementReceipts(value) {
  if (!Array.isArray(value)) return [];
  const byRunId = new Map();
  for (const receipt of value) {
    // Older documents did not carry updatedAt. Accept that exact legacy shape,
    // but never copy arbitrary persisted fields into a new receipt.
    const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt) && Object.getPrototypeOf(receipt) === Object.prototype
      ? Object.keys(receipt).sort() : [];
    const legacyKeys = 'cancellationPending,cancellationReason,retirementPending,retirementReason,runId';
    const currentKeys = `${legacyKeys},updatedAt`;
    if ((keys.join(',') !== legacyKeys && keys.join(',') !== currentKeys)
      || !RUN_ID_RE.test(receipt.runId || '')
      || receipt.retirementPending !== true
      || receipt.retirementReason !== 'node-deleted'
      || typeof receipt.cancellationPending !== 'boolean'
      || receipt.cancellationReason !== 'node-deleted'
      || (Object.hasOwn(receipt, 'updatedAt') && (!Number.isSafeInteger(receipt.updatedAt) || receipt.updatedAt < 0))) continue;
    byRunId.set(receipt.runId, {
      runId: receipt.runId,
      retirementPending: true,
      retirementReason: 'node-deleted',
      cancellationPending: receipt.cancellationPending,
      cancellationReason: 'node-deleted',
      ...(Object.hasOwn(receipt, 'updatedAt') ? { updatedAt: receipt.updatedAt } : {}),
    });
  }
  return [...byRunId.values()].slice(-MAX_MANUAL_AI_RETIREMENT_RECEIPTS);
}
function mergeManualAiRetirementReceipts(receipts, runIds, cancellationPending) {
  const byRunId = new Map(manualAiRetirementReceipts(receipts).map(receipt => [receipt.runId, receipt]));
  for (const runId of Array.isArray(runIds) ? runIds : []) {
    if (!RUN_ID_RE.test(runId || '')) continue;
    byRunId.set(runId, {
      ...(byRunId.get(runId) || {}),
      runId,
      retirementPending: true,
      retirementReason: 'node-deleted',
      cancellationPending: cancellationPending === true,
      cancellationReason: 'node-deleted',
      updatedAt: Date.now(),
    });
  }
  return [...byRunId.values()].slice(-MAX_MANUAL_AI_RETIREMENT_RECEIPTS);
}
function preparationFor(data, activeSnapshotId) {
  const bundle = data.interviewHelperApplicationBundle;
  const url = canonicalInterviewJobUrl(data.interviewHelperJobUrl);
  const binding = interviewPreparationInputDigest({ snapshotId: activeSnapshotId, jobUrl: url, bundleArtifactId: bundle?.artifactId });
  return binding && data.interviewHelperPreparationInputBinding === binding && validInterviewPreparationBrief(data.interviewHelperPreparation, { snapshotId: activeSnapshotId, bundleArtifactId: bundle?.artifactId, bundleDigest: bundle?.digest }) ? data.interviewHelperPreparation : null;
}
function briefItemText(item) {
  if (typeof item === 'string') return item;
  return boundedText(item?.fact, 1200) || boundedText(item?.point, 1200) || '';
}

export const InterviewHelperNode = React.memo(function InterviewHelperNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const navigation = useContext(CanvasNavigationContext);
  const updateGlobal = navigation?.updateNodeDataGlobally || updateNodeData;
  const stateSignature = useStore(useCallback(state => nodeSignature(state.nodes), []));
  const { sources: candidates, files: canvasFiles } = useMemo(() => stateFromSignature(stateSignature), [stateSignature]);
  const [question, setQuestion] = useState('');
  const [urlDraft, setUrlDraft] = useState(data.interviewHelperJobUrl || '');
  const [urlError, setUrlError] = useState(null);
  // A partial-success note from the last Prepare (e.g. the fact-check was skipped).
  const [prepareNotice, setPrepareNotice] = useState(null);
  const [loaded, setLoaded] = useState({ key: null, status: 'idle', snapshot: null });
  const [unsupportedPlan, setUnsupportedPlan] = useState(null);
  const [showCanvasChooser, setShowCanvasChooser] = useState(false);
  const [canvasSelections, setCanvasSelections] = useState([]);
  const [canvasChooserError, setCanvasChooserError] = useState(null);
  const [careerInputError, setCareerInputError] = useState(null);
  const [careerRecoveryDiscard, setCareerRecoveryDiscard] = useState(null);
  const [bundleLoadStatus, setBundleLoadStatus] = useState('idle');
  const [bundlePickerError, setBundlePickerError] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const [verifiedPreparation, setVerifiedPreparation] = useState({ key: null, status: 'idle', brief: null, recordId: null });
  const [manualAiBusy, setManualAiBusy] = useState(false);
  const [manualAiCleanupBusy, setManualAiCleanupBusy] = useState(false);
  const [manualAiRetirementCleanupBusy, setManualAiRetirementCleanupBusy] = useState(false);
  const loadSequenceRef = useRef(0);
  const careerOperationRef = useRef(0);
  const bundleOperationRef = useRef(0);
  const preparationOperationRef = useRef(0);
  const localCareerRunRef = useRef(null);
  const localPreparationRunRef = useRef(null);
  const manualAiOperationRef = useRef(null);
  const persist = useCallback(patch => !data.locked && updateGlobal(id, patch), [data.locked, id, updateGlobal]);
  useEffect(() => { setUrlDraft(data.interviewHelperJobUrl || ''); }, [data.interviewHelperJobUrl]);
  const urlStateRef = useRef({ draft: urlDraft, saved: data.interviewHelperJobUrl });
  useEffect(() => { urlStateRef.current = { draft: urlDraft, saved: data.interviewHelperJobUrl }; }, [urlDraft, data.interviewHelperJobUrl]);

  const savedSourceId = typeof data.interviewHelperSourceNodeId === 'string' ? data.interviewHelperSourceNodeId : null;
  const savedJobSnapshotId = snapshotId(data.interviewHelperSourceSnapshotId);
  const persistedBundle = useMemo(() => projectBundle(data.interviewHelperApplicationBundle), [data.interviewHelperApplicationBundle]);
  const displayedCareerFilenames = useMemo(() => (Array.isArray(data.interviewHelperCareerFilenames) ? data.interviewHelperCareerFilenames : [])
    .map(filename => safeFilename(filename)).filter(Boolean), [data.interviewHelperCareerFilenames]);
  const selectedJobSource = useMemo(() => data.interviewHelperCareerMode === 'none' ? null : candidates.find(candidate => candidate.id === savedSourceId)
    || (!savedSourceId && !savedJobSnapshotId && candidates.length === 1 ? candidates[0] : null), [candidates, data.interviewHelperCareerMode, savedJobSnapshotId, savedSourceId]);
  const pinnedJobSnapshotId = data.interviewHelperCareerMode === 'none' ? null : savedSourceId && savedJobSnapshotId ? savedJobSnapshotId : null;
  const activeJobSnapshotId = pinnedJobSnapshotId || selectedJobSource?.snapshotId || null;
  const sourceMissing = data.interviewHelperCareerMode !== 'import' && !!pinnedJobSnapshotId && !selectedJobSource;
  const sourceHasNewerSnapshot = data.interviewHelperCareerMode !== 'import' && !!pinnedJobSnapshotId && !!selectedJobSource && selectedJobSource.snapshotId !== pinnedJobSnapshotId;
  const importReceipt = data.interviewHelperCareerCompilation;
  const cleanupMarker = manualAiCleanupMarker(data.interviewHelperManualAiCleanup);
  const retirementReceipts = manualAiRetirementReceipts(data.interviewHelperManualAiRetirementReceipts);
  const retirementRunIds = retirementReceipts.map(receipt => receipt.runId);
  const importSnapshotId = snapshotId(data.interviewHelperCareerSnapshotId);
  const importReady = data.interviewHelperCareerMode === 'import' && importReceipt?.version === 1 && importReceipt.status === 'approved' && importReceipt.careerSnapshotId === importSnapshotId && importReceipt.generation === data.interviewHelperCareerGeneration;
  const careerKind = data.interviewHelperCareerMode === 'import'
    ? (importReady ? 'import' : null)
    : activeJobSnapshotId ? 'job-search' : null;
  const activeSnapshotId = careerKind === 'import' ? importSnapshotId : activeJobSnapshotId;
  const sourceKey = activeSnapshotId ? `${careerKind}:${activeSnapshotId}` : null;
  const urlDirty = urlDraft !== (data.interviewHelperJobUrl || '');
  // The completion fence covers committed inputs only. A dirty URL draft
  // already hides the brief, and a committed URL change invalidates the run,
  // so a draft keystroke must not discard a finished manual-AI result.
  const preparationKey = `${activeSnapshotId || ''}\u0000${canonicalInterviewJobUrl(data.interviewHelperJobUrl) || ''}\u0000${persistedBundle?.artifactId || ''}\u0000${persistedBundle?.digest || ''}`;
  const preparationKeyRef = useRef(preparationKey);
  // Update during render rather than waiting for an effect: an async prepare
  // completion can otherwise win between a parent update and effect flush.
  preparationKeyRef.current = preparationKey;
  const invalidatePreparation = useCallback(() => { preparationOperationRef.current += 1; setPrepareNotice(null); }, []);
  const invalidateCareer = useCallback(() => { careerOperationRef.current += 1; }, []);
  const completeManualAiRun = useCallback(async (runId) => {
    if (!RUN_ID_RE.test(runId || '') || !window.electronAPI?.completeNonApiAiRun) throw new Error('Durable manual-AI cleanup is unavailable.');
    const result = await window.electronAPI.completeNonApiAiRun(runId);
    if (result?.cleared !== true && result?.absent !== true) throw new Error('The saved manual-AI handoff could not be retired.');
    return true;
  }, []);
  const retainManualAiCleanup = useCallback((kind, runId) => {
    if ((kind !== 'career' && kind !== 'preparation') || !RUN_ID_RE.test(runId || '')) return;
    persist({ interviewHelperManualAiCleanup: { version: 1, kind, runId, status: 'failed' } });
  }, [persist]);
  const retireTerminalManualAiRun = useCallback(async (kind, runId) => {
    try {
      await completeManualAiRun(runId);
      return true;
    } catch {
      // A cleanup receipt is created only after a terminal response was saved
      // (or fenced as stale), never while the worker is still in flight.
      retainManualAiCleanup(kind, runId);
      return false;
    }
  }, [completeManualAiRun, retainManualAiCleanup]);
  const locallyLiveManualAiRun = (kind, runId) => manualAiOperationRef.current?.kind === kind && manualAiOperationRef.current?.runId === runId
    || (kind === 'career' ? localCareerRunRef.current === runId : localPreparationRunRef.current === runId);
  const recoverableCareerRunId = ['compiling', 'failed'].includes(importReceipt?.status) && RUN_ID_RE.test(importReceipt.manualAiRunId || '') && !locallyLiveManualAiRun('career', importReceipt.manualAiRunId)
    ? importReceipt.manualAiRunId : null;
  const recoverablePreparationRunId = ['preparing', 'failed'].includes(data.interviewHelperPreparation?.status) && RUN_ID_RE.test(data.interviewHelperPreparationRunId || '') && !locallyLiveManualAiRun('preparation', data.interviewHelperPreparationRunId)
    ? data.interviewHelperPreparationRunId : null;
  // The bundle reload effect reads this without re-running its IPC per change.
  const recoverablePreparationRunIdRef = useRef(null);
  recoverablePreparationRunIdRef.current = recoverablePreparationRunId;
  // The bundle picker awaits a native dialog; it must judge the node as it is
  // when the dialog returns, not as it was when the button was clicked.
  const persistedBundleRef = useRef(null);
  persistedBundleRef.current = persistedBundle;
  const bundleLoadStatusRef = useRef('idle');
  bundleLoadStatusRef.current = bundleLoadStatus;
  const retireRecoverableManualAiRun = useCallback(async (kind, runId) => {
    if (!runId) return true;
    setManualAiBusy(true);
    try { return await retireTerminalManualAiRun(kind, runId); }
    finally { setManualAiBusy(false); }
  }, [retireTerminalManualAiRun]);

  useEffect(() => {
    if (showCanvasChooser) setCanvasSelections(current => reconcileCareerCanvasFileSelections(current, canvasFiles));
  }, [canvasFiles, showCanvasChooser]);

  useEffect(() => {
    // A saved source/snapshot pair is an immutable pin. Only a fresh helper
    // with one candidate gets the convenience initial selection automatically.
    if (data.interviewHelperCareerMode === 'import' || data.interviewHelperCareerMode === 'none' || pinnedJobSnapshotId || !selectedJobSource) return;
    let disposed = false;
    void (async () => {
      if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
      if (disposed) return;
      invalidatePreparation(); invalidateCareer();
      persist({ interviewHelperCareerMode: 'job-search', interviewHelperSourceNodeId: selectedJobSource.id, interviewHelperSourceSnapshotId: selectedJobSource.snapshotId, ...clearDependentState(), ...clearCareerImportState() });
    })();
    return () => { disposed = true; };
  }, [data.interviewHelperCareerMode, invalidateCareer, invalidatePreparation, persist, pinnedJobSnapshotId, recoverablePreparationRunId, retireRecoverableManualAiRun, selectedJobSource]);
  useEffect(() => {
    const sequence = ++loadSequenceRef.current;
    setUnsupportedPlan(null);
    if (!activeSnapshotId || !window.electronAPI?.loadInterviewHelperCareerSnapshot) { setLoaded({ key: sourceKey, status: activeSnapshotId ? 'error' : 'idle', snapshot: null }); return undefined; }
    let disposed = false;
    setLoaded({ key: sourceKey, status: 'loading', snapshot: null });
    void window.electronAPI.loadInterviewHelperCareerSnapshot({ snapshotId: activeSnapshotId, nodeId: id }).then(reply => {
      const snapshot = reply?.snapshot;
      if (!disposed && sequence === loadSequenceRef.current) setLoaded(snapshot?.snapshotId === activeSnapshotId && snapshot.profile ? { key: sourceKey, status: 'ready', snapshot } : { key: sourceKey, status: 'error', snapshot: null });
    }).catch(() => { if (!disposed && sequence === loadSequenceRef.current) setLoaded({ key: sourceKey, status: 'error', snapshot: null }); });
    return () => { disposed = true; };
  }, [activeSnapshotId, id, sourceKey]);
  const persistedPlanVerified = useMemo(() => loaded.status === 'ready' && loaded.snapshot?.snapshotId === activeSnapshotId && validLockedPlan(data.interviewHelperLockedPlan, activeSnapshotId, loaded.snapshot), [activeSnapshotId, data.interviewHelperLockedPlan, loaded]);
  const lockedPlan = persistedPlanVerified ? data.interviewHelperLockedPlan : null;
  useEffect(() => { if (loaded.status === 'ready' && data.interviewHelperLockedPlan && !persistedPlanVerified) persist({ interviewHelperLockedPlan: null, interviewHelperCurrentStep: 0 }); }, [data.interviewHelperLockedPlan, loaded.status, persist, persistedPlanVerified]);
  const currentStep = lockedPlan ? planStepIndex(data.interviewHelperCurrentStep, lockedPlan.steps.length) : 0;
  const candidatePrepBrief = !urlDirty ? preparationFor({ ...data, interviewHelperApplicationBundle: persistedBundle }, activeSnapshotId) : null;
  const candidatePreparationRecordId = typeof data.interviewHelperPreparationRecordId === 'string' && DIGEST_RE.test(data.interviewHelperPreparationRecordId)
    ? data.interviewHelperPreparationRecordId : null;
  const preparationVerificationKey = candidatePrepBrief && candidatePreparationRecordId && persistedBundle?.digest
    ? `${id}:${candidatePreparationRecordId}:${activeSnapshotId}:${canonicalInterviewJobUrl(data.interviewHelperJobUrl) || ''}:${persistedBundle.artifactId}:${persistedBundle.digest}` : null;
  useEffect(() => {
    if (!preparationVerificationKey || !candidatePrepBrief || !candidatePreparationRecordId || !persistedBundle?.digest || !window.electronAPI?.loadInterviewPreparedBrief) {
      setVerifiedPreparation({ key: preparationVerificationKey, status: preparationVerificationKey ? 'error' : 'idle', brief: null, recordId: null });
      return undefined;
    }
    let disposed = false;
    setVerifiedPreparation({ key: preparationVerificationKey, status: 'loading', brief: null, recordId: null });
    const jobUrl = canonicalInterviewJobUrl(data.interviewHelperJobUrl);
    void window.electronAPI.loadInterviewPreparedBrief({ nodeId: id, briefRecordId: candidatePreparationRecordId, snapshotId: activeSnapshotId, jobUrl, bundleArtifactId: persistedBundle.artifactId, bundleArtifactDigest: persistedBundle.digest }).then(reply => {
      const brief = reply?.brief;
      if (disposed) return;
      if (validInterviewPreparationBrief(brief, { snapshotId: activeSnapshotId, bundleArtifactId: persistedBundle.artifactId, bundleDigest: persistedBundle.digest })) {
        const answerCardCount = reply.answerBankAvailable === true && Number.isInteger(reply.answerCardCount) && reply.answerCardCount > 0 && reply.answerCardCount <= 20 ? reply.answerCardCount : 0;
        setVerifiedPreparation({ key: preparationVerificationKey, status: 'ready', brief, recordId: candidatePreparationRecordId, answerCardCount });
      } else {
        setVerifiedPreparation({ key: preparationVerificationKey, status: 'error', brief: null, recordId: null });
      }
    }).catch(() => { if (!disposed) setVerifiedPreparation({ key: preparationVerificationKey, status: 'error', brief: null, recordId: null }); });
    return () => { disposed = true; };
  }, [activeSnapshotId, candidatePrepBrief, candidatePreparationRecordId, data.interviewHelperJobUrl, id, persistedBundle, preparationVerificationKey]);
  const prepBrief = verifiedPreparation.key === preparationVerificationKey && verifiedPreparation.status === 'ready' ? verifiedPreparation.brief : null;
  const answerCardCount = prepBrief ? verifiedPreparation.answerCardCount || 0 : 0;
  const preparationVerificationStatus = candidatePrepBrief
    ? (preparationVerificationKey && verifiedPreparation.key === preparationVerificationKey ? verifiedPreparation.status : 'error')
    : 'idle';
  useEffect(() => {
    // A durable recovery is not a malformed completed brief. Retain its exact
    // binding/run id across reload so the user can explicitly resume it.
    const recovery = ['preparing', 'failed'].includes(data.interviewHelperPreparation?.status);
    if (data.interviewHelperPreparation && !recovery && !candidatePrepBrief && activeSnapshotId && !urlDirty) {
      persist(clearPreparationState());
    }
  }, [activeSnapshotId, candidatePrepBrief, data.interviewHelperPreparation, persist, urlDirty]);
  useEffect(() => {
    const saved = persistedBundle;
    if (!saved?.artifactId) { setBundleLoadStatus(data.interviewHelperApplicationBundle ? 'error' : 'idle'); return undefined; }
    if (!window.electronAPI?.loadInterviewApplicationBundle) { setBundleLoadStatus('error'); return undefined; }
    let disposed = false;
    setBundleLoadStatus('loading');
    void window.electronAPI.loadInterviewApplicationBundle({ nodeId: id, artifactId: saved.artifactId }).then(reply => {
      const refreshed = projectBundle(reply);
      if (disposed) return;
      // A durable preparation recovery is retired only through Replace/Remove
      // bundle; clearing it here would orphan its manual-AI run.
      if (!refreshed || refreshed.artifactId !== saved.artifactId || refreshed.digest !== saved.digest) { invalidatePreparation(); setBundleLoadStatus('error'); if (!recoverablePreparationRunIdRef.current) persist(clearPreparationState()); return; }
      setBundleLoadStatus('ready');
      if (refreshed.label !== saved.label || refreshed.integritySummary !== saved.integritySummary) persist({ interviewHelperApplicationBundle: refreshed });
    }).catch(() => { if (!disposed) { invalidatePreparation(); setBundleLoadStatus('error'); if (!recoverablePreparationRunIdRef.current) persist(clearPreparationState()); } });
    return () => { disposed = true; };
  }, [data.interviewHelperApplicationBundle, id, invalidatePreparation, persist, persistedBundle]);

  // Recovery receipts survive reloads; refs do not. A cleanup marker is only
  // recorded after a terminal result could not be retired, so persisted
  // `compiling`/`preparing` state cannot prove that its worker is still live.
  const cleanupRunStillActive = !!cleanupMarker
    && manualAiOperationRef.current?.kind === cleanupMarker.kind
    && manualAiOperationRef.current?.runId === cleanupMarker.runId;
  const manualAiStartBlocked = !!cleanupMarker || retirementRunIds.length > 0 || manualAiBusy;
  const retryManualAiCleanup = useCallback(async () => {
    if (!cleanupMarker || cleanupRunStillActive || manualAiCleanupBusy || data.locked) return;
    setManualAiCleanupBusy(true);
    try {
      await completeManualAiRun(cleanupMarker.runId);
      // Clear only after the main process authoritatively confirms cleared or
      // absent. A failure deliberately leaves the durable receipt intact.
      persist({ interviewHelperManualAiCleanup: null });
    } catch {
      // The current valid marker remains available for another explicit retry.
    } finally {
      setManualAiCleanupBusy(false);
    }
  }, [cleanupMarker, cleanupRunStillActive, completeManualAiRun, data.locked, manualAiCleanupBusy, persist]);
  const retryManualAiRetirementCleanup = useCallback(async () => {
    if (!retirementRunIds.length || manualAiRetirementCleanupBusy || data.locked) return;
    const cancelAndWait = window.electronAPI?.cancelNodeTaskAndWait;
    const completeRuns = window.electronAPI?.completeNonApiAiRuns;
    if (typeof cancelAndWait !== 'function' || typeof completeRuns !== 'function') return;
    let runIds = retirementRunIds;
    let cancellationSettled = false;
    setManualAiRetirementCleanupBusy(true);
    try {
      const acknowledgement = await cancelAndWait(id, 'cleanup-retry');
      if (acknowledgement?.settled !== true) {
        throw new Error('The saved cleanup cancellation did not finish.');
      }
      cancellationSettled = true;
      runIds = [...new Set([
        ...retirementRunIds,
        ...(Array.isArray(acknowledgement.manualAiRunIds) ? acknowledgement.manualAiRunIds : []),
      ].filter(runId => RUN_ID_RE.test(runId || '')))];
      const result = await completeRuns(runIds);
      const retiredRunIds = new Set([
        ...(Array.isArray(result?.clearedRunIds) ? result.clearedRunIds : []),
        ...(Array.isArray(result?.absentRunIds) ? result.absentRunIds : []),
      ]);
      if (result?.completed !== true || runIds.some(runId => !retiredRunIds.has(runId))) {
        throw new Error('The saved manual-AI handoffs could not be retired atomically.');
      }
      const nextPatch = { interviewHelperManualAiRetirementReceipts: null };
      if (
        ['compiling', 'failed'].includes(importReceipt?.status)
        && retiredRunIds.has(importReceipt.manualAiRunId)
      ) Object.assign(nextPatch, clearCareerImportState());
      if (
        ['preparing', 'failed'].includes(data.interviewHelperPreparation?.status)
        && retiredRunIds.has(data.interviewHelperPreparationRunId)
      ) Object.assign(nextPatch, clearPreparationState());
      if (cleanupMarker && retiredRunIds.has(cleanupMarker.runId)) {
        nextPatch.interviewHelperManualAiCleanup = null;
      }
      persist(nextPatch);
    } catch {
      // A settled acknowledgement can reveal a run that was still in the
      // renderer autosave gap. Retain it with the original receipts so a later
      // explicit retry cannot strand it after a failed atomic retirement.
      const merged = mergeManualAiRetirementReceipts(
        retirementReceipts,
        runIds,
        cancellationSettled ? false : true,
      );
      if (merged.length > 0) persist({ interviewHelperManualAiRetirementReceipts: merged });
    } finally {
      setManualAiRetirementCleanupBusy(false);
    }
  }, [cleanupMarker, data.interviewHelperPreparation, data.interviewHelperPreparationRunId, data.locked, id, importReceipt, manualAiRetirementCleanupBusy, persist, retirementReceipts, retirementRunIds]);

  const clearJobSource = useCallback(async () => {
    if (data.locked || data.interviewHelperCareerMode === 'import' || data.interviewHelperCareerMode === 'none') return;
    if (recoverableCareerRunId && !await retireRecoverableManualAiRun('career', recoverableCareerRunId)) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidateCareer(); invalidatePreparation();
    persist({ interviewHelperCareerMode: 'none', interviewHelperSourceNodeId: null, interviewHelperSourceSnapshotId: null, ...clearDependentState(), ...clearCareerImportState() });
  }, [data.interviewHelperCareerMode, data.locked, invalidateCareer, invalidatePreparation, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  const chooseJobSource = useCallback(async event => {
    const next = candidates.find(candidate => candidate.id === event.target.value);
    if (!next) { await clearJobSource(); return; }
    if (recoverableCareerRunId && !await retireRecoverableManualAiRun('career', recoverableCareerRunId)) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidateCareer(); invalidatePreparation();
    persist({ interviewHelperCareerMode: 'job-search', interviewHelperSourceNodeId: next.id, interviewHelperSourceSnapshotId: next.snapshotId, ...clearDependentState(), ...clearCareerImportState() });
  }, [candidates, clearJobSource, invalidateCareer, invalidatePreparation, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  const useLatestJobSnapshot = useCallback(async () => {
    if (data.locked || !sourceHasNewerSnapshot || !selectedJobSource) return;
    if (recoverableCareerRunId && !await retireRecoverableManualAiRun('career', recoverableCareerRunId)) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidateCareer(); invalidatePreparation();
    persist({ interviewHelperCareerMode: 'job-search', interviewHelperSourceNodeId: selectedJobSource.id, interviewHelperSourceSnapshotId: selectedJobSource.snapshotId, ...clearDependentState(), ...clearCareerImportState() });
  }, [data.locked, invalidateCareer, invalidatePreparation, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun, selectedJobSource, sourceHasNewerSnapshot]);
  const clearImportedCareerSource = useCallback(async () => {
    if (data.locked || data.interviewHelperCareerMode !== 'import') return;
    if (recoverableCareerRunId && !await retireRecoverableManualAiRun('career', recoverableCareerRunId)) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidateCareer(); invalidatePreparation();
    persist({ interviewHelperCareerMode: 'none', interviewHelperSourceNodeId: null, interviewHelperSourceSnapshotId: null, ...clearCareerImportState(), ...clearDependentState() });
  }, [data.interviewHelperCareerMode, data.locked, invalidateCareer, invalidatePreparation, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  const commitUrl = useCallback(async () => {
    // Leaving an empty field that never held a URL is not an invalid entry.
    if (!urlDraft.trim() && !data.interviewHelperJobUrl) { setUrlError(null); return; }
    const canonical = canonicalInterviewJobUrl(urlDraft);
    if (!canonical) { setUrlError('Enter a valid http or https job listing URL without credentials.'); return; }
    setUrlError(null); setUrlDraft(canonical);
    if (canonical !== data.interviewHelperJobUrl) {
      if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
      invalidatePreparation(); persist({ interviewHelperJobUrl: canonical, ...clearPreparationState() });
    }
  }, [data.interviewHelperJobUrl, invalidatePreparation, persist, recoverablePreparationRunId, retireRecoverableManualAiRun, urlDraft]);
  const revertUrlDraft = useCallback(() => {
    setUrlDraft(data.interviewHelperJobUrl || ''); setUrlError(null);
  }, [data.interviewHelperJobUrl]);
  const clearJobUrl = useCallback(async () => {
    if (data.locked || !data.interviewHelperJobUrl) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidatePreparation(); setUrlDraft(''); setUrlError(null);
    persist({ interviewHelperJobUrl: null, ...clearPreparationState() });
  }, [data.interviewHelperJobUrl, data.locked, invalidatePreparation, persist, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  const chooseBundle = useCallback(async (folderToken) => {
    const fromFolder = typeof folderToken === 'string';
    const method = fromFolder ? 'selectInterviewApplicationFolder' : 'selectInterviewApplicationBundle';
    if (data.locked || !window.electronAPI?.[method]) return false;
    const token = ++bundleOperationRef.current;
    setBundlePickerError(null);
    try {
      const reply = await window.electronAPI[method](fromFolder ? { nodeId: id, token: folderToken } : { nodeId: id });
      if (token !== bundleOperationRef.current || reply?.cancelled) return false;
      if (fromFolder && reply?.success === false) throw new Error(reply.error || 'The selected application could not be read. Try again.');
      const bundle = projectBundle(reply);
      if (!bundle) throw new Error('The selected application bundle could not be verified.');
      // Never overwrite a saved URL or a draft typed while selection was pending.
      const returnedUrl = canonicalInterviewJobUrl(reply?.jobUrl);
      const fillUrl = returnedUrl && !urlStateRef.current.saved && !urlStateRef.current.draft.trim();
      const urlPatch = fillUrl ? { interviewHelperJobUrl: returnedUrl } : {};
      const current = persistedBundleRef.current;
      // The same content-addressed bundle must not discard a finished brief,
      // except when filling a previously empty URL changes the input binding.
      if (!fillUrl && current?.artifactId === bundle.artifactId && current?.digest === bundle.digest && bundleLoadStatusRef.current === 'ready') {
        if (current.label !== bundle.label || current.integritySummary !== bundle.integritySummary) persist({ interviewHelperApplicationBundle: bundle });
        return true;
      }
      const recoveryRunId = recoverablePreparationRunIdRef.current;
      if (recoveryRunId && !await retireRecoverableManualAiRun('preparation', recoveryRunId)) return false;
      if (token !== bundleOperationRef.current) return false;
      invalidatePreparation();
      if (fillUrl) { setUrlDraft(returnedUrl); setUrlError(null); }
      persist({ interviewHelperApplicationBundle: bundle, ...urlPatch, ...clearPreparationState() });
      return true;
    } catch (failure) {
      if (token === bundleOperationRef.current) setBundlePickerError(fromFolder ? failure?.message || 'The selected application could not be read. Try again.' : 'The selected application bundle could not be read. Choose another bundle and try again.');
      return false;
    }
  }, [data.locked, id, invalidatePreparation, persist, retireRecoverableManualAiRun]);
  const removeBundle = useCallback(async () => {
    if (data.locked || !data.interviewHelperApplicationBundle) return;
    // Fence an open picker so it cannot restore the removed bundle afterwards.
    bundleOperationRef.current += 1;
    setBundlePickerError(null);
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidatePreparation();
    persist({ interviewHelperApplicationBundle: null, ...clearPreparationState() });
  }, [data.interviewHelperApplicationBundle, data.locked, invalidatePreparation, persist, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  const compileCareerFiles = useCallback(async files => {
    let filePaths = (Array.isArray(files) ? files : []).map(file => file?.filePath || file?.path).filter(path => typeof path === 'string' && path.trim() && !/\.app[\\/]*$/iu.test(path));
    let filenames = filePaths.map(path => safeFilename(path.split(/[\\/]/u).pop())).filter(Boolean);
    if (data.locked || manualAiStartBlocked || manualAiOperationRef.current || localCareerRunRef.current || !filePaths.length || !window.electronAPI?.parseCareerData) return;
    if (filenames.length !== filePaths.length) {
      setCareerRecoveryDiscard(null);
      setCareerInputError('Each selected career file needs a safe visible filename. Rename files containing control or invisible formatting characters and try again.');
      return;
    }
    const resumableCandidate = ['compiling', 'failed'].includes(importReceipt?.status) && typeof importReceipt?.generation === 'string' && RUN_ID_RE.test(importReceipt?.manualAiRunId || '')
      ? importReceipt : null;
    const savedFilenames = data.interviewHelperCareerFilenames;
    if (resumableCandidate && Array.isArray(savedFilenames) && !sameSafeFilenames(savedFilenames, filenames)
      && sameSafeFilenames([...savedFilenames].sort(), [...filenames].sort())) {
      // The same files in a different drag order are the same documents, but the
      // snapshot fingerprint is order-sensitive: resume in the recorded order.
      const remaining = filePaths.map((path, index) => ({ path, name: filenames[index] }));
      const ordered = savedFilenames.map(name => remaining.splice(remaining.findIndex(item => item.name === name), 1)[0]);
      filePaths = ordered.map(item => item.path); filenames = ordered.map(item => item.name);
    }
    if (resumableCandidate && !sameSafeFilenames(data.interviewHelperCareerFilenames, filenames)) {
      // A durable run is bound to its original documents. Do not let a new
      // selection reuse that identity; its existing recovery must be resolved
      // or resumed with the same safe filename list first.
      setCareerInputError(recoverableCareerRunId ? 'Career compilation is awaiting recovery for its original files. Reselect those same files to resume safely, or discard that settled recovery before importing different files.' : 'Career compilation is still active for its original files. Wait for it to finish before choosing different files.');
      setCareerRecoveryDiscard(recoverableCareerRunId ? { runId: recoverableCareerRunId } : null);
      return;
    }
    setCareerInputError(null); setCareerRecoveryDiscard(null);
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    const token = ++careerOperationRef.current;
    const resumable = resumableCandidate;
    const generation = resumable?.generation || `interview-helper:career:${generateId()}`;
    const manualAiRunId = resumable?.manualAiRunId || `interview-helper:compile:${generateId()}`;
    const receipt = beginCareerImportCompilation({ generation, manualAiRunId });
    if (!receipt) return;
    manualAiOperationRef.current = { kind: 'career', runId: manualAiRunId };
    setManualAiBusy(true);
    localCareerRunRef.current = manualAiRunId;
    invalidatePreparation();
    persist({ interviewHelperCareerMode: 'import', interviewHelperSourceNodeId: null, interviewHelperSourceSnapshotId: null, interviewHelperCareerGeneration: generation, interviewHelperCareerCompilation: receipt, interviewHelperCareerSnapshotId: null, interviewHelperCareerFingerprint: null, interviewHelperCareerFilenames: filenames, ...clearDependentState() });
    try {
      const reply = await window.electronAPI.parseCareerData({ filePaths, nodeId: id, manualAiRunId });
      const approved = reply?.success && approveCareerImportCompilation(receipt, { generation, attemptId: receipt.attemptId, careerSnapshotId: reply.careerSnapshotId, profileFingerprint: reply.fingerprint });
      if (!approved) throw new Error(reply?.error || 'Career compilation did not return an approved snapshot.');
      if (token !== careerOperationRef.current) {
        await retireTerminalManualAiRun('career', manualAiRunId);
        return;
      }
      persist({ interviewHelperCareerMode: 'import', interviewHelperCareerGeneration: generation, interviewHelperCareerCompilation: approved, interviewHelperCareerSnapshotId: approved.careerSnapshotId, interviewHelperCareerFingerprint: approved.profileFingerprint || null });
      await retireTerminalManualAiRun('career', manualAiRunId);
    } catch {
      if (token === careerOperationRef.current) persist({ interviewHelperCareerCompilation: failCareerImportCompilation(receipt, { generation, attemptId: receipt.attemptId, error: safeReceiptError() }) });
      else await retireTerminalManualAiRun('career', manualAiRunId);
    }
    finally {
      if (localCareerRunRef.current === manualAiRunId) localCareerRunRef.current = null;
      if (manualAiOperationRef.current?.runId === manualAiRunId) { manualAiOperationRef.current = null; setManualAiBusy(false); }
    }
  }, [data.interviewHelperCareerFilenames, data.locked, id, importReceipt, invalidatePreparation, manualAiStartBlocked, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun, retireTerminalManualAiRun]);
  const discardCareerRecovery = useCallback(async () => {
    const runId = careerRecoveryDiscard?.runId;
    if (!runId || !await retireRecoverableManualAiRun('career', runId)) return;
    persist(clearCareerImportState());
    setCareerInputError('Previous career recovery was discarded. Choose or drop the new career files to start a new compilation.'); setCareerRecoveryDiscard(null);
  }, [careerRecoveryDiscard, persist, retireRecoverableManualAiRun]);
  const nativeDragOver = useCallback(event => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const nativeDrop = useCallback(event => {
    event.preventDefault();
    event.stopPropagation();
    const files = filesToDropPayloads(event.dataTransfer?.files).map(file => ({ filePath: file.path, filename: file.name }));
    void compileCareerFiles(files);
  }, [compileCareerFiles]);
  const prepare = useCallback(async () => {
    const jobUrl = canonicalInterviewJobUrl(data.interviewHelperJobUrl); const bundle = persistedBundle;
    const binding = interviewPreparationInputDigest({ snapshotId: activeSnapshotId, jobUrl, bundleArtifactId: bundle?.artifactId });
    if (data.locked || manualAiStartBlocked || manualAiOperationRef.current || !binding || !bundle?.digest || loaded.status !== 'ready' || !window.electronAPI?.prepareInterviewBrief) return;
    const token = ++preparationOperationRef.current;
    const resumableRunId = data.interviewHelperPreparationInputBinding === binding && RUN_ID_RE.test(data.interviewHelperPreparationRunId || '')
      ? data.interviewHelperPreparationRunId : null;
    const manualAiRunId = resumableRunId || `interview-helper:prepare:${generateId()}`; const operationKey = preparationKey;
    manualAiOperationRef.current = { kind: 'preparation', runId: manualAiRunId };
    setManualAiBusy(true);
    localPreparationRunRef.current = manualAiRunId;
    persist({ interviewHelperPreparation: { status: 'preparing' }, interviewHelperPreparationRecordId: null, interviewHelperPreparationRunId: manualAiRunId, interviewHelperPreparationInputBinding: binding });
    setPrepareNotice(null);
    try {
      const reply = await window.electronAPI.prepareInterviewBrief({ nodeId: id, snapshotId: activeSnapshotId, jobUrl, bundleArtifactId: bundle.artifactId, manualAiRunId });
      const brief = reply?.brief;
      if (token !== preparationOperationRef.current || operationKey !== preparationKeyRef.current) {
        await retireTerminalManualAiRun('preparation', manualAiRunId);
        return;
      }
      const briefRecordId = typeof reply?.briefRecordId === 'string' && DIGEST_RE.test(reply.briefRecordId) ? reply.briefRecordId : null;
      if (!briefRecordId || !validInterviewPreparationBrief(brief, { snapshotId: activeSnapshotId, bundleArtifactId: bundle.artifactId, bundleDigest: bundle.digest })) throw new Error(reply?.error || 'Preparation response was invalid.');
      persist({ interviewHelperPreparation: brief, interviewHelperPreparationRecordId: briefRecordId, interviewHelperPreparationInputBinding: binding, interviewHelperPreparationInputDigest: boundedText(reply?.inputDigest, 256) || null, interviewHelperPreparationRunId: null });
      setPrepareNotice(boundedText(reply?.qaWarning, 300) || null);
      await retireTerminalManualAiRun('preparation', manualAiRunId);
    } catch {
      if (token === preparationOperationRef.current && operationKey === preparationKeyRef.current) persist({ interviewHelperPreparation: { status: 'failed', error: safePreparationRecoveryError() }, interviewHelperPreparationInputBinding: binding, interviewHelperPreparationRunId: manualAiRunId });
      else await retireTerminalManualAiRun('preparation', manualAiRunId);
    }
    finally {
      if (localPreparationRunRef.current === manualAiRunId) localPreparationRunRef.current = null;
      if (manualAiOperationRef.current?.runId === manualAiRunId) { manualAiOperationRef.current = null; setManualAiBusy(false); }
    }
  }, [activeSnapshotId, data.interviewHelperJobUrl, data.interviewHelperPreparationInputBinding, data.interviewHelperPreparationRunId, data.locked, id, loaded.status, manualAiStartBlocked, persist, persistedBundle, preparationKey, retireTerminalManualAiRun]);
  const launch = useCallback(async () => {
    if (!prepBrief || !verifiedPreparation.recordId || bundleLoadStatus !== 'ready' || !window.electronAPI?.launchInterviewWindow) return;
    const jobUrl = canonicalInterviewJobUrl(data.interviewHelperJobUrl);
    if (!jobUrl) return;
    setLaunchError(null);
    try { await window.electronAPI.launchInterviewWindow({ nodeId: id, snapshotId: activeSnapshotId, jobUrl, briefRecordId: verifiedPreparation.recordId, brief: prepBrief, plan: lockedPlan || null, currentStep }); }
    catch (error) { setLaunchError(interviewLaunchErrorMessage(error)); }
  }, [activeSnapshotId, bundleLoadStatus, currentStep, data.interviewHelperJobUrl, id, lockedPlan, prepBrief, verifiedPreparation.recordId]);
  const askQuestion = useCallback(() => { const text = question.trim(); if (!text || text.length > INTERVIEW_QUESTION_MAX_LENGTH || data.locked || loaded.status !== 'ready' || !activeSnapshotId || lockedPlan) return; const plan = buildInterviewPlan({ question: text, profile: loaded.snapshot, snapshotId: activeSnapshotId }); if (plan.status !== 'supported') { setUnsupportedPlan(plan); return; }
    // Persist only a rail the render-time verifier accepts; otherwise it would
    // be erased on the next render with no explanation.
    if (!validLockedPlan(plan, activeSnapshotId, loaded.snapshot)) { setUnsupportedPlan({ status: 'unsupported', message: 'Matching saved evidence contains characters this view cannot display safely. Review that career entry before relying on it here.' }); return; }
    setUnsupportedPlan(null); persist({ interviewHelperLockedPlan: plan, interviewHelperCurrentStep: 0 }); }, [activeSnapshotId, data.locked, loaded, lockedPlan, persist, question]);
  const moveStep = useCallback(offset => lockedPlan && persist({ interviewHelperCurrentStep: planStepIndex(currentStep + offset, lockedPlan.steps.length) }), [currentStep, lockedPlan, persist]);
  const canPrepare = !data.locked && !manualAiStartBlocked && !urlDirty && loaded.status === 'ready' && bundleLoadStatus === 'ready' && preparationVerificationStatus !== 'loading' && !!canonicalInterviewJobUrl(data.interviewHelperJobUrl) && !!persistedBundle?.artifactId && !!persistedBundle?.digest;
  const preparationStatus = data.interviewHelperPreparation?.status;
  const preparationError = safePreparationRecoveryError();
  const locallyPreparing = preparationStatus === 'preparing' && localPreparationRunRef.current === data.interviewHelperPreparationRunId;
  // Widen by whole columns as content grows, so the full card fits the window
  // at the largest zoom instead of needing to be zoomed out to unreadable text.
  const bodyRef = useRef(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    const pick = () => setColumns(current => interviewHelperColumns((body.offsetHeight - 24) * current, { width: window.innerWidth, height: window.innerHeight }, current));
    const observer = new ResizeObserver(pick);
    observer.observe(body);
    window.addEventListener('resize', pick);
    return () => { observer.disconnect(); window.removeEventListener('resize', pick); };
  }, []);

  return <div className="relative group rounded-xl border border-violet-400/30 bg-[#16141c] shadow-xl text-white" style={{ width: interviewHelperCardWidth(columns) }}>
    <NodeHandles className="w-2 h-2 bg-violet-300" />{data.locked && <LockBadge />}
    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5"><CircleHelp size={17} className="text-violet-300" /><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">Interview Helper</h3><p className="text-[10px] text-white/45">Prepare, then open a dedicated interview view</p></div><ShieldCheck size={15} className="text-emerald-300" aria-label="Uses saved career evidence only" /></div>
    {/* Balanced columns: the setup sections and the long practice feedback
        share the width instead of stacking into one very tall strip. */}
    <div ref={bodyRef} className="p-3 [column-fill:balance] [&>*]:mb-3" style={{ columnCount: columns, columnGap: INTERVIEW_HELPER_COLUMN_GAP }}>
      {retirementRunIds.length > 0 && <p role="alert" className="break-inside-avoid rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-xs text-amber-100">A restored deletion cleanup is still pending. Retry it before starting another worker task. <button type="button" className="ml-1 underline disabled:opacity-50" onClick={retryManualAiRetirementCleanup} disabled={data.locked || manualAiRetirementCleanupBusy}>{manualAiRetirementCleanupBusy ? 'Retrying…' : 'Retry restored cleanup'}</button></p>}
      {cleanupMarker && <p role="alert" className="break-inside-avoid rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-xs text-amber-100">A completed {cleanupMarker.kind === 'career' ? 'career compilation' : 'interview preparation'} worker could not be retired. {cleanupRunStillActive ? 'Wait for that worker to reach a terminal state.' : 'Retry cleanup before starting another worker task.'} {!cleanupRunStillActive && <button type="button" className="ml-1 underline disabled:opacity-50" onClick={retryManualAiCleanup} disabled={data.locked || manualAiCleanupBusy}>{manualAiCleanupBusy ? 'Retrying…' : 'Retry manual-AI cleanup'}</button>}</p>}
      <section className="break-inside-avoid space-y-2" aria-label="1. Career data"><p className="text-[11px] font-medium text-violet-200">1. Career data</p><div className="nodrag rounded-lg border-2 border-dashed border-violet-400/60 bg-violet-500/10 p-4 text-sm text-violet-100" onDragOver={nativeDragOver} onDrop={nativeDrop}><p className="font-semibold">Drop career files here</p><p className="mt-1 text-xs text-white/60">Use your original career data, not application documents.</p><button type="button" className="mt-2 rounded-md border border-violet-300/40 px-2 py-1 text-xs hover:bg-violet-400/10 disabled:opacity-40" onClick={() => setShowCanvasChooser(true)} disabled={data.locked || manualAiStartBlocked}>choose canvas files</button></div><p className="text-[10px] text-white/45">Or use an approved Job Search snapshot (secondary option)</p>{candidates.length ? <label className="block text-[11px] text-white/60">Approved Job Search snapshot<select aria-label="Career source for Interview Helper" className="nodrag mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs" value={data.interviewHelperCareerMode === 'import' ? '' : selectedJobSource?.id || ''} onChange={chooseJobSource} disabled={data.locked}><option value="">Choose a Job Search module</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-2 text-xs text-amber-100">Add a Job Search module with an approved career snapshot, or import career files below.</p>}{(selectedJobSource || pinnedJobSnapshotId) && data.interviewHelperCareerMode !== 'import' && <button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onClick={clearJobSource} disabled={data.locked || manualAiBusy} aria-label="Clear selected Job Search source">Clear selected Job Search source</button>}{data.interviewHelperCareerMode === 'import' && <button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onClick={clearImportedCareerSource} disabled={data.locked || manualAiBusy} aria-label="Clear imported career source">Clear imported career source</button>}{sourceHasNewerSnapshot && <p role="status" className="text-xs text-amber-100">Job Search has a newer approved snapshot. This helper is still using its saved snapshot. <button type="button" className="underline disabled:opacity-50" onClick={useLatestJobSnapshot} disabled={data.locked || manualAiBusy} aria-label="Use latest Job Search snapshot">Use latest Job Search snapshot</button></p>}{sourceMissing && <p role="status" className="text-xs text-amber-100">The selected Job Search source is no longer on this canvas. This helper is still using its saved approved snapshot.</p>}{careerInputError && <p role="alert" className="text-xs text-amber-100">{careerInputError}</p>}{careerRecoveryDiscard && <button type="button" className="text-xs text-violet-200 underline" onClick={discardCareerRecovery} disabled={data.locked || manualAiBusy}>Discard previous career recovery</button>}{importReceipt?.status === 'compiling' && <p role="status" className="text-xs text-amber-100">{localCareerRunRef.current === importReceipt.manualAiRunId ? 'Compiling career files…' : 'Career compilation was interrupted. Reselect the same career files to resume safely.'}</p>}{importReceipt?.status === 'failed' && <p role="alert" className="text-xs text-red-200">{safeReceiptError()} <button type="button" className="underline" onClick={() => setShowCanvasChooser(true)} disabled={data.locked || manualAiStartBlocked}>Retry</button></p>}{importReady && <p className="text-xs text-emerald-200">Independent career snapshot ready{displayedCareerFilenames.length ? ` · ${displayedCareerFilenames.join(', ')}` : ''}</p>}</section>
      {activeSnapshotId && loaded.status === 'loading' && <p role="status" className="text-xs text-white/50">Loading the pinned career snapshot…</p>}{activeSnapshotId && loaded.status === 'error' && <p role="alert" className="text-xs text-red-200">The selected career snapshot is unavailable. Choose or compile another source.</p>}
      <section className="break-inside-avoid space-y-2 border-t border-white/10 pt-3" aria-label="2. Application">
        <p className="text-[11px] font-medium text-violet-200">2. Application</p>
        <InterviewApplicationPicker nodeId={id} canvasFilePath={navigation?.getCurrentFile?.() || navigation?.currentFile || null} selectedLabel={persistedBundle?.label} disabled={data.locked || manualAiBusy} onSelect={chooseBundle} />
        <button type="button" className="nodrag w-full rounded-md border border-white/10 px-2 py-1.5 text-xs disabled:opacity-50" onClick={chooseBundle} disabled={data.locked}><FileUp size={13} className="mr-1 inline" />{data.interviewHelperApplicationBundle ? 'Replace application bundle' : 'Choose application bundle'}</button>
        {!data.interviewHelperApplicationBundle && <p className="text-[10px] text-white/45">Or choose an application bundle manually.</p>}
        {data.interviewHelperApplicationBundle && <><p className="text-[11px] text-white/60">{persistedBundle?.label || 'Selected application bundle'}{persistedBundle?.integritySummary ? ` · ${persistedBundle.integritySummary}` : ''}{bundleLoadStatus === 'loading' ? ' · checking…' : ''}</p><button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onClick={removeBundle} disabled={data.locked || manualAiBusy} aria-label="Remove selected application bundle">Remove application bundle</button></>}
        {bundlePickerError && <p role="alert" className="text-[11px] text-red-200">{bundlePickerError}</p>}{bundleLoadStatus === 'error' && <p role="alert" className="text-[11px] text-red-200">The selected application bundle is unavailable, changed, or cannot be checked in this app version. Replace it to prepare.</p>}
        <label className="block text-[11px] text-white/60">Original job listing URL (editable)<input aria-label="Original job listing URL" className="nodrag mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs" value={urlDraft} onChange={event => { setUrlDraft(event.target.value); setUrlError(null); }} onBlur={commitUrl} onKeyDown={event => { if (event.key === 'Enter') commitUrl(); }} disabled={data.locked} placeholder="https://company.example/jobs/…" /></label>
        {urlDirty && <button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onMouseDown={event => event.preventDefault()} onClick={revertUrlDraft} disabled={data.locked} aria-label="Revert job listing URL edit">Revert edit</button>}{data.interviewHelperJobUrl && <button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onClick={clearJobUrl} disabled={data.locked || manualAiBusy} aria-label="Clear saved job listing URL">Clear saved URL</button>}{urlError && <p role="alert" className="text-[11px] text-red-200">{urlError}</p>}
      </section>
      <section className="break-inside-avoid space-y-2 border-t border-white/10 pt-3" aria-label="4. Interview preparation"><p className="text-[11px] font-medium text-violet-200">4. Interview preparation</p><p className="text-[11px] text-white/60">Prepare researches the job, checks the brief, then prepares spoken answers from your approved evidence. Finish preparation before the interview.</p>{urlDirty && <p role="status" className="text-[11px] text-amber-100">Finish or revert the edited job URL before using this brief.</p>}{candidatePrepBrief && !prepBrief && preparationVerificationStatus === 'loading' && <p role="status" className="text-[11px] text-white/55">Checking saved brief…</p>}{candidatePrepBrief && !prepBrief && preparationVerificationStatus === 'error' && <p role="alert" className="text-[11px] text-amber-100">Saved brief could not be verified; prepare again.</p>}<button type="button" className="nodrag w-full rounded-md bg-violet-500/20 px-2 py-1.5 text-xs text-violet-100 disabled:opacity-50" onClick={prepare} disabled={!canPrepare || locallyPreparing}>{locallyPreparing ? 'Preparing…' : preparationStatus === 'preparing' || (preparationStatus === 'failed' && data.interviewHelperPreparationRunId) ? 'Resume preparation' : prepBrief ? 'Prepare again' : 'Prepare interview brief'}</button><p className="text-[11px] text-white/60">Fills empty answers; existing answers are kept.</p>{preparationStatus === 'failed' && <p role="alert" className="text-[11px] text-red-200">{preparationError}</p>}{prepareNotice && preparationStatus !== 'failed' && <p role="status" className="text-[11px] text-amber-100">{prepareNotice}</p>}</section>
      <InterviewQaPanel nodeId={id} snapshotId={activeSnapshotId} refreshKey={`${preparationStatus}:${data.interviewHelperPreparationRecordId || ''}:${locallyPreparing}`} disabled={data.locked || manualAiBusy || locallyPreparing} />
      {prepBrief && <section className="break-inside-avoid space-y-2 rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-2" aria-label="Interview preparation ready"><p className="text-xs font-medium text-emerald-100"><BriefcaseBusiness size={13} className="mr-1 inline" />{answerCardCount ? `${answerCardCount} prepared answers ready` : 'Research ready'}{prepBrief.role?.title ? ` · ${prepBrief.role.title}${prepBrief.role.company ? ` at ${prepBrief.role.company}` : ''}` : ''}</p><p className="text-[11px] text-white/70">{answerCardCount ? 'Prepared questions open a ready-to-say answer locally. Unmatched questions fall back to exact saved career cues.' : 'Research is prepared. Live questions retrieve exact saved career cues, not a complete spoken answer. Prepare again to add spoken answer cards.'}</p><p className="text-[11px] text-amber-100">Confirm this career source matches the application you submitted. This bundle is a captured copy; replace it after editing the documents.</p>{[['Researched themes', prepBrief.roleThemes], ['Likely questions', prepBrief.likelyQuestions], ['Submitted wording — reference, not career evidence', prepBrief.applicationPositioning], ['Source warnings', prepBrief.warnings]].map(([label, items]) => <div key={label}><p className="text-[10px] font-semibold uppercase text-white/45">{label}</p><p className="text-[11px] text-white/70">{items.slice(0, 3).map(briefItemText).filter(Boolean).join(' · ') || 'None'}</p></div>)}<button type="button" className="nodrag w-full rounded-md bg-emerald-500/20 px-2 py-1.5 text-xs text-emerald-50 disabled:opacity-50" onClick={launch} disabled={bundleLoadStatus !== 'ready' || !window.electronAPI?.launchInterviewWindow}><Rocket size={13} className="mr-1 inline" />Launch interview view</button>{launchError && <p role="alert" className="text-[11px] text-red-200">{launchError}</p>}</section>}
      <InterviewPracticePanel nodeId={id} briefRecordId={verifiedPreparation.recordId || null} snapshotId={activeSnapshotId || null} canonicalJobUrl={canonicalInterviewJobUrl(data.interviewHelperJobUrl) || null} bundleArtifactId={persistedBundle?.artifactId || null} bundleArtifactDigest={persistedBundle?.digest || null} ready={!!prepBrief && !!verifiedPreparation.recordId && bundleLoadStatus === 'ready' && !!activeSnapshotId && !!canonicalInterviewJobUrl(data.interviewHelperJobUrl)} disabled={data.locked || manualAiBusy || locallyPreparing} />
      {lockedPlan ? <section aria-label="Locked interview answer rail" className="break-inside-avoid space-y-2 border-t border-white/10 pt-3"><p className="text-[11px] font-medium text-violet-200">Saved answer rail · thought {currentStep + 1} of {lockedPlan.steps.length}</p>{boundedPlanText(lockedPlan.message, 500) && <p role="status" className="text-[11px] text-amber-100">{boundedPlanText(lockedPlan.message, 500)}</p>}{lockedPlan.missingComponents.length > 0 && <p role="status" className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">Saved evidence does not document: {lockedPlan.missingComponents.map(item => MISSING_COMPONENT_LABELS[item] || item).join(', ')}. Do not fill that gap from this rail.</p>}<div className="rounded-md border border-white/10 bg-black/20 px-2 py-1.5"><p className="text-[10px] font-semibold uppercase text-white/45">Question</p><p className="text-xs text-white/80">{lockedPlan.analysis.transcript}</p></div><ol aria-label="All grounded interview evidence" className="space-y-1.5">{lockedPlan.steps.map((step, index) => <li key={step.id} aria-current={index === currentStep ? 'step' : undefined} className={`rounded-lg border p-2 ${index === currentStep ? 'border-violet-300/35 bg-violet-500/10' : 'border-white/10 bg-black/10 text-white/60'}`}><p className="text-[10px] font-semibold text-violet-200">{index + 1}. {step.label}</p><p className="mt-1 text-xs">{step.cue}</p><p className="mt-1 text-[10px] text-white/45">Saved {step.provenance?.entityType || 'career'} evidence</p>{roleAttribution(loaded.snapshot, step.provenance?.roleId) && <p className="mt-1 text-[10px] text-white/55">Role: {roleAttribution(loaded.snapshot, step.provenance.roleId)}</p>}</li>)}</ol><div className="flex justify-between gap-2"><button type="button" className="nodrag rounded-md border border-white/10 px-2 py-1 text-xs disabled:opacity-35" onClick={() => moveStep(-1)} disabled={data.locked || currentStep === 0} aria-label="Previous interview thought"><ChevronLeft size={14} className="inline" /> Previous</button><button type="button" className="nodrag rounded-md border border-white/10 px-2 py-1 text-xs disabled:opacity-35" onClick={() => moveStep(1)} disabled={data.locked || currentStep >= lockedPlan.steps.length - 1} aria-label="Next interview thought">Next <ChevronRight size={14} className="inline" /></button></div>{prepBrief && <button type="button" className="nodrag w-full rounded-md bg-emerald-500/20 px-2 py-1.5 text-xs disabled:opacity-50" onClick={launch} disabled={bundleLoadStatus !== 'ready' || !window.electronAPI?.launchInterviewWindow}><Rocket size={13} className="mr-1 inline" />Launch interview view</button>}<button type="button" className="nodrag w-full rounded-md bg-violet-500/20 px-2 py-1.5 text-xs" onClick={() => { setQuestion(''); persist({ interviewHelperLockedPlan: null, interviewHelperCurrentStep: 0 }); }} disabled={data.locked}><RefreshCcw size={13} className="mr-1 inline" />Next question</button></section> : loaded.status === 'ready' && <section className="break-inside-avoid space-y-2 border-t border-white/10 pt-3" aria-label="Ask Interview Helper"><label className="block text-[11px] text-white/60" htmlFor={`interview-question-${id}`}>Optional interviewer question</label><textarea id={`interview-question-${id}`} aria-label="Paste or type the interviewer question" className="nodrag min-h-20 w-full rounded-md border border-white/10 bg-black/30 p-2 text-xs" value={question} onChange={event => { setQuestion(event.target.value); setUnsupportedPlan(null); }} placeholder="Paste or type the question you were asked…" disabled={data.locked} maxLength={INTERVIEW_QUESTION_MAX_LENGTH} /><button type="button" className="nodrag w-full rounded-md bg-violet-500/20 px-2 py-1.5 text-xs disabled:opacity-50" onClick={askQuestion} disabled={data.locked || !question.trim() || question.trim().length > INTERVIEW_QUESTION_MAX_LENGTH}>Find grounded evidence</button>{unsupportedPlan?.status === 'unsupported' && <p role="status" className="text-xs text-amber-100">{unsupportedPlan.message}</p>}</section>}
    </div>
    {showCanvasChooser && <CareerCanvasFileImportDialog files={canvasFiles} selectedSelections={canvasSelections} onToggle={file => { setCanvasChooserError(null); setCanvasSelections(current => toggleCareerCanvasFileSelection(current, file)); }} onClose={() => setShowCanvasChooser(false)} onImport={() => { const selected = selectedCareerCanvasFiles(canvasFiles, canvasSelections); if (!selected.length) { setCanvasChooserError('Your selected canvas files are no longer available. Select an available file to continue.'); return; } setCanvasChooserError(null); setShowCanvasChooser(false); void compileCareerFiles(selected); }} title="Choose career files from this canvas" description="Choose the career documents to compile into this helper’s independent snapshot." importLabel="Compile selected files" errorMessage={canvasChooserError} />}
  </div>;
});
