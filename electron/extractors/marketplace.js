/**
 * Marketplace Price Comparison Extractors + Site Configs.
 *
 * Each platform has ONE best strategy (highest-signal source: JSON state > DOM).
 * If it returns 0 results, the extractor throws SITE_CHANGED — surfaced as a
 * 'stale-selectors' warning so the user is told to update the code rather than
 * silently getting 0 comps. No fallback chains.
 *
 * Exceptions: Swappa (0 = no model match, not broken),
 *             PriceCharting (niche games source, 0 is valid for non-games).
 *
 * StockX and Reverb use direct API calls in apiExtractors.js.
 *
 * All extractors return the standard comp shape:
 *   { title, price, priceText, url, source, soldDate?, condition?, seller? }
 */

// ── SITE_CHANGED diagnostic (page-context) ──────────────────────────────────
// Interpolated into each extractor's throw site and invoked ONLY when extraction
// already returned 0 — so it can never affect a successful scrape. It captures
// the cheap, decisive facts the extractor has in hand at throw time, which the
// thrown message (and thus the bug report's stale-selectors warning) otherwise
// discards: the page path, title, a body-size proxy, and a login-wall flag. The
// caller passes source-specific candidate counts in `extra` (e.g.
// "cards=48 titleSel=0").
//
// This is what lets a report tell apart the two causes of a 0-result scrape that
// "selectors may have changed" alone cannot — a user pasting the page HTML was
// the only way before:
//   • cards=0 (+ LOGIN-WALL / tiny bodyLen) → not logged in / empty anon page,
//     NOT a code bug — log in and retry.
//   • cards=N>0 but our sub-selector matched 0 (e.g. titleSel=0) → a genuine
//     redesign; the candidate count + which sub-selector broke says what to fix.
//
// `sampleEl` (optional) — the first matched candidate card. When given, the diag
// appends `card0=[…]`: the distinct CSS class tokens on that card and its
// descendants (capped). That's the NEW markup's actual class names, so a selector
// rewrite can be derived from the bug report alone — the user never has to paste
// page HTML even when the broken sub-selector's replacement is unknown.
const SITE_CHANGED_DIAG = `(function(extra, sampleEl){
  try {
    var path = location.pathname || '';
    var title = (document.title || '').replace(/\\s+/g, ' ').slice(0, 40);
    var bodyLen = ((document.body && document.body.textContent) || '').length;
    // Visible-text HEAD snippet — the single highest-value field when 0 known
    // selectors match: it reveals whether the page is a real (but re-laid-out)
    // results page, an anti-bot / "verify you're human" wall, a logged-out
    // prompt, or a model-picker, NONE of which the selector COUNTS can tell apart.
    // innerText (not textContent) so a site's huge inline <style>/<script> head
    // (eBay SRPs carry a >100KB inline <style>) doesn't drown out the visible copy.
    // ES5-safe (stringified into page.evaluate); bounded slice-then-collapse so it
    // can't stall on a pathological body, and " → ' so the bodyHead="..." wrapper stays readable.
    var bodyHead = '';
    try {
      var __bt = (document.body && (document.body.innerText || document.body.textContent)) || '';
      bodyHead = __bt.slice(0, 8000).replace(/\\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 200);
    } catch (e2) {}
    var loginWall = /login|signin|sign-in/i.test(path)
      || !!document.querySelector('input[type=password]')
      || /\\b(log ?in|sign ?in)\\b/i.test(document.title || '');
    var skel = '';
    if (sampleEl) {
      var seen = {}, toks = [];
      var els = [sampleEl].concat(Array.prototype.slice.call(sampleEl.querySelectorAll('*')));
      for (var i = 0; i < els.length && toks.length < 22; i++) {
        var cn = (typeof els[i].className === 'string' ? els[i].className : '');
        var parts = cn.split(/\\s+/);
        for (var j = 0; j < parts.length; j++) {
          var t = parts[j];
          if (t && !seen[t]) { seen[t] = 1; toks.push(t); }
        }
      }
      if (toks.length) skel = ' card0=[' + toks.join(' ').slice(0, 240) + ']';
    }
    return ' [diag ' + (extra ? extra + ' ' : '') + 'path=' + path
      + ' title="' + title + '" bodyLen=' + bodyLen
      + (bodyHead ? ' bodyHead="' + bodyHead + '"' : '')
      + (loginWall ? ' LOGIN-WALL/anon-page' : '') + skel + ']';
  } catch (e) { return ' [diag-failed]'; }
})`;

// Safe price parse for the page-context display-text extractors (injected the
// same way as SITE_CHANGED_DIAG). The naive `parseFloat(text.replace(/[^0-9.]/g,
// ''))` is a footgun: it strips every non-digit/non-dot char and FUSES any second
// number in the same node onto the price. A Mercari on-sale card renders the
// current price AND the strikethrough original together ("$274.55" + "$315" →
// "274.55315"; a whole-dollar "$110" + "$199" → a catastrophic "110199"), and an
// eBay "$10 to $20" range → "1020". This strips commas/spaces, then captures only
// the FIRST money token with decimals capped at 2 (`\\d{1,2}`), so the leading
// current/low price survives and a trailing original/range/count can't corrupt it.
// Mirrors parsePriceChartingHtml's inline parsePrice (apiExtractors.js). Returns 0 on no match.
const MONEY_PARSE_FN = `(function(txt){
  if (!txt) return 0;
  var m = String(txt).replace(/[,\\s]/g, '').match(/\\$?(\\d+(?:\\.\\d{1,2})?)/);
  return m ? (parseFloat(m[1]) || 0) : 0;
})`;

