/**
 * Listing status check engine.
 *
 * Structure-agnostic: instead of assuming a URL points at a single listing
 * page, this module classifies "the current state of listing X" by searching
 * any page (listing detail, notification feed, account dashboard, seller
 * summary) for evidence of that specific listing's status. Driven by:
 *
 *   1. A listing identifier extracted from the URL or product title — the
 *      needle the model uses to find the right row/banner/notification.
 *   2. An HTML strip that removes nav/script/style chrome so the surviving
 *      content is dominated by signal, not framing.
 *   3. A literal indexOf pre-pass that windows ±2k chars around the first
 *      identifier match — for big dashboard pages this drops token cost ~10x
 *      and stops the model from being distracted by sibling listings.
 *   4. A signal-shaped prompt that explicitly says "the page may be any of
 *      these formats; find the most specific evidence about THIS listing."
 *
 * Single-URL classification → status enum + short evidence sentence.
 * Multi-URL aggregation → strongest signal wins.
 */
import { callLLMText } from './llm.js';
import { getSoftLoginWallMatch, verifySellMonitorLogin, writeStatusCache } from './accounts.js';
import { getSellMonitorConfig } from './stealthBrowser.js';
import { isLoginUrlPath } from './browser/authWindows.js';
import { logger } from '../logger.js';
import { PAGE_STATUS_SINGLE_SCHEMA, PAGE_STATUS_MULTI_SCHEMA, MARKETPLACE_HUB_SCAN_SCHEMA } from './aiSchemas.js';
import { isFacebookShareUrl } from '../../src/utils/platformUrlMatch.js';
import { detectAntiBotSignal } from './antiBotDetector.js';

// Structural thresholds (absolute by design — not page-baseline candidates):
//   - MIN_CONTENT_CHARS: below this, a fetched page is treated as empty/blocked
//     and we skip the LLM call (a real status page is always far larger).
//   - IDENTIFIER_MAX_CHARS: cap on the URL-slug/title used as the search needle.
const MIN_CONTENT_CHARS    = 200;
const IDENTIFIER_MAX_CHARS = 80;

// Dedup concurrent verifier calls per platform. If a multi-URL check has
// four sources that all 403 simultaneously, we only run the verifier once
// and share its verdict — otherwise we'd race four `fetchHtmlClean` calls
// against each other and against any in-flight Settings re-verify.
const _inFlightVerifies = new Map(); // platformId → Promise<verdict>
function verifyPlatformOnce(platformId) {
  if (_inFlightVerifies.has(platformId)) return _inFlightVerifies.get(platformId);
  const p = verifySellMonitorLogin(platformId).finally(() => {
    _inFlightVerifies.delete(platformId);
  });
  _inFlightVerifies.set(platformId, p);
  return p;
}

/**
 * Disambiguate a 401/403 (or login-URL redirect) into either a real auth
 * failure or an anti-bot challenge. eBay listing pages (`/itm/...`) are
 * publicly viewable — a 403 on them while the universal verify URL still
 * returns 200 is anti-bot rate-limiting, not session expiry. Conflating the
 * two surfaces a misleading "Log in via Settings" prompt when the user IS
 * logged in.
 *
 * Strategy:
 *  - If finalUrl matches /login|/signin etc → unambiguous auth wall, keep
 *    needs-login behavior.
 *  - Otherwise run the platform verifier:
 *      → verifier passes  → anti-bot, return 'unknown' with explanatory
 *        message + warning so the result row shows what really happened.
 *      → verifier fails   → genuine logout, return 'needs-login' and update
 *        the cache so Settings flips the pill to "Log in".
 *
 * Returns `{ status, message, warning? }` matching the existing result shape.
 */
async function disambiguateAuthFailure({ platformId, status, finalUrl, url, urlLabel }) {
  const finalLower = String(finalUrl || url).toLowerCase();
  const onLoginUrl = isLoginUrlPath(finalLower);

  const needsLogin = () => ({
    status: 'needs-login',
    message: `Auth wall (HTTP ${status} → ${finalUrl || url}). Log in via Settings → Marketplace Login.`,
  });

  // No platform context → can't verify, keep legacy behavior.
  if (!platformId) return needsLogin();

  // A redirect straight to /login is NOT proof of logout. The canonical listing
  // URL is fetched UNAUTHENTICATED (plainFetcher, for speed), so a login-gated
  // page — e.g. a Facebook Marketplace item — redirects to /login whether or
  // not the user's saved session is alive. The verifier hits the platform's
  // universal logged-in URL with the persistent cookies and is the source of
  // truth, so consult it even on a login redirect; otherwise we tell a
  // logged-in user to "log in via Settings" (the exact contradiction reported).
  let verdict;
  try {
    verdict = await verifyPlatformOnce(platformId);
  } catch (e) {
    logger.warn(`[ListingStatusCheck] verifier threw for ${platformId} (assuming auth wall):`, e?.message || String(e));
    return needsLogin();
  }

  // The verifier itself couldn't read its page (fetch timed out / errored — e.g.
  // an anti-bot reload loop). That is not evidence of logout, so we must NOT flip
  // to needs-login or poison the session cache. Return 'unknown' (ranks below a
  // real signal, so an authenticated watch URL still wins the aggregate) and say
  // it was a transient verify failure, not a logout.
  if (verdict?.inconclusive) {
    return {
      status: 'unknown',
      message: `Listing page returned HTTP ${status}, and the ${platformId} session check was inconclusive (${verdict.reason || 'verify fetch failed'}) — a transient anti-bot/network error, not a confirmed logout. Retry; an authenticated watch URL's status (if configured) is used instead.`,
      warning: `[${urlLabel || hostOf(url)}] session verify inconclusive (transient) — treating as unknown, not a logout.`,
    };
  }

  if (verdict?.connected) {
    // Session is alive, so this is NOT a logout. Return 'unknown' (which ranks
    // below a real signal, so an authenticated watch URL's verdict wins the
    // aggregate) with a message that distinguishes the two causes:
    //   - login redirect → a login-gated page the unauthenticated check can't read
    //   - other 4xx      → anti-bot rate-limiting
    return onLoginUrl
      ? {
          status: 'unknown',
          message: `Listing page is login-gated (HTTP ${status} → ${finalUrl || url}), but your ${platformId} session is still active — the unauthenticated status check can't read it. Not a logout; an authenticated watch URL's status (if configured) is used instead.`,
          warning: `[${urlLabel || hostOf(url)}] login-gated page, session still active — not a logout.`,
        }
      : {
          status: 'unknown',
          message: `Anti-bot challenge (HTTP ${status} → ${finalUrl || url}); session is still logged in. Retry later or reduce request frequency.`,
          warning: `[${urlLabel || hostOf(url)}] HTTP ${status} blocked by anti-bot — your session is still active, this is rate-limiting.`,
        };
  }

  // Verifier failed → genuine logout. Make sure the cache reflects that so
  // the Settings pill flips to "Log in" on next render (we just learned
  // something the user hasn't been told yet).
  try {
    await writeStatusCache(platformId, false, { lastReason: verdict?.reason, lastTrace: verdict?.trace });
  } catch { /* cache write failures are non-fatal for this code path */ }
  return needsLogin();
}

