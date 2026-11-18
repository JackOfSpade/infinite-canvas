/**
 * Static per-source configuration and the pure, page-free decision rules the
 * manual scraper's walk is built on: timing, selectors, description configs,
 * pacing, stop reasons, page caps, detail-block re-probe policy, walk guards and
 * provider-total-shortfall policy. A leaf module: it imports no sibling.
 */

import { JOB_COLLECTION_AUTO_LIMITS, normalizeJobCollectionLimits, resolveBrowserPageBudgets } from '../../../../src/utils/jobCollectionLimits.js';
import { filterJobsByPostedSince } from '../../jobDateFilter.js';
import { sourceJobKey } from '../../../../src/utils/jobIdentity.js';

// ── Timing ────────────────────────────────────────────────────────────────────
export const NAV_SETTLE_MS          = 2000;          // settle after navigation before first action

export const CONTENT_POLL_MS        = 600;           // poll interval while waiting for content/challenge

export const CONTENT_TIMEOUT_MS     = 20_000;        // max wait for content before proceeding anyway

// Auto/All resolves to the highest value a person can type, so a ceiling at or
// above these is OUR safety net, not a limit the user chose. Hitting one is a
// guard worth showing; an explicit number stays a quiet finish.
export const UNLIMITED_PAGE_BACKSTOP = JOB_COLLECTION_AUTO_LIMITS.pagesPerQuery;

export const UNLIMITED_JOB_BACKSTOP = JOB_COLLECTION_AUTO_LIMITS.jobsPerPlatform;

export const DESC_CHANGE_POLL_MS    = 200;           // poll interval waiting for description panel update

export const DESC_CHANGE_TIMEOUT_MS = 3_000;         // max wait for description to change after a card click

export const DESC_RETRY_PAUSE_MS    = 900;           // pause before re-clicking when the first attempt's panel never updated (catches transient anti-bot 403s)

export const DESC_CLICK_DELAY_MS    = 600;           // pause between card clicks (natural pacing)

export const SITE_CHANGED_ABORT_THRESHOLD = 3;

export const DESC_STALE_THRESHOLD   = 3;             // consecutive click/panel failures before flagging stale selectors

// A source-wide detail block (panel 429 / repeated panel HTTP errors) used to
// last for the whole remaining source: one throttle on page 11 meant pages
// 12-30 were walked with zero descriptions and every row deferred unscored.
// Give the throttle a bounded cooldown, then let ONE normal expansion attempt
// act as the probe — expandDescriptions already stops at its first blocked
// panel, so a still-throttled retry costs a single card, never a page-wide
// hammer (the per-listing no-retry rule in descriptionPanelRetryAllowed stays
// intact). The re-probe cap bounds a long walk that keeps re-arming.
export const DETAIL_BLOCK_COOLDOWNS_MS = Object.freeze([120_000, 300_000, 600_000]);

/** Measured on Glassdoor: 2 minutes' rest bought 0-24 requests before the next 429, so failed tries in one block wait longer. A recovery starts again from 2 minutes. */
export function detailBlockCooldownMs(reprobesSoFar) {
  const index = Math.max(0, Math.floor(Number(reprobesSoFar) || 0));
  return DETAIL_BLOCK_COOLDOWNS_MS[Math.min(index, DETAIL_BLOCK_COOLDOWNS_MS.length - 1)];
}

export const DETAIL_BLOCK_MAX_REPROBES = 3;

// Warnings that pause detail reads for a cooldown while the list walk goes on.
export const DETAIL_BLOCK_WARNING_CODES = Object.freeze([
  'description-rate-limited',
  'description-panel-http-error',
  'description-panel-unresponsive',
]);

// Per-episode re-probes above bound ONE block; a walk that recovers and blocks
// again can re-arm them for every page, which is what made a long source sit on
// cooldowns until the walk ran out of pages. This is the per-SOURCE budget: once
// it is gone, later pages keep their rows deferred exactly as they would at the
// per-episode cap, and the walker files a 'detail-retry-cap' guard.
export const DETAIL_BLOCK_MAX_TOTAL_REPROBES = 6;

// Cards a cooldown re-probe may touch. MUST stay below DESC_STALE_THRESHOLD:
// a silent throttle surfaces as panel timeouts, and that many in a row trips
// abortWithError, which would turn an external rate limit into a bogus
// "stale selectors" error and end the source walk.
export const DETAIL_BLOCK_PROBE_CARDS = 2;

