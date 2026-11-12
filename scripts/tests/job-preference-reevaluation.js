// A strict role requirement removes a job only on a conflict, and re-checking
// saved jobs keeps every score still current. Synthetic fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withTimeout } from './fixtures/practice-connector/harness.js';
import { buildJobBoardDiagnostics } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import { COMPANY_RESEARCH_VERSION, evaluateJobPreferences, reapplyStoredJobPreferences, researchDeferredJobPreferences } from '../../electron/ipc/jobPreferences.js';
import { hasStoredPreferenceVerdicts, mergeScoredJobs, splitKeptScores } from '../../src/utils/jobSearchPreferenceReevaluation.js';
import { savedJobsReevaluationKeepsScores } from '../../src/utils/jobSearchSplitClear.js';
import { carryBoardRescores } from '../../src/nodes/jobboard/jobBoardResearchStage.js';
import { __resetJobRunStatusForTests, getJobRunStatus, pauseOwnerStatus, publishJobRunStatus, showsOwnPauseButton, subscribeJobRunStatuses } from '../../src/utils/jobRunStatusStore.js';
import { unverifiedCompanyPreferences } from '../../electron/ipc/researchGate.js';
import { runBoardPreferenceOverrideStage } from '../../src/nodes/jobboard/jobBoardPreferenceOverrideStage.js';
import { activeJobBoardPreferenceOverride, applyJobBoardPreferenceBrief, jobBoardPreferenceOverrideView } from '../../src/utils/jobBoardPreferenceOverride.js';

