// Model, effort and tools for each AI task outside application bundles, run by
// claudeTaskWorker.js. Aliases resolve to the newest release of each model.
// Tested 2026-11-02 on cost and quality: each is the cheapest setting where blind
// judges found no material loss against Opus xhigh, or, for the audits, where seeded
// defects were still caught. Fable and max effort are excluded.
const WEB = 'WebSearch,WebFetch';
const profile = (model, effort, tools = '') => Object.freeze({ model, effort, tools });

export const CLAUDE_TASK_PROFILES = Object.freeze({
  'job-role-screen-batch': profile('haiku', 'low'),
  'job-taxonomy-plan': profile('haiku', 'low'),
  'job-listing-liveness': profile('haiku', 'low'),
  'platform-fit-assessment': profile('haiku', 'low'),
  'marketplace-hub-scan-batch': profile('haiku', 'low'),
  'career-profile-clean': profile('haiku', 'low'),
  'job-preference-interpretation': profile('haiku', 'medium'),
  'application-edit-recurrence': profile('haiku', 'medium'),
  'career-profile-audit-completeness': profile('haiku', 'medium'),
  'career-profile-audit-grounding': profile('haiku', 'medium'),
  'career-profile-audit-attribution': profile('haiku', 'medium'),
  'career-profile-audit-metrics': profile('haiku', 'medium'),
  'career-profile-audit-conflicts': profile('haiku', 'medium'),
  'price-synthesis-batch': profile('sonnet', 'low'),
  'career-profile-repair': profile('sonnet', 'low'),
  'job-role-audit': profile('sonnet', 'medium'),
  'job-taxonomy-classify-batch': profile('sonnet', 'medium'),
  'job-preference-evaluation': profile('sonnet', 'high'),
  'job-gap-review': profile('sonnet', 'high'),
  'job-preference-research-batch-assessment': profile('sonnet', 'high'),
  'job-scoring': profile('opus', 'low'),
  'job-compensation-assessment-batch': profile('opus', 'low'),
  'job-location-consolidation-confirmation': profile('opus', 'low'),
  'job-official-posting-research': profile('opus', 'low', WEB),
  'bundle-price-synthesis': profile('opus', 'medium'),
  'job-compensation-research-batch': profile('opus', 'medium', WEB),
  'job-preference-research-batch': profile('opus', 'medium', WEB),
  'career-profile-audit-skills': profile('opus', 'xhigh'),
  'career-profile-compile': profile('opus', 'xhigh'),
  // Not tested: a blank-brief search is rare, and no product photos were available.
  'job-query-generation': profile('sonnet', 'medium'),
  'vision-product-analysis': profile('sonnet', 'medium'),
  // Judges the page text the app downloads for each lead; tools only for a lead with no usable page. Tested
  // 2026-11-02 on 8 real postings, A and B per setting: every setting chose the right lead and none a wrong one, so
  // the host validator decided it. Sonnet medium passed 16 of 16 at the lowest cost of the settings that matched
  // Opus xhigh (15 of 16); Haiku failed 3 to 4 of 16 and Sonnet low 1 of 16.
  'job-official-posting-match': profile('sonnet', 'medium', WEB),
});

export const CLAUDE_TASK_IDS = Object.freeze(Object.keys(CLAUDE_TASK_PROFILES));

export function claudeTaskProfile(task) {
  return CLAUDE_TASK_PROFILES[task] || null;
}
