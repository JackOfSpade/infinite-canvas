import { APPLICATION_COVER_LETTER_SCHEMA, APPLICATION_DIRECT_COVER_LETTER_SCHEMA, CLAUDE_FAMILY, GEMINI_ALL_MODEL_IDS, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL_FALLBACKS, GEMINI_TIER_LADDER, JOB_TAXONOMY_CHUNK_SIZE, JOB_TAXONOMY_CLASSIFY_SCHEMA, JOB_TAXONOMY_PLAN_SCHEMA, LETTER_GROUNDING_AUDIT_SCHEMA, LETTER_NEEDS_SCHEMA, LETTER_PLAN_SCHEMA, LOCAL_CHARS_PER_TOKEN, MODEL_FLOOR, POSTED_DATE_PATTERN, VERTEX_GEMINI_MODEL_FALLBACKS, VERTEX_LOCATION, appendGroundedSourceAppendix, assert, assessPromptFit, buildCoverLetterDocument, buildResumeDocument, callGeminiTextRaw, classifyGeminiFailure, claudeModelFor, claudeModelMetaFor, contextWindowForModel, decodeTextEscapes, describeGeminiFailure, dicePostedBucket, entitledTiersFor, effectiveCap, entitlementSnapshot, estimateTokensFromChars, extractDiceSalaryBadge, extractJobPostingBaseSalary, extractJobPostingDescription, filterJobsByAge, formatClaudeGroundedResponse, formatDiceBaseSalary, formatGeminiGroundedResponse, gatedTiers, geminiGroundingTools, geminiModelsInTier, getClaudeBatchResults, getGeminiDefaultThinkingConfig, getGeminiLifecycleWarning, getKnownTaskIds, getTokenBudgetSnapshot, groundedMetadataUrls, inspectJobTaxonomyRoleIndexes, isGeminiDailyQuota, isGeminiProviderAvailable, isGeminiZeroOrDailyQuota, isGeminiZeroQuota, maxOutputForModel, modelForTask, modelMeta, modelResolutionSnapshot, normalizeAIProvider, normalizeGeminiApiKey, normalizeJobTaxonomyPlan, orderGeminiModels, orderVertexGeminiModels, parsePostedDate, parseSalaryToNumeric, pickFamilyModel, planSplits, primeClaudeModels, probeModelForTier, providerForTask, reconcileBatchScores, recordEntitlement, refreshEntitlementInBackground, resetEntitlement, resolvedClaudeModels, runBoundedJobTaxonomy, settleEntitlementProbes, taskMaxTokensFor, taskModelRoutingSnapshot, toGeminiSchema, validateJobTaxonomyPlan, vertexGenerateContentUrl, webSearchToolType } from '../test-dependencies.js';
import { isNonApiJobTask } from '../test-dependencies.js';
// __setGeminiLadderRetryWaitForTests is a test-only seam (Finding 7,
// electron/ipc/gemini.js) that isn't part of the shared test-dependencies.js
// barrel — imported directly from the source module so the ladder-exhaustion
// retry-pass tests below never sleep for real (see its doc comment).
import { __setGeminiLadderRetryWaitForTests, geminiCredentialScope } from '../../electron/ipc/gemini.js';

