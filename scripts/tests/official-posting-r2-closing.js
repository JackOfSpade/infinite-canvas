import assert from 'node:assert/strict';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import { assemblePasteApplicationResult } from '../../electron/ipc/pasteApplicationAssembly.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, __pasteUnitGroundingErrorsForTests, __validateSharedApplicationContentForTests, createApplicationListingClosingValidator } from '../../electron/ipc/localAiApplication.js';
import { LISTING_CLOSING_INTENT_VOCABULARY } from '../../electron/ipc/applicationListingClosing.js';
import { WRITE_VERIFY_LISTING_CLOSING_RULE } from '../../electron/ipc/applicationWriteVerify.js';

const COMPANY = 'Northwind Labs';
const CAREER_QUOTE = 'Built reporting systems that reduced manual work.';
const PRIOR = 'I built reporting systems that reduced manual work.';
const LISTING = 'Your team needs dispatch rosters for freight routes.';
const careerData = `Ada Lovelace\nada@example.test\n## Analytical Engines\nSoftware Engineer\n\n${CAREER_QUOTE}`;
const sourceRoles = [{ id: 'role-one', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];

function fixture(text, { company = COMPANY, quote = LISTING, extra = [] } = {}) {
  const job = { title: 'Platform Engineer', company, snippet: [quote, ...extra.map(item => item.quote)].join('\n') };
  const evidence = [{ id: 'career-one', sourceId: 'career-data', quote: CAREER_QUOTE },
    { id: 'job-one', sourceId: 'job-listing', quote }, ...extra];
  const paragraphs = [{ id: 'letter-one', text: PRIOR, evidenceIds: ['career-one'] },
    { id: 'letter-two', text, evidenceIds: ['job-one'] }];
  const resume = { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
    roles: [{ ...sourceRoles[0], bullets: [{ id: 'bullet-one', text: CAREER_QUOTE, evidenceIds: ['career-one'] }] }] };
  const trustedIdentity = { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: '', credential: '' };
  const state = { stage: 'cover-letter', careerData, evidencePlan: { evidence }, resume, trustedIdentity };
  const input = { version: 1, jobId: 'r2-closing-job', job, sourceRoles };
  return { input, careerData, jobListing: formatOriginalJobListingMarkdown(job),
    validateListingClosing: createApplicationListingClosingValidator({ input, state, sourceRoles, identityTokens: [] }),
    paste: { trustedIdentity, evidencePlan: { evidence }, resume, coverLetter: { name: 'Ada Lovelace', contact: ['ada@example.test'], paragraphs,
      roleThesis: 'Reporting systems serve the work this role needs.',
      coverLetterArgument: { primaryEvidence: { evidence: CAREER_QUOTE, evidenceRole: 'Software Engineer at Analytical Engines', relationToThesis: 'Completed reporting work supports the stated argument.' } },
      generationAudit: { version: 1, finalDecisionSummary: 'Only source-supported reporting evidence was retained.',
        coverLetterPlan: { paragraphs: paragraphs.map(paragraph => ({ paragraph: paragraph.text })) } } },
    finalReview: { decision: 'pass', findings: [], qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
      criteria: [], resume: { decision: 'approved', rationale: 'Direct source evidence.' }, coverLetter: { decision: 'approved', rationale: 'A source-supported argument.' } } } },
    state, evidence, paragraphs };
}
function checks(item) {
  const paragraph = item.paragraphs[1];
  return { closing: item.validateListingClosing({ paragraphs: item.paragraphs, index: 1, acceptedEvidence: item.evidence }),
    drafting: __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: paragraph.id,
      finalText: paragraph.text, evidenceIds: paragraph.evidenceIds, acceptedEvidence: item.evidence,
      label: 'coverLetterParagraphs', identityTokens: [], targetCompany: item.input.job.company, targetTitle: item.input.job.title,
      postingText: item.jobListing, careerData, sourceRoles, paragraphs: item.paragraphs, paragraphIndex: 1, validateListingClosing: item.validateListingClosing }),
    stage: __validateSharedApplicationContentForTests({ coverLetter: item.paste.coverLetter }, item.state, item.input) };
}
function rejected(text, options) {
  const item = fixture(text, options); const result = checks(item);
  assert.equal(result.closing.eligible, false, text);
  assert.ok(result.drafting.length, `drafting: ${text}`);
  assert.ok(result.stage.length, `completion: ${text}`);
  assert.throws(() => assemblePasteApplicationResult(item), /career-data|grounding|closing|sentence/iu, `assembly: ${text}`);
  return result.closing;
}

