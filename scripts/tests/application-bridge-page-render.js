import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { EMPTY_BRIDGE_STATUS } from '../../src/utils/handoffBridgeStatus.js';
import { BRIDGE_PROGRESS_COPY, BRIDGE_UI_COPY } from '../../src/utils/handoffBridgeCopy.js';

const NOW = 1_700_000_000_000;

// Same builder the BridgeProgress render group uses: a fully-shaped status
// whose nested defaults match main's snapshot, so a probe can shallowly
// override chat/queue/etc. without normalizing away the exact shape.
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

const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// A raw queue.jobs entry in the exact shape findBridgeHeldJob and
// deriveBridgeJobProgress read (they never see a normalized snapshot in the
// dock page tests, so the probe must hand them the real lane record).
function job(jobId, extra = {}) {
  return {
    jobId,
    phase: 'awaiting',
    stage: 'evidence-plan',
    reason: null,
    servedToChat: null,
    workerOrdinal: null,
    changedAt: null,
    servedAt: null,
    answeredAt: null,
    awaitingAnswer: false,
    stalled: false,
    stalledSince: null,
    ...extra,
  };
}

function request(id, jobId, extra = {}) {
  return { kind: 'application', requestId: id, jobId, subject: `Subject ${id}`, label: null, stage: 'evidence-plan', corrections: [], ...extra };
}

function text(window) {
  return window.document.body.textContent;
}

function buttons(window) {
  return [...window.document.querySelectorAll('button')];
}

function buttonByLabel(window, label) {
  return buttons(window).find(button => button.textContent.trim() === label);
}

async function bundlePage(entry, { signal }) {
  return withTimeout(bundleComponent(entry, { signal }), 8000);
}

const PAGE_ENTRY_BODY = componentFilePath => `import React from 'react';\nimport { BridgeApplicationsPage } from ${JSON.stringify(componentFilePath)};\nexport function PageProbe(props) { return React.createElement(BridgeApplicationsPage, props); }\n`;

const PROGRESS_ENTRY_BODY = componentFilePath => `import React from 'react';\nimport { BridgeProgress } from ${JSON.stringify(componentFilePath)};\nexport function ProgressProbe(props) { return React.createElement(BridgeProgress, props); }\n`;

