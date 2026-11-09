// Standalone offline benchmark for the practice-interview call. Run it yourself outside the agent sandbox:
// it makes real Claude CLI calls (sequentially, no retries, no substitution). Tests inject stub sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { assertInterviewerConfig, createInterviewerSession } from '../electron/interviewPracticeTransport.js';
import { buildInterviewerInstructions } from '../electron/interviewPracticeCallPrompt.js';
import {
  CLASSIFIER_CASES, CLASSIFIER_INSTRUCTIONS, SCENARIOS, SYNTHETIC_BRIEF, SYNTHETIC_PLAN, classifierMessage,
} from './fixtures/interview-practice-scenarios.mjs';

const USAGE = `Usage: node scripts/interview-practice-benchmark.mjs --out <private dir outside the repo>
  [--models opus,sonnet,haiku] [--efforts low,medium,high] [--ultracode on,off]
  [--classifier-models haiku,sonnet] [--classifier-efforts low,medium]
  [--claude-bin claude] [--timeout-ms 30000] [--runs 2]
  [--only interviewer|classifier] [--report-only]

Concurrency is always 1. Any failure stops that configuration and is recorded; nothing is retried or substituted.
Reusing --out resumes from results.jsonl. --report-only rebuilds reports and judge packets with no CLI calls.
Scenarios are synthetic. Models: opus, sonnet, haiku. Effort max is rejected.
Ultracode (default off) is the interviewer's Workflow-tool setting; it runs as its own configurations so that on and
off results of the same model/effort sit side by side. Classifier configurations never use it.`;

export const FIRST_SENTENCE_GATE_MS = 1500;
export const CLASSIFIER_GATE_MS = 600;
export const CALLS_PER_FIFTY_MINUTES = 60;
const MODELS = ['opus', 'sonnet', 'haiku'];
const RUBRIC = [
  'Reacts to the specific content of what the candidate just said',
  'Follow-up relevance',
  'Persona consistency (name, role, temperament)',
  'Deflects instead of inventing company facts',
  'Correct keep-listening call (<listen/> only when the candidate is unfinished or silent)',
  'Natural handling after an interruption',
];
const configError = () => Object.assign(new Error('CONFIG_REJECTED'), { code: 'CONFIG_REJECTED' });

const ULTRACODE_SUFFIX = '+ultracode';
export const configId = config => `${config.model}/${config.effort}${config.ultracode === true ? ULTRACODE_SUFFIX : ''}`;
const safeName = value => String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
const list = value => [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))];

/** 'on'/'off' tokens become the interviewer's optional boolean; 'off' is the default and the app's own value. */
export function parseUltracode(value = 'off') {
  return list(value).map(token => {
    if (token === 'on') return true;
    if (token === 'off') return false;
    throw configError();
  });
}

/** Build model x effort x ultracode configurations; rejects fable/unknown aliases, effort max and bad ultracode tokens. */
export function buildConfigs(models, efforts, ultracode = 'off') {
  const modes = parseUltracode(ultracode);
  const configs = list(models).flatMap(model => list(efforts)
    .flatMap(effort => modes.map(mode => ({ model, effort, ultracode: mode }))));
  if (!configs.length) throw configError();
  for (const config of configs) assertInterviewerConfig(config);
  return configs;
}

/** Classifier configurations stay model x effort: the classifier never offers Workflow. */
export const classifierConfigsOf = configs => configs.map(({ model, effort }) => ({ model, effort }));

export function percentile(values, quantile) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] : null;
}
const mean = values => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
};

/** Refuses an output directory inside the repository (symlinks resolved through the nearest existing parent). */
export async function assertExternalOutput(target, repoRoot = path.resolve(import.meta.dirname, '..')) {
  const repo = await fs.realpath(repoRoot);
  let probe = path.resolve(target);
  const rest = [];
  for (;;) {
    try { probe = await fs.realpath(probe); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      rest.unshift(path.basename(probe)); probe = parent;
    }
  }
  const resolved = path.join(probe, ...rest);
  const relative = path.relative(repo, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('--out must be a private directory outside the repository.');
  }
}

