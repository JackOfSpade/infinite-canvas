// Bounded, report-safe scoring evidence. The scorer runs independent batches,
// so large score deltas between effectively identical postings can otherwise be
// impossible to diagnose after the saved prompt snapshot is gone.

const AUDIT_LIMIT = 50;
const REASON_LIMIT = 240;
const URL_LIMIT = 240;
const LARGE_DELTA = 15;
const ADJUSTMENT_LIMIT = 4;
// These are the only deterministic fallback reasons emitted by
// jobBatchReconcile.buildScoredJob. Keep their rows in bounded diagnostics even
// when a large run would otherwise push them past the ordinary first-N sample.
const PLACEHOLDER_REASONS = new Set(['AI format error', 'Unable to score']);

function normalizedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function textFingerprint(value) {
  const text = normalizedText(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return { normalized: text, hash: (hash >>> 0).toString(16).padStart(8, '0') };
}

/** Stable key for postings that should be calibrated together by the scorer. */
export function scoringSimilarityKey(job) {
  const description = textFingerprint(job?.snippet || job?.description || '');
  if (description.normalized.length < 200) return '';
  const title = normalizedText(job?.title);
  const company = normalizedText(job?.company);
  if (!title || !company) return '';
  return `${title}|${company}|${description.hash}`;
}

function samePostingText(left, right) {
  if (!left || !right || left.length < 200 || right.length < 200) return false;
  if (left === right) return true;
  // Treat a small footer/header variation as the same JD. This conservative
  // containment rule avoids expensive fuzzy matching and does not group short
  // list-card snippets.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length / longer.length >= 0.9 && longer.includes(shorter);
}

/**
 * Build compact per-job evidence and flag cross-batch calibration drift.
 * `batchRows` keeps the original batch number before scored jobs are sorted.
 */
export function buildScoringAudit(batchRows, { limit = AUDIT_LIMIT } = {}) {
  const source = Array.isArray(batchRows) ? batchRows : [];
  const prepared = source.map((entry, index) => {
    const job = entry?.job || {};
    const fp = textFingerprint(job.snippet || job.description || '');
    return {
      index,
      batch: Number(entry?.batch) || 0,
      title: String(job.title || '').slice(0, 120),
      company: String(job.company || '').slice(0, 100),
      location: String(job.location || '').slice(0, 100),
      source: String(job.source || '').slice(0, 40),
      url: String(job.url || '').slice(0, URL_LIMIT),
      score: Number.isFinite(Number(job.matchScore)) ? Number(job.matchScore) : null,
      rawScore: Number.isFinite(Number(job.rawScore)) ? Number(job.rawScore) : null,
      adjustedScore: Number.isFinite(Number(job.adjustedScore)) ? Number(job.adjustedScore) : null,
      adjustments: (Array.isArray(job.fitAssessment?.adjustments) ? job.fitAssessment.adjustments : [])
        .slice(0, ADJUSTMENT_LIMIT)
        .map(adjustment => ({
          code: String(adjustment?.code || '').slice(0, 80),
          from: Number.isFinite(Number(adjustment?.from)) ? Number(adjustment.from) : null,
          to: Number.isFinite(Number(adjustment?.to)) ? Number(adjustment.to) : null,
        })),
      direction: String(job.careerDirection || '').slice(0, 100),
      // Live scoring replaces potentially unsupported model prose with a
      // deterministic grounded explanation. Deliberately never retain the
      // provider's raw narrative in compact diagnostics.
      reason: String(job.reasoning || '').replace(/\s+/g, ' ').trim().slice(0, REASON_LIMIT),
      placeholder: PLACEHOLDER_REASONS.has(String(job.reasoning || '').replace(/\s+/g, ' ').trim()),
      descriptionChars: fp.normalized.length,
      descriptionFingerprint: fp.hash,
      _normalizedDescription: fp.normalized,
    };
  });

  const boundedLimit = Math.max(0, limit);
  // A placeholder is a score-shaped row the model did not genuinely analyze.
  // It is higher-value failure evidence than an ordinary score, so reserve the
  // existing fixed-size audit for them first and fill any remaining slots with
  // the usual original-order sample.
  const placeholderRows = prepared.filter(row => row.placeholder);
  const bounded = [
    ...placeholderRows.slice(0, boundedLimit),
    ...prepared.filter(row => !row.placeholder).slice(0, Math.max(0, boundedLimit - placeholderRows.length)),
  ];
  const anomalies = [];
  for (let i = 0; i < bounded.length; i++) {
    for (let j = i + 1; j < bounded.length; j++) {
      const a = bounded[i], b = bounded[j];
      if (a.batch === b.batch || a.score == null || b.score == null) continue;
      if (normalizedText(a.title) !== normalizedText(b.title)
        || normalizedText(a.company) !== normalizedText(b.company)) continue;
      if (!samePostingText(a._normalizedDescription, b._normalizedDescription)) continue;
      const delta = Math.abs(a.score - b.score);
      if (delta < LARGE_DELTA) continue;
      anomalies.push({
        delta,
        first: { index: a.index, batch: a.batch, score: a.score },
        second: { index: b.index, batch: b.batch, score: b.score },
        title: a.title,
        company: a.company,
        descriptionFingerprint: a.descriptionFingerprint,
      });
      if (anomalies.length >= 10) break;
    }
    if (anomalies.length >= 10) break;
  }

  return {
    rows: bounded.map(row => ({
      index: row.index,
      batch: row.batch,
      title: row.title,
      company: row.company,
      location: row.location,
      source: row.source,
      url: row.url,
      score: row.score,
      rawScore: row.rawScore,
      adjustedScore: row.adjustedScore,
      adjustments: row.adjustments,
      direction: row.direction,
      reason: row.reason,
      placeholder: row.placeholder,
      descriptionChars: row.descriptionChars,
      descriptionFingerprint: row.descriptionFingerprint,
    })),
    omitted: Math.max(0, prepared.length - Math.max(0, limit)),
    anomalies,
  };
}

/** Reattach original batch numbers after reconciliation/sorting. */
export function scoringAuditRowsFromBatches(batches, scoredJobs) {
  const remaining = Array.isArray(scoredJobs) ? [...scoredJobs] : [];
  const keyFor = job => String(job?.url || '').trim()
    || `${normalizedText(job?.title)}|${normalizedText(job?.company)}|${normalizedText(job?.location)}`;
  return (Array.isArray(batches) ? batches : []).flatMap((batch, batchIndex) =>
    (Array.isArray(batch) ? batch : []).map(original => {
      const key = keyFor(original);
      const foundAt = remaining.findIndex(candidate => keyFor(candidate) === key);
      const job = foundAt >= 0 ? remaining.splice(foundAt, 1)[0] : original;
      return { batch: batchIndex + 1, job };
    }),
  );
}
