import { assert } from './testHelpers.js';
import {
  claudeUsageLimit, clearClaudeUsageLimit, recheckClaudeUsageAfterWake, reportClaudeUsageLimit,
  setClaudeAccountLayerForTest, waitForClaudeUsage,
} from '../../electron/ipc/claudePause.js';
import {
  claudePauseDiagnosticsMarkdown, recordClaudePauseEvent, resetClaudePauseDiagnosticsForTest,
} from '../../electron/ipc/claudePauseDiagnostics.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { applyBugReportCode } from '../../src/utils/bugReportCodes.js';

const HEADING = '## Claude Usage Pauses (CLAUDEPAUSE)';
const rowLines = markdown => markdown.split('\n').filter(line => /^- \d{4}-\d{2}-\d{2}T/u.test(line));

function clean() {
  clearClaudeUsageLimit();
  resetClaudePauseDiagnosticsForTest();
}

async function isched(run) {
  clean();
  try { return await run(); } finally { clean(); }
}

const settled = (promise, ms = 200) => Promise.race([
  promise.then(() => true),
  new Promise((resolve) => { const t = setTimeout(() => resolve(false), ms); t.unref?.(); }),
]);

// A two-account registry: the default account plus one added account, both signed in.
function accountFixture() {
  const accounts = [
    { id: 'default', isDefault: true, active: true, loggedIn: true, email: 'first@example.com', subscriptionType: 'max', limitedUntil: null, limitType: null },
    { id: 'acct-11112222', isDefault: false, active: false, loggedIn: true, email: 'second@example.com', subscriptionType: 'pro', limitedUntil: null, limitType: null },
  ];
  const limitedOf = list => list
    .filter(item => item.limitedUntil !== null && item.limitedUntil > Date.now())
    .map(item => ({ id: item.id, limitedUntil: item.limitedUntil, resetsAt: Number.isFinite(item.resetsAt) ? item.resetsAt : null, limitType: item.limitType }));
  const layer = {
    markClaudeAccountLimited(accountId, { resetsAt = null, limitType = null } = {}) {
      const at = Date.now();
      const target = accounts.find(item => item.id === (accountId ?? accounts.find(entry => entry.active)?.id));
      target.limitedUntil = Number.isFinite(resetsAt) && resetsAt > at ? resetsAt + 60_000 : at + 600_000;
      target.resetsAt = Number.isFinite(resetsAt) ? resetsAt : null;
      target.limitType = limitType;
      const limitedIds = new Set(limitedOf(accounts).map(item => item.id));
      const next = accounts.find(item => item.id !== target.id && !limitedIds.has(item.id));
      if (next) for (const item of accounts) item.active = item.id === next.id;
      return { nextAccountId: next ? next.id : null, accountId: target.id, limitedUntil: target.limitedUntil, limitType };
    },
    claudeAccountLimitState() {
      const limited = limitedOf(accounts);
      const limitedIds = new Set(limited.map(item => item.id));
      return {
        accountCount: accounts.length,
        activeId: accounts.find(item => item.active)?.id ?? accounts[0].id,
        accounts,
        limited,
        eligible: accounts.filter(item => !limitedIds.has(item.id) && item.loggedIn !== false),
      };
    },
    clearClaudeAccountLimits() {
      for (const item of accounts) { item.limitedUntil = null; item.limitType = null; item.resetsAt = null; }
    },
  };
  return { accounts, layer };
}

