/**
 * Ultracode A/B for the post-call practice review (synthetic calls, real Claude CLI).
 *
 * The review runs exactly as the app runs it: analyzeCall builds the prompt from the call record,
 * transcript, tone and metrics, and its `clients.callText` is the app's own
 * createInterviewClaudeTransport().callText(prompt, { signal, task: 'practice-review',
 * claudeStage: 'qa-practice-review', responseSchema }) — only `ultracode` is added per arm.
 * The transport is built with a wrapped runStage so each Claude stage reports its cost, its
 * offered tools and every onActivity tool event, which is how a Workflow run is counted.
 *
 * Usage (needs the same Claude CLI environment as the app):
 *   node scripts/practice-review-ultracode-ab.mjs --out ~/practice-review-ab [--ultracode on,off] [--runs 2]
 * Output stays outside the repository: 0700 directories, 0600 files — one analysis.json per call
 * (written by analyzeCall), a reviews/<label>.json record per call, and summary.json.
 *
 * Scribe is not exercised: a synthetic record has no candidate.wav, so transcription fails the way
 * a missing recording does and only the word-level view is lost. The metrics are real (computed from
 * the timed synthetic transcript). Nothing here is imported for its side effects; main() is guarded.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { analyzeCall } from '../electron/practiceCall/analysis/analyzeCall.js';
import { createInterviewClaudeTransport } from '../electron/ipc/interviewClaudeTransport.js';
import { runClaudeStage } from '../electron/ipc/claudeApplicationRunner.js';
import { assertExternalOutput, parseUltracode } from './interview-practice-benchmark.mjs';

export const REVIEW_TASK = 'practice-review';
export const REVIEW_STAGE = 'qa-practice-review';

const USAGE = `Usage: node scripts/practice-review-ultracode-ab.mjs --out <dir> [options]

  --out <dir>          private output directory outside the repository (required)
  --ultracode on,off   review arms to compare (default on,off; 'off' is the app's own value)
  --runs <n>           reviews per call record per arm (default 2)
  --help               print this text

Each call record is reviewed through analyzeCall -> createInterviewClaudeTransport().callText, the
same path electron/main.js wires for qa-practice-review. summary.json pairs the arms per call.`;

const word = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const safeName = value => String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const total = values => values.filter(Number.isFinite).reduce((sum, value) => sum + value, 0);

/** Synthetic plan cards and brief: the review prompt reads these, never the prepared answer text. */
export const SYNTHETIC_PLAN = Object.freeze([
  Object.freeze({ question: 'Walk me through the last backend platform you owned end to end.', headline: 'Owned a payments platform migration',
    bullets: Object.freeze(['Scoped the migration with the product team', 'Ran the dual-write cutover in three stages']),
    example: 'I owned the migration from the legacy ledger to the new service, including the rollback plan.' }),
  Object.freeze({ question: 'Tell me about a time a release went wrong.', headline: 'Caught a bad release in the first ten minutes',
    bullets: Object.freeze(['Watched error budgets instead of deploy logs', 'Rehearsed the rollback before the cutover']),
    example: 'We rolled back within twelve minutes and I wrote the follow-up before the postmortem.' }),
]);

export const SYNTHETIC_BRIEF = Object.freeze({
  role: 'Senior Backend Engineer', company: 'Northwind Systems', interviewType: 'technical screen',
  interviewerName: 'Dana', durationMinutes: 45, focusAreas: Object.freeze(['backend ownership', 'incident stories', 'collaboration']),
});

/** Turn helper: [speaker, seconds, text] becomes one transcript turn with contiguous timings. */
function transcriptOf(turns) {
  let at = 0;
  return turns.map(([speaker, seconds, text, extra = {}]) => {
    const startMs = at;
    const endMs = at + Math.round(seconds * 1000);
    at = endMs + 400;
    return { speaker, startMs, endMs, text, ...extra };
  });
}