// Cooldown BETWEEN queries (not before the first). Firing N back-to-back
// full-page navigations to different search URLs is a velocity signal that
// anti-bot systems flag — a human-scale pause between them lowers that signal.
// All values are anchors fed through humanDelay() at the call site, so the
// actual wait is organically spread (never a fixed cadence).
export const DEFAULT_INTER_QUERY_COOLDOWN_MS = 2500;

// ── Per-source configs ────────────────────────────────────────────────────────
export const SOURCE_LABELS = {
  google:       'Google for Jobs',
  ziprecruiter: 'ZipRecruiter',
  glassdoor:    'Glassdoor',
};

/** Sleep that returns early if the run is cancelled. Never rejects. */
export function sleepUnlessAborted(ms, signal) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  if (wait === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
    const timer = setTimeout(done, wait);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Warning for a source whose own Chrome disconnected before its walk ended.
 * States the observation only: the cause (crash, sleep, a closed window) is
 * not known here.
 */
export function browserClosedWarning({ srcName, unreadQueries = 0, queryTotal = 0 } = {}) {
  const unread = unreadQueries > 0
    ? ` ${unreadQueries} of ${queryTotal} search${queryTotal === 1 ? '' : 'es'} had not started.`
    : '';
  return {
    code: 'browser-closed',
    severity: 'block',
    evidence: `The ${srcName} browser window closed before the search finished, so its results are incomplete.${unread}`,
    suggestion: `Run ${srcName} again to read the rest. The jobs found before the window closed are kept.`,
  };
}

// Keep terminal causes separate from the generic "completed" outcome.  In
// particular, FAST mode can intentionally stop a source after its aggregate
// result cap; reporting that as a normal completion makes a breadth-limited
// search indistinguishable from an exhausted one.
export function resolveManualSourceStopReason({
  earlyExit = false,
  aborted = false,
  browserClosed = false,
  sourceSkipped = false,
  detailEnrichmentFailed = false,
  hitPerSourceCap = false,
  hitPageCap = false,
  hitEmptyPage = false,
  hitPageTurnStalled = false,
  hitUnhandledPagination = false,
  hitChallengeRecoveryLoop = false,
  hitProviderResultWindow = false,
  hitProviderTotalShortfall = false,
  dataStopReason = null,
} = {}) {
  if (sourceSkipped) return 'blocked';
  if (aborted) return 'aborted';
  // A detail-card failure is an internal scraper failure, not a user action.
  // `earlyExit` remains the legacy umbrella for several exits, but reporting
  // this one as `user-done` hid the actual cause in both the source trail and
  // the bug report.
  if (detailEnrichmentFailed) return 'detail-enrichment-failed';
  // The source's own Chrome went away mid-walk (a crash, a sleep/wake that
  // killed it, or the window being closed). Nothing here ran out of results,
  // so it must never share a reason with a finished walk.
  if (browserClosed) return 'browser-closed';
  // `earlyExit` has historically meant a user-done / source-local stop, not
  // necessarily an AbortSignal. Keep that public result enum stable; callers
  // pass `aborted` only for an actual cancelled signal.
  if (earlyExit) return 'user-done';
  if (hitPerSourceCap) return 'per-source-cap';
  // An enabled next control with no successful action is proof that this run
  // stopped before the board's end. Keep it distinct from a normal completion
  // and from a user-configured page cap so the report states the real cause.
  if (hitUnhandledPagination) return 'pagination-unhandled';
  // A challenge that bounced the walk back to page 1 twice ends it with the
  // pages past the challenge never read. Ranked ABOVE the data-driven stops
  // because age-window / no-new-jobs / end-of-results all read as clean,
  // complete finishes and would hide a walk that gave up.
  if (hitChallengeRecoveryLoop) return 'challenge-recovery-loop';
  // The board stopped linking later pages and a direct continuation request
  // was redirected/clamped somewhere else. This is a provider result-window
  // boundary, not proof that the advertised corpus was exhausted.
  if (hitProviderResultWindow) return 'provider-result-window';
  // ZipRecruiter's query-string result header is the one browser-board total we
  // have verified against a full walk. An empty page before that total is an
  // observation about this pager, not proof that every advertised candidate was
  // reached. Keep it distinct from `empty-page`, which downstream correctly
  // treats as a lossless terminal condition when no contrary total exists.
  if (hitProviderTotalShortfall) return 'provider-total-shortfall';
  // A data-driven stop (age-window / no-new-jobs, from makeJobPageStop via
  // task.options.onPageScraped) means the walk ended because the DATA said
  // stop, not because it was cut short by the hub's page ceiling — surface it
  // under its own reason so bug reports never read a complete, data-driven
  // finish as the `page-cap` "this source may have additional in-window jobs"
  // warning (see bugReport/jobsSnapshot.js's stopReason flagging).
  if (dataStopReason) return dataStopReason;
  if (hitPageCap) return 'page-cap';
  // A page turn that never landed is NOT the end of the results. Reporting it
  // as `empty-page` would assert the board ran out when all we established is
  // that our own click did not navigate — and `empty-page` is treated
  // downstream as a clean, terminal, lossless finish. Ranked above empty-page
  // so the specific observation wins over the generic one.
  if (hitPageTurnStalled) return 'page-turn-stalled';
  if (hitEmptyPage) return 'empty-page';
  return 'completed';
}

// The manual scraper returns one aggregate result per source, while its tasks
// are one per generated query.  Preserve the *sum* of Auto's allocated query
// budgets as the source cap, not a misleading single-query 10-page value.
// Explicit Pages intentionally remains a per-query setting and is reported as
// that configured value.  This is a pure seam because a headed browser test is
// neither necessary nor reliable for verifying receipt metadata.
export function manualPageCapForTasks(sourceTasks, collectionLimits) {
  const limits = normalizeJobCollectionLimits(collectionLimits);
  if (limits.pagesPerPlatform != null) {
    return { type: 'pages-per-platform', limit: limits.pagesPerPlatform };
  }
  const taskCount = Array.isArray(sourceTasks) ? sourceTasks.length : 0;
  const allocated = resolveBrowserPageBudgets(limits, taskCount)
    .reduce((sum, pages) => sum + pages, 0);
  return allocated > 0 ? { type: 'auto-pages-per-platform', limit: allocated } : null;
}

/**
 * Pick this browser page's contribution to a source-wide platform allowance.
 * The caller has normally already de-duped cards against prior pages/queries;
 * retain the small identity guard here as well so this safety boundary remains
 * correct when a provider repeats cards in a single extraction payload.
 */
export function selectManualSourcePageJobs(newJobs, existingJobs, jobsPerPlatform, collectionStartTimestamp, stats = null) {
  const existingKeys = new Set((Array.isArray(existingJobs) ? existingJobs : [])
    .map(sourceJobKey));
  const unique = [];
  for (const job of Array.isArray(newJobs) ? newJobs : []) {
    const key = sourceJobKey(job);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    unique.push(job);
  }
  const eligible = filterJobsByPostedSince(unique, collectionStartTimestamp);
  // This window drop keeps undated cards and removes dated ones, so the rows it
  // returns are biased. Count the drops for callers that measure `posted`.
  if (stats && typeof stats === 'object') {
    const prior = Number.isFinite(Number(stats.windowDropped)) ? Math.max(0, Number(stats.windowDropped)) : 0;
    stats.windowDropped = prior + Math.max(0, unique.length - eligible.length);
  }
  const limit = Number.isFinite(Number(jobsPerPlatform)) && Number(jobsPerPlatform) > 0
    ? Math.floor(Number(jobsPerPlatform))
    : Infinity;
  return eligible.slice(0, Math.max(0, limit - (Array.isArray(existingJobs) ? existingJobs.length : 0)));
}

/**
 * Split a page's rows by what `isAlreadyRead` says about each: 'read' (an
 * earlier blocked run of this platform read its description), 'shown' (it was
 * already shown on an earlier run), or nothing (open it). A test that throws
 * keeps the row, so a fault in the lookup costs one extra detail request, never
 * a listing. `true` counts as 'read'.
 */
export function partitionAlreadyReadJobs(jobs, isAlreadyRead) {
  const rows = Array.isArray(jobs) ? jobs : [];
  if (typeof isAlreadyRead !== 'function') return { open: rows, readEarlier: 0, shownEarlier: 0 };
  const open = [];
  let readEarlier = 0;
  let shownEarlier = 0;
  for (const job of rows) {
    let verdict = null;
    try { verdict = isAlreadyRead(job); } catch { verdict = null; }
    if (verdict === 'shown') shownEarlier++;
    else if (verdict === 'read' || verdict === true) readEarlier++;
    else open.push(job);
  }
  return { open, readEarlier, shownEarlier };
}

/** The rows of a page that still have to be opened. */
export function withoutAlreadyReadJobs(jobs, isAlreadyRead) {
  return partitionAlreadyReadJobs(jobs, isAlreadyRead).open;
}

/**
 * A cooldown re-probe proves the previous detail throttle has lifted only when
 * it produced an actual terminal outcome: either an expanded description or a
 * listing conclusively retired as unavailable. An ordinary zero-description
 * probe is ambiguous and must keep the block armed.
 */
export function didDetailBlockReprobeRecover(result = {}) {
  const expanded = Math.max(0, Number(result.expandedCount) || 0);
  // A listing the board reported closed (kept, flagged for the official-posting
  // resolver) is the same terminal proof as one retired outright.
  const unavailable = Math.max(0, Number(result.unavailableDetailDropped) || 0)
    + Math.max(0, Number(result.boardClosedDetailKept) || 0);
  const reBlocked = DETAIL_BLOCK_WARNING_CODES.includes(result.descWarning?.code);
  return (expanded > 0 || unavailable > 0) && !result.descError && !reBlocked;
}

/**
 * Preserve every safe aggregate while joining the small cooldown probe with
 * the rest of its page. The unsuccessful branch intentionally leaves the
 * untouched rows deferred, but never drops listings the probe conclusively
 * retired as unavailable.
 */
export function composeDetailBlockReprobeResult(probeResult = {}, restResult = null, restJobs = [], reprobeOfCode = null) {
  const probeJobs = Array.isArray(probeResult.jobs) ? probeResult.jobs : [];
  const probeExpanded = Math.max(0, Number(probeResult.expandedCount) || 0);
  const probeUnavailable = Math.max(0, Number(probeResult.unavailableDetailDropped) || 0);
  const probeBoardClosed = Math.max(0, Number(probeResult.boardClosedDetailKept) || 0);
  if (didDetailBlockReprobeRecover(probeResult)) {
    const rest = restResult || {};
    return {
      jobs: [...probeJobs, ...(Array.isArray(rest.jobs) ? rest.jobs : [])],
      descError: rest.descError || null,
      descWarning: rest.descWarning || probeResult.descWarning || null,
      expandedCount: probeExpanded + Math.max(0, Number(rest.expandedCount) || 0),
      attemptedCount: Math.max(0, Number(probeResult.attemptedCount) || 0)
        + Math.max(0, Number(rest.attemptedCount) || 0),
      unavailableDetailDropped: probeUnavailable + Math.max(0, Number(rest.unavailableDetailDropped) || 0),
      boardClosedDetailKept: probeBoardClosed + Math.max(0, Number(rest.boardClosedDetailKept) || 0),
    };
  }
  return {
    jobs: [
      ...probeJobs,
      ...(Array.isArray(restJobs) ? restJobs : []).map(job => ({
        ...job,
        descriptionDeferredReason: reprobeOfCode,
      })),
    ],
    descError: null,
    descWarning: probeResult.descWarning || probeResult.descError || null,
    expandedCount: probeExpanded,
    attemptedCount: Math.max(0, Number(probeResult.attemptedCount) || 0),
    unavailableDetailDropped: probeUnavailable,
    boardClosedDetailKept: probeBoardClosed,
  };
}

// Selector confirming real page content is present (vs bot-challenge page).
// null = no reliable selector; skip content check, rely solely on challenge detection.
export const CONTENT_SELECTORS = {
  // Jobs widget selectors first; plain SERP selectors (#rcnt, #search, .srp) are fallbacks
  // so a loaded page with no jobs panel is treated as "ready" immediately instead of
  // burning the full CONTENT_TIMEOUT_MS (20s) before proceeding with 0 results.
  google:       '.EimVGf, [jscontroller="b11o3b"], #rcnt, #search, .srp',
  ziprecruiter: null,   // JSON-LD tag exists on challenge pages too; extractor validates
  glassdoor:    '[data-test="jobListing"], .JobCard_jobCardWrapper',
};

// Selector for the "Next page" control (null = no auto-pagination for this source).
// These need validation in-browser — flag any that don't work.
export const NEXT_PAGE_SELECTORS = {
  google:       null,
  // ZipRecruiter changed from scroll-loading results to a conventional pager.
  // The current control is an anchor (`<a title="Next Page">`), rather than a
  // button, so it must be clicked as part of the regular pagination loop.
  ziprecruiter: 'a[title="Next Page"]',
  // Glassdoor has no pager: its Next.js rewrite replaced it with an in-page
  // "Show more jobs" append, and its `?p=N` param is ignored. The old
  // `button[data-test="pagination-next"]` here matched nothing, and a
  // no-control result was indistinguishable from a finished board — so every
  // Glassdoor search silently ended after its first ~30 rows and reported
  // `completed`. Its advance control now comes from the task's
  // `loadMoreSelector` (set in jobs.js) and runs through clickLoadMore.
  glassdoor:    null,
};

// Sources that load more jobs by scrolling to the bottom (infinite scroll).
// Google for Jobs (ibp=htl;jobs mode) lazy-loads more cards as you scroll — initial
// render is ~10 cards; scrolling reveals the rest before we run the extractor.
export const SCROLL_SOURCES = new Set(['google']);

// Per-source config for clicking cards to expand full job descriptions.
// null = source doesn't support card-click description expansion.
//
//   keyParam      — URL query param holding the job's unique key (mutually exclusive with keyRegex/keyField)
//   keyRegex      — regex string (1 capture group) to extract key from URL path instead of a param
//   keyField      — if set, read key directly from job[keyField] (bypasses URL parsing entirely)
//   keyDecode     — whether to decodeURIComponent the extracted key
//   cardAttr      — if set, find card via [cardAttr="{key}"] querySelector
//   cardIdPrefix  — if set (cardAttr/cardHrefKey null), find card via getElementById(prefix + key)
//   cardHrefKey   — if set (others null), find card via a[href*="{cardHrefKey}{key}-"]
//   cardDataUrlParam — stable result-card identity carried in its data-share-url
//   clickSelector — element to click within the found card; null = click card itself
//   panelSelector — CSS selector for the description panel that updates after each click
//   panelMulti    — if true, querySelectorAll + join textContent (for split-element panels)
//   closeSelector — if set, click this after reading to close a modal before the next card
export const DESC_CONFIGS = {
  google: {
    keyParam:      'htidocid',
    keyRegex:      null,
    keyDecode:     true,
    cardAttr:      null,
    cardIdPrefix:  '',           // legacy fallback: getElementById(key) = the clickable element
    cardHrefKey:   null,
    // Google's virtualized list can replace the element ID while its surrounding
    // result card remains mounted. data-share-url carries the same stable key.
    cardDataUrlParam: 'htidocid',
    clickSelector: null,
    panelSelector: 'span.OOyDTc, span.ejCXj',
    panelMulti:    true,         // description split across visible + hidden spans
    closeSelector: null,
    // Detail panels are separate network requests. At the old generic 600ms
    // cadence Google reliably returned HTTP 429 near the end of a 30–40 card
    // page. Use a minimum human-scale gap and periodically let the rolling
    // request window drain; list extraction remains fast and is never retried.
    clickDelayMs: 3000,
    panelCooldownEvery: 8,
    panelCooldownMs: 15000,
  },
  ziprecruiter: {
    keyParam:      'jid',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      null,
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    // ItemList JSON-LD gives us the individual job page URL directly, so navigate
    // there instead of card-clicking on the virtualized list page.
    // JSON-LD JobPosting.description (server-rendered) is tried first; panelSelector
    // is a CSS fallback in case the ld+json block is absent.
    // ZipRecruiter uses Tailwind CSS — no semantic class names. The description container
    // uniquely carries the `whitespace-pre-line` utility token; fallbacks are legacy selectors.
    // `.jobdesciption` is Trakstar Hire's live (misspelled) container. ZR can
    // send an external Trakstar apply URL whose visible application form hides
    // this node; normalizeDetailNavigationUrl() below switches only that ATS to
    // its ordinary detail view before these selectors run.
    panelSelector: '[class~="whitespace-pre-line"], .jobDescriptionSection, [data-testid="jobDescriptionSection"], #job-description-container, [class*="jobDescription"], .job_description, .jobdesciption, #job_desc',
    panelMulti:    false,
    closeSelector: null,
    expandViaNavigation: true,
    navUrlField:         'url',  // job.url is already the individual job page
    jsonLdType:          'JobPosting',
    jsonLdField:         'description',
    // ZR pay is a client-rendered "Estimated pay" chip — not in the ItemList or
    // JSON-LD — so read it from the live DOM by money-text pattern during enrichment.
    salaryFromDom:       true,
    // __NEXT_DATA__ fallback — path will be confirmed/corrected from desc-miss diag log.
    nextDataField:       'props.pageProps.job.description',
  },
  glassdoor: {
    keyParam:      'jl',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jobid',
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    // Keep enrichment on the successful search document. Direct navigation to
    // an otherwise-valid www.glassdoor.ca detail URL can itself trigger
    // Glassdoor's Turnstile → terminal "Humans only" sequence. Clicking the
    // list card asks the site's own SPA to populate its right-side panel without
    // opening a fresh detail document. This was the app's original Glassdoor
    // strategy and avoids turning one empty list snippet into a session block.
    panelSelector: '[data-brandviews*="joblisting-description"], [class*="JobDetails_jobDescription"]',
    panelMulti:    false,
    closeSelector: null,
    // The panel request is network-backed. The 2026-08-25 diagnostic showed
    // 10 successful requests in roughly 20 seconds followed by an HTTP 429;
    // 1.5s was still a burst, not human reading cadence. Space requests well
    // apart and let the endpoint's rolling window recover before request nine.
    clickDelayMs: 4500,
    panelCooldownEvery: 8,
    panelCooldownMs: 12000,
    // The click gap is not what trips the throttle. On 2026-11-11, at three
    // times the August gap, Glassdoor still allowed only 11-13 requests before
    // a 429, the same as at 1.5s. After a 429, 2 minutes' rest gave 0 of 4
    // probes and 5 minutes gave 5 of 5 full recoveries. That is a request
    // count in a window of about 3-5 minutes, so cap the count instead: at most
    // 10 panel requests in any 5 minutes, across every page and query.
    panelWindowMs: 300_000,
    panelWindowMax: 10,
  },
};

/**
 * How long to wait before the next panel request so a source stays under its
 * rolling request budget. Drops timestamps that left the window from
 * `requestTimes` in place. Returns 0 for a source with no budget.
 */
export function panelWindowWaitMs(sourceId, requestTimes, now = Date.now()) {
  const cfg = DESC_CONFIGS[sourceId] || {};
  const windowMs = Math.max(0, Number(cfg.panelWindowMs) || 0);
  const max = Math.max(0, Math.floor(Number(cfg.panelWindowMax) || 0));
  if (!windowMs || !max || !Array.isArray(requestTimes)) return 0;
  while (requestTimes.length && now - requestTimes[0] >= windowMs) requestTimes.shift();
  if (requestTimes.length < max) return 0;
  return Math.max(0, requestTimes[requestTimes.length - max] + windowMs - now);
}

/**
 * Decide whether a source is permitted to open an individual posting while
 * enriching descriptions. This is deliberately separate from ordinary search,
 * location-lookup, and user-facing Solve navigation: those actions keep their
 * existing Glassdoor URLs and are not detail enrichment.
 *
 * Glassdoor has one safe enrichment shape: stay on the already-loaded result
 * document and let its own card click populate the side panel. A direct detail
 * document request, even to the same first-party host, has repeatedly caused a
 * Turnstile → text-only "Humans only" escalation. Keep this source-level so a
 * future config edit cannot silently turn an empty panel into a `goto()` loop.
 */
export function descriptionNavigationDecision(sourceId, rawUrl) {
  if (sourceId === 'glassdoor') {
    return {
      allowed: false,
      reason: 'glassdoor-list-card-panel-only',
      url: String(rawUrl || '').trim(),
    };
  }
  if (sourceId !== 'ziprecruiter') {
    return { allowed: true, reason: 'source-has-no-detail-navigation-restriction', url: String(rawUrl || '').trim() };
  }
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const allowed = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return {
      allowed,
      reason: allowed ? 'http-detail-url' : 'unsupported-detail-scheme',
      url: parsed.toString(),
    };
  } catch {
    return { allowed: false, reason: 'malformed-detail-url', url: String(rawUrl || '').trim() };
  }
}

