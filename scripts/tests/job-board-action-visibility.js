import fs from 'node:fs';
import assert from 'node:assert';

import { canFinishPausedBoardSearch, isJobBoardUpToDate } from '../../src/utils/jobBoardSearchSelection.js';

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function validState() {
  return {
    hubState: 'done',
    stale: false,
    connectedCount: 2,
    completedCount: 2,
    combineSignature: 'sig:a;b',
    liveSignature: 'sig:a;b',
  };
}

export default [
  {
    name: 'isJobBoardUpToDate returns true only for a done, current, fully complete and signature-matched board',
    run: async () => {
      assert(isJobBoardUpToDate(validState()) === true, 'all-true case must be up to date');

      // Each single condition flipped => false. Use a table so every branch
      // is proven independently and the failure message names the case.
      const falsifying = [
        ['hubState empty', { hubState: 'empty' }, 'a non-done hub state must not be up to date'],
        ['hubState error', { hubState: 'error' }, 'a failed board must not be up to date'],
        ['hubState sources-ready', { hubState: 'sources-ready' }, 'a sources-ready board must not be up to date'],
        ['hubState scoring', { hubState: 'scoring' }, 'a still-scoring board must not be up to date'],
        ['stale true', { stale: true }, 'a stale board must not be up to date'],
        ['pending saved-job re-score', { pendingSourceWork: true }, 'a matching result signature must not hide a pending scoring repair or replacement-career re-score'],
        ['connectedCount 0', { connectedCount: 0, completedCount: 0 }, 'zero connected searches must not be up to date'],
        ['completedCount fewer', { completedCount: 1 }, 'an incomplete board must not be up to date'],
        ['completedCount more', { completedCount: 3 }, 'more completed than connected must not be up to date'],
        ['combineSignature missing', { combineSignature: undefined }, 'a missing persisted signature must not be up to date'],
        ['combineSignature empty', { combineSignature: '' }, 'an empty persisted signature must not be up to date'],
        ['liveSignature missing', { liveSignature: undefined }, 'a missing live signature must not be up to date'],
        ['liveSignature empty', { liveSignature: '' }, 'an empty live signature must not be up to date'],
        ['mismatched signatures', { combineSignature: 'sig:old' }, 'mismatched signatures must not be up to date'],
      ];
      for (const [label, patch, message] of falsifying) {
        assert(isJobBoardUpToDate({ ...validState(), ...patch }) === false, `${label}: ${message}`);
      }

      // Malformed / non-safe counts fail closed.
      const countCases = [
        ['connectedCount NaN', { connectedCount: NaN }],
        ['connectedCount float', { connectedCount: 2.5 }],
        ['connectedCount string', { connectedCount: '2' }],
        ['completedCount NaN', { completedCount: NaN }],
        ['completedCount float', { completedCount: 2.5 }],
        ['completedCount string', { completedCount: '2' }],
        ['connectedCount negative', { connectedCount: -1, completedCount: -1 }],
        ['connectedCount Infinity', { connectedCount: Infinity, completedCount: Infinity }],
      ];
      for (const [label, patch] of countCases) {
        assert(isJobBoardUpToDate({ ...validState(), ...patch }) === false, `${label} must not be up to date`);
      }

      // Non-object/undefined/null arguments => false, never throws.
      assert(isJobBoardUpToDate(undefined) === false, 'undefined must be false');
      assert(isJobBoardUpToDate(null) === false, 'null must be false');
      assert(isJobBoardUpToDate('done') === false, 'a string argument must be false');
      assert(isJobBoardUpToDate(42) === false, 'a number argument must be false');
      assert(isJobBoardUpToDate(() => {}) === false, 'a function argument must be false');
    },
  },
  {
    name: 'JobBoardSearchSelection hides the combine button behind the up-to-date status branch',
    run: async () => {
      const selection = readSource('../../src/nodes/jobboard/JobBoardSearchSelection.jsx');

      // Optional prop with a non-truthy default of false.
      assert(selection.includes('upToDate = false'), 'upToDate must default to false');

      // The non-interactive status replaces the primary action.
      assert(selection.includes('data-action-state="up-to-date"'), 'up-to-date branch must render a role="status" with data-action-state="up-to-date"');
      assert(selection.includes("'board-up-to-date'"), 'eligibilityReasons must include board-up-to-date');
      assert(selection.includes('actionVisible: !boardUpToDate'), 'onRuntimeSnapshot must report actionVisible as !boardUpToDate');

      // The exact gate: only an explicit true, not running, not recovering.
      assert(selection.includes('upToDate === true && !running && !recoveryError'), 'boardUpToDate must be gated on upToDate === true && !running && !recoveryError');

      // Ordering: the up-to-date <p> branch must come AFTER the recoveryError
      // retry/cancel branch and BEFORE the primary action button branch.
      const recoveryAt = selection.indexOf('recoveryError ? (');
      const upToDateAt = selection.indexOf('data-action-state="up-to-date"');
      const primaryButtonAt = selection.indexOf(
        '<button',
        selection.indexOf(') : (', selection.indexOf('data-action-state="up-to-date"')),
      );
      assert(recoveryAt !== -1 && upToDateAt !== -1 && primaryButtonAt !== -1, 'all three branches must be present');
      assert(recoveryAt < upToDateAt, 'the up-to-date branch must render after the recovery retry/cancel branch');
      assert(upToDateAt < primaryButtonAt, 'the up-to-date branch must render before the primary action button branch');
    },
  },
  {
    name: 'canFinishPausedBoardSearch is true only for a paused, active, non-cancelling searches-phase plan',
    run: async () => {
      const pausedPlan = () => ({
        version: 1,
        boardRunId: 'board-run-1',
        phase: 'searches',
        pausedByUser: true,
        activeSourceId: 'jobsearch-1',
        autoResumeEligible: false,
      });

      assert(canFinishPausedBoardSearch(pausedPlan()) === true, 'a paused, active searches-phase plan must be finishable');
      assert(canFinishPausedBoardSearch({ ...pausedPlan(), pausedByUser: false }) === true,
        'autoResumeEligible === false alone also marks the plan user-paused');
      assert(canFinishPausedBoardSearch({ ...pausedPlan(), activeSourceId: null, activeSourceIds: ['jobsearch-1'] }) === true,
        'a non-empty activeSourceIds array also proves an active source');
      assert(canFinishPausedBoardSearch({ ...pausedPlan(), cancellationCleanupsBySource: {} }) === true,
        'an empty cancellationCleanupsBySource map must not block finishing');

      // Each single falsifier flips the verdict. The table keeps every branch
      // independently proven and names the failing case.
      const falsifying = [
        ['wrong version', { version: 2 }, {}, 'a non-v1 plan must not be finishable'],
        ['missing boardRunId', { boardRunId: '' }, {}, 'an empty boardRunId must not be finishable'],
        ['phase combine', { phase: 'combine' }, {}, 'a combine-phase plan is not a paused scan'],
        ['not paused', { pausedByUser: false, autoResumeEligible: true }, {}, 'a plan that auto-resumes is not user-paused'],
        ['no active source', { activeSourceId: null, activeSourceIds: [] }, {}, 'a plan with no active source must not be finishable'],
        ['cancellationCleanup', { cancellationCleanup: { sourceId: 'jobsearch-1' } }, {}, 'a plan mid-cancellation must not be finishable'],
        ['cancellationCleanupsBySource', { cancellationCleanupsBySource: { 'jobsearch-1': { sourceId: 'jobsearch-1' } } }, {}, 'per-source cleanup receipts must block finishing'],
        ['recoverableFailure', { recoverableFailure: { sourceId: 'jobsearch-1', kind: 'terminal-finalization' } }, {}, 'a recoverable failure must not be finished as a success'],
        ['scanning', {}, { scanning: true }, 'a running scan must not be finishable'],
        ['combining', {}, { combining: true }, 'a running combine must not be finishable'],
        ['locked', {}, { locked: true }, 'a locked board must not be finishable'],
      ];
      for (const [label, patch, options, message] of falsifying) {
        assert(canFinishPausedBoardSearch({ ...pausedPlan(), ...patch }, options) === false, `${label}: ${message}`);
      }

      // Total and pure: malformed input is false, never a throw, never a write.
      const snapshot = JSON.stringify(pausedPlan());
      assert(canFinishPausedBoardSearch(null) === false, 'null must be false');
      assert(canFinishPausedBoardSearch(undefined) === false, 'undefined must be false');
      assert(canFinishPausedBoardSearch('board-run-1') === false, 'a string must be false');
      assert(canFinishPausedBoardSearch(7) === false, 'a number must be false');
      assert(canFinishPausedBoardSearch([]) === false, 'an array must be false');
      assert(canFinishPausedBoardSearch(pausedPlan()) === true && JSON.stringify(pausedPlan()) === snapshot,
        'the predicate must not mutate its input');
    },
  },
];
