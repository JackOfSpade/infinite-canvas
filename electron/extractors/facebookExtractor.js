/**
 * Facebook Marketplace Extractor — Tier 4 (Human-Assisted BrowserView)
 *
 * Facebook uses the Relay framework with randomized DOM class names.
 * DOM parsing is impossible. Instead, we extract data from:
 *   1. Relay Store — window.__relay_store or __RELAY_STORE__ (hydration data)
 *   2. Structured data in <script> tags (JSON-LD or embedded GraphQL results)
 *   3. Inline JSON state objects (__comet_data__, __eqmc, etc.)
 *
 * This extractor is designed to run inside a Tier 4 BrowserView monitor
 * where the user has already authenticated. It scrapes the currently
 * loaded page without needing to intercept network requests.
 */

// ── Facebook Marketplace Search Results Extractor ───────────────────────────
// Runs on: facebook.com/marketplace/search/?query=...
// Extracts listing cards from the Relay store or embedded state.
export const FB_MARKETPLACE_SEARCH_EXTRACTOR = `
(function() {
  const listings = [];
  
  // Strategy 1: Parse Relay Store data from inline scripts
  try {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        // Facebook wraps Relay data in various container structures
        const extractFromRelay = (obj, depth = 0) => {
          if (depth > 8 || !obj || typeof obj !== 'object') return;
          
          // Look for marketplace listing nodes
          if (obj.__typename === 'MarketplaceListing' || 
              obj.__typename === 'Listing' ||
              obj.__typename === 'MarketplaceListingItem' ||
              obj.marketplace_listing_title) {
            const price = obj.listing_price?.amount || 
                          obj.price?.amount ||
                          obj.current_price?.amount ||
                          obj.formatted_price?.text?.match?.(/[\\d,]+\\.?\\d*/)?.[0] || 0;
            const priceNum = typeof price === 'string' ? parseFloat(price.replace(/,/g, '')) : price;
            
            if (obj.marketplace_listing_title || obj.name) {
              listings.push({
                title: obj.marketplace_listing_title || obj.name || '',
                price: priceNum || 0,
                priceText: obj.formatted_price?.text || (priceNum > 0 ? '$' + priceNum.toFixed(2) : 'Free'),
                location: obj.location?.reverse_geocode?.city_page?.display_name ||
                           obj.location_text?.text ||
                           obj.marketplace_listing_location?.city || '',
                condition: obj.listing_condition_text || obj.condition_text?.text || '',
                seller: obj.marketplace_listing_seller?.name || obj.primary_listing_photo?.owner?.name || '',
                url: obj.story?.url || (obj.id ? 'https://www.facebook.com/marketplace/item/' + obj.id + '/' : ''),
                imageUrl: obj.primary_listing_photo?.image?.uri ||
                          obj.listing_photos?.[0]?.image?.uri ||
                          obj.cover_photo?.photo?.image?.uri || '',
                postedDate: obj.creation_time ? new Date(obj.creation_time * 1000).toLocaleDateString() : '',
                source: 'facebook',
              });
            }
            return;
          }
          
          // Recurse into arrays and objects
          if (Array.isArray(obj)) {
            obj.forEach(item => extractFromRelay(item, depth + 1));
          } else {
            // Check for edges/node pattern (Relay connections)
            if (obj.edges) {
              (obj.edges || []).forEach(edge => extractFromRelay(edge?.node || edge, depth + 1));
              return;
            }
            Object.values(obj).forEach(val => extractFromRelay(val, depth + 1));
          }
        };
        
        extractFromRelay(data);
      } catch (e) {}
    }
    
    if (listings.length > 0) {
      // Deduplicate by URL
      const seen = new Set();
      const unique = listings.filter(l => {
        if (!l.url || seen.has(l.url)) return false;
        seen.add(l.url);
        return true;
      });
      return unique.slice(0, 30);
    }
  } catch (e) {}
  
  // Strategy 2: Parse __comet_data__ or similar Facebook state blobs
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      
      // Look for search results data in inline scripts
      const patterns = [
        /"marketplace_search"\\s*:\\s*(\\{.+?\\})\\s*[,}]/s,
        /"marketplace_feed_stories"\\s*:\\s*(\\{.+?\\})\\s*[,}]/s,
        /"search_results"\\s*:\\s*(\\{.+?\\})\\s*[,}]/s,
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            const edges = data.edges || data.results || [];
            edges.forEach(edge => {
              const node = edge.node || edge.listing || edge;
              if (!node.listing_title && !node.marketplace_listing_title) return;
              
              const price = node.listing_price?.amount || node.price?.amount || 0;
              const priceNum = typeof price === 'string' ? parseFloat(price.replace(/,/g, '')) : price;
              
              listings.push({
                title: node.listing_title || node.marketplace_listing_title || '',
                price: priceNum,
                priceText: priceNum > 0 ? '$' + priceNum.toFixed(2) : 'Free',
                location: node.location?.city || node.location_text?.text || '',
                url: node.id ? 'https://www.facebook.com/marketplace/item/' + node.id + '/' : '',
                source: 'facebook',
              });
            });
            
            if (listings.length > 0) {
              const seen = new Set();
              return listings.filter(l => {
                if (!l.url || seen.has(l.url)) return false;
                seen.add(l.url);
                return true;
              }).slice(0, 30);
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // Strategy 3: Last resort — try to extract from aria labels and data attributes
  // Facebook uses randomized class names but aria-labels are human-readable
  try {
    const listingLinks = document.querySelectorAll('a[href*="/marketplace/item/"]');
    listingLinks.forEach(link => {
      const container = link.closest('[class]') || link;
      const ariaLabel = link.getAttribute('aria-label') || '';
      const spans = container.querySelectorAll('span');
      
      let title = ariaLabel;
      let price = '';
      
      spans.forEach(span => {
        const text = span.innerText?.trim() || '';
        if (text.startsWith('$')) {
          price = text;
        } else if (text.length > 5 && text.length < 200 && !title) {
          title = text;
        }
      });
      
      if (title || price) {
        const priceNum = parseFloat((price || '0').replace(/[^0-9.]/g, '')) || 0;
        listings.push({
          title: title || 'Untitled',
          price: priceNum,
          priceText: price || 'Free',
          url: link.href || '',
          source: 'facebook',
        });
      }
    });
    
    if (listings.length > 0) {
      const seen = new Set();
      return listings.filter(l => {
        if (!l.url || seen.has(l.url)) return false;
        seen.add(l.url);
        return true;
      }).slice(0, 30);
    }
  } catch (e) {}
  
  return [];
})()
`;

