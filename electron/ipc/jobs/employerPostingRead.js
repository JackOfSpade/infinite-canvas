import { getOfficialPostingStore, getOfficialPostingView, resolveOfficialPostings } from '../officialPostingService.js';
import { TEXT_LEVELS } from '../officialPostingFields.js';
import { hasResolvedJobDescription } from './sourceRules.js';
import { EMPLOYER_POSTING_READ_SOURCE_IDS } from '../../../src/utils/jobSourceWarningPolicy.js';


// Each listing costs one research request and at least two judge requests, and
// none of them has a fit score yet, so one Skip reads a bounded number.
export const EMPLOYER_POSTING_READ_MAX_LISTINGS = 25;

export function canReadFromEmployerPostings(sourceId) {
  return EMPLOYER_POSTING_READ_SOURCE_IDS.has(sourceId);
}

/**
 * Read listings a platform would not open from each employer's own posting.
 *
 * The one posting finder does all the finding and judging; this only asks it
 * and copies the text it verified onto the listing. A listing is returned as
 * read only when the finder settled on an open posting and its saved text is
 * long enough to score. Everything else comes back unchanged in `unread`.
 */
export async function readListingsFromEmployerPostings(listings, {
  signal, nodeId, manualAiRunId, onProgress,
  resolve = resolveOfficialPostings, getView = getOfficialPostingView, store,
} = {}) {
  const candidates = (Array.isArray(listings) ? listings : []).slice(0, EMPLOYER_POSTING_READ_MAX_LISTINGS);
  const outcome = { attempted: candidates.length, read: [], unread: [], outcomes: {} };
  if (candidates.length === 0) return outcome;
  try { store ||= getOfficialPostingStore(); } catch { store = null; }
  const resolved = await resolve(candidates, { signal, nodeId, manualAiRunId, onProgress, ...(store ? { store } : {}) });
  const rows = Array.isArray(resolved?.jobs) ? resolved.jobs : [];
  for (const [index, candidate] of candidates.entries()) {
    const row = rows[index];
    const posting = row?.officialPosting;
    const settled = posting?.outcome || 'failed';
    outcome.outcomes[settled] = (outcome.outcomes[settled] || 0) + 1;
    let description = '';
    if (posting?.outcome === 'found' && TEXT_LEVELS.has(posting.level)) {
      try {
        const view = await getView(row, { store, signal, requireSemantic: false });
        if (view?.officialPosting && typeof view.description === 'string') description = view.description.trim();
      } catch { description = ''; }
    }
    const read = description ? {
      ...candidate,
      snippet: description,
      descriptionSource: 'employer-posting',
      officialPosting: posting,
      ...(row.postedBy ? { postedBy: row.postedBy } : {}),
    } : null;
    if (read) delete read.descriptionDeferredReason;
    if (read && hasResolvedJobDescription(read)) outcome.read.push({ candidate, row: read });
    else outcome.unread.push(candidate);
  }
  return outcome;
}
