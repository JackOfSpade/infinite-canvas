/**
 * Compact, crash-durable intents for job work that starts after the primary
 * search manifest has reached its renderer-owned continuation:
 *
 *   - a late/background USAJobs append; and
 *   - a source-card recovery / description-enrichment pass.
 *
 * Inputs remain fixed SHA-256 fingerprints, so a restarted renderer can claim
 * work only for the same canvas + hub + run + profile + location/window +
 * result generation that created it. Once a safe provider operation settles,
 * its bounded terminal response is checkpointed in this same atomic envelope.
 * That result is never returned by discovery/listing; an exact active execution
 * lease must read it for replay. This closes the provider-finished/renderer-
 * crashed gap without granting startup consent to a manual browser challenge.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import {
  jobRunPathScopeForCanvas,
  normalizeJobRunProfileFingerprint,
  sanitizeJobSearchWindow,
} from './jobRunStaging.js';
import { acquireCanvasRecoveryRead, resolveCanvasRecoveryPath } from './canvasRecoveryPaths.js';
import { getJobAnalysisPaths, getJobDescriptionRecoveryCheckpointPath } from './jobAnalysisPaths.js';
import {
  jobAnalysisOperationAuthorityReceipt,
  withCurrentJobAnalysisOperationAuthority,
} from './jobAnalysisOperationAuthorityStore.js';

const VERSION = 1;
const PROCESS_EPOCH = crypto.randomBytes(24).toString('hex');
// Continuations are durable correctness receipts, not a work budget. Keep the
// enclosing sidecar's 32 MiB file-safety envelope, but never discard a valid
// receipt merely because an active canvas has crossed an arbitrary count.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_RESULT_BYTES = 12 * 1024 * 1024;
// Parent snapshots legitimately retain a whole recovery candidate universe.
// This is intentionally independent of the much smaller intent sidecar cap.
const MAX_PARENT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const KINDS = new Set(['late-source-refresh', 'source-recovery']);
const OPERATIONS = new Set(['search-jobs-single-source', 'resolve-job-source', 'resume-job-source']);
const RECOVERY_MODES = new Set(['automatic', 'manual']);
const PARENT_ARTIFACT_SLOTS = new Set(['current']);
const locks = new Map();
// ownerKey (canonical canvas + intent) -> execution. Intent ids deliberately
// omit canvas spelling, so keying only by intentId made cloned canvases collide.
const activeExecutions = new Map();
const executionsByLeaseToken = new Map();
const automaticAttempts = new Set();
const senderExecutions = new WeakMap();
const hookedSenders = new WeakSet();

function releaseSenderExecutions(sender) {
  const leaseTokens = senderExecutions.get(sender);
  if (!leaseTokens) return;
  for (const leaseToken of leaseTokens) {
    const execution = executionsByLeaseToken.get(leaseToken);
    if (execution?.sender === sender) {
      activeExecutions.delete(execution.ownerKey);
      executionsByLeaseToken.delete(leaseToken);
      execution.recoveryLease?.release?.();
    }
  }
  senderExecutions.delete(sender);
}

function hookSender(sender) {
  if (!sender || hookedSenders.has(sender)) return;
  hookedSenders.add(sender);
  sender.once?.('destroyed', () => releaseSenderExecutions(sender));
}

function claimExecution(canvasFilePath, intentId, sender, recoveryLease = null, intent = null) {
  if (!sender) return { ok: false, reason: 'missing-sender' };
  const ownerKey = `${canvasFilePath}\u0000${intentId}`;
  if (activeExecutions.has(ownerKey)) return { ok: false, busy: true, reason: 'already-running' };
  const leaseToken = crypto.randomBytes(24).toString('hex');
  const execution = { ownerKey, canvasFilePath, intentId, leaseToken, sender, recoveryLease, intent };
  activeExecutions.set(ownerKey, execution);
  executionsByLeaseToken.set(leaseToken, execution);
  const owned = senderExecutions.get(sender) || new Set();
  owned.add(leaseToken);
  senderExecutions.set(sender, owned);
  hookSender(sender);
  return { ok: true, leaseToken };
}

export function releaseJobContinuationExecution(intentId, leaseToken, sender) {
  const current = executionsByLeaseToken.get(leaseToken);
  if (!current || current.leaseToken !== leaseToken || current.sender !== sender) return false;
  if (current.intentId !== intentId) return false;
  activeExecutions.delete(current.ownerKey);
  executionsByLeaseToken.delete(leaseToken);
  current.recoveryLease?.release?.();
  const owned = senderExecutions.get(sender);
  owned?.delete(leaseToken);
  if (owned?.size === 0) senderExecutions.delete(sender);
  return true;
}

export function validateJobContinuationExecution(intentId, leaseToken, sender, canvasFilePath = null) {
  const current = executionsByLeaseToken.get(leaseToken);
  return !!current
    && current.intentId === intentId
    && current.sender === sender
    && (!canvasFilePath || current.canvasFilePath === resolveCanvasRecoveryPath(canvasFilePath));
}

/**
 * Fast host-side admission for provider handlers.  It deliberately re-reads
 * the durable intent and parent artifact each time; a process-local lease is
 * only an anti-duplicate aid, never durable authority.
 */