/** The network shape used to recover a source's full job descriptions. */
export function descriptionExpansionStrategy(sourceId) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg) return 'none';
  // This is an intentional hard guard, not merely the current config shape.
  // If someone later restores `expandViaNavigation`/`navUrlField` while trying
  // to repair a selector, Glassdoor still remains on the successful list page.
  if (sourceId === 'glassdoor') return cfg.panelSelector ? 'list-card-panel' : 'none';
  if (cfg.expandViaNavigation && (cfg.navUrlTemplate || cfg.navUrlField)) return 'detail-navigation';
  return cfg.panelSelector ? 'list-card-panel' : 'none';
}

/**
 * Deterministic per-source pacing for list-card panel requests.
 *
 * `requestsIssued` counts actual mouse clicks which may cause the board's
 * detail API to run (including a bounded retry), rather than list rows. This
 * lets a configured source cool down before the next request after every small
 * burst, while unconfigured sources preserve their existing walk cadence.
 */
export function descriptionPanelPacing(sourceId, requestsIssued = 0) {
  const cfg = DESC_CONFIGS[sourceId] || {};
  const requestDelayMs = Math.max(0, Number(cfg.clickDelayMs) || DESC_CLICK_DELAY_MS);
  const every = Math.max(0, Number(cfg.panelCooldownEvery) || 0);
  const checkpointDue = every > 0
    && Number(requestsIssued) > 0
    && Number(requestsIssued) % every === 0;
  const checkpointCooldownMs = Math.max(0, Number(cfg.panelCooldownMs) || 0);
  return {
    requestDelayMs,
    checkpointDue,
    // Keep configured pacing visible in card-walk telemetry even before the
    // first checkpoint is due. The executor gates the actual wait on
    // `checkpointDue`; diagnostic output must not incorrectly imply that the
    // checkpoint policy was absent just because this batch stopped early.
    checkpointCooldownMs,
    checkpointEvery: every || null,
    windowMs: Math.max(0, Number(cfg.panelWindowMs) || 0) || null,
    windowMax: Math.max(0, Math.floor(Number(cfg.panelWindowMax) || 0)) || null,
  };
}

