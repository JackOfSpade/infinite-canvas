/**
 * Centralized UI timing — one source of truth for debounce windows, transient
 * feedback durations, and interaction delays.
 *
 * Three helpers are content- or device-aware: autosaveDebounceMs and
 * docSaveDebounceMs grow gently with workspace and document size (bigger means
 * costlier to serialize and write, so a burst of edits coalesces a little
 * longer), and maxUndoHistory scales down on low-memory devices (each snapshot
 * is a full canvas clone). Results are clamped to a sane range and never fall
 * below the fixed value used for small workspaces. The save-failure retry
 * constants are exported separately from TIMINGS.
 */
import { clamp } from './mathUtils.js';

export const AUTOSAVE_FAILURE_RETRY_MS = Object.freeze([2000, 5000, 15000]);
// Sync clients can retain a hard link for minutes. Keep checking at a low
// frequency after the initial retries so recovery never requires another edit.
export const AUTOSAVE_FAILURE_POLL_MS = 30000;
// The host already waits ~15s per attempt for a sync client's upload link to
// clear, so a short gap here keeps the next save close to the upload's end.
export const AUTOSAVE_SYNC_LINK_RETRY_MS = 3000;
// Only tell the user once a sync wait has blocked saving for this long.
export const AUTOSAVE_SYNC_LINK_NOTICE_MS = 3 * 60_000;

export const TIMINGS = {
  // ── Debounce: input settles → commit ──────────────────────────────────────
  UNDO_SNAPSHOT_DEBOUNCE_MS:   500,  // safety-net auto-snapshot after canvas edits settle
  SEARCH_RECOUNT_DEBOUNCE_MS:  200,  // recompute match count after the query stops changing
  AUTOSAVE_RETRY_ANIMATING_MS: 1000, // re-poll autosave while a nav animation is mid-flight
  AUTOSAVE_RETRY_SAVING_MS:    500,  // re-poll autosave while a manual save is in-flight
  AUTOSAVE_RETRY_EDITING_MS:   1500, // re-poll autosave while the user is mid-edit in a contenteditable
  AUTOSAVE_INPUT_QUIET_MS:     1500, // auto-save waits for this long a pause in mouse/keyboard input
  AUTOSAVE_RETRY_INPUT_MS:     500,  // re-poll auto-save while the person is still moving or typing
  AUTOSAVE_INPUT_MAX_WAIT_MS:  20000, // ...but never holds a save back longer than this

  // ── Transient confirmation feedback: show → auto-clear ────────────────────
  // One value for every "it worked, here's a brief badge" cue: the "Saved" dot,
  // "Copied!" confirmations, and the save-status reset (was 1500/1500/1500/2000).
  FEEDBACK_MS: 1500,

  // ── Interaction delays ────────────────────────────────────────────────────
  FOCUS_DELAY_MS:     100, // let an element mount/expand before focusing it
  SEARCH_AUTODIVE_MS: 700, // grace period before auto-diving into a matched sub-canvas
  MODAL_RESOLVE_GUARD_MS: 200, // keep modal shield mounted through a rapid second click

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
  // Coerce defensively: a non-numeric input would make the result NaN, and a NaN
  // debounce fed to setTimeout fires immediately → save storm.
  const n = Number(nodeCount) || 0;
  return clamp(Math.round(2000 + n * 6), 2000, 5000);
}

/**
 * Per-document save debounce. Longer docs cost more to write and tend to be
 * edited in longer bursts, so the idle window grows gently with length. Floored
 * at the old fixed 800ms.
 * @param {number} charCount
 */
export function docSaveDebounceMs(charCount = 0) {
  const c = Number(charCount) || 0;   // see autosaveDebounceMs — avoid NaN → setTimeout(NaN)
  return clamp(Math.round(800 + c / 50), 800, 2500);
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
