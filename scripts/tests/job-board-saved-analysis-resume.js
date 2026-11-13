import { assert } from './testHelpers.js';
import {
  approveCareerImportCompilation,
  beginCareerImportCompilation,
} from '../../src/utils/jobCareerCompilationReceipt.js';
import { classifyJobBoardSourceAdmission } from '../../src/utils/jobBoardSourceAdmission.js';
import {
  getSavedAnalysisAvailability,
  getSavedAnalysisAvailabilityVersion,
  publishSavedAnalysisAvailability,
  savedAnalysisResumeAdmission,
  subscribeSavedAnalysisAvailability,
} from '../../src/utils/jobSavedAnalysisAvailability.js';

const SNAPSHOT_ID = 'a'.repeat(64);
const OTHER_SNAPSHOT_ID = 'b'.repeat(64);
const GENERATION = 'career-import:hub-saved-analysis:one';
const HUB_ID = 'hub-saved-analysis';

// A real consumed-career-import hub: an approved snapshot for this generation
// whose Board import capability was already spent by a cancelled Board run, so
// the only fresh-import escape the classifier can offer is a destructive Clear.
function buildConsumedHub(overrides = {}) {
  const compiling = beginCareerImportCompilation({
    generation: GENERATION,
    attemptId: 'attempt-one',
  });
  const approved = approveCareerImportCompilation(compiling, {
    generation: GENERATION,
    attemptId: 'attempt-one',
    careerSnapshotId: SNAPSHOT_ID,
  });
  return {
    id: HUB_ID,
    type: 'jobhub',
    data: {
      hubState: 'empty',
      careerSnapshotId: SNAPSHOT_ID,
      careerImportGeneration: GENERATION,
      careerImportCompilation: approved,
      careerImportFreshCapability: null,
      careerImportConsumption: {
        capability: GENERATION,
        generation: GENERATION,
        origin: 'job-board',
        boardRunId: 'board-run-one',
        admissionVersion: 2,
      },
      resumeProfile: { targetTitles: ['Reliability Engineer'] },
      ...overrides,
    },
  };
}

const SAVED_ENTRY = { careerSnapshotId: SNAPSHOT_ID, jobCount: 4213 };

