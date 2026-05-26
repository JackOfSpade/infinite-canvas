import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  EBAY_ACTIVE_EXTRACTOR,
  EBAY_SOLD_EXTRACTOR,
  MERCARI_SOLD_EXTRACTOR,
  POSHMARK_SOLD_EXTRACTOR,
} from '../electron/extractors/marketplace.js';
import { GOOGLE_JOBS_EXTRACTOR } from '../electron/extractors/jobs.js';
import {
  getJobHubTransientKeysForSave,
  SELLHUB_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
} from '../src/utils/persistenceTransientState.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  const result = dom.window.eval(extractor);
  assert(Array.isArray(result), `${name}: extractor did not return an array`);
  assert(result.length >= minCount, `${name}: expected at least ${minCount} result(s), got ${result.length}`);
  if (sampleAssert) sampleAssert(result[0], result);
  return { count: result.length, sample: result[0] };
}

function runZeroResultFixtureTest({ name, file, extractor }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  const result = dom.window.eval(extractor);
  assert(Array.isArray(result), `${name}: extractor did not return an array`);
  assert(result.length === 0, `${name}: expected 0 results, got ${result.length}`);
  return { count: result.length };
}

const tests = [
  {
    name: 'eBay sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay sold fixture',
      file: 'ebay-body.html',
      extractor: EBAY_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-sold', 'eBay sold fixture: wrong source id');
        assert(sample.title && sample.price > 0 && sample.soldDate, 'eBay sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'eBay active fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay active fixture',
      file: 'ebay-body.html',
      extractor: EBAY_ACTIVE_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-active', 'eBay active fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'eBay active fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Mercari sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Mercari sold fixture',
      file: 'mercari-body.html',
      extractor: MERCARI_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'mercari', 'Mercari sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Mercari sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Poshmark sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Poshmark sold fixture',
      file: 'poshmark-body.html',
      extractor: POSHMARK_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'poshmark', 'Poshmark sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Poshmark sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Google captcha fixture',
    run: () => runZeroResultFixtureTest({
      name: 'Google captcha fixture',
      file: 'google-jobs.html',
      extractor: GOOGLE_JOBS_EXTRACTOR,
    }),
  },
  {
    name: 'Transient jobhub save rules',
    run: () => {
      const normal = getJobHubTransientKeysForSave('searching');
      const sourcesReady = getJobHubTransientKeysForSave('sources-ready');
      assert(normal.includes('scrapeWarnings'), 'Transient jobhub save rules: default state should strip scrapeWarnings');
      assert(normal.includes('pendingTargetRole'), 'Transient jobhub save rules: default state should strip pendingTargetRole');
      assert(!sourcesReady.includes('scrapeWarnings'), 'Transient jobhub save rules: sources-ready should preserve scrapeWarnings');
      assert(sourcesReady.includes('errorMessage') && sourcesReady.includes('isRateLimit'), 'Transient jobhub save rules: sources-ready should still strip banners');
      return { normal, sourcesReady };
    },
  },
  {
    name: 'Transient state constants',
    run: () => {
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('searching'), 'Transient state constants: missing searching');
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('researching'), 'Transient state constants: missing researching');
      assert(SELLHUB_TRANSIENT_KEYS.includes('platformFitPending'), 'Transient state constants: missing platformFitPending');
      return {
        transientStates: TRANSIENT_PROCESSING_HUB_STATES.length,
        sellhubKeys: SELLHUB_TRANSIENT_KEYS.length,
      };
    },
  },
];

async function run() {
  let passed = 0;
  let failed = 0;

  console.log('\n[TEST RUNNER] Deterministic smoke tests\n');

  for (const test of tests) {
    try {
      const details = await test.run();
      console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
      passed++;
    } catch (error) {
      console.error(`FAIL ${test.name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n[TEST RUNNER] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error('[TEST RUNNER] Fatal error:', error);
  process.exitCode = 1;
});
