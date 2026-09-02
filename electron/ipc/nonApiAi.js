/**
 * In-memory human handoff for job-domain AI work.
 *
 * Job prompts are deliberately sent only to the WebContents that started the
 * IPC request. The renderer copies that material into the user's chosen chat
 * application and invokes `submit-non-api-ai-response` with the pasted reply.
 * Active promises remain process-local, but renderer-created workflow ids let
 * us checkpoint accepted responses and the current draft. After restart the
 * owning renderer re-invokes its workflow: accepted steps replay immediately
 * and the first unfinished step is shown with its draft restored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { parseAiJson } from './jsonRepair.js';
import { assertResponseMatchesSchema, canonicalizeResponseSchemaEnums } from './schemaValidation.js';
import { abortNodeTasks, getCurrentIpcRequestContext } from './ipcUtils.js';
import { logger } from '../logger.js';

const { app, ipcMain, shell } = electronPkg;

// This is a deliberately explicit allowlist. A new job task must be added here
// before llm.js can route it to the copy/paste handoff, making the no-job-AI-API
// rule visible and auditable instead of depending on a name-prefix convention.
export const NON_API_AI_TRANSPORT = 'non-api-ai';

export const NON_API_JOB_TASKS = new Set([
  'career-file-extract',
  'resume-parse',
  'job-query-generation',
  'job-scoring',
  'job-taxonomy-plan',
  'job-taxonomy-classify',
  'job-compensation-research',
  'job-compensation-assessment',
]);

const pendingRequests = new Map();
const DURABLE_HANDOFF_VERSION = 1;
const DURABLE_HANDOFF_FILE = 'non-api-ai-handoffs.json';
const DURABLE_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let durableStatePromise = null;
let durableMutationTail = Promise.resolve();
let durableWriteTail = Promise.resolve();
let durableDeferredWriteTimer = null;
const NON_API_AI_HANDLER_CHANNELS = [
  'replay-pending-non-api-ai-requests',
  'submit-non-api-ai-response',
  'step-back-non-api-ai-request',
  'cancel-non-api-ai-request',
  'reveal-non-api-ai-attachment',
  'update-non-api-ai-draft',
  'flush-non-api-ai-persistence',
  'complete-non-api-ai-run',
];

function cleanRunId(value) {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return clean && clean.length <= 160 ? clean : '';
}

function durableFilePath() {
  try {
    const dir = app?.getPath?.('userData');
    return dir ? path.join(dir, DURABLE_HANDOFF_FILE) : null;
  } catch {
    return null;
  }
}

async function loadDurableState() {
  if (durableStatePromise) return durableStatePromise;
  durableStatePromise = (async () => {
    const filePath = durableFilePath();
    if (!filePath) return { version: DURABLE_HANDOFF_VERSION, runs: {} };
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      const runs = parsed?.runs && typeof parsed.runs === 'object' ? parsed.runs : {};
      const cutoff = Date.now() - DURABLE_RUN_MAX_AGE_MS;
      for (const [runId, run] of Object.entries(runs)) {
        if (!run || Number(run.updatedAt) < cutoff) delete runs[runId];
      }
      return { version: DURABLE_HANDOFF_VERSION, runs };
    } catch {
      return { version: DURABLE_HANDOFF_VERSION, runs: {} };
    }
  })();
  return durableStatePromise;
}

function writeDurableState() {
  durableWriteTail = durableWriteTail.then(async () => {
    const filePath = durableFilePath();
    if (!filePath) return;
    const state = await loadDurableState();
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmp, filePath);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }).catch(error => logger.warn(`[Non-API AI] Could not checkpoint handoff: ${error?.message || error}`));
  return durableWriteTail;
}

function durableStepKey({ materializedPrompt, task, nodeId, batch, batchTotal, itemCount, attachmentPaths }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: materializedPrompt,
    task: task || null,
    nodeId: nodeId || null,
    batch: batch || null,
    batchTotal: batchTotal || null,
    itemCount: itemCount || null,
    // Attachments stay outside the copyable prompt, but they are still part of
    // the logical input. Hash their normalized paths into the opaque step key so
    // two files using the same extraction prompt can never share a response.
    attachments: Array.isArray(attachmentPaths) ? attachmentPaths : [],
  })).digest('hex');
}

async function durableStep(runId, stepKey) {
  if (!runId) return null;
  const state = await loadDurableState();
  return state.runs?.[runId]?.steps?.[stepKey] || null;
}

function queueDurableMutation(work) {
  const mutation = durableMutationTail.then(work, work);
  durableMutationTail = mutation.catch(() => {});
  return mutation;
}

function updateDurableStep(record, patch, { deferWrite = false } = {}) {
  if (!record.runId || !record.stepKey) return Promise.resolve();
  return queueDurableMutation(async () => {
    const state = await loadDurableState();
    const run = state.runs[record.runId] || { createdAt: Date.now(), steps: {} };
    run.updatedAt = Date.now();
    run.nodeId = record.nodeId || null;
    run.recoveryMode = record.recoveryMode || null;
    run.steps[record.stepKey] = {
      ...(run.steps[record.stepKey] || {}),
      task: record.task || null,
      batch: record.batch || null,
      batchTotal: record.batchTotal || null,
      itemCount: record.itemCount || null,
      updatedAt: Date.now(),
      ...patch,
    };
    state.runs[record.runId] = run;
    if (!deferWrite) {
      if (durableDeferredWriteTimer) {
        clearTimeout(durableDeferredWriteTimer);
        durableDeferredWriteTimer = null;
      }
      await writeDurableState();
    } else {
      if (durableDeferredWriteTimer) clearTimeout(durableDeferredWriteTimer);
      durableDeferredWriteTimer = setTimeout(() => {
        durableDeferredWriteTimer = null;
        void writeDurableState();
      }, 200);
    }
  });
}

function clearDurableRun(runId) {
  const clean = cleanRunId(runId);
  if (!clean) return Promise.resolve(false);
  return queueDurableMutation(async () => {
    const state = await loadDurableState();
    if (!state.runs[clean]) return false;
    delete state.runs[clean];
    await writeDurableState();
    return true;
  });
}

export function hasPendingNonApiAiRequestsForSender(sender) {
  for (const record of pendingRequests.values()) if (record.sender === sender) return true;
  return false;
}

export async function flushNonApiAiPersistence() {
  await durableMutationTail;
  if (durableDeferredWriteTimer) {
    clearTimeout(durableDeferredWriteTimer);
    durableDeferredWriteTimer = null;
    await writeDurableState();
  }
  await durableWriteTail;
}

export const NON_API_AI_STEP_BACK_CODE = 'NON_API_AI_STEP_BACK';

export class NonApiAiStepBackError extends Error {
  constructor(message = 'Return to the previous Non-API AI handoff step') {
    super(message);
    this.name = 'NonApiAiStepBackError';
    this.code = NON_API_AI_STEP_BACK_CODE;
  }
}

export function isNonApiAiStepBackError(error) {
  return error?.code === NON_API_AI_STEP_BACK_CODE;
}

export function isNonApiJobTask(task) {
  return NON_API_JOB_TASKS.has(task);
}

function cleanAttachmentPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim()))];
}

// `handoffSettings` is deliberately rendered into a prompt. Keep this
// boundary defensive so a future caller cannot accidentally turn an internal
// credential-bearing option into text copied to a third-party chat.
// Normalize camelCase first so `privateKey`, `authToken`, and `api_key` get
// the same treatment. Keep this list specific enough not to hide harmless
// settings such as maxOutputTokens, while treating every credential-shaped
// field as unsafe for a prompt copied into an external chat application.
const SENSITIVE_SETTING_KEY = /(?:^|_)(?:api_?key|private_?key|secret|password|credential|authorization|auth_?token|access_?token|refresh_?token|id_?token|bearer|session(?:_?token)?|cookie)(?:_|$)/i;
const CHAT_IRRELEVANT_SETTING_KEYS = new Set([
  'model', 'model_id', 'thinking', 'thinking_config', 'effort', 'temperature',
  'format', 'output_config', 'generation_config', 'structured_output',
  'native_provider_schema',
  'model_fallback_policy', 'excluded_models', 'response_schema',
  'response_mime_type',
]);

function isSensitiveSettingKey(key) {
  const normalized = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_SETTING_KEY.test(normalized);
}

function normalizedSettingKey(key) {
  return String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function safeHandoffSettings(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => safeHandoffSettings(item, seen));
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    CHAT_IRRELEVANT_SETTING_KEYS.has(normalizedSettingKey(key))
      ? []
      : [[key, isSensitiveSettingKey(key) ? '[redacted]' : safeHandoffSettings(item, seen)]]
  )));
}

function cleanBatchNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100_000 ? number : null;
}

function cleanBatchMetadata(batch, batchTotal) {
  const cleanBatch = cleanBatchNumber(batch);
  const cleanTotal = cleanBatchNumber(batchTotal);
  // A partial label is misleading and a batch beyond its stated total is a
  // caller bug, not useful UI metadata. Keep the handoff valid either way,
  // simply omit an invalid label rather than exposing arbitrary hint values.
  if (cleanBatch == null || cleanTotal == null || cleanBatch > cleanTotal) {
    return { batch: null, batchTotal: null };
  }
  return { batch: cleanBatch, batchTotal: cleanTotal };
}

function cleanStepBackLabel(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

/** Materialize the copy/paste handoff's otherwise-out-of-band options in the prompt. */
export function materializeNonApiPrompt({
  prompt,
  cachedPrefix,
  task,
  responseSchema,
  grounding = false,
  maxOutputTokens,
  formulaSeed,
  requestKind = 'text',
  handoffSettings,
  retryOnTruncation = true,
} = {}) {
  const effectiveTransport = NON_API_AI_TRANSPORT;
  const sections = [];
  if (cachedPrefix) sections.push(String(cachedPrefix));
  sections.push(String(prompt || ''));

  const settings = [
    '--- NON-API AI HANDOFF SETTINGS ---',
    `Task: ${task || 'default'}`,
    `Request kind: ${requestKind}`,
    `Transport: ${effectiveTransport} (manual copy/paste; no API request, provider selection, or provider fallback)`,
    `Expected response format: ${responseSchema ? 'JSON' : 'free text'}`,
    `Maximum output tokens: ${Number.isFinite(maxOutputTokens) ? maxOutputTokens : 'unspecified'}`,
    `Output-cap formula seed: ${Number.isFinite(formulaSeed) ? formulaSeed : 'unspecified'}`,
    `Grounded/web research: ${grounding ? 'true — use your chat application\'s web research when available' : 'false'}`,
    `Retry-on-truncation setting: ${retryOnTruncation ? 'true' : 'false'}`,
  ];
  if (handoffSettings && typeof handoffSettings === 'object' && !Array.isArray(handoffSettings)) {
    settings.push('', 'Handoff configuration (non-secret):', JSON.stringify(safeHandoffSettings(handoffSettings), null, 2));
  }
  if (responseSchema) {
    settings.push('', '--- REQUIRED RESPONSE FORMAT ---', '', 'Return only valid JSON matching this schema:', JSON.stringify(responseSchema, null, 2), '', 'Do not use Markdown code fences or include commentary outside the JSON.');
  }
  sections.push(settings.join('\n'));
  return sections.filter(Boolean).join('\n\n');
}

