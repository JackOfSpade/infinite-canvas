import fs from 'node:fs';
import assert from 'node:assert';

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const board = () => readSource('../../src/nodes/JobBoardNode.jsx');
const panel = () => readSource('../../src/nodes/jobboard/JobBoardCareerOverridePanel.jsx');
const card = () => readSource('../../src/nodes/JobCardNode.jsx');

function compileRegion(src) {
  const start = src.indexOf('const compileCareerOverride = useCallback');
  assert(start >= 0, 'JobBoardNode must define compileCareerOverride with useCallback');
  const end = src.indexOf('const handleCareerOverride', start);
  assert(end > start, 'compileCareerOverride must be followed by the handleCareerOverride* handlers');
  return src.slice(start, end);
}

export default [
  {
    name: 'career override UI: JobBoardNode imports the panel and the model functions',
    run: () => {
      const src = board();
      assert(
        /import \{ JobBoardCareerOverridePanel \} from '\.\/jobboard\/JobBoardCareerOverridePanel';/.test(src),
        'JobBoardNode must import JobBoardCareerOverridePanel',
      );
      const importMatch = src.match(/import \{([^}]*)\} from '\.\.\/utils\/jobBoardCareerOverride';/);
      assert(importMatch, 'JobBoardNode must import from ../utils/jobBoardCareerOverride');
      const names = importMatch[1].split(',').map(name => name.trim()).filter(Boolean);
      for (const fn of [
        'approveJobBoardCareerOverride',
        'beginJobBoardCareerOverride',
        'resumeJobBoardCareerOverride',
        'failJobBoardCareerOverride',
        'discardJobBoardCareerOverridePending',
        'clearJobBoardCareerOverride',
        'markJobBoardCareerOverrideRunsRetired',
        'queueJobBoardCareerOverrideRetire',
        'jobBoardCareerOverrideView',
      ]) {
        assert(names.includes(fn), `JobBoardNode must import ${fn}`);
      }
    },
  },
  {
    name: 'career override UI: compile calls parseCareerData, approves the exact run and retires it',
    run: () => {
      const region = compileRegion(board());
      assert(
        region.includes("window.electronAPI.parseCareerData({ filePaths, nodeId: id, manualAiRunId, importModule: 'job-board' })"),
        'compile must call parseCareerData with filePaths, nodeId, manualAiRunId and the board import label',
      );
      assert(
        /approveJobBoardCareerOverride\([^)]*\{[\s\S]*?manualAiRunId,[\s\S]*?\}\)/.test(region),
        'approval must go through approveJobBoardCareerOverride with manualAiRunId',
      );
      assert(/completeNonApiAiRun\?\.\(manualAiRunId\)/.test(region), 'compile must retire its durable run');
      assert(/queueJobBoardCareerOverrideRetire\(node\?\.data, manualAiRunId\)/.test(region),
        'an unretired run must be queued for retirement');
      assert(/message !== 'Node deleted'/.test(region), 'a deleted node must not record a failure');
      assert(/isCareerTextFileName\(path\)/.test(region), 'fresh imports must be text-only');
      for (const forbidden of ['manualAiResume', 'boardScanResume', 'createManualAiRunId', 'boardCancellation', 'manualAiCleanupReceipts']) {
        assert(!region.includes(forbidden), `compile must never touch ${forbidden}`);
      }
    },
  },
  {
    name: 'career override UI: Clear discards an interrupted pending before clearing',
    run: () => {
      const src = board();
      const start = src.indexOf('const handleCareerOverrideClear = useCallback');
      assert(start >= 0, 'handleCareerOverrideClear must exist');
      const region = src.slice(start, src.indexOf('}, [', start));
      const discardAt = region.indexOf("view.state === 'interrupted'");
      const clearAt = region.indexOf('clearJobBoardCareerOverride(base)');
      assert(discardAt >= 0, 'Clear must special-case the interrupted state');
      assert(region.includes('discardJobBoardCareerOverridePending(data)'), 'interrupted pending must be discarded');
      assert(clearAt > discardAt, 'clear must run on the discarded base');
      assert(/if \(view\.state === 'compiling'\) return null;/.test(region), 'a live compile must never be cleared');
    },
  },
  {
    name: 'career override UI: panel is rendered before the done-state block',
    run: () => {
      const src = board();
      const panelAt = src.indexOf('<JobBoardCareerOverridePanel');
      const doneAt = src.indexOf("{hubState === 'done' && (");
      const selectionAt = src.indexOf('<JobBoardSearchSelection');
      assert(panelAt > 0, 'JobBoardNode must render JobBoardCareerOverridePanel');
      assert(doneAt > 0, 'done-state anchor must still exist');
      assert(selectionAt > 0 && selectionAt < panelAt, 'panel must follow the search selection');
      assert(panelAt < doneAt, 'panel must render before the hubState done block');
      assert(src.indexOf('<CareerCanvasFileImportDialog') > src.indexOf('</HubContainer>'),
        'canvas chooser must render outside the HubContainer');
    },
  },
  {
    name: 'career override UI: panel exports, two-step clear, text-only picker, no browser dialogs',
    run: () => {
      const src = panel();
      assert(/export function JobBoardCareerOverridePanel\(/.test(src), 'named export expected');
      assert(/import \{ TwoStepConfirmButton \} from '\.\.\/jobsearch\/TwoStepConfirmButton';/.test(src),
        'panel must import TwoStepConfirmButton');
      assert(/<TwoStepConfirmButton[\s\S]*?label="Clear"[\s\S]*?confirmLabel="Click again to clear"/.test(src),
        'Clear must be a two-step button');
      assert(src.includes('accept=".txt,.md,text/plain,text/markdown"'), 'picker must accept text career files only');
      assert(src.includes('Career data for applications'), 'panel header expected');
      assert(!/window\.confirm/.test(src), 'must not call window.confirm');
      assert(!/\balert\(/.test(src), 'must not call alert()');
      for (const label of ['>Resume<', '>Retry<', '>Discard<']) {
        assert(src.includes(label), `panel must offer ${label}`);
      }
    },
  },
  {
    name: 'career override UI: job card resolves the Board override before the guard',
    run: () => {
      const src = card();
      assert(
        /import \{ resolveApplicationCareerSnapshotId \} from '\.\.\/utils\/jobBoardCareerOverride';/.test(src),
        'JobCardNode must import resolveApplicationCareerSnapshotId',
      );
      const start = src.indexOf('const generateApplication = useCallback');
      assert(start >= 0, 'generateApplication must exist');
      const ownerAt = src.indexOf('const owningBoard = getLiveNode(data.hubId);', start);
      const resolveAt = src.indexOf('resolveApplicationCareerSnapshotId({ cardData: { careerSnapshotId: data.careerSnapshotId }', start);
      const guardAt = src.indexOf('if (!careerSnapshotId) {', start);
      assert(ownerAt > start, 'owning Board must be resolved via getLiveNode(data.hubId)');
      assert(resolveAt > ownerAt, 'resolver must use the owning Board');
      assert(guardAt > resolveAt, 'resolver must run before the snapshot guard');
      const declAt = src.indexOf('const careerSnapshotId = ', start);
      const declLine = src.slice(declAt, src.indexOf(';', declAt));
      assert(declAt > resolveAt && declAt < guardAt, 'careerSnapshotId must be declared between resolver and guard');
      assert(declLine.includes("(resolvedCareer.careerSnapshotId || '')"),
        'careerSnapshotId must come from the resolver, not the raw card pin');
      assert(!declLine.includes('data.careerSnapshotId.trim()'), 'the raw card pin must not bypass the resolver');
      const queueAt = src.indexOf('window.electronAPI.queueLocalApplication({', start);
      assert(queueAt > guardAt, 'queue call must follow the guard');
      const payload = src.slice(queueAt, src.indexOf('});', queueAt));
      assert(/\n\s+careerSnapshotId,\n/.test(payload), 'queue payload must still pass careerSnapshotId,');
    },
  },
];
