import test from 'node:test';
import assert from 'node:assert/strict';
import { runParallelTask, PARALLEL_TASK_PROCESSORS, PARALLEL_TASK_ERRORS, PARALLEL_TASK_RUNS_URL } from './parallel-task-arm.mjs';

const KEY = 'parallel-test-key-0123456789';
const PROMPT = 'BEGIN RESEARCH c1\nFind salary sources for c1.\nEND RESEARCH c1';
const RUN_ID = 'trun_0123456789';

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });

/** A fake fetch that answers one POST then the given result replies in order. */
function fakeFetch({ created = json(200, { run_id: RUN_ID, status: 'queued' }), results }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'POST') {
      if (calls.filter(call => call.init.method === 'POST').length > 1) throw new Error('create called twice');
      return typeof created === 'function' ? created(url, init) : created;
    }
    const index = calls.filter(call => call.init.method === 'GET').length - 1;
    const result = results[Math.min(index, results.length - 1)];
    return typeof result === 'function' ? result(url, init) : result;
  };
  return { fetch, calls };
}

const completed = content => json(200, { status: 'completed', output: { content, basis: [{ id: 'b1' }, { id: 'b2' }] } });

test('PARALLEL_TASK_PROCESSORS lists the six Task API processors', () => {
  assert.deepEqual([...PARALLEL_TASK_PROCESSORS], ['lite', 'base', 'core', 'core2x', 'pro', 'ultra']);
});

test('a task run creates then polls the result and returns the text with its run id and basis', async () => {
  const { fetch, calls } = fakeFetch({ results: [completed('the researched reply')] });
  let clock = 0;
  const reply = await runParallelTask({ input: PROMPT, processor: 'pro', key: KEY, fetch, now: () => (clock += 500), pollSeconds: 0.001 });

  assert.equal(calls.length, 2);
  const [create, poll] = calls;
  assert.equal(create.url, PARALLEL_TASK_RUNS_URL);
  assert.equal(create.init.method, 'POST');
  assert.equal(create.init.headers['content-type'], 'application/json');
  assert.equal(create.init.headers['x-api-key'], KEY);
  assert.equal(create.body.input, PROMPT);
  assert.equal(create.body.processor, 'pro');
  assert.deepEqual(create.body.task_spec, { output_schema: { type: 'text' } });
  assert.equal(poll.url, `${PARALLEL_TASK_RUNS_URL}/${RUN_ID}/result?timeout=60`);
  assert.equal(poll.init.method, 'GET');
  assert.equal(poll.init.headers['x-api-key'], KEY);

  assert.equal(reply.text, 'the researched reply');
  assert.equal(reply.runId, RUN_ID);
  assert.equal(reply.processor, 'pro');
  assert.equal(reply.basisCount, 2);
  // now() counts 500 at the start and 1000 at the finish, so the run reports 500 ms.
  assert.equal(reply.durationMs, 500);
});

test('a running run is polled again until its result is ready', async () => {
  const { fetch, calls } = fakeFetch({ results: [json(202, { status: 'running' }), json(202, {}), completed('ready at last')] });
  const reply = await runParallelTask({ input: PROMPT, key: KEY, fetch, pollSeconds: 0.001 });
  assert.equal(reply.text, 'ready at last');
  assert.equal(reply.processor, 'core');
  assert.equal(calls.filter(call => call.init.method === 'GET').length, 3);
});

test('a failed run throws its failure code and reason, not a reply', async () => {
  const { fetch } = fakeFetch({ results: [json(200, { status: 'failed', error: { message: 'processor gave up' } })] });
  await assert.rejects(runParallelTask({ input: PROMPT, key: KEY, fetch, pollSeconds: 0.001 }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.FAILED);
    assert.match(error.message, /processor gave up/u);
    return true;
  });
});

test('a missing key fails before any request is made', async () => {
  const { fetch, calls } = fakeFetch({ results: [completed('never')] });
  await assert.rejects(runParallelTask({ input: PROMPT, key: '', fetch }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.KEY_MISSING);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('an unknown processor is refused before any request is made', async () => {
  const { fetch, calls } = fakeFetch({ results: [completed('never')] });
  await assert.rejects(runParallelTask({ input: PROMPT, processor: 'turbo', key: KEY, fetch }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.PROCESSOR);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('a run that never finishes times out instead of polling forever', async () => {
  const { fetch, calls } = fakeFetch({ results: [json(202, { status: 'running' })] });
  const startedAt = Date.now();
  await assert.rejects(runParallelTask({ input: PROMPT, key: KEY, fetch, timeoutMs: 40, pollSeconds: 0.005 }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.TIMEOUT);
    return true;
  });
  assert.ok(Date.now() - startedAt < 5000, 'the timeout was bounded by timeoutMs');
  assert.ok(calls.filter(call => call.init.method === 'GET').length >= 1);
});

test('an aborted signal stops the run with the abort code', async () => {
  const controller = new AbortController();
  const { fetch } = fakeFetch({
    results: [
      json(202, { status: 'running' }),
      () => { controller.abort(); return json(202, { status: 'running' }); },
      completed('too late'),
    ],
  });
  await assert.rejects(runParallelTask({ input: PROMPT, key: KEY, fetch, signal: controller.signal, pollSeconds: 0.005 }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.ABORTED);
    return true;
  });
});

test('an already-aborted signal makes no request at all', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetch, calls } = fakeFetch({ results: [completed('never')] });
  await assert.rejects(runParallelTask({ input: PROMPT, key: KEY, fetch, signal: controller.signal }), error => {
    assert.equal(error.code, PARALLEL_TASK_ERRORS.ABORTED);
    return true;
  });
  assert.equal(calls.length, 0);
});
