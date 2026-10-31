import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPLIED_JOBS_DIRECTORY, appliedJobsRootForCanvas, applicationFolderJobUrl,
  createApplicationFolderRegistry, enumerateApplicationFolders, listApplicationFolders,
} from '../../electron/ipc/interviewApplicationFolders.js';

async function workspace(fn) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-applied-jobs-'));
  try { return await fn(base); } finally { await fs.promises.rm(base, { recursive: true, force: true }); }
}
async function application(root, company, location, role, { mtime, url = null, listing = true } = {}) {
  const folder = path.join(root, company, location, role);
  await fs.promises.mkdir(folder, { recursive: true });
  if (listing) {
    const file = path.join(folder, 'Original Job Listing.md');
    await fs.promises.writeFile(file, `# ${role}\n\n**Company:** ${company}\n${url ? `**Listing URL:** <${url}>\n` : ''}\n---\n`);
    if (mtime) await fs.promises.utimes(file, mtime, mtime);
  }
  return folder;
}

export default [
  { name: 'interview application folders: lists Company/Location/Role folders newest first, skipping dot dirs, symlinks and folders without a listing', async run() {
    await workspace(async base => {
      const root = path.join(base, APPLIED_JOBS_DIRECTORY);
      await application(root, 'Discord', 'San Francisco, CA', 'Software Engineer', { mtime: new Date('2026-10-01') });
      await application(root, 'Stripe', 'Toronto', 'Full Stack Engineer', { mtime: new Date('2026-10-20') });
      await application(root, 'Stripe', 'Toronto', '.repair-backup-2026-09-23', { mtime: new Date('2026-10-25') });
      await application(root, 'Empty Co', 'Remote', 'No Listing Yet', { listing: false });
      const outside = await application(base, 'Outside', 'Nowhere', 'Linked Role', { mtime: new Date('2026-10-28') });
      await fs.promises.mkdir(path.join(root, 'Linky', 'Remote'), { recursive: true });
      await fs.promises.symlink(outside, path.join(root, 'Linky', 'Remote', 'Linked Role'));
      const folders = await enumerateApplicationFolders(root);
      assert.deepEqual(folders.map(item => `${item.company}/${item.role}`), ['Stripe/Full Stack Engineer', 'Discord/Software Engineer']);
    });
  } },
  { name: 'interview application folders: IPC listing returns tokens and labels only; tokens resolve per helper', async run() {
    await workspace(async base => {
      const canvas = path.join(base, 'jobs.canvas.json');
      await fs.promises.writeFile(canvas, '{}');
      const folder = await application(path.join(base, APPLIED_JOBS_DIRECTORY), 'Discord', 'San Francisco, CA', 'Software Engineer');
      const registry = createApplicationFolderRegistry();
      const reply = await listApplicationFolders({ nodeId: 'helper-a', canvasFilePath: canvas, registry });
      assert.equal(reply.root, APPLIED_JOBS_DIRECTORY);
      assert.equal(reply.folders.length, 1);
      const [item] = reply.folders;
      assert.deepEqual(Object.keys(item).sort(), ['company', 'label', 'location', 'modifiedAt', 'role', 'token']);
      assert.equal(item.label, 'Discord · Software Engineer');
      assert(!JSON.stringify(reply).includes(base), 'no filesystem path may reach the renderer');
      assert.equal(registry.resolve('helper-a', item.token), path.join(await fs.promises.realpath(base), APPLIED_JOBS_DIRECTORY, 'Discord', 'San Francisco, CA', 'Software Engineer'));
      assert.equal(registry.resolve('helper-b', item.token), null, 'a token issued to one helper must not resolve for another');
      assert.equal(registry.resolve('helper-a', 'not-a-real-token-value'), null);
      assert.ok(folder);
    });
  } },
  { name: 'interview application folders: unsaved canvas, missing root and private canvas locations fail closed', async run() {
    await workspace(async base => {
      assert.deepEqual(await appliedJobsRootForCanvas(null), { root: null, reason: 'canvas-unsaved' });
      assert.deepEqual(await appliedJobsRootForCanvas('relative/canvas.json'), { root: null, reason: 'canvas-unsaved' });
      assert.deepEqual(await appliedJobsRootForCanvas(path.join(base, 'missing.json')), { root: null, reason: 'canvas-unsaved' });
      const canvas = path.join(base, 'c.json'); await fs.promises.writeFile(canvas, '{}');
      assert.deepEqual(await appliedJobsRootForCanvas(canvas), { root: null, reason: 'missing-root' });
      await assert.rejects(appliedJobsRootForCanvas(canvas, { assertCanvasPathAllowed: () => { throw new Error('private'); } }), /private/);
      const reply = await listApplicationFolders({ nodeId: 'h', canvasFilePath: null, registry: createApplicationFolderRegistry() });
      assert.deepEqual(reply, { root: null, folders: [], reason: 'canvas-unsaved' });
    });
  } },
  { name: 'interview application folders: job URL comes from the listing header only', async run() {
    await workspace(async base => {
      const withUrl = await application(base, 'A', 'L', 'R1', { url: 'https://www.linkedin.com/jobs/view/123' });
      const without = await application(base, 'A', 'L', 'R2');
      assert.equal(await applicationFolderJobUrl(withUrl), 'https://www.linkedin.com/jobs/view/123');
      assert.equal(await applicationFolderJobUrl(without), null);
      assert.equal(await applicationFolderJobUrl(path.join(base, 'nope')), null);
    });
  } },
];
