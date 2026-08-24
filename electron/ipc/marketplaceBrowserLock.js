// Marketplace browser mutex — serializes every sell-side operation that takes
// over the ONE shared stealth browser / Chrome profile: a price-check comp
// scrape (`scrape-price-comps`), a single-source captcha-resolved rescrape
// (`rescrape-source`), AND a captcha-resolve window (`resolve-captcha`, which
// closes the stealth browser to hand its userDataDir to a visible Chrome).
//
// WHY: all of these drive the single shared stealth browser. Without
// serialization, a captcha-resolve on node A calls closeStealthBrowser() while
// node B's comp scrape still has pages in flight on that same browser — every
// one of B's pages dies with "Navigating frame was detached" and is mis-reported
// as a per-source anti-bot block (`task-failed`). The shared Chrome profile ALSO
// physically forbids a headless scrape while a visible captcha window holds the
// userDataDir, so these can never truly run in parallel anyway; serializing just
// makes the contention ORDERLY (queue + wait) instead of DESTRUCTIVE (detach +
// false block). The user's symptom for the un-serialized version: "queue went
// next before the previous price check was completely done."
//
// DELIBERATELY separate from the other two browser queues:
//   - statusCheckLock (buy-side listing status checks) settles on bounded fetch
//     timeouts and must NOT wait behind an indefinite captcha-wait — see
//     statusCheckLock.js for exactly why those two were kept apart.
//   - withSharedProfileLock guards job scrapers that own a separate Chrome
//     PROCESS; sell-side ops share the one persistent stealth browser via tabs.
//
// Unlike statusCheckLock, THIS queue CAN be held across an indefinite captcha
// wait (a resolve window the user hasn't solved/closed). That is acceptable —
// the visible window holds the profile, so no scrape could run during it anyway,
// and the window is on-screen and user-dismissable. To keep a wedged head from
// trapping a still-cancellable price check, withMarketplaceBrowserLock checks the
// caller's AbortSignal at turn-start and bails WITHOUT running fn if aborted, so
// a cancelled price check that queued behind a long captcha-resolve never wastes
// a scrape pass.
//
// Kept dependency-free (no electron / puppeteer imports) so it is unit-testable
// in the plain-node test runner.
//
// Implementation shared with sharedProfileLock.js / statusCheckLock.js — see
// asyncMutex.js for the FIFO + reentrancy-guard mechanics.
import { createFifoLock } from './asyncMutex.js';

const lock = createFifoLock({ name: 'marketplaceBrowserLock', supportsAbort: true });

/**
 * Run `fn` exclusively with respect to all other withMarketplaceBrowserLock
 * callers, in FIFO order. Returns fn()'s result (or rejection). A rejected (or
 * resolved) fn does NOT wedge the queue — the next caller still runs.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {{ aborted?: boolean } | null} [signal] optional AbortSignal — if it is
 *   already aborted when this caller reaches the head of the queue, fn is NOT run
 *   and the returned promise rejects with an AbortError. Lets a cancelled price
 *   check that queued behind a long captcha-resolve drop out without scraping.
 * @returns {Promise<T>}
 */
export function withMarketplaceBrowserLock(fn, signal = null) {
  return lock.withLock(fn, signal);
}

/**
 * Current number of enqueued-but-unsettled marketplace browser ops (running +
 * waiting). Read it BEFORE calling withMarketplaceBrowserLock to learn how many
 * are already ahead of the caller (the "queued behind N" banner / log).
 * @returns {number}
 */
export function getMarketplaceBrowserQueueDepth() {
  return lock.getQueueDepth();
}
