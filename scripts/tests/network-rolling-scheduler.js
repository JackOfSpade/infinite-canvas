import { readFileSync } from 'node:fs';
import { assert } from '../test-dependencies.js';
import { runRollingWorkers } from '../../src/utils/handoffScheduler.js';

const diceExtractorSource = readFileSync(new URL('../../electron/extractors/apiExtractors.js', import.meta.url), 'utf8');
const stealthBrowserSource = readFileSync(new URL('../../electron/ipc/stealthBrowser.js', import.meta.url), 'utf8');

export default [{
  name: 'Network rolling workers refill a completed slot before a slow probe settles',
  run: async () => {
    const claims = [0, 1, 2];
    const started = [];
    let active = 0;
    let peak = 0;
    let releaseSlow;
    const scheduler = runRollingWorkers({
      workerCount: 2,
      claim: () => claims.shift() ?? null,
      work: async (index) => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        if (index === 0) await new Promise(resolve => { releaseSlow = resolve; });
        active -= 1;
      },
    });
    for (let attempt = 0; attempt < 100 && !started.includes(2); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert(started.join(',') === '0,1,2' && active === 1 && peak === 2,
      `a finished network probe must refill its slot while a sibling is slow, got ${JSON.stringify({ started, active, peak })}`);
    releaseSlow();
    await scheduler;
    assert(active === 0 && peak === 2, 'the rolling network roster must drain without exceeding its cap');
    return { startedBeforeSlowSettled: started.length, peak };
  },
}, {
  name: 'Network rolling workers stop claiming new probes after a cooperative early result',
  run: async () => {
    const claims = [0, 1, 2, 3];
    const started = [];
    let found = false;
    let releaseSlow;
    const scheduler = runRollingWorkers({
      workerCount: 2,
      claim: () => (found ? null : (claims.shift() ?? null)),
      work: async (index) => {
        started.push(index);
        if (index === 0) await new Promise(resolve => { releaseSlow = resolve; });
        if (index === 1) found = true;
      },
    });
    for (let attempt = 0; attempt < 100 && !found; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert(found && started.join(',') === '0,1' && claims.join(',') === '2,3',
      `a successful key probe must stop successor claims while active work drains, got ${JSON.stringify({ started, claims, found })}`);
    releaseSlow();
    await scheduler;
    assert(started.join(',') === '0,1', 'draining siblings after success must not start another probe');
    return { started, unclaimed: claims };
  },
}, {
  name: 'Dice network fan-outs use the shared rolling scheduler with ordered enrichment and cooperative key stop',
  run: () => {
    assert(diceExtractorSource.includes("import { runRollingWorkers } from '../../src/utils/handoffScheduler.js';")
      && diceExtractorSource.includes('const enriched = new Array(jobs.length);')
      && diceExtractorSource.includes('enriched[index] = await enrichOne();')
      && diceExtractorSource.includes('enriched.filter(job => job !== undefined)')
      && diceExtractorSource.includes('await runRollingWorkers({'),
    'Dice detail enrichment must use the shared rolling pool while preserving source-order partial results');
    assert(stealthBrowserSource.includes("import { runRollingWorkers } from '../../src/utils/handoffScheduler.js';")
      && stealthBrowserSource.includes('const fetchStop = new AbortController();')
      && stealthBrowserSource.includes('if (foundKey || nextBundleIndex >= bundleUrls.length) return null;')
      && stealthBrowserSource.includes('fetchStop.abort();')
      && stealthBrowserSource.includes('await runRollingWorkers({'),
    'Dice bundle probing must use the shared rolling pool and stop successor claims after the first key');
    return { detailPool: 'ordered rolling', bundlePool: 'early stopping rolling' };
  },
}];
