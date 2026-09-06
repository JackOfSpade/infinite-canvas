import { assert, runJobApiProbe } from '../test-dependencies.js';
import { runJobApiProbeCli } from '../run-api-tests.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function cliReport(stdout) {
  const jsonStart = stdout.indexOf('{\n');
  if (jsonStart < 0) throw new Error(`CLI did not emit a JSON report: ${stdout}`);
  return JSON.parse(stdout.slice(jsonStart));
}

export default [
  {
    name: 'job API availability probe starts independent sources together and always reports every outcome',
    run: async () => {
      const started = [];
      const settle = [];
      const deferred = (name, result) => () => new Promise(resolve => {
        started.push(name);
        settle.push(() => resolve(result));
      });
      const probe = runJobApiProbe({
        fetchLinkedInJobs: deferred('linkedin', { items: [{ title: 'Software Engineer', company: 'A', source: 'linkedin' }] }),
        fetchRemoteOKJobs: deferred('remoteok', { items: [{ title: 'Engineer', company: 'B', source: 'remoteok' }] }),
        fetchWeWorkRemotelyJobs: deferred('weworkremotely', { items: [{ title: 'Engineer', company: 'C', source: 'weworkremotely' }] }),
        fetchDiceListings: deferred('dice', { items: [], warning: { code: 'http-503', severity: 'block' } }),
      });

      // Promise.all invokes every producer before awaiting any of them. This
      // prevents a blocked CI egress from serially consuming four timeouts.
      await Promise.resolve();
      assert(started.length === 4, `expected all four probes to start together, got ${started.join(', ')}`);
      settle.forEach(resolve => resolve());

      const report = await probe;
      assert(Object.keys(report.results).length === 4
        && report.results.LinkedIn.success
        && report.results.RemoteOK.success
        && report.results.WeWorkRemotely.success
        && !report.results.Dice.success
        && !report.success,
      'the probe returns one result per source and propagates a blocking provider failure to its exit decision');
      return { concurrentlyStarted: started.length, reportedSources: Object.keys(report.results).length };
    },
  },
  {
    name: 'job API availability probe reports thrown and 429-style failures after every provider settles',
    run: async () => {
      const started = [];
      const settle = [];
      const deferred = (name, outcome) => () => new Promise((resolve, reject) => {
        started.push(name);
        settle.push(() => outcome instanceof Error ? reject(outcome) : resolve(outcome));
      });
      const reportLines = [];
      const originalLog = console.log;
      console.log = (...args) => reportLines.push(args.join(' '));
      try {
        const probe = runJobApiProbe({
          fetchLinkedInJobs: deferred('linkedin', new Error('fetch failed: offline')),
          fetchRemoteOKJobs: deferred('remoteok', { items: [], warning: { code: 'http-429', severity: 'throttle' } }),
          fetchWeWorkRemotelyJobs: deferred('weworkremotely', { items: [{ title: 'Engineer', company: 'C', source: 'weworkremotely' }] }),
          fetchDiceListings: deferred('dice', { items: [], warning: { code: 'config-missing', severity: 'info' } }),
        });

        await Promise.resolve();
        assert(started.length === 4, `expected all providers to start before a failure settled, got ${started.join(', ')}`);
        settle.forEach(resolve => resolve());
        const report = await probe;

        const jsonReport = reportLines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).find(Boolean);
        assert(!report.success
          && report.results.LinkedIn.error === 'fetch failed: offline'
          && !report.results.RemoteOK.success
          && report.results.Dice.success
          && report.results.Dice.skipped
          && Object.keys(jsonReport || {}).length === 4,
        `expected complete failure report after all providers settled, got ${JSON.stringify(report)}`);
        return { started: started.length, reportedSources: Object.keys(jsonReport).length };
      } finally {
        console.log = originalLog;
      }
    },
  },
  {
    name: 'job API availability probe fails a partial provider response with a throttle or fetch warning',
    run: async () => {
      const job = (source) => ({ title: 'Engineer', company: 'Example', source });
      const report = await runJobApiProbe({
        // A paginated provider can receive its first page and then be rate
        // limited. Retaining that page is useful in the report, but must not
        // turn a failed live availability check green.
        fetchLinkedInJobs: async () => ({
          items: [job('linkedin')],
          warning: { code: 'http-429', severity: 'throttle', evidence: 'LinkedIn API returned HTTP 429' },
        }),
        fetchRemoteOKJobs: async () => ({ items: [job('remoteok')] }),
        fetchWeWorkRemotelyJobs: async () => ({ items: [job('weworkremotely')] }),
        fetchDiceListings: async () => ({ items: [job('dice')] }),
      });

      assert(!report.success
        && !report.results.LinkedIn.success
        && report.results.LinkedIn.count === 1
        && report.results.LinkedIn.error.includes('http-429')
        && Object.values(report.results).filter(result => result.success).length === 3,
      `a partial 429/fetch warning must fail the complete probe, got ${JSON.stringify(report)}`);
      return { count: report.results.LinkedIn.count, error: report.results.LinkedIn.error };
    },
  },
  {
    name: 'job API availability probe times out a hung provider and still reports every normalized result',
    run: async () => {
      const aborted = [];
      const receivedSignals = [];
      const scheduled = [];
      const probe = runJobApiProbe({
        fetchLinkedInJobs: async (_queries, signal) => {
          receivedSignals.push(signal);
          return { items: [{ title: 'Engineer', company: 'A', source: 'linkedin' }] };
        },
        fetchRemoteOKJobs: (_queries, signal) => {
          receivedSignals.push(signal);
          return new Promise(() => {});
        },
        fetchWeWorkRemotelyJobs: async (_queries, signal) => {
          receivedSignals.push(signal);
          return { items: [{ title: 'Engineer', company: 'C', source: 'weworkremotely' }] };
        },
        fetchDiceListings: async (_query, _location, signal) => {
          receivedSignals.push(signal);
          return { items: [{ title: 'Engineer', company: 'D', source: 'dice' }] };
        },
      }, {
        timeoutMs: 1234,
        createAbortController: () => {
          const signal = { aborted: false };
          return {
            signal,
            abort: () => {
              signal.aborted = true;
              aborted.push(signal);
            },
          };
        },
        scheduleTimeout: callback => {
          scheduled.push(callback);
          return scheduled.length - 1;
        },
        cancelTimeout: () => {},
      });

      await Promise.resolve();
      assert(receivedSignals.length === 4 && scheduled.length === 4,
        `every provider must start and schedule its deadline before a timeout fires, got ${JSON.stringify({ signals: receivedSignals.length, timers: scheduled.length })}`);
      scheduled[1]();
      const report = await probe;

      const requiredFields = ['success', 'count', 'warning', 'error', 'sample'];
      const allResultsNormalized = Object.values(report.results).every(result => requiredFields
        .every(field => Object.hasOwn(result, field)));
      assert(!report.success
        && Object.keys(report.results).length === 4
        && report.results.RemoteOK.error === 'Provider probe timed out after 1234ms'
        && aborted.length === 1
        && receivedSignals.length === 4
        && aborted[0] === receivedSignals[1]
        && receivedSignals[1].aborted
        && allResultsNormalized,
      `a hung provider must time out without dropping results, got ${JSON.stringify({ report, aborted })}`);
      return { reportedSources: Object.keys(report.results).length, abortCalls: aborted.length };
    },
  },
  {
    name: 'job API availability probe handles a late provider rejection after timeout',
    run: async () => {
      const unhandled = [];
      const onUnhandled = error => unhandled.push(error);
      const scheduled = [];
      let rejectRemote;
      process.on('unhandledRejection', onUnhandled);
      try {
        const probe = runJobApiProbe({
          fetchLinkedInJobs: async () => ({ items: [{ title: 'Engineer', company: 'A', source: 'linkedin' }] }),
          fetchRemoteOKJobs: () => new Promise((resolve, reject) => { rejectRemote = reject; }),
          fetchWeWorkRemotelyJobs: async () => ({ items: [{ title: 'Engineer', company: 'C', source: 'weworkremotely' }] }),
          fetchDiceListings: async () => ({ items: [{ title: 'Engineer', company: 'D', source: 'dice' }] }),
        }, {
          timeoutMs: 5678,
          scheduleTimeout: callback => {
            scheduled.push(callback);
            return scheduled.length - 1;
          },
          cancelTimeout: () => {},
        });
        await Promise.resolve();
        assert(scheduled.length === 4 && typeof rejectRemote === 'function',
          `all provider deadlines must be registered before selecting the hung provider, got ${JSON.stringify({ timers: scheduled.length, hasReject: typeof rejectRemote })}`);
        scheduled[1]();
        const report = await probe;
        rejectRemote(new Error('late provider failure'));
        await new Promise(resolve => setImmediate(resolve));
        assert(report.results.RemoteOK.error === 'Provider probe timed out after 5678ms' && unhandled.length === 0,
          `late provider rejection must remain handled after timeout, got ${JSON.stringify({ report, unhandled: unhandled.map(String) })}`);
        return { timedOut: report.results.RemoteOK.error, unhandled: unhandled.length };
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  },
  {
    name: 'job API CLI keeps the process active through the final report and exits nonzero on probe failure',
    run: async () => {
      const lifecycle = [];
      const processRef = { exitCode: 0 };
      const report = await runJobApiProbeCli({
        extractors: {
          fetchLinkedInJobs: async () => ({ items: [{ title: 'Engineer', company: 'A', source: 'linkedin' }] }),
          fetchRemoteOKJobs: async () => ({ items: [{ title: 'Engineer', company: 'B', source: 'remoteok' }] }),
          fetchWeWorkRemotelyJobs: async () => ({ items: [{ title: 'Engineer', company: 'C', source: 'weworkremotely' }] }),
          fetchDiceListings: async () => { throw new Error('HTTP 429'); },
        },
        keepAlive: () => {
          lifecycle.push('started');
          return 'probe-handle';
        },
        clearKeepAlive: handle => lifecycle.push(`cleared:${handle}`),
        processRef,
      });

      assert(!report.success && processRef.exitCode === 1
        && lifecycle.join(',') === 'started,cleared:probe-handle',
      `CLI must retain the process until the complete failed report and then exit nonzero, got ${JSON.stringify({ report, processRef, lifecycle })}`);
      return { exitCode: processRef.exitCode, lifecycle };
    },
  },
  {
    name: 'job API CLI child process flushes a complete report and returns the probe exit status',
    run: async () => {
      const fixture = path.join(process.cwd(), 'scripts', 'tests', 'fixtures', 'job-api-probe-cli.mjs');
      const execute = mode => spawnSync(process.execPath, [
        '--import', './scripts/test-stubs/register.mjs', fixture, mode,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      const failed = execute('failure');
      const succeeded = execute('success');
      const failedReport = cliReport(failed.stdout || '');
      const succeededReport = cliReport(succeeded.stdout || '');
      const expectedSources = ['Dice', 'LinkedIn', 'RemoteOK', 'WeWorkRemotely'];

      assert(failed.status === 1
        && Object.keys(failedReport).sort().join(',') === expectedSources.join(',')
        && failedReport.RemoteOK.success === false
        && failedReport.RemoteOK.error === 'fake HTTP 429',
      `failed child must flush every source result and exit 1, got ${JSON.stringify({ status: failed.status, stdout: failed.stdout, stderr: failed.stderr })}`);
      assert(succeeded.status === 0
        && Object.keys(succeededReport).sort().join(',') === expectedSources.join(',')
        && Object.values(succeededReport).every(result => result.success),
      `successful child must flush every source result and exit 0, got ${JSON.stringify({ status: succeeded.status, stdout: succeeded.stdout, stderr: succeeded.stderr })}`);
      return { failureExit: failed.status, successExit: succeeded.status, sources: expectedSources.length };
    },
  },
];
