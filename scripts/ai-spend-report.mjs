#!/usr/bin/env node
// Annualized Claude spend per call id. Reads the task worker's usage log
// (<userData>/claude-task-usage.jsonl: one row per answered task or per
// interview stage) and, when given, the application runner's run logs
// (<canvas>/.local-ai/claude-runs) where each stage's `response` event carries
// the call's cost. Call ids are the task, `stage:<name>` for application
// stages, or `<task>/<stage>` for interview rows. Prints counts and costs only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_USAGE_FILE } from '../electron/ipc/aiReplaySamples.js';

const DAY_MS = 86_400_000;
const MAX_RUN_LOG_DEPTH = 3;

const round = (value, places) => Number(value.toFixed(places));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isCost = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Pure summarizer. `usageRows` are usage-log rows and every one of them is one
 * call. `runRows` are run-log events: a row is a call when its `event` is
 * `response` or when it carries a numeric costUsd (a row with both is still one
 * call), so stage calls recorded before costs were logged count too. Every run
 * row with a stage and a parseable `at` joins the shared window, including the
 * rows that are not calls (`started`, `thinking-summary`, `failed`, ...).
 * Annualization uses the window of the log source, never of the call: every
 * usage call shares one window, the first-to-last parseable `at` span across
 * all usage rows, and every run call shares the same span across the run rows.
 * Each window is at least one day, so a source observed once annualizes as a
 * single day of spend. Rows without a parseable time sit at `now`, so a source
 * with no parseable time at all spans one day too. Usage entries annualize
 * their recorded total; stage entries annualize the mean recorded cost of
 * their costed calls times all their calls, and are flagged `estimated` when
 * some calls have no recorded cost.
 */
export function summarizeAiSpend({ usageRows = [], runRows = [], now = Date.now() } = {}) {
  const groups = new Map();
  const pairs = new Set();
  const usageTimes = [];
  const runTimes = [];

  /** A row's `at` counts toward its source's window only when it parses. */
  const rememberTime = (times, at) => {
    const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (!Number.isNaN(atMs)) times.push(atMs);
  };

  const observe = (id, isRun, costUsd, model, effort) => {
    if (!id) return;
    let group = groups.get(id);
    if (!group) {
      group = { id, isRun, calls: 0, costedCalls: 0, totalCostUsd: 0, costSum: 0 };
      groups.set(id, group);
    }
    group.calls += 1;
    if (isCost(costUsd)) {
      group.costedCalls += 1;
      group.totalCostUsd += costUsd;
      group.costSum += costUsd;
    }
    if (typeof model === 'string' && model) pairs.add(`${model} / ${typeof effort === 'string' && effort ? effort : 'unknown'}`);
  };

  /** Calls annualize over their source's first-to-last time, never below a day. */
  const sourceWindowDays = (times) => {
    // Rows without a parseable time sit at `now`, so a source with none spans no time.
    let firstAt = times.length ? times[0] : now;
    let lastAt = firstAt;
    for (const time of times) {
      if (time < firstAt) firstAt = time;
      if (time > lastAt) lastAt = time;
    }
    return Math.max(1, (lastAt - firstAt) / DAY_MS);
  };

  for (const row of Array.isArray(usageRows) ? usageRows : []) {
    if (!isObject(row)) continue;
    rememberTime(usageTimes, row.at);
    const task = typeof row.task === 'string' && row.task ? row.task : null;
    const stage = typeof row.stage === 'string' && row.stage ? row.stage : null;
    if (!task && !stage) continue;
    observe(stage ? `${task || 'unknown'}/${stage}` : task, false, row.costUsd, row.model, row.effort);
  }
  for (const row of Array.isArray(runRows) ? runRows : []) {
    if (!isObject(row)) continue;
    if (typeof row.stage !== 'string' || !row.stage) continue;
    // Uncalls still say when the stage was exercised, so they widen the window.
    rememberTime(runTimes, row.at);
    const costed = isCost(row.costUsd);
    if (row.event !== 'response' && !costed) continue;
    observe(`stage:${row.stage}`, true, row.costUsd, row.model, row.effort);
  }

  const usageWindowDays = sourceWindowDays(usageTimes);
  const runWindowDays = sourceWindowDays(runTimes);
  const calls = [...groups.values()].map((group) => {
    if (!group.isRun) {
      return {
        id: group.id,
        calls: group.calls,
        totalCostUsd: round(group.totalCostUsd, 4),
        windowDays: round(usageWindowDays, 3),
        annualCostUsd: round((group.totalCostUsd / usageWindowDays) * 365, 2),
      };
    }
    // Stage calls recorded before costs existed: extrapolate the mean recorded
    // cost over every call rather than the few costed days.
    const meanCostUsd = group.costedCalls ? group.costSum / group.costedCalls : null;
    const annualCostUsd = meanCostUsd === null ? 0 : (meanCostUsd * group.calls / runWindowDays) * 365;
    return {
      id: group.id,
      calls: group.calls,
      totalCostUsd: round(group.totalCostUsd, 4),
      windowDays: round(runWindowDays, 3),
      annualCostUsd: round(annualCostUsd, 2),
      costedCalls: group.costedCalls,
      ...(group.costedCalls < group.calls ? { estimated: true } : {}),
    };
  }).sort((a, b) => b.annualCostUsd - a.annualCostUsd || a.id.localeCompare(b.id));

  return { calls, models: [...pairs].sort() };
}

/** Parses JSONL text, dropping blank and malformed lines. */
export function parseJsonl(text, accept = () => true) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (isObject(row) && accept(row)) rows.push(row);
  }
  return rows;
}

function readUsageRows(file) {
  try { return parseJsonl(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

/** Every run-log row of the directory, recursively, that carries a stage. */
function readRunRows(dir) {
  const rows = [];
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && depth < MAX_RUN_LOG_DEPTH) walk(entryPath, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let text;
        try { text = fs.readFileSync(entryPath, 'utf8'); } catch { continue; }
        rows.push(...parseJsonl(text, row => typeof row.stage === 'string' && row.stage));
      }
    }
  };
  walk(dir, 0);
  return rows;
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const isEntryPoint = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isEntryPoint) {
  const userData = argument('--user-data');
  const runsDir = argument('--runs-dir');
  if (!userData) {
    process.stderr.write('usage: node scripts/ai-spend-report.mjs --user-data <dir> [--runs-dir <canvas>/.local-ai/claude-runs]\n');
    process.exitCode = 1;
  } else {
    const summary = summarizeAiSpend({
      usageRows: readUsageRows(path.join(userData, AI_USAGE_FILE)),
      runRows: runsDir ? readRunRows(runsDir) : [],
    });
    const lines = ['AI spend per call, annualized'];
    for (const call of summary.calls) {
      const estimated = call.estimated ? ` (estimated from ${call.costedCalls} costed calls)` : '';
      lines.push(`${call.id}: calls ${call.calls}, total $${call.totalCostUsd.toFixed(4)}, `
        + `window ${call.windowDays.toFixed(1)}d, annual $${call.annualCostUsd.toFixed(2)}${estimated}`);
    }
    if (!summary.calls.length) lines.push('no recorded calls');
    if (summary.models.length) {
      lines.push('model / effort pairs seen:');
      for (const pair of summary.models) lines.push(`- ${pair}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}
