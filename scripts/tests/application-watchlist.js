import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WATCH_DORMANT_REVIEWS, WATCH_READY_OCCURRENCES, applyWatchlistReview, readWatchlist, watchItemStats, watchlistReport } from '../../electron/ipc/applicationWatchlist.js';
import { improvementStatus, resetImprovementCounter } from '../../electron/ipc/applicationEditLog.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'ic-watch-'));
const pairs = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

export default [{
  name: 'application watch list: an item accumulates corrections, keeps and reviews across sessions',
  run: async () => {
    const root = await temp();
    const first = pairs('a', 4);
    const opened = await applyWatchlistReview(root, { at: '2026-10-28T00:00:00.000Z', pairIds: first, items: [
      { summary: 'Closing retells proof the body already gave', category: 'letter structure', document: 'letter', occurred: ['a-1'], kept: ['a-2'], reviewed: first },
    ] });
    const [item] = opened.items;
    assert.deepEqual([item.occurrences, item.kept, item.reviewed, item.ready], [1, 1, 4, false]);
    const second = pairs('b', 3);
    const later = await applyWatchlistReview(root, { at: '2026-11-04T00:00:00.000Z', pairIds: second, items: [{ id: item.id, occurred: ['b-1', 'b-3'], reviewed: second }] });
    const grown = later.items[0];
    assert.equal(grown.occurrences, WATCH_READY_OCCURRENCES, 'corrections from two sessions add up');
    assert.equal(grown.reviewed, 7);
    assert.equal(grown.ready, true, 'three corrected bundles across sessions make it ready');
    assert.equal(grown.lowRate, false);
  },
}, {
  name: 'application watch list: rare corrections over many reviews read as variation, then dormancy',
  run: async () => {
    const reviewed = pairs('p', 30);
    const item = { status: 'watching', occurred: ['p-1', 'p-2', 'p-3'], kept: [], reviewed };
    const stats = watchItemStats(item, [{ pairIds: reviewed }]);
    assert.equal(stats.ready, true);
    assert.equal(stats.lowRate, true, '3 of 30 is below the one-in-six floor');
    assert.equal(stats.dormant, true, `${WATCH_DORMANT_REVIEWS}+ reviews since the last correction`);
    const recent = watchItemStats({ ...item, occurred: ['p-30'] }, [{ pairIds: reviewed }]);
    assert.equal(recent.dormant, false);
  },
}, {
  name: 'application watch list: reviews are validated and status changes need a reason',
  run: async () => {
    const root = await temp();
    const at = '2026-10-28T00:00:00.000Z';
    await assert.rejects(applyWatchlistReview(root, { at, pairIds: ['x'], items: [{ summary: 's', category: 'wording', document: 'letter', occurred: ['y'] }] }), /outside this review/u);
    await assert.rejects(applyWatchlistReview(root, { at, pairIds: ['x'], items: [{ summary: 's', category: 'tone', document: 'letter' }] }), /category/u);
    await assert.rejects(applyWatchlistReview(root, { at, pairIds: ['x'], items: [{ summary: 's', category: 'wording', document: 'letter', occurred: ['x'], kept: ['x'] }] }), /both correct and keep/u);
    const { items: [item] } = await applyWatchlistReview(root, { at, pairIds: ['x'], items: [{ summary: 's', category: 'wording', document: 'letter', occurred: ['x'] }] });
    await assert.rejects(applyWatchlistReview(root, { at, pairIds: ['z'], items: [{ id: item.id, status: 'resolved' }] }), /needs a reason/u);
    await applyWatchlistReview(root, { at, pairIds: [], items: [{ id: item.id, status: 'resolved', reason: 'fixed at the source' }] });
    const list = await readWatchlist(root);
    assert.equal(list.items[0].status, 'resolved');
    assert.deepEqual(list.items[0].history.map(entry => [entry.from, entry.to]), [['watching', 'resolved']]);
    assert.equal(list.reviews.length, 1, 'rejected reviews and status-only updates add no review');
  },
}, {
  name: 'application watch list: survives the counter reset and appears in status',
  run: async () => {
    const root = await temp();
    await applyWatchlistReview(root, { at: '2026-10-28T00:00:00.000Z', pairIds: pairs('r', 3), items: [
      { summary: 'Letter restates résumé dates', category: 'wording', document: 'letter', occurred: pairs('r', 3) },
    ] });
    await resetImprovementCounter(root);
    const status = await improvementStatus(root);
    assert.equal(status.watchlist.watching, 1, 'the reset leaves watch items in place');
    assert.deepEqual(status.watchlist.ready.map(item => item.occurrences), [3]);
    assert.equal((await watchlistReport(root)).items.length, 1);
    await fs.writeFile(path.join(root, 'application-improvement', 'watchlist.json'), '{');
    assert.deepEqual((await improvementStatus(root)).watchlist, { unreadable: true }, 'a damaged list never hides the counter');
  },
}, {
  name: 'application watch list: career-data remedies are listed apart from generator changes',
  run: async () => {
    const root = await temp();
    const at = '2026-10-28T00:00:00.000Z';
    const { items } = await applyWatchlistReview(root, { at, pairIds: ['x', 'y'], items: [
      { summary: 'Source label copied into a résumé field', category: 'wording', document: 'resume', remedy: 'career data', occurred: ['x'] },
      { summary: 'Closing retells earlier proof', category: 'letter structure', document: 'letter', remedy: 'generator', occurred: ['y'] },
      { summary: 'Unclassified one-off', category: 'wording', document: 'letter', occurred: ['y'] },
    ] });
    assert.deepEqual(items.map(item => item.remedy), ['career data', 'generator', 'undecided'], 'an unspecified remedy reads as undecided');
    await assert.rejects(applyWatchlistReview(root, { at, pairIds: [], items: [{ id: items[2].id, remedy: 'prompt' }] }), /remedy must be one of/u);
    await applyWatchlistReview(root, { at, pairIds: [], items: [{ id: items[2].id, remedy: 'career data' }] });
    const status = (await improvementStatus(root)).watchlist;
    assert.deepEqual(status.careerDataEdits.map(item => item.summary), ['Source label copied into a résumé field', 'Unclassified one-off']);
    await applyWatchlistReview(root, { at, pairIds: [], items: [{ id: items[0].id, status: 'resolved', reason: 'source edited and confirmed' }] });
    assert.deepEqual((await improvementStatus(root)).watchlist.careerDataEdits.map(item => item.summary), ['Unclassified one-off'], 'resolved source fixes leave the list');
  },
}];
