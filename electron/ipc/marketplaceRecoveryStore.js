/**
 * Durable recovery ledger for sell-side marketplace work.
 *
 * Canvas autosave is deliberately debounced, so a renderer-only marker cannot
 * prove that recovery intent reached disk before a browser/AI side effect. This
 * compact sidecar is the write-ahead barrier. It is scoped to the canonical
 * canvas path + exact node owner and every mutation is fenced by run/input id.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import {
  acquireCanvasRecoveryRead,
  resolveCanvasRecoveryPath,
} from './canvasRecoveryPaths.js';
import { getCurrentIpcRequestContext } from './ipcUtils.js';

const VERSION = 1;
const KINDS = new Set(['sellhub', 'marketplace-status']);
const TERMINAL_STATUSES = new Set(['abandoned', 'completed']);
const REPLAY_PHASES = new Set(['analysis-result', 'comps-ready', 'priced-result', 'status-result']);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_CANCELLATION_FENCES = 4096;
const PROCESS_EPOCH = crypto.randomUUID();
const tails = new Map();
const activeClaims = new Map();
const automaticAttempts = new Set();
const senderClaims = new WeakMap();
const hookedClaimSenders = new WeakSet();
let tmpSequence = 0;

function cleanToken(value, max = 1024) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : null;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

async function canonicalCanvasFile(canvasFilePath) {
  const candidate = cleanToken(canvasFilePath, 32_768);
  if (!candidate || !path.isAbsolute(candidate)) return null;
  const resolved = resolveCanvasRecoveryPath(candidate) || path.resolve(candidate);
  const stat = await fs.promises.lstat(resolved).catch(() => null);
  if (!stat?.isFile()) return null;
  return fs.promises.realpath(resolved).catch(() => null);
}

async function owner(args = {}) {
  const canvasFilePath = await canonicalCanvasFile(args.canvasFilePath);
  const nodeId = cleanToken(args.nodeId);
  const kind = KINDS.has(args.kind) ? args.kind : null;
  if (!canvasFilePath || !nodeId || !kind) return null;
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return {
    canvasFilePath,
    nodeId,
    kind,
    filePath: path.join(
      path.dirname(canvasFilePath),
      `${base}.marketplace-recovery.${hash(canvasFilePath)}.${hash(nodeId)}.json`,
    ),
  };
}

async function cancellationFenceOwner(canvasFilePath) {
  const canonicalPath = await canonicalCanvasFile(canvasFilePath);
  if (!canonicalPath) return null;
  const base = path.basename(canonicalPath).replace(/\.json$/i, '');
  return {
    canvasFilePath: canonicalPath,
    filePath: path.join(
      path.dirname(canonicalPath),
      `${base}.marketplace-cancellation-fences.${hash(canonicalPath)}.json`,
    ),
  };
}

/**
 * Read a small recovery record without following a path swapped after its
 * directory entry was inspected. Recovery sidecars live next to user-owned
 * canvases, so `lstat()` followed by `readFile()` is not a safe validation
 * sequence: the name may become a symlink in between. Keep the descriptor
 * open through both validation and read, and verify it still names the inode
 * that was inspected.
 */
