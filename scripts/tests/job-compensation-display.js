import assert from 'node:assert/strict';
import { normalizeCompensationAssessment } from '../../src/nodes/jobsearch/buildJobTree.js';
import { JOB_COMPENSATION_METHOD_VERSION, jobBoardSalaryNeedsRefresh } from '../../src/utils/jobCompensationVersion.js';
import { jobCompensationDisplay } from '../../src/utils/jobCompensationDisplay.js';
import { explicitSalaryCurrency, formatSalaryCurrencyLabel, inferSalaryCurrency } from '../../src/utils/salaryCurrency.js';

const range = (min, max, currency = 'CAD') => ({ min, max, currency, period: 'annual' });
const comparison = (status, max = 100000) => ({ schemaVersion: 1, status,
  offered: range(80000, max), competitiveRange: range(100000, 140000) });

export default [
  {
    name: 'saved boards offer salary refresh after a methodology correction without changed sources or career data',
    run() {
      const data = { resultCount: 7, salaryCareerSnapshotId: 'snapshot-a' };
      assert.equal(jobBoardSalaryNeedsRefresh(data, 'snapshot-a'), true);
      assert.equal(jobBoardSalaryNeedsRefresh({ ...data, salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION - 1 }, 'snapshot-a'), true);
      const refreshed = { ...data, salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION };
      assert.equal(jobBoardSalaryNeedsRefresh(refreshed, 'snapshot-a'), false);
      assert.equal(jobBoardSalaryNeedsRefresh(refreshed, 'snapshot-b'), true);
      assert.equal(jobBoardSalaryNeedsRefresh({ resultCount: 0 }, ''), false, 'an empty board has no stale salary calculations to rerun');
    },
  },
  {
    name: 'Saved salary verdicts must agree with their retained range threshold',
    run() {
      for (const raw of [comparison('competitive', 90000), comparison('below_market', 100000)]) {
        const normalized = normalizeCompensationAssessment(raw);
        assert.equal(normalized.status, 'uncertain');
        assert.equal(normalized.reasonCode, 'inconsistent_comparison_verdict');
        const display = jobCompensationDisplay({ compensationAssessment: raw });
        assert.equal(display.determined, false);
        assert.match(display.explanation, /conflicts with its salary ranges/);
      }
      assert.equal(normalizeCompensationAssessment(comparison('competitive')).status, 'competitive', 'equality reaches the competitive floor');
      assert.equal(normalizeCompensationAssessment(comparison('below_market', 99999)).status, 'below_market');
      for (const currency of ['money', '<CAD>', '']) {
        const raw = comparison('competitive');
        raw.offered.currency = raw.competitiveRange.currency = currency;
        assert.equal(normalizeCompensationAssessment(raw).reasonCode, 'incompatible_comparison_currency');
        assert.equal(normalizeCompensationAssessment({ ...raw, status: 'market_recommendation' }).reasonCode, 'incomplete_market_recommendation');
        assert.equal(jobCompensationDisplay({ compensationAssessment: raw }).marketGuidanceAvailable, false);
      }
      assert.equal(jobCompensationDisplay({ compensationAssessment: comparison('competitive') }).marketGuidanceAvailable, true);
      for (const competitiveRange of [range(140000, 100000), { ...range(100000, 140000), period: '' }, { ...range(100000, 140000), min: null, max: null }]) {
        assert.equal(jobCompensationDisplay({ compensationAssessment: { ...comparison('competitive'), competitiveRange } }).marketGuidanceAvailable, false);
      }
      assert.equal(jobCompensationDisplay({ compensationAssessment: { ...comparison('competitive'), schemaVersion: 2 } }).marketGuidanceAvailable, false);
      for (const missingEndpoint of ['min', 'max']) {
        for (const field of ['offered', 'competitiveRange']) {
          const raw = comparison('competitive');
          delete raw[field][missingEndpoint];
          const normalized = normalizeCompensationAssessment(raw);
          assert.equal(normalized.status, 'uncertain');
          assert.equal(normalized.reasonCode, 'incomplete_comparison_data');
          assert.equal(normalized[field][missingEndpoint], null, 'normalization must not invent the absent endpoint');
          if (field === 'competitiveRange') {
            assert.equal(jobCompensationDisplay({ compensationAssessment: raw }).marketGuidanceAvailable, false);
            assert.equal(normalizeCompensationAssessment({ ...raw, status: 'market_recommendation' }).reasonCode, 'incomplete_market_recommendation');
          }
        }
      }
      for (const invalidAmount of [null, '', ' ', true, false, [], {}]) {
        const raw = comparison('competitive');
        raw.competitiveRange.min = invalidAmount;
        assert.equal(normalizeCompensationAssessment(raw).reasonCode, 'incomplete_comparison_data');
      }
      const fixedPoint = { ...comparison('competitive'), offered: range(100000, 100000), competitiveRange: range(100000, 100000) };
      assert.equal(normalizeCompensationAssessment(fixedPoint).status, 'competitive', 'complete explicit point ranges stay supported');
    },
  },
  {
    name: 'Invalid saved personal guidance remains distinguishable from a valid unavailable answer',
    run() {
      const base = { schemaVersion: 1, status: 'not_evaluated' };
      assert.equal(normalizeCompensationAssessment({ ...base, personalRecommendation: {} }).personalRecommendation.isInvalid, true);
      const unavailable = normalizeCompensationAssessment({ ...base, personalRecommendation: {
        schemaVersion: 1, methodologyVersion: 1, status: 'unavailable', confidence: 'low',
        explanation: 'Comparable evidence was unavailable.', limitations: [], careerSnapshotId: '', range: null, desiredSalary: null,
      } }).personalRecommendation;
      assert.equal(unavailable.status, 'unavailable');
      assert.notEqual(unavailable.isInvalid, true);
      assert.equal(normalizeCompensationAssessment(base).personalRecommendation, null);
    },
  },
  {
    name: 'A resolved description ambiguity retires the old missing-offer explanation until refreshed',
    run() {
      const result = jobCompensationDisplay({ location: 'Toronto, ON',
        description: 'Annual salary: CAD $80,000–$100,000.',
        compensationAssessment: { schemaVersion: 1, status: 'market_recommendation', reasonCode: 'market_range_recommended',
          offerReasonCode: 'ambiguous_description_salary', competitiveRange: range(100000, 140000) },
      });
      assert.equal(result.assessmentOutdated, true);
      assert.equal(result.offerReason, 'description_pay_unassessed');
      assert.match(result.explanation, /did not compare it/);
      assert.doesNotMatch(result.explanation, /multiple pay ranges/);
    },
  },
  {
    name: 'Currency display preserves mixed-market uncertainty and recognizes a qualified metro region',
    run() {
      assert.deepEqual(inferSalaryCurrency('', 'San Francisco Bay Area'), { currency: 'USD', inferred: true });
      assert.equal(inferSalaryCurrency('', 'Bay Area'), null, 'an unqualified region stays unresolved');
      assert.equal(explicitSalaryCurrency('USD $100,000 / CAD $140,000'), null);
      assert.equal(inferSalaryCurrency('USD $100,000 / CAD $140,000', 'Toronto, ON'), null, 'location must not override several explicit currencies');
      assert.equal(formatSalaryCurrencyLabel('USD $100,000 / CAD $140,000', 'Toronto, ON'), 'Multiple currencies · see listing');
      assert.equal(inferSalaryCurrency('$100,000', 'Toronto, ON / Austin, TX'), null, 'a multi-market location must not pick its first currency');
      assert.deepEqual(inferSalaryCurrency('CAD $100,000', 'Toronto, ON / Austin, TX'), { currency: 'CAD', inferred: false });
      assert.deepEqual(inferSalaryCurrency('$100,000', 'Toronto, Ontario, Canada'), { currency: 'CAD', inferred: true });
    },
  },
];
