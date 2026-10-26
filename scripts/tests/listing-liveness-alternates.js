import assert from 'node:assert/strict';
import { collectListingAlternates, restoreListingAlternates, carryListingAlternates } from '../../electron/ipc/listingLivenessAlternates.js';
import { listingEvidenceKey } from '../../electron/ipc/listingLivenessStore.js';

const at = '2026-10-26T12:00:00.000Z';
const posting = { level: 'L2', outcome: 'found', employer: 'Northwind Labs' };
const enough = 'Synthetic position details. '.repeat(25);
const scoreSafe = row => !row?.descriptionDeferredReason
  && String(row?.snippet || row?.description || '').replace(/\s+/gu, ' ').trim().length >= 400;
const row = (source, jobkey, extra = {}) => ({
  source, jobkey, url: `https://${source}.example/jobs/${jobkey}`,
  title: 'Synthetic Systems Analyst', company: 'Northwind Labs', location: 'Ottawa',
  snippet: enough, description: enough, ...extra,
});
const state = (verdict, basis, board = 'linkedin') => ({ verdict, basis, board, at });
const closed = (source, jobkey, extra = {}) => row(source, jobkey, {
  listingLiveness: state('closed', 'ai', source),
  boardClosed: { board: source, reason: 'ai-confirmed-closed', at }, ...extra,
});
const receipt = (kept, dropped, reason = 'cross-source-title-company-location') => ({ kept, dropped, reason });

