// Stage runner that answers a text-only application handoff through the local
// `offload complete` CLI (DeepSeek) instead of Claude Code. It honours the same
// contract as the runner's stageRunner seam, so the runner can swap one for the
// other per stage. The CLI is stateless, so a session's turns live in a private
// JSON file and each resumed turn replays them: the system message and earlier
// turns stay byte-identical, which keeps the provider's prefix cache warm.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HANDOFF_SYSTEM_PROMPT, ClaudeRunnerError, claudeCatalogSystemAppend, splitCareerCatalog } from './claudeApplicationRunner.js';
import { offloadReasoning } from './aiCallProviders.js';

export const OFFLOAD_DEFAULT_BIN = '/Users/jack/.local/bin/offload';
export const OFFLOAD_MAX_TOKENS = 32000;
export const OFFLOAD_TIMEOUT_MS = 900000;
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const SESSION_FILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** The CLI path: an explicit option, then INFINITE_CANVAS_OFFLOAD_BIN, then the installed default. */
export function resolveOffloadBin(binPath, env = process.env) {
  if (typeof binPath === 'string' && binPath) return binPath;
  const fromEnv = env?.INFINITE_CANVAS_OFFLOAD_BIN;
  return typeof fromEnv === 'string' && fromEnv ? fromEnv : OFFLOAD_DEFAULT_BIN;
}

// The runner passes the node fs.promises API; accept the fs module as well.
const promisesOf = fsImpl => fsImpl?.promises || fsImpl;

function sessionFile(transcriptDir, sessionId) {
  if (!transcriptDir || !SESSION_FILE_ID_RE.test(String(sessionId ?? ''))) {
    throw new ClaudeRunnerError('OFFLOAD_INVALID_REQUEST', 'The offload session id or directory is not valid.');
  }
  return path.join(transcriptDir, `${sessionId}.json`);
}

/** Deletes the stored turns of finished or replaced sessions. Never throws. */
export async function removeOffloadSessions(transcriptDir, sessionIds, fsImpl = fs.promises) {
  if (!transcriptDir) return;
  const files = fsImpl ? promisesOf(fsImpl) : fs.promises;
  for (const id of Array.isArray(sessionIds) ? sessionIds : []) {
    if (!SESSION_FILE_ID_RE.test(String(id ?? ''))) continue;
    try { await files.rm(path.join(transcriptDir, `${id}.json`), { force: true }); } catch { /* best effort cleanup */ }
  }
}

function validMessages(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(item => item && typeof item === 'object'
    && ['system', 'user', 'assistant'].includes(item.role) && typeof item.content === 'string');
}

async function loadSession(files, file) {
  let raw;
  try { raw = await files.readFile(file, 'utf8'); } catch {
    throw new ClaudeRunnerError('OFFLOAD_SESSION_MISSING', 'The stored offload session could not be read.');
  }
  let messages;
  try { messages = JSON.parse(raw); } catch { messages = null; }
  if (!validMessages(messages)) throw new ClaudeRunnerError('OFFLOAD_SESSION_MISSING', 'The stored offload session is damaged.');
  return messages;
}

async function saveSession(files, transcriptDir, file, messages) {
  await files.mkdir(transcriptDir, { recursive: true, mode: 0o700 });
  try { await files.chmod(transcriptDir, 0o700); } catch { /* a fake or foreign fs may not support it */ }
  const temp = `${file}.${process.pid}.tmp`;
  await files.writeFile(temp, JSON.stringify(messages), { encoding: 'utf8', mode: 0o600 });
  await files.chmod(temp, 0o600);
  await files.rename(temp, file);
}

function parseResultLine(stdout) {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* try an earlier line */ }
  }
  return null;
}

function unavailable(message, cause) {
  return new ClaudeRunnerError('OFFLOAD_UNAVAILABLE', message, cause ? { cause: String(cause).slice(0, 200) } : undefined);
}

// The installed CLI is a `#!/usr/bin/env node` script. An app opened from
// Finder has no node on its PATH, so the launcher fails with "env: node: No
// such file" and every routed stage would silently fall back to Claude. With a
// nodePath (production passes the app's own executable), the script is run by
// that interpreter instead; ELECTRON_RUN_AS_NODE makes Electron act as Node.
function spawnCommand(binPath, nodePath) {
  if (!nodePath) return { command: binPath, args: ['complete'], options: { stdio: ['pipe', 'pipe', 'pipe'] } };
  return {
    command: nodePath,
    args: [fs.realpathSync(binPath), 'complete'],
    options: { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  };
}

function exchange({ spawnImpl, binPath, nodePath, request, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const { command, args, options } = spawnCommand(binPath, nodePath);
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(unavailable('The offload CLI could not be started.', error?.code || error?.message));
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    function onAbort() {
      // The CLI prints a `cancelled` result after SIGTERM, which settles the call.
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', error => finish(reject, unavailable('The offload CLI could not be run.', error?.code || error?.message)));
    child.stdout?.on('data', chunk => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += String(chunk);
    });
    child.stderr?.on?.('data', () => { /* diagnostics may echo prompts; never kept */ });
    child.on('close', () => {
      const result = parseResultLine(stdout);
      if (result) finish(resolve, result);
      else finish(reject, unavailable('The offload CLI returned no readable result.'));
    });
    child.stdin?.on?.('error', () => { /* a dead child is reported by close */ });
    try {
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
    } catch (error) {
      finish(reject, unavailable('The offload CLI did not accept its request.', error?.code || error?.message));
    }
  });
}

