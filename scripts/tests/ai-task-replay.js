import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appExecute, appValidate, assertOutsideRepo, findBoardNode, main, matchFlow, parseArgs, prepareOutDir, replayTask, resetResearchedMatches, selectRowsForTask, selectScoringGroup, StopCapture, storedPostingUrls, UNREPLAYABLE_TASKS } from '../ai-task-replay.mjs';
import { compensationMap, normalizePostingUrl, officialPostingMap, percentile, preferenceResearchMap, renderText, summarize } from '../ai-task-replay-score.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-task-replay-test-'));
const cfg = (config, rep, batch, answer, extra = {}) => ({
  task: 'x', batch, config, rep, ok: true, valid: answer !== null, code: null, costUsd: 0.01, latencyMs: 100, model: 'm', usage: null, answer, ...extra,
});
const match = (preferenceId, outcome) => ({ preferenceId, outcome });
const prefAnswer = rows => ({ assessments: rows.map((matches, index) => ({ index, matches })) });

export default [
  {
    name: 'ai task replay score: preference agreement counts outcomes and strict-conflict decisions against Claude rep 1',
    async run() {
      const ref = prefAnswer([[match('s1', 'conflicts'), match('p1', 'confirmed')], [match('s1', 'confirmed'), match('p1', 'unverified')]]);
      const flash = prefAnswer([[match('s1', 'confirmed'), match('p1', 'confirmed')], [match('s1', 'confirmed'), match('p1', 'unverified')]]);
      const rows = [
        cfg('claude', 1, 1, ref), cfg('claude', 2, 1, ref),
        cfg('flash:low', 1, 1, flash, { costUsd: 0.01, latencyMs: 100 }),
        cfg('flash:low', 2, 1, null, { costUsd: 0.03, latencyMs: 300 }),
      ].map(row => ({ ...row, task: 'job-preference-evaluation' }));
      const [task] = summarize(rows, { strictIds: new Set(['s1']) }).tasks;
      const flashRow = task.configs.find(c => c.config === 'flash:low');
      assert.equal(flashRow.n, 2);
      assert.equal(flashRow.validRate, 0.5);
      near(flashRow.meanCostUsd, 0.02);
      assert.equal(flashRow.p50LatencyMs, 100);
      assert.equal(flashRow.p95LatencyMs, 300);
      assert.equal(flashRow.compared, 1);
      near(flashRow.outcomeAgreement, 0.75);
      near(flashRow.decisionAgreement, 0.5);
      const claudeRow = task.configs.find(c => c.config === 'claude');
      assert.equal(claudeRow.compared, 1, 'rep 1 is the reference, so only rep 2 is the noise floor');
      assert.equal(claudeRow.outcomeAgreement, 1);
      assert.equal(claudeRow.decisionAgreement, 1);
    },
  },
  {
    name: 'ai task replay score: scoring reports mean absolute difference and the within-5 fraction with Claude noise floor',
    async run() {
      const scores = values => ({ scores: values.map((matchScore, index) => ({ index, matchScore })) });
      const rows = [
        cfg('claude', 1, 1, scores([80, 60, 50])), cfg('claude', 2, 1, scores([80, 62, 50])),
        cfg('pro:high', 1, 1, scores([83, 70, 50])),
      ].map(row => ({ ...row, task: 'job-scoring' }));
      const [task] = summarize(rows).tasks;
      const pro = task.configs.find(c => c.config === 'pro:high');
      near(pro.meanAbsScoreDiff, 13 / 3);
      near(pro.withinPointsFraction, 2 / 3);
      const claude = task.configs.find(c => c.config === 'claude');
      near(claude.meanAbsScoreDiff, 2 / 3);
      assert.equal(claude.withinPointsFraction, 1);
      assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
      assert.equal(percentile([], 95), null);
    },
  },
  {
    name: 'ai task replay: --out inside the repository is refused before anything is created',
    async run() {
      const inside = path.join(REPO, 'replay-test-out-should-not-exist');
      assert.throws(() => assertOutsideRepo(inside, REPO), /outside the repository/);
      assert.throws(() => assertOutsideRepo(REPO, REPO), /outside the repository/);
      assert.doesNotThrow(() => assertOutsideRepo(path.join(os.tmpdir(), 'replay-ok'), REPO));
      const errors = [];
      const original = console.error;
      console.error = line => errors.push(line);
      try {
        const code = await main(['--task', 'job-scoring', '--canvas', 'nope', '--user-data', os.tmpdir(), '--out', inside]);
        assert.equal(code, 2);
      } finally { console.error = original; }
      assert.equal(fs.existsSync(inside), false);
      assert.equal(errors.length, 1);
    },
  },
  {
    name: 'ai task replay: arguments default to the full config matrix and reject unknown input',
    async run() {
      const opts = parseArgs(['--task', 'job-preference-evaluation', '--canvas', 'c', '--out', 'o']);
      assert.equal(opts.configs.length, 11);
      assert.deepEqual(opts.configs[0], { id: 'claude', kind: 'claude' });
      assert.deepEqual(opts.configs.find(c => c.id === 'pro:max'), { id: 'pro:max', kind: 'offload', route: 'deepseek-pro', reasoning: 'max' });
      assert.equal(opts.batches, 6);
      assert.equal(parseArgs(['--task', 'job-preference-evaluation', '--canvas', 'c', '--out', 'o', '--configs', 'flash:off']).configs[0].id, 'claude');
      assert.throws(() => parseArgs(['--task', 'job-scoring', '--canvas', 'c', '--out', 'o']), /user-data/);
      assert.throws(() => parseArgs(['--task', 'job-preference-evaluation', '--canvas', 'c', '--out', 'o', '--configs', 'flash:ultra']), /Unknown config/);
      assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
    },
  },
  {
    name: 'ai task replay: selection takes rows with a Claude result, most recent first, and one career record for scoring',
    async run() {
      const rows = [
        { id: 'a', matchScore: 70, scoringEvidenceReceipt: { careerSnapshotId: 's1', scoredAt: '2025-01-01T00:00:00Z' } },
        { id: 'b', matchScore: 'x', careerSnapshotId: 's2' },
        { id: 'c', matchScore: 60, careerSnapshotId: 's2', scoredAt: '2025-03-01T00:00:00Z' },
        { id: 'd', matchScore: 55, careerSnapshotId: 's2', scoredAt: '2025-02-01T00:00:00Z' },
      ];
      assert.deepEqual(selectRowsForTask('job-scoring', rows).map(row => row.id), ['c', 'd', 'a']);
      const group = selectScoringGroup(rows);
      assert.equal(group.careerSnapshotId, 's2');
      assert.deepEqual(group.jobs.map(row => row.id), ['c', 'd']);
      const withAssessment = (id, evaluatedAt, matches = [{ preferenceId: 'p' }]) => ({ id, preferenceAssessment: { matches, evaluatedAt } });
      const prefs = [withAssessment('p1', '2025-01-01T00:00:00Z'), withAssessment('p2', '2025-09-01T00:00:00Z', []), withAssessment('p3', '2025-02-01T00:00:00Z'), { id: 'p4' }, withAssessment('p5', '2025-02-01T00:00:00Z')];
      assert.deepEqual(selectRowsForTask('job-preference-evaluation', prefs).map(row => row.id), ['p5', 'p3', 'p1']);
      const canvas = { nodes: [{ id: 'g', type: 'group', data: { rows: [] }, children: [
        { id: 'plain', type: 'note', data: { rows: [] } },
        { id: 'board', type: 'jobs', data: { preferenceEvaluation: { preferencePlan: {} }, rows: [{}] } }] }] };
      assert.equal(findBoardNode(canvas).id, 'board');
      assert.equal(findBoardNode({ nodes: [{ id: 'x', data: { rows: [] } }] }), null);
    },
  },
  {
    name: 'ai task replay: capture stops after --batches, writes private results and texts, and resumes without re-running',
    async run() {
      const dir = tempDir();
      try {
        prepareOutDir(dir);
        const h = fakeHarness(dir);
        const first = await replayTask(h.args({ batches: 3 }));
        assert.equal(first.calls.length, 3);
        assert.equal(h.executed.length, 12, '3 batches x (2 claude + 2 flash reps)');
        assert.deepEqual(h.received[0], { config: 'claude', rep: 1, batch: 1 }, 'the flow gets the first valid Claude answer');
        const resultsPath = path.join(dir, 'results.jsonl');
        const rows = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(rows.length, 12);
        const flash = rows.find(row => row.config === 'flash:low' && row.batch === 2 && row.rep === 2);
        assert.deepEqual({ task: flash.task, ok: flash.ok, valid: flash.valid, code: flash.code, costUsd: flash.costUsd, latencyMs: flash.latencyMs, model: flash.model },
          { task: 'job-scoring', ok: true, valid: true, code: null, costUsd: 0.001, latencyMs: 5, model: 'm' });
        assert.deepEqual(flash.answer, { config: 'flash:low', rep: 2, batch: 2 });
        assert.equal(fs.statSync(resultsPath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
        const textPath = path.join(dir, 'texts', '2-flash_low-2.txt');
        assert.equal(fs.statSync(textPath).mode & 0o777, 0o600);
        assert.equal(JSON.parse(fs.readFileSync(textPath, 'utf8')).batch, 2);

        await replayTask(h.args({ batches: 3 }));
        assert.equal(h.executed.length, 12, 'a finished run executes nothing again');

        const kept = fs.readFileSync(resultsPath, 'utf8').trim().split('\n');
        fs.writeFileSync(resultsPath, `${kept.slice(0, -1).join('\n')}\n`);
        await replayTask(h.args({ batches: 3 }));
        assert.equal(h.executed.length, 13, 'only the missing (task, batch, config, rep) runs');
        await replayTask(h.args({ batches: 4 }));
        assert.equal(h.executed.length, 17, 'a new batch adds only its own cells');
        await assert.rejects(replayTask(h.args({ batches: 3, prompt: 'changed' })), /no longer matches/);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'ai task replay: credit exhaustion and a batch with no valid Claude answer stop the run',
    async run() {
      const credit = tempDir();
      const invalid = tempDir();
      try {
        prepareOutDir(credit);
        const h = fakeHarness(credit);
        await assert.rejects(replayTask(h.args({ batches: 3, execute: async ({ config, rep, call }) => {
          if (config.kind === 'offload') throw Object.assign(new Error('out of credit'), { code: 'OFFLOAD_CREDIT_EXHAUSTED' });
          return okReply(config, rep, call);
        } })), error => error.code === 'OFFLOAD_CREDIT_EXHAUSTED');
        const rows = fs.readFileSync(path.join(credit, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(rows.length > 0 && rows.every(row => row.config === 'claude'), 'no offload row is recorded for a credit stop');

        prepareOutDir(invalid);
        const g = fakeHarness(invalid);
        await assert.rejects(replayTask(g.args({ batches: 3, validate: () => { throw new Error('schema'); } })),
          error => error.userFacing === true && /No valid Claude answer for batch 1/.test(error.message));
        const bad = fs.readFileSync(path.join(invalid, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(bad.length >= 2 && bad.every(row => row.valid === false && row.answer === null && row.code === 'Error'));
      } finally {
        fs.rmSync(credit, { recursive: true, force: true });
        fs.rmSync(invalid, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'ai task replay: --dry-run captures and materializes without any AI call',
    async run() {
      const dir = tempDir();
      const recordedDir = tempDir();
      try {
        prepareOutDir(dir);
        const h = fakeHarness(dir);
        const fresh = await replayTask(h.args({ batches: 3, dryRun: true }));
        assert.equal(h.executed.length, 0);
        assert.equal(fresh.calls.length, 1, 'without a recorded answer the flow cannot pass the first batch');
        assert.equal(fresh.calls[0].promptChars, 'prompt-0'.length);
        assert.equal(fs.existsSync(path.join(dir, 'results.jsonl')), false);

        prepareOutDir(recordedDir);
        const g = fakeHarness(recordedDir);
        await replayTask(g.args({ batches: 3 }));
        const before = g.executed.length;
        const dry = await replayTask(g.args({ batches: 3, dryRun: true }));
        assert.equal(dry.calls.length, 3);
        assert.equal(g.executed.length, before);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(recordedDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'ai task replay score: official posting research compares chosen URLs (normalized) and counts found-by-one-side',
    async run() {
      assert.equal(normalizePostingUrl('HTTPS://Jobs.Example.com/a/b/?utm=1#frag'), 'https://jobs.example.com/a/b');
      assert.equal(normalizePostingUrl('not a url'), '');
      const cand = url => `CANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl: url, employer: 'E', employerDomain: '', ats: '' })}`;
      const section = (id, line) => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${line}\nEND OFFICIAL POSTING RESEARCH ${id}`;
      const text = lines => lines.map(([id, line]) => section(id, line)).join('\n');
      const ref = text([['a1', cand('https://x.com/j/1')], ['b2', cand('https://y.com/j/2')], ['c3', 'NOT FOUND'], ['d4', 'NOT FOUND']]);
      assert.deepEqual([...officialPostingMap(ref)], [['a1', 'https://x.com/j/1'], ['b2', 'https://y.com/j/2'], ['c3', 'none'], ['d4', 'none']]);
      const deepseek = text([['a1', cand('https://X.com/j/1/?q=1')], ['b2', 'NOT FOUND'], ['c3', cand('https://z.com/j/3')], ['d4', 'NOT FOUND']]);
      const rows = [
        { config: 'claude', rep: 1, answer: ref }, { config: 'claude', rep: 2, answer: ref }, { config: 'flash:low', rep: 1, answer: deepseek },
      ].map(row => ({ ...cfg(row.config, row.rep, 1, row.answer), task: 'job-official-posting-research' }));
      const [task] = summarize(rows).tasks;
      const flash = task.configs.find(c => c.config === 'flash:low');
      near(flash.agreement, 0.5);
      near(flash.foundRate, 0.5);
      assert.equal(flash.foundByDeepSeekOnly, 1);
      assert.equal(flash.foundByClaudeOnly, 1);
      near(flash.missingRate, 0);
      assert.equal(task.configs.find(c => c.config === 'claude').agreement, 1);
    },
  },
  {
    name: 'ai task replay score: match decision and chosen lead, compensation tolerance and missing answers, preference research agreement',
    async run() {
      const judge = (choice, postingUrl) => JSON.stringify({ choice, postingUrl, status: 'open' });
      const matchRows = [
        cfg('claude', 1, 1, judge('P1', 'https://a.com/1')), cfg('flash:low', 1, 1, judge('P1', 'https://a.com/2')), cfg('flash:low', 2, 1, judge('P2', 'https://a.com/1')),
      ].map(row => ({ ...row, task: 'job-official-posting-match' }));
      const m = summarize(matchRows).tasks[0].configs.find(c => c.config === 'flash:low');
      near(m.decisionAgreement, 0.5);
      near(m.chosenLeadAgreement, 0.5);

      const comp = (id, body) => `BEGIN COMPENSATION RESEARCH ${id}\n${body}\nEND COMPENSATION RESEARCH ${id}`;
      assert.deepEqual(compensationMap(comp('c1', 'Base pay is $100,000 - $120,000 per year.')).get('c1'), { currency: 'USD', period: 'year', min: 100000, max: 120000 });
      assert.equal(compensationMap(comp('c1', 'No figures found.')).size, 0);
      const refComp = [comp('c1', '$100k-$120k a year'), comp('c2', 'EUR 50,000 - 60,000 annual'), comp('c3', '$80,000 - $90,000 per year'), comp('c4', '$70,000 - $80,000 per year')].join('\n');
      const dsComp = [comp('c1', '$105,000 - $125,000 per year'), comp('c2', '$50,000 - $60,000 per year'), comp('c3', '$80,000 - $120,000 per year'), comp('c4', 'nothing public')].join('\n');
      const compRows = [cfg('claude', 1, 1, refComp), cfg('pro:high', 1, 1, dsComp)].map(row => ({ ...row, task: 'job-compensation-research-batch' }));
      const c = summarize(compRows).tasks[0].configs.find(x => x.config === 'pro:high');
      near(c.agreement, 0.25);
      near(c.missingRate, 0.25);

      const pref = (id, body) => `BEGIN RESEARCH ${id}\n${body}\nEND RESEARCH ${id}`;
      const map = preferenceResearchMap([pref('r1', 'See https://www.acme.com/about'), pref('r2', 'unavailable')].join('\n'));
      assert.deepEqual([map.get('r1').found, [...map.get('r1').hosts], map.get('r2').found], [true, ['acme.com'], false]);
      const refPref = [pref('r1', 'https://acme.com/a'), pref('r2', 'https://b.com/x'), pref('r3', 'none found')].join('\n');
      const dsPref = [pref('r1', 'https://www.acme.com/other'), pref('r2', 'https://other.org/x'), pref('r3', 'none found')].join('\n');
      const prefRows = [cfg('claude', 1, 1, refPref), cfg('flash:low', 1, 1, dsPref)].map(row => ({ ...row, task: 'job-preference-research-batch' }));
      const p = summarize(prefRows).tasks[0].configs.find(x => x.config === 'flash:low');
      near(p.agreement, 2 / 3);
      near(p.foundRate, 2 / 3);
    },
  },
  {
    name: 'ai task replay: Claude gets tools+maxTurns 16 for a tool task, offload gets webTools, a no-tool task gets neither',
    async run() {
      const seen = [];
      const fakeApp = tools => ({
        claudeTaskProfile: () => ({ model: 'opus', effort: 'high', ...(tools ? { tools } : {}) }),
        cachedPromptParts: prompt => ({ prompt }),
        handoffMessages: () => [],
        resolveClaudeBinary: () => '/bin/claude',
        claudeChildEnv: () => ({}),
        runClaudeSdkStage: async args => { seen.push({ kind: 'claude', args }); return { text: 't' }; },
        offloadTextCall: async args => { seen.push({ kind: 'offload', args }); return { text: 't' }; },
      });
      const call = { prompt: 'p', cachedPrefix: '' };
      const offload = { id: 'flash:low', kind: 'offload', route: 'deepseek-flash', reasoning: 'low' };
      const research = appExecute(fakeApp('WebSearch,WebFetch'), 'job-official-posting-research', null);
      await research({ config: { id: 'claude', kind: 'claude' }, call });
      await research({ config: offload, call });
      assert.deepEqual(seen[0].args.tools, ['WebSearch', 'WebFetch']);
      assert.equal(seen[0].args.maxTurns, 16);
      assert.deepEqual(seen[1].args.webTools, {});
      const plain = appExecute(fakeApp(''), 'job-scoring', null);
      await plain({ config: { id: 'claude', kind: 'claude' }, call });
      await plain({ config: offload, call });
      assert.equal('tools' in seen[2].args, false);
      assert.equal('maxTurns' in seen[2].args, false);
      assert.equal('webTools' in seen[3].args, false);
    },
  },
  {
    name: 'ai task replay: raw research validation returns the text, unreplayable tasks stop with a reason, researched matches reset to pending',
    async run() {
      const validate = appValidate({ validateNonApiAiSubmission: () => ({ parsed: true }) });
      assert.equal(validate({ responseSchema: null }, 'raw text'), 'raw text');
      assert.deepEqual(validate({ responseSchema: {} }, 'raw text'), { parsed: true });
      assert.deepEqual(Object.keys(UNREPLAYABLE_TASKS).sort(), ['job-compensation-research-batch']);
      const errors = [];
      const original = console.error;
      console.error = line => errors.push(line);
      try {
        for (const task of Object.keys(UNREPLAYABLE_TASKS)) {
          assert.equal(await main(['--task', task, '--canvas', 'c', '--out', path.join(os.tmpdir(), 'replay-unreplayable-out')]), 1);
        }
      } finally { console.error = original; }
      assert.equal(errors.length, 1);
      assert.ok(errors.every(line => /cannot be replayed faithfully/.test(line) && !line.includes('\n')));
      const row = { id: 'r', preferenceAssessment: { matches: [
        { preferenceId: 's', strict: true, category: 'company', outcome: 'confirmed', evidenceQuote: 'q', sourceUrls: ['https://a.com'] },
        { preferenceId: 'w', strict: false, category: 'company', outcome: 'confirmed' },
      ] } };
      const reset = resetResearchedMatches(row);
      assert.deepEqual(reset.preferenceAssessment.matches[0], { preferenceId: 's', strict: true, category: 'company', outcome: 'unverified' });
      assert.equal(reset.preferenceAssessment.matches[1].outcome, 'confirmed');
      assert.equal(row.preferenceAssessment.matches[0].outcome, 'confirmed', 'the stored row is not mutated');
      assert.deepEqual(selectRowsForTask('job-preference-research-batch', [row, { id: 'n' }]).map(r => r.id), ['r']);
      assert.deepEqual(selectRowsForTask('job-official-posting-research', [{ id: 'o', officialPosting: { outcome: 'found' } }, { id: 'n' }]).map(r => r.id), ['o']);
    },
  },
  {
    name: 'ai task replay match: stored URLs select rows and replace research; the store is in memory; rendering is off',
    async run() {
      const row = { id: 'a', title: 'Data Engineer', company: 'Acme', location: 'Berlin', url: 'https://www.linkedin.com/jobs/view/1',
        officialPosting: { outcome: 'found', sourceUrl: 'https://careers.acme.example/jobs/1', officialApplyUrl: 'https://careers.acme.example/apply/1',
          alternatives: [{ url: 'https://careers.acme.example/jobs/1' }, { url: 'http://insecure.example/x' }, { url: 'https://boards.example/acme/2' }] } };
      assert.deepEqual(storedPostingUrls(row), ['https://careers.acme.example/jobs/1', 'https://careers.acme.example/apply/1', 'https://boards.example/acme/2']);
      const noUrl = { id: 'b', officialPosting: { outcome: 'none' } };
      assert.deepEqual(storedPostingUrls(noUrl), []);
      assert.deepEqual(selectRowsForTask('job-official-posting-match', [noUrl, row, { id: 'c' }]).map(r => r.id), ['a']);
      assert.equal('job-official-posting-match' in UNREPLAYABLE_TASKS, false);

      let seen = null;
      const service = { resolveOfficialPostings: async (jobs, options) => { seen = { jobs, options }; return []; } };
      const fetched = [];
      const flow = matchFlow({ service, requestId: job => `${job.title.length}`.padStart(24, 'a'), rows: [row], signal: null,
        fetchPosting: async (...args) => { fetched.push(args); return { body: '' }; } });
      const batchCalls = [];
      await flow.startFlow(async (prompt) => { batchCalls.push(prompt); return 'x'; });
      assert.equal(flow.itemCount, 1);
      assert.equal(seen.jobs[0].officialPosting, undefined, 'the stored result is withheld so it is not reused');
      assert.equal(row.officialPosting.outcome, 'found', 'the stored row is not mutated');
      assert.equal(seen.options.bypassCache, true);
      assert.equal(seen.options.snapshotRender, null);
      assert.deepEqual(seen.options.candidateUrlsByRow, [['https://careers.acme.example/jobs/1', 'https://careers.acme.example/apply/1', 'https://boards.example/acme/2']]);
      await seen.options.snapshotFetch('https://careers.acme.example/jobs/1', { signal: 1 });
      assert.deepEqual(fetched, [['https://careers.acme.example/jobs/1', { signal: 1 }]]);
      // The research seam never reaches the batch caller and answers only the ids it was asked about.
      const id = 'a'.repeat(22) + '13';
      const answer = await seen.options.callRaw(`research ids: ${id}`);
      assert.equal(answer, `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`);
      assert.equal(await seen.options.callRaw('research ids: none'), '');
      assert.equal(batchCalls.length, 0);
      // Saves land in memory only.
      assert.equal(await seen.options.store.find(row), null);
      assert.deepEqual(await seen.options.store.save(row, { officialPosting: { outcome: 'found' } }), { officialPosting: { outcome: 'found' } });
      assert.equal(flow.saved.length, 1);
    },
  },
  {
    name: 'ai task replay match: the real resolver captures judge prompts built from re-downloaded pages with a fake fetch, never touching a store',
    async run() {
      const service = await import('../../electron/ipc/officialPostingService.js');
      const resolver = await import('../../electron/ipc/officialPostingResolver.js');
      const jobUrl = 'https://careers.acme.example/jobs/42';
      const row = { id: 'a', title: 'Data Engineer', company: 'Acme', location: 'Berlin', url: 'https://www.linkedin.com/jobs/view/1',
        snippet: 'Build data pipelines.', officialPosting: { outcome: 'found', sourceUrl: jobUrl, alternatives: [] } };
      const marker = 'REPLAY-PAGE-MARKER-7731';
      const html = `<html><head><title>Data Engineer - Acme</title></head><body><h1>Data Engineer</h1><p>${marker} ${'Acme builds data pipelines in Berlin and needs an engineer. '.repeat(30)}</p></body></html>`;
      const fetched = [];
      const fetchPosting = async (url) => { fetched.push(url); return { body: html, url, contentType: 'text/html; charset=utf-8' }; };
      const flow = matchFlow({ service, requestId: resolver.officialPostingRequestId, fetchPosting, rows: [row], signal: null });
      const calls = [];
      await flow.startFlow(async (prompt, options = {}) => { calls.push({ prompt: String(prompt), options }); throw new StopCapture(); }).catch(() => {});
      assert.ok(fetched.includes(jobUrl), `the stored URL was downloaded through the injected fetch (${fetched.join(',')})`);
      assert.ok(calls.length >= 1, 'a judge request reached the caller');
      for (const call of calls) {
        assert.equal(call.options.task, 'job-official-posting-match');
        assert.equal(typeof call.options.responseValidator, 'function');
        assert.ok(call.options.responseSchema && typeof call.options.responseSchema === 'object');
        assert.ok(`${call.prompt}${call.options.cachedPrefix || ''}`.includes(marker), 'the prompt embeds the downloaded page text');
      }
      assert.deepEqual(flow.saved, [], 'no result was saved anywhere, in memory or on disk');
    },
  },
  {
    name: 'ai task replay score: match agreement reports the Claude noise floor next to each config',
    async run() {
      const judge = (choice, url) => ({ choice, postingUrl: url, status: 'open' });
      const rows = [
        cfg('claude', 1, 1, judge('P1', 'https://a.com/1')), cfg('claude', 2, 1, judge('P1', 'https://a.com/1')), cfg('claude', 3, 1, judge('P2', 'https://a.com/2')),
        cfg('claude', 1, 2, judge('none', '')), cfg('claude', 2, 2, judge('none', '')), cfg('claude', 3, 2, judge('none', '')),
        cfg('pro:high', 1, 1, judge('P1', 'https://a.com/1')), cfg('pro:high', 1, 2, judge('P1', 'https://a.com/1')),
      ].map(r => ({ ...r, task: 'job-official-posting-match' }));
      const [task] = summarize(rows).tasks;
      near(task.noiseFloor.decisionAgreement, 0.75);
      near(task.noiseFloor.chosenLeadAgreement, 0.75);
      assert.equal(task.noiseFloor.compared, 4);
      const pro = task.configs.find(c => c.config === 'pro:high');
      near(pro.decisionAgreement, 0.5);
      near(pro.chosenLeadAgreement, 0.5);
      const text = renderText(summarize(rows));
      assert.match(text, /noise floor \(claude rep>=2 vs rep 1\): decision 75\.0% chosen-lead 75\.0% \[4 compared\]/);
    },
  },
];

function okReply(config, rep, call) {
  return { text: JSON.stringify({ config: config.id, rep, batch: call.batch }), costUsd: 0.001, durationMs: 5, model: 'm', usage: {} };
}

function fakeHarness(dir) {
  const executed = [];
  const received = [];
  const configs = [{ id: 'claude', kind: 'claude' }, { id: 'flash:low', kind: 'offload', route: 'deepseek-flash', reasoning: 'low' }];
  const args = (over = {}) => {
    const { prompt = 'prompt', ...rest } = over;
    return {
      task: 'job-scoring', outDir: dir, configs, reps: 2, claudeReps: 2, batches: 3, concurrency: 3,
      startFlow: async caller => { for (let i = 0; i < 6; i += 1) received.push(await caller(`${prompt}-${i}`, { hints: { itemCount: 2 } })); },
      materialize: (text, opts) => ({ prompt: text, cachedPrefix: '', responseSchema: null, responseValidator: null, itemCount: opts.hints.itemCount }),
      execute: async ({ config, rep, call }) => { executed.push(`${call.batch}-${config.id}-${rep}`); return okReply(config, rep, call); },
      validate: (call, text) => JSON.parse(text),
      ...rest,
    };
  };
  return { args, executed, received };
}