function publicRequest(record, validationError = record.validationError || null) {
  return {
    requestId: record.requestId,
    runId: record.runId || null,
    stepKey: record.stepKey || null,
    recoveryMode: record.recoveryMode || null,
    prompt: record.materializedPrompt,
    task: record.task || null,
    nodeId: record.nodeId,
    batch: record.batch,
    batchTotal: record.batchTotal,
    itemCount: record.itemCount,
    attachments: [...record.attachmentPaths],
    canStepBack: record.canStepBack,
    stepBackLabel: record.stepBackLabel || null,
    initialResponse: record.initialResponse || '',
    validationError,
  };
}

function send(record, channel, payload) {
  if (!record.sender || record.sender.isDestroyed?.()) return false;
  // `isDestroyed()` and `.send()` are not atomic: a window can begin closing
  // between them. Treat a failed delivery exactly like a closed sender so the
  // Promise created below cannot remain forever in `pendingRequests`.
  try {
    record.sender.send(channel, payload);
    return true;
  } catch (error) {
    logger.warn(`[Non-API AI] Could not deliver ${channel} for task '${record.task || 'unknown'}': ${error?.message || error}`);
    return false;
  }
}

function settle(record, outcome) {
  if (!pendingRequests.delete(record.requestId)) return;
  if (record.abortListener) record.signal?.removeEventListener?.('abort', record.abortListener);
  send(record, 'non-api-ai-settled', { requestId: record.requestId, ...outcome });
}

