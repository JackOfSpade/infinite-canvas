import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessSourceHealth, DESCRIPTIONS_NOT_FETCHED_CODE, descriptionsNotFetchedWarning, sourceHealthWarning } from '../../electron/ipc/jobSourceHealth.js';
import { collectionScopeCaveatsFromSourceResults, describeSourceHealthFailures, normalizeCollectionScopeCaveats, sourceHealthCaveats } from '../../src/utils/jobCollectionScopeCaveats.js';
import { AUTOMATIC_DESCRIPTION_SOLVE_WAIT_MS, automaticDescriptionSolveDue, EMPLOYER_POSTING_READ_SOURCE_IDS, employerPostingReadOnSkip, isJobSourceWarningGating } from '../../src/utils/jobSourceWarningPolicy.js';
import { EMPLOYER_POSTING_READ_MAX_LISTINGS, readListingsFromEmployerPostings } from '../../electron/ipc/jobs/employerPostingRead.js';
import { indeedResumeWalkComplete, linkedInWalkComplete, listingReadProgress, listingsReadElsewhere } from '../../electron/ipc/jobs/sourceRules.js';
import { applyResolvedListingsToPendingCoverage, applySourceSolveToPendingCoverage, buildSourceCoverageCommitPatch, sourceOwedKeysForRun, sourcesWithoutDateProgress } from '../../src/utils/jobSearchSourceCoverage.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { filterJobsByPostedSince } from '../../electron/ipc/jobDateFilter.js';
import { appendWalkGuard, CHALLENGE_ESCALATE_MS, descriptionPanelPacing, DETAIL_BLOCK_MAX_TOTAL_REPROBES, detailBlockCooldownMs, panelWindowWaitMs, revealLowGrowthStop, selectManualSourcePageJobs, WALK_GUARD_MAX } from '../../electron/ipc/browser/manualScraper.js';
import { linkedInEnrichedRow } from '../../electron/extractors/apiExtractors.js';
import { indeedPanelDescription, indeedPanelShowsJob, selectIndeedPageRows } from '../../electron/extractors/indeedBrowser.js';

const TEXT = 'Build reliable services for regional teams. '.repeat(12);
const row = (source, over = {}) => ({ source, title: 'Engineer', company: 'Acme', location: 'Toronto', posted: '1 day ago', salary: '$1', url: `https://${source}.test/1`, snippet: TEXT, ...over });
const rows = (source, count, over = {}, bad = 0, badOver = {}) => Array.from({ length: count }, (_, index) => row(source, index < bad ? { ...over, ...badOver } : over));

