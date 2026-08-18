import {
  assert,
  authorCoverLetterEnvelope,
  BANNED_GENERIC_PHRASES,
  BANNED_GENERIC_PATTERNS,
  buildResumeDocument,
  checkAllNeedDisposition,
  checkCompanySpecificity,
  checkEligibilityNeedDisposition,
  checkEvidenceGrounding,
  checkExperienceInfinitiveGrammar,
  checkFigureDiscipline,
  checkGenericPhrases,
  checkLogisticsContainment,
  checkLogisticsGrounding,
  checkNeedGrounding,
  checkNeedsPortfolio,
  checkPlanGate,
  checkRedundancy,
  checkRequestedWorkSampleLink,
  checkShape,
  checkTopNeedDisposition,
  coverLetterCheckSummary,
  evaluateCoverLetterChecks,
  expectedParagraphCount,
  extractResumeEvidence,
  fs,
  hasUsableCoverLetterParagraphs,
  MAX_LETTER_FIGURES,
  MAX_LETTER_WORDS,
  MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS,
  normalizeCoverLetterPlan,
  path,
  renderResumeEvidenceForPrompt,
  selectBetterCoverLetterPlan,
  selectBetterLetterNeeds,
} from '../test-dependencies.js';

function loadFixture(name) {
  const file = path.resolve('scripts/fixtures/cover-letter', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixtureBulletText(fixture) {
  return fixture.resumeMarkup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const evidence = {
  identity: { name: 'Maya Chen', tagline: 'Operations leader', contact: ['Toronto, ON', 'maya@example.test'] },
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
  mappings: [{
    needIndex: 0,
    evidence: 'Triaged incomplete emergency reports under time pressure',
    resumeStatus: 'implied',
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
    name: 'cover letter harness: final résumé evidence extractor preserves real design-system structure',
    run: () => {
      const source = fs.readFileSync(path.resolve('resume_design_system/resume.html'), 'utf8');
      const main = /<main\b[\s\S]*<\/main>/i.exec(source)?.[0] || '';
      const withReceipt = main.replace('<strong>', '<strong data-achievement-id="sample-receipt">');
      const extracted = extractResumeEvidence(withReceipt);
      assert(extracted.identity.name === 'Anya R. Castellanos'
        && extracted.identity.tagline.includes('distributed systems')
        && extracted.identity.contact.length === 5,
      'identity and every nested contact item must come from the résumé header');
      assert(extracted.roles.length === 3 && extracted.bulletTexts.length === 12
        && extracted.skills.length === 5 && extracted.education.length === 1,
      'real design-system role, bullet, skill, and education structures must be preserved');
      assert(extracted.bulletTexts.some(text => text.includes('trade-off:'))
        && extracted.achievementIds.includes('sample-receipt'),
      'annotation text and receipt ids must survive evidence extraction');
      assert(extracted.education[0].includes('2017 · Pittsburgh, PA'),
        'nested education metadata must not be truncated at the first inner paragraph');
      const prompt = renderResumeEvidenceForPrompt(extracted);
      assert(prompt.includes('Anya R. Castellanos') && prompt.includes('achievement ids: sample-receipt')
        && !/<(?:main|article|strong)\b/i.test(prompt),
      'prompt rendering must be deterministic plain text with no HTML structure');
      return { roles: extracted.roles.length, bullets: extracted.bulletTexts.length, skills: extracted.skills.length };
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
      return { pass: pass.detail, negativeControl: fail.detail };
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
    name: 'cover letter harness: generic phrases and banned openers are detected',
    run: () => {
      const pass = checkGenericPhrases(['The role needs careful escalation decisions when reports are incomplete.']);
      assert(pass.passed, `specific opener must pass: ${pass.detail}`);
      const phrase = BANNED_GENERIC_PHRASES[1];
      const fail = checkGenericPhrases([`I am excited to apply because I have a ${phrase}.`]);
      assert(!fail.passed, 'banned generic phrase or first-sentence opener must fail');
      const typographic = checkGenericPhrases(['I am excited to apply—because the role is important.']);
      assert(!typographic.passed, 'a typographic dash must not let a banned opener evade detection');
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
      return { pass: pass.detail, fail: fail.detail, typographic: typographic.detail, spacedHyphen: spacedHyphen.detail, hendrickOpener: hendrickOpener.detail, hendrickMapping: hendrickMapping.detail, allObservations: allObservations.detail, precise: precise.detail };
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
      const logistics = checks.find(check => check.id === 'logistics-containment');
      assert(!generic.passed && generic.detail.includes('paragraph 1 contains banned generic pattern “proven … track record”')
        && generic.detail.includes('paragraph 2 contains banned generic pattern “primary line of defense”')
        && !figures.passed && figures.detail.includes('“three-year”'),
      'the Hendrick regression must trigger both modifier-resistant generic and spelled-duration grounding checks');
      assert(!logistics.passed && logistics.detail.includes('round-the-clock coverage'),
        'Hendrick-style round-the-clock coverage cannot be inferred from an empty/named-shift-only logistics plan');
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
      const skipped = checkCompanySpecificity(['A focused argument.'], '', 'Acme');
      assert(skipped.passed && skipped.detail.includes('skipped'), 'unavailable research must skip rather than fail');
      return { pass: pass.detail, fail: fail.detail, multiWordCompanyOnly: multiWordCompanyOnly.detail, unicode: unicode.detail, skipped: skipped.detail };
    },
  },
  {
    name: 'cover letter harness: argument-derived shape enforces count and word budget',
    run: () => {
      assert(expectedParagraphCount({ mappings: [{}], companyHook: { detail: '' } }) === 2, 'one mapping without a hook yields thesis plus mapping');
      assert(expectedParagraphCount({ mappings: [{}], companyHook: { detail: 'Northstar Dispatch' } }) === 3, 'one mapping with hook yields three paragraphs');
      assert(expectedParagraphCount({ mappings: [{}, {}], companyHook: { detail: 'Northstar Dispatch' } }) === 4, 'two mappings with hook yields four paragraphs');
      const plan = { mappings: [{}], companyHook: { detail: 'Northstar Dispatch' } };
      const pass = checkShape(plan, ['Thesis sentence.', 'Mapping sentence.', 'Company hook sentence.']);
      assert(pass.passed, `matching plan shape must pass: ${pass.detail}`);
      const wrongCount = checkShape(plan, ['Thesis.', 'Mapping.']);
      assert(!wrongCount.passed, 'wrong paragraph count must fail');
      const tooLong = checkShape({ mappings: [], companyHook: { detail: '' } }, [Array(MAX_LETTER_WORDS + 2).fill('word').join(' ')]);
      assert(!tooLong.passed, 'word count over the named budget must fail');
      return { pass: pass.detail, wrongCount: wrongCount.detail, tooLong: tooLong.detail };
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
      return { pass: pass.detail, invented: invented.detail, tooMany: tooMany.detail, currencyMismatch: currencyMismatch.detail, signMismatch: signMismatch.detail, spelledDuration: spelledDuration.detail, malformed: malformed.detail, bounded: manyMissing.detail.length };
    },
  },
  {
    name: 'cover letter harness: plan candidate selection preserves the strongest pass and envelope remains builder-compatible',
    run: () => {
      const valid = checkPlanGate(groundedPlan, evidence, needs, 'The role must manage incident escalation.', '');
      assert(!valid.shouldRetry, 'a grounded non-stated mapping must clear the plan gate');
      const allStated = checkPlanGate({ ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], resumeStatus: 'stated' }] }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(allStated.shouldRetry && allStated.checks.some(check => check.id === 'plan-redundancy' && !check.passed), 'all stated mappings must request the one retry, not throw');
      const invalidNeedReference = checkPlanGate({ ...groundedPlan, mappings: [{ ...groundedPlan.mappings[0], needIndex: 9 }] }, evidence, needs, 'The role must manage incident escalation.', '');
      assert(invalidNeedReference.shouldRetry && invalidNeedReference.checks.some(check => check.id === 'plan-need-references' && !check.passed),
        'a plan mapping may not silently point outside the ranked needs list');
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
      assert(sourcedLogistics.passed && !inventedLogistics.passed && !scatteredShortLogistics.passed,
        'the career-data logistics lane permits stated shift availability but rejects Hendrick-style coverage inflation');
      assert(scatteredShortLogistics.detail.includes('contiguous source match'),
        'a short logistics phrase cannot pass by assembling scattered career-data words');
      const containedSchedule = checkLogisticsContainment(
        { logistics: 'Available for full-time, evening, overnight, and weekend shifts.' },
        ['I am available for full-time, evening, overnight, and weekend shifts.'],
      );
      const inflatedCoverage = checkLogisticsContainment(
        { logistics: 'Available for full-time, evening, overnight, and weekend shifts.' },
        ['I can provide continuous, round-the-clock coverage for the facility.'],
      );
      const containmentOverflow = checkLogisticsContainment(
        { logistics: '' },
        Array.from({ length: 20 }, () => 'I am available for full-time, evening, overnight, weekend, on-call, round-the-clock, 24/7 coverage and can relocate locally or commute.'),
      );
      assert(containedSchedule.passed && !inflatedCoverage.passed
        && inflatedCoverage.detail.includes('continuous coverage') && inflatedCoverage.detail.includes('round-the-clock coverage'),
      'prose may reuse named shift availability but cannot upgrade it to continuous coverage');
      assert(!containmentOverflow.passed && containmentOverflow.detail.includes('additional observation(s) omitted')
        && containmentOverflow.detail.length < 2400 && MAX_LOGISTICS_CONTAINMENT_OBSERVATIONS === 8,
      'logistics-containment detail remains bounded for hostile multi-paragraph output');
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
      const envelope = authorCoverLetterEnvelope({ job: { company: 'Acme', title: 'Incident Lead' }, evidence, today: 'August 14, 2026' });
      assert(envelope.recipient === 'Hiring Team\nAcme' && envelope.salutation === 'Dear Acme Hiring Team,', 'company envelope fields must be code-authored');
      assert(envelope.signatureTitle === '' && envelope.closing === 'Sincerely,', 'code-authored closing omits an implied target title');
      const contactNormalized = authorCoverLetterEnvelope({
        job: { company: 'Acme' }, evidence: { identity: { contact: [' Toronto, ON ', '   ', '\n', 'maya@example.test'] } },
      });
      assert(JSON.stringify(contactNormalized.contact) === JSON.stringify(['Toronto, ON', 'maya@example.test']),
        'envelope contact normalizes before filtering so whitespace-only entries cannot produce blank letterhead separators');
      const fallback = authorCoverLetterEnvelope({ job: {}, evidence: { identity: {} } });
      assert(fallback.recipient === 'Hiring Team' && fallback.salutation === 'Dear Hiring Team,' && fallback.signatureTitle === '', 'missing company/title keeps a usable envelope without adding a target title');
      const proseChecks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['The role needs clear prioritization.', 'My triage experience demonstrates that mechanism.'], evidence, researchText: '' });
      assert(Array.isArray(proseChecks) && proseChecks.length === 7, 'prose helper returns every non-page deterministic check');
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