// Strongest → weakest. Higher rank wins when aggregating across URLs.
// `sold` and `ended` outrank `live` because a "just sold" notification on
// the dashboard reflects newer state than a listing-page render that hasn't
// updated its banner yet. `needs-login` outranks `live` because a confirmed
// auth wall on the dashboard is more actionable than an unauthenticated
// "looks live" guess.
//
// `ended` covers any non-sold terminal state — expired without buyer,
// canceled, removed, withdrawn, suspended-for-policy. The *why* lives in
// `attention[]`, not in extra enum slots.
const STATUS_RANK = {
  sold:           5,
  ended:          4,
  'needs-login':  3,
  live:           2,
  unknown:        1,
  error:          0,
};

const VALID_STATUSES = new Set(Object.keys(STATUS_RANK));

// LLMs occasionally emit a synonym instead of the exact enum token. Map
// known synonyms to the canonical state before validation so we don't
// silently lose a correct verdict to an enum-name mismatch.
const STATUS_ALIASES = {
  expired: 'ended',
  removed: 'ended',
  canceled: 'ended',
  cancelled: 'ended',
  withdrawn: 'ended',
  closed: 'ended',
  active: 'live',
};
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  return STATUS_ALIASES[s] || s;
}

function cleanMessage(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

// `isFacebookShareUrl` is imported from src/utils/platformUrlMatch.js so the
// card UI nudge and this engine's diagnosis stay in lockstep on what a share
// link looks like.

function isFacebookMarketplaceItemUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/marketplace\/item\/[^/]+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function getAuthWallSignal({ status, finalUrl, url, html, platformId }) {
  const finalLower = String(finalUrl || url).toLowerCase();
  if (status === 401 || status === 403 || isLoginUrlPath(finalLower)) {
    return 'transport';
  }
  const config = getSellMonitorConfig(platformId);
  if (!config || !html) return null;
  const softWall = getSoftLoginWallMatch(stripHtmlForAnalysis(html), config);
  return softWall ? `body: ${softWall}` : null;
}

/**
 * A listing's own page returning a hard client error means the item is no
 * longer retrievable — sold, deleted, or removed → `ended`.
 *
 * 404/410 are unambiguous "gone" for ANY page (a dashboard or the listing
 * itself). 400 is broadened to the LISTING url for most canonical listing URLs:
 * some platforms return HTTP 400 "This content isn't available right now" for a
 * removed item. Facebook is an exception: both `/share/<hash>` and canonical
 * `/marketplace/item/<id>` URLs can 400 in automation while the seller's authed
 * view still shows an active/in-review listing. Treat those 400s as ambiguous
 * so watch/dashboard evidence can win the aggregate.
 *
 * Returns a pre-LLM result when the transport status is decisive/ambiguous, or
 * null when the status should proceed to content analysis.
 */
export function goneListingResult({ status, url, urlLabel }) {
  const isListing = urlLabel === 'listing';
  // Facebook listing URLs are not stable status evidence at HTTP 400: a listing
  // under seller review can 400 to public/automation fetches while still being
  // editable and visible in seller dashboards. Treat that shape as ambiguous so
  // authenticated listing/dashboard evidence can decide the final state.
  if (isListing && status === 400 && isFacebookShareUrl(url)) {
    // A /share/<hash> link is the worst-case anchor: it 400s to automation AND
    // its hash never appears on the seller dashboard, so no watch page can
    // confirm it either. Tell the user the actual fix rather than the generic
    // in-review note — paste the canonical /marketplace/item/<id> URL.
    return {
      url,
      urlLabel,
      status: 'unknown',
      message: "This is a Facebook share link (/share/…), which returns HTTP 400 to automated checks and whose code never appears on your seller dashboard — so the status can't be confirmed (the listing may well still be live). Open the listing and paste its canonical facebook.com/marketplace/item/<id> URL for a reliable check.",
    };
  }
  if (isListing && status === 400 && isFacebookMarketplaceItemUrl(url)) {
    return {
      url,
      urlLabel,
      status: 'unknown',
      message: 'Facebook listing URL returned HTTP 400. Facebook can do this for active or in-review seller listings; use authenticated listing/dashboard evidence instead of treating it as ended.',
    };
  }
  const gone = status === 404 || status === 410 || (isListing && status === 400);
  if (!gone) return null;
  const message = status === 404 || status === 410
    ? `Listing not found (HTTP ${status}).`
    : `Listing page is no longer available (HTTP ${status}) — the item was removed, deleted, or sold.`;
  return { url, urlLabel, status: 'ended', message };
}

export function deterministicListingStatusFromText({ text, platformId, url, urlLabel, matched } = {}) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lower || platformId !== 'facebook' || urlLabel !== 'listing') return null;

  const terminalText = /\b(this listing (?:has )?(?:ended|expired)|no longer available|removed by facebook|marked as sold|sold on)\b/.test(lower);
  const isUnderReview =
    /\bthis listing is (?:in review|being reviewed)\b/.test(lower) ||
    /\blisting is (?:currently )?being reviewed\b/.test(lower) ||
    /\ball listings go through a standard review\b/.test(lower);
  if (isUnderReview && !terminalText) {
    return {
      url,
      urlLabel,
      status: 'live',
      message: '[listing] Facebook says this listing is in review. Review means it is awaiting visibility approval, not ended.',
      attention: [{
        urgency: 'low',
        category: 'policy',
        headline: 'Listing currently being reviewed',
        evidence: 'This listing is in review.',
      }],
      matched: typeof matched === 'boolean' ? matched : null,
    };
  }

  const isOwnerActivePage =
    /\bmark as sold\b/.test(lower) &&
    /\bmark as pending\b/.test(lower) &&
    /\bboost listing\b/.test(lower);
  if (!isOwnerActivePage) return null;

  const withoutActionLabels = lower
    .replace(/\bmark as sold\b/g, ' ')
    .replace(/\bmark as pending\b/g, ' ');
  if (/\b(this listing (?:has )?(?:ended|expired)|no longer available|removed by facebook|marked as sold|sold on)\b/.test(withoutActionLabels)) {
    return null;
  }

  return {
    url,
    urlLabel,
    status: 'live',
    message: '[listing] Facebook seller controls are visible: Mark as sold, Mark as pending, and Boost listing. Those are owner actions for an active listing, not a sold/ended banner.',
    attention: [],
    matched: typeof matched === 'boolean' ? matched : null,
  };
}

function sourceDescription(url, urlLabel) {
  if (urlLabel) return `the ${urlLabel} page`;
  return hostOf(url) || 'the page';
}

function fallbackStatusMessage({ status, listingIdentifier, matched, url, urlLabel } = {}) {
  const source = sourceDescription(url, urlLabel);
  const id = listingIdentifier ? `identifier '${listingIdentifier}'` : 'the listing identifier';
  switch (status) {
    case 'unknown':
      if (matched === true) {
        return `Found ${id} on ${source}, but no clear live/sold/ended signal was present.`;
      }
      if (matched === false) {
        return `No clear status signal found; ${id} was not found on ${source}.`;
      }
      return `No clear status signal found for this listing on ${source}.`;
    case 'live':
      return `Status classified as live on ${source}, but no evidence sentence was returned.`;
    case 'sold':
      return `Status classified as sold on ${source}, but no evidence sentence was returned.`;
    case 'ended':
      return `Status classified as ended on ${source}, but no evidence sentence was returned.`;
    case 'needs-login':
      return `Page appears login-gated on ${source}, but no evidence sentence was returned.`;
    case 'error':
      return `Status check failed on ${source} without additional details.`;
    default:
      return `Status check returned no details for ${source}.`;
  }
}

