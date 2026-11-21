/**
 * Glassdoor description route: each row's own /job-listing/ page first, then the
 * list-card side panel for every row the job page could not read.
 *
 * Measured live 2026-11-20 (same IP, the app's Chrome for Testing build):
 * - Panel API: 10 panels per rolling 5 minutes (DESC_CONFIGS.glassdoor
 *   panelWindowMs/panelWindowMax), so 180 panels take ~85-90 minutes.
 * - Job page: full JobPosting JSON-LD (description, datePosted, baseSalary,
 *   hiringOrganization). Its own limit is separate from the panel's: ~13 pages
 *   in a burst, then about one per ~6 s. A 3 s gap (≈6 s cadence with the ~3 s
 *   load) gave 30/30, then 21/30 with a 429 after ~51 pages; a 2 s gap gave 13
 *   and then a 429 on every page, and the next batch drew a Cloudflare check.
 *   The 429 page has HTTP status 429 and the title "Security | Glassdoor".
 * - Host: Glassdoor's own English www.glassdoor.ca search links its cards to
 *   fr.glassdoor.ca/job-listing/… (30/30), and every successful job-page load
 *   (~70, full JSON-LD) was on fr.; the same job on www.glassdoor.ca — where the
 *   extractor rewrites the saved link — drew "Just a moment..." with block text,
 *   and the app's own run on www. got a 403 "Security | Glassdoor" with
 *   hard-block text on its first page. So the route opens the address as
 *   Glassdoor linked it (row.glassdoorJobPageUrl, unpinned, same country
 *   domain only) with the list page as Referer; rows without it fall back to
 *   the saved url pinned to the list host. The field is scrape-only and is
 *   stripped before rows leave the scraper (withoutGlassdoorJobPageUrl).
 *
 * So the job page is opened at a 4 s base gap (≈7 s cadence). The first 429 in
 * a source run ends this batch's job pages (the rest go to the panel) and raises
 * the gap to 8 s for later batches; the second 429 turns the job-page route off
 * for the rest of the source run. Any challenge, Turnstile, "Humans only" or
 * hard block on a job page is never waited on or foregrounded: it turns the
 * route off at once, the detail tab is closed, and the panel takes the rest.
 *
 * A panel block (DETAIL_BLOCK_WARNING_CODES from the panel fallback) only stops
 * the PANEL part while the job-page route is still on: later batches keep
 * reading job pages and defer just their panel rows, with the same cooldown /
 * small re-probe ladder the source-wide block uses. The source-wide block is
 * armed by the caller only once both routes are blocked.
 */
import {
  DETAIL_BLOCK_MAX_REPROBES,
  DETAIL_BLOCK_PROBE_CARDS,
  DETAIL_BLOCK_WARNING_CODES,
  descriptionNavigationDecision,
  detailBlockCooldownMs,
} from './walkRules.js';
import { formatJsonLdSalary, pinGlassdoorDetailUrlToListHost } from './detailParsing.js';
import { measurementPacingOff } from '../scrapeMeasurement.js';

export const GLASSDOOR_JOB_PAGE_GAP_MS = 4000;
export const GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS = 8000;
// One bounded re-probe window for a page whose first read is a 429, the
// Security page, unreadable, or has no JobPosting description: Cloudflare can
// inject its widget just after DOMContentLoaded. Same size as the detail walk's
// DETAIL_CHALLENGE_SETTLE_MS; never a wait for a person.
export const GLASSDOOR_JOB_PAGE_SETTLE_MS = 2500;

/**
 * Fixed codes for why the job-page route stopped; 'none' = it did not stop.
 * 'unreadable' = the page probe failed twice; it ends only that batch's job
 * pages (like a first 429's batch fallback) without counting toward the 429
 * ladder or raising the gap, since nothing showed Glassdoor throttling.
 */
export const GLASSDOOR_JOB_PAGE_STOP_REASONS = Object.freeze(['none', 'unreadable', '429-first', '429-second', 'challenge']);

