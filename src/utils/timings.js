/**
 * Centralized UI timing — one source of truth for debounce windows, transient
 * feedback durations, and interaction delays.
 *
 * Before this they were scattered across the frontend with inconsistent values
 * for the same concept (copy confirmations at both 1500ms and 2000ms, "saved"
 * dots and save-status resets at 1500ms, three different autosave numbers, …).
 * Consolidating them makes similar interactions feel the same and makes the
 * timing easy to tune in one place.
 *
 * Two values are content-/device-aware (the "dynamic" win): autosave and
 * per-document save debounces grow gently with workspace/doc size (bigger =
 * costlier to serialize + write, so coalesce a burst of edits a little longer),
 * and undo history depth scales down on low-memory devices (each snapshot is a
 * full canvas clone). Everything is clamped to stay in a sane range, and the
 * helpers never return a value *shorter* than the old fixed one for the common
 * (small) case — so this can't make saves more eager than before.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const TIMINGS = {
  // ── Debounce: input settles → commit ──────────────────────────────────────
  UNDO_SNAPSHOT_DEBOUNCE_MS:   500,  // safety-net auto-snapshot after canvas edits settle
  SEARCH_RECOUNT_DEBOUNCE_MS:  200,  // recompute match count after the query stops changing
  AUTOSAVE_RETRY_ANIMATING_MS: 1000, // re-poll autosave while a nav animation is mid-flight
  AUTOSAVE_RETRY_SAVING_MS:    500,  // re-poll autosave while a manual save is in-flight

  // ── Transient confirmation feedback: show → auto-clear ────────────────────
  // One value for every "it worked, here's a brief badge" cue: the "Saved" dot,
  // "Copied!" confirmations, and the save-status reset (was 1500/1500/1500/2000).
  FEEDBACK_MS: 1500,

  // ── Interaction delays ────────────────────────────────────────────────────
  FOCUS_DELAY_MS:     100, // let an element mount/expand before focusing it
  SEARCH_AUTODIVE_MS: 700, // grace period before auto-diving into a matched sub-canvas
  SUBMENU_CLOSE_MS:   120, // bridge the mouse gap before closing a context submenu

  // ── Background polling ────────────────────────────────────────────────────
  SETTINGS_LISTENER_POLL_MS:   100,   // retry interval while wiring the settings listener
  SETTINGS_LISTENER_GIVEUP_MS: 10000, // stop retrying after this
};

// ── Content-/device-aware helpers ───────────────────────────────────────────

/**
 * Canvas autosave debounce. Scales with node count: a big workspace costs more
 * to serialize + write, so wait a little longer to coalesce a burst of edits.
 * Floored at the old fixed 2000ms so small canvases are never saved more eagerly
 * than before.
 * @param {number} nodeCount
 */
export function autosaveDebounceMs(nodeCount = 0) {
  return clamp(Math.round(2000 + (nodeCount || 0) * 6), 2000, 5000);
}

/**
 * Per-document save debounce. Longer docs cost more to write and tend to be
 * edited in longer bursts, so the idle window grows gently with length. Floored
 * at the old fixed 800ms.
 * @param {number} charCount
 */
export function docSaveDebounceMs(charCount = 0) {
  return clamp(Math.round(800 + (charCount || 0) / 50), 800, 2500);
}

/**
 * Undo history depth, scaled to device memory — each snapshot is a full canvas
 * clone, so low-memory machines keep fewer to avoid bloating the heap.
 * navigator.deviceMemory is coarse (GB, capped at 8 in Chromium) and may be
 * undefined; default to 8 so capable/unknown machines keep the historical 100.
 */
export function maxUndoHistory() {
  const gb = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
  return clamp(Math.round(gb * 12.5), 50, 200);
}
