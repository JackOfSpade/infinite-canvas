// Persisted record of shared-profile browser-launch COLLISIONS.
//
// WHY: the one shared Chrome profile (getUserDataDir()) is OS-locked to a single
// process at a time. When a second Chrome tries to launch on it — a headless
// rescrape firing while a visible captcha-resolve window is still open, or two
// captcha-resolve windows overlapping — puppeteer.launch() fails with one of two
// distinctive errors:
//   - headless: "The browser is already running for <userDataDir>. Use a different
//     `userDataDir` or stop the running browser first."
//   - visible:  "Failed to launch the browser process: … Code: 0 … stderr:
//     Opening in existing browser session." (Chrome handed off to the existing
//     process and exited 0; puppeteer sees no debugging port → launch failure.)
//
// These errors used to live ONLY in the 60-line main-process log ring buffer, so
// a longer run scrolled them away and even a FULL bug report couldn't show that a
// profile-lock collision had happened. This module keeps a small persisted tally
// + the last few events so the bug report can surface them long after.
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
 */
export function recordLaunchCollision({ context, url = null, attempts = 1, recovered = false, error = '', ts = null } = {}) {
  _state.total += 1;
  if (recovered) _state.recovered += 1;
  _state.events.push({
    context: context || 'unknown',
    url: url || null,
    attempts: Number(attempts) || 1,
    recovered: !!recovered,
    error: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 200),
    ts,
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