const STOP_REASON_RANK = { none: 0, unreadable: 1, '429-first': 2, '429-second': 3, challenge: 4 };

/** The source-run ladder state kept on walkPlan.detailPacing. */
export function glassdoorJobPageState(detailPacing) {
  const pacing = detailPacing && typeof detailPacing === 'object' ? detailPacing : {};
  pacing.glassdoorJobPage ||= { rateLimits: 0, off: false, stopReason: 'none', fromJobPage: 0, fromPanel: 0 };
  return pacing.glassdoorJobPage;
}

/** Gap between job-page navigation starts; 0 when a harness switched pacing off. */
export function glassdoorJobPageGapMs(rateLimitedGapMs = 0) {
  if (measurementPacingOff('glassdoor')) return 0;
  return Math.max(GLASSDOOR_JOB_PAGE_GAP_MS, Number(rateLimitedGapMs) || 0);
}

const CONTENT_GUARDED_REASONS = new Set([
  'hard-block', 'verification-text', 'visible-recaptcha-without-content', 'visible-hcaptcha-without-content',
]);

const SECURITY_TITLE = /^\s*security\s*[|\-–—]\s*glassdoor\b/iu;

/** True for the "Security | Glassdoor" page title. */
export function isGlassdoorSecurityTitle(title) {
  return SECURITY_TITLE.test(String(title || ''));
}

/**
 * What one opened job page means for the route:
 * - 'challenge': a Cloudflare Turnstile widget or frame, a challenge shell,
 *   PerimeterX or DataDome — always (strict). "Humans only"/hard-block text and
 *   visible reCAPTCHA/hCaptcha frames count only when the page has neither a
 *   JobPosting description nor normal content, the same guard
 *   classifyManualChallengeSignals applies (a posting can mention "humans only",
 *   an apply form can carry a reCAPTCHA badge). Any other classifier challenge
 *   verdict also counts.
 * - 'rate-limited': HTTP 429 or the "Security | Glassdoor" title with nothing
 *   of the above on it.
 * - 'unreadable': the page probe itself failed (reason 'evaluate-failed', e.g.
 *   a redirect destroyed the context).
 * - 'ok' otherwise.
 * `hasJobPostingDescription` is whether the page carries a JobPosting JSON-LD
 * description (null = not checked).
 */
export function glassdoorJobPageVerdict({ httpStatus = null, signals = null, hasJobPostingDescription = null } = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const strictWidget = !!s.hasCloudflareTurnstileWidget
    || !!s.hasCloudflareChallengeFrame
    || !!s.hasChallengeShell
    || !!s.hasPerimeterXBlock
    || ((!!s.hasDataDomeFrame || !!s.hasDataDomeScript || !!s.hasDataDomeBlockFrame));
  const contentPresent = hasJobPostingDescription === true || !!s.hasNormalContent;
  const humansOnly = !!s.hasTerminalHardBlockText && !contentPresent;
  const captchaFrames = (Number(s.visibleRecaptchaFrames) > 0 || Number(s.visibleHCaptchaFrames) > 0) && !contentPresent;
  const rateLimited = Number(httpStatus) === 429 || isGlassdoorSecurityTitle(s.title);
  if (strictWidget) return 'challenge';
  if (rateLimited && !humansOnly && !captchaFrames) return 'rate-limited';
  if (humansOnly || captchaFrames) return 'challenge';
  if (s.reason === 'evaluate-failed') return 'unreadable';
  // The classifier's own hard-block and text/frame verdicts rest on the same
  // signals guarded above; with the posting on the page they are not repeated.
  // Every other classifier verdict counts.
  if (s.isHardBlock && !contentPresent) return 'challenge';
  if (s.isChallenge && !(contentPresent && CONTENT_GUARDED_REASONS.has(s.reason))) return 'challenge';
  return 'ok';
}

/**
 * Fixed codes for which signals a job-page read showed, for the route-stop log
 * line and telemetry. Booleans, the HTTP status and the probe's own reason code
 * only — never page text, title text or URLs.
 */
