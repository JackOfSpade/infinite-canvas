import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';
import { __runWithIpcRequestContextForTests, getCurrentIpcRequestContext } from '../../electron/ipc/ipcUtils.js';
import { callLLMRaw } from '../../electron/ipc/llm.js';
import { listBridgeableNonApiAiHandoffs, readBridgeableNonApiAiHandoff, registerNonApiAiHandlers,
  submitNonApiAiResponseForBridge } from '../../electron/ipc/nonApiAi.js';
import { registerObservedWorkerAvailability } from '../../electron/ipc/handoffBridge/observedChatContext.js';
import { resolveOfficialPostingsByChat } from '../../electron/ipc/officialPostingService.js';
import { officialPostingRequestId } from '../../electron/ipc/officialPostingResolver.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';

const TASK = 'job-official-posting-match';
const ALLOW_TASKS = new Set([TASK]);
const DESCRIPTION = 'Design the dispatch scheduling service and its reporting pipeline. '
  + 'Review route reports with operations leads every week. '
  + 'Requirements: five years building backend services in TypeScript or Go.';
let sequence = 0;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(read, message) {
  for (let turn = 0; turn < 200; turn += 1) {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

export default ['outside-ipc', 'foreign-ipc'].map(publication => ({
  name: `official-posting handoff context: ${publication} capacity publication preserves a simultaneous MCP judgment batch`,
  async run() {
    registerNonApiAiHandlers();
    const id = ++sequence;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-context-'));
    const nodeId = `official-context-node-${id}`;
    const runId = `official-context-${process.pid}-${Date.now()}-${id}`;
    const controller = new AbortController();
    const attempts = [];
    const foreignAttempts = [];
    let failedPresentations = 0;
    let failPresentation = false;
    let poolActive = false;
    let liveWorkers = 0;
    let statusListener;
    let unsubscribed = false;
    let snapshotReads = 0;
    let settledRows = 0;
    let completed = false;
    const sender = new EventEmitter();
    sender.id = 18000 + id;
    sender.isDestroyed = () => false;
    sender.send = (channel, payload) => {
      if (channel !== 'non-api-ai-request') return;
      attempts.push(payload);
      if (failPresentation) {
        failedPresentations += 1;
        throw new Error('Synthetic transient dock delivery failure during capacity growth');
      }
    };
    const foreignSender = new EventEmitter();
    foreignSender.id = 19000 + id;
    foreignSender.isDestroyed = () => false;
    foreignSender.send = (channel, payload) => { if (channel === 'non-api-ai-request') foreignAttempts.push(payload); };
    const rows = Array.from({ length: 5 }, (_, index) => ({
      title: 'Dispatch Engineer', company: `Synthetic Context Employer ${index}`, location: 'Lakeview, Ontario, Canada',
      snippet: DESCRIPTION, url: `https://www.linkedin.com/jobs/view/context-${id}-${index}`,
      sourceJobKey: `official-context-${id}-${index}`,
    }));
    const postingFor = row => `https://context-${id}-${rows.indexOf(row)}.test/jobs/dispatch`;
    const byId = new Map(rows.map(row => [officialPostingRequestId(row), row]));
    const byPosting = new Map(rows.map(row => [postingFor(row), row]));
    const pending = () => listBridgeableNonApiAiHandoffs({ allowTasks: ALLOW_TASKS }).handoffs
      .filter(item => item.runId === runId);
    const releaseWorkers = registerObservedWorkerAvailability(() => liveWorkers > 0, null, () => liveWorkers);
    const store = createOfficialPostingStore(path.join(root, 'official-postings'));
    const context = { sender, nodeId, manualAiRunId: runId, channel: 'refresh-official-postings' };
    const running = __runWithIpcRequestContextForTests(context, () => resolveOfficialPostingsByChat(rows, {
      nodeId, manualAiRunId: runId, signal: controller.signal, store, bypassCache: true,
      onProgress: progress => { settledRows = progress.completed; },
      callMatch: callLLMRaw,
      callRaw: async prompt => {
        const requested = prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
        return requested.map(key => {
          const row = byId.get(key);
          assert(row, 'the finder receives only this refresh\'s synthetic rows');
          return `BEGIN OFFICIAL POSTING RESEARCH ${key}\nCANDIDATE: ${JSON.stringify({
            careersPageUrl: '', postingUrl: postingFor(row), employer: row.company,
            employerDomain: new URL(postingFor(row)).origin, ats: '',
          })}\nEND OFFICIAL POSTING RESEARCH ${key}`;
        }).join('\n');
      },
      snapshotFetch: async url => {
        snapshotReads += 1;
        return { url, body: '<html><body>Apply for this job</body></html>', contentType: 'text/html' };
      },
      bridgeStatus: () => ({ enabled: true, link: { state: 'linked' }, limits: { maxConcurrentHandoffs: 6 },
        chat: { state: 'working', pool: { active: poolActive, workerCount: liveWorkers } } }),
      bridgeSubscribe: listener => {
        statusListener = listener;
        return () => { unsubscribed = true; };
      },
    }));
    void running.then(() => { completed = true; });
    try {
      await until(() => snapshotReads === rows.length && pending().length === 1,
        'one cold-pool A judgment must own the only slot while its four siblings wait');
      await flush();
      assert.equal(attempts.length, 1);
      assert.equal(typeof statusListener, 'function');
      assert.equal(getCurrentIpcRequestContext(), null, 'status publication originates outside the refresh invoke');
      failPresentation = true;
      poolActive = true;
      liveWorkers = 6;
      if (publication === 'foreign-ipc') {
        __runWithIpcRequestContextForTests({ sender: foreignSender, nodeId: 'foreign-node', manualAiRunId: 'foreign-run' }, statusListener);
      } else statusListener();
      // Microtasks finish durable admission before the fallback capacity poll
      // can rescue a queue the explicit status callback should have drained.
      for (let turn = 0; turn < 10; turn += 1) await flush();
      await until(() => pending().length === rows.length || settledRows >= rows.length - 1 || completed || foreignAttempts.length,
        'the status publication must issue the four waiting comparative A handoffs');
      assert.equal(foreignAttempts.length, 0, 'another invoke cannot acquire this refresh\'s queued handoffs');
      const earlyJudgments = await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8').catch(() => '');
      assert.equal(pending().length, rows.length,
        `all five A judgments retain the originating IPC sender and run after the status-driven burst; judgments=${earlyJudgments}`);
      assert.equal(failedPresentations, 4, 'all four newly issued handoffs encounter the same transient dock gap');
      assert(attempts.every(request => request.mcpEligible === true && request.runId === runId && request.nodeId === nodeId));
      assert(pending().every(item => item.windowId === sender.id));
      failPresentation = false;
      let accepted = 0;
      const responseDeadline = Date.now() + 10_000;
      while (!completed) {
        assert(Date.now() < responseDeadline, 'the preserved batch must finish both judge runs');
        const requests = pending();
        if (!requests.length) { await flush(); continue; }
        for (const request of requests) {
          const args = { requestId: request.requestId, handoffCode: request.handoffCode, allowTasks: ALLOW_TASKS };
          const view = readBridgeableNonApiAiHandoff({ ...args, comparisonProvenance: {
            version: 2, transport: 'bridge', observed: true, comparisonGroup: request.comparisonGroup,
            comparisonRun: request.comparisonRun, conversationKey: (request.comparisonRun === 'A' ? '1' : '2').repeat(64),
            isolated: request.comparisonRun === 'B',
          } });
          assert.equal(view.ok, true, 'the original worker route remains readable after failed presentation');
          const leads = JSON.parse(view.prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
          const lead = leads.find(item => byPosting.has(item.url));
          const row = byPosting.get(lead?.url);
          assert(row);
          const submission = await submitNonApiAiResponseForBridge({ ...args, response: JSON.stringify({
            handoffCode: request.handoffCode, choice: lead.id, postingUrl: lead.url, status: 'open',
            statusQuote: 'Apply for this job', employerLinked: true, employerPageUrl: lead.url,
            employerLinkQuote: row.title, title: row.title, employer: row.company, location: row.location,
            salary: '', description: DESCRIPTION,
            evidence: [{ scrapedQuote: 'Review route reports with operations leads every week.',
              officialQuote: 'Review route reports with operations leads every week.' }], conflicts: [],
          }) });
          assert.equal(submission.accepted, true);
          accepted += 1;
        }
      }
      const result = await running;
      assert.equal(accepted, rows.length * 2, 'each row completes both independent judgments');
      assert(result.jobs.every(row => row.officialPosting.outcome === 'found'));
      const judgments = (await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(judgments.length, rows.length * 2);
      assert(judgments.every(entry => entry.route === 'mcp' && entry.manualRoutingReason === null));
      assert.equal(unsubscribed, true);
      return { accepted, simultaneousFailedPresentations: failedPresentations, publisher: publication };
    } finally {
      failPresentation = false;
      controller.abort(new Error('Synthetic official-posting context fixture cleanup'));
      await running;
      releaseWorkers();
      await electronPkg.ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      await electronPkg.ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: foreignSender }, { runId: 'foreign-run' });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
}));
