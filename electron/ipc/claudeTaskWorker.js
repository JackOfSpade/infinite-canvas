// Runs every AI task outside application bundles on the local Claude Code CLI.
// It serves pending handoffs through the worker seam in nonApiAi.js, so
// validation, saved progress and correction rounds stay there. Each
// answer starts a fresh session from the full prompt, so nothing carries over.
// A web task (a profile with tools) is answered by Parallel Search, except the
// single task in BUILT_IN_WEB_TASKS, which offers Claude's built-in
// WebSearch/WebFetch instead; no web task ever takes the cheaper offload route.
// When a Parallel web task's search is out of usage the worker pauses with
// PARALLEL_SEARCH_EXHAUSTED and keeps the queued work, so the owner can add
// credits and press Resume. A built-in-web task never pauses for Parallel.
// A task routed to DeepSeek (aiCallProviders.js `task:<id>`) is answered by DeepSeek only (the
// owner's rule, 2026-11-15): Claude never steps in. When DeepSeek credit is exhausted the worker
// pauses with OFFLOAD_CREDIT_EXHAUSTED and keeps the queued work; any other DeepSeek failure is a
// failed attempt that the dock shows and the worker retries with backoff.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { claudeChildEnv, resolveClaudeBinary } from './claudeApplicationRunner.js';
import {
  addClaudeAccount, cancelClaudeAccountLogin, listClaudeAccounts, listClaudeAccountsCached,
  removeClaudeAccount, subscribeClaudeAccounts,
} from './claudeAccounts.js';
import { CLAUDE_PROMPT_TOO_LONG } from './claudePromptLimit.js';
import { claudeUsageLimit, claudeUsageWaitMs, clearClaudeUsageLimit, drainClaudeCalls, heldClaudeKeys, holdClaude, isClaudeHeld, isClaudePauseKey, releaseClaude, reportClaudeUsageLimit, subscribeClaudeHolds } from './claudePause.js';
import { createClaudeTaskActivity, standaloneClaudeActivity, subscribeStandaloneClaudeActivity } from './claudeTaskActivity.js';
import { BUILT_IN_WEB_TASKS, CLAUDE_TASK_IDS, claudeTaskProfile } from './claudeTaskProfiles.js';
import {
  listWorkerHandoffs,
  markWorkerHandoffAssigned,
  onNonApiAiEvent,
  readWorkerHandoff,
  readWorkerHandoffAttachments,
  failWorkerHandoff,
  returnHandoffToPerson,
  submitWorkerResponse,
  workerShadowValidator,
} from './nonApiAi.js';
import { CLAUDE_LIMIT_PROBE_MS } from './claudeLimitConstants.js';
import { routedCall } from './aiCallProviders.js';
import { configureAiRecording, recordAiReplaySample } from './aiReplaySamples.js';
import { createShadowMeasure } from './aiShadowMeasure.js';
import { handoffMessages, offloadTextCall } from './offloadTextCall.js';
import { mergeOfficialPostingResearchReplies, officialPostingResearchMembers, OFFICIAL_POSTING_RESEARCH_TASK } from './officialPostingBridge.js';
import {
  isParallelLimitSignal, isParallelToolName, noteParallelLimit, parallelBlocked, parallelExhaustedError, parallelMcpServers,
  parallelPlainLeads, parallelSearchNotice, PARALLEL_EXHAUSTED_CODE, readParallelKey, resetParallelLimit,
} from './parallelSearch.js';

