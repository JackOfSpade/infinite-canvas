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

// PriceCharting publishes aggregated sold-price data for video games + retro
// consoles. No aggressive anti-bot (their business model depends on price
// data being accessible). Results are a `.offers-table` of rows, one per
// game+console combo, with loose / CIB / new price columns.
export const PRICECHARTING_CONFIG = {
  waitMs: 1500,
  timeoutMs: 25000,
  waitFor: '.offers-table tr, table tr, #games_table',
  scrollFirst: false,
  dismissCookies: false,
};

// Per-source extraction cap — the `slice(0, N)` each extractor below applies to
// its results. Mirrored here (KEEP IN SYNC with the slices) so the scrape funnel
// can flag a source whose returned count EQUALS its cap: that page almost
// certainly held MORE listings than we gathered, which is otherwise invisible —
// a raw count of "25" reads identically whether 25 or 250 were on the page.
// This is not lost downstream (synthesis caps at 25 sold / 15 active and selects
// fairly across sources), but it makes "silently not gathered from scrape?"
// answerable instead of ambiguous. PriceCharting is intentionally omitted: it's
// a niche games source where a small/zero count is expected, never a truncation.
export const COMP_EXTRACT_CAPS = {
  'ebay-sold': 25,
  'ebay-active': 20,
  'poshmark': 25,
  'swappa': 25,
  'mercari': 20,
  'reverb': 25,
};


// ── eBay Sold Listings Extractor ────────────────────────────────────────────
// eBay migrated to the "su-*" design system (2025). Old selectors (.s-item__title,
// .s-item__price, .SECONDARY_INFO, .POSITIVE) are dead. The inline JSON strategy
// (itemSummaries/listingItems) is also dead — replaced by single-letter obfuscated
// keys in a $M_* global that aren't reliably parseable.
// Current structure (as of 2026-05):
//   .srp-results li.s-card           — card root (old .s-item matches ghost nodes)
//   span.su-styled-text.primary.default — title
//   span.s-card__price               — price (kept s-card__ namespace)
//   span.su-styled-text.positive.default — sold date ("Sold May 23, 2026")
//   span.su-styled-text.secondary.default — condition (first match; strips trailing " ·")
//   a.s-card__link                   — listing URL
export const EBAY_SOLD_EXTRACTOR = `
(function() {
  const items = [];

  const cards = document.querySelectorAll('.srp-results li.s-card');

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('span.su-styled-text.primary');
      const title = (titleEl?.innerText || titleEl?.textContent || '').trim();
      if (!title || title === 'Shop on eBay') return;

      const priceEl = card.querySelector('.s-card__price');
      const priceText = (priceEl?.innerText || priceEl?.textContent || '').trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      const dateEl = card.querySelector('span.su-styled-text.positive.default');
      const linkEl = card.querySelector('a.s-card__link');
      // First secondary.default span is condition; later ones are specs (model, storage, carrier)
      const condEl = card.querySelector('span.su-styled-text.secondary.default');
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

  if (items.length === 0) throw new Error('SITE_CHANGED: ebay-sold su-styled-text extractor returned 0 — eBay design system may have changed');
  return items.slice(0, 25);
})()
`;

