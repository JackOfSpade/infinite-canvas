// Provider collection helpers: search-window arithmetic, task building (buildJobTasks,
// Indeed resume plan, Glassdoor buckets), the query fan-out and HTTP-source fetcher,
// job location resolution, egress-IP and abortable-delay utilities, locked LinkedIn
// enrichment and the cooldown probe.
import { sanitizeJobSearchSourceWindows, sanitizeJobSearchWindow } from '../jobRunStaging.js';
import { normalizeJobSearchInitialLookbackDays, providerLookbackDaysForStart, resolveJobSearchDateWindow, startOfLocalDay } from '../../../src/utils/jobSearchDateWindow.js';
import { withSharedProfileLock } from '../sharedProfileLock.js';
import { resetManualScraperTelemetry } from '../browser/manualScraper.js';
import { buildGeoTermSet, enrichLinkedInDescriptionsBrowser, fetchDiceListings, fetchLinkedInJobs, fetchRemoteOKJobs, fetchUSAJobs, fetchWeWorkRemotelyJobs, warmDiceApiKey } from '../../extractors/apiExtractors.js';
import { jobsTelemetry } from './state.js';
import { logger } from '../../logger.js';
import { ACTIVE_SOURCE_ID_SET, filterJobsByDescriptionEvidence, getQueryProgressTotal, sanitizeWalkGuards } from './sourceRules.js';
import { dedupJobsAcrossSources, sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { recordJobSourceDispatch, recordLinkedinEnrichPass } from './telemetry.js';
import { isUnlimitedPages, normalizeJobCollectionLimits, resolveBrowserPageBudgets, resolveJobsPerPlatform, resolvePageCeiling } from '../../../src/utils/jobCollectionLimits.js';
import { deriveLocationParam, normalizeLocationInput } from '../../../src/utils/jobLocation.js';
import { GLASSDOOR_CONFIG, GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_CONFIG, GOOGLE_JOBS_EXTRACTOR, ZIPRECRUITER_CONFIG, ZIPRECRUITER_EXTRACTOR } from '../../extractors/jobs.js';
import { makeJobPageStop } from '../jobPageStop.js';
import { resolveIndeedPageBudgets } from '../../extractors/indeedBrowser.js';
import { getJobsSettings } from '../settings.js';
import { isJobOperationSupersededError } from './analysisStore.js';
import { callLLMText } from '../llm.js';
import { JOB_LOCATION_RESOLUTION_SCHEMA } from '../aiSchemas.js';

const DEFAULT_MAX_AGE_DAYS = 21;

function serializableJobSearchWindow(value) {
  return sanitizeJobSearchWindow(value);
}

/** Resolve the authoritative automatic window for a fresh search request. */
export function freshJobSearchWindow(lastCompletedRunAt, now = new Date(), initialLookbackDays = null) {
  const resolved = serializableJobSearchWindow(resolveJobSearchDateWindow(
    lastCompletedRunAt,
    now,
    normalizeJobSearchInitialLookbackDays(initialLookbackDays),
  ));
  if (!resolved) throw new TypeError('Could not resolve a valid Job Search date window.');
  return resolved;
}

/**
 * Upgrade a pre-searchWindow recovery input. The old setting was a rolling
 * number of days; resuming from the original run's local calendar date gives
 * it a stable, inclusive boundary and adds one broad provider day so midnight
 * rows cannot be missed before the exact client-side filter runs.
 */
export function legacyJobSearchWindow(maxAgeDays, runStartedAt, now = new Date()) {
  const parsedDays = Number(maxAgeDays);
  const days = Number.isFinite(parsedDays) && parsedDays > 0
    ? Math.min(365, Math.floor(parsedDays))
    : DEFAULT_MAX_AGE_DAYS;
  const startedAt = typeof runStartedAt === 'number' && Number.isFinite(runStartedAt)
    ? new Date(runStartedAt)
    : new Date(now);
  const validStartedAt = Number.isFinite(startedAt.getTime()) ? startedAt : new Date(now);
  const runDay = startOfLocalDay(validStartedAt);
  let startDate = new Date(runDay.getFullYear(), runDay.getMonth(), runDay.getDate() - days);
  // Some old/tests fixtures used tiny sentinel `startedAt` values near the
  // Unix epoch. They were valid under the previous maxAgeDays-only schema but
  // cannot form our positive timestamp contract; retain their recoverability
  // with a current-day legacy boundary.
  if (startDate.getTime() <= 0) {
    const currentDay = startOfLocalDay(new Date(now));
    startDate = new Date(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate() - days);
  }
  const upgraded = serializableJobSearchWindow({
    startTimestamp: startDate.getTime(),
    completionTimestamp: null,
    capped: true,
    capReason: 'legacy-max-age-days',
    providerLookbackDays: Math.min(366, days + 1),
  });
  // `now` is valid in every production caller. Keep the fallback explicit so
  // malformed/sentinel legacy fixtures can never turn into a later null
  // dereference at a provider boundary.
  return upgraded || freshJobSearchWindow(null, now);
}

/** Normalize a persisted/action window, with compatibility for old callers. */
export function effectiveJobSearchWindow(searchWindow, maxAgeDays, runStartedAt = null, now = new Date()) {
  const persisted = serializableJobSearchWindow(searchWindow)
    || legacyJobSearchWindow(maxAgeDays, runStartedAt, now);

  // A stored boundary belongs to the original run, but provider "N days"
  // parameters are evaluated again at request time. Resume/Solve can happen
  // hours later, so reusing the original relative horizon would move the
  // provider cutoff forward and create a gap at the frozen boundary. Derive
  // the retrieval horizon again from the immutable start: this both broadens
  // delayed requests correctly and prevents an IPC caller from inflating the
  // provider request while keeping an otherwise-valid boundary. The exact
  // posted-since filter trims the deliberate overfetch.
  const elapsedHorizon = providerLookbackDaysForStart(persisted.startTimestamp, now);
  return {
    ...persisted,
    providerLookbackDays: elapsedHorizon,
  };
}

/**
 * Narrow the renderer's per-source windows against the authoritative run
 * window. A platform that finished last time may legitimately get a NEWER start
 * than the run window, but it can never reach outside it. The provider horizon
 * is recomputed at dispatch time by `effectiveJobSearchWindow` so a delayed run
 * neither gains nor loses rows relative to its frozen boundary.
 */
export function narrowJobSearchSourceWindows(rawSourceWindows, runWindow, now = new Date()) {
  const run = serializableJobSearchWindow(runWindow);
  if (!run) return {};
  const clock = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const nowTimestamp = clock.getTime();
  const sanitized = sanitizeJobSearchSourceWindows(rawSourceWindows);
  const out = {};
  for (const [sourceId, entry] of Object.entries(sanitized)) {
    if (!Number.isFinite(entry?.startTimestamp)) continue;
    if (entry.startTimestamp < run.startTimestamp) continue;
    if (entry.startTimestamp > nowTimestamp) continue;
    out[sourceId] = effectiveJobSearchWindow(entry, null, null, clock);
  }
  return out;
}

/**
 * A list walk the provider cut short (LinkedIn's 429 ends its query walk with
 * stop reason `blocked`) still returns useful rows, so the card stays done. But
 * the results it never reached are unobserved, not absent: the run manifest must
 * keep it retryable, or its date bookmark advances past jobs nobody saw.
 * A description throttle alone is not this case; the list was still walked.
 */
export function listWalkStoppedByProviderBlock(data, effectiveWarnings = []) {
  if (!(Array.isArray(data?.jobs) && data.jobs.length > 0)) return false;
  const reasons = data?.stopReasons instanceof Set ? [...data.stopReasons] : (Array.isArray(data?.stopReasons) ? data.stopReasons : []);
  const stoppedBlocked = reasons.some(reason => (typeof reason === 'string' ? reason : reason?.stopReason) === 'blocked');
  return stoppedBlocked && (Array.isArray(effectiveWarnings) ? effectiveWarnings : [])
    .some(warning => warning?.severity === 'throttle' || warning?.severity === 'block');
}

/**
 * The platforms whose collection genuinely finished this run. A source that
 * hit a page or job cap is still complete: the cap is a deliberate breadth
 * choice, not an unobserved remainder. Exported for the renderer-visible
 * "finished" set that seeds the next run's per-source windows.
 */
export function completedJobSourceIds({
  activeSourceIds = [],
  sourceStatuses = null,
  gatingSourceIds = [],
  intentionallyUnfinishedSourceIds = [],
  loginBlockedSourceIds = [],
  countryApplicableSourceIds = null,
} = {}) {
  const toSet = (value) => (value instanceof Set ? value : new Set(Array.isArray(value) ? value : []));
  const statuses = sourceStatuses && typeof sourceStatuses === 'object' ? sourceStatuses : {};
  const gating = toSet(gatingSourceIds);
  const intentional = toSet(intentionallyUnfinishedSourceIds);
  const blocked = toSet(loginBlockedSourceIds);
  const countryRestricted = countryApplicableSourceIds == null
    ? null
    : toSet(countryApplicableSourceIds);
  const out = [];
  for (const sourceId of toSet(activeSourceIds)) {
    if (statuses[sourceId] !== 'done') continue;
    if (gating.has(sourceId)) continue;
    if (intentional.has(sourceId)) continue;
    if (blocked.has(sourceId)) continue;
    if (countryRestricted && !countryRestricted.has(sourceId)) continue;
    out.push(sourceId);
  }
  return out;
}

function sameFreshJobSearchBoundary(left, right) {
  return left?.startTimestamp === right?.startTimestamp
    && left?.completionTimestamp === right?.completionTimestamp
    && left?.capped === right?.capped
    && left?.capReason === right?.capReason;
}

/**
 * Validate and retain the renderer-frozen boundary for a fresh run.
 *
 * Search preparation can begin just before local midnight and reach this IPC
 * just after it. Accept only the exact policy result for the current or prior
 * local day; anything else is replaced by the backend's current authoritative
 * result. The exact boundary stays frozen while the relative provider horizon
 * is broadened to the actual dispatch time.
 */
export function authoritativeFreshJobSearchWindow(
  lastCompletedRunAt,
  initialLookbackDays,
  requestedSearchWindow,
  now = new Date(),
) {
  const clock = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const current = freshJobSearchWindow(lastCompletedRunAt, clock, initialLookbackDays);
  const requested = serializableJobSearchWindow(requestedSearchWindow);
  if (!requested) return current;

  const priorLocalDay = new Date(clock.getTime());
  priorLocalDay.setDate(priorLocalDay.getDate() - 1);
  const prior = freshJobSearchWindow(lastCompletedRunAt, priorLocalDay, initialLookbackDays);
  if (!sameFreshJobSearchBoundary(requested, current)
    && !sameFreshJobSearchBoundary(requested, prior)) {
    return current;
  }
  // Only the exact calendar boundary is renderer-frozen. The relative provider
  // horizon is derived data and is recomputed at the actual dispatch time.
  return effectiveJobSearchWindow(requested, null, null, clock);
}

/**
 * Validate a pre-provider manual-AI recovery checkpoint.
 *
 * A normal fresh request may only carry today's (or yesterday's) resolved
 * boundary, but a manual handoff can have paused after the renderer froze its
 * original search scope and before any staging manifest existed. Its resume is
 * neither a fresh scan nor a page-resume: retain the checkpoint's exact
 * boundary and broaden only the relative provider horizon at dispatch time.
 */
export function manualAiPreSearchRecoveryWindow(recovery, requestedSearchWindow, now = new Date()) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  if (recovery.version !== 1) return null;
  if (typeof recovery.manualAiRunId !== 'string' || !recovery.manualAiRunId.trim()) return null;
  if (typeof recovery.nodeId !== 'string' || !recovery.nodeId.trim()) return null;
  if (
    typeof recovery.startedAt !== 'number'
    || !Number.isSafeInteger(recovery.startedAt)
    || recovery.startedAt <= 0
    || !Number.isFinite(new Date(recovery.startedAt).getTime())
  ) return null;
  const frozen = serializableJobSearchWindow(recovery.searchWindow);
  const requested = serializableJobSearchWindow(requestedSearchWindow);
  if (!frozen || !requested || !sameFreshJobSearchBoundary(frozen, requested)) return null;
  return effectiveJobSearchWindow(frozen, null, null, now);
}

