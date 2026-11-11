import { assert, jobSearchNextAnchor, resolveJobSearchDateWindow } from '../test-dependencies.js';
import { buildJobSearchDateHistory } from '../../electron/ipc/bugReport/jobSearchDates.js';
import { completionTimestampIso } from '../../src/utils/completionTimestamp.js';
import { buildJobHubScrapeClearPatch } from '../../src/utils/jobSearchSplitClear.js';
import {
  buildSourceCoverageCommitPatch,
  jobSearchSourceAnchor,
  latestSourceCompletedAt,
  normalizeSourceCoverage,
  resolveJobSearchSourceWindows,
  serializeJobSearchWindow,
  sourcesBehindLatest,
} from '../../src/utils/jobSearchSourceCoverage.js';

const localDate = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);
const expectedWindow = (anchorTimestamp, anchorSource, now, initialLookbackDays) => serializeJobSearchWindow(
  resolveJobSearchDateWindow(anchorTimestamp, now, initialLookbackDays),
  anchorSource,
);

export default [
  {
    name: 'Job Search source coverage gives every platform the hub window when only hub history exists',
    run: () => {
      const nodeId = 'hub-source-coverage';
      const now = localDate(2026, 10, 20, 12);
      const coverageAt = localDate(2026, 10, 10, 9).getTime();
      const completedAt = localDate(2026, 10, 11, 8).getTime();
      const data = {
        hubState: 'done',
        lastSearchCoverageStartedAt: coverageAt,
        lastCompletedRunAt: completedAt,
      };
      const hubAnchor = jobSearchNextAnchor(data, nodeId);
      const result = resolveJobSearchSourceWindows(data, nodeId, ['alpha', 'alpha', 'beta'], now, 14);
      const expected = expectedWindow(coverageAt, 'last-coverage-start', now, 14);

      assert(hubAnchor.timestamp === coverageAt && hubAnchor.source === 'last-coverage-start',
        'the hub history anchor is the coverage start');
      assert(Object.keys(result.sourceWindows).length === 2,
        'duplicate source ids resolve to exactly one window each');
      assert(JSON.stringify(result.sourceWindows.alpha) === JSON.stringify(expected)
        && JSON.stringify(result.sourceWindows.beta) === JSON.stringify(expected),
      'platforms without their own bookmark inherit the hub window and its source label');
      assert(expected.startTimestamp === localDate(2026, 10, 10).getTime()
        && expected.anchorTimestamp === expected.startTimestamp
        && expected.completionTimestamp === coverageAt
        && expected.capped === false
        && expected.capReason === null
        && expected.providerLookbackDays === 11,
      'the inherited window starts at local midnight of the hub coverage date with its completion and horizon preserved');
      assert(JSON.stringify(result.runWindow) === JSON.stringify(expected),
        'the run window equals the shared hub window');
      assert(result.runAnchor.timestamp === coverageAt && result.runAnchor.source === 'last-coverage-start',
        'the run anchor is the hub anchor when no platform has a bookmark');
      return { sharedWindow: true, runWindow: result.runWindow.startTimestamp };
    },
  },
  {
    name: 'Job Search source coverage gives a newer platform bookmark a later start while the run keeps the broadest window',
    run: () => {
      const nodeId = 'hub-source-coverage-newer';
      const now = localDate(2026, 10, 20, 12);
      const hubCoverageAt = localDate(2026, 10, 5, 9).getTime();
      const sourceCoverageAt = localDate(2026, 10, 8, 9).getTime();
      const data = {
        hubState: 'done',
        lastSearchCoverageStartedAt: hubCoverageAt,
        lastCompletedRunAt: localDate(2026, 10, 6, 8).getTime(),
        sourceCoverage: {
          alpha: { coverageStartedAt: sourceCoverageAt, completedAt: localDate(2026, 10, 9).getTime(), runId: 'prior' },
        },
      };
      const alphaAnchor = jobSearchSourceAnchor(data, nodeId, 'alpha');
      const betaAnchor = jobSearchSourceAnchor(data, nodeId, 'beta');
      const result = resolveJobSearchSourceWindows(data, nodeId, ['alpha', 'beta'], now, 14);

      assert(alphaAnchor.timestamp === sourceCoverageAt && alphaAnchor.source === 'source-coverage',
        'a platform bookmark wins over the hub anchor and is labelled as source coverage');
      assert(betaAnchor.timestamp === hubCoverageAt && betaAnchor.source === 'last-coverage-start',
        'a platform without a bookmark falls back to the hub anchor');
      assert(result.sourceWindows.alpha.startTimestamp === localDate(2026, 10, 8).getTime(),
        'the booked platform starts at its own coverage date');
      assert(result.sourceWindows.beta.startTimestamp === localDate(2026, 10, 5).getTime(),
        'the unbooked platform still starts at the hub coverage date');
      assert(result.sourceWindows.alpha.startTimestamp > result.sourceWindows.beta.startTimestamp,
        'the newer bookmark produces a strictly later start');
      assert(JSON.stringify(result.runWindow) === JSON.stringify(result.sourceWindows.beta),
        'the run window is the earliest-starting (broadest) platform window');
      assert(result.runAnchor.timestamp === hubCoverageAt && result.runAnchor.source === 'last-coverage-start',
        'the run anchor comes from the broadest platform window');
      assert(Object.values(result.sourceWindows)
        .every(window => window.startTimestamp >= result.runWindow.startTimestamp),
      'no platform window starts before the run window');
      return { perSourceStarts: true, runBroadest: true };
    },
  },
  {
    name: 'Job Search source coverage commit seeds known platforms from pre-commit hub history and advances only completed ones',
    run: () => {
      const nodeId = 'hub-source-coverage-commit';
      const hubCoverageAt = localDate(2026, 10, 5, 9).getTime();
      const hubCompletedAt = localDate(2026, 10, 6, 8).getTime();
      const existingStart = localDate(2026, 9, 20, 9).getTime();
      const existingCompleted = localDate(2026, 9, 21, 8).getTime();
      const collectionStartedAt = localDate(2026, 10, 12, 9).getTime();
      const collectionCompletedAt = localDate(2026, 10, 13, 10).getTime();
      const data = {
        hubState: 'done',
        lastSearchCoverageStartedAt: hubCoverageAt,
        lastCompletedRunAt: hubCompletedAt,
        sourceCoverage: {
          existing: { coverageStartedAt: existingStart, completedAt: existingCompleted, runId: 'older-run' },
        },
      };
      const patch = buildSourceCoverageCommitPatch(data, {
        runId: 'run-2',
        collectionStartedAt,
        collectionCompletedAt,
        completedSourceIds: ['finished'],
        knownSourceIds: ['existing', 'finished', 'unfinished'],
      }, nodeId);
      const coverage = patch.sourceCoverage;

      assert(JSON.stringify(coverage.finished) === JSON.stringify({
        coverageStartedAt: collectionStartedAt,
        completedAt: collectionCompletedAt,
        runId: 'run-2',
      }), 'a completed platform advances to this run start and completion');
      assert(JSON.stringify(coverage.unfinished) === JSON.stringify({
        coverageStartedAt: hubCoverageAt,
        completedAt: hubCompletedAt,
        runId: null,
      }), 'a known but unfinished platform is seeded with the pre-commit hub bookmark');
      assert(JSON.stringify(coverage.existing) === JSON.stringify({
        coverageStartedAt: existingStart,
        completedAt: existingCompleted,
        runId: 'older-run',
      }), 'an existing platform bookmark is not reseeded from hub history');
      assert(Object.keys(coverage).length === 3,
        'the patch contains exactly the known and completed platforms');
      assert(Object.keys(data.sourceCoverage).length === 1 && !('unfinished' in data.sourceCoverage),
        'the original sourceCoverage map is never mutated');

      const noHistory = buildSourceCoverageCommitPatch({}, {
        runId: 'run-3',
        collectionStartedAt,
        collectionCompletedAt,
        completedSourceIds: ['finished'],
        knownSourceIds: ['finished', 'unfinished'],
      }, 'fresh-hub');
      assert(JSON.stringify(noHistory.sourceCoverage) === JSON.stringify({
        finished: {
          coverageStartedAt: collectionStartedAt,
          completedAt: collectionCompletedAt,
          runId: 'run-3',
        },
      }), 'without hub history only completed platforms receive bookmarks');
      return { seeded: true, advanced: true, noHistory: true };
    },
  },
  {
    name: 'Job Search source coverage bookmarks never move backward',
    run: () => {
      const nodeId = 'hub-source-coverage-backward';
      const start = localDate(2026, 10, 10, 9).getTime();
      const completed = localDate(2026, 10, 11, 9).getTime();
      const bookmarkStart = localDate(2026, 10, 15, 9).getTime();
      const bookmarkCompleted = localDate(2026, 10, 16, 9).getTime();
      const data = {
        lastSearchCoverageStartedAt: localDate(2026, 10, 1, 9).getTime(),
        lastCompletedRunAt: localDate(2026, 10, 2, 9).getTime(),
        sourceCoverage: {
          alpha: { coverageStartedAt: bookmarkStart, completedAt: bookmarkCompleted, runId: 'old-run' },
        },
      };
      const patch = buildSourceCoverageCommitPatch(data, {
        runId: 'new-run',
        collectionStartedAt: start,
        collectionCompletedAt: completed,
        completedSourceIds: ['alpha', 'gamma'],
        knownSourceIds: ['alpha', 'beta'],
      }, nodeId);
      const coverage = patch.sourceCoverage;

      assert(coverage.alpha.coverageStartedAt === bookmarkStart && coverage.alpha.completedAt === bookmarkCompleted,
        'an older run can never move an existing bookmark backward');
      assert(coverage.alpha.runId === 'new-run',
        'the completing run is still recorded when the bookmark dates stay put');
      assert(coverage.beta.coverageStartedAt === localDate(2026, 10, 1, 9).getTime()
        && coverage.beta.completedAt === localDate(2026, 10, 2, 9).getTime()
        && coverage.beta.runId === null,
      'an unfinished known platform keeps the pre-commit hub anchor');
      assert(coverage.gamma.coverageStartedAt === start && coverage.gamma.completedAt === completed,
        'a completed platform without a prior bookmark starts at this run');

      const invalidCompletion = buildSourceCoverageCommitPatch({}, {
        runId: 'fallback-run',
        collectionStartedAt: start,
        collectionCompletedAt: 'not-a-timestamp',
        completedSourceIds: ['gamma'],
        knownSourceIds: [],
      }, nodeId);
      assert(invalidCompletion.sourceCoverage.gamma.completedAt === start,
        'an invalid collection completion falls back to the normalized run start');
      return { backwardSafe: true, newSourceAdvanced: true, completionFallback: true };
    },
  },
  {
    name: 'Job Search source coverage normalization drops junk, prototype keys, and invalid timestamps',
    run: () => {
      const coverageStart = localDate(2026, 10, 3, 9).getTime();
      const fallbackCompleted = localDate(2026, 10, 4, 9).getTime();
      const raw = JSON.parse('{"__proto__":{"coverageStartedAt":1700000000000},"constructor":{"coverageStartedAt":1700000000000},"prototype":{"coverageStartedAt":1700000000000}}');
      raw.good = { coverageStartedAt: String(coverageStart), completedAt: 'invalid', runId: 'run-a' };
      raw.fallback = { coverageStartedAt: coverageStart, completedAt: fallbackCompleted, runId: '   ' };
      raw.missingStart = { completedAt: coverageStart };
      raw.invalidStart = { coverageStartedAt: 'abc', completedAt: coverageStart };
      raw.zeroStart = { coverageStartedAt: 0, completedAt: coverageStart };
      raw.negativeStart = { coverageStartedAt: -5 };
      raw.arrayEntry = [];
      raw.scalarEntry = 7;
      raw.nullEntry = null;
      raw[''] = { coverageStartedAt: coverageStart };

      const normalized = normalizeSourceCoverage(raw);
      assert(Object.prototype.hasOwnProperty.call(raw, '__proto__'),
        'the fixture really contains an own __proto__ key');
      assert(JSON.stringify(Object.keys(normalized)) === JSON.stringify(['good', 'fallback']),
        'only valid non-empty own keys with a usable coverage start survive');
      assert(normalized.good.coverageStartedAt === coverageStart
        && normalized.good.completedAt === coverageStart
        && normalized.good.runId === 'run-a',
      'a numeric string start normalizes and an invalid completion falls back to it');
      assert(normalized.fallback.completedAt === fallbackCompleted && normalized.fallback.runId === null,
        'a blank run id normalizes to null while a valid completion is kept');
      assert(!Object.prototype.hasOwnProperty.call(normalized, '__proto__')
        && !Object.prototype.hasOwnProperty.call(normalized, 'constructor')
        && !Object.prototype.hasOwnProperty.call(normalized, 'prototype'),
      'prototype keys are dropped instead of polluting the result');
      assert(Object.getPrototypeOf(normalized) === Object.prototype,
        'the normalized map is a plain object');
      assert(JSON.stringify(normalizeSourceCoverage(null)) === '{}'
        && JSON.stringify(normalizeSourceCoverage([])) === '{}'
        && JSON.stringify(normalizeSourceCoverage('not-an-object')) === '{}',
      'non-object input normalizes to an empty map');
      return { junkDropped: true, prototypeSafe: true };
    },
  },
  {
    name: 'Job Search source coverage commit refuses a patch without a valid collection start',
    run: () => {
      const data = {
        lastSearchCoverageStartedAt: localDate(2026, 10, 1, 9).getTime(),
        sourceCoverage: {
          alpha: { coverageStartedAt: localDate(2026, 9, 20).getTime(), completedAt: localDate(2026, 9, 21).getTime(), runId: 'old' },
        },
      };
      for (const collectionStartedAt of [null, undefined, '', 'not-a-timestamp', 0, -1]) {
        const patch = buildSourceCoverageCommitPatch(data, {
          runId: 'run-1',
          collectionStartedAt,
          collectionCompletedAt: localDate(2026, 10, 5).getTime(),
          completedSourceIds: ['alpha'],
          knownSourceIds: ['alpha', 'beta'],
        }, 'hub-source-coverage-no-start');
        assert(JSON.stringify(patch) === '{}',
          'an unusable collection start must produce no patch at all');
      }
      return { noStartRejected: true };
    },
  },
  {
    name: 'Job Search source coverage reports the latest completion and which platforms lag behind',
    run: () => {
      const nodeId = 'hub-source-coverage-lagging';
      const hubCompletedAt = localDate(2026, 10, 6, 8).getTime();
      const sourceAAt = localDate(2026, 10, 3, 9).getTime();
      const sourceBAt = localDate(2026, 10, 8, 9).getTime();
      const data = {
        lastCompletedRunAt: hubCompletedAt,
        sourceCoverage: {
          a: { coverageStartedAt: sourceAAt, completedAt: localDate(2026, 10, 4, 9).getTime(), runId: 'a-run' },
          b: { coverageStartedAt: sourceBAt, completedAt: localDate(2026, 10, 9, 9).getTime(), runId: 'b-run' },
        },
      };

      assert(latestSourceCompletedAt(data) === localDate(2026, 10, 9, 9).getTime(),
        'the newest platform completion beats the hub completion');
      assert(latestSourceCompletedAt({
        lastCompletedRunAt: localDate(2026, 10, 10, 8).getTime(),
        sourceCoverage: data.sourceCoverage,
      }) === localDate(2026, 10, 10, 8).getTime(),
      'a newer hub completion wins over every platform completion');
      assert(latestSourceCompletedAt({}) === null
        && latestSourceCompletedAt({ lastCompletedRunAt: 'bad', sourceCoverage: { a: { coverageStartedAt: 'bad' } } }) === null,
      'no usable completion anywhere reports null');

      const behind = sourcesBehindLatest(data, nodeId, ['a', 'b', 'c']);
      assert(JSON.stringify(behind) === JSON.stringify([
        { sourceId: 'a', coverageStartedAt: sourceAAt },
        { sourceId: 'c', coverageStartedAt: hubCompletedAt },
      ]), 'platforms older than the newest bookmark are listed oldest first, including hub fallbacks');
      assert(JSON.stringify(sourcesBehindLatest(data, nodeId, ['b', 'b', 'a']))
        === JSON.stringify([{ sourceId: 'a', coverageStartedAt: sourceAAt }]),
      'duplicate ids collapse and a single lagging platform is still reported');
      assert(JSON.stringify(sourcesBehindLatest(data, nodeId, ['a'])) === '[]'
        && JSON.stringify(sourcesBehindLatest(data, nodeId, [])) === '[]',
      'fewer than two platforms means nothing is behind');
      const equalAt = localDate(2026, 10, 12, 9).getTime();
      assert(JSON.stringify(sourcesBehindLatest({
        lastSearchCoverageStartedAt: equalAt,
        sourceCoverage: {
          a: { coverageStartedAt: equalAt, completedAt: equalAt },
          b: { coverageStartedAt: equalAt, completedAt: equalAt },
        },
      }, nodeId, ['a', 'b'])) === '[]',
      'equal bookmarks report no lagging platform');
      return { latestCompletion: true, laggingSorted: true };
    },
  },
  {
    name: 'JOBDATES prints one per-platform bookmark line per hub, sorted by platform id, and none without bookmarks',
    run: () => {
      const completedAt = localDate(2026, 10, 12, 9).getTime();
      const indeedStart = localDate(2026, 10, 11, 9).getTime();
      const googleStart = localDate(2026, 10, 10, 9).getTime();
      const report = buildJobSearchDateHistory([
        {
          id: 'h1',
          type: 'jobhub',
          data: {
            lastCompletedRunAt: completedAt,
            sourceCoverage: {
              // Insertion order is the reverse of the expected report order:
              // the report must sort ids instead of trusting object order.
              indeed: { coverageStartedAt: indeedStart, completedAt, runId: 'run-indeed' },
              google: { coverageStartedAt: googleStart, completedAt, runId: 'run-google' },
            },
          },
        },
        { id: 'h2', type: 'jobhub', data: { lastCompletedRunAt: completedAt } },
      ]);
      const lines = report.split('\n');
      const bookmarkLines = lines.filter(line => line.startsWith('  - Per-platform bookmarks: '));
      assert(bookmarkLines.length === 1,
        'only the hub that actually carries sourceCoverage prints a bookmark line');
      const expectedLine = `  - Per-platform bookmarks: google coverage start ${completionTimestampIso(googleStart)}`
        + ` · completed ${completionTimestampIso(completedAt)}; indeed coverage start ${completionTimestampIso(indeedStart)}`
        + ` · completed ${completionTimestampIso(completedAt)}.`;
      assert(bookmarkLines[0] === expectedLine,
        `the bookmark line lists sorted ids with their own dates (got ${JSON.stringify(bookmarkLines[0])})`);
      const hubLineIndexes = lines
        .map((line, index) => (line.startsWith('- Hub `') ? index : -1))
        .filter(index => index >= 0);
      assert(hubLineIndexes.length === 2, 'both hubs are reported');
      assert(lines[hubLineIndexes[0] + 1] === expectedLine,
        'the bookmark line follows the first hub line immediately');
      assert(!lines[hubLineIndexes[1] + 1].startsWith('  - Per-platform bookmarks:'),
        'the hub without sourceCoverage has no bookmark line');
      return { bookmarkLinePrinted: true, sorted: true };
    },
  },
  {
    name: 'Clear Scrape drops the transient per-platform staging and never the durable bookmarks',
    run: () => {
      const patch = buildJobHubScrapeClearPatch({}, { nodeId: 'hub-clear-source-coverage' });
      assert(patch.pendingSourceCoverage === null,
        'the clear patch nulls the transient pendingSourceCoverage staging');
      assert(!Object.prototype.hasOwnProperty.call(patch, 'sourceCoverage'),
        'the clear patch never writes sourceCoverage, so durable platform bookmarks survive');
      return { stagedCleared: true, durableKept: true };
    },
  },
];
