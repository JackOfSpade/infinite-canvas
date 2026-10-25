import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EDIT_NOTES_MAX_CHARS, RECURRING_MIN_BUNDLES, RECURRING_WINDOW, bundleEditNotes, documentSnapshot, editSummaries, improvementStatus, logBundleEditNotes, logGeneratedBundle, logSavedBundle, normalizeEditNotes, recurringEditSections, resetImprovementCounter } from '../../electron/ipc/applicationEditLog.js';
import { __recordWorkspaceEditNotesForTests, __removeCoverLetterForTests, __withoutCoverLetterForTests, inspectApplicationSyncRevision, mergeSelectedApplicationPanel, registerApplicationSyncWorkspace } from '../../electron/ipc/applicationSync.js';
import electronPkg from 'electron';
import { PDFDocument } from 'pdf-lib';

const html = (resume, letter) => `<!doctype html><html><body>
<section data-ic-document-panel="resume"><main class="page">${resume}</main></section>
<section data-ic-document-panel="cover"><main class="page">${letter}</main></section>
<button data-ic-document-tab="cover">Cover letter</button>
<script id="ic-application-bundle-data" type="application/json">{"sync":{"documents":{"resume":{},"cover":{}}}}</script>
</body></html>`;

export default [{
  name: 'application edits: summaries name each changed block without its text',
  run: async () => {
    const page = body => `<main class="page">${body}</main>`;
    const generated = page(`<h2>Experience</h2><ul><li>alpha one</li><li>beta two</li><li>gamma three</li></ul>
<h2>Projects</h2><article class="project"><span>Kite</span></article><article class="project"><span>Lantern</span></article>
<h2>Skills</h2><dl class="skills"><dt>Skills</dt><dd>Rust · Go · Elm</dd></dl>`);
    const saved = page(`<h2>Experience</h2><ul><li>gamma three</li><li>alpha one revised here</li><li>delta four</li></ul>
<h2>Projects</h2><article class="project"><span>Kite</span></article>
<h2>Skills</h2><dl class="skills"><dt>Skills</dt><dd>Rust · Go</dd></dl>`);
    const rows = editSummaries({ resume: generated }, { resume: saved }, 'x', 'now');
    const find = (op, section) => rows.filter(row => row.op === op && row.section === section);
    assert.equal(find('removed', 'Projects').length, 1, 'dropped project');
    assert.equal(find('removed', 'Projects')[0].kind, 'article.project');
    const skills = find('rewritten', 'Skills');
    assert.equal(skills.length, 1);
    assert.deepEqual([skills[0].kind, skills[0].wordsRemoved, skills[0].wordsAdded], ['dd', 2, 0]);
    const experience = rows.filter(row => row.section === 'Experience');
    assert.deepEqual(experience.map(row => row.op).sort(), ['added', 'removed', 'rewritten'], 'beta dropped, delta added, alpha reworded');
    assert.equal(experience.find(row => row.op === 'rewritten').moved, true, 'the reworded bullet also changed order');
    assert(!JSON.stringify(rows).match(/Lantern|Elm|alpha/), 'no document text in summaries');
    const markup = editSummaries({ resume: page('<p>same</p>') }, { resume: page('<p class="x">same</p>') }, 'x', 'now');
    assert.deepEqual(markup.map(row => row.op), ['markup']);
  },
}, {
  name: 'application edits: the same section edited in four of the last eight accepted bundles is an early session signal, and nothing less is',
  run: async () => {
    assert.equal(RECURRING_WINDOW, 8); assert.equal(RECURRING_MIN_BUNDLES, 4);
    for (const career of ['glassblowing', 'harbour piloting', 'orchard surveying']) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-recurring-'));
      try {
        const resume = (section, text) => `<h2>${section}</h2><p>${text}</p><h2>Other</h2><p>${career} steady line</p>`;
        const generate = async (name, section, edited) => {
          const workspaceDir = path.join(root, name);
          await logGeneratedBundle({ root, workspaceDir, html: html(resume(section, `${career} draft ${name}`), `<p>${career} letter</p>`), posting: `Synthetic ${career} posting`, appVersion: 'test' });
          if (edited) await logSavedBundle({ root, workspaceDir, html: html(resume(section, `${career} draft ${name} trimmed`), `<p>${career} letter</p>`) });
        };
        // Three edits in one section across eight bundles: evidence to inspect, not a signal.
        for (let i = 0; i < 8; i++) await generate(`b${i}`, 'Skills', i < 3);
        let status = await improvementStatus(root);
        assert.equal(status.earlyDue, false, `${career}: three of eight is below the floor`);
        assert.deepEqual(status.recurring, []);
        assert.equal(status.due, true, 'eight bundles exceed the three-bundle review threshold');
        // A fourth edit in the same section inside the window flips it.
        await logSavedBundle({ root, workspaceDir: path.join(root, 'b7'), html: html(resume('Skills', `${career} draft b7 trimmed`), `<p>${career} letter</p>`) });
        status = await improvementStatus(root);
        assert.equal(status.earlyDue, true, `${career}: four of eight is the signal`);
        assert.deepEqual(status.recurring, [{ document: 'resume', section: 'Skills', bundles: 4, of: 8 }]);
        // Four edits spread over two sections are two habits of two, not one of four.
        const spread = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
        const rows = spread.summaries.filter(row => row.document === 'resume' && row.section === 'Skills');
        for (const row of rows.slice(0, 2)) row.section = 'Experience';
        assert.deepEqual(recurringEditSections(spread), [], `${career}: the floor is per section`);
        // A superseded pair never counts, and the window slides: eight newer unedited bundles push the edits out.
        for (let i = 8; i < 16; i++) await generate(`b${i}`, 'Skills', false);
        status = await improvementStatus(root);
        assert.equal(status.earlyDue, false, `${career}: the window is the last eight accepted bundles`);
        const state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
        // workspaceId is a digest, so mark by generation order: the eight newest pairs.
        const newest = [...state.pairs].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)).slice(-8);
        for (const pair of newest) pair.supersededAt = pair.generatedAt;
        assert.deepEqual(recurringEditSections(state), [{ document: 'resume', section: 'Skills', bundles: 4, of: 8 }], `${career}: superseded pairs drop out of the window`);
        // A session reviewed what came before it.
        await fs.writeFile(path.join(root, 'application-improvement/state.json'), JSON.stringify(state));
        await resetImprovementCounter(root);
        status = await improvementStatus(root);
        assert.equal(status.earlyDue, false, `${career}: edits before the last session were already reviewed`);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  },
}, {
  name: 'application edits: three synthetic careers, overwrite, removal, retention and counter reset',
  run: async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-edits-'));
    try {
      for (const [index, career] of ['cartography', 'marine biology', 'industrial design'].entries()) {
        const workspaceDir = path.join(root, `bundle-${index}`);
        await logGeneratedBundle({ root, workspaceDir, html: html(`<p>${career} draft</p>`, `<p>${career} letter</p>`), posting: `Synthetic ${career} posting`, appVersion: 'test' });
        const status = await improvementStatus(root);
        assert.equal(status.count, index + 1, 'review preserves the collection counter');
        assert.equal(status.due, index + 1 >= 3, 'review becomes due at three bundles');
        await logSavedBundle({ root, workspaceDir, html: html(`<p>${career} first edit</p>`, `<p>${career} letter edit</p>`) });
        await logSavedBundle({ root, workspaceDir, html: html(`<p>${career} final edit</p>`, `<p>${career} final letter</p>`) });
      }
      let state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      assert.equal(state.countSinceSession, 3);
      assert.equal(state.pairs.length, 3);
      assert.match(state.pairs[0].generated.resume, /draft/);
      assert.match(state.pairs[0].saved.resume, /final edit/);
      assert.doesNotMatch(state.pairs[0].saved.resume, /first edit/);
      for (const pair of state.pairs) {
        for (const document of ['resume', 'letter']) assert(state.summaries.some(row => row.id === pair.id && row.document === document), `${document} edit summarized`);
      }
      assert.equal(new Set(state.summaries.map(row => row.id)).size, 3, 'a later save replaces earlier summary rows');
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
      assert(state.summaries.some(row => row.id === removedPair.id && row.document === 'letter' && row.op === 'not needed'));
      for (let i = 3; i < 105; i++) {
        if (i === 3 || i === 4) {
          const status = await improvementStatus(root);
          assert.equal(status.count, i, 'a status review preserves the collection counter');
          assert.equal(status.due, i >= 3, 'review is due at three bundles and stays due while collecting more evidence');
        }
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
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      const repeats = state.pairs.filter(pair => pair.posting === 'Synthetic repeat');
      assert(repeats[0].supersededAt, 'the overwritten generation is marked superseded, not sent unchanged');
      assert.equal(repeats[1].supersededAt, undefined);
      assert(state.summaries.some(row => row.id === repeats[0].id && row.op === 'regenerated' && row.reason === 'same-build'), 'regeneration outlives full-pair retention and names its reason');
      assert.equal(repeats[0].supersededReason, 'same-build', 'a regeneration under the same build is a rejected generation');
      assert.equal(repeats[1].build, 'unbundled source');
      // A regeneration after a rebuild re-runs the posting under new code and says nothing about the earlier text.
      repeats[1].build = 'older-build';
      await fs.writeFile(path.join(root, 'application-improvement/state.json'), JSON.stringify(state));
      await logGeneratedBundle({ root, workspaceDir: path.join(root, 'repeat'), html: html('<p>third</p>', '<p>letter</p>'), posting: 'Synthetic repeat', appVersion: 'test' });
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      const rebuilt = state.pairs.find(pair => pair.id === repeats[1].id);
      assert.equal(rebuilt.supersededReason, 'rebuild');
      assert(state.summaries.some(row => row.id === repeats[1].id && row.op === 'regenerated' && row.reason === 'rebuild'), 'a rebuild re-run is tagged so a session never reads it as a rejection');
      const legacy = { ...rebuilt, id: 'legacy-pair', workspaceId: rebuilt.workspaceId, supersededAt: undefined, supersededReason: undefined };
      delete legacy.build; delete legacy.supersededAt; delete legacy.supersededReason;
      state.pairs.push(legacy);
      await fs.writeFile(path.join(root, 'application-improvement/state.json'), JSON.stringify(state));
      await logGeneratedBundle({ root, workspaceDir: path.join(root, 'repeat'), html: html('<p>fourth</p>', '<p>letter</p>'), posting: 'Synthetic repeat', appVersion: 'test' });
      state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
      assert.equal(state.pairs.find(pair => pair.id === 'legacy-pair').supersededReason, 'unknown-build', 'a pair logged before build stamps cannot claim either reason');
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
}, {
  name: 'application edits: normalizeEditNotes trims, caps, normalises newlines and strips control characters',
  run: () => {
    assert.equal(EDIT_NOTES_MAX_CHARS, 4000);
    assert.equal(normalizeEditNotes('  kept it short  \n'), 'kept it short');
    assert.equal(normalizeEditNotes('line one\r\nline two\rline three'), 'line one\nline two\nline three');
    assert.equal(normalizeEditNotes('a\u0000b\u0007c\u001Bd\u007Fe\tf'), 'abcde f', 'control characters vanish but a tab keeps the words apart');
    assert.equal(normalizeEditNotes('x'.repeat(EDIT_NOTES_MAX_CHARS + 50)).length, EDIT_NOTES_MAX_CHARS);
    for (const value of [undefined, null, 42, { text: 'x' }, ['x']]) assert.equal(normalizeEditNotes(value), '');
  },
}, {
  name: 'application edits: bundle edit notes ride on the latest pair only, never in summaries',
  run: async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-notes-'));
    const workspaceDir = path.join(root, 'Workspace');
    const stateOf = async () => JSON.parse(await fs.readFile(path.join(root, 'application-improvement/state.json'), 'utf8'));
    const notes = 'Dropped the Kite project because it repeats the platform bullet.';
    try {
      assert.equal(await logBundleEditNotes({ root, workspaceDir, editNotes: notes }), null, 'a workspace with no pair returns null');
      assert.deepEqual(await bundleEditNotes({ root, workspaceDir }), { editNotes: '', editNotesAt: null });

      await logGeneratedBundle({ root, workspaceDir, html: html('<p>alpha one</p>', '<p>letter one</p>'), posting: 'Notes posting', appVersion: 'test' });
      await logSavedBundle({ root, workspaceDir, html: html('<p>alpha one revised</p>', '<p>letter one</p>') });
      const before = await stateOf();
      const beforePair = before.pairs.at(-1);
      assert.equal(beforePair.editNotes, undefined, 'a fresh pair has no notes');

      assert.deepEqual(await logBundleEditNotes({ root, workspaceDir, editNotes: `  ${notes}\r\n` }), { editNotes: notes });
      const after = await stateOf();
      const afterPair = after.pairs.at(-1);
      assert.equal(afterPair.editNotes, notes);
      assert(!Number.isNaN(Date.parse(afterPair.editNotesAt)), 'editNotesAt is an ISO timestamp');
      assert.equal(afterPair.savedAt, beforePair.savedAt, 'notes do not touch savedAt');
      assert.deepEqual(afterPair.saved, beforePair.saved, 'notes do not touch the saved snapshot');
      assert.deepEqual(after.summaries, before.summaries, 'notes do not touch summary rows');
      assert.equal(after.countSinceSession, before.countSinceSession, 'notes do not touch the counter');
      assert(!JSON.stringify(after.summaries).includes('Kite'), 'notes never enter summaries');
      assert.deepEqual(await bundleEditNotes({ root, workspaceDir }), { editNotes: notes, editNotesAt: afterPair.editNotesAt });

      assert.deepEqual(await logBundleEditNotes({ root, workspaceDir, editNotes: '  \n ' }), { editNotes: '' });
      const cleared = (await stateOf()).pairs.at(-1);
      assert(!('editNotes' in cleared) && !('editNotesAt' in cleared), 'empty notes clear both fields');

      await logSavedBundle({ root, workspaceDir, html: html('<p>alpha two</p>', '<p>letter one</p>'), editNotes: 'Second reason.' });
      assert.equal((await stateOf()).pairs.at(-1).editNotes, 'Second reason.', 'Sync carries the current notes');
      await logSavedBundle({ root, workspaceDir, html: html('<p>alpha three</p>', '<p>letter one</p>') });
      const kept = await stateOf();
      assert.equal(kept.pairs.at(-1).editNotes, 'Second reason.', 'a save without notes keeps the existing notes');
      assert(!JSON.stringify(kept.summaries).includes('Second reason'), 'notes never enter summaries after Sync');

      await logGeneratedBundle({ root, workspaceDir, html: html('<p>regenerated</p>', '<p>letter two</p>'), posting: 'Notes posting', appVersion: 'test' });
      const regenerated = await stateOf();
      const workspacePairs = regenerated.pairs.filter(pair => pair.posting === 'Notes posting');
      assert.equal(workspacePairs.length, 2);
      assert.equal(workspacePairs[0].editNotes, 'Second reason.', 'the superseded pair keeps its notes');
      assert.equal(workspacePairs[1].editNotes, undefined, 'a regeneration starts without notes');
      assert.deepEqual(await bundleEditNotes({ root, workspaceDir }), { editNotes: '', editNotesAt: null });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
}, {
  name: 'application edits: sync server notes action is token-scoped and size-limited',
  run: async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'application-notes-sync-')));
    const appRoot = electronPkg.app.getPath('userData');
    const token = 'f'.repeat(64);
    const source = html('<p>resume notes</p>', '<p>letter notes</p>');
    try {
      await fs.writeFile(path.join(root, 'Application.html'), source);
      await logGeneratedBundle({ root: appRoot, workspaceDir: root, html: source, posting: 'Synthetic notes posting', appVersion: 'test' });
      await registerApplicationSyncWorkspace(root, token);
      assert.deepEqual(await __recordWorkspaceEditNotesForTests({ token, editNotes: ' Kept the letter brief.\r\n' }), { editNotes: 'Kept the letter brief.' });
      const state = JSON.parse(await fs.readFile(path.join(appRoot, 'application-improvement/state.json'), 'utf8'));
      const pair = state.pairs.findLast(item => item.posting === 'Synthetic notes posting');
      assert.equal(pair.editNotes, 'Kept the letter brief.');
      assert(!JSON.stringify(state.summaries).includes('Kept the letter brief'), 'notes never enter summaries');
      await assert.rejects(__recordWorkspaceEditNotesForTests({ token: '1'.repeat(64), editNotes: 'x' }), { statusCode: 403 });
      await assert.rejects(__recordWorkspaceEditNotesForTests({ token, editNotes: 'x'.repeat(64 * 1024 + 1) }), { statusCode: 400 });
      const unchanged = JSON.parse(await fs.readFile(path.join(appRoot, 'application-improvement/state.json'), 'utf8'));
      assert.equal(unchanged.pairs.findLast(item => item.posting === 'Synthetic notes posting').editNotes, 'Kept the letter brief.', 'a refused request leaves the notes alone');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
}];
