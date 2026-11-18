import { launchScrapePlatformBrowser } from './scrapeBrowser.js';
import { getUserDataDir, findChromePath } from '../../stealthBrowser.js';
import { createBackgroundScrapePage } from '../backgroundScrapeBrowser.js';
import { HARD_BLOCK_RETRY_WAIT_MS } from '../../../../src/utils/jobSourceWarningPolicy.js';

function normalizedApplySource(value) {
  return String(value || '')
    .replace(/^apply on\s+/i, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

const isGoogleHost = host => /^(?:[a-z0-9-]+\.)*google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(String(host || '').toLowerCase());

/**
 * Pick the direct posting link from Google's active Jobs detail panel.
 * Google can offer several mirrors; prefer the provider named by the list
 * card's "via …" label, then fall back to the first safe non-Google target.
 */
function googleApplyProviderCandidates(candidates, { httpsOnly = false } = {}) {
  const valid = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const label = String(candidate?.label || '').replace(/\s+/g, ' ').trim();
    if (!/^apply on\b/i.test(label)) continue;
    try {
      const url = new URL(String(candidate?.href || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (httpsOnly && (url.protocol !== 'https:' || url.username || url.password)) continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (isGoogleHost(host)) continue;
      for (const key of ['utm_campaign', 'utm_source', 'utm_medium']) url.searchParams.delete(key);
      valid.push({
        url: url.href,
        label,
        source: normalizedApplySource(label),
      });
    } catch { /* ignore malformed provider hrefs */ }
  }
  return valid;
}

export function selectGoogleApplyUrl(candidates, preferredSource = '') {
  const valid = googleApplyProviderCandidates(candidates);
  if (valid.length === 0) return '';
  const preferred = normalizedApplySource(preferredSource);
  return (preferred && valid.find(item => item.source === preferred)?.url) || valid[0].url;
}

/** Keep every bounded safe Apply-on lead from the same already-read panel. */
export function normalizeGoogleApplyOptions(candidates) {
  const result = []; const seen = new Set();
  for (const candidate of googleApplyProviderCandidates(candidates, { httpsOnly: true })) {
    if (seen.has(candidate.url)) continue;
    // eslint-disable-next-line no-control-regex
    const label = candidate.label.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
    seen.add(candidate.url); result.push({ label, href: candidate.url });
    if (result.length === 8) break;
  }
  return result;
}

/**
 * Read the visible Apply-on anchors from Google's active detail document.
 *
 * Kept as a self-contained exported function so Puppeteer can serialize it
 * into the page and fixture tests can exercise the shipped DOM contract. The
 * accessible name matters: some Google builds put "Apply on …" only in
 * aria-label while leaving both title and visible anchor text empty.
 */
export function extractGoogleApplyCandidatesFromDocument(root = globalThis.document) {
  return Array.from(root?.querySelectorAll?.('a[href]') || [])
    .filter(anchor => !anchor.hidden)
    .filter(anchor => !anchor.closest('[aria-hidden="true"]'))
    .filter(anchor => !anchor.closest('[data-share-url]'))
    .filter(anchor => !!(anchor.offsetWidth || anchor.offsetHeight || anchor.getClientRects().length))
    .map(anchor => ({
      href: anchor.href || '',
      label: (
        anchor.getAttribute('aria-label')
        || anchor.getAttribute('title')
        || anchor.textContent
        || ''
      ).replace(/\s+/g, ' ').trim(),
    }))
    .filter(candidate => /^Apply on\b/i.test(candidate.label));
}

/**
 * Why a detail panel gave no Apply-on link: fixed counts only, never text or addresses.
 * Self-contained so Puppeteer can serialize it into the page, like the extractor above.
 */
export function readGoogleApplyCaptureCounts(root = globalThis.document) {
  const labelOf = element => (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').replace(/\s+/g, ' ').trim();
  const anchors = Array.from(root?.querySelectorAll?.('a[href]') || []).filter(anchor => /^Apply on\b/i.test(labelOf(anchor)));
  return {
    otherControls: Array.from(root?.querySelectorAll?.('a, button, [role="button"], [role="link"]') || []).filter(element => /^Apply\b/i.test(labelOf(element))).length - anchors.length,
    anchors: anchors.length,
    ariaHidden: anchors.filter(anchor => anchor.closest('[aria-hidden="true"]')).length,
    inJobCard: anchors.filter(anchor => anchor.closest('[data-share-url]')).length,
    noLayout: anchors.filter(anchor => !(anchor.offsetWidth || anchor.offsetHeight || anchor.getClientRects().length)).length,
    pageHidden: root?.visibilityState === 'hidden',
  };
}

/** Adds one panel read to a source's running tally; a count field is the number of missed rows where that condition held. */
export function addGoogleApplyCapture(total, { url, candidates, readFailed, counts }) {
  const next = { reads: 0, captured: 0, missed: 0, ...total };
  next.reads += 1;
  if (url) { next.captured += 1; return next; }
  next.missed += 1;
  const count = (key, held) => { if (held) next[key] = (next[key] || 0) + 1; };
  count('readFailed', readFailed);
  count('addressRejected', candidates?.length > 0);
  count('redirectUnresolved', candidates?.some(candidate => isGoogleApplyRedirect(candidate?.href)));
  count('noAnchors', counts && counts.anchors === 0);
  count('otherControls', counts?.otherControls > 0);
  count('ariaHidden', counts?.ariaHidden > 0);
  count('inJobCard', counts?.inJobCard > 0);
  count('noLayout', counts?.noLayout > 0);
  count('pageHidden', counts?.pageHidden === true);
  return next;
}

/**
 * Signed out of Google, Apply-on links point at an opaque www.google.com/goto token, and only Google's redirect
 * says where they go. Anything else on a Google host stays what it was: an internal route, never a destination.
 */
export function isGoogleApplyRedirect(href) {
  try {
    const url = new URL(String(href || ''));
    return url.protocol === 'https:' && url.hostname.startsWith('www.') && isGoogleHost(url.hostname) && url.pathname === '/goto' && !!url.searchParams.get('url');
  } catch { return false; }
}

const GOOGLE_APPLY_REDIRECT_TIMEOUT_MS = 5_000;

const GOOGLE_APPLY_REDIRECT_GAP_MS = 150;

/**
 * Follows a redirect only as far as its first address off Google, in a background tab of the same browser, and never
 * loads that page: reading a link must not visit the job site. Stops for the rest of the run once Google rate-limits,
 * as panels do. `openPage` is the only browser dependency, so the rule is testable.
 */
export function createGoogleApplyRedirectResolver(openPage) {
  let tab = null; let rateLimited = false; let pending = null;
  // When (and how often) Google stopped the reader: a bug report has to show when
  // it started and why the later rows lost their employer link.
  let rateLimitedAt = 0; let followed = 0; let rateLimitedCause = '';
  const markRateLimited = cause => { rateLimited = true; if (!rateLimitedAt) rateLimitedAt = Date.now(); if (!rateLimitedCause) rateLimitedCause = cause; };
  const prepare = async () => {
    if (tab) return tab;
    const page = await openPage();
    // A tab without interception would load the job site, so it is never kept half set up.
    try { await page.setRequestInterception(true); } catch (error) { await page.close().catch(() => {}); throw error; }
    tab = page;
    tab.on('request', request => {
      if (!request.isNavigationRequest() || request.frame() !== tab.mainFrame()) { void request.abort().catch(() => {}); return; }
      let host = ''; let path = '';
      try { ({ hostname: host, pathname: path } = new URL(request.url())); } catch { /* an unreadable hop ends the walk below */ }
      if (path.startsWith('/sorry')) markRateLimited('sorry-hop');
      if (host && !path.startsWith('/sorry') && isGoogleHost(host)) { void request.continue().catch(() => {}); return; }
      if (pending && host && !path.startsWith('/sorry')) pending.destination = request.url();
      void request.abort().catch(() => {});
    });
    tab.on('response', response => { if (response.status() === 429) markRateLimited('http-429'); });
    return tab;
  };
  return {
    get rateLimited() { return rateLimited; },
    get rateLimitedAt() { return rateLimitedAt; },
    /** Why the reader stopped ('sorry-hop' or 'http-429'), for the report trail. */
    get rateLimitedCause() { return rateLimitedCause; },
    /** Redirect navigations attempted so far, the "read" half of the capture tally. */
    get followed() { return followed; },
    /**
     * Same candidates, each redirect replaced by where it goes. One that can't be followed stays as it was, so it is rejected as before.
     * Once `signal` aborts, the remaining candidates come back unchanged and nothing more is followed.
     */
    async resolve(candidates, signal = null) {
      const result = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        if (!isGoogleApplyRedirect(candidate?.href) || rateLimited || signal?.aborted) { result.push(candidate); continue; }
        try {
          const page = await prepare();
          pending = { destination: '' };
          followed += 1;
          await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: GOOGLE_APPLY_REDIRECT_TIMEOUT_MS }).catch(() => {});
          result.push(pending.destination ? { ...candidate, href: pending.destination } : candidate);
        } catch { result.push(candidate); } finally { pending = null; }
        await new Promise(resolve => setTimeout(resolve, GOOGLE_APPLY_REDIRECT_GAP_MS));
      }
      return result;
    },
    async close() { const page = tab; tab = null; await page?.close().catch(() => {}); },
  };
}

export const GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE = 'google-apply-links-rate-limited';

/** At most this many still-unread redirects ride on one row into the checkpoint. */
const GOOGLE_PENDING_APPLY_REDIRECT_LIMIT = 4;

const GOOGLE_PENDING_APPLY_LABEL_MAX = 120;

const googlePendingApplyLabel = value => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, GOOGLE_PENDING_APPLY_LABEL_MAX);

