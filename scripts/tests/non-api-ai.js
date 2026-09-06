import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { _resetNonApiAiHandoffLifecycle, applyBugReportCode, assert, buildNonApiAiHandoffLifecycleMarkdown, callLLMText, checkPromptFits, fs, generateMarkdown, getNonApiAiHandoffLifecycle, handleSafe, ipcMain, modelForTask, NON_API_AI_TRANSPORT, NON_API_JOB_TASKS, isNonApiJobTask, materializeNonApiPrompt, providerForTask, recordTruncation, registerNonApiAiHandlers, requestNonApiAi, runBoundedJobTaxonomy, runRewindableGroundedHandoff, validateCompensationEvidenceSubmission, validateNonApiAiSubmission, validateRoleFamilyExperienceBandsSubmission } from '../test-dependencies.js';

const JOB_TASKS = [
  'career-file-extract',
  'resume-parse',
  'job-query-generation',
  'job-scoring',
  'job-taxonomy-plan',
  'job-taxonomy-classify',
  'job-compensation-research',
  'job-compensation-assessment',
  'job-preference-interpretation',
  'job-preference-evaluation',
  'job-preference-research',
  'job-preference-research-assessment',
];

export default [
  {
    name: 'non-API AI: job task allowlist is exact and jobs no longer primes Claude',
    run: () => {
      assert(JSON.stringify([...NON_API_JOB_TASKS].sort()) === JSON.stringify([...JOB_TASKS].sort()),
        'the explicit non-API job-task allowlist covers every and only the twelve job-domain LLM tasks, including Job Preferences interpretation and grounded verification');
      assert(JOB_TASKS.every(isNonApiJobTask)
        && !isNonApiJobTask('text-polish')
        && !isNonApiJobTask('vision-product-analysis'),
      'job routing cannot accidentally divert marketplace or workspace AI tasks into the manual handoff');

      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      assert(!/import\s*\{[^}]*\bprimeClaudeModels\b[^}]*\}\s*from\s*['"]\.\/modelResolver\.js['"]/.test(jobsSource)
        && !/\bprimeClaudeModels\s*\(/.test(jobsSource)
        && !/\bgetLLMTextBatchStatus\s*\(/.test(jobsSource)
        && !/\bgetLLMTextBatchResults\s*\(/.test(jobsSource)
        && !/\bcancelLLMTextBatch\s*\(/.test(jobsSource),
      'jobs performs no Claude model priming or legacy Batch API calls once its LLM work is routed to the non-API handoff');
      const llmSource = readFileSync(new URL('../../electron/ipc/llm.js', import.meta.url), 'utf8');
      const preflight = llmSource.slice(
        llmSource.indexOf('export async function checkPromptFits'),
        llmSource.indexOf('async function assertPromptFits'),
      );
      const manualBranch = preflight.indexOf("if (isNonApiJobTask(task))");
      const resolverCall = preflight.indexOf('await ensureClaudeModelsForApiRequest(provider)');
      const selectedModel = preflight.indexOf('const model = pickModel(provider, task, settings)');
      assert(manualBranch >= 0 && resolverCall > manualBranch && selectedModel > resolverCall,
        'manual job preflight returns before any provider resolution, while non-manual Claude preflight resolves before selecting its model');
      const jobSearchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert(jobSearchSource.includes('previous API scoring run was retired')
        && jobSearchSource.includes('getLastJobAnalysisSnapshot')
        && jobSearchSource.includes('runScoringAndSpawn'),
      'a legacy scoring-batch state restarts from the local saved snapshot through the normal Non-API scoring flow');
      const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
      const manualTextStart = llmSource.indexOf("if (isNonApiJobTask(task))", llmSource.indexOf('export async function callLLMText'));
      const manualTextEnd = llmSource.indexOf('\n  const settings = getAISettings();', manualTextStart);
      assert(!/\bprimeClaudeModels\s*\(/.test(mainSource)
        && !llmSource.slice(manualTextStart, manualTextEnd).includes('ensureClaudeModelsForApiRequest')
        && llmSource.includes('async function ensureClaudeModelsForApiRequest(provider)')
        && llmSource.includes('await ensureClaudeModelsForApiRequest(provider);'),
      'startup and every manual job branch stay model-list API-silent, while a later non-job Claude API request lazily resolves current models');
      return { taskCount: NON_API_JOB_TASKS.size };
    },
  },
  {
    name: 'non-API AI: job transport identity and copied prompt are stable across API settings',
    run: () => {
      const geminiSettings = { provider: 'gemini', geminiApiKey: 'gemini-key' };
      const claudeSettings = { provider: 'claude', anthropicApiKey: 'claude-key' };
      for (const task of JOB_TASKS) {
        assert(providerForTask(task, geminiSettings) === NON_API_AI_TRANSPORT
          && providerForTask(task, claudeSettings) === NON_API_AI_TRANSPORT
          && modelForTask(task, geminiSettings) === NON_API_AI_TRANSPORT
          && modelForTask(task, claudeSettings) === NON_API_AI_TRANSPORT,
        `'${task}' is always a non-API handoff regardless of the active API provider setting`);
      }
      const prompt = materializeNonApiPrompt({
        prompt: 'DYNAMIC PAYLOAD', cachedPrefix: 'STATIC RUBRIC', task: 'job-scoring',
        responseSchema: { type: 'object', properties: {} }, maxOutputTokens: 4000, formulaSeed: 4000,
        transport: NON_API_AI_TRANSPORT,
        handoffSettings: { transport: NON_API_AI_TRANSPORT, userContent: { cachedPrefix: 'inlined' } },
      });
      assert(prompt.includes('Transport: non-api-ai (manual copy/paste; no API request, provider selection, or provider fallback)')
        && !/Original API provider setting|Anthropic|Gemini|Vertex|provider fallback model/i.test(prompt),
      'the copied prompt names only the stable manual transport and cannot imply API-provider fallback');
      const llmSource = readFileSync(new URL('../../electron/ipc/llm.js', import.meta.url), 'utf8');
      const configStart = llmSource.indexOf('function manualRequestConfig');
      const configEnd = llmSource.indexOf('\n}\n', configStart) + 3;
      const config = llmSource.slice(configStart, configEnd);
      assert(configStart >= 0 && !config.includes('getAISettings') && !config.includes('providerForTask') && !config.includes('pickModel'),
        'manual handoff configuration derives no routing identity, model, or cap from active API settings');
      return { transport: NON_API_AI_TRANSPORT, tasks: JOB_TASKS.length };
    },
  },
  {
    name: 'non-API AI: renderer handoff preserves request ownership and subscribes before replay',
    run: () => {
      const preloadSource = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      const persistenceSource = readFileSync(new URL('../../src/hooks/useCanvasPersistence.js', import.meta.url), 'utf8');
      const appSource = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
      const mainSource = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
      const transportSource = readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
      assert(preloadSource.includes("cancelNonApiAiRequest: (requestId) => ipcRenderer.invoke('cancel-non-api-ai-request', { requestId })"),
        'the preload bridge exposes only a request-id-bound manual AI cancellation IPC');
      assert(preloadSource.includes("stepBackNonApiAiRequest: (requestId) => ipcRenderer.invoke('step-back-non-api-ai-request', { requestId })")
        && dialogSource.includes('activeRequest.canStepBack')
        && dialogSource.includes('Back one step')
        && dialogSource.includes('initialResponse'),
      'a rewindable follow-up exposes a request-bound Back action and restores the prior accepted paste for editing');
      const jobSearchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const jobBoardSource = readFileSync(new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url), 'utf8');
      assert(dialogSource.includes("new CustomEvent('non-api-ai-node-cancelled'")
        && dialogSource.includes('result.nodeCancelled && activeNodeId')
        && jobSearchSource.includes("document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled)")
        && jobSearchSource.includes('resetHandler();'),
      'cancelling a node-owned manual AI request notifies its Job Search hub to run the same reset path as its in-card cancel control');
      assert(preloadSource.includes("revealNonApiAiAttachment: (requestId, filePath) => ipcRenderer.invoke('reveal-non-api-ai-attachment', { requestId, filePath })")
        && dialogSource.includes('activeRequest.attachments?.length > 0')
        && dialogSource.includes('Show in Finder'),
      'attachments are rendered outside the prompt with a request-bound Finder action');
      assert(preloadSource.includes("replayPendingNonApiAiRequests: () => ipcRenderer.invoke('replay-pending-non-api-ai-requests')"),
        'the preload bridge exposes a sender-owned pending-handoff replay seam');
      const requestListener = dialogSource.indexOf('api.onNonApiAiRequest(receiveRequest)');
      const settledListener = dialogSource.indexOf('api.onNonApiAiSettled(removeRequest)');
      const replay = dialogSource.indexOf('api.replayPendingNonApiAiRequests?.()');
      assert(requestListener >= 0 && settledListener > requestListener && replay > settledListener,
        'both live handoff listeners are installed before the dialog asks main to replay pending prompts');
      assert(dialogSource.includes('window.electronAPI.cancelNonApiAiRequest(requestId)')
        && dialogSource.includes('Cancel task stops the owning job operation.')
        && dialogSource.includes("request.itemCount === 1 ? 'item' : 'items'")
        && dialogSource.includes('const count = Number.isFinite(request.itemCount)')
        && dialogSource.includes('`Batch ${request.batch}${count}`')
        && dialogSource.includes('selectedRequestId')
        && dialogSource.includes('Pending AI handoff batches')
        && dialogSource.includes('requests.find(request => request.requestId === selectedRequestId)')
        && dialogSource.includes('submittingRequestIds.has(activeRequestId)')
        && dialogSource.includes('actionRequestIdsRef.current.has(activeRequestId)'),
      'the handoff UI exposes every pending batch, tracks each request action independently, and binds cancellation to its captured request');
      assert(appSource.lastIndexOf('<NonApiAiDialog />') > appSource.lastIndexOf('</ErrorBoundary>'),
        'the global handoff stays mounted above the canvas error boundary so an external-AI wait can still be cancelled after a renderer error');
      assert(transportSource.includes('NON_API_AI_HANDLER_CHANNELS')
        && transportSource.includes('ipcMain.removeHandler?.(channel)'),
      'manual-AI handlers can be safely re-registered by a controlled development reload without duplicate Electron IPC registrations');
      assert(mainSource.includes('hasPendingNonApiAiRequestsForSender(expectedSender)')
        && mainSource.includes("return { action: 'save' }")
        && mainSource.includes('await flushNonApiAiPersistence()')
        && dialogSource.includes("new CustomEvent('non-api-ai-node-pending'")
        && jobSearchSource.includes('Auto-resuming manual AI run'),
      'a pending handoff auto-saves its canvas restart marker, flushes its draft ledger on close, and auto-resumes after reload');
      const closeCheck = mainSource.slice(mainSource.indexOf('async function checkUnsavedChanges'), mainSource.indexOf('// ── Window creation'));
      assert(closeCheck.indexOf('hasPendingNonApiAiRequestsForSender(expectedSender)')
          < closeCheck.indexOf('if (rendererState.hasUnsavedChanges)')
        && preloadSource.includes('const pendingNonApiAiDraftWrites = new Set()')
        && preloadSource.includes('await Promise.allSettled([...pendingNonApiAiDraftWrites])')
        && persistenceSource.indexOf('await window.electronAPI?.flushNonApiAiPersistence?.()')
          < persistenceSource.indexOf('window.electronAPI.sendQuitResponse(hasUnsavedChangesRef.current)'),
      'pending handoffs force a save independently of the dirty flag, and shutdown waits for every draft write before replying');
      assert(!dialogSource.includes("new CustomEvent('non-api-ai-node-settled'")
        && !jobSearchSource.includes("document.addEventListener('non-api-ai-node-settled'")
        && !jobBoardSource.includes("document.addEventListener('non-api-ai-node-settled'")
        && jobSearchSource.includes('completeManualAiRun(effectiveManualAiRunId)')
        && jobBoardSource.includes('completeManualAiRun(manualAiRunId)'),
      'a prompt settlement no longer clears restart state; only committed workflow completion or cancellation does');
      assert(jobSearchSource.includes("manualAiRecoveryMode: 'append-scored-jobs'")
        && jobSearchSource.includes("resultMode === 'append'")
        && jobSearchSource.includes('recoveryMode: resume.recoveryMode'),
      'background scoring marks append recovery and consumes that mode again after restart');
      return { bridge: 'request-id-bound', replay: 'listener-first', registration: 'idempotent' };
    },
  },
  {
    name: 'non-API AI: materialized prompt retains settings and schema but excludes attachment instructions',
    run: () => {
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string', minLength: 1 } },
      };
      const handoff = materializeNonApiPrompt({
        prompt: 'DYNAMIC JOBS PAYLOAD',
        cachedPrefix: 'STATIC SCORING RUBRIC',
        task: 'job-scoring',
        responseSchema: schema,
        grounding: true,
        maxOutputTokens: 4321,
        formulaSeed: 4000,
        transport: 'non-api-ai',
        handoffSettings: {
          requestKind: 'document',
          transport: 'non-api-ai',
          userContent: { cachedPrefix: null },
          thinking: { type: 'adaptive' },
          format: { type: 'provider-native-format-sentinel' },
          outputConfig: { effort: 'medium' },
          structuredOutput: { exactApplicationContract: 'appended below', nativeProviderSchema: 'outputConfig.format.schema' },
          apiKey: 'must-not-leak',
          nested: { authorization: 'must-not-leak-either', privateKey: 'must-not-leak-private', authToken: 'must-not-leak-token' },
        },
        attachmentPaths: ['/tmp/resume.pdf', '', null],
        requestKind: 'document',
        excludeModels: ['gemini-test'],
        retryOnTruncation: false,
      });
      assert(handoff.indexOf('STATIC SCORING RUBRIC') < handoff.indexOf('DYNAMIC JOBS PAYLOAD')
        && handoff.includes('Task: job-scoring')
        && handoff.includes('Request kind: document')
        && handoff.includes('Maximum output tokens: 4321')
        && handoff.includes('Output-cap formula seed: 4000')
        && handoff.includes('Transport: non-api-ai (manual copy/paste; no API request, provider selection, or provider fallback)')
        && handoff.includes('Grounded/web research: true')
        && handoff.includes('Retry-on-truncation setting: false')
        && handoff.includes('Handoff configuration (non-secret):')
        && handoff.includes('"transport": "non-api-ai"')
        && handoff.includes('"apiKey": "[redacted]"')
        && handoff.includes('"privateKey": "[redacted]"')
        && handoff.includes('"authToken": "[redacted]"')
        && !handoff.includes('Original API provider setting:')
        && !handoff.includes('Excluded API models:')
        && !handoff.includes('"thinking"')
        && !handoff.includes('provider-native-format-sentinel')
        && !handoff.includes('"outputConfig"')
        && !handoff.includes('"structuredOutput"')
        && !handoff.includes('"effort"')
        && !handoff.includes('nativeProviderSchema')
        && !handoff.includes('must-not-leak'),
      'the handoff retains useful request context while omitting model-specific execution controls and secrets');
      assert(!handoff.includes('/tmp/resume.pdf')
        && !handoff.includes('Attachments required:')
        && !handoff.includes('Attach this local file')
        && handoff.includes(JSON.stringify(schema, null, 2))
        && handoff.includes('--- REQUIRED RESPONSE FORMAT ---')
        && handoff.includes('Return only valid JSON matching this schema:')
        && handoff.includes('Do not use Markdown code fences or include commentary outside the JSON.'),
      'attachment instructions stay outside the copyable prompt while the exact structured-output contract remains');
      // Two silent-corruption defences, both from an observed resume-parse
      // handoff. The chat returned ~10 unrequested properties (billed against
      // the stated output cap, which is what truncates a long reply on a
      // transport with no cap-raise retry), and it rendered a bare file name in
      // the JSON as an attachment card - which copies back as an empty string,
      // leaving no trace for any validator to catch.
      assert(handoff.includes('Emit exactly the properties named in the schema, at every nesting level, and nothing else.')
        && handoff.includes('they spend the output budget above')
        && handoff.includes('transferred by copying it as plain text')
        && handoff.includes('no file attachments or file cards')
        && handoff.includes("never write out an attached file's name"),
      'the structured contract forbids both unrequested properties and chat-UI widgets that do not survive a plain-text copy');
      return { chars: handoff.length };
    },
  },
  {
    name: 'non-API AI: JSON-only response rules appear only when the task actually has a response schema',
    run: () => {
      // A free-text handoff has no JSON contract to constrain, so none of the
      // structured rules may leak into it. The plain-text-copy warning rides
      // inside the REQUIRED RESPONSE FORMAT block for that reason: it is worded
      // as a rule about JSON values, not about prose answers.
      const freeText = materializeNonApiPrompt({
        prompt: 'SUMMARIZE THIS',
        task: 'job-compensation-research',
        maxOutputTokens: 2048,
        requestKind: 'text',
      });
      assert(freeText.includes('Expected response format: free text')
        && !freeText.includes('--- REQUIRED RESPONSE FORMAT ---')
        && !freeText.includes('Emit exactly the properties named in the schema')
        && !freeText.includes('no file attachments or file cards'),
      'a schema-less handoff carries no structured-output rules');

      const structured = materializeNonApiPrompt({
        prompt: 'EXTRACT THIS',
        task: 'resume-parse',
        maxOutputTokens: 4096,
        requestKind: 'structured-text',
        responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      });
      assert(structured.includes('Expected response format: JSON')
        && structured.includes('Emit exactly the properties named in the schema')
        && structured.includes('no file attachments or file cards'),
      'a schema-bearing handoff carries both rules');
      return { freeText: freeText.length, structured: structured.length };
    },
  },
  {
    name: 'non-API AI: scoring batches stay stable and a complete taxonomy plan avoids a redundant handoff',
    run: async () => {
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const scoringStart = jobsSource.indexOf('const scoreBatch = async');
      const scoringEnd = jobsSource.indexOf('\n    // Live per-batch scoring progress', scoringStart);
      const scoring = jobsSource.slice(scoringStart, scoringEnd);
      assert(scoring.includes('batch: context.topLevelBatch') && scoring.includes('batchTotal: scoringBatches.length'),
        'every manual scoring attempt, including a split/recovery child, keeps its original top-level batch identity');
      assert(jobsSource.includes('classifier chunk(s)')
        && jobsSource.includes('awaiting the global plan to determine whether classifier work is needed')
        && jobsSource.includes('assigned by the bounded plan — no classifier handoff needed'),
      'taxonomy progress labels 0/0 as classifier work and distinguishes plan-pending from planner-only completion');

      const hints = [];
      let activeClassifications = 0;
      let peakClassifications = 0;
      const taxonomyMeta = {};
      await runBoundedJobTaxonomy(Array.from({ length: 25 }, (_, index) => ({ title: `Role ${index}`, salary: '$100k', careerDirection: 'Engineering' })), {
        meta: taxonomyMeta,
        callText: async (_prompt, options) => {
          if (options.task === 'job-taxonomy-plan') {
            options.meta.model = 'plan-model';
            options.meta.fallback = { stage: 'plan', attempts: 1, counts: { rate_limit: 1 } };
            return {
              salaryRanges: [
                { label: '$150k+/yr', minSalary: 150000, maxSalary: 0 },
                { label: '$100k–$150k/yr', minSalary: 100000, maxSalary: 150000 },
                { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
              ],
              roleFamilies: ['Engineering', 'Other'],
              directionRoleIndexes: [{ direction: 'Engineering', roleIndex: 0 }],
            };
          }
          hints.push(options.hints);
          activeClassifications += 1;
          peakClassifications = Math.max(peakClassifications, activeClassifications);
          options.meta.model = `classifier-${options.hints.batch}`;
          options.meta.fallback = { stage: `classifier-${options.hints.batch}`, attempts: 1, counts: { rate_limit: options.hints.batch } };
          if (options.hints.batch === 1) await new Promise(resolve => setTimeout(resolve, 10));
          activeClassifications -= 1;
          return { roleByIndex: Array.from({ length: options.hints.itemCount }, () => 0) };
        },
      });
      assert(hints.length === 0 && peakClassifications === 0,
        'a complete bounded planner mapping assigns every repeated direction without asking the user for a redundant classification paste');
      assert(JSON.stringify(taxonomyMeta.models) === JSON.stringify(['plan-model'])
        && taxonomyMeta.model === 'plan-model'
        && JSON.stringify(taxonomyMeta.fallbacks?.map(fallback => fallback.stage)) === JSON.stringify(['plan'])
        && taxonomyMeta.fallback?.stage === 'plan',
      'planner-only completion preserves its model diagnostics without fabricating a classifier stage');
      assert(jobsSource.includes('Promise.all(scoringBatches.map(async (batch, batchIndex) =>')
        && jobsSource.includes('completedScoringJobCount')
        && jobsSource.includes('scored: signal?.aborted ? completedScoringJobCount : scoredJobs.length'),
      'scoring starts independent top-level batches together, preserves separate completion progress, and reports completed work on abort without saving partial results');
      return { scoringStable: true, taxonomyBatches: hints.length, peakClassifications };
    },
  },
  {
    name: 'non-API AI: attachment metadata stays outside the prompt and Finder reveal is request-bound',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const attachmentPath = `/tmp/infinite-canvas-non-api-attachment-${process.pid}.md`;
      fs.writeFileSync(attachmentPath, '# Career evidence\n', 'utf8');
      const sent = [];
      const sender = {
        id: 706, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const foreignSender = { ...sender, id: 707 };
      handleSafe('non-api-attachment-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'Extract career evidence.',
          task: 'career-file-extract',
          responseSchema: {
            type: 'object', required: ['text'], properties: { text: { type: 'string' } },
          },
          attachmentPaths: [attachmentPath, attachmentPath, ''],
          requestKind: 'structured-document',
          signal,
        }),
      }));

      try {
        const run = ipcMain.__getInvokeHandler('non-api-attachment-test');
        const pending = run({ sender }, { nodeId: 'node-attachment-test' });
        await new Promise(resolve => setImmediate(resolve));
        const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
        assert(request?.attachments?.length === 1
          && request.attachments[0] === attachmentPath
          && !request.prompt.includes(attachmentPath)
          && !request.prompt.includes('Attachments required:'),
        'the renderer receives one deduplicated attachment path beside, never inside, its copyable prompt');

        const reveal = ipcMain.__getInvokeHandler('reveal-non-api-ai-attachment');
        const revealed = await reveal({ sender }, { requestId: request.requestId, filePath: attachmentPath });
        let foreignRejected = false;
        try {
          await reveal({ sender: foreignSender }, { requestId: request.requestId, filePath: attachmentPath });
        } catch {
          foreignRejected = true;
        }
        assert(revealed?.revealed === true && foreignRejected,
          'Finder reveal accepts only the originating renderer and an attachment on its pending request');

        const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
        await cancel({ sender }, { requestId: request.requestId });
        const result = await pending;
        assert(result.success === false && result.error === 'Manual AI job cancelled',
          'the attachment test handoff settles cleanly after cancellation');
        return { attachments: request.attachments.length, requestBound: true };
      } finally {
        fs.rmSync(attachmentPath, { force: true });
      }
    },
  },
  {
    name: 'non-API AI: structured submission repairs fenced JSON and canonicalizes enums before acceptance',
    run: () => {
      const schema = {
        type: 'object', required: ['condition', 'count'], additionalProperties: false,
        properties: {
          condition: { type: 'string', enum: ['New', 'Used'] },
          count: { type: 'integer', minimum: 1 },
        },
      };
      const value = validateNonApiAiSubmission({
        response: 'Here is the requested result:\n```json\n{ "condition": "new", "count": 2, }\n```',
        responseSchema: schema,
        task: 'job-scoring',
      });
      assert(value.condition === 'New' && value.count === 2,
        'a fenced response with a recoverable trailing comma is parsed and enum casing is normalized to the exact schema value');
      return value;
    },
  },
  {
    name: 'non-API AI: invalid structured retries preserve a field-specific validation error',
    run: () => {
      const schema = {
        type: 'object', required: ['score'], additionalProperties: false,
        properties: { score: { type: 'integer', minimum: 1, maximum: 100 } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({ response: '{"score": 101, "leaked": true}', responseSchema: schema, task: 'job-scoring' });
      } catch (error) { failure = error; }
      assert(failure?.code === 'STRUCTURED_OUTPUT_SCHEMA_INVALID'
        && failure.message.includes("task 'job-scoring'")
        && failure.message.includes('$.score')
        && failure.message.includes('$.leaked'),
      'a rejected paste exposes schema paths for correction without resolving the pending request');
      return { code: failure.code };
    },
  },
  {
    name: 'non-API AI: domain semantic validator can reject schema-valid pasted output for retry',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: { scores: { type: 'array', items: { type: 'object' } } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({
          response: '{"scores":[{"index":7}]}', responseSchema: schema, task: 'job-scoring',
          responseValidator: (value) => {
            if (value.scores[0]?.index !== 0) throw new Error('Score row index must match its requested job index.');
          },
        });
      } catch (error) { failure = error; }
      assert(failure?.message === 'Score row index must match its requested job index.',
        'task-specific invariants run after JSON Schema validation and keep the request pending for a corrected paste');
      return { rejected: true };
    },
  },
  {
    name: 'structured API and manual calls apply the same semantic validator contract',
    run: () => {
      const llmSource = readFileSync(new URL('../../electron/ipc/llm.js', import.meta.url), 'utf8');
      const textSection = llmSource.slice(llmSource.indexOf('export async function callLLMText'), llmSource.indexOf('export async function callLLMRaw'));
      const visionSection = llmSource.slice(llmSource.indexOf('export async function callLLMVision'), llmSource.indexOf('export async function callLLMDocument'));
      const documentSection = llmSource.slice(llmSource.indexOf('export async function callLLMDocument'), llmSource.indexOf('// Back-compat shim'));
      assert(textSection.includes('responseValidator?.(result)')
        && visionSection.includes('responseValidator?.(result)')
        && documentSection.includes('responseValidator?.(result)')
        && documentSection.includes('retryOnTruncation, responseValidator'),
      'structured API replies run the same semantic validator as a manual paste, including the Word-document text fallback');
      return { text: true, vision: true, document: true };
    },
  },
  {
    name: 'non-API AI: compensation extraction cannot settle with missing indexes or invented comparable provenance',
    run: () => {
      let coverageFailure = null;
      try {
        validateCompensationEvidenceSubmission([
          { index: 0, comparableRanges: [], justification: '', sourceLinks: [] },
        ], ['USD', 'USD'], 'https://salary.example.test/source');
      } catch (error) { coverageFailure = error; }
      assert(coverageFailure?.message.includes('received 1/2 rows') && coverageFailure.message.includes('missing indexes: 1'),
        'a schema-valid compensation response must still cover every requested offer index exactly once');

      let provenanceFailure = null;
      try {
        validateCompensationEvidenceSubmission([
          {
            index: 0,
            comparableRanges: [{ min: 100000, max: 120000, currency: 'USD', comparable: true, sourceName: 'Invented', sourceUrl: 'https://invented.example.test/range' }],
            justification: '', sourceLinks: [],
          },
        ], ['USD'], 'https://salary.example.test/source');
      } catch (error) { provenanceFailure = error; }
      assert(provenanceFailure?.message.includes('assessment index 0') && provenanceFailure.message.includes('grounded research'),
        'a pasted comparable range must carry a usable source URL actually present in the preceding research');
      return { coverage: true, provenance: true };
    },
  },
  {
    name: 'non-API AI: experience-band extraction retries partial ladders but accepts an honest no-evidence result',
    run: () => {
      let malformed = null;
      try {
        validateRoleFamilyExperienceBandsSubmission({
          bands: [{ label: 'Early', minYears: 0, maxYears: 2 }],
          sources: [{ name: 'Career framework', url: 'https://career.example.test/framework' }],
        }, 'Software Engineering', 'https://different.example.test/source');
      } catch (error) { malformed = error; }
      assert(malformed?.message.includes('Invalid experience-band response'),
        'a partially grounded ladder remains in the handoff rather than silently failing the compensation cohort');
      const unavailable = validateRoleFamilyExperienceBandsSubmission({ bands: [], sources: [] }, 'Software Engineering', '');
      assert(unavailable.available === false,
        'an explicitly empty answer remains an honest no-evidence outcome, not an impossible regeneration loop');
      return { malformedRejected: true, emptyAccepted: true };
    },
  },
  {
    name: 'non-API AI: raw response remains verbatim and blank response is rejected',
    run: () => {
      const raw = 'Research result with useful prose.\n\nhttps://example.test/source';
      assert(validateNonApiAiSubmission({ response: raw, task: 'job-compensation-research' }) === raw,
        'free-text/grounded responses are returned unchanged rather than forced through JSON parsing');
      let failure = null;
      try { validateNonApiAiSubmission({ response: '  ', task: 'job-compensation-research' }); }
      catch (error) { failure = error; }
      assert(failure?.message === 'Paste a non-empty AI response before submitting.',
        'empty submissions are rejected before a manual request can settle');
      return { rawChars: raw.length };
    },
  },
  {
    name: 'non-API AI: implausible-paste gate catches a non-JSON clipboard mistake before schema validation',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: { scores: { type: 'array', items: { type: 'object' } } },
      };
      let failure = null;
      try {
        validateNonApiAiSubmission({
          response: 'Sorry, I no longer have access to that conversation.',
          responseSchema: schema, task: 'job-scoring',
        });
      } catch (error) { failure = error; }
      assert(failure?.message.includes("task 'job-scoring'")
        && failure.message.includes("no '{' or '['")
        && failure.message.includes('wrong clipboard content')
        && failure.message.includes("FULL response")
        && !failure.message.includes('missing required property'),
      'a paste with no JSON delimiters at all is rejected with an actionable clipboard hint instead of the misleading schema-shape complaint');
      return { rejected: true };
    },
  },
  {
    name: 'non-API AI: implausible-paste gate never rejects a genuinely valid response',
    run: () => {
      const schema = {
        type: 'object', required: ['scores'], additionalProperties: false,
        properties: {
          scores: {
            type: 'array',
            items: {
              type: 'object', required: ['index', 'matchScore'], additionalProperties: false,
              properties: { index: { type: 'integer' }, matchScore: { type: 'integer' } },
            },
          },
        },
      };
      const scores = Array.from({ length: 11 }, (_, index) => ({ index, matchScore: 50 + index }));
      const response = JSON.stringify({ scores });
      const value = validateNonApiAiSubmission({ response, responseSchema: schema, task: 'job-scoring' });
      assert(Array.isArray(value.scores) && value.scores.length === 11,
        'a real, fully-populated response clears the delimiter gate and reaches the caller unchanged');
      return { accepted: true, length: response.length };
    },
  },
  {
    name: 'non-API AI: no item-count length heuristic is applied — a short but schema-valid response is always accepted',
    run: () => {
      // itemCount describes the REQUEST, not a promise about the response's
      // shape: an aggregate answer, or a task that legitimately returns few
      // or no rows for many inputs, is short and still fully valid. The gate
      // therefore applies no length floor at all — only the '{'/'[' delimiter
      // check above runs. Prove it with a deliberately sparse reply (one
      // bare integer) against a much larger requested item count; a
      // length-vs-itemCount heuristic would have rejected this.
      const schema = {
        type: 'object', required: ['roleByIndex'], additionalProperties: false,
        properties: { roleByIndex: { type: 'array', items: { type: 'integer', minimum: 0 } } },
      };
      const response = '{"roleByIndex":[0]}';
      const value = validateNonApiAiSubmission({
        response, responseSchema: schema, task: 'job-taxonomy-classify', itemCount: 24,
      });
      assert(Array.isArray(value.roleByIndex) && value.roleByIndex.length === 1,
        'a short response that fully satisfies its schema is accepted no matter how much larger the unrelated itemCount hint is');
      return { accepted: true, length: response.length };
    },
  },
  {
    name: 'non-API AI: job prompt preflight is manual and never invokes a provider token counter',
    run: async () => {
      const fit = await checkPromptFits('x'.repeat(250_000), {
        task: 'job-scoring',
        cachedPrefix: 'STATIC PREFIX',
        responseSchema: { type: 'object', properties: {} },
        hints: { itemCount: 5 },
      });
      assert(fit.fits === true && fit.provider === 'non-api-ai' && fit.model === 'non-api-ai'
        && fit.via === 'manual' && fit.contextWindow === Number.MAX_SAFE_INTEGER,
      'job preflight returns the local manual transport contract without resolving credentials or contacting a token-count endpoint');
      return { via: fit.via, tokens: fit.tokens };
    },
  },
  {
    name: 'non-API AI: manual scoring guidance ignores stale learned provider truncation floors',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      // Mirrors the report's historical 40K provider truncation. It must
      // remain relevant to an actual API call, but never inflate a manual
      // copy/paste instruction after the compact scoring contract ships.
      recordTruncation('job-scoring', 40_000, 32_000);
      const sent = [];
      const sender = {
        id: 708, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-manual-cap-test', async (_event, _args, signal) => ({
        result: await callLLMText('RETURN COMPACT JSON.', {
          signal,
          task: 'job-scoring',
          hints: { itemCount: 15 },
          responseSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-manual-cap-test')({ sender }, { nodeId: 'manual-cap-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request?.itemCount === 15
        && request?.prompt.includes('Maximum output tokens: 10600')
        && request.prompt.includes('Output-cap formula seed: 10600')
        && !request.prompt.includes('Maximum output tokens: 48000'),
      'manual job scoring exposes its 15-item workload and uses the bounded formula, never stale API self-calibration telemetry');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      const reportSource = readFileSync(new URL('../../electron/ipc/bugReport.js', import.meta.url), 'utf8');
      assert(reportSource.includes('historical provider telemetry only')
        && reportSource.includes('manual copy/paste guidance uses the bounded task seed'),
      'bug reports distinguish historical API token telemetry from active manual-handoff guidance');
      return { manualCap: 10600, staleApiFloor: 48000 };
    },
  },
  {
    name: 'non-API AI: Back one step replaces accepted research with the corrected paste',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 709, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-step-back-test', async (_event, _args, signal) => {
        const pair = await runRewindableGroundedHandoff({
          research: ({ initialResponse }) => requestNonApiAi({
            prompt: 'RESEARCH STEP',
            task: 'job-compensation-research',
            initialResponse,
            signal,
          }),
          extract: (research, manualHandoff) => requestNonApiAi({
            prompt: `EXTRACTION STEP\n${research}`,
            task: 'job-compensation-assessment',
            responseSchema: {
              type: 'object', required: ['answer'], properties: { answer: { type: 'string' } },
            },
            ...manualHandoff,
            signal,
          }),
        });
        return { research: pair.groundedResearch, answer: pair.result.answer };
      });

      const run = ipcMain.__getInvokeHandler('non-api-step-back-test')({ sender }, { nodeId: 'node-step-back-test' });
      await new Promise(resolve => setImmediate(resolve));
      const requests = () => sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const stepBackRequest = ipcMain.__getInvokeHandler('step-back-non-api-ai-request');
      const firstResearch = requests()[0];
      assert(firstResearch?.prompt.includes('RESEARCH STEP') && firstResearch.canStepBack === false,
        'the first handoff has no imaginary predecessor');
      const unavailable = await stepBackRequest({ sender }, { requestId: firstResearch.requestId });
      assert(unavailable.steppedBack === false,
        'the main process rejects Back when the active handoff has no real preceding step');
      await submit({ sender }, { requestId: firstResearch.requestId, response: 'WRONG RESEARCH' });
      await new Promise(resolve => setImmediate(resolve));

      const firstExtraction = requests()[1];
      assert(firstExtraction?.canStepBack === true
        && firstExtraction.stepBackLabel === 'Back to research'
        && firstExtraction.prompt.includes('WRONG RESEARCH'),
      'the extraction gate identifies its real preceding research handoff');
      const foreign = await stepBackRequest({ sender: { ...sender, id: 710 } }, { requestId: firstExtraction.requestId });
      assert(foreign.steppedBack === false,
        'a different renderer cannot rewind a sensitive pending handoff');
      const steppedBack = await stepBackRequest({ sender }, { requestId: firstExtraction.requestId });
      await new Promise(resolve => setImmediate(resolve));

      const replacementResearch = requests()[2];
      assert(steppedBack.steppedBack === true
        && replacementResearch?.prompt.includes('RESEARCH STEP')
        && replacementResearch.initialResponse === 'WRONG RESEARCH',
      'Back reissues the previous prompt with the accepted paste restored as an editable draft');
      await submit({ sender }, { requestId: replacementResearch.requestId, response: 'CORRECT RESEARCH' });
      await new Promise(resolve => setImmediate(resolve));

      const replacementExtraction = requests()[3];
      assert(replacementExtraction?.prompt.includes('CORRECT RESEARCH')
        && !replacementExtraction.prompt.includes('WRONG RESEARCH'),
      'the downstream prompt is rebuilt from the corrected response, not the already-resolved wrong value');
      await submit({ sender }, { requestId: replacementExtraction.requestId, response: '{"answer":"accepted"}' });
      const result = await run;
      assert(result.success === true && result.research === 'CORRECT RESEARCH' && result.answer === 'accepted',
        'the owning operation continues and returns only the corrected research result');
      return { rewound: true, corrected: true };
    },
  },
  {
    name: 'non-API AI: dialog cancellation is sender-owned and aborts the whole node task',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const senderA = {
        id: 701, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const senderB = { ...senderA, id: 702, send: () => {} };
      handleSafe('non-api-cancel-node-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-cancel-node-test')({ sender: senderA }, { nodeId: 'node-cancel-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request?.requestId && request.nodeId === 'node-cancel-test', 'the handoff retains node ownership for cancellation');
      const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
      const foreign = await cancel({ sender: senderB }, { requestId: request.requestId });
      assert(foreign.cancelled === false, 'a different renderer cannot cancel a sensitive pending request');
      const own = await cancel({ sender: senderA }, { requestId: request.requestId });
      const settled = await run;
      assert(own.cancelled === true && own.nodeCancelled === true
        && settled.success === false && settled.error === 'Manual AI job cancelled'
        && sent.some(item => item.channel === 'non-api-ai-settled' && item.payload?.cancelled),
      'the owner cancellation aborts the registered node task, rejects the handoff, and emits settlement instead of allowing retries');
      return { nodeCancelled: own.nodeCancelled };
    },
  },
  {
    name: 'non-API AI: dialog cancellation falls back to only the pending request without a node',
    run: async () => {
      const sent = [];
      const sender = {
        id: 703, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-cancel-request-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-cancel-request-test')({ sender }, {});
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const result = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      const settled = await run;
      assert(result.cancelled === true && result.nodeCancelled === false
        && settled.success === false && settled.error === 'Manual AI job cancelled',
      'a request without node ownership still settles and rejects cleanly without touching unrelated work');
      return { nodeCancelled: result.nodeCancelled };
    },
  },
  {
    name: 'non-API AI: a remounted dialog replays only its pending prompts in creation order',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const senderA = {
        id: 704, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const senderB = { ...senderA, id: 705, send: (channel, payload) => sent.push({ channel, payload, sender: 'B' }) };
      handleSafe('non-api-replay-test', async (_event, args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
          hints: { batch: args.batch, batchTotal: args.batchTotal },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-replay-test');
      const first = run({ sender: senderA }, { nodeId: 'node-replay-first', batch: 1, batchTotal: 2 });
      const second = run({ sender: senderA }, { nodeId: 'node-replay-second', batch: 2, batchTotal: 2 });
      await new Promise(resolve => setImmediate(resolve));
      const initial = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(initial.length === 2, 'both initial handoff events are emitted before the simulated renderer reload');
      const handoffPrompt = initial[0]?.prompt || '';
      assert(handoffPrompt.includes('STATIC CACHED RUBRIC')
        && handoffPrompt.includes('Handoff configuration (non-secret):')
        && handoffPrompt.includes('"transport":')
        && handoffPrompt.includes('"cachedPrefix":')
        && handoffPrompt.includes('--- REQUIRED RESPONSE FORMAT ---')
        && !handoffPrompt.includes('Original API model setting:')
        && !handoffPrompt.includes('"thinking":')
        && !handoffPrompt.includes('"thinkingConfig":')
        && !handoffPrompt.includes('"effort":')
        && !handoffPrompt.includes('"outputConfig":')
        && !handoffPrompt.includes('"generationConfig":')
        && !handoffPrompt.includes('"modelFallbackPolicy":'),
      'live manual routing keeps provider-independent response requirements while omitting model execution controls');
      // Simulate a same-frame dialog/listener remount having missed its initial
      // events. Its newly-mounted listener calls the sender-owned replay IPC.
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const rejected = await submit({ sender: senderA }, { requestId: initial[0].requestId, response: '{}' });
      assert(rejected.accepted === false,
        'the first pending request remains open after an invalid response before the simulated dialog remount');
      sent.length = 0;
      const replay = ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests');
      const foreign = await replay({ sender: senderB });
      assert(foreign.count === 0 && sent.length === 0,
        'another renderer cannot replay a different window\'s sensitive prompt');
      const own = await replay({ sender: senderA });
      const replayed = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(own.count === 2
        && replayed.length === 2
        && replayed[0].requestId === initial[0].requestId
        && replayed[1].requestId === initial[1].requestId
        && replayed[0].batch === 1 && replayed[0].batchTotal === 2
        && replayed[1].batch === 2 && replayed[1].batchTotal === 2
        && typeof replayed[0].validationError === 'string' && replayed[0].validationError.includes('is missing required property')
        && replayed.every(item => item.nodeId === 'node-replay-first' || item.nodeId === 'node-replay-second'),
      'the reconnected renderer receives exactly its pending prompts in original creation order, including retry guidance');
      const cancel = ipcMain.__getInvokeHandler('cancel-non-api-ai-request');
      await cancel({ sender: senderA }, { requestId: replayed[0].requestId });
      await cancel({ sender: senderA }, { requestId: replayed[1].requestId });
      const results = await Promise.all([first, second]);
      assert(results.every(result => result.success === false && result.error === 'Manual AI job cancelled'),
        'replayed test requests settle cleanly when their owner cancels them');
      return { replayed: own.count };
    },
  },
  {
    name: 'non-API AI: accepted steps and the active draft resume under the same workflow id',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-resume-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-durable-resume-test', async (_event, _args, signal) => {
        const first = await requestNonApiAi({ prompt: 'DURABLE STEP ONE', task: 'job-scoring', responseSchema: schema, signal });
        const second = await requestNonApiAi({ prompt: `DURABLE STEP TWO\n${first.answer}`, task: 'job-scoring', responseSchema: schema, signal });
        return { first: first.answer, second: second.answer };
      });

      const firstSent = [];
      const firstSender = new EventEmitter();
      firstSender.id = 801;
      firstSender.isDestroyed = () => false;
      firstSender.send = (channel, payload) => firstSent.push({ channel, payload });
      const waitForRequestCount = async (sent, count) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request');
          if (requests.length >= count) return requests;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request');
      };
      const invoke = ipcMain.__getInvokeHandler('non-api-durable-resume-test');
      const firstRun = invoke({ sender: firstSender }, { nodeId: 'durable-node', manualAiRunId: runId });
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const firstRequest = (await waitForRequestCount(firstSent, 1))[0]?.payload;
      await submit({ sender: firstSender }, { requestId: firstRequest.requestId, response: '{"answer":"first accepted"}' });
      const secondRequest = (await waitForRequestCount(firstSent, 2))[1]?.payload;
      assert(secondRequest?.runId === runId && secondRequest?.stepKey,
        'durable requests expose their workflow and deterministic step identity to the renderer');
      await ipcMain.__getInvokeHandler('update-non-api-ai-draft')(
        { sender: firstSender },
        { requestId: secondRequest.requestId, response: '{"answer":"draft survives"}' },
      );
      firstSender.emit('did-start-navigation', {}, 'file:///restart.html', false, true);
      const interrupted = await firstRun;
      assert(interrupted.success === false && interrupted.error === 'Renderer navigated',
        'the original process-local continuation is allowed to terminate after its checkpoint is durable');

      const resumedSent = [];
      const resumedSender = new EventEmitter();
      resumedSender.id = 802;
      resumedSender.isDestroyed = () => false;
      resumedSender.send = (channel, payload) => resumedSent.push({ channel, payload });
      const resumedRun = invoke({ sender: resumedSender }, { nodeId: 'durable-node', manualAiRunId: runId });
      const resumedRequests = (await waitForRequestCount(resumedSent, 1)).map(item => item.payload);
      assert(resumedRequests.length === 1
        && resumedRequests[0].prompt.includes('DURABLE STEP TWO')
        && resumedRequests[0].initialResponse === '{"answer":"draft survives"}',
      'restart replays the accepted first step silently and restores the exact unfinished-step draft');
      await submit({ sender: resumedSender }, { requestId: resumedRequests[0].requestId, response: '{"answer":"second accepted"}' });
      const completed = await resumedRun;
      assert(completed.success === true
        && completed.first === 'first accepted'
        && completed.second === 'second accepted',
      'the restarted workflow continues from the checkpoint and completes with both accepted values');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: resumedSender }, { runId });
      return { resumedAt: 'step-two', draftRestored: true };
    },
  },
  {
    name: 'non-API AI: identical document prompts keep attachment-specific durable steps',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `durable-attachments-${process.pid}-${Date.now()}`;
      const schema = {
        type: 'object', required: ['answer'], additionalProperties: false,
        properties: { answer: { type: 'string' } },
      };
      handleSafe('non-api-durable-attachment-test', async (_event, _args, signal) => {
        const first = await requestNonApiAi({
          prompt: 'IDENTICAL DOCUMENT EXTRACTION PROMPT', task: 'career-file-extract',
          responseSchema: schema, attachmentPaths: ['/tmp/career-file-one.pdf'], signal,
        });
        const second = await requestNonApiAi({
          prompt: 'IDENTICAL DOCUMENT EXTRACTION PROMPT', task: 'career-file-extract',
          responseSchema: schema, attachmentPaths: ['/tmp/career-file-two.pdf'], signal,
        });
        return { first: first.answer, second: second.answer };
      });

      const sent = [];
      const sender = new EventEmitter();
      sender.id = 803;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const waitForRequests = async (count) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requests = sent.filter(item => item.channel === 'non-api-ai-request');
          if (requests.length >= count) return requests.map(item => item.payload);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      };

      const invoke = ipcMain.__getInvokeHandler('non-api-durable-attachment-test');
      const pending = invoke({ sender }, {
        nodeId: 'durable-attachment-node', runId, manualAiRunId: runId,
        manualAiRecoveryMode: 'append-scored-jobs',
      });
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const firstRequest = (await waitForRequests(1))[0];
      await submit({ sender }, { requestId: firstRequest.requestId, response: '{"answer":"file one"}' });
      const requests = await waitForRequests(2);
      assert(requests.length === 2
        && requests[0].stepKey !== requests[1].stepKey
        && requests[0].attachments[0] !== requests[1].attachments[0]
        && requests[1].recoveryMode === 'append-scored-jobs',
      'same-prompt document handoffs have distinct opaque identities and retain their workflow recovery mode');
      await submit({ sender }, { requestId: requests[1].requestId, response: '{"answer":"file two"}' });
      const completed = await pending;
      assert(completed.success === true && completed.first === 'file one' && completed.second === 'file two',
        'the second attachment receives its own response instead of silently replaying the first file response');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      return { attachmentSteps: requests.length, distinct: true };
    },
  },
  {
    name: 'non-API AI: bug-report lifecycle is bounded, redacted, and proves reject/replay/accept settlement',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      _resetNonApiAiHandoffLifecycle();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 721, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-lifecycle-report-test', async (_event, _args, signal) => ({
        result: await requestNonApiAi({
          prompt: 'TOP_SECRET_PROMPT must never be reported',
          task: 'job-taxonomy-classify',
          responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
          batch: 2, batchTotal: 3, itemCount: 24,
          attemptKind: 'partial-recovery', rootBatchSize: 24, signal,
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-lifecycle-report-test')({ sender }, { nodeId: 'handoff-report-node' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const rejected = await submit({ sender }, { requestId: request.requestId, response: '{}' });
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
      const accepted = await submit({ sender }, { requestId: request.requestId, response: '{"result":"TOP_SECRET_RESPONSE"}' });
      await run;
      const lifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const receipt = lifecycle.find(item => item.requestId === request.requestId.slice(0, 12));
      const markdown = buildNonApiAiHandoffLifecycleMarkdown(new Set(['handoff-report-node']), sender.id);
      const focused = applyBugReportCode([
        '[Jobs] Taxonomy classifying: 1/1 chunk(s)',
        '[Non-API AI] Rejected response for task job-taxonomy-classify',
        'viewport changed source=interaction',
      ], {}, 'JOBHANDOFF');
      assert(request.attemptKind === 'partial-recovery' && request.rootBatchSize === 24
        && rejected.accepted === false && replay.count === 1 && accepted.accepted === true
        && receipt?.deliveries === 3 && receipt?.rejected === 1 && receipt?.reissues === 1
        && receipt?.attemptKind === 'partial-recovery' && receipt?.rootBatchSize === 24
        && receipt?.replays === 1 && receipt?.outcome === 'accepted' && receipt?.acceptedAt && receipt?.settledAt,
      'the lifecycle records initial delivery, validation rejection/reissue, remount replay, acceptance, and final settlement');
      assert(markdown.includes('Non-API AI Handoff Lifecycle')
        && markdown.includes('1 paste rejection(s)')
        && markdown.includes('1 reissued')
        && markdown.includes('1 replayed after dialog remount')
        && markdown.includes('**partial-row recovery** from 24-item root batch')
        && markdown.includes('**accepted** in')
        && !markdown.includes('TOP_SECRET_PROMPT')
        && !markdown.includes('TOP_SECRET_RESPONSE')
        && !markdown.includes('is missing required property'),
      'the report receipt exposes only bounded lifecycle metadata, never prompt, response, or validator text');
      assert(focused.matchedCodes.includes('JOBHANDOFF')
        && focused.filteredLogs.some(line => line.includes('Rejected response'))
        && focused.sectionExclusions.has('nodeInternals')
        && focused.sectionExclusions.has('nodes'),
      'JOBHANDOFF is a focused filter that keeps handoff evidence while dropping the heavy canvas payload');

      const taxonomyFilter = applyBugReportCode([], {}, 'TAXONOMY');
      const taxonomyReport = generateMarkdown({
        description: 'The taxonomy response appeared to be stuck.',
        filterCode: 'TAXONOMY',
        filterStats: {
          eventsShown: 0,
          eventsTotal: 0,
          omittedSections: [...taxonomyFilter.sectionExclusions],
          hasJobNodes: true,
          hasSellNodes: false,
          currentNodeIds: ['handoff-report-node'],
        },
        // Deliberately retain a sentinel despite the filter's exclusions: the
        // formatter must obey the exclusion metadata, just as it does after the
        // renderer removes the heavy node payload before IPC.
        nodes: [{ id: 'taxonomy-heavy-node-must-not-render', type: 'jobcard', data: { title: 'TOP_SECRET_NODE' } }],
        edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [],
        frontEndState: {}, eventLogs: [],
      }, sender.id).markdown;
      assert(taxonomyReport.includes('## Non-API AI Handoff Lifecycle')
        && taxonomyReport.includes('job-taxonomy-classify')
        && taxonomyReport.includes('**accepted** in')
        && !taxonomyReport.includes('TOP_SECRET_PROMPT')
        && !taxonomyReport.includes('TOP_SECRET_RESPONSE')
        && !taxonomyReport.includes('TOP_SECRET_NODE'),
      'TAXONOMY retains its redacted manual taxonomy-handoff receipt while honoring heavy-node exclusions');
      return { deliveries: receipt.deliveries, replays: receipt.replays, filter: 'JOBHANDOFF+TAXONOMY' };
    },
  },
  {
    name: 'non-API AI: main-frame navigation aborts its orphaned handoff instead of leaking it across reload',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 706;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      handleSafe('non-api-navigation-abort-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-navigation-abort-test')({ sender }, { nodeId: 'node-navigation-abort' });
      await new Promise(resolve => setImmediate(resolve));
      assert(sent.some(item => item.channel === 'non-api-ai-request'),
        'the handoff is pending before the renderer navigation begins');
      sender.emit('did-start-navigation', {}, 'file:///canvas/index.html', false, true);
      const result = await run;
      assert(result.success === false && result.error === 'Renderer navigated'
        && sent.some(item => item.channel === 'non-api-ai-settled' && item.payload?.cancelled),
      'a real main-frame reload aborts the old invoke and settles its handoff instead of retaining an unreachable promise');
      return { error: result.error };
    },
  },
  {
    name: 'non-API AI: a sender closing during delivery settles instead of leaking a pending request',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sender = {
        id: 707, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: () => { throw new Error('WebContents is closing'); },
      };
      handleSafe('non-api-delivery-race-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const result = await ipcMain.__getInvokeHandler('non-api-delivery-race-test')({ sender }, { nodeId: 'node-delivery-race' });
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
      assert(result.success === false && result.error.includes('Originating window closed before the Non-API AI request could be shown.')
        && replay.count === 0,
      'a `.send()` close race removes the request and rejects its owning handler rather than retaining an unreachable handoff');
      return { replayed: replay.count };
    },
  },
  {
    name: 'non-API AI: a failed validation-retry delivery also settles its unreachable handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      let failDelivery = false;
      const sender = {
        id: 708, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => {
          if (failDelivery) throw new Error('WebContents is closing');
          sent.push({ channel, payload });
        },
      };
      handleSafe('non-api-retry-delivery-race-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-retry-delivery-race-test')({ sender }, { nodeId: 'node-retry-delivery-race' });
      await new Promise(resolve => setImmediate(resolve));
      const requestId = sent.find(item => item.channel === 'non-api-ai-request')?.payload?.requestId;
      failDelivery = true;
      const submit = await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender }, { requestId, response: '{}' });
      const result = await run;
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')?.({ sender });
      assert(submit.accepted === false
        && result.success === false && result.error.includes('Originating window closed before the Non-API AI request could be shown.')
        && replay?.count === 0,
      'a correction re-emit that loses its renderer tears down the same request instead of retaining it forever');
      return { replayed: replay.count };
    },
  },
  {
    name: 'non-API AI: the manual handoff queue is ordered by batch, not by arrival',
    run: () => {
      // A 1-job scoring batch used to reach the renderer FIRST. scoreBatch's
      // only pre-handoff await (checkPromptFits) was gated on `batch.length > 1`,
      // and requestNonApiAi sends its IPC synchronously — so inside the single
      // Promise.all dispatch pass the singleton skipped a microtask turn and
      // jumped the queue. 61 jobs at 15/batch presented as 5, 1, 2, 3, 4.
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const scoreBatchBody = jobsSource.slice(
        jobsSource.indexOf('const scoreBatch = async (batch, context = {}) => {'),
        jobsSource.indexOf('const batchMeta = {};'),
      );
      assert(scoreBatchBody.length > 0
        && /\n\s*let fit = null;\n\s*try \{\n\s*fit = await checkPromptFits\(/.test(scoreBatchBody)
        && !/if \(batch\.length > 1\) \{[\s\S]*await checkPromptFits\(/.test(scoreBatchBody),
      'the context-window preflight await runs for EVERY batch size, so no batch can skip a microtask turn and issue its handoff early');
      assert(/if \(fit && !fit\.fits && batch\.length > 1\) \{/.test(scoreBatchBody),
        'the SPLIT stays guarded on batch.length > 1 — at length 1 mid is 1, the right half is empty, and scoreBatch would recurse forever');
      assert(jobsSource.includes('Promise.all(scoringBatches.map(async (batch, batchIndex) =>'),
        'top-level batches still dispatch together so the person can run every manual prompt in parallel');

      // Renderer-side belt and braces: arrival order is not a contract, so the
      // queue sorts itself rather than trusting main to emit in order.
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(!dialogSource.includes('if (index === -1) return [...previous, incoming];')
        && dialogSource.includes('next.splice(at, 0, incoming);')
        && dialogSource.includes('&& queued.batch > incoming.batch'),
      'receiveRequest inserts a new handoff by batch number instead of appending it in arrival order');

      // Behavioural check of that insert, including the cases it must NOT reorder.
      const insert = (previous, incoming) => {
        const index = previous.findIndex(request => request.requestId === incoming.requestId);
        if (index >= 0) {
          const updated = [...previous];
          updated[index] = { ...updated[index], ...incoming };
          return updated;
        }
        const next = [...previous];
        let at = next.length;
        for (let i = 0; i < next.length; i += 1) {
          const queued = next[i];
          if (queued.nodeId === incoming.nodeId
            && queued.task === incoming.task
            && Number.isFinite(queued.batch)
            && Number.isFinite(incoming.batch)
            && queued.batch > incoming.batch) { at = i; break; }
        }
        next.splice(at, 0, incoming);
        return next;
      };
      const scoringRequest = (batch) => ({ requestId: `r${batch}`, nodeId: 'hub', task: 'job-scoring', batch });
      const order = (arrival) => arrival.reduce((queue, request) => insert(queue, request), []).map(r => r.batch).join(',');
      assert(order([5, 1, 2, 3, 4].map(scoringRequest)) === '1,2,3,4,5'
        && order([1, 2, 3, 4, 5].map(scoringRequest)) === '1,2,3,4,5'
        && order([3, 5, 1, 4, 2].map(scoringRequest)) === '1,2,3,4,5',
      'any arrival order of one hub’s scoring batches presents ascending, so the chip strip matches the prompt numbering');

      const settled = [1, 2, 3].map(scoringRequest).reduce((queue, request) => insert(queue, request), []);
      assert(insert(settled, { ...scoringRequest(1), validationError: 'retry' }).map(r => r.batch).join(',') === '1,2,3',
        'a validation re-emit updates its request in place and never moves the chip the person is answering');

      const mixed = [
        scoringRequest(2),
        { requestId: 'taxonomy', nodeId: 'hub', task: 'job-taxonomy-plan' },
        scoringRequest(1),
        { requestId: 'other-hub', nodeId: 'other', task: 'job-scoring', batch: 1 },
      ].reduce((queue, request) => insert(queue, request), []);
      assert(mixed.map(r => r.requestId).join(',') === 'r1,r2,taxonomy,other-hub',
        'ordering is scoped to one node+task: unnumbered handoffs and other hubs keep arrival order instead of being interleaved');
      return { ordering: 'batch-ascending', scope: 'node+task' };
    },
  },
];
