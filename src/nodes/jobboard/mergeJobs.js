import { jobTitleCompanyLocationKey, jobTitleCompanyUrlKey } from '../../utils/jobIdentity.js';

// A running Search temporarily drops out of the Board's terminal input
// signature. Keep this canonical list beside the snapshot policy so the Board
// cannot accidentally treat a queued or scoring Search as a completed input.
export const ACTIVE_JOB_SEARCH_STATES = new Set([
  'queued',
  'parsing',
  'interpreting-preferences',
  'querying',
  'searching',
  'evaluating-preferences',
  'scoring',
]);

/**
 * Merge the scored-job arrays from several Job Search Modules into one deduped
 * list for the Job Board Module. Pure + unit-tested (no ReactFlow runtime).
 *
 * Identity is `jobTitleCompanyUrlKey` (title|company|url) — the deliberately
 * CONSERVATIVE cross-module key (see the policy note in jobIdentity.js):
 * different modules may target different locations, where same title+company
 * can be genuinely distinct reqs, so only an exact same-listing match
 * collapses. Unlike `dedupeJobsByKey` (first-wins), the board keeps the entry
 * with the HIGHER matchScore on a collision: when two modules scored the same
 * posting against different résumés, the better fit is the useful one, and
 * that copy carries its own `originHubId` so the card's "Generate Résumé +
 * Cover Letter" reads career data from the right origin module. First-seen
 * order is otherwise preserved (the cascade re-sorts by score downstream, but
 * a stable input keeps the result deterministic).
 *
 * Pass an optional `stats` object to collect merge telemetry (mutated in place):
 * `{ totalIncoming, unique, duplicatesRemoved, collisions, collisionUpgrades,
 *    collisionAssessmentUpgrades, preferenceFilteredSkipped }`.
 * The Job Board stores this so a "merged the wrong count / kept the wrong copy"
 * bug is diagnosable from the report — the merge is otherwise invisible (it runs
 * in the renderer, before the bucketJobs IPC that main stamps a funnel for).
 * Omitting `stats` is a no-op, so existing callers are unaffected.
 *
 * @param {object[][]} jobArrays  one scored-jobs array per connected module
 * @param {object}    [stats]     optional out-param; populated with merge counts
 * @returns {object[]} the deduped union
 */
export function unionScoredJobs(jobArrays, stats) {
  const order = [];        // dedup keys in first-seen order
  const byKey = new Map(); // key -> winning job
  let totalIncoming = 0;   // valid job objects seen across all arrays
  let collisions = 0;      // duplicate keys encountered (any resolution)
  let collisionUpgrades = 0; // collisions where a higher matchScore replaced the kept copy
  let collisionAssessmentUpgrades = 0;
  let preferenceFilteredSkipped = 0;

  for (const arr of Array.isArray(jobArrays) ? jobArrays : []) {
    if (!Array.isArray(arr)) continue;
    for (const job of arr) {
      if (!job || typeof job !== 'object') continue;
      // Search modules normally publish only preference-accepted jobs in
      // `scoredJobs`. This boundary also has to defend saved/legacy canvases:
      // a stale or manually-edited filtered row must never be displayed by a
      // Job Board (and consequently never reach its seen-history writer).
      if (job.preferenceAssessment?.status === 'filtered') {
        preferenceFilteredSkipped++;
        continue;
      }
      totalIncoming++;
      const key = boardListingKey(job);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, job);
        order.push(key);
      } else {
        collisions++;
        if (jobMatchScore(job) > jobMatchScore(existing)) {
          byKey.set(key, job); // higher score wins; first-seen position unchanged
          collisionUpgrades++;
        } else if (jobMatchScore(job) === jobMatchScore(existing)
          && canSafelyPreferCompensationAssessment(job, existing)) {
          // Compensation is independent of résumé-fit score. On an exact
          // score tie, retain the richer current assessment only when both
          // copies explicitly compare the same advertised cash offer in the
          // same market. Never combine remote assessments from different
          // candidate residences just to make a card look more complete.
          byKey.set(key, job);
          collisionAssessmentUpgrades++;
        }
      }
    }
  }

  if (stats && typeof stats === 'object') {
    stats.totalIncoming = totalIncoming;
    stats.unique = order.length;
    stats.duplicatesRemoved = totalIncoming - order.length;
    stats.collisions = collisions;
    stats.collisionUpgrades = collisionUpgrades;
    stats.collisionAssessmentUpgrades = collisionAssessmentUpgrades;
    stats.preferenceFilteredSkipped = preferenceFilteredSkipped;
  }

  return order.map(k => byKey.get(k));
}