/**
 * The still-unfollowed `/goto` candidates of ONE Google detail panel, kept on the
 * row so Retry can re-read exactly those links instead of re-scraping the source.
 * Only real redirects qualify: a candidate that already resolved is job.url, and
 * any other Google route is an internal address, never a destination.
 */
export function buildPendingGoogleApplyRedirects(candidates) {
  const pending = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const href = String(candidate?.href || '').trim();
    if (!isGoogleApplyRedirect(href)) continue;
    pending.push({ label: googlePendingApplyLabel(candidate?.label), href });
    if (pending.length === GOOGLE_PENDING_APPLY_REDIRECT_LIMIT) break;
  }
  return pending;
}

/**
 * The one source warning a stopped apply-link reader produces. `severity: 'block'`
 * holds scoring exactly like a hard block, and `retryAfterAt` starts the same wait
 * the card counts down before it offers Retry. Pure, so the wording, the counts and
 * the wait are testable without a browser.
 */
export function googleApplyLinksRateLimitedWarning({
  url = '', readLinks = 0, capturedLinks = 0, pendingRows = 0, now = Date.now(),
} = {}) {
  const read = Number.isFinite(readLinks) ? readLinks : 0;
  const captured = Number.isFinite(capturedLinks) ? capturedLinks : 0;
  const rows = Number.isFinite(pendingRows) ? pendingRows : 0;
  return {
    code: GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE,
    severity: 'block',
    retryAfterAt: now + HARD_BLOCK_RETRY_WAIT_MS,
    url: url || null,
    shortLabel: 'Links paused, wait then retry',
    evidence: `Google stopped the apply-link reader after ${read} apply link${read === 1 ? '' : 's'} ${read === 1 ? 'was' : 'were'} read (${captured} employer link${captured === 1 ? '' : 's'} captured); ${rows} listing${rows === 1 ? '' : 's'} ${rows === 1 ? 'has' : 'have'} no employer link yet.`,
    suggestion: 'Retry re-reads only those links after the wait. Skip keeps them with their Google links.',
  };
}

