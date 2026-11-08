// One rule, shared by the backend validator and the card, for where a desired
// salary may sit. It combines two independent pieces of evidence:
//   - the researched market range for the role, level and location, and
//   - the employer's own advertised band for THIS job, when it is in the
//     same currency and annual.
//
// The advertised minimum is the strongest fact available: it is what the
// employer has budgeted for its lowest hire into this role. A desired salary
// below it never helps the candidate. So:
//   - no comparable band          → the market range.
//   - band entirely below market  → the market range (never anchor to a low
//                                   posting; the conflict is disclosed).
//   - band entirely above market  → the advertised band. A benchmark whose
//                                   top is below the employer's floor does not
//                                   describe this job (wrong level, employer
//                                   tier or specialty), so it cannot cap it.
//   - band overlaps market        → the market range with its floor raised to
//                                   the advertised minimum and its ceiling
//                                   raised to at least the advertised midpoint.
//                                   A posting that advertises more than the
//                                   research supports is itself evidence that
//                                   the answer must not stop below what the
//                                   employer says it pays.

const ANNUAL = new Set(['annual', 'year', 'yr', 'yearly']);

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function currencyOf(value) {
  return String(value?.currency || '').trim().toUpperCase();
}

/** The advertised band in the market's currency and period, or null when it cannot be compared. */
export function comparableAdvertisedBand(offered, market) {
  if (!offered || typeof offered !== 'object' || offered.usable === false) return null;
  if (!market || currencyOf(offered) !== currencyOf(market)) return null;
  if (!ANNUAL.has(String(offered.period || '').trim().toLowerCase())) return null;
  if (!positive(offered.min) || !positive(offered.max) || offered.min > offered.max) return null;
  return { min: offered.min, max: offered.max };
}

/**
 * @returns {{min:number, max:number, basis:'market'|'market_above_posted'|'posted_above_market'|'market_with_posted_floor', postedMidpointCeiling?:boolean}|null}
 *   `postedMidpointCeiling` is set only when the advertised midpoint raised the
 *   ceiling above the researched market maximum. `midpointCeiling: false`
 *   reproduces the methodology-v2 rule (no midpoint ceiling) so answers saved
 *   under it can be validated against the rule they were produced with.
 */
export function salaryRecommendationBounds(market, offered, { midpointCeiling = true } = {}) {
  if (!market || !positive(market.min) || !positive(market.max) || market.min > market.max) return null;
  const band = comparableAdvertisedBand(offered, market);
  if (!band) return { min: market.min, max: market.max, basis: 'market' };
  if (band.max < market.min) return { min: market.min, max: market.max, basis: 'market_above_posted' };
  if (band.min > market.max) return { min: band.min, max: band.max, basis: 'posted_above_market' };
  // An overlapping band can advertise up to a midpoint the research does not
  // reach; the answer must never stop below what the employer itself posts.
  const midpoint = Math.round((band.min + band.max) / 2);
  const max = midpointCeiling ? Math.max(market.max, midpoint) : market.max;
  const bounds = band.min > market.min
    ? { min: band.min, max, basis: 'market_with_posted_floor' }
    : { min: market.min, max, basis: 'market' };
  return max > market.max ? { ...bounds, postedMidpointCeiling: true } : bounds;
}
