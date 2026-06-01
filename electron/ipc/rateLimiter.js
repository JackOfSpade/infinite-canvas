/**
 * Adaptive per-domain rate limiting & escalation.
 *
 * Replaces the old static rpm/baseCooldownMs table + fixed exponential backoff.
 * The table is now a SEED: each domain's hand-tuned cooldown is the FLOOR (the
 * fastest we'll ever hit it) and the starting point. A live `tighten` multiplier
 * (≥1) rides on top, driven by the outcome of every scrape:
 *
 *   block    (hard anti-bot: 403 / captcha / cloudflare / perimeterx / …) → tighten hard
 *   throttle (429 / "unusual traffic" / rate-limit copy)                  → tighten moderately
 *   error    (network / navigation timeout)                              → tighten lightly
 *   ok       (clean result, no anti-bot warning)                         → relax toward the floor
 *
 * `tighten` is clamped to [MIN_TIGHTEN, MAX_TIGHTEN] so adaptation is bounded:
 * it can only ever make a domain SLOWER than its seed, never faster, and never
 * runs away past the cap. Block/throttle signals come from antiBotDetector
 * (severity 'block' | 'throttle'), so soft blocks that return HTTP 200 + empty
 * now correctly back the domain off and count toward escalation — previously
 * they were recorded as plain successes.
 *
 * A global `pressure` level rises with cross-domain block/throttle signals and
 * temporarily shrinks the pool's concurrency, so when many sources turn hostile
 * at once the whole pool eases off; it decays back on clean successes.
 *
 * State is in-memory per session BY DESIGN: a block is a live condition (IP /
 * session / time-of-day), so we adapt within a run and reset on restart rather
 * than persisting a tightened state that could lock a domain out for days after
 * one bad run. (Contrast scrapeBudget.js, which persists timing because a
 * source's typical render time is stable across runs.)
 */
import { logger } from '../logger.js';

// ── Seed policies — the hand-tuned safe baseline / cooldown floor ─────────────
// `rpm` is descriptive only; the enforced knob is `baseCooldownMs` (minimum gap
// between requests to a domain). Kept for documentation and possible future use.
const DOMAIN_POLICIES = {
  'linkedin.com': { rpm: 1,  baseCooldownMs: 60000 },  // aggressively defended, daily cap
  'indeed.com':   { rpm: 5,  baseCooldownMs: 12000 },
  'glassdoor.com':{ rpm: 3,  baseCooldownMs: 20000 },  // Cloudflare-heavy
  'stockx.com':   { rpm: 3,  baseCooldownMs: 20000 },  // PerimeterX
  'ebay.com':     { rpm: 15, baseCooldownMs: 4000 },   // moderate tolerance
  'poshmark.com': { rpm: 5,  baseCooldownMs: 12000 },
  'mercari.com':  { rpm: 8,  baseCooldownMs: 8000 },
  'reverb.com':   { rpm: 10, baseCooldownMs: 6000 },
  'swappa.com':   { rpm: 10, baseCooldownMs: 6000 },
  'depop.com':    { rpm: 5,  baseCooldownMs: 12000 },
};
const DEFAULT_POLICY = { rpm: 5, baseCooldownMs: 12000 };
const DOMAIN_POLICY_ENTRIES = Object.entries(DOMAIN_POLICIES);

// ── Adaptation knobs (bounded) ────────────────────────────────────────────────
const TIGHTEN_FACTOR = { block: 2.5, throttle: 1.6, error: 1.3 }; // ×tighten on a bad outcome
const RELAX_FACTOR    = 0.8;   // ×tighten on a clean success (decays toward the floor)
const MIN_TIGHTEN     = 1;     // seed cooldown is the floor — never faster than the seed
const MAX_TIGHTEN     = 16;    // ≤16× seed cap (matches the old backoff ceiling)
const COOLDOWN_JITTER = 0.3;   // gaussian stddev as a fraction of the cooldown mean

// ── Concurrency seeds ─────────────────────────────────────────────────────────
const MAX_CONCURRENT_SEED = 3; // global simultaneous pages (seed / ceiling)
const MIN_CONCURRENT      = 1; // floor when pressure is high
// HARD invariant — never more than 1 page per domain. Running two pages against
// the same domain is itself a detectable pattern, so this is NOT adapted upward.
const MAX_PER_DOMAIN      = 1;

// Global pressure → concurrency. Each block/throttle nudges pressure up; clean
// successes bleed it off. effectiveConcurrency() = ceil(seed − pressure), floored.
const PRESSURE_PER_BLOCK    = 1;
const PRESSURE_PER_THROTTLE = 0.5;
const PRESSURE_DECAY_PER_OK = 0.5;
const MAX_PRESSURE          = MAX_CONCURRENT_SEED - MIN_CONCURRENT; // can't shrink below the floor

