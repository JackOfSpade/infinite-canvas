// The single place naming every AI call routed off Claude. Keys are
// `application:<stage>`, `task:<worker task id>` and `qa:<interview stage>`.
// No routed call falls back to Claude (the owner's rule, 2026-11-15). DeepSeek credit exhaustion pauses the
// task worker with queued work kept; an application stage or an interview call fails with the OFFLOAD_* code
// and is retried on DeepSeek; any other DeepSeek failure is shown and retried on DeepSeek. The `claude` field
// records the setting a call ran on before it was routed (and what runs when INFINITE_CANVAS_OFFLOAD_STAGES=off).
import { APPLICATION_STAGE_PROFILES, CAREER_WRITING_DEFAULT_PROFILE, INTERVIEW_QA_STAGE_PROFILES } from './careerWritingCore.js';
import { CLAUDE_TASK_PROFILES, claudeTaskProfile } from './claudeTaskProfiles.js';

export const OFFLOAD_REASONING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max']);

const OFFLOAD_ROUTE_NAMES = Object.freeze(['deepseek-flash', 'deepseek-pro']);

/** The offload CLI's reasoning request for a level; an unknown level throws. */
export function offloadReasoning(level) {
  if (level === 'off') return { enabled: false };
  if (typeof level === 'string' && OFFLOAD_REASONING_LEVELS.includes(level)) return { enabled: true, effort: level };
  throw new Error(`Unknown offload reasoning level: ${String(level)}`);
}

const DECIDED = '2026-11-07';
const WHY = 'Unmeasured entry: name the measurement behind every routing choice.';

const applicationEntry = (stage, route = 'deepseek-flash', reasoning = 'high', why = WHY, options = {}) => Object.freeze({
  provider: 'offload',
  route,
  reasoning,
  claude: APPLICATION_STAGE_PROFILES[stage] || CAREER_WRITING_DEFAULT_PROFILE,
  decided: DECIDED,
  why,
  ...(options?.maxRejections !== undefined ? { maxRejections: options.maxRejections } : {}),
});

/** A `qa:<interview stage>` entry. `claude` is the stage's own interview profile, kept for the record: a routed interview call never falls back to it. */
const qaEntry = (stage, route = 'deepseek-flash', reasoning = 'high', why = WHY, options = {}) => Object.freeze({
  provider: 'offload',
  route,
  reasoning,
  claude: INTERVIEW_QA_STAGE_PROFILES[stage] || CAREER_WRITING_DEFAULT_PROFILE,
  decided: options?.decided || DECIDED,
  why,
});

/**
 * A `task:<id>` entry. `claude` is the task's own profile, kept for the record: a routed task never falls back to it. A `webTools`
 * option can still be attached, but the task worker no longer honors it for web
 * tasks: a web task never routes off Claude, because its research runs on Parallel
 * Search instead of Claude's built-in web tools.
 */
export const taskEntry = (task, route = 'deepseek-flash', reasoning = 'high', why = WHY, options = {}) => Object.freeze({
  provider: 'offload',
  route,
  reasoning,
  claude: claudeTaskProfile(task) || CLAUDE_TASK_PROFILES[task],
  decided: options?.decided || DECIDED,
  why,
  ...(options?.maxRejections !== undefined ? { maxRejections: options.maxRejections } : {}),
  ...(options?.webTools ? { webTools: Object.freeze({ ...options.webTools }) } : {}),
});

