// The Parallel Task API as a measurement arm only. The app itself researches with Parallel
// Search (electron/ipc/parallelSearch.js); this arm hands the whole research prompt to
// Parallel's asynchronous Task API instead, which runs its own processor and returns the
// finished text. The key is read from the Keychain by the caller and never printed here.
//
// Protocol (verified live): POST https://api.parallel.ai/v1/tasks/runs with headers
// content-type: application/json and x-api-key: <key>, body
// { input, processor, task_spec: { output_schema: { type: 'text' } } } -> { run_id, status }.
// Then GET https://api.parallel.ai/v1/tasks/runs/<run_id>/result with x-api-key until the
// run reports completed; its output.content is the reply and output.basis lists its sources.
// Parallel bills Task runs on its own plan, so an arm records no invented cost.

/** Where a run is created and polled. */
export const PARALLEL_TASK_RUNS_URL = 'https://api.parallel.ai/v1/tasks/runs';

/** The processors a Task API run may ask for. */
export const PARALLEL_TASK_PROCESSORS = Object.freeze(['lite', 'base', 'core', 'core2x', 'pro', 'ultra']);

/** Every failure carries one of these in `error.code`. */
export const PARALLEL_TASK_ERRORS = Object.freeze({
  INPUT: 'PARALLEL_TASK_INPUT',
  PROCESSOR: 'PARALLEL_TASK_PROCESSOR',
  KEY_MISSING: 'PARALLEL_TASK_KEY_MISSING',
  KEY_REJECTED: 'PARALLEL_TASK_KEY_REJECTED',
  LIMITED: 'PARALLEL_TASK_LIMITED',
  ABORTED: 'PARALLEL_TASK_ABORTED',
  TIMEOUT: 'PARALLEL_TASK_TIMEOUT',
  NETWORK: 'PARALLEL_TASK_NETWORK',
  CREATE: 'PARALLEL_TASK_CREATE',
  FAILED: 'PARALLEL_TASK_FAILED',
  REPLY: 'PARALLEL_TASK_REPLY',
});

const FAILED_STATUSES = Object.freeze(['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired']);
const PENDING_STATUSES = Object.freeze(['', 'queued', 'pending', 'running', 'created', 'in_progress', 'processing']);

const taskError = (code, message) => Object.assign(new Error(message), { code });
const textOf = value => (typeof value === 'string' ? value : '');

/** The reply text of a finished run's output, whether it is a string, { content } or content parts. */
export function taskOutputText(output) {
  if (typeof output === 'string') return output;
  const content = output?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : textOf(part?.text))).join('');
  return textOf(output?.text);
}

/** How many sources a finished run cites. */
export function taskBasisCount(output) {
  for (const value of [output?.basis, output?.citations, output?.sources]) if (Array.isArray(value)) return value.length;
  return 0;
}

/**
 * One Parallel Task API run: create it, poll its result until it finishes, and return the
 * reply. `timeoutMs` bounds the whole create-and-poll, `pollSeconds` spaces the polls, and
 * `signal` cancels it. Failures throw an Error whose `code` is a PARALLEL_TASK_ERRORS value.
 */
