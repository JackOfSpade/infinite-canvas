/**
 * Pure parsers, assessors and merge rules for a read job detail: title and
 * selection assessment, Glassdoor panel JSON, JSON-LD and ZipRecruiter salary,
 * the merged job record, plus the ZipRecruiter detail-page policies and tuning
 * constants. Imports only walkRules among the siblings.
 */

import { GLASSDOOR_FIRST_PARTY_HOST, descriptionNavigationDecision } from './walkRules.js';
import { decodeHtmlEntities, repairMojibake, stripHtmlToText } from '../../../../src/utils/textEncoding.js';
import { withListingClosed, withListingLiveness } from '../../officialPostingBoardClosed.js';
import { LISTING_LIVENESS_RULES, classifyListingLiveness, finalizeListingEvidence, listingLivenessPageProbe } from '../../listingLiveness.js';
import { recordListingEvidence } from '../../listingLivenessStore.js';
import { getCurrentIpcRequestContext } from '../../ipcUtils.js';
import { parseSalaryToNumeric } from '../../../../src/nodes/jobsearch/buildJobTree.js';

// ZipRecruiter will serve a plain HTTP 429 page after sustained detail-page
// navigation. These bounds deliberately slow only detail enrichment (not list
// collection), retry once, then stop the detail pass rather than hammering a
// rate-limited session for every remaining card.
export const ZIPRECRUITER_DETAIL_GAP_MS = 2500;

// The gap does NOT grow after a solved check. Measured live 2026-11-20 with
// the plain fingerprint: one check that cleared by itself in 9s escalated every
// later gap to 10-30s and cost 7 minutes of a 50-page walk, while no gap at all
// drew a 429 after ~45 pages. The 2.5s base gap is what keeps ZipRecruiter's
// request-rate limit away; the check itself came from the fingerprint
// (scrapeFingerprintPolicy), which slower pages never changed.
export function zipRecruiterDetailGapMs() {
  return ZIPRECRUITER_DETAIL_GAP_MS;
}

export const ZIPRECRUITER_429_FALLBACK_WAIT_MS = 45_000;

export const ZIPRECRUITER_429_MAX_WAIT_MS = 60_000;

// A 429 is answered by waiting, then continuing more slowly — not by giving
// up on every remaining description. Measured live 2026-11-20 (plain
// fingerprint): ~3.7s per detail page drew a 429 after ~45 pages, while ~9s
// per page walked 50 with none. After the first 429 the rest of the source's
// walk uses ZIPRECRUITER_RATE_LIMITED_GAP_MS (gap + ~3s page load ≈ 9s).
export const ZIPRECRUITER_429_RETRIES = 3;
export const ZIPRECRUITER_RATE_LIMITED_GAP_MS = 6000;

// Appcast can intermittently block a ZipRecruiter outbound detail redirect
// while the original ZipRecruiter result page remains usable. Recover once by
// discarding that detail tab, backing off, refreshing the known-good list page,
// then retrying the same detail navigation. This is intentionally small: a
// persistent restriction must be left for the user to retry after a network/IP
// change, never turned into a navigation loop.
export const ZIPRECRUITER_APPCAST_RESTRICTED_RECOVERY_RETRIES = 1;

export const ZIPRECRUITER_APPCAST_RESTRICTED_BACKOFF_MS = 6_000;

export const ZIPRECRUITER_APPCAST_RESTRICTED_MAX_BACKOFF_MS = 15_000;

// ZipRecruiter sometimes serves its own error shell ("We encountered an error
// while loading this job." + a "Reload the Job" button) for a listing that is
// perfectly fine on the next request. It is not a challenge, not a 404 and not
// a throttle, so none of the existing probes classify it — the row fell through
// to the description carriers, came back empty, and was dropped by the
// evidence gate as if the posting had no description. Retry the navigation a
// couple of times (which is what the page's own Reload button does) before
// accepting the miss. Deliberately small: a listing that is genuinely broken
// must not become a navigation loop.
export const ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES = 2;

export const ZIPRECRUITER_DETAIL_ERROR_SHELL_BACKOFF_MS = 1_500;

export const ZIPRECRUITER_DETAIL_ERROR_SHELL_MAX_BACKOFF_MS = 6_000;

// A source warning must stay compact enough for the renderer and diagnostics,
// but a first-only title made repeated, independently retained description
// misses look like a single affected listing. Keep a small title-only sample;
// URLs and page text remain in the private scraper telemetry rather than the
// source warning payload.
export const DESCRIPTION_DETAIL_MISS_SAMPLE_LIMIT = 3;

export function boundedDescriptionMissTitles(values) {
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    const title = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title || unique.includes(title)) continue;
    unique.push(title);
    if (unique.length >= DESCRIPTION_DETAIL_MISS_SAMPLE_LIMIT) break;
  }
  return unique;
}

/**
 * Preserve the existing first warning's code/severity/evidence while making
 * repeated non-blocking navigation-detail misses visible as one bounded
 * source-level warning. This intentionally aggregates only this precise
 * warning code: a later partial miss must never overwrite a higher-priority
 * block, navigation, or selector warning.
 */
