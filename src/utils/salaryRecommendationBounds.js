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
//                                   the advertised minimum.

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
 * @returns {{min:number, max:number, basis:'market'|'market_above_posted'|'posted_above_market'|'market_with_posted_floor'}|null}
 */
export function salaryRecommendationBounds(market, offered) {
  if (!market || !positive(market.min) || !positive(market.max) || market.min > market.max) return null;
  const band = comparableAdvertisedBand(offered, market);
  if (!band) return { min: market.min, max: market.max, basis: 'market' };
  if (band.max < market.min) return { min: market.min, max: market.max, basis: 'market_above_posted' };
  if (band.min > market.max) return { min: band.min, max: band.max, basis: 'posted_above_market' };
  if (band.min > market.min) return { min: band.min, max: market.max, basis: 'market_with_posted_floor' };
  return { min: market.min, max: market.max, basis: 'market' };
}