/**
 * Attribute an asynchronous panel failure to the last request that could have
 * caused it. `startIndex` is zero-based, matching the enrichment loop and the
 * deferred-row slice. A fallback keeps the helper safe before the first click.
 */
export function descriptionPanelFailureAttribution(lastRequest, {
  startIndex = 0,
  key = '',
  title = '',
} = {}) {
  const fallback = {
    startIndex: Math.max(0, Math.trunc(Number(startIndex) || 0)),
    key: String(key || ''),
    title: String(title || ''),
  };
  if (!lastRequest || !Number.isFinite(Number(lastRequest.startIndex))) return fallback;
  return {
    startIndex: Math.max(0, Math.trunc(Number(lastRequest.startIndex))),
    key: String(lastRequest.key || fallback.key),
    title: String(lastRequest.title || fallback.title),
  };
}

/** Glassdoor panel enrichment is intentionally single-request per listing. */
export function descriptionPanelRetryAllowed(sourceId) {
  return sourceId !== 'glassdoor';
}

export async function waitForAbortableDelay(ms, signal) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (!signal?.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 500)));
  }
  return false;
}

/**
 * Pull a board's advertised result total out of its page text.
 *
 * Split from readClaimedResultTotal so the parsing is unit-testable without a
 * browser. Rejects the two shapes that are NOT totals:
 *   - a capped "1000+ jobs", which is a ceiling the path-form SERP shows; and
 *   - a "Showing results 501-520" range, which is a window, not a count.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseClaimedResultTotal(text) {
  const body = String(text == null ? '' : text);
  if (/\b1000\+/.test(body)) return null;
  const match = body.match(/([\d,]{1,9})\s+(?:[\w-]+\s+){0,4}?jobs?\b/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Return the 1-based page encoded by ZipRecruiter's /jobs-search[/N] route. */
