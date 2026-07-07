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
 *
 * Each kept representative tracks its OWN best-known location (`rep.loc`),
 * upgraded the first time it absorbs a job that has a real location. Without
 * this, a group's first entry landing with an unknown location would match
 * (and swallow) every later job via the "either side unknown" leniency
 * regardless of THAT job's own known location — collapsing two genuinely
 * different cities onto the one unresolved entry instead of onto each other.
 * Upgrading means only the FIRST location-bearing job merges into it; from
 * then on the representative has a real location and behaves like any other
 * exact-match comparison, so a second, different city still starts its own
 * group entry instead of being swallowed too.
 */
export function dedupJobsAcrossSources(jobs) {
  const arr = Array.isArray(jobs) ? jobs : [];
  const groups = new Map(); // titleCompanyKey -> [{ job, loc }] kept representatives, in first-seen order
  const result = [];
  for (const job of arr) {
    const groupKey = jobTitleCompanyKey(job);
    const loc = normalizedLocationOrNull(job);
    const kept = groups.get(groupKey);
    if (!kept) {
      groups.set(groupKey, [{ job, loc }]);
      result.push(job);
      continue;
    }
    const match = kept.find((rep) => loc === null || rep.loc === null || loc === rep.loc);
    if (!match) {
      kept.push({ job, loc });
      result.push(job);
      continue;
    }
    // Matched an ambiguous (unknown-location) representative via a
    // known-location job — adopt that location so later jobs compare against
    // the real city, not "anything goes" forever.
    if (match.loc === null && loc !== null) match.loc = loc;
  }
  return result;
}

/**
 * Location-aware sibling of uniqueJobsNotIn, for the same "candidate is unique
 * against an existing set" shape but using dedupJobsAcrossSources's
 * title+company+location-tolerant matching instead of a location-blind
 * keyFn. Every current caller wants exactly this: "mirror the backend's
 * cross-source dedup for a job arriving outside the main gather" (a late
 * USAJobs append, a captcha/paste-resolved item) — a location-blind key
 * would over-collapse a genuinely distinct same-title/company job in a
 * different city onto an existing one, the same bug dedupJobsAcrossSources
 * exists to prevent.
 *
 * Implemented by deduping the concatenation (existing first, so existing
 * entries always win any group) and returning only the candidates that
 * survived and aren't reference-identical to an original existing job.
 */
export function uniqueJobsAcrossSources(existingJobs, candidateJobs) {
  const existing = Array.isArray(existingJobs) ? existingJobs : [];
  const existingSet = new Set(existing);
  const deduped = dedupJobsAcrossSources([...existing, ...(Array.isArray(candidateJobs) ? candidateJobs : [])]);
  return deduped.filter((job) => !existingSet.has(job));
}
