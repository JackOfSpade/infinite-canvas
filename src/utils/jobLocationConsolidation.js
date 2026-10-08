/**
 * Job-description location consolidation (Board side).
 *
 * A pure, deterministic module. It automatically merges only exactly equal
 * postings of the same normalized title + company that appear at two or more
 * distinct non-empty locations. A near match may merge only when an upstream
 * AI confirmation explicitly approved that exact pair. Short snippets,
 * same-location requisitions, filtered rows, and rows missing a title/company
 * are never candidates for either path.
 *
 * The module is deliberately free of React/IPC/Electron imports so the same
 * helpers drive the live Combine path (JobBoardNode → buildJobTreeNodes) and the
 * saved-canvas schema migration (serializationUtils version 10).
 *
 * Invariants:
 *   • Inputs are never mutated; callers get fresh objects for any changed row.
 *   • Input order is preserved: a consolidated row appears where its primary
 *     posting first appeared, and untouched rows keep their position.
 *   • Repeated consolidation is idempotent (an already-consolidated row, and a
 *     cascade with nothing to merge, pass through unchanged).
 *   • Application-linked cards are protected and can never be dropped,
 *     replaced, or orphaned.
 */

/** Minimum normalized alphanumeric length of a full description/snippet. */
export const MIN_DESCRIPTION_ALNUM = 500;
/** Displayed location for a consolidated multi-location posting. */
export const MULTIPLE_LOCATIONS_LABEL = 'Multiple locations';
/** Upper bound on retained posting variants per consolidated row. */
export const MAX_POSTING_VARIANTS = 64;
/** Minimum deterministic wording similarity before asking AI to verify a pair. */
export const SIMILARITY_CONFIRMATION_THRESHOLD = 0.75;

// The description-bearing fields a Board row may carry. The *fullest single*
// field is used (never a concatenation): sources that mirror the same text into
// both `description` and `snippet` must fingerprint identically instead of
// being stitched into a false mismatch.
const DESCRIPTION_FIELDS = ['description', 'descriptionText', 'jobDescription', 'snippet', 'summary'];

