// Status-check mutex — serializes every listing status check (the per-card
// "Check" and the hub's "Check All") across the whole app, regardless of which
// hub or card fired it.
//
// WHY: a single Check-All loop is already sequential (useCheckAllConnected.js),
// but nothing stops TWO Check-Alls (two different hubs) — or a per-card "Check"
// during a Check-All — from running concurrently. Each status check fans out to
// the listing URL + the platform's watch/dashboard URLs through the seller's
// ONE residential IP, and marketplaces rate-limit single-IP bursts hard. Two
// overlapping checks double that burst, which surfaces as false "needs-login" /
// captcha / soft-block verdicts (the exact failure the sequential loop was built
// to avoid). Serializing every check end-to-end keeps the burst at one check's
// worth no matter how many the user kicks off.
//
// This is DELIBERATELY a separate queue from withSharedProfileLock():
//   - sharedProfileLock guards separate browser PROCESSES contending for the
//     OS-locked userDataDir (job scrapers that launch+pkill their own Chrome).
//   - Status checks share the ONE persistent stealth browser via tabs and never
//     pkill, so they can't hit that process/profile hazard. Their problem is
//     purely the rate-limit burst above. Reusing the profile lock would also
//     over-serialize: it would throttle a SINGLE check's internal parallel URL
//     fetches against unrelated job scrapes for no benefit.
//
// Each check settles on its own fetch timeouts (fetchHtmlAuthed ~25s/url), so a
// queued check waits at most a bounded number of those — it cannot wedge here
// the way an indefinite captcha-wait scrape could.
//
// Kept dependency-free (no electron / puppeteer imports) so it is unit-testable
// in the plain-node test runner.
//
// Implementation shared with sharedProfileLock.js / marketplaceBrowserLock.js —
// see asyncMutex.js for the FIFO + reentrancy-guard mechanics.
import { createFifoLock } from './asyncMutex.js';

const lock = createFifoLock({ name: 'statusCheckLock', supportsAbort: true });

/**
 * Run `fn` exclusively with respect to all other withStatusCheckLock callers,
 * in FIFO order. Returns fn()'s result (or rejection). A rejected (or resolved)
 * fn does NOT wedge the queue — the next caller still runs.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {{ aborted?: boolean } | null} [signal] optional AbortSignal — if it is
 *   already aborted when this caller reaches the head of the queue, fn is NOT run.
 * @returns {Promise<T>}
 */
export function withStatusCheckLock(fn, signal = null) {
  return lock.withLock(fn, signal);
}

/**
 * Current number of enqueued-but-unsettled status checks (running + waiting).
 * Read it BEFORE calling withStatusCheckLock to learn how many are already
 * ahead of the caller. Used only for diagnostics/logging.
 * @returns {number}
 */
export function getStatusCheckQueueDepth() {
  return lock.getQueueDepth();
}
