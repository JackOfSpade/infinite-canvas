/**
 * Marketplace Price Comparison Extractors + Site Configs.
 *
 * Extraction strategies (in order of reliability, per 2026 deep research report):
 *   1. __PRELOADED_STATE__ — Redux hydration state (Poshmark, Swappa)
 *   2. __NEXT_DATA__       — Next.js SSR payload (Mercari)
 *   3. Inline Script JSON  — variant pricing matrices (eBay)
 *   4. DOM                 — CSS selector scraping with fallbacks
 *
 * StockX and Reverb have been moved to API-based extraction in apiExtractors.js:
 *   - StockX: Algolia API bypass (extracts keys, queries Algolia directly)
 *   - Reverb: Internal REST API (api.reverb.com/api/listings/all)
 *
 * All extractors return the standard comp shape:
 *   { title, price, priceText, url, source, soldDate?, condition?, seller? }
 */

// ── Site Configurations ─────────────────────────────────────────────────────

export const EBAY_SOLD_CONFIG = {
  waitMs: 2500,
  timeoutMs: 40000,
  waitFor: '.srp-results .s-item, .srp-results .s-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const EBAY_ACTIVE_CONFIG = {
  waitMs: 2500,
  timeoutMs: 40000,
  waitFor: '.srp-results .s-item, .srp-results .s-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const POSHMARK_CONFIG = {
  waitMs: 3500,
  timeoutMs: 45000,
  waitFor: '[data-et-name="listing"], .card, .tile__covershot',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const SWAPPA_CONFIG = {
  waitMs: 2500,
  timeoutMs: 30000,
  waitFor: '.search_result, .listing_row, .row.item',
  scrollFirst: false,
  dismissCookies: false,
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
          if (items.length > 0) return items.slice(0, 25);
        } catch {}
      }
    }
  } catch {}
  
  // Strategy 1: DOM parsing
  const cards = document.querySelectorAll('.tile-grid-redesign__media--wrapper, [data-et-name="listing"], .card--small, .tile, [class*="ListingTile"]');
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

  return items.slice(0, 25);
})()
`;


// ── Swappa Electronics Extractor ────────────────────────────────────────────
// Strategy 0: Extract __PRELOADED_STATE__ from .js-content (Redux state)
//   Contains pricing curves, condition-specific market floors, and device variants.
// Strategy 1: DOM parsing fallback
export const SWAPPA_EXTRACTOR = `
(function() {
  const items = [];
  
  // Strategy 0: Parse __PRELOADED_STATE__ (Redux hydration from .js-content)
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/window\\.__PRELOADED_STATE__\\s*=\\s*(\\{.+?\\});\\s*(?:<|window|$)/s);
      if (match) {
        try {
          const state = JSON.parse(match[1]);
          // Navigate to listings/pricing data in Redux tree
          const listings = state?.search?.results ||
                           state?.listings?.items ||
                           state?.catalog?.listings ||
                           [];
          
          const listArr = Array.isArray(listings) ? listings : Object.values(listings || {});
          
          listArr.forEach(item => {
            if (!item) return;
            const price = item.price || item.asking_price || 0;
            const priceNum = typeof price === 'string' ? parseFloat(price.replace(/[^0-9.]/g, '')) : price;
            if (priceNum === 0 || !item.title) return;
            
            items.push({
              title: item.title || item.device_name || '',
              price: priceNum,
              priceText: '$' + priceNum.toFixed(2),
              condition: item.condition || item.condition_name || '',
              url: (item.url || item.listing_url) ? ('https://swappa.com' + (item.url || item.listing_url)) : '',
              source: 'swappa',
            });
          });
          if (items.length > 0) return items.slice(0, 25);
        } catch {}
      }
    }
  } catch {}
  
  // Strategy 1: Fallback DOM parsing
  const cards = document.querySelectorAll('.search_result, .listing_row, .row.item, [class*="ListingItem"], [class*="listing-card"]');
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('h3, .listing_title, [class*="title"], a[href*="/listing/"]');
      const priceEl = card.querySelector('.price, [class*="price"], .listing_price');
      const conditionEl = card.querySelector('.condition, [class*="condition"], .badge');
      const linkEl = card.querySelector('a[href*="/listing/"], a[href*="/buy/"]');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;
      
      const priceTextRaw = priceEl?.innerText?.trim() || '';
      const priceText = priceTextRaw.split(/[\\n\\r]+/)[0];
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
      if (price === 0) return;

      items.push({
        title, price, priceText,
        condition: conditionEl?.innerText?.trim() || '',
        url: linkEl?.href || '',
        source: 'swappa',
      });
    } catch {}
  });

  return items.slice(0, 25);
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
      
      const titleEl = container.querySelector('[data-testid="ItemName"], [class*="itemName"], [class*="ItemName"], p, span');
      const priceEl = container.querySelector('[data-testid="ItemPrice"], [data-testid="ProductThumbItemPrice"], [class*="itemPrice"], [class*="ItemPrice"], [class*="price"]');
      const linkEl = container.querySelector('a[href*="/item/"]') || (container.tagName === 'A' ? container : container.closest('a'));
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title || title.length < 2) return;
      
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