export function mergeDescriptionDetailMissWarning(existing, incoming) {
  const isMiss = warning => warning?.code === 'description-detail-miss';
  if (!existing) return incoming || null;
  if (!incoming || !isMiss(existing) || !isMiss(incoming)) return existing;
  const existingCount = Math.max(1, Math.floor(Number(existing.affectedCount) || 1));
  const incomingCount = Math.max(1, Math.floor(Number(incoming.affectedCount) || 1));
  return {
    ...existing,
    affectedCount: existingCount + incomingCount,
    affectedTitles: boundedDescriptionMissTitles([
      ...(Array.isArray(existing.affectedTitles) ? existing.affectedTitles : []),
      ...(Array.isArray(incoming.affectedTitles) ? incoming.affectedTitles : []),
    ]),
  };
}

export function descriptionDetailMissWarning(sourceName, title) {
  const sampleTitle = String(title || 'an untitled listing').replace(/\s+/g, ' ').trim().slice(0, 120)
    || 'an untitled listing';
  return {
    code: 'description-detail-miss', severity: 'warn',
    evidence: `${sourceName} could not recover a full description for "${sampleTitle}" after its bounded detail-page wait. The listing was retained with its available list fields.`,
    suggestion: `Retry ${sourceName} later or open the listing directly; the board may have delayed or restricted the detail page.`,
    affectedCount: 1,
    affectedTitles: [sampleTitle],
  };
}

// The two sides of a detail-selection check are produced by different DOM
// mechanisms, and that asymmetry is what makes decoding here mandatory rather
// than cosmetic. Entity decoding is a property of HTML *parsing*, not of the
// textContent/innerText read APIs:
//   - the expected title is read off a server-rendered list card, so the
//     browser's parser already turned `&#8211;` in the markup into `–`;
//   - the observed title is read off a detail panel Google populates
//     programmatically from a JSON blob. Assigning a text node never runs an
//     entity decode, so a title double-escaped upstream stays the literal
//     characters `&#8211;`.
// Comparing the parsed `–` against the literal `&#8211;` declared a mismatch
// between a job and ITSELF, which threw away a correctly-read description
// panel as "another job's text" and left the row unresolvable — no number of
// retries can fix a check that rejects the right answer.
//
// Decoding repeats (bounded) because decodeHtmlEntities makes a single
// `String.replace` pass and does not re-scan its own output: one pass turns
// `&amp;#8211;` into `&#8211;`, which still is not the character the expected
// side carries. Mojibake is repaired alongside it so a source that serves
// UTF-8-as-Latin-1 compares equal to its repaired counterpart. This
// normalization is comparison-only — no stored field is rewritten by it.
export const DETAIL_TITLE_DECODE_PASSES = 3;

