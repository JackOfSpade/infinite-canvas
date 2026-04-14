/**
 * Tier 2 Validation Test — checks if plain HTTP fetch (no browser) can
 * retrieve __NEXT_DATA__ or __PRELOADED_STATE__ from Wellfound and Swappa.
 *
 * If the fetch returns structured state data, the platform can be downgraded
 * from Tier 3 (Puppeteer) to Tier 2 (plain HTTP), saving ~100MB RAM per request.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function testTier2(name, url, stateVar) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`URL: ${url}`);
  console.log(`Looking for: ${stateVar}`);
  console.log('='.repeat(60));

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    console.log(`Status: ${res.status} ${res.statusText}`);
    console.log(`Final URL: ${res.url}`);
    console.log(`Content-Type: ${res.headers.get('content-type')}`);

    // Check for WAF challenge indicators
    const cfRay = res.headers.get('cf-ray');
    const server = res.headers.get('server');
    console.log(`Server: ${server || 'not set'}`);
    console.log(`CF-Ray: ${cfRay || 'none (no Cloudflare)'}`);

    if (res.status === 403 || res.status === 503) {
      console.log(`❌ BLOCKED — WAF returned ${res.status}. Tier 3 required.`);
      return { platform: name, tier: 3, reason: `WAF block: ${res.status}` };
    }

    const html = await res.text();
    console.log(`HTML length: ${html.length} bytes`);

    // Check for Cloudflare challenge page
    if (html.includes('cf-browser-verification') || html.includes('Checking your browser') || html.includes('cf_chl_opt')) {
      console.log(`❌ CLOUDFLARE CHALLENGE detected. Tier 3 required.`);
      return { platform: name, tier: 3, reason: 'Cloudflare JS challenge served' };
    }

    // Check for the target state variable
    const hasState = html.includes(stateVar);
    console.log(`${stateVar} present: ${hasState ? '✅ YES' : '❌ NO'}`);

    if (hasState) {
      // Try to extract and validate the state data
      let stateSize = 0;
      if (stateVar === '__NEXT_DATA__') {
        const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (match) {
          stateSize = match[1].length;
          try {
            const data = JSON.parse(match[1]);
            const hasPageProps = !!data?.props?.pageProps;
            console.log(`  → JSON parsed successfully (${stateSize} bytes)`);
            console.log(`  → pageProps present: ${hasPageProps}`);
            console.log(`  → Top-level keys: ${Object.keys(data).join(', ')}`);
            if (data.props?.pageProps) {
              console.log(`  → pageProps keys: ${Object.keys(data.props.pageProps).join(', ')}`);
            }
          } catch (e) {
            console.log(`  → JSON parse failed: ${e.message}`);
          }
        }
      } else if (stateVar === '__PRELOADED_STATE__') {
        const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
        if (match) {
          stateSize = match[1].length;
          try {
            const data = JSON.parse(match[1]);
            console.log(`  → JSON parsed successfully (${stateSize} bytes)`);
            console.log(`  → Top-level keys: ${Object.keys(data).join(', ')}`);
          } catch (e) {
            console.log(`  → JSON parse failed: ${e.message}`);
          }
        }
      }

      console.log(`\n✅ TIER 2 VIABLE — ${name} can use plain HTTP + ${stateVar}`);
      return { platform: name, tier: 2, reason: `${stateVar} accessible via plain HTTP`, stateSize };
    } else {
      // Check if we got meaningful HTML at all
      const hasTitle = html.includes('<title>');
      const hasBody = html.includes('<body');
      console.log(`  → Has <title>: ${hasTitle}`);
      console.log(`  → Has <body>: ${hasBody}`);

      // Maybe the state is under a different name?
      const stateVars = ['__NEXT_DATA__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__RELAY_STORE__', 'window.__data', '__INITIAL_STATE__'];
      console.log(`  → Checking for other state variables...`);
      for (const sv of stateVars) {
        if (html.includes(sv)) {
          console.log(`    → Found: ${sv}`);
        }
      }

      console.log(`\n❌ TIER 3 REQUIRED — ${stateVar} not found via plain HTTP`);
      return { platform: name, tier: 3, reason: `${stateVar} not in plain HTTP response` };
    }
  } catch (error) {
    console.log(`❌ FETCH FAILED: ${error.message}`);
    return { platform: name, tier: 3, reason: `Fetch error: ${error.message}` };
  }
}

async function main() {
  console.log('Tier 2 Validation Test — Wellfound & Swappa');
  console.log('Testing if plain HTTP fetch returns structured state data.\n');

  const results = [];

  // Test Wellfound (expected: __NEXT_DATA__)
  results.push(await testTier2(
    'Wellfound',
    'https://wellfound.com/role/software-engineer',
    '__NEXT_DATA__'
  ));

  // Test Swappa (expected: __PRELOADED_STATE__)
  results.push(await testTier2(
    'Swappa',
    'https://swappa.com/search?q=iphone+15+pro',
    '__PRELOADED_STATE__'
  ));

  // Also test with a second Swappa query pattern
  results.push(await testTier2(
    'Swappa (buy page)',
    'https://swappa.com/buy/apple-iphone-15-pro',
    '__PRELOADED_STATE__'
  ));

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  ${r.platform}: Tier ${r.tier} — ${r.reason}`);
  }
}

main().catch(console.error);
