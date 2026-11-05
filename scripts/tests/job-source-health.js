import assert from 'node:assert/strict';
import { assessSourceHealth, sourceHealthWarning } from '../../electron/ipc/jobSourceHealth.js';
import { collectionScopeCaveatsFromSourceResults, describeSourceHealthFailures, normalizeCollectionScopeCaveats, sourceHealthCaveats } from '../../src/utils/jobCollectionScopeCaveats.js';
import { isJobSourceWarningGating } from '../../src/utils/jobSourceWarningPolicy.js';
import { detailBlockCooldownMs } from '../../electron/ipc/browser/manualScraper.js';
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
];