export function normalizedDetailTitle(title) {
  let text = String(title || '');
  for (let pass = 0; pass < DETAIL_TITLE_DECODE_PASSES; pass++) {
    const decoded = decodeHtmlEntities(repairMojibake(text));
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

// Page-owned JSON-LD/Next data and programmatically-written headings are
// untrusted scraped text. Keep their interpretation out of the page: the pure
// normalizers below never create DOM nodes or treat that text as executable
// markup. This also keeps the title comparison identical for every source.
export function inertDescriptionText(value) {
  return stripHtmlToText(String(value || '')).trim();
}

export function matchingDetailTitle(expectedTitle, candidates) {
  const expected = normalizedDetailTitle(expectedTitle);
  if (!expected || !Array.isArray(candidates)) return '';
  return candidates.find((candidate) => {
    const normalized = normalizedDetailTitle(candidate);
    return normalized && (normalized === expected || normalized.includes(expected) || expected.includes(normalized));
  }) || '';
}

/**
 * A missing detail heading is ordinary Google markup variation and must not
 * turn a good panel read into a false miss. When both titles are present,
 * however, a non-equivalent heading is positive evidence that the click
 * selected a different job and its description must not be attached.
 */
export function assessDetailSelection(expectedTitle, selectedTitle) {
  const expected = normalizedDetailTitle(expectedTitle);
  const selected = normalizedDetailTitle(selectedTitle);
  if (!expected || !selected) {
    return { selectedTitle: String(selectedTitle || '').trim(), selectionVerified: false, selectionMismatch: false };
  }
  const equivalent = expected === selected || expected.includes(selected) || selected.includes(expected);
  return {
    selectedTitle: String(selectedTitle || '').trim(),
    selectionVerified: equivalent,
    selectionMismatch: !equivalent,
  };
}

/**
 * Decide whether a list-panel read belongs to the card that was just clicked.
 *
 * Most boards replace the description text on every card transition. Glassdoor
 * can legitimately serve the exact same employer-authored description for two
 * separate listings (for example the same role in different cities). Text-only
 * change detection would call the second one a timeout even after its right
 * panel loaded. We accept an unchanged Glassdoor body only when the active
 * detail heading independently confirms the requested title; an unverified
 * unchanged body remains a miss so stale content is never copied forward.
 */
export function assessDescriptionPanelUpdate({
  sourceId = '',
  previousText = '',
  currentText = '',
  expectedTitle = '',
  selectedTitle = '',
} = {}) {
  const previous = String(previousText || '').trim();
  const current = String(currentText || '').trim();
  if (!current) return { accepted: false, reason: 'empty-panel' };
  if (current !== previous) return { accepted: true, reason: 'text-changed' };
  if (sourceId !== 'glassdoor') return { accepted: false, reason: 'text-unchanged' };
  const selection = assessDetailSelection(expectedTitle, selectedTitle);
  return selection.selectionVerified
    ? { accepted: true, reason: 'text-unchanged-title-verified', selection }
    : { accepted: false, reason: 'text-unchanged-unverified', selection };
}

/**
 * A panel fetch is a first-party Glassdoor SPA request, not a DOM-selector
 * failure. Keep this predicate pure so the response listener and fixture tests
 * share the exact boundary: we only stop for the job-details endpoint's 429,
 * never for a third-party image or an unrelated Glassdoor API response.
 */
export function glassdoorPanelResponseIdentity({ sourceId = '', status = null, url = '' } = {}) {
  if (sourceId !== 'glassdoor' || !Number.isFinite(Number(status))) return null;
  try {
    const parsed = new URL(String(url || ''));
    if (!GLASSDOOR_FIRST_PARTY_HOST.test(parsed.hostname)
      || !/^\/job-listing\/api\/job-details\/?$/i.test(parsed.pathname)) return null;
    const key = String(parsed.searchParams.get('jobListingId') || '').trim();
    return key ? { key, status: Number(status), url: parsed.toString() } : null;
  } catch {
    return null;
  }
}

export function isGlassdoorPanelRateLimitResponse(input = {}) {
  return glassdoorPanelResponseIdentity(input)?.status === 429;
}

/**
 * Google Jobs loads selected cards through an async callback. Google redirects
 * an exhausted session to /sorry/ with HTTP 429; that is a source throttle,
 * not evidence that the result-card selector became stale.
 */
export function isGoogleDescriptionPanelRateLimitResponse({ sourceId = '', status = null, url = '' } = {}) {
  if (sourceId !== 'google' || Number(status) !== 429) return false;
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'google.com' && !host.endsWith('.google.com')) return false;
    return /^\/async\/callback\/?$/i.test(parsed.pathname) || /^\/sorry\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Turn ATS application-mode links into read-only detail pages for enrichment,
 * without changing the user-facing job URL. Trakstar's `?apply=true` mode hides
 * its `.jobdesciption` body behind the application form, and some Trakstar
 * tenants also emit invalid JSON-LD (literal newlines inside `description`), so
 * leaving the query intact can make a fully populated posting look empty.
 *
 * Keep this host-specific: other boards may require an apply query to resolve
 * the posting at all.
 */
export function normalizeDetailNavigationUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return input;
  try {
    const parsed = new URL(input);
    if (parsed.hostname.toLowerCase().endsWith('.hire.trakstar.com')
      && /^\/jobs\/[^/]+\/?$/i.test(parsed.pathname)
      && parsed.searchParams.get('apply')?.toLowerCase() === 'true') {
      parsed.searchParams.delete('apply');
      return parsed.toString();
    }
  } catch {
    // Preserve malformed/source-relative links for the caller's normal error path.
  }
  return input;
}

export { GLASSDOOR_FIRST_PARTY_HOST };

/**
 * Keep a Glassdoor detail request on the exact first-party host whose list page
 * loaded successfully. Cloudflare clearance and behavioural state are host-bound:
 * a working www.glassdoor.ca search is not evidence that www.glassdoor.com will
 * accept a burst of detail navigations from the same controlled session.
 *
 * Only sibling Glassdoor hosts are rewritten. An employer/ATS URL, malformed URL,
 * non-HTTP scheme, or non-Glassdoor list page is returned unchanged.
 */
export function pinGlassdoorDetailUrlToListHost(rawDetailUrl, rawListUrl) {
  const input = String(rawDetailUrl || '').trim();
  if (!input) return input;
  try {
    const detail = new URL(input);
    const list = new URL(String(rawListUrl || '').trim());
    if (!['http:', 'https:'].includes(detail.protocol)
      || !['http:', 'https:'].includes(list.protocol)
      || !GLASSDOOR_FIRST_PARTY_HOST.test(detail.hostname)
      || !GLASSDOOR_FIRST_PARTY_HOST.test(list.hostname)) {
      return input;
    }
    detail.hostname = list.hostname;
    return detail.toString();
  } catch {
    return input;
  }
}

/** A detached Puppeteer main frame cannot recover by navigating the next row. */
export function isDetachedDetailFrameError(error) {
  return /detached\s+frame|frame\s+was\s+detached|navigating\s+frame\s+was\s+detached/i
    .test(String(error?.message || error || ''));
}

/**
 * ZipRecruiter's ItemList occasionally supplies an employer's outbound
 * application endpoint (for example a Workday `/apply` URL) instead of its
 * own read-only detail page. We make a shallow, read-only visit to both its
 * current `/jobs/...`, legacy `/c/<company>/Job/...`, and employer-provided
 * external URLs: one navigation, text extraction, then immediately on to the
 * next listing. The scraper never clicks Apply, fills fields, logs in, or
 * submits anything on an external page.
 */
export function shouldNavigateForDescription(sourceId, rawUrl, context = {}) {
  return descriptionNavigationDecision(sourceId, rawUrl, context).allowed;
}

/**
 * ZipRecruiter redirects a closed posting to its authenticated jobseeker home
 * page instead of returning a 404. Keep this URL-only so the live page probe
 * and deterministic regression tests share the same narrow classification.
 */
export function isZipRecruiterClosedDetailRedirect(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    const closed = String(parsed.searchParams.get('closed_job_redirect') || '').trim().toLowerCase();
    return (host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com'))
      && parsed.pathname.replace(/\/+$/, '') === '/jobseeker/home'
      && ['1', 'true', 'yes'].includes(closed);
  } catch {
    return false;
  }
}

/**
 * Decide whether a detail page is conclusively unavailable rather than merely
 * slow or selector-incompatible. Workday returns HTTP 200 for a closed posting
 * and exposes that state in its bootstrap object, so status alone is not enough.
 */
export function isUnavailableDetailPage({
  httpStatus = null,
  workdayPostingAvailable,
  zipRecruiterClosedJobRedirect = false,
} = {}) {
  return [404, 410].includes(Number(httpStatus)) || workdayPostingAvailable === false || zipRecruiterClosedJobRedirect;
}

/**
 * What an unavailable detail page means for its row. Only an aggregator board's
 * own "gone" page is a board verdict (the employer may still be hiring), and only
 * for the two generic not-found reasons: the row is kept with a boardClosed marker
 * for the official-posting resolver. Workday's availability flag, and any
 * not-found page on an employer or ATS host, ARE the official source saying
 * closed, so those keep the original drop (row: null).
 */
export function unavailableDetailDisposition({ pageInfo = {}, job = null, sourceId = '', expectedUrl = '', finalUrl = '', now = new Date() } = {}) {
  const reason = pageInfo.zipRecruiterClosedJobRedirect
    ? 'ziprecruiter-closed-job-redirect'
    : pageInfo.workdayPostingAvailable === false
      ? 'workday-posting-unavailable'
      : 'http-not-found';
  const finalHostClass = finalizeListingEvidence({}, { requestedUrl: expectedUrl, finalUrl }).finalHostClass;
  const flagged = job && finalHostClass === 'aggregator' && reason !== 'workday-posting-unavailable'
    ? withListingClosed(job, { board: sourceId, reason, basis: 'structural', now })
    : null;
  return { reason, row: flagged && flagged !== job ? flagged : null };
}

export async function captureZipRecruiterListingLiveness(page, row, {
  requestedUrl, httpStatus, descriptionText = '', descriptionCapture = '', workdayPostingAvailable = null, wall = null,
} = {}) {
  const rules = getCurrentIpcRequestContext()?.livenessRules?.rulesFor?.('ziprecruiter') || LISTING_LIVENESS_RULES.ziprecruiter;
  const probed = await page.evaluate(listingLivenessPageProbe, {
    rules, expectedTitle: row.title, descriptionCapture, descriptionText,
  }).catch(() => null);
  if (!probed) return row;
  const evidence = finalizeListingEvidence(probed, {
    board: row.source || 'ziprecruiter', ruleKey: 'ziprecruiter', requestedUrl, finalUrl: page.url(), httpStatus,
    expectedTitle: row.title, expectedCompany: row.company, expectedLocation: row.location,
    workdayPostingAvailable, wall,
  });
  const result = classifyListingLiveness(evidence, rules);
  recordListingEvidence(row, evidence);
  if (result.verdict === 'unknown') return row;
  if (result.verdict === 'closed') {
    // A tracker or employer URL returning 404 does not establish the listing's
    // status. ATS structural closure is final; aggregator closure waits for the
    // official-posting search.
    if (evidence.finalHostClass === 'other' && [404, 410].includes(Number(httpStatus))) return row;
    if (evidence.finalHostClass === 'ats') return null;
    return withListingClosed(row, { board: row.source || 'ziprecruiter',
      reason: [404, 410].includes(Number(httpStatus)) ? 'http-not-found' : 'ziprecruiter-closed-job-redirect',
      basis: 'structural' });
  }
  return withListingLiveness(row, { verdict: result.verdict === 'needs-ai' ? 'pending' : result.verdict,
    basis: result.basis, board: row.source || 'ziprecruiter' });
}

/** Convert a Retry-After header to a safe, bounded wait for a single retry. */
export function zipRecruiterRetryAfterMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  let delay = raw ? Number(raw) * 1000 : NaN;
  if (!Number.isFinite(delay) || delay < 0) {
    const at = Date.parse(raw);
    delay = Number.isFinite(at) ? at - now : ZIPRECRUITER_429_FALLBACK_WAIT_MS;
  }
  return Math.max(1000, Math.min(ZIPRECRUITER_429_MAX_WAIT_MS, Math.round(delay)));
}

