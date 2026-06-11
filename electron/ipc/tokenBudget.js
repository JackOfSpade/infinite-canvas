/**
 * Telemetry-driven LLM output-token budgets.
 *
 * llm.js's TASK_MAX_TOKENS gives each task a hand-calibrated cap (a static
 * number or a formula of itemCount/photoCount). Those formulas were tuned to
 * specific models' thinking/visible-token behavior — and the comments in llm.js
 * are a graveyard of "a newer thinking-heavy model truncated the old cap." This
 * module makes the cap SELF-CALIBRATING so it tracks model changes automatically.
 *
 * How: record the real output (visible + thinking) tokens each call actually
 * produced, per task, in a rolling persisted window. The effective cap is then
 *
 *     clamp( max(formulaSeed, p95(observed) × HEADROOM),  formulaSeed,  HARD_CAP )
 *
 * Key asymmetry (intentional): learning only ever GROWS the cap above the
 * formula — never shrinks below it. Truncation IS billed (you pay for the tokens
 * produced before the cut-off, then have to retry), so over-shrinking is the
 * expensive mistake; the formula stays the safe floor. When a model churns and
 * starts using more than the formula predicted, observed p95 rises toward the
 * cap, and the budget grows (up to HARD_CAP) to stop the truncation — exactly
 * the failure mode the llm.js comments describe, now handled without a re-tune.
 *
 * A truncated call (it used the entire cap) is itself a sample at the cap, so it
 * pulls p95 up and the budget self-heals on the next call; once roomy, samples
 * fall back to actual usage and it settles at actual_p95 × HEADROOM.
 */
import { lazyStore } from '../utils/lazyStore.js';

const store = lazyStore('token-budgets');

const WINDOW       = 30;     // rolling samples kept per task
const MIN_SAMPLES  = 8;      // trust the learned cap only after this many
const HEADROOM     = 1.2;    // p95 × this — bias upward (truncation is billed)
const HARD_CAP     = 32768;  // absolute ceiling — bounds runaway billing
// Note: tasks whose formula seeds above the old 24576 hard cap (e.g. job-bucketing
// at 52+ jobs: 4096+52×400=24896) were permanently stuck — effectiveCap kept
// returning 24576 even when the self-calibration wanted to raise it higher.
// 32768 gives the self-calibration room to grow past the 24576 truncation floor.

function allUsage() {
  return store.get('usage') || {};
}

function allTruncations() {
  return store.get('truncations') || {};
}

/** Record the real output tokens (visible + thinking) a task's call produced. */
export function recordTokenUsage(task, totalOutputTokens) {
  if (!task || !(totalOutputTokens > 0)) return;
  const all = allUsage();
  const arr = all[task] || [];
  arr.push(Math.round(totalOutputTokens));
  while (arr.length > WINDOW) arr.shift();
  all[task] = arr;
  store.set('usage', all);
}

/**
 * Record that a task hit its output cap (MAX_TOKENS / max_tokens). A truncation
 * is CENSORED evidence — the model wanted MORE than `capHit`, so it's the
 * strongest possible "cap too low" signal. Unlike an ordinary usage sample it
 * must raise the budget IMMEDIATELY (effectiveCap bypasses MIN_SAMPLES for it):
 * otherwise the first MIN_SAMPLES truncations are all wasted while the task
 * silently truncates and falls back to a weaker model on every call before the
 * learned p95 ever engages. We track the largest cap a task has truncated at so
 * the next call provisions past it.
 *
 * `formulaSeed` is optional — the raw TASK_MAX_TOKENS value before effectiveCap
 * adjustment. Stored for diagnostics: a truncatedAt >> formulaSeed means the
 * formula was the bottleneck (self-calibration tried to compensate but couldn't
 * catch up fast enough); truncatedAt ≈ formulaSeed means the formula is fine
 * but the self-calibration hadn't yet grown past it.
 */
export function recordTruncation(task, capHit, formulaSeed) {
  if (!task || !(capHit > 0)) return;
  const all = allTruncations();
  const prev = all[task] || {};
  const prevCap = typeof prev === 'number' ? prev : (prev.capHit || 0);
  if (Math.round(capHit) > prevCap) {
    all[task] = { capHit: Math.round(capHit), formulaSeed: formulaSeed != null ? Math.round(formulaSeed) : null };
  }
  store.set('truncations', all);
}

/**
 * Effective output cap for a task: the formula seed, raised toward p95×headroom
 * (never above HARD_CAP) once we have enough samples and the model is using more
 * than the formula assumed. Returns the seed unchanged until MIN_SAMPLES.
 * @param {string} task
 * @param {number} formulaSeed  the cap TASK_MAX_TOKENS computed for this call
 */
export function effectiveCap(task, formulaSeed) {
  const seed = Number(formulaSeed) > 0 ? Math.round(Number(formulaSeed)) : HARD_CAP;

  // Truncation floor: if this task has ever hit its cap, the real demand was
  // ABOVE that cap, so provision past it (× headroom) right away. This bypasses
  // the MIN_SAMPLES gate on purpose — a truncation is unambiguous, and waiting
  // for a p95 window means truncating + falling back on every call until then.
  const truncRec    = task ? allTruncations()[task] : null;
  // Support both the old plain-number format and the new {capHit, formulaSeed} shape.
  const truncatedAt = truncRec ? (typeof truncRec === 'number' ? truncRec : (truncRec.capHit || 0)) : 0;
  const truncFloor  = truncatedAt > 0 ? Math.round(truncatedAt * HEADROOM) : 0;

  // Learned p95 floor: only trusted once we have a stable window, and only ever
  // grows the cap above the formula (truncation is billed; over-shrinking is the
  // expensive mistake — see module header).
  const arr = task ? allUsage()[task] : null;
  let learned = 0;
  if (arr && arr.length >= MIN_SAMPLES) {
    const sorted = [...arr].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    learned = Math.round(p95 * HEADROOM);
  }

  return Math.min(HARD_CAP, Math.max(seed, truncFloor, learned));
}

/** The absolute max-tokens ceiling. Exported so bug reports can detect a stuck cap. */
export const TOKEN_HARD_CAP = HARD_CAP;

/** Diagnostic snapshot for bug reports: per-task sample count + observed p95. */
export function getTokenBudgetSnapshot() {
  const all = allUsage();
  const truncs = allTruncations();
  const out = {};
  for (const [task, arr] of Object.entries(all)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const truncRec   = truncs[task];
    const truncatedAt = truncRec ? (typeof truncRec === 'number' ? truncRec : (truncRec.capHit || 0)) : 0;
    const formulaSeed = truncRec && typeof truncRec === 'object' ? (truncRec.formulaSeed ?? null) : null;
    out[task] = {
      samples: arr.length,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
      // > 0 means this task has truncated at this cap (and the budget has since
      // grown past it); a truncation = the model fell back to a weaker model.
      truncatedAt,
      // The raw TASK_MAX_TOKENS formula output at the time of the highest
      // truncation — null if the truncation was recorded before this field was added.
      formulaSeedAtTruncation: formulaSeed,
    };
  }
  return out;
}
