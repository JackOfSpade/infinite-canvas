// Generate-time listing check. Page evidence exists only for this click; the
// prepared record receives the bounded liveness pair and audit fact.
import { prepareBackgroundScrapeLaunchOptions, createBackgroundScrapePage } from './browser/backgroundScrapeBrowser.js';
import { detectAntiBotSignal } from './antiBotDetector.js';
import { normaliseJobPostingVariants } from './applicationBundle.js';
import { buildListingLivenessRequest, validateListingLivenessResponse } from './listingLivenessAi.js';
import { getListingLivenessCalibrationStore } from './listingLivenessCalibration.js';
import {
  LISTING_LIVENESS_RULES, classifyListingLiveness, evidenceFromHtml,
  finalizeListingEvidence, listingLivenessPageProbe,
} from './listingLiveness.js';
import { withListingClosed, withListingLiveness } from './officialPostingBoardClosed.js';
import {
  boardClosedBoardLabel, normalizeBoardClosed, normalizeListingLiveness,
  normalizeOfficialPosting, officialResearchSettled,
} from './officialPostingFields.js';
import { cappedHandoff } from './officialPostingService.js';
import { callLLMText } from './llm.js';
import { withSharedProfileLock } from './sharedProfileLock.js';

export const LISTING_PROBE_LOCK_WAIT_MS = 120_000;
export const LISTING_PROBE_VISIT_MS = 60_000;
export const LISTING_GENERATION_AI_MS = 5 * 60_000;
const FRESH_OPEN_MS = 24 * 60 * 60_000;
const AI_MIN_REMAINING_MS = 90_000;
const MAX_GENERATION_VARIANT_PROBES = 4;
const PROBE_HOST_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:linkedin\.com|ziprecruiter\.com|dice\.com|indeed\.[a-z.]{2,}|remoteok\.(?:com|io)|weworkremotely\.com)(?:[/:?#]|$)/i;
const AUDIT_OUTCOMES = new Set(['open', 'unobservable', 'override', 'unavailable', 'official', 'alternate']);
const AUDIT_BASES = new Set(['open-marker', 'structural', 'ai', 'closed-marker', 'neither', 'both', 'official', 'unobservable', 'unavailable']);
const INDEED_ROOT_HOSTS = new Set(['indeed.com', 'indeed.co.uk', 'indeed.com.au', 'indeed.co.nz',
  'indeed.co.in', 'indeed.ca', 'indeed.ie', 'indeed.de', 'indeed.fr', 'indeed.sg']);
const GENERIC_HTML_HOSTS = new Set(['remoteok', 'weworkremotely']);
const countNames = ['checked', 'proceedOfficial', 'refusedFinal', 'refusedRetry', 'refusedPossiblyClosed', 'held', 'override', 'unobservable'];
const counts = Object.fromEntries(countNames.map(key => [key, 0]));

export function getListingLivenessProbeCounts() { return { ...counts }; }
export function recordGenerationFallbackHold(result) {
  if (result?.listingCheck?.action === 'hold') counts.held += 1;
  return result;
}
export function normalizeListingAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !AUDIT_OUTCOMES.has(value.outcome)) return null;
  if (value.outcome === 'unavailable' && Object.keys(value).length === 1) return { outcome: 'unavailable' };
  if (Object.keys(value).length !== 3 || !AUDIT_BASES.has(value.basis)
    || typeof value.at !== 'string' || value.at.length > 40 || !Number.isFinite(Date.parse(value.at))) return null;
  return { outcome: value.outcome, basis: value.basis, at: new Date(Date.parse(value.at)).toISOString() };
}

function hostKind(url) {
  if (typeof url !== 'string' || !PROBE_HOST_RE.test(url)) return '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
    if (host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com')) return 'ziprecruiter';
    if (host === 'dice.com' || host.endsWith('.dice.com')) return 'dice';
    if ([...INDEED_ROOT_HOSTS].some(root => host === root || host.endsWith(`.${root}`))) return 'indeed';
    if (['remoteok.com', 'remoteok.io'].some(root => host === root || host.endsWith(`.${root}`))) return 'remoteok';
    if (host === 'weworkremotely.com' || host.endsWith('.weworkremotely.com')) return 'weworkremotely';
  } catch { /* Bad URLs are unobservable. */ }
  return '';
}
/** The card regex is a conservative fallback; this host guard protects navigation. */
export function isProbeableListingHost(url) { return Boolean(hostKind(url)); }
const unknown = reason => ({ unknown: String(reason || 'probe-unavailable').slice(0, 80) });
const codeError = code => Object.assign(new Error(code), { code });
const aborted = signal => { if (signal?.aborted) throw signal.reason || codeError('listing-probe-aborted'); };
const statusOf = response => typeof response?.status === 'function' ? response.status() : null;

