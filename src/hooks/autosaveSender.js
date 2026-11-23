import { createCanvasDeltaEncoder } from '../../electron/ipc/workspaceSaveDelta.js';

// Records per hand-over call when many must be sent (the first auto-save after
// opening a canvas, or after the app process lost its copy). Each call blocks
// the window while its records are copied, so a large canvas goes over in
// small calls. Waiting for each reply is what lets the window paint in
// between; a timer would be slowed to one per second in a hidden window.
const AUTOSAVE_STAGE_BATCH = 16;

// Node types a PERF receipt may name. Anything else prints "other", so a type
// word can never carry content. Kept in step with the list in
// electron/ipc/perfDiagnostics.js, which checks it again.
const NAMEABLE_NODE_TYPES = new Set(['document', 'text', 'group', 'link', 'jobcard', 'jobhub', 'jobboard', 'sellhub',
  'marketplacecard', 'marketplacestatus', 'compsourcecard', 'jobsourcecard', 'jobgroup']);

// Counts and one type word, read from what is being sent: nothing is measured
// or walked. The largest record is the node holding the most big values cut
// out as parts (those are the records that make a save heavy); with no parts,
// it is named only when a single node record is sent (edge and drawing
// records carry no type).
function describeSent(chunks, attached, calls, whole) {
  let parts = 0;
  let owner = null;
  let ownerParts = 0;
  let onlyNode = null;
  let nodeRecords = 0;
  let records = 0;
  for (const chunk of chunks) {
    if (attached?.has(chunk[0])) { parts += 1; continue; }
    records += 1;
    if (typeof chunk[1]?.type === 'string') { nodeRecords += 1; onlyNode = chunk[1]; }
    const held = chunk[2]?.parts?.length || 0;
    if (held > ownerParts) { ownerParts = held; owner = chunk[1]; }
  }
  const named = owner || (nodeRecords === 1 ? onlyNode : null);
  const type = typeof named?.type === 'string' ? (NAMEABLE_NODE_TYPES.has(named.type) ? named.type : 'other') : null;
  return { records: records + parts, parts, calls, ...(type ? { largest: type } : {}), ...(whole ? { whole: true } : {}) };
}

/**
 * Hands a canvas to the app process for an auto-save, sending only the nodes
 * that changed since the last one (see workspaceSaveDelta.js). One sender per
 * window. Returns the save reply; `onBlocked(ms)` reports each stretch the
 * window was blocked copying data out, and `onSent(summary)` says once, even
 * when the save throws, how much was sent (see describeSent).
 *
 * Falls back to sending the whole canvas when the bridge has no staging call
 * or the app process no longer holds what earlier saves sent.
 */
export function createAutosaveSender() {
  const encoder = createCanvasDeltaEncoder();
  const timed = (onBlocked, call) => {
    const startedAt = performance.now();
    const pending = call();
    onBlocked?.(performance.now() - startedAt);
    return pending;
  };
  return async function sendAutosave({ api, data, filePath, onBlocked, onSent }) {
    let calls = 0;
    let wholeSent = false;
    let sentChunks = [];
    let sentAttached = null;
    const sendWhole = () => {
      wholeSent = true;
      calls += 1;
      return timed(onBlocked, () => api.saveWorkspace({ data, filePath }));
    };
    try {
      return await sendDelta();
    } finally {
      onSent?.(describeSent(sentChunks, sentAttached, calls, wholeSent));
    }

    async function sendDelta() {
    if (typeof api.stageWorkspaceChunks !== 'function') return sendWhole();
    const startedAt = performance.now();
    const { session, root, chunks, attached, settle } = encoder.encode(data);
    onBlocked?.(performance.now() - startedAt);
    sentChunks = chunks;
    sentAttached = attached;
    // A record's parts ride in the same call as the record (see `attached`),
    // so a batch is counted in whole records, never cut between a part and
    // the record it belongs to.
    const batches = [];
    let batch = [];
    let wholeRecords = 0;
    for (const chunk of chunks) {
      batch.push(chunk);
      if (attached?.has(chunk[0])) continue;
      wholeRecords += 1;
      if (wholeRecords === AUTOSAVE_STAGE_BATCH) {
        batches.push(batch);
        batch = [];
        wholeRecords = 0;
      }
    }
    if (batch.length) batches.push(batch);
    let reply;
    try {
      // The last batch rides with the save itself.
      const last = batches.length ? batches.pop() : [];
      for (const staging of batches) {
        calls += 1;
        const staged = await timed(onBlocked, () => api.stageWorkspaceChunks({ session, chunks: staging }));
        if (!staged?.success) {
          settle('lost');
          return sendWhole();
        }
      }
      calls += 1;
      reply = await timed(onBlocked, () => api.saveWorkspace({
        canvas: { session, root, chunks: last },
        filePath,
      }));
    } catch (error) {
      settle('lost');
      throw error;
    }
    if (reply?.needsFullCanvas) {
      settle('lost');
      return sendWhole();
    }
    settle(reply?.success ? 'saved' : 'failed');
    return reply;
    }
  };
}