// These words convey little about whether two postings describe the same
// requisition. Dropping them prevents a generic benefits/template section from
// artificially raising a pair above the AI-confirmation threshold. This is a
// deliberately small, stable list — it is a deterministic candidate gate, not
// a language model pretending to decide identity.
const DESCRIPTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'our', 'that', 'the', 'this', 'to', 'we', 'with',
  'will', 'you', 'your', 'their', 'they', 'who', 'which', 'while', 'about',
  'all', 'any', 'can', 'do', 'have', 'has', 'may', 'not', 'than', 'through',
]);

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:']);
// Reject anything with control characters or surrounding C0/bidi marks before
// even parsing; a URL rendered into a card must be printable and single-line.
const UNSAFE_URL_CHARS = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]`,
);

/** Lowercase, collapse internal whitespace, trim. */
export function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Lowercase and keep only [a-z0-9] — the description-fingerprint alphabet. */
export function normalizeAlnum(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The single fullest description/snippet text for a row. Concatenation is
 * intentionally avoided: the same posting indexed by two sources can expose the
 * description once as `description` and once as `snippet`, and joining them
 * would produce a different fingerprint than the same row carrying only one.
 */
export function descriptionText(job) {
  if (!job || typeof job !== 'object') return '';
  let best = '';
  for (const key of DESCRIPTION_FIELDS) {
    const value = job[key];
    if (typeof value !== 'string') continue;
    if (value.length > best.length) best = value;
  }
  return best;
}

/**
 * Deterministic exact fingerprint of a posting's normalized description. Two
 * postings consolidate only when these strings are byte-identical AND nonempty.
 */
export function descriptionFingerprint(job) {
  return normalizeAlnum(descriptionText(job));
}

/**
 * Light, deterministic stemming for the similarity candidate gate. It keeps
 * ordinary wording changes ("build"/"building", "service"/"services") from
 * hiding a likely variant while remaining fully inspectable and repeatable.
 */
function normalizeDescriptionTerm(value) {
  let term = String(value || '').toLowerCase();
  if (term.length > 5 && term.endsWith('ies')) term = `${term.slice(0, -3)}y`;
  else if (term.length > 5 && term.endsWith('ing')) term = term.slice(0, -3);
  else if (term.length > 4 && term.endsWith('ed')) term = term.slice(0, -2);
  else if (term.length > 4 && term.endsWith('es')) term = term.slice(0, -2);
  else if (term.length > 3 && term.endsWith('s')) term = term.slice(0, -1);
  return term;
}

function descriptionTerms(job) {
  return descriptionText(job)
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(normalizeDescriptionTerm)
    .filter(term => term.length >= 3 && !DESCRIPTION_STOP_WORDS.has(term)) || [];
}

function multisetDice(left, right) {
  if (!left.length || !right.length) return 0;
  const leftCounts = new Map();
  const rightCounts = new Map();
  left.forEach(value => leftCounts.set(value, (leftCounts.get(value) || 0) + 1));
  right.forEach(value => rightCounts.set(value, (rightCounts.get(value) || 0) + 1));
  let overlap = 0;
  for (const [value, count] of leftCounts) overlap += Math.min(count, rightCounts.get(value) || 0);
  return (2 * overlap) / (left.length + right.length);
}

function wordTrigrams(terms) {
  const out = [];
  for (let index = 0; index + 2 < terms.length; index += 1) {
    out.push(`${terms[index]}\u0001${terms[index + 1]}\u0001${terms[index + 2]}`);
  }
  return out;
}

function vocabularyCoverage(left, right) {
  const leftTerms = new Set(left);
  const rightTerms = new Set(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared / Math.max(leftTerms.size, rightTerms.size);
}

/**
 * Deterministic lexical similarity for *candidate selection only*. The score
 * blends meaningful-token overlap, ordered phrase overlap, and vocabulary
 * coverage. It deliberately does not consolidate anything by itself; callers
 * must obtain a separate AI confirmation before a non-identical pair merges.
 */
export function descriptionSimilarity(leftJob, rightJob) {
  const left = descriptionTerms(leftJob);
  const right = descriptionTerms(rightJob);
  const tokenDice = multisetDice(left, right);
  const shingleDice = multisetDice(wordTrigrams(left), wordTrigrams(right));
  const coverage = vocabularyCoverage(left, right);
  const score = (0.55 * tokenDice) + (0.25 * shingleDice) + (0.20 * coverage);
  return {
    score: Math.round(score * 10_000) / 10_000,
    tokenDice: Math.round(tokenDice * 10_000) / 10_000,
    shingleDice: Math.round(shingleDice * 10_000) / 10_000,
    coverage: Math.round(coverage * 10_000) / 10_000,
  };
}

/** Normalized nonempty location, or '' when absent. */
export function normalizedLocation(job) {
  return normalizeText(job?.location);
}

/**
 * True only for a source-facing URL that is safe to persist and render: an
 * http(s) URL with no embedded credentials and no control/format characters.
 * `javascript:`, `data:`, scheme-relative, and userinfo-bearing URLs are
 * dropped so a variant can never smuggle executable or credential material.
 */
export function isSafeSourceUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || UNSAFE_URL_CHARS.test(trimmed)) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  if (!parsed.hostname) return false;
  return true;
}

/** The trimmed safe URL, or '' when unsafe/absent. */
function safeUrl(value) {
  return isSafeSourceUrl(value) ? String(value).trim() : '';
}

/**
 * True when a job is a consolidation *candidate*: nonempty normalized title +
 * company, a nonempty exact description fingerprint of at least
 * MIN_DESCRIPTION_ALNUM normalized alphanumeric characters, and not already a
 * consolidated multi-location row.
 */
export function isConsolidationCandidate(job) {
  if (!job || typeof job !== 'object') return false;
  if (isConsolidatedJob(job)) return false;
  if (!normalizeText(job.title) || !normalizeText(job.company)) return false;
  return descriptionFingerprint(job).length >= MIN_DESCRIPTION_ALNUM;
}

/** True when a row is already the synthetic consolidated result. */
export function isConsolidatedJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (normalizeText(job.location) !== normalizeText(MULTIPLE_LOCATIONS_LABEL)) return false;
  return Array.isArray(job.postingVariants) && job.postingVariants.length > 0;
}

/**
 * A jobcard is protected iff it already has application state. Protected cards
 * anchor consolidation: they are preferred as the reused representative and are
 * never removed.
 */
export function isProtectedJobCard(node) {
  return !!node && node.type === 'jobcard' && !!node.data?.localApplication;
}

/** Explicit protection for plain job rows (node or union row). */
function isProtectedJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.protected === true) return true;
  return !!job.localApplication || !!job.data?.localApplication;
}

/** The stable id used to reuse an existing card, if any. */
function jobCardId(job) {
  const id = job?.cardId ?? job?.id;
  return typeof id === 'string' && id ? id : '';
}

/**
 * Gather one bounded posting variant from a row: location, safe source-facing
 * URLs, source, posted, and salary/apply metadata. Only truthy fields are kept
 * so the union stays compact.
 */
export function buildPostingVariant(job) {
  const variant = {};
  const location = normalizeText(job?.location);
  if (location) variant.location = String(job.location).replace(/\s+/g, ' ').trim();
  const url = safeUrl(job?.url);
  if (url) variant.url = url;
  const googleCardUrl = safeUrl(job?.googleCardUrl);
  if (googleCardUrl) variant.googleCardUrl = googleCardUrl;
  const applyUrl = safeUrl(job?.applyUrl) || safeUrl(job?.applySourceUrl) || safeUrl(job?.applyLink);
  if (applyUrl) variant.applyUrl = applyUrl;
  for (const key of ['source', 'posted', 'salary', 'applySource', 'jobkey', 'language']) {
    const value = job?.[key];
    if (typeof value === 'string' && value.trim()) variant[key] = value.trim();
  }
  return variant;
}

/** Stable dedup key for a variant (ordered; never exposes a raw fingerprint). */
export function postingVariantKey(variant) {
  if (!variant || typeof variant !== 'object') return '';
  return [
    variant.location || '',
    variant.url || '',
    variant.googleCardUrl || '',
    variant.applyUrl || '',
    variant.source || '',
    variant.posted || '',
    variant.salary || '',
    variant.applySource || '',
    variant.jobkey || '',
    variant.language || '',
  ].join('\u0001');
}

/** Cluster key: normalized title | company | exact description fingerprint. */
export function consolidationClusterKey(job) {
  return [
    normalizeText(job?.title),
    normalizeText(job?.company),
    descriptionFingerprint(job),
  ].join('|');
}

/** Stable, input-order-local identifier for an AI-confirmable pair. */
export function locationSimilarityPairId(leftIndex, rightIndex) {
  const left = Math.min(Number(leftIndex), Number(rightIndex));
  const right = Math.max(Number(leftIndex), Number(rightIndex));
  return `${left}:${right}`;
}

/**
 * List only the non-identical, preference-accepted pairs which are eligible
 * for AI verification. Exact-description variants remain automatic; pairs
 * with a filtered listing, missing long description, different employer/title,
 * or the same location never leave the deterministic boundary.
 */
export function findSimilarLocationCandidates(jobs, {
  threshold = SIMILARITY_CONFIRMATION_THRESHOLD,
} = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const groups = new Map();
  input.forEach((job, index) => {
    if (job?.preferenceAssessment?.status === 'filtered') return;
    if (!isConsolidationCandidate(job)) return;
    const key = [normalizeText(job.title), normalizeText(job.company)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ job, index });
  });
  const candidates = [];
  for (const entries of groups.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const a = entries[left];
        const b = entries[right];
        if (normalizedLocation(a.job) === normalizedLocation(b.job)) continue;
        // Exact text stays on the no-AI path. Asking the model about it would
        // waste a worker and make an established deterministic result depend on
        // an external response.
        if (descriptionFingerprint(a.job) === descriptionFingerprint(b.job)) continue;
        const similarity = descriptionSimilarity(a.job, b.job);
        if (similarity.score < threshold) continue;
        candidates.push({
          id: locationSimilarityPairId(a.index, b.index),
          leftIndex: a.index,
          rightIndex: b.index,
          similarity: similarity.score,
          metrics: similarity,
        });
      }
    }
  }
  return candidates;
}

/**
 * Richness ordering used to pick the representative among unprotected members.
 * Higher matchScore first, then more populated fields; deterministic and
 * independent of object key insertion order.
 */
function jobRichness(job) {
  const score = Number(job?.matchScore);
  const numeric = Number.isFinite(score) ? score : -1;
  let fields = 0;
  for (const key of [
    'location', 'salary', 'snippet', 'reasoning', 'careerDirection', 'url',
    'googleCardUrl', 'posted', 'source',
  ]) {
    const value = job?.[key];
    if (typeof value === 'string' ? value.trim() : value != null) fields += 1;
  }
  return numeric * 1000 + fields;
}

/** Union variant lists in order, deduped by key, bounded by MAX_POSTING_VARIANTS. */
function mergeVariantLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const variant of list) {
      if (!variant || typeof variant !== 'object') continue;
      const key = postingVariantKey(variant);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...variant });
      if (out.length >= MAX_POSTING_VARIANTS) return out;
    }
  }
  return out;
}

/** The variant list a member contributes (its existing union, or a fresh one). */
function memberVariants(member) {
  if (Array.isArray(member?.postingVariants) && member.postingVariants.length > 0) {
    return member.postingVariants;
  }
  const variant = buildPostingVariant(member);
  return postingVariantKey(variant) ? [variant] : [];
}

/** Distinct normalized locations across a member set, including its variants. */
function distinctLocationsOf(members) {
  const distinct = new Set();
  for (const member of members) {
    const loc = normalizedLocation(member);
    if (loc) distinct.add(loc);
    for (const variant of memberVariants(member)) {
      const variantLoc = normalizeText(variant?.location);
      if (variantLoc) distinct.add(variantLoc);
    }
  }
  return distinct;
}

/**
 * Build the consolidated row for an already-proven posting family.
 *
 * @param {object[]} members
 * @param {object|null} primaryMember  protected representative to reuse
 */
function buildConsolidatedRow(members, primaryMember) {
  const protectedMembers = members.filter(isProtectedJob);
  let primary = primaryMember;
  if (!primary) {
    primary = protectedMembers.length > 0
      ? protectedMembers[0]
      : members.slice().sort((a, b) => jobRichness(b) - jobRichness(a))[0];
  }
  const variants = mergeVariantLists(...members.map(memberVariants));
  const locations = distinctLocationsOf(members);

  const row = {
    ...primary,
    location: MULTIPLE_LOCATIONS_LABEL,
    postingVariants: variants,
    consolidatedLocationCount: locations.size,
    consolidatedPostingCount: members.length,
  };
  const reuseCardId = jobCardId(primary);
  if (reuseCardId) row.reuseCardId = reuseCardId;
  if (primary?.cardData) row.reuseCardData = primary.cardData;
  // Never carry representative-only markers into the output.
  delete row.protected;
  delete row.cardData;
  return row;
}

// Preserve the historical exact-cluster diagnostic key when a component is
// entirely exact. A fuzzy component intentionally gets an index-only key so
// telemetry never exposes the description-derived fingerprint.
function componentDiagnosticKey(bucket) {
  const first = bucket.members[0] ? consolidationClusterKey(bucket.members[0]) : '';
  if (first && bucket.members.every(member => consolidationClusterKey(member) === first)) return first;
  return `component:${bucket.indices.join(',')}`;
}

/**
 * Consolidate postings by title/company across distinct locations. Exact
 * description matches are automatic; non-identical descriptions are admitted
 * only through a pair id that was returned as sameJob=true by the AI
 * confirmation step. The deterministic similarity score is never sufficient
 * on its own to remove a card.
 *
 * @param {object[]} jobs
 * @param {object}   [options]
 * @param {Set<string>|string[]} [options.protectedIds] explicit protected ids
 * @param {Set<string>|string[]} [options.confirmedSimilarPairIds] AI-approved
 * input-order-local pair ids returned by findSimilarLocationCandidates
 * @returns {{ jobs: object[], groups: object[], stats: object }}
 */
export function consolidateJobLocations(jobs, options = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const protectedIds = options.protectedIds instanceof Set
    ? options.protectedIds
    : new Set(Array.isArray(options.protectedIds) ? options.protectedIds : []);
  const confirmedSimilarPairIds = options.confirmedSimilarPairIds instanceof Set
    ? options.confirmedSimilarPairIds
    : new Set(Array.isArray(options.confirmedSimilarPairIds) ? options.confirmedSimilarPairIds : []);
  const isProtected = (job) => isProtectedJob(job) || (jobCardId(job) !== '' && protectedIds.has(jobCardId(job)));

  // Record candidates by exact fingerprint. An exact group is automatic only
  // when it visibly spans locations; same-location rows stay separate exactly
  // as they did before similarity confirmation existed.
  const exactBuckets = new Map();
  const eligibleIndexes = new Set();
  input.forEach((job, index) => {
    if (!isConsolidationCandidate(job)) return;
    eligibleIndexes.add(index);
    const key = consolidationClusterKey(job);
    if (!exactBuckets.has(key)) exactBuckets.set(key, { key, members: [], indices: [] });
    const bucket = exactBuckets.get(key);
    bucket.members.push(job);
    bucket.indices.push(index);
  });

  // A tiny union-find keeps exact groups and independently AI-approved fuzzy
  // pairs transitive. If A/B are exact variants and AI verifies B/C, all three
  // represent one posting family without treating any unconfirmed pair as
  // equivalent.
  const parent = new Map();
  const root = (index) => {
    const current = parent.get(index);
    if (current === index) return index;
    const resolved = root(current);
    parent.set(index, resolved);
    return resolved;
  };
  const join = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  eligibleIndexes.forEach(index => parent.set(index, index));
  for (const bucket of exactBuckets.values()) {
    if (distinctLocationsOf(bucket.members).size < 2) continue;
    for (let offset = 1; offset < bucket.indices.length; offset += 1) join(bucket.indices[0], bucket.indices[offset]);
  }
  // Rebuild the deterministic candidate set here instead of trusting a caller
  // supplied pair id. This makes it impossible for a stale/tampered renderer
  // to merge a below-threshold, same-location, filtered, or unrelated pair.
  for (const candidate of findSimilarLocationCandidates(input)) {
    if (confirmedSimilarPairIds.has(candidate.id)) join(candidate.leftIndex, candidate.rightIndex);
  }

  const buckets = new Map();
  for (const index of eligibleIndexes) {
    const component = root(index);
    if (!buckets.has(component)) buckets.set(component, { members: [], indices: [] });
    const bucket = buckets.get(component);
    bucket.members.push(input[index]);
    bucket.indices.push(index);
  }

  const consolidatedByIndex = new Map();
  const removedIndices = new Set();
  const groups = [];
  let protectedRetained = 0;

  for (const bucket of buckets.values()) {
    const distinct = distinctLocationsOf(bucket.members);
    if (distinct.size < 2) continue; // same-location requisitions never merge

    // A singleton cannot represent a consolidation just because it happens to
    // carry a long description.
    if (bucket.members.length < 2) continue;

    const protectedMembers = bucket.members.filter(isProtected);
    protectedRetained += protectedMembers.length;

    if (protectedMembers.length >= 2) {
      // Never merge two application-linked cards. Keep every protected card and
      // attach all unprotected variants to exactly one of them (the first),
      // removing only the unprotected duplicates.
      const primaryProtected = protectedMembers[0];
      const primaryIndex = bucket.indices[bucket.members.indexOf(primaryProtected)];
      const variants = mergeVariantLists(...bucket.members.map(memberVariants));
      consolidatedByIndex.set(primaryIndex, {
        ...primaryProtected,
        location: MULTIPLE_LOCATIONS_LABEL,
        postingVariants: variants,
        consolidatedLocationCount: distinct.size,
        consolidatedPostingCount: bucket.members.length,
      });
      bucket.members.forEach((member, i) => {
        if (isProtected(member)) return;
        removedIndices.add(bucket.indices[i]);
      });
      groups.push({
        key: componentDiagnosticKey(bucket),
        representativeId: jobCardId(primaryProtected),
        protectedIds: protectedMembers.map(jobCardId).filter(Boolean),
        memberIds: bucket.members.map(jobCardId).filter(Boolean),
        locations: [...distinct].sort(),
        postingCount: bucket.members.length,
        protectedCount: protectedMembers.length,
      });
      continue;
    }

    // zero or one protected card → collapse to a single row, preferring the
    // protected card when it exists.
    const primaryMember = protectedMembers.length === 1 ? protectedMembers[0] : null;
    const primaryIndex = primaryMember
      ? bucket.indices[bucket.members.indexOf(primaryMember)]
      : bucket.indices[0];
    const consolidated = buildConsolidatedRow(bucket.members, primaryMember);
    consolidatedByIndex.set(primaryIndex, consolidated);
    for (const index of bucket.indices) {
      if (index !== primaryIndex) removedIndices.add(index);
    }
    groups.push({
      key: componentDiagnosticKey(bucket),
      representativeId: jobCardId(consolidated),
      protectedIds: protectedMembers.map(jobCardId).filter(Boolean),
      memberIds: bucket.members.map(jobCardId).filter(Boolean),
      locations: [...distinct].sort(),
      postingCount: bucket.members.length,
      protectedCount: protectedMembers.length,
    });
  }

  const out = [];
  let alreadyConsolidated = 0;
  input.forEach((job, index) => {
    if (removedIndices.has(index)) return;
    if (consolidatedByIndex.has(index)) {
      out.push(consolidatedByIndex.get(index));
      return;
    }
    if (isConsolidatedJob(job)) alreadyConsolidated += 1;
    out.push(job);
  });

  const stats = {
    candidateGroups: groups.length,
    locationVariantGroups: groups.length,
    postingsCollapsed: removedIndices.size,
    locationVariantPostingsCollapsed: removedIndices.size,
    protectedRetained,
    representedPostings: groups.reduce((sum, group) => sum + group.postingCount, 0),
    alreadyConsolidated,
    variantsUnion: groups.reduce((sum, group) => sum + group.locations.length, 0),
  };

  return { jobs: out, groups, stats };
}

/**
 * Convert a board jobcard node into a consolidation row that reuses the node's
 * id and protects its persisted data (localApplication etc.).
 */
export function jobFromProtectedCard(node) {
  const data = node?.data || {};
  return {
    ...data,
    id: node.id,
    cardId: node.id,
    cardData: data,
    protected: true,
  };
}

/** True when a node is a child jobcard of the given board id. */
function isBoardCardOf(node, boardId) {
  return !!node && node.type === 'jobcard' && node.data?.hubId === boardId;
}

/**
 * Attach a matching protected card to each union row (by id first, then url,
 * then normalized title|company|location) so the reused card keeps its id and
 * persisted state. Returns the union rows plus the protected cards that had no
 * union counterpart.
 */
export function attachProtectedCards(unionJobs, protectedCards) {
  const jobs = Array.isArray(unionJobs) ? unionJobs : [];
  const cards = Array.isArray(protectedCards) ? protectedCards : [];
  if (cards.length === 0) {
    return { jobs: jobs.slice(), unmatchedProtected: [] };
  }
  const byId = new Map();
  const byKey = new Map();
  const byUrl = new Map();
  const locationKey = (job) => [
    normalizeText(job?.title), normalizeText(job?.company), normalizeText(job?.location),
  ].join('|');
  const urlKey = (job) => normalizeText(safeUrl(job?.url) || safeUrl(job?.googleCardUrl));
  for (const card of cards) {
    const row = jobFromProtectedCard(card);
    if (row.cardId) byId.set(row.cardId, row);
    byKey.set(locationKey(row), row);
    const url = urlKey(row);
    if (url) byUrl.set(url, row);
  }

  const usedIds = new Set();
  const out = jobs.map((job) => {
    let match = null;
    const id = jobCardId(job);
    if (id && byId.has(id)) match = byId.get(id);
    if (!match) {
      const url = urlKey(job);
      if (url && byUrl.has(url)) match = byUrl.get(url);
    }
    if (!match) {
      const key = locationKey(job);
      if (byKey.has(key)) match = byKey.get(key);
    }
    if (!match) return job;
    usedIds.add(match.cardId);
    return {
      ...job,
      cardId: match.cardId,
      reuseCardId: match.cardId,
      reuseCardData: match.cardData,
      protected: true,
    };
  });

  const unmatchedProtected = cards
    .filter(card => !usedIds.has(card.id))
    .map(jobFromProtectedCard);

  return { jobs: out, unmatchedProtected };
}

/**
 * Metadata-only facts about a Board cascade's consolidation state. Never emits
 * titles, descriptions, URLs, locations, fingerprints, or application ids.
 */
export function summarizeConsolidation(jobs) {
  const input = Array.isArray(jobs) ? jobs : [];
  const byCluster = new Map();
  let alreadyConsolidated = 0;
  let representedPostings = 0;
  let protectedCards = 0;
  for (const job of input) {
    if (!job || typeof job !== 'object') continue;
    if (isProtectedJob(job)) protectedCards += 1;
    if (isConsolidatedJob(job)) {
      alreadyConsolidated += 1;
      representedPostings += Array.isArray(job.postingVariants) ? job.postingVariants.length : 0;
      continue;
    }
    if (!isConsolidationCandidate(job)) continue;
    const key = consolidationClusterKey(job);
    if (!byCluster.has(key)) byCluster.set(key, { locations: new Set(), count: 0 });
    const bucket = byCluster.get(key);
    bucket.count += 1;
    const loc = normalizedLocation(job);
    if (loc) bucket.locations.add(loc);
  }
  let eligibleExactDescriptionMultiLocationGroups = 0;
  for (const bucket of byCluster.values()) {
    if (bucket.locations.size >= 2) eligibleExactDescriptionMultiLocationGroups += 1;
  }
  return {
    eligibleExactDescriptionMultiLocationGroups,
    alreadyConsolidated,
    representedPostings,
    protectedCards,
  };
}

/** Normalize a jobgroup `count` field defensively. */
function normalizeGroupCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Consolidate an existing saved Board cascade in place (schema migration path).
 *
 * Operates on a flat node array for ONE canvas level: finds each `jobboard`
 * node, consolidates its child `jobcard` nodes (protected cards preserved),
 * rewrites jobgroup childIds, prunes emptied groups, recomputes recursive group
 * counts, and refreshes the Board's result/source/merge stats. Edges to removed
 * nodes are pruned later by the established save/load edge sanitation.
 *
 * Returns the SAME node-array reference when nothing consolidated, so the
 * migration is a no-op on an already-consolidated cascade (idempotent).
 *
 * @returns {{ nodes: object[], stats: object }}
 */
export function consolidateBoardCascadeNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const stats = emptyBoardCascadeStats();
  const boards = list.filter(n => n?.type === 'jobboard');
  if (boards.length === 0) return { nodes: list, stats };

  const removeIds = new Set();
  const cardDataById = new Map();
  const affectedBoardIds = new Set();
  const boardStatsById = new Map();

  for (const board of boards) {
    const cards = list.filter(n => isBoardCardOf(n, board.id));
    if (cards.length === 0) continue;
    const protectedCards = cards.filter(isProtectedJobCard);
    const protectedIds = new Set(protectedCards.map(card => card.id));
    const rows = cards.map((card) => {
      const isProtected = protectedIds.has(card.id);
      const row = {
        ...(card.data || {}),
        id: card.id,
        cardId: card.id,
        protected: isProtected,
      };
      if (isProtected) row.cardData = card.data || {};
      return row;
    });

    const { jobs, stats: localStats } = consolidateJobLocations(rows, { protectedIds });
    stats.eligibleGroups += localStats.candidateGroups;
    stats.postingsCollapsed += localStats.postingsCollapsed;
    stats.protectedRetained += localStats.protectedRetained;
    stats.alreadyConsolidated += localStats.alreadyConsolidated;
    stats.boardsProcessed += 1;
    if (localStats.postingsCollapsed === 0) continue;
    affectedBoardIds.add(board.id);
    boardStatsById.set(board.id, localStats);

    const survivingIds = new Set();
    for (const job of jobs) {
      const id = jobCardId(job);
      if (!id) continue;
      survivingIds.add(id);
      if (job.postingVariants) {
        cardDataById.set(id, {
          location: job.location,
          postingVariants: job.postingVariants,
          consolidatedLocationCount: job.consolidatedLocationCount,
          consolidatedPostingCount: job.consolidatedPostingCount,
        });
      }
    }
    for (const card of cards) {
      if (!survivingIds.has(card.id)) removeIds.add(card.id);
    }
  }

  if (removeIds.size === 0) {
    return { nodes: list, stats };
  }

  const groupById = new Map();
  for (const node of list) {
    if (node?.type === 'jobgroup' && affectedBoardIds.has(node.data?.hubId)) {
      groupById.set(node.id, node);
    }
  }
  const isGroup = (id) => groupById.has(id);

  // Post-order resolution of the group forest: a group survives iff it keeps at
  // least one live child (a non-removed card or a surviving group); counts are
  // the number of descendant cards. Memoized + cycle-guarded so the result is
  // independent of declaration order and idempotent.
  const resolved = new Map();
  const inProgress = new Set();
  const resolveGroup = (groupId) => {
    if (resolved.has(groupId)) return resolved.get(groupId);
    if (inProgress.has(groupId)) return { survive: false, count: 0, childIds: [] };
    inProgress.add(groupId);
    const group = groupById.get(groupId);
    const rawChildIds = Array.isArray(group?.data?.childIds) ? group.data.childIds : [];
    const childIds = [];
    let count = 0;
    let hasLiveChild = false;
    for (const cid of rawChildIds) {
      if (typeof cid !== 'string' || !cid) continue;
      if (isGroup(cid)) {
        const child = resolveGroup(cid);
        if (!child.survive) continue;
        childIds.push(cid);
        count += child.count;
        hasLiveChild = true;
      } else if (!removeIds.has(cid)) {
        childIds.push(cid);
        count += 1;
        hasLiveChild = true;
      }
    }
    inProgress.delete(groupId);
    const result = { survive: hasLiveChild, count, childIds };
    resolved.set(groupId, result);
    return result;
  };

  const out = [];
  for (const node of list) {
    if (removeIds.has(node.id)) continue;
    if (node?.type === 'jobgroup' && groupById.has(node.id)) {
      const result = resolveGroup(node.id);
      if (!result.survive) continue; // prune an emptied group
      const prevChildIds = Array.isArray(node.data?.childIds) ? node.data.childIds : [];
      const count = result.count;
      if (
        prevChildIds.length !== result.childIds.length
        || prevChildIds.some((cid, i) => cid !== result.childIds[i])
        || normalizeGroupCount(node.data?.count) !== count
      ) {
        out.push({ ...node, data: { ...node.data, childIds: result.childIds, count } });
        continue;
      }
      out.push(node);
      continue;
    }
    if (node?.type === 'jobcard' && cardDataById.has(node.id)) {
      out.push({ ...node, data: { ...node.data, ...cardDataById.get(node.id) } });
      continue;
    }
    out.push(node);
  }

  // Recompute Board result counts / source counts / merge stats from survivors.
  const finalized = out.map((node) => {
    if (node?.type !== 'jobboard') return node;
    const boardStats = boardStatsById.get(node.id);
    if (!boardStats) return node;
    const cards = out.filter(n => isBoardCardOf(n, node.id));
    if (cards.length === 0) return node;
    const sourceCounts = {};
    for (const card of cards) {
      const source = card.data?.source;
      if (source) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
    const mergeStats = node.data?.mergeStats && typeof node.data.mergeStats === 'object'
      ? { ...node.data.mergeStats }
      : {};
    mergeStats.locationVariantGroups = boardStats.candidateGroups;
    mergeStats.locationVariantPostingsCollapsed = boardStats.postingsCollapsed;
    return {
      ...node,
      data: {
        ...node.data,
        resultCount: cards.length,
        finalSourceCounts: sourceCounts,
        mergeStats,
      },
    };
  });

  return { nodes: finalized, stats };
}

/** Zeroed cascade-consolidation counters. */
export function emptyBoardCascadeStats() {
  return {
    boardsProcessed: 0,
    eligibleGroups: 0,
    postingsCollapsed: 0,
    protectedRetained: 0,
    alreadyConsolidated: 0,
  };
}