/** Summarize journal records. Listen turns are excluded from first-sentence percentiles. */
export function summarize({ records, interviewerConfigs = [], classifierConfigs = [], scenarios = SCENARIOS }) {
  const listenScenarios = new Set(scenarios.filter(scenario => scenario.turns.some(item => item.expectControl === 'listen')).map(scenario => scenario.name));
  const failures = records.filter(record => record.type === 'failure');
  const ids = (kind, configs) => [...new Set([...configs.map(configId),
    ...records.filter(record => record.kind === kind).map(record => record.config)])];
  const interviewer = ids('interviewer', interviewerConfigs).map(id => {
    const turns = records.filter(record => record.type === 'turn' && record.kind === 'interviewer' && record.config === id);
    const spoken = turns.filter(record => record.control !== 'listen' && Number.isFinite(record.firstSentenceMs));
    const listens = turns.filter(record => record.control === 'listen');
    const pause = turns.filter(record => listenScenarios.has(record.scenario));
    const pauseCorrect = pause.filter(record => (record.control === 'listen') === (record.expectControl === 'listen'));
    const meanCostPerTurn = mean(turns.map(record => record.costUsd));
    const p95FirstSentenceMs = percentile(spoken.map(record => record.firstSentenceMs), 0.95);
    const failed = failures.filter(record => record.kind === 'interviewer' && record.config === id);
    return {
      config: id, ultracode: id.endsWith(ULTRACODE_SUFFIX), turns: turns.length, spokenTurns: spoken.length, listenTurns: listens.length,
      p50FirstSentenceMs: percentile(spoken.map(record => record.firstSentenceMs), 0.5), p95FirstSentenceMs,
      p50ListenMs: percentile(listens.map(record => record.totalMs), 0.5), p95ListenMs: percentile(listens.map(record => record.totalMs), 0.95),
      keepListeningCorrect: pauseCorrect.length, keepListeningTotal: pause.length,
      keepListeningAccuracy: pause.length ? pauseCorrect.length / pause.length : null,
      meanCostPerTurnUsd: meanCostPerTurn, projectedCostPerCallUsd: meanCostPerTurn === null ? null : meanCostPerTurn * CALLS_PER_FIFTY_MINUTES,
      failures: failed.map(({ scenario, turnIndex, code }) => ({ scenario, turnIndex, code })),
      eligible: !failed.length && p95FirstSentenceMs !== null && p95FirstSentenceMs <= FIRST_SENTENCE_GATE_MS,
    };
  });
  const classifier = ids('classifier', classifierConfigs).map(id => {
    const samples = records.filter(record => record.type === 'case' && record.kind === 'classifier' && record.config === id);
    const correct = samples.filter(record => record.correct).length;
    const p95Ms = percentile(samples.map(record => record.totalMs), 0.95);
    const failed = failures.filter(record => record.kind === 'classifier' && record.config === id);
    return {
      config: id, cases: samples.length, correct, accuracy: samples.length ? correct / samples.length : null,
      p50Ms: percentile(samples.map(record => record.totalMs), 0.5), p95Ms,
      failures: failed.map(({ caseId, code }) => ({ caseId, code })),
      passesGate: !failed.length && p95Ms !== null && p95Ms <= CLASSIFIER_GATE_MS,
    };
  });
  return {
    version: 1, synthetic: true,
    gates: { firstSentenceP95Ms: FIRST_SENTENCE_GATE_MS, classifierP95Ms: CLASSIFIER_GATE_MS },
    interviewer, classifier, ultracode: ultracodeComparison(interviewer),
    ranking: interviewer.filter(row => row.eligible).sort((a, b) => a.p95FirstSentenceMs - b.p95FirstSentenceMs || a.config.localeCompare(b.config)).map(row => row.config),
  };
}

