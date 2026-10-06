/**
 * Main-process ownership gate for recovery sidecars keyed by a canvas path.
 *
 * Normal recovery operations take a short read lease and receive the current
 * alias-resolved path. A Save As/Finder rename takes exclusive leases for both
 * spellings, draining every in-flight reader before store migration. Aliases
 * are process-local by design; after restart only the rekeyed sidecars at the
 * adopted path are discoverable.
 */
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentIpcRequestContext } from './ipcUtils.js';

const aliases = new Map();
const gates = new Map();
const recoveryOwnerStorage = new AsyncLocalStorage();

function rawPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return path.resolve(value); } catch { return null; }
}

export function resolveCanvasRecoveryPath(value) {
  let resolved = rawPath(value);
  if (!resolved) return null;
  const seen = new Set();
  while (aliases.has(resolved) && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = aliases.get(resolved);
  }
  return resolved;
}

export function rawCanvasRecoveryPath(value) {
  return rawPath(value);
}

function gateFor(key) {
  let gate = gates.get(key);
  if (!gate) {
    gate = {
      readers: 0,
      readerOwners: new Map(),
      joinCapabilities: new Set(),
      controlReaders: 0,
      writers: 0,
      exclusiveTail: Promise.resolve(),
      writerBarrier: null,
      releaseWriterBarrier: null,
      drained: null,
      releaseDrained: null,
    };
    gates.set(key, gate);
  }
  return gate;
}

function recoveryReadOwner(explicitOwner = null) {
  if (explicitOwner) return explicitOwner;
  const scopedOwner = recoveryOwnerStorage.getStore();
  if (scopedOwner) return scopedOwner;
  // Nested store calls run inside the same handleSafe AsyncLocalStorage scope.
  // A queued writer must not block that existing reader from taking another
  // lease, or it deadlocks waiting for the outer workflow to finish.
  return getCurrentIpcRequestContext()?.sender || null;
}

/**
 * Extend a sender-owned recovery read across direct IPC handlers that cannot
 * use handleSafe (for example, a Stop handler that aborts its own node task).
 * Nested store APIs then see the same owner even after a writer queues.
 */
export function withCanvasRecoveryOwner(owner, callback) {
  return owner ? recoveryOwnerStorage.run(owner, callback) : callback();
}

async function acquireRead(key, owner = null, joinCapability = null) {
  for (;;) {
    const gate = gateFor(key);
    const ownsRead = !!owner && gate.readerOwners.has(owner);
    // Exact cancellation may borrow only the unforgeable capability of a
    // still-live reader. This is intentionally not a boolean "join any"
    // escape hatch: an unrelated sender cannot bypass a queued Save As merely
    // because some workflow happens to be reading the same canvas.
    const joinsExistingReader = !!gate.writerBarrier
      && !!joinCapability
      && gate.joinCapabilities.has(joinCapability);
    if (gate.writerBarrier && !ownsRead && !joinsExistingReader) await gate.writerBarrier;
    const controlRead = !!gate.writerBarrier && !ownsRead && joinsExistingReader;
    const issuedCapability = controlRead ? null : Object.freeze({});
    gate.readers += 1;
    if (controlRead) gate.controlReaders += 1;
    if (owner) gate.readerOwners.set(owner, (gate.readerOwners.get(owner) || 0) + 1);
    if (issuedCapability) gate.joinCapabilities.add(issuedCapability);
    // Re-check after incrementing. Existing owners and a still-valid exact
    // cancellation capability are deliberately allowed through; any other
    // reader undoes its tentative ref and waits.
    if (!gate.writerBarrier || ownsRead || controlRead) {
      return {
        joinCapability: issuedCapability,
        release: () => {
          gate.readers -= 1;
          if (controlRead) gate.controlReaders -= 1;
          if (issuedCapability) gate.joinCapabilities.delete(issuedCapability);
          if (owner) {
            const remaining = (gate.readerOwners.get(owner) || 1) - 1;
            if (remaining > 0) gate.readerOwners.set(owner, remaining);
            else gate.readerOwners.delete(owner);
          }
          if (gate.readers === 0) gate.releaseDrained?.();
        },
      };
    }
    gate.readers -= 1;
    if (controlRead) gate.controlReaders -= 1;
    if (issuedCapability) gate.joinCapabilities.delete(issuedCapability);
    if (owner) {
      const remaining = (gate.readerOwners.get(owner) || 1) - 1;
      if (remaining > 0) gate.readerOwners.set(owner, remaining);
      else gate.readerOwners.delete(owner);
    }
    if (gate.readers === 0) gate.releaseDrained?.();
  }
}

