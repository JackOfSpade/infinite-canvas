// Runs every AI task outside application bundles on the local Claude Code CLI.
// It serves pending handoffs through the worker seam in nonApiAi.js, so
// validation, saved progress and correction rounds stay there. Each
// answer starts a fresh session from the full prompt, so nothing carries over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { claudeChildEnv, resolveClaudeBinary } from './claudeApplicationRunner.js';
import { CLAUDE_TASK_IDS, claudeTaskProfile } from './claudeTaskProfiles.js';
import {
  listWorkerHandoffs,
  markWorkerHandoffAssigned,
  onNonApiAiEvent,
  readWorkerHandoff,
  readWorkerHandoffAttachments,
  returnHandoffToPerson,
  submitWorkerResponse,
} from './nonApiAi.js';

export const CLAUDE_TASK_CONCURRENCY = 4;
export const CLAUDE_TASK_USAGE_FILE = 'claude-task-usage.jsonl';
const SAFEGUARD_ATTEMPTS = 3;
const TRUNCATION_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const USAGE_LIMIT_WAIT_MS = 10 * 60_000;
const RESEARCH_MAX_TURNS = 16;
const IMAGE_MAX_EDGE = 1568;

const SEAM = Object.freeze({
  list: listWorkerHandoffs,
  read: readWorkerHandoff,
  assigned: markWorkerHandoffAssigned,
  attachments: readWorkerHandoffAttachments,
  submit: submitWorkerResponse,
  returnToPerson: returnHandoffToPerson,
  onEvent: onNonApiAiEvent,
});

export const CLAUDE_TASK_STATUS_CHANNEL = 'get-claude-task-status';
// Only these stops are shown to the person; anything else just retries quietly.
export const CLAUDE_TASK_PAUSE_CODES = Object.freeze(['CLAUDE_USAGE_LIMIT', 'CLAUDE_NOT_SIGNED_IN', 'CLAUDE_CLI_MISSING']);

let current = null;

/** What the dock may show: whether the worker is held up, and why. No task or prompt data. */
export function claudeTaskStatusView(workerStatus) {
  const pauseCode = CLAUDE_TASK_PAUSE_CODES.includes(workerStatus?.pauseCode) ? workerStatus.pauseCode : null;
  return Object.freeze({ paused: Boolean(pauseCode), pauseCode });
}

export function claudeTaskWorkerStatus() {
  return claudeTaskStatusView(current?.status());
}

/** Let the renderer ask whether AI work is paused. */
export function registerClaudeTaskStatusHandler({ ipcMain, status = claudeTaskWorkerStatus } = {}) {
  ipcMain.removeHandler?.(CLAUDE_TASK_STATUS_CHANNEL);
  ipcMain.handle(CLAUDE_TASK_STATUS_CHANNEL, () => status());
}

/** Fit a photo inside Claude's image size, or return null when it cannot be read. */
export function prepareTaskImage({ mime, bytes }, nativeImage) {
  if (!nativeImage) return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) ? { mimeType: mime, data: Buffer.from(bytes).toString('base64') } : null;
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const fitted = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image;
  return { mimeType: 'image/jpeg', data: fitted.toJPEG(85).toString('base64') };
}

// Claude Code reuses its cache only for system prompt text. A cache write costs
// twice the input price, so a prompt with nothing to share turns caching off.
export function cachedPromptParts(prompt, cachedPrefix) {
  if (!cachedPrefix || !prompt.includes(cachedPrefix)) return { text: prompt, systemAppend: '' };
  return {
    text: prompt.replace(cachedPrefix, () => '[The shared reference for this task is in the system prompt under SHARED REFERENCE. Treat it exactly as if it appeared at this point.]'),
    systemAppend: `SHARED REFERENCE:\n${cachedPrefix}`,
  };
}

async function defaultRunStage(options) {
  const { runClaudeSdkStage } = await import('./claudeApplicationSdkStage.js');
  return runClaudeSdkStage(options);
}