async function readRegularNoFollowUtf8(filePath) {
  let handle = null;
  try {
    const before = await fs.promises.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JSON_BYTES) {
      throw new Error(`Refusing unsafe Marketplace recovery record: ${path.basename(filePath)}`);
    }
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size > MAX_JSON_BYTES
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new Error(`Refusing changed Marketplace recovery record: ${path.basename(filePath)}`);
    }
    // Do not use FileHandle.readFile() here. It reads through EOF, so a
    // writer which retains this same inode can append after the fstat above
    // and bypass MAX_JSON_BYTES without changing the pathname or inode. Read
    // exactly the verified size, then make one final descriptor-held check so
    // growth, truncation, or an in-place write observed during this read is
    // rejected rather than treated as a recovery record.
    const expectedSize = opened.size;
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, offset);
      if (!(bytesRead > 0)) {
        throw new Error(`Refusing changed Marketplace recovery record: ${path.basename(filePath)}`);
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.size !== expectedSize
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Refusing changed Marketplace recovery record: ${path.basename(filePath)}`);
    }
    return bytes.toString('utf8');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function cancellationFenceKey(kind, nodeId, runId) {
  return `${kind}\u0000${nodeId}\u0000${runId}`;
}

async function readCancellationFencesUnlocked(fenceScope) {
  try {
    const parsed = JSON.parse(await readRegularNoFollowUtf8(fenceScope.filePath));
    if (parsed?.version !== VERSION || parsed?.canvasFilePath !== fenceScope.canvasFilePath || !parsed.entries || typeof parsed.entries !== 'object') {
      return { version: VERSION, canvasFilePath: fenceScope.canvasFilePath, entries: {} };
    }
    return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('[MarketplaceRecovery] Could not read cancellation fences:', error?.message || String(error));
    return { version: VERSION, canvasFilePath: fenceScope.canvasFilePath, entries: {} };
  }
}

async function isCancellationFenced(scope, runId) {
  const fenceScope = await cancellationFenceOwner(scope.canvasFilePath);
  if (!fenceScope) return false;
  const ledger = await readCancellationFencesUnlocked(fenceScope);
  return !!ledger.entries?.[cancellationFenceKey(scope.kind, scope.nodeId, runId)];
}

function removeSenderClaim(sender, key) {
  if (!sender) return;
  const owned = senderClaims.get(sender);
  owned?.delete(key);
  if (owned?.size === 0) senderClaims.delete(sender);
}

function releaseMarketplaceClaimRecord(key, record) {
  if (!record || record.ownerReleased) return false;
  record.ownerReleased = true;
  if (activeClaims.get(key) === record) activeClaims.delete(key);
  removeSenderClaim(record.sender, key);
  record.resolveReleased?.();
  record.canvasLease?.release?.();
  return true;
}

function hookMarketplaceClaimSender(sender) {
  if (!sender || hookedClaimSenders.has(sender) || typeof sender.once !== 'function') return;
  hookedClaimSenders.add(sender);
  sender.once('destroyed', () => {
    const owned = senderClaims.get(sender);
    if (!owned) return;
    for (const key of [...owned]) {
      const record = activeClaims.get(key);
      if (!record || record.sender !== sender) continue;
      try {
        record.abort?.(Object.assign(new Error('Window closed'), {
          name: 'AbortError',
          cancelCause: 'sender-destroyed',
        }));
      } catch (error) {
        logger.warn('[MarketplaceRecovery] Could not abort destroyed sender claim:', error?.message || String(error));
      }
      // A dependency may ignore AbortSignal forever. Keep the durable active
      // sidecar for restart, but release this process-local executor/read lease
      // so Save As and another window cannot wedge behind a dead WebContents.
      releaseMarketplaceClaimRecord(key, record);
    }
    senderClaims.delete(sender);
  });
}

/** One process-local executor per canonical canvas/node owner. */
export async function acquireMarketplaceRecoveryClaim(args = {}) {
  const senderCandidate = args.sender || getCurrentIpcRequestContext()?.sender || null;
  const sender = senderCandidate && (typeof senderCandidate === 'object' || typeof senderCandidate === 'function')
    ? senderCandidate
    : null;
  const canvasLease = await acquireCanvasRecoveryRead(args.canvasFilePath, { owner: sender });
  const scope = await owner({ ...args, canvasFilePath: canvasLease.canvasFilePath });
  // Unsaved canvases have no restart sidecar and no cross-window canonical
  // identity. Their existing browser/queue locks remain the concurrency gate.
  if (!scope) {
    canvasLease.release();
    return { claimed: true, release: () => {} };
  }
  const key = scope.filePath;
  const requested = `${cleanToken(args.runId) || ''}\u0000${typeof args.inputKey === 'string' ? args.inputKey : ''}`;
  const automaticAttemptKey = `${key}\u0000${requested}\u0000${cleanToken(args.operation, 120) || 'run'}`;
  if (args.autoResume === true && automaticAttempts.has(automaticAttemptKey)) {
    canvasLease.release();
    return { claimed: false, reason: 'automatic-attempted' };
  }
  const held = activeClaims.get(key);
  if (held) {
    if (args.waitForRelease === true) {
      canvasLease.release();
      await held.released;
      return acquireMarketplaceRecoveryClaim(args);
    }
    canvasLease.release();
    return { claimed: false, reason: held.identity === requested ? 'already-running' : 'owner-busy' };
  }
  let resolveReleased;
  const releasePromise = new Promise(resolve => { resolveReleased = resolve; });
  const ownerToken = Symbol('marketplace-recovery-owner');
  const claimRecord = {
    ownerToken,
    identity: requested,
    runId: cleanToken(args.runId),
    inputKey: typeof args.inputKey === 'string' ? args.inputKey : '',
    abort: typeof args.abort === 'function' ? args.abort : null,
    released: releasePromise,
    resolveReleased,
    canvasLease,
    joinCapability: canvasLease.joinCapability || null,
    sender,
    ownerReleased: false,
  };
  if (args.autoResume === true) automaticAttempts.add(automaticAttemptKey);
  activeClaims.set(key, claimRecord);
  if (sender) {
    const owned = senderClaims.get(sender) || new Set();
    owned.add(key);
    senderClaims.set(sender, owned);
    hookMarketplaceClaimSender(sender);
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      try {
        claimRecord.abort?.(Object.assign(new Error('Window closed'), {
          name: 'AbortError',
          cancelCause: 'sender-destroyed',
        }));
      } finally {
        releaseMarketplaceClaimRecord(key, claimRecord);
      }
      return { claimed: false, reason: 'sender-destroyed' };
    }
  }
  let didRelease = false;
  return {
    claimed: true,
    ownerToken,
    release: () => {
      if (didRelease) return;
      didRelease = true;
      releaseMarketplaceClaimRecord(key, claimRecord);
    },
  };
}

function withLock(filePath, fn) {
  const prior = tails.get(filePath) || Promise.resolve();
  const result = prior.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  tails.set(filePath, tail);
  return result.finally(() => {
    if (tails.get(filePath) === tail) tails.delete(filePath);
  });
}

async function atomicWrite(filePath, value, options = {}) {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('Marketplace recovery checkpoint is too large to persist safely.');
  }
  const temp = `${filePath}.${process.pid}.${tmpSequence++}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let handle = null;
  try {
    const flags = fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0);
    handle = await fs.promises.open(temp, flags, 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (options.signal?.aborted) {
      const error = options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Marketplace recovery checkpoint aborted before commit.');
      if (!error.name || error.name === 'Error') error.name = 'AbortError';
      throw error;
    }
    await fs.promises.rename(temp, filePath);
    // rename durability is a directory metadata property. Best effort on
    // filesystems that reject directory fsync, but never skip the file fsync.
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
  }
}

async function readUnlocked(scope) {
  let parsed;
  try {
    parsed = JSON.parse(await readRegularNoFollowUtf8(scope.filePath));
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('[MarketplaceRecovery] Could not read sidecar:', error?.message || String(error));
    return null;
  }
  if (
    parsed?.version !== VERSION
    || parsed.canvasFilePath !== scope.canvasFilePath
    || parsed.nodeId !== scope.nodeId
    || parsed.kind !== scope.kind
    || !cleanToken(parsed.runId)
    || typeof parsed.inputKey !== 'string'
  ) return null;
  return parsed;
}

