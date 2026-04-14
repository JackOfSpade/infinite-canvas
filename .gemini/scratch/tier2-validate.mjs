// Validate eBay and Poshmark Tier 2 data quality
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function validateEbay() {
  console.log('═══ eBay Tier 2 Validation ═══\n');
  const res = await fetch('https://www.ebay.com/sch/i.html?_nkw=iphone+15+pro', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();

  // Extract JSON-LD
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      console.log('JSON-LD type:', ld['@type']);
      if (ld.itemListElement) {
        console.log(`Items in JSON-LD: ${ld.itemListElement.length}`);
        console.log('First item:', JSON.stringify(ld.itemListElement[0], null, 2).substring(0, 500));
      }
    } catch (e) { console.log('JSON-LD parse error:', e.message); }
  }

  // Extract items array from inline scripts
  const itemsMatch = html.match(/"items"\s*:\s*(\[[\s\S]*?\])\s*,\s*"pagination"/);
  if (itemsMatch) {
    try {
      const items = JSON.parse(itemsMatch[1]);
      console.log(`\nInline items array: ${items.length} items`);
      if (items[0]) {
        console.log('First item keys:', Object.keys(items[0]).join(', '));
        console.log('Sample:', JSON.stringify(items[0], null, 2).substring(0, 800));
      }
    } catch (e) { console.log('Items parse error:', e.message); }
  }
}

async function validatePoshmark() {
  console.log('\n═══ Poshmark Tier 2 Validation ═══\n');
  const res = await fetch('https://poshmark.com/search?query=nike+shoes&type=listings', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();

  // Extract __INITIAL_STATE__
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (stateMatch) {
    try {
      // This might be large, just check structure
      const state = JSON.parse(stateMatch[1]);
      console.log('__INITIAL_STATE__ top keys:', Object.keys(state).join(', '));
      console.log('State size:', stateMatch[1].length, 'bytes');
      
      // Look for search results
      const searchKey = Object.keys(state).find(k => k.includes('search') || k.includes('listing') || k.includes('feed'));
      if (searchKey) {
        console.log(`\nSearch data key: "${searchKey}"`);
        const searchData = state[searchKey];
        console.log('Keys:', Object.keys(searchData || {}).join(', '));
      }
    } catch (e) { 
      console.log('State parse failed (might be escaped):', e.message);
      console.log('Raw sample:', stateMatch[1].substring(0, 500));
    }
  } else {
    console.log('__INITIAL_STATE__ not found in expected format, checking alternatives...');
    if (html.includes('__INITIAL_STATE__')) {
      // Try different extraction pattern
      const alt = html.match(/__INITIAL_STATE__\s*=\s*"([^"]+)"/);
      if (alt) {
        console.log('Found encoded state (', alt[1].length, 'chars) — may need decoding');
      }
      // Show context around __INITIAL_STATE__
      const idx = html.indexOf('__INITIAL_STATE__');
      console.log('Context:', html.substring(idx, idx + 300));
    }
  }

  // Check JSON-LD
  const ldMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (ldMatches) {
    for (let i = 0; i < ldMatches.length; i++) {
      try {
        const ld = JSON.parse(ldMatches[i].replace(/<\/?script[^>]*>/g, ''));
        console.log(`\nJSON-LD #${i+1}: ${ld['@type']} (${ld.itemListElement?.length || 0} items)`);
        if (ld.itemListElement?.[0]) {
          console.log('  Sample:', JSON.stringify(ld.itemListElement[0], null, 2).substring(0, 400));
        }
      } catch {}
    }
  }
}

async function main() {
  await validateEbay();
  await validatePoshmark();
}
main().catch(console.error);
