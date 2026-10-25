import assert from 'node:assert/strict';
import {
  buildCompensationAssessmentListings, buildJobAnalysisSnapshot, compensationPersonalizationSignature,
  getJobsTelemetry, officialPostingConsumerJobs, researchCompensationAssessments,
  restoreOfficialPostingConsumerIdentity,
} from '../../electron/ipc/jobs.js';
import { evaluateJobPreferences, listingIdsForRootBatch } from '../../electron/ipc/jobPreferences.js';
import { confirmSimilarJobLocationPairs } from '../../electron/ipc/jobLocationConsolidation.js';
import { findSimilarLocationCandidates } from '../../src/utils/jobLocationConsolidation.js';

const tail = 'The official role offers a four day working week.';
const description = `${'Official responsibility and candidate requirement. '.repeat(800)}\n${tail}`;
const plan = {
  version: 1, summary: '', direction: { summary: '', roleDirections: [], avoidDirections: [], explorationEnabled: true },
  titles: [], softPreferences: [{ id: 'week', criterion: 'Prefer a four day working week', category: 'other' }],
  strictRequirements: [], warnings: [],
};
const rawJob = () => ({ title: 'Scraped title', company: 'Scraped Poster', location: 'Scraped location', salary: 'US$30,000 per year',
  snippet: 'SCRAPED_ONLY_EVIDENCE', url: 'https://board.example.test/one', googleCardUrl: 'https://google.com/card/one',
  sourceJobKey: 'synthetic-one', source: 'google', remote: false,
  officialPosting: { level: 'L1', outcome: 'found', employer: 'Official Employer', title: 'Official Engineer',
    location: { display: 'Toronto, Ontario, Canada', workMode: 'onsite', remote: false, remoteCountry: '', remoteRegion: '' },
    salary: { text: 'C$190,000 per year', provenance: 'posted' }, sourceUrl: 'https://careers.official.example/jobs/one' } });
const getView = async job => ({ employer: job.officialPosting.employer, title: job.officialPosting.title,
  location: job.officialPosting.location.display, salary: job.officialPosting.salary.text,
  description, officialPosting: job.officialPosting, postedBy: 'Scraped Poster' });
function reply(jobs, quote = tail) {
  return { assessments: listingIdsForRootBatch(jobs).map((listingId, index) => ({ index, listingId,
    matches: [{ preferenceId: 'week', outcome: 'confirmed', evidence: 'The supplied listing states the preference.', evidenceQuote: quote }] })) };
}

