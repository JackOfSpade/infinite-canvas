import assert from 'node:assert/strict';
import { assessOfficialPostingReads, createOfficialPostingReadMonitor, officialPostingReadObservations, resetOfficialPostingReadHealthForTests } from '../../electron/ipc/officialPostingReadHealth.js';

const rep = (kind, ok, bad, extra = {}) => [...Array(ok).fill({ kind, bad: false, ...extra }), ...Array(bad).fill({ kind, bad: true, ...extra })];
const keys = reports => reports.map(r => `${r.key}:${r.failure ? `${r.failure.bad}/${r.failure.attempts}` : 'clear'}`).sort();

// Measured 2026-11-05 from official-postings/judgments.jsonl and .1 (636 snapshots, 4 hours). Per hour, final snapshots:
// 02:00 page 200 (8 unread, httpStatus 202, renderFailed load-failed), renders 232 (8 failed), board-data 84 (0 bad).
// 07:00 page 206 (0 bad), renders 218 (0 failed), board-data 64 (0 bad). Whole log: renders 530 attempts, 8 failed.
const LOG_HOURS = [
  { page: [192, 8], render: [224, 8], ats: [84, 0] },
  { page: [206, 0], render: [218, 0], ats: [64, 0] },
];
const lead = (url, dataUrl) => ({ id: 'P1', url, kind: 'posting', ...(dataUrl ? { dataUrl } : {}) });