// Measured 2026-11-07 (docs/application-improvement-sessions.md, Hard rules):
// 1,080 replays of 36 archived prompts (Flash/Pro x reasoning off..max x 3) and
// paired live bundles on 3 postings (Claude-only, config A, config B).
// Only requirements-audit matched Claude. Kept on Claude, with the reason:
// - requirements: live 14/17 accepted vs Claude 13/13; DeepSeek trims quote edges.
//   Re-test with the edge-whitespace relink and 3 tries: replay quotes 189/189 (was 11/189),
//   but live first-try 6/12 vs Claude 5/5 (coverage cursor, complete flag, ID prefix errors).
// - requirements-adjudication: 58-78% agreement with Claude vs Claude's own 96%.
// - convert, verify-correction, fit-correction: DeepSeek corrections accepted 1 of 15
//   live, Claude's own follow-up corrections fell from 5/9 to 3/20, and config A
//   lost 2 of 6 candidates (Claude-only lost none).
// Worker tasks (task:<id>), replayed offline on board rows 2026-11-07: none matched Claude.
// job-scoring 0/36 schema-valid; preference-evaluation agreement 69-80% vs Claude's 91-97%;
// with web tools, official-posting research <=2/18 valid, match 73-76% vs 87-97%, preference
// research 56% agreement vs 74%. A web-only task does not route off Claude at all:
// its research uses Parallel Search, so the `webTools` option no longer applies.
export const AI_CALL_PROVIDERS = Object.freeze({
  'application:requirements-audit': applicationEntry('requirements-audit', 'deepseek-flash', 'off',
    'Live 14/14 accepted (Claude 9/9); replay agreement with Claude 98.4% vs Claude-Claude 99.2%; $0.001 vs $0.058 per call, p50 4.9 s vs 17.4 s. Reasoning adds cost and latency with no gain.'),
  // Measured 2026-11-15 (docs/ai-model-selection.md): Flash and Pro at reasoning off to high on the stored prompts of
  // the worker tasks never measured with DeepSeek. The gap review, role audit and location consolidation matched Claude; the role screens,
  // liveness, taxonomy plan, preference interpretation and preference-research assessment stay on Claude (see that file).
  'task:job-gap-review': taskEntry('job-gap-review', 'deepseek-flash', 'low',
    'Real prompts 18/18 rows agreeing with production (Haiku high 18/18), 4/4 valid; planted softer-wording, overlooked-evidence, duplicate and near-miss rows 8/8 caught with 0 false alarms in 18 clean rows, 8/8 valid; $0.001-0.003 vs $0.010 per call. Reasoning off missed one planted duplicate; high had one invalid answer.',
    { decided: '2026-11-15' }),
  'qa:qa-practice-order': qaEntry('qa-practice-order', 'deepseek-flash', 'low',
    'The one real 26-question prompt x 2 runs, blind-judged against its ordering rules: 9 and 9 (production Opus low 8; Flash high 9 and 8; Pro low and high 8 and 9); reasoning off repeated a question once; $0.001 vs $0.014 per call.',
    { decided: '2026-11-15' }),
  'task:job-role-audit': taskEntry('job-role-audit', 'deepseek-flash', 'low',
    'Four real audits of 2026-11-12 to 11-15 x 2 runs: 97.8% agreement with production on kept, removed and added titles (a Haiku high rerun 95.6%), 8/8 valid; on the 2026-11-10 audits the same title, removal and addition overlap as Haiku high (0.986, 0.875, 1.0); $0.0015 vs $0.0044 per call.',
    { decided: '2026-11-15' }),
  'task:job-location-consolidation-confirmation': taskEntry('job-location-consolidation-confirmation', 'deepseek-flash', 'low',
    'Planted pairs built from real listings (changed seniority, employment type, team, stack, level or requisition must split; location-only or boilerplate-only copies must merge): 40/40 decisions right across 2 runs, the same as Haiku low; reasoning off and Pro off split a boilerplate-only copy; $0.001-0.002 vs $0.004 per call.',
    { decided: '2026-11-15' }),
});

/** True when INFINITE_CANVAS_OFFLOAD_STAGES=off turns every routed call back to Claude. */
export function offloadStagesDisabled(env = process.env) {
  return env?.INFINITE_CANVAS_OFFLOAD_STAGES === 'off';
}

/** The routed call for a key, with env overrides applied; null when it stays on Claude. */
export function routedCall(key, { env = process.env, table = AI_CALL_PROVIDERS } = {}) {
  if (offloadStagesDisabled(env)) return null;
  const entry = table?.[key];
  if (!entry || entry.provider !== 'offload') return null;
  const routeEnv = env?.INFINITE_CANVAS_OFFLOAD_ROUTE;
  const reasoningEnv = env?.INFINITE_CANVAS_OFFLOAD_REASONING;
  return {
    ...entry,
    route: OFFLOAD_ROUTE_NAMES.includes(routeEnv) ? routeEnv : entry.route,
    reasoning: OFFLOAD_REASONING_LEVELS.includes(reasoningEnv) ? reasoningEnv : entry.reasoning,
  };
}

/** Application stage -> routed call, for every `application:` key. */
export function applicationStageProviders({ env = process.env, table = AI_CALL_PROVIDERS } = {}) {
  const result = {};
  for (const key of Object.keys(table || {})) {
    if (!key.startsWith('application:')) continue;
    const call = routedCall(key, { env, table });
    if (call) result[key.slice('application:'.length)] = call;
  }
  return result;
}