export default [
  {
    name: 'application bridge page: render: three held jobs each drive their own four-step walk with exactly one worker block and a silent console',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-render-'));
      const entry = path.join(directory, 'PageProbe.jsx');
      await fsPromises.writeFile(entry, PAGE_ENTRY_BODY(path.resolve('src/components/BridgeApplicationsPage.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        const held = [
          request('req-a', JOB_A),
          request('req-b', JOB_B),
          request('req-c', JOB_C),
        ];
        const given = status(1, {
          chat: { state: 'none' },
          queue: {
            jobs: [
              job(JOB_A, { phase: 'awaiting', stage: 'evidence-plan' }),
              job(JOB_B, { phase: 'unread', stage: 'resume' }),
              job(JOB_C, { phase: 'host', stage: 'review' }),
            ],
          },
        });
        await withDom(async window => withConsoleCollector(async entries => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.PageProbe, {
                  status: given,
                  held,
                  ordinalFor: request => ({ 'req-a': 1, 'req-b': 2, 'req-c': 3 })[request.requestId] ?? null,
                  activeRequestId: null,
                  discardingRequestIds: new Set(),
                  discardDisabled: false,
                  onDiscard: () => undefined,
                })));
              await Promise.resolve();
            });

            const page = window.document.querySelector('[data-applications-page="true"]');
            assert(page, 'the shared applications page must render a single labelled wrapper');
            assert(window.document.querySelectorAll('[data-applications-page="true"]').length === 1, 'exactly one applications page wrapper');
            const rows = [...window.document.querySelectorAll('[data-application-row]')];
            assert(rows.length === 3, `exactly three application rows, got ${rows.length}`);

            const expected = [
              { id: 'req-a', stage: 'Evidence plan', ordinal: 'Application 1' },
              { id: 'req-b', stage: 'Résumé', ordinal: 'Application 2' },
              { id: 'req-c', stage: 'Review and edit', ordinal: 'Application 3' },
            ];
            for (const expectation of expected) {
              const row = window.document.querySelector(`[data-application-row="${expectation.id}"]`);
              assert(row, `row for ${expectation.id} exists`);
              const list = row.querySelector('ol[aria-label="Application steps"]');
              assert(list && list.querySelectorAll('li').length === 4, `${expectation.id}: the stepper is an ordered list of four steps`);
              const labels = [...list.querySelectorAll('li')].map(item => item.textContent);
              assert(labels.some(item => item.includes('Evidence plan')), `${expectation.id}: stepper includes Evidence plan`);
              assert(labels.some(item => item.includes('Résumé')), `${expectation.id}: stepper includes Resume label`);
              assert(labels.some(item => item.includes('Cover letter')), `${expectation.id}: stepper includes Cover letter`);
              assert(labels.some(item => item.includes('Review and edit')), `${expectation.id}: stepper includes Review label`);
              const current = [...list.querySelectorAll('li[aria-current="step"]')];
              assert(current.length === 1, `${expectation.id}: exactly one current step`);
              assert(current[0].textContent.includes(expectation.stage), `${expectation.id}: the current step matches the job stage`);
              assert(text(window).includes(expectation.ordinal), `${expectation.id}: ordinals reflect ordinalFor`);
            }
            assert(text(window).includes('Subject req-a') && text(window).includes('Subject req-b') && text(window).includes('Subject req-c'), 'each row shows its own subject');
            assert(entries.length === 0, `render must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application bridge page: render: one active worker pool renders a single worker-chat block with its three workers for all three rows',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-pool-'));
      const entry = path.join(directory, 'PageProbe.jsx');
      await fsPromises.writeFile(entry, PAGE_ENTRY_BODY(path.resolve('src/components/BridgeApplicationsPage.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        const held = [request('req-a', JOB_A), request('req-b', JOB_B), request('req-c', JOB_C)];
        const given = status(1, {
          chat: {
            state: 'working',
            ordinal: 1,
            pool: {
              active: true,
              generation: 1,
              workerCount: 3,
              workers: [
                { ordinal: 1, state: 'working', completed: 2 },
                { ordinal: 2, state: 'available', completed: 0 },
                { ordinal: 3, state: 'quiet', completed: 1, quietReason: 'answer_silent' },
              ],
              plan: { recommended: 3, queued: 3, materialized: 3 },
            },
          },
          queue: {
            jobs: [
              job(JOB_A, { phase: 'awaiting', stage: 'evidence-plan', workerOrdinal: 1, servedToChat: 1, awaitingAnswer: true, servedAt: NOW - 60000 }),
              job(JOB_B, { phase: 'awaiting', stage: 'resume', workerOrdinal: 2 }),
              job(JOB_C, { phase: 'host', stage: 'review' }),
            ],
          },
        });
        await withDom(async window => withConsoleCollector(async entries => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.PageProbe, {
                  status: given,
                  held,
                  ordinalFor: request => ({ 'req-a': 1, 'req-b': 2, 'req-c': 3 })[request.requestId] ?? null,
                  activeRequestId: null,
                  discardingRequestIds: new Set(),
                  discardDisabled: false,
                  onDiscard: () => undefined,
                })));
              await Promise.resolve();
            });
            assert(window.document.querySelectorAll('[data-application-row]').length === 3, 'three rows still render alongside a live worker pool');
            const lists = window.document.querySelectorAll('ul[aria-label="Worker chat progress"]');
            assert(lists.length === 1, `exactly one worker list, got ${lists.length}`);
            assert(lists[0].querySelectorAll('li').length === 3, 'the single worker list has exactly three worker entries');
            assert(entries.length === 0, `render must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application bridge page: render: no chat yields exactly one start-workers action that asks main once and surfaces copy-starters exactly once',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-start-'));
      const entry = path.join(directory, 'PageProbe.jsx');
      await fsPromises.writeFile(entry, PAGE_ENTRY_BODY(path.resolve('src/components/BridgeApplicationsPage.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        const held = [request('req-a', JOB_A), request('req-b', JOB_B), request('req-c', JOB_C)];
        const given = status(1, {
          chat: { state: 'none' },
          queue: {
            jobs: [
              job(JOB_A, { phase: 'awaiting', stage: 'evidence-plan' }),
              job(JOB_B, { phase: 'awaiting', stage: 'resume' }),
              job(JOB_C, { phase: 'awaiting', stage: 'cover-letter' }),
            ],
          },
        });
        await withDom(async window => withConsoleCollector(async entries => {
          const calls = [];
          window.electronAPI = {
            handoffBridgeStartWorkerPool: async () => {
              calls.push('plan');
              return { success: true, generation: 7, workerCount: 2, recommended: 2, queued: 3, materialized: 3 };
            },
            handoffBridgeCopyWorkerStarter: async payload => {
              calls.push(['copy', payload]);
              return { success: true, generation: 7, workerCount: 2, workerOrdinal: payload?.workerOrdinal, copied: true };
            },
            handoffBridgeRestartWorker: async () => ({ success: true }),
          };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.PageProbe, {
                  status: given,
                  held,
                  ordinalFor: request => ({ 'req-a': 1, 'req-b': 2, 'req-c': 3 })[request.requestId] ?? null,
                  activeRequestId: null,
                  discardingRequestIds: new Set(),
                  discardDisabled: false,
                  onDiscard: () => undefined,
                })));
              await Promise.resolve();
            });

            const startButtons = buttons(window).filter(button => button.textContent.trim() === BRIDGE_UI_COPY.startChat);
            assert(startButtons.length === 1, `exactly one start-workers button, got ${startButtons.length}`);
            const detail = BRIDGE_PROGRESS_COPY.noChat('Infinite Canvas')[1];
            assert(text(window).split(detail).length - 1 === 1, `the no-chat explanatory detail appears exactly once: ${detail}`);

            await bundle.module.act(async () => {
              startButtons[0].click();
              await Promise.resolve();
              await Promise.resolve();
            });
            assert(calls.length === 1 && calls[0] === 'plan', `the page's single action asks main once: ${JSON.stringify(calls)}`);
            const lists = window.document.querySelectorAll('ul[aria-label="Worker chat progress"]');
            assert(lists.length === 1, `still exactly one worker list after starting, got ${lists.length}`);
            const copyButtons = buttons(window).filter(button => /^Copy worker \d+ starter$/.test(button.textContent.trim()));
            assert(copyButtons.length === 2, `the new worker list surfaces one copy-starter per worker, got ${copyButtons.length}`);
            assert(entries.length === 0, `render must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application bridge page: render: discard controls are per-row and disabled/discarding/active states are reflected',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-discard-'));
      const entry = path.join(directory, 'PageProbe.jsx');
      await fsPromises.writeFile(entry, PAGE_ENTRY_BODY(path.resolve('src/components/BridgeApplicationsPage.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        const held = [request('req-a', JOB_A), request('req-b', JOB_B)];
        const given = status(1, {
          chat: { state: 'none' },
          queue: { jobs: [job(JOB_A, { phase: 'awaiting', stage: 'evidence-plan' }), job(JOB_B, { phase: 'awaiting', stage: 'resume' })] },
        });
        await withDom(async window => withConsoleCollector(async entries => {
          const discarded = [];
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          const render = (props) => bundle.module.act(async () => {
            rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
              bundle.module.React.createElement(bundle.module.PageProbe, {
                status: given,
                held,
                ordinalFor: () => null,
                activeRequestId: null,
                discardingRequestIds: new Set(),
                discardDisabled: false,
                onDiscard: request => discarded.push(request),
                ...props,
              })));
            await Promise.resolve();
          });
          try {
            // Row's own request object is handed to onDiscard exactly.
            await render({});
            const discardButtons = buttons(window).filter(button => /Discard bundle|Discarding…/.test(button.textContent.trim()));
            assert(discardButtons.length === 2, `two rows, two discard buttons, got ${discardButtons.length}`);
            await bundle.module.act(async () => { discardButtons[0].click(); await Promise.resolve(); });
            assert(discarded.length === 1 && discarded[0].requestId === 'req-a', `onDiscard receives the row's own request, got ${discarded.map(item => item.requestId).join(',')}`);

            // discardingRequestIds disables the matching row and relabels it.
            await render({ discardingRequestIds: new Set(['req-b']) });
            const reqBBody = window.document.querySelector('[data-application-row="req-b"]');
            const reqBButton = reqBBody.querySelector('button[title="Delete this application bundle and its private job folder"]');
            assert(reqBButton && reqBButton.disabled && reqBButton.textContent.trim() === 'Discarding…', 'the discarding row is disabled and labelled Discarding…');
            const reqAButton = window.document.querySelector('[data-application-row="req-a"] button[title="Delete this application bundle and its private job folder"]');
            assert(reqAButton && !reqAButton.disabled && reqAButton.textContent.trim() === 'Discard bundle', 'the other row stays enabled');

            // discardDisabled disables both.
            await render({ discardDisabled: true, discardingRequestIds: new Set() });
            const allDisabledByGlobal = [...window.document.querySelectorAll('[data-application-row] button')].every(button => button.disabled);
            assert(allDisabledByGlobal, 'discardDisabled disables every discard button');

            // activeRequestId marks one row current.
            await render({ activeRequestId: 'req-b' });
            const active = window.document.querySelector('[data-application-row="req-b"]');
            const inactive = window.document.querySelector('[data-application-row="req-a"]');
            assert(active.getAttribute('aria-current') === 'true', 'the active row is aria-current');
            assert(inactive.getAttribute('aria-current') === null, 'the inactive row has no aria-current');
            assert(entries.length === 0, `render must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application bridge page: render: empty and malformed inputs never throw and never write to the console',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-malformed-'));
      const entry = path.join(directory, 'PageProbe.jsx');
      await fsPromises.writeFile(entry, PAGE_ENTRY_BODY(path.resolve('src/components/BridgeApplicationsPage.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        await withDom(async window => withConsoleCollector(async entries => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.PageProbe, { status: null, held: [], ordinalFor: () => null })));
              await Promise.resolve();
            });
            assert(window.document.querySelectorAll('[data-applications-page="true"]').length === 0, 'empty held renders nothing');

            // Replace with one malformed status at a time; each must render
            // without throwing and without console output.
            const malformed = [
              { label: 'null status', props: { status: null, held: [request('req-a', JOB_A)] } },
              { label: 'empty object status', props: { status: {}, held: [request('req-a', JOB_A)] } },
              { label: 'non-array queue.jobs', props: { status: { queue: { jobs: 'not-an-array' }, chat: {} }, held: [request('req-a', JOB_A)] } },
            ];
            for (const scenario of malformed) {
              await bundle.module.act(async () => {
                rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                  bundle.module.React.createElement(bundle.module.PageProbe, { ordinalFor: () => null, ...scenario.props })));
                await Promise.resolve();
              });
            }
            assert(entries.length === 0, `malformed inputs must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application bridge page: render: BridgeProgress workersOnly renders only the worker chrome and nothing when there is nothing to show',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-app-page-workers-only-'));
      const entry = path.join(directory, 'ProgressProbe.jsx');
      await fsPromises.writeFile(entry, PROGRESS_ENTRY_BODY(path.resolve('src/components/BridgeProgress.jsx')));
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await bundlePage(entry, { signal: controller.signal });
        await withDom(async window => withConsoleCollector(async entries => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            // No chat + held awaiting job: action exists, so the worker block
            // keeps the status line and action button, but no stepper/pause.
            const noChatStatus = status(1, {
              chat: { state: 'none' },
              queue: { jobs: [job(JOB_A, { phase: 'awaiting', stage: 'evidence-plan' })] },
            });
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.ProgressProbe, {
                  status: noChatStatus,
                  item: request('req-a', JOB_A),
                  workersOnly: true,
                  observedReleased: 1,
                })));
              await Promise.resolve();
            });
            const section = window.document.querySelector('section[aria-label="ChatGPT progress"]');
            assert(section, 'workersOnly with an action still renders the worker block');
            assert(section.getAttribute('data-workers-only') === 'true', 'workersOnly marks the section');
            assert(section.querySelectorAll('ol[aria-label="Application steps"]').length === 0, 'workersOnly never renders the stepper');
            assert(section.querySelectorAll('button[data-action="pause-and-save-job-search"]').length === 0, 'workersOnly never renders the pause block');
            assert(buttonByLabel(window, BRIDGE_UI_COPY.startChat), 'workersOnly still renders the start action button');

            // Live working chat, no pool, no action, no notice: render nothing.
            const liveStatus = status(2, {
              chat: { state: 'working', ordinal: 1, lastCallAt: NOW - 30000, jobsAssigned: 1, jobsCap: 2 },
              queue: { jobs: [job(JOB_A, { phase: 'awaiting', stage: 'review', servedToChat: 1, awaitingAnswer: true, servedAt: NOW - 60000 })] },
            });
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.React.StrictMode, null,
                bundle.module.React.createElement(bundle.module.ProgressProbe, {
                  status: liveStatus,
                  item: request('req-a', JOB_A, { stage: 'review' }),
                  workersOnly: true,
                  observedReleased: 1,
                })));
              await Promise.resolve();
            });
            assert(window.document.querySelector('section[aria-label="ChatGPT progress"]') === null, 'workersOnly with nothing actionable renders nothing');
            assert(entries.length === 0, `render must stay silent: ${entries.map(entry => entry.args.join(' ')).join(' | ')}`);
          } finally {
            await bundle.module.act(async () => rootNode.unmount());
          }
        }));
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
