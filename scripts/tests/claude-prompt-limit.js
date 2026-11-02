import assert from 'node:assert/strict';
import { classifyClaudeFailure } from '../../electron/ipc/claudeApplicationRunner.js';
import { runClaudeSdkStage } from '../../electron/ipc/claudeApplicationSdkStage.js';
import {
  assertClaudePromptFits,
  CLAUDE_CONTEXT_WINDOW_TOKENS,
  CLAUDE_OUTPUT_TOKENS,
  CLAUDE_PROMPT_TOKEN_BUDGET,
  CLAUDE_PROMPT_TOO_LONG,
  estimateClaudePromptTokens,
} from '../../electron/ipc/claudePromptLimit.js';
import { callLLMRaw, callLLMText, callLLMVision, checkPromptFits } from '../../electron/ipc/llm.js';

const SCHEMA = { type: 'object', properties: {} };
// 2.5 UTF-8 bytes make one estimated token, so this many bytes is exactly the budget.
const BUDGET_BYTES = CLAUDE_PROMPT_TOKEN_BUDGET * 2.5;
const tooLong = error => error?.code === CLAUDE_PROMPT_TOO_LONG;

export default [
  {
    name: 'claude prompt limit: the budget leaves room for the full output limit and the CLI itself',
    run() {
      assert.equal(CLAUDE_CONTEXT_WINDOW_TOKENS, 1_000_000);
      assert.equal(CLAUDE_OUTPUT_TOKENS, 128_000);
      assert(CLAUDE_PROMPT_TOKEN_BUDGET < CLAUDE_CONTEXT_WINDOW_TOKENS - CLAUDE_OUTPUT_TOKENS - 16_000,
        'the measured 16,000-token CLI overhead fits inside the reserve');
    },
  },
  {
    name: 'claude prompt limit: the estimate counts bytes, so non-Latin text is not undercounted',
    run() {
      assert.equal(estimateClaudePromptTokens('aaaaa'), 2);
      assert.equal(estimateClaudePromptTokens('日本語'), 4);
      assert.equal(estimateClaudePromptTokens('aaaaa', null, undefined, 'aaaaa'), 4, 'missing parts add nothing');
    },
  },
  {
    name: 'claude prompt limit: checkPromptFits flips at the budget and counts prefix and schema too',
    async run() {
      const fits = await checkPromptFits('x'.repeat(BUDGET_BYTES), { task: 'job-scoring' });
      assert.equal(fits.fits, true);
      assert.equal(fits.tokens, CLAUDE_PROMPT_TOKEN_BUDGET);
      assert.equal((await checkPromptFits('x'.repeat(BUDGET_BYTES + 3), { task: 'job-scoring' })).fits, false);
      assert.equal((await checkPromptFits('x'.repeat(BUDGET_BYTES), { task: 'job-scoring', cachedPrefix: 'yyy' })).fits, false);
      assert.equal((await checkPromptFits('x'.repeat(BUDGET_BYTES), { task: 'job-scoring', responseSchema: SCHEMA })).fits, false);
    },
  },
  {
    name: 'claude prompt limit: every AI call refuses an oversized prompt before issuing a request',
    async run() {
      const oversized = 'x'.repeat(BUDGET_BYTES + 3);
      // A request that got past the check would wait on a handoff forever, so a
      // rejection here also proves none was issued.
      await assert.rejects(callLLMText(oversized, { task: 'job-scoring', responseSchema: SCHEMA }), tooLong);
      await assert.rejects(callLLMRaw(oversized, { task: 'job-scoring' }), tooLong);
      await assert.rejects(callLLMRaw('small', { task: 'job-scoring', cachedPrefix: oversized }), tooLong);
      await assert.rejects(callLLMVision([], oversized, { task: 'job-scoring', responseSchema: SCHEMA }), tooLong);
    },
  },
  {
    name: 'claude prompt limit: a Claude stage refuses before starting Claude, counting the system prompt',
    async run() {
      let started = 0;
      const queryImpl = () => { started += 1; throw new Error('Claude must not start'); };
      await assert.rejects(runClaudeSdkStage({ text: 'x'.repeat(BUDGET_BYTES + 3), queryImpl }), tooLong);
      await assert.rejects(runClaudeSdkStage({ text: 'small', systemAppend: 'x'.repeat(BUDGET_BYTES + 3), queryImpl }), tooLong);
      assert.equal(started, 0);
    },
  },
  {
    name: 'claude prompt limit: Claude saying the prompt is too long gets its own code, and other failures do not',
    run() {
      for (const result of ['Prompt is too long', 'prompt is too long: 1100000 tokens > 1000000 maximum', 'input length and max_tokens exceed context limit']) {
        assert.equal(classifyClaudeFailure({ parsed: { result }, exitCode: 1 }).code, CLAUDE_PROMPT_TOO_LONG, result);
      }
      assert.equal(classifyClaudeFailure({ parsed: null, stderr: 'Prompt is too long', exitCode: 1 }).code, CLAUDE_PROMPT_TOO_LONG);
      assert.equal(classifyClaudeFailure({ parsed: { result: 'Something broke' }, exitCode: 1 }).code, 'CLAUDE_ERROR');
    },
  },
  {
    name: 'claude prompt limit: assertClaudePromptFits passes at the budget and throws above it',
    run() {
      assert.doesNotThrow(() => assertClaudePromptFits('x'.repeat(BUDGET_BYTES)));
      assert.throws(() => assertClaudePromptFits('x'.repeat(BUDGET_BYTES), 'yyy'),
        error => tooLong(error) && /848,000/.test(error.message));
    },
  },
];
