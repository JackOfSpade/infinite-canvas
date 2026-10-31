// Standalone CLI benchmark. Deliberately does not import application/Electron code.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createTransport as defaultCreateTransport, inspectCli } from './interview-match-transports.mjs';
import {
  PROMPT_VERSION, assertExternalOutput, bankDigest, casePrompt, digest, expectedTurnKind, matchInstructions,
  normalizeBank, parsePrediction, validateCases, writePrivateJson,
} from './interview-match-shared.mjs';

const TRANSPORTS = ['claude-cold', 'claude-warm', 'codex'];
const USAGE = `Usage: node scripts/interview-match-benchmark.mjs --bank <file> --cases <file> --out <dir>
  [--transports claude-cold,claude-warm,codex]
  [--claude-models haiku,sonnet,opus] [--claude-efforts default,low,high]
  [--codex-models gpt-6.1-terra,gpt-6.1-sol,gpt-6-luna] [--codex-efforts low,medium]
  [--timeout-ms 30000] [--bridge-latency-ms <measured milliseconds>]
  [--claude-bin claude] [--codex-bin codex] [--report-only]

Run outside the agent sandbox. Concurrency is always 1. Warm sessions run two
passes; cold/Codex one. Reusing --out resumes the identical run. --report-only
rebuilds reports with no CLI inspection or AI calls. Private output must be
outside the repository. --help never makes an AI call.`;

const sampleKey = record => `${record.configId}\0${record.pass}\0${record.caseId}`;
const passes = config => config.transport === 'claude-warm' ? [1, 2] : [1];
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const milliseconds = values => values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
function percentile(values, quantile) {
  const sorted = milliseconds(values);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] : null;
}

function expectedCard(item) {
  return item.label === 'follow-up' ? item.previousCardId : item.label;
}