// ── Pipeline telemetry ───────────────────────────────────────────────────────
// Records the last job-search funnel so the bug reporter can answer "did we
// analyze all the jobs we found?" without depending on (a) the renderer node
// tree, which vanishes the instant the user deletes the hub, or (b) the 60-line
// log ring buffer, which scrolls. Each stage stamps its own slot independently
// because the stages are separate IPC calls that don't always run together
// (e.g. a captcha-resolve scores pendingJobs with no fresh search).

// Best-effort egress (public) IP lookup. It records whether a VPN switch
// changed the observed egress before LinkedIn enrichment is retried. That does
// not establish whether a guest ceiling is keyed by IP, guest context, or a
// fingerprint; it only lets the immediate-retry guard avoid repeating a just
// observed ceiling on identical network conditions. Returns null on any failure
// so callers degrade gracefully (proceed without the guard).
export async function getEgressIp() {
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.ip === 'string') ? data.ip : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Resolve after `ms`, or reject early if the abort signal fires — so a long
// cooldown-probe wait (tens of minutes) still bails the instant the user resets
// the run or closes the window, instead of sleeping to completion.
export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Start a job run's browser-diagnostic generation only after it owns the
 * shared Chrome profile. The telemetry object is process-global because there
 * is one shared browser, so resetting it before this FIFO lock is acquired
 * lets a queued hub erase the hub currently scraping. Keep the reset and the
 * entire browser phase in one lock ownership window.
 */
export function withFreshManualScraperTelemetry(fn, signal = null) {
  return withSharedProfileLock(async () => {
    resetManualScraperTelemetry();
    return fn();
  }, signal, 'job browser-source phase');
}

// LinkedIn description enrichment uses the same long-lived stealth browser and
// profile as the manual-source collectors.  It runs after the initial collector
// phase, so it cannot rely on that phase's lock still being held.  Keep the
// lock around each actual browser pass (rather than a cooldown wait) so another
// canvas can use Chrome while this run is idling between probes.
export async function enrichLinkedInDescriptionsLocked(jobs, signal, options = {}) {
  return withSharedProfileLock(
    () => enrichLinkedInDescriptionsBrowser(jobs, signal, options),
    signal,
    'job LinkedIn description enrichment',
  );
}

// Focused concurrency seam: callers run their browser pass under the exact
// lock used by production LinkedIn enrichment. Kept small so the unit suite
// can prove cross-window exclusion without launching Chromium.
export function __withLockedLinkedInEnrichmentForTests(fn, signal = null) {
  return withSharedProfileLock(fn, signal, 'job LinkedIn enrichment test seam');
}

