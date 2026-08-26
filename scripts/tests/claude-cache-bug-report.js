import { assert, buildClaudePromptCacheTelemetryMarkdown } from '../test-dependencies.js';

export default [
  {
    name: 'Bug report Claude prompt-cache telemetry reports session hit, write, and token metrics',
    run: () => {
      const report = buildClaudePromptCacheTelemetryMarkdown({
        requested: 5,
        hits: 3,
        writes: 4,
        cacheReadInputTokens: 8_192,
        cacheWriteInputTokens: 2_048,
        uncachedInputTokens: 1_024,
        tasks: {
          jobScoring: {
            requested: 5,
            hits: 3,
            writes: 4,
            cacheReadInputTokens: 8_192,
            cacheWriteInputTokens: 2_048,
          },
        },
      }, { provider: 'claude' });
      assert(report.includes('## Claude Prompt Cache Telemetry')
        && report.includes('Session-retained')
        && report.includes('reset when the app restarts'),
      'cache telemetry must clearly state its in-memory session lifetime');
      assert(report.includes('Cache hits: 3 (60.0% of cache-marked requests)')
        && report.includes('Cache writes: 4')
        && report.includes('8,192 cache-read · 2,048 cache-write · 1,024 uncached'),
      'cache telemetry must show hit/write counts and all input-token categories');
      assert(report.includes('| `jobScoring` | 5 | 3 | 4 | 8192 | 2048 |'),
      'cache telemetry must preserve per-task counters for actionable diagnostics');

      const noClaudeData = buildClaudePromptCacheTelemetryMarkdown({}, { provider: 'gemini' });
      assert(noClaudeData === '',
        'cache telemetry should stay out of Gemini reports until this session has Claude cache data');
      assert(buildClaudePromptCacheTelemetryMarkdown({ requested: 1 }, { provider: 'gemini' })
        .includes('## Claude Prompt Cache Telemetry'),
      'cache telemetry should remain visible after this session used Claude even when Gemini is now selected');
      return { cacheHits: 3, tokenCategories: 3 };
    },
  },
];