function recoveryIdentity(recovery) {
  const runId = cleanToken(recovery?.runId);
  const inputKey = typeof recovery?.inputKey === 'string' ? recovery.inputKey : null;
  return runId && inputKey !== null ? { runId, inputKey } : null;
}

/** Await this before the first external side effect of a phase. */
async function beginMarketplaceRecoveryUnlocked(args = {}) {
  const scope = await owner(args);
  const identity = recoveryIdentity(args.recovery);
  if (!scope || !identity || !args.recovery || typeof args.recovery !== 'object') {
    return { saved: false, reason: scope ? 'invalid-recovery' : 'unsaved-or-invalid-owner' };
  }
  return withLock(scope.filePath, async () => {
    if (await isCancellationFenced(scope, identity.runId)) {
      return { saved: false, reason: 'abandoned', recovery: null };
    }
    const previous = await readUnlocked(scope);
    // A user Reset/Cancel is durable authority for this exact run. Never let a
    // late continuation resurrect it. A deliberate fresh run has a new run id
    // and may supersede the old receipt.
    if (previous?.status === 'abandoned' && previous.runId === identity.runId) {
      return { saved: false, reason: 'abandoned', recovery: previous.recovery || null };
    }
    if (previous?.status === 'completed' && previous.runId === identity.runId) {
      return { saved: false, reason: 'completed', recovery: null };
    }
    if (previous?.status === 'replay' && previous.runId === identity.runId) {
      return { saved: false, reason: 'replay-pending', recovery: previous.recovery || null };
    }
    if (previous?.runId === identity.runId && previous.inputKey !== identity.inputKey) {
      return { saved: false, reason: 'input-mismatch', recovery: previous.recovery || null };
    }
    if (previous?.status === 'active' && previous.runId === identity.runId) {
      return {
        saved: true,
        existing: true,
        recovery: previous.recovery,
        canonicalCanvasFilePath: scope.canvasFilePath,
      };
    }
    const now = Date.now();
    const record = {
      version: VERSION,
      kind: scope.kind,
      status: REPLAY_PHASES.has(args.recovery.phase) ? 'replay' : 'active',
      canvasFilePath: scope.canvasFilePath,
      nodeId: scope.nodeId,
      runId: identity.runId,
      inputKey: identity.inputKey,
      recovery: args.recovery,
      createdAt: previous?.runId === identity.runId ? previous.createdAt : now,
      updatedAt: now,
    };
    await atomicWrite(scope.filePath, record);
    return { saved: true, recovery: record.recovery, canonicalCanvasFilePath: scope.canvasFilePath };
  });
}

/** Exact-owner/run/input checkpoint. Late work from superseded phases is inert. */
async function checkpointMarketplaceRecoveryUnlocked(args = {}) {
  const scope = await owner(args);
  const identity = recoveryIdentity(args.recovery);
  if (!scope || !identity) return { saved: false, reason: 'unsaved-or-invalid' };
  return withLock(scope.filePath, async () => {
    if (args.signal?.aborted) return { saved: false, reason: 'aborted' };
    if (await isCancellationFenced(scope, identity.runId)) return { saved: false, reason: 'abandoned' };
    const previous = await readUnlocked(scope);
    if (!previous || TERMINAL_STATUSES.has(previous.status)) return { saved: false, reason: previous?.status || 'missing' };
    if (previous.runId !== identity.runId) return { saved: false, reason: 'run-mismatch' };
    // Phase transitions intentionally change inputKey (scrape -> synthesis),
    // but the caller must name the exact key it is replacing.
    const expectedInputKey = typeof args.expectedInputKey === 'string' ? args.expectedInputKey : identity.inputKey;
    if (previous.inputKey !== expectedInputKey) return { saved: false, reason: 'input-mismatch' };
    const next = {
      ...previous,
      status: REPLAY_PHASES.has(args.recovery.phase) ? 'replay' : 'active',
      inputKey: identity.inputKey,
      recovery: args.recovery,
      updatedAt: Date.now(),
    };
    if (args.signal?.aborted) return { saved: false, reason: 'aborted' };
    await atomicWrite(scope.filePath, next, { signal: args.signal });
    return { saved: true, recovery: next.recovery, processEpoch: PROCESS_EPOCH };
  });
}

async function peekMarketplaceRecoveryUnlocked(args = {}) {
  const scope = await owner(args);
  if (!scope) return { found: false, reason: 'unsaved-or-invalid-owner' };
  return withLock(scope.filePath, async () => {
    const record = await readUnlocked(scope);
    if (record && await isCancellationFenced(scope, record.runId)) {
      return { found: false, status: 'abandoned', runId: record.runId, inputKey: record.inputKey };
    }
    if (!record || !['active', 'replay'].includes(record.status)) {
      return {
        found: false,
        status: record?.status || null,
        runId: record?.runId || null,
        inputKey: record?.inputKey ?? null,
      };
    }
    return {
      found: true,
      recovery: record.recovery,
      runId: record.runId,
      inputKey: record.inputKey,
      status: record.status,
      canonicalCanvasFilePath: scope.canvasFilePath,
      processEpoch: PROCESS_EPOCH,
    };
  });
}

/**
 * Mark a replay receipt completed only after a later renderer observation sees
 * that the canvas already contains the terminal state. Keeping this distinct
 * from abandon makes diagnostics unambiguous and closes the autosave gap.
 */