function abortPending(record, reason) {
  const error = reason instanceof Error ? reason : new Error(String(reason || 'Manual AI request cancelled'));
  settle(record, { accepted: false, cancelled: true, error: error.message });
  record.reject(error);
}

function sendRequest(record) {
  if (send(record, 'non-api-ai-request', publicRequest(record))) return true;
  // A failed retry/replay delivery is just as terminal as a failed first
  // delivery. Leaving it in the map would create a handoff no renderer can
  // ever complete, particularly during a window-close race.
  abortPending(record, new Error('Originating window closed before the Non-API AI request could be shown.'));
  return false;
}

/**
 * Send a human handoff request and wait until the originating renderer submits
 * an accepted response. The returned value matches the legacy LLM facades:
 * structured calls return parsed JSON and raw calls return raw text.
 */
export async function requestNonApiAi({
  prompt,
  cachedPrefix,
  task,
  responseSchema,
  grounding,
  maxOutputTokens,
  formulaSeed,
  attachmentPaths,
  requestKind,
  handoffSettings,
  batch,
  batchTotal,
  itemCount,
  retryOnTruncation,
  responseValidator,
  canStepBack = false,
  stepBackLabel,
  initialResponse,
  signal,
} = {}) {
  const context = getCurrentIpcRequestContext();
  const sender = context?.sender;
  if (!sender || sender.isDestroyed?.()) {
    throw new Error(`Non-API AI task '${task || 'unknown'}' requires an active originating renderer window.`);
  }
  if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');

  const runId = cleanRunId(context.manualAiRunId);
  const normalizedAttachmentPaths = cleanAttachmentPaths(attachmentPaths);
  const materializedPrompt = materializeNonApiPrompt({
    prompt, cachedPrefix, task, responseSchema, grounding, maxOutputTokens,
    formulaSeed, requestKind, retryOnTruncation,
    handoffSettings,
  });
  const batchMeta = cleanBatchMetadata(batch, batchTotal);
  const stepKey = runId ? durableStepKey({
    materializedPrompt, task, nodeId: context.nodeId || null,
    ...batchMeta, itemCount: cleanBatchNumber(itemCount),
    attachmentPaths: normalizedAttachmentPaths,
  }) : '';
  const savedStep = await durableStep(runId, stepKey);
  // A Back action deliberately reissues a previously accepted prompt with its
  // old response as an editable draft. Never auto-consume that accepted value.
  if (savedStep?.status === 'accepted' && !(typeof initialResponse === 'string' && initialResponse)) {
    try {
      return validateNonApiAiSubmission({ response: savedStep.response, responseSchema, responseValidator, task });
    } catch (error) {
      logger.warn(`[Non-API AI] Ignoring invalid saved response for '${task || 'unknown'}': ${error?.message || error}`);
    }
  }

  const record = {
    requestId: crypto.randomUUID(),
    runId,
    stepKey,
    recoveryMode: context.manualAiRecoveryMode || null,
    sender,
    nodeId: context.nodeId || null,
    ...batchMeta,
    itemCount: cleanBatchNumber(itemCount),
    task,
    responseSchema,
    responseValidator: typeof responseValidator === 'function' ? responseValidator : null,
    attachmentPaths: normalizedAttachmentPaths,
    canStepBack: canStepBack === true,
    stepBackLabel: cleanStepBackLabel(stepBackLabel),
    initialResponse: typeof initialResponse === 'string' && initialResponse
      ? initialResponse
      : (typeof savedStep?.draft === 'string' ? savedStep.draft : ''),
    settling: false,
    validationError: null,
    signal,
    materializedPrompt,
    resolve: null,
    reject: null,
    abortListener: null,
  };

  await updateDurableStep(record, { status: 'pending', draft: record.initialResponse || '', response: null });
  return new Promise((resolve, reject) => {
    record.resolve = resolve;
    record.reject = reject;
    record.abortListener = () => abortPending(record, signal?.reason || new Error('Operation cancelled'));
    pendingRequests.set(record.requestId, record);
    signal?.addEventListener?.('abort', record.abortListener, { once: true });
    sendRequest(record);
  });
}

