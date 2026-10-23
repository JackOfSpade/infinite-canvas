import { APPLICATION_ROUTE_CLAUDE_RUNNER } from './applicationRuleTally.js';
// Main-process Claude Code application runner.
//
// Application-bundle stages are answered through the local Claude Code CLI in
// headless mode: the latest Opus writes and judges, the latest Sonnet
// converts, repairs and fact-checks (CLAUDE_STAGE_PROFILES). Each handoff lane
// (the main lane of a job, or one parallel task) keeps one persisted Claude Code
// session per chat: correction rounds resume it, and the bridge's new-chat rule
// (freshContextRequired / freshContextKey) decides when a fresh session starts.
// Failures are final until the user retries: there is no automatic retry, no
// fallback and no waiting. This module is pure Node (no 'electron' import);
// everything environment-specific is injected so it can be tested with fakes.
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEditorialPlanPrompt, editorialPlanAllowedIds, editorialPlanBinding, parseEditorialPlanResponse, writerPromptWithEditorialPlan } from './applicationEditorialPlan.js';
import { loadEditorialPlan, saveEditorialPlan } from './applicationEditorialPlanArchive.js';

// Claude Code's aliases for the newest model in each line, so a new Sonnet or
// Opus release is used without a code change. The answer is checked by family.
export const CLAUDE_SONNET_MODEL = 'sonnet';
export const CLAUDE_OPUS_MODEL = 'opus';
// The default profile, for any stage the table below does not name.
export const CLAUDE_APPLICATION_MODEL = CLAUDE_SONNET_MODEL;
export const CLAUDE_APPLICATION_EFFORT = 'high';
// Opus where the stage decides the writing (write) or picks it (pick);
// Sonnet for the rule-following repair, trim, fact and conversion stages.
export const CLAUDE_STAGE_PROFILES = Object.freeze({
  'editorial-plan': Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  write: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'xhigh' }),
  pick: Object.freeze({ model: CLAUDE_OPUS_MODEL, effort: 'high' }),
  convert: Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'medium' }),
  'verify-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fit-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-check': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-correction': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
  'fact-recheck': Object.freeze({ model: CLAUDE_SONNET_MODEL, effort: 'high' }),
});
const MODEL_FAMILIES = Object.freeze({
  [CLAUDE_SONNET_MODEL]: Object.freeze({ label: 'Sonnet', id: /^claude-sonnet-/ }),
  [CLAUDE_OPUS_MODEL]: Object.freeze({ label: 'Opus', id: /^claude-opus-/ }),
});

/** The model id in a run's modelUsage that belongs to the requested family, or null. */
export function answeringModel(requested, models) {
  const family = MODEL_FAMILIES[requested];
  const list = Array.isArray(models) ? models : [];
  return list.find(id => (family ? family.id.test(id) : id === requested)) || null;
}

export function claudeStageProfile(stage) {
  return CLAUDE_STAGE_PROFILES[stage] || { model: CLAUDE_APPLICATION_MODEL, effort: CLAUDE_APPLICATION_EFFORT };
}
// Normal Opus write stages take 5-7 minutes; the cap leaves room for Claude
// Code's own recovery after a cut-off API stream.
export const CLAUDE_STAGE_TIMEOUT_MS = 45 * 60_000;
// Appended to every CLI invocation so Claude replies in the format the app's
// validator accepts (no prose around a JSON answer).
export const CLAUDE_HANDOFF_SYSTEM_PROMPT = 'You are answering a structured handoff from a desktop application. When the message asks for a JSON object, reply with only that JSON object, optionally inside one json code fence, with no text before or after it. When it asks for plain text, reply with only the requested text.';
export const CLAUDE_RUNNER_CONCURRENCY = 3;
export const CLAUDE_MAX_RUNS_PER_JOB = 120;
// Activity-only state updates (stream liveness) reach the UI at most this often per job.
export const CLAUDE_ACTIVITY_EMIT_INTERVAL_MS = 5000;

const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const HUMAN_STOP_STAGE = 'write-verify-human-stop';

const MESSAGES = Object.freeze({
  missing: 'Claude Code is not installed or not on PATH. Install it and sign in with your Claude subscription, then retry.',
  usage: 'Claude usage limit reached. Retry this application after your limit resets.',
  login: 'Claude Code is not signed in. Run claude in a terminal and sign in with your Claude subscription, then retry.',
  timeout: minutes => `Claude did not finish this stage within ${minutes} minutes.`,
  cancelled: 'Claude run was cancelled.',
  tooMany: runs => `Stopped after ${runs} Claude runs without finishing this application.`,
});

export class ClaudeRunnerError extends Error {
  constructor(code, message, detail, result) {
    super(message);
    this.name = 'ClaudeRunnerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    // Only the terminal result's plain text belongs here, never the stream's
    // assistant/thinking blocks, signatures, or transcript.
    if (typeof result === 'string') this.result = result;
  }
}

function clip(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

export function claudeCliArgs({
  model = CLAUDE_APPLICATION_MODEL,
  effort = CLAUDE_APPLICATION_EFFORT,
  sessionId,
  resume = false,
} = {}) {
  let sessionArgs = [];
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    sessionArgs = resume === true ? ['--resume', sessionId] : ['--session-id', sessionId];
  }
  return [
    '-p',
    ...sessionArgs,
    '--model', model,
    '--effort', effort,
    '--append-system-prompt', CLAUDE_HANDOFF_SYSTEM_PROMPT,
    '--restricted',
    '--strict-mcp-config',
    '--tools', '',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
  ];
}

function defaultIsExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveClaudeBinary({ env = process.env, homedir = '', isExecutable = defaultIsExecutable } = {}) {
  const candidates = [];
  for (const entry of String(env?.PATH || '').split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, 'claude'));
  }
  if (homedir) candidates.push(path.join(homedir, '.local', 'bin', 'claude'));
  candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  for (const candidate of candidates) {
    let ok = false;
    try { ok = isExecutable(candidate) === true; } catch { ok = false; }
    if (ok) return candidate;
  }
  throw new ClaudeRunnerError('CLAUDE_CLI_MISSING', MESSAGES.missing);
}

export function claudeChildEnv(env = {}, binaryDir = '') {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')) continue;
    out[key] = value;
  }
  if (binaryDir) out.PATH = out.PATH ? `${binaryDir}${path.delimiter}${out.PATH}` : binaryDir;
  return out;
}