function formatClassificationMessage({ url, urlLabel, status, rawMessage, listingIdentifier, matched }) {
  const source = urlLabel || hostOf(url);
  const message = cleanMessage(rawMessage) || fallbackStatusMessage({ status, listingIdentifier, matched, url, urlLabel });
  return source ? `[${source}] ${message}` : message;
}

// Open-ended channel for "things a seller would want to know that don't
// change the state." Engagement signals, platform actions, deadlines, etc.
// AI picks `category` from this fixed list so the card UI can pick an icon.
const VALID_ATTENTION_CATEGORIES = new Set([
  'engagement',     // views/watchers/saves spikes, recent activity
  'offer',          // offer received / counter / accepted
  'question',       // buyer asked a question
  'policy',         // policy hold, suspended, demoted in search, identity verify
  'payout',         // payout hold, payment dispute, refund issued
  'pricing',        // platform price suggestion, competing item undercut, promo
  'time-sensitive', // deadline (offer expiring, dispute response due)
  'other',
]);
const VALID_URGENCIES = new Set(['high', 'low']);

/**
 * Extract a unique-enough anchor string for the listing.
 * Prefers a path/query identifier from the URL (eBay item id, Poshmark slug,
 * Mercari hash). Falls back to the productSnapshot title. Returns null only
 * if neither is available — caller decides what to do.
 */
export function extractListingIdentifier(listingUrl, productTitle) {
  if (listingUrl) {
    try {
      const u = new URL(listingUrl);
      // Try platform-specific patterns first; fall back to the last segment.
      const path = u.pathname;
      // eBay: /itm/<id> OR /itm/<title>/<id>
      const ebayItm = path.match(/\/itm\/(?:[^/]+\/)?(\d{6,})/);
      if (ebayItm) return ebayItm[1];
      // eBay alt: ?item= or ?ItemID=
      const ebayQuery = u.searchParams.get('item') || u.searchParams.get('ItemID');
      if (ebayQuery && /^\d{6,}$/.test(ebayQuery)) return ebayQuery;
      // Generic: the last non-empty path segment that's a usable slug.
      const segments = path.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && last.length >= 4) {
        // Strip file extensions and trailing query-like fragments.
        return last.replace(/\.\w+$/, '').slice(0, IDENTIFIER_MAX_CHARS);
      }
    } catch { /* malformed URL — fall through to title */ }
  }
  const title = (productTitle || '').trim();
  if (title.length >= 4) return title.slice(0, IDENTIFIER_MAX_CHARS);
  return null;
}

/**
 * Strip a page down to its signal-bearing text. Removes script/style/svg/nav/
 * footer/header/aside blocks, HTML comments, and collapses whitespace.
 *
 * Returns a string of plain-ish text with HTML tags removed. Cheap regex
 * approach instead of a DOM parse — good enough since the LLM is what does
 * the actual reading. Token-density goes up ~5x vs. raw HTML.
 */
// Read/unread state on a marketplace messages/notifications hub lives ONLY in
// CSS class names — never in the visible text. eBay's messages inbox marks an
// already-opened conversation with `card__content-read` on its content block
// and `status-dot--hidden` on its "new" dot; an unopened one carries
// `card__content-unread`. stripHtmlForAnalysis collapses every tag (and thus
// every class) to a space, so the model sees identical text for a read and an
// unread message — and flags already-handled messages as ACTION NEEDED.
//
// annotateReadState runs on the RAW html BEFORE stripping and injects an inline
// sentinel right AFTER the marker element's opening tag, so the sentinel lands
// at the very start of that element's text and survives stripping + windowing.
// The tokens are system annotations, not page copy — the hub-scan prompt is told
// not to quote them as evidence, and sanitizeAttention scrubs them defensively.
//
// DIRECTIONAL INVARIANT (do not invert): the READ classes do the real work. The
// presence of a ⟦READ⟧ token is what DEMOTES a message; absence means "unknown
// read-state", which (correctly) leaves it eligible for action-needed. So class
// drift fails toward OVER-flagging (an already-handled message resurfaces), never
// toward hiding a genuinely new one. Never rewrite this so that "unmarked" becomes
// the demotion trigger — that would flip drift to dangerous false suppression.
export const READ_STATE_READ_TOKEN   = '⟦READ⟧';
export const READ_STATE_UNREAD_TOKEN = '⟦UNREAD⟧';

// [openingTagRegex, token]. Each regex matches an opening tag whose class
// attribute carries a read-state signal; the token is appended after that tag.
const READ_STATE_RULES = [
  // eBay messages inbox — read conversation's content block + its hidden dot.
  // `card__content-read` is the LOAD-BEARING read signal: it sits on the content
  // block (always plain-text-bearing), so its token survives stripping. The
  // `status-dot--hidden` rule is a corroborating fallback only — if that dot is
  // ever an <svg> (or nested in <svg>/<nav>/<header>/<footer>/<aside>, all
  // removed-WITH-contents by stripHtmlForAnalysis), its token is wiped. That is
  // harmless while the content-block rule still fires.
  [/(<[a-z][a-z0-9-]*\b[^>]*\bcard__content-read\b[^>]*>)/gi,   READ_STATE_READ_TOKEN],
  [/(<[a-z][a-z0-9-]*\b[^>]*\bstatus-dot--hidden\b[^>]*>)/gi,   READ_STATE_READ_TOKEN],
  // eBay messages inbox — explicit unopened conversation card (best-effort
  // positive signal; the system does not depend on it — see note above).
  [/(<[a-z][a-z0-9-]*\b[^>]*\bcard__content-unread\b[^>]*>)/gi, READ_STATE_UNREAD_TOKEN],
];

// NOTE: not idempotent — each call appends a token per match. Call exactly once
// per page (the sole production call site is in scanSellerHubPages); never wrap
// an already-annotated string.
export function annotateReadState(html) {
  if (!html) return html;
  let s = String(html);
  for (const [re, token] of READ_STATE_RULES) s = s.replace(re, `$1 ${token} `);
  return s;
}

// Conversation-level read/unread counts for diagnostics (one per card, keyed off
// the content class so the hidden-dot annotation does not double-count). Surfaced
// in the bug report so a future "read message still flagged" report proves whether
// the model actually received the read-state signal.
export function summarizeReadState(html) {
  if (!html) return { read: 0, unread: 0 };
  const s = String(html);
  return {
    read:   (s.match(/\bcard__content-read\b/gi)   || []).length,
    unread: (s.match(/\bcard__content-unread\b/gi) || []).length,
  };
}

