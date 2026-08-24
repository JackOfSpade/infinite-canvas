import { assert } from '../test-dependencies.js';
import { buildJobTreeNodes, normalizeCompensationAssessment } from '../../src/nodes/jobsearch/buildJobTree.js';

const assessment = {
  schemaVersion: 1,
  status: 'below_market',
  reasonCode: 'offered_max_below_competitive_min',
  offered: { min: 70000, max: 85000, currency: 'CAD', period: 'year' },
  competitiveRange: { min: 90000, max: 120000, currency: 'CAD', period: 'year' },
  comparisonLocation: { kind: 'remote_canada_residence', display: 'Toronto, Ontario, Canada', country: 'Canada' },
  justification: 'Even the advertised maximum is below the researched competitive cash range.',
  researchedAt: '2026-08-22T12:00:00.000Z',
  sourceLinks: [{ title: 'Example salary source', url: 'https://example.test/salaries' }],
};

export default [
  {
    name: 'Compensation assessments fail open for legacy and malformed cards',
    run: () => {
      const legacy = normalizeCompensationAssessment(undefined);
      assert(legacy.status === 'not_evaluated' && legacy.isLegacy,
        'a pre-research card must remain neutral/not evaluated');
      assert(legacy.justification.includes('not run for this saved result'),
        'legacy cards must retain a safe explanation without auto-research');

      const malformed = normalizeCompensationAssessment({ schemaVersion: 1, status: 'invented-status' });
      assert(malformed.status === 'not_evaluated' && malformed.reasonCode === 'unreadable_assessment',
        'unknown current-schema verdicts must not accidentally colour a card');
      const future = normalizeCompensationAssessment({ schemaVersion: 2, status: 'competitive' });
      assert(future.status === 'not_evaluated' && future.reasonCode === 'unsupported_assessment_schema',
        'future assessment schemas must fail open rather than inherit a semantic border');
      const currencyMismatch = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'below_market',
        offered: { min: 80_000, max: 90_000, currency: 'USD', period: 'annual' },
        competitiveRange: { min: 100_000, max: 120_000, currency: 'CAD', period: 'annual' },
      });
      assert(currencyMismatch.status === 'uncertain' && currencyMismatch.reasonCode === 'incompatible_comparison_currency',
        'a persisted cross-currency comparison must never colour a card without a conversion');
      const missingCurrency = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'competitive',
        offered: { min: 80_000, max: 100_000, period: 'annual' },
        competitiveRange: { min: 90_000, max: 120_000, period: 'annual' },
      });
      assert(missingCurrency.status === 'uncertain' && missingCurrency.reasonCode === 'incompatible_comparison_currency',
        'a saved assessment without an explicit common currency must remain neutral');
      const missingPeriod = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'below_market',
        offered: { min: 80_000, max: 90_000, currency: 'USD' },
        competitiveRange: { min: 100_000, max: 120_000, currency: 'USD' },
      });
      assert(missingPeriod.status === 'uncertain' && missingPeriod.reasonCode === 'incompatible_comparison_period',
        'a saved assessment without annualized units must remain neutral');
      const annualAlias = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'competitive',
        offered: { min: 80_000, max: 100_000, currency: 'USD', period: 'year' },
        competitiveRange: { min: 90_000, max: 120_000, currency: 'USD', period: 'yr' },
      });
      assert(annualAlias.status === 'competitive' && annualAlias.offered.period === 'annual',
        'legacy annual aliases may remain semantic after deterministic normalization');
      const reversedRange = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'competitive',
        offered: { min: 100_000, max: 80_000, currency: 'USD', period: 'annual' },
        competitiveRange: { min: 90_000, max: 120_000, currency: 'USD', period: 'annual' },
      });
      assert(reversedRange.status === 'uncertain' && reversedRange.reasonCode === 'incomplete_comparison_data',
        'a reversed range must fail open instead of being silently repaired into a verdict');
      const boundedEvidence = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'uncertain',
        sourceLinks: Array.from({ length: 8 }, (_, index) => `https://example.test/${index}`),
      });
      assert(boundedEvidence.sourceLinks.length === 5 && boundedEvidence.sourceLinks.every((source) => source.label.length <= 240),
        'legacy/untrusted evidence must be capped before a disclosure can make a card unbounded');

      const normalized = normalizeCompensationAssessment(assessment);
      assert(normalized.status === 'below_market'
        && normalized.offered.max === 85000
        && normalized.competitiveRange.min === 90000
        && normalized.comparisonLocation === 'Toronto, Ontario, Canada'
        && normalized.sourceLinks[0]?.url === 'https://example.test/salaries',
      'the salary research contract must survive normalization intact');
      return { legacyStatus: legacy.status, verdict: normalized.status };
    },
  },
  {
    name: 'Compensation assessments propagate through AI-taxonomized job trees',
    run: () => {
      const jobs = [{
        title: 'Senior Designer', company: 'Acme', location: 'Toronto, ON', salary: 'C$70k–C$85k',
        matchScore: 88, reasoning: 'Strong match.', compensationAssessment: assessment,
      }];
      const common = { displayedJobs: jobs, originalPos: { x: 0, y: 0 }, hubId: 'hub', baseNodeId: 'run' };
      const grouped = buildJobTreeNodes({
        ...common,
        bucketTree: {
          likelihoodBands: [{ label: 'Excellent hiring fit (85–100)', minScore: 85, maxScore: 100 }],
          salaryRanges: [{ label: 'C$60–100k', minSalary: 60000, maxSalary: 100000 }],
          roles: [{ name: 'Design', jobIndices: [0] }],
        },
      });
      assert(grouped.newNodes.find((node) => node.type === 'jobcard')?.data?.compensationAssessment === assessment,
        'grouped hierarchy cards must retain compensation research');
      return { groupedCards: grouped.newNodes.filter((node) => node.type === 'jobcard').length };
    },
  },
];
