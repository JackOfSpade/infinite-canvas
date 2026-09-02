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
  checkDirectWelcomeClosing,
  checkEligibilityNeedDisposition,
  checkEvidenceGrounding,
  checkExperienceInfinitiveGrammar,
  checkFigureDiscipline,
  checkGenericPhrases,
  checkIntroductoryWorkplaceComma,
  checkLegalStatus,
  checkLogisticsContainment,
  checkLogisticsExclusion,
  checkLogisticsGrounding,
  checkLogisticsLegalStatus,
  checkLowInformationToolBuild,
  checkModifierAttachment,
  checkNamedArtifactIntroduction,
  checkNeedGrounding,
  checkNeedsPortfolio,
  checkOpeningDemonstrative,
  checkParallelStructure,
  checkPlainRegister,
  checkPlanGate,
  checkPostingReference,
  checkPriorEmployerOpening,
  checkPunctuationStyle,
  checkRedundancy,
  checkResumeBulletFocus,
  checkReferenceClarity,
  checkResponsibilityTransition,
  checkSalientPhraseEcho,
  checkRequestedWorkSampleLink,
  checkRoleThesis,
  checkSentenceLength,
  checkShape,
  checkToolCallsGardenPath,
  checkTopNeedDisposition,
  checkVagueDomainWorkLabel,
  checkVisualReferencePrecision,
  COMPOUND_HYPHENATION_RULES,
  coverLetterCheckSummary,
  directArgumentContractObservation,
  evaluateCoverLetterChecks,
  extractResumeEvidence,
  fs,
  hasUsableCoverLetterParagraphs,
  MAX_HYPHENATION_OBSERVATIONS,
  MAX_LETTER_FIGURES,
  MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS,
  MAX_SENTENCE_WORDS,
  MIN_ANCHOR_RELEVANCE_CORPUS_WORDS,
  normalizeCoverLetterPlan,
  normalizeDirectLetterArgumentContract,
  path,
  renderResumeEvidenceForPrompt,
  selectBetterCoverLetterPlan,
  selectBetterLetterNeeds,
  sentences,
  STACK_TOOL_LEXICON,
} from '../test-dependencies.js';

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
    name: 'cover letter harness: plan normalization clears numeric and generic growth hooks without mutating the argument',
    run: () => {
      const base = {
        roleThesis: 'A grounded thesis.',
        mappings: [{ evidence: 'A grounded résumé line.' }],
        companyHook: {
          detail: 'GPT-5.6-Cyber', source: 'research',
          whyItMattersToCandidate: 'A relevant direction.',
        },
        logistics: 'Brooklyn, NY',
        droppedNeeds: [{ needIndex: 2, reason: 'Not evidenced.' }],
      };
      const normalized = normalizeCoverLetterPlan(base);
      assert(normalized !== base && normalized.companyHook.detail === ''
        && normalized.companyHook.source === '' && normalized.companyHook.whyItMattersToCandidate === '',
      'a digit-bearing research hook must be cleared in a new plan object');
      assert(base.companyHook.detail === 'GPT-5.6-Cyber'
        && normalized.mappings === base.mappings && normalized.logistics === base.logistics,
      'normalization must not mutate the model result or disturb mappings and logistics');
      const growth = normalizeCoverLetterPlan({ ...base, companyHook: { ...base.companyHook, detail: 'Annual Revenue Growth' } });
      assert(growth.companyHook.detail === '', 'generic finance/growth hooks must be cleared');
      const specific = { ...base, companyHook: { ...base.companyHook, detail: 'Platform Systems' } };
      assert(normalizeCoverLetterPlan(specific) === specific,
        'a nonnumeric proper-name hook remains available to prose unchanged');
      const unsafeRationale = normalizeCoverLetterPlan({
        ...specific,
        companyHook: { ...specific.companyHook, whyItMattersToCandidate: 'The program grew 50% last year.' },
      });
      assert(unsafeRationale.companyHook.detail === '' && unsafeRationale.companyHook.whyItMattersToCandidate === '',
        'numeric or growth wording in the rationale must not bypass hook normalization through a safe-looking detail');
      const wordOnlyGrowth = normalizeCoverLetterPlan({
        ...specific,
        companyHook: { ...specific.companyHook, whyItMattersToCandidate: 'The program grew quickly after launch.' },
      });
      assert(wordOnlyGrowth.companyHook.detail === '' && wordOnlyGrowth.companyHook.whyItMattersToCandidate === '',
        'word-only growth outcomes must not bypass hook normalization just because no figure is present');
      const safeRationale = { ...specific, companyHook: { ...specific.companyHook, whyItMattersToCandidate: 'Its incident focus makes the candidate’s triage direction concrete.' } };
      assert(normalizeCoverLetterPlan(safeRationale) === safeRationale,
        'a nonnumeric, non-growth rationale must retain the supported company hook');
      const mixedMappings = {
        ...specific,
        mappings: [
          { needIndex: 0, evidence: 'Triaged incomplete emergency reports under time pressure' },
          { needIndex: 2, evidence: 'Owned a lunar reactor program for seven colonies' },
        ],
        droppedNeeds: [],
      };
      const groundedOnly = normalizeCoverLetterPlan(mixedMappings, evidence);
      assert(groundedOnly.mappings.length === 1 && groundedOnly.mappings[0].needIndex === 0,
        'only mappings grounded in the final fitted résumé may reach prose');
      assert(groundedOnly.droppedNeeds.some(item => item.needIndex === 2
        && item.reason.includes('did not match the final fitted résumé')),
      'an ungrounded mapping becomes an observation-backed dropped need');
      assert(mixedMappings.mappings.length === 2 && mixedMappings.droppedNeeds.length === 0,
        'mapping pruning must not mutate the model plan');
      return { numericCleared: true, growthCleared: true, rationaleProtected: true, wordOnlyGrowthProtected: true, properDetailKept: true, ungroundedMappingDropped: true };
    },
  },
  {
    name: 'cover letter harness: an initial prose response needs at least one usable paragraph',
    run: () => {
      assert(!hasUsableCoverLetterParagraphs(null)
        && !hasUsableCoverLetterParagraphs([])
        && !hasUsableCoverLetterParagraphs([' ', '\n']),
      'empty or whitespace-only prose is not a shippable cover-letter artifact');
      assert(hasUsableCoverLetterParagraphs(['A specific argument survives.']),
        'one non-empty paragraph is enough to preserve the artifact while shape checks handle quality');
      return { emptyRejected: true, usableAccepted: true };
    },
  },
  {
    name: 'cover letter harness: direct fallback contract stays grounded and non-rendered',
    run: () => {
      const valid = normalizeDirectLetterArgumentContract({
        roleThesis: 'Operational judgment under incomplete information is the capability this incident role needs.',
        primaryEvidence: 'Triaged incomplete emergency reports under time pressure',
        primaryRelationToThesis: 'The triage work demonstrates the judgment in the thesis.',
        secondaryNarrativeRole: 'foundation',
        secondaryEvidence: 'Reduced response backlog by 32% while coordinating field crews across six districts.',
        secondaryRelationToPrimary: 'This provides an operational foundation for the primary triage proof.',
      }, evidence);
      const ungrounded = normalizeDirectLetterArgumentContract({
        roleThesis: 'A plausible but unsupported thesis.',
        primaryEvidence: 'Owned an undocumented nationwide command center.',
        primaryRelationToThesis: 'It proves the thesis.',
        secondaryNarrativeRole: 'none', secondaryEvidence: '', secondaryRelationToPrimary: '',
      }, evidence);
      const document = buildResumeDocument({
        resumeMainHtml: '<main class="page">Résumé</main>',
        coverLetter: {
          ...authorCoverLetterEnvelope({ job: { company: 'Acme' }, evidence, today: 'August 14, 2026' }),
          paragraphs: ['The primary argument remains visible only in prose.'],
        },
      });
      assert(valid?.secondaryNarrativeRole === 'foundation' && ungrounded === null,
        'the host retains only résumé-grounded primary and optional secondary metadata for the fallback audit');
      assert(directArgumentContractObservation(valid) === ''
        && directArgumentContractObservation(ungrounded).includes('missing or not grounded'),
      'an invalid direct fallback contract becomes a revision and human-review observation rather than silently weakening the audit');
      assert(!document.includes('primaryRelationToThesis') && !document.includes('secondaryRelationToPrimary')
        && !document.includes('Operational judgment under incomplete information is the capability this incident role needs.'),
      'fallback argument metadata is never passed into or rendered by the cover-letter document');
      return { grounded: !!valid, ungroundedRejected: ungrounded === null, rendered: false };
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
      const prompt = renderResumeEvidenceForPrompt(extracted);
      assert(prompt.includes('Anya R. Castellanos') && prompt.includes('achievement ids: sample-receipt')
        && !/<(?:main|article|strong)\b/i.test(prompt),
      'prompt rendering must be deterministic plain text with no HTML structure');
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
      const prompt = renderResumeEvidenceForPrompt(extracted);
      assert(prompt.includes('achievement ids: span-id, em-id, strong-id'),
        'tag-neutral receipt IDs must remain available to downstream cover-letter grounding');
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
        'I evaluated each product from requesting quotes through presenting findings to management.',
        'I evaluated each product from the initial request for quotes through the presentation of findings.',
        'I requested quotes, assessed each product, and presented findings to management.',
      ]);
      assert(!faulty.passed && faulty.id === 'parallel-structure'
        && faulty.detail.includes('from the quote request through presenting')
        && !opaque.passed && opaque.detail.includes('run each from X through Y')
        && parallel.passed,
      'the runtime check rejects noun-to-gerund and opaque run-range defects while accepting parallel or explicit actions');

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
      const bridgedResponsibilityPivot = checkResponsibilityTransition([
        'The ticketing system I extended needed role-restricted access so staff saw only what their role allowed. Alongside that access-control work, I kept the district data consistent across its tools with Python integration jobs.',
        'That role also required me to assess software the district would adopt instead of build.',
      ]);
      assert(bridgedResponsibilityPivot.passed,
        `a supported access-control bridge and a role-responsibility opener avoid the opaque-transition constructions: ${bridgedResponsibilityPivot.detail}`);
      const evaluatedResponsibilityPivot = evaluateCoverLetterChecks({
        plan: { mappings: [{}], companyHook: { detail: '' } },
        paragraphs: ['Keeping the district data consistent across its tools was a separate challenge. I addressed it with Python integration jobs.'],
        evidence, researchText: '',
      }).find(check => check.id === 'responsibility-transition');
      assert(evaluatedResponsibilityPivot && !evaluatedResponsibilityPivot.passed,
        'the complete cover-letter evaluator enforces opaque responsibility-transition repairs, not only the direct helper');
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
        && equivalence.detail.includes('explain the shared mechanism (constraints, data flow, failure modes)'),
      'every asserted-equivalence formula is quoted and redirected to the arguable shared mechanism');
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
        && mismatchedRoles.detail.includes('Nginx is a web or application server, not a containerization tool')
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
        'That evaluation practice gives me a clear view of that approach’s downsides and trade-offs as well as its upsides. The way the district core-and-integrations work maps onto your brand-agnostic platform is the part I would bring first. I hold Canadian citizenship and am in possession of a valid driver licence.',
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
        'legal-status', 'opening-demonstrative'];
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
        && failed.get('legal-status').includes('paragraph 4 states citizenship (“Canadian citizenship”)')
        && failed.get('legal-status').includes('application form')
        && failed.get('opening-demonstrative').includes('paragraph 4 opens with')
        && failed.get('opening-demonstrative').includes('“evaluation”'),
      'each failure quotes the specific defective construction the one revision attempt has to repair');
      assert(checks.every(check => typeof check.id === 'string' && typeof check.passed === 'boolean' && typeof check.detail === 'string'),
        'the register checks keep the result(id, passed, detail) contract the audit line and revision prompt consume');
      const hostile = [checkCompoundHyphenation, checkAnchorRelevance, checkAdditiveSeam, checkPostingReference,
        checkClaimedEquivalence, checkSentenceLength, checkPunctuationStyle, checkPlainRegister,
        checkLegalStatus, checkOpeningDemonstrative]
        .map(check => check(['', null, undefined, 42, { toString: () => 'in house' }], null, undefined));
      assert(hostile.every(check => check && typeof check.passed === 'boolean' && typeof check.detail === 'string'),
        'a malformed or partially persisted paragraph array must yield a check result, never a thrown application-generation failure');
      return { failed: [...failed.keys()] };
    },
  },
  {
    name: 'cover letter harness: legal status is removal work and opening demonstratives must anchor in the previous paragraph',
    run: () => {
      const flagged = checkLegalStatus([
        'I am a Canadian citizen and hold a U.S. work permit.',
        'I am authorized to work in Canada and hold permanent residency there.',
        'I would not require visa sponsorship for this position.',
      ]);
      assert(!flagged.passed && flagged.id === 'legal-status'
        && flagged.detail.includes('paragraph 1 states citizenship (“Canadian citizen”)')
        && flagged.detail.includes('paragraph 2 states work authorization (“authorized to work”)')
        && flagged.detail.includes('paragraph 3 states visa status')
        && flagged.detail.includes('application form'),
      'every legal-status family member asks for deletion, never a rephrasing');
      const cleanLegal = checkLegalStatus([
        'The city runs a citizen feedback portal, and I built the intake queue behind it.',
        'I can relocate to Toronto in June and start within two weeks.',
      ]);
      assert(cleanLegal.passed, `common-noun “citizen” uses and plain logistics facts are not legal-status statements: ${cleanLegal.detail}`);
      const planLegal = checkLogisticsLegalStatus({ logistics: 'I am a Canadian citizen based in Toronto.' });
      assert(!planLegal.passed && planLegal.id === 'logistics-legal-status'
        && planLegal.detail.includes('plan logistics states citizenship'),
      'the plan-side twin catches the fact before prose exists');
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
      const legalGate = checkPlanGate({ ...groundedPlan, logistics: 'I am a Canadian citizen.' }, evidence, needs,
        'The role must manage incident escalation.', '', 'Logistics: I am a Canadian citizen.');
      assert(legalGate.shouldRetry && legalGate.checks.some(check => check.id === 'logistics-legal-status' && !check.passed),
        'citizenship in plan logistics must request the plan retry that removes it');
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
      return { flagged: flagged.detail, logistics: proseOnlyLogistics.detail, planGate: legalGate.checks.find(check => check.id === 'logistics-legal-status').detail, unanchored: unanchored.detail };
    },
  },
  {
    name: 'cover letter harness: known résumé projects receive a standalone first mention',
    run: () => {
      const abrupt = checkNamedArtifactIntroduction(
        ['AI-Chalkboard addressed a concrete interface gap because a screen assistant could describe a control but not indicate it.'],
        ['AI-Chalkboard'],
      );
      assert(!abrupt.passed && abrupt.detail.includes('first names AI-Chalkboard'),
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
      const firstPlan = { ...groundedPlan, mappings: [] };
      const retryPlan = { ...groundedPlan, mappings: [{ evidence: 'unrelated evidence', resumeStatus: 'stated' }] };
      const firstGate = checkPlanGate(firstPlan, evidence, needs, 'The role must manage incident escalation.', '');
      const retryGate = checkPlanGate(retryPlan, evidence, needs, 'The role must manage incident escalation.', '');
      assert(firstGate.shouldRetry && retryGate.shouldRetry, 'the selection exercise must represent two failed gate candidates');
      const selected = selectBetterCoverLetterPlan(
        firstPlan, firstGate,
        retryPlan, retryGate,
      );
      assert(selected.plan === firstPlan && selected.gate === firstGate && selected.selected === 'first',
        'a failed plan candidate must preserve the stronger completed plan while convergence continues');
      const leanPlan = { ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], evidence: 'Triaged incomplete emergency reports under time pressure' }] };
      const expandedPlan = {
        ...groundedPlan,
        mappings: [
          ...leanPlan.mappings,
          { ...groundedPlan.mappings[0], needIndex: 0, evidence: 'Reduced response backlog by 32% while coordinating field crews across six districts.' },
        ],
      };
      const equalGate = { checks: [{ passed: true }, { passed: true }] };
      const leanSelected = selectBetterCoverLetterPlan(leanPlan, equalGate, expandedPlan, equalGate);
      assert(leanSelected.plan === leanPlan && leanSelected.selected === 'first',
        'when plan gates are equal, the selector keeps minimum-sufficient evidence instead of rewarding another mapping');
      const sameCountLongerEvidence = {
        ...groundedPlan,
        mappings: [{
          ...groundedPlan.mappings[0],
          evidence: 'Reduced response backlog by 32% while coordinating field crews across six districts.',
        }],
      };
      const trueTie = selectBetterCoverLetterPlan(leanPlan, equalGate, sameCountLongerEvidence, equalGate);
      assert(trueTie.plan === leanPlan && trueTie.selected === 'first',
        'when gate quality and mapping count tie, evidence length does not bias selection away from the first completed plan');
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
      assert(Array.isArray(proseChecks) && proseChecks.length === 32, 'prose helper returns every non-page deterministic check');
      assert(proseChecks.slice(8).map(check => check.id).join(',')
        === 'compound-hyphenation,parallel-structure,prior-employer-opening,named-artifact-introduction,vague-domain-work-label,reference-clarity,modifier-attachment,anchor-relevance,additive-seam,responsibility-transition,tool-calls-garden-path,low-information-tool-build,containerization-technology-roles,posting-reference,claimed-equivalence,dangling-paragraph-transition,sentence-length,punctuation-style,plain-register,introductory-workplace-comma,visual-reference-precision,direct-welcome-closing,legal-status,opening-demonstrative',
      'the register and style checks are appended after the established seven, and all of them read paragraphs only');
      const emptyHookWithResearch = evaluateCoverLetterChecks({
        plan: { mappings: [{ evidence: 'Triaged incomplete emergency reports under time pressure.' }], companyHook: { detail: '' } },
        paragraphs: ['Careful prioritization under incomplete reports is the relevant mechanism.'],
        evidence,
        researchText: 'Northstar Dispatch supports Acme incident operations.',
        companyName: 'Acme',
      }).find(check => check.id === 'company-specificity');
      assert(emptyHookWithResearch?.passed && emptyHookWithResearch.detail.includes('intentionally omitted'),
        'available research must not force company padding after the plan intentionally leaves its hook empty');
      const checkNotice = coverLetterCheckSummary([
        { id: 'one', passed: false, detail: 'first factual observation' },
        { id: 'two', passed: false, detail: 'second factual observation' },
        { id: 'three', passed: false, detail: 'third factual observation' },
      ]);
      const workspace = buildResumeDocument({ resumeMainHtml: '<main class="page">Résumé</main>', coverLetterCheckSummary: checkNotice });
      assert(workspace.includes('Cover-letter review required: 3 unmet deterministic checks:')
        && workspace.includes('1 additional check omitted.')
        && workspace.includes('not a persuasive-quality score'),
      'the saved workspace must require review for failed deterministic checks without overstating their scope');
      const allPassNotice = coverLetterCheckSummary([{ id: 'shape', passed: true, detail: 'fits' }]);
      assert(allPassNotice.includes('deterministic checks passed') && allPassNotice.includes('not a persuasive-quality certification'),
        'an all-pass workspace must explicitly avoid treating mechanical checks as a persuasive-quality score');
      const requestedWorkSample = 'Please include a link to something you have built and shipped — a repo, a deployed app, or a demo — with your application.';
      const missingWorkSample = checkRequestedWorkSampleLink(requestedWorkSample, '<main><a href="mailto:maya@example.test">Email</a></main>');
      const linkedWorkSample = checkRequestedWorkSampleLink(requestedWorkSample, '<main><a href="https://example.test/demo">Demo</a></main>');
      const notRequested = checkRequestedWorkSampleLink('Build and ship internal tools.', '<main></main>');
      assert(!missingWorkSample.passed && missingWorkSample.id === 'work-sample-link'
        && linkedWorkSample.passed && notRequested.passed,
      'a posting-requested work-sample link must stay visible unless the résumé contains a clickable http(s) URL');
      const punctuationNotice = coverLetterCheckSummary([{ id: 'punctuation', passed: false, detail: 'already punctuated.' }]);
      assert(!punctuationNotice.includes('punctuated..'),
        'the bounded workspace notice must not append a second terminal period');
      return { validChecks: valid.checks.length, retryChecks: allStated.checks.length, sourcedLogistics: sourcedLogistics.detail, portfolio: betterPortfolio.selected, topNeed: topDisposition.detail, nonTopEligibility: nonTopEligibility.detail, proseChecks: proseChecks.length };
    },
  },
];
