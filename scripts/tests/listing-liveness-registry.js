import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { getKnownTaskIds, taskMaxTokensFor } from '../../electron/ipc/llm.js';
import { BRIDGE_RAW_RESEARCH_TASKS, BRIDGE_RELEASE_ONE_TASKS } from '../../electron/ipc/nonApiAi.js';
import { PUSH_TASK_POLICY, assertPushTaskPolicy } from '../../electron/ipc/handoffBridge/sources/push.js';
import { cappedHandoff } from '../../electron/ipc/officialPostingService.js';
import { bridgeLinked, bridgeWorkerPoolActive } from '../../electron/ipc/handoffBridge/bridgeAvailability.js';

const TASK = 'job-listing-liveness';

function vocabulary(file, declaration) {
  const source = fs.readFileSync(new URL(`../../electron/ipc/handoffBridge/${file}`, import.meta.url), 'utf8');
  const start = source.indexOf(`const ${declaration} = new Set([`);
  const end = source.indexOf(']);', start);
  assert(start >= 0 && end > start, `${declaration} must remain an explicit closed vocabulary`);
  return new Set([...source.slice(start, end).matchAll(/'([a-z0-9-]+)'/gu)].map(match => match[1]));
}

export default [
  { name: 'listing liveness: AI task has the bounded batch token cap and release-one policy', run() {
    const known = getKnownTaskIds();
    assert(known.has(TASK), 'the liveness task must not fall through to the default task');
    assert(taskMaxTokensFor(TASK, { itemCount: 0 }) === 1184);
    assert(taskMaxTokensFor(TASK, { itemCount: 1 }) === 1184);
    assert(taskMaxTokensFor(TASK, { itemCount: 8 }) === 2304);
    assert(taskMaxTokensFor(TASK, { itemCount: 1000 }) === 15360, 'the batch cap must stop at the usable ceiling');
    assert(BRIDGE_RELEASE_ONE_TASKS.includes(TASK), 'the liveness task rides the reviewed bridge route');
    assert(!BRIDGE_RAW_RESEARCH_TASKS.includes(TASK), 'validated liveness JSON must not take the raw research exception');
    assert(PUSH_TASK_POLICY[TASK]?.mode === 'release_one' && PUSH_TASK_POLICY[TASK]?.bridgeable === true);
    assert(assertPushTaskPolicy(known), 'the complete known task set must match push policy');
  } },
  { name: 'listing liveness: closed bridge status vocabularies include the task', run() {
    for (const [file, declaration] of [
      ['controller.js', 'TASK_IDS'],
      ['engine.js', 'STATUS_PUSH_TASKS'],
      ['telemetry.js', 'QUEUE_PUSH_TASKS'],
    ]) {
      assert(vocabulary(file, declaration).has(TASK), `${declaration} must carry the task`);
    }
  } },
  { name: 'listing liveness: linked chat and active worker pool are distinct gates', run() {
    const linked = { enabled: true, link: { state: 'linked' }, chat: { pool: { active: false } } };
    assert(bridgeLinked(linked) && !bridgeWorkerPoolActive(linked), 'a linked single chat is available for search handoffs');
    assert(bridgeWorkerPoolActive({ ...linked, chat: { pool: { active: true } } }), 'Generate requires the active worker pool');
    assert(!bridgeLinked({ ...linked, enabled: false }) && !bridgeWorkerPoolActive({ ...linked, enabled: false }));
    assert(!bridgeLinked({ ...linked, link: { state: 'unlinked' } }));
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
