import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MIN_PROB, buildChecks, buildQuestion, callDecisions, cliOptions, consoleLines, decisionForAnswer,
  decisionRows, loadResults, main, planRequests, runDecisionsPass, summarizeChecks,
} from './parallel-decisions-ab.mjs';

const RULE_A = 'Exclude agencies, consultancies, and outsourcing firms.';
const RULE_B = 'Exclude unpaid internships.';

const match = (arm, company, title, criterion, outcome) => JSON.stringify({
  kind: 'match', arm, company, title, criterion, outcome, evidence: 'evidence', sourceUrls: ['https://example.com/a'],
});
const jsonl = rows => `${rows.join('\n')}\n`;
const answer = (choice, probability = 0.9) => ({
  type: 'choice', choice, confidence: 'high', probabilities: {
    excluded: choice === 'excluded' ? probability : 0.05,
    not_excluded: choice === 'not_excluded' ? probability : 0.05,
    unknown: choice === 'unknown' ? probability : 0.05,
  },
});
const check = (company, title, criterion, native, parallelClaude) => ({ company, title, criterion, native, parallelClaude });
const row = (company, decisions, native, parallelClaude) => ({
  company, title: 'Engineer', criterion: RULE_A, decisions, native, parallelClaude,
  choice: null, probabilities: {}, confidence: null, citations: [], error: null,
});
const fakeResponse = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('loadResults keeps the last line per arm and check, and ignores merged', () => {
  const rows = loadResults(jsonl([
    match('native', 'Acme', 'Engineer', RULE_A, 'unverified'),
    match('native', 'Acme', 'Engineer', RULE_A, 'confirmed'),
    match('merged', 'Acme', 'Engineer', RULE_A, 'conflicts'),
    match('tavily', 'Acme', 'Engineer', RULE_A, 'conflicts'),
    JSON.stringify({ kind: 'summary' }),
    'not json',
  ]));
  assert.deepEqual(rows.map(entry => [entry.arm, entry.outcome]), [['native', 'confirmed'], ['tavily', 'conflicts']]);
  assert.deepEqual(rows[0].sourceUrls, ['https://example.com/a']);
});

test('buildChecks puts both Claude arms on one check', () => {
  const checks = buildChecks(loadResults(jsonl([
    match('native', 'Acme', 'Engineer', RULE_A, 'confirmed'),
    match('tavily', 'Acme', 'Engineer', RULE_A, 'conflicts'),
    match('native', 'Beta', 'Designer', RULE_A, 'unverified'),
  ])));
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0], check('Acme', 'Engineer', RULE_A, 'confirmed', 'conflicts'));
  assert.deepEqual(checks[1], check('Beta', 'Designer', RULE_A, 'unverified', null));
});

test('a question carries the specified body shape and wording', () => {
  assert.deepEqual(buildQuestion('Acme', RULE_A), {
    type: 'choice',
    instructions: `A job seeker filters employers with this rule: "${RULE_A}". Based on what Acme is and does as an employer, `
      + 'does this rule exclude it? Select unknown when the evidence does not establish it.',
    criteria: {
      excluded: 'The employer is the kind of organization the rule excludes.',
      not_excluded: 'The employer is clearly not the kind of organization the rule excludes.',
      unknown: 'The evidence does not establish whether the rule excludes the employer.',
    },
  });
});

test('planRequests sends one request per company with one question per criterion', () => {
  const checks = [
    check('Acme', 'Engineer', RULE_A, 'confirmed', 'confirmed'),
    check('Acme', 'Engineer', RULE_B, 'confirmed', 'confirmed'),
    check('Acme', 'Manager', RULE_A, 'unverified', 'unverified'),
    check('Beta', 'Designer', RULE_A, 'confirmed', 'confirmed'),
  ];
  const plans = planRequests(checks);
  assert.deepEqual(plans.map(plan => plan.company), ['Acme', 'Beta']);
  assert.deepEqual(Object.keys(plans[0].body.questions), ['q1', 'q2']);
  assert.deepEqual(plans[0].body.state, { company: 'Acme', job_title: 'Engineer' });
  assert.deepEqual(plans[0].order.map(item => [item.name, item.criterion]), [['q1', RULE_A], ['q2', RULE_B]]);
  assert.equal(plans[0].order[0].checks.length, 2);
  assert.equal(plans[0].checks.length, 3);
  assert.deepEqual(planRequests(checks, { limit: 1 }).map(plan => plan.company), ['Acme']);
});

