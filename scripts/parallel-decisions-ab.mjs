#!/usr/bin/env node
// Measures Parallel's Decisions API on the app's job-preference checks: every strict
// company/perk check that two Claude research arms already answered is asked again as one
// choice question per company (up to 100), and the answers are compared with both arms.
// The research rows are private, so the run is written outside the repository with
// owner-only permissions, journaled like the other measurement scripts, and the console
// prints counts only (company names stay inside the output files).
//
//   node scripts/parallel-decisions-ab.mjs --results <results.jsonl> --out <dir> \
//     [--concurrency 4] [--min-prob 0.6] [--limit <n companies>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertDurableOutDir, createRunJournal, takeEphemeralFlag } from './ai-test-journal.mjs';
import { assertOutsideRepo } from './ai-task-replay.mjs';

export const DECISIONS_URL = 'https://api.parallel.ai/v1/decisions';
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MIN_PROB = 0.6;
export const RETRY_DELAY_MS = 2000;
export const OUTCOMES = Object.freeze(['confirmed', 'conflicts', 'unverified']);
/** The sources compared per check: Decisions, the native Claude arm and the Tavily arm. */
export const SOURCES = Object.freeze(['decisions', 'native', 'parallelClaude']);
const MAX_CITATIONS = 5;
// The three options of every choice question, exactly as the verified Decisions API takes them.
export const CRITERIA = Object.freeze({
  excluded: 'The employer is the kind of organization the rule excludes.',
  not_excluded: 'The employer is clearly not the kind of organization the rule excludes.',
  unknown: 'The evidence does not establish whether the rule excludes the employer.',
});
const CHOICE_OUTCOMES = Object.freeze({ not_excluded: 'confirmed', excluded: 'conflicts', unknown: 'unverified' });
const PROBABILITY_KEYS = Object.freeze(['excluded', 'not_excluded', 'unknown']);

export function cliOptions(argv) {
  const { values } = parseNodeArgs({ args: argv, options: {
    results: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
    'min-prob': { type: 'string', default: String(DEFAULT_MIN_PROB) }, limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } });
  if (!values.results) throw new Error('--results <path> is required.');
  if (!values.out) throw new Error('--out <dir> is required.');
  const int = (name, raw, min) => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < min) throw new Error(`--${name} must be an integer >= ${min}.`);
    return number;
  };
  const minProb = Number(values['min-prob']);
  if (!Number.isFinite(minProb) || minProb < 0 || minProb > 1) throw new Error('--min-prob must be a number between 0 and 1.');
  return {
    results: path.resolve(values.results), out: path.resolve(values.out), concurrency: int('concurrency', values.concurrency, 1),
    minProb, limit: values.limit === undefined ? null : int('limit', values.limit, 1), dryRun: values['dry-run'] === true,
  };
}

// ---- Input -----------------------------------------------------------------

export const checkKey = (company, title, criterion) => `${company}\u0000${title}\u0000${criterion}`;

/**
 * Rows from the results JSONL, keeping the LAST line seen for each
 * (arm, company, title, criterion) because the file may hold two passes. The
 * 'merged' arm is not an answer and is ignored, as is any other kind of line.
 */
export function loadResults(text) {
  const latest = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || row.kind !== 'match') continue;
    if (row.arm !== 'native' && row.arm !== 'tavily') continue;
    const company = typeof row.company === 'string' ? row.company.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const criterion = typeof row.criterion === 'string' ? row.criterion.trim() : '';
    if (!company || !title || !criterion || !OUTCOMES.includes(row.outcome)) continue;
    const sourceUrls = Array.isArray(row.sourceUrls) ? row.sourceUrls.filter(url => typeof url === 'string') : [];
    latest.set(`${row.arm}\u0000${checkKey(company, title, criterion)}`, { arm: row.arm, company, title, criterion, outcome: row.outcome, sourceUrls });
  }
  return [...latest.values()];
}

const byCheck = (a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title) || a.criterion.localeCompare(b.criterion);

/** One check per (company, title, criterion) carrying the outcome each Claude arm gave it. */
export function buildChecks(rows) {
  const checks = new Map();
  for (const row of rows) {
    const key = checkKey(row.company, row.title, row.criterion);
    const check = checks.get(key) ?? { company: row.company, title: row.title, criterion: row.criterion, native: null, parallelClaude: null };
    if (row.arm === 'native') check.native = row.outcome;
    else check.parallelClaude = row.outcome;
    checks.set(key, check);
  }
  return [...checks.values()].sort(byCheck);
}

