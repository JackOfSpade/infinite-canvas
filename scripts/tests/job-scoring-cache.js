import { assert, buildJobScoringRequestParts } from '../test-dependencies.js';

export default [
  {
    name: 'job scoring cache: single-batch runs merge the rubric into one prompt',
    run: () => {
      const cachedPrefix = 'SCORING RUBRIC\nCANDIDATE EVIDENCE';
      const dynamicPrompt = 'JOBS TO SCORE: [{"index":0}]';
      const parts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, 1);
      assert(parts.cachedPrefix === null,
        'one top-level batch has no separately reusable prefix');
      assert(parts.prompt === `${cachedPrefix}\n\n${dynamicPrompt}`,
        'one-batch request preserves the complete rubric, evidence, and jobs payload in order');
      return { cached: false };
    },
  },
  {
    name: 'job scoring cache: repeated top-level batches keep the reusable prefix separate',
    run: () => {
      const cachedPrefix = 'SCORING RUBRIC\nCANDIDATE EVIDENCE';
      const dynamicPrompt = 'JOBS TO SCORE: [{"index":0}]';
      const parts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, 2);
      assert(parts.prompt === dynamicPrompt && parts.cachedPrefix === cachedPrefix,
        'two top-level batches retain the separate reusable prefix');

      const noBatchParts = buildJobScoringRequestParts(dynamicPrompt, cachedPrefix, Number.NaN);
      assert(noBatchParts.cachedPrefix === null && noBatchParts.prompt === `${cachedPrefix}\n\n${dynamicPrompt}`,
        'zero/invalid batch counts cannot create a prefix-only split');
      const noPrefixParts = buildJobScoringRequestParts(dynamicPrompt, '', 2);
      assert(noPrefixParts.cachedPrefix === null && noPrefixParts.prompt === dynamicPrompt,
        'an empty prefix leaves the dynamic prompt unchanged');
      return { cached: true };
    },
  },
];