/**
 * A URL is the board's only cross-module proof that two rows are the same
 * listing. Do not turn two missing URLs into the synthetic
 * `title|company|` key: that silently drops separate requisitions which have
 * the same employer and title (a common scrape fallback). Within one search
 * module, retain the legacy location-aware collapse for duplicate fallback
 * rows; across modules, no listing proof exists, so preserve both. An object
 * Map key intentionally makes unlinked legacy rows with no origin unique.
 */
function boardListingKey(job) {
  if (String(job?.url || job?.googleCardUrl || '').trim()) return jobTitleCompanyUrlKey(job);
  const originHubId = String(job?.originHubId || '').trim();
  return originHubId ? `unlinked:${originHubId}|${jobTitleCompanyLocationKey(job)}` : job;
}

// Saved canvases and provider responses can outlive a renderer update. Keep one
// score boundary for both the merge and the taxonomy IPC projection: without it,
// a legacy string score can win the merge correctly but be sent to bucketing as
// zero, putting an 80-fit job in the wrong board branch.
export function normalizeJobMatchScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

function jobMatchScore(job) {
  return normalizeJobMatchScore(job?.matchScore);
}

/**
 * Attach the transient residence settings belonging to each merged job's
 * originating search module. A board can combine modules configured with
 * different residences, so selecting one board-wide map would research some
 * remote listings against the wrong market. The helper is pure: callers get
 * cloned job objects and the stored scored jobs remain untouched.
 *
 * The main-process board-stage handler removes this field in `finally` after
 * research; buildJobTreeNodes also uses an explicit whitelist, so it can never
 * become persisted card data.
 */
export function attachCompensationRemoteResidences(jobs, residencesByOrigin = {}) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => ({
    ...job,
    compensationRemoteResidences: residencesByOrigin?.[job?.originHubId] || {},
  }));
}

function normalizedAssessmentLocation(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (!value || typeof value !== 'object') return '';
  return String(value.display || value.label || [value.city, value.subdivision ?? value.state ?? value.province, value.country]
    .filter(Boolean).join(', ')).trim().toLowerCase();
}

function assessmentOfferKey(value) {
  const assessment = value && typeof value === 'object' ? value : null;
  const offer = assessment?.offered;
  if (Number(assessment?.schemaVersion) !== 1 || !offer || typeof offer !== 'object') return '';
  const min = Number(offer.min);
  const max = Number(offer.max);
  const currency = String(offer.currency || '').trim().toUpperCase();
  const period = String(offer.period || '').trim().toLowerCase();
  const location = normalizedAssessmentLocation(assessment.comparisonLocation);
  if (!(min > 0) || !(max >= min) || !currency || !location) return '';
  return `${min}|${max}|${currency}|${period || 'annual'}|${location}`;
}

function assessmentQuality(value) {
  const assessment = value && typeof value === 'object' ? value : null;
  if (Number(assessment?.schemaVersion) !== 1) return 0;
  const status = String(assessment.status || '').trim().toLowerCase();
  if (status === 'competitive' || status === 'below_market') return 4;
  if (status === 'uncertain') return 3;
  if (status === 'not_evaluated') return 1;
  return 0;
}

function canSafelyPreferCompensationAssessment(candidate, existing) {
  const candidateKey = assessmentOfferKey(candidate?.compensationAssessment);
  const existingKey = assessmentOfferKey(existing?.compensationAssessment);
  return !!candidateKey && candidateKey === existingKey
    && assessmentQuality(candidate?.compensationAssessment) > assessmentQuality(existing?.compensationAssessment);
}

// Keyed by the scoredJobs array identity. Correct only because every writer of
// node.data.scoredJobs replaces the array with a fresh one — nothing mutates a
// stored array or its job objects in place. If that ever changes, this cache
// must go, not gain an invalidation hook.
const FINGERPRINT_CACHE = new WeakMap();

