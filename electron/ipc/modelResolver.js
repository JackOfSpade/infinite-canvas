/**
 * Always-latest Claude model resolution (résumé design doc §8).
 *
 * `TASK_MODELS` (llm.js) used to pin literal Claude ids. Pins go stale
 * silently — the table drifted two whole generations behind
 * (claude-opus-4-8 / claude-sonnet-4-6 vs the current claude-opus-5 /
 * claude-sonnet-5, at identical or lower price) because nobody remembers to
 * manually sweep it. This module replaces the literal ids with FAMILY TOKENS
 * (CLAUDE_FAMILY.OPUS/.SONNET/.HAIKU) resolved against Anthropic's Models API
 * (`client.models.list()`, `GET /v1/models` — free, no billing) so the app
 * tracks the current generation automatically.
 *
 * Three guards, all load-bearing:
 *
 * 1. PINNED FLOOR. If the API is unreachable, or no key is set, resolution
 *    falls back to MODEL_FLOOR (claudeModels.js) without an error. A résumé
 *    must never fail to generate because model discovery failed.
 *
 * 2. RESOLVE ONCE, NOT PER CALL. Prompt caches are model-scoped — flipping
 *    the resolved id between two calls in the same run silently invalidates
 *    every cached prefix and re-bills it at full rate. The in-memory
 *    `snapshot` this module reads from is swapped ONLY inside
 *    primeClaudeModels(); claudeModelFor() is a pure, synchronous read of
 *    whatever snapshot is currently live. Callers are expected to call
 *    primeClaudeModels() once at the start of a logical run (a hub run, a
 *    generate-application invocation) and let every call within that run
 *    read the same resolved id via claudeModelFor(). `modelResolutionSnapshot
 *    ().epoch` increments on every swap so a caller/bug-report can detect a
 *    mid-run flip after the fact.
 *
 * 3. CAPABILITY GATE. A new model generation is not automatically a drop-in —
 *    Opus 4.7 removed budget_tokens/sampling params outright (400), Opus 5
 *    turned thinking on by default and made `thinking:{disabled}` a 400 above
 *    `high` effort. Gate on the `capabilities` tree the Models API returns:
 *    if a candidate explicitly reports `structured_outputs.supported: false`,
 *    skip it (every schema-forced task in aiSchemas.js depends on structured
 *    output) and fall to the next-newest. A model reporting NO capabilities
 *    tree at all is accepted at face value — the field being absent means the
 *    API doesn't report it for that model, not that the model lacks it.
 *    Every skip is logged: a silently skipped generation is indistinguishable
 *    from no new generation ever having been available.
 *
 * Fable and Mythos are excluded from auto-tracking ENTIRELY (any id
 * containing 'fable' or 'mythos'), regardless of whether it would otherwise
 * match a family token. They're a higher price tier with a different API
 * contract (thinking always on, an explicit `thinking:{disabled}` 400s, org
 * must be on 30-day retention or every request 400s) — auto-adopting one
 * would be an unrequested cost + compatibility change. Matching is on the
 * exact family tokens, never "newest Claude model".
 *
 * Version floor: a candidate is never resolved if it's older than
 * MODEL_FLOOR's own created_at — but that's only checkable when the floor id
 * itself appears in the API's list (gives us its real date); if it doesn't,
 * every family-matching candidate is eligible (nothing to compare against).
 *
 * Caching: lazyStore('model-resolution'), ~24h TTL. Fail-soft is correct here
 * precisely because MODEL_FLOOR is the backstop (lazyStore's own doc calls
 * this the "learned telemetry" case it's right for). primeClaudeModels()
 * no-ops when a fresh resolution (either the in-memory snapshot or the
 * on-disk cache) is within the TTL, unless `force: true`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getAISettings } from './settings.js';
import { lazyStore } from '../utils/lazyStore.js';
import { logger } from '../logger.js';
import { MODEL_FLOOR } from './claudeModels.js';

export const CLAUDE_FAMILY = Object.freeze({ OPUS: 'OPUS', SONNET: 'SONNET', HAIKU: 'HAIKU' });
const FAMILY_VALUES = new Set(Object.values(CLAUDE_FAMILY));

/** Is `v` one of the CLAUDE_FAMILY tokens (as opposed to a literal model id)? */
export function isClaudeFamilyToken(v) {
  return FAMILY_VALUES.has(v);
}

const store = lazyStore('model-resolution');
const CACHE_KEY = 'snapshot';
// A resolver ping is background housekeeping, not a per-request cost — once a
// day is plenty freshness for a model catalog that changes on the order of
// months, and it keeps the free-but-not-instant Models API call off the hot
// path of every hub run / application generation.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Swapped ONLY by applySnapshot() (called only from primeClaudeModels), per
// guard 2 above. `epoch` increments on every swap, including the very first
// one — callers/bug-reports can diff it to catch a resolution that changed
// mid-run.
let epochCounter = 0;
let snapshot = {
  resolved: { ...MODEL_FLOOR },
  meta: {},          // { [modelId]: { contextWindow, maxOutput } } — live API numbers
  source: 'floor',    // 'floor' | 'api'
  fetchedAt: 0,
  skipped: [],
  epoch: epochCounter,
};

