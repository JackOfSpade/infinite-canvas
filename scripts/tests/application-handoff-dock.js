import { readFileSync } from 'node:fs';
import { assert } from './testHelpers.js';
import {
  APPLICATION_DOCK_IDLE_STATUSES,
  APPLICATION_HANDOFF_LIMIT,
  applicationDockRequest,
  applicationLimitMessage,
  brokenApplicationDockRequest,
  getDismissedApplicationBundles,
  setDismissedApplicationBundles,
  flushApplicationDraftWrites,
  registerApplicationDraftFlusher,
  trackApplicationDraftWrite,
  applicationRequestId,
  applicationStageLabel,
  countActiveApplicationHandoffs,
  getApplicationHandoffs,
  isApplicationRequestId,
  mergeDockQueue,
  publishApplicationHandoffs,
  retainUnreadableApplicationItems,
  selectApplicationHandoffCandidates,
  subscribeApplicationHandoffs,
  usesPushHandoffCode,
  __resetApplicationHandoffsForTests,
} from '../../src/utils/applicationHandoffDock.js';
import { isWorkflowSuccessor } from '../../src/utils/nonApiAiNavigation.js';

const jobCard = (id, localApplication, extra = {}) => ({
  id,
  type: 'jobcard',
  data: { title: 'Staff Engineer', company: 'Acme', ...extra, localApplication },
});

const pasteJob = (id, status = 'queued') => ({
  id, status, mode: 'paste', canvasFilePath: '/canvas/board.json',
});

const handoffRecord = (overrides = {}) => ({
  jobId: 'job-1',
  stage: 'resume',
  revision: 2,
  handoffCode: 'fZ8kQ1v3nT7pLwXyBc2dGh4j',
  baseHashes: {},
  prompt: 'Write the résumé.',
  draft: '',
  ...overrides,
});

