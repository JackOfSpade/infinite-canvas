// Bug-report diagnostics fixes from the 2026-11-22 report: each case pins one
// diagnostic so the report states only what was recorded.
import crypto from 'node:crypto';
import os from 'node:os';
import electronPkg from 'electron';
import { recordJobAnalysisRecoveryLifecycle } from '../../electron/ipc/jobAnalysisRecoveryLifecycle.js';
import {
  assert, buildJobCompletionAssessment, getJobAnalysisPaths, getJobsTelemetry, completeRunWithReceipt, fs, getManualScraperTelemetry, path,
  readLastRunReceipt, recordManualScraperTelemetry, resetManualScraperTelemetry, startRun,
} from '../test-dependencies.js';
import {
  SCORING_RECOVERY_SAVE_FAILURE_CAUSE, findScoringRecoverySaveFailure, formatReceiptTerminalCountReconciliation,
} from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { formatScrapePaceLine, notePacePanelWindowWait, resetScrapePace } from '../../electron/ipc/browser/manualScraper/scrapeTelemetry.js';
import { finishedWithSavedSourceWarning } from '../../electron/ipc/jobs/searchHandlers.js';

const repoFile = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
// Same one-way digest the lifecycle journal stores for owner/run ids.
const digest = value => `#${crypto.createHash('sha256').update(value).digest('hex').slice(0, 10)}`;

