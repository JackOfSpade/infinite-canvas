#!/usr/bin/env node
/** Opt-in real-provider replay. Imports have no CLI/provider side effects. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createInterviewAiMatcher } from '../electron/interviewAiMatcher.js';
import { createInterviewSpeculativeMatcher } from '../electron/interviewSpeculativeMatcher.js';
import { assertExternalOutput, normalizeBank, validateCases, writePrivateJson } from './interview-match-shared.mjs';

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
};
const percent = (count, total) => total ? 100 * count / total : 0;

/** Pure aggregation; a wrong preview counts once per turn, not once per update. */
export function aggregateSpeculativeReplay(records) {
  return [...new Set(records.map(record => record.poolSize))].sort((a, b) => a - b).map(poolSize => {
    const rows = records.filter(record => record.poolSize === poolSize);
    const answerable = rows.filter(record => record.expectedCardId !== 'none');
    const early = answerable.filter(record => Number.isFinite(record.firstCorrectPreviewAt)
      && record.firstCorrectPreviewAt < record.endpointAt);
    const leads = early.map(record => record.endpointAt - record.firstCorrectPreviewAt);
    const instant = rows.filter(record => record.instant).length;
    const inflight = rows.filter(record => record.inflight).length;
    const correct = rows.filter(record => record.expectedCardId === 'none'
      ? record.finalCardId === 'none' || record.finalKind === 'not-question'
      : record.finalCardId === record.expectedCardId);
    return { poolSize, questions: rows.length, answerable: answerable.length,
      correctPreviewPercent: percent(early.length, answerable.length),
      leadTimeMedianMs: percentile(leads, 0.5), leadTimeP10Ms: percentile(leads, 0.1),
      wrongPreviewPercent: percent(rows.filter(record => record.wrongPreview).length, rows.length),
      finalLockMedianMs: percentile(rows.map(record => record.finalLatencyMs), 0.5),
      finalLockP90Ms: percentile(rows.map(record => record.finalLatencyMs), 0.9),
      perceivedLockMedianMs: percentile(rows.map(record => record.perceivedLatencyMs), 0.5),
      perceivedLockP90Ms: percentile(rows.map(record => record.perceivedLatencyMs), 0.9),
      instantLockPercent: percent(instant, rows.length),
      inflightLockPercent: percent(inflight, rows.length),
      reusedLockPercent: percent(instant + inflight, rows.length),
      lockCorrectPercent: percent(correct.length, rows.length),
      callsPerQuestion: rows.reduce((total, record) => total + record.calls, 0) / rows.length };
  });
}

