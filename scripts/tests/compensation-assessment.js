import { assert } from '../test-dependencies.js';
import { buildJobTreeNodes, isCompensationRecommendationCurrent, normalizeCompensationAssessment } from '../../src/nodes/jobsearch/buildJobTree.js';
import { estimateCompensationExperienceYearsFromDescription, selectCompensationExperienceYears } from '../../electron/ipc/jobCompensation.js';

const personalRecommendation = {
  schemaVersion: 1,
  status: 'personalized',
  range: { min: 95000, max: 110000, currency: 'CAD', period: 'annual' },
  desiredSalary: 105000,
  confidence: 'medium',
  explanation: 'Your documented system ownership and directly relevant experience support this portion of the market range.',
  limitations: ['Leadership scope is not fully documented.'],
  careerSnapshotId: 'a'.repeat(64),
  methodologyVersion: 1,
};

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
  personalRecommendation,
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
      assert(legacy.personalRecommendation === null,
        'old cards must not fabricate a personalized range or desired salary');

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

      const recommendation = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'market_recommendation',
        reasonCode: 'market_range_recommended',
        competitiveRange: { min: 90_000, max: 120_000, currency: 'CAD', period: 'annual' },
        comparisonLocation: 'Toronto, Ontario, Canada',
        currencyInferredFromLocation: true,
      });
      assert(recommendation.status === 'market_recommendation'
        && recommendation.offered.min === null
        && recommendation.competitiveRange.min === 90_000
        && recommendation.currencyInferredFromLocation,
      'a market-only recommendation remains neutral and renderable without a fabricated advertised offer');
      const incompleteRecommendation = normalizeCompensationAssessment({
        schemaVersion: 1,
        status: 'market_recommendation',
        competitiveRange: { min: 90_000, max: 120_000, currency: 'CAD' },
      });
      assert(incompleteRecommendation.status === 'uncertain'
        && incompleteRecommendation.reasonCode === 'incomplete_market_recommendation',
      'an incomplete saved recommendation must fail open rather than display an unsupported answer range');

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
    name: 'Personal salary guidance remains separate from the researched market verdict and career snapshot',
    run: () => {
      const normalized = normalizeCompensationAssessment(assessment);
      assert(normalized.status === 'below_market' && normalized.competitiveRange.min === 90000,
        'personal salary guidance must not change the independent offer comparison or market range');
      assert(normalized.personalRecommendation?.desiredSalary === 105000
        && normalized.personalRecommendation.range.min === 95000
        && normalized.personalRecommendation.range.max === 110000
        && normalized.personalRecommendation.explanation === personalRecommendation.explanation,
      'valid personal guidance must retain its answer, range and evidence explanation');
      assert(isCompensationRecommendationCurrent(normalized.personalRecommendation, 'a'.repeat(64))
        && !isCompensationRecommendationCurrent(normalized.personalRecommendation, 'b'.repeat(64))
        && !isCompensationRecommendationCurrent(normalized.personalRecommendation, undefined),
      'freshness is true only for the exact career snapshot used to calculate the desired salary');
      const legacy = normalizeCompensationAssessment({ ...assessment, personalRecommendation: undefined });
      assert(legacy.personalRecommendation === null && legacy.status === 'below_market',
        'legacy market assessments must remain renderable without creating a personal answer');
      const marketEstimate = normalizeCompensationAssessment({
        ...assessment,
        personalRecommendation: {
          ...personalRecommendation, status: 'market_estimate', careerSnapshotId: '', confidence: 'low',
          range: { min: 90000, max: 120000, currency: 'CAD', period: 'annual' },
        },
      });
      assert(marketEstimate.personalRecommendation.status === 'market_estimate'
        && isCompensationRecommendationCurrent(marketEstimate.personalRecommendation, ''),
      'a clearly labeled market estimate can exist without claiming candidate-specific evidence');
      const unavailable = normalizeCompensationAssessment({
        ...assessment,
        personalRecommendation: {
          ...personalRecommendation, status: 'unavailable', range: null, desiredSalary: null,
          explanation: 'Salary evidence is too limited for a defensible target.',
        },
      });
      assert(unavailable.personalRecommendation.desiredSalary === null
        && unavailable.personalRecommendation.explanation.includes('too limited')
        && !isCompensationRecommendationCurrent(unavailable.personalRecommendation, 'a'.repeat(64)),
      'explicitly unavailable guidance must show the reason without offering a number to copy');
      return { desiredSalary: normalized.personalRecommendation.desiredSalary, status: normalized.status };
    },
  },
  {
    name: 'Malformed personal salary guidance fails closed without changing a market comparison',
    run: () => {
      const invalid = [
        null,
        [],
        { ...personalRecommendation, schemaVersion: 2 },
        { ...personalRecommendation, schemaVersion: '1' },
        { ...personalRecommendation, methodologyVersion: 2 },
        { ...personalRecommendation, status: 'invented' },
        { ...personalRecommendation, confidence: 'certain' },
        { ...personalRecommendation, explanation: '' },
        { ...personalRecommendation, limitations: [null] },
        { ...personalRecommendation, careerSnapshotId: '' },
        { ...personalRecommendation, careerSnapshotId: 'a'.repeat(63) },
        { ...personalRecommendation, careerSnapshotId: 'A'.repeat(64) },
        { ...personalRecommendation, careerSnapshotId: 'g'.repeat(64) },
        { ...personalRecommendation, careerSnapshotId: 'x'.repeat(301) },
        { ...personalRecommendation, desiredSalary: '105000' },
        { ...personalRecommendation, desiredSalary: Infinity },
        { ...personalRecommendation, desiredSalary: 0 },
        { ...personalRecommendation, desiredSalary: null },
        { ...personalRecommendation, desiredSalary: 94000 },
        { ...personalRecommendation, desiredSalary: 111000 },
        { ...personalRecommendation, range: { ...personalRecommendation.range, min: '95000' } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, max: NaN } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, min: 0 } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, max: 11000000 } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, min: 110000, max: 95000 } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, min: 89000 } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, max: 121000 } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, currency: 'USD' } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, currency: 'cad' } },
        { ...personalRecommendation, range: { ...personalRecommendation.range, period: 'year' } },
        { ...personalRecommendation, status: 'unavailable' },
        { ...personalRecommendation, status: 'market_estimate', confidence: 'low' },
        {
          ...personalRecommendation, status: 'market_estimate', confidence: 'medium',
          range: { min: 90000, max: 120000, currency: 'CAD', period: 'annual' },
        },
      ];
      for (const value of invalid) {
        const result = normalizeCompensationAssessment({ ...assessment, personalRecommendation: value });
        assert(result.personalRecommendation?.status === 'unavailable'
          && result.personalRecommendation.range === null && result.personalRecommendation.desiredSalary === null,
        'malformed guidance must never expose a personal range or copyable salary');
        assert(result.status === 'below_market' && result.competitiveRange.min === 90000,
          'a rejected personal answer must leave the independently researched market verdict intact');
      }
      const bounded = normalizeCompensationAssessment({
        ...assessment,
        personalRecommendation: {
          ...personalRecommendation,
          explanation: 'x'.repeat(3000),
          limitations: Array.from({ length: 12 }, () => 'y'.repeat(700)),
        },
      }).personalRecommendation;
      assert(bounded.status === 'personalized' && bounded.explanation.length === 2400
        && bounded.limitations.length === 8 && bounded.limitations.every((item) => item.length === 500),
      'untrusted personal explanations and limitations must be bounded before rendering');
      const future = normalizeCompensationAssessment({ ...assessment, schemaVersion: 2 });
      assert(future.personalRecommendation === null,
        'an unsupported parent assessment schema cannot expose a copyable personal recommendation');
      return { rejectedGuidanceCases: invalid.length };
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
      assert(grouped.newNodes.find((node) => node.type === 'jobcard')?.data?.compensationAssessment.personalRecommendation.desiredSalary === 105000,
        'grouped hierarchy cards must retain personal guidance alongside the market assessment');
      return { groupedCards: grouped.newNodes.filter((node) => node.type === 'jobcard').length };
    },
  },
  {
    name: 'Salary analysis estimates experience from a job description when the fit assessment lacks years',
    run: () => {
      const explicitMinimum = estimateCompensationExperienceYearsFromDescription({
        description: 'You bring at least 5 years of experience building distributed systems.',
      });
      const explicitRange = estimateCompensationExperienceYearsFromDescription({
        description: 'Requirements: 3–5 years of product design experience.',
      });
      const titleSeniority = estimateCompensationExperienceYearsFromDescription({
        title: 'Senior Platform Engineer',
        description: 'Own critical systems and mentor teammates.',
      }, { seniority: 'senior' });
      const principalSeniority = estimateCompensationExperienceYearsFromDescription({
        title: 'Principal Product Manager',
      });
      const juniorReportingLine = estimateCompensationExperienceYearsFromDescription({
        title: 'Junior Data Analyst',
        description: 'This position reports to the Director of Analytics and supports the broader team.',
      });
      const juniorManager = estimateCompensationExperienceYearsFromDescription({ title: 'Junior Manager' });
      const unspecifiedDescription = estimateCompensationExperienceYearsFromDescription({
        description: 'The role supports 3 products, has a 5-person team, and offers $125,000 annually.',
      });
      const noEvidence = estimateCompensationExperienceYearsFromDescription({
        description: 'We are looking for a thoughtful collaborator who enjoys building useful software.',
      });
      const titleOnly = estimateCompensationExperienceYearsFromDescription({ title: 'Operations Coordinator' });
      const unrelatedExternalPage = {
        title: 'Junior Engineer',
        descriptionCapture: 'external-page-full-text',
        description: 'Senior Architect: requires 8 years of software engineering experience. Junior Engineer: work with the team.',
      };
      const externalPageEstimate = estimateCompensationExperienceYearsFromDescription(unrelatedExternalPage);
      const unsupportedCategory = selectCompensationExperienceYears({
        categorySpecificExperience: [{ requiredMinimumYears: 8, jobEvidenceGrounded: true, jobEvidence: 'Experience with distributed systems.' }],
      }, { job: { description: 'Experience with distributed systems.' } });
      const unsupportedCandidateYears = selectCompensationExperienceYears({
        categorySpecificExperience: [{ reportedYears: 8, candidateEvidenceGrounded: false }],
      });
      assert(explicitMinimum.years === 5 && explicitMinimum.basis === 'description-stated-minimum',
        'an explicit job-description minimum must place the listing in a salary experience band when structured scoring evidence lacks years');
      assert(explicitRange.years === 5 && explicitRange.basis === 'description-stated-minimum',
        'a stated experience range must use its highest explicit requirement when choosing a salary market');
      assert(titleSeniority.years === 5 && titleSeniority.basis === 'description-seniority-estimate'
        && principalSeniority.years === 10 && principalSeniority.basis === 'description-seniority-estimate',
      'a listed seniority level must produce a clearly marked market estimate when the description has no numeric experience requirement');
      assert(juniorReportingLine.years === 1 && juniorReportingLine.basis === 'description-seniority-estimate',
        'a reporting line must not upgrade a junior listing into the director salary market');
      assert(juniorManager.years === 1 && juniorManager.basis === 'description-seniority-estimate',
        'a junior title must take precedence over a role noun when pricing the experience band');
      assert(unspecifiedDescription.years === 2 && unspecifiedDescription.basis === 'description-unspecified-estimate',
        'a real description with no stated level must use the disclosed conservative market anchor instead of abandoning salary research');
      assert(noEvidence.years === 2 && noEvidence.basis === 'description-unspecified-estimate',
        'a complete listing description with no numeric experience signal must still receive the disclosed conservative market anchor');
      assert(titleOnly.years === 2 && titleOnly.basis === 'description-unspecified-estimate',
        'a title-only listing must receive the disclosed conservative market anchor instead of abandoning salary research');
      assert(externalPageEstimate.years === 1 && externalPageEstimate.basis === 'description-seniority-estimate'
        && unsupportedCategory.years === null && unsupportedCandidateYears.years === null,
      'an unrelated full-page role, grounded quote without its claimed number, or ungrounded candidate years must not upgrade this listing’s salary band');
      return { explicitMinimum: explicitMinimum.years, explicitRange: explicitRange.years };
    },
  },
];
