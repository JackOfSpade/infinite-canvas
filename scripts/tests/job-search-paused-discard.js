import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';

const readSource = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

const source = () => readSource('../../src/nodes/JobSearchNode.jsx');

const bannerSlice = search => {
  const start = search.indexOf('const manualAiRecoveryBanner = showManualAiRecoveryBanner ? (');
  const end = search.indexOf('const visibleCareerCompilationError', start);
  assert(start >= 0 && end > start, 'the manual-AI recovery banner must exist before the career error banner');
  return search.slice(start, end);
};

const discardHandlerSlice = search => {
  const start = search.indexOf('const handleDiscardManualAiRecovery = useCallback(async () => {');
  const end = search.indexOf('const restartCareerCompilationBusyRef = useRef(false);', start);
  assert(start >= 0 && end > start, 'handleDiscardManualAiRecovery must exist before the career restart handler');
  return search.slice(start, end);
};

export default [
  {
    name: 'the paused banner offers a two-step Discard for every non-career-compile variant',
    run() {
      const banner = bannerSlice(source());
      const discardAt = banner.indexOf("              label=\"Discard\"\n              confirmLabel=\"Click again to discard\"");
      assert(discardAt >= 0,
        'the banner renders a TwoStepConfirmButton labelled Discard with its confirm label');
      assert(banner.slice(discardAt).includes('onConfirm={handleDiscardManualAiRecovery}'),
        'the Discard button is wired to the discard handler');
      assert(banner.slice(discardAt).includes(
        'title="Discard this paused search. Career files, scan dates and saved jobs are kept."',
      ), 'the Discard button states that career files, scan dates and saved jobs are kept');
      assert(banner.slice(discardAt - 400, discardAt).includes('<TwoStepConfirmButton'),
        'Discard reuses the existing TwoStepConfirmButton component');
      // The old row was hidden entirely while a Board owned recovery actions;
      // Discard must now render in that variant too.
      assert(!banner.includes('{!manualAiRecoveryThroughBoard && <div className="flex gap-1.5 mt-1.5">'),
        'the action row is no longer hidden when the Job Board owns recovery');
      assert(banner.slice(discardAt).includes('border border-amber-500/40 text-amber-200'),
        'Discard is styled as the banner\'s small amber outline button');
      const careerBranchAt = banner.indexOf('{careerResumeExplanation ? (');
      assert(careerBranchAt >= 0 && careerBranchAt < discardAt,
        'Discard sits in the non-career branch, so career-compile variants keep their own actions');
      assert(banner.slice(careerBranchAt, discardAt).includes('onClick={handleContinueManualAiRecovery}')
        && banner.slice(careerBranchAt, discardAt).includes('>Continue saved compilation</button>')
        && banner.slice(careerBranchAt, discardAt).includes('>Restart career compilation</button>'),
        'career-compile Continue and Restart are unchanged and still call the card handlers');
      return { discardEverywhere: true };
    },
  },
  {
    name: 'Discard retires the handoff and clears only the marker that pointed at it',
    run() {
      const handler = discardHandlerSlice(source());
      assert(handler.includes("const marker = getNode(id)?.data?.manualAiResume;"),
        'the handler reads the live marker instead of a stale render value');
      assert(handler.includes('const runId = marker?.runId;')
        && handler.includes('if (!runId || manualAiDiscardBusyRef.current) return;'),
        'the handler returns without a run id and refuses a second concurrent discard');
      assert(handler.includes("retirementReason: 'user-discarded', requireCancellationAck: true });"),
        'Discard settles the durable run as user-discarded with a cancellation acknowledgement');
      assert(handler.slice(0, handler.indexOf("retirementReason: 'user-discarded'")).includes(
        'await settleManualAiRetirement({ runId, marker,',
      ), 'the handler awaits settleManualAiRetirement for the live run and marker');
      assert(handler.includes('if (current?.manualAiResume?.runId !== runId) return null;'),
        'the marker is cleared only while it still points at the discarded run');
      assert(handler.includes('? { manualAiResume: null, searchWindow: null, jobRunId: null }')
        && handler.includes(': { manualAiResume: null };'),
        'only the discarded pre-search window and run id are dropped with the marker');
      for (const kept of ['scoredJobs', 'careerSnapshotId', 'lastCompletedRunAt', 'sourceCoverage',
        'careerData', 'lastSearchCoverageStartedAt']) {
        assert(!handler.includes(kept),
          `Discard must not write ${kept} — career files, scan dates, coverage and saved jobs stay`);
      }
      return { retiresOnlyTheRun: true };
    },
  },
  {
    name: 'Discard logs, toasts and disables itself while it works',
    run() {
      const handler = discardHandlerSlice(source());
      assert(handler.includes('EventLogger.log(`[JobSearch][${id}] User discarded paused manual-AI handoff run=${runId}`);'),
        'Discard logs the discarded run id');
      assert(handler.includes("title: 'Paused search discarded',")
        && handler.includes("description: 'Career files and scan history were kept.',"),
        'Discard confirms that career files and scan history were kept');
      assert(handler.includes('EventLogger.error(`[JobSearch][${id}] Could not discard paused manual-AI handoff:`, error);'),
        'a failed discard is logged through EventLogger.error');
      assert(handler.includes("title: 'Could not discard',")
        && handler.includes('description: error?.message || String(error),')
        && handler.includes("type: 'error',"),
        'a failed discard toasts an error with the failure message');
      assert(handler.includes('setManualAiDiscardBusy(true);')
        && handler.includes('if (isMountedRef.current) setManualAiDiscardBusy(false);'),
        'the busy flag brackets the whole discard attempt');
      const banner = bannerSlice(source());
      assert(banner.includes('disabled={baseControlsLocked || manualAiDiscardBusy || !canvasFilePath}'),
        'the Discard button is disabled while the discard is busy');
      return { busyAndToasts: true };
    },
  },
  {
    name: 'the non-career Continue is Board-only and the wording no longer sends users to Clear career data',
    run() {
      const search = source();
      const banner = bannerSlice(search);
      assert(banner.includes('{managedByJobBoard && !manualAiRecoveryThroughBoard && <button'),
        'Continue renders only on a card connected to a Job Board');
      assert(banner.includes("onClick={() => deferDirectSearchToBoard('Saved handoff continue')}"),
        'a non-career Continue defers to the Job Board instead of resuming from the card');
      assert(!banner.includes('Clear career data is the only way to remove it'),
        'the banner no longer claims Clear career data is the only way out');
      assert(banner.includes('${manualAiRecoveryNextStep}'),
        'each non-career variant points at the Board/Discard next step');
      assert(search.includes("    ? 'Continue it with Search selected & combine on the connected Job Board, or Discard it.'")
        && search.includes("    : 'Connect a Job Board to continue it, or Discard it.'"),
        'a connected card names Continue on the Board and an unconnected card names connecting one');
      assert(!search.includes('Continue resumes its saved handoff'),
        'the old "Continue resumes its saved handoff" sentence is gone');
      return { boardOnlyContinue: true, wordingFixed: true };
    },
  },
];
