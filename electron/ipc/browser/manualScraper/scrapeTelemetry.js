// Everything that writes or reads manualScraperTelemetry: event/origin/anomaly rings,
// per-source scrape pace, the liveness beat and in-flight marker, the console/network
// noise filter, run resets and the public snapshot getter.

import { manualScraperTelemetry, activitySinkState } from './scrapeState.js';
import { logger } from '../../../logger.js';

// Sizes of the recency windows kept in the telemetry below.
const EVENT_RING_MAX = 30;

const ORIGIN_RING_MAX = 24;

// Origin rows that are pinned in the origin ring: each source's FIRST
// source-start and the first row of each location-* phase. Per-query rows
// (query-start, reveal-finished) and source-finished can be evicted on a long
// run; pinned rows only when every retained row is pinned. Keys are
// `${sourceId}\u0000${phase}`, reset with the rest of the run telemetry.
const pinnedOriginKeys = new Set();
const pinnedOriginEntries = new WeakSet();

function isPinnableOriginPhase(phase) {
  return phase === 'source-start' || (typeof phase === 'string' && phase.startsWith('location-'));
}

function pushOriginRow(entry) {
  const origins = manualScraperTelemetry.origins;
  if (isPinnableOriginPhase(entry.phase)) {
    const key = `${String(entry.sourceId || 'unknown')}\u0000${entry.phase}`;
    if (!pinnedOriginKeys.has(key)) {
      pinnedOriginKeys.add(key);
      pinnedOriginEntries.add(entry);
    }
  }
  origins.push(entry);
  while (origins.length > ORIGIN_RING_MAX) {
    const evictAt = origins.findIndex(row => !pinnedOriginEntries.has(row));
    origins.splice(evictAt >= 0 ? evictAt : 0, 1);
    manualScraperTelemetry.originsDropped = (Number(manualScraperTelemetry.originsDropped) || 0) + 1;
  }
}

const ANOMALY_RING_MAX = 20;

// ── Per-source scrape pace ────────────────────────────────────────────────────
// Diagnostics ONLY. Each record answers: how many list pages and detail pages
// were opened, how many verification checks appeared (list vs detail), how many
// detail pages opened between consecutive checks, and where wall time went.
// Every writer below funnels through updateScrapePace and swallows its own
// errors: a telemetry fault must never unwind a scrape's await chain.
const PACE_BETWEEN_CHALLENGES_LIMIT = 20;

const PACE_DETAIL_PAGE_LOG_EVERY = 10;

function paceRecordFor(sourceId, meta = {}) {
  const key = String(sourceId || 'unknown');
  let pace = manualScraperTelemetry.pace[key];
  if (!pace) {
    pace = {
      sourceId: key,
      srcName: null,
      startedAt: Date.now(),
      queryIndex: 1,
      queryTotal: null,
      listPages: 0,
      detailOpened: 0,
      challenges: { list: 0, detail: 0 },
      challengeWaitMs: 0,
      spacingWaitMs: 0,
      detailLoadMs: 0,
      // Detail pages opened since the LAST check started — one value per check
      // (only the last PACE_BETWEEN_CHALLENGES_LIMIT are kept).
      opensBetweenChallenges: [],
      opensSinceLastChallenge: 0,
      lastChallengeAt: null,
      // Non-null while a check is on screen but unsolved: its elapsed time is
      // reported as ongoing rather than silently dropped from the totals.
      openChallengeSince: null,
      // How each finished check ended, by what input reached the page meanwhile
      // (challengeInputProbe.js): 'input' | 'movement' | 'none' | 'unknown'.
      checkInput: { input: 0, movement: 0, none: 0, unknown: 0 },
      // What was on screen when a card-walk failure streak STARTED
      // (panelWalkInterrupt.js). Only the first failure of a streak is counted,
      // so three failing cards behind one check is one interruption, not three.
      // 'none'/'unknown' are counted but never printed.
      panelInterrupts: { check: 0, popup: 0, covered: 0, none: 0, unknown: 0 },
    };
    manualScraperTelemetry.pace[key] = pace;
  }
  // Identity is refreshed by whichever hook knows it; the record itself is
  // normally created by resetScrapePace at source start.
  if (meta.srcName) pace.srcName = meta.srcName;
  if (Number(meta.queryIndex) > 0) pace.queryIndex = Number(meta.queryIndex);
  if (Number(meta.queryTotal) > 0) pace.queryTotal = Number(meta.queryTotal);
  return pace;
}