export default [
{
    name: 'llm: compensation and scoring token-budget floors accommodate larger cohorts',
    run: () => {
      assert(taskMaxTokensFor('job-scoring', { itemCount: 100 }) === 12000
        && taskMaxTokensFor('job-scoring', { itemCount: 15 }) === 10600,
        'job-scoring caps the compact manual evidence audit instead of inviting impractical 32,000-token pastes');
      assert(taskMaxTokensFor('job-compensation-assessment', { itemCount: 100 }) === 12288,
        'per-cohort compensation assessment has the larger 12,288-token ceiling');
      assert(taskMaxTokensFor('job-compensation-assessment', { itemCount: 15 }) === 11048,
        'a 15-job consolidated cohort no longer flattens at the former 8,192-token ceiling');
      return { scoringCap: taskMaxTokensFor('job-scoring', { itemCount: 100 }), compensationCap: taskMaxTokensFor('job-compensation-assessment', { itemCount: 100 }) };
    },
  },
{
    name: 'Gemini Vertex routing: global endpoint uses only the supported 2.5 fallback chain',
    run: () => {
      assert(VERTEX_LOCATION === 'global', 'Vertex Gemini publisher calls use the global location');
      assert(JSON.stringify(VERTEX_GEMINI_MODEL_FALLBACKS) === JSON.stringify(['gemini-2.5-flash', 'gemini-2.5-flash-lite']),
        'Vertex fallback chain contains only supported Flash and Flash-Lite ids');
      assert(JSON.stringify(getGeminiDefaultThinkingConfig('gemini-2.5-flash')) === JSON.stringify({ thinkingBudget: 1024 })
        && JSON.stringify(getGeminiDefaultThinkingConfig('gemini-2.5-flash-lite')) === JSON.stringify({ thinkingBudget: 1024 }),
        'Vertex 2.5 models receive the REST thinkingBudget configuration, never the 3.x thinkingLevel form');
      const url = vertexGenerateContentUrl('project-123', 'gemini-2.5-flash');
      assert(url === 'https://aiplatform.googleapis.com/v1/projects/project-123/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
        'Vertex request URL targets the global publisher endpoint, never a regional hostname');
      assert(!url.includes('us-central1') && !VERTEX_GEMINI_MODEL_FALLBACKS.some((id) => /^gemini-3/.test(id)),
        'Vertex transport cannot emit the regional 3.x ids that returned 404s');
      assert(JSON.stringify(geminiGroundingTools(false)) === JSON.stringify([{ google_search: {} }]),
        'AI Studio grounding retains its Generative Language google_search field');
      assert(JSON.stringify(geminiGroundingTools(true)) === JSON.stringify([{ googleSearch: {} }]),
        'Vertex grounding uses the v1 publisher API googleSearch field, not the AI Studio spelling');
      assert(normalizeGeminiApiKey('  api-key  ') === 'api-key' && normalizeGeminiApiKey(' \n\t ') === '',
        'whitespace-only keys take the no-key Vertex path instead of producing a misleading AI Studio authentication failure');
      const now = 10_000;
      const suppressed = new Map([['gemini-2.5-flash', now + 1_000]]);
      assert(JSON.stringify(orderVertexGeminiModels(suppressed, now)) === JSON.stringify(['gemini-2.5-flash-lite', 'gemini-2.5-flash']),
        'a cooling Vertex primary moves behind Flash-Lite without leaving the chain empty');
      return { ok: true };
  },
},
{
    name: 'Gemini credential scopes isolate colliding API-key prefixes and same-path Vertex rotations',
    run: () => {
      // These two suffixes collide under the old 32-bit DJB2-style hash. A
      // shared tail preserves that collision, so this is a regression fixture
      // for the exact bug rather than merely an arbitrary unequal-key check.
      const keyTail = 'x'.repeat(32);
      const firstKey = `AIzaAB-${keyTail}`;
      const secondKey = `AIzaAAN${keyTail}`;
      const firstScope = geminiCredentialScope({ apiKey: firstKey });
      const secondScope = geminiCredentialScope({ apiKey: secondKey });
      assert(firstScope !== secondScope && /^ai:[a-f0-9]{64}$/.test(firstScope)
        && !firstScope.includes(firstKey) && !secondScope.includes(secondKey),
      'persisted AI Studio health state uses distinct non-secret SHA-256 scopes even for the demonstrated legacy hash collision');

      const rotatedAtSamePathBefore = geminiCredentialScope({ vertexCredentialIdentity: '{"client_email":"worker@example.test","private_key_id":"old"}' });
      const rotatedAtSamePathAfter = geminiCredentialScope({ vertexCredentialIdentity: '{"client_email":"worker@example.test","private_key_id":"new"}' });
      assert(rotatedAtSamePathBefore !== rotatedAtSamePathAfter
        && /^vx:[a-f0-9]{64}$/.test(rotatedAtSamePathBefore),
      'a replacement service-account identity receives a clean Vertex suppression scope even when its configured path is unchanged');
      return { aiScopeLength: firstScope.length, vertexScopeLength: rotatedAtSamePathBefore.length };
    },
  },
{
    name: 'application generation: cover-letter schemas reserve structure for needs and argument, not envelope fields',
    run: () => {
      assert(JSON.stringify(APPLICATION_COVER_LETTER_SCHEMA.required) === JSON.stringify(['paragraphs']),
        'prose schema requires only body paragraphs');
      assert(Object.keys(APPLICATION_COVER_LETTER_SCHEMA.properties).join(',') === 'paragraphs',
        'prose schema contains no model-authored letterhead or envelope fields');
      const need = LETTER_NEEDS_SCHEMA.properties.needs.items;
      assert(JSON.stringify(need.required) === JSON.stringify(['need', 'quote', 'source', 'decisiveness', 'kind', 'emphasisReason']),
        'needs schema preserves the ranked, verbatim-grounded, emphasis-aware requirement contract');
      assert(need.properties.source.enum.join(',') === 'posting,research',
        'needs sources are limited to the posting and research');
      assert(LETTER_NEEDS_SCHEMA.properties.needs.maxItems === 6,
        'needs schema caps the ranked list at six without preventing the empty-input degrade path');
      assert(need.properties.decisiveness.minimum === 1 && need.properties.decisiveness.maximum === 100,
        'needs schema enforces the documented 1–100 decisiveness range');
      assert(need.properties.emphasisReason.type === 'string',
        'needs schema makes the structural basis for emphasis visible to the argument planner');
      const mapping = LETTER_PLAN_SCHEMA.properties.mappings.items;
      assert(JSON.stringify(mapping.required) === JSON.stringify(['needIndex', 'need', 'evidence', 'evidenceRole', 'achievementIds', 'resumeStatus', 'inference', 'narrativeRole', 'relationToPrevious']),
        'plan mappings carry evidence, the inferential step, and an explicit narrative relationship');
      assert(mapping.properties.resumeStatus.enum.join(',') === 'stated,implied,absent',
        'plan mappings force an explicit résumé-status declaration');
      assert(LETTER_PLAN_SCHEMA.properties.mappings.minItems === 1
        && LETTER_PLAN_SCHEMA.properties.mappings.maxItems === 2,
      'plan schema requires one primary mapping and caps the argument at two');
      assert(mapping.properties.narrativeRole.enum.join(',') === 'primary,foundation,corroborates,deepens,extends,qualifies'
        && mapping.properties.relationToPrevious.type === 'string'
        && LETTER_PLAN_SCHEMA.properties.mappings.description.includes('Use one by default'),
      'plan schema prefers minimum-sufficient primary proof and records why optional evidence follows it');
      assert(LETTER_PLAN_SCHEMA.properties.roleThesis.description.includes('organizes the entire letter')
        && LETTER_PLAN_SCHEMA.properties.mappings.description.includes('same roleThesis'),
      'plan schema makes one controlling angle, rather than two adjacent matches, the structural contract');
      assert(LETTER_PLAN_SCHEMA.required.includes('logistics') && LETTER_PLAN_SCHEMA.required.includes('droppedNeeds'),
        'plan preserves logistics isolation and visible dropped needs');
      const directContract = APPLICATION_DIRECT_COVER_LETTER_SCHEMA.properties.argumentContract;
      assert(JSON.stringify(APPLICATION_DIRECT_COVER_LETTER_SCHEMA.required) === JSON.stringify(['paragraphs', 'argumentContract'])
        && JSON.stringify(directContract.required) === JSON.stringify(['roleThesis', 'primaryEvidence', 'primaryRelationToThesis', 'secondaryNarrativeRole', 'secondaryEvidence', 'secondaryRelationToPrimary'])
        && directContract.properties.secondaryNarrativeRole.enum.join(',') === 'none,foundation,corroborates,deepens,extends,qualifies',
      'direct fallback returns an ephemeral primary/secondary argument contract for the cohesion audit');
      const groundingViolation = LETTER_GROUNDING_AUDIT_SCHEMA.properties.violations;
      const cohesionObservation = LETTER_GROUNDING_AUDIT_SCHEMA.properties.cohesionObservations;
      assert(LETTER_GROUNDING_AUDIT_SCHEMA.required.includes('violations')
        && LETTER_GROUNDING_AUDIT_SCHEMA.required.includes('cohesionObservations')
        && groundingViolation.maxItems === 8
        && JSON.stringify(groundingViolation.items.required) === JSON.stringify(['claim', 'reason'])
        && cohesionObservation.maxItems === 8
        && JSON.stringify(cohesionObservation.items.required) === JSON.stringify(['kind', 'claim', 'reason', 'repair'])
        && cohesionObservation.items.properties.kind.enum.join(',') === 'unclear-antecedent,unexplained-shift,chronological-backtracking,unmoored-temporal-contrast,inventory-paragraph,overloaded-sentence,faulty-parallelism,misattached-modifier,introductory-punctuation,literal-metaphorical-precision,conditional-closing,repeated-metaphor,awkward-register,unnecessary-employer-repetition,unframed-employer,ambiguous-domain-label,dependent-reference,detached-synthesis,volunteered-gap,delayed-relevance,second-thesis,unnecessary-evidence,dangling-transition,unearned-causal,literalized-frame',
      'final audit separates bounded factual violations from exact-span cohesion observations');
      const faultyParallelismFixture = {
        kind: 'faulty-parallelism',
        claim: 'from the quote request through presenting findings',
        reason: 'The process span coordinates a noun phrase with a verb-ing phrase.',
        repair: 'Use parallel nouns or parallel actions.',
      };
      assert(cohesionObservation.items.properties.kind.enum.includes(faultyParallelismFixture.kind)
        && cohesionObservation.items.required.every(key => String(faultyParallelismFixture[key] || '').length > 0),
      'the grounding-audit schema can return an exact-span observation for the reported noun-to-gerund regression');
      for (const kind of ['misattached-modifier', 'unframed-employer', 'ambiguous-domain-label', 'dependent-reference']) {
        assert(cohesionObservation.items.properties.kind.enum.includes(kind),
          `the grounding-audit schema can report ${kind} instead of hiding it under awkward-register`);
      }
      const detachedSynthesisFixture = {
        kind: 'detached-synthesis',
        claim: 'An ambiguous problem at one end and something running in production at the other is the shape most of my work has taken.',
        reason: 'The conclusion jumps from one role example to unsupported breadth and never names the concrete relationship it summarizes.',
        repair: 'Scope the conclusion to the role and name the evaluation-to-production responsibility, or delete it.',
      };
      const unclearTransitionFixture = {
        kind: 'unclear-antecedent',
        claim: 'It',
        reason: 'The paragraph-opening reference could mean the evaluation, integration, boundary decision, or abstract shape.',
        repair: 'Name the exact end-to-end responsibility.',
      };
      assert([detachedSynthesisFixture, unclearTransitionFixture].every(item => (
        cohesionObservation.items.properties.kind.enum.includes(item.kind)
        && cohesionObservation.items.required.every(key => String(item[key] || '').length > 0)
      )),
      'the audit schema represents the detached-synthesis sentence and its ambiguous cross-paragraph “It” as separate repairable defects');
      const providerNeeds = toGeminiSchema(LETTER_NEEDS_SCHEMA);
      const providerPlan = toGeminiSchema(LETTER_PLAN_SCHEMA);
      assert(providerNeeds.properties.needs.maxItems === 6
        && providerNeeds.properties.needs.items.properties.decisiveness.minimum === 1
        && providerNeeds.properties.needs.items.properties.decisiveness.maximum === 100,
      'Gemini receives the bounded needs contract, not a description-only approximation');
      assert(providerPlan.properties.mappings.maxItems === 2
        && providerPlan.properties.mappings.minItems === 1
        && providerPlan.properties.mappings.items.properties.needIndex.minimum === 0,
      'Gemini receives the bounded non-negative argument-mapping contract');
      return { ok: true };
    },
  },
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
      const bounded = toGeminiSchema({
        type: 'object',
        properties: {
          candidates: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[A-Z]+$', format: 'email' } },
          score: { type: 'integer', minimum: 1, maximum: 100 },
        },
      });
      assert(bounded.properties.candidates.minItems === 1 && bounded.properties.candidates.maxItems === 2
        && bounded.properties.candidates.items.format === 'email',
      'Gemini response-schema adapter preserves documented array and format constraints');
      assert(!('minLength' in bounded.properties.candidates.items)
        && !('maxLength' in bounded.properties.candidates.items)
        && !('pattern' in bounded.properties.candidates.items),
      'Gemini response-schema adapter drops unsupported generic JSON-Schema string constraints instead of triggering a provider 400');
      assert(bounded.properties.score.minimum === 1 && bounded.properties.score.maximum === 100,
        'Gemini response-schema adapter preserves supported numeric constraints');
      return { preservedValidEnum: true };
    },
  },
{
    name: 'job taxonomy: bounded static plan/classifier schemas remain provider-safe at arbitrary board sizes',
    run: () => {
      const classifier = JOB_TAXONOMY_CLASSIFY_SCHEMA;
      assert(JSON.stringify(classifier).length < 800,
      'classifier schema is one fixed, small object rather than an N-property grammar');
      assert(JSON.stringify(classifier.required) === JSON.stringify(['roleByIndex'])
        && classifier.properties.roleByIndex.items.type === 'integer'
        && JOB_TAXONOMY_PLAN_SCHEMA.properties.roleFamilies.maxItems === 12,
      'planner freezes a bounded vocabulary and classifier returns only vocabulary indexes');
      const gemini = toGeminiSchema(classifier);
      assert(gemini.properties.roleByIndex.type === 'ARRAY'
        && gemini.properties.roleByIndex.items.type === 'INTEGER',
      'Gemini receives the same bounded integer-index classifier contract');
      return { schemaBytes: JSON.stringify(classifier).length };
    },
  },
  {
    name: 'job taxonomy: bounded executor covers every original index and never returns a partial result',
    run: async () => {
      const jobs = Array.from({ length: 124 }, (_, index) => ({
        title: index === 0 ? 'X'.repeat(1_000_000) : `Role ${index}`,
        careerDirection: index === 0 ? 'Y'.repeat(1_000_000) : (index % 3 ? 'Engineering' : ''),
        salary: `$${80 + index}k/yr`,
      }));
      const prompts = [];
      const progressReceipts = [];
      let classifications = 0;
      const complete = await runBoundedJobTaxonomy(jobs, {
        onProgress: progress => progressReceipts.push(progress),
        callText: async (prompt, options) => {
          prompts.push({ prompt, options });
          if (options.task === 'job-taxonomy-plan') {
            return { salaryRanges: [{ label: '$100k+/yr', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }], roleFamilies: ['Engineering', 'Other'], directionRoleIndexes: [{ direction: 'Engineering', roleIndex: 0 }, { direction: '(blank)', roleIndex: 1 }, { direction: 'Y'.repeat(100), roleIndex: 1 }] };
          }
          classifications += 1;
          const count = Number(prompt.match(/exactly (\d+) integers/)?.[1]);
          return { roleByIndex: Array.from({ length: count }, (_, index) => index % 2) };
        },
      });
      assert(classifications === 0
        && complete.roleByIndex.length === 124
        && complete.roleByIndex.every(role => role === 'Engineering' || role === 'Other'),
      'planner directly maps every bounded direction without a redundant classifier handoff');
      assert(Math.max(...prompts.map(({ prompt }) => prompt.length)) < 20_000
        && !prompts[0].prompt.includes('X'.repeat(1000))
        && !prompts.some(({ prompt }) => prompt.includes('Y'.repeat(1000))),
      'one-megabyte listing fields are hard-clamped before every provider prompt');
      assert(prompts[0].prompt.includes('encode "Under $Xk/yr" as minSalary=1')
        && prompts[0].prompt.includes('minSalary=0, maxSalary=0'),
      'planner prompt reserves zero bounds for Unspecified and gives Under ranges an unambiguous sentinel');
      const progressSequence = progressReceipts
        .map(progress => `${progress.stage}:${progress.completedBatches}:${progress.processed}`);
      assert(JSON.stringify(progressSequence) === JSON.stringify([
        'planning:0:0', 'planned:0:124',
      ]),
      `taxonomy progress emits one receipt per real transition, without duplicate chunk boundaries (${progressSequence.join(', ')})`);
      // A high-cardinality board deliberately maps only its bounded planning
      // vocabulary. The residual direction must retain its original position
      // and flow through the tiny classifier fallback rather than being
      // silently assigned to Other.
      const diverseJobs = Array.from({ length: 25 }, (_, index) => ({
        title: `Distinct Role ${index}`,
        careerDirection: `Direction ${index}`,
        salary: '$100k/yr',
      }));
      const diversePlan = {
        salaryRanges: [{ label: '$100k+/yr', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
        roleFamilies: ['Mapped', 'Classified', 'Other'],
        directionRoleIndexes: Array.from({ length: 24 }, (_, index) => ({ direction: `Direction ${index}`, roleIndex: 0 })),
      };
      const fallbackHints = [];
      const fallback = await runBoundedJobTaxonomy(diverseJobs, {
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return diversePlan;
          fallbackHints.push(options.hints);
          return { roleByIndex: [1] };
        },
      });
      assert(JSON.stringify(fallbackHints.map(hint => [hint.batch, hint.batchTotal, hint.itemCount])) === JSON.stringify([[1, 1, 1]])
        && fallback.roleByIndex.slice(0, 24).every(role => role === 'Mapped')
        && fallback.roleByIndex[24] === 'Classified',
      'only the unmapped residual is classified in a bounded 1-based chunk and written back to its original index');

      const sequentialJobs = Array.from({ length: 50 }, (_, index) => ({
        title: `Sequential Role ${index}`,
        careerDirection: `Sequential Direction ${index}`,
        salary: '$100k/yr',
      }));
      const sequentialPlan = {
        ...diversePlan,
        directionRoleIndexes: Array.from({ length: 24 }, (_, index) => ({ direction: `Sequential Direction ${index}`, roleIndex: 0 })),
      };
      const sequentialHints = [];
      let activeClassifiers = 0;
      let peakClassifiers = 0;
      await runBoundedJobTaxonomy(sequentialJobs, {
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return sequentialPlan;
          sequentialHints.push(options.hints);
          activeClassifiers += 1;
          peakClassifiers = Math.max(peakClassifiers, activeClassifiers);
          await new Promise(resolve => setTimeout(resolve, options.hints.batch === 1 ? 5 : 0));
          activeClassifiers -= 1;
          return { roleByIndex: Array.from({ length: options.hints.itemCount }, () => 1) };
        },
      });
      assert(peakClassifiers === 1
        && JSON.stringify(sequentialHints.map(hint => [hint.batch, hint.batchTotal, hint.itemCount])) === JSON.stringify([[1, 2, 24], [2, 2, 2]]),
      'manual taxonomy classifier handoffs are issued one at a time in stable batch order so different-length replies cannot be cross-pasted');

      const shortCalls = [];
      let failed = false;
      try {
        await runBoundedJobTaxonomy(diverseJobs, {
          callText: async (_prompt, options) => {
            shortCalls.push(options.task);
            if (options.task === 'job-taxonomy-plan') return diversePlan;
            return { roleByIndex: [0] };
          },
        });
      } catch { failed = true; }
      assert(!failed && shortCalls.filter(task => task === 'job-taxonomy-classify').length === 1,
        'a one-row residual accepts an exact one-index classifier result');
      let shortFailure = '';
      try {
        await runBoundedJobTaxonomy(diverseJobs, {
          callText: async (_prompt, options) => (
            options.task === 'job-taxonomy-plan' ? diversePlan : { roleByIndex: [] }
          ),
        });
      } catch (error) { shortFailure = error?.message || String(error); }
      assert(shortFailure.includes('received 0 entries; exactly 1 required'),
        'a short residual classifier result rejects atomically and reports the raw received count plus exact requirement');
      const controller = new AbortController();
      let abortCalls = 0;
      try {
        await runBoundedJobTaxonomy(diverseJobs, {
          signal: controller.signal,
          callText: async (_prompt, options) => {
            if (options.task === 'job-taxonomy-plan') return diversePlan;
            abortCalls += 1;
            controller.abort();
            return { roleByIndex: [1] };
          },
        });
      } catch { /* cancellation is the expected terminal outcome */ }
      assert(abortCalls === 1, 'cancellation after a residual classifier response prevents taxonomy publication');
      const shape = inspectJobTaxonomyRoleIndexes([0, 2, 1], 3, 2);
      const oversizedShape = inspectJobTaxonomyRoleIndexes(Array(24).fill(0), 14, 2);
      assert(shape.outOfRangeCount === 1
        && inspectJobTaxonomyRoleIndexes([0, 1], 3, 2).missingCount === 1
        && oversizedShape.rawEntryCount === 24
        && oversizedShape.extraCount === 10,
      'classifier diagnostics reject unknown indexes and distinguish raw response length from expected-position coverage');
      const noOther = normalizeJobTaxonomyPlan({ roleFamilies: ['Engineering'], salaryRanges: [] });
      assert(!noOther.valid, 'a plan without the reserved Other role is rejected before any classification call');
      const malformedSalaryPlan = validateJobTaxonomyPlan({
        roleFamilies: ['Engineering', 'Other'],
        salaryRanges: [
          { label: '$120k+/yr', minSalary: 120000, maxSalary: 0 },
          { label: '$80k–$100k/yr', minSalary: 80000, maxSalary: 100000 },
          { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
        ],
      });
      assert(!malformedSalaryPlan.valid && malformedSalaryPlan.reason.includes('preceding range'),
        'a schema-valid but gapped salary plan remains in the manual retry loop instead of being silently normalized into another taxonomy');
      return { chunks: classifications, promptMax: Math.max(...prompts.map(({ prompt }) => prompt.length)) };
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
      const adversarial = orderGeminiModels('gemini-3.5-flash', new Map(), now, {
        responseSchema: true,
        excludeModels: ['gemini-3.7-flash'],
      });
      assert(!adversarial.includes('gemini-3.7-flash') && adversarial.length > 1,
        'an adversarial structured-output pass can exclude the exact model that authored the material under review');
      const vertexAdversarial = orderVertexGeminiModels(new Map(), now, { excludeModels: ['gemini-2.5-flash'] });
      assert(JSON.stringify(vertexAdversarial) === JSON.stringify(['gemini-2.5-flash-lite']),
        'the Vertex cascade honors the same author-model exclusion when another supported model exists');
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
    // 2026-08-21 regression: excludeModels was consumed for fallback ordering
    // but never stripped before the wire payload, so every callLLMText Gemini
    // call sent generationConfig.excludeModels and Google 400'd the entire
    // cascade ("Unknown name \"excludeModels\" at 'generation_config'").
    name: 'Gemini cascade: internal options (excludeModels/task/meta) never leak into the wire generationConfig',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const bodies = [];
      const calledModels = [];
      globalThis.fetch = async (url, init) => {
        const target = String(url);
        const calledModel = /models\/([^:]+):generateContent/.exec(target)?.[1] || null;
        if (!calledModel || !GEMINI_MODEL_FALLBACKS.includes(calledModel)) {
          // Ancillary call (the background Pro-entitlement probe) — irrelevant here.
          return new Response(JSON.stringify({ error: { code: 429, message: 'ignore' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        calledModels.push(calledModel);
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'clean payload' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      try {
        const meta = {};
        const text = await callGeminiTextRaw('Adversarial refute pass.', 'payload-hygiene-test-key', 'gemini-3.7-flash', null, {
          maxOutputTokens: 128, formulaSeed: 64, task: 'career-file-extract', meta,
          excludeModels: ['gemini-3.7-flash'],
        });
        assert(text === 'clean payload', 'the mocked call succeeds on the first non-excluded model');
        assert(calledModels.length === 1 && calledModels[0] === 'gemini-3.6-flash',
          `excludeModels steers the cascade off the excluded author model (called: ${calledModels.join(', ') || 'none'})`);
        const genCfg = bodies[0]?.generationConfig || {};
        for (const key of ['excludeModels', 'task', 'meta', 'formulaSeed', 'signal', 'grounding']) {
          assert(!(key in genCfg), `internal option "${key}" must never reach the wire generationConfig — Google rejects unknown fields with a 400`);
        }
        assert(genCfg.maxOutputTokens === 128 && genCfg.responseMimeType === 'text/plain',
          'real generationConfig fields still reach the wire');
      } finally {
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { calledModels };
    },
  },
{
    // Companion to the leak test above: when every model rejects the request
    // itself, the aggregate header must not claim "usage limits or quotas" —
    // that wording tripped enhanceLLMError's 'quota' message sniff, falsely
    // tagged isRateLimit, and titled the hub banner "Usage Limit Reached".
    name: 'Gemini cascade: an all-models payload rejection reports a request bug, not a usage limit',
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (!target.includes(':generateContent')) throw new Error(`Unexpected Gemini payload-rejection test URL: ${target}`);
        return new Response(JSON.stringify({
          error: { code: 400, message: 'Invalid JSON payload received. Unknown name "excludeModels" at \'generation_config\': Cannot find field.' },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      };
      try {
        let failure = null;
        try {
          await callGeminiTextRaw('Trigger the aggregate failure.', 'payload-bug-header-test-key', 'gemini-3.7-flash', null, { maxOutputTokens: 128 });
        } catch (err) {
          failure = err;
        }
        assert(/All Gemini models failed/.test(failure?.message || ''), 'exhausted cascade still surfaces the aggregate failure');
        assert(/malformed request or an API change/.test(failure.message),
          'header names a request/API-contract problem when no failure was limit-shaped');
        assert(!/quota|rate limit|429/i.test(failure.message),
          'header avoids limit-flavored words that would falsely trip enhanceLLMError or the hub banner');
        assert(failure.isRateLimit !== true, 'a payload rejection is never tagged as a rate limit');
      } finally {
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { ok: true };
    },
  },
{
    // Finding 7 (gemini.js): a real run burned the entire ladder in ~850ms —
    // every model 429'd on a recoverable per-minute quota — then threw and the
    // caller silently degraded, even though the SAME model succeeded 4 seconds
    // later. These four tests cover the fix: the ladder-exhaustion retry pass.
    name: 'Gemini cascade: ladder-exhaustion retry pass succeeds once every model 429s on a recoverable rate limit',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const N = GEMINI_MODEL_FALLBACKS.length;
      let fallbackCalls = 0;
      let waitHookCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        const calledModel = /models\/([^:]+):generateContent/.exec(target)?.[1] || null;
        if (!calledModel || !GEMINI_MODEL_FALLBACKS.includes(calledModel)) {
          // Ancillary call (the background Pro-entitlement probe) — outside the
          // ladder's own bookkeeping, must not affect fallbackCalls below.
          return new Response(JSON.stringify({ error: { code: 429, message: 'ignore' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        fallbackCalls++;
        if (fallbackCalls <= N) {
          return new Response(JSON.stringify({
            error: { code: 429, message: 'Resource exhausted. Please retry in 0.05s.', status: 'RESOURCE_EXHAUSTED' },
          }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'recovered after the quota window reopened' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6, thoughtsTokenCount: 0 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      __setGeminiLadderRetryWaitForTests(async () => { waitHookCalls++; });
      try {
        const text = await callGeminiTextRaw('Research this company.', 'retry-pass-success-test-key', 'gemini-3.7-flash', null, {});
        assert(text === 'recovered after the quota window reopened', 'callGemini resolves with the retry pass\'s successful text');
        assert(fallbackCalls === N + 1, `the retry pass needed exactly one more attempt after the exhausted ladder (got ${fallbackCalls}, expected ${N + 1})`);
        assert(waitHookCalls === 1, `exactly one retry pass runs, never a loop (wait hook invoked ${waitHookCalls} times)`);
      } finally {
        __setGeminiLadderRetryWaitForTests(null);
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { fallbackCalls, waitHookCalls };
    },
  },
{
    name: 'Gemini cascade: a hard failure mixed into an exhausted ladder throws immediately with no retry wait',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const N = GEMINI_MODEL_FALLBACKS.length;
      let fallbackCalls = 0;
      let waitHookCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        const calledModel = /models\/([^:]+):generateContent/.exec(target)?.[1] || null;
        if (!calledModel || !GEMINI_MODEL_FALLBACKS.includes(calledModel)) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'ignore' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        fallbackCalls++;
        // Every model rate-limits EXCEPT one, which is denied outright
        // (model-access) — a failure no short quota-reset timer can fix.
        if (calledModel === 'gemini-3.5-flash-lite') {
          return new Response(JSON.stringify({
            error: { code: 403, message: 'Permission denied on resource model gemini-3.5-flash-lite', status: 'PERMISSION_DENIED' },
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          error: { code: 429, message: 'Resource exhausted. Please retry in 0.05s.', status: 'RESOURCE_EXHAUSTED' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      };
      __setGeminiLadderRetryWaitForTests(async () => { waitHookCalls++; });
      try {
        let failure = null;
        try {
          await callGeminiTextRaw('Research this company.', 'retry-pass-hard-failure-test-key', 'gemini-3.7-flash', null, {});
        } catch (err) {
          failure = err;
        }
        assert(/All Gemini models failed/.test(failure?.message || ''), 'a mixed hard failure still surfaces the aggregate failure');
        assert(fallbackCalls === N, `every model is attempted exactly once — a mixed hard classification skips the retry pass entirely (got ${fallbackCalls}, expected ${N})`);
        assert(waitHookCalls === 0, 'a non-rate-limit failure anywhere in the pass must skip the wait entirely — a short timer cannot fix it');
      } finally {
        __setGeminiLadderRetryWaitForTests(null);
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { fallbackCalls, waitHookCalls };
    },
  },
{
    name: 'Gemini cascade: a retry pass that ALSO exhausts throws the identical aggregate-failure error, only once',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const N = GEMINI_MODEL_FALLBACKS.length;
      let fallbackCalls = 0;
      let waitHookCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        const calledModel = /models\/([^:]+):generateContent/.exec(target)?.[1] || null;
        if (!calledModel || !GEMINI_MODEL_FALLBACKS.includes(calledModel)) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'ignore' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        fallbackCalls++;
        return new Response(JSON.stringify({
          error: { code: 429, message: 'Resource exhausted. Please retry in 0.05s.', status: 'RESOURCE_EXHAUSTED' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      };
      __setGeminiLadderRetryWaitForTests(async () => { waitHookCalls++; });
      try {
        let failure = null;
        try {
          await callGeminiTextRaw('Research this company.', 'retry-pass-double-429-test-key', 'gemini-3.7-flash', null, {});
        } catch (err) {
          failure = err;
        }
        assert(/All Gemini models failed/.test(failure?.message || ''), 'a doubly-exhausted ladder still throws the SAME unchanged aggregate error');
        assert(failure?.isRateLimit === true && failure?.provider === 'gemini', 'the final error keeps its existing rate-limit tagging (error shape unchanged)');
        assert(fallbackCalls === N * 2, `both the original pass and the single retry pass attempt every model (got ${fallbackCalls}, expected ${N * 2})`);
        assert(waitHookCalls === 1, `only ONE retry pass ever runs, even when it also exhausts (wait hook invoked ${waitHookCalls} times)`);
      } finally {
        __setGeminiLadderRetryWaitForTests(null);
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { fallbackCalls, waitHookCalls };
    },
  },
{
    name: 'Gemini cascade: an abort during the ladder-exhaustion retry wait propagates as an AbortError',
    run: async () => {
      const originalFetch = globalThis.fetch;
      const N = GEMINI_MODEL_FALLBACKS.length;
      let fallbackCalls = 0;
      let waitHookCalls = 0;
      const controller = new AbortController();
      globalThis.fetch = async (url) => {
        const target = String(url);
        const calledModel = /models\/([^:]+):generateContent/.exec(target)?.[1] || null;
        if (!calledModel || !GEMINI_MODEL_FALLBACKS.includes(calledModel)) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'ignore' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        fallbackCalls++;
        return new Response(JSON.stringify({
          error: { code: 429, message: 'Resource exhausted. Please retry in 0.05s.', status: 'RESOURCE_EXHAUSTED' },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      };
      // Simulates the user/timeout cancelling exactly while the ladder is
      // waiting out the quota window — the wait hook itself triggers the abort.
      __setGeminiLadderRetryWaitForTests(async () => {
        waitHookCalls++;
        controller.abort();
      });
      try {
        let failure = null;
        try {
          await callGeminiTextRaw('Research this company.', 'retry-pass-abort-test-key', 'gemini-3.7-flash', controller.signal, {});
        } catch (err) {
          failure = err;
        }
        assert(failure?.name === 'AbortError', `an abort during the retry wait must surface as an AbortError, not the aggregate failure (got ${failure?.name}: ${failure?.message})`);
        assert(fallbackCalls === N, `the abort is caught right after the wait, before any second-pass attempt (got ${fallbackCalls}, expected ${N})`);
        assert(waitHookCalls === 1, 'the wait is attempted exactly once before the abort short-circuits it');
      } finally {
        __setGeminiLadderRetryWaitForTests(null);
        await settleEntitlementProbes();
        globalThis.fetch = originalFetch;
      }
      return { fallbackCalls, waitHookCalls };
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
    name: 'llm: generic routing supports only Gemini and Claude APIs; legacy Local AI settings fall back to Gemini',
    run: () => {
      // Fake settings objects, NOT the real store — providerForTask takes an
      // explicit 2nd arg precisely so callers (and tests) can probe routing
      // without mutating global settings.
      const geminiSettings = { provider: 'gemini', anthropicApiKey: 'x' };
      const claudeSettings = { provider: 'claude', anthropicApiKey: 'x' };
      const legacyLocalSettings = { provider: 'local' };

      // Every generic task must use one of the two API providers. A persisted
      // legacy Local AI selection is intentionally safe: it follows the
      // historic Gemini default instead of leaving unrelated AI features
      // unable to make a request.
      for (const task of [...getKnownTaskIds(), 'default'].filter(task => !isNonApiJobTask(task))) {
        assert(providerForTask(task, geminiSettings) === 'gemini', `'${task}' follows the Gemini Settings pick`);
        assert(providerForTask(task, claudeSettings) === 'claude', `'${task}' follows the Claude Settings pick`);
        assert(providerForTask(task, legacyLocalSettings) === 'gemini', `'${task}' falls back to Gemini for the removed Local AI provider`);
        assert(String(modelForTask(task, legacyLocalSettings)).startsWith('gemini-'), `'${task}' resolves a Gemini model for the removed Local AI provider`);
      }
      assert(normalizeAIProvider('gemini') === 'gemini' && normalizeAIProvider('claude') === 'claude',
        'the two supported provider settings remain valid');
      assert(normalizeAIProvider('local') === 'gemini' && normalizeAIProvider('not-a-provider') === 'gemini',
        'legacy Local AI and invalid persisted provider values normalize to Gemini');
      const geminiQualityTasks = [
        'vision-product-analysis', 'price-synthesis', 'bundle-price-synthesis',
        'default',
      ];
      for (const task of geminiQualityTasks) {
        assert(modelForTask(task, geminiSettings) === 'gemini-3.7-flash',
          `'${task}' uses Gemini 3.7 Flash as its quality-tier primary`);
      }
      for (const task of ['platform-fit-assessment', 'page-status-classify', 'marketplace-hub-scan', 'text-polish']) {
        assert(modelForTask(task, geminiSettings) === 'gemini-3.5-flash-lite',
          `'${task}' remains on the deliberate lightweight Gemini tier`);
      }
      // Callers that pass an explicit malformed/missing settings snapshot must
      // fail safely to the default provider instead of crashing on
      // `settings.provider` while handling a real task.
      assert(providerForTask('price-synthesis', null) === 'gemini', 'an explicit null settings snapshot safely falls back to Gemini');
      assert(modelForTask('price-synthesis', null) === 'gemini-3.7-flash', 'model routing remains usable with an explicit null settings snapshot');
      return { ok: true };
    },
  },
{
    name: 'llm: default Claude model settings resolve every live API task',
    run: () => {
      // The safety net for the whole task-group refactor: an install with no
      // `claudeModels` configured (settings.js backfills GROUP_DEFAULT_FAMILY)
      // must resolve Judgment, Extraction, and Light tasks to their defaults.
      const settings = { provider: 'claude', anthropicApiKey: 'x' }; // no claudeModels key — defaults apply
      const { OPUS, SONNET, HAIKU } = MODEL_FLOOR;
      const expected = {
        'vision-product-analysis':   SONNET,
        'price-synthesis':           OPUS,
        'bundle-price-synthesis':    OPUS,
        'default':                   SONNET,
        'platform-fit-assessment':   HAIKU,
        'page-status-classify':      HAIKU,
        'marketplace-hub-scan':      HAIKU,
        'text-polish':               HAIKU,
      };
      for (const [task, expectedModel] of Object.entries(expected)) {
        const got = modelForTask(task, settings);
        assert(got === expectedModel, `default claudeModels: '${task}' should resolve to ${expectedModel}, got ${got}`);
      }
      // Every known task (+ the 'default' fallback) is covered above — a task
      // added to TASK_GROUPS without a row here would silently go unverified.
      assert(new Set([...getKnownTaskIds(), 'default'].filter(task => !isNonApiJobTask(task))).size === Object.keys(expected).length,
        'the expectation table above covers every known task, including the default fallback');
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
      const badToken = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { judgment: 'nope', light: null } };
      assert(modelForTask('price-synthesis', badToken) === MODEL_FLOOR.OPUS, 'an unrecognized Judgment token falls back to OPUS (the group default)');
      assert(modelForTask('text-polish', badToken) === MODEL_FLOOR.HAIKU, 'a null light token falls back to HAIKU (the group default)');

      const noClaudeModelsAtAll = { provider: 'claude', anthropicApiKey: 'x' };
      assert(modelForTask('price-synthesis', noClaudeModelsAtAll) === MODEL_FLOOR.OPUS, 'a settings object with no claudeModels key at all still resolves via the group default');
      return { ok: true };
    },
  },
{
    name: 'llm: a non-default claudeModels family choice for one group actually moves that group\'s resolved model, and only that group',
    run: () => {
      // The whole point of the group/step refactor is that the FAMILY is a
      // per-group Settings choice, not a hard-code — prove picking a
      // non-default family actually changes the resolved model id, not just
      // that the plumbing accepts the value without erroring. Judgment is set
      // below while Light is left unset, proving the choice is group-scoped.

      const sonnetJudgment = { provider: 'claude', anthropicApiKey: 'x', claudeModels: { judgment: 'SONNET' } };
      assert(modelForTask('price-synthesis', sonnetJudgment) === MODEL_FLOOR.SONNET, 'judgment=SONNET moves price-synthesis off its OPUS default');
      assert(modelForTask('text-polish', sonnetJudgment) === MODEL_FLOOR.HAIKU, 'light (unset) retains its own HAIKU default');
      return { ok: true };
    },
  },
{
    name: 'llm: taskModelRoutingSnapshot reports only live API groups and tasks',
    run: () => {
      // Replaces the old providerPinnedTasks/applicationGenerationBlocked
      // bug-report fields (which described a pin that no longer exists) — a
      // task missing from this snapshot would be invisible to a "why did
      // this task use a weaker/stronger model than I picked" bug report.
      const settings = { provider: 'claude', anthropicApiKey: 'x' }; // defaults apply
      const snap = taskModelRoutingSnapshot(settings);
      assert(snap.provider === 'claude', 'snapshot.provider reflects the Settings provider');
      assert(Object.keys(snap.groups).sort().join(',') === 'extraction,judgment,light', 'snapshot.groups contains exactly the three live API groups');
      assert(snap.groups.judgment.family === 'OPUS' && snap.groups.extraction.family === 'SONNET' && snap.groups.light.family === 'HAIKU', 'group summaries resolve to their own defaults');

      const knownTasks = [...getKnownTaskIds()].filter(task => !isNonApiJobTask(task));
      assert(knownTasks.length > 0, 'sanity: getKnownTaskIds is non-empty');
      for (const task of knownTasks) {
        assert(snap.tasks[task], `taskModelRoutingSnapshot is missing a row for registered task '${task}'`);
        assert(snap.tasks[task].provider === 'claude', `'${task}' row reports the active provider`);
        assert(typeof snap.tasks[task].model === 'string' && snap.tasks[task].model.length > 0, `'${task}' row carries a real model id, not undefined/empty`);
      }
      for (const task of getKnownTaskIds()) {
        if (isNonApiJobTask(task)) assert(!snap.tasks[task], `'${task}' is excluded because it is a manual non-API handoff, not an API routing row`);
      }

      // provider is task-independent (providerForTask doc) — every row
      // shares the one provider even under a Gemini settings object.
      const geminiSnap = taskModelRoutingSnapshot({ provider: 'gemini', anthropicApiKey: 'x' });
      assert(geminiSnap.provider === 'gemini', 'snapshot.provider follows Settings for Gemini too');
      for (const task of knownTasks) {
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
      // so guessing wrong here breaks a grounded API call rather than merely
      // under-using a feature.
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
    name: 'grounded research: Claude and Gemini retain public search provenance in the bounded raw-research prefix',
    run: () => {
      const longTitle = `Claude evidence ${'x'.repeat(260)}`;
      const claude = formatClaudeGroundedResponse([
        {
          type: 'text',
          text: 'Claude found a credible career framework.',
          citations: [
            { type: 'web_search_result_location', url: 'https://framework.example/ladder', title: longTitle, encrypted_index: 'never-copy-this' },
            { type: 'web_search_result_location', url: 'javascript:alert(1)', title: 'Unsafe protocol' },
          ],
        },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://framework.example/ladder', title: 'Duplicate title loses to first', encrypted_content: 'never-copy-this-either' },
            { type: 'web_search_result', url: 'https://association.example/levels', title: 'Professional levels https://title-injected.example/not-a-source', encrypted_content: 'opaque payload' },
            { type: 'web_search_result', url: 'https://secret@example.test/private', title: 'Credential URL is unsafe', encrypted_content: 'opaque payload' },
          ],
        },
        { type: 'text', text: 'It also found an association ladder.', citations: null },
      ]);
      assert(claude.startsWith('Grounded source URLs (provider metadata):\n- https://framework.example/ladder — Claude evidence ') && claude.includes('https://framework.example/ladder')
        && claude.includes('https://association.example/levels')
        && claude.includes('Claude found a credible career framework.\nIt also found an association ladder.'),
      'Claude grounded prose retains text citations and web-search result URLs before the research body');
      assert((claude.match(/https:\/\/framework\.example\/ladder/g) || []).length === 1
        && !claude.includes('javascript:') && !claude.includes('secret@example')
        && !claude.includes('never-copy-this') && !claude.includes('opaque payload'),
      'Claude provenance is URL-deduped and never leaks encrypted content, unsafe protocols, or credential-bearing URLs');
      const claudeTitle = claude.split('\n')[1].split(' — ')[1];
      assert(claudeTitle.length <= 200 && claudeTitle.endsWith('…'),
        'provider source titles are bounded before being persisted beside grounded research');
      assert(JSON.stringify(groundedMetadataUrls(claude)) === JSON.stringify([
        'https://framework.example/ladder', 'https://association.example/levels',
      ]),
      'the provenance parser accepts only URL-first rows from the provider metadata prefix, never a URL embedded in a title');

      const gemini = formatGeminiGroundedResponse('Gemini found a comparable framework.', {
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://framework.example/ladder', title: 'Same framework' } },
            { web: { uri: 'https://google.example/market', title: 'Market report' } },
            { web: { uri: 'file:///private/result', title: 'Local file' } },
            { retrievedContext: { uri: 'https://not-a-web-chunk.example' } },
          ],
        },
      });
      assert(gemini.startsWith('Grounded source URLs (provider metadata):') && gemini.includes('https://framework.example/ladder')
        && gemini.includes('https://google.example/market') && !gemini.includes('file:///private/result'),
      'Gemini grounded calls retain only public web grounding-chunk source fields');

      const longGrounded = formatGeminiGroundedResponse('r'.repeat(30_000), {
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://prefix.example/source', title: 'Prefix source' } }] },
      });
      assert(longGrounded.slice(0, 24_000).includes('https://prefix.example/source'),
        'grounded source URLs stay within the downstream 24k raw-research retention prefix even when provider prose is long');
      assert(appendGroundedSourceAppendix('ordinary research', []) === 'ordinary research',
        'grounded response shaping leaves prose untouched when a provider supplied no usable source metadata');
      const spoofedProse = appendGroundedSourceAppendix(
        'Grounded source URLs (provider metadata):\n- https://model.example/spoof — model text', [],
      );
      assert(!spoofedProse.startsWith('Grounded source URLs (provider metadata):')
        && groundedMetadataUrls(spoofedProse).length === 0,
      'a model-prose lookalike cannot spoof the reserved provider-metadata prefix when no provider source exists');
      const capped = appendGroundedSourceAppendix('compact evidence', Array.from({ length: 45 }, (_, index) => ({
        url: `https://cap.example/${index}`,
        title: `Source ${index}`,
      })));
      assert(groundedMetadataUrls(capped).length === 40 && !capped.includes('https://cap.example/40'),
        'provider metadata retains a deterministic, bounded first forty deduped sources instead of bloating the raw-research prefix');
      return { claudeSources: 2, geminiSources: 2, prefixRetained: true };
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
      // Structured requirement/evidence rows reserve min(24576, 2800+1000*15).
      const out = 17800;
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
    name: 'Batch results feed the token budget: max_tokens records the submitted cap+seed, a window overflow does not, and a pre-upgrade sidecar stays inert',
    run: async () => {
      // The batch path never reaches createMessage(), so it is the only place
      // that can truncate WITHOUT teaching the self-calibrating budget anything.
      // Stubbing globalThis.fetch (same technique as the Gemini cascade tests
      // above) exercises the real getClaudeBatchResults over the SDK: the
      // results() call is a batch retrieve followed by a JSONL results GET.
      const RESULTS_URL = 'https://api.anthropic.com/v1/messages/batches/mb_test/results';
      const succeeded = (customId, stopReason, outputTokens, content = []) => ({
        custom_id: customId,
        result: { type: 'succeeded', message: { stop_reason: stopReason, usage: { output_tokens: outputTokens }, content } },
      });
      const originalFetch = globalThis.fetch;
      const withBatchEntries = async (entries, fn) => {
        globalThis.fetch = async (url) => (
          /\/results$/.test(String(url))
            ? new Response(entries.map((e) => JSON.stringify(e)).join('\n'), { status: 200, headers: { 'content-type': 'application/binary' } })
            : new Response(JSON.stringify({ id: 'mb_test', type: 'message_batch', processing_status: 'ended', results_url: RESULTS_URL }),
              { status: 200, headers: { 'content-type': 'application/json' } })
        );
        try { return await fn(); } finally { globalThis.fetch = originalFetch; }
      };

      // (i) max_tokens → truncation recorded at the cap the item was SUBMITTED
      // with (9000, from the persisted sidecar), not the 700 tokens it managed
      // to emit before the cut-off, plus its formula seed for diagnostics.
      const truncated = await withBatchEntries([succeeded('b0', 'max_tokens', 700)], () =>
        getClaudeBatchResults('batch-budget-test-key', 'mb_test', {
          task: 'tb-batch-truncate', capsByCustomId: { b0: { cap: 9000, seed: 2500 } },
        }));
      assert(truncated.b0.ok === false && truncated.b0.error === 'max_tokens (truncated)',
        'a truncated item is still refused, so reconciliation applies its placeholder');
      const truncSnap = getTokenBudgetSnapshot()['tb-batch-truncate'];
      assert(truncSnap?.truncatedAt === 9000 && truncSnap.formulaSeedAtTruncation === 2500,
        'the sidecar cap + seed are what get recorded (output_tokens understates the cap on a thinking-heavy item)');
      assert(truncSnap.samples === 1 && truncSnap.max === 700,
        'the truncated call is also a usage sample — batch runs used to contribute none at all');
      assert(effectiveCap('tb-batch-truncate', 2500) === Math.round(9000 * 1.2),
        'the next run provisions past the cap that truncated instead of truncating identically forever');

      // (ii) A window overflow is an INPUT-size problem: raising the output cap
      // shrinks the input budget, so it must never raise the truncation floor.
      const overflowed = await withBatchEntries([succeeded('b0', 'model_context_window_exceeded', 5000)], () =>
        getClaudeBatchResults('batch-budget-test-key', 'mb_test', {
          task: 'tb-batch-window', capsByCustomId: { b0: { cap: 9000, seed: 2500 } },
        }));
      assert(overflowed.b0.ok === false && overflowed.b0.error === 'model_context_window_exceeded (truncated)',
        'a window overflow is refused under its own stop reason');
      assert(getTokenBudgetSnapshot()['tb-batch-window']?.truncatedAt === 0,
        'no truncation floor from a context-window overflow');
      assert(effectiveCap('tb-batch-window', 1000) === 1000,
        'the cap for that task is left exactly where the formula put it');

      // (iii) A sidecar written before this existed carries neither field. Both
      // tokenBudget helpers no-op on a falsy task, so reconciliation of an
      // in-flight pre-upgrade batch must behave exactly as it did before.
      const before = Object.keys(getTokenBudgetSnapshot()).sort().join(',');
      const legacy = await withBatchEntries(
        [
          succeeded('b0', 'max_tokens', 700),
          succeeded('b1', 'end_turn', 42, [{ type: 'text', text: 'new-' }, { type: 'text', text: 'json' }]),
          succeeded('b2', 'end_turn', 42, [{ type: 'tool_use', input: { scores: [] } }]),
          succeeded('b3', 'refusal', 1),
        ],
        () => getClaudeBatchResults('batch-budget-test-key', 'mb_test'));
      assert(legacy.b0.error === 'max_tokens (truncated)'
        && legacy.b1.ok === true && legacy.b1.text === 'new-\njson'
        && legacy.b2.ok === true && legacy.b2.text === JSON.stringify({ scores: [] })
        && legacy.b3.ok === false && legacy.b3.error === 'refusal',
      'legacy batches retain old tool_use decoding while native text JSON concatenates and refusals fail explicitly');
      assert(Object.keys(getTokenBudgetSnapshot()).sort().join(',') === before,
        'a task-less reconcile records nothing and throws nothing');

      // (iv) A caps record missing this item (e.g. a customId that was never
      // submitted) falls back to what the model did emit rather than recording 0.
      await withBatchEntries([succeeded('b9', 'max_tokens', 700)], () =>
        getClaudeBatchResults('batch-budget-test-key', 'mb_test', { task: 'tb-batch-nocaps', capsByCustomId: {} }));
      assert(getTokenBudgetSnapshot()['tb-batch-nocaps']?.truncatedAt === 700,
        'no caps entry → the observed output tokens are still a usable cap-too-low signal');
      return { ok: true };
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

      // Cover letter: legacy recipient data is intentionally ignored. The
      // design system now identifies a generic addressee in the salutation,
      // without a redundant postal-style recipient block.
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
      assert(!clContent.includes('recipient-name') && !clContent.includes('recipient-line')
        && !clContent.includes('Monster Brewing Company'), 'legacy recipient data must not render a recipient block');
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