export function stripHtmlForAnalysis(html) {
  if (!html) return '';
  let s = String(html);

  // Drop noisy structural blocks entirely (including their contents).
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  s = s.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ');
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ');
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Remaining tags → space (preserves word boundaries).
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode the handful of common entities that matter for keyword matching.
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");
  // Collapse whitespace runs.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Find the first case-insensitive occurrence of `identifier` in `text` and
 * return a ±contextChars window around it. If no match, returns the head of
 * `text` capped at maxFullChars so the model still has something to look at.
 *
 * The pre-pass is what lets a single multi-URL check survive an account
 * dashboard with 50 listings: instead of sending all 50, we send the chunk
 * containing the one we care about.
 */
export function findIdentifierWindow(text, identifier, {
  contextChars = 2000,
  // Capped low: when the identifier isn't found anywhere in the page, sending
  // 50k chars to the LLM almost always produces `unknown` anyway (the listing
  // genuinely isn't on the page). Better to confidently return `unknown` at
  // 8k chars than burn 12k input tokens hoping. The match path is unaffected.
  maxFullChars = 8000,
} = {}) {
  if (!text) return { window: '', matched: false };
  if (!identifier) {
    return { window: text.slice(0, maxFullChars), matched: false };
  }
  const needle = identifier.toLowerCase();
  const hay    = text.toLowerCase();
  const idx    = hay.indexOf(needle);
  if (idx === -1) {
    return { window: text.slice(0, maxFullChars), matched: false };
  }
  const start = Math.max(0, idx - contextChars);
  const end   = Math.min(text.length, idx + needle.length + contextChars);
  return { window: text.slice(start, end), matched: true };
}

/**
 * Pick the strongest signal across N per-URL classification results.
 * Returns { status, message, attention, sources } where:
 *   - status: strongest state (sold > ended > needs-login > live > unknown)
 *   - message: best-source message + parenthetical of other non-unknown statuses
 *   - attention: deduped union of attention items from every source
 *   - sources: per-URL trace for "here's exactly what was found and where"
 */
export function aggregateStrongest(perUrlResults) {
  if (!perUrlResults || perUrlResults.length === 0) {
    return { status: 'unknown', message: 'No URLs checked', attention: [], sources: [] };
  }
  let best = null;
  for (const r of perUrlResults) {
    const rank = STATUS_RANK[r.status] ?? -1;
    const bestRank = STATUS_RANK[best?.status] ?? -1;
    if (!best || rank > bestRank || (rank === bestRank && !cleanMessage(best.message) && cleanMessage(r.message))) {
      best = r;
    }
  }
  const messageParts = [];
  const bestMessage = cleanMessage(best?.message) || fallbackStatusMessage(best);
  if (bestMessage) messageParts.push(bestMessage);
  const otherSignals = perUrlResults
    .filter(r => r !== best && r.status !== 'unknown' && r.status !== 'error')
    .map(r => `${r.status} on ${r.urlLabel || r.url}`);
  if (otherSignals.length > 0) {
    messageParts.push(`(also: ${otherSignals.join(', ')})`);
  }
  // Concatenate attention items from the sources that actually located THIS
  // listing, then fuzzy-dedup so the card doesn't show four near-identical
  // "1 offer received" lines when four watch URLs all surfaced the same signal.
  //
  // A watch/dashboard page lists many listings; attention it emits is only
  // about ours when ours was found there — otherwise it bleeds in a sibling
  // listing's offer or an account-level notice (e.g. a deleted listing reading
  // `ended` while a dashboard still showed an unrelated "high urgency" item).
  // A source is trusted for attention when: it's the listing's own page
  // (inherently about this listing — `matched` can be false there if the page
  // doesn't echo the id literally), OR the identifier matched on that page, OR
  // that page reached a definite per-listing verdict (live/sold/ended/needs-
  // login — the model located the listing by id or title to conclude that).
  const allAttention = perUrlResults.flatMap(r => {
    if (!Array.isArray(r.attention) || r.attention.length === 0) return [];
    const aboutThisListing = r.urlLabel === 'listing'
      || r.matched === true
      || (r.status && r.status !== 'unknown' && r.status !== 'error');
    return aboutThisListing ? r.attention : [];
  });
  const attention = dedupeAttention(allAttention);
  return {
    status: best?.status || 'unknown',
    message: messageParts.join(' '),
    attention,
    sources: perUrlResults,
  };
}

/**
 * Fuzzy-dedup attention items by normalized headline. Two items match if
 * their headlines (lowercased, alphanum-only, whitespace-collapsed) are
 * equal — cheap enough to run on every check, robust against tiny copy
 * variations ("Offer: $65" vs "Offer received: $65").
 *
 * On collision, keeps the item with the higher urgency (high > low). For
 * ties, keeps the first seen — preserves a stable order for rendering.
 */
function dedupeAttention(items) {
  const seen = new Map(); // normalized headline → item
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const headline = String(raw.headline || '').trim();
    if (!headline) continue;
    const urgency = VALID_URGENCIES.has(raw.urgency) ? raw.urgency : 'low';
    const category = VALID_ATTENTION_CATEGORIES.has(raw.category) ? raw.category : 'other';
    const evidence = String(raw.evidence || '').trim();
    // Preserve sourceUrl when present so dedupe stays shape-compatible with
    // sanitizeAttention (today only the hub path sets it, and that path doesn't
    // dedupe — but don't make this a silent field-drop if that ever changes).
    const sourceUrl = String(raw.sourceUrl || '').trim();
    const key = headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prior = seen.get(key);
    if (!prior || (urgency === 'high' && prior.urgency !== 'high')) {
      seen.set(key, { urgency, category, headline, evidence, ...(sourceUrl ? { sourceUrl } : {}) });
    }
  }
  // High urgency items render first; within a tier, insertion order.
  const arr = Array.from(seen.values());
  arr.sort((a, b) => (a.urgency === 'high' ? -1 : 0) - (b.urgency === 'high' ? -1 : 0));
  return arr;
}

/** Derive the platform-level hub status from its per-page source outcomes. */
export function deriveHubScanStatus(sources) {
  const statuses = (Array.isArray(sources) ? sources : []).map((source) => source?.status);
  if (statuses.includes('ok')) return 'ok';
  if (statuses.includes('needs-login')) return 'needs-login';
  if (statuses.length > 0 && statuses.every((status) => status === 'error')) return 'error';
  return 'unknown';
}

/**
 * Default fetcher — plain Node fetch with a real-browser UA. Returns the same
 * shape as the puppeteer-based fetcher so the check pipeline doesn't care
 * which one ran. Callers can pass their own `fetcher` to route an URL through
 * an authenticated browser session instead.
 */
export async function plainFetcher(url, signal) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal,
    });
    const html = await res.text();
    return { ok: true, status: res.status, finalUrl: res.url || url, html };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Classify the status of one URL. The fetcher is injected so callers can use
 * plainFetcher for public listing pages and an authenticated stealth-browser
 * fetcher for dashboards / notification feeds.
 */