function withDeadlineSignal(parent, milliseconds, code) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason || codeError('listing-probe-aborted'));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(codeError(code)), Math.max(1, milliseconds));
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); } };
}
async function abortable(promise, signal) {
  aborted(signal);
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason || codeError('listing-probe-aborted')); });
  signal?.addEventListener('abort', rejectAbort, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal?.removeEventListener('abort', rejectAbort); }
}
async function delay(ms, signal) {
  if (ms <= 0) return;
  await abortable(new Promise(resolve => setTimeout(resolve, ms)), signal);
}

// One gate across rapid Generate clicks, including separate prepare invocations.
let linkedInPacingTail = Promise.resolve();
let linkedInRequestsIssued = 0;
let linkedInLastDispatchAt = 0;
async function pacedLinkedIn(signal, now = Date.now) {
  const task = linkedInPacingTail.then(async () => {
    aborted(signal);
    const { linkedInDescriptionPacing } = await import('../extractors/apiExtractors.js');
    aborted(signal);
    const pacing = linkedInDescriptionPacing({ mode: 'guest', requestsIssued: linkedInRequestsIssued });
    const floor = pacing.checkpointDue ? pacing.checkpointCooldownMs : pacing.requestDelayMs;
    if (linkedInRequestsIssued) await delay(Math.max(0, linkedInLastDispatchAt + floor - now()), signal);
    aborted(signal);
    linkedInLastDispatchAt = now();
    linkedInRequestsIssued += 1;
  });
  linkedInPacingTail = task.catch(() => {});
  return abortable(task, signal);
}

async function singletonPageVisit(url, { signal, job, rules, guest = false }) {
  const { getStealthBrowser } = await import('./stealthBrowser.js');
  const { LINKEDIN_LOGIN_WALL_RE } = guest ? await import('../extractors/apiExtractors.js') : {};
  let context; let page;
  try {
    const browser = await abortable(getStealthBrowser(), signal);
    aborted(signal);
    context = guest ? await abortable(browser.createBrowserContext(), signal) : null;
    page = await abortable(guest ? context.newPage() : browser.newPage(), signal);
    await abortable(page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' }), signal);
    const response = await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), signal);
    const finalUrl = page.url() || url;
    const httpStatus = statusOf(response);
    if (guest && LINKEDIN_LOGIN_WALL_RE.test(finalUrl)) return unknown('login-wall');
    if ([404, 410].includes(httpStatus)) return { requestedUrl: url, finalUrl, httpStatus, title: '', chromeText: '' };
    const raw = await abortable(page.evaluate(listingLivenessPageProbe, { rules, expectedTitle: job.title }), signal);
    return { ...raw, requestedUrl: url, finalUrl, httpStatus };
  } finally {
    if (context) await context.close().catch(() => {});
    else await page?.close().catch(() => {});
  }
}

async function defaultLinkedInVisit(url, options) {
  return singletonPageVisit(url, { ...options, guest: true });
}
async function defaultZipRecruiterVisit(url, options) {
  const { getStealthBrowser } = await import('./stealthBrowser.js');
  const { getChallengeSignals: getManualChallengeSignals, isAppcastTemporaryRestriction,
    isZipRecruiterClosedDetailRedirect, isZipRecruiterDetailErrorShell } = await import('./browser/manualScraper.js');
  let context; let page;
  try {
    const browser = await abortable(getStealthBrowser(), options.signal);
    context = await abortable(browser.createBrowserContext(), options.signal);
    page = await abortable(context.newPage(), options.signal);
    const response = await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), options.signal);
    const finalUrl = page.url() || url;
    const httpStatus = statusOf(response);
    if (httpStatus === 429) return unknown('rate-limit');
    if (isZipRecruiterClosedDetailRedirect(finalUrl)) {
      return { requestedUrl: url, finalUrl, httpStatus, title: '', chromeText: '',
        zipRecruiterClosedJobRedirect: true };
    }
    if ([404, 410].includes(httpStatus)) return { requestedUrl: url, finalUrl, httpStatus, title: '', chromeText: '' };
    const challenge = await abortable(getManualChallengeSignals(page), options.signal);
    if (challenge?.isChallenge || challenge?.isHardBlock || challenge?.reason === 'evaluate-failed') return unknown('challenge');
    const raw = await abortable(page.evaluate(listingLivenessPageProbe, {
      rules: options.rules, expectedTitle: options.job.title,
    }), options.signal);
    const visibleText = `${raw?.title || ''} ${raw?.chromeText || ''}`;
    if (isAppcastTemporaryRestriction({ url: finalUrl, visibleText })) return unknown('appcast');
    if (isZipRecruiterDetailErrorShell({ url: finalUrl, visibleText })) return unknown('error-shell');
    return { ...raw, requestedUrl: url, finalUrl, httpStatus };
  } finally {
    if (context) await context.close().catch(() => {});
    else await page?.close().catch(() => {});
  }
}