export const CLAUDE_TASK_CONCURRENCY = 4;
export const CLAUDE_TASK_USAGE_FILE = 'claude-task-usage.jsonl';
const SAFEGUARD_ATTEMPTS = 3;
const TRUNCATION_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
const RETRY_PAUSE_MS = 10 * 60_000;
const RETRY_MAX_MS = RETRY_PAUSE_MS;
const USAGE_LIMIT_WAIT_MS = CLAUDE_LIMIT_PROBE_MS;
const RESEARCH_MAX_TURNS = 16;
const IMAGE_MAX_EDGE = 1568;
const ACTIVITY_NOTIFY_MS = 500;
const OFFLOAD_PAUSE_MS = RETRY_PAUSE_MS;
export const OFFLOAD_CREDIT_CODE = 'OFFLOAD_CREDIT_EXHAUSTED';
// A Parallel web task waits for a limit to pass: its search has no fallback.
const PARALLEL_PAUSE_MS = RETRY_PAUSE_MS;
// Research runs Parallel alone. Measured 2026-11-14, two seeds, Parallel against built-in web search
// and both together: experience bands over 12 families with two verified hosts 11 and 10 against 1 and
// 4, together 12 and 12; salary over 12 cohorts with a verified source 12 and 9 against 4 and 4,
// together 9 on the second seed; location cards correct 2 and 9 of 24 against 1 and 4, together 2 and
// 8; preference research over 172 checks answered by both decided 166 confirmed / 2 conflicts / 4
// unverified with built-in against 158 / 2 / 12 with Parallel, the same two conflicts decided.
const BUILT_IN_WEB_TOOL_NAMES = Object.freeze(['WebSearch', 'WebFetch']);

/**
 * Which search a profile's tools name: Parallel's MCP tools, Claude's built-in web tools, or
 * neither. Keeping them apart is what stops Parallel-only handling (its MCP server, its
 * tool-result callback, its exhaustion pause) from reaching a built-in-web task.
 */
export function toolSearchKind(tools) {
  const names = String(tools ?? '').split(',').map(name => name.trim()).filter(Boolean);
  return Object.freeze({
    usesParallel: names.some(name => isParallelToolName(name)),
    usesBuiltInWeb: names.some(name => BUILT_IN_WEB_TOOL_NAMES.includes(name)),
  });
}
const SEAM = Object.freeze({
  list: listWorkerHandoffs,
  read: readWorkerHandoff,
  assigned: markWorkerHandoffAssigned,
  attachments: readWorkerHandoffAttachments,
  submit: submitWorkerResponse,
  returnToPerson: returnHandoffToPerson,
  fail: failWorkerHandoff,
  onEvent: onNonApiAiEvent,
});

export const CLAUDE_TASK_STATUS_CHANNEL = 'get-claude-task-status';
// Only these stops are shown to the person; anything else just retries quietly.
export const CLAUDE_TASK_PAUSE_CODES = Object.freeze(['CLAUDE_USAGE_LIMIT', 'CLAUDE_NOT_SIGNED_IN', 'CLAUDE_CLI_MISSING', PARALLEL_EXHAUSTED_CODE, OFFLOAD_CREDIT_CODE]);
export const CLAUDE_TASK_ACTIVITY_CHANNEL = 'get-claude-task-activity';
export const CLAUDE_TASK_ACTIVITY_EVENT = 'claude-task:activity';

let current = null;

/** What the dock may show: whether the worker is held up, and why. No task or prompt data. */
export function claudeTaskStatusView(workerStatus) {
  const pauseCode = CLAUDE_TASK_PAUSE_CODES.includes(workerStatus?.pauseCode) ? workerStatus.pauseCode : null;
  const providerNotice = typeof workerStatus?.providerNotice === 'string' && workerStatus.providerNotice ? workerStatus.providerNotice : null;
  const searchNotice = typeof workerStatus?.searchNotice === 'string' && workerStatus.searchNotice ? workerStatus.searchNotice : null;
  return Object.freeze({ paused: Boolean(pauseCode), pauseCode, ...(providerNotice ? { providerNotice } : {}), ...(searchNotice ? { searchNotice } : {}) });
}

export function claudeTaskWorkerStatus() {
  return claudeTaskStatusView(current?.status());
}

/** Let the renderer ask whether AI work is paused. */
export function registerClaudeTaskStatusHandler({ ipcMain, status = claudeTaskWorkerStatus } = {}) {
  ipcMain.removeHandler?.(CLAUDE_TASK_STATUS_CHANNEL);
  ipcMain.handle(CLAUDE_TASK_STATUS_CHANNEL, () => status());
}

