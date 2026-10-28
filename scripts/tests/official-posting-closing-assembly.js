import assert from 'node:assert/strict';
import { assemblePasteApplicationResult } from '../../electron/ipc/pasteApplicationAssembly.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import { renderStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { extractResumeEvidence } from '../../electron/ipc/jobApplication.js';
import { validateSharedApplicationContent } from '../../electron/ipc/applicationTruthGates.js';
import { WRITE_VERIFY_BRIEF, initialWriteVerifyState, writeVerifyPrompt, writeVerifySourcePrompt } from '../../electron/ipc/applicationWriteVerify.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, __pasteUnitGroundingErrorsForTests, __validateSharedApplicationContentForTests, writeVerifyGroundingContract } from '../../electron/ipc/localAiApplication.js';

const CAREER_QUOTE = 'Built reporting systems that reduced manual work.';
const PRIOR_TEXT = 'I built reporting systems that reduced manual work.';
const LISTING_QUOTE = 'Your reporting systems support workflows for engineering teams.';
const job = { title: 'Software Engineer', company: 'Northwind Labs', snippet: LISTING_QUOTE };
const careerData = `Ada Lovelace\nada@example.test\n## Analytical Engines\nSoftware Engineer\n\n${CAREER_QUOTE}`;
const sourceRoles = [{ id: 'role-one', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
const evidence = [
  { id: 'career-proof', sourceId: 'career-data', quote: CAREER_QUOTE },
  { id: 'listing-proof', sourceId: 'job-listing', quote: LISTING_QUOTE },
];
const prior = () => ({ id: 'letter-one', text: PRIOR_TEXT, evidenceIds: ['career-proof'] });
const closing = (text = LISTING_QUOTE) => ({ id: 'letter-two', text, evidenceIds: ['listing-proof'] });

function fixture(paragraphs = [prior(), closing()]) {
  return {
    input: { version: 1, jobId: 'closing-job', job, sourceRoles }, careerData,
    jobListing: formatOriginalJobListingMarkdown(job),
    paste: {
      trustedIdentity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: '', credential: '' },
      evidencePlan: { evidence },
      resume: { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ ...sourceRoles[0], bullets: [{ id: 'bullet-one', text: CAREER_QUOTE, evidenceIds: ['career-proof'] }] }] },
      coverLetter: { name: 'Ada Lovelace', contact: ['ada@example.test'], paragraphs,
        roleThesis: 'Reporting systems serve the work this role needs.',
        coverLetterArgument: { primaryEvidence: { evidence: CAREER_QUOTE, evidenceRole: 'Software Engineer at Analytical Engines', relationToThesis: 'The completed reporting work supports the stated argument.' } },
        generationAudit: { version: 1, finalDecisionSummary: 'Only source-supported reporting evidence was retained.',
          coverLetterPlan: { paragraphs: paragraphs.map(paragraph => ({ paragraph: paragraph.text.replace(/\s+/gu, ' ').trim() })) } } },
      finalReview: { decision: 'pass', findings: [], qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: [], resume: { decision: 'approved', rationale: 'Direct source evidence.' }, coverLetter: { decision: 'approved', rationale: 'A source-supported argument.' } } },
    },
  };
}

function draftingErrors(paragraphs, index = paragraphs.length - 1) {
  const paragraph = paragraphs[index];
  return __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: paragraph.id,
    finalText: paragraph.text, evidenceIds: paragraph.evidenceIds, acceptedEvidence: evidence, identityTokens: [],
    label: 'coverLetterParagraphs', sourceRoles, careerData, targetCompany: job.company, targetTitle: job.title,
    postingText: formatOriginalJobListingMarkdown(job), paragraphIndex: index });
}

function stageErrors(paragraphs) {
  const item = fixture(paragraphs);
  return __validateSharedApplicationContentForTests({ coverLetter: item.paste.coverLetter }, {
    stage: 'cover-letter', careerData, evidencePlan: { evidence }, trustedIdentity: item.paste.trustedIdentity,
    resume: item.paste.resume,
  }, item.input);
}

