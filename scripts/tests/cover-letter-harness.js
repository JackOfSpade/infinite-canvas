import {
  assert,
  assertCandidateDashPunctuation,
  authorCoverLetterEnvelope,
  formatCoverLetterDate,
  BANNED_GENERIC_PHRASES,
  BANNED_GENERIC_PATTERNS,
  buildResumeDocument,
  checkAdditiveSeam,
  checkAllNeedDisposition,
  checkAnchorRelevance,
  checkClaimedEquivalence,
  checkCompanySpecificity,
  checkCompoundHyphenation,
  checkContainerizationTechnologyRoles,
  checkDanglingParagraphTransition,
  checkDetachedRelevanceClaim,
  checkDirectWelcomeClosing,
  checkEligibilityNeedDisposition,
  checkEvidenceGrounding,
  checkExperienceInfinitiveGrammar,
  checkFigureDiscipline,
  checkGenericPhrases,
  checkInterestFraming,
  checkIntroductoryWorkplaceComma,
  checkLogisticsContainment,
  checkLogisticsExclusion,
  checkLogisticsGrounding,
  checkLowInformationToolBuild,
  checkModifierAttachment,
  checkNamedArtifactIntroduction,
  checkOpeningArtifactContext,
  checkNeedGrounding,
  checkNeedsPortfolio,
  checkOpeningDemonstrative,
  checkAdjacentEmployerRepetition,
  checkOpeningEmployerShorthand,
  checkEntailedPremise,
  checkParallelStructure,
  checkParagraphArgumentLinks,
  ARGUMENT_MAPPING_REQUIRED_RULE,
  ARGUMENT_RELEVANCE_ANAPHORA_RULE,
  ARGUMENT_RELEVANCE_MECHANISM_RULE,
  paragraphArgumentSpanGaps,
  checkCandidateAgency,
  paragraphHasCandidatePastProof,
  checkPlainRegister,
  checkPlanGate,
  checkPostingReference,
  checkPriorEmployerOpening,
  checkRepeatedPhrase,
  checkRepeatedSentenceShape,
  checkPunctuationStyle,
  checkProspectiveContributionTense,
  checkRedundancy,
  checkResumeBulletFocus,
  checkReferenceClarity,
  checkResponsibilityTransition,
  checkSalientPhraseEcho,
  checkRequestedWorkSampleLink,
  checkRoleThesis,
  checkSentenceLength,
  checkShape,
  checkTargetClaimScope,
  checkToolCallsGardenPath,
  checkTopNeedDisposition,
  checkVagueDomainWorkLabel,
  checkVisualReferencePrecision,
  COMPOUND_HYPHENATION_RULES,
  evaluateCoverLetterChecks,
  extractResumeEvidence,
  fs,
  MAX_HYPHENATION_OBSERVATIONS,
  MAX_LETTER_FIGURES,
  MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS,
  MAX_SENTENCE_WORDS,
  MIN_ANCHOR_RELEVANCE_CORPUS_WORDS,
  MIN_CROSS_PARAGRAPH_REPEAT_WORDS,
  MIN_SAME_PARAGRAPH_REPEAT_WORDS,
  MIN_SHARED_SHAPE_PARAGRAPHS,
  SENTENCE_SHAPE_FRAME_WORDS,
  path,
  selectBetterLetterNeeds,
  sharedSentenceShapeCeiling,
  sentences,
  STACK_TOOL_LEXICON,
} from '../test-dependencies.js';
// Read at the source rather than through scripts/test-dependencies.js: that
// barrel is shared with every other test group and sits outside this task's file
// scope, and these three bindings are exactly what the repeated-run assertions
// below have to compare against the code that prints them — the rule text the
// letter contract carries, the content-word floor that text must state, and the
// relevance-span rule whose CHOICE of carriers settles the one apparent
// contradiction in this pair of checks.
import {
  ARGUMENT_RELEVANCE_SPAN_RULE, checkDanglingDemonstrative, checkRepeatedTransferCarrier, DANGLING_DEMONSTRATIVE_RULE,
  MIN_REPEAT_CONTENT_WORDS, REPEATED_PHRASE_RULE, REPEATED_TRANSFER_CARRIER_RULE,
} from '../../electron/ipc/coverLetterChecks.js';

