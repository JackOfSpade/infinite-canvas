import {
  fetchLinkedInJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
  fetchStockXListings,
  fetchReverbListings
} from '../electron/extractors/apiExtractors.js';

async function run() {
  console.log('Testing API extractors...');
  const results = {};

  const safeCall = async (name, fn) => {
    try {
      const data = await fn();
      results[name] = { success: true, count: Array.isArray(data) ? data.length : 'unknown', sample: data[0] };
    } catch (e) {
      results[name] = { success: false, error: e.message };
    }
  };

  await safeCall('LinkedIn', () => fetchLinkedInJobs('software engineer'));
  await safeCall('RemoteOK', () => fetchRemoteOKJobs('react'));
  await safeCall('WeWorkRemotely', () => fetchWeWorkRemotelyJobs('frontend'));
  await safeCall('Dice', () => fetchDiceListings('software engineer'));
  await safeCall('StockX', () => fetchStockXListings('iphone 15 pro', false));
  await safeCall('Reverb', () => fetchReverbListings('fender stratocaster', true));

  console.log(JSON.stringify(results, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