/** Real scheduler, injectable matcher/clock for deterministic unit replay. */
export async function replaySpeculativeCase({ item, bank, matcher, rate = 2.6, silenceMs = 1050,
  now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('Speaking rate must be positive.');
  if (!Number.isFinite(silenceMs) || silenceMs < 0) throw new TypeError('Silence must be non-negative milliseconds.');
  const startedAt = now();
  const expectedCardId = item.label === 'follow-up' ? item.previousCardId : item.label;
  let calls = 0; let firstCorrectPreviewAt = null; let wrongPreview = false;
  const countedMatcher = {
    poolSize: matcher.poolSize, speculativeCapacity: matcher.speculativeCapacity, minConfidence: matcher.minConfidence,
    get availableSpeculative() { return matcher.availableSpeculative; },
    subscribeAvailability: matcher.subscribeAvailability?.bind(matcher),
    select(input) { calls += 1; return matcher.select ? matcher.select(input) : matcher.match(input.text, input); },
  };
  const scheduler = createInterviewSpeculativeMatcher({ matcher: countedMatcher, bank, now,
    onPreview(preview) {
      if (!preview || preview.confidence < 0.6) return;
      if (preview.cardId !== expectedCardId) wrongPreview = true;
      else if (firstCorrectPreviewAt === null) firstCorrectPreviewAt = now() - startedAt;
    } });
  const context = item.previousCardId ? { previousCardId: item.previousCardId,
    previousQuestion: item.previousUtterance || '',
    previousCardQuestion: bank.cards.find(card => card.id === item.previousCardId)?.question || '' } : {};
  const words = item.utterance.trim().split(/\s+/u);
  try {
    for (let index = 0; index < words.length; index += 1) {
      const target = startedAt + index * 1000 / rate;
      if (now() < target) await sleep(target - now());
      scheduler.partial({ turnId: item.id, text: words.slice(0, index + 1).join(' ') }, context);
    }
    // Finish the final word's speaking interval before starting endpoint silence.
    const end = startedAt + words.length * 1000 / rate;
    if (now() < end) await sleep(end - now());
    const lastWordAt = now() - startedAt;
    if (silenceMs > 0) await sleep(silenceMs);
    const finalStartedAt = now();
    const endpointAt = finalStartedAt - startedAt;
    const selection = await scheduler.selectFinal({ id: item.id, text: item.utterance }, context);
    const lockedAt = now();
    return { id: item.id, poolSize: matcher.poolSize, expectedCardId, lastWordAt, endpointAt,
      firstCorrectPreviewAt, wrongPreview, calls,
      finalLatencyMs: Math.max(0, lockedAt - finalStartedAt),
      perceivedLatencyMs: Math.max(0, lockedAt - startedAt - lastWordAt),
      instant: selection.source === 'speculative', inflight: selection.source === 'speculative-inflight',
      finalCardId: selection.cardId, finalKind: selection.kind };
  } finally { scheduler.dispose(); }
}

export function speculativeReplayMarkdown(summary) {
  const display = value => value === null ? '—' : value.toFixed(1);
  return '# Speculative interview matching replay\n\n'
    + 'Lead time is endpoint minus first correct preview (confidence ≥0.6), only when shown before endpoint. Wrong rate counts any wrong preview per turn, including unanswerable turns. Calls count scheduler selections (provider recovery can add transport calls). Final latency includes all final verdicts, including not-question. Perceived lock is time from the last word to selection, including endpoint silence and final latency. Instant locks reuse completed speculative results; inflight locks reuse identical in-flight calls; reused is their sum. Lock correct counts matching final card IDs for answerable turns and none/not-question verdicts for unanswerable turns, over all cases.\n\n'
    + '| Pool | Cases | Correct early / answerable | Lead median / p10 ms | Any wrong preview | Final median / p90 ms | Perceived lock median / p90 ms | Instant locks | Inflight locks | Reused locks | Lock correct | Calls / case |\n'
    + '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
    + summary.map(row => `| ${row.poolSize} | ${row.questions} | ${display(row.correctPreviewPercent)}% | ${display(row.leadTimeMedianMs)} / ${display(row.leadTimeP10Ms)} | ${display(row.wrongPreviewPercent)}% | ${display(row.finalLockMedianMs)} / ${display(row.finalLockP90Ms)} | ${display(row.perceivedLockMedianMs)} / ${display(row.perceivedLockP90Ms)} | ${display(row.instantLockPercent)}% | ${display(row.inflightLockPercent)}% | ${display(row.reusedLockPercent)}% | ${display(row.lockCorrectPercent)}% | ${display(row.callsPerQuestion)} |`).join('\n') + '\n';
}

/** Parse CLI options without touching files or starting a provider. */
export function parseSpeculativeReplayOptions(argv) {
  const options = { pool: '1,2,3', rate: '2.6', 'silence-ms': '1050' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, '');
    if (!['bank', 'cases', 'out', 'pool', 'rate', 'silence-ms'].includes(key) || !argv[index + 1]) throw new Error('Usage: --bank BANK.json --cases CASES.json --out DIRECTORY [--pool 1,2,3] [--rate 2.6] [--silence-ms 1050]');
    options[key] = argv[index + 1];
  }
  if (!options.bank || !options.cases || !options.out) throw new Error('--bank, --cases and --out are required.');
  const pools = [...new Set(options.pool.split(',').map(Number))];
  const rate = Number(options.rate);
  const silenceMs = Number(options['silence-ms']);
  if (!pools.length || pools.some(size => !Number.isInteger(size) || size < 1 || size > 4)
    || !Number.isFinite(rate) || rate <= 0) throw new Error('--pool must list integers 1–4; --rate must be positive words/second.');
  if (!Number.isFinite(silenceMs) || silenceMs < 0) throw new Error('--silence-ms must be non-negative milliseconds.');
  return { bank: options.bank, cases: options.cases, out: options.out, pools, rate, silenceMs };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSpeculativeReplayOptions(argv);
  const { pools, rate, silenceMs } = options;
  await assertExternalOutput(options.out);
  const cards = normalizeBank(JSON.parse(await fs.readFile(options.bank, 'utf8')));
  const cases = validateCases(JSON.parse(await fs.readFile(options.cases, 'utf8')), cards);
  const bank = { cards };
  const records = [];
  for (const poolSize of pools) {
    const matcher = createInterviewAiMatcher({ bank, config: { poolSize } });
    try {
      await matcher.start();
      for (const item of cases) records.push(await replaySpeculativeCase({ item, bank, matcher, rate, silenceMs }));
    } finally { await matcher.close(); }
  }
  const summary = aggregateSpeculativeReplay(records);
  const markdown = speculativeReplayMarkdown(summary);
  await writePrivateJson(path.join(options.out, 'summary.json'), { rate, silenceMs, summary, records });
  await fs.writeFile(path.join(options.out, 'summary.md'), markdown, { mode: 0o600 });
  process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Speculative replay failed. Check input paths, cases and local Claude availability.\n'); process.exitCode = 1; });
}
