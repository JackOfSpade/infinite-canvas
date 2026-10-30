import { normalizeJobListingExternalUrl } from './jobListingUrl.js';
import { OFFICIAL_POSTING_GENERATION_RECEIPT_MAX_AGE_MS } from '../../electron/ipc/officialPostingFields.js';

// Refresh before the host's five-minute receipt limit, leaving a queue margin.
const PREPARATION_REFRESH_AGE_MS = OFFICIAL_POSTING_GENERATION_RECEIPT_MAX_AGE_MS - 60 * 1000;

/** One live source projection for both research and the final queue boundary. */
export function projectOfficialPostingGenerationJob(data = {}) {
  return {
    title: data.title, company: data.company, snippet: data.snippet, description: data.description,
    employer: data.employer, hiringOrganization: data.hiringOrganization, locations: data.locations,
    workMode: data.workMode, remote: data.remote, remoteCountry: data.remoteCountry, remoteRegion: data.remoteRegion,
    employmentType: data.employmentType, seniority: data.seniority, jobLevel: data.jobLevel,
    identifier: data.identifier, requisitionId: data.requisitionId, reqId: data.reqId,
    sourceUrl: data.sourceUrl, provenance: data.provenance,
    postedBy: data.postedBy, applyOptions: data.applyOptions,
    salaryProvenance: data.salaryProvenance, officialPosting: data.officialPosting,
    boardClosed: data.boardClosed, listingLiveness: data.listingLiveness, alternateListings: data.alternateListings,
    googleCardUrl: data.googleCardUrl, sourceJobKey: data.sourceJobKey,
    location: data.location, salary: data.salary, url: normalizeJobListingExternalUrl(data),
    source: data.source, posted: data.posted, language: data.language,
    postingVariants: (Array.isArray(data.postingVariants) ? data.postingVariants : [])
      .filter(variant => variant && typeof variant === 'object' && !Array.isArray(variant))
      .map(variant => ({
        location: variant.location,
        url: normalizeJobListingExternalUrl({ title: variant.title || data.title, company: variant.company || data.company,
          location: variant.location, url: variant.url, googleCardUrl: variant.googleCardUrl }),
        googleCardUrl: '', source: variant.source, posted: variant.posted, salary: variant.salary,
        applySource: variant.applySource, liveness: variant.liveness === 'closed' ? 'closed' : undefined,
      })),
  };
}

/** Lookup outputs may update the card without changing the original source. */
export function officialPostingPreparationSourceKey(job = {}) {
  const { officialPosting: _posting, postedBy: _poster, listingLiveness: _liveness, boardClosed: _closed, ...source } = job;
  return JSON.stringify({ ...source, postingVariants: (source.postingVariants || []).map(variant => ({ ...variant, liveness: undefined })) });
}

export function officialPostingPreparationNeedsRefresh({ preparedAt, preparedSourceKey, job, now = Date.now() } = {}) {
  const checkedAt = typeof preparedAt === 'string' ? Date.parse(preparedAt) : NaN;
  return !Number.isFinite(checkedAt) || now < checkedAt || now - checkedAt >= PREPARATION_REFRESH_AGE_MS
    || preparedSourceKey !== officialPostingPreparationSourceKey(job);
}

// Transient renderer ownership outlives a hidden card's React instance. This
// contains no job facts and holds no application lane while research runs.
const preparations = new Map();
const listeners = new Set();
const keyFor = (canvasFilePath, nodeId) => JSON.stringify([canvasFilePath || '', nodeId || '']);
const publish = () => {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One renderer must not interrupt another. */ }
  }
};

export function getOfficialPostingPreparation(canvasFilePath, nodeId) {
  return preparations.get(keyFor(canvasFilePath, nodeId)) || null;
}

export function subscribeOfficialPostingPreparation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A synchronous claim also fences callbacks captured before a rerender. */
export function beginOfficialPostingPreparation({ canvasFilePath, nodeId, cancel, purpose = 'generation', owner = 'card' }) {
  const key = keyFor(canvasFilePath, nodeId);
  if (preparations.has(key)) return null;
  let cancelled = false;
  const entry = Object.freeze({
    state: 'resolving', position: null, purpose: purpose === 'lookup' ? 'lookup' : 'generation',
    owner: owner === 'board-refresh' ? 'board-refresh' : 'card',
    cancel() {
      if (preparations.get(key) !== entry || cancelled) return;
      cancelled = true;
      try {
        const acknowledgement = cancel?.();
        if (acknowledgement && typeof acknowledgement.then === 'function') {
          // The owner keeps its claim until host acknowledgment. A failed
          // attempt can return false so the still-visible Cancel can retry.
          void Promise.resolve(acknowledgement).then(result => {
            if (result === false) cancelled = false;
          }, () => { cancelled = false; });
        }
      } catch { cancelled = false; }
    },
    finish() {
      if (preparations.get(key) !== entry) return;
      preparations.delete(key);
      publish();
    },
  });
  preparations.set(key, entry);
  publish();
  return entry;
}