// Automated cooldown probe: idle escalating waits on the SAME IP/browser,
// probing a small job batch after each wait, stop at the first interval whose
// wall is clear AND confirmed by 2 additional probes. Diagnostic only — gated
// by JOB_SEARCH_PROBE_COOLDOWN. Both the initial search path (auto-trigger on
// wall) and the resolve/Solve path call this. Returns { pool, foundMs, attempt,
// probeTotalEnriched, aborted }. saveMidProbe(pool) is optional — the resolve
// path uses it to persist enriched descriptions mid-probe; the search path
// relies on the final snapshot save at the end of the search.
export async function runCooldownProbe(nodeId, waitsMs, initialPool, signal, progressFn, saveMidProbe, {
  ownership = null,
  canWriteTelemetry = () => true,
  // Resolve calls already own the profile lock for their full recovery
  // transaction. Initial searches do not: their earlier source-collection
  // lock has been released by the time a cooldown probe starts.
  lockLinkedInEnrichment = false,
} = {}) {
  const PROBE_BATCH = 15;
  const setCooldownTelemetry = (value) => {
    if (canWriteTelemetry()) jobsTelemetry.linkedinCooldown = value;
  };
  logger.info(`[Jobs][${nodeId}] Cooldown probe armed: waits ${waitsMs.map(ms => Math.round(ms / 60000)).join('/')}m, batch ${PROBE_BATCH}`);
  setCooldownTelemetry({ running: true, attempts: 0, foundMs: null, waitsMs, ts: Date.now() });
  let pool = initialPool;
  let foundMs = null;
  let attempt = 0;     // total probe CALLS (initial + confirmations) — telemetry/return
  let waitIndex = 0;   // which configured wait we're on — the X in the "X/N" label
  let probeTotalEnriched = 0;
  // A cooldown probe is meaningful only when it keeps the same observed egress
  // and browser process as the wall that armed it. The first entry is the
  // immediately preceding rate-limited pass (recorded by either search or
  // Solve); never silently promote a VPN/browser change into a cooldown clear.
  const precedingWall = (canWriteTelemetry() ? [...jobsTelemetry.linkedinEnrich] : []).reverse().find(e =>
    e.browserGen != null && e.ip && (e.walled || (e.noDescSoftBlock || 0) > 0),
  );
  const expectedIdentity = precedingWall
    ? { ip: precedingWall.ip, browserGen: precedingWall.browserGen }
    : null;
  const identityIssue = (ip, browserGen) => {
    if (!expectedIdentity || !ip || browserGen == null) return 'unverified';
    return expectedIdentity.ip === ip && expectedIdentity.browserGen === browserGen ? null : 'changed';
  };
  // One probe request. The initial probes and their confirmations run the same
  // body — enrich a batch, merge by url, record the pass, bail on an
  // unavailable browser or a changed egress identity — and differ only in their
  // labels and in what they do with the outcome, so the shared half lives here
  // and each caller keeps its own loop control. Returns a discriminated result:
  // 'exhausted' (nothing left to probe), 'bail' (caller returns .result as-is),
  // or 'ok'. Telemetry field names are load-bearing: the bug report renders
  // "paused"/"invalid" cooldown lines off browserUnavailable / identityChanged.
  const probeOnce = async ({ detail, pausedLabel, invalidLabel }) => {
    const stillEmpty = filterJobsByDescriptionEvidence(pool).dropped;
    if (stillEmpty.length === 0) return { kind: 'exhausted' };
    const batch = stillEmpty.slice(0, PROBE_BATCH);
    const ip = await getEgressIp();
    progressFn({ nodeId, sourceId: 'linkedin', status: 'searching', count: pool.length, detail });
    const startedAt = Date.now();
    const pr = await (lockLinkedInEnrichment
      ? enrichLinkedInDescriptionsLocked(batch, signal)
      : enrichLinkedInDescriptionsBrowser(batch, signal));
    const byUrl = new Map((pr.jobs || []).map(j => [j.url, j]));
    const structurallyDropped = new Set(pr.structuralDroppedKeys || []);
    pool = pool.filter(j => !structurallyDropped.has(sourceJobKey(j))).map(j => byUrl.get(j.url) || j);
    probeTotalEnriched += pr.successCount || 0;
    const stillEmptyAfter = filterJobsByDescriptionEvidence(pool).dropped.length;
    recordLinkedinEnrichPass({ kind: 'probe', ...(ownership || {}), ip, ipOk: !!ip, walled: pr.loginWall, browserUnavailable: !!pr.browserUnavailable, attempted: pr.attempted ?? batch.length, remainingBefore: stillEmpty.length, enriched: pr.successCount || 0, stillEmpty: stillEmptyAfter, contextRotations: pr.contextRotations || 0, browserGen: pr.browserGen ?? null, browserAgeMs: pr.browserAgeMs ?? null, startedAt });
    if (pr.browserUnavailable) {
      setCooldownTelemetry({ running: false, attempts: attempt, foundMs: null, waitsMs, ts: Date.now(), browserUnavailable: true });
      logger.info(`[Jobs][${nodeId}] ${pausedLabel}: shared browser unavailable (${pr.browserError || 'unknown error'})`);
      return { kind: 'bail', result: { pool, foundMs: null, attempt, probeTotalEnriched, aborted: false, browserUnavailable: true, profileReserved: !!pr.profileReserved, browserError: pr.browserError || null } };
    }
    const issue = identityIssue(ip, pr.browserGen);
    if (issue) {
      setCooldownTelemetry({
        running: false, attempts: attempt, foundMs: null, waitsMs, ts: Date.now(),
        identityChanged: issue === 'changed', identityUnverified: issue === 'unverified',
        expectedIdentity, observedIdentity: { ip: ip || null, browserGen: pr.browserGen ?? null },
      });
      logger.info(`[Jobs][${nodeId}] ${invalidLabel}: IP/browser ${issue} (expected ${expectedIdentity?.ip || '?'}/#${expectedIdentity?.browserGen ?? '?'}, got ${ip || '?'}/#${pr.browserGen ?? '?'})`);
      return { kind: 'bail', result: { pool, foundMs: null, attempt, probeTotalEnriched, aborted: false, cooldownIdentityChanged: issue === 'changed', cooldownIdentityUnverified: issue === 'unverified' } };
    }
    return { kind: 'ok', ip, walled: !!pr.loginWall, successCount: pr.successCount || 0, stillEmptyAfter };
  };
  try {
    for (const waitMs of waitsMs) {
      attempt++;
      waitIndex++;
      const mins = Math.round(waitMs / 60000);
      progressFn({ nodeId, sourceId: 'linkedin', status: 'searching', count: pool.length, detail: `cooldown probe ${waitIndex}/${waitsMs.length}: idling ${mins}m`, warning: null });
      await abortableDelay(waitMs, signal);
      const probe = await probeOnce({
        detail: `cooldown probe ${attempt}: testing after ${mins}m idle`,
        pausedLabel: 'Cooldown probe paused',
        invalidLabel: 'Cooldown probe invalid',
      });
      if (probe.kind === 'exhausted') { foundMs = waitMs; break; }
      if (probe.kind === 'bail') return probe.result;
      setCooldownTelemetry({ running: true, attempts: attempt, foundMs: null, waitsMs, ts: Date.now() });
      if (probe.successCount > 0 && saveMidProbe) {
        try { await saveMidProbe(pool); } catch (e) { logger.warn(`[Jobs][${nodeId}] Cooldown probe: snapshot persist failed — ${e.message}`); }
      }
      logger.info(`[Jobs][${nodeId}] Cooldown probe ${attempt}: after ${mins}m idle on IP ${probe.ip || '?'} → +${probe.successCount}, ${probe.walled ? 'still WALLED' : 'CLEAR'}, ${probe.stillEmptyAfter} still empty`);
      if (probe.walled) continue;

      // First clean probe. Run 2 confirmation probes at the same interval
      // (no additional idle — just re-probe immediately) before committing
      // to this as the cooldown. If any confirmation walls, this interval
      // isn't stable and we advance to the next longer wait.
      const CONFIRM_NEEDED = 2;
      let confirmFailed = false;
      for (let c = 1; c <= CONFIRM_NEEDED; c++) {
        attempt++;
        const confirm = await probeOnce({
          detail: `cooldown confirm ${c}/${CONFIRM_NEEDED} (${mins}m interval)`,
          pausedLabel: 'Cooldown confirmation paused',
          invalidLabel: 'Cooldown confirmation invalid',
        });
        if (confirm.kind === 'exhausted') break;
        if (confirm.kind === 'bail') return confirm.result;
        if (confirm.successCount > 0 && saveMidProbe) {
          try { await saveMidProbe(pool); } catch (e) { logger.warn(`[Jobs][${nodeId}] Cooldown confirm: snapshot persist failed — ${e.message}`); }
        }
        logger.info(`[Jobs][${nodeId}] Cooldown confirm ${c}/${CONFIRM_NEEDED}: IP ${confirm.ip || '?'} → +${confirm.successCount}, ${confirm.walled ? 'WALLED (unstable)' : 'CLEAR'}, ${confirm.stillEmptyAfter} still empty`);
        if (confirm.walled) { confirmFailed = true; break; }
      }
      if (!confirmFailed) { foundMs = waitMs; break; }
      logger.info(`[Jobs][${nodeId}] Cooldown probe: ${mins}m interval not stable (confirmation walled) — advancing to next wait`);
    }
  } catch (e) {
    setCooldownTelemetry({ running: false, attempts: attempt, foundMs, waitsMs, ts: Date.now(), aborted: true });
    logger.info(`[Jobs][${nodeId}] Cooldown probe aborted: ${e.message}`);
    return { pool, foundMs, attempt, probeTotalEnriched, aborted: true };
  }
  setCooldownTelemetry({ running: false, attempts: attempt, foundMs, waitsMs, ts: Date.now() });
  return { pool, foundMs, attempt, probeTotalEnriched, aborted: false };
}

// Sources that run WITHOUT the browser pool:
// - remoteok: Open JSON API at remoteok.com/api (zero WAF)
// - weworkremotely: RSS feed at weworkremotely.com/remote-jobs.rss (zero WAF)
// Indeed is NOT one of them. It runs a real local Chrome through its own
// launcher (fetchIndeedListingsBrowser, electron/extractors/indeedBrowser.js) —
// see BROWSER_SCRAPE_ORDER above, which lists it first. An earlier comment here
// claimed a Scrapfly REST path with no local browser; that path no longer
// exists, and believing it makes every Indeed anti-bot finding unattributable.

// Human "reading" pause between page turns within a paginating source's
// session (min/max ms, jittered in the browser pool). Speed is intentionally
// sacrificed for a natural cadence during a hub-configured page walk.
const PAGE_DELAY_MS = [6000, 14000];

// Per-query pagination stop callback, one fresh instance per task (see
// buildJobTasks below). The hub's blank page count is the finite Auto policy
// (pagesPerPlatform: null on disk), so every generated query has a deterministic
// browser-page allocation and the platform never receives an accidental
// 1000×query walk. The data-driven stops below can end even earlier. The
// real stop condition is the DATA, decided by makeJobPageStop
// (electron/ipc/jobPageStop.js) per page: empty-page (terminal/lossless — no
// results exist past an empty offset), age-window (two consecutive pages
// decisively outside the hub's automatic date window), or no-new-jobs (unlimited
// walks only — the pager has stopped advancing).
//
// This replaces a prior version of this policy that walked the FULL ceiling on
// every source and stopped early only on an empty page, reasoning that the
// server-side date filter (fromage / days / fromAge / f_TPR) already bounded
// the window and that a naive "first out-of-window row ends the source" cutoff
// would prune real jobs under relevance sort (a reshuffled page reads as
// out-of-window even though later pages are not). That reasoning no longer
// holds when an explicit deep override raises the ceiling: walking every page
// blindly is not affordable, so a data-driven stop is required. The age-window rule here
// avoids the exact failure mode the old naive cutoff had — it fires only when
// a page carries enough dated evidence to be conclusive AND is entirely
// out-of-window, TWICE in a row (a single relevance reshuffle does not produce
// two consecutive entirely-out-of-window pages; a walk that has genuinely paged
// past the window does), and unparseable dates never count as evidence, so a
// source with no visible posted date on its cards can never trip it (it falls
// back to empty-page/no-new-jobs instead). See jobPageStop.js's header comment
// for the full rule set and STOP_STREAK/MIN_DATED_EVIDENCE constants.
//
// Streak state (outOfWindowStreak / staleStreak / seenKeys) lives inside one
// makeJobPageStop instance and must never be shared across queries or sources
// — a fresh instance per task is required, not a shared closure.



// Location helpers (deriveLocationParam / summarizeLocationAdherence /
// LOCATION_TREATMENT) live in src/utils/jobLocation.js — dependency-free + unit-
// tested there; imported at the top of this file.

