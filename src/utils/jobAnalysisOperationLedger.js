/**
 * Renderer-side authority for an asynchronous Job Search analysis operation.
 *
 * A career snapshot is necessary evidence, but is not an operation identity:
 * two requests can legitimately use the same approved snapshot.  Keep a
 * serializable generation receipt as the durable/UI identity and a private
 * object identity as the capability passed through delayed continuations.
 * Claiming a newer operation revokes every older capability synchronously,
 * before that newer operation performs any await.
 */
export function createJobAnalysisOperationLedger() {
  let generation = 0;
  let current = null;

  const receiptFor = (capability) => capability ? {
    hubId: capability.hubId,
    generation: capability.generation,
    operationId: capability.operationId,
    runId: capability.runId || null,
    fingerprint: capability.fingerprint || null,
    disposition: capability.disposition || null,
  } : null;

  return {
    prepare({ canvasFilePath = null, hubId, runId = null, fingerprint = null, disposition = null } = {}) {
      if (!hubId) return null;
      const operationId = globalThis.crypto?.randomUUID?.();
      // Operation ids are cross-process durable authority names. A timestamp
      // or Math.random fallback can collide after reload/restart and is not a
      // capability; fail closed on a platform without secure UUID support.
      if (!operationId) throw new Error('Secure operation UUID support is required.');
      return Object.freeze({
        canvasFilePath: canvasFilePath || null,
        hubId,
        generation: null,
        // Generation is diagnostic only: it restarts on a renderer remount.
        // The opaque id is the persisted authority and must never collide with
        // an old in-flight operation after reload/restart.
        operationId,
        runId: runId || null,
        fingerprint: fingerprint || null,
        disposition: disposition || null,
      });
    },
    adopt(prepared, authority = null) {
      if (!prepared?.operationId || !prepared?.hubId) return null;
      // The host-issued receipt is the authority for immediate IPC calls. Do
      // not wait for React node-state propagation, which can race a Resume.
      const capability = Object.freeze({ ...prepared, authority, generation: ++generation });
      current = capability;
      return capability;
    },
    claim(args = {}) {
      return this.adopt(this.prepare(args));
    },
    canCommit(capability) {
      return capability != null && current === capability;
    },
    receiptFor,
    currentReceipt() { return receiptFor(current); },
    revoke(capability = null) {
      if (capability == null || current === capability) current = null;
    },
  };
}

/** Exact node-data CAS used after an await; never treat snapshot equality alone as authority. */
export function jobAnalysisOperationMatches(data, capability) {
  const actual = data?.analysisOperation;
  return !!capability
    && actual?.hubId === capability.hubId
    && actual?.generation === capability.generation
    && actual?.operationId === capability.operationId
    && actual?.runId === (capability.runId || null)
    && actual?.fingerprint === (capability.fingerprint || null)
    && actual?.disposition === (capability.disposition || null);
}
