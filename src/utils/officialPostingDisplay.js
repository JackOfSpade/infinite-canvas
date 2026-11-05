import { mostOfficialSource, normalizeOfficialPosting, officialPostingClosureReadFullPage, officialPostingExhausted, officialPostingLookupStatus, OFFICIAL_POSTING_LABELS } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';
import { officialPostingNegativeNeedsRecheck } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { researchSkipReason, RESEARCH_MIN_FIT_SCORE } from '../../electron/ipc/researchGate.js';

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
  if (officialPostingExhausted(posting)) return false;
  return !posting || !hasSemanticReceipt(posting) || (posting.outcome === 'closed' && !officialPostingClosureReadFullPage(posting)) || officialPostingNegativeNeedsRecheck(posting)
    || officialPostingLookupStatus(posting).retryable;
}

/** Display-only facts never replace the card identity used by Board matching. */
export function officialPostingDisplay(job = {}) {
  const posting = normalizeOfficialPosting(job.officialPosting);
  const savedStatus = officialPostingLookupStatus(posting);
  const exhausted = officialPostingExhausted(posting);
  const outdated = !!posting && !exhausted && (!hasSemanticReceipt(posting) || officialPostingNegativeNeedsRecheck(posting));
  const currentStatus = outdated && !savedStatus.retryable ? { ...savedStatus, state: 'outdated', retryable: true,
    label: savedStatus.state === 'verified' ? 'Previous official posting · check again' : 'Outdated lookup · check again',
    detail: 'This saved result predates the current verification checks. Check the official posting again to get a current result.' } : savedStatus;
  // A row outside a scored Board (an application dock entry, an export) has no fit to report.
  const skipReason = typeof job.matchScore === 'number' || typeof job.scoreStatus === 'string' ? researchSkipReason(job) : null;
  // An unfinished lookup on a job below the threshold is left over from before the
  // gate, and no automatic work will finish it. A finished result keeps its own state.
  const researchSkipped = Boolean(skipReason) && (!posting || savedStatus.state === 'incomplete');
  const status = researchSkipped ? { ...currentStatus, label: skipReason,
    detail: `Automatic research runs for jobs with a fit score of ${RESEARCH_MIN_FIT_SCORE} or above. Generate or this card's lookup still checks this job.` } : currentStatus;
  const unknown = posting?.level === 'L6';
  const unnamedOfficial = posting?.level === 'L4' && !text(posting.employer);
  const employer = unknown || unnamedOfficial ? '' : text(posting?.employer) || text(job.company);
  const postedBy = text(job.postedBy) || (unknown || unnamedOfficial ? text(job.company) : '');
  // With a confirmed official posting, the card shows that source and nothing from the listings beneath it.
  const officialOnly = mostOfficialSource(job).kind === 'official';
  // An official link that names no employer leaves the poster as the only way to tell which job this is.
  const via = unnamedOfficial && postedBy ? `via ${postedBy}` : '';
  const employerLabel = unnamedOfficial ? 'Employer unknown' : employer || postedBy || 'Employer unknown';
  const title = text(posting?.title) || text(job.title);
  const applyUrl = normalizeJobListingExternalUrl({ ...job, url: status.applyUrl || status.sourceUrl || job.url });
  const closedOfficialUrl = ['L1', 'L2', 'L3', 'L4'].includes(posting?.level) && posting.outcome === 'closed'
    ? posting.sourceUrl || '' : '';
  const levelLabel = OFFICIAL_POSTING_LABELS[posting?.level] || '';
  return {
    employer, postedBy, via, employerLabel, unnamedOfficial,
    label: unnamedOfficial ? [employerLabel, via].filter(Boolean).join(' · ') : employer || postedBy || title || 'job', title,
    officialOnly,
    location: text(posting?.location?.display) || (officialOnly ? '' : text(job.location)),
    salary: text(posting?.salary?.text) || (officialOnly ? '' : text(job.salary)),
    levelLabel,
    statusLabel: [unknown ? 'poster, employer unknown' : '', status.label].filter(Boolean).join(' · '),
    statusDetail: status.detail,
    lookupState: status.state,
    researchSkipped,
    lookupRetryable: status.retryable,
    lookupExhausted: exhausted,
    lookupNeedsRefresh: exhausted || officialPostingNeedsRefresh(job),
    lookupActionLabel: exhausted ? 'Check again' : savedStatus.state === 'unchecked' || researchSkipped ? 'Check official posting' : 'Retry lookup',
    candidateLinks: officialOnly ? [] : (posting?.alternatives || []).filter(item => item.title.startsWith('Unconfirmed'))
      .slice(0, 3).map((item, index) => ({ url: item.url, title: item.title, rank: index + 1 })),
    applyUrl,
    viewUrl: closedOfficialUrl || applyUrl,
    viewLabel: closedOfficialUrl ? 'View official posting previously marked closed'
      : levelLabel ? `${levelLabel} · Open job listing` : 'Open job listing',
  };
}