async function defaultIndeedVisit(url, { signal, job, rules }) {
  const { closeOwnedBrowserProcess, closeStealthBrowser, findChromePath,
    findSystemChromePath, getUserDataDir, launchWithProfileLockRetry,
    reserveSharedProfile } = await import('./stealthBrowser.js');
  const { getChallengeSignals: getIndeedChallengeSignals } = await import('../extractors/indeedBrowser.js');
  let releaseReservation; let browser; let page;
  try {
    await closeStealthBrowser(false);
    aborted(signal);
    releaseReservation = reserveSharedProfile('listing-liveness-indeed');
    const executablePath = await abortable(findSystemChromePath().then(path => path || findChromePath()), signal);
    const userDataDir = await abortable(getUserDataDir(), signal);
    browser = await launchWithProfileLockRetry(prepareBackgroundScrapeLaunchOptions({
      headless: false, executablePath, userDataDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--window-size=1400,900', '--lang=en-US,en'],
      defaultViewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, signal,
    }), 'listing-liveness-indeed', url);
    page = await abortable(createBackgroundScrapePage(browser, { width: 1400, height: 900 }), signal);
    const response = await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), signal);
    const finalUrl = page.url() || url;
    const httpStatus = statusOf(response);
    if ([404, 410].includes(httpStatus)) return { requestedUrl: url, finalUrl, httpStatus, title: '', chromeText: '' };
    const challenge = await abortable(getIndeedChallengeSignals(page), signal);
    if (challenge?.isChallenge) return unknown('challenge');
    const raw = await abortable(page.evaluate(listingLivenessPageProbe, { rules, expectedTitle: job.title }), signal);
    return { ...raw, requestedUrl: url, finalUrl, httpStatus };
  } finally {
    await page?.close().catch(() => {});
    if (browser) await closeOwnedBrowserProcess(browser, { label: 'Listing liveness Indeed probe', gracefulMs: 5_000 });
    releaseReservation?.();
  }
}

async function defaultHtmlFetch(url, options) {
  const { fetchHtmlClean } = await import('./stealthBrowser.js');
  return fetchHtmlClean(url, options);
}
const ruleKeyForHost = kind => GENERIC_HTML_HOSTS.has(kind) ? 'generic' : kind;