// ── eBay Active Listings Extractor ──────────────────────────────────────────
// Same su-* design system migration as EBAY_SOLD — identical selectors, no soldDate.
export const EBAY_ACTIVE_EXTRACTOR = `
(function() {
  const items = [];

  const cards = document.querySelectorAll('.srp-results li.s-card');

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('span.su-styled-text.primary');
      const title = (titleEl?.innerText || titleEl?.textContent || '').trim();
      if (!title || title === 'Shop on eBay') return;

      const priceEl = card.querySelector('.s-card__price');
      const priceText = (priceEl?.innerText || priceEl?.textContent || '').trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      const linkEl = card.querySelector('a.s-card__link');
      items.push({ title, price, priceText, url: linkEl?.href || '', source: 'ebay-active' });
    } catch {}
  });

  if (items.length === 0) throw new Error('SITE_CHANGED: ebay-active su-styled-text extractor returned 0 — eBay design system may have changed');
  return items.slice(0, 20);
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
  const items = [];
  const cards = document.querySelectorAll('[data-et-name="listing"]');
  for (const card of cards) {
    try {
      const statusEl = card.querySelector('.tile-grid-redesign__listing-status-word');
      if ((statusEl?.textContent || '').trim().toLowerCase() !== 'sold') continue;
      const titleEl = card.querySelector('.tile-grid-redesign__title');
      const priceEl = card.querySelector('.tile-grid-redesign__price-current');
      const linkEl  = card.querySelector('a[href*="/listing/"]');
      const title    = titleEl?.textContent?.trim() || '';
      const priceText = priceEl?.textContent?.trim() || '';
      const price    = parseFloat(priceText.replace(/[^0-9.]/g, ''));
      const href     = linkEl?.getAttribute('href') || '';
      const url      = href ? 'https://poshmark.com' + href : '';
      if (!title || !price || !url) continue;
      items.push({ title, price, priceText, url, source: 'poshmark' });
    } catch {}
  }
  if (items.length === 0) throw new Error('SITE_CHANGED: poshmark tile-grid-redesign extractor returned 0 — selectors or page structure may have changed');
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; }).slice(0, 25);
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

  function abs(href) {
    if (!href) return '';
    try { return new URL(href, ORIGIN).href; } catch (e) { return href.charAt(0) === '/' ? ORIGIN + href : href; }
  }

  // Read comps from any document carrying schema.org Offer microdata.
  function extractOffers(doc) {
    var out = [];
    var cards = doc.querySelectorAll('[itemprop="offers"][itemscope], [itemtype*="schema.org/Offer"]');
    cards.forEach(function(card) {
      try {
        var priceEl = card.querySelector('[itemprop="price"]');
        if (!priceEl) return;
        var raw = priceEl.getAttribute('content') || priceEl.textContent || '';
        var price = parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
        if (price <= 0) return;
        var descEl = card.querySelector('[itemprop="description"]') || card.querySelector('[itemprop="name"]');
        var title = (descEl && (descEl.getAttribute('content') || descEl.textContent) || '').trim();
        if (!title) return;
        var linkEl = card.querySelector('a[href*="/listing/"]');
        out.push({
          title: title,
          price: price,
          priceText: '$' + price,
          url: linkEl ? abs(linkEl.getAttribute('href')) : '',
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
  if (direct.length > 0) return direct.slice(0, 25);

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
        return extractOffers(doc).slice(0, 25);
      } catch (e) { return []; }
    })().then(function(items) {
      window.__swappaComps = items;
      return items;
    });
  }
  return window.__swappaCompsPromise;
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
  const items = [];

  const cards = document.querySelectorAll('a[href*="/us/item/"]');

  cards.forEach(card => {
    try {
      // Normalize URL — strip ?ref=... and other query params so the second
      // result-pass variants (?ref=search_results) dedup against the first.
      const rawUrl = card.href || '';
      if (!rawUrl) return;
      const url = rawUrl.split('?')[0];

      // Title from image alt — the only place Mercari puts the product name in the card
      const imgEl = card.querySelector('img[alt]');
      const title = (imgEl?.alt || '').replace(/\\s*-\\s*App\\w*\\s*$/, '').trim();
      if (!title || title.length < 3) return;

      // Price: find the first <p> that contains a $ sign. Mercari cards can
      // also have a <p> with a discount percentage ("24%") or a <p> holding the
      // title text — both yield nonsense when parsed as a number. Requiring "$"
      // skips those and lands on the actual price element.
      const pEls = card.querySelectorAll('p');
      let priceEl = null;
      for (const p of pEls) {
        if ((p.innerText || p.textContent || '').includes('$')) { priceEl = p; break; }
      }
      if (!priceEl) return;
      const priceText = (priceEl.innerText || priceEl.textContent || '').trim();
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      items.push({ title, price, priceText, url, source: 'mercari' });
    } catch {}
  });

  const seen = new Set();
  const deduped = items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  if (deduped.length === 0) throw new Error('SITE_CHANGED: mercari a[href*="/us/item/"] extractor returned 0 — URL pattern or card structure may have changed');
  return deduped.slice(0, 20);
})()
`;

// ── PriceCharting Extractor ─────────────────────────────────────────────────
// PriceCharting search returns a table of game results. Each row carries the
// title (with platform in brackets) and loose / CIB / new prices. We pick the
// loose price as the FMV anchor — that's what a typical reseller listing
// matches (cart-only, no box). Falls back to whichever price cell has a
// number when loose is missing.
export const PRICECHARTING_EXTRACTOR = `
(function() {
  const items = [];

  const parsePrice = (txt) => {
    if (!txt) return 0;
    const m = String(txt).replace(/[,\\s]/g, '').match(/\\$?(\\d+(?:\\.\\d{1,2})?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  // Strategy 1: PriceCharting renders results inside #games_table > tbody > tr
  // (legacy id) or a generic table.offers-table. Each row has a title link
  // and three price columns. Try both shells.
  const rows = document.querySelectorAll('#games_table tbody tr, table.offers-table tbody tr, table tr');
  rows.forEach(row => {
    try {
      const titleLink = row.querySelector('td.title a, a[href*="/game/"]');
      if (!titleLink) return;
      const title = (titleLink.innerText || titleLink.textContent || '').trim();
      if (!title || title.length < 2) return;

      // Price cells, in column order. PriceCharting columns are:
      // loose | complete-in-box (CIB) | new. Some result pages drop one.
      const priceCells = Array.from(row.querySelectorAll('td.price, td[align="right"]'))
        .map(td => parsePrice(td.innerText || td.textContent))
        .filter(p => p > 0);
      if (priceCells.length === 0) return;
      const price = priceCells[0]; // loose price first

      const href = titleLink.getAttribute('href') || '';
      const url = href.startsWith('http')
        ? href
        : 'https://www.pricecharting.com' + (href.startsWith('/') ? href : '/' + href);

      items.push({
        title,
        price,
        priceText: '$' + price.toFixed(2),
        url,
        condition: 'Loose (cart-only)',
        source: 'pricecharting',
      });
    } catch {}
  });

  // Deduplicate by URL
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 20);
})()
`;