/** Pair every ultracode-on interviewer row with the same model/effort ultracode-off row for a side-by-side delta. */
export function ultracodeComparison(rows = []) {
  const byId = new Map(rows.map(row => [row.config, row]));
  const delta = (on, off) => on === null || on === undefined || off === null || off === undefined ? null : on - off;
  return rows.filter(row => row.ultracode === true).map(onRow => {
    const base = onRow.config.slice(0, -ULTRACODE_SUFFIX.length);
    const offRow = byId.get(base) ?? null;
    return {
      config: base,
      offP95FirstSentenceMs: offRow?.p95FirstSentenceMs ?? null, onP95FirstSentenceMs: onRow.p95FirstSentenceMs,
      p95FirstSentenceDeltaMs: delta(onRow.p95FirstSentenceMs, offRow?.p95FirstSentenceMs),
      offMeanCostPerTurnUsd: offRow?.meanCostPerTurnUsd ?? null, onMeanCostPerTurnUsd: onRow.meanCostPerTurnUsd,
      meanCostPerTurnDeltaUsd: delta(onRow.meanCostPerTurnUsd, offRow?.meanCostPerTurnUsd),
      offEligible: offRow?.eligible ?? null, onEligible: onRow.eligible,
      offFailures: offRow?.failures.length ?? null, onFailures: onRow.failures.length,
    };
  });
}

const ms = value => value === null || value === undefined ? '—' : String(Math.round(value));
const pct = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const usd = value => value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;
const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');

export function renderSummaryMarkdown(summary) {
  const lines = ['# Practice interview call benchmark (synthetic scenarios)', '',
    '## Interviewer', '',
    '| Config | Ultracode | Spoken turns | p50 first sentence ms | p95 first sentence ms | Listen turns | p50 / p95 listen ms | Keep-listening (d) | Mean cost / turn | Cost / 50-min call (×60) | Failures | Gate p95 ≤ 1500 | Judge score |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |'];
  for (const row of summary.interviewer) lines.push(`| ${cell(row.config)} | ${row.ultracode ? 'on' : 'off'} | ${row.spokenTurns} | ${ms(row.p50FirstSentenceMs)} | ${ms(row.p95FirstSentenceMs)} | ${row.listenTurns} | ${ms(row.p50ListenMs)} / ${ms(row.p95ListenMs)} | ${row.keepListeningTotal ? `${row.keepListeningCorrect}/${row.keepListeningTotal}` : '—'} | ${usd(row.meanCostPerTurnUsd)} | ${usd(row.projectedCostPerCallUsd)} | ${row.failures.length ? row.failures.map(item => `${cell(item.scenario)}#${item.turnIndex} ${cell(item.code)}`).join('; ') : 'none'} | ${row.eligible ? 'pass' : 'fail'} | (to be filled) |`);
  const pairs = summary.ultracode ?? ultracodeComparison(summary.interviewer);
  if (pairs.length) {
    lines.push('', '## Ultracode on vs off (same model/effort)', '',
      '| Config | p95 off ms | p95 on ms | Δ p95 ms | Cost/turn off | Cost/turn on | Δ cost | Gate off | Gate on | Failures off / on |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |');
    const signed = (value, unit = '') => value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${Math.round(value * 10000) / 10000}${unit}`;
    for (const pair of pairs) {
      lines.push(`| ${cell(pair.config)} | ${ms(pair.offP95FirstSentenceMs)} | ${ms(pair.onP95FirstSentenceMs)} | ${signed(pair.p95FirstSentenceDeltaMs)} | ${usd(pair.offMeanCostPerTurnUsd)} | ${usd(pair.onMeanCostPerTurnUsd)} | ${signed(pair.meanCostPerTurnDeltaUsd)} | ${pair.offEligible === null ? '—' : pair.offEligible ? 'pass' : 'fail'} | ${pair.onEligible ? 'pass' : 'fail'} | ${pair.offFailures ?? '—'} / ${pair.onFailures} |`);
    }
  }
  lines.push('', '## Classifier', '',
    '| Config | Cases | Accuracy | p50 ms | p95 ms | Failures | Gate p95 ≤ 600 |', '| --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const row of summary.classifier) lines.push(`| ${cell(row.config)} | ${row.cases} | ${pct(row.accuracy)} | ${ms(row.p50Ms)} | ${ms(row.p95Ms)} | ${row.failures.length ? row.failures.map(item => `${cell(item.caseId)} ${cell(item.code)}`).join('; ') : 'none'} | ${row.passesGate ? 'pass' : 'fail'} |`);
  lines.push('', '## Decision rule', '',
    `1. Keep interviewer configs with p95 first-sentence latency ≤ ${FIRST_SENTENCE_GATE_MS} ms and no failures: ${summary.ranking.length ? summary.ranking.map(cell).join(', ') : 'none'}.`,
    '2. Rank those configs by blinded judge score (to be filled from judge-packets/ and judge-key.json). The order above is only by p95 latency.',
    `3. Classifier gate: p95 ≤ ${CLASSIFIER_GATE_MS} ms (passing: ${summary.classifier.filter(row => row.passesGate).map(row => cell(row.config)).join(', ') || 'none'}); accuracy decides among passing configs.`,
    '', 'First-sentence percentiles exclude keep-listening turns, which have no sentence; their decision latency is the listen totals. Cost per call = mean cost per turn × 60. Scenarios and classifier cases are synthetic.', '');
  return lines.join('\n');
}

// ---------- judge packets (blinded) ----------
function seedFrom(text) {
  let hash = 2166136261;
  for (const char of text) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash >>> 0;
}
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministic Fisher-Yates over sorted ids, seeded by the scenario name. */
export function shuffleForScenario(ids, scenarioName) {
  const result = [...ids].sort();
  const random = mulberry32(seedFrom(scenarioName));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

const turnReply = record => record.control === 'listen' ? `(kept listening) ${record.text}`
  : record.endCall ? `${record.text} (call ended)` : record.text;

function blindTranscript(scenario, turns) {
  const byIndex = new Map(turns.map(record => [record.turnIndex, record]));
  return scenario.turns.map((item, index) => {
    const record = byIndex.get(index);
    return `**Turn ${index + 1}** candidate: ${item.message}\n\nInterviewer: ${record ? turnReply(record) : '(no reply recorded)'}`;
  }).join('\n\n');
}

export function buildJudgePackets({ records, scenarios = SCENARIOS }) {
  const packets = {};
  const key = {};
  for (const scenario of scenarios) {
    const turns = records.filter(record => record.type === 'turn' && record.kind === 'interviewer' && record.scenario === scenario.name);
    const runs = turns.map(record => record.run);
    if (!runs.length) continue;
    const run = Math.min(...runs);
    const configs = shuffleForScenario([...new Set(turns.filter(record => record.run === run).map(record => record.config))], scenario.name);
    const labels = Object.fromEntries(configs.map((id, index) => [String.fromCharCode(65 + index), id]));
    key[scenario.name] = labels;
    const lines = [`# Judge packet: ${scenario.title}`, '',
      `Scenario: ${scenario.name} (synthetic). Interviewer persona: ${scenario.persona.name}, ${scenario.persona.role}, ${scenario.persona.team}; temperament ${scenario.persona.temperament}.`,
      '', 'Score every candidate transcript from 0 to 5 on each criterion:', '', ...RUBRIC.map(item => `- ${item}: 0-5`),
      '', '## What a good interviewer does at each turn', '', ...scenario.turns.map((item, index) => `- Turn ${index + 1}: ${item.expect}`), ''];
    for (const [letter, id] of Object.entries(labels)) {
      lines.push(`## Transcript ${letter}`, '', blindTranscript(scenario, turns.filter(record => record.config === id && record.run === run)), '');
    }
    packets[scenario.name] = lines.join('\n');
  }
  return { packets, key };
}