export async function validateJobContinuationAuthority(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  leaseToken = null,
  operation = null,
  careerSnapshotId = null,
  operationAuthority = null,
  parentArtifactFingerprint = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  const op = OPERATIONS.has(operation) ? operation : null;
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  if (!ownerNodeId || !runToken || !token || !op || !execution?.intent) {
    return { ok: false, reason: 'missing-or-inactive-ownership' };
  }
  if (execution.intent.parentRunId !== runToken || execution.intent.operation !== op
    || execution.intent.careerSnapshotId !== careerSnapshotId
    || execution.intent.parentArtifactFingerprint !== parentArtifactFingerprint
    || !sameAuthorityReceipt(execution.intent.operationAuthority, operationAuthority)) {
    return { ok: false, reason: 'ownership-mismatch' };
  }
  const admitted = await withExactContinuationAuthority(canvasFilePath, {
    ...execution.intent, nodeId: ownerNodeId, parentRunId: runToken, intentId: token, leaseToken, operation: op,
  }, { sender, requireLease: true }, async () => ({ ok: true }));
  return admitted.admitted ? admitted.value : { ok: false, reason: admitted.reason || 'operation-superseded' };
}

function exactExecution(intentId, leaseToken, sender, canvasFilePath = null) {
  return validateJobContinuationExecution(intentId, leaseToken, sender, canvasFilePath)
    ? executionsByLeaseToken.get(leaseToken)
    : null;
}

function boundedToken(value, max = 200) {
  const token = typeof value === 'string' ? value.trim() : '';
  return token && token.length <= max ? token : null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sameAuthorityReceipt(left, right) {
  const a = jobAnalysisOperationAuthorityReceipt(left);
  const b = jobAnalysisOperationAuthorityReceipt(right);
  return !!a && !!b && a.operationId === b.operationId && a.revision === b.revision
    && stableJson(a.semanticBase) === stableJson(b.semanticBase);
}

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeTerminalResult(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.operation !== operation || !timestamp(value.completedAt)) return null;
  if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) return null;
  let serialized;
  try { serialized = JSON.stringify(value.result); } catch { return null; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TERMINAL_RESULT_BYTES) return null;
  const resultKey = boundedToken(value.resultKey, 64);
  if (!/^[a-f0-9]{64}$/.test(resultKey || '') || resultKey !== sha(serialized)) return null;
  return {
    operation,
    completedAt: value.completedAt,
    resultKey,
    result: value.result,
  };
}

function publicIntent(intent) {
  if (!intent) return intent;
  const { terminalResult, ...identity } = intent;
  return {
    ...identity,
    terminalResultAvailable: !!terminalResult,
    terminalResultAt: terminalResult?.completedAt || null,
    terminalResultKey: terminalResult?.resultKey || null,
    processEpoch: PROCESS_EPOCH,
  };
}

function inputFingerprints(args = {}) {
  const { searchWindow = null, canonicalLocation = '', generationFingerprint = '' } = args;
  const normalizedWindow = sanitizeJobSearchWindow(searchWindow);
  const location = typeof canonicalLocation === 'string'
    ? canonicalLocation.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    : '';
  const generation = boundedToken(generationFingerprint, 300) || '';
  const inputs = {
    searchWindowFingerprint: sha(stableJson(normalizedWindow)),
    locationFingerprint: sha(location),
    generationFingerprint: sha(generation),
  };
  if (Object.hasOwn(args, 'operationInput')) {
    inputs.operationInputFingerprint = sha(stableJson(args.operationInput));
  }
  return inputs;
}

function continuationPath(canvasFilePath, nodeId) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeId);
  if (!scope?.ownerHash) return null;
  return path.join(
    scope.dir,
    `${scope.base}.jobs-continuations.${scope.canvasHash}.${scope.ownerHash}.json`,
  );
}

function normalizeIdentity(args = {}) {
  const nodeId = boundedToken(args.nodeId, 300);
  const parentRunId = boundedToken(args.parentRunId, 300);
  const profileFingerprint = normalizeJobRunProfileFingerprint(args.profileFingerprint);
  const kind = KINDS.has(args.kind) ? args.kind : null;
  const operation = OPERATIONS.has(args.operation) ? args.operation : null;
  const sourceId = boundedToken(args.sourceId, 80);
  const careerSnapshotId = typeof args.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(args.careerSnapshotId)
    ? args.careerSnapshotId
    : null;
  const operationAuthority = jobAnalysisOperationAuthorityReceipt(args.operationAuthority);
  const parentArtifactFingerprint = typeof args.parentArtifactFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(args.parentArtifactFingerprint)
    ? args.parentArtifactFingerprint
    : null;
  if (!nodeId || !parentRunId || !profileFingerprint || !kind || !operation || !sourceId
    || !careerSnapshotId || !operationAuthority || !parentArtifactFingerprint) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(sourceId)) return null;
  const inputs = inputFingerprints(args);
  // Lifecycle calls made from a claimed execution carry the persisted hashes,
  // not the original raw search window/location/input object. Re-hashing the
  // absent raw fields would turn a valid exact lease into a different intent
  // between provider completion and its durability barrier. Accept those
  // stored values only as an identity representation; sameIdentity below still
  // binds them to the durable sidecar row.
  for (const key of ['searchWindowFingerprint', 'locationFingerprint', 'generationFingerprint']) {
    if (typeof args[key] === 'string' && /^[a-f0-9]{64}$/.test(args[key])) inputs[key] = args[key];
  }
  if (typeof args.operationInputFingerprint === 'string' && /^[a-f0-9]{64}$/.test(args.operationInputFingerprint)) {
    inputs.operationInputFingerprint = args.operationInputFingerprint;
  }
  return {
    nodeId, parentRunId, profileFingerprint, kind, operation, sourceId,
    careerSnapshotId, operationAuthority, parentArtifactFingerprint, ...inputs,
  };
}

function intentIdFor(identity) {
  return sha(stableJson(identity)).slice(0, 40);
}

function emptyStore(nodeId) {
  return { version: VERSION, nodeId, intents: [] };
}

