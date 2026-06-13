import { jobTitleCompanyUrlKey } from '../../utils/jobIdentity.js';

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
 * `{ totalIncoming, unique, duplicatesRemoved, collisions, collisionUpgrades }`.
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

  for (const arr of Array.isArray(jobArrays) ? jobArrays : []) {
    if (!Array.isArray(arr)) continue;
    for (const job of arr) {
      if (!job || typeof job !== 'object') continue;
      totalIncoming++;
      const key = jobTitleCompanyUrlKey(job);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, job);
        order.push(key);
      } else {
        collisions++;
        if ((job.matchScore || 0) > (existing.matchScore || 0)) {
          byKey.set(key, job); // higher score wins; first-seen position unchanged
          collisionUpgrades++;
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
  }

  return order.map(k => byKey.get(k));
}

/**
 * Cheap content fingerprint of one module's scored jobs. Changes when the set
 * changes size (re-scrape), any score changes (re-score), the order changes,
 * or the jobs themselves change (folds each title's length + first character),
 * so it tells whether a connection carries the SAME data it did at the last
 * Combine. Deliberately O(n) + allocation-free so it can run inside the
 * reactive store selector on every frame; not a cryptographic hash, but unlike
 * the old count+score-sum format it can't be fooled by a re-run whose score
 * deltas cancel out ([80,90] → [85,85]).
 *
 * The "2:" prefix versions the format: combineSignatures saved by the old
 * fingerprint can't be recomputed, so the board treats a signature without the
 * marker as a legacy baseline to adopt rather than a staleness mismatch (see
 * isLegacyCombineSignature).
 *
 * @param {object[]} scoredJobs
 * @returns {string} e.g. "2:191:-1240318" (version:length:fold)
 */
export function moduleFingerprint(scoredJobs) {
  const arr = Array.isArray(scoredJobs) ? scoredJobs : [];
  let h = 0;
  for (const j of arr) {
    const s = (j && typeof j.matchScore === 'number') ? j.matchScore : -1;
    const t = (j && typeof j.title === 'string') ? j.title : '';
    h = (h * 33 + s + 1) | 0;
    h = (h * 33 + t.length) | 0;
    h = (h * 33 + (t.charCodeAt(0) || 0)) | 0;
  }
  return `2:${arr.length}:${h}`;
}

/**
 * True when a stored combineSignature predates the versioned fingerprint
 * format. Old signatures can't be compared against live ones (the math
 * changed), so the board adopts the live signature as its baseline instead of
 * flagging a false "connections changed".
 */
export function isLegacyCombineSignature(signature) {
  const s = String(signature || '');
  return !!s && !s.includes('=2:');
}

/**
 * Canonical signature of the modules that feed a Combine: sorted `id=fingerprint`
 * pairs. Two combines are equivalent (→ the cached board is still valid) iff
 * their signatures are equal — same module set AND same data in each. Order
 * independent (connection order doesn't matter).
 *
 * @param {{id: string, fingerprint: string}[]} modules  ready modules (count > 0)
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
 * the last Combine against the live module set: how many connections were
 * disconnected, newly added, or had their data change. Powers the board's
 * "Connections changed — re-combine" prompt.
 *
 * @param {string} prevSignature  what `combineSignature` returned at last Combine
 * @param {{id: string, fingerprint: string}[]} liveModules  current ready modules
 * @returns {string} e.g. "1 disconnected · 1 updated" (or "connections changed")
 */
export function staleReason(prevSignature, liveModules) {
  const was = new Map(
    String(prevSignature || '').split('|').filter(Boolean).map((s) => {
      const eq = s.lastIndexOf('='); // ids have no '='; fingerprint has no '|'
      return [s.slice(0, eq), s.slice(eq + 1)];
    })
  );
  const now = new Map((Array.isArray(liveModules) ? liveModules : []).map(m => [m.id, m.fingerprint]));
  let disconnected = 0, added = 0, updated = 0;
  for (const [mid, fp] of was) {
    if (!now.has(mid)) disconnected++;
    else if (now.get(mid) !== fp) updated++;
  }
  for (const mid of now.keys()) if (!was.has(mid)) added++;
  const parts = [];
  if (disconnected) parts.push(`${disconnected} disconnected`);
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  return parts.join(' · ') || 'connections changed';
}