// ── Facebook Marketplace Single Listing Extractor ───────────────────────────
// Runs on: facebook.com/marketplace/item/{id}/
// Extracts detailed pricing, condition, and seller info from a single listing.
export const FB_MARKETPLACE_ITEM_EXTRACTOR = `
(function() {
  // Strategy 1: Parse structured data from JSON-LD (Facebook sometimes includes it)
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      const data = JSON.parse(script.textContent);
      if (data['@type'] === 'Product') {
        const offer = data.offers || {};
        return {
          title: data.name || '',
          price: parseFloat(offer.price || 0),
          priceText: offer.priceCurrency ? offer.priceCurrency + ' ' + offer.price : '$' + offer.price,
          description: data.description || '',
          condition: data.itemCondition?.replace('https://schema.org/', '') || '',
          seller: data.seller?.name || '',
          imageUrl: data.image || '',
          url: window.location.href,
          source: 'facebook',
        };
      }
    }
  } catch (e) {}
  
  // Strategy 2: Parse from Relay store / inline JSON
  try {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const findListing = (obj, depth = 0) => {
          if (depth > 8 || !obj || typeof obj !== 'object') return null;
          
          if ((obj.__typename === 'MarketplaceListing' || obj.marketplace_listing_title) && obj.listing_price) {
            return obj;
          }
          
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = findListing(item, depth + 1);
              if (found) return found;
            }
          } else {
            for (const val of Object.values(obj)) {
              const found = findListing(val, depth + 1);
              if (found) return found;
            }
          }
          return null;
        };
        
        const listing = findListing(data);
        if (listing) {
          const price = listing.listing_price?.amount || 0;
          const priceNum = typeof price === 'string' ? parseFloat(price.replace(/,/g, '')) : price;
          
          return {
            title: listing.marketplace_listing_title || listing.name || '',
            price: priceNum,
            priceText: listing.formatted_price?.text || (priceNum > 0 ? '$' + priceNum.toFixed(2) : 'Free'),
            description: listing.redacted_description?.text || listing.description?.text || '',
            condition: listing.listing_condition_text || '',
            location: listing.location?.reverse_geocode?.city_page?.display_name || '',
            seller: listing.marketplace_listing_seller?.name || '',
            imageUrl: listing.primary_listing_photo?.image?.uri || '',
            url: window.location.href,
            source: 'facebook',
          };
        }
      } catch (e) {}
    }
  } catch (e) {}

  return null;
})()
`;

// ── Platform-Specific Monitor Configs ───────────────────────────────────────

export const MONITOR_CONFIGS = {
  facebook: {
    platform: 'facebook',
    searchUrl: (query) => `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}&daysSinceListed=1&sortBy=creation_time_descend`,
    extractorJS: FB_MARKETPLACE_SEARCH_EXTRACTOR,
    refreshMs: 120_000, // 2 minutes (Facebook is very sensitive to rapid refreshes)
    requiresAuth: true,
    authUrl: 'https://www.facebook.com/login',
  },
  // Future Tier 4 fallback candidates:
  glassdoor: {
    platform: 'glassdoor',
    searchUrl: (query) => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(query)}`,
    // Uses the existing Glassdoor extractor from jobs.js
    extractorJS: null, // Will be set dynamically from jobs.js GLASSDOOR_EXTRACTOR
    refreshMs: 300_000, // 5 minutes
    requiresAuth: false,
    authUrl: 'https://www.glassdoor.com/profile/login_input.htm',
  },
  ziprecruiter: {
    platform: 'ziprecruiter',
    searchUrl: (query) => `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(query)}&days=14`,
    extractorJS: null,
    refreshMs: 300_000,
    requiresAuth: false,
    authUrl: 'https://www.ziprecruiter.com/login',
  },
};