const prosody = seconds => ({ meanVolumeDb: -18 - (seconds % 4), meanPitchHz: 150 + Math.round(seconds * 3), speakingSeconds: seconds });

/** Three realistic synthetic practice calls, shaped like analyzeCall's input contract. */
export function syntheticCallRecords() {
  const first = transcriptOf([
    ['interviewer', 4, 'Thanks for making the time. Walk me through the last backend platform you owned end to end.'],
    ['candidate', 26, 'Sure. The last platform I owned was the payments ledger at my previous company, where I led the move from a single Postgres instance to a sharded service over about six months.'],
    ['interviewer', 4, 'What part of that migration did you personally decide?'],
    ['candidate', 19, 'I decided the cutover order. We had three consumer services, and I chose to move settlement first because its read pattern was easiest to shadow.'],
    ['interviewer', 4, 'How did you know the shadow reads agreed with the old system?'],
    ['candidate', 22, 'We compared every settlement line for three weeks and reconciled the mismatches daily. That gave us the confidence to flip the write path in stages.'],
    ['interviewer', 4, 'That is a clear answer. Anything you would do differently?'],
    ['candidate', 14, 'I would have written the rollback runbook earlier than the second week, because we needed it before we had it.'],
  ]);
  const second = transcriptOf([
    ['interviewer', 4, 'Tell me about a time a release went wrong and what you changed afterwards.'],
    ['candidate', 8, 'Um, so, we had this release, right, and, um, it broke the checkout flow for maybe ten minutes.', { interrupted: false }],
    ['interviewer', 3, 'What did you do in the first five minutes?'],
    ['candidate', 16, 'I, um, looked at the dashboards, and we saw errors spiking, so I paged the on-call and we rolled back.'],
    ['interviewer', 3, 'Who made the rollback call?'],
    ['candidate', 12, 'Actually I made it, after, you know, confirming with the payments lead that it was safe.'],
    ['candidate', 6, 'We rolled back at about twelve minutes, I think.', { interrupted: true }],
    ['interviewer', 3, 'What did the postmortem change?'],
    ['candidate', 20, 'We added a pre-cutover check that compares error budgets, and we now rehearse the rollback in staging every release.'],
  ]);
  const third = transcriptOf([
    ['interviewer', 5, 'Last question: how do you give hard feedback to a peer?'],
    ['candidate', 17, 'I try to describe the specific behaviour and its effect, and ask how it looked from their side before I propose anything.'],
    ['interviewer', 4, 'And when they disagree with your read of the effect?'],
    ['candidate', 15, 'I go back to the evidence with them, and if we still disagree I say what I will do differently rather than insisting.'],
  ]);
  const record = (callId, persona, transcript, toneNotes) => Object.freeze({
    callId, persona, transcript, toneNotes,
    durationMs: transcript.at(-1).endMs,
    startedAt: '2026-04-14T09:00:00.000Z',
    toneSamples: transcript.filter(turn => turn.speaker === 'candidate').map(turn => ({ startMs: turn.startMs, volumeDb: -21, pitchHz: 148 })),
    candidateProsodyByTurn: Object.fromEntries(transcript
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => turn.speaker === 'candidate')
      .map(({ turn, index }) => [index, prosody(Math.round((turn.endMs - turn.startMs) / 1000))])),
    baseline: Object.freeze({ meanVolumeDb: -22, meanPitchHz: 150, sampleCount: 12 }),
  });
  return [
    record('synth-ledger-platform', 'technical-screen', first, ['Steady pace through the migration story.']),
    record('synth-failed-release', 'hiring-manager', second, ['Rushed and filler-heavy while retelling the incident.']),
    record('synth-hard-feedback', 'behavioural', third, ['Even tone, short answers.']),
  ];
}

/** on/off arm label: the same call reviewed by the same arm is one file, arms never overwrite each other. */
export const armLabel = (ultracode, run, callId) => `${ultracode ? 'on' : 'off'}-r${run}-${safeName(callId)}`;