export function buildClaudeInputMessage({ text, pageImages } = {}) {
  const content = [{ type: 'text', text: String(text ?? '') }];
  const images = Array.isArray(pageImages) ? pageImages : [];
  images.forEach((image, i) => {
    content.push({ type: 'text', text: `Page image ${i + 1}: candidate ${image?.candidateId}, ${image?.document}` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image?.mimeType || 'image/png', data: image?.data },
    });
  });
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

export function parseClaudeStreamOutput(stdoutText) {
  const lines = String(stdoutText ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object' || obj.type !== 'result') continue;
    return {
      isError: obj.is_error === true || obj.subtype !== 'success',
      subtype: obj.subtype,
      result: typeof obj.result === 'string' ? obj.result : '',
      apiErrorStatus: obj.api_error_status ?? null,
      models: Object.keys(obj.modelUsage || {}),
      sessionId: obj.session_id,
      durationMs: obj.duration_ms,
    };
  }
  return null;
}

const USAGE_RE = /usage limit|limit reached|hit your limit|rate.?limit|out of (extra )?usage/i;
const LOGIN_RE = /not logged in|log ?in|\/login|authenticat|credential|invalid api key/i;
// These are provider error sentences, not a keyword detector. A normal answer
// or an incidental mention of safeguards cannot establish a blocked request.
const SAFEGUARD_ERROR_RE = /^(?:API Error:\s*)?(?:(?:Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)*['’]s safeguards flagged this message\b|Your (?:request|message) (?:was|has been) blocked by (?:our |the )?safeguards\b)/iu;

function plainSafeguardStderr(stderr) {
  const text = stderr.trim();
  if (!SAFEGUARD_ERROR_RE.test(text)) return '';
  // Only a recognized plain provider error may be retained from stderr. Do
  // not bring along any following JSON stream record or reasoning block.
  const lines = text.split(/\r?\n/u);
  const streamAt = lines.findIndex(line => /^\s*(?:\[|\{|<\/?(?:thinking|analysis|redacted_thinking)\b)/iu.test(line));
  return (streamAt < 0 ? lines : lines.slice(0, streamAt)).join('\n').trim();
}

export function classifyClaudeFailure({ parsed, stderr, exitCode } = {}) {
  const resultText = typeof parsed?.result === 'string' ? parsed.result : '';
  const stderrText = String(stderr ?? '');
  const combined = `${resultText}\n${stderrText}`;
  const clipped = clip(resultText.trim() ? resultText : stderrText);
  const detail = { exitCode: exitCode ?? null, subtype: parsed?.subtype ?? null, apiErrorStatus: parsed?.apiErrorStatus ?? null,
    models: parsed?.models ?? [], durationMs: parsed?.durationMs ?? null };
  if (parsed?.apiErrorStatus === 429 || USAGE_RE.test(combined)) {
    return new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', clipped ? `${MESSAGES.usage} (${clipped})` : MESSAGES.usage, detail, resultText);
  }
  if (LOGIN_RE.test(combined)) {
    return new ClaudeRunnerError('CLAUDE_NOT_SIGNED_IN', MESSAGES.login, detail, resultText);
  }
  const providerText = resultText.trim() || plainSafeguardStderr(stderrText);
  if (SAFEGUARD_ERROR_RE.test(providerText)) {
    const category = providerText.match(/\bDetails:\s*`\[([a-z][a-z_]{0,79})\]`/u)?.[1];
    const requestId = providerText.match(/\bRequest ID:\s*(req_[A-Za-z0-9]{8,120})\b/u)?.[1];
    const messageId = providerText.match(/\bMessage ID:\s*(msg_[A-Za-z0-9]{8,120})\b/u)?.[1];
    return new ClaudeRunnerError('CLAUDE_SAFEGUARD_BLOCKED',
      'Claude blocked this request with its safeguards. The private run log contains the provider message. Review the request before retrying.',
      { ...detail, ...(category ? { refusalCategory: category } : {}), ...(requestId ? { requestId } : {}), ...(messageId ? { messageId } : {}) },
      resultText.trim() ? resultText : providerText);
  }
  return new ClaudeRunnerError(
    'CLAUDE_ERROR',
    `Claude Code failed (exit ${exitCode ?? 'unknown'})${clipped ? `: ${clipped}` : ''}`,
    detail,
    resultText,
  );
}

export function runClaudeStage({
  text,
  pageImages,
  signal,
  binary,
  env,
  cwd,
  model = CLAUDE_APPLICATION_MODEL,
  effort = CLAUDE_APPLICATION_EFFORT,
  sessionId,
  resume = false,
  spawnImpl = childProcess.spawn,
  timeoutMs = CLAUDE_STAGE_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled));
      return;
    }
    let child;
    try {
      child = spawnImpl(binary, claudeCliArgs({ model, effort, sessionId, resume }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error?.code === 'ENOENT'
        ? new ClaudeRunnerError('CLAUDE_CLI_MISSING', MESSAGES.missing)
        : new ClaudeRunnerError('CLAUDE_ERROR', `Claude Code could not start: ${clip(error?.message || error)}`));
      return;
    }

    let settled = false;
    let timer = null;
    let killTimer = null;
    let killed = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const onAbort = () => {
      killChild();
      finish(new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled));
    };

    function killChild() {
      if (killed) return;
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeoutImpl(() => {
        killTimer = null;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      killTimer?.unref?.();
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (timer !== null) { clearTimeoutImpl(timer); timer = null; }
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve(value);
    }

    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeoutImpl(() => {
      timer = null;
      killChild();
      finish(new ClaudeRunnerError('CLAUDE_TIMEOUT', MESSAGES.timeout(Math.round(timeoutMs / 60000))));
    }, timeoutMs);
    timer?.unref?.();

    child.on('error', error => {
      if (error?.code === 'ENOENT') finish(new ClaudeRunnerError('CLAUDE_CLI_MISSING', MESSAGES.missing));
      else finish(new ClaudeRunnerError('CLAUDE_ERROR', `Claude Code could not run: ${clip(error?.message || error)}`));
    });

    child.stdout?.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += buffer.length;
      if (stdoutBytes > OUTPUT_CAP_BYTES) {
        killChild();
        finish(new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code produced more than 16 MB of output.'));
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr?.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stderrBytes += buffer.length;
      if (stderrBytes > OUTPUT_CAP_BYTES) {
        killChild();
        finish(new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code produced more than 16 MB of error output.'));
        return;
      }
      stderrChunks.push(buffer);
    });

    child.on('close', (code, closeSignal) => {
      if (killTimer !== null) { clearTimeoutImpl(killTimer); killTimer = null; }
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exitCode = code ?? (closeSignal ? closeSignal : null);
      const parsed = parseClaudeStreamOutput(stdout);
      if (!parsed || parsed.isError || code !== 0) {
        finish(classifyClaudeFailure({ parsed, stderr, exitCode }));
        return;
      }
      const answered = answeringModel(model, parsed.models);
      if (!answered) {
        finish(new ClaudeRunnerError(
          'CLAUDE_WRONG_MODEL',
          `Claude answered with ${parsed.models.join(', ')} instead of ${MODEL_FAMILIES[model]?.label || model}.`,
          { models: parsed.models, subtype: parsed.subtype, apiErrorStatus: parsed.apiErrorStatus, exitCode, durationMs: parsed.durationMs },
          parsed.result,
        ));
        return;
      }
      if (!parsed.result.trim()) {
        finish(new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code returned an empty answer.',
          { models: parsed.models, subtype: parsed.subtype, apiErrorStatus: parsed.apiErrorStatus, exitCode, durationMs: parsed.durationMs }, parsed.result));
        return;
      }
      finish(null, { text: parsed.result, model: answered, durationMs: parsed.durationMs });
    });

    if (child.stdin) {
      child.stdin.on?.('error', () => { /* a dead child reports through close */ });
      try {
        child.stdin.end(buildClaudeInputMessage({ text, pageImages }));
      } catch (error) {
        killChild();
        finish(new ClaudeRunnerError('CLAUDE_ERROR', `Claude Code input could not be written: ${clip(error?.message || error)}`));
      }
    }
  });
}

function createSemaphore(size) {
  const limit = Math.max(1, Number.isFinite(size) ? Math.floor(size) : 1);
  let active = 0;
  const waiters = [];
  function release() {
    active -= 1;
    while (waiters.length && active < limit) {
      const waiter = waiters.shift();
      active += 1;
      waiter.grant();
    }
  }
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled));
    if (active < limit) {
      active += 1;
      return Promise.resolve(onceRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => { signal?.removeEventListener?.('abort', onAbort); resolve(onceRelease()); },
      };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  }
  function onceRelease() {
    let done = false;
    return () => { if (!done) { done = true; release(); } };
  }
  return { acquire };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isEnoent(error) {
  return error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message || ''));
}