export async function acquireCanvasRecoveryRead(canvasFilePath, { owner = null, joinCapability = null } = {}) {
  // Resolve, lease, then resolve again: if a rebind installs an alias while a
  // reader was waiting, it retries against the adopted owner rather than using
  // a stale old-path filename.
  for (;;) {
    const ownerPath = resolveCanvasRecoveryPath(canvasFilePath);
    if (!ownerPath) return { canvasFilePath: null, release: () => {} };
    const acquired = await acquireRead(ownerPath, recoveryReadOwner(owner), joinCapability);
    const current = resolveCanvasRecoveryPath(canvasFilePath);
    if (current === ownerPath) {
      return { canvasFilePath: ownerPath, release: acquired.release, joinCapability: acquired.joinCapability };
    }
    acquired.release();
  }
}

export async function withCanvasRecoveryRead(canvasFilePath, fn, { owner = null, joinCapability = null } = {}) {
  const lease = await acquireCanvasRecoveryRead(canvasFilePath, { owner, joinCapability });
  try { return await fn(lease.canvasFilePath); } finally { lease.release(); }
}

function reserveExclusive(key) {
  const gate = gateFor(key);
  const previous = gate.exclusiveTail;
  let releaseTail;
  const tail = new Promise(resolve => { releaseTail = resolve; });
  gate.exclusiveTail = previous.then(() => tail);
  if (gate.writers++ === 0) {
    gate.writerBarrier = new Promise(resolve => { gate.releaseWriterBarrier = resolve; });
  }
  return {
    async waitForTurnAndDrain() {
      await previous;
      if (gate.readers > 0) {
        gate.drained = new Promise(resolve => { gate.releaseDrained = resolve; });
        await gate.drained;
      }
    },
    release() {
      gate.releaseDrained = null;
      gate.drained = null;
      gate.writers -= 1;
      if (gate.writers === 0) {
        gate.releaseWriterBarrier?.();
        gate.releaseWriterBarrier = null;
        gate.writerBarrier = null;
      }
      releaseTail();
    },
  };
}

/** Exclusive old/new owner transaction. The callback installs aliases only after durable commits. */
export async function withCanvasRecoveryRebind(oldCanvasFilePath, newCanvasFilePath, fn) {
  const oldRawPath = rawPath(oldCanvasFilePath);
  const newRawPath = rawPath(newCanvasFilePath);
  // A stale in-flight handler may still pass the pre-rename spelling. Lock and
  // migrate its current alias owner rather than opening a second independent
  // transaction keyed by the obsolete hash.
  const oldPath = oldRawPath ? resolveCanvasRecoveryPath(oldRawPath) : null;
  const newPath = newRawPath ? resolveCanvasRecoveryPath(newRawPath) : null;
  if (!oldPath || !newPath) return { success: false, reason: 'invalid-canvas-path' };
  if (oldPath === newPath) return fn({ oldPath, newPath, installAlias: () => {} });
  const keys = [...new Set([oldPath, newPath])].sort();
  // Reserve every spelling before awaiting any old reader. Otherwise a rebind
  // waiting on the first (sorted) path leaves the other path open for a new
  // Board/provider claim, defeating cross-path exclusivity during Save As.
  const reservations = keys.map(key => reserveExclusive(key));
  try {
    for (const reservation of reservations) await reservation.waitForTurnAndDrain();
    return await fn({
      oldPath,
      newPath,
      installAlias: () => {
        aliases.set(oldPath, newPath);
        for (const [alias, target] of aliases) {
          if (target === oldPath && alias !== oldPath) aliases.set(alias, newPath);
        }
        for (const [alias, target] of aliases) if (alias === target) aliases.delete(alias);
      },
    });
  } finally {
    for (const reservation of reservations.reverse()) reservation.release();
  }
}

export const __canvasRecoveryPathsForTests = { aliases, gates, recoveryOwnerStorage };
