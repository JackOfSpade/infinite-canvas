/**
 * In-memory human handoff for job-domain AI work.
 *
 * Job prompts are deliberately sent only to the WebContents that started the
 * IPC request. The renderer copies that material into the user's chosen chat
 * application and invokes `submit-non-api-ai-response` with the pasted reply.
 * This module intentionally has no timeout or disk persistence. Closing the
 * originating window aborts the existing IPC signal and discards the pending
 * handoff. A same-frame dialog remount/listener timing gap can explicitly
 * replay its sender-owned in-memory requests after it reconnects.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { parseAiJson } from './jsonRepair.js';
import { assertResponseMatchesSchema, canonicalizeResponseSchemaEnums } from './schemaValidation.js';
import { abortNodeTasks, getCurrentIpcRequestContext } from './ipcUtils.js';
import { logger } from '../logger.js';

const { ipcMain, shell } = electronPkg;

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
const NON_API_AI_HANDLER_CHANNELS = [
  'replay-pending-non-api-ai-requests',
  'submit-non-api-ai-response',
  'cancel-non-api-ai-request',
  'reveal-non-api-ai-attachment',
];

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
    prompt: record.materializedPrompt,
    task: record.task || null,
    nodeId: record.nodeId,
    batch: record.batch,
    batchTotal: record.batchTotal,
    attachments: [...record.attachmentPaths],
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
export function requestNonApiAi({
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
  retryOnTruncation,
  responseValidator,
  signal,
} = {}) {
  const context = getCurrentIpcRequestContext();
  const sender = context?.sender;
  if (!sender || sender.isDestroyed?.()) {
    throw new Error(`Non-API AI task '${task || 'unknown'}' requires an active originating renderer window.`);
  }
  if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');

  const record = {
    requestId: crypto.randomUUID(),
    sender,
    nodeId: context.nodeId || null,
    ...cleanBatchMetadata(batch, batchTotal),
    task,
    responseSchema,
    responseValidator: typeof responseValidator === 'function' ? responseValidator : null,
    attachmentPaths: cleanAttachmentPaths(attachmentPaths),
    validationError: null,
    signal,
    materializedPrompt: materializeNonApiPrompt({
      prompt, cachedPrefix, task, responseSchema, grounding, maxOutputTokens,
      formulaSeed, requestKind, retryOnTruncation,
      handoffSettings,
    }),
    resolve: null,
    reject: null,
    abortListener: null,
  };

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
      settle(record, { accepted: true });
      record.resolve(value);
      return { accepted: true };
    } catch (error) {
      const message = error?.message || 'The pasted response could not be accepted.';
      record.validationError = message;
      logger.warn(`[Non-API AI] Rejected response for task '${record.task || 'unknown'}': ${message}`);
      sendRequest(record);
      return { accepted: false, validationErrors: [message] };
    }
  });

  ipcMain.handle('cancel-non-api-ai-request', async (event, args = {}) => {
    const record = pendingRequests.get(args?.requestId);
    if (!record) return { cancelled: false };
    if (event.sender !== record.sender) return { cancelled: false };
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