export default [
  {
    name: 'R2 listing-only closing rejects uncited experience seniority return and perfect-tense claims at every production seam',
    run() {
      for (const text of [
        `I would bring years of dispatch work to ${COMPANY}.`, `I would bring a decade of dispatch work to ${COMPANY}.`,
        `I would bring decades of dispatch work to ${COMPANY}.`, `I would bring a lifetime of dispatch work to ${COMPANY}.`,
        `I would bring senior dispatch work to ${COMPANY}.`, `I would join ${COMPANY} as a principal engineer.`,
        `I would join ${COMPANY} as a staff engineer.`, `I would bring expertise in dispatch rosters to ${COMPANY}.`,
        `I would bring proven dispatch work to ${COMPANY}.`, `I would bring extensive dispatch work to ${COMPANY}.`,
        `I would bring leadership of dispatch teams to ${COMPANY}.`, `I would bring dispatch rosters to ${COMPANY} from a prior company.`,
        `I am eager to rejoin ${COMPANY}.`, `I would return to ${COMPANY}.`, `I would continue dispatch rosters at ${COMPANY}.`,
        `I would stay at ${COMPANY}.`, `I would remain at ${COMPANY}.`, `I would be back at ${COMPANY}.`,
        `I would be glad to have rebuilt dispatch rosters at ${COMPANY}.`, `I would be glad to have run dispatch rosters at ${COMPANY}.`,
        `I would bring dispatch rosters I had built to ${COMPANY}.`,
        'Your team gets a decade of dispatch rosters for freight routes.',
        'Your team gets a principal engineer who writes dispatch rosters for freight routes.',
        'Your team needs dispatch rosters for freight routes, and this application delivers them.',
      ]) rejected(text);
    },
  },
  {
    name: 'R2 listing-only closing structural bans remain even when a cited quote contains the banned term or frame',
    run() {
      for (const text of [`I would bring years of dispatch work to ${COMPANY}.`, `I would join ${COMPANY} as a principal engineer.`,
        `I would return to ${COMPANY}.`, `I would stay with ${COMPANY}.`, `I would remain with ${COMPANY}.`,
        `I would stay on ${COMPANY}'s team.`, `I would remain on ${COMPANY}'s team.`, `I would be back with ${COMPANY}.`,
        `I would have rebuilt dispatch rosters at ${COMPANY}.`,
        'Your team needs proven expertise in dispatch rosters for freight routes.',
        'Your team needs a dozen dispatch rosters for freight routes.',
        'Your team needs hundreds of dispatch rosters for freight routes.']) rejected(text, { quote: text });
    },
  },
  {
    name: 'R2 listing-only closing token coverage reads only actually cited quotes and reports generic ordinal failures',
    run() {
      const text = `I would bring service architecture to ${COMPANY}.`;
      const result = rejected(`${LISTING} ${text}`, { extra: [{ id: 'job-unused', sourceId: 'job-listing', quote: 'Your team needs service architecture.' }] });
      assert.ok(result.corrections.some(line => /sentence 2:.*every meaningful term/u.test(line)));
      for (const correction of result.corrections) {
        assert.ok(!correction.includes('service architecture') && !correction.includes(LISTING) && !correction.includes(CAREER_QUOTE), correction);
      }
      const accepted = fixture(text, { quote: 'Your team needs service architecture.' });
      assert.equal(checks(accepted).closing.eligible, true);
      assert.doesNotThrow(() => assemblePasteApplicationResult(accepted));
    },
  },
  {
    name: 'R2 listing-only closing prints its closed intent vocabulary in the writer rule and names it generically in the correction',
    run() {
      // Words that count as nothing to the token floor (stopwords and one-letter forms); every other vocabulary word is printed.
      const silent = new Set(['a', 'an', 'and', 'are', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'i', 'm', 'd', 're', 'll', 'we', 'am']);
      const printed = WRITE_VERIFY_LISTING_CLOSING_RULE.toLowerCase();
      assert.ok(printed.includes('closed intent'), 'the rule names the vocabulary');
      for (const word of LISTING_CLOSING_INTENT_VOCABULARY) {
        if (!silent.has(word)) assert.match(printed, new RegExp(`(?<![a-z])${word}(?![a-z])`, 'u'), `the printed rule lists ${word}`);
      }
      for (const word of ['conversation', 'discuss', 'talk', 'about']) {
        assert.equal(LISTING_CLOSING_INTENT_VOCABULARY.has(word), false, `${word} is not vocabulary`);
        assert.ok(printed.includes(word), `${word} is printed as a rejected word`);
      }
      const text = 'I would welcome a conversation about dispatch rosters for freight routes.';
      const result = rejected(text);
      assert.ok(result.corrections.some(line => /sentence 1: listing-grounded closing requires clause 1 with every meaningful term in the closed intent vocabulary listed in the closing rule, the frozen company name or a cited listing quote\.$/u.test(line)),
        JSON.stringify(result.corrections));
      for (const line of result.corrections) {
        for (const word of ['conversation', 'about', LISTING, CAREER_QUOTE]) assert.ok(!line.includes(word), `the correction quotes no text: ${line}`);
      }
      // The same words pass when the vocabulary, the company or a cited quote supplies them.
      for (const good of [`I would welcome the chance to join ${COMPANY}.`, 'I would welcome the chance to help with dispatch rosters for freight routes.']) {
        const item = fixture(good); assert.equal(checks(item).closing.eligible, true, good);
      }
    },
  },
  {
    name: 'R2 listing-only closing keeps the plain application opener for an article-led company without opening it to other organizations or clauses',
    run() {
      const quote = 'The Platform Engineer role owns dispatch rosters for freight routes.';
      for (const company of ['The Alder Yard', 'The Willow Mutual']) {
        for (const text of [`I am applying for the Platform Engineer role at ${company}.`, `I am applying for the role of Platform Engineer at ${company}.`]) {
          const item = fixture(text, { company, quote }); const result = checks(item);
          assert.equal(result.closing.eligible, true, `${company}: ${text}: ${JSON.stringify(result.closing.corrections)}`);
          assert.deepEqual(result.drafting, []); assert.deepEqual(result.stage, []);
          assert.doesNotThrow(() => assemblePasteApplicationResult(item));
        }
        for (const text of [`I am applying for the Platform Engineer role at Initech.`, `I am applying for the Platform Engineer role at ${company}, where I rebuilt dispatch rosters.`,
          `I am applying for the role of Platform Engineer at ${company} and I led dispatch rosters.`]) rejected(text, { company, quote });
      }
    },
  },
  {
    name: 'R2 listing-only closing preserves plain intent company variants and cited employer-facing work through assembly',
    run() {
      for (const company of [COMPANY, `${COMPANY}, Inc.`, `${COMPANY} (NWL)`]) {
        for (const text of [LISTING, `I would join ${COMPANY}.`, `I am excited to join ${COMPANY}.`,
          `I look forward to joining ${COMPANY}.`, `I would bring dispatch rosters to ${COMPANY}.`,
          `${COMPANY}'s team needs dispatch rosters for freight routes.`]) {
          const item = fixture(text, { company }); const result = checks(item);
          assert.equal(result.closing.eligible, true, `${company}: ${text}: ${JSON.stringify(result.closing.corrections)}`);
          assert.deepEqual(result.drafting, []); assert.deepEqual(result.stage, []);
          const assembled = assemblePasteApplicationResult(item);
          assert.deepEqual(assembled.qualityReview.sourceGrounding.coverLetterParagraphs[1].careerDataQuotes, []);
          assert.deepEqual(assembled.qualityReview.sourceGrounding.coverLetterParagraphs[1].jobListingQuotes, [LISTING]);
        }
      }
      const modern = fixture(`I would join ${COMPANY}.`); modern.input.applicationProtocol = 'write-then-verify.v2';
      assert.equal(assemblePasteApplicationResult(modern).qualityReview, null);
      const named = fixture('I would join Principal Staff Works.', { company: 'Principal Staff Works' });
      assert.equal(checks(named).closing.eligible, true, 'an exact frozen company name is not a candidate seniority claim');
      assert.doesNotThrow(() => assemblePasteApplicationResult(named));
      rejected('I would join Principal Staff Works as a principal engineer.', { company: 'Principal Staff Works' });
      rejected('I would bring principal craftsmanship to Principal Staff Works.', { company: 'Principal Staff Works' });
    },
  },
];
