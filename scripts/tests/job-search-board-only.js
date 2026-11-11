import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';

const readSource = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

export default [
  {
    name: 'deferDirectSearchToBoard always defers and asks an unconnected card to connect a Job Board',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('const deferDirectSearchToBoard = useCallback');
      const end = search.indexOf('const completeJobRun = useCallback', start);
      assert(start >= 0 && end > start, 'deferDirectSearchToBoard must exist between its helpers');
      const defer = search.slice(start, end);
      assert(!defer.includes('return false'),
        'deferDirectSearchToBoard never hands a direct provider search back to the card');
      assert(defer.includes('`[JobSearch][${id}] ${trigger} saved without scanning — connect a Job Board to search`'),
        'an unconnected card logs that the work was saved without scanning');
      assert(defer.includes("title: 'Connect a Job Board',")
        && defer.includes("description: 'Searches run only from a Job Board. Connect this Job Search to a Job Board, then use Search selected & combine.',"),
        'an unconnected card gets the connect-a-Job-Board toast');
      assert(defer.includes('saved without scanning — connected Job Board owns search admission')
        && defer.includes("title: 'Run from Job Board',"),
        'a connected card keeps the existing Board-owned log line and toast');
      assert(defer.split('dedupeKey: `job-search-run-from-board:${id}`,').length === 3,
        'both branches reuse the existing per-hub dedupe key');
      assert(defer.includes('return true;'), 'every branch reports the search as deferred');
      return { deferAlways: true };
    },
  },
  {
    name: 'runPipeline refuses an unmanaged search before it contacts a provider',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('const runPipeline = useCallback');
      const end = search.indexOf('const startProcessing = useCallback', start);
      assert(start >= 0 && end > start, 'runPipeline must exist before startProcessing');
      const pipeline = search.slice(start, end);
      const refusalAt = pipeline.indexOf('Direct search refused — searches run only from a Job Board');
      assert(refusalAt >= 0, 'runPipeline logs a direct-search refusal');
      assert(refusalAt > pipeline.indexOf('if (isJobWorkflowDeletionPending(id)) {'),
        'the refusal sits just after the deletion fence');
      assert(refusalAt < pipeline.indexOf('window.electronAPI'),
        'the refusal precedes every IPC call that runPipeline can make');
      assert(pipeline.slice(refusalAt, pipeline.indexOf('window.electronAPI')).includes(
        "return searchRunOutcome('not-ready', { error: 'Searches run only from a Job Board.' });",
      ), 'the refusal returns a not-ready outcome instead of searching');
      return { refusalBeforeProvider: true };
    },
  },
  {
    name: 'handleRerun refuses an unmanaged re-run and keeps a failed compile compile-only',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('const handleRerun = useCallback');
      const end = search.indexOf('const cancelBoardRun = useCallback', start);
      assert(start >= 0 && end > start, 'handleRerun must exist before cancelBoardRun');
      const rerun = search.slice(start, end);
      const compileRetryAt = rerun.indexOf("if (!queueManagedByBoard && runOrigin === 'career-compilation-retry') {");
      const deferAt = rerun.indexOf("if (!queueManagedByBoard && deferDirectSearchToBoard('Direct re-run')) {");
      const firstSearchAt = rerun.indexOf('startProcessingWithProfile(');
      assert(compileRetryAt >= 0 && deferAt > compileRetryAt,
        'the compile-retry branch is resolved before the direct re-run deferral');
      assert(rerun.slice(compileRetryAt, deferAt).includes('compileRetainedCareerFiles();'),
        'a failed compile retry recompiles the retained files and nothing else');
      assert(rerun.slice(compileRetryAt, deferAt).includes("Searches run only from a Job Board."),
        'the compile-retry branch still refuses to search');
      assert(firstSearchAt > deferAt && rerun.slice(deferAt, firstSearchAt).includes(
        "Searches run only from a Job Board.",
      ), 'a direct re-run is refused before any search path is reached');
      return { directRerunDefers: true, compileOnlyRetry: true };
    },
  },
  {
    name: 'the Re-scan control is offered only on a connected card and a hint replaces it otherwise',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      assert(search.includes('!resumeOffer?.incomplete && (\n                    managedByJobBoard ? ('),
        'the Re-scan / Run Search button renders only when managedByJobBoard');
      assert(search.includes('>Connect a Job Board to search.</p>'),
        'an unconnected card shows the connect hint in place of the search button');
      assert(!search.includes('{hasRunnableCareerInput && !controlsLocked && !boardRecoveryOwnsActions && !resumeOffer?.incomplete && (\n                    <button'),
        'no ungated Re-scan button survives');
      assert(search.includes("{careerCompilationFailed ? 'Retry Career Compilation' : 'Compile Career Files'}"),
        'the compile controls stay available without a Job Board');
      const done = readSource('../../src/nodes/jobsearch/JobSearchDoneState.jsx');
      assert(done.includes('onRerun: onRerunAction = null,'),
        'the done state receives the re-scan handler as an unexposed action prop');
      assert(done.includes('const onRerun = managedByJobBoard ? onRerunAction : null;'),
        'the done-state Re-scan handler is withheld unless a Job Board is connected');
      return { rerunGated: true, doneRerunGated: true };
    },
  },
  {
    name: 'no standalone auto-start, USAJobs refresh, or stale re-scan copy survives on the card',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const retiredAt = search.indexOf('const standaloneAutoStartRetired = true;');
      assert(retiredAt >= 0, 'the legacy file auto-start is suppressed unconditionally');
      assert(search.indexOf('Legacy file auto-start suppressed — searches run only from a Job Board', retiredAt) > retiredAt,
        'the unconditional suppression still logs why the persisted path did not start');
      const usaStart = search.indexOf('const triggerUSAJobsBackgroundSearch = useCallback');
      const leaseAt = search.indexOf('moduleRunQueue.acquireModuleRun', usaStart);
      assert(usaStart >= 0 && leaseAt > usaStart, 'the USAJobs refresh and its run lane must both exist');
      assert(search.slice(usaStart, leaseAt).includes(
        'USAJobs background search dropped because searches run only from a Job Board.',
      ), 'an unconnected card drops the USAJobs background refresh before it can acquire a run lane');
      assert(search.includes("? 'Career data and the last scan date were kept — search from the connected Job Board to continue from that date.'")
        && search.includes(": 'Career data was kept — search from the connected Job Board when you are ready.'"),
        'Clear Scrape copy points the user at the connected Job Board');
      assert(!search.includes('Re-scan for New Jobs continues from that date'),
        'the standalone re-scan promise is gone');
      return { autoStartRetired: true, usaJobsDropped: true };
    },
  },
];
