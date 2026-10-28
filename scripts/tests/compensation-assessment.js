import { assert } from '../test-dependencies.js';
import { buildJobTreeNodes, isCompensationRecommendationCurrent, normalizeCompensationAssessment } from '../../src/nodes/jobsearch/buildJobTree.js';
import { estimateCompensationExperienceYearsFromDescription, selectCompensationExperienceYears } from '../../electron/ipc/jobCompensation.js';
import { compensationAssessment, parseGuaranteedCashOffer } from '../../electron/ipc/jobCompensation.js';
import { jobCompensationDisplay } from '../../src/utils/jobCompensationDisplay.js';
import { advertisedSalaryForJob } from '../../src/utils/jobAdvertisedSalary.js';
import { collectJobCompensationReport } from '../../src/utils/jobCompensationReport.js';
import { buildJobCompensationSnapshot } from '../../electron/ipc/bugReport/jobCompensationSnapshot.js';

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
    name: 'Repeated description salary bands remain usable without merging genuinely different offers',
    run() {
      const location = 'Toronto, Ontario, Canada';
      for (const description of [
        'The actual base salary offered depends on experience. CAD $92,000–$134,000\nWage Notice CAD $92,000–$134,000',
        'Compensation reflects base salary only and excludes equity or benefits. $92,000–$134,000 CAD\nBase Salary $92,000–$134,000 CAD',
        'Annual base salary: CAD $92k–$134k\nSalary range CAD $92,000–$134,000 per year',
      ]) {
        const result = parseGuaranteedCashOffer({ location, description });
        assert(result.usable && result.min === 92000 && result.max === 134000 && result.currency === 'CAD',
          'one pay band repeated under different labels must support the advertised-pay comparison');
      }
      for (const description of [
        'Salary: CAD $92,000–$134,000\nWage notice CAD $95,000–$140,000',
        'Salary: CAD $92–$134 per hour\nSalary: CAD $92–$134 per day',
        'Salary: USD $92,000–$134,000\nSalary: CAD $92,000–$134,000',
        'Base salary CAD $92,000–$134,000 plus CAD $20,000 bonus\nSalary: CAD $92,000–$134,000',
        'Canada salary $92,000–$134,000\nUnited States base salary $92,000–$134,000',
        'Base salary USD $92,000–$134,000\nTotal compensation USD $92,000–$134,000',
        'Base salary USD $92,000–$134,000\nOn-target earnings compensation USD $92,000–$134,000',
        'Salary in Toronto CAD $92,000–$134,000\nSalary in Vancouver CAD $92,000–$134,000',
        'Toronto salary CAD $92,000–$134,000\nVancouver salary CAD $92,000–$134,000',
      ]) {
        const result = parseGuaranteedCashOffer({ location, description });
        assert(!result.usable && result.reasonCode === 'ambiguous_description_salary',
          'differing amounts, periods, currencies or extra money remain ambiguous');
      }
      for (const [currency, description] of [
        ['EUR', 'Salary: EUR €92,000–€134,000 per year'],
        ['GBP', 'Salary: GBP £92,000–£134,000 per year'],
      ]) {
        const result = parseGuaranteedCashOffer({ location, description });
        assert(result.usable && result.currency === currency, 'a currency code and its own symbol name one pay currency');
      }
      const mixedField = parseGuaranteedCashOffer({ location, salary: 'USD $92,000–CAD $134,000' });
      assert(!mixedField.usable && mixedField.reasonCode === 'currency_unclear',
        'a dedicated salary field must reject mixed currencies just as a description does');
      for (const salary of [
        'USD 92,000 base salary + CAD 20,000 bonus',
        'USD $92,000 base salary + CAD $20,000 bonus',
        'Base salary USD $92,000 + CAD $20,000 bonus',
        '$92,000 USD base salary + CAD $20,000 bonus',
      ]) {
        const baseAndForeignBonus = parseGuaranteedCashOffer({ location, salary });
        assert(baseAndForeignBonus.usable && baseAndForeignBonus.currency === 'USD' && baseAndForeignBonus.max === 92000,
          'a foreign variable-pay currency cannot relabel separately stated base pay');
      }
      const bareBase = parseGuaranteedCashOffer({ location: 'Austin, TX', salary: '$92,000 base salary + CAD $20,000 bonus' });
      assert(bareBase.usable && bareBase.currency === 'USD' && bareBase.currencyInferredFromLocation,
        'a base figure without an explicit currency must use its own market, never an excluded bonus currency');
      const bareWithoutMarket = parseGuaranteedCashOffer({ salary: '$92,000 base salary + CAD $20,000 bonus' });
      assert(!bareWithoutMarket.usable && bareWithoutMarket.reasonCode === 'currency_unclear',
        'an excluded bonus cannot establish the currency of an otherwise ambiguous base amount');
    },
  },
  {
    name: 'Salary comparison reads description pay without mixing currencies, levels, or unrelated financial figures',
    run() {
      const job = { salary: '', location: 'Toronto, Ontario, Canada', description: 'Build useful tools.\nThe annual base salary range is CAD $90,000–$120,000.\nJoin our team.' };
      const offer = parseGuaranteedCashOffer(job);
      assert(offer.usable && offer.min === 90000 && offer.max === 120000 && offer.currency === 'CAD');
      assert(compensationAssessment({ offer, competitiveRanges: [{ min: 100000, max: 140000, currency: 'CAD' }] }).status === 'competitive');
      const split = parseGuaranteedCashOffer({ location: job.location, description: 'Compensation Range:\nCAD $90,000–$120,000' });
      assert(split.usable && split.max === 120000, 'a pay label on the preceding line must retain the stated range');
      const hourly = parseGuaranteedCashOffer({ location: job.location, description: 'Base pay: CAD $45/hour.\nFull-time, 40 hours per week.' });
      assert(hourly.usable && hourly.max === 93600, 'description recovery must preserve cadence and known hours');
      const minimum = parseGuaranteedCashOffer({ location: job.location, description: 'Salary starts from CAD $90,000.' });
      assert(!minimum.usable && minimum.reasonCode === 'salary_maximum_unstated');
      const ambiguous = [
        'Salary: USD $90,000–$120,000.\nSalary: CAD $110,000–$150,000.',
        'Targeted cash compensation:\nP2: $90,000–$120,000\nP3: $120,000–$160,000',
        'Salary: USD $90,000–CAD $120,000.',
      ];
      for (const description of ambiguous) {
        const result = parseGuaranteedCashOffer({ location: job.location, description });
        assert(!result.usable && result.reasonCode === 'ambiguous_description_salary', 'multiple pay markets or levels must not become one invented offer');
      }
      const financial = parseGuaranteedCashOffer({ location: job.location, description: 'Our company raised $120,000,000. We offer competitive compensation.' });
      assert(!financial.usable, 'company funding must not become an advertised salary');
      const unrelated = parseGuaranteedCashOffer({ ...job, descriptionCapture: 'external-page-full-text' });
      assert(!unrelated.usable && unrelated.reasonCode === 'description_scope_unclear');
      assert(advertisedSalaryForJob({ ...job, salary: 'CAD $80,000 per year' }).source === 'salary_field', 'the dedicated pay field stays primary');
    },
  },
  {
    name: 'Every salary disclosure separates an advertised-pay verdict from guidance and explains research skips',
    run() {
      for (const reasonCode of ['below_fit_threshold', 'comparison_location_unavailable', 'market_currency_unavailable', 'fit_score_unavailable', 'research_interrupted']) {
        const result = jobCompensationDisplay({ compensationAssessment: { schemaVersion: 1, status: 'not_evaluated', reasonCode } });
        assert(result.label === 'Cannot determine pay competitiveness' && result.explanation.includes('No advertised cash pay'), 'missing pay remains explicit even when another gate skipped research');
      }
      const marketJob = { compensationAssessment: { ...assessment, status: 'market_recommendation', reasonCode: 'market_range_recommended', offered: null } };
      const market = jobCompensationDisplay(marketJob);
      assert(!market.determined && market.explanation.includes('researched market range') && market.explanation.includes('No advertised cash pay'));
      const stale = jobCompensationDisplay({ ...marketJob, location: 'Toronto, Ontario, Canada', description: 'Base salary: CAD $90,000–$120,000.' });
      assert(stale.hasAdvertisedPay && stale.offerReason === 'description_pay_unassessed' && stale.explanation.includes('did not compare it') && !stale.explanation.includes('No advertised cash pay'));
      assert(jobCompensationDisplay({ compensationAssessment: assessment }).determined, 'a retained supported below-market verdict remains visible');
      const skipped = compensationAssessment({ offer: { usable: false, reasonCode: 'hourly_hours_unclear' }, reasonCode: 'below_fit_threshold' });
      assert(skipped.reasonCode === 'below_fit_threshold' && skipped.offerReasonCode === 'hourly_hours_unclear', 'retain the pay limitation independently of the skip reason');
      const hourly = jobCompensationDisplay({ salary: '$45/hour', compensationAssessment: skipped });
      assert(hourly.explanation.includes('Weekly hours') && hourly.explanation.includes('hiring fit'));
    },
  },
  {
    name: 'Salary audit covers hidden nested cards after restart and emits only fixed metadata',
    run() {
      const nodes = [{ type: 'group', data: { canvasData: { nodes: [
        { id: 'private-card-id', type: 'jobcard', hidden: true, data: { salary: 'PRIVATE_SALARY', compensationAssessment: { ...assessment, justification: 'PRIVATE_PROSE', sourceLinks: [{ url: 'https://private.example.test' }] } } },
        { id: 'missing', type: 'jobcard', data: {} },
      ] } } }];
      const snapshot = collectJobCompensationReport(nodes);
      assert(snapshot.inspectedCards === 2 && snapshot.rows[0].thresholdCheck === 'consistent');
      const report = buildJobCompensationSnapshot([], snapshot);
      assert(report.includes('2 inspected') && report.includes('below_market=1') && report.includes('legacy_unresearched'));
      for (const privateValue of ['PRIVATE_SALARY', 'PRIVATE_PROSE', 'private-card-id', 'private.example.test']) assert(!JSON.stringify(snapshot).replace('private-card-id', '').includes(privateValue) && !report.includes(privateValue));
      const malicious = buildJobCompensationSnapshot([], { inspectedCards: 1, rows: [{ id: 'id', status: 'PRIVATE_STATUS', reason: 'PRIVATE_REASON', offerReason: 'PRIVATE_REASON', thresholdCheck: 'PRIVATE_CHECK' }] });
      assert(!malicious.includes('PRIVATE_'), 'main-process rendering revalidates renderer metadata');
      assert(collectJobCompensationReport(nodes, { flat: true }).inspectedCards === 0, 'flat live inventories must not descend into stale embedded snapshots');
    },
  },
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
        descriptionCapture: 'external-page-full-text',
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
      assert(grouped.newNodes.find((node) => node.type === 'jobcard')?.data?.descriptionCapture === 'external-page-full-text',
        'cards must retain description scope so a whole careers page cannot supply another job’s salary');
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
      assert(explicitRange.years === 3 && explicitRange.basis === 'description-stated-minimum',
        'a stated experience range must use its lower required endpoint when choosing a salary market');
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