export default [
  {
    name: 'application dock: only paste bundles awaiting a response take a slot',
    run: () => {
      const nodes = [
        jobCard('a', pasteJob('job-a', 'queued')),
        jobCard('b', pasteJob('job-b', 'revision-required')),
        jobCard('c', pasteJob('job-c', 'invalid')),
        // Terminal and app-owned states hold no prompt to paste against.
        jobCard('d', pasteJob('job-d', 'saved')),
        jobCard('e', pasteJob('job-e', 'failed')),
        jobCard('f', pasteJob('job-f', 'importing')),
        jobCard('g', pasteJob('job-g', 'completed')),
        jobCard('h', pasteJob('job-h', 'paste-completed')),
        // A legacy filesystem-transport job is not a paste handoff.
        jobCard('i', { id: 'job-i', status: 'queued', transport: 'filesystem' }),
        // Non-job nodes and cards with no bundle never contribute.
        { id: 'j', type: 'textnode', data: {} },
        jobCard('k', null),
      ];
      const selected = selectApplicationHandoffCandidates(nodes).map(node => node.id);
      assert(
        selected.join(',') === 'a,b,c',
        `expected only pending paste bundles, got ${selected.join(',') || '(none)'}`,
      );
      assert(countActiveApplicationHandoffs(nodes) === 3, 'count must agree with selection');
      assert(countActiveApplicationHandoffs(null) === 0, 'a missing node list is zero, not a throw');
      // The idle list is the single source of truth for "holds no slot"; a new
      // terminal status added there must not need a second edit here.
      assert(
        APPLICATION_DOCK_IDLE_STATUSES.every(status => (
          selectApplicationHandoffCandidates([jobCard('x', pasteJob('job-x', status))]).length === 0
        )),
        'every idle status must be excluded',
      );
    },
  },
  {
    name: 'application dock: the limit matches the scoring handoff concurrency',
    run: () => {
      // The dock caps application prompts exactly where it caps scoring
      // prompts, and the chip strip is laid out for that many. If either
      // number moves, the other must move with it.
      const jobPreferences = readFileSync(new URL('../../electron/ipc/jobPreferences.js', import.meta.url), 'utf8');
      const declared = /export const MANUAL_HANDOFF_CONCURRENCY = (\d+);/.exec(jobPreferences);
      assert(declared, 'MANUAL_HANDOFF_CONCURRENCY must remain a literal export in jobPreferences.js');
      assert(
        Number(declared[1]) === APPLICATION_HANDOFF_LIMIT,
        `APPLICATION_HANDOFF_LIMIT (${APPLICATION_HANDOFF_LIMIT}) must equal MANUAL_HANDOFF_CONCURRENCY (${declared[1]})`,
      );
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(
        dock.includes(`sm:grid-cols-${APPLICATION_HANDOFF_LIMIT}`),
        'the chip strip must lay out one column per concurrent prompt',
      );
      assert(
        applicationLimitMessage().includes(String(APPLICATION_HANDOFF_LIMIT)),
        'the refusal must name the limit it enforces',
      );
    },
  },
  {
    name: 'application dock: request ids are stable and cannot collide with push handoffs',
    run: () => {
      const id = applicationRequestId('job-1');
      assert(id === 'application:job-1', `unexpected request id ${id}`);
      assert(applicationRequestId('job-1') === id, 'the id must be stable across refreshes');
      assert(isApplicationRequestId(id), 'an application id must be recognised');
      // Push transport ids are opaque, but none of them start with this prefix,
      // so a merged queue can key drafts and chips off requestId alone.
      assert(!isApplicationRequestId('a1b2c3d4'), 'a push request id must not read as an application');
      assert(!isApplicationRequestId(null) && !isApplicationRequestId(undefined), 'absent ids are not applications');
    },
  },
  {
    name: 'application dock: a stage advance is a workflow successor, so focus follows it',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      const resume = applicationDockRequest({ node, handoff: handoffRecord({ stage: 'resume' }) });
      const coverLetter = applicationDockRequest({ node, handoff: handoffRecord({ stage: 'cover-letter', handoffCode: 'nextCode0000000000000000' }) });
      assert(resume && coverLetter, 'both stages must produce items');
      assert(resume.runId === 'job-1' && coverLetter.runId === 'job-1', 'a bundle keeps one run identity');
      assert(resume.task === 'resume' && coverLetter.task === 'cover-letter', 'the stage is the task');
      // Same nodeId+runId with a changed task is exactly the rule the dock
      // already uses to advance focus to the prompt the person just unlocked.
      assert(
        isWorkflowSuccessor(
          { requestId: resume.requestId, nodeId: resume.nodeId, runId: resume.runId, task: resume.task, batch: 1 },
          { ...coverLetter, requestId: 'application:job-1-next' },
        ),
        'the next stage must qualify as the workflow successor',
      );
      assert(resume.batch === undefined, 'application items must carry no batch number');
    },
  },
  {
    name: 'application dock: corrections drive the correction affordances',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      const clean = applicationDockRequest({ node, handoff: handoffRecord() });
      assert(clean.isCorrection === false && clean.corrections.length === 0, 'a fresh stage is not a correction');
      const rejected = applicationDockRequest({
        node,
        handoff: handoffRecord({
          corrections: ['Bullet 3 cites no source quote.', ''],
          correctionPrompt: 'Fix only these.',
        }),
      });
      assert(rejected.isCorrection === true, 'a handoff carrying corrections is a correction round');
      assert(rejected.corrections.length === 1, 'blank corrections must be dropped');
      assert(rejected.correctionPrompt === 'Fix only these.', 'the correction prompt must survive');
    },
  },
  {
    name: 'application dock: a malformed handoff produces no item rather than a broken prompt',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      assert(applicationDockRequest({ node, handoff: null }) === null, 'no handoff, no item');
      assert(applicationDockRequest({ node: null, handoff: handoffRecord() }) === null, 'no node, no item');
      assert(
        applicationDockRequest({ node, handoff: handoffRecord({ handoffCode: '' }) }) === null,
        'a codeless handoff cannot be submitted, so it must not be offered',
      );
      assert(
        applicationDockRequest({ node, handoff: handoffRecord({ prompt: null }) }) === null,
        'an item with no prompt text would render an empty prompt box',
      );
      assert(
        applicationDockRequest({ node: jobCard('card-1', null), handoff: handoffRecord() }) === null,
        'a card with no bundle owns no handoff',
      );
    },
  },
  {
    name: 'application dock: the draft and canvas path needed to submit always travel with the item',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      const item = applicationDockRequest({ node, handoff: handoffRecord({ draft: '{"resume":{}}' }) });
      // submitLocalApplicationHandoff and updateLocalApplicationDraft both need
      // all three; the dock mounts outside the canvas tree and cannot look any
      // of them up itself.
      assert(item.jobId === 'job-1', 'the job id must travel with the item');
      assert(item.canvasFilePath === '/canvas/board.json', 'the canvas path must travel with the item');
      assert(item.handoffCode === handoffRecord().handoffCode, 'the handoff code must travel with the item');
      assert(item.initialResponse === '{"resume":{}}', 'a saved draft must be restored into the response box');
      const fallback = applicationDockRequest({
        node: jobCard('card-2', { id: 'job-2', status: 'queued', mode: 'paste' }),
        handoff: handoffRecord({ jobId: 'job-2' }),
        canvasFilePath: '/canvas/current.json',
      });
      assert(fallback.canvasFilePath === '/canvas/current.json', 'the current canvas file is the fallback path');
    },
  },
  {
    name: 'application dock: push handoffs lead the merged queue and ids never duplicate',
    run: () => {
      const push = [{ requestId: 'p1', task: 'job-scoring' }, { requestId: 'p2', task: 'job-scoring' }];
      const application = [
        applicationDockRequest({ node: jobCard('c1', pasteJob('job-1')), handoff: handoffRecord({ jobId: 'job-1' }) }),
        applicationDockRequest({ node: jobCard('c2', pasteJob('job-2')), handoff: handoffRecord({ jobId: 'job-2' }) }),
      ];
      const merged = mergeDockQueue(push, application);
      assert(merged.length === 4, `expected 4 items, got ${merged.length}`);
      // A blocked job run is what the person is waiting on; a bundle waits on
      // disk and loses nothing by being answered second.
      assert(merged[0].requestId === 'p1' && merged[1].requestId === 'p2', 'push handoffs must lead');
      assert(merged[2].kind === 'application' && merged[3].kind === 'application', 'application items follow');
      assert(
        new Set(merged.map(item => item.requestId)).size === merged.length,
        'a duplicate requestId would collide the chip keys and the draft store',
      );
      assert(mergeDockQueue(null, null).length === 0, 'empty sources merge to an empty queue');
      assert(mergeDockQueue(push, [null, undefined]).length === 2, 'null items must be dropped');
    },
  },
  {
    name: 'application dock: an unreadable refresh keeps the prompt someone is mid-paste on',
    run: () => {
      const previous = [
        { jobId: 'job-1', requestId: 'application:job-1', unreadable: true },
        { jobId: 'job-2', requestId: 'application:job-2', unreadable: true },
      ];
      // job-1 re-read fine this pass; job-2 did not. Evicting job-2 would throw
      // away a response the person may be part way through pasting, for a job
      // that is still pending on disk.
      const next = [{ jobId: 'job-1', requestId: 'application:job-1' }];
      const retained = retainUnreadableApplicationItems(next, previous);
      assert(retained.length === 2, `expected the unreadable item to be kept, got ${retained.length}`);
      assert(retained[0].jobId === 'job-1' && !retained[0].unreadable, 'a fresh read replaces the stale item');
      assert(retained[1].jobId === 'job-2', 'the unreadable item is retained');
      // An item that was readable and is now simply gone has genuinely left the
      // queue (the stage completed), so it must NOT be resurrected.
      const settled = retainUnreadableApplicationItems([], [{ jobId: 'job-3', requestId: 'application:job-3' }]);
      assert(settled.length === 0, 'a settled item must not be retained');
    },
  },
  {
    name: 'application dock: the cross-paste guard only claims a code the prompt actually carries',
    run: () => {
      assert(usesPushHandoffCode({ handoffCode: 'HANDOFF-2AB4CD' }), 'a push stamp must be recognised');
      // Application codes are base64url of 18 random bytes — a different
      // alphabet and length. Running the HANDOFF-XXXXXX comparison against one
      // would tell the person to look for a code their prompt never printed.
      assert(!usesPushHandoffCode({ handoffCode: 'fZ8kQ1v3nT7pLwXyBc2dGh4j' }), 'an application code is not a push stamp');
      assert(!usesPushHandoffCode({ handoffCode: '' }) && !usesPushHandoffCode(null), 'absent codes are not push stamps');
      assert(!usesPushHandoffCode({ handoffCode: 'HANDOFF-IL0OU1' }), 'the ambiguous-glyph alphabet is excluded');
    },
  },
  {
    name: 'application dock: stage labels stay human and never leak a raw stage key',
    run: () => {
      assert(applicationStageLabel('evidence-plan') === 'Evidence plan', 'evidence-plan label');
      assert(applicationStageLabel('resume') === 'Résumé', 'resume label');
      assert(applicationStageLabel('cover-letter') === 'Cover letter', 'cover-letter label');
      assert(applicationStageLabel('review') === 'Review and edit', 'review label');
      const unknown = applicationStageLabel('some-future-stage');
      assert(
        unknown === 'Application handoff',
        `an unmapped stage must fall back to a readable label, got ${unknown}`,
      );
    },
  },
  {
    name: 'application dock: the store replays to late subscribers and survives a throwing listener',
    run: () => {
      __resetApplicationHandoffsForTests();
      const seen = [];
      const items = [{ requestId: 'application:job-1', jobId: 'job-1' }];
      publishApplicationHandoffs(items);
      // The dock can mount after discovery has already published — a subscriber
      // must be handed the current queue immediately, not wait for a change.
      const unsubscribe = subscribeApplicationHandoffs(next => seen.push(next));
      assert(seen.length === 1 && seen[0].length === 1, 'a late subscriber must receive the current queue');
      assert(getApplicationHandoffs().length === 1, 'the store must expose the published queue');

      let goodListenerRan = false;
      subscribeApplicationHandoffs(() => { throw new Error('a broken dock listener'); });
      subscribeApplicationHandoffs(() => { goodListenerRan = true; });
      publishApplicationHandoffs([]);
      assert(goodListenerRan, 'one throwing listener must not stop discovery reaching the others');
      assert(getApplicationHandoffs().length === 0, 'publishing an empty queue clears it');

      unsubscribe();
      publishApplicationHandoffs(items);
      assert(seen.length === 2, 'an unsubscribed listener must stop receiving updates');
      __resetApplicationHandoffsForTests();
      assert(getApplicationHandoffs().length === 0, 'the test reset must clear the module-level store');
    },
  },
  {
    name: 'application dock: a broken bundle is shown as unfinishable, never silently dropped',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      const message = 'The frozen career corpus for this application can no longer be read.';
      const broken = brokenApplicationDockRequest({ node, message });
      assert(broken, 'a broken bundle must still produce an item');
      assert(broken.integrityMessage === message, 'the explanation must travel with the item');
      // No prompt and no code: this job takes no further paste, so the dock
      // must not be able to offer a response box for it.
      assert(broken.prompt === '' && broken.handoffCode === '', 'a broken bundle offers nothing to paste');
      assert(broken.isCorrection === false, 'a broken bundle is not a correction round');
      assert(broken.requestId === applicationRequestId('job-1'), 'it must occupy its own job slot');
      assert(!brokenApplicationDockRequest({ node, message: '   ' }), 'a blank explanation is no explanation');
      assert(!brokenApplicationDockRequest({ node: null, message }), 'no node, no item');

      // Both paths into the broken state must render the same way.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(
        dock.includes('activeRequest.integrityMessage'),
        'the dock must render an integrity fault observed by discovery, not only one caught by submit',
      );
      const discovery = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');
      assert(
        discovery.includes('jobIntegrityFailureMessage(') && discovery.includes('brokenApplicationDockRequest('),
        'discovery must classify an integrity fault rather than treating it as nothing to show',
      );
    },
  },
  {
    name: 'application dock: a debounced draft survives quit instead of trailing window destruction',
    run: async () => {
      // Push drafts get this from preload, which tracks every outstanding
      // invoke. Application drafts are debounced in the renderer, so at quit
      // an edit can exist only as a timer that has not fired yet.
      let flushed = false;
      let resolveWrite;
      const write = new Promise((resolve) => { resolveWrite = resolve; });
      const unregister = registerApplicationDraftFlusher(() => {
        flushed = true;
        trackApplicationDraftWrite(write);
      });
      // A throwing flusher must not strand everyone else's drafts.
      const unregisterBroken = registerApplicationDraftFlusher(() => { throw new Error('broken flusher'); });

      let settled = false;
      const flushing = flushApplicationDraftWrites().then(() => { settled = true; });
      assert(flushed, 'the pending debounce must be fired, not merely awaited');
      await Promise.resolve();
      assert(!settled, 'the flush must not resolve before the write it just issued');
      resolveWrite();
      await flushing;
      assert(settled, 'the flush must resolve once every issued write settles');

      unregister();
      unregisterBroken();
      await flushApplicationDraftWrites();

      // And the quit handshake must actually call it.
      const persistence = readFileSync(new URL('../../src/hooks/useCanvasPersistence.js', import.meta.url), 'utf8');
      assert(
        persistence.includes('flushApplicationDraftWrites()'),
        'the quit handshake must drain application drafts alongside push drafts',
      );
    },
  },
  {
    name: 'application dock: discarding a bundle clears the pointer even with the card unmounted',
    run: () => {
      // Two halves: the dock removes the durable folder, something clears
      // node.data.localApplication. If only a mounted card can do the second,
      // discarding from a hidden board leaves the fallback manager driving a
      // job whose folder is gone.
      const discovery = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');
      assert(
        discovery.includes("'application-handoff-discarded'"),
        'the canvas-level manager must hear discards, not only the mounted card',
      );
      assert(
        discovery.includes('updateNodeDataGlobally'),
        'it must clear the pointer through the global node write, as the fallback manager does',
      );
      assert(
        discovery.includes('live?.id === jobId'),
        'it must clear only the bundle the discard targeted, never a replacement queued since',
      );
    },
  },
  {
    name: 'application dock: a refresh raised during a discovery pass is queued, not dropped',
    run: () => {
      const discovery = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');
      // The dock asks for a refresh the instant it submits; dropping it
      // strands the answered prompt on screen until the slow safety interval.
      assert(
        discovery.includes('queuedRefreshRef'),
        'a refresh arriving while a pass runs must be remembered',
      );
      const busyIndex = discovery.indexOf('if (tickBusyRef.current) {');
      const queueIndex = discovery.indexOf('queuedRefreshRef.current =');
      assert(busyIndex >= 0 && queueIndex > busyIndex, 'the busy path must record the request before returning');
      assert(
        discovery.includes('queued.all') && discovery.includes('queued.jobIds'),
        'a pending full refresh must outrank a single-job one, which it already covers',
      );
    },
  },
  {
    name: 'application dock: a rejection never overwrites a correction the person is typing',
    run: () => {
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      // submit() re-enables the textarea in its finally while the refresh is
      // still round-tripping, so the person is invited to retype BEFORE
      // discovery answers — and the draft it answers with is the rejected
      // text still sitting on disk. Adopting it unconditionally would replace
      // a correction mid-keystroke.
      assert(
        dock.includes('const codeChanged = !prior || prior.handoffCode !== item.handoffCode;'),
        'the draft reset must distinguish a new stage from a correction round',
      );
      assert(
        dock.includes('const untouched = current === undefined || (prior && current === (prior.initialResponse || \'\'));'),
        'a same-code refresh must only adopt the stored draft when nothing of the person\'s is at stake',
      );
      const resetIndex = dock.indexOf('const codeChanged =');
      const guardIndex = dock.indexOf('const untouched =');
      assert(resetIndex >= 0 && guardIndex > resetIndex, 'the guard must sit inside the reset branch');
    },
  },
  {
    name: 'application dock: a dismissed bundle stops holding a Generate slot',
    run: () => {
      const nodes = [
        jobCard('a', pasteJob('job-a', 'queued')),
        jobCard('b', pasteJob('job-b', 'queued')),
      ];
      assert(countActiveApplicationHandoffs(nodes) === 2, 'both bundles hold a slot to begin with');
      // Dismissing an unfinishable bundle takes it off screen; leaving it
      // counted would refuse the next Generate for a slot nothing occupies.
      const dismissed = new Set([applicationRequestId('job-a')]);
      assert(
        countActiveApplicationHandoffs(nodes, dismissed) === 1,
        'a dismissed bundle must not count against the cap',
      );
      assert(countActiveApplicationHandoffs(nodes, new Set()) === 2, 'an empty dismissal set changes nothing');
      // The cap is read from another tree, so the set has to be shared.
      __resetApplicationHandoffsForTests();
      assert(getDismissedApplicationBundles().size === 0, 'the shared set starts empty');
      setDismissedApplicationBundles(dismissed);
      assert(
        getDismissedApplicationBundles().has(applicationRequestId('job-a')),
        'the dock must be able to publish dismissals to the cap',
      );
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert(
        card.includes('countActiveApplicationHandoffs(handoffCapNodes, getDismissedApplicationBundles())'),
        'the Generate cap must consult the dismissed set',
      );
      __resetApplicationHandoffsForTests();
      assert(getDismissedApplicationBundles().size === 0, 'the reset seam must clear the shared set');
    },
  },
  {
    name: 'application dock: a bundle past the paste phase occupies no slot and lights no action',
    run: () => {
      // The result already exists; it is the LAYOUT check that is retried,
      // from the card. There is no prompt to hand back, so counting it would
      // spend a slot on a bundle the dock can never show — and light a
      // Continue action that opens nothing.
      assert(
        APPLICATION_DOCK_IDLE_STATUSES.includes('render-retry-required'),
        'render-retry-required is past the paste phase and holds no dock slot',
      );
      assert(
        selectApplicationHandoffCandidates([jobCard('a', pasteJob('job-a', 'render-retry-required'))]).length === 0,
        'it must not be a dock candidate',
      );
      // The card's Continue button and the dock's candidate rule must not drift.
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert(
        card.includes('!APPLICATION_DOCK_IDLE_STATUSES.includes(localApplication.status)'),
        'the card must gate Continue AI handoff on the same list the dock selects with',
      );
    },
  },
  {
    name: 'application dock: an unreadable item is not carried forward once its job settles',
    run: () => {
      const previous = [
        { jobId: 'job-1', requestId: 'application:job-1', unreadable: true },
        { jobId: 'job-2', requestId: 'application:job-2', unreadable: true },
      ];
      // job-1 is still pending, so keep it. job-2 settled through its own poll
      // or import and left the candidate list; only a successful re-read could
      // clear its flag, and a settled job is never re-read — so without the
      // candidate scope it would ride along on every pass forever.
      const stillPending = new Set(['job-1']);
      const retained = retainUnreadableApplicationItems([], previous, stillPending);
      assert(retained.length === 1 && retained[0].jobId === 'job-1', 'only a still-pending job is retained');
      // Omitting the scope keeps the old permissive behaviour for callers that
      // genuinely have no candidate list.
      assert(
        retainUnreadableApplicationItems([], previous).length === 2,
        'an absent candidate set must not silently drop items',
      );
      const discovery = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');
      assert(
        discovery.includes('retainUnreadableApplicationItems(nextItems, previousItems, candidateJobIds)'),
        'discovery must pass the candidate scope it already computed',
      );
    },
  },
  {
    name: 'application dock: a focus request cannot fire on a later unrelated publish',
    run: () => {
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      // Two Generate presses before either is discovered put two ids in the
      // set, and one publish can satisfy both. Honouring one and leaving the
      // other queued would let it seize the panel minutes later, yanking the
      // person off the prompt they are working on.
      assert(dock.includes('let focused = false;'), 'only the first satisfied focus may select');
      assert(
        dock.includes('if (focused) continue;'),
        'the remaining satisfied ids must be drained rather than left queued',
      );
      assert(
        !/awaitingFocus\.delete\(focusJobId\);\s*\n\s*if \(focused\) continue;[\s\S]{0,400}?break;/.test(dock),
        'the loop must not break early and strand a satisfied id',
      );
      assert(
        dock.includes('for (const focusJobId of [...awaitingFocus])'),
        'iterate a copy, since the loop deletes from the set',
      );
    },
  },
  {
    name: 'application dock: retention is disclosed before a response is pasted',
    run: () => {
      // The full-screen modal this replaced said so in its footer. Pasted
      // answers are written into the private job folder and every accepted
      // revision is appended to the bundle's Generation Log, so dropping the
      // sentence would quietly remove the only place the person is told.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(
        /Responses are saved privately with this application/.test(dock),
        'the dock must disclose that pasted responses are retained with the bundle',
      );
      assert(
        /appended to its generation log/i.test(dock),
        'the dock must disclose that accepted revisions are logged',
      );
      // And the log itself must still be written and shipped with the bundle.
      const main = readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert(
        main.includes("const PASTE_APPLICATION_LOG_FILE = 'Generation Log.jsonl';"),
        'the generation log file must still be defined',
      );
      assert(
        main.includes('PASTE_APPLICATION_LOG_FILE,') || main.includes('PASTE_APPLICATION_LOG_FILE]'),
        'the generation log must still be listed among the files a bundle keeps',
      );
    },
  },
  {
    name: 'application dock: every cross-tree event a card raises has a live consumer',
    run: () => {
      // The card owns no dialog any more, so a dispatched event with nobody
      // listening is a dead button — and nothing else in this repo would catch
      // it: the app compiles, the tests pass, and the control silently does
      // nothing. Pair each producer with its consumer explicitly.
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const discovery = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');

      assert(
        card.includes('requestApplicationHandoffFocus('),
        'the card must be able to point the dock at its bundle',
      );
      assert(
        dock.includes('subscribeApplicationHandoffFocus('),
        'the dock must consume focus requests, or Generate and Continue AI handoff do nothing',
      );
      assert(
        dock.includes('requestApplicationHandoffRefresh('),
        'the dock must ask discovery to re-read a job after it submits',
      );
      assert(
        discovery.includes('subscribeApplicationHandoffRefresh('),
        'discovery must consume refresh requests, or a submitted stage never advances on screen',
      );
      // The discard is two halves: the dock removes the durable folder, the
      // card clears its pointer. If the event name or its detail fields drift
      // apart, the fallback manager resurrects the bundle the person discarded.
      assert(
        dock.includes("'application-handoff-discarded'") && card.includes("'application-handoff-discarded'"),
        'the discard event name must match on both sides',
      );
      for (const field of ['jobId', 'nodeId']) {
        assert(
          dock.includes(`${field},`) || dock.includes(`${field}:`),
          `the discard event must carry ${field}`,
        );
        assert(
          card.includes(`event?.detail?.${field}`),
          `the card must read ${field} off the discard event detail`,
        );
      }
    },
  },
  {
    name: 'application dock: the full-screen application modals are gone and unreferenced',
    run: () => {
      // The whole point of the change: one queue, no per-card modal. A dangling
      // import of a deleted component is a render-time crash, and no test in
      // this repo mounts a component to catch it.
      const sources = [
        '../../src/nodes/JobCardNode.jsx',
        '../../src/Canvas.jsx',
        '../../src/App.jsx',
      ].map(relative => readFileSync(new URL(relative, import.meta.url), 'utf8'));
      for (const source of sources) {
        assert(
          !source.includes('ApplicationPasteDialog') && !source.includes('ApplicationLaunchPromptDialog'),
          'no renderer source may still reference a deleted application modal',
        );
      }
      let removed = 0;
      for (const relative of [
        '../../src/components/ApplicationPasteDialog.jsx',
        '../../src/components/ApplicationLaunchPromptDialog.jsx',
      ]) {
        try { readFileSync(new URL(relative, import.meta.url), 'utf8'); }
        catch (error) {
          assert(error?.code === 'ENOENT', `unexpected error reading ${relative}: ${error?.message}`);
          removed += 1;
        }
      }
      assert(removed === 2, 'both application modal components must be deleted');
    },
  },
];