export default [
  { name: 'the real judgments log, hour by hour, raises nothing', run() {
    for (const hour of LOG_HOURS) {
      const reports = assessOfficialPostingReads([...rep('page', ...hour.page), ...rep('render', ...hour.render), ...rep('ats', hour.ats[0], hour.ats[1], { vendor: 'greenhouse' })]);
      assert.ok(reports.every(r => r.failure === null), JSON.stringify(reports));
    }
  } },
  { name: 'a broken run fires each surface with its own key and counts', run() {
    const reports = assessOfficialPostingReads([
      ...rep('page', 2, 18),
      ...rep('render', 0, 20),
      ...rep('ats', 1, 5, { vendor: 'ashby' }),
      ...rep('ats', 10, 0, { vendor: 'greenhouse' }),
    ]);
    assert.deepEqual(keys(reports), ['official:ats:ashby:5/6', 'official:ats:greenhouse:clear', 'official:page:18/20', 'official:render:20/20']);
    assert.equal(reports.find(r => r.key === 'official:render').site, 'Throwaway browser');
    assert.equal(reports.find(r => r.key === 'official:ats:ashby').site, 'ashby');
  } },
  { name: 'a changed vendor format fires across employers; one employer read again, or an honest 404, does not', run() {
    const board = name => lead(`https://jobs.ashbyhq.com/${name}/304271cf-0f60-44a6-8c8d-a729aa2e8028`, `https://api.ashbyhq.com/posting-api/job-board/${name}`);
    const empty = { source: 'board-data', read: true, postingsInData: 0 };
    const many = ['a1', 'b2', 'c3', 'd4', 'e5'].map(board);
    const obs = officialPostingReadObservations({ leads: many, plain: many.map(() => empty), final: many.map(() => empty) });
    assert.deepEqual(keys(assessOfficialPostingReads(obs)), ['official:ats:ashby:5/5']);
    const same = Array(5).fill(board('freed'));
    assert.deepEqual(assessOfficialPostingReads(officialPostingReadObservations({ leads: same, plain: same.map(() => empty), final: same.map(() => empty) })), [],
      'an employer with no open jobs, checked five times, is one employer');
    const closed = officialPostingReadObservations({ leads: [board('freed')], plain: [{ source: 'board-data', read: false, notFound: true, httpStatus: 404 }], final: [{ read: true }] });
    assert.deepEqual(closed.map(item => [item.kind, item.vendor, item.bad]), [['ats', 'ashby', false]]);
  } },
  { name: 'known blocks, 404s and cancelled or busy renders are not broken reads', run() {
    const leads = ['a', 'b', 'c', 'd', 'e'].map(n => lead(`https://${n}.example.com/jobs/1`));
    const final = [{ read: false, httpStatus: 403, renderFailed: 'aborted' }, { read: false, httpStatus: 429, renderFailed: 'busy' },
      { read: false, httpStatus: 404, notFound: true, renderFailed: 'blocked' }, { read: true, rendered: true }, { read: false, renderFailed: 'unsafe-address' }];
    assert.deepEqual(officialPostingReadObservations({ leads, plain: final, final }), [{ kind: 'page', bad: false }, { kind: 'render', bad: false }]);
  } },
  { name: 'a firewall challenge (HTTP 202 with no page) is a known block, not a broken reader', run() {
    const leads = [lead('https://x.example.com/jobs/1')];
    const final = [{ read: false, httpStatus: 202, renderFailed: 'load-failed' }];
    assert.deepEqual(officialPostingReadObservations({ leads, plain: final, final }).filter(item => item.kind === 'page'), []);
  } },
  { name: 'browser-unavailable and load-failed renders count; an unread page with no status counts', run() {
    const leads = [lead('https://x.example.com/jobs/1'), lead('https://y.example.com/jobs/2')];
    const obs = officialPostingReadObservations({ leads, plain: [{ read: false }, { read: false, httpStatus: 502 }],
      final: [{ read: false, renderFailed: 'browser-unavailable' }, { read: false, renderFailed: 'load-failed' }] });
    assert.deepEqual(obs, [{ kind: 'page', bad: true }, { kind: 'render', bad: true }, { kind: 'page', bad: true }, { kind: 'render', bad: true }]);
  } },
  { name: 'a plain download the browser then recovered is not a broken read', run() {
    const obs = officialPostingReadObservations({ leads: [lead('https://x.example.com/jobs/1')], plain: [{ read: false }], final: [{ read: true, rendered: true }] });
    assert.deepEqual(obs, [{ kind: 'page', bad: false }, { kind: 'render', bad: false }]);
  } },
  { name: 'a few bad reads in a big run, or any in a small run, neither fire nor clear', run() {
    assert.deepEqual(keys(assessOfficialPostingReads(rep('page', 40, 4))), ['official:page:clear']);
    assert.deepEqual(assessOfficialPostingReads(rep('page', 0, 9)), []);
    assert.deepEqual(assessOfficialPostingReads(rep('render', 19, 0)), []);
    assert.deepEqual(assessOfficialPostingReads(rep('ats', 2, 2, { vendor: 'lever' })), []);
    assert.deepEqual(assessOfficialPostingReads(rep('page', 7, 5)), [], 'five dead links in one lookup of twelve');
    assert.deepEqual(assessOfficialPostingReads(rep('page', 20, 5)).map(r => r.failure), [null]);
  } },
  { name: 'AI or unknown observations raise nothing', run() {
    assert.deepEqual(assessOfficialPostingReads([{ kind: 'ai', bad: true }, { kind: 'bridge-unavailable' }, null, undefined, { kind: 'ats', vendor: 'Bad Vendor!', bad: true }]), []);
    assert.deepEqual(assessOfficialPostingReads('nope'), []);
  } },
  { name: 'reads add up across small lookups, an alarm clears once recent reads are clean, and a cancelled run is ignored', run() {
    resetOfficialPostingReadHealthForTests();
    const sent = [];
    const lookup = (size, snapshot) => {
      const monitor = createOfficialPostingReadMonitor({ report: r => sent.push(r) });
      const leads = Array.from({ length: size }, () => lead('https://x.example.com/jobs/1'));
      monitor.observe({ leads, plain: leads.map(() => snapshot), final: leads.map(() => snapshot) });
      monitor.flush();
    };
    const broken = { read: false, renderFailed: 'browser-unavailable' };
    for (let card = 0; card < 3; card += 1) { sent.length = 0; lookup(6, broken); assert.deepEqual(sent, [], 'six reads say nothing yet'); }
    lookup(6, broken);
    assert.deepEqual(keys(sent), ['official:page:24/24', 'official:render:24/24'], 'card-by-card work still reaches the sample');
    sent.length = 0;
    lookup(40, { read: true, rendered: true });
    assert.deepEqual(sent.filter(r => r.failure).length, 2, 'still mostly broken: 24 of 64');
    sent.length = 0;
    lookup(40, { read: true, rendered: true });
    assert.deepEqual(keys(sent), ['official:page:clear', 'official:render:clear']);
    sent.length = 0;
    const controller = new AbortController();
    const cancelled = createOfficialPostingReadMonitor({ signal: controller.signal, report: r => sent.push(r) });
    const leads = Array.from({ length: 20 }, () => lead('https://x.example.com/jobs/1'));
    cancelled.observe({ leads, plain: leads.map(() => broken), final: leads.map(() => broken) });
    controller.abort();
    cancelled.flush();
    assert.equal(sent.length, 0);
  } },
  { name: 'a very long run reports by count, and a throwing report never escapes', run() {
    resetOfficialPostingReadHealthForTests();
    const sent = [];
    const monitor = createOfficialPostingReadMonitor({ windowSize: 20, report: r => sent.push(r) });
    const leads = Array.from({ length: 25 }, () => lead('https://x.example.com/jobs/1'));
    monitor.observe({ leads, plain: leads.map(() => ({ read: false })), final: leads.map(() => ({ read: false })) });
    assert.deepEqual(keys(sent), ['official:page:25/25']);
    const throwing = createOfficialPostingReadMonitor({ windowSize: 1, report: () => { throw new Error('boom'); } });
    throwing.observe({ leads, plain: leads.map(() => ({ read: false })), final: leads.map(() => ({ read: false })) });
    throwing.observe(null); throwing.flush();
    resetOfficialPostingReadHealthForTests();
  } },
];
