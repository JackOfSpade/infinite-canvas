import assert from 'node:assert/strict';
import { assessSourceHealth, sourceHealthWarning } from '../../electron/ipc/jobSourceHealth.js';
import { collectionScopeCaveatsFromSourceResults, describeSourceHealthFailures, normalizeCollectionScopeCaveats, sourceHealthCaveats } from '../../src/utils/jobCollectionScopeCaveats.js';
import { isJobSourceWarningGating } from '../../src/utils/jobSourceWarningPolicy.js';
import { appendWalkGuard, CHALLENGE_ESCALATE_MS, descriptionPanelPacing, DETAIL_BLOCK_MAX_TOTAL_REPROBES, detailBlockCooldownMs, panelWindowWaitMs, revealLowGrowthStop, selectManualSourcePageJobs, WALK_GUARD_MAX } from '../../electron/ipc/browser/manualScraper.js';
import { linkedInEnrichedRow } from '../../electron/extractors/apiExtractors.js';
import { indeedPanelShowsJob } from '../../electron/extractors/indeedBrowser.js';

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
];
