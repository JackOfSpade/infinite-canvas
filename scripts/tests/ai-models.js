import { CLAUDE_FAMILY, CLAUDE_FAMILY_LADDER, GEMINI_ALL_MODEL_IDS, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL_FALLBACKS, GEMINI_TIER_LADDER, LOCAL_CHARS_PER_TOKEN, MODEL_FLOOR, POSTED_DATE_PATTERN, assert, assessPromptFit, buildCoverLetterDocument, buildResumeDocument, callGeminiTextRaw, classifyGeminiFailure, claudeModelFor, claudeModelMetaFor, contextWindowForModel, decodeTextEscapes, describeGeminiFailure, dicePostedBucket, entitledTiersFor, entitlementSnapshot, estimateTokensFromChars, extractDiceSalaryBadge, extractJobPostingBaseSalary, extractJobPostingDescription, filterJobsByAge, formatDiceBaseSalary, gatedTiers, geminiModelsInTier, getCompanyResearchContext, getGeminiDefaultThinkingConfig, getGeminiLifecycleWarning, getKnownTaskIds, isGeminiDailyQuota, isGeminiProviderAvailable, isGeminiZeroOrDailyQuota, isGeminiZeroQuota, maxOutputForModel, modelForTask, modelMeta, modelResolutionSnapshot, orderGeminiModels, parsePostedDate, parseSalaryToNumeric, pickFamilyModel, planSplits, primeClaudeModels, probeModelForTier, providerForTask, reconcileBatchScores, recordEntitlement, refreshEntitlementInBackground, resetEntitlement, resolvedClaudeModels, settleEntitlementProbes, taskModelRoutingSnapshot, toGeminiSchema, webSearchToolType } from '../test-dependencies.js';

