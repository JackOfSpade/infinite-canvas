import { assert } from './testHelpers.js';
import { w4Jobs } from '../test-dependencies.js';
import { sanitizeJobSearchSourceWindows } from '../../electron/ipc/jobRunStaging.js';

const {
  buildJobTasks,
  capPlatformJobsAfterWindow,
  completedJobSourceIds,
  listWalkStoppedByProviderBlock,
  narrowJobSearchSourceWindows,
  sanitizeWalkGuards,
  walkGuardWarning,
  WALK_GUARD_WARNING_CODE,
} = w4Jobs;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-10T12:00:00.000Z');
const NOW_MS = NOW.getTime();
// Fixed, minimal shape accepted by sanitizeJobSearchWindow.
const windowFor = (startTimestamp, providerLookbackDays = 30) => ({ startTimestamp, providerLookbackDays });

function taskBySource(tasks) {
  const out = {};
  for (const task of tasks) out[task.sourceId] = task;
  return out;
}

export default [
  {
    name: 'job search source windows: buildJobTasks applies each platform window and falls back to the run window',
    run: () => {
      const runStart = NOW_MS - 30 * DAY;
      const googleStart = NOW_MS - 3 * DAY;
      const glassdoorStart = NOW_MS - 7 * DAY;
      const perSourceOptions = {
        collectionStartTimestamp: runStart,
        maxAgeDaysBySource: { google: 3, glassdoor: 7 },
        collectionStartTimestampBySource: { google: glassdoorStart, glassdoor: glassdoorStart },
      };
      perSourceOptions.collectionStartTimestampBySource.google = googleStart;
      const perSource = taskBySource(buildJobTasks(['engineer'], 30, perSourceOptions, '', null, ''));
      assert(perSource.google, 'google task must exist');
      assert(perSource.glassdoor, 'glassdoor task must exist');
      assert(perSource.google.options.maxAgeDays === 3,
        `google must use its own days, got ${perSource.google.options.maxAgeDays}`);
      assert(perSource.glassdoor.options.maxAgeDays === 7,
        `glassdoor must use its own days, got ${perSource.glassdoor.options.maxAgeDays}`);
      assert(perSource.google.options.collectionStartTimestamp === googleStart,
        'google must use its own collection boundary');
      assert(perSource.glassdoor.options.collectionStartTimestamp === glassdoorStart,
        'glassdoor must use its own collection boundary');
      assert(perSource.google.options.maxAgeDays !== perSource.glassdoor.options.maxAgeDays,
        'differing maps must give differing per-platform horizons');
      assert(perSource.google.options.collectionStartTimestamp
        !== perSource.glassdoor.options.collectionStartTimestamp,
      'differing maps must give differing per-platform boundaries');
      assert(new URL(perSource.glassdoor.url).searchParams.get('fromAge') === '7',
        `glassdoor fromAge must follow its own days, got ${perSource.glassdoor.url}`);
      // A platform without an entry keeps the run values.
      assert(perSource.ziprecruiter.options.maxAgeDays === 30,
        'ziprecruiter without an entry must keep the run horizon');
      assert(perSource.ziprecruiter.options.collectionStartTimestamp === runStart,
        'ziprecruiter without an entry must keep the run boundary');

      const runOnly = { collectionStartTimestamp: runStart };
      const withNullMaps = taskBySource(buildJobTasks(['engineer'], 30, {
        ...runOnly,
        maxAgeDaysBySource: null,
        collectionStartTimestampBySource: null,
      }, '', null, ''));
      const baseline = taskBySource(buildJobTasks(['engineer'], 30, runOnly, '', null, ''));
      assert(Object.keys(withNullMaps).join(',') === Object.keys(baseline).join(','),
        'null maps must not add or remove tasks');
      for (const sourceId of Object.keys(baseline)) {
        assert(withNullMaps[sourceId].url === baseline[sourceId].url,
          `${sourceId}: null maps must not change the request URL`);
        assert(withNullMaps[sourceId].options.maxAgeDays === 30,
          `${sourceId}: null maps must keep the run horizon`);
        assert(withNullMaps[sourceId].options.collectionStartTimestamp === runStart,
          `${sourceId}: null maps must keep the run boundary`);
      }
      assert(new URL(withNullMaps.glassdoor.url).searchParams.get('fromAge') === '30',
        'glassdoor without an entry must keep the run-level bucket');
    },
  },
  {
    name: 'job search source windows: capPlatformJobsAfterWindow honours a per-source boundary resolver',
    run: () => {
      const fiveDaysOld = new Date(NOW_MS - 5 * DAY).toISOString();
      const jobs = [
        { title: 'Dice row', company: 'Alpha', source: 'dice', posted: fiveDaysOld, url: 'https://example.test/dice' },
        { title: 'LinkedIn row', company: 'Beta', source: 'linkedin', posted: fiveDaysOld, url: 'https://example.test/li' },
      ];
      const perSource = capPlatformJobsAfterWindow(
        jobs,
        (sourceId) => (sourceId === 'dice' ? NOW_MS - 2 * DAY : NOW_MS - 20 * DAY),
        50,
        { now: NOW },
      );
      assert(perSource.jobs.length === 1, `only the permissive source may keep the row, got ${perSource.jobs.length}`);
      assert(perSource.jobs[0].source === 'linkedin', 'the kept row must be the source with the 20-day boundary');
      assert(perSource.sourceStats.dice.ageDropped === 1, 'the narrow source must count the row as age-dropped');
      assert(perSource.sourceStats.linkedin.ageDropped === 0, 'the permissive source must not drop the row');
      assert(perSource.ageDropped === 1, 'aggregate ageDropped must match the per-source drops');

      const numericNarrow = capPlatformJobsAfterWindow(jobs, NOW_MS - 2 * DAY, 50, { now: NOW });
      assert(numericNarrow.jobs.length === 0, 'a numeric 2-day boundary drops both 5-day-old rows');
      assert(numericNarrow.windowEligible.length === 0, 'numeric boundary must expose no window-eligible rows');
      const numericBroad = capPlatformJobsAfterWindow(jobs, NOW_MS - 20 * DAY, 50, { now: NOW });
      assert(numericBroad.jobs.map(job => job.source).join(',') === 'dice,linkedin',
        'a numeric 20-day boundary keeps both rows in original order');
      assert(numericBroad.ageDropped === 0, 'a numeric 20-day boundary drops nothing');
    },
  },
  {
    name: 'job search source windows: narrowJobSearchSourceWindows keeps only in-boundary own keys',
    run: () => {
      const runWindow = windowFor(NOW_MS - 10 * DAY, 11);
      const narrowed = narrowJobSearchSourceWindows({
        google: windowFor(NOW_MS - 4 * DAY, 30),
        dice: windowFor(NOW_MS - 20 * DAY, 30),
        indeed: windowFor(NOW_MS + DAY, 30),
        'at-run-boundary': windowFor(NOW_MS - 10 * DAY, 30),
        junk: 'not-a-window',
        Valid: windowFor(NOW_MS - 4 * DAY, 30),
        'bad key!': windowFor(NOW_MS - 4 * DAY, 30),
        ['__proto__']: windowFor(NOW_MS - 4 * DAY, 30),
      }, runWindow, NOW);
      assert(Object.keys(narrowed).join(',') === 'google,at-run-boundary',
        `expected only the narrowed sources, got ${Object.keys(narrowed).join(',')}`);
      assert(narrowed.google.startTimestamp === NOW_MS - 4 * DAY,
        'a narrower in-boundary source must keep its own start');
      assert(narrowed['at-run-boundary'].startTimestamp === runWindow.startTimestamp,
        'a source exactly at the run boundary is inside the window');
      assert(Number.isSafeInteger(narrowed.google.providerLookbackDays)
        && narrowed.google.providerLookbackDays > 0,
      'providerLookbackDays must be recomputed to a positive whole day count');
      assert(!Object.hasOwn(narrowed, '__proto__'), '__proto__ must never survive narrowing');
      assert(!Object.hasOwn(narrowed, 'junk'), 'unparseable windows must be dropped');
      assert(Object.keys(narrowJobSearchSourceWindows(null, runWindow, NOW)).length === 0,
        'missing input must narrow to no per-source windows');
      assert(Object.keys(narrowJobSearchSourceWindows({ google: windowFor(NOW_MS - 4 * DAY, 30) }, null, NOW)).length === 0,
        'a missing run window must narrow to nothing');
    },
  },
  {
    name: 'job search source windows: sanitizeJobSearchSourceWindows rejects junk keys and caps at 25',
    run: () => {
      const many = {};
      for (let i = 0; i < 30; i += 1) many[`src${i}`] = windowFor(NOW_MS - DAY, 5);
      const capped = sanitizeJobSearchSourceWindows(many);
      const cappedKeys = Object.keys(capped);
      assert(cappedKeys.length === 25, `expected 25 entries, got ${cappedKeys.length}`);
      assert(cappedKeys[0] === 'src0' && cappedKeys[24] === 'src24',
        'the cap must keep the first 25 valid entries in order');

      const mixed = sanitizeJobSearchSourceWindows({
        good: windowFor(NOW_MS - DAY, 5),
        bad: { startTimestamp: 'yesterday' },
        alsoBad: null,
        ['__proto__']: windowFor(NOW_MS - DAY, 5),
        UPPER: windowFor(NOW_MS - DAY, 5),
      });
      assert(Object.keys(mixed).join(',') === 'good',
        `expected only the valid lowercase entry, got ${Object.keys(mixed).join(',')}`);
      assert(mixed.good.startTimestamp === NOW_MS - DAY, 'a valid window must be preserved verbatim');
      assert(Object.keys(sanitizeJobSearchSourceWindows('nope')).length === 0,
        'a non-object must sanitize to an empty map');
      assert(Object.keys(sanitizeJobSearchSourceWindows([])).length === 0,
        'an array must sanitize to an empty map');
      assert(Object.keys(sanitizeJobSearchSourceWindows(null)).length === 0,
        'null must sanitize to an empty map');
    },
  },
  {
    name: 'job search source windows: completedJobSourceIds excludes every unfinished category',
    run: () => {
      const statuses = {
        indeed: 'done',
        google: 'done',
        glassdoor: 'done',
        ziprecruiter: 'done',
        dice: 'done',
        linkedin: 'failed',
      };
      const completed = completedJobSourceIds({
        activeSourceIds: ['indeed', 'google', 'glassdoor', 'ziprecruiter', 'dice', 'linkedin'],
        sourceStatuses: statuses,
        gatingSourceIds: ['google'],
        intentionallyUnfinishedSourceIds: ['glassdoor'],
        loginBlockedSourceIds: ['ziprecruiter'],
        countryApplicableSourceIds: ['indeed', 'google', 'glassdoor', 'ziprecruiter', 'linkedin'],
      });
      assert(completed.join(',') === 'indeed',
        `only the gated-free done source may complete, got ${completed.join(',')}`);

      // A done but cap-truncated platform is still complete: caps are breadth
      // choices, so nothing about a truncated source removes it here.
      const truncated = completedJobSourceIds({
        activeSourceIds: ['dice', 'indeed'],
        sourceStatuses: { dice: 'done', indeed: 'pending' },
        countryApplicableSourceIds: null,
      });
      assert(truncated.join(',') === 'dice', `a done truncated source stays complete, got ${truncated.join(',')}`);

      const orderPreserved = completedJobSourceIds({
        activeSourceIds: ['dice', 'indeed', 'linkedin'],
        sourceStatuses: { dice: 'done', indeed: 'done', linkedin: 'done' },
        gatingSourceIds: new Set(['indeed']),
        intentionallyUnfinishedSourceIds: new Set(),
        loginBlockedSourceIds: new Set(),
        countryApplicableSourceIds: new Set(['dice', 'indeed', 'linkedin']),
      });
      assert(orderPreserved.join(',') === 'dice,linkedin',
        `results must follow activeSourceIds order, got ${orderPreserved.join(',')}`);

      assert(completedJobSourceIds({}).length === 0, 'no arguments must yield no completions');
      assert(completedJobSourceIds({
        activeSourceIds: ['indeed'],
        sourceStatuses: { indeed: 'skipped' },
      }).length === 0, 'a skipped source is not a completed collection');
    },
  },
  {
    name: 'job search source windows: a list walk the provider blocked is not a finished platform',
    run() {
      const throttle = [{ code: 'http-429', severity: 'throttle' }];
      const rows = [{ title: 'Engineer' }];
      assert(listWalkStoppedByProviderBlock({ jobs: rows, stopReasons: [{ query: 'q', stopReason: 'blocked' }] }, throttle) === true,
        'LinkedIn API envelope: 429 ended the walk');
      assert(listWalkStoppedByProviderBlock({ jobs: rows, stopReasons: new Set(['blocked']) }, throttle) === true,
        'merged Set of plain reasons');
      assert(listWalkStoppedByProviderBlock({ jobs: rows, stopReasons: new Set(['provider-page-limit']) }, throttle) === false,
        'a throttle warning on a walk that reached its end is a description problem, not lost coverage');
      assert(listWalkStoppedByProviderBlock({ jobs: rows, stopReasons: new Set(['blocked']) }, []) === false,
        'no warning, no claim');
      assert(listWalkStoppedByProviderBlock({ jobs: [], stopReasons: new Set(['blocked']) }, throttle) === false,
        'no rows: the source is already an error, handled elsewhere');
    },
  },
  {
    name: 'job search source windows: walkGuardWarning surfaces guarded walks as a non-gating warning',
    run: () => {
      assert(walkGuardWarning('dice', []) === null, 'no guards must yield no warning');
      assert(walkGuardWarning('dice', undefined) === null, 'missing guards must yield no warning');
      assert(WALK_GUARD_WARNING_CODE === 'collection-stalled',
        `warning code must be collection-stalled, got ${WALK_GUARD_WARNING_CODE}`);

      const guard = {
        kind: 'pager-trickle',
        source: 'dice',
        query: 'engineer',
        page: '4',
        pages: '9',
        newRows: '0',
        detail: 'next page added 0 new rows',
      };
      const warning = walkGuardWarning('dice', [guard]);
      assert(warning !== null, 'one guard must yield a warning');
      assert(warning.code === 'collection-stalled', `code must be collection-stalled, got ${warning.code}`);
      assert(warning.severity === 'warn', `severity must be warn, got ${warning.severity}`);
      assert(warning.shortLabel === 'Stopped early', `shortLabel must be "Stopped early", got ${warning.shortLabel}`);
      assert(warning.evidence.includes(guard.detail), `evidence must contain the guard detail, got ${warning.evidence}`);
      assert(warning.suggestion.includes('Send a bug report.'), 'suggestion must point at a bug report');

      const deduped = walkGuardWarning('dice', [
        guard,
        { ...guard, detail: 'second identical kind/query guard' },
      ]);
      assert(deduped.evidence === guard.detail,
        `identical kind+query guards must dedup to the first detail, got ${deduped.evidence}`);

      const longGuards = Array.from({ length: 8 }, (_, index) => ({
        kind: 'page-backstop',
        query: `query-${index}`,
        page: index,
        detail: 'x'.repeat(200),
      }));
      const clipped = walkGuardWarning('dice', longGuards);
      assert(clipped.evidence.length === 600,
        `evidence must be clipped to 600 chars, got ${clipped.evidence.length}`);

      const sanitized = sanitizeWalkGuards([
        guard,
        { kind: 'not-a-real-kind', detail: 'dropped' },
        { kind: 'reveal-stalled', detail: 'y'.repeat(400) },
      ], 20);
      assert(sanitized.length === 2, `unknown kinds must be dropped, got ${sanitized.length}`);
      assert(sanitized[0].page === 4, `page numbers must be coerced, got ${String(sanitized[0].page)}`);
      assert(sanitized[1].detail.length === 240,
        `detail must be clipped to 240 chars, got ${sanitized[1].detail.length}`);
      assert(sanitizeWalkGuards(Array.from({ length: 25 }, () => guard), 20).length === 20,
        'walk guard arrays must be capped at 20');
    },
  },
];
