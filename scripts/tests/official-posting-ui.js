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
];
