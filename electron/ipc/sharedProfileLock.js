// Shared-profile mutex — serializes everything that launches a Chrome on the
// ONE shared stealth-browser profile directory (getUserDataDir()).
//
// WHY: Chrome OS-locks a userDataDir per process, so only one browser may run on
// the shared profile at a time. The two browser-based job-scrape launchers —
// scrapeManualSources (Google / ZipRecruiter / Glassdoor) and
// fetchIndeedListingsBrowser (Indeed) — are dispatched CONCURRENTLY by jobs.js
// (`Promise.all([scrapeManualSources(...), fetchApiSources(...)])`, and Indeed
// lives inside fetchApiSources). Without serialization they race the profile
// lock. Serializing each launcher's whole launch→scrape→close makes the browser
// job scrapes run strictly in sequence and prevents profile-lock collisions.
//
// Pure-HTTP job sources (LinkedIn guest API, RemoteOK, WeWorkRemotely, USAJobs,
// Dice) never touch the profile and MUST NOT acquire this — they stay fully
// concurrent. Dice's API-key refresh is also exempt: it uses an isolated /tmp
// profile, not the shared dir.
//
// Any FUTURE code that launches a browser on the shared profile should wrap its
// launch→close lifetime in withSharedProfileLock() too.
//
// Kept dependency-free (no electron / puppeteer imports) so it is unit-testable
// in the plain-node test runner.
//
// Implementation shared with marketplaceBrowserLock.js / statusCheckLock.js —
// see asyncMutex.js for the FIFO + reentrancy-guard mechanics.
import { createFifoLock } from './asyncMutex.js';

// Browser work may sit behind a long-running visible login or scrape. Make
// acquisition abort-aware so Reset/delete can remove a queued card before it
// ever opens Chrome, while preserving the legacy one-argument call sites.
const lock = createFifoLock({ name: 'sharedProfileLock', supportsAbort: true });

/**
 * Run `fn` exclusively with respect to all other withSharedProfileLock callers,
 * in FIFO order. Returns fn()'s result (or rejection) to the caller. A rejected
 * (or resolved) fn does NOT wedge the queue — the next caller still runs.
 *
 * NOTE: serialization is bounded by each fn settling. A launcher that hangs
 * forever would stall the queue; callers rely on their own scrape timeouts /
 * abort signals to guarantee fn eventually settles.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {AbortSignal|null} [signal] - optional cancellation while queued
 * @returns {Promise<T>}
 */
export function withSharedProfileLock(fn, signal = null) {
  return lock.withLock(fn, signal);
}