export default [
  {
    name: 'A description is saved only once Indeed shows that job open with new text',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const shows = now => indeedPanelShowsJob({ jobKey: 'b', before, now });
      assert.equal(shows({ openKey: 'a', text: 'First job text' }), false, 'click did nothing');
      assert.equal(shows({ openKey: 'b', text: 'First job text' }), false, 'key moved, text has not');
      assert.equal(shows({ openKey: 'a', text: 'Second job text' }), false, 'text belongs to a different open job');
      assert.equal(shows({ openKey: 'b', text: '' }), false, 'blank panel');
      assert.equal(shows({ openKey: 'b', text: 'Second job text' }), true);
      assert.equal(shows({ openKey: '', text: 'Second job text' }), true, 'no key in the URL leaves the text change');
      assert.equal(shows({ openKey: '', text: 'First job text' }), false);
      assert.equal(indeedPanelShowsJob({ jobKey: 'a', before, now: { openKey: 'a', text: 'First job text' } }), true, 'the job was already open');
      assert.equal(indeedPanelShowsJob({ jobKey: 'a', before: { openKey: '', text: 'First job text' }, now: { openKey: '', text: 'First job text' } }), false);
    },
  },
  {
    name: 'A panel that only opened the target job after the click wait still gets its description saved',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead: null,
        settled: { openKey: 'b', text: 'Second job text' },
      });
      assert.equal(description, 'Second job text');
    },
  },
  {
    name: 'A fresh key over the previous job text is not saved as the late panel description',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead: null,
        settled: { openKey: 'b', text: 'First job text' },
      });
      assert.equal(description, '', 'the stale text would otherwise pass on the new key');
    },
  },
  {
    name: 'A late panel that shows another job is not saved',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead: null,
        settled: { openKey: 'c', text: 'Third job text' },
      });
      assert.equal(description, '');
    },
  },
  {
    name: 'A late panel with no open key in the URL is not saved, because only the key can prove which job it is',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead: null,
        settled: { openKey: '', text: 'Second job text' },
      });
      assert.equal(description, '');
    },
  },
  {
    name: 'A panel read inside the click wait is kept when another job opens before the dwell ends',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const panelRead = { openKey: 'b', text: 'Second job text' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead,
        settled: { openKey: 'c', text: 'Third job text' },
      });
      assert.equal(description, 'Second job text');
    },
  },
  {
    name: 'A panel that stays on the card job through the dwell is saved from the later read',
    run() {
      const before = { openKey: 'a', text: 'First job text' };
      const panelRead = { openKey: 'b', text: 'Second job tex' };
      const description = indeedPanelDescription({
        jobKey: 'b',
        before,
        panelRead,
        settled: { openKey: 'b', text: 'Second job text, now fully loaded' },
      });
      assert.equal(description, 'Second job text, now fully loaded');
    },
  },
  {
    name: 'The Indeed run that saved wrong descriptions fails the check, and one employer reposting does not',
    run() {
      const copied = Array.from({ length: 30 }, (_, index) => row('indeed', { company: `Employer ${index}`, snippet: index < 18 ? `${TEXT}${index}` : TEXT }));
      const failures = assessSourceHealth(copied);
      assert.deepEqual(failures.map(item => [item.field, item.missing, item.rows]), [['same-description', 11, 30]]);
      assert.match(describeSourceHealthFailures(failures), /11 of 30 listings have another employer's description/u);
      assert.equal(normalizeCollectionScopeCaveats([{ sourceId: 'indeed', code: 'source-health-failed', failures }])[0].failures[0].field, 'same-description');
      const reposts = Array.from({ length: 30 }, (_, index) => row('indeed', { company: 'Deloitte', url: `https://indeed.test/${index}` }));
      assert.deepEqual(assessSourceHealth(reposts), []);
      const fewCopies = Array.from({ length: 30 }, (_, index) => row('indeed', { company: `Employer ${index}`, snippet: index < 27 ? `${TEXT}${index}` : TEXT }));
      assert.deepEqual(assessSourceHealth(fewCopies), [], 'exactly at the limit is not over it');
    },
  },
  {
    name: 'What broke Indeed and Glassdoor on 2026-11-03 now fails the check',
    run() {
      // Indeed: every description blank. Glassdoor: 210 of 488 deferred after rate limits.
      const failures = assessSourceHealth([...rows('indeed', 162, {}, 161, { snippet: '' }), ...rows('glassdoor', 488, {}, 210, { descriptionDeferredReason: 'description-rate-limited' })]);
      assert.deepEqual(failures.map(item => [item.source, item.field, item.missing]), [['indeed', 'description', 161], ['glassdoor', 'description', 210]]);
    },
  },
  {
    name: 'What healthy sites returned on 2026-11-03 passes, including Google with few posted dates',
    run() {
      const healthy = [
        ...rows('google', 466, { url: '', applyOptions: [{ label: 'Apply on X', href: 'https://x.test' }] }, 139, { posted: '' }),
        ...rows('google', 321, { url: '', applyOptions: [{ label: 'Apply on X', href: 'https://x.test' }] }, 198, { posted: '' }),
        ...rows('ziprecruiter', 111, {}, 28, { posted: '' }),
        ...rows('linkedin', 303, { salary: '' }),
        ...rows('weworkremotely', 2, { snippet: '' }),
      ];
      assert.deepEqual(assessSourceHealth(healthy), []);
    },
  },
  {
    name: 'A field goes missing on one site, a small sample stays quiet, and a large site returning nothing is flagged',
    run() {
      assert.deepEqual(assessSourceHealth(rows('dice', 40, {}, 11, { company: '' })).map(item => item.field), ['company']);
      assert.deepEqual(assessSourceHealth(rows('indeed', 19, { snippet: '' })), [], 'too few rows to call it');
      assert.deepEqual(assessSourceHealth(rows('dice', 40, {}, 10, { company: '' })), [], 'exactly at the limit is not over it');
            assert.deepEqual(assessSourceHealth(rows('google', 30, { url: '' })).map(item => item.field), ['link']);
      assert.deepEqual(assessSourceHealth(rows('glassdoor', 20, { salary: '' })).map(item => item.field), ['salary']);
      assert.deepEqual(assessSourceHealth(rows('dice', 50), { silentlyEmptySourceIds: ['indeed', 'remoteok'] }).map(item => [item.source, item.field]), [['indeed', 'rows']]);
      assert.deepEqual(assessSourceHealth(rows('dice', 49), { silentlyEmptySourceIds: ['indeed'] }), [], 'a narrow search can honestly be empty');
    },
  },
  {
    name: 'The failure is loud but never pauses other sites, and survives a save with counts only',
    run() {
      const failures = assessSourceHealth(rows('indeed', 20, { snippet: '' }));
      const warning = sourceHealthWarning('indeed', failures);
      assert.equal(warning.code, 'source-health-failed');
      assert.equal(isJobSourceWarningGating(warning), false, 'scoring for other sites carries on');
      assert.match(warning.evidence, /description missing on 20 of 20 listings \(100%\)/u);
      assert.equal(sourceHealthWarning('dice', failures), null);
      const caveats = collectionScopeCaveatsFromSourceResults({ indeed: { healthFailures: failures.map(({ field, rows: count, missing }) => ({ field, rows: count, missing })) } });
      const saved = normalizeCollectionScopeCaveats(JSON.parse(JSON.stringify([...caveats, { sourceId: 'indeed', code: 'source-health-failed', failures: [{ field: 'PRIVATE TEXT', rows: 1 }] }, { sourceId: 'dice', code: 'source-health-failed', failures: [{ field: 'link', rows: 'PRIVATE', missing: 2, url: 'PRIVATE' }] }])));
      assert.equal(sourceHealthCaveats(saved).length, 2);
      assert.equal(JSON.stringify(saved).includes('PRIVATE'), false);
      assert.match(describeSourceHealthFailures(saved[0].failures), /description missing on 20 of 20/u);
    },
  },
  {
    name: 'A repeated description block waits longer each time, up to a limit',
    run() {
      assert.deepEqual([0, 1, 2, 9].map(detailBlockCooldownMs), [120_000, 300_000, 600_000, 600_000]);
    },
  },
  {
    name: "LinkedIn's posted pay reaches the row, and never overwrites pay already there",
    run() {
      const decision = { verdict: 'open', basis: 'open-marker' };
      const pay = linkedInEnrichedRow({ title: 'x', salary: '' }, TEXT, decision, null, '  CA$109,225.00/yr - CA$179,900.00/yr ');
      assert.equal(pay.salary, 'CA$109,225.00/yr - CA$179,900.00/yr');
      assert.equal(pay.salaryProvenance, 'posted');
      assert.equal(linkedInEnrichedRow({ title: 'x', salary: '$1' }, TEXT, decision, null, '$2').salary, '$1');
      assert.equal(linkedInEnrichedRow({ title: 'x', salary: '' }, TEXT, decision).salaryProvenance, undefined);
    },
  },
  {
    name: 'A collection window that dropped dated Google cards is not a missing posted date',
    run() {
      const googleRows = rows('google', 30, {}, 27, { posted: '' });
      assert.deepEqual(assessSourceHealth(googleRows, { datedOutsideWindowBySource: { google: 270 } }), []);
      // Without the window count the same rows fail, naming the rows measured.
      assert.deepEqual(
        assessSourceHealth(googleRows).map(item => [item.field, item.rows, item.missing]),
        [['posted', 30, 27]],
      );
      // A window too thin to explain the gap still fails, and reports the widened denominator.
      assert.deepEqual(
        assessSourceHealth(googleRows, { datedOutsideWindowBySource: { google: 2 } }).map(item => [item.field, item.rows, item.missing]),
        [['posted', 32, 27]],
      );
    },
  },
  {
    name: 'A negative or unreadable window count is ignored',
    run() {
      const googleRows = rows('google', 30, {}, 27, { posted: '' });
      const withoutWindow = assessSourceHealth(googleRows);
      for (const value of [-270, Number.NaN, undefined]) {
        assert.deepEqual(
          assessSourceHealth(googleRows, { datedOutsideWindowBySource: { google: value } }),
          withoutWindow,
          `window count ${String(value)} changed the verdict`,
        );
      }
    },
  },
  {
    name: 'The page selection counts only the cards its date window dropped',
    run() {
      const start = Date.parse('2026-10-01T00:00:00.000Z');
      const card = (key, posted) => ({
        source: 'google', jobId: key, title: `Engineer ${key}`, company: `Company ${key}`,
        location: 'Toronto', url: `https://google.test/${key}`, posted,
      });
      const cards = [
        card('fresh-a', '2026-10-02T00:00:00.000Z'),
        card('repeated', '2026-10-03T00:00:00.000Z'),
        card('repeated', '2026-10-03T00:00:00.000Z'),
        card('undated', ''),
        card('old-a', '2026-09-20T00:00:00.000Z'),
        card('fresh-b', '2026-10-04T00:00:00.000Z'),
        card('old-b', '2026-09-25T00:00:00.000Z'),
      ];
      const stats = {};
      const selected = selectManualSourcePageJobs(cards, [], 2, start, stats);
      assert.ok(Array.isArray(selected), 'still returns an array');
      // Two dated-old cards dropped; the repeat is a dedup drop and fresh-b is a
      // cap slice, so neither reaches windowDropped.
      assert.equal(stats.windowDropped, 2);
      assert.deepEqual(selected.map(job => job.jobId), ['fresh-a', 'repeated']);
      const seeded = { windowDropped: 3 };
      selectManualSourcePageJobs([card('old-c', '2026-09-01T00:00:00.000Z')], [], 5, start, seeded);
      assert.equal(seeded.windowDropped, 4, 'adds to a count already there');
      assert.equal(selectManualSourcePageJobs(cards.slice(0, 1), [], 5, start).length, 1, 'no stats object still returns rows');
    },
  },
  {
    name: 'Glassdoor panel requests stay at or under 10 in any 5 minutes, across pages',
    run() {
      const pacing = descriptionPanelPacing('glassdoor', 0);
      assert.equal(pacing.windowMs, 300_000);
      assert.equal(pacing.windowMax, 10);
      const times = [];
      assert.equal(panelWindowWaitMs('glassdoor', times, 0), 0, 'nothing sent yet');
      for (let i = 0; i < 9; i += 1) times.push(i * 4500);
      assert.equal(panelWindowWaitMs('glassdoor', times, 40_500), 0, 'ninth sent, tenth may go');
      times.push(40_500);
      assert.equal(panelWindowWaitMs('glassdoor', times, 45_000), 255_000, 'eleventh waits until the first leaves the window');
      assert.equal(panelWindowWaitMs('glassdoor', times, 300_000), 0, 'the first request has left the window');
      assert.equal(times.length, 9, 'requests older than the window are dropped');
      assert.equal(panelWindowWaitMs('indeed', [1, 2, 3], 4), 0, 'a source with no budget never waits');

      // Replay a long walk at the 4.5s click gap: no 5-minute window may hold more than 10.
      const all = [];
      let now = 0;
      for (let request = 0; request < 60; request += 1) {
        now += panelWindowWaitMs('glassdoor', all.filter(t => now - t < 300_000), now);
        all.push(now);
        now += 4500;
      }
      const worst = Math.max(...all.map(start => all.filter(t => t >= start && t < start + 300_000).length));
      assert.equal(worst, 10);
    },
  },
  {
    name: 'A Google reveal that adds under 5% over ten passes stops as reveal-stalled',
    run() {
      assert.equal(revealLowGrowthStop([100, 100, 101, 101, 102, 102, 103, 103, 104, 104, 104]), true, '4 cards over ten passes from 100 is a stalled list');
      assert.equal(revealLowGrowthStop([100, 100, 101, 101, 102, 102, 103, 103, 104, 105, 106]), false, '6 cards over the same window is real growth');
      assert.equal(revealLowGrowthStop([100, 100, 101, 101, 102, 102, 103, 103, 104, 104, 105]), false, 'exactly 5% is the boundary, not a stall');
      assert.equal(revealLowGrowthStop([10, 10, 10, 10, 11, 11, 11, 11, 12, 12, 12]), false, 'a list under 20 cards cannot prove a meaningful share');
      assert.equal(revealLowGrowthStop([100, 100, 101, 101, 102, 102, 103, 103, 104, 104]), false, 'ten counts is not yet a ten-pass window');
      assert.equal(revealLowGrowthStop([]), false, 'no passes at all');
      assert.equal(revealLowGrowthStop(null), false, 'no counts at all');
    },
  },
  {
    name: 'Detail retry and human-check escalation budgets are the agreed numbers',
    run() {
      assert.equal(DETAIL_BLOCK_MAX_TOTAL_REPROBES, 6);
      assert.deepEqual(CHALLENGE_ESCALATE_MS, [900000, 1800000]);
    },
  },
  {
    name: 'A walk guard keeps the fixed shape, drops long detail text and caps at twenty',
    run() {
      const guards = [];
      const backstop = { kind: 'page-backstop', source: 'indeed', query: 2, page: 12, pages: 12, newRows: 210, detail: 'Stopped at the 12-page backstop' };
      assert.equal(appendWalkGuard(guards, backstop), true);
      assert.deepEqual(guards[0], { kind: 'page-backstop', source: 'indeed', query: 2, page: 12, pages: 12, newRows: 210, detail: 'Stopped at the 12-page backstop' });
      assert.deepEqual(Object.keys(guards[0]).sort(), ['detail', 'kind', 'newRows', 'page', 'pages', 'query', 'source'], 'no field outside the shared contract');
      appendWalkGuard(guards, { kind: 'reveal-stalled', source: 'google', query: 1, page: null, pages: null, newRows: null, detail: 'x'.repeat(500) });
      assert.equal(guards[1].detail.length, 240, 'detail is clamped so a guard can never carry listing text');
      assert.equal(guards[1].page, null);
      assert.equal(appendWalkGuard(guards, { kind: 'pager-trickle', detail: 42 }), true);
      assert.equal(guards[2].detail, null, 'a non-string detail is dropped, not coerced');
      assert.equal(appendWalkGuard(guards, { kind: 'not-a-guard' }), false, 'an unknown kind never reaches the result');
      for (let i = guards.length; i < WALK_GUARD_MAX + 5; i += 1) {
        appendWalkGuard(guards, { kind: 'job-backstop', source: 'indeed', query: 1, page: 1, pages: 1, newRows: 1, detail: `backstop ${i}` });
      }
      assert.equal(guards.length, WALK_GUARD_MAX);
      assert.equal(guards[WALK_GUARD_MAX - 1].detail, `backstop ${WALK_GUARD_MAX - 1}`, 'the cap keeps the first twenty, in order');
    },
  },
  {
    name: 'A local-only continuation reports LinkedIn descriptions as not fetched, not as a broken site',
    run() {
      const linkedin = rows('linkedin', 30, { snippet: '' });
      assert.deepEqual(
        assessSourceHealth(linkedin).map(item => [item.source, item.field, item.missing]),
        [['linkedin', 'description', 30]],
        'the same rows do fail the description check when the walk was supposed to run',
      );
      assert.deepEqual(assessSourceHealth(linkedin, { descriptionNotFetchedSourceIds: ['linkedin'] }), []);
      assert.deepEqual(assessSourceHealth(linkedin, { descriptionNotFetchedSourceIds: ['LINKEDIN'] }), [], 'the source match ignores case');
      assert.deepEqual(assessSourceHealth(linkedin, { descriptionNotFetchedSourceIds: ['dice'] }), assessSourceHealth(linkedin), 'another source is never exempted');
    },
  },
  {
    name: 'Exempting the unfetched description leaves every other LinkedIn check in force',
    run() {
      const linkedin = rows('linkedin', 30, { snippet: '' }, 30, { company: '' });
      assert.deepEqual(
        assessSourceHealth(linkedin, { descriptionNotFetchedSourceIds: ['linkedin'] }).map(item => [item.source, item.field, item.missing, item.rows]),
        [['linkedin', 'company', 30, 30]],
        'only description is exempt; company still fails on every row',
      );
      assert.deepEqual(
        assessSourceHealth(linkedin).map(item => [item.field, item.missing]),
        [['description', 30], ['company', 30]],
        'without the option both checks fail',
      );
    },
  },
  {
    name: 'The LinkedIn exemption never hides the same problem on another site in the same run',
    run() {
      const mixed = [...rows('linkedin', 30, { snippet: '' }), ...rows('indeed', 30, { snippet: '' })];
      assert.deepEqual(
        assessSourceHealth(mixed, { descriptionNotFetchedSourceIds: ['linkedin'] }).map(item => [item.source, item.field, item.missing]),
        [['indeed', 'description', 30]],
      );
    },
  },
  {
    name: 'The not-fetched notice carries its own code and the exact count, never the broken-site alarm',
    run() {
      assert.equal(descriptionsNotFetchedWarning('linkedin', rows('linkedin', 30)), null, 'full descriptions need no notice');
      const warning = descriptionsNotFetchedWarning('linkedin', [...rows('linkedin', 30, { snippet: '' }), ...rows('dice', 2)]);
      assert.equal(warning.code, DESCRIPTIONS_NOT_FETCHED_CODE);
      assert.equal(warning.code, 'descriptions-not-fetched');
      assert.notEqual(warning.code, 'source-health-failed', 'this code must never raise the "site may have changed" alarm');
      assert.equal(warning.severity, 'warn');
      assert.equal(warning.shortLabel, 'Descriptions not fetched');
      assert.equal(warning.evidence, '30 saved LinkedIn listing(s) have no description yet because this search finished from its saved listings without contacting the site again. They were set aside, not scored.');
      assert.equal(warning.suggestion, 'Use Solve on this source, or run a new search, to fetch their descriptions.');
      const dice = descriptionsNotFetchedWarning('dice', [{ source: 'dice', snippet: '' }]);
      assert.equal(dice.evidence.startsWith('1 saved Dice listing(s)'), true, 'the site name and count are exact');
      assert.equal(descriptionsNotFetchedWarning('dice', rows('linkedin', 5, { snippet: '' })), null, 'rows of another source are not counted');
    },
  },
  {
    name: 'Solve is pressed automatically once per run for a description refusal, never for a check a person must pass',
    run() {
      const refused = { sourceId: 'google', code: 'description-rate-limited', severity: 'block' };
      const due = over => automaticDescriptionSolveDue({ hubState: 'sources-ready', jobRunId: 'run-1', warnings: [refused], ...over });
      assert.equal(due(), true);
      assert.equal(due({ attemptedRunId: 'run-1' }), false, 'one automatic try per run');
      assert.equal(due({ attemptedRunId: 'run-0' }), true, 'an earlier run does not use up this one');
      assert.equal(due({ hubState: 'searching' }), false, 'not while the search is still running');
      assert.equal(due({ jobRunId: '' }), false);
      assert.equal(due({ warnings: [] }), false, 'a skipped platform leaves nothing to retry');
      assert.equal(due({ warnings: [{ ...refused, severity: 'warn' }] }), false, 'only a refusal that pauses the run');
      assert.equal(due({ warnings: [{ sourceId: 'google', code: 'captcha', severity: 'block' }] }), false, 'a person must pass a check');
      assert.equal(due({ warnings: [{ ...refused, action: 'login-platform' }] }), false, 'a sign-in is a person\'s step');
      assert.equal(AUTOMATIC_DESCRIPTION_SOLVE_WAIT_MS, detailBlockCooldownMs(0), 'the same rest the scan gives a first refusal');
    },
  },
  {
    name: 'An unread listing another platform read in the same scan counts as read, by the scan\'s own same-job rule',
    run() {
      const unread = over => row('google', { snippet: '', descriptionDeferredReason: 'description-rate-limited', ...over });
      const same = unread({ title: 'Data Engineer', company: 'Acme', url: 'https://google.test/a' });
      const otherCity = unread({ title: 'Data Engineer', company: 'Acme', location: 'Vancouver', url: 'https://google.test/b' });
      const alone = unread({ title: 'Platform Lead', company: 'Birch', url: 'https://google.test/c' });
      const jobsBySource = {
        google: [same, otherCity, alone, row('google', { title: 'Read Here', url: 'https://google.test/d' })],
        indeed: [row('indeed', { title: 'Data Engineer', company: 'Acme', url: 'https://indeed.test/1' }),
          row('indeed', { title: 'Platform Lead', company: 'Birch', snippet: '', url: 'https://indeed.test/2' })],
      };
      const covered = listingsReadElsewhere('google', jobsBySource);
      assert.deepEqual([...covered], [sourceJobKey(same)], 'a different city, and a copy the other platform did not read either, stay unread');
      const progress = listingReadProgress(jobsBySource.google, covered);
      assert.equal(progress.readKeys.includes(sourceJobKey(same)), true);
      assert.deepEqual(progress.unreadListings.map(listing => listing.key), [sourceJobKey(otherCity), sourceJobKey(alone)]);
      assert.equal(listingsReadElsewhere('google', { google: jobsBySource.google }).size, 0, 'a platform never covers itself');
    },
  },
  {
    name: 'Reading the last unread listing of a fully walked platform finishes it; a cut-short platform stays unfinished',
    run() {
      const pending = { runId: 'r', completedSourceIds: ['indeed'], walkCompleteSourceIds: ['google'],
        sourceQueryProgress: { google: { finishedQueries: [], unreadListings: [{ key: 'a' }, { key: 'b' }] },
          linkedin: { finishedQueries: [], unreadListings: [{ key: 'x' }] } } };
      const partly = applyResolvedListingsToPendingCoverage(pending, 'google', ['a']);
      assert.deepEqual(partly.completedSourceIds, ['indeed']);
      const all = applyResolvedListingsToPendingCoverage(partly, 'google', ['b']);
      assert.deepEqual(all.completedSourceIds, ['indeed', 'google']);
      assert.deepEqual(applyResolvedListingsToPendingCoverage(pending, 'linkedin', ['x']).completedSourceIds, ['indeed']);
    },
  },
  {
    name: 'LinkedIn counts as fully walked only when every query finished in this run or an earlier blocked one',
    run() {
      const queries = ['a', 'b', 'c'];
      assert.equal(linkedInWalkComplete(queries, ['a', 'b', 'c']), true);
      assert.equal(linkedInWalkComplete(queries, ['a', 'c']), false, 'a query cut short by a block');
      assert.equal(linkedInWalkComplete(queries, ['b', 'c'], ['b', 'c']), true, 'query a finished in an earlier blocked run and was left out');
      assert.equal(linkedInWalkComplete(queries, ['b'], ['b', 'c']), false);
      assert.equal(linkedInWalkComplete([], []), false);
    },
  },
  {
    name: 'A Solve that clears a fully walked platform moves its date and keeps what it could not read as owed',
    run() {
      const start = { sourceCoverage: { linkedin: { coverageStartedAt: 1000, completedAt: 2000, runId: 'r0' } } };
      const pending = { runId: 'r', collectionStartedAt: 5000, collectionCompletedAt: 6000, completedSourceIds: [],
        participatingSourceIds: ['linkedin'], walkCompleteSourceIds: ['linkedin'], locationKey: 'Canada', readContextKey: 'p',
        sourceQueryProgress: { linkedin: { finishedQueries: ['q'], unreadListings: [{ key: 'a', title: 'A', company: 'C', url: 'https://l.test/a' }, { key: 'b', title: 'B', company: 'C', url: '' }] } } };
      assert.equal(sourcesWithoutDateProgress(start, pending, 'hub', ['linkedin'])[0].walkComplete, true);
      assert.equal(sourcesWithoutDateProgress(start, pending, 'hub', ['linkedin'])[0].unreadListings, 2);

      // Still blocked after the pass: the user can Solve again or Skip.
      const stillBlocked = applySourceSolveToPendingCoverage(pending, 'linkedin', ['a'], false);
      assert.deepEqual(stillBlocked.completedSourceIds, []);
      assert.equal(sourcesWithoutDateProgress(start, stillBlocked, 'hub', ['linkedin']).length, 1);

      // Block cleared with one listing that can never be read.
      const cleared = applySourceSolveToPendingCoverage(pending, 'linkedin', ['a'], true);
      assert.deepEqual(cleared.completedSourceIds, ['linkedin']);
      assert.equal(sourcesWithoutDateProgress(start, cleared, 'hub', ['linkedin']).length, 0, 'no stalled-date popup');
      const data = { ...start, ...buildSourceCoverageCommitPatch(start, cleared, 'hub') };
      assert.equal(data.sourceCoverage.linkedin.coverageStartedAt, 5000);
      assert.deepEqual(data.sourceOwedListings.linkedin.listings.map(listing => listing.key), ['b']);

      // A pass that read nothing but cleared the block also finishes it.
      assert.deepEqual(applySourceSolveToPendingCoverage(pending, 'linkedin', [], true).completedSourceIds, ['linkedin']);
      // A walk that was cut short is never finished by a Solve.
      const cutShort = { ...pending, walkCompleteSourceIds: [] };
      assert.deepEqual(applySourceSolveToPendingCoverage(cutShort, 'linkedin', ['a', 'b'], true).completedSourceIds, []);
    },
  },
  {
    name: 'An Indeed resume that walked every planned list moves Indeed\'s date and keeps what it could not read as owed',
    run() {
      const unread = ['a', 'b', 'c'].map(key => ({ key, title: key.toUpperCase(), company: 'C', url: `https://indeed.test/${key}` }));
      const start = { sourceCoverage: { indeed: { coverageStartedAt: 1000, completedAt: 2000, runId: 'r0' } } };
      // The first scrape was challenged, so the search never recorded Indeed as walked.
      const pending = { runId: 'r', collectionStartedAt: 5000, collectionCompletedAt: 6000, completedSourceIds: [],
        participatingSourceIds: ['indeed'], walkCompleteSourceIds: [], locationKey: 'Canada', readContextKey: 'p',
        sourceQueryProgress: { indeed: { finishedQueries: [], unreadListings: unread } } };
      const stalled = sourcesWithoutDateProgress(start, pending, 'hub', ['indeed']);
      assert.equal(stalled.length, 1);
      assert.equal(stalled[0].walkComplete, false);

      // Report 2026-11-22: the resume walked every list and cleared the gate,
      // but 3 listings were still unread. Indeed's date moves and they stay owed.
      const withUnread = applySourceSolveToPendingCoverage(pending, 'indeed', ['a'], true, { walkComplete: true });
      assert.deepEqual(withUnread.walkCompleteSourceIds, ['indeed']);
      assert.deepEqual(withUnread.completedSourceIds, ['indeed']);
      assert.equal(sourcesWithoutDateProgress(start, withUnread, 'hub', ['indeed']).length, 0, 'the date moves');
      const owedData = { ...start, ...buildSourceCoverageCommitPatch(start, withUnread, 'hub') };
      assert.equal(owedData.sourceCoverage.indeed.coverageStartedAt, 5000);
      assert.deepEqual(owedData.sourceOwedListings.indeed.listings.map(listing => listing.key), ['b', 'c'], 'unread listings stay owed');
      assert.deepEqual(sourceOwedKeysForRun(owedData, ['indeed'], 'Canada'), { indeed: ['b', 'c'] }, 'the next Indeed scrape is handed them');

      // Rows the resume itself returned unread (no readable description) join
      // the not-done list and stay owed too, even when the first scrape saw none.
      const clean = { ...pending, sourceQueryProgress: {} };
      const dropped = [{ key: 'd', title: 'D', company: 'C', url: 'https://indeed.test/d' }];
      const fromResume = applySourceSolveToPendingCoverage(clean, 'indeed', ['x'], true, { walkComplete: true, unreadListings: dropped });
      assert.deepEqual(fromResume.sourceQueryProgress.indeed.unreadListings.map(listing => listing.key), ['d']);
      const resumeData = { ...start, ...buildSourceCoverageCommitPatch(start, fromResume, 'hub') };
      assert.deepEqual(resumeData.sourceOwedListings.indeed.listings.map(listing => listing.key), ['d']);
      // Still gated: they are recorded unread, and the date stays.
      const gatedWithRows = applySourceSolveToPendingCoverage(clean, 'indeed', [], false, { walkComplete: true, unreadListings: dropped });
      assert.deepEqual(gatedWithRows.sourceQueryProgress.indeed.unreadListings.map(listing => listing.key), ['d']);
      assert.deepEqual(gatedWithRows.completedSourceIds, []);
      // A row this run already read is not added; malformed rows are ignored.
      const alreadyRead = applySourceSolveToPendingCoverage({ ...clean, readKeysBySource: { indeed: ['d'] } }, 'indeed', [], false,
        { unreadListings: [...dropped, { title: 'no key' }, null] });
      assert.equal(alreadyRead.sourceQueryProgress?.indeed, undefined);

      // The resume read the last unread listings: nothing is missing, so the date moves with nothing owed.
      const moved = applySourceSolveToPendingCoverage(pending, 'indeed', ['a', 'b', 'c'], true, { walkComplete: true });
      assert.deepEqual(moved.walkCompleteSourceIds, ['indeed']);
      assert.deepEqual(moved.completedSourceIds, ['indeed']);
      const data = { ...start, ...buildSourceCoverageCommitPatch(start, moved, 'hub') };
      assert.equal(data.sourceCoverage.indeed.coverageStartedAt, 5000);
      assert.equal(data.sourceOwedListings?.indeed, undefined);
      // Recording it twice does not duplicate the id.
      assert.deepEqual(applySourceSolveToPendingCoverage(moved, 'indeed', [], true, { walkComplete: true }).walkCompleteSourceIds, ['indeed']);

      // Flag missing or false: the date stays stalled exactly as before.
      for (const options of [undefined, {}, { walkComplete: false }, { walkComplete: 'true' }]) {
        const kept = applySourceSolveToPendingCoverage(pending, 'indeed', [], true, options);
        assert.deepEqual(kept.completedSourceIds, [], JSON.stringify(options));
        assert.deepEqual(kept.walkCompleteSourceIds, [], JSON.stringify(options));
        assert.equal(sourcesWithoutDateProgress(start, kept, 'hub', ['indeed']).length, 1, JSON.stringify(options));
      }
      // A walk proven complete but with the gate still up records nothing.
      const stillGated = applySourceSolveToPendingCoverage(pending, 'indeed', [], false, { walkComplete: true });
      assert.deepEqual(stillGated.walkCompleteSourceIds, []);
      assert.deepEqual(stillGated.completedSourceIds, []);
    },
  },
  {
    name: 'Indeed opens an owed listing whatever its date, and the search hands Indeed its owed listings',
    run() {
      const windowStart = Date.now() - 2 * 86400000;
      const card = (jk, posted) => ({ source: 'indeed', title: jk, url: `https://ca.indeed.com/viewjob?jk=${jk}`, posted });
      const cards = [card('owed1', '20 days ago'), card('old1', '20 days ago'), card('new1', 'Today'), card('read1', 'Today')];
      const owed = new Set([sourceJobKey(cards[0])]);
      const page = selectIndeedPageRows(cards, windowStart, job => (job.title === 'read1' ? 'read' : false), job => owed.has(sourceJobKey(job)));
      assert.deepEqual(page.open.map(job => job.title), ['owed1', 'new1'], 'the owed card survives the window; the old one does not');
      assert.equal(page.readEarlier, 1);
      assert.equal(cards[0].postedWindowExempt, true, 'the mark travels with the row');
      assert.equal(filterJobsByPostedSince(page.open, windowStart).length, 2, 'the final window check keeps it too');
      // No hook, or a hook that throws: nothing is exempt.
      const fresh = () => [card('owed1', '20 days ago'), card('new1', 'Today')];
      assert.deepEqual(selectIndeedPageRows(fresh(), windowStart).open.map(job => job.title), ['new1']);
      assert.deepEqual(selectIndeedPageRows(fresh(), windowStart, null, () => { throw new Error('x'); }).open.map(job => job.title), ['new1']);

      const search = fs.readFileSync('electron/ipc/jobs/searchHandlers.js', 'utf8');
      assert.match(search, /fetchIndeedListingsBrowser\(indeedPlan\.queries,[\s\S]{0,800}alreadyReadBySource\.indeed \|\| null,[\s\S]{0,200}owedBySource\.indeed \|\| null\);/,
        'runIndeed passes the owed hook');
      assert.doesNotMatch(search, /readsCards && sourceId !== 'indeed'/, 'Indeed can be recorded as fully walked like any card-reading platform');
      const extractor = fs.readFileSync('electron/extractors/indeedBrowser.js', 'utf8');
      assert.match(extractor, /const alreadyRead = selectIndeedPageRows\(\s*newProviderCandidates\.map\(candidate => candidate\.job\),\s*collectionStartTimestamp,\s*isAlreadyRead,\s*isOwed,/);
    },
  },
  {
    name: 'An Indeed resume counts as fully walked only when every planned query is terminal in the ledger or in this resume',
    run() {
      const manifest = {
        runId: 'r',
        inputs: { queries: ['q0', 'q1', 'q2'] },
        sources: { indeed: { status: 'blocked', queries: { '#0': { lastPage: 3, terminal: true }, '#1': { lastPage: 1 } } } },
      };
      const walked = options => indeedResumeWalkComplete({ manifest, jobRunId: 'r', warning: null, ...options });
      assert.equal(walked({ terminalQueryIndexes: [1, 2] }), true, 'q0 from the first scrape, q1/q2 from the resume');
      assert.equal(walked({ terminalQueryIndexes: [0, 1, 2] }), true);
      assert.equal(walked({ terminalQueryIndexes: [] }), false, 'warning null with nothing terminal: a frame detach, nav error or budget stop');
      assert.equal(walked({ terminalQueryIndexes: undefined }), false);
      assert.equal(walked({ terminalQueryIndexes: [1] }), false, 'q2 never reached its end');
      assert.equal(walked({ terminalQueryIndexes: [1, 2], warning: { code: 'scrape-failed', severity: 'block' } }), false);
      assert.equal(walked({ terminalQueryIndexes: [1, 2], warning: { code: 'rate-limited', severity: 'throttle' } }), false);
      assert.equal(walked({ terminalQueryIndexes: [1, 2], warning: { code: 'x', severity: 'info' } }), true);
      // The full plan cannot be established: fail closed.
      assert.equal(indeedResumeWalkComplete({ manifest, jobRunId: 'other', terminalQueryIndexes: [0, 1, 2] }), false, 'another run');
      assert.equal(indeedResumeWalkComplete({ manifest, jobRunId: null, terminalQueryIndexes: [0, 1, 2] }), false);
      assert.equal(indeedResumeWalkComplete({ manifest: null, jobRunId: 'r', terminalQueryIndexes: [0, 1, 2] }), false);
      assert.equal(indeedResumeWalkComplete({ manifest: { ...manifest, inputs: {} }, jobRunId: 'r', terminalQueryIndexes: [0, 1, 2] }), false);
      assert.equal(indeedResumeWalkComplete({ manifest: { ...manifest, inputs: { queries: [] } }, jobRunId: 'r', terminalQueryIndexes: [] }), false);
    },
  },
  {
    name: 'The Indeed resume reports walk completion and retires the gather-stage block, and the card and hub pass it on',
    run() {
      const handler = fs.readFileSync('electron/ipc/jobs/recoveryHandlers.js', 'utf8');
      const resume = handler.slice(handler.indexOf("handleSafe('resume-job-source'"));
      assert.ok(resume.length > 0);
      assert.match(resume, /indeedResumeWalkComplete\(\{\s*manifest: runState\?\.manifest,\s*jobRunId,\s*terminalQueryIndexes: result\?\.terminalQueryIndexes,/);
      assert.match(resume, /if \(canWriteTelemetry\(\)\s*&& resolved\s*&& warning\?\.severity !== 'block'\s*&& warning\?\.severity !== 'throttle'\) \{\s*recordSourceResolvedAfterGather\(sourceId\);/);
      assert.match(resume, /return \{\s*resolved,\s*items,\s*walkComplete,/);
      assert.doesNotMatch(resume, /descriptionEvidence\.dropped\.length === 0\) \{/,
        'a resumed row with no readable description no longer keeps the walk incomplete: it is sent back unread and stays owed');
      assert.match(resume, /const unreadListings = listingReadProgress\(\s*descriptionEvidence\.dropped\.filter\(job => !retiredKeySet\.has\(sourceJobKey\(job\)\)\),\s*\)\.unreadListings;/);
      assert.match(resume, /\.\.\.\(unreadListings\.length > 0 \? \{ unreadListings \} : \{\}\)/);
      const extractor = fs.readFileSync('electron/extractors/indeedBrowser.js', 'utf8');
      const checkpoints = extractor.match(/onPageJobs\(\{[^}]*terminal: true \}\)/g) || [];
      const recorded = extractor.match(/terminalQueryIndexes\.add\(queryIndexes\[qi\]\);\n\s*if \(onPageJobs\) await onPageJobs\(\{[^}]*terminal: true \}\)/g) || [];
      assert.ok(checkpoints.length >= 4);
      assert.equal(recorded.length, checkpoints.length, 'every terminal checkpoint records its query, with or without onPageJobs');
      assert.match(extractor, /terminalQueryIndexes: \[\.\.\.terminalQueryIndexes\]/);
      assert.match(fs.readFileSync('src/nodes/JobSourceCardNode.jsx', 'utf8'), /walkComplete: result\?\.walkComplete === true/);
      assert.match(fs.readFileSync('src/nodes/JobSourceCardNode.jsx', 'utf8'), /unreadListings: Array\.isArray\(result\?\.unreadListings\) \? result\.unreadListings : \[\]/);
      assert.match(fs.readFileSync('src/nodes/JobSearchNode.jsx', 'utf8'), /walkComplete: e\.detail\?\.walkComplete === true,[\s\S]{0,300}unreadListings: Array\.isArray\(e\.detail\?\.unreadListings\) \? e\.detail\.unreadListings : \[\]/);
      assert.match(fs.readFileSync('src/nodes/JobSearchNode.jsx', 'utf8'), /applySourceSolveToPendingCoverage\(staged, resolvedSourceId, resolvedKeys, sourceGateCleared, \{[\s\S]{0,200}walkComplete: e\.detail\?\.walkComplete === true/);
    },
  },
  {
    name: 'Skip reads unread listings from employer postings only on a hand-listed platform, and keeps only text the finder verified',
    async run() {
      const refused = { code: 'description-rate-limited', severity: 'block' };
      assert.equal(EMPLOYER_POSTING_READ_SOURCE_IDS.size, 0, 'no platform is enabled: the measured yield was too low');
      assert.equal(employerPostingReadOnSkip('google', refused), false);
      EMPLOYER_POSTING_READ_SOURCE_IDS.add('google');
      try {
        assert.equal(employerPostingReadOnSkip('google', refused), true, 'a platform listed by hand is read on Skip');
        assert.equal(employerPostingReadOnSkip('glassdoor', refused), false, 'a platform is added by hand, never by itself');
        assert.equal(employerPostingReadOnSkip('google', { code: 'captcha', severity: 'block' }), false);
        assert.equal(employerPostingReadOnSkip('google', { ...refused, severity: 'warn' }), false);
      } finally { EMPLOYER_POSTING_READ_SOURCE_IDS.delete('google'); }

      const listing = index => row('google', { title: `Role ${index}`, snippet: '', descriptionDeferredReason: 'description-rate-limited', url: `https://google.test/${index}` });
      const listings = Array.from({ length: EMPLOYER_POSTING_READ_MAX_LISTINGS + 3 }, (_, index) => listing(index));
      const outcomes = ['found', 'found', 'link-only', 'not-found', 'closed', 'found'];
      let asked = 0;
      const result = await readListingsFromEmployerPostings(listings, {
        store: {},
        resolve: async (jobs) => {
          asked = jobs.length;
          return { jobs: jobs.map((job, index) => ({ ...job, officialPosting: {
            outcome: outcomes[index] || 'not-found', level: index === 5 ? 'L4' : 'L1', contentHash: `h${index}` } })) };
        },
        // Row 1 was found but its saved text is too short to score.
        getView: async job => ({ officialPosting: job.officialPosting, description: job.title === 'Role 1' ? 'Too short.' : TEXT }),
      });
      assert.equal(asked, EMPLOYER_POSTING_READ_MAX_LISTINGS, 'one Skip looks up a bounded number');
      assert.deepEqual(result.read.map(entry => entry.row.title), ['Role 0'], 'only an open posting with verified, score-length text is read');
      assert.equal(result.read[0].row.snippet, TEXT.trim());
      assert.equal('descriptionDeferredReason' in result.read[0].row, false);
      assert.equal(result.read[0].row.descriptionSource, 'employer-posting');
      assert.equal(result.unread.length, EMPLOYER_POSTING_READ_MAX_LISTINGS - 1);
      assert.equal(result.unread[0].descriptionDeferredReason, 'description-rate-limited', 'an unread listing comes back unchanged');
      assert.deepEqual((await readListingsFromEmployerPostings([], { resolve: async () => { throw new Error('not called'); } })).read, []);
    },
  },
];
