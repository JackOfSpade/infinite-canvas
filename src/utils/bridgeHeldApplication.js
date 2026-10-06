// The one rule for "the ChatGPT bridge holds this application", shared by the
// dock (NonApiAiDialog) and the job card so the two can never disagree.
//
// True only when the bridge's live status lists this exact jobId in a lane
// phase where ChatGPT is the one to answer it (unread, awaiting, host). A lane
// the bridge kept for the person (held, e.g. "Keep for me"), handed back
// (needs_user) or finished with (gone, done) is exactly where the person has
// to paste, so those keep the normal paste UI.
//
// Never throws: a missing or malformed status (bridge disabled, preload still
// connecting, an older main process) is simply "not held".
import { deriveBridgeJobProgress } from './bridgeJobProgress.js';
import { BRIDGE_CARD_COPY } from './handoffBridgeCopy.js';

export const BRIDGE_WORKING_PHASES = new Set(['unread', 'awaiting', 'host']);

export function findBridgeHeldJob(status, jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  const jobs = status?.queue?.jobs;
  if (!Array.isArray(jobs)) return null;
  return jobs.find(job => job?.jobId === jobId && BRIDGE_WORKING_PHASES.has(job?.phase)) || null;
}

export function isBridgeHeldJob(status, jobId) {
  return findBridgeHeldJob(status, jobId) !== null;
}

// The job card must never contradict the dock, so it does not word the job's
// state itself: it takes the dock's own derivation (BridgeProgress calls the
// same deriveBridgeJobProgress on the same status) and shows its headline.
//
// A card subscribes with useSyncExternalStore, which re-renders only when the
// snapshot changes under Object.is, and the status object is replaced on every
// push, so the card subscribes to this PRIMITIVE: null when the bridge does not
// hold the job, otherwise JSON [tone, headline]. It changes only when the card
// would actually look different.
//
// The clock: getSnapshot must return the same value on consecutive calls, so
// the derivation runs with now = null. The only headline that depends on the
// clock is only used by the dock's live elapsed line. The card is refreshed by
// status pushes, never by a timer: a slow unanswered handoff stays working and
// age alone must not turn it into a recovery action.
// The card also lacks the dock item's corrections list, so where the dock says
// "ChatGPT is fixing N issues" the card says "ChatGPT is working on: <step>",
// the same tone and a weaker true statement.
export function bridgeHeldKey(status, jobId) {
  const job = findBridgeHeldJob(status, jobId);
  if (!job) return null;
  const chat = status?.chat && typeof status.chat === 'object' ? status.chat : {};
  const view = deriveBridgeJobProgress({
    job,
    chat,
    item: { stage: job.stage },
    now: null,
    bridge: { paused: status?.paused === true },
  });
  return JSON.stringify([view.tone, view.headline]);
}

// What the job card's application line says. `heldKey` is bridgeHeldKey(...).
// Only a paste-transport job that awaits a paste can be held (those are the
// only application bundles the dock lists); everything else, and every job the
// bridge does not hold, returns null so the card keeps its existing wording.
export function bridgeHeldCardLine(heldKey, { pasteTransport, awaitingPaste }) {
  if (typeof heldKey !== 'string' || !pasteTransport || !awaitingPaste) return null;
  let parsed;
  try { parsed = JSON.parse(heldKey); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !parsed[1]) return null;
  const [tone, headline] = parsed;
  return {
    title: headline,
    detail: tone === 'attention' || tone === 'problem' ? BRIDGE_CARD_COPY.detailNeedsYou : BRIDGE_CARD_COPY.detail,
    needsYou: tone === 'attention' || tone === 'problem',
    openLabel: BRIDGE_CARD_COPY.open,
    pendingLabel: BRIDGE_CARD_COPY.pending,
    pendingTitle: BRIDGE_CARD_COPY.pendingTitle,
  };
}
