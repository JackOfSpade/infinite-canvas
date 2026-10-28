import assert from 'node:assert/strict';
import { formatOriginalJobListingMarkdown } from '../../electron/ipc/applicationBundle.js';
import * as local from '../../electron/ipc/localAiApplication.js';

const company = 'Northwind Labs';
const careerQuote = 'I built dispatch rosters for freight routes. I maintained route reports and coordinated dispatch updates for the operations team.';
const listingQuotes = [
  'Your team needs dispatch rosters for freight routes.',
  'Your mission is clear handoffs between dispatch teams and freight operations.',
];
const prior = { id: 'career-paragraph', text: 'I built dispatch rosters for freight routes.', evidenceIds: ['career-one'] };
const closing = (text = listingQuotes[0], evidenceIds = ['job-one']) => ({ id: 'listing-closing', text, evidenceIds });
function context({ paragraphs = null } = {}) {
  const job = { title: 'Platform Engineer', company, location: 'Lakeview, Canada', url: 'https://board.example.test/platform',
    snippet: listingQuotes.join('\n') };
  const acceptedEvidence = [{ id: 'career-one', sourceId: 'career-data', quote: careerQuote },
    ...listingQuotes.map((quote, index) => ({ id: ['job-one', 'job-two'][index], sourceId: 'job-listing', quote }))];
  return { job, acceptedEvidence, jobListing: formatOriginalJobListingMarkdown(job),
    paragraphs: paragraphs || [structuredClone(prior), closing()], index: 1 };
}
function twin(ctx) {
  const paragraph = ctx.paragraphs[ctx.index];
  return local.__pasteUnitGroundingErrorsForTests({
    unitLabel: 'Cover-letter paragraph', unitId: paragraph.id, finalText: paragraph.text, evidenceIds: paragraph.evidenceIds,
    acceptedEvidence: ctx.acceptedEvidence, label: 'coverLetterParagraphs',
    identityTokens: [], targetCompany: ctx.job.company, targetTitle: ctx.job.title, postingText: ctx.jobListing,
    careerData: careerQuote, sourceRoles: [], authority: null, paragraphIndex: ctx.index,
  });
}

export default [
  {
    name: 'Amendment 6 listing-only guard corrections report the real sentence ordinal',
    run() {
      const ctx = context({ paragraphs: [structuredClone(prior), closing(`I would join ${company}. At ${company}, I rebuilt dispatch rosters.`)] });
      const errors = twin(ctx);
      const failures = errors.filter(line => line.includes('states work at'));
      assert.equal(failures.length, 1, JSON.stringify(errors));
      assert.ok(failures[0].includes('paragraph 2, sentence 2'), failures[0]);
      assert.ok(errors.some(line => /needs at least one career-data evidence ID\.$/u.test(line)), 'the citation rule reports alongside the guard');
    },
  },
  {
    name: 'official-posting closing explicitly applies the target-employment guard to listing-only units before any early return',
    run() {
      for (const text of [
        `At ${company}, I rebuilt dispatch rosters for freight routes.`,
        `I now run dispatch rosters for freight routes at ${company}.`,
        `My work at ${company} on dispatch rosters cut triage time.`,
        `I am applying for the role that I rebuilt at ${company}.`,
        `I would be using ${company}'s platform.`,
      ]) {
        const ctx = context({ paragraphs: [structuredClone(prior), closing(text)] });
        const errors = twin(ctx);
        assert.ok(errors.length, `${text}: ${JSON.stringify(errors)}`);
        if (text.startsWith('At ') || text.startsWith('My work at ')) assert.ok(errors.some(line => line.includes('states work at')), text);
      }
      const duration = context({ paragraphs: [structuredClone(prior), closing('I bring 12 years of experience in dispatch rosters for freight routes.')] });
      assert.ok(twin(duration).some(line => /duration|years|span/iu.test(line)), 'listing-only duration is checked against no career quote');
    },
  },
  {
    name: 'official-posting closing leaves the legacy source-grounding sanitizer strict and does not reuse listing text as career evidence',
    run() {
      const ctx = context();
      const raw = { resumeBullets: [], coverLetterParagraphs: [
        { paragraph: prior.text, careerDataQuotes: [careerQuote] },
        { paragraph: listingQuotes[0], careerDataQuotes: [listingQuotes[0]] },
      ] };
      const sourceContext = { careerData: careerQuote, resumeEvidence: { roles: [], projects: [] },
        coverLetter: { paragraphs: [prior.text, prior.text] }, coverLetterArgument: null,
        postingText: ctx.jobListing, postingCompany: company };
      assert.doesNotThrow(() => local.__sanitizeSourceGroundingForTests({ resumeBullets: [], coverLetterParagraphs: [
        { paragraph: prior.text, careerDataQuotes: [careerQuote] }, { paragraph: prior.text, careerDataQuotes: [careerQuote] },
      ] }, sourceContext), 'the strict sanitizer control must bind valid career text before testing the listing-only refusal');
      assert.throws(() => local.__sanitizeSourceGroundingForTests(raw, {
        ...sourceContext,
        coverLetter: { paragraphs: [prior.text, listingQuotes[0]] }, coverLetterArgument: null,
      }), /not an exact quote from trusted career data/u, 'retained legacy jobs still require an exact career-source quote');
    },
  },
];
