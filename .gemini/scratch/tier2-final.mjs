// Final validation: Poshmark __INITIAL_STATE__ and eBay data
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  // ── Poshmark ──
  console.log('═══ Poshmark ═══');
  const pm = await fetch('https://poshmark.com/search?query=nike+shoes&type=listings', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  const pmHtml = await pm.text();
  
  // Poshmark uses __INITIAL_STATE__={...} (no quotes, raw JS)
  // We need to find the boundary — it ends at </script>
  const pmIdx = pmHtml.indexOf('__INITIAL_STATE__=');
  if (pmIdx !== -1) {
    const start = pmIdx + '__INITIAL_STATE__='.length;
    const scriptEnd = pmHtml.indexOf('</script>', start);
    let stateStr = pmHtml.substring(start, scriptEnd).trim();
    // Remove trailing semicolons
    if (stateStr.endsWith(';')) stateStr = stateStr.slice(0, -1);
    
    try {
      const state = JSON.parse(stateStr);
      console.log('✅ Parsed! Top keys:', Object.keys(state).join(', '));
      console.log('Size:', stateStr.length, 'bytes');
      
      // Find search/listing data
      for (const [k, v] of Object.entries(state)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const subKeys = Object.keys(v).join(', ');
          if (subKeys.includes('data') || subKeys.includes('items') || subKeys.includes('listing') || subKeys.includes('results')) {
            console.log(`  Key "${k}": ${subKeys.substring(0, 200)}`);
          }
        }
      }
      
      // Check for search results specifically
      if (state.search) {
        console.log('\n  search keys:', Object.keys(state.search).join(', '));
        if (state.search.data) {
          const count = Array.isArray(state.search.data) ? state.search.data.length : 'not array';
          console.log('  search.data items:', count);
          if (Array.isArray(state.search.data) && state.search.data[0]) {
            console.log('  First item keys:', Object.keys(state.search.data[0]).join(', '));
            console.log('  Sample:', JSON.stringify(state.search.data[0], null, 2).substring(0, 500));
          }
        }
      }
      
      // Check for feed
      if (state.feed) {
        console.log('\n  feed keys:', Object.keys(state.feed).join(', '));
      }
    } catch (e) {
      console.log('❌ Parse failed:', e.message);
      console.log('Start:', stateStr.substring(0, 200));
    }
  }
  
  // ── eBay ──
  console.log('\n═══ eBay ═══');
  const eb = await fetch('https://www.ebay.com/sch/i.html?_nkw=iphone+15+pro', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  const ebHtml = await eb.text();
  
  // Look for all JSON-LD blocks
  const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  let ldCount = 0;
  while ((match = ldRegex.exec(ebHtml)) !== null) {
    ldCount++;
    try {
      const ld = JSON.parse(match[1]);
      console.log(`JSON-LD #${ldCount}: @type=${ld['@type']}, items=${ld.itemListElement?.length || 'N/A'}`);
      if (ld.itemListElement?.[0]) {
        console.log('  First item:', JSON.stringify(ld.itemListElement[0], null, 2).substring(0, 300));
      }
    } catch (e) { console.log(`JSON-LD #${ldCount}: parse error`, e.message.substring(0, 100)); }
  }
  
  // Look for srp-results or similar data blobs
  const srpMatch = ebHtml.match(/"srp-river-results"[\s\S]{0,50}?"items"\s*:\s*\[([\s\S]*?)\]\s*}/);
  if (srpMatch) {
    console.log('\n✅ Found SRP results items!');
  }
  
  // Check for s-item class (DOM pattern)
  const sItems = (ebHtml.match(/class="s-item/g) || []).length;
  console.log(`DOM s-item elements: ${sItems}`);
  
  // ── Dice API already confirmed ──
  console.log('\n═══ Dice API (already confirmed Tier 1) ═══');
  console.log('✅ Public JSON API at job-search-api.svc.dhigroupinc.com');
  console.log('   Returns: title, company, location, salary, summary, URL, etc.');
}

main().catch(console.error);
