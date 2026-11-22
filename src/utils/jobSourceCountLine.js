import { JOB_SOURCE_BY_ID } from './constants.js';

/** A listing count with thousands separators. */
export function formatSourceCount(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
}

/**
 * The all-sites line on a running Job Search: every site's own count, largest
 * first, then the sum. Each site counts its own listings; the same job on two
 * sites counts twice until the later cross-site de-duplication.
 *
 * It used to read "11837 listings currently reported by sources (before
 * de-duplication)" and sat right after the active site's detail, so on
 * 2026-11-22 a Glassdoor pause line followed by it read as Glassdoor's count.
 */
export function allSitesCollectedLine(total, sourceCounts) {
  const parts = Object.entries(sourceCounts && typeof sourceCounts === 'object' ? sourceCounts : {})
    .map(([sourceId, progress]) => [sourceId, Math.max(0, Number(progress?.count) || 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([sourceId, count]) => `${JOB_SOURCE_BY_ID[sourceId]?.name || sourceId} ${formatSourceCount(count)}`);
  const sum = `${formatSourceCount(total)} listing${total === 1 ? '' : 's'} found so far across all sites`;
  const caveat = 'a job listed on two sites counts twice';
  return parts.length > 0 ? `All sites: ${parts.join(', ')} (${sum}; ${caveat})` : `${sum} (${caveat})`;
}