/** Sends one request to `offload complete` and returns the parsed result object. */
export async function runOffloadComplete({ request, binPath, nodePath = null, spawnImpl = childProcess.spawn, signal } = {}) {
  return exchange({ spawnImpl, binPath: resolveOffloadBin(binPath), nodePath, request, signal });
}

function failureFor(result) {
  const info = result?.error && typeof result.error === 'object' ? result.error : {};
  const rawCode = typeof info.code === 'string' ? info.code : '';
  const message = typeof info.message === 'string' && info.message ? info.message.slice(0, 400) : 'The offload call failed.';
  const detail = {
    offloadCode: rawCode || null,
    retryable: info.retryable === true,
    httpStatus: Number.isInteger(info.httpStatus) ? info.httpStatus : null,
    providerRequestId: typeof info.providerRequestId === 'string' ? info.providerRequestId : null,
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
    costUsd: typeof result?.costUsd === 'number' ? result.costUsd : null,
  };
  if (rawCode.toLowerCase() === 'cancelled') return new ClaudeRunnerError('CLAUDE_CANCELLED', message, detail);
  const suffix = rawCode.toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  return new ClaudeRunnerError(`OFFLOAD_${suffix || 'ERROR'}`, message, detail);
}

export { failureFor as offloadFailure };

export function createOffloadCompleteStage({ binPath, nodePath = null, spawnImpl = childProcess.spawn, transcriptDir, fsImpl = fs, route = 'deepseek-flash' } = {}) {
  const files = promisesOf(fsImpl);
  return async function runOffloadStage({ text, pageImages = [], signal, stage, sessionId, resume = false, route: callRoute, reasoning } = {}) {
    if (Array.isArray(pageImages) && pageImages.length > 0) {
      throw new ClaudeRunnerError('OFFLOAD_UNSUPPORTED', 'Page images cannot be sent through the offload provider.');
    }
    let reasoningRequest;
    try { reasoningRequest = offloadReasoning(reasoning ?? 'high'); } catch {
      throw new ClaudeRunnerError('OFFLOAD_INVALID_REQUEST', 'The offload reasoning level is not valid.');
    }
    if (signal?.aborted) throw new ClaudeRunnerError('CLAUDE_CANCELLED', 'Offload run was cancelled.');
    const file = sessionFile(transcriptDir, sessionId);
    const split = splitCareerCatalog(text);
    let messages;
    if (resume) {
      messages = await loadSession(files, file);
      messages.push({ role: 'user', content: split.text });
    } else {
      const append = claudeCatalogSystemAppend(split.catalog);
      messages = [
        { role: 'system', content: append ? `${CLAUDE_HANDOFF_SYSTEM_PROMPT}\n\n${append}` : CLAUDE_HANDOFF_SYSTEM_PROMPT },
        { role: 'user', content: split.text },
      ];
    }
    const useRoute = callRoute || route;
    const request = {
      version: 1, route: useRoute, messages, maxTokens: OFFLOAD_MAX_TOKENS,
      reasoning: reasoningRequest, timeoutMs: OFFLOAD_TIMEOUT_MS,
      caller: 'infinite-canvas', tag: String(stage ?? 'handoff'),
    };
    const result = await exchange({ spawnImpl, binPath: resolveOffloadBin(binPath), nodePath, request, signal });
    if (result.ok !== true) throw failureFor(result);
    const answer = typeof result.text === 'string' ? result.text : '';
    if (!answer.trim()) {
      throw new ClaudeRunnerError('OFFLOAD_EMPTY', 'The offload provider returned an empty answer.', {
        offloadCode: 'empty', latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
        costUsd: typeof result.costUsd === 'number' ? result.costUsd : null });
    }
    // Only a successful turn extends the stored conversation.
    await saveSession(files, transcriptDir, file, [...messages, { role: 'assistant', content: answer }]);
    const raw = result.usage && typeof result.usage === 'object' ? result.usage : {};
    return {
      text: answer,
      model: typeof result.model === 'string' ? result.model : useRoute,
      durationMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
      usage: {
        input_tokens: raw.cacheMissTokens ?? 0,
        cache_read_input_tokens: raw.cacheHitTokens ?? 0,
        output_tokens: raw.outputTokens ?? 0,
        reasoning_tokens: raw.reasoningTokens ?? 0,
        provider_usage: raw,
      },
      costUsd: typeof result.costUsd === 'number' ? result.costUsd : undefined,
      summaryCount: 0,
      summaryChars: 0,
      thinkingDisplay: 'omitted',
      provider: 'offload',
      route: useRoute,
    };
  };
}