export default [
  { name: 'listing alternates deferred: kept rows carry three safe nonclosed board links without text or identity changes', run() {
    const winner = row('linkedin', 'primary');
    const candidates = [
      row('indeed', 'one'), row('dice', 'two', { listingLiveness: state('pending', 'neither', 'dice') }),
      closed('ziprecruiter', 'closed'), row('remoteok', 'three'), row('weworkremotely', 'four'),
      row('dice', 'insecure', { url: 'http://dice.example/jobs/insecure' }),
    ];
    const carried = carryListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), candidates]]),
    });
    assert.equal(carried[0].url, winner.url);
    assert.equal(carried[0].source, winner.source);
    assert.deepEqual(carried[0].alternateListings, candidates.filter(item => ['one', 'two', 'three'].includes(item.jobkey))
      .map(item => ({ board: item.source, url: item.url })));
    assert.deepEqual(Object.keys(carried[0].alternateListings[0]), ['board', 'url']);
    assert.equal(Object.hasOwn(carried[0].alternateListings[0], 'description'), false);
    const restored = carryListingAlternates([candidates[0]], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), candidates]]),
      restored: [{ winner, alternate: candidates[0], row: candidates[0] }],
    });
    assert.equal(restored[0].alternateListings.some(item => item.url === candidates[0].url), false);
  } },
  { name: 'listing alternates: both dedup stages chain winners, retain receipt order and cap four', run() {
    const a = row('linkedin', 'a');
    const x = row('indeed', 'x');
    const official = row('careers', 'official');
    const [a1, a2, a3, x1, x2] = [
      row('dice', 'a1'), row('ziprecruiter', 'a2'), row('glassdoor', 'a3'),
      row('google', 'x1'), row('remoteok', 'x2'),
    ];
    const result = collectListingAlternates({
      admissionDrops: [receipt(a, a1), receipt(a, a2, 'cross-source-full-description'), receipt(a, a3),
        receipt(x, x1), receipt(x, x2), receipt(a, row('linkedin', 'same'), 'same-source-listing-id')],
      finalDrops: [receipt(x, a)],
      officialDrops: [receipt(official, x, 'official-url')],
      finalKept: [official],
    });
    assert.deepEqual(result.get(listingEvidenceKey(official)), [a1, a2, a3, x1]);
    assert.equal(result.size, 1);
  } },
  { name: 'listing alternates: same-source final loss transfers earlier candidates without adding its loser', run() {
    const first = row('linkedin', 'one');
    const survivor = row('linkedin', 'two');
    const alternate = row('indeed', 'other');
    const result = collectListingAlternates({
      admissionDrops: [receipt(first, alternate)],
      finalDrops: [receipt(survivor, first, 'same-source-listing-id')],
      finalKept: [survivor],
    });
    assert.deepEqual(result.get(listingEvidenceKey(survivor)), [alternate]);
  } },
  { name: 'listing alternates: open wins by rank and restoration retains own link and identity', async run() {
    const winner = closed('linkedin', 'winner', { company: 'Acme Talent Partners', officialPosting: posting });
    const pending = row('dice', 'pending', { listingLiveness: state('pending', 'closed-marker', 'dice') });
    const open = row('indeed', 'open', { listingLiveness: state('open', 'ai', 'indeed'),
      googleCardUrl: 'https://google.example/card/open', applyOptions: [{ url: 'https://indeed.example/apply/open' }] });
    const result = await restoreListingAlternates([row('google', 'before'), winner, row('google', 'after')], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [pending, open]]]),
      scoreSafe, shouldTryWinner: async () => true,
    });
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0].jobkey, 'before');
    assert.equal(result.rows[2].jobkey, 'after');
    assert.equal(result.rows[1].url, open.url);
    assert.equal(result.rows[1].source, open.source);
    assert.equal(result.rows[1].jobkey, open.jobkey);
    assert.equal(result.rows[1].googleCardUrl, open.googleCardUrl);
    assert.equal(result.rows[1].applyOptions, open.applyOptions);
    assert.deepEqual(result.rows[1].listingLiveness, open.listingLiveness);
    assert.equal(result.rows[1].boardClosed, undefined, 'the closed winner marker must not leak to the alternate');
    assert.equal(result.rows[1].officialPosting, posting);
    assert.equal(result.rows[1].postedBy, undefined, 'posting employer matches the alternate company');
    assert.equal(result.restored.length, 1);
    assert.equal(result.restored[0].winner, winner);
    assert.equal(result.restored[0].alternate, open);
    assert.equal(result.restored[0].row, result.rows[1]);
  } },
  { name: 'listing alternates: borrowed text clears deferral, recomputes postedBy and keeps own marker', async run() {
    const winner = closed('linkedin', 'winner', { company: 'Northwind Labs', officialPosting: posting });
    const alternate = row('indeed', 'alternate', { company: 'Acme Talent Partners', snippet: '', description: '',
      descriptionDeferredReason: 'description-card-unavailable', boardClosed: { board: 'indeed', reason: 'indeed-job-unavailable', at } });
    const result = await restoreListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
      scoreSafe, shouldTryWinner: () => true,
    });
    assert.equal(result.restored.length, 1);
    const restored = result.rows[0];
    assert.equal(restored.url, alternate.url);
    assert.equal(restored.description, winner.description);
    assert.equal(restored.snippet, winner.snippet);
    assert.equal(restored.descriptionDeferredReason, undefined);
    assert.equal(restored.postedBy, 'Acme Talent Partners');
    assert.deepEqual(restored.boardClosed, alternate.boardClosed, 'legacy marker belongs to the alternate');
    assert(scoreSafe(restored));
  } },
  { name: 'listing alternates: unresolved official employer is recomputed for the alternate company', async run() {
    const alternate = row('indeed', 'agency', { company: 'Acme Talent Partners',
      title: 'Synthetic Systems Analyst at Northwind Labs' });
    for (const officialPosting of [
      { level: 'L5', outcome: 'not-found', employer: 'Northwind Labs' },
      { level: 'L6', outcome: 'not-found', employer: '' },
    ]) {
      const winner = closed('linkedin', `winner-${officialPosting.level}`, { officialPosting });
      const result = await restoreListingAlternates([winner], {
        alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
        scoreSafe, shouldTryWinner: () => true,
      });
      assert.equal(result.rows[0].postedBy, 'Acme Talent Partners', `${officialPosting.level} must use the alternate's poster`);
      assert.equal(result.rows[0].officialPosting, officialPosting);
    }
  } },
  { name: 'listing alternates: one second AI callback rejects newly closed candidates and keeps official-protected winners', async run() {
    const winnerA = closed('linkedin', 'a', { officialPosting: posting });
    const winnerB = closed('linkedin', 'b');
    const protectedWinner = closed('linkedin', 'protected', { officialPosting: posting });
    const altA = row('indeed', 'a', { listingLiveness: state('pending', 'neither', 'indeed') });
    const altB = row('dice', 'b', { listingLiveness: state('pending', 'closed-marker', 'dice') });
    const altProtected = row('ziprecruiter', 'protected', { listingLiveness: state('pending', 'neither', 'ziprecruiter') });
    let calls = 0;
    const result = await restoreListingAlternates([winnerA, winnerB, protectedWinner], {
      alternatesByKey: new Map([
        [listingEvidenceKey(winnerA), [altA]], [listingEvidenceKey(winnerB), [altB]],
        [listingEvidenceKey(protectedWinner), [altProtected]],
      ]),
      scoreSafe, shouldTryWinner: winner => winner !== protectedWinner,
      hasEvidence: () => true,
      classifyPending: pending => {
        calls += 1;
        assert.deepEqual(pending, [altA, altB]);
        return [
          { ...altA, listingLiveness: state('open', 'ai', 'indeed') },
          { ...altB, listingLiveness: state('closed', 'ai', 'dice'),
            boardClosed: { board: 'dice', reason: 'ai-confirmed-closed', at } },
        ];
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.rows[0].url, altA.url);
    assert.equal(result.rows[0].listingLiveness.verdict, 'open');
    assert.equal(result.rows[1], winnerB, 'AI-confirmed-closed candidate cannot be restored');
    assert.equal(result.rows[2], protectedWinner);
    assert.equal(result.restored.length, 1);
    assert.equal(result.classified.get(listingEvidenceKey(altB)).listingLiveness.verdict, 'closed',
      'the search seam needs the classified copy to exclude a newly closed Generate alternate');
  } },
  { name: 'listing alternates: neither row can lend score-safe text, and AI failure leaves pending candidate available', async run() {
    const winner = closed('linkedin', 'winner', { snippet: '', description: '' });
    const alternate = row('indeed', 'alternate', { snippet: '', description: '', listingLiveness: state('pending', 'neither', 'indeed') });
    let noTextCalls = 0;
    const noText = await restoreListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
      scoreSafe, shouldTryWinner: () => true, hasEvidence: () => true,
      classifyPending: () => { noTextCalls += 1; return []; },
    });
    assert.equal(noTextCalls, 0, 'nonrestorable alternate must not be classified');
    assert.equal(noText.rows[0], winner);
    assert.equal(noText.restored.length, 0);
    const describedWinner = { ...winner, snippet: enough };
    let alreadyOpenCalls = 0;
    const alreadyOpen = { ...alternate, listingLiveness: state('open', 'ai', 'indeed') };
    await restoreListingAlternates([describedWinner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alreadyOpen]]]),
      scoreSafe, shouldTryWinner: () => true, hasEvidence: () => true,
      classifyPending: () => { alreadyOpenCalls += 1; return []; },
    });
    assert.equal(alreadyOpenCalls, 0, 'an already classified alternate must not be re-sent');
    let called = 0;
    const failedAi = await restoreListingAlternates([describedWinner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
      scoreSafe, shouldTryWinner: () => true, hasEvidence: () => true,
      classifyPending: () => { called += 1; throw new Error('synthetic bridge failure'); },
    });
    assert.equal(called, 1);
    assert.equal(failedAi.rows[0].url, alternate.url);
    assert.equal(failedAi.rows[0].listingLiveness.verdict, 'pending');
    assert(scoreSafe(failedAi.rows[0]));
  } },
  { name: 'listing alternates: run abort propagates its exact reason', async run() {
    const winner = closed('linkedin', 'winner');
    const alternate = row('indeed', 'alternate');
    const controller = new AbortController();
    const reason = new Error('synthetic cancellation');
    await assert.rejects(restoreListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
      scoreSafe, signal: controller.signal,
      shouldTryWinner: () => { controller.abort(reason); return true; },
    }), error => error === reason);
  } },
  { name: 'listing alternates: every winner short of confirmed closure keeps its own link', async run() {
    for (const [verdict, basis] of [['open', 'ai'], ['pending', 'neither'], ['pending', 'closed-marker']]) {
      const winner = row('linkedin', `winner-${verdict}-${basis}`, { listingLiveness: state(verdict, basis, 'linkedin'), officialPosting: posting });
      const alternate = row('indeed', `alternate-${verdict}-${basis}`, { listingLiveness: state('open', 'ai', 'indeed') });
      const result = await restoreListingAlternates([winner], {
        alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]),
        scoreSafe, shouldTryWinner: async () => true,
      });
      assert.equal(result.rows[0], winner, `${verdict}/${basis} winner retains its own link and identity`);
      assert.equal(result.restored.length, 0);
    }
  } },
  { name: 'listing alternates: an alternate with score-safe text keeps its own wording', async run() {
    const winner = closed('linkedin', 'winner-own-text', { snippet: enough, description: enough, officialPosting: posting });
    const ownText = 'Alternate synthetic wording about product support and operations. '.repeat(12);
    const alternate = row('indeed', 'alternate-own-text', { snippet: ownText, description: ownText,
      listingLiveness: state('open', 'ai', 'indeed') });
    const result = await restoreListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]), scoreSafe,
      shouldTryWinner: async () => true,
    });
    assert.equal(result.restored.length, 1);
    assert.equal(result.rows[0].snippet, ownText);
    assert.equal(result.rows[0].description, ownText);
    assert.equal(result.rows[0].url, alternate.url);
  } },
  { name: 'listing alternates: an open alternate with its own text survives a textless closed winner', async run() {
    const winner = closed('linkedin', 'winner-no-text', { snippet: '', description: '', officialPosting: posting });
    const ownText = 'Alternate synthetic description for the open role and its platform duties. '.repeat(12);
    const alternate = row('indeed', 'alternate-with-text', { snippet: ownText, description: ownText,
      listingLiveness: state('open', 'ai', 'indeed') });
    const result = await restoreListingAlternates([winner], {
      alternatesByKey: new Map([[listingEvidenceKey(winner), [alternate]]]), scoreSafe,
      shouldTryWinner: async () => true,
    });
    assert.equal(result.restored.length, 1);
    assert.equal(result.rows[0].url, alternate.url);
    assert.equal(result.rows[0].snippet, ownText);
  } },
];
