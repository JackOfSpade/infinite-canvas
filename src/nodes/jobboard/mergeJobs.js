import { jobTitleCompanyLocationKey, jobTitleCompanyUrlKey } from '../../utils/jobIdentity.js';

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
 *    collisionAssessmentUpgrades }`.
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

  for (const arr of Array.isArray(jobArrays) ? jobArrays : []) {
    if (!Array.isArray(arr)) continue;
    for (const job of arr) {
      if (!job || typeof job !== 'object') continue;
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
  if (String(job?.url || '').trim()) return jobTitleCompanyUrlKey(job);
  const originHubId = String(job?.originHubId || '').trim();
  return originHubId ? `unlinked:${originHubId}|${jobTitleCompanyLocationKey(job)}` : job;
}

// Saved canvases and provider responses can outlive a renderer update. Treat a
// numeric-looking legacy score exactly like the current numeric contract;
// otherwise JavaScript's string comparison makes "9" outrank "80" during a
// board merge. Invalid values retain the historic zero-score fallback.
function jobMatchScore(job) {
  const score = Number(job?.matchScore);
  return Number.isFinite(score) ? score : 0;
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

/**
 * Cheap content fingerprint of one module's scored jobs. Changes when the set
 * changes size (re-scrape), any score changes (re-score), the order changes,
 * or any card-visible/origin-sensitive job field changes,
 * so it tells whether a connection carries the SAME data it did at the last
 * Combine. Deliberately O(n) + allocation-free so it can run inside the
 * reactive store selector on every frame; not a cryptographic hash, but unlike
 * the old count+score-sum format it can't be fooled by a re-run whose score
 * deltas cancel out ([80,90] → [85,85]).
 *
 * The "4:" prefix versions the format: combineSignatures saved by the old
 * fingerprint can't be recomputed, so the board treats a signature without the
 * marker as a legacy baseline to adopt rather than a staleness mismatch (see
 * isLegacyCombineSignature).
 *
 * @param {object[]} scoredJobs
 * @returns {string} e.g. "4:191:123456789" (version:length:fold)
 */
export function moduleFingerprint(scoredJobs) {
  const arr = Array.isArray(scoredJobs) ? scoredJobs : [];
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
    fold(j.snippet);
    fold(j.reasoning);
    fold(j.careerDirection);
    fold(j.source);
    fold(j.url);
    fold(j.posted);
    fold(j.language);
    fold(j.originHubId);
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
  }
  return `4:${arr.length}:${h >>> 0}`;
}

/**
 * True when a stored combineSignature predates the versioned fingerprint
 * format. Old signatures can't be compared against live ones (the math
 * changed), so the board adopts the live signature as its baseline instead of
 * flagging a false "connections changed".
 */
export function isLegacyCombineSignature(signature) {
  const s = String(signature || '');
  return !!s && !/(?:^|\|)[^=]+=([34]):/.test(s);
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
 * `id=fingerprint` pairs. Zero-result completed modules are intentionally
 * included so a terminal empty re-run is an update, not a disappearance. Two
 * combines are equivalent (→ the cached board is still valid) iff their
 * signatures are equal — same completed-module set AND same data in each.
 * Order independent (connection order doesn't matter).
 *
 * @param {{id: string, fingerprint: string}[]} modules  completed modules (zero-result included)
 * @returns {string}
 */
export function combineSignature(modules) {
  return (Array.isArray(modules) ? modules : [])
    .map(m => `${m.id}=${m.fingerprint}`)
    .sort()
    .join('|');
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
  const was = new Map(
    String(prevSignature || '').split('|').filter(Boolean).map((s) => {
      const eq = s.lastIndexOf('='); // ids have no '='; fingerprint has no '|'
      return [s.slice(0, eq), s.slice(eq + 1)];
    })
  );
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
