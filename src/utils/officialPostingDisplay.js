import { boardClosedBoardLabel, normalizeBoardClosed, normalizeOfficialPosting, officialPostingLookupStatus, OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';
import { officialPostingNegativeNeedsRecheck } from '../../electron/ipc/officialPostingNegativePolicy.js';

const sameName = (left, right) => String(left || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  === String(right || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

// Renderer freshness is only a structural indicator. The host compares the
// receipt's input/source hashes before reusing a saved research decision.
function hasSemanticReceipt(posting) {
  return posting?.trail?.includes('semantic-match-v1') && posting.semanticMatch?.version === 1
    && /^[a-f0-9]{64}$/u.test(posting.semanticMatch.inputHash || '')
    && (!['L1', 'L2', 'L3', 'L4'].includes(posting.level)
      || /^[a-f0-9]{64}$/u.test(posting.semanticMatch.sourceHash || ''));
}

export function officialPostingNeedsRefresh(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  return !posting || !hasSemanticReceipt(posting) || officialPostingNegativeNeedsRecheck(posting)
    || officialPostingLookupStatus(posting).retryable;
}

/** A row the job board reported closed stays visible only because the official source decides, so say which case this is. */
function boardClosedStatus(job, status) {
  const closed = normalizeBoardClosed(job.boardClosed);
  const board = closed ? boardClosedBoardLabel(closed.board) : '';
  if (!board) return null;
  if (status.state === 'verified' && !status.retryable) return `Closed on ${board} · open on official site`;
  return `Closed on ${board} · ${status.label}`;
}

/** Display-only facts never replace the card identity used by Board matching. */
export function officialPostingDisplay(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  const savedStatus = officialPostingLookupStatus(posting);
  const outdated = !!posting && (!hasSemanticReceipt(posting) || officialPostingNegativeNeedsRecheck(posting));
  const status = outdated && !savedStatus.retryable ? { ...savedStatus, state: 'outdated', retryable: true,
    label: savedStatus.state === 'verified' ? 'Previous official posting · check again' : 'Outdated lookup · check again',
    detail: 'This saved result predates the current verification checks. Check the official posting again to get a current result.' } : savedStatus;
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
    lookupState: status.state,
    lookupRetryable: status.retryable,
    lookupNeedsRefresh: officialPostingNeedsRefresh(job),
    lookupActionLabel: savedStatus.state === 'unchecked' ? 'Check official posting' : 'Retry lookup',
    candidateLinks: (posting?.alternatives || []).filter(item => item.title.startsWith('Unconfirmed'))
      .slice(0, 3).map((item, index) => ({ url: item.url, title: item.title, rank: index + 1 })),
    applyUrl,
    viewUrl: closedOfficialUrl || applyUrl,
    viewLabel: closedOfficialUrl ? 'View official posting previously marked closed'
      : levelLabel ? `${levelLabel} · Open job listing` : 'Open job listing',
  };
}
