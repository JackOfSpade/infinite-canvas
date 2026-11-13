import assert from 'node:assert/strict';
import { DICE_TEASER_MAX_CHARS, isDiceTeaserRow, refreshDiceTeaserRows } from '../../electron/ipc/diceTeaserRefresh.js';

const diceRow = (fields = {}) => ({ source: 'dice', url: 'https://dice.example.test/job/1', title: 'Engineer', ...fields });
const teaser = (url = 'https://dice.example.test/job/1') => diceRow({ url, snippet: 's'.repeat(500) });

export default [
  {
    name: 'dice teaser: only short dice rows with a url are teasers',
    run() {
      assert.equal(DICE_TEASER_MAX_CHARS, 600);
      assert.equal(isDiceTeaserRow(diceRow({ snippet: 's'.repeat(500) })), true);
      assert.equal(isDiceTeaserRow(diceRow({ description: 'd'.repeat(2000) })), false);
      assert.equal(isDiceTeaserRow({ source: 'indeed', url: 'https://indeed.example.test/job/1', description: 'd'.repeat(100) }), false);
      assert.equal(isDiceTeaserRow(diceRow({ url: '   ', snippet: 's'.repeat(500) })), false);
      assert.equal(isDiceTeaserRow(diceRow({ description: 'd'.repeat(600) })), true);
      assert.equal(isDiceTeaserRow(diceRow({ description: 'd'.repeat(601) })), false);
      assert.equal(isDiceTeaserRow(null), false);
    },
  },
  {
    name: 'dice teaser: refresh enriches only teaser rows once and replaces them with longer text',
    async run() {
      const target = { ...teaser('https://dice.example.test/job/1'), matchScore: 77, title: 'Staff Engineer', salary: '$200k' };
      const alreadyLong = diceRow({ url: 'https://dice.example.test/job/2', description: 'd'.repeat(2000) });
      const indeed = { source: 'indeed', url: 'https://indeed.example.test/job/3', snippet: 'short' };
      const jobs = [alreadyLong, target, indeed];
      const calls = [];
      const signal = { aborted: false };
      const enrich = async (rows, receivedSignal) => {
        calls.push({ rows, receivedSignal });
        return [{ url: target.url, description: 'r'.repeat(1800), snippet: 'extra' }];
      };
      const result = await refreshDiceTeaserRows(jobs, { enrich, signal });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].rows.length, 1);
      assert.equal(calls[0].rows[0], target);
      assert.equal(calls[0].receivedSignal, signal);
      assert.equal(result.attempted, 1);
      assert.equal(result.lengthened, 1);
      assert.equal(result.jobs.length, 3);
      assert.equal(result.jobs[0], alreadyLong);
      assert.equal(result.jobs[2], indeed);
      assert.notEqual(result.jobs[1], target);
      assert.equal(result.jobs[1].url, target.url);
      assert.equal(result.jobs[1].description, 'r'.repeat(1800));
      assert.equal(result.jobs[1].snippet, 'extra');
      assert.equal(result.jobs[1].matchScore, 77);
      assert.equal(result.jobs[1].title, 'Staff Engineer');
      assert.equal(result.jobs[1].salary, '$200k');
    },
  },
  {
    name: 'dice teaser: a replacement mirrors a single enriched field into both description and snippet',
    async run() {
      const target = teaser();
      const fromDescription = await refreshDiceTeaserRows([target], {
        enrich: async () => [{ url: target.url, description: 'd'.repeat(1200) }],
      });
      assert.equal(fromDescription.lengthened, 1);
      assert.equal(fromDescription.jobs[0].description, 'd'.repeat(1200));
      assert.equal(fromDescription.jobs[0].snippet, 'd'.repeat(1200));
      const fromSnippet = await refreshDiceTeaserRows([target], {
        enrich: async () => [{ url: target.url, snippet: 's'.repeat(1300) }],
      });
      assert.equal(fromSnippet.lengthened, 1);
      assert.equal(fromSnippet.jobs[0].description, 's'.repeat(1300));
      assert.equal(fromSnippet.jobs[0].snippet, 's'.repeat(1300));
    },
  },
  {
    name: 'dice teaser: shorter, equal, null, omitted and throwing enrichments keep the original rows',
    async run() {
      const target = teaser();
      const shorter = await refreshDiceTeaserRows([target], { enrich: async () => [{ url: target.url, description: 'short' }] });
      assert.equal(shorter.jobs[0], target);
      assert.equal(shorter.attempted, 1);
      assert.equal(shorter.lengthened, 0);
      const equal = await refreshDiceTeaserRows([target], { enrich: async () => [{ url: target.url, snippet: 'x'.repeat(500) }] });
      assert.equal(equal.jobs[0], target);
      assert.equal(equal.lengthened, 0);
      const nulled = await refreshDiceTeaserRows([target], { enrich: async () => [null] });
      assert.equal(nulled.jobs[0], target);
      assert.equal(nulled.attempted, 1);
      assert.equal(nulled.lengthened, 0);
      const omitted = await refreshDiceTeaserRows([target], { enrich: async () => [] });
      assert.equal(omitted.jobs[0], target);
      assert.equal(omitted.attempted, 1);
      assert.equal(omitted.lengthened, 0);
      const thrown = await refreshDiceTeaserRows([target], { enrich: async () => { throw new Error('closed listing'); } });
      assert.equal(thrown.jobs[0], target);
      assert.equal(thrown.attempted, 1);
      assert.equal(thrown.lengthened, 0);
      const nonArray = await refreshDiceTeaserRows([target], { enrich: async () => null });
      assert.equal(nonArray.jobs[0], target);
      assert.equal(nonArray.attempted, 1);
      assert.equal(nonArray.lengthened, 0);
    },
  },
  {
    name: 'dice teaser: refresh reports attempted and lengthened exactly and never drops an omitted row',
    async run() {
      const first = teaser('https://dice.example.test/job/1');
      const second = teaser('https://dice.example.test/job/2');
      const result = await refreshDiceTeaserRows([first, second], {
        enrich: async rows => {
          assert.equal(rows.length, 2);
          return [{ url: first.url, description: 'd'.repeat(900) }];
        },
      });
      assert.equal(result.jobs.length, 2);
      assert.equal(result.jobs[0].description, 'd'.repeat(900));
      assert.equal(result.jobs[1], second);
      assert.equal(result.attempted, 2);
      assert.equal(result.lengthened, 1);
    },
  },
  {
    name: 'dice teaser: an aborted signal, no teaser rows or a missing enricher never calls enrich',
    async run() {
      let calls = 0;
      const enrich = async () => { calls += 1; return []; };
      const target = teaser();
      const aborted = await refreshDiceTeaserRows([target], { enrich, signal: { aborted: true } });
      assert.equal(calls, 0);
      assert.equal(aborted.attempted, 0);
      assert.equal(aborted.lengthened, 0);
      assert.equal(aborted.jobs.length, 1);
      assert.equal(aborted.jobs[0], target);
      const noTeaser = await refreshDiceTeaserRows([diceRow({ description: 'd'.repeat(2000) })], { enrich });
      assert.equal(calls, 0);
      assert.equal(noTeaser.attempted, 0);
      assert.equal(noTeaser.lengthened, 0);
      const noEnricher = await refreshDiceTeaserRows([target], { signal: { aborted: false } });
      assert.equal(noEnricher.attempted, 0);
      assert.equal(noEnricher.lengthened, 0);
      assert.equal(noEnricher.jobs[0], target);
      const nonArray = await refreshDiceTeaserRows(null, { enrich });
      assert.equal(nonArray.jobs.length, 0);
      assert.equal(nonArray.attempted, 0);
      assert.equal(calls, 0);
    },
  },
];