/**
 * Appcast's terminal page is distinct from a generic job-board hard block: it
 * is an outbound click.appcast.io redirect reached from a still-working
 * ZipRecruiter results page. Require both the host and its visible copy so an
 * ordinary Appcast job page or another site's generic wording cannot trigger
 * the recovery. Appcast also serves the same restriction through DataDome's
 * block frame, whose copy sits in another origin and never reaches
 * `visibleText`; there the host plus that frame is the proof.
 */
export function isAppcastTemporaryRestriction({ url = '', visibleText = '', dataDomeBlocked = false } = {}) {
  let isAppcastClick = false;
  try {
    const parsed = new URL(String(url || '').trim());
    isAppcastClick = parsed.hostname.toLowerCase() === 'click.appcast.io';
  } catch {
    return false;
  }
  if (!isAppcastClick) return false;
  if (dataDomeBlocked) return true;
  const text = String(visibleText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text.includes('access is temporarily restricted')
    && text.includes('unusual activity from your device or network');
}

export function zipRecruiterAppcastRestrictionBackoffMs(attempt) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(
    ZIPRECRUITER_APPCAST_RESTRICTED_MAX_BACKOFF_MS,
    ZIPRECRUITER_APPCAST_RESTRICTED_BACKOFF_MS * (2 ** (safeAttempt - 1)),
  );
}