export function scoreResults({ cases, records, configs, confidenceThreshold = 0.8, bridgeLatencyMs = null }) {
  const index = new Map(records.filter(record => !record.type || record.type === 'sample').map(record => [sampleKey(record), record]));
  const rows = [];
  for (const config of configs) for (const pass of passes(config)) {
    const samples = cases.map(item => ({ item, record: index.get(sampleKey({ configId: config.id, pass, caseId: item.id })) }));
    const valid = samples.filter(({ record }) => record?.status === 'ok');
    const cardMatched = ({ item, record }) => record?.status === 'ok' && record.prediction?.cardId === expectedCard(item);
    const kindMatched = ({ item, record }) => record?.status === 'ok' && record.prediction?.kind === expectedTurnKind(item);
    const matched = sample => cardMatched(sample) && kindMatched(sample);
    const clear = samples.filter(({ item }) => item.kind === 'paraphrase');
    const none = samples.filter(({ item }) => item.label === 'none');
    const nonQuestions = samples.filter(({ item }) => item.kind === 'not-question');
    const nonQuestionPredicted = valid.filter(({ record }) => record.prediction.kind === 'not-question').length;
    const nonQuestionCorrect = nonQuestions.filter(kindMatched).length;
    const kindCorrect = samples.filter(kindMatched).length;
    const followUps = samples.filter(({ item }) => item.kind === 'follow-up');
    const followUpCorrect = followUps.filter(matched).length;
    const nonePredicted = valid.filter(({ record }) => record.prediction.cardId === 'none').length;
    const noneTruePositive = none.filter(cardMatched).length;
    const parseFailures = samples.filter(({ record }) => record?.status === 'parse-error').length;
    const callFailures = samples.filter(({ record }) => record?.status === 'call-error').length;
    const completed = samples.filter(({ record }) => record).length;
    const correct = samples.filter(matched).length;
    const clearCorrect = clear.filter(matched).length;
    const falseConfidentNone = none.filter(({ record }) => record?.status === 'ok'
      && record.prediction.cardId !== 'none' && record.prediction.confidence >= confidenceThreshold).length;
    const latencies = valid.map(({ record }) => record.latencyMs);
    const ttfts = valid.map(({ record }) => record.ttftMs);
    const multiPart = samples.filter(({ item }) => item.kind === 'multi-part');
    const noisy = samples.filter(({ item }) => item.kind === 'noisy');
    const leadIns = samples.filter(({ item }) => item.kind === 'lead-in');
    const followUpFalsePositives = valid.filter(({ item, record }) => item.kind !== 'follow-up' && record.prediction.kind === 'follow-up').length;
    const replayDrifts = records.filter(record => record.type === 'replay' && record.configId === config.id && record.drift).length;
    const row = {
      configId: config.id, transport: config.transport, model: config.model, effort: config.effort, pass,
      total: cases.length, completed, correct, accuracy: ratio(correct, cases.length),
      kindCorrect, kindAccuracy: ratio(kindCorrect, cases.length),
      leadInTotal: leadIns.length, leadInAccuracy: ratio(leadIns.filter(matched).length, leadIns.length),
      notQuestionTotal: nonQuestions.length, notQuestionCorrect: nonQuestionCorrect,
      notQuestionPrecision: ratio(nonQuestionCorrect, nonQuestionPredicted), notQuestionRecall: ratio(nonQuestionCorrect, nonQuestions.length),
      clearTotal: clear.length, clearCorrect, clearAccuracy: ratio(clearCorrect, clear.length),
      multiPartAccuracy: ratio(multiPart.filter(matched).length, multiPart.length),
      noisyAccuracy: ratio(noisy.filter(matched).length, noisy.length),
      noneTotal: none.length, nonePredicted, noneTruePositive,
      nonePrecision: ratio(noneTruePositive, nonePredicted), noneRecall: ratio(noneTruePositive, none.length),
      falseConfidentNone, followUpTotal: followUps.length, followUpCorrect,
      followUpAccuracy: ratio(followUpCorrect, followUps.length), followUpFalsePositives,
      parseFailures, parseFailureRate: ratio(parseFailures, cases.length), callFailures,
      p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95),
      ttftP50Ms: percentile(ttfts, 0.5), ttftP95Ms: percentile(ttfts, 0.95),
      replayDrifts,
      resolvedModels: [...new Set(valid.flatMap(({ record }) => record.resolvedModel ? [record.resolvedModel] : []))],
      eligible: completed === cases.length && clear.length > 0 && none.length > 0
        && clearCorrect / clear.length >= 0.95 && kindCorrect / cases.length >= 0.95
        && nonQuestionCorrect === nonQuestions.length && falseConfidentNone === 0 && parseFailures === 0 && callFailures === 0 && replayDrifts === 0,
    };
    rows.push(row);
  }
  const candidates = rows.filter(row => row.pass === 1 && row.eligible
    && rows.filter(other => other.configId === row.configId).every(other => other.eligible)
    && Number.isFinite(row.p50Ms));
  candidates.sort((a, b) => a.p50Ms - b.p50Ms || a.p95Ms - b.p95Ms || a.configId.localeCompare(b.configId));
  const winner = candidates[0];
  return {
    version: 2, confidenceThreshold, rows,
    recommendation: winner ? { configId: winner.configId, pass: 1, p50Ms: winner.p50Ms, p95Ms: winner.p95Ms,
      meetsLatencyTarget: winner.p95Ms <= 3_000 } : null,
    bridgeLatencyMs, setupErrors: records.filter(record => record.type === 'setup-error'),
    callErrors: records.filter(record => (!record.type || record.type === 'sample') && record.status === 'call-error')
      .map(({ configId, pass, caseId, code }) => ({ configId, pass, caseId, code })),
    warmSetups: records.filter(record => record.type === 'warm-setup'),
    replays: records.filter(record => record.type === 'replay').length,
  };
}

const percent = value => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const ms = value => value === null ? '—' : `${Math.round(value)}`;
const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');