/**
 * Follow the still-unread Google apply redirects parked on already-saved rows,
 * WITHOUT re-scraping any source. Uses the same shared-profile browser setup the
 * scrape pass uses (the caller holds the shared-profile lane), and reports
 * whether Google throttled the reader again so the caller can restart the wait.
 */
export async function followGoogleApplyRedirects(pending, { signal = null } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const entry of Array.isArray(pending) ? pending : []) {
    if (signal?.aborted) break;
    const href = String(entry?.href || '').trim();
    if (!isGoogleApplyRedirect(href) || seen.has(href)) continue;
    seen.add(href);
    candidates.push({ label: String(entry?.label || ''), href });
  }
  const result = { links: [], rateLimited: false, rateLimitedAt: null, read: 0 };
  if (candidates.length === 0) return result;
  const userDataDir = await getUserDataDir();
  const executablePath = process.env.CHROME_PATH || await findChromePath();
  const sandboxArgs = process.platform === 'darwin' ? [] : ['--no-sandbox', '--disable-setuid-sandbox'];
  const platform = await launchScrapePlatformBrowser({ userDataDir, executablePath, sandboxArgs, onCrash: () => {} });
  const resolver = createGoogleApplyRedirectResolver(() => createBackgroundScrapePage(platform.browser));
  try {
    const resolved = await resolver.resolve(candidates, signal);
    // Paired positionally: the resolver answers in the order it was asked, so an
    // unfollowed redirect comes back with its own /goto href and stays unread.
    result.links = resolved.map((link, index) => ({
      from: candidates[index].href,
      to: String(link?.href || candidates[index].href),
      label: String(link?.label || candidates[index].label || ''),
    }));
  } finally {
    result.rateLimited = resolver.rateLimited;
    result.rateLimitedAt = resolver.rateLimitedAt || null;
    result.read = resolver.followed;
    await resolver.close().catch(() => {});
    await platform.teardown().catch(() => {});
  }
  return result;
}

export async function waitForGoogleApplyDestination(page, preferredSource, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let candidates = [];
  let readFailed = false;
  while (true) {
    readFailed = false;
    candidates = await page.evaluate(extractGoogleApplyCandidatesFromDocument).catch(() => { readFailed = true; return []; });
    const url = selectGoogleApplyUrl(candidates, preferredSource);
    // A redirect has a destination too: it just isn't known until it is followed.
    if (url || candidates.some(candidate => isGoogleApplyRedirect(candidate.href)) || Date.now() >= deadline) return { url, candidates, readFailed };
    // The description often paints before the detail panel's outbound controls.
    // Poll only rows that still lack a usable destination, keeping the normal
    // happy path free of any extra delay.
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

