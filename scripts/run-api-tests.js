import {
  fetchLinkedInJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
} from '../electron/extractors/apiExtractors.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_EXTRACTORS = {
  fetchLinkedInJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
};

/**
 * Run the independent live-provider checks and return their report.
 *
 * Extractors are injectable so the probe's completion/concurrency contract is
 * deterministic under the unit runner; the executable path below always uses
 * the production implementations.
 */
export async function runJobApiProbe(extractors = DEFAULT_EXTRACTORS) {
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

  // These are independent provider health checks. Starting them together keeps
  // the probe bounded by the slowest provider rather than serially adding four
  // transport timeouts — particularly important when a CI egress is blocked.
  await Promise.all([
    safeCall('LinkedIn', () => extractors.fetchLinkedInJobs(['software engineer'], null, 7)),
    safeCall('RemoteOK', () => extractors.fetchRemoteOKJobs(['engineer', 'developer'])),
    // WWR filters against job titles. "engineer" is a broad representative role
    // that keeps this live availability probe from failing simply because the
    // rolling feed has no frontend-titled opening at the moment.
    safeCall('WeWorkRemotely', () => extractors.fetchWeWorkRemotelyJobs(['engineer'])),
    safeCall('Dice', () => extractors.fetchDiceListings('software engineer', '', null, 7)),
  ]);

  console.log(JSON.stringify(results, null, 2));
  return { results, success: Object.values(results).every(result => result.success) };
}

// AbortSignal.timeout() deliberately uses an unref'ed timer. If a network stack
// drops every outbound connection before it creates a referenced socket (a
// common CI/sandbox failure mode), Node can therefore exit while `run()` is
// still awaiting the fetch promises. That produced a false green probe with
// only the opening banner and no source results. Keep one lightweight handle
// alive until the probe has reported its outcome; the extractor timeouts still
// bound the run, and the handle is always cleared before exit.
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const keepAlive = setInterval(() => {}, 60_000);
  runJobApiProbe()
    .then(({ success }) => {
      if (!success) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => clearInterval(keepAlive));
}
