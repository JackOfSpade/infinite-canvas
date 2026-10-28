const PAY_ANCHOR = /\b(?:salary|salaries|base pay|base compensation|compensation(?: range)?|cash pay|pay range|pay rate|hourly pay|annual pay|wages?)\b/i;
const MONEY = /(?:US\$|CA?\$|\$|€|£|\b(?:USD|CAD|EUR|GBP)\s*)\s*\d[\d,.]*(?:\s*[km]\b)?/gi;
const NON_PAY = /\b(?:revenue|funding|raised|valuation|budget|signing|referral|grant|stock|equity|RSUs?)\b/i;
const PAY_RANGE = /(?:(?:US\$|CA?\$|\$|€|£|USD|CAD|EUR|GBP)\s*)?(\d[\d,.]*)\s*([km])?\s*(?:USD|CAD|EUR|GBP)?\s*(?:[-–—]|\bto\b|\band\b)\s*(?:(?:US\$|CA?\$|\$|€|£|USD|CAD|EUR|GBP)\s*)?(\d[\d,.]*)\s*([km])?/gi;

function currenciesIn(text) {
  return [...new Set((text.match(/\b(?:USD|CAD|EUR|GBP)\b|US\$|CA?\$|€|£/gi) || []).map(value =>
    /^(?:US\$|USD)$/i.test(value) ? 'USD' : /^(?:CA?\$|CAD)$/i.test(value) ? 'CAD'
      : /^(?:€|EUR)$/i.test(value) ? 'EUR' : 'GBP'))].sort();
}

// A posting can repeat one band in its salary paragraph and a wage notice.
// Different labels do not make those equal amounts two competing offers.
// Deduplicate only a complete single band, retaining ambiguity for additional
// amounts, differing currencies, or differing pay periods.
function repeatedBandKey(line) {
  const ranges = [...line.matchAll(PAY_RANGE)];
  if (ranges.length !== 1) return '';
  const range = ranges[0];
  if ([...line.matchAll(MONEY)].some(match => match.index < range.index || match.index >= range.index + range[0].length)) return '';
  const numbers = [Number(range[1].replace(/,/g, '')), Number(range[3].replace(/,/g, ''))];
  const suffixes = [range[2] || '', range[4] || ''];
  if (!suffixes[0] && suffixes[1] && numbers[0] < 1000) suffixes[0] = suffixes[1];
  if (!suffixes[1] && suffixes[0] && numbers[1] < 1000) suffixes[1] = suffixes[0];
  const amounts = numbers.map((number, index) => number * (/k/i.test(suffixes[index]) ? 1000 : /m/i.test(suffixes[index]) ? 1000000 : 1));
  if (amounts.some(number => !Number.isFinite(number) || number <= 0)) return '';
  const currencies = currenciesIn(line);
  const periods = [...new Set((line.match(/\/\s*(?:hours?|hrs?|h|weeks?|wks?|months?|mos?|days?|years?|yrs?)\b|\b(?:per|an?)\s+(?:hour|hr|week|wk|month|mo|day|year|yr)\b|\b(?:hourly|weekly|monthly|daily|annual(?:ly)?|yearly)\b/gi) || []).map(value =>
    /hour|hr|\/\s*h\b/i.test(value) ? 'hourly' : /week|wk/i.test(value) ? 'weekly' : /month|mo\b/i.test(value) ? 'monthly' : /day|daily/i.test(value) ? 'daily' : 'annual'))];
  const basisText = line.replace(/\b(?:(?:do(?:es)?|will) not include|exclud(?:e[sd]?|ing)|without)\b[^.!?\n]*(?:[.!?]|$)/gi, '');
  const variableBasis = [...new Set((basisText.match(/\b(?:total\s+(?:comp(?:ensation)?|rewards?)|OTE|on[-\s]?target earnings|bonus(?:es)?|commission|equity|stock|tips?)\b/gi) || []).map(value => value.toLowerCase()))].sort();
  // Explicitly scoped bands must keep their location labels even when their
  // numbers happen to match. Ordinary "depending on your location" wording
  // does not identify a second salary market.
  const scope = [...line.matchAll(/\b(?:in|within|for|based in|located in)\s+([A-Z][\p{L}.]+(?:[ ,]+[A-Z][\p{L}.]+){0,5})/gu)].map(match => match[1]);
  const prefix = line.slice(0, line.search(PAY_ANCHOR)).trim().replace(/\bbase\s*$/i, '').trim();
  if (/^[A-Z][\p{L}.]+(?:[ ,]+[A-Z][\p{L}.]+){0,4}$/u.test(prefix)
    && !/^(?:annual(?:ly)?|yearly|hourly|weekly|monthly|daily|target(?:ed)?|minimum|maximum|starting)$/i.test(prefix)) scope.push(prefix);
  return JSON.stringify({ amounts, currencies, periods: periods.length ? periods.sort() : ['annual'], variableBasis, scope });
}

