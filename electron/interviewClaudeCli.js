/** Process plumbing shared by the warm, tool-free Claude CLI sessions of the Interview Helper. */
import { randomUUID } from 'node:crypto';
import { applyClaudeAccountEnv } from './ipc/claudeAccounts.js';
import { claudeChildEnv } from './ipc/claudeApplicationRunner.js';

const owned = new Set();
export const transportError = code => Object.assign(new Error(code), { code });
export const cancelledError = () => Object.assign(transportError('CANCELLED'), { name: 'AbortError' });

function signalProcess(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* It already exited. */ }
}
process.once('exit', () => { for (const child of owned) signalProcess(child, 'SIGKILL'); });

/** Spawn the CLI in its own process group; `done` settles on exit or on a failed spawn. */
export function managedSpawn(binary, args, cwd, spawn) {
  // The raw CLI runs as whichever account is active now, not the desktop session's.
  const env = applyClaudeAccountEnv(claudeChildEnv(process.env)).env;
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  const child = spawn(binary, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  owned.add(child);
  let exited = false;
  let spawnFailure;
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => {
    // A failed spawn is not guaranteed to be followed by 'close'.
    child.once('error', () => { spawnFailure = true; exited = true; owned.delete(child); resolve({ code: null, failed: true }); });
    child.once('close', code => { exited = true; owned.delete(child); resolve({ code, failed: spawnFailure }); });
  });
  let stopping;
  function stop() {
    if (stopping) return stopping;
    if (exited) return Promise.resolve();
    signalProcess(child, 'SIGTERM');
    stopping = new Promise(resolve => {
      const timer = setTimeout(() => { if (!exited) signalProcess(child, 'SIGKILL'); resolve(); }, 250);
      done.then(() => { clearTimeout(timer); resolve(); });
    });
    return stopping;
  }
  return { child, done, stop };
}

/** Run the CLI to completion with no input and return its stdout. */
export async function captureCliOutput(binary, args, { cwd, spawn, signal, handles, outputLimit }) {
  if (signal?.aborted) throw cancelledError();
  const handle = managedSpawn(binary, args, cwd, spawn);
  handles.add(handle);
  let bytes = 0;
  const output = [];
  let rejectInterrupted;
  const interrupted = new Promise((resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => { rejectInterrupted(cancelledError()); void handle.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  for (const stream of ['stdout', 'stderr']) handle.child[stream].on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > outputLimit) { rejectInterrupted(transportError('TRANSPORT_OUTPUT_LIMIT')); void handle.stop(); }
    else if (stream === 'stdout') output.push(Buffer.from(chunk));
  });
  handle.child.stdin.end();
  try {
    const result = await Promise.race([handle.done, interrupted]);
    if (result.failed || result.code !== 0) throw transportError('TRANSPORT_UNAVAILABLE');
    return Buffer.concat(output).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', abort);
    await handle.stop();
    handles.delete(handle);
  }
}

export function requireCliFlags(help, flags) {
  if (flags.some(flag => !help.includes(flag))) throw transportError('TRANSPORT_CAPABILITY_UNSUPPORTED');
}

/** The text of a successful stream-json `result` event. */
function cliResultText(value) {
  if (!value || value.type !== 'result' || value.is_error || value.subtype && value.subtype !== 'success' || typeof value.result !== 'string') throw transportError('TRANSPORT_INVALID_RESPONSE');
  return value.result;
}

/**
 * One warm stream-json conversation over a managed CLI process. `request` resolves `{ text, event, model }`;
 * an aborted turn that was already sent drains in place so the conversation stays usable.
 */
export function createWarmProcess(handle, outputLimit) {
  const { child } = handle;
  let buffer = '';
  let bytes = 0;
  let pending;
  const queued = [];
  let dead = false;
  let sessionId;
  const idleWaiters = [];
  function notifyIdle() {
    if (dead || !pending && !queued.length) for (const resolve of idleWaiters.splice(0)) resolve();
  }
  function fail(code) {
    if (dead) return;
    dead = true;
    const current = pending;
    pending = null;
    current?.cleanup();
    current?.reject(transportError(code));
    for (const waiting of queued.splice(0)) { waiting.cleanup(); waiting.reject(transportError(code)); }
    notifyIdle();
    void handle.stop();
  }
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > outputLimit) fail('TRANSPORT_OUTPUT_LIMIT'); });
  child.stdout.on('data', chunk => {
    if (dead) return;
    buffer += chunk; bytes += Buffer.byteLength(chunk);
    if (bytes > outputLimit) { fail('TRANSPORT_OUTPUT_LIMIT'); return; }
    while (buffer.includes('\n') && !dead) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { fail('TRANSPORT_INVALID_RESPONSE'); return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { fail('TRANSPORT_INVALID_RESPONSE'); return; }
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'stream_event') { pending?.onEvent?.(event.event); continue; }
      if (event.type === 'assistant') {
        if (!Array.isArray(event.message?.content) || event.message.content.some(block => !block || typeof block !== 'object')) { fail('TRANSPORT_INVALID_RESPONSE'); return; }
        if (event.message.content.some(block => block.type === 'tool_use')) { fail('TRANSPORT_TOOL_USE'); return; }
        if (pending && typeof event.message.model === 'string') pending.model = event.message.model;
      }
      if (event.type !== 'result') continue;
      if (!pending || event.user_message_uuid && event.user_message_uuid !== pending.uuid) { fail('TRANSPORT_UNEXPECTED_RESPONSE'); return; }
      try {
        const text = cliResultText(event);
        const current = pending; pending = null; current.cleanup(); current.resolve({ text, event, model: current.model });
        sendNext();
      } catch { fail('TRANSPORT_INVALID_RESPONSE'); }
    }
  });
  handle.done.then(() => fail('TRANSPORT_UNAVAILABLE'));
  function sendNext() {
    if (dead || pending || !queued.length) { notifyIdle(); return; }
    pending = queued.shift();
    bytes = 0;
    const message = { type: 'user', message: { role: 'user', content: pending.prompt }, parent_tool_use_id: null, uuid: pending.uuid, client_composed: true };
    if (sessionId) message.session_id = sessionId;
    child.stdin.write(`${JSON.stringify(message)}\n`, writeError => { if (writeError) fail('TRANSPORT_WRITE_FAILED'); });
  }
  return {
    request(prompt, signal, onEvent) {
      if (signal?.aborted) return Promise.reject(cancelledError());
      if (dead) return Promise.reject(transportError('TRANSPORT_UNAVAILABLE'));
      return new Promise((resolve, reject) => {
        const current = { uuid: randomUUID(), prompt, onEvent, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
        const abort = () => {
          current.cleanup();
          const index = queued.indexOf(current);
          if (index >= 0) queued.splice(index, 1);
          // A sent turn must drain before the warm conversation is reused: keep its UUID, drop its output.
          current.resolve = () => {}; current.onEvent = undefined;
          current.reject(cancelledError());
        };
        signal?.addEventListener('abort', abort, { once: true });
        queued.push(current);
        sendNext();
      });
    },
    whenIdle() {
      return dead || !pending && !queued.length ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve));
    },
    close() { fail('CANCELLED'); return handle.stop(); },
  };
}