async function acknowledgeMarketplaceRecoveryUnlocked(args = {}) {
  const scope = await owner(args);
  const runId = cleanToken(args.runId);
  const inputKey = typeof args.inputKey === 'string' ? args.inputKey : null;
  const appliedProcessEpoch = cleanToken(args.appliedProcessEpoch, 120);
  if (!scope || !runId || inputKey === null || !appliedProcessEpoch) return { completed: false, reason: 'unsaved-or-invalid' };
  if (appliedProcessEpoch === PROCESS_EPOCH) {
    return { completed: false, reason: 'same-process-autosave-unproven' };
  }
  return withLock(scope.filePath, async () => {
    const previous = await readUnlocked(scope);
    if (!previous) return { completed: false, reason: 'missing' };
    if (previous.runId !== runId) return { completed: false, reason: 'run-mismatch' };
    if (previous.inputKey !== inputKey) return { completed: false, reason: 'input-mismatch' };
    if (previous.status !== 'replay') return { completed: false, reason: previous.status || 'not-replay' };
    await atomicWrite(scope.filePath, {
      version: VERSION,
      kind: scope.kind,
      status: 'completed',
      canvasFilePath: scope.canvasFilePath,
      nodeId: scope.nodeId,
      runId,
      inputKey: previous.inputKey,
      reason: cleanToken(args.reason, 120) || 'terminal-state-observed',
      createdAt: previous.createdAt,
      updatedAt: Date.now(),
    });
    return { completed: true };
  });
}