/** A one-page, no-retry visit. Inject visits to test dispatch without browsers. */
export function createListingLivenessProbe({
  job, visitLinkedIn = defaultLinkedInVisit, visitIndeed = defaultIndeedVisit,
  visitZipRecruiter = defaultZipRecruiterVisit, fetchDiceHtml = defaultHtmlFetch,
  fetchGenericHtml = defaultHtmlFetch,
  withProfileLock = withSharedProfileLock, paceLinkedIn = pacedLinkedIn,
  rulesFor = key => LISTING_LIVENESS_RULES[key], now = Date.now,
  lockWaitMs = LISTING_PROBE_LOCK_WAIT_MS, visitMs = LISTING_PROBE_VISIT_MS,
} = {}) {
  if (!job || typeof job !== 'object') throw new TypeError('Listing probe requires a job.');
  async function probe(url, { signal } = {}) {
    const kind = hostKind(url);
    if (!kind) return unknown('unobservable');
    aborted(signal);
    const { getSharedProfileReservationInfo } = await import('./stealthBrowser.js');
    if (getSharedProfileReservationInfo()) return unknown('profile-reserved');
    let lock;
    try {
      // Guest cadence may wait; the shared profile is held only for the visit.
      if (kind === 'linkedin') await paceLinkedIn(signal, now);
      aborted(signal);
      lock = withDeadlineSignal(signal, Math.min(LISTING_PROBE_LOCK_WAIT_MS, lockWaitMs), 'listing-lock-timeout');
      return await withProfileLock(async () => {
        aborted(lock.signal);
        const visit = withDeadlineSignal(lock.signal, Math.min(LISTING_PROBE_VISIT_MS, visitMs), 'listing-visit-timeout');
        try {
          const ruleKey = ruleKeyForHost(kind);
          const rules = rulesFor(ruleKey) || LISTING_LIVENESS_RULES[ruleKey];
          const options = { signal: visit.signal, job, rules };
          let raw;
          if (kind === 'linkedin') raw = await visitLinkedIn(url, options);
          else if (kind === 'indeed') raw = await visitIndeed(url, options);
          else if (kind === 'ziprecruiter') raw = await visitZipRecruiter(url, options);
          else raw = await abortable((kind === 'dice' ? fetchDiceHtml : fetchGenericHtml)(url,
            { signal: visit.signal, timeoutMs: 55_000 }), visit.signal);
          aborted(visit.signal);
          if (raw?.unknown) return unknown(raw.unknown);
          if (kind === 'dice' || GENERIC_HTML_HOSTS.has(kind)) {
            if (raw?.ok === false) return unknown('browser-failure');
            const page = evidenceFromHtml(raw?.html || '', { board: job.source || kind, ruleKey,
              requestedUrl: url, finalUrl: raw?.finalUrl || url, httpStatus: raw?.status ?? null,
              expectedTitle: job.title, expectedCompany: job.company, expectedLocation: job.location,
              rules });
            if (GENERIC_HTML_HOSTS.has(kind)) {
              const wall = detectAntiBotSignal({ status: raw?.status ?? 0, finalUrl: raw?.finalUrl || url,
                html: `${page.title} ${page.chromeText}`, title: page.title });
              if (wall?.severity === 'block' || wall?.code === 'http-429') return unknown('challenge');
            }
            raw = page;
          }
          const evidence = finalizeListingEvidence(raw, { board: job.source || kind, ruleKey,
            requestedUrl: url, finalUrl: raw?.finalUrl || url, httpStatus: raw?.httpStatus ?? null,
            expectedTitle: job.title, expectedCompany: job.company, expectedLocation: job.location });
          const status = Number(evidence.httpStatus);
          if (status === 0 || status === 401 || status === 403 || status === 429 || status >= 500) return unknown('http-wall');
          if ([404, 410].includes(status) && evidence.finalHostClass === 'other') return unknown('other-host-not-found');
          if (![404, 410].includes(status) && !raw?.zipRecruiterClosedJobRedirect
            && evidence.workdayPostingAvailable !== false
            && !`${evidence.title}${evidence.h1}${evidence.chromeText}${evidence.descriptionText}`.trim()) return unknown('empty-body');
          if (kind === 'linkedin') {
            const { LINKEDIN_LOGIN_WALL_RE } = await import('../extractors/apiExtractors.js');
            if (LINKEDIN_LOGIN_WALL_RE.test(evidence.finalUrl || '')) return unknown('login-wall');
          }
          if (kind === 'ziprecruiter') {
            const { isAppcastTemporaryRestriction, isZipRecruiterDetailErrorShell } = await import('./browser/manualScraper.js');
            if (isAppcastTemporaryRestriction({
              url: evidence.finalUrl || '', visibleText: `${evidence.title} ${evidence.chromeText}`,
            })) return unknown('appcast');
            if (isZipRecruiterDetailErrorShell({
              url: evidence.finalUrl || '', visibleText: `${evidence.title} ${evidence.chromeText}`,
            })) return unknown('error-shell');
          }
          return evidence;
        } finally { visit.close(); }
      }, lock.signal, 'listing liveness one-page visit');
    } catch (error) {
      aborted(signal);
      return unknown(error?.code === 'listing-lock-timeout' ? 'lock-timeout'
        : error?.code === 'listing-visit-timeout' ? 'visit-timeout' : 'browser-failure');
    } finally { lock?.close(); }
  }
  return Object.freeze({ probe });
}

