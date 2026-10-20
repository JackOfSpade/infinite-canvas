import {
  assert,
  assertCandidateDashPunctuation,
  enDashIsRange,
  authorCoverLetterEnvelope,
  formatCoverLetterDate,
  BANNED_GENERIC_PHRASES,
  BANNED_GENERIC_PATTERNS,
  buildResumeDocument,
  buildCoverLetterDocument,
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
  checkMigrationObjectClarity,
  checkNamedArtifactIntroduction,
  checkOpeningArtifactContext,
  checkNeedGrounding,
  checkNeedsPortfolio,
  checkOpeningDemonstrative,
  checkAdjacentEmployerRepetition,
  checkOpeningEmployerShorthand,
  checkOpeningPostingRestatement,
  checkOpeningJobSummaryScaffolding,
  checkEntailedPremise,
  checkParallelStructure,
  checkParagraphArgumentLinks,
  ARGUMENT_MAPPING_REQUIRED_RULE,
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
  checkTargetCompanyBinding,
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
  ARGUMENT_RELEVANCE_SPAN_RULE, checkDanglingDemonstrative, checkRepeatedTransferCarrier, COVER_LETTER_SALIENT_ECHO_PHRASES,
  DANGLING_DEMONSTRATIVE_RULE, MIN_REPEAT_CONTENT_WORDS, REPEATED_PHRASE_RULE, REPEATED_TRANSFER_CARRIER_RULE,
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
    contact: ['Lakeview, ON', 'maya@example.test'],
  },
  bulletTexts: [
    'Triaged incomplete emergency reports under time pressure for a municipal operations team.',
    'Reduced response backlog by 32% while coordinating field crews across six regions.',
  ],
  roles: [{
    summary: 'Municipal operations leadership.',
    bullets: [{ text: 'Reduced response backlog by 32% while coordinating field crews across six regions.' }],
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
  'My role at Brackenfield Freight Company was to keep the dispatch board dependable.',
  'In that role I wrote the load-planning scripts myself.',
  'The role I held at Orrin Quay Surveying Partners covered both site visits and reporting.',
  'I would bring this to the role.',
  'The role I am applying for sits in your platform team.',
  'Each role taught me something about release discipline.',
  'My last role required me to run the on-call rotation.',
  'The position paper we published shaped the fleet data policy.',
  'I moved into a backend role after two release cycles.',
  'That role gave me the first taste of incident response.',
  'My understanding of the role is that it joins interface work with services.',
  'One requirement of the position is comfort with SQL.',
  'Everything I read about the role is consistent with the work I have done.',
  'The budget for the role is not something I would need to manage.',
  'Two of my previous roles required that kind of coordination.',
  'The role description parser I maintained is unrelated to this application.',
  'I stepped into the role of release coordinator during that cutover.',
  'The position offered to me then was mostly maintenance.',
  'My role involved both interface work and data cleanup.',
  'The role at my current employer centers on reporting.',
  'I learned the most from the role that followed.',
  'This position sits between the field crews and the dispatch office.',
  'This role requires steady prioritization when reports arrive incomplete.',
  'Your listing quality team ships the ranking model.',
  'The listing page I rebuilt cut abandoned carts.',
  'I rewrote the job description parser your team maintains.',
  'The position description identifies incident response as a core responsibility.',
  'The job posting describes the service team as responsible for release coordination.',
  'This job listing describes a rebuild that starts from years of existing workflows.',
  'Nothing in the role is unfamiliar to me.',
  'The work I did maps to the position without much translation.',
  'I have held the role of on-call engineer for a freight company.',
  'The responsibilities of the role are familiar from my time at Brackenfield.',
  'A senior role is not what I am asking for.',
  'My role notes from that cutover still guide how I document releases.',
  'The role of automated tests in that rebuild was to catch regressions early.',
  'Their position on data retention shaped how I built the exports.',
  'The position I left in 2021 was a support role.',
  'I would grow into the position over the first quarter.',
  'The hiring team knows the position better than I do.',
  'Reporting to the position manager would be new for me.',
  "Much of the position's day-to-day work resembles what I did at Brackenfield.",
  "I asked about the position's on-call expectations during the screen.",
  'The team behind the position is the one I would join.',
  'Nothing about the position needs explaining to someone who has done it.',
  'My position at Orrin Quay Surveying Partners was junior.',
  'I declined the position offer that arrived that spring.',
  'I appreciate the role focus on data quality that the work itself shows.',
  'The other role I considered involves far less backend work.',
  'The previous role centers on hardware, which is not where my work sits.',
  'Our automated posting pipeline published nightly reports for the depot.',
  'A posting service I wrote kept the notice board current.',
  'The internal dispatch board I built for the depot is still in use.',
  'I read the description twice before writing this letter.',
  'I would adapt to whatever this role needs on day one.',
  "This role's emphasis on data quality matches what I practised.",
  'The support team role I filled covered both site visits and reporting.',
  'The team I joined at Brackenfield is the one whose role definitions I rewrote.',
  'Their posting process runs nightly against the depot calendar.',
  'I built the alerting that the on-call role depends on.',
  'Nothing in this letter restates the role description.',
  'The position title on my last offer letter read Support Engineer.',
  'The role of the dispatch office is to coordinate between depots.',
  'The job I left was not a fit for the work I want to do.',
  'Every position I have held involved on-call work.',
  'The position, as I understand it, is mostly backend.',
  'The Associate Platform Developer role I am applying for is the one I want.',
  'I would be the first person in the role.',
  'The role Brackenfield Freight Company gave me is the closest match I have.',
  'The recent job posting describes the service team as responsible for release coordination.',
  'This job description states that engineers rotate through incident response.',
  'The position requirements I read match the work I did at Orrin Quay Surveying Partners.',
  'The role-based access control I added restricted the dispatch queue by staff role.',
  'My first position out of school was mostly data entry.',
  'The second role I held there is the one that taught me SQL.',
  'The work sits closer to the role than my title suggests.',
  'I have never left a position without documenting the handover.',
];

// A generated letter that cleared the whole battery: no check in
// coverLetterChecks.js compared a paragraph to itself or to another paragraph.
// checkRedundancy and checkSalientPhraseEcho measure the letter against the
// RESUME, checkRepeatedSentenceShape erased every content word before it
// compared, and every other n-gram site takes its needle from the resume, the
// plan or a fixed list. So the same six words appeared twice in paragraph 1 and
// nothing said anything. Three tests read it, from three sides: the runs it
// repeats, the shapes its consecutive paragraphs share, and the one place those
// two checks answer differently about the same sentences.
const LETTER_THAT_RESTATES_ITSELF = [
  "Wexcombe Structural pairs each field survey with the load calculations and ratings behind it, as well as the crew notes. My bridge inspection experience includes sway checks across the deck and abutments. As a Field Engineer at Harlow Civic Works, I developed a survey workbook for footbridge crews, and it carried load checks across the deck and abutments. The design challenge was planning for heavier traffic as future repairs changed the structure. I would apply that checking approach across deck and abutments to the planning of field surveys and the design checks behind them, as well as the sign-off forms.",
  "In that role, my survey experience includes linked instruments, strain gauge logs, and reading-triggered alerts. I assembled a gauge-logging kit that paired a handheld reader with strain gauge logs for the footbridge crews. The design challenge was keeping alerts in order when two readings arrived together. I would apply that linked-instrument experience to planning inspection routines, so each alert reaches the right crew.",
  'Reporting cycles add another layer to field engineering. In that Field Engineer role, my rating experience spans bearing seats, expansion joints, scour records, photographs, and report tables. I built a shared condition register from paper inspection sheets and their maintenance history. Most of the effort went into sequencing dependent stages around review and sign-off. I can apply that register approach to sampling, reporting, and ongoing asset care.',
  "I welcome a conversation about how my inspection practice could support the site visits your team plans, runs, and documents.",
];

// The letter paragraph every pipeline fixture in this repo writes, and the one
// the targeted exclusion has to stay silent on. Its transfer sentence is a
// stock frame, and a stock frame re-names the capability its claim sentence
// named (a bare back-reference stands in for it in six fixed phrases only) and
// names the responsibility it reaches, in the job need's own words. Both
// re-namings are dictated by the frame and both land inside one paragraph:
// comparing the whole sentence reported this paragraph at 38 of the 39 test sites
// in this repo that assert a well-formed letter is accepted.
const LETTER_WITH_MANDATED_RE_NAMINGS = 'My experience delivering supported systems is a relevant capability.'
  + ' In my engineering role at Acme, I updated supported systems for internal users.'
  + ' I would apply my experience delivering supported systems to reliable system delivery this role requires.';

// A paragraph in the style of the design system's fixture letter. It names one
// artifact twice in one paragraph, in lowercase and in full, and says something
// different about it each time — which is why the old message, "the same
// statement made twice", was untrue of it, and why the run is still a defect.
const DESIGN_SYSTEM_ARTIFACT_PARAGRAPH = 'Nearly everything I wrote at Brackenfield Freight Company ended up running'
  + ' beside a vendor platform, and that is the condition this role sets for each carrier feature layered'
  + " on a shared core. The depot's pallet intake and release system was my first build there, written from scratch for the forklift"
  + ' fleet and the handhelds drivers carry. Our in-house tools shared one dispatch board, which I wrote end to end as a Vue front end'
  + ' over a Flask service and packaged in containers for whichever server a depot had free. When'
  + ' invoicing, pallet intake and release, and claims tracking moved onto vendor solutions, the transfer fell to me,'
  + ' along with the nightly load scripts that keep the depot ledger and those platforms in step'
  + ' both ways.';

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
  'The intake queue was one of the places a record could go missing. The nightly export was one of the others, and there was no audit trail behind it. In order to see where, I timed each step of the write path. There was no owner for the older records, so in order to reassign them I built a small review screen. Every reversal was a change that had to be logged, as well as the reason behind it. A refund was an entry that had to be approved, as well as the note a clerk left on it. I worked on the weighbridge path first. Then I worked on the ledger, which nobody had touched in a year.',
  'Reporting was the second half of the job. I was able to move the aggregation into a nightly job once the timings were in hand. At the same time the clerks wanted a weekly view, so the work had to fit around their Monday deadline. Coordination was one of the things nobody had budgeted for.',
  'The cutover was the last piece. I was able to take the older records across without a freeze. At the same time two teams were editing the same records, so the work had to be reversible at every step. Sequencing was one of the things that decided the order.',
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
    name: 'cover letter harness: prospective company binding catches copied targets while preserving past employer evidence and AI prose',
    run: () => {
      const target = 'Northstar Labs, Inc.';
      const copied = checkTargetCompanyBinding(['I would bring my delivery practice to Other Company\'s platform team.'], target, ['Acme']);
      const targetAlias = checkTargetCompanyBinding(['I would bring my delivery practice to Northstar Labs\' platform team.'], target, ['Acme']);
      const priorEvidence = checkTargetCompanyBinding(['At Acme, I rebuilt the release flow and would bring that practice to this role.'], target, ['Acme']);
      const genericAcronym = checkTargetCompanyBinding(['I would bring AI platform experience to this role.'], target, ['Acme']);
      assert(!copied.passed && targetAlias.passed && priorEvidence.passed && genericAcronym.passed,
        `only a mismatched prospective employer is rejected (${JSON.stringify({ copied, targetAlias, priorEvidence, genericAcronym })})`);
      return { copiedTargetRejected: true, targetAliasAllowed: true, priorEvidenceAllowed: true };
    },
  },
  {
    name: 'target-company-binding: three domains keep past tools under this role and reject flipped future targets',
    run: () => {
      for (const [target, prior, tool] of [
        ['Northstar Labs', 'Acme', 'Python APIs'],
        ['Harbor Clinic', 'City Hospital', 'Epic Workflows'],
        ['River Library', 'County Archive', 'MARC Records'],
      ]) {
        const bound = `For this role, I would bring my experience with ${tool} to your team.`;
        const namedTarget = `I would bring my experience with ${tool} to ${target}'s team.`;
        const flipped = `I would bring my experience for ${tool} to this role.`;
        const priorTarget = `I would bring that experience to the team at ${prior}.`;
        assert(checkTargetCompanyBinding([bound], target, [prior]).passed === true, bound);
        assert(checkTargetCompanyBinding([namedTarget], target, [prior]).passed === true, namedTarget);
        assert(checkTargetCompanyBinding([flipped], target, [prior]).passed === false, flipped);
        assert(checkTargetCompanyBinding([priorTarget], target, [prior]).passed === false, priorTarget);
      }
    },
  },
  {
    name: 'dash range grammar: shared predicate accepts supported endpoints and rejects prose lookalikes',
    run: () => {
      const corpus = [
        ['March, 2019 – August, 2022', true],
        ['March,2019 – Aug.,2022', true],
        ['Sep. 2019 – Feb. 2020', true],
        ['03/2019 – 06/2022', true],
        ['3 – 5', true],
        ['March 2019 – Current', true],
        ['March 2019 – Ongoing', true],
        ['March 2019 – (Present)', true],
        ['Spring 2020 – Fall 2021', false],
        ['The project grew in March, 2019 – and then shipped.', false],
        ['The service migrated from Sep. 2019 – after testing.', false],
      ];
      for (const [copy, expected] of corpus) {
        assert(enDashIsRange(copy, copy.indexOf('–')) === expected,
          `shared dash-range grammar returned the wrong result for ${JSON.stringify(copy)}`);
      }
      return { cases: corpus.length };
    },
  },
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
      const markup = '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example Co</span><ul class="highlights"><li>Caching reduced latency by <span data-achievement-id="span-id">74%</span>, while <em data-achievement-id=\'em-id\'>10 hours</em> of support work remained; <strong data-achievement-id="strong-id">30%</strong> was retained and <span data-achievement-id="span-id">74%</span> was not duplicated.</li></ul></article></main>';
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
      const realMain = '<main class="page"><header><h1 class="name">Real Candidate</h1><p class="tagline">Real Role</p><p class="contact">Lakeview, ON<span class="sep">·</span>real@example.test</p></header><article class="role"><span class="title">Operator</span><span class="company">Real Co</span><ul class="highlights"><li>Handled real incidents under documented constraints.</li></ul></article></main>';
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
      const fail = checkRedundancy(['I reduced response backlog by 32% while coordinating field crews across six regions.'], evidence);
      assert(!fail.passed, 'an eight-word copied résumé run must fail');
      assert(fail.detail.includes('paragraph 1') && fail.detail.includes('résumé bullet 2')
        && fail.detail.includes('12-word run') && fail.detail.includes('“reduced response backlog by 32 while coordinating field crews across six regions”'),
      'a redundancy observation must name the paragraph, bullet, run length, and exact shared phrase for the one revision attempt');
      return { pass: pass.detail, fail: fail.detail };
    },
  },
  {
    name: 'cover letter harness: résumé echo is graded by the measured run floor and by wording the current résumé repeats, never by a fixed phrase',
    run: () => {
      // The former short-phrase table named one candidate's three-word phrase.
      // Restating the résumé is graded by the measured run floor, in any domain.
      const sources = [
        { bulletTexts: ['Scheduled overnight pharmacy deliveries across three satellite clinics without missed handoffs.'] },
        { bulletTexts: ['Redesigned the quarterly grant reporting workbook used by every regional program officer.'] },
        { bulletTexts: ['Rebuilt the dispatch routing service so field crews received the nearest open ticket first.'] },
      ];
      const copied = [
        ['I scheduled overnight pharmacy deliveries across three satellite clinics without missed handoffs.'],
        ['I redesigned the quarterly grant reporting workbook used by every regional program officer.'],
        ['I rebuilt the dispatch routing service so field crews received the nearest open ticket first.'],
      ];
      const restated = [
        ['I scheduled overnight pharmacy deliveries across three satellite sites.'],
        ['I redesigned the quarterly grant reporting workbook for program officers.'],
        ['I rebuilt the dispatch routing service so field work moved faster.'],
      ];
      sources.forEach((source, index) => {
        const verbatim = checkRedundancy(copied[index], source);
        const faithful = checkRedundancy(restated[index], source);
        const salient = checkSalientPhraseEcho(restated[index], source);
        assert(!verbatim.passed && verbatim.detail.includes('-word run'),
          `a run at the floor is rejected whatever the domain (source ${index + 1}): ${verbatim.detail}`);
        assert(faithful.passed && salient.passed,
          `a fact restated below the floor by a letter that repeats none of the résumé's refrains is accepted (source ${index + 1}): ${faithful.detail}; ${salient.detail}`);
      });

      // Below the floor the evidence decides: wording that TWO OR MORE current résumé
      // bullets already share is that résumé's refrain, and the letter picking it up
      // again is an echo. Three unrelated domains, so no phrase of any one
      // candidate's file is what makes the rule fire.
      const refrainCases = [
        {
          label: 'build style',
          bullets: ['Booking portal rebuilt from the ground up for the whole network.', 'Volunteer rota tool, rebuilt from the ground up in a month.', 'Maintained the nightly export job.'],
          echo: 'The intake form was rebuilt from the ground up for the front desk.',
          fresh: 'I replaced the intake form entirely, starting over on a blank page for the front desk.',
          phrase: 'rebuilt from the ground up',
        },
        {
          label: 'delivery style',
          bullets: ['Delivered the clinic rollout on time and under budget.', 'Delivered the grant portal on time and under budget.', 'Trained eleven site coordinators.'],
          echo: 'We shipped the new scheduler on time and under budget.',
          fresh: 'The new scheduler shipped by the promised date and cost less than planned.',
          phrase: 'time and under budget',
        },
        {
          label: 'cadence style',
          bullets: ['Led weekly check-ins with regional program officers.', 'Ran weekly check-ins with regional site leads.', 'Reconciled the monthly invoices.'],
          echo: 'I ran weekly check-ins with regional partners.',
          fresh: 'I met each partner every week to review open items.',
          phrase: 'weekly check ins with regional',
        },
      ];
      for (const kase of refrainCases) {
        const echoed = checkSalientPhraseEcho([kase.echo], { bulletTexts: kase.bullets });
        const reworded = checkSalientPhraseEcho([kase.fresh], { bulletTexts: kase.bullets });
        const singleBullet = checkSalientPhraseEcho([kase.echo], { bulletTexts: [kase.bullets[0], kase.bullets[2]] });
        assert(!echoed.passed && echoed.id === 'salient-phrase-echo' && echoed.detail.includes(`“${kase.phrase}”`)
          && echoed.detail.includes('already share'),
        `${kase.label}: wording two résumé bullets share is an echo when the letter repeats it (${echoed.detail})`);
        assert(reworded.passed, `${kase.label}: the same fact in the letter's own words is accepted (${reworded.detail})`);
        assert(singleBullet.passed,
          `${kase.label}: wording only one bullet uses is that bullet's fact, not the résumé's refrain, so it is not gated here (${singleBullet.detail})`);
      }
      // Excused: a refrain made only of names, or only of the posting's own words.
      const nameRefrain = checkSalientPhraseEcho(['I run Alpha Console for Beta Ledger.'], {
        bulletTexts: ['Ran Alpha Console for Beta Ledger.', 'Supported Alpha Console for Beta Ledger.'],
      });
      const postingRefrain = checkSalientPhraseEcho(['We shipped the new scheduler on time and under budget.'], {
        bulletTexts: refrainCases[1].bullets,
      }, 'Candidates deliver programs on time and under budget for a regional network.');
      assert(nameRefrain.passed && postingRefrain.passed,
        `a refrain of names, or of the posting's own words, is excused (${nameRefrain.detail}; ${postingRefrain.detail})`);
      // The contract describes what is read; it names no phrase from any document.
      assert(!/[“”"]/u.test(COVER_LETTER_SALIENT_ECHO_PHRASES) && !/scratch/iu.test(COVER_LETTER_SALIENT_ECHO_PHRASES),
        `the contract wording lists no phrase: ${COVER_LETTER_SALIENT_ECHO_PHRASES}`);
      return { floor: checkRedundancy(copied[0], sources[0]).detail, refrain: checkSalientPhraseEcho([refrainCases[0].echo], { bulletTexts: refrainCases[0].bullets }).detail };
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
      const clicheOpener = checkGenericPhrases(['The role needs more than basic presence; it demands a professional with a proven three-year track record.']);
      const clicheMapping = checkGenericPhrases(['Verifying identification was not merely administrative; it was the primary line of defense and gave me this exact foundation.']);
      assert(!clicheOpener.passed && clicheOpener.detail.includes('proven … track record'),
        'a short modifier such as “three-year” must not let the proven-track-record cliché pass');
      assert(!clicheMapping.passed && clicheMapping.detail.includes('primary line of defense'),
        'narrow, high-frequency rhetorical clichés must request revision');
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
        'The rollout surfaced limitations in the vendor tooling as well as strengths in our own.',
        'I documented the benefits of the rollout as well as its limitations.',
      ].map(paragraph => checkGenericPhrases([paragraph]));
      assert(!hollowDoublet.passed && hollowDoublet.detail.includes('downsides and trade-offs')
        && namedJudgement.every(check => check.passed),
      'only the fixed hollow doublet is banned: this id is a hard gate on the Local AI path, so a sentence naming a specific judgment must never reject a completed run');
      return { pass: pass.detail, fail: fail.detail, typographic: typographic.detail, applicationAnnouncements: applicationAnnouncements.map(check => check.detail), spacedHyphen: spacedHyphen.detail, clicheOpener: clicheOpener.detail, clicheMapping: clicheMapping.detail, allObservations: allObservations.detail, precise: precise.detail };
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
    name: 'cover letter harness: generic duration-cliché rhetoric cannot receive a clean prose score',
    run: () => {
      const paragraphs = [
        'Protecting patients, staff, and assets requires a Security Officer I who brings more than basic presence; it demands a professional with a proven three-year track record of rigorous access control, perimeter protection, and vigilant surveillance in high-traffic environments. Jordan Ellis offers this exact foundation, prepared to deliver continuous, round-the-clock vigilance across full-time, evening, overnight, and weekend shifts.',
        'At Lakeshore Corporate Center, verifying employee and visitor identification at all entry points was not merely administrative; it was the primary line of defense. This continuous practice builds the sharp, repetitive judgment required to enforce strict safety policies.',
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
      'the duration-cliché regression must trigger both modifier-resistant generic and spelled-duration grounding checks');
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
      const spelledDuration = checkFigureDiscipline(['A proven three-year track record supports careful access decisions.'], { bulletTexts: ['Managed access control from March 2019 to the present.'] });
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
        'We kept the scheduling core in house and gave one team end to end ownership of the company wide rollout, its third party vendors, and its real time dashboards.',
        'The yard ran a check in and check out process for rental trailers, and we published the open source tools behind it.',
      ]);
      assert(!fail.passed && fail.id === 'compound-hyphenation'
        && fail.detail.includes('paragraph 1 writes “in house”; write “in-house” (hyphenate the compound modifier)')
        && fail.detail.includes('write “end-to-end ownership”')
        && fail.detail.includes('write “company-wide”')
        && fail.detail.includes('write “third-party vendors”')
        && fail.detail.includes('write “real-time dashboards”')
        && fail.detail.includes('paragraph 2 writes “check in and check out process”; write “check-in / check-out process”')
        && fail.detail.includes('write “open-source tools”'),
      'every covered compound must name its paragraph, the written form, and the concrete hyphenated replacement');
      const legal = checkCompoundHyphenation([
        'My experience to date is in-house work, so I own end-to-end ownership of the full stack.',
        'We parked the rental trailers end to end along the fence while drivers checked in trailers at the gate.',
      ]);
      assert(legal.passed,
        `already-hyphenated modifiers, the bare adverbial, the noun “the full stack”, and conjugated check-in verbs are defensible register: ${legal.detail}`);
      const oneDirection = checkCompoundHyphenation(['I ran the check out kiosk for rental trailers.']);
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
      const faulty = checkParallelStructure(['I reviewed each grant from the application form through presenting findings to the board.']);
      const opaque = checkParallelStructure(['I reviewed grant proposals, running each from the application form through a findings presentation to the board.']);
      const parallel = checkParallelStructure([
        'I reviewed each grant from collecting applications to presenting findings for the board.',
        'I reviewed each grant from the initial call for applications to the presentation of findings.',
        'I collected applications, scored each proposal, and presented findings to the board.',
        'I held that role from January 2019 through March 2023.',
      ]);
      const steward = checkParallelStructure(['I ran the reviews, carrying each one from the application form through the final report for the board.']);
      const transfer = checkParallelStructure(['The nightly import I owned moved each record from the booking system to the vendor warehouse.']);
      const span = checkParallelStructure(['I owned that work from the first scoping call through the final handoff.']);
      assert(!faulty.passed && faulty.id === 'parallel-structure'
        && faulty.detail.includes('from the application form through presenting')
        && !opaque.passed && opaque.detail.includes('run each from X through Y')
        && parallel.passed,
      'the runtime check rejects noun-to-gerund and opaque run-range defects while accepting parallel or explicit actions');
      assert(!steward.passed && steward.detail.includes('run each from X through Y') && transfer.passed,
        'the opaque-range anchor covers every stewardship verb, so a paraphrase from ran to carrying cannot route around it, while a concrete transfer between two real systems stays acceptable');
      assert(!span.passed && span.detail.includes('inclusive numeric or calendar ranges')
        && parallel.passed,
        'a span between prose endpoints ends with to, and through survives only for an enumerable series');

      // Three unrelated domains: the rule is an event-class relation (a completed
      // acquisition entails the selection of the same thing), not one sentence.
      const entailedCases = [
        'Before those autoclaves were purchased, the clinic had to pick them, and I ran the trials.',
        'Before the new curriculum was adopted, the school board had to choose it, and I drafted the rubric.',
        'Prior to the routing tools being licensed, finance had to select them, and I built the comparison.',
      ];
      const entailed = checkEntailedPremise(entailedCases);
      const informative = checkEntailedPremise([
        'Before the clinic adopted an autoclave, I had to evaluate the market.',
        'Before the rollout shipped, I had to map every field by hand.',
        'Before those autoclaves were purchased, the clinic had to test them against the old workflow.',
        'Before the board adopted the curriculum, we had to choose which grades to pilot.',
      ]);
      assert(!entailed.passed && entailed.id === 'entailed-premise'
        && entailed.detail.includes('already entails the choice')
        && (entailed.detail.match(/sets up with/gu) || []).length === entailedCases.length
        && informative.passed,
      `a setup clause is rejected only when the acquisition it names already entails the obligation it claims (${entailed.detail}; ${informative.detail})`);

      const abrupt = checkPriorEmployerOpening(
        ['At Brackenfield Freight Company, I evaluated vendor products before company-wide adoption.'],
        ['Brackenfield Freight Company'],
      );
      const framed = checkPriorEmployerOpening(
        ['In my previous software engineering role at Brackenfield Freight Company, I evaluated vendor products before company-wide adoption.'],
        ['Brackenfield Freight Company'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('without the candidate\'s role or relationship')
        && framed.passed,
      'a prior employer in the opening is contextualized for a reader who does not know the organization');

      const broadDomain = checkVagueDomainWorkLabel(['My logistics work extends this evidence with software design.']);
      const concreteDomain = checkVagueDomainWorkLabel(['My work on warehouse-slotting software extends this evidence with software design.']);
      assert(!broadDomain.passed && broadDomain.detail.includes('name the supported software, system, or responsibility')
        && concreteDomain.passed,
      'cross-domain evidence names the concrete work rather than implying broad industry or operational tenure');
      const vagueActors = checkReferenceClarity([
        'I moved the billing queue across with their records.',
        'We reconciled the nightly feed against their ledgers.',
        'Data arrived late, so I rebuilt their loader.',
      ]);
      assert(!vagueActors.passed && vagueActors.id === 'reference-clarity'
        && vagueActors.detail.includes('name the data owner, producer, consumer, vendor, or agency explicitly')
        && ['passage 1', 'passage 2', 'passage 3'].every(label => vagueActors.detail.includes(label)),
      `a plural pronoun with nothing before it to stand for is reported in each passage that uses one (${vagueActors.detail})`);
      // Faithful but pronoun-adjacent: each of these has something for the pronoun
      // to stand for, so none is reported however data-flow-like it reads.
      const namedActors = checkReferenceClarity([
        'I ingested vendor data, delivered feeds to each vendor, and synchronized releases through the agency APIs.',
        'I synchronized releases from the regional agencies through their APIs.',
        'I trained the clinic staff on their new scheduling screens.',
        'I helped each applicant check their status.',
        'The suppliers sent weekly files, and I validated them before the load.',
        'The platforms exposed usage data. I loaded it nightly, and I kept their schemas documented.',
        'When Alder Street Clinic changed their intake forms, I rebuilt the importer.',
      ]);
      assert(namedActors.passed,
        `a plural, collective, distributive, or named antecedent before the pronoun is a clear reference (${namedActors.detail})`);
      const detachedModifier = checkModifierAttachment(['Tuned the dispatch scorer, applying it to ambulance routing after testing candidate heuristics.']);
      const attachedModifier = checkModifierAttachment(['After testing candidate heuristics, I adapted the dispatch scorer for ambulance routing.']);
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
        'Harbourline Customs is hiring an engineer to extend the Vue interface that customs brokers use every day.',
        'The work sits between the broker desk and the port office, so you will follow a signed declaration from the desk where it is handed in to the record that proves it was cleared.',
        'You will own the MongoDB data model that carries manifest, permit, and transfer records for eleven terminals.',
        'We care about how you find the failure point in that path, not about the length of a tool list.',
      ].join(' ');
      const dump = checkAnchorRelevance(['I rebuilt the reporting service around Rails, Redis, Kafka, and Docker Compose behind an Angular client.'], posting, '');
      assert(!dump.passed && dump.id === 'anchor-relevance'
        && dump.detail.includes('paragraph 1 names 5 stack tools the posting and research never mention')
        && dump.detail.includes('“Docker Compose”') && !dump.detail.includes('“Docker”,')
        && dump.detail.includes('letter names 5 stack tools the posting and research never mention'),
      'an unlicensed stack list is reported per paragraph and letter-wide, and longest-first matching counts “Docker Compose” once');
      const licensedPair = checkAnchorRelevance(['I extended the Vue interface against the MongoDB schema that carried manifest records.'], posting, '');
      const singleAnchor = checkAnchorRelevance(['I moved the nightly aggregation onto a Jenkins schedule after the cron host kept losing runs.'], posting, '');
      assert(licensedPair.passed && singleAnchor.passed,
        'two posting-named tools and one off-posting concrete anchor both stay inside the letter budget');
      const tour = checkAnchorRelevance([
        'The scheduler runs on Jenkins.',
        'The queue runs on Kafka.',
        'The cache runs on Redis.',
      ], posting, '');
      assert(!tour.passed && tour.detail.includes('letter names 3 stack tools') && !tour.detail.includes('paragraph 1 names'),
        'a stack tour spread one name per paragraph still fails letter-wide with no paragraph-level observation');
      const dockerPosting = [
        'Brightpath Terminals runs its berth scheduling platform on a small internal team and deploys every service with Docker.',
        'You would take over the nightly aggregation that reconciles gate movements against vessel records, and you would own the release path from a merged branch to a running container.',
        'The platform serves nine terminals, and a failed release is felt at the berth desk within minutes, so we ask for a clear account of how you keep releases boring.',
      ].join(' ');
      const flavour = checkAnchorRelevance(['The service ships under Docker Compose and a Jenkins cron job.'], dockerPosting, '');
      assert(flavour.passed, `a posting naming “Docker” licenses the “Docker Compose” flavour of it: ${flavour.detail}`);
      const researchCorpus = [
        'The Harbourline platform team publishes engineering notes describing a Rails application served behind Nginx.',
        'Their most recent note walks through the manifest import path, the queue that retries a failed import, and the review step a port administrator performs before records become visible to a terminal.',
        'The team describes itself as small, long-tenured, and responsible for the whole path from intake form to filed record.',
      ].join(' ');
      const research = checkAnchorRelevance(['I rebuilt the reporting service around Rails and Nginx.'], '', researchCorpus);
      const skipped = checkAnchorRelevance(['I rebuilt the reporting service around Rails, Nginx, and Redis.'], '', '');
      assert(research.passed && skipped.passed && skipped.detail.includes('skipped: no posting or research text supplied'),
        'research text licenses a name too, and a missing corpus skips rather than rewriting the whole letter');
      // An unscraped job description is a supported state, and the deterministic
      // corpus still carries title/company/location/salary. That metadata can
      // license a name it happens to contain, but it can never show that the
      // employer does not want one, so the check must skip rather than report
      // every résumé-grounded anchor in the letter as off-posting.
      const metadataOnly = checkAnchorRelevance([
        'I rebuilt the reporting service with Flask after the nightly export kept losing rows.',
        'I put Redis behind the intake form so a resubmitted application could not create a second record.',
        'I shipped a Vue dashboard that showed the broker which declarations were still uncleared.',
      ], 'Data Engineer\nAcme Analytics\nAustin, TX\n$140,000 to $180,000 a year', '');
      assert(metadataOnly.passed && metadataOnly.detail.includes('skipped: posting and research text supply only')
        && MIN_ANCHOR_RELEVANCE_CORPUS_WORDS > 25,
      'a metadata-only corpus is not evidence of absence: the floor must stay above the words a title, company, location, and salary contribute');
      assert(!STACK_TOOL_LEXICON.some(entry => ['Go', 'Swift', 'R', 'C', 'D'].includes(entry))
        && STACK_TOOL_LEXICON.includes('Vue') && STACK_TOOL_LEXICON.includes('Docker Compose'),
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
        'The Associate Platform Developer role centers on dispatcher-facing screens and route services.',
      ]);
      assert(!titled.passed && titled.id === 'posting-reference'
        && titled.detail.includes('detached target-position reference')
        && titled.detail.includes('(\u201CThe Associate Platform Developer role centers\u201D)'),
      'a job title between the determiner and the head noun does not hide the target position from the check');
      const fronted = checkPostingReference([
        'At Marrowgate, the role centers on dispatcher-facing screens and route services.',
      ]);
      assert(!fronted.passed && fronted.detail.includes('(\u201Cthe role centers\u201D)'),
        'a fronted clause does not hide the target position from the check');
      // A live letter's own opening, which combined both evasions and was
      // accepted, and the repair the observation names.
      const live = checkPostingReference([
        'At Marrowgate, the Associate Platform Developer role centers on dispatcher-facing screens and route services. I would apply this experience to features that cross dispatcher-facing screens and route services.',
      ]);
      assert(!live.passed
        && live.detail.includes('(\u201Cthe Associate Platform Developer role centers\u201D)')
        && live.detail.includes('use a proximal reference for the position attached to this application'),
      'both evasions combined are still reported, and the observation names the repair');
      const repairedLive = checkPostingReference([
        'At Marrowgate, this role centers on dispatcher-facing screens and route services. I would apply this experience to features that cross dispatcher-facing screens and route services.',
      ]);
      assert(repairedLive.passed,
        `the proximal reference the observation asks for is accepted in the same round: ${repairedLive.detail}`);
      // The same two evasions on the sibling rule in the same contract clause.
      const titledSource = checkPostingReference([
        'The Associate Platform Developer role states that engineers rotate through incident response.',
        'At Marrowgate, the position states that engineers rotate through incident response.',
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
        'I built an internal scheduling tool from scratch. I also wrote a claims assistant for the same company.',
        'I built a driver notification tool too.',
      ]);
      assert(!seam.passed && seam.id === 'additive-seam'
        && seam.detail.includes('paragraph 1 appends evidence with a bare additive connective (“I also wrote a claims assistant for the …”)')
        && seam.detail.includes('paragraph 2 appends evidence with a bare additive connective (“I built a driver notification tool too.”)')
        && seam.detail.includes('state the gap or need this evidence answers before naming the artifact'),
      'the additive opener and the trailing “too” seam are both quoted and repaired argumentatively rather than lexically');
      const adjacentBuild = checkAdditiveSeam([
        'Additionally, I built the berth-booking service the broker runs every morning.',
        'I also personally built the driver notification path.',
      ]);
      assert(!adjacentBuild.passed
        && adjacentBuild.detail.includes('paragraph 1 appends evidence with a bare additive connective (“Additionally, I built the berth-booking service')
        && adjacentBuild.detail.includes('paragraph 2 appends evidence with a bare additive connective (“I also personally built the driver notification'),
      'the seam still fires when the build verb follows the connective subject directly or behind a single -ly adverb');
      const midSentenceTrailer = checkAdditiveSeam([
        'I built the intake system from scratch too, in modern tooling, covering every site.',
      ]);
      assert(!midSentenceTrailer.passed
        && midSentenceTrailer.detail.includes('paragraph 1 appends evidence with a bare additive connective (“I built the intake system from scratch too,'),
      'an additive “too” followed by a comma is the same appended proof as one that ends the sentence');
      const connective = checkAdditiveSeam([
        'I also learned to read incomplete incident reports quickly.',
        'I built the scheduler because the paper process kept losing signed slips.',
        'In addition, I supported the staff who wrote the policy.',
        'I also saw how a poorly designed intake process created rework for the front office.',
        'I built dashboards that were too slow to ship at first, then fixed them.',
        'I built the intake flow as well as the reporting layer.',
      ]);
      assert(connective.passed,
        `an additive opener without adjacent build evidence, build evidence without a seam, a build verb buried in a subordinate clause, a degree “too” followed by the word it modifies, and a mid-sentence “as well as” comparative are ordinary connective prose: ${connective.detail}`);
      const opaqueResponsibilityPivot = checkResponsibilityTransition([
        'The booking tool I extended needed role-limited views so dispatchers saw only what their depot allowed. Keeping the fleet data consistent across its tools was a different problem. I solved it with nightly integration jobs.',
        'The same job also included assessing software the company would adopt instead of build.',
      ]);
      assert(!opaqueResponsibilityPivot.passed && opaqueResponsibilityPivot.id === 'responsibility-transition'
        && opaqueResponsibilityPivot.detail.includes('paragraph 1 shifts from “Keeping the fleet data consistent across its tools …”')
        && opaqueResponsibilityPivot.detail.includes('through an opaque problem label')
        && opaqueResponsibilityPivot.detail.includes('paragraph 2 opens with “The same job also included assessing software the …”')
        && opaqueResponsibilityPivot.detail.includes('shared job scope is not a bridge between responsibilities'),
      'opaque problem-to-solution pivots and same-job paragraph openers require a substantive responsibility bridge');
      // Bare category labels, in three unrelated domains, with no determiner,
      // name, figure or constraint anywhere in the label: one kind of work is
      // called broader than another without saying how.
      const abstractCategoryPivot = checkResponsibilityTransition([
        'Vendor onboarding extended my pharmacy purchasing work beyond contract negotiation.',
        'Beyond shift scheduling, I used a spreadsheet to connect the rota with the payroll export.',
      ]);
      const otherDomainPivot = checkResponsibilityTransition([
        'Curriculum planning also broadened my classroom practice beyond lesson preparation.',
        'Beyond freight handling, I tracked each carrier invoice against the booking record.',
      ]);
      assert(!abstractCategoryPivot.passed
        && abstractCategoryPivot.detail.includes('paragraph 1 says “Vendor onboarding extended my pharmacy purchasing work beyond contract negotiation.”')
        && abstractCategoryPivot.detail.includes('only renames one work category as broader than another')
        && abstractCategoryPivot.detail.includes('paragraph 2 opens evidence with a bare category transition (“Beyond shift scheduling, I used a spreadsheet to …”)')
        && abstractCategoryPivot.detail.includes('“beyond” marks addition but does not explain the relationship')
        && !otherDomainPivot.passed
        && otherDomainPivot.detail.includes('only renames one work category as broader than another')
        && otherDomainPivot.detail.includes('opens evidence with a bare category transition'),
      `abstract work categories and bare beyond-openers cannot stand in for the relationship between proofs, in any domain (${abstractCategoryPivot.detail} | ${otherDomainPivot.detail})`);
      const detachedRelevance = checkDetachedRelevanceClaim([
        "As a software engineer for Brackenfield Freight Company, I shifted billing records and rate tables onto vendor-hosted software, work relevant to this role's carrier onboarding and cross-depot reporting responsibilities.",
      ]);
      const explainedRelevance = checkDetachedRelevanceClaim([
        "As a software engineer for Brackenfield Freight Company, I retired the in-house billing system and wrote the changeover checks that kept rate tables aligned, which is the carrier-onboarding work this role describes.",
        'Experience relevant to this role includes writing changeover checks and reconciliation reports for replacement software.',
      ]);
      assert(!detachedRelevance.passed && detachedRelevance.id === 'detached-relevance-claim'
        && detachedRelevance.detail.includes("work relevant to this role's")
        && detachedRelevance.detail.includes('using conditional language for work that would occur after hiring'),
      'a trailing relevance assertion cannot make the recruiter infer the action-to-responsibility connection');
      assert(explainedRelevance.passed,
        `an explicit mechanism and a non-detached relevance noun phrase remain valid: ${explainedRelevance.detail}`);
      const presentContribution = checkProspectiveContributionTense([
        "That changeover experience helps me contribute to this role's carrier-onboarding responsibilities.",
      ]);
      const pastReadinessContribution = checkProspectiveContributionTense([
        "That project prepared me to contribute to HPA's carrier onboarding and cross-depot reporting flows.",
      ], 'Halden Port Authority');
      const prospectiveContribution = checkProspectiveContributionTense([
        'At HPA, I would apply that changeover experience to retiring old dispatch tools and designing cross-depot reporting flows.',
        'I wrote changeover scripts and reconciled rate tables against the replacement software.',
      ], 'Halden Port Authority');
      const historicalPreparation = checkProspectiveContributionTense([
        "That training prepared me to support Brackenfield Freight Company's replacement systems the following year.",
        'That training prepared me to support the systems during the following peak season.',
      ], 'Halden Port Authority');
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
        'My clinic experience covers intake flow and records exchange. I handled intake flow by moving paper forms onto tablets. In separate records work, I addressed records exchange by connecting the front desk to the lab.',
        'My clinic experience covers intake flow and records exchange. I handled intake flow such as moving paper forms onto tablets. I addressed the records exchange by connecting the front desk to the lab.',
        'Her bakery chain spans sourcing and distribution. I tackled sourcing through weekly farm calls. I oversaw distribution by routing drivers to the busiest sites.',
      ]);
      assert(!mirroredCategoryScaffold.passed
        && mirroredCategoryScaffold.detail.includes('paragraph 1 repeats mirrored abstract labels (“intake flow” then “records exchange”)')
        && mirroredCategoryScaffold.detail.includes('paragraph 2 repeats mirrored abstract labels (“intake flow” then “records exchange”)')
        && mirroredCategoryScaffold.detail.includes('paragraph 3 repeats mirrored abstract labels (“sourcing” then “distribution”)')
        && mirroredCategoryScaffold.detail.includes('state the umbrella once, then let concrete action verbs demonstrate each branch'),
      `an explicit umbrella must not turn the following evidence into mirrored light-verb category labels, including the “such as” variant and other domains (${mirroredCategoryScaffold.detail})`);
      const bridgedResponsibilityPivot = checkResponsibilityTransition([
        'The booking tool I extended needed role-limited views so dispatchers saw only what their depot allowed. Alongside that access-control work, I kept the fleet data consistent across its tools with nightly integration jobs.',
        'That role also required me to assess software the company would adopt instead of build.',
        'The cutover extended the catalog system to support interlibrary loans without interrupting circulation.',
        'Beyond reshelving the branch catalog, I wrote a script to preserve borrower identifiers during cutover.',
        'Moving operations exposed incompatible record identifiers, so I used a nightly load script to reconcile them before cutover.',
        'My clinic experience covered two distinct needs: adapting intake flow and enabling records exchange. I moved paper forms onto tablets. Separately, I connected the front desk to the lab.',
        // Faithful but label-adjacent: a determiner, a figure, a name, or a branch no earlier
        // sentence stated takes each construction out of scope.
        'Beyond scheduling the 14 night shifts, I wrote a macro to balance the overtime.',
        'Beyond Alder Street staffing, I reconciled each carrier invoice against its booking.',
        'Vendor onboarding also extended my Alder Street purchasing work beyond contract negotiation.',
        'I handled the Tuesday backlog by triaging by clinic. I covered the weekend queue by rotating two drivers.',
        'Beyond scheduling, there was little left to automate.',
      ]);
      assert(bridgedResponsibilityPivot.passed,
        `supported bridges, concrete actions under one umbrella, and a minimal separation cue avoid opaque or mirrored category scaffolding: ${bridgedResponsibilityPivot.detail}`);
      const evaluatedResponsibilityPivot = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ['Keeping the fleet data consistent across its tools was a separate challenge. I addressed it with nightly integration jobs.'],
        evidence, researchText: '',
      }).find(check => check.id === 'responsibility-transition');
      assert(evaluatedResponsibilityPivot && !evaluatedResponsibilityPivot.passed,
        'the complete cover-letter evaluator enforces opaque responsibility-transition repairs, not only the direct helper');
      const evaluatedCategoryPivot = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ['Vendor onboarding extended my pharmacy purchasing work beyond contract negotiation. Beyond shift scheduling, I used a spreadsheet to connect the rota with payroll.'],
        evidence, researchText: '',
      }).find(check => check.id === 'responsibility-transition');
      assert(evaluatedCategoryPivot && !evaluatedCategoryPivot.passed
        && evaluatedCategoryPivot.detail.includes('only renames one work category as broader than another')
        && evaluatedCategoryPivot.detail.includes('opens evidence with a bare category transition'),
      'the complete evaluator routes both abstract category pivots into its single prose-revision attempt');
      const evaluatedDetachedRelevance = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ["I shifted billing records and rate tables onto vendor-hosted software, experience directly relevant to this role's carrier onboarding responsibilities."],
        evidence, researchText: '',
      }).find(check => check.id === 'detached-relevance-claim');
      assert(evaluatedDetachedRelevance && !evaluatedDetachedRelevance.passed,
        'the complete evaluator routes detached relevance assertions into its single prose-revision attempt');
      const evaluatedPresentContribution = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ["That project prepared me to contribute to HPA's carrier onboarding and cross-depot reporting flows."],
        evidence, researchText: '', companyName: 'Halden Port Authority',
      }).find(check => check.id === 'prospective-contribution-tense');
      assert(evaluatedPresentContribution && !evaluatedPresentContribution.passed,
        'the complete evaluator routes past or present readiness bridges for prospective contribution into its single prose-revision attempt');
      const posting = checkPostingReference([
        'Owning the rollout end-to-end is what your posting wants sped up.',
        'The job ad asks for the same cleanup work, as advertised.',
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
        'This position sits between the field crews and the dispatch office.',
        'Your listing quality team ships the ranking model.',
        'The listing page I rebuilt cut abandoned carts.',
        'I rewrote the job description parser your team maintains.',
      ]);
      assert(workNouns.passed, `proximal role references name the work itself, while “listing” and “job description” may remain marketplace and job-board product vocabulary: ${workNouns.detail}`);
      const equivalence = checkClaimedEquivalence([
        'The way the depot routing work maps onto your platform is the part I would bring first.',
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
      const forcedAnalogy = checkClaimedEquivalence([
        'Pallet verification is another side of the same route coordination problem.',
      ]);
      assert(!forcedAnalogy.passed
        && forcedAnalogy.detail.includes('(“another side of the same route coordination problem”)'),
      `the forced same-problem analogy is rejected while the domains remain distinct (got ${forcedAnalogy.detail})`);
      const postingSentence = 'The Fleet Planning group is hiring an engineer who will maintain carrier scheduling services and keep each dispatch decision compliant with driver rest regulations.';
      const restatedOpening = checkOpeningPostingRestatement([
        'The Fleet Planning group maintains carrier scheduling services that keep every dispatch decision compliant with driver rest regulations.',
      ], postingSentence);
      const compactRestatedOpening = checkOpeningPostingRestatement([
        'Maintain carrier scheduling services.',
      ], postingSentence);
      const inflectedRestatedOpening = checkOpeningPostingRestatement([
        'Maintaining scheduling services that keep dispatch decisions compliant under driver rest regulation.',
      ], postingSentence);
      const synthesizedOpening = checkOpeningPostingRestatement([
        'Dispatch decisions are only as dependable as the planning underneath them, a constraint I have handled in rule-driven yard tools.',
      ], postingSentence);
      const candidateSpecificOpening = checkOpeningPostingRestatement([
        'I built a pickup-window planner for a regional bakery chain, where delivery decisions had to remain traceable to the dispatcher.',
      ], postingSentence);
      assert(!restatedOpening.passed && restatedOpening.id === 'opening-posting-restatement'
        && restatedOpening.detail.includes('closely restates one posting sentence')
        && !compactRestatedOpening.passed
        && !inflectedRestatedOpening.passed
        && synthesizedOpening.passed && candidateSpecificOpening.passed,
      `an opening must reject both compressed and inflected advertisement paraphrases while leaving a candidate-specific connection alone (restated=${restatedOpening.detail}; compact=${compactRestatedOpening.detail}; inflected=${inflectedRestatedOpening.detail}; synthesized=${synthesizedOpening.detail}; candidate=${candidateSpecificOpening.detail})`);
      const equivalentForms = [
        'Pallet verification is a facet of the same route coordination problem.',
        'Pallet verification is another aspect of the same route coordination problem.',
        'Pallet verification represents the same route coordination challenge in another context.',
      ].map(sentence => checkClaimedEquivalence([sentence]));
      const nonEquivalence = checkClaimedEquivalence([
        'I built a claims review tool in another context and would apply its traceability practice to this role.',
      ]);
      assert(equivalentForms.every(check => !check.passed && check.id === 'claimed-equivalence')
        && nonEquivalence.passed,
      `the asserted-equivalence family catches facets, aspects, and same-challenge-in-another-context forms without rejecting a normal transfer argument (forms=${equivalentForms.map(check => check.detail).join(' | ')}; control=${nonEquivalence.detail})`);
      return { seam: seam.detail, posting: posting.detail, equivalence: equivalence.detail, opening: compactRestatedOpening.detail };
    },
  },
  {
    name: 'cover letter harness: candidate-first openings, exact requirement modality, evidence scope, and migration objects remain clear',
    run: () => {
      const scaffolds = [
        'The posting requires a careful engineer for this work.',
        "Northstar's listing calls for reliable delivery.",
        "Driftwood’s posting places clear ownership on product engineers.",
        'This role calls for an engineer who can build interfaces.',
      ].map(paragraph => checkOpeningJobSummaryScaffolding([paragraph]));
      const secondParagraphScaffold = checkOpeningJobSummaryScaffolding([
        'My review workflow experience keeps work traceable.',
        "Northstar's posting calls for reliable delivery.",
      ]);
      const supportedOpening = checkOpeningJobSummaryScaffolding([
        'My experience making review decisions traceable would help this role keep its customer workflows understandable.',
      ]);
      assert(scaffolds.every(check => !check.passed && check.id === 'opening-job-summary-scaffolding')
        && !secondParagraphScaffold.passed && secondParagraphScaffold.detail.includes('paragraph 2')
        && supportedOpening.passed,
      `job-summary scaffolding is rejected at every paragraph opening while a candidate-first thesis remains valid (${scaffolds.map(check => check.detail).join(' | ')}; ${secondParagraphScaffold.detail}; ${supportedOpening.detail})`);

      const ambiguousMigration = checkMigrationObjectClarity([
        'The invoicing/claims-tracking systems moved to vendor-hosted software.',
        'Claims tracking migrated after validation.',
      ]);
      const clearMigration = checkMigrationObjectClarity([
        'I migrated the invoicing system, the claims-tracking system, and both sets of records to vendor-hosted software.',
        'The sign-in / sign-out process remained available during the rollout.',
        'The sign-in/sign-out system migrated to the new platform.',
      ]);
      assert(!ambiguousMigration.passed && ambiguousMigration.detail.includes('invoicing/claims-tracking systems moved')
        && ambiguousMigration.detail.includes('tracking migrated') && clearMigration.passed,
      `migration copy names its actual object and permits ordinary slash pairs outside migration claims (${ambiguousMigration.detail}; ${clearMigration.detail})`);

      const modalityQuote = 'Use the workflow platform to support review work.';
      const modalityParagraph = 'My capability designing review workflows is supported by my past work. I configured the workflow platform to improve review quality. I would integrate the workflow platform into this role’s review work.';
      const modality = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My capability designing review workflows is supported by my past work.',
          proof: 'I configured the workflow platform to improve review quality.',
          relevance: 'I would integrate the workflow platform into this role’s review work.',
          jobNeedQuote: modalityQuote,
        } }] },
        paragraphs: [modalityParagraph], jobText: modalityQuote,
      });
      assert(!modality.passed && modality.detail.includes('turns a use/workflow requirement into building or integrating it'),
        `a tool-use requirement cannot become an integration responsibility in the transfer (${modality.detail})`);
      const validModalityParagraph = 'My capability designing review workflows is supported by my past work. I configured the workflow platform to improve review quality. I would use the platform to build review tools for this role.';
      const validModality = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My capability designing review workflows is supported by my past work.',
          proof: 'I configured the workflow platform to improve review quality.',
          relevance: 'I would use the platform to build review tools for this role.',
          jobNeedQuote: modalityQuote,
        } }] },
        paragraphs: [validModalityParagraph], jobText: modalityQuote,
      });
      assert(validModality.passed,
        `building tools around a platform is not incorrectly read as building the platform (${validModality.detail})`);

      // One invariant, three instruments: using a tool in one's own process is not
      // evidence of having shipped a product powered by that tool. The tool is
      // learned from the proof, not from a list, so a tool nobody listed works too.
      const scopeCases = [
        {
          label: 'AI family',
          need: 'Design LLM-driven triage features for the support desk.',
          claim: 'My capability improving delivery practice is supported by prior work.',
          proof: 'I implemented AI-assisted coding workflows to improve review quality.',
          relevance: 'I would apply that practice to designing LLM-driven triage features for the support desk.',
          badClaim: 'My experience shipping LLM-driven triage features is supported by prior work.',
          badRelevance: 'I would apply that experience to designing LLM-driven triage features for the support desk.',
          direct: { claim: 'My capability building usable triage features is supported by prior work.', proof: 'I built an LLM-driven triage feature for reviewers.' },
        },
        {
          label: 'cloud (a tool no list names)',
          need: 'Operate cloud-native scheduling applications for a hospital network.',
          claim: 'My capability improving release practice is supported by prior work.',
          proof: 'I deployed clinic systems through cloud-assisted runbooks.',
          relevance: 'I would apply that practice to operating cloud-native scheduling applications for a hospital network.',
          badClaim: 'My experience building cloud-native scheduling applications is supported by prior work.',
          badRelevance: 'I would apply that experience to operating cloud-native scheduling applications for a hospital network.',
          direct: { claim: 'My capability building scheduling applications is supported by prior work.', proof: 'I built a cloud-native scheduling application for a clinic network.' },
        },
        {
          label: 'robot',
          need: 'Maintain robot-driven packing cells on the warehouse floor.',
          claim: 'My capability improving line practice is supported by prior work.',
          proof: 'I tested robot-assisted picking trials on the floor.',
          relevance: 'I would apply that practice to maintaining robot-driven packing cells on the warehouse floor.',
          badClaim: 'My experience developing robot-driven packing cells is supported by prior work.',
          badRelevance: 'I would apply that experience to maintaining robot-driven packing cells on the warehouse floor.',
          direct: { claim: 'My capability building packing cells is supported by prior work.', proof: 'I built a robot-driven packing cell for the floor.' },
        },
      ];
      const scopeCheck = (kase, claim, proof, relevance) => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance, jobNeedQuote: kase.need } }] },
        paragraphs: [`${claim} ${proof} ${relevance}`], jobText: kase.need,
      });
      for (const kase of scopeCases) {
        const prospective = scopeCheck(kase, kase.claim, kase.proof, kase.relevance);
        const overclaim = scopeCheck(kase, kase.badClaim, kase.proof, kase.badRelevance);
        const directBuild = scopeCheck(kase, kase.direct.claim, `${kase.direct.proof} ${kase.proof}`, kase.badRelevance);
        assert(prospective.passed
          && !overclaim.passed && overclaim.detail.includes('treats a tool-assisted practice (“')
          && overclaim.detail.includes('as evidence of shipping a product powered by that tool')
          && directBuild.passed,
        `${kase.label}: prospective target work stays valid, a tool-assisted practice cannot become prior shipment of a product powered by that tool, and a direct build proves it (${prospective.detail}; ${overclaim.detail}; ${directBuild.detail})`);
      }
      const badScope = scopeCheck(scopeCases[0], scopeCases[0].badClaim, scopeCases[0].proof, scopeCases[0].badRelevance);
      return { opening: scaffolds[0].detail, migration: ambiguousMigration.detail, modality: modality.detail, scope: badScope.detail };
    },
  },
  {
    name: 'cover letter harness: runaway sentences, semicolons, dash splices, and bureaucratic register carry plain repairs',
    run: () => {
      const long = checkSentenceLength(['The scheduling rewrite began when the paper receiving log kept losing signed delivery slips, so I mapped every handoff between the dock, the yard office, and the billing desk in order to find the point where a slip could vanish without anyone noticing it had gone missing at all.']);
      assert(!long.passed && long.id === 'sentence-length'
        && long.detail.includes('paragraph 1 contains a 49-word sentence beginning “The scheduling rewrite began when the paper receiving …”')
        && long.detail.includes('split it into short causal sentences') && MAX_SENTENCE_WORDS === 40,
      'a runaway sentence reports its exact word count and opening words for the split');
      const measured = checkSentenceLength(['The scheduling rewrite began when the paper receiving log kept losing signed delivery slips, so I mapped every handoff between the dock, the yard office, and the billing desk.']);
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
        'I led that team from March 2019 – August 2022 without a gap.',
        'I led that team from March, 2019 – August, 2022 without a gap.',
        'I led that team from Sep. 2019 – Feb. 2020 without a gap.',
        'I led that team from March,2019 – Aug.,2022 without a gap.',
        'I led that team from 03/2019 – 06/2022 without a gap.',
        'I led that team from March 2019 – Current without a gap.',
        'I led that team from March 2019 – Ongoing without a gap.',
        'I led that team from March 2019 – (Present) without a gap.',
      ]);
      assert(spacedRanges.passed,
        `numeric and conventional month-year ranges both ship past the document gate, so flagging them would spend a revision round damaging correct copy: ${spacedRanges.detail}`);
      // Parity with the design-system hard gate (assertCandidateDashPunctuation).
      // Anything that gate throws on must arrive here as a revisable
      // observation instead: a spaced hyphen used to pass this check, fail the
      // build, and surface as a page-count error that never mentioned a dash.
      const gateCorpus = [
        'I ran the desk - the queue never backed up.',
        'The core - the scheduler - shipped.',
        'The rollout had two halves — the scheduling core and the reporting service.',
        'The broker signed the form – the office filed it.',
        'I led that work from 2019–2022 without a gap in coverage.',
        'I worked there from 2019 – 2022 without a break.',
        'I led that team from March 2019 – August 2022 without a gap.',
        'I led that team from March, 2019 – August, 2022 without a gap.',
        'I led that team from Sep. 2019 – Feb. 2020 without a gap.',
        'I led that team from March,2019 – Aug.,2022 without a gap.',
        'I led that team from 03/2019 – 06/2022 without a gap.',
        'I led that team from March 2019 – Current without a gap.',
        'I led that team from March 2019 – Ongoing without a gap.',
        'I led that team from March 2019 – (Present) without a gap.',
        'The project grew in March, 2019 – and then shipped.',
        'The service migrated from Sep. 2019 – after testing.',
        'The deadline was 2023 – maybe next year.',
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
      assert(parity.filter(item => item.gateRejected).length === 7
        && parity.every(item => item.gateRejected === item.spliceFlagged),
      'every dash form the document gate rejects must become a revisable observation, and no form it blesses may be sent back for revision');
      const colonStyle = checkPunctuationStyle([
        'The greenhouse ran on one rule: water before noon.',
        'I opened the bakery at 10:30 and mixed dough at a 3:1 ratio.',
        'The ferry timetable now lives at https://example.test for every deckhand.',
      ]);
      assert(!colonStyle.passed
        && colonStyle.detail.includes('paragraph 1 uses a colon as sentence punctuation; write the sentence out instead')
        && !colonStyle.detail.includes('paragraph 2 uses a colon')
        && !colonStyle.detail.includes('paragraph 3 uses a colon'),
      `a prose colon is revision work while a time, a ratio, and a URL scheme are not: ${colonStyle.detail}`);
      const markCorpus = [
        { copy: 'The greenhouse ran on one rule: water before noon.', rejected: true, marker: 'uses a colon as sentence punctuation', gateMessage: 'Cover-letter copy contains a colon used as sentence punctuation. Write the sentence out instead.' },
        { copy: 'I calibrated the kiln each morning; the glaze never cracked.', rejected: true, marker: 'uses a semicolon', gateMessage: 'Cover-letter copy contains a semicolon. Split the clause into separate sentences.' },
        { copy: 'I opened the bakery at 10:30 every weekday.', rejected: false },
        { copy: 'The ferry timetable now lives at https://example.test for every deckhand.', rejected: false },
      ];
      for (const { copy, rejected, marker, gateMessage } of markCorpus) {
        let gateError = null;
        try {
          assertCandidateDashPunctuation({ coverLetter: { paragraphs: [copy] } });
        } catch (error) {
          gateError = error;
        }
        const advisory = checkPunctuationStyle([copy]);
        if (rejected) {
          assert(gateError && gateError.message === gateMessage,
            `the document gate rejects this mark by name on the letter surface: ${copy} -> ${gateError?.message}`);
          assert(!advisory.passed && advisory.detail.includes(`paragraph 1 ${marker}`),
            `the advisory check flags what the gate rejects: ${copy} -> ${advisory.detail}`);
        } else {
          assert(!gateError, `the document gate blesses mechanical colons: ${copy} -> ${gateError?.message}`);
          assert(advisory.passed, `the advisory check never sends a blessed colon back for revision: ${copy} -> ${advisory.detail}`);
        }
      }
      const register = checkPlainRegister([
        'I am in possession of a valid driver licence for the depot fleet.',
        'I possess a valid first aid certificate for the site.',
      ]);
      assert(!register.passed && register.id === 'plain-register'
        && register.detail.includes('paragraph 1 uses bureaucratic register (“in possession of”)')
        && register.detail.includes('(“possess a valid”)'),
      'the fixed bureaucratic formulas ask for plain first-person English');
      const plain = checkPlainRegister(['I have a valid driver licence, and I can work weekends in the depot.']);
      assert(plain.passed, `plain first-person logistics facts must never become revision work: ${plain.detail}`);
      const missingIntroComma = checkIntroductoryWorkplaceComma([
        'At the company I delivered software through manual and rule-based workflows.',
      ]);
      const introCommaPresent = checkIntroductoryWorkplaceComma([
        'At the company, I delivered software through manual and rule-based workflows.',
        'At times I chose a traditional workflow.',
      ]);
      const namedWorkplaceMissingComma = checkIntroductoryWorkplaceComma([
        'At Northstar Systems I led a platform changeover.',
      ], ['Northstar Systems']);
      assert(!missingIntroComma.passed
        && missingIntroComma.detail.includes('insert a comma after “At the company”')
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
      // No actor is named in the rule: any subject that cannot point at a concrete UI
      // target gets the same repair, and a metaphorical “point to” stays untouched.
      const anyActor = checkVisualReferencePrecision([
        'A first-time visitor cannot point at the field they mean when the form has a dozen of them.',
      ]);
      const metaphoricalPoint = checkVisualReferencePrecision([
        'I cannot point to a single metric that explains the delay.',
      ]);
      assert(!ambiguousPoint.passed
        && ambiguousPoint.detail.includes('visually indicate the on-screen control')
        && !ambiguousVariant.passed
        && !anyActor.passed
        && metaphoricalPoint.passed
        && visualPoint.passed,
      'screen-guidance prose recognizes varied actors, targets, and pointing constructions while accepting an explicit visible limitation');
      const conditionalClose = checkDirectWelcomeClosing(['I would welcome the chance to talk about that work.']);
      const conditionalConversation = checkDirectWelcomeClosing(['I would welcome a conversation about how that combination could support the HARBOR rebuild.']);
      const conditionalDiscussion = checkDirectWelcomeClosing(['I’d welcome a discussion about the release path.']);
      const deferentialVariant = checkDirectWelcomeClosing(['I would be pleased to discuss the rollout.']);
      const directClose = checkDirectWelcomeClosing(['I welcome a conversation about how my release-workflow experience could support the team’s deployment process.']);
      const employerChoiceClose = checkDirectWelcomeClosing(['I welcome a conversation about whether the voice assistant or browser agent should be the first prototype.']);
      const nonClosingUse = checkDirectWelcomeClosing([
        'I would welcome the chance to review that question during discovery.',
        'The rollout work is the contribution I want to continue here.',
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
      // the target half is the one a second incident (see the
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
      const spacedGladVariant = checkDirectWelcomeClosing(['I would be glad to discuss the rollout.']);
      const contractedGladVariant = checkDirectWelcomeClosing(["I'd be glad to discuss the rollout."]);
      const curlyContractedGladVariant = checkDirectWelcomeClosing(['I’d be glad to discuss the rollout.']);
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
      const evidenceBring = checkPlainRegister(['Product evaluation, route planning, and nightly load scripts are the evidence I would bring.']);
      assert(!evidenceBring.passed && evidenceBring.detail.includes('say what experience, skills, or work the candidate would bring'),
        'a closing distinguishes the candidate\'s capabilities from the evidence supporting the argument');
      assert(sentences('The desk logged forms at 9 a.m. for Harbourline Inc. and closed at noon.').length === 1
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

      // A scope phrase that names a category of built software, then a build of
      // that same category with nothing after it, restates itself. The category
      // is read from the sentence's own words, so it holds in any domain.
      const fillerBridges = [
        'For tools that remained in-house, I built software.',
        'Where the clinic relied on desktop programs, I developed applications.',
        'With the old billing system retired, I wrote code.',
        'For the platforms the warehouse kept, I created systems.',
      ].map(sentence => checkLowInformationToolBuild([sentence]));
      const specificBridges = checkLowInformationToolBuild([
        'For tools that remained in-house, I built the workflow that reconciled operator changes before release.',
        'For workflows that remained manual, I built software that reconciled operator changes before release.',
        'For systems that lacked audit trails, I built software that recorded each operator change.',
        // The scope names something other than a software category, so the sentence carries information.
        'For the night shift at the pharmacy, I built software.',
        'When the grant deadline moved up, I built software.',
        // A modifier on the object makes it a specific thing.
        'For tools that remained in-house, I built audit software.',
      ]);
      assert(fillerBridges.every(check => !check.passed && check.detail.includes('only restates that the scoped thing is software'))
        && specificBridges.passed,
      `a terminal category-restating bridge is removed or made specific without rejecting concrete work (${fillerBridges.map(check => check.detail).join(' | ')}; ${specificBridges.detail})`);

      // The tool a letter credits with containerizing is judged against what the
      // current résumé credits, so the rule holds for any tool and any domain.
      const stackEvidence = {
        bulletTexts: [
          'Containerized the intake portal with Podman, running the app under Puma behind Traefik.',
          'Operated the nightly export job on a shared Linux host.',
        ],
        skills: [{ group: 'Infrastructure', items: ['Podman', 'Traefik', 'Puma'] }],
      };
      const mismatchedRoles = checkContainerizationTechnologyRoles([
        'I containerized it with Podman, Traefik, and Puma so one image could be promoted from staging to production hosts.',
      ], stackEvidence);
      const accurateRoles = checkContainerizationTechnologyRoles([
        'I containerized the service with Podman, then configured Traefik as a reverse proxy and Puma as the application server.',
      ], stackEvidence);
      const coordinatedRoles = checkContainerizationTechnologyRoles([
        'I containerized it with Podman and configured Traefik as the reverse proxy.',
      ], stackEvidence);
      // Verified false rejection of the old fixed server list: the proxy is the
      // OBJECT being containerized and Podman is the instrument.
      const objectNotInstrument = checkContainerizationTechnologyRoles([
        'I containerized the Traefik proxy with Podman for the staff portal.',
      ], stackEvidence);
      const otherDomain = {
        bulletTexts: ['Containerized the simulation pipeline in Apptainer images, submitting each run through Slurm.'],
        skills: [{ group: 'Platform', items: ['Apptainer', 'Slurm', 'PostgreSQL'] }],
      };
      const otherMismatch = checkContainerizationTechnologyRoles(['I containerized the simulation pipeline using Slurm.'], otherDomain);
      const otherAccurate = checkContainerizationTechnologyRoles(['I containerized the simulation pipeline using Apptainer, with Slurm scheduling each run.'], otherDomain);
      // A tool the résumé does not state at all is the grounding checks' business, and a résumé that
      // names no containerization instrument leaves nothing to contradict.
      const unattested = checkContainerizationTechnologyRoles(['I containerized the simulation pipeline using Mesos.'], otherDomain);
      const noEvidence = checkContainerizationTechnologyRoles(['I containerized it with Podman, Traefik, and Puma.']);
      assert(!mismatchedRoles.passed
        && mismatchedRoles.detail.includes('crediting “Traefik” with the containerization')
        && mismatchedRoles.detail.includes('the résumé names “Podman” for that')
        && accurateRoles.passed && coordinatedRoles.passed
        && objectNotInstrument.passed
        && !otherMismatch.passed && otherMismatch.detail.includes('crediting “Slurm”')
        && otherAccurate.passed && unattested.passed && noEvidence.passed,
      `containerization claims cannot credit a technology the résumé states in another role, while separate role-accurate predicates and an object-versus-instrument sentence pass (${mismatchedRoles.detail} | ${objectNotInstrument.detail} | ${otherMismatch.detail})`);

      // A résumé bullet whose trailing clause only chains terms the same résumé
      // already indexes in its Skills block adds no mechanism of its own. The
      // terms are invented: the decision reads them from the résumé's own Skills.
      const skillsBlock = '<section class="section"><h2>Skills</h2><dl class="skills"><dt>Tools</dt><dd>Alpha Console · Beta Ledger · Gamma Scheduler</dd></dl></section>';
      const topologyTail = checkResumeBulletFocus(`<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example</span><ul class="highlights"><li>Rebuilt the clinic intake process, running Alpha Console under Beta Ledger behind Gamma Scheduler.</li></ul></article>${skillsBlock}</main>`);
      const focusedContainerization = checkResumeBulletFocus(`<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example</span><ul class="highlights"><li>Rebuilt the clinic intake process with Alpha Console.</li></ul></article>${skillsBlock}</main>`);
      assert(!topologyTail.passed
        && topologyTail.detail.includes('already indexes in Skills')
        && focusedContainerization.passed,
      'résumé validation keeps a complete highlight focused instead of ending it in a clause that only chains terms the Skills block already indexes');
      // Faithful text next to that shape stays legal: a purpose after the last
      // name, a figure, fewer than three indexed names, names the Skills block
      // does not index, and a plain comma list all carry something of their own.
      const focusAround = (bullet, block = skillsBlock) => checkResumeBulletFocus(`<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Example</span><ul class="highlights"><li>${bullet}</li></ul></article>${block}</main>`);
      const chain = 'running Alpha Console under Beta Ledger behind Gamma Scheduler';
      assert(focusAround(`Rebuilt the clinic intake process, ${chain} to cut handoff delays.`).passed
        && focusAround(`Rebuilt the clinic intake process, ${chain} 24 hours a day.`).passed
        && focusAround(`Rebuilt the clinic intake process, running Alpha Console under Beta Ledger.`).passed
        && focusAround(`Rebuilt the clinic intake process, ${chain}.`, skillsBlock.replace(' · Beta Ledger · Gamma Scheduler', '')).passed
        && focusAround('Rebuilt the clinic intake process, using Alpha Console, Beta Ledger and Gamma Scheduler.').passed
        && focusAround('Opened the regional office network, serving Boston, Cambridge and Somerville.').passed,
      'a clause that carries a purpose, a figure, fewer indexed names, unindexed names or a plain comma list is not mistaken for an inventory tail');

      const literalizedFrame = checkClaimedEquivalence([
        'A vendor service and an internal tool are two answers to one build-or-buy call.',
      ]);
      const mechanismFirst = checkClaimedEquivalence([
        'I compare vendor capabilities, custom code, and manual controls against the constraints of each workflow.',
      ]);
      assert(!literalizedFrame.passed
        && literalizedFrame.detail.includes('asserts a cross-domain equivalence')
        && mechanismFirst.passed,
      'a coined two-answers-to-one-decision frame cannot force nonparallel options into an equivalence');

      const danglingTransition = checkDanglingParagraphTransition([
        'The checklist kept every reviewer in control. The boundary between manual review and automated checks also shaped how I handled invoice matching at Northstar Depot.',
        'I would bring careful architecture decisions to the target work.',
      ]);
      const developedTransition = checkDanglingParagraphTransition([
        'The checklist kept every reviewer in control. At Northstar Depot, I applied the same boundary by routing flagged invoices through scripted validation.',
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
          'I containerized it with Podman, Traefik, and Puma so one image could be promoted from staging to production hosts.',
          'The boundary between manual review and automated checks also shaped how I handled invoice matching at Northstar Depot.',
          'A vendor service and an internal tool are two answers to one build-or-buy call.',
        ],
        evidence: stackEvidence,
      });
      const failures = new Map(combined.filter(check => !check.passed).map(check => [check.id, check.detail]));
      assert(failures.has('tool-calls-garden-path')
        && failures.has('low-information-tool-build')
        && failures.has('containerization-technology-roles')
        && failures.has('dangling-paragraph-transition')
        && failures.has('claimed-equivalence'),
      `each exact regression case is part of the single-revision prose evaluation: ${[...failures.keys()].join(', ')}`);
      return { gardenPath: gardenPath.detail, fillerBridge: fillerBridges[0].detail, mismatchedRoles: mismatchedRoles.detail, danglingTransition: danglingTransition.detail };
    },
  },
  {
    name: 'cover letter harness: a synthetic register-defect letter fails every appended deterministic check',
    run: () => {
      // Every construction here paraphrases a real generation defect with
      // invented employers and projects. The fixture deliberately contains no
      // copied letter text and no personal data.
      const paragraphs = [
        'Owning the rollout end to end is what your posting wants, and that is the work I kept in house at Brightpath Terminals through a rebuild that began when the paper receiving log lost signed delivery slips, continued through every handoff between the dock, the yard office, and the broker, and ended only once each slip had one named owner.',
        'I rebuilt the shared in-house core with Vue, Flask, Redis, Terraform, and Docker Compose behind a Svelte client; one piece was Berthwise — the scheduling service the broker now runs every morning.',
        'I built Berthwise from scratch. I also wrote Tallybook, a claims assistant for the same company. I built a driver notification tool too.',
        'That evaluation practice gives me a clear view of that approach’s downsides and trade-offs as well as its upsides. The way the depot routing work maps onto your carrier-neutral platform is the part I would bring first. I am in possession of a valid driver licence.',
      ];
      const checks = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs,
        evidence: { bulletTexts: ['Rebuilt a dock intake path so every delivery slip carried one named owner.'] },
        // A posting-sized corpus (the check treats anything smaller as metadata)
        // that names exactly one of the six tools the letter lists.
        jobText: [
          'Harbourline Customs is hiring an engineer to extend the Vue interface that customs brokers use every day.',
          'The role sits between the broker desk and the port office, so you will follow a signed declaration from the moment it is handed in to the record that proves it was cleared.',
          'We care about how you find the failure point in that path, not about the length of a tool list.',
          'Tell us what broke, what you changed, and how you knew the change held.',
        ].join(' '),
        researchText: '',
        companyName: 'Harbourline Customs',
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
        'I maintained a highly available service that handled travel-booking records for a Lakeview team.',
        'In a prior role, I traveled between customer sites while resolving incidents.',
      ]);
      assert(logisticsPositiveControls.passed,
        `system availability, historical travel duties, and neutral locations are not current logistics promises: ${logisticsPositiveControls.detail}`);
      const logisticsGate = checkPlanGate({ ...groundedPlan, logistics: 'I am available to start on June 1.' }, evidence, needs,
        'The role must manage incident escalation.', '', 'Logistics: I am available to start on June 1.');
      assert(logisticsGate.shouldRetry && logisticsGate.checks.some(check => check.id === 'logistics-exclusion' && !check.passed),
        'availability in plan logistics must request the plan retry that removes it');
      const unanchored = checkOpeningDemonstrative([
        'I built the nightly data integration between the depot booking system and its vendor platforms.',
        'That evaluation practice already covers AI products.',
      ]);
      assert(!unanchored.passed && unanchored.id === 'opening-demonstrative'
        && unanchored.detail.includes('paragraph 2 opens with “That evaluation practice already …”')
        && unanchored.detail.includes('“evaluation” or “practice”'),
      'a paragraph-opening demonstrative must find its referent in the paragraph the reader just finished');
      const anchored = checkOpeningDemonstrative([
        'I ran the vendor product evaluations behind the company adoption decisions.',
        'That evaluation practice already covers AI products.',
      ]);
      assert(anchored.passed, `a stemmed referent in the previous paragraph anchors the demonstrative: ${anchored.detail}`);
      const fixedPhrase = checkOpeningDemonstrative([
        'The integration reached both directions.',
        'That is why the company kept the contract.',
      ]);
      assert(fixedPhrase.passed, `pronoun and fixed-phrase demonstratives are out of scope: ${fixedPhrase.detail}`);
      const firstParagraph = checkOpeningDemonstrative(['That evaluation practice is the subject of this letter and needs no anchor.']);
      assert(firstParagraph.passed, 'the first paragraph has no previous paragraph to anchor to and is never flagged');
      const shorthandEmployer = checkOpeningEmployerShorthand([
        'At Brackenfield Freight Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
        'The company chose that software because it was cheaper to keep running than the in-house systems.',
      ], ['Brackenfield Freight Company']);
      const explicitEmployer = checkOpeningEmployerShorthand([
        'At Brackenfield Freight Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
        'Brackenfield Freight Company chose that software because it was cheaper to keep running than the in-house systems.',
      ], ['Brackenfield Freight Company']);
      const repeatedEmployer = checkAdjacentEmployerRepetition([
        'In my software engineering role at Brackenfield Freight Company, I wrote a gate workflow that forwarded every tag scan to the right carrier portal.',
        'At Brackenfield Freight Company, I also assembled a dispatch board whose front end and back end were designed to take on further tools.',
      ], ['Brackenfield Freight Company']);
      const conciseRoleReference = checkAdjacentEmployerRepetition([
        'In my software engineering role at Brackenfield Freight Company, I wrote a gate workflow that forwarded every tag scan to the right carrier portal.',
        'In that role, I also assembled a dispatch board whose front end and back end were designed to take on further tools.',
      ], ['Brackenfield Freight Company']);
      const disambiguatedEmployers = checkAdjacentEmployerRepetition([
        'In my software engineering role at Brackenfield Freight Company, I integrated the dispatch system with a platform from Acme.',
        'At Brackenfield Freight Company, I also assembled a dispatch board whose front end and back end were designed to take on further tools.',
      ], ['Brackenfield Freight Company', 'Acme']);
      const ordinaryDefiniteDescription = checkOpeningEmployerShorthand([
        'At Brackenfield Freight Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
        'The system validated records before the cutover.',
      ], ['Brackenfield Freight Company']);
      const unanchoredCompany = checkOpeningEmployerShorthand([
        'I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
        'The company chose that software because it was cheaper to keep running than the in-house systems.',
      ], ['Brackenfield Freight Company']);
      assert(!shorthandEmployer.passed && shorthandEmployer.id === 'opening-employer-shorthand'
        && shorthandEmployer.detail.includes('“The company chose …”')
        && shorthandEmployer.detail.includes('Brackenfield Freight Company'),
      'a new paragraph cannot replace a just-named prior employer with organization shorthand');
      assert(explicitEmployer.passed && ordinaryDefiniteDescription.passed && unanchoredCompany.passed,
        `an explicit employer bridge, ordinary definite description, and a company with no prior named-employer antecedent remain allowed: ${explicitEmployer.detail}; ${ordinaryDefiniteDescription.detail}; ${unanchoredCompany.detail}`);
      // Both messages used to hand over a literal re-entry cue as the repair,
      // and a live letter opened two of its four paragraphs
      // with exactly that cue. They now describe what the opening should be
      // about, name the employer because that is what makes the observation
      // locatable, and quote nothing else beyond the employer's own name: the
      // only quoted span in either message that is not the employer's name is
      // the offending opening itself.
      const employerMessages = [shorthandEmployer.detail, repeatedEmployer.detail];
      assert(shorthandEmployer.detail.includes('open instead on whatever this paragraph is actually about')
        && shorthandEmployer.detail.includes('“Brackenfield Freight Company” named in full where another employer or role could be the referent'),
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
      const employerNameQuotes = quotedSpans.filter(span => span === 'Brackenfield Freight Company');
      const otherQuotedSpans = quotedSpans.filter(span => span !== 'Brackenfield Freight Company');
      assert(employerNameQuotes.length === 4,
        `both messages must curly-quote the employer's own name at every mention, twice each (quoted=${JSON.stringify(quotedSpans)})`);
      assert(otherQuotedSpans.length === 1 && otherQuotedSpans[0] === 'The company chose …',
        `neither employer message quotes a reusable phrase the letter could paste, beyond the employer's own name (quoted=${JSON.stringify(quotedSpans)})`);
      assert(!employerMessages.some(detail => /\bin that role\b/iu.test(detail)),
        `and neither one names the re-entry cue the shipped letter copied twice (messages=${JSON.stringify(employerMessages)})`);
      const evaluatedEmployerShorthand = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: [
          'At Brackenfield Freight Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
          'The company chose that software because it was cheaper to keep running than the in-house systems.',
        ],
        evidence: { roles: [{ company: 'Brackenfield Freight Company' }] }, researchText: '',
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
        ['SlateBoard addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'],
        ['SlateBoard'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('first names “SlateBoard”'),
        'a named résumé project cannot begin its proof before the reader learns what it is or the candidate relationship');
      const structuredEvidence = extractResumeEvidence('<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built a native desktop annotation server.</li></ul></article><div class="projects"><article class="project"><span class="project-name">SlateBoard</span><span class="project-desc">A native desktop annotation server.</span></article></div></main>');
      const hostChecks = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: 'Built a native desktop annotation server.' }], companyHook: { detail: '' } },
        paragraphs: ['SlateBoard addressed a concrete interface gap because a screen assistant could describe a control but not visibly indicate it.'],
        evidence: structuredEvidence,
      });
      assert(!hostChecks.find(check => check.id === 'named-artifact-introduction').passed,
        'host-side enforcement derives known project names from the structured résumé project markup');
      const introduced = checkNamedArtifactIntroduction(
        ['I built SlateBoard, a native desktop annotation server, to address the interface gap between describing a control and visibly indicating it.'],
        ['SlateBoard'],
      );
      const introducedAsOverlay = checkNamedArtifactIntroduction(
        ['I built SlateBoard, a click-through overlay, to visibly indicate the control a screen assistant means.'],
        ['SlateBoard'],
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
        ['RouteDesk is my personal project, where hosted vision models process item photos and draft listings.'],
        ['RouteDesk'],
      );
      const projectPreposition = checkOpeningArtifactContext(
        ['In RouteDesk, I connected hosted vision-model APIs to item photos and listing drafts.'],
        ['RouteDesk'],
      );
      const possessiveProject = checkOpeningArtifactContext(
        ['My personal project, RouteDesk, connects hosted vision-model APIs to item photos and listing drafts.'],
        ['RouteDesk'],
      );
      const employerFirst = checkOpeningArtifactContext(
        ['As a Software Engineer at Brackenfield Freight Company, I built a gate workflow that connected outside carrier portals.'],
        [], ['Brackenfield Freight Company'],
      );
      const targetFacing = checkOpeningArtifactContext(
        ['Connecting AI APIs to usable workflows is the capability this role needs. RouteDesk is my personal project that demonstrates it.'],
        ['RouteDesk'],
      );
      const exactRoleOpening = checkOpeningArtifactContext(
        ['Marlowe’s Applied AI Developer role calls for turning AI models and APIs into working products.'],
        ['RouteDesk'], ['Brackenfield Freight Company'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('RouteDesk'),
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
      const splitCapability = 'For a different operational workflow, I built a weigh-station kiosk app that identified trucks by plate capture. The app queried the carrier registry and could flag overweight loads to the inspector on duty.';
      const integrationThenActionSplit = 'For a different operational workflow, I built a weigh-station kiosk app that identified trucks by plate capture and queried the carrier registry. When a captured plate matched an overweight record, the app could flag the load to the inspector on duty.';
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
        'I am interested in Keystone Center’s access workflows because I have built role-limited web interfaces for yard coordinators.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views.',
        'I welcome a conversation about how my access-control experience could support the team’s authorization work.',
      ]);
      const genericEnthusiasm = checkInterestFraming([
        'I am excited about joining the Keystone Center team.',
        'At Brackenfield Freight Company, I updated an invoicing system.',
      ]);
      const repeatedInterest = checkInterestFraming([
        'I am interested in Keystone Center’s access workflows because I have built role-limited web interfaces for yard coordinators.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views.',
        'I am excited about the opportunity to join the team.',
      ]);
      const contributionClose = checkInterestFraming([
        'I am interested in Keystone Center’s access workflows because I have built role-limited web interfaces for yard coordinators.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views.',
        'I am interested in how my access-control experience could support the team’s authorization work.',
      ]);
      const possessiveCompanyInterest = checkInterestFraming([
        'Parcelo’s work helping brands create and keep product listings current interests me because it pairs end-to-end feature development with long-term maintainability.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views for yard coordinators.',
      ]);
      const impliedInterest = checkInterestFraming([
        'Keystone Center’s access workflows call for role-limited web interfaces that let people reach the services available to them.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views for yard coordinators.',
        'I welcome a conversation about how my access-control experience could support the team’s authorization work.',
      ]);
      const ordinaryInterestNoun = checkInterestFraming([
        'The role’s interest in access-control workflows is clear from its focus on authorization.',
        'At Brackenfield Freight Company, I updated a dock-appointment tool with role-limited views.',
      ]);
      const additionalDeclarations = [
        'My interest in Keystone Center comes from its authorization work.',
        'I am drawn to Keystone Center’s authorization work.',
        'I am motivated by the team’s work on authorization.',
      ].map(paragraph => checkInterestFraming([paragraph]));
      const evaluated = evaluateCoverLetterChecks({
        plan: { mappings: [], companyHook: { detail: '' } },
        paragraphs: ['I am excited about joining the Keystone Center team.'], evidence: {}, researchText: '', companyName: 'Nimbus',
      });
      assert(!directInterest.passed && !genericEnthusiasm.passed && !possessiveCompanyInterest.passed
        && directInterest.detail.includes('declares the candidate’s interest')
        && !repeatedInterest.passed && !contributionClose.passed
        && impliedInterest.passed && ordinaryInterestNoun.passed
        && additionalDeclarations.every(check => !check.passed)
        && evaluated.some(check => check.id === 'interest-framing' && !check.passed),
      'explicit first-person interest and enthusiasm declarations require a target-work recast, while concrete engagement and non-candidate uses of “interest” remain valid');
      return { directInterest: directInterest.detail, possessiveCompanyInterest: possessiveCompanyInterest.detail, impliedInterest: impliedInterest.detail };
    },
  },
  {
    name: 'cover letter harness: opening application boilerplate yields to a direct team-work capability hook',
    run: () => {
      const boilerplate = checkGenericPhrases([
        'I am applying for the Software Development Engineer role on the Keystone Center team. I have built access-controlled web interfaces.',
      ]);
      const extendedBoilerplate = checkGenericPhrases([
        'I would like to apply for the Software Development Engineer role on the Keystone Center team.',
      ]);
      const directHook = checkGenericPhrases([
        'Keystone Center needs access workflows that show each user only the accounts and applications they are authorized to use. I have built role-limited web interfaces for yard coordinators.',
      ]);
      const quotedEvidence = checkGenericPhrases([
        'A hiring guide warned that the phrase “I am applying for this role” does not explain a candidate capability. My work on access-controlled interfaces does.',
      ]);
      const evaluated = evaluateCoverLetterChecks({
        plan: { mappings: [], companyHook: { detail: '' } },
        paragraphs: ['I am applying for the Software Development Engineer role on the Keystone Center team.'],
        evidence: {}, researchText: '', companyName: 'Nimbus',
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
      const posting = `Northgate Care and Learning runs residential homes and community classes across the region. This engineer joins the platform team that keeps stock counting, resident scheduling, and learner attendance records accurate for site managers. You will design web workflows that let managers see shortages early, plan rotas, and confirm who attended each session. We value clear reporting, careful access control, and software that front-line staff can trust during a busy shift.`;
      const priorWorkEvidence = {
        bulletTexts: [
          'Built a cold-chain integration that identified cartons by label scan, raised temperature alerts, and flagged recalled lots.',
          'Tracked pharmacy inventory counts across three clinics and flagged shortages before shift change.',
          'Scheduled patient transport slots for a rural hospital network using a rostering workbook.',
          'Recorded classroom attendance for a community college program and reported absences to advisors.',
        ],
      };
      const leakedThesis = 'For this role\'s attendance reporting, I would bring experience building temperature alerts and recalled lots flagging in web workflows.';
      const leaked = checkTargetClaimScope({ roleThesis: leakedThesis }, [], priorWorkEvidence, posting);
      const general = checkTargetClaimScope({
        roleThesis: 'For this role\'s attendance reporting, I would bring experience designing secure, usable access workflows.',
      }, ['In a prior web application, I implemented temperature alerts and recalled lot flagging after label scans.'], priorWorkEvidence, posting);
      const evaluated = evaluateCoverLetterChecks({
        plan: { roleThesis: leakedThesis, mappings: [], companyHook: { detail: '' } },
        paragraphs: [leakedThesis],
        evidence: priorWorkEvidence,
        jobText: posting,
      });
      const directBring = checkTargetClaimScope({}, [
        'For this role\'s stock counting, I bring cold-chain alert experience from pharmacy work.',
      ], priorWorkEvidence, posting);
      const contribution = checkTargetClaimScope({}, [
        'For this role\'s stock counting, I would contribute temperature alert experience from pharmacy work.',
      ], priorWorkEvidence, posting);
      const closing = checkTargetClaimScope({}, [
        'I welcome a conversation about applying my cold-chain alert work to the learner records this role keeps accurate.',
      ], priorWorkEvidence, posting);
      assert(!leaked.passed && leaked.detail.includes('temperature alert'),
        `a target thesis cannot promote two adjacent prior-workflow terms into the target role (${leaked.detail})`);
      assert(general.passed,
        `a general capability may lead while the prior workflow remains a past-tense proof sentence: ${general.detail}`);
      assert(!directBring.passed && !contribution.passed && !closing.passed && closing.detail.includes('cold chain'),
        'target-facing prose checks cover I bring, I would contribute, and an applying-my-work closing with a hyphenated source-domain mechanic');
      assert(!evaluated.find(check => check.id === 'target-claim-scope').passed,
        'the prose revision loop receives a target-claim-scope failure for the leaked target thesis');
      // Faithful but list-adjacent: the posting says stock, residents and learners
      // where the evidence says inventory, patients and classrooms. A single source
      // word beside posting vocabulary is the candidate's own word for the same
      // thing, not a promoted mechanic, and no fixed noun list can tell them apart.
      const synonymClaims = [
        'For this role\'s stock counting, I would bring my inventory counting experience.',
        'For this team\'s resident scheduling, I would bring my patient scheduling experience.',
        'For this role\'s learner attendance records, I would bring my classroom attendance experience.',
      ].map(sentence => checkTargetClaimScope({}, [sentence], priorWorkEvidence, posting));
      assert(synonymClaims.every(check => check.passed),
        `a single synonym of a posting word is not reported as a leaked prior-work mechanic (${synonymClaims.map(check => check.detail).join(' | ')})`);
      return { leaked: leaked.detail, general: general.detail };
    },
  },
  {
    name: 'cover letter harness: paragraph argument mappings require an explicit, concrete proof-to-need bridge in either order',
    run: () => {
      const posting = 'Nimbus Keystone Center modernizes the control plane and Nimbus access portal, where teams build interfaces that show each user only the accounts and applications they are authorized to use.';
      // An unbridged opening-plus-proof paragraph, and a generic bridge that names
      // no responsibility of the quote it cites. The generic bridge is decided by
      // the shared-term rule against the CURRENT quote, not by a fixed phrase.
      const permitsPosting = 'The permits office modernizes the licensing portal, where staff review applications submitted by contractors.';
      const permitsQuote = 'modernizes the licensing portal';
      const deficient = [
        'For the permits office\'s portal work, I bring experience building web interfaces with access controls. At Northgate Clinic, I updated a scheduling system with role-limited views for front-desk staff.',
        'In that role, I also built an internal reporting board with a front end and a back end designed to host additional tools. I would apply that full-stack experience to the interface and service work behind this role.',
      ];
      const deficientPlan = {
        paragraphs: [
          { argumentMapping: {
            claim: 'For the permits office\'s portal work, I bring experience building web interfaces with access controls.',
            proof: 'At Northgate Clinic, I updated a scheduling system with role-limited views for front-desk staff.',
            relevance: 'For the permits office\'s portal work, I bring experience building web interfaces with access controls.',
            jobNeedQuote: permitsQuote,
          } },
          { argumentMapping: {
            claim: 'I would apply that full-stack experience to the interface and service work behind this role.',
            proof: 'In that role, I also built an internal reporting board with a front end and a back end designed to host additional tools.',
            relevance: 'I would apply that full-stack experience to the interface and service work behind this role.',
            jobNeedQuote: permitsQuote,
          } },
        ],
      };
      const deficientCheck = checkParagraphArgumentLinks({ plan: deficientPlan, paragraphs: deficient, jobText: permitsPosting });
      assert(!deficientCheck.passed
        && deficientCheck.detail.includes('paragraph 1 argumentMapping.relevance does not name a concrete responsibility from its jobNeedQuote')
        && deficientCheck.detail.includes('paragraph 2 argumentMapping.relevance does not name a concrete responsibility from its jobNeedQuote'),
      `the unbridged opening-plus-proof paragraph and a generic bridge are both flagged against the quote they cite (${deficientCheck.detail})`);

      // The review correction used to say only that relevance missed a
      // concrete responsibility. That left the writer to guess which words
      // survive the validator's stop-word and singularization rules, and an
      // audit-only repair could repeat unchanged. The hint must be derived
      // from the exact jobNeedQuote this mapping already supplied, while the
      // same predicate still rejects the generic span and accepts its literal
      // repair.
      const hintPosting = 'The role designs authorization decision systems for customer accounts.';
      const hintClaim = 'My experience with access-control systems is a practical foundation for reliable delivery.';
      const hintProof = 'At Brackenfield Freight Company, I built a role-limited dock-appointment tool for yard coordinators.';
      const hintRelevance = 'I would apply that access-control experience to this role.';
      const hintQuote = 'designs authorization decision systems';
      const hintedFailure = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim: hintClaim, proof: hintProof, relevance: hintRelevance, jobNeedQuote: hintQuote } }] },
        paragraphs: [`${hintClaim} ${hintProof} ${hintRelevance}`], jobText: hintPosting,
      });
      const hintedRepair = 'I would apply that access-control experience to authorization decision systems.';
      const hintedPass = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim: hintClaim, proof: hintProof, relevance: hintedRepair, jobNeedQuote: hintQuote } }] },
        paragraphs: [`${hintClaim} ${hintProof} ${hintedRepair}`], jobText: hintPosting,
      });
      assert(!hintedFailure.passed
        && hintedFailure.detail.includes('eligible responsibility terms')
        && hintedFailure.detail.includes('"authorization"')
        && hintedFailure.detail.includes('"decision"')
        && hintedFailure.detail.includes('this relevance currently matches none')
        && hintedPass.passed,
      `the concrete-responsibility rejection exposes its validator-derived literal repair terms without relaxing the gate: ${hintedFailure.detail}`);

      const relevanceFirst = 'Those access-control patterns would help Keystone Center present each user only the accounts and applications they are authorized to use. My experience with access-control patterns is a practical foundation for authorization-focused workflows. At Brackenfield Freight Company, I built an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.';
      const passingCheck = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My experience with access-control patterns is a practical foundation for authorization-focused workflows.',
          proof: 'At Brackenfield Freight Company, I built an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.',
          relevance: 'Those access-control patterns would help Keystone Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: [relevanceFirst], jobText: posting,
      });
      assert(passingCheck.passed,
        `a relevance-first paragraph with exact spans and an explicit authorization bridge must pass: ${passingCheck.detail}`);
      const naturalClaims = [
        {
          claim: 'I have worked on web interfaces that restrict access by role.',
          relevance: 'Those access patterns would help Keystone Center present each user only the accounts and applications they are authorized to use.',
        },
        {
          claim: 'My full-stack work spans interfaces and the back-end services behind them.',
          relevance: 'That full-stack experience would help Keystone Center build interfaces that show each user only authorized accounts.',
        },
      ];
      naturalClaims.forEach(({ claim, relevance }) => {
        const natural = checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim,
            proof: 'At Brackenfield Freight Company, I built an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.',
            relevance,
            jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
          } }] },
          paragraphs: [`${relevance} ${claim} At Brackenfield Freight Company, I built an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.`],
          jobText: posting,
        });
        assert(natural.passed, `natural general capability claim must pass without formulaic “experience” language: ${natural.detail}`);
      });
      const presentPerfectProof = 'At Brackenfield Freight Company, I have updated an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.';
      const presentPerfect = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'I build web interfaces that restrict access by role.',
          proof: presentPerfectProof,
          relevance: 'Those access patterns would help Keystone Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: [`Those access patterns would help Keystone Center present each user only the accounts and applications they are authorized to use. I build web interfaces that restrict access by role. ${presentPerfectProof}`],
        jobText: posting,
      });
      assert(paragraphHasCandidatePastProof(presentPerfectProof) && presentPerfect.passed,
        `a first-person present-perfect action must count as proof and pass its mapping: ${presentPerfect.detail}`);
      assert(!paragraphHasCandidatePastProof('I build web interfaces that restrict access by role.'),
        'a present-tense general capability statement must remain a claim, not a completed proof');
      const anaphoraPosting = 'Nimbus Keystone Center enables customers and enterprises to interact securely with Nimbus consoles and services.';
      const anaphoraClaim = 'I have worked on web interfaces that restrict access by role.';
      const anaphoraProof = 'At Brackenfield Freight Company, I updated an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.';
      const anaphoraRelevance = 'I would bring that experience to Keystone Center’s work enabling customers and enterprises to interact securely with Nimbus consoles and services.';
      const clearAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof, relevance: anaphoraRelevance,
          jobNeedQuote: 'customers and enterprises to interact securely with Nimbus consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} ${anaphoraRelevance}`], jobText: anaphoraPosting,
      });
      const genericAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof,
          relevance: 'I would bring that experience to your innovative team.',
          jobNeedQuote: 'customers and enterprises to interact securely with Nimbus consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} I would bring that experience to your innovative team.`], jobText: anaphoraPosting,
      });
      const ambiguousAnaphora = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: anaphoraClaim, proof: anaphoraProof, relevance: anaphoraRelevance,
          jobNeedQuote: 'customers and enterprises to interact securely with Nimbus consoles and services',
        } }] },
        paragraphs: [`${anaphoraClaim} ${anaphoraProof} I also built an internal dispatch board for staff. ${anaphoraRelevance}`], jobText: anaphoraPosting,
      });
      assert(clearAnaphora.passed && !genericAnaphora.passed
        && genericAnaphora.detail.includes('generic relevance label')
        && ambiguousAnaphora.passed,
      `a relevance sentence needs no back-reference and no shared noun, so an intervening sentence does not matter once it names the quote's responsibility, while a generic label still fails: ${clearAnaphora.detail}; ${genericAnaphora.detail}; ${ambiguousAnaphora.detail}`);
      const systemProof = 'At Brackenfield Freight Company, I built a role-limited dock-appointment tool for yard coordinators.';
      const implicitReferences = [
        'I would bring this experience to Keystone Center’s work enabling customers and enterprises to interact securely with Nimbus consoles and services.',
        'I would apply that work to Keystone Center’s work enabling customers and enterprises to interact securely with Nimbus consoles and services.',
        'I would use the system to enable customers and enterprises to interact securely with Nimbus consoles and services.',
        'I would use it to enable customers and enterprises to interact securely with Nimbus consoles and services.',
      ];
      implicitReferences.forEach(relevance => {
        const implicit = checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim: anaphoraClaim, proof: systemProof, relevance,
            jobNeedQuote: 'customers and enterprises to interact securely with Nimbus consoles and services',
          } }] },
          paragraphs: [`${anaphoraClaim} ${systemProof} ${relevance}`], jobText: anaphoraPosting,
        });
        assert(implicit.passed, `an immediate proof may license a clear implicit reference without restating its full noun phrase: ${implicit.detail}`);
      });
      const doppelPosting = 'The team builds secure web interfaces that turn user input into controlled back-end actions.';
      const doppelClaim = 'I have built workflows that turn user input into controlled back-end actions.';
      const doppelProof = 'At Brackenfield Freight Company, I have built a web application that identified trucks by plate capture and could flag an overweight load to the inspector when a captured plate matched a violation record.';
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
          claim: 'At Brackenfield Freight Company, I have built an Angular dock-appointment tool with role-limited views for yard coordinators.',
          proof: presentPerfectProof,
          relevance: 'Those access patterns would help Keystone Center present each user only the accounts and applications they are authorized to use.',
          jobNeedQuote: 'interfaces that show each user only the accounts and applications they are authorized to use',
        } }] },
        paragraphs: ['Those access patterns would help Keystone Center present each user only the accounts and applications they are authorized to use. At Brackenfield Freight Company, I have built an Angular dock-appointment tool with role-limited views for yard coordinators. At Brackenfield Freight Company, I have updated an Angular and Sass dock-appointment tool with role-limited views for yard coordinators.'],
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
          proof: 'At Brackenfield Freight Company, I built an internal simulation tool for staff.',
          relevance: simulationRelevance,
          jobNeedQuote: 'create simulations using natural language',
        } }] },
        paragraphs: [`${simulationRelevance} My work spans simulation-creation interfaces and back-end services. At Brackenfield Freight Company, I built an internal simulation tool for staff.`],
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
      const unmappableClaim = 'My delivery experience is directly relevant to this role.';
      const unmappableProof = 'I owned the internal reporting service for the colleagues who depend on it.';
      const unmappable = `${unmappableClaim} ${unmappableProof}`;
      const unmappablePosting = 'Engineer role focused on reliable system delivery. The team maintains internal services.';
      const spanGaps = paragraphArgumentSpanGaps(unmappable, unmappablePosting);
      assert(spanGaps.length === 1 && spanGaps[0].field === 'relevance',
        `the drafting-stage reporter names the one span this paragraph cannot supply: ${JSON.stringify(spanGaps)}`);
      assert(!paragraphArgumentSpanGaps(unmappable).length && paragraphArgumentSpanGaps(unmappableProof).some(gap => gap.field === 'relevance'),
        'without the posting the reporter can only ask whether the paragraph has a sentence apart from its proof, the weaker verdict and still a subset');
      const runs = [];
      const unmappableWords = unmappable.split(/\s+/u);
      for (let start = 0; start < unmappableWords.length; start += 1) {
        for (let end = start + 1; end <= unmappableWords.length; end += 1) runs.push(unmappableWords.slice(start, end).join(' '));
      }
      const mappable = runs.some(relevance => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim: unmappableClaim, proof: unmappableProof, relevance, jobNeedQuote: 'reliable system delivery' } }] },
        paragraphs: [unmappable], jobText: unmappablePosting,
      }).passed);
      assert(!mappable,
        `no span of a paragraph reported by the drafting stage can satisfy this check (${runs.length} spans tried)`);
      // In whatever wording the writer chooses: this sentence has no modal and no stock frame.
      const repairedRelevance = 'Reliable system delivery is what this team needs from whoever owns that service.';
      const repairedParagraph = `${unmappable} ${repairedRelevance}`;
      const repaired = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: unmappableClaim,
          proof: unmappableProof,
          relevance: repairedRelevance,
          jobNeedQuote: 'reliable system delivery',
        } }] },
        paragraphs: [repairedParagraph], jobText: unmappablePosting,
      });
      assert(!paragraphArgumentSpanGaps(repairedParagraph, unmappablePosting).length && repaired.passed,
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
        'At Tidemark, Routelink pairs dispatcher screens with carrier integration work that reduces manual handoffs for depots. As a Software Engineer at Brackenfield Freight Company, my gate kiosk app passed container tag reads to the shipping lines’ booking portals. I would apply that integration practice to Routelink screens that reduce handoff effort and delay.',
        'A separate project moved paper inspection sheets and maintenance histories into a shared register, combining conversion workflows with photographing, checking, and cutover tooling.',
        'Import scripts handled trailer records, and a lookup service opened the gate database through staff accounts.',
      ];
      const escaped = artifactActor.every(paragraph => !paragraphArgumentSpanGaps(paragraph, 'reducing handoff effort').length);
      const agency = checkCandidateAgency(artifactActor);
      assert(escaped && !agency.passed && agency.detail.includes('argumentMapping'),
        `artifact-as-actor paragraphs owe no span and must be caught by the agency check instead: ${agency.detail}`);

      // The same evidence in the first person now owes a mapping, and the
      // paragraph is reported until it carries the abstraction beat.
      const posting = 'Make it easy for Routelink depots to grow their volume while reducing handoff effort and delay.';
      const evidence = 'As a Software Engineer at Brackenfield Freight Company, I built a kiosk app that read container tags at the gate and sent each movement to the shipping lines\u2019 booking portals.';
      const transfer = 'I would apply that consolidation work to Routelink\u2019s planning screens, so depots adding Cold Storage, Customs Hold, or Cross-Dock carry less of the handoff effort.';
      const warrant = 'The engineering was in absorbing those portals\u2019 differences into one surface, so the clerk at the gate acted on a single screen instead of learning which carrier owned which action.';
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
      const groundedRange = 'Led a dock intake rebuild from 2019–2022 so every delivery slip carried one named owner.';
      const checks = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: groundedRange }], companyHook: { detail: '' } },
        paragraphs: [
          'The broker at Brightpath Terminals kept losing signed delivery slips because intake ran on paper. This role requires someone who can find that failure point and close it. My experience to date is in that kind of cleanup work.',
          'I rebuilt the intake path against the Vue interface and the MongoDB schema the broker already trusted. The rebuild kept one in-house core, so a single team owned end-to-end delivery. I led that work from 2019–2022 without a gap.',
          'Paper slips vanished between three desks, so I gave every slip a single owner record. The same gap explained why billing feedback arrived late, which is why the second tool answered a need the first one had exposed.',
          'I have a valid driver licence for the depot fleet. I can say what the rebuild cost in review time and what it saved at the dock desk, and I would rather argue the mechanism than the resemblance.',
        ],
        evidence: { bulletTexts: [groundedRange] },
        jobText: [
          'Harbourline Customs is hiring an engineer to extend the Vue interface that customs brokers use every day.',
          'The work sits between the broker desk and the port office, so you will follow a signed declaration from the desk where it is handed in to the record that proves it was cleared.',
          'You will own the MongoDB data model that carries manifest, permit, and transfer records for eleven terminals.',
          'We care about how you find the failure point in that path, not about the length of a tool list.',
        ].join(' '),
        researchText: '',
        companyName: 'Harbourline Customs',
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
      // A relevance span is recognised by the words it shares with the posting,
      // in whatever wording the writer chose. That is necessary, not sufficient:
      // the gate also rejects a span that reads as a generic relevance label, and
      // a span that names nothing the posting asks for. This paragraph has a
      // sentence apart from its proof, and still cannot be mapped: the one
      // sentence that could carry the relevance is a generic label (every span
      // wide enough to reach the posting's vocabulary also picks up “experience
      // … relevant”), and every other sentence shares too little with the
      // posting. Reported by nobody until the completion gate read it, with the
      // letter three stages frozen and the only repair a rewrite.
      const posting = 'Harbourline Customs needs reliable delivery for the broker interface.';
      const paragraph = 'My delivery experience supports dependable work. I owned the reporting service. My experience is directly relevant to this role, and I would bring it along.';
      const claim = 'My delivery experience supports dependable work.';
      const proof = 'I owned the reporting service.';
      assert(paragraphHasCandidatePastProof(paragraph),
        'the fixture states a candidate past action, so the completion gate requires a mapping for it');
      const withPosting = paragraphArgumentSpanGaps(paragraph, posting);
      assert(withPosting.length === 1 && withPosting[0].field === 'relevance',
        `the reporter names the relevance span this paragraph cannot supply: ${JSON.stringify(withPosting)}`);
      assert(!paragraphArgumentSpanGaps(paragraph).length,
        'without the posting the reporter can only ask whether the paragraph has a sentence apart from its proof, which is the weaker verdict and still a subset');

      // Subset proof, the same way the sibling reporter proves it: every
      // contiguous word run of the paragraph is tried as the relevance span
      // and every contiguous word run of the posting as its job-need quote,
      // and none of them makes the gate pass. The only relevance observations
      // that read the proof are the apart-from-proof ones, so the assertion
      // also records that some OTHER relevance observation fires on every pair
      // — no choice of claim or proof could have rescued it.
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
      const independentRelevanceFailure = /argumentMapping\.relevance (?:is missing|is not an exact normalized span|uses a generic relevance label|does not name a concrete responsibility)/u;
      let mappablePairs = 0;
      let proofDependentOnlyPairs = 0;
      for (const relevance of relevanceRuns) {
        for (const jobNeedQuote of needRuns) {
          const verdict = checkParagraphArgumentLinks({
            plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance, jobNeedQuote } }] },
            paragraphs: [paragraph], jobText: posting,
          });
          if (verdict.passed) mappablePairs += 1;
          else if (!independentRelevanceFailure.test(verdict.detail)) proofDependentOnlyPairs += 1;
        }
      }
      assert(!mappablePairs && !proofDependentOnlyPairs,
        `no span of a reported paragraph is a legal relevance field for any posting quote (${relevanceRuns.length} spans × ${needRuns.length} quotes, ${mappablePairs} passed, ${proofDependentOnlyPairs} failed only on a proof-dependent rule)`);

      // The generic label is skipped by the reporter as the gate skips it: the
      // only sentence apart from the proof that carries two words of the posting
      // also carries “experience … relevant”, so every span wide enough to reach
      // both words is a generic label and every narrower span names one word only.
      // Flipping a single word (“is relevant to” becomes “sits beside”) turns the
      // same sentence into a legal span, which is the control.
      const genericPosting = 'The team needs reliable delivery.';
      const genericClaim = 'My practice is steady.';
      const genericProof = 'I owned the reporting service.';
      const genericParagraph = `${genericClaim} ${genericProof} Reliable experience is relevant to delivery.`;
      assert(paragraphArgumentSpanGaps(genericParagraph, genericPosting).some(gap => gap.field === 'relevance'),
        'a sentence that carries the posting’s words only inside a generic label is not a relevance span');
      const genericWords = genericParagraph.split(/\s+/u);
      let genericPassed = 0;
      for (let start = 0; start < genericWords.length; start += 1) {
        for (let end = start + 1; end <= genericWords.length; end += 1) {
          if (checkParagraphArgumentLinks({
            plan: { paragraphs: [{ argumentMapping: { claim: genericClaim, proof: genericProof, relevance: genericWords.slice(start, end).join(' '), jobNeedQuote: 'reliable delivery' } }] },
            paragraphs: [genericParagraph], jobText: genericPosting,
          }).passed) genericPassed += 1;
        }
      }
      assert(!genericPassed, `no span of the generic-label paragraph passes the gate either (${genericPassed} passed)`);
      assert(!paragraphArgumentSpanGaps(genericParagraph.replace('is relevant to', 'sits beside'), genericPosting).length,
        'without the label the same sentence is a legal relevance span');

      // Repairability, by following the reported rule literally: say, in a
      // sentence of your own, how the work bears on a responsibility the posting
      // states. The sentence carries no modal and no stock frame.
      const repairedRelevance = 'Reliable delivery for the broker interface is what this role comes down to.';
      const repaired = `${paragraph} ${repairedRelevance}`;
      assert(!paragraphArgumentSpanGaps(repaired, posting).length,
        'the span the reporter describes is the span that clears it');
      const repairedVerdict = checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim, proof,
          relevance: repairedRelevance,
          jobNeedQuote: 'reliable delivery for the broker interface',
        } }] },
        paragraphs: [repaired], jobText: posting,
      });
      assert(repairedVerdict.passed,
        `the repair the reporter names is one the completion gate accepts: ${repairedVerdict.detail}`);

      // And the reporter must stay silent on a paragraph the gate accepts:
      // supplying the posting may never turn a mappable paragraph into a
      // drafting-stage rejection. A sentence that is also the claim is a legal
      // relevance span when it names the need and stands apart from the proof.
      const mappable = 'My delivery experience supports reliable delivery for the broker interface. I owned the reporting service.';
      assert(!paragraphArgumentSpanGaps(mappable, posting).length
        && checkParagraphArgumentLinks({
          plan: { paragraphs: [{ argumentMapping: {
            claim: 'My delivery experience supports reliable delivery',
            proof,
            relevance: 'supports reliable delivery for the broker interface',
            jobNeedQuote: 'reliable delivery for the broker interface',
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
            evidence: 'Reduced response backlog by 32% while coordinating field crews across six regions.',
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
      const acronymCompany = 'Orchard Interactive Entertainment (OIE)';
      const acronymJob = { company: acronymCompany };
      const acronymEnvelope = authorCoverLetterEnvelope({ job: acronymJob, evidence });
      assert(acronymEnvelope.recipient === ''
        && acronymEnvelope.salutation === 'Dear Orchard Interactive Entertainment Hiring Team,'
        && acronymJob.company === acronymCompany,
      'a trailing parenthesized acronym is omitted only from the salutation, without changing the job company value used elsewhere');
      const legalSuffixCompany = 'Reddit, Inc.';
      const legalSuffixJob = { company: legalSuffixCompany };
      assert(authorCoverLetterEnvelope({ job: legalSuffixJob, evidence }).salutation === 'Dear Reddit Hiring Team,'
        && authorCoverLetterEnvelope({ job: { company: 'Orchard Labs LLC (OL)' }, evidence }).salutation === 'Dear Orchard Labs Hiring Team,'
        && authorCoverLetterEnvelope({ job: { company: 'The Walt Disney Company' }, evidence }).salutation === 'Dear The Walt Disney Company Hiring Team,'
        && legalSuffixJob.company === legalSuffixCompany,
      'a legal-entity suffix is omitted only from the salutation, while a spoken "Company" stays');
      const qualifiedEnvelope = authorCoverLetterEnvelope({ job: { company: 'Acme (Canada)' }, evidence });
      for (const company of ['Orchard - Scheduling Tools', 'Harbor — Logistics', 'Elm – Research']) {
        const job = { company };
        const letter = { ...authorCoverLetterEnvelope({ job, evidence }), paragraphs: ['I built reporting tools.'] };
        assert(letter.salutation === 'Dear Hiring Team,' && job.company === company,
          'a host-owned salutation uses a neutral greeting without rewriting a punctuated employer name');
        // Exercise the final document gate, not just the display helper: this
        // envelope previously consumed all five candidates' correction rounds.
        buildCoverLetterDocument({ letter });
      }
      assert(qualifiedEnvelope.salutation === 'Dear Acme (Canada) Hiring Team,',
        'a descriptive parenthetical qualifier is not mistaken for an acronym in the salutation');
      const numericQualifierEnvelope = authorCoverLetterEnvelope({ job: { company: 'Acme (2024)' }, evidence });
      assert(numericQualifierEnvelope.salutation === 'Dear Acme (2024) Hiring Team,',
        'a numeric parenthetical qualifier is not mistaken for an acronym in the salutation');
      assert(envelope.signatureTitle === '' && envelope.closing === 'Sincerely,', 'code-authored closing omits an implied target title');
      assert(envelope.date === 'August 2026', 'app-authored cover-letter dates use month and year only');
      assert(envelope.subtitleRole === 'Operations leader' && envelope.credential === 'B.S. Operations, Example University',
        'the authored envelope preserves the résumé header role and credential as structured letterhead fields');
      const contactNormalized = authorCoverLetterEnvelope({
        job: { company: 'Acme' }, evidence: { identity: { contact: [' Lakeview, ON ', '   ', '\n', 'maya@example.test'] } },
      });
      assert(JSON.stringify(contactNormalized.contact) === JSON.stringify(['Lakeview, ON', 'maya@example.test']),
        'envelope contact normalizes before filtering so whitespace-only entries cannot produce blank letterhead separators');
      const fallback = authorCoverLetterEnvelope({ job: {}, evidence: { identity: {} } });
      assert(fallback.recipient === '' && fallback.salutation === 'Dear Hiring Team,' && fallback.signatureTitle === '', 'missing company/title keeps a usable envelope without a recipient block');
      const proseChecks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['The role needs clear prioritization.', 'My triage experience demonstrates that mechanism.'], evidence, researchText: '' });
      assert(Array.isArray(proseChecks) && proseChecks.length === 52, 'prose helper returns every non-page deterministic check');
      assert(proseChecks.slice(9).map(check => check.id).join(',')
        === 'compound-hyphenation,parallel-structure,prior-employer-opening,named-artifact-introduction,opening-artifact-context,vague-domain-work-label,reference-clarity,modifier-attachment,migration-object-clarity,opening-posting-restatement,opening-job-summary-scaffolding,anchor-relevance,target-claim-scope,target-company-binding,detached-relevance-claim,prospective-contribution-tense,additive-seam,responsibility-transition,tool-calls-garden-path,low-information-tool-build,containerization-technology-roles,posting-reference,claimed-equivalence,dangling-paragraph-transition,sentence-length,punctuation-style,plain-register,introductory-workplace-comma,visual-reference-precision,direct-welcome-closing,opening-demonstrative,opening-employer-shorthand,adjacent-employer-repetition,entailed-premise,repeated-sentence-shape,repeated-phrase,candidate-agency,letter-proportion,repeated-transfer-carrier,dangling-demonstrative,ended-role-current-employment,transfer-carrier-budget,transfer-benefit-support',
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
        'Marrowgate builds dispatcher-facing screens on top of route services. Dispatch work crosses both sides in my experience. At Brackenfield Freight Company, I assembled an internal dispatch board with an Angular front end and one backend application, then containerized it for deployment across depot server configurations. I would apply this experience to features that cross Marrowgate’s screens and route services.',
        'On the interface side, my experience includes Angular and Sass interface work. At Brackenfield Freight Company, I restricted each yard coordinator’s dock-appointment screens to their own terminal, using Angular and Sass. I would use this experience to build robust screens across Marrowgate’s browsers and devices.',
        'On the backend side, my background includes Java APIs and shell automations. At Orrin Quay Surveying Partners, I wrote endpoints that gave controlled access to a regional bridge-sensor archive, plus shell automations that surfaced sensors missing scheduled readings. I would bring this experience to Marrowgate’s backend services, with attention to data quality.',
        'My engineering practice also includes rule-based release workflows. At Brackenfield Freight Company, I paired manual review with scripted checks so releases stayed fast, inexpensive, and dependable. I would apply this practice to Marrowgate’s use of automated code checks in development.',
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
        'I containerized an internal dispatch board so any depot server produced one stack.',
        'I restricted the depot invoicing system by staff role in Angular and Sass. That is the kind of problem I like.',
        'My shell automations surfaced sensors whose scheduled readings were missing.',
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
        'I containerized an internal dispatch board so any depot server produced one stack. That is the kind of problem I like.',
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
      // Measured on a live paste run. A generated letter was rejected
      // for four paragraphs closing on one shape. The repair rotated two
      // closings, cleared the check, and left the template where a reader
      // meets it first: every paragraph walked into its evidence with "As a
      // <role> at <employer>, my <noun> included". Reading one position
      // measured the position, not the letter, so every sentence is read now.
      const movedTemplate = [
        'This role combines dispatcher-facing screens with route services in the same implementation. Full-stack development across screens and services is familiar ground for me. As a Software Engineer at Brackenfield Freight Company, my full-stack work included an internal dispatch board whose screens used Angular. The board was packaged in containers for deployment across depot server configurations, and growth was planned for both the screens and the services. This experience would help with features that span screens and backend services in this role.',
        'On the interface side, my experience includes Angular and Sass interface work. As a Software Engineer at Brackenfield Freight Company, I restricted each yard coordinator’s dock-appointment screens to their own terminal, using Angular and Sass. I would use this Angular and Sass experience to build robust screens across browsers and devices in this role.',
        'On the backend side, my background includes Java APIs and shell automations. As a Survey Analyst at Orrin Quay Surveying Partners, my work included Java endpoints that gave controlled access to a regional bridge-sensor archive. Shell automations I maintained told inspectors when a sensor had not logged the readings scheduled for a visit. This Java and shell experience would support backend services in this role, with attention to data quality.',
        'Rule-based checking complements the cross-stack implementation this role requires. As a Software Engineer at Brackenfield Freight Company, my engineering practice included manual review and scripted release workflows. Those workflows kept releases fast, inexpensive, and dependable. I would apply this practice while developing screens and services with automated code checks in this role.',
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
        'As a Software Engineer at Brackenfield Freight Company, I restricted each yard coordinator’s dock-appointment screens to their own terminal, using Angular and Sass.',
        'Each yard coordinator’s dock-appointment screens, which I restricted to their own terminal at Brackenfield Freight Company, used Angular and Sass.');
      repaired[2] = repaired[2].replace(
        'On the backend side, my background includes Java APIs and shell automations.',
        'Java APIs and shell automations are where my background sits.');
      repaired[3] = repaired[3].replace(
        'As a Software Engineer at Brackenfield Freight Company, my engineering practice included manual review and scripted release workflows.',
        'My engineering practice at Brackenfield Freight Company included manual review and scripted release workflows.');
      const afterRepair = checkRepeatedSentenceShape(repaired);
      assert(afterRepair.passed,
        `rewriting exactly the number of sentences the message names clears the check in one round (detail=${afterRepair.detail})`);

      // The rule this one could collide with: a proof-bearing paragraph still
      // owes a claim span and a transfer span, and the repair must not have
      // bought its variety by dropping either. Measured on every paragraph,
      // before and after.
      const posting = 'Build robust screens across browsers and devices, and core backend services with Java and shell.';
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
    name: 'cover letter harness: a relevance span needs no stock phrase, no modal and no shared noun, only the words it shares with its quote, and a share of stop words alone does not count',
    run() {
      // Measured on a live paste run's third paragraph. The review contract used
      // to require the relevance span to carry a word of five letters or more
      // that the claim or the proof also carried, with an anaphora exception of
      // six fixed phrases. A strong writer was therefore forced into the same few
      // transfer sentences, and independent reviewers flagged them as formulaic
      // in every round. What the host reads now is the words the span shares
      // with the quote its paragraph cites, in whatever wording, and that the
      // span stands apart from the proof.
      const posting = 'Maintain scheduling services that run the core dispatch loop, with attention to latency and route accuracy.';
      const need = 'Maintain scheduling services that run the core dispatch loop, with attention to latency and route accuracy.';
      const claim = 'my background includes Java APIs and shell automations';
      const proof = 'I built endpoints for controlled access to a regional bridge-sensor archive';
      const grade = (relevance, paragraph) => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: { claim, proof, relevance, jobNeedQuote: need } }] },
        paragraphs: [paragraph], jobText: posting,
      });
      const frame = relevance => `On the backend side, ${claim}. As a survey analyst, ${proof} and implemented shell automations. ${relevance}.`;

      // The live paragraph the old rule rejected, which refers back with a
      // modifier inside the phrase and shares no counted word with its proof. It
      // names the need, so it is a relevance span now.
      const liveRelevance = 'That scheduling experience would support the scheduling services, with attention to route accuracy';
      const live = grade(liveRelevance, frame(liveRelevance));
      assert(live.passed, `a closing that names the quote's responsibility needs no shared noun and no bare back-reference: ${live.detail}`);

      // The same need in wording that has no modal, no back-reference and none of
      // the stock frames is accepted as well: the host asks for no phrase at all.
      for (const natural of [
        'Scheduling services with attention to latency and route accuracy are the core of this role',
        'The core dispatch loop this team runs depends on scheduling services that keep route accuracy in view',
        'Whoever maintains scheduling services here carries attention to latency and route accuracy every day',
      ]) {
        assert(!/\b(?:would|can|will|could)\b/iu.test(natural), `the fixture sentence uses no modal (${natural})`);
        const verdict = grade(natural, frame(natural));
        assert(verdict.passed, `natural wording naming the need passes: ${verdict.detail}`);
      }

      // The stop list, proved rather than asserted: a relevance that shares ONLY
      // words the content-word filter drops (“experience”, “role”, “team”) names
      // no responsibility of the quote, with the eligible terms listed.
      const stopWordRelevance = 'I would apply that experience to the role and the team';
      const stopWordOnly = grade(stopWordRelevance, frame(stopWordRelevance));
      assert(!stopWordOnly.passed && stopWordOnly.detail.includes('does not name a concrete responsibility from its jobNeedQuote')
        && stopWordOnly.detail.includes('"scheduling"') && stopWordOnly.detail.includes('this relevance currently matches none'),
      `"experience", "role" and "team" are filtered, so sharing them alone is not naming the need: ${stopWordOnly.detail}`);

      // A span that shares words with the PROOF and none with the quote is no
      // relevance statement, and the proof's own sentence cannot stand for it.
      const proofEcho = 'The endpoints gave controlled access to a regional bridge-sensor archive';
      const echoed = grade(proofEcho, frame(proofEcho));
      assert(!echoed.passed && echoed.detail.includes('does not name a concrete responsibility from its jobNeedQuote'),
        `words shared with the proof alone name no responsibility: ${echoed.detail}`);

      // Nothing about adjacency matters any more: a sentence between the proof
      // and the relevance changes nothing.
      const between = grade(liveRelevance, `On the backend side, ${claim}. As a survey analyst, ${proof} and implemented shell automations. The same work covered nightly exports. ${liveRelevance}.`);
      assert(between.passed, `an intervening sentence does not matter: ${between.detail}`);

      // The printed rules say what the code does.
      assert(!/shared word|never count as that shared word|anaphora/u.test(ARGUMENT_RELEVANCE_SPAN_RULE)
        && ARGUMENT_RELEVANCE_SPAN_RULE.includes('other than the sentence the proof span sits in')
        && ARGUMENT_RELEVANCE_SPAN_RULE.includes('no stock phrase, no would or can'),
      `the printed relevance rule asks for no phrase and no shared noun (rule=${ARGUMENT_RELEVANCE_SPAN_RULE})`);
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
      const posting = 'Harbourline Customs needs reliable systems delivery for the broker interface.';
      const jobNeedQuote = 'reliable systems delivery for the broker interface';
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
      // The generated letter that restates itself, and why it is the fixture:
      // LETTER_THAT_RESTATES_ITSELF above.
      const restated = LETTER_THAT_RESTATES_ITSELF;
      const reported = checkRepeatedPhrase(restated);
      assert(!reported.passed && reported.id === 'repeated-phrase',
        `the letter that restates itself is reported (detail=${reported.detail})`);
      // The reported complaint first: one noun phrase, stated twice, two
      // sentences apart. Then the two the same paragraph and the next one
      // carry. Each is named with the run and with both sentences that hold it.
      assert(reported.detail.includes('paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “checks across the deck and abutments”'),
        `the six-word run stated twice in one paragraph is named with both of its sentences (detail=${reported.detail})`);
      // The complaint was three occurrences, not two: the paragraph's transfer
      // sentence reached back for part of the same run on top of the re-naming
      // its own rules mandate. See the transfer-sentence test below for what is
      // blanked there and what is not.
      assert(reported.detail.includes('paragraph 1 sentence 2, paragraph 1 sentence 3 and paragraph 1 sentence 5 repeat one run of 3 words, “deck and abutments”'),
        `the third occurrence, inside the transfer sentence, is named with the two it echoes (detail=${reported.detail})`);
      assert(reported.detail.includes('paragraph 2 sentence 1 and paragraph 2 sentence 2 repeat one run of 3 words, “strain gauge logs”'),
        `a three-word run repeated inside one paragraph is reported (detail=${reported.detail})`);
      assert(reported.detail.includes('paragraph 1 sentence 4 and paragraph 2 sentence 3 repeat one run of 4 words, “the design challenge was”'),
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
        'The dispatch office ran three systems that never spoke to each other. I rebuilt the gate workflow at the dispatch office so a tag scan updated the trailer record directly.',
        'Reporting was the other problem, and moving it was the harder half.',
        'I welcome a conversation about either.',
      ];
      const acrossTwo = [
        'The dispatch office ran three systems that never spoke to each other.',
        'I rebuilt the gate workflow at the dispatch office so a tag scan updated the trailer record directly.',
        'I welcome a conversation about either.',
      ];
      assert(!checkRepeatedPhrase(withinOne).passed && checkRepeatedPhrase(acrossTwo).passed,
        `a ${MIN_SAME_PARAGRAPH_REPEAT_WORDS}-word run is a repeat inside one paragraph and is not one across two`
        + ` (within=${checkRepeatedPhrase(withinOne).detail}; across=${checkRepeatedPhrase(acrossTwo).detail})`);

      // A name is supposed to recur, and how often it may is already
      // checkPriorEmployerOpening's and checkAdjacentEmployerRepetition's
      // business. Measured against the twin above rather than argued: the two
      // letters differ only in whether the three words are a proper name.
      const named = withinOne.map(paragraph => paragraph.replaceAll('the dispatch office', 'Brackenfield Freight Company'));
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
      // evidence on one frame, "In that role, my survey experience
      // includes" and "In that Field Engineer role, my rating experience
      // spans", and two of four is exactly the ceiling, so the count said
      // nothing. The ceiling was built to permit deliberate parallelism; what a
      // reader registers as one template filled twice is consecutive.
      const template = [
        'Inspection work joins the field survey with the calculations behind it.',
        'In that role, my survey experience includes linked instruments and reading-triggered alerts. I developed the gauge-logging kit that drove a physical strain reader.',
        'In that Field Engineer role, my rating experience spans bearing seats, joints and photographs. I moved the paper sheets and their maintenance history onto a shared condition register.',
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
        'In that Field Engineer role, my rating experience spans bearing seats, joints and photographs.',
        'Rating was the other half of that Field Engineer role, and it spanned bearing seats, joints and photographs.');
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
      // the real repeats in the restating letter carry two and three. So the
      // line sits at MIN_REPEAT_CONTENT_WORDS content words, and one word of the
      // same run is the entire distance between excused and reported.
      const twin = [...ORDINARY_SYNTAX_REPEATED_PROSE];
      twin[0] = twin[0].replace('Then I worked on the ledger,', 'Then I worked on the weighbridge ledger,');
      const twinReported = checkRepeatedPhrase(twin);
      assert(!twinReported.passed && twinReported.detail.includes('“i worked on the weighbridge”'),
        `one content word added to an excused run makes that run a repeat (detail=${twinReported.detail})`);

      // And the contract prints the exclusion from the same constant, or a
      // writer over-corrects around a rule that never reached the sentence.
      assert(REPEATED_PHRASE_RULE.includes(`fewer than ${MIN_REPEAT_CONTENT_WORDS} content words`),
        `the printed rule states the content-word exclusion from the check's own floor (rule=${REPEATED_PHRASE_RULE})`);
      return { excused: ORDINARY_SYNTAX_REPEATED_RUNS.length, twinRun: 'i worked on the weighbridge' };
    },
  },
  {
    name: 'cover letter harness: the syntax exclusion leaves every defect measured on the restating letter reported',
    run() {
      // What the exclusion cost, paid on the letter that produced both checks.
      // Four defects were real in it, three runs and one shape, and an exclusion
      // that reached any of them would have bought its silence with the
      // rejection the user asked for in the first place.
      const repeats = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF);
      const shape = checkRepeatedSentenceShape(LETTER_THAT_RESTATES_ITSELF);
      const unreported = [
        ['the six-word run stated twice inside paragraph 1', repeats,
          'paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “checks across the deck and abutments”'],
        ['the three-word run stated twice inside paragraph 2', repeats,
          'paragraph 2 sentence 1 and paragraph 2 sentence 2 repeat one run of 3 words, “strain gauge logs”'],
        ['the four-word run carried from paragraph 1 into paragraph 2', repeats,
          'paragraph 1 sentence 4 and paragraph 2 sentence 3 repeat one run of 4 words, “the design challenge was”'],
        ['the frame paragraphs 2 and 3 enter their evidence on', shape,
          'paragraph 2 sentence 1 and paragraph 3 sentence 2 carry the same sentence shape “in that * my *” in back-to-back paragraphs'],
      ].filter(([, check, printed]) => check.passed || !check.detail.includes(printed));
      assert(!unreported.length,
        `every real defect in that letter is still named: unreported=${JSON.stringify(unreported.map(([label]) => label))}`
        + ` (repeats=${repeats.detail}; shape=${shape.detail})`);
      // Each of the three runs carries at least the content the exclusion asks
      // for, which is why they survive it, and the shortest of them is the
      // measurement that put MIN_REPEAT_CONTENT_WORDS where it is: "the
      // design challenge was" is four words carrying exactly two.
      const shortest = 'the design challenge was'.split(' ')
        .filter(word => !['the', 'was'].includes(word)).length;
      assert(shortest === MIN_REPEAT_CONTENT_WORDS,
        `the thinnest real repeat sits exactly on the content floor (content=${shortest}, floor=${MIN_REPEAT_CONTENT_WORDS})`);
      return { runs: (repeats.detail.match(/repeat one run of/gu) || []).length, shortest };
    },
  },
  {
    name: 'cover letter harness: a stock transfer carrier is excused by its words and charged by its shape, and no rule requires it, so the repair is the writer\'s own wording',
    run() {
      // Read as one rule these two look like a contradiction, and the next
      // reader is the one likely to "fix" it: checkRepeatedPhrase blanks the
      // stock carrier out of its comparison while the adjacency branch of
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

      // Why the two answers differ: they read different levels. No rule requires
      // a transfer carrier, so the choice of one, and of the same shape in
      // neighbouring paragraphs, is the writer's, while its words are policed by
      // the budget and the form check and are not charged a second time as a
      // repeated phrase. Measured on the letter's own paragraphs: 2 and 3
      // transferred on two different shapes and the span gate accepts both, and
      // strip the carrier out of 3 and the gate still finds a legal relevance
      // span, because the paragraph says how its work bears on the target in
      // other words. The carrier is a habit, not a requirement.
      const [, withWould, withCan] = LETTER_THAT_RESTATES_ITSELF;
      const carrierless = withCan.replace(
        ' I can apply that register approach to sampling, reporting, and ongoing asset care.', '');
      const gapFields = paragraph => paragraphArgumentSpanGaps(paragraph).map(gap => gap.field);
      assert(carrierless !== withCan && !gapFields(withWould).includes('relevance') && !gapFields(withCan).includes('relevance')
        && !gapFields(carrierless).includes('relevance'),
      'the span gate takes either shape of the carrier and takes the paragraph without one'
        + ` (would=${JSON.stringify(gapFields(withWould))}, can=${JSON.stringify(gapFields(withCan))},`
        + ` stripped=${JSON.stringify(gapFields(carrierless))})`);
      assert(!ARGUMENT_RELEVANCE_SPAN_RULE.includes('I would apply') && !ARGUMENT_RELEVANCE_SPAN_RULE.includes('I can apply')
        && REPEATED_TRANSFER_CARRIER_RULE.includes('never required'),
      `neither printed rule enumerates a closed list of shapes (rule=${ARGUMENT_RELEVANCE_SPAN_RULE})`);

      // So the repair the shape report asks for is the writer's own: rotate one
      // of the two paragraphs onto another wording, and the carrier report is
      // gone with the paragraph's relevance span intact and its new carrier
      // still uncharged as words. The other frame those paragraphs share is a
      // different defect and stays reported, so this measures the one report
      // rather than the check's verdict.
      const rotated = [...LETTER_THAT_RESTATES_ITSELF];
      rotated[0] = rotated[0].replace('I would apply that checking approach', 'I can bring that checking approach');
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
      // of the comparison against its own paragraph, and a live letter is
      // what that cost. A reader counted three occurrences of one
      // phrase in paragraph 1; the check reported two, because the third sat in
      // the sentence the exemption blanked entirely.
      const repeats = checkRepeatedPhrase(LETTER_THAT_RESTATES_ITSELF);
      assert(!repeats.passed
        && repeats.detail.includes('paragraph 1 sentence 2, paragraph 1 sentence 3 and paragraph 1 sentence 5 repeat one run of 3 words, “deck and abutments”'),
      `the transfer sentence's own echo of its paragraph is reported (detail=${repeats.detail})`);
      // Both runs are named, because the two repairs differ: sentence 5 drops
      // three words it hung off a mandated phrase, sentences 2 and 3 share six.
      // A filter that dropped the shorter run for sitting inside the longer one
      // is what hid sentence 5 even once it was compared.
      assert(repeats.detail.includes('paragraph 1 sentence 2 and paragraph 1 sentence 3 repeat one run of 6 words, “checks across the deck and abutments”'),
        `the longer run the echo sits inside keeps its own two sentences (detail=${repeats.detail})`);
      // Nothing the rules dictate is charged: not the carrier, and not the
      // capability phrase the carrier hands over.
      for (const mandated of ['i would apply that', 'that checking approach']) {
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

      // The six back-reference phrases a stock frame may use in place of the
      // re-naming are excused too, read off one set of regexes rather than a
      // second list.
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
        + ' I rebuilt the system in Rails so a failed deploy rolled itself back.'
        + ' I would apply that rollback practice across the system in Rails to the deploy safety this role needs.';
      const anaphora = checkRepeatedPhrase([anaphoraSentences]);
      assert(anaphora.passed,
        `a permitted anaphoric back-reference is not a repeat of its own antecedent (detail=${anaphora.detail})`);
      const withoutCarrier = checkRepeatedPhrase([anaphoraSentences.replace('I would apply that rollback practice across', 'The rollback practice reached across')]);
      const unpermitted = checkRepeatedPhrase([anaphoraSentences.replaceAll('the system in Rails', 'the platform in Rails')]);
      assert(!withoutCarrier.passed && withoutCarrier.detail.includes('“the system in rails”')
        && !unpermitted.passed && unpermitted.detail.includes('“the platform in rails”'),
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
        thirdOccurrence: 'deck and abutments',
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
      // "strain gauge logs" repeat this check exists for, and the
      // letter contract already asks for the shortest unambiguous reference
      // after a first mention — so the wording is what changes, not the gate.
      const named = checkRepeatedPhrase([DESIGN_SYSTEM_ARTIFACT_PARAGRAPH]);
      assert(!named.passed && named.detail.includes('repeat one run of 4 words, “pallet intake and release”'),
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
      for (const disclosed of ['capability phrase that frame hands over', 'responsibility phrase it reaches',
        'job-need quote puts there', 'is counted like any other wording']) {
        assert(REPEATED_PHRASE_RULE.includes(disclosed),
          `the rule discloses “${disclosed}” (rule=${REPEATED_PHRASE_RULE})`);
      }
      return { namedRun: 'pallet intake and release' };
    },
  },
  {
    name: 'cover letter harness: direct-welcome-closing accepts the employer\'s own name and attributes the missing half',
    run: () => {
      // Ground truth for a 4-round rejection loop observed in one live
      // generation (one fingerprint on every round): each pair
      // below is identical except the FAIL sentence names the employer by
      // name — the shape every other rule in this app pushes a writer
      // toward — while the PASS sentence uses the generic "your" lexicon that
      // already worked. Each FAIL sentence must pass once companyName names
      // that employer, and must still fail with no companyName or with a
      // DIFFERENT one — proving the matcher accepts the employer's own name,
      // not any proper noun in the sentence.
      const companyTargetPairs = [
        {
          fail: 'I welcome a conversation about how my integration work could support Quillmart’s smart-store rollout.',
          pass: 'I welcome a conversation about how my integration work could support your smart-store rollout.',
        },
        {
          fail: 'I welcome a conversation about applying that adapter service experience to Quillmart’s inventory sync.',
          pass: 'I welcome a conversation about applying that adapter service experience to your inventory pipeline.',
        },
        {
          fail: 'I welcome a conversation about how the integration I built could support Quillmart stores.',
          pass: 'I welcome a conversation about how the integration I built could support the store platform.',
        },
      ];
      for (const { fail, pass } of companyTargetPairs) {
        const namedCompany = checkDirectWelcomeClosing([fail], 'Quillmart');
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

      // Legal-suffix stripping, and the parenthesized-acronym company-name shape
      // ("Nimbus Web Services (NWS)"), must not throw and must still
      // match — the full name, and its distinctive leading token.
      const suffixed = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Quillmart’s smart-store rollout.'],
        'Quillmart Inc.',
      );
      assert(suffixed.passed,
        `"Quillmart Inc." must strip its legal suffix so "Quillmart’s" still matches (detail=${suffixed.detail})`);
      let parenLeadingTokenThrew = false;
      let parenLeadingToken = { passed: false, detail: '' };
      try {
        parenLeadingToken = checkDirectWelcomeClosing(
          ['I welcome a conversation about how my integration work could support Nimbus’s smart-store rollout.'],
          'Nimbus Web Services (NWS)',
        );
      } catch {
        parenLeadingTokenThrew = true;
      }
      let parenFullNameThrew = false;
      let parenFullName = { passed: false, detail: '' };
      try {
        parenFullName = checkDirectWelcomeClosing(
          ['I welcome a conversation about how my integration work could support Nimbus Web Services (NWS)’s smart-store rollout.'],
          'Nimbus Web Services (NWS)',
        );
      } catch {
        parenFullNameThrew = true;
      }
      assert(!parenLeadingTokenThrew && parenLeadingToken.passed,
        `a parenthesized company name must not throw building its matcher, and its leading token must match (threw=${parenLeadingTokenThrew}, detail=${parenLeadingToken.detail})`);
      assert(!parenFullNameThrew && parenFullName.passed,
        `the full parenthesized company name must also match without throwing (threw=${parenFullNameThrew}, detail=${parenFullName.detail})`);

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
        ['I welcome a conversation about how my integration work could support the dispatch team.'],
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
        ['I welcome a conversation about how my integration work could support Quillmart’s smart-store rollout.'],
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
      // guarded only by length>=3 and a 3-word stopword set. "Best Harbor" ->
      // "Best" matched ordinary candidate-facing prose ("my best work"), so
      // the target half of the three-part closing requirement was falsely
      // satisfied without the sentence ever reaching the employer's side — a
      // false PASS on a check gating a paste handoff. This app's own job
      // board turns up real employers whose leading token is an ordinary
      // English word too (a bare common word used as a brand name).
      const genericBestProse = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support my best work.'],
        'Best Harbor',
      );
      assert(!genericBestProse.passed
        && genericBestProse.detail.includes('the sentence is missing its target half'),
      `lowercase "best" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Best Harbor" (detail=${genericBestProse.detail})`);

      // The full (suffix-stripped) company name keeps matching CASE-
      // INSENSITIVELY by design — only the leading-token alternative changed.
      const fullNameLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support best harbor’s checkout flow.'],
        'Best Harbor',
      );
      assert(fullNameLowercase.passed,
        `the full company name must still satisfy the target half case-insensitively (detail=${fullNameLowercase.detail})`);

      // The leading token still matches when a letter capitalizes it exactly
      // as the company spells it — the shape a letter naming the employer
      // actually writes ("Best's checkout flow", "Supply's ingestion
      // pipeline").
      const leadingTokenCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Best’s checkout flow.'],
        'Best Harbor',
      );
      assert(leadingTokenCapitalized.passed,
        `the capitalized leading token must still satisfy the target half (detail=${leadingTokenCapitalized.detail})`);

      // Full company name, capitalized as written, is unaffected either way.
      const fullNameCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Best Harbor’s checkout flow.'],
        'Best Harbor',
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
      // the SAME class of employer its own comment names (a bare common
      // word used as a brand name): a one-word company name fell
      // through to the multi-word branch's fullNamePattern, which is
      // case-INSENSITIVE by design (see fullNameLowercase above — that
      // case-insensitivity is deliberate for a two-word name like "Best
      // Harbor"). For a ONE-word name the "full name" and the "leading token"
      // are the identical string, so the case-insensitive treatment let
      // ordinary lowercase prose with no employer reference at all — "my own
      // drift of ideas" — satisfy the target half for companyName "Drift",
      // exactly the false PASS the leading-token fix exists to close, just on
      // the single-word half of its own measured list instead of the
      // multi-word half.
      const driftLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support my own drift of ideas.'],
        'Drift',
      );
      assert(!driftLowercase.passed
        && driftLowercase.detail.includes('the sentence is missing its target half'),
      `lowercase "drift" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Drift" (detail=${driftLowercase.detail})`);

      const supplyLowercase = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support the supply of my own services.'],
        'Supply',
      );
      assert(!supplyLowercase.passed
        && supplyLowercase.detail.includes('the sentence is missing its target half'),
      `lowercase "supply" inside ordinary candidate-facing prose must not satisfy the target half for companyName "Supply" (detail=${supplyLowercase.detail})`);

      // Capitalized exactly as the company spells it, the single-word name
      // still satisfies the target half — the shape a letter naming the
      // employer actually writes ("Drift's ingestion pipeline").
      const driftCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Drift’s ingestion pipeline.'],
        'Drift',
      );
      assert(driftCapitalized.passed,
        `the single-word company name capitalized as written must still satisfy the target half (detail=${driftCapitalized.detail})`);

      const supplyCapitalized = checkDirectWelcomeClosing(
        ['I welcome a conversation about how my integration work could support Supply’s ingestion pipeline.'],
        'Supply',
      );
      assert(supplyCapitalized.passed,
        `the single-word company name capitalized as written must still satisfy the target half (detail=${supplyCapitalized.detail})`);

      return {
        driftLowercase: driftLowercase.detail,
        supplyLowercase: supplyLowercase.detail,
        driftCapitalized: driftCapitalized.detail,
        supplyCapitalized: supplyCapitalized.detail,
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
          checkPriorEmployerOpening(['At Brackenfield Freight Company, I evaluated vendor products before company-wide adoption.'], ['Brackenfield Freight Company']),
          checkPriorEmployerOpening(['At Acme, I built the incident workflow.'], ['Acme'])],
        ['checkNamedArtifactIntroduction',
          checkNamedArtifactIntroduction(['SlateBoard addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'], ['SlateBoard']),
          checkNamedArtifactIntroduction(['RouteDesk addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'], ['RouteDesk'])],
        ['checkOpeningArtifactContext (leading project)',
          checkOpeningArtifactContext(['RouteDesk is my personal project, where hosted vision models process item photos and draft listings.'], ['RouteDesk']),
          checkOpeningArtifactContext(['SlateBoard is my personal project, where hosted vision models process item photos and draft listings.'], ['SlateBoard'])],
        ['checkOpeningArtifactContext (leading employer)',
          checkOpeningArtifactContext(['As a Software Engineer at Brackenfield Freight Company, I built a gate workflow that connected outside carrier portals.'], [], ['Brackenfield Freight Company']),
          checkOpeningArtifactContext(['As a Software Engineer at Acme, I built a gate workflow that connected outside carrier portals.'], [], ['Acme'])],
        ['checkOpeningEmployerShorthand',
          checkOpeningEmployerShorthand([
            'At Brackenfield Freight Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
            'The company chose that software because it was cheaper to keep running than the in-house systems.',
          ], ['Brackenfield Freight Company']),
          checkOpeningEmployerShorthand([
            'At Pinehurst Haulage Company, I retired the in-house invoicing and claims systems in favour of vendor-hosted software.',
            'The company chose that software because it was cheaper to keep running than the in-house systems.',
          ], ['Pinehurst Haulage Company'])],
        ['checkAdjacentEmployerRepetition',
          checkAdjacentEmployerRepetition([
            'In my software engineering role at Brackenfield Freight Company, I wrote a gate workflow that forwarded every tag scan to the right carrier portal.',
            'At Brackenfield Freight Company, I also assembled a dispatch board whose front end and back end were designed to take on further tools.',
          ], ['Brackenfield Freight Company']),
          checkAdjacentEmployerRepetition([
            'In my software engineering role at Acme, I wrote a gate workflow that forwarded every tag scan to the right carrier portal.',
            'At Acme, I also assembled a dispatch board whose front end and back end were designed to take on further tools.',
          ], ['Acme'])],
        ['checkContainerizationTechnologyRoles',
          checkContainerizationTechnologyRoles(['I containerized it with Podman, Traefik, and Puma so one image could be promoted from staging to production hosts.'], {
            bulletTexts: ['Containerized the intake portal with Podman, running the app under Puma behind Traefik.'],
          }),
          checkContainerizationTechnologyRoles(['I containerized it with Apptainer, Slurm, and Puma so one image could be promoted from staging to production hosts.'], {
            bulletTexts: ['Containerized the batch pipeline with Apptainer, scheduling each run through Slurm.'],
          })],
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
      // proof over with "That changeover experience would support ..." and
      // paragraph 3 with "That judgment would support ...": one carrier form,
      // back to back. checkRepeatedSentenceShape missed it because its
      // five-word frame differs in the fifth slot ("... and" against "... for").
      const embeddedAiLetter = [
        'Duskfield is growing its cold-chain network across regional depots, and safety, audit trails, and uptime stay central to that growth. I combine depot route planning with forecasting work. As a Software Engineer at Brackenfield Freight Company, I built an internal dispatch board that spans the screens and services, packaged so it could be deployed at a new depot within a day. I would apply that capability to dispatch features that watch temperature across the network.',
        'Linked structures are where my changeover experience sits, in surveying, photographing, and checking them in sequence. At Brackenfield Freight Company, I turned a stack of paper inspection sheets into one shared register, with sampling and cutover steps that kept it current. That changeover experience would support production sensor integrations, including alert routing and error handling.',
        "My release practice combines manual review with scripted checking, and I have written route validators, checklist templates, and handoff routing for it. That judgment would support the team's shared habits around release safety, quality, and cost. I welcome a conversation about how my checking practice could support Duskfield's shared engineering patterns.",
      ];
      assert(checkRepeatedSentenceShape(embeddedAiLetter).passed,
        'the premise: the sentence-shape check does not see this pair, which is why a second check reads the carrier');
      const reported = checkRepeatedTransferCarrier(embeddedAiLetter);
      assert(!reported.passed && reported.id === 'repeated-transfer-carrier'
        && reported.detail.includes('paragraphs 2 and 3 both carry the same transfer form “that * would <verb>”')
        && reported.detail.includes('paragraph 2 sentence 3, paragraph 3 sentence 2'),
      `the shipped pair is one form once the noun phrase and the verb are slots (detail=${reported.detail})`);
      // It names the operation, the offending form, and the form the OUTER
      // neighbour uses so a rotation cannot land on it; it hands over no verb,
      // and it asks for the writer's own wording rather than another member of a list.
      const quoted = reported.detail.match(/“[^”]*”/g) || [];
      assert(quoted.join(' ') === '“that * would <verb>” “i would <verb>”'
        && reported.detail.includes('in your own wording, since no stock transfer form is required')
        && reported.detail.includes('“i would <verb>” (paragraph 1 uses it) would be the same defect again'),
      `the message quotes the offending form and the neighbour's form only (quoted=${JSON.stringify(quoted)})`);
      assert(!/the argument rule accepts|a different transfer form/u.test(reported.detail),
        `the message names no closed set of forms to move to (detail=${reported.detail})`);
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
        plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs, evidence: {}, jobText: '', researchText: '', companyName: 'Duskfield',
      });
      // It also carries a transfer form in all three paragraphs, which the carrier
      // budget (at most MAX_EXPLICIT_TRANSFER_PARAGRAPHS paragraphs) now reports.
      assert(battery(embeddedAiLetter).filter(check => !check.passed).map(check => check.id).join(',')
        === 'repeated-transfer-carrier,dangling-demonstrative,transfer-carrier-budget',
      'the shipped letter fails both carrier checks and the budget that reads its three transfers, and nothing else');
      assert(checkDanglingDemonstrative([embeddedAiLetter[0]]).passed && !checkDanglingDemonstrative([embeddedAiLetter[2]]).passed,
        'paragraph 1 is not reported by the demonstrative check, and paragraph 3 is');
      // Rotating the form, the repair this pair's report asks for on its own,
      // clears both carrier checks and leaves the letter over its transfer budget.
      const rotated = [
        embeddedAiLetter[0],
        embeddedAiLetter[1],
        embeddedAiLetter[2].replace("That judgment would support the team's shared habits", "I can bring that practice to the team's shared habits"),
      ];
      assert(battery(rotated).filter(check => !check.passed).map(check => check.id).join(',') === 'transfer-carrier-budget',
        `rotating the form clears the pair and the demonstrative, and the three transfers remain (failed=${battery(rotated).filter(check => !check.passed).map(check => check.id)})`);
      // The repair, in one round: paragraphs 2 and 3 end on what their work did
      // instead of on a second and a third transfer, so only the first paragraph
      // carries a stock frame (the budget is one) and the pair is gone.
      const repaired = [
        embeddedAiLetter[0],
        embeddedAiLetter[1].replace(' That changeover experience would support production sensor integrations, including alert routing and error handling.', ''),
        embeddedAiLetter[2].replace(" That judgment would support the team's shared habits around release safety, quality, and cost.", ''),
      ];
      assert(repaired[1] !== embeddedAiLetter[1] && repaired[2] !== embeddedAiLetter[2] && battery(repaired).every(check => check.passed),
        `the minimal repair clears the whole battery (failed=${battery(repaired).filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`).join(' | ')})`);
      assert(battery(repaired).length === 52, 'the repaired letter is graded by every check, not by a shortened battery');
      // Swapping only the verb or only the noun of the shipped sentence is not a rotation.
      const verbOnly = [embeddedAiLetter[0], embeddedAiLetter[1], embeddedAiLetter[2].replace('That judgment would support', 'That practice would help')];
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
        && beyond.detail.includes('and “i would <verb>” (paragraph 1 uses it) or “that * would <verb>” (paragraph 4 uses it) would be the same defect again'),
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
        'a stock transfer frame is never required',
        'reaching for one form again in the very next paragraph is a choice, because no rule requires a carrier at all',
        'the repair is your own wording in one of the two paragraphs, not a different stock form',
      ]) {
        assert(REPEATED_TRANSFER_CARRIER_RULE.includes(clause), `the printed rule states “${clause}” (rule=${REPEATED_TRANSFER_CARRIER_RULE})`);
      }
      return { reported: reported.detail.length };
    },
  },
  {
    name: 'cover letter harness: a demonstrative transfer carrier must find its capability noun earlier in its paragraph, and nothing else is judged',
    run: () => {
      const paragraph3 = "My release practice combines manual review with scripted checking, and I have written route validators, checklist templates, and handoff routing for it. That judgment would support the team's shared habits around release safety, quality, and cost. I welcome a conversation about how my checking practice could support Duskfield's shared engineering patterns.";
      const reported = checkDanglingDemonstrative(['I built the dispatch board.', paragraph3]);
      assert(!reported.passed && reported.id === 'dangling-demonstrative'
        && reported.detail.includes('paragraph 2 sentence 2 carries “That judgment would support”')
        && reported.detail.includes('no earlier sentence of paragraph 2 mentions “judgment”'),
      `the shipped sentence has no referent: its paragraph is about a practice (detail=${reported.detail})`);
      // The message names the operation, and the two repairs it offers are the two
      // that keep the other rules satisfied: never a noun outside the cue, and
      // never "name the thing in full", which repeats a phrase.
      assert(reported.detail.includes('put a word an earlier sentence of this paragraph uses for that capability directly before the noun, or use one of the back-references that name experience, work or patterns and need no earlier mention'),
        'the message names the operation');
      assert(!reported.detail.includes('in full') && !reported.detail.includes('replace that noun'),
        'the message never asks for a replacement noun or for the thing to be named in full');
      const quoted = reported.detail.match(/“[^”]*”/g) || [];
      assert(quoted.join(' ') === '“That judgment would support” “judgment”', `the message quotes the carrier and the noun (quoted=${JSON.stringify(quoted)})`);
      // The repairs it offers clear it, and keep the carrier a carrier.
      const mapped = text => checkParagraphArgumentLinks({
        plan: { paragraphs: [{ argumentMapping: {
          claim: 'My release practice combines manual review with scripted checking',
          proof: 'I wrote checklist templates that sent every handoff to its reviewer',
          relevance: text,
          jobNeedQuote: 'reusable team practices for release safety',
        } }] },
        paragraphs: [`My release practice combines manual review with scripted checking. I wrote checklist templates that sent every handoff to its reviewer. ${text}`],
        jobText: 'The role builds reusable team practices for release safety across the engineering group.',
      });
      for (const [label, replacement] of [
        ['a word the paragraph uses before the noun', 'That release judgment would support reusable team practices for release safety.'],
        ['the paragraph\'s own noun', 'That practice would support reusable team practices for release safety.'],
        ['a permitted back-reference', 'That experience would support reusable team practices for release safety.'],
      ]) {
        assert(checkDanglingDemonstrative([`My release practice combines manual review with scripted checking. I wrote checklist templates that sent every handoff to its reviewer. ${replacement}`]).passed,
          `${label} clears the check`);
        assert(mapped(replacement).passed, `${label} stays a legal relevance span (detail=${mapped(replacement).detail})`);
      }
      assert(checkRepeatedPhrase([`My release practice combines manual review with scripted checking. I wrote checklist templates that sent every handoff to its reviewer. That release judgment would support reusable team practices for release safety.`]).passed,
        'the word borrowed from the paragraph does not trip the repeated-phrase check');

      const body = 'I retired the in-house invoicing systems for vendor-hosted software at Acme.';
      const read = sentence => checkDanglingDemonstrative([`${body} ${sentence}`]);
      // Positives: a carrier whose capability noun, and whose modifiers, no earlier sentence used.
      for (const [label, sentence, noun] of [
        ['subject shape, abstract quality', 'That judgment would support reusable practices.', 'judgment'],
        ['subject shape, another noun', 'That capability would enable faster releases.', 'capability'],
        ['plural noun', 'Those capabilities would help a small team.', 'capabilities'],
        ['an approach', 'This approach would help a small team.', 'approach'],
        ['modifiers that are not earlier either', 'That scripted checking practice would support reusable standards.', 'practice'],
      ]) {
        const found = read(sentence);
        assert(!found.passed && found.detail.includes(`“${noun}”`), `${label}: reported (detail=${found.detail})`);
      }
      // A function word before the noun is not a word the paragraph "used".
      assert(!checkDanglingDemonstrative(['I did very careful work on the cutover. That very approach would help a small team.']).passed,
        'a function word between the determiner and the noun does not excuse the carrier');
      // The object shape is not read: it sits right after the proof it transfers, so its
      // noun summarizes that action (the shipped paragraph 1 measured this way).
      for (const sentence of ['I would apply that capability to faster releases.', 'I can bring this approach to faster releases.',
        'To apply that judgment to reviews, I would start small.', 'I would use that practice for weekly delivery.']) {
        assert(read(sentence).passed, `an object-position carrier is out of scope: ${sentence}`);
      }
      // Negatives: the noun, a stem of it, or a modifier appears earlier.
      for (const [label, sentences] of [
        ['the noun appears earlier', 'My changeover practice starts from the records. That practice would support reusable standards.'],
        ['the plural of the noun appears earlier', 'I documented the capabilities of each platform. That capability would help a small team.'],
        ['the singular of the noun appears earlier', 'I documented each platform capability. Those capabilities would help a small team.'],
        ['a modifier appears earlier', 'I ran the depot cutover myself. That depot cutover practice would support reusable standards.'],
        ['a stemmed modifier appears earlier', 'I ran the changeovers myself. That changeover practice would support reusable standards.'],
        ['a hyphenated modifier part appears earlier', 'I built a gate workflow for staff. That gate-triggered practice would support reusable standards.'],
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
        'That integration experience would support production work.', 'That company-wide rollout work would support production work.',
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
        ['I wrote the nightly load jobs that feed the warehouse.', 'This new pipeline replaced three spreadsheets.'],
        ['I moved the claims records into a new platform.', 'That difficulty lay mostly in reconciling the duplicate records between platforms.'],
        ['I moved the claims records into a new platform.', 'That judgment guided how I sequenced the cutover.'],
        ['I ran the changeover.', 'That means I can move between UI and backend work.'],
        ['I ran the changeover.', 'That said, I kept the rollout small.'],
        ['I ran the changeover.', 'This role needs steady delivery.'],
        ['I ran the changeover.', 'That would help a small team.'],
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
      assert(checkOpeningDemonstrative(['I ran the changeover.', 'That would support reusable practices.']).passed,
        'a demonstrative followed by a modal is a pronoun and has no noun to hunt for');
      assert(checkOpeningDemonstrative(['I ran the changeover.', "That couldn't wait for the quarter."]).passed,
        'a contracted auxiliary is not a noun either');
      return { reported: reported.detail.length };
    },
  },
  {
    name: 'cover letter harness: appended checks remain reportable prose checks',
    run: () => {
      const checks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['I built it.', 'It ran.'], evidence: {}, jobText: '', researchText: '' });
      assert(checks.slice(-5).map(check => check.id).join(',') === 'repeated-transfer-carrier,dangling-demonstrative,ended-role-current-employment,transfer-carrier-budget,transfer-benefit-support',
        'the appended checks are last in the battery, so the established order is unmoved');
      assert(checks.slice(-5).every(check => check.passed && typeof check.detail === 'string' && check.detail.length > 0),
        'each returns the result(id, passed, detail) contract with a detail on a pass');
      return { ids: checks.slice(-5).map(check => check.id) };
    },
  },
];
