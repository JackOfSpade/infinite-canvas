import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { documentSnapshot, improvementStatus, logGeneratedBundle, logSavedBundle, resetImprovementCounter } from '../../electron/ipc/applicationEditLog.js';
import { __removeCoverLetterForTests, __withoutCoverLetterForTests, inspectApplicationSyncRevision, mergeSelectedApplicationPanel, registerApplicationSyncWorkspace } from '../../electron/ipc/applicationSync.js';
import electronPkg from 'electron';
import { PDFDocument } from 'pdf-lib';

const html = (resume, letter) => `<!doctype html><html><body>
<section data-ic-document-panel="resume"><main class="page">${resume}</main></section>
<section data-ic-document-panel="cover"><main class="page">${letter}</main></section>
<button data-ic-document-tab="cover">Cover letter</button>
<script id="ic-application-bundle-data" type="application/json">{"sync":{"documents":{"resume":{},"cover":{}}}}</script>
</body></html>`;

export default [{
  name: 'application edits: three synthetic careers, overwrite, removal, retention and counter reset',
  run: async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-edits-'));
    try {
      for (const [index, career] of ['cartography', 'marine biology', 'industrial design'].entries()) {
        const workspaceDir = path.join(root, `bundle-${index}`);
        await logGeneratedBundle({ root, workspaceDir, html: html(`<p>${career} draft</p>`, `<p>${career} letter</p>`), posting: `Synthetic ${career} posting`, appVersion: 'test' });
        await logSavedBundle({ root, workspaceDir, html: html(`<p>${career} first edit</p>`, `<p>${career} letter edit</p>`) });
        await logSavedBundle({ root, workspaceDir, html: html(`<p>${career} final edit</p>`, `<p>${career} final letter</p>`) });
      }
      let state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      assert.equal(state.countSinceSession, 3);
      assert.equal(state.pairs.length, 3);
      assert.match(state.pairs[0].generated.resume, /draft/);
      assert.match(state.pairs[0].saved.resume, /final edit/);
      assert.doesNotMatch(state.pairs[0].saved.resume, /first edit/);
      assert.equal(state.summaries.length, 6);
      state.summaries.push({ id: 'expired', at: '2020-01-01T00:00:00.000Z', category: 'wording', location: 'resume:line-1', size: 1 });
      await fs.writeFile(path.join(root, 'application-improvement/state.json'), JSON.stringify(state));
      await logSavedBundle({ root, workspaceDir: path.join(root, 'bundle-2'), html: html('<p>industrial design last edit</p>', '<p>industrial design final letter</p>') });
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      assert(!state.summaries.some(row => row.id === 'expired'), 'six-month summary retention removes expired rows');
      const removed = __withoutCoverLetterForTests(html('<p>kept</p>', '<p>delete me</p>'));
      assert.match(removed, /letterRemoved/);
      assert.equal(documentSnapshot(removed).letter, null);
      assert.match(documentSnapshot(removed).resume, /kept/);
      await logSavedBundle({ root, workspaceDir: path.join(root, 'bundle-0'), html: removed, letterRemoved: true });
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      const removedPair = state.pairs.find(pair => pair.posting === 'Synthetic cartography posting');
      assert.equal(removedPair.letterRemoved, 'not needed');
      assert.equal(removedPair.generated.letter, null);
      assert.equal(removedPair.saved.letter, null);
      for (let i = 3; i < 105; i++) {
        await logGeneratedBundle({ root, workspaceDir: path.join(root, `bundle-${i}`), html: html('<p>resume</p>', '<p>letter</p>'), posting: 'Synthetic role', appVersion: 'test' });
      }
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      assert.equal(state.pairs.length, 100);
      assert.equal(state.countSinceSession, 105);
      assert.equal((await improvementStatus(root)).due, true);
      await resetImprovementCounter(root);
      assert.equal((await improvementStatus(root)).count, 0);
      await logGeneratedBundle({ root, workspaceDir: path.join(root, 'repeat'), html: html('<p>first</p>', '<p>letter</p>'), posting: 'Synthetic repeat', appVersion: 'test' });
      await logGeneratedBundle({ root, workspaceDir: path.join(root, 'repeat'), html: html('<p>second</p>', '<p>letter</p>'), posting: 'Synthetic repeat', appVersion: 'test' });
      assert.equal((await improvementStatus(root)).count, 2, 'regeneration in one folder counts as two bundles');
      const modelFile = path.join(root, 'model.json');
      await fs.writeFile(modelFile, '{"label":"synthetic-next-model"}');
      const priorModelFile = process.env.IC_APPLICATION_MODEL_FILE;
      try {
        process.env.IC_APPLICATION_MODEL_FILE = modelFile;
        assert.equal((await improvementStatus(root)).count, 0, 'model change resets the counter');
        state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
        assert.equal(state.pairs.length, 0);
        assert(state.summaries.length > 0, 'model transition keeps compact summaries');
        assert((await fs.readdir(path.join(root, 'application-improvement/archive'))).length > 0, 'previous full pairs are archived');
        assert.equal(await fs.readFile(path.join(root, 'application-improvement/frozen-regression.json'), 'utf8'), '[]\n');
      } finally {
        if (priorModelFile === undefined) delete process.env.IC_APPLICATION_MODEL_FILE;
        else process.env.IC_APPLICATION_MODEL_FILE = priorModelFile;
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
}, {
  name: 'application edits: removal transaction deletes PDF and panel, preserves résumé and updates private log',
  run: async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'application-remove-')));
    const appRoot = electronPkg.app.getPath('userData');
    const token = 'e'.repeat(64);
    const source = html('<p>resume kept</p>', '<p>letter removed</p>').replace('"sync":{"documents"', `"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}","documents"`);
    try {
      await fs.writeFile(path.join(root, 'Application.html'), source);
      await fs.writeFile(path.join(root, 'Cover Letter.pdf'), '%PDF-test');
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      const resumePdf = await pdf.save();
      await fs.writeFile(path.join(root, 'Resume.pdf'), resumePdf);
      await logGeneratedBundle({ root: appRoot, workspaceDir: root, html: source, posting: 'Synthetic posting', appVersion: 'test' });
      await registerApplicationSyncWorkspace(root, token);
      assert.deepEqual(await __removeCoverLetterForTests({ token }), { removed: true });
      await assert.rejects(fs.stat(path.join(root, 'Cover Letter.pdf')), { code: 'ENOENT' });
      const saved = await fs.readFile(path.join(root, 'Application.html'), 'utf8');
      assert.equal(documentSnapshot(saved).letter, null);
      assert.match(documentSnapshot(saved).resume, /resume kept/);
      assert.match(mergeSelectedApplicationPanel(saved, saved, 'resume'), /resume kept/, 'resume remains syncable');
      const manifest = await inspectApplicationSyncRevision({ applicationPath: path.join(root, 'Application.html'), pdfPath: path.join(root, 'Resume.pdf'), html: saved, pdf: resumePdf, token });
      assert(manifest.every(row => row.integrityVerified), 'resume-only bundle passes Sync readback');
      const state = JSON.parse(await fs.readFile(path.join(appRoot, 'application-improvement/state.json'), 'utf8'));
      const pair = state.pairs.find(item => item.posting === 'Synthetic posting');
      assert.equal(pair.letterRemoved, 'not needed');
      assert.equal(pair.generated.letter, null);
      assert.equal(pair.saved.letter, null);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
}];
