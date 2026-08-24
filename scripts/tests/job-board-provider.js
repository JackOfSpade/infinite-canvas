import { assert } from './testHelpers.js';
import { isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../../src/utils/jobBoardAiProvider.js';

export default [
  {
    name: 'Job Board taxonomy validation rejects incomplete API output before board replacement',
    run() {
      const valid = validateJobBoardTaxonomy({
        roles: [{ name: 'Engineering', jobIndices: [0, 1] }],
      }, 2);
      assert(valid.valid, `complete role taxonomy should be valid: ${valid.reason}`);
      const missing = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0] }] }, 2);
      const duplicate = validateJobBoardTaxonomy({ roles: [{ name: 'Engineering', jobIndices: [0, 0] }] }, 1);
      assert(!missing.valid && !duplicate.valid,
        'incomplete or duplicate role assignment must abort before it can replace a board');
      return { completeAccepted: true, invalidRejected: true };
    },
  },
  {
    name: 'Job Board hides editable legacy flat cards until a successful Re-combine',
    run() {
      const flatNodes = [{ type: 'jobcard', data: { hubId: 'board' } }];
      assert(isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null }, flatNodes, 'board'),
        'an editable done board with direct cards and no taxonomy must be marked stale');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: null, locked: true }, flatNodes, 'board'),
        'a locked snapshot must retain its historical view');
      assert(!isLegacyUnbucketedJobBoard({ hubState: 'done', jobTaxonomy: { roles: [] } }, flatNodes, 'board'),
        'a board with persisted taxonomy is not the legacy flat-card case');
      return { legacyFlatBoardHidden: true, lockedSnapshotPreserved: true };
    },
  },
];
