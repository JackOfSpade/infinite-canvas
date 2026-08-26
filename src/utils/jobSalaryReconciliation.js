import { parseSalaryToNumeric } from '../nodes/jobsearch/buildJobTree.js';

const PAY_LABEL = String.raw`\b(?:base\s+)?(?:pay(?:\s+range|\s+rate)?|salary(?:\s+range)?|compensation|wage(?:\s+range)?|hourly\s+rate)\b`;
const MONEY = String.raw`([$€£])\s*(\d[\d,]*(?:\.\d+)?)`;
const CADENCE = String.raw`(\/\s*(?:yr|year|hr|hour|mo|month|wk|week|day)|(?:per|a|an)\s+(?:year|hour|month|week|day|annum)|annually|annual|yearly|monthly|weekly|daily|hourly)`;
const DESCRIPTION_PAY_RE = new RegExp(
  String.raw`${PAY_LABEL}[^$€£\n]{0,24}${MONEY}(?:\s*(?:-|–|—|to)\s*([$€£])?\s*(\d[\d,]*(?:\.\d+)?))?\s*((?:USD|CAD|AUD|EUR|GBP)\b)?\s*${CADENCE}\b`,
  'i',
);

function numericAmount(raw) {
  const value = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function compactNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Recover a Glassdoor list-card salary only when the same job's recovered full
 * description labels an amount as pay and states its cadence explicitly.
 *
 * This deliberately does not fill blank salaries, touch another source, or
 * infer hourly/annual from magnitude. A provider's already-parseable list value
 * also wins unchanged. The one normalization below handles Glassdoor's observed
 * "$1 - $100K" artifact: when the description repeats that as an explicitly
 * annual $1-to-$100,000 range, the implausible lower sentinel is discarded and
 * the grounded ceiling is represented as "Up to $100,000/yr".
 */
export function reconcileGlassdoorSalaryFromDescription(job) {
  if (!job || String(job.source || '').toLowerCase() !== 'glassdoor') return job;
  const raw = String(job.salary || '').trim();
  if (!raw || !/[$€£]\s*\d/.test(raw) || parseSalaryToNumeric(raw) > 0) return job;

  const description = String(job.description || job.snippet || '').replace(/\r/g, '');
  const match = DESCRIPTION_PAY_RE.exec(description);
  if (!match) return job;

  const [, symbol, firstRaw, secondSymbol, secondRaw, currency = '', cadence] = match;
  const first = numericAmount(firstRaw);
  const second = numericAmount(secondRaw);
  const currencyPrefix = currency ? `${currency.toUpperCase()} ` : '';
  const rangeSymbol = secondSymbol || symbol;
  const captured = secondRaw
    ? `${currencyPrefix}${symbol}${firstRaw} - ${rangeSymbol}${secondRaw} ${cadence}`
    : `${currencyPrefix}${symbol}${firstRaw} ${cadence}`;
  const normalized = captured.replace(/\s+/g, ' ').replace(/\s+\//g, '/').trim();
  if (parseSalaryToNumeric(normalized) > 0) return { ...job, salary: normalized };

  // The shared annualizer intentionally rejects tiny explicit annual minima.
  // Glassdoor currently emits exactly that sentinel shape for some listings.
  // Retain only the description's stated upper ceiling, and only when the unit
  // is explicitly annual and the ceiling is itself a plausible annual amount.
  const annual = /(?:\/\s*(?:yr|year)|\b(?:per|a|an)\s+(?:year|annum)\b|\b(?:annually|annual|yearly)\b)/i.test(cadence);
  if (annual && first != null && first > 0 && first < 1_000
      && second != null && second >= 10_000 && second <= 2_000_000) {
    return { ...job, salary: `Up to ${currencyPrefix}${rangeSymbol}${compactNumber(second)}/yr` };
  }

  return job;
}
