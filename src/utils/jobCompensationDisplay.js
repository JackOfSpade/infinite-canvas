import { normalizeCompensationAssessment } from '../nodes/jobsearch/buildJobTree.js';
import { officialPostingDisplay } from './officialPostingDisplay.js';
import { advertisedSalaryForJob } from './jobAdvertisedSalary.js';

export const COMPENSATION_OFFER_REASONS = new Set([
  'usable_cash_salary', 'no_cash_salary', 'variable_or_non_cash_only',
  'unparseable_cash_salary', 'salary_maximum_unstated', 'hourly_hours_unclear',
  'daily_schedule_unclear', 'currency_unclear',
  'ambiguous_description_salary', 'description_scope_unclear', 'description_pay_unassessed',
]);

export const COMPENSATION_COMPARISON_REASONS = new Set([
  ...COMPENSATION_OFFER_REASONS, 'legacy_unresearched', 'unsupported_assessment_schema',
  'unreadable_assessment', 'incomplete_comparison_data', 'incompatible_comparison_currency',
  'incompatible_comparison_period', 'incomplete_market_recommendation',
  'inconsistent_comparison_verdict',
  'market_range_recommended', 'market_range_unavailable', 'market_evidence_unavailable',
  'offered_max_below_competitive_floor', 'offered_reaches_competitive_floor',
  'below_fit_threshold', 'fit_score_unavailable', 'comparison_location_unavailable',
  'market_currency_unavailable', 'experience_band_unavailable', 'research_interrupted',
  'research_unavailable',
]);

const OFFER_EXPLANATIONS = {
  no_cash_salary: 'No advertised cash pay is available to compare.',
  variable_or_non_cash_only: 'Only variable pay or non-cash compensation is advertised.',
  unparseable_cash_salary: 'The advertised pay does not establish a usable cash amount.',
  salary_maximum_unstated: 'The advertised pay does not state a maximum.',
  hourly_hours_unclear: 'Weekly hours are unknown, so hourly pay cannot be compared annually.',
  daily_schedule_unclear: 'The work schedule is unknown, so daily pay cannot be compared annually.',
  currency_unclear: 'The advertised pay currency could not be established.',
  ambiguous_description_salary: 'The description advertises multiple pay ranges or currencies; the applicable offer is unclear.',
  description_scope_unclear: 'The captured page may contain other jobs, so this posting’s advertised pay could not be established.',
};

const COMPARISON_EXPLANATIONS = {
  below_fit_threshold: 'Market research was skipped because hiring fit was below the research threshold.',
  fit_score_unavailable: 'Market research was skipped because the hiring-fit score was unavailable.',
  comparison_location_unavailable: 'The applicable salary-market location could not be established.',
  market_currency_unavailable: 'The salary-market currency could not be established.',
  experience_band_unavailable: 'A comparable experience band could not be established.',
  research_interrupted: 'Salary research was interrupted.',
  research_unavailable: 'Comparable salary research was unavailable or incomplete.',
  market_range_unavailable: 'A comparable market range could not be established.',
  market_evidence_unavailable: 'Comparable market evidence was unavailable.',
  market_range_recommended: 'A researched market range is available in salary guidance.',
  legacy_unresearched: 'Salary research was not run for this saved result.',
  inconsistent_comparison_verdict: 'The saved conclusion conflicts with its salary ranges. Re-combine saved results on the Job Board to refresh it.',
};

/** Keep the advertised-pay verdict visible even when separate salary guidance exists. */
export function jobCompensationDisplay(job = {}, assessment = normalizeCompensationAssessment(job.compensationAssessment)) {
  const advertised = advertisedSalaryForJob({ ...job, salary: officialPostingDisplay(job).salary });
  const salary = advertised.text;
  const retainedOffer = assessment.offered.min > 0 && assessment.offered.max > 0;
  const marketRange = assessment.competitiveRange;
  const marketGuidanceAvailable = assessment.schemaVersion === 1
    && marketRange.min > 0 && marketRange.max >= marketRange.min
    && /^[A-Z]{3}$/.test(marketRange.currency) && marketRange.period === 'annual';
  const storedReason = job.compensationAssessment?.offerReasonCode;
  const staleMissingOffer = advertised.source === 'description' && !retainedOffer
    && (!storedReason || storedReason === 'no_cash_salary'
      || (storedReason === 'ambiguous_description_salary' && !advertised.reasonCode));
  const assessmentOutdated = staleMissingOffer && !advertised.reasonCode
    && !['below_fit_threshold', 'fit_score_unavailable'].includes(assessment.reasonCode);
  const offerReason = staleMissingOffer ? (advertised.reasonCode || 'description_pay_unassessed')
    : COMPENSATION_OFFER_REASONS.has(storedReason)
    ? storedReason
    : retainedOffer ? 'usable_cash_salary' : salary ? 'unknown' : advertised.reasonCode || 'no_cash_salary';
  const determined = ['competitive', 'below_market'].includes(assessment.status);
  const label = assessment.status === 'competitive' ? 'Competitive cash pay'
    : assessment.status === 'below_market' ? 'Likely below-market cash pay'
      : 'Cannot determine pay competitiveness';
  const reasons = determined ? [] : [
    OFFER_EXPLANATIONS[offerReason],
    assessmentOutdated ? 'Pay is advertised in the description, but this saved assessment did not compare it. Combine saved results again on the Job Board to refresh salary analysis.'
      : staleMissingOffer && !advertised.reasonCode ? 'Pay is advertised in the description.' : '',
    COMPARISON_EXPLANATIONS[assessment.reasonCode],
  ].filter(Boolean);
  return {
    label, determined, offerReason, assessmentOutdated, marketGuidanceAvailable, hasAdvertisedPay: Boolean(salary || retainedOffer),
    explanation: reasons.join(' ') || (determined ? '' : 'The saved salary evidence does not support a reliable comparison. Open salary details for the reason.'),
    salary,
  };
}