function normalizeIntent(value, nodeId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = normalizeIdentity({
    ...value,
    // Persisted rows already contain hashes, not raw inputs. Preserve them
    // explicitly below instead of hashing those hashes a second time.
    searchWindow: null,
    canonicalLocation: '',
    generationFingerprint: '',
  });
  const searchWindowFingerprint = boundedToken(value.searchWindowFingerprint, 64);
  const locationFingerprint = boundedToken(value.locationFingerprint, 64);
  const generationFingerprint = boundedToken(value.generationFingerprint, 64);
  const operationInputFingerprint = value.operationInputFingerprint == null
    ? null
    : boundedToken(value.operationInputFingerprint, 64);
  const intentId = boundedToken(value.intentId, 64);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const recoveryMode = RECOVERY_MODES.has(value.recoveryMode) ? value.recoveryMode : null;
  const parentArtifactSlot = typeof value.parentArtifactSlot === 'string'
    && (PARENT_ARTIFACT_SLOTS.has(value.parentArtifactSlot) || /^checkpoint:[a-f0-9]{24}$/.test(value.parentArtifactSlot))
    ? value.parentArtifactSlot
    : null;
  const parentArtifactPublicationReceipt = jobAnalysisOperationAuthorityReceipt(value.parentArtifactPublicationReceipt);
  if (!identity || identity.nodeId !== nodeId || !intentId || !createdAt || !updatedAt || !recoveryMode
    || !parentArtifactSlot || !parentArtifactPublicationReceipt) return null;
  if (![searchWindowFingerprint, locationFingerprint, generationFingerprint].every(v => /^[a-f0-9]{64}$/.test(v || ''))) return null;
  if (value.operationInputFingerprint != null && !/^[a-f0-9]{64}$/.test(operationInputFingerprint || '')) return null;
  const normalizedIdentity = {
    nodeId: identity.nodeId,
    parentRunId: identity.parentRunId,
    profileFingerprint: identity.profileFingerprint,
    kind: identity.kind,
    operation: identity.operation,
    sourceId: identity.sourceId,
    careerSnapshotId: identity.careerSnapshotId,
    operationAuthority: identity.operationAuthority,
    parentArtifactFingerprint: identity.parentArtifactFingerprint,
    searchWindowFingerprint,
    locationFingerprint,
    generationFingerprint,
    ...(operationInputFingerprint ? { operationInputFingerprint } : {}),
  };
  if (intentIdFor(normalizedIdentity) !== intentId) return null;
  const terminalResult = normalizeTerminalResult(value.terminalResult, normalizedIdentity.operation);
  return {
    intentId,
    ...normalizedIdentity,
    recoveryMode,
    createdAt,
    updatedAt,
    parentArtifactSlot,
    parentArtifactPublicationReceipt,
    ...(terminalResult ? { terminalResult } : {}),
  };
}

async function readBoundedNoFollowRegularFile(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_PARENT_ARTIFACT_BYTES) return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    return after.isFile() && after.dev === before.dev && after.ino === before.ino
      && after.size === before.size && bytes.length === before.size ? bytes : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

function recordReceipt(record) {
  return jobAnalysisOperationAuthorityReceipt({
    operationId: record?.operationId, semanticBase: record?.semanticBase, revision: record?.revision,
  });
}

function sameContinuationWithoutAuthority(left, right) {
  return left?.nodeId === right?.nodeId && left?.parentRunId === right?.parentRunId
    && left?.profileFingerprint === right?.profileFingerprint && left?.kind === right?.kind
    && left?.operation === right?.operation && left?.sourceId === right?.sourceId
    && left?.careerSnapshotId === right?.careerSnapshotId
    && left?.parentArtifactFingerprint === right?.parentArtifactFingerprint
    && left?.searchWindowFingerprint === right?.searchWindowFingerprint
    && left?.locationFingerprint === right?.locationFingerprint
    && left?.generationFingerprint === right?.generationFingerprint
    && left?.operationInputFingerprint === right?.operationInputFingerprint;
}

async function validateStoredParentArtifact(canvasFilePath, record, intent) {
  const current = recordReceipt(record);
  const embedded = jobAnalysisOperationAuthorityReceipt(intent?.parentArtifactPublicationReceipt);
  const publication = intent?.parentArtifactSlot && (record?.publications?.[intent.parentArtifactSlot]
    || record?.pendingPublications?.[intent.parentArtifactSlot]);
  if (!current || !embedded || !publication || publication.digest !== intent.parentArtifactFingerprint
    || !sameAuthorityReceipt(publication.receipt, embedded)) return { ok: false, reason: 'parent-artifact-superseded' };
  const paths = getJobAnalysisPaths(canvasFilePath, null, intent.nodeId);
  const filePath = intent.parentArtifactSlot === 'current'
    ? paths?.jsonPath
    : getJobDescriptionRecoveryCheckpointPath(canvasFilePath, intent.parentRunId, null);
  if (!filePath) return { ok: false, reason: 'parent-artifact-unavailable' };
  const bytes = await readBoundedNoFollowRegularFile(filePath);
  if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== intent.parentArtifactFingerprint) {
    return { ok: false, reason: 'parent-artifact-superseded' };
  }
  try {
    const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const snapshotReceipt = jobAnalysisOperationAuthorityReceipt(snapshot?.operationAuthority ?? snapshot?.snapshotContext?.operationAuthority);
    if (snapshot?.nodeId !== intent.nodeId || snapshot?.sourceHubId !== intent.nodeId
      || snapshot?.runId !== intent.parentRunId || snapshot?.careerSnapshotId !== intent.careerSnapshotId
      || !sameAuthorityReceipt(snapshotReceipt, embedded)) return { ok: false, reason: 'parent-artifact-mismatch' };
  } catch { return { ok: false, reason: 'parent-artifact-invalid' }; }
  return { ok: true };
}