/** The dock's live steps for every handoff the worker knows about. */
export function claudeTaskWorkerActivity() {
  return withStandaloneActivity(current?.activity() || { at: Date.now(), running: 0, waiting: 0, paused: false, pauseCode: null, tasks: {} });
}

function withStandaloneActivity(snapshot) {
  return {
    ...snapshot,
    held: heldClaudeKeys(),
    usageLimit: claudeUsageLimit(),
    // Cached only: an activity push must never wait on the CLI.
    claudeAccounts: listClaudeAccountsCached(),
    tasks: { ...snapshot.tasks, ...standaloneClaudeActivity.snapshot().tasks },
  };
}

const nodeOfPauseKey = key => (typeof key === 'string' && key.startsWith('node:') ? key.slice('node:'.length) : null);

/** Re-run the worker's pump now, e.g. after the system wakes from sleep. */
export function wakeClaudeTaskWorker() { current?.pump(); }

/** Hold, release and drain every Claude call, from the panel's one control. */
export function registerClaudePauseHandlers({ ipcMain } = {}) {
  const handlers = {
    'claude-pause:hold': ({ key }) => { holdClaude(key); return { held: isClaudeHeld(key) }; },
    'claude-pause:release': ({ key }) => { releaseClaude(key); return { held: false }; },
    // Resolves once no call for this key is still running, its answer saved.
    'claude-pause:drain': async ({ key }) => {
      const nodeId = nodeOfPauseKey(key);
      await (nodeId ? current?.drain(nodeId) : drainClaudeCalls(key));
      return { drained: true };
    },
    'claude-pause:stop-running': ({ key }) => { if (nodeOfPauseKey(key)) current?.stopRunning(nodeOfPauseKey(key)); return { stopped: true }; },
  };
  // Try now instead of waiting for the reset. A limit that still stands simply reports itself again.
  ipcMain.removeHandler?.('claude-usage:resume-now');
  ipcMain.handle('claude-usage:resume-now', () => { clearClaudeUsageLimit('resume-now'); current?.resumeNow(); return { resumed: true }; });
  // Signed-in Claude accounts: each one is its own CLAUDE_CONFIG_DIR.
  const accountHandlers = {
    'claude-accounts:list': () => listClaudeAccounts(),
    'claude-accounts:add': () => addClaudeAccount(),
    'claude-accounts:remove': ({ id } = {}) => removeClaudeAccount(id),
    'claude-accounts:cancel-login': () => cancelClaudeAccountLogin(),
  };
  for (const [channel, handler] of Object.entries(accountHandlers)) {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (_event, args) => handler(args ?? {}));
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, (_event, args) => (isClaudePauseKey(args?.key) ? handler(args) : { error: 'Unknown pause key.' }));
  }
}

