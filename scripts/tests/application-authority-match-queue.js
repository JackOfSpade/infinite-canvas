import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { fs, createAuthorityLedgerStore, createStoreAuthorityWorkflowRoot, openAuthorityLedgerStore, __setAuthorityLedgerStoreFaultHookForTests } from '../test-dependencies.js';
import { __authorityMatchPlanForTests, __claimCurrentAuthorityMatchForTests, __commitCurrentAuthorityMatchForTests, __currentAuthorityMatchQueueForTests, __materializeCurrentAuthorityMatchesForTests, __resetAuthorityMatchQueueClaimsForTests } from '../../electron/ipc/localAiApplication.js';

async function fixture(catalogCount = 2) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-match-queue-'));
  const store = await createAuthorityLedgerStore(root, { namespace: 'match-queue', genesis: { jobId: 'match-queue' } });
  await store.appendReceiptPage('requirements', [
    { id: 'listing-a', kind: 'listing-evidence', item: { id: 'listing-a', sourceId: 'job-listing', quote: 'Build systems', requirement: 'Build systems', priority: 'highest' } },
    { id: 'requirement-a', kind: 'requirement', item: { id: 'requirement-a', text: 'Build systems', priority: 'highest', evidenceIds: ['listing-a'] } },
  ]);
  for (let index = 0; index < catalogCount; index += 1) {
    await store.appendReceiptPage('catalog', [{ id: `catalog:${index}`, kind: 'catalog-evidence', item: { id: `career-${index}`, sourceId: 'career-data', quote: `Systems evidence ${index}.` } }]);
  }
  const receipt = store.receipt();
  return { root, store, workflow: { root: createStoreAuthorityWorkflowRoot({ requirements: receipt.streams.requirements, catalog: receipt.streams.catalog, rolesDigest: 'roles', skillsDigest: 'skills', catalogPageSize: 24 }) } };
}

function response(work, id) {
  return { version: 1, rootDigest: work.pair.rootDigest, pairDigest: work.pair.digest,
    rows: [{ requirementId: 'requirement-a', candidateEvidenceIds: [id], localStatus: 'matched' }] };
}