const boardOf = job => normalizeListingLiveness(job?.listingLiveness)?.board
  || normalizeBoardClosed(job?.boardClosed)?.board || job?.source || 'listing';
const pairOf = job => ({
  listingLiveness: normalizeListingLiveness(job?.listingLiveness),
  boardClosed: normalizeBoardClosed(job?.boardClosed),
});
const isOfficialLive = posting => ['L1', 'L2', 'L3', 'L4'].includes(posting?.level)
  && ['found', 'link-only'].includes(posting?.outcome);
const hasClosedMarker = basis => basis === 'closed-marker' || basis === 'both';
function fixedMessage(action, verdict, basis, board, posting) {
  const label = boardClosedBoardLabel(board) || 'Listing';
  if (action === 'refuse-final') return 'Listing closed — no open posting found';
  if (action === 'refuse-retry' && verdict === 'closed') {
    return posting?.outcome === 'ambiguous' || posting?.trail?.includes('comparative-disagree')
      ? `Closed on ${label} — several official postings match`
      : `Closed on ${label} — official posting not checked yet`;
  }
  if (action === 'refuse-retry' && hasClosedMarker(basis)) return `Possibly closed on ${label} — not confirmed yet`;
  if (action === 'hold') return "Couldn't confirm the listing is still open";
  return '';
}

/** Pure matrix; the caller supplies the resolved current state. */
export function decideGenerationListingCheck({
  job, posting, verdict = 'unknown', basis = 'neither', at = Date.now(), listingOverride = false,
} = {}) {
  const official = normalizeOfficialPosting(posting);
  const board = boardOf(job);
  const timestamp = new Date(at).toISOString();
  let action = 'hold';
  if (isOfficialLive(official) || verdict === 'open' || verdict === 'unobservable') action = 'proceed';
  else if (verdict === 'closed') {
    action = officialResearchSettled(official) && ['not-found', 'closed'].includes(official.outcome)
      ? 'refuse-final' : 'refuse-retry';
  } else if (hasClosedMarker(basis)) action = 'refuse-retry';
  // A deliberate user override bypasses every listing-status pause. Keep the
  // observed verdict and basis intact for the audit and card display.
  const override = listingOverride === true && action !== 'proceed';
  if (override) action = 'proceed';
  const listingCheck = { action, verdict: isOfficialLive(official) ? 'unobservable' : verdict,
    basis: isOfficialLive(official) ? 'official' : basis, board, at: timestamp, override };
  const message = fixedMessage(action, verdict, basis, board, official).slice(0, 160);
  const outcome = action !== 'proceed' ? null : isOfficialLive(official) ? 'official'
    : override ? 'override' : verdict === 'unobservable' ? 'unobservable'
      : verdict === 'open' ? 'open' : 'unavailable';
  const listingAudit = outcome ? normalizeListingAudit({
    outcome, basis: isOfficialLive(official) ? 'official' : verdict === 'unobservable' ? 'unobservable'
      : override ? basis : verdict === 'open' ? basis : 'unavailable', at: timestamp,
  }) : null;
  return { listingCheck, message, listingAudit };
}

function stampedResult(job, posting, verdict, basis, at, listingOverride) {
  return { ...decideGenerationListingCheck({ job, posting, verdict, basis, at, listingOverride }), ...pairOf(job) };
}