/**
 * Fingerprint every immutable Job Search input that can alter a Board card.
 * Candidate residence is included because the Board compensation pass chooses
 * its comparison market from this per-Search snapshot. Keeping this helper
 * beside moduleFingerprint also lets graph duplication rebuild an equivalent
 * signature after Search node ids/provenance are remapped.
 */
export function moduleCombineFingerprint(scoredJobs, remoteResidences) {
  const source = remoteResidences && typeof remoteResidences === 'object' ? remoteResidences : {};
  const residenceRows = ['usa', 'canada', 'other'].map((key) => {
    const value = source[key] && typeof source[key] === 'object' ? source[key] : {};
    return [
      key,
      value.city || '',
      value.subdivision || value.stateCode || value.region || '',
      value.country || '',
      value.countryCode || '',
      value.countryConflict === true,
    ];
  });
  const residenceFingerprint = moduleFingerprint([{
    source: 'remote-residences',
    location: JSON.stringify(residenceRows),
  }]);
  return `${moduleFingerprint(scoredJobs)}.${residenceFingerprint}`;
}

/**
 * Cheap content fingerprint of one module's scored jobs. Changes when the set
 * changes size (re-scrape), any score changes (re-score), the order changes,
 * or any card-visible/origin-sensitive job field changes,
 * so it tells whether a connection carries the SAME card-visible data it did at
 * the last Combine. It runs inside a reactive store selector, which zustand
 * re-runs on every ReactFlow setState (pan/drag frames included), so repeat
 * calls for an unchanged array are served from FINGERPRINT_CACHE — the O(n)
 * fold over every job's text now costs kilobytes of characters per job. Not a
 * cryptographic hash, but unlike the old count+score-sum format it can't be
 * fooled by a re-run whose score deltas cancel out ([80,90] → [85,85]).
 *
 * The "7:" prefix versions the format: combineSignatures saved by older
 * fingerprint can't be recomputed, so the board treats a signature without the
 * marker as a legacy baseline to adopt rather than a staleness mismatch (see
 * isLegacyCombineSignature).
 *
 * @param {object[]} scoredJobs
 * @returns {string} e.g. "7:191:123456789" (version:length:fold)
 */
