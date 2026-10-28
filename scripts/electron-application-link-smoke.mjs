import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { closeDisposableElectron } from './close-disposable-electron.mjs';

// Exercise only a disposable canvas/profile. No real generation or user files.
const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ic-bundle-link-')));
const canvasFilePath = path.join(root, 'canvas.json');
const outputDir = path.join(root, 'Applied Jobs', 'Synthetic');
const jobId = '123e4567-e89b-42d3-a456-426614174777';
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'Resume.pdf'), 'synthetic placeholder');
  const receipt = { version: 2, jobId, canvasFilePath, status: 'imported', resultSha256: 'a'.repeat(64),
    importedAt: new Date().toISOString(), outputDir };
  const receiptsRoot = path.join(root, '.local-ai', 'handoff-receipts');
  await fs.mkdir(receiptsRoot, { recursive: true });
  await fs.writeFile(path.join(receiptsRoot, `${jobId}.json`), JSON.stringify({
    ...receipt, listingKeys: ['https://example.test/jobs/synthetic'],
  }));
  await fs.writeFile(path.join(outputDir, 'Generation Audit.json'), JSON.stringify({
    jobId, finalArtifacts: { resultSha256: receipt.resultSha256 },
  }));
  await fs.writeFile(canvasFilePath, JSON.stringify({ schemaVersion: 1, nodes: [{
    id: 'saved-card', type: 'jobcard', position: { x: 0, y: 0 },
    data: { title: 'Synthetic Engineer', company: 'Synthetic', matchScore: 80,
      localApplication: { id: jobId, status: 'saved', mode: 'paste', canvasFilePath, savedDir: outputDir, receipt } },
  }, {
    id: 'rebuilt-card', type: 'jobcard', position: { x: 400, y: 0 },
    data: { title: 'Synthetic Engineer', company: 'Synthetic', matchScore: 80,
      url: 'https://example.test/jobs/synthetic' },
  }, {
    id: 'lookup-retry-card', type: 'jobcard', position: { x: 800, y: 0 },
    data: { title: 'Synthetic Engineer', company: 'Synthetic', matchScore: 80,
      url: 'https://example.test/jobs/retry',
      officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Synthetic', trail: ['fetch-timeout'] },
      listingGenerationNotice: { action: 'refuse-retry', basis: 'official-lookup', message: 'Retry the official posting lookup.' } },
  }, {
    id: 'closed-posting-card', type: 'jobcard', position: { x: 800, y: 400 },
    data: { title: 'Synthetic Engineer', company: 'Synthetic', matchScore: 80,
      url: 'https://example.test/jobs/old-source',
      officialPosting: { level: 'L2', outcome: 'closed', employer: 'Synthetic',
        sourceUrl: 'https://careers.example.test/jobs/closed', trail: ['closed'] },
      listingGenerationNotice: { action: 'refuse-final', basis: 'official-closed', message: 'The official posting is closed.' } },
  }], edges: [], drawings: [] }));
  application = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await application.firstWindow();
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof window.electronAPI?.loadWorkspace === 'function');
  await page.locator('.react-flow').waitFor();
  const loaded = await page.evaluate(filePath => window.electronAPI.loadWorkspace({ filePath }), canvasFilePath);
  assert.equal(loaded.success, true, loaded.error || 'synthetic canvas must load');
  const url = new URL(page.url());
  url.searchParams.set('init', 'file');
  url.searchParams.set('file', canvasFilePath);
  await page.goto(url.href);
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  if (await skip.isVisible()) await skip.click();
  const card = page.locator('.react-flow__node-jobcard[data-id="saved-card"]');
  const rebuilt = page.locator('.react-flow__node-jobcard[data-id="rebuilt-card"]');
  const retry = page.locator('.react-flow__node-jobcard[data-id="lookup-retry-card"]');
  await retry.getByRole('button', { name: 'Check again', exact: true }).waitFor();
  assert.match(await retry.innerText(), /Employer site verification timed out/u);
  assert.match(await retry.innerText(), /Complete the official posting lookup before generating/u);
  assert.equal(await retry.getByRole('button', { name: 'Generate anyways', exact: true }).count(), 0,
    'an incomplete source lookup offers retry, without a bypass');
  const closed = page.locator('.react-flow__node-jobcard[data-id="closed-posting-card"]');
  await closed.getByRole('button', { name: 'Check again', exact: true }).waitFor();
  assert.match(await closed.innerText(), /Generation paused · Official posting closed/u);
  assert.equal(await closed.getByRole('button', { name: 'Generate anyways', exact: true }).count(), 0,
    'a closed official identity offers a fresh lookup without a board-only override');
  await rebuilt.getByRole('button', { name: 'Open saved folder', exact: true }).waitFor();
  assert.equal(await rebuilt.getByTestId('job-card-bundle-cross').count(), 1, 'the restored bundle displays its red X');
  assert.equal(await rebuilt.getByRole('button', { name: 'Generate', exact: true }).count(), 0,
    'a rebuilt mounted card adopts its restored saved pointer');
  await card.getByRole('button', { name: 'Open saved folder', exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Generate', exact: true }).count(), 0,
    'a linked saved folder must hide Generate entirely');
  await page.evaluate(filePath => window.electronAPI.watchApplicationBundles({ canvasFilePath: filePath }), canvasFilePath);
  await fs.unlink(path.join(outputDir, 'Resume.pdf'));
  assert.equal(await card.getByRole('button', { name: 'Generate', exact: true }).count(), 0,
    'editing or deleting a file inside a linked folder must not unlock generation');
  await fs.rm(outputDir, { recursive: true });
  await card.getByRole('button', { name: 'Retry generation', exact: true }).waitFor({ timeout: 20_000 });
  await rebuilt.getByRole('button', { name: 'Retry generation', exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await rebuilt.getByTestId('job-card-bundle-cross').count(), 0, 'a deleted bundle clears the restored X');
  assert.equal(await card.getByRole('button', { name: 'Open saved folder', exact: true }).count(), 0,
    'external folder removal must clear the saved indicator');
  const status = await page.evaluate(args => window.electronAPI.getLocalApplicationStatus(args), { jobId, canvasFilePath });
  assert.equal(status.localJob.savedOutputMissing, true);
  assert.equal(await fs.readFile(path.join(receiptsRoot, `${jobId}.json`), 'utf8'), JSON.stringify({ ...receipt, listingKeys: ['https://example.test/jobs/synthetic'] }),
    'a missing-output check must preserve the prior receipt');
  console.log('PASS: incomplete and closed official postings offer fresh lookup without bypass; saved bundles restore and external folder deletion unlocks retry without deleting the receipt.');
} catch (error) {
  const page = application?.windows()[0];
  if (page) {
    console.error((await page.locator('body').innerText()).slice(0, 5000));
    await page.screenshot({ path: '/tmp/ic-bundle-link-smoke-error.png' });
  }
  throw error;
} finally {
  try { await closeDisposableElectron(application); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
