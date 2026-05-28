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