// Google for Jobs accepts no reliable location parameter. Put the canonical
// location into its keyword query instead, but do not repeat a place the query
// generator already supplied. Comparison is punctuation/case-insensitive, and a
// matching first location component (e.g. "Toronto" for "Toronto, ON") counts
// as present so we don't produce "Toronto Toronto, ON".
function googleKeywordWithLocation(query, location) {
  const keyword = String(query || '').trim().replace(/\s+/g, ' ');
  const loc = String(location || '').trim().replace(/\s+/g, ' ');
  if (!keyword || !loc) return keyword;
  // The location IS appended, including a bare country — measured, and the
  // measurement inverted an earlier assumption. `udm=8` does hard-AND
  // out-of-vocabulary tokens (a nonsense word collapses the query to 0), but a
  // place name is NOT treated as a free-text term: Google lifts it out as a
  // LOCATION SCOPE, and that scope OVERRIDES the browser's geolocation.
  //
  // From a Canadian egress, `Systems Architect` and `Systems Architect jobs`
  // returned 0/159 and 0/151 US postings — every card was Toronto/Ontario.
  // Adding "United States" returned 173/173 US, and RAISED reachable depth in
  // all three roles tested (+14, +6, +9). Dropping it does not tighten the
  // query; it hands the entire result set to whatever IP the run happens to
  // egress from. That is the single largest correctness lever on this source.
  //
  // Contrast the " jobs" suffix, removed in the same pass and correctly so: it
  // never moved geography (0% US both with and without) and its depth effect was
  // erratic and role-dependent, costing 57% of reachable results on one role.

  const words = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const keywordWords = words(keyword);
  const locationWords = words(loc);
  const firstComponentWords = words(loc.split(',')[0]);
  const hasPhrase = (phrase) => !!phrase && (` ${keywordWords} `).includes(` ${phrase} `);

  if (hasPhrase(locationWords) || hasPhrase(firstComponentWords)) return keyword;
  return `${keyword} ${loc}`;
}

const GLASSDOOR_POSTED_BUCKETS = Object.freeze([1, 3, 7, 14, 30]);

/** Smallest supported Glassdoor fromAge bucket that does not narrow the request. */
export function glassdoorPostedBucket(days) {
  const wanted = Math.max(1, Math.floor(Number(days) || DEFAULT_MAX_AGE_DAYS));
  return GLASSDOOR_POSTED_BUCKETS.find((bucket) => bucket >= wanted) || null;
}