export function zipRecruiterSearchPageNumber(value) {
  try {
    const pathname = new URL(String(value || '')).pathname.replace(/\/+$/, '');
    if (pathname === '/jobs-search') return 1;
    const match = pathname.match(/^\/jobs-search\/(\d+)$/);
    const page = match ? Number(match[1]) : NaN;
    return Number.isInteger(page) && page >= 1 ? page : null;
  } catch {
    return null;
  }
}

/**
 * ZipRecruiter can stop rendering its Next link after page 20 even while a
 * direct /jobs-search/21 request serves new rows. Probe that hidden tail only
 * when the board itself says more results exist and the hub's page limit still
 * permits another page. Other sources must retain their verified controls.
 */
export function shouldTryZipRecruiterDirectContinuation({
  sourceId,
  claimedTotal,
  collected,
  pageNum,
  maxPages,
  hasNextUrl,
} = {}) {
  return sourceId === 'ziprecruiter'
    && Number.isFinite(Number(claimedTotal))
    && Number(claimedTotal) > Number(collected || 0)
    && Number.isInteger(pageNum)
    && Number.isInteger(maxPages)
    && pageNum < maxPages
    && hasNextUrl === true;
}

/**
 * Decide whether one verified direct reload is warranted after ZipRecruiter's
 * normal pager successfully lands on an empty page below its trustworthy
 * advertised total. This is deliberately narrower than the hidden-tail
 * continuation above: the direct URL must identify the page we just reached,
 * and a retry is never repeated. A headline total is only a shortfall signal,
 * never proof that every advertised listing is reachable.
 */
