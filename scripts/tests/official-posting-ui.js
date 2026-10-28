import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import { officialPostingDisplay } from '../../src/utils/officialPostingDisplay.js';
import { beginOfficialPostingPreparation } from '../../src/utils/officialPostingPreparation.js';
import { OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from '../../src/utils/jobListingUrl.js';
import { createModuleRunQueue } from '../../src/utils/moduleRunQueue.js';
import {
  hasLinkedLocalApplicationOutput, queuedLocalApplicationSettlement, queuedLocalApplicationStartDecision,
  replacedLocalApplicationForCleanup,
} from '../../src/utils/localAiApplicationLifecycle.js';
import { resolveApplicationCareerSnapshotId } from '../../src/utils/jobBoardCareerOverride.js';
import { getConnectedJobSearchIds } from '../../src/utils/jobBoardSearchSelection.js';
import { APPLICATION_HANDOFF_LIMIT, countActiveApplicationHandoffs } from '../../src/utils/applicationHandoffDock.js';
import { dedupJobsAcrossSources, uniqueJobsAcrossSources } from '../../src/utils/jobIdentity.js';
import { mergeResolvedSourceItems } from '../../src/utils/jobSourceResolveMerge.js';
import { cardOfficialPostingHubMarkerCleanup, isCardOfficialPostingRunId } from '../../src/utils/jobHubManualAiOwnership.js';

const copy = value => JSON.parse(JSON.stringify(value));
const posting = extra => ({ level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Official Platform Engineer',
  location: { display: 'Lakeview, Canada', workMode: 'onsite', remote: false },
  salary: { text: 'Synthetic posted salary', provenance: 'posted' },
  sourceUrl: 'https://careers.example.test/platform', officialApplyUrl: 'https://apply.example.test/platform', trail: [], ...extra });
const row = extra => ({ hubId: 'board', careerSnapshotId: 'approved-snapshot',
  title: 'Scraped Platform Engineer', company: 'Acme Talent Partners', location: 'Scraped location', salary: 'Scraped salary',
  snippet: 'Synthetic scraped description.', url: 'https://listing.example.test/platform',
  googleCardUrl: 'https://www.google.com/search?htidocid=synthetic-platform', sourceJobKey: 'synthetic-job',
  source: 'google', posted: 'Today', language: 'en', postedBy: 'Acme Talent Partners',
  officialPosting: posting(), applyOptions: [{ label: 'Careers', href: 'https://careers.example.test/platform' }],
  salaryProvenance: 'unknown', postingVariants: [{ location: 'Lakeview, Canada', url: 'https://listing.example.test/variant',
    googleCardUrl: '', source: 'google', posted: 'Today', salary: 'Scraped salary', applySource: 'Careers' }], ...extra });

function generateBody() {
  const source = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const generateApplication = useCallback(');
  const end = source.indexOf('\n\n  return (', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function harness({ prepare, data = row(), queueResult = { success: false }, absent = false } = {}) {
  let card = { id: 'card', type: 'jobcard', data };
  const board = { id: 'board', type: 'jobboard', data: {} };
  const search = { id: 'search', type: 'jobhub', data: { careerSnapshotId: 'a'.repeat(64) } };
  const queue = createModuleRunQueue();
  const states = []; const calls = []; const completed = []; const cancelled = []; const updates = []; const toasts = [];
  let leases = 0; let sequence = 0; let laneLabel = '';
  const electronAPI = {
    ...(absent ? {} : { prepareOfficialPostingForGeneration: async args => {
      calls.push({ kind: 'prepare', args: copy(args) });
      return typeof prepare === 'function' ? prepare(args) : prepare;
    } }),
    queueLocalApplication: async args => { calls.push({ kind: 'queue', args: copy(args) }); return queueResult; },
    checkApplicationGenerationGate: async () => ({ success: true, blocked: false }),
    completeNonApiAiRun: async id => { completed.push(id); },
    cancelNodeTaskAndWait: async id => { cancelled.push(id); },
  };
  const context = {
    useCallback: fn => fn, window: { electronAPI }, generateId: () => `fresh-${++sequence}`,
    applicationSubmissionRef: { current: false }, hasApplicationRun: false, localJobPending: false, effectiveLock: false,
    id: 'card', idRef: { current: 'card' }, data, additionalNotes: '',
    nav: { getCurrentFile: () => '/project/canvas.json', enumerateAllNodes: () => [card, board, search].filter(Boolean),
      enumerateAllEdges: () => [{ id: 'connection', source: 'board', target: 'search' }] },
    resolveApplicationCareerSnapshotId, getConnectedJobSearchIds,
    getNodes: () => [], getEdges: () => [], getLiveNode: id => id === 'card' ? card : id === 'board' ? board : null,
    setApplicationRun: state => states.push(state), updateGlobal: (_id, change) => {
      const patch = typeof change === 'function' ? change(card) : change;
      if (patch && card) { updates.push(copy(patch)); card.data = { ...card.data, ...patch }; }
    },
    addToast: toast => toasts.push(toast), setLocalApplication() {}, isMountedRef: { current: true },
    EventLogger: { log() {}, error() {} }, APPLICATION_HANDOFF_LIMIT, countActiveApplicationHandoffs,
    getDismissedApplicationBundles: () => new Set(), hasLinkedLocalApplicationOutput, queuedLocalApplicationStartDecision,
    queuedLocalApplicationSettlement, replacedLocalApplicationForCleanup,
    requestApplicationHandoffFocus() {}, requestApplicationHandoffRefresh() {},
    normalizeJobListingExternalUrl, beginOfficialPostingPreparation, setTimeout: fn => { fn(); return 0; },
    acquireModuleRun: options => { leases++; laneLabel = options.label; return queue.acquireModuleRun(options); },
  };
  return { callback: runInNewContext(`${generateBody()}\ngenerateApplication;`, context), context, states, calls, completed, cancelled, updates, toasts,
    queue, get leases() { return leases; }, get label() { return laneLabel; }, get card() { return card; }, board,
    deleteCard: () => { card = null; } };
}

export default [
  {
    name: 'official-posting card tokens never retire through saved Search child-cancellation ledgers',
    async run() {
      const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const callback = (name, scope) => {
        const start = source.indexOf(`  const ${name} = useCallback(`);
        const bodyStart = source.indexOf('useCallback(', start) + 'useCallback('.length;
        const end = source.indexOf('\n  }, [', bodyStart);
        assert.ok(start > 0 && bodyStart > start && end > bodyStart);
        return new Function(...Object.keys(scope), `return (${source.slice(bodyStart, end)}\n});`)(...Object.values(scope));
      };
      const cardRunId = 'official-posting:card:research';
      assert.equal(await callback('retireManualAiRunDurably', { isCardOfficialPostingRunId })(cardRunId), true);
      assert.equal(await callback('settleManualAiRetirement', { isCardOfficialPostingRunId })({
        runId: cardRunId, requireCancellationAck: true,
      }), true, 'copied card state cannot cancel the parent hub or complete the card run');

      const node = { id: 'search', data: { manualAiResume: { runId: 'legacy-search' } } };
      const retired = [];
      const parentReceipts = [];
      const normalize = value => value || [];
      const remove = (receipts, id) => normalize(receipts).filter(receipt => receipt.runId !== id);
      const settle = callback('settleManualAiRetirement', {
        isCardOfficialPostingRunId, id: 'search',
        getNode: () => node, updateGlobal: (_id, update) => { node.data = { ...node.data, ...update(node) }; },
        waitForRendererCommitFrame: async () => {}, retireManualAiRunDurably: async id => { retired.push(id); },
        attemptedManualAiCleanupRunIdsRef: { current: new Set() }, activeManualAiRunIdRef: { current: 'legacy-search' },
        cancelledBoardManualAiRunIdsRef: { current: new Set() }, manualAiCleanupErrorMessagesRef: { current: new Set() },
        normalizeManualAiCleanupReceipts: normalize, removeManualAiCleanupReceipt: remove,
        upsertManualAiCleanupReceipt: (receipts, receipt) => [...remove(receipts, receipt.runId), receipt],
        rememberBoundedRunId: (ids, id) => ids.add(id),
      });
      await settle({ runId: 'legacy-search', acknowledgedRunIds: ['legacy-search', cardRunId],
        beforeRetirement: async ids => { parentReceipts.push(...ids); } });
      assert.deepEqual(retired, ['legacy-search']);
      assert.deepEqual(parentReceipts, ['legacy-search'], 'foreign discoveries cannot become Board child cleanup receipts');
      assert.equal(node.data.manualAiResume, null);
      assert.equal(node.data.manualAiCleanupReceipts, null);

      const persistenceStart = source.indexOf('    const persistChildCancellationCleanup = async (cleanupPatch = {}) => {');
      const persistenceEnd = source.indexOf('\n    };', persistenceStart) + '\n    };'.length;
      assert.ok(persistenceStart > 0 && persistenceEnd > persistenceStart);
      for (const [priorRunId, requestedIds, expectedRunId] of [
        [cardRunId, [], null], [cardRunId, ['legacy-child'], 'legacy-child'], ['legacy-child', [], 'legacy-child'],
      ]) {
        const board = { id: 'board', data: { boardScanResume: { boardRunId: 'parent-scan', phase: 'searches',
          cancellationCleanup: { sourceId: 'search', manualAiRunId: priorRunId, manualAiRunIds: [cardRunId] } } } };
        const persist = runInNewContext(`${source.slice(persistenceStart, persistenceEnd)}\npersistChildCancellationCleanup;`, {
          id: 'search', orchestratorNodeId: 'board', boardRunId: 'parent-scan', isCardOfficialPostingRunId,
          getNode: () => board, waitForRendererCommitFrame: async () => {},
          updateGlobal: (_id, update) => { board.data = { ...board.data, ...update(board) }; },
        });
        assert.equal(await persist({ sourceId: 'search', manualAiRunId: cardRunId, manualAiRunIds: requestedIds }), true);
        for (const receipt of [board.data.boardScanResume.cancellationCleanup,
          board.data.boardScanResume.cancellationCleanupsBySource.search]) {
          assert.equal(receipt.manualAiRunId, expectedRunId, 'singular cleanup ownership must exclude copied card tokens');
          assert.deepEqual(Array.from(receipt.manualAiRunIds), expectedRunId ? [expectedRunId] : []);
        }
      }
    },
  },
  {
    name: 'official-posting card research cannot become Search recovery or cancel its parent run',
    run() {
      const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const pendingStart = source.indexOf('const onPending = (event) => {');
      const pendingEnd = source.indexOf("    document.addEventListener('non-api-ai-node-pending', onPending);", pendingStart);
      const cancelStart = source.indexOf('const onManualAiNodeCancelled = (event) => {');
      const cancelEnd = source.indexOf("    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);", cancelStart);
      assert.ok(pendingStart > 0 && pendingEnd > pendingStart && cancelStart > 0 && cancelEnd > cancelStart);
      for (const runId of ['legacy-search-7', 'job-search:search:parent']) {
        const node = { id: 'search', data: { jobRunId: 'gather-1', resumeProfile: { roles: ['Engineer'] } } };
        const effects = [];
        const active = { current: null };
        const context = {
          id: node.id, isCardOfficialPostingRunId,
          activeManualAiRunIdRef: active, cancelledBoardManualAiRunIdsRef: { current: new Set() },
          boardRunControlRef: { current: null }, jobRunIdRef: { current: 'gather-1' },
          getNode: () => node, getNodes: () => [node], getEdges: () => [],
          updateGlobal: (_id, change) => {
            effects.push('update');
            const patch = typeof change === 'function' ? change(node) : change;
            node.data = { ...node.data, ...patch };
          },
          settleManualAiRetirement: () => { throw new Error('card request retired by Search'); },
          stopHandler: () => { effects.push('stop'); },
          rememberBoundedRunId: (ids, id) => ids.add(id), findJobSearchBoardRecoveryOwner: () => null,
          isCareerCompilationTask: () => false, createManualAiPreSearchRecovery: () => { throw new Error('invented a fresh search'); },
          REANALYZE_SAVED_JOBS_MANUAL_AI_RECOVERY_MODE: 'reanalyze-saved-jobs', EventLogger: { log() {}, error() {} },
        };
        const pending = runInNewContext(`${source.slice(pendingStart, pendingEnd)}\nonPending;`, context);
        const cancel = runInNewContext(`${source.slice(cancelStart, cancelEnd)}\nonManualAiNodeCancelled;`, context);
        const cardEvent = { detail: { nodeId: 'search', runId: 'official-posting:card:research', task: 'official-posting' } };
        pending(cardEvent);
        cancel(cardEvent);
        assert.deepEqual(effects, []);
        assert.equal(active.current, null);
        assert.equal(node.data.manualAiResume, undefined);
        // Search-owned official-posting checks share their Search run id. The
        // task name alone must never suppress those legitimate checkpoints.
        const searchEvent = { detail: { nodeId: 'search', runId, task: 'official-posting' } };
        pending(searchEvent);
        assert.equal(node.data.manualAiResume.runId, runId);
        assert.equal(node.data.manualAiResume.jobRunId, 'gather-1');
        assert.equal(active.current, runId);
        cancel(searchEvent);
        assert.deepEqual(effects, ['update', 'stop']);
      }
    },
  },
  {
    name: 'official-posting copied hub markers self-heal without changing card ownership or saved Search results',
    run() {
      const research = { runId: 'official-posting:card:research', retirementPending: true, cancellationPending: true };
      const receipt = { runId: 'legacy-search-7', cancellationPending: true };
      const saved = { hubState: 'done', scoredJobs: [{ id: 'saved-result' }], resumeProfile: { roles: ['Engineer'] },
        manualAiResume: research, manualAiCleanupReceipts: [research, receipt] };
      const patch = cardOfficialPostingHubMarkerCleanup(saved);
      assert.deepEqual(patch, { manualAiResume: null, manualAiCleanupReceipts: [receipt] });
      const restored = { ...saved, ...patch };
      assert.equal(restored.scoredJobs, saved.scoredJobs);
      assert.equal(restored.resumeProfile, saved.resumeProfile);
      assert.equal(restored.hubState, 'done');
      assert.equal(saved.manualAiResume, research, 'cleanup does not mutate its input');
      assert.equal(cardOfficialPostingHubMarkerCleanup(restored), null, 'cleanup is idempotent');
      assert.equal(cardOfficialPostingHubMarkerCleanup({ manualAiResume: { runId: 'search-parent', task: 'official-posting' } }), null);
      assert.equal(isCardOfficialPostingRunId('official-posting:card:research'), true);
      assert.equal(isCardOfficialPostingRunId('search-parent'), false);

      const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const cleanupStart = source.indexOf('    const liveData = getNode(id)?.data || data;', source.indexOf('// Older renderers adopted card research'));
      const cleanupEnd = source.indexOf('\n  }, [', cleanupStart);
      assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
      const cleanup = new Function('getNode', 'id', 'data', 'cardOfficialPostingHubMarkerCleanup',
        'isCardOfficialPostingRunId', 'activeManualAiRunIdRef', 'updateGlobal', source.slice(cleanupStart, cleanupEnd));
      for (const currentRun of [research.runId, 'search-parent']) {
        const node = { id: 'search', data: { ...saved } };
        const active = { current: currentRun };
        const calls = [];
        cleanup(() => node, node.id, node.data, cardOfficialPostingHubMarkerCleanup,
          isCardOfficialPostingRunId, active, (_id, update) => {
            calls.push('update');
            node.data = { ...node.data, ...update(node) };
          });
        assert.deepEqual(calls, ['update']);
        assert.equal(active.current, currentRun === research.runId ? null : currentRun);
        assert.equal(node.data.manualAiResume, null);
        assert.equal(node.data.scoredJobs, saved.scoredJobs);
        assert.deepEqual(node.data.manualAiCleanupReceipts, [receipt]);
      }

      const receiptsStart = source.indexOf('    if (isJobWorkflowDeletionPending(id)) return;', source.indexOf("document.removeEventListener('non-api-ai-node-pending'"));
      const receiptsEnd = source.indexOf('\n  }, [', receiptsStart);
      assert.ok(receiptsStart > 0 && receiptsEnd > receiptsStart);
      const receiptsEffect = new Function('data', 'id', 'isJobWorkflowDeletionPending',
        'normalizeManualAiCleanupReceipts', 'isCardOfficialPostingRunId', 'attemptedManualAiCleanupRunIdsRef',
        'processingRunsRef', 'boardRunControlRef', 'BOARD_BUSY_SEARCH_STATES', 'settleManualAiRetirement',
        source.slice(receiptsStart, receiptsEnd));
      receiptsEffect({ hubState: 'done', manualAiCleanupReceipts: [research] }, 'search', () => false,
        value => value || [], isCardOfficialPostingRunId, { current: new Set() },
        { current: { active: false } }, { current: null }, new Set(),
        () => { throw new Error('saved card receipt reached Search retirement'); });

      const recoveryStart = source.indexOf('    const resume = data.manualAiResume;', source.indexOf('  const autoResumedManualAiRunRef ='));
      const recoveryGuardEnd = source.indexOf('    if (isJobWorkflowDeletionPending(id))', recoveryStart);
      assert.ok(recoveryStart > 0 && recoveryGuardEnd > recoveryStart);
      const guard = new Function('data', 'isCardOfficialPostingRunId',
        `${source.slice(recoveryStart, recoveryGuardEnd)}\nthrow new Error('card research reached Search auto-resume');`);
      guard(saved, isCardOfficialPostingRunId);
      assert.throws(() => guard({ manualAiResume: { runId: 'search-parent', task: 'official-posting' } }, isCardOfficialPostingRunId),
        /reached Search auto-resume/u, 'legitimate Search checkpoints remain eligible');
    },
  },
  {
    name: 'official-posting card displays verified facts and via labels without rewriting scraped identity',
    run() {
      for (const level of ['L1', 'L2', 'L3', 'L4']) {
        const job = row({ officialPosting: posting({ level }) }); const before = copy(job);
        const display = officialPostingDisplay(job);
        assert.equal(display.employerLabel, 'Northwind Labs'); assert.equal(display.via, 'via Acme Talent Partners');
        assert.equal(display.title, 'Official Platform Engineer'); assert.equal(display.location, 'Lakeview, Canada');
        assert.equal(display.salary, 'Synthetic posted salary'); assert.equal(display.levelLabel, OFFICIAL_POSTING_LABELS[level]);
        assert.equal(display.applyUrl, 'https://apply.example.test/platform'); assert.deepEqual(job, before);
      }
      assert.equal(officialPostingDisplay(row({ postedBy: ' NORTHWIND   LABS ' })).via, '');
      const l5 = officialPostingDisplay(row({ officialPosting: posting({ level: 'L5' }) }));
      assert.equal(l5.employer, 'Northwind Labs'); assert.equal(l5.via, '');
    },
  },
  {
    name: 'official-posting card labels unresolved posters, closed and ambiguous outcomes, safe links and legacy fallbacks',
    run() {
      const unknown = officialPostingDisplay(row({ officialPosting: posting({ level: 'L6', employer: '' }) }));
      assert.equal(unknown.employer, ''); assert.equal(unknown.postedBy, 'Acme Talent Partners');
      assert.equal(unknown.employerLabel, 'Acme Talent Partners'); assert.match(unknown.statusLabel, /poster, employer unknown/u);
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'closed' }) })).statusLabel, 'Official posting closed');
      const alternatives = [{ title: 'Platform Engineer A', url: 'https://careers.example.test/platform-a' },
        { title: 'Platform Engineer B', url: 'https://careers.example.test/platform-b' }];
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'ambiguous', alternatives }) })).statusLabel, 'Ambiguous: 2 candidates');
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'ambiguous' }) })).statusLabel, 'Ambiguous: 0 candidates');
      const maximumAlternatives = Array.from({ length: 12 }, (_, index) => ({ title: `Platform Engineer ${index}`, url: `https://careers.example.test/platform-${index}` }));
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'ambiguous', alternatives: maximumAlternatives }) })).statusLabel, 'Ambiguous: 12 candidates');
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'ambiguous', alternatives: [...maximumAlternatives, alternatives[0]] }) })).statusLabel, '');
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ outcome: 'ambiguous', alternatives: [{ title: 'Invalid URL', url: 'javascript:alert(1)' }] }) })).statusLabel, '');
      const legacy = officialPostingDisplay(row({ officialPosting: undefined, company: '  ', postedBy: '  Synthetic Poster  ' }));
      assert.equal(legacy.label, 'Synthetic Poster'); assert.equal(legacy.title, 'Scraped Platform Engineer'); assert.equal(legacy.levelLabel, '');
      assert.equal(officialPostingDisplay(row({ officialPosting: posting({ officialApplyUrl: 'javascript:alert(1)' }) })).applyUrl, 'https://listing.example.test/platform');
      assert.equal(officialPostingDisplay(row({ url: '', googleCardUrl: '', officialPosting: posting() })).applyUrl, 'https://apply.example.test/platform');
      const google = officialPostingDisplay(row({ officialPosting: undefined, url: '', googleCardUrl: 'https://www.google.com/search?htidocid=synthetic-card' }));
      assert.match(google.applyUrl, /https:\/\/www\.google\.com\/search\?/u);
    },
  },
  {
    name: 'official-posting Generate prepares before the lane with an identical queue projection and retires its fresh run',
    async run() {
      const test = harness({ prepare: { success: true, resolutionId: 'opaque-resolution', officialPosting: posting(), postedBy: 'Acme Talent Partners' } });
      await test.callback();
      const prepared = test.calls.find(call => call.kind === 'prepare'); const queued = test.calls.find(call => call.kind === 'queue');
      assert.equal(prepared.args.nodeId, 'board'); assert.equal(prepared.args.cardId, 'card');
      assert.equal(prepared.args.manualAiRunId, 'official-posting:card:fresh-1');
      assert.equal(JSON.stringify(prepared.args.job), JSON.stringify(queued.args.job), 'both IPCs must receive byte-equivalent matching projections');
      assert.equal(queued.args.resolutionId, 'opaque-resolution'); assert.equal(test.leases, 1);
      assert.deepEqual(test.completed, ['official-posting:card:fresh-1', 'application-gate:card:fresh-2']);
      assert.equal(test.states.at(-1).state, 'idle'); assert.equal(test.queue.getSnapshot().active, null);
      assert.ok(test.updates.every(update => !['company', 'snippet', 'applyUrl'].some(key => Object.hasOwn(update, key))));
      const prior = prepared.args.manualAiRunId;
      await test.callback();
      assert.notEqual(test.calls.filter(call => call.kind === 'prepare').at(-1).args.manualAiRunId, prior, 'every deliberate click receives a fresh research run identity');
    },
  },
  {
    name: 'official-posting Generate tolerates absent IPC, missing resolution ids and unexpected preparation failures',
    async run() {
      for (const options of [{ absent: true }, { prepare: { success: true } }, { prepare: { success: false, error: 'Synthetic unavailable' } },
        { prepare: async () => { throw new Error('Synthetic transport failure'); } }]) {
        const test = harness(options); await test.callback();
        assert.equal(test.calls.filter(call => call.kind === 'queue').length, 1);
        assert.equal(test.calls.find(call => call.kind === 'queue').args.resolutionId, null);
        assert.equal(test.leases, 1); assert.equal(test.queue.getSnapshot().active, null);
        assert.equal(test.completed.filter(id => id.startsWith('official-posting:')).length, options.absent ? 0 : 1);
      }
    },
  },
  {
    name: 'listing liveness card: typed refusal and hold stop before the application lane and retain the returned pair',
    async run() {
      const at = '2026-10-26T12:00:00.000Z';
      for (const action of ['refuse-final', 'refuse-retry', 'hold']) {
        const listingLiveness = { verdict: action === 'hold' ? 'pending' : 'closed',
          basis: action === 'hold' ? 'neither' : 'structural', board: 'linkedin', at };
        const boardClosed = action === 'hold' ? null : { board: 'linkedin', reason: 'http-not-found', at };
        const test = harness({ data: row({ url: 'https://www.linkedin.com/jobs/view/synthetic-card' }),
          prepare: { success: true, listingCheck: { action }, listingLiveness, boardClosed, message: 'Synthetic listing decision.' } });
        await test.callback();
        assert.equal(test.calls.filter(call => call.kind === 'queue').length, 0, action);
        assert.equal(test.leases, 0, action);
        assert.equal(test.updates.length, 1, action);
        assert.deepEqual(test.updates[0], { listingGenerationNotice: copy(test.card.data.listingGenerationNotice), listingLiveness, ...(boardClosed ? { boardClosed } : {}), listingHold: action === 'hold' });
        assert.equal(test.card.data.listingGenerationNotice.action, action);
        assert.equal(test.card.data.listingGenerationNotice.message, 'Synthetic listing decision.');
        assert.ok(Number.isFinite(Date.parse(test.card.data.listingGenerationNotice.at)));
        assert.equal(test.toasts[0]?.title, 'Listing check');
        assert.equal(test.toasts[0]?.description, 'Synthetic listing decision.');
        assert.equal(test.states.at(-1)?.state, 'idle');
        assert.equal(test.context.applicationSubmissionRef.current, false);
      }
    },
  },
  {
    name: 'listing liveness card: a failed or missing probe result holds board URLs and override can continue',
    async run() {
      for (const [url, shouldHold] of [
        ['https://www.linkedin.com/jobs/view/synthetic-card', true],
        ['https://careers.ziprecruiter.com/jobs/synthetic-card', true],
        ['https://www.dice.com/job-detail/synthetic-card', true],
        ['https://ca.indeed.co.uk/viewjob?jk=synthetic', true],
        ['https://linkedin.com.evil.test/jobs/view/synthetic-card', false],
        ['https://listing.example.test/jobs/synthetic-card', false],
      ]) {
        const test = harness({ data: row({ url }), prepare: { success: false, error: 'Synthetic unavailable.' } });
        await test.callback();
        assert.equal(test.leases, shouldHold ? 0 : 1, url);
        assert.equal(test.calls.some(call => call.kind === 'queue'), !shouldHold, url);
        assert.equal(test.card.data.listingHold, shouldHold ? true : undefined, url);
        if (shouldHold) {
          assert.equal(test.toasts[0]?.title, 'Listing check', url);
          assert.equal(test.toasts[0]?.description, "Couldn't confirm the listing is still open", url);
        }
      }
      const override = harness({ data: row({ url: 'https://www.linkedin.com/jobs/view/synthetic-override' }),
        prepare: async () => { throw new Error('Synthetic transport error'); } });
      await override.callback({ listingOverride: true });
      assert.equal(override.calls.find(call => call.kind === 'prepare')?.args.listingOverride, true);
      assert.equal(override.calls.some(call => call.kind === 'queue'), true);
      assert.equal(override.leases, 1);
      assert.equal(override.toasts.some(toast => toast.title === 'Listing check'), false);
    },
  },
  {
    name: 'listing liveness card: proceed updates only a changed pair and both payloads retain closed variants',
    async run() {
      const at = '2026-10-26T12:00:00.000Z';
      const open = { verdict: 'open', basis: 'ai', board: 'linkedin', at };
      const variants = [
        { location: 'Lakeview', url: 'https://listing.example.test/closed', liveness: 'closed' },
        { location: 'Bayview', url: 'https://listing.example.test/open' },
      ];
      const changed = harness({ data: row({ postingVariants: variants }),
        prepare: { success: true, listingCheck: { action: 'proceed' }, listingLiveness: open, boardClosed: null } });
      await changed.callback();
      assert.equal(changed.leases, 1);
      assert.deepEqual(changed.updates[0], { listingLiveness: open, listingHold: false, listingGenerationNotice: null });
      const prepareJob = changed.calls.find(call => call.kind === 'prepare')?.args.job;
      const queueJob = changed.calls.find(call => call.kind === 'queue')?.args.job;
      assert.equal(JSON.stringify(prepareJob), JSON.stringify(queueJob));
      assert.equal(prepareJob.postingVariants[0].liveness, 'closed');
      assert.equal(Object.hasOwn(prepareJob.postingVariants[1], 'liveness'), false);
      const same = harness({ data: row({ listingLiveness: open }),
        prepare: { success: true, listingCheck: { action: 'proceed' }, listingLiveness: open, boardClosed: null } });
      await same.callback();
      assert.equal(same.leases, 1);
      assert.deepEqual(same.updates, []);
      assert.deepEqual(same.calls.find(call => call.kind === 'prepare')?.args.job.listingLiveness, open,
        'the card sends its listing state to Prepare');
      assert.deepEqual(same.calls.find(call => call.kind === 'queue')?.args.job.listingLiveness, open,
        'the queue receives the same listing state projection');
      const cleared = harness({ data: row({ listingLiveness: open, listingHold: true,
        listingGenerationNotice: { action: 'hold', message: 'Previous uncertainty' } }),
        prepare: { success: true, listingCheck: { action: 'proceed' }, listingLiveness: open, boardClosed: null } });
      await cleared.callback({ listingOverride: true });
      assert.equal(cleared.card.data.listingHold, false, 'proceed clears a hold even with identical liveness');
      assert.equal(cleared.card.data.listingGenerationNotice, null);
      const source = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert.ok(source.includes('data.listingGenerationNotice?.message || data.listingHold === true'));
      assert.ok(source.includes('Generation paused · Listing check'));
      assert.equal(source.split("liveness: variant.liveness === 'closed' ? 'closed' : undefined,").length - 1, 2);
      assert.ok(source.includes('const listingOverrideAvailable = listingGenerationPaused;')
        && source.includes('generateApplication({ listingOverride: listingOverrideAvailable })')
        && source.includes("listingOverrideAvailable ? 'Generate anyways' : localApplicationNeedsAttention"));
      assert.ok(source.includes('Check again'));
    },
  },
  {
    name: 'listing liveness card: every listing pause offers an explicit override and recheck',
    async run() {
      const source = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      const start = source.indexOf('  const listingGenerationPaused =');
      const end = source.indexOf('  const localApplicationNeedsAttention =', start);
      for (const action of ['hold', 'refuse-retry', 'refuse-final']) {
        const data = row({ listingHold: action === 'hold',
          listingGenerationNotice: { action, message: 'Synthetic listing pause' } });
        const available = runInNewContext(`${source.slice(start, end)}\nlistingOverrideAvailable;`, {
          data, hasLinkedApplicationOutput: false, hasApplicationRun: false, localJobPending: false,
        });
        assert.equal(available, true, action);
        const test = harness({ data, prepare: input => ({ success: true,
          listingCheck: { action: input.listingOverride ? 'proceed' : action } }) });
        await test.callback({ listingOverride: available });
        assert.equal(test.calls.find(call => call.kind === 'prepare').args.listingOverride, true);
        assert.equal(test.calls.some(call => call.kind === 'queue'), true);
        assert.equal(test.card.data.listingGenerationNotice, null);
      }
      const notice = source.slice(source.indexOf('      {listingGenerationPaused && ('),
        source.indexOf('      {/* Generate the application bundle.'));
      assert.ok(notice.includes('Check again'));
      assert.ok(notice.includes('generateApplication();'));
      assert.equal(notice.includes('data.listingHold === true &&'), false);
    },
  },
  {
    name: 'official-posting Generate cancellation prevents every queue call even when preparation returns a late success',
    async run() {
      let release;
      const test = harness({ prepare: () => new Promise(resolve => { release = resolve; }) });
      const pending = test.callback();
      assert.equal(test.leases, 0, 'research must hold no application lane');
      const resolving = test.states.find(state => state.state === 'resolving'); assert.ok(resolving);
      resolving.cancel();
      release({ success: true, resolutionId: 'late-resolution', officialPosting: posting() });
      await pending;
      assert.equal(test.leases, 0); assert.equal(test.calls.some(call => call.kind === 'queue'), false);
      assert.deepEqual(test.cancelled, ['card']); assert.deepEqual(test.completed, ['official-posting:card:fresh-1']);
      assert.equal(test.updates.length, 0); assert.equal(test.toasts.length, 0);
      assert.equal(test.context.applicationSubmissionRef.current, false);
    },
  },
  {
    name: 'official-posting Generate retires cancelled, deleted, newly locked or saved cards before lane admission',
    async run() {
      for (const change of ['cancelled', 'quit', 'deleted', 'card-locked', 'board-locked', 'saved', 'pending']) {
        let release;
        const test = harness({ prepare: () => new Promise(resolve => { release = resolve; }) });
        const pending = test.callback();
        if (change === 'deleted') test.deleteCard();
        if (change === 'card-locked') test.card.data.locked = true;
        if (change === 'board-locked') test.board.data.locked = true;
        if (change === 'saved') test.card.data.localApplication = { id: 'saved', status: 'saved' };
        if (change === 'pending') test.card.data.localApplication = { id: 'pending', status: 'queued' };
        release(change === 'cancelled' ? { success: false, cancelled: true } : change === 'quit' ? { success: false, pausedForQuit: true }
          : { success: true, resolutionId: 'resolution', officialPosting: posting() });
        await pending;
        assert.equal(test.leases, 0, change); assert.equal(test.calls.some(call => call.kind === 'queue'), false, change);
        assert.equal(test.completed.filter(id => id.startsWith('official-posting:')).length, 1, change);
      }
    },
  },
  {
    name: 'official-posting lane labels match the shared display and queue metadata reflects a host downgrade',
    async run() {
      for (const level of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
        const metadata = posting({ level, employer: level === 'L6' ? '' : 'Northwind Labs' });
        const data = row({ officialPosting: metadata });
        const test = harness({ data, prepare: { success: true, resolutionId: 'resolution', officialPosting: metadata, postedBy: data.postedBy } });
        await test.callback(); assert.equal(test.label, `Application: ${officialPostingDisplay(data).label}`);
      }
      const downgraded = posting({ level: 'L4', outcome: 'link-only', trail: ['oversize'] });
      const test = harness({ prepare: { success: true, resolutionId: 'resolution', officialPosting: posting(), postedBy: 'Acme Talent Partners' },
        queueResult: { success: true, localJob: { id: 'synthetic-queued', status: 'queued' }, officialPosting: downgraded, postedBy: 'Acme Talent Partners' } });
      await test.callback();
      assert.equal(test.card.data.officialPosting.level, 'L4'); assert.equal(test.card.data.company, 'Acme Talent Partners');
      assert.equal(test.card.data.snippet, 'Synthetic scraped description.'); assert.equal(Object.hasOwn(test.card.data, 'applyUrl'), false);
      assert.equal(test.card.data.localApplication.id, 'synthetic-queued');
    },
  },
  {
    name: 'official-posting card source preserves renderer URL policy, accessible level labels and isolated resolving Cancel',
    run() {
      const source = fs.readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert.ok(source.includes("from '../utils/officialPostingDisplay'"));
      assert.ok(source.includes('normalizeJobListingExternalUrl({ ...data, url: postingDisplay.applyUrl || data.url })'));
      assert.ok(source.includes('(postingDisplay.applyUrl || data.url || data.googleCardUrl)'));
      assert.ok(source.includes('title={postingDisplay.levelLabel ?') && source.includes('aria-label={postingDisplay.levelLabel ?'));
      assert.ok(source.includes('Finding official posting…') && source.includes("{displayedApplicationRun.state === 'resolving' && ("));
      assert.ok(source.includes('displayedApplicationRun.cancel?.()'));
      const body = generateBody(); const prepareAt = body.indexOf('await window.electronAPI.prepareOfficialPostingForGeneration?.(');
      assert.ok(prepareAt > body.indexOf('applicationSubmissionRef.current = true;') && prepareAt < body.indexOf('lease = await acquireModuleRun('));
      assert.ok(body.includes('        careerSnapshotId,\n'));
    },
  },
  {
    name: 'Amendment 4 both late renderer merges preserve open copies verified closed copies and ghost survivors',
    run() {
      const source = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const lateAt = source.indexOf("if (currentState === 'sources-ready')");
      const lateStart = source.indexOf('const prevPending =', lateAt);
      const lateEnd = source.indexOf('// This source completed', lateStart);
      assert.ok(lateAt > 0 && lateStart > lateAt && lateEnd > lateStart);
      const lateBody = source.slice(lateStart, lateEnd);
      const resolvedAt = source.indexOf('const resolvedItems = prevPending.filter(j => sourceWarningOverrides.has(j?.source));');
      const resolvedExpression = source.slice(resolvedAt).match(/foundJobs = ([^\n]+);/u)?.[1];
      assert.ok(resolvedAt > 0 && resolvedExpression);
      const marker = { board: 'linkedin', reason: 'linkedin-no-longer-accepting', at: '2026-10-24T12:00:00.000Z' };
      const make = (source, id, extra = {}) => ({ title: 'Platform Engineer', company: 'Northwind Labs', location: 'Lakeview, Canada',
        source, url: `https://${source}.example.test/jobs/${id}`, snippet: 'Synthetic role description.', ...extra });
      const runMerge = (site, retained, incoming) => {
        const context = { dedupJobsAcrossSources, uniqueJobsAcrossSources, mergeResolvedSourceItems,
          pendingJobsRef: { current: retained }, freshJobs: incoming, resolvedItems: retained, foundJobs: incoming };
        const result = runInNewContext(site === 'late-usajobs' ? `${lateBody}\nmergedPending;` : resolvedExpression, context);
        return Array.from(result);
      };
      for (const site of ['late-usajobs', 'post-backend']) {
        for (const [priorVerified, incomingVerified, expectedSource] of [[false, false, 'usajobs'], [true, false, 'linkedin'], [true, true, 'usajobs']]) {
          const retained = [make('linkedin', 'closed', { boardClosed: marker, ...(priorVerified ? { officialPosting: posting() } : {}) })];
          const incoming = [make('usajobs', 'open', incomingVerified ? { officialPosting: posting() } : {})];
          const before = JSON.stringify([retained, incoming]);
          assert.deepEqual(runMerge(site, retained, incoming).map(job => job.source), [expectedSource], site);
          assert.equal(JSON.stringify([retained, incoming]), before, 'the merge does not mutate inputs');
        }
        const first = make('linkedin', '2001', { url: 'https://www.linkedin.com/jobs/view/2001', snippet: 'First distinct synthetic responsibilities. '.repeat(30) });
        const closed = make('linkedin', '2002', { url: 'https://www.linkedin.com/jobs/view/2002', boardClosed: marker, snippet: 'Second distinct synthetic responsibilities. '.repeat(30) });
        const ghost = make('usajobs', 'copy', { snippet: closed.snippet });
        assert.deepEqual(runMerge(site, [first, closed], [ghost]), [first, closed], `${site}: a discarded incoming representative cannot remove the closed row`);
      }
    },
  },
];
