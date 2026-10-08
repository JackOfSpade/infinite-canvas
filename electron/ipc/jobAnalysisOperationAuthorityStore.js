/**
 * Durable admission authority for every write in a Job Search analysis.
 *
 * Renderer capabilities are useful for promptly stopping UI work, but cannot
 * survive a renderer reload or process restart.  This sidecar is the host
 * authority: one canonical canvas + hub has exactly one current receipt.
 * Revoke writes a tombstone rather than removing it, so an old artifact can
 * never become valid again merely because the app was restarted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getJobAnalysisPaths } from './jobAnalysisPaths.js';
import { acquireCanvasRecoveryRead } from './canvasRecoveryPaths.js';

const VERSION = 1;
const MAX_IDENTIFIER = 200;
// The authority record is a tiny capability ledger. Treat it as a bounded,
// no-follow security boundary rather than letting an attacker-controlled
// sidecar path stream an arbitrary file into the main process.
const MAX_AUTHORITY_BYTES = 256 * 1024;
// Three recovery generations, current, and the bounded 48 checkpoint scan
// fit without making an otherwise-valid authority record unreadable.
const MAX_PUBLICATIONS = 64;
// Snapshot publication bytes can be substantially larger than the authority
// ledger, but they are still bounded by the writer/rebind contract.  Never use
// readFile here: this verifier runs on paths beside a user-controlled canvas.
const MAX_PUBLICATION_ARTIFACT_BYTES = 64 * 1024 * 1024;
// These operations reuse a durable run, recovered artifact, or continuation
// rather than beginning a fresh analysis. They must name exactly the prior
// receipt; `kind === 'resume'` was too narrow for the real operation dialect.
const LINEAGE_KINDS = new Set([
  'resume',
  'crash-resume',
  'resume-saved-scrape',
  'resolved-source-continuation',
  'usajobs-late-append',
  'reanalyze-saved-jobs',
  'manual-ai-resume',
]);
const tails = new Map();

function identifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_IDENTIFIER
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

function semanticBase(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = identifier(value.kind || value.disposition);
  const careerSnapshotId = typeof value.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(value.careerSnapshotId)
    ? value.careerSnapshotId
    : null;
  const runId = value.runId == null ? null : identifier(value.runId);
  const revision = value.analysisRevisionId == null ? null : identifier(value.analysisRevisionId);
  const fingerprint = value.fingerprint == null ? null : identifier(value.fingerprint);
  const continuationId = value.continuationId == null ? null : identifier(value.continuationId);
  const sourceArtifactFingerprint = value.sourceArtifactFingerprint == null ? null : identifier(value.sourceArtifactFingerprint);
  if (!kind || !careerSnapshotId || (value.runId != null && !runId) || (value.analysisRevisionId != null && !revision)
    || (value.fingerprint != null && !fingerprint)) return null;
  if ((value.continuationId != null && !continuationId) || (value.sourceArtifactFingerprint != null && !sourceArtifactFingerprint)) return null;
  return { kind, careerSnapshotId, runId, analysisRevisionId: revision, fingerprint, continuationId, sourceArtifactFingerprint };
}

function scope(canvasFilePath, hubId) {
  const owner = identifier(hubId);
  if (!owner || typeof canvasFilePath !== 'string' || !canvasFilePath.trim()) return null;
  const paths = getJobAnalysisPaths(canvasFilePath, null, owner);
  if (!paths.canvasPath || !paths.ownerNamespace) return null;
  return {
    canvasFilePath: paths.canvasPath,
    hubId: owner,
    // Keep this alongside the owner-scoped snapshot bundle, without exposing
    // either a source filename or hub id in a friendly public artifact name.
    authorityPath: paths.operationAuthorityPath,
    paths,
  };
}

function artifactPathForSlot(scopeValue, slot) {
  if (slot === 'current') return scopeValue.paths.jsonPath;
  const success = slot.match(/^success:([1-3])$/);
  return success ? scopeValue.paths.lastSuccessJsonPaths?.[Number(success[1]) - 1] || null : null;
}

async function mapMatchesDisk(scopeValue, map) {
  const entries = Object.values(map || {}).filter(item => ['current', 'success:1', 'success:2', 'success:3'].includes(item.slot));
  if (entries.length === 0) return false;
  for (const item of entries) {
    const filePath = artifactPathForSlot(scopeValue, item.slot);
    try {
      const bytes = await readStableRegularPublication(filePath);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.digest) return false;
    } catch { return false; }
  }
  return true;
}

/** Read a publication through one descriptor, refusing links, devices/FIFOs,
 * oversize files, and a path that was swapped while it was being verified. */
