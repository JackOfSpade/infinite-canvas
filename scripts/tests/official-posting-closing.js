import assert from 'node:assert/strict';
import { formatOriginalJobListingMarkdown, ORIGINAL_JOB_LISTING_BODY_HEADING, ORIGINAL_JOB_LISTING_TARGETS_HEADING } from '../../electron/ipc/applicationBundle.js';
import * as local from '../../electron/ipc/localAiApplication.js';

const company = 'Northwind Labs';
const careerQuote = 'I built dispatch rosters for freight routes. I maintained route reports and coordinated dispatch updates for the operations team.';
const listingQuotes = [
  'Your team needs dispatch rosters for freight routes.',
  'Your mission is clear handoffs between dispatch teams and freight operations.',
  'Your roadmap covers release checklists and route reporting.',
  'Your teams use CedarOS for dispatch scheduling.',
];
const prior = { id: 'career-paragraph', text: 'I built dispatch rosters for freight routes.', evidenceIds: ['career-one'] };
const closing = (text = listingQuotes[0], evidenceIds = ['job-one']) => ({ id: 'listing-closing', text, evidenceIds });
function context({ snippet = listingQuotes.join('\n'), evidence = null, paragraphs = null, ...extra } = {}) {
  const input = { job: { title: 'Platform Engineer', company, location: 'Lakeview, Canada', url: 'https://board.example.test/platform',
    snippet, postingVariants: [{ location: 'Riverton', url: 'https://board.example.test/other-location' }] } };
  const acceptedEvidence = evidence || [{ id: 'career-one', sourceId: 'career-data', quote: careerQuote },
    ...listingQuotes.map((quote, index) => ({ id: ['job-one', 'job-two', 'job-three', 'job-four'][index], sourceId: 'job-listing', quote }))];
  const state = { careerData: careerQuote, sourceRoles: [], jobListing: formatOriginalJobListingMarkdown(input.job),
    evidencePlan: { evidence: acceptedEvidence } };
  return { input, state, acceptedEvidence, identityTokens: [], sourceRoles: [], projects: [], authority: null,
    paragraphs: paragraphs || [structuredClone(prior), closing()], index: 1, ...extra };
}
function evaluate(options = {}) {
  const ctx = context(options);
  return local.__finalParagraphListingGroundingForTests(ctx);
}
function twin(ctx) {
  const paragraph = ctx.paragraphs[ctx.index];
  return local.__pasteUnitGroundingErrorsForTests({
    unitLabel: 'Cover-letter paragraph', unitId: paragraph.id, finalText: paragraph.text, evidenceIds: paragraph.evidenceIds,
    acceptedEvidence: ctx.acceptedEvidence, label: 'coverLetterParagraphs',
    identityTokens: [], targetCompany: ctx.input.job.company, targetTitle: ctx.input.job.title, postingText: ctx.state.jobListing,
    careerData: ctx.state.careerData, sourceRoles: [], authority: null,
    paragraphs: ctx.paragraphs, paragraphIndex: ctx.index,
    validateListingClosing: local.createApplicationListingClosingValidator(ctx),
  });
}

