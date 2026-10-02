import {
  assert,
  JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS,
  JOB_SEARCH_MAX_AUTOMATIC_HISTORY_LOOKBACK_DAYS,
  JOB_SEARCH_MAX_INITIAL_LOOKBACK_DAYS,
  JOB_SEARCH_MIN_INITIAL_LOOKBACK_DAYS,
  filterJobsByPostedSince,
  JOB_SEARCH_MAX_LOOKBACK_DAYS,
  jobSearchCompletionAnchor,
  jobSearchHistoricalAnchor,
  jobSearchNextAnchor,
  jobSearchRescanAnchor,
  legacyJobRunStartedAt,
  normalizeJobSearchInitialLookbackDays,
  parsePostedDate,
  resolveJobSearchDateWindow,
} from '../test-dependencies.js';

const localDate = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);

export default [
  {
    name: 'Job Search history always wins over first-search lookback',
    run: () => {
      const nodeId = 'hub-mode';
      const completedAt = localDate(2026, 10, 3, 10).getTime();
      const coverageAt = localDate(2026, 10, 2, 9).getTime();
      const base = { hubState: 'empty', lastCompletedRunAt: completedAt, lastSearchCoverageStartedAt: coverageAt };
      const legacy = jobSearchNextAnchor(base, nodeId);
      const retainedAfterClear = jobSearchNextAnchor({
        ...base,
        nextSearchWindowMode: 'full-lookback',
        initialLookbackDays: 180,
      }, nodeId);
      const legacyRunStartedAt = localDate(2026, 10, 1, 8).getTime();
      const legacyDone = jobSearchNextAnchor({
        hubState: 'done', jobRunId: `${nodeId}-${legacyRunStartedAt}`,
      }, nodeId);
      const partialFinished = jobSearchNextAnchor({
        hubState: 'done',
        jobRunId: `${nodeId}-${legacyRunStartedAt}`,
        partialCollectionRunId: `${nodeId}-${legacyRunStartedAt}`,
      }, nodeId);
      const partialWithPriorFullHistory = jobSearchNextAnchor({
        hubState: 'done',
        jobRunId: `${nodeId}-${legacyRunStartedAt}`,
        partialCollectionRunId: `${nodeId}-${legacyRunStartedAt}`,
        lastCompletedRunAt: completedAt,
      }, nodeId);
      const savedWindowAt = localDate(2026, 10, 1, 7).getTime();
      const savedWindow = jobSearchHistoricalAnchor({
        hubState: 'empty', searchWindow: { completionTimestamp: savedWindowAt, anchorTimestamp: localDate(2026, 9, 1).getTime() },
      }, nodeId);
      assert(normalizeJobSearchInitialLookbackDays(null) === JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS
        && normalizeJobSearchInitialLookbackDays('') === JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS
        && normalizeJobSearchInitialLookbackDays(true) === JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS
        && normalizeJobSearchInitialLookbackDays({ valueOf: () => 7 }) === JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS
        && normalizeJobSearchInitialLookbackDays(0) === JOB_SEARCH_MIN_INITIAL_LOOKBACK_DAYS
        && normalizeJobSearchInitialLookbackDays(999) === JOB_SEARCH_MAX_INITIAL_LOOKBACK_DAYS,
      'the first-search lookback defaults safely and is constrained to its UI range');
      assert(legacy.timestamp === coverageAt && legacy.source === 'last-coverage-start'
        && retainedAfterClear.timestamp === coverageAt && retainedAfterClear.source === 'last-coverage-start',
      'retained no-gap history wins even if an obsolete full-lookback mode remains on disk');
      assert(legacyDone.timestamp === legacyRunStartedAt && legacyDone.source === 'legacy-run-start',
        'a completed legacy run id provides a safe anchor that Clear career files can materialize before removing the id');
      assert(partialFinished.timestamp === null && partialFinished.source === 'initial-lookback'
        && partialWithPriorFullHistory.timestamp === completedAt && partialWithPriorFullHistory.source === 'last-completed',
      'a saved-listings partial finish never converts its run-id timestamp into full-scan history, while earlier genuine history remains available');
      assert(savedWindow.timestamp === savedWindowAt && savedWindow.source === 'saved-window-completion',
        'a Reset followed by Clear can retain a prior window completion without treating its capped start as history');
      return { historyWins: true, legacyRunMaterializes: true, initialLookback: true };
    },
  },
  {
    name: 'Job Search completion anchors prefer the durable completion and conservatively recover legacy run starts',
    run: () => {
      const nodeId = 'job-hub-with-hyphens';
      const completedAt = localDate(2026, 10, 2, 11, 20).getTime();
      const legacyStartedAt = localDate(2026, 10, 1, 9, 5).getTime();
      const runId = `${nodeId}-${legacyStartedAt}`;

      assert(legacyJobRunStartedAt(runId, nodeId) === legacyStartedAt,
        'the numeric suffix is recovered after the complete node-id prefix');
      assert(legacyJobRunStartedAt(`other-node-${legacyStartedAt}`, nodeId) === null,
        'a run owned by another node is never accepted as this hub\'s anchor');
      assert(legacyJobRunStartedAt(`${nodeId}-not-a-timestamp`, nodeId) === null,
        'a malformed legacy suffix fails closed');

      const coverageStartedAt = localDate(2026, 10, 1, 23, 50).getTime();
      const covered = jobSearchRescanAnchor(coverageStartedAt, completedAt, runId, nodeId);
      assert(covered.timestamp === coverageStartedAt && covered.source === 'last-coverage-start',
        'a successful run start wins as the conservative coverage watermark across midnight');
      const overnightWindow = resolveJobSearchDateWindow(
        covered.timestamp,
        localDate(2026, 10, 2, 0, 10),
      );
      assert(overnightWindow.startTimestamp === localDate(2026, 10, 1).getTime(),
        'an overnight completed run must rescan from the prior local date so finished sources have no gap');
      const malformedCoverage = jobSearchRescanAnchor('not-a-time', completedAt, runId, nodeId);
      assert(malformedCoverage.timestamp === completedAt && malformedCoverage.source === 'last-completed',
        'a malformed dedicated coverage watermark safely falls back to actual completion history');
      const durable = jobSearchCompletionAnchor(completedAt, runId, nodeId);
      assert(durable.timestamp === completedAt && durable.source === 'last-completed',
        'the successful completion instant wins over the older run-start fallback');
      const legacy = jobSearchCompletionAnchor(null, runId, nodeId);
      assert(legacy.timestamp === legacyStartedAt && legacy.source === 'legacy-run-start',
        'a completed legacy canvas can safely overfetch from its recorded run start');
      const fallback = jobSearchCompletionAnchor(null, 'unrelated-run', nodeId);
      assert(fallback.timestamp === null && fallback.source === 'default-cap',
        'a hub with no trustworthy historical timestamp uses the normal capped default');
      return { coverage: true, durable: true, legacy: true, defaultCap: true };
    },
  },
  {
    name: 'Job Search date window honors the first-run lookback while history has its own safety cap',
    run: () => {
      const now = localDate(2026, 10, 22, 12, 30);
      const window = resolveJobSearchDateWindow(null, now);
      assert(JOB_SEARCH_DEFAULT_INITIAL_LOOKBACK_DAYS === 21
        && JOB_SEARCH_MAX_LOOKBACK_DAYS === JOB_SEARCH_MAX_AUTOMATIC_HISTORY_LOOKBACK_DAYS,
      'the default first scan and independent history safety cap are explicit');
      assert(window.startDate.getTime() === localDate(2026, 10, 1).getTime(), 'first run starts at local midnight 21 days ago');
      assert(window.startTimestamp === window.startDate.getTime(), 'timestamp and date identify the same exact boundary');
      assert(window.anchorTimestamp === window.startTimestamp, 'effective anchor is the exact boundary');
      assert(window.completionTimestamp === null, 'first run has no completion instant');
      assert(window.capped && window.capReason === 'no-completion', 'first run reports why it uses the cap');
      assert(window.providerLookbackDays === 22, 'provider fetch includes the complete boundary day');
      const configured = resolveJobSearchDateWindow(null, now, 90);
      assert(configured.startTimestamp === localDate(2026, 7, 24).getTime()
        && configured.providerLookbackDays === 91,
      'a first run can request its persisted 1–180 day lookback');
      return { ok: true };
    },
  },
  {
    name: 'Job Search provider horizon remains strictly broader at exact midnight boundaries',
    run: () => {
      const now = localDate(2026, 10, 22);
      const window = resolveJobSearchDateWindow(null, now);
      assert(window.startTimestamp === localDate(2026, 10, 1).getTime(),
        'the 21-calendar-day cap still begins at local midnight');
      assert(window.providerLookbackDays === 22,
        'an exact 21-day duration still requests one deliberate provider overlap day');
      return { exactMultipleOverfetch: true };
    },
  },
  {
    name: 'Job Search rescans start at local midnight of the last completion date',
    run: () => {
      const now = localDate(2026, 10, 2, 15, 45);
      const completedAt = localDate(2026, 10, 1, 12, 10).getTime();
      const window = resolveJobSearchDateWindow(String(completedAt), now);
      assert(window.startDate.getTime() === localDate(2026, 10, 1).getTime(), 'midday completion overlaps all of its local date');
      assert(window.completionTimestamp === completedAt, 'valid persisted decimal timestamp is preserved');
      assert(!window.capped && window.capReason === null, 'recent valid completion does not use the cap');
      assert(window.providerLookbackDays === 2, 'provider range reaches the previous calendar date');
      const olderHistory = resolveJobSearchDateWindow(
        localDate(2026, 9, 1, 12).getTime(),
        now,
        1,
      );
      assert(olderHistory.startTimestamp === localDate(2026, 9, 1).getTime()
        && olderHistory.capped === false,
      'a valid completed history ignores the first-search picker rather than narrowing a subsequent scan');
      return { ok: true };
    },
  },
  {
    name: 'Job Search window counts local calendar dates safely across daylight-saving changes',
    run: () => {
      // In DST-observing zones this interval contains a 23-hour spring-forward
      // date; in other zones it is still the same two-calendar-date interval.
      // The product contract is calendar dates, never elapsed 24-hour chunks.
      const now = localDate(2026, 3, 9, 12);
      const completedAt = localDate(2026, 3, 7, 23, 50).getTime();
      const window = resolveJobSearchDateWindow(completedAt, now);
      assert(window.startTimestamp === localDate(2026, 3, 7).getTime(),
        'the boundary remains local midnight on the completion date');
      assert(window.providerLookbackDays === 3,
        'provider retrieval covers both intervening calendar dates plus the complete boundary date');
      return { localMidnight: true, providerCalendarDays: window.providerLookbackDays };
    },
  },
  {
    name: 'Job Search provider horizon stays calendar-based across a 25-hour fall-back date',
    run: () => {
      const now = localDate(2026, 11, 2, 23, 30);
      const completedAt = localDate(2026, 11, 1, 12).getTime();
      const window = resolveJobSearchDateWindow(completedAt, now);
      const expectedProviderDays = Math.ceil((now.getTime() - window.startTimestamp) / (24 * 60 * 60 * 1000));
      assert(window.startTimestamp === localDate(2026, 11, 1).getTime(),
        'fall-back does not shift the inclusive boundary away from local midnight');
      assert(window.providerLookbackDays === expectedProviderDays,
        'the broad provider request covers every elapsed hour since local midnight, including a 25-hour fall-back date');
      return { localMidnight: true, providerCalendarDays: window.providerLookbackDays };
    },
  },
  {
    name: 'Job Search date window clamps stale, future, and malformed completion anchors',
    run: () => {
      const now = localDate(2026, 10, 22, 12);
      const historyCapStart = localDate(2025, 10, 22).getTime();
      const firstScanCapStart = localDate(2026, 10, 1).getTime();
      const cases = [
        [localDate(2025, 9, 30, 23).getTime(), 'older-than-max-lookback', historyCapStart, 366],
        [localDate(2026, 10, 23).getTime(), 'future-completion', firstScanCapStart, 22],
        ['2026-10-01T12:00:00.000Z', 'invalid-completion', firstScanCapStart, 22],
      ];
      for (const [completion, reason, expectedStart, expectedProviderDays] of cases) {
        const window = resolveJobSearchDateWindow(completion, now);
        assert(window.startTimestamp === expectedStart, `${reason} falls back to the appropriate safe boundary`);
        assert(window.capped && window.capReason === reason, `${reason} is explicit`);
        assert(window.providerLookbackDays === expectedProviderDays, `${reason} still fetches the full boundary day`);
      }
      return { ok: true };
    },
  },
  {
    name: 'Job Search exact posted-since filter is inclusive and retains unknown dates',
    run: () => {
      const now = localDate(2026, 10, 2, 12);
      const start = localDate(2026, 10, 1).getTime();
      const jobs = [
        { id: 'bare-calendar-boundary', posted: '2026-10-01' },
        { id: 'at-boundary', posted: '2026-10-01T00:00:00' },
        { id: 'newer', posted: '2026-10-01T00:00:01' },
        { id: 'older', posted: '2026-09-30T23:59:59' },
        { id: 'relative', posted: '1 day ago' },
        { id: 'unknown', posted: 'recently listed' },
      ];
      const bareCalendarDate = parsePostedDate('2026-10-01', now);
      assert(bareCalendarDate?.getFullYear() === 2026
        && bareCalendarDate?.getMonth() === 9
        && bareCalendarDate?.getDate() === 1
        && bareCalendarDate?.getHours() === 0,
      'a bare ISO calendar date is interpreted at local midnight, never UTC midnight');
      const kept = filterJobsByPostedSince(jobs, new Date(start), now).map(job => job.id);
      assert(kept.join(',') === 'bare-calendar-boundary,at-boundary,newer,relative,unknown', 'the entire boundary calendar date is retained while only parseable older rows are removed');
      return { ok: true };
    },
  },
];