export function zipRecruiterProviderShortfallRecoveryOutcome({
  sourceId,
  claimedTotal,
  providerGathered,
  pageNum,
  maxPages,
  hasNextUrl,
  pageIdentityValid,
  retryAttempted = false,
  documentReloaded = false,
  extractedRows = 0,
} = {}) {
  const shortfall = sourceId === 'ziprecruiter'
    && Number.isFinite(Number(claimedTotal))
    && Number(claimedTotal) > Number(providerGathered || 0)
    && Number.isInteger(pageNum)
    && Number.isInteger(maxPages)
    && pageNum >= 1
    && pageNum <= maxPages;
  if (!shortfall) return 'not-applicable';
  if (retryAttempted) {
    return pageIdentityValid && documentReloaded && Number(extractedRows) > 0 ? 'recovered' : 'shortfall';
  }
  return hasNextUrl === true && pageIdentityValid ? 'retry' : 'shortfall';
}

/**
 * Keep the retry provenance safe to carry through jobs.js's terminal-source
 * receipt. In particular, the direct URL used for the reload is browser-only:
 * its query can carry provider search and tracking values and must never enter
 * a durable result/report field.
 */
export function providerTotalShortfallRecoveryReceipt(recovery) {
  if (!recovery || typeof recovery !== 'object') return null;
  const boundedInteger = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const status = typeof recovery.status === 'string'
    ? recovery.status.replace(/[^a-z0-9-]/gi, '').slice(0, 80)
    : '';
  if (!status) return null;
  const receipt = {
    pageNum: boundedInteger(recovery.pageNum),
    attempts: boundedInteger(recovery.attempts),
    status,
    rawRows: boundedInteger(recovery.rawRows),
    newProviderRows: boundedInteger(recovery.newProviderRows),
    shortfall: boundedInteger(recovery.shortfall),
  };
  const terminalPageNum = boundedInteger(recovery.terminalPageNum);
  if (terminalPageNum != null) receipt.terminalPageNum = terminalPageNum;
  return receipt;
}