test('decisionForAnswer maps the choice and enforces the probability floor', () => {
  assert.equal(decisionForAnswer(answer('not_excluded', 0.8)).outcome, 'confirmed');
  assert.equal(decisionForAnswer(answer('excluded', 0.8)).outcome, 'conflicts');
  assert.equal(decisionForAnswer(answer('unknown', 0.8)).outcome, 'unverified');
  assert.equal(decisionForAnswer(answer('not_excluded', 0.59)).outcome, 'unverified');
  assert.equal(decisionForAnswer(answer('excluded', 0.59)).outcome, 'unverified');
  assert.equal(decisionForAnswer(answer('not_excluded', DEFAULT_MIN_PROB)).outcome, 'confirmed');
  assert.equal(decisionForAnswer(answer('excluded', 0.2), 0.1).outcome, 'conflicts');
  const unreadable = decisionForAnswer(undefined);
  assert.equal(unreadable.outcome, 'error');
  assert.equal(unreadable.choice, null);
});

test('decisionRows maps every check of the plan and caps citations at five', () => {
  const [plan] = planRequests([
    check('Acme', 'Engineer', RULE_A, 'confirmed', 'unverified'),
    check('Acme', 'Manager', RULE_A, 'unverified', 'confirmed'),
  ]);
  const data = {
    answers: { q1: answer('excluded', 0.9) },
    citations: Array.from({ length: 7 }, (_, index) => ({ url: `https://a.example/${index}` })),
  };
  const rows = decisionRows(plan, { ok: true, data });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(entry => entry.decisions), ['conflicts', 'conflicts']);
  assert.equal(rows[0].citations.length, 5);
  assert.equal(rows[0].native, 'confirmed');
  assert.equal(rows[1].parallelClaude, 'confirmed');
  const failed = decisionRows(plan, { ok: false, error: 'HTTP 500' });
  assert.deepEqual(failed.map(entry => entry.decisions), ['error', 'error']);
  assert.equal(failed[0].error, 'HTTP 500');
  assert.deepEqual(failed[0].citations, []);
});

test('summarizeChecks totals and compares only the checks all three answered', () => {
  const summary = summarizeChecks([
    row('Acme', 'conflicts', 'confirmed', 'unverified'),
    row('Beta', 'confirmed', 'conflicts', 'conflicts'),
    row('Gamma', 'error', 'confirmed', 'confirmed'),
    row('Delta', 'unverified', 'unverified', 'unverified'),
  ], { requests: [{ ok: true, latencyMs: 10 }, { ok: false, latencyMs: 30 }, { ok: true, latencyMs: 20 }] });
  assert.equal(summary.checks, 4);
  assert.equal(summary.compared, 3);
  assert.deepEqual(summary.totals.decisions, { confirmed: 1, conflicts: 1, unverified: 1, error: 1 });
  assert.deepEqual(summary.totals.native, { confirmed: 2, conflicts: 1, unverified: 1, error: 0 });
  assert.deepEqual(summary.totals.parallelClaude, { confirmed: 1, conflicts: 1, unverified: 2, error: 0 });
  assert.deepEqual(summary.agreement, { decisionsVsNative: 1, decisionsVsParallelClaude: 1, nativeVsParallelClaude: 2 });
  assert.deepEqual(summary.decisionsConflicts.map(entry => entry.company), ['Acme']);
  assert.deepEqual(summary.claudeConflicts.map(entry => entry.company), ['Beta']);
  assert.equal(summary.claudeConflicts[0].decisions, 'confirmed');
  assert.deepEqual(summary.requests, { made: 3, failed: 1, medianLatencyMs: 20 });
});

test('consoleLines prints counts only, never a company name', () => {
  const summary = summarizeChecks([row('Acme', 'conflicts', 'confirmed', 'unverified')],
    { requests: [{ ok: true, latencyMs: 10 }, { ok: true, latencyMs: 20 }, { ok: true, latencyMs: 30 }] });
  const lines = consoleLines(summary).join('\n');
  assert.match(lines, /median 20 ms/u);
  assert.match(lines, /decisions conflicts 1/u);
  assert.equal(lines.includes('Acme'), false);
  assert.equal(lines.includes(RULE_A), false);
});

