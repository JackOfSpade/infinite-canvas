/**
 * Tier Upgrade Audit — Test all Tier 3 platforms for Tier 1/2 paths.
 * Checks: plain HTTP for __NEXT_DATA__, known API endpoints, RSS feeds.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function testHTTP(name, url, lookFor) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    
    const status = res.status;
    const server = res.headers.get('server') || 'unknown';
    const cf = res.headers.get('cf-ray') ? 'YES' : 'no';
    
    if (status >= 400) {
      console.log(`  ${name}: ❌ ${status} (server: ${server}, CF: ${cf})`);
      return { name, tier: 3, reason: `HTTP ${status}` };
    }
    
    const html = await res.text();
    const hasTarget = lookFor.some(v => html.includes(v));
    const found = lookFor.filter(v => html.includes(v));
    
    console.log(`  ${name}: ${status} (${html.length}b, server: ${server}, CF: ${cf})`);
    console.log(`    Targets found: ${found.length > 0 ? found.join(', ') : 'NONE'}`);
    
    if (hasTarget) {
      return { name, tier: 2, reason: `Found: ${found.join(', ')}` };
    }
    return { name, tier: 3, reason: 'No state data in plain HTTP response' };
  } catch (e) {
    console.log(`  ${name}: ❌ ERROR: ${e.message}`);
    return { name, tier: 3, reason: e.message };
  }
}

async function testAPI(name, url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(10000),
    });
    
    const status = res.status;
    const ct = res.headers.get('content-type') || '';
    
    if (status >= 400) {
      console.log(`  ${name} API: ❌ ${status}`);
      return { name, tier: null, reason: `API ${status}` };
    }
    
    const body = await res.text();
    const isJSON = ct.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[');
    
    console.log(`  ${name} API: ${status} (${body.length}b, JSON: ${isJSON})`);
    if (isJSON && body.length > 100) {
      return { name, tier: 1, reason: `API returns JSON (${body.length}b)` };
    }
    return { name, tier: null, reason: 'Not useful JSON' };
  } catch (e) {
    console.log(`  ${name} API: ❌ ${e.message}`);
    return { name, tier: null, reason: e.message };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TIER UPGRADE AUDIT — Can any Tier 3 platform go higher? ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results = [];

  // ── Tier 3 Platforms: Test plain HTTP for state data ─────────────────
  console.log('── Plain HTTP Tests (can we skip the browser?) ──\n');

  results.push(await testHTTP('Google Jobs', 'https://www.google.com/search?q=software+engineer+jobs&ibp=htl;jobs', 
    ['__NEXT_DATA__', '"job_listings"', '"jobs_results"']));

  results.push(await testHTTP('Indeed', 'https://www.indeed.com/jobs?q=software+engineer&l=remote',
    ['__NEXT_DATA__', '__PRELOADED_STATE__', 'mosaic-provider-jobcards']));

  results.push(await testHTTP('ZipRecruiter', 'https://www.ziprecruiter.com/jobs-search?search=software+engineer',
    ['__NEXT_DATA__', '__PRELOADED_STATE__']));

  results.push(await testHTTP('Glassdoor', 'https://www.glassdoor.com/Job/software-engineer-jobs-SRCH_KO0,17.htm',
    ['__NEXT_DATA__', 'apolloCache', 'apolloState']));

  results.push(await testHTTP('Dice', 'https://www.dice.com/jobs?q=software+engineer',
    ['__NEXT_DATA__', '__PRELOADED_STATE__']));

  results.push(await testHTTP('eBay', 'https://www.ebay.com/sch/i.html?_nkw=iphone+15+pro',
    ['__NEXT_DATA__', '__PRELOADED_STATE__', '"itemSummaries"', '"listingItems"']));

  results.push(await testHTTP('Poshmark', 'https://poshmark.com/search?query=nike+shoes&type=listings',
    ['__PRELOADED_STATE__', '__NEXT_DATA__']));

  results.push(await testHTTP('Mercari', 'https://www.mercari.com/search/?keyword=iphone%2015%20pro',
    ['__NEXT_DATA__', '__PRELOADED_STATE__']));

  // ── Known API endpoints: Test for Tier 1 paths ─────────────────────
  console.log('\n── API Endpoint Tests (hidden/undocumented APIs) ──\n');

  // Indeed mobile API (used by the Indeed app)
  results.push(await testAPI('Indeed Mobile API', 
    'https://apis.indeed.com/ads/apisearch?publisher=&q=software+engineer&l=remote&format=json&v=2'));

  // Dice undocumented API
  results.push(await testAPI('Dice API',
    'https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?q=software+engineer&countryCode2=US&radius=30&radiusUnit=mi&page=1&pageSize=20',
    { 'x-api-key': '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8' })); // Known public key

  // Google Serpapi-style (public Google Jobs API doesn't exist)
  // eBay Browse API (requires registration — noting for reference)
  
  // Poshmark internal API
  results.push(await testAPI('Poshmark API',
    'https://poshmark.com/api/posts?filters[department]=Women&filters[category_v2]=Shoes&query=nike&max_id=1&count=24',
    { 'Accept': 'application/json' }));

  // Mercari API
  results.push(await testAPI('Mercari API',
    'https://www.mercari.com/v1/api/items/search?query=iphone%2015%20pro&num_results=20',
    { 'Accept': 'application/json' }));

  // eBay Finding API (public, no auth needed for basic search)
  results.push(await testAPI('eBay Finding API',
    'https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findItemsByKeywords&SERVICE-VERSION=1.0.0&RESPONSE-DATA-FORMAT=JSON&keywords=iphone+15+pro&paginationInput.entriesPerPage=10'));

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('RESULTS SUMMARY');
  console.log('══════════════════════════════════════════════════════════');
  
  const upgrades = results.filter(r => r.tier !== null && r.tier !== 3);
  const confirmed = results.filter(r => r.tier === 3 || r.tier === null);
  
  if (upgrades.length > 0) {
    console.log('\n🔼 POTENTIAL UPGRADES:');
    for (const r of upgrades) {
      console.log(`  ${r.name}: → Tier ${r.tier} (${r.reason})`);
    }
  }
  
  console.log('\n✅ CONFIRMED Tier 3 (no upgrade path):');
  for (const r of confirmed) {
    console.log(`  ${r.name}: Tier 3 — ${r.reason}`);
  }
}

main().catch(console.error);
