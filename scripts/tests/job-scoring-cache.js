import { assert, buildAnthropicMessageParams, buildJobScoringRequestParts } from '../test-dependencies.js';

export default [
  {
    name: 'job scoring cache: single-batch runs merge the rubric without an Anthropic cache write',
    run: () => {
      const cachedPrefix = 'SCORING RUBRIC\nCANDIDATE EVIDENCE';
      const dynamicPrompt = 'JOBS TO SCORE: [{"index":0}]';
      const parts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, 1);
      assert(parts.cachedPrefix === null,
        'one top-level batch has no cacheable prefix');
      assert(parts.prompt === `${cachedPrefix}\n\n${dynamicPrompt}`,
        'one-batch request preserves the complete rubric, evidence, and jobs payload in order');

      const request = buildAnthropicMessageParams(parts.prompt, {
        model: 'claude-sonnet-4-6', maxTokens: 1000,
        responseSchema: { type: 'object', properties: {} }, cachedPrefix: parts.cachedPrefix,
      });
      assert(request.messages[0].content === parts.prompt,
        'one-batch Anthropic request sends the merged semantic prompt directly');
      assert(!JSON.stringify(request.messages).includes('cache_control'),
        'one-batch Anthropic request contains no cache marker');
      return { cached: false };
    },
  },
  {
    name: 'job scoring cache: repeated top-level batches preserve the cache-marked prefix',
    run: () => {
      const cachedPrefix = 'SCORING RUBRIC\nCANDIDATE EVIDENCE';
      const dynamicPrompt = 'JOBS TO SCORE: [{"index":0}]';
      const parts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, 2);
      assert(parts.prompt === dynamicPrompt && parts.cachedPrefix === cachedPrefix,
        'two top-level batches retain the separate reusable prefix');

      const request = buildAnthropicMessageParams(parts.prompt, {
        model: 'claude-sonnet-4-6', maxTokens: 1000,
        responseSchema: { type: 'object', properties: {} }, cachedPrefix: parts.cachedPrefix,
      });
      const [prefixBlock, dynamicBlock] = request.messages[0].content;
      assert(prefixBlock.text === cachedPrefix && prefixBlock.cache_control?.type === 'ephemeral'
        && dynamicBlock.text === dynamicPrompt,
      'multi-batch Anthropic request keeps the same prompt content with an ephemeral cache marker');

      const noBatchParts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, Number.NaN);
      assert(noBatchParts.cachedPrefix === null && noBatchParts.prompt === `${cachedPrefix}\n\n${dynamicPrompt}`,
        'zero/invalid batch counts cannot create a cache-write-only request');
      const noPrefixParts = buildJobScoringRequestParts(dynamicPrompt, '', 2);
      assert(noPrefixParts.cachedPrefix === null && noPrefixParts.prompt === dynamicPrompt,
        'an empty prefix leaves the dynamic prompt unchanged');
      return { cached: true };
    },
  },
];