// ---------- journal and transcripts ----------
async function readJournal(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const end = text.lastIndexOf('\n') + 1;
  if (end !== text.length) await fs.truncate(file, Buffer.byteLength(text.slice(0, end))); // torn final append
  return text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function renderTranscript(config, scenario, turns) {
  const lines = [`# ${config} — ${scenario.title}`, '', `Synthetic scenario ${scenario.name}. Persona: ${scenario.persona.name}, ${scenario.persona.role} (${scenario.persona.temperament}).`, ''];
  for (const run of [...new Set(turns.map(record => record.run))].sort((a, b) => a - b)) {
    lines.push(`## Run ${run}`, '');
    for (const record of turns.filter(item => item.run === run).sort((a, b) => a.turnIndex - b.turnIndex)) {
      const item = scenario.turns[record.turnIndex];
      lines.push(`**Candidate:** ${item?.message ?? ''}`, '', `**Interviewer:** ${turnReply(record)}`, '',
        `_first sentence ${ms(record.firstSentenceMs)} ms, first delta ${ms(record.firstDeltaMs)} ms, total ${ms(record.totalMs)} ms, cost ${usd(record.costUsd)}${item?.expect ? `; expect: ${item.expect}` : ''}_`, '');
    }
  }
  return lines.join('\n');
}

async function writeReports(outDir, records, { interviewerConfigs, classifierConfigs, scenarios }) {
  const summary = summarize({ records, interviewerConfigs, classifierConfigs, scenarios });
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(outDir, 'summary.md'), renderSummaryMarkdown(summary), { mode: 0o600 });
  const turns = records.filter(record => record.type === 'turn' && record.kind === 'interviewer');
  for (const config of [...new Set(turns.map(record => record.config))]) {
    const dir = path.join(outDir, 'transcripts', safeName(config));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const scenario of scenarios) {
      const mine = turns.filter(record => record.config === config && record.scenario === scenario.name);
      if (mine.length) await fs.writeFile(path.join(dir, `${safeName(scenario.name)}.md`), renderTranscript(config, scenario, mine), { mode: 0o600 });
    }
  }
  const { packets, key } = buildJudgePackets({ records, scenarios });
  const packetDir = path.join(outDir, 'judge-packets');
  await fs.mkdir(packetDir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(packets)) await fs.writeFile(path.join(packetDir, `${safeName(name)}.md`), text, { mode: 0o600 });
  await fs.writeFile(path.join(outDir, 'judge-key.json'), JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
  return { summary, key };
}