async function readStableRegularPublication(filePath) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlocking = fs.constants.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) {
    throw new Error('safe descriptor flags unavailable');
  }
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || before.size > MAX_PUBLICATION_ARTIFACT_BYTES) {
      throw new Error('unsafe publication artifact');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    // The descriptor protects the bytes read, but a path swap after open could
    // otherwise let us promote a map whose pathname now addresses different
    // bytes.  Re-stat the pathname after the read and require it to remain the
    // same regular non-link file as the descriptor.
    const pathname = await fs.promises.lstat(filePath);
    if (!pathname.isFile() || pathname.isSymbolicLink()
      || pathname.size !== before.size || pathname.dev !== before.dev || pathname.ino !== before.ino
      || !after.isFile() || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || bytes.length !== before.size) {
      throw new Error('publication artifact changed while read');
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function canonical(value) {
  return JSON.stringify(value);
}

function sameBase(left, right) {
  return !!left && !!right && left.kind === right.kind && left.careerSnapshotId === right.careerSnapshotId
    && left.runId === right.runId && left.analysisRevisionId === right.analysisRevisionId
    && left.fingerprint === right.fingerprint && left.continuationId === right.continuationId
    && left.sourceArtifactFingerprint === right.sourceArtifactFingerprint;
}

function requiresPredecessor(base) {
  return LINEAGE_KINDS.has(base?.kind);
}

function receipt(value) {
  const operationId = identifier(value?.operationId);
  const base = semanticBase(value?.semanticBase);
  return operationId && base && Number.isSafeInteger(value?.revision) && value.revision > 0
    ? { operationId, semanticBase: base, revision: value.revision }
    : null;
}
function publicReceipt(value) {
  return receipt(value);
}

function sameReceipt(left, right) {
  const a = receipt(left);
  const b = receipt(right);
  return !!a && !!b && a.operationId === b.operationId && a.revision === b.revision
    && sameBase(a.semanticBase, b.semanticBase);
}

function publication(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slot = typeof value.slot === 'string' && /^(?:current|success:[1-3]|checkpoint:[a-f0-9]{24})$/.test(value.slot)
    ? value.slot
    : null;
  const digest = typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest) ? value.digest : null;
  const operation = receipt(value.receipt);
  return slot && digest && operation ? { slot, digest, receipt: operation } : null;
}

function publications(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_PUBLICATIONS) return null;
  const output = {};
  for (const [slot, item] of entries) {
    const normalized = publication({ ...item, slot });
    if (!normalized) return null;
    output[slot] = normalized;
  }
  return output;
}

function validRecord(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION
    || value.canvasFilePath !== expected.canvasFilePath || value.hubId !== expected.hubId
    || !identifier(value.operationId) || !semanticBase(value.semanticBase)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !['active', 'revoked'].includes(value.status)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
  const published = publications(value.publications);
  const pendingPublications = value.pendingPublications == null ? null : publications(value.pendingPublications);
  const predecessor = value.predecessor == null ? null : receipt(value.predecessor);
  // A malformed duplicate is fail-closed rather than silently allowing an
  // attacker-controlled unbounded/ambiguous publication history.
  if (published == null || (value.pendingPublications != null && pendingPublications == null)
    || (value.predecessor != null && !predecessor)) return null;
  return {
    version: VERSION,
    canvasFilePath: expected.canvasFilePath,
    hubId: expected.hubId,
    operationId: value.operationId,
    semanticBase: semanticBase(value.semanticBase),
    revision: value.revision,
    status: value.status,
    updatedAt: value.updatedAt,
    publications: published,
    pendingPublications,
    predecessor,
  };
}