export default [
{
    name: 'application generation: Gemini schema adapter preserves honest empty values without invalid enums',
    run: () => {
      const source = {
        type: 'object',
        properties: {
          unit: { type: 'string', enum: ['USD', '%', ''] },
          direction: { type: 'string', enum: ['increase', 'decrease'] },
          unconstrained: { type: 'string', enum: [] },
        },
      };
      const gemini = toGeminiSchema(source);
      assert(!('enum' in gemini.properties.unit),
        'Gemini must not receive an enum containing its invalid empty-string value');
      assert(JSON.stringify(gemini.properties.direction.enum) === JSON.stringify(['increase', 'decrease']),
        'valid Gemini enums must remain structured-output constraints');
      assert(!('enum' in gemini.properties.unconstrained),
        'an empty enum must not be sent as an invalid response schema');
      assert(JSON.stringify(source.properties.unit.enum) === JSON.stringify(['USD', '%', '']),
        'the provider adapter must not mutate the cross-provider source schema');
      return { preservedValidEnum: true };
    },
  },
{
    name: 'application generation: research quota failure degrades to scraped-job-only context',
    run: async () => {
      const quotaError = new Error('All Gemini models failed. 8 model(s) exhausted their daily quota.');
      const fallback = await getCompanyResearchContext(
        { company: 'Acme', title: 'Engineer' },
        null,
        async () => { throw quotaError; },
      );
      assert(fallback.available === false, 'a research quota failure must be non-fatal and marked unavailable');
      assert(fallback.error.includes('daily quota'), 'the diagnostic should retain the provider failure reason');
      assert(fallback.text.includes('Do not invent or imply company facts'),
        'the fallback context must explicitly prevent fabricated company research');
      let abortPassedThrough = false;
      try {
        await getCompanyResearchContext({}, null, async () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        });
      } catch (error) {
        abortPassedThrough = error?.name === 'AbortError';
      }
      assert(abortPassedThrough, 'a user cancellation must not be converted into a no-research generation');
      return { degradedSafely: true };
    },
  },
{
    name: 'Gemini registry: supports every compatible current model with safe routing metadata',
    run: () => {
      // 10 ungated ids: Flash, upgrade aliases, Lite, and the two final Gemma
      // rescue models. Pro remains gated by a credential-specific probe.
      assert(GEMINI_MODEL_FALLBACKS.length === 10, `expected 10 ungated Gemini fallback models, got ${GEMINI_MODEL_FALLBACKS.length}`);
      for (const model of [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3-flash-preview',
        'gemini-flash-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemini-flash-lite-latest',
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it',
      ]) {
        assert(GEMINI_MODEL_FALLBACKS.includes(model), `compatible model missing from registry: ${model}`);
      }
      assert(!GEMINI_MODEL_FALLBACKS.some(model => /image|tts|live|embedding|robotics/i.test(model)),
        'special-purpose models must not enter the universal generateContent fallback chain');
      // Pro is gated on a PROVEN entitlement, not permanently banned — an
      // unentitled credential 429s ("limit: 0") on every Pro call, so it must
      // stay out of the ungated chain every caller relies on by default.
      // orderGeminiModels' opts.entitledTiers is what re-admits it once a live
      // probe proves the credential can actually call it (geminiEntitlement.js);
      // this assertion guards the DEFAULT (no entitledTiers) chain only.
      assert(!GEMINI_MODEL_FALLBACKS.some(model => /\bpro\b/i.test(model)),
        'entitlement-gated Pro models must stay out of the ungated fallback chain until a probe proves the credential can call them');

      for (const model of GEMINI_ALL_MODEL_IDS) {
        const thinking = getGeminiDefaultThinkingConfig(model);
        if (/^gemma-/i.test(model)) {
          assert(thinking.thinkingLevel === 'minimal', `${model} keeps minimal thinking for its TPM-limited rescue role`);
        } else {
          assert(thinking.thinkingLevel === 'high', `${model} uses high thinking`);
        }
      }
      assert(getGeminiDefaultThinkingConfig('gemini-3.99-future').thinkingLevel === 'high',
        'an unlisted Gemini fallback retains high thinking');
      assert(GEMINI_MAX_OUTPUT_TOKENS === 16384, 'high thinking has the shared 16,384-token output floor');

      const preferredFlash = orderGeminiModels('gemini-3.7-flash');
      assert(preferredFlash[0] === 'gemini-3.7-flash' && preferredFlash[1] === 'gemini-3.6-flash',
        'quality tasks start with the current Flash generation and retain 3.6 as their immediate fallback');
      const preferredLite = orderGeminiModels('gemini-3.5-flash-lite');
      assert(preferredLite[0] === 'gemini-3.7-flash' && preferredLite[1] === 'gemini-3.6-flash',
        'the portable cascade stays global rather than varying per task preference');
      const now = Date.now();
      const deferred = orderGeminiModels('gemini-3.7-flash', new Map([['gemini-3.7-flash', now + 1000]]), now);
      assert(deferred[0] === 'gemini-3.6-flash' && deferred.at(-1) === 'gemini-3.7-flash',
        'known-suppressed preferred model moves to the tail without being removed');
      return { models: GEMINI_MODEL_FALLBACKS.length };
    },
  },
{
    name: 'Gemini cascade: quota exhaustion stops after direct structured-capable models',
    run: async () => {
      const originalFetch = globalThis.fetch;
      let directCalls = 0;
      let interactionsCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.endsWith('/v1beta/interactions')) {
          interactionsCalls++;
          throw new Error('Antigravity must not be used by the Gemini cascade.');
        }
        if (target.includes(':generateContent')) {
          directCalls++;
          return new Response(JSON.stringify({
            error: { code: 429, message: 'Quota exceeded for generate_requests_per_model_per_day, limit: 20' },
          }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`Unexpected Gemini cascade test URL: ${target}`);
      };
      try {
        let failure = null;
        try {
          await callGeminiTextRaw('Keep structured-output guarantees.', 'cascade-direct-only-test-key', 'gemini-3.7-flash', null, { maxOutputTokens: 128 });
        } catch (err) {
          failure = err;
        }
        assert(/All Gemini models failed/.test(failure?.message || ''),
          'exhausted direct models surface their aggregate failure instead of switching transports');
        assert(directCalls >= GEMINI_MODEL_FALLBACKS.length,
          'every eligible direct Gemini model is tried before the aggregate failure');
        assert(interactionsCalls === 0,
          'the Gemini cascade never calls the schema-incompatible Interactions/Antigravity endpoint');
      } finally {
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { directCalls, interactionsCalls };
    },
  },
{
    name: 'Gemini registry: lifecycle and live-failure warnings stay distinct',
    run: () => {
      const now = Date.parse('2026-08-14T00:00:00Z');
      assert(getGeminiLifecycleWarning('gemini-3.1-flash-lite', now) === null,
        'the active Lite endpoint has no invented shutdown warning');
      assert(getGeminiLifecycleWarning('gemini-flash-latest', now) === null
        && getGeminiLifecycleWarning('gemini-flash-lite-latest', now) === null,
      'upgrade aliases carry no fabricated lifecycle warning');
      assert(getGeminiLifecycleWarning('gemini-3.7-flash', now) === null,
        'models without an announced shutdown do not get fabricated lifecycle warnings');

      assert(classifyGeminiFailure(404, 'model not found') === 'unavailable', '404 model endpoint is unavailable');
      assert(classifyGeminiFailure(429, 'quota limit: 0') === 'no-quota', 'quota-zero is distinct from consumed quota');
      assert(classifyGeminiFailure(429, 'quota exceeded [{"quotaValue":"0"}]') === 'no-quota',
        'structured quotaValue zero classifies as no-quota');
      assert(classifyGeminiFailure(429, 'GenerateRequestsPerDayPerProjectPerModel quota exceeded') === 'daily-quota',
        'daily quota exhaustion is distinct from a short burst rate limit');
      assert(classifyGeminiFailure(429, 'Please retry in 24.15s') === 'rate-limit',
        'a retryable burst limit remains a short rate-limit');
      // A 429 that mentions "per API key" must NOT be misread as a credential failure.
      assert(classifyGeminiFailure(429, 'Quota exceeded per API key for this project') === 'rate-limit',
        'a quota message that mentions "API key" is still rate-limit, not auth');
      // Finding 1: a bare per-model 403 must NOT abort the chain (it is model-access,
      // not credential auth) so a denied model still falls through to the next fallback.
      assert(classifyGeminiFailure(403, 'permission denied') === 'model-access',
        'a per-model 403 is model-access (cascade), not chain-aborting auth');
      assert(classifyGeminiFailure(403, 'Permission denied on resource model gemini-3.5-flash') === 'model-access',
        'PERMISSION_DENIED on a specific model is model-access');
      // ...but a CREDENTIAL/project-level 403 IS auth (every model fails identically).
      assert(classifyGeminiFailure(403, 'API key not valid. Please pass a valid API key.') === 'auth',
        'a 403 about the API key itself is credential auth');
      assert(classifyGeminiFailure(403, 'Generative Language API has not been used in project 123 before or it is disabled') === 'auth',
        'a project-level "API not enabled" 403 is credential auth');
      assert(classifyGeminiFailure(401, 'unauthorized') === 'auth', '401 is always credential auth');
      assert(classifyGeminiFailure(null, 'invalid api key') === 'auth', 'a message-only bad-key failure is auth');
      assert(classifyGeminiFailure(503, 'overloaded') === 'server', 'provider overload is server failure');
      assert(classifyGeminiFailure(null, 'AI response was truncated') === 'truncation', 'output-cap failure is truncation');
      assert(classifyGeminiFailure(400, 'invalid thinkingConfig.thinkingLevel value') === 'thinking-config',
        'a per-model thinking configuration rejection is suppressed and falls through');
      assert(isGeminiProviderAvailable([{ ok: false }, { ok: true }]), 'one working model makes Gemini usable');
      assert(!isGeminiProviderAvailable([{ ok: false }, { ok: false }]), 'no working model makes Gemini unavailable');

      // Finding 3: zero / per-day quota detection. The decisive quotaValue:"0"
      // signal only appears in the STRUCTURED details we now preserve on the error,
      // not in the flat 429 message — so a Pro model with no free-tier quota is
      // deferred on the long timer instead of being re-hammered every 30s.
      assert(isGeminiZeroOrDailyQuota('You exceeded your quota. [{"@type":"...QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"0"}]}]') === true,
        'structured quotaValue:"0" in appended details is detected as a zero quota');
      assert(isGeminiZeroQuota('quota limit: 0') === true && isGeminiDailyQuota('quota limit: 0') === false,
        'zero entitlement is not mislabeled as daily exhaustion');
      assert(isGeminiZeroOrDailyQuota('quota exceeded: requests per day') === true, 'a per-day quota is a long-window quota');
      assert(isGeminiZeroOrDailyQuota('GenerateRequestsPerDayPerProjectPerModel') === true, 'camelCase PerDay quotaId is detected');
      assert(isGeminiZeroOrDailyQuota('Please retry in 24.15s') === false, 'a transient burst retry hint is NOT a zero/daily quota');
      assert(isGeminiZeroOrDailyQuota('rate limit exceeded, retry in 5s') === false, 'a generic per-minute rate limit is not long-window');
      assert(describeGeminiFailure('no-quota', 'generic provider prelude').includes('0 / 0'),
        'no-quota diagnostic explains the dashboard 0 / 0 state');
      return { ok: true };
    },
  },
{
    name: 'Gemini registry: shared Flash -> Pro -> aliases -> Lite -> Gemma cascade is capability-gated',
    run: () => {
      assert(GEMINI_TIER_LADDER.join(',') === 'flash,pro,flash-alias,lite,lite-alias,gemma', 'the portable cascade order is stable');
      assert(GEMINI_ALL_MODEL_IDS.includes('gemini-3.1-pro-preview'), 'GEMINI_ALL_MODEL_IDS includes gated ids too (metadata lookups need Pro\'s token window)');
      assert(geminiModelsInTier('pro').length === 3, 'the source configuration contributes all three gated Pro endpoints');
      assert(geminiModelsInTier('flash').length === 4 && geminiModelsInTier('lite').length === 2,
        'pinned Flash/Lite endpoints are kept ahead of their aliases');

      const now = Date.now();
      // Default (no entitledTiers) — Pro must NEVER appear. An unentitled Pro
      // 429s ("limit: 0") on every single call, so silently trying it would
      // burn a guaranteed-wasted round-trip on every LLM call forever.
      const ungated = orderGeminiModels('gemini-3.7-flash', new Map(), now);
      assert(!ungated.includes('gemini-3.1-pro-preview'), 'no entitledTiers -> Pro never enters the chain');

      // Entitled: Pro joins after the Flash pool, matching the portable source
      // ordering and avoiding an otherwise wasted free-tier hop.
      const entitledSet = orderGeminiModels('gemini-3.7-flash', new Map(), now, { entitledTiers: new Set(['pro']) });
      assert(entitledSet[0] === 'gemini-3.7-flash', `Flash heads the shared chain (got ${entitledSet[0]})`);
      assert(entitledSet.indexOf('gemini-3.1-pro-preview') > entitledSet.indexOf('gemini-3-flash-preview'),
        'entitled Pro follows the pinned Flash models');

      // opts.entitledTiers is documented as Set|Array — both must behave identically.
      const entitledArray = orderGeminiModels('gemini-3.7-flash', new Map(), now, { entitledTiers: ['pro'] });
      assert(entitledArray.includes('gemini-3.1-pro-preview'), 'entitledTiers accepts a plain Array, not only a Set');

      // The source cascade is task-independent once a model is entitled.
      const litePreferredEntitled = orderGeminiModels('gemini-3.5-flash-lite', new Map(), now, { entitledTiers: new Set(['pro']) });
      assert(litePreferredEntitled.includes('gemini-3.1-pro-preview'),
        'a Lite-preferred task receives every entitled independent quota pool too');

      const structured = orderGeminiModels('gemini-3.7-flash', new Map(), now, { responseSchema: true });
      assert(!structured.some((id) => /^gemma-/i.test(id)),
        'Gemma is excluded from schema-constrained workflows');

      // A stale/removed id lingering in TASK_MODELS must be DROPPED, not
      // hoisted to the front as a guaranteed-404 first attempt.
      const retired = orderGeminiModels('gemini-retired-9', new Map(), now);
      assert(!retired.includes('gemini-retired-9'), 'an unregistered preferred model is dropped, not hoisted to the front');
      assert(retired.length > 0, 'the chain is still non-empty after dropping an unrecognized preferred model');

      // The per-tier hoist-to-front logic must never emit a duplicate id.
      for (const chain of [ungated, entitledSet, entitledArray, litePreferredEntitled, structured, retired]) {
        assert(new Set(chain).size === chain.length, `orderGeminiModels chain has no duplicate ids (got ${chain.join(',')})`);
      }
      return { ok: true };
    },
  },
{
    name: 'geminiEntitlement: scoped cache with asymmetric TTLs, fails closed on a throwing probe',
    run: async () => {
      // lazyStore falls back to no persisted state under the plain-node test
      // runner, so cached verdicts live only in the module's in-memory memo —
      // resetEntitlement() normalizes that memo so this test doesn't depend on
      // run order (a prior test's recordEntitlement call would otherwise leak in).
      resetEntitlement();
      assert(gatedTiers().length === 1 && gatedTiers()[0] === 'pro', `pro is the only gated tier (got ${gatedTiers().join(',')})`);
      assert(probeModelForTier('pro') === 'gemini-3.1-pro-preview', 'pro is probed with its own (most capable) entry');

      const scopeA = 'test-scope-A';
      const scopeB = 'test-scope-B';
      recordEntitlement(scopeA, 'pro', false, 'HTTP 429 limit:0');
      assert(entitledTiersFor(scopeA).size === 0, 'a denied verdict grants nothing');

      recordEntitlement(scopeA, 'pro', true, 'HTTP 200');
      assert(entitledTiersFor(scopeA).has('pro'), 'a granted verdict is readable back for the same scope');
      // Scoping: granting on scope A must not leak into scope B — swapping in a
      // billing-enabled key must not silently entitle every OTHER credential.
      assert(entitledTiersFor(scopeB).size === 0, 'entitlement is scoped per credential, not global');

      // Staleness: a granted entry expires after its 24h TTL — a lapsed billing
      // card must degrade back to Flash within a day, not 429 for a week.
      const farFuture = Date.now() + 25 * 60 * 60 * 1000;
      assert(entitledTiersFor(scopeA, farFuture).size === 0, 'a granted verdict older than its 24h TTL is no longer returned');
      // A backwards system clock must not extend a positive entitlement past
      // its TTL. Fail closed and let the background probe establish a current
      // result instead of moving a formerly-valid Pro entry back to the head
      // of the chain indefinitely after the clock is corrected.
      const recordedAt = Date.now();
      recordEntitlement(scopeA, 'pro', true, 'HTTP 200', recordedAt);
      assert(entitledTiersFor(scopeA, recordedAt - 1).size === 0,
        'a granted verdict from the apparent future is stale (backwards clock fails closed)');

      // Background refresh: a successful probe grants the tier once settled.
      resetEntitlement();
      const scopeC = 'test-scope-C';
      refreshEntitlementInBackground(scopeC, async () => ({ ok: true, status: 200 }));
      await settleEntitlementProbes();
      assert(entitledTiersFor(scopeC).has('pro'), 'a successful background probe grants the tier after settling');

      // Fail-closed: a probe that THROWS (a local/network fault, not evidence
      // about the credential) must NOT cache a denial — the next call should get
      // a fresh chance instead of sitting on a week-long "denied" (DENIED_TTL_MS).
      resetEntitlement();
      const scopeD = 'test-scope-D';
      // This must be a *synchronous* throw, not an `async` rejection. An async
      // IIFE used to run its finally before it had inserted its promise into
      // inFlight, leaving a resolved stale entry that blocked all later probes.
      let syncProbeCalls = 0;
      refreshEntitlementInBackground(scopeD, () => {
        syncProbeCalls += 1;
        throw new Error('network blip');
      });
      await settleEntitlementProbes();
      assert(!entitledTiersFor(scopeD).has('pro'), 'a throwing probe leaves the tier ungated');
      assert(entitlementSnapshot(scopeD)[0].known === false, 'a throwing probe caches NO verdict at all (known stays false, not "known and denied")');
      // ...and a LATER successful probe can still grant it — proof the throw
      // didn't poison the scope with a cached denial OR leave its in-flight
      // marker stuck after a synchronous exception.
      refreshEntitlementInBackground(scopeD, () => {
        syncProbeCalls += 1;
        return { ok: true, status: 200 };
      });
      await settleEntitlementProbes();
      assert(syncProbeCalls === 2, 'a synchronous throwing probe does not leave the in-flight marker stuck');
      assert(entitledTiersFor(scopeD).has('pro'), 'a later successful probe still grants after an earlier throw');

      const snap = entitlementSnapshot(scopeD)[0];
      assert(snap.tier === 'pro' && snap.model === 'gemini-3.1-pro-preview' && snap.allowed === true && snap.known === true,
        `entitlementSnapshot reports a sensible {tier,model,allowed,known} (got ${JSON.stringify(snap)})`);

      resetEntitlement();
      return { ok: true };
    },
  },
{
    name: 'llm: providerForTask purely follows Settings — the old application-generation Claude pin is gone',
    run: () => {
      // Fake settings objects, NOT the real store — providerForTask takes an
      // explicit 2nd arg precisely so callers (and tests) can probe routing
      // without mutating global settings.
      const geminiSettings = { provider: 'gemini', anthropicApiKey: 'x' };
      const claudeSettings = { provider: 'claude', anthropicApiKey: 'x' };

      // Jack reversed the earlier "application-generation always runs on
      // Claude" decision — EVERY known task (including the former pin set)
      // must now follow the user's Settings provider with no exceptions.
      for (const task of [...getKnownTaskIds(), 'default']) {
        assert(providerForTask(task, geminiSettings) === 'gemini', `'${task}' follows the Gemini Settings pick (no more Claude pin)`);
        assert(providerForTask(task, claudeSettings) === 'claude', `'${task}' follows the Claude Settings pick`);
      }
      const geminiQualityTasks = [
        'vision-product-analysis', 'price-synthesis', 'bundle-price-synthesis',
        'resume-parse', 'career-file-extract', 'job-query-generation',
        'job-scoring', 'job-bucketing', 'company-research',
        'application-resume', 'application-cover-letter', 'application-skill-opportunity',
        'career-achievement-mining', 'default',
      ];
      for (const task of geminiQualityTasks) {
        assert(modelForTask(task, geminiSettings) === 'gemini-3.7-flash',
          `'${task}' uses Gemini 3.7 Flash as its quality-tier primary`);
      }
      for (const task of ['platform-fit-assessment', 'page-status-classify', 'marketplace-hub-scan', 'text-polish']) {
        assert(modelForTask(task, geminiSettings) === 'gemini-3.5-flash-lite',
          `'${task}' remains on the deliberate lightweight Gemini tier`);
      }
      assert(modelForTask('career-achievement-refute', geminiSettings) === 'gemini-3.5-flash',
        'the Gemini achievement refuter remains independent from the 3.7 miner');
      // Callers that pass an explicit malformed/missing settings snapshot must
      // fail safely to the default provider instead of crashing on
      // `settings.provider` while handling a real task.
      assert(providerForTask('application-resume', null) === 'gemini', 'an explicit null settings snapshot safely falls back to Gemini');
      assert(modelForTask('application-resume', null) === 'gemini-3.7-flash', 'model routing remains usable with an explicit null settings snapshot');
      return { ok: true };
    },
  },
{
    name: 'llm: default claudeModels settings reproduce the OLD hard-coded TASK_MODELS table exactly',
    run: () => {
      // The safety net for the whole task-group refactor: an install with no
      // `claudeModels` configured (settings.js backfills GROUP_DEFAULT_FAMILY)
      // must resolve every task to the exact same model the old literal
      // per-task Claude column did — generation=OPUS, analysis=SONNET,
      // light=HAIKU, with company-research/career-achievement-refute one
      // step below generation (i.e. SONNET, same as before).
      const settings = { provider: 'claude', anthropicApiKey: 'x' }; // no claudeModels key — defaults apply
      const { OPUS, SONNET, HAIKU } = MODEL_FLOOR;
      const expected = {
        'application-resume':        OPUS,
        'application-cover-letter':  OPUS,
        'application-skill-opportunity': OPUS,
        'career-achievement-mining': OPUS,
        'career-achievement-refute': SONNET, // generation stepped down 1 (independence — load-bearing)
        'company-research':          SONNET, // generation stepped down 1 (feeds generation, isn't the artifact)
        'vision-product-analysis':   SONNET,
        'price-synthesis':           SONNET,
        'bundle-price-synthesis':    SONNET,
        'resume-parse':              SONNET,
        'career-file-extract':       SONNET,
        'job-query-generation':      SONNET,
        'job-scoring':               SONNET,
        'job-bucketing':             SONNET,
        'default':                   SONNET,
        'platform-fit-assessment':   HAIKU,
        'page-status-classify':      HAIKU,
        'marketplace-hub-scan':      HAIKU,
        'text-polish':               HAIKU,
      };
      for (const [task, expectedModel] of Object.entries(expected)) {
        const got = modelForTask(task, settings);
        assert(got === expectedModel, `default claudeModels: '${task}' should resolve to ${expectedModel} (the old TASK_MODELS value), got ${got}`);
      }
      // Every known task (+ the 'default' fallback) is covered above — a task
      // added to TASK_GROUPS without a row here would silently go unverified.
      assert(new Set([...getKnownTaskIds(), 'default']).size === Object.keys(expected).length,
        'the expectation table above covers every known task, including the default fallback');
      return { ok: true };
    },
  },
{
    name: 'llm: career-achievement-refute independence survives a non-default generation family, clamps at the ladder floor',
    run: () => {
      // The refuter deliberately runs a DIFFERENT model from the miner — an
      // adversarial check re-run on the SAME model tends to just re-confirm its
      // own reasoning, which would silently turn "independent verification"
      // into self-confirmation. This must hold for ANY family the user picks
      // for Generation, not just the OPUS default.
      const fableGen = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { generation: 'FABLE', analysis: 'SONNET', light: 'HAIKU' } };
      const minerModel = modelForTask('career-achievement-mining', fableGen);
      const refuterModel = modelForTask('career-achievement-refute', fableGen);
      assert(minerModel !== refuterModel, `miner (Fable) and refuter (one step down) must resolve to different models (both got ${minerModel})`);
      assert(refuterModel === MODEL_FLOOR.OPUS, `refuter one step below FABLE on the ladder should be OPUS (got ${refuterModel})`);

      // Clamp: Generation set to the BOTTOM of the ladder (Haiku) leaves the
      // step-1 refuter with nowhere lower to go — it must clamp at Haiku
      // (same as the miner) rather than throw or wrap around the ladder.
      // This is the documented "independence silently lost" case; it must
      // not crash, just land flat.
      const haikuGen = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { generation: 'HAIKU', analysis: 'SONNET', light: 'HAIKU' } };
      const clampedMiner = modelForTask('career-achievement-mining', haikuGen);
      const clampedRefuter = modelForTask('career-achievement-refute', haikuGen);
      assert(clampedMiner === MODEL_FLOOR.HAIKU && clampedRefuter === MODEL_FLOOR.HAIKU,
        `generation=HAIKU clamps the step-1 refuter at HAIKU too (got miner=${clampedMiner}, refuter=${clampedRefuter})`);
      return { ok: true };
    },
  },
{
    name: 'llm: an unrecognized/missing claudeModels family token falls back to the group default, never throws',
    run: () => {
      // Defensive re-validation inside llm.js itself (belt-and-suspenders on
      // top of settings.js's own normalizeClaudeModels()) — llm.js is
      // reachable with a hand-built settings object that never went through
      // that layer (tests, or a future caller).
      const badToken = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { generation: 'MYTHOS', analysis: 'nope', light: null } };
      assert(modelForTask('application-resume', badToken) === MODEL_FLOOR.OPUS, 'an unrecognized generation token falls back to OPUS (the group default)');
      assert(modelForTask('job-scoring', badToken) === MODEL_FLOOR.SONNET, 'an unrecognized analysis token falls back to SONNET (the group default)');
      assert(modelForTask('text-polish', badToken) === MODEL_FLOOR.HAIKU, 'a null light token falls back to HAIKU (the group default)');

      const noClaudeModelsAtAll = { provider: 'claude', anthropicApiKey: 'x' };
      assert(modelForTask('application-resume', noClaudeModelsAtAll) === MODEL_FLOOR.OPUS, 'a settings object with no claudeModels key at all still resolves via the group default');
      return { ok: true };
    },
  },
{
    name: 'llm: a non-default claudeModels family choice for one group actually moves that group\'s resolved model, and only that group',
    run: () => {
      // The whole point of the group/step refactor is that the FAMILY is a
      // per-group Settings choice, not a hard-code — prove picking a
      // non-default family actually changes the resolved model id, not just
      // that the plumbing accepts the value without erroring. Only
      // `generation` is set below; analysis/light are left unset so they
      // fall through to their own defaults, which also proves the choice is
      // scoped to the group it names rather than a global override.
      const sonnetGen = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { generation: 'SONNET' } };
      assert(modelForTask('application-resume', sonnetGen) === MODEL_FLOOR.SONNET, 'generation=SONNET moves application-resume off its OPUS default to the Sonnet floor');
      assert(modelForTask('application-cover-letter', sonnetGen) === MODEL_FLOOR.SONNET, 'generation=SONNET moves application-cover-letter too');
      assert(modelForTask('career-achievement-mining', sonnetGen) === MODEL_FLOOR.SONNET, 'generation=SONNET moves career-achievement-mining too');
      // Unrelated groups, left unset, resolve via THEIR OWN defaults — the
      // pick above is scoped to `generation`, not applied everywhere.
      assert(modelForTask('job-scoring', sonnetGen) === MODEL_FLOOR.SONNET, 'job-scoring (analysis, unset) still resolves via its own default (which happens to also be Sonnet)');
      assert(modelForTask('text-polish', sonnetGen) === MODEL_FLOOR.HAIKU, 'text-polish (light, unset) is untouched by the generation change');

      const haikuAnalysis = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { analysis: 'HAIKU' } };
      assert(modelForTask('application-resume', haikuAnalysis) === MODEL_FLOOR.OPUS, 'generation (unset) is untouched by an analysis-only change');
      assert(modelForTask('job-scoring', haikuAnalysis) === MODEL_FLOOR.HAIKU, 'analysis=HAIKU moves job-scoring off its SONNET default');
      return { ok: true };
    },
  },
{
    name: 'llm: career-achievement-mining vs -refute independence holds for EVERY generation family, except the ladder floor',
    run: () => {
      // Load-bearing invariant (TASK_GROUPS doc, llm.js): the refuter must
      // resolve to a DIFFERENT model from the miner for any Settings pick, or
      // the "independent verification" the step exists for silently
      // degenerates into self-confirmation. Walk the WHOLE ladder — not just
      // a couple of hand-picked samples — so a future ladder change (a family
      // inserted, removed, or reordered) is caught here instead of discovered
      // live. At the ladder floor there is nowhere lower to step, so that one
      // entry is the sole documented exception: assert the boundary
      // explicitly rather than skip it.
      const floorFamily = CLAUDE_FAMILY_LADDER[CLAUDE_FAMILY_LADDER.length - 1];
      for (const family of CLAUDE_FAMILY_LADDER) {
        const settings = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { generation: family } };
        const miner = modelForTask('career-achievement-mining', settings);
        const refuter = modelForTask('career-achievement-refute', settings);
        if (family === floorFamily) {
          assert(miner === refuter, `at the ladder floor (${family}) the refuter has nowhere lower to step, so it lands on the SAME model as the miner (got miner=${miner}, refuter=${refuter})`);
        } else {
          assert(miner !== refuter, `generation=${family}: miner and refuter must resolve to DIFFERENT models for independence (both got ${miner})`);
        }
      }
      return { ok: true };
    },
  },
{
    name: 'llm: taskModelRoutingSnapshot returns a complete {provider, groups, tasks} diagnostic, one row per known task',
    run: () => {
      // Replaces the old providerPinnedTasks/applicationGenerationBlocked
      // bug-report fields (which described a pin that no longer exists) — a
      // task missing from this snapshot would be invisible to a "why did
      // this task use a weaker/stronger model than I picked" bug report.
      const settings = { provider: 'claude', anthropicApiKey: 'x' }; // defaults apply
      const snap = taskModelRoutingSnapshot(settings);
      assert(snap.provider === 'claude', 'snapshot.provider reflects the Settings provider');
      assert(Object.keys(snap.groups).sort().join(',') === 'analysis,generation,light', 'snapshot.groups covers exactly the three task groups');
      assert(snap.groups.generation.family === 'OPUS' && snap.groups.generation.model === MODEL_FLOOR.OPUS, 'generation group summary resolves to its default family + model');
      assert(snap.groups.analysis.family === 'SONNET' && snap.groups.light.family === 'HAIKU', 'analysis/light group summaries resolve to their own defaults');

      const known = getKnownTaskIds();
      assert(known.size > 0, 'sanity: getKnownTaskIds is non-empty');
      for (const task of known) {
        assert(snap.tasks[task], `taskModelRoutingSnapshot is missing a row for known task '${task}'`);
        assert(snap.tasks[task].provider === 'claude', `'${task}' row reports the active provider`);
        assert(typeof snap.tasks[task].model === 'string' && snap.tasks[task].model.length > 0, `'${task}' row carries a real model id, not undefined/empty`);
      }
      // Step-offset detail is visible per-task, not just inferable from the
      // group summary — the whole reason the per-task half of this
      // diagnostic exists alongside the per-group half.
      assert(snap.tasks['career-achievement-refute'].step === 1, 'career-achievement-refute row reports its step offset');
      assert(snap.tasks['career-achievement-refute'].model === MODEL_FLOOR.SONNET, 'career-achievement-refute resolves one step below generation (SONNET) by default');

      // provider is task-independent (providerForTask doc) — every row
      // shares the one provider even under a Gemini settings object.
      const geminiSnap = taskModelRoutingSnapshot({ provider: 'gemini', anthropicApiKey: 'x' });
      assert(geminiSnap.provider === 'gemini', 'snapshot.provider follows Settings for Gemini too');
      for (const task of known) {
        assert(geminiSnap.tasks[task].provider === 'gemini', `'${task}' row follows the Gemini provider — no per-task pin survives`);
      }
      return { ok: true };
    },
  },
{
    name: 'modelResolver: pickFamilyModel always resolves to the latest OPUS, never a Fable/Mythos upsell',
    run: () => {
      // Shape verified live against Anthropic's Models API (2026-08-12): id,
      // created_at, max_input_tokens, max_tokens, capabilities.structured_outputs.supported.
      const today = [
        { id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } },
        { id: 'claude-sonnet-5', created_at: '2026-05-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 64000, capabilities: { structured_outputs: { supported: true } } },
        { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000, capabilities: { structured_outputs: { supported: true } } },
      ];
      assert(pickFamilyModel('OPUS', today, 'claude-opus-5').id === 'claude-opus-5', 'resolves to the current floor on today\'s real catalog');

      // A newer Opus generation ships — must be adopted automatically. This is
      // the regression this whole resolver exists to prevent: TASK_MODELS used
      // to pin a literal id and silently drift two generations stale.
      const withOpus6 = [...today, { id: 'claude-opus-6', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } }];
      assert(pickFamilyModel('OPUS', withOpus6, 'claude-opus-5').id === 'claude-opus-6', 'a newer Opus generation is adopted automatically');

      // A newer AND pricier Fable/Mythos entry must NEVER win, even though it
      // postdates every real Opus candidate — the explicit user requirement is
      // "auto-use the latest OPUS", not "auto-use the latest model of any kind".
      const withUpsells = [...withOpus6,
        { id: 'claude-fable-6', created_at: '2026-10-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } },
        { id: 'claude-mythos-6', created_at: '2026-11-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } },
      ];
      const upsellResult = pickFamilyModel('OPUS', withUpsells, 'claude-opus-5');
      assert(upsellResult.id === 'claude-opus-6', `Fable/Mythos must never win over Opus regardless of recency (got ${upsellResult.id})`);

      // A capability-gated newer candidate is skipped in favour of the
      // next-newest AND surfaces in \`skipped\` — a SILENT skip would be
      // indistinguishable from no new generation ever having been available.
      const withUnsupported = [...withOpus6,
        { id: 'claude-opus-7', created_at: '2026-12-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: false } } },
      ];
      const gated = pickFamilyModel('OPUS', withUnsupported, 'claude-opus-5');
      assert(gated.id === 'claude-opus-6', 'a candidate reporting structured_outputs unsupported is skipped for the next-newest');
      assert(gated.skipped.some((s) => s.id === 'claude-opus-7'), 'the skipped candidate is reported in `skipped`, not silently dropped');

      // No capabilities tree at all -> accepted (absence means "the API didn't
      // report it", not "the model lacks it" — module doc guard 3).
      const withNoCapabilities = [...withOpus6,
        { id: 'claude-opus-8', created_at: '2027-01-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
      ];
      assert(pickFamilyModel('OPUS', withNoCapabilities, 'claude-opus-5').id === 'claude-opus-8',
        'a candidate with no capabilities key at all is accepted (unknown, not unsupported)');

      // An older Opus id must never win over the pinned floor.
      const withOlder = [...today,
        { id: 'claude-opus-4-1', created_at: '2025-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 32000, capabilities: { structured_outputs: { supported: true } } },
      ];
      assert(pickFamilyModel('OPUS', withOlder, 'claude-opus-5').id === 'claude-opus-5', 'an older Opus candidate never displaces the floor');
      return { ok: true };
    },
  },
{
    name: 'modelResolver: synchronous reads never reuse a resolved model after an API-key switch',
    run: async () => {
      // Prime a deliberately newer catalog for account A without any network.
      // The important assertion is the NEXT synchronous read: callers such as
      // callLLMText select a model before the next async prime has necessarily
      // started, so account B must get the universal floor rather than A's
      // newer/account-specific id.
      const priorFetch = globalThis.fetch;
      const catalog = [
        { id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
        { id: 'claude-opus-6', created_at: '2026-09-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
        { id: 'claude-sonnet-5', created_at: '2026-05-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 64000 },
        { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 },
      ];
      globalThis.fetch = async () => new Response(JSON.stringify({ data: catalog, has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      try {
        await primeClaudeModels({ apiKey: 'test-account-a-key', force: true });
        assert(claudeModelFor(CLAUDE_FAMILY.OPUS, 'test-account-a-key') === 'claude-opus-6',
          'the account that primed the snapshot may use its resolved newer model');
        assert(claudeModelFor(CLAUDE_FAMILY.OPUS, 'test-account-b-key') === MODEL_FLOOR.OPUS,
          'a different key synchronously receives the safe floor before it is primed, never account A\'s model');
        assert(claudeModelFor(CLAUDE_FAMILY.OPUS, null) === MODEL_FLOOR.OPUS,
          'removing the key also rejects the old API snapshot synchronously');
        assert(resolvedClaudeModels('test-account-b-key').OPUS === MODEL_FLOOR.OPUS,
          'the synchronous resolved-model map also refuses account A\'s stale id');
        assert(claudeModelMetaFor('claude-opus-6', 'test-account-b-key') === null,
          'token-window metadata for account A\'s newer model is unavailable to account B');
        const bSnapshot = modelResolutionSnapshot('test-account-b-key');
        assert(bSnapshot.source === 'floor' && bSnapshot.staleForCurrentKey === true && bSnapshot.resolved.OPUS === MODEL_FLOOR.OPUS,
          'diagnostics report the safe floor plus a key-agnostic stale marker, never account A\'s catalog as current');
      } finally {
        globalThis.fetch = priorFetch;
      }
      return { ok: true };
    },
  },
{
    name: 'claude: webSearchToolType picks the search-tool variant each Claude generation actually accepts',
    run: () => {
      // Verified live (module doc): Haiku 400s on the new `_20260209` variant,
      // so guessing wrong here breaks the ONE grounded call the app makes
      // (company-research) rather than just under-using a feature.
      for (const modern of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
        assert(webSearchToolType(modern) === 'web_search_20260209', `${modern} (Opus/Sonnet 4.6+) gets the dynamic-filtering search tool`);
      }
      for (const legacy of ['claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']) {
        assert(webSearchToolType(legacy) === 'web_search_20250305', `${legacy} gets the basic search tool (the new variant 400s on it)`);
      }
      // The id comes from the live resolver and changes generation on its own —
      // a hard-coded id list would silently stop matching. Future generations
      // must resolve via the regex, including double-digit ones (not string-sorted).
      assert(webSearchToolType('claude-opus-6') === 'web_search_20260209', 'a hypothetical future Opus 6 gets the new variant');
      assert(webSearchToolType('claude-opus-10') === 'web_search_20260209', 'double-digit future generations parse correctly (not string-sorted)');
      // Guessing wrong upward is a hard 400 on the user's résumé research, so
      // anything unidentifiable must fall back to the variant every model accepts.
      assert(webSearchToolType(null) === 'web_search_20250305', 'null input falls back to the safe variant without throwing');
      assert(webSearchToolType(undefined) === 'web_search_20250305', 'undefined input falls back to the safe variant without throwing');
      assert(webSearchToolType('garbage-model-xyz') === 'web_search_20250305', 'an unrecognized id falls back to the safe variant');
      return { ok: true };
    },
  },
{
    name: 'tokenWindow: per-model context windows + max output (verified registry)',
    run: () => {
      // Verified against provider docs (Aug 2026): the MODEL_FLOOR generation —
      // Opus 5 & Sonnet 5 — are 1M natively; Haiku 4.5 is 200K; every compatible
      // Gemini is 1,048,576 / 65,536. Sourced from MODEL_FLOOR (claudeModels.js)
      // rather than a hardcoded literal so a floor bump updates this test for free.
      assert(contextWindowForModel(MODEL_FLOOR.SONNET) === 1000000, 'Sonnet floor window should be 1M');
      assert(contextWindowForModel(MODEL_FLOOR.OPUS) === 1000000, 'Opus floor window should be 1M');
      assert(contextWindowForModel(MODEL_FLOOR.HAIKU) === 200000, 'Haiku floor window should be 200K');
      assert(contextWindowForModel('gemini-3.7-flash') === 1048576, 'Gemini 3.7 Flash window should be 1,048,576');
      assert(maxOutputForModel('gemini-3.7-flash') === 65536, 'Gemini 3.7 Flash max output should be 65,536');
      assert(contextWindowForModel('gemini-3.5-flash') === 1048576, 'Gemini 3.5 flash window should be 1,048,576');
      assert(contextWindowForModel('gemini-3-flash-preview') === 1048576, 'Gemini 3 Flash Preview window should be 1,048,576');
      assert(maxOutputForModel(MODEL_FLOOR.OPUS) === 128000, 'Opus floor max output should be 128K');
      assert(maxOutputForModel('gemini-2.5-flash') === 65536, 'Gemini 2.5 Flash max output should be 65,536');
      assert(maxOutputForModel('gemini-2.5-flash-lite') === 65536, 'Gemini flash-lite max output should be 65,536');
      // Family fallbacks: unknown gemini → 1M; unknown claude → conservative 200K.
      assert(contextWindowForModel('gemini-99-ultra-flash') === 1048576, 'unknown gemini → 1M family default');
      assert(contextWindowForModel('claude-future-9') === 200000, 'unknown claude → conservative 200K default');
      assert(modelMeta('gemini-2.5-flash').provider === 'gemini', 'provider tagged on meta');
      return { ok: true };
    },
  },
{
    name: 'tokenWindow: local estimate over-counts (safe upper bound), assessPromptFit budget math',
    run: () => {
      // The local estimate must be an UPPER bound vs the realistic ~4 chars/token,
      // so it can never wave an oversized prompt through.
      const chars = 100000;
      const est = estimateTokensFromChars(chars);
      assert(est === Math.ceil(chars / LOCAL_CHARS_PER_TOKEN), 'estimate uses the conservative ratio');
      assert(est > chars / 4, 'estimate over-counts vs the realistic ~4 chars/token');
      // A 22K-token scoring batch (15 enriched jobs) fits BOTH a 200K and a 1M window.
      const out = 8800; // job-scoring reserve at 15 items: min(24576, 2500+420*15)
      assert(assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 22000 }).fits, '22K batch fits 200K');
      assert(assessPromptFit({ contextWindow: 1048576, modelMaxOutput: 65536, requestedOutput: out, promptTokens: 22000 }).fits, '22K batch fits 1M');
      // A 195K-token prompt overflows 200K (no room for output+margin) but fits 1M.
      assert(!assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 195000 }).fits, '195K overflows 200K');
      assert(assessPromptFit({ contextWindow: 1048576, modelMaxOutput: 65536, requestedOutput: out, promptTokens: 195000 }).fits, '195K fits 1M');
      // requestedOutput is clamped to the model's own max output.
      const clamped = assessPromptFit({ contextWindow: 200000, modelMaxOutput: 4096, requestedOutput: 24576, promptTokens: 0 });
      assert(clamped.reservedOutput === 4096, 'requestedOutput clamps to modelMaxOutput');
      return { ok: true, est, budget200k: assessPromptFit({ contextWindow: 200000, modelMaxOutput: 64000, requestedOutput: out, promptTokens: 0 }).budget };
    },
  },
{
    name: 'tokenWindow: planSplits recursively halves only oversized groups, preserves order',
    run: () => {
      const items = Array.from({ length: 15 }, (_, i) => i);
      // fits = groups of ≤4 only → every chunk ≤4, order preserved, covers all 15.
      const chunks = planSplits(items, (g) => g.length <= 4);
      assert(chunks.every((c) => c.length <= 4), 'all chunks within the size predicate');
      assert(chunks.flat().join(',') === items.join(','), 'flatten preserves original order + completeness');
      // Whole batch fits → single chunk, no splitting.
      assert(planSplits(items, () => true).length === 1, 'no split when it already fits');
      // Halving ISOLATES a single oversized item (size-weighted predicate).
      const weighted = [1, 1, 1, 20, 1, 1];
      const wchunks = planSplits(weighted, (g) => g.reduce((a, b) => a + b, 0) <= 10);
      assert(wchunks.some((c) => c.length === 1 && c[0] === 20), 'oversized item isolated into its own chunk');
      // A size-1 group that still does not fit is returned as-is (atomic case).
      assert(planSplits([99], () => false).length === 1, 'unsplittable single item returned as-is');
      return { ok: true, chunkSizes: chunks.map((c) => c.length) };
    },
  },
{
    name: 'ZipRecruiter posted-date: DOM "Posted X ago" pattern extracts + parses (no structured date)',
    run: () => {
      // ZR's new /jobs/{co}/{slug} detail pages have NO JSON-LD/__NEXT_DATA__/<time>;
      // the only date is visible text like "Posted 28 days ago". manualScraper's
      // harvest matches POSTED_DATE_PATTERN against short DOM text leaves and feeds
      // the captured phrase to parsePostedDate. Validate that exact chain.
      const re = new RegExp(POSTED_DATE_PATTERN, 'i');
      const ageOf = (d) => d ? Math.round((Date.now() - new Date(d).getTime()) / 86400000) : null;
      const cases = [
        ['Posted 28 days ago', '28 days ago', 28],
        ['Posted 30+ days ago', '30+ days ago', 30],
        ['Reposted 3 weeks ago', '3 weeks ago', 21],
        ['Posted 5 hours ago', '5 hours ago', 0],
        // Regression: these were captured by the old pattern but UNPARSEABLE —
        // "Posted today" parsed to null so the freshest jobs sorted LAST in the
        // recency cap, and "2 years ago" leaked through every age window.
        ['Posted today', 'Posted today', 0],
        ['Posted 2 years ago', '2 years ago', 730],
        ['Posted 30 seconds ago', '30 seconds ago', 0],
      ];
      for (const [raw, phrase, ageDays] of cases) {
        const m = raw.match(re);
        assert(m && m[0] === phrase, `extract "${phrase}" from "${raw}" (got ${m && m[0]})`);
        const parsed = parsePostedDate(m[0]); // returns a Date
        assert(parsed && ageOf(parsed) === ageDays, `parse "${phrase}" → ${ageDays}d (got ${ageOf(parsed)})`);
      }
      // Structural guarantee: EVERY unit the harvest pattern can capture must
      // convert — the pattern and parser are built from one unit table now.
      for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year']) {
        const phrase = `3 ${unit}s ago`;
        assert(phrase.match(re)?.[0] === phrase, `pattern captures "${phrase}"`);
        assert(parsePostedDate(phrase) !== null, `parser converts "${phrase}"`);
      }
      // "just posted" captures and parses to ~today.
      assert('Just posted'.match(re)?.[0].toLowerCase() === 'just posted', 'captures "just posted"');
      assert(parsePostedDate('just posted') !== null, '"just posted" parses to a recent date');
      // The age filter now actually drops year-old postings.
      const aged = filterJobsByAge([{ posted: '2 years ago' }, { posted: '3 days ago' }], 21);
      assert(aged.length === 1 && aged[0].posted === '3 days ago', 'age filter drops "2 years ago" within a 21d window');
      // Must NOT false-positive on prose that merely contains a number, and the
      // bare word "today" must stay parser-only (page prose says "Apply today!").
      assert(!('We have 28 open roles on our careers page.'.match(re)), 'no false-positive on non-date prose');
      assert(!('Apply today!'.match(re)), 'bare "today" is not harvested from prose');
      assert(parsePostedDate('today') !== null, 'bare "today" still parses when an extractor hands it over');
      return { ok: true };
    },
  },
{
    name: 'Dice JD enrichment: extractJobPostingDescription pulls JobPosting.description from JSON-LD',
    run: () => {
      // Dice list summaries are ~500 chars; the full JD lives in the detail page's
      // JSON-LD JobPosting.description. The harvester must handle plain JobPosting,
      // @graph wrappers, and array @type — and never throw on malformed JSON-LD.
      const mk = (ld) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>`;
      assert(extractJobPostingDescription(mk({ '@type': 'JobPosting', description: 'Full JD here' })) === 'Full JD here', 'plain JobPosting');
      assert(extractJobPostingDescription(mk({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', description: 'Graph JD' }] })) === 'Graph JD', '@graph wrapper');
      assert(extractJobPostingDescription(mk({ '@type': ['JobPosting', 'Thing'], description: 'Array-type JD' })) === 'Array-type JD', 'array @type');
      // Absent / no-LD / malformed → '' (caller keeps the list summary), no throw.
      assert(extractJobPostingDescription(mk({ '@type': 'Organization', name: 'Acme' })) === '', 'no JobPosting → empty');
      assert(extractJobPostingDescription('<html>no ld</html>') === '', 'no JSON-LD → empty');
      assert(extractJobPostingDescription('<script type="application/ld+json">{bad json</script>') === '', 'malformed → empty (no throw)');
      return { ok: true };
    },
  },
{
    name: 'Dice salary cadence recovery: extractJobPostingBaseSalary + formatDiceBaseSalary from JSON-LD',
    run: () => {
      // Same JSON-LD shapes as the description harvester test above — the walk
      // (@graph wrapper, array @type, malformed/absent) is shared, so cover it
      // again through the baseSalary path specifically.
      const mk = (ld) => `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>`;
      const yearBS = { currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 90000, maxValue: 125000, unitText: 'YEAR' } };
      assert(JSON.stringify(extractJobPostingBaseSalary(mk({ '@type': 'JobPosting', baseSalary: yearBS }))) === JSON.stringify(yearBS),
        'plain JobPosting baseSalary');
      assert(JSON.stringify(extractJobPostingBaseSalary(mk({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', baseSalary: yearBS }] }))) === JSON.stringify(yearBS),
        '@graph wrapper baseSalary');
      assert(JSON.stringify(extractJobPostingBaseSalary(mk({ '@type': ['JobPosting', 'Thing'], baseSalary: yearBS }))) === JSON.stringify(yearBS),
        'array @type baseSalary');
      assert(extractJobPostingBaseSalary(mk({ '@type': 'JobPosting' })) === null, 'JobPosting with no baseSalary field → null');
      assert(extractJobPostingBaseSalary(mk({ '@type': 'Organization', name: 'Acme' })) === null, 'no JobPosting → null');
      assert(extractJobPostingBaseSalary('<html>no ld</html>') === null, 'no JSON-LD → null');
      assert(extractJobPostingBaseSalary('<script type="application/ld+json">{bad json</script>') === null, 'malformed → null (no throw)');

      // formatDiceBaseSalary: one recognized unitText per schema.org cadence,
      // each producing a suffix parseSalaryToNumeric already understands.
      const unitCases = [
        ['HOUR', { minValue: 24, maxValue: 25, unitText: 'HOUR' }, '$24 - $25/hr'],
        ['DAY', { minValue: 400, maxValue: 450, unitText: 'DAY' }, '$400 - $450/day'],
        ['WEEK', { minValue: 1500, maxValue: 1600, unitText: 'WEEK' }, '$1,500 - $1,600/wk'],
        ['MONTH', { minValue: 5000, maxValue: 5500, unitText: 'MONTH' }, '$5,000 - $5,500/mo'],
        ['YEAR', { minValue: 90000, maxValue: 125000, unitText: 'YEAR' }, '$90,000 - $125,000/yr'],
      ];
      for (const [unit, value, expected] of unitCases) {
        const bs = extractJobPostingBaseSalary(mk({ '@type': 'JobPosting', baseSalary: { currency: 'USD', value } }));
        assert(bs?.value?.unitText === unit, `Dice baseSalary extraction: ${unit} unit round-trips through JSON-LD`);
        const formatted = formatDiceBaseSalary(bs);
        assert(formatted === expected, `Dice baseSalary formatting: ${unit} → "${expected}" (got "${formatted}")`);
        assert(parseSalaryToNumeric(formatted) > 0, `Dice baseSalary formatting: ${unit} cadence annualizes through the shared parser`);
      }
      assert(formatDiceBaseSalary({ currency: 'CAD', value: { value: 30, unitText: 'HOUR' } }) === 'CAD 30/hr',
        'Dice baseSalary formatting: non-USD currency keeps its code prefix');
      assert(formatDiceBaseSalary({ value: { value: 55000, unitText: 'YEAR' } }) === '$55,000/yr',
        'Dice baseSalary formatting: single value (no min/max range) formats correctly');
      assert(formatDiceBaseSalary({ value: { minValue: 5, maxValue: 6 } }) === '',
        'Dice baseSalary formatting: no unitText → never guessed as hourly, stays empty');
      // A one-sided QuantitativeValue is valid schema.org and real ("From $19/hr").
      // Dropping it would discard the very cadence this recovery path exists to find.
      const fromOnly = formatDiceBaseSalary({ value: { minValue: 19, unitText: 'HOUR' } });
      assert(fromOnly === 'From $19/hr' && parseSalaryToNumeric(fromOnly) === 39520,
        `Dice baseSalary formatting: minValue-only keeps the cadence and annualizes, got ${JSON.stringify(fromOnly)}`);
      const upToOnly = formatDiceBaseSalary({ value: { maxValue: 24, unitText: 'HOUR' } });
      assert(upToOnly === 'Up to $24/hr' && parseSalaryToNumeric(upToOnly) === 49920,
        `Dice baseSalary formatting: maxValue-only keeps the cadence and annualizes, got ${JSON.stringify(upToOnly)}`);
      assert(formatDiceBaseSalary(null) === '', 'Dice baseSalary formatting: null input → empty');
      assert(formatDiceBaseSalary('nonsense') === '', 'Dice baseSalary formatting: non-object input → empty');

      // End-to-end regression: the real cadence-lost Dice values from the bug
      // report annualize to 0 as-is, but recover once "upgraded" with a
      // JSON-LD baseSalary — mirroring enrichDiceDescriptions' actual gate
      // (parseSalaryToNumeric(job.salary) === 0) and its recovery path.
      const cadenceLost = ['25', '19', '$20 - $24', '$20 - $21'];
      for (const raw of cadenceLost) {
        assert(parseSalaryToNumeric(raw) === 0, `Dice salary regression: "${raw}" has no readable cadence pre-fix`);
      }
      const recoveredHtml = mk({ '@type': 'JobPosting', description: 'JD', baseSalary: { value: { minValue: 20, maxValue: 24, unitText: 'HOUR' } } });
      const upgraded = formatDiceBaseSalary(extractJobPostingBaseSalary(recoveredHtml));
      assert(upgraded === '$20 - $24/hr', 'Dice salary upgrade: recovered baseSalary formats with a readable cadence');
      assert(parseSalaryToNumeric(upgraded) === 20 * 40 * 52,
        'Dice salary upgrade: upgraded text now annualizes end-to-end through the shared parser instead of 0');

      // Salaries that already annualize (Dice's own text is complete) must
      // never be overwritten by the JSON-LD upgrade — enrichDiceDescriptions
      // only patches when parseSalaryToNumeric(job.salary) === 0.
      const alreadyGood = ['USD 90,000.00 - 125,000.00 per year', 'USD 24.00 - 25.00 per hour', 'USD 23.21 - 23.21 per hour', '38000 - 40000'];
      for (const raw of alreadyGood) {
        assert(parseSalaryToNumeric(raw) > 0, `Dice salary: "${raw}" already annualizes and must not trigger a JSON-LD upgrade`);
      }
      assert(parseSalaryToNumeric('38000 - 40000') === 38000,
        'Dice salary: bare range without a cadence word but above the credibility floor still parses to $38,000/yr');

      // No usable baseSalary in the JSON-LD → caller leaves job.salary exactly
      // as-is (correctly → Unspecified), never guesses a small bare number is hourly.
      const noBaseSalaryHtml = mk({ '@type': 'JobPosting', description: 'JD' });
      assert(formatDiceBaseSalary(extractJobPostingBaseSalary(noBaseSalaryHtml)) === '',
        'Dice salary upgrade: absent baseSalary in JSON-LD → no upgrade, salary text is left untouched by the caller');
      return { ok: true };
    },
  },
{
    name: "Dice salary cadence recovery: extractDiceSalaryBadge reads the detail page's own badge",
    run: () => {
      // Checked live against 9 real Dice job-detail pages: baseSalary in the
      // JSON-LD never carries unitText (see the JSON-LD test above — that
      // path is schema.org-correct but dead for Dice in practice). The page
      // itself renders the real cadence as a short badge right next to its
      // <h1> title, e.g. "$16 - $16/hr" — that's what actually recovers
      // Dice salaries. The same page also lists OTHER jobs' salaries much
      // further down (a "Related jobs" rail, worded "$X.XX - $Y.YY per
      // hour"), which must never be attributed to this job.
      const pad = (n) => 'x'.repeat(n);
      const withBadge = (salaryText, gap = 1400) =>
        `<html><body><h1 class="job-title">Customer Service Rep I</h1>${pad(gap)}<div class="SeuiInfoBadge"><div>${salaryText}</div></div>${pad(30000)}<div>USD 19.81 - 28.30 per hour</div></body></html>`;
      assert(extractDiceSalaryBadge(withBadge('$16 - $16/hr')) === '$16 - $16/hr',
        'reads the ranged $X - $Y/hr badge next to the title');
      assert(extractDiceSalaryBadge(withBadge('$24/hr')) === '$24/hr',
        'reads a single-value $X/hr badge');
      assert(parseSalaryToNumeric(extractDiceSalaryBadge(withBadge('$16 - $16/hr'))) === 16 * 40 * 52,
        'the recovered badge text annualizes through the shared parser (low end × 2080)');

      // The unrelated "Related jobs" salary sits far past the search window —
      // must never be picked up when THIS job has no badge of its own.
      const noBadgeButLaterJob = `<html><body><h1>Front Desk Receptionist</h1>${pad(500)}<div>Depends on Experience</div>${pad(30000)}<div>USD 19.81 - 28.30 per hour</div></body></html>`;
      assert(extractDiceSalaryBadge(noBadgeButLaterJob) === '',
        "a later/unrelated job's salary far down the page is never attributed to this job");

      assert(extractDiceSalaryBadge('<html><body>no h1 here</body></html>') === '', 'no <h1> on the page → empty, no throw');
      assert(extractDiceSalaryBadge('') === '', 'empty input → empty, no throw');
      assert(extractDiceSalaryBadge(null) === '', 'null input → empty, no throw');

      // enrichDiceDescriptions' actual fallback order: try the JSON-LD
      // unitText path first, then the badge — mirroring Dice's real shape,
      // where baseSalary has real min/maxValue but no unitText at all.
      const diceRealShape = `<html><body><h1>Patient Account Representative</h1>${pad(1200)}<div>$21 - $24/hr</div></body>` +
        `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', minValue: 21, maxValue: 24 } })}</script></html>`;
      const jsonLdFirst = formatDiceBaseSalary(extractJobPostingBaseSalary(diceRealShape));
      assert(jsonLdFirst === '', 'Dice-shaped baseSalary (real min/maxValue, no unitText) still yields nothing from the JSON-LD path alone');
      const fallback = jsonLdFirst || extractDiceSalaryBadge(diceRealShape);
      assert(fallback === '$21 - $24/hr', 'falls back to the page badge when JSON-LD has no cadence, matching real Dice pages');
      assert(parseSalaryToNumeric(fallback) === 21 * 40 * 52,
        'the fallback-recovered text annualizes end-to-end instead of staying 0');
      return { ok: true };
    },
  },
{
    name: 'Dice postedDate bucket: only exact 1/3/7-day windows map to a server-side filter',
    run: () => {
      // Dice's `filters.postedDate` accepts ONLY ONE/THREE/SEVEN (verified against
      // the live API; other values are silently ignored). dicePostedBucket must
      // return a bucket ONLY for an exact 1/3/7-day window, else null so the caller
      // keeps the wide over-pull + client-side filter (no server-side narrowing).
      assert(dicePostedBucket(1) === 'ONE', '1 → ONE');
      assert(dicePostedBucket(3) === 'THREE', '3 → THREE');
      assert(dicePostedBucket(7) === 'SEVEN', '7 → SEVEN');
      assert(dicePostedBucket(7.0) === 'SEVEN', 'float 7.0 → SEVEN');
      // Non-bucket windows → null (client-side enforces them; never a wrong bucket).
      for (const n of [2, 5, 6, 8, 14, 21, 30]) {
        assert(dicePostedBucket(n) === null, `${n} → null (no exact bucket)`);
      }
      // Garbage / missing → null (never throw, never fabricate a bucket).
      for (const bad of [null, undefined, 0, -1, NaN, '7']) {
        assert(dicePostedBucket(bad) === null, `${String(bad)} → null`);
      }
      return { ok: true };
    },
  },
{
    name: 'Batch chunking: window-split sub-batches reconcile by b{i} (order + per-job index preserved)',
    run: () => {
      // The async batch path pre-splits each over-window group then submits one
      // `b{i}` request per fit-guaranteed sub-batch (splitBatchesToFitWindow in
      // jobs.js mirrors planSplits). reconcileBatchScores must map every sub-batch
      // back by local index so no job is lost or mis-scored after the split.
      const jobs = Array.from({ length: 7 }, (_, i) => ({ id: i, title: `J${i}`, company: 'Co' }));
      const subBatches = planSplits(jobs, (g) => g.length <= 3); // synthetic "fits ≤3" predicate
      assert(subBatches.flat().length === 7, 'no jobs lost across the split');
      assert(subBatches.every((b) => b.length <= 3), 'each sub-batch within the window predicate');
      // Build results exactly as the Batch API returns them: b{i} → {scores:[{index(LOCAL)…}]}.
      const resultsByCustomId = {};
      subBatches.forEach((b, i) => {
        resultsByCustomId[`b${i}`] = { scores: b.map((_job, idx) => ({ index: idx, matchScore: 50 + idx, reasoning: 'r', careerDirection: 'X' })) };
      });
      const { scoredJobs, placeholderCount, failedBatches } = reconcileBatchScores(subBatches, resultsByCustomId, { fallbackScore: 1 });
      assert(scoredJobs.length === 7, 'every job reconciled after the split');
      assert(placeholderCount === 0 && failedBatches === 0, 'clean results → no placeholders/failures');
      assert(scoredJobs.every((j) => typeof j.title === 'string' && j.matchScore >= 50), 'each job kept its fields + a real local-index score');
      return { ok: true, subBatchSizes: subBatches.map((b) => b.length) };
    },
  },
{
    name: 'Application: literal \\n / \\t escapes decode in cover letter + résumé (no verbatim backslash text)',
    run: () => {
      // decodeTextEscapes: literal 2-char escapes → real whitespace; real content untouched.
      assert(decodeTextEscapes('Hiring Team\\nMonster') === 'Hiring Team\nMonster', 'literal \\n decodes to newline');
      assert(decodeTextEscapes('a\\tb') === 'a\tb', 'literal \\t decodes to tab');
      assert(decodeTextEscapes('already\nreal') === 'already\nreal', 'real newline untouched (no-op)');
      assert(decodeTextEscapes('plain text') === 'plain text', 'plain text untouched');

      // Cover letter: a recipient with a LITERAL backslash-n splits into rows
      // (recipient-name + recipient-line), and no verbatim "\n" leaks through.
      // buildCoverLetterDocument takes { letter, variantAttrs, docId } — fields
      // nest under `letter`, they are not top-level (signature changed under
      // the HTML-first rewrite, design doc §5.2).
      const cl = buildCoverLetterDocument({
        letter: {
          name: 'Maya Chen',
          recipient: 'Hiring Team\\nMonster Brewing Company',
          salutation: 'Dear Monster Team,',
          paragraphs: ['I have led growth\\nin brand marketing for 6 years.', 'Second\\tindented bit.'],
          closing: 'Sincerely,',
        },
      });
      // Scoped past the inlined <style> AND the injected chrome's own <script>
      // — that script legitimately contains a real "\n" as JS SOURCE (the
      // download-a-copy button builds a Blob with '<!doctype html>\n' + …),
      // which is correct JS, not a leaked model escape. Only the rendered
      // document content (past </style>, minus the toolbar script) must be
      // free of a literal two-character backslash-n/t.
      const clContent = cl.split('</style>').pop().replace(/<script[\s\S]*?<\/script>/g, '');
      assert(!/\\n|\\t/.test(clContent), 'cover letter must contain NO literal backslash-n/t');
      assert(clContent.includes('<span class="recipient-name">Hiring Team</span>'), 'recipient first line → recipient-name');
      assert(clContent.includes('<span class="recipient-line">Monster Brewing Company</span>'), 'recipient second line → recipient-line');
      // An in-paragraph newline must COLLAPSE (flowing prose), NOT become a hard
      // <br> — a stray model newline mid-sentence (around a title's en-dash) would
      // otherwise render as a bad break. Both halves still present, no <br>.
      assert(!/<br\s*\/?>/.test(clContent), 'no hard <br> break inserted inside a paragraph');
      assert(/led growth\s+in brand marketing/.test(clContent), 'in-paragraph newline collapses to whitespace (prose flows)');

      // Résumé: literal escapes in the raw model HTML decode to whitespace.
      // buildResumeDocument now takes { resumeMainHtml, variantAttrs, ledger,
      // docId } — no longer a bare positional string (design doc §4.3 needs
      // somewhere to pass the ledger through for receipt resolution).
      const rz = buildResumeDocument({ resumeMainHtml: '<main class="page"><h1 class="name">Maya\\nChen</h1><p>Led\\tgrowth</p></main>' });
      const rzContent = rz.split('</style>').pop().replace(/<script[\s\S]*?<\/script>/g, '');
      assert(!/\\n|\\t/.test(rzContent), 'résumé must contain NO literal backslash-n/t');
      assert(/Maya\s+Chen/.test(rzContent), 'résumé literal \\n became collapsing whitespace');
      return { ok: true };
    },
  }
];