/**
 * ZipRecruiter's own detail-page error shell. Require BOTH the host and its
 * exact visible copy, the same false-positive-proof shape as
 * isAppcastTemporaryRestriction: an ordinary posting that happens to discuss
 * errors cannot trigger a re-navigation. Text + URL only so the live page probe
 * and deterministic regression tests share one classification. `status` is
 * carried for telemetry but deliberately NOT gated on — the shell is served
 * with HTTP 200.
 */
export function isZipRecruiterDetailErrorShell({ url = '', visibleText = '' } = {}) {
  let isZipRecruiterHost = false;
  try {
    const parsed = new URL(String(url || '').trim());
    const host = parsed.hostname.toLowerCase();
    isZipRecruiterHost = host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com');
  } catch {
    return false;
  }
  if (!isZipRecruiterHost) return false;
  const text = String(visibleText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text.includes('we encountered an error while loading this job');
}

export function zipRecruiterDetailErrorShellBackoffMs(attempt) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(
    ZIPRECRUITER_DETAIL_ERROR_SHELL_MAX_BACKOFF_MS,
    ZIPRECRUITER_DETAIL_ERROR_SHELL_BACKOFF_MS * (2 ** (safeAttempt - 1)),
  );
}

// Format a schema.org JobPosting.baseSalary object into a compact display string
// ("$80,000 - $120,000/yr", "$55/hr"). Returns '' for anything unrecognizable so a
// malformed block never poisons the salary field. Shared by the enrichment path
// (ZipRecruiter/Glassdoor) — backfills salary the list extractor couldn't get.
export function formatJsonLdSalary(bs) {
  if (!bs || typeof bs !== 'object') return '';
  const cur = String(bs.currency || bs.salaryCurrency || '').toUpperCase();
  const sym = (cur === 'USD' || cur === 'CAD' || cur === 'AUD' || cur === '') ? '$' : `${cur} `;
  const v = bs.value && typeof bs.value === 'object' ? bs.value : bs;
  const unitMap = { YEAR: '/yr', HOUR: '/hr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' };
  const unit = unitMap[String(v.unitText || '').toUpperCase()] || '';
  const num = (x) => (x == null || isNaN(Number(x))) ? null : Number(x).toLocaleString('en-US');
  const min = num(v.minValue), max = num(v.maxValue), val = num(v.value);
  // With no recognized unitText we cannot tell an hourly rate from an annual
  // salary, and emitting the bare number anyway is worse than emitting nothing:
  // it is truthy, so the caller's DOM-chip fallback (which DOES carry a visible
  // cadence) never runs, and the wrong figure gets locked in. Keep the value only
  // when its magnitude can't be anything but annual.
  const annualOnly = (x) => Number(x) >= 10000;
  if (!unit) {
    if (v.minValue != null && v.maxValue != null && annualOnly(v.minValue)) return `${sym}${min} - ${sym}${max}`;
    if (v.value != null && annualOnly(v.value)) return `${sym}${val}`;
    return '';
  }
  if (min != null && max != null) return `${sym}${min} - ${sym}${max}${unit}`;
  if (val != null) return `${sym}${val}${unit}`;
  return '';
}

export const GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS = 400;

export function compactGlassdoorResponseText(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  return stripHtmlToText(raw).replace(/\s+/g, ' ').trim();
}

