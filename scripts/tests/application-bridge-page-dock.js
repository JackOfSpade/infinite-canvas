// Real-dock proof that every application the ChatGPT bridge holds shares ONE
// page (rows, one worker block) instead of one page per bundle. These render
// the actual NonApiAiDialog; the pure grouping rules and the page component
// have their own groups (application-bridge-page*.js).
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { EMPTY_BRIDGE_STATUS } from '../../src/utils/handoffBridgeStatus.js';
import { BRIDGE_UI_COPY } from '../../src/utils/handoffBridgeCopy.js';

const NOW = 1_700_000_000_000;
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Same builder the other bridge render groups use: a fully-shaped status.
function status(seq, extra = {}) {
  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const prior = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {};
        target[key] = merge({ ...prior }, value);
      } else target[key] = value;
    }
    return target;
  };
  const base = JSON.parse(JSON.stringify(EMPTY_BRIDGE_STATUS));
  Object.assign(base, { v: 1, seq, at: NOW, enabled: true, autoStart: false, autoRelease: false, serving: 'live', paused: false });
  base.availability = { ...base.availability, ok: true };
  Object.assign(base.config, { hostname: null, pluginName: 'Infinite Canvas', mcpUrl: null, telemetryInBugReports: false });
  base.config.scope = { ...base.config.scope, applications: true, scoring: false };
  Object.assign(base.setup, { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: true, linked: true, toolsListed: true, firstCallSeen: true });
  Object.assign(base.tunnel, { state: 'up' });
  base.tunnel.probe = { ...base.tunnel.probe, state: 'ok' };
  Object.assign(base.link, { state: 'linked' });
  Object.assign(base.chat, { state: 'none' });
  base.windows.canvasOpen = true;
  return merge(base, extra);
}

// One bridge lane record, in the shape status.queue.jobs carries.
const lane = (jobId, phase = 'awaiting', stage = 'resume') => ({
  jobId, phase, stage, reason: phase === 'needs_user' ? 'user_hold' : null, servedToChat: null, changedAt: NOW,
});
const withLanes = (seq, lanes, extra = {}) => status(seq, { queue: { jobs: lanes }, ...extra });

