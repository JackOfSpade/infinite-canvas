import { assert } from './testHelpers.js';
import { redactNodeForIssueReport } from '../../src/utils/issueReportRedaction.js';
import {
  cancelNodeTasksRecursively,
  collectDeletedManualAiWorkflowNodes,
  walkCanvasNodesBounded,
} from '../../src/utils/canvasInteractions.js';
import { hasActiveExternalRunState, mergeNonRestorableNodeDataFromLive } from '../../src/utils/undoNonRestorableState.js';

const PRIVATE = {
  url: 'PRIVATE_JOB_LISTING_URL',
  filename: 'PRIVATE_CAREER_FILENAME',
  bundle: 'PRIVATE_APPLICATION_BUNDLE',
  artifact: 'PRIVATE_ARTIFACT_ID',
  binding: 'PRIVATE_INPUT_BINDING',
  question: 'PRIVATE_TYPED_INTERVIEW_QUESTION',
  cue: 'PRIVATE_EVIDENCE_CUE',
  snippet: 'PRIVATE_SOURCE_SNIPPET',
  error: 'PRIVATE_WORKER_ERROR',
  run: 'PRIVATE_RUN_ID',
  extra: 'PRIVATE_UNRECOGNIZED_DATA',
};

function interviewNode(extra = {}) {
  return {
    id: 'interview-helper-node',
    type: 'interviewhelper',
    position: { x: 20, y: 30 },
    data: {
      locked: true,
      interviewHelperCareerMode: 'import',
      interviewHelperCareerFilenames: [PRIVATE.filename],
      interviewHelperJobUrl: `https://jobs.example.test/${PRIVATE.url}`,
      interviewHelperApplicationBundle: { artifactId: PRIVATE.artifact, digest: PRIVATE.bundle, label: PRIVATE.bundle, path: `/private/${PRIVATE.bundle}` },
      interviewHelperCareerCompilation: { status: 'failed', error: PRIVATE.error, generation: PRIVATE.extra },
      interviewHelperPreparation: {
        version: 1,
        briefId: 'a'.repeat(64),
        role: { title: PRIVATE.extra },
        facts: [{ fact: PRIVATE.snippet }],
        applicationPositioning: [PRIVATE.snippet],
        sourceUrl: `https://example.test/${PRIVATE.url}`,
      },
      interviewHelperPreparationInputBinding: PRIVATE.binding,
      interviewHelperPreparationRecordId: 'b'.repeat(64),
      interviewHelperPreparationInputDigest: PRIVATE.bundle,
      interviewHelperPreparationRunId: PRIVATE.run,
      interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: PRIVATE.run, status: 'failed' },
      interviewHelperManualAiRetirementReceipts: [{
        runId: PRIVATE.run,
        retirementPending: true,
        retirementReason: 'node-deleted',
        cancellationPending: false,
        cancellationReason: 'node-deleted',
        updatedAt: 42,
      }],
      interviewHelperLockedPlan: {
        status: 'supported',
        analysis: { transcript: PRIVATE.question, sourceSnippet: PRIVATE.snippet },
        steps: [{ cue: PRIVATE.cue, label: PRIVATE.extra, provenance: { source: PRIVATE.snippet } }],
      },
      interviewHelperCurrentStep: 0,
      unrelatedPrivateContent: PRIVATE.extra,
      ...extra,
    },
  };
}

