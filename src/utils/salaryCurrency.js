// Salary amounts remain exactly as a job platform supplied them. This helper
// labels an explicitly stated currency first. An ambiguous value may use the
// job location as a clearly marked fallback; it never converts amounts.

const EXPLICIT_CURRENCIES = [
  ['CAD', /(?:\bCAD\b|CA\$|C\$)/i],
  ['USD', /(?:\bUSD\b|US\$)/i],
  ['AUD', /(?:\bAUD\b|AU\$|A\$)/i],
  ['NZD', /(?:\bNZD\b|NZ\$)/i],
  ['HKD', /(?:\bHKD\b|HK\$)/i],
  ['SGD', /(?:\bSGD\b|SG\$|S\$)/i],
  ['MXN', /(?:\bMXN\b|MX\$)/i],
  ['BRL', /(?:\bBRL\b|R\$)/i],
  ['EUR', /(?:\bEUR\b|€)/i],
  ['GBP', /(?:\bGBP\b|£)/i],
  ['INR', /(?:\bINR\b|₹)/i],
  ['KRW', /(?:\bKRW\b|₩)/i],
  ['JPY', /(?:\bJPY\b|JP¥)/i],
  ['CNY', /(?:\bCNY\b|CN¥)/i],
  ['CHF', /\bCHF\b/i],
  ['AED', /\bAED\b/i],
  ['ZAR', /\bZAR\b/i],
  ['SEK', /\bSEK\b/i],
  ['NOK', /\bNOK\b/i],
  ['DKK', /\bDKK\b/i],
  ['PLN', /\bPLN\b/i],
  ['TRY', /\bTRY\b/i],
  ['PHP', /\bPHP\b/i],
  ['VND', /\bVND\b/i],
];

const LOCATION_CURRENCIES = [
  ['CAD', /\b(?:canada|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland(?: and labrador)?|prince edward island|northwest territories|nunavut|yukon)\b/i],
  ['USD', /\b(?:united states(?: of america)?|u\.?s\.?a?\.?|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i],
  ['GBP', /\b(?:united kingdom|great britain|england|scotland|wales|northern ireland)\b/i],
  ['EUR', /\b(?:ireland|germany|deutschland|france|spain|italy|netherlands|belgium|austria|portugal|finland|greece|luxembourg|estonia|latvia|lithuania|slovakia|slovenia|croatia|cyprus|malta)\b/i],
  ['AUD', /\b(?:australia|new south wales|queensland|victoria,? australia|western australia|south australia|tasmania|australian capital territory)\b/i],
  ['NZD', /\bnew zealand\b/i], ['INR', /\bindia\b/i], ['SGD', /\bsingapore\b/i], ['JPY', /\bjapan\b/i],
  ['CNY', /\bchina\b/i], ['HKD', /\bhong kong\b/i], ['KRW', /\b(?:south korea|republic of korea)\b/i],
  ['CHF', /\bswitzerland\b/i], ['MXN', /\bmexico\b/i], ['BRL', /\bbrazil\b/i],
  ['AED', /\b(?:united arab emirates|uae|dubai|abu dhabi)\b/i], ['ZAR', /\bsouth africa\b/i],
  ['SEK', /\bsweden\b/i], ['NOK', /\bnorway\b/i], ['DKK', /\bdenmark\b/i], ['PLN', /\bpoland\b/i],
  ['TRY', /\b(?:turkey|türkiye)\b/i], ['PHP', /\bphilippines\b/i], ['VND', /\bvietnam\b/i],
];

// These are accepted only after a comma so normal words such as "in" and
// "or" cannot be mistaken for U.S. state abbreviations.
const CANADIAN_PROVINCE_CODE_RE = /,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/i;
const US_STATE_CODE_RE = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\b/i;

/** Return an explicitly stated salary currency, or null when the listing is ambiguous. */
export function explicitSalaryCurrency(salary) {
  const pay = String(salary || '');
  for (const [currency, pattern] of EXPLICIT_CURRENCIES) {
    if (pattern.test(pay)) return currency;
  }
  return null;
}

/**
 * Identify the salary currency without changing the source amount. Listing text
 * always wins; a location fallback is deliberately exposed as an inference.
 */
export function inferSalaryCurrency(salary, location) {
  const explicit = explicitSalaryCurrency(salary);
  if (explicit) return { currency: explicit, inferred: false };

  const place = String(location || '');
  if (!place.trim()) return null;
  if (CANADIAN_PROVINCE_CODE_RE.test(place)) return { currency: 'CAD', inferred: true };
  if (US_STATE_CODE_RE.test(place)) return { currency: 'USD', inferred: true };
  for (const [currency, pattern] of LOCATION_CURRENCIES) {
    if (pattern.test(place)) return { currency, inferred: true };
  }
  return null;
}

export function formatSalaryCurrencyLabel(salary, location) {
  const info = inferSalaryCurrency(salary, location);
  if (!info) return 'Currency not specified';
  return info.inferred ? `${info.currency} · inferred from location` : info.currency;
}