export function glassdoorJobPageSignalCodes({ httpStatus = null, signals = null, hasJobPostingDescription = null } = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const reason = typeof s.reason === 'string' && /^[a-z0-9-]{1,48}$/u.test(s.reason) ? s.reason : 'other';
  return {
    status: Number.isFinite(Number(httpStatus)) && httpStatus != null ? Number(httpStatus) : null,
    securityTitle: isGlassdoorSecurityTitle(s.title),
    turnstileWidget: !!s.hasCloudflareTurnstileWidget,
    cfFrame: !!s.hasCloudflareChallengeFrame,
    challengeShell: !!s.hasChallengeShell,
    perimeterX: !!s.hasPerimeterXBlock,
    dataDome: !!(s.hasDataDomeFrame || s.hasDataDomeScript || s.hasDataDomeBlockFrame),
    recaptchaFrames: Number(s.visibleRecaptchaFrames) > 0,
    hcaptchaFrames: Number(s.visibleHCaptchaFrames) > 0,
    hardBlockText: !!s.hasTerminalHardBlockText,
    verificationText: !!s.hasVerificationText,
    classifierChallenge: !!s.isChallenge,
    classifierHardBlock: !!s.isHardBlock,
    hasJsonLdDescription: hasJobPostingDescription === true,
    hasNormalContent: !!s.hasNormalContent,
    probeReason: reason,
  };
}

/** `key=value` list of the codes above, for one log line. */
export function formatGlassdoorJobPageSignalCodes(codes) {
  return Object.entries(codes || {}).map(([key, value]) => `${key}=${value}`).join(' ');
}

/** Whether the first read of a page needs the one bounded re-probe. */
export function glassdoorJobPageNeedsReprobe({ httpStatus = null, signals = null } = {}) {
  return Number(httpStatus) === 429
    || isGlassdoorSecurityTitle(signals?.title)
    || signals?.reason === 'evaluate-failed';
}

/** An unreadable page ends this batch's job pages only (see STOP_REASONS). */
export function noteGlassdoorJobPageUnreadable(state) {
  state.stopReason = mostSevereStopReason(state.stopReason, 'unreadable');
  return { stopReason: 'unreadable' };
}

const HOST_HOME_CURRENCY = [
  [/(?:^|\.)glassdoor\.ca$/i, 'CAD'],
  [/(?:^|\.)glassdoor\.com$/i, 'USD'],
];
// Prefixes src/utils/salaryCurrency.js reads as explicit currencies.
const DOLLAR_PREFIX = { USD: 'US$', CAD: 'CA$', AUD: 'AU$' };

/**
 * JobPosting.baseSalary as Glassdoor's own list chips write it: a bare '$' only
 * when the currency is the list host's home currency (glassdoor.ca → CAD,
 * glassdoor.com → USD), otherwise an explicit 'US$'/'CA$'/'AU$' prefix, so a
 * USD posting on glassdoor.ca is never later read as CAD. Other currencies keep
 * formatJsonLdSalary's 'EUR ' style prefix; no currency keeps the bare '$'.
 * A min-only baseSalary (no maxValue and no value) stays unmapped, because
 * formatJsonLdSalary returns '' for it.
 */
export function glassdoorJobPageSalary(baseSalary, listUrl) {
  const formatted = formatJsonLdSalary(baseSalary);
  if (!formatted) return '';
  const currency = String(baseSalary?.currency || baseSalary?.salaryCurrency || '').toUpperCase();
  const prefix = DOLLAR_PREFIX[currency];
  if (!prefix) return formatted;
  let host = '';
  try { host = new URL(String(listUrl || '')).hostname; } catch { host = ''; }
  const home = HOST_HOME_CURRENCY.find(([pattern]) => pattern.test(host))?.[1] || null;
  return home === currency ? formatted : formatted.replaceAll('$', prefix);
}