export default [
  {
    name: 'official-posting closing permits actual final intent and employer-facing sentences with one through four accepted body citations',
    run() {
      for (const text of [
        listingQuotes[0], 'Your mission is clear handoffs between dispatch teams and freight operations.',
        `I am applying for the role at ${company}.`, `I would join ${company}.`,
        `I am excited to join ${company}.`, `I am eager to join ${company}.`, `I'm ready to help ${company}.`,
        `I look forward to joining ${company}.`, `I would love to contribute to ${company}.`,
        `I'd join ${company}.`, `I’d join ${company}.`, `I'll join ${company}.`, `I’ll join ${company}.`,
        `We'd join ${company}.`, `We’d join ${company}.`, `We'll join ${company}.`, `We’ll join ${company}.`,
        `I would support ${company}’ mission.`, `I would support ${company}'s mission.`,
      ]) {
        const ctx = context({ paragraphs: [structuredClone(prior), closing(text)] });
        const result = local.__finalParagraphListingGroundingForTests(ctx);
        assert.equal(result.eligible, true, `${text}: ${JSON.stringify(result.corrections)}`);
        assert.equal(result.listingOnly, true); assert.deepEqual(result.corrections, []);
        assert.deepEqual(twin(ctx), [], `drafting twin accepts ${text}`);
      }
      for (let count = 1; count <= 4; count++) {
        const ids = ['job-one', 'job-two', 'job-three', 'job-four'].slice(0, count);
        const result = evaluate({ paragraphs: [structuredClone(prior), closing(listingQuotes[0], ids)] });
        assert.equal(result.eligible, true, JSON.stringify(result.corrections));
        assert.equal(result.listingQuotes.length, count);
      }
      const named = evaluate({ paragraphs: [structuredClone(prior), closing('Your team needs CedarOS dispatch rosters for freight routes.', ['job-one', 'job-four'])] });
      assert.equal(named.eligible, true, JSON.stringify(named.corrections));
      for (const [text, expected] of [
        [`I would join ${company}, and I would help ${company}.`, true],
        [`I would join ${company}, and I rebuilt dispatch rosters for freight routes.`, false],
        [`I would join ${company}, and I would help ${company} while building dispatch rosters.`, false],
      ]) {
        const base = context();
        const evidence = [base.acceptedEvidence[0], { id: 'job-one', sourceId: 'job-listing', quote: text }];
        const ctx = context({ snippet: text, evidence, paragraphs: [structuredClone(prior), closing(text)] });
        const result = local.__finalParagraphListingGroundingForTests(ctx);
        assert.equal(result.eligible, expected, `${text}: ${JSON.stringify(result.corrections)}`);
        assert.equal(twin(ctx).length === 0, expected, 'every coordinated intent clause keeps its own closed lead-in and remainder checks');
      }
    },
  },
  {
    name: 'official-posting closing requires a final paragraph and an earlier paragraph that passes unchanged career grounding',
    run() {
      for (const options of [
        { paragraphs: [closing()], index: 0 },
        { paragraphs: [structuredClone(prior), closing(), structuredClone(prior)], index: 1 },
        { paragraphs: [{ ...prior, text: 'I built unrelated invented hospital systems.' }, closing()] },
        { paragraphs: [{ ...prior, evidenceIds: ['job-one'] }, closing()] },
        { paragraphs: [{ ...prior, evidenceIds: ['unknown-career'] }, closing()] },
      ]) {
        const ctx = context(options); const result = local.__finalParagraphListingGroundingForTests(ctx);
        assert.equal(result.eligible, false, JSON.stringify(options));
        assert.ok(twin(ctx).length, 'drafting retains the strict rule when earlier context does not qualify');
      }
      const falseFlag = evaluate({ paragraphs: [closing()], index: 0, eligible: true, finalParagraphListingGrounded: true });
      assert.equal(falseFlag.eligible, false, 'model-shaped flags never grant the structural exception');
    },
  },
  {
    name: 'official-posting closing admits only one to four known listing-only ids and quote slices within the actual frozen posting fence',
    run() {
      const idsCases = [[], ['unknown-listing'], ['career-one'], ['career-one', 'job-one'],
        ['job-one', 'job-two', 'job-three', 'job-four', 'job-five']];
      for (const ids of idsCases) assert.equal(evaluate({ paragraphs: [structuredClone(prior), closing(listingQuotes[0], ids)] }).eligible, false, JSON.stringify(ids));
      const base = context();
      const fifthQuote = 'Your work needs route checklists for dispatch teams.';
      const fiveKnown = evaluate({ snippet: [...listingQuotes, fifthQuote].join('\n'),
        evidence: [...base.acceptedEvidence, { id: 'job-five', sourceId: 'job-listing', quote: fifthQuote }],
        paragraphs: [structuredClone(prior), closing(listingQuotes[0], ['job-one', 'job-two', 'job-three', 'job-four', 'job-five'])] });
      assert.equal(fiveKnown.eligible, false, 'five known body citations still exceed the four-id limit');
      assert.ok(base.state.jobListing.includes(ORIGINAL_JOB_LISTING_BODY_HEADING));
      assert.ok(base.state.jobListing.includes(ORIGINAL_JOB_LISTING_TARGETS_HEADING));
      const header = base.state.jobListing.split('\n').find(line => line.startsWith('**Company:**'));
      const target = base.state.jobListing.split('\n').find(line => line.startsWith('- **Riverton:**'));
      for (const quote of [header, target, 'This accepted-plan quote never occurs in the posting body.']) {
        assert.ok(quote);
        const evidence = [...base.acceptedEvidence, { id: 'job-outside', sourceId: 'job-listing', quote }];
        assert.equal(evaluate({ evidence, paragraphs: [structuredClone(prior), closing(listingQuotes[0], ['job-outside'])] }).eligible, false, quote);
        assert.equal(evaluate({ evidence, paragraphs: [structuredClone(prior), closing(listingQuotes[0], ['job-one', 'job-outside'])] }).eligible, false,
          'one valid body citation cannot hide a header, target or absent sibling quote');
      }
      assert.equal(evaluate({ snippet: '', paragraphs: [structuredClone(prior), closing()] }).eligible, false,
        'an empty posting has no fenced quote body even if a prior accepted item names a quote');
      assert.equal(evaluate({ snippet: `A source line with literal \`\`\` markers.\n${listingQuotes.join('\n')}` }).eligible, true,
        'the formatter expands its fence around embedded markers without losing real body quotes');
      const shortQuote = { id: 'job-one', sourceId: 'job-listing', quote: 'Northwind Labs' };
      assert.equal(evaluate({ evidence: [base.acceptedEvidence[0], shortQuote] }).eligible, false,
        'a company named only in metadata is not an in-body quote');
    },
  },
  {
    name: 'official-posting closing rejects every prohibited candidate, career, figure, qualifier, credential and unsupported-name sentence at the drafting twin',
    run() {
      for (const text of [
        'I rebuilt dispatch rosters for freight routes.',
        'Your team needs ZephyrWorks dispatch rosters for freight routes.',
        'Your team needs dispatch rosters for 12 freight routes.',
        'Your team needs dispatch rosters for twelve freight routes.',
        'Your team needs dispatch rosters in 2024 for freight routes.',
        'Your team needs certification in dispatch rosters for freight routes.',
        'Your team needs daily dispatch rosters for freight routes.',
        'Your team needs my dispatch rosters for freight routes.',
        'Your team needs our dispatch rosters for freight routes.',
        'Your team needs experience with dispatch rosters for freight routes.',
        'Your team needs proven expertise in dispatch rosters for freight routes.',
        'Build dispatch rosters for your freight routes.',
        'Dispatch rosters cover freight routes.',
        'Your team built dispatch rosters for freight routes.',
        `I would bring my dispatch rosters to ${company}.`,
        `I would join ${company} in 2027.`,
        `I would join ZephyrWorks.`,
        `I was excited to join ${company}.`,
        `I am applying for the role that I led across forty ZephyrWorks sites.`,
      ]) {
        const ctx = context({ paragraphs: [structuredClone(prior), closing(text)] });
        const result = local.__finalParagraphListingGroundingForTests(ctx);
        assert.equal(result.eligible, false, text);
        assert.ok(twin(ctx).length, `drafting rejects ${text}`);
      }
    },
  },
  {
    name: 'official-posting closing intent grants capitalized listing terms only at whole-term boundaries',
    run() {
      for (const [term, longer] of [['API', 'XAPIX'], ['Zorgon', 'ZorgonX']]) {
        const quote = `Your team needs ${longer} dispatch rosters for freight routes.`;
        const base = context();
        const evidence = [base.acceptedEvidence[0], { id: 'job-one', sourceId: 'job-listing', quote }];
        const bad = context({ snippet: quote, evidence, paragraphs: [structuredClone(prior), closing(`I would bring ${term} to ${company}.`)] });
        assert.equal(local.__finalParagraphListingGroundingForTests(bad).eligible, false, `${longer} cannot license ${term}`);
        assert.ok(twin(bad).length);
        const good = context({ snippet: quote, evidence, paragraphs: [structuredClone(prior), closing(`I would bring ${longer} to ${company}.`)] });
        const accepted = local.__finalParagraphListingGroundingForTests(good);
        assert.equal(accepted.eligible, true, JSON.stringify(accepted.corrections));
      }
      const foreign = `I would support Zorgon's mission.`;
      assert.equal(evaluate({ paragraphs: [structuredClone(prior), closing(foreign)] }).eligible, false);
      const quote = 'Your team needs Zorgon dispatch rosters for freight routes.';
      const base = context();
      const stated = evaluate({ snippet: quote,
        evidence: [base.acceptedEvidence[0], { id: 'job-one', sourceId: 'job-listing', quote }],
        paragraphs: [structuredClone(prior), closing(foreign)] });
      assert.equal(stated.eligible, true, JSON.stringify(stated.corrections));
    },
  },
  {
    name: 'official-posting closing refuses the whole final paragraph when one sentence fails and reports source-free ordinal corrections per cause',
    run() {
      const bad = 'I rebuilt ZephyrWorks dispatch rosters for 12 freight routes.';
      const ctx = context({ paragraphs: [structuredClone(prior), closing(`${listingQuotes[0]} ${bad}`)] });
      const result = local.__finalParagraphListingGroundingForTests(ctx);
      assert.equal(result.eligible, false); assert.equal(result.listingOnly, true);
      assert.ok(result.corrections.length >= 3, JSON.stringify(result.corrections));
      assert.equal(new Set(result.corrections).size, result.corrections.length);
      assert.ok(result.corrections.some(line => /sentence\s+2/iu.test(line)), JSON.stringify(result.corrections));
      for (const line of result.corrections) {
        assert.ok(!line.includes(bad) && !line.includes(listingQuotes[0]) && !line.includes(careerQuote), line);
        assert.ok(!line.includes('ZephyrWorks') && !line.includes('12 freight'), 'corrections must name generic failures without reproducing source or unsupported facts');
      }
      assert.ok(twin(ctx).length, 'a good first sentence cannot exempt its invalid sibling');
    },
  },
  {
    name: 'official-posting closing employer-facing figure credential and qualifier bans still apply when the cited listing states them',
    run() {
      for (const text of [
        'Your team needs dispatch rosters for 12 freight routes.',
        'Your team needs dispatch rosters for twelve freight routes.',
        'Your team needs dispatch rosters in 2024 for freight routes.',
        'Your team needs certification in dispatch rosters for freight routes.',
        'Your team needs daily dispatch rosters for freight routes.',
      ]) {
        const base = context();
        const evidence = [base.acceptedEvidence[0], { id: 'job-one', sourceId: 'job-listing', quote: text }];
        const ctx = context({ snippet: text, evidence, paragraphs: [structuredClone(prior), closing(text)] });
        assert.equal(local.__finalParagraphListingGroundingForTests(ctx).eligible, false, `a stated listing fact cannot relax the structural ban: ${text}`);
        assert.ok(twin(ctx).length);
      }
    },
  },
  {
    name: 'official-posting closing conservatively refuses opening verbs even outside a finite action list when their listing quote states them',
    run() {
      for (const text of ['Compose your dispatch rosters for freight routes.', 'Protect your dispatch rosters for freight routes.']) {
        const base = context();
        const evidence = [base.acceptedEvidence[0], { id: 'job-one', sourceId: 'job-listing', quote: text }];
        const ctx = context({ snippet: text, evidence, paragraphs: [structuredClone(prior), closing(text)] });
        const result = local.__finalParagraphListingGroundingForTests(ctx);
        assert.equal(result.eligible, false, text);
        assert.ok(result.corrections.some(line => /opening verb/iu.test(line)), JSON.stringify(result.corrections));
        assert.ok(twin(ctx).some(line => /opening verb/iu.test(line)));
      }
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
        assert.ok(errors.some(line => line.includes('the employer this letter is addressed to')), `${text}: ${JSON.stringify(errors)}`);
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
        postingText: ctx.state.jobListing, postingCompany: company };
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
