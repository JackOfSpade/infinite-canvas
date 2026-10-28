import { boardClosedBoardLabel, normalizeBoardClosed, normalizeOfficialPosting, officialPostingLookupStatus, OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';

const sameName = (left, right) => String(left || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  === String(right || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

/** A row the job board reported closed stays visible only because the official source decides, so say which case this is. */
function boardClosedStatus(job, status) {
  const closed = normalizeBoardClosed(job.boardClosed);
  const board = closed ? boardClosedBoardLabel(closed.board) : '';
  if (!board) return null;
  if (status.state === 'verified') return `Closed on ${board} · open on official site`;
  return `Closed on ${board} · ${status.label}`;
}

/** Display-only facts never replace the card identity used by Board matching. */
export function officialPostingDisplay(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  const status = officialPostingLookupStatus(posting);
  const unknown = posting?.level === 'L6';
  const unnamedOfficial = posting?.level === 'L4' && !text(posting.employer);
  const employer = unknown || unnamedOfficial ? '' : text(posting?.employer) || text(job.company);
  const postedBy = text(job.postedBy) || (unknown || unnamedOfficial ? text(job.company) : '');
  const via = ['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && postedBy && (!employer || !sameName(employer, postedBy)) ? `via ${postedBy}` : '';
  const employerLabel = unnamedOfficial ? 'Employer unknown' : employer || postedBy || 'Employer unknown';
  const title = text(posting?.title) || text(job.title);
  const applyUrl = normalizeJobListingExternalUrl({ ...job, url: status.applyUrl || status.sourceUrl || job.url });
  const closedOfficialUrl = ['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && posting.outcome === 'closed'
    ? posting.sourceUrl || '' : '';
  const levelLabel = OFFICIAL_POSTING_LABELS[posting?.level] || '';
  return {
    employer, postedBy, via, employerLabel, unnamedOfficial,
    label: unnamedOfficial ? [employerLabel, via].filter(Boolean).join(' · ') : employer || postedBy || title || 'job', title,
    location: text(posting?.location?.display) || text(job.location), salary: text(posting?.salary?.text) || text(job.salary),
    levelLabel,
    statusLabel: [unknown ? 'poster, employer unknown' : '', boardClosedStatus(job, status) ?? status.label].filter(Boolean).join(' · '),
    statusDetail: status.detail,
    applyUrl,
    viewUrl: closedOfficialUrl || applyUrl,
    viewLabel: closedOfficialUrl ? 'View official posting previously marked closed'
      : levelLabel ? `${levelLabel} · Open job listing` : 'Open job listing',
  };
}
