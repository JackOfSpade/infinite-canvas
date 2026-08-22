/**
 * Shared plumbing between JobCardNode's mounted Local AI workflow and the
 * canvas-level fallback manager (useLocalAiFallbackManager).
 *
 * Why this exists: the Local AI handoff used to be driven ONLY by a poll
 * interval inside JobCardNode. Hidden cards unmount (collapse, a board hiding
 * stale results, nested-canvas navigation), which silently killed the poll —
 * Claude Code would write result.json and wait forever on a manifest nobody
 * was ever going to update. The canvas-level manager keeps every pending job
 * alive; this module gives both drivers one source of truth for who owns a
 * job at any moment (exactly one driver: the mounted card if there is one,
 * otherwise the manager).
 */

export const LOCAL_AI_RESULT_SETTLE_MS = 6_000;
export const LOCAL_AI_POLL_INTERVAL_MS = 2_500;

// A transient status-IPC failure (a canvas re-save renaming files under the
// resolver, a momentary FS error) is surfaced only after this many consecutive
// failing polls. Drivers label it `status-error`, which remains pollable, so a
// later successful check reconnects the handoff automatically.
export const LOCAL_AI_STATUS_ERROR_STREAK_LIMIT = 3;

// Statuses the MOUNTED CARD's poll loop leaves alone (JobCardNode's effect).
// 'importing' is here because the card is itself mid-import when it holds it.
export const LOCAL_AI_CARD_POLL_IDLE_STATUSES = Object.freeze([
  'saved', 'failed', 'importing', 'render-retry-required', 'revision-exhausted',
]);

// Statuses the FALLBACK MANAGER leaves alone. Deliberately narrower than the
// card's list: a persisted 'importing' with NO mounted card means the driving
// renderer died (or the card unmounted mid-import) — the on-disk job is safe
// to validate again, so the manager resumes it. An import genuinely still
// running in the main process rejects the retry with LOCAL_AI_IMPORT_IN_FLIGHT,
// which the manager treats as "wait for the next tick".
export const LOCAL_AI_FALLBACK_IDLE_STATUSES = Object.freeze([
  'saved', 'failed', 'render-retry-required', 'revision-exhausted',
]);

// ── Mounted-card registry ────────────────────────────────────────────────────
// Module-level so the manager (a different component tree) can consult it
// synchronously before every poll/import/state write. A card registers for its
// whole mounted lifetime; membership therefore means "this card's own effect
// is driving its Local AI job right now".
const mountedJobCards = new Set();

export function registerMountedJobCard(id) {
  if (id) mountedJobCards.add(id);
}

export function unregisterMountedJobCard(id) {
  mountedJobCards.delete(id);
}

export function isJobCardMounted(id) {
  return mountedJobCards.has(id);
}

/**
 * Pure selection of the jobs the fallback manager should drive this tick:
 * job cards holding a pending Local AI job whose card component is not
 * mounted (hidden cascade, collapsed group, a parent canvas level, …).
 * `isMounted` is injectable for tests.
 */
export function selectFallbackLocalAiJobs(allNodes, isMounted = isJobCardMounted) {
  const out = [];
  for (const node of Array.isArray(allNodes) ? allNodes : []) {
    if (node?.type !== 'jobcard') continue;
    const local = node?.data?.localApplication;
    if (!local?.id) continue;
    if (LOCAL_AI_FALLBACK_IDLE_STATUSES.includes(local.status)) continue;
    if (isMounted(node.id)) continue;
    out.push(node);
  }
  return out;
}
