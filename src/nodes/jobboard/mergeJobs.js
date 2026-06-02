import { jobTitleCompanyUrlKey } from '../../utils/jobIdentity.js';

/**
 * Merge the scored-job arrays from several Job Search Modules into one deduped
 * list for the Job Board Module. Pure + unit-tested (no ReactFlow runtime).
 *
 * Identity uses the same key as the rest of the pipeline — `jobTitleCompanyUrlKey`
 * (title|company|url) from jobIdentity.js — so the same posting scraped by two
 * connected modules collapses to one card. Unlike `dedupeJobsByKey` (first-wins),
 * the board keeps the entry with the HIGHER matchScore on a collision: when two
 * modules scored the same posting against different résumés, the better fit is the
 * useful one, and that copy carries its own `resumeProfile` so "Generate Résumé +
 * Cover Letter" uses the right origin résumé. First-seen order is otherwise
 * preserved (the cascade re-sorts by score downstream, but a stable input keeps
 * the result deterministic).
 *
 * @param {object[][]} jobArrays  one scored-jobs array per connected module
 * @returns {object[]} the deduped union
 */
export function unionScoredJobs(jobArrays) {
  const order = [];        // dedup keys in first-seen order
  const byKey = new Map(); // key -> winning job

  for (const arr of Array.isArray(jobArrays) ? jobArrays : []) {
    if (!Array.isArray(arr)) continue;
    for (const job of arr) {
      if (!job || typeof job !== 'object') continue;
      const key = jobTitleCompanyUrlKey(job);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, job);
        order.push(key);
      } else if ((job.matchScore || 0) > (existing.matchScore || 0)) {
        byKey.set(key, job); // higher score wins; first-seen position unchanged
      }
    }
  }

  return order.map(k => byKey.get(k));
}
