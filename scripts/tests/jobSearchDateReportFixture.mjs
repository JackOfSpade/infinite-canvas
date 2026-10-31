import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildJobSearchDateHistory } from '../../electron/ipc/bugReport/jobSearchDates.js';
import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import { lastRunReceiptPathForCanvas } from '../../electron/ipc/jobRunStaging.js';
import { applyBugReportCode } from '../../src/utils/bugReportCodes.js';
import { jobSearchDateDiagnosticPatch } from '../../src/utils/jobSearchDateDiagnostics.js';

const startedAt = Date.UTC(2026, 9, 6, 5, 26);
const completedAt = Date.UTC(2026, 9, 6, 5, 30);
const laterAt = Date.UTC(2026, 9, 27, 20);
const runId = 'b108efaf-2102-4202-b647-f1b029af5390-1793131200000';
const hubId = 'c412fdfa-04c0-4567-a38b-c8992089b58a';

function clearedHub() {
  let data = { lastCompletedRunAt: completedAt, lastSearchCoverageStartedAt: startedAt };
  data = { ...data, ...jobSearchDateDiagnosticPatch(data, {
    event: 'collection', reason: 'unfinished-sources', runId, recordedAt: laterAt,
    searchResult: { collectionStartedAt: laterAt - 1000, collectionCompletedAt: laterAt, hasUnfinishedSources: true },
  }) };
  data = { ...data, ...jobSearchDateDiagnosticPatch(data, {
    event: 'finalization', reason: 'partial-collection', runId, recordedAt: laterAt + 1000,
  }) };
  data = { ...data, ...jobSearchDateDiagnosticPatch(data, {
    event: 'clear', reason: 'clear-scrape', runId, recordedAt: laterAt + 2000,
  }), hubState: 'empty', scoredJobs: null };
  return { id: hubId, type: 'jobhub', data };
}

export default [
  {
    name: 'JOBDATES renders saved nested clear history and refuses private diagnostic fields',
    run() {
      const hub = clearedHub();
      hub.data.jobSearchDateDiagnostics[0].prompt = 'PRIVATE_PROMPT';
      hub.data.jobSearchDateDiagnostics.push({ version: 1, event: 'finalization', reason: 'PRIVATE_REASON', recordedAt: laterAt });
      hub.data.resumeProfile = { name: 'PRIVATE_CAREER' };
      const nodes = JSON.parse(JSON.stringify([{ type: 'canvas', data: { canvasData: { nodes: [hub] } } }]));
      const report = buildJobSearchDateHistory(nodes);
      assert.match(report, /current last scraped 2026-10-06T05:30:00\.000Z/);
      assert.match(report, /reason `clear-scrape`/);
      assert.match(report, /reason `partial-collection`/);
      assert.match(report, /Collection: `unfinished-sources`/);
      assert.match(report, /2026-10-06T05:30:00\.000Z → 2026-10-06T05:30:00\.000Z/);
      assert(report.indexOf('`clear-scrape`') < report.indexOf('`partial-collection`'), 'newest evidence is first');
      for (const privateValue of [hubId, runId, 'PRIVATE_PROMPT', 'PRIVATE_REASON', 'PRIVATE_CAREER']) {
        assert(!report.includes(privateValue), `must not export ${privateValue}`);
      }
    },
  },
  {
    name: 'JOBDATES explicitly reports legacy, invalid, and bounded collection history',
    run() {
      const hub = clearedHub();
      const invalid = { ...hub, id: 'invalid-hub', data: { lastCompletedRunAt: 'PRIVATE_TIMESTAMP', jobSearchDateDiagnostics: [{ event: 'PRIVATE_EVENT' }] } };
      const legacy = { id: 'legacy-hub', type: 'jobhub', data: { lastCompletedRunAt: completedAt } };
      hub.data.jobSearchDateDiagnostics = Array.from({ length: 20 }, (_, index) => ({ ...hub.data.jobSearchDateDiagnostics[0], recordedAt: laterAt + index }));
      const level = [hub, invalid, legacy];
      level.push({ type: 'canvas', data: { canvasData: { nodes: level } } });
      const report = buildJobSearchDateHistory(level);
      assert.equal((report.match(/reason `unfinished-sources`/g) || []).length, 8);
      assert.equal((report.match(/Date decisions: not retained/g) || []).length, 2);
      assert(!report.includes('PRIVATE_TIMESTAMP') && !report.includes('PRIVATE_EVENT'));
      assert.match(buildJobSearchDateHistory(undefined), /No Job Search module metadata was available/);
    },
  },
  {
    name: 'FULL and JOBDATES include retained date decisions and full partial or unknown terminal collection evidence',
    run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-job-date-report-'));
      const canvas = path.join(dir, 'canvas.json');
      const receiptPath = lastRunReceiptPathForCanvas(canvas, hubId);
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      const base = {
        description: 'Clear Scrape kept a date.', nodes: [clearedHub()], edges: [], drawings: [],
        frontEndState: { currentFile: canvas }, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
      };
      try {
        for (const disposition of ['full', 'user-finished-partial', 'unfinished-sources', 'unknown']) {
          const receipt = {
            runId, nodeId: hubId, startedAt: laterAt - 1000, completedAt: laterAt,
            terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 66 },
            cleanup: { attempted: true, cleared: true },
            ...(disposition === 'unknown' ? {} : { collectionDiagnostics: {
              disposition, startedAt: laterAt - 1000, completedAt: laterAt,
              unfinishedSourceCount: disposition === 'full' ? 0 : 1, private: 'PRIVATE_HOST_TEXT',
            } }),
          };
          fs.writeFileSync(receiptPath, JSON.stringify(receipt));
          for (const code of ['FULL', 'JOBDATES']) {
            const filtered = applyBugReportCode([], base, code);
            assert.equal(filtered.unknownCodes.length, 0);
            assert(!filtered.sectionExclusions.has('nodes'), 'date reports retain nested node metadata');
            const payload = { ...base, filterCode: code, filterStats: { omittedSections: [...filtered.sectionExclusions] } };
            for (const excluded of filtered.sectionExclusions) delete payload[excluded];
            const report = generateMarkdown(payload).markdown;
            assert.match(report, /## Job Search Date History \(JOBDATES\)/);
            assert.match(report, /reason `clear-scrape`/);
            assert.match(report, /## Job Recovery Diagnostics/);
            assert(report.includes(`Collection evidence: \`${disposition}\``));
            if (disposition === 'unknown') assert.match(report, /older or missing evidence cannot establish full collection/);
            assert(!report.includes('PRIVATE_HOST_TEXT'));
          }
        }
        const unrelated = generateMarkdown({ ...base, filterCode: 'UI' }).markdown;
        assert(!unrelated.includes('## Job Search Date History (JOBDATES)'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
