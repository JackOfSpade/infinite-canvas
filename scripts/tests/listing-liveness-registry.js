import { assert } from './testHelpers.js';
import { BATCH_OUTPUT_TOKEN_BUDGET } from '../../electron/ipc/resultCaps.js';
import { getKnownTaskIds, taskMaxTokensFor } from '../../electron/ipc/llm.js';
import { WORKER_RAW_RESEARCH_TASKS, WORKER_RELEASE_ONE_TASKS } from '../../electron/ipc/nonApiAi.js';
import { cappedHandoff } from '../../electron/ipc/officialPostingService.js';

const TASK = 'job-listing-liveness';

export default [
  { name: 'listing liveness: AI task has the bounded batch token cap and release-one task list', run() {
    const known = getKnownTaskIds();
    assert(known.has(TASK), 'the liveness task must not fall through to the default task');
    assert(taskMaxTokensFor(TASK, { itemCount: 0 }) === 1184);
    assert(taskMaxTokensFor(TASK, { itemCount: 1 }) === 1184);
    assert(taskMaxTokensFor(TASK, { itemCount: 8 }) === 2304);
    assert(taskMaxTokensFor(TASK, { itemCount: 1000 }) === BATCH_OUTPUT_TOKEN_BUDGET, 'the batch cap must stop at the usable output budget');
    assert(WORKER_RELEASE_ONE_TASKS.includes(TASK), 'the liveness task is released to a worker one handoff at a time');
    assert(!WORKER_RAW_RESEARCH_TASKS.includes(TASK), 'validated liveness JSON must not take the raw research exception');
  } },
  { name: 'listing liveness: capped handoff forwards text-task options and keeps a separate stats sink', async run() {
    const stats = { handoffs: 0, handoffMs: 0 };
    let observed;
    const request = {
      task: TASK,
      format: 'json',
      prompt: 'Synthetic liveness evidence.',
      responseSchema: { type: 'object' },
      hints: { itemCount: 2, batch: 1, batchTotal: 1 },
      manualHandoff: {},
      responseValidator: () => true,
    };
    const result = await cappedHandoff(request, {
      call: async (prompt, options) => { observed = { prompt, options }; return { rows: [] }; },
      timeoutMs: 1000,
      now: () => 100,
      stats,
      manualAiRunId: 'synthetic-run',
      nodeId: 'synthetic-node',
    });
    assert(result?.rows?.length === 0);
    assert(observed.prompt === request.prompt && observed.options.task === TASK && observed.options.format === 'json');
    assert(observed.options.responseSchema === request.responseSchema
      && observed.options.responseValidator === request.responseValidator
      && observed.options.manualHandoff === request.manualHandoff);
    assert(observed.options.hints.itemCount === 2 && observed.options.hints.batch === 1 && observed.options.hints.batchTotal === 1);
    assert(observed.options.manualAiRunId === 'synthetic-run' && observed.options.nodeId === 'synthetic-node');
    assert(stats.handoffs === 1 && stats.handoffMs === 0);
  } },
];