export function moduleFingerprint(scoredJobs) {
  const isArray = Array.isArray(scoredJobs);
  if (isArray) {
    const cached = FINGERPRINT_CACHE.get(scoredJobs);
    if (cached !== undefined) return cached;
  }
  const arr = isArray ? scoredJobs : [];
  // FNV-1a is cheap enough to run in the ReactFlow store selector while making
  // every field that can alter a spawned card (or its origin-hub lookup) part
  // of staleness. The old fold used score + title length + title initial only,
  // so two different "Manager ?" jobs with equal scores could leave a board
  // falsely current after a re-run.
  let h = 0x811c9dc5;
  const fold = (value) => {
    const text = value == null ? '' : String(value);
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    // Field delimiter prevents e.g. ["ab", "c"] colliding with ["a", "bc"].
    h = Math.imul(h ^ 0xff, 0x01000193);
  };
  const foldFitAssessment = (assessment) => {
    const value = assessment && typeof assessment === 'object' ? assessment : null;
    // Mirror compactHiringFitAudit's display boundary. An unaudited saved card
    // renders only its fixed continuity message, so internal provider fields
    // below must not create a false board-staleness signal.
    const isAudited = value?.auditStatus === 'audited';
    fold(isAudited);
    if (!isAudited) return;

    const finiteNumber = (raw) => {
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    };
    const auditStatus = (row) => {
      const status = String(row?.effectiveStatus || row?.status || '').trim().toLowerCase().replace(/-/g, '_');
      return ['direct', 'adjacent', 'not_documented', 'contradicted', 'unclear'].includes(status) ? status : '';
    };
    const requirementLabel = (row) => String(row?.requirement || row?.requirementText || '')
      .replace(/\s+/g, ' ')
      .trim();
    const confidence = String(value?.confidence?.effective || '').trim().toLowerCase();
    fold(['high', 'medium', 'low', 'unknown'].includes(confidence) ? confidence : '');
    const groundedRequirementCount = finiteNumber(value?.confidence?.groundedRequirementCount);
    const requirementCount = finiteNumber(value?.confidence?.requirementCount);
    // Coverage is rendered only when both counts are finite and non-negative.
    // Normalize the whole hidden case to avoid treating different malformed
    // provider values as a card-visible board update.
    const hasCoverage = groundedRequirementCount !== null && requirementCount !== null
      && groundedRequirementCount >= 0 && requirementCount >= 0;
    fold(hasCoverage ? groundedRequirementCount : null);
    fold(hasCoverage ? requirementCount : null);
    fold(finiteNumber(value?.rawScore));
    fold(finiteNumber(value?.adjustedScore));
    const foldRows = (rows, rejectedOnly = false) => {
      const list = Array.isArray(rows) ? rows : [];
      // The explicit rejected-row list renders only its unique labels; its
      // cardinality (including empty/duplicate rows) has no visible effect.
      if (!rejectedOnly) fold(list.length);
      for (const row of list) {
        // rejectedRequirementRows are rendered solely as de-duplicated labels.
        // Their original provider status/evidence payload is deliberately not
        // surfaced, so hashing it would make a board stale for no visible
        // change.
        fold(requirementLabel(row));
        if (rejectedOnly) continue;
        fold(auditStatus(row));
        fold(row?.scoreImpact === 'informational');
        fold(row?.materialGap === true);
        fold(row?.grounding?.requirementGrounded === true);
        fold(row?.grounding?.candidateClaimGrounded === true);
        // The card only asks whether rejected evidence exists; its count/text
        // never reaches the compact audit.
        fold(Array.isArray(row?.grounding?.rejectedJobEvidence) && row.grounding.rejectedJobEvidence.length > 0);
        fold(Array.isArray(row?.grounding?.rejectedCandidateEvidence) && row.grounding.rejectedCandidateEvidence.length > 0);
      }
    };
    foldRows(value?.requirementRows);
    foldRows(value?.rejectedRequirementRows, true);
  };
  const foldPreferenceAssessment = (assessment) => {
    const value = assessment && typeof assessment === 'object' ? assessment : null;
    fold(value?.status);
    fold(value?.summary);
    const preferenceScore = Number(value?.preferenceScore);
    fold(Number.isFinite(preferenceScore) ? preferenceScore : null);
    const matches = Array.isArray(value?.matches) ? value.matches : [];
    fold(matches.length);
    for (const match of matches) {
      fold(match?.preferenceId);
      fold(match?.criterion);
      fold(match?.category);
      fold(match?.strict === true);
      fold(match?.outcome);
      fold(match?.evidence);
      fold(match?.source);
      fold(match?.sourceDate);
      fold(match?.verifiedAt);
      const sourceUrls = Array.isArray(match?.sourceUrls) ? match.sourceUrls : [];
      fold(sourceUrls.length);
      for (const url of sourceUrls) fold(url);
    }
  };
  const foldStructured = (value, depth = 0) => {
    if (depth > 8) { fold('__depth_limit__'); return; }
    if (value == null || typeof value !== 'object') {
      fold(typeof value);
      fold(value);
      return;
    }
    if (Array.isArray(value)) {
      fold('array');
      fold(value.length);
      value.slice(0, 100).forEach(item => foldStructured(item, depth + 1));
      if (value.length > 100) fold('__items_truncated__');
      return;
    }
    const keys = Object.keys(value).sort();
    fold('object');
    fold(keys.length);
    keys.slice(0, 100).forEach((key) => {
      fold(key);
      foldStructured(value[key], depth + 1);
    });
    if (keys.length > 100) fold('__keys_truncated__');
  };
  for (const j of arr) {
    if (!j || typeof j !== 'object') {
      fold('__non-job__');
      continue;
    }
    fold(j.matchScore);
    fold(j.title);
    fold(j.company);
    fold(j.location);
    fold(j.salary);
    fold(j.compensation);
    fold(j.currency);
    fold(j.snippet);
    fold(j.description);
    fold(j.reasoning);
    fold(j.careerDirection);
    fold(j.source);
    fold(j.url);
    fold(j.googleCardUrl);
    fold(j.posted);
    fold(j.language);
    fold(j.originHubId);
    // A change in the career snapshot changes what this card is allowed to
    // generate, even if the listing and score happen to be identical.
    fold(j.careerSnapshotId);
    // These fields are consumed by the downstream compensation pipeline even
    // when they are not rendered directly on a card. A paused Combine must be
    // invalidated if its role/work-mode/experience cohort inputs change.
    fold(j.remote === true);
    fold(j.isRemote === true);
    fold(j.workMode);
    fold(j.remoteRegion);
    fold(j.remoteCountry);
    foldStructured(j.compensationContext);
    foldStructured(j.experienceAssessment);
    // Preference status, evidence and its secondary ordering score are all
    // user-visible card input. Any change must offer Re-combine rather than
    // leaving a board showing the previous ordering/explanation.
    foldPreferenceAssessment(j.preferenceAssessment);
    // The card's expandable hiring-fit audit is derived from fitAssessment,
    // not from the short top-level reasoning above. It must participate in
    // staleness, or refreshed evidence/gaps can leave an old card disclosure
    // visible while the board incorrectly claims its inputs are current.
    foldFitAssessment(j.fitAssessment);
    // A compensation assessment controls the card's border, expandable
    // explanation, source list, and comparison metadata. It must participate
    // in board staleness just like visible match reasoning does, otherwise a
    // re-run can leave an old red/green card on a board that claims it is
    // current. Fold the current renderer contract explicitly instead of
    // JSON.stringify so property insertion order cannot create false updates.
    const assessment = j.compensationAssessment;
    fold(assessment?.schemaVersion);
    fold(assessment?.status);
    fold(assessment?.reasonCode);
    fold(assessment?.justification);
    fold(assessment?.researchedAt);
    const comparisonLocation = assessment?.comparisonLocation;
    fold(typeof comparisonLocation === 'object' && comparisonLocation
      ? comparisonLocation.display ?? comparisonLocation.label ?? comparisonLocation.city
      : comparisonLocation);
    if (comparisonLocation && typeof comparisonLocation === 'object') {
      fold(comparisonLocation.subdivision ?? comparisonLocation.state ?? comparisonLocation.province);
      fold(comparisonLocation.country);
    }
    for (const range of [assessment?.offered, assessment?.competitiveRange]) {
      fold(range?.min);
      fold(range?.max);
      fold(range?.currency);
      fold(range?.period);
    }
    const links = Array.isArray(assessment?.sourceLinks) ? assessment.sourceLinks : [];
    fold(links.length);
    for (const link of links) {
      if (typeof link === 'string') { fold(link); continue; }
      fold(link?.title ?? link?.name ?? link?.label);
      fold(link?.url ?? link?.href ?? link?.link);
      fold(link?.note ?? link?.details ?? link?.summary);
      const range = link?.range ?? link?.competitiveRange ?? link;
      fold(range?.min ?? range?.low ?? range?.minimum);
      fold(range?.max ?? range?.high ?? range?.maximum);
      fold(range?.currency ?? range?.currencyCode);
      fold(range?.period ?? range?.payPeriod ?? range?.unit);
    }
    // Consolidated multi-location rows carry a bounded variant union whose
    // location/URL/source mix is card-visible. Variant rows are folded only when
    // present, so an ordinary variant-less board keeps its previous fingerprint
    // (no spurious mass staleness) while any change to a consolidated row's
    // variants deterministically changes the signature. Fields fold in a fixed
    // order so property insertion order cannot create false updates.
    if (Array.isArray(j.postingVariants) && j.postingVariants.length > 0) {
      fold(j.postingVariants.length);
      fold(Number.isFinite(j.consolidatedLocationCount) ? j.consolidatedLocationCount : null);
      fold(Number.isFinite(j.consolidatedPostingCount) ? j.consolidatedPostingCount : null);
      for (const variant of j.postingVariants) {
        if (!variant || typeof variant !== 'object') { fold(variant); continue; }
        fold(variant.location);
        fold(variant.url);
        fold(variant.googleCardUrl);
        fold(variant.applyUrl);
        fold(variant.source);
        fold(variant.posted);
        fold(variant.salary);
        fold(variant.applySource);
        fold(variant.jobkey);
      }
    }
  }
  const signature = `7:${arr.length}:${h >>> 0}`;
  if (isArray) FINGERPRINT_CACHE.set(scoredJobs, signature);
  return signature;
}

