#!/usr/bin/env node
// Turns the opt-in shadow measurements (<dir>/shadow.jsonl, written by
// electron/ipc/aiShadowMeasure.js) into a per-(kind,id) routing recommendation.
// Plain Node ESM, no app imports. The data is private, so --dir inside the repo is refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const Z_95 = 1.645; // one-sided 95%
const Z_WILSON = 1.96; // two-sided 95% interval
const MAX_FAILURE_RATE = 0.05;
const DEFAULT_MIN_SAMPLES = 30;
export const FOOTNOTE = 'Note: a blind quality judge is still needed whenever the validator does not fully check quality; a valid rate only measures what the validator checks.';

const USAGE = `Usage: node scripts/ai-shadow-report.mjs --dir <shadow dir> [--min-samples ${DEFAULT_MIN_SAMPLES}] [--json]

Summarizes <shadow dir>/shadow.jsonl per (kind,id) and recommends a DeepSeek
(route, reasoning) config or "stay on Claude".

  --dir <path>         directory containing shadow.jsonl (must be outside the repository)
  --min-samples <n>    minimum rows per config to be eligible (default ${DEFAULT_MIN_SAMPLES})
  --json               print JSON instead of Markdown
  --help               print this help
`;

export function parseRows(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (typeof row.kind !== 'string' || typeof row.id !== 'string' || typeof row.sampleId !== 'string') continue;
    if (typeof row.route !== 'string' || typeof row.reasoning !== 'string') continue;
    rows.push(row);
  }
  return rows;
}