export function createClaudeTaskWorker({
  seam = SEAM,
  runStage = defaultRunStage,
  profileFor = claudeTaskProfile,
  taskIds = CLAUDE_TASK_IDS,
  concurrency = CLAUDE_TASK_CONCURRENCY,
  prepareImage = attachment => prepareTaskImage(attachment),
  recordUsage = () => {},
  binding = () => {
    const binary = resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
    return { binary, env: claudeChildEnv(process.env, path.dirname(binary)), cwd: os.tmpdir() };
  },
  now = () => Date.now(),
  setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimer = clearTimeout,
} = {}) {
  const allowTasks = new Set(taskIds);
  const running = new Map();
  const failures = new Map();
  let pausedUntil = 0;
  let pauseCode = null;
  let timer = null;
  let stopped = false;
  let unsubscribe = null;

  function wakeIn(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; pump(); }, Math.max(0, ms));
  }

  function pause(code, ms) {
    pausedUntil = Math.max(pausedUntil, now() + ms);
    if (pauseCode !== code) logger.warn(`[Claude tasks] Paused (${code}).`);
    pauseCode = code;
    wakeIn(ms);
  }

  function handleFailure(entry, error) {
    if (error?.code === 'CLAUDE_CANCELLED') return;
    if (error?.code === 'CLAUDE_USAGE_LIMIT') return pause(error.code, USAGE_LIMIT_WAIT_MS);
    if (error?.code === 'CLAUDE_NOT_SIGNED_IN' || error?.code === 'CLAUDE_CLI_MISSING') return pause(error.code, RETRY_BASE_MS * 2);
    const failure = failures.get(entry.requestId) || { attempts: 0, blocked: 0, notBefore: 0 };
    failure.attempts += 1;
    logger.warn(`[Claude tasks] '${entry.task}' failed (${error?.code || 'error'}), attempt ${failure.attempts}.`);
    if (error?.code === 'CLAUDE_SAFEGUARD_BLOCKED') {
      // These flags are sometimes false alarms and a fresh attempt usually passes.
      failure.blocked += 1;
      if (failure.blocked >= SAFEGUARD_ATTEMPTS) {
        failures.delete(entry.requestId);
        seam.returnToPerson({ requestId: entry.requestId, reason: 'worker_restart_cap' });
        return;
      }
      failures.set(entry.requestId, failure);
      return;
    }
    if (error?.code === 'CLAUDE_OUTPUT_TRUNCATED' && failure.attempts >= TRUNCATION_ATTEMPTS) {
      failures.delete(entry.requestId);
      seam.returnToPerson({ requestId: entry.requestId, reason: 'worker_restart_cap' });
      return;
    }
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failure.attempts - 1));
    failure.notBefore = now() + delay;
    failures.set(entry.requestId, failure);
    wakeIn(delay);
  }

  async function imagesFor(entry) {
    if (!entry.hasAttachments) return [];
    const files = await seam.attachments({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks });
    const images = (files?.attachments || []).map(file => prepareImage(file));
    if (!files || images.some(image => !image)) throw Object.assign(new Error('A photo could not be read.'), { code: 'CLAUDE_TASK_IMAGE' });
    return images.map((image, i) => ({ ...image, label: `Photo ${i + 1}` }));
  }

  async function serve(entry, controller) {
    const comparisonProvenance = entry.comparisonGroup ? {
      version: 2, transport: 'worker', observed: true, comparisonGroup: entry.comparisonGroup, comparisonRun: entry.comparisonRun,
      // Every answer is its own session, which is the isolation the comparison needs.
      conversationKey: crypto.randomBytes(32).toString('hex'), isolated: true,
    } : null;
    const handoff = seam.read({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks, ...(comparisonProvenance ? { comparisonProvenance } : {}) });
    if (!handoff?.ok) return;
    seam.assigned({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks });
    const profile = profileFor(entry.task);
    const pageImages = await imagesFor(entry);
    const stage = binding();
    const cached = cachedPromptParts(handoff.prompt, handoff.cachedPrefix);
    const reply = await runStage({
      ...stage, ...cached, env: cached.systemAppend ? stage.env : { ...stage.env, DISABLE_PROMPT_CACHING: '1' },
      pageImages, signal: controller.signal,
      model: profile.model, effort: profile.effort, persistSession: false,
      ...(profile.tools ? { tools: profile.tools.split(','), maxTurns: RESEARCH_MAX_TURNS } : {}),
    });
    recordUsage({ at: new Date(now()).toISOString(), task: entry.task, model: reply.model, effort: profile.effort, usage: reply.usage, costUsd: reply.costUsd });
    failures.delete(entry.requestId);
    // An answer proves Claude is usable again, which is what ends a pause notice.
    pauseCode = null;
    const outcome = await seam.submit({ requestId: entry.requestId, handoffCode: entry.handoffCode, response: reply.text, allowTasks });
    if (outcome?.retryAfterMs > 0) wakeIn(outcome.retryAfterMs);
  }

  function pump() {
    if (stopped) return;
    const snapshot = seam.list({ allowTasks });
    const live = new Set([...snapshot.handoffs.map(entry => entry.requestId), ...snapshot.settlingRequestIds]);
    for (const [requestId, run] of running) if (!live.has(requestId)) run.controller.abort();
    for (const requestId of failures.keys()) if (!live.has(requestId)) failures.delete(requestId);
    if (snapshot.retryAfterMs > 0) wakeIn(snapshot.retryAfterMs);
    if (now() < pausedUntil) return;
    for (const entry of snapshot.handoffs) {
      if (running.size >= concurrency) return;
      if (running.has(entry.requestId) || (failures.get(entry.requestId)?.notBefore || 0) > now() || !profileFor(entry.task)) continue;
      const controller = new AbortController();
      running.set(entry.requestId, { controller });
      serve(entry, controller)
        .catch(error => handleFailure(entry, error))
        .finally(() => {
          running.delete(entry.requestId);
          pump();
        });
    }
  }

  return Object.freeze({
    start() {
      stopped = false;
      unsubscribe = seam.onEvent(pump);
      pump();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearTimer(timer);
      for (const run of running.values()) run.controller.abort();
    },
    status: () => Object.freeze({ running: running.size, retrying: failures.size, paused: now() < pausedUntil, pauseCode }),
    pump,
  });
}

/** Start answering AI tasks with Claude for this process. */
export function startClaudeTaskWorker({ userData, nativeImage = null } = {}) {
  const usageFile = userData ? path.join(userData, CLAUDE_TASK_USAGE_FILE) : null;
  const worker = createClaudeTaskWorker({
    prepareImage: attachment => prepareTaskImage(attachment, nativeImage),
    recordUsage: (row) => {
      if (usageFile) void fs.promises.appendFile(usageFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }).catch(() => {});
    },
  });
  current = worker;
  worker.start();
  logger.info('[Claude tasks] Worker started.');
  return worker;
}