/**
 * True when a stored combineSignature predates the versioned fingerprint
 * format. Old signatures can't be compared against live ones (the math
 * changed), so the board adopts the live signature as its baseline instead of
 * flagging a false "connections changed".
 */
export function isLegacyCombineSignature(signature) {
  const parsed = parseCombineSignature(signature);
  if (parsed.format === 'empty') return false;
  if (parsed.format === 'v8') return false;
  // A corrupted structured signature may have been written after a Combine
  // but cannot be verified against the visible cascade. Unlike pre-v3 legacy
  // signatures, it must *not* be adopted as a fresh baseline: normal Board
  // equality will flag it stale and hide the unverifiable old result.
  if (parsed.format === 'v8-invalid') return false;
  // A malformed delimiter signature cannot safely describe the visible
  // cascade. Treat it like the older pre-versioned shapes: the Board will
  // adopt its live input baseline rather than parse a truncated id and claim
  // an imported result set is current.
  if (!parsed.valid) return !!String(signature || '');
  // v3 introduced visible-data folding, v4 added compensation, v5 added the
  // fit audit, v6 added Job Preferences, and v7 adds pre-research compensation
  // inputs. Those signatures must still be
  // compared (and therefore go stale) after an upgrade; silently adopting one
  // could leave old card ordering/evidence visible. Only pre-v3 formats lack a
  // safe enough baseline to compare and are adopted on load.
  return !parsed.entries.some(([, fingerprint]) => /^[34567]:/.test(fingerprint));
}

