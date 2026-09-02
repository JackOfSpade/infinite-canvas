import { assert, runJobApiProbe } from '../test-dependencies.js';

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
];
