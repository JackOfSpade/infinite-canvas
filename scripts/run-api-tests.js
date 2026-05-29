import {
  fetchLinkedInJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
  fetchGreenhouseJobs,
  fetchLeverJobs,
} from '../electron/extractors/apiExtractors.js';

async function run() {
  console.log('Testing job API extractors...');
  const results = {};

  const safeCall = async (name, fn) => {
    try {
      const data = await fn();
      const items = Array.isArray(data) ? data : (data?.items || []);
      const warning = Array.isArray(data) ? null : (data?.warning || null);
      const emptyWithoutWarning = items.length === 0 && warning?.severity !== 'block';
      results[name] = {
        success: warning?.severity !== 'block' && !emptyWithoutWarning,
        count: items.length,
        warning,
        error: emptyWithoutWarning ? 'Source returned zero jobs without a blocking warning' : undefined,
        sample: items[0] ? {
          title: items[0].title,
          company: items[0].company,
          source: items[0].source,
        } : null,
      };
    } catch (e) {
      results[name] = { success: false, error: e.message };
    }
  };

  await safeCall('LinkedIn', () => fetchLinkedInJobs(['software engineer'], null, 7));
  await safeCall('RemoteOK', () => fetchRemoteOKJobs(['engineer', 'developer']));
  await safeCall('WeWorkRemotely', () => fetchWeWorkRemotelyJobs(['frontend']));
  await safeCall('Dice', () => fetchDiceListings('software engineer', '', null, 7));
  await safeCall('Greenhouse', () => fetchGreenhouseJobs(['software engineer']));
  await safeCall('Lever', () => fetchLeverJobs(['software engineer']));

  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results).some(r => !r.success)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