/**
 * Decode a Board combine signature without making node ids part of a fragile
 * delimiter grammar. Version 8 serializes sorted `[id, fingerprint]` pairs as
 * JSON only when a delimiter-bearing imported id/fingerprint (or the reserved
 * v8 prefix) requires it, so `search|west=1` remains one exact identity
 * without rewriting normal saves.
 *
 * Delimiter signatures are retained for saved-canvas compatibility. They are
 * intentionally parsed strictly: a malformed row is not silently split into a
 * different source id, because that could make stale detection or copied Board
 * provenance refer to the wrong Job Search.
 */
export function parseCombineSignature(signature) {
  if (typeof signature !== 'string' || !signature) {
    return { format: 'empty', valid: true, entries: [] };
  }
  // The emitted v8 form starts with a JSON pair array. Do not reserve every
  // `8:` prefix: a pre-v8 imported node id can itself begin with `8:` and its
  // ordinary delimiter signature must remain readable after upgrade.
  if (signature.startsWith('8:[[')) {
    try {
      const value = JSON.parse(signature.slice(2));
      if (!Array.isArray(value) || !value.every((entry) => (
        Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === 'string'
        && entry[0]
        && typeof entry[1] === 'string'
      ))) {
        return { format: 'v8-invalid', valid: false, entries: [] };
      }
      return { format: 'v8', valid: true, entries: value };
    } catch {
      return { format: 'v8-invalid', valid: false, entries: [] };
    }
  }
  // Keep historically valid delimiter signatures such as
  // `8:imported-search=7:…` readable: imported node ids were unrestricted
  // before v8. But a bare `8:` payload cannot be a delimiter signature at
  // all. Classify it as a corrupt structured attempt so the Board marks its
  // visible cascade stale instead of adopting unverifiable provenance as an
  // old baseline.
  if (signature.startsWith('8:') && !signature.includes('=')) {
    return { format: 'v8-invalid', valid: false, entries: [] };
  }
  const entries = [];
  for (const row of signature.split('|')) {
    if (!row) continue;
    const separator = row.lastIndexOf('=');
    if (separator <= 0) return { format: 'legacy-invalid', valid: false, entries: [] };
    entries.push([row.slice(0, separator), row.slice(separator + 1)]);
  }
  return { format: 'legacy', valid: true, entries };
}

