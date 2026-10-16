import assert from 'node:assert/strict';
import { recordCareerCompilationProgress, careerCompilationProgressForRequest } from '../../src/utils/careerCompilationProgress.js';
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
              progress: { phase: 'auditing', completed: 3, total: 6, round: 2, startedAt: Date.now() - 125000 },
              onPauseAndSave: () => paused++,
            })));
            assert.match(window.document.body.textContent, /Auditing career data · round 2/);
            assert.match(window.document.body.textContent, /3\/6 checks returned · 2m 5s elapsed/);
            const progress = window.document.querySelector('[role="progressbar"]');
            assert.equal(progress.getAttribute('aria-valuenow'), '3'); assert.equal(progress.getAttribute('aria-valuemax'), '6');
            await act(async () => window.document.querySelector('button').click());
            assert.equal(paused, 1);
            await act(async () => root.render(React.createElement(CareerCompilationProgress, {
              progress: { phase: 'repairing', round: 3, startedAt: Date.now() },
            })));
            assert.match(window.document.body.textContent, /Repairing career data · round 3/);
            assert.equal(window.document.querySelector('[role="progressbar"]'), null, 'unknown work has no invented percentage');
          } finally { await act(async () => root.unmount()); }
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
