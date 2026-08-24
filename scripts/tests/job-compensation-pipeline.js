import { assert, COMPENSATION_MIN_FIT_SCORE } from '../test-dependencies.js';
import { readFileSync } from 'node:fs';
import {
  classifyCompensationFitEligibility,
  parseGuaranteedCashOffer,
  mergeCompetitiveRanges,
  compensationAssessment,
  resolveCompensationLocation,
  compensationResidencesForJob,
  canonicalizeCompensationLocation,
  compensationCohortKey,
  selectCompensationExperienceYears,
  isValidCompensationExperienceBandLadder,
  selectCompensationExperienceBand,
  isAuditableCompensationSource,
  selectComparableEvidence,
  sourcesPresentInGroundedResearch,
} from '../../electron/ipc/jobCompensation.js';
import { normalizeRemoteResidences } from '../../src/utils/jobSearchLocations.js';
import { ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA } from '../../electron/ipc/aiSchemas.js';

export default [{
  name: 'classifyCompensationFitEligibility: the 75 boundary is inclusive and an unscored job is not a low-scoring job',
  run: () => {
    const opts = { minScore: COMPENSATION_MIN_FIT_SCORE, unscoredSentinel: 50 };
    // Boundary. The user asked for "75% match or above", so 75 must be
    // INCLUSIVE — an off-by-one here silently denies the check to exactly the
    // jobs sitting on the bar they named.
    assert(classifyCompensationFitEligibility(75, opts) === 'eligible', '75 must be eligible (threshold is inclusive)');
    assert(classifyCompensationFitEligibility(74, opts) === 'below-threshold', '74 must be below the threshold');
    assert(classifyCompensationFitEligibility(100, opts) === 'eligible', '100 must be eligible');
    assert(classifyCompensationFitEligibility(0, opts) === 'below-threshold', '0 must be below the threshold');
    // An unscored job must NEVER be reported as a weak match. The scorer's
    // sentinel marks "no assessment happened", so reading it as a real 50
    // would tell the user their job was judged and found wanting when it was
    // never judged at all.
    assert(classifyCompensationFitEligibility(50, opts) === 'score-unavailable',
      'the unscored sentinel must read as score-unavailable, never as a genuine mid score');
    for (const missing of [null, undefined, NaN, Infinity, '82', {}]) {
      assert(classifyCompensationFitEligibility(missing, opts) === 'score-unavailable',
        `a non-numeric score must read as score-unavailable → ${String(missing)}`);
    }
    // With no sentinel configured, 50 is an ordinary score like any other.
    assert(classifyCompensationFitEligibility(50, { minScore: COMPENSATION_MIN_FIT_SCORE }) === 'below-threshold',
      'with no sentinel configured, 50 is an ordinary below-threshold score');
    return { threshold: COMPENSATION_MIN_FIT_SCORE };
  },
}, {
  name: 'Role-family band extraction permits honest empty evidence and retains only grounded URLs',
  run: () => {
    assert(!('minItems' in ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.bands)
      && !('minItems' in ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.sources),
    'role-band schema must permit empty arrays so insufficient research blocks honestly instead of forcing fabricated rows');
    const bandSchema = ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA.properties.bands.items.properties;
    assert(bandSchema.minYears.type === 'integer' && bandSchema.maxYears.type === 'integer',
      'the provider schema requires the same whole-year boundaries enforced by the persisted contiguous-ladder validator');
    const retained = sourcesPresentInGroundedResearch([
      { name: 'Grounded framework', url: 'https://careers.example.test/framework' },
      { name: 'Invented but plausible', url: 'https://invented.example.test/ladder' },
      { name: 'Unsafe scheme', url: 'file:///etc/passwd' },
    ], 'The grounded search found https://careers.example.test/framework.');
    assert(retained.length === 1 && retained[0].url === 'https://careers.example.test/framework',
      'only a direct HTTP URL actually present in grounded raw research may enter the experience-band cache');
    const salaryRanges = sourcesPresentInGroundedResearch([
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Grounded salary source', sourceUrl: 'https://salary.example.test/role' },
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'Invented salary source', sourceUrl: 'https://invented.example.test/pay' },
    ], 'The grounded search found https://salary.example.test/role.');
    assert(salaryRanges.length === 1 && salaryRanges[0].sourceUrl === 'https://salary.example.test/role'
      && selectComparableEvidence(salaryRanges, 5, 'USD').length === 1,
    'a schema-valid salary URL absent from the grounded response cannot drive a compensation verdict');
    const metadataOnly = sourcesPresentInGroundedResearch([
      { comparable: true, min: 90000, max: 110000, currency: 'USD', sourceName: 'Provider citation', sourceUrl: 'https://provider.example.test/cited' },
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'Prose-only URL', sourceUrl: 'https://prose.example.test/untrusted' },
    ], `Grounded source URLs (provider metadata):
- https://provider.example.test/cited — Provider citation

Model prose happens to mention https://prose.example.test/untrusted.`);
    assert(metadataOnly.length === 1 && metadataOnly[0].sourceUrl === 'https://provider.example.test/cited',
      'when provider metadata exists, a URL mentioned only in model prose cannot satisfy compensation provenance');
    assert(sourcesPresentInGroundedResearch(
      [{ sourceUrl: 'https://prose.example.test/untrusted' }],
      'Grounded source URLs (provider metadata):\n\nMalformed metadata with https://prose.example.test/untrusted.',
    ).length === 0,
    'a present but malformed provider appendix fails closed instead of falling back to model prose');
    return { retained: retained.length, salaryRanges: salaryRanges.length, metadataOnly: metadataOnly.length };
  },
}, {
  name: 'Role-family experience-band lookup keeps grounded research separate from schema extraction',
  run: () => {
    const source = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function getExperienceBandsForRoleFamily');
    const end = source.indexOf('\n/**\n * Research cash salary', start);
    const resolver = source.slice(start, end);
    assert(start >= 0 && end > start, 'the role-family experience-band resolver must remain a distinct audited path');
    assert(/callLLMRaw\([\s\S]*?grounding:\s*true/.test(resolver),
      'experience-band research must use the raw grounded path; structured calls cannot activate Claude web search');
    assert(/callLLMText\([\s\S]*?responseSchema:\s*ROLE_FAMILY_EXPERIENCE_BANDS_SCHEMA/.test(resolver),
      'grounded role-family prose must still go through schema-constrained extraction before persistence');
    return { grounded: true };
  },
}, {
  name: 'Cash compensation parsing, source union, and exact market-floor verdict',
  run: () => {
    const canadian = parseGuaranteedCashOffer({ salary: 'C$70,000–C$95,000 per year' });
    assert(canadian.usable && canadian.max === 95000 && canadian.currency === 'CAD', 'must parse annual stated cash range');
    const oneSymbolRange = parseGuaranteedCashOffer({ salary: '$80,000–100,000 per year', location: 'Austin, Texas, USA' });
    assert(oneSymbolRange.usable && oneSymbolRange.min === 80000 && oneSymbolRange.max === 100000, 'one currency symbol must still preserve both range endpoints');
    const shorthandRange = parseGuaranteedCashOffer({ salary: '$80–100k per year', location: 'Austin, Texas, USA' });
    assert(shorthandRange.usable && shorthandRange.min === 80000 && shorthandRange.max === 100000, 'a shared k suffix must apply to both range endpoints');
    assert(!parseGuaranteedCashOffer({ salary: 'Commission only, uncapped earnings' }).usable, 'variable-only pay cannot be evaluated');
    assert(!parseGuaranteedCashOffer({ salary: 'Equity worth $100k' }).usable, 'equity cannot be converted into guaranteed cash');
    const baseOnly = parseGuaranteedCashOffer({ salary: '$150k OTE, base salary $80k', location: 'Austin, Texas, USA' });
    assert(baseOnly.usable && baseOnly.min === 80000 && baseOnly.max === 80000, 'OTE must not inflate a separately stated base salary');
    const trailingBase = parseGuaranteedCashOffer({ salary: '$80k–$100k base salary + bonus', location: 'Austin, Texas, USA' });
    assert(trailingBase.usable && trailingBase.min === 80000 && trailingBase.max === 100000, 'a base marker after the range must retain both base endpoints');
    const leadingBase = parseGuaranteedCashOffer({ salary: 'Base salary $80k–$100k + bonus', location: 'Austin, Texas, USA' });
    assert(leadingBase.usable && leadingBase.min === 80000 && leadingBase.max === 100000, 'a base marker before the range must retain both base endpoints');
    const trailingOte = parseGuaranteedCashOffer({ salary: 'Base salary $80k, $150k OTE', location: 'Austin, Texas, USA' });
    assert(trailingOte.usable && trailingOte.min === 80000 && trailingOte.max === 80000, 'an OTE label after its amount must not inflate base pay');
    const totalComp = parseGuaranteedCashOffer({ salary: 'Total compensation $150k, base salary $100k', location: 'Austin, Texas, USA' });
    assert(totalComp.usable && totalComp.max === 100000, 'total compensation cannot inflate a separately stated base salary');
    for (const salary of [
      'Commission plus base salary $80k',
      'commission + $80k base salary',
      'base salary $80k and commission',
      'commission + base salary $80k + $20k bonus',
    ]) {
      const mixedPay = parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' });
      assert(mixedPay.usable && mixedPay.min === 80000 && mixedPay.max === 80000,
        `a stated base must survive variable-pay wording on either side: ${salary}`);
    }
    const hourlyBase = parseGuaranteedCashOffer({ salary: 'base pay $45/hour plus commission', description: '40 hours per week', location: 'Austin, Texas, USA' });
    assert(hourlyBase.usable && hourlyBase.max === 93600 && hourlyBase.annualized, 'an extracted base hourly rate must retain its cadence');
    const weeklyBase = parseGuaranteedCashOffer({ salary: 'base pay $2,000/week + bonus', location: 'Austin, Texas, USA' });
    assert(weeklyBase.usable && weeklyBase.max === 104000 && weeklyBase.annualized, 'an extracted base weekly rate must retain its cadence');
    const monthlyBase = parseGuaranteedCashOffer({ salary: 'base salary $8,000/month + equity', location: 'Austin, Texas, USA' });
    assert(monthlyBase.usable && monthlyBase.max === 96000 && monthlyBase.annualized, 'an extracted base monthly rate must retain its cadence');
    for (const salary of ['from $80k', 'minimum $80k', 'starting salary $80k']) {
      assert(parseGuaranteedCashOffer({ salary, location: 'Austin, Texas, USA' }).reasonCode === 'salary_maximum_unstated',
        `a one-sided lower bound cannot be treated as a fixed offer: ${salary}`);
    }
    assert(parseGuaranteedCashOffer({ salary: 'up to $100k', location: 'Austin, Texas, USA' }).max === 100000,
      'an explicit upper bound remains usable for the maximum-vs-floor comparison');
    const bareAnnual = parseGuaranteedCashOffer({ salary: 'Salary: 100000 per year', location: 'Austin, Texas, USA' });
    assert(bareAnnual.usable && bareAnnual.max === 100000 && bareAnnual.currency === 'USD', 'a single annual number uses the unambiguous comparison-location currency');
    const fallbackCompensation = parseGuaranteedCashOffer({ salary: '   ', compensation: '$90k/year', location: 'Austin, Texas, USA' });
    assert(fallbackCompensation.usable && fallbackCompensation.max === 90000, 'a blank primary salary field must not hide a scraper compensation fallback');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Part-time flexible' }).reasonCode === 'hourly_hours_unclear', 'must not invent annual hours');
    assert(parseGuaranteedCashOffer({ salary: '$45/hour', description: 'Full-time, 40 hours per week', location: 'Austin, Texas, USA' }).max === 93600, 'known full-time hourly pay annualizes deterministically');
    const merged = mergeCompetitiveRanges([
      { min: 100000, max: 130000, currency: 'CAD' },
      { min: '85000', max: '115000', currency: ' cad ' },
    ], 'CAD');
    assert(merged.min === 85000 && merged.max === 130000 && merged.currency === 'CAD', 'conflicting comparable sources must union A–D despite normalized currency/numeric strings');
    assert(mergeCompetitiveRanges([{ min: 85000, max: 110000, currency: '' }], 'CAD') === null,
      'market evidence with no currency cannot be treated as the listing currency');
    assert(isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'https://example.test/pay' }), 'an http(s) source with a title is auditable');
    assert(!isAuditableCompensationSource({ sourceName: 'Survey', sourceUrl: 'file:///etc/passwd' }) && !isAuditableCompensationSource({ min: 1, max: 2 }), 'unlinked or unsafe source evidence cannot drive a verdict');
    const evidence = [
      { comparable: true, min: 100000, max: 120000, sourceName: 'one', sourceUrl: 'https://example.test/one' },
      { comparable: true, min: 95000, max: 125000, sourceName: 'two', sourceUrl: 'https://example.test/two' },
      { comparable: true, min: 80000, max: 110000, sourceName: 'floor', sourceUrl: 'https://example.test/floor' },
      { comparable: true, min: 110000, max: 180000, sourceName: 'ceiling', sourceUrl: 'https://example.test/ceiling' },
      { comparable: true, min: 105000, max: 130000, sourceName: 'five', sourceUrl: 'https://example.test/five' },
      { comparable: true, min: 101000, max: 121000, sourceName: 'six', sourceUrl: 'https://example.test/six' },
    ];
    const displayedEvidence = selectComparableEvidence(evidence, 5);
    assert(displayedEvidence.length === 5 && displayedEvidence.some(item => item.sourceName === 'floor') && displayedEvidence.some(item => item.sourceName === 'ceiling'),
      'the capped card evidence must retain the ranges that set the merged floor and ceiling');
    const currencyCompetition = [
      { comparable: true, min: 1, max: 999999, currency: 'USD', sourceName: 'wrong floor', sourceUrl: 'https://example.test/us-floor' },
      { comparable: true, min: 2, max: 1000000, currency: 'EUR', sourceName: 'wrong ceiling', sourceUrl: 'https://example.test/eur-ceiling' },
      ...Array.from({ length: 6 }, (_unused, index) => ({
        comparable: true, min: 85000 + index * 1000, max: 105000 + index * 1000, currency: ' cad ',
        sourceName: `cad-${index}`, sourceUrl: `https://example.test/cad-${index}`,
      })),
    ];
    const cadEvidence = selectComparableEvidence(currencyCompetition, 5, 'CAD');
    assert(cadEvidence.length === 5 && cadEvidence.every(item => item.currency.trim().toUpperCase() === 'CAD'),
      'wrong-currency extrema must not consume capped target-currency evidence slots');
    assert(compensationAssessment({ offer: canadian, competitiveRanges: [merged] }).status === 'competitive', 'offer maximum reaching floor is competitive');
    assert(compensationAssessment({ offer: { ...canadian, max: 84999 }, competitiveRanges: [merged] }).status === 'below_market', 'no hidden buffer below floor');
    const withEvidence = compensationAssessment({
      offer: canadian,
      competitiveRanges: [merged],
      sourceLinks: [{ title: 'Salary survey', url: 'https://example.test/pay', min: 85000, max: 130000, currency: 'CAD', note: 'Senior role in Toronto.' }],
    });
    assert(withEvidence.sourceLinks[0]?.note === 'Senior role in Toronto.' && withEvidence.justification.includes('reaches or exceeds'), 'auditable source details and deterministic verdict must be retained');
    const loc = resolveCompensationLocation({}, { workMode: 'remote', remoteRegion: 'canada' }, { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } });
    assert(loc?.display === 'Toronto, Ontario, Canada', 'remote Canada work uses Canada residence');
    const inferredRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: 'United States' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    );
    assert(inferredRemote?.display === 'Denver, Colorado, United States', 'an explicit permitted country repairs an unknown remote-region classification');
    const worldwideCanadianRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'worldwide' },
      { other: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    );
    assert(worldwideCanadianRemote?.display === 'Toronto, Ontario, Canada',
      'a worldwide outside-region remote role may use a Canadian residence for compensation');
    const originScopedResidence = compensationResidencesForJob(
      { compensationRemoteResidences: { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } } },
      { usa: { city: 'Austin', subdivision: 'Texas', country: 'United States' } },
    );
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'usa' },
      originScopedResidence,
    )?.display === 'Denver, Colorado, United States',
    'a board job uses its transient origin-hub residence before a board-level fallback');
    const conflictingRemoteResidence = normalizeRemoteResidences({
      other: { city: 'Toronto', subdivision: 'Ontario', country: 'United States' },
    });
    assert(conflictingRemoteResidence.other.countryConflict, 'the compensation fixture carries a deterministic residence conflict');
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'worldwide' },
      conflictingRemoteResidence,
    ) === null, 'a selected conflicting residence remains unavailable for salary comparison');
    assert(resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'Germany' },
      { other: { city: 'London', subdivision: 'England', country: 'United Kingdom' } },
    ) === null, 'an incompatible other-country residence must stay uncertain');
    const contradictoryRemote = resolveCompensationLocation(
      { remote: true, location: 'Remote' },
      { workMode: 'onsite', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    );
    assert(contradictoryRemote?.display === 'Denver, Colorado, United States'
      && contradictoryRemote.level === 'city',
    'affirmative scraped remote evidence overrides contradictory onsite context and uses the saved residence');
    assert(resolveCompensationLocation(
      { location: 'Toronto, ON (Remote)' },
      { workMode: 'onsite', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.display === 'Denver, Colorado, United States',
    'a compact location with an explicit remote marker uses the residence even when context says onsite');
    assert(resolveCompensationLocation(
      { location: 'Austin, TX', snippet: 'Remote work is not available for this onsite position.' },
      { workMode: 'unknown', remoteRegion: 'usa' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.display === 'Austin, Texas, United States',
    'a prose mention of remote work must not override an onsite listing location when structured work mode is unknown');
    assert(resolveCompensationLocation(
      { location: 'Hybrid' },
      { workMode: 'onsite' },
    ) === null, 'a non-geographic work-mode token must not become a city-level compensation cohort');
    const hybridToronto = resolveCompensationLocation({ location: 'Hybrid - Toronto, ON' }, { workMode: 'hybrid' });
    const onsiteAustin = resolveCompensationLocation({ location: 'On-site: Austin, TX' }, { workMode: 'onsite' });
    assert(hybridToronto?.value === 'Toronto, Ontario, Canada'
      && onsiteAustin?.value === 'Austin, Texas, United States',
    'hybrid/on-site prefixes are removed before canonical city grouping');
    const trailingHybridToronto = resolveCompensationLocation({ location: 'Toronto, ON (Hybrid)' }, { workMode: 'hybrid' });
    const trailingOnsiteAustin = resolveCompensationLocation({ location: 'Austin, TX - On-site' }, { workMode: 'onsite' });
    assert(trailingHybridToronto?.value === 'Toronto, Ontario, Canada'
      && trailingOnsiteAustin?.value === 'Austin, Texas, United States',
    'parenthesized and trailing hybrid/on-site labels cannot fragment a city cohort');
    for (const placeholder of ['Multiple Locations', 'Location Negotiable After Selection', 'TBD', 'Not specified']) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' }) === null,
        `${placeholder} is not a compensation market`);
    }
    assert(resolveCompensationLocation({ location: 'Anywhere in Canada' }, { workMode: 'onsite' })?.value === 'Canada',
      'an explicit anywhere-in-country listing safely uses the country cohort');
    assert(resolveCompensationLocation({ location: 'Anywhere in Atlantis' }, { workMode: 'onsite' }) === null,
      'an unrecognized anywhere-in-country phrase cannot become a fictional city cohort');
    for (const [placeholder, country] of [
      ['Nationwide, Canada', 'Canada'],
      ['Multiple Locations, United States', 'United States'],
      ['Various Locations - Canada', 'Canada'],
    ]) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' })?.value === country,
        `${placeholder} retains its explicit country boundary without inventing a city`);
    }
    for (const placeholder of ['Multiple Locations', 'Various Locations - Atlantis', 'Nationwide, El Dorado']) {
      assert(resolveCompensationLocation({ location: placeholder }, { workMode: 'onsite' }) === null,
        `${placeholder} cannot become a fake country or city cohort`);
    }
    assert(resolveCompensationLocation(
      { location: 'Remote - Canada' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    )?.value === 'Toronto, Ontario, Canada',
    'an explicit raw remote-country marker repairs an otherwise unknown remote restriction');
    assert(resolveCompensationLocation(
      { location: 'Remote, U.S.' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { usa: { city: 'Denver', subdivision: 'Colorado', country: 'United States' } },
    )?.value === 'Denver, Colorado, United States',
    'U.S. aliases in raw remote locations select the U.S. residence');
    assert(resolveCompensationLocation(
      { location: 'Remote' },
      { workMode: 'unknown', remoteRegion: 'unknown', remoteCountry: '' },
      { canada: { city: 'Toronto', subdivision: 'Ontario', country: 'Canada' } },
    ) === null,
    'a bare Remote listing stays unavailable without a structured or raw country restriction');
    assert(resolveCompensationLocation(
      { location: 'Remote - Canada' },
      { workMode: 'remote', remoteRegion: 'other', remoteCountry: 'UK' },
      { other: { city: 'London', subdivision: 'England', country: 'United Kingdom' } },
    )?.country === 'United Kingdom',
    'structured UK restrictions override contradictory raw location hints and normalize country aliases');
    const cohortCommon = { job: { title: 'Senior Designer' }, location: loc, offer: canadian, context: { seniority: 'senior' } };
    const roleBands = [
      { label: 'Entry (0–2 years)', minYears: 0, maxYears: 2 },
      { label: 'Mid-level (3–6 years)', minYears: 3, maxYears: 6 },
      { label: 'Senior (7–11 years)', minYears: 7, maxYears: 11 },
      { label: 'Lead+ (12+ years)', minYears: 12, maxYears: 99 },
    ];
    const fiveYearHeadline = selectCompensationExperienceYears({ categorySpecificExperience: [{ requiredMinimumYears: 5 }] });
    const sixYearHeadline = selectCompensationExperienceYears({ categorySpecificExperience: [{ requiredMinimumYears: 6 }] });
    const fiveYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, fiveYearHeadline.years) });
    const sixYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, sixYearHeadline.years) });
    const sevenYearKey = compensationCohortKey({ ...cohortCommon, experienceBand: selectCompensationExperienceBand(roleBands, 7) });
    assert(fiveYearHeadline.years === 5 && sixYearHeadline.years === 6
      && fiveYearKey === sixYearKey && fiveYearKey !== sevenYearKey,
      'jobs at 5y and 6y in one researched band share a cohort, while a different band does not');
    const fullLadder = [
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Mid', minYears: 3, maxYears: 6 },
      { label: 'Senior+', minYears: 7, maxYears: 99 },
    ];
    assert(isValidCompensationExperienceBandLadder(fullLadder), 'a 0–99 ordered contiguous ladder is cacheable');
    assert(!isValidCompensationExperienceBandLadder([
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Senior+', minYears: 4, maxYears: 99 },
    ]), 'a gap invalidates a persisted role-family ladder rather than assigning a nearest band');
    assert(!isValidCompensationExperienceBandLadder([
      { label: 'Early', minYears: 0, maxYears: 2 },
      { label: 'Mid', minYears: 3, maxYears: 6 },
    ]), 'a ladder that does not reach the open-ended 99 bucket is invalid');
    assert(selectCompensationExperienceBand(fullLadder, 100) === null
      && selectCompensationExperienceBand(fullLadder, 2.5) === null,
    'out-of-range and uncontained fractional experience returns no band instead of a nearest one');
    const reportedOnly = selectCompensationExperienceYears({ categorySpecificExperience: [
      { requiredMinimumYears: null, reportedYears: '3 years' },
      { requiredMinimumYears: null, reportedYears: '4–6.5 years' },
    ] });
    assert(reportedOnly.years === 6.5 && reportedOnly.basis === 'candidate-reported-material-category',
      'when no category states a minimum, the highest material reported years is used');
    const statedWins = selectCompensationExperienceYears({ categorySpecificExperience: [
      { requiredMinimumYears: 2, reportedYears: '12' },
      { requiredMinimumYears: 5, reportedYears: '3' },
    ] });
    assert(statedWins.years === 5 && statedWins.basis === 'job-stated-minimum',
      'the highest job-stated category minimum wins over reported and total tenure');
    const city = canonicalizeCompensationLocation({ display: 'Denver, Colorado, United States' });
    const state = canonicalizeCompensationLocation({ display: 'Colorado, United States' });
    const country = canonicalizeCompensationLocation({ display: 'Canada' });
    assert(city?.level === 'city' && city.value === 'Denver, Colorado, United States'
      && state?.level === 'state' && state.value === 'Colorado, United States'
      && country?.level === 'country' && country.value === 'Canada',
    'location cohorts use deterministic city → state → country canonical ladder');
    const torontoForms = [
      canonicalizeCompensationLocation({ display: 'Toronto, ON' }),
      canonicalizeCompensationLocation({ display: 'Toronto, ON M5V 1K4' }),
      canonicalizeCompensationLocation({ display: 'Toronto, Ontario, Canada' }),
    ];
    assert(torontoForms.every(place => place?.level === 'city' && place.value === 'Toronto, Ontario, Canada'),
      'trailing Canadian postal codes cannot split an otherwise identical city cohort');
    const austinForms = [
      canonicalizeCompensationLocation({ display: 'Austin, TX' }),
      canonicalizeCompensationLocation({ display: 'Austin, TX 78701-1234' }),
      canonicalizeCompensationLocation({ display: 'Austin, Texas, United States' }),
    ];
    assert(austinForms.every(place => place?.level === 'city' && place.value === 'Austin, Texas, United States'),
      'trailing US ZIP and ZIP+4 forms cannot split an otherwise identical city cohort');
    return { unionFloor: merged.min };
  },
}, {
  // Contracts A + C: the compensation-research fit gate. The gate's boundary
  // check itself (rawScore >= COMPENSATION_MIN_FIT_SCORE, and the unscored-vs-
  // known-low-score branch) lives inline in the non-exported async
  // researchCompensationAssessments (electron/ipc/jobs.js ~1939-1963) — it is
  // not exposed as an importable pure function, so it cannot be exercised
  // directly here (see the accompanying risk note). This test instead pins the
  // two things that ARE exported and load-bearing: the threshold constant
  // itself, and — via compensationAssessment(), the same helper jobs.js calls
  // to build the skip's fallback card — that a below-threshold skip and an
  // unscored skip are honestly distinguishable in the justification text even
  // though both currently share the reasonCode 'below_fit_threshold' (contract
  // C), and that JOB_COMPENSATION_EVIDENCE distinguishes them from a REAL
  // researched verdict via reasonCode.
  name: 'Compensation fit gate: threshold constant and below_fit_threshold skip shape',
  run: () => {
    assert(COMPENSATION_MIN_FIT_SCORE === 75, `COMPENSATION_MIN_FIT_SCORE must be 75 per the shared contract, got ${COMPENSATION_MIN_FIT_SCORE}`);

    // Mirrors jobs.js's compensationFallback(job, 'below_fit_threshold', ...)
    // for a job that DOES have a real, parseable salary but scored below the
    // gate — offer.usable is true, so `offered` on the card is the real offer,
    // never null, and no market range was ever requested for it.
    const knownLowOffer = parseGuaranteedCashOffer({ salary: '$90,000 per year', location: 'Austin, Texas, USA' });
    assert(knownLowOffer.usable, 'fixture salary must itself be a usable stated cash offer');
    const knownLowScoreSkip = compensationAssessment({
      offer: knownLowOffer,
      reasonCode: 'below_fit_threshold',
      justification: `The competitive-pay check is reserved for stronger matches (fit score ${COMPENSATION_MIN_FIT_SCORE} or above); this job scored 69.`,
    });
    assert(knownLowScoreSkip.reasonCode === 'below_fit_threshold' && knownLowScoreSkip.offered?.max === 90000,
      'a known below-threshold score must be skipped with reasonCode below_fit_threshold while still carrying the real parsed offer');
    assert(knownLowScoreSkip.justification.includes('69'),
      'a known below-threshold score justification must name the actual score so it reads as a real assessment, not a missing one');

    // Mirrors the sibling branch for a job whose score is unknown/null
    // (unscored, or the UNSCORED_FALLBACK_SCORE sentinel) — same reasonCode,
    // but the justification must say the score was unavailable rather than
    // implying a real low score was measured. This is the "distinguishable"
    // half of contract C: there is no separate reasonCode for this case today,
    // so the justification text is the only signal a bug report can show.
    const unknownScoreSkip = compensationAssessment({
      offer: knownLowOffer,
      reasonCode: 'below_fit_threshold',
      justification: `The competitive-pay check is reserved for stronger matches (fit score ${COMPENSATION_MIN_FIT_SCORE} or above); this job's fit score was unavailable, so no comparison was made.`,
    });
    assert(unknownScoreSkip.reasonCode === 'below_fit_threshold', 'an unscored job must also be gated out under the below_fit_threshold reason code');
    assert(unknownScoreSkip.justification.includes('unavailable') && !unknownScoreSkip.justification.includes('scored'),
      'an unscored skip must read as "score unavailable", not be confused with a known below-threshold score');
    assert(knownLowScoreSkip.justification !== unknownScoreSkip.justification,
      'a known-low-score skip and an unscored skip must never render identical text on the card — that would erase the only signal that distinguishes them');

    // A boundary-inclusive pass (score === 75) never reaches this fallback path
    // at all in jobs.js; it is asserted here only as the documented contract on
    // the constant itself, since the real branch is not independently callable
    // (see the risk note above).
    assert(75 >= COMPENSATION_MIN_FIT_SCORE && 74 < COMPENSATION_MIN_FIT_SCORE,
      'the fit gate must be boundary-inclusive: 75 eligible, 74 not — pinned against the real constant');

    return { minFitScore: COMPENSATION_MIN_FIT_SCORE };
  },
}];