export function glassdoorResponsePathToken(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function glassdoorStructuredSalary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const firstFrom = (source, ...keys) => keys.map(key => source?.[key]).find(item => item != null && item !== '');
  const nested = firstFrom(value, 'salaryRange', 'range', 'baseSalary', 'value');
  const amountSource = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : value;
  const first = (...keys) => firstFrom(amountSource, ...keys) ?? firstFrom(value, ...keys);
  const rawUnit = String(firstFrom(value, 'unitText', 'payPeriod', 'salaryType', 'period', 'cadence')
    ?? firstFrom(amountSource, 'unitText', 'payPeriod', 'salaryType', 'period', 'cadence')
    ?? '').toUpperCase();
  const unitAliases = {
    ANNUAL: 'YEAR', ANNUALLY: 'YEAR', YEARLY: 'YEAR', HOURLY: 'HOUR',
    MONTHLY: 'MONTH', WEEKLY: 'WEEK', DAILY: 'DAY',
  };
  const unitText = unitAliases[rawUnit] || rawUnit;
  return formatJsonLdSalary({
    currency: firstFrom(value, 'currency', 'currencyCode', 'salaryCurrency')
      ?? firstFrom(amountSource, 'currency', 'currencyCode', 'salaryCurrency'),
    value: {
      minValue: first('minValue', 'min', 'minimum', 'lowerBound'),
      maxValue: first('maxValue', 'max', 'maximum', 'upperBound'),
      value: first('value', 'amount'),
      unitText,
    },
  });
}

/**
 * Extract conservative enrichment fields from the JSON body already returned
 * by Glassdoor's card-panel request. This function never performs I/O. The
 * caller separately binds the response URL's jobListingId to the clicked card,
 * while this bounded walk tolerates minor response-schema changes.
 */
export function extractGlassdoorPanelResponseDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const descriptionCandidates = [];
  const salaryCandidates = [];
  const postedCandidates = [];
  const companyCandidates = [];
  const queue = [{ value: payload, path: [] }];
  const seen = new Set();
  let visited = 0;

  while (queue.length && visited < 800) {
    const current = queue.shift();
    const node = current?.value;
    if (!node || typeof node !== 'object' || seen.has(node) || current.path.length > 10) continue;
    seen.add(node);
    visited++;
    const entries = Array.isArray(node) ? node.entries() : Object.entries(node);
    for (const [rawKey, value] of entries) {
      const key = glassdoorResponsePathToken(rawKey);
      const path = [...current.path, key];
      const pathText = path.join('.');
      const jobScoped = /job|listing|posting|position|detail/.test(pathText);
      const employerScoped = /employer|company|organization/.test(pathText);

      if (typeof value === 'string') {
        const text = compactGlassdoorResponseText(value);
        const strongDescription = /^(?:job)?description(?:text|html)?$/.test(key) && key !== 'description';
        const genericJobDescription = key === 'description' && jobScoped && !employerScoped;
        if (((strongDescription && !employerScoped) || genericJobDescription)
          && text.length >= GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS) {
          descriptionCandidates.push({
            value: text,
            score: (strongDescription ? 120 : 80) + Math.min(20, Math.floor(text.length / 1000)),
          });
        }

        if (/salary|pay|compensation/.test(key) && text.length <= 160 && parseSalaryToNumeric(text) > 0) {
          salaryCandidates.push({ value: text, score: /display|text|range/.test(key) ? 100 : 80,
            provenance: /estimate/iu.test(pathText) ? 'estimated' : 'unknown' });
        }
        if (/^(?:dateposted|posteddate|postingdate|listingage|age)$/.test(key) && text.length <= 120) {
          postedCandidates.push({ value: text, score: /dateposted|posteddate/.test(key) ? 100 : 70 });
        }
        if (/^(?:employername|companyname|hiringorganizationname)$/.test(key) && text.length <= 240) {
          companyCandidates.push({ value: text, score: 100 });
        } else if (key === 'name' && employerScoped && text.length <= 240) {
          companyCandidates.push({ value: text, score: 80 });
        }
      } else if (typeof value === 'number' && /^(?:ageindays|listingageindays|daysago)$/.test(key)
        && value >= 0 && value <= 3650) {
        postedCandidates.push({ value: `${value}d`, score: 70 });
      }

      if (value && typeof value === 'object') {
        if (/salary|pay|compensation/.test(key)) {
          const salary = glassdoorStructuredSalary(value);
          if (salary && parseSalaryToNumeric(salary) > 0) salaryCandidates.push({ value: salary, score: 110,
            provenance: /estimate/iu.test(pathText) ? 'estimated' : key === 'basesalary' ? 'posted' : 'unknown' });
        }
        queue.push({ value, path });
      }
    }
  }

  const bestCandidate = candidates => candidates.sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0];
  const best = candidates => bestCandidate(candidates)?.value || '';
  const salary = bestCandidate(salaryCandidates);
  const detail = {
    description: best(descriptionCandidates),
    salary: salary?.value || '',
    salaryProvenance: salary?.provenance || 'unknown',
    posted: best(postedCandidates),
    company: best(companyCandidates),
  };
  return [detail.description, detail.salary, detail.posted, detail.company].some(Boolean) ? detail : null;
}