function applySnapshot(next) {
  epochCounter += 1;
  snapshot = { ...next, epoch: epochCounter };
}

// Constructed directly rather than reusing claude.js's getAnthropicClient
// (which isn't exported): claude.js is about to re-export claudeModelsInUse()
// FROM this module, so importing claude.js back here would create a
// claude.js <-> modelResolver.js cycle. The client construction itself is two
// lines — duplicating that is far cheaper than the cycle.
function buildAnthropicClient(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 1 });
}

/**
 * Pure selection logic, exported for unit tests. Given a family token, the
 * raw `ModelInfo[]` the Models API returned, and that family's MODEL_FLOOR
 * id, picks the newest eligible candidate.
 *
 * Eligibility, in order:
 *   1. id contains `-{family}-` (e.g. `-opus-`) AND does not contain 'fable'
 *      or 'mythos' (excluded entirely, regardless of family match).
 *   2. Not older than the floor's created_at, when the floor id is itself
 *      present in `apiModels` (otherwise unenforceable — accept all).
 *   3. Sorted newest created_at first (ties broken by id, descending), the
 *      first candidate that doesn't explicitly report
 *      `capabilities.structured_outputs.supported === false` wins. A
 *      candidate with no `capabilities` at all is accepted (unknown, not
 *      unsupported — see module doc guard 3). Rejected candidates accumulate
 *      in `skipped` and the walk continues to the next-newest.
 *
 * Falls back to `floorId` (with whatever `skipped` accumulated) if nothing
 * survives. Never throws.
 * @returns {{ id: string, skipped: Array<{ id: string, reason: string }> }}
 */
export function pickFamilyModel(family, apiModels, floorId) {
  const list = Array.isArray(apiModels) ? apiModels : [];
  const token = `-${String(family || '').toLowerCase()}-`;
  const skipped = [];

  const familyCandidates = list.filter((m) => {
    const id = String(m?.id || '');
    if (!id.includes(token)) return false;
    const lower = id.toLowerCase();
    return !lower.includes('fable') && !lower.includes('mythos');
  });

  const floorEntry = list.find((m) => m?.id === floorId);
  const floorCreated = floorEntry ? Date.parse(floorEntry.created_at) : NaN;
  const eligible = Number.isFinite(floorCreated)
    ? familyCandidates.filter((m) => {
        const created = Date.parse(m?.created_at);
        return !Number.isFinite(created) || created >= floorCreated;
      })
    : familyCandidates;

  const sorted = [...eligible].sort((a, b) => {
    const da = Date.parse(a?.created_at) || 0;
    const db = Date.parse(b?.created_at) || 0;
    if (db !== da) return db - da;
    return String(b?.id).localeCompare(String(a?.id));
  });

  for (const m of sorted) {
    const structured = m?.capabilities?.structured_outputs;
    if (structured && structured.supported === false) {
      skipped.push({ id: m.id, reason: 'capability-gate: structured_outputs.supported=false' });
      continue;
    }
    return { id: m.id, skipped };
  }

  return { id: floorId, skipped };
}

/** Run pickFamilyModel for all three families against one Models API response. */
function resolveFromApiModels(apiModels) {
  const resolved = {};
  const meta = {};
  const skipped = [];
  for (const family of Object.values(CLAUDE_FAMILY)) {
    const { id, skipped: familySkipped } = pickFamilyModel(family, apiModels, MODEL_FLOOR[family]);
    resolved[family] = id;
    for (const s of familySkipped) skipped.push({ family, ...s });
  }
  // Live context-window/max-output metadata for EVERY model the API reported
  // (not just the three resolved ones) — this is what lets claudeModelMetaFor
  // answer for a model id the static registry has never seen (tokenWindow.js).
  for (const m of apiModels || []) {
    const contextWindow = Number(m?.max_input_tokens);
    const maxOutput = Number(m?.max_tokens);
    if (Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(maxOutput) && maxOutput > 0) {
      meta[m.id] = { contextWindow, maxOutput };
    }
  }
  return { resolved, meta, skipped };
}

async function resolveViaApi(apiKey, signal) {
  const client = buildAnthropicClient(apiKey);
  const apiModels = [];
  // PagePromise's async iterator auto-pages (walks has_more/next cursor
  // internally) — no manual cursor loop needed.
  for await (const m of client.models.list(null, signal ? { signal } : undefined)) {
    apiModels.push(m);
  }
  const { resolved, meta, skipped } = resolveFromApiModels(apiModels);
  for (const s of skipped) {
    logger.warn(`[modelResolver] Skipped '${s.id}' for ${s.family}: ${s.reason} — falling to next-newest.`);
  }
  const next = { resolved, meta, source: 'api', fetchedAt: Date.now(), skipped };
  applySnapshot(next);
  store.set(CACHE_KEY, next);
  logger.info(`[modelResolver] Resolved Claude models: OPUS=${resolved.OPUS} SONNET=${resolved.SONNET} HAIKU=${resolved.HAIKU}`);
}

