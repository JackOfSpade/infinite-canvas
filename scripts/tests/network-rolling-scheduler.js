import { readFileSync } from 'node:fs';
import { assert } from '../test-dependencies.js';
import { runRollingWorkers } from '../../src/utils/handoffScheduler.js';
import { registerNetworkHandlers, scanForTitle } from '../../electron/ipc/network.js';

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
  name: 'URL title fetch normalizes uppercase schemes and never scans past the first MiB of an oversized chunk',
  run: async () => {
    let titleHandler;
    registerNetworkHandlers({
      ipcMainInstance: { on: () => {}, handle: () => {} },
      registerHandler: (channel, handler) => {
        if (channel === 'fetch-url-title') titleHandler = handler;
      },
    });
    const previousFetch = globalThis.fetch;
    const visited = [];
    let reads = 0;
    let cancelled = 0;
    try {
      globalThis.fetch = async url => {
        visited.push(url);
        return {
          body: {
            getReader: () => ({
              read: async () => {
                reads += 1;
                // A single legal stream chunk can be larger than the scan cap.
                // The title beyond that cap must remain invisible.
                return { done: false, value: Buffer.from(`${'x'.repeat(1024 * 1024)}<title>Too late</title>`) };
              },
              cancel: async () => { cancelled += 1; },
            }),
          },
        };
      };
      const result = await titleHandler({ sender: { isDestroyed: () => false } }, '  HTTPS://example.test/path  ', new AbortController().signal);
      assert(visited.length === 1 && visited[0] === 'https://example.test/path',
        `uppercase HTTPS URL was changed incorrectly: ${JSON.stringify(visited)}`);
      assert(result.title === null && reads === 1 && cancelled === 1,
        'a title after the first MiB of one oversized chunk must not be read');
      return { normalizedUrl: visited[0], scannedChunks: reads, cancelled };
    } finally {
      globalThis.fetch = previousFetch;
    }
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
}, {
  name: 'Title scan over growing text finds the same title as one scan of the whole text',
  run: () => {
    const pieces = ['<title>', '</title>', '<title', '>', '<', '/', 'title', 'Name', ' x', '<b>', '</b>', 'TITLE', '<TITLE lang="en">', ' ', '\n', '</titl', '<div>'];
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let round = 0; round < 3000; round += 1) {
      let text = '';
      for (let count = Math.floor(random() * 9) + 1; count > 0; count -= 1) text += pieces[Math.floor(random() * pieces.length)];
      const whole = /<title[^>]*>([^<]+)<\/title>/i.exec(text);
      let grown = ''; let scanFrom = 0; let found = null;
      for (let at = 0; at < text.length && !found;) {
        const end = Math.min(text.length, at + 1 + Math.floor(random() * 6));
        grown += text.slice(at, end); at = end;
        const scan = scanForTitle(grown, scanFrom);
        found = scan.match; scanFrom = scan.scanFrom;
      }
      assert((found ? found[1] : null) === (whole ? whole[1] : null), `incremental scan matches the whole-text scan for ${JSON.stringify(text)}`);
    }
  },
}];
