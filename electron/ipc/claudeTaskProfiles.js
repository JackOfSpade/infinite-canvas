// Model, effort and tools for each AI task outside application bundles, run by
// claudeTaskWorker.js. Aliases resolve to the newest release of each model.
// Tested 2026-11-02 on cost and quality: each is the cheapest setting where blind
// judges found no material loss against Opus xhigh, or, for the audits, where seeded
// defects were still caught. Fable and max effort are excluded.
// docs/ai-model-selection.md records the selection policy, every measured result
// and the open gaps; read it before re-testing or changing a profile here.
// A task with no tools that aiCallProviders.js routes (`task:<id>`) is answered by DeepSeek only: there is no Claude
// fallback (the owner's rule, 2026-11-15). Its profile here is what it ran on before and what a re-test compares with.
// Web tasks run on Parallel Search only, except the tasks named in BUILT_IN_WEB_TASKS: those
// offer Claude's built-in WebSearch/WebFetch instead. A Parallel limit pauses the work instead of
// falling back.
import { PARALLEL_RESEARCH_TOOLS } from './parallelSearch.js';
const WEB = PARALLEL_RESEARCH_TOOLS.join(',');
const BUILT_IN_WEB = 'WebSearch,WebFetch';
// The one exception to Parallel-only web search: measured 2026-11-14 over 16 batches, Claude's
// built-in tools chose the same posting between their own runs in 15 of 16 pairs (94%) with 0 of 32
// replies invalid, Parallel 37 of 44 (84%) with 2 of 48 invalid, and Parallel's fetch can return an
// old stored copy of a removed posting.
export const BUILT_IN_WEB_TASKS = Object.freeze(['job-official-posting-match']);
// Ultracode is off for every task (measured 2026-11-09: no quality gain, 3-5x cost
// on the research tasks where it acted). A profile records only an explicit opt-in.
export const profile = (model, effort, tools = '', options = {}) => Object.freeze({
  model, effort, tools, ...(options.ultracode === true ? { ultracode: true } : {}),
});