/** Official-first Generate decision, with a single-row AI handoff when useful. */
export async function checkListingForGeneration({
  job, posting, probe, callText = callLLMText, bridgeAvailable = false, calibrationStore,
  signal, now = Date.now, deadline = null,
  manualAiRunId = null, nodeId = null, listingOverride = false,
} = {}) {
  if (!job || typeof job !== 'object') throw new TypeError('Listing check requires a job.');
  const expiresAt = deadline ?? now() + 15 * 60_000;
  counts.checked += 1;
  const official = normalizeOfficialPosting(posting);
  const stored = pairOf(job);
  const board = boardOf(job);
  const finish = (row, verdict, basis) => {
    const result = stampedResult(row, official, verdict, basis, now(), listingOverride);
    if (result.listingCheck.action === 'refuse-final') counts.refusedFinal += 1;
    else if (result.listingCheck.action === 'refuse-retry') {
      counts.refusedRetry += 1;
      if (verdict !== 'closed' && hasClosedMarker(basis)) counts.refusedPossiblyClosed += 1;
    } else if (result.listingCheck.action === 'hold') counts.held += 1;
    if (result.listingAudit?.outcome === 'official') counts.proceedOfficial += 1;
    if (result.listingAudit?.outcome === 'unobservable') counts.unobservable += 1;
    if (result.listingAudit?.outcome === 'override') counts.override += 1;
    return result;
  };
  const storedVerdict = stored.listingLiveness?.verdict || (stored.boardClosed ? 'pending' : 'unknown');
  const storedBasis = stored.listingLiveness?.basis || (stored.boardClosed ? 'closed-marker' : 'neither');
  if (isOfficialLive(official)) return finish(job, storedVerdict, storedBasis);
  if (storedVerdict === 'closed' && ['structural', 'ai'].includes(storedBasis)) return finish(job, 'closed', storedBasis);
  const latestDemotedAt = async () => {
    try {
      const store = calibrationStore || getListingLivenessCalibrationStore();
      return await store.latestDemotedAt?.(ruleKeyForHost(hostKind(job.url)) || board) || null;
    } catch { return null; }
  };
  if (storedVerdict === 'open' && ['open-marker', 'ai'].includes(storedBasis)) {
    const age = now() - Date.parse(stored.listingLiveness.at);
    const demotedAt = await latestDemotedAt();
    aborted(signal);
    if (age >= 0 && age < FRESH_OPEN_MS && (!demotedAt || Date.parse(stored.listingLiveness.at) > Date.parse(demotedAt))) {
      return finish(job, 'open', storedBasis);
    }
  }
  if (!isProbeableListingHost(job.url)) return finish(job, 'unobservable', 'unobservable');
  if (listingOverride) return finish(job, storedVerdict === 'closed' ? 'closed'
    : storedVerdict === 'pending' && hasClosedMarker(storedBasis) ? 'pending' : 'unknown', storedBasis);
  if (now() >= expiresAt) return GENERIC_HTML_HOSTS.has(hostKind(job.url))
    ? finish(job, 'unobservable', 'unobservable') : finish(job, 'pending', storedBasis);
  let evidence;
  try {
    evidence = await (probe || createListingLivenessProbe({ job })).probe(job.url, { signal });
    aborted(signal);
  } catch (error) {
    aborted(signal);
    throw error;
  }
  const kind = hostKind(job.url);
  if (evidence?.unknown) return GENERIC_HTML_HOSTS.has(kind)
    ? finish(job, 'unobservable', 'unobservable') : finish(job, 'unknown', storedBasis);
  const ruleKey = ruleKeyForHost(kind) || 'generic';
  let rules;
  try {
    const snapshot = await (calibrationStore || getListingLivenessCalibrationStore()).snapshot();
    rules = snapshot.rulesFor(ruleKey);
  }
  catch { rules = LISTING_LIVENESS_RULES[ruleKey]; }
  aborted(signal);
  const classification = classifyListingLiveness(evidence, rules);
  if (classification.verdict === 'unknown') return GENERIC_HTML_HOSTS.has(kind)
    ? finish(job, 'unobservable', 'unobservable') : finish(job, 'unknown', storedBasis);
  if (classification.verdict === 'closed') {
    const stamped = withListingClosed(job, { board, basis: 'structural',
      reason: evidence.workdayPostingAvailable === false ? 'workday-posting-unavailable'
        : [404, 410].includes(Number(evidence.httpStatus)) ? 'http-not-found'
          : 'ziprecruiter-closed-job-redirect', now: new Date(now()) });
    return finish(stamped, 'closed', 'structural');
  }
  if (classification.verdict === 'open') {
    return finish(withListingLiveness(job, { board, verdict: 'open', basis: 'open-marker', now: new Date(now()) }),
      'open', 'open-marker');
  }
  const pending = withListingLiveness(job, {
    board, verdict: 'pending', basis: classification.basis, now: new Date(now()),
  });
  const remaining = expiresAt - now();
  if (!bridgeAvailable || remaining < AI_MIN_REMAINING_MS || typeof callText !== 'function') {
    return finish(pending, 'pending', classification.basis);
  }
  const members = [{ row: pending, evidence }];
  const request = buildListingLivenessRequest(members);
  const stats = { handoffs: 0, handoffMs: 0 };
  try {
    const raw = await cappedHandoff(request, { call: callText, signal,
      timeoutMs: Math.min(LISTING_GENERATION_AI_MS, remaining),
      manualAiRunId, nodeId, now, stats });
    aborted(signal);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const answer = validateListingLivenessResponse(parsed, members).rows[0];
    const store = calibrationStore || getListingLivenessCalibrationStore();
    await store.recordAiAnswer?.({ ruleKey, evidence, verdict: answer.verdict, now: now() });
    aborted(signal);
    const stamped = answer.verdict === 'closed'
      ? withListingClosed(pending, { board, reason: 'ai-confirmed-closed', basis: 'ai', now: new Date(now()) })
      : withListingLiveness(pending, { board, verdict: answer.verdict, basis: 'ai', now: new Date(now()) });
    return finish(stamped, answer.verdict, 'ai');
  } catch {
    aborted(signal);
    return finish(pending, 'pending', classification.basis);
  }
}

