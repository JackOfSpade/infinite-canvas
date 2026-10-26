import assert from 'node:assert/strict';
import { assemblePasteApplicationResult } from '../../electron/ipc/pasteApplicationAssembly.js';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import { renderStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { extractResumeEvidence } from '../../electron/ipc/jobApplication.js';
import { validateSharedApplicationContent } from '../../electron/ipc/applicationTruthGates.js';
import { WRITE_VERIFY_BRIEF, WRITE_VERIFY_LISTING_CLOSING_RULE, initialWriteVerifyState, writeVerifyPrompt, writeVerifySourcePrompt } from '../../electron/ipc/applicationWriteVerify.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, __pasteUnitGroundingErrorsForTests, __validateSharedApplicationContentForTests, createApplicationListingClosingValidator, writeVerifyGroundingContract } from '../../electron/ipc/localAiApplication.js';

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

function validator() {
  return createApplicationListingClosingValidator({ input: { job }, state: { careerData, evidencePlan: { evidence } }, sourceRoles, identityTokens: [] });
}

function fixture(paragraphs = [prior(), closing()]) {
  return {
    input: { version: 1, jobId: 'closing-job', job, sourceRoles }, careerData,
    jobListing: formatOriginalJobListingMarkdown(job), validateListingClosing: validator(),
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
    postingText: formatOriginalJobListingMarkdown(job), paragraphs, paragraphIndex: index, validateListingClosing: validator() });
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
    name: 'Official posting closing shared gate: optional context is lazy and missing injection retains the career-citation rule',
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
        createApplicationListingClosingValidator: () => { throw new Error('Ordinary validation must not create listing-only context.'); },
      };
      assert.deepEqual(validateSharedApplicationContent(response, state, {}, null, dependencies), []);
      assert.deepEqual(validateSharedApplicationContent({ coverLetter: { ...response.coverLetter, paragraphs: [] } }, state, {}, null, dependencies),
        ['Cover letter needs at least one paragraph.']);
      for (const ids of [[], ['unknown-listing'], ['listing-proof', 'unknown-listing']]) {
        const errors = validateSharedApplicationContent({ coverLetter: { ...response.coverLetter,
          paragraphs: [prior(), { ...closing(), evidenceIds: ids }] } }, state, {}, null, dependencies);
        assert.ok(errors.some(error => /needs at least one career-data evidence ID/u.test(error)), 'invalid citations never create optional render context');
      }
      const historicalDependencies = { ...dependencies }; delete historicalDependencies.createApplicationListingClosingValidator;
      const errors = validateSharedApplicationContent({ coverLetter: { ...response.coverLetter, paragraphs: [prior(), closing()] } }, state, {}, null, historicalDependencies);
      assert.ok(errors.some(error => /needs at least one career-data evidence ID/u.test(error)));
      assert.deepEqual(durations.at(-1), [], 'listing-only duration still receives no career quotes');
    },
  },
  {
    name: 'Official posting closing assembly: a multi-paragraph listing close passes the write and correction twins and retains its posting source label',
    run() {
      const paragraphs = [prior(), closing()];
      assert.deepEqual(draftingErrors(paragraphs), [], 'write-time grounding accepts the structural closing');
      assert.deepEqual(stageErrors(paragraphs), [], 'the real shared stage gate and completion twin accept the write');
      const badDraft = [prior(), closing(`${LISTING_QUOTE} I built dispatch tools.`)];
      assert.ok(draftingErrors(badDraft).length, 'an unsupported first draft is rejected');
      assert.ok(stageErrors(badDraft).length, 'the real shared stage gate rejects the unsupported draft');
      assert.deepEqual(draftingErrors(paragraphs), [], 'the corrected draft passes the same production twin');
      assert.deepEqual(stageErrors(paragraphs), [], 'the real shared stage gate and completion twin accept the correction');
      const result = assemblePasteApplicationResult(fixture(paragraphs));
      const grounds = result.qualityReview.sourceGrounding.coverLetterParagraphs;
      assert.deepEqual(grounds[0].careerDataQuotes, [CAREER_QUOTE]);
      assert.deepEqual(grounds[1], { paragraph: LISTING_QUOTE, careerDataQuotes: [], jobListingQuotes: [LISTING_QUOTE] });
      assert.deepEqual(result.coverLetter.paragraphs, [PRIOR_TEXT, LISTING_QUOTE]);
      const modern = fixture(paragraphs); modern.input.applicationProtocol = 'write-then-verify.v2';
      const modernResult = assemblePasteApplicationResult(modern);
      assert.equal(modernResult.applicationProtocol, 'write-then-verify.v2');
      assert.equal(modernResult.qualityReview, null);
      assert.deepEqual(modernResult.coverLetter.paragraphs, [PRIOR_TEXT, LISTING_QUOTE]);
      const legacy = fixture(paragraphs); delete legacy.validateListingClosing;
      assert.throws(() => assemblePasteApplicationResult(legacy), /job-listing evidence alone cannot support candidate copy/u);
    },
  },
  {
    name: 'Official posting closing assembly: one paragraph, non-final, failed earlier proof and every unsupported closing sentence are refused by drafting and assembly',
    run() {
      const cases = [
        { paragraphs: [closing()], index: 0 },
        { paragraphs: [closing(), prior()], index: 0 },
        { paragraphs: [{ ...prior(), text: 'I built dispatch rosters for freight routes.' }, closing()], index: 1 },
        ...[
          `${LISTING_QUOTE} I built dispatch rosters for freight routes.`,
          `${LISTING_QUOTE} Your workflows use ZephyrMesh.`,
          `${LISTING_QUOTE} Your workflows serve 900 engineering teams.`,
        ].map(text => ({ paragraphs: [prior(), closing(text)], index: 1 })),
      ];
      for (const { paragraphs, index } of cases) {
        assert.ok(draftingErrors(paragraphs, index).length, JSON.stringify(paragraphs));
        assert.ok(stageErrors(paragraphs).length, 'the real shared stage and completion twin reject the same changed package');
        assert.throws(() => assemblePasteApplicationResult(fixture(paragraphs)), /career-data|grounding|sentence|unsupported/iu, JSON.stringify(paragraphs));
      }
    },
  },
  {
    name: 'Official posting closing assembly: each failed sentence clause retains its own generic correction record and authored-letter repair',
    run() {
      const paragraphs = [prior(), closing(`${LISTING_QUOTE} Your workflows served 900 ZephyrMesh engineers.`)];
      const evaluation = validator()({ paragraphs, index: 1, acceptedEvidence: evidence });
      assert.ok(evaluation.corrections.length >= 3, 'the bad sentence fails multiple independent clauses');
      assert.throws(() => assemblePasteApplicationResult(fixture(paragraphs)), error => {
        const records = error.failureRecords;
        assert.deepEqual(records.slice(0, -1).map(record => record.message), evaluation.corrections);
        assert.ok(records.slice(0, -1).every(record => /paragraph 2, sentence 2:/u.test(record.message)));
        assert.ok(records.every(record => JSON.stringify(record.repairs) === JSON.stringify(['coverLetter:authored'])));
        assert.ok(records.every(record => !record.message.includes(LISTING_QUOTE) && !record.message.includes(CAREER_QUOTE)));
        assert.match(records.at(-1).message, /job-listing evidence alone cannot support candidate copy/u);
        return true;
      });
    },
  },
  {
    name: 'Official posting closing assembly: the host receives normalized full paragraphs and the accepted plan, and the exception never applies to a résumé bullet',
    run() {
      const item = fixture([prior(), closing(`  Your reporting\n systems support workflows for engineering teams.  `)]);
      const calls = []; const trusted = item.validateListingClosing;
      item.validateListingClosing = args => { calls.push(args); return trusted(args); };
      assemblePasteApplicationResult(item);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map(call => call.index), [0, 1]);
      assert.ok(calls.every(call => call.paragraphs.length === 2 && call.paragraphs[1].text === LISTING_QUOTE));
      assert.ok(calls.every(call => JSON.stringify(call.acceptedEvidence) === JSON.stringify(evidence)));
      const mixed = fixture([prior(), { ...closing(), evidenceIds: ['career-proof', 'listing-proof'] }]);
      const oldGrounding = assemblePasteApplicationResult(mixed).qualityReview.sourceGrounding.coverLetterParagraphs[1];
      assert.deepEqual(oldGrounding.careerDataQuotes, [CAREER_QUOTE], 'mixed citations keep the old career projection');
      assert.equal(Object.hasOwn(oldGrounding, 'jobListingQuotes'), false);
      assert.equal(validator()({ paragraphs: mixed.paste.coverLetter.paragraphs, index: 1, acceptedEvidence: evidence }).listingOnly, false);
      const resume = fixture(); resume.paste.resume.roles[0].bullets[0].evidenceIds = ['listing-proof'];
      assert.throws(() => assemblePasteApplicationResult(resume), /career-data evidence ID|career.*evidence/iu);
    },
  },
  {
    name: 'Official posting closing assembly: a cited project name stays grounded while employment at that target still rejects',
    run() {
      const projectQuote = "I built Northwind Labs's platform for reporting systems and engineering workflows.";
      const paragraphs = [{ id: 'letter-project', text: projectQuote, evidenceIds: ['project-proof'] }, closing()];
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
        targetCompany: job.company, targetTitle: job.title, postingText: item.jobListing, allowListingClosing: false });
      assert.deepEqual(baseline, [], 'a project named by its actual cited career quote retains baseline grounding');
      assert.deepEqual(__validateSharedApplicationContentForTests({ coverLetter: item.paste.coverLetter }, state, item.input), [], 'the shared stage retains cited project grounding');
      item.validateListingClosing = createApplicationListingClosingValidator({ input: item.input, state, careerData: item.careerData });
      assert.doesNotThrow(() => assemblePasteApplicationResult(item));
      const employment = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'employment',
        finalText: 'At Northwind Labs, I rebuilt reporting systems.', evidenceIds: ['project-proof'], acceptedEvidence: accepted,
        identityTokens: [], label: 'coverLetterParagraphs', sourceRoles, careerData: item.careerData, projects: approvedProjects,
        targetCompany: job.company, targetTitle: job.title, postingText: item.jobListing });
      assert.ok(employment.some(error => error.includes('states work at')), 'a project is not an approved career employer');
    },
  },
  {
    name: 'Official posting closing prompts: write, conversion and correction learn the same scoped exception outside the unchanged brief',
    run() {
      const state = initialWriteVerifyState(1); state.candidates[0].structured = fixture().paste;
      state.candidates[0].plainText = `${PRIOR_TEXT}\n\n${LISTING_QUOTE}`;
      const sourcePrompt = writeVerifySourcePrompt({ posting: formatOriginalJobListingMarkdown(job), requirements: [],
        listingEvidence: evidence.filter(row => row.sourceId === 'job-listing'), identity: {}, sourceRoles: [],
        profile: { roles: [], achievements: [], projects: [], skills: [] }, catalog: [], groundingContract: writeVerifyGroundingContract() });
      assert.equal(WRITE_VERIFY_BRIEF.length, 968);
      assert.equal(WRITE_VERIFY_BRIEF.includes(WRITE_VERIFY_LISTING_CLOSING_RULE), false);
      assert.equal(writeVerifyGroundingContract().split(WRITE_VERIFY_LISTING_CLOSING_RULE).length, 2);
      const ownSentenceRule = 'Name the employer only in a short sentence of its own about its need or your wish to join it.';
      assert.equal(WRITE_VERIFY_BRIEF.includes(ownSentenceRule), false);
      assert.equal(writeVerifyGroundingContract().includes(ownSentenceRule), false);
      for (const stage of ['write', 'convert', 'verify-correction']) {
        const prompt = writeVerifyPrompt({ stage, state, sourcePrompt, posting: '', hand: '', envelope: {} });
        assert.ok(prompt.includes(WRITE_VERIFY_LISTING_CLOSING_RULE), stage);
        assert.equal(prompt.includes(ownSentenceRule), false, stage);
        assert.ok(prompt.includes(`BRIEF: ${WRITE_VERIFY_BRIEF}`), stage);
      }
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
