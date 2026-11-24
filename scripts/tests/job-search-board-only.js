import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';

const readSource = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

// 2026-11-20 made the Job Board the only way to start a search. 2026-11-23
// reversed that: a Job Search starts, pauses and continues its own runs and
// sends listings to a saved stream; a Job Board only reads that stream. These
// tests pin the new rule on the Search card.
export default [
  {
    name: 'a Job Search starts its own searches: nothing is handed to a Job Board',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('const deferDirectSearchToBoard = useCallback');
      const end = search.indexOf('const completeJobRun = useCallback', start);
      assert(start >= 0 && end > start, 'deferDirectSearchToBoard must exist between its helpers');
      const defer = search.slice(start, end);
      assert(defer.includes('useCallback(() => false, [])'), 'no launch is deferred to a Board any more');
      assert(!defer.includes('Run from Job Board') && !defer.includes('Connect a Job Board'), 'no "run it from the Board" toast survives');
      assert(search.includes('const managedByJobBoard = false;'), 'a connected Board never owns this card\'s actions');
      assert(search.includes('const connectedToJobBoard = useStore('), 'the connection is still known, for wording only');
      return { searchOwnsStart: true };
    },
  },
  {
    name: 'runPipeline no longer refuses a search started from the card',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const start = search.indexOf('const runPipeline = useCallback');
      const end = search.indexOf('const startProcessing = useCallback', start);
      assert(start >= 0 && end > start, 'runPipeline must exist before startProcessing');
      const pipeline = search.slice(start, end);
      assert(!pipeline.includes('Direct search refused') && !pipeline.includes('Searches run only from a Job Board.'),
        'the Board-only backstop is gone');
      assert(pipeline.indexOf('if (isJobWorkflowDeletionPending(id)) {') >= 0, 'the deletion fence stays');
      return { refusalRemoved: true };
    },
  },
  {
    name: 'the card offers Run Search and Search for new jobs; a failed compile retry still only compiles',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      assert(search.includes('>Run Search</button>'), 'a compiled card offers Run Search');
      assert(!search.includes('>Connect a Job Board to search.</p>'), 'the connect-a-Board hint is gone');
      assert(search.includes("onSearchAgain={controlsLocked ? null : () => handleRerun({ frameSourceCards: false })}"),
        'a finished card can search again');
      const done = readSource('../../src/nodes/jobsearch/JobSearchDoneState.jsx');
      assert(done.includes('Search for new jobs') && done.includes('onSearchAgain'), 'the finished state renders the button');
      assert(done.includes("jobsLabel(count, 'listing sent', 'listings sent')"), 'a finished run says how many listings it sent');
      assert(done.includes('The connected Job Board scores these listings and shows them as they arrive.'),
        'the card says where its listings go');
      const rerunStart = search.indexOf('const handleRerun = useCallback');
      const rerun = search.slice(rerunStart, search.indexOf('const cancelBoardRun = useCallback', rerunStart));
      const compileRetryAt = rerun.indexOf("if (!queueManagedByBoard && runOrigin === 'career-compilation-retry') {");
      assert(compileRetryAt >= 0 && rerun.slice(compileRetryAt, compileRetryAt + 400).includes('compileRetainedCareerFiles();'),
        'a failed compile retry recompiles the retained files and does not search');
      assert(search.includes("{careerCompilationFailed ? 'Retry Career Compilation' : 'Compile Career Files'}"),
        'the compile controls stay available');
      return { cardOwnsSearch: true };
    },
  },
  {
    name: 'a Job Search run ends once its listings are sent: no preference check and no scoring on the Search side',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      assert(search.includes('const SEARCH_SENDS_LISTINGS_ONLY = true;'), 'the Search sends listings only');
      const evaluateStart = search.indexOf('const evaluatePreferencesForRun = useCallback');
      const evaluate = search.slice(evaluateStart, search.indexOf('window.electronAPI.evaluateJobPreferences', evaluateStart));
      assert(evaluate.includes('if (SEARCH_SENDS_LISTINGS_ONLY) return unevaluatedPreferenceResult(fallbackJobs);'),
        'preferences are not judged on the Search side');
      const scoreStart = search.indexOf('const runScoringAndSpawn = useCallback');
      const score = search.slice(scoreStart, search.indexOf('const handlePostSearchResult = useCallback', scoreStart));
      assert(/const scoreResult = SEARCH_SENDS_LISTINGS_ONLY \? \{\s+success: true, scoredJobs: \[\], collectionOnly: true/u.test(score),
        'no scoring request is made');
      assert(score.includes("...(SEARCH_SENDS_LISTINGS_ONLY ? { listingsOnly: true, resultDisposition: 'collection-only' } : {}),"),
        'the run is committed as listings sent');
      const finish = search.slice(search.indexOf('const finishScoringAndSpawn = useCallback'), scoreStart);
      assert(finish.includes("listingsOnly || displayed.length > 0 ? 'completed' : 'failed',")
        && finish.includes("listingsOnly ? 'collection-only' : displayed.length > 0 ? 'populated' : 'incomplete',"),
        'a run with no rows of its own ends cleanly, not as incomplete');
      return { listingsOnly: true };
    },
  },
  {
    name: 'no legacy auto-start or stale re-scan copy survives on the card',
    run() {
      const search = readSource('../../src/nodes/JobSearchNode.jsx');
      const autoStartAt = search.indexOf('Legacy file auto-start suppressed');
      assert(autoStartAt >= 0, 'the suppressed legacy file auto-start still logs why the persisted path did not start');
      const autoStartEnd = search.indexOf('const continueSavedJobsRescore = useCallback', autoStartAt);
      const autoStartEffect = search.slice(search.lastIndexOf('useEffect(() => {', autoStartAt), autoStartEnd);
      assert(!autoStartEffect.includes('startProcessing(') && !autoStartEffect.includes('runPipeline('),
        'a search starts only when the person presses a button, never from a saved file path alone');
      assert(!search.includes('handleClearScrape') && !search.includes('canClearScrape'), 'Clear Scrape is gone from the card');
      return { autoStartRetired: true };
    },
  },
];