/**
 * Reconcile the summary/filter metadata stored on a Job Board after a user
 * dismisses a disposable card. The cascade nodes are the authoritative live
 * result set; leaving this metadata at its original Combine values made the
 * board claim jobs/sources that no longer existed.
 */
export function deriveBoardCardStats(nodes, hubId, currentData = {}) {
  const cards = (Array.isArray(nodes) ? nodes : []).filter((node) =>
    node?.type === 'jobcard' && node.data?.hubId === hubId
  );
  const finalSourceCounts = {};
  const scores = [];
  for (const card of cards) {
    const source = String(card.data?.source || '').trim();
    if (source) finalSourceCounts[source] = (finalSourceCounts[source] || 0) + 1;
    const score = Number(card.data?.matchScore);
    if (Number.isFinite(score)) scores.push(score);
  }
  const scoreRangeMin = scores.length ? Math.min(...scores) : 0;
  const scoreRangeMax = scores.length ? Math.max(...scores) : 100;
  const previousThreshold = Number(currentData.scoreThreshold);
  const unclampedThreshold = Number.isFinite(previousThreshold) ? previousThreshold : scoreRangeMin;
  const scoreThreshold = scores.length
    ? Math.min(scoreRangeMax, Math.max(scoreRangeMin, unclampedThreshold))
    : 0;
  const activeSource = currentData.sourceFilter || null;
  return {
    resultCount: cards.length,
    finalSourceCounts,
    scoreRangeMin,
    scoreRangeMax,
    scoreThreshold,
    // Do not strand the user behind an active filter whose last card was just
    // dismissed. This also prevents a source pill from disappearing while its
    // invisible filter remains selected.
    sourceFilter: activeSource && !finalSourceCounts[activeSource] ? null : activeSource,
  };
}

/**
 * Canonical signature of every completed module at Combine time: sorted
 * `id=fingerprint` pairs for ordinary IDs, with v8 JSON `[id, fingerprint]`
 * pairs only when an imported delimiter-bearing value needs it. Zero-result
 * completed modules are intentionally included so a terminal empty re-run is
 * an update, not a disappearance. Two combines are equivalent (→ the cached
 * board is still valid) iff their signatures are equal — same completed-module
 * set AND same data in each. Order independent (connection order doesn't
 * matter).
 *
 * @param {{id: string, fingerprint: string}[]} modules  completed modules (zero-result included)
 * @returns {string}
 */
export function combineSignature(modules) {
  const entries = (Array.isArray(modules) ? modules : [])
    .filter(module => typeof module?.id === 'string' && module.id)
    .map(module => [module.id, String(module.fingerprint ?? '')])
    .sort(([leftId, leftFingerprint], [rightId, rightFingerprint]) => (
      leftId < rightId ? -1 : leftId > rightId ? 1
        : leftFingerprint < rightFingerprint ? -1 : leftFingerprint > rightFingerprint ? 1 : 0
    ));
  if (entries.length === 0) return '';
  // Keep ordinary generated ids byte-for-byte compatible with the v3–v7
  // persisted representation. Raw equality is deliberately used by durable
  // recovery fences, so unconditionally upgrading a healthy Board to JSON
  // would falsely mark every existing canvas stale after an app update.
  // `=` in an id remains unambiguous because legacy parsing splits at the
  // final separator; an `=` in the opaque fingerprint (or any `|`) is not.
  const legacySignature = entries.map(([id, fingerprint]) => `${id}=${fingerprint}`).join('|');
  const requiresStructuredFormat = legacySignature.startsWith('8:') || entries.some(([id, fingerprint]) => (
    id.includes('|') || fingerprint.includes('|') || fingerprint.includes('=')
  ));
  return requiresStructuredFormat
    ? `8:${JSON.stringify(entries)}`
    : legacySignature;
}

/**
 * Keep an already-valid Board cascade available while one of the same
 * connected Searches is in a transient run state. The terminal signature
 * deliberately represents such a Search as `state:<hubState>` while it is
 * working; that is not yet proof that the previously combined cards are
 * obsolete. Once every Search is terminal, ordinary signature staleness
 * applies again.
 *
 * A topology change must still hide immediately, even if another Search is
 * active. Compare the exact connected id set to the last successful Combine
 * before preserving the snapshot.
 */
