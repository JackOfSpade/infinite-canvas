// AI task/model sizing — NOT provider routing. Every AI call in the app now
// goes through the single human copy/paste handoff (electron/ipc/nonApiAi.js,
// NON_API_AI_TRANSPORT === 'non-api-ai'); there is no Gemini/Claude API call,
// no per-task provider/model selection, no entitlement probing, no token-
// window preflight, and no Batch API left to test. What remains real and
// worth covering here:
//   - the known-task registry and each task's output-size guidance
//     (getKnownTaskIds / taskMaxTokensFor / TASK_MAX_TOKENS in llm.js),
//   - the always-permissive manual preflight (checkPromptFits),
//   - the job-scoring batch-size ceiling (resultCaps.jobScoringBatchSize),
//   - two schema-shape guarantees (application cover-letter / job-taxonomy
//     JSON schemas) that the manual handoff still depends on,
//   - the bounded job-taxonomy executor (runBoundedJobTaxonomy),
// plus a block of job-source scraping/formatting tests (ZipRecruiter posted-
// date parsing, Dice JD/salary/pager behaviour, safeApiFetch cancellation
// classification, application text-escape decoding) that never depended on
// an LLM provider and is preserved here unmodified.
//
// taskModelRoutingSnapshot()'s own single-transport contract is covered in
// platform-utils.js ('llm: taskModelRoutingSnapshot reports the single
// manual transport for every known task') — not duplicated here.
import { APPLICATION_COVER_LETTER_SCHEMA, APPLICATION_DIRECT_COVER_LETTER_SCHEMA, JOB_TAXONOMY_CHUNK_SIZE, JOB_TAXONOMY_CLASSIFY_SCHEMA, JOB_TAXONOMY_PLAN_SCHEMA, LETTER_GROUNDING_AUDIT_SCHEMA, LETTER_NEEDS_SCHEMA, LETTER_PLAN_SCHEMA, POSTED_DATE_PATTERN, assert, buildCoverLetterDocument, buildJobTaxonomyPlanSummary, buildResumeDocument, cancellationError, checkPromptFits, decodeTextEscapes, dicePostedBucket, extractDiceSalaryBadge, extractJobPostingBaseSalary, extractJobPostingDescription, fetchDiceListings, filterJobsByAge, formatDiceBaseSalary, getKnownTaskIds, inspectJobTaxonomyRoleIndexes, jobPreferenceResearchAssessmentMaxTokens, jobPreferenceResearchMaxTokens, jobScoringBatchFits, jobScoringBatchSize, jobScoringEstimatedTokens, jobScoringMaxTokens, listingEvaluationBatchSize, listingEvaluationMaxTokens, marketplaceHubScanBatchEstimatedTokens, marketplaceHubScanBatchFits, marketplaceHubScanMaxPagesForPlatform, nodeCancellationError, normalizeJobTaxonomyPlan, parsePostedDate, parseSalaryToNumeric, priceSynthesisBatchEstimatedTokens, priceSynthesisBatchFits, priceSynthesisBatchMaxComps, priceSynthesisBatchMaxTokens, runBoundedJobTaxonomy, safeApiFetch, taskMaxTokensFor, validateJobTaxonomyPlan } from '../test-dependencies.js';