/** Keep variant links unless this visit confirms that exact variant is closed.
 * The primary listing decision is deliberately outside this helper. */
export async function checkPostingVariantsForGeneration({
  job, variants = job?.postingVariants, probe, callText = callLLMText, bridgeAvailable = false,
  calibrationStore, signal, now = Date.now, deadline = null, manualAiRunId = null, nodeId = null,
} = {}) {
  if (!job || typeof job !== 'object') throw new TypeError('Variant check requires a job.');
  const retained = [];
  const bounded = normaliseJobPostingVariants(variants);
  const expiresAt = deadline ?? now() + 15 * 60_000;
  const store = calibrationStore || getListingLivenessCalibrationStore();
  let snapshot; let snapshotAttempted = false; let probes = 0;
  for (const variant of bounded) {
    if (variant.liveness === 'closed') continue;
    const url = variant.url || variant.googleCardUrl;
    const kind = hostKind(url);
    if (!kind || probes >= MAX_GENERATION_VARIANT_PROBES || now() >= expiresAt || signal?.aborted) {
      retained.push(variant);
      continue;
    }
    probes += 1;
    const row = { ...job, url, source: variant.source || job.source,
      location: variant.location || job.location };
    const visit = withDeadlineSignal(signal, expiresAt - now(), 'listing-variant-timeout');
    let raw;
    try { raw = await (probe || createListingLivenessProbe({ job: row })).probe(url, { signal: visit.signal }); }
    catch { retained.push(variant); continue; }
    finally { visit.close(); }
    if (raw?.unknown || signal?.aborted || now() >= expiresAt) { retained.push(variant); continue; }
    const ruleKey = ruleKeyForHost(kind);
    let evidence; let classification;
    try {
      evidence = finalizeListingEvidence(raw, { board: row.source || kind, ruleKey,
        requestedUrl: url, finalUrl: raw?.finalUrl || url, httpStatus: raw?.httpStatus ?? null,
        expectedTitle: row.title, expectedCompany: row.company, expectedLocation: row.location });
      if (!snapshotAttempted) {
        snapshotAttempted = true;
        try { snapshot = await store.snapshot(); } catch { /* Static rules remain available. */ }
      }
      const rules = snapshot?.rulesFor(ruleKey) || LISTING_LIVENESS_RULES[ruleKey];
      classification = classifyListingLiveness(evidence, rules);
    } catch { retained.push(variant); continue; }
    if (classification.verdict === 'closed') continue;
    if (classification.verdict !== 'needs-ai' || !bridgeAvailable || typeof callText !== 'function'
      || expiresAt - now() < AI_MIN_REMAINING_MS) {
      retained.push(variant);
      continue;
    }
    const members = [{ row, evidence }];
    const remaining = expiresAt - now();
    try {
      const request = buildListingLivenessRequest(members);
      const answerRaw = await cappedHandoff(request, { call: callText, signal,
        timeoutMs: Math.min(LISTING_GENERATION_AI_MS, remaining), manualAiRunId, nodeId, now,
        stats: { handoffs: 0, handoffMs: 0 } });
      if (signal?.aborted || now() >= expiresAt) { retained.push(variant); continue; }
      const answer = validateListingLivenessResponse(typeof answerRaw === 'string' ? JSON.parse(answerRaw) : answerRaw,
        members).rows[0];
      try { await store.recordAiAnswer?.({ ruleKey, evidence, verdict: answer.verdict, now: now() }); }
      catch { /* Calibration availability cannot discard a valid page decision. */ }
      if (answer.verdict !== 'closed') retained.push(variant);
    } catch { retained.push(variant); }
  }
  return retained;
}