/** A Workflow run shows up as an onActivity tool event naming the tool (kind 'tool' calls or 'tool-progress'). */
export function isWorkflowToolEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const names = Array.isArray(event.calls) ? event.calls.map(call => call?.tool) : [event.tool];
  return names.some(name => String(name ?? '').toLowerCase() === 'workflow');
}

/** The transport's default runStage, wrapped so every Claude stage reports its cost, tools and tool events. */
export function instrumentedRunStage({ state, stage = runClaudeStage }) {
  return async args => {
    state.stageRuns += 1;
    state.offeredTools.push(word(args?.tools));
    const onActivity = event => {
      state.activityEvents += 1;
      if (isWorkflowToolEvent(event)) state.workflowToolEvents += 1;
      if (typeof args?.onActivity === 'function') args.onActivity(event);
    };
    const reply = await stage({ ...args, onActivity });
    if (Number.isFinite(reply?.costUsd)) state.costUsd += reply.costUsd;
    return reply;
  };
}

/**
 * One review of one synthetic call under one arm. analyzeCall owns the prompt, the retry and the
 * validation; every Claude stage is measured here, and analyzeCall writes analysis.json (the review JSON).
 */
export async function reviewCall({ record, ultracode, run, outDir, plan = SYNTHETIC_PLAN, brief = SYNTHETIC_BRIEF, log = () => {} }) {
  const label = armLabel(ultracode, run, record.callId);
  const callDir = path.join(outDir, 'calls', label);
  await fs.mkdir(callDir, { recursive: true, mode: 0o700 });
  await fs.chmod(callDir, 0o700);
  const state = { stageRuns: 0, costUsd: 0, activityEvents: 0, workflowToolEvents: 0, offeredTools: [] };
  const transport = createInterviewClaudeTransport({ runStage: instrumentedRunStage({ state }) });
  // The app's own callText for qa-practice-review (electron/main.js), plus the arm's ultracode.
  const callText = ({ prompt, schema, signal } = {}) => transport.callText(prompt, {
    signal, task: REVIEW_TASK, claudeStage: REVIEW_STAGE, responseSchema: schema, ultracode,
  });
  const started = performance.now();
  let result = null;
  let thrown = null;
  try {
    result = await analyzeCall({ callDir, callRecord: record, plan, brief, deps: {
      callText,
      // A synthetic record has no candidate.wav; the real Scribe path would only add the word-level view.
      transcribe: async () => { throw new Error('synthetic call record has no candidate.wav'); },
    } });
  } catch (error) { thrown = error; }
  const durationMs = Math.round(performance.now() - started);
  const analysis = result?.analysis ?? null;
  const validation = !thrown && analysis?.status === 'ready' && result?.feedback
    ? { ok: true, error: null }
    : { ok: false, error: word(thrown?.message) || word(analysis?.error, 'no review was produced') };
  const call = {
    label, ultracode, run, callId: record.callId, persona: record.persona,
    durationMs, costUsd: Math.round(state.costUsd * 1e9) / 1e9, stageRuns: state.stageRuns,
    offeredTools: [...new Set(state.offeredTools)], activityEvents: state.activityEvents,
    workflowToolRan: state.workflowToolEvents > 0, workflowToolEvents: state.workflowToolEvents,
    validation, analysisStatus: analysis?.status ?? null,
    transcriptTurns: record.transcript.length, chapters: Array.isArray(analysis?.chapters) ? analysis.chapters.length : 0,
    metricsError: word(analysis?.metricsError) || null, reviewPath: path.join(callDir, 'analysis.json'),
  };
  const reviewDir = path.join(outDir, 'reviews');
  await fs.mkdir(reviewDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(reviewDir, `${label}.json`), `${JSON.stringify({ ...call, analysis }, null, 2)}\n`, { mode: 0o600 });
  log(`  ${label} ${durationMs} ms ${validation.ok ? 'valid' : `invalid: ${validation.error}`} workflow=${call.workflowToolRan}`);
  return call;
}

