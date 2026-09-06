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

// LinkedIn's paced guest-feed walk can legitimately take around a minute when
// it reaches its page ceiling, and Dice can spend roughly that long on its
// retry/recovery path. Keep the live probe generous, while still giving a
// black-holed provider a hard terminal outcome.
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

const PROBE_CALLS = [
  ['LinkedIn', (extractors, signal) => extractors.fetchLinkedInJobs(['software engineer'], signal, 7)],
  ['RemoteOK', (extractors, signal) => extractors.fetchRemoteOKJobs(['engineer', 'developer'], signal)],
  // WWR filters against job titles. "engineer" is a broad representative role
  // that keeps this live availability probe from failing simply because the
  // rolling feed has no frontend-titled opening at the moment.
  ['WeWorkRemotely', (extractors, signal) => extractors.fetchWeWorkRemotelyJobs(['engineer'], signal)],
  ['Dice', (extractors, signal) => extractors.fetchDiceListings('software engineer', '', signal, 7)],
];

function errorMessage(error) {
  if (error?.message) return String(error.message);
  return String(error);
}

function failureResult(error) {
  return {
    success: false,
    count: 0,
    warning: null,
    error,
    sample: null,
  };
}

function warningFailureMessage(warning) {
  if (!warning || warning?.severity === 'info') return null;
  const code = typeof warning?.code === 'string' && warning.code.trim()
    ? warning.code.trim()
    : 'provider-warning';
  const evidence = typeof warning?.evidence === 'string' && warning.evidence.trim()
    ? `: ${warning.evidence.trim()}`
    : '';
  return `Source reported ${code}${evidence}`;
}

function providerTimeoutMs(value) {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_TIMEOUT_MS;
}

function providerAbortController() {
  return typeof AbortController === 'function' ? new AbortController() : null;
}

/**
 * Run the independent live-provider checks and return their report.
 *
 * Extractors are injectable so the probe's completion/concurrency contract is
 * deterministic under the unit runner; the executable path below always uses
 * the production implementations.
 */
export async function runJobApiProbe(extractors = DEFAULT_EXTRACTORS, {
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  createAbortController = providerAbortController,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  console.log('Testing job API extractors...');
  const deadlineMs = providerTimeoutMs(timeoutMs);

  const safeCall = async (name, fn) => {
    let controller = null;
    let timer = null;
    try {
      controller = createAbortController?.() || null;
      const provider = Promise.resolve().then(() => fn(controller?.signal || null));
      const timedOut = new Promise(resolve => {
        timer = scheduleTimeout(() => {
          controller?.abort();
          resolve(true);
        }, deadlineMs);
      });
      const settled = await Promise.race([
        provider.then(data => ({ data })),
        timedOut.then(() => ({ timedOut: true })),
      ]);
      if (settled.timedOut) {
        return [name, failureResult(`Provider probe timed out after ${deadlineMs}ms`)];
      }

      const data = settled.data;
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      const warning = Array.isArray(data) ? null : (data?.warning || null);
      // `skipped` and info warnings are intentional opt-outs (for example, an
      // optional provider with no configured credential). Every other warning
      // means the provider did not complete cleanly. In particular, a walk can
      // collect a first page and then receive an HTTP 429/fetch failure; those
      // partial items are useful diagnostics, not a successful availability
      // probe.
      const skipped = !Array.isArray(data) && (data?.skipped === true || warning?.severity === 'info');
      const warningFailure = skipped ? null : warningFailureMessage(warning);
      const emptyWithoutExplanation = items.length === 0 && !skipped && !warningFailure;
      return [name, {
        success: skipped || (!warningFailure && !emptyWithoutExplanation),
        count: items.length,
        warning,
        ...(skipped ? { skipped: true } : {}),
        error: warningFailure || (emptyWithoutExplanation ? 'Source returned zero jobs without a provider warning' : null),
        sample: items[0] ? {
          title: items[0].title,
          company: items[0].company,
          source: items[0].source,
        } : null,
      }];
    } catch (error) {
      return [name, failureResult(errorMessage(error))];
    } finally {
      if (timer !== null) cancelTimeout(timer);
    }
  };

  // These are independent provider health checks. Starting them together keeps
  // the probe bounded by the slowest provider rather than serially adding four
  // transport timeouts — particularly important when a CI egress is blocked.
  const results = Object.fromEntries(await Promise.all(
    PROBE_CALLS.map(([name, call]) => safeCall(name, signal => call(extractors, signal))),
  ));

  console.log(JSON.stringify(results, null, 2));
  return { results, success: Object.values(results).every(result => result.success) };
}

/**
 * Keep the CLI process alive until every provider has settled and the report is
 * printed. The injectable hooks make that lifecycle testable without a live
 * network probe or a child process.
 */
export async function runJobApiProbeCli({
  extractors = DEFAULT_EXTRACTORS,
  timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  keepAlive = () => setInterval(() => {}, 60_000),
  clearKeepAlive = clearInterval,
  processRef = process,
} = {}) {
  const handle = keepAlive();
  try {
    const report = await runJobApiProbe(extractors, { timeoutMs });
    if (!report.success) processRef.exitCode = 1;
    return report;
  } catch (error) {
    // Provider failures are converted to source results above. If the runner
    // itself fails, still provide the same complete machine-readable report
    // shape rather than ending on a lone stack trace.
    const message = errorMessage(error);
    const results = Object.fromEntries(PROBE_CALLS.map(([name]) => [name, failureResult(message)]));
    const report = { results, success: false };
    console.log(JSON.stringify(results, null, 2));
    processRef.exitCode = 1;
    return report;
  } finally {
    clearKeepAlive(handle);
  }
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
  runJobApiProbeCli();
}