// `opts` (resume only): { onlySources: Set, startPageBySourceQuery: { [id]: [{ startPage, durable }] } }.
// URL-paginated sources resume each task from its own cursor. Google has one
// result view per query and skips a query whose view is already durable.
// Glassdoor's load-more UI has no random-access URL, so it deliberately
// replays its view and relies on staged rows/dedup rather than claiming a jump.
export function buildJobTasks(queries, maxAgeDays, opts = {}, location = '', collectionLimits = null, countryScope = '') {
  const {
    onlySources = null,
    startPageBySource = null,
    startPageBySourceQuery = null,
    collectionStartTimestamp = null,
    maxAgeDaysBySource = null,
    collectionStartTimestampBySource = null,
    // sourceId → test for "an earlier run already read or showed this listing".
    alreadyReadBySource = null,
    // sourceId → test for "this listing is still owed from an earlier scan".
    owedBySource = null,
  } = opts;
  const limits = normalizeJobCollectionLimits(collectionLimits);
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  const glassdoorDays = glassdoorPostedBucket(days);
  // Board-ready location filter (already flattened from the structured canonical
  // by deriveLocationParam). Appended as each board's REAL location param so a
  // location-free query no longer searches nationwide. Empty → omitted (nationwide,
  // the correct default for a remote / no-location search). Google for Jobs has no
  // clean location param, so we append the canonical place to its keyword query.
  const loc = String(location || '').trim();
  // Country-only market scope. It is deliberately NOT folded into `loc`: `loc`
  // is a board's location FILTER and a remote search must not be narrowed by
  // one, while the market a board serves still has to be pinned. Falls back to
  // the filter's own country when both are present.
  const country = String(countryScope || '').trim();
  const glassdoorCountry = normalizeLocationInput(loc || country).countryCode;
  const glassdoorHost = glassdoorCountry === 'CA'
    ? 'www.glassdoor.ca'
    : 'www.glassdoor.com';
  const locParam = (name) => loc ? `&${name}=${encodeURIComponent(loc)}` : '';
  // Browser pool extractors — only platforms that REQUIRE local browser rendering.
  // Indeed runs as a browser source in the search-jobs driver (not here); RemoteOK
  // and WeWorkRemotely are pure-HTTP and live in fetchHttpSources.
  //
  // `paginates: true` marks a source whose task walks multiple result pages in one
  // same-session task (see the loop below). This is now an EXPLICIT flag rather
  // than the old `maxPages > 1` check: pagesPerPlatform defaults to "All" (null),
  // so a raw limit can no longer double as "did the user/source want pagination" —
  // `resolvePageCeiling(limits)` always returns a finite number (the backstop when
  // unlimited), and branching on that would make every source look paginating.
  // Google (paginates: false) is a single-page/scroll source; its own maxPages: 1
  // below is unrelated to the resolved ceiling — it's just a non-paginating marker.
  // `urlFn(q, page)` builds the 0-based page URL for paginating sources.
  //
  // Every task's `options` below carries the same contract regardless of source:
  // maxPages (resolved, always finite — a backstop against a runaway pager, not
  // the intended stop condition), unlimitedPages, maxAgeDays, collectionLimits, and
  // a FRESH onPageScraped (makeJobPageStop, one instance per task/query so its
  // streak state never leaks across queries or sources). See jobPageStop.js's
  // header comment for the empty-page / age-window / no-new-jobs rules that now
  // decide when a walk stops, instead of exhausting the ceiling. Sources that
  // DATE-FILTER server-side (Glassdoor fromAge / ZipRecruiter days) additionally
  // narrow what a page can even return; recency is enforced by that filter + the
  // client age-filter, not by sorting — each source stays on its default RELEVANCE
  // sort (no sort param) so the walk keeps the most-relevant in-window jobs,
  // consistent with the relevance-sorted API sources.
  // Declaration order here IS the run order for the manual-scraper sources
  // (scrapeManualSources groups bySource preserving it). Per BROWSER_SCRAPE_ORDER
  // the manual trio runs ZipRecruiter → Glassdoor → Google (Indeed runs first, but
  // it's a separate launcher handled in the search-jobs browser driver, not here).
  const pageCeiling = resolvePageCeiling(limits);
  const pageBudgets = resolveBrowserPageBudgets(limits, queries.length);
  const unlimitedPages = isUnlimitedPages(limits);
  const extractors = {
    ziprecruiter:    { extractor: ZIPRECRUITER_EXTRACTOR, config: ZIPRECRUITER_CONFIG, paginates: true,
                       urlPaginated: true, // first URL can jump to an arbitrary page → supports per-page resume
                       urlFn: (q, page, sourceDays = days) => `https://www.ziprecruiter.com/jobs-search${page > 0 ? `/${page + 1}` : ''}?search=${encodeURIComponent(q)}${locParam('location')}&days=${sourceDays}` },
    // Glassdoor migrated to Next.js with infinite-scroll "Show more" pagination —
    // the old ?p=N URL param is silently ignored (every "page" returns page 1).
    // One URL load + the configured page count minus one button clicks replaces the old N-page walk.
    // No locKeyword: Glassdoor ignores the location TEXT (LOCATION_TREATMENT
    // documents this), and it is emitted only when `loc` is truthy — exactly
    // when resolveGlassdoorLocation is set two statements below and overwrites
    // the URL with a real locId before the first navigation. Sending it changed
    // nothing except making the first-navigation URL in the bug report look like
    // a locKeyword search, and it is the measured trigger for the country
    // redirect that silently moved a US search onto glassdoor.ca.
    glassdoor:       { extractor: GLASSDOOR_EXTRACTOR,    config: GLASSDOOR_CONFIG,    paginates: true,
                       // Glassdoor accepts only its UI buckets. Round UP so the
                       // source never under-fetches the requested window; the
                       // global client filter trims the extra tail. Above its
                       // largest bucket, omit fromAge and rely on the client.
                       urlFn: (q, _page, sourceDays = days) => {
                         const bucket = sourceDays === days ? glassdoorDays : glassdoorPostedBucket(sourceDays);
                         return `https://${glassdoorHost}/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}${bucket ? `&fromAge=${bucket}` : ''}`;
                       },
                       loadMoreSelector: '[data-test="load-more"]' },
    // Google Jobs: single-page scroll-loaded panel (ibp=htl;jobs). No pagination —
    // scroll logic is handled by SCROLL_SOURCES in manualScraper.js. Does not throw
    // SITE_CHANGED on 0 (bot detection can block the panel entirely). Last: public,
    // non-interactive, fast.
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,  config: GOOGLE_JOBS_CONFIG,  paginates: false, maxPages: 1,
                       // Google deprecated ibp=htl;jobs → it 302s to ?q=…&udm=8 (the new
                       // Jobs layout). Build udm=8 directly to skip the redirect hop.
                       // No " jobs" suffix: `udm=8` IS the jobs vertical, so the
                       // word is vestigial (it dates from the removed
                       // `ibp=htl;jobs` form). Because udm=8 AND-requires every
                       // free-text token, appending it made "jobs" a term each
                       // posting had to contain, and it double-appended on any
                       // query already ending in "jobs".
                       // `loc || country`: a REMOTE search deliberately produces an
                       // empty `loc` (a location FILTER must not narrow it), which
                       // left Google with the bare template — and the bare template
                       // is pinned to the EGRESS METRO, not nationwide. Measured
                       // from a Canadian exit: the bare query returned 0/159 US
                       // cards, all Toronto/Ontario, while appending the country
                       // returned 173/173 US AND raised reachable depth. So a
                       // remote search was silently answered with jobs near
                       // whatever IP the run left from. The country is the correct
                       // scope precisely here, because remote IS nationwide.
                       urlFn: (q) => `https://www.google.com/search?q=${encodeURIComponent(googleKeywordWithLocation(q, loc || country))}&udm=8` },
  };

  const tasks = [];
  for (const [sourceId, { extractor, config, urlFn, paginates = false, loadMoreSelector = null, urlPaginated = false }] of Object.entries(extractors)) {
    if (!ACTIVE_SOURCE_ID_SET.has(sourceId)) continue;
    if (onlySources && !onlySources.has(sourceId)) continue; // resume: skip already-'done' sources
    const querySubset = queries;
    // Per-source date windows narrow the run's own window. A platform with no
    // entry uses the run values verbatim (the pre-feature behaviour), and the
    // Glassdoor bucket is recomputed from THIS source's days so a narrower
    // window never asks the board for a wider fromAge than it must.
    const requestedSourceDays = maxAgeDaysBySource && Object.hasOwn(maxAgeDaysBySource, sourceId)
      ? Number(maxAgeDaysBySource[sourceId])
      : NaN;
    const sourceDays = Number.isFinite(requestedSourceDays) && requestedSourceDays > 0
      ? Math.max(1, Math.floor(requestedSourceDays))
      : days;
    const requestedSourceStart = collectionStartTimestampBySource
      && Object.hasOwn(collectionStartTimestampBySource, sourceId)
      ? Number(collectionStartTimestampBySource[sourceId])
      : NaN;
    const sourceCollectionStartTimestamp = Number.isFinite(requestedSourceStart)
      ? requestedSourceStart
      : collectionStartTimestamp;

    // One task per query. `id` stays `${sourceId}-${n}` so `res.id.replace(/-\d+$/,'')`
    // still maps a result back to its source. A multi-page source runs as a SINGLE
    // paginating task (same-session walk inside the browser pool); a single-page
    // source (Google) runs as a one-shot scrape.
    let idx = 0;
    for (const q of querySubset) {
      const queryIndex = idx++;
      const queryPlan = startPageBySourceQuery?.[sourceId]?.[queryIndex];
      // Compatibility with callers/tests that supplied a text-keyed map before
      // the durable ledger became index-keyed. New recovery always uses the
      // aligned array, so duplicate query strings never collapse.
      const legacyQueryCursor = !Array.isArray(startPageBySourceQuery?.[sourceId])
        ? startPageBySourceQuery?.[sourceId]?.[q]
        : null;
      const queryCursor = Number.isSafeInteger(queryPlan?.startPage)
        ? queryPlan.startPage
        : legacyQueryCursor;
      const legacyCursor = startPageBySource?.[sourceId];
      const requestedStartPage = Number.isSafeInteger(queryCursor) && queryCursor > 1
        ? queryCursor
        : (Number.isSafeInteger(legacyCursor) && legacyCursor > 1 ? legacyCursor : 1);
      if (queryPlan?.terminal === true || (sourceId === 'google' && (queryPlan?.durable === true || (legacyQueryCursor != null && Number.isSafeInteger(queryCursor) && queryCursor >= 1)))) continue;
      const startPage = urlPaginated ? requestedStartPage : 1;
      const queryPageBudget = pageBudgets[queryIndex] ?? pageCeiling;
      // Do not even open a browser tab for a URL-paginated query whose durable
      // cursor has exhausted its original per-query allocation.
      if (urlPaginated && queryPlan?.durable === true && startPage > queryPageBudget) continue;
      const base = { id: `${sourceId}-${queryIndex}`, sourceId, url: urlFn(q, startPage - 1, sourceDays), extractorJS: extractor, query: q, queryIndex };
      // Glassdoor's location filter needs a numeric locId (its locKeyword text is
      // ignored). The scraper resolves it in-browser (CF-gated) just before nav and
      // appends &locId=&locT= to the URL — see resolveGlassdoorLocId.
      // Resolve a locId for the location when there is one, and for the bare
      // COUNTRY when there is not, so the applied-location proof has something
      // to check instead of going inert on a remote search.
      //
      // ⚠️ A NATION-tier locId does NOT actually filter. Measured on Glassdoor:
      // `_IN1` ("United States") returned Toronto/Mississauga listings under the
      // header "50,231 United States jobs"; `_IN1` and `_IN3` returned identical
      // counts; and Ontario alone (`_IS4080`, 83,887) exceeded all of Canada
      // (`_IN3`, 50,233) — impossible if the nation tier filtered. It persists
      // with countryRedirect=false, so the TLD hop is not the cause. STATE, CITY
      // and METRO tiers ARE honoured cross-border. So a country-scoped Glassdoor
      // run is really scoped by the browsing egress, and the page echoes the
      // country you asked for — a header or label check would pass it. The
      // scraper records that caveat rather than reporting a country filter it
      // cannot deliver; see the nation-tier warning in manualScraper.js.
      if (sourceId === 'glassdoor' && (loc || country)) {
        base.resolveGlassdoorLocation = loc || country;
        // A location the user actually asked for is a HARD boundary: if its
        // locId cannot be verified the source is skipped rather than silently
        // widened to nationwide. A bare country on a REMOTE search is only a
        // market hint — nationwide is already the correct result there — so a
        // failed lookup must not turn a working Glassdoor run into zero rows.
        if (!loc) base.glassdoorLocationSoftScope = true;
      }
      // Fresh onPageScraped per query — makeJobPageStop's streak state
      // (outOfWindowStreak/staleStreak/seenKeys) must never be shared across
      // queries or sources, or one query's early rows would silently poison
      // another's stop decision.
      const onPageScraped = makeJobPageStop({ maxAgeDays: sourceDays, unlimited: unlimitedPages, sourceLabel: sourceId });
      if (paginates) {
        base.options = {
          ...config,
          paginate: true,
          // Declares that this source's page number lives in the URL, so the
          // scraper can ASSERT the page actually turned before extracting.
          // Without it a slow page load made the extractor re-read the previous
          // page, whose rows all dedup away — reported as a board-side clamp.
          urlPaginated,
          // manualScraper compares its 1-based absolute page number with this
          // end bound. The per-query budget is a lifetime ceiling, including
          // any pages staged before a crash; a resume can use only its
          // unconsumed portion and never extends Auto beyond 40/source.
          maxPages: queryPageBudget,
          unlimitedPages,
          maxAgeDays: sourceDays,
          collectionLimits: limits,
          collectionStartTimestamp: sourceCollectionStartTimestamp,
          ...(typeof alreadyReadBySource?.[sourceId] === 'function' ? { isAlreadyRead: alreadyReadBySource[sourceId] } : {}),
          ...(typeof owedBySource?.[sourceId] === 'function' ? { isOwed: owedBySource[sourceId] } : {}),
          startPageNum: startPage,
          nextUrl: (page) => urlFn(q, page, sourceDays),
          onPageScraped,
          pageDelayMs: PAGE_DELAY_MS,
          ...(loadMoreSelector ? { loadMoreSelector } : {}),
        };
      } else {
        // Google has one result view, but its scroll/preload loop treats the
        // configured page count as its maximum reveal iterations — resolved,
        // not the raw (possibly null/"All") pagesPerPlatform.
        base.options = {
          ...config,
          maxPages: queryPageBudget,
          unlimitedPages,
          maxAgeDays: sourceDays,
          collectionLimits: limits,
          collectionStartTimestamp: sourceCollectionStartTimestamp,
          ...(typeof alreadyReadBySource?.[sourceId] === 'function' ? { isAlreadyRead: alreadyReadBySource[sourceId] } : {}),
          ...(typeof owedBySource?.[sourceId] === 'function' ? { isOwed: owedBySource[sourceId] } : {}),
          onPageScraped,
        };
      }
      tasks.push(base);
    }
  }
  return tasks;
}

/** Preserve original Indeed query positions/budgets while omitting terminal/exhausted slots. */
export function selectIndeedResumePlan(queries, resumePlans, collectionLimits = null) {
  const queryList = Array.isArray(queries) ? queries : [];
  const originalBudgets = resolveIndeedPageBudgets(queryList.length, collectionLimits);
  const indexes = queryList.map((_query, index) => index)
    .filter(index => resumePlans?.[index]?.terminal !== true && originalBudgets[index] > 0);
  return {
    indexes,
    queries: indexes.map(index => queryList[index]),
    startPages: indexes.map((index) => {
      const cursor = resumePlans?.[index]?.startPage;
      return Number.isSafeInteger(cursor) && cursor > 1 ? cursor - 1 : 0;
    }),
    pageBudgets: indexes.map(index => originalBudgets[index]),
  };
}

