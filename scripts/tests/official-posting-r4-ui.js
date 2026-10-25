import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { officialPostingDisplay } from '../../src/utils/officialPostingDisplay.js';
import { beginOfficialPostingPreparation, getOfficialPostingPreparation, subscribeOfficialPostingPreparation } from '../../src/utils/officialPostingPreparation.js';
import { applicationDockRequest, brokenApplicationDockRequest, workingApplicationDockRequest } from '../../src/utils/applicationHandoffDock.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withConsoleCollector } from './fixtures/handoff-bridge/renderHarness.js';

const posting = extra => ({ level: 'L4', outcome: 'link-only', employer: '', title: 'Platform Engineer',
  sourceUrl: 'https://careers.example.test/platform', officialApplyUrl: 'https://careers.example.test/platform/apply', trail: [], ...extra });
const job = extra => ({ hubId: 'board', careerSnapshotId: 'approved-snapshot', company: 'Acme Talent Partners',
  title: 'Scraped Platform Engineer', snippet: 'Synthetic scraped listing.', location: 'Lakeview, Canada',
  url: 'https://mirror.example.test/platform', postedBy: 'Acme Talent Partners', officialPosting: posting(), ...extra });
const buttons = window => [...window.document.querySelectorAll('button')];
const button = (window, text) => buttons(window).find(item => item.textContent.trim() === text);

async function cardBundle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'official-r4-card-'));
  const entry = path.join(directory, 'CardProbe.jsx');
  const source = file => JSON.stringify(path.resolve(file));
  await fs.writeFile(entry, `
import React from ${source('node_modules/react/index.js')};
import { ReactFlowProvider } from '@xyflow/react';
import { JobCardNode } from ${source('src/nodes/JobCardNode.jsx')};
import { CanvasNavigationContext } from ${source('src/contexts/CanvasNavigationContext.jsx')};
import { ModuleRunQueueContext } from ${source('src/contexts/moduleRunQueueShared.js')};
import { ToastProvider } from ${source('src/components/ToastProvider.jsx')};
export function CardProbe({navigation, queue, cards}) {
  return <ReactFlowProvider><CanvasNavigationContext.Provider value={navigation}><ModuleRunQueueContext.Provider value={queue}><ToastProvider>
    {cards.map((card, index) => <JobCardNode key={index} id={card.id} data={card.data} />)}
  </ToastProvider></ModuleRunQueueContext.Provider></CanvasNavigationContext.Provider></ReactFlowProvider>;
}
`);
  try { return { bundle: await bundleComponent(entry), directory }; }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