export function renderMarkdown(summary) {
  const lines = [
    '# Interview AI matching benchmark', '',
    '| Configuration | Pass | Complete | p50 ms | p95 ms | TTFT p50/p95 ms | Selection | Kind | Lead-in | Not-question P/R | Clear | Multi | Noisy | None P/R | Confident false card | Follow-up | Follow-up FP | JSON failures | Call failures | Eligible |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of summary.rows) lines.push(`| ${cell(row.configId)} | ${row.pass} | ${row.completed}/${row.total} | ${ms(row.p50Ms)} | ${ms(row.p95Ms)} | ${ms(row.ttftP50Ms)}/${ms(row.ttftP95Ms)} | ${percent(row.accuracy)} | ${percent(row.kindAccuracy)} | ${percent(row.leadInAccuracy)} | ${percent(row.notQuestionPrecision)}/${percent(row.notQuestionRecall)} | ${percent(row.clearAccuracy)} | ${percent(row.multiPartAccuracy)} | ${percent(row.noisyAccuracy)} | ${percent(row.nonePrecision)}/${percent(row.noneRecall)} | ${row.falseConfidentNone} | ${percent(row.followUpAccuracy)} | ${row.followUpFalsePositives} | ${percent(row.parseFailureRate)} | ${row.callFailures} | ${row.eligible ? 'yes' : 'no'} |`);
  lines.push('', `Confident means confidence ≥ ${summary.confidenceThreshold}. Selection = correct turn kind and card together. Kind = question/follow-up/not-question accuracy. Lead-in = acknowledgement-prefixed question selection. Clear = standalone paraphrases. Missing/failed attempts remain in accuracy denominators. Latency percentiles use valid parsed responses only; no-response timeouts are call failures.`, '');
  if (summary.recommendation) {
    const result = summary.recommendation;
    lines.push(`Recommendation: **${cell(result.configId)}**, pass 1 p50 ${ms(result.p50Ms)} ms, p95 ${ms(result.p95Ms)} ms. ${result.meetsLatencyTarget ? 'p95 meets the 3 s matching ceiling.' : '**Latency target missed:** p95 exceeds 3 s.'}`);
  } else lines.push('Recommendation: none. No complete configuration passed the clear-paraphrase, turn-classification, abstention, and failure gates on every pass.');
  lines.push('', 'Ranked by pass 1 p50, then p95. Both warm passes must qualify; pass 2 repeats prompts and can benefit from prior context as well as caching. Warm initialization and resume replay are excluded. CLI cold includes startup; it does not guarantee an empty provider prompt cache. Matching time excludes speech finalization and card rendering.', '');
  if (summary.bridgeLatencyMs !== null) lines.push(`ChatGPT bridge: ${ms(summary.bridgeLatencyMs)} ms supplied externally (single measured figure; no accuracy or percentile claim; excluded from ranking).`, '');
  else lines.push('ChatGPT bridge: not measured. It requires an in-app measurement; see the benchmark guide.', '');
  if (summary.warmSetups?.length) lines.push(`Warm initializations: ${summary.warmSetups.map(record => `${cell(record.configId)} ${ms(record.latencyMs)} ms`).join('; ')}.`, '');
  if (summary.setupErrors?.length) lines.push('Unavailable or failed configurations:', '',
    ...summary.setupErrors.map(record => `- ${cell(record.configId)}: ${cell(record.code)}`), '');
  if (summary.callErrors?.length) lines.push('Call failures:', '',
    ...summary.callErrors.map(record => `- ${cell(record.configId)}, pass ${record.pass}, ${cell(record.caseId)}: ${cell(record.code)}`), '');
  const drifted = summary.rows.filter(row => row.pass === 1 && row.replayDrifts);
  if (drifted.length) lines.push('Warm resume changed prior predictions; these configurations require a fresh run before recommendation:', '',
    ...drifted.map(row => `- ${cell(row.configId)}: ${row.replayDrifts} changed replay predictions`), '');
  return lines.join('\n') + '\n';
}

export function renderCsv(summary) {
  const columns = ['configId', 'transport', 'model', 'effort', 'resolvedModels', 'pass', 'total', 'completed', 'correct', 'accuracy',
    'kindCorrect', 'kindAccuracy', 'leadInTotal', 'leadInAccuracy', 'notQuestionTotal', 'notQuestionCorrect', 'notQuestionPrecision', 'notQuestionRecall',
    'clearTotal', 'clearCorrect', 'clearAccuracy', 'multiPartAccuracy', 'noisyAccuracy', 'noneTotal', 'nonePredicted', 'noneTruePositive',
    'nonePrecision', 'noneRecall', 'falseConfidentNone', 'followUpTotal', 'followUpCorrect', 'followUpAccuracy', 'followUpFalsePositives',
    'parseFailures', 'parseFailureRate', 'callFailures', 'p50Ms', 'p95Ms', 'ttftP50Ms', 'ttftP95Ms', 'replayDrifts', 'eligible'];
  const escape = value => `"${String(Array.isArray(value) ? value.join(';') : value ?? '').replace(/"/g, '""')}"`;
  return [columns.join(','), ...summary.rows.map(row => columns.map(column => escape(row[column])).join(','))].join('\n') + '\n';
}

async function acquireLock(outDir) {
  const file = path.join(outDir, '.benchmark.lock');
  const value = JSON.stringify({ pid: process.pid, host: os.hostname() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(file, value, { flag: 'wx', mode: 0o600 });
      return async () => { await fs.rm(file, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = JSON.parse(await fs.readFile(file, 'utf8'));
      if (lock.host !== os.hostname()) throw new Error('Output is locked by another host.');
      try { process.kill(lock.pid, 0); }
      catch (probeError) {
        if (probeError.code !== 'ESRCH') throw new Error('Cannot verify output lock owner.');
        await fs.rm(file);
        continue;
      }
      throw new Error('Another benchmark is using this output directory.');
    }
  }
  throw new Error('Could not acquire benchmark output lock.');
}

async function readJournal(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // A crash can leave a partial last append. Only that unterminated tail may be
  // discarded; corruption of an already completed line must stop the resume.
  const end = text.lastIndexOf('\n') + 1;
  if (end !== text.length) await fs.truncate(file, Buffer.byteLength(text.slice(0, end)));
  return text.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function validateConfigs(configs) {
  const ids = new Set();
  if (!Array.isArray(configs) || !configs.length) throw new Error('At least one configuration is required.');
  for (const config of configs) {
    if (!config.id || ids.has(config.id) || !TRANSPORTS.includes(config.transport) || !config.model || !config.effort) throw new Error('Invalid or duplicate configuration.');
    ids.add(config.id);
  }
}

async function boundedRequest(transport, prompt, timeoutMs) {
  let timer;
  try {
    return await Promise.race([transport.request(prompt), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('MATCH_TIMEOUT'), { code: 'MATCH_TIMEOUT' })), timeoutMs + 250);
    })]);
  } catch (error) {
    // Reap a timed-out child before any subsequent request can start.
    if (error.code === 'MATCH_TIMEOUT') await transport.close();
    throw error;
  } finally { clearTimeout(timer); }
}

