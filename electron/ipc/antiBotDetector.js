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
const HTML_SCAN_CHARS = 5000; // HTML body keyword sniff
const API_SCAN_CHARS  = 2000; // raw API body keyword sniff

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

const KEYWORD_SIGNALS = [
  // Cloudflare interstitials
  { pat: /just a moment\s*\.\.\.|checking your browser|cf-challenge|cf-browser-verification|cf_chl_/i,
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

  // CAPTCHA (generic)
  { pat: /\b(captcha|recaptcha|hcaptcha)\b|g-recaptcha|grecaptcha\.execute/i,
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

/**
 * @param {object} ctx
 * @param {number} [ctx.status]              HTTP status (0 if unknown)
 * @param {string} [ctx.finalUrl]            URL after redirects
 * @param {string} [ctx.html]                Response body (raw HTML or stripped text — both work)
 * @param {number} [ctx.itemsExtracted]      How many records the extractor produced (null if N/A)
 * @param {number} [ctx.expectedMinItems]    Floor below which "zero or near-zero" is suspicious (default 0 — set to e.g. 5 for established platforms)
 * @param {number} [ctx.expectedBodySize]    This source's LEARNED typical good-response body size (chars); 0/absent → use the absolute floor
 * @param {string} [ctx.sourceLabel]         For the evidence string ("eBay Sold", "LinkedIn", etc.)
 * @returns {null | {code, severity, evidence, suggestion}}
 */
export function detectAntiBotSignal(ctx = {}) {
  const { status = 0, finalUrl = '', html = '', itemsExtracted = null, expectedMinItems = 0, expectedBodySize = 0, sourceLabel = '' } = ctx;
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
    if (htmlLen < suspiciousBelow) {
      const vs = expectedBodySize > 0 ? ` (typical ~${Math.round(expectedBodySize)})` : '';
      return {
        code: 'suspicious-empty',
        severity: 'throttle',
        evidence: `${label}returned ${itemsExtracted} items with only ${htmlLen} chars of body${vs}${where}`,
        suggestion: 'Response was suspiciously small AND empty of items. Most likely a soft block; retry with a fresh profile.',
      };
    }
    return {
      code: 'zero-extracted',
      severity: 'throttle',
      evidence: `${label}extractor produced ${itemsExtracted} items (expected ≥ ${expectedMinItems}) from ${htmlLen} chars of body${where}`,
      suggestion: 'Extractor produced fewer items than expected. The body is NOT tiny, so this is not a hard block — check finalUrl: if it is not the expected results page, the scraper landed on a picker/disambiguation/login/interstitial page (wrong URL), not stale selectors. If it IS the right page, the layout changed.',
    };
  }

  return null;
}

/**
 * Human-friendly one-liner for embedding in a card's status text.
 * Format: "⚠️ <code>: <evidence> — <suggestion>"
 */
export function formatAntiBotWarning(signal) {
  if (!signal) return '';
  const icon = signal.severity === 'block' ? '⛔' : '⚠️';
  return `${icon} ${signal.code}: ${signal.evidence} — ${signal.suggestion}`;
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