const SNAPSHOT = 'a'.repeat(64);
const OTHER_SNAPSHOT = 'b'.repeat(64);
const item = (id, criterion, category) => ({ id, criterion, category });
const plan = strictRequirements => ({ version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: false }, softPreferences: [], strictRequirements, warnings: [], settingConflicts: [], titles: [] });
const verdict = (preferenceId, outcome, evidenceQuote = '') => ({ preferenceId, outcome, evidence: 'Fixture evidence.', evidenceQuote });
// The raw research prompt embeds the request list as JSON inside its untrusted
// wrapper; read it back so the assertion is about the data the model receives.
function embeddedRequestList(prompt) {
  const start = prompt.indexOf('[{"researchId"');
  assert.ok(start >= 0, 'the prompt embeds the research request list');
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(prompt.slice(start, index + 1));
    }
  }
  throw new Error('the embedded research request list is unterminated');
}
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
      const card = (criterion, version = COMPANY_RESEARCH_VERSION) => ({ type: 'jobcard', data: { ...listing('Saved'), url, preferenceAssessment: { ...assessment(criterion, false), ...(version === null ? {} : { companyResearchVersion: version }) } } });
      const job = { ...listing('Saved'), url, preferenceAssessment: assessment('No staffing agencies', true) };
      const carried = candidate => carryBoardRescores([job], [candidate])[0].preferenceAssessment;
      assert.equal(carried(card('No staffing agencies')).companyResearchPending, undefined, 'the same rule keeps its finished research');
      assert.equal(carried(card('No government employers')).companyResearchPending, true, 'a new rule stays pending');
      assert.equal(carried(card('No staffing agencies', null)).companyResearchPending, true, 'research from before the research version is asked again');
      assert.equal(carried(card('No staffing agencies', 1)).companyResearchPending, true, 'version 1 research is asked again before it can confirm a rule');
    },
  },
  {
    name: 'company research: the request carries the posting identities and research must identify the poster first',
    run: async () => {
      const criterion = 'Exclude agencies, consultancies, and outsourcing firms';
      const description = 'Technology-led solutions. '.repeat(40);
      const posting = n => ({
        ...listing(`Saskatoon Engineer ${n}`, description),
        company: 'Stelvio Inc.',
        location: `Saskatoon, SK ${n}`,
        url: `https://stelvio.example.test/postings/${n}`,
        preferenceAssessment: { status: 'accepted', companyResearchPending: true, matches: [{ preferenceId: 'r8', criterion, category: 'company', strict: true, outcome: 'unverified' }] },
      });
      const rawPrompts = [];
      const assessmentPrompts = [];
      const researchQuote = 'Stelvio Inc. is a technology recruitment firm that hires for unnamed clients.';
      const settled = await researchDeferredJobPreferences({
        jobs: [1, 2, 3, 4].map(posting),
        callRaw: async prompt => {
          rawPrompts.push(prompt);
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/gu) || [])];
          return ids.map(id => `BEGIN RESEARCH ${id}\n${researchQuote} https://stelvio.example.test/about\nEND RESEARCH ${id}`).join('\n');
        },
        callText: async prompt => {
          assessmentPrompts.push(prompt);
          const ids = [...new Set(prompt.match(/research-[a-f0-9]{20}/gu) || [])];
          return { assessments: ids.map(researchId => ({ researchId, preferenceId: 'r8', outcome: 'conflicts', evidence: 'Recruiter posting.', evidenceQuote: researchQuote, sourceUrls: ['https://stelvio.example.test/about'], sourceDate: '' })) };
        },
      });
      assert.equal(rawPrompts.length, 1, 'one grouped request covers every Stelvio posting');
      const requests = embeddedRequestList(rawPrompts[0]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].postings.length, 3, 'at most three posting identities travel with the request');
      assert.deepEqual(requests[0].postings[0], {
        title: 'Saskatoon Engineer 1',
        location: 'Saskatoon, SK 1',
        listingUrl: 'https://stelvio.example.test/postings/1',
        excerpt: description.slice(0, 300),
      });
      assert.equal(requests[0].postings[0].excerpt.length, 300, 'the excerpt stops at 300 characters');
      assert.ok(rawPrompts[0].includes('FIRST identify the organization that actually posted these jobs'), 'the research identifies the poster before answering');
      assert.ok(rawPrompts[0].includes('A name match alone is not identification'), 'a name match alone is not identification');
      assert.ok(rawPrompts[0].includes('IDENTITY UNCERTAIN'), 'the research knows how to report an unidentifiable poster');
      assert.ok(rawPrompts[0].includes('Do not put one employer\'s evidence, URL, or facts in another employer\'s section.'), 'the per-employer isolation sentence survives');
      assert.ok(assessmentPrompts[0].includes('A section that says IDENTITY UNCERTAIN, or that identifies an organization other than the one that posted these jobs, can never yield confirmed'), 'the assessment forbids confirming another organization');
      assert.ok(assessmentPrompts[0].includes('an agency, staffing, intermediary or outsourcing requirement is conflicts'), 'an established intermediary conflicts with an agency rule');
      assert.equal(settled.filtered, 4, 'the researched agency conflict removes every Stelvio posting');
      assert.equal(settled.jobs[0].preferenceAssessment.status, 'filtered');
      assert.equal(settled.jobs[0].preferenceAssessment.companyResearchVersion, COMPANY_RESEARCH_VERSION, 'web research stamps the research version on its assessment');
      const replayed = reapplyStoredJobPreferences({ jobs: [{ ...listing('Saved'), preferenceAssessment: { matches: [{ preferenceId: 'r1', criterion: 'Exclude agencies', category: 'company', strict: true, outcome: 'confirmed', source: 'listing' }] } }], preferencePlan: plan([item('r1', 'Exclude agencies', 'company')]) });
      assert.equal(replayed.candidatePool[0].preferenceAssessment.companyResearchVersion, undefined, 'a listing-only answer owes no research version');
    },
  },
  {
    name: 'listing prompt: a generic unnamed employer is an intermediary posting',
    run: async () => {
      const prompts = [];
      await evaluateJobPreferences({
        jobs: [listing('Backend Engineer')],
        jobPreferences: 'Fixture brief.',
        preferencePlan: plan([item('r1', 'Exclude agencies', 'company')]),
        deferCompanyResearch: true,
        callRaw: () => { throw new Error('this fixture needs no web research'); },
        callText: async prompt => {
          prompts.push(prompt);
          return { assessments: [{ index: 0, matches: [verdict('r1', 'unverified')] }] };
        },
      });
      const listingPrompt = prompts.find(prompt => prompt.includes('Second, intermediaries:'));
      assert.ok(listingPrompt, 'the listing pass runs');
      assert.ok(listingPrompt.includes('a listing that does not name the employer it hires for and describes it only generically, for example as "a business", "our client" or "an established company", is an intermediary posting'), 'the unnamed-employer rule is left to the wording, with no keyword list');
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
      assert.deepEqual(result.counts, { checked: 3, passed: 2, removed: 1, checkedRows: 3, removedRows: 1, newlyScored: 1, keptScores: 1, reused: 0, unscored: 0 });
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
      assert.deepEqual([both.counts.checked, both.counts.passed, both.counts.removed, both.counts.checkedRows, both.counts.removedRows],
        [1, 1, 0, 2, 0], 'one shared listing is one job; rows stay per Search so they balance against the merge');
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
    name: 'Pause & save: one button per run, and the handoff row pauses the whole Board run',
    run: () => {
      const pause = () => ({ success: true });
      const board = { nodeId: 'board', onPause: pause, pauseKeys: ['node:board', 'node:ca', 'node:us'] };
      const canada = { nodeId: 'ca', onPause: pause, pauseKeys: ['node:ca'] };
      const alone = { nodeId: 'solo', onPause: pause, pauseKeys: ['node:solo'] };
      const all = [board, canada, alone];
      assert.equal(pauseOwnerStatus('ca', all), board);
      assert.equal(pauseOwnerStatus('solo', all), alone);
      assert.equal(pauseOwnerStatus('missing', all), null);
      const shown = handoff => all.filter(entry => showsOwnPauseButton(entry, handoff, all)).map(entry => entry.nodeId);
      assert.deepEqual(shown('ca'), ['solo'], 'the handoff row owns the Board run, and its searches show none');
      assert.deepEqual(shown('board'), ['solo']);
      assert.deepEqual(shown(null), ['board', 'solo'], 'with no handoff, the Board card holds the run button');
      const combining = [{ ...board, onPause: null }, canada];
      assert.equal(pauseOwnerStatus('ca', combining), canada, 'a Board with no pause does not cover its search');
      const dialog = fs.readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert.match(dialog, /onSave=\{pauseOwnerStatus\(activeRequest\.nodeId\)\?\.onPause/);
      assert.match(fs.readFileSync(new URL('../../src/components/ClaudeRunStatus.jsx', import.meta.url), 'utf8'), /showPause=\{showsOwnPauseButton\(entry, pauseOwnedBy, statuses\)\}/);
    },
  },
  {
    name: 'Run status entries keep their live Claude request and a pause with no save step',
    run: () => {
      __resetJobRunStatusForTests();
      try {
        publishJobRunStatus('interview', { label: 'Interview Helper' });
        const defaults = getJobRunStatus('interview');
        assert.equal(defaults.claudeRequestId, null, 'no live request by default');
        assert.equal(defaults.pauseWithoutSave, false, 'a saved pause by default');
        const renders = [];
        const unsubscribe = subscribeJobRunStatuses(() => renders.push(getJobRunStatus('interview').claudeRequestId));
        publishJobRunStatus('interview', { label: 'Interview Helper', headline: 'Preparing interview brief', claudeRequestId: 'node:interview:prep', pauseKeys: ['node:interview:prep'], pauseWithoutSave: true });
        assert.equal(getJobRunStatus('interview').claudeRequestId, 'node:interview:prep');
        assert.equal(getJobRunStatus('interview').pauseWithoutSave, true);
        assert.deepEqual(renders, ['node:interview:prep'], 'a new request id re-renders the panel');
        publishJobRunStatus('interview', { label: 'Interview Helper', headline: 'Preparing interview brief', claudeRequestId: 'node:interview:prep', pauseKeys: ['node:interview:prep'], pauseWithoutSave: false });
        assert.equal(getJobRunStatus('interview').claudeRequestId, 'node:interview:prep', 'the request survives a plain re-publish');
        assert.deepEqual(renders, ['node:interview:prep', 'node:interview:prep'], 'flipping pauseWithoutSave alone also re-renders');
        publishJobRunStatus('interview', { label: 'Interview Helper', headline: 'Preparing interview brief', claudeRequestId: 'node:interview:prep', pauseKeys: ['node:interview:prep'], pauseWithoutSave: false });
        assert.equal(renders.length, 2, 'an unchanged entry does not re-render');
        unsubscribe();
      } finally { __resetJobRunStatusForTests(); }
    },
  },
  {
    name: 'Pause ownership: a run that pauses without saving still holds its own button',
    run: () => {
      const board = { nodeId: 'board', onPause: () => {}, pauseKeys: ['node:board'] };
      const interview = { nodeId: 'interview', onPause: null, pauseWithoutSave: true, pauseKeys: ['node:interview'] };
      const idle = { nodeId: 'idle', onPause: null, pauseKeys: ['node:idle'] };
      const all = [board, interview, idle];
      assert.equal(pauseOwnerStatus('interview', all), interview);
      assert.equal(showsOwnPauseButton(interview, null, all), true, 'with no handoff the run shows its own Pause button');
      assert.equal(showsOwnPauseButton(interview, 'board', all), true, 'nothing hands this run to another row');
      assert.equal(showsOwnPauseButton(idle, null, all), false, 'neither an onPause nor pauseWithoutSave means no button');
      const silentBoard = [{ nodeId: 'board', onPause: null, pauseWithoutSave: true, pauseKeys: ['node:board', 'node:interview'] }, interview];
      assert.equal(pauseOwnerStatus('interview', silentBoard), silentBoard[0], 'a Board that pauses without saving covers the module it runs');
    },
  },
  {
    name: 'Interview Helper: the live Claude status lives in the Modules running panel, not the node',
    run: () => {
      const node = fs.readFileSync(new URL('../../src/nodes/InterviewHelperNode.jsx', import.meta.url), 'utf8');
      assert.doesNotMatch(node, /ClaudeTaskProgress/);
      assert.doesNotMatch(node, /ClaudePauseControl/);
      assert.match(node, /usePublishJobRunStatus\(id, locallyPreparing \? \{ label: 'Interview Helper', headline: 'Preparing interview brief', claudeRequestId: claudeInterviewPauseKey\(data\.interviewHelperPreparationRunId\), pauseKeys: \[claudeInterviewPauseKey\(data\.interviewHelperPreparationRunId\)\], pauseWithoutSave: true \} : null\);/);
      assert.match(node, /locallyPreparing \? 'Preparing…'/);
      const card = fs.readFileSync(new URL('../../src/components/ClaudeRunStatus.jsx', import.meta.url), 'utf8');
      assert.match(card, /if \(entry\.claudeRequestId\) \{\n {4}return <ClaudeTaskProgress requestId=\{entry\.claudeRequestId\} contextPrefix=\{entry\.label\} region=\{`\$\{entry\.label\} status`\} footer=\{pauseFooter\} \/>;/);
      assert.match(card, /onSave=\{entry\.pauseWithoutSave && !entry\.onPause \? null :/);
    },
  },
  {
    name: 'Board status panel: a saved run waiting for Continue is not listed as running',
    run: () => {
      const board = fs.readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert.match(board, /const boardWorkRunning = boardRunVisible && !savedRunAwaitsContinue;/);
      assert.match(board, /const savedRunAwaitsContinue = !scanning && !combining && \(!!recoveryError/);
      assert.match(board, /marker\?\.pausedByUser === true \|\| marker\?\.autoResumeEligible === false/);
      assert.match(board, /usePublishJobRunStatus\(id, boardWorkRunning \?/);
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
    name: 'Board preferences box: stays empty until the person types in it, and only Apply to Board applies it',
    async run() {
      const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ic-board-preferences-'));
      const entry = path.join(directory, 'PanelProbe.jsx');
      await fsPromises.writeFile(entry, `export { JobBoardPreferenceOverridePanel } from ${JSON.stringify(path.resolve('src/nodes/jobboard/JobBoardPreferenceOverridePanel.jsx'))};\n`);
      const controller = new AbortController();
      let bundle;
      try {
        await withDom(async window => {
          // React decides at load whether input events work, so load it with the DOM in place.
          bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 8000);
          const { React, act, createRoot, JobBoardPreferenceOverridePanel: Panel } = bundle.module;
          const applied = [];
          const props = { hasSavedJobs: true, onApply: brief => applied.push(brief), onClear: () => {} };
          const rootNode = createRoot(window.document.getElementById('root'));
          const render = view => act(async () => { rootNode.render(React.createElement(Panel, { ...props, view })); await Promise.resolve(); });
          const box = () => window.document.querySelector('textarea');
          const button = label => [...window.document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
          const click = label => act(async () => { button(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
          try {
            await render(jobBoardPreferenceOverrideView({}));
            assert.equal(box().value, '', 'a Search brief must not fill the box by itself');
            assert.match(box().placeholder, /own rules are in use/);
            assert.equal(button('Apply to Board').disabled, true, 'an empty box has nothing to apply');
            assert.doesNotMatch(window.document.body.textContent, /Not applied yet/);
            assert.equal(window.document.querySelectorAll('button').length, 1, 'Apply to Board is the only action, so nothing can overwrite the box');

            await act(async () => {
              Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(box(), 'Remote only');
              box().dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Remote only' }));
            });
            assert.equal(applied.length, 0, 'typing applies nothing');
            assert.match(window.document.body.textContent, /Not applied yet.*own rules/);
            await click('Apply to Board');
            assert.deepEqual(applied, ['Remote only']);

            await render({ state: 'applied', brief: 'No agencies', counts: null });
            assert.equal(box().value, 'No agencies', 'applied preferences show as applied');
            assert.doesNotMatch(window.document.body.textContent, /Not applied yet/);
          } finally { await act(async () => rootNode.unmount()); }
        });
      } finally {
        controller.abort();
        await bundle?.dispose();
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Board preferences in the bug report: states which rules are in use and withholds the brief',
    run() {
      const report = override => buildJobBoardDiagnostics([{ id: 'board', type: 'jobboard', data: { hubState: 'done', jobBoardPreferenceOverride: override } }], []);
      assert.match(report(undefined), /Board preferences: none applied \(each search's own rules are in use\)\./);
      const applied = report({ version: 1, brief: 'Secret brief', combinedAt: 5, counts: { checked: 10, passed: 7, removed: 3 } });
      assert.match(applied, /Board preferences: applied · brief-chars=12 · checked=10 · passed=7 · removed=3\./);
      assert.doesNotMatch(applied, /Secret brief/);
      assert.match(report({ version: 1, brief: 'Secret brief', combinedAt: null, counts: null }), /Board preferences: pending · brief-chars=12 · checked=not retained/);
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
