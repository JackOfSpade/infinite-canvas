#!/usr/bin/env node
// Measures the Skip-time employer-posting read on real unread listings: how many
// listings a platform refused to open can be read from the employer's own posting
// by the production finder, and what that costs in requests and time.
//
//   node --import ./scripts/test-stubs/register.mjs scripts/employer-posting-read-measure.mjs \
//     --listings <unread listings json> --out <private dir> [--n 6] [--seed 1] [--source google]
//
// --listings is an array of { title, company, url } as saved under a search's
// sourceQueryProgress.<platform>.unreadListings. Job details are written only to
// the private --out directory. Record the totals afterwards with
// `node scripts/ai-test-journal.mjs record --tool employer-posting-read-measure ...`.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { mulberry32, sample } from './lib/seeded-random.mjs';

const { values } = parseArgs({ options: {
  listings: { type: 'string' }, out: { type: 'string' }, n: { type: 'string', default: '6' },
  seed: { type: 'string', default: '1' }, source: { type: 'string', default: 'google' },
} });
if (!values.listings || !values.out) throw new Error('--listings and --out are required.');
const out = path.resolve(values.out);
if (/^(\/private)?\/tmp\//u.test(out)) throw new Error('--out must be a durable private directory, not a temp path.');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });

const { readListingsFromEmployerPostings } = await import('../electron/ipc/jobs/employerPostingRead.js');
const { createOfficialPostingStore } = await import('../electron/ipc/officialPostingStore.js');

const all = JSON.parse(fs.readFileSync(values.listings, 'utf8')).filter(item => item?.title && item?.company);
const picked = sample(all, Math.min(Number(values.n), all.length), mulberry32(Number(values.seed)));
// The same shape a refused card has in the app, minus its location (not saved with the unread list).
const rows = picked.map(item => ({
  source: values.source, title: item.title, company: item.company, url: item.url || '',
  snippet: '', descriptionDeferredReason: 'description-rate-limited',
}));
const store = createOfficialPostingStore(path.join(out, 'official-postings'));
const telemetry = {};
const started = Date.now();
const progressPath = path.join(out, 'progress.jsonl');
fs.writeFileSync(progressPath, '', { mode: 0o600 });
// Outside the app there is no task worker, so each request is run the way the
// worker runs it: the app's prompt preparation, the task's own model, effort and
// search tools, and the app's validator (the helpers ai-task-replay.mjs uses).
const ipc = rel => import(new URL(`../electron/ipc/${rel}`, import.meta.url).href);
const app = Object.assign({}, ...await Promise.all(['nonApiAi.js', 'claudeTaskWorker.js', 'offloadTextCall.js', 'claudeTaskProfiles.js',
  'claudeApplicationSdkStage.js', 'claudeApplicationRunner.js', 'parallelSearch.js'].map(ipc)));
const { appExecute, appMaterialize, appValidate, createLimiter } = await import('./ai-task-replay.mjs');
const materialize = appMaterialize(app);
const validate = appValidate(app);
const limit = createLimiter(3);
const executors = new Map();
const callsPath = path.join(out, 'calls.jsonl');
fs.writeFileSync(callsPath, '', { mode: 0o600 });
const totals = { calls: 0, failed: 0, costUsd: 0, byTask: {} };
const caller = (prompt, options = {}) => limit(async () => {
  const task = options.task;
  if (!executors.has(task)) executors.set(task, appExecute(app, task, options.signal));
  const call = { ...materialize(prompt, options), task };
  const began = Date.now();
  const record = { task, at: began - started };
  totals.calls += 1;
  totals.byTask[task] = (totals.byTask[task] || 0) + 1;
  try {
    const reply = await executors.get(task)({ config: { id: 'claude', kind: 'claude' }, call });
    record.ms = Date.now() - began; record.costUsd = reply?.costUsd ?? null; record.toolCalls = reply?.toolCalls || {};
    if (Number.isFinite(reply?.costUsd)) totals.costUsd += reply.costUsd;
    const value = validate(call, typeof reply?.text === 'string' ? reply.text : '');
    record.valid = true;
    return value;
  } catch (error) {
    record.ms ??= Date.now() - began; record.valid = false; record.code = error?.code || error?.name || 'error';
    totals.failed += 1;
    throw error;
  } finally {
    fs.appendFileSync(callsPath, `${JSON.stringify(record)}\n`);
  }
});
const wrapped = async (jobs, options) => {
  const { resolveOfficialPostings } = await import('../electron/ipc/officialPostingService.js');
  return resolveOfficialPostings(jobs, { ...options, telemetry, callRaw: caller, callMatch: caller });
};
const result = await readListingsFromEmployerPostings(rows, {
  store, resolve: wrapped,
  onProgress: value => fs.appendFileSync(progressPath, `${JSON.stringify({ at: Date.now() - started, ...value })}\n`),
});
const summary = {
  pool: all.length, sampled: rows.length, seed: Number(values.seed),
  attempted: result.attempted, read: result.read.length, unread: result.unread.length,
  outcomes: result.outcomes, minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
  aiCalls: totals.calls, aiCallsFailed: totals.failed, aiCallsByTask: totals.byTask, costUsd: Number(totals.costUsd.toFixed(2)),
  handoffs: telemetry.officialPosting?.handoffs ?? null,
  handoffMinutes: telemetry.officialPosting ? Number((telemetry.officialPosting.handoffMs / 60_000).toFixed(1)) : null,
};
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
  summary, telemetry: telemetry.officialPosting || null,
  read: result.read.map(({ row }) => ({ title: row.title, company: row.company, postingUrl: row.officialPosting?.sourceUrl || '',
    level: row.officialPosting?.level, chars: row.snippet.length, opening: row.snippet.slice(0, 300) })),
  unread: result.unread.map(row => ({ title: row.title, company: row.company })),
}, null, 1), { mode: 0o600 });
console.log(JSON.stringify(summary));