export async function runParallelTask({ input, processor = 'core', key, fetch: fetchImpl = globalThis.fetch,
  signal, timeoutMs = 20 * 60_000, pollSeconds = 180, now = Date.now } = {}) {
  const prompt = textOf(input);
  if (!prompt.trim()) throw taskError(PARALLEL_TASK_ERRORS.INPUT, 'A Parallel task run needs a non-empty input prompt.');
  if (!PARALLEL_TASK_PROCESSORS.includes(processor)) {
    throw taskError(PARALLEL_TASK_ERRORS.PROCESSOR, `--task-processor must be one of ${PARALLEL_TASK_PROCESSORS.join(', ')}.`);
  }
  const apiKey = textOf(key).trim();
  if (!apiKey) {
    throw taskError(PARALLEL_TASK_ERRORS.KEY_MISSING, 'The Parallel task arm needs the Keychain item infinite-canvas-parallel-api-key.');
  }
  if (signal?.aborted) throw taskError(PARALLEL_TASK_ERRORS.ABORTED, 'The Parallel task run was aborted before it started.');

  const budget = Math.max(1, Number(timeoutMs) || 1);
  const interval = Math.max(0, (Number(pollSeconds) || 0) * 1000);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener?.('abort', stop, { once: true });
  const timer = setTimeout(stop, budget);
  timer.unref?.();
  const started = now();
  const stoppedError = () => (signal?.aborted
    ? taskError(PARALLEL_TASK_ERRORS.ABORTED, 'The Parallel task run was aborted.')
    : taskError(PARALLEL_TASK_ERRORS.TIMEOUT, `The Parallel task run did not finish within ${Math.round(budget / 1000)}s.`));

  const request = async (url, init) => {
    if (controller.signal.aborted) throw stoppedError();
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw stoppedError();
      throw taskError(PARALLEL_TASK_ERRORS.NETWORK, `Parallel task request failed: ${String(error?.message || error).slice(0, 200)}`);
    }
    const raw = await Promise.resolve(response?.text?.()).catch(() => '');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const status = Number(response?.status) || 0;
    return { status, ok: response?.ok === true || (status >= 200 && status < 300), body };
  };

  try {
    const created = await request(PARALLEL_TASK_RUNS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ input: prompt, processor, task_spec: { output_schema: { type: 'text' } } }),
    });
    if (created.status === 401 || created.status === 403) {
      throw taskError(PARALLEL_TASK_ERRORS.KEY_REJECTED, 'Parallel rejected the API key (HTTP ' + created.status + ').');
    }
    if (created.status === 402 || created.status === 429) {
      throw taskError(PARALLEL_TASK_ERRORS.LIMITED, `Parallel is limiting task runs (HTTP ${created.status}).`);
    }
    if (!created.ok) throw taskError(PARALLEL_TASK_ERRORS.CREATE, `Parallel task create failed (HTTP ${created.status}).`);
    const runId = textOf(created.body?.run_id ?? created.body?.id ?? created.body?.run?.run_id).trim();
    if (!runId) throw taskError(PARALLEL_TASK_ERRORS.REPLY, 'Parallel task create returned no run_id.');

    // The result call blocks server-side for up to `timeout` seconds and answers 408 while the run is still going (verified live 2026-11-14).
    const resultUrl = `${PARALLEL_TASK_RUNS_URL}/${encodeURIComponent(runId)}/result?timeout=60`;
    for (;;) {
      const report = await request(resultUrl, { method: 'GET', headers: { 'x-api-key': apiKey } });
      const status = String(report.body?.run?.status ?? report.body?.status ?? '').toLowerCase();
      const notReady = report.status === 408 || report.status === 425 || report.status === 202;
      if (FAILED_STATUSES.includes(status)) {
        const reason = String(report.body?.error?.message ?? report.body?.error ?? status).slice(0, 200);
        throw taskError(PARALLEL_TASK_ERRORS.FAILED, `Parallel task run ${runId} ${status}: ${reason}`);
      }
      if (report.status === 401 || report.status === 403) {
        throw taskError(PARALLEL_TASK_ERRORS.KEY_REJECTED, `Parallel rejected the API key (HTTP ${report.status}).`);
      }
      if (report.status === 402 || report.status === 429) {
        throw taskError(PARALLEL_TASK_ERRORS.LIMITED, `Parallel is limiting task runs (HTTP ${report.status}).`);
      }
      if (report.ok && !notReady && !PENDING_STATUSES.includes(status)) {
        const output = report.body?.output ?? report.body?.result?.output;
        const text = taskOutputText(output);
        if (!text.trim()) throw taskError(PARALLEL_TASK_ERRORS.REPLY, `Parallel task run ${runId} finished without text.`);
        return { text, runId, processor, durationMs: now() - started, basisCount: taskBasisCount(output) };
      }
      if (report.status >= 400 && !notReady) throw taskError(PARALLEL_TASK_ERRORS.REPLY, `Parallel task result failed (HTTP ${report.status}).`);
      const wait = Math.min(interval, 2000, budget - (now() - started));
      if (wait <= 0) throw stoppedError();
      // Not unref'd: while a run is pending this sleep can be the only thing keeping the process alive.
      await new Promise(resolve => { setTimeout(resolve, wait); });
      if (controller.signal.aborted) throw stoppedError();
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', stop);
  }
}