// Coalesce concurrent primes (e.g. two hub runs starting at once) into one
// in-flight API call rather than firing the Models API request twice.
let primeInFlight = null;

/**
 * Resolve (or refresh) the Claude family → model-id snapshot. Never throws —
 * any failure (network, auth, malformed response) logs a warning and leaves
 * the current snapshot exactly as it was (the floor, on a first-ever prime).
 *
 * No-ops when a fresh resolution already exists (in-memory this run, or an
 * on-disk cache within CACHE_TTL_MS) unless `force: true`. Defaults to
 * `getAISettings().anthropicApiKey` when `opts.apiKey` is absent.
 * @param {{ apiKey?: string, force?: boolean, signal?: AbortSignal }} [opts]
 */
export async function primeClaudeModels(opts = {}) {
  const { apiKey: apiKeyOpt, force = false, signal } = opts || {};
  try {
    const apiKey = apiKeyOpt || getAISettings().anthropicApiKey;
    if (!apiKey) {
      // No key anywhere — resolve to the floor without an API call and
      // without an error (guard 1). Deliberately NOT cached as a durable
      // 24h-fresh result: checking for a key costs nothing, so re-check every
      // call rather than risk pinning the floor for a stale day after a key
      // is added mid-session.
      if (snapshot.source !== 'floor') {
        applySnapshot({ resolved: { ...MODEL_FLOOR }, meta: {}, source: 'floor', fetchedAt: Date.now(), skipped: [] });
      }
      return;
    }

    if (!force && snapshot.source === 'api' && Date.now() - snapshot.fetchedAt < CACHE_TTL_MS) {
      return; // already resolved this run, within TTL — don't flip mid-run (guard 2).
    }

    if (!force) {
      const cached = store.get(CACHE_KEY);
      if (cached?.source === 'api' && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        applySnapshot(cached);
        return;
      }
    }

    if (primeInFlight) { await primeInFlight; return; }
    primeInFlight = resolveViaApi(apiKey, signal);
    try { await primeInFlight; }
    finally { primeInFlight = null; }
  } catch (err) {
    logger.warn(`[modelResolver] Claude model resolution failed, staying on the current snapshot (source=${snapshot.source}): ${err?.message || err}`);
  }
}

/**
 * Sync read of the currently-resolved model id for a family. Pure — never
 * throws, never touches the network. Falls back to MODEL_FLOOR[family] if
 * nothing has been resolved yet, and to the Sonnet floor for an unrecognized
 * family token (which should never happen from llm.js's pickModel, which
 * only calls this after isClaudeFamilyToken()).
 */
export function claudeModelFor(family) {
  if (!isClaudeFamilyToken(family)) {
    logger.warn(`[modelResolver] claudeModelFor() called with an unrecognized family '${family}' — falling back to the Sonnet floor.`);
    return MODEL_FLOOR.SONNET;
  }
  return snapshot.resolved[family] || MODEL_FLOOR[family];
}

/** { OPUS, SONNET, HAIKU } → currently-resolved model ids. */
export function resolvedClaudeModels() {
  return { ...snapshot.resolved };
}

/**
 * The resolved id list, registry order opus/sonnet/haiku — replaces the old
 * literal CLAUDE_MODELS_IN_USE const (claude.js re-exports this) so the
 * per-model availability probe follows the resolver automatically.
 */
export function claudeModelsInUse() {
  return [CLAUDE_FAMILY.OPUS, CLAUDE_FAMILY.SONNET, CLAUDE_FAMILY.HAIKU].map((f) => claudeModelFor(f));
}

/**
 * Live { contextWindow, maxOutput } for a model id, straight from the last
 * Models API response — or null if that id was never in it (not yet primed,
 * primed against an unreachable API, or a model the API simply doesn't list).
 * tokenWindow.js's modelMeta() consults this FIRST, before its own static
 * registry, so a freshly-resolved generation the static table has never seen
 * still sizes correctly instead of falling through to a conservative fallback.
 */
export function claudeModelMetaFor(id) {
  if (!id) return null;
  const meta = snapshot.meta[id];
  return meta ? { ...meta } : null;
}

/** Diagnostic snapshot for bug reports: what's resolved, from where, when, and what got skipped. */
export function modelResolutionSnapshot() {
  return {
    resolved: { ...snapshot.resolved },
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    skipped: snapshot.skipped.map((s) => ({ ...s })),
    epoch: snapshot.epoch,
  };
}