export function shouldKeepCompletedBoardSnapshotVisible({
  boardHubState = '',
  boardStale = false,
  boardLocked = false,
  combineSignature: priorSignature = null,
  completedModules = [],
  connectedModules = [],
} = {}) {
  if (boardHubState !== 'done' || boardStale || boardLocked || isLegacyCombineSignature(priorSignature)) return false;
  const parsed = parseCombineSignature(priorSignature);
  if (!parsed.valid || parsed.entries.length === 0) return false;

  const priorById = new Map(parsed.entries);
  const connected = Array.isArray(connectedModules) ? connectedModules : [];
  const completedById = new Map(
    (Array.isArray(completedModules) ? completedModules : [])
      .filter(module => typeof module?.id === 'string' && !!module.id)
      .map(module => [module.id, module]),
  );
  // Exact topology must match; duplicate/malformed module records fail closed.
  if (priorById.size !== parsed.entries.length || priorById.size !== connected.length) return false;
  const seenConnectedIds = new Set();
  let hasActiveSearch = false;
  for (const module of connected) {
    if (!module?.id || seenConnectedIds.has(module.id) || !priorById.has(module.id)) return false;
    seenConnectedIds.add(module.id);
    if (ACTIVE_JOB_SEARCH_STATES.has(module.hubState)) {
      hasActiveSearch = true;
      continue;
    }
    // An active sibling must not conceal a completed Search whose output
    // already changed; that remains ordinary stale-input evidence.
    const completed = completedById.get(module.id);
    if (!completed || completed.fingerprint !== priorById.get(module.id)) return false;
  }
  return hasActiveSearch;
}

/**
 * Returns the reason an empty search result cannot replace a board, or null
 * when it is safe to ask the user to clear the stale cascade. Keeping this
 * predicate pure lets the click path and the confirmation-time recheck use
 * exactly the same preconditions.
 */
export function emptyReplacementIneligibilityReason({
  stale = false,
  allConnectedModulesDone = false,
  readyModuleCount = 0,
} = {}) {
  if (!allConnectedModulesDone) return 'one or more connected searches are no longer terminal';
  if (readyModuleCount > 0) return 'one or more connected searches now have jobs';
  if (!stale) return 'the board is no longer stale';
  return null;
}

/**
 * Human-readable reason a board is stale, by diffing the signature captured at
 * the last Combine against the current completed-module set: how many
 * connections were disconnected, newly added, are currently re-running, or
 * had their terminal data change. A completed module that now has zero jobs is
 * therefore reported as updated, not disconnected. Supplying all connected
 * modules lets a board distinguish a genuinely removed edge from a still-wired
 * search that is temporarily non-terminal while it refreshes.
 *
 * @param {string} prevSignature  what `combineSignature` returned at last Combine
 * @param {{id: string, fingerprint: string}[]} liveModules  current completed modules (zero-result included)
 * @param {{id: string, hubState?: string}[]} [connectedModules] all connected modules, including in-progress ones
 * @returns {string} e.g. "1 disconnected · 1 updated" (or "connections changed")
 */
export function staleReason(prevSignature, liveModules, connectedModules) {
  const was = new Map(parseCombineSignature(prevSignature).entries);
  const now = new Map((Array.isArray(liveModules) ? liveModules : []).map(m => [m.id, m.fingerprint]));
  const connected = new Map((Array.isArray(connectedModules) ? connectedModules : []).map(m => [m.id, m]));
  let disconnected = 0, added = 0, updated = 0, updating = 0;
  for (const [mid, fp] of was) {
    if (!now.has(mid)) {
      // The module left the terminal signature because it is searching/scoring,
      // not because its edge vanished. Do not tell the user it disconnected.
      if (connected.has(mid)) updating++;
      else disconnected++;
    }
    else if (now.get(mid) !== fp) updated++;
  }
  for (const mid of now.keys()) if (!was.has(mid)) added++;
  const parts = [];
  if (disconnected) parts.push(`${disconnected} disconnected`);
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (updating) parts.push(`${updating} updating`);
  return parts.join(' · ') || 'connections changed';
}