function applicationError(error) {
  return new ClaudeRunnerError(
    'APPLICATION_ERROR',
    clip(error?.message || String(error || 'Application step failed.')) || 'Application step failed.',
    error?.code,
  );
}

function handoffCodeOf(handoff) {
  return handoff?.handoffCode ?? handoff?.code;
}

const MAX_CORRECTION_ITEMS = 30;
const MAX_CORRECTION_CHARS = 1500;

// Head 65 percent, an ellipsis, then the tail (like framing.js clipCorrectionItem).
function clipCorrection(value, max = MAX_CORRECTION_CHARS) {
  const text = String(value);
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = max - head - 1;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

// A rejected handoff always reaches Claude with every correction item: the
// app's correction prompt may be the original prompt verbatim, so any item it
// does not already contain is appended as a numbered list.
function chooseText(handoff) {
  const corrections = Array.isArray(handoff?.corrections)
    ? handoff.corrections.filter(item => typeof item === 'string' && item.length > 0)
    : [];
  const prompt = typeof handoff?.prompt === 'string' ? handoff.prompt : '';
  const correctionPrompt = handoff?.correctionPrompt;
  const base = (corrections.length > 0 && typeof correctionPrompt === 'string' && correctionPrompt.trim() && correctionPrompt !== handoff?.prompt)
    ? correctionPrompt
    : prompt;
  const missing = corrections.filter(item => !base.includes(item)).slice(0, MAX_CORRECTION_ITEMS);
  if (!missing.length) return base;
  const what = missing.length === 1 ? 'this item' : `these ${missing.length} items`;
  return `${base}\n\nYour previous response to this handoff was rejected by the app. Fix ${what} and reply again with the complete corrected response:\n`
    + missing.map((item, i) => `${i + 1}. ${clipCorrection(item)}`).join('\n');
}

function createProductionRunStage({ workspaceDir, fsImpl }) {
  let bound = null;
  return async ({ text, pageImages, signal, stage, sessionId, resume, onThinkingSummary, onActivity }) => {
    if (!bound) {
      if (workspaceDir) await fsImpl.mkdir(workspaceDir, { recursive: true });
      const binary = resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
      bound = { binary, env: claudeChildEnv(process.env, path.dirname(binary)), cwd: workspaceDir || os.tmpdir() };
    }
    const { runClaudeSdkStage } = await import('./claudeApplicationSdkStage.js');
    return runClaudeSdkStage({ text, pageImages, signal, sessionId, resume, onThinkingSummary, onActivity, ...bound, ...claudeStageProfile(stage) });
  };
}

const FRESH_CONTEXT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// freshContextRequired / freshContextKey are non-enumerable on the app's
// handoff object, so they are read directly, never through a spread or JSON.
function freshContextKeyOf(handoff) {
  const key = handoff?.freshContextKey;
  return typeof key === 'string' && FRESH_CONTEXT_KEY_RE.test(key) ? key : null;
}

/** Mirrors the bridge engine's requiresFreshContextBoundary rule for one lane. */
function needsFreshSession(lane, handoff, key) {
  if (!lane.started) return true;
  if (handoff?.freshContextRequired !== true) return false;
  if (key !== null) return key !== lane.contextKey;
  return typeof lane.stage === 'string' && handoff?.stage !== lane.stage;
}

function sanitizeLane(value) {
  if (!value || typeof value !== 'object' || !SESSION_ID_RE.test(String(value.sessionId || ''))) return null;
  return {
    sessionId: value.sessionId,
    started: value.started === true,
    contextKey: typeof value.contextKey === 'string' ? value.contextKey : null,
    stage: typeof value.stage === 'string' ? value.stage : null,
    ...(value.editorialPlanned === true ? { editorialPlanned: true } : {}),
  };
}

// Errors may contain transport objects or a raw stream. Project only the
// small result metadata needed to diagnose a failed invocation.
function auditFailure(error) {
  const failure = { code: clip(error?.code || 'CLAUDE_ERROR', 80), message: clip(error?.message || 'Claude run failed.', 400) };
  const detail = error?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const metadata = {};
    if (Number.isInteger(detail.exitCode) || (typeof detail.exitCode === 'string' && /^SIG[A-Z0-9]+$/u.test(detail.exitCode))) metadata.exitCode = detail.exitCode;
    if (typeof detail.subtype === 'string') metadata.subtype = clip(detail.subtype, 100);
    if (Number.isInteger(detail.apiErrorStatus) && detail.apiErrorStatus >= 100 && detail.apiErrorStatus <= 599) metadata.apiErrorStatus = detail.apiErrorStatus;
    if (Array.isArray(detail.models)) metadata.models = detail.models.filter(model => typeof model === 'string').slice(0, 20).map(model => clip(model, 200));
    if (Number.isFinite(detail.durationMs) && detail.durationMs >= 0) metadata.durationMs = detail.durationMs;
    if (typeof detail.refusalCategory === 'string' && /^[a-z][a-z_]{0,79}$/u.test(detail.refusalCategory)) metadata.refusalCategory = detail.refusalCategory;
    if (typeof detail.requestId === 'string' && /^req_[A-Za-z0-9]{8,120}$/u.test(detail.requestId)) metadata.requestId = detail.requestId;
    if (typeof detail.messageId === 'string' && /^msg_[A-Za-z0-9]{8,120}$/u.test(detail.messageId)) metadata.messageId = detail.messageId;
    if (typeof detail.reason === 'string') metadata.reason = clip(detail.reason, 300);
    if (Array.isArray(detail.errors)) metadata.errors = detail.errors.filter(value => typeof value === 'string').slice(0, 20).map(value => clip(value, 2000));
    if (typeof detail.refusalEvent === 'string') metadata.refusalEvent = clip(detail.refusalEvent, 100);
    if (typeof detail.stopReason === 'string') metadata.stopReason = clip(detail.stopReason, 100);
    for (const key of ['assistantStopReasons', 'assistantErrors']) {
      if (Array.isArray(detail[key])) metadata[key] = detail[key].filter(value => typeof value === 'string').slice(0, 20).map(value => clip(value, 100));
    }
    if (Object.keys(metadata).length) failure.detail = metadata;
  }
  return failure;
}