export async function classifyOneUrl({
  url,
  listingIdentifier,
  productTitle,
  platformId,
  urlLabel,
  fetcher = plainFetcher,
  signal,
}) {
  const r = await fetcher(url, signal);
  if (!r.ok) {
    return { url, urlLabel, status: 'error', message: `Fetch failed: ${r.error}` };
  }

  // Cheap pre-classification on transport signals — skip the LLM call when
  // the answer is obvious from HTTP status alone.
  const authWallSignal = getAuthWallSignal({ status: r.status, finalUrl: r.finalUrl, url, html: r.html, platformId });
  // Transport-level auth (401/403 / login redirect) is a real wall → disambiguate.
  if (authWallSignal === 'transport') {
    const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url, urlLabel });
    return { url, urlLabel, ...verdict };
  }
  // A hard client error on the listing's own page = the item is gone. Checked
  // BEFORE the soft body-wall so a deleted-listing 400 isn't swallowed as a
  // login wall by chrome that happens to carry a "Log in" link.
  const goneResult = goneListingResult({ status: r.status, url, urlLabel });
  if (goneResult) return goneResult;
  // Soft body-level login wall (a 200 page whose body is a sign-in prompt).
  if (authWallSignal) {
    const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url, urlLabel });
    return { url, urlLabel, ...verdict };
  }
  if (!r.html || r.html.length < MIN_CONTENT_CHARS) {
    return {
      url, urlLabel,
      status: 'unknown',
      message: `Empty or near-empty response (${r.html?.length || 0} bytes).`,
    };
  }

  // Strip + window. If the identifier matched, we send only the ±2k slice
  // around it; otherwise the head of the page up to maxFullChars (8000).
  const stripped = stripHtmlForAnalysis(r.html);
  const { window: snippet, matched } = findIdentifierWindow(stripped, listingIdentifier);
  const deterministicStatus = deterministicListingStatusFromText({
    text: stripped,
    platformId,
    url,
    urlLabel,
    matched,
  });
  if (deterministicStatus) return deterministicStatus;
  const matchHint = matched
    ? `The text below is the ±2000-char window around the first occurrence of identifier '${listingIdentifier}'.`
    : `Identifier '${listingIdentifier || '(none)'}' was NOT found in this page; the text below is the page head. If the listing isn't present here, return status 'unknown' with reason 'not present on this page'.`;

  const prompt = `You are determining the current status of a specific listing or posting. The platform may be a marketplace listing (eBay, Mercari…) or a job posting (LinkedIn, Indeed…) — interpret evidence in the context of whatever platform this is.

Identifier:         ${listingIdentifier || '(none provided)'}
Title:              ${productTitle || '(unknown)'}
Platform:           ${platformId || '(unknown)'}
Page URL:           ${url}
Final URL after redirects: ${r.finalUrl || url}
HTTP status:        ${r.status}

The page you are reading may be any of:
  - the listing's own detail page
  - a notification feed / activity center
  - the seller's account dashboard or active-listings table
  - the seller's sold-listings or ended-listings table
  - something else entirely

${matchHint}

PAGE TEXT (stripped of nav/scripts/styles):
${snippet}

You are checking this listing on behalf of the seller. Report two things:

1. The listing's current STATE.
2. Any ATTENTION items — things the seller would want to know about that don't change the state (offers, questions, watcher activity, platform actions, deadlines, etc.).

Return ONLY a JSON object:
{
  "status": "live" | "sold" | "ended" | "needs-login" | "unknown",
  "message": "1 short sentence quoting or paraphrasing the verbatim signal that determined the state (e.g. 'SOLD banner above the buy button', 'Row in active-listings table with status Active and 0 watchers')",
  "attention": [
    {
      "urgency": "high" | "low",
      "category": "engagement" | "offer" | "question" | "policy" | "payout" | "pricing" | "time-sensitive" | "other",
      "headline": "short sentence the seller reads at a glance, e.g. 'Buyer offered $65 (expires 2h)'",
      "evidence": "verbatim quote or close paraphrase from the page so the seller can verify"
    }
    // zero or more; omit field entirely if nothing notable
  ]
}

State rules:
- "live"        — listing is currently up for sale (buy button visible, status Active in a table, etc.)
- Seller owner-page actions such as "Mark as sold", "Mark as pending", "Boost listing", or "Edit" are LIVE evidence; they are actions the seller can take, not evidence that the item is already sold, pending, or ended.
- Facebook review banners such as "This listing is in review" or "This listing is being reviewed" are LIVE/non-terminal evidence; include a low-urgency attention item, but do not classify them as ended.
- "sold"        — the listing sold (SOLD banner, notification of sale, row in sold-listings table)
- "ended"       — listing is no longer for sale and didn't sell (expired, canceled, removed, withdrawn, suspended for policy — *why* goes in attention, not state)
- "needs-login" — the page itself is gated behind a login form or a "sign in to view" wall
- "unknown"     — no clear evidence about THIS listing in the page text above

Attention rules:
- urgency "high" = act-now items (offer expiring, suspension, dispute response due, payout held)
- urgency "low"  = FYI items (a few new watchers, price recommendation, listing edit suggestion)
- Skip generic baseline info (a static view count is not attention; an unusual spike is)
- Be selective — only what a busy seller would actually want to act on or know about

Be conservative: prefer "unknown" over a guess for state. Do NOT classify based on OTHER listings on a dashboard page.`;

  let parsed;
  try {
    parsed = await callLLMText(prompt, { signal, task: 'page-status-classify', responseSchema: PAGE_STATUS_SINGLE_SCHEMA });
  } catch (err) {
    return {
      url, urlLabel,
      status: 'error',
      message: `AI classification failed: ${err?.message || String(err)}`,
    };
  }

  const normalized = normalizeStatus(parsed?.status);
  const status = VALID_STATUSES.has(normalized) ? normalized : 'unknown';
  const attention = sanitizeAttention(parsed?.attention);
  return {
    url, urlLabel,
    status,
    message: formatClassificationMessage({
      url,
      urlLabel,
      status,
      rawMessage: parsed?.message,
      listingIdentifier,
      matched,
    }),
    attention,
    // Whether the identity anchor was located in this page — the decisive
    // diagnostic for "why did the dashboard read unknown?" (a /share/<hash>
    // listing URL yields an anchor that never appears on the seller dashboard).
    matched,
  };
}

/**
 * Coerce LLM-returned attention payload into a clean array of validated
 * items. Drops malformed entries silently — the LLM occasionally returns
 * stringified objects, missing fields, or invalid categories. Caller-side
 * code should trust the result shape after this passes.
 */
function sanitizeAttention(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const headline = stripReadStateTokens(String(item.headline || '')).trim();
    if (!headline) continue;
    // `sourceUrl` is only emitted by the hub scan (which validates it against the
    // pages it actually fetched — see resolveAttentionSourceUrls). Pass it through
    // verbatim here; omit the key entirely when absent so other callers' shape is
    // unchanged.
    const sourceUrl = String(item.sourceUrl || '').trim();
    out.push({
      urgency:  VALID_URGENCIES.has(item.urgency) ? item.urgency : 'low',
      category: VALID_ATTENTION_CATEGORIES.has(item.category) ? item.category : 'other',
      headline,
      evidence: stripReadStateTokens(String(item.evidence || '')).trim(),
      ...(sourceUrl ? { sourceUrl } : {}),
    });
  }
  return out;
}