// ---- Requests --------------------------------------------------------------

export function questionInstructions(company, criterion) {
  return `A job seeker filters employers with this rule: "${criterion}". Based on what ${company} is and does as an employer, `
    + 'does this rule exclude it? Select unknown when the evidence does not establish it.';
}

export function buildQuestion(company, criterion) {
  return { type: 'choice', instructions: questionInstructions(company, criterion), criteria: { ...CRITERIA } };
}

/**
 * One request per distinct company, one choice question per distinct criterion for that
 * company (q1, q2, ...), so the questions share a single set of retrieved evidence.
 * `limit` keeps the first companies in name order. Every check keeps its place in `order`,
 * so a criterion asked once answers every title of the company that carries it.
 */
export function planRequests(checks, { limit = null } = {}) {
  const companies = new Map();
  for (const check of checks) {
    const entry = companies.get(check.company) ?? { company: check.company, title: check.title, criteria: new Map() };
    const item = entry.criteria.get(check.criterion) ?? { criterion: check.criterion, checks: [] };
    item.checks.push(check);
    entry.criteria.set(check.criterion, item);
    companies.set(check.company, entry);
  }
  const names = [...companies.keys()].sort((a, b) => a.localeCompare(b));
  const picked = Number.isInteger(limit) ? names.slice(0, limit) : names;
  return picked.map((name) => {
    const entry = companies.get(name);
    const criteria = [...entry.criteria.values()].sort((a, b) => a.criterion.localeCompare(b.criterion));
    const questions = {};
    const order = criteria.map((item, index) => {
      const questionName = `q${index + 1}`;
      questions[questionName] = buildQuestion(entry.company, item.criterion);
      return { name: questionName, criterion: item.criterion, checks: item.checks };
    });
    return {
      company: entry.company,
      body: { state: { company: entry.company, job_title: entry.title }, questions },
      order,
      checks: order.flatMap(item => item.checks),
    };
  });
}

// ---- Answers ---------------------------------------------------------------

export function decisionProbabilities(value) {
  const probabilities = {};
  for (const key of PROBABILITY_KEYS) probabilities[key] = Number.isFinite(value?.[key]) ? value[key] : null;
  return probabilities;
}

/**
 * not_excluded -> confirmed, excluded -> conflicts, unknown -> unverified; a chosen option
 * whose probability is below the floor (or missing) is unverified, and an unreadable answer
 * is an error for that check only.
 */
export function decisionForAnswer(answer, minProb = DEFAULT_MIN_PROB) {
  const choice = typeof answer?.choice === 'string' ? answer.choice : null;
  const probabilities = decisionProbabilities(answer?.probabilities);
  const confidence = typeof answer?.confidence === 'number' || typeof answer?.confidence === 'string' ? answer.confidence : null;
  const mapped = choice ? CHOICE_OUTCOMES[choice] : undefined;
  if (!mapped) return { outcome: 'error', choice, probabilities, confidence, reason: 'no readable choice in the answer' };
  const belowFloor = mapped !== 'unverified' && !(probabilities[choice] >= minProb);
  return { outcome: belowFloor ? 'unverified' : mapped, choice, probabilities, confidence, reason: null };
}

