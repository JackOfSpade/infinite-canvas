import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { claimJobAnalysisOperationAuthority, withCurrentJobAnalysisOperationAuthority } from '../electron/ipc/jobAnalysisOperationAuthorityStore.js';
import { startRun, completeRunWithReceipt } from '../electron/ipc/jobRunStaging.js';
import { moduleFingerprint } from '../src/nodes/jobboard/mergeJobs.js';

// Exercise the real built renderer in an isolated, invisible app. The Board
// is locked so this presentation fixture cannot start providers or AI work.
const directory = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-job-recovery-display-'));
const canvas = path.join(directory, 'recovery.json');
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  const pin = 'a'.repeat(64);
  const ca = { id: 'ca', type: 'jobhub', position: { x: 0, y: 0 }, data: {
    hubState: 'done', jobRunId: 'ca-run', careerSnapshotId: pin, resultDisposition: 'scored',
    resultCount: 57, totalScoredCount: 57,
    scoredJobs: Array.from({ length: 57 }, (_, i) => ({ id: `job-${i}`, title: 'Saved engineering job', matchScore: 80, careerSnapshotId: pin })),
    terminalFinalizationRecovery: { kind: 'terminal-finalization', runId: 'ca-run', careerSnapshotId: pin, resultDisposition: 'scored', terminalStatus: 'completed', terminalOutcome: 'populated', scoreReadyCount: 57 },
  } };
  const us = { id: 'us', type: 'jobhub', position: { x: 0, y: 450 }, data: {
    hubState: 'empty', jobRunId: 'us-run', careerSnapshotId: pin, resumeProfile: {}, careerData: 'Saved career evidence',
    manualAiResume: { runId: 'us-ai', jobRunId: 'us-run', task: 'job-preference-research', orchestratorNodeId: 'board', boardRunId: 'board-run' },
  } };
  const board = { id: 'board', type: 'jobboard', position: { x: 500, y: 0 }, data: {
    hubState: 'empty', locked: true, selectedSearchModuleIds: ['ca', 'us'],
    boardScanResume: { version: 1, phase: 'searches', boardRunId: 'board-run', startedAt: Date.now(),
      selectedSearchModuleIds: ['ca', 'us'], activeSourceId: 'us', activeSourceIds: ['ca', 'us'],
      activeSourceManualAiRunIds: { us: 'us-ai' }, awaitingSourceResolution: { sourceId: 'us', jobRunId: 'us-run' } },
  } };
  const reviewed = { id: 'reviewed-card', type: 'jobcard', position: { x: 900, y: 0 }, data: {
    hubId: 'board', title: 'Synthetic reviewed role', company: 'Example', matchScore: 71, rawScore: 71,
    fitAssessment: { auditStatus: 'audited', rawScore: 71, adjustedScore: 71,
      gapReview: { before: { adjustedScore: 69 }, after: { adjustedScore: 71 }, changes: [] } },
  } };
  const capped = { ...reviewed, id: 'capped-card', position: { x: 1200, y: 0 }, data: { ...reviewed.data, rawScore: 83 } };
  await fs.writeFile(canvas, JSON.stringify({ schemaVersion: 1, nodes: [ca, us, board, reviewed, capped],
    edges: [{ id: 'ca-board', source: 'ca', target: 'board' }, { id: 'us-board', source: 'us', target: 'board' }], drawings: [] }));
  application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(directory, 'profile')}`], env });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  const skip = page.getByText('Skip', { exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.evaluate(filePath => {
    const key = 'infiniteCanvas.settings';
    const settings = JSON.parse(localStorage.getItem(key) || '{}');
    localStorage.setItem(key, JSON.stringify({ ...settings, lastOpenedWorkspace: filePath }));
    window.addEventListener('beforeunload', event => { event.stopImmediatePropagation(); delete event.returnValue; }, { capture: true, once: true });
  }, canvas);
  await page.reload();
  const canada = page.locator('.react-flow__node[data-id="ca"]');
  const usa = page.locator('.react-flow__node[data-id="us"]');
  await canada.getByText('Scored jobs saved · cleanup pending', { exact: true }).waitFor();
  await usa.getByText('Resume from Job Board', { exact: true }).waitFor();
  assert.equal(await canada.getByText('LAST ATTEMPT FAILED', { exact: true }).count(), 0);
  assert.match(await usa.innerText(), /Continue saved AI handoff or Retry recovery/);
  assert.equal(await usa.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
  assert.equal(await usa.getByRole('button', { name: 'Open prompt', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  // Reproduce the report's second shape: a completed Board already consumed
  // this exact result, while its Search still carries an obsolete cleanup lock.
  // Create a real revoked terminal authority and receipt; the built main IPC
  // must authenticate and finish this exact idempotent cleanup on mount.
  const completedCanvas = path.join(directory, 'completed.json');
  const claimed = await claimJobAnalysisOperationAuthority({ canvasFilePath: completedCanvas, hubId: 'ca',
    operationId: 'completed-authority', semanticBase: { kind: 'search', careerSnapshotId: pin, runId: null } });
  assert.ok(claimed.admitted);
  await startRun(completedCanvas, { runId: 'ca-run', nodeId: 'ca', careerSnapshotId: pin, operationAuthority: claimed.receipt });
  const terminal = { runId: 'ca-run', nodeId: 'ca', completedAt: Date.now(),
    terminal: { status: 'completed', outcome: 'populated', scoreReadyCount: 57 },
    careerSnapshotId: pin, operationAuthority: claimed.receipt };
  const completion = await withCurrentJobAnalysisOperationAuthority({ canvasFilePath: completedCanvas,
    hubId: 'ca', ...claimed.receipt, terminalTombstone: true }, () => completeRunWithReceipt(completedCanvas, terminal, {
    expectedNodeId: 'ca', expectedCareerSnapshotId: pin, trashItem: filePath => fs.unlink(filePath),
  }));
  assert.ok(completion.admitted && completion.value.ok && completion.value.cleared);
  const completedSource = structuredClone(ca);
  completedSource.data.analysisOperation = { authority: claimed.receipt };
  completedSource.data.terminalFinalizationRecovery.fingerprint = moduleFingerprint(completedSource.data.scoredJobs);
  const completedBoard = { ...board, data: { locked: true, hubState: 'done', resultCount: 57 } };
  await fs.writeFile(completedCanvas, JSON.stringify({ schemaVersion: 1, nodes: [completedSource, completedBoard],
    edges: [{ id: 'ca-board', source: 'ca', target: 'board' }], drawings: [] }));
  await page.evaluate(filePath => {
    const key = 'infiniteCanvas.settings';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), lastOpenedWorkspace: filePath }));
    window.addEventListener('beforeunload', event => { event.stopImmediatePropagation(); delete event.returnValue; }, { capture: true, once: true });
  }, completedCanvas);
  await page.reload();
  await page.locator('.react-flow__node[data-id="ca"]').waitFor();
  let savedSource;
  const deadline = Date.now() + 10_000;
  do {
    const persisted = await page.evaluate(filePath => window.electronAPI.loadWorkspace({ filePath }), completedCanvas);
    savedSource = persisted.data?.nodes?.find(node => node.id === 'ca')?.data;
    if (savedSource && !savedSource.terminalFinalizationRecovery && !savedSource.queuedModuleRun) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(savedSource && !savedSource.terminalFinalizationRecovery && !savedSource.queuedModuleRun,
    `exact terminal cleanup must settle and autosave: ${JSON.stringify({ marker: !!savedSource?.terminalFinalizationRecovery, queued: !!savedSource?.queuedModuleRun, error: savedSource?.errorMessage })}`);
  assert.equal(savedSource.scoredJobs.length, 57);
  assert.equal(await page.getByText('Scored jobs saved · cleanup pending', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: built renderer displays saved scoring recovery and pending terminal cleanup, with Board-owned actions, verified automatic terminal reconciliation, and no runtime errors.');
} finally {
  try { await application?.close(); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
