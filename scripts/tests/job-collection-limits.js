// Coverage for the "All" (unlimited) job-collection breadth change:
//   - src/utils/jobCollectionLimits.js: normalization, the finite backstop, and
//     the isUnlimitedPages/resolvePageCeiling/describeJobCollectionLimits seams
//     every walker/report must use instead of branching on null itself.
//   - electron/ipc/jobPageStop.js: the data-driven "should we keep paging?"
//     decision (empty-page / age-window / no-new-jobs) that replaced the old
//     "walk to the ceiling" default.
import { assert } from './testHelpers.js';
import {
  JOB_COLLECTION_LIMITS_MAX,
  JOB_COLLECTION_PAGE_CEILING,
  MIN_DATED_EVIDENCE,
  STOP_STREAK,
  describeJobCollectionLimits,
  getJobCollectionSafetyForMode,
  getJobPlatformSafety,
  getJobPlatformSelectionStatus,
  getUnsafeJobPlatformIds,
  getEnabledJobSourceIds,
  getRunnableJobSourceIds,
  isUnlimitedPages,
  makeJobPageStop,
  normalizeJobCollectionLimits,
  normalizeEnabledJobSourceIds,
  resolvePageCeiling,
} from '../test-dependencies.js';

const FIXED_NOW = new Date('2026-08-13T12:00:00Z');
const clock = () => FIXED_NOW;

// Resolves 'today' (in-window against any maxAgeDays) / well past any
// maxAgeDays used below (21) / unparseable by parsePostedDate (no digits).
const IN_WINDOW = 'today';
const OUT_OF_WINDOW = '90 days ago';
const UNPARSEABLE = 'flexible schedule';

const row = (posted, jobkey) => ({ posted, jobkey });