export const CLAUDE_TASK_PROFILES = Object.freeze({
  'job-role-screen-batch': profile('haiku', 'low'),
  // 2026-11-12: Same cost as Haiku low ($0.0056 a call) and, on 106 disputed rows judged blind, dropped fewer real jobs (28 vs 40 of 212 judgments); Sonnet medium dropped 118 (docs/ai-model-selection.md).
  'job-role-snippet-screen-batch': profile('haiku', 'medium'),
  'job-taxonomy-plan': profile('haiku', 'low'),
  // 2026-11-12: Same cost as Haiku low; matched production on every real page and caught every planted closed, open and login-wall page Sonnet medium caught (docs/ai-model-selection.md).
  'job-listing-liveness': profile('haiku', 'medium'),
  'platform-fit-assessment': profile('haiku', 'low'),
  'marketplace-hub-scan-batch': profile('haiku', 'low'),
  'career-profile-clean': profile('haiku', 'low'),
  'job-preference-interpretation': profile('haiku', 'medium'),
  // Chosen by analogy 2026-11-15, not yet tested on a real prompt (none is stored): it judges whether the same kind of
  // edit recurs across bundles and can stop generation, like the gap review and role audit, where Haiku high matched
  // the stronger settings at the same price and Haiku medium was less reliable (docs/ai-model-selection.md).
  'application-edit-recurrence': profile('haiku', 'high'),
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
  // Chosen by analogy 2026-11-15, not yet tested on a real prompt (none is stored): on every measured sibling that
  // sorts jobs (taxonomy plan, both role screens) Haiku beat Sonnet medium at about a tenth of the cost, and Haiku
  // medium was the pick where descriptions are read (docs/ai-model-selection.md).
  'job-taxonomy-classify-batch': profile('haiku', 'medium'),
  // 2026-11-09: Sonnet low agreed with Sonnet high within run-to-run noise (decision 98.0% vs 96.8%,
  // 6 batches x 2 runs) at about 15% less cost; Haiku fell 12-14 points short (docs/ai-model-selection.md).
  'job-preference-evaluation': profile('sonnet', 'low'),
  // 2026-11-12: Caught all planted softer-wording, overlooked-evidence and duplicate rows with no false alarms, the same as Sonnet high, and agreed 18/18 on real prompts, at about a tenth of the cost (docs/ai-model-selection.md).
  'job-gap-review': profile('haiku', 'high'),
  // 2026-11-10: Sonnet low matched every production outcome (40 of 40 across 2 runs of a real 20-item batch)
  // at about 30% less cost; Haiku medium and high reversed most outcomes (4 of 40) (docs/ai-model-selection.md).
  'job-preference-research-batch-assessment': profile('sonnet', 'low'),
  'job-scoring': profile('opus', 'low'),
  // 2026-11-12: Blind-judged ranges scored 9 and 8 against production's 8 and Opus low reruns' 6 and 5, all answers passed the app validator, at about half the cost (docs/ai-model-selection.md).
  'job-compensation-assessment-batch': profile('sonnet', 'low'),
  // 2026-11-10: On the real board prompt plus planted pairs (a copy with changed seniority, employment type,
  // team, required stack, level, or a separate requisition must be split; a location-only or boilerplate-only
  // copy must merge), Haiku low decided 40 of 40 correctly across 2 runs, the same as Opus low or better (Opus
  // low split one boilerplate-only copy), at about 1/20 the cost (docs/ai-model-selection.md).
  'job-location-consolidation-confirmation': profile('haiku', 'low'),
  // 2026-11-15: With Parallel Search, Haiku high found the confirmed posting as often as Opus low (27 and 28 of 30 on
  // two seeds vs 28 and 27) and named more confirmed postings in real 12-job batches (59 vs 48 over 12 replies), at about
  // a third of the batch cost; Haiku medium and low found 26 on the first seed (docs/ai-model-selection.md).
  'job-official-posting-research': profile('haiku', 'high', WEB),
  'bundle-price-synthesis': profile('opus', 'medium'),
  // 2026-11-09: Sonnet medium kept two-source salary coverage (10-11 of 12 cohorts vs 9-10 on Opus medium)
  // with about 20% fewer verified sources, at about 75% less cost; Sonnet high and Opus medium buy a few
  // sources at 3-4x the price (docs/ai-model-selection.md).
  // 2026-11-15: With Parallel Search, Sonnet low verified a source for 12 of 12 salary cohorts on two seeds (Sonnet
  // medium 9-10 and 12), matched it on experience bands (two verified hosts 10 of 12) and job location (9 of 24 correct),
  // at 15-20% less; Haiku medium verified 5 of 12 (docs/ai-model-selection.md).
  'job-compensation-research-batch': profile('sonnet', 'low', WEB),
  // 2026-11-15: With Parallel Search, Sonnet medium confirmed 171 and 175 of 180 preference checks in two runs and found
  // the same 2 conflicts as Opus medium (158 of 172 confirmed), so the same jobs are filtered, at under half the cost.
  // Sonnet low matched once and returned no usable assessment once; Haiku high confirmed 36 and found no conflict
  // (docs/ai-model-selection.md).
  'job-preference-research-batch': profile('sonnet', 'medium', WEB),
  // 2026-11-09: Haiku medium caught the same planted skill defects as Opus xhigh (16/18), was valid on
  // every real prompt, and a full compile with it converged in 2 rounds; Haiku low stalled the compile
  // with unactionable findings (docs/ai-model-selection.md).
  'career-profile-audit-skills': profile('haiku', 'medium'),
  'career-profile-compile': profile('opus', 'xhigh'),
  // Chosen by analogy 2026-11-15, not yet tested (a blank-brief search is rare): it turns the profile into search
  // titles, like preference interpretation, where Haiku medium was judged best and Sonnet medium worst at 7x the cost
  // (docs/ai-model-selection.md).
  'job-query-generation': profile('haiku', 'medium'),
  // Not tested: no product photos were available; marketplace calls are skipped by the owner's decision.
  'vision-product-analysis': profile('sonnet', 'medium'),
  // Judges the page text the app downloads for each lead; tools only for a lead with no usable page. Tested
  // 2026-11-02 on 8 real postings, A and B per setting: every setting chose the right lead and none a wrong one, so
  // the host validator decided it. Sonnet medium passed 16 of 16 at the lowest cost of the settings that matched
  // Opus xhigh (15 of 16); Haiku failed 3 to 4 of 16 and Sonnet low 1 of 16.
  // 2026-11-15: built-in web tools instead of Parallel (same posting between own runs 15 of 16 pairs vs 37 of 44; see BUILT_IN_WEB_TASKS).
  'job-official-posting-match': profile('sonnet', 'medium', BUILT_IN_WEB),
});

export const CLAUDE_TASK_IDS = Object.freeze(Object.keys(CLAUDE_TASK_PROFILES));

export function claudeTaskProfile(task) {
  return CLAUDE_TASK_PROFILES[task] || null;
}