export default [
  {
    name: 'the saved-analysis fixture hub really classifies as fresh-import-requires-clear',
    run() {
      const hub = buildConsumedHub();
      const admission = classifyJobBoardSourceAdmission(hub);
      assert(admission.kind === 'fresh-import-requires-clear',
        `fixture must prove the deadlock admission, got ${admission.kind}`);
      assert(typeof admission.reason === 'string' && admission.reason.length > 0,
        'the deadlock admission carries the Clear-and-import reason');
      assert(hub.data.hubState === 'empty' && !hub.data.manualAiResume,
        'fixture is the empty, cancelled hub shape');
      return { kind: admission.kind };
    },
  },
  {
    name: 'savedAnalysisResumeAdmission admits an empty hub whose saved analysis matches',
    run() {
      const hub = buildConsumedHub();
      assert(classifyJobBoardSourceAdmission(hub).kind === 'fresh-import-requires-clear',
        'admission case needs the fresh-import-requires-clear hub');
      const result = savedAnalysisResumeAdmission(hub, SAVED_ENTRY);
      assert(result.ok === true, 'a matching saved analysis must be admitted');
      assert(result.jobCount === 4213, `admitted job count must be the saved count, got ${result.jobCount}`);
      assert(JSON.stringify(result) === JSON.stringify({ ok: true, jobCount: 4213 }),
        `admitted result must carry only ok and jobCount, got ${JSON.stringify(result)}`);
      return result;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects a saved analysis for different career data',
    run() {
      const hub = buildConsumedHub();
      const result = savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, careerSnapshotId: OTHER_SNAPSHOT_ID });
      assert(result.ok === false, 'a mismatched career snapshot id must not be admitted');
      assert(result.reason === 'Its saved job analysis belongs to different career data.',
        `mismatch reason must name the career-data mismatch, got ${JSON.stringify(result.reason)}`);
      const missingHubSnapshot = buildConsumedHub({ careerSnapshotId: null });
      assert(savedAnalysisResumeAdmission(missingHubSnapshot, SAVED_ENTRY).ok === false,
        'a hub without a career snapshot id cannot match the saved analysis');
      const missingEntrySnapshot = savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, careerSnapshotId: '' });
      assert(missingEntrySnapshot.ok === false, 'an entry without a career snapshot id is not admitted');
      return result;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects an empty saved analysis',
    run() {
      const hub = buildConsumedHub();
      const zero = savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, jobCount: 0 });
      assert(zero.ok === false, 'a zero-job saved analysis must not be admitted');
      assert(typeof zero.reason === 'string' && zero.reason.length > 0, 'zero jobs must explain itself');
      assert(savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, jobCount: -3 }).ok === false,
        'a negative job count must not be admitted');
      assert(savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, jobCount: Number.NaN }).ok === false,
        'a non-numeric job count must not be admitted');
      assert(savedAnalysisResumeAdmission(hub, { ...SAVED_ENTRY, jobCount: '42' }).ok === false,
        'a string job count must not be admitted');
      return zero;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects a hub that is not waiting in empty',
    run() {
      const hub = buildConsumedHub({ hubState: 'done' });
      const result = savedAnalysisResumeAdmission(hub, SAVED_ENTRY);
      assert(result.ok === false, 'a non-empty hub must not be resumed by the Board');
      assert(result.reason === 'This Job Search is not in an empty state that needs its saved jobs back.',
        `hub-state reason must be exact, got ${JSON.stringify(result.reason)}`);
      return result;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects a hub with a pending manual AI handoff',
    run() {
      const hub = buildConsumedHub({
        manualAiResume: { runId: 'manual-ai-run-one', task: 'career-profile-audit-confirmation' },
      });
      assert(classifyJobBoardSourceAdmission(hub).kind === 'fresh-import-requires-clear',
        'the manual-handoff fixture keeps the deadlock admission');
      const result = savedAnalysisResumeAdmission(hub, SAVED_ENTRY);
      assert(result.ok === false, 'a live manual AI handoff must not be resumed by the Board');
      assert(result.reason === 'This Job Search still has a saved AI handoff to resolve first.',
        `manual-handoff reason must be exact, got ${JSON.stringify(result.reason)}`);
      return result;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects a null saved analysis and a non-hub node',
    run() {
      const hub = buildConsumedHub();
      const result = savedAnalysisResumeAdmission(hub, null);
      assert(result.ok === false, 'no published saved analysis means nothing to resume');
      assert(result.reason === 'No saved job analysis is available for this Job Search.',
        `missing-entry reason must be exact, got ${JSON.stringify(result.reason)}`);
      assert(savedAnalysisResumeAdmission({ ...hub, type: 'jobsearch' }, SAVED_ENTRY).ok === false,
        'only jobhub nodes can be resumed by a Board');
      return result;
    },
  },
  {
    name: 'savedAnalysisResumeAdmission rejects a hub whose fresh import is still available',
    run() {
      const hub = buildConsumedHub({
        careerImportFreshCapability: GENERATION,
        careerImportConsumption: null,
      });
      assert(classifyJobBoardSourceAdmission(hub).kind === 'fresh-imported-input',
        'the unspent-import fixture must expose the fresh capability');
      const result = savedAnalysisResumeAdmission(hub, SAVED_ENTRY);
      assert(result.ok === false, 'an admissible fresh import is preferred over resuming saved work');
      return result;
    },
  },
  {
    name: 'the saved-analysis registry version only bumps on real changes',
    run() {
      const before = getSavedAnalysisAvailabilityVersion();
      const nodeId = 'registry-hub';
      assert(getSavedAnalysisAvailability(nodeId) === null, 'an unknown hub has no saved analysis');
      assert(publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 12 }) === true,
        'the first publish reports a change');
      assert(getSavedAnalysisAvailabilityVersion() === before + 1, 'the first publish bumps the version by one');
      const entry = getSavedAnalysisAvailability(nodeId);
      assert(entry?.careerSnapshotId === SNAPSHOT_ID && entry?.jobCount === 12,
        `the published entry must round-trip, got ${JSON.stringify(entry)}`);
      assert(publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 12 }) === false,
        'an identical republish reports no change');
      assert(getSavedAnalysisAvailabilityVersion() === before + 1,
        'an identical republish must not bump the version');
      assert(publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 13 }) === true,
        'a changed job count reports a change');
      assert(getSavedAnalysisAvailabilityVersion() === before + 2, 'a changed entry bumps the version');
      assert(publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 0 }) === true,
        'a zero-job report clears the resumable entry');
      assert(getSavedAnalysisAvailability(nodeId) === null, 'a zero-job report leaves no resumable entry');
      assert(getSavedAnalysisAvailabilityVersion() === before + 3, 'clearing bumps the version once');
      assert(publishSavedAnalysisAvailability(nodeId, null) === false, 'clearing an empty entry is a no-op');
      assert(getSavedAnalysisAvailabilityVersion() === before + 3, 'an empty clear must not bump the version');
      return { version: getSavedAnalysisAvailabilityVersion() };
    },
  },
  {
    name: 'unsubscribing stops saved-analysis notifications',
    run() {
      const nodeId = 'notify-hub';
      const notifications = [];
      const unsubscribe = subscribeSavedAnalysisAvailability(
        () => notifications.push(getSavedAnalysisAvailabilityVersion()),
      );
      publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 5 });
      assert(notifications.length === 1, `one change must notify once, got ${notifications.length}`);
      assert(publishSavedAnalysisAvailability(nodeId, { careerSnapshotId: SNAPSHOT_ID, jobCount: 5 }) === false,
        'the identical republish reports no change');
      assert(notifications.length === 1, 'an identical republish must send no notification');
      const versionAtUnsubscribe = getSavedAnalysisAvailabilityVersion();
      unsubscribe();
      publishSavedAnalysisAvailability(nodeId, null);
      assert(notifications.length === 1, `an unsubscribed listener must receive nothing, got ${notifications.length}`);
      assert(getSavedAnalysisAvailabilityVersion() === versionAtUnsubscribe + 1,
        'the clearing publish still bumps the shared version');
      return { notifications: notifications.length };
    },
  },
];