export default [
  {
    name: 'bugreport 2026-11-22 (a): a same-run failed oversize recovery save newer than the snapshot is the named cause',
    run: () => {
      const savedAt = 1_700_000_000_000;
      const row = {
        at: savedAt + 5_000, operation: 'snapshot-save', result: 'failed', reason: 'artifact-too-large',
        owner: digest('hub-1'), run: digest('run-1'),
      };
      const scope = { ownerId: 'hub-1', runId: 'run-1', receiptRunId: 'run-1', savedSnapshotCreatedAtMs: savedAt };
      assert(findScoringRecoverySaveFailure([row], scope) === row, 'the matching row is found');
      assert(findScoringRecoverySaveFailure([{ ...row, at: savedAt - 1 }], scope) === null, 'a failure older than the saved snapshot explains nothing');
      assert(findScoringRecoverySaveFailure([{ ...row, run: digest('run-2') }], scope) === null, 'another run is not this cause');
      assert(findScoringRecoverySaveFailure([{ ...row, owner: digest('hub-2') }], scope) === null, 'another owner is not this cause');
      assert(findScoringRecoverySaveFailure([{ ...row, reason: 'unknown' }], scope) === null, 'only a recorded too-large failure names the size limit');
      assert(findScoringRecoverySaveFailure([{ ...row, result: 'saved' }], scope) === null, 'a successful save is not a failure');
      assert(findScoringRecoverySaveFailure([row], { ...scope, receiptRunId: 'run-2' }) === null, 'a receipt for another run blocks the claim');
      assert(findScoringRecoverySaveFailure([], scope) === null && findScoringRecoverySaveFailure(null, scope) === null, 'no row, no cause');
      assert(SCORING_RECOVERY_SAVE_FAILURE_CAUSE.includes('128 MiB') && SCORING_RECOVERY_SAVE_FAILURE_CAUSE.includes('previous snapshot kept'),
        'the cause names the limit and that the previous snapshot was kept');
      const source = repoFile('electron/ipc/bugReport/jobsSnapshot.js');
      assert(/gaps\.push\(`scored \$\{scored\} ≠ saved score-ready \$\{snapshot\.jobs\}\$\{savedSnapshotFailureCause\(\)\}`\)/.test(source),
        'the scored-vs-saved gap carries the cause (and is still a gap, so the verdict stays non-green)');
      return { matched: true };
    },
  },
  {
    name: 'bugreport 2026-11-22 (b): receipt funnel names Job Preferences only when it reconciles and never names recovery without a merge',
    run: () => {
      const reconciled = formatReceiptTerminalCountReconciliation({
        terminalScoreReady: 120, kept: 149, recoveryNet: null, preferences: { filtered: 28, roleScreenBackstopDropped: 1 },
      });
      assert(reconciled === ' · − 28 removed by Job Preferences − 1 removed by the backstop role screen = 120 terminal score-ready', reconciled);
      const noBackstop = formatReceiptTerminalCountReconciliation({
        terminalScoreReady: 121, kept: 149, recoveryNet: null, preferences: { filtered: 28, roleScreenBackstopDropped: 0 },
      });
      assert(noBackstop === ' · − 28 removed by Job Preferences = 121 terminal score-ready', noBackstop);
      const unexplained = formatReceiptTerminalCountReconciliation({
        terminalScoreReady: 100, kept: 149, recoveryNet: null, preferences: { filtered: 28 },
      });
      assert(unexplained === ' · terminal score-ready 100 differs from kept 149; cause not recorded in this receipt', unexplained);
      const noTelemetry = formatReceiptTerminalCountReconciliation({ terminalScoreReady: 120, kept: 149, recoveryNet: null, preferences: null });
      assert(noTelemetry.includes('cause not recorded') && !/recovery/i.test(noTelemetry), 'without preferences the gap is stated with no cause');
      assert(formatReceiptTerminalCountReconciliation({ terminalScoreReady: 149, kept: 149, recoveryNet: null }) === '', 'equal counts need no suffix');
      assert(formatReceiptTerminalCountReconciliation({ terminalScoreReady: 120, kept: 149, recoveryNet: 3 }) === '', 'a recorded merge keeps its own recovery detail');
      const source = repoFile('electron/ipc/bugReport/jobsSnapshot.js');
      assert(!source.includes('later source recovery changed the terminal score-ready count'), 'the unconditional recovery suffix is gone');
      assert(source.includes('preferences: liveRunId && liveRunId === receipt.runId ? livePreferences : null'),
        'live preferences are used only when the live run is this receipt');
      return { reconciled: true };
    },
  },
  {
    name: 'bugreport 2026-11-22 (c): a source that was already blocked gets its own non-blocking finish note in telemetry',
    run: () => {
      const blocked = finishedWithSavedSourceWarning('blocked');
      assert(blocked.code === 'collection-finished-after-source-failure', 'blocked sources get a distinct code');
      assert(blocked.severity !== 'block' && ['info', 'warn'].includes(blocked.severity), 'a deliberate finish never gates');
      assert(/already stopped on a block or error earlier in this run/.test(blocked.evidence) && /not retried/.test(blocked.evidence), blocked.evidence);
      for (const status of ['pending', null, undefined]) {
        const pending = finishedWithSavedSourceWarning(status);
        assert(pending.code === 'collection-finished-with-saved-listings' && pending.severity === 'info'
          && pending.evidence === 'Provider collection was deliberately stopped; this source was not resumed.', `pending text unchanged for ${status}`);
      }
      const handlers = repoFile('electron/ipc/jobs/searchHandlers.js');
      assert(handlers.includes('|| finishedWithSavedWarningsBySource[sid] || null;'), 'the finish note fills bySource[sid].warning when no source warning exists');
      assert(!/sourceResults\[sourceId\]\.warnings[^\n]*finishedWithSavedSourceWarning/.test(handlers)
        && !/finishedWithSavedWarningsBySource[^\n]*\.warnings\.push/.test(handlers),
        'the finish note stays out of sourceResults warnings (card status / gating unchanged)');
      const report = repoFile('electron/ipc/bugReport/jobsSnapshot.js');
      assert(report.includes("'collection-finished-after-source-failure': 'had already stopped on a block or error earlier in this run; not retried after the finish'")
        && report.includes('collection deliberately finished with saved listings; unfinished source(s)'),
        'the report renders finish notes on their own line');
      return { blockedCode: blocked.code };
    },
  },
  {
    name: 'bugreport 2026-11-22 (d): each source keeps its first source-start and location rows; evictions are counted and reset',
    run: () => {
      resetManualScraperTelemetry();
      try {
        recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'glassdoor', srcName: 'Glassdoor' });
        recordManualScraperTelemetry({ phase: 'location-host-redirected', sourceId: 'glassdoor', intendedHost: 'www.glassdoor.com', landedHost: 'www.glassdoor.ca' });
        recordManualScraperTelemetry({ phase: 'source-start', sourceId: 'indeed', srcName: 'Indeed' });
        for (let i = 0; i < 40; i++) {
          recordManualScraperTelemetry({ phase: 'query-start', sourceId: 'glassdoor', queryIndex: i + 1, queryTotal: 40 });
          recordManualScraperTelemetry({ phase: 'reveal-finished', sourceId: 'glassdoor', queryIndex: i + 1, queryTotal: 40 });
        }
        const t = getManualScraperTelemetry();
        assert(t.origins.length === 24, `origin ring stays bounded (got ${t.origins.length})`);
        const firstStarts = t.origins.filter(e => e.phase === 'source-start').map(e => e.sourceId);
        assert(firstStarts.includes('glassdoor') && firstStarts.includes('indeed'), 'each source-start is pinned');
        assert(t.origins.some(e => e.phase === 'location-host-redirected' && e.landedHost === 'www.glassdoor.ca'), 'the location row is pinned');
        assert(t.origins.some(e => e.phase === 'query-start' && e.queryIndex === 40), 'the newest per-query rows are kept');
        assert(t.originsDropped === 3 + 80 - 24, `evictions are counted (got ${t.originsDropped})`);
        resetManualScraperTelemetry();
        assert(getManualScraperTelemetry().originsDropped === 0, 'the counter resets with the run');
      } finally {
        resetManualScraperTelemetry();
      }
      const report = repoFile('electron/ipc/bugReport/jobsSnapshot.js');
      assert(report.includes('earlier row${originsDropped === 1 ? \'\' : \'s\'} omitted') && !report.includes('these are emitted once per source'),
        'the heading no longer claims every row is once per source and prints the omitted count');
      return { pinned: true };
    },
  },
  {
    name: 'bugreport 2026-11-22 (e): Glassdoor panel request-limit waits reach the pace line',
    run: () => {
      resetManualScraperTelemetry();
      try {
        const pace0 = resetScrapePace('glassdoor', { srcName: 'Glassdoor' });
        assert(!formatScrapePaceLine(pace0).includes('panel request limit'), 'no waits, no clause');
        notePacePanelWindowWait('glassdoor', { srcName: 'Glassdoor', waitMs: 45_000 });
        const pace = notePacePanelWindowWait('glassdoor', { srcName: 'Glassdoor', waitMs: 90_000 });
        const line = formatScrapePaceLine(pace);
        assert(line.includes('panel request limit waits 2 (2m15s)'), line);
      } finally {
        resetManualScraperTelemetry();
      }
      const walker = repoFile('electron/ipc/browser/manualScraper/expandByPanel.js');
      assert(/panelWindowWaits\+\+;\n\s+panelWindowWaitedMs \+= waitMs;[\s\S]{0,300}notePacePanelWindowWait\(sourceId, \{ srcName: overlayBase\.srcName, waitMs \}\);/.test(walker),
        'waitForPanelWindow records each wait on the pace record');
      return { line: true };
    },
  },
  {
    name: 'bugreport 2026-11-22 (f): a resumed run receipt keeps the manifest durable start',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-receipt-start-'));
      const canvasPath = path.join(root, 'workspace.json');
      try {
        await startRun(canvasPath, { runId: 'resume-start-run', startedAt: 1_700_000_000_000, nodeId: 'hub-1', sourceIds: ['remoteok'] });
        const completed = await completeRunWithReceipt(canvasPath, {
          runId: 'resume-start-run', nodeId: 'hub-1', startedAt: 1_700_000_900_000, completedAt: 1_700_001_000_000,
          terminal: { status: 'completed', outcome: 'zero' },
        }, { expectedNodeId: 'hub-1' });
        assert(completed?.ok, 'receipt fixture completes');
        const receipt = await readLastRunReceipt(canvasPath, { nodeId: 'hub-1' });
        assert(receipt?.startedAt === 1_700_000_000_000, `manifest start wins over the resume moment (got ${receipt?.startedAt})`);
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
      return { durableStart: true };
    },
  },
  {
    name: 'bugreport 2026-11-22 (a) wiring: the Completion Assessment reads the lifecycle journal and names the failed scoring save',
    run: async () => {
      const telemetry = getJobsTelemetry();
      const keys = ['nodeId', 'search', 'pipeline', 'scoring', 'bucketing', 'history', 'resolves', 'preferences'];
      const saved = Object.fromEntries(keys.map(key => [key, telemetry[key]]));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-scoring-save-cause-'));
      try {
        const nodeId = 'save-cause-hub';
        const runId = 'save-cause-run';
        Object.assign(telemetry, { nodeId, search: null, pipeline: null, scoring: null, bucketing: null, history: null, resolves: null, preferences: null });
        const canvas = path.join(dir, 'canvas.json');
        const analysisPaths = getJobAnalysisPaths(canvas, path.join(dir, 'analysis'));
        fs.mkdirSync(path.dirname(analysisPaths.jsonPath), { recursive: true });
        // The durable save is the earlier, pre-preference one: 500 score-ready.
        const savedAt = Date.now() - 60_000;
        fs.writeFileSync(analysisPaths.jsonPath, JSON.stringify({
          runId, nodeId, sourceHubId: nodeId, canvasFilePath: canvas, createdAt: savedAt,
          jobs: Array.from({ length: 500 }, () => ({})), gatheredJobCount: 500,
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'canvas.jobs-last-run.json'), JSON.stringify({
          runId, nodeId, startedAt: savedAt - 60_000, completedAt: Date.now(),
          terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 120 },
          funnel: { raw: 600, relevanceDropped: 0, deduped: 560, ageDropped: 0, roleDropped: 60, historyDropped: 0, descriptionEvidenceDropped: 0, kept: 500 },
          scoring: { input: 120, selected: 120, scored: 120, placeholders: 0, unscored: 0, failedBatches: 0 },
          cleanup: { attempted: true, cleared: true },
        }), 'utf8');
        const lifecyclePath = path.join(electronPkg.app.getPath('userData'), 'job-search', 'analysis-recovery-lifecycle.json');

        const before = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(!before.includes(SCORING_RECOVERY_SAVE_FAILURE_CAUSE), 'no cause is stated without the lifecycle row');

        await recordJobAnalysisRecoveryLifecycle(lifecyclePath, {
          operation: 'snapshot-save', result: 'failed', reason: 'artifact-too-large',
          canvasFilePath: canvas, ownerId: nodeId, runId, gatheredJobCount: 120, candidatePoolJobCount: 500,
        });
        const after = buildJobCompletionAssessment(canvas, new Set([nodeId]));
        assert(after.includes(SCORING_RECOVERY_SAVE_FAILURE_CAUSE), `the failed save is named:\n${after.slice(0, 1500)}`);
        assert(after.split(SCORING_RECOVERY_SAVE_FAILURE_CAUSE).length === 2, 'stated once');
        assert(!after.includes('✅ **COMPLETE'), 'the verdict stays non-green');
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete telemetry[key];
          else telemetry[key] = saved[key];
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'bugreport 2026-11-22 (c) wiring: both finish-with-saved branches record each unfinished source\'s prior status and the note reaches telemetry',
    run: () => {
      const src = repoFile('electron/ipc/jobs/searchHandlers.js');
      const fill = /intentionallyUnfinishedPriorStatuses = Object\.fromEntries\(intentionallyUnfinishedSourceIds\s*\.map\(sourceId => \[sourceId, priorSources\[sourceId\]\?\.status \|\| null\]\)\);/g;
      const fills = [...src.matchAll(fill)].map(match => match.index);
      assert(fills.length === 2, `both the finish-receipt and already-finished branches fill the statuses (found ${fills.length})`);
      const finishBranch = src.indexOf('intentionallyUnfinishedSourceIds = Array.isArray(finishReceipt.unfinishedSourceIds)');
      const alreadyBranch = src.indexOf('} else if (alreadyFinishedWithSavedListings) {');
      assert(finishBranch > 0 && finishBranch < fills[0] && fills[0] < alreadyBranch && alreadyBranch < fills[1],
        'one fill sits in each branch, after its source list is set');
      assert(/finishedWithSavedSourceWarning\(intentionallyUnfinishedPriorStatuses\[sourceId\]\)/.test(src), 'the note is chosen from the prior status');
      assert(/\|\| finishedWithSavedWarningsBySource\[sid\] \|\| null;\s*bySource\[sid\] = \{/.test(src),
        'per-source telemetry falls back to the finish note, so the report never says "no retained warning"');
      assert(!/sourceResults\[sourceId\]\.warnings\.push\(finishedWithSavedSourceWarning/.test(src), 'the note stays out of card status and gating');
      const blocked = finishedWithSavedSourceWarning('blocked');
      assert(blocked.code === 'collection-finished-after-source-failure' && blocked.severity !== 'block');
    },
  },
];
