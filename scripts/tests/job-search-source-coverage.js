import { assert, jobSearchNextAnchor, resolveJobSearchDateWindow } from '../test-dependencies.js';
import { buildJobSearchDateHistory } from '../../electron/ipc/bugReport/jobSearchDates.js';
import { completionTimestampIso } from '../../src/utils/completionTimestamp.js';
import { buildJobHubScrapeClearPatch } from '../../src/utils/jobSearchSplitClear.js';
import { collectionEvidenceForSnapshot } from '../../electron/ipc/jobs.js';
import { sanitizeJobRunCollectionDiagnostics } from '../../electron/ipc/jobRunStaging.js';
import { sanitizeJobSearchDateDiagnostics } from '../../src/utils/jobSearchDateDiagnostics.js';
import fs from 'node:fs';
import { didDetailBlockReprobeRecover } from '../../electron/ipc/browser/manualScraper.js';
import { formatPipelineState } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import {
  __resetJobsTelemetryForTests,
  getJobsTelemetry,
  recordRunCompletedWithUnfinishedSources,
} from '../../electron/ipc/jobs.js';
import {
  buildCollectionEvidenceCommitPatch,
  buildSourceCoverageCommitPatch,
  coverageSourceIdsForLocation,
  JOB_SOURCE_RESCRAPE_INTERVAL_MS,
  jobSearchSourceAnchor,
  latestSourceCompletedAt,
  normalizeSourceCoverage,
  partitionSourcesByRescrapeAge,
  resolveJobSearchSourceWindows,
  serializeJobSearchWindow,
  sourceFinishedQueriesForRun,
  sourcesBehindLatest,
  sourcesWithoutDateProgress,
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
  {
    name: 'Job Search rescrape interval partitions platforms into fresh and due by their own completed scrape',
    run: () => {
      assert(JOB_SOURCE_RESCRAPE_INTERVAL_MS === 24 * 60 * 60 * 1000,
        'the rescrape interval is exactly twenty-four hours');
      const nowDate = localDate(2026, 10, 20, 12);
      const nowMs = nowDate.getTime();
      const almostADay = JOB_SOURCE_RESCRAPE_INTERVAL_MS - 60 * 1000;
      const freshCompletedAt = nowMs - almostADay;
      const data = {
        // A fresh hub-level completion says nothing about the platforms a run
        // selected, so it must never make one of them fresh on its own.
        lastCompletedRunAt: nowMs - 1000,
        sourceCoverage: {
          freshPlatform: {
            coverageStartedAt: freshCompletedAt - 60 * 60 * 1000,
            completedAt: freshCompletedAt,
            runId: 'run-fresh',
          },
          exactlyADay: {
            coverageStartedAt: nowMs - 2 * JOB_SOURCE_RESCRAPE_INTERVAL_MS,
            completedAt: nowMs - JOB_SOURCE_RESCRAPE_INTERVAL_MS,
          },
          older: {
            coverageStartedAt: nowMs - 4 * JOB_SOURCE_RESCRAPE_INTERVAL_MS,
            completedAt: nowMs - 3 * JOB_SOURCE_RESCRAPE_INTERVAL_MS,
          },
          future: {
            coverageStartedAt: nowMs - 60 * 1000,
            completedAt: nowMs + 60 * 1000,
          },
          noStart: { completedAt: nowMs - 1000 },
        },
      };
      const ids = [
        'freshPlatform',
        'exactlyADay',
        'hubOnly',
        'freshPlatform',
        'older',
        'future',
        'noStart',
      ];
      const partition = partitionSourcesByRescrapeAge(data, ids, nowDate);

      assert(JSON.stringify(partition.fresh) === JSON.stringify([
        {
          sourceId: 'freshPlatform',
          completedAt: freshCompletedAt,
          nextEligibleAt: freshCompletedAt + JOB_SOURCE_RESCRAPE_INTERVAL_MS,
        },
      ]), `only a completed scrape under twenty-four hours old is fresh (got ${JSON.stringify(partition.fresh)})`);
      assert(partition.fresh[0].nextEligibleAt === freshCompletedAt + JOB_SOURCE_RESCRAPE_INTERVAL_MS
        && partition.fresh[0].nextEligibleAt > nowMs,
      'a fresh platform carries the exact time it becomes eligible again');
      assert(JSON.stringify(partition.due) === JSON.stringify([
        'exactlyADay', 'hubOnly', 'older', 'future', 'noStart',
      ]), `due platforms keep input order after de-duplication (got ${JSON.stringify(partition.due)})`);
      assert(partition.due.includes('hubOnly'),
        'a platform with no own completion entry is always due');
      assert(partition.due.includes('exactlyADay'),
        'a completion exactly twenty-four hours old is due, not fresh');
      assert(partition.due.includes('future'),
        'a future completion (clock skew) is due so the platform is never blocked forever');
      assert(partition.due.includes('noStart'),
        'an entry without a usable coverage start is due');
      assert(partition.due.length + partition.fresh.length === new Set(ids).size,
        'duplicated platform ids are partitioned exactly once');

      const hubOnly = partitionSourcesByRescrapeAge(
        { lastCompletedRunAt: nowMs - 1000 },
        ['alpha', 'beta'],
        nowDate,
      );
      assert(JSON.stringify(hubOnly) === JSON.stringify({ due: ['alpha', 'beta'], fresh: [] }),
        'a fresh hub lastCompletedRunAt alone never makes a platform fresh');

      assert(JSON.stringify(partitionSourcesByRescrapeAge(data, ids, nowMs)) === JSON.stringify(partition),
        'a numeric now and a Date now partition identically');
      assert(JSON.stringify(partitionSourcesByRescrapeAge(data, ids, new Date(nowMs))) === JSON.stringify(partition),
        'an equivalent Date instance partitions identically');

      const atEligibility = partitionSourcesByRescrapeAge(
        data,
        ['freshPlatform'],
        freshCompletedAt + JOB_SOURCE_RESCRAPE_INTERVAL_MS,
      );
      assert(JSON.stringify(atEligibility) === JSON.stringify({ due: ['freshPlatform'], fresh: [] }),
        'the platform is due again at its next eligible time');
      assert(JSON.stringify(partitionSourcesByRescrapeAge(null, ['alpha'], nowDate)) === JSON.stringify({ due: ['alpha'], fresh: [] })
        && JSON.stringify(partitionSourcesByRescrapeAge({}, [], nowDate)) === JSON.stringify({ due: [], fresh: [] }),
      'missing data or an empty selection partitions without throwing');
      return { freshCounted: partition.fresh.length, dueCounted: partition.due.length };
    },
  },
  {
    // A card's last scrape was scored and shown from its saved copy, yet every
    // date stayed at the previous run because the completion was never
    // recorded on the card. The record now travels with the saved scrape.
    name: 'Job Search dates move from the saved scrape collection record, one finished platform at a time',
    run: () => {
      const nodeId = 'hub-evidence';
      const runId = `${nodeId}-1794509644237`;
      const oldStart = 1793492385746;
      const oldDone = 1793671672921;
      const startedAt = 1794509644237;
      const completedAt = 1794541645596;
      const data = { hubState: 'done', jobRunId: runId, lastSearchCoverageStartedAt: oldStart, lastCompletedRunAt: oldDone };
      const known = ['alpha', 'beta', 'gamma'];

      const partial = buildCollectionEvidenceCommitPatch(data, {
        runId, disposition: 'unfinished-sources', startedAt, completedAt, completedSourceIds: ['alpha', 'beta'],
      }, nodeId, known);
      assert(partial.sourceCoverage.alpha.coverageStartedAt === startedAt
        && partial.sourceCoverage.beta.completedAt === completedAt,
      'each finished platform moves to the walk start of the run that finished it');
      assert(partial.sourceCoverage.gamma.coverageStartedAt === oldStart,
        'a platform the record does not list as finished keeps its earlier date');
      assert(!('lastCompletedRunAt' in partial) && !('lastSearchCoverageStartedAt' in partial),
        'the card-level date does not move for a collection with unfinished platforms');

      const full = buildCollectionEvidenceCommitPatch(data, {
        runId, disposition: 'full', startedAt, completedAt, completedSourceIds: known,
      }, nodeId, known);
      assert(full.lastCompletedRunAt === completedAt && full.lastSearchCoverageStartedAt === startedAt
        && known.every(id => full.sourceCoverage[id].coverageStartedAt === startedAt),
      'a full collection moves the card date and every finished platform');
      assert(buildCollectionEvidenceCommitPatch({ ...data, ...full }, {
        runId, disposition: 'full', startedAt, completedAt, completedSourceIds: known,
      }, nodeId, known) === null, 'applying the same record twice changes nothing');

      const noList = buildCollectionEvidenceCommitPatch(data, { runId, disposition: 'full', startedAt, completedAt }, nodeId, known);
      assert(noList.lastCompletedRunAt === completedAt && !('sourceCoverage' in noList),
        'without a finished-platform list no platform date is invented');

      for (const [label, card, evidence] of [
        ['another run', { ...data, jobRunId: `${nodeId}-1` }, { runId, disposition: 'full', startedAt, completedAt, completedSourceIds: known }],
        ['a staged completion', { ...data, pendingCollectionCompletion: { runId } }, { runId, disposition: 'full', startedAt, completedAt, completedSourceIds: known }],
        ['staged platform dates', { ...data, pendingSourceCoverage: { runId } }, { runId, disposition: 'full', startedAt, completedAt, completedSourceIds: known }],
        ['no times', data, { runId, disposition: 'full', completedSourceIds: known }],
        ['an end before the start', data, { runId, disposition: 'full', startedAt: completedAt, completedAt: startedAt, completedSourceIds: known }],
        ['no record', data, null],
      ]) assert(buildCollectionEvidenceCommitPatch(card, evidence, nodeId, known) === null, `nothing moves for ${label}`);

      // Main process: the record is taken from this run's manifest, survives a
      // rewrite of the same run, and is never borrowed from another run.
      const manifest = { runId, collectionDiagnostics: { disposition: 'unfinished-sources', startedAt, completedAt, unfinishedSourceCount: 1, completedSourceIds: ['alpha', 'beta', 'beta', 'Not An Id', 7] } };
      const fromManifest = collectionEvidenceForSnapshot({ runId }, manifest);
      assert(JSON.stringify(fromManifest.completedSourceIds) === '["alpha","beta"]' && fromManifest.runId === runId
        && fromManifest.startedAt === startedAt && fromManifest.disposition === 'unfinished-sources',
      'the saved scrape copies the host record, with platform ids cleaned');
      assert(collectionEvidenceForSnapshot({ runId }, null, { runId, collectionEvidence: fromManifest }).completedAt === completedAt,
        'a rewrite of the same run keeps the record from the file it replaces');
      assert(collectionEvidenceForSnapshot({ runId: 'other-run' }, manifest, { runId, collectionEvidence: fromManifest }) === null
        && collectionEvidenceForSnapshot({ runId }, { runId, collectionDiagnostics: { disposition: 'full' } }) === null
        && collectionEvidenceForSnapshot({}, manifest) === null,
      'no record for another run, for one without times, or for a snapshot without a run');
      assert(!('completedSourceIds' in sanitizeJobRunCollectionDiagnostics({ disposition: 'full', startedAt, completedAt })),
        'an absent finished-platform list stays absent, so older records keep their shape');

      assert(sanitizeJobSearchDateDiagnostics([{ version: 1, event: 'finalization', reason: 'saved-scrape-evidence', recordedAt: completedAt }]).length === 1,
        'the date history keeps the new reason');
      const node = fs.readFileSync('src/nodes/JobSearchNode.jsx', 'utf8');
      assert(/savedScrapeOutcome\?\.status === 'completed'[\s\S]{0,900}buildCollectionEvidenceCommitPatch\(node\?\.data, evidence, id, ALL_JOB_SOURCE_IDS\)/.test(node),
        'the saved-scrape path applies the record only after its rows are shown');
      const jobs = fs.readFileSync('electron/ipc/jobs.js', 'utf8');
      assert(/completedSourceIds,\n\s+\},\n\s+\}\);\n\s+await assertSearchCurrent\(\);/.test(jobs)
        && /snapshot = await attachCollectionEvidence\(snapshot, jsonPath\);/.test(jobs),
      'the host writes the finished-platform list at the gathered stage and into the saved scrape');
    },
  },
  {
    name: 'Job Search source coverage ignores platforms that cannot serve the search country',
    run() {
      // Dice and USAJobs are skipped by every Canada run, so their bookmarks
      // never move. They must not set the scan start or be named as behind.
      const now = localDate(2026, 11, 17, 3);
      const stale = localDate(2026, 10, 31, 20, 20).getTime();
      const recent = localDate(2026, 11, 15, 4, 20).getTime();
      const newest = localDate(2026, 11, 17, 0, 23).getTime();
      const entry = at => ({ coverageStartedAt: at, completedAt: at, runId: null });
      const data = {
        lastCompletedRunAt: recent,
        lastSearchCoverageStartedAt: recent,
        sourceCoverage: {
          dice: entry(stale), usajobs: entry(stale), google: entry(recent), indeed: entry(newest),
        },
      };
      const selected = ['google', 'indeed', 'dice', 'usajobs'];

      const canada = coverageSourceIdsForLocation(selected, 'Canada');
      assert(JSON.stringify(canada) === JSON.stringify(['google', 'indeed']),
        `a Canada search leaves out the U.S.-only platforms, got ${JSON.stringify(canada)}`);
      const { runAnchor } = resolveJobSearchSourceWindows(data, 'hub', canada, now);
      assert(runAnchor.timestamp === recent, `the scan starts from the oldest platform that can actually run, got ${runAnchor.timestamp}`);
      assert(JSON.stringify(sourcesBehindLatest(data, 'hub', canada).map(row => row.sourceId)) === JSON.stringify(['google']),
        'only a platform that can run is named as catching up');

      const unitedStates = coverageSourceIdsForLocation(selected, 'United States');
      assert(unitedStates.includes('dice') && unitedStates.includes('usajobs'),
        'a U.S. search keeps them, and their kept bookmarks resume from where they stopped');
      assert(resolveJobSearchSourceWindows(data, 'hub', unitedStates, now).runAnchor.timestamp === stale,
        'their old bookmark then sets the scan start again');

      assert(JSON.stringify(coverageSourceIdsForLocation(['dice', 'usajobs'], 'Canada')) === JSON.stringify(['dice', 'usajobs']),
        'when nothing applies the selection is unchanged, so the run preflight reports it');
    },
  },
  {
    name: 'Panels that stop loading mid-walk pause detail reads instead of ending the platform',
    run() {
      // The walk itself needs a live browser page; this pins the two contracts
      // the fix rests on.
      assert(didDetailBlockReprobeRecover({ expandedCount: 2 }) === true
        && didDetailBlockReprobeRecover({ expandedCount: 2, descWarning: { code: 'description-panel-unresponsive' } }) === false,
      'an unresponsive panel keeps the detail cooldown armed, like a rate limit');
      const scraper = fs.readFileSync('electron/ipc/browser/manualScraper.js', 'utf8');
      const guard = scraper.indexOf('if (!panelInterrupt && panelProvenThisWalk) {');
      assert(guard > 0 && guard < scraper.indexOf("'stale-desc-selectors',\n            panelInterrupt?.status"),
        'the proven-panel deferral is decided before the selector-failure abort');
    },
  },
  {
    name: 'A platform blocked part-way keeps its finished queries and its date moves once all have finished',
    run() {
      const bookmark = localDate(2026, 11, 15, 4).getTime();
      const run1 = localDate(2026, 11, 17, 0).getTime();
      const run2 = localDate(2026, 11, 18, 0).getTime();
      const entry = at => ({ coverageStartedAt: at, completedAt: at, runId: null });
      let data = { sourceCoverage: { linkedin: entry(bookmark), indeed: entry(bookmark) } };

      // Run 1: LinkedIn is blocked after finishing two of its queries.
      Object.assign(data, buildSourceCoverageCommitPatch(data, {
        runId: 'r1', collectionStartedAt: run1, collectionCompletedAt: run1 + 1000,
        completedSourceIds: ['indeed'],
        sourceQueryProgress: { linkedin: { finishedQueries: ['a', 'b'] } },
        locationKey: 'Canada',
      }, 'hub'));
      assert(data.sourceCoverage.linkedin.coverageStartedAt === bookmark, 'the blocked platform keeps its date');
      assert(JSON.stringify(sourceFinishedQueriesForRun(data, ['linkedin', 'indeed'], 'Canada')) === JSON.stringify({ linkedin: ['a', 'b'] }),
        'the next run is told which queries to skip');
      assert(Object.keys(sourceFinishedQueriesForRun(data, ['linkedin'], 'Toronto, Ontario, Canada')).length === 0,
        'a different search location starts every query again');
      assert(Object.keys(sourceFinishedQueriesForRun(data, ['indeed'], 'Canada')).length === 0,
        'only platforms taking part in the run are told anything');

      // Run 2: blocked again, one more query finished.
      Object.assign(data, buildSourceCoverageCommitPatch(data, {
        runId: 'r2', collectionStartedAt: run2, collectionCompletedAt: run2 + 1000,
        completedSourceIds: [],
        sourceQueryProgress: { linkedin: { finishedQueries: ['c'] } },
        locationKey: 'Canada',
      }, 'hub'));
      assert(JSON.stringify(sourceFinishedQueriesForRun(data, ['linkedin'], 'Canada').linkedin) === JSON.stringify(['a', 'b', 'c']),
        'finished queries add up across blocked runs');

      // Run 3: the rest finish. The date moves to the OLDEST contributing run.
      const run3 = localDate(2026, 11, 19, 0).getTime();
      Object.assign(data, buildSourceCoverageCommitPatch(data, {
        runId: 'r3', collectionStartedAt: run3, collectionCompletedAt: run3 + 1000,
        completedSourceIds: ['linkedin'], locationKey: 'Canada',
      }, 'hub'));
      assert(data.sourceCoverage.linkedin.coverageStartedAt === run1,
        `queries finished in run 1 were only read up to run 1, so the date moves there, got ${data.sourceCoverage.linkedin.coverageStartedAt}`);
      assert(Object.keys(data.sourceQueryProgress).length === 0 && Object.keys(sourceFinishedQueriesForRun(data, ['linkedin'], 'Canada')).length === 0,
        'a finished platform starts clean');

      // A platform with no bookmark yet keeps its progress after the commit seeds one.
      let fresh = { lastCompletedRunAt: bookmark, lastSearchCoverageStartedAt: bookmark };
      Object.assign(fresh, buildSourceCoverageCommitPatch(fresh, {
        runId: 'r1', collectionStartedAt: run1, collectionCompletedAt: run1,
        completedSourceIds: [], knownSourceIds: ['google'],
        sourceQueryProgress: { google: { finishedQueries: ['a'] } }, locationKey: 'Canada',
      }, 'hub'));
      assert(JSON.stringify(sourceFinishedQueriesForRun(fresh, ['google'], 'Canada')) === JSON.stringify({ google: ['a'] }),
        'progress survives the first write of a seeded bookmark');

      // Progress tied to a bookmark that has since moved is ignored.
      const moved = { sourceCoverage: { linkedin: entry(run2) }, sourceQueryProgress: {
        linkedin: { finishedQueries: ['a'], oldestStartedAt: run1, bookmarkAt: bookmark, locationKey: 'Canada' } } };
      assert(Object.keys(sourceFinishedQueriesForRun(moved, ['linkedin'], 'Canada')).length === 0,
        'progress from before the date moved is not reused');
    },
  },
  {
    name: 'A platform whose date does not move after a scan is reported for the dismiss-required popup',
    run() {
      const bookmark = localDate(2026, 11, 15, 4).getTime();
      const run1 = localDate(2026, 11, 17, 0).getTime();
      const entry = at => ({ coverageStartedAt: at, completedAt: at, runId: null });
      const data = { sourceCoverage: { linkedin: entry(bookmark), indeed: entry(bookmark), dice: entry(bookmark - 1000) } };
      const staged = {
        runId: 'r1', collectionStartedAt: run1, collectionCompletedAt: run1 + 1000,
        completedSourceIds: ['indeed'], participatingSourceIds: ['indeed', 'linkedin', 'google'],
      };
      const stalled = sourcesWithoutDateProgress(data, staged, 'hub');
      assert(JSON.stringify(stalled.map(row => row.sourceId)) === JSON.stringify(['linkedin', 'google']),
        `only platforms that took part and did not finish are reported, got ${JSON.stringify(stalled)}`);
      assert(stalled[0].resumesFrom === bookmark, 'the popup names the date the next scan starts from');
      assert(sourcesWithoutDateProgress(data, { ...staged, completedSourceIds: ['indeed', 'linkedin', 'google'] }, 'hub').length === 0,
        'nothing is reported when every platform that took part moved forward');
      assert(sourcesWithoutDateProgress(data, { ...staged, participatingSourceIds: null }, 'hub').length === 0,
        'an older staged result without the participant list reports nothing');

      // Finishing with the help of an earlier blocked run still moves the date.
      const withProgress = { ...data, sourceQueryProgress: {
        linkedin: { finishedQueries: ['a'], oldestStartedAt: bookmark + 60_000, bookmarkAt: bookmark, locationKey: '' } } };
      assert(sourcesWithoutDateProgress(withProgress, { ...staged, completedSourceIds: ['indeed', 'linkedin'], participatingSourceIds: ['indeed', 'linkedin'] }, 'hub').length === 0,
        'a date that moves only to an earlier run start is still progress');

      const node = fs.readFileSync('src/nodes/JobSearchNode.jsx', 'utf8');
      const popup = node.slice(node.indexOf('title: `Scan date did not move: '), node.indexOf('dedupeKey: `job-scan-date-stalled:'));
      assert(popup.includes("type: 'error'") && popup.includes('duration: 0'),
        'the warning uses the error popup that stays until dismissed');
    },
  },
  {
    name: 'A run finished by skipping blocked sources stops reading as blocked',
    run() {
      __resetJobsTelemetryForTests();
      try {
        const telemetry = getJobsTelemetry();
        telemetry.nodeId = 'hub';
        telemetry.pipeline = { phase: 'sources-blocked', runId: 'run-1', active: false, pendingSources: ['google', 'glassdoor'] };
        assert(recordRunCompletedWithUnfinishedSources('hub', 'run-2') === false
          && recordRunCompletedWithUnfinishedSources('other-hub', 'run-1') === false
          && getJobsTelemetry().pipeline.phase === 'sources-blocked',
        'another run or another hub cannot retire this stage');
        assert(recordRunCompletedWithUnfinishedSources('hub', 'run-1') === true, 'the same hub and run retires it');
        const pipeline = getJobsTelemetry().pipeline;
        assert(pipeline.phase === 'completed' && pipeline.pendingSources.length === 0
          && JSON.stringify(pipeline.finishedWithoutSources) === JSON.stringify(['google', 'glassdoor']),
        'the stage is completed and keeps which sources it finished without');
        assert(formatPipelineState(pipeline) === '✅ complete (finished without: google, glassdoor)',
          `the report says so, got ${formatPipelineState(pipeline)}`);
        assert(recordRunCompletedWithUnfinishedSources('hub', 'run-1') === false, 'a repeat completion changes nothing');
      } finally { __resetJobsTelemetryForTests(); }
    },
  },
];
