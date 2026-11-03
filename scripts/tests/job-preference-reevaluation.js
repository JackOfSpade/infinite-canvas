// A strict role requirement removes a job only on a conflict, and re-checking
// saved jobs keeps every score still current. Synthetic fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateJobPreferences, reapplyStoredJobPreferences, researchDeferredJobPreferences } from '../../electron/ipc/jobPreferences.js';
import { hasStoredPreferenceVerdicts, mergeScoredJobs, splitKeptScores } from '../../src/utils/jobSearchPreferenceReevaluation.js';
import { savedJobsReevaluationKeepsScores } from '../../src/utils/jobSearchSplitClear.js';
import { carryBoardRescores } from '../../src/nodes/jobboard/jobBoardResearchStage.js';
import { unverifiedCompanyPreferences } from '../../electron/ipc/researchGate.js';
import { runBoardPreferenceOverrideStage } from '../../src/nodes/jobboard/jobBoardPreferenceOverrideStage.js';
import { activeJobBoardPreferenceOverride, applyJobBoardPreferenceBrief, jobBoardPreferenceOverrideView, jobBoardPreferenceSeed } from '../../src/utils/jobBoardPreferenceOverride.js';

const SNAPSHOT = 'a'.repeat(64);
const OTHER_SNAPSHOT = 'b'.repeat(64);
const item = (id, criterion, category) => ({ id, criterion, category });
const plan = strictRequirements => ({ version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements, warnings: [], settingConflicts: [], titles: [] });
const verdict = (preferenceId, outcome, evidenceQuote = '') => ({ preferenceId, outcome, evidence: 'Fixture evidence.', evidenceQuote });
const listing = (title, description = 'Northwind Labs builds billing software for customers.') => ({ title, company: 'Northwind Labs', location: 'Remote', description, url: `https://jobs.example.test/${encodeURIComponent(title)}` });

async function evaluate(strictRequirements, matches, { deferCompanyResearch = true } = {}) {
  const jobs = [listing('Backend Engineer')];
  return evaluateJobPreferences({
    jobs, jobPreferences: 'Fixture brief.', preferencePlan: plan(strictRequirements), deferCompanyResearch,
    callRaw: () => { throw new Error('this fixture needs no web research'); },
    callText: async () => ({ assessments: [{ index: 0, matches }] }),
  });
}