export default [{
  name: 'application authority match queue: a multi-million-pair plan has an exact aggregate forecast without allocating pair descriptors',
  run: async () => {
    const plan = __authorityMatchPlanForTests({ root: { digest: 'a'.repeat(64), requirements: { count: 5_000 }, catalog: { count: 5_000 } } });
    assert(plan.pairCount === 25_000_000 && plan.requirementPageCount === 5_000 && plan.catalogPageCount === 5_000
      && !Object.hasOwn(plan, 'pairs') && Object.keys(plan).length < 12,
    'the plan keeps an exact unbounded aggregate forecast without materializing its Cartesian product');
  },
}, {
  name: 'application authority match queue: materializes only a fixed live wave while retaining an exact larger backlog',
  run: async () => {
    const value = await fixture(11); const jobId = '00000000-0000-4000-8000-000000000003';
    try {
      const claims = [];
      for (let ordinal = 0; ordinal < 10; ordinal += 1) claims.push(await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal }));
      let queue = await __currentAuthorityMatchQueueForTests(value.store, value.workflow);
      assert(queue.plan.pairCount === 11 && queue.slots.size === 10 && queue.waveStart === 0 && queue.waveEnd === 10,
        'only the first ten supported live tasks are represented despite an exact larger forecast');
      for (let ordinal = 9; ordinal >= 0; ordinal -= 1) await __commitCurrentAuthorityMatchForTests({ ...value, jobId, ordinal, claim: claims[ordinal].claim, response: response(claims[ordinal].task, `career-${ordinal}`) });
      queue = await __materializeCurrentAuthorityMatchesForTests(value.store, value.workflow, await __currentAuthorityMatchQueueForTests(value.store, value.workflow));
      assert(queue.materializedCount === 10 && queue.waveStart === 10 && queue.waveEnd === 11 && queue.slots.size === 0
        && value.store.receipt().streams.matches.count === 10,
      'the finished wave is streamed canonically and the remaining aggregate work becomes one new bounded wave');
    } finally { __resetAuthorityMatchQueueClaimsForTests(); await fs.promises.rm(value.root, { recursive: true, force: true }); }
  },
}, {
  name: 'application authority match queue: reverse completion, reclaim, canonical materialization, and no early coverage',
  run: async () => {
    const value = await fixture(); const jobId = '00000000-0000-4000-8000-000000000001';
    try {
      const second = await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 1 });
      const first = await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0 });
      assert(second.claim && first.claim && second.claim.digest !== first.claim.digest, 'two distinct workers claim distinct durable pairs');
      await __commitCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 1, claim: second.claim, response: response(second.task, 'career-1') });
      const queuePagesBeforeDuplicate = value.store.receipt().streams['match-queue'].count;
      await __commitCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 1, claim: second.claim, response: response(second.task, 'career-1') });
      assert(value.store.receipt().streams['match-queue'].count === queuePagesBeforeDuplicate,
        'the exact same completion retry is idempotent and writes no second receipt');
      let queue = await __currentAuthorityMatchQueueForTests(value.store, value.workflow);
      assert(queue.completedCount === 1 && !queue.complete, 'one reverse-order result never unlocks selection/materialization');
      let incompleteRejected = false;
      try { await __materializeCurrentAuthorityMatchesForTests(value.store, value.workflow, queue); } catch (error) { incompleteRejected = /coverage is incomplete/i.test(error?.message || ''); }
      assert(incompleteRejected, 'canonical reducers cannot run before every deterministic ordinal is complete');
      __resetAuthorityMatchQueueClaimsForTests();
      const reclaimed = await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0 });
      assert(reclaimed.claim.attempt === first.claim.attempt + 1 && reclaimed.claim.digest !== first.claim.digest,
        'a restart safely reissues an unfinished claim with a fresh token');
      let staleRejected = false;
      try { await __commitCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0, claim: first.claim, response: response(first.task, 'career-0') }); } catch (error) { staleRejected = /stale|conflicts/i.test(error?.message || ''); }
      assert(staleRejected, 'a stale worker cannot complete a reclaimed pair');
      await __commitCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0, claim: reclaimed.claim, response: response(reclaimed.task, 'career-0') });
      queue = await __currentAuthorityMatchQueueForTests(value.store, value.workflow);
      assert(!queue.complete && queue.completedCount === 2, 'only complete authenticated wave coverage unlocks materialization');
      queue = await __materializeCurrentAuthorityMatchesForTests(value.store, value.workflow, queue);
      assert(queue.complete, 'the exact aggregate total is complete only after the canonical wave is materialized');
      const firstPage = await value.store.getReceiptPage('matches', 0); const secondPage = await value.store.getReceiptPage('matches', 1);
      assert(firstPage.records[0].receipt.catalogPageIndex === 0 && secondPage.records[0].receipt.catalogPageIndex === 1,
        'arrival order is deterministically rewritten into canonical ordinal match pages');
    } finally { __resetAuthorityMatchQueueClaimsForTests(); await fs.promises.rm(value.root, { recursive: true, force: true }); }
  },
}, {
  name: 'application authority match queue: a rolled-back claim removes its unreachable immutable page before a fresh capability is minted',
  run: async () => {
    const value = await fixture(); const jobId = '00000000-0000-4000-8000-000000000004';
    try {
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'journal-published') throw new Error(step); });
      let interrupted = false;
      try { await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0, holdJournal: true }); }
      catch (error) { interrupted = /journal-published/.test(String(error?.message || error)); }
      finally { __setAuthorityLedgerStoreFaultHookForTests(null); }
      assert(interrupted, 'the held claim is interrupted after its journal publication but before a manifest could point at it');
      const reopened = await openAuthorityLedgerStore(value.root, { namespace: 'match-queue' });
      await reopened.rollbackPendingJournal();
      const reclaimed = await __claimCurrentAuthorityMatchForTests({ store: reopened, workflow: value.workflow, jobId, ordinal: 0, holdJournal: true });
      assert(reclaimed.claim?.attempt === 1 && reclaimed.claim?.code,
        'rollback deletes only the unreachable immutable claim page, so a fresh random claim cannot collide with it');
    } finally { __setAuthorityLedgerStoreFaultHookForTests(null); __resetAuthorityMatchQueueClaimsForTests(); await fs.promises.rm(value.root, { recursive: true, force: true }); }
  },
}, {
  name: 'application authority match queue: a substituted durable claim page is rejected before any task is reissued',
  run: async () => {
    const value = await fixture(); const jobId = '00000000-0000-4000-8000-000000000002';
    try {
      await __claimCurrentAuthorityMatchForTests({ ...value, jobId, ordinal: 0 });
      await fs.promises.writeFile(path.join(value.root, 'match-queue-pages', 'match-queue-000000000000.json'), '{}', 'utf8');
      let rejected = false;
      try { await __currentAuthorityMatchQueueForTests(value.store, value.workflow); } catch (error) { rejected = /inclusion proof|tampered/i.test(error?.message || ''); }
      assert(rejected, 'a tampered durable claim receipt cannot be replayed or reclaimed');
    } finally { __resetAuthorityMatchQueueClaimsForTests(); await fs.promises.rm(value.root, { recursive: true, force: true }); }
  },
}];