// A persistent shortfall must remain a usable completed source: the rows we
// did collect are valid, and a drifting provider headline is not a target we
// can hold the whole pipeline hostage to. It is nevertheless actionable, so
// carry a compact non-gating warning to the completed Job Search UI rather
// than leaving this fact visible only in a later bug report/terminal receipt.
export function zipRecruiterProviderTotalShortfallWarning({
  claimedTotal,
  providerGathered,
  retryStatus = '',
} = {}) {
  const total = Number.isSafeInteger(Number(claimedTotal)) && Number(claimedTotal) > 0
    ? Number(claimedTotal)
    : null;
  const gathered = Number.isSafeInteger(Number(providerGathered)) && Number(providerGathered) >= 0
    ? Number(providerGathered)
    : null;
  if (total == null || gathered == null || gathered >= total) return null;
  const retry = typeof retryStatus === 'string' && retryStatus
    ? ` The one verified page reload ended ${retryStatus.replace(/[^a-z0-9-]/gi, '').slice(0, 80) || 'without additional coverage'}.`
    : '';
  return {
    code: 'provider-total-shortfall',
    severity: 'warn',
    shortLabel: 'Partial result coverage',
    evidence: `ZipRecruiter returned an empty page after ${gathered} of ~${total} advertised candidate identities were traversed.${retry}`,
    suggestion: 'Partial rows were kept. Rerun this source later to try its pager again; the advertised total can drift and is not treated as an exhaustive target.',
  };
}

