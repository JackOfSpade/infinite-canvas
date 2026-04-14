// Inspect the Dice API response structure
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const res = await fetch(
    'https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?q=software+engineer&countryCode2=US&radius=30&radiusUnit=mi&page=1&pageSize=5',
    {
      headers: {
        'User-Agent': UA,
        'x-api-key': '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8',
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  console.log(`Status: ${res.status}`);
  const data = await res.json();
  
  console.log('\nTop-level keys:', Object.keys(data));
  console.log('Total results:', data.meta?.totalHits || data.resultCount || 'unknown');
  
  if (data.data && data.data.length > 0) {
    console.log(`\nFirst job listing keys: ${Object.keys(data.data[0]).join(', ')}`);
    console.log('\nFirst listing (full):');
    console.log(JSON.stringify(data.data[0], null, 2));
  } else if (data.jobs && data.jobs.length > 0) {
    console.log(`\nFirst job listing keys: ${Object.keys(data.jobs[0]).join(', ')}`);
    console.log('\nFirst listing (full):');
    console.log(JSON.stringify(data.jobs[0], null, 2));
  } else {
    console.log('\nFull response (truncated):');
    console.log(JSON.stringify(data, null, 2).substring(0, 3000));
  }
}

main().catch(console.error);
