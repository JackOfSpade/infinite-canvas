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

const VERSION = 1;
const PROCESS_EPOCH = crypto.randomBytes(24).toString('hex');
const MAX_INTENTS = 32;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_RESULT_BYTES = 12 * 1024 * 1024;
const KINDS = new Set(['late-source-refresh', 'source-recovery']);
const OPERATIONS = new Set(['search-jobs-single-source', 'resolve-job-source', 'resume-job-source']);
const RECOVERY_MODES = new Set(['automatic', 'manual']);
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

function claimExecution(canvasFilePath, intentId, sender, recoveryLease = null) {
  if (!sender) return { ok: false, reason: 'missing-sender' };
  const ownerKey = `${canvasFilePath}\u0000${intentId}`;
  if (activeExecutions.has(ownerKey)) return { ok: false, busy: true, reason: 'already-running' };
  const leaseToken = crypto.randomBytes(24).toString('hex');
  const execution = { ownerKey, canvasFilePath, intentId, leaseToken, sender, recoveryLease };
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
  if (!nodeId || !parentRunId || !profileFingerprint || !kind || !operation || !sourceId) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(sourceId)) return null;
  const inputs = inputFingerprints(args);
  return { nodeId, parentRunId, profileFingerprint, kind, operation, sourceId, ...inputs };
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
  if (!identity || identity.nodeId !== nodeId || !intentId || !createdAt || !updatedAt || !recoveryMode) return null;
  if (![searchWindowFingerprint, locationFingerprint, generationFingerprint].every(v => /^[a-f0-9]{64}$/.test(v || ''))) return null;
  if (value.operationInputFingerprint != null && !/^[a-f0-9]{64}$/.test(operationInputFingerprint || '')) return null;
  const normalizedIdentity = {
    nodeId: identity.nodeId,
    parentRunId: identity.parentRunId,
    profileFingerprint: identity.profileFingerprint,
    kind: identity.kind,
    operation: identity.operation,
    sourceId: identity.sourceId,
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
    ...(terminalResult ? { terminalResult } : {}),
  };
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
      intents: parsed.intents.slice(0, MAX_INTENTS).map(value => normalizeIntent(value, nodeId)).filter(Boolean),
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
    && Object.entries(identity).every(([key, value]) => intent?.[key] === value);
}

