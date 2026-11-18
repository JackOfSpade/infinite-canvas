import assert from 'node:assert/strict';
import {
  PLAN_ATTEMPTS, PLAN_SCHEMA, buildPlanPrompt, buildPlanRetryPrompt, planCall, validatePlan,
} from '../../electron/practiceCall/callPlanner.js';

const pool = [
  { number: 1, question: 'Tell me about yourself.', answer: 'PRIVATE-ANSWER-ONE I built widgets.', timesAsked: 3 },
  { number: 2, question: 'Design a widget cache.', answer: 'PRIVATE-ANSWER-TWO cache with eviction.', timesAsked: 0 },
  { number: 3, question: 'Why this team?', preparedAnswer: 'PRIVATE-ANSWER-THREE I like gadgets.', timesAsked: 1 },
];
const voices = [
  { key: 'V1', name: 'Alex', gender: 'female', age: 'middle-aged', accent: 'American', description: 'calm and low' },
  { key: 'V2', name: 'Blake', gender: 'male', age: 'young', accent: 'British', description: 'bright and quick' },
  { key: 'V3', name: 'Casey', gender: 'female', age: 'old', accent: 'Irish', description: 'warm and slow' },
];
const brief = { company: 'Acme Gadgets', role: 'Widget engineer', summary: 'Builds widgets.', themes: ['caching'], facts: ['Founded in a garage'] };
const application = { resume: 'RESUME-LINE Built widget pipelines.', coverLetter: 'LETTER-LINE I love gadgets.' };
const ctx = { pool, voices, targetMinutes: 30 };

const goodPlan = () => ({
  interviewKind: 'A hiring-manager screen with one technical segment.',
  lead: { voice: 'V1', role: 'Engineering manager', temperament: 'warm', stability: 0.3, room: 0.2, manner: 'Unhurried, listens for the reason behind a choice.' },
  panel: [{ voice: 'V2', role: 'Senior engineer', focus: 'caching design', stability: 0.35, room: 0.4, manner: 'Direct and curious.' }],
  questions: [
    { number: 1, askedBy: 'V1', minutes: 8, probes: ['Ask what exactly they built.'] },
    { number: 0, text: 'Tell me about a time a widget shipment went wrong.', askedBy: 'V1', minutes: 5, probes: [] },
    { number: 2, askedBy: 'V2', minutes: 15, probes: [] },
  ],
  problems: [{
    ref: 'p1', question: 2, language: 'python',
    parts: [{ title: 'Cache', content: 'Write a cache.\n\n- keep it small' }, { title: 'Eviction', content: 'Add eviction.' }],
    solution: 'Use a dict and a queue.', edgeCases: ['capacity zero'], hints: ['Think about order.', 'A queue helps.'],
  }],
});
const check = raw => validatePlan(raw, ctx);