export function registerClaudeTaskActivityHandler({ ipcMain, activity = claudeTaskWorkerActivity } = {}) {
  ipcMain.removeHandler?.(CLAUDE_TASK_ACTIVITY_CHANNEL);
  ipcMain.handle(CLAUDE_TASK_ACTIVITY_CHANNEL, () => activity());
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
  onActivityChange = null,
  isHeld = nodeId => isClaudeHeld(`node:${nodeId}`),
  onUsageLimit = () => {},
  routeFor = task => routedCall(`task:${task}`),
  offloadCall = offloadTextCall,
  shadow = createShadowMeasure(),
  shadowValidator = workerShadowValidator,
  // Parallel's free MCP needs no key, so it is on unless `enabled` says otherwise: tests turn it off,
  // and it reports off for ten minutes after a reply says Parallel is out of usage. A Parallel web
  // task waits for that pause to pass; a built-in-web task never asks, as its own search remains.
  parallel = { enabled: async () => !parallelBlocked(), readKey: readParallelKey, plainLeads: parallelPlainLeads },
} = {}) {
  const allowTasks = new Set(taskIds);
  // Requests whose attempt actually ran on Claude (not a routed provider), so a
  // failure knows whether the spend it reports is Claude's.
  const claudeAttempts = new Set();
  const running = new Map();
  const failures = new Map();
  let pausedUntil = 0;
  let pauseCode = null;
  let pausedAt = null;
  let pausedCode = null;
  let timer = null;
  let activityTimer = null;
  let stopped = false;
  let unsubscribe = null;
  let unsubscribeHolds = null;
  const drains = new Set();
  // Streamed deltas arrive many times a second; the dock needs at most two a second.
  const activity = createClaudeTaskActivity({
    now,
    onChange() {
      if (!onActivityChange || stopped || activityTimer) return;
      activityTimer = setTimer(() => {
        activityTimer = null;
        try { onActivityChange(activity.snapshot()); } catch { /* reporting cannot affect a task */ }
      }, ACTIVITY_NOTIFY_MS);
    },
  });

  function wakeIn(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; pump(); }, Math.max(0, ms));
  }

  function pause(code, ms, resetsAt = null) {
    pausedUntil = Math.max(pausedUntil, now() + ms);
    if (pauseCode !== code) {
      const resetIso = Number.isFinite(resetsAt) && !Number.isNaN(new Date(resetsAt).getTime()) ? new Date(resetsAt).toISOString() : null;
      logger.warn(`[Claude tasks] Paused (${code})${resetIso ? ` until ${resetIso}` : ''}.`);
    }
    if (pausedAt === null) pausedAt = now();
    pausedCode = code;
    pauseCode = code;
    activity.setPause(true, code);
    wakeIn(ms);
  }

  // A failed attempt still spent Claude's tokens, so its cost is logged the same
  // way a success's is. Reporting must never disturb a retry or a pause.
  function recordFailedUsage(entry, error) {
    try {
      const spent = error?.detail;
      const usage = spent?.usage && typeof spent.usage === 'object' ? spent.usage : null;
      const costUsd = typeof spent?.costUsd === 'number' ? spent.costUsd : null;
      if (!usage && costUsd === null) return;
      const profile = profileFor(entry.task);
      if (!profile) return;
      recordUsage({
        at: new Date(now()).toISOString(), task: entry.task, model: profile.model, effort: profile.effort,
        usage: usage ?? undefined, costUsd: costUsd ?? undefined, provider: 'claude',
        outcome: 'failed', code: error?.code ?? null,
      });
    } catch { /* usage reporting cannot change what a failure does */ }
  }

  function handleFailure(entry, error) {
    if (claudeAttempts.delete(entry.requestId)) recordFailedUsage(entry, error);
    if (error?.code === 'CLAUDE_CANCELLED') return activity.released(entry.requestId);
    if (error?.code === 'CLAUDE_USAGE_LIMIT') {
      activity.released(entry.requestId);
      const reported = onUsageLimit({
        resetsAt: error.detail?.resetsAt ?? null,
        task: entry.task,
        accountId: error.detail?.accountId ?? null,
        limitType: error.detail?.limitType ?? null,
      });
      // Another signed-in account has usage: this request runs again there at once,
      // which is a switch, not a failed attempt.
      if (reported?.paused === false) { wakeIn(0); return; }
      return pause(error.code, Number.isFinite(error.detail?.resetsAt) ? claudeUsageWaitMs(error.detail.resetsAt, now()) : USAGE_LIMIT_WAIT_MS, error.detail?.resetsAt ?? null);
    }
    if (error?.code === 'CLAUDE_NOT_SIGNED_IN' || error?.code === 'CLAUDE_CLI_MISSING') { activity.released(entry.requestId); return pause(error.code, RETRY_BASE_MS * 2); }
    if (error?.code === PARALLEL_EXHAUSTED_CODE) {
      // Parallel Search is out of usage and no other search may answer, so this
      // request waits for credits in the queue: no failed attempt, nothing given up.
      failures.delete(entry.requestId);
      activity.released(entry.requestId);
      return pause(error.code, PARALLEL_PAUSE_MS);
    }
    if (error?.code === OFFLOAD_CREDIT_CODE) {
      // DeepSeek is out of credit and Claude may not answer a routed task, so this
      // request waits in the queue for a top-up: no failed attempt, nothing given up.
      failures.delete(entry.requestId);
      activity.released(entry.requestId);
      return pause(error.code, OFFLOAD_PAUSE_MS);
    }
    if (error?.code === CLAUDE_PROMPT_TOO_LONG) {
      // No retry or manual paste can make this prompt fit, so its caller is told.
      failures.delete(entry.requestId);
      logger.warn(`[Claude tasks] '${entry.task}' prompt is too long.`);
      seam.fail({ requestId: entry.requestId, error });
      return;
    }
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
      activity.failed(entry.requestId, { code: error.code, attempts: failure.attempts, retryAt: now() });
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
    activity.failed(entry.requestId, { code: error?.code, attempts: failure.attempts, retryAt: failure.notBefore });
    wakeIn(delay);
  }

  async function imagesFor(entry) {
    if (!entry.hasAttachments) return [];
    const files = await seam.attachments({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks });
    const images = (files?.attachments || []).map(file => prepareImage(file));
    if (!files || images.some(image => !image)) throw Object.assign(new Error('A photo could not be read.'), { code: 'CLAUDE_TASK_IMAGE' });
    return images.map((image, i) => ({ ...image, label: `Photo ${i + 1}` }));
  }

  /** The Parallel API key for one web task, or '' (the anonymous server) when there is none. */
  async function parallelKeyForTask() {
    try { return typeof parallel.readKey === 'function' ? (await parallel.readKey()) || '' : ''; } catch { return ''; }
  }

  /**
   * The tool-result callback every Parallel web task's stage gets. A Parallel tool that reports a
   * limit means that search cannot go on, so the limit is noted (the dock and the next task see it)
   * and the exhaustion error ends the stage, which pauses the worker with the queued work kept.
   */
  function parallelToolResult({ toolName, isError, text }) {
    if (!isParallelToolName(toolName) || isError !== true || !isParallelLimitSignal({ text })) return;
    noteParallelLimit({ text }, now());
    throw parallelExhaustedError();
  }

  /** False while Parallel is out of usage: a Parallel web task then waits instead of being answered elsewhere. */
  async function parallelAvailable() {
    try { return typeof parallel.enabled === 'function' ? (await parallel.enabled()) !== false : true; } catch { return false; }
  }

  /**
   * Official-posting research: the Parallel reply plus a plain Parallel search per job (no AI), merged.
   * Measured on 2026-11-14, two seeds, 30 confirmed postings: built-in web search found 18 and 18,
   * Parallel 28 and 27, both together 28 and 28, so the single Parallel reply carries the search and
   * the plain leads only add pages it did not name. There is no built-in fallback: a Parallel limit
   * pauses the worker instead.
   */
  async function researchPosting({ prompt, claudeCall, key, signal }) {
    const members = officialPostingResearchMembers(prompt);
    const [lookup, plain] = await Promise.allSettled([
      claudeCall(),
      Promise.all(members.map(async member => [member.id, await parallel.plainLeads({ member, key, signal })])),
    ]);
    if (lookup.status === 'rejected') throw lookup.reason;
    const reply = lookup.value;
    const merged = mergeOfficialPostingResearchReplies({
      ids: members.map(member => member.id),
      replies: [reply.text],
      extraLeads: plain.status === 'fulfilled' ? Object.fromEntries(plain.value) : {},
    });
    // No member list (an unexpected prompt) or nothing valid: the answer as it came.
    return members.length && merged ? { ...reply, text: merged } : reply;
  }

  async function serve(entry, controller) {
    const profile = profileFor(entry.task);
    // The profile's tools decide the search: Parallel's MCP tools, Claude's built-in web tools, or
    // neither. Only a Parallel web task waits on Parallel; the built-in-web task named in
    // BUILT_IN_WEB_TASKS is never paused for it, since its own search still answers. While Parallel
    // is out of usage the entry stays queued: nothing is failed or dropped, and the owner's Resume
    // or the ten minutes retry it.
    const searchKind = toolSearchKind(profile.tools);
    if (searchKind.usesParallel && !(await parallelAvailable())) {
      activity.released(entry.requestId);
      return pause(PARALLEL_EXHAUSTED_CODE, PARALLEL_PAUSE_MS);
    }
    const comparisonProvenance = entry.comparisonGroup ? {
      version: 2, transport: 'worker', observed: true, comparisonGroup: entry.comparisonGroup, comparisonRun: entry.comparisonRun,
      // Every answer is its own session, which is the isolation the comparison needs.
      conversationKey: crypto.randomBytes(32).toString('hex'), isolated: true,
    } : null;
    const handoff = seam.read({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks, ...(comparisonProvenance ? { comparisonProvenance } : {}) });
    if (!handoff?.ok) return;
    seam.assigned({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks });
    // A routed task is DeepSeek's alone: its failure is thrown to handleFailure (a credit pause, or a
    // failed attempt with backoff) and a rejected answer is corrected by DeepSeek again. Claude never answers it.
    const route = !profile.tools && !entry.hasAttachments ? routeFor(entry.task) : null;
    activity.begin(entry.requestId, { task: entry.task, model: route ? route.route : profile.model, effort: route ? route.reasoning : profile.effort, maxTurns: profile.tools ? RESEARCH_MAX_TURNS : null, rejections: entry.rejections, nodeId: entry.nodeId });
    const cached = cachedPromptParts(handoff.prompt, handoff.cachedPrefix);
    let reply = null;
    let provider = 'claude';
    if (route) {
      reply = await offloadCall({
        messages: handoffMessages(cached), route: route.route, reasoning: route.reasoning, tag: entry.task, signal: controller.signal,
      });
      provider = 'offload';
    } else {
      const pageImages = await imagesFor(entry);
      const stage = binding();
      // Marked before the call so a failure is known to carry Claude's spend.
      claudeAttempts.add(entry.requestId);
      const key = searchKind.usesParallel ? await parallelKeyForTask() : '';
      const claudeCall = () => runStage({
        ...stage, ...cached, env: cached.systemAppend ? stage.env : { ...stage.env, DISABLE_PROMPT_CACHING: '1' },
        pageImages, signal: controller.signal,
        onActivity: event => activity.event(entry.requestId, event),
        model: profile.model, effort: profile.effort, persistSession: false,
        // Ultracode is off unless a profile records the opt-in.
        ...(profile.ultracode === true ? { ultracode: true } : {}),
        // A web task gets its profile's tools and the research turn budget. Only a Parallel web task
        // gets Parallel's MCP server and the tool-result callback that ends the stage on a limit; and
        // only the task named in BUILT_IN_WEB_TASKS may pass allowBuiltInWebTools, the runner's
        // guard still refuses Claude's built-in web tools for every other task.
        ...(profile.tools ? {
          tools: profile.tools.split(','), maxTurns: RESEARCH_MAX_TURNS,
          ...(searchKind.usesParallel ? { mcpServers: parallelMcpServers(key), onToolResult: parallelToolResult } : {}),
          ...(BUILT_IN_WEB_TASKS.includes(entry.task) ? { allowBuiltInWebTools: true } : {}),
        } : {}),
      });
      // Official-posting research merges the plain Parallel leads with its single reply; every other
      // web task is that reply as it came.
      reply = entry.task === OFFICIAL_POSTING_RESEARCH_TASK && !entry.hasAttachments
        ? await researchPosting({ prompt: handoff.prompt, claudeCall, key, signal: controller.signal })
        : await claudeCall();
    }
    recordUsage(provider === 'offload'
      ? { at: new Date(now()).toISOString(), task: entry.task, model: reply.model, effort: route.reasoning, usage: reply.usage, costUsd: reply.costUsd, provider, route: route.route, reasoning: route.reasoning }
      : { at: new Date(now()).toISOString(), task: entry.task, model: reply.model, effort: profile.effort, usage: reply.usage, costUsd: reply.costUsd, provider });
    claudeAttempts.delete(entry.requestId);
    failures.delete(entry.requestId);
    if (provider === 'claude' || pauseCode === OFFLOAD_CREDIT_CODE) {
      // An answer proves its provider is usable again, which is what ends a pause notice.
      pauseCode = null;
      pausedAt = null;
      activity.setPause(false, null);
    }
    activity.checking(entry.requestId);
    // The validator is taken before the submit, which may settle the request.
    let shadowValidate = null;
    if (provider === 'claude' && shadow.enabled && !profile.tools && !entry.hasAttachments) {
      try { shadowValidate = shadowValidator({ requestId: entry.requestId, handoffCode: entry.handoffCode, allowTasks }); } catch { shadowValidate = null; }
    }
    const outcome = await seam.submit({ requestId: entry.requestId, handoffCode: entry.handoffCode, response: reply.text, allowTasks });
    if (provider === 'claude') {
      // The exact request that produced this answer, so a future model can
      // re-answer it offline. Recording never changes what the task does.
      try {
        recordAiReplaySample({
          at: new Date(now()).toISOString(),
          task: entry.task,
          stage: null,
          attempt: entry.rejections || 0,
          text: cached.text,
          systemAppend: cached.systemAppend,
          model: reply.model ?? null,
          requestedModel: profile.model ?? null,
          effort: profile.effort ?? null,
          tools: profile.tools ?? null,
          costUsd: reply.costUsd ?? null,
          usage: reply.usage ?? null,
          durationMs: reply.durationMs ?? null,
          answer: reply.text,
          outcome: outcome?.outcome === 'accepted' || outcome?.outcome === 'rejected' ? outcome.outcome : null,
          validationCode: outcome?.validationCode ?? null,
        });
      } catch { /* recording cannot change or fail the task */ }
    }
    if (shadowValidate) {
      try {
        shadow.measure({
          kind: 'task', id: entry.task, messages: handoffMessages(cached), validate: shadowValidate,
          claude: { model: reply.model, effort: profile.effort, costUsd: reply.costUsd ?? null, durationMs: reply.durationMs ?? null,
            outcome: outcome?.outcome ?? null, validationCode: outcome?.validationCode ?? null },
          texts: { claude: reply.text },
        });
      } catch { /* shadow measurement never affects the task */ }
    }
    if (outcome?.outcome === 'rejected') activity.rejected(entry.requestId);
    else activity.released(entry.requestId);
    if (outcome?.retryAfterMs > 0) wakeIn(outcome.retryAfterMs);
  }

  const runningFor = nodeId => [...running.values()].filter(run => run.nodeId === nodeId);

  function settleDrains() {
    for (const drain of [...drains]) {
      if (!runningFor(drain.nodeId).length) { drains.delete(drain); drain.resolve(); }
    }
  }

  function pump() {
    if (stopped) return;
    const snapshot = seam.list({ allowTasks });
    const live = new Set([...snapshot.handoffs.map(entry => entry.requestId), ...snapshot.settlingRequestIds]);
    for (const [requestId, run] of running) if (!live.has(requestId)) run.controller.abort();
    for (const requestId of failures.keys()) if (!live.has(requestId)) failures.delete(requestId);
    for (const requestId of [...claudeAttempts]) if (!live.has(requestId)) claudeAttempts.delete(requestId);
    activity.prune(live);
    if (snapshot.retryAfterMs > 0) wakeIn(snapshot.retryAfterMs);
    // A handoff past its backoff, or past a slot limit, is waiting for a turn.
    for (const entry of snapshot.handoffs) {
      if (!running.has(entry.requestId) && profileFor(entry.task) && (failures.get(entry.requestId)?.notBefore || 0) <= now()) {
        activity.queued(entry.requestId, { task: entry.task, issuedAt: entry.issuedAt, nodeId: entry.nodeId });
      }
    }
    // Anything else may have replaced the wake timer, so a pause re-arms its own.
    if (now() < pausedUntil) { wakeIn(pausedUntil - now()); return; }
    if (pausedAt !== null) {
      const minutes = Math.max(0, Math.round((now() - pausedAt) / 60_000));
      logger.info(`[Claude tasks] Resumed after ${pausedCode} (paused ${minutes}m).`);
      pausedAt = null;
    }
    activity.setPause(false, null);
    for (const entry of snapshot.handoffs) {
      if (running.size >= concurrency) return;
      if (running.has(entry.requestId) || (failures.get(entry.requestId)?.notBefore || 0) > now() || !profileFor(entry.task)) continue;
      if (isHeld(entry.nodeId)) continue;
      const controller = new AbortController();
      running.set(entry.requestId, { controller, nodeId: entry.nodeId });
      serve(entry, controller)
        .catch(error => handleFailure(entry, error))
        .finally(() => {
          running.delete(entry.requestId);
          settleDrains();
          pump();
        });
    }
  }

  return Object.freeze({
    start() {
      stopped = false;
      unsubscribe = seam.onEvent(pump);
      unsubscribeHolds = subscribeClaudeHolds(pump);
      pump();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribeHolds?.();
      for (const drain of [...drains]) { drains.delete(drain); drain.resolve(); }
      if (timer) clearTimer(timer);
      if (activityTimer) clearTimer(activityTimer);
      activityTimer = null;
      for (const run of running.values()) run.controller.abort();
    },
    status: () => Object.freeze({ running: running.size, retrying: failures.size, paused: now() < pausedUntil, pauseCode,
      searchNotice: parallelSearchNotice() }),
    activity: () => activity.snapshot(),
    // Resolves when this node's running calls have ended and their answers are in.
    drain: nodeId => new Promise((resolve) => {
      drains.add({ nodeId, resolve });
      settleDrains();
    }),
    stopRunning(nodeId) { for (const run of runningFor(nodeId)) run.controller.abort(); },
    resumeNow() {
      pausedUntil = 0;
      pauseCode = null;
      pausedAt = null;
      // Resume also drops the Parallel block, so a web task retries Parallel at once.
      resetParallelLimit();
      activity.setPause(false, null);
      pump();
    },
    pump,
  });
}