function loadFixture(name) {
  const file = path.resolve('scripts/fixtures/cover-letter', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixtureBulletText(fixture) {
  return fixture.resumeMarkup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const evidence = {
  identity: {
    name: 'Maya Chen', tagline: 'Operations leader · B.S. Operations, Example University',
    subtitleRole: 'Operations leader', credential: 'B.S. Operations, Example University',
    contact: ['Toronto, ON', 'maya@example.test'],
  },
  bulletTexts: [
    'Triaged incomplete emergency reports under time pressure for a municipal operations team.',
    'Reduced response backlog by 32% while coordinating field crews across six districts.',
  ],
  roles: [{
    summary: 'Municipal operations leadership.',
    bullets: [{ text: 'Reduced response backlog by 32% while coordinating field crews across six districts.' }],
  }],
};

const groundedPlan = {
  roleThesis: 'Operational judgment under incomplete information is the capability this incident role needs.',
  mappings: [{
    needIndex: 0,
    evidence: 'Triaged incomplete emergency reports under time pressure',
    resumeStatus: 'implied',
    narrativeRole: 'primary',
    relationToPrevious: 'This primary proof establishes the thesis by showing judgment under incomplete information.',
  }],
  companyHook: { detail: '' },
};

const needs = [{
  need: 'manage incident escalation',
  quote: 'manage incident escalation',
  source: 'posting',
}];

// Sentences that mention a role, a position, or a posting without making the
// advertisement the subject of what it states or requires. The posting-
// reference family reads noun phrases anywhere in a sentence rather than a
// fixed bigram at the sentence start, so this corpus is what keeps that reach
// from swallowing the candidate's own past roles, prepositional objects,
// possessives, and ordinary product vocabulary.
const PROXIMAL_AND_ORDINARY_ROLE_PROSE = [
  'My role at Thomson School District was to keep the ticketing system dependable.',
  'In that role I wrote the migration scripts myself.',
  'The role I held at Horizon Health Alliance covered both intake and reporting.',
  'I would bring this to the role.',
  'The role I am applying for sits in your platform team.',
  'Each role taught me something about release discipline.',
  'My last role required me to run the on-call rotation.',
  'The position paper we published shaped the district data policy.',
  'I moved into a backend role after two release cycles.',
  'That role gave me the first taste of incident response.',
  'My understanding of the role is that it joins interface work with services.',
  'One requirement of the position is comfort with SQL.',
  'Everything I read about the role is consistent with the work I have done.',
  'The budget for the role is not something I would need to manage.',
  'Two of my previous roles required that kind of coordination.',
  'The role description parser I maintained is unrelated to this application.',
  'I stepped into the role of release coordinator during that migration.',
  'The position offered to me then was mostly maintenance.',
  'My role involved both interface work and data cleanup.',
  'The role at my current employer centers on reporting.',
  'I learned the most from the role that followed.',
  'This position sits between the field crews and the district office.',
  'This role requires steady prioritization when reports arrive incomplete.',
  'Your listing quality team ships the ranking model.',
  'The listing page I rebuilt cut abandoned carts.',
  'I rewrote the job description parser your team maintains.',
  'The position description identifies incident response as a core responsibility.',
  'The job posting describes the service team as responsible for release coordination.',
  'This job listing describes a rebuild that starts from years of existing workflows.',
  'Nothing in the role is unfamiliar to me.',
  'The work I did maps to the position without much translation.',
  'I have held the role of on-call engineer for a school district.',
  'The responsibilities of the role are familiar from my time at Thomson.',
  'A senior role is not what I am asking for.',
  'My role notes from that migration still guide how I document releases.',
  'The role of automated tests in that rebuild was to catch regressions early.',
  'Their position on data retention shaped how I built the exports.',
  'The position I left in 2023 was a support role.',
  'I would grow into the position over the first quarter.',
  'The hiring team knows the position better than I do.',
  'Reporting to the position manager would be new for me.',
  "Much of the position's day-to-day work resembles what I did at Thomson.",
  "I asked about the position's on-call expectations during the screen.",
  'The team behind the position is the one I would join.',
  'Nothing about the position needs explaining to someone who has done it.',
  'My position at Horizon Health Alliance was junior.',
  'I declined the position offer that arrived that spring.',
  'I appreciate the role focus on data quality that the work itself shows.',
  'The other role I considered involves far less backend work.',
  'The previous role centers on hardware, which is not where my work sits.',
  'Our automated posting pipeline published nightly reports for the district.',
  'A posting service I wrote kept the notice board current.',
  'The internal tools hub I built for the district is still in use.',
  'I read the description twice before writing this letter.',
  'I would adapt to whatever this role needs on day one.',
  "This role's emphasis on data quality matches what I practised.",
  'The support team role I filled covered both intake and reporting.',
  'The team I joined at Thomson is the one whose role definitions I rewrote.',
  'Their posting process runs nightly against the district calendar.',
  'I built the alerting that the on-call role depends on.',
  'Nothing in this letter restates the role description.',
  'The position title on my last offer letter read Support Engineer.',
  'The role of the district office is to coordinate between schools.',
  'The job I left was not a fit for the work I want to do.',
  'Every position I have held involved on-call work.',
  'The position, as I understand it, is mostly backend.',
  'The Intermediate Software Developer role I am applying for is the one I want.',
  'I would be the first person in the role.',
  'The role Thomson School District gave me is the closest match I have.',
  'The recent job posting describes the service team as responsible for release coordination.',
  'This job description states that engineers rotate through incident response.',
  'The position requirements I read match the work I did at Horizon Health Alliance.',
  'The role-based access control I added restricted the ticket queue by staff role.',
  'My first position out of school was mostly data entry.',
  'The second role I held there is the one that taught me SQL.',
  'The work sits closer to the role than my title suggests.',
  'I have never left a position without documenting the handover.',
];

// The letter of 2026-09-23, verbatim. It cleared the whole battery: no check in
// coverLetterChecks.js compared a paragraph to itself or to another paragraph.
// checkRedundancy and checkSalientPhraseEcho measure the letter against the
// RESUME, checkRepeatedSentenceShape erased every content word before it
// compared, and every other n-gram site takes its needle from the resume, the
// plan or a fixed list. So the same six words appeared twice in paragraph 1 and
// nothing said anything. Three tests read it, from three sides: the runs it
// repeats, the shapes its consecutive paragraphs share, and the one place those
// two checks answer differently about the same sentences.
const LETTER_THAT_RESTATES_ITSELF = [
  "AWS Workflow Experience's cross-stack work joins intuitive front-end experiences with the services and APIs that power them. My full-stack experience includes scalability across the UI and backend. At Thomson School District, as a Software Engineer, I developed a web app for internal tools with scalability across the UI and backend. The engineering challenge was planning for scalability as future additions changed the application. I would apply that scalability approach across UI and backend to feature design spanning front-end experiences and the services that power them.",
  "In that role, my application experience includes connected systems, device management platforms, and scan-triggered features. I developed the district's device check-in/check-out web app to work with a physical barcode scanner and device management platforms. The engineering challenge was coordinating connected features when one action triggered another. I would apply that connected-system experience to designing intuitive front-end behavior together with the services that power it.",
  'Operational handoffs add another layer to full-stack engineering. In that Software Engineer role, my migration experience spans integrations, data migration workflows, automation, validation, and operational tooling. I migrated ticketing and repair-tracking systems and associated data to third-party platforms. The work lay mainly in coordinating dependent activities during validation and transition. I can apply that operational transition approach to implementation, deployment, and ongoing operational health.',
  "I welcome a conversation about how my migration work with integrations and operational tooling could support your team's work designing, building, and operating features across front-end experiences, services, and APIs.",
];

// The letter paragraph every pipeline fixture in this repo writes, and the one
// the targeted exclusion has to stay silent on. Its transfer sentence re-names
// the capability its claim sentence named, because
// ARGUMENT_RELEVANCE_ANAPHORA_RULE permits a bare back-reference in six fixed
// phrases only, and it names the responsibility it reaches, because
// relevanceNamesNeed grades that span for its job need's own words. Both
// re-namings are mandated and both land inside one paragraph: comparing the whole
// sentence reported this paragraph at 38 of the 39 test sites in this repo that
// assert a contract-following letter is accepted.
const LETTER_WITH_MANDATED_RE_NAMINGS = 'My experience delivering supported systems is a relevant capability.'
  + ' In my engineering role at Acme, I updated supported systems for internal users.'
  + ' I would apply my experience delivering supported systems to reliable system delivery this role requires.';

// Paragraph 1 of the design system's own fixture letter, verbatim
// (Job Application Design System/uploads/Application.html). It names one
// artifact twice in one paragraph, in lowercase and in full, and says something
// different about it each time — which is why the old message, "the same
// statement made twice", was untrue of it, and why the run is still a defect.
const DESIGN_SYSTEM_ARTIFACT_PARAGRAPH = 'Most of what I built at Thomson School District eventually had to keep working'
  + ' against a third-party platform, which is the condition this role puts on every brand-specific feature delivered'
  + " over a shared core. I built the district's device check-in and check-out system from scratch, covering the laptops"
  + ' and iPads issued to staff and students. The tools we kept in house ran on a web hub I built full stack, with a'
  + ' React front end and a Django back end, containerized so it could be deployed on any VM the district had. When'
  + ' ticketing, device check-in and check-out, and repair tracking moved onto third-party solutions, I owned that'
  + ' transfer and the Python ETL that keeps the district information system and those platforms in agreement in both'
  + ' directions.';

// Ordinary prose whose only repeats are the syntax English hands a sentence. It
// is a negative control against a live cost: the first build of
// checkRepeatedPhrase had no content-word test, and a sweep of what it reported
// found every run listed below, each announced as "the same statement made
// twice" and each worth one manual handoff round. Nothing here is the letter
// restating itself, and the prose is deliberately dull rather than clean: it
// says a different thing in every sentence while reaching for the same
// function-word scaffolding, which is what ordinary writing does.
//
// Each run sits in two DIFFERENT sentences, because the check compares sentence
// against sentence and a run repeated inside one sentence is never compared at
// all, and the test measures that placement rather than trusting it.
const ORDINARY_SYNTAX_REPEATED_PROSE = [
  'The scan queue was one of the places a record could go missing. The nightly export was one of the others, and there was no audit trail behind it. In order to see where, I timed each step of the write path. There was no owner for the older records, so in order to reassign them I built a small review screen. Every reversal was a change that had to be logged, as well as the reason behind it. A refund was an entry that had to be approved, as well as the note a clerk left on it. I worked on the scanner path first. Then I worked on the ledger, which nobody had touched in a year.',
  'Reporting was the second half of the job. I was able to move the aggregation into a nightly job once the timings were in hand. At the same time the clerks wanted a weekly view, so the work had to fit around their Monday deadline. Coordination was one of the things nobody had budgeted for.',
  'The migration was the last piece. I was able to take the older records across without a freeze. At the same time two teams were editing the same records, so the work had to be reversible at every step. Sequencing was one of the things that decided the order.',
];
// The runs above, with the distance each one is repeated at, so the assertion
// can check every one against the floor its own distance uses instead of
// against a single number. Reported live, all ten of them.
const ORDINARY_SYNTAX_REPEATED_RUNS = [
  { run: 'one of the', distance: 'inside' },
  { run: 'in order to', distance: 'inside' },
  { run: 'there was no', distance: 'inside' },
  { run: 'that had to be', distance: 'inside' },
  { run: 'as well as the', distance: 'inside' },
  { run: 'i worked on the', distance: 'inside' },
  { run: 'i was able to', distance: 'across' },
  { run: 'at the same time', distance: 'across' },
  { run: 'the work had to', distance: 'across' },
  { run: 'was one of the things', distance: 'across' },
];

export default [
  {
    name: 'cover letter harness: role thesis is one specific controlling claim',
    run: () => {
      const specific = checkRoleThesis({ roleThesis: 'Making incomplete operational data actionable is the through-line this incident role needs.' });
      const missing = checkRoleThesis({ roleThesis: '' });
      const terse = checkRoleThesis({ roleThesis: 'Operational judgment matters.' });
      const generic = checkRoleThesis({ roleThesis: 'My experience aligns well with the requirements of this role.' });
      const multiSentence = checkRoleThesis({ roleThesis: 'I prioritize incomplete signals. I also coordinate teams.' });
      assert(specific.passed, `a specific one-sentence angle must pass: ${specific.detail}`);
      assert(!missing.passed && !terse.passed && !generic.passed && !multiSentence.passed,
        'missing, underdeveloped, generic, and multi-sentence theses must request a plan retry');
      return { specific: specific.detail, missing: missing.detail, terse: terse.detail, generic: generic.detail, multiSentence: multiSentence.detail };
    },
  },
  {
    name: 'cover letter harness: final résumé evidence extractor preserves real design-system structure',
    run: () => {
      const source = fs.readFileSync(path.resolve('Job Application Design System/resume.html'), 'utf8');
      const main = /<main\b[\s\S]*<\/main>/i.exec(source)?.[0] || '';
      const withReceipt = main
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<strong\b/, '<strong data-achievement-id="sample-receipt"');
      const extracted = extractResumeEvidence(withReceipt);
      assert(extracted.identity.name === 'Anya R. Castellanos'
        && extracted.identity.tagline.includes('Staff Engineer')
        && extracted.identity.tagline.includes('B.S. Computer Science')
        && extracted.identity.contact.length === 2,
      'identity and every nested contact item must come from the résumé header');
      // The shipped one-page sample intentionally keeps all three roles but
      // selects six high-value bullets, rather than preserving the former
      // two-page sample's ten-plus bullets. This checks the schema contract,
      // not a superseded density target.
      assert(extracted.roles.length === 3 && extracted.bulletTexts.length >= 6
        && extracted.skills.length === 3 && extracted.education.length === 1,
      'real design-system role, bullet, skill, and header-credential structures must be preserved');
      assert(extracted.bulletTexts.some(text => text.includes('trade-off:'))
        && extracted.achievementIds.includes('sample-receipt'),
      'annotation text and receipt ids must survive evidence extraction');
      assert(extracted.education[0].includes('B.S. Computer Science, Carnegie Mellon University'),
        'the header credential must remain available as structured degree evidence');
      return { roles: extracted.roles.length, bullets: extracted.bulletTexts.length, skills: extracted.skills.length };
    },
  },
  {
    name: 'cover letter harness: résumé receipt extraction is tag-agnostic and ordered',
    run: () => {
      const markup = '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example Co</span><ul class="highlights"><li>Python reduced latency by <span data-achievement-id="span-id">74%</span>, while <em data-achievement-id=\'em-id\'>10 hours</em> of support work remained; <strong data-achievement-id="strong-id">30%</strong> was retained and <span data-achievement-id="span-id">74%</span> was not duplicated.</li></ul></article></main>';
      const extracted = extractResumeEvidence(markup);
      const ids = extracted.roles[0].bullets[0].achievementIds;
      assert(JSON.stringify(ids) === JSON.stringify(['span-id', 'em-id', 'strong-id'])
        && JSON.stringify(extracted.achievementIds) === JSON.stringify(ids),
      'receipt IDs must be extracted from any inline element in markup order and deduplicated per bullet');
      return { receiptIds: ids.length };
    },
  },
  {
    name: 'cover letter harness: built-document decoys do not replace the real résumé evidence',
    run: () => {
      const realMain = '<main class="page"><header><h1 class="name">Real Candidate</h1><p class="tagline">Real Role</p><p class="contact">Toronto, ON<span class="sep">·</span>real@example.test</p></header><article class="role"><span class="title">Operator</span><span class="company">Real Co</span><ul class="highlights"><li>Handled real incidents under documented constraints.</li></ul></article></main>';
      const built = buildResumeDocument({ resumeMainHtml: realMain, docId: 'cover-evidence-decoy' })
        .replace('<style>', '<style>/* <main class="page"><h1 class="name">CSS Decoy</h1></main> */');
      const extracted = extractResumeEvidence(built);
      assert(extracted.identity.name === 'Real Candidate' && extracted.roles.length === 1
        && extracted.bulletTexts[0].includes('real incidents'),
      'extracting a built document must not silently select a commented <main> example');
      return { name: extracted.identity.name, roles: extracted.roles.length };
    },
  },
  {
    name: 'cover letter harness: evidence grounding accepts résumé evidence and rejects cross-candidate evidence',
    run: () => {
      const tightMatch = loadFixture('tight-match');
      const careerChanger = loadFixture('career-changer');
      const thin = loadFixture('thin-jd-no-research');
      const absentTopNeed = loadFixture('top-need-absent');
      const candidateAPlan = { ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], evidence: fixtureBulletText(tightMatch) }] };
      const pass = checkEvidenceGrounding(candidateAPlan, { bulletTexts: [fixtureBulletText(tightMatch)] });
      assert(pass.passed, `near-quoted résumé evidence must pass: ${pass.detail}`);
      assert(tightMatch.research && !thin.research && /credential/i.test(absentTopNeed.jobDescription), 'grouped harness fixtures must cover research, degrade, and top-need-absent cases');
      const candidateB = { bulletTexts: [fixtureBulletText(careerChanger)] };
      const fail = checkEvidenceGrounding(candidateAPlan, candidateB);
      assert(!fail.passed && fail.id === 'evidence-grounding', 'candidate A evidence against candidate B résumé is the required negative control');
      const secondaryOnlyFailure = checkEvidenceGrounding({
        ...groundedPlan,
        mappings: [
          { ...groundedPlan.mappings[0], evidence: 'Primary evidence stays exactly with this résumé bullet.' },
          { evidence: 'alpha beta gamma unrelated phrases remain safely distinct', narrativeRole: 'corroborates', relationToPrevious: 'This secondary proof would corroborate the primary evidence.' },
        ],
      }, {
        bulletTexts: [
          'Primary evidence stays exactly with this résumé bullet.',
          'alpha beta gamma delta epsilon',
        ],
      });
      assert(!secondaryOnlyFailure.passed
        && secondaryOnlyFailure.detail.includes('coverLetterArgument.secondaryEvidence.evidence')
        && secondaryOnlyFailure.detail.includes('mapping 2')
        && secondaryOnlyFailure.detail.includes('not cover-letter paragraph 2')
        && secondaryOnlyFailure.detail.includes('best contiguous run is 3 words (need 5)')
        && secondaryOnlyFailure.detail.includes('best token overlap is 38% (need 60%)'),
      'an ungrounded secondary argument anchor identifies its exact non-rendered field and both grounding thresholds');
      return { pass: pass.detail, negativeControl: fail.detail, secondaryDiagnostic: secondaryOnlyFailure.detail };
    },
  },
  {
    name: 'cover letter harness: need grounding checks the declared posting or research source',
    run: () => {
      const pass = checkNeedGrounding(needs, 'The role must manage incident escalation during on-call rotations.', '');
      assert(pass.passed, `verbatim posting quote must pass: ${pass.detail}`);
      const fail = checkNeedGrounding([{ ...needs[0], quote: 'lead global transformation' }], 'The role must manage incident escalation.', '');
      assert(!fail.passed, 'invented need quote must fail');
      const invalidSource = checkNeedGrounding([{ ...needs[0], source: 'either' }], 'The role must manage incident escalation.', 'manage incident escalation');
      assert(!invalidSource.passed && invalidSource.detail.includes('invalid source'),
        'an undeclared source must not pass merely because its quote appears somewhere in the combined corpus');
      return { pass: pass.detail, fail: fail.detail, invalidSource: invalidSource.detail };
    },
  },
  {
    name: 'cover letter harness: redundancy allows topical evidence but blocks copied runs',
    run: () => {
      const pass = checkRedundancy(['That triage work taught me how to rank incomplete information when escalation cannot wait.'], evidence);
      assert(pass.passed, `interpretive topical overlap must pass: ${pass.detail}`);
      const fail = checkRedundancy(['I reduced response backlog by 32% while coordinating field crews across six districts.'], evidence);
      assert(!fail.passed, 'an eight-word copied résumé run must fail');
      assert(fail.detail.includes('paragraph 1') && fail.detail.includes('résumé bullet 2')
        && fail.detail.includes('12-word run') && fail.detail.includes('“reduced response backlog by 32 while coordinating field crews across six districts”'),
      'a redundancy observation must name the paragraph, bullet, run length, and exact shared phrase for the one revision attempt');
      return { pass: pass.detail, fail: fail.detail };
    },
  },
  {
    name: 'cover letter harness: distinctive short source wording is paraphrased across documents',
    run: () => {
      const source = { bulletTexts: ['Built from scratch a Django hub for retained internal tools.'] };
      const repeated = checkSalientPhraseEcho(['I built from scratch a Django application for the district.'], source);
      const paraphrased = checkSalientPhraseEcho(['I designed and implemented a Django application for the district.'], source);
      assert(!repeated.passed && repeated.detail.includes('built from scratch'),
        'a distinctive three-word résumé phrase must be revision work even below the general eight-word threshold');
      assert(paraphrased.passed, `a fact-preserving natural paraphrase must pass: ${paraphrased.detail}`);
      return { repeated: repeated.detail, paraphrased: paraphrased.detail };
    },
  },
  {
    name: 'cover letter harness: generic phrases and banned openers are detected',
    run: () => {
      const pass = checkGenericPhrases(['The role needs careful escalation decisions when reports are incomplete.']);
      assert(pass.passed, `specific opener must pass: ${pass.detail}`);
      const phrase = BANNED_GENERIC_PHRASES[1];
      const fail = checkGenericPhrases([`I am excited to apply because I have a ${phrase}.`]);
      assert(!fail.passed, 'banned generic phrase or first-sentence opener must fail');
      const typographic = checkGenericPhrases(['I am excited to apply—because the role is important.']);
      assert(!typographic.passed, 'a typographic dash must not let a banned opener evade detection');
      const applicationAnnouncements = [
        'I am writing to apply for the Senior Engineer role.',
        "I'm writing to apply for the Senior Engineer role.",
        'I’m writing to apply for the Senior Engineer role.',
        'I am applying for the Senior Engineer role.',
        "I'm applying for the Senior Engineer role.",
        'I’m applying for the Senior Engineer role.',
        'Please accept my application for the Senior Engineer role.',
      ].map(paragraph => checkGenericPhrases([paragraph]));
      assert(applicationAnnouncements.every(check => !check.passed && check.detail.includes('banned opener')),
        'expanded and contracted application-announcement openers must all request revision');
      const apiLoopAnnouncements = [
        'I am applying for the Senior Engineer role.',
        'Please accept my application for the Senior Engineer role.',
      ].map(paragraph => evaluateCoverLetterChecks({
        plan: { mappings: [], companyHook: { detail: '' } },
        paragraphs: [paragraph], evidence, researchText: '', companyName: '',
      }));
      assert(apiLoopAnnouncements.every(checks => checks.some(check => check.id === 'generic-phrases' && !check.passed)),
        'the API prose-revision loop must receive application-announcement opener failures');
      const spacedHyphen = checkGenericPhrases(['I thrive in a fast paced environment with explicit constraints.']);
      assert(!spacedHyphen.passed, 'spacing a hyphenated banned phrase must not evade the generic-language check');
      const hendrickOpener = checkGenericPhrases(['The role needs more than basic presence; it demands a professional with a proven three-year track record.']);
      const hendrickMapping = checkGenericPhrases(['Verifying identification was not merely administrative; it was the primary line of defense and gave me this exact foundation.']);
      assert(!hendrickOpener.passed && hendrickOpener.detail.includes('proven … track record'),
        'a short modifier such as “three-year” must not let the Hendrick-style proven-track-record cliché pass');
      assert(!hendrickMapping.passed && hendrickMapping.detail.includes('primary line of defense'),
        'narrow, high-frequency Hendrick-style rhetorical clichés must request revision');
      assert(BANNED_GENERIC_PATTERNS.length >= 4,
        'modifier-resistant patterns remain an explicit, auditable small list rather than a hidden style scorer');
      const allObservations = checkGenericPhrases([
        'This exact foundation comes from a proven three-year track record.',
        'The work was the primary line of defense.',
      ]);
      const overflow = checkGenericPhrases(Array.from({ length: 20 }, () => 'This exact foundation comes from a proven three-year track record.'));
      assert(!allObservations.passed && allObservations.detail.includes('paragraph 1 contains banned generic pattern “proven … track record”')
        && allObservations.detail.includes('paragraph 1 contains banned generic pattern “exact foundation”')
        && allObservations.detail.includes('paragraph 2 contains banned generic pattern “primary line of defense”'),
      'one revision observation must disclose every distinct generic problem across paragraphs');
      assert(!overflow.passed && overflow.detail.includes('additional observation(s) omitted') && overflow.detail.length < 2400,
        'generic-observation detail remains bounded for hostile multi-paragraph output');
      const precise = checkGenericPhrases(['An unproven track record would be a concern, so I rely on documented incident outcomes.']);
      assert(precise.passed, 'word-substring collisions must not falsely revise a specific, non-generic sentence');
      const hollowDoublet = checkGenericPhrases(['I gave the board a clear view of the downsides and trade-offs of that approach.']);
      const namedJudgement = [
        'The migration surfaced limitations in the vendor tooling as well as strengths in our own.',
        'I documented the benefits of the migration as well as its limitations.',
      ].map(paragraph => checkGenericPhrases([paragraph]));
      assert(!hollowDoublet.passed && hollowDoublet.detail.includes('downsides and trade-offs')
        && namedJudgement.every(check => check.passed),
      'only the fixed hollow doublet is banned: this id is a hard gate on the Local AI path, so a sentence naming a specific judgment must never reject a completed run');
      return { pass: pass.detail, fail: fail.detail, typographic: typographic.detail, applicationAnnouncements: applicationAnnouncements.map(check => check.detail), spacedHyphen: spacedHyphen.detail, hendrickOpener: hendrickOpener.detail, hendrickMapping: hendrickMapping.detail, allObservations: allObservations.detail, precise: precise.detail };
    },
  },
  {
    name: 'cover letter harness: malformed sentence-initial experience infinitives request one grammar revision',
    run: () => {
      const fail = checkExperienceInfinitiveGrammar(['My experience to enforce access control policies taught me to make careful entry decisions.']);
      assert(!fail.passed && fail.id === 'experience-infinitive-grammar'
        && fail.detail.includes('paragraph 1') && fail.detail.includes('My experience enforcing'),
      'the malformed exported construction must produce a specific gerund correction');
      const toDate = checkExperienceInfinitiveGrammar(['My experience to date has taught me to make careful entry decisions.']);
      const withNoun = checkExperienceInfinitiveGrammar(['My experience with access control policies taught me to make careful entry decisions.']);
      assert(toDate.passed && withNoun.passed,
        'valid experience constructions must not be mistaken for the narrow infinitive error');
      return { fail: fail.detail, toDate: toDate.detail, withNoun: withNoun.detail };
    },
  },
  {
    name: 'cover letter harness: Hendrick-like generic duration rhetoric cannot receive a clean prose score',
    run: () => {
      const paragraphs = [
        'Protecting patients, staff, and assets requires a Security Officer I who brings more than basic presence; it demands a professional with a proven three-year track record of rigorous access control, perimeter protection, and vigilant surveillance in high-traffic environments. Derrick Coleman offers this exact foundation, prepared to deliver continuous, round-the-clock vigilance across full-time, evening, overnight, and weekend shifts.',
        'At Mid-South Corporate Center, verifying employee and visitor identification at all entry points was not merely administrative; it was the primary line of defense. This continuous practice builds the sharp, repetitive judgment required to enforce strict safety policies.',
      ];
      const checks = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs,
        evidence: {
          bulletTexts: ['Manage facility access by verifying employee and visitor identification at all entrances and exits to maintain a secure perimeter.'],
        },
        researchText: '',
      });
      const generic = checks.find(check => check.id === 'generic-phrases');
      const figures = checks.find(check => check.id === 'figure-discipline');
      const logistics = checks.find(check => check.id === 'logistics-exclusion');
      assert(!generic.passed && generic.detail.includes('paragraph 1 contains banned generic pattern “proven … track record”')
        && generic.detail.includes('paragraph 2 contains banned generic pattern “primary line of defense”')
        && !figures.passed && figures.detail.includes('“three-year”'),
      'the Hendrick regression must trigger both modifier-resistant generic and spelled-duration grounding checks');
      assert(logistics.passed,
        'impersonal coverage language is not mistaken for a candidate-specific application logistics promise');
      return { generic: generic.detail, figures: figures.detail, logistics: logistics.detail };
    },
  },
  {
    name: 'cover letter harness: company specificity requires a research detail and skips honestly without research',
    run: () => {
      const pass = checkCompanySpecificity(['Your Northstar Dispatch program makes the incident model concrete.'], 'Northstar Dispatch expanded its regional incident program in 2024.', 'Acme');
      assert(pass.passed, `capitalized research detail must pass: ${pass.detail}`);
      const fail = checkCompanySpecificity(['Acme is a company I want to join.'], 'Acme announced a regional incident program.', 'Acme');
      assert(!fail.passed, 'a bare company mention must not satisfy research specificity');
      const multiWordCompanyOnly = checkCompanySpecificity(['Acme Global Systems is a company I want to join.'], 'Acme Global Systems announced a regional incident program.', 'Acme Global Systems');
      assert(!multiWordCompanyOnly.passed, 'a capitalized bigram inside a multi-word company name must not satisfy research specificity');
      const unicode = checkCompanySpecificity(['Votre Équipe Atlas rend cette direction concrète.'], 'Équipe Atlas a étendu son programme régional.', 'Acme');
      assert(unicode.passed && unicode.detail.includes('Équipe Atlas'),
        'Unicode capitalized research details must be recognized rather than rejected by ASCII-only word boundaries');
      const yearOnly = checkCompanySpecificity(['Acme expanded the program in 2024.'], 'Acme expanded Northstar Dispatch in 2024.', 'Acme');
      const figureOnly = checkCompanySpecificity(['Acme reported 32% growth.'], 'Acme reported 32% growth for Northstar Dispatch.', 'Acme');
      assert(!yearOnly.passed && !figureOnly.passed,
        'a research-sourced year or figure cannot substitute for the required proper-name detail');
      const plannedMismatch = checkCompanySpecificity(
        ['The Atlas Program makes this direction concrete.'],
        'Northstar Dispatch and Atlas Program support distinct operations.',
        'Acme',
        'Northstar Dispatch',
      );
      assert(!plannedMismatch.passed && plannedMismatch.detail.includes('Northstar Dispatch'),
        'prose must preserve the planned proper detail, not swap in a different research bigram');
      const skipped = checkCompanySpecificity(['A focused argument.'], '', 'Acme');
      assert(skipped.passed && skipped.detail.includes('skipped'), 'unavailable research must skip rather than fail');
      return { pass: pass.detail, fail: fail.detail, multiWordCompanyOnly: multiWordCompanyOnly.detail, unicode: unicode.detail, yearOnly: yearOnly.detail, figureOnly: figureOnly.detail, plannedMismatch: plannedMismatch.detail, skipped: skipped.detail };
    },
  },
  {
    name: 'cover letter harness: prose shape requires body copy without paragraph or word caps',
    run: () => {
      const plan = { mappings: [{}], companyHook: { detail: 'Northstar Dispatch' } };
      const combined = checkShape(plan, ['A single paragraph may combine the complete argument naturally.']);
      assert(combined.passed, `a plan must not dictate paragraph count: ${combined.detail}`);
      const split = checkShape(plan, ['Thesis.', 'Evidence.', 'Interpretation.', 'Company relevance.']);
      assert(split.passed, `the writer may split the argument where clarity warrants it: ${split.detail}`);
      const longOnePageCandidate = checkShape({ mappings: [], companyHook: { detail: '' } }, [Array(1000).fill('word').join(' ')]);
      assert(longOnePageCandidate.passed, 'shape checks must not impose a word-count limit; rendered page fit owns length');
      const empty = checkShape(plan, [' ', '']);
      assert(!empty.passed, 'cover-letter body must retain at least one usable paragraph');
      return { combined: combined.detail, split: split.detail, longOnePageCandidate: longOnePageCandidate.detail, empty: empty.detail };
    },
  },
  {
    name: 'cover letter harness: figure discipline limits and grounds every number',
    run: () => {
      const pass = checkFigureDiscipline(['The 32% backlog reduction shows how I prioritize constrained work.'], evidence);
      assert(pass.passed, `résumé-backed figure must pass: ${pass.detail}`);
      const invented = checkFigureDiscipline(['I improved outcomes by 47%.'], evidence);
      assert(!invented.passed && invented.detail.includes('“47%”'), 'a figure absent from résumé evidence must fail with the exact missing figure');
      const tooMany = checkFigureDiscipline(['32% $40 2026 32%'], evidence);
      assert(!tooMany.passed && tooMany.detail.includes(`${MAX_LETTER_FIGURES + 1} figures`)
        && tooMany.detail.includes('“$40”') && tooMany.detail.includes('“2026”'),
      'one figure result must combine an over-limit count/list with every distinct résumé-missing figure');
      const currencyMismatch = checkFigureDiscipline(['The $32 improvement shows disciplined prioritization.'], evidence);
      assert(!currencyMismatch.passed && currencyMismatch.detail.includes('“$32”'),
        'currency signs are part of a numeric claim: an un-currency-qualified 32% must not ground $32');
      const signMismatch = checkFigureDiscipline(['The -32% change shows disciplined prioritization.'], evidence);
      assert(!signMismatch.passed && signMismatch.detail.includes('“-32%”'),
        'a leading sign changes the claim and must not be silently discarded during figure grounding');
      const rangedEvidence = { bulletTexts: ['Maintained the program from 2024–2025 while reducing turnaround by 10-20%.'] };
      const yearRange = checkFigureDiscipline(['The 2025 endpoint shows the later operating context.'], rangedEvidence);
      const numericRange = checkFigureDiscipline(['The 20% endpoint frames the result without adding a new figure.'], rangedEvidence);
      const currencyRangeEvidence = { bulletTexts: ['Managed a $10–$20 operating range.'] };
      const currencyRange = checkFigureDiscipline(['The $20 endpoint frames the operating range.'], currencyRangeEvidence);
      const signedCurrency = checkFigureDiscipline(['The $20 amount is not the documented -$20 exception.'], { bulletTexts: ['Documented a -$20 exception.'] });
      assert(yearRange.passed && numericRange.passed && currencyRange.passed,
        'both endpoints of hyphen/en-dash ranges, including a currency-marked right endpoint, must be available as unsigned résumé figures');
      assert(!signedCurrency.passed && signedCurrency.detail.includes('“$20”'),
        'a signed currency figure remains distinct when no numeric left range endpoint exists');
      const spelledDuration = checkFigureDiscipline(['A proven three-year track record supports careful access decisions.'], { bulletTexts: ['Managed access control from October 2022 to the present.'] });
      const groundedSpelledDuration = checkFigureDiscipline(['Three-year access-control experience supports careful entry decisions.'], { bulletTexts: ['Built three years of access-control experience.'] });
      assert(!spelledDuration.passed && spelledDuration.detail.includes('“three-year”'),
        'a spelled-out duration must not evade figure grounding merely because it has no digit');
      assert(groundedSpelledDuration.passed,
        'hyphenated and spaced spelled-out duration forms normalize to the same résumé-backed figure');
      const malformed = checkFigureDiscipline(['I improved outcomes by 47%.'], { roles: {}, skills: null, education: 'not-an-array' });
      assert(!malformed.passed && malformed.detail.includes('“47%”'),
        'a malformed legacy evidence payload must yield a failed observation, never throw and abort the cover-letter artifact');
      const manyMissing = checkFigureDiscipline([Array.from({ length: 30 }, (_, index) => `${1000 + index}%`).join(' ')], evidence);
      assert(!manyMissing.passed && manyMissing.detail.includes('…') && manyMissing.detail.length < 1000,
        'a hostile number-heavy response must produce bounded revision/diagnostic detail rather than an unbounded payload');
      const unselectedCoincidence = checkFigureDiscipline(
        ['Acme reported a 32% company result.'],
        evidence,
        { mappings: [{ evidence: 'Triaged incomplete emergency reports under time pressure.' }] },
      );
      assert(!unselectedCoincidence.passed && unselectedCoincidence.detail.includes('“32%”'),
        'a figure elsewhere in the résumé cannot authorize planned prose when no selected mapping carries it');
      return { pass: pass.detail, invented: invented.detail, tooMany: tooMany.detail, currencyMismatch: currencyMismatch.detail, signMismatch: signMismatch.detail, spelledDuration: spelledDuration.detail, malformed: malformed.detail, unselectedCoincidence: unselectedCoincidence.detail, bounded: manyMissing.detail.length };
    },
  },
  {
    name: 'cover letter harness: compound hyphenation flags a missing hyphen and leaves bare adverbial and noun forms alone',
    run: () => {
      const fail = checkCompoundHyphenation([
        'We kept the scheduling core in house and gave one team end to end ownership of the district wide rollout, its third party integrations, and its real time dashboards.',
        'The desk ran a check in and check out process for loaner hardware, and we published the open source tools behind it.',
      ]);
      assert(!fail.passed && fail.id === 'compound-hyphenation'
        && fail.detail.includes('paragraph 1 writes “in house”; write “in-house” (hyphenate the compound modifier)')
        && fail.detail.includes('write “end-to-end ownership”')
        && fail.detail.includes('write “district-wide”')
        && fail.detail.includes('write “third-party integrations”')
        && fail.detail.includes('write “real-time dashboards”')
        && fail.detail.includes('paragraph 2 writes “check in and check out process”; write “check-in / check-out process”')
        && fail.detail.includes('write “open-source tools”'),
      'every covered compound must name its paragraph, the written form, and the concrete hyphenated replacement');
      const legal = checkCompoundHyphenation([
        'My experience to date is in-house work, so I own end-to-end ownership of the full stack.',
        'We placed the loaner laptops end to end on the counter while students checked in devices at the desk.',
      ]);
      assert(legal.passed,
        `already-hyphenated modifiers, the bare adverbial, the noun “the full stack”, and conjugated check-in verbs are defensible register: ${legal.detail}`);
      const oneDirection = checkCompoundHyphenation(['I ran the check out kiosk for loaner hardware.']);
      assert(!oneDirection.passed
        && oneDirection.detail.includes('paragraph 1 writes “check out kiosk”; write “check-out kiosk”')
        && !oneDirection.detail.includes('check-in'),
      'the suggestion names only the direction the letter wrote: the revision prompt applies a hyphenation suggestion verbatim, so the paired form would add a duty the résumé never evidenced');
      const overflow = checkCompoundHyphenation(Array.from({ length: 12 }, () => 'The team kept the roster in house.'));
      assert(!overflow.passed && overflow.detail.includes('additional observation(s) omitted')
        && MAX_HYPHENATION_OBSERVATIONS === 8 && overflow.detail.length < 2400,
      'hyphenation detail remains bounded for hostile multi-paragraph output');
      assert(COMPOUND_HYPHENATION_RULES.length >= 8
        && COMPOUND_HYPHENATION_RULES.every(rule => rule.label && rule.pattern && rule.suggestion),
      'the hyphenation rules stay an explicit, auditable closed list rather than a general orthography scorer');
      return { fail: fail.detail, legal: legal.detail, rules: COMPOUND_HYPHENATION_RULES.length };
    },
  },
  {
    name: 'cover letter harness: parallel ranges, prior-employer openings, and domain labels receive concrete repairs',
    run: () => {
      const faulty = checkParallelStructure(['I evaluated each product from the quote request through presenting findings to management.']);
      const opaque = checkParallelStructure(['I evaluated third-party products, running each from the quote request through a findings presentation to management.']);
      const parallel = checkParallelStructure([
        'I evaluated each product from requesting quotes to presenting findings for management.',
        'I evaluated each product from the initial request for quotes to the presentation of findings.',
        'I requested quotes, assessed each product, and presented findings to management.',
        'I held that role from January 2019 through March 2023.',
      ]);
      const steward = checkParallelStructure(['I ran the evaluations, carrying each one from the quote request through the final analysis for management.']);
      const transfer = checkParallelStructure(['I wrote the Python ETL that moved each record from the student information system to the vendor warehouse.']);
      const span = checkParallelStructure(['I owned that work from the first scoping call through the final handoff.']);
      assert(!faulty.passed && faulty.id === 'parallel-structure'
        && faulty.detail.includes('from the quote request through presenting')
        && !opaque.passed && opaque.detail.includes('run each from X through Y')
        && parallel.passed,
      'the runtime check rejects noun-to-gerund and opaque run-range defects while accepting parallel or explicit actions');
      assert(!steward.passed && steward.detail.includes('run each from X through Y') && transfer.passed,
        'the opaque-range anchor covers every stewardship verb, so a paraphrase from ran to carrying cannot route around it, while a concrete transfer between two real systems stays acceptable');
      assert(!span.passed && span.detail.includes('inclusive numeric or calendar ranges')
        && parallel.passed,
        'a span between prose endpoints ends with to, and through survives only for an enumerable series');

      const entailed = checkEntailedPremise(['Before those products were adopted, the district had to choose them, and I ran the evaluations.']);
      const informative = checkEntailedPremise([
        'Before the district adopted a vendor, I had to evaluate the market.',
        'Before the migration shipped, I had to map every field by hand.',
      ]);
      assert(!entailed.passed && entailed.id === 'entailed-premise'
        && entailed.detail.includes('already entails the choice')
        && informative.passed,
      'a setup clause is rejected only when the acquisition it names already entails the obligation it claims');

      const abrupt = checkPriorEmployerOpening(
        ['At Thomson School District, I evaluated third-party products before district-wide adoption.'],
        ['Thomson School District'],
      );
      const framed = checkPriorEmployerOpening(
        ['In my previous software engineering role at Thomson School District, I evaluated third-party products before district-wide adoption.'],
        ['Thomson School District'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('without the candidate\'s role or relationship')
        && framed.passed,
      'a prior employer in the opening is contextualized for a reader who does not know the organization');

      const broadDomain = checkVagueDomainWorkLabel(['My aviation work extends this evidence with software design.']);
      const concreteDomain = checkVagueDomainWorkLabel(['My work on flight-route-optimization software extends this evidence with software design.']);
      assert(!broadDomain.passed && broadDomain.detail.includes('name the supported software, system, or responsibility')
        && concreteDomain.passed,
      'cross-domain evidence names the concrete work rather than implying broad industry or operational tenure');
      const vagueActors = checkReferenceClarity([
        'I moved ticketing across with their data.',
        'The platforms produced data they used and data they returned.',
        'I synchronized FAA releases through their APIs.',
      ]);
      const namedActors = checkReferenceClarity(['I ingested vendor data, delivered feeds to each vendor, and synchronized FAA releases through the agency APIs.']);
      assert(!vagueActors.passed && vagueActors.detail.includes('name the data owner, producer, consumer, vendor, or agency explicitly')
        && namedActors.passed,
      'data-flow prose names producers, consumers, vendors, and agencies instead of plural pronouns');
      const detachedModifier = checkModifierAttachment(['Modified A*, applying it to flight routing after testing candidate algorithms.']);
      const attachedModifier = checkModifierAttachment(['After testing candidate algorithms, I adapted A* for flight routing.']);
      assert(!detachedModifier.passed && detachedModifier.detail.includes('move the earlier action beside “after”')
        && attachedModifier.passed,
      'temporal modifiers remain beside the action they modify');
      return { faulty: faulty.detail, opaque: opaque.detail, abrupt: abrupt.detail, broadDomain: broadDomain.detail, vagueActors: vagueActors.detail, detachedModifier: detachedModifier.detail };
    },
  },
  {
    name: 'cover letter harness: anchor relevance licenses posting-named tools and flags an off-posting stack tour',
    run: () => {
      const posting = [
        'Cedar Ridge Learning is hiring an engineer to extend the React interface that school registrars use every day.',
        'The work sits between the registrar desk and the district office, so you will follow a signed form from the desk where it is handed in to the record that proves it was filed.',
        'You will own the Postgres data model that carries attendance, permission, and transfer records for eleven schools.',
        'We care about how you find the failure point in that path, not about the length of a tool list.',
      ].join(' ');
      const dump = checkAnchorRelevance(['I rebuilt the reporting service around Django, Nginx, Gunicorn, and Docker Compose behind a TypeScript client.'], posting, '');
      assert(!dump.passed && dump.id === 'anchor-relevance'
        && dump.detail.includes('paragraph 1 names 5 stack tools the posting and research never mention')
        && dump.detail.includes('“Docker Compose”') && !dump.detail.includes('“Docker”,')
        && dump.detail.includes('letter names 5 stack tools the posting and research never mention'),
      'an unlicensed stack list is reported per paragraph and letter-wide, and longest-first matching counts “Docker Compose” once');
      const licensedPair = checkAnchorRelevance(['I extended the React interface against the Postgres schema that carried attendance records.'], posting, '');
      const singleAnchor = checkAnchorRelevance(['I moved the nightly aggregation onto a Kubernetes cluster after the cron host kept losing runs.'], posting, '');
      assert(licensedPair.passed && singleAnchor.passed,
        'two posting-named tools and one off-posting concrete anchor both stay inside the letter budget');
      const tour = checkAnchorRelevance([
        'The scheduler runs on Kubernetes.',
        'The queue runs on Kafka.',
        'The cache runs on Redis.',
      ], posting, '');
      assert(!tour.passed && tour.detail.includes('letter names 3 stack tools') && !tour.detail.includes('paragraph 1 names'),
        'a stack tour spread one name per paragraph still fails letter-wide with no paragraph-level observation');
      const dockerPosting = [
        'Brightpath District runs its student services platform on a small internal team and deploys every service with Docker.',
        'You would take over the nightly aggregation that reconciles attendance against transport records, and you would own the release path from a merged branch to a running container.',
        'The platform serves nine schools, and a failed release is felt at the front desk within minutes, so we ask for a clear account of how you keep releases boring.',
      ].join(' ');
      const flavour = checkAnchorRelevance(['The service ships under Docker Compose and a Kubernetes cron job.'], dockerPosting, '');
      assert(flavour.passed, `a posting naming “Docker” licenses the “Docker Compose” flavour of it: ${flavour.detail}`);
      const researchCorpus = [
        'The Cedar Ridge platform team publishes engineering notes describing a Django application served behind Nginx.',
        'Their most recent note walks through the registrar import path, the queue that retries a failed import, and the review step a district administrator performs before records become visible to a school.',
        'The team describes itself as small, long-tenured, and responsible for the whole path from intake form to filed record.',
      ].join(' ');
      const research = checkAnchorRelevance(['I rebuilt the reporting service around Django and Nginx.'], '', researchCorpus);
      const skipped = checkAnchorRelevance(['I rebuilt the reporting service around Django, Nginx, and Gunicorn.'], '', '');
      assert(research.passed && skipped.passed && skipped.detail.includes('skipped: no posting or research text supplied'),
        'research text licenses a name too, and a missing corpus skips rather than rewriting the whole letter');
      // An unscraped job description is a supported state, and the deterministic
      // corpus still carries title/company/location/salary. That metadata can
      // license a name it happens to contain, but it can never show that the
      // employer does not want one, so the check must skip rather than report
      // every résumé-grounded anchor in the letter as off-posting.
      const metadataOnly = checkAnchorRelevance([
        'I rebuilt the reporting service with Django after the nightly export kept losing rows.',
        'I put Redis behind the intake form so a resubmitted application could not create a second record.',
        'I shipped a React dashboard that showed the registrar which forms were still unfiled.',
      ], 'Data Engineer\nAcme Analytics\nAustin, TX\n$140,000 to $180,000 a year', '');
      assert(metadataOnly.passed && metadataOnly.detail.includes('skipped: posting and research text supply only')
        && MIN_ANCHOR_RELEVANCE_CORPUS_WORDS > 25,
      'a metadata-only corpus is not evidence of absence: the floor must stay above the words a title, company, location, and salary contribute');
      assert(!STACK_TOOL_LEXICON.some(entry => ['Go', 'Swift', 'R', 'C', 'D'].includes(entry))
        && STACK_TOOL_LEXICON.includes('React') && STACK_TOOL_LEXICON.includes('Docker Compose'),
      'tokens that are ordinary English words or common names stay out of the case-sensitive lexicon');
      return { dump: dump.detail, licensedPair: licensedPair.detail, tour: tour.detail, flavour: flavour.detail, skipped: skipped.detail };
    },
  },
  {
    name: 'cover letter harness: target-position and advertisement references are read as noun phrases wherever they stand',
    run: () => {
      // Measured on a letter this battery passed. Two stackable evasions
      // defeated the shipped patterns: a job title between the determiner and
      // the head noun, and a clause fronted in front of the phrase. The
      // contract promises this construction is reported wherever it stands,
      // so each evasion, and the two together, are the test.
      const titled = checkPostingReference([
        'The Intermediate Software Developer role centers on frontend user interfaces and backend services.',
      ]);
      assert(!titled.passed && titled.id === 'posting-reference'
        && titled.detail.includes('detached target-position reference')
        && titled.detail.includes('(\u201CThe Intermediate Software Developer role centers\u201D)'),
      'a job title between the determiner and the head noun does not hide the target position from the check');
      const fronted = checkPostingReference([
        'At Axonify, the role centers on frontend user interfaces and backend services.',
      ]);
      assert(!fronted.passed && fronted.detail.includes('(\u201Cthe role centers\u201D)'),
        'a fronted clause does not hide the target position from the check');
      // The live letter's own opening, which combined both evasions and was
      // accepted, and the repair the observation names.
      const live = checkPostingReference([
        'At Axonify, the Intermediate Software Developer role centers on frontend user interfaces and backend services. I would apply this experience to features that cross frontend user interfaces and backend services.',
      ]);
      assert(!live.passed
        && live.detail.includes('(\u201Cthe Intermediate Software Developer role centers\u201D)')
        && live.detail.includes('use a proximal reference for the position attached to this application'),
      'both evasions combined are still reported, and the observation names the repair');
      const repairedLive = checkPostingReference([
        'At Axonify, this role centers on frontend user interfaces and backend services. I would apply this experience to features that cross frontend user interfaces and backend services.',
      ]);
      assert(repairedLive.passed,
        `the proximal reference the observation asks for is accepted in the same round: ${repairedLive.detail}`);
      // The same two evasions on the sibling rule in the same contract clause.
      const titledSource = checkPostingReference([
        'The Intermediate Software Developer role states that engineers rotate through incident response.',
        'At Axonify, the position states that engineers rotate through incident response.',
      ]);
      assert(!titledSource.passed
        && titledSource.detail.includes('paragraph 1 makes the target position the source of a statement')
        && titledSource.detail.includes('paragraph 2 makes the target position the source of a statement'),
      'a modifier and a fronted clause do not hide a reporting target position either');
      // The advertisement nouns carry the same promise and the same evasion.
      const modifiedAdvertisement = checkPostingReference([
        'Your recent posting asks for dependable delivery.',
        'I read this recent advertisement before writing.',
      ]);
      assert(!modifiedAdvertisement.passed
        && modifiedAdvertisement.detail.includes('(\u201CYour recent posting\u201D)')
        && modifiedAdvertisement.detail.includes('(\u201Cthis recent advertisement\u201D)'),
      'a modifier in front of an advertisement noun does not hide the reference');
      // The one sanctioned exception has to reach as far as the rule it is an
      // exception to, or a writer is rejected for a word the exception cannot
      // read; the bare form it is distinguished from still excludes the
      // specificity words that name the document.
      const modifiedAttribution = checkPostingReference([
        'The recent job posting describes the service team as responsible for release coordination.',
      ]);
      assert(modifiedAttribution.passed,
        `a specifically named source document may still own its reporting verb with a modifier: ${modifiedAttribution.detail}`);
      const modifiedBareListing = checkPostingReference([
        'The recent listing describes a rebuild that starts from years of existing workflows.',
      ]);
      assert(!modifiedBareListing.passed
        && modifiedBareListing.detail.includes('underspecified source attribution (\u201CThe recent listing describes\u201D)'),
      'a modifier does not make a bare listing a specifically named source document');
      // The exemption the observation itself states, now readable by the code
      // that produces it rather than only by the reader of the message.
      const contrasted = checkPostingReference([
        'The previous role centers on hardware, which is not where my work sits.',
        'The other role I considered involves far less backend work.',
      ]);
      assert(contrasted.passed,
        `a reference marked as a different role is the contrast the observation exempts: ${contrasted.detail}`);
      // False positives are the risk this reach creates, so the corpus is the
      // gate: the candidate's own past roles, prepositional objects,
      // possessives, relative clauses, and product vocabulary all stay legal.
      const rejected = PROXIMAL_AND_ORDINARY_ROLE_PROSE
        .filter(sentence => !checkPostingReference([sentence]).passed);
      assert(PROXIMAL_AND_ORDINARY_ROLE_PROSE.length >= 40 && !rejected.length,
        `role and posting prose that never makes the advertisement the subject stays accepted: ${JSON.stringify(rejected)}`);
      return { corpus: PROXIMAL_AND_ORDINARY_ROLE_PROSE.length, live: live.detail };
    },
  },
  {
    name: 'cover letter harness: additive seams, advertisement references, and asserted equivalences request an argumentative repair',
    run: () => {
      const seam = checkAdditiveSeam([
        'I built an internal scheduling tool from scratch. I also wrote a grading assistant for the same district.',
        'I built a parent notification tool too.',
      ]);
      assert(!seam.passed && seam.id === 'additive-seam'
        && seam.detail.includes('paragraph 1 appends evidence with a bare additive connective (“I also wrote a grading assistant for the …”)')
        && seam.detail.includes('paragraph 2 appends evidence with a bare additive connective (“I built a parent notification tool too.”)')
        && seam.detail.includes('state the gap or need this evidence answers before naming the artifact'),
      'the additive opener and the trailing “too” seam are both quoted and repaired argumentatively rather than lexically');
      const adjacentBuild = checkAdditiveSeam([
        'Additionally, I built the rostering service the registrar runs every morning.',
        'I also personally built the parent notification path.',
      ]);
      assert(!adjacentBuild.passed
        && adjacentBuild.detail.includes('paragraph 1 appends evidence with a bare additive connective (“Additionally, I built the rostering service')
        && adjacentBuild.detail.includes('paragraph 2 appends evidence with a bare additive connective (“I also personally built the parent notification'),
      'the seam still fires when the build verb follows the connective subject directly or behind a single -ly adverb');
      const midSentenceTrailer = checkAdditiveSeam([
        'I built the intake system from scratch too, in modern tooling, covering every site.',
      ]);
      assert(!midSentenceTrailer.passed
        && midSentenceTrailer.detail.includes('paragraph 1 appends evidence with a bare additive connective (“I built the intake system from scratch too,'),
      'an additive “too” followed by a comma is the same appended proof as one that ends the sentence');
      const connective = checkAdditiveSeam([
        'I also learned to read incomplete incident reports quickly.',
        'I built the scheduler because the paper process kept losing signed forms.',
        'In addition, I supported the staff who wrote the policy.',
        'I also saw how a poorly designed intake process created rework for the front office.',
        'I built dashboards that were too slow to ship at first, then fixed them.',
        'I built the intake flow as well as the reporting layer.',
      ]);
      assert(connective.passed,
        `an additive opener without adjacent build evidence, build evidence without a seam, a build verb buried in a subordinate clause, a degree “too” followed by the word it modifies, and a mid-sentence “as well as” comparative are ordinary connective prose: ${connective.detail}`);
      const opaqueResponsibilityPivot = checkResponsibilityTransition([
        'The ticketing system I extended needed role-restricted access so staff saw only what their role allowed. Keeping the district data consistent across its tools was a different problem. I solved it with Python integration jobs.',
        'The same job also included assessing software the district would adopt instead of build.',
      ]);
      assert(!opaqueResponsibilityPivot.passed && opaqueResponsibilityPivot.id === 'responsibility-transition'
        && opaqueResponsibilityPivot.detail.includes('paragraph 1 shifts from “Keeping the district data consistent across its tools …”')
        && opaqueResponsibilityPivot.detail.includes('through an opaque problem label')
        && opaqueResponsibilityPivot.detail.includes('paragraph 2 opens with “The same job also included assessing software the …”')
        && opaqueResponsibilityPivot.detail.includes('shared job scope is not a bridge between responsibilities'),
      'opaque problem-to-solution pivots and same-job paragraph openers require a substantive responsibility bridge');
      const abstractCategoryPivot = checkResponsibilityTransition([
        'Operational migration extended my third-party system work beyond product evaluation.',
        'Beyond moving operations, I used Python ETL to connect the district information system with third-party solutions.',
      ]);
      assert(!abstractCategoryPivot.passed
        && abstractCategoryPivot.detail.includes('paragraph 1 says “Operational migration extended my third-party system work beyond product evaluation.”')
        && abstractCategoryPivot.detail.includes('only renames one work category as broader than another')
        && abstractCategoryPivot.detail.includes('paragraph 2 opens evidence with a bare category transition (“Beyond moving operations, I used Python ETL to …”)')
        && abstractCategoryPivot.detail.includes('“beyond” marks addition but does not explain the relationship'),
      'abstract lifecycle categories and bare beyond-openers cannot stand in for the relationship between proofs');
      const detachedRelevance = checkDetachedRelevanceClaim([
        "As a software engineer for Thomson School District, I moved operational data and workflows from internal systems to third-party platforms, work relevant to this role's legacy modernization and cross-program integration responsibilities.",
      ]);
      const explainedRelevance = checkDetachedRelevanceClaim([
        "As a software engineer for Thomson School District, I moved internal systems and their operational data to third-party platforms, building migration workflows and validation for the legacy-modernization work this role describes.",
        'Experience relevant to this role includes building migration workflows and validation for replacement platforms.',
      ]);
      assert(!detachedRelevance.passed && detachedRelevance.id === 'detached-relevance-claim'
        && detachedRelevance.detail.includes("work relevant to this role's")
        && detachedRelevance.detail.includes('using conditional language for work that would occur after hiring'),
      'a trailing relevance assertion cannot make the recruiter infer the action-to-responsibility connection');
      assert(explainedRelevance.passed,
        `an explicit mechanism and a non-detached relevance noun phrase remain valid: ${explainedRelevance.detail}`);
      const presentContribution = checkProspectiveContributionTense([
        "That migration experience helps me contribute to this role's legacy-modernization responsibilities.",
      ]);
      const pastReadinessContribution = checkProspectiveContributionTense([
        "That project prepared me to contribute to ODFW's legacy-system modernization and cross-program data flows.",
      ], 'Oregon Department of Fish and Wildlife');
      const prospectiveContribution = checkProspectiveContributionTense([
        'At ODFW, I would apply that migration experience to modernizing legacy systems and architecting cross-program data flows.',
        'I built migration workflows and validated operational data for the replacement platforms.',
      ], 'Oregon Department of Fish and Wildlife');
      const historicalPreparation = checkProspectiveContributionTense([
        "That training prepared me to support Thomson School District's replacement systems the following year.",
        'That training prepared me to support the systems during the following school year.',
      ], 'Oregon Department of Fish and Wildlife');
      assert(!presentContribution.passed && presentContribution.id === 'prospective-contribution-tense'
        && presentContribution.detail.includes('past/present readiness bridge')
        && presentContribution.detail.includes('in a transfer form that differs from the transfer forms of the neighbouring paragraphs')
        && !/\bI (?:would|can) (?:apply|bring|use|contribute)\b/u.test(presentContribution.detail),
      'completed experience cannot be framed as a present-tense promise to a prospective employer');
      assert(!pastReadinessContribution.passed
        && pastReadinessContribution.detail.includes('prepared me to contribute'),
      'a completed project cannot use past readiness as the tense anchor for named prospective-employer work');
      assert(prospectiveContribution.passed,
        `conditional target contribution and ordinary past-tense evidence remain valid: ${prospectiveContribution.detail}`);
      assert(historicalPreparation.passed,
        `readiness for documented past work at a prior employer remains valid: ${historicalPreparation.detail}`);
      const mirroredCategoryScaffold = checkResponsibilityTransition([
        'My implementation experience covers workflow change and data exchange. I handled workflow change by transferring internal operations to third-party systems. In separate integration work, I addressed data exchange by connecting the district system to those solutions.',
        'My implementation experience covers workflow change and data exchange. I handled workflow change such as transferring internal operations to third-party systems. I addressed the data exchange by connecting the district system to those solutions.',
      ]);
      assert(!mirroredCategoryScaffold.passed
        && mirroredCategoryScaffold.detail.includes('paragraph 1 repeats mirrored abstract labels (“workflow change” then “data exchange”)')
        && mirroredCategoryScaffold.detail.includes('paragraph 2 repeats mirrored abstract labels (“workflow change” then “data exchange”)')
        && mirroredCategoryScaffold.detail.includes('state the umbrella once, then let concrete action verbs demonstrate each branch'),
      'an explicit umbrella must not turn the following evidence into mirrored handled/addressed category labels, including the “such as” variant');
      const bridgedResponsibilityPivot = checkResponsibilityTransition([
        'The ticketing system I extended needed role-restricted access so staff saw only what their role allowed. Alongside that access-control work, I kept the district data consistent across its tools with Python integration jobs.',
        'That role also required me to assess software the district would adopt instead of build.',
        'The migration extended the catalog system to support interlibrary loans without interrupting circulation.',
        'Beyond migrating the district catalog, I used Python ETL to preserve borrower identifiers during cutover.',
        'Moving operations exposed incompatible record identifiers, so I used Python ETL to reconcile them before cutover.',
        'My implementation experience covered two distinct needs: adapting workflows and enabling data exchange. I transferred internal operations and their data to third-party systems. Separately, I used Python to connect the district information system with third-party solutions.',
      ]);
      assert(bridgedResponsibilityPivot.passed,
        `supported bridges, concrete actions under one umbrella, and a minimal separation cue avoid opaque or mirrored category scaffolding: ${bridgedResponsibilityPivot.detail}`);
      const evaluatedResponsibilityPivot = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ['Keeping the district data consistent across its tools was a separate challenge. I addressed it with Python integration jobs.'],
        evidence, researchText: '',
      }).find(check => check.id === 'responsibility-transition');
      assert(evaluatedResponsibilityPivot && !evaluatedResponsibilityPivot.passed,
        'the complete cover-letter evaluator enforces opaque responsibility-transition repairs, not only the direct helper');
      const evaluatedCategoryPivot = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ['Operational migration extended my third-party system work beyond product evaluation. Beyond moving operations, I used Python ETL to connect the systems.'],
        evidence, researchText: '',
      }).find(check => check.id === 'responsibility-transition');
      assert(evaluatedCategoryPivot && !evaluatedCategoryPivot.passed
        && evaluatedCategoryPivot.detail.includes('only renames one work category as broader than another')
        && evaluatedCategoryPivot.detail.includes('opens evidence with a bare category transition'),
      'the complete evaluator routes both abstract category pivots into its single prose-revision attempt');
      const evaluatedDetachedRelevance = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ["I moved operational data and workflows to third-party platforms, experience directly relevant to this role's legacy modernization responsibilities."],
        evidence, researchText: '',
      }).find(check => check.id === 'detached-relevance-claim');
      assert(evaluatedDetachedRelevance && !evaluatedDetachedRelevance.passed,
        'the complete evaluator routes detached relevance assertions into its single prose-revision attempt');
      const evaluatedPresentContribution = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ["That project prepared me to contribute to ODFW's legacy-system modernization and cross-program data flows."],
        evidence, researchText: '', companyName: 'Oregon Department of Fish and Wildlife',
      }).find(check => check.id === 'prospective-contribution-tense');
      assert(evaluatedPresentContribution && !evaluatedPresentContribution.passed,
        'the complete evaluator routes past or present readiness bridges for prospective contribution into its single prose-revision attempt');
      const posting = checkPostingReference([
        'Owning the rollout end-to-end is what your posting wants sped up.',
        'The job ad asks for the same repair work, as advertised.',
      ]);
      assert(!posting.passed && posting.id === 'posting-reference'
        && posting.detail.includes('paragraph 1 addresses the advertisement itself (“your posting”)')
        && posting.detail.includes('paragraph 2 addresses the advertisement itself (“job ad”)')
        && posting.detail.includes('(“as advertised”)'),
      'each advertisement-object noun is reported once per paragraph with the phrase that produced it');
      const contextualReference = checkPostingReference([
        'This position emphasizes reliable handoffs during service recovery.',
        'The position description identifies incident response as a core responsibility.',
        'The job posting describes the service team as responsible for release coordination.',
      ]);
      assert(contextualReference.passed,
        `the attached position uses a proximal reference, while source documents may own reporting verbs for listing-only context: ${contextualReference.detail}`);
      const bareListingAttribution = checkPostingReference([
        'The listing describes a rebuild that starts from years of existing workflows and operational data rather than an empty repository.',
      ]);
      const explicitListingAttribution = checkPostingReference([
        'This job listing describes a rebuild that starts from years of existing workflows and operational data rather than an empty repository.',
      ]);
      assert(!bareListingAttribution.passed
        && bareListingAttribution.detail.includes('underspecified source attribution (“The listing describes”)')
        && bareListingAttribution.detail.includes('name this role and its work directly')
        && bareListingAttribution.detail.includes('“this job listing” or “this job description”')
        && explicitListingAttribution.passed,
      'a bare “The listing describes” opener is redirected to role-facing prose or explicit provenance, while an explicit job-listing attribution remains available when needed');
      const detachedOrUngrammatical = checkPostingReference([
        "The role's focus on service reliability rewards careful prioritization.",
        'The position states that engineers rotate through incident response.',
      ]);
      assert(!detachedOrUngrammatical.passed
        && detachedOrUngrammatical.detail.includes('detached target-position reference')
        && detachedOrUngrammatical.detail.includes('makes the target position the source of a statement'),
      'a target position is referenced proximally and never made the grammatical source of reported information');
      const workNouns = checkPostingReference([
        'This role requires steady prioritization when reports arrive incomplete.',
        'This position sits between the field crews and the district office.',
        'Your listing quality team ships the ranking model.',
        'The listing page I rebuilt cut abandoned carts.',
        'I rewrote the job description parser your team maintains.',
      ]);
      assert(workNouns.passed, `proximal role references name the work itself, while “listing” and “job description” may remain marketplace and job-board product vocabulary: ${workNouns.detail}`);
      const equivalence = checkClaimedEquivalence([
        'The way the district core-and-integrations work maps onto your platform is the part I would bring first.',
        'That responsibility translates directly into this team, and it is exactly what the work needs.',
        'The same failure pattern translates directly to your intake queue.',
      ]);
      assert(!equivalence.passed && equivalence.id === 'claimed-equivalence'
        && equivalence.detail.includes('paragraph 1 asserts a cross-domain equivalence (“maps onto”)')
        && equivalence.detail.includes('(“translates directly into”)')
        && equivalence.detail.includes('(“is exactly what”)')
        && equivalence.detail.includes('(“translates directly to”)')
        && equivalence.detail.includes('name the source-supported transferable capability')
        && equivalence.detail.includes('actual responsibility in the posting'),
      'every asserted-equivalence formula is quoted and redirected to an explicit, bounded transfer argument');
      const argued = checkClaimedEquivalence([
        'I translated the intake requirements into a build plan, and the dashboard mirrored the incident feed.',
        'Our dashboard mirrors production latency within a second.',
        'That volume translates to about two hundred tickets a week.',
      ]);
      assert(argued.passed, `past-tense uses outside the closed formula family, literal replication, and unit restatement are not asserted analogies: ${argued.detail}`);
      return { seam: seam.detail, posting: posting.detail, equivalence: equivalence.detail };
    },
  },
  {
    name: 'cover letter harness: runaway sentences, semicolons, dash splices, and bureaucratic register carry plain repairs',
    run: () => {
      const long = checkSentenceLength(['The scheduling rewrite began when the paper intake process kept losing signed permission forms, so I mapped every handoff between the front desk, the classroom, and the district office in order to find the point where a form could vanish without anyone noticing it had gone missing at all.']);
      assert(!long.passed && long.id === 'sentence-length'
        && long.detail.includes('paragraph 1 contains a 49-word sentence beginning “The scheduling rewrite began when the paper intake …”')
        && long.detail.includes('split it into short causal sentences') && MAX_SENTENCE_WORDS === 40,
      'a runaway sentence reports its exact word count and opening words for the split');
      const measured = checkSentenceLength(['The scheduling rewrite began when the paper intake process kept losing signed permission forms, so I mapped every handoff between the front desk, the classroom, and the district office.']);
      assert(measured.passed, `a well-built 29-word sentence is a runaway-clause near miss, not revision work: ${measured.detail}`);
      const punctuation = checkPunctuationStyle([
        'The rollout had two halves; one was the scheduling core.',
        'The rollout had two halves — the scheduling core and the reporting service.',
      ]);
      assert(!punctuation.passed && punctuation.id === 'punctuation-style'
        && punctuation.detail.includes('paragraph 1 uses a semicolon; split the clause into two short sentences')
        && punctuation.detail.includes('paragraph 2 uses a dash as a clause splice'),
      'the semicolon escape hatch and the em-dash splice are both read off the raw paragraph string');
      const dateRange = checkPunctuationStyle(['I led that work from 2019–2022 without a gap in coverage.']);
      assert(dateRange.passed, `an en dash between two digits is a range, not a clause splice: ${dateRange.detail}`);
      const spacedRanges = checkPunctuationStyle([
        'I worked there from 2019 – 2022 without a break.',
        'I led that team from May 2023 – June 2026 without a gap.',
      ]);
      assert(spacedRanges.passed,
        `a spaced numeric range and a month-name range both ship past the document gate, so flagging them would spend a revision round damaging correct copy: ${spacedRanges.detail}`);
      // Parity with the design-system hard gate (assertCandidateDashPunctuation).
      // Anything that gate throws on must arrive here as a revisable
      // observation instead: a spaced hyphen used to pass this check, fail the
      // build, and surface as a page-count error that never mentioned a dash.
      const gateCorpus = [
        'I ran the desk - the queue never backed up.',
        'The core - the scheduler - shipped.',
        'The rollout had two halves — the scheduling core and the reporting service.',
        'The registrar signed the form – the office filed it.',
        'I led that work from 2019–2022 without a gap in coverage.',
        'I worked there from 2019 – 2022 without a break.',
        'I led that team from May 2023 – June 2026 without a gap.',
      ];
      const parity = gateCorpus.map(copy => {
        let gateRejected = false;
        try {
          assertCandidateDashPunctuation({ coverLetter: { paragraphs: [copy] } });
        } catch {
          gateRejected = true;
        }
        return { copy, gateRejected, spliceFlagged: checkPunctuationStyle([copy]).detail.includes('uses a dash as a clause splice') };
      });
      assert(parity.filter(item => item.gateRejected).length === 4
        && parity.every(item => item.gateRejected === item.spliceFlagged),
      'every dash form the document gate rejects must become a revisable observation, and no form it blesses may be sent back for revision');
      const register = checkPlainRegister([
        'I am in possession of a valid driver licence for the district fleet.',
        'I possess a valid first aid certificate for the site.',
      ]);
      assert(!register.passed && register.id === 'plain-register'
        && register.detail.includes('paragraph 1 uses bureaucratic register (“in possession of”)')
        && register.detail.includes('(“possess a valid”)'),
      'the fixed bureaucratic formulas ask for plain first-person English');
      const plain = checkPlainRegister(['I have a valid driver licence, and I can work weekends in the district.']);
      assert(plain.passed, `plain first-person logistics facts must never become revision work: ${plain.detail}`);
      const missingIntroComma = checkIntroductoryWorkplaceComma([
        'At the district I delivered software through traditional and AI-assisted workflows.',
      ]);
      const introCommaPresent = checkIntroductoryWorkplaceComma([
        'At the district, I delivered software through traditional and AI-assisted workflows.',
        'At times I chose a traditional workflow.',
      ]);
      const namedWorkplaceMissingComma = checkIntroductoryWorkplaceComma([
        'At Northstar Systems I led a platform migration.',
      ], ['Northstar Systems']);
      assert(!missingIntroComma.passed
        && missingIntroComma.detail.includes('insert a comma after “At the district”')
        && !namedWorkplaceMissingComma.passed
        && namedWorkplaceMissingComma.detail.includes('insert a comma after “At Northstar Systems”')
        && introCommaPresent.passed,
      'introductory workplace phrases cover generic organization types and supplied employer names without turning every short adjunct into a mandatory-comma rule');
      const ambiguousPoint = checkVisualReferencePrecision([
        'An agent walking someone through an on-screen task cannot point at the control it means.',
      ]);
      const ambiguousVariant = checkVisualReferencePrecision([
        'The AI assistant cannot point out which button opens the panel.',
      ]);
      const visualPoint = checkVisualReferencePrecision([
        'An automated guide cannot visually point to the relevant part of the window.',
      ]);
      assert(!ambiguousPoint.passed
        && ambiguousPoint.detail.includes('visually indicate the on-screen control')
        && !ambiguousVariant.passed
        && visualPoint.passed,
      'screen-guidance prose recognizes varied actors, targets, and pointing constructions while accepting an explicit visible limitation');
      const conditionalClose = checkDirectWelcomeClosing(['I would welcome the chance to talk about that work.']);
      const conditionalConversation = checkDirectWelcomeClosing(['I would welcome a conversation about how that combination could support the WAVES rebuild.']);
      const conditionalDiscussion = checkDirectWelcomeClosing(['I’d welcome a discussion about the release path.']);
      const deferentialVariant = checkDirectWelcomeClosing(['I would be pleased to discuss the migration.']);
      const directClose = checkDirectWelcomeClosing(['I welcome a conversation about how my release-workflow experience could support the team’s deployment process.']);
      const employerChoiceClose = checkDirectWelcomeClosing(['I welcome a conversation about whether the voice assistant or browser agent should be the first prototype.']);
      const nonClosingUse = checkDirectWelcomeClosing([
        'I would welcome the chance to review that question during discovery.',
        'The migration work is the contribution I want to continue here.',
      ]);
      const selfDirectedClose = checkDirectWelcomeClosing([
        'I hope to learn more about how the team approaches release review.',
      ]);
      const bareLookForwardClose = checkDirectWelcomeClosing([
        'I look forward to learning more about how the team approaches release review.',
      ]);
      const prospectiveClose = checkDirectWelcomeClosing([
        'I look forward to discussing how my release-workflow experience could support the team’s deployment process.',
      ]);
      const selfDirectedContribution = checkDirectWelcomeClosing([
        'I hope to discuss how my operations experience could support the team’s service transition.',
      ]);
      const nonFinalIntent = checkDirectWelcomeClosing([
        'I plan to discuss the implementation during onboarding. I look forward to discussing how my operations experience could support the service team.',
      ]);
      assert(!conditionalClose.passed
        && conditionalClose.detail.includes('make the invitation direct')
        && !conditionalConversation.passed && conditionalConversation.detail.includes('would welcome a conversation')
        && !conditionalDiscussion.passed && conditionalDiscussion.detail.includes("I'd welcome a discussion")
        && !deferentialVariant.passed
        && directClose.passed
        && !employerChoiceClose.passed
        && employerChoiceClose.detail.includes('asks the employer to choose between initiatives')
        && nonClosingUse.passed
        && !selfDirectedClose.passed
        && selfDirectedClose.detail.includes('ends with conversation or learning intent')
        && !bareLookForwardClose.passed
        && bareLookForwardClose.detail.includes('but no candidate contribution')
        && prospectiveClose.passed
        && selfDirectedContribution.passed
        && nonFinalIntent.passed,
      'the closing check catches final invitations that stop at conversation or learning while leaving contribution-connected and non-final intent alone');
      // The observation used to name the GOAL ("direct") without the OPERATION
      // (delete the modal), and its second clause pointed at the half of the
      // sentence the writer had already satisfied — exactly why a real handoff
      // enriched the contribution clause for 16 rounds and never dropped "would".
      // The fix must name the operation, not re-present the contribution clause
      // as the missing half, and must carry the contribution rule too, since
      // deleting the modal moves the sentence onto DIRECT_CONVERSATION_CLOSE.
      const conditionalOperationDetail = checkDirectWelcomeClosing(['I would welcome the chance to talk about that work.']).detail;
      // "needs both halves" became "needs all three parts": the conditional
      // branch grades the sentence before any of the three contribution
      // predicates have run, so it always lists asset, action, AND target —
      // the target half is the one a second incident (752d8241, see the
      // comment on contributionHalfRequirement) found this message never
      // demonstrated at all, in any branch.
      assert(conditionalOperationDetail.includes('delete that opening modal')
        && conditionalOperationDetail.includes('make the invitation direct')
        && conditionalOperationDetail.includes('the sentence needs all three parts')
        && conditionalOperationDetail.includes('never a bare demonstrative')
        && conditionalOperationDetail.includes('reach the employer’s side too')
        && !conditionalOperationDetail.includes('name the specific work or contribution to discuss'),
      `the conditional-close rejection must name the operation (delete the modal) and carry the full three-part contribution rule in the same round, got ${JSON.stringify(conditionalOperationDetail)}`);
      // A closing that reuses a noun phrase an earlier paragraph already used
      // satisfies this check and trips checkRepeatedPhrase; 5 of the incident's
      // 16 rejections also named repeated-phrase. The remediation states that
      // counter-pressure by reading MIN_CROSS_PARAGRAPH_REPEAT_WORDS rather than
      // a hardcoded number, so the floor can never drift from what
      // checkRepeatedPhrase actually enforces.
      assert(conditionalOperationDetail.includes(`${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} or more words carried verbatim`),
      `the remediation must state the cross-paragraph repeat floor by constant, got ${JSON.stringify(conditionalOperationDetail)}`);
      // \bI\s+(?:would|'d)\s+be\s+… forced a space before "'d" that the
      // contraction never has, so "I'd be glad to discuss…" escaped the check
      // entirely while "I would be glad to discuss…" was caught beside it.
      const spacedGladVariant = checkDirectWelcomeClosing(['I would be glad to discuss the migration.']);
      const contractedGladVariant = checkDirectWelcomeClosing(["I'd be glad to discuss the migration."]);
      const curlyContractedGladVariant = checkDirectWelcomeClosing(['I’d be glad to discuss the migration.']);
      assert(!spacedGladVariant.passed
        && !contractedGladVariant.passed && contractedGladVariant.detail.includes("I'd be glad to discuss")
        && !curlyContractedGladVariant.passed,
      'the "I would be glad/happy/pleased to" close must be caught in its contracted spelling too, straight or curly apostrophe alike');
      // checkDirectWelcomeClosing graded only sentences(paragraph).at(-1), so a
      // trailing courtesy sentence with no invitation and no contribution
      // masked whatever closing sentence stood before it.
      const conditionalMaskedByCourtesy = checkDirectWelcomeClosing([
        'I would welcome the chance to talk about that work. Thank you for your consideration.',
      ]);
      const directMaskedByCourtesy = checkDirectWelcomeClosing([
        'I welcome a conversation about that work. Thank you for your consideration.',
      ]);
      const goodCloseFollowedByCourtesy = checkDirectWelcomeClosing([
        'I welcome a conversation about how my release-workflow experience could support the team’s deployment process. Thank you for your consideration.',
      ]);
      assert(!conditionalMaskedByCourtesy.passed
        && conditionalMaskedByCourtesy.detail.includes('make the invitation direct')
        && !directMaskedByCourtesy.passed
        && directMaskedByCourtesy.detail.includes('never connects a candidate asset')
        && goodCloseFollowedByCourtesy.passed,
      'a trailing courtesy sentence must not mask the invitation sentence graded before it, and must not block a closing that already satisfies the rule');
      const awkwardGap = checkPlainRegister(['I answered that gap with a native overlay.']);
      assert(!awkwardGap.passed && awkwardGap.detail.includes('use “closed the gap” or “addressed the gap”'),
        'unnatural gap wording must receive a plain contemporary repair');
      const evidenceBring = checkPlainRegister(['Product evaluation, operational migration, and Python ETL are the evidence I would bring.']);
      assert(!evidenceBring.passed && evidenceBring.detail.includes('say what experience, skills, or work the candidate would bring'),
        'a closing distinguishes the candidate\'s capabilities from the evidence supporting the argument');
      assert(sentences('The desk logged forms at 9 a.m. for Cedar Ridge Inc. and closed at noon.').length === 1
        && sentences('').length === 0,
      'the shared segmenter keeps abbreviations in one sentence so every sentence-level check counts the same units');
      return { long: long.detail, punctuation: punctuation.detail, register: register.detail, introComma: missingIntroComma.detail, visualPoint: ambiguousPoint.detail, directClose: conditionalClose.detail };
    },
  },
  {
    name: 'cover letter harness: garden paths, filler bridges, and deployment-role errors receive narrow repairs',
    run: () => {
      const gardenPath = checkToolCallsGardenPath([
        'Rebuilding a system without recreating every existing tool calls for clear evidence about which work belongs in a custom application.',
      ]);
      const directPredicate = checkToolCallsGardenPath([
        'Rebuilding a system without recreating every existing tool requires clear evidence about which work belongs in a custom application.',
      ]);
      assert(!gardenPath.passed
        && gardenPath.detail.includes('garden-path reading with “tool calls for”')
        && gardenPath.detail.includes('replace “calls for” with “requires”')
        && directPredicate.passed,
      'a familiar compound noun cannot conceal the intended “calls for” predicate, while a direct predicate remains legal');

      const fillerBridge = checkLowInformationToolBuild([
        'For tools that remained in-house, I built software.',
      ]);
      const concreteBridge = checkLowInformationToolBuild([
        'For tools that remained in-house, I built the workflow that reconciled operator changes before release.',
      ]);
      const workflowBridge = checkLowInformationToolBuild([
        'For workflows that remained manual, I built software that reconciled operator changes before release.',
      ]);
      const systemBridge = checkLowInformationToolBuild([
        'For systems that lacked audit trails, I built software that recorded each operator change.',
      ]);
      assert(!fillerBridge.passed
        && fillerBridge.detail.includes('only restates that tools are software')
        && concreteBridge.passed && workflowBridge.passed && systemBridge.passed,
      'a terminal category-restating tools bridge is removed or made specific without rejecting concrete tools, workflows, or systems work');

      const mismatchedRoles = checkContainerizationTechnologyRoles([
        'I containerized it with Docker Compose, Nginx, and Gunicorn so it could be deployed on different virtual-machine configurations.',
      ]);
      const accurateRoles = checkContainerizationTechnologyRoles([
        'I containerized the service with Docker Compose, then configured Nginx as a reverse proxy and Gunicorn as the application server.',
      ]);
      const coordinatedRoles = checkContainerizationTechnologyRoles([
        'I containerized it with Docker Compose and configured Nginx as the reverse proxy.',
      ]);
      assert(!mismatchedRoles.passed
        && mismatchedRoles.detail.includes('“Nginx” is a web or application server, not a containerization tool')
        && mismatchedRoles.detail.includes('Docker or Docker Compose for containerization')
        && accurateRoles.passed && coordinatedRoles.passed,
      'containerization claims cannot grammatically govern web or application servers, while separate role-accurate predicates pass');

      const topologyTail = checkResumeBulletFocus('<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example</span><ul class="highlights"><li>Containerized the internal-tools hub with Docker Compose, running Django under Gunicorn behind Nginx.</li></ul></article></main>');
      const focusedContainerization = checkResumeBulletFocus('<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example</span><ul class="highlights"><li>Containerized the internal-tools hub with Docker Compose.</li></ul></article></main>');
      assert(!topologyTail.passed
        && topologyTail.detail.includes('appends runtime topology to a containerization point')
        && focusedContainerization.passed,
      'résumé validation keeps a complete containerization highlight focused instead of appending routine server topology');

      const literalizedFrame = checkClaimedEquivalence([
        'Model delegation and a purchased platform are two answers to one build-or-buy call.',
      ]);
      const mechanismFirst = checkClaimedEquivalence([
        'I compare model discretion, deterministic controls, and vendor capabilities against the constraints of each workflow.',
      ]);
      assert(!literalizedFrame.passed
        && literalizedFrame.detail.includes('asserts a cross-domain equivalence')
        && mechanismFirst.passed,
      'a coined two-answers-to-one-decision frame cannot force nonparallel options into an equivalence');

      const danglingTransition = checkDanglingParagraphTransition([
        'The overlay preserved user control. The boundary between model-owned work and deterministic code also shaped how I used AI-assisted development at Northstar District.',
        'I would bring careful architecture decisions to the target work.',
      ]);
      const developedTransition = checkDanglingParagraphTransition([
        'The overlay preserved user control. At Northstar District, I applied the same boundary by routing model output through deterministic validation.',
        'I would bring careful architecture decisions to the target work.',
      ]);
      assert(!danglingTransition.passed
        && danglingTransition.detail.includes('launching an undeveloped topic')
        && developedTransition.passed,
      'a non-final paragraph cannot end by launching a broad workplace claim that the letter never develops');

      const combined = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: [
          'Rebuilding a system without recreating every existing tool calls for clear evidence about which work belongs in a custom application.',
          'For tools that remained in-house, I built software.',
          'I containerized it with Docker Compose, Nginx, and Gunicorn so it could be deployed on different virtual-machine configurations.',
          'The boundary between model work and deterministic code also shaped how I used AI-assisted development at Northstar District.',
          'Model delegation and a purchased platform are two answers to one build-or-buy call.',
        ],
      });
      const failures = new Map(combined.filter(check => !check.passed).map(check => [check.id, check.detail]));
      assert(failures.has('tool-calls-garden-path')
        && failures.has('low-information-tool-build')
        && failures.has('containerization-technology-roles')
        && failures.has('dangling-paragraph-transition')
        && failures.has('claimed-equivalence'),
      `each exact regression case is part of the single-revision prose evaluation: ${[...failures.keys()].join(', ')}`);
      return { gardenPath: gardenPath.detail, fillerBridge: fillerBridge.detail, mismatchedRoles: mismatchedRoles.detail, danglingTransition: danglingTransition.detail };
    },
  },
  {
    name: 'cover letter harness: a synthetic register-defect letter fails every appended deterministic check',
    run: () => {
      // Every construction here paraphrases a real generation defect with
      // invented employers and projects. The fixture deliberately contains no
      // copied letter text and no personal data.
      const paragraphs = [
        'Owning the rollout end to end is what your posting wants, and that is the work I kept in house at Brightpath District through a rebuild that began when the paper intake process lost signed permission forms, continued through every handoff between the front desk, the classroom, and the registrar, and ended only once each form had one named owner.',
        'I rebuilt the shared in-house core with React, Django, Nginx, Gunicorn, and Docker Compose behind a TypeScript client; one piece was Rosterly — the scheduling service the registrar now runs every morning.',
        'I built Rosterly from scratch. I also wrote Chalkline, a grading assistant for the same district. I built a parent notification tool too.',
        'That evaluation practice gives me a clear view of that approach’s downsides and trade-offs as well as its upsides. The way the district core-and-integrations work maps onto your brand-agnostic platform is the part I would bring first. I am in possession of a valid driver licence.',
      ];
      const checks = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs,
        evidence: { bulletTexts: ['Rebuilt a district intake path so every permission form carried one named owner.'] },
        // A posting-sized corpus (the check treats anything smaller as metadata)
        // that names exactly one of the six tools the letter lists.
        jobText: [
          'Cedar Ridge Learning is hiring an engineer to extend the React interface that school registrars use every day.',
          'The role sits between the front desk and the district office, so you will follow a signed form from the moment it is handed in to the record that proves it was filed.',
          'We care about how you find the failure point in that path, not about the length of a tool list.',
          'Tell us what broke, what you changed, and how you knew the change held.',
        ].join(' '),
        researchText: '',
        companyName: 'Cedar Ridge Learning',
      });
      const failed = new Map(checks.filter(check => !check.passed).map(check => [check.id, check.detail]));
      const expected = ['generic-phrases', 'compound-hyphenation', 'anchor-relevance', 'additive-seam',
        'posting-reference', 'claimed-equivalence', 'sentence-length', 'punctuation-style', 'plain-register',
        'opening-demonstrative'];
      assert(expected.every(id => failed.has(id)),
        `the synthetic defect letter must fail every register check: ${expected.filter(id => !failed.has(id)).join(', ') || 'none missing'}`);
      assert(failed.get('generic-phrases').includes('downsides and trade-offs')
        && failed.get('compound-hyphenation').includes('write “in-house”')
        && failed.get('anchor-relevance').includes('paragraph 2 names 5 stack tools')
        && failed.get('additive-seam').includes('paragraph 3 appends evidence with a bare additive connective')
        && failed.get('posting-reference').includes('(“your posting”)')
        && failed.get('claimed-equivalence').includes('(“maps onto”)')
        && failed.get('sentence-length').includes('60-word sentence')
        && failed.get('punctuation-style').includes('paragraph 2 uses a semicolon')
        && failed.get('punctuation-style').includes('paragraph 2 uses a dash as a clause splice')
        && failed.get('plain-register').includes('(“in possession of”)')
        && failed.get('opening-demonstrative').includes('paragraph 4 opens with')
        && failed.get('opening-demonstrative').includes('“evaluation”'),
      'each failure quotes the specific defective construction the one revision attempt has to repair');
      assert(checks.every(check => typeof check.id === 'string' && typeof check.passed === 'boolean' && typeof check.detail === 'string'),
        'the register checks keep the result(id, passed, detail) contract the audit line and revision prompt consume');
      const hostile = [checkCompoundHyphenation, checkAnchorRelevance, checkAdditiveSeam, checkPostingReference,
        checkClaimedEquivalence, checkSentenceLength, checkPunctuationStyle, checkPlainRegister,
        checkOpeningDemonstrative]
        .map(check => check(['', null, undefined, 42, { toString: () => 'in house' }], null, undefined));
      assert(hostile.every(check => check && typeof check.passed === 'boolean' && typeof check.detail === 'string'),
        'a malformed or partially persisted paragraph array must yield a check result, never a thrown application-generation failure');
      return { failed: [...failed.keys()] };
    },
  },
  {
    name: 'cover letter harness: application logistics are rejected and opening demonstratives must anchor in the previous paragraph',
    run: () => {
      // Work authorization is the candidate's own business and the pipeline
      // reads none of it: a letter that answers the posting's eligibility
      // clause outright reaches the reader unflagged, and no check in the
      // evaluated set is named for that subject.
      const workStatusProse = [
        // A proof paragraph carries the letter: candidate-agency reads the
        // whole letter, and these status lines state no completed work.
        'I built the incident triage interface the dispatch team uses.',
        'I am a Canadian citizen and hold a U.S. work permit.',
        'I am authorized to work in Canada and hold permanent residency there.',
        'I would not require visa sponsorship for this position.',
      ];
      const workStatusChecks = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: workStatusProse,
        evidence: {},
        researchText: '',
      });
      assert(workStatusChecks.every(check => check.passed),
        `stating work authorization in letter prose is no longer a defect: ${workStatusChecks.filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`).join(' | ')}`);
      const planStatusGate = checkPlanGate({ ...groundedPlan, logistics: '' }, evidence, needs,
        'The role must manage incident escalation.', '', 'Candidates must be authorized to work in Canada.');
      assert(!planStatusGate.checks.some(check => /legal|status|citizen|authoriz/iu.test(check.id)),
        `no plan-gate check is named for legal work status: ${planStatusGate.checks.map(check => check.id).join(', ')}`);
      const logisticsExcluded = checkLogisticsExclusion(
        { logistics: 'I am willing to work anywhere.' },
        ['I am willing to work anywhere.', 'I can work hybrid or remotely and travel as needed.'],
      );
      assert(!logisticsExcluded.passed && logisticsExcluded.id === 'logistics-exclusion'
        && logisticsExcluded.detail.includes('argument plan contains logistics'),
      'availability and work-location intent are rejected from the argument plan and letter rather than rephrased');
      const proseOnlyLogistics = checkLogisticsExclusion({}, [
        'I am willing to work anywhere.',
        'I can work hybrid or remotely and travel as needed.',
        'I can start June 1.',
        'I am open to working on-site in Austin.',
      ]);
      assert(!proseOnlyLogistics.passed && proseOnlyLogistics.detail.includes('work-location willingness')
        && proseOnlyLogistics.detail.includes('travel willingness')
        && proseOnlyLogistics.detail.includes('start date'),
      'the exact willing-to-work-anywhere regression and hybrid/remote/travel/start-date promises are rejected in prose');
      const logisticsPositiveControls = checkLogisticsExclusion({}, [
        'I maintained a highly available service that handled travel-booking records for a Toronto team.',
        'In a prior role, I traveled between customer sites while resolving incidents.',
      ]);
      assert(logisticsPositiveControls.passed,
        `system availability, historical travel duties, and neutral locations are not current logistics promises: ${logisticsPositiveControls.detail}`);
      const logisticsGate = checkPlanGate({ ...groundedPlan, logistics: 'I am available to start on June 1.' }, evidence, needs,
        'The role must manage incident escalation.', '', 'Logistics: I am available to start on June 1.');
      assert(logisticsGate.shouldRetry && logisticsGate.checks.some(check => check.id === 'logistics-exclusion' && !check.passed),
        'availability in plan logistics must request the plan retry that removes it');
      const unanchored = checkOpeningDemonstrative([
        'I built the Python data integration between the district information system and its third-party platforms.',
        'That evaluation practice already covers AI products.',
      ]);
      assert(!unanchored.passed && unanchored.id === 'opening-demonstrative'
        && unanchored.detail.includes('paragraph 2 opens with “That evaluation practice already …”')
        && unanchored.detail.includes('“evaluation” or “practice”'),
      'a paragraph-opening demonstrative must find its referent in the paragraph the reader just finished');
      const anchored = checkOpeningDemonstrative([
        'I ran the third-party product evaluations behind the district adoption decisions.',
        'That evaluation practice already covers AI products.',
      ]);
      assert(anchored.passed, `a stemmed referent in the previous paragraph anchors the demonstrative: ${anchored.detail}`);
      const fixedPhrase = checkOpeningDemonstrative([
        'The integration reached both directions.',
        'That is why the district kept the contract.',
      ]);
      assert(fixedPhrase.passed, `pronoun and fixed-phrase demonstratives are out of scope: ${fixedPhrase.detail}`);
      const firstParagraph = checkOpeningDemonstrative(['That evaluation practice is the subject of this letter and needs no anchor.']);
      assert(firstParagraph.passed, 'the first paragraph has no previous paragraph to anchor to and is never flagged');
      const shorthandEmployer = checkOpeningEmployerShorthand([
        'At Thomson School District, I migrated internal systems and their operational data to third-party platforms.',
        'The district chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
      ], ['Thomson School District']);
      const explicitEmployer = checkOpeningEmployerShorthand([
        'At Thomson School District, I migrated internal systems and their operational data to third-party platforms.',
        'Thomson School District chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
      ], ['Thomson School District']);
      const repeatedEmployer = checkAdjacentEmployerRepetition([
        'In my software engineering role at Thomson School District, I built a web workflow that connected barcode scans to external management platforms.',
        'At Thomson School District, I also built an internal tools hub with a UI and back end designed to support additional tools.',
      ], ['Thomson School District']);
      const conciseRoleReference = checkAdjacentEmployerRepetition([
        'In my software engineering role at Thomson School District, I built a web workflow that connected barcode scans to external management platforms.',
        'In that role, I also built an internal tools hub with a UI and back end designed to support additional tools.',
      ], ['Thomson School District']);
      const disambiguatedEmployers = checkAdjacentEmployerRepetition([
        'In my software engineering role at Thomson School District, I integrated the district system with a platform from Acme.',
        'At Thomson School District, I also built an internal tools hub with a UI and back end designed to support additional tools.',
      ], ['Thomson School District', 'Acme']);
      const ordinaryDefiniteDescription = checkOpeningEmployerShorthand([
        'At Thomson School District, I migrated internal systems and their operational data to third-party platforms.',
        'The system validated records before the cutover.',
      ], ['Thomson School District']);
      const unanchoredDistrict = checkOpeningEmployerShorthand([
        'I migrated internal systems and their operational data to third-party platforms.',
        'The district chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
      ], ['Thomson School District']);
      assert(!shorthandEmployer.passed && shorthandEmployer.id === 'opening-employer-shorthand'
        && shorthandEmployer.detail.includes('“The district chose …”')
        && shorthandEmployer.detail.includes('Thomson School District'),
      'a new paragraph cannot replace a just-named prior employer with organization shorthand');
      assert(explicitEmployer.passed && ordinaryDefiniteDescription.passed && unanchoredDistrict.passed,
        `an explicit employer bridge, ordinary definite description, and a district with no prior named-employer antecedent remain allowed: ${explicitEmployer.detail}; ${ordinaryDefiniteDescription.detail}; ${unanchoredDistrict.detail}`);
      // Both messages used to hand over a literal re-entry cue as the repair,
      // and the live letter of 2026-09-23 opened two of its four paragraphs
      // with exactly that cue. They now describe what the opening should be
      // about, name the employer because that is what makes the observation
      // locatable, and quote nothing else beyond the employer's own name: the
      // only quoted span in either message that is not the employer's name is
      // the offending opening itself.
      const employerMessages = [shorthandEmployer.detail, repeatedEmployer.detail];
      assert(shorthandEmployer.detail.includes('open instead on whatever this paragraph is actually about')
        && shorthandEmployer.detail.includes('“Thomson School District” named in full where another employer or role could be the referent'),
      `employer-shorthand feedback describes the repair and preserves names for ambiguity: ${shorthandEmployer.detail}`);
      assert(!repeatedEmployer.passed
        && repeatedEmployer.detail.includes('one established employer needs no re-introduction')
        && repeatedEmployer.detail.includes("let the opening start from this paragraph's own subject")
        && conciseRoleReference.passed && disambiguatedEmployers.passed,
      `a needless adjacent employer-name repeat is flagged, while a concise cue and necessary disambiguation remain allowed: ${repeatedEmployer.detail}; ${conciseRoleReference.detail}; ${disambiguatedEmployers.detail}`);
      // The offending opening is the one span either message may quote besides
      // the employer's own name. Every other quoted run would be wording the
      // letter can adopt, which is the rule stated beside
      // checkRepeatedSentenceShape in coverLetterChecks.js and the mechanism
      // that put one cue in two paragraphs. The employer name itself is now
      // curly-quoted too (checkPriorEmployerOpening's comment in
      // coverLetterChecks.js explains why: it keeps a job-specific name out of
      // this check's fingerprint), so it is filtered out before applying that
      // older rule rather than making the older rule blind to it.
      const quotedSpans = employerMessages.flatMap(detail => [...detail.matchAll(/“([^”]*)”/gu)].map(([, span]) => span));
      const employerNameQuotes = quotedSpans.filter(span => span === 'Thomson School District');
      const otherQuotedSpans = quotedSpans.filter(span => span !== 'Thomson School District');
      assert(employerNameQuotes.length === 4,
        `both messages must curly-quote the employer's own name at every mention, twice each (quoted=${JSON.stringify(quotedSpans)})`);
      assert(otherQuotedSpans.length === 1 && otherQuotedSpans[0] === 'The district chose …',
        `neither employer message quotes a reusable phrase the letter could paste, beyond the employer's own name (quoted=${JSON.stringify(quotedSpans)})`);
      assert(!employerMessages.some(detail => /\bin that role\b/iu.test(detail)),
        `and neither one names the re-entry cue the shipped letter copied twice (messages=${JSON.stringify(employerMessages)})`);
      const evaluatedEmployerShorthand = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: [
          'At Thomson School District, I migrated internal systems and their operational data to third-party platforms.',
          'The district chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
        ],
        evidence: { roles: [{ company: 'Thomson School District' }] }, researchText: '',
      }).find(check => check.id === 'opening-employer-shorthand');
      assert(evaluatedEmployerShorthand && !evaluatedEmployerShorthand.passed,
        'the complete evaluator routes paragraph-opening prior-employer shorthand into its single prose-revision attempt');
      return { workStatusChecks: workStatusChecks.length, logistics: proseOnlyLogistics.detail, planGate: logisticsGate.checks.find(check => check.id === 'logistics-exclusion').detail, unanchored: unanchored.detail, shorthandEmployer: shorthandEmployer.detail, repeatedEmployer: repeatedEmployer.detail };
    },
  },
  {
    name: 'cover letter harness: known résumé projects receive a standalone first mention',
    run: () => {
      const abrupt = checkNamedArtifactIntroduction(
        ['AI-Chalkboard addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'],
        ['AI-Chalkboard'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('first names “AI-Chalkboard”'),
        'a named résumé project cannot begin its proof before the reader learns what it is or the candidate relationship');
      const structuredEvidence = extractResumeEvidence('<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built a native macOS MCP server.</li></ul></article><div class="projects"><article class="project"><span class="project-name">AI-Chalkboard</span><span class="project-desc">A native macOS MCP server.</span></article></div></main>');
      const hostChecks = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: 'Built a native macOS MCP server.' }], companyHook: { detail: '' } },
        paragraphs: ['AI-Chalkboard addressed a concrete interface gap because a screen assistant could describe a control but not visibly indicate it.'],
        evidence: structuredEvidence,
      });
      assert(!hostChecks.find(check => check.id === 'named-artifact-introduction').passed,
        'host-side enforcement derives known project names from the structured résumé project markup');
      const introduced = checkNamedArtifactIntroduction(
        ['I built AI-Chalkboard, a native macOS MCP server, to address the interface gap between describing a control and visibly indicating it.'],
        ['AI-Chalkboard'],
      );
      const introducedAsOverlay = checkNamedArtifactIntroduction(
        ['I built AI-Chalkboard, a click-through overlay, to visibly indicate the control a screen assistant means.'],
        ['AI-Chalkboard'],
      );
      assert(introduced.passed && introducedAsOverlay.passed,
        `a same-sentence candidate relationship plus concise artifact descriptor introduces the project: ${introduced.detail}; ${introducedAsOverlay.detail}`);
      const bareEmployer = checkPriorEmployerOpening(['At Acme, I built the incident workflow.'], ['Acme']);
      const framedEmployer = checkPriorEmployerOpening(['In my software engineering role at Acme, I built the incident workflow.'], ['Acme']);
      assert(!bareEmployer.passed && framedEmployer.passed,
        'a prior employer needs an explicit candidate role or relationship; bare “At Acme, I …” is not sufficient context');
      return { abrupt: abrupt.detail, introduced: introduced.detail, employer: bareEmployer.detail };
    },
  },
  {
    name: 'cover letter harness: opening establishes relevance before a named project leads the letter',
    run: () => {
      const abrupt = checkOpeningArtifactContext(
        ['Marketplace Hub is my personal project, where Gemini or Claude process item photos and draft listings.'],
        ['Marketplace Hub'],
      );
      const projectPreposition = checkOpeningArtifactContext(
        ['In Marketplace Hub, I connected Gemini or Claude APIs to item photos and listing drafts.'],
        ['Marketplace Hub'],
      );
      const possessiveProject = checkOpeningArtifactContext(
        ['My personal project, Marketplace Hub, connects Gemini or Claude APIs to item photos and listing drafts.'],
        ['Marketplace Hub'],
      );
      const employerFirst = checkOpeningArtifactContext(
        ['As a Software Engineer at Thomson School District, I built a device workflow that connected external platforms.'],
        [], ['Thomson School District'],
      );
      const targetFacing = checkOpeningArtifactContext(
        ['Connecting AI APIs to usable workflows is the capability this role needs. Marketplace Hub is my personal project that demonstrates it.'],
        ['Marketplace Hub'],
      );
      const exactRoleOpening = checkOpeningArtifactContext(
        ['Ribit’s Applied AI Developer role calls for turning AI models and APIs into working products.'],
        ['Marketplace Hub'], ['Thomson School District'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('Marketplace Hub'),
        'a cover letter cannot open with an unconnected project description');
      assert(!projectPreposition.passed && !possessiveProject.passed && !employerFirst.passed,
        'prepositional, possessive, and role-framed proof-first openings must not bypass the opening-context check');
      assert(targetFacing.passed && exactRoleOpening.passed,
        `a job-grounded thesis may introduce the project later in the opening paragraph, and a role-facing opening stays valid: ${targetFacing.detail}; ${exactRoleOpening.detail}`);
      return { abrupt: abrupt.detail, targetFacing: targetFacing.detail, exactRole: exactRoleOpening.detail };
    },
  },
  {
    name: 'cover letter harness: artifact actions may follow the introduction in an adjacent sentence',
    run: () => {
      const splitCapability = 'For a different operational workflow, I built a district device app that used barcode scans to identify equipment. The app connected to native device-management platforms and could trigger remote wiping or notifications for devices marked lost or stolen when scanned.';
      const integrationThenActionSplit = 'For a different operational workflow, I built a district device app that used barcode scans to identify equipment and connected to native device-management platforms. When a scanned device was marked lost or stolen, the app could trigger a remote wipe or notification.';
      for (const paragraph of [splitCapability, integrationThenActionSplit]) {
        const hostChecks = evaluateCoverLetterChecks({
          plan: { mappings: [], companyHook: { detail: '' } },
          paragraphs: [paragraph], evidence, researchText: '', companyName: '',
        });
        assert(!hostChecks.some(check => check.id === 'artifact-action-completeness'),
          'the editorial battery must not force a supported action into the artifact-introduction sentence');
        assert(checkSentenceLength([paragraph]).passed,
          `a clear adjacent causal sentence remains valid under the independent sentence-length guard: ${paragraph}`);
      }
      return { splitSentencesAccepted: 2 };
    },
  },
  {
    name: 'cover letter harness: target-work opening conveys interest without a first-person declaration',
    run: () => {
      const directInterest = checkInterestFraming([
        'I am interested in Identity Center’s access workflows because I have built role-restricted web interfaces for internal staff.',
        'At Thomson School District, I updated a ticketing system with role-restricted access.',
        'I welcome a conversation about how my access-control experience could support the team’s authorization work.',
      ]);
      const genericEnthusiasm = checkInterestFraming([
        'I am excited about joining the Identity Center team.',
        'At Thomson School District, I updated a ticketing system.',
      ]);
      const repeatedInterest = checkInterestFraming([
        'I am interested in Identity Center’s access workflows because I have built role-restricted web interfaces for internal staff.',
        'At Thomson School District, I updated a ticketing system with role-restricted access.',
        'I am excited about the opportunity to join the team.',
      ]);
      const contributionClose = checkInterestFraming([
        'I am interested in Identity Center’s access workflows because I have built role-restricted web interfaces for internal staff.',
        'At Thomson School District, I updated a ticketing system with role-restricted access.',
        'I am interested in how my access-control experience could support the team’s authorization work.',
      ]);
      const faireStyleInterest = checkInterestFraming([
        'Faire’s work helping brands create and keep product listings current interests me because it pairs end-to-end feature development with long-term maintainability.',
        'At Thomson School District, I updated a ticketing system with role-restricted access for internal staff.',
      ]);
      const impliedInterest = checkInterestFraming([
        'Identity Center’s access workflows call for role-restricted web interfaces that let people reach the services available to them.',
        'At Thomson School District, I updated a ticketing system with role-restricted access for internal staff.',
        'I welcome a conversation about how my access-control experience could support the team’s authorization work.',
      ]);
      const ordinaryInterestNoun = checkInterestFraming([
        'The role’s interest in access-control workflows is clear from its focus on authorization.',
        'At Thomson School District, I updated a ticketing system with role-restricted access.',
      ]);
      const additionalDeclarations = [
        'My interest in Identity Center comes from its authorization work.',
        'I am drawn to Identity Center’s authorization work.',
        'I am motivated by the team’s work on authorization.',
      ].map(paragraph => checkInterestFraming([paragraph]));
      const evaluated = evaluateCoverLetterChecks({
        plan: { mappings: [], companyHook: { detail: '' } },
        paragraphs: ['I am excited about joining the Identity Center team.'], evidence: {}, researchText: '', companyName: 'AWS',
      });
      assert(!directInterest.passed && !genericEnthusiasm.passed && !faireStyleInterest.passed
        && directInterest.detail.includes('declares the candidate’s interest')
        && !repeatedInterest.passed && !contributionClose.passed
        && impliedInterest.passed && ordinaryInterestNoun.passed
        && additionalDeclarations.every(check => !check.passed)
        && evaluated.some(check => check.id === 'interest-framing' && !check.passed),
      'explicit first-person interest and enthusiasm declarations require a target-work recast, while concrete engagement and non-candidate uses of “interest” remain valid');
      return { directInterest: directInterest.detail, faireStyleInterest: faireStyleInterest.detail, impliedInterest: impliedInterest.detail };
    },
  },
  {
    name: 'cover letter harness: opening application boilerplate yields to a direct team-work capability hook',
    run: () => {
      const boilerplate = checkGenericPhrases([
        'I am applying for the Software Development Engineer role on the Identity Center team. I have built access-controlled web interfaces.',
      ]);
      const extendedBoilerplate = checkGenericPhrases([
        'I would like to apply for the Software Development Engineer role on the Identity Center team.',
      ]);
      const directHook = checkGenericPhrases([
        'Identity Center needs access workflows that show each user only the accounts and applications they are authorized to use. I have built role-restricted web interfaces for internal staff.',
      ]);
      const quotedEvidence = checkGenericPhrases([
        'A hiring guide warned that the phrase “I am applying for this role” does not explain a candidate capability. My work on access-controlled interfaces does.',
      ]);
      const evaluated = evaluateCoverLetterChecks({
        plan: { mappings: [], companyHook: { detail: '' } },
        paragraphs: ['I am applying for the Software Development Engineer role on the Identity Center team.'],
        evidence: {}, researchText: '', companyName: 'AWS',
      });
      assert(!boilerplate.passed && boilerplate.detail.includes('banned opener “i am applying for”')
        && !extendedBoilerplate.passed && extendedBoilerplate.detail.includes('banned opener “i would like to apply”')
        && directHook.passed && quotedEvidence.passed
        && evaluated.some(check => check.id === 'generic-phrases' && !check.passed),
      'only an application announcement leading the letter is revision work; a direct target hook and a later quotation remain valid');
      return { boilerplate: boilerplate.detail, directHook: directHook.detail };
    },
  },
  {
    name: 'cover letter harness: target thesis keeps prior-work mechanics in evidence',
    run: () => {
      const posting = `Amazon Web Services (AWS) is a dynamic and rapidly growing business within Amazon, with millions of active customers in 190 countries around the world. We maintain a rapid pace of innovation by treating each team like its own startup inside AWS, directly accountable for their customers’ satisfaction, service innovations, effective growth, and meeting revenue goals.

AWS Identity platform provides the bedrock for secure and continuous access to all AWS services. By quickly connecting millions of users, across the world we empower organizations and enterprises to accelerate their cloud and digital transformation.

This specific position within AWS Identity Center team represents an opportunity to design and build solutions that allow both customers and enterprises to interact with AWS consoles and services seamlessly. We support all the modern identity standards and push the boundaries to create new ones. The team is engaged at modernizing user experience for Identity Center Control Plane, and AWS portal. We are building agentic experience for providing rich, secure customer experience. If you are interested in building scalable, resilient services powered by ML, let's chat.`;
      const deviceEvidence = {
        bulletTexts: [
          'Updated a React and TypeScript ticketing system with role-restricted access for internal staff.',
          'Built a web application for the district that identified devices by barcode, could trigger remote wipes, and could issue a notification when a device was labeled lost or stolen.',
        ],
      };
      const leaked = checkTargetClaimScope({
        roleThesis: 'For this role\'s Identity Center interface modernization, I would bring experience implementing role-restricted access and conditional device actions in web workflows.',
      }, [], deviceEvidence, posting);
      const general = checkTargetClaimScope({
        roleThesis: 'For this role\'s Identity Center interface modernization, I would bring experience designing secure, usable access workflows.',
      }, ['In a prior web application, I implemented role-restricted access and conditional device actions after barcode scans.'], deviceEvidence, posting);
      const evaluated = evaluateCoverLetterChecks({
        plan: { roleThesis: 'For this role\'s Identity Center interface modernization, I would bring experience implementing role-restricted access and conditional device actions in web workflows.', mappings: [], companyHook: { detail: '' } },
        paragraphs: ['For this role\'s Identity Center interface modernization, I would bring experience implementing role-restricted access and conditional device actions in web workflows.'],
        evidence: deviceEvidence,
        jobText: posting,
      });
      const directBring = checkTargetClaimScope({}, [
        'For this role\'s Identity Center interface modernization, I bring device integration experience from district workflows.',
      ], deviceEvidence, posting);
      const contribution = checkTargetClaimScope({}, [
        'For this role\'s Identity Center interface modernization, I would contribute device integration experience from district workflows.',
      ], deviceEvidence, posting);
      const closing = checkTargetClaimScope({}, [
        'I welcome a conversation about applying my access-control and device-integration work to the Identity Center interfaces this role is modernizing.',
      ], deviceEvidence, posting);
      assert(!leaked.passed && leaked.detail.includes('device'),
        'the exact AWS target thesis cannot promote the prior device workflow into the target role');
      assert(general.passed,
        `a general capability may lead while the prior workflow remains a past-tense proof sentence: ${general.detail}`);
      assert(!directBring.passed && !contribution.passed && !closing.passed && closing.detail.includes('device'),
        'target-facing prose checks cover I bring, I would contribute, and an applying-my-work closing with a hyphenated source-domain artifact');
      assert(!evaluated.find(check => check.id === 'target-claim-scope').passed,
        'the prose revision loop receives a target-claim-scope failure for the leaked target thesis');
      return { leaked: leaked.detail, general: general.detail };
    },
  },
  {
    name: 'cover letter harness: paragraph argument mappings require an explicit, concrete proof-to-need bridge in either order',
    run: () => {
      const posting = 'AWS Identity Center modernizes the control plane and AWS access portal, where teams build interfaces that show each user only the accounts and applications they are authorized to use.';
      const deficient = [
        "For AWS Identity Center's work modernizing the control plane and AWS portal, I bring experience building web interfaces with access controls. At Thomson School District, I updated a React and TypeScript ticketing system with role-restricted access for internal staff.",
        "In that role, I also built an internal tools hub with a React front end and Django back end designed to support additional tools. I would apply that full-stack experience to the interface and service work behind Identity Center's control plane and portal.",
      ];
      const deficientPlan = {
        paragraphs: [
          { argumentMapping: {
            claim: "For AWS Identity Center's work modernizing the control plane and AWS portal, I bring experience building web interfaces with access controls.",
            proof: 'At Thomson School District, I updated a React and TypeScript ticketing system with role-restricted access for internal staff.',
            relevance: "For AWS Identity Center's work modernizing the control plane and AWS portal, I bring experience building web interfaces with access controls.",
            jobNeedQuote: 'modernizes the control plane and AWS access portal',
          } },
          { argumentMapping: {
            claim: 'I would apply that full-stack experience to the interface and service work behind Identity Center\'s control plane and portal.',
            proof: 'In that role, I also built an internal tools hub with a React front end and Django back end designed to support additional tools.',
            relevance: 'I would apply that full-stack experience to the interface and service work behind Identity Center\'s control plane and portal.',
            jobNeedQuote: 'modernizes the control plane and AWS access portal',
          } },
        ],
      };
      const deficientCheck = checkParagraphArgumentLinks({ plan: deficientPlan, paragraphs: deficient, jobText: posting });
      assert(!deficientCheck.passed
        && deficientCheck.detail.includes('paragraph 1 argumentMapping.relevance does not explicitly state')
        && deficientCheck.detail.includes('paragraph 2 argumentMapping.relevance names only a vacuous target label'),
      'the existing AWS regression must flag both the unbridged opening-plus-proof paragraph and a generic interface/service bridge even when it cites a broad real posting quote');

      const relevanceFirst = 'Those access-control patterns would help Identity Center present each user only the accounts and applications they are authorized to use. My experience with access-control patterns is a practical foundation for authorization-focused workflows. At Thomson School District, I built a React and TypeScript ticketing system with role-restricted access for internal staff.';
      const passingCheck = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My experience with access-control patterns is a practical foundation for authorization-focused workflows.',
          proof: 'At Thomson School District, I built a React and TypeScript ticketing system with role-restricted access for internal staff.',
          relevance: 'Those access-control patterns would help Identity Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: [relevanceFirst], jobText: posting,
      });
      assert(passingCheck.passed,
        `a relevance-first paragraph with exact spans and an explicit authorization bridge must pass: ${passingCheck.detail}`);
      const naturalClaims = [
        {
          claim: 'I have worked on web interfaces that restrict access by role.',
          relevance: 'Those access patterns would help Identity Center present each user only the accounts and applications they are authorized to use.',
        },
        {
          claim: 'My full-stack work spans interfaces and the back-end services behind them.',
          relevance: 'That full-stack experience would help Identity Center build interfaces that show each user only authorized accounts.',
        },
      ];
      naturalClaims.forEach(({ claim, relevance }) => {
        const natural = checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim,
            proof: 'At Thomson School District, I built a React and TypeScript ticketing system with role-restricted access for internal staff.',
            relevance,
            jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
          } }] },
          paragraphs: [`${relevance} ${claim} At Thomson School District, I built a React and TypeScript ticketing system with role-restricted access for internal staff.`],
          jobText: posting,
        });
        assert(natural.passed, `natural general capability claim must pass without formulaic “experience” language: ${natural.detail}`);
      });
      const presentPerfectProof = 'At Thomson School District, I have updated a React and TypeScript ticketing system with role-restricted access for internal staff.';
      const presentPerfect = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'I build web interfaces that restrict access by role.',
          proof: presentPerfectProof,
          relevance: 'Those access patterns would help Identity Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: [`Those access patterns would help Identity Center present each user only the accounts and applications they are authorized to use. I build web interfaces that restrict access by role. ${presentPerfectProof}`],
        jobText: posting,
      });
      assert(paragraphHasCandidatePastProof(presentPerfectProof) && presentPerfect.passed,
        `a first-person present-perfect action must count as proof and pass its mapping: ${presentPerfect.detail}`);
      assert(!paragraphHasCandidatePastProof('I build web interfaces that restrict access by role.'),
        'a present-tense general capability statement must remain a claim, not a completed proof');
      const anaphoraPosting = 'AWS Identity Center enables customers and enterprises to interact securely with AWS consoles and services.';
      const anaphoraClaim = 'I have worked on web interfaces that restrict access by role.';
      const anaphoraProof = 'At Thomson School District, I updated a React and TypeScript ticketing system with role-restricted access for internal staff.';
      const anaphoraRelevance = 'I would bring that experience to Identity Center’s work enabling customers and enterprises to interact securely with AWS consoles and services.';
      const clearAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof, relevance: anaphoraRelevance,
          jobNeedQuote: 'customers and enterprises to interact securely with AWS consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} ${anaphoraRelevance}`], jobText: anaphoraPosting,
      });
      const genericAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof,
          relevance: 'I would bring that experience to your innovative team.',
          jobNeedQuote: 'customers and enterprises to interact securely with AWS consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} I would bring that experience to your innovative team.`], jobText: anaphoraPosting,
      });
      const ambiguousAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof, relevance: anaphoraRelevance,
          jobNeedQuote: 'customers and enterprises to interact securely with AWS consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} I also built an internal tools hub for staff. ${anaphoraRelevance}`], jobText: anaphoraPosting,
      });
      assert(clearAnaphora.passed && !genericAnaphora.passed
        && genericAnaphora.detail.includes('generic relevance label')
        && !ambiguousAnaphora.passed && ambiguousAnaphora.detail.includes('shared capability or mechanism'),
      `an adjacent mapped proof may support “that experience”, but generic or nonadjacent references remain insufficient: ${clearAnaphora.detail}; ${genericAnaphora.detail}; ${ambiguousAnaphora.detail}`);
      const systemProof = 'At Thomson School District, I built a role-restricted ticketing system for internal staff.';
      const implicitReferences = [
        'I would bring this experience to Identity Center’s work enabling customers and enterprises to interact securely with AWS consoles and services.',
        'I would apply that work to Identity Center’s work enabling customers and enterprises to interact securely with AWS consoles and services.',
        'I would use the system to enable customers and enterprises to interact securely with AWS consoles and services.',
        'I would use it to enable customers and enterprises to interact securely with AWS consoles and services.',
      ];
      implicitReferences.forEach(relevance => {
        const implicit = checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim: anaphoraClaim, proof: systemProof, relevance,
            jobNeedQuote: 'customers and enterprises to interact securely with AWS consoles and services',
          } }] },
          paragraphs: [`${anaphoraClaim} ${systemProof} ${relevance}`], jobText: anaphoraPosting,
        });
        assert(implicit.passed, `an immediate proof may license a clear implicit reference without restating its full noun phrase: ${implicit.detail}`);
      });
      const doppelPosting = 'The team builds secure web interfaces that turn user input into controlled back-end actions.';
      const doppelClaim = 'I have built workflows that turn user input into controlled back-end actions.';
      const doppelProof = 'At Thomson School District, I have built a web application that identified devices by barcode and could trigger a remote wipe or notification when a scanned device was marked lost or stolen.';
      const doppelRelevance = 'Those input-driven workflows would help the team turn user input into controlled back-end actions.';
      const doppel = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: doppelClaim, proof: doppelProof, relevance: doppelRelevance,
          jobNeedQuote: 'turn user input into controlled back-end actions',
        } }] },
        paragraphs: [`${doppelRelevance} ${doppelClaim} ${doppelProof}`], jobText: doppelPosting,
      });
      const mislabeledSpecificProof = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'At Thomson School District, I have built a React ticketing system with role-restricted access for internal staff.',
          proof: presentPerfectProof,
          relevance: 'Those access patterns would help Identity Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: ['Those access patterns would help Identity Center present each user only the accounts and applications they are authorized to use. At Thomson School District, I have built a React ticketing system with role-restricted access for internal staff. At Thomson School District, I have updated a React and TypeScript ticketing system with role-restricted access for internal staff.'],
        jobText: posting,
      });
      assert(doppel.passed && !mislabeledSpecificProof.passed
        && mislabeledSpecificProof.detail.includes('argumentMapping.claim must state a general candidate capability'),
      `a generalized present-perfect capability must pass while a source-specific completed artifact cannot be relabelled as the claim: ${doppel.detail}; ${mislabeledSpecificProof.detail}`);
      const simulationPosting = 'The team will create simulations using natural language.';
      const simulationRelevance = 'Those simulation-creation patterns would help create a natural-language simulation-creation flow.';
      const simulation = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My work spans simulation-creation interfaces and back-end services.',
          proof: 'At Thomson School District, I built an internal simulation tool for staff.',
          relevance: simulationRelevance,
          jobNeedQuote: 'create simulations using natural language',
        } }] },
        paragraphs: [`${simulationRelevance} My work spans simulation-creation interfaces and back-end services. At Thomson School District, I built an internal simulation tool for staff.`],
        jobText: simulationPosting,
      });
      assert(simulation.passed,
        `hyphenated and pluralized need wording must still bind a natural-language simulation bridge: ${simulation.detail}`);

      // The letter is written three stages before the audit that this check
      // reads, so the stage that writes a paragraph reports the half of this
      // verdict the paragraph alone decides. That reporter must never reject a
      // letter this check would accept, which is the property measured here:
      // for a paragraph it reports, EVERY contiguous word-run of that
      // paragraph is tried as the span it says is missing, and none of them
      // makes this check pass. Adding the span it describes then does.
      const unmappable = 'Reliable system delivery is the capability this engineering role needs, and my delivery experience supports it. I owned the internal reporting service for the colleagues who depend on it.';
      const unmappableProof = 'I owned the internal reporting service for the colleagues who depend on it.';
      const unmappablePosting = 'Engineer role focused on reliable system delivery. The team maintains internal services.';
      const spanGaps = paragraphArgumentSpanGaps(unmappable);
      assert(spanGaps.length === 1 && spanGaps[0].field === 'relevance',
        `the drafting-stage reporter names the one span this paragraph cannot supply: ${JSON.stringify(spanGaps)}`);
      const runs = [];
      const unmappableWords = unmappable.split(/\s+/u);
      for (let start = 0; start < unmappableWords.length; start += 1) {
        for (let end = start + 1; end <= unmappableWords.length; end += 1) runs.push(unmappableWords.slice(start, end).join(' '));
      }
      const mappable = runs.some(relevance => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim: 'my delivery experience supports it', proof: unmappableProof, relevance, jobNeedQuote: 'reliable system delivery' } }] },
        paragraphs: [unmappable], jobText: unmappablePosting,
      }).passed);
      assert(!mappable,
        `no span of a paragraph reported by the drafting stage can satisfy this check (${runs.length} spans tried)`);
      const repairedParagraph = `${unmappable} I would apply that experience to the reliable system delivery this role needs.`;
      const repaired = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'my delivery experience supports it',
          proof: unmappableProof,
          relevance: 'I would apply that experience to the reliable system delivery this role needs.',
          jobNeedQuote: 'reliable system delivery',
        } }] },
        paragraphs: [repairedParagraph], jobText: unmappablePosting,
      });
      assert(!paragraphArgumentSpanGaps(repairedParagraph).length && repaired.passed,
        `the span the reporter describes is the span that makes this check pass: ${repaired.detail}`);

      return { deficient: deficientCheck.detail, relevanceFirst: passingCheck.detail, naturalClaims: naturalClaims.length, presentPerfect: presentPerfect.detail, doppel: doppel.detail, simulation: simulation.detail, spansTried: runs.length };
    },
  },
  {
    name: 'cover letter harness: artifact-as-actor prose silently escapes the argument battery, and the abstraction beat is a legal claim span',
    run: () => {
      // A shipped letter that named the artifact as the actor in every
      // paragraph. Nothing rejected it: no paragraph trips the past-proof cue,
      // so none owes an argumentMapping and claim/proof/relevance went
      // ungraded. The gap was invisible because every gate downstream is
      // conditioned on that same cue.
      const artifactActor = [
        'At Stripe, Connect pairs end-to-end product experiences with integration work that reduces complexity for platforms. As a Software Engineer at Thomson School District, my device check-in/check-out web app connected barcode scanning with native device management platforms. I would apply that integration practice to Connect experiences that reduce integration lift and complexity.',
        'A separate project moved ticketing and repair tracking into third-party platforms, combining data migration workflows with integrations, automation, validation, and operational tooling.',
        'ETL pipelines handled medical data, and REST APIs opened the local database through controlled access.',
      ];
      const escaped = artifactActor.every(paragraph => !paragraphArgumentSpanGaps(paragraph, 'reducing integration lift').length);
      const agency = checkCandidateAgency(artifactActor);
      assert(escaped && !agency.passed && agency.detail.includes('argumentMapping'),
        `artifact-as-actor paragraphs owe no span and must be caught by the agency check instead: ${agency.detail}`);

      // The same evidence in the first person now owes a mapping, and the
      // paragraph is reported until it carries the abstraction beat.
      const posting = 'Make it easy for Connect platforms to scale their business while reducing integration lift and complexity.';
      const evidence = 'As a Software Engineer at Thomson School District, I built a district-wide device check-in/check-out web app that identified devices by barcode scan and acted on them through the district\u2019s device-management platforms.';
      const transfer = 'I would apply that consolidation work to Connect\u2019s dashboard surfaces, so platforms adding Instant Payouts, Issuing, or Capital carry less of the integration lift.';
      const warrant = 'The engineering was in absorbing those platforms\u2019 differences into one surface, so the staff member at the counter acted on a single screen instead of learning which system owned which action.';
      const withoutWarrant = paragraphArgumentSpanGaps(`${evidence} ${transfer}`, posting);
      const withWarrant = paragraphArgumentSpanGaps(`${evidence} ${warrant} ${transfer}`, posting);
      assert(withoutWarrant.length === 1 && withoutWarrant[0].field === 'claim' && !withWarrant.length,
        `the abstraction beat is the span that closes the claim gap: ${JSON.stringify(withoutWarrant)} then ${JSON.stringify(withWarrant)}`);
      assert(checkCandidateAgency([`${evidence} ${warrant} ${transfer}`]).passed,
        'a first-person proof satisfies the agency check');

      // A bare -ing mood is not an abstraction of the work. The gerund has to
      // take an object, or "the work was mostly rewarding" would read as a
      // capability claim.
      const mood = paragraphArgumentSpanGaps(`${evidence} The work was mostly rewarding and challenging. ${transfer}`, posting);
      assert(mood.length === 1 && mood[0].field === 'claim',
        `an adjectival -ing cannot stand in for the abstraction beat: ${JSON.stringify(mood)}`);

      return { agency: agency.detail, withoutWarrant: withoutWarrant.length, withWarrant: withWarrant.length };
    },
  },
  {
    name: 'cover letter harness: a clean synthetic letter clears every register and style check',
    run: () => {
      const groundedRange = 'Led a district intake rebuild from 2019–2022 so every permission form carried one named owner.';
      const checks = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: groundedRange }], companyHook: { detail: '' } },
        paragraphs: [
          'The registrar at Brightpath District kept losing signed permission forms because intake ran on paper. This role requires someone who can find that failure point and close it. My experience to date is in that kind of repair work.',
          'I rebuilt the intake path against the React interface and the Postgres schema the registrar already trusted. The rebuild kept one in-house core, so a single team owned end-to-end delivery. I led that work from 2019–2022 without a gap.',
          'Paper forms vanished between three desks, so I gave every form a single owner record. The same gap explained why grading feedback arrived late, which is why the second tool answered a need the first one had exposed.',
          'I have a valid driver licence for the district fleet. I can say what the rebuild cost in review time and what it saved at the front desk, and I would rather argue the mechanism than the resemblance.',
        ],
        evidence: { bulletTexts: [groundedRange] },
        jobText: [
          'Cedar Ridge Learning is hiring an engineer to extend the React interface that school registrars use every day.',
          'The work sits between the registrar desk and the district office, so you will follow a signed form from the desk where it is handed in to the record that proves it was filed.',
          'You will own the Postgres data model that carries attendance, permission, and transfer records for eleven schools.',
          'We care about how you find the failure point in that path, not about the length of a tool list.',
        ].join(' '),
        researchText: '',
        companyName: 'Cedar Ridge Learning',
      });
      const failed = checks.filter(check => !check.passed);
      assert(!failed.length,
        `a letter already written in the target register must produce no revision work: ${failed.map(check => `${check.id}: ${check.detail}`).join('; ')}`);
      return { checks: checks.length };
    },
  },
  {
    name: 'cover letter harness: the drafting-stage reporter reads the posting, so a paragraph with no legal relevance span is named before the letter freezes',
    run: () => {
      // Carrying the transfer cue is necessary for a relevance span, not
      // sufficient. This paragraph carries one, and still cannot be mapped:
      // every span wide enough to reach the posting's vocabulary also picks up
      // “experience … relevant”, which the gate rejects as a generic relevance
      // label, and every span narrow enough to escape that names nothing the
      // posting asks for. Reported by nobody until the completion gate read
      // it, with the letter three stages frozen and the only repair a rewrite.
      const posting = 'Cedar Ridge Learning needs reliable delivery for the registrar interface.';
      const paragraph = 'My delivery experience supports reliable delivery. I owned the reporting service. My experience is directly relevant to this role, and I would bring it along.';
      const claim = 'My delivery experience supports reliable delivery.';
      const proof = 'I owned the reporting service.';
      assert(paragraphHasCandidatePastProof(paragraph),
        'the fixture states a candidate past action, so the completion gate requires a mapping for it');
      const withPosting = paragraphArgumentSpanGaps(paragraph, posting);
      assert(withPosting.length === 1 && withPosting[0].field === 'relevance',
        `the reporter names the relevance span this paragraph cannot supply: ${JSON.stringify(withPosting)}`);
      assert(!paragraphArgumentSpanGaps(paragraph).length,
        'without the posting the reporter can only ask whether a transfer cue is present, which is the weaker verdict and still a subset');

      // Subset proof, the same way the sibling reporter proves it: every
      // contiguous word run of the paragraph is tried as the relevance span
      // and every contiguous word run of the posting as its job-need quote,
      // and none of them makes the gate pass. The only relevance observation
      // that reads the claim or the proof is the shared-mechanism one, so the
      // assertion also records that some OTHER relevance observation fires on
      // every pair — no choice of claim or proof could have rescued it.
      const wordRuns = (value) => {
        const words = value.split(/\s+/u);
        const runs = [];
        for (let start = 0; start < words.length; start += 1) {
          for (let end = start + 1; end <= words.length; end += 1) runs.push(words.slice(start, end).join(' '));
        }
        return runs;
      };
      const relevanceRuns = wordRuns(paragraph);
      const needRuns = wordRuns(posting);
      const independentRelevanceFailure = /argumentMapping\.relevance (?:is missing|is not an exact normalized span|uses a generic relevance label|names only a vacuous target label|does not explicitly state|does not name a concrete responsibility)/u;
      let mappablePairs = 0;
      let mechanismOnlyPairs = 0;
      for (const relevance of relevanceRuns) {
        for (const jobNeedQuote of needRuns) {
          const verdict = checkParagraphArgumentLinks({
            plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance, jobNeedQuote } }] },
            paragraphs: [paragraph], jobText: posting,
          });
          if (verdict.passed) mappablePairs += 1;
          else if (!independentRelevanceFailure.test(verdict.detail)) mechanismOnlyPairs += 1;
        }
      }
      assert(!mappablePairs && !mechanismOnlyPairs,
        `no span of a reported paragraph is a legal relevance field for any posting quote (${relevanceRuns.length} spans × ${needRuns.length} quotes, ${mappablePairs} passed, ${mechanismOnlyPairs} failed only on a claim/proof-dependent rule)`);

      // Repairability, by following the reported rule literally: state the
      // transfer outright and name a responsibility the posting states.
      const repaired = `${paragraph} I would apply that experience to the reliable delivery this registrar interface needs.`;
      assert(!paragraphArgumentSpanGaps(repaired, posting).length,
        'the span the reporter describes is the span that clears it');
      const repairedVerdict = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim, proof,
          relevance: 'I would apply that experience to the reliable delivery this registrar interface needs.',
          jobNeedQuote: 'reliable delivery for the registrar interface',
        } }] },
        paragraphs: [repaired], jobText: posting,
      });
      assert(repairedVerdict.passed,
        `the repair the reporter names is one the completion gate accepts: ${repairedVerdict.detail}`);

      // And the reporter must stay silent on a paragraph the gate accepts:
      // supplying the posting may never turn a mappable paragraph into a
      // drafting-stage rejection.
      const mappable = 'My delivery experience supports reliable delivery. I owned the reporting service. I would apply that experience to the reliable delivery this registrar interface needs.';
      assert(!paragraphArgumentSpanGaps(mappable, posting).length
        && checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim, proof,
            relevance: 'I would apply that experience to the reliable delivery this registrar interface needs.',
            jobNeedQuote: 'reliable delivery for the registrar interface',
          } }] },
          paragraphs: [mappable], jobText: posting,
        }).passed,
      'a paragraph the completion gate accepts is not reported by the drafting stage');
      return { spans: relevanceRuns.length, quotes: needRuns.length };
    },
  },
  {
    name: 'cover letter harness: plan candidate selection preserves the strongest pass and envelope remains builder-compatible',
    run: () => {
      const valid = checkPlanGate(groundedPlan, evidence, needs, 'The role must manage incident escalation.', '');
      assert(!valid.shouldRetry, 'a grounded non-stated mapping must clear the plan gate');
      const genericThesis = checkPlanGate({ ...groundedPlan, roleThesis: 'My experience aligns well with this role.' }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(genericThesis.shouldRetry && genericThesis.checks.some(check => check.id === 'role-thesis' && !check.passed),
        'a generic thesis must enter the existing plan-revision loop');
      const allStated = checkPlanGate({ ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], resumeStatus: 'stated' }] }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(allStated.shouldRetry && allStated.checks.some(check => check.id === 'plan-redundancy' && !check.passed), 'all stated mappings must request the one retry, not throw');
      const invalidNeedReference = checkPlanGate({ ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], needIndex: 9 }] }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(invalidNeedReference.shouldRetry && invalidNeedReference.checks.some(check => check.id === 'plan-need-references' && !check.passed),
        'a plan mapping may not silently point outside the ranked needs list');
      const nonPrimaryFirst = checkPlanGate({
        ...groundedPlan,
        mappings: [{ ...groundedPlan.mappings[0], narrativeRole: 'foundation' }],
      }, evidence, needs, 'The role must manage incident escalation.', '');
      const secondaryWithoutRelationship = checkPlanGate({
        ...groundedPlan,
        mappings: [
          ...groundedPlan.mappings,
          { ...groundedPlan.mappings[0], narrativeRole: 'foundation', relationToPrevious: '' },
        ],
      }, evidence, needs, 'The role must manage incident escalation.', '');
      const validFoundation = checkPlanGate({
        ...groundedPlan,
        mappings: [
          ...groundedPlan.mappings,
          {
            ...groundedPlan.mappings[0],
            evidence: 'Reduced response backlog by 32% while coordinating field crews across six districts.',
            narrativeRole: 'foundation',
            relationToPrevious: 'This supplies the operational foundation behind the primary judgment example.',
          },
        ],
      }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(nonPrimaryFirst.shouldRetry
        && secondaryWithoutRelationship.shouldRetry
        && !validFoundation.shouldRetry,
      'the plan gate requires a primary first mapping and an explicit relationship for a legitimate secondary foundation');
      const sourcedLogistics = checkLogisticsGrounding(
        { logistics: 'Available for full-time, evening, overnight, and weekend shifts.' },
        'Available for full-time, evening, overnight, and weekend shifts in security roles.',
      );
      const inventedLogistics = checkLogisticsGrounding(
        { logistics: 'Available to provide continuous, round-the-clock hospital coverage.' },
        'Available for full-time, evening, overnight, and weekend shifts in security roles.',
      );
      const scatteredShortLogistics = checkLogisticsGrounding(
        { logistics: 'Available weekends locally.' },
        'Available weekends. Current location: Memphis, TN.',
      );
      assert(!sourcedLogistics.passed && !inventedLogistics.passed && !scatteredShortLogistics.passed
        && sourcedLogistics.id === 'logistics-exclusion',
      'even career-data-supported availability and schedules are excluded from the letter argument');
      const containedSchedule = checkLogisticsContainment(
        { logistics: 'Available for full-time, evening, overnight, and weekend shifts.' },
        ['I am available for full-time, evening, overnight, and weekend shifts.'],
      );
      const inflatedCoverage = checkLogisticsContainment(
        { logistics: '' },
        ['Continuous, round-the-clock coverage kept the facility open.'],
      );
      const containmentOverflow = checkLogisticsContainment(
        { logistics: '' },
        Array.from({ length: 20 }, () => 'I am available for full-time, evening, overnight, weekend, on-call, round-the-clock, 24/7 coverage and can relocate locally or commute.'),
      );
      assert(!containedSchedule.passed && containedSchedule.id === 'logistics-exclusion'
        && inflatedCoverage.passed,
      'legacy containment rejects candidate schedule promises and does not misread impersonal coverage as a candidate promise');
      assert(!containmentOverflow.passed && containmentOverflow.detail.includes('additional observation(s) omitted')
        && containmentOverflow.detail.length < 2400 && MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS === 8,
      'logistics-exclusion detail remains bounded for hostile multi-paragraph output');
      const credentialHeavyNeeds = [
        { kind: 'credential' }, { kind: 'logistics' }, { kind: 'credential' },
        { kind: 'capability' }, { kind: 'disposition' },
      ];
      const performancePortfolio = [
        { kind: 'capability' }, { kind: 'domain' }, { kind: 'credential' },
      ];
      const firstPortfolio = checkNeedsPortfolio(credentialHeavyNeeds);
      const retryPortfolio = checkNeedsPortfolio(performancePortfolio);
      const betterPortfolio = selectBetterLetterNeeds(credentialHeavyNeeds, firstPortfolio, performancePortfolio, retryPortfolio);
      assert(!firstPortfolio.passed && retryPortfolio.passed && betterPortfolio.selected === 'retry'
        && betterPortfolio.needs === performancePortfolio,
      'a five-need credential-heavy portfolio retries once and deterministically keeps the performance-balanced result');
      const eligibilityNeeds = [
        { need: 'hold the required credential', quote: 'hold the required credential', source: 'posting', kind: 'credential' },
        { need: 'manage incident escalation', quote: 'manage incident escalation', source: 'posting', kind: 'capability' },
      ];
      const eligibilityPlan = {
        roleThesis: groundedPlan.roleThesis,
        mappings: [{ ...groundedPlan.mappings[0], needIndex: 1 }],
        companyHook: { detail: '' }, logistics: '',
        droppedNeeds: [{ needIndex: 0, reason: 'The credential is not documented on the résumé.' }],
      };
      const eligibilityGate = checkPlanGate(eligibilityPlan, evidence, eligibilityNeeds,
        'The role must hold the required credential and manage incident escalation.', '', '');
      const topDisposition = checkTopNeedDisposition(eligibilityPlan, eligibilityNeeds);
      assert(!eligibilityGate.shouldRetry && !topDisposition.passed && topDisposition.detail.includes('honestly dropped'),
        'a documented missing top eligibility screen is surfaced, but never retried into a fabricated qualification');
      const nonTopEligibilityNeeds = [
        { need: 'manage incident escalation', quote: 'manage incident escalation', source: 'posting', kind: 'capability' },
        { need: 'hold the required credential', quote: 'hold the required credential', source: 'posting', kind: 'credential' },
        { need: 'operate secure equipment', quote: 'operate secure equipment', source: 'posting', kind: 'capability' },
      ];
      const nonTopEligibilityPlan = {
        roleThesis: groundedPlan.roleThesis,
        mappings: [{ ...groundedPlan.mappings[0], needIndex: 0 }], companyHook: { detail: '' }, logistics: '',
        droppedNeeds: [{ needIndex: 1, reason: 'The credential is not documented on the résumé.' }],
      };
      const missingDisposition = checkAllNeedDisposition(nonTopEligibilityPlan, nonTopEligibilityNeeds);
      const nonTopEligibility = checkEligibilityNeedDisposition(nonTopEligibilityPlan, nonTopEligibilityNeeds);
      const nonTopEligibilityGate = checkPlanGate(nonTopEligibilityPlan, evidence, nonTopEligibilityNeeds,
        'The role must manage incident escalation, hold the required credential, and operate secure equipment.', '', '');
      assert(!missingDisposition.passed && missingDisposition.detail.includes('need 3')
        && !nonTopEligibility.passed && nonTopEligibility.detail.includes('#2 credential')
        && nonTopEligibilityGate.shouldRetry,
      'every need must be mapped or dropped, while a non-top honestly dropped credential remains visible but non-retryable on its own');
      const envelope = authorCoverLetterEnvelope({ job: { company: 'Acme', title: 'Incident Lead' }, evidence, today: formatCoverLetterDate(new Date('2026-08-14T12:00:00Z')) });
      assert(envelope.recipient === '' && envelope.salutation === 'Dear Acme Hiring Team,', 'company envelope fields use the salutation rather than a redundant recipient block');
      assert(envelope.signatureTitle === '' && envelope.closing === 'Sincerely,', 'code-authored closing omits an implied target title');
      assert(envelope.date === 'August 2026', 'app-authored cover-letter dates use month and year only');
      assert(envelope.subtitleRole === 'Operations leader' && envelope.credential === 'B.S. Operations, Example University',
        'the authored envelope preserves the résumé header role and credential as structured letterhead fields');
      const contactNormalized = authorCoverLetterEnvelope({
        job: { company: 'Acme' }, evidence: { identity: { contact: [' Toronto, ON ', '   ', '\n', 'maya@example.test'] } },
      });
      assert(JSON.stringify(contactNormalized.contact) === JSON.stringify(['Toronto, ON', 'maya@example.test']),
        'envelope contact normalizes before filtering so whitespace-only entries cannot produce blank letterhead separators');
      const fallback = authorCoverLetterEnvelope({ job: {}, evidence: { identity: {} } });
      assert(fallback.recipient === '' && fallback.salutation === 'Dear Hiring Team,' && fallback.signatureTitle === '', 'missing company/title keeps a usable envelope without a recipient block');
      const proseChecks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['The role needs clear prioritization.', 'My triage experience demonstrates that mechanism.'], evidence, researchText: '' });
      assert(Array.isArray(proseChecks) && proseChecks.length === 44, 'prose helper returns every non-page deterministic check');
      assert(proseChecks.slice(9).map(check => check.id).join(',')
        === 'compound-hyphenation,parallel-structure,prior-employer-opening,named-artifact-introduction,opening-artifact-context,vague-domain-work-label,reference-clarity,modifier-attachment,anchor-relevance,target-claim-scope,detached-relevance-claim,prospective-contribution-tense,additive-seam,responsibility-transition,tool-calls-garden-path,low-information-tool-build,containerization-technology-roles,posting-reference,claimed-equivalence,dangling-paragraph-transition,sentence-length,punctuation-style,plain-register,introductory-workplace-comma,visual-reference-precision,direct-welcome-closing,opening-demonstrative,opening-employer-shorthand,adjacent-employer-repetition,entailed-premise,repeated-sentence-shape,repeated-phrase,candidate-agency,repeated-transfer-carrier,dangling-demonstrative',
      'the register and style checks are appended after the established eight, and all of them read paragraphs only');
      const emptyHookWithResearch = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: 'Triaged incomplete emergency reports under time pressure.' }], companyHook: { detail: '' } },
        paragraphs: ['Careful prioritization under incomplete reports is the relevant mechanism.'],
        evidence,
        researchText: 'Northstar Dispatch supports Acme incident operations.',
        companyName: 'Acme',
      }).find(check => check.id === 'company-specificity');
      assert(emptyHookWithResearch?.passed && emptyHookWithResearch.detail.includes('intentionally omitted'),
        'available research must not force company padding after the plan intentionally leaves its hook empty');
      const requestedWorkSample = 'Please include a link to something you have built and shipped — a repo, a deployed app, or a demo — with your application.';
      const missingWorkSample = checkRequestedWorkSampleLink(requestedWorkSample, '<main><a href="mailto:maya@example.test">Email</a></main>');
      const linkedWorkSample = checkRequestedWorkSampleLink(requestedWorkSample, '<main><a href="https://example.test/demo">Demo</a></main>');
      const notRequested = checkRequestedWorkSampleLink('Build and ship internal tools.', '<main></main>');
      assert(!missingWorkSample.passed && missingWorkSample.id === 'work-sample-link'
        && linkedWorkSample.passed && notRequested.passed,
      'a posting-requested work-sample link must stay visible unless the résumé contains a clickable http(s) URL');
      return { validChecks: valid.checks.length, retryChecks: allStated.checks.length, sourcedLogistics: sourcedLogistics.detail, portfolio: betterPortfolio.selected, topNeed: topDisposition.detail, nonTopEligibility: nonTopEligibility.detail, proseChecks: proseChecks.length };
    },
  },
  {
    name: 'cover letter harness: a sentence shape repeated through the letter is reported, and deliberate parallelism is not',
    run() {
      // The defect this measures came off a real letter: four paragraphs that
      // each ended "I would <verb> this <noun> to <company>'s <work>". Every
      // existing check was blind to it. checkShape counts paragraphs and
      // words; checkRedundancy and checkSalientPhraseEcho compare the letter
      // to the RÉSUMÉ, never paragraph to paragraph; and the rotated verb
      // means no two closings share a run anywhere near the résumé shingle
      // floor, so lowering that floor would not have found it either.
      const templated = [
        'At Axonify, the Intermediate Software Developer role centers on frontend user interfaces and backend services. I have experience building software across frontend user interfaces and backend services. At Thomson School District, I built an internal tools hub from scratch with React on the frontend and a backend application, and I containerized it for deployment across VM configurations. I would apply this experience to features that cross Axonify’s frontend user interfaces and backend services.',
        'On the interface side, my experience includes React and TypeScript interface work. At Thomson School District, I enhanced an in-house ticketing system by restricting access for internal staff by role, using React and TypeScript. I would use this experience to build robust user interfaces across Axonify’s browsers and platforms.',
        'On the backend side, my background includes Python APIs and SQL automations. At Horizon Health Alliance, I built REST APIs for controlled access to a local medical database and implemented SQL automations to surface patients missing prescribed treatment appointments. I would bring this experience to Axonify’s backend services, with attention to data quality.',
        'My engineering practice also includes AI-assisted software development workflows. At Thomson School District, I used traditional and AI-assisted workflows to optimize speed, cost efficiency, and engineering quality. I would apply this practice to Axonify’s use of AI coding tools in development.',
      ];
      const reported = checkRepeatedSentenceShape(templated);
      assert(!reported.passed && reported.id === 'repeated-sentence-shape'
        && reported.detail.includes('paragraph 1 sentence 4')
        && reported.detail.includes('paragraph 4 sentence 3')
        && reported.detail.includes('“i would * this *”')
        && reported.detail.includes(`at most ${sharedSentenceShapeCeiling(templated.length)} of these ${templated.length} paragraphs`)
        && reported.detail.includes(`at least ${templated.length - sharedSentenceShapeCeiling(templated.length)} of those ${templated.length} sentences must be rewritten`),
      `the repeated shape is reported with the sentence each repeat sits in, the shape read, the ceiling that would pass, and how many sentences have to move (detail=${reported.detail})`);
      // The message must carry no em dash and no replacement wording: it is
      // quoted back to the writer verbatim, and candidate copy may not contain
      // an em dash at all.
      assert(!/[—–]/u.test(reported.detail),
        `the observation hands the writer no dash it could copy into the letter (detail=${reported.detail})`);
      // Why no run-length check could see this, measured rather than asserted.
      const runWords = value => (String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      const closings = templated.map(paragraph => sentences(paragraph).slice(-1)[0]);
      let longestClosingRun = 0;
      for (let left = 0; left < closings.length; left++) {
        for (let right = left + 1; right < closings.length; right++) {
          const leftWords = runWords(closings[left]);
          const rightWords = runWords(closings[right]);
          leftWords.forEach((_, start) => {
            let run = 0;
            while (leftWords[start + run] && rightWords.includes(leftWords[start + run])
              && leftWords[start + run] === rightWords[rightWords.indexOf(leftWords[start]) + run]) run++;
            longestClosingRun = Math.max(longestClosingRun, run);
          });
        }
      }
      assert(longestClosingRun < 5,
        `the templated closings share no run a shingle check could catch (longest=${longestClosingRun})`);

      // Deliberate parallelism is not a template. Three of five paragraphs
      // closing alike is epistrophe a writer chose; rejecting it would cost a
      // handoff round for a non-defect, so the ceiling is all but two.
      // The triad is spread across paragraphs 1, 3 and 5 rather than run
      // together. That placement is the whole allowance now: the count ceiling
      // permits parallelism a reader meets with a paragraph in between, and the
      // adjacency branch reports the same triad back-to-back, because what a
      // reader registers as one template filled three times is consecutive.
      const parallel = [
        'Training software for people who are not at a desk has to be boring in the right places. That is the kind of problem I like.',
        'I containerized an internal tools hub so any VM configuration produced one stack.',
        'I restricted the district ticketing system by staff role in React and TypeScript. That is the kind of problem I like.',
        'My SQL automations surfaced patients whose prescribed treatment appointments were missing.',
        'None of it was glamorous, and none of it broke quietly. That is the kind of problem I like.',
      ];
      assert(checkRepeatedSentenceShape(parallel).passed,
        `a deliberate parallel triad spread through a five-paragraph letter is not a template (detail=${checkRepeatedSentenceShape(parallel).detail})`);
      assert(sharedSentenceShapeCeiling(3) === 2 && sharedSentenceShapeCeiling(4) === 2
        && sharedSentenceShapeCeiling(5) === 3 && sharedSentenceShapeCeiling(6) === 4,
      'the ceiling is all but two paragraphs, and never below two');
      // One more paragraph on the same shape is the template again, so the
      // rule has a repair target rather than an open-ended instruction.
      assert(!checkRepeatedSentenceShape([parallel[0],
        'I containerized an internal tools hub so any VM configuration produced one stack. That is the kind of problem I like.',
        ...parallel.slice(2)]).passed,
      'four of five paragraphs closing alike is past the ceiling');

      // A letter too short to have a template is never reported: there is no
      // repair to name when two paragraphs are the whole letter.
      assert(checkRepeatedSentenceShape([
        'I would bring this practice to the platform work.',
        'I would bring this habit to the release work.',
      ]).passed, `a ${MIN_SHARED_SHAPE_PARAGRAPHS - 1}-paragraph letter is below the floor the contract prints`);
      // A sentence whose whole shape is shorter than the compared window, or
      // is mostly content, is not judged rather than being judged by a frame
      // too thin to mean anything.
      assert(checkRepeatedSentenceShape(['Reports arrived late.', 'Reports arrived late.', 'Reports arrived late.']).passed,
        `a sentence shorter than ${SENTENCE_SHAPE_FRAME_WORDS} shape elements carries no comparable shape`);
      assert(checkRepeatedSentenceShape([undefined, null, '']).passed && checkRepeatedSentenceShape().passed,
        'an absent or empty letter reports nothing');
      return { ceiling: sharedSentenceShapeCeiling(4), longestClosingRun, frameWords: SENTENCE_SHAPE_FRAME_WORDS };
    },
  },
  {
    name: 'cover letter harness: the repeated-shape read is position-blind, so a template that moves out of the closings is still reported',
    run() {
      // Measured on the live paste run. The letter of 2026-09-21 was rejected
      // for four paragraphs closing on one shape. The repair rotated two
      // closings, cleared the check, and left the template where a reader
      // meets it first: every paragraph walked into its evidence with "As a
      // <role> at <employer>, my <noun> included". Reading one position
      // measured the position, not the letter, so every sentence is read now.
      const movedTemplate = [
        'This role combines frontend user interfaces with backend services in the same implementation. I have experience with full-stack development across UI and backend concerns. As a Software Engineer at Thomson School District, my full-stack work included an internal-tools hub whose frontend used React. The hub was containerized for deployment across VM configurations, with scalability considered for both the UI and backend. This experience would help with features that span frontend user interfaces and backend services in this role.',
        'On the interface side, my experience includes React and TypeScript interface work. As a Software Engineer at Thomson School District, I enhanced an in-house ticketing system by restricting access for internal staff by role, using React and TypeScript. I would use this React and TypeScript experience to build robust user interfaces across browsers and platforms in this role.',
        'On the backend side, my background includes Python APIs and SQL automations. As a Data Engineer at Horizon Health Alliance, my work included Python REST APIs for controlled access to a local medical database. I worked with SQL automations that informed therapists when patients had not made necessary appointments for prescribed treatment sessions. This Python and SQL experience would support backend services in this role, with attention to data quality.',
        'AI-assisted development complements the cross-stack implementation this role requires. As a Software Engineer at Thomson School District, my engineering practice included traditional and AI-assisted software development workflows. I used those workflows to optimize speed, cost efficiency, and engineering quality. I would apply this practice while developing frontend and backend code with AI coding tools in this role.',
      ];
      // The blind spot, measured rather than asserted: read only the closing
      // sentence and this letter is inside the ceiling on every shape.
      const closingShapes = new Map();
      movedTemplate.forEach(paragraph => {
        const probe = checkRepeatedSentenceShape(new Array(3).fill(sentences(paragraph).slice(-1)[0]));
        const frame = /same sentence shape “([^”]*)”/u.exec(probe.detail)?.[1];
        if (frame) closingShapes.set(frame, (closingShapes.get(frame) || 0) + 1);
      });
      assert(Math.max(...closingShapes.values()) <= sharedSentenceShapeCeiling(movedTemplate.length),
        `the closing-only read passes this letter (shapes=${JSON.stringify([...closingShapes])})`);

      const moved = checkRepeatedSentenceShape(movedTemplate);
      assert(!moved.passed && moved.detail.includes('“as a * at *”')
        && moved.detail.includes('paragraph 1 sentence 3, paragraph 2 sentence 2, paragraph 3 sentence 2 and paragraph 4 sentence 2'),
      `the shape is reported wherever it sits, with the sentence that carries it in each paragraph (detail=${moved.detail})`);
      // The same letter also signposts two consecutive paragraphs with one
      // shape, which the count of two out of four never reached. That is now
      // its own item in the same message, so the writer is told about both in
      // the round that reports either.
      assert(moved.detail.includes('“on the * my *”')
        && moved.detail.includes('paragraph 2 sentence 1 and paragraph 3 sentence 1 carry the same sentence shape'),
      `the back-to-back signpost is named alongside the count defect (detail=${moved.detail})`);

      // The repair the message names, applied literally: two of the four
      // sentences on the counted shape rewritten, and the two rewritten are
      // the paragraphs that re-enter an employer already introduced, so the
      // role stays attached where each employer is first named; plus the one
      // sentence the adjacency item names.
      const repaired = [...movedTemplate];
      repaired[1] = repaired[1].replace(
        'As a Software Engineer at Thomson School District, I enhanced an in-house ticketing system by restricting access for internal staff by role, using React and TypeScript.',
        'The in-house ticketing system I enhanced at Thomson School District restricted access for internal staff by role, using React and TypeScript.');
      repaired[2] = repaired[2].replace(
        'On the backend side, my background includes Python APIs and SQL automations.',
        'Python APIs and SQL automations are where my background sits.');
      repaired[3] = repaired[3].replace(
        'As a Software Engineer at Thomson School District, my engineering practice included traditional and AI-assisted software development workflows.',
        'My engineering practice at Thomson School District included traditional and AI-assisted software development workflows.');
      const afterRepair = checkRepeatedSentenceShape(repaired);
      assert(afterRepair.passed,
        `rewriting exactly the number of sentences the message names clears the check in one round (detail=${afterRepair.detail})`);

      // The rule this one could collide with: a proof-bearing paragraph still
      // owes a claim span and a transfer span, and the repair must not have
      // bought its variety by dropping either. Measured on every paragraph,
      // before and after.
      const posting = 'Build robust user interfaces across browsers and platforms, and core backend services with Python and SQL.';
      const gapsBefore = movedTemplate.map(paragraph => paragraphArgumentSpanGaps(paragraph, posting).map(gap => gap.field).join(','));
      const gapsAfter = repaired.map(paragraph => paragraphArgumentSpanGaps(paragraph, posting).map(gap => gap.field).join(','));
      assert(gapsBefore.every(gaps => gaps === '') && gapsAfter.every(gaps => gaps === ''),
        `the varied letter still carries every claim and transfer span the argument rules require (before=${JSON.stringify(gapsBefore)} after=${JSON.stringify(gapsAfter)})`);

      // False positives are the cost that matters: a fired check spends a
      // handoff round on good writing. Twelve letters written to vary their
      // structure, including three that repeat a shape on purpose, a letter
      // that names one employer in four paragraphs, and a six-paragraph
      // letter, are all inside the ceiling on every position.
      const varied = [
        ['one employer, four paragraphs, varied entry',
          'Dispatch software fails in the minutes nobody is watching it, which is the part of the job this posting describes. Three years at Northstar Dispatch taught me where those minutes are.',
          'The incident queue there lost its ordering whenever two supervisors edited a shift at once. I rebuilt the write path so the later edit had to read the earlier one first, and the duplicate dispatches stopped.',
          'Reporting was the second problem. Supervisors wanted the weekly numbers on Monday morning, and the export took until Tuesday, so I moved the aggregation into a nightly job and the Monday meeting got its numbers.',
          'Neither fix was clever. Both came from sitting with the dispatchers for a week before writing anything, and I would start the same way on a queue I did not build.'],
        ['six paragraphs, clinical operations',
          'Infusion scheduling is a capacity problem wearing a calendar, and this coordinator role is written as one.',
          'At Lakeview Oncology I ran the chair schedule for eleven nurses. Overbooking by one chair cost an hour of nurse time, and underbooking cost a patient a week.',
          'The fix was a standing Thursday review of the next two weeks with the charge nurse. Cancellations stopped being surprises because somebody had already looked at them.',
          'Pharmacy was the other constraint. I learned to ask for the mix time before promising a slot, which is dull and which is why the chairs stayed full.',
          'When the clinic added Saturday hours, that review was the thing I carried over, and I would bring the same practice to a schedule with more sites than I have run before.',
          'I am available for a conversation whenever it is useful.'],
        ['analyst, evidence introduced three ways',
          'Forecast accuracy is mostly a data-hygiene problem, and the posting puts hygiene first.',
          'At Corvid Retail I owned the weekly demand forecast for nine hundred SKUs. Returns were being counted as sales in the warehouse feed, which inflated every fast mover until I traced it to a status code the vendor had reused.',
          'Once the feed was honest, the model got simpler. I dropped two features the noise had been propping up and the error fell.',
          'Buyers still needed a number they could argue with, so the weekly note said which SKUs the model was least sure about. That is the part I would bring here.'],
        // The second half used to open on the same signpost as the first. That
        // pair is the adjacency defect now, so the letter that stays inside
        // every rule signposts its second half some other way.
        ['technical writer, two halves signposted differently',
          'Documentation that nobody opens is a support cost wearing a wiki.',
          'On the API side, my work has been the reference nobody reads until something breaks. I rewrote the error tables for a payments API so each code named the caller mistake that produced it, and the tickets that quoted a code dropped.',
          'Release notes were the other half of it. I moved the changelog into the pull request template so it was written while the author still remembered why.',
          'Both habits came from watching support queues rather than from a style guide, and I would apply that to your developer portal.'],
        ['security engineer, five paragraphs',
          'Access reviews are where a security program either becomes real work or becomes a spreadsheet.',
          'At Harbor Mutual the quarterly review covered four hundred accounts and was approved wholesale every time. I split it by system owner so each approver saw thirty rows they recognized, and the first honest quarter revoked sixty accounts.',
          'Revocation broke two jobs nobody had documented. Fixing them took a week and produced the first list of service accounts the company had.',
          'A year later the review took a morning. The list was the reason.',
          'I would start a program here the same way, with a review small enough that somebody reads it.'],
        ['support lead, varied transfer placement',
          'Escalation policy is the only part of a support organization that customers can feel.',
          'At Tidewater Software I rewrote ours after a week where three customers waited two days for the same missing owner. Naming a single accountable engineer per escalation, rather than a rotation, is what changed the clock.',
          'I would bring that policy here, though the harder half was getting engineering to accept it, and that took showing the wait times by team rather than by ticket.',
          'Your posting describes a queue with two products and one rotation, which is where the same argument would start.'],
      ];
      const falsePositives = varied.filter(([, ...paragraphs]) => !checkRepeatedSentenceShape(paragraphs).passed);
      assert(falsePositives.length === 0,
        `letters that vary their structure are not reported (fired=${JSON.stringify(falsePositives.map(([label]) => label))})`);

      // Parallelism inside one paragraph is the writer's business: a shape a
      // single paragraph repeats counts once for that paragraph.
      const insideOneParagraph = [
        'I kept the reporting service dependable for the people who depend on it. I wrote the runbook the rotation followed. I wrote the checklist the rotation signed. I wrote the summary the rotation filed.',
        'Deployment was the other half of that work, and scripting it was what let a colleague repeat it without me.',
        'That practice would support the delivery this role needs.',
      ];
      assert(checkRepeatedSentenceShape(insideOneParagraph).passed,
        `a shape one paragraph repeats inside itself is counted once (detail=${checkRepeatedSentenceShape(insideOneParagraph).detail})`);

      // Every shape over the ceiling is the same defect, so they travel in one
      // item and one round clears the class. Past the cap the writer is told
      // shapes remain rather than being handed a silent pass on them.
      const templatedEverywhere = [
        'I rebuilt the intake queue with a single owner. The report is the first thing a supervisor reads. We scripted that step for the night rotation. My work at Acme was steady. In the same year I rewrote the on-call rota.',
        'I rewrote the escalation policy with a named engineer. The runbook is the first page a responder opens. We rehearsed that drill for the weekend shift. My month at Corvid was quiet. In the same month I replaced the paging tree.',
        'I moved the reconciliation calendar with a written owner. The summary is the first slide a director sees. We timed that release for the quiet window. My quarter at Pell was clean. In the same quarter I retired the manual journal.',
      ];
      const batched = checkRepeatedSentenceShape(templatedEverywhere);
      assert(!batched.passed && (batched.detail.match(/reduce to the same sentence shape/gu) || []).length === 4
        && batched.detail.includes('1 additional repeated shape(s) omitted'),
      `a letter templated at five positions names four of them and says one remains (detail=${batched.detail})`);
      return { reportedShape: 'as a * at *', variedLetters: varied.length, falsePositives: falsePositives.length };
    },
  },
  {
    name: 'cover letter harness: the relevance span’s shared-word rule and its anaphora exception are exactly what the review contract now prints',
    run() {
      // Measured on the live paste run's third paragraph. The review contract
      // promised a relevance span "sharing a word of five letters or more
      // with the claim or the proof, unless it is the sentence directly after
      // the proof sentence and refers back to it". Both halves overpromised.
      // argumentContentWords drops ARGUMENT_STOP_WORDS before counting, and
      // "experience" is on that list — the obvious word to share. And the
      // adjacency exception is not reference in general: it is six fixed
      // phrases with nothing between the determiner and the noun, so "That
      // backend experience", which refers back in plain English, is not one.
      // A reviewer who wrote to the loose version selected a span the gate
      // rejects, at the last and most expensive stage, with a rewrite of the
      // paragraph as the only repair.
      const posting = 'Develop backend services that make up the core solution, with attention to performance and data quality.';
      const need = 'Develop backend services that make up the core solution, with attention to performance and data quality.';
      const claim = 'my background includes Python APIs and SQL automations';
      const proof = 'I built REST APIs for controlled access to a local medical database';
      const grade = (relevance, paragraph) => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance, jobNeedQuote: need } }] },
        paragraphs: [paragraph], jobText: posting,
      });

      // The live paragraph, reduced to its three spans. Its closing shares
      // "experience" with nothing that counts, and its anaphora carries a
      // modifier, so neither route to the mechanism rule is open.
      const liveRelevance = 'That backend experience would support the backend services, with attention to data quality';
      const live = grade(liveRelevance, `On the backend side, ${claim}. As a data engineer, ${proof} and implemented SQL automations. ${liveRelevance}.`);
      assert(!live.passed && live.detail.includes('shared capability or mechanism'),
        `a closing that refers back with a modifier in the phrase is rejected, however plainly it refers back: ${live.detail}`);

      // Neither cue is the problem: the same span passes every other
      // condition, which is why the failure reads as one line and not five.
      assert(live.detail.split('; ').length === 1,
        `the live closing fails only the mechanism rule, so the rewrite it needs is the one the message names: ${live.detail}`);

      // Direction one of the repair the contract now names: carry a word the
      // claim or proof already carries.
      const carried = 'I would apply that database and automation work to the backend services, with attention to data quality';
      const repaired = grade(carried, `On the backend side, ${claim}. As a data engineer, ${proof} and implemented SQL automations. ${carried}.`);
      assert(repaired.passed,
        `carrying a counted word of the proof forward accepts the same paragraph in one round: ${repaired.detail}`);

      // Direction two: the bare anaphora the exception really accepts, with
      // no word between the determiner and the noun.
      const bare = 'I would apply that experience to the backend services, with attention to data quality';
      const bareResult = grade(bare, `On the backend side, ${claim}. As a data engineer, ${proof} and implemented SQL automations. ${bare}.`);
      assert(bareResult.passed,
        `the exception accepts the phrase written with nothing between “that” and “experience”: ${bareResult.detail}`);

      // The stop list, proved rather than asserted: a relevance that shares
      // ONLY "experience" — ten letters, and the word a reader would call
      // shared — does not satisfy the rule.
      const stopWordClaim = 'my experience covers controlled access to records';
      const stopWordProof = 'I built REST APIs for a local medical database';
      const stopWordRelevance = 'I would apply that experience to the backend services and the data quality they need';
      const stopWordOnly = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim: stopWordClaim, proof: stopWordProof, relevance: stopWordRelevance, jobNeedQuote: need } }] },
        // Separating the proof from the relevance by one sentence closes the
        // adjacency exception, so only the shared word can carry this mapping.
        paragraphs: [`On the backend side, ${stopWordClaim}. As a data engineer, ${stopWordProof}. The same work covered scheduling reminders. ${stopWordRelevance}.`],
        jobText: posting,
      });
      assert(!stopWordOnly.passed && stopWordOnly.detail.includes('shared capability or mechanism'),
        `"experience" is on the stop list, so sharing it alone is not the shared word the rule counts: ${stopWordOnly.detail}`);

      // The printed rules name both facts, and name them from this module.
      assert(ARGUMENT_RELEVANCE_MECHANISM_RULE.includes('experience')
        && ARGUMENT_RELEVANCE_MECHANISM_RULE.includes('never count as that shared word'),
      'the printed mechanism rule names the stop list rather than leaving it to be discovered');
      assert(ARGUMENT_RELEVANCE_ANAPHORA_RULE.includes('no word between the two')
        && ARGUMENT_RELEVANCE_ANAPHORA_RULE.includes('that backend experience'),
      'the printed anaphora rule states that a modifier inside the phrase takes it outside the exception');
      assert(ARGUMENT_MAPPING_REQUIRED_RULE.includes('omitted rather than supplied'),
        'the printed mapping-required rule states that a paragraph with no listed verb omits its mapping instead of supplying one');
      return { liveDetail: live.detail };
    },
  },
  {
    name: 'cover letter harness: a mapping span is copied out on word boundaries, so the drafting-stage reporter sees every span the completion gate accepts',
    run: () => {
      // The reporter that runs three stages earlier enumerates what a
      // paragraph offers by walking its words; the gate took any substring.
      // A span cut out of the middle of a word was therefore legal at
      // completion and invisible to the reporter — the direction that costs a
      // rewrite, because the letter is reported unmappable at the stage that
      // could still change it, for a field the gate would have accepted.
      // Measured on the mappable paragraph below: the gate used to accept 774
      // spans of it, 670 of them cuts no word-walk can reach.
      const posting = 'Cedar Ridge Learning needs reliable systems delivery for the registrar interface.';
      const jobNeedQuote = 'reliable systems delivery for the registrar interface';
      const paragraph = 'My delivery experience supports dependable delivery. I owned the reporting microsystems delivery path, helping this team.';
      const claim = 'My delivery experience supports dependable delivery.';
      const proof = 'I owned the reporting microsystems delivery path, helping this team.';
      // “systems delivery path, …” is inside “microsystems”: its letters are
      // all there, and “microsystem” is not a word this posting uses, so the
      // cut is what made the span name the posting's own vocabulary.
      const midWord = 'systems delivery path, helping this team.';
      const at = paragraph.indexOf(midWord);
      assert(at > 0 && /\p{L}/u.test(paragraph[at - 1]),
        'the fixture span is an exact substring of the paragraph that begins inside a word');
      const midWordVerdict = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance: midWord, jobNeedQuote } }] },
        paragraphs: [paragraph], jobText: posting,
      });
      assert(!midWordVerdict.passed && midWordVerdict.detail.includes('begins or ends inside a word')
        && midWordVerdict.detail.includes('copy it out on word boundaries'),
      `the gate rejects a mid-word cut and names the repair: ${midWordVerdict.detail}`);
      assert(paragraphHasCandidatePastProof(paragraph),
        'the fixture states a candidate past action, so the completion gate requires a mapping for it');
      const gaps = paragraphArgumentSpanGaps(paragraph, posting);
      assert(gaps.length === 1 && gaps[0].field === 'relevance',
        `and the reporter reaches the same verdict about the same paragraph: ${JSON.stringify(gaps)}`);

      // Exact agreement, measured rather than argued: every span of a mappable
      // paragraph is tried as its relevance field, and every one the gate
      // accepts is a span a word-boundary walk enumerates. The count is
      // asserted too, so a narrowing that accepted nothing at all could not
      // pass this as a vacuous truth.
      const mappable = 'My delivery experience is dependable. I owned the service. I would apply that experience to reliable systems delivery.';
      const mappableClaim = 'My delivery experience is dependable.';
      const mappableProof = 'I owned the service.';
      const isWordCharacter = (character) => typeof character === 'string' && /[\p{L}\p{N}]/u.test(character);
      const wordAligned = (span) => {
        const text = mappable.toLowerCase();
        const needle = span.toLowerCase().replace(/\s+/gu, ' ').trim();
        for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
          const opens = !(isWordCharacter(text[index - 1]) && isWordCharacter(text[index]));
          const closes = !(isWordCharacter(text[index + needle.length - 1]) && isWordCharacter(text[index + needle.length]));
          if (opens && closes) return true;
        }
        return false;
      };
      let tried = 0;
      let accepted = 0;
      let acceptedUnaligned = 0;
      for (let start = 0; start < mappable.length; start += 1) {
        for (let end = start + 1; end <= mappable.length; end += 1) {
          const relevance = mappable.slice(start, end);
          if (!relevance.trim()) continue;
          tried += 1;
          const verdict = checkParagraphArgumentLinks({
            plan: { paragraphs: [{ argumentMapping: { claim: mappableClaim, proof: mappableProof, relevance, jobNeedQuote } }] },
            paragraphs: [mappable], jobText: posting,
          });
          if (!verdict.passed) continue;
          accepted += 1;
          if (!wordAligned(relevance)) acceptedUnaligned += 1;
        }
      }
      assert(accepted > 0 && !acceptedUnaligned,
        `every span this gate accepts is one the reporter can enumerate (${tried} tried, ${accepted} accepted, ${acceptedUnaligned} of them unreachable by a word walk)`);
      // And wider than the whitespace runs the reporter used to walk, which is
      // why it walks word boundaries instead of splitting on spaces: this span
      // drops the sentence's final period, so no run of whole space-separated
      // tokens produces it, and the gate accepts it.
      const spaceRuns = [];
      const tokens = mappable.split(/\s+/u);
      for (let start = 0; start < tokens.length; start += 1) {
        for (let end = start + 1; end <= tokens.length; end += 1) spaceRuns.push(tokens.slice(start, end).join(' '));
      }
      const trimmedOfPunctuation = 'I would apply that experience to reliable systems delivery';
      assert(!spaceRuns.includes(trimmedOfPunctuation)
        && checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: { claim: mappableClaim, proof: mappableProof, relevance: trimmedOfPunctuation, jobNeedQuote } }] },
          paragraphs: [mappable], jobText: posting,
        }).passed,
      'a span trimmed of its trailing punctuation is accepted and is not a run of whole space-separated tokens');
      assert(!paragraphArgumentSpanGaps(mappable, posting).length,
        'and the reporter stays silent on the paragraph the gate accepts spans of');
      return { tried, accepted, midWordDetail: midWordVerdict.detail };
    },
  },
  {
    name: 'cover letter harness: a letter that restates itself is reported run by run, and the runs its own rules require are not',
    run() {
      // The letter of 2026-09-23, verbatim, and why it is the fixture:
      // LETTER_THAT_RESTATES_ITSELF above.
      const restated = LETTER_THAT_RESTATES_ITSELF;
      const reported = checkRepeatedPhrase(restated);
      assert(!reported.passed && reported.id === 'repeated-phrase',
        `the letter that restates itself is reported (detail=${reported.detail})`);
      // The user's own complaint first: one noun phrase, stated twice, two
      // sentences apart. Then the two the same paragraph and the next one
      // carry. Each is named with the run and with both sentences that hold it.
      assert(reported.detail.includes('paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “scalability across the ui and backend”'),
        `the six-word run stated twice in one paragraph is named with both of its sentences (detail=${reported.detail})`);
      // The complaint was three occurrences, not two: the paragraph's transfer
      // sentence reached back for part of the same run on top of the re-naming
      // its own rules mandate. See the transfer-sentence test below for what is
      // blanked there and what is not.
      assert(reported.detail.includes('paragraph 1 sentence 2, paragraph 1 sentence 3 and paragraph 1 sentence 5 repeat one run of 3 words, “ui and backend”'),
        `the third occurrence, inside the transfer sentence, is named with the two it echoes (detail=${reported.detail})`);
      assert(reported.detail.includes('paragraph 2 sentence 1 and paragraph 2 sentence 2 repeat one run of 3 words, “device management platforms”'),
        `a three-word run repeated inside one paragraph is reported (detail=${reported.detail})`);
      assert(reported.detail.includes('paragraph 1 sentence 4 and paragraph 2 sentence 3 repeat one run of 4 words, “the engineering challenge was”'),
        `a four-word run carried into the next paragraph is reported (detail=${reported.detail})`);
      // The argument contract REQUIRES the transfer carrier in every
      // proof-bearing paragraph, so the four words two paragraphs share here
      // are compliance. Reporting them would make two rules contradict each
      // other, and it would spend a handoff round asking for a repair the
      // other rule forbids.
      assert(!reported.detail.includes('i would apply that'),
        `the mandated transfer carrier is not charged to the writer (detail=${reported.detail})`);
      // Same-paragraph repeats lead: they are the ones a reader hits hardest
      // and the ones repaired without touching another paragraph.
      assert(reported.detail.indexOf('inside paragraph 2') < reported.detail.indexOf('across paragraphs'),
        `same-paragraph repeats are reported before cross-paragraph ones (detail=${reported.detail})`);
      assert(!/[—–]/u.test(reported.detail),
        `the observation hands the writer no dash it could copy into the letter (detail=${reported.detail})`);
      // No replacement wording. The only quoted spans are the offending runs
      // themselves, which is naming the offense rather than writing the
      // repair, the rule stated beside checkRepeatedSentenceShape.
      const quoted = [...reported.detail.matchAll(/“([^”]*)”/gu)].map(([, run]) => run);
      assert(quoted.length > 0 && quoted.every(run => restated.some(paragraph => paragraph.toLowerCase().includes(run))),
        `every quoted span is a run the letter already contains (quoted=${JSON.stringify(quoted)})`);

      // The two floors, measured against each other. The same three words sit
      // in one paragraph in the first letter and in two paragraphs in the
      // second; only the first is reported, because inside one paragraph the
      // first statement is still in the reader's head when the echo arrives.
      const withinOne = [
        'The district office ran three systems that never spoke to each other. I rebuilt the check-in workflow at the district office so a barcode scan updated the asset record directly.',
        'Reporting was the other problem, and moving it was the harder half.',
        'I welcome a conversation about either.',
      ];
      const acrossTwo = [
        'The district office ran three systems that never spoke to each other.',
        'I rebuilt the check-in workflow at the district office so a barcode scan updated the asset record directly.',
        'I welcome a conversation about either.',
      ];
      assert(!checkRepeatedPhrase(withinOne).passed && checkRepeatedPhrase(acrossTwo).passed,
        `a ${MIN_SAME_PARAGRAPH_REPEAT_WORDS}-word run is a repeat inside one paragraph and is not one across two`
        + ` (within=${checkRepeatedPhrase(withinOne).detail}; across=${checkRepeatedPhrase(acrossTwo).detail})`);

      // A name is supposed to recur, and how often it may is already
      // checkPriorEmployerOpening's and checkAdjacentEmployerRepetition's
      // business. Measured against the twin above rather than argued: the two
      // letters differ only in whether the three words are a proper name.
      const named = withinOne.map(paragraph => paragraph.replaceAll('the district office', 'Thomson School District'));
      assert(checkRepeatedPhrase(named).passed,
        `a run of nothing but a proper name is not this check's to report (detail=${checkRepeatedPhrase(named).detail})`);

      // The carrier exclusion, measured the same way: the run two transfer
      // sentences share is long enough to report and is not reported, and the
      // clean letter beside it shows the check is not simply silent.
      const runWordsOf = value => (String(value).toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []);
      const longestVerbatimRun = (left, right) => {
        const leftWords = runWordsOf(left);
        const rightWords = runWordsOf(right);
        let longest = 0;
        for (let start = 0; start < leftWords.length; start++) {
          for (let other = 0; other < rightWords.length; other++) {
            let length = 0;
            while (leftWords[start + length] && leftWords[start + length] === rightWords[other + length]) length++;
            longest = Math.max(longest, length);
          }
        }
        return longest;
      };
      const carrierLetter = [
        'Dispatch reliability is what this role is written around, and it is what my last three years were about.',
        'At Northstar Dispatch the incident queue lost its ordering whenever two supervisors edited a shift at once. I rebuilt the write path so the later edit had to read the earlier one first. I would apply that experience to the ordering guarantees your queue needs.',
        'Reporting was the other problem. Supervisors wanted Monday numbers and the export ran until Tuesday, so I moved the aggregation into a nightly job. I would apply that practice to the weekly figures your operations team publishes.',
        'I welcome a conversation about either.',
      ];
      const sharedCarrier = longestVerbatimRun(sentences(carrierLetter[1]).slice(-1)[0], sentences(carrierLetter[2]).slice(-1)[0]);
      assert(sharedCarrier >= MIN_CROSS_PARAGRAPH_REPEAT_WORDS && checkRepeatedPhrase(carrierLetter).passed,
        `the ${sharedCarrier}-word run two mandated transfers share is past the cross-paragraph floor and is still not reported`
        + ` (detail=${checkRepeatedPhrase(carrierLetter).detail})`);

      // False positives are the cost that matters: a fired check spends a
      // handoff round on good writing. A letter that says each thing once is
      // silent.
      const clean = [
        'Dispatch software fails in the minutes nobody is watching it, which is the part of the job this posting describes. Three years at Northstar Dispatch taught me where those minutes are.',
        'The incident queue there lost its ordering whenever two supervisors edited a shift at once. I rebuilt the write path so the later edit had to read the earlier one first, and the duplicate dispatches stopped.',
        'Reporting was the second problem. Supervisors wanted the weekly numbers on Monday morning, and the export took until Tuesday, so I moved the aggregation into a nightly job and the Monday meeting got its numbers.',
        'Neither fix was clever. Both came from sitting with the dispatchers for a week before writing anything, and I would start the same way on a queue I did not build.',
      ];
      const passing = checkRepeatedPhrase(clean);
      assert(passing.passed && passing.detail.includes(`${clean.length} paragraph(s)`)
        && passing.detail.includes(`${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words inside one paragraph`)
        && passing.detail.includes(`${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words across paragraphs`),
      `a letter that says each thing once passes, and says which two floors it cleared (detail=${passing.detail})`);
      assert(checkRepeatedPhrase([]).passed && checkRepeatedPhrase().passed && checkRepeatedPhrase([null, '']).passed,
        'an absent or empty letter reports nothing');
      const throughHelper = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: restated, evidence, researchText: '',
      }).find(check => check.id === 'repeated-phrase');
      assert(throughHelper && !throughHelper.passed,
        'the check is registered in the prose battery the paste validator runs, not only callable on its own');
      return { reported: (reported.detail.match(/repeat one run of/gu) || []).length, sharedCarrier };
    },
  },
  {
    name: 'cover letter harness: one shape in back-to-back paragraphs is a filled template the count ceiling never reached',
    run() {
      // Measured on the same letter. Two of its four paragraphs entered their
      // evidence on one frame, "In that role, my application experience
      // includes" and "In that Software Engineer role, my migration experience
      // spans", and two of four is exactly the ceiling, so the count said
      // nothing. The ceiling was built to permit deliberate parallelism; what a
      // reader registers as one template filled twice is consecutive.
      const template = [
        'Full-stack work joins the interface with the services behind it.',
        'In that role, my application experience includes connected systems and scan-triggered features. I developed the check-in web app that drove a physical barcode scanner.',
        'In that Software Engineer role, my migration experience spans integrations, automation and validation. I moved the ticketing system and its data onto a third-party platform.',
        'I welcome a conversation about either.',
      ];
      const shape = checkRepeatedSentenceShape(template);
      assert(!shape.passed && shape.id === 'repeated-sentence-shape'
        && shape.detail.includes('paragraph 2 sentence 1 and paragraph 3 sentence 1 carry the same sentence shape “in that * my *” in back-to-back paragraphs'),
      `a frame two consecutive paragraphs carry is reported with both of its sentences (detail=${shape.detail})`);
      // It is reported at a count the ceiling passes, which is the whole point
      // of the branch, and the message does the subtraction rather than leaving
      // the writer to work out that breaking a pair costs one rewrite.
      assert(shape.detail.includes(`the ${sharedSentenceShapeCeiling(template.length)} paragraphs the count allows one shape`)
        && shape.detail.includes('so at least 1 of those 2 sentences must be rewritten to a different shape'),
      `the report names the ceiling it is below and how many sentences have to move (detail=${shape.detail})`);
      assert(!/[—–]/u.test(shape.detail),
        `the adjacency observation carries no dash the letter could copy (detail=${shape.detail})`);

      // Adjacency is what fires, measured rather than argued: the same two
      // sentences with one paragraph between them are the same count and are
      // not reported.
      const spread = [template[0], template[1], template[3], template[2]];
      const spreadShape = checkRepeatedSentenceShape(spread);
      assert(spreadShape.passed,
        `the same frame with a paragraph between its two carriers is the parallelism the ceiling permits (detail=${spreadShape.detail})`);
      // And a rewrite of one of the two clears it, so the message has a repair
      // target rather than an open-ended instruction.
      const repairedTemplate = [...template];
      repairedTemplate[2] = repairedTemplate[2].replace(
        'In that Software Engineer role, my migration experience spans integrations, automation and validation.',
        'Migration was the other half of that Software Engineer role, and it spanned integrations, automation and validation.');
      assert(checkRepeatedSentenceShape(repairedTemplate).passed,
        `rewriting the one sentence the message names clears the check (detail=${checkRepeatedSentenceShape(repairedTemplate).detail})`);
      return { ceiling: sharedSentenceShapeCeiling(template.length) };
    },
  },
  {
    name: 'cover letter harness: a repeated run of nothing but English syntax is excused, and one content word more is reported',
    run() {
      // Latent rather than live, which is the reason it gets a test rather than
      // a wait: none of the real prose fixtures in this file trips it, and the
      // first letter that reaches for "in order to" in two sentences of one
      // paragraph pays a manual handoff round for restating nothing, reading a
      // message that says it made the same statement twice.
      const passing = checkRepeatedPhrase(ORDINARY_SYNTAX_REPEATED_PROSE);
      assert(passing.passed,
        `prose whose only repeats are syntax says each thing once (detail=${passing.detail})`);

      // A negative control proves nothing unless the check had to reach the
      // exclusion to stay silent, so each run is measured where it sits rather
      // than assumed to be there: at or past the floor its own distance uses,
      // and repeated at that distance in two different sentences.
      const runSites = run => {
        const found = [];
        ORDINARY_SYNTAX_REPEATED_PROSE.forEach((paragraph, paragraphIndex) => {
          sentences(paragraph).forEach((sentence, sentenceIndex) => {
            if (sentence.toLowerCase().includes(run)) found.push({ paragraph: paragraphIndex + 1, sentence: sentenceIndex + 1 });
          });
        });
        return found;
      };
      const unmeasured = ORDINARY_SYNTAX_REPEATED_RUNS.filter(({ run, distance }) => {
        const inside = distance === 'inside';
        const floor = inside ? MIN_SAME_PARAGRAPH_REPEAT_WORDS : MIN_CROSS_PARAGRAPH_REPEAT_WORDS;
        const found = runSites(run);
        const repeatedAtDistance = found.some(left => found.some(right => (inside
          ? left.paragraph === right.paragraph && left.sentence !== right.sentence
          : left.paragraph !== right.paragraph)));
        return run.split(' ').length < floor || !repeatedAtDistance;
      });
      assert(!unmeasured.length,
        `every excused run is past its own floor and repeated at its own distance: unmeasured=${JSON.stringify(unmeasured)}`);

      // The boundary itself, measured rather than argued, because the cheaper
      // rule was available and is wrong: "every word is a function word" would
      // still report seven of the ten runs above, each of which carries exactly
      // one content word (order, well, worked, able, time, work, things), while
      // the real repeats in the letter of 2026-09-23 carry two and three. So the
      // line sits at MIN_REPEAT_CONTENT_WORDS content words, and one word of the
      // same run is the entire distance between excused and reported.
      const twin = [...ORDINARY_SYNTAX_REPEATED_PROSE];
      twin[0] = twin[0].replace('Then I worked on the ledger,', 'Then I worked on the scanner ledger,');
      const twinReported = checkRepeatedPhrase(twin);
      assert(!twinReported.passed && twinReported.detail.includes('“i worked on the scanner”'),
        `one content word added to an excused run makes that run a repeat (detail=${twinReported.detail})`);

      // And the contract prints the exclusion from the same constant, or a
      // writer over-corrects around a rule that never reached the sentence.
      assert(REPEATED_PHRASE_RULE.includes(`fewer than ${MIN_REPEAT_CONTENT_WORDS} content words`),
        `the printed rule states the content-word exclusion from the check's own floor (rule=${REPEATED_PHRASE_RULE})`);
      return { excused: ORDINARY_SYNTAX_REPEATED_RUNS.length, twinRun: 'i worked on the scanner' };
    },
  },
  {
    name: 'cover letter harness: the syntax exclusion leaves every defect measured on the letter of 2026-09-23 reported',
    run() {
      // What the exclusion cost, paid on the letter that produced both checks.
      // Four defects were real in it, three runs and one shape, and an exclusion
      // that reached any of them would have bought its silence with the
      // rejection the user asked for in the first place.
      const repeats = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF);
      const shape = checkRepeatedSentenceShape(LETTER_THAT_RESTATES_ITSELF);
      const unreported = [
        ['the six-word run stated twice inside paragraph 1', repeats,
          'paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “scalability across the ui and backend”'],
        ['the three-word run stated twice inside paragraph 2', repeats,
          'paragraph 2 sentence 1 and paragraph 2 sentence 2 repeat one run of 3 words, “device management platforms”'],
        ['the four-word run carried from paragraph 1 into paragraph 2', repeats,
          'paragraph 1 sentence 4 and paragraph 2 sentence 3 repeat one run of 4 words, “the engineering challenge was”'],
        ['the frame paragraphs 2 and 3 enter their evidence on', shape,
          'paragraph 2 sentence 1 and paragraph 3 sentence 2 carry the same sentence shape “in that * my *” in back-to-back paragraphs'],
      ].filter(([, check, printed]) => check.passed || !check.detail.includes(printed));
      assert(!unreported.length,
        `every real defect in that letter is still named: unreported=${JSON.stringify(unreported.map(([label]) => label))}`
        + ` (repeats=${repeats.detail}; shape=${shape.detail})`);
      // Each of the three runs carries at least the content the exclusion asks
      // for, which is why they survive it, and the shortest of them is the
      // measurement that put MIN_REPEAT_CONTENT_WORDS where it is: "the
      // engineering challenge was" is four words carrying exactly two.
      const shortest = 'the engineering challenge was'.split(' ')
        .filter(word => !['the', 'was'].includes(word)).length;
      assert(shortest === MIN_REPEAT_CONTENT_WORDS,
        `the thinnest real repeat sits exactly on the content floor (content=${shortest}, floor=${MIN_REPEAT_CONTENT_WORDS})`);
      return { runs: (repeats.detail.match(/repeat one run of/gu) || []).length, shortest };
    },
  },
  {
    name: 'cover letter harness: the mandated transfer carrier is excused by its words and charged by its shape, and the rule that mandates it offers the repair',
    run() {
      // Read as one rule these two look like a contradiction, and the next
      // reader is the one likely to "fix" it: checkRepeatedPhrase blanks the
      // mandated carrier out of its comparison while the adjacency branch of
      // checkRepeatedSentenceShape reports two consecutive paragraphs for
      // carrying that carrier's shape, both on the same two sentences of the
      // same letter. This pins the asymmetry as deliberate.
      const repeats = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF);
      const shape = checkRepeatedSentenceShape(LETTER_THAT_RESTATES_ITSELF);
      assert(!repeats.passed && !repeats.detail.includes('i would apply that'),
        `the carrier's words are never charged to the writer (detail=${repeats.detail})`);
      assert(!shape.passed
        && shape.detail.includes('paragraph 1 sentence 5 and paragraph 2 sentence 4 carry the same sentence shape “i would * that *” in back-to-back paragraphs'),
      `that same carrier's shape in back-to-back paragraphs is charged (detail=${shape.detail})`);

      // Why the two answers differ: they read different levels, and what the
      // rule left to the writer differs at each. ARGUMENT_RELEVANCE_SPAN_RULE
      // mandates a transfer carrier and offers a CHOICE of shapes to carry it
      // in, so the words of the chosen one are compliance while the choice of
      // shape is the writer's. Measured on the letter's own paragraphs: 2 and 3
      // transferred on two different offered shapes and the span gate accepts
      // both, and strip the carrier out of 3 and that gate reports the paragraph
      // has no relevance span at all, which is what makes the carrier mandated
      // rather than merely usual.
      const [, withWould, withCan] = LETTER_THAT_RESTATES_ITSELF;
      const carrierless = withCan.replace(
        ' I can apply that operational transition approach to implementation, deployment, and ongoing operational health.', '');
      const gapFields = paragraph => paragraphArgumentSpanGaps(paragraph).map(gap => gap.field);
      assert(!gapFields(withWould).includes('relevance') && !gapFields(withCan).includes('relevance')
        && gapFields(carrierless).includes('relevance'),
      'the span gate mandates a carrier and takes either shape of it'
        + ` (would=${JSON.stringify(gapFields(withWould))}, can=${JSON.stringify(gapFields(withCan))},`
        + ` stripped=${JSON.stringify(gapFields(carrierless))})`);
      assert(ARGUMENT_RELEVANCE_SPAN_RULE.includes('I would apply') && ARGUMENT_RELEVANCE_SPAN_RULE.includes('I can apply'),
        `the rule the letter obeys enumerates both shapes (rule=${ARGUMENT_RELEVANCE_SPAN_RULE})`);

      // So the repair the shape report asks for lies inside the rule the carrier
      // obeys: rotate one of the two paragraphs onto another shape the same rule
      // offers, and the carrier report is gone with the paragraph's relevance
      // span intact and its new carrier still uncharged as words. The other
      // frame those paragraphs share is a different defect and stays reported,
      // so this measures the one report rather than the check's verdict.
      const rotated = [...LETTER_THAT_RESTATES_ITSELF];
      rotated[0] = rotated[0].replace('I would apply that scalability approach', 'I can bring that scalability approach');
      const afterRotation = checkRepeatedSentenceShape(rotated);
      assert(!afterRotation.detail.includes('i would * that *')
        && !gapFields(rotated[0]).includes('relevance')
        && !checkRepeatedPhrase(rotated).detail.includes('i can bring that'),
      'rotating onto another offered shape clears the carrier report and stays compliant'
        + ` (shape=${afterRotation.detail}; gaps=${JSON.stringify(gapFields(rotated[0]))})`);
      return { chargedShape: 'i would * that *', rotatedTo: 'i can bring that' };
    },
  },
  {
    name: 'cover letter harness: inside its own paragraph a transfer sentence is compared with only its mandated words blanked',
    run() {
      // The first build of this exclusion took the WHOLE transfer sentence out
      // of the comparison against its own paragraph, and the letter of
      // 2026-09-23 is what that cost. The user counted three occurrences of one
      // phrase in paragraph 1; the check reported two, because the third sat in
      // the sentence the exemption blanked entirely.
      const repeats = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF);
      assert(!repeats.passed
        && repeats.detail.includes('paragraph 1 sentence 2, paragraph 1 sentence 3 and paragraph 1 sentence 5 repeat one run of 3 words, “ui and backend”'),
      `the transfer sentence's own echo of its paragraph is reported (detail=${repeats.detail})`);
      // Both runs are named, because the two repairs differ: sentence 5 drops
      // three words it hung off a mandated phrase, sentences 2 and 3 share six.
      // A filter that dropped the shorter run for sitting inside the longer one
      // is what hid sentence 5 even once it was compared.
      assert(repeats.detail.includes('paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “scalability across the ui and backend”'),
        `the longer run the echo sits inside keeps its own two sentences (detail=${repeats.detail})`);
      // Nothing the rules dictate is charged: not the carrier, and not the
      // capability phrase the carrier hands over.
      for (const mandated of ['i would apply that', 'that scalability approach']) {
        assert(!repeats.detail.includes(mandated),
          `the mandated “${mandated}” is not charged to the writer (detail=${repeats.detail})`);
      }

      // The exclusion is measured from both sides, because one that never fires
      // and one that fires on everything both look like a passing test from one
      // side only. A paragraph carrying nothing but its mandated re-namings is
      // silent; the same paragraph with one clause copied out of its proof
      // sentence and hung off the same mandated phrase is reported.
      const mandatedOnly = checkRepeatedPhrase([LETTER_WITH_MANDATED_RE_NAMINGS]);
      assert(mandatedOnly.passed,
        `a transfer sentence carrying only its mandated re-namings is silent (detail=${mandatedOnly.detail})`);
      const elaborated = checkRepeatedPhrase([LETTER_WITH_MANDATED_RE_NAMINGS.replace(
        'I would apply my experience delivering supported systems to reliable system delivery',
        'I would apply my experience delivering supported systems for internal users to reliable system delivery')]);
      assert(!elaborated.passed && elaborated.detail.includes('“for internal users”'),
        `one clause carried out of the proof sentence on top of those re-namings is reported (detail=${elaborated.detail})`);

      // The six phrases ARGUMENT_RELEVANCE_ANAPHORA_RULE permits in place of the
      // re-naming are excused too, read off the same regexes the rule is printed
      // from rather than a second list.
      //
      // The back-reference is placed where NO other exclusion reaches it —
      // between the capability phrase the carrier hands over and the “to” that
      // introduces the responsibility — because a phrase sitting in either of
      // those slots is already blanked by position, and a case that put it there
      // stayed silent with the anaphora exclusion switched off entirely. Both
      // controls flip one thing each: drop the carrier and the same words are
      // reported, and swap “the system” for a back-reference the rule does NOT
      // permit and they are reported too.
      const anaphoraSentences = 'Release safety is what the posting is written around.'
        + ' I rebuilt the system in Django so a failed deploy rolled itself back.'
        + ' I would apply that rollback practice across the system in Django to the deploy safety this role needs.';
      const anaphora = checkRepeatedPhrase([anaphoraSentences]);
      assert(anaphora.passed,
        `a permitted anaphoric back-reference is not a repeat of its own antecedent (detail=${anaphora.detail})`);
      const withoutCarrier = checkRepeatedPhrase([anaphoraSentences.replace('I would apply that rollback practice across', 'The rollback practice reached across')]);
      const unpermitted = checkRepeatedPhrase([anaphoraSentences.replaceAll('the system in Django', 'the platform in Django')]);
      assert(!withoutCarrier.passed && withoutCarrier.detail.includes('“the system in django”')
        && !unpermitted.passed && unpermitted.detail.includes('“the platform in django”'),
      'the same words are reported in a sentence carrying no transfer carrier, and a back-reference the rule does not permit is reported inside one'
        + ` (noCarrier=${withoutCarrier.detail}; unpermitted=${unpermitted.detail})`);

      // The need's own wording, where a caller holds the quote the paragraph
      // answers. Both halves are measured: the same letter is reported with no
      // quote supplied and silent with it, so the parameter is doing the work
      // rather than sitting unread.
      const needEcho = ['The listing states reliable system delivery as the first responsibility.'
        + ' At Acme I rebuilt the release path so a failed deploy rolled itself back.'
        + ' I would apply that release practice across reliable system delivery and the on-call rotation this team keeps.'];
      const withoutQuote = checkRepeatedPhrase(needEcho);
      const withQuote = checkRepeatedPhrase(needEcho, { jobNeedQuotes: ['reliable system delivery'] });
      assert(!withoutQuote.passed && withoutQuote.detail.includes('“reliable system delivery”') && withQuote.passed,
        'the wording a paragraph\'s job-need quote mandates is excused where the caller holds that quote'
        + ` (without=${withoutQuote.detail}; with=${withQuote.detail})`);
      // And the battery reads that quote off the plan it is handed rather than
      // leaving the caller to pass it separately, measured through the helper the
      // paste validator calls: the audit's coverLetterPlan is the one record in
      // this pipeline that holds a jobNeedQuote, a plan built from a
      // coverLetterArgument alone holds none, and a quote naming some other
      // responsibility excuses nothing.
      const throughBattery = plan => evaluateCoverLetterChecks({
        plan, paragraphs: needEcho, evidence, researchText: '',
      }).find(check => check.id === 'repeated-phrase');
      const argumentOnlyPlan = { mappings: [{}], companyHook: { detail: '' } };
      assert(!throughBattery(argumentOnlyPlan).passed
        && throughBattery({ ...argumentOnlyPlan, paragraphs: [{ argumentMapping: { jobNeedQuote: 'reliable system delivery' } }] }).passed
        && !throughBattery({ ...argumentOnlyPlan, paragraphs: [{ argumentMapping: { jobNeedQuote: 'incident response rotas' } }] }).passed,
      'the battery reads each paragraph\'s own job-need quote off the plan it is given'
        + ` (argument-only=${throughBattery(argumentOnlyPlan).detail})`);

      // Across paragraphs the carrier is still the only thing blanked, which is
      // what round 2 measured and this round leaves alone: two transfer
      // sentences in two paragraphs are compared in full past their carriers.
      const acrossParagraphs = checkRepeatedPhrase([
        'Release safety is what this role is written around.',
        'At Acme the deploy path had no rollback. I rebuilt it so a failed deploy rolled itself back.'
        + ' I would apply that rollback practice to the release safety this team needs.',
        'Reporting was the other half. I moved the aggregation into a nightly job.'
        + ' I would apply that rollback practice to the weekly figures your operations team publishes.',
        'I welcome a conversation about either.',
      ]);
      assert(!acrossParagraphs.passed
        && acrossParagraphs.detail.includes('paragraph 2 sentence 3 and paragraph 3 sentence 3 repeat one run of 5 words, “that rollback practice to the”'),
      `two paragraphs transferring in the same words past the carrier are still reported (detail=${acrossParagraphs.detail})`);
      return {
        thirdOccurrence: 'ui and backend',
        elaboration: 'for internal users',
        crossParagraph: 'that rollback practice to the',
      };
    },
  },
  {
    name: 'cover letter harness: a repeated run is reported as the measurement it is rather than as a statement made twice',
    run() {
      // The old message ended "is the same statement made twice". That asserts a
      // cause, and the cause is untrue wherever the run is a lowercase compound
      // artifact name: the design system's own fixture letter names one artifact
      // twice in one paragraph and says something different about it each time.
      // The run stays reported — it is indistinguishable in structure from the
      // "device management platforms" repeat this check exists for, and the
      // letter contract already asks for the shortest unambiguous reference
      // after a first mention — so the wording is what changes, not the gate.
      const named = checkRepeatedPhrase([DESIGN_SYSTEM_ARTIFACT_PARAGRAPH]);
      assert(!named.passed && named.detail.includes('repeat one run of 4 words, “device check-in and check-out”'),
        `a compound artifact name repeated in full inside one paragraph is still reported (detail=${named.detail})`);
      assert(named.detail.includes(`the floor inside one paragraph is ${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words`)
        && named.detail.includes('satisfies the rule while it stands at one position only'),
      `the observation states the floor it measured against and what would satisfy it (detail=${named.detail})`);

      // Neither branch asserts a cause, and the cross-paragraph branch keeps the
      // structure of the same-paragraph one, measured on the letter that carries
      // both distances at once.
      const both = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF).detail;
      assert(both.includes(`the floor from one paragraph into another is ${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words`)
        && both.includes('satisfies the rule while it stands at one position only'),
      `the cross-paragraph branch states its own floor in the same shape (detail=${both})`);
      for (const claim of ['the same statement made twice', 'is a restatement', 'restating itself']) {
        for (const [label, detail] of [['the named-artifact run', named.detail], ['the measured letter', both]]) {
          assert(!detail.includes(claim), `${label} asserts no cause (“${claim}” in detail=${detail})`);
        }
      }

      // The rule the letter contract prints carries the same change, or the
      // responder is told the thing the report stopped saying.
      for (const claim of ['the same statement made twice', 'a statement made twice', 'is the letter restating itself']) {
        assert(!REPEATED_PHRASE_RULE.includes(claim),
          `the printed rule asserts no cause either (“${claim}” in rule=${REPEATED_PHRASE_RULE})`);
      }
      assert(REPEATED_PHRASE_RULE.includes(`${MIN_SAME_PARAGRAPH_REPEAT_WORDS} words or more repeated inside one paragraph`)
        && REPEATED_PHRASE_RULE.includes(`${MIN_CROSS_PARAGRAPH_REPEAT_WORDS} words or more carried from one paragraph into another`)
        && REPEATED_PHRASE_RULE.includes('is reported at every position it stands in past the first'),
      `the rule states both floors and what is reported (rule=${REPEATED_PHRASE_RULE})`);
      // And it discloses the exclusions a transfer sentence relies on, so a
      // writer does not rewrite the words another rule demanded.
      for (const disclosed of ['capability phrase that carrier hands over', 'responsibility phrase it reaches',
        'job-need quote puts there', 'is counted like any other wording']) {
        assert(REPEATED_PHRASE_RULE.includes(disclosed),
          `the rule discloses “${disclosed}” (rule=${REPEATED_PHRASE_RULE})`);
      }
      return { namedRun: 'device check-in and check-out' };
    },
  },
  {
    name: 'cover letter harness: direct-welcome-closing accepts the employer\'s own name and attributes the missing half',
    run: () => {
      // Ground truth for a 4-round rejection loop (2026-09-24,
      // 13:08:05Z–13:10:40Z, fingerprint 752d8241 on every round): each pair
      // below is identical except the FAIL sentence names the employer by
      // name — the shape every other rule in this app pushes a writer
      // toward — while the PASS sentence uses the generic "your" lexicon that
      // already worked. Each FAIL sentence must pass once companyName names
      // that employer, and must still fail with no companyName or with a
      // DIFFERENT one — proving the matcher accepts the employer's own name,
      // not any proper noun in the sentence.
      const companyTargetPairs = [
        {
          fail: 'I welcome a conversation about how my integration work could support Micromart’s smart-store rollout.',
          pass: 'I welcome a conversation about how my integration work could support your smart-store rollout.',
        },
        {
          fail: 'I welcome a conversation about applying that MCP server experience to Micromart’s inventory sync.',
          pass: 'I welcome a conversation about applying that MCP server experience to your inventory pipeline.',
        },
        {
          fail: 'I welcome a conversation about how the connector I built could support Micromart stores.',
          pass: 'I welcome a conversation about how the connector I built could support the store platform.',
        },
      ];
      for (const { fail, pass } of companyTargetPairs) {
        const namedCompany = checkDirectWelcomeClosing([fail], 'Micromart');
        const noCompany = checkDirectWelcomeClosing([fail], '');
        const differentCompany = checkDirectWelcomeClosing([fail], 'Northwind Robotics');
        const genericControl = checkDirectWelcomeClosing([pass], '');
        assert(namedCompany.passed,
          `naming the employer by name must pass once companyName supplies that name (sentence=${JSON.stringify(fail)}, detail=${namedCompany.detail})`);
        assert(!noCompany.passed,
          `the identical sentence must still fail with no companyName (detail=${noCompany.detail})`);
        assert(!differentCompany.passed,
          `the identical sentence must still fail against a DIFFERENT company, proving this is not "any proper noun passes" (detail=${differentCompany.detail})`);
        assert(genericControl.passed,
          `the generic "your …" control sentence must already pass on its own (detail=${genericControl.detail})`);
      }

      // Legal-suffix stripping, and the parenthesized-acronym form this app's
      // own STACK_TOOL_LEXICON already demonstrates is a real company-name
      // shape ("Amazon Web Services (AWS)"), must not throw and must still
      // match — the full name, and its distinctive leading token.
      const suffixed = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Micromart’s smart-store rollout.'],
        'Micromart Inc.',
      );
      assert(suffixed.passed,
        `"Micromart Inc." must strip its legal suffix so "Micromart’s" still matches (detail=${suffixed.detail})`);
      let awsLeadingTokenThrew = false;
      let awsLeadingToken = { passed: false, detail: '' };
      try {
        awsLeadingToken = checkDirectWelcomeClosing(
          ['I welcome a conversation about how my integration work could support Amazon’s smart-store rollout.'],
          'Amazon Web Services (AWS)',
        );
      } catch {
        awsLeadingTokenThrew = true;
      }
      let awsFullNameThrew = false;
      let awsFullName = { passed: false, detail: '' };
      try {
        awsFullName = checkDirectWelcomeClosing(
          ['I welcome a conversation about how my integration work could support Amazon Web Services (AWS)’s smart-store rollout.'],
          'Amazon Web Services (AWS)',
        );
      } catch {
        awsFullNameThrew = true;
      }
      assert(!awsLeadingTokenThrew && awsLeadingToken.passed,
        `a parenthesized company name must not throw building its matcher, and its leading token must match (threw=${awsLeadingTokenThrew}, detail=${awsLeadingToken.detail})`);
      assert(!awsFullNameThrew && awsFullName.passed,
        `the full parenthesized company name must also match without throwing (threw=${awsFullNameThrew}, detail=${awsFullName.detail})`);

      // A company name too short to be safe (2 characters) builds no pattern
      // at all: the sentence still fails, and the message never offers a name
      // the matcher itself would refuse.
      const shortName = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support AB’s inventory sync.'],
        'AB',
      );
      assert(!shortName.passed && !shortName.detail.includes('own name exactly as this letter'),
        `a company name under 3 characters must build no pattern and must not be offered as a naming option (detail=${shortName.detail})`);

      // A company name that normalizes to nothing but a stopword ("The")
      // must not start matching ordinary "the <word>" prose that the GENERIC
      // lexicon does not already cover on its own — "the details are settled"
      // names no employer-facing noun, so this must still fail.
      const stopwordName = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Widgetco once the details are settled.'],
        'The',
      );
      assert(!stopwordName.passed,
        `a stopword-only company name must build no pattern, so unrelated "the …" prose is not mistaken for a match (detail=${stopwordName.detail})`);
      // The same stopword-only companyName must not interfere with a
      // sentence the GENERIC lexicon legitimately passes on its own.
      const stopwordOrdinary = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support the district team.'],
        'The',
      );
      assert(stopwordOrdinary.passed,
        `a stopword-only companyName must not break an otherwise-passing generic closing (detail=${stopwordOrdinary.detail})`);

      // Per-half attribution: the same job's letter was rejected for this
      // check 4 consecutive rounds because the single fixed message quoted
      // asset and action examples but never a target example, so a writer who
      // already had both kept rewriting the two halves that were never
      // broken. A sentence missing only the target must be told about the
      // target and nothing else; a sentence missing only the asset must be
      // told about the asset and nothing else.
      const targetOnlyMissing = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Micromart’s smart-store rollout.'],
        '',
      );
      assert(!targetOnlyMissing.passed
        && targetOnlyMissing.detail.includes('the sentence is missing its target half')
        && targetOnlyMissing.detail.includes('reach the employer’s side too')
        // The reader-noun example set must agree with the design-system docs
        // and with what EMPLOYER_FACING_TARGET actually accepts (client(s) /
        // customer(s) / user(s) / student(s) / patient(s) / here): the message
        // used to demonstrate only "customers" and "users", so a writer
        // reaching for the docs' own "clients" example had no way to learn the
        // check would already accept it.
        && targetOnlyMissing.detail.includes('“clients”, “customers”, “users”')
        && !targetOnlyMissing.detail.includes('never a bare demonstrative')
        && !targetOnlyMissing.detail.includes('authorship clause')
        && !targetOnlyMissing.detail.includes('say what that asset does for the target work'),
      `a sentence missing only the target half must name the target operation and not repeat the asset or action instructions (detail=${targetOnlyMissing.detail})`);
      const assetOnlyMissing = checkDirectWelcomeClosing(
        ['I welcome a conversation about that could support your smart-store rollout.'],
        '',
      );
      assert(!assetOnlyMissing.passed
        && assetOnlyMissing.detail.includes('the sentence is missing its asset half')
        && assetOnlyMissing.detail.includes('never a bare demonstrative')
        && !assetOnlyMissing.detail.includes('reach the employer’s side too')
        && !assetOnlyMissing.detail.includes('say what that asset does for the target work'),
      `a sentence missing only the asset half must name the asset operation and not repeat the target or action instructions (detail=${assetOnlyMissing.detail})`);

      // checkDirectWelcomeClosing's own design note says a modal-only guard
      // "measurably rejected" this present-tense closing shape, which is why
      // CONTRIBUTION_VERBS_PRESENT exists — but checkProspectiveContributionTense
      // rejected the identical present-tense bridge in the identical sentence,
      // pulling the two checks in opposite directions. Once
      // checkDirectWelcomeClosing certifies this sentence class as a direct
      // closing invitation, checkProspectiveContributionTense must not then
      // fail it for using the present tense that certification requires.
      const tugOfWarParagraphs = [
        'I built and shipped several data pipelines at my last company.',
        'I welcome the chance to talk about how my pipeline experience helps me contribute to your platform team.',
      ];
      const tugClosing = checkDirectWelcomeClosing(tugOfWarParagraphs);
      const tugTense = checkProspectiveContributionTense(tugOfWarParagraphs);
      assert(tugClosing.passed,
        `the certified closing invitation must pass checkDirectWelcomeClosing (detail=${tugClosing.detail})`);
      assert(tugTense.passed,
        `checkProspectiveContributionTense must not reject a sentence checkDirectWelcomeClosing has already certified as a direct, present-tense closing invitation (detail=${tugTense.detail})`);
      // The exemption is scoped to the final paragraph only: the identical
      // present-tense bridge, appearing anywhere else, is exactly the shape
      // this check exists to catch and must still be caught.
      const tugNotClosing = checkProspectiveContributionTense([
        'I welcome the chance to talk about how my pipeline experience helps me contribute to your platform team.',
        'Thank you again for your time and consideration.',
      ]);
      assert(!tugNotClosing.passed,
        `the identical present-tense bridge must still be caught when it is not in the final paragraph (detail=${tugNotClosing.detail})`);
      return { targetOnlyMissing: targetOnlyMissing.detail, assetOnlyMissing: assetOnlyMissing.detail };
    },
  },
  {
    name: 'cover letter harness: the company leading-token target matcher is case-sensitive so ordinary English words do not falsely satisfy it',
    run: () => {
      // VERIFIED collision (companyNameTargetPattern, coverLetterChecks.js):
      // a multi-word company's leading token used to match CASE-INSENSITIVELY,
      // guarded only by length>=3 and a 3-word stopword set. "Best Buy" ->
      // "Best" matched ordinary candidate-facing prose ("my best work"), so
      // the target half of the three-part closing requirement was falsely
      // satisfied without the sentence ever reaching the employer's side — a
      // false PASS on a check gating a paste handoff. This app's own job
      // board turns up real employers whose leading token is an ordinary
      // English word too: Float, Loop Financial, Provision, Stripe, Top Hat.
      const genericBestProse = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support my best work.'],
        'Best Buy',
      );
      assert(!genericBestProse.passed
        && genericBestProse.detail.includes('the sentence is missing its target half'),
      `lowercase "best" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Best Buy" (detail=${genericBestProse.detail})`);

      // The full (suffix-stripped) company name keeps matching CASE-
      // INSENSITIVELY by design — only the leading-token alternative changed.
      const fullNameLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support best buy’s checkout flow.'],
        'Best Buy',
      );
      assert(fullNameLowercase.passed,
        `the full company name must still satisfy the target half case-insensitively (detail=${fullNameLowercase.detail})`);

      // The leading token still matches when a letter capitalizes it exactly
      // as the company spells it — the shape a letter naming the employer
      // actually writes ("Best's checkout flow", "Provision's ingestion
      // pipeline").
      const leadingTokenCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Best’s checkout flow.'],
        'Best Buy',
      );
      assert(leadingTokenCapitalized.passed,
        `the capitalized leading token must still satisfy the target half (detail=${leadingTokenCapitalized.detail})`);

      // Full company name, capitalized as written, is unaffected either way.
      const fullNameCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Best Buy’s checkout flow.'],
        'Best Buy',
      );
      assert(fullNameCapitalized.passed,
        `the full company name capitalized as written must still satisfy the target half (detail=${fullNameCapitalized.detail})`);

      return {
        genericBestProse: genericBestProse.detail,
        fullNameLowercase: fullNameLowercase.detail,
        leadingTokenCapitalized: leadingTokenCapitalized.detail,
      };
    },
  },
  {
    name: 'cover letter harness: a single-word company name matches the target half case-sensitively, not case-insensitively like a multi-word full name',
    run: () => {
      // VERIFIED collision (companyNameTargetPattern, coverLetterChecks.js),
      // found while re-verifying the leading-token fix directly above against
      // the SAME measured employer list its own comment names (Float, Loop
      // Financial, Provision, Stripe, Top Hat): a one-word company name fell
      // through to the multi-word branch's fullNamePattern, which is
      // case-INSENSITIVE by design (see fullNameLowercase above — that
      // case-insensitivity is deliberate for a two-word name like "Best
      // Buy"). For a ONE-word name the "full name" and the "leading token"
      // are the identical string, so the case-insensitive treatment let
      // ordinary lowercase prose with no employer reference at all — "my own
      // float of ideas" — satisfy the target half for companyName "Float",
      // exactly the false PASS the leading-token fix exists to close, just on
      // the single-word half of its own measured list instead of the
      // multi-word half.
      const floatLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support my own float of ideas.'],
        'Float',
      );
      assert(!floatLowercase.passed
        && floatLowercase.detail.includes('the sentence is missing its target half'),
      `lowercase "float" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Float" (detail=${floatLowercase.detail})`);

      const provisionLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support the provision of my own services.'],
        'Provision',
      );
      assert(!provisionLowercase.passed
        && provisionLowercase.detail.includes('the sentence is missing its target half'),
      `lowercase "provision" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Provision" (detail=${provisionLowercase.detail})`);

      // Capitalized exactly as the company spells it, the single-word name
      // still satisfies the target half — the shape a letter naming the
      // employer actually writes ("Float's ingestion pipeline").
      const floatCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Float’s ingestion pipeline.'],
        'Float',
      );
      assert(floatCapitalized.passed,
        `the single-word company name capitalized as written must still satisfy the target half (detail=${floatCapitalized.detail})`);

      const provisionCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Provision’s ingestion pipeline.'],
        'Provision',
      );
      assert(provisionCapitalized.passed,
        `the single-word company name capitalized as written must still satisfy the target half (detail=${provisionCapitalized.detail})`);

      return {
        floatLowercase: floatLowercase.detail,
        provisionLowercase: provisionLowercase.detail,
        floatCapitalized: floatCapitalized.detail,
        provisionCapitalized: provisionCapitalized.detail,
      };
    },
  },
  {
    name: 'cover letter harness: certifiedClosingInvitation includes the "look forward to discussing" close so the tense check does not reject what the closing check just certified',
    run: () => {
      // certifiedClosingInvitation (coverLetterChecks.js) used to test only
      // CONDITIONAL_WELCOME_CLOSE, DIRECT_CONVERSATION_CLOSE, and
      // SELF_DIRECTED_CONVERSATION_CLOSE — but checkDirectWelcomeClosing's own
      // selfDirectedMatch already ORs LOOK_FORWARD_CONVERSATION_CLOSE into
      // that identical certifying branch (see the "bareLookForwardClose" and
      // "prospectiveClose" fixtures above). A closing certified via "I look
      // forward to discussing ..." was therefore rejected right back by
      // checkProspectiveContributionTense for the exact present-tense bridge
      // its own certifying branch requires — the two-checks-pulling-opposite-
      // ways bug this whole fix exists to prevent, reproduced by omission.
      const lookForwardParagraphs = [
        'I built and shipped several data pipelines at my last company.',
        'I look forward to discussing how my pipeline experience helps me contribute to your platform team.',
      ];
      const lookForwardClosing = checkDirectWelcomeClosing(lookForwardParagraphs);
      const lookForwardTense = checkProspectiveContributionTense(lookForwardParagraphs);
      assert(lookForwardClosing.passed,
        `fixture sanity: the "look forward to discussing" close with all three contribution halves already present must pass checkDirectWelcomeClosing (detail=${lookForwardClosing.detail})`);
      assert(lookForwardTense.passed,
        `checkProspectiveContributionTense must not reject a "look forward to discussing" closing checkDirectWelcomeClosing has already certified (detail=${lookForwardTense.detail})`);
      // The exemption stays scoped to the final paragraph only: the identical
      // present-tense bridge elsewhere in the letter is exactly the defect
      // this check exists to catch, "look forward to discussing" wording or
      // not.
      const lookForwardNotClosing = checkProspectiveContributionTense([
        'I look forward to discussing how my pipeline experience helps me contribute to your platform team.',
        'Thank you again for your time and consideration.',
      ]);
      assert(!lookForwardNotClosing.passed,
        `the identical present-tense bridge must still be caught when it is not in the final paragraph (detail=${lookForwardNotClosing.detail})`);
      return { lookForwardTense: lookForwardTense.detail };
    },
  },
  {
    name: 'cover letter harness: the tense-check exemption is scoped to the ONE sentence checkDirectWelcomeClosing certifies, by position, not by text equality',
    run: () => {
      // checkDirectWelcomeClosing certifies exactly ONE sentence per letter —
      // finalSubstantiveClosingSentenceIndex's pick in the final paragraph —
      // but the old exemption in checkProspectiveContributionTense tested
      // EVERY sentence of the final paragraph against certifiedClosingInvitation
      // by TEXT. Two identical sentences in the same final paragraph — the
      // first a genuine present-tense readiness-bridge defect, the second the
      // sentence actually certified — used to both pass that text test and
      // both get exempted, masking the first sentence's defect. This fixture
      // keeps the two sentences byte-for-byte identical specifically to prove
      // the fix compares POSITION, not text: only the certified (second)
      // sentence may be exempted, and the earlier, textually identical one
      // must still be caught.
      const duplicateInvitation = 'I welcome the chance to talk about how my pipeline experience helps me contribute to your platform team.';
      const duplicateClosingParagraph = [`${duplicateInvitation} ${duplicateInvitation}`];
      const duplicateClosing = checkDirectWelcomeClosing(duplicateClosingParagraph);
      assert(duplicateClosing.passed,
        `fixture sanity: the certified (second, final substantive) sentence satisfies all three contribution halves and passes on its own (detail=${duplicateClosing.detail})`);
      const duplicateTense = checkProspectiveContributionTense(duplicateClosingParagraph);
      assert(!duplicateTense.passed
        && duplicateTense.detail.includes('paragraph 1')
        && duplicateTense.detail.includes('past/present readiness bridge'),
      `the earlier, textually identical sentence must still be caught for its own readiness-bridge defect even though the LATER, certified sentence shares its exact wording (detail=${duplicateTense.detail})`);
      // Exactly one observation: the certified (second) occurrence must not
      // also be reported, or one genuine defect would be double-counted as
      // two and the writer told to rewrite a sentence that is already fine.
      assert((duplicateTense.detail.match(/past\/present readiness bridge/gu) || []).length === 1,
        `only the uncertified sentence is reported, not both identical occurrences (detail=${duplicateTense.detail})`);
      return { duplicateTense: duplicateTense.detail };
    },
  },
  {
    name: 'cover letter harness: employer/project/artifact names inside the fingerprinted battery are curly-quoted so one branch fingerprints identically across different letters',
    run: () => {
      // checkObservationFingerprint (localAiApplication.js) strips only
      // curly-quoted spans and collapses "paragraph N"/"passage N" before
      // hashing (see checkPriorEmployerOpening's comment in
      // coverLetterChecks.js). Reimplementing just that normalization step —
      // not the sha256 itself, which adds nothing this test needs to prove —
      // is enough to show each check touched by this fix now normalizes
      // identically across two different letters that trip the identical
      // branch for a different employer, project, or artifact name. Before
      // the fix, each pair's stripped detail differed by exactly the bare
      // name — precisely what would have alternated a stuck branch's
      // fingerprint every round of a real rejection streak, defeating the
      // cross-receipt branch comparison checkFingerprints exists for.
      const stripFingerprintInputs = detail => String(detail)
        .replace(/“[^”]*”/gu, '‹quote›')
        .replace(/\b(paragraph|passage)\s+\d+\b/giu, (_match, word) => `${word.toLowerCase()} ‹n›`);
      const pairs = [
        ['checkPriorEmployerOpening',
          checkPriorEmployerOpening(['At Thomson School District, I evaluated third-party products before district-wide adoption.'], ['Thomson School District']),
          checkPriorEmployerOpening(['At Acme, I built the incident workflow.'], ['Acme'])],
        ['checkNamedArtifactIntroduction',
          checkNamedArtifactIntroduction(['AI-Chalkboard addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'], ['AI-Chalkboard']),
          checkNamedArtifactIntroduction(['Marketplace Hub addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'], ['Marketplace Hub'])],
        ['checkOpeningArtifactContext (leading project)',
          checkOpeningArtifactContext(['Marketplace Hub is my personal project, where Gemini or Claude process item photos and draft listings.'], ['Marketplace Hub']),
          checkOpeningArtifactContext(['AI-Chalkboard is my personal project, where Gemini or Claude process item photos and draft listings.'], ['AI-Chalkboard'])],
        ['checkOpeningArtifactContext (leading employer)',
          checkOpeningArtifactContext(['As a Software Engineer at Thomson School District, I built a device workflow that connected external platforms.'], [], ['Thomson School District']),
          checkOpeningArtifactContext(['As a Software Engineer at Acme, I built a device workflow that connected external platforms.'], [], ['Acme'])],
        ['checkOpeningEmployerShorthand',
          checkOpeningEmployerShorthand([
            'At Thomson School District, I migrated internal systems and their operational data to third-party platforms.',
            'The district chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
          ], ['Thomson School District']),
          checkOpeningEmployerShorthand([
            'At Wexford School District, I migrated internal systems and their operational data to third-party platforms.',
            'The district chose those platforms to reduce the ongoing maintenance expense of its in-house systems.',
          ], ['Wexford School District'])],
        ['checkAdjacentEmployerRepetition',
          checkAdjacentEmployerRepetition([
            'In my software engineering role at Thomson School District, I built a web workflow that connected barcode scans to external management platforms.',
            'At Thomson School District, I also built an internal tools hub with a UI and back end designed to support additional tools.',
          ], ['Thomson School District']),
          checkAdjacentEmployerRepetition([
            'In my software engineering role at Acme, I built a web workflow that connected barcode scans to external management platforms.',
            'At Acme, I also built an internal tools hub with a UI and back end designed to support additional tools.',
          ], ['Acme'])],
        ['checkContainerizationTechnologyRoles',
          checkContainerizationTechnologyRoles(['I containerized it with Docker Compose, Nginx, and Gunicorn so it could be deployed on different virtual-machine configurations.']),
          checkContainerizationTechnologyRoles(['I containerized it with Docker Compose, Apache, and Gunicorn so it could be deployed on different virtual-machine configurations.'])],
      ];
      for (const [label, a, b] of pairs) {
        assert(!a.passed && !b.passed,
          `fixture sanity: ${label} must fail the identical branch on both fixtures (a=${JSON.stringify(a)}, b=${JSON.stringify(b)})`);
        assert(a.detail !== b.detail,
          `fixture sanity: ${label}'s two fixtures must differ in raw detail text before normalization (both were ${JSON.stringify(a.detail)})`);
        assert(stripFingerprintInputs(a.detail) === stripFingerprintInputs(b.detail),
          `${label} must fingerprint identically across two different names once curly-quoted spans are stripped (a=${JSON.stringify(a.detail)}, b=${JSON.stringify(b.detail)})`);
      }
      return Object.fromEntries(pairs.map(([label, a]) => [label, a.detail]));
    },
  },
  {
    name: 'cover letter harness: one transfer carrier form in two consecutive paragraphs is reported, and only that',
    run: () => {
      // The shipped letter this check was written for. Paragraph 2 handed its
      // proof over with "That integration experience would support ..." and
      // paragraph 3 with "That judgment would support ...": one carrier form,
      // back to back. checkRepeatedSentenceShape missed it because its
      // five-word frame differs in the fifth slot ("... and" against "... for").
      const ezra = [
        'EZRA is embedding AI across full-stack product experiences while keeping quality, testing, and safety central. My approach combines full-stack application engineering with practical AI-assisted development. As a Software Engineer at Thomson School District, I built an internal tools hub across the UI and backend with deployment and scalability considerations in mind. I would apply that capability to building AI-powered product features across the full stack.',
        'My integration experience centers on migrations, automation, and validation across connected systems. At Thomson School District, I migrated ticketing and repair-tracking systems to third-party platforms and implemented integrations, automation, validation, and data migration workflows. That integration experience would support production Claude API integrations, including tool calling and error handling.',
        "My AI engineering practice spans traditional development and AI-assisted or agentic coding, with hands-on work in MCP, connectors, prompt harnessing, and model delegation. That judgment would support reusable team practices for AI development while maintaining quality and cost awareness. I welcome a conversation about how my AI-assisted development practice could support EZRA's shared AI engineering patterns.",
      ];
      assert(checkRepeatedSentenceShape(ezra).passed,
        'the premise: the sentence-shape check does not see this pair, which is why a second check reads the carrier');
      const reported = checkRepeatedTransferCarrier(ezra);
      assert(!reported.passed && reported.id === 'repeated-transfer-carrier'
        && reported.detail.includes('paragraphs 2 and 3 both carry the same transfer form “that * would <verb>”')
        && reported.detail.includes('paragraph 2 sentence 3, paragraph 3 sentence 2'),
      `the shipped pair is one form once the noun phrase and the verb are slots (detail=${reported.detail})`);
      // It names the operation, the offending form, and the form the OUTER
      // neighbour uses so a rotation cannot land on it; it hands over no verb.
      const quoted = reported.detail.match(/“[^”]*”/g) || [];
      assert(quoted.join(' ') === '“that * would <verb>” “i would <verb>”'
        && reported.detail.includes('and not “i would <verb>” (paragraph 1 uses it)'),
      `the message quotes the offending form and the neighbour's form only (quoted=${JSON.stringify(quoted)})`);
      for (const replacement of ['I can', 'I would', 'instead', 'such as', 'for example', 'e.g.']) {
        assert(!reported.detail.includes(replacement),
          `the message suggests no replacement wording (“${replacement}” in ${reported.detail})`);
      }
      assert(!/\b(?:apply|bring|use|contribute|help|support|enable)\b/iu.test(reported.detail.replace(/\(paragraph[^)]*\)/gu, '')),
        `the message shows the verb slot, not a verb a writer could copy (detail=${reported.detail})`);
      assert(!reported.detail.includes(String.fromCharCode(0x2014)), 'the message carries no em dash');

      // The whole-battery view. The demonstrative check reads only the subject
      // shape, so paragraph 1's "I would apply that capability", an object-position
      // summary of the proof just before it, is not reported; paragraph 3 is.
      const battery = paragraphs => evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs, evidence: {}, jobText: '', researchText: '', companyName: 'EZRA',
      });
      assert(battery(ezra).filter(check => !check.passed).map(check => check.id).join(',')
        === 'repeated-transfer-carrier,dangling-demonstrative',
      'the shipped letter fails both new checks and nothing else');
      assert(checkDanglingDemonstrative([ezra[0]]).passed && !checkDanglingDemonstrative([ezra[2]]).passed,
        'paragraph 1 is not reported by the demonstrative check, and paragraph 3 is');
      // The repair, in one round: one sentence in paragraph 3 that puts its noun
      // where the paragraph uses it and hands its proof over in a form neither neighbour uses.
      const repaired = [
        ezra[0],
        ezra[1],
        ezra[2].replace('That judgment would support reusable team practices', 'I can bring that practice to reusable team practices'),
      ];
      assert(repaired[2] !== ezra[2] && battery(repaired).every(check => check.passed),
        `the minimal repair clears the whole battery (failed=${battery(repaired).filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`).join(' | ')})`);
      assert(battery(repaired).length === 44, 'the repaired letter is graded by every check, not by a shortened battery');
      // Swapping only the verb or only the noun of the shipped sentence is not a rotation.
      const verbOnly = [ezra[0], ezra[1], ezra[2].replace('That judgment would support', 'That practice would help')];
      assert(!checkRepeatedTransferCarrier(verbOnly).passed
        && checkRepeatedTransferCarrier(verbOnly).detail.includes('“that * would <verb>”'),
      'the minimal noun-and-verb swap of the shipped sentence is still one form');

      const pair = (first, second) => [`I kept the reporting service dependable. ${first}`, `I wrote the runbook the rotation followed. ${second}`];
      // Positive: the same form, in every shape a form takes.
      for (const [label, first, second, form] of [
        ['subject shape', 'That reporting experience would support daily delivery.', 'That runbook practice would support weekly delivery.', 'that * would <verb>'],
        ['other determiner', 'This practice would help daily delivery.', 'This approach would help weekly delivery.', 'this * would <verb>'],
        ['only the verb changes (subject shape)', 'That practice would support daily delivery.', 'That practice would help weekly delivery.', 'that * would <verb>'],
        ['only the verb changes (first person)', 'I would apply that practice to daily delivery.', 'I would bring that practice to weekly delivery.', 'i would <verb>'],
        ['the determiner after I would is not part of the form', 'I would apply that experience to daily delivery.', 'I would apply my experience to weekly delivery.', 'i would <verb>'],
        ['first person can', 'I can bring that practice to daily delivery.', 'I can bring that approach to weekly delivery.', 'i can <verb>'],
        ['would before the verb without I', 'You would apply that practice to daily delivery.', 'Colleagues would use that approach for weekly delivery.', 'would <verb> that *'],
        ['a modal outside the cue is not part of the form', 'I will apply that experience to daily delivery.', 'I could bring that practice to weekly delivery.', '<verb> that *'],
      ]) {
        const found = checkRepeatedTransferCarrier(pair(first, second));
        assert(!found.passed && found.detail.includes(`“${form}”`),
          `${label}: two consecutive paragraphs on one carrier form are reported as “${form}” (detail=${found.detail})`);
      }
      // A closing paragraph is read like any other: it is a carrier-shaped phrase in a consecutive paragraph.
      const closing = checkRepeatedTransferCarrier(['I kept the reporting service dependable. I can apply that experience to daily delivery.',
        'I welcome a conversation about how I can bring my experience to your platform.']);
      assert(!closing.passed && closing.detail.includes('“i can <verb>”') && closing.detail.includes('paragraph 2 sentence 1'),
        `the closing is read too (detail=${closing.detail})`);
      // Negative: everything that is not the same form, or not consecutive.
      for (const [label, paragraphs] of [
        ['different forms', pair('I would apply that experience to daily delivery.', 'That practice would support weekly delivery.')],
        ['a different determiner is a different way of handing the capability over', pair('You would apply that practice to daily delivery.', 'You would apply my practice to weekly delivery.')],
        ['a different modal after I is a different form', pair('I would apply that practice to daily delivery.', 'I can apply that practice to weekly delivery.')],
        ['a different shape is a different form', pair('You would apply that practice to daily delivery.', 'That practice would support weekly delivery.')],
        ['one carrier only', ['I kept the reporting service dependable. I would apply that experience to daily delivery.', 'I wrote the runbook the rotation followed.']],
        ['no carrier at all', pair('It ran daily.', 'It ran weekly.')],
        ['a target-only cue is ordinary prose, not a handed-over proof', pair('The rota exists to support the team every day.', 'The runbook exists to support the team every week.')],
        ['a single paragraph', ['I would apply that experience to daily delivery. I would apply that experience to weekly delivery.']],
        ['hostile input', ['', null, undefined, 42, { toString: () => 'x' }]],
      ]) {
        const found = checkRepeatedTransferCarrier(paragraphs);
        assert(found.passed, `${label}: not reported (detail=${found.detail})`);
      }
      const spread = [
        'I kept the reporting service dependable. I would apply that experience to daily delivery.',
        'I wrote the runbook the rotation followed. That practice would support weekly delivery.',
        'I trained the new on-call engineers. I would apply that experience to onboarding.',
      ];
      assert(checkRepeatedTransferCarrier(spread).passed, 'one form spread across paragraphs that do not touch is the parallelism the count allows');
      // Four proof paragraphs on four different forms, then a closing, is a legal letter.
      const fourForms = [
        'I kept the reporting service dependable. This experience would help daily delivery.',
        'I wrote the runbook the rotation followed. I would apply that practice to weekly delivery.',
        'I trained the new on-call engineers. That approach would support onboarding.',
        'I closed the incident review loop. I can apply that work to reviews.',
        'I welcome a conversation about the rota.',
      ];
      assert(checkRepeatedTransferCarrier(fourForms).passed, 'rotating four forms through four paragraphs is what the check asks for');

      // A run of three neighbours costs one rewrite, not two, and the message says so.
      const triad = [
        'I kept the reporting service dependable. That practice would support daily delivery.',
        'I wrote the runbook the rotation followed. That approach would support weekly delivery.',
        'I trained the new on-call engineers. That experience would support onboarding.',
        'I closed the incident review loop. I welcome a conversation.',
      ];
      const triadReport = checkRepeatedTransferCarrier(triad);
      assert(!triadReport.passed && triadReport.detail.includes('paragraphs 1, 2 and 3 all carry the same transfer form')
        && triadReport.detail.includes('at least 1 of them so that no two neighbouring paragraphs share it'),
      `a run of three neighbours is one observation that counts the rewrites (detail=${triadReport.detail})`);

      // Both reports name a pair the sentence-shape check also reports, and say so:
      // a repair that answers only the shape report keeps the carrier, so this
      // check is not suppressed.
      const shapeReported = [
        'I scripted the deployment step at Acme. I would apply that practice to the reliable delivery this role needs.',
        'I wrote the weekly runbook at Acme. I would apply that practice to the reliable delivery this role needs.',
        'The rotation followed the runbook. My colleagues repeated the step without me present.',
      ];
      const shape = checkRepeatedSentenceShape(shapeReported);
      assert(!shape.passed && shape.detail.includes('“i would * that *”'),
        `the premise: the shape check reports this pair (detail=${shape.detail})`);
      const both = checkRepeatedTransferCarrier(shapeReported);
      assert(!both.passed && both.detail.includes('repeated-sentence-shape reports these same sentences')
        && both.detail.includes('one rewrite that changes both the carrier form and the sentence shape answers both reports'),
      `a pair the shape check also reports is reported here and says so (detail=${both.detail})`);
      // The round-two hole this closes: the shape is rotated and the carrier kept.
      const shapeOnlyRepair = [shapeReported[0], shapeReported[1].replace('I would apply that practice to', 'At Acme I would apply that practice to'), shapeReported[2]];
      assert(!checkRepeatedTransferCarrier(shapeOnlyRepair).passed,
        'a shape-only repair that keeps the carrier is still one form, and is reported');
      const shapeReportedVerbSwap = [shapeReported[0], shapeReported[1].replace('I would apply that practice', 'I would bring that practice'), shapeReported[2]];
      assert(!checkRepeatedSentenceShape(shapeReportedVerbSwap).passed && !checkRepeatedTransferCarrier(shapeReportedVerbSwap).passed,
        'a verb swap in a pair the shape check reports is one form too');
      assert(!checkRepeatedTransferCarrier(shapeReported.slice(0, 2)).passed
        && !checkRepeatedTransferCarrier(shapeReported.slice(0, 2)).detail.includes('repeated-sentence-shape reports'),
      'below the shape check\'s paragraph floor the pair is reported without that note');

      // Rotating onto the form of the paragraph beyond the pair moves the defect one paragraph over.
      const beyond = checkRepeatedTransferCarrier([
        'I kept the reporting service dependable. I would apply that experience to daily delivery.',
        'I wrote the runbook the rotation followed. I can apply that practice to weekly delivery.',
        'I trained the new on-call engineers. I can bring that approach to onboarding.',
        'I closed the incident review loop. That work would support reviews.',
      ]);
      assert(!beyond.passed && beyond.detail.includes('paragraphs 2 and 3 both carry the same transfer form “i can <verb>”')
        && beyond.detail.includes('and not “i would <verb>” (paragraph 1 uses it) or “that * would <verb>” (paragraph 4 uses it)'),
      `the message names each outer neighbour's form (detail=${beyond.detail})`);

      // The rule the contract prints says exactly what the code does, and quotes no word to reuse.
      for (const clause of [
        'every carrier-shaped phrase is read in any two consecutive paragraphs, the opening and the closing included',
        'two paragraphs standing next to each other may not both carry the same form',
        'changing only the verb or only the noun keeps the same form',
        'after I, only would or can is part of the form',
        '“I would apply that X” and “I would bring my Y” are one form',
        '“that X would support” and “that Y would help” are one form',
        '“will apply that X” and “could apply that Y” are one form',
        'not compliance with the rule that mandates a carrier',
      ]) {
        assert(REPEATED_TRANSFER_CARRIER_RULE.includes(clause), `the printed rule states “${clause}” (rule=${REPEATED_TRANSFER_CARRIER_RULE})`);
      }
      return { reported: reported.detail.length };
    },
  },
  {
    name: 'cover letter harness: a demonstrative transfer carrier must find its capability noun earlier in its paragraph, and nothing else is judged',
    run: () => {
      const paragraph3 = "My AI engineering practice spans traditional development and AI-assisted or agentic coding, with hands-on work in MCP, connectors, prompt harnessing, and model delegation. That judgment would support reusable team practices for AI development while maintaining quality and cost awareness. I welcome a conversation about how my AI-assisted development practice could support EZRA's shared AI engineering patterns.";
      const reported = checkDanglingDemonstrative(['I built the tools hub.', paragraph3]);
      assert(!reported.passed && reported.id === 'dangling-demonstrative'
        && reported.detail.includes('paragraph 2 sentence 2 carries “That judgment would support”')
        && reported.detail.includes('no earlier sentence of paragraph 2 mentions “judgment”'),
      `the shipped sentence has no referent: its paragraph is about a practice (detail=${reported.detail})`);
      // The message names the operation, and the two repairs it offers are the two
      // that keep the other rules satisfied: never a noun outside the cue, and
      // never "name the thing in full", which repeats a phrase.
      assert(reported.detail.includes('put a word an earlier sentence of this paragraph uses for that capability directly before the noun, or use one of the back-references the relevance rule permits'),
        'the message names the operation');
      assert(!reported.detail.includes('in full') && !reported.detail.includes('replace that noun'),
        'the message never asks for a replacement noun or for the thing to be named in full');
      const quoted = reported.detail.match(/“[^”]*”/g) || [];
      assert(quoted.join(' ') === '“That judgment would support” “judgment”', `the message quotes the carrier and the noun (quoted=${JSON.stringify(quoted)})`);
      // The repairs it offers clear it, and keep the carrier a carrier.
      const mapped = text => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My AI engineering practice spans traditional development and AI-assisted or agentic coding',
          proof: 'I built prompt harnesses that routed each task to the right model',
          relevance: text,
          jobNeedQuote: 'reusable team practices for AI development',
        } }] },
        paragraphs: [`My AI engineering practice spans traditional development and AI-assisted or agentic coding. I built prompt harnesses that routed each task to the right model. ${text}`],
        jobText: 'The role builds reusable team practices for AI development across the engineering group.',
      });
      for (const [label, replacement] of [
        ['a word the paragraph uses before the noun', 'That AI engineering judgment would support reusable team practices for AI development.'],
        ['the paragraph\'s own noun', 'That practice would support reusable team practices for AI development.'],
        ['a permitted back-reference', 'That experience would support reusable team practices for AI development.'],
      ]) {
        assert(checkDanglingDemonstrative([`My AI engineering practice spans traditional development and AI-assisted or agentic coding. I built prompt harnesses that routed each task to the right model. ${replacement}`]).passed,
          `${label} clears the check`);
        assert(mapped(replacement).passed, `${label} stays a legal relevance span (detail=${mapped(replacement).detail})`);
      }
      assert(checkRepeatedPhrase([`My AI engineering practice spans traditional development and AI-assisted or agentic coding. I built prompt harnesses that routed each task to the right model. That AI engineering judgment would support reusable team practices for AI development.`]).passed,
        'the word borrowed from the paragraph does not trip the repeated-phrase check');

      const body = 'I migrated the ticketing systems to third-party platforms at Acme.';
      const read = sentence => checkDanglingDemonstrative([`${body} ${sentence}`]);
      // Positives: a carrier whose capability noun, and whose modifiers, no earlier sentence used.
      for (const [label, sentence, noun] of [
        ['subject shape, abstract quality', 'That judgment would support reusable practices.', 'judgment'],
        ['subject shape, another noun', 'That capability would enable faster releases.', 'capability'],
        ['plural noun', 'Those capabilities would help a small team.', 'capabilities'],
        ['an approach', 'This approach would help a small team.', 'approach'],
        ['modifiers that are not earlier either', 'That agentic coding practice would support reusable standards.', 'practice'],
      ]) {
        const found = read(sentence);
        assert(!found.passed && found.detail.includes(`“${noun}”`), `${label}: reported (detail=${found.detail})`);
      }
      // A function word before the noun is not a word the paragraph "used".
      assert(!checkDanglingDemonstrative(['I did very careful work on the cutover. That very approach would help a small team.']).passed,
        'a function word between the determiner and the noun does not excuse the carrier');
      // The object shape is not read: it sits right after the proof it transfers, so its
      // noun summarizes that action (the shipped EZRA paragraph 1 measured this way).
      for (const sentence of ['I would apply that capability to faster releases.', 'I can bring this approach to faster releases.',
        'To apply that judgment to reviews, I would start small.', 'I would use that practice for weekly delivery.']) {
        assert(read(sentence).passed, `an object-position carrier is out of scope: ${sentence}`);
      }
      // Negatives: the noun, a stem of it, or a modifier appears earlier.
      for (const [label, sentences] of [
        ['the noun appears earlier', 'My migration practice starts from the records. That practice would support reusable standards.'],
        ['the plural of the noun appears earlier', 'I documented the capabilities of each platform. That capability would help a small team.'],
        ['the singular of the noun appears earlier', 'I documented each platform capability. Those capabilities would help a small team.'],
        ['a modifier appears earlier', 'I ran the district cutover myself. That district cutover practice would support reusable standards.'],
        ['a stemmed modifier appears earlier', 'I ran the migrations myself. That migration practice would support reusable standards.'],
        ['a hyphenated modifier part appears earlier', 'I built a scan workflow for staff. That scan-triggered practice would support reusable standards.'],
        ['the noun appears in the carrier\'s own object shape', 'My delivery approach kept releases small. I would bring that approach to your releases.'],
      ]) {
        const found = checkDanglingDemonstrative([sentences]);
        assert(found.passed, `${label}: not reported (detail=${found.detail})`);
      }
      // The three back-references the relevance rule permits need no earlier mention, in any determiner.
      for (const sentence of [
        'That experience would support production integrations.', 'This experience would support production integrations.',
        'That work would support production integrations.', 'This work would support production integrations.',
        'Those patterns would support production integrations.', 'These patterns would support production integrations.',
        'That integration experience would support production work.', 'That district-wide rollout work would support production work.',
        'I would apply that experience to production integrations.', 'I would apply this work to production integrations.',
      ]) {
        assert(read(sentence).passed, `a permitted back-reference is never read: ${sentence}`);
      }
      // Nothing that is not a demonstrative transfer carrier is judged, whatever noun it opens on.
      for (const [first, second] of [
        ['I rebuilt the public API.', 'That rebuild let partners integrate in days.'],
        ['I cached the pricing lookups.', 'This cut p95 latency from 900 to 120 milliseconds.'],
        ['I added retries, idempotency keys, and dead-letter queues to the payment consumer.', 'These safeguards cut failed charges by 80 percent.'],
        ['I kept the checkout service reliable during peak season.', 'That reliability mattered because peak weeks carried half the revenue.'],
        ['I wrote the ETL jobs that feed the warehouse.', 'This new pipeline replaced three spreadsheets.'],
        ['I migrated the repair records into a new platform.', 'That difficulty lay mostly in reconciling the duplicate records between platforms.'],
        ['I migrated the repair records into a new platform.', 'That judgment guided how I sequenced the cutover.'],
        ['I ran the migration.', 'That means I can move between UI and backend work.'],
        ['I ran the migration.', 'That said, I kept the rollout small.'],
        ['I ran the migration.', 'This role needs steady delivery.'],
        ['I ran the migration.', 'That would help a small team.'],
      ]) {
        const found = checkDanglingDemonstrative([`${first} ${second}`]);
        assert(found.passed, `an ordinary demonstrative sentence is out of scope: ${second} (detail=${found.detail})`);
      }
      // The first sentence of a paragraph has nothing earlier to find its noun in; the boundary belongs to checkOpeningDemonstrative.
      assert(checkDanglingDemonstrative(['That judgment would support reusable practices.', 'I would apply that capability to releases.']).passed,
        'a paragraph\'s first sentence is not read');
      assert(checkDanglingDemonstrative(['', null, undefined, 42, { toString: () => 'x' }]).passed, 'hostile input yields a result');
      const many = checkDanglingDemonstrative([1, 2, 3].map(() => `${body} That judgment would help. That capability would help.`));
      assert(!many.passed && many.detail.includes('additional observation(s) omitted'), 'the report is capped like its siblings');

      // The scope the rule prints is read from the arrays the regexes are built from.
      for (const clause of ['capability', 'practice', 'approach', 'judgment', 'experience', 'work', 'pattern',
        'must find that noun, or a word standing before it in the carrier, or a form of one of them, in an earlier sentence of the same paragraph',
        'put a word an earlier sentence of the paragraph uses for that capability directly before the noun',
        'no object-position carrier such as apply that X, and no other sentence that opens with a demonstrative, is read here']) {
        assert(DANGLING_DEMONSTRATIVE_RULE.includes(clause), `the printed rule states “${clause}” (rule=${DANGLING_DEMONSTRATIVE_RULE})`);
      }
      assert(!DANGLING_DEMONSTRATIVE_RULE.includes('in full'), 'the printed rule does not ask for the thing to be named in full');

      // The paragraph-boundary check had the same verb-as-head leniency: a modal
      // in the previous paragraph satisfied "That judgment would".
      const boundary = checkOpeningDemonstrative([
        'I would rewrite the runbook before I would ship the cutover.',
        'That judgment would support reusable practices.',
      ]);
      assert(!boundary.passed && boundary.detail.includes('“judgment”') && !boundary.detail.includes('“would”'),
        `a modal in the previous paragraph is not a referent at the boundary either (detail=${boundary.detail})`);
      assert(checkOpeningDemonstrative(['I ran the migration.', 'That would support reusable practices.']).passed,
        'a demonstrative followed by a modal is a pronoun and has no noun to hunt for');
      assert(checkOpeningDemonstrative(['I ran the migration.', "That couldn't wait for the quarter."]).passed,
        'a contracted auxiliary is not a noun either');
      return { reported: reported.detail.length };
    },
  },
  {
    name: 'cover letter harness: both new checks are appended after the established battery and reported as prose checks',
    run: () => {
      const checks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['I built it.', 'It ran.'], evidence: {}, jobText: '', researchText: '' });
      assert(checks.slice(-2).map(check => check.id).join(',') === 'repeated-transfer-carrier,dangling-demonstrative',
        'the two checks are the last two the battery returns, so the established order is unmoved');
      assert(checks.slice(-2).every(check => check.passed && typeof check.detail === 'string' && check.detail.length > 0),
        'each returns the result(id, passed, detail) contract with a detail on a pass');
      return { ids: checks.slice(-2).map(check => check.id) };
    },
  },
];
