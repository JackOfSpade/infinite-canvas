import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { assert, callLLMText, checkPromptFits, fs, handleSafe, ipcMain, modelForTask, NON_API_AI_TRANSPORT, NON_API_JOB_TASKS, isNonApiJobTask, materializeNonApiPrompt, providerForTask, registerNonApiAiHandlers, requestNonApiAi, runBoundedJobTaxonomy, validateCompensationEvidenceSubmission, validateNonApiAiSubmission, validateRoleFamilyExperienceBandsSubmission } from '../test-dependencies.js';

const JOB_TASKS = [
  'career-file-extract',
  'resume-parse',
  'job-query-generation',
  'job-scoring',
  'job-taxonomy-plan',
  'job-taxonomy-classify',
  'job-compensation-research',
  'job-compensation-assessment',
];

export default [
  {
    name: 'non-API AI: job task allowlist is exact and jobs no longer primes Claude',
    run: () => {
      assert(JSON.stringify([...NON_API_JOB_TASKS].sort()) === JSON.stringify([...JOB_TASKS].sort()),
        'the explicit non-API job-task allowlist covers every and only the eight job-domain LLM tasks');
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
      const appSource = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
      const transportSource = readFileSync(new URL('../../electron/ipc/nonApiAi.js', import.meta.url), 'utf8');
      assert(preloadSource.includes("cancelNonApiAiRequest: (requestId) => ipcRenderer.invoke('cancel-non-api-ai-request', { requestId })"),
        'the preload bridge exposes only a request-id-bound manual AI cancellation IPC');
      const jobSearchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
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
      return { chars: handoff.length };
    },
  },
  {
    name: 'non-API AI: scoring and taxonomy classify handoffs retain stable 1-based batch progress',
    run: async () => {
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const scoringStart = jobsSource.indexOf('const scoreBatch = async');
      const scoringEnd = jobsSource.indexOf('\n    // Live per-batch scoring progress', scoringStart);
      const scoring = jobsSource.slice(scoringStart, scoringEnd);
      assert(scoring.includes('batch: context.topLevelBatch') && scoring.includes('batchTotal: scoringBatches.length'),
        'every manual scoring attempt, including a split/recovery child, keeps its original top-level batch identity');

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
      assert(JSON.stringify(hints.map(hint => [hint.batch, hint.batchTotal, hint.itemCount])) === JSON.stringify([[1, 2, 24], [2, 2, 1]]),
        'taxonomy classification publishes a positive 1-based batch and fixed total for every manual prompt');
      assert(peakClassifications === 2,
        'taxonomy classification starts independent manual batches together so every prompt is available before the first response returns');
      assert(JSON.stringify(taxonomyMeta.models) === JSON.stringify(['plan-model', 'classifier-1', 'classifier-2'])
        && taxonomyMeta.model === 'classifier-2'
        && JSON.stringify(taxonomyMeta.fallbacks?.map(fallback => fallback.stage)) === JSON.stringify(['plan', 'classifier-1', 'classifier-2'])
        && taxonomyMeta.fallback?.stage === 'classifier-2',
      'out-of-order classifier completions merge isolated model and fallback diagnostics into the parent in stable batch order');
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
];