/** Pure validation seam shared by the IPC submit handler and focused tests. */
export function validateNonApiAiSubmission({ response, responseSchema, responseValidator, task } = {}) {
  if (typeof response !== 'string' || !response.trim()) throw new Error('Paste a non-empty AI response before submitting.');
  let value = response;
  if (responseSchema) {
    const parsed = parseAiJson(response);
    value = canonicalizeResponseSchemaEnums(parsed, responseSchema);
    assertResponseMatchesSchema(value, responseSchema, { provider: 'Non-API AI', task });
  }
  // Some contracts have deterministic domain rules beyond JSON Schema (for
  // example exact classifier coverage or evidence-grounded score rows). Keep
  // those in the same retry loop instead of accepting a syntactically-valid
  // paste and later silently producing placeholder data.
  responseValidator?.(value);
  return value;
}

export function registerNonApiAiHandlers() {
  // Electron rejects a second `handle` registration for the same channel.
  // Main currently calls this once, but removing the old handlers makes a
  // controlled re-registration (dev reload/test harness) safe without
  // discarding any pending sender-owned requests.
  for (const channel of NON_API_AI_HANDLER_CHANNELS) ipcMain.removeHandler?.(channel);
  // A dialog remount or listener timing gap can miss an emitted prompt while
  // its same-frame IPC invocation is still valid. Replay only records owned by
  // this exact sender so it never exposes another window's career data.
  // Sending before returning makes the invoke a synchronization point for the
  // renderer: it subscribes first, then calls this handler. Main-frame reloads
  // abort their old invocation in ipcUtils instead of replaying it. Map
  // iteration preserves handoff creation order.
  ipcMain.handle('replay-pending-non-api-ai-requests', async (event) => {
    let count = 0;
    for (const record of pendingRequests.values()) {
      if (record.sender !== event.sender) continue;
      if (sendRequest(record)) count += 1;
    }
    return { count };
  });

  ipcMain.handle('submit-non-api-ai-response', async (event, args = {}) => {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    const record = pendingRequests.get(requestId);
    if (!record) return { accepted: false, validationErrors: ['This Non-API AI request is no longer pending.'] };
    if (event.sender !== record.sender) return { accepted: false, validationErrors: ['This response belongs to a different window.'] };

    try {
      const value = validateNonApiAiSubmission({
        response: args.response,
        responseSchema: record.responseSchema,
        responseValidator: record.responseValidator,
        task: record.task,
      });
      record.validationError = null;
      record.settling = true;
      await updateDurableStep(record, { status: 'accepted', response: args.response, draft: '' });
      settle(record, { accepted: true });
      record.resolve(value);
      return { accepted: true };
    } catch (error) {
      record.settling = false;
      const message = error?.message || 'The pasted response could not be accepted.';
      record.validationError = message;
      logger.warn(`[Non-API AI] Rejected response for task '${record.task || 'unknown'}': ${message}`);
      sendRequest(record);
      return { accepted: false, validationErrors: [message] };
    }
  });

  ipcMain.handle('step-back-non-api-ai-request', async (event, args = {}) => {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    const record = pendingRequests.get(requestId);
    if (!record) return { steppedBack: false, error: 'This Non-API AI request is no longer pending.' };
    if (event.sender !== record.sender) return { steppedBack: false, error: 'This response belongs to a different window.' };
    if (!record.canStepBack) return { steppedBack: false, error: 'There is no previous handoff step available for this request.' };

    // Resolving a prior handoff already advanced its JavaScript continuation,
    // so a visual-only back button would leave the wrong value in the owning
    // pipeline. Reject this downstream gate with a private control-flow error;
    // the paired research/extraction workflow catches it and reissues the
    // preceding prompt with its accepted response restored as an editable
    // draft. The AbortSignal remains live because the owning operation itself
    // is continuing, not being cancelled.
    settle(record, { accepted: false, steppedBack: true });
    record.reject(new NonApiAiStepBackError());
    return { steppedBack: true };
  });

  ipcMain.handle('cancel-non-api-ai-request', async (event, args = {}) => {
    const record = pendingRequests.get(args?.requestId);
    if (!record) return { cancelled: false };
    if (event.sender !== record.sender) return { cancelled: false };
    await clearDurableRun(record.runId);
    // A manual cancellation is a cancellation of the owning job operation, not
    // merely one prompt. In particular, scoring must not mistake it for a
    // recoverable model failure and split/reissue more prompts.
    if (record.nodeId) {
      abortNodeTasks(record.nodeId, record.sender, new Error('Manual AI job cancelled'));
      return { cancelled: true, nodeCancelled: true };
    }
    abortPending(record, new Error('Manual AI job cancelled'));
    return { cancelled: true, nodeCancelled: false };
  });

  ipcMain.handle('update-non-api-ai-draft', async (event, args = {}) => {
    const record = pendingRequests.get(args?.requestId);
    if (!record || event.sender !== record.sender || record.settling) return { saved: false };
    const draft = typeof args.response === 'string' ? args.response.slice(0, 8_000_000) : '';
    record.initialResponse = draft;
    await updateDurableStep(record, { status: 'pending', draft, response: null }, { deferWrite: true });
    return { saved: true };
  });

  // Renderer shutdown first waits for every fire-and-forget draft invoke in
  // preload, then uses this as a disk barrier before reporting that it is safe
  // for main to save/destroy the canvas window.
  ipcMain.handle('flush-non-api-ai-persistence', async () => {
    await flushNonApiAiPersistence();
    return { flushed: true };
  });

  ipcMain.handle('complete-non-api-ai-run', async (_event, args = {}) => ({
    cleared: await clearDurableRun(args?.runId),
  }));

  ipcMain.handle('reveal-non-api-ai-attachment', async (event, args = {}) => {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    const record = pendingRequests.get(requestId);
    if (!record || event.sender !== record.sender) {
      throw new Error('This attachment belongs to a different or completed Non-API AI request.');
    }
    if (!record.attachmentPaths.includes(filePath)) {
      throw new Error('That file is not an attachment for this Non-API AI request.');
    }
    if (!path.isAbsolute(filePath)) throw new Error('The attachment path must be absolute.');
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('The attachment file no longer exists at that location.');
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error('The attachment is not a file that Finder can reveal.');
    }
    shell.showItemInFolder(filePath);
    return { revealed: true };
  });
}