/** Durable tombstone used by explicit Reset/Cancel and exact-input invalidation. */
async function abandonMarketplaceRecoveryUnlocked(args = {}, options = {}) {
  const scope = await owner(args);
  const runId = cleanToken(args.runId);
  const requestedInputKey = typeof args.inputKey === 'string' ? args.inputKey : null;
  if (!scope || !runId || requestedInputKey === null) return { abandoned: false, reason: 'unsaved-or-invalid' };
  const result = await withLock(scope.filePath, async () => {
    const previous = await readUnlocked(scope);
    if (previous && previous.runId !== runId) return { abandoned: false, reason: 'run-mismatch' };
    if (previous && previous.inputKey !== requestedInputKey) return { abandoned: false, reason: 'input-mismatch' };
    const heldClaim = activeClaims.get(scope.filePath);
    if (!previous && heldClaim?.runId && heldClaim.runId !== runId) {
      return { abandoned: false, reason: 'run-mismatch' };
    }
    if (!previous && heldClaim && heldClaim.inputKey !== requestedInputKey) {
      return { abandoned: false, reason: 'input-mismatch' };
    }
    const tombstone = {
      version: VERSION,
      kind: scope.kind,
      status: 'abandoned',
      canvasFilePath: scope.canvasFilePath,
      nodeId: scope.nodeId,
      runId,
      // A renderer can request Reset in the acquire→begin gap, before an active
      // record exists. Write the exact-run tombstone anyway so the later begin
      // is rejected. Prefer the caller/claim key; the empty fallback is still
      // safe because abandoned ownership is fenced by run id before input.
      inputKey: previous?.inputKey ?? heldClaim?.inputKey ?? requestedInputKey,
      reason: cleanToken(args.reason, 120) || 'user-cancelled',
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await atomicWrite(scope.filePath, tombstone);
    return { abandoned: true };
  });
  if (!result.abandoned) return result;
  // The canonical claim can belong to another renderer window. Sender-scoped
  // IPC cancellation cannot reach it, so the exact durable tombstone also
  // aborts that owner and waits for its handler finally/release boundary.
  const heldClaim = activeClaims.get(scope.filePath);
  if (heldClaim?.runId === runId) {
    if (options.ownerToken && heldClaim.ownerToken === options.ownerToken) {
      return { ...result, claimSettled: false, ownerWillRelease: true };
    }
    try {
      heldClaim.abort?.(Object.assign(new Error('Node deleted'), {
        name: 'AbortError',
        cancelCause: cleanToken(args.reason, 40) || 'marketplace-abandoned',
      }));
    } catch (error) {
      logger.warn('[MarketplaceRecovery] Could not abort canonical claim:', error?.message || String(error));
    }
    let timeoutId;
    const settled = await Promise.race([
      heldClaim.released.then(() => true),
      new Promise(resolve => { timeoutId = setTimeout(() => resolve(false), 30_000); }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    return { ...result, claimSettled: settled };
  }
  return { ...result, claimSettled: true };
}

/**
 * Atomically fence every Marketplace owner in one deletion transaction.
 * The canvas-scoped ledger is the commit record: once it is fsynced, every
 * listed run is inert even if a later per-owner tombstone write fails. All
 * ownership validation happens before that single commit, so callers either
 * retain every active recovery or can safely remove the whole node tree.
 */
async function abandonMarketplaceRecoveryBatchUnlocked(args = {}, options = {}) {
  const fenceScope = await cancellationFenceOwner(args.canvasFilePath);
  const requestedOwners = Array.isArray(args.owners) ? args.owners : [];
  if (!fenceScope || requestedOwners.length > MAX_CANCELLATION_FENCES) {
    return { fenced: false, reason: 'unsaved-or-invalid' };
  }
  const scopes = (await Promise.all(requestedOwners.map(async requested => {
    const scope = await owner({
      canvasFilePath: fenceScope.canvasFilePath,
      nodeId: requested?.nodeId,
      kind: requested?.kind,
    });
    return scope ? { scope, requested } : null;
  }))).filter(Boolean);

  const prepared = await withLock(fenceScope.filePath, async () => {
    const targets = [];
    for (const { scope, requested } of scopes) {
      const record = await readUnlocked(scope);
      const claim = activeClaims.get(scope.filePath);
      const requestedRunId = cleanToken(requested?.runId);
      const requestedInputKey = typeof requested?.inputKey === 'string' ? requested.inputKey : null;
      const authoritativeRunId = record?.runId || claim?.runId || requestedRunId;
      const authoritativeInputKey = record?.inputKey ?? claim?.inputKey ?? requestedInputKey ?? '';
      if (!authoritativeRunId) continue;
      if (requestedRunId && requestedRunId !== authoritativeRunId) {
        return { fenced: false, reason: 'run-mismatch', nodeId: scope.nodeId };
      }
      if (requestedRunId && requestedInputKey === null) {
        return { fenced: false, reason: 'input-mismatch', nodeId: scope.nodeId };
      }
      if (requestedInputKey !== null && requestedInputKey !== authoritativeInputKey) {
        return { fenced: false, reason: 'input-mismatch', nodeId: scope.nodeId };
      }
      targets.push({
        canvasFilePath: fenceScope.canvasFilePath,
        nodeId: scope.nodeId,
        kind: scope.kind,
        runId: authoritativeRunId,
        inputKey: authoritativeInputKey,
        filePath: scope.filePath,
      });
    }
    const previous = await readCancellationFencesUnlocked(fenceScope);
    const now = Date.now();
    const entries = { ...(previous.entries || {}) };
    for (const target of targets) {
      entries[cancellationFenceKey(target.kind, target.nodeId, target.runId)] = {
        kind: target.kind,
        nodeId: target.nodeId,
        runId: target.runId,
        inputKey: target.inputKey,
        reason: cleanToken(args.reason, 120) || 'node-deleted',
        updatedAt: now,
      };
    }
    const currentTargetKeys = new Set(targets.map(target => (
      cancellationFenceKey(target.kind, target.nodeId, target.runId)
    )));
    const boundedEntries = Object.fromEntries(Object.entries(entries)
      .sort((a, b) => {
        const targetPriority = Number(currentTargetKeys.has(b[0])) - Number(currentTargetKeys.has(a[0]));
        return targetPriority || Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0);
      })
      .slice(0, MAX_CANCELLATION_FENCES));
    await atomicWrite(fenceScope.filePath, {
      version: VERSION,
      canvasFilePath: fenceScope.canvasFilePath,
      entries: boundedEntries,
      updatedAt: now,
    });
    return { fenced: true, targets };
  });
  if (!prepared.fenced) return prepared;

  // Abort canonical owners across renderer windows only after the fence commit,
  // and never while holding the ledger lock (a handler may be draining a
  // checkpoint lock in its finally path).
  const claimSettlements = prepared.targets.map(async target => {
    const claim = activeClaims.get(target.filePath);
    if (!claim || claim.runId !== target.runId) return true;
    try {
      claim.abort?.(Object.assign(new Error('Node deleted'), {
        name: 'AbortError',
        cancelCause: cleanToken(args.reason, 40) || 'marketplace-deleted',
      }));
    } catch (error) {
      logger.warn('[MarketplaceRecovery] Could not abort fenced claim:', error?.message || String(error));
    }
    let timeoutId;
    const settled = await Promise.race([
      claim.released.then(() => true),
      new Promise(resolve => { timeoutId = setTimeout(() => resolve(false), 30_000); }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    return settled;
  });
  const claimResults = await Promise.all(claimSettlements);

  const tombstoneWriter = typeof options.tombstoneWriter === 'function'
    ? options.tombstoneWriter
    : abandonMarketplaceRecoveryUnlocked;
  const cleanupErrors = [];
  for (const target of prepared.targets) {
    try {
      const result = await tombstoneWriter({
        canvasFilePath: target.canvasFilePath,
        nodeId: target.nodeId,
        kind: target.kind,
        runId: target.runId,
        inputKey: target.inputKey,
        reason: args.reason,
      });
      if (!result?.abandoned) cleanupErrors.push({ nodeId: target.nodeId, reason: result?.reason || 'not-abandoned' });
    } catch (error) {
      cleanupErrors.push({ nodeId: target.nodeId, reason: error?.message || String(error) });
    }
  }
  return {
    fenced: true,
    targetCount: prepared.targets.length,
    claimsSettled: claimResults.every(Boolean),
    cleanupErrors,
  };
}

async function withMarketplaceRecoveryReadLease(args, operation, { joinCapability = null } = {}) {
  // Every operation takes an actual refcounted read lease. The central canvas
  // gate recognizes a nested call from the same handleSafe sender and lets it
  // extend its existing ownership past a queued rebind writer. A standalone
  // call from another sender cannot merely observe an active Marketplace claim
  // and borrow it without a ref: it waits or owns its own lease, closing the
  // owner-release/rebind race.
  const lease = await acquireCanvasRecoveryRead(args?.canvasFilePath, { joinCapability });
  try {
    return await operation({ ...args, canvasFilePath: lease.canvasFilePath });
  } finally {
    lease.release();
  }
}

async function exactActiveClaimJoinCapability(args = {}) {
  const scope = await owner(args);
  const runId = cleanToken(args.runId);
  const inputKey = typeof args.inputKey === 'string' ? args.inputKey : null;
  if (!scope || !runId || inputKey === null) return null;
  const claim = activeClaims.get(scope.filePath);
  if (!claim || claim.runId !== runId) return null;
  if (claim.inputKey !== inputKey) return null;
  return claim.joinCapability || null;
}

async function exactBatchClaimJoinCapability(args = {}) {
  for (const requested of (Array.isArray(args.owners) ? args.owners : [])) {
    const capability = await exactActiveClaimJoinCapability({
      canvasFilePath: args.canvasFilePath,
      nodeId: requested?.nodeId,
      kind: requested?.kind,
      runId: requested?.runId,
      inputKey: requested?.inputKey,
    });
    if (capability) return capability;
  }
  return null;
}

export function beginMarketplaceRecovery(args = {}) {
  return withMarketplaceRecoveryReadLease(args, beginMarketplaceRecoveryUnlocked);
}

export function checkpointMarketplaceRecovery(args = {}) {
  return withMarketplaceRecoveryReadLease(args, checkpointMarketplaceRecoveryUnlocked);
}

export function peekMarketplaceRecovery(args = {}) {
  return withMarketplaceRecoveryReadLease(args, peekMarketplaceRecoveryUnlocked);
}

export function acknowledgeMarketplaceRecovery(args = {}) {
  return withMarketplaceRecoveryReadLease(args, acknowledgeMarketplaceRecoveryUnlocked);
}

export async function abandonMarketplaceRecovery(args = {}, options = {}) {
  const joinCapability = await exactActiveClaimJoinCapability(args);
  return withMarketplaceRecoveryReadLease(
    args,
    leasedArgs => abandonMarketplaceRecoveryUnlocked(leasedArgs, options),
    { joinCapability },
  );
}

export async function abandonMarketplaceRecoveryBatch(args = {}, options = {}) {
  const joinCapability = await exactBatchClaimJoinCapability(args);
  const lease = await acquireCanvasRecoveryRead(args?.canvasFilePath, { joinCapability });
  try {
    return await abandonMarketplaceRecoveryBatchUnlocked(
      { ...args, canvasFilePath: lease.canvasFilePath },
      options,
    );
  } finally {
    lease.release();
  }
}

function recoveryFilePrefix(canvasFilePath) {
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return path.join(
    path.dirname(canvasFilePath),
    `${base}.marketplace-recovery.${hash(canvasFilePath)}.`,
  );
}

function cancellationFencePathForRawCanvas(canvasFilePath) {
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return path.join(
    path.dirname(canvasFilePath),
    `${base}.marketplace-cancellation-fences.${hash(canvasFilePath)}.json`,
  );
}

async function readBoundedJsonFile(filePath) {
  return JSON.parse(await readRegularNoFollowUtf8(filePath));
}

async function fsyncDirectory(directoryPath) {
  const handle = await fs.promises.open(directoryPath, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Prepare Marketplace ownership migration while the caller holds the shared
 * old/new canvas exclusive lease. Preparation only writes private stage files;
 * `commit` publishes every new owner before removing any old owner, while
 * `rollback` restores the exact old records if a later store migration fails.
 */
export async function prepareCanvasRecoveryRebind(oldCanvasFilePath, newCanvasFilePath, options = {}) {
  const oldPath = cleanToken(oldCanvasFilePath, 32_768);
  const newPath = cleanToken(newCanvasFilePath, 32_768);
  if (!oldPath || !newPath || !path.isAbsolute(oldPath) || !path.isAbsolute(newPath)) {
    return { success: false, reason: 'invalid-canvas-path' };
  }
  const oldResolved = await fs.promises.realpath(path.resolve(oldPath)).catch(() => path.resolve(oldPath));
  const newResolved = await fs.promises.realpath(path.resolve(newPath)).catch(() => path.resolve(newPath));
  if (oldResolved === newResolved) {
    return {
      success: true,
      migratedCount: 0,
      commit: async () => ({ success: true, migratedCount: 0 }),
      rollback: async () => ({ success: true }),
    };
  }

  const oldPrefix = recoveryFilePrefix(oldResolved);
  const newPrefix = recoveryFilePrefix(newResolved);
  const oldFencePath = cancellationFencePathForRawCanvas(oldResolved);
  const newFencePath = cancellationFencePathForRawCanvas(newResolved);
  const preparedFiles = [];
  const stageNonce = `${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
  // Narrow injection seams let the crash-convergence tests model an unlink or
  // directory-fsync that reports failure after it may already have taken
  // effect. Production callers deliberately use the native implementations.
  const removeOldSource = typeof options.removeOldSource === 'function'
    ? options.removeOldSource
    : filePath => fs.promises.unlink(filePath);
  const syncDestinationDirectory = typeof options.syncDestinationDirectory === 'function'
    ? options.syncDestinationDirectory
    : fsyncDirectory;
  const syncSourceDirectory = typeof options.syncSourceDirectory === 'function'
    ? options.syncSourceDirectory
    : fsyncDirectory;
  const restoreOldSource = typeof options.restoreOldSource === 'function'
    ? options.restoreOldSource
    : (filePath, value) => atomicWrite(filePath, value);
  const removePublishedTarget = typeof options.removePublishedTarget === 'function'
    ? options.removePublishedTarget
    : filePath => fs.promises.unlink(filePath);

  try {
    const entries = await fs.promises.readdir(path.dirname(oldResolved), { withFileTypes: true });
    const recoveryNames = entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink())
      .map(entry => path.join(path.dirname(oldResolved), entry.name))
      .filter(filePath => filePath.startsWith(oldPrefix) && filePath.endsWith('.json'));
    if (await fs.promises.lstat(oldFencePath).then(stat => stat.isFile() && !stat.isSymbolicLink()).catch(() => false)) {
      recoveryNames.push(oldFencePath);
    }

    for (const sourcePath of recoveryNames) {
      const value = await readBoundedJsonFile(sourcePath);
      let targetPath;
      let nextValue;
      if (sourcePath === oldFencePath) {
        if (value?.version !== VERSION || value?.canvasFilePath !== oldResolved || !value.entries || typeof value.entries !== 'object') {
          throw new Error('Marketplace cancellation ledger does not belong to the canvas being rebound.');
        }
        targetPath = newFencePath;
        nextValue = { ...value, canvasFilePath: newResolved };
      } else {
        const nodeId = cleanToken(value?.nodeId);
        if (
          value?.version !== VERSION
          || value?.canvasFilePath !== oldResolved
          || !nodeId
          || !KINDS.has(value?.kind)
          || sourcePath !== `${oldPrefix}${hash(nodeId)}.json`
        ) {
          throw new Error(`Marketplace recovery owner failed validation: ${path.basename(sourcePath)}`);
        }
        targetPath = `${newPrefix}${hash(nodeId)}.json`;
        nextValue = { ...value, canvasFilePath: newResolved };
      }

      const targetExists = await fs.promises.lstat(targetPath).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      let existingEqual = false;
      if (targetExists) {
        if (!targetExists.isFile() || targetExists.isSymbolicLink() || targetExists.size > MAX_JSON_BYTES) {
          throw new Error(`Marketplace recovery rebind target is unsafe: ${path.basename(targetPath)}`);
        }
        const existing = await readBoundedJsonFile(targetPath);
        existingEqual = JSON.stringify(existing) === JSON.stringify(nextValue);
        if (!existingEqual) throw new Error(`Marketplace recovery rebind target already exists: ${path.basename(targetPath)}`);
      }

      const stagePath = existingEqual ? null : `${targetPath}.${stageNonce}.prepared`;
      if (stagePath) await atomicWrite(stagePath, nextValue);
      preparedFiles.push({
        sourcePath,
        targetPath,
        stagePath,
        value,
        nextValue,
        existingEqual,
        targetCreated: false,
        oldRetired: false,
        oldRemoved: false,
      });
    }

    // The shared exclusive gate drains claim-held read leases. Await any legacy
    // short store tail as an additional fence before capturing map keys.
    const matchingTails = [...tails.entries()]
      .filter(([filePath]) => filePath === oldFencePath || filePath.startsWith(oldPrefix))
      .map(([, tail]) => tail);
    await Promise.all(matchingTails);

    const mapMoves = [];
    for (const [oldKey, record] of activeClaims) {
      if (!oldKey.startsWith(oldPrefix)) continue;
      const newKey = `${newPrefix}${oldKey.slice(oldPrefix.length)}`;
      if (activeClaims.has(newKey) && activeClaims.get(newKey) !== record) {
        throw new Error('Marketplace recovery claim target is already occupied.');
      }
      mapMoves.push({ map: activeClaims, oldKey, newKey, value: record });
    }
    for (const [oldKey, tail] of tails) {
      if (oldKey !== oldFencePath && !oldKey.startsWith(oldPrefix)) continue;
      const newKey = oldKey === oldFencePath
        ? newFencePath
        : `${newPrefix}${oldKey.slice(oldPrefix.length)}`;
      if (tails.has(newKey) && tails.get(newKey) !== tail) {
        throw new Error('Marketplace recovery lock target is already occupied.');
      }
      mapMoves.push({ map: tails, oldKey, newKey, value: tail });
    }
    const attemptMoves = [...automaticAttempts]
      .filter(key => key.startsWith(oldPrefix))
      .map(oldKey => ({
        oldKey,
        newKey: `${newPrefix}${oldKey.slice(oldPrefix.length)}`,
      }));

    let committed = false;
    let destinationDurable = false;
    let rolledBack = false;
    let commitResult = null;
    let rollbackResult = null;
    const sourceDirectories = [...new Set(preparedFiles.map(file => path.dirname(file.sourcePath)))];
    const targetDirectories = [...new Set(preparedFiles.map(file => path.dirname(file.targetPath)))];
    const retiredRecord = (file, reason) => (
      file.sourcePath === oldFencePath
        ? null
        : {
            version: VERSION,
            kind: file.value.kind,
            status: 'completed',
            canvasFilePath: reason === 'canvas-path-rebind-rolled-back' ? newResolved : oldResolved,
            nodeId: file.value.nodeId,
            runId: file.value.runId,
            inputKey: file.value.inputKey,
            reason,
            migratedTo: reason === 'canvas-path-rebound' ? newResolved : oldResolved,
            createdAt: file.value.createdAt || Date.now(),
            updatedAt: Date.now(),
          }
    );
    const rollback = async () => {
      if (rolledBack) return rollbackResult || { success: true };

      // If publication reached its durable boundary, restore *every* old
      // owner and fsync the source directories before touching any destination
      // record. A partial source restore must never be followed by deleting the
      // only known-good destination copy.
      if (destinationDurable) {
        try {
          for (const file of preparedFiles) {
            await restoreOldSource(file.sourcePath, file.value);
          }
          await Promise.all(sourceDirectories.map(directoryPath => fsyncDirectory(directoryPath)));
        } catch (error) {
          // A failing write can report an error after its rename already took
          // effect. Retire every possible old owner, not merely the writes that
          // returned success, while keeping every durable destination record
          // authoritative.
          for (const file of preparedFiles) {
            const retired = retiredRecord(file, 'canvas-path-rebound');
            if (retired) await atomicWrite(file.sourcePath, retired).catch(() => {});
          }
          await Promise.all(sourceDirectories.map(directoryPath => fsyncDirectory(directoryPath).catch(() => {})));
          rollbackResult = {
            success: false,
            reason: error?.message || String(error),
            destinationPreserved: true,
          };
          return rollbackResult;
        }
      }

      for (const move of mapMoves) {
        if (move.map.get(move.newKey) === move.value) move.map.delete(move.newKey);
        if (!move.map.has(move.oldKey)) move.map.set(move.oldKey, move.value);
      }
      for (const move of attemptMoves) {
        automaticAttempts.delete(move.newKey);
        automaticAttempts.add(move.oldKey);
      }

      const cleanupErrors = [];
      for (const file of preparedFiles) {
        if (file.targetCreated) {
          // Make a target that survives an unlink/fsync failure inert before
          // attempting deletion. The restored source remains authoritative.
          const retired = retiredRecord(file, 'canvas-path-rebind-rolled-back');
          if (retired) {
            try { await atomicWrite(file.targetPath, retired); } catch (error) {
              cleanupErrors.push({ filePath: file.targetPath, operation: 'retire-target', reason: error?.message || String(error) });
            }
          }
          try {
            await removePublishedTarget(file.targetPath);
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              cleanupErrors.push({ filePath: file.targetPath, operation: 'remove-target', reason: error?.message || String(error) });
            }
          }
        }
        if (file.stagePath) {
          await fs.promises.unlink(file.stagePath).catch(error => {
            if (error?.code !== 'ENOENT') {
              cleanupErrors.push({ filePath: file.stagePath, operation: 'remove-stage', reason: error?.message || String(error) });
            }
          });
        }
      }
      await Promise.all(targetDirectories.map(async directoryPath => {
        try { await fsyncDirectory(directoryPath); } catch (error) {
          cleanupErrors.push({ filePath: directoryPath, operation: 'fsync-target-directory', reason: error?.message || String(error) });
        }
      }));
      rolledBack = true;
      committed = false;
      rollbackResult = cleanupErrors.length > 0
        ? { success: false, cleanupErrors, destinationPreserved: false }
        : { success: true };
      return rollbackResult;
    };

    const commit = async () => {
      if (rolledBack) return { success: false, reason: 'rolled-back' };
      if (committed) return commitResult || { success: true, migratedCount: preparedFiles.length };
      try {
        for (const file of preparedFiles) {
          if (file.existingEqual) continue;
          // Hard-link publication is atomic and refuses to overwrite a target
          // that appeared after preparation.
          await fs.promises.link(file.stagePath, file.targetPath);
          file.targetCreated = true;
          await fs.promises.unlink(file.stagePath);
        }
        await Promise.all(targetDirectories.map(directoryPath => syncDestinationDirectory(directoryPath)));
      } catch (error) {
        const rollbackState = await rollback().catch(rollbackError => {
          logger.error('[MarketplaceRecovery] Rebind rollback failed:', rollbackError?.message || String(rollbackError));
          return { success: false, reason: rollbackError?.message || String(rollbackError) };
        });
        return {
          success: false,
          reason: error?.message || String(error),
          rollback: rollbackState,
        };
      }

      // This is the point of no return. Every destination record has been
      // published and its parent metadata fsynced. Cleanup errors from here on
      // must converge on the destination; rolling it back could lose the only
      // durable copy when unlink already took effect despite throwing.
      destinationDurable = true;
      committed = true;
      for (const move of mapMoves) {
        if (move.map.get(move.oldKey) === move.value) move.map.delete(move.oldKey);
        move.map.set(move.newKey, move.value);
      }
      for (const move of attemptMoves) {
        automaticAttempts.delete(move.oldKey);
        automaticAttempts.add(move.newKey);
      }

      const cleanupErrors = [];
      for (const file of preparedFiles) {
        // If unlink or its directory fsync fails, a crash may expose the old
        // directory entry again. First replace active sidecars with a durable
        // inert receipt; cancellation ledgers are already safe if retained.
        const retired = retiredRecord(file, 'canvas-path-rebound');
        if (retired) {
          try {
            await atomicWrite(file.sourcePath, retired);
            file.oldRetired = true;
          } catch (error) {
            cleanupErrors.push({ filePath: file.sourcePath, operation: 'retire-source', reason: error?.message || String(error) });
          }
        }
        try {
          await removeOldSource(file.sourcePath);
          file.oldRemoved = true;
        } catch (error) {
          if (error?.code === 'ENOENT') {
            file.oldRemoved = true;
          } else {
            cleanupErrors.push({ filePath: file.sourcePath, operation: 'remove-source', reason: error?.message || String(error) });
          }
        }
      }
      await Promise.all(sourceDirectories.map(async directoryPath => {
        try { await syncSourceDirectory(directoryPath); } catch (error) {
          cleanupErrors.push({ filePath: directoryPath, operation: 'fsync-source-directory', reason: error?.message || String(error) });
        }
      }));
      commitResult = {
        success: true,
        migratedCount: preparedFiles.length,
        destinationDurable: true,
        cleanupPending: cleanupErrors.length > 0,
        cleanupErrors,
      };
      if (cleanupErrors.length > 0) {
        logger.warn('[MarketplaceRecovery] Rebind destination committed with deferred source cleanup:', cleanupErrors);
      }
      return commitResult;
    };

    return {
      success: true,
      migratedCount: preparedFiles.length,
      commit,
      rollback,
    };
  } catch (error) {
    await Promise.all(preparedFiles.map(file => (
      file.stagePath ? fs.promises.unlink(file.stagePath).catch(() => {}) : null
    )));
    return { success: false, reason: error?.message || String(error) };
  }
}

export const __marketplaceRecoveryStoreForTests = {
  VERSION,
  owner,
  atomicWrite,
  readRegularNoFollowUtf8,
  activeClaims,
  automaticAttempts,
  cancellationFenceOwner,
  PROCESS_EPOCH,
  withMarketplaceRecoveryReadLease,
};
