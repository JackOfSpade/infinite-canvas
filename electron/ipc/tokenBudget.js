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
import Store from 'electron-store';

const store = new Store({ name: 'token-budgets' });

const WINDOW       = 30;     // rolling samples kept per task
const MIN_SAMPLES  = 8;      // trust the learned cap only after this many
const HEADROOM     = 1.2;    // p95 × this — bias upward (truncation is billed)
const HARD_CAP     = 24576;  // absolute ceiling — bounds runaway billing

function allUsage() {
  return store.get('usage') || {};
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
 * Effective output cap for a task: the formula seed, raised toward p95×headroom
 * (never above HARD_CAP) once we have enough samples and the model is using more
 * than the formula assumed. Returns the seed unchanged until MIN_SAMPLES.
 * @param {string} task
 * @param {number} formulaSeed  the cap TASK_MAX_TOKENS computed for this call
 */
export function effectiveCap(task, formulaSeed) {
  const seed = Number(formulaSeed) > 0 ? Math.round(Number(formulaSeed)) : HARD_CAP;
  const arr = task ? allUsage()[task] : null;
  if (!arr || arr.length < MIN_SAMPLES) return Math.min(HARD_CAP, seed);

  const sorted = [...arr].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const learned = Math.round(p95 * HEADROOM);
  return Math.min(HARD_CAP, Math.max(seed, learned));
}

/** Diagnostic snapshot for bug reports: per-task sample count + observed p95. */
export function getTokenBudgetSnapshot() {
  const all = allUsage();
  const out = {};
  for (const [task, arr] of Object.entries(all)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    out[task] = {
      samples: arr.length,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
    };
  }
  return out;
}
