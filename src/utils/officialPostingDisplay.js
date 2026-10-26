import { boardClosedBoardLabel, normalizeBoardClosed, normalizeOfficialPosting, officialResearchSettled, OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';

const sameName = (left, right) => String(left || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  === String(right || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const OUTCOME_LABELS = Object.freeze({ closed: 'Official posting closed',
  unreadable: 'Official posting unreadable', failed: 'Official posting unavailable' });
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

/** A row the job board reported closed stays visible only because the official source decides, so say which case this is. */
function boardClosedStatus(job, posting, outcomeLabel) {
  const closed = normalizeBoardClosed(job.boardClosed);
  const board = closed ? boardClosedBoardLabel(closed.board) : '';
  if (!board) return null;
  if (['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && ['found', 'link-only'].includes(posting.outcome)) return `Closed on ${board} · open on official site`;
  if (posting?.outcome === 'ambiguous' || posting?.trail?.includes('comparative-disagree')) return `Closed on ${board} · several official postings match`;
  if (officialResearchSettled(posting)) return [`Closed on ${board}`, outcomeLabel].filter(Boolean).join(' · ');
  return `Closed on ${board} · official posting not checked`;
}

/** Display-only facts never replace the card identity used by Board matching. */
export function officialPostingDisplay(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  const unknown = posting?.level === 'L6';
  const unnamedOfficial = posting?.level === 'L4' && !text(posting.employer);
  const employer = unknown || unnamedOfficial ? '' : text(posting?.employer) || text(job.company);
  const postedBy = text(job.postedBy) || (unknown || unnamedOfficial ? text(job.company) : '');
  const via = ['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && postedBy && (!employer || !sameName(employer, postedBy)) ? `via ${postedBy}` : '';
  const employerLabel = unnamedOfficial ? 'Employer unknown' : employer || postedBy || 'Employer unknown';
  const title = text(posting?.title) || text(job.title);
  const applyUrl = normalizeJobListingExternalUrl({ ...job, url: posting?.officialApplyUrl || job.url });
  const outcomeLabel = posting?.outcome === 'ambiguous'
    ? `Ambiguous: ${posting.alternatives?.length || 0} candidates` : OUTCOME_LABELS[posting?.outcome] || '';
  return {
    employer, postedBy, via, employerLabel, unnamedOfficial,
    label: unnamedOfficial ? [employerLabel, via].filter(Boolean).join(' · ') : employer || postedBy || title || 'job', title,
    location: text(posting?.location?.display) || text(job.location), salary: text(posting?.salary?.text) || text(job.salary),
    levelLabel: OFFICIAL_POSTING_LABELS[posting?.level] || '',
    statusLabel: [unknown ? 'poster, employer unknown' : '', boardClosedStatus(job, posting, outcomeLabel) ?? outcomeLabel].filter(Boolean).join(' · '),
    applyUrl,
  };
}