export default [
  {
    name: 'job platform selection: missing selection defaults to all; malformed entries are removed and scoped views preserve hidden preferences',
    run: () => {
      const all = ['google', 'indeed', 'linkedin'];
      const defaulted = normalizeEnabledJobSourceIds(undefined, all);
      assert(defaulted.join(',') === all.join(','), 'existing hubs with no allow-list must retain all-platform behavior');
      const cleaned = normalizeEnabledJobSourceIds(['indeed', 'unknown', 'indeed', '', 'google'], all);
      assert(cleaned.join(',') === 'indeed,google', 'selection removes unknown/duplicate/empty IDs without changing order');
      const persisted = normalizeEnabledJobSourceIds(['google', 'indeed', 'linkedin'], all);
      const scoped = getEnabledJobSourceIds(persisted, ['indeed']);
      assert(scoped.join(',') === 'indeed', 'test-scoped runner intersects its view without mutating the persisted selection');
      assert(persisted.join(',') === 'google,indeed,linkedin', 'hidden source preferences remain available after scope changes');
      assert(getRunnableJobSourceIds(persisted, ['indeed'], { jobsPerPlatform: null, pagesPerPlatform: null }).join(',') === 'indeed',
        'the runner helper applies the same scoped selection used by renderer and IPC');
      return { defaulted: defaulted.length, persisted: persisted.length };
    },
  },
  {
    name: 'jobPlatformSafety: every current platform is safe with either or both collection fields set to All',
    run: () => {
      const allCurrent = ['google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely', 'ziprecruiter', 'glassdoor', 'dice', 'usajobs'];
      for (const limits of [
        { jobsPerPlatform: null, pagesPerPlatform: 5 },
        { jobsPerPlatform: 25, pagesPerPlatform: null },
        { jobsPerPlatform: null, pagesPerPlatform: null },
      ]) {
        assert(getUnsafeJobPlatformIds(limits, allCurrent).length === 0,
          `all current collectors must have their own terminal condition for ${JSON.stringify(limits)}`);
        for (const id of allCurrent) {
          assert(getJobPlatformSafety(id, limits).enabled === true, `${id} should remain selectable for ${JSON.stringify(limits)}`);
        }
      }
      return { sources: allCurrent.length };
    },
  },
  {
    name: 'job platform selection: country-incompatible sources are disabled in the UI without changing server policy',
    run: () => {
      const canadaDice = getJobPlatformSelectionStatus('dice', { jobsPerPlatform: null, pagesPerPlatform: null }, {
        city: 'Toronto', stateCode: 'ON', country: 'Canada',
      });
      assert(canadaDice.enabled === false && canadaDice.code === 'country-incompatible',
        'Dice must be visibly unavailable for a Canada target before the user starts a run');
      assert(canadaDice.reason.includes('Canada'), 'country disable must explain the target-specific policy');
      const canadaIndeed = getJobPlatformSelectionStatus('indeed', { jobsPerPlatform: null, pagesPerPlatform: null }, {
        city: 'Toronto', stateCode: 'ON', country: 'Canada',
      });
      assert(canadaIndeed.enabled, 'Indeed must remain selectable for a Canada target');
      const usaDice = getJobPlatformSelectionStatus('dice', { jobsPerPlatform: null, pagesPerPlatform: null }, {
        city: 'Denver', stateCode: 'CO', country: 'United States',
      });
      assert(usaDice.enabled, 'Dice must re-enable when the target changes to the supported United States scope');
      return { canadaDice: canadaDice.code, canadaIndeed: canadaIndeed.enabled, usaDice: usaDice.enabled };
    },
  },
  {
    name: 'jobPlatformSafety: finite-only modes block exactly the All setting that would make a future collector non-terminating',
    run: () => {
      const jobsAll = { jobsPerPlatform: null, pagesPerPlatform: 4 };
      const pagesAll = { jobsPerPlatform: 40, pagesPerPlatform: null };
      const bothAll = { jobsPerPlatform: null, pagesPerPlatform: null };
      assert(getJobCollectionSafetyForMode('finite-jobs', jobsAll).code === 'unlimited-jobs', 'jobs-only mode blocks Jobs=All');
      assert(getJobCollectionSafetyForMode('finite-jobs', pagesAll).enabled, 'jobs-only mode permits Pages=All');
      assert(getJobCollectionSafetyForMode('finite-pages', pagesAll).code === 'unlimited-pages', 'pages-only mode blocks Pages=All');
      assert(getJobCollectionSafetyForMode('finite-pages', jobsAll).enabled, 'pages-only mode permits Jobs=All');
      const both = getJobCollectionSafetyForMode('finite-both', bothAll);
      assert(both.code === 'unlimited-jobs-and-pages' && both.reason.includes('both are set to All'), 'both-only mode produces an actionable both-All warning');
      assert(getJobCollectionSafetyForMode('finite-both', jobsAll).code === 'unlimited-jobs', 'both-only mode blocks Jobs=All alone');
      assert(getJobCollectionSafetyForMode('finite-both', pagesAll).code === 'unlimited-pages', 'both-only mode blocks Pages=All alone');
      assert(getJobCollectionSafetyForMode('finite-both', { jobsPerPlatform: 40, pagesPerPlatform: 4 }).enabled, 'finite limits enable a finite-only collector');
      const unknown = getJobPlatformSafety('future-unreviewed-board', bothAll);
      assert(unknown.enabled === false && unknown.code === 'unreviewed-unlimited-collector', 'unknown unlimited collectors are conservatively disabled with a UI warning');
      return { modes: 3 };
    },
  },
  {
    name: 'jobCollectionLimits: blank/null/undefined/0/negative/non-numeric all fall back to "All" (null), independently per field',
    run: () => {
      const fallbackCases = ['', null, undefined, 0, -4, 'not-a-number', NaN, Infinity, -Infinity];
      for (const value of fallbackCases) {
        const jobs = normalizeJobCollectionLimits({ jobsPerPlatform: value });
        assert(jobs.jobsPerPlatform === null, `jobsPerPlatform ${JSON.stringify(value)} must fall back to null (All), got ${jobs.jobsPerPlatform}`);
        assert(jobs.pagesPerPlatform === null, 'an untouched field must independently default to null, not inherit the other field\'s input');
        const pages = normalizeJobCollectionLimits({ pagesPerPlatform: value });
        assert(pages.pagesPerPlatform === null, `pagesPerPlatform ${JSON.stringify(value)} must fall back to null (All), got ${pages.pagesPerPlatform}`);
        assert(pages.jobsPerPlatform === null, 'an untouched field must independently default to null, not inherit the other field\'s input');
      }
      return { fallbackCasesChecked: fallbackCases.length };
    },
  },
  {
    name: 'jobCollectionLimits: over-max clamps to each field\'s own ceiling; in-range explicit numbers pass through',
    run: () => {
      assert(normalizeJobCollectionLimits({ jobsPerPlatform: 50000 }).jobsPerPlatform === JOB_COLLECTION_LIMITS_MAX.jobsPerPlatform,
        'jobsPerPlatform clamps to its own max instead of silently accepting an unbounded number');
      assert(normalizeJobCollectionLimits({ pagesPerPlatform: 50000 }).pagesPerPlatform === JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform,
        'pagesPerPlatform clamps to its own (smaller) max');
      assert(normalizeJobCollectionLimits({ pagesPerPlatform: JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform + 1 }).pagesPerPlatform === JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform,
        'one past the max still clamps, not just far-over values');
      assert(normalizeJobCollectionLimits({ jobsPerPlatform: 250 }).jobsPerPlatform === 250,
        'a plain in-range number passes through unchanged');
      assert(normalizeJobCollectionLimits({ pagesPerPlatform: '7' }).pagesPerPlatform === 7,
        'a numeric string in range normalizes to a real number');
      assert(normalizeJobCollectionLimits({ jobsPerPlatform: '17.9' }).jobsPerPlatform === 17,
        'a fractional numeric string floors to a whole collector unit');
      return { ok: true };
    },
  },
  {
    name: 'isUnlimitedPages / resolvePageCeiling: the seam every walker must use instead of `|| 10`',
    run: () => {
      assert(isUnlimitedPages({ pagesPerPlatform: '' }) === true, 'blank pagesPerPlatform reads as unlimited');
      assert(isUnlimitedPages({ pagesPerPlatform: null }) === true, 'null pagesPerPlatform reads as unlimited');
      assert(isUnlimitedPages(undefined) === true, 'missing limits object reads as unlimited (production default)');
      assert(isUnlimitedPages({ pagesPerPlatform: 7 }) === false, 'an explicit page count is never unlimited');
      assert(isUnlimitedPages({ pagesPerPlatform: 0 }) === true, 'zero is not a valid explicit count — it normalizes back to unlimited');

      assert(resolvePageCeiling({ pagesPerPlatform: '' }) === JOB_COLLECTION_PAGE_CEILING,
        'blank → null resolves to the finite backstop, the exact round-trip a saved hub with an emptied input box goes through');
      assert(resolvePageCeiling({ pagesPerPlatform: 7 }) === 7, 'an explicit page count is its own ceiling');

      // resolvePageCeiling must NEVER hand a walker loop something non-finite,
      // for any shape of input a caller might pass it.
      const neverNonFinite = [
        undefined, null, {}, 'garbage', 42,
        { pagesPerPlatform: null }, { pagesPerPlatform: '' }, { pagesPerPlatform: 0 }, { pagesPerPlatform: -1 },
        { pagesPerPlatform: Infinity }, { pagesPerPlatform: NaN }, { pagesPerPlatform: 999999 },
      ];
      for (const limits of neverNonFinite) {
        assert(Number.isFinite(resolvePageCeiling(limits)), `resolvePageCeiling(${JSON.stringify(limits)}) must always be finite`);
      }
      return { checked: neverNonFinite.length };
    },
  },
  {
    name: 'describeJobCollectionLimits: "All" fields read as human text naming the backstop; explicit/clamped numbers as plain digits',
    run: () => {
      const allDescribed = describeJobCollectionLimits({});
      assert(allDescribed.jobs === 'all' && allDescribed.pages === `all (backstop ${JOB_COLLECTION_PAGE_CEILING})`,
        `default breadth must read as all/all with the backstop named, got ${JSON.stringify(allDescribed)}`);
      const explicitDescribed = describeJobCollectionLimits({ jobsPerPlatform: 12, pagesPerPlatform: 3 });
      assert(explicitDescribed.jobs === '12' && explicitDescribed.pages === '3',
        `explicit numbers render as plain strings with no backstop caveat, got ${JSON.stringify(explicitDescribed)}`);
      const clampedDescribed = describeJobCollectionLimits({ pagesPerPlatform: 5000 });
      assert(clampedDescribed.pages === String(JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform),
        `an over-max page request must describe its CLAMPED value, not the raw input, got ${clampedDescribed.pages}`);
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: an empty page is a terminal, lossless stop',
    run: () => {
      const stop = makeJobPageStop({ maxAgeDays: 21, unlimited: true, sourceLabel: 'ziprecruiter', now: clock });
      const result = stop({ items: [], pageIndex: 0 });
      assert(result.stop === true && result.reason === 'empty-page', `empty page must stop with reason empty-page, got ${JSON.stringify(result)}`);
      assert(result.detail.includes('ziprecruiter') && result.detail.includes('page 1'), 'detail should name the source and 1-based page number');
      assert(stop.stats.stopReason === 'empty-page', 'stats.stopReason mirrors the returned reason');
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: age-window needs TWO consecutive conclusive out-of-window pages, not one',
    run: () => {
      const stop = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'glassdoor', now: clock });
      // 3 dated rows (>= MIN_DATED_EVIDENCE), all out of the 21-day window, no
      // unparseable filler — a clean, fully-conclusive page.
      const outOfWindowPage = [row(OUT_OF_WINDOW, 'a'), row(OUT_OF_WINDOW, 'b'), row(OUT_OF_WINDOW, 'c')];
      assert(MIN_DATED_EVIDENCE <= outOfWindowPage.length, 'fixture must carry at least MIN_DATED_EVIDENCE dated rows');
      const first = stop({ items: outOfWindowPage, pageIndex: 0 });
      assert(first.stop === false, 'a single out-of-window page is only a streak of 1 — a relevance reshuffle must not end the source');
      const second = stop({ items: outOfWindowPage, pageIndex: 1 });
      assert(second.stop === true && second.reason === 'age-window',
        `a SECOND consecutive conclusive out-of-window page must stop (STOP_STREAK=${STOP_STREAK}), got ${JSON.stringify(second)}`);
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: an in-window page between two out-of-window pages resets the age streak',
    run: () => {
      const stop = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'glassdoor', now: clock });
      const outPage = [row(OUT_OF_WINDOW, 'a'), row(OUT_OF_WINDOW, 'b'), row(OUT_OF_WINDOW, 'c')];
      const inPage = [row(IN_WINDOW, 'd'), row(IN_WINDOW, 'e'), row(IN_WINDOW, 'f')];
      assert(stop({ items: outPage, pageIndex: 0 }).stop === false, 'first out-of-window page: streak=1, no stop');
      assert(stop({ items: inPage, pageIndex: 1 }).stop === false, 'in-window page must reset the streak, not merely pause it');
      assert(stop({ items: outPage, pageIndex: 2 }).stop === false,
        'the streak was reset — a lone out-of-window page after the reset is only streak=1, so this must NOT stop');
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: under-evidenced pages can never trip age-window, however many repeat',
    run: () => {
      // (a) Fewer than MIN_DATED_EVIDENCE dated rows on the page at all.
      const sparse = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'x', now: clock });
      const sparsePage = [row(OUT_OF_WINDOW, 'a'), row(OUT_OF_WINDOW, 'b'), row(UNPARSEABLE, 'c'), row(UNPARSEABLE, 'd'), row(UNPARSEABLE, 'e')];
      assert(sparsePage.filter(r => r.posted === OUT_OF_WINDOW).length < MIN_DATED_EVIDENCE, 'fixture must have fewer than MIN_DATED_EVIDENCE dated rows');
      assert(sparse({ items: sparsePage, pageIndex: 0 }).stop === false, 'under-evidenced page must not stop on the first pass');
      assert(sparse({ items: sparsePage, pageIndex: 1 }).stop === false, 'still not conclusive on a repeat — evidence count never accumulates across pages');

      // (b) >= MIN_DATED_EVIDENCE dated rows, but they are LESS than half the page
      // (the rest genuinely unparseable) — also not conclusive.
      const majorityUnparseable = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'x', now: clock });
      const lowDensityPage = [
        row(OUT_OF_WINDOW, 'a'), row(OUT_OF_WINDOW, 'b'), row(OUT_OF_WINDOW, 'c'),
        row(UNPARSEABLE, 'd'), row(UNPARSEABLE, 'e'), row(UNPARSEABLE, 'f'),
        row(UNPARSEABLE, 'g'), row(UNPARSEABLE, 'h'), row(UNPARSEABLE, 'i'), row(UNPARSEABLE, 'j'),
      ];
      assert(lowDensityPage.length === 10 && lowDensityPage.filter(r => r.posted === OUT_OF_WINDOW).length === 3,
        'fixture must have exactly 3 dated rows out of 10 (below the "at least half" threshold)');
      assert(majorityUnparseable({ items: lowDensityPage, pageIndex: 0 }).stop === false, 'less than half the page dated must not count as conclusive');
      assert(majorityUnparseable({ items: lowDensityPage, pageIndex: 1 }).stop === false, 'still not conclusive on a repeat');
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: maxAgeDays:null disables the age rule entirely',
    run: () => {
      const stop = makeJobPageStop({ maxAgeDays: null, unlimited: false, sourceLabel: 'x', now: clock });
      const outPage = [row(OUT_OF_WINDOW, 'a'), row(OUT_OF_WINDOW, 'b'), row(OUT_OF_WINDOW, 'c')];
      for (let i = 0; i < 4; i++) {
        assert(stop({ items: outPage, pageIndex: i }).stop === false,
          `maxAgeDays:null must never trip age-window, however many out-of-window pages repeat (pass ${i})`);
      }
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: no-new-jobs fires only under unlimited:true, only after TWO consecutive all-duplicate pages',
    run: () => {
      const page = [row(IN_WINDOW, 'k1'), row(IN_WINDOW, 'k2')];

      const unlimitedStop = makeJobPageStop({ unlimited: true, sourceLabel: 'x', now: clock });
      assert(unlimitedStop({ items: page, pageIndex: 0 }).stop === false, 'first page introduces new jobs — not stale');
      assert(unlimitedStop({ items: page, pageIndex: 1 }).stop === false, 'one repeated page is only a stale streak of 1');
      const third = unlimitedStop({ items: page, pageIndex: 2 });
      assert(third.stop === true && third.reason === 'no-new-jobs',
        `a SECOND consecutive all-duplicate page must stop an unlimited walk, got ${JSON.stringify(third)}`);

      // The old lossless behavior: with an explicit ceiling (unlimited:false),
      // a duplicate-page heuristic must never fire — walk it out, let
      // cross-source dedup absorb the repeats.
      const boundedStop = makeJobPageStop({ unlimited: false, sourceLabel: 'x', now: clock });
      for (let i = 0; i < 5; i++) {
        assert(boundedStop({ items: page, pageIndex: i }).stop === false,
          `unlimited:false must never stop on repeats (pass ${i}) — a clamped pager stays lossless`);
      }
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: a page mixing repeats with at least one new job resets the stale streak',
    run: () => {
      const stop = makeJobPageStop({ unlimited: true, sourceLabel: 'x', now: clock });
      const A = row(IN_WINDOW, 'm1');
      const B = row(IN_WINDOW, 'm2');
      const C = row(IN_WINDOW, 'm3');
      assert(stop({ items: [A, B], pageIndex: 0 }).stop === false, 'A and B are new — not stale');
      assert(stop({ items: [A, B], pageIndex: 1 }).stop === false, 'exact repeat: stale streak = 1');
      assert(stop({ items: [A, C], pageIndex: 2 }).stop === false, 'C is new even though A repeats — resets the stale streak to 0');
      // If the reset above did NOT happen, the streak would already be 2 here
      // and this call would incorrectly stop.
      assert(stop({ items: [A, B], pageIndex: 3 }).stop === false,
        'post-reset: an all-duplicate page (A, B, C now all seen) is only stale streak = 1');
      const fifth = stop({ items: [A, B], pageIndex: 4 });
      assert(fifth.stop === true && fifth.reason === 'no-new-jobs',
        'a genuine SECOND consecutive all-duplicate page after the reset stops the walk');
      return { ok: true };
    },
  },
  {
    name: 'makeJobPageStop: separate instances never share streak or seen-key state',
    run: () => {
      const page = [row(IN_WINDOW, 'z1')];
      const instanceA = makeJobPageStop({ unlimited: true, sourceLabel: 'a', now: clock });
      instanceA({ items: page, pageIndex: 0 }); // fresh
      instanceA({ items: page, pageIndex: 1 }); // stale streak = 1, one call from stopping

      // A brand-new instance seeing the exact same rows for the "first" time
      // must not inherit instanceA's seenKeys (which would make this call read
      // as a duplicate) or its stale streak (which would make it stop early).
      const instanceB = makeJobPageStop({ unlimited: true, sourceLabel: 'b', now: clock });
      const firstOnB = instanceB({ items: page, pageIndex: 0 });
      assert(firstOnB.stop === false, 'a fresh instance must not inherit another instance\'s seen-keys/streak state');

      // Same isolation check for the age-window streak.
      const outPage = [row(OUT_OF_WINDOW, 'o1'), row(OUT_OF_WINDOW, 'o2'), row(OUT_OF_WINDOW, 'o3')];
      const ageA = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'a', now: clock });
      ageA({ items: outPage, pageIndex: 0 }); // out-of-window streak = 1
      const ageB = makeJobPageStop({ maxAgeDays: 21, unlimited: false, sourceLabel: 'b', now: clock });
      assert(ageB({ items: outPage, pageIndex: 0 }).stop === false, 'a fresh instance must not inherit another instance\'s out-of-window streak');
      return { ok: true };
    },
  },
];