export default [
  {
    name: 'claude pause diagnostics: a reported usage limit records the reset time and task',
    run: () => isched(() => {
      const resetsAt = Date.now() + 3 * 3_600_000;
      reportClaudeUsageLimit({ resetsAt, task: 'career-compile' });
      const rows = rowLines(claudePauseDiagnosticsMarkdown({ current: claudeUsageLimit() }));
      assert(rows.length === 1 && rows[0].includes('· usage-limit ·'), 'one usage-limit row is recorded');
      assert(rows[0].includes(`resets ${new Date(resetsAt).toISOString()}`), 'the reset ISO time is in the row');
      assert(rows[0].includes('task career-compile'), 'the task id is in the row');
      const markdown = claudePauseDiagnosticsMarkdown({ current: claudeUsageLimit() });
      assert(/- Current: limited since .* resumes /u.test(markdown), 'the current line describes the active limit');
      assert(/- Current: not limited/u.test(claudePauseDiagnosticsMarkdown({ current: null })), 'no limit reads not limited');
    }),
  },
  {
    name: 'claude pause diagnostics: a wake re-check past the resume time clears the limit and wakes waiters',
    run: () => isched(async () => {
      reportClaudeUsageLimit({ resetsAt: Date.now() + 3_600_000 });
      const waiting = waitForClaudeUsage();
      recheckClaudeUsageAfterWake(claudeUsageLimit().resumeAt + 1);
      assert(claudeUsageLimit() === null, 'the expired limit is cleared');
      assert(await settled(waiting), 'the pending waiter is woken');
      const markdown = claudePauseDiagnosticsMarkdown();
      assert(markdown.includes('· wake-recheck · outcome cleared'), 'a cleared wake-recheck row is recorded');
      assert(markdown.includes('· resumed · reason wake-recheck'), 'a resumed row names the wake-recheck reason');
    }),
  },
  {
    name: 'claude pause diagnostics: a wake re-check before the resume time keeps the limit and re-arms it',
    run: () => isched(() => {
      reportClaudeUsageLimit({ resetsAt: Date.now() + 3_600_000 });
      const { resumeAt } = claudeUsageLimit();
      const now = resumeAt - 90_000;
      recheckClaudeUsageAfterWake(now);
      assert(claudeUsageLimit()?.resumeAt === resumeAt, 'the unexpired limit stays');
      const markdown = claudePauseDiagnosticsMarkdown();
      assert(markdown.includes('· wake-recheck · outcome rearmed · remaining 90000 ms'), 'the rearmed row carries the remaining time');
      assert(!markdown.includes('· resumed ·'), 'nothing resumed');
      clearClaudeUsageLimit();
      recheckClaudeUsageAfterWake();
      assert(claudePauseDiagnosticsMarkdown().includes('outcome not-limited'), 'a re-check with no limit is recorded');
    }),
  },
  {
    name: 'claude pause diagnostics: the ring keeps only the newest 40 rows and ignores unknown kinds',
    run: () => isched(() => {
      for (let i = 0; i < 55; i++) recordClaudePauseEvent({ kind: 'system-resume' });
      recordClaudePauseEvent({ kind: 'system-suspend' });
      recordClaudePauseEvent({ kind: 'unknown-kind' });
      recordClaudePauseEvent({ kind: 'resumed', reason: 'free-text' });
      const rows = rowLines(claudePauseDiagnosticsMarkdown());
      assert(rows.length === 40, `exactly 40 rows are retained, got ${rows.length}`);
      assert(rows[0].includes('· system-suspend'), 'newest row comes first');
      assert(!rows.some(row => row.includes('unknown-kind') || row.includes('free-text')), 'closed vocabulary only');
    }),
  },
  {
    name: 'claude pause diagnostics: included in FULL and CLAUDEPAUSE reports only',
    run: () => isched(() => {
      recordClaudePauseEvent({ kind: 'system-suspend' });
      const payload = { nodes: [], edges: [], drawings: [], eventLogs: [], description: 'Synthetic pause check' };
      for (const filterCode of ['FULL', 'CLAUDEPAUSE']) {
        const report = generateMarkdown({ ...payload, filterCode }).markdown;
        assert(report.includes(HEADING) && report.includes('· system-suspend'), `${filterCode} includes the pause section`);
      }
      assert(!generateMarkdown({ ...payload, filterCode: 'APPOUTPUT' }).markdown.includes(HEADING),
        'unrelated narrow reports omit the pause section');
      assert(applyBugReportCode([], {}, 'CLAUDEPAUSE').matchedCodes.includes('CLAUDEPAUSE'), 'CLAUDEPAUSE is a recognized filter');
    }),
  },
  {
    name: 'claude pause diagnostics: unknown fields and bad task ids never reach the report',
    run: () => isched(() => {
      const sentinel = 'PRIVATE-SENTINEL-/Users/me/secret';
      recordClaudePauseEvent({ kind: 'usage-limit', code: 'CLAUDE_USAGE_LIMIT', resumeAt: Date.now() + 1000, prompt: sentinel, error: sentinel, task: sentinel });
      recordClaudePauseEvent({ kind: 'system-suspend', path: sentinel, answer: sentinel });
      recordClaudePauseEvent({ kind: 'wake-recheck', outcome: sentinel, remainingMs: 5 });
      recordClaudePauseEvent({ kind: 'usage-limit', code: sentinel, task: 'a'.repeat(81) });
      const markdown = claudePauseDiagnosticsMarkdown();
      assert(!markdown.includes(sentinel) && !markdown.includes('SENTINEL'), 'sentinel text is not retained');
      assert(!markdown.includes('aaaaaaaa'), 'an over-long task id is dropped');
      assert(!markdown.includes('task '), 'no task is shown for invalid ids');
      assert(rowLines(markdown).length === 3, 'invalid outcome is rejected, valid rows kept');
    }),
  },
  {
    name: 'claude pause diagnostics: a second account with usage switches instead of pausing',
    run: () => isched(() => {
      const fixture = accountFixture();
      setClaudeAccountLayerForTest(fixture.layer);
      try {
        const resetsAt = Date.now() + 3_600_000;
        const first = reportClaudeUsageLimit({ resetsAt, task: 'job-scoring', limitType: 'five_hour' });
        assert(first.paused === false, 'the first limit switches accounts instead of pausing');
        assert(claudeUsageLimit() === null, 'no global limit is set while another account has usage');
        const switched = claudePauseDiagnosticsMarkdown({ current: null });
        assert(switched.includes('· account-switch · five_hour · account 1/2 -> 2/2'), 'the switch row carries ordinals only');
        assert(!switched.includes('example.com'), 'no account email reaches the report');
        assert(!switched.includes('acct-11112222'), 'no account id reaches the report');
        assert(!switched.includes('· usage-limit ·'), 'a switch is not a pause');

        const second = reportClaudeUsageLimit({ resetsAt: resetsAt + 600_000, limitType: 'seven_day' });
        assert(second.paused === true, 'the last account limit pauses every call');
        const limit = claudeUsageLimit();
        assert(limit.limitType === 'seven_day' && limit.accountCount === 2, 'the pause names the window and the account count');
        assert(limit.resumeAt === fixture.accounts[0].limitedUntil, 'the earliest account reset wins');
        assert(second.resumeAt === limit.resumeAt, 'the report returns the earliest resume time');
        const pausedRow = rowLines(claudePauseDiagnosticsMarkdown({ current: limit }))[0];
        assert(pausedRow.includes('limit seven_day') && pausedRow.includes('accounts 2'), 'the pause row carries the window and count');

        clearClaudeUsageLimit('resume-now');
        assert(fixture.accounts.every(item => item.limitedUntil === null), 'resume now clears every account limit');
      } finally {
        setClaudeAccountLayerForTest(null);
      }
    }),
  },
  {
    name: 'claude pause diagnostics: one account still pauses with its own reset time',
    run: () => isched(() => {
      const fixture = accountFixture();
      fixture.layer.claudeAccountLimitState = () => {
        const at = Date.now();
        const [only] = fixture.accounts;
        const limited = only.limitedUntil !== null && only.limitedUntil > at
          ? [{ id: only.id, limitedUntil: only.limitedUntil, resetsAt: only.resetsAt ?? null, limitType: only.limitType }]
          : [];
        return { accountCount: 1, activeId: only.id, accounts: [only], limited, eligible: limited.length ? [] : [only] };
      };
      setClaudeAccountLayerForTest(fixture.layer);
      try {
        const resetsAt = Date.now() + 3_600_000;
        const reported = reportClaudeUsageLimit({ resetsAt, task: 'job-scoring', limitType: 'five_hour' });
        assert(reported.paused === true, 'a lone account pauses');
        assert(claudeUsageLimit().resetsAt === resetsAt, 'the provider reset time is kept');
        assert(claudeUsageLimit().accountCount === 1, 'the pause names the account count');
        const markdown = claudePauseDiagnosticsMarkdown();
        assert(!markdown.includes('· account-switch ·'), 'no switch is recorded');
      } finally {
        setClaudeAccountLayerForTest(null);
      }
    }),
  },
];
