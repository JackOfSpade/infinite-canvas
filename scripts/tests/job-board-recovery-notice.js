import fs from 'node:fs';
import assert from 'node:assert';

import {
  SAVED_HANDOFF_READY_MESSAGE,
  combineCommitMismatchReason,
  isLiveCombineOwnedMarker,
} from '../../src/nodes/jobboard/boardRecoveryNotice.js';

function readNodeSource() {
  return fs.readFileSync(
    new URL('../../src/nodes/JobBoardNode.jsx', import.meta.url),
    'utf8',
  );
}

export default [
  {
    name: 'board recovery notice constant text is exact and mismatch reason reports the first failing invariant',
    run: async () => {
      assert(
        SAVED_HANDOFF_READY_MESSAGE === 'Saved AI handoff ready. Choose Continue saved AI handoff to resume this exact Board run.',
        'SAVED_HANDOFF_READY_MESSAGE must keep its exact user-facing text',
      );

      // All 8 boolean combinations, including priority order. `combineCommitMismatchReason`
      // fails on any non-true value and returns the first failing check, so feed the raw
      // booleans from the node's three up-front comparisons.
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: true, exactSourceRunsMatch: true }) === null, 'all true -> null');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'signature wins priority');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: false, exactSourceRunsMatch: true }) === 'selected-runs', 'selected-runs second');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: true, exactSourceRunsMatch: false }) === 'exact-source-runs', 'exact-source-runs third');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: false, exactSourceRunsMatch: true }) === 'input-signature', 'signature beats selected-runs');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: true, exactSourceRunsMatch: false }) === 'input-signature', 'signature beats exact-source-runs');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: false, exactSourceRunsMatch: false }) === 'selected-runs', 'selected-runs beats exact-source-runs');
      assert(combineCommitMismatchReason({ signatureMatches: false, selectedRunsMatch: false, exactSourceRunsMatch: false }) === 'input-signature', 'all false -> first');
    },
  },
  {
    name: 'board recovery notice mismatch reason and marker ownership handle non-boolean and non-string inputs',
    run: async () => {
      // Non-true values (including truthy-but-not-true) count as failing.
      assert(combineCommitMismatchReason({ signatureMatches: 1, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'truthy non-true signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: 'yes', selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'string signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: undefined, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'undefined signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: null, selectedRunsMatch: true, exactSourceRunsMatch: true }) === 'input-signature', 'null signature fails');
      assert(combineCommitMismatchReason({ signatureMatches: true, selectedRunsMatch: 1, exactSourceRunsMatch: true }) === 'selected-runs', 'truthy non-true selected fails');

      // isLiveCombineOwnedMarker requires non-empty string equality.
      assert(isLiveCombineOwnedMarker('run-a', 'run-a') === true, 'equal strings -> owned');
      assert(isLiveCombineOwnedMarker('run-a', 'run-b') === false, 'different strings -> not owned');
      assert(isLiveCombineOwnedMarker('', 'run-a') === false, 'empty resume id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', '') === false, 'empty active id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', null) === false, 'null active id -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', undefined) === false, 'undefined active id -> not owned');
      assert(isLiveCombineOwnedMarker(123, 123) === false, 'numbers -> not owned');
      assert(isLiveCombineOwnedMarker('run-a', 123) === false, 'mixed string/number -> not owned');
    },
  },
  {
    name: 'JobBoardNode imports the notice helpers and guards the restored-marker notice from a live combine',
    run: async () => {
      const source = readNodeSource();

      // (a) The node imports both helpers from the new module.
      assert(source.includes("import { SAVED_HANDOFF_READY_MESSAGE, isLiveCombineOwnedMarker, combineCommitMismatchReason } from './jobboard/boardRecoveryNotice';"), 'node must import notice helpers');
      assert(source.includes("import { "), 'import statements present');

      // (b) Inside the marker effect, the live-owner guard must run before setRecoveryError(message).
      const effectStart = source.indexOf('const resume = data.manualAiResume;');
      assert(effectStart !== -1, 'marker effect present');
      const guardAt = source.indexOf('isLiveCombineOwnedMarker(resume.runId, activeCombineManualAiRunRef.current?.runId)', effectStart);
      const setAt = source.indexOf('setRecoveryError(message)', effectStart);
      assert(guardAt !== -1, 'live owner guard present in effect');
      assert(setAt !== -1, 'setRecoveryError(message) present in effect');
      assert(guardAt < setAt, 'guard must return early before setRecoveryError(message)');

      // (c) A clearing effect exists referencing the constant and clearing the notice.
      const clearEffect = source.indexOf('if (recoveryError !== SAVED_HANDOFF_READY_MESSAGE) return;');
      assert(clearEffect !== -1, 'clearing effect must reference SAVED_HANDOFF_READY_MESSAGE');
      const clearCall = source.indexOf('setRecoveryError(null)', clearEffect);
      assert(clearCall !== -1 && clearCall < source.indexOf('const handleRetryRecovery'), 'clearing effect must call setRecoveryError(null)');

      // (d) The supersede log now names which invariant failed.
      assert(source.includes('[JobBoard] combine superseded before commit id=${id} signature=${sigAtCombine} reason=${mismatchReason}'), 'supersede log must append reason=');
    },
  },
];