// Mounts the REAL dock in a jsdom window and hands the scenario a small kit.
// Everything the scenario needs to publish items / bridge status, click, and
// observe is here, so a scenario reads as intent rather than plumbing.
async function withDock(run) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-dock-'));
  const entry = path.join(directory, 'DockProbe.jsx');
  const abs = relative => JSON.stringify(path.resolve(relative));
  await fsPromises.writeFile(entry, [
    "import React from 'react';",
    `import { NonApiAiDialog } from ${abs('src/components/NonApiAiDialog.jsx')};`,
    `export { publishApplicationHandoffs, applicationDockRequest, __resetApplicationHandoffsForTests } from ${abs('src/utils/applicationHandoffDock.js')};`,
    `export { applyHandoffBridgeStatus, __resetHandoffBridgeStoreForTests } from ${abs('src/utils/handoffBridgeStore.js')};`,
    `export { updateModalCount } from ${abs('src/components/modalStack.js')};`,
    `export { EventLogger } from ${abs('src/utils/EventLogger.js')};`,
    'export function DockProbe() { return <NonApiAiDialog />; }',
    '',
  ].join('\n'));
  const controller = new AbortController();
  let bundle;
  try {
    bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 20000);
    await withDom(async window => withConsoleCollector(async entries => {
      const priorCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
      Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
      const calls = { discard: [], startPool: [] };
      window.electronAPI = {
        handoffBridgeGetStatus: async () => ({ status: status(1) }),
        onHandoffBridgeStatus: () => () => {},
        handoffBridgeGetActivity: async () => ({ items: [] }),
        handoffBridgePublishJobs: () => undefined,
        onNonApiAiRequest: () => () => {},
        onNonApiAiSettled: () => () => {},
        onNonApiAiCancelled: () => () => {},
        discardLocalApplication: async payload => { calls.discard.push(payload); return { success: true }; },
        handoffBridgeStartWorkerPool: async () => {
          calls.startPool.push(true);
          return { success: true, generation: 1, workerCount: 2, recommended: 2, queued: 2, materialized: 2, lockedWorkerOrdinals: [] };
        },
      };
      bundle.module.__resetHandoffBridgeStoreForTests();
      bundle.module.__resetApplicationHandoffsForTests();
      const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
      const act = async fn => bundle.module.act(async () => {
        if (fn) await fn();
        await Promise.resolve();
        await Promise.resolve();
      });
      const kit = {
        window,
        document: window.document,
        entries,
        calls,
        bundle,
        act,
        // A dock item for one paste-flow bundle (subject = "<title> · <company>").
        item: ({ jobId, title, company, stage = 'resume', code = `CODE-${jobId.slice(0, 4)}`, prompt = `PROMPT_${jobId.slice(0, 4)}`, extra = {} }) => ({
          ...bundle.module.applicationDockRequest({
            node: { id: `node-${jobId.slice(0, 4)}`, data: { title, company, localApplication: { id: jobId, mode: 'paste', status: 'queued', stage } } },
            handoff: { jobId, stage, revision: 1, handoffCode: code, prompt, draft: '' },
          }),
          ...extra,
        }),
        render: () => act(async () => { rootNode.render(bundle.module.React.createElement(bundle.module.DockProbe)); }),
        setStatus: next => act(async () => { bundle.module.applyHandoffBridgeStatus(next); }),
        // The dock's own copy of the modal stack (bundled with it): what Settings,
        // Dialog, ConfirmDialog and the lightbox call while they are open.
        setModalCount: delta => act(async () => { bundle.module.updateModalCount(delta); }),
        publish: items => act(async () => { bundle.module.publishApplicationHandoffs(items); }),
        click: element => act(async () => { element.click(); }),
        page: () => window.document.querySelector('[data-applications-page]'),
        rows: () => [...window.document.querySelectorAll('[data-application-row]')],
        nav: () => window.document.querySelector('nav[aria-label="Pending AI handoff batches"]'),
        text: () => window.document.body.textContent,
        sleep: ms => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }),
        logs: () => {
          const raw = bundle.module.EventLogger.getLogs();
          const lines = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
          return lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line)));
        },
      };
      try {
        await run(kit);
      } finally {
        await act(async () => rootNode.unmount());
        if (priorCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', priorCustomEvent); else delete globalThis.CustomEvent;
      }
      assert(entries.length === 0, `the dock must render without console output: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
    }));
  } finally {
    controller.abort();
    await bundle?.dispose();
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

export default [
  {
    name: 'application bridge page: dock: queued bundles the bridge holds share ONE page with a row each, no chips, one worker block',
    async run() {
      await withDock(async dock => {
        const first = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'evidence-plan' });
        const second = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'evidence-plan'), lane(JOB_B, 'unread', 'resume')]));
        await dock.publish([first, second]);

        assert(dock.document.querySelector('#non-api-ai-handoff-panel'), 'the dock opens on a new queue');
        assert(dock.page(), 'held bundles render the shared application page');
        assert(dock.document.querySelectorAll('[data-applications-page]').length === 1, 'exactly one shared page');
        assert(dock.rows().length === 2, `one row per held bundle (got ${dock.rows().length})`);
        assert(!dock.nav(), 'a queue made only of held bundles has no chip strip to choose between');
        assert(!dock.document.querySelector('textarea'), 'no paste box while ChatGPT holds the bundles');
        const text = dock.text();
        assert(text.includes('2 applications with ChatGPT'), `the header names the shared page (${text.slice(0, 200)})`);
        assert(text.includes('Staff Engineer') && text.includes('Designer'), 'each row names its own bundle');
        assert(!text.includes('PROMPT_aaaa') && !text.includes('PROMPT_bbbb') && !text.includes('CODE-aaaa') && !text.includes('CODE-bbbb'),
          'no prompt text or handoff code leaks onto the shared page');
        assert(dock.document.querySelectorAll('[data-workers-only="true"]').length === 1, 'exactly one shared worker block');
        const startButtons = [...dock.document.querySelectorAll('button')].filter(button => button.textContent.trim() === BRIDGE_UI_COPY.startChat);
        assert(startButtons.length === 1, `exactly one start-workers action for all rows (got ${startButtons.length})`);

        // A third queued generation joins the SAME page; it never opens another.
        const third = dock.item({ jobId: JOB_C, title: 'Analyst', company: 'Initech', stage: 'review' });
        await dock.setStatus(withLanes(3, [lane(JOB_A, 'awaiting', 'evidence-plan'), lane(JOB_B, 'unread', 'resume'), lane(JOB_C, 'awaiting', 'review')]));
        await dock.publish([first, second, third]);
        assert(dock.document.querySelectorAll('[data-applications-page]').length === 1 && dock.rows().length === 3,
          `a live add stays on the one page with three rows (got ${dock.rows().length})`);
        assert(!dock.nav(), 'still no chip strip after the add');
      });
    },
  },
  {
    name: 'application bridge page: dock: mixed held and unlaned queue has one shared ChatGPT chip and a separate paste chip',
    async run() {
      await withDock(async dock => {
        const held = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        const unlaned = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume')]));
        await dock.publish([held, unlaned]);

        const nav = dock.nav();
        assert(nav, 'a mixed queue gets the pending-batch chip strip');
        const buttons = [...nav.querySelectorAll('button')];
        assert(buttons.length === 2, `exactly two chips for one held + one unlaned bundle (got ${buttons.length})`);
        const shared = buttons.find(button => button.textContent.trim() === 'ChatGPT · 1');
        const numeric = buttons.find(button => button !== shared);
        assert(shared, 'the held bundle gets the shared ChatGPT chip');
        assert(shared.getAttribute('aria-current') === 'page', 'the shared chip is current while the shared page is open');
        assert(numeric, 'the unlaned bundle keeps a numeric chip');
        assert(numeric.getAttribute('aria-label')?.includes('Designer · Globex'), `the numeric chip names the unlaned subject (${numeric.getAttribute('aria-label')})`);
        assert(dock.rows().length === 1, `only the held bundle is a row (got ${dock.rows().length})`);

        await dock.click(numeric);
        assert(!dock.page(), 'clicking the unlaned chip leaves the shared application page');
        assert(dock.document.querySelector('textarea'), 'the unlaned bundle shows its paste textarea');
        assert(dock.text().includes('PROMPT_bbbb'), 'the unlaned prompt text is shown');

        const sharedAgain = [...dock.nav().querySelectorAll('button')].find(button => button.textContent.trim() === 'ChatGPT · 1');
        assert(sharedAgain, 'the shared chip is still available');
        await dock.click(sharedAgain);
        assert(dock.page(), 'clicking the shared chip reopens the shared page');
        assert(dock.rows().length === 1 && dock.rows()[0].getAttribute('data-application-row') === `application:${JOB_A}`,
          'the reopened page has exactly the held bundle row');
        assert(!dock.document.querySelector('textarea'), 'the paste box is hidden again');
      });
    },
  },
  {
    name: 'application bridge page: dock: needs_user moves a held bundle to its own paste page and blocked items never join rows',
    async run() {
      await withDock(async dock => {
        const normal = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        const blocked = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume', extra: { working: true, workingState: 'blocked' } });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume'), lane(JOB_B, 'awaiting', 'resume')]));
        await dock.publish([normal, blocked]);

        assert(dock.page(), 'the normal held bundle opens the shared page');
        assert(dock.rows().length === 1 && dock.rows()[0].getAttribute('data-application-row') === `application:${JOB_A}`,
          'the blocked bundle is not grouped as a row');
        const nav = dock.nav();
        assert(nav, 'the blocked bundle keeps the chip strip');
        const blockedChip = [...nav.querySelectorAll('button')].find(button => button.textContent.trim() !== 'ChatGPT · 1');
        assert(blockedChip && blockedChip.getAttribute('aria-label')?.includes('Designer · Globex'),
          `the blocked bundle appears as its own numeric chip (${blockedChip?.getAttribute('aria-label')})`);

        await dock.setStatus(withLanes(3, [lane(JOB_A, 'needs_user', 'resume'), lane(JOB_B, 'awaiting', 'resume')]));
        assert(!dock.page(), 'needs_user removes the shared page');
        assert(dock.document.querySelector('textarea'), 'the needs_user bundle shows its paste textarea');
        assert(dock.text().includes('PROMPT_aaaa'), 'the needs_user prompt text is shown');
        assert(dock.document.querySelectorAll('[data-application-row]').length === 0, 'no rows remain once every grouped bundle leaves');
      });
    },
  },
  {
    name: 'application bridge page: dock: discard from a non-open row asks about that bundle and only discards it on confirm',
    async run() {
      await withDock(async dock => {
        const first = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        const second = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume'), lane(JOB_B, 'unread', 'resume')]));
        await dock.publish([first, second]);

        const rowB = () => dock.document.querySelector(`[data-application-row="application:${JOB_B}"]`);
        const discardB = () => rowB()?.querySelector('button[title="Delete this application bundle and its private job folder"]');
        assert(discardB(), 'the non-open row has a Discard bundle button');

        await dock.click(discardB());
        let dialog = dock.document.querySelector('[role="dialog"]');
        assert(dialog, 'clicking Discard bundle opens ConfirmDialog');
        assert(dialog.textContent.includes('Designer · Globex'), `the dialog names the B bundle subject (${dialog.textContent.slice(0, 200)})`);
        assert(!dialog.textContent.includes('Staff Engineer · Acme'), 'the dialog does not name the open A bundle');
        const confirmIn = root => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === 'Discard bundle');
        const cancelIn = root => [...root.querySelectorAll('button')].find(button => button.textContent.trim() !== 'Discard bundle' && button.getAttribute('aria-label') !== 'Cancel and undo');
        assert(confirmIn(dialog) && cancelIn(dialog), 'the dialog has confirm and cancel actions');

        await dock.click(cancelIn(dialog));
        await dock.sleep(500);
        assert(dock.calls.discard.length === 0, 'cancelling discards nothing');

        assert(discardB(), 'the row remains after cancel');
        await dock.click(discardB());
        dialog = dock.document.querySelector('[role="dialog"]');
        assert(dialog, 'discard can be reopened');
        const confirm = confirmIn(dialog);
        assert(confirm, 'the reopened dialog has a Discard bundle confirm button');
        await dock.click(confirm);
        await dock.sleep(500);
        assert(dock.calls.discard.length === 1, `confirm discards exactly once (got ${dock.calls.discard.length})`);
        assert(dock.calls.discard[0].jobId === JOB_B, `confirm discards the clicked bundle (got ${dock.calls.discard[0]?.jobId})`);
        assert(dock.calls.discard.every(call => call.jobId !== JOB_A), 'confirm does not discard the open A bundle');
      });
    },
  },
  {
    name: 'application bridge page: dock: one start action starts one shared worker pool for all held rows',
    async run() {
      await withDock(async dock => {
        const first = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        const second = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume'), lane(JOB_B, 'unread', 'resume')]));
        await dock.publish([first, second]);

        const startButtons = [...dock.document.querySelectorAll('button')].filter(button => button.textContent.trim() === BRIDGE_UI_COPY.startChat);
        assert(startButtons.length === 1, `exactly one start-workers button for the page (got ${startButtons.length})`);
        await dock.click(startButtons[0]);
        await dock.sleep(20);
        assert(dock.calls.startPool.length === 1, `start clicked once (got ${dock.calls.startPool.length})`);
        const workerLists = [...dock.document.querySelectorAll('ul[aria-label="Worker chat progress"]')];
        assert(workerLists.length === 1, `exactly one worker chat progress list (got ${workerLists.length})`);
        assert(workerLists[0].children.length === 2, `the worker list has two worker entries (got ${workerLists[0].children.length})`);
        assert(dock.document.querySelectorAll('[data-workers-only="true"]').length === 1, 'still exactly one shared worker block');
      });
    },
  },
  {
    name: 'application bridge page: dock: EventLogger records shared and separate application page layout changes',
    async run() {
      await withDock(async dock => {
        const first = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        const second = dock.item({ jobId: JOB_B, title: 'Designer', company: 'Globex', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume'), lane(JOB_B, 'unread', 'resume')]));
        await dock.publish([first, second]);

        assert(dock.logs().some(line => line.includes('dock layout: shared application page rows=2 · separate chips=0')),
          `initial layout log present: ${dock.logs().join(' | ')}`);

        await dock.setStatus(withLanes(3, [lane(JOB_A, 'awaiting', 'resume'), lane(JOB_B, 'needs_user', 'resume')]));
        assert(dock.logs().some(line => line.includes('dock layout: shared application page rows=1 · separate chips=1')),
          `updated layout log present: ${dock.logs().join(' | ')}`);
      });
    },
  },
  {
    name: 'application bridge page: dock: drops below any open modal (Settings) and returns above everything when it closes',
    async run() {
      await withDock(async dock => {
        const first = dock.item({ jobId: JOB_A, title: 'Staff Engineer', company: 'Acme', stage: 'resume' });
        await dock.render();
        await dock.setStatus(withLanes(2, [lane(JOB_A, 'awaiting', 'resume')]));
        await dock.publish([first]);

        // The wrapper's z-index is what orders the dock against body-level
        // modals (a fixed element with a z-index is a stacking context).
        const wrapperZ = () => {
          const container = dock.document.querySelector('[data-handoff-dock]');
          assert(container, 'the dock container carries data-handoff-dock');
          const wrapper = container.parentElement;
          return /z-\[(\d+)\]/.exec(wrapper.className)?.[1] || null;
        };
        assert(dock.document.querySelector('[data-handoff-dock]').getAttribute('data-handoff-dock') === 'expanded', 'a new queue opens the dock expanded');
        assert(wrapperZ() === '11000', `with no modal open the dock sits above everything (z ${wrapperZ()})`);

        // Settings is z-9999 and ConfirmDialog/dialogs z-10000: the dock must be below both.
        await dock.setModalCount(1);
        const whileOpen = Number(wrapperZ());
        assert(whileOpen < 9999, `an open modal puts the dock below Settings (z-9999) — got z ${whileOpen}`);
        assert(dock.document.querySelector('#non-api-ai-handoff-panel'), 'the dock stays mounted (and keeps its state) under a modal');

        await dock.setModalCount(1);
        await dock.setModalCount(-1);
        assert(Number(wrapperZ()) < 9999, 'two stacked modals, one closed: the dock still yields to the remaining one');

        await dock.setModalCount(-1);
        assert(wrapperZ() === '11000', `the last modal closing returns the dock to the top (z ${wrapperZ()})`);
      });
    },
  },
];