export default [
  {
    name: 'interview helper: issue-report redaction projects only safe structural diagnostics recursively',
    run: () => {
      const nested = interviewNode();
      const parent = interviewNode({
        canvasData: { nodes: [nested] },
        interviewHelperCareerCompilation: { status: 'approved', output: PRIVATE.snippet },
        interviewHelperPreparation: { status: 'failed', error: PRIVATE.error },
      });
      const redacted = redactNodeForIssueReport(parent);
      const reportJson = JSON.stringify(redacted);

      for (const secret of Object.values(PRIVATE)) {
        assert(!reportJson.includes(secret), `issue reports must not include Interview Helper private value: ${secret}`);
      }

      assert(redacted.data.locked === true
        && redacted.data.interviewHelperCareerMode === 'import'
        && redacted.data.interviewHelperCareerFilesCount === 1
        && redacted.data.interviewHelperHasJobUrl === true
        && redacted.data.interviewHelperHasApplicationBundle === true,
      'safe setup booleans, bounded mode, and file count should remain useful diagnostics');
      assert(redacted.data.interviewHelperCareerCompilationStatus === 'approved'
        && redacted.data.interviewHelperPreparationStatus === 'failed'
        && redacted.data.interviewHelperManualAiCleanup?.kind === 'preparation'
        && redacted.data.interviewHelperManualAiCleanup?.status === 'failed'
        && redacted.data.interviewHelperManualAiRetirementReceiptsCount === 1,
      'valid worker lifecycle state should remain without run IDs or errors');

      const child = redacted.data.canvasData.nodes[0];
      assert(child.type === 'interviewhelper'
        && child.data.interviewHelperPreparationReady === true
        && child.data.interviewHelperPlanStatus === 'supported'
        && child.data.interviewHelperPlanStepsCount === 1
        && child.data.interviewHelperCurrentStep === 0,
      'nested Interview Helper cards must receive the same positive allow-list projection');
      assert(!Object.hasOwn(child.data, 'interviewHelperLockedPlan')
        && !Object.hasOwn(child.data, 'interviewHelperPreparation')
        && !Object.hasOwn(child.data, 'interviewHelperPreparationRecordId')
        && !Object.hasOwn(child.data, 'unrelatedPrivateContent'),
      'private brief, answer rail, and unrecognized data must be omitted rather than copied');

      const malformed = redactNodeForIssueReport(interviewNode({
        interviewHelperPreparation: { version: 1, briefId: 'not-a-valid-brief-id', facts: [PRIVATE.snippet] },
      }));
      assert(!Object.hasOwn(malformed.data, 'interviewHelperPreparationReady'),
        'an arbitrary preparation object must not be diagnosed as a completed brief');
    },
  },
  {
    name: 'interview helper: lifecycle walkers bound cyclic and over-deep nested canvas data',
    run: () => {
      const helper = {
        id: 'cycle-helper',
        type: 'interviewhelper',
        data: {
          interviewHelperPreparation: { status: 'preparing' },
          interviewHelperPreparationRunId: 'cycle-preparation-run',
        },
      };
      const group = { id: 'cycle-group', type: 'group', data: { canvasData: { nodes: [helper] } } };
      // Persisted JSON cannot be cyclic, but hostile/in-memory canvas state
      // can be. Every lifecycle boundary must return safely rather than recur.
      group.data.canvasData.nodes.push(group);
      const traversal = walkCanvasNodesBounded([group], () => {});
      assert(traversal.complete === false && traversal.visited === 2,
        'the shared lifecycle walker should visit each cyclic node once and report an incomplete tree');
      assert(collectDeletedManualAiWorkflowNodes([group]).length === 1,
        'workflow collection should keep the safely reachable Interview Helper owner without looping');

      const priorWindow = globalThis.window;
      const cancelled = [];
      try {
        globalThis.window = { electronAPI: { cancelNodeTask: id => cancelled.push(id) } };
        const result = cancelNodeTasksRecursively([group]);
        assert(result.complete === false && cancelled.join(',') === 'cycle-group,cycle-helper',
          'post-commit cancellation must be bounded while still notifying safely reachable owners');
      } finally {
        globalThis.window = priorWindow;
      }
      const attempted = [];
      try {
        globalThis.window = { electronAPI: { cancelNodeTask: id => {
          attempted.push(id);
          if (id === 'throws') throw new Error('bridge failure');
        } } };
        cancelNodeTasksRecursively([{ id: 'throws' }, { id: 'still-cancelled' }]);
        assert(attempted.join(',') === 'throws,still-cancelled',
          'a failed cancellation bridge call must not stop traversal of a sibling owner');
      } finally {
        globalThis.window = priorWindow;
      }
      assert(hasActiveExternalRunState([group]) === true,
        'navigation/Undo must fail closed for a cyclic nested canvas');
      assert(mergeNonRestorableNodeDataFromLive([group], [group])?.[0] === group,
        'Undo merge must retain live state instead of recursively restoring a malformed tree');

      const rootCycleGroup = { id: 'root-cycle', type: 'group', data: { canvasData: {} } };
      const rootCycle = [rootCycleGroup];
      rootCycleGroup.data.canvasData.nodes = rootCycle;
      assert(walkCanvasNodesBounded(rootCycle, () => {}).complete === false,
        'a child reference to the root array must not be mistaken for a benign legacy/current alias');

      const sharedChildren = [{ id: 'shared-helper', type: 'interviewhelper', data: {} }];
      const firstGroup = { id: 'first-shared-group', type: 'group', data: { canvasData: { nodes: sharedChildren } } };
      const secondGroup = { id: 'second-shared-group', type: 'group', data: { canvasData: { nodes: sharedChildren } } };
      assert(walkCanvasNodesBounded([firstGroup, secondGroup], () => {}).complete === false,
        'a child array shared by distinct parents must fail the tree-only lifecycle contract');

      const aliasedChildren = [{ id: 'aliased-helper', type: 'interviewhelper', data: {} }];
      const migratedAlias = { id: 'migrated-alias', type: 'group', data: { canvasData: { nodes: aliasedChildren }, nodes: aliasedChildren } };
      assert(walkCanvasNodesBounded([migratedAlias], () => {}).complete === true,
        'the same node may expose one migrated child array through current and legacy fields without false rejection');

      let deep = { id: 'deep-helper', type: 'interviewhelper', data: { interviewHelperPreparation: { status: 'preparing' }, interviewHelperPreparationRunId: 'deep-preparation-run' } };
      for (let index = 0; index < 70; index += 1) deep = { id: `deep-group-${index}`, type: 'group', data: { canvasData: { nodes: [deep] } } };
      assert(walkCanvasNodesBounded([deep], () => {}).complete === false
        && hasActiveExternalRunState([deep]) === true,
      'over-deep nested canvases must be bounded and treated as unsafe active lifecycle state');
      return { bounded: true };
    },
  },
];
