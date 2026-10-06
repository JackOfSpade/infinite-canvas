/**
 * Process-wide execution lease for a Job Board transaction.
 *
 * Renderer module queues are window-local. Two windows can therefore hydrate
 * the same saved Board plan and both try to drive its children. This lease is
 * deliberately process-local (a process crash releases it) and keyed by the
 * alias-resolved canvas + Board owner. The exact boardRunId is retained as the
 * execution identity so a stale renderer can never acquire over a newer run.
 */
import crypto from 'node:crypto';
import { acquireCanvasRecoveryRead, resolveCanvasRecoveryPath } from './canvasRecoveryPaths.js';

const activeClaims = new Map();
const automaticAttempts = new Set();
const senderClaims = new WeakMap();
const hookedSenders = new WeakSet();

function token(value, max = 400) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= max ? normalized : null;
}

function executionOwner(args = {}) {
  const canvasFilePath = resolveCanvasRecoveryPath(args.canvasFilePath);
  const nodeId = token(args.nodeId);
  const boardRunId = token(args.boardRunId);
  if (!canvasFilePath || !nodeId || !boardRunId) return null;
  return {
    canvasFilePath,
    nodeId,
    boardRunId,
    ownerKey: `${canvasFilePath}\u0000${nodeId}`,
  };
}

function removeSenderClaim(sender, ownerKey) {
  const owned = senderClaims.get(sender);
  owned?.delete(ownerKey);
  if (owned?.size === 0) senderClaims.delete(sender);
}

function releaseRecord(ownerKey, record) {
  if (activeClaims.get(ownerKey) !== record) return false;
  activeClaims.delete(ownerKey);
  removeSenderClaim(record.sender, ownerKey);
  record.recoveryLease?.release?.();
  record.resolveReleased();
  return true;
}

function hookSender(sender) {
  if (!sender || hookedSenders.has(sender)) return;
  hookedSenders.add(sender);
  sender.once?.('destroyed', () => {
    const owned = senderClaims.get(sender);
    if (!owned) return;
    for (const ownerKey of [...owned]) {
      const record = activeClaims.get(ownerKey);
      if (record?.sender === sender) releaseRecord(ownerKey, record);
    }
    senderClaims.delete(sender);
  });
}

/**
 * Claim one exact Board transaction. `operation` separates the safe hidden
 * provider-only pass from mounted Board orchestration for one-shot admission:
 * the latter may run after the former releases, while two startup renderers
 * can never both run the same phase.
 */
export async function claimJobBoardRunExecution(args = {}, { sender = null } = {}) {
  const recoveryLease = await acquireCanvasRecoveryRead(args.canvasFilePath, { owner: sender });
  const owner = recoveryLease.canvasFilePath
    ? executionOwner({ ...args, canvasFilePath: recoveryLease.canvasFilePath })
    : null;
  const operation = token(args.operation, 120) || 'board-orchestration';
  if (!owner || !sender) {
    recoveryLease.release();
    return { ok: false, reason: 'missing-ownership' };
  }

  const attemptKey = `${owner.ownerKey}\u0000${owner.boardRunId}\u0000${operation}`;
  if (args.autoResume === true && automaticAttempts.has(attemptKey)) {
    recoveryLease.release();
    return { ok: false, attempted: true, reason: 'automatic-attempted' };
  }

  const held = activeClaims.get(owner.ownerKey);
  if (held) {
    if (args.waitForRelease === true && held.boardRunId === owner.boardRunId) {
      recoveryLease.release();
      await held.released;
      return claimJobBoardRunExecution({ ...args, canvasFilePath: owner.canvasFilePath }, { sender });
    }
    recoveryLease.release();
    return {
      ok: false,
      busy: true,
      reason: held.boardRunId === owner.boardRunId ? 'already-running' : 'owner-busy',
    };
  }

  let resolveReleased;
  const released = new Promise(resolve => { resolveReleased = resolve; });
  const claimToken = crypto.randomBytes(24).toString('hex');
  const record = {
    sender,
    boardRunId: owner.boardRunId,
    operation,
    claimToken,
    released,
    resolveReleased,
    recoveryLease,
  };
  if (args.autoResume === true) automaticAttempts.add(attemptKey);
  activeClaims.set(owner.ownerKey, record);
  const owned = senderClaims.get(sender) || new Set();
  owned.add(owner.ownerKey);
  senderClaims.set(sender, owned);
  hookSender(sender);
  return {
    ok: true,
    claimToken,
    canvasFilePath: owner.canvasFilePath,
    nodeId: owner.nodeId,
    boardRunId: owner.boardRunId,
    operation,
  };
}

export function releaseJobBoardRunExecution(args = {}, { sender = null } = {}) {
  const owner = executionOwner(args);
  const claimToken = token(args.claimToken, 128);
  if (!owner || !sender || !claimToken) return false;
  const record = activeClaims.get(owner.ownerKey);
  if (
    !record
    || record.sender !== sender
    || record.boardRunId !== owner.boardRunId
    || record.claimToken !== claimToken
  ) return false;
  return releaseRecord(owner.ownerKey, record);
}

/** Admission fence for provider work performed under an already-claimed Board. */
export function validateJobBoardRunExecution(args = {}, { sender = null } = {}) {
  const owner = executionOwner(args);
  const claimToken = token(args.claimToken, 128);
  const operation = token(args.operation, 120);
  if (!owner || !sender || !claimToken) return false;
  const record = activeClaims.get(owner.ownerKey);
  return !!record
    && record.sender === sender
    && record.boardRunId === owner.boardRunId
    && record.claimToken === claimToken
    && (!operation || record.operation === operation);
}

export const __jobBoardRunLeaseForTests = {
  activeClaims,
  automaticAttempts,
};
