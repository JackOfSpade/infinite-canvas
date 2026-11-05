import { SOURCE_HEALTH_FAILED_CODE, describeSourceHealthFailures } from '../../src/utils/jobCollectionScopeCaveats.js';

/**
 * Notices when a job site changed under the scraper. A broken selector doesn't throw: it returns rows with a blank
 * field, and a later gate quietly discards them, so a whole site can vanish while every step reports success.
 * This compares each site's collected rows with what that site normally fills, before any gate drops them.
 *
 * Limits come from what real searches filled on 2026-11-03: link, description, company and location were at 96-100%
 * on working sites. A posted date is often absent, on Google especially (38-70%).
 */
export const SOURCE_HEALTH_WARNING_CODE = SOURCE_HEALTH_FAILED_CODE;
/** Below this many rows a share says little: a few odd listings aren't a broken site. */
export const SOURCE_HEALTH_MIN_ROWS = 20;
const DEFAULT_MAX_MISSING_SHARE = 0.25;
const DESCRIPTION_MIN_CHARS = 400;

const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const FIELD_CHECKS = Object.freeze([
  { field: 'link', present: row => Boolean(text(row?.url) || (Array.isArray(row?.applyOptions) && row.applyOptions.length)) },
  { field: 'description', present: row => !row?.descriptionDeferredReason && text(row?.snippet || row?.description).length >= DESCRIPTION_MIN_CHARS },
  { field: 'company', present: row => Boolean(text(row?.company)) },
  { field: 'location', present: row => Boolean(text(row?.location)) },
  { field: 'posted', present: row => Boolean(text(row?.posted)), maxMissingShare: 0.5, maxMissingShareBySource: { google: 0.8 } },
]);
/** Often blank on a single row, but these sites have shown pay on most rows, so none at all means the reader broke. */
const SALARY_USUALLY_SHOWN = Object.freeze(new Set(['glassdoor', 'ziprecruiter', 'dice', 'google']));
/** A large site that returns nothing and reports no reason has failed silently, when others found plenty for the same search. Small boards can honestly have nothing. */
const OTHER_SITES_ROWS_FOR_SILENCE = 50;
const SOURCES_THAT_ALWAYS_HAVE_ROWS = Object.freeze(new Set(['google', 'indeed', 'linkedin', 'ziprecruiter', 'glassdoor']));
/** One description under different employers means a reader saved the wrong job's text. Reposts by one employer are normal. */
const MAX_SAME_DESCRIPTION_SHARE = 0.1;

function rowsRepeatingAnotherEmployersDescription(list) {
  const employersByText = new Map();
  let repeats = 0;
  for (const row of list) {
    const description = text(row?.snippet || row?.description);
    const company = text(row?.company).toLowerCase();
    if (description.length < DESCRIPTION_MIN_CHARS || !company) continue;
    const employers = employersByText.get(description);
    if (!employers) { employersByText.set(description, new Set([company])); continue; }
    if (!employers.has(company)) repeats += 1;
    employers.add(company);
  }
  return repeats;
}

/**
 * @param {object[]} rows every row collected this run, before any description or scoring gate
 * @param {{ silentlyEmptySourceIds?: string[] }} [options] sites searched that returned nothing and gave no warning of their own
 * @returns {Array<{ source: string, field: string, rows: number, missing: number, share: number, limit: number }>}
 */
export function assessSourceHealth(rows, { silentlyEmptySourceIds = [] } = {}) {
  const bySource = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const source = text(row?.source).toLowerCase();
    if (!source) continue;
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(row);
  }
  const failures = [];
  for (const [source, list] of bySource) {
    if (list.length < SOURCE_HEALTH_MIN_ROWS) continue;
    for (const check of FIELD_CHECKS) {
      const missing = list.filter(row => !check.present(row)).length;
      const limit = check.maxMissingShareBySource?.[source] ?? check.maxMissingShare ?? DEFAULT_MAX_MISSING_SHARE;
      if (missing / list.length > limit) failures.push({ source, field: check.field, rows: list.length, missing, share: missing / list.length, limit });
    }
    const repeats = rowsRepeatingAnotherEmployersDescription(list);
    if (repeats / list.length > MAX_SAME_DESCRIPTION_SHARE) failures.push({ source, field: 'same-description', rows: list.length, missing: repeats, share: repeats / list.length, limit: MAX_SAME_DESCRIPTION_SHARE });
    if (SALARY_USUALLY_SHOWN.has(source) && !list.some(row => text(row?.salary))) {
      failures.push({ source, field: 'salary', rows: list.length, missing: list.length, share: 1, limit: 1 });
    }
  }
  const totalRows = [...bySource.values()].reduce((sum, list) => sum + list.length, 0);
  for (const source of silentlyEmptySourceIds) {
    if (totalRows >= OTHER_SITES_ROWS_FOR_SILENCE && SOURCES_THAT_ALWAYS_HAVE_ROWS.has(source) && !bySource.has(source)) failures.push({ source, field: 'rows', rows: 0, missing: 0, share: 1, limit: 0 });
  }
  return failures;
}

/**
 * One warning per broken site, in the shape every other source warning uses. It stays non-gating on purpose: a block
 * would pause scoring for every other site's good rows. The loud part is the UI that reads this code.
 */
export function sourceHealthWarning(source, failures) {
  const own = failures.filter(item => item.source === source);
  if (!own.length) return null;
  return {
    code: SOURCE_HEALTH_WARNING_CODE,
    severity: 'warn',
    shortLabel: 'Results look broken',
    evidence: describeSourceHealthFailures(own).slice(0, 600),
    suggestion: 'This site may have changed, so the scraper may need a fix. Its results are incomplete until then. Send a bug report.',
  };
}
