// Check what state variables ARE present in eBay, Poshmark, Dice HTML
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STATE_VARS = [
  '__NEXT_DATA__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__RELAY_STORE__',
  '__INITIAL_STATE__', '__SSR_DATA__', '__NUXT__', 'window.__data',
  '"itemSummaries"', '"listingItems"', '"searchResults"', '"results":[{"id"',
  'application/ld+json', 'application/json',
];

async function checkState(name, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 400) { console.log(`${name}: ${res.status} — skipped`); return; }
    const html = await res.text();
    console.log(`\n${name}: ${res.status} (${html.length} bytes)`);
    
    for (const sv of STATE_VARS) {
      const count = (html.match(new RegExp(sv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (count > 0) console.log(`  ✅ ${sv}: ${count} occurrences`);
    }
    
    // Check for JSON-LD structured data
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    if (ldMatch) {
      console.log(`  ✅ JSON-LD scripts: ${ldMatch.length} found`);
      // Show first one truncated
      const first = ldMatch[0].replace(/<\/?script[^>]*>/g, '').trim();
      try {
        const data = JSON.parse(first);
        console.log(`    Type: ${data['@type'] || 'unknown'}`);
      } catch {}
    }

    // Check eBay-specific inline JSON
    if (name.includes('eBay')) {
      const srp = html.match(/"itemSummaries"\s*:\s*\[/);
      const items = html.match(/"searchResults"\s*:\s*\{/);
      const listing = html.match(/"items"\s*:\s*\[/);
      if (srp) console.log('  ✅ eBay itemSummaries found in HTML!');
      if (items) console.log('  ✅ eBay searchResults found in HTML!');
      if (listing) console.log('  ✅ eBay items array found in HTML!');
    }
  } catch (e) { console.log(`${name}: ERROR: ${e.message}`); }
}

async function main() {
  console.log('State variable audit for Tier 3 platforms that return 200\n');
  await checkState('eBay', 'https://www.ebay.com/sch/i.html?_nkw=iphone+15+pro');
  await checkState('Poshmark', 'https://poshmark.com/search?query=nike+shoes&type=listings');
  await checkState('Dice', 'https://www.dice.com/jobs?q=software+engineer');
  await checkState('Google', 'https://www.google.com/search?q=software+engineer+jobs&ibp=htl;jobs');
}

main().catch(console.error);