/** Start answering AI tasks with Claude for this process. */
export function startClaudeTaskWorker({ userData, nativeImage = null, getAllWindows = () => [] } = {}) {
  // Samples and usage rows live beside the worker's own usage log.
  configureAiRecording({ userData });
  const usageFile = userData ? path.join(userData, CLAUDE_TASK_USAGE_FILE) : null;
  const broadcast = (snapshot) => {
    for (const win of getAllWindows() || []) {
      try {
        if (!win || win.isDestroyed?.()) continue;
        const contents = win.webContents;
        if (!contents || contents.isDestroyed?.()) continue;
        contents.send(CLAUDE_TASK_ACTIVITY_EVENT, snapshot);
      } catch { /* a closing window cannot fail a task */ }
    }
  };
  let standaloneTimer = null;
  const scheduleBroadcast = () => {
    if (standaloneTimer) return;
    standaloneTimer = setTimeout(() => { standaloneTimer = null; broadcast(claudeTaskWorkerActivity()); }, ACTIVITY_NOTIFY_MS);
    standaloneTimer.unref?.();
  };
  const unsubscribers = [
    subscribeStandaloneClaudeActivity(scheduleBroadcast),
    subscribeClaudeHolds(scheduleBroadcast),
    // A switched or limited account changes the dock and the pause notice alike.
    subscribeClaudeAccounts(() => {
      if (current) current.pump();
      scheduleBroadcast();
    }),
  ];
  // Learn each account's email and sign-in once, so a later pause notice can name it.
  void listClaudeAccounts().catch(() => {});
  const base = createClaudeTaskWorker({
    prepareImage: attachment => prepareTaskImage(attachment, nativeImage),
    onActivityChange: snapshot => broadcast(withStandaloneActivity(snapshot)),
    onUsageLimit: reportClaudeUsageLimit,
    recordUsage: (row) => {
      if (usageFile) void fs.promises.appendFile(usageFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }).catch(() => {});
    },
  });
  const worker = Object.freeze({
    ...base,
    stop() {
      base.stop();
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (standaloneTimer) clearTimeout(standaloneTimer);
      standaloneTimer = null;
      if (current === worker) current = null;
    },
  });
  current = worker;
  worker.start();
  logger.info('[Claude tasks] Worker started.');
  return worker;
}
