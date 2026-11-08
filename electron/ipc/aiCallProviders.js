// The single place naming every AI call routed off Claude. Keys are
// `application:<stage>`, `task:<worker task id>` and `qa:<interview stage>`.
// The `claude` profile is the fallback used on any OFFLOAD_* error.
import { APPLICATION_STAGE_PROFILES, CAREER_WRITING_DEFAULT_PROFILE } from './careerWritingCore.js';
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

/** A `task:<id>` entry; its Claude fallback is the task's own profile. `webTools` lets a WebSearch/WebFetch task route. */
export const taskEntry = (task, route = 'deepseek-flash', reasoning = 'high', why = WHY, options = {}) => Object.freeze({
  provider: 'offload',
  route,
  reasoning,
  claude: claudeTaskProfile(task) || CLAUDE_TASK_PROFILES[task],
  decided: DECIDED,
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
// research 56% agreement vs 74%. A web-only task routes only with a `webTools` option (taskEntry).
export const AI_CALL_PROVIDERS = Object.freeze({
  'application:requirements-audit': applicationEntry('requirements-audit', 'deepseek-flash', 'off',
    'Live 14/14 accepted (Claude 9/9); replay agreement with Claude 98.4% vs Claude-Claude 99.2%; $0.001 vs $0.058 per call, p50 4.9 s vs 17.4 s. Reasoning adds cost and latency with no gain.'),
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