// Shared empty-guard for EBAY_SOLD_EXTRACTOR / EBAY_ACTIVE_EXTRACTOR: both were
// hand-duplicating this ~40-line block verbatim (only the throw message's
// label differed). Reads eBay's own "N results" count-heading BEFORE deciding
// 0 extracted is real drift vs a genuinely-thin/empty query (see SITE_CHANGED_DIAG
// for why), widens the diagnostic sample to every known alternate eBay card
// family, and throws SITE_CHANGED with the full diag on a non-empty-query 0.
// Returns { empty: true, claimedTotal: 0 } for a genuine empty result so the
// caller can return its own yieldStats shape; on a non-empty extract it
// returns { empty: false, claimedTotal } for the caller to include in its stats.
const EBAY_EMPTY_GUARD_FN = `(function(label, cards, items, diagFn){
  var claimedTotal = null;
  try {
    var ch = document.querySelector('.srp-controls__count-heading');
    var m = ch && (ch.textContent || '').match(/([\\d,]+)\\s*\\+?\\s*results?\\b/i);
    if (m) { var n = parseInt(m[1].replace(/,/g, ''), 10); if (isFinite(n)) claimedTotal = n; }
  } catch (e) {}
  if (items.length > 0) return { empty: false, claimedTotal: claimedTotal };
  // eBay itself reports 0 results (rare/obscure query, no exact matches) → a
  // GENUINE empty, not a site change. Two independent signals, either decisive:
  //   • count heading reads 0 ("<b>0</b> results for X"), OR
  //   • eBay rendered its dedicated null-search block (.srp-save-null-search →
  //     "No exact matches found") — robust when the count-heading regex misses.
  if (claimedTotal === 0 || document.querySelector('.srp-save-null-search')) {
    return { empty: true, claimedTotal: 0 };
  }
  // Widen the diagnostic sample to the KNOWN alternate eBay card families so a
  // 0-card page still yields a card0=[…] class skeleton to rewrite against.
  // Purely for the SITE_CHANGED diag — NOT an extraction fallback (a blind
  // alternate-container extract would let ghost/promo/watchlist tiles poison the
  // comp set → wrong FMV, with no live test to catch it). Last resort: the LI/DIV
  // ancestor of the first real listing link, so even a foreign container is fingerprinted.
  var diagSample = cards[0]
    || document.querySelector('.su-item-card, li.s-card, .s-card, .srp-results li, [data-testid="item-card"], .s-item, .brwrvr__item-card, .su-card-container, ul.srp-results > li')
    || (document.querySelector('a[href*="/itm/"]') && document.querySelector('a[href*="/itm/"]').closest('li, div'));
  var diagCounts = [
    'cards=' + cards.length,
    // Current (2026-07) div-based card + its two differently-shaped result
    // containers (sold = div.srp-river-main, active = ul.su-grid--is-list).
    'suItemCard=' + document.querySelectorAll('.su-item-card').length,
    'srpRiverMain=' + document.querySelectorAll('.srp-river-main').length,
    'suGridList=' + document.querySelectorAll('.su-grid--is-list').length,
    'titleSel2=' + document.querySelectorAll('.su-item-card__title').length,
    'priceSel2=' + document.querySelectorAll('.su-item-card__price').length,
    // Pre-2026-07 (li.s-card) markers — kept so a report can tell which
    // generation of redesign it's looking at instead of just "still 0".
    'srp=' + document.querySelectorAll('.srp-results').length,
    'srpLi=' + document.querySelectorAll('.srp-results li').length,
    'liSCard=' + document.querySelectorAll('li.s-card').length,
    'anySCard=' + document.querySelectorAll('.s-card').length,
    'titleSel=' + document.querySelectorAll('.srp-results li.s-card span.su-styled-text.primary').length,
    'sCardTitle=' + document.querySelectorAll('.s-card__title').length,
    'priceSel=' + document.querySelectorAll('.s-card__price').length,
    // Alternate-layout markers: is eBay serving the OLD .s-item cards, the
    // browse-redesign .brwrvr card, or (itmLinks=0) NO listings at all
    // (→ a wall / logged-out / empty page, read bodyHead) vs listings present
    // in an unknown container (itmLinks>0 → targeted selector rewrite).
    'sItem=' + document.querySelectorAll('.s-item').length,
    'brw=' + document.querySelectorAll('.brwrvr__item-card').length,
    'itmLinks=' + document.querySelectorAll('a[href*="/itm/"]').length,
  ].join(' ');
  throw new Error('SITE_CHANGED: ' + label + ' su-styled-text extractor returned 0 — eBay design system may have changed' + diagFn(diagCounts, diagSample));
})`;

// Shared dedup-by-url for EBAY_SOLD_EXTRACTOR / EBAY_ACTIVE_EXTRACTOR — a
// promoted/related-item card can re-surface the same listing elsewhere on the
// same results page; without this, a duplicate silently doubles that
// listing's weight in the price the AI recommends.
const DEDUP_BY_URL_FN = `(function(items){
  var seen = new Set();
  return items.filter(function(i){
    // A card with no extractable link (malformed/edge-case markup) must never
    // be deduped against another such card — without this guard every item
    // missing a url collapses onto the empty-string/undefined "seen" entry
    // and all but the first are silently dropped, even though they're
    // unrelated listings that just happen to share "no url".
    if (!i.url) return true;
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
})`;