function defaultRunLogPath(jobId, canvasFilePath) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(String(jobId || '')) || !path.isAbsolute(String(canvasFilePath || ''))) {
    throw Object.assign(new Error('Invalid private audit path.'), { code: 'LOG_PATH_INVALID' });
  }
  return path.join(path.dirname(canvasFilePath), '.local-ai', 'claude-runs', `${jobId}.jsonl`);
}

export function createClaudeApplicationRunner({
  api = {},
  runStage = null,
  stateFile,
  workspaceDir,
  isBridgeLaned = () => false,
  notify = () => {},
  logger = console,
  concurrency = CLAUDE_RUNNER_CONCURRENCY,
  maxRunsPerJob = CLAUDE_MAX_RUNS_PER_JOB,
  now = Date.now,
  fsImpl = fs.promises,
  homedir = os.homedir(),
  // Where each Claude run is recorded as correlated append-only events for later
  // diagnosis. Defaults to <canvas folder>/.local-ai/claude-runs/<jobId>.jsonl, beside the job's
  // other private files; null turns the log off.
  runLogPath = defaultRunLogPath,
  capturePrompts = true,
} = {}) {
  const { getHandoff, submitHandoff, subscribeDiscards } = api;
  const stageRunner = typeof runStage === 'function' ? runStage : createProductionRunStage({ workspaceDir, fsImpl });
  const semaphore = createSemaphore(concurrency);
  const states = new Map();
  const runCounts = new Map();
  // jobId -> time of the last activity-only emit (never part of a state).
  const activityEmits = new Map();
  const drivers = new Map();
  // jobId -> Map(laneKey -> { sessionId, started, contextKey, stage }); laneKey is 'main' or a matchTaskId.
  const sessions = new Map();

  function laneFor(jobId, laneKey) {
    let lanes = sessions.get(jobId);
    if (!lanes) { lanes = new Map(); sessions.set(jobId, lanes); }
    let lane = lanes.get(laneKey);
    if (!lane) { lane = { sessionId: null, started: false, contextKey: null, stage: null }; lanes.set(laneKey, lane); }
    return lane;
  }

  let runLogChain = Promise.resolve();
  function logRun(jobId, canvasFilePath, record) {
    if (typeof runLogPath !== 'function') return Promise.resolve();
    const logError = error => {
      logger?.warn?.(`[ClaudeRunner] could not write the Claude run log: ${clip(error?.code || 'LOG_WRITE_FAILED', 80)}`);
      return new ClaudeRunnerError('CLAUDE_LOG_ERROR', 'The private Claude audit log could not be written. Check the log folder permissions and available disk space, then retry.');
    };
    let file;
    try { file = runLogPath(jobId, canvasFilePath); } catch (error) { return Promise.reject(logError(error)); }
    if (!nonEmptyString(file)) return Promise.reject(logError({ code: 'LOG_PATH_INVALID' }));
    const line = `${JSON.stringify({ ...record, at: new Date(now()).toISOString() })}\n`;
    const write = runLogChain.then(async () => {
      let logDir = path.dirname(file);
      if (runLogPath === defaultRunLogPath) {
        const canvasRoot = await fsImpl.realpath(path.dirname(canvasFilePath));
        logDir = path.join(canvasRoot, '.local-ai', 'claude-runs');
        // Validate each app-owned directory before creating anything inside
        // it. A .local-ai symlink must not redirect even directory creation.
        for (const dir of [path.dirname(logDir), logDir]) {
          try { await fsImpl.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
          const stat = await fsImpl.lstat(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink() || await fsImpl.realpath(dir) !== dir) {
            throw Object.assign(new Error('Audit directory left the canvas.'), { code: 'LOG_PATH_UNTRUSTED' });
          }
        }
        await fsImpl.chmod(logDir, 0o700);
      } else {
        await fsImpl.mkdir(logDir, { recursive: true, mode: 0o700 });
      }
      const dirStat = await fsImpl.lstat(logDir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Object.assign(new Error('Invalid audit directory.'), { code: 'LOG_PATH_UNTRUSTED' });
      const realDir = await fsImpl.realpath(logDir);
      const logFile = path.join(realDir, path.basename(file));
      let fileStat;
      try { fileStat = await fsImpl.lstat(logFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (fileStat && (!fileStat.isFile() || fileStat.isSymbolicLink())) throw Object.assign(new Error('Invalid audit file.'), { code: 'LOG_PATH_UNTRUSTED' });
      const handle = await fsImpl.open(logFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw Object.assign(new Error('Invalid audit file.'), { code: 'LOG_PATH_UNTRUSTED' });
        await handle.chmod(0o600);
        await fsImpl.appendFile(handle, line, { encoding: 'utf8' });
      } finally { await handle.close(); }
    });
    // A failed append must reach its caller, without poisoning later jobs or
    // leaving a rejected background promise for shutdown to discover.
    runLogChain = write.catch(() => {});
    return write.catch(error => { throw logError(error); });
  }

  async function removeTranscripts(sessionIds) {
    const ids = sessionIds.filter(id => SESSION_ID_RE.test(String(id || '')));
    if (!ids.length || !homedir) return;
    const root = path.join(homedir, '.claude', 'projects');
    let dirs;
    try {
      dirs = await fsImpl.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`[ClaudeRunner] could not list Claude projects: ${clip(error?.code || error?.message, 80)}`);
      return;
    }
    for (const dirent of dirs) {
      if (!dirent?.isDirectory?.()) continue;
      const dir = path.join(root, dirent.name);
      for (const id of ids) {
        try {
          await fsImpl.rm(path.join(dir, `${id}.jsonl`), { force: true });
          await fsImpl.rm(path.join(dir, id), { force: true, recursive: true });
        } catch (error) {
          logger?.warn?.(`[ClaudeRunner] could not remove a Claude session transcript: ${clip(error?.code || error?.message, 80)}`);
        }
      }
    }
  }

  async function dropSessions(jobId) {
    const lanes = sessions.get(jobId);
    const hadRuns = runCounts.delete(jobId);
    if (!lanes && !hadRuns) return;
    sessions.delete(jobId);
    const ids = [...(lanes?.values() || [])].map(lane => lane.sessionId).filter(Boolean);
    persist();
    try {
      await removeTranscripts(ids);
    } catch (error) {
      logger?.warn?.(`[ClaudeRunner] could not remove Claude session transcripts: ${clip(error?.code || error?.message, 80)}`);
    }
  }
  let persistChain = Promise.resolve();
  let tempCounter = 0;
  let shuttingDown = false;

  function emit(payload) {
    try { notify(payload); } catch { /* the UI cannot fail a run */ }
  }

  function setState(jobId, canvasFilePath, patch) {
    const previous = states.get(jobId);
    const state = {
      jobId,
      canvasFilePath,
      status: patch.status,
      stage: patch.stage !== undefined ? patch.stage : (previous?.stage ?? null),
      ...(patch.code ? { code: patch.code } : {}),
      ...(patch.message ? { message: patch.message } : {}),
      updatedAt: now(),
      ...((drivers.get(jobId)?.runs ?? runCounts.get(jobId)) > 0 ? { runs: drivers.get(jobId)?.runs ?? runCounts.get(jobId) } : {}),
      ...(patch.reason ? { reason: patch.reason } : {}),
      ...(patch.stop ? { stop: patch.stop } : {}),
    };
    states.set(jobId, state);
    activityEmits.delete(jobId);
    emit({ ...state });
    return state;
  }

  // Liveness from the provider stream. updatedAt stays the stage start (it
  // drives the Elapsed clock); only lastActivityAt moves, emitted throttled.
  function touchActivity(jobId) {
    const state = states.get(jobId);
    if (!state || state.status !== 'running') return;
    const at = now();
    state.lastActivityAt = at;
    const last = activityEmits.get(jobId);
    if (last !== undefined && at - last < CLAUDE_ACTIVITY_EMIT_INTERVAL_MS) return;
    activityEmits.set(jobId, at);
    emit({ ...state });
  }

  function removeState(jobId, canvasFilePath) {
    const previous = states.get(jobId);
    states.delete(jobId);
    activityEmits.delete(jobId);
    emit({ jobId, canvasFilePath: previous?.canvasFilePath ?? canvasFilePath, status: 'done', stage: previous?.stage ?? null, updatedAt: now() });
  }

  function persist() {
    const failed = {};
    for (const [jobId, state] of states) if (state.status === 'failed') failed[jobId] = { ...state };
    const sessionSnapshot = {};
    for (const [jobId, lanes] of sessions) {
      const out = {};
      for (const [laneKey, lane] of lanes) {
        if (!lane.sessionId) continue;
        out[laneKey] = { sessionId: lane.sessionId, started: lane.started === true, contextKey: lane.contextKey ?? null, stage: lane.stage ?? null,
          ...(lane.editorialPlanned === true ? { editorialPlanned: true } : {}) };
      }
      if (Object.keys(out).length) sessionSnapshot[jobId] = out;
    }
    const runs = Object.fromEntries([...runCounts].filter(([, n]) => n > 0));
    const body = `${JSON.stringify({ failed, sessions: sessionSnapshot, ...(Object.keys(runs).length ? { runs } : {}) }, null, 2)}\n`;
    const write = async () => {
      if (!stateFile) return;
      await fsImpl.mkdir(path.dirname(stateFile), { recursive: true });
      tempCounter += 1;
      const temp = `${stateFile}.${process.pid}.${tempCounter}.tmp`;
      await fsImpl.writeFile(temp, body, 'utf8');
      await fsImpl.rename(temp, stateFile);
    };
    persistChain = persistChain.then(write).catch(error => {
      logger?.warn?.(`[ClaudeRunner] could not persist failed applications: ${clip(error?.code || error?.message || error, 80)}`);
    });
    return persistChain;
  }

  async function load() {
    let raw;
    try {
      raw = await fsImpl.readFile(stateFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`[ClaudeRunner] could not read failed applications: ${clip(error?.code || error?.message, 80)}`);
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      logger?.warn?.('[ClaudeRunner] ignoring malformed runner state file');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logger?.warn?.('[ClaudeRunner] ignoring malformed runner state file');
      return;
    }
    const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const newFormat = ('failed' in data || 'sessions' in data || 'runs' in data)
      && data.failed?.status !== 'failed' && data.sessions?.status !== 'failed';
    let failedMap = data;
    if (newFormat) {
      const failedOk = data.failed === undefined || isPlainObject(data.failed);
      const sessionsOk = data.sessions === undefined || isPlainObject(data.sessions);
      if (!failedOk || !sessionsOk) {
        logger?.warn?.('[ClaudeRunner] ignoring malformed runner state file');
        return;
      }
      failedMap = data.failed || {};
      if (isPlainObject(data.runs)) for (const [jobId, n] of Object.entries(data.runs)) {
        if (nonEmptyString(jobId) && !drivers.has(jobId) && Number.isSafeInteger(n) && n > 0) runCounts.set(jobId, n);
      }
      for (const [jobId, lanes] of Object.entries(data.sessions || {})) {
        if (!nonEmptyString(jobId) || !isPlainObject(lanes) || drivers.has(jobId)) continue;
        const restored = new Map();
        for (const [laneKey, lane] of Object.entries(lanes)) {
          const clean = nonEmptyString(laneKey) ? sanitizeLane(lane) : null;
          if (clean) restored.set(laneKey, clean);
        }
        if (restored.size) sessions.set(jobId, restored);
      }
    }
    for (const [jobId, entry] of Object.entries(failedMap)) {
      if (!nonEmptyString(jobId) || entry?.status !== 'failed' || drivers.has(jobId)) continue;
      states.set(jobId, {
        jobId,
        canvasFilePath: typeof entry.canvasFilePath === 'string' ? entry.canvasFilePath : '',
        status: 'failed',
        stage: entry.stage ?? null,
        ...(entry.code ? { code: String(entry.code) } : {}),
        ...(entry.message ? { message: String(entry.message) } : {}),
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now(),
      });
    }
  }

  async function drive(entry) {
    const { jobId, canvasFilePath, controller } = entry;
    const signal = controller.signal;

    const read = async (matchTaskId) => {
      try {
        return await getHandoff(matchTaskId ? { jobId, canvasFilePath, matchTaskId } : { jobId, canvasFilePath });
      } catch (error) {
        if (isEnoent(error)) return { gone: true, handoff: null };
        throw applicationError(error);
      }
    };

    // One durable record per provider invocation, including the separate planning
    // call. Summaries are provider-authored readable output, never raw events.
    const invokeLoggedStage = async ({ stage, text, pageImages = [], sessionId, resume = false, handoff, matchTaskId, editorialPlan }) => {
      if (entry.runs >= maxRunsPerJob) {
        throw new ClaudeRunnerError('CLAUDE_TOO_MANY_RUNS', MESSAGES.tooMany(maxRunsPerJob));
      }
      const release = await semaphore.acquire(signal);
      const profile = claudeStageProfile(stage);
      const record = {
        version: 2, runId: crypto.randomUUID(), jobId, stage, ...(matchTaskId ? { matchTaskId } : {}),
        sessionId, resume,
        requestedModel: profile.model, requestedEffort: profile.effort,
        handoffSha256: crypto.createHash('sha256').update(String(handoffCodeOf(handoff) ?? '')).digest('hex'),
        promptSha256: crypto.createHash('sha256').update(text).digest('hex'), promptChars: text.length,
        pageImages: pageImages.length,
        ...(editorialPlan ? { editorialPlan } : {}),
      };
      let summaryCount = 0;
      let summaryChars = 0;
      let summaryChain = Promise.resolve();
      let acceptingSummaries = true;
      const coverage = status => ({ thinkingDisplay: 'summarized', thinkingSummaryCount: summaryCount,
        thinkingSummaryChars: summaryChars, thinkingSummaryPresent: summaryCount > 0, summaryStatus: status });
      try {
        if (signal.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled);
        // A logged start also makes an interrupted/incomplete invocation
        // visible. No provider call is made if this cannot be recorded.
        await logRun(jobId, canvasFilePath, { ...record, event: 'started', ...(capturePrompts ? { prompt: text } : {}) });
        try {
          const result = await stageRunner({
            text, pageImages, signal, stage, sessionId, resume, model: profile.model, effort: profile.effort,
            onActivity: () => touchActivity(jobId),
            onThinkingSummary: summary => {
              if (!acceptingSummaries) return Promise.reject(new ClaudeRunnerError('CLAUDE_LOG_ERROR', 'Claude returned a diagnostic summary after its run had ended.'));
              const write = summaryChain.then(async () => {
                if (typeof summary?.text !== 'string' || !summary.text.trim() || summary.thinkingDisplay !== 'summarized'
                  || typeof summary.model !== 'string' || !answeringModel(profile.model, [summary.model])) {
                  throw new ClaudeRunnerError('CLAUDE_LOG_ERROR', 'Claude returned an invalid diagnostic summary. The application was stopped before submission.');
                }
                // Project only this public content. Never serialize the callback
                // argument itself: it may contain signatures or redacted blocks.
                const safe = { text: summary.text, model: summary.model, index: summaryCount + 1, thinkingDisplay: 'summarized' };
                await logRun(jobId, canvasFilePath, { ...record, event: 'thinking-summary', summary: safe, provisional: true });
                summaryCount += 1;
                summaryChars += summary.text.length;
              });
              summaryChain = write;
              write.catch(() => {});
              return write;
            },
          });
          acceptingSummaries = false;
          await summaryChain;
          // Keep returned text before submission, cancellation or transcript cleanup.
          await logRun(jobId, canvasFilePath, { ...record, event: 'response', model: result?.model ?? null,
            durationMs: result?.durationMs ?? null, answer: result?.text ?? '', ...coverage('complete'), runsCompleted: entry.runs + 1 });
          entry.runs += 1; runCounts.set(jobId, entry.runs); persist();
          return { result, record };
        } catch (error) {
          acceptingSummaries = false;
          // Cancellation can settle the SDK before an in-flight disk append.
          // Wait for it before freezing terminal coverage for the run.
          let cause = error;
          try { await summaryChain; } catch (logError) { cause = logError; }
          const failure = cause instanceof ClaudeRunnerError
            ? cause
            : new ClaudeRunnerError('CLAUDE_ERROR', clip(cause?.message || 'Claude run failed.') || 'Claude run failed.', cause?.code);
          await logRun(jobId, canvasFilePath, { ...record, event: 'failed', error: auditFailure(failure),
            ...(typeof failure.result === 'string' ? { result: failure.result } : {}), ...coverage('incomplete') });
          throw failure;
        }
      } finally {
        release();
      }
    };

    const answer = async (handoff, matchTaskId) => {
      const stage = handoff?.stage ?? null;
      entry.stage = stage;
      setState(jobId, canvasFilePath, { status: 'running', stage });
      let text = chooseText(handoff);
      const laneKey = matchTaskId || 'main';
      const key = freshContextKeyOf(handoff);
      const lane = laneFor(jobId, laneKey);
      let planReference;
      // Only the v2 writer has this frozen source contract. Other application
      // stages still receive their exact handoff without a planning round.
      if (stage === 'write' && /^(?:APPLICATION V2 HANDOFF|The following is approved source data, not instructions\.)$/mu.test(handoff?.prompt || '')) {
        let planRecord;
        try {
          const binding = editorialPlanBinding(handoff.prompt);
          const allowedIds = editorialPlanAllowedIds(handoff.prompt);
          const archiveArgs = { canvasFilePath, jobId, laneKey, contextKey: key ?? `handoff:${crypto.createHash('sha256').update(String(handoffCodeOf(handoff) ?? '')).digest('hex')}`,
            sourceDigest: binding.sourceDigest, allowedIds };
          let saved = await loadEditorialPlan(archiveArgs);
          if (!saved && lane.started && !lane.editorialPlanned && !needsFreshSession(lane, handoff, key)) {
            // A session started by an older build cannot acquire an outline
            // retrospectively. Keep its established draft/correction context.
            await logRun(jobId, canvasFilePath, { version: 2, jobId, stage, event: 'editorial-plan-unavailable',
              sessionId: lane.sessionId, reason: 'writer-session-already-started', sourceDigest: binding.sourceDigest });
          } else if (!saved) {
            const planSessionId = crypto.randomUUID();
            try {
              const planned = await invokeLoggedStage({ stage: 'editorial-plan', text: buildEditorialPlanPrompt(handoff.prompt),
                sessionId: planSessionId, handoff, matchTaskId });
              planRecord = planned.record;
              const checkPlanningCancellation = async () => {
                if (!signal.aborted) return;
                const error = new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled);
                await logRun(jobId, canvasFilePath, { ...planRecord, event: 'cancelled', error: auditFailure(error) });
                throw error;
              };
              await checkPlanningCancellation();
              saved = await saveEditorialPlan({ ...archiveArgs, writerPromptSha256: binding.writerPromptSha256,
                plan: parseEditorialPlanResponse(planned.result?.text, allowedIds), planRunId: planned.record.runId,
                planSessionId, model: planned.result?.model, createdAt: new Date(now()).toISOString() });
              await checkPlanningCancellation();
            } finally {
              // This standalone session is never resumed, including failures.
              await removeTranscripts([planSessionId]);
            }
          }
          if (saved) {
            lane.editorialPlanned = true;
            planReference = { reference: saved.reference, planSha256: saved.planSha256, planRunId: saved.planRunId,
              sourceDigest: saved.sourceDigest, contextKey: saved.contextKey };
            const attached = writerPromptWithEditorialPlan(handoff.prompt, saved.plan);
            // Resumed corrections may be terse. Preserve their corrections and
            // append the same saved proposal without replaying all source data.
            text += attached.slice(handoff.prompt.length);
          }
        } catch (error) {
          if (error instanceof ClaudeRunnerError) throw error;
          const failure = new ClaudeRunnerError('CLAUDE_EDITORIAL_PLAN_ERROR', 'The private editorial outline could not be validated or saved. Review the diagnostic archive before retrying.', { reason: clip(error?.message, 300) });
          await logRun(jobId, canvasFilePath, { version: 2, jobId, stage: 'editorial-plan', ...planRecord,
            event: 'editorial-plan-error', error: auditFailure(failure) });
          throw failure;
        }
      }
      const wasStarted = lane.started;
      if (needsFreshSession(lane, handoff, key)) {
        const replacedId = lane.sessionId;
        lane.sessionId = crypto.randomUUID();
        lane.started = false;
        if (replacedId && replacedId !== lane.sessionId) {
          removeTranscripts([replacedId]).catch(error => {
            logger?.warn?.(`[ClaudeRunner] could not remove a replaced Claude session transcript: ${clip(error?.code || error?.message, 80)}`);
          });
        }
      }
      let result;
      let record;
      try {
        ({ result, record } = await invokeLoggedStage({ stage, text, handoff, matchTaskId,
          pageImages: Array.isArray(handoff?.pageImages) ? handoff.pageImages : [],
          sessionId: lane.sessionId, resume: lane.started, editorialPlan: planReference }));
        lane.started = true;
      } finally {
        lane.contextKey = key;
        lane.stage = stage;
        if (entry.abortReason !== 'discard' && (lane.started || wasStarted)) persist();
      }
      if (signal.aborted) {
        const error = new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled);
        await logRun(jobId, canvasFilePath, { ...record, event: 'cancelled', error: auditFailure(error) });
        throw error;
      }
      let submitted;
      try {
        submitted = await submitHandoff({
          jobId,
          canvasFilePath,
          ...(matchTaskId ? { matchTaskId } : {}),
          handoffCode: handoffCodeOf(handoff),
          response: result?.text ?? '',
          route: APPLICATION_ROUTE_CLAUDE_RUNNER,
        });
      } catch (error) {
        await logRun(jobId, canvasFilePath, { ...record, event: 'submission-error', error: auditFailure(applicationError(error)) });
        if (isEnoent(error)) return { gone: true };
        throw applicationError(error);
      }
      await logRun(jobId, canvasFilePath, { ...record, event: 'submission', submit: {
        accepted: submitted?.accepted === true, completed: submitted?.completed === true,
        ...(Array.isArray(submitted?.validationErrors) && submitted.validationErrors.length ? { validationErrors: submitted.validationErrors } : {}),
        ...(submitted?.gone === true ? { gone: true } : {}),
        ...(submitted?.rejection ? { rejection: submitted.rejection } : {}),
      } });
      return submitted;
    };

    const runTask = async (task) => {
      try {
        for (;;) {
          if (signal.aborted) return;
          const current = await read(task.id);
          if (current?.gone === true || current?.completed === true) return;
          if (!current?.handoff) throw new ClaudeRunnerError('APPLICATION_ERROR', 'The application returned no handoff for a parallel task.');
          const submitted = await answer(current.handoff, task.id);
          if (submitted?.gone === true) return;
          if (submitted?.accepted === true && submitted.completed === true) return;
        }
      } catch (error) {
        if (!entry.abortReason) {
          entry.firstError = error;
          entry.abortReason = 'failed';
          controller.abort();
        }
        throw error;
      }
    };

    for (;;) {
      if (signal.aborted) return { stopped: true };
      const current = await read();
      if (current?.gone === true) return { gone: true };
      if (current?.completed === true) return current.terminal === true ? { needsReview: true, stop: current.stop || null } : { done: true };
      const handoff = current?.handoff;
      if (!handoff) throw new ClaudeRunnerError('APPLICATION_ERROR', 'The application returned no handoff.');
      entry.stage = handoff.stage ?? null;
      if (handoff.stage === HUMAN_STOP_STAGE) return { needsReview: true };
      const tasks = Array.isArray(handoff.parallelTasks) ? handoff.parallelTasks.filter(task => nonEmptyString(task?.id)) : [];
      if (tasks.length) {
        const results = await Promise.allSettled(tasks.map(runTask));
        const rejected = results.find(item => item.status === 'rejected');
        if (rejected) throw entry.firstError || rejected.reason;
        continue;
      }
      const submitted = await answer(handoff, null);
      if (submitted?.gone === true) return { gone: true };
      if (submitted?.terminal === true) return { needsReview: true, stop: submitted.stop || null };
      if (submitted?.accepted === true && submitted.completed === true) return { done: true };
    }
  }

  function startDriver(jobId, canvasFilePath) {
    const entry = {
      jobId,
      canvasFilePath,
      controller: new AbortController(),
      runs: runCounts.get(jobId) ?? 0,
      stage: null,
      abortReason: null,
      firstError: null,
      promise: null,
    };
    drivers.set(jobId, entry);
    setState(jobId, canvasFilePath, { status: 'running', stage: null });
    const needsReview = async stop => {
      const previous = states.get(jobId);
      setState(jobId, canvasFilePath, { status: 'needs-review', stage: entry.stage, reason: stop?.reason, stop });
      if (stop && !(previous?.status === 'needs-review' && previous.reason === stop.reason)) {
        try { await logRun(jobId, canvasFilePath, { version: 2, jobId, stage: entry.stage, event: 'needs-review', stop, runs: entry.runs }); }
        catch { /* stop remains authoritative if a best-effort diagnostic fails */ }
      }
      await dropSessions(jobId);
    };
    entry.promise = (async () => {
      try {
        const outcome = await drive(entry);
        if (entry.abortReason === 'discard') { await dropSessions(jobId); return; }
        if (entry.abortReason === 'shutdown') return;
        if (outcome?.gone) {
          removeState(jobId, canvasFilePath);
          await dropSessions(jobId);
        } else if (outcome?.done) {
          setState(jobId, canvasFilePath, { status: 'done', stage: entry.stage });
          await dropSessions(jobId);
        } else if (outcome?.needsReview) {
          await needsReview(outcome.stop);
        }
      } catch (caught) {
        if (entry.abortReason === 'discard') { await dropSessions(jobId); return; }
        if (entry.abortReason === 'shutdown') return;
        const raw = entry.abortReason === 'failed' && entry.firstError ? entry.firstError : caught;
        if (raw?.code === 'CLAUDE_TOO_MANY_RUNS' && typeof api.stopHandoff === 'function') {
          try {
            const result = await api.stopHandoff({ jobId, canvasFilePath, reason: 'run-budget', runs: entry.runs, limit: maxRunsPerJob });
            if (result?.stopped === true || result?.alreadyTerminal === true) { await needsReview(result.stop || { reason: 'run-budget', stage: entry.stage }); return; }
            if (result?.completed === true) { setState(jobId, canvasFilePath, { status: 'done', stage: entry.stage }); await dropSessions(jobId); return; }
          } catch { /* fall back to the visible runner failure */ }
        }
        const error = raw instanceof ClaudeRunnerError ? raw : applicationError(raw);
        setState(jobId, canvasFilePath, { status: 'failed', stage: entry.stage, code: error.code, message: error.message });
        logger?.error?.(`[ClaudeRunner] job=${jobId.slice(0, 8)} stage=${entry.stage ?? 'none'} code=${error.code}`);
        await persist();
      } finally {
        if (drivers.get(jobId) === entry) drivers.delete(jobId);
      }
    })();
    return { status: 'running', stage: null };
  }

  function ensure({ jobId, canvasFilePath } = {}) {
    if (!nonEmptyString(jobId) || !nonEmptyString(canvasFilePath)) return { status: 'invalid' };
    const existing = states.get(jobId);
    if (existing?.status === 'failed') return { ...existing };
    if (drivers.has(jobId)) return existing ? { ...existing } : { status: 'running', stage: null };
    if (shuttingDown) return { status: 'stopped' };
    let laned = false;
    try { laned = isBridgeLaned(jobId) === true; } catch { laned = false; }
    if (laned) return { status: 'bridge' };
    return startDriver(jobId, canvasFilePath);
  }

  async function retry({ jobId, canvasFilePath } = {}) {
    if (!nonEmptyString(jobId) || !nonEmptyString(canvasFilePath)) return { status: 'invalid' };
    if (states.get(jobId)?.status === 'failed') {
      states.delete(jobId);
      await persist();
    }
    return ensure({ jobId, canvasFilePath });
  }

  function status(jobIds) {
    const out = {};
    for (const jobId of Array.isArray(jobIds) ? jobIds : []) {
      if (typeof jobId !== 'string') continue;
      const state = states.get(jobId);
      if (state) out[jobId] = { ...state };
    }
    return out;
  }

  function onDiscard(event) {
    const jobId = typeof event === 'string' ? event : event?.jobId;
    if (!nonEmptyString(jobId)) return;
    const entry = drivers.get(jobId);
    if (entry) {
      entry.abortReason = 'discard';
      entry.controller.abort();
      removeState(jobId, entry.canvasFilePath);
      return;
    }
    if (states.get(jobId)?.status === 'failed') {
      removeState(jobId, event?.canvasFilePath);
      persist();
    }
    if (sessions.has(jobId) || runCounts.has(jobId)) {
      dropSessions(jobId).catch(() => { /* logged inside; never fails a job */ });
    }
  }

  let unsubscribe = null;
  if (typeof subscribeDiscards === 'function') {
    try { unsubscribe = subscribeDiscards(onDiscard) || null; } catch { unsubscribe = null; }
  }

  async function shutdown() {
    shuttingDown = true;
    const pending = [];
    for (const entry of drivers.values()) {
      if (!entry.abortReason) entry.abortReason = 'shutdown';
      entry.controller.abort();
      pending.push(entry.promise);
    }
    await Promise.allSettled(pending);
    try { unsubscribe?.(); } catch { /* ignore */ }
    await persistChain;
    await runLogChain;
  }

  return Object.freeze({ ensure, retry, status, shutdown, load });
}

export function registerClaudeApplicationRunnerHandlers({ handleSafe, runner, getAllWindows }) {
  handleSafe('claude-application:ensure', async (_event, args) => runner.ensure(args || {}));
  handleSafe('claude-application:retry', async (_event, args) => runner.retry(args || {}));
  handleSafe('claude-application:status', async (_event, args) => ({ states: runner.status(args?.jobIds) }));
  return function notify(state) {
    let windows = [];
    try { windows = getAllWindows() || []; } catch { windows = []; }
    for (const win of windows) {
      try {
        if (!win || win.isDestroyed?.()) continue;
        const contents = win.webContents;
        if (!contents || contents.isDestroyed?.()) continue;
        contents.send('claude-application:changed', state);
      } catch { /* a closing window cannot fail a run */ }
    }
  };
}