// ── Outcome-aware rolling window ──────────────────────────────────────────────
const HISTORY_WINDOW       = 10; // per-domain outcome history is capped to the last N attempts

// ── State (in-memory, per session) ────────────────────────────────────────────
const tighten     = new Map(); // canonicalDomain -> multiplier (≥1)
const nextAllowed = new Map(); // canonicalDomain -> earliest next-request timestamp
const history     = new Map(); // canonicalDomain -> Array<'ok'|'throttle'|'block'|'error'>
let pressure = 0;              // global, decays toward 0

export const perDomainLimit = MAX_PER_DOMAIN;

// ── Domain canonicalization ───────────────────────────────────────────────────
/** Canonicalize a raw hostname against known policy keys (e.g. 'm.ebay.com' → 'ebay.com'). */
export function getCanonicalDomain(rawDomain) {
  for (const [key] of DOMAIN_POLICY_ENTRIES) {
    if (rawDomain.includes(key)) return key;
  }
  return rawDomain;
}

/** Returns the canonical policy key for a URL. */
export function extractDomain(url) {
  try {
    return getCanonicalDomain(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return 'unknown';
  }
}

function policyFor(domain) {
  return DOMAIN_POLICIES[domain] || DEFAULT_POLICY;
}

/** Gaussian-distributed delay (more natural than uniform = less detectable). */
function gaussianDelay(mean, stddev) {
  // Clamp u1 away from 0: Math.log(0) = -Infinity → NaN → setTimeout fires
  // immediately, bypassing the limiter. Number.EPSILON is safe.
  const u1 = Math.random() || Number.EPSILON;
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1000, Math.round(mean + normal * stddev));
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Effective global concurrency cap — shrinks under sustained cross-domain pressure. */
export function effectiveConcurrency() {
  return Math.max(MIN_CONCURRENT, Math.round(MAX_CONCURRENT_SEED - pressure));
}

/** True if `domain` is still inside its cooldown window. */
export function isCoolingDown(domain) {
  const t = nextAllowed.get(domain);
  return t ? Date.now() < t : false;
}

/**
 * Soonest delay (ms) until any currently-cooling domain frees up, or null if
 * nothing is cooling. Lets the queue wake exactly when a domain becomes
 * eligible instead of polling blindly.
 */
export function nextWakeMs() {
  const now = Date.now();
  let soonest = Infinity;
  for (const t of nextAllowed.values()) {
    if (t > now && t < soonest) soonest = t;
  }
  return soonest === Infinity ? null : soonest - now;
}

/** (Re)arm a domain's cooldown from its seed × current tighten multiplier. */
function applyCooldown(domain) {
  const mult = tighten.get(domain) || 1;
  const base = policyFor(domain).baseCooldownMs;
  const jittered = gaussianDelay(base, base * COOLDOWN_JITTER);
  nextAllowed.set(domain, Date.now() + jittered * mult);
}

/**
 * Record the outcome of a scrape against a domain and adapt the limiter.
 * @param {string} domain  canonical domain (from extractDomain)
 * @param {'ok'|'throttle'|'block'|'error'} outcome
 */
export function recordOutcome(domain, outcome) {
  const cur = tighten.get(domain) || 1;
  let next;
  if (outcome === 'ok') {
    next = Math.max(MIN_TIGHTEN, cur * RELAX_FACTOR);
    pressure = Math.max(0, pressure - PRESSURE_DECAY_PER_OK);
  } else {
    next = Math.min(MAX_TIGHTEN, cur * (TIGHTEN_FACTOR[outcome] ?? TIGHTEN_FACTOR.error));
    const add = outcome === 'block' ? PRESSURE_PER_BLOCK : outcome === 'throttle' ? PRESSURE_PER_THROTTLE : 0;
    pressure = Math.min(MAX_PRESSURE, pressure + add);
  }
  tighten.set(domain, next);
  applyCooldown(domain);

  // Outcome-aware rolling window for escalation.
  const h = history.get(domain) || [];
  h.push(outcome);
  if (h.length > HISTORY_WINDOW) h.shift();
  history.set(domain, h);

  if (outcome !== 'ok') {
    const cooldownSec = Math.round((policyFor(domain).baseCooldownMs * next) / 1000);
    logger.info(`[RateLimiter] ${domain} ${outcome} → tighten ${cur.toFixed(1)}×→${next.toFixed(1)}× (~${cooldownSec}s cooldown), pressure=${pressure}, concurrency=${effectiveConcurrency()}`);
  }
}

/**
/** Diagnostic snapshot for bug reports / debugging. */
export function getRateLimiterSnapshot() {
  const domains = {};
  for (const [d, t] of tighten) {
    domains[d] = { tighten: Math.round(t * 10) / 10, recent: history.get(d) || [] };
  }
  return { pressure, effectiveConcurrency: effectiveConcurrency(), domains };
}
