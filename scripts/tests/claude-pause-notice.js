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
import { CLAUDE_PAUSE_COPY, claudeLimitLabel, claudePauseNotice, claudeUsageLimitNotice } from '../../src/utils/claudeTaskPause.js';
import { normalizeClaudeTaskActivity } from '../../src/utils/claudeTaskActivityStore.js';
import { claudeAccountAddMessage } from '../../src/utils/claudeAccountsActions.js';
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
        tavily: { readKey: async () => '', plainLeads: async () => [] },
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
      await fsPromises.writeFile(entry, `import React from 'react';\nimport { ClaudeTaskProgress } from ${JSON.stringify(path.resolve('src/components/ClaudeProgress.jsx'))};\nimport { applyClaudeTaskActivity } from ${JSON.stringify(path.resolve('src/utils/claudeTaskActivityStore.js'))};\nexport { applyClaudeTaskActivity };\nexport function WorkingProbe() { return React.createElement(ClaudeTaskProgress, { requestId: 'a' }); }\n`);
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
            assert.match(region.textContent, /Waiting for Claude to pick this up/);
            assert.equal(window.document.querySelectorAll('button, a, input, select').length, 0, 'the row has no controls');
            await bundle.module.act(async () => {
              bundle.module.applyClaudeTaskActivity({ running: 1, waiting: 0, tasks: { a: {
                state: 'running', phase: 'tool', tool: 'WebSearch', target: 'Acme careers', model: 'opus', effort: 'low', round: 1,
                toolTurns: 3, maxTurns: 16, firstStartedAt: Date.now() - 65000, phaseStartedAt: Date.now() - 5000, lastActivityAt: Date.now() - 1000,
                steps: [{ at: Date.now() - 5000, label: 'Searching the web: Acme careers' }],
              } } });
            });
            assert.match(region.textContent, /Searching the web/);
            assert.match(region.textContent, /Web research turn 3 of 16/);
            assert.match(region.textContent, /Total elapsed: 1 min/);
            assert.equal(window.document.querySelector('ol li span').textContent, 'Searching the web: Acme careers');
            assert.equal(window.document.querySelectorAll('button, a, input, select').length, 0, 'live steps add no controls');
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
      assert(dock.includes('<ClaudeTaskProgress requestId={activeRequest.requestId} />'), 'the dock renders live Claude progress');
      assert(dock.indexOf('isMcpRoutedRequest && (') < dock.indexOf('<ClaudeTaskProgress requestId={activeRequest.requestId} />'), 'the row sits inside the worker-routed branch');
      assert(!/ChatGPT|handoffBridge|BridgeProgress/.test(dock), 'the dock names no ChatGPT or bridge component');
    },
  },
  {
    name: 'claude pause notice: the usage-limit headline names the limit kind',
    run() {
      const base = { resumeAt: Date.parse('2026-02-03T15:20:00Z'), knownReset: true, accountCount: 1 };
      const headlines = [
        ['five_hour', 'Claude 5-hour limit reached'],
        ['seven_day', 'Claude weekly limit reached'],
        ['seven_day_opus', 'Claude weekly Opus limit reached'],
        ['seven_day_sonnet', 'Claude weekly Sonnet limit reached'],
        ['seven_day_overage_included', 'Claude extra usage limit reached'],
        ['overage', 'Claude extra usage limit reached'],
      ];
      for (const [limitType, headline] of headlines) {
        assert.equal(claudeUsageLimitNotice({ ...base, limitType }).headline, headline, `${limitType} has its own headline`);
      }
      assert.equal(claudeUsageLimitNotice({ ...base, limitType: 'mystery' }).headline, 'Claude usage limit reached');
      assert.equal(claudeUsageLimitNotice({ ...base, limitType: null }).headline, 'Claude usage limit reached');
      assert.equal(claudeUsageLimitNotice(null), null);
      assert.notEqual(
        claudeUsageLimitNotice({ ...base, limitType: 'five_hour' }).headline,
        claudeUsageLimitNotice({ ...base, limitType: 'seven_day' }).headline,
        'two limit kinds never share a headline',
      );
    },
  },
  {
    name: 'claude pause notice: the reason names the blocked account or how many are limited',
    run() {
      const limit = { resumeAt: Date.parse('2026-02-03T15:20:00Z'), knownReset: true, limitType: 'seven_day', accountCount: 1 };
      const ada = { id: 'a', isDefault: true, active: true, loggedIn: true, email: 'ada@example.com', subscriptionType: 'pro', limitedUntil: null, limitType: 'seven_day' };
      const single = claudeUsageLimitNotice(limit, [ada]);
      assert(single.reason.includes('All finished work is saved and nothing was lost.'), 'the saved-work sentence survives');
      assert(single.reason.includes('Signed in as ada@example.com (Pro).'), 'the one blocked account is named with its plan');
      assert(single.reason.includes('Add another Claude account to keep working now.'), 'the way out is offered');
      assert(!single.reason.includes('All 1'), 'one account is named, not counted');
      const noPlan = claudeUsageLimitNotice(limit, [{ ...ada, subscriptionType: null }]);
      assert(noPlan.reason.includes('Signed in as ada@example.com.'), 'no plan means no parenthesis');
      assert(!noPlan.reason.includes('ada@example.com ('), 'a missing plan leaves no empty parenthesis');
      const anonymous = claudeUsageLimitNotice(limit, [{ ...ada, email: null }]);
      assert(!anonymous.reason.includes('Signed in as'), 'an unnamed account is not announced');
      assert(anonymous.reason.includes('Add another Claude account to keep working now.'));
      const guessing = claudeUsageLimitNotice({ ...limit, knownReset: false }, []);
      assert(guessing.reason.includes('Claude did not say when usage resets'), 'an unknown reset time is admitted');
      const both = claudeUsageLimitNotice({ ...limit, limitType: null, accountCount: 2 }, []);
      assert(both.reason.includes('All 2 signed-in Claude accounts are at their limit.'), 'two accounts are counted');
      assert(!both.reason.includes('Signed in as'), 'a count is not a single email');
      assert.equal(both.headline, 'Claude usage limit reached');
      const bothNamed = claudeUsageLimitNotice({ ...limit, accountCount: 2 }, [ada]);
      assert(bothNamed.reason.includes('All 2 signed-in Claude accounts are at their limit.'), 'the count wins over one named account');
      assert(!bothNamed.reason.includes('ada@example.com'));
    },
  },
  {
    name: 'claude pause notice: limit labels map every limit kind to the short word the panel reuses',
    run() {
      const labels = [
        ['five_hour', '5-hour'], ['seven_day', 'weekly'], ['seven_day_opus', 'weekly Opus'],
        ['seven_day_sonnet', 'weekly Sonnet'], ['seven_day_overage_included', 'extra usage'], ['overage', 'extra usage'],
      ];
      for (const [limitType, label] of labels) assert.equal(claudeLimitLabel(limitType), label);
      assert.equal(claudeLimitLabel(null), 'usage');
      assert.equal(claudeLimitLabel('unheard_of'), 'usage');
      assert.equal(claudeLimitLabel(undefined), 'usage');
    },
  },
  {
    name: 'claude pause notice: activity normalization keeps only CONTRACT account fields',
    run() {
      const snapshot = normalizeClaudeTaskActivity({
        claudeAccounts: [
          { id: 'acc-1', isDefault: true, active: true, loggedIn: true, email: 'ada@example.com', subscriptionType: 'pro', limitedUntil: 1700000000000, limitType: 'five_hour', dir: '/Users/ada/.claude-2', token: 'secret-token' },
          { id: 'acc-2', isDefault: false, active: false, loggedIn: null, email: null, subscriptionType: null, limitedUntil: null, limitType: 'unheard_of' },
          { id: '', email: 'nobody@example.com' },
          'not-an-account',
        ],
        usageLimit: { resumeAt: 1700000000000, resetsAt: 1700000000000, limitType: 'seven_day', accountCount: 2, dir: '/Users/ada/.claude' },
      });
      assert.equal(snapshot.claudeAccounts.length, 2, 'an account without an id is dropped');
      assert.deepEqual({ ...snapshot.claudeAccounts[0] }, {
        id: 'acc-1', isDefault: true, active: true, loggedIn: true, email: 'ada@example.com',
        subscriptionType: 'pro', limitedUntil: 1700000000000, limitType: 'five_hour',
      });
      assert.equal(snapshot.claudeAccounts[1].limitType, null, 'an unknown limit kind is dropped');
      assert.equal(snapshot.claudeAccounts[1].loggedIn, null);
      assert(Object.isFrozen(snapshot.claudeAccounts) && Object.isFrozen(snapshot.claudeAccounts[0]));
      assert(!JSON.stringify(snapshot.claudeAccounts).includes('/Users/'), 'no account directory reaches the renderer');
      assert(!JSON.stringify(snapshot.claudeAccounts).includes('secret-token'), 'no token reaches the renderer');
      assert.deepEqual({ ...snapshot.usageLimit }, { resumeAt: 1700000000000, knownReset: true, limitType: 'seven_day', accountCount: 2 });
      assert.equal(normalizeClaudeTaskActivity(null).claudeAccounts.length, 0);
      assert.equal(normalizeClaudeTaskActivity({}).claudeAccounts.length, 0);
      const many = normalizeClaudeTaskActivity({ claudeAccounts: Array.from({ length: 12 }, (_, index) => ({ id: `acc-${index}` })) });
      assert.equal(many.claudeAccounts.length, 10, 'at most ten accounts are kept');
      const long = normalizeClaudeTaskActivity({ claudeAccounts: [{ id: 'i'.repeat(80), email: `${'e'.repeat(300)}@example.com`, subscriptionType: 'p'.repeat(80), limitType: 'five_hour' }] });
      assert.equal(long.claudeAccounts[0].id.length, 60);
      assert.equal(long.claudeAccounts[0].email.length, 200);
      assert.equal(long.claudeAccounts[0].subscriptionType.length, 40);
    },
  },
  {
    name: 'claude pause notice: the add-account result reads as one short line',
    run() {
      assert.equal(claudeAccountAddMessage({ ok: true, account: { email: 'ada@example.com' } }), 'Added ada@example.com.');
      assert.equal(claudeAccountAddMessage({ ok: true, account: {} }), 'Added the account.');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'duplicate' }), 'That account is already added.');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'cli-missing' }), 'Claude Code is not installed.');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'timeout' }), 'Sign-in timed out.');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'cancelled' }), null, 'a cancelled sign-in says nothing');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'busy', message: 'Another sign-in is already open.' }), 'Another sign-in is already open.');
      assert.equal(claudeAccountAddMessage({ ok: false, reason: 'failed' }), 'Sign-in did not finish.');
      assert.equal(claudeAccountAddMessage(null), 'Sign-in did not finish.');
    },
  },
  {
    name: 'claude pause notice: the accounts panel lists accounts and removes only a non-default one',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-claude-accounts-'));
      const entry = path.join(directory, 'AccountsProbe.jsx');
      await fsPromises.writeFile(entry, `export { ClaudeAccountsPanel } from ${JSON.stringify(path.resolve('src/components/ClaudeAccountsPanel.jsx'))};\n`);
      const controller = new AbortController();
      let bundle;
      try {
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 8000);
        await withDom(async window => {
          const limitedUntil = Date.now() + 60 * 60 * 1000;
          const accounts = [
            { id: 'acc-1', isDefault: true, active: false, loggedIn: true, email: 'ada@example.com', subscriptionType: 'pro', limitedUntil, limitType: 'seven_day' },
            { id: 'acc-2', isDefault: false, active: true, loggedIn: true, email: 'grace@example.com', subscriptionType: 'max', limitedUntil: null, limitType: null },
          ];
          const removed = [];
          const confirmations = [];
          window.confirm = message => { confirmations.push(message); return true; };
          window.electronAPI = {
            listClaudeAccounts: async () => accounts,
            removeClaudeAccount: async id => { removed.push(id); return { ok: true }; },
          };
          const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
          const rootNode = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => {
              rootNode.render(bundle.module.React.createElement(bundle.module.ClaudeAccountsPanel));
              await flush();
            });
            const region = window.document.querySelector('section[aria-label="Claude accounts"]');
            assert(region, 'the panel is a labelled Claude accounts section');
            assert(region.textContent.includes('The app uses the first signed-in account that has usage left'), 'the help sentence explains failover');
            assert(region.textContent.includes('ada@example.com') && region.textContent.includes('grace@example.com'), 'both accounts are listed');
            assert(region.textContent.includes('Pro') && region.textContent.includes('Max'), 'each plan is labelled');
            assert.match(region.textContent, /Limited until .+ \(weekly\)/, 'a limited account says until when');
            const rowOf = node => { let row = node; while (row && !/@example\.com/.test(row.textContent)) row = row.parentElement; return row; };
            const badges = [...region.querySelectorAll('span')].filter(node => node.textContent === 'In use');
            assert.equal(badges.length, 1, 'exactly one account is marked in use');
            assert(rowOf(badges[0]).textContent.includes('grace@example.com'), 'the active account carries the badge');
            assert(!rowOf(badges[0]).textContent.includes('ada@example.com'));
            const buttons = [...region.querySelectorAll('button')];
            const removeButtons = buttons.filter(node => node.textContent.trim() === 'Remove');
            assert.equal(removeButtons.length, 1, 'the default account cannot be removed');
            assert(rowOf(removeButtons[0]).textContent.includes('grace@example.com'), 'the removable account is the non-default one');
            assert(buttons.some(node => node.textContent.trim() === 'Add account'), 'the panel offers Add account');
            await bundle.module.act(async () => {
              removeButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
              await flush();
            });
            assert.equal(confirmations.length, 1, 'removal asks for confirmation first');
            assert(confirmations[0].includes('grace@example.com'));
            assert.deepEqual(removed, ['acc-2'], 'the confirmed account is removed');
          } finally { await bundle.module.act(async () => rootNode.unmount()); }
        });
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
];
