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
  constructor(code, message, detail) {
    super(message);
    this.name = 'ClaudeRunnerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
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

export function classifyClaudeFailure({ parsed, stderr, exitCode } = {}) {
  const resultText = typeof parsed?.result === 'string' ? parsed.result : '';
  const stderrText = String(stderr ?? '');
  const combined = `${resultText}\n${stderrText}`;
  const clipped = clip(resultText.trim() ? resultText : stderrText);
  const detail = { exitCode: exitCode ?? null, subtype: parsed?.subtype ?? null, apiErrorStatus: parsed?.apiErrorStatus ?? null };
  if (parsed?.apiErrorStatus === 429 || USAGE_RE.test(combined)) {
    return new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', clipped ? `${MESSAGES.usage} (${clipped})` : MESSAGES.usage, detail);
  }
  if (LOGIN_RE.test(combined)) {
    return new ClaudeRunnerError('CLAUDE_NOT_SIGNED_IN', MESSAGES.login, detail);
  }
  return new ClaudeRunnerError(
    'CLAUDE_ERROR',
    `Claude Code failed (exit ${exitCode ?? 'unknown'})${clipped ? `: ${clipped}` : ''}`,
    detail,
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
          { models: parsed.models },
        ));
        return;
      }
      if (!parsed.result.trim()) {
        finish(new ClaudeRunnerError('CLAUDE_ERROR', 'Claude Code returned an empty answer.'));
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
  return async ({ text, pageImages, signal, stage, sessionId, resume }) => {
    if (!bound) {
      if (workspaceDir) await fsImpl.mkdir(workspaceDir, { recursive: true });
      const binary = resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
      bound = { binary, env: claudeChildEnv(process.env, path.dirname(binary)), cwd: workspaceDir || os.tmpdir() };
    }
    return runClaudeStage({ text, pageImages, signal, sessionId, resume, ...bound, ...claudeStageProfile(stage) });
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
  };
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
} = {}) {
  const { getHandoff, submitHandoff, subscribeDiscards } = api;
  const stageRunner = typeof runStage === 'function' ? runStage : createProductionRunStage({ workspaceDir, fsImpl });
  const semaphore = createSemaphore(concurrency);
  const states = new Map();
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
    if (!lanes) return;
    sessions.delete(jobId);
    const ids = [...lanes.values()].map(lane => lane.sessionId).filter(Boolean);
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
    };
    states.set(jobId, state);
    emit({ ...state });
    return state;
  }

  function removeState(jobId, canvasFilePath) {
    const previous = states.get(jobId);
    states.delete(jobId);
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
        out[laneKey] = { sessionId: lane.sessionId, started: lane.started === true, contextKey: lane.contextKey ?? null, stage: lane.stage ?? null };
      }
      if (Object.keys(out).length) sessionSnapshot[jobId] = out;
    }
    const body = `${JSON.stringify({ failed, sessions: sessionSnapshot }, null, 2)}\n`;
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
    const newFormat = ('failed' in data || 'sessions' in data)
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

    const answer = async (handoff, matchTaskId) => {
      if (entry.runs >= maxRunsPerJob) {
        throw new ClaudeRunnerError('CLAUDE_TOO_MANY_RUNS', MESSAGES.tooMany(maxRunsPerJob));
      }
      entry.runs += 1;
      entry.stage = handoff?.stage ?? null;
      setState(jobId, canvasFilePath, { status: 'running', stage: entry.stage });
      const text = chooseText(handoff);
      const release = await semaphore.acquire(signal);
      let result;
      try {
        if (signal.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled);
        const lane = laneFor(jobId, matchTaskId || 'main');
        const key = freshContextKeyOf(handoff);
        const wasStarted = lane.started;
        if (needsFreshSession(lane, handoff, key)) {
          lane.sessionId = crypto.randomUUID();
          lane.started = false;
        }
        let succeeded = false;
        try {
          result = await stageRunner({
            text,
            pageImages: Array.isArray(handoff?.pageImages) ? handoff.pageImages : [],
            signal,
            stage: entry.stage,
            sessionId: lane.sessionId,
            resume: lane.started,
          });
          succeeded = true;
        } catch (error) {
          if (error instanceof ClaudeRunnerError) throw error;
          throw new ClaudeRunnerError('CLAUDE_ERROR', clip(error?.message || 'Claude run failed.') || 'Claude run failed.', error?.code);
        } finally {
          lane.contextKey = key;
          lane.stage = handoff?.stage ?? null;
          if (succeeded) lane.started = true;
          // Only a resumable lane (or one that replaced a resumable lane) needs to reach disk now;
          // a discarded job's sessions are about to be dropped.
          if (entry.abortReason !== 'discard' && (lane.started || wasStarted)) persist();
        }
      } finally {
        release();
      }
      if (signal.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', MESSAGES.cancelled);
      try {
        return await submitHandoff({
          jobId,
          canvasFilePath,
          ...(matchTaskId ? { matchTaskId } : {}),
          handoffCode: handoffCodeOf(handoff),
          response: result?.text ?? '',
        });
      } catch (error) {
        if (isEnoent(error)) return { gone: true };
        throw applicationError(error);
      }
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
      if (current?.completed === true) return { done: true };
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
      if (submitted?.accepted === true && submitted.completed === true) return { done: true };
    }
  }

  function startDriver(jobId, canvasFilePath) {
    const entry = {
      jobId,
      canvasFilePath,
      controller: new AbortController(),
      runs: 0,
      stage: null,
      abortReason: null,
      firstError: null,
      promise: null,
    };
    drivers.set(jobId, entry);
    setState(jobId, canvasFilePath, { status: 'running', stage: null });
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
          setState(jobId, canvasFilePath, { status: 'needs-review', stage: entry.stage });
        }
      } catch (caught) {
        if (entry.abortReason === 'discard') { await dropSessions(jobId); return; }
        if (entry.abortReason === 'shutdown') return;
        const raw = entry.abortReason === 'failed' && entry.firstError ? entry.firstError : caught;
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
    if (sessions.has(jobId)) {
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
