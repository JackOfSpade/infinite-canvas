import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { _resetNonApiAiHandoffLifecycle, abortNodeTasksAndWait, applyBugReportCode, assert, buildNonApiAiHandoffLifecycleMarkdown, callLLMDocument, callLLMRaw, callLLMText, callLLMVision, checkPromptFits, fs, generateMarkdown, getKnownTaskIds, getNonApiAiHandoffLifecycle, handleSafe, ipcMain, materializeNonApiPrompt, NON_API_AI_TRANSPORT, registerNonApiAiHandlers, requestNonApiAi, runBoundedJobTaxonomy, runRewindableGroundedHandoff, taskModelRoutingSnapshot, validateCompensationEvidenceSubmission, validateNonApiAiSubmission, validateRoleFamilyExperienceBandsSubmission } from '../test-dependencies.js';
import { pendingManualHandoffsForActiveTasks } from '../../electron/ipc/bugReport.js';

// A handful of representative marketplace tasks used below to prove routing
// and dispatch are task-agnostic now that every task shares the one manual
// transport. (The workspace 'text-polish' task that used to sit alongside
// these was removed outright along with its sole call site, the AI Polish
// Text context-menu action — there is no remaining non-job task that uses
// the raw-text request kind, so this list, and the test below, only exercise
// structured-text dispatch; callLLMRaw's own dispatch path is covered by the
// 'callLLMRaw is the deliberate exception' test above.)
const MARKETPLACE_AND_WORKSPACE_TASKS = [
  'vision-product-analysis',
  'price-synthesis',
  'bundle-price-synthesis',
  'platform-fit-assessment',
  'marketplace-hub-scan',
];