// ---------- run ----------
async function bounded(timeoutMs, run) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([run(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const derive = (result, record) => ({
  control: result.control !== undefined ? result.control : /^\s*<listen\/>/.test(result.text ?? '') ? 'listen' : null,
  endCall: result.endCall !== undefined ? !!result.endCall : /<end-call\/>/.test(result.text ?? ''),
  ...record,
});

export async function runBenchmark(options) {
  const { outDir, interviewerConfigs = [], classifierConfigs = [], only, timeoutMs = 30_000, runs = 2, reportOnly = false,
    claudeBin = 'claude', scenarios = SCENARIOS, classifierCases = CLASSIFIER_CASES, brief = SYNTHETIC_BRIEF, plan = SYNTHETIC_PLAN,
    createSession = config => createInterviewerSession({ ...config, claudeBin }), onProgress = () => {} } = options;
  if (!outDir) throw new Error('--out is required.');
  if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid benchmark options.');
  if (only !== undefined && !['interviewer', 'classifier'].includes(only)) throw new Error('--only must be interviewer or classifier.');
  for (const config of [...interviewerConfigs, ...classifierConfigs]) assertInterviewerConfig(config);
  await assertExternalOutput(outDir, options.repoRoot);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const journalPath = path.join(outDir, 'results.jsonl');
  const existing = await readJournal(journalPath);
  if (reportOnly && !existing) throw new Error('No existing run to report.');
  const records = existing || [];
  const append = async batch => {
    const stamped = batch.map(record => ({ ...record, at: new Date().toISOString() }));
    await fs.appendFile(journalPath, stamped.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    records.push(...batch);
  };
  const stopped = (kind, id) => records.some(record => record.type === 'failure' && record.kind === kind && record.config === id);

  if (!reportOnly && only !== 'classifier') for (const config of interviewerConfigs) {
    const id = configId(config);
    for (let run = 1; run <= runs && !stopped('interviewer', id); run += 1) for (const scenario of scenarios) {
      if (stopped('interviewer', id)) break;
      const done = records.filter(record => record.type === 'turn' && record.kind === 'interviewer' && record.config === id
        && record.run === run && record.scenario === scenario.name).length;
      if (done >= scenario.turns.length) continue;
      onProgress({ kind: 'interviewer', config: id, run, scenario: scenario.name });
      const batch = [];
      let session;
      let turnIndex = null;
      try {
        session = await createSession(config);
        const instructions = buildInterviewerInstructions({ persona: scenario.persona, brief, plan, history: scenario.history });
        await bounded(timeoutMs, signal => session.start({ instructions, signal }));
        for (turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
          const item = scenario.turns[turnIndex];
          const started = performance.now();
          const result = await bounded(timeoutMs, signal => session.turn(item.message, { signal }));
          const text = typeof result.text === 'string' ? result.text : '';
          batch.push({ type: 'turn', kind: 'interviewer', config: id, run, scenario: scenario.name, turnIndex,
            ...derive({ ...result, text }, {
              text, firstSentenceMs: Number.isFinite(result.firstSentenceMs) ? result.firstSentenceMs : null,
              firstDeltaMs: Number.isFinite(result.firstDeltaMs) ? result.firstDeltaMs : null,
              totalMs: Number.isFinite(result.totalMs) ? result.totalMs : Math.round(performance.now() - started),
              usage: result.usage ?? null, costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null, model: result.model ?? null,
              ultracode: config.ultracode === true, expectControl: item.expectControl ?? null,
            }) });
        }
        await append(batch);
      } catch (error) {
        // Turns already completed stay in the journal; the failure stops this configuration (no retry, no substitution).
        batch.push({ type: 'failure', kind: 'interviewer', config: id, run, scenario: scenario.name, turnIndex, code: error?.code || 'TURN_FAILED' });
        await append(batch);
      } finally { await session?.close?.(); }
    }
  }

  if (!reportOnly && only !== 'interviewer') for (const config of classifierConfigs) {
    const id = configId(config);
    if (stopped('classifier', id)) continue;
    const done = new Set(records.filter(record => record.type === 'case' && record.kind === 'classifier' && record.config === id)
      .map(record => `${record.run}\0${record.caseId}`));
    const pending = Array.from({ length: runs }, (_, index) => index + 1)
      .flatMap(run => classifierCases.map(item => ({ run, item }))).filter(({ run, item }) => !done.has(`${run}\0${item.id}`));
    if (!pending.length) continue;
    let session;
    let caseId = null;
    try {
      session = await createSession(config);
      await bounded(timeoutMs, signal => session.start({ instructions: CLASSIFIER_INSTRUCTIONS, signal }));
      for (const { run, item } of pending) {
        caseId = item.id;
        onProgress({ kind: 'classifier', config: id, run, caseId });
        const started = performance.now();
        const result = await bounded(timeoutMs, signal => session.turn(classifierMessage(item), { signal }));
        const answer = String(result.text ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
        await append([{ type: 'case', kind: 'classifier', config: id, run, caseId: item.id, label: item.label, answer,
          correct: answer === item.label, totalMs: Number.isFinite(result.totalMs) ? result.totalMs : Math.round(performance.now() - started) }]);
      }
    } catch (error) {
      await append([{ type: 'failure', kind: 'classifier', config: id, caseId, code: error?.code || 'TURN_FAILED' }]);
    } finally { await session?.close?.(); }
  }

  const { summary, key } = await writeReports(outDir, records, { interviewerConfigs, classifierConfigs, scenarios });
  return { summary, key, records };
}

// ---------- CLI ----------
function parseArguments(argv) {
  const booleans = new Set(['--help', '--report-only']);
  const values = new Set(['--out', '--models', '--efforts', '--ultracode', '--classifier-models', '--classifier-efforts', '--claude-bin', '--timeout-ms', '--runs', '--only']);
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
  const only = args['--only'];
  const { summary } = await runBenchmark({
    outDir, only, reportOnly: !!args['--report-only'], claudeBin: args['--claude-bin'] || 'claude',
    timeoutMs: Number(args['--timeout-ms'] || 30_000), runs: Number(args['--runs'] || 2),
    interviewerConfigs: only === 'classifier' ? [] : buildConfigs(args['--models'] || MODELS.join(','), args['--efforts'] || 'low,medium,high',
      args['--ultracode'] || 'off'),
    classifierConfigs: only === 'interviewer' ? [] : classifierConfigsOf(buildConfigs(args['--classifier-models'] || 'haiku,sonnet', args['--classifier-efforts'] || 'low,medium')),
    onProgress: ({ kind, config, run, scenario, caseId }) => console.log(`${kind} ${config} run=${run} ${scenario ?? caseId}`),
  });
  console.log(renderSummaryMarkdown(summary));
  console.log(`Reports, transcripts and judge packets: ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
