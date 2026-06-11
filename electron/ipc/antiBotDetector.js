/**
 * Anti-bot signal detector.
 *
 * One canonical place that decides "this response looks like a block or
 * throttle." Every scraper / fetcher in the app should feed its result
 * through here and propagate the verdict upward as a `warning` so the user
 * can see it on the card and paste it back for debugging — instead of the
 * pipeline silently returning zero items.
 *
 * Detection layers (in order, most specific first):
 *   1. HTTP status (403/429/503 are tells)
 *   2. Final-URL pattern (captcha / challenge / signin paths)
 *   3. Body-keyword sniff (Cloudflare interstitial, eBay "Pardon Our
 *      Interruption", PerimeterX, generic "access denied"/"unusual
 *      traffic", etc.)
 *   4. Volume sanity check (response far shorter than expected, or zero
 *      items extracted when the platform normally returns many)
 *
 * Returns { code, severity, evidence, suggestion } when something looks
 * off; null when the response looks clean. `severity` lets the UI choose
 * how loud to render (yellow = throttle, red = hard block).
 */

// ── Detection tuning ──────────────────────────────────────────────────────────
// Keyword-scan windows: how far into a body we look for block markers. Block
// interstitials always put their markers near the top, so these are structural
// "scan the head" bounds (not page-content thresholds) — kept fixed.
const HTML_SCAN_CHARS      = 5000;   // hard-block keyword sniff (captcha/403 pages replace the whole page, text is at the top)
const SOFT_GATE_SCAN_CHARS = 100000; // soft-gate keyword sniff — contribution gates appear alongside partial content
                                     // and are buried past large <head> sections (Glassdoor: "To restore your access"
                                     // appears at ~50-100KB into 775KB HTML, past the old 5000-char window)
const API_SCAN_CHARS       = 2000;   // raw API body keyword sniff
const SNIPPET_STRIP_MAX_CHARS = 3000000; // htmlTextSnippet: bound the <style>/<script> strip input.
                                     // Must exceed a full page (eBay SRPs are ~1.8MB with a >100KB
                                     // inline <style> in <head>) so the strip sees each block's close
                                     // tag; only guards against a pathologically huge body.

// Suspicious-empty ("soft block returns a stripped 200") thresholds. The body
// size is judged against the source's LEARNED typical good-response size when
// available (see expectedBodySize), else an absolute floor. The clamp keeps the
// threshold sane: never below MIN (full page HTML is always large, so this is a
// safe no-false-positive floor) and never above MAX (so a large-but-partial
// real page isn't mislabeled as a skeleton block).
const SUSPICIOUS_MIN_BYTES  = 2000;  // floor / fallback when there's no baseline
const SUSPICIOUS_MAX_BYTES  = 20000; // ceiling — a soft-block skeleton is rarely larger
const SUSPICIOUS_BODY_RATIO = 0.3;   // < 30% of the source's typical body = suspicious

// A served anti-bot wall replaces content, so an extractor that pulled at least
// this many records is proof real results came back — any body-keyword "block"
// hit (Layer 3) is then ambient page chrome (e.g. an always-loaded reCAPTCHA
// script that sites embed on every page), NOT a challenge served instead of the
// data. At/above this floor we skip the keyword sniff so a full result set is
// never mislabeled as a block. (HTTP-status and final-URL signals still apply —
// those can't co-occur with a healthy 200 result page anyway.)
const CONTENT_SERVED_MIN_ITEMS = 3;

// Soft gates — contribution / account walls that appear ALONGSIDE partial
// content rather than replacing it entirely. Unlike captchas, these don't zero
// out the extractor, so they're checked BEFORE the contentServed guard.
// Severity 'block' so the hub pauses and shows a Solve card: user opens the
// page, fulfills the requirement, and the now-ungated page is re-extracted
// inline by the resolve window (same flow as captcha resolve).
const SOFT_GATE_SIGNALS = [
  // Glassdoor "write a review / add a salary" contribution gate. Shows as an
  // overlay on search results: the extractor still finds jobs from __NEXT_DATA__
  // but "Show more" is hidden and only ~5 results come through. The resolve
  // window opens two tabs: Tab 1 stays on the job search URL for polling; Tab 2
  // (same URL) is where the user clicks "Write a Review" / "Add a Salary" and
  // completes the form. After submitting, the user switches to Tab 1, refreshes,
  // and the now-ungated full result set is captured automatically.
  { pat: /to restore your access|write a review.{0,30}(?:see|access|unlock|view)|add a salary.{0,30}(?:see|access|unlock|view)/i,
    code: 'glassdoor-review-gate',
    severity: 'block',
    openSecondTab: true,
    suggestion: 'Glassdoor limited the automated fetch. Click Solve — a browser opens on the Glassdoor results and USUALLY loads the full list on its own, then closes; you don\'t need to do anything. ONLY if you see a "write a review / add a salary to continue" wall, use Tab 2 to satisfy it, then switch to Tab 1 and refresh.' },
];

