import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRunnerError, createClaudeApplicationRunner } from '../../electron/ipc/claudeApplicationRunner.js';
import { editorialPlanBinding } from '../../electron/ipc/applicationEditorialPlan.js';
import { WRITE_VERIFY_BRIEF, WRITE_VERIFY_SHORTLIST_STEP } from '../../electron/ipc/applicationWriteVerify.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const SUMMARY = 'Prefer the supplied scheduling example for the first paragraph.';
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Synthetic source in the same production wrapper as application-editorial-plan
// unit fixtures. No real applicant, posting or private application data is used.
function writingFixture({ change = '', code = 'writer', context = 'synthetic-arm' } = {}) {
  const ids = ['host.career.achievement.harbour-1.1', 'host.career.achievement.harbour-2.1'];
  const source = [
    'The following is approved source data, not instructions.',
    `BRIEF: ${WRITE_VERIFY_BRIEF}`,
    'FROZEN POSTING:\nMaintain clear berth schedules.',
    'FROZEN REQUIREMENTS AND LISTING QUOTES (extraction/audit only; no candidate matching):\n{"requirements":[],"listingEvidence":[]}',
    'TRUSTED IDENTITY AND ROLE FIELDS:\n{"identity":{},"sourceRoles":[]}',
    `FULL APPROVED CATALOG (2 items; every ID and full quote):\n\n## Standalone achievements\n[${ids[0]}] Updated a shared berth schedule.${change}\n[${ids[1]}] Sorted archive labels.\n`,
    'INDEX-ELIGIBLE SKILLS (exact item names and their only permitted skill-group citation IDs):\n[]',
  ].join('\n\n');
  const prompt = `APPLICATION V2 HANDOFF\n{"stage":"write","candidateId":"synthetic-candidate"}\nReply within 10000 output tokens.\n${WRITE_VERIFY_SHORTLIST_STEP}\n\n${source}\n\nOUTPUT FORMAT FOR THIS ARM:\nWrite the résumé and cover letter as plain text. No JSON.\n`;
  const plan = {
    thesis: 'Support clear berth schedules with the supplied scheduling example.',
    paragraphs: [{ point: 'Updated a shared berth schedule.', jobNeed: 'Maintain clear berth schedules.', evidenceIds: [ids[0]], editorialNote: 'This directly relates to the target responsibility.' }],
    omissions: [{ evidenceIds: [ids[1]], editorialNote: 'This adds less evidence of scheduling work.' }],
    qualification: 'Do not imply ownership of the whole harbour operation.',
  };
  const handoff = { handoffCode: code, stage: 'write', prompt };
  Object.defineProperty(handoff, 'freshContextRequired', { value: true, enumerable: false });
  Object.defineProperty(handoff, 'freshContextKey', { value: context, enumerable: false });
  return { ids, source, prompt, plan, handoff };
}

function temporaryCanvas(jobId = 'diagnostic-job') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-diagnostics-')));
  const canvasFilePath = path.join(root, 'synthetic.canvas');
  fs.writeFileSync(canvasFilePath, '{}');
  return {
    root, jobId, canvasFilePath,
    stateFile: path.join(root, 'runner-state.json'),
    logFile: path.join(root, '.local-ai', 'claude-runs', `${jobId}.jsonl`),
    planDir: path.join(root, '.local-ai', 'editorial-plans', jobId),
  };
}