const tests = [
  {
    name: 'practice call planner: a valid plan passes unchanged',
    async run() {
      const raw = goodPlan();
      const { plan, problems } = check(raw);
      assert.deepEqual(problems, []);
      assert.deepEqual(plan, goodPlan());
      assert.equal(PLAN_ATTEMPTS, 3);
      assert.equal(PLAN_SCHEMA.properties.panel.maxItems, 4);
    },
  },
  {
    name: 'practice call planner: each validation rule has its own specific problem',
    async run() {
      const mutate = fn => { const p = goodPlan(); fn(p); return check(p).problems.join(' | '); };
      assert.match(check('nope').problems[0], /not a JSON object/u);
      assert.match(mutate(p => { p.lead.voice = 'V9'; }), /lead\.voice is V9, which is not one of the drawn voices/u);
      assert.match(mutate(p => { p.panel[0].voice = 'V1'; }), /voice V1 is used by both lead and panel\[0\]/u);
      assert.match(mutate(p => { p.lead.temperament = 'angry'; }), /lead\.temperament must be one of warm, neutral, tough/u);
      assert.match(mutate(p => { p.lead.role = ''; }), /lead\.role must be at least 1 character/u);
      assert.match(mutate(p => { p.lead.role = 'x'.repeat(61); }), /lead\.role is 61 characters long and the limit is 60/u);
      assert.match(mutate(p => { p.questions[0].askedBy = 'V3'; }), /questions\[0\]\.askedBy is V3, who is neither the lead nor a panel member/u);
      assert.match(mutate(p => { p.questions[0].number = 99; }), /questions\[0\]\.number is 99, which is not a question number in the pool/u);
      assert.match(mutate(p => { p.questions[2].number = 1; }), /number 1 appears twice/u);
      assert.match(mutate(p => { p.questions[0].minutes = 0.1; }), /questions\[0\]\.minutes is 0\.1 and must be between 0\.5 and 20/u);
      assert.match(mutate(p => { p.questions[0].probes = ['a', 'b', 'c', 'd', 'e']; }), /probes has 5 items and the limit is 4/u);
      assert.match(mutate(p => { p.questions = []; }), /at least one pool question/u);
      assert.match(mutate(p => { p.questions.splice(1, 1); }), /exactly one question of your own/u);
      assert.match(mutate(p => { p.questions.push({ number: 0, text: 'Another question of my own here.', askedBy: 'V1', minutes: 1, probes: [] }); }), /number 0 appears twice/u);
      assert.match(mutate(p => { p.questions[1].text = 'short'; }), /text \(the question you wrote\) must be at least 10/u);
      assert.match(mutate(p => { p.questions[1].text = 'x'.repeat(401); }), /is 401 characters long and the limit is 400/u);
      assert.match(mutate(p => { delete p.questions[1].text; }), /text \(the question you wrote\) must be a string/u);
      assert.match(mutate(p => { p.questions[0].text = 'A reworded pool question.'; }), /pool question 1 and must not carry a text field/u);
      assert.match(mutate(p => { p.questions = p.questions.slice(0, 2); }), /panel\[0\] \(V2, Senior engineer\) asks no question/u);
      assert.match(mutate(p => { p.questions[0].minutes = 20; p.questions[2].minutes = 20; }), /add up to 45, more than 1\.25 times the call length of 30/u);
      assert.match(mutate(p => { p.problems[0].question = 3; }), /problems\[0\]\.question is 3, which is not one of the picked questions/u);
      assert.match(mutate(p => { p.problems.push({ ...p.problems[0] }); }), /ref p1 is used twice/u);
      assert.match(mutate(p => { p.problems[0].parts = []; }), /parts must list at least one part/u);
      assert.match(mutate(p => { p.problems[0].parts[0].content = ''; }), /parts\[0\]\.content must not be empty/u);
      assert.match(mutate(p => { p.problems[0].solution = ''; }), /solution must not be empty/u);
      assert.match(mutate(p => { p.problems[0].hints = Array(6).fill('h'); }), /hints has 6 items and the limit is 5/u);
      assert.match(mutate(p => { p.panel = Array(5).fill(p.panel[0]); }), /panel has 5 members and the limit is 4/u);
      assert.match(mutate(p => { delete p.interviewKind; }), /interviewKind must be a string/u);
      assert.match(mutate(p => { p.lead.stability = 'high'; }), /lead\.stability must be a number/u);
    },
  },
  {
    name: 'practice call planner: harmless normalisation trims strings and clamps stability and room',
    async run() {
      const raw = goodPlan();
      raw.interviewKind = '  A   screen \n today ';
      raw.lead.stability = 0.99;
      raw.lead.room = -2;
      raw.panel[0].stability = 0.01;
      raw.panel[0].room = 7;
      raw.problems[0].parts[0].content = '\n  Write a cache.\n\n- keep it small  \n';
      const { plan, problems } = check(raw);
      assert.deepEqual(problems, []);
      assert.equal(plan.interviewKind, 'A screen today');
      assert.deepEqual([plan.lead.stability, plan.lead.room, plan.panel[0].stability, plan.panel[0].room], [0.75, 0, 0.15, 1]);
      assert.equal(plan.problems[0].parts[0].content, 'Write a cache.\n\n- keep it small', 'line breaks inside content are kept');
    },
  },
  {
    name: 'practice call planner: a failed first attempt is asked again with its problems and recorded',
    async run() {
      const prompts = [];
      const bad = goodPlan(); bad.lead.voice = 'V9';
      const answers = [bad, goodPlan()];
      const callText = async ({ prompt, schema, signal }) => {
        prompts.push({ prompt, schema, signal });
        return answers.shift();
      };
      const controller = new AbortController();
      const result = await planCall({ callText, brief, pool, voices, targetMinutes: 30, signal: controller.signal });
      assert.deepEqual(result.plan, goodPlan());
      assert.equal(result.attempts.length, 1);
      assert.match(result.attempts[0].problems[0], /lead\.voice is V9/u);
      assert.equal(prompts.length, 2);
      assert.equal(prompts[0].schema, PLAN_SCHEMA);
      assert.equal(prompts[0].signal, controller.signal, 'the abort signal is passed through');
      assert.doesNotMatch(prompts[0].prompt, /REJECTED/u);
      assert.match(prompts[1].prompt, /PREVIOUS PLAN WAS REJECTED/u);
      assert.match(prompts[1].prompt, /lead\.voice is V9/u);
      assert.ok(prompts[1].prompt.includes('"voice": "V9"'), 'the retry carries the rejected plan');
      assert.equal(typeof result.ms, 'number');
    },
  },
  {
    name: 'practice call planner: three failures throw plan-failed carrying the attempts',
    async run() {
      let calls = 0;
      const callText = async () => { calls += 1; return { nonsense: true }; };
      await assert.rejects(() => planCall({ callText, brief, pool, voices, targetMinutes: 30 }), error => {
        assert.equal(error.code, 'plan-failed');
        assert.equal(error.attempts.length, PLAN_ATTEMPTS);
        assert.ok(error.attempts.every(attempt => attempt.problems.length > 0));
        return true;
      });
      assert.equal(calls, PLAN_ATTEMPTS);
    },
  },
  {
    name: 'practice call planner: an abort is passed on and not retried',
    async run() {
      let calls = 0;
      const controller = new AbortController();
      const callText = async () => { calls += 1; controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
      await assert.rejects(() => planCall({ callText, brief, pool, voices, targetMinutes: 30, signal: controller.signal }), error => error.name === 'AbortError');
      assert.equal(calls, 1);
      const early = new AbortController(); early.abort();
      let never = 0;
      await assert.rejects(() => planCall({ callText: async () => { never += 1; return goodPlan(); }, brief, pool, voices, targetMinutes: 30, signal: early.signal }), error => error.name === 'AbortError');
      assert.equal(never, 0);
    },
  },
  {
    name: 'practice call planner: the prompt carries the pool, the voices with keys and only those inputs',
    async run() {
      const prompt = buildPlanPrompt({ brief, application, pool, voices, targetMinutes: 30, steering: 'Focus on caching.', candidateName: 'Pat Example' });
      for (const item of pool) assert.ok(prompt.includes(`Question ${item.number}: ${item.question}`));
      assert.doesNotMatch(prompt, /PRIVATE-ANSWER/u, 'prepared answers never reach the planner');
      assert.doesNotMatch(prompt, /Prepared answer/u);
      assert.match(prompt, /RESUME-LINE Built widget pipelines\./u);
      assert.match(prompt, /LETTER-LINE I love gadgets\./u);
      assert.match(prompt, /THE APPLICATION/u);
      assert.match(prompt, /ONE QUESTION OF YOUR OWN/u);
      assert.match(prompt, /WHOLE pool/u);
      assert.match(prompt, /number 0/u);
      const empty = buildPlanPrompt({ brief, application: { resume: '', coverLetter: '  ' }, pool, voices, targetMinutes: 30 });
      assert.match(empty, /submitted no resume text/u);
      assert.match(empty, /submitted no cover letter text/u);
      const career = buildPlanPrompt({ brief, application: { resume: 'CAREER-LINE Ran a lab.', coverLetter: '', source: 'career-documents' }, pool, voices, targetMinutes: 30 });
      assert.match(career, /CAREER-LINE Ran a lab\./u);
      assert.match(career, /not a resume tailored to this job/u);
      assert.doesNotMatch(career, /RESUME \(what the candidate submitted/u);
      const richBrief = buildPlanPrompt({ brief: { company: 'Acme', role: 'Dev', roleSummary: 'RS-TEXT', roleThemes: ['RT-ONE'], companyFacts: ['CF-ONE'], recentContext: [{ text: 'RC-ONE' }] }, pool, voices, targetMinutes: 30 });
      for (const bit of ['RS-TEXT', 'RT-ONE', 'CF-ONE', 'RC-ONE']) assert.ok(richBrief.includes(bit), bit);
      assert.match(prompt, /timesAsked: 3/u);
      for (const voice of voices) { assert.ok(prompt.includes(`- ${voice.key}: ${voice.name}`)); assert.ok(prompt.includes(voice.description)); }
      assert.match(prompt, /Acme Gadgets/u);
      assert.match(prompt, /Focus on caching\./u);
      assert.match(prompt, /Pat Example/u);
      assert.match(prompt, /about 30 minutes/u);
      assert.match(prompt, /MANNER ONLY/u);
      assert.match(prompt, /make do with them/u);
      assert.doesNotMatch(prompt, /V4|V5/u, 'only the drawn voices are listed');
      const retry = buildPlanRetryPrompt({ brief, pool, voices, targetMinutes: 30 }, ['x is wrong'], '{"rejected":"RAW-PLAN"}');
      assert.match(retry, /- x is wrong/u);
      assert.ok(retry.indexOf('RAW-PLAN') > 0 && retry.indexOf('RAW-PLAN') < retry.indexOf('- x is wrong'), 'the rejected plan comes before the problem list');
      const long = buildPlanRetryPrompt({ brief, pool, voices, targetMinutes: 30 }, ['y'], 'z'.repeat(70000));
      assert.ok(long.length < buildPlanPrompt({ brief, pool, voices, targetMinutes: 30 }).length + 61000);
    },
  },
  {
    name: 'practice call planner: fewer than five voices and a single voice work',
    async run() {
      const solo = [voices[0]];
      const plan = {
        interviewKind: 'A short solo call.',
        lead: { voice: 'V1', role: 'Recruiter', temperament: 'neutral', stability: 0.3, room: 0.1, manner: '' },
        panel: [],
        questions: [{ number: 3, askedBy: 'V1', minutes: 5, probes: [] }, { number: 0, text: 'What is your notice period?', askedBy: 'V1', minutes: 2, probes: [] }],
        problems: [],
      };
      assert.deepEqual(validatePlan(plan, { pool, voices: solo, targetMinutes: 10 }).problems, []);
      const asked = [];
      const result = await planCall({ callText: async ({ prompt }) => { asked.push(prompt); return plan; }, brief, pool, voices: solo, targetMinutes: 10 });
      assert.deepEqual(result.plan.panel, []);
      assert.match(asked[0], /- V1: Alex/u);
      assert.doesNotMatch(asked[0], /V2/u);
      const two = JSON.parse(JSON.stringify(plan)); two.panel = [{ voice: 'V2', role: 'Peer', focus: 'x', stability: 0.3, room: 0, manner: '' }];
      assert.match(validatePlan(two, { pool, voices: solo, targetMinutes: 10 }).problems.join(' | '), /panel\[0\]\.voice is V2, which is not one of the drawn voices \(V1\)/u);
    },
  },
  {
    name: 'practice call planner: a rejected raw text answer is parsed and passed to the retry',
    async run() {
      const prompts = [];
      const answers = ['not json at all', JSON.stringify(goodPlan())];
      const callText = async ({ prompt }) => { prompts.push(prompt); return answers.shift(); };
      const result = await planCall({ callText, brief, application, pool, voices, targetMinutes: 30 });
      assert.deepEqual(result.plan, goodPlan());
      assert.match(result.attempts[0].problems[0], /not valid JSON/u);
      assert.ok(prompts[1].includes('not json at all'));
      assert.ok(prompts[0].includes('RESUME-LINE'), 'planCall passes the application through');
    },
  },
  {
    name: 'practice call planner: a problem may belong to question 0',
    async run() {
      const p = goodPlan(); p.problems[0].question = 0;
      assert.deepEqual(check(p).problems, []);
    },
  },
  {
    name: 'practice call planner: a broken value does not cause follow-on false problems',
    async run() {
      const mutate = fn => { const p = goodPlan(); fn(p); return check(p).problems; };
      // invalid lead voice: askedBy for the lead's own questions is not also flagged
      const bad = mutate(p => { p.lead.voice = 'V9'; p.questions[0].askedBy = 'V9'; p.questions[1].askedBy = 'V9'; });
      assert.equal(bad.length, 1, bad.join(' | '));
      // duplicate voice still counts as a person
      const dup = mutate(p => { p.panel[0].voice = 'V1'; p.questions[2].askedBy = 'V1'; });
      assert.equal(dup.length, 1, dup.join(' | '));
      // lead missing: no askedBy or panel-asks noise
      const noLead = mutate(p => { p.lead = null; });
      assert.deepEqual(noLead, ['lead must be an object']);
      // no questions: problems[].question is not reported against an empty list
      const none = mutate(p => { p.questions = []; });
      assert.equal(none.length, 1, none.join(' | '));
      const notArray = mutate(p => { p.questions = 'x'; });
      assert.equal(notArray.length, 1, notArray.join(' | '));
    },
  },
];

export default tests;
