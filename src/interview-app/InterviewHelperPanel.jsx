import { claudeInterviewPauseKey } from '../utils/claudePauseFlow';
import { usePublishJobRunStatus } from '../hooks/usePublishJobRunStatus';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, Rocket } from 'lucide-react';

import { InterviewApplicationPicker } from '../components/InterviewApplicationPicker';
import { InterviewQaPanel } from '../components/InterviewQaPanel';
import { InterviewPracticePanel } from '../components/InterviewPracticePanel';
import { filesToDropPayloads } from '../utils/fileDropUtils';
import { CareerConversionList } from './CareerConversionList';
import { isPassThroughCareerName, planCareerConversionResults } from './careerConversionText';
import { approveCareerImportCompilation, beginCareerImportCompilation, failCareerImportCompilation } from '../utils/jobCareerCompilationReceipt';
import { generateId } from '../utils/idGenerator';
import { RUN_ID_RE } from './sessions';
import { canonicalInterviewJobUrl, interviewLaunchErrorMessage, interviewPreparationInputDigest, validInterviewPreparationBrief } from '../utils/interviewHelper';

const SHA_256_HEX_RE = /^[a-f0-9]{64}$/u;
const snapshotId = value => typeof value === 'string' && SHA_256_HEX_RE.test(value) ? value : null;
// File names and labels are retained in the saved interview. Do not
// silently remove invisible characters: doing so can make the displayed value
// differ from the file/value that the user selected.
const hasUnsafeDisplayCharacters = value => /[\p{Cc}\p{Cf}]/u.test(value);
const boundedText = (value, limit = 512) => typeof value === 'string'
  && !hasUnsafeDisplayCharacters(value) && value.trim() && value.trim().length <= limit ? value.trim() : null;
const safeFilename = value => boundedText(value, 180);
const sameSafeFilenames = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);

const TYPED_JOB_MAX = 2000;
const TYPED_KINDS = ['link', 'found', 'generated'];
const typedJobKind = value => TYPED_KINDS.includes(value) ? value : null;
const typedJobNotes = value => (Array.isArray(value) ? value : []).map(note => boundedText(note, 400)).filter(Boolean).slice(0, 6);
const clearTypedJobResult = () => ({ interviewHelperTypedJobKind: null, interviewHelperTypedJobNotes: null });
const clearPreparationState = () => ({ interviewHelperPreparation: null, interviewHelperPreparationRecordId: null, interviewHelperPreparationInputBinding: null, interviewHelperPreparationInputDigest: null, interviewHelperPreparationRunId: null });
const clearDependentState = () => ({ ...clearPreparationState(), interviewHelperLockedPlan: null, interviewHelperCurrentStep: 0 });
const clearCareerImportState = () => ({ interviewHelperCareerGeneration: null, interviewHelperCareerCompilation: null, interviewHelperCareerSnapshotId: null, interviewHelperCareerFingerprint: null, interviewHelperCareerFilenames: [] });
function projectBundle(reply) {
  const value = reply?.bundle || reply?.artifact || reply;
  const artifactId = boundedText(value?.artifactId, 256);
  const label = safeFilename(value?.label || value?.displayName || value?.filename || value?.name);
  const candidateDigest = value?.digest || value?.applicationArtifactDigest;
  const digest = typeof candidateDigest === 'string' && SHA_256_HEX_RE.test(candidateDigest) ? candidateDigest : null;
  const integritySummary = boundedText(value?.integritySummary || value?.integrity || value?.verification?.status, 500);
  return artifactId && SHA_256_HEX_RE.test(artifactId) && label && digest ? { artifactId, label, digest, ...(integritySummary ? { integritySummary } : {}) } : null;
}
const MAX_MANUAL_AI_RETIREMENT_RECEIPTS = 32;
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

/**
 * One interview's setup, preparation, Q&A and practice. `data` holds the
 * `interviewHelper*` fields and `onPatch` merges a change into them; the
 * standalone app saves every patch to disk.
 */
