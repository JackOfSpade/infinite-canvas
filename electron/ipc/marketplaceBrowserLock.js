// Marketplace browser lock. Every sell-side operation that takes over the one
// shared stealth browser / Chrome profile runs through it: a price-check comp
// scrape (`scrape-price-comps`), a single-source captcha-resolved rescrape
// (`rescrape-source`), and a captcha-resolve window (`resolve-captcha`, which
// closes the stealth browser to hand its userDataDir to a visible Chrome).
//
// These are not a separate queue. They share the profile-wide FIFO in
// sharedProfileLock.js with the job scrapers, because job work owns a fresh
// Chrome process while marketplace work uses the retained browser, yet both
// touch the same userDataDir and either can close or release it for a visible
// challenge window. Without that ordering a captcha-resolve on one node would
// close the browser while another node's scrape still had pages in flight, and
// every one of those pages would die with "Navigating frame was detached" and
// be reported as a per-source anti-bot block.
//
// The buy-side status check has its own lock (statusCheckLock.js) because it
// settles on bounded fetch timeouts and must not wait behind an indefinite
// captcha wait. This lock can be held across one, which is acceptable because
// the visible window holds the profile anyway. A caller whose signal is already
// aborted when it reaches the head of the queue is dropped without running, so a
// cancelled price check never wastes a scrape pass.
import { getSharedProfileLockSnapshot, withSharedProfileLock } from './sharedProfileLock.js';

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
export function withMarketplaceBrowserLock(fn, signal = null, label = 'marketplace browser workflow') {
  // This is intentionally a thin alias rather than a second lock. Nesting it
  // under withSharedProfileLock (or vice versa) is detected by the one lock's
  // existing reentrancy guard instead of silently deadlocking.
  return withSharedProfileLock(fn, signal, label);
}

/**
 * Current number of enqueued-but-unsettled marketplace browser ops (running +
 * waiting). Read it BEFORE calling withMarketplaceBrowserLock to learn how many
 * are already ahead of the caller (the "queued behind N" banner / log).
 * @returns {number}
 */
export function getMarketplaceBrowserQueueDepth() {
  return getSharedProfileLockSnapshot().queueDepth;
}