/** The https citation urls of a reply, deduplicated and capped at five. */
export function citationUrls(data) {
  const urls = [];
  for (const citation of Array.isArray(data?.citations) ? data.citations : []) {
    const url = typeof citation?.url === 'string' ? citation.url.trim() : '';
    if (/^https?:\/\//iu.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_CITATIONS);
}

/** One output row per check of the plan; a failed request marks all of them 'error'. */
export function decisionRows(plan, call, minProb = DEFAULT_MIN_PROB) {
  const urls = call.ok ? citationUrls(call.data) : [];
  const answers = call.ok ? call.data?.answers : null;
  return plan.order.flatMap((item) => {
    const decision = call.ok
      ? decisionForAnswer(answers?.[item.name], minProb)
      : { outcome: 'error', choice: null, probabilities: decisionProbabilities(null), confidence: null, reason: call.error || 'request failed' };
    return item.checks.map(check => ({
      company: check.company, title: check.title, criterion: check.criterion,
      decisions: decision.outcome, choice: decision.choice, probabilities: decision.probabilities,
      confidence: decision.confidence, citations: [...urls],
      native: check.native, parallelClaude: check.parallelClaude, error: decision.reason,
    }));
  });
}

// ---- Network ---------------------------------------------------------------

const defaultSleep = ms => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * POST one Decisions request. A 429 or 5xx reply is retried once after 2 s; every other
 * failure (network, bad JSON, 4xx) is returned as { ok: false } and never throws, so the
 * caller can mark the request's checks and carry on.
 */
export async function callDecisions({ apiKey, body, fetchImpl = fetch, sleep = defaultSleep, url = DECISIONS_URL }) {
  const request = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify(body) };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let status = 0;
    let data = null;
    let error = '';
    try {
      const response = await fetchImpl(url, request);
      status = Number(response?.status) || 0;
      const text = await response.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (status >= 200 && status < 300 && data && typeof data === 'object') return { ok: true, status, data, attempts: attempt };
      error = status >= 200 && status < 300 ? 'reply was not JSON' : `HTTP ${status}`;
    } catch (thrown) {
      error = thrown?.message || String(thrown);
    }
    const retryable = status === 429 || status >= 500;
    if (retryable && attempt === 1) { await sleep(RETRY_DELAY_MS); continue; }
    return { ok: false, status, error, attempts: attempt };
  }
  return { ok: false, status: 0, error: 'request did not finish', attempts: 2 };
}

/**
 * Run the plan with bounded concurrency. Every finished request is recorded (ok or not)
 * and handed to onRequest, so a failure never stops the run.
 */
export async function runDecisionsPass({
  plans, apiKey, fetchImpl = fetch, concurrency = DEFAULT_CONCURRENCY, minProb = DEFAULT_MIN_PROB, sleep = defaultSleep, onRequest = null,
}) {
  const queue = [...plans];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const plan = queue.shift();
      const started = Date.now();
      const call = await callDecisions({ apiKey, body: plan.body, fetchImpl, sleep });
      const latencyMs = Date.now() - started;
      const result = { company: plan.company, call, rows: decisionRows(plan, call, minProb), latencyMs };
      results.push(result);
      if (onRequest) await onRequest(result);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// ---- Summary ---------------------------------------------------------------

export function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : Math.round((list[middle - 1] + list[middle]) / 2);
}

const blankTotals = () => ({ confirmed: 0, conflicts: 0, unverified: 0, error: 0 });
const answered = outcome => OUTCOMES.includes(outcome);
const brief = row => ({
  company: row.company, title: row.title, criterion: row.criterion,
  decisions: row.decisions, native: row.native, parallelClaude: row.parallelClaude,
});

/**
 * Totals per source over the checks all three answered, pairwise agreement over the same
 * checks, and the conflict lists both ways. `requests` carries { ok, latencyMs } per call.
 */
export function summarizeChecks(rows, { requests = [], minProb = DEFAULT_MIN_PROB } = {}) {
  const totals = Object.fromEntries(SOURCES.map(source => [source, blankTotals()]));
  for (const row of rows) {
    for (const source of SOURCES) {
      const outcome = row[source];
      if (outcome && totals[source][outcome] !== undefined) totals[source][outcome] += 1;
    }
  }
  const compared = rows.filter(row => SOURCES.every(source => answered(row[source])));
  const agree = (left, right) => compared.filter(row => row[left] === row[right]).length;
  return {
    checks: rows.length,
    companies: new Set(rows.map(row => row.company)).size,
    compared: compared.length,
    minProb,
    totals,
    agreement: {
      decisionsVsNative: agree('decisions', 'native'),
      decisionsVsParallelClaude: agree('decisions', 'parallelClaude'),
      nativeVsParallelClaude: agree('native', 'parallelClaude'),
    },
    decisionsConflicts: rows.filter(row => row.decisions === 'conflicts').map(brief),
    claudeConflicts: rows.filter(row => row.native === 'conflicts' || row.parallelClaude === 'conflicts').map(brief),
    requests: {
      made: requests.length,
      failed: requests.filter(request => request.ok === false).length,
      medianLatencyMs: median(requests.map(request => request.latencyMs)),
    },
  };
}