export default [
{
    name: 'llm: compensation and scoring token-budget floors accommodate larger cohorts',
    run: () => {
      assert(taskMaxTokensFor('job-scoring', { itemCount: 22 }) === 14800
        && taskMaxTokensFor('job-scoring', { itemCount: 23 }) === 15360
        && taskMaxTokensFor('job-scoring', { itemCount: 15 }) === 10600,
        'job-scoring keeps old 15-row handoffs byte-stable while fresh 22-row work uses the 15,360-token packed ceiling');
      assert(taskMaxTokensFor('job-compensation-assessment', { itemCount: 100 }) === 12288,
        'per-cohort compensation assessment has the larger 12,288-token ceiling');
      assert(taskMaxTokensFor('job-compensation-assessment', { itemCount: 15 }) === 11048,
        'a 15-job consolidated cohort no longer flattens at the former 8,192-token ceiling');
      // The profile grows with the corpus the multi-file career drop merges, so
      // its cap must too. The old flat 4096 truncated a large corpus mid-JSON,
      // and the copy/paste transport has no cap-raise retry to recover it.
      assert(taskMaxTokensFor('resume-parse', {}) === 4096
        && taskMaxTokensFor('resume-parse', { promptLength: 6000 }) === 4608
        && taskMaxTokensFor('resume-parse', { promptLength: 60000 }) === 11776
        && taskMaxTokensFor('resume-parse', { promptLength: 5_000_000 }) === 12288,
        'resume-parse scales its cap with the merged career corpus and stops at a bounded ceiling');
      return { scoringCap: taskMaxTokensFor('job-scoring', { itemCount: 100 }), compensationCap: taskMaxTokensFor('job-compensation-assessment', { itemCount: 100 }) };
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
      return { ok: true };
    },
  },
{
    name: 'job taxonomy: bounded static plan/classifier schemas stay small at arbitrary board sizes',
    run: () => {
      const classifier = JOB_TAXONOMY_CLASSIFY_SCHEMA;
      assert(JSON.stringify(classifier).length < 800,
      'classifier schema is one fixed, small object rather than an N-property grammar');
      assert(JSON.stringify(classifier.required) === JSON.stringify(['roleByIndex'])
        && classifier.properties.roleByIndex.items.type === 'integer'
        && JOB_TAXONOMY_PLAN_SCHEMA.properties.roleFamilies.maxItems === 12,
      'planner freezes a bounded vocabulary and classifier returns only vocabulary indexes');
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

      const sequentialJobs = Array.from({ length: 1000 }, (_, index) => ({
        title: `Sequential Role ${index}`,
        careerDirection: `Sequential Direction ${index}`,
        salary: '$100k/yr',
      }));
      const sequentialPlan = {
        ...diversePlan,
        directionRoleIndexes: buildJobTaxonomyPlanSummary(sequentialJobs).commonSuggestedDirections
          .map(({ direction }) => ({ direction, roleIndex: 0 })),
      };
      const sequentialPlanned = sequentialPlan.directionRoleIndexes.length;
      const sequentialResidualSizes = [];
      for (let remaining = sequentialJobs.length - sequentialPlanned; remaining > 0; remaining -= JOB_TAXONOMY_CHUNK_SIZE) {
        sequentialResidualSizes.push(Math.min(JOB_TAXONOMY_CHUNK_SIZE, remaining));
      }
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
      assert(peakClassifiers === 3
        && JSON.stringify(sequentialHints.map(hint => [hint.batch, hint.batchTotal, hint.itemCount]))
          === JSON.stringify(sequentialResidualSizes.map((itemCount, index) => [index + 1, sequentialResidualSizes.length, itemCount]))
        && sequentialHints.every((hint, index) => hint.itemsTotal === sequentialJobs.length
          && hint.itemsDone === sequentialPlanned
          && hint.progressUnits === sequentialResidualSizes[index]
          && hint.progressUnitId === `fresh:${index + 1}`
          && typeof hint.progressScopeId === 'string' && hint.progressScopeId.length > 0)
        && new Set(sequentialHints.map(hint => hint.progressScopeId)).size === 1,
      'v2 taxonomy fills the 15,360-token ceiling with 448 compact rows per handoff, dispatches independent chunks together with stable identities, and reports only accepted scoped progress');

      // Classification is automatic work: one slow batch must not strand the
      // other nine worker slots. Keep every prompt deferred so this verifies
      // the cap, immediate refill, and durable batch identity without a fast
      // successor cascading through the rest of the test data.
      const rollingJobs = Array.from({ length: 5_000 }, (_, index) => ({
        title: `Rolling Roster Role ${index}`,
        careerDirection: `Rolling Roster Direction ${index}`,
        salary: '$100k/yr',
      }));
      const rollingPlan = {
        ...diversePlan,
        directionRoleIndexes: buildJobTaxonomyPlanSummary(rollingJobs).commonSuggestedDirections
          .map(({ direction }) => ({ direction, roleIndex: 0 })),
      };
      const rollingCalls = [];
      let rollingActive = 0;
      let rollingPeak = 0;
      let notifyInitialRollingRoster;
      const initialRollingRoster = new Promise(resolve => { notifyInitialRollingRoster = resolve; });
      const rollingRun = runBoundedJobTaxonomy(rollingJobs, {
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return rollingPlan;
          const { batch, itemCount } = options.hints;
          const result = { roleByIndex: Array.from({ length: itemCount }, () => 1) };
          return new Promise(resolve => {
            rollingActive += 1;
            rollingPeak = Math.max(rollingPeak, rollingActive);
            const call = {
              batch,
              hints: options.hints,
              released: false,
              release() {
                if (call.released) return;
                call.released = true;
                rollingActive -= 1;
                resolve(result);
              },
            };
            rollingCalls.push(call);
            if (rollingCalls.length === 10) notifyInitialRollingRoster();
          });
        },
      });
      await initialRollingRoster;
      assert(JSON.stringify(rollingCalls.map(call => call.batch)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        && rollingActive === 10 && rollingPeak === 10,
      `taxonomy must fill exactly ten automatic slots before waiting, got ${JSON.stringify({ batches: rollingCalls.map(call => call.batch), rollingActive, rollingPeak })}`);
      rollingCalls[0].release();
      for (let attempt = 0; attempt < 100 && rollingCalls.length < 11; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(rollingCalls.length === 11 && rollingCalls[10].batch === 11
        && rollingCalls.slice(1, 10).every(call => !call.released)
        && rollingActive === 10 && rollingPeak === 10
        && rollingCalls[10].hints.batchTotal === rollingCalls[1].hints.batchTotal,
      `a completed taxonomy slot must immediately refill with the next durable batch while siblings remain open, got ${JSON.stringify({ batches: rollingCalls.map(call => call.batch), rollingActive, rollingPeak })}`);
      for (let attempt = 0; attempt < 100 && rollingActive > 0; attempt += 1) {
        rollingCalls.filter(call => !call.released).forEach(call => call.release());
        await new Promise(resolve => setImmediate(resolve));
      }
      const rolling = await rollingRun;
      assert(rolling.roleByIndex.length === rollingJobs.length
        && rolling.roleByIndex.every(Boolean),
      'rolling taxonomy completion preserves the original output shape and every classified assignment');

      // Restored v1 and fresh v2 chunks retain their independent durable task
      // identities, but they share the same work-conserving automatic roster.
      let hybridWaveProbeCount = 0;
      const hybridRollingCalls = [];
      let hybridActive = 0;
      let hybridPeak = 0;
      let notifyInitialHybridRoster;
      const initialHybridRoster = new Promise(resolve => { notifyInitialHybridRoster = resolve; });
      const hybridWaveRun = runBoundedJobTaxonomy(rollingJobs, {
        legacyClassifierStepProbe: async () => (++hybridWaveProbeCount === 1),
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return rollingPlan;
          const { itemCount } = options.hints;
          const result = { roleByIndex: Array.from({ length: itemCount }, () => 1) };
          return new Promise(resolve => {
            hybridActive += 1;
            hybridPeak = Math.max(hybridPeak, hybridActive);
            const call = {
              task: options.task,
              hints: options.hints,
              released: false,
              release() {
                if (call.released) return;
                call.released = true;
                hybridActive -= 1;
                resolve(result);
              },
            };
            hybridRollingCalls.push(call);
            if (hybridRollingCalls.length === 10) notifyInitialHybridRoster();
          });
        },
      });
      await initialHybridRoster;
      assert(hybridRollingCalls.length === 10
        && hybridRollingCalls[0].task === 'job-taxonomy-classify'
        && hybridRollingCalls.slice(1).every(call => call.task === 'job-taxonomy-classify-batch')
        && hybridActive === 10 && hybridPeak === 10,
      `one restored taxonomy classifier plus nine fresh chunks must fill the first automatic roster, got ${JSON.stringify(hybridRollingCalls.map(call => call.task))}`);
      hybridRollingCalls[0].release();
      for (let attempt = 0; attempt < 100 && hybridRollingCalls.length < 11; attempt += 1) await new Promise(resolve => setImmediate(resolve));
      assert(hybridRollingCalls.length === 11
        && hybridRollingCalls[10].task === 'job-taxonomy-classify-batch'
        && hybridRollingCalls.slice(1, 10).every(call => !call.released)
        && hybridActive === 10 && hybridPeak === 10,
      'a settled restored classifier must immediately refill its slot with fresh work without changing its legacy identity');
      for (let attempt = 0; attempt < 100 && hybridActive > 0; attempt += 1) {
        hybridRollingCalls.filter(call => !call.released).forEach(call => call.release());
        await new Promise(resolve => setImmediate(resolve));
      }
      const hybridRolling = await hybridWaveRun;
      assert(hybridRolling.roleByIndex.length === rollingJobs.length
        && hybridRolling.roleByIndex.every(Boolean),
      'mixed restored/fresh rolling taxonomy preserves every classified assignment');

      const legacyJobs = sequentialJobs.slice(0, 50);
      const legacyPlan = {
        ...diversePlan,
        directionRoleIndexes: buildJobTaxonomyPlanSummary(legacyJobs).commonSuggestedDirections
          .map(({ direction }) => ({ direction, roleIndex: 0 })),
      };
      const legacyHints = [];
      let activeLegacyClassifiers = 0;
      let peakLegacyClassifiers = 0;
      await runBoundedJobTaxonomy(legacyJobs, {
        useLegacyClassifierBatches: true,
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return legacyPlan;
          legacyHints.push({ task: options.task, ...options.hints });
          activeLegacyClassifiers += 1;
          peakLegacyClassifiers = Math.max(peakLegacyClassifiers, activeLegacyClassifiers);
          await new Promise(resolve => setTimeout(resolve, 1));
          activeLegacyClassifiers -= 1;
          return { roleByIndex: Array.from({ length: options.hints.itemCount }, () => 1) };
        },
      });
      assert(peakLegacyClassifiers === 2
        && JSON.stringify(legacyHints.map(hint => [hint.task, hint.batch, hint.batchTotal, hint.itemCount]))
          === JSON.stringify([['job-taxonomy-classify', 1, 2, 24], ['job-taxonomy-classify', 2, 2, 2]]),
      'a durable legacy taxonomy run retains its exact 24-row task contract while independent prompts share one bounded automatic roster');

      const hybridProbes = [];
      const hybridCalls = [];
      const hybrid = await runBoundedJobTaxonomy(sequentialJobs, {
        legacyClassifierStepProbe: async ({ prompt, task, responseSchema, hints }) => {
          hybridProbes.push({ prompt, task, responseSchema, hints });
          return hybridProbes.length === 1;
        },
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') return sequentialPlan;
          hybridCalls.push({ task: options.task, hints: options.hints });
          return { roleByIndex: Array.from({ length: options.hints.itemCount }, () => 1) };
        },
      });
      const hybridFreshSizes = [];
      for (let remaining = sequentialJobs.length - sequentialPlanned - 24; remaining > 0; remaining -= JOB_TAXONOMY_CHUNK_SIZE) {
        hybridFreshSizes.push(Math.min(JOB_TAXONOMY_CHUNK_SIZE, remaining));
      }
      assert(hybridProbes.length === Math.ceil((sequentialJobs.length - sequentialPlanned) / 24)
        && hybridProbes.every((probe, index) => probe.task === 'job-taxonomy-classify'
          && probe.hints.batch === index + 1
          && probe.hints.batchTotal === hybridProbes.length),
      'the resume probe must reconstruct every original 24-row v1 identity, never broadly inspect task history');
      assert(JSON.stringify(hybridCalls.map(call => [call.task, call.hints.batch, call.hints.batchTotal, call.hints.itemCount])) === JSON.stringify([
        ['job-taxonomy-classify', 1, hybridProbes.length, 24],
        ...hybridFreshSizes.map((itemCount, index) => ['job-taxonomy-classify-batch', index + 1, hybridFreshSizes.length, itemCount]),
      ]), 'only the exact durable classifier prompt may replay; all unissued rows must move to deterministic 448-row v2 chunks');
      assert(hybrid.roleByIndex.length === sequentialJobs.length && hybrid.roleByIndex.every(Boolean),
        'hybrid taxonomy migration must assign each original job exactly once without any unclassified gap');

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
      assert(!failed && shortCalls.filter(task => task === 'job-taxonomy-classify-batch').length === 1,
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
      const gappedSalaryPlan = {
        roleFamilies: ['Engineering', 'Other'],
        salaryRanges: [
          { label: '$120k+/yr', minSalary: 120000, maxSalary: 0 },
          { label: '$80k–$100k/yr', minSalary: 80000, maxSalary: 100000 },
          { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
        ],
      };
      // This plan is rejected on its salary ranges, long before the direction
      // mapping is read; the directions it must cover are stated all the same.
      const malformedSalaryPlan = validateJobTaxonomyPlan(gappedSalaryPlan, []);
      assert(!malformedSalaryPlan.valid && malformedSalaryPlan.reason.includes('preceding range'),
        'a schema-valid but gapped salary plan remains in the manual retry loop instead of being silently normalized into another taxonomy');
      // Validating with no stated directions accepted any direction the
      // response invented, and read as a pass. It is a host defect now.
      let unstatedDirections = '';
      try { validateJobTaxonomyPlan(gappedSalaryPlan); } catch (error) { unstatedDirections = String(error?.message || error); }
      assert(/requires the list of career directions/u.test(unstatedDirections),
        `a plan validated with no stated directions must fail loudly, got ${unstatedDirections || 'a verdict'}`);
      return { chunks: classifications, promptMax: Math.max(...prompts.map(({ prompt }) => prompt.length)) };
    },
  },
{
    name: 'llm: getKnownTaskIds excludes the internal default fallback and the retired page-status-classify task',
    run: () => {
      const known = getKnownTaskIds();
      assert(known instanceof Set && known.size > 0, 'getKnownTaskIds returns a non-empty Set');
      assert(!known.has('default'), 'the internal "default" fallback bucket is not itself a call-site task');
      assert(!known.has('page-status-classify'), 'page-status-classify was deleted (no call site) and must not resurface here');
      return { taskCount: known.size };
    },
  },
{
    name: 'llm: every known task resolves a positive finite output-token ceiling via taskMaxTokensFor',
    run: () => {
      for (const task of getKnownTaskIds()) {
        const cap = taskMaxTokensFor(task);
        assert(Number.isFinite(cap) && cap > 0, `taskMaxTokensFor('${task}') must be a positive finite number (got ${cap})`);
      }
      // The 'default' fallback itself (excluded from getKnownTaskIds, but still
      // a real TASK_MAX_TOKENS entry resolveTask() lands unmapped tasks on).
      const defaultCap = taskMaxTokensFor('default');
      assert(Number.isFinite(defaultCap) && defaultCap > 0, 'the default fallback cap is itself a positive finite number');
      return { defaultCap };
    },
  },
  {
    name: 'llm: batched job-preference research tasks are registered and use the shared result-cap formulas',
    run: () => {
      const known = getKnownTaskIds();
      const itemCounts = [1, 3, 8, 12, 27];
      assert(known.has('job-preference-research-batch')
        && known.has('job-preference-research-batch-assessment')
        && known.has('job-role-screen-batch')
        && known.has('job-taxonomy-classify-batch')
        && known.has('job-compensation-research-batch')
        && known.has('job-compensation-assessment-batch')
        && known.has('marketplace-hub-scan-batch')
        && known.has('price-synthesis-batch'),
      'every versioned packed-work task id is registered instead of falling through to the default cap');
      for (const itemCount of itemCounts) {
        assert(taskMaxTokensFor('job-preference-research-batch', { itemCount })
          === jobPreferenceResearchMaxTokens(itemCount),
        `research batch cap delegates to resultCaps at ${itemCount} item(s)`);
        assert(taskMaxTokensFor('job-preference-research-batch-assessment', { itemCount })
          === jobPreferenceResearchAssessmentMaxTokens(itemCount),
          `research assessment batch cap delegates to resultCaps at ${itemCount} item(s)`);
      }
      assert(jobPreferenceResearchMaxTokens(1) === 4096
        && jobPreferenceResearchAssessmentMaxTokens(1) === 2048
        && jobPreferenceResearchMaxTokens(6) === 9216
        && jobPreferenceResearchAssessmentMaxTokens(6) === 4608
        && jobPreferenceResearchMaxTokens(12) === 15360
        && jobPreferenceResearchAssessmentMaxTokens(12) === 7680
        && jobPreferenceResearchAssessmentMaxTokens(27) === 15360,
      'batched research keeps the legacy singleton floors and fills the usable output budget at twelve employers');
      const packedCaps = [
        taskMaxTokensFor('price-synthesis-batch', { itemCount: 4, totalCompCount: 53 }),
        taskMaxTokensFor('marketplace-hub-scan-batch', { platformCount: 4, urlCount: 8 }),
        taskMaxTokensFor('job-role-screen-batch', { itemCount: 298 }),
        taskMaxTokensFor('job-taxonomy-classify-batch', { itemCount: JOB_TAXONOMY_CHUNK_SIZE }),
        taskMaxTokensFor('job-compensation-research-batch', { roleFamilyCount: 7, itemCount: 7 }),
        taskMaxTokensFor('job-compensation-research-batch', { cohortCount: 4, itemCount: 4 }),
        taskMaxTokensFor('job-compensation-assessment-batch', { cohortCount: 4, itemCount: 12 }),
      ];
      assert(packedCaps.every(cap => Number.isFinite(cap) && cap > 0 && cap <= 15360)
        && packedCaps[0] === 15224
        && packedCaps[1] === 15360,
      `packed manual handoffs must stay at or below the 15,360-token usable ceiling, got ${packedCaps.join(', ')}`);
      assert(priceSynthesisBatchEstimatedTokens(1, 67) === 15324
        && priceSynthesisBatchFits(1, 67)
        && !priceSynthesisBatchFits(1, 68)
        && priceSynthesisBatchMaxComps(1) === 67
        && priceSynthesisBatchMaxTokens(1, 68) === 15360
        && marketplaceHubScanMaxPagesForPlatform() === 26
        && marketplaceHubScanBatchEstimatedTokens(1, 26) === 15360
        && marketplaceHubScanBatchFits(1, 26)
        && !marketplaceHubScanBatchFits(1, 27),
      'packers compare unclamped estimates at the exact price-comp and hub-page boundaries while prompt caps clamp to 15,360');
      return { itemCounts };
    },
  },
{
    name: 'llm: taskMaxTokensFor hint functions scale photoCount/itemCount and an unmapped task falls back to the default cap',
    run: () => {
      // vision-product-analysis: 1024 + 200/photo above the first, capped at 4096.
      assert(taskMaxTokensFor('vision-product-analysis', { photoCount: 1 }) === 1024,
        'a single photo gets the 1024 floor');
      assert(taskMaxTokensFor('vision-product-analysis', { photoCount: 7 }) === 2224,
        'multi-photo uploads scale above the floor (1024 + 6*200)');
      assert(taskMaxTokensFor('vision-product-analysis', { photoCount: 30 }) === 4096,
        'a large photo dump clamps at the 4096 hard cap instead of requesting a runaway budget');
      assert(taskMaxTokensFor('vision-product-analysis') === 1024,
        'an absent photoCount hint defaults to a single photo');
      // bundle-price-synthesis: 2048 + 350/item beyond the two-item baseline, capped at 8192.
      assert(taskMaxTokensFor('bundle-price-synthesis', { itemCount: 2 }) === 2048,
        'the two-item baseline gets the 2048 floor');
      assert(taskMaxTokensFor('bundle-price-synthesis', { itemCount: 20 }) === 8192,
        'a large bundle clamps at the 8192 hard cap');
      // marketplace-hub-scan: 1536 + 512/url beyond the first, capped at 4096.
      assert(taskMaxTokensFor('marketplace-hub-scan', { urlCount: 1 }) === 1536,
        'a single watched URL gets the 1536 floor');
      assert(taskMaxTokensFor('marketplace-hub-scan', { urlCount: 10 }) === 4096,
        'a busy multi-URL hub scan clamps at the 4096 hard cap');
      // An unmapped/unknown task id falls back to the same cap as 'default',
      // and any hints it was passed are ignored (the default entry is a flat number).
      assert(taskMaxTokensFor('not-a-real-task') === taskMaxTokensFor('default')
        && taskMaxTokensFor('not-a-real-task', { itemCount: 999 }) === taskMaxTokensFor('default'),
      'an unrecognized task id resolves the default cap regardless of hints, instead of throwing or returning undefined');
      return { ok: true };
    },
  },
{
    name: 'llm: checkPromptFits is always permissive and its reservedOutput mirrors taskMaxTokensFor for the same task/hints',
    run: async () => {
      const hints = { itemCount: 20 };
      const fit = await checkPromptFits('x'.repeat(300_000), { task: 'job-scoring', hints });
      assert(fit.fits === true, 'the manual-handoff transport has no provider context window to preflight against, so every prompt fits');
      assert(fit.model === 'non-api-ai' && fit.provider === 'non-api-ai' && fit.via === 'manual',
        'the verdict names the single manual transport, not a provider/model');
      assert(fit.budget === Number.MAX_SAFE_INTEGER && fit.contextWindow === Number.MAX_SAFE_INTEGER,
        'budget and contextWindow are unbounded — nothing is gated on them anymore');
      assert(fit.reservedOutput === taskMaxTokensFor('job-scoring', hints),
        'reservedOutput is exactly the same task-specific ceiling taskMaxTokensFor would report for the identical task/hints');
      assert(Number.isFinite(fit.tokens) && fit.tokens > 0, 'tokens is a real (informational-only) local estimate, not left undefined');
      // A wildly larger prompt still fits — there is no size past which this flips.
      const bigger = await checkPromptFits('y'.repeat(5_000_000), { task: 'career-file-extract' });
      assert(bigger.fits === true && bigger.reservedOutput === taskMaxTokensFor('career-file-extract'),
        'even a multi-megabyte prompt reports fits:true with the correct task-specific reservedOutput');
      return { reservedOutput: fit.reservedOutput };
    },
  },
{
    name: 'resultCaps: the listing-evaluation batch can never request more output than the serving model can emit',
    run: () => {
      // This transport has NO cap-raise retry: a batch sized past the model's
      // output ceiling is not degraded gracefully, it is truncated mid-JSON and
      // the whole handoff must be re-pasted. So the declared cap and the batch
      // size MUST come from the same constants and the batch must never exceed
      // what the cap affords — including at plan sizes where a minimum batch
      // would otherwise force it over.
      const CEILING = listingEvaluationMaxTokens(Number.MAX_SAFE_INTEGER);
      const plans = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 48, 64, 128];
      for (const planItems of plans) {
        const batch = listingEvaluationBatchSize(planItems);
        assert(Number.isInteger(batch) && batch >= 1,
          `batch size must be a positive integer for a ${planItems}-item plan, got ${batch}`);
        assert(batch <= 25, `batch size must stay reviewable for a ${planItems}-item plan, got ${batch}`);
        // Declare on BOTH axes, exactly as the batch was derived: matches bind
        // a large plan, the per-listing floor binds a small one. Declaring on
        // matches alone under-states a small-plan batch, which is precisely the
        // drift this asserts against.
        const declared = listingEvaluationMaxTokens(batch * planItems, batch);
        assert(declared <= CEILING,
          `declared output budget ${declared} exceeds the model ceiling ${CEILING} at plan ${planItems}`);
        // The budget the batch was SIZED against must itself fit the ceiling —
        // this is the assertion a raised MIN_LISTING_BATCH, or an inflated
        // base-token constant, would break. Truncation has no retry on this
        // transport, so exceeding it costs the user a whole re-paste.
        assert(declared >= listingEvaluationMaxTokens(batch * planItems),
          `declaring on matches alone must never exceed the two-axis budget at plan ${planItems}`);
      }
      // Degenerate inputs must not produce a zero/NaN batch (an infinite loop in
      // the caller) nor an unbounded one.
      for (const bad of [0, -5, NaN, undefined, null, 'x']) {
        const batch = listingEvaluationBatchSize(bad);
        assert(Number.isInteger(batch) && batch >= 1 && batch <= 25,
          `degenerate plan size ${String(bad)} must still yield a sane batch, got ${batch}`);
      }
      // A bigger plan must never buy a bigger batch.
      let previous = Infinity;
      for (const planItems of plans) {
        const batch = listingEvaluationBatchSize(planItems);
        assert(batch <= previous, `batch must be monotonically non-increasing in plan size (plan ${planItems})`);
        previous = batch;
      }
      // Reproduces the empirically verified answer: the measured run used 10
      // listings per handoff and all 20 of its responses were accepted without
      // truncation. A change that moves this number is a change to how many
      // times the user is interrupted AND to the truncation risk, so pin it.
      assert(listingEvaluationBatchSize(8) === 10,
        `a typical 8-item plan must still afford the measured-safe 10 listings, got ${listingEvaluationBatchSize(8)}`);
      // THE REGRESSION THIS PINS: a 32-item preference plan (the size actually
      // measured, from a real canvas) once collapsed to 3 listings per handoff
      // because the per-match constant was derived from schema worst-case field
      // lengths instead of measured output. That turned a 2070-listing run into
      // 690 copy/paste prompts instead of 207 — a 3.3x increase in human work,
      // produced by a constant nobody could see was wrong.
      assert(listingEvaluationBatchSize(32) === 10,
        `the measured 32-item plan must afford 10 listings per handoff, got ${listingEvaluationBatchSize(32)}`);
      assert(Math.ceil(2070 / listingEvaluationBatchSize(32)) === 207,
        'a 2070-listing pool at the measured plan size must cost 207 handoffs, not 690');
      // The per-match term must stay at or below the floor crossover for the one
      // plan size with real data behind it, or the floor stops governing and the
      // batch silently drops below the 10 that has a 20/20 no-truncation record.
      assert(listingEvaluationMaxTokens(10 * 32, 10) <= CEILING,
        'the measured-safe batch must not declare more output than the model can emit');
      return { ceiling: CEILING, atEightItemPlan: listingEvaluationBatchSize(8) };
    },
  },
  {
    name: 'resultCaps: jobScoringBatchSize derives the largest fresh manual-output-safe pack',
    run: () => {
      // jobScoringBatchSize used to take a model id (jobScoringBatchSize(model))
      // so the caller could size the batch to that model's output budget. There
      // is no per-call model choice anymore — the single manual-handoff output
      // cap is fixed, so the function is zero-arg now.
      assert(jobScoringBatchSize.length === 0, 'jobScoringBatchSize takes no argument (no per-model sizing survives)');
      const size = jobScoringBatchSize();
      assert(size === 22
        && jobScoringEstimatedTokens(size) === 14800
        && jobScoringBatchFits(size)
        && !jobScoringBatchFits(size + 1)
        && jobScoringMaxTokens(size) === 14800,
        `jobScoringBatchSize packs the maximum 22 jobs below 15,360 output tokens (got ${size})`);
      assert(jobScoringBatchSize() === size, 'the result is stable across repeated calls (no hidden state/model drift)');
      return { batchSize: size };
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
    name: 'Dice pager: walks all provider pages, dedupes overlaps, and reports a complete bucketed corpus',
    run: async () => {
      const requests = [];
      const row = (id) => ({
        id: `dice-${id}`,
        title: `Engineer ${id}`,
        companyName: 'Acme',
        detailsPageUrl: `https://www.dice.com/job-detail/dice-${id}`,
        postedDate: 'today',
      });
      // The production 7-day page size is 400. Page two deliberately repeats
      // the final first-page listing: completion must use unique row coverage,
      // not merely page-count arithmetic, and output must not contain it twice.
      const first = Array.from({ length: 400 }, (_, index) => row(index + 1));
      const pages = new Map([
        [1, { data: first, meta: { totalHits: 401 } }],
        [2, { data: [row(400), row(401)], meta: { totalHits: 401 } }],
      ]);
      const result = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async (url) => {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get('page'));
          requests.push({ page, pageSize: parsed.searchParams.get('pageSize'), bucket: parsed.searchParams.get('filters.postedDate') });
          return { ok: true, status: 200, warning: null, json: pages.get(page) || { data: [], meta: { totalHits: 401 } } };
        },
      });
      assert(requests.map(request => request.page).join(',') === '1,2', `pager should request pages 1 and 2 only, got ${JSON.stringify(requests)}`);
      assert(requests.every(request => request.pageSize === '400' && request.bucket === 'SEVEN'), 'bucketed walk preserves the server date filter and its 400-row page size');
      assert(result.items.length === 401 && new Set(result.items.map(job => job._diceId)).size === 401,
        `overlapping pages must be deduped, got ${result.items.length} rows / ${new Set(result.items.map(job => job._diceId)).size} unique ids`);
      assert(result.providerTotal === 401 && result.pagesFetched === 2 && !result.truncated && result.stopReasons.at(-1)?.stopReason === 'provider-total',
        `a complete bucketed corpus must retain totalHits and say complete, got ${JSON.stringify({ providerTotal: result.providerTotal, pagesFetched: result.pagesFetched, truncated: result.truncated, stopReasons: result.stopReasons })}`);
      return { requests: requests.length, items: result.items.length };
    },
  },
{
    name: 'Dice pager: provider-total fallbacks reject placeholder zero coercions',
    run: async () => {
      const row = (id) => ({
        id: `dice-${id}`,
        title: `Engineer ${id}`,
        companyName: 'Acme',
        detailsPageUrl: `https://www.dice.com/job-detail/dice-${id}`,
        postedDate: 'today',
      });
      const fallback = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async () => ({
          ok: true,
          status: 200,
          warning: null,
          json: { data: [row(1), row(2)], meta: { totalHits: null, total: 2 } },
        }),
      });
      assert(fallback.providerTotal === 2 && fallback.stopReasons.at(-1)?.stopReason === 'provider-total',
        `null totalHits must not coerce to 0 or hide a later valid total, got ${JSON.stringify({ providerTotal: fallback.providerTotal, stopReasons: fallback.stopReasons })}`);

      const unknown = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async () => ({
          ok: true,
          status: 200,
          warning: null,
          json: { data: [row(1)], meta: { totalHits: null, total: '', totalResults: false } },
        }),
      });
      assert(unknown.providerTotal === null && unknown.stopReasons.at(-1)?.stopReason === 'short-page',
        `all placeholder totals must remain unknown, got ${JSON.stringify({ providerTotal: unknown.providerTotal, stopReasons: unknown.stopReasons })}`);
      return { fallbackTotal: fallback.providerTotal, unknownTotal: unknown.providerTotal };
    },
  },
{
    name: 'Dice pager: finite jobs cap stops early and never compares an all-age provider total to filtered rows',
    run: async () => {
      const requests = [];
      const row = (id) => ({
        id: `dice-${id}`,
        title: `Engineer ${id}`,
        companyName: 'Acme',
        detailsPageUrl: `https://www.dice.com/job-detail/dice-${id}`,
        postedDate: 'today',
      });
      const result = await fetchDiceListings('engineer', '', null, 21, {
        jobsPerPlatform: 3,
        pagesPerPlatform: 99,
      }, {
        interPageDelayMs: 0,
        requestPage: async (url) => {
          const parsed = new URL(url);
          requests.push({ page: Number(parsed.searchParams.get('page')), pageSize: parsed.searchParams.get('pageSize') });
          return { ok: true, status: 200, warning: null, json: { data: [row(1), row(2), row(3)], meta: { totalHits: 9 } } };
        },
      });
      assert(requests.length === 1 && requests[0].page === 1 && requests[0].pageSize === '3',
        `finite cap must issue one cap-sized request instead of walking the corpus, got ${JSON.stringify(requests)}`);
      assert(result.items.length === 3 && result.truncated && result.providerTotal === null,
        `unbucketed capped rows are partial, so raw total 9 must stay unproven/null; got ${JSON.stringify({ items: result.items.length, truncated: result.truncated, providerTotal: result.providerTotal })}`);
      assert(result.stopReasons.at(-1)?.stopReason === 'jobs-per-platform',
        `finite cap must be explicit in diagnostics, got ${JSON.stringify(result.stopReasons)}`);
      assert(result.pagesFetched === 1 && result.cap?.type === 'jobs-per-platform' && result.cap.limit === 3,
        `cap diagnostics must name the finite configured limit, got ${JSON.stringify({ pagesFetched: result.pagesFetched, cap: result.cap })}`);
      return { requests: requests.length, items: result.items.length };
    },
  },
{
    name: 'Dice pager: a fully exhausted client-side age filter keeps provider totals unproven',
    run: async () => {
      const row = (id, posted) => ({
        id: `dice-${id}`,
        title: `Engineer ${id}`,
        companyName: 'Acme',
        detailsPageUrl: `https://www.dice.com/job-detail/dice-${id}`,
        postedDate: posted,
      });
      const filtered = await fetchDiceListings('engineer', '', null, 21, null, {
        interPageDelayMs: 0,
        requestPage: async () => ({
          ok: true,
          status: 200,
          warning: null,
          json: { data: [row(1, 'today'), row(2, '90 days ago')], meta: { totalHits: 2 } },
        }),
      });
      assert(filtered.items.length === 1 && !filtered.truncated && filtered.providerTotal === null
        && filtered.stopReasons.at(-1)?.stopReason === 'provider-total',
      `a raw-complete but locally filtered walk must expose completion without inventing a provider total, got ${JSON.stringify({ items: filtered.items.length, truncated: filtered.truncated, providerTotal: filtered.providerTotal, stopReasons: filtered.stopReasons })}`);

      const unfiltered = await fetchDiceListings('engineer', '', null, null, null, {
        interPageDelayMs: 0,
        requestPage: async () => ({
          ok: true,
          status: 200,
          warning: null,
          json: { data: [row(1, 'today'), row(2, '90 days ago')], meta: { totalHits: 2 } },
        }),
      });
      assert(unfiltered.items.length === 2 && unfiltered.providerTotal === 2 && !unfiltered.truncated,
        `without a local age filter, the provider's raw total remains comparable, got ${JSON.stringify({ items: unfiltered.items.length, providerTotal: unfiltered.providerTotal, truncated: unfiltered.truncated })}`);
      return { filteredItems: filtered.items.length, unfilteredTotal: unfiltered.providerTotal };
    },
  },
{
    name: 'Dice pager: a first-page transport failure is explicitly truncated and warned',
    run: async () => {
      let requests = 0;
      const result = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async () => {
          requests++;
          // A non-5xx response avoids retry/key-refresh timing while exercising
          // the exact no-warning envelope safeApiFetch can produce on transport
          // failures and unusual proxy responses.
          return { ok: false, status: 418, warning: null, json: null };
        },
      });
      assert(requests === 1 && result.items.length === 0 && result.truncated
        && result.stopReasons.length === 1 && result.stopReasons[0].page === 1 && result.stopReasons[0].stopReason === 'page-error',
      `first-page failure must be marked partial with page-error, got ${JSON.stringify({ requests, items: result.items.length, truncated: result.truncated, stopReasons: result.stopReasons })}`);
      assert(result.warning?.code === 'scrape-failed' && result.warning?.severity === 'block' && result.warning.evidence.includes('418'),
        `first-page no-warning failure must get a safe blocking warning, got ${JSON.stringify(result.warning)}`);
      return { requests, warning: result.warning.code };
  },
},
{
    name: 'Dice pager: fan-out searches get a 25s bounded transport signal without retrying a provider block',
    run: async () => {
      let requests = 0;
      let transport = null;
      const result = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async (_url, context) => {
          requests++;
          transport = context;
          return {
            ok: false,
            status: 429,
            warning: { code: 'http-429', severity: 'throttle', evidence: 'Dice throttled this request' },
            json: null,
          };
        },
      });
      assert(transport?.timeoutMs === 25_000
        && transport?.signal instanceof AbortSignal,
      `Dice fan-out searches must receive the 25s bounded transport signal, got ${JSON.stringify({ timeoutMs: transport?.timeoutMs, hasSignal: !!transport?.signal })}`);
      assert(requests === 1 && result.truncated && result.warning?.code === 'http-429'
        && result.stopReasons.at(-1)?.stopReason === 'page-error',
      `a provider throttle must remain one request and explicit partial coverage, got ${JSON.stringify({ requests, warning: result.warning, truncated: result.truncated, stopReasons: result.stopReasons })}`);

      let blockedRequests = 0;
      const blocked = await fetchDiceListings('engineer', '', null, 7, null, {
        interPageDelayMs: 0,
        requestPage: async () => {
          blockedRequests++;
          return {
            ok: false,
            status: 503,
            warning: { code: 'http-503', severity: 'block', evidence: 'Dice Cloudflare block' },
            json: null,
          };
        },
      });
      assert(blockedRequests === 1 && blocked.warning?.code === 'http-503'
        && blocked.truncated && blocked.stopReasons.at(-1)?.stopReason === 'page-error',
      `a provider block must bypass Dice transient retries and key refresh, got ${JSON.stringify({ blockedRequests, warning: blocked.warning, truncated: blocked.truncated, stopReasons: blocked.stopReasons })}`);

      const cancelled = new AbortController();
      let cancelledRequests = 0;
      let cancellationCaught = false;
      try {
        await fetchDiceListings('engineer', '', cancelled.signal, 7, null, {
          // A full first page makes the walker enter the paced second-page
          // delay. Cancellation must wake that delay rather than wait 5s or
          // dispatch a second request.
          interPageDelayMs: 5000,
          requestPage: async (url) => {
            cancelledRequests++;
            if (Number(new URL(url).searchParams.get('page')) === 1) {
              setTimeout(() => cancelled.abort(), 0);
              return {
                ok: true,
                status: 200,
                json: {
                  data: Array.from({ length: 400 }, (_, index) => ({
                    id: `cancel-${index}`,
                    title: `Engineer ${index}`,
                    companyName: 'Acme',
                    postedDate: 'today',
                  })),
                  meta: { totalHits: 800 },
                },
              };
            }
            return { ok: true, status: 200, json: { data: [] } };
          },
        });
      } catch (error) {
        cancellationCaught = error?.message === 'Aborted';
      }
      assert(cancellationCaught && cancelledRequests === 1,
        `cancelling during Dice pacing must stop before page two, got ${JSON.stringify({ cancellationCaught, cancelledRequests })}`);
      return { timeoutMs: transport.timeoutMs, requests, cancelledRequests };
    },
  },
{
    name: 'Dice pager: only an explicit page ceiling is reported as a configured cap',
    run: async () => {
      const row = (id) => ({
        id: `dice-${id}`,
        title: `Engineer ${id}`,
        companyName: 'Acme',
        detailsPageUrl: `https://www.dice.com/job-detail/dice-${id}`,
        postedDate: 'today',
      });
      const fullPage = (offset) => Array.from({ length: 400 }, (_, index) => row(offset + index));
      const explicit = await fetchDiceListings('engineer', '', null, 7, { jobsPerPlatform: 1_000, pagesPerPlatform: 2 }, {
        interPageDelayMs: 0,
        requestPage: async (url) => {
          const page = Number(new URL(url).searchParams.get('page'));
          return { ok: true, status: 200, warning: null, json: { data: fullPage((page - 1) * 400), meta: { totalHits: 1_000 } } };
        },
      });
      assert(explicit.truncated && explicit.pagesFetched === 2 && explicit.stopReasons.at(-1)?.stopReason === 'pages-per-platform'
        && explicit.cap?.type === 'pages-per-platform' && explicit.cap.limit === 2,
      `explicit page ceiling must be named as a cap, got ${JSON.stringify({ truncated: explicit.truncated, pagesFetched: explicit.pagesFetched, stopReasons: explicit.stopReasons, cap: explicit.cap })}`);

      const defaultBackstop = await fetchDiceListings('engineer', '', null, 7, { pagesPerPlatform: null }, {
        interPageDelayMs: 0,
        requestPage: async (url) => {
          const page = Number(new URL(url).searchParams.get('page'));
          return { ok: true, status: 200, warning: null, json: page === 1
            ? { data: fullPage(0), meta: {} }
            : { data: [], meta: {} } };
        },
      });
      assert(!defaultBackstop.truncated && defaultBackstop.pagesFetched === 2 && defaultBackstop.stopReasons.at(-1)?.stopReason === 'empty-page' && defaultBackstop.cap === null,
        `an exhausted Auto walk must not claim a cap it did not reach, got ${JSON.stringify({ truncated: defaultBackstop.truncated, pagesFetched: defaultBackstop.pagesFetched, stopReasons: defaultBackstop.stopReasons, cap: defaultBackstop.cap })}`);
      return { explicitPages: explicit.pagesFetched, defaultPages: defaultBackstop.pagesFetched };
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
  ,
  {
    name: 'safeApiFetch: a user cancel is silent, a timeout is still reported',
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        // The app's own cancel sentinel. `fetch` rejects with the
        // AbortController's reason VERBATIM, so this exact object is what the
        // catch block sees — a plain Error whose message says nothing about
        // aborting. Classifying on the message text reported the user's Stop
        // as an `api-fetch-failed` network warning and stamped the source
        // `blocked`, sending the user hunting a provider failure they caused.
        const cancel = nodeCancellationError('user-reset');
        assert(cancel.message === 'Node deleted',
          'the cancel sentinel MESSAGE is a load-bearing IPC/control-flow contract and must not change');
        assert(cancel.name === 'AbortError' && cancel.cancelCause === 'user-reset',
          'the sentinel identifies itself as a cancellation and carries the renderer-supplied cause');

        globalThis.fetch = async () => { throw cancel; };
        const controller = new AbortController();
        controller.abort(cancel);
        const cancelled = await safeApiFetch('https://example.test/api', { signal: controller.signal }, 'linkedin');
        assert(cancelled.ok === false && cancelled.warning === null,
          `a cancelled fetch must publish NO warning, got ${JSON.stringify(cancelled.warning)}`);

        // The mirror-image bug: AbortSignal.timeout rejects with "The operation
        // was aborted due to timeout", which the old /abort/i message test
        // swallowed — so a real timeout produced no warning at all. A timeout is
        // a genuine symptom and must stay reportable.
        const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        globalThis.fetch = async () => { throw timeoutError; };
        const timedOut = await safeApiFetch('https://example.test/api', { signal: AbortSignal.abort() }, 'linkedin');
        assert(timedOut.ok === false && timedOut.warning?.code === 'api-fetch-failed',
          `a timeout must still surface api-fetch-failed, got ${JSON.stringify(timedOut.warning)}`);

        // An ordinary transport failure on a live signal is unchanged.
        globalThis.fetch = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }); };
        const offline = await safeApiFetch('https://example.test/api', { signal: new AbortController().signal }, 'linkedin');
        assert(offline.warning?.code === 'api-fetch-failed' && offline.warning?.severity === 'throttle',
          'a genuine network error is still reported');

        // A cancellation raised without any signal at all is still recognised.
        globalThis.fetch = async () => { throw cancellationError('Manual AI job cancelled', 'manual-ai-cancelled'); };
        const bare = await safeApiFetch('https://example.test/api', {}, 'linkedin');
        assert(bare.warning === null, 'an AbortError-named cancellation is silent even with no signal passed');
        return { cases: 4 };
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  }
];
