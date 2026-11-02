/**
 * Leaf registry of task ids. llm.js imports nonApiAi.js, so nonApiAi.js cannot
 * import llm.js; both read the list from here instead (nonApiAi.js uses it to
 * drop durable steps saved under ids that no longer exist).
 */

/**
 * The full set of task ids this router recognizes. Every task shares the one
 * manual transport, so there is nothing to look up per task except its
 * output-size guidance (TASK_MAX_TOKENS in llm.js) — this plain set is the
 * single source of truth getKnownTaskIds exposes.
 */
export const KNOWN_TASKS = new Set([
  'vision-product-analysis',
  'price-synthesis-batch',
  'bundle-price-synthesis',
  'platform-fit-assessment',
  'marketplace-hub-scan-batch',
  'career-profile-compile',
  'career-profile-clean',
  'career-profile-audit-completeness',
  'career-profile-audit-grounding',
  'career-profile-audit-attribution',
  'career-profile-audit-metrics',
  'career-profile-audit-skills',
  'career-profile-audit-conflicts',
  'career-profile-repair',
  'job-query-generation',
  'job-scoring',
  'job-gap-review',
  'application-edit-recurrence',
  'job-taxonomy-plan',
  'job-taxonomy-classify-batch',
  'job-location-consolidation-confirmation',
  'job-listing-liveness',
  'job-official-posting-research',
  'job-official-posting-match',
  'job-compensation-research-batch',
  'job-compensation-assessment-batch',
  'job-preference-interpretation',
  'job-preference-evaluation',
  'job-preference-research-batch',
  'job-preference-research-batch-assessment',
  'job-role-audit',
  'job-role-screen-batch',
  // The fallback bucket resolveTask() lands on for an unmapped/absent task.
  // It is a real member here so that passing task:'default' explicitly is not
  // itself reported as "unmapped"; getKnownTaskIds() filters it back out
  // because it names no actual call site.
  'default',
]);

// The set of task ids the router recognizes (KNOWN_TASKS above), minus the
// 'default' fallback — callers enumerate this to report on REAL tasks, and
// 'default' is a safety net rather than something any call site asks for.
export function getKnownTaskIds() {
  return new Set([...KNOWN_TASKS].filter(task => task !== 'default'));
}