export default [
  {
    name: 'Official posting closing shared gate: a listing-only paragraph always needs career evidence and still reports its duration guard',
    run() {
      const item = fixture();
      const response = { coverLetter: { ...item.paste.coverLetter, paragraphs: [prior()] } };
      const state = { stage: 'cover-letter', evidencePlan: { evidence }, trustedIdentity: item.paste.trustedIdentity,
        resume: item.paste.resume };
      const durations = [];
      const dependencies = {
        nonemptyText: value => typeof value === 'string' && value.trim().length > 0,
        projectContactChannels: value => value,
        PASTE_COVER_PARAGRAPH_UNIT_LABEL: 'Cover-letter paragraph', MAX_COVER_LETTER_PARAGRAPH_EVIDENCE_IDS: 4,
        pasteCareerQuotesForEvidenceIds: ids => evidence.filter(row => row.sourceId === 'career-data' && ids.includes(row.id)).map(row => row.quote),
        unsupportedDurationClaimError: (_unit, _text, quotes) => { durations.push(quotes); return ''; },
        pasteCoverLetterCompletionTwinErrors: () => [],
      };
      assert.deepEqual(validateSharedApplicationContent(response, state, {}, null, dependencies), []);
      assert.deepEqual(validateSharedApplicationContent({ coverLetter: { ...response.coverLetter, paragraphs: [] } }, state, {}, null, dependencies),
        ['Cover letter needs at least one paragraph.']);
      for (const ids of [[], ['unknown-listing'], ['listing-proof', 'unknown-listing'], ['listing-proof']]) {
        const errors = validateSharedApplicationContent({ coverLetter: { ...response.coverLetter,
          paragraphs: [prior(), { ...closing(), evidenceIds: ids }] } }, state, {}, null, dependencies);
        assert.ok(errors.some(error => /needs at least one career-data evidence ID/u.test(error)), JSON.stringify(ids));
      }
      assert.deepEqual(durations.at(-1), [], 'listing-only duration still receives no career quotes');
    },
  },
  {
    name: 'Official posting closing regression: a final paragraph citing only job-listing IDs is rejected at generation with the ordinary career-citation message and no prompt offers the old exception',
    run() {
      const paragraphs = [prior(), closing()];
      assert.deepEqual(draftingErrors(paragraphs), ['Cover-letter paragraph "letter-two" needs at least one career-data evidence ID.'],
        'write-time grounding rejects the listing-only closing with the ordinary message only');
      assert.ok(stageErrors(paragraphs).includes('Cover-letter paragraph letter-two needs at least one career-data evidence ID.'),
        'the real shared stage gate rejects it with the ordinary message');
      assert.throws(() => assemblePasteApplicationResult(fixture(paragraphs)), /job-listing evidence alone cannot support candidate copy/u);
      const modern = fixture(paragraphs); modern.input.applicationProtocol = 'write-then-verify.v2';
      assert.throws(() => assemblePasteApplicationResult(modern), /job-listing evidence alone cannot support candidate copy/u);
      const mixed = [prior(), { ...closing(), evidenceIds: ['career-proof', 'listing-proof'] }];
      assert.deepEqual(draftingErrors(mixed).filter(error => /career-data evidence ID/u.test(error)), [], 'a career citation clears the rule');

      const state = initialWriteVerifyState(1); state.candidates[0].structured = fixture().paste;
      state.candidates[0].plainText = `${PRIOR_TEXT}\n\n${LISTING_QUOTE}`;
      const sourcePrompt = writeVerifySourcePrompt({ posting: formatOriginalJobListingMarkdown(job), requirements: [],
        listingEvidence: evidence.filter(row => row.sourceId === 'job-listing'), identity: {}, sourceRoles: [],
        profile: { roles: [], achievements: [], projects: [], skills: [] }, catalog: [], groundingContract: writeVerifyGroundingContract() });
      const oldRule = /Only the last paragraph may instead cite|closed intent vocabulary|Letter paragraphs otherwise need/u;
      assert.equal(oldRule.test(writeVerifyGroundingContract()), false);
      for (const stage of ['write', 'convert', 'verify-correction']) {
        const prompt = writeVerifyPrompt({ stage, state, sourcePrompt, posting: '', hand: '', envelope: {} });
        assert.equal(oldRule.test(prompt), false, stage);
        assert.ok(prompt.includes(`BRIEF: ${WRITE_VERIFY_BRIEF}`), stage);
        if (stage !== 'write') assert.ok(prompt.includes('Every letter paragraph, including the last, needs at least one full career catalog ID.'), stage);
      }
    },
  },
  {
    name: 'Official posting closing assembly: mixed citations keep the career projection and a listing-only résumé bullet is refused',
    run() {
      const mixed = fixture([prior(), { ...closing(), evidenceIds: ['career-proof', 'listing-proof'] }]);
      const oldGrounding = assemblePasteApplicationResult(mixed).qualityReview.sourceGrounding.coverLetterParagraphs[1];
      assert.deepEqual(oldGrounding.careerDataQuotes, [CAREER_QUOTE], 'mixed citations keep the career projection');
      assert.equal(Object.hasOwn(oldGrounding, 'jobListingQuotes'), false);
      const resume = fixture(); resume.paste.coverLetter.paragraphs = [prior()];
      resume.paste.coverLetter.generationAudit.coverLetterPlan.paragraphs = [{ paragraph: PRIOR_TEXT }];
      resume.paste.resume.roles[0].bullets[0].evidenceIds = ['listing-proof'];
      assert.throws(() => assemblePasteApplicationResult(resume), /career-data evidence ID|career.*evidence/iu);
    },
  },
  {
    name: 'Official posting closing assembly: a cited project name stays grounded while employment at that target still rejects',
    run() {
      const projectQuote = "I built Northwind Labs's platform for reporting systems and engineering workflows.";
      const paragraphs = [{ id: 'letter-project', text: projectQuote, evidenceIds: ['project-proof'] }, prior()];
      const item = fixture(paragraphs);
      item.careerData += `\n# Personal Projects\n## Northwind Labs\n${projectQuote}`;
      const accepted = [...evidence, { id: 'project-proof', sourceId: 'career-data', quote: projectQuote }];
      item.paste.evidencePlan = { evidence: accepted };
      item.paste.resume.projects = [{ id: 'project-one', name: job.company,
        description: "Built Northwind Labs's platform for reporting systems and engineering workflows.", evidenceIds: ['project-proof'] }];
      const rendered = renderStructuredApplicationResume(item.paste.resume, {
        sourceRoles, careerData: item.careerData, evidenceCatalog: accepted,
      });
      const approvedProjects = extractResumeEvidence(rendered).projects;
      assert.ok(approvedProjects.some(project => project.name === job.company), 'the project name must first pass the real source-backed renderer');
      const state = { stage: 'cover-letter', careerData: item.careerData, evidencePlan: item.paste.evidencePlan,
        trustedIdentity: item.paste.trustedIdentity, resume: item.paste.resume };
      const baseline = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: paragraphs[0].id,
        finalText: projectQuote, evidenceIds: ['project-proof'], acceptedEvidence: accepted, identityTokens: [],
        label: 'coverLetterParagraphs', sourceRoles, careerData: item.careerData, projects: approvedProjects,
        targetCompany: job.company, targetTitle: job.title, postingText: item.jobListing });
      assert.deepEqual(baseline, [], 'a project named by its actual cited career quote retains baseline grounding');
      assert.deepEqual(__validateSharedApplicationContentForTests({ coverLetter: item.paste.coverLetter }, state, item.input), [], 'the shared stage retains cited project grounding');
      assert.doesNotThrow(() => assemblePasteApplicationResult(item));
      const employment = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'employment',
        finalText: 'At Northwind Labs, I rebuilt reporting systems.', evidenceIds: ['project-proof'], acceptedEvidence: accepted,
        identityTokens: [], label: 'coverLetterParagraphs', sourceRoles, careerData: item.careerData, projects: approvedProjects,
        targetCompany: job.company, targetTitle: job.title, postingText: item.jobListing });
      assert.ok(employment.some(error => error.includes('states work at')), 'a project is not an approved career employer');
    },
  },
  {
    name: 'Official posting closing fact-check: only actually cited accepted listing IDs are shown and retain their source role',
    run() {
      const state = initialWriteVerifyState(1); state.candidates[0].structured = fixture().paste;
      state.candidates[0].structured.coverLetter.paragraphs[1].evidenceIds.push('unaccepted-listing', 'career-shadow');
      state.ranking = [state.candidates[0].id]; state.factIndex = 0;
      const listingEvidence = [...evidence,
        { id: 'uncited-listing', sourceId: 'job-listing', quote: 'UNCITED_LISTING_SENTINEL' },
        { id: 'career-shadow', sourceId: 'career-data', quote: 'CAREER_SOURCE_SENTINEL' }];
      for (const stage of ['fact-check', 'fact-recheck']) {
        const prompt = writeVerifyPrompt({ stage, state, listingEvidence, sourcePrompt: '', posting: '', hand: 'CAREER HAND', envelope: {} });
        const block = prompt.split('CITED LISTING QUOTES (posting evidence only; never candidate career evidence):\n')[1].split('\nDOCUMENTS:')[0];
        assert.deepEqual(JSON.parse(block), [{ id: 'listing-proof', quote: LISTING_QUOTE }]);
        assert.equal(prompt.includes('UNCITED_LISTING_SENTINEL'), false);
        assert.equal(prompt.includes('CAREER_SOURCE_SENTINEL'), false);
        assert.ok(prompt.includes('CAREER HAND'));
      }
    },
  },
];
