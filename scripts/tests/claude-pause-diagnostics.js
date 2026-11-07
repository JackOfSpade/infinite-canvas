import { assert } from './testHelpers.js';
import {
  claudeUsageLimit, clearClaudeUsageLimit, recheckClaudeUsageAfterWake, reportClaudeUsageLimit, waitForClaudeUsage,
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
];