const KEYWORD_SIGNALS = [
  // Cloudflare interstitials — includes both interactive challenges ("Just a
  // moment…") and hard Ray-ID blocks ("Additional Verification Required").
  { pat: /just a moment\s*\.\.\.|checking your browser|cf-challenge|cf-browser-verification|cf_chl_|additional verification required/i,
    code: 'cloudflare-challenge',
    severity: 'block',
    suggestion: 'Cloudflare anti-bot. Switching to puppeteer-stealth with a longer waitFor and a real Chrome may bypass; for high-volume scrapes consider a residential proxy.' },

  // PerimeterX / HUMAN
  { pat: /perimeterx|px-captcha|_pxhd|_pxvid|please verify you are a human|human verification challenge|press & hold/i,
    code: 'perimeterx-challenge',
    severity: 'block',
    suggestion: 'PerimeterX/HUMAN challenge. This source is hardened; the scraper needs a residential proxy + slower request pacing or it should be swapped for an official API.' },

  // eBay-specific
  { pat: /pardon our interruption|are you a human/i,
    code: 'ebay-anti-bot',
    severity: 'block',
    suggestion: 'eBay anti-bot interstitial. Slow request rate per session, or rotate to a fresh stealth profile.' },

  // Akamai bot manager
  { pat: /reference&nbsp;#|akamai|bot manager has detected/i,
    code: 'akamai-block',
    severity: 'block',
    suggestion: 'Akamai Bot Manager. Often defeated by a real browser session + warm cookies; otherwise needs proxy rotation.' },

  // DataDome
  { pat: /datadome|geo\.captcha-delivery\.com|please enable js and disable any ad blocker/i,
    code: 'datadome-block',
    severity: 'block',
    suggestion: 'DataDome challenge. Hard to bypass without a residential proxy; consider an official API if available.' },

  // CAPTCHA (generic) — only count rendered challenge/widget markers, not
  // ambient bot-scoring scripts. Many normal pages load reCAPTCHA Enterprise
  // or hCaptcha assets in the background without presenting a challenge.
  { pat: /class=["'][^"']*\bg-recaptcha\b|data-sitekey=|recaptcha challenge expires|i am not a robot|please (?:complete|solve).{0,40}captcha|hcaptcha-box|cf-turnstile/i,
    code: 'captcha-presented',
    severity: 'block',
    suggestion: 'CAPTCHA was served instead of content. Manual solve via a visible browser window or rotate session.' },

  // Generic access-denied / rate-limit copy
  { pat: /access denied|you do?n.?t have permission|forbidden by/i,
    code: 'access-denied',
    severity: 'block',
    suggestion: 'Server refused the request. Likely IP- or fingerprint-based block.' },
  { pat: /unusual (traffic|activity) from your (computer|network|device)|automated requests/i,
    code: 'unusual-traffic',
    severity: 'throttle',
    suggestion: 'Source flagged this session as automated. Pause this source for a few minutes; try again with a cleared profile if it persists.' },
  { pat: /rate.?limit|too many requests|slow down/i,
    code: 'rate-limited',
    severity: 'throttle',
    suggestion: 'Soft rate limit. Reduce concurrency for this source or add a delay between requests.' },

  // Sign-in walls on what should be a public page
  { pat: /sign in to continue|please sign in to view|log in to (continue|view)/i,
    code: 'sign-in-wall',
    severity: 'block',
    suggestion: 'A public data page is asking for sign-in — usually the result of an anti-bot fingerprint, not an actual auth requirement. Try a fresh stealth profile.' },
];

const URL_SIGNALS = [
  { pat: /\/(captcha|challenge|interstitial|block|denied|errors\/blocked)/i,
    code: 'redirected-to-challenge',
    severity: 'block',
    suggestion: 'Final URL is a challenge / block path. The originating request was rejected before content was served.' },
];

// ── Explicit "zero results" sentinels ─────────────────────────────────────────
// Phrases a site renders in its OWN empty-state when a search legitimately
// matched nothing — e.g. Swappa sells only electronics, so a guitar query returns
// "No products match this criteria" / "Showing 0 results". That is NOT a block,
// NOT stale selectors, and NOT a wrong-URL picker — it is the site's authoritative
// "0 results" answer. Detecting it lets the volume-sanity layer return null
// instead of a spurious 'zero-extracted' throttle, which otherwise surfaces a
// Solve card, a rate-limiter penalty, and a 30s captcha-resolve grace window for a
// page that simply has nothing to show. Every pattern pairs a result-NOUN with an
// empty QUALIFIER (or a literal 0 count), so it cannot match a populated results
// page. The generic ones reuse the battle-tested empty-state copy already shipped
// in electron/extractors/jobs.js. Exported for reuse by the captcha-resolve window
// (authWindows.js), which concludes immediately on a definitive empty page rather
// than holding the full human-scale grace.
const NO_RESULTS_SENTINELS = [
  // Swappa: "<h2>No products match this criteria ...</h2>"
  /no products? match(?:es)? this (?:criteria|search)/i,
  // "Showing 0 results" / "Showing <b>0</b> results" — entity/tag-tolerant 0.
  /showing\s*(?:<[^>]+>\s*)*0(?:\s*<\/[^>]+>)*\s*(?:results?|listings?|items?|products?)/i,
  // "0 results found" / "0 listings match".
  /\b0 (?:results?|listings?|jobs?|items?|products?) (?:found|match)/i,
  // Generic "no <thing> found/matched/available" within a single text run.
  /\bno (?:results?|listings?|items?|products?|jobs?|matches)\b[^<]{0,40}\b(?:found|match|matched|available)\b/i,
  // "we couldn't find any …" / "did not find any …".
  /\b(?:we )?(?:could ?n.?t|did(?: not|n.?t)) find any\b/i,
  // "Your search did not match any …".
  /your search (?:did not|did ?n.?t) match any/i,
  // eBay's empty SRP: count heading "<b>0</b> results for <query>" + the dedicated
  // null-search block "No exact matches found". Neither matched the generic patterns
  // above — "0 results for" lacks a trailing found/match, and "no exact matches" puts
  // a word between "no" and "matches". On innerText (the Solve-window path) both read
  // contiguously; in raw HTML the null-search heading text is the reliable catch.
  /\b0 results? for\b/i,
  /\bno exact match(?:es)? found\b/i,
];

/**
 * True if `text` contains a site's own definitive "zero results" empty-state copy.
 * Used by the volume-sanity gate below AND by the captcha-resolve window to tell a
 * genuinely-empty page apart from a soft block.
 * @param {string} text  HTML body OR innerText (patterns are tag-tolerant)
 * @returns {boolean}
 */
export function matchesNoResultsSentinel(text) {
  if (!text) return false;
  const body = String(text).slice(0, SOFT_GATE_SCAN_CHARS);
  return NO_RESULTS_SENTINELS.some((re) => re.test(body));
}

// Strip tags + collapse whitespace into a short readable snippet of a page's
// visible text. Appended to volume-sanity evidence so a bug report can tell WHY a
// page came back empty — the site's own "0 results" copy, a model-picker's tiles
// ("Select your model…"), or real listings the extractor missed (= drift) —
// WITHOUT the user having to paste the page HTML (the gap that made the "stuck on
// Swappa" report un-diagnosable from the report alone).
export function htmlTextSnippet(html, maxChars = 220) {
  if (!html) return '';
  // Strip non-visible blocks (script/style/noscript) BEFORE bounding the window.
  // eBay-class pages carry a >100KB inline <style> in <head>; slicing to a small
  // window first would cut off its closing </style>, the non-greedy strip would
  // never match the orphaned open tag, and raw CSS would leak into the snippet —
  // defeating the field meant to tell genuine-empty / model-picker / selector-
  // drift apart. The strip input is bounded so a huge body can't stall this
  // (error-path-only) diagnostic; it just needs to exceed one full page.
  return String(html)
    .slice(0, SNIPPET_STRIP_MAX_CHARS)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ') // drop non-visible blocks
    .replace(/<[^>]+>/g, ' ')                                 // strip tags
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')          // crude entity strip
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/**
 * @param {object} ctx
 * @param {number} [ctx.status]              HTTP status (0 if unknown)
 * @param {string} [ctx.finalUrl]            URL after redirects
 * @param {string} [ctx.html]                Response body (raw HTML or stripped text — both work)
 * @param {number} [ctx.itemsExtracted]      How many records the extractor produced (null if N/A)
 * @param {number} [ctx.expectedMinItems]    Floor below which "zero or near-zero" is suspicious (default 0 — set to e.g. 5 for established platforms)
 * @param {number} [ctx.expectedBodySize]    This source's LEARNED typical good-response body size (chars); 0/absent → use the absolute floor
 * @param {string} [ctx.sourceLabel]         For the evidence string ("eBay Sold", "LinkedIn", etc.)
 * @param {object} [ctx.yieldStats]          Extractor health: { seen, noFields, claimedTotal? } — lets a sub-floor count be recognized as a genuinely-thin query (not a block) rather than firing a false zero-extracted + unclearable Solve
 * @returns {null | {code, severity, evidence, suggestion}}
 */
export function detectAntiBotSignal(ctx = {}) {
  const { status = 0, finalUrl = '', html = '', itemsExtracted = null, expectedMinItems = 0, expectedBodySize = 0, sourceLabel = '', yieldStats = null } = ctx;
  const label = sourceLabel ? `[${sourceLabel}] ` : '';

  // Layer 1 — HTTP status
  if (status === 403) {
    return {
      code: 'http-403',
      severity: 'block',
      evidence: `${label}HTTP 403 from ${finalUrl || 'request URL'}`,
      suggestion: 'Server forbid the request outright. IP- or UA-based block; switch profile or proxy.',
    };
  }
  if (status === 429) {
    return {
      code: 'http-429',
      severity: 'throttle',
      evidence: `${label}HTTP 429 from ${finalUrl || 'request URL'}`,
      suggestion: 'Rate limit hit. Back off this source for a few minutes and reduce parallelism.',
    };
  }
  if (status === 503) {
    return {
      code: 'http-503',
      severity: 'block',
      evidence: `${label}HTTP 503 from ${finalUrl || 'request URL'} — often a Cloudflare/anti-bot interstitial`,
      suggestion: 'Likely an anti-bot challenge page returning 503. Check body for cf-challenge markers; may need stealth + waitFor.',
    };
  }

  // Layer 2 — URL pattern
  if (finalUrl) {
    for (const s of URL_SIGNALS) {
      if (s.pat.test(finalUrl)) {
        return {
          code: s.code,
          severity: s.severity,
          evidence: `${label}Final URL ${finalUrl} matched ${s.code}`,
          suggestion: s.suggestion,
        };
      }
    }
  }

  // Layer 2.5 — soft gate scan (runs before contentServed check).
  // These gates appear alongside partial content, so checking them only when
  // itemsExtracted < CONTENT_SERVED_MIN_ITEMS would miss them. Uses a larger
  // window than the hard-block scan because soft-gate text is buried past the
  // site's <head> section (Glassdoor's review gate appears at ~50-100KB).
  if (html) {
    const head = String(html).slice(0, SOFT_GATE_SCAN_CHARS);
    for (const s of SOFT_GATE_SIGNALS) {
      const m = head.match(s.pat);
      if (m) {
        return {
          code: s.code,
          severity: s.severity,
          evidence: `${label}body contained "${(m[0] || '').slice(0, 80)}" (${s.code})`,
          suggestion: s.suggestion,
          ...(s.openSecondTab ? { openSecondTab: true } : {}),
        };
      }
    }
  }

  // Layer 3 — body keyword sniff. Scope to the head so a legitimate listing
  // that happens to mention "captcha" deep in nav chrome doesn't false-positive.
  //
  // Skip entirely when the extractor returned a healthy item count: a real wall
  // serves the challenge INSTEAD of content, so if we got a full result set the
  // keyword matched ambient chrome (a reCAPTCHA/hCaptcha script the site loads
  // on every page), not a block. Without this gate, e.g. Mercari — which embeds
  // grecaptcha on every search page — gets its 20 returned sold comps mislabeled
  // as a hard "captcha-presented" block, triggering a phantom Solve prompt and
  // an unwarranted rate-limiter penalty.
  const contentServed = itemsExtracted != null && itemsExtracted >= CONTENT_SERVED_MIN_ITEMS;
  if (html && !contentServed) {
    const head = String(html).slice(0, HTML_SCAN_CHARS);
    for (const s of KEYWORD_SIGNALS) {
      const m = head.match(s.pat);
      if (m) {
        return {
          code: s.code,
          severity: s.severity,
          evidence: `${label}body contained "${(m[0] || '').slice(0, 80)}" (${s.code})`,
          suggestion: s.suggestion,
        };
      }
    }
  }

  // Layer 3.5 — explicit empty state. A page where the SITE ITSELF declares zero
  // matches (its own empty-state copy, e.g. Swappa "No products match this
  // criteria" / "Showing 0 results") must NOT fire a throttle: no Solve card, no
  // rate-limiter penalty, no captcha-resolve grace window. Guarded by the SAME
  // low-count condition Layer 4 uses, so it can only ever short-circuit the empty
  // path — a real block that co-occurs with results has items above the threshold
  // and never reaches here, and Layer 3 (block keywords) has already returned for a
  // challenge served instead of content, so a block page that also says "no
  // results" still loses to the block verdict. A drifted listings page (results
  // present, extractor got 0) shows the listings, NOT this copy, so drift is still
  // caught.
  if (itemsExtracted != null && expectedMinItems > 0 && itemsExtracted < expectedMinItems
      && matchesNoResultsSentinel(html)) {
    return null; // the site's own "0 results" — genuinely empty, not suspicious
  }

  // Layer 3.6 — extractor-health / site-declared-count gate. A sub-floor item
  // count is only a block/drift tell if the SCRAPE FAILED. Two independent proofs
  // that it instead SUCCEEDED on a genuinely-thin query — where a Solve card would
  // be unclearable because there is no wall to clear — short-circuit to null:
  //   (a) the site's OWN result-count header (eBay's "1 result"): we extracted
  //       everything it claims (itemsExtracted >= claimedTotal), or it claims fewer
  //       than the floor. Immune to selector drift — a drifted page reads "50
  //       results" while we got 1, so neither test passes and it still warns below.
  //   (b) no count header: the extractor saw exactly as many cards as it returned
  //       and none were malformed (seen === itemsExtracted, noFields === 0) — the
  //       page genuinely had that few listings, not silently-dropped ones.
  if (itemsExtracted != null && expectedMinItems > 0 && itemsExtracted < expectedMinItems && yieldStats) {
    const claimed = Number(yieldStats.claimedTotal);
    if (Number.isFinite(claimed) && claimed >= 0) {
      // (a) The site declares its own total — authoritative, and takes EXCLUSIVE
      // precedence: suppress only if we extracted everything it claims, or it
      // genuinely has fewer than the floor. A drifted page (claims 50, we got 1)
      // fails both and still warns below — we do NOT fall through to the seen
      // heuristic, which a drift-induced low `seen` would otherwise fool.
      if (itemsExtracted >= claimed || claimed < expectedMinItems) return null;
    } else {
      // (b) No count header: fall back to extractor health. seen === extracted
      // with no malformed cards = the page genuinely had that few listings.
      const { seen, noFields } = yieldStats;
      if (Number.isInteger(seen) && Number.isInteger(noFields)
          && noFields === 0 && seen === itemsExtracted && seen > 0) {
        return null;
      }
    }
  }

  // Layer 4 — volume sanity. Triggered only when caller passes a threshold;
  // a generic zero-results on a long-tail query is not suspicious by itself.
  if (itemsExtracted != null && expectedMinItems > 0 && itemsExtracted < expectedMinItems) {
    const htmlLen = html ? String(html).length : 0;
    // Sometimes a soft block returns a stripped-down 200 OK with no items and a
    // small body. Judge "small" against this source's learned typical body size
    // when we have one (catches a styled block page that's still bigger than a
    // flat byte floor); otherwise fall back to the absolute floor. Clamped so
    // the threshold is never below the floor or above a skeleton-sized ceiling.
    const suspiciousBelow = expectedBodySize > 0
      ? Math.min(SUSPICIOUS_MAX_BYTES, Math.max(SUSPICIOUS_MIN_BYTES, Math.round(expectedBodySize * SUSPICIOUS_BODY_RATIO)))
      : SUSPICIOUS_MIN_BYTES;
    // Always stamp the landing URL: a 0-item result on a BIG body where the
    // finalUrl isn't the expected results page is almost never selector rot —
    // it's the scraper landing on a product-picker / disambiguation / login /
    // interstitial page (e.g. Swappa's /search?q= is a model-picker, not a
    // listings page). Without finalUrl in the evidence, "0 items" can't tell
    // those apart, and a bug report shows a confusing "good on the site, 0 here."
    const where = finalUrl ? ` [finalUrl=${finalUrl}]` : '';
    // A snippet of the page's visible text disambiguates the three reasons a page
    // comes back with 0 items (genuine empty / model-picker / real drift) so the
    // bug report is self-diagnosing. Genuine "0 results" pages are already caught
    // by Layer 3.5 above, so the snippet here mostly clarifies picker-vs-drift.
    const snippet = htmlTextSnippet(html);
    const snippetEvidence = snippet ? ` · page text: "${snippet}"` : '';
    if (htmlLen < suspiciousBelow) {
      const vs = expectedBodySize > 0 ? ` (typical ~${Math.round(expectedBodySize)})` : '';
      return {
        code: 'suspicious-empty',
        severity: 'throttle',
        evidence: `${label}returned ${itemsExtracted} items with only ${htmlLen} chars of body${vs}${where}${snippetEvidence}`,
        suggestion: 'Response was suspiciously small AND empty of items. Most likely a soft block; retry with a fresh profile.',
      };
    }
    return {
      code: 'zero-extracted',
      severity: 'throttle',
      evidence: `${label}extractor produced ${itemsExtracted} items (expected ≥ ${expectedMinItems}) from ${htmlLen} chars of body${where}${snippetEvidence}`,
      suggestion: 'Extractor produced fewer items than expected. The body is NOT tiny, so this is not a hard block — check finalUrl + the page-text snippet: if it shows model tiles/disambiguation the scraper landed on a picker page (wrong URL); if it shows real listings the selectors drifted; if it states "0 results" it is genuinely empty (should have been caught upstream).',
    };
  }

  return null;
}

// ── API-side detection ──────────────────────────────────────────────────────
// The HTML-shaped detector above misses JSON/REST API blocks because APIs
// don't serve Cloudflare interstitials — they serve 429s and JSON error
// bodies. detectApiAntiBotSignal is the parallel detector for those.

const API_JSON_ERROR_PATTERNS = [
  { pat: /rate.?limit|too many requests|quota.{0,10}(exceed|reach)|throttl/i,
    code: 'api-rate-limit',
    severity: 'throttle',
    suggestion: 'API soft rate limit. Reduce request frequency or wait several minutes before retry.' },
  { pat: /forbidden|access.?denied|blocked|not authoriz|insufficient.{0,10}permis/i,
    code: 'api-access-denied',
    severity: 'block',
    suggestion: 'API rejected the request outright. Check the auth token / API key, or this IP may be banlisted.' },
  { pat: /captcha|prove you.{0,10}human|verification required/i,
    code: 'api-captcha',
    severity: 'block',
    suggestion: 'API is asking for a CAPTCHA — usually means we tripped a bot rule. Manual session refresh required.' },
];

/**
 * @param {object} ctx
 * @param {number} [ctx.status]          HTTP status
 * @param {string} [ctx.bodyText]        Response body as raw text
 * @param {any}    [ctx.bodyJson]        Parsed JSON if available
 * @param {number} [ctx.itemsReturned]   Items the parser produced (null if N/A)
 * @param {string} [ctx.sourceLabel]
 * @returns {null | {code, severity, evidence, suggestion}}
 */
export function detectApiAntiBotSignal(ctx = {}) {
  const { status = 0, bodyText = '', bodyJson = null, sourceLabel = '' } = ctx;
  const label = sourceLabel ? `[${sourceLabel}] ` : '';

  // HTTP status first — APIs are very clear with these codes.
  if (status === 429) {
    return { code: 'http-429', severity: 'throttle',
      evidence: `${label}API returned HTTP 429`,
      suggestion: 'Rate limit hit. Back off this source for several minutes.' };
  }
  if (status === 403) {
    return { code: 'http-403', severity: 'block',
      evidence: `${label}API returned HTTP 403`,
      suggestion: 'API refused the request. Check API key / auth header; this IP or token may be blocked.' };
  }
  if (status === 503) {
    return { code: 'http-503', severity: 'block',
      evidence: `${label}API returned HTTP 503`,
      suggestion: 'Service unavailable / Cloudflare in front of the API. Retry in a few minutes; persistent → proxy.' };
  }
  if (status === 401) {
    return { code: 'http-401', severity: 'block',
      evidence: `${label}API returned HTTP 401`,
      suggestion: 'Auth failed. The configured API key is missing, expired, or revoked.' };
  }

  // JSON error body inspection — many APIs return 200 with { error: "..." }
  // for soft errors. Walk a few common locations: top-level error, message,
  // detail, or a nested errors[].
  const candidateStrings = [];
  if (bodyJson) {
    const push = (v) => { if (typeof v === 'string') candidateStrings.push(v); };
    push(bodyJson.error);
    push(bodyJson.message);
    push(bodyJson.detail);
    push(bodyJson.error_description);
    if (typeof bodyJson.error === 'object' && bodyJson.error) {
      push(bodyJson.error.message);
      push(bodyJson.error.code);
    }
    if (Array.isArray(bodyJson.errors)) {
      for (const e of bodyJson.errors) {
        if (typeof e === 'string') push(e);
        else if (e && typeof e === 'object') { push(e.message); push(e.code); push(e.detail); }
      }
    }
  }
  // Also sniff the raw body — useful when an API responds with HTML on block
  // (Cloudflare interstitial returned with text/html instead of JSON).
  if (bodyText) candidateStrings.push(String(bodyText).slice(0, API_SCAN_CHARS));

  for (const s of candidateStrings) {
    for (const p of API_JSON_ERROR_PATTERNS) {
      const m = s.match(p.pat);
      if (m) {
        return {
          code: p.code,
          severity: p.severity,
          evidence: `${label}body matched "${(m[0] || '').slice(0, 80)}" (${p.code})`,
          suggestion: p.suggestion,
        };
      }
    }
  }

  return null;
}

/**
 * Thin fetch wrapper that returns the response context plus an anti-bot
 * verdict. Lets each fetcher say `const { ok, json, warning } = await
 * safeApiFetch(url, opts, 'remoteok')` instead of duplicating
 * status/body/detection boilerplate across nine functions.
 */
export async function safeApiFetch(url, opts = {}, sourceLabel = '') {
  try {
    const res = await fetch(url, opts);
    const status = res.status;
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    // Two-pass detection: try the API-shaped detector first (catches HTTP
    // status + JSON error envelopes + rate-limit copy). If it returns
    // null AND the body looks like HTML, fall back to the HTML detector
    // — useful for "API" endpoints like LinkedIn's job-search that
    // actually return HTML, which means a block looks like a Cloudflare
    // interstitial rather than a JSON error.
    let warning = detectApiAntiBotSignal({ status, bodyText: text, bodyJson: json, sourceLabel });
    if (!warning && !json && text && /<html|<!doctype/i.test(text.slice(0, 200))) {
      warning = detectAntiBotSignal({ status, finalUrl: url, html: text, sourceLabel });
    }
    return { ok: res.ok, status, text, json, warning };
  } catch (error) {
    // Network/timeout/abort — surface as a throttle-level warning so the
    // user sees something rather than silent zero. Aborts (user cancel)
    // are not anti-bot signals; the caller can filter those upstream.
    const msg = error?.message || String(error);
    const isAbort = /abort/i.test(msg) || error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      error,
      warning: isAbort ? null : {
        code: 'api-fetch-failed',
        severity: 'throttle',
        evidence: `[${sourceLabel}] fetch threw: ${msg.slice(0, 200)}`,
        suggestion: 'Network error talking to the API. Often transient; if it persists, the source may be down or blocking us at the network layer.',
      },
    };
  }
}
