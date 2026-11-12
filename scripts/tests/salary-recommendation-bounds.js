import assert from 'node:assert/strict';
import { salaryRecommendationBounds } from '../../src/utils/salaryRecommendationBounds.js';
import {
  normalizePersonalSalaryRecommendation,
  validatePersonalSalaryRecommendation,
} from '../../electron/ipc/personalSalaryRecommendation.js';
import {
  compensationAssessment, mergeCompetitiveRanges, parseGuaranteedCashOffer,
  retainConsistentCompetitiveRanges, typicalCompetitiveBand,
} from '../../electron/ipc/jobCompensation.js';
import { formatSalaryCurrencyLabel, inferSalaryCurrency, salaryCurrencyAmbiguousAcrossLocations } from '../../src/utils/salaryCurrency.js';
import { isCompensationRecommendationCurrent, normalizeCompensationAssessment } from '../../src/nodes/jobsearch/buildJobTree.js';

const SNAPSHOT = 'a'.repeat(64);
const PACKET = {
  methodologyVersion: 3, careerSnapshotId: SNAPSHOT, experience: [],
  evidence: [{ id: 'requirement-1', status: 'direct', candidateQuote: 'Built web applications.', jobQuote: 'Familiarity with web applications.' }],
};
// The saved Baseten case that prompted this rule: one Montreal junior survey
// (CAD 57–91K) against an employer band whose floor is far above it.
const MARKET = { min: 57000, max: 91000, currency: 'CAD', period: 'annual' };
const POSTED = { usable: true, min: 165000, max: 330000, currency: 'CAD', period: 'annual' };

function personal(overrides = {}) {
  return {
    status: 'personalized', min: 70000, max: 90000, desiredSalary: 85000, currency: 'CAD', confidence: 'low',
    explanation: 'Documented web-application work supports this position.', limitations: [], evidenceIds: ['requirement-1'],
    ...overrides,
  };
}