// ── Site Configurations ─────────────────────────────────────────────────────
// `timeoutMs` is a SEED / safety ceiling, not a fixed budget: scrapeBudget
// learns each source's typical time-to-ready and derives a tighter working
// timeout for fast sources (never looser than this seed). `waitMs` is now
// vestigial — the readiness-stabilization loop in browserPool decides when
// results are ready, and the pre-read beat is sized from learned timing.
//
// `expectedMinItems` arms the anti-bot detector's volume check (antiBotDetector
// Layer 4): if an established general/tech resale source returns fewer than this,
// it's flagged (block if the body is also tiny, else "extractor produced 0 — stale
// selectors or soft block"). Without it, a source silently returning 0 (e.g. a
// stale-selector Swappa) looks identical to a clean empty result. Set ONLY on
// broad sources that reliably have results for any real product — NOT on niche
// sources (PriceCharting = games, Reverb = instruments) where 0 is expected for
// off-category items and would false-positive.

export const EBAY_SOLD_CONFIG = {
  waitMs: 2500,
  timeoutMs: 40000,
  waitFor: '.srp-results li.s-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};

export const EBAY_ACTIVE_CONFIG = {
  waitMs: 2500,
  timeoutMs: 40000,
  waitFor: '.srp-results li.s-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};

export const POSHMARK_CONFIG = {
  waitMs: 3500,
  timeoutMs: 45000,
  waitFor: '[data-et-name="listing"], .card, .tile__covershot',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};

export const SWAPPA_CONFIG = {
  waitMs: 2500,
  timeoutMs: 30000,
  // /search renders the product picker (server-side, no scroll needed); the
  // extractor follows the best model link to /listings and reads Offer microdata.
  // Wait on either the picker's product links OR an Offer card (if we landed on a
  // listings page directly, e.g. in the Solve window).
  // Three-way OR: product links on the picker (products found), the container
  // itself (picker loaded but no matching products → genuine 0, skips the 8s
  // selector timeout), or an Offer card (direct listings page).
  waitFor: '#main_search_product_results a[href*="/listings/"], #main_search_product_results, [itemprop="offers"]',
  scrollFirst: false,
  dismissCookies: false,
  expectedMinItems: 3,
};

// NOTE: StockX and Reverb configs removed — these platforms now use direct API
// calls in apiExtractors.js (Algolia bypass and REST API respectively).

export const MERCARI_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  // Mercari is fully client-side (styled-components, no SSR). Wait for product links.
  waitFor: 'a[href*="/us/item/"]',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};

// NOTE: PriceCharting moved OFF the stealth browser to a direct HTTP fetch —
// see fetchPriceChartingComps in apiExtractors.js. Its prices are server-rendered
// but its client-side JS blanks them under automation, so the browser always read
// 0; a plain fetch with a browser UA (no JS) gets them. No CONFIG/EXTRACTOR here.

// PriceCharting searches a PRODUCT CATALOG, not a marketplace listing index, so a
// seller-style title ("Sony PlayStation 5 Digital Edition 1TB Console - Certified
// Refurbished") finds 0 exact matches and falls back to ~100 fuzzy results. Strip
// the marketplace-listing cruft — capacity, condition/grade words, generic nouns,
// and listing separators — so the query reduces to the canonical product name.
// KEPT on purpose (deviates from "strip Digital Edition"): edition/variant tokens
// (Digital/Disc/Slim/Pro/OLED/Lite) are DISTINCT catalog SKUs with materially
// different prices — a PS5 Digital is ~$80–100 below a Disc — so dropping them
// would silently match the wrong, pricier console. Intra-word hyphens (Spider-Man)
// are preserved; only space-padded listing dashes are removed. Applied to the
// PriceCharting task ONLY (full-text sources still want the full title).
export function priceChartingQuery(query) {
  const stripped = String(query || '')
    .replace(/\b\d+\s?(?:gb|tb)\b/gi, ' ')                                                          // 1TB, 512 GB
    .replace(/\bcertified\s+refurbished\b/gi, ' ')
    .replace(/\b(?:refurbished|pre[-\s]?owned|brand[-\s]?new|like[-\s]?new|open[-\s]?box|used|sealed|loose|complete in box|cib)\b/gi, ' ')
    .replace(/\b(?:console|system|bundle|handheld)\b/gi, ' ')
    .replace(/\s+[-–—|]+\s+/g, ' ')                                                                 // " - " listing separators, NOT Spider-Man
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || String(query || '').trim();   // never reduce to empty
}

// NOTE: comp extractors return the FULL rendered page — no per-source slice.
// The downstream relevance ranker + synthesis cap (resultCaps.compsForPricing:
// 25 sold / 15 active, selected fairly across sources) still bound what reaches
// the pricing LLM, so token cost is unchanged. The win is that the ranker now
// chooses from EVERY listing on the page instead of the first N in DOM order —
// eBay's sold results sort by recency, not relevance, so the closest-matching
// comps frequently sit past the old 25-item cutoff.


// ── eBay Sold Listings Extractor ────────────────────────────────────────────
// eBay redesigned again (2026-07): the "su-*"/li.s-card generation (2025) is
// now ALSO dead — .srp-results/li.s-card/su-styled-text.primary/.s-card__price
// all match 0. Current structure (verified live 2026-07 — see the diag's
// suItemCard/srpRiverMain/suGridList counters for the next time this drifts):
//   div.srp-river-main (sold) — the results river; card root is div.su-item-card
//   a.su-item-card__title            — title text AND the listing URL (href has /itm/)
//   span.su-item-card__price         — price
//   span.signal.signal--recent       — sold date ("Sold Jul 7, 2026") — sold-only
//   .su-item-card__subtitle .su-styled-text.secondary — condition (strips trailing " ·")
// The first 1-2 cards on both sold/active pages are sponsored placeholders
// whose title starts with "Shop on eBay" (sometimes with mangled trailing
// text from a visually-hidden reversed "Sponsored" badge) — filtered below.
export const EBAY_SOLD_EXTRACTOR = `
(function() {
  const __diag = ${SITE_CHANGED_DIAG};
  const __money = ${MONEY_PARSE_FN};
  const __emptyGuard = ${EBAY_EMPTY_GUARD_FN};
  const __dedupByUrl = ${DEDUP_BY_URL_FN};
  const items = [];
  // Per-card "looked like a listing but yielded no usable price/title" counter.
  // Surfaced as yieldStats.noFields so a PARTIAL sub-selector drift (some cards
  // silently dropped while items.length stays > 0) is visible in the bug report,
  // not masked behind a healthy-looking raw count. noTitle/noPrice attribute each
  // miss to the FIRST absent field so a partial drift is field-localized in the report
  // (a drop concentrated in one field = that sub-selector moved).
  let __noFields = 0, __noTitle = 0, __noPrice = 0;

  const cards = document.querySelectorAll('.su-item-card');

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('a.su-item-card__title');
      const title = (titleEl?.innerText || titleEl?.textContent || '').trim();
      if (/^Shop on eBay\\b/i.test(title)) return;   // sponsored placeholder tile, not a real listing → benign
      if (!title) { __noFields++; __noTitle++; return; }

      const priceEl = card.querySelector('.su-item-card__price');
      const priceText = (priceEl?.innerText || priceEl?.textContent || '').trim();
      const price = __money(priceText);
      if (price === 0) { __noFields++; __noPrice++; return; }

      const dateEl = card.querySelector('.signal--recent');
      // Title element doubles as the listing link (href has /itm/).
      const linkEl = titleEl;
      const condEl = card.querySelector('.su-item-card__subtitle .su-styled-text.secondary');
      const condition = ((condEl?.innerText || condEl?.textContent || '').trim()).replace(/\\s*·\\s*$/, '');

      items.push({
        title, price, priceText,
        soldDate: (dateEl?.innerText || dateEl?.textContent || '').trim(),
        condition,
        url: linkEl?.href || '',
        source: 'ebay-sold',
      });
    } catch {}
  });

  // eBay's own "N result(s) for <query>" header. The anti-bot detector uses this
  // to tell a genuinely-thin query (eBay says "1 result", we got 1) apart from
  // selector drift (eBay says "50 results", we got 1) — so a 1-result page never
  // raises a false zero-extracted block + unclearable Solve. See
  // EBAY_EMPTY_GUARD_FN for the full genuine-empty-vs-drift decision + the
  // SITE_CHANGED diagnostic (shared with ebay-active — only the label differs).
  const __guardResult = __emptyGuard('ebay-sold', cards, items, __diag);
  if (__guardResult.empty) {
    return { items: [], yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, claimedTotal: 0 } };
  }
  // A promoted/related-item card can re-surface the same listing elsewhere on
  // the same results page (see poshmark/mercari/swappa-sold, which already
  // guard this) — without dedup, a duplicate silently doubles that listing's
  // weight in the price the AI recommends.
  const deduped = __dedupByUrl(items);
  return { items: deduped, yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, claimedTotal: __guardResult.claimedTotal } };
})()
`;

// ── eBay Active Listings Extractor ──────────────────────────────────────────
// Same 2026-07 redesign as EBAY_SOLD — identical card/title/price selectors,
// no soldDate/signal badge. Active listings render inside ul.su-grid--is-list
// (li.su-grid__item wrapping the same div.su-item-card) rather than sold's
// div.srp-river-main, but the card class itself is unchanged across both.
export const EBAY_ACTIVE_EXTRACTOR = `
(function() {
  const __diag = ${SITE_CHANGED_DIAG};
  const __money = ${MONEY_PARSE_FN};
  const __emptyGuard = ${EBAY_EMPTY_GUARD_FN};
  const __dedupByUrl = ${DEDUP_BY_URL_FN};
  const items = [];
  let __noFields = 0, __noTitle = 0, __noPrice = 0;   // field-miss total + per-field attribution (see ebay-sold)

  const cards = document.querySelectorAll('.su-item-card');

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('a.su-item-card__title');
      const title = (titleEl?.innerText || titleEl?.textContent || '').trim();
      if (/^Shop on eBay\\b/i.test(title)) return;   // sponsored placeholder tile, not a real listing → benign
      if (!title) { __noFields++; __noTitle++; return; }

      const priceEl = card.querySelector('.su-item-card__price');
      const priceText = (priceEl?.innerText || priceEl?.textContent || '').trim();
      const price = __money(priceText);
      if (price === 0) { __noFields++; __noPrice++; return; }

      // Title element doubles as the listing link (href has /itm/).
      items.push({ title, price, priceText, url: titleEl?.href || '', source: 'ebay-active' });
    } catch {}
  });

  // eBay's own "N result(s) for <query>" header — see EBAY_SOLD_EXTRACTOR /
  // EBAY_EMPTY_GUARD_FN for the full genuine-empty-vs-drift decision + diag.
  const __guardResult = __emptyGuard('ebay-active', cards, items, __diag);
  if (__guardResult.empty) {
    return { items: [], yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, claimedTotal: 0 } };
  }
  // See ebay-sold — same promoted/related-item re-insertion risk.
  const deduped = __dedupByUrl(items);
  return { items: deduped, yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, claimedTotal: __guardResult.claimedTotal } };
})()
`;


// ── Poshmark Sold Extractor ─────────────────────────────────────────────────
// Strategy: tile-grid-redesign DOM (Poshmark is a Vue.js SPA — no embedded
// JSON state, no __PRELOADED_STATE__, no XHR listings endpoint). Sold items
// render as tile cards; the SOLD overlay sets
// .tile-grid-redesign__listing-status-word to "Sold".
// Throws SITE_CHANGED if 0 sold listings are extracted.
export const POSHMARK_SOLD_EXTRACTOR = `
(function() {
  const __diag = ${SITE_CHANGED_DIAG};
  const __money = ${MONEY_PARSE_FN};
  const items = [];
  let __noFields = 0, __noTitle = 0, __noPrice = 0, __noLink = 0;   // field-miss total + per-field attribution (partial drift signal)
  const cards = document.querySelectorAll('[data-et-name="listing"]');
  // The scrape URL is always availability=sold_out, so every result IS a sold
  // listing. Poshmark used to stamp each card with a per-card "Sold" status word
  // (.tile-grid-redesign__listing-status-word); when it stops rendering that
  // (redesign — observed diag soldSel=0), REQUIRING it drops every card → 0 comps.
  // So the sold-word check is adaptive: only when the page actually carries sold
  // words (mixed result pages) do we use them to reject non-sold cards; if no card
  // has one, trust the URL filter and accept all. This survives Poshmark dropping
  // the per-card overlay without falsely accepting active listings on mixed pages.
  const pageHasSoldWords = !!document.querySelector('.tile-grid-redesign__listing-status-word');
  for (const card of cards) {
    try {
      const statusEl = card.querySelector('.tile-grid-redesign__listing-status-word');
      const statusText = (statusEl?.textContent || '').trim().toLowerCase();
      if (statusEl && statusText !== 'sold') continue;        // explicitly NOT sold → skip
      if (!statusEl && pageHasSoldWords) continue;            // page marks sold elsewhere but not here → not a sold result
      const titleEl = card.querySelector('.tile-grid-redesign__title');
      const priceEl = card.querySelector('.tile-grid-redesign__price-current');
      const linkEl  = card.querySelector('a[href*="/listing/"]');
      const title    = titleEl?.textContent?.trim() || '';
      const priceText = priceEl?.textContent?.trim() || '';
      const price    = __money(priceText);
      const href     = linkEl?.getAttribute('href') || '';
      const url      = href ? 'https://poshmark.com' + href : '';
      if (!title || !price || !url) {
        __noFields++;
        if (!title) __noTitle++; else if (!price) __noPrice++; else __noLink++;
        continue;
      }
      items.push({ title, price, priceText, url, source: 'poshmark' });
    } catch {}
  }
  if (items.length === 0) throw new Error('SITE_CHANGED: poshmark tile-grid-redesign extractor returned 0 — selectors or page structure may have changed' + __diag('cards=' + cards.length + ' titleSel=' + document.querySelectorAll('.tile-grid-redesign__title').length + ' priceSel=' + document.querySelectorAll('.tile-grid-redesign__price-current').length + ' linkSel=' + document.querySelectorAll('[data-et-name="listing"] a[href*="/listing/"]').length + ' soldSel=' + document.querySelectorAll('.tile-grid-redesign__listing-status-word').length, cards[0]));
  const seen = new Set();
  const deduped = items.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; });
  return { items: deduped, yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, noLink: __noLink } };
})()
`;


// ── Swappa Electronics Extractor ────────────────────────────────────────────
// Swappa is a server-rendered HTMX site — NOT a Redux/Next SPA — so there is no
// __PRELOADED_STATE__ / __NEXT_DATA__ to read, and there is no JSON-LD. Critically,
// the scrape URL `/search?q=<query>` is a PRODUCT DISAMBIGUATION page (it lists
// matching MODELS, each linking to `/listings/<model-slug>`), NOT a page of priced
// listings. The actual sold/active comps live one navigation away on the model's
// listings page, where every card is standardized schema.org Offer microdata
// (`itemprop="offers"` → `itemprop="price"` / `itemprop="description"`).
//
// So this extractor is two-step and site-agnostic by design (microdata, not CSS
// class names that rot):
//   1. If the current document already carries Offer microdata (e.g. the user
//      navigated straight to a listings page in the Solve window), extract it.
//   2. Otherwise we're on /search — resolve the `/listings/<slug>` link whose
//      label best matches the `?q=` query, fetch that page SAME-ORIGIN (carries
//      the session cookies that already passed the bot check), parse it, and read
//      its Offer microdata.
// The fetch is memoized on `window` so the readiness poll loop (which calls this
// repeatedly until the count settles) only hits the network once. Returns a
// Promise — both the headless pool and the inline-resolve window await it.
export const SWAPPA_EXTRACTOR = `
(function() {
  var ORIGIN = location.origin || 'https://swappa.com';
  var __money = ${MONEY_PARSE_FN};

  function abs(href) {
    if (!href) return '';
    try { return new URL(href, ORIGIN).href; } catch (e) { return href.charAt(0) === '/' ? ORIGIN + href : href; }
  }

  // Read comps from any document carrying schema.org Offer microdata.
  // Deduped by url — a featured offer can also appear in the main grid on
  // the same page (see SWAPPA_SOLD_EXTRACTOR below, which guards the same
  // failure mode); without it a duplicate silently doubles that listing's
  // weight in the price the AI recommends.
  function extractOffers(doc) {
    var out = [];
    var seenUrls = {};
    var cards = doc.querySelectorAll('[itemprop="offers"][itemscope], [itemtype*="schema.org/Offer"]');
    cards.forEach(function(card) {
      try {
        var priceEl = card.querySelector('[itemprop="price"]');
        if (!priceEl) return;
        var raw = priceEl.getAttribute('content') || priceEl.textContent || '';
        var price = __money(raw);
        if (price <= 0) return;
        var descEl = card.querySelector('[itemprop="description"]') || card.querySelector('[itemprop="name"]');
        var title = (descEl && (descEl.getAttribute('content') || descEl.textContent) || '').trim();
        if (!title) return;
        var linkEl = card.querySelector('a[href*="/listing/"]');
        var url = linkEl ? abs(linkEl.getAttribute('href')) : '';
        if (url) { if (seenUrls[url]) return; seenUrls[url] = 1; }
        out.push({
          title: title,
          price: price,
          priceText: '$' + price,
          url: url,
          source: 'swappa',
        });
      } catch (e) {}
    });
    return out;
  }

  function tokens(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  // From the /search disambiguation page, pick the bare /listings/<slug> link
  // whose label best matches the query. Token overlap wins; extra tokens are
  // lightly penalized so "iPhone XS" prefers .../apple-iphone-xs over the
  // superset .../apple-iphone-xs-max; DOM order is the final tie-break.
  function pickListingsLink(doc, query) {
    var scope = doc.querySelector('#main_search_product_results') || doc;
    var anchors = Array.prototype.slice.call(scope.querySelectorAll('a[href*="/listings/"]'));
    var seen = {};
    var cands = [];
    anchors.forEach(function(a) {
      var href = a.getAttribute('href') || '';
      if (!/\\/listings\\/[a-z0-9-]+$/i.test(href)) return; // bare model pages only (skip ?carrier= variants)
      if (seen[href]) return; seen[href] = 1;
      var label = (a.getAttribute('title') || a.textContent || '').trim() || href.split('/').pop().replace(/-/g, ' ');
      cands.push({ href: href, label: label });
    });
    if (!cands.length) return '';
    var qt = tokens(query);
    // Union of every candidate's tokens — tells us which query tokens are even
    // matchable on this page. A query carries slug-absent descriptors (storage
    // "64gb", color, carrier) that no Swappa model slug contains; excluding them
    // means the winner isn't penalized for missing what nothing could match.
    var pool = {};
    cands.forEach(function(c) { tokens(c.label + ' ' + c.href).forEach(function(t) { pool[t] = 1; }); });
    var matchable = 0;
    qt.forEach(function(t) { if (pool[t]) matchable++; });
    var best = null, bestScore = -Infinity, bestHits = 0;
    cands.forEach(function(c, idx) {
      var ct = tokens(c.label + ' ' + c.href);
      var hits = 0;
      qt.forEach(function(t) { if (ct.indexOf(t) !== -1) hits++; });
      var extra = Math.max(0, ct.length - hits);
      var score = hits * 100 - extra - idx * 0.01;
      if (score > bestScore) { bestScore = score; best = c; bestHits = hits; }
    });
    // Match-quality gate: the picked model must (a) share more than a single
    // generic brand token with the query, AND (b) match EVERY query token that is
    // matchable on this page — if another candidate matches a query token the
    // winner misses, the winner is the wrong model (e.g. "iphone-16-pro" beating
    // a query for "iphone xs" on brand+line alone). When the picker has no real
    // match — an over-specific query, or only featured/trending products like
    // "Apple Vision Pro" for an iPhone search — both checks fail and we return ''
    // so the source reports a visible 0 instead of fetching the wrong product.
    var minHits = Math.min(2, qt.length);
    if (!best || bestHits < minHits || bestHits < matchable) return '';
    return abs(best.href);
  }

  // Step 1 — already on a listings page? Extract directly.
  var direct = extractOffers(document);
  if (direct.length > 0) return direct;

  // Step 2 — on /search: resolve + fetch the model's listings page (memoized).
  if (window.__swappaComps) return window.__swappaComps;
  if (!window.__swappaCompsPromise) {
    var query = '';
    try { query = new URLSearchParams(location.search).get('q') || ''; } catch (e) {}
    if (!query) query = (document.title || '').replace(/\\s*[-|].*$/, '').trim();
    var target = pickListingsLink(document, query);
    window.__swappaCompsPromise = (async function() {
      if (!target) return [];
      try {
        var res = await fetch(target, { credentials: 'include', headers: { 'Accept': 'text/html' } });
        if (!res.ok) return [];
        var html = await res.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        return extractOffers(doc);
      } catch (e) { return []; }
    })().then(function(items) {
      window.__swappaComps = items;
      return items;
    });
  }
  return window.__swappaCompsPromise;
})()
`;


// ── Swappa SOLD Extractor (recently-completed sales) ────────────────────────
// SWAPPA_EXTRACTOR above reads /listings/<slug> = ACTIVE for-sale inventory
// (asking prices). Swappa's real COMPLETED-SALE data lives at the HTMX endpoint
// `/xui/product/<slug>/sales`: a table of individual recent SOLD listings — one
// <tr> per sale with cells [date · condition · carrier · storage] and a final
// <a href="/listing/view/<id>" title="View Sold Listing">$price</a>. It's PUBLIC
// (no login) but is an HTMX fragment, so the fetch must carry HX-Request. Two-step
// like the active extractor: resolve the model slug from /search, then fetch the
// sales fragment same-origin (carries any session cookies, same bot-check pass).
// The resolver helpers (abs/tokens/pickListingsLink) are intentionally duplicated
// from SWAPPA_EXTRACTOR so that working extractor is left byte-for-byte untouched.
export const SWAPPA_SOLD_EXTRACTOR = `
(function() {
  var ORIGIN = location.origin || 'https://swappa.com';
  var __money = ${MONEY_PARSE_FN};

  function abs(href) {
    if (!href) return '';
    try { return new URL(href, ORIGIN).href; } catch (e) { return href.charAt(0) === '/' ? ORIGIN + href : href; }
  }
  function tokens(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  // Pick the bare /listings/<slug> link best matching the query (same model
  // picker + match-quality gate as the active extractor — keeps wrong-model risk
  // identical between the two Swappa sources).
  function pickListingsLink(doc, query) {
    var scope = doc.querySelector('#main_search_product_results') || doc;
    var anchors = Array.prototype.slice.call(scope.querySelectorAll('a[href*="/listings/"]'));
    var seen = {};
    var cands = [];
    anchors.forEach(function(a) {
      var href = a.getAttribute('href') || '';
      if (!/\\/listings\\/[a-z0-9-]+$/i.test(href)) return;
      if (seen[href]) return; seen[href] = 1;
      var label = (a.getAttribute('title') || a.textContent || '').trim() || href.split('/').pop().replace(/-/g, ' ');
      cands.push({ href: href, label: label });
    });
    if (!cands.length) return '';
    var qt = tokens(query);
    var pool = {};
    cands.forEach(function(c) { tokens(c.label + ' ' + c.href).forEach(function(t) { pool[t] = 1; }); });
    var matchable = 0;
    qt.forEach(function(t) { if (pool[t]) matchable++; });
    var best = null, bestScore = -Infinity, bestHits = 0;
    cands.forEach(function(c, idx) {
      var ct = tokens(c.label + ' ' + c.href);
      var hits = 0;
      qt.forEach(function(t) { if (ct.indexOf(t) !== -1) hits++; });
      var extra = Math.max(0, ct.length - hits);
      var score = hits * 100 - extra - idx * 0.01;
      if (score > bestScore) { bestScore = score; best = c; bestHits = hits; }
    });
    var minHits = Math.min(2, qt.length);
    if (!best || bestHits < minHits || bestHits < matchable) return '';
    return abs(best.href);
  }

  // 'apple-iphone-x' -> 'Apple Iphone X' — the sales fragment has no model name,
  // only the row's spec columns, so the comp title is built from the slug + specs.
  function modelNameFromSlug(slug) {
    return String(slug || '').split('-').filter(Boolean).map(function(w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // Parse the sales table: each row's price+link come from the
  // a[href*="/listing/view/"] anchor; the remaining cells (date/condition/
  // carrier/storage) are classified by pattern so column-order changes don't break it.
  function parseSales(doc, modelName) {
    var out = [];
    var links = doc.querySelectorAll('a[href*="/listing/view/"]');
    Array.prototype.forEach.call(links, function(a) {
      try {
        var price = __money(a.textContent || '');
        if (price <= 0) return;
        var row = a.closest('tr');
        var cells = row ? Array.prototype.map.call(row.querySelectorAll('td'), function(td) { return (td.textContent || '').trim(); }) : [];
        var storage = '', condition = '', carrier = '', soldDate = '';
        cells.forEach(function(t) {
          if (!storage && /\\b\\d+\\s?(gb|tb)\\b/i.test(t)) storage = t;
          else if (!condition && /^(brand new|new|mint|good|fair|excellent|like new|used|acceptable)\\b/i.test(t)) condition = t;
          else if (!soldDate && /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\\d{4}-\\d{2}-\\d{2})/i.test(t)) soldDate = t;
          else if (!carrier && /(unlocked|verizon|at&?t|t-?mobile|sprint|gsm|cdma|cricket|metro|boost|us cellular|non-us)/i.test(t)) carrier = t;
        });
        var title = [modelName, storage, carrier].filter(Boolean).join(' ').trim() || modelName || 'Swappa sold';
        out.push({
          title: title,
          price: price,
          priceText: '$' + price,
          condition: condition,
          soldDate: soldDate,
          url: abs(a.getAttribute('href')),
          source: 'swappa-sold',
        });
      } catch (e) {}
    });
    // Dedup by listing URL — the same completed sale can surface twice on the
    // fragment (a highlighted recent sale also appearing in the table), which
    // would otherwise inflate the sold set (the report's "N unique of N+1" flag).
    var seenUrls = {};
    return out.filter(function(it) {
      if (!it.url) return true;
      if (seenUrls[it.url]) return false;
      seenUrls[it.url] = 1;
      return true;
    });
  }

  // Step 1 — already on the sales fragment (test / direct-nav)? Parse it directly.
  if (document.querySelector('a[href*="/listing/view/"]')) {
    var slugNow = '';
    try { var m = (location.pathname || '').match(/\\/(?:xui\\/product|prices|listings)\\/([a-z0-9-]+)/i); slugNow = m ? m[1] : ''; } catch (e) {}
    var directSales = parseSales(document, modelNameFromSlug(slugNow));
    if (directSales.length > 0) return directSales;
  }

  // Step 2 — on /search: resolve the model slug, then fetch the sales fragment.
  if (window.__swappaSold) return window.__swappaSold;
  if (!window.__swappaSoldPromise) {
    var query = '';
    try { query = new URLSearchParams(location.search).get('q') || ''; } catch (e) {}
    if (!query) query = (document.title || '').replace(/\\s*[-|].*$/, '').trim();
    var listingsUrl = pickListingsLink(document, query);
    var slugMatch = String(listingsUrl).match(/\\/listings\\/([a-z0-9-]+)/i);
    var slug = slugMatch ? slugMatch[1] : '';
    window.__swappaSoldPromise = (async function() {
      if (!slug) return [];
      try {
        var res = await fetch(ORIGIN + '/xui/product/' + slug + '/sales', {
          credentials: 'include',
          headers: { 'Accept': 'text/html', 'HX-Request': 'true', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) return [];
        var html = await res.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        return parseSales(doc, modelNameFromSlug(slug));
      } catch (e) { return []; }
    })().then(function(items) {
      window.__swappaSold = items;
      return items;
    });
  }
  return window.__swappaSoldPromise;
})()
`;

// NOTE: StockX and Reverb extractors have been removed from browser pool.
// They are now handled by direct API calls in apiExtractors.js:
//   - StockX: Algolia API bypass (fetchStockXListings)
//   - Reverb: Internal REST API (fetchReverbListings)
// This eliminates PerimeterX/Cloudflare WAF risk entirely for these platforms.


// ── Mercari Sold Extractor ──────────────────────────────────────────────────
// Mercari is fully client-side — styled-components, no SSR data in __NEXT_DATA__
// (only Sentry traces). All strategies relying on __NEXT_DATA__ or data-testid
// selectors are dead as of 2026-05.
// Current structure: product cards are <a href*="/us/item/"> anchors.
//   - Title: img[alt] (only location carrying the product name; strip " - App..." suffix)
//   - Price: the single <p> inside the anchor
//   - URL: anchor href (stable /us/item/ pattern)
// No sold date or condition visible in the search result card format.
export const MERCARI_SOLD_EXTRACTOR = `
(function() {
  const __diag = ${SITE_CHANGED_DIAG};
  const __money = ${MONEY_PARSE_FN};
  const items = [];
  // Cards that looked like a listing (matched the /us/item/ anchor) but yielded no
  // usable link/title/price. Count EVERY field-miss path, not just price: the title
  // comes solely from img[alt], so a lazy-load or alt-attr drift silently empties it
  // — counting it here (matching the renderer's advertised "price/title/link"
  // semantics and the eBay/Poshmark convention) is what makes that partial drift
  // visible instead of vanishing behind a healthy-looking noFields=0.
  let __noFields = 0, __noTitle = 0, __noPrice = 0, __noLink = 0;

  const cards = document.querySelectorAll('a[href*="/us/item/"]');

  cards.forEach(card => {
    try {
      // Normalize URL — strip ?ref=... and other query params so the second
      // result-pass variants (?ref=search_results) dedup against the first.
      const rawUrl = card.href || '';
      if (!rawUrl) { __noFields++; __noLink++; return; }
      const url = rawUrl.split('?')[0];

      // Title from image alt — the only place Mercari puts the product name in the card
      const imgEl = card.querySelector('img[alt]');
      const title = (imgEl?.alt || '').replace(/\\s*-\\s*App\\w*\\s*$/, '').trim();
      if (!title || title.length < 3) { __noFields++; __noTitle++; return; }

      // Price: find the first <p> that contains a $ sign. Mercari cards can
      // also have a <p> with a discount percentage ("24%") or a <p> holding the
      // title text — both yield nonsense when parsed as a number. Requiring "$"
      // skips those and lands on the actual price element.
      const pEls = card.querySelectorAll('p');
      let priceEl = null;
      for (const p of pEls) {
        if ((p.innerText || p.textContent || '').includes('$')) { priceEl = p; break; }
      }
      if (!priceEl) { __noFields++; __noPrice++; return; }
      const priceText = (priceEl.innerText || priceEl.textContent || '').trim();
      const price = __money(priceText);
      if (price === 0) { __noFields++; __noPrice++; return; }

      items.push({ title, price, priceText, url, source: 'mercari' });
    } catch {}
  });

  const seen = new Set();
  const deduped = items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  if (deduped.length === 0) throw new Error('SITE_CHANGED: mercari a[href*="/us/item/"] extractor returned 0 — URL pattern or card structure may have changed' + __diag('cards=' + cards.length + ' withImg=' + document.querySelectorAll('a[href*="/us/item/"] img[alt]').length, cards[0]));
  return { items: deduped, yieldStats: { seen: cards.length, noFields: __noFields, noTitle: __noTitle, noPrice: __noPrice, noLink: __noLink } };
})()
`;

// PriceCharting comp extraction lives in apiExtractors.js (fetchPriceChartingComps /
// parsePriceChartingHtml) — a direct HTTP fetch + server-HTML parse, NOT a browser
// extractor. See the note where PRICECHARTING_CONFIG used to be (above) for why.