test('callDecisions posts the request with the key header and parses the reply', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return fakeResponse(200, { answers: {} }); };
  const body = { state: { company: 'Acme', job_title: 'Engineer' }, questions: {} };
  const result = await callDecisions({
    apiKey: 'test-key-not-real', body, fetchImpl, sleep: async () => { throw new Error('no retry expected'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.parallel.ai/v1/decisions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key-not-real');
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test('callDecisions retries a 429 once after two seconds', async () => {
  const statuses = [429, 200];
  const sleeps = [];
  const fetchImpl = async () => fakeResponse(statuses.shift(), { answers: { q1: answer('unknown') } });
  const result = await callDecisions({ apiKey: 'k', body: {}, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('callDecisions gives up after a second 5xx', async () => {
  const sleeps = [];
  let attempts = 0;
  const result = await callDecisions({
    apiKey: 'k', body: {}, sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => { attempts += 1; return fakeResponse(503, 'unavailable'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('callDecisions does not retry a 4xx or a bad JSON reply', async () => {
  let attempts = 0;
  const noRetry = async () => { throw new Error('no retry expected'); };
  const rejected = await callDecisions({
    apiKey: 'k', body: {}, sleep: noRetry,
    fetchImpl: async () => { attempts += 1; return fakeResponse(400, 'bad request'); },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'HTTP 400');
  assert.equal(attempts, 1);
  const notJson = await callDecisions({ apiKey: 'k', body: {}, sleep: noRetry, fetchImpl: async () => fakeResponse(200, 'not json') });
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error, 'reply was not JSON');
});

test('callDecisions records a network failure without retrying', async () => {
  let attempts = 0;
  const result = await callDecisions({
    apiKey: 'k', body: {}, sleep: async () => { throw new Error('no retry expected'); },
    fetchImpl: async () => { attempts += 1; throw new Error('socket closed'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1);
  assert.equal(result.error, 'socket closed');
});

test('runDecisionsPass marks a failed request and keeps going', async () => {
  const plans = planRequests([
    check('Acme', 'Engineer', RULE_A, 'confirmed', 'confirmed'),
    check('Beta', 'Designer', RULE_A, 'confirmed', 'confirmed'),
  ]);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.state.company === 'Beta') return fakeResponse(500, 'down');
    return fakeResponse(200, { answers: { q1: answer('not_excluded', 0.9) } });
  };
  const seen = [];
  const results = await runDecisionsPass({
    plans, apiKey: 'k', fetchImpl, sleep: async () => {}, concurrency: 2, onRequest: result => { seen.push(result.company); },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(seen.sort(), ['Acme', 'Beta']);
  const beta = results.find(result => result.company === 'Beta');
  assert.equal(beta.call.ok, false);
  assert.deepEqual(beta.rows.map(entry => entry.decisions), ['error']);
  const acme = results.find(result => result.company === 'Acme');
  assert.deepEqual(acme.rows.map(entry => entry.decisions), ['confirmed']);
});

test('cliOptions reads the flags, applies defaults and rejects bad values', () => {
  const defaults = cliOptions(['--results', 'results.jsonl', '--out', '/tmp/out']);
  assert.equal(defaults.concurrency, 4);
  assert.equal(defaults.minProb, 0.6);
  assert.equal(defaults.limit, null);
  assert.equal(defaults.dryRun, false);
  const custom = cliOptions(['--results', 'r.jsonl', '--out', '/tmp/out', '--concurrency', '2', '--min-prob', '0.75', '--limit', '5', '--dry-run']);
  assert.equal(custom.concurrency, 2);
  assert.equal(custom.minProb, 0.75);
  assert.equal(custom.limit, 5);
  assert.equal(custom.dryRun, true);
  assert.throws(() => cliOptions(['--out', '/tmp/out']), /--results <path> is required/u);
  assert.throws(() => cliOptions(['--results', 'r.jsonl']), /--out <dir> is required/u);
  assert.throws(() => cliOptions(['--results', 'r.jsonl', '--out', '/tmp/out', '--concurrency', '0']), /--concurrency must be an integer >= 1/u);
  assert.throws(() => cliOptions(['--results', 'r.jsonl', '--out', '/tmp/out', '--min-prob', '1.5']), /--min-prob must be a number between 0 and 1/u);
  assert.throws(() => cliOptions(['--results', 'r.jsonl', '--out', '/tmp/out', '--limit', '0']), /--limit must be an integer >= 1/u);
});

test('--dry-run counts without a network call or an out dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-decisions-dry-'));
  try {
    const results = path.join(dir, 'results.jsonl');
    fs.writeFileSync(results, jsonl([
      match('native', 'Acme', 'Engineer', RULE_A, 'confirmed'),
      match('tavily', 'Acme', 'Engineer', RULE_A, 'confirmed'),
      match('native', 'Beta', 'Designer', RULE_B, 'conflicts'),
      match('tavily', 'Beta', 'Designer', RULE_B, 'conflicts'),
      match('native', 'Beta', 'Manager', RULE_B, 'unverified'),
    ]));
    const out = path.join(dir, 'out');
    const logs = [];
    const original = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let code;
    try {
      code = await main(['--results', results, '--out', out, '--dry-run'], {
        requireDurable: false,
        readKey: async () => { throw new Error('the keychain must not be read in a dry run'); },
        fetchImpl: async () => { throw new Error('the network must not be used in a dry run'); },
      });
    } finally {
      console.log = original;
    }
    assert.equal(code, 0);
    assert.match(logs.join('\n'), /2 companies \/ 3 checks in the file; 2 companies \/ 3 checks/u);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run without a key stops with one line that carries no key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-decisions-nokey-'));
  try {
    const results = path.join(dir, 'results.jsonl');
    fs.writeFileSync(results, jsonl([
      match('native', 'Acme', 'Engineer', RULE_A, 'confirmed'),
      match('tavily', 'Acme', 'Engineer', RULE_A, 'confirmed'),
    ]));
    const finished = [];
    await assert.rejects(
      main(['--results', results, '--out', path.join(dir, 'out')], {
        requireDurable: false,
        readKey: async () => '',
        fetchImpl: async () => { throw new Error('the network must not be used without a key'); },
        journalFactory: () => ({ update: () => {}, finish: status => { finished.push(status); } }),
      }),
      error => /No Parallel API key in the Keychain item infinite-canvas-parallel-api-key/u.test(error.message),
    );
    assert.deepEqual(finished, ['failed: No Parallel API key in the Keychain item infinite-canvas-parallel-api-key. '
      + 'Run: security add-generic-password -s infinite-canvas-parallel-api-key -a parallel -w']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run writes decisions.jsonl and summary.json with owner-only modes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-decisions-run-'));
  try {
    const results = path.join(dir, 'results.jsonl');
    fs.writeFileSync(results, jsonl([
      match('native', 'Acme', 'Engineer', RULE_A, 'confirmed'),
      match('tavily', 'Acme', 'Engineer', RULE_A, 'unverified'),
      match('native', 'Beta', 'Designer', RULE_B, 'conflicts'),
      match('tavily', 'Beta', 'Designer', RULE_B, 'conflicts'),
    ]));
    const out = path.join(dir, 'out');
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.state.company === 'Acme') return fakeResponse(200, { answers: { q1: answer('not_excluded', 0.9) } });
      return fakeResponse(500, 'down');
    };
    const logs = [];
    const original = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let code;
    try {
      code = await main(['--results', results, '--out', out], {
        requireDurable: false, readKey: async () => 'test-key-not-real', fetchImpl, sleep: async () => {},
      });
    } finally {
      console.log = original;
    }
    assert.equal(code, 0);
    const decisions = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(decisions.map(entry => [entry.company, entry.decisions]), [['Acme', 'confirmed'], ['Beta', 'error']]);
    assert.equal(decisions[0].native, 'confirmed');
    assert.equal(decisions[0].parallelClaude, 'unverified');
    assert.equal(decisions[1].error, 'HTTP 500');
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.equal(summary.checks, 2);
    assert.equal(summary.compared, 1);
    assert.deepEqual(summary.requests, { made: 2, failed: 1, medianLatencyMs: summary.requests.medianLatencyMs });
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(out, 'decisions.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(out, 'summary.json')).mode & 0o777, 0o600);
    assert.match(logs.join('\n'), /2 checks/u);
    assert.equal(logs.join('\n').includes('Acme'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