// Fan-out a single-query fetcher across all queries, merge and deduplicate by
// title+company. Returns the same { items, warning } shape.
//
// `concurrency`    — max simultaneous in-flight fetcher calls (default: unbounded).
// `minIntervalMs`  — minimum ms between consecutive dispatch times, shared across
//                    all workers. Prevents request bursts that trigger per-key
//                    rate limits (e.g. Dice returns 500 when several queries fire
//                    within the same second). JS is single-threaded between awaits,
//                    so reading + bumping `nextSlotTime` is atomic — no two workers
//                    can claim the same slot.
async function queryFanOut(queries, fetcher, signal, concurrency = Infinity, minIntervalMs = 0, label = 'source') {
  // A query that throws (rather than resolving with {items, warning}, the
  // contract every extractor is expected to follow) would otherwise vanish
  // as an invisible 0-result source — no warning card, no log trace. Log it
  // here so a persistent failure in ANY fan-out source is at least visible
  // in the app logs / bug report ring buffer. Non-cancellation failures also
  // surface a safe warning/truncation fact in the source diagnostics while the
  // pipeline degrades gracefully to an empty result for that query.
  const onQueryError = (q, err) => {
    if (signal?.aborted || err?.message === 'Aborted') return { items: [] };
    logger.warn(`[${label}] Query "${q}" threw and was dropped: ${err?.message || err}`);
    // Keep the durable result terse and controlled: a query failure makes
    // coverage incomplete, but neither the query nor provider error body may
    // enter receipt/report data.
    return {
      items: [],
      warning: { code: 'query-error', severity: 'warn' },
      truncated: true,
      stopReason: 'query-error',
    };
  };
  let results;
  if (!isFinite(concurrency) || concurrency >= queries.length) {
    // Fast path — all concurrent (original behaviour for most sources)
    results = await Promise.all(
      queries.map(q => fetcher(q, signal).catch(err => onQueryError(q, err)))
    );
  } else {
    results = new Array(queries.length);
    let next = 0;
    // Shared dispatch clock: each worker atomically claims the next available
    // slot, then waits until that slot time before firing its request.
    let nextSlotTime = minIntervalMs > 0 ? Date.now() : 0;
    async function worker() {
      while (next < queries.length) {
        const idx = next++;
        if (minIntervalMs > 0) {
          // Claim the next slot. `Math.max` handles the case where a worker
          // re-enters after a long retry — it doesn't skip ahead of a slot
          // already claimed by another worker, but it also doesn't stall
          // behind a slot that's already in the past.
          const slotTime = Math.max(Date.now(), nextSlotTime);
          nextSlotTime = slotTime + minIntervalMs;
          const waitMs = slotTime - Date.now();
          // The fan-out shares the search run's cancellation signal. Waiting
          // for a pacing slot must therefore yield immediately on Cancel,
          // rather than holding the Board's serial transaction for the rest
          // of the rate-limit interval.
          if (waitMs > 0) await abortableDelay(waitMs, signal);
        }
        results[idx] = await fetcher(queries[idx], signal).catch(err => onQueryError(queries[idx], err));
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, worker));
  }
  const items = dedupJobsAcrossSources(results.flatMap(r => r?.items || []));
  // Severity-ranked, matching how the per-source rollup picks a card warning.
  // Taking the LAST query's warning let a `block` raised by query 1 be masked
  // by a trailing `info`, so a source that was actually walled could report a
  // clean `done`.
  const warned = results.filter(r => r?.warning);
  const warning = warned.find(r => r.warning.severity === 'block')?.warning
    ?? warned.find(r => r.warning.severity === 'throttle')?.warning
    ?? warned.find(r => r.warning.severity === 'warn')?.warning
    ?? [...warned].reverse()[0]?.warning
    ?? null;
  // Preserve provider-vs-app relevance accounting across query fan-out. The
  // fields are kept for sources that DO apply a local gate (the whole-feed
  // sources); USAJobs is not one of them — it reports relevanceDropped: 0 and
  // returns `mapped` unchanged. Its Keyword parameter searches the full
  // announcement and every returned row is admitted.
  const gathered = results.reduce((sum, r) => sum + Number(r?.gathered ?? r?.items?.length ?? 0), 0);
  const providerGathered = results.reduce((sum, r) => sum + Number(r?.providerGathered ?? r?.gathered ?? r?.items?.length ?? 0), 0);
  const relevanceDropped = results.reduce((sum, r) => sum + Number(r?.relevanceDropped ?? 0), 0);
  // Rejected-title samples from every query in the fan-out, deduped and re-capped
  // so a multi-query source can't blow past one query's bound.
  const relevanceRejected = [...new Set(results.flatMap(r => r?.relevanceRejected || []))].slice(0, 8);
  const itemUrls = new Set(items.map(item => item?.url).filter(Boolean));
  const relevanceTrace = results
    .flatMap(r => r?.relevanceTrace || [])
    .filter(row => !row?.url || itemUrls.has(row.url))
    .slice(0, 20);
  // Corpus-coverage evidence, aggregated the same way `providerGathered` is.
  // Dropping these here is where "44 of 973" became indistinguishable from "44
  // of 44": the single-query wrapper below reads them off this object, so a
  // fan-out source could never report an incomplete walk no matter what its
  // extractor measured. Summed only when EVERY query reported a total — one
  // query that threw or that came from a source with no corpus count makes the
  // sum a fiction, and an unproven coverage claim must read as unproven.
  const providerTotal = results.length > 0 && results.every(r => (
    r?.providerTotal != null
    && r.providerTotal !== ''
    && Number.isFinite(Number(r.providerTotal))
    && Number(r.providerTotal) >= 0
  ))
    ? results.reduce((sum, r) => sum + Number(r.providerTotal), 0)
    : null;
  const truncated = results.some(r => r?.truncated === true);
  const pageShapeFailures = results.reduce((sum, r) => sum + (Number.isSafeInteger(r?.pageShapeFailures) && r.pageShapeFailures > 0 ? r.pageShapeFailures : 0), 0);
  // MEASURED, not inferred: rows this fan-out's own dedup removed, i.e. the same
  // listing returned by more than one of the run's queries. Deriving it as a
  // residual would silently relabel any other unexplained shortfall as dedup.
  const crossQueryDuplicates = Math.max(
    0,
    results.reduce((sum, r) => sum + (Array.isArray(r?.items) ? r.items.length : 0), 0) - items.length,
  );
  // A query-level walker may stop for a meaningful reason (for example a
  // provider page cap). Preserve every distinct reason through fan-out rather
  // than losing it when the per-query envelopes are merged.
  const stopReasons = [...new Set(results.flatMap(result => (Array.isArray(result?.stopReasons)
    ? result.stopReasons
    : result?.stopReason ? [result.stopReason] : []))
    .map(reason => (typeof reason === 'string' ? reason : reason?.stopReason))
    .filter(reason => typeof reason === 'string' && reason))];
  // Unlike a browser source's deepest page number, API fan-out is a set of
  // independent request walks. Sum the pages actually fetched so a Dice
  // source's final receipt says how much API pagination it performed.
  const pagesFetched = results.reduce((sum, result) => (
    sum + Math.max(0, Number(result?.pagesFetched) || 0)
  ), 0);
  // A finite query-level ceiling is meaningful only when that query actually
  // stopped because of it. Preserve the extractor's compact metadata so the
  // HTTP wrapper can carry it into sourceResults/bySource diagnostics.
  const caps = [...new Map(results.map(result => result?.cap)
    .filter(value => (
      ['jobs-per-platform', 'pages-per-platform', 'auto-jobs-per-platform', 'auto-pages-per-platform'].includes(value?.type)
      && value.limit != null
      && value.limit !== ''
      && Number.isFinite(Number(value.limit))
      && Number(value.limit) > 0
    ))
    .map(value => [`${value.type}:${Math.floor(Number(value.limit))}`, {
      type: value.type,
      limit: Math.floor(Number(value.limit)),
    }])).values()];
  // `cap` remains for old callers/receipts, while `caps` preserves the real
  // union when different fan-out queries stopped at distinct finite limits.
  const cap = caps[0] || null;
  const walkGuards = sanitizeWalkGuards(results.flatMap(result => (Array.isArray(result?.walkGuards) ? result.walkGuards : [])), 20);
  return { items, warning, gathered, providerGathered, providerTotal, truncated, crossQueryDuplicates, relevanceDropped, relevanceRejected, relevanceTrace, stopReasons, pagesFetched, cap, caps, walkGuards, ...(pageShapeFailures > 0 ? { pageShapeFailures } : {}) };
}

// Keep the pacing/cancellation behavior observable without exposing the
// production helper as part of the jobs IPC surface.
export function __queryFanOutForTests(queries, fetcher, signal, options = {}) {
  const {
    concurrency = Infinity,
    minIntervalMs = 0,
    label = 'test source',
  } = options || {};
  return queryFanOut(queries, fetcher, signal, concurrency, minIntervalMs, label);
}

/**
 * LinkedIn's query walk for this run. Entries carry each query's position in
 * the run's full list. `carried` is the text subset a blocked earlier run left
 * (fresh runs only); `resumePlan` is the index-aligned crash-recovery plan, in
 * which a terminal query is skipped. `skipped` lists the skipped query texts.
 */