async function deriveParentArtifactUnderAuthority(canvasFilePath, record, identity) {
  const candidates = Object.entries({ ...(record?.publications || {}), ...(record?.pendingPublications || {}) })
    .filter(([slot]) => slot === 'current' || /^checkpoint:[a-f0-9]{24}$/.test(slot));
  for (const [slot, publication] of candidates) {
    const candidate = {
      ...identity,
      // The host reads the sealed bytes and determines this digest itself.
      // A renderer-provided digest is compared by begin() only after that
      // derivation; it is never the source of authority.
      parentArtifactFingerprint: publication.digest,
      parentArtifactSlot: slot,
      parentArtifactPublicationReceipt: publication.receipt,
    };
    const valid = await validateStoredParentArtifact(canvasFilePath, record, candidate);
    if (valid.ok) return { ok: true, slot, receipt: publication.receipt, digest: publication.digest };
  }
  return { ok: false, reason: 'parent-artifact-superseded' };
}

/* Authority lock is always acquired before the continuation mutex. */
async function withExactContinuationAuthority(canvasFilePath, args, { sender = null, requireLease = false } = {}, callback) {
  const desired = normalizeIdentity(args);
  const suppliedIntentId = boundedToken(args?.intentId, 64);
  if (!desired || !suppliedIntentId) return { admitted: false, reason: 'missing-ownership' };
  const authority = desired.operationAuthority;
  return withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: desired.nodeId, ...authority,
  }, async record => {
    const ownerCanvasFilePath = record.canvasFilePath;
    const filePath = continuationPath(ownerCanvasFilePath, desired.nodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
      const store = await readStore(filePath, desired.nodeId);
      let intent = store.intents.find(row => row.intentId === suppliedIntentId);
      if (!intent) return { ok: false, reason: 'intent-absent' };
      let rebound = false;
      if (!sameIdentity(intent, desired)) {
        // Startup S3 may rebind only its exact durable S2 predecessor. The
        // protected authority record—not renderer input—proves that one hop.
        if (!sameAuthorityReceipt(intent.operationAuthority, record.predecessor)
          || !sameContinuationWithoutAuthority(intent, desired)) {
          return { ok: false, reason: 'ownership-mismatch' };
        }
        const inherited = await validateStoredParentArtifact(ownerCanvasFilePath, record, intent);
        if (!inherited.ok) return { ok: false, reason: inherited.reason };
        const reboundIntent = {
          ...intent,
          intentId: intentIdFor(desired),
          ...desired,
          // Parent bytes remain S2-sealed; record that exact inherited tuple.
          parentArtifactSlot: intent.parentArtifactSlot,
          parentArtifactPublicationReceipt: intent.parentArtifactPublicationReceipt,
          updatedAt: Date.now(),
        };
        store.intents = store.intents.map(row => row.intentId === intent.intentId ? reboundIntent : row);
        await atomicWrite(filePath, store);
        intent = reboundIntent;
        rebound = true;
      }
      if (!sameAuthorityReceipt(intent.operationAuthority, recordReceipt(record))) {
        return { ok: false, reason: 'operation-superseded' };
      }
      const parent = await validateStoredParentArtifact(ownerCanvasFilePath, record, intent);
      if (!parent.ok) return { ok: false, reason: parent.reason };
      const execution = requireLease ? exactExecution(intent.intentId, args.leaseToken, sender, ownerCanvasFilePath) : null;
      if (requireLease && !execution) return { ok: false, reason: 'execution-released' };
      return callback({ filePath, ownerCanvasFilePath, store, intent, execution, rebound, record });
    });
  });
}

async function withStoredContinuationAuthority(canvasFilePath, { nodeId, parentRunId, intentId, careerSnapshotId, operationAuthority, parentArtifactFingerprint } = {}, callback, {
  // The only caller allowed to pass this is the host's exact Stop/terminal
  // transaction. It never weakens identity: the durable intent tuple and its
  // sealed parent artifact are still checked below.
  allowRevokedExactAuthority = false,
} = {}) {
  const authority = jobAnalysisOperationAuthorityReceipt(operationAuthority);
  if (!nodeId || !parentRunId || !intentId || !careerSnapshotId || !parentArtifactFingerprint || !authority) {
    return { admitted: false, reason: 'missing-ownership' };
  }
  return withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: nodeId, ...authority,
    allowRevoked: allowRevokedExactAuthority === true,
  }, async record => {
    const filePath = continuationPath(record.canvasFilePath, nodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
      const store = await readStore(filePath, nodeId);
      const intent = store.intents.find(row => row.intentId === intentId);
      if (!intent || intent.parentRunId !== parentRunId || intent.careerSnapshotId !== careerSnapshotId
        || intent.parentArtifactFingerprint !== parentArtifactFingerprint
        || !sameAuthorityReceipt(intent.operationAuthority, authority)) return { ok: false, reason: 'ownership-mismatch' };
      const parent = await validateStoredParentArtifact(record.canvasFilePath, record, intent);
      if (!parent.ok) return { ok: false, reason: parent.reason };
      return callback({ record, filePath, store, intent });
    });
  });
}

async function readStore(filePath, nodeId) {
  let handle = null;
  try {
    const before = await fs.promises.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return emptyStore(nodeId);
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size > MAX_FILE_BYTES
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) return emptyStore(nodeId);
    const parsed = JSON.parse(await handle.readFile('utf8'));
    if (!parsed || parsed.version !== VERSION || parsed.nodeId !== nodeId || !Array.isArray(parsed.intents)) {
      return emptyStore(nodeId);
    }
    return {
      version: VERSION,
      nodeId,
      intents: parsed.intents.map(value => normalizeIntent(value, nodeId)).filter(Boolean),
    };
  } catch {
    return emptyStore(nodeId);
  } finally {
    try { await handle?.close(); } catch { /* noop */ }
  }
}

