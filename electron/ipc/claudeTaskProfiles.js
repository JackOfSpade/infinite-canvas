// Model, effort and tools for each AI task outside application bundles, run by
// claudeTaskWorker.js. Aliases resolve to the newest release of each model.
// Tested 2026-11-02 on cost and quality: each is the cheapest setting where blind
// judges found no material loss against Opus xhigh, or, for the audits, where seeded
// defects were still caught. Fable and max effort are excluded.
// docs/ai-model-selection.md records the selection policy, every measured result
// and the open gaps; read it before re-testing or changing a profile here.
const WEB = 'WebSearch,WebFetch';
// Ultracode is off for every task (measured 2026-11-09: no quality gain, 3-5x cost
// on the research tasks where it acted). A profile records only an explicit opt-in.
export const profile = (model, effort, tools = '', options = {}) => Object.freeze({
  model, effort, tools, ...(options.ultracode === true ? { ultracode: true } : {}),
});

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
  // 2026-11-10: On 4 real audits x 2 runs Haiku high matched a Sonnet medium rerun on final titles, removals
  // and additions at about 1/10 the cost; Haiku low and Sonnet low removed brief-allowed Senior titles, which a
  // blind judge ruled a clear rule violation (docs/ai-model-selection.md).
  'job-role-audit': profile('haiku', 'high'),
  'job-taxonomy-classify-batch': profile('sonnet', 'medium'),
  // 2026-11-09: Sonnet low agreed with Sonnet high within run-to-run noise (decision 98.0% vs 96.8%,
  // 6 batches x 2 runs) at about 15% less cost; Haiku fell 12-14 points short (docs/ai-model-selection.md).
  'job-preference-evaluation': profile('sonnet', 'low'),
  'job-gap-review': profile('sonnet', 'high'),
  // 2026-11-10: Sonnet low matched every production outcome (40 of 40 across 2 runs of a real 20-item batch)
  // at about 30% less cost; Haiku medium and high reversed most outcomes (4 of 40) (docs/ai-model-selection.md).
  'job-preference-research-batch-assessment': profile('sonnet', 'low'),
  'job-scoring': profile('opus', 'low'),
  'job-compensation-assessment-batch': profile('opus', 'low'),
  // 2026-11-10: On the real board prompt plus planted pairs (a copy with changed seniority, employment type,
  // team, required stack, level, or a separate requisition must be split; a location-only or boilerplate-only
  // copy must merge), Haiku low decided 40 of 40 correctly across 2 runs, the same as Opus low or better (Opus
  // low split one boilerplate-only copy), at about 1/20 the cost (docs/ai-model-selection.md).
  'job-location-consolidation-confirmation': profile('haiku', 'low'),
  'job-official-posting-research': profile('opus', 'low', WEB),
  'bundle-price-synthesis': profile('opus', 'medium'),
  // 2026-11-09: Sonnet medium kept two-source salary coverage (10-11 of 12 cohorts vs 9-10 on Opus medium)
  // with about 20% fewer verified sources, at about 75% less cost; Sonnet high and Opus medium buy a few
  // sources at 3-4x the price (docs/ai-model-selection.md).
  'job-compensation-research-batch': profile('sonnet', 'medium', WEB),
  'job-preference-research-batch': profile('opus', 'medium', WEB),
  // 2026-11-09: Haiku medium caught the same planted skill defects as Opus xhigh (16/18), was valid on
  // every real prompt, and a full compile with it converged in 2 rounds; Haiku low stalled the compile
  // with unactionable findings (docs/ai-model-selection.md).
  'career-profile-audit-skills': profile('haiku', 'medium'),
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