// ── Walk guards ───────────────────────────────────────────────────────────────
// A source that stopped early because of a backstop, a trickle pager, a stalled
// reveal or an exhausted retry budget used to look exactly like one that
// finished. These are the fixed-shape records jobs.js turns into a visible
// warning; counts only, never titles, URLs or listing text.
export const WALK_GUARD_MAX = 20;

export const WALK_GUARD_DETAIL_MAX_CHARS = 240;

export const WALK_GUARD_KINDS = Object.freeze([
  'pager-trickle',
  'page-backstop',
  'job-backstop',
  'reveal-stalled',
  'reveal-backstop',
  'detail-retry-cap',
]);

export const walkGuardNumber = value => (Number.isFinite(value) ? value : null);

/** Append one guard in the shared shape. False when it was dropped. */
export function appendWalkGuard(guards, entry) {
  if (!Array.isArray(guards) || !entry || !WALK_GUARD_KINDS.includes(entry.kind)) return false;
  if (guards.length >= WALK_GUARD_MAX) return false;
  const detail = typeof entry.detail === 'string'
    ? entry.detail.slice(0, WALK_GUARD_DETAIL_MAX_CHARS)
    : null;
  guards.push({
    kind: entry.kind,
    source: entry.source || null,
    query: walkGuardNumber(entry.query),
    page: walkGuardNumber(entry.page),
    pages: walkGuardNumber(entry.pages),
    newRows: walkGuardNumber(entry.newRows),
    detail,
  });
  return true;
}