/** Per-arm totals and the on/off pairs, so the same call's two reviews sit side by side. */
export function summarizeReviews(calls = []) {
  const arms = [false, true].filter(ultracode => calls.some(call => call.ultracode === ultracode)).map(ultracode => {
    const mine = calls.filter(call => call.ultracode === ultracode);
    return {
      ultracode,
      calls: mine.length,
      valid: mine.filter(call => call.validation.ok).length,
      invalid: mine.filter(call => !call.validation.ok).length,
      workflowToolRuns: mine.filter(call => call.workflowToolRan).length,
      offeredTools: [...new Set(mine.flatMap(call => call.offeredTools))],
      stageRuns: mine.reduce((sum, call) => sum + call.stageRuns, 0),
      medianDurationMs: median(mine.map(call => call.durationMs)),
      meanDurationMs: mine.length ? total(mine.map(call => call.durationMs)) / mine.length : null,
      meanCostUsd: mine.length ? total(mine.map(call => call.costUsd)) / mine.length : null,
      totalCostUsd: total(mine.map(call => call.costUsd)),
      invalidationReasons: [...new Set(mine.filter(call => !call.validation.ok).map(call => call.validation.error))],
    };
  });
  const pairs = [];
  const runs = [...new Set(calls.map(call => call.run))].sort((a, b) => a - b);
  for (const callId of [...new Set(calls.map(call => call.callId))]) for (const run of runs) {
    const off = calls.find(call => call.callId === callId && call.run === run && call.ultracode === false);
    const on = calls.find(call => call.callId === callId && call.run === run && call.ultracode === true);
    if (!off || !on) continue;
    pairs.push({ callId, run, durationDeltaMs: on.durationMs - off.durationMs,
      costDeltaUsd: Math.round((on.costUsd - off.costUsd) * 1e9) / 1e9,
      offValid: off.validation.ok, onValid: on.validation.ok,
      offWorkflowToolRan: off.workflowToolRan, onWorkflowToolRan: on.workflowToolRan });
  }
  return { synthetic: true, task: REVIEW_TASK, stage: REVIEW_STAGE, plan: 'synthetic', arms, pairs };
}

/** Run both arms over every synthetic call and write summary.json beside the per-call files. */
export async function runAb({ outDir, ultracodes = [false, true], runs = 2, records = syntheticCallRecords(),
  plan = SYNTHETIC_PLAN, brief = SYNTHETIC_BRIEF, log = () => {} } = {}) {
  if (typeof outDir !== 'string' || !outDir) throw new Error('--out is required.');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer.');
  if (!Array.isArray(ultracodes) || !ultracodes.length) throw new Error('--ultracode must list on, off or both.');
  await assertExternalOutput(outDir);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const calls = [];
  for (const ultracode of ultracodes) for (let run = 1; run <= runs; run += 1) for (const record of records) {
    log(`ultracode ${ultracode ? 'on' : 'off'} run=${run} ${record.callId}`);
    calls.push(await reviewCall({ record, ultracode, run, outDir, plan, brief, log }));
  }
  const summary = { ...summarizeReviews(calls), generatedAt: new Date().toISOString(), calls };
  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

function parseArguments(argv) {
  const booleans = new Set(['--help']);
  const values = new Set(['--out', '--ultracode', '--runs']);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (Object.hasOwn(result, flag) || (!booleans.has(flag) && !values.has(flag))) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (booleans.has(flag)) result[flag] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args['--help']) { console.log(USAGE); return; }
  if (!args['--out']) throw new Error(USAGE);
  const outDir = path.resolve(args['--out']);
  await assertExternalOutput(outDir);
  const summary = await runAb({ outDir, ultracodes: parseUltracode(args['--ultracode'] || 'on,off'),
    runs: args['--runs'] === undefined ? 2 : Number(args['--runs']), log: message => console.log(message) });
  console.log(JSON.stringify(summary.arms, null, 2));
  console.log(`Reviews and summary: ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