/** Merge one exact card response with its visible panel read, without clobbering list fields. */
export function mergeGlassdoorPanelDetail(job, { domText = '', responseDetail = null } = {}) {
  const panelText = String(domText || '').trim();
  const responseText = String(responseDetail?.description || '').trim();
  const responseDescriptionUsable = responseText.length >= GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS;
  const description = panelText || (responseDescriptionUsable ? responseText : '');
  const existingSalaryUsable = parseSalaryToNumeric(job?.salary) > 0;
  const responseSalary = String(responseDetail?.salary || '').trim();
  const salaryRecovered = !existingSalaryUsable && parseSalaryToNumeric(responseSalary) > 0;
  const postedRecovered = !String(job?.posted || '').trim() && !!String(responseDetail?.posted || '').trim();
  const companyRecovered = !String(job?.company || '').trim() && !!String(responseDetail?.company || '').trim();
  const recoveredFields = [
    salaryRecovered ? 'salary' : '',
    postedRecovered ? 'posted' : '',
    companyRecovered ? 'company' : '',
  ].filter(Boolean);
  const mergedJob = {
    ...job,
    ...(description ? { snippet: description, descriptionCapture: panelText ? 'glassdoor-panel-dom' : 'glassdoor-panel-response-json' } : {}),
    ...(salaryRecovered ? { salary: responseSalary, salaryProvenance: ['posted', 'estimated'].includes(responseDetail?.salaryProvenance) ? responseDetail.salaryProvenance : 'unknown' } : {}),
    ...(postedRecovered ? { posted: String(responseDetail.posted).trim() } : {}),
    ...(companyRecovered ? { company: String(responseDetail.company).trim() } : {}),
  };
  // Recovery may receive a row staged after an earlier 429. A verified panel or
  // exact response description makes it score-safe again; remove the explicit
  // deferral marker from the copied object without mutating recovery storage.
  if (description) delete mergedJob.descriptionDeferredReason;
  return {
    job: mergedJob,
    descriptionSource: panelText ? 'dom' : responseDescriptionUsable ? 'json' : '',
    recoveredFields,
  };
}

// A ZipRecruiter pay chip may prefix either endpoint with a compact currency
// marker ("CA$40 - CA$85/hr", "US$17.60 - US$22.00 Per hour"). Keep the
// prefix inside the match: starting at the first bare `$` used to stop at
// "$40" when the second endpoint began with `CA$`, losing both the range and
// its cadence. The prefix is tied to a currency symbol so prose immediately
// before an ordinary dollar amount cannot be swallowed.
export const ZIPRECRUITER_MONEY_SRC = String.raw`(?:[A-Za-z]{1,3}(?=\$))?\$\s?\d[\d.,]*\s?(?:[KkMm](?![A-Za-z]))?(?:\s?(?:[-–—]|to)\s?(?:(?:[A-Za-z]{1,3}(?=\$))?\$)?\s?\d[\d.,]*\s?(?:[KkMm](?![A-Za-z]))?)?(?:\s?(?:\/\s?(?:yr|year|hr|hour|mo|month|wk|week)|(?:hour|year|month|week|annual|bi[-\s]?week)ly|an hour|a year|a month|a week|per (?:hour|year|month|week)))?`;

/** Extract one bounded ZipRecruiter pay-chip value from visible text. */
export function extractZipRecruiterDomSalaryText(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 60) return '';
  const match = value.match(new RegExp(ZIPRECRUITER_MONEY_SRC, 'i'));
  return match?.[0]?.trim() || '';
}

/**
 * ZipRecruiter's client-rendered estimate occasionally combines an annual K
 * amount with an hourly cadence (for example "$65K/hr"). Prefer an explicit,
 * pay-anchored annual amount from that listing's own description; if there is
 * no such correction, omit the corrupt chip rather than presenting false pay.
 * This deliberately has no dependency on renderer taxonomy helpers.
 */