export const InterviewHelperPanel = React.memo(function InterviewHelperPanel({ id, data, onPatch, appliedJobsFolder = null, onChooseAppliedJobsFolder = null }) {
  // True while files are dragged over the drop area.
  const [dropActive, setDropActive] = useState(false);
  // A partial-success note from the last Prepare (e.g. the fact-check was skipped).
  const [prepareNotice, setPrepareNotice] = useState(null);
  const [loaded, setLoaded] = useState({ key: null, status: 'idle', snapshot: null });
  const [careerInputError, setCareerInputError] = useState(null);
  const [careerRecoveryDiscard, setCareerRecoveryDiscard] = useState(null);
  const [careerConverting, setCareerConverting] = useState(false);
  const [careerConversion, setCareerConversion] = useState(null);
  const careerConvertingRef = useRef(false);
  const [bundleLoadStatus, setBundleLoadStatus] = useState('idle');
  const [bundlePickerError, setBundlePickerError] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const [typedText, setTypedText] = useState(() => (typeof data.interviewHelperTypedJob === 'string' ? data.interviewHelperTypedJob.slice(0, TYPED_JOB_MAX) : ''));
  const [typedBusy, setTypedBusy] = useState(false);
  const [typedError, setTypedError] = useState(null);
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
  const persist = useCallback(patch => !data.locked && onPatch(patch), [data.locked, onPatch]);
  const persistedBundle = useMemo(() => projectBundle(data.interviewHelperApplicationBundle), [data.interviewHelperApplicationBundle]);
  const displayedCareerFilenames = useMemo(() => (Array.isArray(data.interviewHelperCareerFilenames) ? data.interviewHelperCareerFilenames : [])
    .map(filename => safeFilename(filename)).filter(Boolean), [data.interviewHelperCareerFilenames]);
  const importReceipt = data.interviewHelperCareerCompilation;
  const cleanupMarker = manualAiCleanupMarker(data.interviewHelperManualAiCleanup);
  const retirementReceipts = manualAiRetirementReceipts(data.interviewHelperManualAiRetirementReceipts);
  const retirementRunIds = retirementReceipts.map(receipt => receipt.runId);
  const importSnapshotId = snapshotId(data.interviewHelperCareerSnapshotId);
  const importReady = data.interviewHelperCareerMode === 'import' && importReceipt?.version === 1 && importReceipt.status === 'approved' && importReceipt.careerSnapshotId === importSnapshotId && importReceipt.generation === data.interviewHelperCareerGeneration;
  const careerKind = importReady ? 'import' : null;
  const activeSnapshotId = careerKind === 'import' ? importSnapshotId : null;
  const sourceKey = activeSnapshotId ? `${careerKind}:${activeSnapshotId}` : null;
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
    const sequence = ++loadSequenceRef.current;
    if (!activeSnapshotId || !window.electronAPI?.loadInterviewHelperCareerSnapshot) { setLoaded({ key: sourceKey, status: activeSnapshotId ? 'error' : 'idle', snapshot: null }); return undefined; }
    let disposed = false;
    setLoaded({ key: sourceKey, status: 'loading', snapshot: null });
    void window.electronAPI.loadInterviewHelperCareerSnapshot({ snapshotId: activeSnapshotId, nodeId: id }).then(reply => {
      const snapshot = reply?.snapshot;
      if (!disposed && sequence === loadSequenceRef.current) setLoaded(snapshot?.snapshotId === activeSnapshotId && snapshot.profile ? { key: sourceKey, status: 'ready', snapshot } : { key: sourceKey, status: 'error', snapshot: null });
    }).catch(() => { if (!disposed && sequence === loadSequenceRef.current) setLoaded({ key: sourceKey, status: 'error', snapshot: null }); });
    return () => { disposed = true; };
  }, [activeSnapshotId, id, sourceKey]);
  const candidatePrepBrief = preparationFor({ ...data, interviewHelperApplicationBundle: persistedBundle }, activeSnapshotId);
  const candidatePreparationRecordId = typeof data.interviewHelperPreparationRecordId === 'string' && SHA_256_HEX_RE.test(data.interviewHelperPreparationRecordId)
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
    if (data.interviewHelperPreparation && !recovery && !candidatePrepBrief && activeSnapshotId) {
      persist(clearPreparationState());
    }
  }, [activeSnapshotId, candidatePrepBrief, data.interviewHelperPreparation, persist]);
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
        !cancellationSettled,
      );
      if (merged.length > 0) persist({ interviewHelperManualAiRetirementReceipts: merged });
    } finally {
      setManualAiRetirementCleanupBusy(false);
    }
  }, [cleanupMarker, data.interviewHelperPreparation, data.interviewHelperPreparationRunId, data.locked, id, importReceipt, manualAiRetirementCleanupBusy, persist, retirementReceipts, retirementRunIds]);

  const clearImportedCareerSource = useCallback(async () => {
    if (data.locked || data.interviewHelperCareerMode !== 'import') return;
    if (recoverableCareerRunId && !await retireRecoverableManualAiRun('career', recoverableCareerRunId)) return;
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return;
    invalidateCareer(); invalidatePreparation();
    persist({ interviewHelperCareerMode: 'none', interviewHelperSourceNodeId: null, interviewHelperSourceSnapshotId: null, ...clearCareerImportState(), ...clearDependentState() });
  }, [data.interviewHelperCareerMode, data.locked, invalidateCareer, invalidatePreparation, persist, recoverableCareerRunId, recoverablePreparationRunId, retireRecoverableManualAiRun]);
  // Shared by the folder picker and the typed job: validate the reply, then
  // adopt it exactly the same way. Returns false when a newer operation won.
  const adoptBundleReply = useCallback(async (reply, token, extraPatch = null) => {
    const bundle = projectBundle(reply);
    if (!bundle) throw new Error('The selected application bundle could not be verified.');
    // The chosen bundle is the only source of the job URL: its official
    // posting URL always replaces whatever was saved before (or clears it).
    const returnedUrl = canonicalInterviewJobUrl(reply?.jobUrl);
    const urlUnchanged = canonicalInterviewJobUrl(data.interviewHelperJobUrl) === returnedUrl;
    const current = persistedBundleRef.current;
    // Re-picking the same content-addressed bundle with the same URL must not
    // discard a finished brief.
    if (current?.artifactId === bundle.artifactId && current?.digest === bundle.digest && urlUnchanged && bundleLoadStatusRef.current === 'ready') {
      if (current.label !== bundle.label || current.integritySummary !== bundle.integritySummary || extraPatch) persist({ ...(current.label !== bundle.label || current.integritySummary !== bundle.integritySummary ? { interviewHelperApplicationBundle: bundle } : {}), ...(extraPatch || {}) });
      return true;
    }
    const recoveryRunId = recoverablePreparationRunIdRef.current;
    if (recoveryRunId && !await retireRecoverableManualAiRun('preparation', recoveryRunId)) return false;
    if (token !== bundleOperationRef.current) return false;
    invalidatePreparation();
    persist({ interviewHelperApplicationBundle: bundle, interviewHelperJobUrl: returnedUrl, ...clearPreparationState(), ...(extraPatch || clearTypedJobResult()) });
    return true;
  }, [data.interviewHelperJobUrl, invalidatePreparation, persist, retireRecoverableManualAiRun]);
  const chooseBundle = useCallback(async (folderToken) => {
    if (data.locked || typedBusy || typeof folderToken !== 'string' || !window.electronAPI?.selectInterviewApplicationFolder) return false;
    const token = ++bundleOperationRef.current;
    setBundlePickerError(null);
    try {
      const reply = await window.electronAPI.selectInterviewApplicationFolder({ nodeId: id, token: folderToken });
      if (token !== bundleOperationRef.current || reply?.cancelled) return false;
      if (reply?.success === false) throw new Error(reply.error || 'The selected application could not be read. Try again.');
      return await adoptBundleReply(reply, token);
    } catch (failure) {
      if (token === bundleOperationRef.current) setBundlePickerError(failure?.message || 'The selected application could not be read. Try again.');
      return false;
    }
  }, [adoptBundleReply, data.locked, id, typedBusy]);
  const useTypedJob = useCallback(async () => {
    const text = typedText.trim();
    if (data.locked || typedBusy || !text || text.length > TYPED_JOB_MAX || typeof window.interviewAppAPI?.resolveInterviewTypedJob !== 'function') return false;
    const token = ++bundleOperationRef.current;
    setTypedBusy(true); setTypedError(null); setBundlePickerError(null);
    try {
      const reply = await window.interviewAppAPI.resolveInterviewTypedJob({ nodeId: id, text });
      if (token !== bundleOperationRef.current) return false;
      if (reply?.success === false || reply?.cancelled) throw new Error(reply?.error || reply?.userMessage || 'The job could not be found. Try again.');
      const kind = typedJobKind(reply?.kind);
      if (!kind) throw new Error('The job could not be verified. Try again.');
      return await adoptBundleReply(reply, token, { interviewHelperTypedJob: text, interviewHelperTypedJobKind: kind, interviewHelperTypedJobNotes: typedJobNotes(reply.notes) });
    } catch (failure) {
      if (token === bundleOperationRef.current) setTypedError(boundedText(failure?.userMessage, 500) || boundedText(failure?.message, 500) || 'The job could not be found. Try again.');
      return false;
    } finally {
      if (token === bundleOperationRef.current) setTypedBusy(false);
    }
  }, [adoptBundleReply, data.locked, id, typedBusy, typedText]);
  // Reached through the dropdown's "None" option; nothing on disk is touched.
  const clearBundle = useCallback(async () => {
    if (data.locked || !data.interviewHelperApplicationBundle) return false;
    // Fence an open picker so it cannot restore the cleared bundle afterwards.
    bundleOperationRef.current += 1;
    // A typed-job resolve still in flight is now stale and its finally will not clear the busy state.
    setTypedBusy(false);
    setBundlePickerError(null);
    if (recoverablePreparationRunId && !await retireRecoverableManualAiRun('preparation', recoverablePreparationRunId)) return false;
    invalidatePreparation();
    persist({ interviewHelperApplicationBundle: null, interviewHelperJobUrl: null, ...clearPreparationState(), ...clearTypedJobResult() });
    return true;
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
  // Any file type may be dropped: each is converted to plain text first, then
  // the converted (or pass-through .txt/.md) files go through the unchanged compile.
  const startCareerFiles = useCallback(async files => {
    const dropped = (Array.isArray(files) ? files : []).map(file => file?.filePath || file?.path).filter(path => typeof path === 'string' && path.trim() && !/\.app[\\/]*$/iu.test(path));
    if (!dropped.length || data.locked || manualAiStartBlocked || manualAiOperationRef.current || localCareerRunRef.current || careerConvertingRef.current) return;
    const convert = window.interviewAppAPI?.convertCareerFiles;
    if (typeof convert !== 'function' || dropped.every(path => isPassThroughCareerName(path))) { setCareerConversion(null); await compileCareerFiles(files); return; }
    if (dropped.some(path => !safeFilename(path.split(/[\\/]/u).pop()))) { await compileCareerFiles(files); return; }
    careerConvertingRef.current = true; setCareerConverting(true); setCareerInputError(null);
    let reply = null; let failure = null;
    try { reply = await convert.call(window.interviewAppAPI, { nodeId: id, filePaths: dropped }); } catch { failure = 'The files could not be converted to text. Try again.'; }
    careerConvertingRef.current = false; setCareerConverting(false);
    const plan = failure ? null : planCareerConversionResults(dropped, reply);
    if (!plan) { setCareerConversion(null); setCareerInputError(failure || 'The files could not be converted to text. Try again.'); return; }
    setCareerConversion(plan.rows);
    if (!plan.good.length) { setCareerInputError('None of the dropped files could be converted to text, so nothing was imported.'); return; }
    if (plan.refused) setCareerInputError(`${plan.refused} of ${dropped.length} files could not be converted and were left out. Continuing with the ${plan.good.length} that were.`);
    await compileCareerFiles(plan.good.map(item => ({ filePath: item.filePath })));
  }, [compileCareerFiles, data.locked, id, manualAiStartBlocked]);
  const openConvertedText = useCallback(async token => {
    if (typeof window.interviewAppAPI?.revealConvertedCareerFile !== 'function') { setCareerInputError('The converted text could not be opened.'); return; }
    try { await window.interviewAppAPI?.revealConvertedCareerFile?.({ token }); } catch { setCareerInputError('The converted text could not be opened.'); }
  }, []);
  const nativeDragOver = useCallback(event => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(true);
  }, []);
  const nativeDrop = useCallback(event => {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const files = filesToDropPayloads(event.dataTransfer?.files).map(file => ({ filePath: file.path, filename: file.name }));
    void startCareerFiles(files);
  }, [startCareerFiles]);
  // Files can be dropped on the area above or picked in the native chooser.
  const chooseCareerFiles = useCallback(async () => {
    if (data.locked || typeof window.interviewAppAPI?.chooseCareerFiles !== 'function') return;
    let paths = [];
    try { paths = await window.interviewAppAPI.chooseCareerFiles(); } catch { setCareerInputError('The file chooser could not be opened. Drop the files here instead.'); return; }
    const files = (Array.isArray(paths) ? paths : []).filter(filePath => typeof filePath === 'string' && filePath.trim()).map(filePath => ({ filePath }));
    if (files.length) void startCareerFiles(files);
  }, [startCareerFiles, data.locked]);
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
      const briefRecordId = typeof reply?.briefRecordId === 'string' && SHA_256_HEX_RE.test(reply.briefRecordId) ? reply.briefRecordId : null;
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
    try { await window.electronAPI.launchInterviewWindow({ nodeId: id, snapshotId: activeSnapshotId, jobUrl, briefRecordId: verifiedPreparation.recordId, brief: prepBrief, plan: null, currentStep: 0 }); }
    catch (error) { setLaunchError(interviewLaunchErrorMessage(error)); }
  }, [activeSnapshotId, bundleLoadStatus, data.interviewHelperJobUrl, id, prepBrief, verifiedPreparation.recordId]);
  const canPrepare = !data.locked && !manualAiStartBlocked && loaded.status === 'ready' && bundleLoadStatus === 'ready' && preparationVerificationStatus !== 'loading' && !!canonicalInterviewJobUrl(data.interviewHelperJobUrl) && !!persistedBundle?.artifactId && !!persistedBundle?.digest;
  const preparationStatus = data.interviewHelperPreparation?.status;
  const preparationError = safePreparationRecoveryError();
  const locallyPreparing = preparationStatus === 'preparing' && localPreparationRunRef.current === data.interviewHelperPreparationRunId;
  // The side panel owns this run's live activity and Pause button; the node only
  // shows that it is preparing. No save step: Resume follows the hold.
  usePublishJobRunStatus(id, locallyPreparing ? { label: 'Interview Helper', headline: 'Preparing interview brief', claudeRequestId: claudeInterviewPauseKey(data.interviewHelperPreparationRunId), pauseKeys: [claudeInterviewPauseKey(data.interviewHelperPreparationRunId)], pauseWithoutSave: true } : null);
  usePublishJobRunStatus(`${id}:convert`, careerConverting ? { label: 'Interview Helper', headline: 'Converting career files', lines: ['Converting each file to text.'] } : null);
  usePublishJobRunStatus(`${id}:typed`, typedBusy ? { label: 'Interview Helper', headline: 'Finding the job', lines: ['Reading the link, or researching the company and role.'] } : null);
  const typedKind = persistedBundle ? typedJobKind(data.interviewHelperTypedJobKind) : null;
  const shownTypedNotes = typedKind ? typedJobNotes(data.interviewHelperTypedJobNotes) : [];
  return <div className="relative text-white" data-testid="interview-helper-panel">
    {/* Balanced columns: the setup sections and the long practice feedback
        share the width instead of stacking into one very tall strip. */}
    <div className="p-4 [column-fill:balance] [&>*]:mb-3" style={{ columnWidth: 348, columnGap: 20 }}>
      {retirementRunIds.length > 0 && <p role="alert" className="break-inside-avoid rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-xs text-amber-100">A restored deletion cleanup is still pending. Retry it before starting another worker task. <button type="button" className="ml-1 underline disabled:opacity-50" onClick={retryManualAiRetirementCleanup} disabled={data.locked || manualAiRetirementCleanupBusy}>{manualAiRetirementCleanupBusy ? 'Retrying…' : 'Retry restored cleanup'}</button></p>}
      {cleanupMarker && <p role="alert" className="break-inside-avoid rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-xs text-amber-100">A completed {cleanupMarker.kind === 'career' ? 'career compilation' : 'interview preparation'} worker could not be retired. {cleanupRunStillActive ? 'Wait for that worker to reach a terminal state.' : 'Retry cleanup before starting another worker task.'} {!cleanupRunStillActive && <button type="button" className="ml-1 underline disabled:opacity-50" onClick={retryManualAiCleanup} disabled={data.locked || manualAiCleanupBusy}>{manualAiCleanupBusy ? 'Retrying…' : 'Retry manual-AI cleanup'}</button>}</p>}
      <section className="break-inside-avoid space-y-2" aria-label="1. Career data"><p className="text-[11px] font-medium text-violet-200">1. Career data</p><div className={`rounded-lg border-2 border-dashed p-4 text-sm ${dropActive ? 'border-emerald-300/80 bg-emerald-500/15 text-emerald-50' : 'border-violet-400/60 bg-violet-500/10 text-violet-100'}`} onDragOver={nativeDragOver} onDragLeave={() => setDropActive(false)} onDrop={nativeDrop}><p className="font-semibold">Drop career files here</p>{dropActive && <p role="status" className="mt-1 text-xs font-semibold">Drop to compile these career files</p>}<p className="mt-1 text-xs text-white/60">Any file type works: each file is converted to text first. Use your original career data, not application documents.</p><button type="button" className="mt-2 rounded-md border border-violet-300/40 px-2 py-1 text-xs hover:bg-violet-400/10 disabled:opacity-40" onClick={chooseCareerFiles} disabled={data.locked || manualAiStartBlocked || careerConverting}>Choose files…</button></div>{careerConverting && <p role="status" className="text-xs text-amber-100">Converting files to text…</p>}<CareerConversionList rows={careerConversion} onOpen={openConvertedText} />{data.interviewHelperCareerMode === 'import' && <button type="button" className="text-xs text-violet-200 underline disabled:opacity-50" onClick={clearImportedCareerSource} disabled={data.locked} aria-label="Clear imported career source">Clear imported career source</button>}{careerInputError && <p role="alert" className="text-xs text-amber-100">{careerInputError}</p>}{careerRecoveryDiscard && <button type="button" className="text-xs text-violet-200 underline" onClick={discardCareerRecovery} disabled={data.locked || manualAiBusy}>Discard previous career recovery</button>}{importReceipt?.status === 'compiling' && <p role="status" className="text-xs text-amber-100">{localCareerRunRef.current === importReceipt.manualAiRunId ? 'Compiling career files…' : 'Career compilation was interrupted. Reselect the same career files to resume safely.'}</p>}{importReceipt?.status === 'failed' && <p role="alert" className="text-xs text-red-200">{safeReceiptError()} <button type="button" className="underline" onClick={chooseCareerFiles} disabled={data.locked || manualAiStartBlocked}>Retry</button></p>}{importReady && <p className="text-xs text-emerald-200">Independent career snapshot ready{displayedCareerFilenames.length ? ` · ${displayedCareerFilenames.join(', ')}` : ''}</p>}</section>
      {activeSnapshotId && loaded.status === 'loading' && <p role="status" className="text-xs text-white/50">Loading the pinned career snapshot…</p>}{activeSnapshotId && loaded.status === 'error' && <p role="alert" className="text-xs text-red-200">The selected career snapshot is unavailable. Choose or compile another source.</p>}
      <section className="break-inside-avoid space-y-2 border-t border-white/10 pt-3" aria-label="2. Application">
        <p className="text-[11px] font-medium text-violet-200">2. Application</p>
        <p className="text-[11px] text-white/60">{appliedJobsFolder ? <>Folder: <span className="break-all text-white/80">{appliedJobsFolder}</span></> : 'Choose the Applied Jobs folder that holds your generated applications.'}{onChooseAppliedJobsFolder && <button type="button" className="ml-1 text-violet-200 underline disabled:opacity-50" onClick={onChooseAppliedJobsFolder} disabled={data.locked}>{appliedJobsFolder ? 'Change' : 'Choose folder…'}</button>}</p>
        <InterviewApplicationPicker key={appliedJobsFolder || 'no-folder'} nodeId={id} selectedLabel={persistedBundle?.label} disabled={data.locked} hasSelection={Boolean(data.interviewHelperApplicationBundle)} onSelect={chooseBundle} onClear={clearBundle} />
        <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-white/45">Or type a job link, or a company and role</span>
          <textarea className="nodrag w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[11px] text-white placeholder:text-white/30 disabled:opacity-50" rows={3} maxLength={TYPED_JOB_MAX} value={typedText} disabled={data.locked || typedBusy} placeholder="https://… or: Product Manager at Acme, Toronto" aria-label="Job link, or company and role"
            onChange={event => { const next = event.target.value.slice(0, TYPED_JOB_MAX); setTypedText(next); setTypedError(null); persist({ interviewHelperTypedJob: next }); }} /></label>
        <button type="button" className="rounded-md bg-violet-500/20 px-2 py-1 text-xs text-violet-100 disabled:opacity-50" onClick={useTypedJob} disabled={data.locked || typedBusy || !typedText.trim() || !window.interviewAppAPI?.resolveInterviewTypedJob}>{typedBusy ? 'Finding the job…' : 'Use this job'}</button>
        {typedBusy && <p role="status" className="text-[11px] text-white/60">Reading the link, or researching the company and role. This can take a minute.</p>}
        {typedError && <p role="alert" className="text-[11px] text-amber-100">{typedError}</p>}
        {typedKind === 'generated' && <p role="status" data-testid="typed-job-generated" className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">Generated listing: no open posting was found, so this job description was written by AI as a realistic stand-in. It is not the employer's text.</p>}
        {typedKind === 'found' && <p role="status" className="text-[11px] text-emerald-200">Found a live posting for this role.</p>}
        {typedKind === 'link' && <p role="status" className="text-[11px] text-emerald-200">Read from the posting link.</p>}
        {shownTypedNotes.map((note, index) => <p key={index} role="status" className="text-[11px] text-white/60">{note}</p>)}
        {data.interviewHelperApplicationBundle && <><p className="text-[11px] text-white/60">{persistedBundle?.label || 'Selected application bundle'}{persistedBundle?.integritySummary ? ` · ${persistedBundle.integritySummary}` : ''}{bundleLoadStatus === 'loading' ? ' · checking…' : ''}</p></>}
        {bundlePickerError && <p role="alert" className="text-[11px] text-red-200">{bundlePickerError}</p>}{bundleLoadStatus === 'error' && <p role="alert" className="text-[11px] text-red-200">The selected application bundle is unavailable, changed, or cannot be checked in this app version. Replace it to prepare.</p>}
        {persistedBundle && !canonicalInterviewJobUrl(data.interviewHelperJobUrl) && <p role="status" className="text-[11px] text-amber-100">This application has no job posting link, so preparation cannot research it. Regenerate the application, then choose it again.</p>}
      </section>
      <section className="break-inside-avoid space-y-2 border-t border-white/10 pt-3" aria-label="4. Interview preparation"><p className="text-[11px] font-medium text-violet-200">4. Interview preparation</p><p className="text-[11px] text-white/60">Prepare researches the job, checks the brief, then prepares spoken answers from your approved evidence. Finish preparation before the interview.</p>{candidatePrepBrief && !prepBrief && preparationVerificationStatus === 'loading' && <p role="status" className="text-[11px] text-white/55">Checking saved brief…</p>}{candidatePrepBrief && !prepBrief && preparationVerificationStatus === 'error' && <p role="alert" className="text-[11px] text-amber-100">Saved brief could not be verified; prepare again.</p>}<button type="button" className="w-full rounded-md bg-violet-500/20 px-2 py-1.5 text-xs text-violet-100 disabled:opacity-50" onClick={prepare} disabled={!canPrepare || locallyPreparing}>{locallyPreparing ? 'Preparing…' : preparationStatus === 'preparing' || (preparationStatus === 'failed' && data.interviewHelperPreparationRunId) ? 'Resume preparation' : prepBrief ? 'Prepare again' : 'Prepare interview brief'}</button><p className="text-[11px] text-white/60">Fills empty answers; existing answers are kept.</p>{preparationStatus === 'failed' && <p role="alert" className="text-[11px] text-red-200">{preparationError}</p>}{prepareNotice && preparationStatus !== 'failed' && <p role="status" className="text-[11px] text-amber-100">{prepareNotice}</p>}</section>
      <InterviewQaPanel nodeId={id} snapshotId={activeSnapshotId} refreshKey={`${preparationStatus}:${data.interviewHelperPreparationRecordId || ''}:${locallyPreparing}`} disabled={data.locked || manualAiBusy || locallyPreparing} />
      {prepBrief && <section className="break-inside-avoid space-y-2 rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-2" aria-label="Interview preparation ready"><p className="text-xs font-medium text-emerald-100"><BriefcaseBusiness size={13} className="mr-1 inline" />{answerCardCount ? `${answerCardCount} prepared answers ready` : 'Research ready'}{prepBrief.role?.title ? ` · ${prepBrief.role.title}${prepBrief.role.company ? ` at ${prepBrief.role.company}` : ''}` : ''}</p><p className="text-[11px] text-white/70">{answerCardCount ? 'The cue card listens to the call and shows short cues when it recognises a prepared question. It stays blank for anything else. Closing it stops listening.' : 'Research is prepared, but there are no prepared answers, so the cue card would stay blank. Prepare again to add answer cards.'}</p><p className="text-[11px] text-amber-100">Confirm this career source matches the application you submitted. This bundle is a captured copy; replace it after editing the documents.</p>{[['Researched themes', prepBrief.roleThemes], ['Likely questions', prepBrief.likelyQuestions], ['Submitted wording — reference, not career evidence', prepBrief.applicationPositioning], ['Source warnings', prepBrief.warnings]].map(([label, items]) => <div key={label}><p className="text-[10px] font-semibold uppercase text-white/45">{label}</p><p className="text-[11px] text-white/70">{items.slice(0, 3).map(briefItemText).filter(Boolean).join(' · ') || 'None'}</p></div>)}<button type="button" className="w-full rounded-md bg-emerald-500/20 px-2 py-1.5 text-xs text-emerald-50 disabled:opacity-50" onClick={launch} disabled={bundleLoadStatus !== 'ready' || !window.electronAPI?.launchInterviewWindow}><Rocket size={13} className="mr-1 inline" />Open cue card</button>{launchError && <p role="alert" className="text-[11px] text-red-200">{launchError}</p>}</section>}
      <InterviewPracticePanel nodeId={id} briefRecordId={verifiedPreparation.recordId || null} snapshotId={activeSnapshotId || null} canonicalJobUrl={canonicalInterviewJobUrl(data.interviewHelperJobUrl) || null} bundleArtifactId={persistedBundle?.artifactId || null} bundleArtifactDigest={persistedBundle?.digest || null} ready={!!prepBrief && !!verifiedPreparation.recordId && bundleLoadStatus === 'ready' && !!activeSnapshotId && !!canonicalInterviewJobUrl(data.interviewHelperJobUrl)} disabled={data.locked || manualAiBusy || locallyPreparing} steering={typeof data.practiceSteering === 'string' ? data.practiceSteering : ''} onSteeringChange={text => persist({ practiceSteering: text })} />
    </div>
  </div>;
});