export default [
  {
    name: 'strict rules: an unclear role requirement goes to scoring, a role conflict still removes the job',
    run: async () => {
      const unclear = await evaluate([item('r1', 'Consider Frontend Engineer only with API work', 'role')], [verdict('r1', 'unverified')]);
      assert.equal(unclear.acceptedJobs.length, 1);
      assert.equal(unclear.filteredJobs.length, 0);
      assert.equal(unclear.counts.strictUnverified, 1);
      assert.match(unclear.acceptedJobs[0].preferenceAssessment.summary, /1 could not be confirmed/);
      const conflict = await evaluate([item('r1', 'Exclude internal tools', 'role')], [verdict('r1', 'conflicts', 'billing software')]);
      assert.equal(conflict.filteredJobs.length, 1);
      assert.equal(conflict.counts.strictConflicts, 1);
    },
  },
  {
    name: 'strict rules: a quote the listing does not contain cannot remove a job on a role conflict',
    run: async () => {
      const result = await evaluate([item('r1', 'Exclude internal tools', 'role')], [verdict('r1', 'conflicts', 'internal tooling only')]);
      assert.equal(result.acceptedJobs.length, 1);
      assert.equal(result.acceptedJobs[0].preferenceAssessment.matches[0].outcome, 'unverified');
    },
  },
  {
    name: 'strict rules: an unsure company rule waits for research, and no category removes a job without a conflict',
    run: async () => {
      const deferred = await evaluate([item('r8', 'Exclude government employers', 'company')], [verdict('r8', 'unverified')]);
      assert.equal(deferred.acceptedJobs.length, 1);
      assert.equal(deferred.acceptedJobs[0].preferenceAssessment.companyResearchPending, true);
      const other = await evaluate([item('l1', 'Must offer relocation help', 'other')], [verdict('l1', 'unverified')]);
      assert.equal(other.acceptedJobs.length, 1);
      const pay = await evaluate([item('p1', 'Must pay over a stated floor', 'compensation')], [verdict('p1', 'conflicts', 'billing software')]);
      assert.equal(pay.filteredJobs.length, 1);
    },
  },
  {
    name: 'company research: a rule it cannot settle keeps the job, drops the pending flag and keeps the label',
    run: async () => {
      const match = { preferenceId: 'r8', criterion: 'Exclude staffing agencies', category: 'company', strict: true, outcome: 'unverified', source: 'listing' };
      const job = { ...listing('Product Engineer'), preferenceAssessment: { status: 'accepted', companyResearchPending: true, matches: [match] } };
      let calls = 0;
      const settled = await researchDeferredJobPreferences({
        jobs: [job], companyResearchPipelineEligible: false,
        callRaw: async () => { calls += 1; throw new Error('research unavailable'); },
        callText: async () => { calls += 1; throw new Error('research unavailable'); },
      }).catch(error => ({ error }));
      assert.ok(calls > 0, 'the company rule was sent to research');
      if (!settled.error) {
        assert.equal(settled.filtered, 0);
        assert.equal(Object.hasOwn(settled.jobs[0].preferenceAssessment, 'companyResearchPending'), false);
        assert.deepEqual(unverifiedCompanyPreferences(settled.jobs[0]).map(row => row.preferenceId), ['r8']);
      }
      assert.deepEqual(unverifiedCompanyPreferences(job).map(row => row.criterion), ['Exclude staffing agencies'], 'a job still waiting shows the same label');
      assert.deepEqual(unverifiedCompanyPreferences({ preferenceAssessment: { matches: [{ ...match, outcome: 'confirmed' }, { ...match, category: 'role' }] } }), []);
    },
  },
  {
    name: 'stored verdicts: the removal rule re-runs on saved jobs with no AI',
    run: () => {
      const stored = (outcome, category = 'role') => ({ ...listing(`Job ${outcome} ${category}`), preferenceAssessment: { status: 'filtered', matches: [{ preferenceId: 'r1', criterion: 'Rule', category, strict: true, outcome }] } });
      const result = reapplyStoredJobPreferences({ jobs: [stored('unverified'), stored('conflicts'), stored('confirmed'), stored('unverified', 'company')], preferencePlan: plan([]) });
      assert.deepEqual(result.acceptedJobs.map(job => job.title).sort(), ['Job confirmed role', 'Job unverified company', 'Job unverified role']);
      assert.deepEqual(result.filteredJobs.map(job => job.title), ['Job conflicts role']);
      assert.equal(result.candidatePool.length, 4);
      assert.equal(result.acceptedJobs.find(job => job.title === 'Job unverified company').preferenceAssessment.companyResearchPending, true);
      assert.equal(reapplyStoredJobPreferences({ jobs: [listing('No verdicts')], preferencePlan: plan([]) }), null);
      const samePlan = plan([item('r1', 'Rule', 'role')]);
      assert.equal(hasStoredPreferenceVerdicts([stored('confirmed')], samePlan), true);
      assert.equal(hasStoredPreferenceVerdicts([stored('confirmed'), listing('No verdicts')], samePlan), false);
      assert.equal(hasStoredPreferenceVerdicts([], samePlan), false);
    },
  },
  {
    name: 'stored verdicts: results for another plan are never re-applied, as after a paused brief edit',
    run: () => {
      const job = { ...listing('Saved'), preferenceAssessment: { matches: [{ preferenceId: 'r1', criterion: 'Old rule', category: 'role', strict: true, outcome: 'confirmed' }] } };
      assert.equal(hasStoredPreferenceVerdicts([job], plan([item('r1', 'Old rule', 'role')])), true);
      assert.equal(hasStoredPreferenceVerdicts([job], plan([item('r1', 'New rule', 'role')])), false, 'same id, reworded rule');
      assert.equal(hasStoredPreferenceVerdicts([job], plan([item('r1', 'Old rule', 'role'), item('r2', 'Added rule', 'company')])), false, 'added rule');
      assert.equal(hasStoredPreferenceVerdicts([job], { ...plan([]), softPreferences: [item('s1', 'Soft', 'role')] }), false, 'removed strict rule');
      assert.equal(hasStoredPreferenceVerdicts([job], plan([])), false, 'no rules');
    },
  },
  {
    name: 'carried company research: an edited brief owes its new company rule fresh research',
    run: () => {
      const url = 'https://jobs.example.test/saved';
      const assessment = (criterion, pending) => ({ status: 'accepted', ...(pending ? { companyResearchPending: true } : {}), matches: [{ preferenceId: 'r8', criterion, category: 'company', strict: true, outcome: pending ? 'unverified' : 'confirmed' }] });
      const card = criterion => ({ type: 'jobcard', data: { ...listing('Saved'), url, preferenceAssessment: assessment(criterion, false) } });
      const job = { ...listing('Saved'), url, preferenceAssessment: assessment('No staffing agencies', true) };
      assert.equal(carryBoardRescores([job], [card('No staffing agencies')])[0].preferenceAssessment.companyResearchPending, undefined, 'the same rule keeps its finished research');
      assert.equal(carryBoardRescores([job], [card('No government employers')])[0].preferenceAssessment.companyResearchPending, true, 'a new rule stays pending');
    },
  },
  {
    name: 'an empty replacement keeps every card tied to an application',
    run: () => {
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const confirm = board.slice(board.indexOf('const confirmEmptyReplacement = useCallback'), board.indexOf('confirmed empty replacement id='));
      assert.match(confirm, /isProtectedJobCard\(node\)/);
      assert.match(confirm, /clearBoardChildren\(\{ preserveNodeIds: applicationCardIds \}\)/);
    },
  },
  {
    name: 'kept scores: only newly passing jobs are scored, and a kept job takes its fresh preference result',
    run: () => {
      const fresh = { status: 'accepted', preferenceScore: 25, matches: [] };
      const passed = ['Kept', 'New', 'Unscored', 'Old career'].map(title => ({ ...listing(title), preferenceAssessment: fresh }));
      const scored = [
        { ...listing('Kept'), matchScore: 81, reasoning: 'Kept reasoning', careerSnapshotId: SNAPSHOT, preferenceAssessment: { status: 'accepted', preferenceScore: 0 } },
        { ...listing('Unscored'), matchScore: 50, scoreStatus: 'unscored-batch', careerSnapshotId: SNAPSHOT },
        { ...listing('Old career'), matchScore: 90, careerSnapshotId: OTHER_SNAPSHOT },
        { ...listing('Removed by edit'), matchScore: 95, careerSnapshotId: SNAPSHOT },
      ];
      const { jobsToScore, keptScoredJobs } = splitKeptScores(passed, scored, SNAPSHOT);
      assert.deepEqual(jobsToScore.map(job => job.title), ['New', 'Unscored', 'Old career']);
      assert.deepEqual(keptScoredJobs.map(job => job.title), ['Kept']);
      assert.equal(keptScoredJobs[0].reasoning, 'Kept reasoning');
      assert.equal(keptScoredJobs[0].preferenceAssessment, fresh);
      const merged = mergeScoredJobs([{ matchScore: 90, title: 'Top' }, { matchScore: 81, title: 'Tie', preferenceAssessment: { preferenceScore: 0 } }], keptScoredJobs);
      assert.deepEqual(merged.map(job => job.title), ['Top', 'Kept', 'Tie']);
    },
  },
  {
    name: 'scores: a re-check on a standalone Search keeps them, a career swap does not',
    run: () => {
      assert.equal(savedJobsReevaluationKeepsScores({}), true);
      assert.equal(savedJobsReevaluationKeepsScores({ savedJobsRescore: { careerSnapshotId: SNAPSHOT } }), false);
    },
  },
  {
    name: 'Board preferences: an edit keeps scores and re-asks only the rule checks, and an empty box applies nothing',
    run: () => {
      const first = applyJobBoardPreferenceBrief({}, '  No agencies  ', { now: 1 });
      assert.equal(first.brief, 'No agencies');
      assert.equal(activeJobBoardPreferenceOverride({ jobBoardPreferenceOverride: first }), first);
      assert.equal(applyJobBoardPreferenceBrief({}, '   '), null);
      const withResults = { ...first, plan: plan([]), results: { hub: { careerSnapshotId: SNAPSHOT, assessments: { a: { status: 'accepted' } }, scored: { a: { matchScore: 80 } } } } };
      const edited = applyJobBoardPreferenceBrief({ jobBoardPreferenceOverride: withResults }, 'No staffing firms', { now: 2 });
      assert.equal(edited.plan, null);
      assert.deepEqual(edited.results.hub.assessments, {});
      assert.deepEqual(edited.results.hub.scored, { a: { matchScore: 80 } });
      const same = applyJobBoardPreferenceBrief({ jobBoardPreferenceOverride: withResults }, 'No agencies', { now: 3 });
      assert.deepEqual(same.results.hub.assessments, { a: { status: 'accepted' } });
      assert.equal(same.combinedAt, null);
      assert.equal(jobBoardPreferenceOverrideView({}).state, 'empty');
      assert.equal(jobBoardPreferenceOverrideView({ jobBoardPreferenceOverride: same }).state, 'pending');
      assert.equal(jobBoardPreferenceOverrideView({ jobBoardPreferenceOverride: { ...same, combinedAt: 4 } }).state, 'applied');
      assert.deepEqual(jobBoardPreferenceSeed([{ jobPreferences: 'A' }, { jobPreferences: 'A ' }]), { brief: 'A', briefsDiffer: false });
      assert.deepEqual(jobBoardPreferenceSeed([{ jobPreferences: 'A' }, { jobPreferences: 'B' }]), { brief: 'A', briefsDiffer: true });
    },
  },
  {
    name: 'Board preferences stage: replaces Search rules, scores only newly passing jobs, leaves the Search alone, and resumes without asking again',
    run: async () => {
      const rule = item('r1', 'Exclude internal tools', 'role');
      const rulePlan = plan([rule]);
      const assessment = (status, criterion = rule.criterion) => ({ status, matches: [{ preferenceId: 'r1', criterion, category: 'role', strict: true, outcome: status === 'filtered' ? 'conflicts' : 'confirmed' }] });
      const source = { id: 'hub', careerSnapshotId: SNAPSHOT, jobPreferences: 'Old brief', searchBriefPlan: plan([item('o1', 'Old rule', 'role')]),
        preferenceCandidatePool: [{ ...listing('Kept score'), preferenceAssessment: assessment('filtered', 'Old rule') }, listing('Was filtered'), listing('Now removed')],
        scoredJobs: [{ ...listing('Kept score'), matchScore: 81, reasoning: 'Kept', careerSnapshotId: SNAPSHOT }] };
      const harness = () => {
        const calls = { interpret: 0, evaluated: [], scored: [] };
        return { calls, options: { nodeId: 'board', manualAiRunId: 'run', persist: () => {},
          interpret: async () => { calls.interpret += 1; return { success: true, preferencePlan: { ...rulePlan, titles: ['Ignored'] } }; },
          reapply: async () => { throw new Error('these answers belong to another plan'); },
          evaluate: async ({ jobs, preferencePlan }) => {
            calls.evaluated.push(...jobs.map(job => job.title));
            assert.deepEqual(preferencePlan.titles, [], 'an override never changes what a Search scans');
            return { success: true, candidatePool: jobs.map(job => ({ ...job, preferenceAssessment: assessment(job.title === 'Now removed' ? 'filtered' : 'accepted') })) };
          },
          score: async ({ jobs }) => { calls.scored.push(...jobs.map(job => job.title)); return { success: true, scoredJobs: jobs.map(job => ({ ...job, matchScore: 72 })) }; },
        } };
      };
      const before = JSON.stringify(source);
      const first = harness();
      const saved = [];
      const result = await runBoardPreferenceOverrideStage([source], { ...first.options, override: applyJobBoardPreferenceBrief({}, 'New brief', { now: 1 }), persist: record => saved.push(record) });
      assert.equal(JSON.stringify(source), before, 'Search data is only read');
      assert.equal(first.calls.interpret, 1);
      assert.deepEqual(first.calls.evaluated.sort(), ['Kept score', 'Now removed', 'Was filtered']);
      assert.deepEqual(first.calls.scored, ['Was filtered']);
      const rows = result.jobArrays[0];
      assert.deepEqual(rows.map(job => job.title).sort(), ['Kept score', 'Was filtered']);
      assert.equal(rows.find(job => job.title === 'Kept score').reasoning, 'Kept');
      assert.ok(rows.every(job => job.originHubId === 'hub'));
      assert.deepEqual(result.counts, { checked: 3, passed: 2, removed: 1, newlyScored: 1, keptScores: 1, reused: 0, unscored: 0 });
      const resumed = harness();
      const again = await runBoardPreferenceOverrideStage([source], { ...resumed.options, override: saved.at(-1) });
      assert.equal(resumed.calls.interpret, 0);
      assert.deepEqual(resumed.calls.evaluated, []);
      assert.deepEqual(resumed.calls.scored, []);
      assert.deepEqual(again.jobArrays[0].map(job => job.title).sort(), ['Kept score', 'Was filtered']);
      const later = harness();
      await runBoardPreferenceOverrideStage([{ ...source, preferenceCandidatePool: [...source.preferenceCandidatePool, listing('From a later scan')] }], { ...later.options, override: saved.at(-1) });
      assert.deepEqual(later.calls.evaluated, ['From a later scan'], 'a later scan is checked against the override');
      assert.deepEqual(later.calls.scored, ['From a later scan']);
    },
  },
  {
    name: 'Board preferences stage: unchanged rules reuse saved answers with no AI, and a failed score is asked again',
    run: async () => {
      const rule = item('r1', 'Exclude internal tools', 'role');
      const stored = { status: 'accepted', matches: [{ preferenceId: 'r1', criterion: rule.criterion, category: 'role', strict: true, outcome: 'unverified' }] };
      const hubPlan = plan([rule]);
      const source = { id: 'hub', careerSnapshotId: SNAPSHOT, jobPreferences: 'Same brief', searchBriefPlan: hubPlan, scoredJobs: [],
        preferenceCandidatePool: [{ ...listing('Stored'), preferenceAssessment: stored }] };
      let reapplied = 0; let scoreCalls = 0; const persisted = [];
      const options = { override: applyJobBoardPreferenceBrief({}, 'Same brief'), nodeId: 'board', manualAiRunId: 'run', persist: record => persisted.push(record),
        interpret: async () => { throw new Error('the same brief needs no AI'); },
        evaluate: async () => { throw new Error('stored answers need no AI'); },
        reapply: async ({ jobs }) => { reapplied += jobs.length; return { success: true, candidatePool: reapplyStoredJobPreferences({ jobs, preferencePlan: hubPlan }).candidatePool }; },
        score: async ({ jobs }) => { scoreCalls += 1; return { success: true, scoredJobs: jobs.map(job => ({ ...job, matchScore: 50, scoreStatus: 'unscored-batch' })) }; },
      };
      const result = await runBoardPreferenceOverrideStage([source], options);
      assert.equal(reapplied, 1);
      assert.equal(result.counts.unscored, 1);
      assert.equal(result.jobArrays[0][0].scoreStatus, 'unscored-batch', 'a failed score is shown as unavailable, not invented');
      await runBoardPreferenceOverrideStage([source], { ...options, override: persisted.at(-1) });
      assert.equal(scoreCalls, 2);
    },
  },
  {
    name: 'Board preferences stage: a job in two Searches on one career record is checked and scored once',
    run: async () => {
      const rule = item('r1', 'Exclude internal tools', 'role');
      const accepted = { status: 'accepted', matches: [{ preferenceId: 'r1', criterion: rule.criterion, category: 'role', strict: true, outcome: 'confirmed' }] };
      const shared = listing('Shared job');
      const asked = []; const scored = [];
      const options = { override: { ...applyJobBoardPreferenceBrief({}, 'New brief'), plan: plan([rule]) }, nodeId: 'board', manualAiRunId: 'run',
        interpret: async () => { throw new Error('the plan is known'); }, reapply: async () => { throw new Error('nothing is stored'); },
        evaluate: async ({ jobs }) => { asked.push(...jobs.map(job => job.title)); return { success: true, candidatePool: jobs.map(job => ({ ...job, preferenceAssessment: accepted })) }; },
        score: async ({ jobs }) => { scored.push(...jobs.map(job => job.title)); return { success: true, scoredJobs: jobs.map(job => ({ ...job, matchScore: 80 })) }; } };
      const search = id => ({ id, careerSnapshotId: SNAPSHOT, jobPreferences: 'Old', scoredJobs: [], preferenceCandidatePool: [shared] });
      const both = await runBoardPreferenceOverrideStage([search('a'), search('b')], options);
      assert.deepEqual(asked, ['Shared job']);
      assert.deepEqual(scored, ['Shared job']);
      assert.equal(both.jobArrays[1][0].matchScore, 80, 'the second Search shows the same score');
      const scoredSibling = { ...search('a'), scoredJobs: [{ ...shared, matchScore: 91, careerSnapshotId: SNAPSHOT }] };
      scored.length = 0;
      await runBoardPreferenceOverrideStage([search('b'), scoredSibling], options);
      assert.deepEqual(scored, [], 'a score another Search already holds is reused');
      scored.length = 0;
      await runBoardPreferenceOverrideStage([search('a'), { ...search('b'), careerSnapshotId: OTHER_SNAPSHOT }], options);
      assert.deepEqual(scored, ['Shared job', 'Shared job'], 'a different career record needs its own score');
    },
  },
  {
    name: 'Board preferences panel and empty paths: clearing needs no saved jobs, and a late application card stays',
    run: () => {
      const panel = fs.readFileSync(new URL('../../src/nodes/jobboard/JobBoardPreferenceOverridePanel.jsx', import.meta.url), 'utf8');
      assert.match(panel, /trimmed \? !hasSavedJobs : view\?\.state === 'empty'/);
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      const emptyCommit = board.slice(board.indexOf("if (candidateCountBeforeDismissal > 0 || preferenceOverrideAtCombine)"), board.indexOf('markBoardPreferencesCombined();\n          autoResumedManualAiRunRef'));
      assert.match(emptyCommit, /getNode\(id\)\?\.data\?\.locked/);
      assert.match(emptyCommit, /clearBoardChildren\(\{ preserveNodeIds: liveApplicationCardIds \}\)/);
      const clear = board.slice(board.indexOf('const handlePreferenceOverrideClear'), board.indexOf('const careerOverrideView ='));
      assert.doesNotMatch(clear, /requestEmptyReplacement/);
      assert.match(clear, /clearBoardChildren\(\{ preserveNodeIds: applicationCardIds \}\)/);
    },
  },
  {
    name: 'Job Search and Board wiring: a connected brief is read-only and copyable, and an all-removed Board keeps application cards',
    run: () => {
      const done = fs.readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      assert.match(done, /readOnly=\{managedByJobBoard\}/);
      assert.match(done, /<CopyBriefButton brief=\{jobPreferences\} \/>/);
      const search = fs.readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert.match(search, /<CopyBriefButton brief=\{jobPreferences\} \/>/);
      assert.match(search, /onReanalyze=\{boardRecoveryOwnsActions/);
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert.match(board, /if \(union\.length > 0 \|\| protectedBoardCards\.length > 0\)/);
      const panel = fs.readFileSync(new URL('../../src/nodes/jobboard/JobBoardPreferenceOverridePanel.jsx', import.meta.url), 'utf8');
      assert.match(panel, /if \(trimmed\) onApply\?\.\(trimmed\); else onClear\?\.\(\)/);
      assert.doesNotMatch(panel, /TwoStepConfirmButton/);
    },
  },
  {
    name: 'deferred company research keeps a job whose company rule was settled',
    run: async () => {
      const job = { ...listing('Product Engineer'), preferenceAssessment: { status: 'accepted', companyResearchPending: true, matches: [{ preferenceId: 'r8', criterion: 'Exclude government employers', category: 'company', strict: true, outcome: 'confirmed', source: 'web' }] } };
      const settled = await researchDeferredJobPreferences({ jobs: [job], callRaw: async () => { throw new Error('nothing is pending'); }, callText: async () => { throw new Error('nothing is pending'); } });
      assert.equal(settled.filtered, 0);
    },
  },
];
