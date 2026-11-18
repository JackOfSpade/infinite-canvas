// Persisted record of shared-profile browser-launch collisions.
//
// The shared Chrome profile (getUserDataDir()) is OS-locked to one process at a
// time. A second launch on it fails with "already running for <userDataDir>"
// (headless) or "Opening in existing browser session" (visible). This module
// keeps a small tally and the last few events so a bug report can show that a
// collision happened after the main-process log ring has scrolled past it.
//
// Pure / dependency-free (no electron, no puppeteer) so it's unit-testable in the
// plain-node test runner. Callers pass `ts` (Date.now()) in rather than the module
// calling the clock, keeping it deterministic for tests.

// Both launch-failure strings that mean "another Chrome already holds the shared
// profile lock". Anything else (a real crash, a missing executable, a macOS
// permission denial) is NOT a collision and must NOT be silently retried.
const COLLISION_RE = /already running for|Opening in existing browser session/i;

/**
 * @param {unknown} err  an Error or anything stringifiable
 * @returns {boolean} true if the launch failure is a shared-profile lock collision
 */
export function isProfileLockCollision(err) {
  const msg = err?.message || String(err ?? '');
  return COLLISION_RE.test(msg);
}

const MAX_EVENTS = 12;
const _state = { total: 0, recovered: 0, events: [] };

/**
 * Record one collision occurrence.
 * @param {object} o
 * @param {string} o.context   where it happened ('headless-scrape' | 'captcha-resolve-window' | …)
 * @param {string|null} [o.url]
 * @param {number} [o.attempts] how many launch attempts it took
 * @param {boolean} [o.recovered] whether a retry eventually succeeded
 * @param {unknown} [o.error]
 * @param {number|null} [o.ts]  epoch ms (caller passes Date.now())
 * @param {boolean|null} [o.askedSingletonToYield]  whether this call asked the
 *   retained stealth-browser singleton to close so it would yield the profile;
 *   `null` means the caller did not report it, `false` means it did not ask.
 */
export function recordLaunchCollision({ context, url = null, attempts = 1, recovered = false, error = '', ts = null, askedSingletonToYield = null } = {}) {
  _state.total += 1;
  if (recovered) _state.recovered += 1;
  _state.events.push({
    context: context || 'unknown',
    url: url || null,
    attempts: Number(attempts) || 1,
    recovered: !!recovered,
    error: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 200),
    ts,
    askedSingletonToYield: askedSingletonToYield === true ? true : askedSingletonToYield === false ? false : null,
  });
  // Ring: keep only the most recent MAX_EVENTS.
  if (_state.events.length > MAX_EVENTS) _state.events.shift();
}

/** @returns {{total:number, recovered:number, events:Array}} a snapshot copy */
export function getLaunchCollisions() {
  return { total: _state.total, recovered: _state.recovered, events: _state.events.slice() };
}

// Test-only reset.
export function _resetLaunchCollisions() {
  _state.total = 0;
  _state.recovered = 0;
  _state.events = [];
}