export default [
  {
    name: 'R4 unnamed L4 card and every dock item identify an unknown employer before the poster without changing job facts',
    run() {
      for (const postedBy of ['Acme Talent Partners', '', '  ']) {
        const data = job({ postedBy }); const before = structuredClone(data);
        const display = officialPostingDisplay(data);
        assert.equal(display.employer, ''); assert.equal(display.employerLabel, 'Employer unknown');
        assert.equal(display.postedBy, 'Acme Talent Partners'); assert.equal(display.via, 'via Acme Talent Partners');
        assert.equal(display.label, 'Employer unknown · via Acme Talent Partners');
        const node = { id: 'card-label', data: { ...data, localApplication: { id: 'local-label', status: 'queued' } } };
        for (const item of [applicationDockRequest({ node, handoff: { handoffCode: 'synthetic-code', prompt: 'Synthetic prompt' } }),
          brokenApplicationDockRequest({ node, message: 'Synthetic integrity message' }), workingApplicationDockRequest({ node })]) {
          assert.equal(item.label, display.label); assert.match(item.subject, /Employer unknown · via Acme Talent Partners$/u);
        }
        assert.deepEqual(data, before);
      }
      const noPoster = officialPostingDisplay(job({ company: '', postedBy: '' }));
      assert.equal(noPoster.label, 'Employer unknown'); assert.equal(noPoster.via, '');
      const noPosterNode = { id: 'card-no-poster', data: { ...job({ company: '', postedBy: '' }), localApplication: { id: 'local-no-poster' } } };
      for (const item of [applicationDockRequest({ node: noPosterNode, handoff: { handoffCode: 'synthetic-code', prompt: 'Synthetic prompt' } }),
        brokenApplicationDockRequest({ node: noPosterNode, message: 'Synthetic message' }), workingApplicationDockRequest({ node: noPosterNode })]) {
        assert.equal(item.label, 'Employer unknown');
      }
      const named = officialPostingDisplay(job({ officialPosting: posting({ employer: 'Northwind Labs' }) }));
      assert.equal(named.label, 'Northwind Labs'); assert.equal(named.via, 'via Acme Talent Partners');
      const l6 = officialPostingDisplay(job({ officialPosting: posting({ level: 'L6', outcome: 'not-found' }) }));
      assert.equal(l6.label, 'Acme Talent Partners'); assert.equal(l6.employerLabel, 'Acme Talent Partners'); assert.equal(l6.via, '');
      assert.equal(officialPostingDisplay(job({ officialPosting: null })).label, 'Acme Talent Partners');
    },
  },
  {
    name: 'R4 actual Generate lane label agrees with the shared display for unnamed L4 and retained named or legacy levels',
    async run() {
      const source = await fs.readFile(new URL('../../src/nodes/JobCardNode.jsx', import.meta.url), 'utf8');
      const start = source.indexOf('const unnamedOfficialEmployer =');
      const end = source.indexOf('lease = await acquireModuleRun({', start);
      assert.ok(start > 0 && end > start);
      const cases = [job(), job({ postedBy: '' }), job({ company: '', postedBy: '' }),
        ...['L1', 'L2', 'L3', 'L4', 'L5'].map(level => job({ officialPosting: posting({ level, employer: 'Northwind Labs' }) })),
        job({ officialPosting: posting({ level: 'L6', outcome: 'not-found' }) }), job({ officialPosting: undefined })];
      for (const data of cases) {
        const label = runInNewContext(`(() => { ${source.slice(start, end)} return applicationLabel; })()`, {
          preparedPosting: data.officialPosting, preparedPoster: data.postedBy, data,
        });
        assert.equal(label, officialPostingDisplay(data).label);
      }
    },
  },
  {
    name: 'R4 shared preparation claims are synchronous, canvas-scoped and retire only their own token',
    run() {
      let cancels = 0; let notices = 0;
      const unsubscribe = subscribeOfficialPostingPreparation(() => notices++);
      const args = { canvasFilePath: '/synthetic/one.json', nodeId: 'card', cancel: () => cancels++ };
      const first = beginOfficialPostingPreparation(args);
      const otherCanvas = beginOfficialPostingPreparation({ ...args, canvasFilePath: '/synthetic/two.json' });
      try {
        assert.equal(beginOfficialPostingPreparation(args), null);
        assert.equal(getOfficialPostingPreparation(args.canvasFilePath, args.nodeId), first);
        first.cancel(); first.cancel(); assert.equal(cancels, 1);
        assert.equal(beginOfficialPostingPreparation(args), null, 'Cancel retains ownership until the original asynchronous work settles');
        first.finish();
        const replacement = beginOfficialPostingPreparation(args);
        try {
          first.finish(); first.cancel();
          assert.equal(getOfficialPostingPreparation(args.canvasFilePath, args.nodeId), replacement);
          assert.equal(cancels, 1, 'a stale cancel cannot target replacement work');
          assert.ok(notices >= 4);
        } finally { replacement.finish(); }
      } finally { first.finish(); otherCanvas.finish(); unsubscribe(); }
      assert.equal(getOfficialPostingPreparation(args.canvasFilePath, args.nodeId), null);
    },
  },
  {
    name: 'R4 real JobCard remount retains Finding official posting and Cancel, fences a stale Generate callback and refuses a late cancelled success',
    async run() {
      const { bundle, directory } = await cardBundle();
      try {
        const { React, act, createRoot, CardProbe } = bundle.module;
        await withDom(async window => withConsoleCollector(async entries => {
          const data = job(); const before = structuredClone(data);
          const card = { id: 'remount-card', type: 'jobcard', data };
          const board = { id: 'board', type: 'jobboard', data: {} };
          const search = { id: 'search', type: 'jobhub', data: { careerSnapshotId: 'a'.repeat(64) } };
          let release; let prepares = 0; let queues = 0; let leases = 0; const cancels = []; const retired = [];
          window.electronAPI = {
            prepareOfficialPostingForGeneration: () => { prepares++; return new Promise(resolve => { release = resolve; }); },
            queueLocalApplication: async () => { queues++; return { success: false }; },
            cancelNodeTaskAndWait: async (...args) => { cancels.push(args); },
            completeNonApiAiRun: async id => { retired.push(id); },
          };
          const navigation = { getCurrentFile: () => '/synthetic/remount.json',
            enumerateAllNodes: () => [card, board, search], enumerateAllEdges: () => [{ source: 'board', target: 'search' }],
            updateNodeDataGlobally() {} };
          const queue = { snapshot: { active: null, activeRuns: [], queued: [] },
            acquireModuleRun: async () => { leases++; throw new Error('Cancelled preparation must never take a lane'); }, cancelQueuedRunsForNode() {} };
          const root = createRoot(window.document.getElementById('root'));
          const render = cards => act(async () => root.render(React.createElement(React.StrictMode, null,
            React.createElement(CardProbe, { navigation, queue, cards }))));
          try {
            await render([card, card]);
            assert.match(window.document.body.textContent, /Employer unknown/u);
            assert.match(window.document.body.textContent, /via Acme Talent Partners/u);
            const idle = buttons(window).filter(item => item.textContent.trim() === 'Generate');
            const stale = idle[1][Object.keys(idle[1]).find(key => key.startsWith('__reactProps$'))].onClick;
            await act(async () => idle[0].click());
            assert.equal(prepares, 1); assert.equal(button(window, 'Finding official posting…').disabled, true);
            await act(async () => stale({ stopPropagation() {} }));
            assert.equal(prepares, 1, 'a pre-render callback in another card instance is synchronously fenced');
            await render([]); await render([card]);
            assert.equal(button(window, 'Finding official posting…').disabled, true);
            assert.equal(button(window, 'Generate'), undefined);
            const cancel = button(window, 'Cancel'); assert.ok(cancel);
            await act(async () => { cancel.click(); cancel.click(); });
            assert.deepEqual(cancels, [['remount-card', 'official-posting-cancelled']]);
            await act(async () => release({ success: true, resolutionId: 'late-resolution', officialPosting: posting() }));
            assert.equal(queues, 0); assert.equal(leases, 0); assert.equal(prepares, 1); assert.equal(retired.length, 1);
            assert.equal(button(window, 'Generate').disabled, false);
            assert.deepEqual(data, before, 'transient ownership and cancellation never change the job projection');
          } finally { await act(async () => { release?.({ success: false, cancelled: true }); root.unmount(); }); }
          assert.deepEqual(entries, [], 'the real card lifecycle emits no React warnings');
        }));
      } finally { await bundle.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
    },
  },
];
