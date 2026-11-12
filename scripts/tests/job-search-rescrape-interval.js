import { assert } from './testHelpers.js';
import { readFileSync } from 'node:fs';

const readSource = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

const GATE_START = '      // A platform whose last COMPLETED scrape is younger than the interval';
const GATE_END = '      // Recovery replays the exact window frozen before the interruption. A';

const readGate = () => {
  const search = readSource('../../src/nodes/JobSearchNode.jsx');
  const pipelineStart = search.indexOf('const runPipeline = useCallback');
  const pipelineEnd = search.indexOf('const startProcessing = useCallback', pipelineStart);
  assert(pipelineStart >= 0 && pipelineEnd > pipelineStart,
    'runPipeline must exist before startProcessing');
  const start = search.indexOf(GATE_START, pipelineStart);
  assert(start >= 0 && start < pipelineEnd,
    'the rescrape gate must live inside runPipeline');
  const end = search.indexOf(GATE_END, start);
  assert(end > start, 'the rescrape gate must end before the recovery window branch');
  return {
    search,
    pipelineStart,
    pipelineEnd,
    start,
    end,
    gate: search.slice(start, end),
  };
};

export default [
  {
    name: 'Job Search rescrape gate runs before windows resolve, only for a fresh run',
    run() {
      const { search, start, gate } = readGate();
      assert(gate.includes('if (!recoveredPreSearchContext) {'),
        'recovery runs must bypass the gate entirely');
      assert(gate.indexOf('if (!recoveredPreSearchContext) {')
        < gate.indexOf('partitionSourcesByRescrapeAge('),
      'the recovery fence wraps the partition itself');
      assert(gate.includes([
        'const rescrapePartition = partitionSourcesByRescrapeAge(',
        '          laneTurnData,',
        '          runActiveEnabledSourceIds,',
        '          new Date(),',
        '        );',
      ].join('\n')), 'the gate partitions the runnable platform ids as of now');
      assert(start > search.indexOf('runActiveEnabledSourceIds = getRunnableJobSourceIds('),
        'the gate runs after the runnable platform ids are computed');
      assert(start < search.indexOf('const resolvedSourceWindows = recoveredPreSearchContext'),
        'the gate runs before the per-platform windows are resolved');
      assert(start < search.indexOf('resolveJobSearchSourceWindows(', start),
        'no window is resolved from the platform list the gate will narrow');
      assert(!gate.includes('window.electronAPI') && !gate.includes('updateGlobal('),
        'the gate never contacts a provider and never mutates node data');
      return { gatedFreshOnly: true };
    },
  },
  {
    name: 'Job Search rescrape gate drops fresh platforms from both selected-platform lists',
    run() {
      const { gate } = readGate();
      const removeAt = gate.indexOf('runEnabledSourceIds = runEnabledSourceIds.filter(');
      const removeActiveAt = gate.indexOf('runActiveEnabledSourceIds = runActiveEnabledSourceIds.filter(');
      assert(removeAt >= 0, 'fresh platforms must be removed from the platforms sent to the main process');
      assert(removeActiveAt >= 0, 'fresh platforms must be removed from the runnable platform list');
      assert(removeAt > gate.indexOf('if (rescrapePartition.due.length === 0) {'),
        'the removal only happens when some platforms are still due');
      assert(removeAt < removeActiveAt,
        'both lists lose the same fresh platforms inside the due branch');
      assert(gate.slice(removeAt, removeActiveAt).split('!freshSourceIds.includes(sourceId)').length === 2,
        'the platforms sent to the main process are filtered by the fresh platform ids');
      assert(gate.slice(removeActiveAt, removeActiveAt + 200).includes('!freshSourceIds.includes(sourceId)'),
        'the runnable platform list is filtered by the same fresh platform ids');
      assert(gate.includes('const freshSourceIds = rescrapePartition.fresh.map(entry => entry.sourceId);'),
        'the fresh ids come straight from the partition');
      assert(gate.includes('Skipped recently scraped platforms: ${describeFresh()}'),
        'the skipped platforms are logged');
      assert(gate.includes('(next eligible ${new Date(entry.nextEligibleAt).toISOString()})'),
        'the log line names each skipped platform with its next eligible time');
      return { narrowedBothLists: true };
    },
  },
  {
    name: 'Job Search all-fresh gate returns the existing result, or stops without scraping when there is none',
    run() {
      const { search, start, gate } = readGate();
      const guardAt = gate.indexOf(
        'isMergeableTerminalJobSearchOutcome({ type: \'jobhub\', data: laneTurnData }, existingOutcome)',
      );
      assert(gate.includes('const existingOutcome = terminalJobSearchOutcome({ type: \'jobhub\', data: laneTurnData });'),
        'the gate reads the node\'s existing terminal outcome');
      assert(guardAt > 0,
        'the all-fresh early return is guarded by a mergeable terminal result');
      const returnAt = gate.indexOf('return searchRunOutcome(\'completed\', {');
      assert(returnAt > guardAt,
        'the completed outcome is only returned under that guard');
      const outcome = gate.slice(returnAt, returnAt + 300);
      assert(outcome.includes('runId: laneTurnData.jobRunId || null,')
        && outcome.includes('resultDisposition: laneTurnData.resultDisposition || null,')
        && outcome.includes("reason: 'platforms-recently-scraped',"),
      'the outcome carries the existing run id, disposition, and the skip reason');
      assert(gate.includes('Math.min(')
        && gate.includes('(earliest next eligible ${new Date(earliestNextEligibleAt).toISOString()})'),
      'the skip is logged with the earliest next eligible time');
      assert(!gate.includes('Rescrape gate bypassed'),
        'the 24-hour rule has no bypass for nodes without a mergeable result');
      const notReadyAt = gate.indexOf("return searchRunOutcome('not-ready', {");
      assert(notReadyAt > returnAt,
        'a node without a mergeable result stops as not-ready instead of scraping');
      const notReady = gate.slice(notReadyAt, notReadyAt + 400);
      assert(notReady.includes("reason: 'platforms-recently-scraped',")
        && notReady.includes('in the last 24 hours'),
      'the not-ready stop names the skip reason and the 24-hour rule');
      const dispatchAt = search.indexOf('window.electronAPI.searchJobs(');
      assert(dispatchAt > start,
        'the provider dispatch must live later in the file than the gate');
      assert(start + returnAt < dispatchAt,
        'the all-fresh early return precedes the provider dispatch');
      assert(start + notReadyAt < dispatchAt,
        'the not-ready stop precedes the provider dispatch');
      assert(start + guardAt < dispatchAt
        && start + gate.indexOf('const existingOutcome = terminalJobSearchOutcome(') < dispatchAt,
      'the existing outcome is read before any provider is contacted');
      return { allFreshReturnsOrBypasses: true };
    },
  },
  {
    name: 'Job Board skips a Search in its rescrape cooldown instead of stopping',
    run() {
      const board = readSource('../../src/nodes/JobBoardNode.jsx');
      const fanoutSkip = board.indexOf("if (!error && result?.status === 'not-ready' && result?.reason === 'platforms-recently-scraped') {");
      const fanoutIncomplete = board.indexOf("if (error || result?.status === 'failed' || result?.status === 'not-ready'");
      assert(fanoutSkip > 0 && fanoutSkip < fanoutIncomplete,
        'the fan-out loop skips a cooldown Search before classifying not-ready as incomplete');
      const serialSkip = board.indexOf("          if (result?.status === 'not-ready' && result?.reason === 'platforms-recently-scraped') {");
      const serialThrow = board.indexOf("if (result?.status !== 'completed') {\n            const error = new Error(result?.error || `${label} did not finish.`);");
      assert(serialSkip > 0 && serialThrow > serialSkip && serialThrow - serialSkip < 1200,
        'the serial loop skips a cooldown Search before throwing for a non-completed result');
      for (const at of [fanoutSkip, serialSkip]) {
        const body = board.slice(at, at + 700);
        assert(body.includes('continue;') && !body.slice(0, body.indexOf('continue;')).includes('incompleteSearches.push'),
          'a cooldown skip is never recorded as an incomplete Search');
      }
      return { boardSkipsCooldown: true };
    },
  },
];
