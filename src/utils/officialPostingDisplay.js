import { normalizeOfficialPosting, OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';

const sameName = (left, right) => String(left || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
  === String(right || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const OUTCOME_LABELS = Object.freeze({ closed: 'Official posting closed',
  unreadable: 'Official posting unreadable', failed: 'Official posting unavailable' });
const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';

/** Display-only facts never replace the card identity used by Board matching. */
export function officialPostingDisplay(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  const unknown = posting?.level === 'L6';
  const employer = unknown ? '' : text(posting?.employer) || text(job.company);
  const postedBy = text(job.postedBy) || (unknown ? text(job.company) : '');
  const via = ['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && employer && postedBy && !sameName(employer, postedBy) ? `via ${postedBy}` : '';
  const title = text(posting?.title) || text(job.title);
  const applyUrl = normalizeJobListingExternalUrl({ ...job, url: posting?.officialApplyUrl || job.url });
  const outcomeLabel = posting?.outcome === 'ambiguous'
    ? `Ambiguous: ${posting.alternatives?.length || 0} candidates` : OUTCOME_LABELS[posting?.outcome] || '';
  return {
    employer, postedBy, via, employerLabel: employer || postedBy || 'Employer unknown',
    label: employer || postedBy || title || 'job', title,
    location: text(posting?.location?.display) || text(job.location), salary: text(posting?.salary?.text) || text(job.salary),
    levelLabel: OFFICIAL_POSTING_LABELS[posting?.level] || '',
    statusLabel: [unknown ? 'poster, employer unknown' : '', outcomeLabel].filter(Boolean).join(' · '),
    applyUrl,
  };
}
