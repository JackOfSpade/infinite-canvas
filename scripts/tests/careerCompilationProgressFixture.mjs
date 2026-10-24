import assert from 'node:assert/strict';
import { recordCareerCompilationProgress, careerCompilationProgressForRequest, deriveCareerCompilationProgress } from '../../src/utils/careerCompilationProgress.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

export default [
  {
    name: 'Popup progress correlates exact node and run, bounds history, and falls back to the selected task',
    run() {
      let progress = recordCareerCompilationProgress(new Map(), { nodeId: 'first', manualAiRunId: 'run', phase: 'auditing', completed: 3, total: 6, prompt: 'must-not-retain' });
      assert.equal(careerCompilationProgressForRequest({ nodeId: 'first', runId: 'run', task: 'career-profile-audit-skills' }, progress).completed, 3);
      assert.deepEqual(careerCompilationProgressForRequest({ nodeId: 'second', runId: 'run', task: 'career-profile-compile' }, progress), { phase: 'compiling' });
      assert.deepEqual(careerCompilationProgressForRequest({ nodeId: 'first', runId: 'new-run', task: 'career-profile-repair' }, progress), { phase: 'repairing' });
      assert.equal(careerCompilationProgressForRequest({ task: 'job-scoring' }, progress), null);
      assert(!JSON.stringify([...progress]).includes('must-not-retain'));
      for (let i = 0; i < 100; i++) progress = recordCareerCompilationProgress(progress, { nodeId: `hub-${i}`, manualAiRunId: 'run', phase: 'compiling' });
      assert.equal(progress.size, 64);
    },
  },
  {
    name: 'Career progress scopes measured counts to the action and separates run and action clocks',
    run() {
      const audit = deriveCareerCompilationProgress({ phase: 'auditing', round: 2, completed: 6, total: 6,
        startedAt: 1000, phaseStartedAt: 111000 }, 126000);
      assert.equal(audit.label, 'Auditing career data · round 2');
      assert.equal(audit.countLabel, '6/6 audit checks returned this round');
      assert.equal(audit.totalElapsed, 125);
      assert.equal(audit.actionElapsed, 15);
      assert.match(audit.detail, /can still contain findings/);
      const repairing = deriveCareerCompilationProgress({ phase: 'repairing', round: 2, completed: 6, total: 6 });
      assert.equal(repairing.countLabel, null, 'audit counts cannot be repurposed as repair completion');
      for (const counts of [{ completed: -1, total: 6 }, { completed: 7, total: 6 }, { completed: 0.5, total: 6 }, { completed: 0, total: 0 }]) {
        assert.equal(deriveCareerCompilationProgress({ phase: 'compiling', ...counts }).countLabel, null);
      }
      const cached = deriveCareerCompilationProgress({ phase: 'cleaning', cached: true });
      assert.match(cached.detail, /previously approved/);
      assert.equal(cached.countLabel, null);
      assert.equal(cached.totalElapsed, null);
      assert.equal(cached.actionElapsed, null, 'no fabricated clock when only a handoff task is known');
      let recorded = recordCareerCompilationProgress(new Map(), {
        nodeId: 'first', manualAiRunId: 'run', phase: 'auditing', startedAt: 1000, phaseStartedAt: 11000, round: 1,
      });
      recorded = recordCareerCompilationProgress(recorded, {
        nodeId: 'first', manualAiRunId: 'run', phase: 'repairing', phaseStartedAt: 21000, round: 1,
      });
      const replay = careerCompilationProgressForRequest({ nodeId: 'first', runId: 'run', task: 'career-profile-repair' }, recorded);
      assert.equal(replay.startedAt, 1000, 'later stage updates retain the known total start');
      assert.equal(replay.phaseStartedAt, 21000);
    },
  },
  {
    name: 'Career compilation progress renders real stage counts, repairs, elapsed time, and pause action',
    async run() {
      const bundle = await bundleComponent('src/components/CareerCompilationProgress.jsx');
      try {
        await withDom(async window => {
          const { React, createRoot, act, CareerCompilationProgress } = bundle.module;
          const root = createRoot(window.document.getElementById('root'));
          let paused = 0;
          try {
            await act(async () => root.render(React.createElement(CareerCompilationProgress, {
              progress: { phase: 'auditing', completed: 3, total: 6, round: 2, startedAt: Date.now() - 125000, phaseStartedAt: Date.now() - 15000 },
              onPauseAndSave: () => paused++,
            })));
            assert.match(window.document.body.textContent, /Auditing career data · round 2/);
            assert.match(window.document.body.textContent, /3\/6 audit checks returned this round/);
            assert.match(window.document.body.textContent, /Total elapsed: 2m 5s/);
            assert.match(window.document.body.textContent, /This action: 0m 15s/);
            assert.equal(window.document.querySelector('ol'), null, 'current phase cannot prove earlier phases completed');
            const progress = window.document.querySelector('[role="progressbar"]');
            assert.equal(progress.getAttribute('aria-valuenow'), '3'); assert.equal(progress.getAttribute('aria-valuemax'), '6');
            await act(async () => window.document.querySelector('button').click());
            assert.equal(paused, 1);
            await act(async () => root.render(React.createElement(CareerCompilationProgress, {
              progress: { phase: 'repairing', round: 3, startedAt: Date.now() },
            })));
            assert.match(window.document.body.textContent, /Repairing career data · round 3/);
            assert.equal(window.document.querySelector('[role="progressbar"]'), null, 'unknown work has no invented percentage');
            assert(!window.document.body.textContent.includes('3/6'), 'earlier-round counts are cleared during repairs');
            await act(async () => root.render(React.createElement(CareerCompilationProgress, {
              progress: { phase: 'cleaning', cached: true },
            })));
            assert.match(window.document.body.textContent, /Using previously approved career data/);
            assert(!window.document.body.textContent.includes('elapsed'), 'recovered tasks with unknown start show no timer');
          } finally { await act(async () => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'Career processing cards show live host actions for exact node/run ownership without persisting progress',
    async run() {
      const bundle = await bundleComponent('scripts/tests/fixtures/career-progress-surfaces.mjs');
      try {
        const { React, createRoot, act, ToastProvider, JobSearchProcessingState, JobSearchDoneState, JobBoardCareerOverridePanel } = bundle.module;
        const surfaces = [
          [JobSearchProcessingState, runId => ({ hubState: 'parsing', nodeId: 'career-hub', careerRunId: runId })],
          [JobSearchDoneState, runId => ({ locked: true, careerCleared: true, careerCompiling: true, careerNodeId: 'career-hub', careerRunId: runId, savedJobCount: 4 })],
          [JobBoardCareerOverridePanel, runId => ({ nodeId: 'career-hub', view: { state: 'compiling', pending: { manualAiRunId: runId, fileNames: ['Synthetic career.txt'] } } })],
        ];
        for (const [Component, propsFor] of surfaces) await withDom(async window => {
          const listeners = new Set();
          window.electronAPI = { onCareerCompileProgress: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
          const root = createRoot(window.document.getElementById('root'));
          const render = runId => act(async () => root.render(React.createElement(ToastProvider, null,
            React.createElement(Component, propsFor(runId)))));
          const publish = event => act(async () => { for (const listener of listeners) listener(event); });
          const text = () => window.document.querySelector('[aria-label="Career compilation progress"]')?.textContent || '';
          try {
            await render('career-run');
            assert.match(text(), /Processing career data/);
            assert(!text().includes('elapsed'), 'unknown provenance supplies no clock or completion claim');
            await publish({ nodeId: 'other-hub', manualAiRunId: 'career-run', phase: 'auditing', completed: 99, total: 100 });
            assert(!text().includes('99/100'));
            await publish({ nodeId: 'career-hub', manualAiRunId: 'career-run', phase: 'auditing', round: 2, completed: 3, total: 6,
              startedAt: Date.now() - 125000, phaseStartedAt: Date.now() - 15000 });
            assert.match(text(), /Auditing career data · round 2/);
            assert.match(text(), /3\/6 audit checks returned this round/);
            assert.match(text(), /Total elapsed:/);
            assert.match(text(), /This action:/);
            await publish({ nodeId: 'career-hub', manualAiRunId: 'career-run', phase: 'repairing', round: 2 });
            assert.match(text(), /Repairing career data · round 2/);
            assert(!text().includes('3/6'), 'the previous audit bar is not reused as repair progress');
            await render('replacement-run');
            assert.match(text(), /Processing career data/);
            await publish({ nodeId: 'career-hub', manualAiRunId: 'career-run', phase: 'auditing', completed: 99, total: 100 });
            assert(!text().includes('99/100'), 'events from the retired run cannot leak into the replacement');
            await publish({ nodeId: 'career-hub', manualAiRunId: 'replacement-run', phase: 'saving' });
            assert.match(text(), /Saving approved career data/);
            assert.equal(listeners.size, 1, 'ownership changes replace the live subscription');
          } finally {
            await act(async () => root.unmount());
            assert.equal(listeners.size, 0, 'cards release progress listeners on unmount');
          }
        });
      } finally { await bundle.dispose(); }
    },
  },
  {
    name: 'Queued processing search exposes Cancel instead of Pause and save',
    async run() {
      const bundle = await bundleComponent('src/nodes/jobsearch/JobSearchProcessingState.jsx');
      try {
        await withDom(async window => {
          const { React, createRoot, act, JobSearchProcessingState } = bundle.module;
          const root = createRoot(window.document.getElementById('root'));
          let cancelled = 0; let paused = 0;
          try {
            await act(async () => root.render(React.createElement(JobSearchProcessingState, {
              chromeLaunchInfo: { port: 9222, terminalCommand: 'stale launch info' },
              hubState: 'queued', statusLabel: 'Queued', queuedRun: { label: 'Job search', position: 2 },
              onCancelQueued: () => cancelled++, onPauseAndSave: () => paused++,
            })));
            assert.match(window.document.body.textContent, /Position 2/);
            const button = window.document.querySelector('button');
            assert.equal(button.textContent, 'Cancel queued work');
            await act(async () => button.click());
            assert.equal(cancelled, 1); assert.equal(paused, 0);
          } finally { await act(async () => root.unmount()); }
        });
      } finally { await bundle.dispose(); }
    },
  },
];