export default [
  {
    name: 'Recommendation bounds cover every relation between the market range and the posted band',
    run: () => {
      const market = { min: 100000, max: 150000, currency: 'CAD', period: 'annual' };
      const band = (min, max, extra = {}) => ({ usable: true, min, max, currency: 'CAD', period: 'annual', ...extra });
      assert.deepEqual(salaryRecommendationBounds(market, null), { min: 100000, max: 150000, basis: 'market' });
      assert.deepEqual(salaryRecommendationBounds(market, band(60000, 90000)), { min: 100000, max: 150000, basis: 'market_above_posted' });
      assert.deepEqual(salaryRecommendationBounds(market, band(165000, 330000)), { min: 165000, max: 330000, basis: 'posted_above_market' });
      assert.deepEqual(salaryRecommendationBounds(market, band(120000, 200000)), { min: 120000, max: 160000, basis: 'market_with_posted_floor', postedMidpointCeiling: true });
      assert.deepEqual(salaryRecommendationBounds(market, band(90000, 140000)), { min: 100000, max: 150000, basis: 'market' });
      // An overlapping advertisement never caps the answer below its own
      // midpoint: the raised ceiling is the advertised midpoint when the
      // research stops short of it, and the market maximum otherwise.
      const eur = (min, max) => ({ min, max, currency: 'EUR', period: 'annual' });
      assert.deepEqual(salaryRecommendationBounds(eur(25000, 61200), band(48000, 72000, { currency: 'EUR' })), { min: 48000, max: 61200, basis: 'market_with_posted_floor' });
      assert.deepEqual(salaryRecommendationBounds(eur(25000, 55000), band(48000, 72000, { currency: 'EUR' })), { min: 48000, max: 60000, basis: 'market_with_posted_floor', postedMidpointCeiling: true });
      assert.deepEqual(salaryRecommendationBounds(eur(50000, 60000), band(40000, 90000, { currency: 'EUR' })), { min: 50000, max: 65000, basis: 'market', postedMidpointCeiling: true });
      assert.equal(salaryRecommendationBounds(market, band(60000, 90000)).postedMidpointCeiling, undefined, 'a band entirely below the market keeps the market ceiling');
      assert.equal(salaryRecommendationBounds(market, band(165000, 330000)).postedMidpointCeiling, undefined, 'an advertised band above the market is unchanged');
      // A band that cannot be compared never moves the bounds.
      for (const unusable of [
        band(165000, 330000, { currency: 'USD' }), band(165000, 330000, { period: 'hourly' }),
        band(165000, 330000, { usable: false }), band(330000, 165000), band(0, 330000),
      ]) {
        assert.equal(salaryRecommendationBounds(market, unusable).basis, 'market', JSON.stringify(unusable));
      }
      assert.equal(salaryRecommendationBounds({ ...market, min: 0 }, band(1, 2)), null);
    },
  },
  {
    name: 'A posted floor above the whole market bounds the desired salary by the posted band',
    run: () => {
      const options = { marketRange: MARKET, evidence: PACKET, offered: POSTED };
      const belowFloor = validatePersonalSalaryRecommendation(personal(), options);
      assert.equal(belowFloor.boundsAdjusted, true);
      assert.equal(belowFloor.min, 165000);
      assert.equal(belowFloor.max, 165000);
      assert.equal(belowFloor.desiredSalary, 165000,
        'the saved CAD 85,000 answer below the employer floor is fitted up to it, never left below it');
      const normalized = normalizePersonalSalaryRecommendation(personal(), options);
      assert.equal(normalized.status, 'personalized');
      assert.deepEqual(normalized.range, { min: 165000, max: 165000, currency: 'CAD', period: 'annual' });
      assert.equal(normalized.desiredSalary, 165000);
      assert.ok(normalized.limitations.some(value => /fitted to the recommendation bounds/.test(value)),
        'the card must say the answer was fitted to the recommendation bounds');
      assert.ok(normalized.limitations.some(value => /posted minimum is above the whole researched market range/.test(value)),
        'the card must also say the bounds are the posted band');
      const accepted = normalizePersonalSalaryRecommendation(personal({ min: 165000, max: 200000, desiredSalary: 175000 }), options);
      assert.equal(accepted.status, 'personalized');
      assert.equal(accepted.desiredSalary, 175000);
      assert.ok(accepted.limitations.some(value => /posted minimum is above the whole researched market range/.test(value)),
        'the card must say why the answer is not inside the researched market range');
      const raisedCeiling = validatePersonalSalaryRecommendation(personal({ min: 165000, max: 340000, desiredSalary: 200000 }), options);
      assert.equal(raisedCeiling.min, 165000);
      assert.equal(raisedCeiling.max, 330000);
      assert.equal(raisedCeiling.desiredSalary, 200000);
      assert.equal(raisedCeiling.boundsAdjusted, true);

      const estimate = normalizePersonalSalaryRecommendation(undefined, { ...options, evidence: { ...PACKET, evidence: [] } });
      assert.equal(estimate.status, 'market_estimate');
      assert.deepEqual(estimate.range, { min: 165000, max: 330000, currency: 'CAD', period: 'annual' });
      assert.equal(estimate.desiredSalary, 250000);
      assert.match(estimate.explanation, /benchmark does not describe this job/);
      assert.equal(estimate.limitations.length, 2);
    },
  },
  {
    name: 'The assessment names a benchmark below the posted floor and a single-source market range',
    run: () => {
      const assessment = compensationAssessment({
        offer: POSTED, competitiveRanges: [{ min: 57000, max: 91000, currency: 'CAD' }], marketCurrency: 'CAD',
        comparisonLocation: { display: 'Montreal, Quebec, Canada' }, researchedAt: '2026-11-05T00:00:00.000Z',
      });
      assert.equal(assessment.status, 'competitive');
      assert.equal(assessment.reasonCode, 'offered_min_above_competitive_ceiling');
      assert.match(assessment.justification, /lowest stated guaranteed cash salary \(CAD 165,000\) is above the top/);
      assert.match(assessment.justification, /Only one comparable salary source/);
      const twoSources = compensationAssessment({
        offer: { ...POSTED, min: 60000, max: 90000 }, marketCurrency: 'CAD',
        competitiveRanges: [{ min: 57000, max: 91000, currency: 'CAD' }, { min: 60000, max: 85000, currency: 'CAD' }],
      });
      assert.equal(twoSources.reasonCode, 'offered_reaches_typical_market');
      assert.doesNotMatch(twoSources.justification, /Only one comparable salary source/);
      assert.equal(twoSources.currencyAmbiguous, undefined);
      const verbose = compensationAssessment({
        offer: POSTED, competitiveRanges: [{ min: 57000, max: 91000, currency: 'CAD' }], marketCurrency: 'CAD', justification: 'z'.repeat(5000),
      });
      assert.ok(verbose.justification.length <= 2400);
      assert.match(verbose.justification, /Desired-salary guidance uses the employer's posted band instead\. Only one comparable salary source/,
        'a long model justification is trimmed, never the host conclusion appended after it');
      // The renderer keeps a valid verdict for the new reason code.
      const rendered = normalizeCompensationAssessment(assessment);
      assert.equal(rendered.status, 'competitive');
      assert.equal(rendered.personalRecommendation.status, 'market_estimate',
        'the renderer must preserve the market estimate, which requires buildJobTree.normalizedPersonalRecommendation to accept PERSONAL_SALARY_METHODOLOGY_VERSION 3 instead of its current [1, 2] gate (src/nodes/jobsearch/buildJobTree.js:191)');
      assert.equal(rendered.personalRecommendation.desiredSalary, 250000);
    },
  },
  {
    name: 'A bare "$" amount read in one currency while its posted places name another is flagged as a reading',
    run: () => {
      const list = 'San Francisco | Toronto | New York | Montreal | Seattle';
      // The header keeps its location inference; the conflict is with the
      // CAD reading used for a Montreal comparison.
      assert.equal(formatSalaryCurrencyLabel('$165K - $330K', list), 'USD · inferred from location');
      assert.equal(salaryCurrencyAmbiguousAcrossLocations('$165K - $330K', list, 'CAD'), true);
      assert.equal(salaryCurrencyAmbiguousAcrossLocations('$165K - $330K', list, 'USD'), false);
      assert.equal(formatSalaryCurrencyLabel('$165K - $330K', 'New York, NY; Toronto, ON'), 'Currency not stated · multiple countries');
      // Places that name no country neither confirm nor contradict.
      for (const [places, read] of [['Toronto, ON; Ottawa', 'CAD'], ['Toronto, ON • Full-time', 'CAD'], ['Austin | Dallas', 'USD'], ['Austin, TX | Remote', 'USD']]) {
        assert.equal(salaryCurrencyAmbiguousAcrossLocations('$120K', places, read), false, places);
      }
      assert.deepEqual(inferSalaryCurrency('$120K', 'Toronto, ON; Ottawa'), { currency: 'CAD', inferred: true }, 'one named province still decides a list');
      assert.deepEqual(inferSalaryCurrency('$120K', 'Austin, TX | Remote'), { currency: 'USD', inferred: true });
      assert.deepEqual(inferSalaryCurrency('US$120K', list), { currency: 'USD', inferred: false }, 'a stated currency always wins');
      assert.equal(salaryCurrencyAmbiguousAcrossLocations('US$120K', list, 'CAD'), false);
      assert.equal(salaryCurrencyAmbiguousAcrossLocations('$120K', 'Montreal, Quebec, Canada', 'USD'), false, 'one place is never a list');
      assert.equal(formatSalaryCurrencyLabel('$120K', 'Remote'), 'Currency not specified');

      const job = {
        title: 'Software Engineer', location: 'Montreal, Quebec, Canada', salary: '$165K - $330K',
        officialPosting: { location: { display: list } },
      };
      const offer = parseGuaranteedCashOffer(job, { display: 'Montreal, Quebec, Canada' });
      assert.equal(offer.usable, true, 'the posted floor still matters when its currency is only a reading');
      assert.equal(offer.currency, 'CAD');
      assert.equal(offer.currencyAmbiguous, true);
      const single = parseGuaranteedCashOffer({ ...job, officialPosting: { location: { display: 'Montreal, QC' } } }, { display: 'Montreal, Quebec, Canada' });
      assert.equal(single.currencyAmbiguous, undefined);
      const stated = parseGuaranteedCashOffer({ ...job, salary: 'CAD 165K - 330K' }, { display: 'Montreal, Quebec, Canada' });
      assert.equal(stated.currencyAmbiguous, undefined);

      const assessment = compensationAssessment({ offer, competitiveRanges: [{ min: 57000, max: 91000, currency: 'CAD' }], marketCurrency: 'CAD' });
      assert.equal(assessment.currencyAmbiguous, true);
      assert.match(assessment.justification, /read as CAD for this comparison/);
      assert.equal(normalizeCompensationAssessment(assessment).currencyAmbiguous, true);
    },
  },
  {
    name: 'A saved v2 market estimate under the old ceiling is outdated, not unreadable',
    run: () => {
      const market = { min: 80000, max: 100000, currency: 'CAD', period: 'annual' };
      const posted = { usable: true, min: 90000, max: 130000, currency: 'CAD', period: 'annual' };
      assert.deepEqual(salaryRecommendationBounds(market, posted, { midpointCeiling: false }), { min: 90000, max: 100000, basis: 'market_with_posted_floor' });
      const save = (methodologyVersion, range, desiredSalary) => normalizeCompensationAssessment({
        schemaVersion: 1, status: 'competitive', reasonCode: 'offered_reaches_typical_market', offered: posted, competitiveRange: market,
        justification: 'Saved.', researchedAt: '2026-11-05T00:00:00.000Z',
        personalRecommendation: {
          schemaVersion: 1, methodologyVersion, status: 'market_estimate', confidence: 'low', explanation: 'Saved estimate.', limitations: [],
          careerSnapshotId: '', range: { ...range, currency: 'CAD', period: 'annual' }, desiredSalary,
        },
      }).personalRecommendation;
      const v2 = save(2, { min: 90000, max: 100000 }, 95000);
      assert.equal(v2.status, 'market_estimate', 'a v2 estimate produced under its own rule stays readable');
      assert.equal(v2.isInvalid, undefined);
      assert.equal(v2.superseded, true, 'today the ceiling reaches the posted midpoint, so it is shown as outdated');
      const v3 = save(3, { min: 90000, max: 110000 }, 100000);
      assert.equal(v3.status, 'market_estimate');
      assert.equal(v3.superseded, undefined, 'a v3 estimate at the current bounds is current');
      assert.equal(save(3, { min: 90000, max: 100000 }, 95000).isInvalid, true, 'a v3 estimate must match the v3 bounds');
    },
  },
  {
    name: 'Saved v1 answers keep their market-only rule while v2 answers use the shared bounds',
    run: () => {
      const base = {
        schemaVersion: 1, status: 'competitive', reasonCode: 'offered_min_above_competitive_ceiling',
        offered: POSTED, competitiveRange: MARKET, justification: 'Saved.', researchedAt: '2026-11-05T00:00:00.000Z',
      };
      const saved = (methodologyVersion, range, desiredSalary, status = 'personalized') => normalizeCompensationAssessment({
        ...base,
        personalRecommendation: {
          schemaVersion: 1, methodologyVersion, status, confidence: 'low', explanation: 'Saved answer.', limitations: [],
          careerSnapshotId: status === 'personalized' ? SNAPSHOT : '', range: { ...range, currency: 'CAD', period: 'annual' }, desiredSalary,
        },
      }).personalRecommendation;
      // The original Baseten card stays readable, but as an outdated answer, not a number to enter.
      const baseten = saved(1, { min: 70000, max: 90000 }, 85000);
      assert.equal(baseten.desiredSalary, 85000);
      assert.equal(baseten.superseded, true);
      assert.equal(isCompensationRecommendationCurrent(baseten, SNAPSHOT), false);
      const unaffected = normalizeCompensationAssessment({
        ...base, status: 'competitive', reasonCode: 'offered_reaches_competitive_floor', offered: { ...POSTED, min: 50000, max: 95000 },
        personalRecommendation: { schemaVersion: 1, methodologyVersion: 1, status: 'personalized', confidence: 'low', explanation: 'Saved.', limitations: [],
          careerSnapshotId: SNAPSHOT, range: { min: 70000, max: 90000, currency: 'CAD', period: 'annual' }, desiredSalary: 85000 },
      }).personalRecommendation;
      assert.equal(unaffected.superseded, undefined, 'a v1 answer today’s rule still allows stays current');
      assert.equal(isCompensationRecommendationCurrent(unaffected, SNAPSHOT), true);
      assert.equal(saved(1, { min: 165000, max: 200000 }, 175000).status, 'unavailable', 'v1 answers were never allowed outside the market');
      assert.equal(saved(2, { min: 165000, max: 200000 }, 175000).desiredSalary, 175000);
      assert.equal(saved(2, { min: 165000, max: 200000 }, 175000).methodologyVersion, 2);
      assert.equal(saved(2, { min: 70000, max: 90000 }, 85000).status, 'unavailable', 'a v2 answer below the posted floor is invalid');
      assert.equal(saved(2, { min: 165000, max: 330000 }, 250000, 'market_estimate').status, 'market_estimate');
      assert.equal(saved(2, { min: 57000, max: 91000 }, 75000, 'market_estimate').status, 'unavailable');
      // Version 3 is current now, so an older-than-v3 gate must not be what
      // proves the failure: an actually unknown version still fails closed.
      assert.equal(saved(4, { min: 165000, max: 200000 }, 175000).status, 'unavailable', 'an unknown methodology fails closed');
    },
  },
  {
    name: 'Personal-recommendation validation uses the typical band the assessment saves',
    run: () => {
      // One wide survey sits in the same midpoint cluster, so it is retained:
      // the union spans 60–140K while the typical band is 90–110K.
      const sources = [
        { min: 60000, max: 140000, currency: 'CAD' },
        { min: 90000, max: 110000, currency: 'CAD' },
        { min: 95000, max: 105000, currency: 'CAD' },
      ];
      const { retained } = retainConsistentCompetitiveRanges(sources, 'CAD');
      const band = typicalCompetitiveBand(retained, 'CAD');
      const union = mergeCompetitiveRanges(retained, 'CAD');
      assert.deepEqual(band, { min: 90000, max: 110000, currency: 'CAD', period: 'annual' });
      assert.deepEqual(union, { min: 60000, max: 140000, currency: 'CAD', period: 'annual' },
        'the union is still available for diagnosis, just not for the market range');
      const offer = { usable: true, min: 95000, max: 108000, currency: 'CAD', period: 'annual' };
      const assessment = compensationAssessment({ offer, competitiveRanges: sources, marketCurrency: 'CAD' });
      assert.deepEqual(assessment.competitiveRange, band, 'the assessment saves the typical band');
      assert.deepEqual(assessment.reportedSpan, union);
      // A target only the old union would allow must be fitted to exactly the
      // band the assessment saved, not a second wider definition.
      const aboveBand = personal({ min: 120000, max: 130000, desiredSalary: 125000 });
      const fitted = validatePersonalSalaryRecommendation(aboveBand, {
        marketRange: assessment.competitiveRange, evidence: PACKET, offered: offer,
      });
      assert.equal(fitted.boundsAdjusted, true);
      assert.equal(fitted.min, 110000);
      assert.equal(fitted.max, 110000);
      assert.equal(fitted.desiredSalary, 110000,
        'a target only the old union would allow is fitted to exactly the saved band');
      assert.doesNotThrow(() => validatePersonalSalaryRecommendation(aboveBand, {
        marketRange: union, evidence: PACKET, offered: offer,
      }), 'the union alone would have accepted it, so the saved band is what bounds the answer');
      assert.equal(validatePersonalSalaryRecommendation(aboveBand, {
        marketRange: union, evidence: PACKET, offered: offer,
      }).boundsAdjusted, undefined, 'the union would leave this answer untouched');
      const inside = personal({ min: 95000, max: 108000, desiredSalary: 101500 });
      assert.doesNotThrow(() => validatePersonalSalaryRecommendation(inside, {
        marketRange: assessment.competitiveRange, evidence: PACKET, offered: offer,
      }), 'an answer inside the saved typical band stays valid');
    },
  },
];