export function buildLinkedInQueryPlan(queries, carried = null, resumePlan = null) {
  const all = (Array.isArray(queries) ? queries : [queries]).map((query, index) => ({ query, index }));
  if (Array.isArray(resumePlan) && resumePlan.length === all.length) {
    const entries = all.filter(entry => resumePlan[entry.index]?.terminal !== true);
    const skipped = all.filter(entry => resumePlan[entry.index]?.terminal === true).map(entry => entry.query);
    return { entries, skipped };
  }
  if (Array.isArray(carried)) {
    // The carried list is the full list with finished texts filtered out, so a
    // text filter over the full list reproduces it with exact positions. Any
    // other shape keeps its own order with no ledger position (text-keyed).
    const keep = new Set(carried);
    const entries = all.filter(entry => keep.has(entry.query));
    const sameOrder = entries.length === carried.length && entries.every((entry, i) => entry.query === carried[i]);
    return { entries: sameOrder ? entries : carried.map(query => ({ query, index: null })), skipped: [] };
  }
  return { entries: all, skipped: [] };
}

export const __fetchHttpSourcesForTests = (...args) => fetchHttpSources(...args);

/**
 * Fetch API-based sources in parallel (no Puppeteer needed).
 * @returns {{ sourceId: string, jobs: object[], error?: string }[]}
 */
