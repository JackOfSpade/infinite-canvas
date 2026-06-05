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
import { verifySellMonitorLogin, writeStatusCache } from './accounts.js';
import { logger } from '../logger.js';
import { PAGE_STATUS_SINGLE_SCHEMA, PAGE_STATUS_MULTI_SCHEMA } from './aiSchemas.js';

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
  const onLoginUrl = /\/(login|signin|sign-in|account\/login|auth(?!or))/i.test(finalLower);

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
  // Concatenate attention items from every source then fuzzy-dedup so the
  // card doesn't show four near-identical "1 offer received" lines when
  // four watch URLs all surfaced the same signal.
  const allAttention = perUrlResults.flatMap(r => Array.isArray(r.attention) ? r.attention : []);
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
    const key = headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prior = seen.get(key);
    if (!prior || (urgency === 'high' && prior.urgency !== 'high')) {
      seen.set(key, { urgency, category, headline, evidence });
    }
  }
  // High urgency items render first; within a tier, insertion order.
  const arr = Array.from(seen.values());
  arr.sort((a, b) => (a.urgency === 'high' ? -1 : 0) - (b.urgency === 'high' ? -1 : 0));
  return arr;
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
  const finalLower = String(r.finalUrl || url).toLowerCase();
  if (r.status === 401 || r.status === 403 || /\/(login|signin|sign-in|account\/login)/i.test(finalLower)) {
    const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url, urlLabel });
    return { url, urlLabel, ...verdict };
  }
  if (r.status === 404 || r.status === 410) {
    return {
      url, urlLabel,
      status: 'ended',
      message: `Listing not found (HTTP ${r.status}).`,
    };
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
    const headline = String(item.headline || '').trim();
    if (!headline) continue;
    out.push({
      urgency:  VALID_URGENCIES.has(item.urgency) ? item.urgency : 'low',
      category: VALID_ATTENTION_CATEGORIES.has(item.category) ? item.category : 'other',
      headline,
      evidence: String(item.evidence || '').trim(),
    });
  }
  return out;
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
    const finalLower = String(r.finalUrl || s.url).toLowerCase();
    if (r.status === 401 || r.status === 403 || /\/(login|signin|sign-in|account\/login)/i.test(finalLower)) {
      const verdict = await disambiguateAuthFailure({ platformId, status: r.status, finalUrl: r.finalUrl, url: s.url, urlLabel: s.urlLabel });
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, ...verdict } };
    }
    if (r.status === 404 || r.status === 410) {
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, status: 'ended', message: `Listing not found (HTTP ${r.status}).` } };
    }
    if (!r.html || r.html.length < MIN_CONTENT_CHARS) {
      return { spec: s, terminal: { url: s.url, urlLabel: s.urlLabel, status: 'unknown', message: `Empty or near-empty response (${r.html?.length || 0} bytes).` } };
    }
    const stripped = stripHtmlForAnalysis(r.html);
    const { window: snippet, matched } = findIdentifierWindow(stripped, listingIdentifier);
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
    });
  }
  return results;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
