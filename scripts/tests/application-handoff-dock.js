import { readFileSync } from 'node:fs';
import { assert } from './testHelpers.js';
import {
  APPLICATION_DOCK_BLOCKED_STATUSES,
  APPLICATION_DOCK_IDLE_STATUSES,
  APPLICATION_DOCK_WORKING_STATUSES,
  APPLICATION_HANDOFF_LIMIT,
  applicationAwaitsPaste,
  applicationDockItemState,
  applicationDockRequest,
  applicationLimitMessage,
  brokenApplicationDockRequest,
  workingApplicationDockRequest,
  getDismissedApplicationBundles,
  setDismissedApplicationBundles,
  flushApplicationDraftWrites,
  registerApplicationDraftFlusher,
  trackApplicationDraftWrite,
  applicationRequestId,
  applicationStageLabel,
  assignApplicationOrdinals,
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
import { deriveBridgeJobProgress, formatProgressDuration, progressTimeLines, PROGRESS_STAGES } from '../../src/utils/bridgeJobProgress.js';
import { BRIDGE_PROGRESS_COPY, bridgePluginRef } from '../../src/utils/handoffBridgeCopy.js';
import { deriveBridgeHealth } from '../../src/utils/handoffBridgeView.js';
import { EMPTY_BRIDGE_STATUS } from '../../src/utils/handoffBridgeStatus.js';
import { BRIDGE_WORKING_PHASES, bridgeHeldCardLine, bridgeHeldKey, findBridgeHeldJob, isBridgeHeldJob } from '../../src/utils/bridgeHeldApplication.js';

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

const dockTests = [
  {
    name: 'application dock: only genuinely finished paste bundles give up their slot',
    run: () => {
      const nodes = [
        jobCard('a', pasteJob('job-a', 'queued')),
        jobCard('b', pasteJob('job-b', 'revision-required')),
        jobCard('c', pasteJob('job-c', 'invalid')),
        // Only the terminal pair holds no slot.
        jobCard('d', pasteJob('job-d', 'saved')),
        jobCard('e', pasteJob('job-e', 'failed')),
        // The app's own post-accept work still holds its slot: no paste is
        // possible, but the bundle is not finished — see
        // APPLICATION_DOCK_WORKING_STATUSES.
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
        selected.join(',') === 'a,b,c,f,g,h',
        `expected waiting and working bundles, got ${selected.join(',') || '(none)'}`,
      );
      assert(countActiveApplicationHandoffs(nodes) === 6, 'count must agree with selection');
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
    name: 'application dock: the blocked panel names a card action that actually exists',
    run: () => {
      const dialog = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      // A panel that deliberately keeps a bundle on screen owes the person
      // the way out of it, and naming a button that does not exist is worse
      // than naming none at all. This is the one place the dock points at an
      // affordance it does not own, so the two have to be checked together.
      assert(dialog.includes('press Retry layout check on its card')
        && card.includes('Retry layout check')
        && card.includes("localApplication.status === 'render-retry-required' && ("),
      'the dock names the card\u2019s Retry layout check button, and the card still renders it for exactly that status');
      return { checkedActions: 1 };
    },
  },
  {
    name: 'application dock: a working bundle is classified from the main process status, not the stale node copy',
    run: () => {
      const hook = readFileSync(new URL('../../src/hooks/useApplicationHandoffDock.js', import.meta.url), 'utf8');
      // node.data.localApplication.status is written by a 2.5s card poll that
      // accepting a response does not trigger. The refresh a submit fires
      // therefore lands while that copy still reads the PRE-submit status,
      // classifies as 'waiting', and drops the chip until the next full
      // discovery interval — the exact disappearance the working item exists
      // to stop, reintroduced while looking correct. getLocalApplicationHandoff
      // returns manifest.status read from disk in the same call; that is the
      // only current one.
      assert(hook.includes('const freshStatus = result.localJob?.status || local.status;')
        && hook.includes('const workingState = applicationDockItemState(freshStatus);')
        && hook.includes('workingApplicationDockRequest({ node, canvasFilePath, status: freshStatus })')
        && !hook.includes('applicationDockItemState(local.status)'),
      'the dock classifies a working bundle from the status the main process just read, never from the node copy a poll has not refreshed');
      // A completed paste whose status has not caught up even in the manifest
      // is still the app working. Only an explicitly idle status ends it.
      assert(hook.includes("if (result.completed && workingState !== 'idle') {")
        && hook.includes("workingApplicationDockRequest({ node, canvasFilePath, status: 'paste-completed' })"),
      'a completed paste whose status lags keeps its slot instead of vanishing');
      return { checkedSignals: 2 };
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
    name: 'application dock: a rejection empties the paste box and no refresh refills it',
    run: () => {
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      // The rejected text has to go: the correction asks for the COMPLETE
      // regenerated answer, so every character of it is replaced anyway, and
      // leaving thousands of characters in the box made a fresh paste look
      // appended rather than replacing.
      assert(
        dock.includes("setDrafts(previous => (previous[requestId] === '' ? previous : { ...previous, [requestId]: '' }));"),
        'submit must clear the dock draft when a response is rejected',
      );
      assert(
        dock.includes('flushApplicationDraftSave(requestId);'),
        'the debounced write must be flushed so it cannot re-save the rejected text',
      );
      // And the durable draft too, or reopening restores what was discarded.
      assert(
        /updateLocalApplicationDraft\(\{[\s\S]{0,200}?draft: '',/.test(dock),
        'the persisted draft must be cleared as well',
      );
      // The refresh that follows must not put it back: the durable clear is
      // async, so a refresh landing first would carry the rejected text.
      assert(
        dock.includes('const codeChanged = !prior || prior.handoffCode !== item.handoffCode;'),
        'a new stage must still be distinguished from a correction round',
      );
      assert(
        !dock.includes('const untouched ='),
        'a correction round must not adopt a stored draft at all',
      );
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
    name: 'application dock: a blocked bundle keeps its slot and its number, but still lights no action',
    run: () => {
      // The result already exists; it is the LAYOUT check that is retried,
      // from the card. There is still no prompt to hand back, so Continue
      // still opens nothing — but the bundle is NOT finished, and if the
      // retry fails back into a paste round, its dock slot and its ordinal
      // have to still be there waiting for it. This is the opposite of the
      // old rule: render-retry-required used to hold no slot at all.
      assert(
        APPLICATION_DOCK_BLOCKED_STATUSES.includes('render-retry-required'),
        'render-retry-required is blocked, not idle',
      );
      assert(
        !APPLICATION_DOCK_IDLE_STATUSES.includes('render-retry-required'),
        'a blocked bundle must not be idle: idle is what releases the number',
      );
      assert(
        selectApplicationHandoffCandidates([jobCard('a', pasteJob('job-a', 'render-retry-required'))]).length === 1,
        'it must still be a dock candidate, holding its slot',
      );
      assert(
        applicationDockItemState('render-retry-required') === 'blocked',
        'the shared classifier must call it blocked',
      );
      assert(
        !applicationAwaitsPaste('render-retry-required'),
        'there is still no prompt to paste against, so Continue must not light',
      );
      // The card's Continue button and the dock's "can this show a prompt"
      // rule must not drift apart: both have to read the one shared predicate,
      // not each maintain their own copy of which statuses qualify.
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert(
        card.includes('applicationAwaitsPaste(localApplication.status)'),
        'the card must gate Continue AI handoff on the shared awaits-paste predicate',
      );
    },
  },
  {
    name: 'application dock: every working status is a dock candidate',
    run: () => {
      for (const status of APPLICATION_DOCK_WORKING_STATUSES) {
        assert(
          selectApplicationHandoffCandidates([jobCard('a', pasteJob('job-a', status))]).length === 1,
          `${status} must still hold a dock slot`,
        );
        assert(applicationDockItemState(status) === 'working', `${status} must classify as working`);
        assert(!applicationAwaitsPaste(status), `${status} must not await a paste`);
      }
    },
  },
  {
    name: 'application dock: a bundle keeps its ordinal across waiting to working',
    run: () => {
      // Two discovery passes for the SAME job — first while it is waiting on
      // a paste, then after the accepted answer put it into its own
      // post-accept work. The number on screen must not move between them,
      // or the chip a person is watching for stops meaning the same bundle.
      const ordinals = new Map();
      const waiting = { jobId: 'job-a', requestId: applicationRequestId('job-a') };
      assignApplicationOrdinals(ordinals, [waiting]);
      const assignedNumber = ordinals.get('job-a');
      assert(assignedNumber === 1, 'the first bundle in an empty queue takes number 1');
      const working = {
        jobId: 'job-a',
        requestId: applicationRequestId('job-a'),
        working: true,
        workingState: 'working',
      };
      assignApplicationOrdinals(ordinals, [working]);
      assert(
        ordinals.get('job-a') === assignedNumber,
        'the number must not change when the same bundle goes from waiting to working',
      );
    },
  },
  {
    name: 'application dock: a new bundle cannot take a working bundle’s number',
    run: () => {
      const ordinals = new Map();
      const working = {
        jobId: 'job-a',
        requestId: applicationRequestId('job-a'),
        working: true,
        workingState: 'working',
      };
      assignApplicationOrdinals(ordinals, [working]);
      assert(ordinals.get('job-a') === 1, 'the working bundle holds number 1 on its own');
      // A second bundle discovered while the first is still saving must not
      // be able to seize 1 — that number is not free until job-a is idle.
      const arriving = { jobId: 'job-b', requestId: applicationRequestId('job-b') };
      assignApplicationOrdinals(ordinals, [working, arriving]);
      assert(ordinals.get('job-a') === 1, 'the working bundle keeps its number');
      assert(ordinals.get('job-b') === 2, 'the new bundle takes the next free number, never a held one');
    },
  },
  {
    name: 'application dock: applicationAwaitsPaste is true only for a genuinely waiting status',
    run: () => {
      for (const status of APPLICATION_DOCK_IDLE_STATUSES) {
        assert(!applicationAwaitsPaste(status), `${status} (idle) must not await a paste`);
      }
      for (const status of APPLICATION_DOCK_WORKING_STATUSES) {
        assert(!applicationAwaitsPaste(status), `${status} (working) must not await a paste`);
      }
      for (const status of APPLICATION_DOCK_BLOCKED_STATUSES) {
        assert(!applicationAwaitsPaste(status), `${status} (blocked) must not await a paste`);
      }
      assert(applicationAwaitsPaste('queued'), 'a fresh waiting bundle must await a paste');
      assert(applicationAwaitsPaste('revision-required'), 'a correction round is still waiting on a paste');
    },
  },
  {
    name: 'application dock: workingApplicationDockRequest mirrors its broken sibling’s identity fields',
    run: () => {
      assert(
        workingApplicationDockRequest({ node: null, status: 'importing' }) === null,
        'no node, no item',
      );
      assert(
        workingApplicationDockRequest({ node: jobCard('a', null), status: 'importing' }) === null,
        'a card with no bundle owns no handoff',
      );

      const node = jobCard('card-1', pasteJob('job-1', 'importing'));
      const working = workingApplicationDockRequest({ node, status: 'importing' });
      const broken = brokenApplicationDockRequest({ node, message: 'x' });
      assert(working, 'a usable node must produce an item');
      for (const field of ['stage', 'jobId', 'nodeId', 'requestId', 'canvasFilePath', 'label', 'subject']) {
        assert(
          working[field] === broken[field],
          `working and broken items must carry the same ${field}, got ${working[field]} vs ${broken[field]}`,
        );
      }
      assert(working.working === true, 'a working item must be flagged working');
      assert(working.workingState === 'working', 'importing must classify as working');
      assert(working.prompt === '', 'a working item has nothing to paste against');

      const blocked = workingApplicationDockRequest({
        node: jobCard('card-2', pasteJob('job-2', 'render-retry-required')),
        status: 'render-retry-required',
      });
      assert(blocked.workingState === 'blocked', 'render-retry-required must classify as blocked');
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
    name: 'application dock: a new bundle takes a number no queued bundle is using',
    run: () => {
      const item = (jobId) => ({ jobId, requestId: applicationRequestId(jobId) });
      const ordinals = new Map();

      // Three bundles queued in one pass get 1, 2, 3 — the second must see the
      // number the first just took, or two chips would both read "1".
      let queue = assignApplicationOrdinals(ordinals, [item('a'), item('b'), item('c')]);
      assert(queue.map(i => ordinals.get(i.jobId)).join(',') === '1,2,3', 'first pass numbers 1,2,3');
      assert(new Set(ordinals.values()).size === ordinals.size, 'no two bundles may share a number');

      // A live bundle NEVER renumbers. b finishing must not slide c from 3 to 2
      // while someone has c's chat open.
      queue = assignApplicationOrdinals(ordinals, [item('a'), item('c')]);
      assert(ordinals.get('a') === 1 && ordinals.get('c') === 3, 'survivors keep their numbers');
      assert(!ordinals.has('b'), 'a finished bundle releases its number');

      // A NEW bundle takes the lowest number nothing in the queue is using —
      // 2, the one b released — rather than growing to 4.
      queue = assignApplicationOrdinals(ordinals, [item('a'), item('c'), item('d')]);
      assert(ordinals.get('d') === 2, `a new bundle reuses the freed number, got ${ordinals.get('d')}`);
      assert(ordinals.get('a') === 1 && ordinals.get('c') === 3, 'and still does not renumber the others');
      assert(new Set(ordinals.values()).size === 3, 'the queue never holds a duplicate number');

      // Ordering follows the number, not discovery order, so a reshuffled
      // enumeration cannot move chips under someone mid-paste.
      queue = assignApplicationOrdinals(ordinals, [item('c'), item('d'), item('a')]);
      assert(queue.map(i => i.jobId).join(',') === 'a,d,c', `expected a,d,c got ${queue.map(i => i.jobId).join(',')}`);

      // Emptying the queue frees everything; the next bundle starts at 1 again.
      assignApplicationOrdinals(ordinals, []);
      assert(ordinals.size === 0, 'an empty queue holds no numbers');
      assignApplicationOrdinals(ordinals, [item('e')]);
      assert(ordinals.get('e') === 1, 'numbering restarts at 1 once nothing is queued');

      // A full strip: ten bundles must occupy exactly 1..10.
      const ten = new Map();
      const all = Array.from({ length: APPLICATION_HANDOFF_LIMIT }, (_, i) => item(`job-${i}`));
      assignApplicationOrdinals(ten, all);
      assert(
        [...ten.values()].sort((x, y) => x - y).join(',') === all.map((_, i) => i + 1).join(','),
        'a full queue occupies 1..limit with no gaps or repeats',
      );
      assert(assignApplicationOrdinals(ten, null).length === 0, 'a missing list is empty, not a throw');
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
    name: 'application dock: the prompt textarea and panel body both reset their scroll offset on every new prompt',
    run: () => {
      // Two scrollers are reused for every prompt the dock ever shows: the
      // <textarea id="non-api-ai-prompt">, and the <form ref={panelBodyRef}>
      // panel body wrapped around it. Both keep their scroll offset across a
      // value change on their own, and the panel body's height genuinely
      // varies prompt to prompt (attachments block, error banner, fix-count
      // chip, full-prompt escape hatch), so a leftover offset there does not
      // merely hold position — it can land on unrelated content or push the
      // action buttons off the bottom of a shorter prompt. Without an
      // explicit reset, submitting a response from halfway down a long
      // prompt opens the NEXT prompt at that same stale offset in one or
      // both scrollers. This locks the fix in place against the ways it
      // could silently regress: either ref going missing, the identity check
      // running after a ref read instead of before, the bail-out firing when
      // only one scroller is unmounted instead of both, either scroller's
      // reset being dropped, the identity dropping displayedPrompt, or the
      // effect downgrading to useEffect (which paints the old offset for one
      // frame before the reset runs).
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      // Both scrollers must be the exact nodes the reset can reach, and the
      // textarea must render the exact value the reset is keyed on — not
      // some other expression that could drift out of sync with what is
      // actually on screen.
      assert(dock.includes('ref={promptFieldRef}'), 'the prompt textarea must carry the ref the scroll reset uses');
      assert(dock.includes('ref={panelBodyRef}'), 'the panel body form must carry the ref the scroll reset uses');
      assert(dock.includes('value={displayedPrompt}'), 'the prompt textarea must render displayedPrompt itself, not a re-derived expression');

      // The reset must be a useLayoutEffect — not useEffect, which would let
      // the browser paint the old scroll offset for one frame before the
      // reset ran — and it must stay keyed on promptScrollIdentity. Isolate
      // its body between those two anchors so the checks below are specific
      // to this effect without depending on the exact lines around it.
      const effectStart = dock.indexOf('useLayoutEffect(() => {');
      assert(effectStart >= 0, 'the scroll reset must be a useLayoutEffect');
      const depArrayMarker = '}, [promptScrollIdentity]);';
      const effectEnd = dock.indexOf(depArrayMarker, effectStart);
      assert(effectEnd > effectStart, 'the layout effect must stay keyed on promptScrollIdentity');
      const effectBody = dock.slice(effectStart, effectEnd);

      // The identity check has to run before either ref is read: that is what
      // makes an unrelated re-render (same prompt, some other state changing)
      // a no-op instead of re-zeroing a scroller the person is mid-read on.
      const identityCheckIndex = effectBody.indexOf('promptScrollIdentityRef.current === promptScrollIdentity');
      const fieldReadIndex = effectBody.indexOf('promptFieldRef.current');
      const bodyReadIndex = effectBody.indexOf('panelBodyRef.current');
      assert(
        identityCheckIndex >= 0 && fieldReadIndex > identityCheckIndex && bodyReadIndex > identityCheckIndex,
        'the identity check must run before either ref is read',
      );

      // The effect must give up only when BOTH scrollers are unmounted (the
      // dock is collapsed) — bailing on just one missing ref would skip the
      // reset for whichever scroller is actually mounted.
      assert(
        effectBody.includes('if (!field && !body) return;'),
        'the effect must bail only when both scrollers are unmounted',
      );

      // The textarea reset must zero both axes, guarded so it never runs
      // against a null ref.
      const fieldGuardIndex = effectBody.indexOf('if (field)');
      const fieldScrollTopIndex = effectBody.indexOf('field.scrollTop = 0');
      const fieldScrollLeftIndex = effectBody.indexOf('field.scrollLeft = 0');
      assert(
        fieldGuardIndex >= 0 && fieldScrollTopIndex > fieldGuardIndex && fieldScrollLeftIndex > fieldScrollTopIndex,
        'the textarea reset must zero scrollTop and scrollLeft inside an `if (field)` guard',
      );

      // The panel body reset rides the same trigger. It only needs scrollTop
      // zeroed — the body scrolls vertically only — so it has no scrollLeft
      // companion the way the textarea's reset does.
      assert(
        effectBody.includes('body.scrollTop = 0'),
        'the panel body must have its scrollTop zeroed on the same trigger as the textarea',
      );

      // promptScrollIdentity must include displayedPrompt itself, not just the
      // handoffCode/revision/correction bookkeeping — a correction reissued
      // under the SAME handoffCode (an ordinary rejection keeps its stage
      // code) still has to reset both scrollers, and only the text changing
      // can catch that case.
      assert(
        dock.includes('    displayedPrompt,\n  ].join(\'\\n\');'),
        'promptScrollIdentity must include displayedPrompt so a same-code correction still resets the scroll',
      );
    },
  },
  {
    name: 'application dock: rejectionEscalation threads onto dock items exactly as the handoff sent it',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      // Mirrors the shape pasteHandoffRecord (electron/ipc/localAiApplication.js)
      // writes onto record.rejectionEscalation when a check individually
      // crossed PASTE_REJECTION_ESCALATION_STREAK.
      const escalation = { active: true, checkIds: ['direct-welcome-closing'], streak: 3, trimmedFromPrompt: false };
      const item = applicationDockRequest({
        node,
        handoff: handoffRecord({
          corrections: ['Says the letter closes by naming the employer.'],
          correctionPrompt: 'Fix only this.',
          rejectionEscalation: escalation,
        }),
      });
      assert(
        item.rejectionEscalation === escalation,
        'the dock item must carry the SAME object the handoff sent — applicationDockRequest must never recompute it (see its own doc comment)',
      );

      // A fresh (non-correction) round never carries the field at all — the
      // main process only sets it alongside a correction prompt.
      const fresh = applicationDockRequest({ node, handoff: handoffRecord() });
      assert(fresh.rejectionEscalation === null, 'a fresh stage with no escalation field must normalize to null, not undefined');

      // A malformed or missing field must degrade to null rather than be
      // passed through as-is: NonApiAiDialog's hasActiveEscalation trusts
      // `rejectionEscalation` to be either an object or null, never a stray
      // primitive a future caller could send.
      for (const malformed of [undefined, null, 'active', 42, true]) {
        const bad = applicationDockRequest({ node, handoff: handoffRecord({ rejectionEscalation: malformed }) });
        assert(bad.rejectionEscalation === null, `a malformed rejectionEscalation (${JSON.stringify(malformed)}) must normalize to null`);
      }

      // The broken and working variants never see a handoff at all, so they
      // must declare the same null EXPLICITLY — consistent with every other
      // field these two already mirror from applicationDockRequest's shape.
      const broken = brokenApplicationDockRequest({ node, message: 'x' });
      const working = workingApplicationDockRequest({ node, status: 'importing' });
      assert(broken.rejectionEscalation === null, 'a broken bundle carries no escalation');
      assert(working.rejectionEscalation === null, 'a working bundle carries no escalation');
    },
  },
  {
    name: 'application dock: an active escalation renders a hard-to-skim signal naming the check id(s) and streak',
    run: () => {
      // NonApiAiDialog is never mounted by this suite (no render-phase
      // coverage exists here — see the project's own known blind spot), so
      // this locks the RENDER LOGIC the same way every other conditional-
      // render fact in this file is locked: by asserting the exact source
      // that gates it is present, in the right shape. A future edit that
      // silently drops the gate, or folds it into the ordinary hasError
      // dot/badge it exists to be distinct from, fails this test.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      // The gate itself: true only when active AND at least one check id is
      // named, so a defensive-but-empty payload cannot render a blank claim.
      // Routed through escalationCheckIds (shared with escalationHeadline
      // below) rather than a raw `.checkIds.length` so a falsy-only array
      // (`['']`/`[null]`) can never pass the gate and then render nothing —
      // see the dedicated agreement test below.
      assert(
        dock.includes('escalation?.active === true && escalationCheckIds(escalation).length > 0'),
        'hasActiveEscalation must require both an active flag and a non-empty (post-falsy-filter) checkIds list',
      );
      // The headline sentence must name the check id and the streak count —
      // the two facts the bug report says are invisible today.
      assert(
        dock.includes('now rejected ${streak} consecutive response'),
        'escalationHeadline must state the consecutive-rejection count in its own sentence',
      );
      assert(
        dock.includes('`Check "${ids[0]}"`') && dock.includes('Checks ${ids.map(id => `"${id}"`).join(\', \')}'),
        'escalationHeadline must name the stuck check id(s) verbatim',
      );

      // The panel banner: role="alert" (announced unprompted, unlike the
      // amber role="status" bundle-saving block above it), red rather than
      // the amber this file already uses for an ordinary correction, and
      // gated on the escalation being ACTIVE — not merely on isCorrection,
      // or every ordinary correction round would show it.
      const bannerIndex = dock.indexOf('{activeRejectionEscalation && !activeCorrectionsRecovered && (');
      assert(bannerIndex >= 0, 'the panel must render a block gated on activeRejectionEscalation');
      const bannerSlice = dock.slice(bannerIndex, bannerIndex + 1600);
      assert(bannerSlice.includes('role="alert"'), 'the escalation banner must be role="alert", not a passive status region');
      assert(bannerSlice.includes('border-red-400/40'), 'the escalation banner must use red, not the amber vocabulary of an ordinary correction');
      assert(bannerSlice.includes('Stuck on the same check: {escalationHeadline(activeRejectionEscalation)}'), 'the banner must state plainly which check is stuck and print its own headline sentence');
      // It must be positioned ABOVE the ordinary correction paragraph, not
      // spliced into it — the exact failure mode the bug report describes
      // (a signal buried mid-prompt that a skim never reaches).
      const introIndex = dock.indexOf('The previous answer did not validate');
      assert(introIndex > bannerIndex, 'the escalation banner must render before the ordinary correction intro paragraph, not after it');

      // The chip strip: a ring distinct from the selected/unselected border
      // colors, and a triangle icon replacing the plain color dot so a
      // THIRD rejection cannot look identical to a first (the dot is already
      // red for any hasError chip).
      assert(dock.includes("isEscalated ? ' ring-2 ring-red-400/80 ring-offset-1 ring-offset-neutral-900' : ''"), 'an escalated chip must carry a ring distinct from its selected/unselected border colors');
      assert(dock.includes(') : isEscalated ? (') && dock.includes('<AlertTriangle size={10} className="shrink-0 text-red-300" aria-hidden="true" />'), 'an escalated chip must swap its status dot for a triangle icon, not reuse the plain hasError dot');
      // And the accessible name (aria-label/title both read selectorDescription)
      // must carry the fact too, for anyone who cannot see the ring.
      assert(
        dock.includes('isEscalated ? `stuck — ${escalationHeadline(request.rejectionEscalation)}` : null,'),
        'the chip\'s accessible description must lead with the escalation sentence, not bury it after the ordinary status words',
      );

      // The second, dedicated "Stuck ×N" badge beside the existing fix-count
      // chip — the exact line the bug report names ("the dock chip reads
      // '1 fix to send' identically whether the streak is 1, 2 or 3").
      assert(
        dock.includes('Stuck{Number.isFinite(activeRejectionEscalation.streak) ? ` ×${activeRejectionEscalation.streak}` : \'\'}'),
        'a dedicated Stuck ×N badge must sit beside the fix-count chip so streak 1/2/3 no longer render identically',
      );
    },
  },
  {
    // Executes the real gate/headline logic (not just a string match) by
    // pulling the three verbatim const declarations out of the component
    // source and evaluating them — same technique job-role-lock-regressions.js
    // and solve-ipc-failure.js already use to exercise renderer-only pure
    // logic without mounting React (see this file's own known blind spot,
    // noted above). Proves the bug directly: hasActiveEscalation and
    // escalationHeadline must agree on every shape, including a `checkIds`
    // array whose entries are ALL falsy (e.g. `['']`/`[null]`) — before the
    // fix, that shape passed the gate (non-empty array) and then rendered a
    // headline naming nothing, because escalationHeadline filtered falsy
    // entries and the gate did not.
    name: 'application dock: hasActiveEscalation and escalationHeadline agree on every checkIds shape, including falsy-only entries',
    run: () => {
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const start = dock.indexOf('const escalationCheckIds = (escalation) => (');
      assert(start >= 0, 'could not locate the escalationCheckIds declaration to extract -- has it been renamed?');
      const headlineStart = dock.indexOf('const escalationHeadline = (escalation) => {', start);
      assert(headlineStart > start, 'could not locate the escalationHeadline declaration after escalationCheckIds -- has ordering changed?');
      const end = dock.indexOf('\n};', headlineStart);
      assert(end > headlineStart, 'could not find escalationHeadline\'s closing brace to bound the extracted source');
      const body = dock.slice(start, end + 3);
      const { escalationCheckIds, hasActiveEscalation, escalationHeadline } = new Function(
        `${body}\nreturn { escalationCheckIds, hasActiveEscalation, escalationHeadline };`,
      )();

      // The exact shape the bug report names: every entry falsy, so the OLD
      // gate (`Array.isArray(checkIds) && checkIds.length > 0`) passed on the
      // raw array length while escalationHeadline's own internal filter threw
      // every entry away and returned ''. Both must now say "no" together.
      for (const checkIds of [[''], [null], [undefined], [0], [false], ['', null, 0, false]]) {
        const escalation = { active: true, checkIds, streak: 4 };
        assert(hasActiveEscalation(escalation) === false,
          `a checkIds array of only falsy entries (${JSON.stringify(checkIds)}) must not gate as an active escalation`);
        assert(escalationHeadline(escalation) === '',
          `escalationHeadline must return '' (never a blank-subject sentence) for an all-falsy checkIds array, got ${JSON.stringify(escalationHeadline(escalation))}`);
      }

      // A normal, real escalation must still render exactly as before --
      // this fix must not have narrowed the gate past legitimate payloads.
      const real = { active: true, checkIds: ['direct-welcome-closing'], streak: 3 };
      assert(hasActiveEscalation(real) === true, 'a real, active, named escalation must still gate as active');
      assert(escalationHeadline(real) === 'Check "direct-welcome-closing" has now rejected 3 consecutive responses in a row.',
        `escalationHeadline must still name the real check id and streak verbatim, got ${JSON.stringify(escalationHeadline(real))}`);

      // A mixed array (some falsy, some real) must gate as active and name
      // ONLY the real id(s) -- escalationCheckIds is the single filter both
      // the gate and the headline read, so they cannot possibly diverge here.
      const mixed = { active: true, checkIds: ['', 'redundancy', null], streak: 2 };
      assert(hasActiveEscalation(mixed) === true, 'a checkIds array mixing falsy entries with one real id must still gate as active');
      assert(escalationHeadline(mixed) === 'Check "redundancy" has now rejected 2 consecutive responses in a row.',
        `escalationHeadline must name only the real id(s) from a mixed array, never a blank one, got ${JSON.stringify(escalationHeadline(mixed))}`);
      assert(JSON.stringify(escalationCheckIds(mixed)) === JSON.stringify(['redundancy']),
        'escalationCheckIds must filter falsy entries out for any caller, not just escalationHeadline');

      // Sweep restricted to active:true -- the only condition under which any
      // call site in this file actually invokes escalationHeadline (every
      // call site gates on hasActiveEscalation first, per this function's own
      // header comment). escalationHeadline itself never reads `active` --
      // that split is intentional, so an inactive-but-checkIds-populated
      // shape is deliberately excluded here rather than asserted equal; the
      // invariant this fix establishes is narrower and exact: for any active
      // escalation, the gate says yes if and only if the headline says
      // something, regardless of how malformed checkIds is.
      const sweep = [
        { active: true, checkIds: ['direct-welcome-closing'], streak: 3 },
        { active: true, checkIds: [], streak: 1 },
        { active: true, checkIds: null, streak: 1 },
        { active: true, checkIds: undefined, streak: 1 },
        { active: true },
      ];
      for (const escalation of sweep) {
        const gated = hasActiveEscalation(escalation);
        const headlineIsBlank = escalationHeadline(escalation) === '';
        assert(gated === !headlineIsBlank,
          `hasActiveEscalation and escalationHeadline disagreed on ${JSON.stringify(escalation)}: gate=${gated}, headline blank=${headlineIsBlank}`);
      }
      // The gate must still independently reject an inactive escalation even
      // though escalationHeadline (asked directly, bypassing the gate, which
      // no real call site does) would still describe its checkIds.
      assert(hasActiveEscalation({ active: false, checkIds: ['direct-welcome-closing'], streak: 1 }) === false,
        'an inactive escalation must never gate as active, regardless of what its checkIds contain');
      assert(hasActiveEscalation(null) === false && hasActiveEscalation(undefined) === false,
        'a missing escalation must never gate as active');

      return { falsyOnlyGated: false, realEscalationStillGates: true, agreementSwept: sweep.length };
    },
  },
  {
    name: 'application dock: trimmedFromPrompt renders the stronger variant, naming that the copied prompt lacks the guidance',
    run: () => {
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      // trimmedFromPrompt is the case pasteHandoffRecord's own doc comment
      // calls out as the one path where the copied prompt text CANNOT say
      // this itself (escalationTrimmed cut the block for length) — so the
      // UI has to be the only place the guidance still reaches the person,
      // and has to say so explicitly rather than silently showing nothing
      // extra.
      const trimmedIndex = dock.indexOf('{activeRejectionEscalation.trimmedFromPrompt && (');
      assert(trimmedIndex >= 0, 'the banner must branch explicitly on trimmedFromPrompt');
      // Collapse JSX's own line-wrapping whitespace before matching prose —
      // the source wraps this sentence across lines like every other
      // paragraph in this file, so a literal-phrase match would be broken by
      // reformatting alone rather than by an actual change in meaning.
      const trimmedProse = dock.slice(trimmedIndex, trimmedIndex + 1200).replace(/\s+/g, ' ');
      assert(
        /cut from the copied prompt/i.test(trimmedProse) && /not in the text below/i.test(trimmedProse),
        'the trimmed variant must say plainly that the guidance is missing from the copied prompt text, not just repeat the ordinary banner',
      );
      // It must render INSIDE the same alert (nested under the trimmedFromPrompt
      // branch above), i.e. additive to the ordinary banner rather than a
      // silent swap — someone still needs the "which check, how many times"
      // headline even in the trimmed case.
      const bannerIndex = dock.indexOf('{activeRejectionEscalation && !activeCorrectionsRecovered && (');
      assert(bannerIndex >= 0 && bannerIndex < trimmedIndex, 'the trimmed-variant branch must live inside the main escalation banner, not replace it');
    },
  },
  {
    name: 'application dock: absent or inactive rejectionEscalation renders exactly as before this field existed',
    run: () => {
      // Every non-correction round (no corrections at all), and any cached
      // record from a build that predates this field, must produce an item
      // whose escalation UI is fully inert — no thrown error, no banner, no
      // chip ring — because activeRejectionEscalation collapses to null.
      const node = jobCard('card-1', pasteJob('job-1'));
      assert(
        applicationDockRequest({ node, handoff: handoffRecord() }).rejectionEscalation === null,
        'a non-correction round must carry a null escalation, never undefined or a stray truthy placeholder',
      );
      // An escalation object that exists but never actually fired (the main
      // process always sends active:false with an empty checkIds array for
      // "nothing qualified this round" — see pasteRejectionEscalatedIds'
      // own header) must be exactly as inert as a null one.
      const inactiveShapes = [
        { active: false, checkIds: [], streak: 0, trimmedFromPrompt: false },
        { active: true, checkIds: [], streak: 0, trimmedFromPrompt: false }, // defensive: active with nothing named
      ];
      for (const shape of inactiveShapes) {
        const item = applicationDockRequest({
          node,
          handoff: handoffRecord({ corrections: ['x'], correctionPrompt: 'y', rejectionEscalation: shape }),
        });
        // applicationDockRequest itself must pass the object through unchanged
        // (it is not this function's job to interpret active/checkIds) — the
        // inertness is NonApiAiDialog's hasActiveEscalation gate, asserted
        // below by source.
        assert(item.rejectionEscalation === shape, 'applicationDockRequest must not reinterpret the escalation object, only normalize its outer shape');
      }
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      // The gate that makes both shapes above inert on screen: requires
      // active === true AND a non-empty checkIds array, so neither
      // `{active:false,...}` nor `{active:true, checkIds:[]}` can light the
      // banner, the chip ring, or the Stuck badge.
      assert(
        dock.includes('escalation?.active === true && escalationCheckIds(escalation).length > 0'),
        'the escalation gate must reject an inactive or emptily-active payload, not just a missing one',
      );
    },
  },
  {
    name: 'application dock: correctionsRecovered threads onto dock items exactly as the handoff sent it',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      // Mirrors the shape electron/ipc/localAiApplication.js's correctionsRecovered
      // doc comment describes: set only when a restart discarded the in-memory
      // pasteCorrectionsByJob entry and this process rehydrated the count from
      // the durable rejection trace instead of ever seeing the items live.
      const recovered = {
        active: true,
        itemCount: 2,
        checkIds: ['direct-welcome-closing'],
        rejectionCount: 4,
        lastAt: '2026-09-24T08:23:19.000Z',
      };
      const item = applicationDockRequest({
        node,
        handoff: handoffRecord({ correctionsRecovered: recovered }),
      });
      assert(
        item.correctionsRecovered === recovered,
        'the dock item must carry the SAME object the handoff sent — applicationDockRequest must never recompute it',
      );

      // An ordinary round — including a live correction round in the same
      // process — never carries the field at all.
      const fresh = applicationDockRequest({
        node,
        handoff: handoffRecord({ corrections: ['x'], correctionPrompt: 'y' }),
      });
      assert(fresh.correctionsRecovered === null, 'a round with no correctionsRecovered field must normalize to null, not undefined');

      // A malformed or missing field must degrade to null rather than pass
      // through as-is, the same discipline rejectionEscalation already has.
      for (const malformed of [undefined, null, 'active', 42, true]) {
        const bad = applicationDockRequest({ node, handoff: handoffRecord({ correctionsRecovered: malformed }) });
        assert(bad.correctionsRecovered === null, `a malformed correctionsRecovered (${JSON.stringify(malformed)}) must normalize to null`);
      }

      // The broken and working variants never see a handoff at all, so they
      // must declare the same null EXPLICITLY, for shape consistency with
      // every other field applicationDockRequest's items carry.
      const broken = brokenApplicationDockRequest({ node, message: 'x' });
      const working = workingApplicationDockRequest({ node, status: 'importing' });
      assert(broken.correctionsRecovered === null, 'a broken bundle carries no recovered corrections');
      assert(working.correctionsRecovered === null, 'a working bundle carries no recovered corrections');
    },
  },
  {
    name: 'application dock: an active correctionsRecovered renders a notice naming the count and check id(s), leading over an active escalation',
    run: () => {
      // Same technique as the rejectionEscalation render-logic tests above:
      // NonApiAiDialog is never mounted by this suite, so the gate and the
      // banner are locked by asserting the exact source that produces them.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      assert(
        dock.includes('const hasActiveCorrectionsRecovered = (recovered) => recovered?.active === true;'),
        'hasActiveCorrectionsRecovered must gate on active === true alone',
      );
      assert(
        dock.includes("return `This stage already has ${itemClause} from before a restart — ${rejectionClause}${checkClause}${atClause}.`;"),
        'correctionsRecoveredSummary must assemble its sentence from itemClause/rejectionClause/checkClause/atClause',
      );

      // The panel banner: role="alert", amber (not the escalation banner's
      // red, and not a bare paragraph like the ordinary correction intro),
      // gated on activeCorrectionsRecovered, and placed above the ordinary
      // correction intro paragraph.
      const bannerIndex = dock.indexOf('{activeCorrectionsRecovered && (');
      assert(bannerIndex >= 0, 'the panel must render a block gated on activeCorrectionsRecovered');
      const bannerSlice = dock.slice(bannerIndex, bannerIndex + 2800);
      assert(bannerSlice.includes('role="alert"'), 'the correctionsRecovered notice must be role="alert", not a passive status region');
      assert(bannerSlice.includes('border-amber-400/40'), 'the correctionsRecovered notice must use amber, distinct from the escalation banner\'s red');
      assert(bannerSlice.includes('Corrections carried over from before a restart'), 'the notice must name what it is plainly');
      assert(bannerSlice.includes('{correctionsRecoveredSummary(activeCorrectionsRecovered)}'), 'the notice must print the rejection-count/check-id summary sentence');
      assert(
        /self-contained version meant for a NEW chat/.test(bannerSlice.replace(/\s+/g, ' ')),
        'the notice must state plainly that the shown prompt is the self-contained one meant for a new chat',
      );
      const introIndex = dock.indexOf('The previous answer did not validate');
      assert(introIndex > bannerIndex, 'the correctionsRecovered notice must render before the ordinary correction intro paragraph, not after it');

      // The two notices must not stack: the escalation banner's own gate must
      // now also exclude an active correctionsRecovered, so a round where the
      // main process somehow set both never prints the same rejection count
      // and check id(s) twice in two colors.
      assert(
        dock.includes('{activeRejectionEscalation && !activeCorrectionsRecovered && ('),
        'the escalation banner must be gated OFF when correctionsRecovered is active, so the two notices never stack',
      );
    },
  },
  {
    name: 'application dock: correctionsRecoveredSummary never renders a blank check-id claim for falsy-only, non-array, or empty checkIds',
    run: () => {
      // Executes the real gate/summary logic (not just a string match) by
      // pulling the verbatim const declarations out of the component source
      // and evaluating them — same technique the escalation agreement test
      // above uses. Proves directly that an empty or falsy-only checkIds
      // never produces a dangling "on check """ style clause, the exact bug
      // class this session's audit found in a sibling helper.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const start = dock.indexOf('const correctionsRecoveredCheckIds = (recovered) => (');
      assert(start >= 0, 'could not locate the correctionsRecoveredCheckIds declaration to extract -- has it been renamed?');
      const end = dock.indexOf('\n};', dock.indexOf('const correctionsRecoveredSummary = (recovered) => {', start));
      assert(end > start, 'could not find correctionsRecoveredSummary\'s closing brace to bound the extracted source');
      const body = dock.slice(start, end + 3);
      const {
        correctionsRecoveredCheckIds, hasActiveCorrectionsRecovered, correctionsRecoveredSummary,
      } = new Function(
        `${body}\nreturn { correctionsRecoveredCheckIds, hasActiveCorrectionsRecovered, correctionsRecoveredSummary };`,
      )();

      // checkIds absent, not an array, empty, or holding only falsy entries —
      // every shape the task calls out by name. `active` still gates true in
      // every case: unlike rejectionEscalation, an empty checkIds list does
      // NOT disqualify correctionsRecovered (the contract documents it as
      // "may be empty" — see hasActiveCorrectionsRecovered's own header).
      const blankShapes = [
        { active: true, itemCount: 3, rejectionCount: 4 }, // checkIds absent entirely
        { active: true, itemCount: 3, rejectionCount: 4, checkIds: null },
        { active: true, itemCount: 3, rejectionCount: 4, checkIds: 'direct-welcome-closing' }, // not an array
        { active: true, itemCount: 3, rejectionCount: 4, checkIds: [] },
        { active: true, itemCount: 3, rejectionCount: 4, checkIds: [''] },
        { active: true, itemCount: 3, rejectionCount: 4, checkIds: [null, undefined, 0, false] },
      ];
      for (const shape of blankShapes) {
        assert(hasActiveCorrectionsRecovered(shape) === true, `active:true must still gate active regardless of checkIds shape (${JSON.stringify(shape)})`);
        assert(JSON.stringify(correctionsRecoveredCheckIds(shape)) === '[]', `a falsy-only/absent/non-array checkIds (${JSON.stringify(shape.checkIds)}) must filter to []`);
        const summary = correctionsRecoveredSummary(shape);
        assert(!/on check/.test(summary) && !/on checks/.test(summary), `a blank checkIds must never render a "on check(s)" clause, got ${JSON.stringify(summary)}`);
        assert(!/""/.test(summary) && !summary.includes('check "'), `a blank checkIds must never leave a dangling empty-quoted name, got ${JSON.stringify(summary)}`);
        assert(/^This stage already has 3 outstanding correction items from before a restart — rejected 4 times in a row\.$/.test(summary),
          `the itemCount/rejectionCount clauses must still render for a blank-checkIds shape, got ${JSON.stringify(summary)}`);
      }

      // A real, named checkIds (single and plural) must still render the
      // clause correctly, and a mixed falsy/real array must name only the
      // real id(s) — the same agreement invariant escalationCheckIds already
      // has to hold.
      const single = correctionsRecoveredSummary({ active: true, itemCount: 1, rejectionCount: 1, checkIds: ['direct-welcome-closing'] });
      assert(single.includes('on check "direct-welcome-closing"'), `a single real checkIds entry must be named, got ${JSON.stringify(single)}`);
      const plural = correctionsRecoveredSummary({ active: true, itemCount: 2, rejectionCount: 2, checkIds: ['a', 'b'] });
      assert(plural.includes('on checks "a", "b"'), `multiple real checkIds entries must all be named, got ${JSON.stringify(plural)}`);
      const mixed = correctionsRecoveredSummary({ active: true, itemCount: 1, rejectionCount: 1, checkIds: ['', 'redundancy', null] });
      assert(mixed.includes('on check "redundancy"') && !mixed.includes('""'), `a mixed array must name only the real id(s), got ${JSON.stringify(mixed)}`);

      // Missing/non-finite itemCount and rejectionCount must degrade their
      // own clause without throwing and without blocking the rest of the
      // sentence — the same "one clause degrades, the rest survives" rule
      // the header comment states.
      const noCounts = correctionsRecoveredSummary({ active: true, checkIds: ['x'] });
      assert(
        noCounts === 'This stage already has outstanding corrections from before a restart — rejected before this restart on check "x".',
        `missing itemCount/rejectionCount must fall back to generic clauses without throwing, got ${JSON.stringify(noCounts)}`,
      );

      // An unparsable lastAt must omit its clause rather than render
      // "Invalid Date" or throw.
      const badDate = correctionsRecoveredSummary({ active: true, itemCount: 1, rejectionCount: 1, lastAt: 'not-a-date' });
      assert(!/Invalid Date/.test(badDate) && !/most recently at/.test(badDate), `an unparsable lastAt must omit its clause entirely, got ${JSON.stringify(badDate)}`);
      const goodDate = correctionsRecoveredSummary({ active: true, itemCount: 1, rejectionCount: 1, lastAt: '2026-09-24T08:23:19.000Z' });
      assert(/most recently at/.test(goodDate), `a well-formed ISO lastAt must render its clause, got ${JSON.stringify(goodDate)}`);

      // hasActiveCorrectionsRecovered must reject everything that is not
      // exactly active:true, without throwing on a non-object.
      for (const inactive of [null, undefined, {}, { active: false }, { active: 'true' }, 'active', 42]) {
        assert(hasActiveCorrectionsRecovered(inactive) === false, `only an object with active===true may gate active, got ${JSON.stringify(inactive)} gated true`);
      }
    },
  },
  {
    name: 'application dock: absent, undefined, or malformed correctionsRecovered — and every non-application request — renders exactly as today',
    run: () => {
      const node = jobCard('card-1', pasteJob('job-1'));
      // applicationDockRequest's own normalization, re-asserted here in the
      // same shape the render gate reads it in: undefined/null/a stray
      // primitive must all collapse to the same null the field's total
      // absence produces, so NonApiAiDialog's gate sees one inert value no
      // matter which of these a caller (or an older cached record) sends.
      for (const malformed of [undefined, null, {}, { active: false }, 'x', 7]) {
        const item = applicationDockRequest({ node, handoff: handoffRecord({ correctionsRecovered: malformed }) });
        if (malformed && typeof malformed === 'object') {
          // applicationDockRequest only normalizes the OUTER shape (object or
          // not); an object with active:false is passed through unchanged,
          // exactly as rejectionEscalation's own equivalent case works —
          // inertness for that shape is NonApiAiDialog's gate, not this
          // function's job to interpret.
          assert(item.correctionsRecovered === malformed, `an object-shaped correctionsRecovered (${JSON.stringify(malformed)}) must pass through unchanged, not be reinterpreted`);
        } else {
          assert(item.correctionsRecovered === null, `a non-object correctionsRecovered (${JSON.stringify(malformed)}) must normalize to null`);
        }
      }

      // The render gate itself: isApplicationRequest must be checked first,
      // so a non-application request (kind !== 'application') never even
      // reads request.correctionsRecovered, let alone renders a notice for
      // it — the same guard order activeRejectionEscalation already uses.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(
        dock.includes('const activeCorrectionsRecovered = isApplicationRequest && hasActiveCorrectionsRecovered(activeRequest?.correctionsRecovered)'),
        'activeCorrectionsRecovered must gate on isApplicationRequest before ever reading the field, so a non-application request renders unchanged',
      );
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
  {
    name: 'application dock: an item the ChatGPT bridge already holds renders "Handed to ChatGPT" instead of the copy/paste workflow, and an unheld item is unaffected',
    run: () => {
      // A source-substring check, the same convention this file already uses
      // for the render gate above (see "the render gate itself" test just
      // above): mounting this component is impractical here, so the render
      // ternary's own text is the closest available proof of which branch
      // shows what.
      const dock = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');

      // The dock must read bridge status off the existing hook — the same one
      // HandoffBridgePanel already uses — never a new IPC channel of its own.
      assert(
        dock.includes("import { useHandoffBridgeStatus } from '../hooks/useHandoffBridgeStatus';"),
        'the dock must read bridge status via the existing useHandoffBridgeStatus hook',
      );

      // The gate itself: scoped to application requests only (a push item's
      // jobId, if any, must never be compared against the bridge's queue),
      // and defensive against a missing or malformed queue/jobs shape —
      // bridge disabled, preload still connecting, or an older main process
      // — so it degrades to "not held" instead of throwing.
      // The rule itself lives in src/utils/bridgeHeldApplication.js (shared with
      // the job card, unit-tested below): guarded by isApplicationRequest here,
      // and defensive there about a missing or malformed queue/jobs shape.
      assert(
        dock.includes('const isBridgeHeldApplication = isApplicationRequest && isBridgeHeldJob(bridgeStatus, activeRequest?.jobId);')
        && dock.includes("from '../utils/bridgeHeldApplication'"),
        'isBridgeHeldApplication must gate on isApplicationRequest first, then use the shared held rule',
      );
      const heldRule = readFileSync(new URL('../../src/utils/bridgeHeldApplication.js', import.meta.url), 'utf8');
      assert(
        heldRule.includes('Array.isArray(jobs)')
        && heldRule.includes('job?.jobId === jobId && BRIDGE_WORKING_PHASES.has(job?.phase)')
        && heldRule.includes("new Set(['unread', 'awaiting', 'host'])"),
        'the shared held rule must read status.queue.jobs defensively in the three lane phases',
      );

      // Isolate the bridge-held branch's own markup from its two neighbors:
      // applicationWorkingState's branch before it, and the ordinary
      // copy/paste fragment after it.
      const heldStart = dock.indexOf(') : isBridgeHeldApplication ? (');
      assert(heldStart >= 0, 'the render ternary must add a isBridgeHeldApplication branch');
      const unheldMarker = ') : (\n            <>';
      const unheldStart = dock.indexOf(unheldMarker, heldStart);
      assert(unheldStart > heldStart, 'the bridge-held branch must sit before the ordinary copy/paste fragment, not replace it');
      const heldBlock = dock.slice(heldStart, unheldStart);
      const unheldEnd = dock.indexOf('</form>', unheldStart);
      assert(unheldEnd > unheldStart, 'the ordinary copy/paste fragment must still close the same form');
      const unheldBlock = dock.slice(unheldStart, unheldEnd);

      // Held: a calm status line, and only the one control this dock still
      // owns for such an item — Discard bundle. No prompt box, no paste box,
      // no Submit response, no Copy prompt.
      assert(heldBlock.includes('Handed to ChatGPT') && !heldBlock.includes('Working in ChatGPT'),
        'a bridge-held application item must show the "Handed to ChatGPT" state, a headline true before any chat has started');
      assert(!/paste/i.test(heldBlock.slice(heldBlock.indexOf('role="status"'), heldBlock.indexOf('Discard bundle'))),
        'the held status box must not mention pasting: BridgeProgress beneath it owns any paste instruction');
      assert(dock.includes('{activeRequest?.handoffCode && !isBridgeHeldApplication && ('),
        'the header handoff-code chip belongs to the copy/paste flow and must be hidden for a bridge-held application');
      assert(heldBlock.includes('Discard bundle') && heldBlock.includes('requestApplicationDiscardConfirm'),
        'a bridge-held application item must still offer Discard bundle');
      // Live progress renders beside the calm status line, not inside its live
      // region: the elapsed timers tick every second and must not re-announce.
      assert(heldBlock.includes('<BridgeProgress status={bridgeStatus} item={activeRequest} />')
        && dock.includes("import { BridgeProgress } from './BridgeProgress';")
        && heldBlock.indexOf('<BridgeProgress') > heldBlock.lastIndexOf('</div>') - 200
        && heldBlock.indexOf('<BridgeProgress') > heldBlock.indexOf('Discard bundle'),
      'a bridge-held application item must render BridgeProgress after (outside) the status block');
      assert(
        !heldBlock.includes('Paste AI response')
        && !heldBlock.includes('id="non-api-ai-response"')
        && !heldBlock.includes('id="non-api-ai-prompt"')
        && !heldBlock.includes('Submit response')
        && !heldBlock.includes('Copy prompt'),
        'a bridge-held application item must not render the prompt textarea, the paste textarea, Submit response, or Copy prompt',
      );

      // Unheld (and every push item, which can never reach this ternary
      // branch at all): today's exact copy/paste workflow, untouched.
      assert(
        unheldBlock.includes('id="non-api-ai-prompt"')
        && unheldBlock.includes('id="non-api-ai-response"')
        && unheldBlock.includes('Paste AI response')
        && unheldBlock.includes('Submit response')
        && unheldBlock.includes('Copy prompt'),
        'an application item the bridge does not hold, and every push item, must keep rendering the prompt box, the paste box, Submit response and Copy prompt',
      );
    },
  },
];

// ---- bridge job progress (src/utils/bridgeJobProgress.js) -------------------
const PROGRESS_NOW = 1_700_000_000_000;
// A job the current chat holds AND is answering (the engine's per-job proof). A
// job with servedToChat: null was never handed over, so it is not awaited either.
const progressJob = (extra = {}) => ({
  jobId: '11111111-1111-4111-8111-111111111111', phase: 'awaiting', stage: 'resume', reason: null, servedToChat: 1, changedAt: PROGRESS_NOW - 600000,
  servedAt: extra.servedToChat === null ? null : PROGRESS_NOW - 120000, answeredAt: null, awaitingAnswer: extra.servedToChat !== null, stalled: false, stalledSince: null, ...extra,
});
// The same job after ChatGPT's answer was accepted and the next stage is not served yet.
const answeredJob = (extra = {}) => progressJob({ awaitingAnswer: false, servedAt: null, answeredAt: PROGRESS_NOW - 30000, ...extra });
const progressChat = (extra = {}) => ({
  ordinal: 1, state: 'working', startedAt: PROGRESS_NOW - 300000, firstCallAt: PROGRESS_NOW - 290000, lastCallAt: PROGRESS_NOW - 20000, lastCallKind: 'get', calls: 3, jobsAssigned: 1, jobsCap: 2,
  outstanding: { servedAt: PROGRESS_NOW - 120000, kind: 'application', stage: 'resume', task: null, stalled: false, stalledSince: null, stallsLastHour: 0 }, ...extra,
});
const progress = (input = {}) => deriveBridgeJobProgress({ job: progressJob(), chat: progressChat(), item: { stage: 'resume', corrections: [] }, now: PROGRESS_NOW, ...input });
const stepStates = view => view.steps.map(step => step.state).join(',');

const bridgeJobProgressTests = [
  {
    name: 'bridge progress: the four steps carry the dock\'s own stage labels and mark done / current / upcoming',
    run: () => {
      const view = progress();
      assert(view.steps.map(step => step.key).join() === PROGRESS_STAGES.join(), 'the stepper must list the four stages in order');
      assert(view.steps.every(step => step.label === applicationStageLabel(step.key)), 'step labels must be the dock\'s STAGE_LABELS');
      assert(stepStates(view) === 'done,current,upcoming,upcoming', `resume must be the current step: ${stepStates(view)}`);
      assert(stepStates(progress({ job: progressJob({ stage: 'review' }) })) === 'done,done,done,current', 'review current means three done');
      assert(stepStates(progress({ job: progressJob({ stage: null }), item: {} })) === 'upcoming,upcoming,upcoming,upcoming', 'an unknown stage must not invent progress');
    },
  },
  {
    name: 'bridge progress: needs_user is a problem that names the reason in the existing copy, and held is attention',
    run: () => {
      const needs = progress({ job: progressJob({ phase: 'needs_user', reason: 'write_failed' }) });
      assert(needs.tone === 'problem' && needs.headline === BRIDGE_PROGRESS_COPY.needsYou, 'needs_user is a problem headline');
      assert(needs.detail === 'The app could not save this answer.', `reason copy must come from JOB_ROW_COPY without the row prefix or "See the dock": ${needs.detail}`);
      assert(needs.since === PROGRESS_NOW - 600000, 'a stopped job times itself from changedAt');
      const capped = progress({ job: progressJob({ phase: 'held', reason: 'rejection_cap' }) });
      assert(capped.tone === 'attention' && capped.headline === BRIDGE_PROGRESS_COPY.needsYou && capped.detail.includes('rejected too many times'), 'a cap hold that needs the person is attention with its reason');
      const kept = progress({ job: progressJob({ phase: 'held', reason: 'user_hold' }) });
      assert(kept.tone === 'attention' && kept.headline === 'Kept for you' && kept.detail === BRIDGE_PROGRESS_COPY.kept, 'a user hold explains how to hand the job back');
      const answered = progress({ job: progressJob({ phase: 'held', reason: 'answered_in_dock' }) });
      assert(answered.headline === 'Answered here; ChatGPT stopped serving it', 'the answered-in-dock hold reuses the row copy');
      const unknownReason = progress({ job: progressJob({ phase: 'needs_user', reason: 'constructor' }) });
      assert(unknownReason.detail === BRIDGE_PROGRESS_COPY.needsYouFallback, 'a reason with no copy (even an Object.prototype key) must fall back, never render a function');
      const restart = progress({ job: progressJob({ phase: 'held', reason: 'restart' }) });
      assert(restart.action === 'start-chat' && restart.headline === 'Confirm to restart', 'a restart hold is resolved by starting a chat');
      assert(progress({ job: progressJob({ phase: 'needs_user', reason: 'job_broken', stalled: true }) }).kind === 'needs_user', 'needs_user outranks stalled');
    },
  },
  {
    name: 'bridge progress: stalled reuses the BRIDGE stalled copy and offers a new chat',
    run: () => {
      // stalledSince is when the quiet began, so a job stalled for 4 minutes past the threshold was served 4 minutes ago.
      const stalledJob = progressJob({ servedAt: PROGRESS_NOW - 4 * 60000, stalled: true, stalledSince: PROGRESS_NOW - 4 * 60000 });
      const view = progress({ job: stalledJob });
      assert(view.kind === 'stalled' && view.tone === 'attention' && view.action === 'start-chat', 'stalled is attention with a start-chat action');
      assert(view.headline === 'ChatGPT has been quiet for 4 min', view.headline);
      assert(view.detail.includes('was given résumé 4 min ago') && view.detail.includes('start a fresh chat'), 'stalled detail must be the shared BRIDGE copy');
      assert(view.since === PROGRESS_NOW - 4 * 60000 && view.lastHeard === PROGRESS_NOW - 20000, 'stalled times from stalledSince and reports the last call');
      // The stall is the JOB's, not the chat's: another lane's stall never becomes this job's.
      const otherLaneStalled = { outstanding: { ...progressChat().outstanding, stalled: true, stalledSince: PROGRESS_NOW - 4 * 60000 } };
      assert(progress({ chat: progressChat(otherLaneStalled) }).kind === 'writing', 'the chat\'s outstanding lane being stalled says nothing about a job that is not');
      assert(progress({ job: progressJob({ servedToChat: null }), chat: progressChat(otherLaneStalled) }).kind === 'queued', 'a job this chat was never handed is not the stalled one');
      assert(progress({ job: answeredJob({ stalled: true, stalledSince: PROGRESS_NOW - 4 * 60000 }) }).kind === 'queued', 'a job whose answer was accepted is not stalled, whatever stale flag rode along');
      for (const state of ['ended', 'idle', 'full', 'awaiting-first-call']) {
        assert(progress({ job: stalledJob, chat: progressChat({ state }) }).kind === 'stalled', `an awaited, stalled job is stalled even when the chat is ${state}`);
      }
      assert(progress({ job: stalledJob, chat: { ordinal: 0, state: 'none' } }).kind === 'stalled', 'an awaited, stalled job is stalled even when there is no chat');
      assert(progress({ job: progressJob({ phase: 'unread', stalled: true }), chat: progressChat(otherLaneStalled) }).kind === 'unread', 'an unread job was never served, so another lane\'s stall is not its stall');
      const anchoredOnServe = progress({ job: progressJob({ stalled: true, stalledSince: null }) });
      assert(anchoredOnServe.kind === 'stalled' && anchoredOnServe.since === PROGRESS_NOW - 120000, 'with no stalledSince the job\'s own servedAt anchors the stall');
    },
  },
  {
    name: 'bridge progress: no chat, awaiting-first-call, full and ended each tell the person what to press',
    run: () => {
      const none = progress({ job: progressJob({ servedToChat: null }), chat: { ordinal: 0, state: 'none' } });
      assert(none.kind === 'no-chat' && none.action === 'start-chat' && none.actionLabel === 'Copy chat starter' && none.tone === 'attention', 'no chat -> start-chat');
      const first = progress({ job: progressJob({ servedToChat: null }), chat: progressChat({ state: 'awaiting-first-call', calls: 0, lastCallAt: null }) });
      assert(first.kind === 'first-call' && first.headline === 'Waiting for chat 1' && first.action === 'start-chat' && first.actionLabel === 'Copy starter', 'awaiting-first-call uses the panel\'s Copy starter label');
      assert(first.lastHeard === null, 'a chat that has never called has nothing to report as last heard');
      const full = progress({ job: progressJob({ servedToChat: null }), chat: progressChat({ state: 'full' }) });
      assert(full.kind === 'chat-full' && full.action === 'start-chat' && full.headline === 'Start a new chat', 'a full chat that was never handed this job needs a new chat');
      assert(full.lastHeard === PROGRESS_NOW - 20000, 'a full chat reports its last call');
      const ended = progress({ chat: progressChat({ state: 'ended' }) });
      assert(ended.kind === 'chat-ended' && ended.action === 'continue-chat' && ended.actionLabel === 'Copy Continue' && ended.detail.includes('Copy Continue and paste it into it'), 'an ended chat is continued');
      assert(ended.lastHeard === PROGRESS_NOW - 20000, 'an ended chat reports its last call');
      assert(progress({ chat: { ordinal: 0, state: 'working' }, job: progressJob({ servedToChat: null }) }).kind === 'no-chat', 'a chat with no ordinal is not a chat');
      assert(progress({ chat: progressChat({ state: 'idle' }) }).action === 'continue-chat', 'an idle chat with a waiting job is continued');
      assert(progress({ chat: progressChat({ state: 'full' }), job: progressJob({ phase: 'host' }) }).action === null, 'app-side work never asks for a chat');
    },
  },
  {
    name: 'bridge progress: a job released after ChatGPT was told to stop leads with Copy Continue, not "Not read yet"',
    run: () => {
      const unread = progress({ job: progressJob({ phase: 'unread', servedToChat: null }), chat: progressChat({ state: 'idle' }) });
      assert(unread.kind === 'chat-ended' && unread.action === 'continue-chat' && unread.actionLabel === 'Copy Continue' && unread.tone === 'attention', `an unread job in an idle chat must offer Copy Continue, got ${unread.kind}/${unread.action}`);
      assert(unread.headline === 'Waiting for ChatGPT' && unread.detail.includes('Copy Continue and paste it into it'), 'it says what to do');
      assert(unread.lastHeard === PROGRESS_NOW - 20000, 'and when the chat was last heard');
      // A working chat still describes an unread job as not read yet, and app-side work is unchanged.
      assert(progress({ job: progressJob({ phase: 'unread', servedToChat: null }), chat: progressChat({ state: 'working' }) }).kind === 'unread', 'a chat that is still calling will read it');
      const host = progress({ job: progressJob({ phase: 'host' }), chat: progressChat({ state: 'idle' }) });
      assert(host.kind === 'host' && host.action === null, 'the app saving a job is true whatever the chat is doing');
    },
  },
  {
    name: 'bridge progress: a full chat that already holds this job is still working on it, with a weaker note and no Start-a-new-chat button',
    run: () => {
      const view = progress({ chat: progressChat({ state: 'full' }) });
      assert(view.kind === 'writing' && view.headline === 'ChatGPT is working on: Résumé', `a served job in a full chat can still be answered: ${view.kind} ${view.headline}`);
      assert(view.action === null && view.actionLabel === null, 'the person must not be told to abandon a chat that is mid-answer');
      assert(view.detail.includes(BRIDGE_PROGRESS_COPY.chatFullNote) && view.detail.includes('has not arrived yet'), `the detail carries the limit note: ${view.detail}`);
      assert(!view.detail.includes('work limit'), 'the full-chat headline copy must not leak into a served job');
      const fixing = progress({ chat: progressChat({ state: 'full' }), item: { stage: 'resume', corrections: ['a'] } });
      assert(fixing.kind === 'fixing' && fixing.detail.includes(BRIDGE_PROGRESS_COPY.chatFullNote) && fixing.action === null, 'a correction round in a full chat gets the same note');
      assert(!progress().detail.includes(BRIDGE_PROGRESS_COPY.chatFullNote), 'a chat with room says nothing about a limit');
    },
  },
  {
    name: 'bridge progress: queued vs served-and-waiting, and a chat at its bundle limit',
    run: () => {
      const queued = progress({ job: progressJob({ servedToChat: null }) });
      assert(queued.kind === 'queued' && queued.tone === 'working' && queued.headline === 'Queued for ChatGPT' && queued.since === null, 'not yet served -> queued, no invented timer');
      assert(queued.detail.includes('résumé step'), 'queued names the step');
      const capped = progress({ job: progressJob({ servedToChat: null }), chat: progressChat({ jobsAssigned: 2, jobsCap: 2 }) });
      assert(capped.headline === 'Queued for the next chat' && capped.detail.includes('limit of 2 bundles'), 'a chat at its limit hands this job over in a later chat');
      const writing = progress();
      assert(writing.kind === 'writing' && writing.tone === 'working' && writing.headline === 'ChatGPT is working on: Résumé', writing.headline);
      assert(writing.detail.includes('has not arrived yet') && writing.lastHeard === PROGRESS_NOW - 20000, 'served -> waiting for the answer with the last call');
      assert(writing.since === PROGRESS_NOW - 120000, 'the hand-over time is this job\'s own servedAt');
      // Per-job proof: none of the chat-level guesses matter any more.
      assert(progress({ chat: progressChat({ jobsAssigned: 2 }) }).since === PROGRESS_NOW - 120000, 'with several jobs in the chat the job\'s own servedAt is still exact');
      assert(progress({ chat: progressChat({ outstanding: null }) }).kind === 'writing', 'the chat-level outstanding lane is not consulted');
      assert(progress({ chat: progressChat({ outstanding: { ...progressChat().outstanding, servedAt: PROGRESS_NOW - 900000, stage: 'cover-letter', kind: 'push' } }) }).since === PROGRESS_NOW - 120000, 'another lane\'s outstanding entry never changes this job\'s timer');
      // Served (it holds a slot) is not the same as being answered: the answer was accepted, the next stage is not served yet.
      const between = progress({ job: answeredJob({ stage: 'cover-letter' }) });
      assert(between.kind === 'queued' && between.headline === 'Queued for ChatGPT' && between.since === null && !/working on/.test(between.headline),
        `an accepted answer with the next stage not yet served must not read as "ChatGPT is working": ${between.kind} ${between.headline}`);
      assert(between.detail.includes('cover letter step'), 'and names the step that is ready');
      assert(progress({ job: answeredJob(), chat: progressChat({ jobsAssigned: 2, jobsCap: 2 }) }).headline === 'Queued for ChatGPT', 'a job that already holds a slot is never told it waits for a later chat');
      assert(progress({ job: progressJob({ awaitingAnswer: false, servedAt: null }), item: { stage: 'resume', corrections: ['a'] } }).kind === 'queued', 'corrections are only "being fixed" while the answer is actually awaited');
    },
  },
  {
    name: 'bridge progress: unread and host are app-side, and the bridge being paused overrides waiting',
    run: () => {
      const unread = progress({ job: progressJob({ phase: 'unread', servedToChat: null }) });
      assert(unread.kind === 'unread' && unread.tone === 'neutral' && unread.headline === 'Not read yet' && unread.action === null, 'unread is not read yet: nothing reads it until ChatGPT asks');
      assert(!/reading|nothing is needed/i.test(`${unread.headline} ${unread.detail}`), `unread must not claim the app is reading it or that nothing is needed: ${unread.detail}`);
      const host = progress({ job: progressJob({ phase: 'host', stage: null }), item: {} });
      assert(host.kind === 'host' && host.tone === 'working' && host.headline === 'The app is saving this' && host.detail === 'The app is building the documents.', `host claims only the app-side work: ${host.detail}`);
      assert(stepStates(host) === 'upcoming,upcoming,upcoming,upcoming', 'host cannot prove ChatGPT answered every stage, so it must not mark them done');
      assert(stepStates(progress({ job: progressJob({ phase: 'host', stage: 'review' }) })) === 'done,done,done,current', 'host with a known stage marks that stage, not everything');
      assert(!/ChatGPT/.test(host.detail), 'host detail must not credit ChatGPT');
      const paused = progress({ bridge: { paused: true } });
      assert(paused.tone === 'attention' && paused.headline === 'Paused', 'a paused bridge serves nothing, so the job must not read as being written');
      const pausedHost = progress({ bridge: { paused: true }, job: progressJob({ phase: 'host' }) });
      assert(pausedHost.kind === 'host' && pausedHost.headline === 'The app is saving this' && pausedHost.tone === 'working', 'a pause does not change app-side saving');
      const pausedNeeds = progress({ bridge: { paused: true }, job: progressJob({ phase: 'needs_user', reason: 'write_failed' }) });
      assert(pausedNeeds.kind === 'needs_user' && pausedNeeds.tone === 'problem' && pausedNeeds.headline === 'This job needs you', 'a problem the person must fix outranks the pause');
      const pausedHeld = progress({ bridge: { paused: true }, job: progressJob({ phase: 'held', reason: 'user_hold' }) });
      assert(pausedHeld.kind === 'held' && pausedHeld.headline === 'Kept for you', 'a held job says why it is held, not just Paused');
      const pausedUnread = progress({ bridge: { paused: true }, job: progressJob({ phase: 'unread' }) });
      assert(pausedUnread.kind === 'unread' && pausedUnread.headline === 'Paused' && pausedUnread.tone === 'attention', 'a paused bridge reads nothing either, so Paused wins over not-read-yet');
      assert(progress({ bridge: { paused: true }, job: progressJob({ phase: 'done' }) }).kind === 'done', 'a finished job is not paused');
    },
  },
  {
    name: 'bridge progress: an unread job names what to press before it says anything else',
    run: () => {
      const unreadJob = progressJob({ phase: 'unread', servedToChat: null });
      const none = progress({ job: unreadJob, chat: { ordinal: 0, state: 'none' } });
      assert(none.kind === 'no-chat' && none.action === 'start-chat' && none.headline === 'No ChatGPT chat yet', 'an unread job with no chat is resolved by starting one');
      assert(none.detail === 'Press Copy chat starter, then paste it into a new ChatGPT chat with the Infinite Canvas plugin selected.',
        'the no-chat line names the button that copies the starter, then the one paste it owes');
      const first = progress({ job: unreadJob, chat: progressChat({ state: 'awaiting-first-call', calls: 0, lastCallAt: null }) });
      assert(first.kind === 'first-call' && first.action === 'start-chat' && first.actionLabel === 'Copy starter', 'an unread job in a chat that has not called yet is waiting for that first call');
      for (const state of ['working', 'full', 'ended']) {
        const view = progress({ job: unreadJob, chat: progressChat({ state }) });
        assert(view.kind === 'unread' && view.headline === 'Not read yet' && view.action === null, `an unread job with a ${state} chat says only that it is not read yet`);
      }
      // 'idle' is the exception: ChatGPT was told to stop, so it will not read this job until Continue (see the idle test below).
      assert(progress({ job: unreadJob, chat: progressChat({ state: 'idle' }) }).action === 'continue-chat', 'an unread job behind an idle chat is continued');
      assert(progress({ job: unreadJob, chat: { state: 'unknown', ordinal: 1 } }).kind === 'unread', 'an unreadable chat state does not change what an unread job proves');
      assert(progress({ job: unreadJob, chat: null }).kind === 'unread', 'a missing chat does not change it either');
      // Two jobs, one chat: B stays unread while A is outstanding, and is not "being read".
      const second = progress({ job: unreadJob, chat: progressChat({ jobsAssigned: 1 }) });
      assert(second.kind === 'unread' && !/reading/i.test(second.detail), 'a job queued behind another is waiting its turn, not being read');
    },
  },
  {
    name: 'bridge progress: a correction round reports the issue count and only proven escalation',
    run: () => {
      const view = progress({ item: { stage: 'resume', corrections: ['a', 'b', 'c'], rejectionEscalation: null } });
      assert(view.kind === 'fixing' && view.headline === 'ChatGPT is fixing 3 issues' && view.tone === 'working', view.headline);
      assert(view.detail.includes('last résumé') && !/round/i.test(view.detail), 'no round number is invented: the job revision does not advance on a rejection');
      const one = progress({ item: { stage: 'resume', corrections: ['a'] } });
      assert(one.headline === 'ChatGPT is fixing 1 issue' && one.detail.includes('an issue'), 'singular wording');
      const escalated = progress({ item: { stage: 'resume', corrections: ['a'], rejectionEscalation: { active: true, streak: 3, checkIds: ['x'] } } });
      assert(escalated.detail.includes('The same check has now failed 3 times in a row.'), 'an active escalation states its streak');
      assert(!progress({ item: { stage: 'resume', corrections: ['a'], rejectionEscalation: { active: false, streak: 3 } } }).detail.includes('in a row'), 'an inactive escalation is not reported');
      assert(progress({ job: progressJob({ servedToChat: null }), item: { corrections: ['a'] } }).kind === 'queued', 'corrections only matter once the chat holds the job');
    },
  },
  {
    name: 'bridge progress: small branches that must not drift (push lane, streak floor, empty corrections, unknown stage, item stage, held reason keys)',
    run: () => {
      const push = progress({ chat: progressChat({ outstanding: { ...progressChat().outstanding, kind: 'push', stage: null } }) });
      assert(push.kind === 'writing' && push.since === PROGRESS_NOW - 120000, 'a push lane being outstanding does not change this job\'s own hand-over time');
      assert(progress({ job: progressJob({ servedAt: null }) }).since === null, 'a job with no servedAt claims no timer');
      const oneStreak = progress({ item: { stage: 'resume', corrections: ['a'], rejectionEscalation: { active: true, streak: 1 } } });
      assert(!oneStreak.detail.includes('in a row'), 'a streak of one is not a streak');
      assert(progress({ item: { stage: 'resume', corrections: ['a'], rejectionEscalation: { active: true, streak: 2 } } }).detail.includes('failed 2 times in a row'), 'a streak of two is reported');
      const blank = progress({ item: { stage: 'resume', corrections: ['', null, undefined] } });
      assert(blank.kind === 'writing', 'empty correction entries are not issues');
      assert(progress({ item: { stage: 'resume', corrections: ['', 'real'] } }).headline === 'ChatGPT is fixing 1 issue', 'only real correction entries are counted');
      const unknownStage = progress({ job: progressJob({ stage: null }), item: {} });
      assert(unknownStage.kind === 'writing' && unknownStage.headline === 'ChatGPT is working on this' && !unknownStage.headline.includes('undefined'), `an unknown stage gets the stage-less line: ${unknownStage.headline}`);
      assert(stepStates(progress({ job: progressJob({ stage: null }), item: { stage: 'review' } })) === 'done,done,done,current', 'the dock item\'s stage is used when the bridge job has none');
      const heldConstructor = progress({ job: progressJob({ phase: 'held', reason: 'constructor' }) });
      assert(heldConstructor.headline === 'Kept for you' && typeof heldConstructor.detail === 'string', 'a held reason that is an Object.prototype key must fall back, never render a function');
      const queued = progress({ job: progressJob({ servedToChat: null }) });
      assert(queued.lastHeard === PROGRESS_NOW - 20000, 'a queued job reports the chat\'s last call');
    },
  },
  {
    name: 'bridge progress: done and gone are terminal and quiet',
    run: () => {
      const done = progress({ job: progressJob({ phase: 'done' }) });
      assert(done.kind === 'done' && done.tone === 'neutral' && done.headline === 'Saved' && stepStates(done) === 'done,done,done,done' && done.action === null && done.lastHeard === null, 'done is all steps complete');
      const gone = progress({ job: progressJob({ phase: 'gone' }) });
      assert(gone.kind === 'gone' && gone.headline === 'Discarded' && stepStates(gone) === 'done,current,upcoming,upcoming', 'gone must not claim completion');
    },
  },
  {
    name: 'bridge progress: malformed and unknown input degrades to a neutral generic line and never throws',
    run: () => {
      const hostile = [undefined, null, 7, 'x', [], {}, { job: null }, { job: { phase: 'nonsense' } }, { job: { phase: 'unknown' } },
        { job: progressJob(), chat: null }, { job: progressJob(), chat: { state: 'bogus' } }, { job: progressJob(), chat: { state: 'unknown', ordinal: 1 } },
        { job: progressJob(), chat: { state: 'working', ordinal: 'x', outstanding: 5 }, item: { corrections: 'nope', rejectionEscalation: 9 }, now: 'later' },
        { job: progressJob({ stage: { toString() { throw new Error('boom'); } } }), chat: progressChat() },
        { job: new Proxy({}, { get() { throw new Error('boom'); } }) }];
      for (const input of hostile) {
        let view;
        try { view = deriveBridgeJobProgress(input); } catch (error) { assert(false, `deriveBridgeJobProgress threw for ${JSON.stringify(input)}: ${error.message}`); }
        assert(view.steps.length === 4 && typeof view.headline === 'string' && view.headline && typeof view.detail === 'string', 'a view model always has four steps and a headline');
        assert(['neutral', 'working', 'attention', 'problem'].includes(view.tone), 'tone stays in the closed set');
        assert(view.action === null || ['start-chat', 'continue-chat'].includes(view.action), 'action stays in the closed set');
      }
      const unknown = deriveBridgeJobProgress({ job: { phase: 'unknown' }, chat: progressChat(), now: PROGRESS_NOW });
      assert(unknown.kind === 'generic' && unknown.tone === 'neutral' && unknown.headline === 'Checking on this job' && unknown.action === null, 'an unknown phase is the generic line');
      assert(deriveBridgeJobProgress({ job: progressJob(), chat: { state: 'bogus' }, now: PROGRESS_NOW }).kind === 'generic', 'an unrecognised chat state must not become a guess');
      assert(deriveBridgeJobProgress({ job: progressJob(), chat: { ordinal: 1, state: 'unknown' }, now: PROGRESS_NOW }).kind === 'generic', 'the normaliser\'s fallback chat state (unknown) must degrade to the generic line, never assert progress');
      assert(deriveBridgeJobProgress({ job: progressJob(), chat: { ordinal: 1, state: 'unknown' }, now: PROGRESS_NOW }).headline === 'Checking on this job', 'and say so in the neutral words');
    },
  },
  {
    name: 'bridge progress: timer text is derived from timestamps, clamps skew, and is null without an anchor',
    run: () => {
      assert(formatProgressDuration(20000) === '20s' && formatProgressDuration(120000) === '2 min' && formatProgressDuration(3900000) === '1 h 5 min' && formatProgressDuration(3600000) === '1 h', 'duration format');
      assert(formatProgressDuration(-1) === null && formatProgressDuration(NaN) === null && formatProgressDuration('5') === null, 'bad durations are null');
      const lines = progressTimeLines({ since: PROGRESS_NOW - 120000, lastHeard: PROGRESS_NOW - 20000 }, PROGRESS_NOW);
      assert(lines.elapsed === 'for 2 min' && lines.heard === 'Last heard from ChatGPT 20s ago', `${lines.elapsed} / ${lines.heard}`);
      assert(progressTimeLines({ since: null, lastHeard: null }, PROGRESS_NOW).elapsed === null && progressTimeLines({ since: null, lastHeard: null }, PROGRESS_NOW).heard === null, 'no anchor, no line');
      assert(progressTimeLines({ lastHeard: PROGRESS_NOW + 5000 }, PROGRESS_NOW).heard === 'Last heard from ChatGPT just now', 'a clock skew clamps to just now');
      assert(progressTimeLines(null, PROGRESS_NOW).elapsed === null && progressTimeLines({ since: 5 }, undefined).elapsed === null, 'malformed input yields no lines');
    },
  },
];

const bridgeHeldCardTests = [
  {
    name: 'job card: the held rule is the dock\'s, and the key is a primitive that ignores unrelated status churn',
    run: () => {
      const JOB = '11111111-1111-4111-8111-111111111111';
      const statusWith = (phase, stage = 'evidence-plan') => ({ queue: { jobs: [{ ...progressJob({ phase, stage }), jobId: JOB }, { jobId: 'other', phase: 'awaiting', stage: 'resume' }] }, chat: progressChat() });
      for (const phase of BRIDGE_WORKING_PHASES) assert(isBridgeHeldJob(statusWith(phase), JOB), `${phase} is held by ChatGPT`);
      assert([...BRIDGE_WORKING_PHASES].join() === 'unread,awaiting,host', 'the held phases are the dock\'s three');
      for (const phase of ['held', 'needs_user', 'gone', 'done', 'unknown']) assert(!isBridgeHeldJob(statusWith(phase), JOB) && bridgeHeldKey(statusWith(phase), JOB) === null, `${phase} is the person's to paste: not held`);
      for (const bad of [null, undefined, {}, { queue: null }, { queue: { jobs: 'x' } }, { queue: { jobs: [null, 5] } }]) assert(!isBridgeHeldJob(bad, JOB) && bridgeHeldKey(bad, JOB) === null, `malformed status degrades to not held: ${JSON.stringify(bad)}`);
      assert(!isBridgeHeldJob(statusWith('awaiting'), '') && !isBridgeHeldJob(statusWith('awaiting'), undefined) && !isBridgeHeldJob(statusWith('awaiting'), 'unknown-job'), 'an empty or unknown jobId is never held');
      assert(findBridgeHeldJob(statusWith('awaiting'), JOB).stage === 'evidence-plan', 'the held job is returned');

      const key = bridgeHeldKey(statusWith('awaiting'), JOB);
      assert(typeof key === 'string', 'the key is a primitive');
      assert(bridgeHeldKey({ ...statusWith('awaiting'), at: 99, counts: { served: 7 }, chat: progressChat({ calls: 8, lastCallAt: PROGRESS_NOW - 1 }) }, JOB) === key, 'a new status object with the same card text gives the SAME key, so the card does not re-render');
      assert(bridgeHeldKey(statusWith('awaiting', null), JOB) !== null, 'a held job with no known stage still keys as held');
      assert(bridgeHeldKey(statusWith('awaiting'), JOB) === bridgeHeldKey(statusWith('awaiting'), JOB), 'consecutive calls agree (getSnapshot contract)');
    },
  },
  {
    name: 'job card: its text follows the dock\'s derivation in every held state, never claiming ChatGPT is working when the dock says otherwise',
    run: () => {
      const JOB = '11111111-1111-4111-8111-111111111111';
      const paste = { pasteTransport: true, awaitingPaste: true };
      const dockView = status => deriveBridgeJobProgress({ job: status.queue.jobs[0], chat: status.chat, item: { stage: status.queue.jobs[0].stage }, now: PROGRESS_NOW, bridge: { paused: status.paused === true, pluginName: status.config?.pluginName } });
      const build = (jobExtra, chat, top = {}) => ({ queue: { jobs: [{ ...progressJob(jobExtra), jobId: JOB }] }, chat, ...top });
      const states = {
        'no chat (attention)': build({ phase: 'unread', servedToChat: null }, { ordinal: 0, state: 'none' }),
        'awaiting with an active chat (working)': build({}, progressChat()),
        'unread with an active chat': build({ phase: 'unread', servedToChat: null }, progressChat()),
        'paused': build({}, progressChat(), { paused: true }),
        'host (the app is saving)': build({ phase: 'host', servedToChat: null }, progressChat()),
        'first call not made yet': build({ servedToChat: null }, progressChat({ state: 'awaiting-first-call', calls: 0, lastCallAt: null })),
        'chat ended': build({ servedToChat: null, awaitingAnswer: false }, progressChat({ state: 'ended' })),
        'chat full, job never handed over': build({ servedToChat: null, awaitingAnswer: false }, progressChat({ state: 'full' })),
        'queued behind the chat limit': build({ servedToChat: null, awaitingAnswer: false }, progressChat({ jobsAssigned: 2, jobsCap: 2 })),
      };
      const lines = {};
      for (const [name, status] of Object.entries(states)) {
        const dock = dockView(status);
        const line = bridgeHeldCardLine(bridgeHeldKey(status, JOB), paste);
        lines[name] = line;
        assert(line && line.title === dock.headline, `${name}: the card headline is the dock's: card ${line?.title} vs dock ${dock.headline}`);
        assert(line.needsYou === (dock.tone === 'attention' || dock.tone === 'problem'), `${name}: the card says it needs you exactly when the dock's tone does (${dock.tone})`);
        assert(line.detail === (line.needsYou ? 'Open AI handoffs: it needs you.' : 'Open AI handoffs to see its progress.'), `${name}: detail ${line.detail}`);
        assert(line.openLabel === 'Open AI handoffs' && line.pendingLabel === 'In AI handoffs', `${name}: button labels`);
        assert(line.pendingTitle === 'This application is in the AI handoffs dock. Open it to see its progress.', `${name}: tooltip`);
        assert(!/paste|Continue AI handoff|Local AI|Handed to ChatGPT|With ChatGPT/i.test(`${line.title} ${line.detail} ${line.openLabel} ${line.pendingLabel} ${line.pendingTitle}`), `${name}: no paste-era or handed-off claim`);
      }
      // The four states the review named, spelled out.
      assert(lines['no chat (attention)'].title === 'No ChatGPT chat yet' && lines['no chat (attention)'].needsYou, 'no chat: attention, needs you');
      assert(lines['awaiting with an active chat (working)'].title === 'ChatGPT is working on: Résumé' && !lines['awaiting with an active chat (working)'].needsYou, 'an active chat that was served: working, no call to action');
      assert(lines.paused.title === 'Paused' && lines.paused.needsYou, 'paused: attention');
      assert(lines['host (the app is saving)'].title === 'The app is saving this' && !lines['host (the app is saving)'].needsYou, 'host: the app is saving');
      assert(lines['queued behind the chat limit'].title === 'Queued for the next chat', 'queued behind the limit says so');
      assert(lines['chat ended'].needsYou && lines['first call not made yet'].needsYou && lines['chat full, job never handed over'].needsYou, 'ended, first-call and full chats need the person');

      // Stalled: the dock's headline counts minutes; the card must not, since
      // its snapshot cannot tick. Same words, no number.
      const stalledStatus = build({ stalled: true, stalledSince: PROGRESS_NOW - 12 * 60000 }, progressChat());
      const stalledDock = dockView(stalledStatus);
      const stalledLine = bridgeHeldCardLine(bridgeHeldKey(stalledStatus, JOB), paste);
      assert(stalledDock.headline === 'ChatGPT has been quiet for 12 min' && stalledLine.title === 'ChatGPT has been quiet' && stalledDock.headline.startsWith(stalledLine.title) && stalledLine.needsYou, `stalled: ${stalledLine.title}`);
      assert(bridgeHeldKey(stalledStatus, JOB) === bridgeHeldKey(build({ stalled: true, stalledSince: PROGRESS_NOW - 30 * 60000 }, progressChat()), JOB), 'the stalled key does not depend on the clock or the quiet age');

      // Not held, or not a paste application the dock lists: the card's own wording stays.
      assert(bridgeHeldCardLine(null, paste) === null, 'not held: paste wording stays');
      const key = bridgeHeldKey(states['awaiting with an active chat (working)'], JOB);
      assert(bridgeHeldCardLine(key, { pasteTransport: true, awaitingPaste: false }) === null, 'a job not awaiting a paste (working/blocked/saved) is never relabelled');
      assert(bridgeHeldCardLine(key, { pasteTransport: false, awaitingPaste: true }) === null, 'a non-paste Local AI job is never relabelled');
      for (const bad of [undefined, 5, '', 'held:resume', 'resume', '[]', '["working"]', '["working",""]', '["working",5]', '{"a":1}']) assert(bridgeHeldCardLine(bad, paste) === null, `a malformed key is not held: ${bad}`);
    },
  },
  {
    name: 'job card: source wiring, the card and the dock read the one shared rule and derivation',
    run: () => {
      const card = readFileSync(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      assert(card.includes('useBridgeHeldKey(localApplication?.id)') && card.includes('bridgeHeldCardLine(bridgeHeldKey,'), 'the card derives its held state from the shared helper');
      assert(card.includes("'Application AI handoff ready'") && card.includes("'Continue AI handoff'") && card.includes("'Local AI queued'"), 'the paste-flow wording is unchanged');
      assert(card.includes('bridgeHeldLine ? bridgeHeldLine.title :') && card.includes('bridgeHeldLine ? bridgeHeldLine.openLabel :') && card.includes('bridgeHeldLine ? bridgeHeldLine.pendingLabel :') && card.includes('bridgeHeldLine ? bridgeHeldLine.pendingTitle :'), 'title, button, pending label and tooltip each switch on the held line');
      assert(!card.includes('useHandoffBridgeStatus'), 'the card must not subscribe to the whole status object (it changes on every push)');
      const hook = readFileSync(new URL('../../src/hooks/useBridgeHeldKey.js', import.meta.url), 'utf8');
      assert(hook.includes('useSyncExternalStore') && hook.includes('bridgeHeldKey(getHandoffBridgeStatus(), jobId)') && !/electronAPI|ipcRenderer|invoke/.test(hook), 'the hook reads the shared store with a primitive snapshot and adds no IPC');
      const held = readFileSync(new URL('../../src/utils/bridgeHeldApplication.js', import.meta.url), 'utf8');
      assert(held.includes('deriveBridgeJobProgress({') && held.includes('now: null'), 'the card key uses the dock\'s derivation with no clock');
      const progressView = readFileSync(new URL('../../src/components/BridgeProgress.jsx', import.meta.url), 'utf8');
      assert(progressView.includes('deriveBridgeJobProgress({ job, chat, item, now, bridge: { paused: status?.paused === true, pluginName } })'), 'the dock derives from the same function and the same paused field');
      const dialog = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(dialog.includes('isBridgeHeldJob(bridgeStatus, activeRequest?.jobId)') && !dialog.includes('BRIDGE_WORKING_PHASES'), 'the dock uses the same shared rule rather than its own copy');
    },
  },
  {
    name: 'bridge copy: the plugin name is a parameter with a neutral fallback, and Copy chat starter is the only starter button on a stalled health card',
    run: () => {
      const named = BRIDGE_PROGRESS_COPY.noChat('my_plugin');
      assert(named[1] === 'Press Copy chat starter, then paste it into a new ChatGPT chat with my_plugin selected.', named[1]);
      assert(BRIDGE_PROGRESS_COPY.copiedNew('my_plugin') === 'Copied. Now switch to ChatGPT, open a new chat, type @ and pick my_plugin, then paste and send.', 'copiedNew names the configured plugin');
      assert(BRIDGE_PROGRESS_COPY.copiedAgain(3, 'my_plugin') === 'Copied again: the same starter for chat 3. Paste it into a new ChatGPT chat with my_plugin selected.', 'copiedAgain names the chat and the plugin');
      assert(BRIDGE_PROGRESS_COPY.copiedAgain(2, null) === 'Copied again: the same starter for chat 2. Paste it into a new ChatGPT chat with the Infinite Canvas plugin selected.', 'copiedAgain falls back to the neutral plugin name');
      for (const missing of [undefined, null, '', '   ', 5, {}]) {
        assert(BRIDGE_PROGRESS_COPY.noChat(missing)[1].includes('with the Infinite Canvas plugin selected') && BRIDGE_PROGRESS_COPY.copiedNew(missing).includes('pick the Infinite Canvas plugin,'), `fallback for ${JSON.stringify(missing)}`);
        assert(bridgePluginRef(missing) === 'the Infinite Canvas plugin', 'fallback ref');
      }
      // Wired end to end: the dock's derivation takes the name from bridge.pluginName.
      const none = deriveBridgeJobProgress({ job: progressJob({ phase: 'unread', servedToChat: null }), chat: { ordinal: 0, state: 'none' }, item: {}, now: PROGRESS_NOW, bridge: { pluginName: 'my_plugin' } });
      assert(none.detail.includes('with my_plugin selected') && !none.detail.includes('Infinite Canvas'), none.detail);
      const bare = deriveBridgeJobProgress({ job: progressJob({ phase: 'unread', servedToChat: null }), chat: { ordinal: 0, state: 'none' }, item: {}, now: PROGRESS_NOW });
      assert(bare.detail.includes('with the Infinite Canvas plugin selected'), bare.detail);
      // No copy module hard-codes a plugin name; the native sheet is built from the main-owned config name.
      const copySource = readFileSync(new URL('../../src/utils/handoffBridgeCopy.js', import.meta.url), 'utf8');
      assert(!/pick Infinite Canvas|with Infinite Canvas selected/.test(copySource), 'no hard-coded plugin name in the renderer copy');
      const status = JSON.parse(JSON.stringify(EMPTY_BRIDGE_STATUS));
      Object.assign(status, { enabled: true, serving: 'live', paused: false }); status.availability.ok = true;
      Object.assign(status.setup, { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: true, linked: true, toolsListed: true, firstCallSeen: true });
      status.tunnel.state = 'up'; status.tunnel.probe.state = 'ok'; status.link.state = 'linked'; status.windows.canvasOpen = true;
      Object.assign(status.chat, { state: 'working', ordinal: 1, outstanding: { stalled: true, stalledSince: PROGRESS_NOW - 120000 } });
      const health = deriveBridgeHealth(status, PROGRESS_NOW);
      assert(health.id === 'stalled' && health.actions.map(action => action.id).join() === 'new-chat,open-dock', `stalled offers one starter button: ${health.actions.map(action => action.id)}`);
    },
  },
];

export default [...dockTests, ...bridgeJobProgressTests, ...bridgeHeldCardTests];