export async function fetchHttpSources(queries, sender, signal = null, nodeId = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, preferredLocation = '', onlySources = null, emit = null, stageSource = null, collectionLimits = null, beforeSourceDispatch = null, afterProviderResult = null, maxAgeDaysBySource = null, queriesBySource = null, {
  // Index-aligned crash-recovery plan per source (computeResumeStartPagesByQuery).
  // Only LinkedIn consumes it here: a query whose ledger entry is terminal was
  // already walked and checkpointed by this run, so it is not fetched again.
  queryPlansBySource = null,
  // Per-query durable checkpoint (the browser sources' page hook). LinkedIn
  // calls it once per cleanly finished query with that query's rows.
  stageQuery = null,
  // Unit-test seam only (request pacing); production never passes it.
  linkedInFetchOptions = null,
} = {}) {
  // Route progress through the caller's recorder (emitProgress) so the five
  // pure-HTTP sources appear in jobsTelemetry.sourceEvents — without this they
  // bypassed the trail and were invisible in bug reports (exactly the sources
  // most prone to silent blocks: Dice 500s, LinkedIn walls). Falls back to a raw
  // send if no recorder is passed.
  const send = emit || ((payload) => { if (sender && !sender.isDestroyed()) sender.send('job-source-progress', payload); });
  // Source credentials come from Settings (electron-store) with a legacy
  // process.env fallback handled inside getJobsSettings() for users still
  // on the old .env config.
  const { usajobsApiKey: apiKey, usajobsEmail: email } = getJobsSettings();
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  // A platform with its own (narrower) window uses ITS horizon for the server-side
  // request; every other platform keeps the run window verbatim.
  const daysForSource = (sourceId) => {
    const requested = maxAgeDaysBySource && Object.hasOwn(maxAgeDaysBySource, sourceId)
      ? Number(maxAgeDaysBySource[sourceId])
      : NaN;
    return Number.isFinite(requested) && requested > 0 ? Math.max(1, Math.floor(requested)) : days;
  };
  const limits = normalizeJobCollectionLimits(collectionLimits);
  // This is a per-query retrieval budget, not the final source aggregate. The
  // source fan-out retains each query's bounded result so the central exact
  // window/source-identity pass can fill the platform allowance from sibling
  // queries without turning a small explicit choice into an unbounded crawl.
  const usajobsRowBudget = resolveJobsPerPlatform(limits);
  const location = String(preferredLocation || '').trim();
  const queryTotal = getQueryProgressTotal(queries);
  // Whole-feed remote boards cannot receive a location parameter. Exclude the
  // requested-location words from their title matcher so an incidental city
  // suffix cannot become role evidence for an otherwise unrelated listing.
  const wholeFeedGeoTerms = buildGeoTermSet(location ? [location] : []);

  // Pure-HTTP sources ONLY — no browser, no shared profile, so they run fully
  // concurrent with each other AND with the serialized browser driver. Indeed is
  // NOT here (it is browser-based and runs in the search-jobs browser driver).
  // LinkedIn's walk plan, as { query, index } entries in the run's own query
  // positions so a checkpoint lands on the same ledger key a resume reads.
  const linkedInPlan = buildLinkedInQueryPlan(queries, queriesBySource?.linkedin, queryPlansBySource?.linkedin);
  // Rows LinkedIn already checkpointed per query. The whole-source stage at
  // the end writes only the rest, so a finished query's rows are appended once.
  const linkedInCheckpointed = new Set();
  const apiTasks = [
    // LinkedIn alone may be given fewer queries: the ones a blocked earlier run
    // already finished are left out (see carriedFinishedQueries in search-jobs),
    // and a resumed run leaves out the ones this run already checkpointed.
    { sourceId: 'linkedin',      fn: async (s) => {
      const result = await fetchLinkedInJobs(linkedInPlan.entries.map(entry => entry.query), s, daysForSource('linkedin'), location, ({ completed, count, detail }) => {
      // Intermediate heartbeat during LinkedIn's multi-minute paced walk — without
      // this the pre-loop 'searching' stamp below is the only event LinkedIn ever
      // emits until it fully resolves, which reads as a stale/hung task in a bug
      // report even though it's progressing normally (humanDelay pacing is
      // intentional — see fetchLinkedInJobs). `total` stays this run's queryTotal
      // rather than the extractor's own count so one source never reports two
      // different denominators mid-run.
      send({ nodeId, sourceId: 'linkedin', status: 'searching', count, detail, completed: completed + linkedInPlan.skipped.length, total: queryTotal });
      }, {
        ...(linkedInFetchOptions && typeof linkedInFetchOptions === 'object' ? linkedInFetchOptions : {}),
        onQueryFinished: typeof stageQuery === 'function'
          ? async ({ queryIndex, query, jobs, pages }) => {
            const entry = linkedInPlan.entries[queryIndex];
            await stageQuery({
              sourceId: 'linkedin',
              query: entry?.query ?? query,
              queryIndex: Number.isSafeInteger(entry?.index) ? entry.index : null,
              page: pages,
              jobs,
              terminal: true,
            });
            for (const job of jobs) linkedInCheckpointed.add(job);
          }
          : null,
      });
      // A query skipped because this run already finished it is still a
      // finished query of this run: the walk-complete and carried-query
      // bookkeeping downstream must not mistake it for one never walked.
      if (linkedInPlan.skipped.length > 0 && result && !Array.isArray(result)) {
        result.finishedQueries = [...linkedInPlan.skipped, ...(Array.isArray(result.finishedQueries) ? result.finishedQueries : [])];
      }
      return result;
    } },
    // USAJobs now walks its pager to the provider's own reported total, which
    // for a broad keyword is ~1000 rows rather than the old single 150-row page.
    { sourceId: 'usajobs',       fn: (s) => queryFanOut(queries, (q, sig) => fetchUSAJobs(q, apiKey, email, sig, daysForSource('usajobs'), location, usajobsRowBudget), s, Infinity, 0, 'USAJobs API') },
    { sourceId: 'remoteok',      fn: (s) => fetchRemoteOKJobs(queries, s, wholeFeedGeoTerms) },
    { sourceId: 'weworkremotely',fn: (s) => fetchWeWorkRemotelyJobs(queries, s, wholeFeedGeoTerms) },
    { sourceId: 'dice',          fn: async (s) => {
      // Pre-warm the key before fan-out so all queries use a fresh key.
      // Dice rate-limits by request rate (not just concurrency): firing several
      // requests within the same second triggers 500 even with a fresh key.
      // minIntervalMs=350 spaces queries ~350ms apart (12 queries ≈ 4s total),
      // keeping each request well within the per-key burst window.
      // Enrichment (detail fetch) is deferred to after history dedup so we
      // only fetch descriptions for jobs that will actually be scored/shown.
      await warmDiceApiKey(s);
      logger.info(`[Dice API] Fan-out starting: ${queries.length} queries, 350ms interval`);
      return queryFanOut(queries, (q, sig) => fetchDiceListings(q, location, sig, daysForSource('dice'), limits), s, 4, 350, 'Dice API');
    }},
  ].filter(task => ACTIVE_SOURCE_ID_SET.has(task.sourceId) && (!onlySources || onlySources.has(task.sourceId)));

  // Notify frontend that API sources are starting
  for (const { sourceId } of apiTasks) {
    send({ nodeId, sourceId, status: 'searching', count: 0, completed: 0, total: queryTotal });
  }

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      // An exact recovery token is a capability for one durable manifest, not
      // a permission to continue after another run has replaced it. Keep this
      // immediately adjacent to the provider call: browser sources make the
      // same check in their sequential dispatch loop below.
      if (typeof beforeSourceDispatch === 'function') await beforeSourceDispatch(sourceId);
      recordJobSourceDispatch(sourceId);
      // Each API fetcher now returns { items, warning } so blocks/throttles
      // can surface in the UI instead of silently producing an empty array.
      const result = await fn(signal);
      // Provider completion is another authority boundary. In particular, a
      // late S1 result must not emit a terminal card, checkpoint its rows, or
      // be collapsed into a successful empty source after S2 owns the hub.
      if (typeof afterProviderResult === 'function') await afterProviderResult(sourceId, result);
      // Extractors cooperatively return a warning-free cancelled envelope
      // after an abort-aware delay/backoff. Do not paint it as a clean zero,
      // stage it, or turn it into a source error; the enclosing gather joins
      // then call throwIfSearchAborted() to terminate the run quietly.
      if (signal?.aborted || result?.cancelled) {
        return { sourceId, jobs: [], cancelled: true };
      }
      const rawJobs = Array.isArray(result) ? result : (result?.items || []);
      const warning = Array.isArray(result) ? null : (result?.warning || null);
      // Keyword-less remote feeds return a small explanation of each relevance
      // admission (query terms + title match; RemoteOK also preserves its tags).
      // Keep it separate from jobs so it cannot pollute cards, scoring prompts,
      // saved snapshots, or history rows.
      const allRelevanceTrace = Array.isArray(result) ? [] : (result?.relevanceTrace || []);
      // Keep every fetched, source-unique row through the central admission
      // boundary below.  Slicing here used to let an old row (or a row that
      // later failed the exact country/window checks) spend a platform slot,
      // with no way to backfill it from the rest of this source's fan-out.
      // `gathered` remains the provider-facing coverage count; the one real
      // Jobs-per-platform slice now happens after the exact window and
      // same-platform identity pass.
      const gathered = Array.isArray(result) ? rawJobs.length : (result?.gathered ?? rawJobs.length);
      const providerGathered = Array.isArray(result) ? rawJobs.length : (result?.providerGathered ?? gathered);
      const relevanceDropped = Array.isArray(result) ? 0 : (result?.relevanceDropped ?? 0);
      const sponsoredDropped = Array.isArray(result) ? 0 : (result?.sponsoredDropped ?? 0);
      // Whole-feed sources filter before this wrapper applies the persisted
      // per-platform cap. Preserve those early drops separately so the central
      // funnel can reconstruct provider rows rather than reporting only the
      // already-admitted subset as its raw count.
      const preCapRelevanceDropped = Array.isArray(result) ? 0 : (result?.preCapRelevanceDropped ?? 0);
      // Titles the relevance gate rejected (bounded sample) — diagnostics only,
      // never merged into jobs. See fetchUSAJobs for why the count alone is not
      // enough to tell a healthy gate from one that is starving the source.
      const relevanceRejected = Array.isArray(result) ? [] : (result?.relevanceRejected || []);
      // RemoteOK's whole feed is widened with a bounded set of query-derived
      // tag feeds. Carry only compact row counts/scopes so an all-rejected run
      // can be reconstructed in JOBS/FULL without retaining discarded postings.
      const remoteFeedProvenance = Array.isArray(result) ? [] : (result?.remoteFeedProvenance || []);
      // Provider-reported corpus size and walk outcomes. Carried through because
      // a source that WAS truncated and one that genuinely had this many rows are
      // otherwise byte-identical in the report: `providerGathered` is already the
      // truncated number, so nothing downstream could tell them apart.
      const providerTotal = Array.isArray(result) ? null : (result?.providerTotal ?? null);
      const truncated = Array.isArray(result) ? false : !!result?.truncated;
      const crossQueryDuplicates = Array.isArray(result) ? 0 : (Number(result?.crossQueryDuplicates) || 0);
      const stopReasons = Array.isArray(result) ? [] : (result?.stopReasons || []);
      const finishedQueries = Array.isArray(result) || !Array.isArray(result?.finishedQueries) ? [] : result.finishedQueries;
      const sourceCap = Array.isArray(result) ? null : (result?.cap ?? null);
      const sourceCaps = Array.isArray(result) ? [] : (Array.isArray(result?.caps) ? result.caps : []);
      const pagesFetched = Array.isArray(result) ? 0 : Math.max(0, Number(result?.pagesFetched) || 0);
      const walkGuards = Array.isArray(result) ? [] : sanitizeWalkGuards(result?.walkGuards, 20);
      const pageShapeFailures = Array.isArray(result) ? 0 : (Number.isSafeInteger(result?.pageShapeFailures) && result.pageShapeFailures > 0 ? result.pageShapeFailures : 0);
      const jobs = rawJobs;
      const capDropped = 0;
      const returnedUrls = new Set(jobs.map(job => job?.url).filter(Boolean));
      const relevanceTrace = allRelevanceTrace.filter(row => returnedUrls.has(row?.url));
      // Emit live completion so the source card updates as soon as this source
      // finishes — without this, all API cards stay "Searching..." until the
      // browser scraper finishes too (the final per-source loop runs post-Promise.all).
      send({
        nodeId,
        sourceId,
        status: warning?.severity === 'block' ? 'error' : 'done',
        count: jobs.length,
        warning: warning || null,
        completed: queryTotal,
        total: queryTotal,
      });
      // Flush this source to crash-recovery staging the moment IT finishes —
      // HTTP sources resolve in seconds while the browser phase runs for
      // minutes (the dominant crash window), so waiting for the gather join
      // (the old behavior) lost all HTTP results to a browser-phase crash and
      // forced a resume to re-fetch them. A clean zero is also a durable
      // completion fact: stage it now so it is not retried during that window.
      if (stageSource) {
        // Query-fanout converts a single failed query into a compact warning
        // rather than rejecting the whole source. Preserve that incompleteness
        // at the early durability boundary: a crash during the browser phase
        // must not turn partial HTTP coverage into a terminal source.
        const retryablePartial = warning?.code === 'query-error'
          || (sourceId === 'remoteok'
            && warning?.severity === 'throttle'
            && remoteFeedProvenance.some(entry => entry?.fanoutStopped === true));
        const unstaged = sourceId === 'linkedin' && linkedInCheckpointed.size > 0
          ? jobs.filter(job => !linkedInCheckpointed.has(job))
          : jobs;
        await stageSource({ sourceId, jobs: unstaged, warning, retryablePartial });
      }
      return { sourceId, jobs, warning, gathered, providerGathered, providerTotal, truncated, capDropped, crossQueryDuplicates, stopReasons, finishedQueries, sourceCap, sourceCaps, pagesFetched, relevanceDropped, sponsoredDropped, preCapRelevanceDropped, relevanceRejected, remoteFeedProvenance, relevanceTrace, walkGuards, ...(pageShapeFailures > 0 ? { pageShapeFailures } : {}) };
    } catch (error) {
      // Ownership loss is pipeline-wide, not a source-level provider error.
      // Let the search handler return its stable resumeRunMissing/mismatch
      // contract instead of converting it to a retriable empty source.
      if (error?.exactResumeOwnershipFailure || isJobOperationSupersededError(error)) throw error;
      if (signal?.aborted) return { sourceId, jobs: [], cancelled: true };
      send({ nodeId, sourceId, status: 'error', count: 0, completed: queryTotal, total: queryTotal });
      return { sourceId, jobs: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Resolve only the board location. Target-role searches use this path so the
 * model is never asked to invent search-query variations whose output would be
 * discarded. Known Canadian/U.S. inputs are normalized without an LLM call;
 * typos, other countries, regions, remote phrasing, and country inference use a
 * narrow location-only response.
 */
export async function resolveJobSearchLocation(profile, preferredLocation, signal) {
  const location = String(preferredLocation || '').trim();
  const normalizedInput = normalizeLocationInput(location);
  if (normalizedInput.countryConflict) {
    throw new Error(`Preferred location "${location}" combines a Canadian province/territory with the United States, or a U.S. state with Canada. Correct the country and try again.`);
  }
  if (location && normalizedInput.countryCode) {
    return { canonicalLocation: normalizedInput.boardReady, locationModel: null };
  }

  const locationInstruction = location ? `
Resolve this free-form preferred job-search location: ${location}
It may be a city, state, region, remote/hybrid phrase, another country, or a typo (for example "denvr"). Correct typos and return a strictly place-shaped canonicalLocation. For U.S. cities use a 2-letter state code in stateCode and "City, ST" in display. For non-U.S. cities use the full province/region name and "City, Province, Country" in display. A bare state/province belongs in region. Remote-only uses isRemote=true and display="".` : `
No preferred location was supplied. Infer only the candidate's country from the professional profile (recent/dominant work location, stated location, or education). Return canonicalLocation with country populated and city/stateCode/region/display empty and isRemote=false. If the country genuinely cannot be inferred, return every string field empty.`;
  const meta = {};
  const result = await callLLMText(`
You resolve the geographic filter for a job search. Do not generate, suggest, or rewrite any job-search query.${locationInstruction}

Professional profile:
${JSON.stringify(profile || {})}

Return only { "canonicalLocation": { "city": "", "stateCode": "", "region": "", "country": "", "isRemote": false, "display": "" } }.`, {
    signal,
    task: 'job-query-generation',
    responseSchema: JOB_LOCATION_RESOLUTION_SCHEMA,
    meta,
  });
  const struct = (result && typeof result.canonicalLocation === 'object' && result.canonicalLocation) || {};
  return {
    canonicalLocation: deriveLocationParam(struct, location),
    // The COUNTRY survives even when the flattened param does not. A remote-only
    // search returns '' from deriveLocationParam (correctly — "Remote, United
    // States" must never reach a board's location field), which used to erase
    // the market entirely: Glassdoor then resolved no locId, its applied-location
    // proof went inert, and the .com→.ca geo-redirect silently decided which
    // country's jobs came back. Kept separate so it can pin the market without
    // narrowing a remote search.
    canonicalCountry: String(struct?.country || '').trim(),
    locationModel: meta.model || null,
  };
}
