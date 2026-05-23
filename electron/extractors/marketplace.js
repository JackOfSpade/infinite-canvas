/**
 * Marketplace Price Comparison Extractors + Site Configs.
 *
 * Extraction strategies (in order of reliability, per 2026 deep research report):
 *   1. __PRELOADED_STATE__ — Redux hydration state (Poshmark)
 *   2. __NEXT_DATA__       — Next.js SSR payload (Mercari)
 *   3. schema.org microdata — itemprop="offers" Offer cards (Swappa; two-step,
 *                             since its /search?q= is a model picker, not listings)
 *   4. Inline Script JSON  — variant pricing matrices (eBay)
 *   5. DOM                 — CSS selector scraping with fallbacks
 *
 * StockX and Reverb have been moved to API-based extraction in apiExtractors.js:
 *   - StockX: Algolia API bypass (extracts keys, queries Algolia directly)
 *   - Reverb: Internal REST API (api.reverb.com/api/listings/all)
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
  waitFor: '.srp-results .s-item, .srp-results .s-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  expectedMinItems: 3,
};

export const EBAY_ACTIVE_CONFIG = {
  waitMs: 2500,
  timeoutMs: 40000,
  waitFor: '.srp-results .s-item, .srp-results .s-card',
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
  waitFor: '[data-testid="SearchResults"], [class*="SearchResults"], [class*="ItemContainer"], #__NEXT_DATA__',
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
// Strategy 0: Extract inline variant JSON from <script> tags (pricing matrices)
// Strategy 1: DOM parsing (eBay HTML is relatively stable)
export const EBAY_SOLD_EXTRACTOR = `
(function() {
  const items = [];
  
  // Strategy 0: Extract structured data from inline scripts (variant pricing)
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // eBay embeds search results as JSON in srp-main-content data
      if (text.includes('"itemSummaries"') || text.includes('"listingItems"')) {
        const match = text.match(/"itemSummaries"\\s*:\\s*(\\[.+?\\])\\s*[,}]/s) ||
                      text.match(/"listingItems"\\s*:\\s*(\\[.+?\\])\\s*[,}]/s);
        if (match) {
          try {
            const listings = JSON.parse(match[1]);
            if (Array.isArray(listings)) {
              listings.forEach(item => {
                const price = item.price?.value || item.currentBidPrice?.value || 0;
                if (!price || !item.title) return;
                items.push({
                  title: item.title || '',
                  price: parseFloat(price),
                  priceText: '$' + parseFloat(price).toFixed(2),
                  soldDate: item.endDate || item.listingInfo?.endTime || '',
                  condition: item.condition?.conditionDisplayName || item.conditionDisplayName || '',
                  url: item.itemWebUrl || item.viewItemURL || '',
                  source: 'ebay-sold',
                });
              });
            }
            if (items.length > 0) return items.slice(0, 25);
          } catch {}
        }
      }
    }
  } catch {}

  // Strategy 1: DOM parsing
  const cards = document.querySelectorAll('.s-item, .s-card');
  
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.s-item__title, .s-card__title, [class*="title"]');
      const priceEl = card.querySelector('.s-item__price, .s-card__price, [class*="price"]');
      const dateEl = card.querySelector('.s-item__title--tag, .s-item__ended-date, .POSITIVE, .s-card__caption');
      const linkEl = card.querySelector('.s-item__link, .s-card__link');
      const conditionEl = card.querySelector('.SECONDARY_INFO, .s-card__subtitle');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title || title === 'Shop on eBay') return;
      
      const priceTextRaw = priceEl?.innerText?.trim() || '';
      const priceText = priceTextRaw.split(/[\\n\\r]+/)[0];
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      items.push({
        title, price, priceText,
        soldDate: dateEl?.innerText?.trim() || '',
        condition: conditionEl?.innerText?.trim() || '',
        url: linkEl?.href || '',
        source: 'ebay-sold',
      });
    } catch {}
  });

  return items.slice(0, 25);
})()
`;

// ── eBay Active Listings Extractor ──────────────────────────────────────────
export const EBAY_ACTIVE_EXTRACTOR = `
(function() {
  const items = [];
  const cards = document.querySelectorAll('.s-item, .s-card');
  
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.s-item__title, .s-card__title, [class*="title"]');
      const priceEl = card.querySelector('.s-item__price, .s-card__price, [class*="price"]');
      const linkEl = card.querySelector('.s-item__link, .s-card__link');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title || title === 'Shop on eBay') return;
      
      const priceTextRaw = priceEl?.innerText?.trim() || '';
      const priceText = priceTextRaw.split(/[\\n\\r]+/)[0];
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      items.push({ title, price, priceText, url: linkEl?.href || '', source: 'ebay-active' });
    } catch {}
  });

  return items.slice(0, 20);
})()
`;


// ── Poshmark Sold Extractor ─────────────────────────────────────────────────
// Strategy 0: Extract __PRELOADED_STATE__ (Poshmark is React/Redux, NOT Next.js)
//   Contains sold prices, days-to-sell, and seller performance metrics.
// Strategy 1: DOM parsing with sold overlay detection
export const POSHMARK_SOLD_EXTRACTOR = `
(function() {
  const items = [];

  // Collapse repeats of the same listing. Key on the listing URL when present;
  // fall back to title+price for the (link-less) stripped twins the nested-DOM
  // match used to emit. Keeps the first, drops later copies.
  const dedupeComps = (arr) => {
    const seen = new Set();
    return arr.filter(i => {
      const key = (i && i.url) ? String(i.url) : ((i && i.title) || '') + '|' + ((i && i.price) || 0);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Strategy 0: Parse __PRELOADED_STATE__ (Redux hydration state)
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/window\\.__PRELOADED_STATE__\\s*=\\s*(\\{.+?\\});\\s*(?:<|window|$)/s);
      if (match) {
        try {
          const state = JSON.parse(match[1]);
          // Navigate Redux state tree to find listings
          const listings = state?.search?.searchResults ||
                           state?.closet?.listings ||
                           state?.listing?.listings ||
                           (state?.data ? Object.values(state.data).filter(v => v?.title && v?.price_amount) : []) ||
                           [];
          
          const listArr = Array.isArray(listings) ? listings : Object.values(listings || {});
          
          listArr.forEach(listing => {
            if (!listing || !listing.title) return;
            const price = listing.price_amount?.val || listing.sold_price || listing.price || 0;
            const priceNum = typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) : price;
            if (priceNum === 0) return;
            
            items.push({
              title: listing.title || '',
              price: priceNum,
              priceText: '$' + priceNum.toFixed(2),
              soldDate: listing.sold_at || listing.updated_at || '',
              condition: listing.condition || '',
              seller: listing.creator_username || '',
              url: listing.id ? ('https://poshmark.com/listing/' + listing.id) : '',
              source: 'poshmark',
            });
          });
          // Redux state can list the same listing in multiple slices
          // (search.searchResults + the data map), so dedup before returning.
          if (items.length > 0) return dedupeComps(items).slice(0, 25);
        } catch {}
      }
    }
  } catch {}

  // Strategy 1: DOM parsing
  // Poshmark nests matching wrappers — a single listing renders as
  // .tile > [class*="ListingTile"] > [data-et-name="listing"], so the
  // selector union below matches the SAME listing 2-3× (ancestor +
  // descendants). Each match re-extracts the same title/price (the innermost
  // one lacks the link + sold badge, producing an empty-url stripped twin),
  // which previously triple-counted every listing into the pricing set with
  // no dedup. Keep only the OUTERMOST match per listing so each renders once.
  const matched = Array.from(document.querySelectorAll('.tile-grid-redesign__media--wrapper, [data-et-name="listing"], .card--small, .tile, [class*="ListingTile"]'));
  const cards = matched.filter(el => !matched.some(other => other !== el && other.contains(el)));
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.tile-grid-redesign__title, [data-et-name="title"], .title__condition, .tile__title, [class*="itemTitle"]');
      const priceEl = card.querySelector('.tile-grid-redesign__price-current, [data-et-name="price"], .fw--bold, .tile__price, [class*="itemPrice"]');
      const linkEl = card.querySelector('a[href*="/listing/"]');
      const listingId = card.querySelector('[data-et-prop-listing_id]')?.getAttribute('data-et-prop-listing_id');
      const soldBadge = card.querySelector('.tile-grid-redesign__listing-status-word, .sold-tag, [class*="sold"], .badge--sold, .item__sold-tag');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;
      
      const priceTextRaw = priceEl?.innerText?.trim() || '';
      const priceText = priceTextRaw.split(/[\\n\\r]+/)[0];
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;
      let url = linkEl?.href || '';
      if (!url && listingId) {
        url = 'https://poshmark.com/listing/' + title.replace(/[^a-zA-Z0-9]/g, '-') + '-' + listingId;
      } else if (url && !url.startsWith('http')) {
        url = 'https://poshmark.com' + url;
      }

      items.push({
        title, price, priceText,
        soldDate: soldBadge ? 'Sold' : '',
        url,
        source: 'poshmark',
      });
    } catch {}
  });

  // Defensive final dedup (outermost-only selection above should already
  // prevent nested double-counts, but guard against repeated listing ids).
  return dedupeComps(items).slice(0, 25);
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
// Strategy 0: __NEXT_DATA__ (Mercari is Next.js — sold listing data preserved in state)
// Strategy 1: DOM parsing with broad selectors (Mercari uses React with dynamic classes)
export const MERCARI_SOLD_EXTRACTOR = `
(function() {
  const items = [];

  // Strategy 0: Parse __NEXT_DATA__ (Mercari strips JSON-LD on sold items)
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      try {
        const nd = JSON.parse(ndEl.textContent);
        const results = nd?.props?.pageProps?.searchResults ||
                        nd?.props?.pageProps?.items ||
                        nd?.props?.pageProps?.data?.search?.itemsList ||
                        [];
        
        const resArr = Array.isArray(results) ? results : Object.values(results || {});

        resArr.forEach(item => {
          if (!item) return;
          const price = item.price || item.currentPrice || 0;
          const priceNum = typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) : price;
          if (priceNum === 0 || !item.name) return;
          
          items.push({
            title: item.name || item.itemName || '',
            price: priceNum,
            priceText: '$' + priceNum.toFixed(2),
            soldDate: item.updated || item.sold_at || '',
            url: item.id ? ('https://www.mercari.com/item/' + item.id + '/') : '',
            source: 'mercari',
          });
        });
        if (items.length > 0) {
          const seen = new Set();
          return items.filter(i => { if (seen.has(i.url)) return false; seen.add(i.url); return true; }).slice(0, 20);
        }
      } catch {}
    }
  } catch {}

  // Strategy 1: DOM parsing with broad selectors
  const cards = document.querySelectorAll(
    '[data-testid="ItemContainer"], [class*="ItemContainer"], [class*="ItemCell"], ' +
    '[class*="SearchResultItem"], [class*="item-cell"], a[href*="/item/"]'
  );
  
  // If direct card approach fails, try finding items by link pattern
  const targets = cards.length > 0 ? cards : document.querySelectorAll('a[href*="/item/m"]');
  
  targets.forEach(card => {
    try {
      // Walk up to find the container if we matched a link
      const container = card.closest('[class*="Item"]') || card.closest('[data-testid="ItemContainer"]') || card;
      
      const priceEl = container.querySelector('[data-testid="ItemPrice"], [data-testid="ProductThumbItemPrice"], [class*="itemPrice"], [class*="ItemPrice"], [class*="price"]');
      const linkEl = container.querySelector('a[href*="/item/"]') || (container.tagName === 'A' ? container : container.closest('a'));

      // Title resolution. The old bare "p, span" fallback grabbed the FIRST
      // child paragraph/span — which on a Mercari card is the discount badge
      // ("76%") or the "SOLD" overlay, not the product name. Prefer the explicit
      // name node, then the thumbnail alt / link aria-label (Mercari puts the
      // product name there), and reject anything that's clearly a badge /
      // status word / bare price rather than a title.
      const isJunkTitle = (t) =>
        !t || t.length < 4 || /^\\d+%$/.test(t) || /^(sold|free|new|used)$/i.test(t) || /^\\$?\\d[\\d.,]*$/.test(t);
      let title = (container.querySelector('[data-testid="ItemName"], [class*="itemName"], [class*="ItemName"]')?.innerText || '').trim();
      if (isJunkTitle(title)) {
        const alt = (container.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
        if (!isJunkTitle(alt)) title = alt;
      }
      if (isJunkTitle(title)) {
        const aria = (linkEl?.getAttribute?.('aria-label') || '').trim();
        if (!isJunkTitle(aria)) title = aria;
      }
      if (isJunkTitle(title)) return; // no real product title found — skip this card

      const priceTextRaw = priceEl?.innerText?.trim() || '';
      const priceText = priceTextRaw.split(/[\\n\\r]+/)[0];
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      items.push({
        title, price, priceText,
        url: linkEl?.href ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://www.mercari.com' + linkEl.getAttribute('href')) : '',
        source: 'mercari',
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