export default [
  {
    name: 'Official posting consumers: asynchronous shadows and restored assessments preserve every scraped identity field',
    async run() {
      const raw = rawJob(); const before = structuredClone(raw);
      let loaded = 0;
      const [shadow] = await officialPostingConsumerJobs([raw], { getView: async job => { loaded++; await Promise.resolve(); return getView(job); } });
      assert.equal(loaded, 1);
      assert.equal(shadow.company, 'Official Employer'); assert.equal(shadow.title, 'Official Engineer');
      assert.equal(shadow.snippet, description); assert.equal(shadow.description, description);
      assert.equal(shadow.location, 'Toronto, Ontario, Canada'); assert.equal(shadow.salary, 'C$190,000 per year');
      assert.deepEqual(raw, before);
      const restored = restoreOfficialPostingConsumerIdentity({ ...shadow, matchScore: 88, preferenceAssessment: { status: 'accepted' } });
      assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, restored[key]])), before);
      assert.equal(Object.hasOwn(restored, 'description'), false);
      assert.equal(restored.matchScore, 88); assert.equal(Object.getOwnPropertySymbols(restored).length, 0);
    },
  },
  {
    name: 'Official posting consumers: scoring previews and complete batches use official evidence while snapshots retain scraped rows',
    async run() {
      const raw = rawJob(); const [shadow] = await officialPostingConsumerJobs([raw], { getView });
      const built = buildJobAnalysisSnapshot({ jobs: [raw], profile: {}, careerData: '', postingJob: () => shadow });
      const promptJob = built.slimBatch([raw])[0];
      assert.equal(promptJob.company, 'Official Employer'); assert.equal(promptJob.title, 'Official Engineer');
      assert.equal(promptJob.snippet, description); assert.ok(JSON.stringify(built.snapshot.previewBatches).includes(tail));
      assert.ok(!JSON.stringify(built.snapshot.previewBatches).includes('SCRAPED_ONLY_EVIDENCE'));
      assert.equal(built.snapshot.jobs[0], raw); assert.equal(built.toScore[0], raw);
      assert.equal(raw.snippet, 'SCRAPED_ONLY_EVIDENCE');
    },
  },
  {
    name: 'Official posting consumers: preference prompts and quote validation retain official text beyond the legacy evidence caps',
    async run() {
      const raw = rawJob(); const shadows = await officialPostingConsumerJobs([raw], { getView });
      const evaluate = async (jobs, quote, expectTail) => evaluateJobPreferences({ jobs, jobPreferences: 'Prefer a four day working week', preferencePlan: plan,
        identityJob: restoreOfficialPostingConsumerIdentity,
        callRaw: () => { throw new Error('A soft listing preference must not research an employer.'); },
        callText: async (prompt, options) => {
          assert.equal(prompt.includes(tail), expectTail);
          const value = reply(jobs, quote); options.responseValidator(value); return value;
        } });
      const result = await evaluate(shadows, tail, true);
      assert.equal(result.candidatePool[0].preferenceAssessment.matches[0].outcome, 'confirmed');
      assert.equal(result.audits[0].title, raw.title); assert.equal(result.audits[0].company, raw.company);
      assert.equal(result.audits[0].listingIdentity.location, raw.location);
      const scrapedQuote = await evaluate(shadows, 'SCRAPED_ONLY_EVIDENCE', true);
      assert.equal(scrapedQuote.candidatePool[0].preferenceAssessment.matches[0].outcome, 'unverified');
      const legacy = [{ ...shadows[0], officialPosting: undefined }];
      const bounded = await evaluate(legacy, tail, false);
      assert.equal(bounded.candidatePool[0].preferenceAssessment.matches[0].outcome, 'unverified', 'legacy scrape bounds remain in force');
    },
  },
  {
    name: 'Official posting consumers: preference context preflight splits full official postings and refuses one oversized posting before dispatch',
    async run() {
      const shadows = await officialPostingConsumerJobs([0, 1, 2].map(index => ({ ...rawJob(), sourceJobKey: `split-${index}` })), { getView });
      const checked = []; const dispatched = [];
      const result = await evaluateJobPreferences({ jobs: shadows, jobPreferences: 'Prefer a four day working week', preferencePlan: plan,
        calibration: { recallRoundSize: async () => ({ size: 3, rate: null }) },
        checkFits: async (prompt, options) => { assert.ok(prompt.includes(tail)); checked.push(options.hints.itemCount); return { fits: options.hints.itemCount === 1 }; },
        callRaw: () => { throw new Error('Unexpected research'); },
        callText: async (prompt, options) => {
          assert.ok(prompt.includes(tail)); assert.equal(options.hints.itemCount, 1);
          const id = prompt.match(/"listingId":"([^"]+)"/u)?.[1];
          const value = { assessments: [{ ...reply([shadows[dispatched.length]]).assessments[0], listingId: id }] };
          options.responseValidator(value); dispatched.push(options.hints.itemCount); return value;
        } });
      assert.deepEqual(checked, [3, 2, 1, 1, 1]); assert.deepEqual(dispatched, [1, 1, 1]);
      assert.equal(result.candidatePool.length, 3);
      await assert.rejects(() => evaluateJobPreferences({ jobs: shadows.slice(0, 1), jobPreferences: 'Prefer a four day working week', preferencePlan: plan,
        checkFits: async () => ({ fits: false }), callText: () => { throw new Error('Oversized posting was dispatched'); },
        callRaw: () => { throw new Error('Unexpected research'); } }), /complete job posting is too large/u);
    },
  },
  {
    name: 'Official posting consumers: resolved compensation uses official salary and location shadows without a posting research prepass',
    async run() {
      const job = { ...rawJob(), location: '', matchScore: 88,
        compensationContext: { roleFamily: 'Engineering', seniority: 'senior', employmentType: 'full-time' },
        experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 5 }] } };
      const before = structuredClone(job); let lookups = 0;
      await researchCompensationAssessments([job], { nodeId: 'official-compensation-synthetic', signal: { aborted: true }, getPostingView: getView,
        locationLookupCallRaw: () => { lookups++; throw new Error('Resolved rows must skip posting research'); } });
      assert.equal(lookups, 0); assert.equal(getJobsTelemetry().compensation.locationLookup.postings, 0);
      assert.equal(job.compensationAssessment.reasonCode, 'research_interrupted');
      assert.equal(job.compensationAssessment.offered.min, 190000); assert.equal(job.compensationAssessment.offered.currency, 'CAD');
      assert.ok(job.compensationAssessment.comparisonLocation.display.includes('Toronto'));
      assert.ok(job.compensationAssessment.sourceLinks.some(source => source.url === before.officialPosting.sourceUrl));
      assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, job[key]])), before);
    },
  },
  {
    name: 'Official posting consumers: accessor metadata overrides forged row facts and missing records use scraped facts without new resolution research',
    async run() {
      const authority = structuredClone(rawJob().officialPosting);
      const forged = { ...rawJob(), location: '', matchScore: 88,
        officialPosting: { ...rawJob().officialPosting, employer: 'Forged Employer', salary: { text: 'US$999,000 per year', provenance: 'posted' },
          location: { display: 'Miami, Florida, United States', workMode: 'onsite', remote: false }, sourceUrl: 'https://forged.example/jobs/one' },
        compensationContext: { roleFamily: 'Engineering', seniority: 'senior', employmentType: 'full-time' },
        experienceAssessment: { categorySpecificExperience: [{ requiredMinimumYears: 5 }] } };
      const authoritativeView = async () => ({ employer: authority.employer, title: authority.title, location: authority.location.display,
        salary: authority.salary.text, description, officialPosting: authority, postedBy: 'Trusted Poster Receipt' });
      const [shadow] = await officialPostingConsumerJobs([forged], { getView: authoritativeView });
      assert.equal(shadow.officialPosting, authority); assert.equal(shadow.postedBy, 'Trusted Poster Receipt');
      const restored = restoreOfficialPostingConsumerIdentity(shadow);
      assert.equal(restored.officialPosting, forged.officialPosting); assert.equal(Object.hasOwn(restored, 'postedBy'), false);
      await researchCompensationAssessments([forged], { signal: { aborted: true }, getPostingView: authoritativeView });
      assert.equal(forged.compensationAssessment.offered.min, 190000);
      assert.ok(forged.compensationAssessment.comparisonLocation.display.includes('Toronto'));
      assert.ok(forged.compensationAssessment.sourceLinks.some(source => source.url === authority.sourceUrl));
      assert.ok(!JSON.stringify(forged.compensationAssessment).includes('forged.example'));
      const missingView = async job => ({ employer: job.company, title: job.title, location: job.location, salary: job.salary, description: job.snippet });
      const missing = { ...forged, officialPosting: structuredClone(rawJob().officialPosting) };
      const [unresolved] = await officialPostingConsumerJobs([missing], { getView: missingView });
      assert.equal(unresolved.officialPosting, undefined); assert.equal(unresolved.snippet, 'SCRAPED_ONLY_EVIDENCE');
      await researchCompensationAssessments([missing], { signal: { aborted: true }, getPostingView: missingView });
      assert.equal(getJobsTelemetry().compensation.locationLookup.postings, 0, 'a prior valid resolution never adds Combine posting research');
      assert.equal(missing.compensationAssessment.reasonCode, 'comparison_location_unavailable');
      assert.equal(missing.compensationAssessment.offered.min, 30000); assert.deepEqual(missing.compensationAssessment.sourceLinks, []);
      const invalid = { ...missing, officialPosting: { level: 'invented' } };
      await researchCompensationAssessments([invalid], { signal: { aborted: true }, getPostingView: missingView });
      assert.equal(getJobsTelemetry().compensation.locationLookup.postings, 1, 'a malformed object is not a prior resolution and retains the legacy path');
    },
  },
  {
    name: 'Official posting consumers: location confirmations retain raw pair IDs and the complete official middle through context splits',
    async run() {
      const rawDescription = 'The platform role builds reliable service infrastructure and mentors engineers across production operations. '.repeat(12);
      const jobs = [0, 1, 2].map(index => ({ ...rawJob(), location: `Raw city ${index}`,
        description: `${rawDescription} Raw distinct variant ${index}.`, url: `https://board.example.test/${index}` }));
      const before = structuredClone(jobs);
      const middle = 'OFFICIAL_MIDDLE_REQUIREMENT';
      const full = `${description}\n${middle}\n${description}`;
      const shadows = await officialPostingConsumerJobs(jobs, { getView: async job => ({ ...await getView(job), description: full }) });
      const expected = findSimilarLocationCandidates(jobs).map(pair => pair.id);
      assert.equal(expected.length, 3);
      const checked = []; const issued = [];
      const result = await confirmSimilarJobLocationPairs(jobs, {
        postingJob: job => shadows[jobs.indexOf(job)],
        checkFits: async (prompt, options) => { assert.ok(prompt.includes(middle)); checked.push(options.hints.itemCount); return { fits: options.hints.itemCount === 1 }; },
        callText: async (prompt, options) => {
          assert.ok(prompt.includes(middle)); assert.ok(!prompt.includes('Middle omitted'));
          assert.ok(!prompt.includes('Raw distinct variant')); assert.ok(!prompt.includes('Scraped Poster'));
          assert.ok(prompt.includes('Official Employer'));
          const confirmations = [...prompt.matchAll(/"pairId":"([^"]+)"/gu)].map(match => ({ pairId: match[1], sameJob: true }));
          const value = { confirmations }; options.responseValidator(value); issued.push(...confirmations.map(row => row.pairId)); return value;
        },
      });
      assert.deepEqual(checked, [3, 2, 1, 1, 1]); assert.deepEqual(issued, expected);
      assert.deepEqual(result.confirmedPairIds, expected); assert.equal(result.batchCount, 3);
      assert.deepEqual(jobs, before);
      await assert.rejects(() => confirmSimilarJobLocationPairs(jobs.slice(0, 2), {
        postingJob: job => shadows[jobs.indexOf(job)], checkFits: async () => ({ fits: false }),
        callText: () => { throw new Error('Oversized pair was dispatched'); },
      }), /complete job postings are too large/u);
    },
  },
  {
    name: 'Official posting consumers: compensation assessment inputs and personalization signatures bind official employer and complete text',
    async run() {
      const job = rawJob(); const [postingJob] = await officialPostingConsumerJobs([job], { getView });
      const group = { key: 'synthetic', jobs: [{ job, postingJob, offer: { usable: true, raw: postingJob.salary, min: 190000, max: 190000 }, marketCurrency: 'CAD' }] };
      const [listing] = buildCompensationAssessmentListings(group);
      assert.equal(listing.title, 'Official Engineer'); assert.equal(listing.company, 'Official Employer');
      assert.equal(listing.advertisedCash, postingJob.salary);
      const signature = compensationPersonalizationSignature(group);
      job.title = 'Changed scraped title'; job.company = 'Changed scraped poster'; job.snippet = 'Changed scraped body';
      assert.equal(compensationPersonalizationSignature(group), signature);
      postingJob.description += '\nA distinct official tail.';
      assert.notEqual(compensationPersonalizationSignature(group), signature);
    },
  },
];