export async function beginJobContinuation(canvasFilePath, args = {}) {
  const identity = normalizeIdentity(args);
  const now = timestamp(args.now);
  const requestedMode = args.recoveryMode === 'manual' ? 'manual' : 'automatic';
  if (!identity || !now) return { ok: false, reason: 'missing-ownership' };
  return withRecoveryOwner(canvasFilePath, async (ownerCanvasFilePath) => {
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
      recoveryMode: requestedMode,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ...(existing?.terminalResult ? { terminalResult: existing.terminalResult } : {}),
    };
    if (!existing && store.intents.length >= MAX_INTENTS) {
      return { ok: false, reason: 'capacity' };
    }
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
  const recoveryLease = await acquireCanvasRecoveryRead(canvasFilePath, { owner: sender });
  if (!recoveryLease.canvasFilePath) {
    recoveryLease.release();
    return { ok: false, reason: 'missing-ownership' };
  }
  const ownerCanvasFilePath = recoveryLease.canvasFilePath;
  let leaseTransferred = false;
  try {
    const filePath = continuationPath(ownerCanvasFilePath, identity.nodeId);
    const intent = filePath
      ? await withLock(filePath, async () => (
          (await readStore(filePath, identity.nodeId)).intents.find(candidate => candidate.intentId === intentId) || null
        ))
      : null;
    if (!intent) return { ok: false, absent: true, reason: 'intent-absent' };
    if (!sameIdentity(intent, identity)) return { ok: false, tokenMismatch: true, reason: 'ownership-mismatch' };
    if (intent.recoveryMode !== 'automatic' && args.allowManualResume !== true) {
      return { ok: false, manual: true, reason: 'manual-recovery-required' };
    }
    const automaticOperation = boundedToken(args.automaticOperation, 80) || 'execute';
    const automaticAttemptKey = `${ownerCanvasFilePath}\u0000${intent.intentId}\u0000${automaticOperation}`;
    if (args.autoResume === true && automaticAttempts.has(automaticAttemptKey)) {
      return { ok: false, attempted: true, reason: 'automatic-attempted' };
    }
    const execution = claimExecution(ownerCanvasFilePath, intent.intentId, sender, recoveryLease);
    if (!execution.ok) return execution;
    leaseTransferred = true;
    if (args.autoResume === true) automaticAttempts.add(automaticAttemptKey);
    return { ok: true, intent: publicIntent(intent), leaseToken: execution.leaseToken };
  } finally {
    // A successful execution owns this read lease through release/destroy.
    if (!leaseTransferred) recoveryLease.release();
  }
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
  result = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  const op = OPERATIONS.has(operation) ? operation : null;
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  const filePath = ownerNodeId && execution
    ? continuationPath(execution.canvasFilePath, ownerNodeId)
    : null;
  if (!filePath || !runToken || !token || !op) {
    return { saved: false, reason: 'missing-or-inactive-ownership' };
  }
  if (!isTerminalContinuationResult(op, result)) return { saved: false, nonterminal: true, reason: 'nonterminal' };
  let serialized;
  try { serialized = JSON.stringify(result); } catch { return { saved: false, reason: 'invalid-result' }; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TERMINAL_RESULT_BYTES) {
    return { saved: false, reason: 'result-too-large' };
  }
  return withLock(filePath, async () => {
    if (!exactExecution(token, leaseToken, sender, execution.canvasFilePath)) {
      return { saved: false, reason: 'execution-released' };
    }
    const store = await readStore(filePath, ownerNodeId);
    const existing = store.intents.find(intent => intent.intentId === token);
    if (!existing || existing.parentRunId !== runToken || existing.operation !== op) {
      return { saved: false, reason: 'ownership-mismatch' };
    }
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
}

/** Exact claimed read. Discovery never receives scraped result payloads. */
export async function readJobContinuationResult(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  leaseToken = null,
} = {}, { sender = null } = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = boundedToken(parentRunId, 300);
  const token = boundedToken(intentId, 64);
  const execution = exactExecution(token, leaseToken, sender, canvasFilePath);
  const filePath = ownerNodeId && execution
    ? continuationPath(execution.canvasFilePath, ownerNodeId)
    : null;
  if (!filePath || !runToken || !token) {
    return { found: false, reason: 'missing-or-inactive-ownership' };
  }
  return withLock(filePath, async () => {
    if (!exactExecution(token, leaseToken, sender, execution.canvasFilePath)) {
      return { found: false, reason: 'execution-released' };
    }
    const intent = (await readStore(filePath, ownerNodeId)).intents
      .find(candidate => candidate.intentId === token);
    if (!intent || intent.parentRunId !== runToken) return { found: false, reason: 'ownership-mismatch' };
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
}

export async function completeJobContinuation(canvasFilePath, {
  nodeId = null,
  intentId = null,
  parentRunId = null,
  expectedResultKey = null,
  appliedProcessEpoch = null,
  superseded = false,
} = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const token = boundedToken(intentId, 64);
  const runToken = boundedToken(parentRunId, 300);
  if (!ownerNodeId || !token || !runToken) return { ok: false, reason: 'missing-ownership' };
  return withRecoveryOwner(canvasFilePath, async (ownerCanvasFilePath) => {
    const filePath = continuationPath(ownerCanvasFilePath, ownerNodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
    const store = await readStore(filePath, ownerNodeId);
    const existing = store.intents.find(intent => intent.intentId === token);
    if (!existing) return { ok: true, removed: false, absent: true };
    if (existing.parentRunId !== runToken) return { ok: false, tokenMismatch: true, reason: 'ownership-mismatch' };
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
  });
}

export async function pauseJobContinuations(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
  intentId = null,
  now = null,
} = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = parentRunId == null ? null : boundedToken(parentRunId, 300);
  const token = intentId == null ? null : boundedToken(intentId, 64);
  const at = timestamp(now);
  if (!ownerNodeId || !at || (parentRunId != null && !runToken) || (intentId != null && !token)) {
    return { ok: false, reason: 'missing-ownership' };
  }
  return withRecoveryOwner(canvasFilePath, async (ownerCanvasFilePath) => {
    const filePath = continuationPath(ownerCanvasFilePath, ownerNodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
    const store = await readStore(filePath, ownerNodeId);
    let paused = 0;
    store.intents = store.intents.map((intent) => {
      if ((runToken && intent.parentRunId !== runToken) || (token && intent.intentId !== token)) return intent;
      paused += 1;
      return { ...intent, recoveryMode: 'manual', updatedAt: at };
    });
    if (paused === 0) return { ok: true, paused: 0 };
    try {
      await atomicWrite(filePath, store);
      return { ok: true, paused };
    } catch (error) {
      logger.warn(`[JobContinuation] pause failed: ${error?.message || error}`);
      return { ok: false, paused: 0, reason: 'write-failed' };
    }
    });
  });
}

export async function clearJobContinuations(canvasFilePath, {
  nodeId = null,
  parentRunId = null,
} = {}) {
  const ownerNodeId = boundedToken(nodeId, 300);
  const runToken = parentRunId == null ? null : boundedToken(parentRunId, 300);
  if (!ownerNodeId || (parentRunId != null && !runToken)) return { ok: false, reason: 'missing-ownership' };
  return withRecoveryOwner(canvasFilePath, async (ownerCanvasFilePath) => {
    const filePath = continuationPath(ownerCanvasFilePath, ownerNodeId);
    if (!filePath) return { ok: false, reason: 'missing-ownership' };
    return withLock(filePath, async () => {
    const store = await readStore(filePath, ownerNodeId);
    const retained = runToken
      ? store.intents.filter(intent => intent.parentRunId !== runToken)
      : [];
    const removed = store.intents.length - retained.length;
    try {
      if (retained.length === 0) await fs.promises.unlink(filePath).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
      if (retained.length === 0) await fsyncDirectory(path.dirname(filePath));
      else await atomicWrite(filePath, { ...store, intents: retained });
      return { ok: true, removed };
    } catch (error) {
      logger.warn(`[JobContinuation] clear failed: ${error?.message || error}`);
      return { ok: false, removed: 0, reason: 'write-failed' };
    }
    });
  });
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
          || parsed.intents.length > MAX_INTENTS || parsed.intents.some(intent => !normalizeIntent(intent, nodeId))) {
        throw new Error('sidecar-ownership-mismatch');
      }
      try {
        const handle = await fs.promises.open(destination, 'wx', sourceStat.mode & 0o777);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fsyncDirectory(newScope.dir);
        created.push(destination);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existingStat = await fs.promises.lstat(destination);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size > MAX_FILE_BYTES) throw new Error('unsafe-destination');
        const existing = await fs.promises.readFile(destination);
        if (!existing.equals(bytes)) throw new Error('destination-sidecar-conflict');
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
