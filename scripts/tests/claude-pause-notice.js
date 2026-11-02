import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withTimeout } from './fixtures/practice-connector/harness.js';
import {
  CLAUDE_TASK_PAUSE_CODES,
  CLAUDE_TASK_STATUS_CHANNEL,
  claudeTaskStatusView,
  claudeTaskWorkerStatus,
  createClaudeTaskWorker,
  registerClaudeTaskStatusHandler,
} from '../../electron/ipc/claudeTaskWorker.js';
import { CLAUDE_PAUSE_COPY, claudePauseNotice } from '../../src/utils/claudeTaskPause.js';
import { applyClaudeTaskStatus, getClaudeTaskStatus, subscribeClaudeTaskStatus } from '../../src/utils/claudeTaskStatusStore.js';

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const source = path => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

export default [
  {
    name: 'claude pause notice: the status view carries only a known pause code',
    run() {
      for (const code of CLAUDE_TASK_PAUSE_CODES) {
        assert.deepEqual({ ...claudeTaskStatusView({ pauseCode: code }) }, { paused: true, pauseCode: code });
      }
      assert.deepEqual({ ...claudeTaskStatusView({ pauseCode: 'CLAUDE_ERROR' }) }, { paused: false, pauseCode: null });
      assert.deepEqual({ ...claudeTaskStatusView(undefined) }, { paused: false, pauseCode: null });
      assert.equal(claudeTaskWorkerStatus().paused, false, 'a worker that never started is not paused');
    },
  },
  {
    name: 'claude pause notice: a usage limit reaches the status view and clears after an answer',
    async run() {
      let clock = 1000;
      const pending = new Map([['a', { requestId: 'a', handoffCode: 'code-a', task: 'job-scoring', hasAttachments: false }]]);
      let limited = true;
      const worker = createClaudeTaskWorker({
        seam: {
          list: () => ({ handoffs: [...pending.values()], settlingRequestIds: [], retryAfterMs: 0 }),
          read: () => ({ ok: true, prompt: 'p' }),
          assigned: () => true,
          attachments: async () => ({ attachments: [] }),
          submit: async ({ requestId }) => { pending.delete(requestId); return { outcome: 'accepted' }; },
          returnToPerson: () => true,
          onEvent: () => () => {},
        },
        binding: () => ({ binary: 'claude', env: {}, cwd: '/tmp' }),
        now: () => clock,
        setTimer: (fn, ms) => ({ fn, ms }),
        clearTimer: () => {},
        runStage: async () => {
          if (limited) throw Object.assign(new Error('x'), { code: 'CLAUDE_USAGE_LIMIT' });
          return { text: 'answer', model: 'claude-sonnet-5-5', usage: {}, costUsd: 0 };
        },
      });
      worker.start();
      await settle();
      assert.equal(claudeTaskStatusView(worker.status(), true).pauseCode, 'CLAUDE_USAGE_LIMIT');
      limited = false;
      clock += 11 * 60_000;
      worker.pump();
      await settle();
      assert.equal(pending.size, 0, 'the held-up work is answered once Claude is usable');
      assert.equal(claudeTaskStatusView(worker.status(), true).paused, false, 'an answer ends the notice');
    },
  },
  {
    name: 'claude pause notice: one IPC channel returns the status, and the preload exposes it',
    async run() {
      const handlers = new Map();
      const removed = [];
      registerClaudeTaskStatusHandler({
        ipcMain: { removeHandler: channel => removed.push(channel), handle: (channel, fn) => handlers.set(channel, fn) },
        status: () => ({ active: true, paused: true, pauseCode: 'CLAUDE_NOT_SIGNED_IN' }),
      });
      assert.deepEqual(removed, [CLAUDE_TASK_STATUS_CHANNEL]);
      assert.deepEqual(await handlers.get(CLAUDE_TASK_STATUS_CHANNEL)(), { active: true, paused: true, pauseCode: 'CLAUDE_NOT_SIGNED_IN' });
      assert(source('electron/preload.js').includes(`getClaudeTaskStatus: () => ipcRenderer.invoke('${CLAUDE_TASK_STATUS_CHANNEL}')`));
      assert(source('electron/main.js').includes('registerClaudeTaskStatusHandler({ ipcMain: electronPkg.ipcMain })'));
    },
  },
  {
    name: 'claude pause notice: shows a short line with the reason only while paused',
    run() {
      assert.equal(claudePauseNotice(null), null);
      assert.equal(claudePauseNotice({ active: true, paused: false, pauseCode: null }), null);
      assert.equal(claudePauseNotice({ paused: true, pauseCode: 'SOMETHING_ELSE' }), null, 'an unknown code is not shown');
      for (const code of CLAUDE_TASK_PAUSE_CODES) {
        const notice = claudePauseNotice({ active: true, paused: true, pauseCode: code });
        assert.equal(notice.headline, CLAUDE_PAUSE_COPY.headline);
        assert(notice.headline.includes('paused') && notice.headline.includes('resume'));
        assert(notice.reason.length > 20 && !notice.reason.includes('ChatGPT'));
      }
    },
  },
  {
    name: 'claude pause notice: the dock status store notifies only on a real change',
    run() {
      let calls = 0;
      const stop = subscribeClaudeTaskStatus(() => { calls += 1; });
      try {
        applyClaudeTaskStatus({ active: true, paused: true, pauseCode: 'CLAUDE_USAGE_LIMIT' });
        applyClaudeTaskStatus({ active: true, paused: true, pauseCode: 'CLAUDE_USAGE_LIMIT' });
        assert.equal(calls, 1);
        assert.equal(getClaudeTaskStatus().pauseCode, 'CLAUDE_USAGE_LIMIT');
        applyClaudeTaskStatus(null);
        assert.equal(getClaudeTaskStatus().paused, false);
      } finally { stop(); }
      assert(source('src/components/NonApiAiDialog.jsx').includes('<ClaudePauseNotice'), 'the global dock renders the notice');
    },
  },
  {
    name: 'claude pause notice: a handoff held by the worker renders as Claude working, with no controls',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-claude-working-'));
      const entry = path.join(directory, 'WorkingProbe.jsx');
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { ClaudeWorkingRow } from ${JSON.stringify(path.resolve('src/components/ClaudeProgress.jsx'))};\nexport function WorkingProbe() { return React.createElement(ClaudeWorkingRow); }\n`);
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 8000);
        await withDom(async window => {
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.WorkingProbe));
              await Promise.resolve();
            });
            const region = window.document.querySelector('section[aria-label="Claude progress"]');
            assert(region, 'the working row is a labelled Claude progress region');
            assert.equal(region.textContent.trim(), 'Claude is working on this handoff');
            assert.equal(window.document.querySelectorAll('button, a, input, select').length, 0, 'the row has no controls');
          } finally { await bundle.module.act(async () => rootNode.unmount()); }
        });
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'claude pause notice: the dock answers every worker-routed handoff with the Claude working row, not a bridge panel',
    run() {
      const dock = source('src/components/NonApiAiDialog.jsx');
      assert(dock.includes('<ClaudeWorkingRow />'), 'the dock renders the Claude working row');
      assert(dock.indexOf('isMcpRoutedRequest && (') < dock.indexOf('<ClaudeWorkingRow />'), 'the row sits inside the worker-routed branch');
      assert(!/ChatGPT|handoffBridge|BridgeProgress/.test(dock), 'the dock names no ChatGPT or bridge component');
    },
  },
];