export function reconcileZipRecruiterDomSalary(rawSalary, description) {
  const raw = String(rawSalary || '').trim();
  const body = String(description || '').replace(/\s+/g, ' ');

  // ZipRecruiter sometimes exposes a broken list/detail chip while the JD still
  // contains the authoritative pay block. Canadian postings in particular can
  // use a decimal comma without thousands separators ("$111308,33"), which the
  // generic money regex correctly refuses to guess at. Recover only from an
  // explicitly pay-labelled block and normalize it to the shared annualizer's
  // unambiguous display format.
  const localizedAmount = String.raw`(?:[A-Za-z]{1,3}(?=[$€£]))?[$€£]?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d{4,}(?:[.,]\d{2})?|\d+(?:[.]\d{1,2})?)`;
  const labelledRange = new RegExp(
    String.raw`\b(annual\s+base\s+salary\s+range(?:\s+or\s+hourly\s+base\s+pay\s+range)?|base\s+salary(?:\s+range)?|salary\s+range|compensation(?:\s+range)?)\b[^$€£]{0,60}${localizedAmount}\s*(?:[-–—]|to)\s*${localizedAmount}`,
    'i',
  ).exec(body);
  const parseLocalized = (value) => {
    let s = String(value || '').replace(/\s+/g, '');
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      // The right-most separator is decimal; the other is grouping.
      s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (comma >= 0) {
      // A final two-digit comma after at least four integer digits is a locale
      // decimal separator. Otherwise commas are ordinary thousands grouping.
      s = /^\d{4,},\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  let descriptionSalary = '';
  if (labelledRange) {
    const min = parseLocalized(labelledRange[2]);
    const max = parseLocalized(labelledRange[3]);
    const nearby = body.slice(labelledRange.index, labelledRange.index + labelledRange[0].length + 220);
    const explicitHourly = /compensation\s+type\s*:\s*hourly\b/i.test(nearby);
    const explicitSalary = /compensation\s+type\s*:\s*salary\b/i.test(nearby);
    const annualScale = min >= 10_000 && max >= 10_000;
    const hourlyScale = min > 0 && max > 0 && min < 1_000 && max < 1_000;
    const cadence = explicitHourly && hourlyScale ? 'hr'
      : (explicitSalary || annualScale || /^annual\b/i.test(labelledRange[1])) ? 'yr'
        : '';
    if (cadence && min > 0 && max >= min && max <= 10_000_000) {
      const format = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      descriptionSalary = `${format(min)} - ${format(max)}/${cadence}`;
    }
  }

  if (!raw) return descriptionSalary;
  if (parseSalaryToNumeric(raw) === 0 && descriptionSalary) return descriptionSalary;
  const amount = raw.match(/\$\s?(\d+(?:\.\d+)?)\s*([km])\b/i);
  const cadence = raw.match(/\b(?:bi[-\s]?weekly|week(?:ly)?|wk|month(?:ly)?|mo|day|daily|hour(?:ly)?|hr)\b|\/\s*(?:bi[-\s]?wk|wk|mo|day|hr)\b/i);
  if (!amount || !cadence) return raw;

  const base = Number(amount[1]) * (amount[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
  const token = cadence[0].toLowerCase();
  const multiplier = /bi[-\s]?(?:weekly|wk)/.test(token) ? 26
    : /week|wk/.test(token) ? 52
      : /month|mo/.test(token) ? 12
        : /day/.test(token) ? 260
          : 2080;
  if (!Number.isFinite(base) || base * multiplier <= 10_000_000) return raw;

  const money = String.raw`(?:[A-Za-z]{1,3}(?=\$))?\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?(?:[-–—]|to)\s?(?:(?:[A-Za-z]{1,3}(?=\$))?\$)?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?)?`;
  const annual = String.raw`(?:\s*(?:USD|CAD|AUD|EUR|GBP)\b)?\s*(?:(?:per|a)\s+(?:year|annum)|\/\s*(?:yr|year)|annually|annual|yearly)`;
  const explicitPay = new RegExp(
    String.raw`\b(?:base\s+)?(?:salary|compensation|pay)\b[^$]{0,80}(${money}${annual})`,
    'i',
  ).exec(body);
  return descriptionSalary || explicitPay?.[1]?.trim() || '';
}

// Keep every list-card field when detail enrichment is partial. In particular,
// a description miss must not discard a date recovered from the same detail
// page: ZipRecruiter can expose datePosted even when its description is absent.
// This is deliberately field-by-field so existing list data remains authoritative.
export function mergeExpandedJobDetail(job, {
  text = '',
  descriptionCapture = '',
  jsonLdDate = '',
  jsonLdSalary = '',
  jsonLdSalaryProvenance = 'unknown',
  salaryChanged = false,
  reconciledSalary,
  jsonLdCompany = '',
} = {}) {
  const existingSalaryUsable = parseSalaryToNumeric(job?.salary) > 0;
  const existingCompanyUsable = !!String(job?.company || '').trim();
  const usableJsonLdCompany = String(jsonLdCompany || '').trim();
  const hasDescriptionText = !!String(text || '').trim();
  const mergedJob = {
    ...job,
    ...(hasDescriptionText ? { snippet: text } : {}),
    ...(hasDescriptionText && descriptionCapture ? { descriptionCapture } : {}),
    ...(jsonLdDate && !job?.posted ? { posted: jsonLdDate } : {}),
    ...(salaryChanged ? { salary: reconciledSalary, salaryProvenance: 'unknown' } : {}),
    // Structured detail pay includes schema.org unitText. Let it repair a
    // present-but-unusable list chip (e.g. Glassdoor "US$19 - US$20 (Employer
    // provided)"), while leaving every already-parseable list salary untouched.
    ...(jsonLdSalary && !existingSalaryUsable && !salaryChanged ? { salary: jsonLdSalary,
      salaryProvenance: job?.source === 'google' ? 'unknown' : ['posted', 'estimated'].includes(jsonLdSalaryProvenance) ? jsonLdSalaryProvenance : 'unknown' } : {}),
    // ZipRecruiter's ItemList regex derives company from the listing URL
    // (/c/{Company}/Job/), which never matches externally-hosted postings
    // (ziprecruiter.com/job-redirect?match_token=…) — leaving company
    // permanently blank from list extraction alone. Backfill from the detail
    // page's own JobPosting.hiringOrganization, but only when the list
    // extractor found nothing; never clobber a company it already resolved.
    ...(usableJsonLdCompany && !existingCompanyUsable ? { company: usableJsonLdCompany } : {}),
    ...(job?.source === 'google' ? { salaryProvenance: 'unknown' } : {}),
  };
  // A navigation detail page can recover a row that was explicitly deferred by
  // an earlier source-wide block. Keep the marker for a blank detail page, but
  // do not let it make a later verified description permanently ineligible for
  // the shared scoring-evidence gate.
  if (hasDescriptionText) delete mergedJob.descriptionDeferredReason;
  return mergedJob;
}