/**
 * Advance the ladder after a 429. Returns this batch's stop reason and the gap
 * later batches use. Mutates the source-run state.
 */
export function noteGlassdoorJobPageRateLimit(state) {
  state.rateLimits = (Number(state.rateLimits) || 0) + 1;
  if (state.rateLimits >= 2) {
    state.off = true;
    state.stopReason = mostSevereStopReason(state.stopReason, '429-second');
    return { stopReason: '429-second', gapMs: GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS };
  }
  state.stopReason = mostSevereStopReason(state.stopReason, '429-first');
  return { stopReason: '429-first', gapMs: GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS };
}

/** A challenge turns the job-page route off for the rest of the source run. */
export function noteGlassdoorJobPageChallenge(state) {
  state.off = true;
  state.stopReason = mostSevereStopReason(state.stopReason, 'challenge');
  return { stopReason: 'challenge' };
}

export function mostSevereStopReason(a, b) {
  const ra = STOP_REASON_RANK[a] ?? 0;
  const rb = STOP_REASON_RANK[b] ?? 0;
  return rb > ra ? b : (STOP_REASON_RANK[a] != null ? a : 'none');
}

/**
 * The address the job-page route opens for a row: Glassdoor's own as-linked
 * job-page URL when the extractor kept one (often fr.glassdoor.ca — see
 * descriptionNavigationDecision), unpinned; otherwise the saved url pinned to
 * the list host, as before.
 */
export function glassdoorJobPageTarget(job, listUrl) {
  const asLinked = typeof job?.glassdoorJobPageUrl === 'string' ? job.glassdoorJobPageUrl.trim() : '';
  return asLinked || pinGlassdoorDetailUrlToListHost(job?.url || '', listUrl);
}

/** True when a row may be read from its own job page (same-country https /job-listing/). */
export function glassdoorJobPageEligible(job, listUrl) {
  return descriptionNavigationDecision('glassdoor', glassdoorJobPageTarget(job, listUrl), { listUrl }).allowed;
}

/**
 * The as-linked job-page address is only needed during the scrape that read it;
 * rows leave the scraper without it so saved rows keep their shape.
 */
