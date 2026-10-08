// Pure decision layer for the shared "AI handoffs" application page. Every
// application the ChatGPT bridge currently holds becomes one row of a single
// shared page instead of its own chip, so the dock groups them and this file
// answers every grouping/row question without touching the store or the DOM.
import { findBridgeHeldJob } from './bridgeHeldApplication.js';
import { deriveBridgeJobProgress, PROGRESS_STAGES } from './bridgeJobProgress.js';
import { MAX_HANDOFF_CONCURRENCY } from './handoffScheduler.js';

/**
 * True when this dock request belongs on the shared application page. Only a
 * readable, non-integrity application whose job the bridge still holds (in one
 * of the working phases) is grouped; blocked, integrity-flagged or unreadable
 * requests, and anything the bridge no longer holds, keep a normal chip/page.
 */
export function isGroupableBridgeApplication(request, status) {
  try {
    return request?.kind === 'application'
      && typeof request?.jobId === 'string' && request.jobId.length > 0
      && !request.integrityMessage
      && !request.unreadable
      && request.workingState !== 'blocked'
      && findBridgeHeldJob(status, request.jobId) !== null;
  } catch {
    return false;
  }
}

/**
 * Split dock requests into the shared page (`held`) and everything else
 * (`rest`), preserving input order within each list. Falsy entries are dropped
 * and a non-array input yields two empty lists. Never mutates the input.
 */
export function partitionBridgeApplications(requests, status) {
  if (!Array.isArray(requests)) return { held: [], rest: [] };
  const held = [];
  const rest = [];
  for (const request of requests) {
    if (!request) continue;
    (isGroupableBridgeApplication(request, status) ? held : rest).push(request);
  }
  return { held, rest };
}

/**
 * The dock nav in display order: one 'request' entry per non-held request, and
 * ONE 'applications' group entry standing where the first held request sat in
 * the input order. A single held request still groups (the shared page is used
 * for one application too); no held requests means no group entry.
 */
export function buildDockNav(requests, status) {
  const source = Array.isArray(requests) ? requests : [];
  const nav = [];
  let firstHeld = null;
  // Where the first held request sat among the entries emitted so far: the
  // shared page takes that slot, so the strip does not reorder under someone
  // who is already looking at it.
  let groupIndex = -1;
  const held = [];
  for (const request of source) {
    if (!request) continue;
    if (isGroupableBridgeApplication(request, status)) {
      if (firstHeld === null) {
        firstHeld = request;
        groupIndex = nav.length;
      }
      held.push(request);
    } else {
      nav.push({ type: 'request', requestId: request.requestId, request });
    }
  }
  if (firstHeld !== null) {
    nav.splice(groupIndex, 0, {
      type: 'applications',
      requestId: firstHeld.requestId,
      requests: held,
    });
  }
  return nav;
}

/** True when any 'applications' group entry includes the given requestId. */
export function navGroupContains(nav, requestId) {
  const entries = Array.isArray(nav) ? nav : [];
  return entries.some(entry => (
    entry?.type === 'applications'
    && Array.isArray(entry.requests)
    && entry.requests.some(request => request?.requestId === requestId)
  ));
}

/** True when the nav is exactly one applications group (the shared page only). */
export function isGroupOnlyNav(nav) {
  return Array.isArray(nav) && nav.length === 1 && nav[0]?.type === 'applications';
}

/**
 * One row per held request, in order. Each row resolves the request's job,
 * stage, worker and view through the same real helpers the dock already uses.
 * A throwing `ordinalFor` is tolerated (ordinal becomes null), and a request
 * whose job is no longer held still yields a row with the generic view.
 */
export function buildApplicationPageRows({ held = [], status, ordinalFor, now } = {}) {
  const source = Array.isArray(held) ? held : [];
  const chat = status?.chat && typeof status.chat === 'object' ? status.chat : {};
  const workers = chat?.pool?.active === true && Array.isArray(chat.pool.workers) ? chat.pool.workers : [];

  const ordinalOf = (request) => {
    if (typeof ordinalFor !== 'function') return null;
    let value;
    try {
      value = ordinalFor(request);
    } catch {
      return null;
    }
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  };

  return source.map((request) => {
    const job = findBridgeHeldJob(status, request?.jobId);

    let stage = null;
    if (job && PROGRESS_STAGES.includes(job.stage)) stage = job.stage;
    else if (PROGRESS_STAGES.includes(request?.stage)) stage = request.stage;

    const rawOrdinal = job?.workerOrdinal;
    const workerOrdinal = Number.isInteger(rawOrdinal) && rawOrdinal >= 1 && rawOrdinal <= MAX_HANDOFF_CONCURRENCY
      ? rawOrdinal
      : null;
    const ownerWorker = workerOrdinal === null
      ? null
      : workers.find(worker => worker?.ordinal === workerOrdinal) || null;

    const view = deriveBridgeJobProgress({
      job,
      chat,
      item: request,
      ownerWorker,
      now,
      bridge: { paused: status?.paused === true, pluginName: status?.config?.pluginName },
    });

    return {
      requestId: request?.requestId,
      jobId: request?.jobId,
      request,
      ordinal: ordinalOf(request),
      subject: request?.subject || request?.label || 'This application',
      stage,
      workerOrdinal,
      ownerWorker,
      view,
      showDetail: view?.action === null,
    };
  });
}

/**
 * The row that drives the single shared worker block: the first row that wants
 * to start a chat, else the first row with any action, else the first row.
 */
export function pickWorkerRepresentative(rows) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length === 0) return null;
  const starter = source.find(row => row?.view?.action === 'start-chat');
  if (starter) return starter;
  const withAction = source.find(row => row?.view?.action !== null && row?.view?.action !== undefined);
  return withAction || source[0];
}