// Belt-and-suspenders: the hub-scan prompt tells the model not to quote the
// ⟦READ⟧/⟦UNREAD⟧ sentinels (they sit right next to the quotable message text
// after stripping), but a non-compliant model could leak one into headline/
// evidence — which would clutter the UI card and the bug report's verbatim
// evidence. Scrub them here so the guarantee doesn't depend on model compliance.
export function stripReadStateTokens(s) {
  const str = String(s ?? '');
  // No-op fast path — keeps the shared per-listing classifier output byte-for-byte
  // unchanged (those items never carry a sentinel; only the hub scan annotates).
  if (!str.includes(READ_STATE_READ_TOKEN) && !str.includes(READ_STATE_UNREAD_TOKEN)) return str;
  // Replace each token with a SPACE (not '') so a token jammed between two words
  // can't merge them, then collapse the gaps it leaves. Caller trims.
  return str
    .split(READ_STATE_READ_TOKEN).join(' ')
    .split(READ_STATE_UNREAD_TOKEN).join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Bind each hub-scan attention item to the page it was derived from, so the UI
 * can offer a "jump straight there" button. The model is asked to copy the HUB
 * PAGE url into `sourceUrl`, but we never trust that blindly:
 *
 *   - If the model's `sourceUrl` exactly matches one of the pages we fetched,
 *     keep it.
 *   - Otherwise, if only ONE hub page was scanned, the source is unambiguous —
 *     use it (the model's hint was redundant anyway).
 *   - Otherwise we genuinely don't know which of several pages it came from →
 *     drop `sourceUrl` (no button) rather than point the seller at a wrong page.
 *
 * Pure + exported for unit testing; `hubUrls` is the list of urls actually fetched.
 */
export function resolveAttentionSourceUrls(attention, hubUrls) {
  const urls = (Array.isArray(hubUrls) ? hubUrls : []).filter(Boolean);
  const known = new Set(urls);
  const soleUrl = urls.length === 1 ? urls[0] : null;
  return (Array.isArray(attention) ? attention : []).map((item) => {
    const claimed = String(item?.sourceUrl || '').trim();
    const resolved = known.has(claimed) ? claimed : soleUrl;
    const { sourceUrl: _drop, ...rest } = item || {};
    return resolved ? { ...rest, sourceUrl: resolved } : rest;
  });
}

/**
 * Consolidated multi-URL classifier. Fetches each URL with its fetcher,
 * strips + windows each page, then makes ONE LLM call carrying all N
 * windows. Cheaper than N separate calls because the instruction block +
 * listing identity preamble is shipped exactly once instead of N times.
 *
 * Falls back to per-URL `classifyOneUrl` only when N=1 (single-call path
 * has no consolidation win, and reuses the existing well-tested code).
 *
 * Each item in `urlSpecs` is `{ url, urlLabel, fetcher }` — the fetcher is
 * how the caller routes auth-walled URLs through the stealth browser while
 * keeping public listing URLs on plain fetch.
 */
export async function classifyMultipleUrls({
  urlSpecs,
  listingIdentifier,
  productTitle,
  platformId,
  signal,
}) {
  if (!urlSpecs || urlSpecs.length === 0) return [];
  if (urlSpecs.length === 1) {
    const s = urlSpecs[0];
    return [await classifyOneUrl({
      url: s.url,
      listingIdentifier,
      productTitle,
      platformId,
      urlLabel: s.urlLabel,
      fetcher: s.fetcher,
      signal,
    })];
  }

  // Fetch + strip + window every URL in parallel. Surface transport-level
  // outcomes (auth wall, 404, empty) immediately without burning an LLM
  // call — these are the same shortcuts classifyOneUrl makes individually.
  const prepared = await Promise.all(urlSpecs.map(async (s) => {
    const r = await s.fetcher(s.url, signal);
    if (!r.ok) {
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, status: 'error', message: `Fetch failed: ${r.error}` } };
    }
    const authWallSignal = getAuthWallSignal({ status: r.status, finalUrl: r.finalUrl, url: s.url, html: r.html, platformId });
    if (authWallSignal === 'transport') {
      const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url: s.url, urlLabel: s.urlLabel });
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, ...verdict } };
    }
    // Hard client error on the listing's own page = gone (see goneListingResult);
    // ranked above the soft body-wall so a deleted-listing 400 isn't read as login.
    const goneResult = goneListingResult({ status: r.status, url: s.url, urlLabel: s.urlLabel });
    if (goneResult) return { spec: s, terminal: goneResult };
    if (authWallSignal) {
      const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url: s.url, urlLabel: s.urlLabel });
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, ...verdict } };
    }
    if (!r.html || r.html.length < MIN_CONTENT_CHARS) {
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, status: 'unknown', message: `Empty or near-empty response (${r.html?.length || 0} bytes).` } };
    }
    const stripped = stripHtmlForAnalysis(r.html);
    const { window: snippet, matched } = findIdentifierWindow(stripped, listingIdentifier);
    const deterministicStatus = deterministicListingStatusFromText({
      text: stripped,
      platformId,
      url: s.url,
      urlLabel: s.urlLabel,
      matched,
    });
    if (deterministicStatus) return { spec: s, terminal: deterministicStatus };
    return { spec: s, status: r.status, finalUrl: r.finalUrl, snippet, matched };
  }));

  // Anything with a terminal verdict goes straight to results; only
  // non-terminal pages go to the consolidated LLM call.
  const results = [];
  const llmInputs = [];
  for (const p of prepared) {
    if (p.terminal) {
      results.push(p.terminal);
    } else {
      llmInputs.push(p);
    }
  }

  if (llmInputs.length === 0) return results;

  // Build one prompt with all N stripped windows labeled by index. Model
  // returns an array of per-window verdicts.
  const sections = llmInputs.map((p, i) => {
    const matchHint = p.matched
      ? `(±2000-char window around first occurrence of identifier)`
      : `(identifier NOT found; head of page shown — return 'unknown' if listing isn't present)`;
    return `--- PAGE ${i + 1} (label: ${p.spec.urlLabel || 'page'}, url: ${p.spec.url}, finalUrl: ${p.finalUrl}, http: ${p.status}) ${matchHint} ---\n${p.snippet}`;
  }).join('\n\n');

  const prompt = `You are determining the current status of a specific listing or posting across multiple pages. The platform may be a marketplace listing (eBay, Mercari…) or a job posting (LinkedIn, Indeed…) — interpret evidence in the context of whatever platform this is.

Identifier:         ${listingIdentifier || '(none provided)'}
Title:              ${productTitle || '(unknown)'}
Platform:           ${platformId || '(unknown)'}

Each page below may be the listing's own detail page, a notification feed, a seller dashboard or active-listings table, a sold-listings table, or something else. For EACH page, find the most specific evidence about THIS listing's state in that page only.

${sections}

For each page, report two things:
1. The listing's STATE as evidenced on that page.
2. ATTENTION items on that page — things the seller would want to know about that don't change the state (offers, questions, watcher activity, platform actions, deadlines, etc.).

Return ONLY a JSON object:
{
  "results": [
    {
      "pageIndex": 1,
      "status": "live" | "sold" | "ended" | "needs-login" | "unknown",
      "message": "1 short sentence quoting or paraphrasing the verbatim signal that determined the state",
      "attention": [
        {
          "urgency": "high" | "low",
          "category": "engagement" | "offer" | "question" | "policy" | "payout" | "pricing" | "time-sensitive" | "other",
          "headline": "short sentence the seller reads at a glance",
          "evidence": "verbatim quote or close paraphrase from the page"
        }
        // zero or more; omit field entirely if nothing notable on this page
      ]
    }
    // one entry per page, in order
  ]
}

State rules per page:
- "live"        — listing currently up for sale on that page (buy button, status Active in a table row matching the identifier, etc.)
- Seller owner-page actions such as "Mark as sold", "Mark as pending", "Boost listing", or "Edit" are LIVE evidence; they are actions the seller can take, not evidence that the item is already sold, pending, or ended.
- Facebook review banners such as "This listing is in review" or "This listing is being reviewed" are LIVE/non-terminal evidence; include a low-urgency attention item, but do not classify them as ended.
- "sold"        — page evidence of sale for this specific listing (SOLD banner, "sold for $X" notification, row in sold-listings)
- "ended"       — listing is no longer for sale and didn't sell (expired, canceled, removed, withdrawn, suspended for policy — *why* belongs in attention)
- "needs-login" — page body is gated behind a login form (separate from the 4xx auth wall we already handle)
- "unknown"     — no clear evidence about THIS listing in this page

Attention rules:
- urgency "high" = act-now items (offer expiring, suspension, dispute response due, payout held)
- urgency "low"  = FYI items (a few new watchers, price recommendation, listing edit suggestion)
- Skip generic baseline info (a static view count is not attention; an unusual spike is)
- Be selective — only what a busy seller would actually want to act on or know about

Be conservative: prefer "unknown" over a guess for state. Do NOT classify based on OTHER listings on a dashboard.`;

  let parsed;
  try {
    parsed = await callLLMText(prompt, { signal, task: 'page-status-classify', responseSchema: PAGE_STATUS_MULTI_SCHEMA });
  } catch (err) {
    // The whole batch failed — mark every LLM page as error. Terminal verdicts
    // computed pre-LLM are already in `results`.
    for (const p of llmInputs) {
      results.push({ url: p.spec.url, urlLabel: p.spec.urlLabel, status: 'error', message: `AI classification failed: ${err?.message || String(err)}` });
    }
    return results;
  }

  const arr = Array.isArray(parsed?.results) ? parsed.results : [];
  for (let i = 0; i < llmInputs.length; i++) {
    const p = llmInputs[i];
    // Match by pageIndex (1-based) but fall back to positional if the model
    // dropped or renumbered entries.
    const verdict = arr.find(r => r?.pageIndex === i + 1) || arr[i];
    const normalized = normalizeStatus(verdict?.status);
    const status = VALID_STATUSES.has(normalized) ? normalized : 'unknown';
    results.push({
      url: p.spec.url,
      urlLabel: p.spec.urlLabel,
      status,
      message: formatClassificationMessage({
        url: p.spec.url,
        urlLabel: p.spec.urlLabel,
        status,
        rawMessage: verdict?.message,
        listingIdentifier,
        matched: p.matched,
      }),
      attention: sanitizeAttention(verdict?.attention),
      matched: p.matched,
    });
  }
  return results;
}

