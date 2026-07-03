/**
 * Job identity keys — the dedup vocabulary for the whole pipeline.
 *
 * WHICH KEY TO USE (policy — keep new call sites consistent):
 *
 *   jobTitleCompanyKey (title|company)
 *     "Same posting, any board." The SAME job scraped from two boards has two
 *     different URLs, so this is the only key that collapses cross-source
 *     copies. It is the key for every SAME-RUN merge in the renderer
 *     (post-Solve resolve items, the late USAJobs append) — anything the
 *     backend would have collapsed had it arrived in the main gather must
 *     collapse the same way when it arrives late. The backend's own
 *     cross-source dedup (jobs.js dedupJobsAcrossSources, below) additionally
 *     considers location — see dedupJobsAcrossSources for why title+company
 *     alone over-collapses distinct same-title/company reqs in different
 *     cities.
 *
 *   jobTitleCompanyUrlKey (title|company|url)
 *     "Same listing." Used by the Job Board union across SEVERAL search
 *     modules (mergeJobs.js): different modules may target different
 *     locations, where same title+company can be genuinely distinct reqs —
 *     the conservative key keeps them apart (a visible duplicate beats a
 *     silently-collapsed distinct opening).
 *
 *   jobTitleCompanyLocationKey (title|company|location)
 *     Multi-req-aware identity for persistent records (history CSV uses its
 *     own equivalent) — same title at Google NYC vs Google SF are separate
 *     opportunities.
 *
 *   sourceJobKey (native id → url → title|company|location)
 *     WITHIN-SOURCE dedup of one source's own multi-page / multi-query gather
 *     (the Indeed extractors). Prefers the source's stable native id (Indeed's
 *     `jobkey`), then the canonical url, then the location-aware composed key —
 *     so a nationwide search's genuinely distinct same-title/same-company reqs
 *     in different cities stay separate when no native id is present.
 */
function keyPart(value) {
  return String(value || '').toLowerCase().trim();
}

export function jobTitleCompanyKey(job) {
  return `${keyPart(job?.title)}|${keyPart(job?.company)}`;
}

export function jobTitleCompanyUrlKey(job) {
  return `${jobTitleCompanyKey(job)}|${keyPart(job?.url)}`;
}

export function jobTitleCompanyLocationKey(job) {
  return `${jobTitleCompanyKey(job)}|${keyPart(job?.location)}`;
}

/**
 * Per-listing dedup key for a single source's own gather (see policy above).
 * Both Indeed extractors share this one definition so they can't drift — the
 * browser path previously fell back to title|company and could over-collapse a
 * nationwide search's distinct-location reqs that share a title and company.
 */
export function sourceJobKey(job) {
  return job?.jobkey || job?.url || jobTitleCompanyLocationKey(job);
}

export function dedupeJobsByKey(jobs, keyFn) {
  const seen = new Set();
  const deduped = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const key = keyFn(job);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }
  return deduped;
}

export function uniqueJobsNotIn(existingJobs, candidateJobs, keyFn) {
  const seen = new Set((Array.isArray(existingJobs) ? existingJobs : []).map(keyFn));
  const unique = [];
  for (const job of Array.isArray(candidateJobs) ? candidateJobs : []) {
    const key = keyFn(job);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(job);
  }
  return unique;
}

function normalizedLocationOrNull(job) {
  const loc = keyPart(job?.location);
  return loc ? loc : null;
}

/**
 * Cross-source dedup: collapses the SAME posting scraped from two different
 * boards (which necessarily have two different URLs) while still keeping
 * genuinely distinct same-title/same-company reqs in different cities apart
 * (e.g. a nationwide search legitimately turning up "Software Engineer" at
 * Google in both NYC and SF).
 *
 * Grouped by title+company, then within each group two jobs are treated as
 * the same posting only when their locations match OR at least one side's
 * location couldn't be read — plain title+company alone can't express this
 * (it always collapses), and a strict title+company+location key can't
 * either (it would fail to collapse the same posting when one source omits
 * location and the other doesn't). First-seen order within each source's
 * gather is preserved, matching the old dedupByTitleCompany's semantics.
 */
export function dedupJobsAcrossSources(jobs) {
  const arr = Array.isArray(jobs) ? jobs : [];
  const groups = new Map(); // titleCompanyKey -> kept jobs in that group
  const result = [];
  for (const job of arr) {
    const groupKey = jobTitleCompanyKey(job);
    const kept = groups.get(groupKey);
    if (!kept) {
      groups.set(groupKey, [job]);
      result.push(job);
      continue;
    }
    const loc = normalizedLocationOrNull(job);
    const isDuplicate = kept.some((other) => {
      const otherLoc = normalizedLocationOrNull(other);
      return loc === null || otherLoc === null || loc === otherLoc;
    });
    if (isDuplicate) continue;
    kept.push(job);
    result.push(job);
  }
  return result;
}