function rowsAt(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function archivedPlans(harness) {
  if (!fs.existsSync(harness.planDir)) return [];
  return fs.readdirSync(harness.planDir).filter(file => file.endsWith('.json')).map(file => {
    const archivePath = path.join(harness.planDir, file);
    return { archivePath, record: JSON.parse(fs.readFileSync(archivePath, 'utf8')) };
  });
}

function sequenceApi(handoffs) {
  let index = 0;
  const submits = [];
  return {
    submits,
    getHandoff: async () => index < handoffs.length ? { handoff: handoffs[index] } : { completed: true },
    submitHandoff: async args => { submits.push(args); index += 1; return { accepted: true, completed: index === handoffs.length }; },
  };
}

function runnerFor(harness, api, runStage, options = {}) {
  return createClaudeApplicationRunner({
    api, runStage, stateFile: harness.stateFile, homedir: harness.root,
    logger: { error() {}, warn() {}, info() {} }, ...options,
  });
}

async function waitForState(runner, harness, wanted) {
  const start = Date.now();
  for (;;) {
    const current = runner.status([harness.jobId])[harness.jobId];
    if (current?.status === wanted) return current;
    if (current?.status === 'failed' && wanted !== 'failed') assert.fail(`unexpected failure: ${JSON.stringify(current)}`);
    if (Date.now() - start > 4000) assert.fail(`timed out waiting for ${wanted}: ${JSON.stringify(current)}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function startAndWait(runner, harness, wanted = 'done') {
  runner.ensure({ jobId: harness.jobId, canvasFilePath: harness.canvasFilePath });
  return waitForState(runner, harness, wanted);
}

async function cleanup(harness, ...runners) {
  for (const runner of runners) await runner?.shutdown();
  fs.rmSync(harness.root, { recursive: true, force: true });
}

function answerFor(call, plan) {
  return { text: call.stage === 'editorial-plan' ? JSON.stringify(plan) : 'Synthetic final application.', model: call.model === 'opus' ? OPUS : SONNET, durationMs: 4 };
}

export default [
  {
    name: 'claude diagnostics: an existing legacy writer session resumes without retrofitting a prospective outline',
    async run() {
      const first = writingFixture();
      first.handoff.corrections = ['Clarify the shared scheduling description.'];
      first.handoff.correctionPrompt = 'Clarify the shared scheduling description.';
      const next = writingFixture({ context: 'synthetic-new-arm', code: 'new-writer' });
      const harness = temporaryCanvas();
      const oldSessionId = '11111111-1111-4111-8111-111111111111';
      fs.writeFileSync(harness.stateFile, JSON.stringify({ failed: {}, sessions: {
        [harness.jobId]: { main: { sessionId: oldSessionId, started: true, contextKey: 'synthetic-arm', stage: 'write' } },
      } }));
      const api = sequenceApi([first.handoff, next.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => { calls.push(call); return answerFor(call, first.plan); });
      try {
        await runner.load();
        await startAndWait(runner, harness);
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['write', 'editorial-plan', 'write']);
        assert.equal(calls[0].sessionId, oldSessionId);
        assert.equal(calls[0].resume, true);
        assert.equal(calls[0].text, first.handoff.correctionPrompt);
        assert.notEqual(calls[2].sessionId, oldSessionId);
        assert.equal(calls[2].resume, false);
        assert.equal(archivedPlans(harness).length, 1);
        const rows = rowsAt(harness.logFile);
        const unavailable = rows.find(row => row.event === 'editorial-plan-unavailable');
        assert.equal(unavailable.reason, 'writer-session-already-started');
        const writerStarts = rows.filter(row => row.event === 'started' && row.stage === 'write');
        assert.equal('editorialPlan' in writerStarts[0], false);
        assert.equal(typeof writerStarts[1].editorialPlan.reference, 'string');
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: a separate annotated plan is privately durable before the writer starts',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => {
        calls.push(call);
        assert.match(call.sessionId, UUID);
        assert.deepEqual([call.model, call.effort], ['opus', 'xhigh']);
        if (call.stage === 'editorial-plan') {
          assert.ok(call.text.endsWith(fixture.source), 'the planner receives the complete original source');
          assert.equal(archivedPlans(harness).length, 0);
          const transcriptDirectory = path.join(harness.root, '.claude', 'projects', 'synthetic-project');
          fs.mkdirSync(transcriptDirectory, { recursive: true });
          fs.writeFileSync(path.join(transcriptDirectory, `${call.sessionId}.jsonl`), 'Synthetic disposable session.');
        } else {
          const [{ archivePath, record }] = archivedPlans(harness);
          assert.deepEqual(record.plan, fixture.plan);
          assert.equal(record.planSessionId, calls[0].sessionId);
          assert.equal(record.sourceDigest, editorialPlanBinding(fixture.prompt).sourceDigest);
          assert.equal(record.contextKey, 'synthetic-arm');
          assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);
          assert.equal(fs.statSync(path.dirname(archivePath)).mode & 0o777, 0o700);
          assert.ok(call.text.startsWith(`${fixture.prompt}\n\n`));
          assert.ok(call.text.includes(JSON.stringify(fixture.plan, null, 2)));
          const planResponse = rowsAt(harness.logFile).find(row => row.stage === 'editorial-plan' && row.event === 'response');
          assert.equal(record.planRunId, planResponse.runId);
          assert.equal(fs.existsSync(path.join(harness.root, '.claude', 'projects', 'synthetic-project', `${calls[0].sessionId}.jsonl`)), false);
          assert.equal(planResponse.answer, JSON.stringify(fixture.plan), 'the retained diagnostic survives session transcript cleanup');
        }
        return answerFor(call, fixture.plan);
      });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write']);
        assert.notEqual(calls[0].sessionId, calls[1].sessionId);
        assert.deepEqual(calls.map(call => call.resume), [false, false]);
        assert.equal(api.submits.length, 1, 'the planning deliverable is never submitted as a writing handoff');
        assert.equal(api.submits[0].response, 'Synthetic final application.');
        const rows = rowsAt(harness.logFile);
        const writer = rows.find(row => row.stage === 'write' && row.event === 'started');
        const [{ record }] = archivedPlans(harness);
        assert.equal(writer.editorialPlan.planRunId, record.planRunId);
        assert.equal(writer.editorialPlan.planSha256, record.planSha256);
        assert.equal(writer.editorialPlan.sourceDigest, record.sourceDigest);
        assert.equal(writer.editorialPlan.contextKey, record.contextKey);
        assert.equal(path.isAbsolute(writer.editorialPlan.reference), false);
        assert.equal(fs.existsSync(path.join(harness.root, writer.editorialPlan.reference)), true);
        assert.equal(fs.statSync(harness.logFile).mode & 0o777, 0o600);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: retrying a failed writer in the same process reuses the retained plan',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      let failWriter = true;
      const runner = runnerFor(harness, api, async call => {
        calls.push(call);
        if (call.stage === 'write' && failWriter) throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', 'Synthetic usage limit.');
        return answerFor(call, fixture.plan);
      });
      try {
        await startAndWait(runner, harness, 'failed');
        const [{ record }] = archivedPlans(harness);
        failWriter = false;
        await runner.retry({ jobId: harness.jobId, canvasFilePath: harness.canvasFilePath });
        await waitForState(runner, harness, 'done');
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write', 'write']);
        const starts = rowsAt(harness.logFile).filter(row => row.stage === 'write' && row.event === 'started');
        assert.deepEqual(starts.map(row => row.editorialPlan.planRunId), [record.planRunId, record.planRunId]);
        assert.equal(api.submits.length, 1);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: corrections reuse the original source-bound plan with the distinct correction prompt',
    async run() {
      const first = writingFixture();
      const correction = writingFixture({ code: 'writer-corrected' });
      correction.handoff.corrections = ['Clarify the contribution.'];
      correction.handoff.correctionPrompt = 'Revise only the contribution claim.';
      const harness = temporaryCanvas();
      const api = sequenceApi([first.handoff, correction.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => { calls.push(call); return answerFor(call, first.plan); });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write', 'write']);
        assert.equal(calls[1].sessionId, calls[2].sessionId);
        assert.equal(calls[2].resume, true);
        assert.ok(calls[2].text.startsWith(correction.handoff.correctionPrompt));
        assert.ok(calls[2].text.includes('1. Clarify the contribution.'));
        assert.ok(calls[2].text.includes(JSON.stringify(first.plan, null, 2)));
        const starts = rowsAt(harness.logFile).filter(row => row.stage === 'write' && row.event === 'started');
        assert.equal(starts[0].editorialPlan.planRunId, starts[1].editorialPlan.planRunId);
        assert.equal(starts[0].editorialPlan.sourceDigest, starts[1].editorialPlan.sourceDigest);
        assert.notEqual(starts[0].promptSha256, starts[1].promptSha256);
        assert.equal(archivedPlans(harness).length, 1);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: a retained completed plan survives writer failure, retry and process restart',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      let failWriter = true;
      const runStage = async call => {
        calls.push(call);
        if (call.stage === 'write' && failWriter) throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', 'Synthetic usage limit.');
        return answerFor(call, fixture.plan);
      };
      const firstRunner = runnerFor(harness, api, runStage);
      let restarted;
      try {
        await startAndWait(firstRunner, harness, 'failed');
        const [{ record }] = archivedPlans(harness);
        await firstRunner.shutdown();
        failWriter = false;
        restarted = runnerFor(harness, api, runStage);
        await restarted.load();
        assert.equal(restarted.status([harness.jobId])[harness.jobId].status, 'failed');
        await restarted.retry({ jobId: harness.jobId, canvasFilePath: harness.canvasFilePath });
        await waitForState(restarted, harness, 'done');
        await restarted.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write', 'write']);
        const writerStarts = rowsAt(harness.logFile).filter(row => row.stage === 'write' && row.event === 'started');
        assert.equal(writerStarts[0].editorialPlan.planRunId, record.planRunId);
        assert.equal(writerStarts[1].editorialPlan.planRunId, record.planRunId);
        assert.equal(writerStarts[0].editorialPlan.reference, writerStarts[1].editorialPlan.reference);
        assert.equal(api.submits.length, 1);
      } finally { await cleanup(harness, firstRunner, restarted); }
    },
  },
  {
    name: 'claude diagnostics: context and exact source changes create separate bound plans',
    async run() {
      const first = writingFixture({ context: 'arm-one', code: 'first' });
      const second = writingFixture({ context: 'arm-two', code: 'second' });
      const third = writingFixture({ context: 'arm-two', code: 'third', change: ' Confirmed schedule updates.' });
      const harness = temporaryCanvas();
      const api = sequenceApi([first.handoff, second.handoff, third.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => { calls.push(call); return answerFor(call, first.plan); });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write', 'editorial-plan', 'write', 'editorial-plan', 'write']);
        assert.equal(new Set(calls.filter(call => call.stage === 'editorial-plan').map(call => call.sessionId)).size, 3);
        assert.notEqual(calls[1].sessionId, calls[3].sessionId, 'fresh boundaries also reset the writer session');
        const archives = archivedPlans(harness).map(entry => entry.record);
        assert.equal(archives.length, 3);
        assert.equal(new Set(archives.map(record => record.contextKey)).size, 2);
        assert.equal(new Set(archives.map(record => record.sourceDigest)).size, 2);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: parallel writing lanes never share a retained plan or provider session',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const done = new Set();
      const calls = [];
      const api = {
        getHandoff: async ({ matchTaskId }) => {
          if (matchTaskId) return done.has(matchTaskId) ? { completed: true } : { handoff: fixture.handoff };
          return done.size === 2 ? { completed: true } : { handoff: { stage: 'match-wave', parallelTasks: [{ id: 'lane-a' }, { id: 'lane-b' }] } };
        },
        submitHandoff: async ({ matchTaskId }) => { done.add(matchTaskId); return { accepted: true, completed: true }; },
      };
      const runner = runnerFor(harness, api, async call => { calls.push(call); return answerFor(call, fixture.plan); }, { concurrency: 2 });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        assert.equal(calls.filter(call => call.stage === 'editorial-plan').length, 2);
        assert.equal(calls.filter(call => call.stage === 'write').length, 2);
        assert.equal(new Set(calls.map(call => call.sessionId)).size, 4);
        const archives = archivedPlans(harness).map(entry => entry.record);
        assert.deepEqual(archives.map(record => record.laneKey).sort(), ['lane-a', 'lane-b']);
        const writerStarts = rowsAt(harness.logFile).filter(row => row.stage === 'write' && row.event === 'started');
        assert.equal(new Set(writerStarts.map(row => row.editorialPlan.reference)).size, 2);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: malformed and uncited proposals stop before the writer and application mutation',
    async run() {
      const fixture = writingFixture();
      const uncited = JSON.parse(JSON.stringify(fixture.plan));
      uncited.paragraphs[0].evidenceIds = ['host.career.achievement.unapproved-1.1'];
      for (const plannerText of ['not JSON', JSON.stringify(uncited)]) {
        const harness = temporaryCanvas();
        const api = sequenceApi([fixture.handoff]);
        const calls = [];
        const transcriptDirectory = path.join(harness.root, '.claude', 'projects', 'synthetic-project');
        const runner = runnerFor(harness, api, async call => {
          calls.push(call);
          fs.mkdirSync(transcriptDirectory, { recursive: true });
          fs.writeFileSync(path.join(transcriptDirectory, `${call.sessionId}.jsonl`), 'Synthetic disposable session.');
          return { text: plannerText, model: OPUS };
        });
        try {
          await startAndWait(runner, harness, 'failed');
          await runner.shutdown();
          assert.deepEqual(calls.map(call => call.stage), ['editorial-plan']);
          assert.equal(api.submits.length, 0);
          assert.equal(archivedPlans(harness).length, 0);
          assert.equal(fs.existsSync(path.join(transcriptDirectory, `${calls[0].sessionId}.jsonl`)), false);
          assert.equal(rowsAt(harness.logFile).some(row => row.event === 'started' && row.stage === 'write'), false);
        } finally { await cleanup(harness, runner); }
      }
    },
  },
  {
    name: 'claude diagnostics: provider planning failure stays visible and prevents writer execution',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      const transcriptDirectory = path.join(harness.root, '.claude', 'projects', 'synthetic-project');
      const runner = runnerFor(harness, api, async call => {
        calls.push(call);
        fs.mkdirSync(transcriptDirectory, { recursive: true });
        fs.writeFileSync(path.join(transcriptDirectory, `${call.sessionId}.jsonl`), 'Synthetic disposable session.');
        throw new ClaudeRunnerError('CLAUDE_SAFEGUARD_BLOCKED', 'Synthetic provider refusal.', { refusalCategory: 'reasoning_extraction' }, 'Synthetic plain provider error.');
      });
      try {
        const state = await startAndWait(runner, harness, 'failed');
        await runner.shutdown();
        assert.equal(state.code, 'CLAUDE_SAFEGUARD_BLOCKED');
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan']);
        assert.equal(api.submits.length, 0);
        assert.equal(fs.existsSync(path.join(transcriptDirectory, `${calls[0].sessionId}.jsonl`)), false);
        const failed = rowsAt(harness.logFile).find(row => row.event === 'failed');
        assert.equal(failed.stage, 'editorial-plan');
        assert.equal(failed.result, 'Synthetic plain provider error.');
        assert.equal(failed.error.detail.refusalCategory, 'reasoning_extraction');
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: terminal failure and cancellation wait for an in-flight summary append before freezing coverage',
    async run() {
      for (const outcome of ['failure', 'cancellation']) {
        const harness = temporaryCanvas();
        const entered = deferred();
        const release = deferred();
        const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt: 'Synthetic conversion input.' }]);
        const runner = runnerFor(harness, api, async ({ signal, onThinkingSummary }) => {
          // A transport can reject promptly on abort while its awaited callback
          // is still doing disk I/O. The root must settle that log first.
          onThinkingSummary({ text: SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'summarized' });
          if (outcome === 'failure') throw new ClaudeRunnerError('CLAUDE_ERROR', 'Synthetic model failure.');
          return new Promise((_, reject) => signal.addEventListener('abort', () => {
            reject(new ClaudeRunnerError('CLAUDE_CANCELLED', 'Synthetic cancellation.'));
          }, { once: true }));
        }, {
          fsImpl: { ...fs.promises, appendFile: async (file, line, options) => {
            if (JSON.parse(line).event === 'thinking-summary') { entered.resolve(); await release.promise; }
            return fs.promises.appendFile(file, line, options);
          } },
        });
        let stopping;
        try {
          runner.ensure({ jobId: harness.jobId, canvasFilePath: harness.canvasFilePath });
          await entered.promise;
          if (outcome === 'cancellation') stopping = runner.shutdown();
          await new Promise(resolve => setImmediate(resolve));
          assert.deepEqual(rowsAt(harness.logFile).map(row => row.event), ['started']);
          release.resolve();
          if (stopping) await stopping;
          else await waitForState(runner, harness, 'failed');
          await runner.shutdown();
          const rows = rowsAt(harness.logFile);
          assert.deepEqual(rows.map(row => row.event), ['started', 'thinking-summary', 'failed']);
          assert.equal(new Set(rows.map(row => row.runId)).size, 1);
          assert.deepEqual([rows[2].thinkingSummaryCount, rows[2].thinkingSummaryChars, rows[2].summaryStatus], [1, SUMMARY.length, 'incomplete']);
          assert.equal(rows[2].error.code, outcome === 'failure' ? 'CLAUDE_ERROR' : 'CLAUDE_CANCELLED');
          assert.equal(api.submits.length, 0);
        } finally { release.resolve(); await stopping; await cleanup(harness, runner); }
      }
    },
  },
  {
    name: 'claude diagnostics: corrupted retained plan fails retry before either planning or writing again',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => {
        calls.push(call);
        if (call.stage === 'write') throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', 'Synthetic usage limit.');
        return answerFor(call, fixture.plan);
      });
      try {
        await startAndWait(runner, harness, 'failed');
        const [{ archivePath, record }] = archivedPlans(harness);
        record.plan.thesis = 'Altered without updating its content hash.';
        fs.writeFileSync(archivePath, JSON.stringify(record));
        await runner.retry({ jobId: harness.jobId, canvasFilePath: harness.canvasFilePath });
        const state = await waitForState(runner, harness, 'failed');
        await runner.shutdown();
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan', 'write']);
        assert.match(state.message, /plan|archive|hash/iu);
        assert.equal(api.submits.length, 0);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: the extra planning call counts toward the existing per-job run limit',
    async run() {
      const fixture = writingFixture();
      const harness = temporaryCanvas();
      const api = sequenceApi([fixture.handoff]);
      const calls = [];
      const runner = runnerFor(harness, api, async call => { calls.push(call); return answerFor(call, fixture.plan); }, { maxRunsPerJob: 1 });
      try {
        const state = await startAndWait(runner, harness, 'failed');
        await runner.shutdown();
        assert.equal(state.code, 'CLAUDE_TOO_MANY_RUNS');
        assert.deepEqual(calls.map(call => call.stage), ['editorial-plan']);
        assert.equal(api.submits.length, 0);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: native summaries are correlated durable events and full prompts appear only on start',
    async run() {
      const harness = temporaryCanvas();
      const prompt = 'Synthetic conversion input with an exact audit marker.';
      const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt }]);
      const summary = { text: SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'summarized' };
      const runner = runnerFor(harness, api, async ({ onThinkingSummary }) => {
        await onThinkingSummary({ ...summary, signature: 'DO_NOT_COPY_SIGNATURE', rawStream: 'DO_NOT_COPY_RAW_STREAM', redacted: 'DO_NOT_COPY_REDACTED' });
        const latest = rowsAt(harness.logFile).at(-1);
        assert.equal(latest.event, 'thinking-summary');
        assert.deepEqual(latest.summary, summary);
        return { text: 'Synthetic conversion.', model: SONNET, durationMs: 4 };
      });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        const rows = rowsAt(harness.logFile);
        assert.deepEqual(rows.map(row => row.event), ['started', 'thinking-summary', 'response', 'submission']);
        assert.equal(new Set(rows.map(row => row.runId)).size, 1);
        assert.equal(rows[0].prompt, prompt);
        assert.equal(rows[0].promptSha256, hash(prompt));
        assert.equal(rows[1].provisional, true);
        assert.deepEqual(rows[1].summary, summary);
        const response = rows[2];
        assert.deepEqual([response.thinkingSummaryCount, response.thinkingSummaryChars, response.thinkingSummaryPresent, response.thinkingDisplay, response.summaryStatus], [1, SUMMARY.length, true, 'summarized', 'complete']);
        assert.equal(rows.filter(row => Object.hasOwn(row, 'prompt')).length, 1);
        assert.doesNotMatch(fs.readFileSync(harness.logFile, 'utf8'), /DO_NOT_COPY|rawStream|signature|redacted/u);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: native summaries remain provisional and failure metadata excludes unknown transport fields',
    async run() {
      const harness = temporaryCanvas();
      const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt: 'Synthetic conversion input.' }]);
      const runner = runnerFor(harness, api, async ({ onThinkingSummary }) => {
        await onThinkingSummary({ text: SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'summarized' });
        throw new ClaudeRunnerError('CLAUDE_SAFEGUARD_BLOCKED', 'Synthetic native refusal.', {
          refusalCategory: 'reasoning_extraction', requestId: 'req_123456789', apiErrorStatus: 403,
          errors: ['Synthetic provider explanation.'], stopReason: 'refusal',
          signature: 'DO_NOT_COPY_SIGNATURE', rawStream: 'DO_NOT_COPY_RAW_STREAM', privateThinking: 'DO_NOT_COPY_THINKING',
        }, 'Synthetic plain failure result.');
      });
      try {
        await startAndWait(runner, harness, 'failed');
        await runner.shutdown();
        const rows = rowsAt(harness.logFile);
        assert.deepEqual(rows.map(row => row.event), ['started', 'thinking-summary', 'failed']);
        assert.equal(rows[1].provisional, true);
        assert.deepEqual([rows[2].thinkingSummaryCount, rows[2].thinkingSummaryChars, rows[2].thinkingSummaryPresent, rows[2].thinkingDisplay, rows[2].summaryStatus], [1, SUMMARY.length, true, 'summarized', 'incomplete']);
        assert.equal(rows[2].result, 'Synthetic plain failure result.');
        assert.equal(rows[2].error.detail.refusalCategory, 'reasoning_extraction');
        assert.equal(rows[2].error.detail.requestId, 'req_123456789');
        assert.deepEqual(rows[2].error.detail.errors, ['Synthetic provider explanation.']);
        assert.equal(rows[2].error.detail.stopReason, 'refusal');
        assert.equal(api.submits.length, 0);
        assert.doesNotMatch(fs.readFileSync(harness.logFile, 'utf8'), /DO_NOT_COPY|rawStream|signature|privateThinking/u);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: invalid display or mismatched model summary stops before application submission',
    async run() {
      for (const invalidSummary of [
        { text: SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'omitted' },
        { text: SUMMARY, model: OPUS, index: 1, thinkingDisplay: 'summarized' },
      ]) {
        const harness = temporaryCanvas();
        const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt: 'Synthetic conversion input.' }]);
        const runner = runnerFor(harness, api, async ({ onThinkingSummary }) => {
          await onThinkingSummary(invalidSummary);
          return { text: 'Invalid summary answer.', model: SONNET };
        });
        try {
          const state = await startAndWait(runner, harness, 'failed');
          await runner.shutdown();
          assert.equal(state.code, 'CLAUDE_LOG_ERROR');
          assert.equal(api.submits.length, 0);
          assert.equal(rowsAt(harness.logFile).some(row => row.event === 'thinking-summary' || row.event === 'response'), false);
        } finally { await cleanup(harness, runner); }
      }
    },
  },
  {
    name: 'claude diagnostics: a failed native summary append prevents the answer from reaching the application',
    async run() {
      const harness = temporaryCanvas();
      const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt: 'Synthetic conversion input.' }]);
      let afterSummary = false;
      const runner = runnerFor(harness, api, async ({ onThinkingSummary }) => {
        await onThinkingSummary({ text: SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'summarized' });
        afterSummary = true;
        return { text: 'Unlogged answer.', model: SONNET };
      }, {
        fsImpl: { ...fs.promises, appendFile: async (file, line, options) => {
          if (JSON.parse(line).event === 'thinking-summary') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return fs.promises.appendFile(file, line, options);
        } },
      });
      try {
        const state = await startAndWait(runner, harness, 'failed');
        await runner.shutdown();
        assert.equal(state.code, 'CLAUDE_LOG_ERROR');
        assert.equal(afterSummary, false);
        assert.equal(api.submits.length, 0);
        assert.equal(rowsAt(harness.logFile).some(row => row.event === 'response'), false);
      } finally { await cleanup(harness, runner); }
    },
  },
  {
    name: 'claude diagnostics: prompt capture can be disabled without losing hashes or native summary availability',
    async run() {
      const harness = temporaryCanvas();
      const prompt = 'Synthetic prompt omitted from diagnostic text.';
      const api = sequenceApi([{ handoffCode: 'convert', stage: 'convert', prompt }]);
      const runner = runnerFor(harness, api, async () => ({ text: 'Synthetic answer.', model: SONNET }), { capturePrompts: false });
      try {
        await startAndWait(runner, harness);
        await runner.shutdown();
        const rows = rowsAt(harness.logFile);
        assert.equal(rows.some(row => Object.hasOwn(row, 'prompt')), false);
        assert.equal(rows[0].promptSha256, hash(prompt));
        const response = rows.find(row => row.event === 'response');
        assert.deepEqual([response.thinkingSummaryCount, response.thinkingSummaryChars, response.thinkingSummaryPresent, response.thinkingDisplay, response.summaryStatus], [0, 0, false, 'summarized', 'complete']);
        assert.equal(fs.readFileSync(harness.logFile, 'utf8').includes(prompt), false);
      } finally { await cleanup(harness, runner); }
    },
  },
];