/** Read pay from the posting's own description when a scraper left salary blank.
 * Keep the surrounding labels, currencies, and cadence: a naked first amount
 * can turn OTE, a foreign range, or a lower bound into a fictitious base offer.
 */
export function advertisedSalaryForJob(job = {}) {
  const field = [job.salary, job.compensation].find(value => typeof value === 'string' && value.trim());
  if (field) return { text: field.trim(), source: 'salary_field', reasonCode: '' };
  // A whole external careers page can contain other jobs' pay. It is not an
  // authoritative description of this individual posting.
  if (job.descriptionCapture === 'external-page-full-text') {
    return { text: '', source: 'none', reasonCode: 'description_scope_unclear' };
  }
  const description = (typeof job.description === 'string' && job.description.trim()
    ? job.description : typeof job.snippet === 'string' ? job.snippet : '').slice(0, 100_000);
  const lines = description.split(/[\r\n]+|(?<=[.!?])\s+/u).map(line => line.trim()).filter(Boolean);
  const candidates = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!PAY_ANCHOR.test(line)) continue;
    // Labels and level ranges are often on separate adjacent lines. Retain
    // each labeled band separately so a repeated notice can be deduplicated,
    // while genuinely distinct levels still make the offer ambiguous.
    const payLines = line.match(MONEY) ? [line]
      : lines.slice(index + 1, index + 3).filter(value => value.match(MONEY)).map(value => `${line} ${value}`);
    for (const payLine of payLines) {
      if (payLine.length > 1200 || (NON_PAY.test(payLine) && !/\b(?:base (?:salary|pay|compensation)|salary range)\b/i.test(payLine))) continue;
      candidates.add(payLine);
    }
  }
  if (!candidates.size) return { text: '', source: 'none', reasonCode: 'no_cash_salary' };
  // Check all original labels: dropping a repeated numeric band must never
  // erase a conflicting currency or country from its other occurrence.
  const originalText = [...candidates].join('\n');
  const currencies = currenciesIn(originalText);
  const countries = /\b(?:US|USA|United States)\b/i.test(originalText) && /\bCanada|Canadian\b/i.test(originalText);
  const seenBands = new Set();
  const distinctCandidates = [...candidates].filter(line => {
    const key = repeatedBandKey(line);
    if (!key) return true;
    if (seenBands.has(key)) return false;
    seenBands.add(key);
    return true;
  });
  const text = distinctCandidates.join('\n').slice(0, 2400);
  const rangeCount = [...text.matchAll(/\d[\d,.]*\s*[km]?\s*(?:USD|CAD|EUR|GBP)?\s*(?:[-–—]|\bto\b|\band\b)\s*(?:(?:US\$|CA?\$|\$|€|£|USD|CAD|EUR|GBP)\s*)?\d/gi)].length;
  return { text, source: 'description', reasonCode: distinctCandidates.length > 1 || currencies.length > 1 || rangeCount > 1 || countries
    ? 'ambiguous_description_salary' : '' };
}