// Head slice for a hub page — there is no single-listing identifier to window
// around (the whole point of the hub is that it aggregates every listing), so
// we feed the model the page head after stripping nav/script chrome.
const HUB_HEAD_CHARS = 8000;

/**
 * Marketplace Status Module scanner — NOT listing-specific.
 *
 * Fetches a single platform's aggregate hub page(s) (the per-platform watch URLs
 * the user configured in Settings: seller dashboard, notifications feed, activity
 * center, messages inbox) and asks the model to surface anything across ALL of
 * the seller's listings that needs action or is useful to know — instead of
 * tracking one listing's live/sold/ended state.
 *
 * Reuses the same transport shortcuts as classifyMultipleUrls (auth wall →
 * needs-login, fetch error → error, empty → unknown) so a logged-out platform
 * reports cleanly without an LLM call. All readable pages go into ONE
 * consolidated `marketplace-hub-scan` call.
 *
 * @returns {{ status:'ok'|'needs-login'|'error'|'unknown', message:string,
 *   summary:string, attention:object[], sources:object[] }}
 */
export async function scanSellerHubPages({ urlSpecs, platformId, signal, llmText = callLLMText }) {
  if (!Array.isArray(urlSpecs) || urlSpecs.length === 0) {
    return { status: 'unknown', message: 'No watch URLs configured for this platform.', summary: '', attention: [], sources: [] };
  }

  // Fetch + strip every hub URL in parallel; resolve transport-level outcomes
  // (auth wall, fetch error, empty) up front so they never cost an LLM call.
  const prepared = await Promise.all(urlSpecs.map(async (s) => {
    const spec = s && typeof s === 'object' ? s : {};
    const { url, urlLabel } = spec;
    let r;
    try {
      if (typeof spec.fetcher !== 'function') throw new Error('missing fetcher');
      r = await spec.fetcher(url, signal);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'error',
          message: `Fetch failed: ${err?.message || String(err)}`,
        },
      };
    }
    if (!r || typeof r !== 'object') {
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'error',
          message: 'Fetch failed: fetcher returned no response.',
        },
      };
    }
    if (!r.ok) {
      const detail = r.error || (r.status ? `HTTP ${r.status}` : 'unknown error');
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'error',
          message: `Fetch failed: ${detail}`,
          ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}),
          ...(r.title ? { title: r.title } : {}),
          ...(r.appleEventsDisabled ? { appleEventsDisabled: true } : {}),
          ...(r.loggedOut ? { loggedOut: true } : {}),
          ...(r.challenged ? { challenged: true } : {}),
        },
      };
    }
    const authWallSignal = getAuthWallSignal({ status: r.status, finalUrl: r.finalUrl, url, html: r.html, platformId });
    if (authWallSignal) {
      const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url, urlLabel });
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          ...verdict,
          ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}),
          ...(r.title ? { title: r.title } : {}),
        },
      };
    }
    // Anti-bot wall served as HUB CONTENT to the app's CDP/stealth browser (eBay's
    // "Please verify yourself to continue" at HTTP 200, a Cloudflare "Performing
    // security verification", an AptDeco-style "Human Verification" 405) while the
    // user's NORMAL browser is unaffected. getAuthWallSignal does NOT catch these —
    // they're not 401/403, not a /login URL, and not in the soft-wall list — so
    // without this the wall HTML is stripped and sent to the AI summarizer, which
    // reads the verify-wall copy and reports a phantom high-urgency "account blocked"
    // (the reported eBay mis-classification). Classify it as a BLOCKED / unreadable
    // hub source instead: the marketplace SESSION may still be connected (this is an
    // anti-bot fingerprint block on the automated session, not an account/logout),
    // and we skip the misleading AI summary for this URL. 'unknown' buckets it under
    // the `blk` count + the "Blocked / unreadable hub sources" section.
    const antiBot = detectAntiBotSignal({ status: r.status, finalUrl: r.finalUrl, html: r.html, title: r.title, sourceLabel: platformId });
    if (antiBot && antiBot.severity === 'block') {
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'unknown',
          antiBot: antiBot.code,
          message: `Anti-bot wall served to the app browser (${antiBot.code}) — NOT an account block; your normal browser is unaffected and the ${platformId} session may still be connected. ${antiBot.suggestion}`,
          ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}),
          ...(r.title ? { title: r.title } : {}),
        },
      };
    }
    // Any other 4xx/5xx (auth walls were handled just above) means a broken or
    // changed watch URL, not readable hub content. Surface it as a terminal error
    // instead of stripping the error-page body and paying for a token-heavy
    // hub-scan LLM call that could only return a misleading "unknown".
    if (r.status >= 400) {
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'error',
          message: `Hub page returned HTTP ${r.status} — the watch URL is broken or changed.`,
          ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}),
          ...(r.title ? { title: r.title } : {}),
        },
      };
    }
    if (!r.html || r.html.length < MIN_CONTENT_CHARS) {
      return {
        spec,
        terminal: {
          url,
          urlLabel,
          status: 'unknown',
          message: `Empty or near-empty response (${r.html?.length || 0} bytes).`,
          ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}),
          ...(r.title ? { title: r.title } : {}),
        },
      };
    }
    // Preserve message read/unread state (CSS-class-only) BEFORE stripping wipes
    // it, so the model can tell an already-read message from a new one.
    const snippet = stripHtmlForAnalysis(annotateReadState(r.html)).slice(0, HUB_HEAD_CHARS);
    return { spec, status: r.status, finalUrl: r.finalUrl, title: r.title, snippet, readState: summarizeReadState(r.html) };
  }));

  const sources = [];
  const llmInputs = [];
  for (const p of prepared) {
    if (p.terminal) sources.push(p.terminal);
    else llmInputs.push(p);
  }

  // Aggregate read/unread conversation counts across the hub pages we read, for
  // the bug report (proves the model received read-state signal). Zero of both
  // means no message hub among the watch URLs, or the markers fell outside the
  // window — both worth knowing when a "read message flagged" report comes in.
  const readState = llmInputs.reduce((acc, p) => ({
    read:   acc.read   + (p.readState?.read   || 0),
    unread: acc.unread + (p.readState?.unread || 0),
  }), { read: 0, unread: 0 });

  let attention = [];
  let summary = '';

  if (llmInputs.length > 0) {
    const platformName = getSellMonitorConfig(platformId)?.name || platformId || 'this marketplace';
    const sections = llmInputs.map((p, i) =>
      `--- HUB PAGE ${i + 1} (label: ${p.spec.urlLabel || 'hub'}, url: ${p.spec.url}, http: ${p.status}) ---\n${p.snippet}`
    ).join('\n\n');

    const prompt = `You are reviewing a seller's ${platformName} account on their behalf. The page(s) below are the seller's AGGREGATE HUB — a seller dashboard, notifications feed, activity center, or messages inbox that summarizes ALL of their listings at once. You are NOT tracking one specific listing; scan the whole hub for what the seller would care about across their entire account.

${sections}

READ-STATE MARKERS: a conversation or message preceded by the token ${READ_STATE_READ_TOKEN} has ALREADY BEEN OPENED by the seller; one preceded by ${READ_STATE_UNREAD_TOKEN} (or with no marker) has not been confirmed read. These tokens are system annotations of the page's read/unread CSS state — they are NOT part of the page text, so never quote them in "evidence".

Surface two kinds of items:

1. ACTION NEEDED (urgency "high") — anything that needs the seller to act:
   - a buyer offer or counter-offer (especially if it's expiring)
   - an UNREAD buyer message or question awaiting a reply
   - an order to ship or a shipping deadline
   - a dispute, case, return request, or claim to respond to
   - a policy strike, listing removal, account warning, or a hold on funds
   - a payout that needs action or verification

2. USEFUL INFO (urgency "low") — FYI that doesn't need action:
   - a recent sale ("sold for $X")
   - new watchers, a new-offers count, a price/relist suggestion
   - a payout posted, a listing auto-renewed, a promotion eligibility

Return ONLY a JSON object:
{
  "summary": "one short line, e.g. '2 offers, 1 unread message, no policy issues'",
  "attention": [
    {
      "urgency": "high" | "low",
      "category": "engagement" | "offer" | "question" | "policy" | "payout" | "pricing" | "time-sensitive" | "other",
      "headline": "short sentence the seller reads at a glance, e.g. 'Buyer offered $65 on the AirPods (expires 8h)'",
      "evidence": "verbatim quote or close paraphrase from the page so the seller can verify",
      "sourceUrl": "the exact url of the HUB PAGE this item came from — copy it verbatim from that page's header line above"
    }
    // zero or more; return an empty array if the hub is quiet
  ]
}

Rules:
- Be selective and specific — only what a busy seller would actually act on or want to know. Skip static chrome (menu labels, a generic "0 notifications", boilerplate help text).
- A message/conversation marked ${READ_STATE_READ_TOKEN} has already been opened by the seller — do NOT raise it as ACTION NEEDED. Treat it as already-handled: omit it, or — if its latest message is from the BUYER and is an explicit question/request the seller has not yet answered — include it ONLY as a low-urgency FYI (never high). Only ${READ_STATE_UNREAD_TOKEN} / unmarked-but-clearly-new messages awaiting a reply are ACTION NEEDED.
- A NOTIFICATIONS/ACTIVITY-FEED entry such as "<name> sent you a message about your Marketplace listing …" is a persistent NOTIFICATION, NOT proof of a pending message — it stays in the feed after the seller has already read and replied to that message. Do NOT raise it as ACTION NEEDED on its own. Treat a message as ACTION NEEDED only when the page itself shows it is genuinely awaiting a reply (a ${READ_STATE_UNREAD_TOKEN} marker, a bold/"new"/unread badge, or an inbox unread count > 0).
- TRUST EXPLICIT COUNTERS over the feed: when the hub shows an authoritative actionable count — e.g. "Chats to answer: N", "Needs attention: N", "Orders to fill: N", "N unread" — that count is the source of truth. Never surface more high-urgency items of that kind than the counter says; when such a counter reads 0, the matching feed entries are already-handled (omit them, or at most a low-urgency FYI). A "Chats to answer: 0" with old "sent you a message" notifications means NO unread messages.
- IGNORE account-security noise: "new login from a device or location you don't usually use", "review your recent login", "we noticed a login", and password / 2FA / security-checkup prompts are NOT marketplace-actionable, and are routinely triggered by this very tool's OWN automated logins. Never raise them as high urgency — omit them (at most ONE low-urgency FYI).
- Every item must be grounded in the page text above — quote it in "evidence". Do NOT invent items.
- "sourceUrl" must be one of the HUB PAGE urls listed above, copied character-for-character — it's the page the seller will be taken to. Do not shorten, guess, or combine urls.
- If nothing notable is present, return an empty attention array.`;

    try {
      const parsed = await llmText(prompt, {
        signal,
        task: 'marketplace-hub-scan',
        hints: { urlCount: llmInputs.length },
        responseSchema: MARKETPLACE_HUB_SCAN_SCHEMA,
      });
      // Bind each item to the hub page it was read from (validated against the
      // pages we actually fetched) so the card can offer a jump-to-page button.
      attention = resolveAttentionSourceUrls(sanitizeAttention(parsed?.attention), llmInputs.map((p) => p.spec.url));
      // Scrub read-state sentinels from the summary too (sanitizeAttention already
      // does this for headline/evidence). The summary is a free-form model line
      // that sits right next to the annotated message text, so a non-compliant
      // model can leak a ⟦READ⟧/⟦UNREAD⟧ token into it — strip before it reaches
      // the card and the bug report.
      summary = cleanMessage(stripReadStateTokens(parsed?.summary));
      for (const p of llmInputs) {
        sources.push({
          url: p.spec.url,
          urlLabel: p.spec.urlLabel,
          status: 'ok',
          ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}),
          ...(p.title ? { title: p.title } : {}),
        });
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      for (const p of llmInputs) {
        sources.push({ url: p.spec.url, urlLabel: p.spec.urlLabel, status: 'error', message: `AI scan failed: ${err?.message || String(err)}` });
      }
    }
  }

  // Platform-level read status: 'ok' if we read any hub page; else surface the
  // strongest blocking reason (a dead session → needs-login; all errors →
  // error; otherwise unknown for anti-bot / login-gated-but-alive pages).
  const status = deriveHubScanStatus(sources);

  const message = summary || (
    status === 'ok'          ? (attention.length ? `${attention.length} item${attention.length === 1 ? '' : 's'} flagged.` : 'No action items found.')
    : status === 'needs-login' ? `${getSellMonitorConfig(platformId)?.name || platformId} session needs login. Open Settings → Marketplace Login.`
    : status === 'error'       ? (sources.find(s => s.message)?.message || 'Hub scan failed.')
    : 'Could not read this platform’s hub pages.'
  );

  return { status, message, summary, attention, sources, readState };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
