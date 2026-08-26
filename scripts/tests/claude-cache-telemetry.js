import { assert, getClaudeCacheTelemetry, recordClaudeCacheUsage, _resetClaudeCacheTelemetry } from '../test-dependencies.js';

export default [
  {
    name: 'Claude cache telemetry: records requested calls, cache reads/writes, and uncached input by task',
    run: () => {
      _resetClaudeCacheTelemetry();
      recordClaudeCacheUsage({
        task: 'job-scoring', model: 'claude-sonnet-test', cachedPrefix: 'shared evidence', ts: 100,
        usage: { input_tokens: 280, cache_creation_input_tokens: 1800, cache_read_input_tokens: 0 },
      });
      recordClaudeCacheUsage({
        task: 'job-scoring', model: 'claude-sonnet-test', cachedPrefix: 'shared evidence', ts: 200,
        usage: { input_tokens: 310, cache_read_input_tokens: 1800 },
      });
      recordClaudeCacheUsage({
        task: 'cover-letter', model: 'claude-sonnet-test', usage: { input_tokens: 90 }, ts: 300 });

      const snapshot = getClaudeCacheTelemetry();
      assert(snapshot.requested === 2 && snapshot.writes === 1 && snapshot.hits === 1,
        `expected requested/write/hit totals, got ${JSON.stringify(snapshot)}`);
      assert(snapshot.cacheWriteInputTokens === 1800 && snapshot.cacheReadInputTokens === 1800
        && snapshot.uncachedInputTokens === 680,
      `expected token totals split by cache status, got ${JSON.stringify(snapshot)}`);
      assert(snapshot.tasks['job-scoring'].requested === 2
        && snapshot.tasks['job-scoring'].uncachedInputTokens === 590
        && snapshot.tasks['cover-letter'].requested === 0,
      `expected per-task telemetry, got ${JSON.stringify(snapshot.tasks)}`);
      assert(snapshot.lastEvent.task === 'cover-letter' && snapshot.tasks['job-scoring'].lastEvent.ts === 200,
        'global and task last events retain their respective most recent calls');

      snapshot.tasks['job-scoring'].requested = 999;
      assert(getClaudeCacheTelemetry().tasks['job-scoring'].requested === 2,
        'telemetry snapshots must not expose mutable live state');
      recordClaudeCacheUsage({ task: 'empty-prefix', cachedPrefix: '', usage: { input_tokens: 1 }, ts: 400 });
      assert(getClaudeCacheTelemetry().tasks['empty-prefix'].requested === 0,
        'an empty prefix does not create an Anthropic cache-control request');
      return { requested: snapshot.requested, writes: snapshot.writes, hits: snapshot.hits };
    },
  },
  {
    name: 'Claude cache telemetry: bounds retained task stats and resets cleanly',
    run: () => {
      _resetClaudeCacheTelemetry();
      for (let i = 0; i < 25; i++) {
        recordClaudeCacheUsage({ task: `task-${i}`, usage: { input_tokens: 1 }, ts: i });
      }
      const bounded = getClaudeCacheTelemetry();
      assert(Object.keys(bounded.tasks).length === 24 && !bounded.tasks['task-0'] && bounded.tasks['task-24'],
        `task telemetry must retain only the newest 24 tasks, got ${JSON.stringify(Object.keys(bounded.tasks))}`);
      _resetClaudeCacheTelemetry();
      const cleared = getClaudeCacheTelemetry();
      assert(cleared.requested === 0 && cleared.lastEvent === null && Object.keys(cleared.tasks).length === 0,
        `reset must clear the session telemetry, got ${JSON.stringify(cleared)}`);
      return { retainedTasks: Object.keys(bounded.tasks).length };
    },
  },
];