/** The console report: counts and summary numbers only, never a company name. */
export function consoleLines(summary) {
  const line = source => `${source}: confirmed ${summary.totals[source].confirmed} · conflicts ${summary.totals[source].conflicts}`
    + ` · unverified ${summary.totals[source].unverified} · error ${summary.totals[source].error}`;
  return [
    `${summary.checks} checks · ${summary.companies} companies · ${summary.requests.made} requests (${summary.requests.failed} failed)`
      + ` · median ${summary.requests.medianLatencyMs ?? 'n/a'} ms`,
    line('decisions'), line('native'), line('parallelClaude'),
    `compared ${summary.compared} · agreement decisions/native ${summary.agreement.decisionsVsNative}`
      + ` · decisions/parallelClaude ${summary.agreement.decisionsVsParallelClaude} · native/parallelClaude ${summary.agreement.nativeVsParallelClaude}`,
    `decisions conflicts ${summary.decisionsConflicts.length} · checks either Claude arm calls conflicts ${summary.claudeConflicts.length}`,
  ];
}

// ---- Run -------------------------------------------------------------------

const KEYCHAIN_SERVICE = 'infinite-canvas-parallel-api-key';

function prepareOut(outDir) {
  assertOutsideRepo(outDir);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);
  return outDir;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main(argv, deps = {}) {
  const opts = cliOptions(argv);
  let text = '';
  try { text = fs.readFileSync(opts.results, 'utf8'); } catch (error) {
    throw new Error(`--results ${opts.results} could not be read (${error?.code || error?.message}).`);
  }
  const checks = buildChecks(loadResults(text));
  const plans = planRequests(checks, { limit: opts.limit });
  const plannedChecks = plans.reduce((total, plan) => total + plan.checks.length, 0);
  if (opts.dryRun) {
    const companiesInFile = new Set(checks.map(check => check.company)).size;
    console.log(`dry run: ${companiesInFile} companies / ${checks.length} checks in the file; ${plans.length} companies / ${plannedChecks} checks`
      + ' would be sent as one request each; no network call');
    return 0;
  }
  if (deps.requireDurable) assertDurableOutDir(opts.out, { allowEphemeral: deps.allowEphemeral === true });
  const outDir = prepareOut(opts.out);
  const journal = deps.journalFactory ? deps.journalFactory({
    tool: 'parallel-decisions-ab', task: 'job-preference-checks', label: `min-prob ${opts.minProb}`, outDir,
    command: deps.command ?? '', facts: { Companies: plans.length, Checks: plannedChecks },
  }) : null;
  try {
    const readKey = deps.readKey ?? (async () => (await import('../electron/ipc/parallelSearch.js')).readParallelKey());
    const key = await readKey();
    if (!key) {
      throw new Error(`No Parallel API key in the Keychain item ${KEYCHAIN_SERVICE}. `
        + `Run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a parallel -w`);
    }
    const results = await runDecisionsPass({
      plans, apiKey: key, fetchImpl: deps.fetchImpl, concurrency: opts.concurrency, minProb: opts.minProb, sleep: deps.sleep,
      onRequest: (() => {
        let done = 0;
        let failed = 0;
        return (result) => {
          done += 1;
          if (!result.call.ok) failed += 1;
          journal?.update({ facts: { Done: done, Failed: failed } }, { force: !result.call.ok });
        };
      })(),
    });
    const rows = results.flatMap(result => result.rows).sort((a, b) => byCheck(a, b));
    writeJsonl(path.join(outDir, 'decisions.jsonl'), rows);
    const summary = summarizeChecks(rows, {
      requests: results.map(result => ({ ok: result.call.ok, latencyMs: result.latencyMs })), minProb: opts.minProb,
    });
    writeJson(path.join(outDir, 'summary.json'), summary);
    for (const line of consoleLines(summary)) console.log(line);
    console.log(`details: ${outDir}`);
    journal?.update({ facts: { Requests: summary.requests.made, Failed: summary.requests.failed, Compared: summary.compared } }, { force: true });
    journal?.finish('finished');
    return summary.requests.made > 0 && summary.requests.failed === summary.requests.made ? 1 : 0;
  } catch (error) {
    journal?.finish(`failed: ${String(error?.message || error).slice(0, 200)}`);
    throw error;
  }
}

export { main };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cliArgs, allowEphemeral] = takeEphemeralFlag(process.argv.slice(2));
  main(cliArgs, {
    requireDurable: true, allowEphemeral, journalFactory: allowEphemeral ? null : createRunJournal,
    command: `node scripts/parallel-decisions-ab.mjs ${cliArgs.join(' ')}`,
  }).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`parallel-decisions-ab: ${String(error?.message || error).replace(/\s+/gu, ' ').trim()}`);
    process.exitCode = 1;
  });
}