export default [
  {
    name: 'non-API AI: every known task id routes to the single manual transport',
    run: () => {
      // There is exactly one transport left in this app: every LLM call, job
      // and marketplace/workspace alike, goes through the human copy/paste
      // handoff. getKnownTaskIds()/taskModelRoutingSnapshot() are the only
      // routing surface left to assert against — there is no more per-task
      // allowlist, provider, or model to look up.
      const knownTasks = getKnownTaskIds();
      assert(knownTasks instanceof Set && knownTasks.size > 10 && !knownTasks.has('default'),
        'getKnownTaskIds() enumerates real call-site task ids and excludes the internal default fallback bucket');
      assert(!knownTasks.has('page-status-classify'),
        'a task id with no remaining call site is not resurrected in the known-task set');
      const snapshot = taskModelRoutingSnapshot();
      assert(snapshot.transport === NON_API_AI_TRANSPORT,
        'the routing snapshot names the single manual transport at its top level');
      for (const task of knownTasks) {
        assert(snapshot.tasks[task]?.transport === NON_API_AI_TRANSPORT
          && Object.keys(snapshot.tasks[task]).length === 1,
        `task '${task}' routes to the manual handoff transport with no per-task provider or model field left to report`);
      }
      assert(!('page-status-classify' in snapshot.tasks) && !('default' in snapshot.tasks),
        'the snapshot reports only real call-site tasks, never the deleted task id or the internal fallback bucket');
      return { taskCount: knownTasks.size };
    },
  },
  {
    name: 'non-API AI: llm.js imports no provider module and every entry point reaches requestNonApiAi',
    run: () => {
      // The old dual-transport router picked a live API branch per task; that
      // guarantee used to be checked by asserting manual-branch/provider-branch
      // ORDERING inside llm.js. With only one transport left, the guarantee
      // that actually matters is structural: llm.js cannot name a provider at
      // all, and every public call shape reaches the one transport function.
      const llmSource = readFileSync(new URL('../../electron/ipc/llm.js', import.meta.url), 'utf8');
      const lowered = llmSource.toLowerCase();
      const banned = ['gemini', 'claude', 'anthropic', 'apikey', 'providerfortask', 'modelfortask'];
      const present = banned.filter(token => lowered.includes(token));
      assert(present.length === 0,
        `llm.js must name no provider, credential, or removed routing helper; found: ${present.join(', ') || 'none'}`);
      assert(llmSource.includes("import { NON_API_AI_TRANSPORT, requestNonApiAi } from './nonApiAi.js';"),
        'llm.js imports only the manual handoff transport, never a provider SDK module');
      for (const fn of ['callLLMText', 'callLLMRaw', 'callLLMVision', 'callLLMDocument']) {
        const start = llmSource.indexOf(`export async function ${fn}`);
        assert(start >= 0, `${fn} is exported from llm.js`);
        const nextExportAt = llmSource.indexOf('\nexport ', start + 1);
        const body = llmSource.slice(start, nextExportAt > 0 ? nextExportAt : llmSource.length);
        assert(body.includes('requestNonApiAi({'),
          `${fn} dispatches through requestNonApiAi — the single transport — with no provider branch to choose between`);
      }
      return { checkedFunctions: 4, bannedTokens: banned.length };
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
        && dialogSource.includes('result.nodeCancelled && cancelledNodeId')
        && dialogSource.includes('detail: { nodeId: cancelledNodeId, runId: cancelledRunId }')
        && jobSearchSource.includes("document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled)")
        && jobSearchSource.includes('resetHandler();'),
      'cancelling a node-owned manual AI request notifies its Job Search hub with exact run ownership before using the in-card cancellation path');
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
      // Overall progress through the task. A batch number alone does not answer
      // "how many are left" when the run is dozens of handoffs long.
      assert(dialogSource.includes('` · ${request.itemsDone}/${request.itemsTotal} done`')
        && dialogSource.includes('Number.isFinite(request.itemsDone) && Number.isFinite(request.itemsTotal)')
        && transportSource.includes('itemsDone: cleanProgressCount(itemsDone),')
        && transportSource.includes('itemsTotal: cleanProgressCount(itemsTotal),')
        && transportSource.includes('itemsDone: record.itemsDone,'),
      'the handoff dialog reports overall task progress, and the transport carries it through to the renderer');
      // cleanBatchNumber floors at 1; a progress counter reads 0 on the first
      // handoff and must not be blanked exactly when it is most reassuring.
      assert(transportSource.includes('function cleanProgressCount(value)')
        && transportSource.includes('number >= 0 && number <= 100_000'),
      'the progress counter admits 0 rather than reusing the 1-based batch-number sanitizer');
      // THE resume invariant: these are display-only. Hashing them would change
      // the step key and make a resumed run re-ask for answers already pasted.
      const stepKeyStart = transportSource.indexOf('function durableStepKey(');
      const stepKeyEnd = transportSource.indexOf('async function durableStep(', stepKeyStart);
      const stepKeyBody = transportSource.slice(stepKeyStart, stepKeyEnd);
      assert(stepKeyStart >= 0 && stepKeyEnd > stepKeyStart
        && !stepKeyBody.includes('itemsDone') && !stepKeyBody.includes('itemsTotal'),
      'the durable step key must NOT hash the display-only progress counters, or a resumed run re-issues accepted handoffs');

      assert(dialogSource.includes('const [isExpanded, setIsExpanded] = useState(false)')
        && dialogSource.includes('Pending AI handoffs')
        && dialogSource.includes('Expand')
        && dialogSource.includes('Minimize')
        && dialogSource.includes('pointer-events-none fixed inset-0')
        && dialogSource.includes('pointer-events-auto fixed bottom-4 right-4')
        && dialogSource.includes('role="region"')
        && !dialogSource.includes('aria-modal="true"')
        && !dialogSource.includes('aria-controls="non-api-ai-handoff-panel"')
        && !dialogSource.includes('updateModalCount')
        && !dialogSource.includes('trapFocus')
        && !dialogSource.includes('blockEscape'),
      'pending handoffs default to a compact non-modal dock: its expanded controls own pointer events, do not point at an unmounted panel, and leave the canvas interactive without trapping keyboard focus');
      const ownerBadgeStart = dialogSource.indexOf('const ownerBadgeForNode = (nodeId) =>');
      const ownerBadgeEnd = dialogSource.indexOf('\n};', ownerBadgeStart) + 3;
      const ownerBadgeSource = dialogSource.slice(ownerBadgeStart, ownerBadgeEnd);
      assert(ownerBadgeStart >= 0
        && ownerBadgeSource.includes('Math.imul')
        && ownerBadgeSource.includes("return `Hub ${((hash >>> 0).toString(36).toUpperCase()).padStart(7, '0')}`;")
        && !ownerBadgeSource.includes('.slice(')
        && dialogSource.includes('const multipleHubQueue = useMemo(() =>')
        && dialogSource.includes('const chipLabel = ownerBadge ? `${ownerBadge} · ${label}` : label;')
        && dialogSource.includes('{multipleHubQueue && ownerBadgeForNode(activeRequest.nodeId) && ('),
      'a queue spanning Job Search hubs assigns each owner a deterministic privacy-safe badge in both its selectable chip and active handoff header, without exposing an id fragment');
      assert(appSource.lastIndexOf('<NonApiAiDialog />') > appSource.lastIndexOf('</ErrorBoundary>'),
        'the global handoff stays mounted above the canvas error boundary so an external-AI wait can still be cancelled after a renderer error');
      assert(transportSource.includes('NON_API_AI_HANDLER_CHANNELS')
        && transportSource.includes('ipcMain.removeHandler?.(channel)'),
      'manual-AI handlers can be safely re-registered by a controlled development reload without duplicate Electron IPC registrations');
      assert(mainSource.includes('hasPendingNonApiAiRequestsForSender(expectedSender)')
        && mainSource.includes("return { action: 'save', skipDocumentSessions, forceCanvasSave: true }")
        && mainSource.includes('await flushNonApiAiPersistence()')
        && dialogSource.includes("new CustomEvent('non-api-ai-node-pending'")
        && jobSearchSource.includes('Auto-resuming manual AI run'),
      'a pending handoff auto-saves its canvas restart marker, flushes its draft ledger on close, and auto-resumes after reload');
      assert(mainSource.includes('async function flushNonApiAiPersistenceForLifecycle(win, actionType)')
        && mainSource.includes("if (!await flushNonApiAiPersistenceForLifecycle(win, 'close')) return;")
        && mainSource.includes("return flushNonApiAiPersistenceForLifecycle(win, 'quit');")
        && mainSource.includes('Could Not Save AI Draft')
        && mainSource.includes('`${verb} Without Saving AI Draft`')
        && mainSource.includes('return choice === 1;')
        && mainSource.includes('Could not flush Non-API AI persistence before')
        && mainSource.includes('Could not complete canvas window close safely')
        && mainSource.includes('Could not complete app quit safely'),
      'a rejected AI-draft durability barrier must keep close/quit fail-closed, explain the failure, and not escape an async Electron event listener');
      const closeCheck = mainSource.slice(mainSource.indexOf('async function checkUnsavedChanges'), mainSource.indexOf('// ── Window creation'));
      assert(closeCheck.indexOf('hasPendingNonApiAiRequestsForSender(expectedSender)')
          < closeCheck.indexOf('if (rendererState.hasUnsavedChanges)')
        && preloadSource.includes('const pendingNonApiAiDraftWrites = new Set()')
        && preloadSource.includes('await Promise.allSettled([...pendingNonApiAiDraftWrites])')
        && persistenceSource.indexOf('await window.electronAPI?.flushNonApiAiPersistence?.()')
          < persistenceSource.indexOf('sendQuitResponse(response, requestId);'),
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
    name: 'non-API AI: every Job Search recovery path owns one shared lane and workflow id',
    run: () => {
      const source = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const between = (start, end) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from);
        return from >= 0 && to > from ? source.slice(from, to) : '';
      };
      const usaJobs = between('const triggerUSAJobsBackgroundSearch = useCallback', 'const handleJobsSettingsChange = useCallback');
      const paused = between('const resumeScoring = useCallback', 'useEffect(() => {\n    resumeScoringRef.current = resumeScoring;');
      const crashResume = between('const handleResumeRun = useCallback', 'const handleDiscardResume = useCallback');
      const savedScrape = between('const handleResumeSavedScrape = useCallback', 'const autoResumedManualAiRunRef = useRef(null);');

      assert(usaJobs.includes("lane: 'job-search'")
        && usaJobs.includes('const manualAiRunId = createManualAiRunId(currentId);')
        && usaJobs.includes('manualAiRunId,')
        && usaJobs.includes('lease?.release();')
        && usaJobs.includes('processingRunsRef.current.finish(processingToken)')
        && usaJobs.includes('await resumeScoringRef.current?.()'),
      'the USAJobs append holds the shared job lane and one workflow id, then releases before handing off paused scoring so it cannot deadlock itself');
      assert(paused.includes("lane: 'job-search'")
        && paused.includes('const manualAiRunId = createManualAiRunId(currentId);')
        && paused.includes('completeManualAiRun(manualAiRunId);'),
      'paused-source scoring carries one manual-AI workflow id through preference evaluation, scoring, and terminal preference filtering');
      const crashLeaseAt = crashResume.indexOf('lease = await moduleRunQueue.acquireModuleRun');
      const crashDelegationAt = crashResume.indexOf('Interrupted-run queue delegated to Job Board');
      const crashProcessingAt = crashResume.indexOf('processingToken = processingRunsRef.current.start();');
      assert(crashResume.includes("lane: 'job-search'")
        && crashResume.includes('const manualAiRunId = options?.manualAiRunId || createManualAiRunId(currentId);')
        && crashResume.includes('if (!queueManagedByBoard) {')
        && crashResume.includes("error: 'A Board-managed resume requires an orchestrator node id.'")
        && crashLeaseAt >= 0 && crashDelegationAt > crashLeaseAt && crashProcessingAt > crashDelegationAt
        && crashResume.includes('manualAiRunId,')
        && crashResume.includes('lease?.release();')
        && crashResume.includes('completeManualAiRun(manualAiRunId);'),
      'crash recovery reuses an exact Board-provided workflow id when orchestrated, otherwise acquires the shared lane, and starts processing only after either admission path is established');
      assert(savedScrape.includes("lane: 'job-search'")
        && savedScrape.includes('if (!queueManagedByBoard) {')
        && savedScrape.includes("throw new Error('A board-managed recovery requires an orchestrator node id.')")
        && savedScrape.includes('options?.manualAiRunId || createManualAiRunId(id)')
        && savedScrape.includes("manualAiRecoveryMode: resultMode === 'append' ? 'append-scored-jobs' : 'resume-saved-scrape'")
        && savedScrape.includes('lease?.release();')
        && source.includes('isSavedScrapeManualAiResume(resume)')
        && source.includes('Saved recovery queue delegated to Job Board'),
      'saved-scrape recovery is lane-serialized when standalone, reuses the Board lease when orchestrated, and routes either saved replay mode back to the exact saved snapshot after restart');
      return { workflows: 4, lane: 'job-search' };
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
        && handoff.includes('exactly one fenced JSON code block labelled `json`')
        && handoff.includes('Inside the block, return only valid JSON matching this schema:')
        && !handoff.includes('Do not use Markdown code fences'),
      'attachment instructions stay outside the copyable prompt while the exact structured-output contract remains');
      // Two silent-corruption defences from observed structured handoffs. The
      // chat returned ~10 unrequested properties (billed against the stated
      // output cap, which is what truncates a long reply on a transport with no
      // cap-raise retry), and both a bare filename and a citation to an
      // automatically-created paste attachment rendered as cards that copy
      // back as empty strings. A card appended to existing text leaves no trace
      // for a validator; job scoring separately rejects contractually-required
      // evidence fields when the entire value becomes blank.
      assert(handoff.includes('Emit exactly the properties named in the schema, at every nesting level, and nothing else.')
        && handoff.includes('they spend the output budget above')
        && handoff.includes('automatic paste attachment')
        && handoff.includes('treat that attachment only as input')
        && handoff.includes('Never cite, name, link to, or otherwise reference the file that contains the prompt')
        && handoff.includes('Do not place file attachments or file cards')
        && handoff.includes('schema requires an http(s) URL')
        && handoff.includes('ordinary literal JSON string rather than a rich link')
        && handoff.includes('normally add a citation to the file containing this prompt, omit it'),
      'the structured contract isolates the exact schema in a copyable code block and forbids chat-UI widgets that do not survive a plain-text copy');
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
        && !freeText.includes('fenced JSON code block')
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
        && structured.includes('exactly one fenced JSON code block labelled `json`')
        && structured.includes('automatic paste attachment')
        && structured.includes('Do not place file attachments or file cards')
        && structured.includes('schema requires an http(s) URL'),
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
    name: 'non-API AI: callLLMVision forwards its image paths as attachments beside a structured-vision handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 731, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const imagePaths = ['/tmp/non-api-vision-front.jpg', '/tmp/non-api-vision-back.jpg'];
      handleSafe('non-api-vision-test', async (_event, _args, signal) => ({
        result: await callLLMVision(imagePaths, 'Describe these product photos.', {
          signal, task: 'vision-product-analysis',
          responseSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-vision-test')({ sender }, { nodeId: 'node-vision-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request
        && JSON.stringify(request.attachments) === JSON.stringify(imagePaths)
        && request.prompt.includes('Request kind: structured-vision')
        && request.prompt.includes('Task: vision-product-analysis'),
      'callLLMVision hands its image paths through requestNonApiAi as Finder-revealable attachments beside a structured-vision handoff, not inlined in the prompt text');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { attachments: request.attachments.length };
    },
  },
  {
    name: 'non-API AI: callLLMDocument forwards a single file as an attachment beside a structured-document handoff',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 732, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const filePath = '/tmp/non-api-document-resume.pdf';
      handleSafe('non-api-document-test', async (_event, _args, signal) => ({
        result: await callLLMDocument(filePath, 'Extract the career profile.', {
          signal, task: 'career-file-extract',
          responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-document-test')({ sender }, { nodeId: 'node-document-test' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request
        && JSON.stringify(request.attachments) === JSON.stringify([filePath])
        && request.prompt.includes('Request kind: structured-document')
        && request.prompt.includes('Task: career-file-extract'),
      'callLLMDocument hands its single filePath through requestNonApiAi as one Finder-revealable attachment on a structured-document handoff');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { attachments: request.attachments.length };
    },
  },
  {
    // FIX regression test: callLLMVision used to have NO sensitive-path gate
    // at all — before every LLM call became a manual handoff, this was
    // enforced implicitly by assertAttachmentPathSafe() inside the deleted
    // callClaudeVision/callGeminiVision provider modules (one check per
    // element of imagePaths, run before any file was touched). A node's
    // imagePaths/filePath is sourced from loaded canvas JSON, so an
    // untrusted/shared canvas pointing a node at ~/.ssh/id_rsa etc. must
    // still be refused — and refused BEFORE the path is ever Finder-revealed
    // to the user as an attachment to paste into their own chat, i.e. before
    // requestNonApiAi dispatches a 'non-api-ai-request' at all.
    name: 'non-API AI: callLLMVision and callLLMDocument refuse a sensitive attachment path before any handoff is requested',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 941, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      const visionSchema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

      // The sensitive path is second in the array — the gate must check
      // EVERY element, not just imagePaths[0].
      handleSafe('non-api-vision-sensitive-test', async (_event, _args, signal) => ({
        result: await callLLMVision(
          ['/Users/x/Pictures/product.jpg', '/Users/x/.ssh/id_rsa'],
          'Describe these product photos.',
          { signal, task: 'vision-product-analysis', responseSchema: visionSchema },
        ),
      }));
      // handleSafe never rethrows — a handler's throw comes back as a resolved
      // { success: false, error } payload, so assert on that shape rather
      // than expecting the invoke() promise itself to reject.
      const visionResult = await ipcMain.__getInvokeHandler('non-api-vision-sensitive-test')({ sender }, {});
      assert(visionResult?.success === false
        && visionResult?.error === 'Refusing to read a sensitive system/credential path as an AI attachment: /Users/x/.ssh/id_rsa',
        'callLLMVision throws callLLMDocument\'s exact sensitive-path error, naming the offending (non-first) path');
      assert(!sent.some(item => item.channel === 'non-api-ai-request'),
        'callLLMVision must throw before requestNonApiAi ever Finder-reveals the path or dispatches a handoff prompt');

      // callLLMDocument's own pre-existing gate is the regression baseline —
      // must still behave identically after adding callLLMVision's gate.
      handleSafe('non-api-document-sensitive-test', async (_event, _args, signal) => ({
        result: await callLLMDocument('/Users/x/.aws/credentials', 'Extract the career profile.', {
          signal, task: 'career-file-extract',
          responseSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        }),
      }));
      const docResult = await ipcMain.__getInvokeHandler('non-api-document-sensitive-test')({ sender }, {});
      assert(docResult?.success === false
        && docResult?.error === 'Refusing to read a sensitive system/credential path as an AI attachment: /Users/x/.aws/credentials',
        'callLLMDocument keeps its own sensitive-path gate unchanged');
      assert(!sent.some(item => item.channel === 'non-api-ai-request'),
        'callLLMDocument must also throw before any handoff is requested');

      // A null/absent imagePaths (no attachments at all) must not crash the
      // gate's loop — only a REAL sensitive path throws. The handoff still
      // proceeds normally in this case, so drive it through to completion
      // (cancel) rather than leaving a dangling pending request.
      handleSafe('non-api-vision-null-paths-test', async (_event, _args, signal) => ({
        result: await callLLMVision(null, 'Describe this.', {
          signal, task: 'vision-product-analysis', responseSchema: visionSchema,
        }),
      }));
      const nullRun = ipcMain.__getInvokeHandler('non-api-vision-null-paths-test')({ sender }, {});
      await new Promise(resolve => setImmediate(resolve));
      const nullRequest = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(nullRequest && Array.isArray(nullRequest.attachments) && nullRequest.attachments.length === 0,
        'a null imagePaths is guarded by Array.isArray in the gate loop (no crash) and reaches the handoff with zero attachments');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: nullRequest.requestId });
      await nullRun;

      return { sensitivePathsRejected: 2 };
    },
  },
  {
    name: 'non-API AI: structured public LLM entry points reject a missing responseSchema, and callLLMRaw stays exempt',
    run: async () => {
      // assertStructuredResponseSchema() is the one shared guard: it must
      // still fire before any handoff is dispatched for every structured
      // entry point, so a caller can never silently get reparsed prose back
      // for what it asked to be schema-validated JSON.
      for (const invoke of [
        () => callLLMText('structured result'),
        () => callLLMVision([], 'structured result'),
        () => callLLMDocument('/tmp/fixture.pdf', 'structured result'),
      ]) {
        let caught = null;
        try { await invoke(); } catch (error) { caught = error; }
        assert(/requires a responseSchema/.test(caught?.message || ''),
          'structured public LLM calls cannot silently fall back to reparsed prose');
      }

      // callLLMRaw is the deliberate exception — prose/HTML/grounded research
      // has no JSON envelope to validate — so it must reach the manual
      // handoff dispatch with no responseSchema instead of throwing.
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 911, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-raw-schema-exempt-test', async (_event, _args, signal) => ({
        result: await callLLMRaw('Prose response, no schema required.', { signal }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-raw-schema-exempt-test')({ sender }, { nodeId: 'node-raw-exempt' });
      await new Promise(resolve => setImmediate(resolve));
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      assert(request && request.prompt.includes('Request kind: raw-text'),
        'callLLMRaw reaches the manual handoff without a responseSchema — it is deliberately exempt from the structured-output guard');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { guardedEntrypoints: 3, exemptEntrypoint: 'callLLMRaw' };
    },
  },
  {
    name: 'non-API AI: every marketplace and workspace task reaches the manual handoff through callLLMText/callLLMRaw',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 733, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      let counter = 0;
      for (const task of MARKETPLACE_AND_WORKSPACE_TASKS) {
        const channel = `non-api-marketplace-test-${counter}`;
        handleSafe(channel, async (_event, _args, signal) => ({
          result: await callLLMText('Return the requested JSON.', {
            signal, task,
            responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
          }),
        }));
        const run = ipcMain.__getInvokeHandler(channel)({ sender }, { nodeId: `node-marketplace-${counter}` });
        counter += 1;
        await new Promise(resolve => setImmediate(resolve));
        const request = sent[sent.length - 1]?.payload;
        assert(sent[sent.length - 1]?.channel === 'non-api-ai-request'
          && request?.prompt.includes(`Task: ${task}`)
          && request.prompt.includes('Request kind: structured-text'),
        `'${task}' dispatches through requestNonApiAi with its task id and request kind materialized into the handoff prompt, exactly like every job task`);
        await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
        await run;
      }
      return { tasks: MARKETPLACE_AND_WORKSPACE_TASKS.length };
    },
  },
  {
    name: 'non-API AI: callLLMText threads its caller-supplied responseValidator through the pasted response before settling',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = {
        id: 734, isDestroyed: () => false, once: () => {}, removeListener: () => {},
        send: (channel, payload) => sent.push({ channel, payload }),
      };
      handleSafe('non-api-validator-thread-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return the requested JSON.', {
          signal, task: 'job-scoring',
          responseSchema: { type: 'object', required: ['index'], properties: { index: { type: 'integer' } } },
          responseValidator: (value) => {
            if (value.index !== 0) throw new Error('index must be 0 for this single-row request.');
          },
        }),
      }));
      const run = ipcMain.__getInvokeHandler('non-api-validator-thread-test')({ sender }, { nodeId: 'node-validator-thread' });
      await new Promise(resolve => setImmediate(resolve));
      const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
      const request = sent.find(item => item.channel === 'non-api-ai-request')?.payload;
      const rejected = await submit({ sender }, { requestId: request.requestId, response: '{"index": 7}' });
      assert(rejected.accepted === false
        && rejected.validationErrors?.[0] === 'index must be 0 for this single-row request.',
      'a schema-valid but semantically wrong paste is rejected by the caller-supplied validator before the invoke can settle');
      const accepted = await submit({ sender }, { requestId: request.requestId, response: '{"index": 0}' });
      const result = await run;
      assert(accepted.accepted === true && result.success === true && result.result?.index === 0,
        'a corrected paste that satisfies both schema and validator settles the original callLLMText invocation with the validated value');
      return { validated: true };
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
    name: 'non-API AI: manual scoring dispatch uses the bounded per-item task formula, not a flat cap',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      // There is no learned/self-calibrating cap left on this transport (that
      // was API-only retry telemetry, now deleted along with the API path).
      // What still matters is that the manual handoff's stated output ceiling
      // is the real per-item job-scoring formula (1600 + itemCount*600), not
      // a stale or flat number, so the human's chat app gets an accurate
      // budget for the actual batch size.
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
      'manual job scoring exposes its 15-item workload and uses the bounded per-item formula, never a flat historical cap');
      await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: request.requestId });
      await run;
      return { manualCap: 10600 };
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
    name: 'non-API AI: acknowledged manual-run ids survive cancellation until explicit durable completion',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sent = [];
      const sender = new EventEmitter();
      sender.id = 711;
      sender.isDestroyed = () => false;
      sender.send = (channel, payload) => sent.push({ channel, payload });
      const foreignSender = new EventEmitter();
      foreignSender.id = 712;
      foreignSender.isDestroyed = () => false;
      foreignSender.send = () => {};
      const runId = `cancel-ack-${process.pid}-${Date.now()}`;
      const nodeId = `cancel-ack-node-${process.pid}`;

      handleSafe('non-api-cancel-ack-ledger-test', async (_event, _args, signal) => ({
        result: await callLLMText('Return a result.', {
          signal, task: 'job-scoring', cachedPrefix: 'STATIC CACHED RUBRIC', responseSchema: {
            type: 'object', required: ['result'], properties: { result: { type: 'string' } },
          },
        }),
      }));
      const invocation = ipcMain.__getInvokeHandler('non-api-cancel-ack-ledger-test')(
        { sender },
        { nodeId, manualAiRunId: runId },
      );
      let request = null;
      for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
        request = sent.find(item => item.channel === 'non-api-ai-request')?.payload || null;
        if (!request) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(request?.requestId && request.runId === runId,
        'the cancellable dialog exposes the same renderer-owned manual run id registered on its node task');

      const cancellation = await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')(
        { sender },
        { requestId: request.requestId },
      );
      const cancelledInvocation = await invocation;
      assert(cancellation.cancelled === true
        && cancellation.settled === true
        && JSON.stringify(cancellation.manualAiRunIds) === JSON.stringify([runId])
        && cancelledInvocation.success === false,
      'dialog cancellation returns the acknowledged manual run id after its node task has settled');

      const rediscovered = await abortNodeTasksAndWait(nodeId, sender, undefined, 1_000);
      const foreign = await abortNodeTasksAndWait(nodeId, foreignSender, undefined, 1_000);
      assert(rediscovered.abortedCount === 0
        && rediscovered.settled === true
        && JSON.stringify(rediscovered.manualAiRunIds) === JSON.stringify([runId])
        && foreign.manualAiRunIds.length === 0,
      'a reload cancellation rediscovers the retained id after active-task unregister, without crossing renderer ownership');

      const completed = await ipcMain.__getInvokeHandler('complete-non-api-ai-run')(
        { sender },
        { runId },
      );
      const afterCompletion = await abortNodeTasksAndWait(nodeId, sender, undefined, 1_000);
      assert(completed.absent === true
        && afterCompletion.manualAiRunIds.length === 0,
      'only explicit renderer completion releases an acknowledgement, even when dialog cancellation already removed the durable handoff');

      let releaseUncooperative;
      const slowRunId = `${runId}-slow`;
      const slowNodeId = `${nodeId}-slow`;
      handleSafe('non-api-cancel-ack-timeout-test', async () => {
        await new Promise(resolve => { releaseUncooperative = resolve; });
        return { drained: true };
      });
      const slowInvocation = ipcMain.__getInvokeHandler('non-api-cancel-ack-timeout-test')(
        { sender },
        { nodeId: slowNodeId, manualAiRunId: slowRunId },
      );
      const timedOut = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1);
      const timedOutRetry = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1);
      assert(timedOut.settled === false
        && timedOutRetry.settled === false
        && JSON.stringify(timedOutRetry.manualAiRunIds) === JSON.stringify([slowRunId]),
      'a bounded cancellation timeout never releases its discovered run id');
      releaseUncooperative();
      await slowInvocation;
      const afterLateSettlement = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1_000);
      assert(JSON.stringify(afterLateSettlement.manualAiRunIds) === JSON.stringify([slowRunId]),
        'late task settlement unregisters execution without pretending the renderer durably recorded cleanup');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: slowRunId });
      const afterSlowCompletion = await abortNodeTasksAndWait(slowNodeId, sender, undefined, 1_000);
      assert(afterSlowCompletion.manualAiRunIds.length === 0,
        'explicit completion also releases an acknowledgement retained across a cancellation timeout');
      return { rediscovered: 1, timeoutRetained: 1 };
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
      const pendingLifecycle = getNonApiAiHandoffLifecycle({ windowId: sender.id });
      const matching = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'non-api-lifecycle-report-test' }],
      }], pendingLifecycle);
      const wrongChannel = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'different-ipc-task' }],
      }], pendingLifecycle);
      const wrongRun = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [{ channel: 'non-api-lifecycle-report-test', manualAiRunId: 'different-workflow' }],
      }], [{
        nodeId: 'handoff-report-node', windowId: sender.id,
        channel: 'non-api-lifecycle-report-test', runId: 'actual-workflow', outcome: 'pending',
      }]);
      const mixedControllers = pendingManualHandoffsForActiveTasks([{
        nodeId: 'handoff-report-node',
        senderId: sender.id,
        taskDetails: [
          { channel: 'non-api-lifecycle-report-test', manualAiRunId: 'actual-workflow' },
          { channel: 'unrelated-ipc-task', manualAiRunId: null },
        ],
      }], [{
        nodeId: 'handoff-report-node', windowId: sender.id,
        channel: 'non-api-lifecycle-report-test', runId: 'actual-workflow', outcome: 'pending',
      }]);
      const pendingReport = generateMarkdown({
        description: 'A manual taxonomy handoff is waiting.', filterCode: 'FULL',
        filterStats: {
          hasJobNodes: true, hasSellNodes: false,
          currentNodeIds: ['handoff-report-node', 'handoff-report-board'], omittedSections: [],
        },
        nodes: [
          { id: 'handoff-report-node', type: 'jobhub', data: {} },
          {
            id: 'handoff-report-board', type: 'jobboard', data: {
              boardScanResume: {
                phase: 'searches', selectedSearchModuleIds: ['handoff-report-node'],
                completedSourceRuns: {}, incompleteSearches: [],
                activeSourceIds: ['handoff-report-node', 'other-active-source'],
                awaitingSourceResolutions: [{ sourceId: 'handoff-report-node' }, { sourceId: 'other-pending-source' }],
              },
            },
          },
        ],
        edges: [], drawings: [], nodeInternals: [], nodeComponentStates: [], frontEndState: {}, eventLogs: [],
      }, sender.id).markdown;
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
      assert(matching.get('handoff-report-node')?.[0]?.task === 'job-taxonomy-classify'
        && wrongChannel.size === 0 && wrongRun.size === 0 && mixedControllers.size === 0
        && pendingReport.includes('⏳ awaiting manual response: job-taxonomy-classify')
        && pendingReport.includes('IPC `non-api-lifecycle-report-test`')
        && pendingReport.includes('Board `…handoff-` searches · 1 selected · 0 completed · 2 active · 2 awaiting source resolution · this source active · this source awaiting resolution')
        && !pendingReport.includes('handoff-report-board')
        && !pendingReport.includes('TOP_SECRET_PROMPT'),
      'an active controller is correlated only to the same-node, same-channel pending manual handoff, and FULL exposes only its redacted Board/source progress');
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
