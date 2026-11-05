import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScrapeAlarmStore, scrapeAlarmsMarkdown, scrapeShareBroken } from '../../electron/ipc/scrapeAlarms.js';
import { assessSourceHealth } from '../../electron/ipc/jobSourceHealth.js';
import { describeSourceHealthFailures } from '../../src/utils/jobCollectionScopeCaveats.js';
import { scrapeAlarmToast } from '../../src/hooks/useScrapeAlarms.js';

const withFile = async work => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-scrape-alarms-'));
  try { await work(path.join(directory, 'scrape-alarms.json')); } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
};
const failure = { what: 'pages could not be read', attempts: 20, bad: 12 };
const report = { key: 'official:page', surface: 'official posting reads', site: 'Employer pages', failure };

export default [
  {
    name: 'Scrape share: a few bad pages or a small sample never trip it',
    run() {
      const limits = { minAttempts: 10, minBad: 5, maxShare: 0.3 };
      assert.equal(scrapeShareBroken({ attempts: 4, bad: 4, ...limits }), false, 'small sample');
      assert.equal(scrapeShareBroken({ attempts: 200, bad: 4, ...limits }), false, 'isolated bad pages');
      assert.equal(scrapeShareBroken({ attempts: 100, bad: 30, ...limits }), false, 'at the limit');
      assert.equal(scrapeShareBroken({ attempts: 100, bad: 31, ...limits }), true);
    },
  },
  {
    name: 'Scrape alarm store: an alarm survives a restart, says what failed, and clears only on a healthy report',
    async run() {
      await withFile(async file => {
        let changes = 0; let time = 1_000;
        const first = createScrapeAlarmStore(file, { now: () => time, onChange: () => { changes++; } });
        first.report(report);
        await first.flush();
        assert.equal(changes, 1);
        const reopened = createScrapeAlarmStore(file, { now: () => time });
        assert.deepEqual(reopened.list(), [{ key: 'official:page', surface: 'official posting reads', site: 'Employer pages', what: 'pages could not be read', attempts: 20, bad: 12, at: 1_000, firstAt: 1_000 }]);
        time = 2_000;
        reopened.report(report);
        assert.deepEqual([reopened.list()[0].at, reopened.list()[0].firstAt], [2_000, 1_000], 'a repeat keeps when it began');
        assert.match(scrapeAlarmsMarkdown(reopened.list()), /official posting reads \/ Employer pages: pages could not be read \(12 of 20\)/u);
        assert.match(scrapeAlarmToast(reopened.list()[0]).title, /Employer pages official posting reads look broken/u);
        assert.equal(scrapeAlarmToast(reopened.list()[0]).duration, 0, 'it stays until dismissed');
        reopened.report({ key: 'official:page', failure: null });
        await reopened.flush();
        assert.deepEqual(createScrapeAlarmStore(file, { now: () => time }).list(), []);
        assert.match(scrapeAlarmsMarkdown([]), /None on record/u);
      });
    },
  },
  {
    name: 'Scrape alarm store: a damaged file, stale alarms and a failed save never stop a scrape',
    async run() {
      await withFile(async file => {
        await fs.promises.writeFile(file, '{ not json');
        const damaged = createScrapeAlarmStore(file);
        assert.deepEqual(damaged.list(), []);
        damaged.report(report);
        await damaged.flush();
        const longAfter = createScrapeAlarmStore(file, { now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 });
        assert.deepEqual(longAfter.list(), [], 'an alarm nothing has re-run drops after 30 days');
      });
    },
  },
  {
    name: 'Job site check: wrong descriptions alarm on the small runs Indeed returns, but not two copies or small lists',
    run() {
      const TEXT = 'Build reliable services for regional teams. '.repeat(12);
      const row = (index, snippet) => ({ source: 'indeed', title: 'Engineer', company: `Employer ${index}`, location: 'Toronto', posted: '1 day ago', url: `https://indeed.test/${index}`, snippet });
      const list = (size, copied) => Array.from({ length: size }, (_, index) => row(index, index < size - copied - 1 ? `${TEXT}${index}` : TEXT));
      const fields = rows => assessSourceHealth(rows).map(item => [item.field, item.missing]);
      assert.deepEqual(fields(list(15, 4)), [['same-description', 4]]);
      assert.deepEqual(fields(list(15, 2)), [], 'two repeats can be a shared agency template');
      assert.deepEqual(fields(list(9, 8)), [], 'too small for a share to mean anything');
    },
  },
  {
    name: 'Job site check: a page the fetcher could not read alarms',
    run() {
      const failures = assessSourceHealth([], { pageShapeFailures: { weworkremotely: 2, remoteok: 0 } });
      assert.deepEqual(failures.map(item => [item.source, item.field, item.missing]), [['weworkremotely', 'page-shape', 2]]);
      assert.match(describeSourceHealthFailures(failures), /2 pages loaded, but no listings could be read from them/u);
    },
  },
];