export function withoutGlassdoorJobPageUrl(row) {
  if (!row || typeof row !== 'object' || !('glassdoorJobPageUrl' in row)) return row;
  const { glassdoorJobPageUrl: _dropped, ...rest } = row;
  return rest;
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function combinePanelResults(a, b) {
  if (!b) return a;
  const sum = key => count(a?.[key]) + count(b?.[key]);
  return {
    ...b,
    jobs: [...(a?.jobs || []), ...(b?.jobs || [])],
    descError: a?.descError || b?.descError || null,
    descWarning: b?.descWarning || a?.descWarning || null,
    expandedCount: sum('expandedCount'),
    attemptedCount: sum('attemptedCount'),
    missingCount: sum('missingCount'),
    panelTimeoutCount: sum('panelTimeoutCount'),
    panelRateLimitCount: sum('panelRateLimitCount'),
    panelHttpFailureCount: sum('panelHttpFailureCount'),
    selectionMismatchCount: sum('selectionMismatchCount'),
    unavailableDetailDropped: sum('unavailableDetailDropped'),
    boardClosedDetailKept: sum('boardClosedDetailKept'),
  };
}

/**
 * True when a panel block in this Glassdoor batch result must arm the
 * source-wide detail block: only once the job-page route is off too.
 * While job pages are still on, the block stays panel-only (state.panelBlock).
 */
export function glassdoorPanelBlockIsSourceWide(detailPacing) {
  return !!detailPacing?.glassdoorJobPage?.off;
}

/**
 * Hand a panel-only block over to the source-wide block once the job-page route
 * has turned off. Returns { code, at } to arm, or null. Clears the panel-only
 * block so it is not applied twice.
 */
export function takeGlassdoorPanelBlockForSource(detailPacing) {
  const state = detailPacing?.glassdoorJobPage;
  if (!state?.off || !state.panelBlock?.code) return null;
  const { code, at } = state.panelBlock;
  state.panelBlock = null;
  return { code, at: Number(at) || Date.now() };
}

/**
 * Run the job-page walk, then the panel walk on what is left, and merge both in
 * the original row order. `deps.byNavigation` / `deps.byPanel` are the two walks
 * (expandDescriptionsByNavigation / expandDescriptionsByPanel); `deps.record`
 * receives the batch's card-walk route summary and `deps.notePace` the
 * per-source counts. Counters are summed from the two walks, which touch
 * disjoint rows, so nothing is counted twice.
 */
export async function expandGlassdoorDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal, walkPlan, runtime, cfg, deps) {
  const rows = Array.isArray(jobs) ? [...jobs] : [];
  const detailPacing = walkPlan?.detailPacing || {};
  const state = glassdoorJobPageState(detailPacing);
  const listUrl = String(page?.url?.() || '');
  const physicalIndexes = Array.isArray(walkPlan?.physicalIndexes) ? walkPlan.physicalIndexes : [];
  const physicalTotal = Number.isFinite(Number(walkPlan?.physicalTotal)) ? Number(walkPlan.physicalTotal) : rows.length;
  const physicalIndexFor = index => (Number.isFinite(Number(physicalIndexes[index])) ? Number(physicalIndexes[index]) : index + 1);

  const routeOffAtStart = !!state.off;
  const eligible = routeOffAtStart ? [] : rows.map((job, index) => (glassdoorJobPageEligible(job, listUrl) ? index : -1)).filter(i => i >= 0);
  // 'done' rows are final: a description came from the job page, or the job
  // page reported the listing closed (closed-listing rules already applied).
  const done = new Array(rows.length).fill(false);
  let navResult = null;
  let batchStopReason = 'none';
  if (eligible.length > 0) {
    const navJobs = eligible.map(index => rows[index]);
    navResult = await deps.byNavigation(page, navJobs, sourceId, overlayBase,
      totalSoFar - rows.length + navJobs.length, signal,
      { physicalTotal, physicalIndexes: eligible.map(physicalIndexFor), detailPacing }, runtime, cfg);
    const navRows = Array.isArray(navResult?.rows) ? navResult.rows : null;
    const outcomes = Array.isArray(navResult?.rowOutcomes) ? navResult.rowOutcomes : [];
    batchStopReason = GLASSDOOR_JOB_PAGE_STOP_REASONS.includes(navResult?.jobPageRoute?.stopReason)
      ? navResult.jobPageRoute.stopReason
      : 'none';
    eligible.forEach((index, k) => {
      const outcome = outcomes[k];
      if (outcome === 'expanded' || outcome === 'closed') {
        rows[index] = navRows ? navRows[k] : rows[index];
        done[index] = true;
      }
    });
  }

  const panelIndexes = rows.map((_, index) => index).filter(index => !done[index]);
  let panelResult = null;
  let panelBlockOutcome = 'none';
  const runPanel = async (indexes) => {
    const panelJobs = indexes.map(index => rows[index]);
    const result = await deps.byPanel(page, panelJobs, sourceId, overlayBase,
      totalSoFar - rows.length + panelJobs.length, signal,
      { physicalTotal, physicalIndexes: indexes.map(physicalIndexFor), detailPacing }, runtime, cfg);
    const panelRows = Array.isArray(result?.jobs) ? result.jobs : [];
    if (panelRows.length === panelJobs.length) {
      indexes.forEach((index, k) => { rows[index] = panelRows[k]; });
    }
    return result;
  };
  const deferPanelRows = (indexes, code) => {
    for (const index of indexes) rows[index] = { ...rows[index], descriptionDeferredReason: code };
  };
  if (panelIndexes.length > 0 && !signal?.aborted) {
    const block = state.panelBlock;
    if (block?.code) {
      // Panel-only block: same cooldown ladder and small probe as the
      // source-wide block, applied to the panel rows alone.
      const now = Number(deps.now?.() ?? Date.now());
      const due = count(block.reprobes) < DETAIL_BLOCK_MAX_REPROBES
        && now - Number(block.at || 0) >= detailBlockCooldownMs(count(block.reprobes));
      if (!due) {
        deferPanelRows(panelIndexes, block.code);
        panelBlockOutcome = 'deferred';
      } else {
        const probe = panelIndexes.slice(0, DETAIL_BLOCK_PROBE_CARDS);
        const rest = panelIndexes.slice(probe.length);
        const probeResult = await runPanel(probe);
        const recovered = count(probeResult?.expandedCount) > 0
          && !probeResult?.descError
          && !DETAIL_BLOCK_WARNING_CODES.includes(probeResult?.descWarning?.code);
        if (recovered) {
          state.panelBlock = null;
          panelBlockOutcome = 'recovered';
          const restResult = rest.length > 0 && !signal?.aborted ? await runPanel(rest) : null;
          panelResult = combinePanelResults(probeResult, restResult);
        } else {
          state.panelBlock = { code: block.code, at: now, reprobes: count(block.reprobes) + 1 };
          panelBlockOutcome = 'reprobe-failed';
          deferPanelRows(rest, block.code);
          panelResult = { ...probeResult, descWarning: null, descError: null };
        }
      }
    } else {
      panelResult = await runPanel(panelIndexes);
    }
    const code = panelResult?.descWarning?.code;
    if (DETAIL_BLOCK_WARNING_CODES.includes(code)) {
      const now = Number(deps.now?.() ?? Date.now());
      state.panelBlock = { code, at: now, reprobes: count(state.panelBlock?.reprobes) };
      panelBlockOutcome = 'armed';
    }
  }

  const fromJobPage = count(navResult?.expandedCount);
  const fromPanel = count(panelResult?.expandedCount);
  state.fromJobPage = count(state.fromJobPage) + fromJobPage;
  state.fromPanel = count(state.fromPanel) + fromPanel;
  const route = {
    jobPageEligible: eligible.length,
    jobPageOpened: count(navResult?.jobPageRoute?.opened),
    silentMisses: count(navResult?.jobPageRoute?.silentMisses),
    fromJobPage,
    jobPageClosed: count(navResult?.unavailableDetailDropped) + count(navResult?.boardClosedDetailKept),
    panelFallback: panelIndexes.length,
    fromPanel,
    stopReason: batchStopReason,
    routeOffAtStart,
    sourceStopReason: state.stopReason || 'none',
    panelBlock: panelBlockOutcome,
  };
  deps.record?.(route);
  deps.notePace?.({ fromJobPage: state.fromJobPage, fromPanel: state.fromPanel, stopReason: state.stopReason || 'none' });

  // A row the job page retired is null; the panel never drops rows.
  return {
    jobs: rows.filter(Boolean).map(withoutGlassdoorJobPageUrl),
    // Only the panel walk's error and warning describe rows that are still
    // missing: the job page handed every row it could not read to the panel,
    // so its own per-row warnings would double-report them.
    descError: panelResult?.descError ?? null,
    descWarning: panelResult?.descWarning ?? null,
    expandedCount: fromJobPage + fromPanel,
    attemptedCount: count(navResult?.jobPageRoute?.opened) + count(panelResult?.attemptedCount),
    missingCount: count(panelResult?.missingCount),
    panelTimeoutCount: count(panelResult?.panelTimeoutCount),
    panelRateLimitCount: count(panelResult?.panelRateLimitCount),
    panelHttpFailureCount: count(panelResult?.panelHttpFailureCount),
    selectionMismatchCount: count(panelResult?.selectionMismatchCount),
    unavailableDetailDropped: count(navResult?.unavailableDetailDropped) + count(panelResult?.unavailableDetailDropped),
    boardClosedDetailKept: count(navResult?.boardClosedDetailKept) + count(panelResult?.boardClosedDetailKept),
    descriptionRoute: route,
  };
}