export async function runBenchmark(options) {
  const cards = normalizeBank(options.cards);
  const cases = validateCases(options.cases, cards);
  const { configs, outDir, timeoutMs = 30_000, confidenceThreshold = 0.8, bridgeLatencyMs = null,
    createTransport = defaultCreateTransport, reportOnly = false, cliMetadata = {}, onProgress = () => {} } = options;
  validateConfigs(configs);
  if (!outDir || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(confidenceThreshold)
    || confidenceThreshold < 0 || confidenceThreshold > 1 || (bridgeLatencyMs !== null && (!Number.isFinite(bridgeLatencyMs) || bridgeLatencyMs < 0))) throw new Error('Invalid benchmark options.');
  await assertExternalOutput(outDir);
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const unlock = await acquireLock(outDir);
  let active;
  let interrupted = false;
  const interrupt = () => { interrupted = true; void active?.close(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let workDir;
  try {
    const identity = { version: 1, promptVersion: PROMPT_VERSION, bankDigest: bankDigest(cards), casesDigest: digest(cases),
      configs, timeoutMs, confidenceThreshold, claudeBin: options.claudeBin || 'claude', codexBin: options.codexBin || 'codex' };
    const manifestPath = path.join(outDir, 'manifest.json');
    let previous;
    try { previous = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && digest(previous.identity) !== digest(identity)) throw new Error('Resume inputs/configuration changed. Use a new output directory.');
    if (!previous) {
      if (reportOnly) throw new Error('No existing run to report.');
      await writePrivateJson(manifestPath, { identity, createdAt: new Date().toISOString(), cliMetadata,
        runtime: { node: process.version, platform: process.platform, arch: process.arch }, caseCount: cases.length });
    }
    const journalPath = path.join(outDir, 'results.jsonl');
    const records = await readJournal(journalPath);
    const append = async record => {
      await fs.appendFile(journalPath, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      records.push(record);
    };
    const samples = new Map(records.filter(record => record.type === 'sample').map(record => [sampleKey(record), record]));
    if (!reportOnly) {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-match-cli-'));
      for (const config of configs) {
        const sequence = passes(config).flatMap(pass => cases.map(item => ({ pass, item })));
        if (sequence.every(({ pass, item }) => samples.has(sampleKey({ configId: config.id, pass, caseId: item.id })))) continue;
        if (interrupted) throw new Error('Benchmark interrupted; resume with the same command.');
        try {
          const kind = config.transport === 'codex' ? 'codex' : 'claude';
          if (cliMetadata[kind]?.available === false) throw Object.assign(new Error('CLI unavailable'),
            { code: cliMetadata[kind].error || `${kind.toUpperCase()}_UNAVAILABLE` });
          const openTransport = () => createTransport(config, { timeoutMs, claudeBin: identity.claudeBin, codexBin: identity.codexBin,
            cwd: workDir, claudeHelp: cliMetadata.claude?.help, codexHelp: cliMetadata.codex?.help });
          active = await openTransport();
          if (interrupted) throw Object.assign(new Error('MATCH_INTERRUPTED'), { code: 'MATCH_INTERRUPTED' });
          if (config.transport === 'claude-warm') {
            const setup = await boundedRequest(active, matchInstructions(cards) + '\nRemember these cards. Reply READY. Later messages are independent classifications.', timeoutMs);
            if (setup.text.trim() !== 'READY') throw Object.assign(new Error('MATCH_INIT_INVALID'), { code: 'MATCH_INIT_INVALID' });
            await append({ type: 'warm-setup', configId: config.id, latencyMs: setup.latencyMs, resolvedModel: setup.resolvedModel, usage: setup.usage });
          }
          for (const { pass, item } of sequence) {
            if (interrupted) throw Object.assign(new Error('MATCH_INTERRUPTED'), { code: 'MATCH_INTERRUPTED' });
            const key = sampleKey({ configId: config.id, pass, caseId: item.id });
            const short = casePrompt(item, cards);
            const prompt = config.transport === 'claude-warm' ? short : matchInstructions(cards) + '\n' + short;
            if (samples.has(key)) {
              if (config.transport === 'claude-warm') {
                const replay = await boundedRequest(active, prompt, timeoutMs);
                let prediction;
                try { prediction = parsePrediction(replay.text, cards, item.previousCardId); }
                catch { throw Object.assign(new Error('Invalid replay response'), { code: 'MATCH_REPLAY_INVALID' }); }
                const original = samples.get(key).prediction;
                const drift = !!original && (original.cardId !== prediction.cardId || original.kind !== prediction.kind);
                await append({ type: 'replay', configId: config.id, pass, caseId: item.id, latencyMs: replay.latencyMs, drift });
              }
              continue;
            }
            onProgress({ configId: config.id, pass, caseId: item.id });
            const started = performance.now();
            let record = { type: 'sample', configId: config.id, pass, caseId: item.id };
            try {
              const result = await boundedRequest(active, prompt, timeoutMs);
              const parseStart = performance.now();
              try {
                record.prediction = parsePrediction(result.text, cards, item.previousCardId);
                record.status = 'ok';
              } catch (error) { record.status = 'parse-error'; record.code = error.message; }
              record.latencyMs = Math.round((Number.isFinite(result.latencyMs) ? result.latencyMs : parseStart - started) + performance.now() - parseStart);
              record.ttftMs = Number.isFinite(result.ttftMs) ? result.ttftMs : null;
              if (result.resolvedModel) record.resolvedModel = result.resolvedModel;
              if (result.usage) record.usage = result.usage;
            } catch (error) {
              record.status = 'call-error'; record.code = error.code || 'MATCH_CALL_FAILED';
              record.latencyMs = Math.round(performance.now() - started); record.ttftMs = null;
            }
            await append(record);
            samples.set(key, record);
            if (record.status === 'call-error') {
              // A slow cold call remains one failed observation. Its process
              // is reaped before measuring the next case, without a retry.
              // Permanent failures and broken warm sessions stop this config.
              if (config.transport === 'claude-warm' || !record.code.endsWith('_TIMEOUT')) break;
              await active.close();
              active = await openTransport();
            }
          }
        } catch (error) {
          await append({ type: 'setup-error', configId: config.id, code: error.code || 'MATCH_SETUP_FAILED' });
        } finally { await active?.close(); active = undefined; }
      }
    }
    const summary = scoreResults({ cases, records, configs, confidenceThreshold, bridgeLatencyMs });
    await writePrivateJson(path.join(outDir, 'summary.json'), summary);
    await fs.writeFile(path.join(outDir, 'summary.csv'), renderCsv(summary), { mode: 0o600 });
    await fs.writeFile(path.join(outDir, 'summary.md'), renderMarkdown(summary), { mode: 0o600 });
    if (interrupted) throw new Error('Benchmark interrupted; resume with the same command.');
    return summary;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await active?.close();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
    await unlock();
  }
}

function parseArguments(argv) {
  const boolean = new Set(['--help', '--report-only']);
  const values = new Set(['--bank', '--cases', '--out', '--transports', '--claude-models', '--claude-efforts', '--codex-models', '--codex-efforts', '--timeout-ms', '--bridge-latency-ms', '--claude-bin', '--codex-bin']);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (Object.hasOwn(result, flag) || (!boolean.has(flag) && !values.has(flag))) throw new Error(`Unknown or duplicate option: ${flag}`);
    if (boolean.has(flag)) result[flag] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}

const list = value => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
function configurations(args, claudeHelp) {
  const transports = list(args['--transports'] || TRANSPORTS.join(','));
  if (!transports.length || transports.some(value => !TRANSPORTS.includes(value))) throw new Error('Unknown or empty transport list.');
  const result = [];
  for (const transport of transports) {
    const isCodex = transport === 'codex';
    const models = list(args[isCodex ? '--codex-models' : '--claude-models'] || (isCodex ? 'gpt-6.1-terra,gpt-6.1-sol,gpt-6-luna' : 'haiku,sonnet,opus'));
    const efforts = list(args[isCodex ? '--codex-efforts' : '--claude-efforts'] || (isCodex ? 'low,medium' : claudeHelp.includes('--effort') ? 'default,low,high' : 'default'));
    if (!models.length || !efforts.length || efforts.some(value => !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value))) throw new Error('Invalid model/effort list.');
    for (const model of models) for (const effort of efforts) result.push({ id: `${transport}/${model}/${effort}`, transport, model, effort });
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args['--help']) { console.log(USAGE); return; }
  if (!args['--bank'] || !args['--cases'] || !args['--out']) throw new Error(USAGE);
  const outDir = path.resolve(args['--out']);
  await assertExternalOutput(outDir);
  const cards = normalizeBank(JSON.parse(await fs.readFile(args['--bank'], 'utf8')));
  const cases = validateCases(JSON.parse(await fs.readFile(args['--cases'], 'utf8')), cards);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reportOnly = !!args['--report-only'];
  const claudeBin = args['--claude-bin'] || manifest?.identity.claudeBin || 'claude';
  const codexBin = args['--codex-bin'] || manifest?.identity.codexBin || 'codex';
  let cliMetadata = manifest?.cliMetadata || {};
  if (!reportOnly) {
    const requested = args['--transports'] ? list(args['--transports']) : manifest?.identity.configs.map(config => config.transport) || TRANSPORTS;
    // These are help/version probes only, before the sequential paid run.
    const probes = await Promise.allSettled([
      requested.some(value => value.startsWith('claude-')) ? inspectCli(claudeBin, 'claude') : null,
      requested.includes('codex') ? inspectCli(codexBin, 'codex') : null,
    ]);
    cliMetadata = { claude: probes[0].status === 'fulfilled' ? probes[0].value : null,
      codex: probes[1].status === 'fulfilled' ? probes[1].value : null };
  }
  const hasConfigArgs = ['--transports', '--claude-models', '--claude-efforts', '--codex-models', '--codex-efforts'].some(key => args[key]);
  const configs = manifest && !hasConfigArgs ? manifest.identity.configs : configurations(args, cliMetadata.claude?.help || '');
  const summary = await runBenchmark({ cards, cases, configs, outDir, reportOnly, claudeBin, codexBin, cliMetadata,
    timeoutMs: Number(args['--timeout-ms'] || manifest?.identity.timeoutMs || 30_000),
    bridgeLatencyMs: args['--bridge-latency-ms'] === undefined ? null : Number(args['--bridge-latency-ms']),
    onProgress: ({ configId, pass, caseId }) => console.log(`${configId} pass=${pass} case=${caseId}`),
  });
  console.log(renderMarkdown(summary));
  console.log(`Reports: ${path.join(outDir, 'summary.md')} and summary.csv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