async function atomicWrite(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, 'w', 0o600);
    try { await handle.writeFile(`${canonical(value)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.promises.rename(temporary, filePath);
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

async function readState(scopeValue) {
  let handle = null;
  try {
    const initial = await fs.promises.lstat(scopeValue.authorityPath);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_AUTHORITY_BYTES) return { record: null, invalid: true };
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(scopeValue.authorityPath, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES) return { record: null, invalid: true };
    const raw = await handle.readFile({ encoding: 'utf8' });
    const record = validRecord(JSON.parse(raw), scopeValue);
    return record ? { record, invalid: false } : { record: null, invalid: true };
  } catch (error) {
    return error?.code === 'ENOENT' ? { record: null, invalid: false, missing: true } : { record: null, invalid: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function withLock(scopeValue, fn) {
  const key = scopeValue.authorityPath;
  const prior = tails.get(key) || Promise.resolve();
  const result = prior.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  tails.set(key, tail);
  void tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
  return result;
}

// Save As/rename owns a recovery rebind lease. Every authority admission and
// publication read joins that lease so it cannot address an old sidecar while
// rebind is atomically moving its artifact namespace.
async function withRecoveryScope(canvasFilePath, hubId, callback) {
  if (typeof canvasFilePath !== 'string' || !canvasFilePath.trim()) return callback(scope(canvasFilePath, hubId));
  const lease = await acquireCanvasRecoveryRead(canvasFilePath);
  try { return await callback(scope(lease.canvasFilePath || canvasFilePath, hubId)); }
  finally { lease.release(); }
}

/** Main-process admission boundary. A newer claim wins even after restart. */
export async function claimJobAnalysisOperationAuthority({ canvasFilePath, hubId, operationId, semanticBase: rawBase, expectedRevision = null, predecessor = null } = {}) {
  const operation = identifier(operationId);
  const base = semanticBase(rawBase);
  const requestedPredecessor = predecessor == null ? null : receipt(predecessor);
  if (!operation || !base || (predecessor != null && !requestedPredecessor)
    || (expectedRevision != null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) return { admitted: false, reason: 'invalid-operation-authority' };
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return { admitted: false, reason: 'invalid-operation-authority' };
    return withLock(scopeValue, async () => {
    const priorState = await readState(scopeValue);
    if (priorState.invalid) return { admitted: false, reason: 'invalid-operation-authority-record' };
    const prior = priorState.record;
    if (prior?.operationId === operation) {
      if (!sameBase(prior.semanticBase, base)) return { admitted: false, reason: 'operation-id-conflict' };
      // An idempotent resume claim is still a lineage assertion. Do not let an
      // operation-id replay omit or substitute the immediate predecessor.
      if (requiresPredecessor(base) && (!requestedPredecessor || !sameReceipt(prior.predecessor, requestedPredecessor))) {
        return { admitted: false, reason: 'resume-predecessor-mismatch', receipt: publicReceipt(prior) };
      }
      return prior.status === 'active' ? { admitted: true, idempotent: true, receipt: publicReceipt(prior) } : { admitted: false, reason: 'operation-revoked' };
    }
    if (expectedRevision != null && (prior?.revision || 0) !== expectedRevision) {
      return { admitted: false, reason: 'admission-superseded', receipt: publicReceipt(prior) };
    }
    // A resume is a one-step capability rebind, not a historical lookup. The
    // caller must name the exact active/revoked receipt it is continuing; a
    // clear tombstone deliberately has no admissible lineage.
    if (requiresPredecessor(base)) {
      if (!prior || prior.semanticBase?.kind === 'clear' || !requestedPredecessor
        || !sameReceipt(prior, requestedPredecessor)) {
        return { admitted: false, reason: 'resume-predecessor-mismatch', receipt: publicReceipt(prior) };
      }
    } else if (requestedPredecessor != null) {
      return { admitted: false, reason: 'unexpected-predecessor' };
    }
    const record = {
      version: VERSION, canvasFilePath: scopeValue.canvasFilePath, hubId: scopeValue.hubId,
      operationId: operation, semanticBase: base, revision: (prior?.revision || 0) + 1,
      status: 'active', updatedAt: new Date().toISOString(), publications: prior?.publications || {},
      // A prior crash may have renamed artifacts after staging but before
      // promotion. A new claim must not erase the only exact mapping before a
      // reader/reconciliation can validate those bytes.
      pendingPublications: prior?.pendingPublications || null,
      predecessor: requiresPredecessor(base) ? publicReceipt(prior) : null,
    };
    await atomicWrite(scopeValue.authorityPath, record);
    return { admitted: true, receipt: publicReceipt(record) };
    });
  });
}

/** Last-wins cancellation. The tombstone is deliberately durable. */
export async function revokeJobAnalysisOperationAuthority({ canvasFilePath, hubId, operationId, semanticBase: rawBase, revision } = {}) {
  const operation = identifier(operationId);
  const base = semanticBase(rawBase);
  if (!operation || !base || !Number.isSafeInteger(revision) || revision < 1) {
    return { revoked: false, reason: 'invalid-operation-authority' };
  }
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return { revoked: false, reason: 'invalid-operation-authority' };
    return withLock(scopeValue, async () => {
    const priorState = await readState(scopeValue);
    if (priorState.invalid) return { revoked: false, reason: 'invalid-operation-authority-record' };
    const prior = priorState.record;
    // A stale caller may only revoke the exact receipt it observed.
    if (!prior || prior.operationId !== operation || prior.revision !== revision || !sameBase(prior.semanticBase, base)) {
      return { revoked: false, superseded: true, receipt: publicReceipt(prior) };
    }
    const record = {
      version: VERSION, canvasFilePath: scopeValue.canvasFilePath, hubId: scopeValue.hubId,
      operationId: operation,
      semanticBase: base,
      // Stop changes only liveness, not identity: the manifest still carries
      // this exact receipt and Resume must be able to name it without reading
      // a hidden sidecar revision. Explicit Clear is the destructive boundary
      // that advances revision and erases publications.
      revision: prior.revision, status: 'revoked', updatedAt: new Date().toISOString(),
      // Career-data Clear is a deliberately destructive boundary; ordinary
      // cancel preserves earlier host-published recovery generations.
      publications: prior?.publications || {},
      pendingPublications: prior?.pendingPublications || null,
      predecessor: prior?.predecessor || null,
    };
    await atomicWrite(scopeValue.authorityPath, record);
    return { revoked: true, receipt: publicReceipt(record) };
    });
  });
}

/** Explicit destructive career-data clear; unlike ordinary cancel, drops every publication. */
export async function clearJobAnalysisOperationAuthority({ canvasFilePath, hubId } = {}) {
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return { cleared: false, reason: 'invalid-operation-authority' };
    return withLock(scopeValue, async () => {
      const priorState = await readState(scopeValue);
      // Explicit user Clear is the sole destructive recovery action allowed to
      // replace corrupt evidence with a new irreversible clear fence.
      const prior = priorState.record;
      const record = {
        version: VERSION, canvasFilePath: scopeValue.canvasFilePath, hubId: scopeValue.hubId,
        operationId: `clear-${crypto.randomUUID()}`,
        semanticBase: { kind: 'clear', careerSnapshotId: '0'.repeat(64), runId: null, analysisRevisionId: null, fingerprint: null, continuationId: null, sourceArtifactFingerprint: null },
        revision: (prior?.revision || 0) + 1, status: 'revoked', updatedAt: new Date().toISOString(),
        publications: {}, pendingPublications: null,
        predecessor: null,
      };
      await atomicWrite(scopeValue.authorityPath, record);
      return { cleared: true, receipt: publicReceipt(record) };
    });
  });
}

/** Legacy/missing receipts are never admitted. This is safe across restart. */
export async function currentJobAnalysisOperationAuthority({ canvasFilePath, hubId, operationId, semanticBase: rawBase, revision } = {}) {
  const operation = identifier(operationId);
  const base = semanticBase(rawBase);
  if (!operation || !base || !Number.isSafeInteger(revision) || revision < 1) return false;
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return false;
    return withLock(scopeValue, async () => {
    const state = await readState(scopeValue);
    if (state.invalid) return false;
    let current = state.record;
    return !!current && current.status === 'active' && current.operationId === operation
      && current.revision === revision && sameBase(current.semanticBase, base);
    });
  });
}

/**
 * Hold the durable authority lock throughout an artifact transaction.  Every
 * analysis writer obtains this lock *before* its snapshot/checkpoint lock;
 * claim/revoke therefore cannot acknowledge S2 between S1 validation and its
 * atomic rename. Exact publications are recorded only after `write` resolves.
 */
export async function withCurrentJobAnalysisOperationAuthority({
  canvasFilePath,
  hubId,
  operationId,
  semanticBase: rawBase,
  revision,
  // This is deliberately an internal-only recovery affordance. A terminal
  // receipt may need to retry sidecar cleanup after the terminal commit has
  // tombstoned its exact capability. IPC callers never choose this mode.
  allowRevoked = false,
  // A successful terminal commit must close its write capability before this
  // transaction releases the authority lock. Otherwise a delayed save with
  // the same receipt could publish after `complete-job-run` returns.
  terminalTombstone = false,
  // Stop/pause uses the same exact write-close primitive, but its manifest is
  // intentionally retained for an immediate-predecessor Resume rebind.
  tombstoneAfterWrite = false,
} = {}, write) {
  const operation = identifier(operationId);
  const base = semanticBase(rawBase);
  if (!operation || !base || !Number.isSafeInteger(revision) || revision < 1 || typeof write !== 'function') {
    return { admitted: false, reason: 'invalid-operation-authority' };
  }
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return { admitted: false, reason: 'invalid-operation-authority' };
    return withLock(scopeValue, async () => {
    const state = await readState(scopeValue);
    if (state.invalid) return { admitted: false, reason: 'invalid-operation-authority-record' };
    let current = state.record;
    if (!current || (current.status !== 'active' && !(allowRevoked && current.status === 'revoked')) || current.operationId !== operation
      || current.revision !== revision || !sameBase(current.semanticBase, base)) {
      return { admitted: false, reason: 'operation-superseded' };
    }
    const shouldTombstone = terminalTombstone || tombstoneAfterWrite;
    const mayTombstone = value => tombstoneAfterWrite
      ? value?.ok === true
      // A terminal receipt is durable before cleanup, but an uncleared
      // manifest must retain its active receipt so the exact cleanup retry can
      // re-enter the normal manifest path.
      : terminalTombstone && value?.ok === true && value?.cleared === true;
    // An idempotent terminal cleanup may retry under the exact already-revoked
    // receipt. It cannot publish (the callback has no stage capability), but
    // it can finish its durable cleanup receipt safely.
    if (shouldTombstone && current.status !== 'active' && !allowRevoked) {
      return { admitted: false, reason: 'operation-not-active' };
    }
    // If a prior process crashed after all fixed-name renames but before map
    // promotion, resolve that complete pending layout *before* another writer
    // replaces it. This prevents D/A/B on disk being stranded by a new E/D/A
    // plan that crashes before its first rename.
    if (current.pendingPublications && await mapMatchesDisk(scopeValue, current.pendingPublications)) {
      current = { ...current, publications: current.pendingPublications, pendingPublications: null };
      await atomicWrite(scopeValue.authorityPath, { ...current, updatedAt: new Date().toISOString() });
    }
    let pending = null;
    const stage = async ({ publications: proposed = [], rotateSuccessful = false } = {}) => {
      // Exact revoked receipt retries are cleanup-only. Never hand a tombstone
      // a publication capability merely because a future callback happens to
      // invoke the common transaction helper.
      if (current.status !== 'active') throw new Error('Cannot publish with a revoked operation authority.');
      // Pending is the most recent intended layout after a crash. Base a new
      // rotation on it so old success:1 is not shifted from stale stable map.
      // A composite authority transaction may stage its checkpoint and global
      // artifact in separate locked writes. Accumulate its already-fsynced
      // pending map rather than dropping the earlier sibling publication.
      const nextPublications = { ...(pending || current.pendingPublications || current.publications || {}) };
      // Shift the old receipt map BEFORE overlaying newly-written success:1.
      if (rotateSuccessful) {
        if (nextPublications['success:2']) nextPublications['success:3'] = { ...nextPublications['success:2'], slot: 'success:3' };
        if (nextPublications['success:1']) nextPublications['success:2'] = { ...nextPublications['success:1'], slot: 'success:2' };
      }
      for (const raw of proposed) {
        const normalized = publication({ ...raw, receipt: { operationId: operation, semanticBase: base, revision } });
        if (!normalized) throw new Error('Invalid durable analysis publication receipt.');
        nextPublications[normalized.slot] = normalized;
      }
      pending = nextPublications;
      // Phase 1 is fsync'd before any artifact rename. If power fails during
      // rotation, readers accept exact bytes named by either prior or pending.
      await atomicWrite(scopeValue.authorityPath, { ...current, pendingPublications: pending, updatedAt: new Date().toISOString() });
    };
    const writeResult = await write(current, stage);
    const value = writeResult?.value === undefined ? writeResult : writeResult.value;
    // A scoped cancellation deletes an already-sealed artifact while holding
    // this exact authority lock.  It may retire only the semantic slots the
    // callback proved belonged to this receipt; this is deliberately not the
    // global Clear operation and therefore preserves the authority floor and
    // unrelated recovery generations.
    const retireSlots = Array.isArray(writeResult?.retirePublications)
      ? [...new Set(writeResult.retirePublications)]
      : [];
    if (retireSlots.length > 0) {
      if (retireSlots.some(slot => typeof slot !== 'string' || !/^(?:current|success:[1-3]|checkpoint:[a-f0-9]{24})$/.test(slot))) {
        throw new Error('Invalid scoped publication retirement.');
      }
      const removeMatching = (map) => {
        if (!map) return map;
        const copy = { ...map };
        for (const slot of retireSlots) {
          // Do not erase a retained predecessor/success publication merely
          // because it shares a slot name with a newer cancelled operation.
          if (sameReceipt(copy[slot]?.receipt, publicReceipt(current))) delete copy[slot];
        }
        return copy;
      };
      current = {
        ...current,
        publications: removeMatching(current.publications),
        pendingPublications: removeMatching(current.pendingPublications),
        updatedAt: new Date().toISOString(),
      };
      await atomicWrite(scopeValue.authorityPath, current);
    }
    if (pending == null) {
      // Writes that produced no artifact publication intentionally retain the
      // prior map; they cannot make an unsealed artifact readable.
      if (shouldTombstone && mayTombstone(value)) {
        const tombstone = { ...current, status: 'revoked', updatedAt: new Date().toISOString() };
        await atomicWrite(scopeValue.authorityPath, tombstone);
        return { admitted: true, value, receipt: publicReceipt(tombstone), terminalTombstoned: true };
      }
      return { admitted: true, value, receipt: publicReceipt(current) };
    }
    // Phase 2 promotes only after every writer rename returned. A crash before
    // here leaves the fsync'd pending map available for exact-digest recovery.
    const committed = { ...current, publications: pending, pendingPublications: null, updatedAt: new Date().toISOString() };
    const finalRecord = shouldTombstone && mayTombstone(value)
      ? { ...committed, status: 'revoked', updatedAt: new Date().toISOString() }
      : committed;
    await atomicWrite(scopeValue.authorityPath, finalRecord);
    return { admitted: true, value, receipt: publicReceipt(finalRecord), ...(shouldTombstone && mayTombstone(value) ? { terminalTombstoned: true } : {}) };
    });
  });
}

/** Verify a published artifact by its semantic slot, exact bytes digest, and receipt. */
export async function publishedJobAnalysisOperationAuthority({ canvasFilePath, hubId, slot, digest, operationId, semanticBase: rawBase, revision } = {}) {
  const wanted = receipt({ operationId, semanticBase: rawBase, revision });
  const expected = publication({ slot, digest, receipt: wanted });
  if (!expected) return false;
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return false;
    return withLock(scopeValue, async () => {
    const state = await readState(scopeValue);
    if (state.invalid) return false;
    const current = state.record;
    const matches = actual => !!actual && actual.digest === expected.digest && actual.receipt.operationId === expected.receipt.operationId
      && actual.receipt.revision === expected.receipt.revision && sameBase(actual.receipt.semanticBase, expected.receipt.semanticBase);
    return matches(current?.publications?.[expected.slot]) || matches(current?.pendingPublications?.[expected.slot]);
    });
  });
}

/** Remove a checkpoint slot only after its artifact has been retired. */
export async function retireJobAnalysisOperationPublication({ canvasFilePath, hubId, slot } = {}) {
  if (typeof slot !== 'string' || !/^checkpoint:[a-f0-9]{24}$/.test(slot)) return false;
  return withRecoveryScope(canvasFilePath, hubId, async scopeValue => {
    if (!scopeValue) return false;
    return withLock(scopeValue, async () => {
      const state = await readState(scopeValue);
      if (state.invalid) return false;
      const current = state.record;
      if (!current) return false;
      const publications = { ...current.publications };
      const pendingPublications = current.pendingPublications ? { ...current.pendingPublications } : null;
      const changed = delete publications[slot] || (pendingPublications ? delete pendingPublications[slot] : false);
      if (!changed) return false;
      await atomicWrite(scopeValue.authorityPath, { ...current, publications, pendingPublications, updatedAt: new Date().toISOString() });
      return true;
    });
  });
}

export function jobAnalysisOperationAuthorityReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  const operationId = identifier(value.operationId);
  const base = semanticBase(value.semanticBase);
  return operationId && base && Number.isSafeInteger(value.revision) && value.revision > 0
    ? { operationId, semanticBase: base, revision: value.revision }
    : null;
}

export const __jobAnalysisOperationAuthorityForTests = {
  current: currentJobAnalysisOperationAuthority,
  claim: claimJobAnalysisOperationAuthority,
  revoke: revokeJobAnalysisOperationAuthority,
  clear: clearJobAnalysisOperationAuthority,
  published: publishedJobAnalysisOperationAuthority,
  retirePublication: retireJobAnalysisOperationPublication,
};
