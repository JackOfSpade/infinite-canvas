import { extractAtsTenant } from './officialSourceHosts.js';
import { reportScrapeHealth, scrapeShareBroken } from './scrapeAlarms.js';

/**
 * A site changing its pages, or our reader breaking, shows up on a card as "couldn't confirm", the same as a posting
 * that honestly isn't there. This watches the reads themselves over the recent past, because most lookups cover one card
 * and a few leads, and raises one alarm per read surface when a large share of a big enough sample failed. AI transport
 * failures never reach it: only downloads count. A page counts by what a person's browser could get in the end: a plain
 * download the render then recovered lost nothing, and the log below can only show that final outcome.
 */
// Page and render limits: measured 2026-11-05 from the judgments log, worst hour 8 bad of 200 page reads (4%) and 8 of 232 renders (3.4%).
// 20 reads because one lookup can hold several dead links to a domain an AI guessed; those are a small share of a longer window.
const BROAD = { minAttempts: 20, minBad: 8, maxShare: 0.3 };
// Provisional: the log held only 168 board-data reads (0 bad) over 4 hours, spread over 7 vendors.
const PER_VENDOR = { minAttempts: 5, minBad: 3, maxShare: 0.5 };
// Reads gathered before a long run reports, and how many recent reads each surface is judged on.
export const OFFICIAL_READ_WINDOW = 50;
export const OFFICIAL_RECENT_READS = 100;
// A block already has its own message, and these renders never tried to read the site.
// 202 is a firewall challenge: AptDeco answered one live on 2026-11-05, and it is the only status on the 8 unread pages in the log.
const KNOWN_BLOCK_STATUSES = new Set([202, 401, 403, 429]);
const RENDER_NOT_A_READ = new Set(['aborted', 'busy', 'blocked', 'unsafe-address']);
const VENDOR = /^[a-z0-9][a-z0-9_-]{0,39}$/u;

/** Every download this lookup made, as {kind, ...}. `plain` is each lead's snapshot before the browser rendered it, which the rendered one replaces. */
export function officialPostingReadObservations({ leads = [], plain = [], final = [] } = {}) {
  const out = [];
  leads.forEach((lead, index) => {
    const first = plain[index]; const last = final[index];
    if (lead?.dataUrl) {
      if (first && !(first.read !== true && KNOWN_BLOCK_STATUSES.has(first.httpStatus))) {
        const route = extractAtsTenant(lead.url);
        const vendor = String(route?.ats || '').toLowerCase();
        if (VENDOR.test(vendor)) out.push({ kind: 'ats', vendor, tenant: String(route?.tenant || lead.url),
          bad: (first.read !== true && !first.notFound) || (first.read === true && first.postingsInData === 0) });
      }
    } else if (last && !(last.read !== true && (KNOWN_BLOCK_STATUSES.has(last.httpStatus) || RENDER_NOT_A_READ.has(last.renderFailed)))) {
      out.push({ kind: 'page', bad: last.read !== true && !last.notFound });
    }
    if (last?.rendered === true) out.push({ kind: 'render', bad: false });
    else if (last?.renderFailed && !RENDER_NOT_A_READ.has(last.renderFailed)) out.push({ kind: 'render', bad: true });
  });
  return out;
}

const SURFACES = {
  page: { key: 'official:page', surface: 'Official posting pages', site: 'Employer pages', limits: BROAD, what: 'Employer pages are failing to download' },
  render: { key: 'official:render', surface: 'Official posting pages', site: 'Throwaway browser', limits: BROAD, what: 'The throwaway browser is failing to load pages' },
};

/** Alarms to raise or clear for one run's observations. A surface with too few reads is left out, so its alarm stays as it was. Pure. */
export function assessOfficialPostingReads(observations) {
  const tally = new Map();
  // An employer with no open jobs answers its board with zero postings, so each employer counts once per vendor, by its
  // latest read: it takes several employers at once to look like a changed format.
  const latestByTenant = new Map();
  const reads = [];
  for (const item of Array.isArray(observations) ? observations : []) {
    if (item?.kind === 'ats' && item.tenant) latestByTenant.set(`${item.vendor}\u0000${item.tenant}`, item);
    else reads.push(item);
  }
  for (const item of [...reads, ...latestByTenant.values()]) {
    const id = item?.kind === 'ats' ? `ats:${item.vendor}` : item?.kind;
    if (!id || (item.kind === 'ats' ? !VENDOR.test(String(item.vendor)) : !SURFACES[item.kind])) continue;
    const entry = tally.get(id) || { kind: item.kind, vendor: item.vendor, attempts: 0, bad: 0 };
    entry.attempts += 1; if (item.bad === true) entry.bad += 1;
    tally.set(id, entry);
  }
  const reports = [];
  for (const { kind, vendor, attempts, bad } of tally.values()) {
    const spec = kind === 'ats'
      ? { key: `official:ats:${vendor}`, surface: 'Official posting board data', site: vendor, limits: PER_VENDOR, what: 'Hiring platform board data is failing to download or comes back with no postings' }
      : SURFACES[kind];
    if (scrapeShareBroken({ attempts, bad, ...spec.limits })) {
      reports.push({ key: spec.key, surface: spec.surface, site: spec.site, failure: { what: spec.what, attempts, bad } });
    } else if (attempts - bad >= spec.limits.minAttempts) {
      reports.push({ key: spec.key, surface: spec.surface, site: spec.site, failure: null });
    }
  }
  return reports;
}

const recentReads = new Map();
const surfaceId = item => (item.kind === 'ats' ? `ats:${item.vendor}` : item.kind);
export function resetOfficialPostingReadHealthForTests() { recentReads.clear(); }

/** Gathers a lookup run's reads into the recent past. Never throws, and drops a run that was cancelled, since its downloads were cut short by that. */
export function createOfficialPostingReadMonitor({ signal, report = reportScrapeHealth, windowSize = OFFICIAL_READ_WINDOW } = {}) {
  let pending = [];
  const flush = () => {
    const batch = pending; pending = [];
    if (!batch.length || signal?.aborted) return;
    try {
      for (const item of batch) {
        const id = surfaceId(item);
        recentReads.set(id, [...(recentReads.get(id) || []), item].slice(-OFFICIAL_RECENT_READS));
      }
      for (const item of assessOfficialPostingReads([...recentReads.values()].flat())) report(item);
    } catch { /* A failed alarm never disturbs the lookup. */ }
  };
  return {
    observe(snapshots) {
      try {
        if (signal?.aborted) return;
        pending.push(...officialPostingReadObservations(snapshots));
        if (pending.length >= windowSize) flush();
      } catch { /* Same. */ }
    },
    flush,
  };
}