/** Wilson 95% score interval for k successes out of n. */
export function wilson(k, n) {
  if (!(n > 0)) return { rate: null, low: null, high: null };
  const p = k / n;
  const z2 = Z_WILSON * Z_WILSON;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_WILSON * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function numbers(values) {
  return values.filter(value => typeof value === 'number' && Number.isFinite(value));
}

function mean(values) {
  const list = numbers(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

function percentile(values, q) {
  const list = numbers(values).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.max(0, Math.ceil(q * list.length) - 1))];
}

// z statistic for (rateA - rateB) with a pooled standard error; large = A is above B.
function zDifference(rateA, nA, rateB, nB) {
  const diff = rateA - rateB;
  const pooled = (rateA * nA + rateB * nB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return diff > 0 ? Infinity : 0;
  return diff / se;
}

/** True when `rate` (n) is significantly below `reference` (refN): one-sided 95% two-proportion z-test. */
function significantlyBelow(reference, refN, rate, n) {
  return zDifference(reference, refN, rate, n) >= Z_95;
}

function summarizeClaude(kind, rows) {
  const bySample = new Map();
  for (const row of rows) if (!bySample.has(row.sampleId)) bySample.set(row.sampleId, row.claude && typeof row.claude === 'object' ? row.claude : {});
  const claudes = [...bySample.values()];
  const outcomes = claudes.map(claude => claude.outcome ?? null);
  const rated = kind === 'qa' ? outcomes.map(outcome => outcome ?? 'accepted') : outcomes.filter(outcome => outcome !== null);
  const accepted = rated.filter(outcome => outcome === 'accepted').length;
  return {
    samples: claudes.length,
    rated: rated.length,
    acceptanceRate: rated.length ? accepted / rated.length : null,
    meanCostUsd: mean(claudes.map(claude => claude.costUsd)),
    p50DurationMs: percentile(claudes.map(claude => claude.durationMs), 0.5),
    p95DurationMs: percentile(claudes.map(claude => claude.durationMs), 0.95),
  };
}

function summarizeConfig(route, reasoning, rows) {
  const n = rows.length;
  const failures = rows.filter(row => row.ok === false).length;
  const validCount = rows.filter(row => row.valid === true).length;
  const interval = wilson(validCount, n);
  return {
    route, reasoning, n, failures, failureRate: failures / n,
    validCount, validRate: validCount / n, validLow: interval.low, validHigh: interval.high,
    meanCostUsd: mean(rows.map(row => row.costUsd)),
    p50LatencyMs: percentile(rows.map(row => row.latencyMs), 0.5),
    p95LatencyMs: percentile(rows.map(row => row.latencyMs), 0.95),
  };
}

function decide(claude, configs, minSamples) {
  const enough = configs.filter(config => config.n >= minSamples);
  for (const config of configs) {
    config.enoughSamples = config.n >= minSamples;
    config.belowClaude = claude.acceptanceRate !== null && config.enoughSamples
      && significantlyBelow(claude.acceptanceRate, claude.samples, config.validRate, config.n);
    config.tooManyFailures = config.failureRate > MAX_FAILURE_RATE;
    config.eligible = false;
  }
  if (!enough.length) {
    const most = Math.max(0, ...configs.map(config => config.n));
    return { decision: 'stay', route: null, reasoning: null, reason: `too few samples (largest config n=${most}, need ${minSamples})` };
  }
  if (claude.acceptanceRate === null) {
    return { decision: 'stay', route: null, reasoning: null, reason: 'no Claude baseline: no sample has a rated outcome' };
  }
  const base = enough.filter(config => !config.belowClaude && !config.tooManyFailures);
  const best = enough.reduce((top, config) => (config.validRate > top.validRate ? config : top), enough[0]);
  const eligible = base.filter(config => config === best || !significantlyBelow(best.validRate, best.n, config.validRate, config.n));
  for (const config of eligible) config.eligible = true;
  if (!eligible.length) {
    const below = enough.filter(config => config.belowClaude).length;
    const failing = enough.filter(config => config.tooManyFailures).length;
    const parts = [];
    if (below) parts.push(`${below} significantly below Claude's acceptance rate`);
    if (failing) parts.push(`${failing} with call-failure rate above ${MAX_FAILURE_RATE * 100}%`);
    const left = enough.length - below - failing;
    if (left > 0 && !parts.length) parts.push('none within noise of the best config');
    return { decision: 'stay', route: null, reasoning: null, reason: `no eligible config (${parts.join('; ') || 'none qualified'})` };
  }
  const cost = config => (config.meanCostUsd === null ? Infinity : config.meanCostUsd);
  const latency = config => (config.p50LatencyMs === null ? Infinity : config.p50LatencyMs);
  const pick = [...eligible].sort((a, b) => cost(a) - cost(b) || latency(a) - latency(b))[0];
  return {
    decision: 'recommend', route: pick.route, reasoning: pick.reasoning,
    reason: `cheapest of ${eligible.length} eligible config(s): valid ${(pick.validRate * 100).toFixed(1)}% vs Claude ${(claude.acceptanceRate * 100).toFixed(1)}%, n=${pick.n}`,
  };
}

export function summarize(rows, { minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.kind, row.id]);
    if (!groups.has(key)) groups.set(key, { kind: row.kind, id: row.id, rows: [] });
    groups.get(key).rows.push(row);
  }
  const out = [...groups.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .map(group => {
      const claude = summarizeClaude(group.kind, group.rows);
      const byConfig = new Map();
      for (const row of group.rows) {
        const key = JSON.stringify([row.route, row.reasoning]);
        if (!byConfig.has(key)) byConfig.set(key, { route: row.route, reasoning: row.reasoning, rows: [] });
        byConfig.get(key).rows.push(row);
      }
      const configs = [...byConfig.values()]
        .sort((a, b) => a.route.localeCompare(b.route) || a.reasoning.localeCompare(b.reasoning))
        .map(config => summarizeConfig(config.route, config.reasoning, config.rows));
      return { kind: group.kind, id: group.id, claude, configs, recommendation: decide(claude, configs, minSamples) };
    });
  return { minSamples, groups: out, footnote: FOOTNOTE };
}

const pct = value => (value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`);
const usd = value => (value === null || value === undefined ? '-' : `$${value.toFixed(5)}`);
const ms = value => (value === null || value === undefined ? '-' : String(Math.round(value)));

export function renderMarkdown(summary) {
  const lines = [`# AI shadow report (min samples ${summary.minSamples})`, ''];
  if (!summary.groups.length) lines.push('No shadow rows found.', '');
  for (const group of summary.groups) {
    const { claude } = group;
    lines.push(`## ${group.kind} / ${group.id}`, '');
    lines.push('| config | n | failure rate | valid rate | valid 95% CI | mean cost | p50 ms | p95 ms |');
    lines.push('| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |');
    lines.push(`| Claude baseline | ${claude.samples} | - | ${pct(claude.acceptanceRate)} (accepted) | - | ${usd(claude.meanCostUsd)} | ${ms(claude.p50DurationMs)} | ${ms(claude.p95DurationMs)} |`);
    for (const c of group.configs) {
      lines.push(`| ${c.route} ${c.reasoning} | ${c.n} | ${pct(c.failureRate)} | ${pct(c.validRate)} | ${pct(c.validLow)}–${pct(c.validHigh)} | ${usd(c.meanCostUsd)} | ${ms(c.p50LatencyMs)} | ${ms(c.p95LatencyMs)} |`);
    }
    const rec = group.recommendation;
    lines.push('', rec.decision === 'recommend'
      ? `**Recommendation:** ${rec.route} ${rec.reasoning} — ${rec.reason}`
      : `**Recommendation:** stay on Claude — ${rec.reason}`, '');
  }
  lines.push(summary.footnote, '');
  return lines.join('\n');
}

/** True when `dir` is the repository root or inside it (symlinks resolved when the path exists). */
export function isInsideRepo(dir, repoRoot) {
  const real = target => { try { return fs.realpathSync(target); } catch { return path.resolve(target); } };
  const rel = path.relative(real(repoRoot), real(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const opts = { dir: null, minSamples: DEFAULT_MIN_SAMPLES, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--dir') opts.dir = argv[++i] ?? null;
    else if (arg === '--min-samples') {
      const value = argv[++i];
      if (!/^[1-9]\d*$/.test(value ?? '')) throw new Error('--min-samples needs a positive integer');
      opts.minSamples = Number(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, repoRoot = REPO_ROOT } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) { stdout.write(USAGE); return 0; }
  if (!opts.dir) { stderr.write(`--dir is required\n\n${USAGE}`); return 2; }
  const dir = path.resolve(opts.dir);
  if (isInsideRepo(dir, repoRoot)) {
    stderr.write(`Refusing --dir ${dir}: it is inside the repository and shadow data is private.\n`);
    return 2;
  }
  let text;
  try { text = fs.readFileSync(path.join(dir, 'shadow.jsonl'), 'utf8'); } catch (error) {
    stderr.write(`Cannot read ${path.join(dir, 'shadow.jsonl')}: ${error.message}\n`);
    return 1;
  }
  const summary = summarize(parseRows(text), { minSamples: opts.minSamples });
  stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : renderMarkdown(summary));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