async function atomicWrite(filePath, store) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let handle;
  try {
    const serialized = `${JSON.stringify(store)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Job continuation checkpoint is too large to persist safely.');
    }
    handle = await fs.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, filePath);
    try {
      const dir = await fs.promises.open(path.dirname(filePath), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { /* directory fsync is best effort on filesystems that reject it */ }
  } finally {
    try { await handle?.close(); } catch { /* noop */ }
    try { await fs.promises.unlink(tmp); } catch { /* renamed or absent */ }
  }
}

async function withLock(filePath, callback) {
  const previous = locks.get(filePath) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(filePath, current);
  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(filePath) === current) locks.delete(filePath);
  }
}

async function withRecoveryOwner(canvasFilePath, callback) {
  const recoveryLease = await acquireCanvasRecoveryRead(canvasFilePath);
  try {
    return await callback(recoveryLease.canvasFilePath);
  } finally {
    recoveryLease.release();
  }
}

function sameIdentity(intent, identity) {
  return intent?.intentId === intentIdFor(identity)
    && Object.entries(identity).every(([key, value]) => (
      value && typeof value === 'object'
        ? stableJson(intent?.[key]) === stableJson(value)
        : intent?.[key] === value
    ));
}

export async function beginJobContinuation(canvasFilePath, args = {}) {
  // A new renderer intent cannot know the digest of a host-sealed artifact.
  // Admit it from its other immutable fields, derive the digest under the
  // authority lock, then reject an optional supplied digest if it disagrees.
  const suppliedParentFingerprint = typeof args.parentArtifactFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(args.parentArtifactFingerprint)
    ? args.parentArtifactFingerprint
    : null;
  const provisionalIdentity = normalizeIdentity({ ...args, parentArtifactFingerprint: suppliedParentFingerprint || '0'.repeat(64) });
  const now = timestamp(args.now);
  const requestedMode = args.recoveryMode === 'manual' ? 'manual' : 'automatic';
  if (!provisionalIdentity || !now) return { ok: false, reason: 'missing-ownership' };
  const admitted = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: provisionalIdentity.nodeId, ...provisionalIdentity.operationAuthority,
  }, async record => {
    const ownerCanvasFilePath = record.canvasFilePath;
    const parent = await deriveParentArtifactUnderAuthority(ownerCanvasFilePath, record, provisionalIdentity);
    if (!parent.ok) return { ok: false, operationSuperseded: true, reason: parent.reason };
    if (suppliedParentFingerprint && suppliedParentFingerprint !== parent.digest) {
      return { ok: false, operationSuperseded: true, reason: 'parent-artifact-mismatch' };
    }
    const identity = normalizeIdentity({ ...args, parentArtifactFingerprint: parent.digest });
    if (!identity) return { ok: false, reason: 'missing-ownership' };
    const filePath = continuationPath(ownerCanvasFilePath, identity.nodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
    const store = await readStore(filePath, identity.nodeId);
    const intentId = intentIdFor(identity);
    const existing = store.intents.find(intent => intent.intentId === intentId);
    if (existing?.recoveryMode === 'manual' && args.allowManualResume !== true) {
      return { ok: false, manual: true, intent: publicIntent(existing), reason: 'manual-recovery-required' };
    }
    const intent = {
      intentId,
      ...identity,
      parentArtifactSlot: parent.slot,
      parentArtifactPublicationReceipt: parent.receipt,
      recoveryMode: requestedMode,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ...(existing?.terminalResult ? { terminalResult: existing.terminalResult } : {}),
    };
    store.intents = existing
      ? store.intents.map(candidate => candidate.intentId === intentId ? intent : candidate)
      : [...store.intents, intent];
    try {
      await atomicWrite(filePath, store);
      return { ok: true, intent: publicIntent(intent) };
    } catch (error) {
      logger.warn(`[JobContinuation] begin failed: ${error?.message || error}`);
      return { ok: false, reason: 'write-failed' };
    }
    });
  });
  return admitted.admitted ? admitted.value : { ok: false, operationSuperseded: true, reason: admitted.reason };
}

export async function listJobContinuations(canvasFilePath, nodeId) {
  const ownerNodeId = boundedToken(nodeId, 300);
  if (!ownerNodeId) return [];
  return withRecoveryOwner(canvasFilePath, async (ownerCanvasFilePath) => {
    const filePath = continuationPath(ownerCanvasFilePath, ownerNodeId);
    if (!filePath) return [];
    return withLock(filePath, async () => (
      (await readStore(filePath, ownerNodeId)).intents.map(publicIntent)
    ));
  });
}

export async function claimJobContinuation(canvasFilePath, args = {}, { sender = null } = {}) {
  const identity = normalizeIdentity(args);
  const intentId = boundedToken(args.intentId, 64);
  if (!identity || !intentId) return { ok: false, reason: 'missing-ownership' };
  const admitted = await withExactContinuationAuthority(canvasFilePath, args, { sender }, async ({ intent, ownerCanvasFilePath, rebound }) => {
    if (intent.recoveryMode !== 'automatic' && args.allowManualResume !== true) return { ok: false, manual: true, reason: 'manual-recovery-required' };
    const automaticOperation = boundedToken(args.automaticOperation, 80) || 'execute';
    const automaticAttemptKey = `${ownerCanvasFilePath}\u0000${intent.intentId}\u0000${automaticOperation}`;
    if (args.autoResume === true && automaticAttempts.has(automaticAttemptKey)) return { ok: false, attempted: true, reason: 'automatic-attempted' };
    // Holding a recovery read lease across live execution is still required for
    // Save As, but acquire it only after authority→sidecar admission releases.
    const lease = await acquireCanvasRecoveryRead(ownerCanvasFilePath, { owner: sender });
    const execution = claimExecution(lease.canvasFilePath || ownerCanvasFilePath, intent.intentId, sender, lease, intent);
    if (!execution.ok) { lease.release(); return execution; }
    if (args.autoResume === true) automaticAttempts.add(automaticAttemptKey);
    return { ok: true, intent: publicIntent(intent), leaseToken: execution.leaseToken, rebound };
  });
  if (!admitted.admitted) return { ok: false, operationSuperseded: true, reason: admitted.reason };
  return admitted.value;
}

function isTerminalContinuationResult(operation, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (operation === 'search-jobs-single-source') {
    return result.success === true && Array.isArray(result.jobs);
  }
  if (operation === 'resolve-job-source' || operation === 'resume-job-source') {
    return result.resolved === true && Array.isArray(result.items);
  }
  return false;
}

/** Main-handler durability barrier, invoked before handleSafe replies. */
export async function checkpointJobContinuationResult(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  leaseToken = null,
  operation = null,
  careerSnapshotId = null,
  operationAuthority = null,
  parentArtifactFingerprint = null,
  result = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  const op = OPERATIONS.has(operation) ? operation : null;
  if (!ownerNodeId || !runToken || !token || !op) {
    return { saved: false, reason: 'missing-or-inactive-ownership' };
  }
  if (!isTerminalContinuationResult(op, result)) return { saved: false, nonterminal: true, reason: 'nonterminal' };
  let serialized;
  try { serialized = JSON.stringify(result); } catch { return { saved: false, reason: 'invalid-result' }; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TERMINAL_RESULT_BYTES) {
    return { saved: false, reason: 'result-too-large' };
  }
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  if (!execution?.intent) return { saved: false, reason: 'missing-or-inactive-ownership' };
  if (execution.intent.careerSnapshotId !== careerSnapshotId
    || execution.intent.parentArtifactFingerprint !== parentArtifactFingerprint
    || !sameAuthorityReceipt(execution.intent.operationAuthority, operationAuthority)) {
    return { saved: false, operationSuperseded: true, reason: 'ownership-mismatch' };
  }
  const admitted = await withExactContinuationAuthority(canvasFilePath, {
    ...execution.intent,
    nodeId: ownerNodeId, parentRunId: runToken, intentId: token, leaseToken, operation: op,
  }, { sender, requireLease: true }, async ({ store, intent: existing, filePath }) => {
    if (existing.parentRunId !== runToken || existing.operation !== op) return { saved: false, reason: 'ownership-mismatch' };
    const terminalResult = {
      operation: op,
      completedAt: Date.now(),
      resultKey: sha(serialized),
      result,
    };
    store.intents = store.intents.map(intent => intent.intentId === token
      ? { ...intent, terminalResult, updatedAt: terminalResult.completedAt }
      : intent);
    try {
      await atomicWrite(filePath, store);
      return {
        saved: true,
        terminalResultAt: terminalResult.completedAt,
        resultKey: terminalResult.resultKey,
        processEpoch: PROCESS_EPOCH,
      };
    } catch (error) {
      logger.warn(`[JobContinuation] terminal result checkpoint failed: ${error?.message || error}`);
      return { saved: false, reason: 'write-failed' };
    }
  });
  return admitted.admitted ? admitted.value : { saved: false, operationSuperseded: true, reason: admitted.reason };
}

/** Exact claimed read. Discovery never receives scraped result payloads. */
export async function readJobContinuationResult(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  leaseToken = null,
  careerSnapshotId = null,
  operationAuthority = null,
  parentArtifactFingerprint = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  if (!ownerNodeId || !execution?.intent || !runToken || !token) {
    return { found: false, reason: 'missing-or-inactive-ownership' };
  }
  if (execution.intent.careerSnapshotId !== careerSnapshotId
    || execution.intent.parentArtifactFingerprint !== parentArtifactFingerprint
    || !sameAuthorityReceipt(execution.intent.operationAuthority, operationAuthority)) {
    return { found: false, operationSuperseded: true, reason: 'ownership-mismatch' };
  }
  const admitted = await withExactContinuationAuthority(canvasFilePath, {
    ...execution.intent, nodeId: ownerNodeId, parentRunId: runToken, intentId: token, leaseToken,
  }, { sender, requireLease: true }, async ({ intent }) => {
    if (!intent.terminalResult) return { found: false, reason: 'result-absent' };
    return {
      found: true,
      operation: intent.operation,
      resultKey: intent.terminalResult.resultKey,
      completedAt: intent.terminalResult.completedAt,
      processEpoch: PROCESS_EPOCH,
      result: intent.terminalResult.result,
    };
  });
  return admitted.admitted ? admitted.value : { found: false, operationSuperseded: true, reason: admitted.reason };
}

export async function completeJobContinuation(canvasFilePath, {
  nodeId = null,
  intentId = null,
  parentRunId = null,
  expectedResultKey = null,
  appliedProcessEpoch = null,
  superseded = false,
  operationAuthority = null,
  careerSnapshotId = null,
  parentArtifactFingerprint = null,
  leaseToken = null,
  operation = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const token = boundedToken(intentId, 64);
  const runToken = boundedToken(parentRunId, 300);
  const op = OPERATIONS.has(operation) ? operation : null;
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  if (!ownerNodeId || !token || !runToken || !op || !execution) return { ok: false, reason: 'missing-or-inactive-ownership' };
  if (!execution.intent || execution.intent.careerSnapshotId !== careerSnapshotId
    || execution.intent.parentArtifactFingerprint !== parentArtifactFingerprint
    || !sameAuthorityReceipt(execution.intent.operationAuthority, operationAuthority)) {
    return { ok: false, operationSuperseded: true, reason: 'ownership-mismatch' };
  }
  const admitted = await withExactContinuationAuthority(canvasFilePath, {
    ...execution.intent, nodeId: ownerNodeId, parentRunId: runToken, intentId: token, leaseToken, operation: op,
  }, { sender, requireLease: true }, async ({ store, intent: existing, filePath }) => {
    // Completion is an exact acknowledgement, never a blind delete.  The
    // replay caller must name the receipt and artifact that produced its UI.
    // withExactContinuationAuthority already matched the claimed execution to
    // this durable row (including every input fingerprint). Reconstructing an
    // identity from a hash-only row here used to hash absent raw inputs a
    // second time and reject a valid terminal acknowledgement.
    if (existing.parentRunId !== runToken || existing.operation !== op
      || existing.careerSnapshotId !== careerSnapshotId
      || existing.parentArtifactFingerprint !== parentArtifactFingerprint
      || !sameAuthorityReceipt(existing.operationAuthority, operationAuthority)) {
      return { ok: false, operationSuperseded: true, reason: 'ownership-mismatch' };
    }
    if (existing.terminalResult && superseded !== true) {
      const resultKey = boundedToken(expectedResultKey, 64);
      const appliedEpoch = boundedToken(appliedProcessEpoch, 120);
      if (resultKey !== existing.terminalResult.resultKey || !appliedEpoch) {
        return { ok: false, receiptRequired: true, reason: 'terminal-application-receipt-required' };
      }
      if (appliedEpoch === PROCESS_EPOCH) {
        return { ok: false, receiptRequired: true, reason: 'same-process-autosave-unproven' };
      }
    }
    store.intents = store.intents.filter(intent => intent.intentId !== token);
    try {
      if (store.intents.length === 0) await fs.promises.unlink(filePath).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
      if (store.intents.length === 0) await fsyncDirectory(path.dirname(filePath));
      else await atomicWrite(filePath, store);
      return { ok: true, removed: true };
    } catch (error) {
      logger.warn(`[JobContinuation] complete failed: ${error?.message || error}`);
      return { ok: false, removed: false, reason: 'write-failed' };
    }
  });
  return admitted.admitted ? admitted.value : { ok: false, operationSuperseded: true, reason: admitted.reason };
}

export async function pauseJobContinuations(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  now = null,
  operationAuthority = null,
  careerSnapshotId = null,
  parentArtifactFingerprint = null,
  // Host-only post-Stop retry. The renderer IPC wrapper intentionally drops
  // this field, so a caller cannot turn a revoked receipt into generic power.
  allowRevokedExactAuthority = false,
} = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = parentRunId == null ? null : boundedToken(parentRunId, 300);
  const token = intentId == null ? null : boundedToken(intentId, 64);
  const at = timestamp(now);
  if (!ownerNodeId || !at || !runToken || !token || !operationAuthority || !careerSnapshotId || !parentArtifactFingerprint) {
    return { ok: false, reason: 'missing-ownership' };
  }
  const admitted = await withStoredContinuationAuthority(canvasFilePath, {
    nodeId: ownerNodeId, parentRunId: runToken, intentId: token,
    careerSnapshotId, operationAuthority, parentArtifactFingerprint,
  }, async ({ store, intent, filePath }) => {
    store.intents = store.intents.map(row => row.intentId === intent.intentId
      ? { ...row, recoveryMode: 'manual', updatedAt: at }
      : row);
    try {
      await atomicWrite(filePath, store);
      return { ok: true, paused: 1 };
    } catch (error) {
      logger.warn(`[JobContinuation] pause failed: ${error?.message || error}`);
      return { ok: false, paused: 0, reason: 'write-failed' };
    }
  }, { allowRevokedExactAuthority });
  return admitted.admitted ? admitted.value : { ok: false, paused: 0, operationSuperseded: true, reason: admitted.reason };
}

export async function clearJobContinuations(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  operationAuthority = null,
  careerSnapshotId = null,
  parentArtifactFingerprint = null,
  // Same narrow host-only cleanup capability as pause above.
  allowRevokedExactAuthority = false,
} = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = parentRunId == null ? null : boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  if (!ownerNodeId || !runToken || !token) return { ok: false, reason: 'missing-ownership' };
  const admitted = await withStoredContinuationAuthority(canvasFilePath, {
    nodeId: ownerNodeId, parentRunId: runToken, intentId: token,
    careerSnapshotId, operationAuthority, parentArtifactFingerprint,
  }, async ({ store, intent, filePath }) => {
    const retained = store.intents.filter(row => row.intentId !== intent.intentId);
    try {
      if (retained.length === 0) await fs.promises.unlink(filePath).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
      if (retained.length === 0) await fsyncDirectory(path.dirname(filePath));
      else await atomicWrite(filePath, { ...store, intents: retained });
      return { ok: true, removed: 1 };
    } catch (error) {
      logger.warn(`[JobContinuation] clear failed: ${error?.message || error}`);
      return { ok: false, removed: 0, reason: 'write-failed' };
    }
  }, { allowRevokedExactAuthority });
  return admitted.admitted ? admitted.value : { ok: false, removed: 0, operationSuperseded: true, reason: admitted.reason };
}

/**
 * Re-key continuation sidecars after a canvas Save As/Finder rename. Intent
 * identities deliberately exclude the canvas spelling, so their run/node/input
 * proof and live execution leases stay valid; only the path-derived envelope
 * moves. The filesystem adoption transaction calls this before exposing the
 * new path to a renderer.
 */
export async function rebindJobContinuationOwners(oldCanvasFilePath, newCanvasFilePath) {
  const oldScope = jobRunPathScopeForCanvas(oldCanvasFilePath);
  const newScope = jobRunPathScopeForCanvas(newCanvasFilePath);
  if (!oldScope || !newScope) return { success: false, reason: 'invalid-canvas-path' };
  if (oldScope.canvasPath === newScope.canvasPath) return { success: true, migratedCount: 0 };
  let names;
  try {
    names = (await fs.promises.readdir(oldScope.dir, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(`${oldScope.base}.jobs-continuations.${oldScope.canvasHash}.`)
        && /^[\s\S]+\.jobs-continuations\.[a-f0-9]{24}\.[a-f0-9]{24}\.json$/.test(entry.name))
      .map(entry => entry.name);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { success: true, migratedCount: 0 }
      : { success: false, reason: 'scan-failed' };
  }
  const created = [];
  let sourceDeletionStarted = false;
  try {
    for (const name of names) {
      const ownerHash = name.match(/\.jobs-continuations\.[a-f0-9]{24}\.([a-f0-9]{24})\.json$/)?.[1];
      if (!ownerHash) throw new Error('unsafe-sidecar-name');
      const source = path.join(oldScope.dir, name);
      const destination = path.join(
        newScope.dir,
        `${newScope.base}${name.slice(oldScope.base.length)}`.replace(`.${oldScope.canvasHash}.`, `.${newScope.canvasHash}.`),
      );
      const sourceStat = await fs.promises.lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > MAX_FILE_BYTES) {
        throw new Error('unsafe-sidecar');
      }
      const bytes = await fs.promises.readFile(source);
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('malformed-sidecar'); }
      const nodeId = boundedToken(parsed?.nodeId, 300);
      if (!nodeId || sha(nodeId).slice(0, 24) !== ownerHash || parsed?.version !== VERSION || !Array.isArray(parsed?.intents)
          || parsed.intents.some(intent => !normalizeIntent(intent, nodeId))) {
        throw new Error('sidecar-ownership-mismatch');
      }
      // Analysis artifacts are rewritten first during Save As, including the
      // canvas path embedded in the sealed snapshot. Their byte digest changes
      // by design, so carry each intent forward to the new sealed digest while
      // retaining the same authority receipt. Leaving the old digest here
      // would make every migrated continuation permanently unclaimable.
      const reboundIntents = [];
      for (const rawIntent of parsed.intents) {
        const intent = normalizeIntent(rawIntent, nodeId);
        if (!intent) throw new Error('sidecar-ownership-mismatch');
        if (intent.parentArtifactSlot !== 'current') throw new Error('unsupported-parent-artifact-slot');
        const artifactPath = getJobAnalysisPaths(newScope.canvasPath, null, nodeId)?.jsonPath;
        const artifactBytes = artifactPath ? await readBoundedNoFollowRegularFile(artifactPath) : null;
        if (!artifactBytes) throw new Error('parent-artifact-unavailable');
        const digest = crypto.createHash('sha256').update(artifactBytes).digest('hex');
        let snapshot;
        try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifactBytes)); } catch { throw new Error('parent-artifact-invalid'); }
        const snapshotReceipt = jobAnalysisOperationAuthorityReceipt(snapshot?.operationAuthority ?? snapshot?.snapshotContext?.operationAuthority);
        if (snapshot?.nodeId !== nodeId || snapshot?.sourceHubId !== nodeId
          || snapshot?.runId !== intent.parentRunId || snapshot?.careerSnapshotId !== intent.careerSnapshotId
          || !sameAuthorityReceipt(snapshotReceipt, intent.parentArtifactPublicationReceipt)) {
          throw new Error('parent-artifact-mismatch');
        }
        const identity = {
          nodeId: intent.nodeId,
          parentRunId: intent.parentRunId,
          profileFingerprint: intent.profileFingerprint,
          kind: intent.kind,
          operation: intent.operation,
          sourceId: intent.sourceId,
          careerSnapshotId: intent.careerSnapshotId,
          operationAuthority: intent.operationAuthority,
          parentArtifactFingerprint: digest,
          searchWindowFingerprint: intent.searchWindowFingerprint,
          locationFingerprint: intent.locationFingerprint,
          generationFingerprint: intent.generationFingerprint,
          ...(intent.operationInputFingerprint ? { operationInputFingerprint: intent.operationInputFingerprint } : {}),
        };
        reboundIntents.push({
          ...intent,
          ...identity,
          intentId: intentIdFor(identity),
          parentArtifactFingerprint: digest,
        });
      }
      if (new Set(reboundIntents.map(intent => intent.intentId)).size !== reboundIntents.length) {
        throw new Error('rebound-intent-collision');
      }
      const reboundBytes = Buffer.from(`${JSON.stringify({ ...parsed, intents: reboundIntents })}\n`, 'utf8');
      if (reboundBytes.length > MAX_FILE_BYTES) throw new Error('sidecar-too-large');
      try {
        const handle = await fs.promises.open(destination, 'wx', sourceStat.mode & 0o777);
        try { await handle.writeFile(reboundBytes); await handle.sync(); } finally { await handle.close(); }
        await fsyncDirectory(newScope.dir);
        created.push(destination);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existingStat = await fs.promises.lstat(destination);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size > MAX_FILE_BYTES) throw new Error('unsafe-destination');
        const existing = await fs.promises.readFile(destination);
        if (!existing.equals(reboundBytes)) throw new Error('destination-sidecar-conflict');
      }
    }
    for (const name of names) {
      sourceDeletionStarted = true;
      await fs.promises.unlink(path.join(oldScope.dir, name));
    }
    await fsyncDirectory(oldScope.dir);
    return { success: true, migratedCount: names.length };
  } catch (error) {
    // Once any old entry was removed, the already-durable destinations are the
    // only exact copy. Keep them for an idempotent journal replay instead of
    // turning a late unlink/fsync error into data loss.
    if (!sourceDeletionStarted) await Promise.all(created.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
    logger.warn(`[JobContinuation] recovery owner rebind failed: ${error?.message || error}`);
    return { success: false, reason: error?.message === 'destination-sidecar-conflict' ? 'destination-conflict' : 'migration-failed' };
  }
}

export function __jobContinuationPathForTests(canvasFilePath, nodeId) {
  return continuationPath(canvasFilePath, nodeId);
}