function updateScrapePace(sourceId, meta = {}, mutate = () => {}) {
  try {
    const pace = paceRecordFor(sourceId, meta);
    mutate(pace);
    return pace;
  } catch {
    return null; // fail-soft by contract
  }
}

export function formatWaitDuration(ms) {
  const sec = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

// Wall time spent on verification checks, INCLUDING the one on screen right now:
// an open check is ongoing, not completed — a report written mid-challenge must
// still show where the time went.
function paceChallengeWaitMs(pace, now = Date.now()) {
  const completed = Math.max(0, Number(pace?.challengeWaitMs) || 0);
  const open = pace?.openChallengeSince ? Math.max(0, Number(now) - Number(pace.openChallengeSince)) : 0;
  return completed + open;
}

function logScrapePaceSummary(pace) {
  try {
    const line = formatScrapePaceLine(pace);
    if (line) logger.info(`[BrowserScraper] ${line}`);
  } catch {
    // fail-soft: logging must never break a scrape
  }
}

// Reset (create) a source's record — called at source start so a re-dispatched
// source cannot inherit an earlier attempt's counts.
export function resetScrapePace(sourceId, meta = {}) {
  try {
    delete manualScraperTelemetry.pace[String(sourceId || 'unknown')];
  } catch {
    // ignore — the record is rebuilt below regardless
  }
  return updateScrapePace(sourceId, meta);
}

export function notePaceListPage(sourceId, meta = {}) {
  return updateScrapePace(sourceId, meta, pace => { pace.listPages += 1; });
}

export function notePaceDetailOpened(sourceId, meta = {}) {
  return updateScrapePace(sourceId, meta, pace => {
    pace.detailOpened += 1;
    pace.opensSinceLastChallenge += 1;
    pace.detailLoadMs += Math.max(0, Number(meta.loadMs) || 0);
    if (pace.detailOpened % PACE_DETAIL_PAGE_LOG_EVERY === 0) logScrapePaceSummary(pace);
  });
}

// Glassdoor's description route (glassdoorJobPage.js): running source totals of
// descriptions read from job pages vs the panel fallback, and the fixed code
// for why the job-page route stopped. Counts and codes only.
const DESCRIPTION_ROUTE_STOP_CODES = new Set(['none', 'unreadable', 'no-reads', '429-first', '429-second', 'challenge']);
export function notePaceDescriptionRoute(sourceId, meta = {}) {
  return updateScrapePace(sourceId, meta, pace => {
    pace.descriptionRoute = {
      fromJobPage: Math.max(0, Number(meta.fromJobPage) || 0),
      fromPanel: Math.max(0, Number(meta.fromPanel) || 0),
      stopReason: DESCRIPTION_ROUTE_STOP_CODES.has(meta.stopReason) ? meta.stopReason : 'none',
    };
  });
}

export function notePaceSpacingWait(sourceId, meta = {}) {
  return updateScrapePace(sourceId, meta, pace => {
    pace.spacingWaitMs += Math.max(0, Number(meta.waitMs) || 0);
  });
}

// `challengeOnly` is how waitForReady was entered: true means a DETAIL page is on
// screen (detail-page gate), false means list navigation/extraction.
export function notePaceChallengeStart(sourceId, meta = {}) {
  const at = Number(meta.now) || Date.now();
  return updateScrapePace(sourceId, meta, pace => {
    const context = meta.challengeOnly ? 'detail' : 'list';
    pace.challenges[context] = (Number(pace.challenges[context]) || 0) + 1;
    pace.opensBetweenChallenges.push(pace.opensSinceLastChallenge);
    if (pace.opensBetweenChallenges.length > PACE_BETWEEN_CHALLENGES_LIMIT) {
      pace.opensBetweenChallenges.splice(0, pace.opensBetweenChallenges.length - PACE_BETWEEN_CHALLENGES_LIMIT);
    }
    pace.opensSinceLastChallenge = 0;
    pace.lastChallengeAt = at;
    pace.openChallengeSince = at;
    pace.openChallenge = null;
  });
}

// What the input probe has counted on the check that is open right now, so a
// report written DURING a wait can say whether anyone clicked and how often the
// site loaded its check page again. Counts only.
export function notePaceChallengeProgress(sourceId, meta = {}) {
  const c = meta.counts && typeof meta.counts === 'object' ? meta.counts : null;
  if (!c) return null;
  const n = value => Math.max(0, Number(value) || 0);
  return updateScrapePace(sourceId, meta, pace => {
    if (!pace.openChallengeSince) return;
    pace.openChallenge = {
      clicks: n(c.clicks), keys: n(c.keys), frameFocus: n(c.frameFocus),
      documents: n(c.documents), failedAttempts: n(c.failedAttempts),
    };
  });
}

export function notePaceChallengeEnd(sourceId, meta = {}) {
  const at = Number(meta.now) || Date.now();
  return updateScrapePace(sourceId, meta, pace => {
    if (pace.openChallengeSince) {
      pace.challengeWaitMs += Math.max(0, at - Number(pace.openChallengeSince));
      pace.openChallengeSince = null;
    }
    pace.openChallenge = null;
    if (meta.input) {
      const kind = ['input', 'movement', 'none'].includes(meta.input) ? meta.input : 'unknown';
      pace.checkInput ||= { input: 0, movement: 0, none: 0, unknown: 0 };
      pace.checkInput[kind] = (Number(pace.checkInput[kind]) || 0) + 1;
    }
    logScrapePaceSummary(pace);
  });
}

// Glassdoor panel request-limit waits (expandByPanel waitForPanelWindow): the
// walk paused to keep panel requests under the site's 5-minute limit. Counted
// per source so the pace line shows the time even when no batch summary
// survives in the recency ring.
export function notePacePanelWindowWait(sourceId, meta = {}) {
  return updateScrapePace(sourceId, meta, pace => {
    pace.panelWindowWaits = (Number(pace.panelWindowWaits) || 0) + 1;
    pace.panelWindowWaitMs = (Number(pace.panelWindowWaitMs) || 0) + Math.max(0, Number(meta.waitMs) || 0);
  });
}

// Diagnostics-only companion to the card walk: what was on screen when a click
// or panel-read failure streak STARTED. Counted at stage 'first' only, so one
// covered page cannot turn into one count per failing card.
export function notePacePanelInterrupt(sourceId, meta = {}) {
  const verdict = ['check', 'popup', 'covered', 'none', 'unknown'].includes(meta.verdict) ? meta.verdict : 'unknown';
  return updateScrapePace(sourceId, meta, pace => {
    pace.panelInterrupts ||= { check: 0, popup: 0, covered: 0, none: 0, unknown: 0 };
    pace.panelInterrupts[verdict] = (Number(pace.panelInterrupts[verdict]) || 0) + 1;
  });
}

// One-line summary shared by the log stream and the bug report, e.g.
// "ZipRecruiter pace: query 1/11 · 16 detail pages · 2 list pages · 9 checks
//  (9 detail, 0 list) · detail pages between checks 1,1,2,1,4 · waiting on you
//  7m12s · spacing 4m03s · page loads 1m10s · 54s per detail page"
export function formatScrapePaceLine(pace, now = Date.now()) {
  if (!pace || typeof pace !== 'object') return '';
  const at = Number(now) || Date.now();
  const duration = formatWaitDuration;
  const detailChecks = Math.max(0, Number(pace.challenges?.detail) || 0);
  const listChecks = Math.max(0, Number(pace.challenges?.list) || 0);
  const checks = detailChecks + listChecks;
  const detailOpened = Math.max(0, Number(pace.detailOpened) || 0);
  const listPages = Math.max(0, Number(pace.listPages) || 0);
  const between = Array.isArray(pace.opensBetweenChallenges)
    ? pace.opensBetweenChallenges.map(n => String(Number(n) || 0)).join(',')
    : '';
  const waitMs = paceChallengeWaitMs(pace, at);
  const spacingMs = Math.max(0, Number(pace.spacingWaitMs) || 0);
  const loadMs = Math.max(0, Number(pace.detailLoadMs) || 0);
  const perDetailMs = detailOpened > 0 ? (waitMs + spacingMs + loadMs) / detailOpened : 0;
  const queryTotal = Number(pace.queryTotal) || 0;
  const bits = [
    `query ${Number(pace.queryIndex) || 1}${queryTotal > 0 ? `/${queryTotal}` : ''}`,
    `${detailOpened} detail page${detailOpened === 1 ? '' : 's'}`,
    `${listPages} list page${listPages === 1 ? '' : 's'}`,
    `${checks} check${checks === 1 ? '' : 's'} (${detailChecks} detail, ${listChecks} list)`,
    `detail pages between checks ${between || 'n/a'}`,
    `waiting on you ${duration(waitMs)}${pace.openChallengeSince ? ` (check still open${(() => {
      const open = pace.openChallenge;
      if (!open || typeof open !== 'object') return '';
      const n = value => Math.max(0, Number(value) || 0);
      return `: ${n(open.clicks)} click(s), ${n(open.keys)} key press(es), ${n(open.frameFocus)} into-check focus, check page loaded ${n(open.documents)} time(s), served again after input ${n(open.failedAttempts)} time(s)`;
    })()})` : ''}`,
    ...(() => {
      const input = pace.checkInput || {};
      const counts = ['input', 'movement', 'none', 'unknown'].map(kind => Math.max(0, Number(input[kind]) || 0));
      const finished = counts.reduce((a, b) => a + b, 0);
      if (!finished) return [];
      const [touched, moved, untouched, unknown] = counts;
      const parts = [`${touched} with clicks or keys`, `${moved + untouched} without`];
      if (unknown) parts.push(`${unknown} unknown`);
      return [`checks cleared: ${parts.join(', ')}`];
    })(),
    ...(() => {
      const interrupts = pace.panelInterrupts || {};
      const [check, popup, covered] = ['check', 'popup', 'covered'].map(kind => Math.max(0, Number(interrupts[kind]) || 0));
      const parts = [];
      if (check) parts.push(`${check} check(s)`);
      if (popup) parts.push(`${popup} popup(s)`);
      if (covered) parts.push(`${covered} covered`);
      return parts.length ? [`panel walk interruptions: ${parts.join(', ')}`] : [];
    })(),
    ...(() => {
      const waits = Math.max(0, Number(pace.panelWindowWaits) || 0);
      return waits ? [`panel request limit waits ${waits} (${duration(pace.panelWindowWaitMs)})`] : [];
    })(),
    ...(() => {
      const route = pace.descriptionRoute;
      if (!route || typeof route !== 'object') return [];
      const stop = DESCRIPTION_ROUTE_STOP_CODES.has(route.stopReason) ? route.stopReason : 'none';
      return [`descriptions: ${Math.max(0, Number(route.fromJobPage) || 0)} from job pages, ${Math.max(0, Number(route.fromPanel) || 0)} from panel fallback · job-page route stop ${stop}`];
    })(),
    `spacing ${duration(spacingMs)}`,
    `page loads ${duration(loadMs)}`,
    `${duration(perDetailMs)} per detail page`,
  ];
  return `${pace.srcName || pace.sourceId || 'source'} pace: ${bits.join(' · ')}`;
}

// Overlay paints are cheap and frequent (every scroll tick in preloadContent);
// renderer IPC should not be. One second is far below the ~5-7s Glassdoor card
// cadence, so no real progress step is ever coalesced away.
const ACTIVITY_SINK_MIN_INTERVAL_MS = 1000;

// How long a single awaited scrape step may run before it is worth a log line.
// Well under puppeteer-core's 180s CDP protocolTimeout so a wedged renderer is
// NAMED long before the protocol gives up on it and the retry loop restarts it.
const IN_FLIGHT_WARN_MS = 30_000;

// Rows that establish the identity and setup of a source's walk. source-start,
// source-finished and the location-* rows are normally once per source, while
// query-start and reveal-finished are once per QUERY — so on a long run they
// are the first casualties of the 30-slot recency ring and the last thing a
// reader can afford to lose (query, requested location, any host redirect).
// They get their own bounded ring; each source's first source-start and
// location-* rows are pinned there (pushOriginRow) and every other eviction is
// counted in `originsDropped`.
const ORIGIN_PHASES = new Set([
  'source-start', 'query-start', 'source-finished', 'reveal-finished',
  'location-nation-tier-unenforced', 'location-resolution-failed',
  'location-not-applied', 'location-proof-unavailable', 'location-host-redirected',
]);

// Browser job boards routinely emit failed ad/analytics requests and CSP/ORB
// console errors that have no bearing on whether the listing scraper worked.
// These buffers are deliberately small, so allowing a burst of that traffic to
// consume them can evict the first-party failure that actually explains a bad
// scrape. Keep the allowlist URL-shaped and narrow: unfamiliar third parties and
// every ordinary first-party URL remain reportable.
function isKnownTelemetryNoiseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.replace(/[),.;:'"]+$/g, ''));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const hostIs = domain => host === domain || host.endsWith(`.${domain}`);

    if (hostIs('siteintercept.qualtrics.com')) return true;
    if (hostIs('impactradius-event.com')) return true;
    if (hostIs('doubleclick.net')) return true;
    if (hostIs('googleadservices.com') || hostIs('googlesyndication.com')) return true;
    if (host === 'www.google.com' && (pathname.startsWith('/rmkt/') || pathname.startsWith('/ccm/collect'))) return true;
    if (host === 'csp.withgoogle.com' && pathname === '/csp/identityrotatecookieshttp') return true;
    // Glassdoor embeds Indeed company-spotlight pixels. Chromium rejects these
    // cross-origin images/fetches on every card transition, producing duplicate
    // requestfailed + console entries even though the job-details request and
    // panel both succeed. Keep the allowlist path-exact so real Indeed job/API
    // failures remain visible.
    if (hostIs('indeed.com') && pathname === '/rc/gd/png') return true;
    if (host === 'itad.indeed.com' && pathname === '/ita/v1/publisher') return true;

    // Preserve the pre-existing low-value telemetry exclusions in one shared
    // predicate so request failures and HTTP failures cannot drift apart.
    if (host === 't.indeed.com' && pathname.startsWith('/signals')) return true;
    if (hostIs('googletagmanager.com') || hostIs('google-analytics.com') || host.includes('.analytics.')) return true;
    if (hostIs('sift.com') || hostIs('intercom.io') || hostIs('clarity.ms')) return true;
    if (hostIs('bat.bing.com') || hostIs('munchkin.marketo.net') || hostIs('cdn.branch.io')) return true;
    if (hostIs('cloudflareinsights.com') && pathname.startsWith('/cdn-cgi/rum')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * True only when a browser console/network diagnostic targets a known
 * non-functional ad/tracker endpoint. Console CSP messages often originate in
 * a first-party bundle (`url`) while naming the blocked request in `text`, so we
 * inspect the first embedded URL as the target. We intentionally do not scan
 * every URL in the message: CSP directive text may list tracker domains after a
 * genuine first-party failure, and that failure must stay visible.
 *
 * Exported for deterministic regression tests.
 */
export function isIgnorableManualBrowserTelemetry({ url = '', text = '' } = {}) {
  if (isKnownTelemetryNoiseUrl(url)) return true;
  const target = String(text || '').match(/https?:\/\/[^\s'"<>]+/i)?.[0] || '';
  return isKnownTelemetryNoiseUrl(target);
}

// A stuck single-card retry loop can emit dozens of byte-identical card-walk
// batch summaries in a row — same source/strategy/attempted/expanded/timeout
// counts, same failureSamples keys+reasons, nothing different except the
// timestamp. Left alone, the plain oldest-first `events` ring treats each
// retry as new history, so ~13 identical retries evicted 13 DISTINCT earlier
// batches before anyone read the report ("5 earlier card-walk batch
// summary(s) omitted"). Compare everything except the bookkeeping fields
// (`ts`, `repeatCount`, `firstTs`, `lastTs`) — a JSON-identical match is
// deliberately conservative: any real difference (even one more failed card)
// serializes differently and is never folded.
function cardWalkFingerprint(entry) {
  // `_`-prefixed to match the repo's destructure-to-omit convention (the lint
  // config's varsIgnorePattern allows it); these four are dropped, never read.
  const { ts: _ts, repeatCount: _repeatCount, firstTs: _firstTs, lastTs: _lastTs, ...rest } = entry;
  try {
    return JSON.stringify(rest);
  } catch {
    return null; // circular/unserializable — never collapse, never crash
  }
}

/**
 * Folds `entry` into the previous ring slot IN PLACE when it is a
 * byte-identical repeat of the last card-walk event, returning true. Returns
 * false (no mutation) for the first occurrence of a batch, for any batch that
 * differs from the previous one, or when the previous slot isn't a card-walk
 * event at all — so the caller can push normally in every one of those cases.
 */
function collapseRepeatedCardWalk(events, entry) {
  if (entry.phase !== 'card-walk') return false;
  const prev = events[events.length - 1];
  if (!prev || prev.phase !== 'card-walk') return false;
  const prevKey = cardWalkFingerprint(prev);
  const nextKey = cardWalkFingerprint(entry);
  if (prevKey === null || nextKey === null || prevKey !== nextKey) return false;
  prev.repeatCount = (prev.repeatCount || 1) + 1;
  prev.firstTs = prev.firstTs || prev.ts;
  prev.lastTs = entry.ts;
  // Re-anchor `ts` to the latest occurrence so the report's age ("-Ns ago")
  // reflects when the loop last repeated, not when it first started — a
  // repeat that is STILL happening must not read as old.
  prev.ts = entry.ts;
  return true;
}

const FIELD_ANOMALY_PHASES = new Set([
  'desc-miss', 'date-miss', 'detail-unavailable', 'detail-challenge', 'detail-offsite-challenge', 'detail-navigation-abort', 'detail-appcast-restriction', 'detail-panel-rate-limit', 'detail-panel-http-error', 'google-apply-links-rate-limited', 'detail-block-reprobe', 'detail-block-reprobe-partial', 'detail-block-reprobe-failed', 'detail-block-cleared', 'challenge-text-suppressed', 'challenge-resolved', 'challenge-loop', 'panel-walk-interrupt',
]);

const ACTIVE_CONTEXT_RESET_PHASES = new Set(['source-start', 'query-start', 'page-extract', 'source-finished', 'recovery-start']);

// `updateActive: false` records an event into the trail WITHOUT advancing the
// "current phase". Per-job outcomes (desc-miss / date-miss / detail-unavailable)
// are not scrape phases: `active` is a merge that never deletes fields, so
// folding one in would leave its `key` pinned to every later render — reporting
// one job's outcome as though it belonged to whatever the scraper is doing at
// report time.
// Exported for unit testing.
export function recordManualScraperTelemetry(event, { updateActive = true } = {}) {
  const entry = {
    ts: Date.now(),
    ...event,
  };
  if (!collapseRepeatedCardWalk(manualScraperTelemetry.events, entry)) {
    manualScraperTelemetry.events.push(entry);
    if (manualScraperTelemetry.events.length > EVENT_RING_MAX) manualScraperTelemetry.events.shift();
  }
  // Sources run strictly sequentially, so the last phase to name a source names
  // the source every subsequent overlay paint belongs to. This is what lets the
  // beat below carry a sourceId without threading one through ~30 call sites.
  if (entry.sourceId) manualScraperTelemetry.currentSourceId = entry.sourceId;
  if (ORIGIN_PHASES.has(entry.phase)) pushOriginRow(entry);
  // The 30-slot `events` ring is a recency window: after a source-wide detail
  // block, every later page emits two rows, so 18 pages of skip chatter evicted
  // the single `detail-panel-rate-limit` event that explained the whole run.
  // The rate-limit / panel-HTTP phases are the CAUSE rows — keep them in the
  // longer-lived anomaly ring so a report written an hour later still has them.
  if (FIELD_ANOMALY_PHASES.has(entry.phase)) {
    manualScraperTelemetry.fieldAnomalies.push(entry);
    if (manualScraperTelemetry.fieldAnomalies.length > ANOMALY_RING_MAX) manualScraperTelemetry.fieldAnomalies.shift();
  }
  if (!updateActive) return entry;
  // A source/query/page boundary is a new diagnostic context, not an update to
  // the prior listing. Replacing at those boundaries prevents a Glassdoor
  // detail key/reason/evidence from being reported as the current Google item
  // after the next source starts. Fine-grained phases within one context still
  // merge so browser/challenge metadata can accumulate while it is current.
  // 'recovery-start' is the same kind of boundary for a post-completion
  // recovery pass (Solve/Continue re-opening a stalled source): every per-card
  // phase inside that pass passes updateActive:false by design (see
  // expandDescriptions), so without a reset here `active` stays pinned to
  // whatever the main run last recorded — naming the WRONG source while a
  // different one silently recovers.
  manualScraperTelemetry.active = ACTIVE_CONTEXT_RESET_PHASES.has(entry.phase)
    ? entry
    : { ...(manualScraperTelemetry.active || {}), ...entry };
  return entry;
}

// Records the challenge-detected event at once, then fills in the egress fields
// when the lookup settles, so the user-solve wait never waits on a network call.
// The lookup never rejects; a failed one leaves the fields null.
export function recordChallengeDetectedTelemetry(event, egressLookup) {
  const entry = recordManualScraperTelemetry({
    ...event,
    egressIp: null, egressIsp: null, egressOrg: null, egressHosting: null,
  });
  Promise.resolve(egressLookup).then((egress) => {
    if (!egress) return;
    const fields = {
      egressIp: egress.ip ?? null,
      egressIsp: egress.isp ?? null,
      egressOrg: egress.org ?? null,
      egressHosting: egress.hosting ?? null,
    };
    Object.assign(entry, fields);
    const active = manualScraperTelemetry.active;
    if (active && active !== entry && active.phase === entry.phase && active.ts === entry.ts) Object.assign(active, fields);
  }, () => {});
  return entry;
}

/** Record a query only when Chrome accepted the location-assignment command. */
export function recordIssuedManualQuery(executedQueries, entry, navigationIssued) {
  if (navigationIssued && Array.isArray(executedQueries)) executedQueries.push(entry);
  return executedQueries;
}

// A terminal phase (finished/idle/aborted) must not keep vouching for the
// PRIOR active entry's source/count/URL/reason as though it were still
// current. That is exactly what let a bug report read "Current: phase
// finished · source Glassdoor · count 722" hours after Glassdoor's own run
// had ended, while a DIFFERENT source's post-completion recovery was the
// thing actually running — the reader had no way to tell the number was
// inherited rather than live. `ts` already tells a reader this is over; keep
// only phase + ts and drop every field that names a specific source's
// in-progress state.
export function clearManualScraperTelemetry(status = 'idle') {
  manualScraperTelemetry.active = manualScraperTelemetry.active
    ? { phase: status, ts: Date.now() }
    : null;
}

export function getManualScraperTelemetry() {
  return {
    active: manualScraperTelemetry.active ? { ...manualScraperTelemetry.active } : null,
    events: manualScraperTelemetry.events.map(e => ({ ...e })),
    origins: manualScraperTelemetry.origins.map(e => ({ ...e })),
    // Origin rows evicted from the bounded origin ring this run (pinned rows
    // are never among them unless every retained row is pinned).
    originsDropped: Math.max(0, Number(manualScraperTelemetry.originsDropped) || 0),
    fieldAnomalies: manualScraperTelemetry.fieldAnomalies.map(e => ({ ...e })),
    consoleLogs: manualScraperTelemetry.consoleLogs.map(e => ({ ...e })),
    networkErrors: manualScraperTelemetry.networkErrors.map(e => ({ ...e })),
    // `paused` was tracked on every ~500ms waitIfPaused poll but dropped here,
    // so a scrape a user had deliberately paused reported as a hang — with the
    // pause button, and the reason for the silence, invisible in a FULL report.
    paused: manualScraperTelemetry.paused,
    beat: manualScraperTelemetry.beat ? { ...manualScraperTelemetry.beat } : null,
    inFlight: manualScraperTelemetry.inFlight ? { ...manualScraperTelemetry.inFlight } : null,
    browser: manualScraperTelemetry.browser ? { ...manualScraperTelemetry.browser } : null,
    // Defensive copies here too: the report and any caller must not be able to
    // mutate the live rings the next pace hook writes into.
    pace: Object.fromEntries(Object.entries(manualScraperTelemetry.pace || {}).map(([key, pace]) => [
      key,
      {
        ...pace,
        challenges: { ...(pace?.challenges || {}) },
        opensBetweenChallenges: Array.isArray(pace?.opensBetweenChallenges)
          ? [...pace.opensBetweenChallenges]
          : [],
      },
    ])),
  };
}

/**
 * Record one liveness beat and forward it to the renderer sink.
 *
 * Split out of updateOverlay so the throttle/emit contract is unit-testable
 * without a live page. Exported for tests only.
 */
export function recordActivityBeat(state) {
  const beat = {
    ts:         Date.now(),
    sourceId:   manualScraperTelemetry.currentSourceId || null,
    srcName:    state?.srcName ?? null,
    status:     state?.status ?? null,
    // By default every different overlay message is a meaningful progress
    // step. Tight loops can provide one stable key while their copy/count
    // changes, so the renderer limiter remains effective.
    activityKey: state?.activityKey ?? state?.activityKind ?? state?.status ?? null,
    count:      Number.isFinite(state?.count) ? state.count : null,
    queryIndex: state?.queryIndex ?? null,
    queryTotal: state?.queryTotal ?? null,
    pageNum:    state?.pageNum ?? null,
    tabLayout: state?.tabLayout === 'results-and-details' ? 'results-and-details' : 'single-page',
  };
  manualScraperTelemetry.beat = beat;
  // Throttled so a scroll loop cannot flood the renderer, but ordinary callers
  // still emit a changed status immediately because the fallback key is status.
  // Tight loops opt into a stable key when their changing count is not a new
  // semantic step.
  if (!activitySinkState.sink) return beat;
  const changed = beat.activityKey !== activitySinkState.lastEmitKey;
  if (changed || Date.now() - activitySinkState.lastEmitAt >= ACTIVITY_SINK_MIN_INTERVAL_MS) {
    activitySinkState.lastEmitAt = Date.now();
    activitySinkState.lastEmitKey = beat.activityKey;
    try { activitySinkState.sink(beat); } catch { /* a reporting sink must never break a scrape */ }
  }
  return beat;
}

/** Install the renderer activity sink. Exported for tests; runs set it via scrapeManualSources. */
export function setActivitySink(sink) {
  activitySinkState.sink = typeof sink === 'function' ? sink : null;
  activitySinkState.lastEmitAt = 0;
  activitySinkState.lastEmitKey = null;
}

/**
 * Run one awaited scrape step with its identity recorded while it is in flight.
 *
 * A report written mid-walk otherwise names only the last COMPLETED phase, so
 * the operation that is actually slow is the one thing it cannot name. Records
 * a bounded marker, logs once if the step outlives IN_FLIGHT_WARN_MS, and always
 * clears — including on throw, so a failure cannot leave a phantom marker that
 * makes the next report claim a step is still running.
 */
export async function withInFlight(label, detail, run) {
  const started = Date.now();
  manualScraperTelemetry.inFlight = { label, detail: detail || null, since: started };
  const warn = setTimeout(() => {
    logger.warn(`[BrowserScraper] still awaiting ${label}${detail ? ` (${detail})` : ''} after ${Math.round(IN_FLIGHT_WARN_MS / 1000)}s — the page may be unresponsive; puppeteer gives up on a wedged evaluate at 180s and this step is then retried`);
  }, IN_FLIGHT_WARN_MS);
  try {
    return await run();
  } finally {
    clearTimeout(warn);
    manualScraperTelemetry.inFlight = null;
  }
}

// Clears the per-run browser diagnostic buffers (console/network) so a bug report
// shows only THIS run. Exposed so the orchestrator can reset ONCE when it calls
// scrapeManualSources per-source (data-driven order) — otherwise each per-source
// call would wipe the earlier sources' diagnostics.
export function resetManualScraperDiagnostics() {
  manualScraperTelemetry.consoleLogs = [];
  manualScraperTelemetry.networkErrors = [];
  manualScraperTelemetry.fieldAnomalies = [];
  manualScraperTelemetry.googleApplyCapture = null;
}

// Browser-scrape progress is run-scoped just like the console/network buffers.
// In particular, an API-only follow-up search never enters this module's normal
// browser loop, so leaving `active` or the phase ring intact would make a prior
// Google/Glassdoor scrape look like activity in that new LinkedIn-only run.
// Call this once at the beginning of every job-search run; per-source dispatch
// deliberately uses resetManualScraperDiagnostics() instead so sibling browser
// sources in the SAME run keep their shared diagnostic trail.
export function resetManualScraperTelemetry() {
  manualScraperTelemetry.active = null;
  manualScraperTelemetry.events = [];
  manualScraperTelemetry.origins = [];
  manualScraperTelemetry.originsDropped = 0;
  pinnedOriginKeys.clear();
  // A new run must not report the previous run's pace. Per-source dispatch uses
  // resetScrapePace (source start) and keeps sibling sources' records.
  manualScraperTelemetry.pace = {};
  manualScraperTelemetry.paused = false;
  manualScraperTelemetry.beat = null;
  manualScraperTelemetry.inFlight = null;
  manualScraperTelemetry.currentSourceId = null;
  // Cleared at the RUN boundary, not at teardown: a report written after a run
  // finishes should still show which Chrome that run used and that it closed,
  // but a NEW run must not display the previous run's process as its own.
  manualScraperTelemetry.browser = null;
  resetManualScraperDiagnostics();
}
