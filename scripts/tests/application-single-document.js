// A job card's Résumé and Cover letter buttons each produce one document.
// These cover the single-document paths from the prompt to the saved folder,
// pressing the buttons one after the other, and what greys each button out.
// Every fixture is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPkg from 'electron';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import {
  ABSENT_DOCUMENT_FIT, SAVED_RESUME_TEXT_MAX_CHARS, evidenceResumeForLetter, normalizeApplicationDocumentScope,
  savedDocumentsFromHtml, savedResumeTextFromHtml, workspaceDocumentKinds,
} from '../../electron/ipc/applicationDocumentScope.js';
import { mergeApplicationDocument } from '../../electron/ipc/applicationBundleMerge.js';
import { archiveV2Content } from '../../electron/ipc/applicationV2EvidenceArchive.js';
import { __queueLegacyLocalApplicationFixtureForTests, buildLocalGenerationAuditArtifact, savedResumeTextForCoverStart, withApplicationDocumentStart } from '../../electron/ipc/localAiApplication.js';
import { buildResumeDocument, embedApplicationSyncConfig } from '../../electron/ipc/resumeHtml.js';
import { applicationSyncConfig, mergeSelectedApplicationPanel, workspacePanelsMatchBundle } from '../../electron/ipc/applicationSync.js';
import { documentSnapshot, editSummaries, logGeneratedBundle, improvementStatus } from '../../electron/ipc/applicationEditLog.js';
import { registerJobApplicationHandlers, registerPendingApplicationWorkspace } from '../../electron/ipc/jobApplication.js';
import { fitMeasurement, sameFitMeasurement, fitRejectionMessage, classifyRenderFaults } from '../../electron/ipc/applicationV2HostFaults.js';
import { splitWriteVerifyWriterResponse } from '../../electron/ipc/applicationV2WriterShortlist.js';
import { applicationUnitRegistry } from '../../electron/ipc/applicationUnitPatches.js';
import {
  WRITE_VERIFY_BRIEF, WRITE_VERIFY_COVER_BRIEF, WRITE_VERIFY_RESUME_BRIEF, initialWriteVerifyState,
  writeVerifyDocumentsForPrompt, writeVerifyPrompt, writeVerifySourcePrompt,
} from '../../electron/ipc/applicationWriteVerify.js';
import {
  activeApplicationDocuments, applicationDocumentButtonState, applicationDocumentMustWait, localApplicationAfterDiscard,
  queuedLocalApplicationSettlement, queuedLocalApplicationStartDecision, replacedLocalApplicationForCleanup,
  savedApplicationDocuments, savedApplicationPointer,
} from '../../src/utils/localAiApplicationLifecycle.js';
import { bundleComponent, withDom } from './fixtures/practice-connector/mountComponent.js';
import { withConsoleCollector } from './fixtures/practice-connector/renderHarness.js';

const { ipcMain } = electronPkg;
const LETTER = { name: 'Sample Person', contact: ['sample@example.test'], salutation: 'Dear Hiring Team,', closing: 'Sincerely,',
  paragraphs: ['First paragraph of the synthetic letter.', 'Second paragraph of the synthetic letter.'] };
const RESUME_MAIN = '<main class="page"><header class="resume-header"><h1 class="name">Sample Person</h1><p class="contact">sample@example.test</p></header><section class="section"><p>Generated résumé line.</p></section></main>';
const BUNDLE = { company: 'Sample Co', candidateName: 'Sample Person', jobUrl: 'https://example.test/job', jobMarkdown: '# Job\n' };
const resumeOnly = docId => buildResumeDocument({ documentScope: 'resume', resumeMainHtml: RESUME_MAIN, variantAttrs: '', docId, downloadBundle: BUNDLE });
const coverOnly = docId => buildResumeDocument({ documentScope: 'cover', coverLetter: LETTER, variantAttrs: '', docId, downloadBundle: BUNDLE });
const both = docId => buildResumeDocument({ resumeMainHtml: RESUME_MAIN, coverLetter: LETTER, variantAttrs: '', docId, downloadBundle: BUNDLE });
const synced = (html, { resumePdf = null, coverPdf = null } = {}) => embedApplicationSyncConfig(html, applicationSyncConfig('a'.repeat(64), { html, resumePdf, coverPdf }));
const panelText = (html, kind) => {
  const dom = new JSDOM(html);
  try { return dom.window.document.querySelector(`[data-ic-document-panel="${kind}"] main.page`)?.textContent || null; }
  finally { dom.window.close(); }
};
const scriptLiteral = (html, name) => JSON.parse(new RegExp(`var ${name} = ("(?:[^"\\\\]|\\\\.)*");`, 'u').exec(html)[1]);
// The page script as a browser runs it. A throw here is a page with no working
// tabs, editor or Sync button.
const runPage = html => {
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file:///Applied%20Jobs/Application.html', pretendToBeVisual: true, beforeParse(window) {
    window.addEventListener('error', event => errors.push(event.error?.message || event.message));
    window.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    window.CSS = { supports: () => true };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.document.fonts = { ready: Promise.resolve(), check: () => true, load: async () => [], status: 'loaded', forEach() {} };
    Object.defineProperty(window, 'print', { value() {} });
  } });
  return { dom, errors, document: dom.window.document };
};
const onePagePdf = async text => {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(text);
  return Buffer.from(await pdf.save());
};

const saved = (extra = {}) => ({ id: 'saved-job', status: 'saved', savedDir: '/synthetic/folder', ...extra });
const running = (documentScope, status = 'queued') => ({ id: `${documentScope}-job`, status, mode: 'paste', documentScope });

export default [
  {
    name: 'a saved application from before the split counts as holding both documents, so both buttons stay greyed out',
    run() {
      const data = { localApplication: saved() };
      assert.deepEqual(savedApplicationDocuments(data), { resume: true, cover: true });
      for (const kind of ['resume', 'cover']) assert.equal(applicationDocumentButtonState(kind, { data }).disabled, true);
      assert.equal(applicationDocumentButtonState('resume', { data: { localApplication: { ...saved(), receipt: { outputDir: '/x' }, savedDir: undefined } } }).exists, true);
    },
  },
  {
    name: 'a button greys out only for its own document, and that survives a restart because it is read from the canvas',
    run() {
      const fresh = {};
      assert.equal(applicationDocumentButtonState('resume', { data: fresh }).disabled, false);
      assert.equal(applicationDocumentButtonState('cover', { data: fresh }).disabled, false);
      const resumeSaved = JSON.parse(JSON.stringify({ localApplication: saved({ documentScope: 'resume', savedDocuments: { resume: true, cover: false } }) }));
      assert.equal(applicationDocumentButtonState('resume', { data: resumeSaved }).exists, true);
      assert.equal(applicationDocumentButtonState('resume', { data: resumeSaved }).disabled, true);
      assert.equal(applicationDocumentButtonState('cover', { data: resumeSaved }).disabled, false);
      const coverRunning = JSON.parse(JSON.stringify({ localApplication: running('cover'), priorSavedApplication: resumeSaved.localApplication }));
      assert.equal(applicationDocumentButtonState('cover', { data: coverRunning }).inProgress, true);
      assert.equal(applicationDocumentButtonState('resume', { data: coverRunning }).exists, true, 'the saved résumé stays blocked while its letter runs');
      assert.equal(applicationDocumentButtonState('cover', { data: {}, runningDocument: 'cover' }).disabled, true, 'a run still being set up has no job pointer yet');
      assert.equal(applicationDocumentButtonState('resume', { data: {}, runningDocument: 'cover' }).disabled, false, 'the other document can still be pressed');
      assert.equal(applicationDocumentButtonState('cover', { data: { queuedApplicationDocument: 'cover' } }).disabled, true);
    },
  },
  {
    name: 'a letter removed from the saved page frees the Cover letter button',
    run() {
      const data = { localApplication: saved({ savedDocuments: { resume: true, cover: false } }) };
      assert.equal(applicationDocumentButtonState('cover', { data }).disabled, false);
      assert.equal(applicationDocumentButtonState('resume', { data }).disabled, true);
    },
  },
  {
    name: 'a failed or discarded document becomes usable again without touching the other document',
    run() {
      const prior = saved({ documentScope: 'resume', savedDocuments: { resume: true, cover: false } });
      for (const status of ['failed', 'invalid', 'revision-exhausted', 'blocked']) {
        const data = { localApplication: running('cover', status), priorSavedApplication: prior };
        assert.equal(applicationDocumentButtonState('cover', { data }).disabled, false, status);
        assert.equal(applicationDocumentButtonState('resume', { data }).exists, true, status);
        assert.equal(applicationDocumentMustWait(data), false, `${status} ends the wait`);
      }
      const data = { localApplication: running('cover'), priorSavedApplication: prior };
      assert.deepEqual(localApplicationAfterDiscard(data, 'cover-job'), { localApplication: prior, priorSavedApplication: null });
      assert.equal(localApplicationAfterDiscard(data, 'some-other-job'), null, 'a discard of another job moves nothing');
      assert.deepEqual(localApplicationAfterDiscard({ localApplication: running('resume') }, 'resume-job'), { localApplication: null, priorSavedApplication: null });
    },
  },
  {
    name: 'one card runs one job at a time, and the start check blocks only what it must',
    run() {
      const card = data => ({ type: 'jobcard', data });
      assert.equal(applicationDocumentMustWait({ localApplication: running('resume') }), true);
      assert.equal(applicationDocumentMustWait({}, 'resume'), true);
      assert.equal(applicationDocumentMustWait({ localApplication: saved() }), false);
      assert.deepEqual(activeApplicationDocuments({ localApplication: running('resume') }), { resume: true, cover: false });
      assert.deepEqual(activeApplicationDocuments({ localApplication: { id: 'legacy', status: 'queued', mode: 'paste' } }), { resume: true, cover: true }, 'a job from before the split is producing both');

      const resumeSaved = card({ localApplication: saved({ documentScope: 'resume', savedDocuments: { resume: true, cover: false } }) });
      assert.deepEqual(queuedLocalApplicationStartDecision(resumeSaved, null, 'cover'), { allowed: true });
      assert.equal(queuedLocalApplicationStartDecision(resumeSaved, null, 'resume').reason, 'bundle-saved');
      assert.equal(queuedLocalApplicationStartDecision(card({ localApplication: running('resume') }), null, 'cover').reason, 'handoff-pending');
      assert.equal(queuedLocalApplicationStartDecision(card({ locked: true }), null, 'cover').reason, 'card-locked');
      assert.equal(queuedLocalApplicationStartDecision(card({ localApplication: saved() }), null, 'cover').reason, 'bundle-saved', 'a two-document bundle blocks both');
      assert.equal(queuedLocalApplicationStartDecision(card({ localApplication: saved() })).reason, 'bundle-saved', 'an unscoped caller keeps the earlier rule');
    },
  },
  {
    name: 'a second document stacks on the saved one, and neither a late first job nor a saved job can be overwritten by it',
    run() {
      const priorJob = saved({ documentScope: 'resume', savedDocuments: { resume: true, cover: false } });
      const card = { type: 'jobcard', data: { localApplication: priorJob } };
      const letterJob = running('cover');
      assert.equal(queuedLocalApplicationSettlement(card, letterJob, priorJob).action, 'persist');
      assert.equal(replacedLocalApplicationForCleanup(priorJob, letterJob, true), null, 'the saved job is never cleaned up when a letter stacks on it');
      assert.equal(queuedLocalApplicationSettlement(card, running('resume'), priorJob).action, 'discard', 'a document the folder already holds is refused');
      assert.equal(queuedLocalApplicationSettlement({ type: 'jobcard', data: { localApplication: saved() } }, letterJob, saved()).action, 'discard', 'a two-document folder takes nothing more');
      assert.equal(queuedLocalApplicationSettlement({ type: 'jobcard', data: { localApplication: running('resume') } }, letterJob, null).action, 'discard', 'a running job is never replaced');
      assert.deepEqual(savedApplicationPointer({ localApplication: letterJob, priorSavedApplication: priorJob }), priorJob);
    },
  },
  {
    name: 'a merged save names everything in the folder, and a pointer that has not read it back still counts the earlier document',
    run() {
      const prior = saved({ id: 'first', documentScope: 'resume', savedDocuments: { resume: true, cover: false } });
      assert.deepEqual(savedApplicationDocuments({ localApplication: saved({ id: 'second', documentScope: 'cover' }), priorSavedApplication: prior }), { resume: true, cover: true });
      assert.deepEqual(savedApplicationDocuments({ localApplication: saved({ id: 'second', documentScope: 'cover', savedDocuments: { resume: false, cover: true } }), priorSavedApplication: prior }), { resume: false, cover: true }, 'what the folder says wins');
      assert.deepEqual(savedApplicationDocuments({ localApplication: running('cover', 'failed'), priorSavedApplication: prior }), { resume: true, cover: false });
      assert.deepEqual(savedApplicationDocuments({ localApplication: { ...prior, status: 'failed', savedOutputMissing: true } }), { resume: false, cover: false }, 'a deleted folder frees both');
    },
  },
  {
    name: 'each scoped brief keeps the exact shared sentences and asks only for its own document',
    run() {
      assert.ok(WRITE_VERIFY_BRIEF.includes('Open on a thesis'));
      assert.equal(/cover letter|thesis|paragraph/iu.test(WRITE_VERIFY_RESUME_BRIEF), false);
      assert.equal(/résumé/iu.test(WRITE_VERIFY_COVER_BRIEF), false);
      for (const sentence of ['Open on a thesis', 'Start each body paragraph', 'Close in first person on what your past work taught you']) {
        const whole = WRITE_VERIFY_BRIEF.slice(WRITE_VERIFY_BRIEF.indexOf(sentence)).split('. ')[0];
        assert.ok(WRITE_VERIFY_COVER_BRIEF.includes(whole), sentence);
      }
      const quoteRule = WRITE_VERIFY_BRIEF.slice(WRITE_VERIFY_BRIEF.indexOf('Use a name, acronym'));
      assert.ok(WRITE_VERIFY_RESUME_BRIEF.endsWith(quoteRule) && WRITE_VERIFY_COVER_BRIEF.endsWith(quoteRule), 'the truth rule is not weakened for either document');
    },
  },
  {
    name: 'the saved résumé panel reads as plain text, without the letter, hidden blocks or an over-cap tail',
    run() {
      const html = `<!doctype html><html><body>
        <section data-ic-document-panel="resume"><main class="page">
          <h1>Sample   Person</h1>
          <p>sample@example.test</p>
          <section><h2>Experience</h2><p>Generated résumé line.</p>
          <ul><li>Bullet <em>one</em>.</li><li>Bullet two.</li></ul></section>
          <div hidden><p>Hidden by attribute.</p></div>
          <div aria-hidden="true"><p>Hidden by aria.</p></div>
        </main></section>
        <section data-ic-document-panel="cover"><main class="page"><p>First paragraph of the synthetic letter.</p></main></section>
      </body></html>`;
      assert.equal(SAVED_RESUME_TEXT_MAX_CHARS, 6000);
      const text = savedResumeTextFromHtml(html);
      assert.equal(text, 'Sample Person\nsample@example.test\nExperience\nGenerated résumé line.\nBullet one.\nBullet two.');
      for (const excluded of ['First paragraph of the synthetic letter', 'Hidden by attribute', 'Hidden by aria'])
        assert.equal(text.includes(excluded), false, `${excluded} is not saved résumé text`);
      assert.equal(savedResumeTextFromHtml('<section data-ic-document-panel="cover"><main class="page"><p>Only a letter.</p></main></section>'), '');
      assert.equal(savedResumeTextFromHtml(''), '');
      const line = index => `Approved résumé line ${String(index).padStart(4, '0')} ${'x'.repeat(74)}`;
      const long = `<section data-ic-document-panel="resume"><main class="page">${Array.from({ length: 80 }, (_, index) => `<p>${line(index)}</p>`).join('')}</main></section>`;
      const capped = savedResumeTextFromHtml(long);
      const cappedLines = capped.split('\n');
      assert.equal(capped.length <= SAVED_RESUME_TEXT_MAX_CHARS, true);
      assert.equal(cappedLines.every(row => row === row.trim() && row.length === 100), true, 'every kept line is a whole line');
      assert.equal(cappedLines.length, 59, 'the first line that would cross the ceiling is dropped whole');
      assert.equal(cappedLines.at(-1), line(58));
      assert.equal(capped.includes(line(59)), false);
    },
  },
  {
    name: 'a saved résumé reaches the cover source prompt as context and changes no other prompt by a byte',
    async run() {
      const profile = { roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [] };
      const source = (documentScope, extra = {}) => writeVerifySourcePrompt({ posting: 'P', requirements: [], listingEvidence: [], identity: { name: 'Sample Person' },
        sourceRoles: [], profile, catalog: [], documentScope, ...extra });
      const text = 'Sample Person\nGenerated résumé line.';
      const base = source('cover');
      const withResume = source('cover', { savedResumeText: text });
      const section = `SAVED RÉSUMÉ FOR THIS APPLICATION (context only, not a citable source; the letter is sent with this exact résumé):\n${text}\n\nKeep the letter consistent with this résumé. Do not restate its bullets; use the letter to explain how the work meets this job's needs and to go deeper on one or two examples. Every claim still cites the approved catalog.`;
      assert.equal(withResume.split('SAVED RÉSUMÉ FOR THIS APPLICATION').length - 1, 1, 'the section appears exactly once');
      assert.equal(withResume.includes(section), true);
      const education = 'TRUSTED EDUCATION AND CREDENTIAL FIELDS (institution and issuer exclude separately stated locations):';
      assert.equal(withResume, base.replace(`\n\n${education}`, `\n\n${section}\n\n${education}`), 'the section sits directly after the identity section and moves nothing else');
      assert.equal(source('cover', { savedResumeText: '' }), base);
      assert.equal(source('cover', { savedResumeText: '   \n\t ' }), base, 'blank text adds nothing');
      const resumeBase = source('resume');
      const bothBase = source(null);
      assert.equal(source('resume', { savedResumeText: text }), resumeBase, 'a résumé job never sees a saved résumé');
      assert.equal(source(null, { savedResumeText: text }), bothBase, 'a two-document job never sees a saved résumé');
      for (const prompt of [base, source('resume', { savedResumeText: text }), source(null, { savedResumeText: text })])
        assert.equal(prompt.includes('SAVED RÉSUMÉ FOR THIS APPLICATION'), false);
    },
  },
  {
    name: 'each prompt stage asks for one document, and a letter-only job never shows its evidence as a résumé',
    run() {
      const profile = { roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [] };
      const sourceFor = documentScope => writeVerifySourcePrompt({ posting: 'P', requirements: [], listingEvidence: [], identity: {}, sourceRoles: [], profile, catalog: [], documentScope });
      assert.ok(sourceFor('resume').includes(`BRIEF: ${WRITE_VERIFY_RESUME_BRIEF}`));
      assert.ok(sourceFor('cover').includes(`BRIEF: ${WRITE_VERIFY_COVER_BRIEF}`));
      assert.ok(sourceFor(null).includes(`BRIEF: ${WRITE_VERIFY_BRIEF}`));
      const state = initialWriteVerifyState(1);
      const evidence = { schemaVersion: 'structured-resume.v1', identity: { name: 'N', contact: [] }, roles: [{ id: 'r1', title: 'T', company: 'C', dates: 'D', bullets: [{ id: 'evidence-1', text: 'Approved quote text.', evidenceIds: ['x'] }] }] };
      const letter = { paragraphs: [{ id: 'p1', text: 'Letter text.', evidenceIds: ['x'] }], roleThesis: 'Thesis', coverLetterArgument: { primaryEvidence: { evidence: 'Approved quote text.', evidenceRole: 'T at C', relationToThesis: 'R' } } };
      state.candidates[0] = { ...state.candidates[0], plainText: 'WRITER', status: 'accepted', structured: { resume: evidence, coverLetter: letter } };
      state.ranking = ['candidate-1'];
      const common = { state, sourcePrompt: sourceFor('cover'), posting: 'P', hand: 'H', envelope: {} };
      const coverWrite = writeVerifyPrompt({ ...common, stage: 'write', documentScope: 'cover' });
      assert.match(coverWrite, /Start the letter with a standalone COVER LETTER heading/u);
      assert.match(coverWrite, /Do not write a résumé/u);
      assert.equal(/Start the application with a standalone RÉSUMÉ heading/u.test(coverWrite), false);
      const resumeWrite = writeVerifyPrompt({ ...common, sourcePrompt: sourceFor('resume'), stage: 'write', documentScope: 'resume' });
      assert.match(resumeWrite, /Do not write a cover letter/u);
      const coverConvert = writeVerifyPrompt({ ...common, stage: 'convert', documentScope: 'cover' });
      assert.match(coverConvert, /copy the full quote of one achievement from the FULL APPROVED CATALOG/u);
      assert.equal(coverConvert.length - common.sourcePrompt.length < 6000, true, 'the letter conversion adds no second copy of the catalog: it has to fit the prompt limit');
      assert.equal(coverConvert.includes('"resume":{"schemaVersion"'), false, 'the conversion schema carries no résumé');
      const resumeConvert = writeVerifyPrompt({ ...common, stage: 'convert', documentScope: 'resume' });
      assert.equal(resumeConvert.includes('"coverLetter":{'), false, 'the conversion schema carries no letter');
      const coverFact = writeVerifyPrompt({ ...common, stage: 'fact-check', documentScope: 'cover' });
      assert.equal(coverFact.includes('evidence-1'), false, 'the host evidence is not listed as a checkable unit or a document');
      assert.match(coverFact, /p1/u);
      const coverPick = writeVerifyPrompt({ ...common, stage: 'pick', documentScope: 'cover' });
      assert.match(coverPick, /produces only a cover letter/u);
      assert.match(coverPick, /One PNG per candidate/u);
      assert.equal(coverPick.includes('"schemaVersion":"structured-resume.v1"'), false);
      assert.deepEqual(writeVerifyDocumentsForPrompt({ resume: evidence, coverLetter: letter }, 'cover'), { coverLetter: letter });
      assert.deepEqual(writeVerifyDocumentsForPrompt({ resume: evidence, coverLetter: letter }, null), { resume: evidence, coverLetter: letter });
    },
  },
  {
    name: 'a résumé-only job skips the letter outline call, and a letter-only job keeps it',
    async run() {
      const runner = await fs.readFile(new URL('../../electron/ipc/claudeApplicationRunner.js', import.meta.url), 'utf8');
      assert.match(runner, /stage === 'write' && handoff\?\.documentScope !== 'resume' && /u);
      const host = await fs.readFile(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(host, /if \(input\.documentScope\) record\.documentScope = input\.documentScope;/u);
    },
  },
  {
    name: 'the writer parser takes one document with its appendices and refuses the other document',
    run() {
      const ids = Array.from({ length: 7 }, (_, index) => `host.career.achievement.a${index}.1`);
      const shortlist = ids.slice(0, 6).map(id => `- ${id} - a reason`).join('\n');
      const reply = (heading, body) => `${heading}\n${body}\n\nEVIDENCE SHORTLIST\n${shortlist}\n\nEDITORIAL SUMMARY\nWhy this was written.`;
      const resume = splitWriteVerifyWriterResponse(reply('RÉSUMÉ', 'Experience line'), ids, { documentScope: 'resume' });
      assert.equal(resume.plainText, 'RÉSUMÉ\nExperience line');
      assert.equal(resume.ids.length, 6);
      assert.equal(resume.decisions, 'Why this was written.');
      const letter = splitWriteVerifyWriterResponse(reply('**COVER LETTER**', 'Dear team'), ids, { documentScope: 'cover' });
      assert.equal(letter.plainText, 'COVER LETTER\nDear team');
      assert.throws(() => splitWriteVerifyWriterResponse(reply('COVER LETTER', 'x'), ids, { documentScope: 'resume' }), /standalone RÉSUMÉ heading/u);
      assert.throws(() => splitWriteVerifyWriterResponse(reply('RÉSUMÉ', 'x\nCOVER LETTER\ny'), ids, { documentScope: 'resume' }), /only the résumé/u);
      assert.throws(() => splitWriteVerifyWriterResponse(reply('RÉSUMÉ', `x ${ids[0]}`), ids, { documentScope: 'resume' }), /must not contain catalog evidence IDs/u);
      assert.throws(() => splitWriteVerifyWriterResponse('COVER LETTER\nBody', ids, { documentScope: 'cover' }), /EVIDENCE SHORTLIST/u);
      const twoDocument = `RÉSUMÉ\nA\nCOVER LETTER\nB\nEVIDENCE SHORTLIST\n${shortlist}\nEDITORIAL SUMMARY\nC`;
      assert.match(splitWriteVerifyWriterResponse(twoDocument, ids).plainText, /COVER LETTER/u, 'a job from before the split parses as it did');
    },
  },
  {
    name: 'a cover-only start against a saved résumé folder freezes its text, and a missing folder only omits it',
    async run() {
      // Canonical, as resolveCanvasProject gives the host: macOS tmpdir is a symlink.
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'single-document-saved-resume-')));
      try {
        const canvasFilePath = path.join(root, 'Sample Canvas.canvas');
        await fs.writeFile(canvasFilePath, '{}\n');
        const savedDir = path.join(root, 'Applied Jobs', 'Sample Co - Role');
        await fs.mkdir(savedDir, { recursive: true });
        await fs.writeFile(path.join(savedDir, 'Application.html'), `<!doctype html><html><body>
          <section data-ic-document-panel="resume"><main class="page"><h1>Sample Person</h1><p>Generated résumé line.</p></main></section>
          <section data-ic-document-panel="cover"><main class="page"><p>First paragraph of the synthetic letter.</p></main></section>
        </body></html>`);
        const receipt = { version: 2, jobId: '11111111-1111-4111-8111-111111111111', canvasFilePath, status: 'imported', outputDir: savedDir };
        const canvas = { canvasRoot: root, canonicalCanvasFilePath: canvasFilePath };
        const text = await savedResumeTextForCoverStart(canvas, receipt);
        assert.equal(text, 'Sample Person\nGenerated résumé line.');
        assert.equal(text.includes('First paragraph of the synthetic letter'), false, 'the saved letter is never read as the résumé');
        await fs.rm(savedDir, { recursive: true, force: true });
        assert.equal(await savedResumeTextForCoverStart(canvas, receipt), '', 'a folder that is gone leaves the text out without throwing');
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'a letter-only job checks against exact approved quotes it never delivers',
    run() {
      const catalog = [
        { id: 'host.career.achievement.a1.1', quote: 'Raw quote one.', cleanQuote: 'Clean quote one.' },
        { id: 'host.career.achievement.a2.1', quote: 'Quote  two.' },
        { id: 'host.career.skill.s1.1', quote: 'A skill row.' },
      ];
      const profile = { achievements: [{ id: 'a1', roleId: 'r1' }, { id: 'a2', roleId: 'r2' }, { id: 'a3', roleId: 'r3' }] };
      const evidence = evidenceResumeForLetter({ identity: { name: 'N', contact: ['c@example.test'], subtitleRole: 'Role' }, profile, catalog,
        sourceRoles: [{ id: 'r1', title: 'T1', company: 'C1', dates: 'D1' }, { id: 'r2', title: 'T2', company: '', dates: 'D2', location: 'L' }, { id: 'r3', title: 'Empty', company: 'C3', dates: 'D3' }] });
      assert.deepEqual(evidence.roles.map(role => role.id), ['r1', 'r2'], 'a role with no approved achievement has nothing to argue from');
      assert.equal(evidence.roles[0].bullets[0].text, 'Clean quote one.');
      assert.deepEqual(evidence.roles[0].bullets[0].evidenceIds, ['host.career.achievement.a1.1']);
      assert.equal(evidence.identity.subtitleRole, 'Role');
      assert.equal(evidence.roles[1].bullets[0].text, 'Quote two.', 'whitespace is collapsed the way the letter checks read it');
      assert.equal(applicationUnitRegistry({ resume: { roles: [] } }).errors.length, 0, 'a résumé-only job has no letter to require fields of');
      assert.ok(applicationUnitRegistry({ resume: { roles: [] }, coverLetter: {} }).errors.length > 0, 'a letter still has to carry them');
    },
  },
  {
    name: 'the document a job skips passes every render check without being measured',
    run() {
      const realFit = { pageCount: 1, fontsLoaded: true, bytes: Buffer.from('x'), layout: { contentHeightPx: 100, typeAreaHeightPx: 200 }, layoutIssues: [] };
      assert.deepEqual(classifyRenderFaults({ resumeFit: realFit, letterFit: ABSENT_DOCUMENT_FIT }), { transient: [], punctuation: [] });
      assert.equal(fitRejectionMessage({ resumeFit: realFit, letterFit: ABSENT_DOCUMENT_FIT }), null);
      const measured = fitMeasurement({ resumeFit: realFit, letterFit: ABSENT_DOCUMENT_FIT });
      assert.equal(measured.coverLetter.absent, true);
      assert.equal(sameFitMeasurement(measured, measured), true, 'a stuck trim is still recognised when one document is absent');
      assert.equal(normalizeApplicationDocumentScope(undefined), null);
      assert.equal(normalizeApplicationDocumentScope('cover'), 'cover');
      assert.throws(() => normalizeApplicationDocumentScope('both'), /Invalid application document/u);
    },
  },
  {
    name: 'a single-document workspace holds only that panel and its page script runs',
    async run() {
      const resume = synced(resumeOnly('doc-r'));
      assert.deepEqual(workspaceDocumentKinds(resume), ['resume']);
      assert.deepEqual(savedDocumentsFromHtml(resume), { resume: true, cover: false });
      assert.equal(panelText(resume, 'cover'), null);
      assert.ok(panelText(resume, 'resume').includes('Generated résumé line.'));
      assert.equal(/Cover letter was unavailable/u.test(resume), false);

      const cover = synced(coverOnly('doc-c'));
      assert.deepEqual(workspaceDocumentKinds(cover), ['cover']);
      assert.equal(panelText(cover, 'resume'), null);
      assert.ok(panelText(cover, 'cover').includes('First paragraph'));

      const legacy = synced(both('doc-b'));
      assert.deepEqual(workspaceDocumentKinds(legacy), ['resume', 'cover']);
      assert.equal(applicationBundleScope(legacy), undefined, 'a two-document file carries no scope');

      for (const [html, active] of [[resume, 'resume'], [cover, 'cover'], [legacy, 'resume']]) {
        const page = runPage(html);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(page.errors, [], `${active} workspace script`);
        const panel = page.document.querySelector(`[data-ic-document-panel="${active}"]`);
        assert.equal(panel.hidden, false, `${active} panel is showing`);
        page.dom.window.close();
      }
      for (const [html, resumePanels, coverPanels] of [[resume, 1, 0], [cover, 0, 1], [legacy, 1, 1]]) {
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        const bundle = JSON.parse(doc.getElementById('ic-application-bundle-data').textContent);
        const r = doc.querySelectorAll('[data-ic-document-panel="resume"]'); const c = doc.querySelectorAll('[data-ic-document-panel="cover"]');
        assert.equal(r.length, resumePanels); assert.equal(c.length, coverPanels);
        assert.equal(workspacePanelsMatchBundle(bundle, r, c), true);
        assert.equal(workspacePanelsMatchBundle(bundle, [], []), false, 'panels that disagree with the bundle data are refused');
        dom.window.close();
      }
    },
  },
  {
    name: 'a letter joining a résumé keeps every hand edit, and a résumé joining a letter keeps the letter and its browser drafts',
    async run() {
      // Letter after résumé, with the résumé already edited by hand.
      const edited = synced(resumeOnly('doc-resume')).replace('Generated résumé line.', 'Résumé line I fixed by hand; with a semicolon.');
      const letterStaged = coverOnly('doc-letter');
      const joined = mergeApplicationDocument({ existingHtml: edited, stagedHtml: letterStaged, documentScope: 'cover' });
      assert.deepEqual(workspaceDocumentKinds(joined.html), ['resume', 'cover']);
      assert.equal(joined.keptKind, 'resume');
      assert.ok(panelText(joined.html, 'resume').includes('Résumé line I fixed by hand; with a semicolon.'), 'a hand edit outside the writing rules survives');
      assert.ok(panelText(joined.html, 'cover').includes('First paragraph'));
      assert.equal(scriptLiteral(joined.html, 'DOC_ID'), 'doc-resume');
      assert.equal(scriptLiteral(joined.html, 'COVER_MARKUP_FINGERPRINT'), scriptLiteral(letterStaged, 'COVER_MARKUP_FINGERPRINT'));
      assert.notEqual(scriptLiteral(joined.html, 'COVER_MARKUP_FINGERPRINT'), '');
      assert.ok(joined.keptSyncDocument, 'the kept document carries its own last synced revision');
      assert.ok(new JSDOM(joined.html).window.document.querySelector('[data-ic-document-tab="cover"]'));
      const joinedPage = runPage(joined.html);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(joinedPage.errors, []);
      assert.equal(joinedPage.document.querySelector('[data-ic-document-panel="cover"]').hidden, true, 'the résumé shows first');
      joinedPage.document.querySelector('[data-ic-document-tab="cover"]').click();
      assert.equal(joinedPage.document.querySelector('[data-ic-document-panel="cover"]').hidden, false, 'the new tab works');
      joinedPage.dom.window.close();

      // Résumé after letter, with the letter edited by hand.
      const editedLetter = synced(coverOnly('doc-letter')).replace('First paragraph of the synthetic letter.', 'My own opening; typed here.');
      const resumeStaged = resumeOnly('doc-resume-late');
      const joinedLate = mergeApplicationDocument({ existingHtml: editedLetter, stagedHtml: resumeStaged, documentScope: 'resume' });
      assert.deepEqual(workspaceDocumentKinds(joinedLate.html), ['resume', 'cover']);
      assert.equal(joinedLate.keptKind, 'cover');
      assert.ok(panelText(joinedLate.html, 'cover').includes('My own opening; typed here.'));
      assert.ok(panelText(joinedLate.html, 'resume').includes('Generated résumé line.'));
      assert.equal(scriptLiteral(joinedLate.html, 'DOC_ID'), 'doc-letter', 'browser-saved letter edits stay under their key');
      assert.equal(scriptLiteral(joinedLate.html, 'COVER_MARKUP_FINGERPRINT'), scriptLiteral(editedLetter, 'COVER_MARKUP_FINGERPRINT'));
      const latePage = runPage(joinedLate.html);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(latePage.errors, []);
      latePage.dom.window.close();

      // Nothing to keep: the save writes the document alone.
      assert.equal(mergeApplicationDocument({ existingHtml: synced(resumeOnly('x')), stagedHtml: resumeOnly('y'), documentScope: 'resume' }), null);

      // A letter the person removed, then generated again.
      const removedData = embedApplicationSyncConfig(both('doc-removed'), applicationSyncConfig('b'.repeat(64), {}));
      const removed = withoutLetter(removedData);
      assert.deepEqual(workspaceDocumentKinds(removed), ['resume']);
      const regenerated = mergeApplicationDocument({ existingHtml: removed, stagedHtml: coverOnly('doc-new'), documentScope: 'cover' });
      assert.deepEqual(workspaceDocumentKinds(regenerated.html), ['resume', 'cover']);
      assert.equal(new JSDOM(regenerated.html).window.document.querySelectorAll('[data-ic-document-tab="cover"]').length, 1);
    },
  },
  {
    name: 'Sync on a single-document workspace edits that document and refuses the absent one',
    run() {
      const token = 'c'.repeat(64);
      const coverSource = coverOnly('doc');
      const cover = embedApplicationSyncConfig(coverSource, applicationSyncConfig(token, { html: coverSource }));
      const editedCover = cover.replace('First paragraph of the synthetic letter.', 'An edited opening.');
      const merged = mergeSelectedApplicationPanel(editedCover, cover, 'cover');
      assert.ok(String(merged.html ?? merged).includes('An edited opening.'));
      assert.throws(() => mergeSelectedApplicationPanel(editedCover, cover, 'resume'), /does not hold a résumé/u);
      const resume = embedApplicationSyncConfig(resumeOnly('doc'), applicationSyncConfig(token, {}));
      assert.throws(() => mergeSelectedApplicationPanel(resume, resume, 'cover'), /removed cover letter cannot be synced/u);
      const editedResume = resume.replace('Generated résumé line.', 'An edited line.');
      assert.ok(String(mergeSelectedApplicationPanel(editedResume, resume, 'resume').html ?? mergeSelectedApplicationPanel(editedResume, resume, 'resume')).includes('An edited line.'));
      const syncData = JSON.parse(new JSDOM(cover).window.document.getElementById('ic-application-bundle-data').textContent).sync;
      assert.equal(syncData.documents.resume.htmlSha256, '', 'an absent panel has no revision to compare');
      assert.ok(syncData.documents.cover.htmlSha256);
    },
  },
  {
    name: 'the edit log counts a second document as the same application, not as a rejected regeneration',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-log-'));
      try {
        const workspaceDir = path.join(root, 'bundle');
        const first = synced(resumeOnly('log-doc'));
        await logGeneratedBundle({ root, workspaceDir, html: first, posting: 'Posting', appVersion: 'test' });
        const joined = mergeApplicationDocument({ existingHtml: first, stagedHtml: coverOnly('log-letter'), documentScope: 'cover' }).html;
        const pair = await logGeneratedBundle({ root, workspaceDir, html: joined, posting: 'Posting', appVersion: 'test', addedDocument: 'cover' });
        assert.equal(pair.supersededAt, undefined);
        assert.ok(pair.generated.resume.includes('Generated résumé line.'), 'the first document\'s generated baseline stays');
        assert.ok(pair.generated.letter.includes('First paragraph'));
        const state = JSON.parse(await fs.readFile(path.join(root, 'application-improvement', 'state.json'), 'utf8'));
        assert.equal(state.pairs.length, 1);
        assert.equal(state.countSinceSession, 1, 'one application, one count');
        assert.equal(state.summaries.some(row => row.op === 'regenerated'), false);
        assert.equal((await improvementStatus(root)).countSinceSession ?? 1, 1);

        // A single document alone logs and diffs without a second panel.
        const letterDir = path.join(root, 'letter-bundle');
        const letterPair = await logGeneratedBundle({ root, workspaceDir: letterDir, html: synced(coverOnly('log-only')), posting: 'Posting', appVersion: 'test' });
        assert.equal(letterPair.generated.resume, '');
        assert.ok(letterPair.generated.letter);
        assert.deepEqual(editSummaries(letterPair.generated, documentSnapshot(synced(coverOnly('log-only'))), 'id', 'at'), []);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'saving one document and then the other, in either order or at the same moment, ends in one folder holding both',
    async run() {
      registerJobApplicationHandlers();
      const saveApplication = ipcMain.__getInvokeHandler('save-application');
      const listing = '# Synthetic role\n\nThe same original listing.\n';
      const sender = { id: 941, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {} };
      const stage = async (root, name, html) => {
        const workDir = path.join(root, 'stage', name);
        await fs.mkdir(workDir, { recursive: true });
        const resumeHtmlPath = path.join(workDir, 'Application.html');
        const jobListingPath = path.join(workDir, 'Original Job Listing.md');
        await fs.writeFile(resumeHtmlPath, html); await fs.writeFile(jobListingPath, listing);
        return { workDir, resumeHtmlPath, jobListingPath };
      };
      const save = async (root, outputRoot, name, documentScope, html) => {
        const staged = await stage(root, name, html);
        registerPendingApplicationWorkspace({ workDir: staged.workDir, senderId: sender.id, company: 'Sample Co', documentScope, applicationRoot: outputRoot,
          resumeHtmlPath: staged.resumeHtmlPath, jobListingPath: staged.jobListingPath, cleanupOnDiscard: false, cleanupOnSaveFailure: false,
          artifactData: { resumeHtml: html, jobListing: listing } });
        return saveApplication({ sender }, { resumeHtmlPath: staged.resumeHtmlPath, resumePdfPath: null, coverLetterPdfPath: null, jobListingPath: staged.jobListingPath,
          generationAuditPath: null, generationLogPath: null, scrapedListingPath: null, workDir: staged.workDir,
          jobTitle: 'Synthetic Role', location: 'Lakeview', canvasFilePath: path.join(root, 'canvas.json'), suppressReveal: true });
      };
      for (const [firstKind, firstHtml, secondKind, secondHtml] of [
        ['resume', resumeOnly('order-r'), 'cover', coverOnly('order-c')],
        ['cover', coverOnly('order-c2'), 'resume', resumeOnly('order-r2')],
      ]) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-save-'));
        const outputRoot = path.join(root, 'Applied Jobs');
        await fs.mkdir(outputRoot);
        await fs.writeFile(path.join(root, 'canvas.json'), '{}');
        try {
          const first = await save(root, outputRoot, 'first', firstKind, firstHtml);
          assert.equal(first.success, true, first.error);
          assert.deepEqual(first.savedDocuments, { resume: firstKind === 'resume', cover: firstKind === 'cover' });
          const absentName = firstKind === 'resume' ? 'cover-letter PDF' : 'résumé PDF';
          assert.equal(String(first.bundleError || '').includes(absentName), false, 'the absent document is not reported as missing');
          const keptPdf = await onePagePdf('kept');
          const keptPath = path.join(first.dir, firstKind === 'resume' ? 'Resume.pdf' : 'Cover Letter.pdf');
          await fs.writeFile(keptPath, keptPdf);
          const editedHtml = (await fs.readFile(path.join(first.dir, 'Application.html'), 'utf8'))
            .replace('Generated résumé line.', 'Edited line; kept.').replace('First paragraph of the synthetic letter.', 'Edited opening; kept.');
          await fs.writeFile(path.join(first.dir, 'Application.html'), editedHtml);

          const second = await save(root, outputRoot, 'second', secondKind, secondHtml);
          assert.equal(second.success, true, second.error);
          assert.equal(second.dir, first.dir, 'both documents land in one folder');
          assert.deepEqual(second.savedDocuments, { resume: true, cover: true });
          const finalHtml = await fs.readFile(path.join(second.dir, 'Application.html'), 'utf8');
          assert.deepEqual(workspaceDocumentKinds(finalHtml), ['resume', 'cover']);
          assert.ok(panelText(finalHtml, firstKind).includes('; kept.'), 'the first document\'s hand edit survived the second save');
          assert.ok(Buffer.from(await fs.readFile(keptPath)).equals(keptPdf), 'the first document\'s PDF is byte-for-byte what it was');
        } finally { await fs.rm(root, { recursive: true, force: true }); }
      }
      // Both saves landing at the same moment.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-race-'));
      const outputRoot = path.join(root, 'Applied Jobs');
      await fs.mkdir(outputRoot);
      await fs.writeFile(path.join(root, 'canvas.json'), '{}');
      try {
        const [one, two] = await Promise.all([
          save(root, outputRoot, 'race-resume', 'resume', resumeOnly('race-r')),
          save(root, outputRoot, 'race-cover', 'cover', coverOnly('race-c')),
        ]);
        assert.equal(one.success, true, one.error); assert.equal(two.success, true, two.error);
        assert.equal(one.dir, two.dir);
        const finalHtml = await fs.readFile(path.join(one.dir, 'Application.html'), 'utf8');
        assert.deepEqual(workspaceDocumentKinds(finalHtml), ['resume', 'cover'], 'neither save overwrote the other');
        assert.ok(panelText(finalHtml, 'resume')); assert.ok(panelText(finalHtml, 'cover'));
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'a résumé-only job writes an audit the save step accepts',
    run() {
      const audit = buildLocalGenerationAuditArtifact({ jobId: 'job', input: { job: { title: 'T' } }, result: { documentScope: 'resume', resumeMainHtml: RESUME_MAIN, coverLetter: null, coverLetterArgument: null }, resultRaw: '{}', applicationHtml: '<html></html>', jobListingMarkdown: '# Job', careerDataProvenance: { kind: 'pinned-career-authority' } });
      const parsed = JSON.parse(audit);
      assert.deepEqual(parsed.coverLetterArgument, { notRequested: true });
      for (const key of ['hostValidation', 'measuredFit', 'handoff']) assert.equal(typeof parsed[key], 'object', key);
    },
  },
  {
    name: 'the evidence archive keeps a one-document candidate and still refuses one holding neither',
    async run() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-archive-'));
      const jobId = '123e4567-e89b-42d3-a456-426614174000';
      const jobDir = path.join(root, '.local-ai', 'jobs', jobId);
      await fs.mkdir(jobDir, { recursive: true });
      try {
        const record = (structured, revision) => archiveV2Content({ jobDir, jobId, stage: 'convert', revision, kind: 'candidate-final', candidateId: 'candidate-1', content: { plainText: 'x', structured } });
        await record({ resume: { roles: [] } }, 1);
        await record({ coverLetter: { paragraphs: [] } }, 2);
        await assert.rejects(record({}, 3), /accepts only stage content/u);
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'the main process refuses a duplicate start for one card and document, at once and from what is on disk',
    async run() {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-start-')));
      const canvasFilePath = path.join(root, 'canvas.json');
      await fs.writeFile(canvasFilePath, '{}');
      const args = { canvasFilePath, nodeId: 'card', documentScope: 'resume' };
      try {
        // Two invokes in one turn: only one reaches its start.
        let starts = 0; let release;
        const gate = new Promise(resolve => { release = resolve; });
        const start = async () => { starts += 1; await gate; return 'started'; };
        const first = withApplicationDocumentStart(args, start);
        const second = withApplicationDocumentStart(args, start);
        await assert.rejects(second, error => error.code === 'LOCAL_AI_DOCUMENT_ALREADY_STARTED');
        const otherDocument = withApplicationDocumentStart({ ...args, documentScope: 'cover' }, async () => 'cover started');
        const otherCard = withApplicationDocumentStart({ ...args, nodeId: 'other' }, async () => 'other started');
        assert.equal(await otherDocument, 'cover started', 'the other document is a separate run');
        assert.equal(await otherCard, 'other started', 'another card is a separate run');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(starts, 1);
        release();
        assert.equal(await first, 'started');
        // A failed start releases its claim.
        await assert.rejects(withApplicationDocumentStart(args, async () => { throw new Error('boom'); }), /boom/u);
        assert.equal(await withApplicationDocumentStart(args, async () => 'again'), 'again');

        // A job already on disk holds its document until it ends or is replaced.
        const job = await __queueLegacyLocalApplicationFixtureForTests({ canvasFilePath, nodeId: 'card', job: { title: 'Developer', company: 'Acme', snippet: 'Reliable delivery.' }, careerData: 'Sample Person\nsample@example.test\nDeveloper at Acme' });
        const inputPath = path.join(job.folder, 'input.json');
        const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
        await fs.writeFile(inputPath, JSON.stringify({ ...input, documentScope: 'resume' }));
        await assert.rejects(withApplicationDocumentStart(args, async () => 'x'), error => error.code === 'LOCAL_AI_DOCUMENT_ALREADY_STARTED');
        assert.equal(await withApplicationDocumentStart({ ...args, documentScope: 'cover' }, async () => 'cover'), 'cover', 'it does not hold the other document');
        assert.equal(await withApplicationDocumentStart({ ...args, nodeId: 'other' }, async () => 'other'), 'other');
        assert.equal(await withApplicationDocumentStart({ ...args, priorLocalApplicationId: job.id }, async () => 'replacing'), 'replacing', 'the job this start replaces does not block it');
        const manifestPath = path.join(job.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'failed' }));
        assert.equal(await withApplicationDocumentStart(args, async () => 'retry'), 'retry', 'a failed job frees its document');
        // A job with no scope is producing both.
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        await fs.writeFile(inputPath, JSON.stringify(input));
        await assert.rejects(withApplicationDocumentStart({ ...args, documentScope: 'cover' }, async () => 'x'), error => error.code === 'LOCAL_AI_DOCUMENT_ALREADY_STARTED');
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'on the real card, each button starts its own document, the second waits its turn, and every state greys out the right button',
    async run() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'single-doc-card-'));
      const entry = path.join(directory, 'CardProbe.jsx');
      const source = file => JSON.stringify(path.resolve(file));
      await fs.writeFile(entry, `
import React from ${source('node_modules/react/index.js')};
import { ReactFlowProvider } from '@xyflow/react';
import { JobCardNode } from ${source('src/nodes/JobCardNode.jsx')};
import { CanvasNavigationContext } from ${source('src/contexts/CanvasNavigationContext.jsx')};
import { ModuleRunQueueContext } from ${source('src/contexts/moduleRunQueueShared.js')};
import { ToastProvider } from ${source('src/components/ToastProvider.jsx')};
export function CardProbe({navigation, queue, card}) {
  return <ReactFlowProvider><CanvasNavigationContext.Provider value={navigation}><ModuleRunQueueContext.Provider value={queue}><ToastProvider>
    {card ? <JobCardNode id={card.id} data={card.data} /> : null}
  </ToastProvider></ModuleRunQueueContext.Provider></CanvasNavigationContext.Provider></ReactFlowProvider>;
}
`);
      let bundle = null;
      try {
        bundle = await bundleComponent(entry);
        const { React, act, createRoot, CardProbe } = bundle.module;
        await withDom(async window => withConsoleCollector(async () => {
          const job = extra => ({ hubId: 'board', careerSnapshotId: 'a'.repeat(64), company: 'Sample Co', title: 'Synthetic Role', snippet: 'Synthetic listing.',
            location: 'Lakeview', url: 'https://example.test/job', ...extra });
          const documentButton = kind => window.document.querySelector(`[data-application-document="${kind}"]`);
          const mount = async (initial, { queueResults = [] } = {}) => {
            const state = { card: { id: 'split-card', type: 'jobcard', data: job(initial) } };
            const board = { id: 'board', type: 'jobboard', data: {} };
            const search = { id: 'search', type: 'jobhub', data: { careerSnapshotId: 'a'.repeat(64) } };
            const queued = [];
            const prepared = [];
            window.electronAPI = {
              prepareOfficialPostingForGeneration: async args => { prepared.push(args); return { success: true, resolutionId: 'resolution', preparedAt: new Date().toISOString(), listingCheck: { action: 'proceed' } }; },
              checkApplicationGenerationGate: async () => ({ success: true, blocked: false }),
              queueLocalApplication: async args => { queued.push(args); if (queueResults.length) return queueResults.shift(); return { success: true, localJob: { id: `job-${queued.length}`, status: 'queued', mode: 'paste', canvasFilePath: '/synthetic/canvas.json' } }; },
              getLocalApplicationStatus: async ({ jobId }) => ({ success: true, localJob: { id: jobId, status: state.card.data.localApplication?.id === jobId ? state.card.data.localApplication.status : 'saved' } }),
              completeNonApiAiRun: async () => {},
              discardLocalApplication: async () => ({ success: true, discarded: true }),
            };
            const navigation = {
              getCurrentFile: () => '/synthetic/canvas.json', enumerateAllNodes: () => [state.card, board, search].filter(Boolean),
              enumerateAllEdges: () => [{ source: 'board', target: 'search' }],
              updateNodeDataGlobally: (_id, change) => {
                const patch = typeof change === 'function' ? change(state.card) : change;
                if (patch) state.card = { ...state.card, data: { ...state.card.data, ...patch } };
              },
            };
            const queue = { snapshot: { active: null, activeRuns: [], queued: [] }, acquireModuleRun: async ({ onStart }) => { onStart?.(); return { release() {} }; }, cancelQueuedRunsForNode() {} };
            const root = createRoot(window.document.getElementById('root'));
            const render = () => act(async () => root.render(React.createElement(CardProbe, { navigation, queue, card: state.card })));
            await render();
            return active = { state, queued, prepared, render, root, settle: async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); await render(); },
              setJob: async patch => { state.card = { ...state.card, data: { ...state.card.data, localApplication: { ...state.card.data.localApplication, ...patch } } }; await render(); },
              unmount: async () => { active = null; await act(async () => root.unmount()); window.document.getElementById('root').replaceChildren(); } };
          };
          let active = null;
          try {

          // The second button starts both documents in one job with no scope.
          let card = await mount({});
          assert.equal(documentButton('resume').textContent.trim(), 'Generate résumé');
          assert.equal(documentButton('both').textContent.trim(), 'Generate résumé and cover letter');
          assert.equal(documentButton('cover'), null, 'a letter is never offered before its résumé');
          await act(async () => { documentButton('both').click(); });
          await card.settle(60);
          assert.equal(card.queued.length, 1);
          assert.equal(card.queued[0].documentScope ?? null, null, 'one job produces both');
          assert.equal(documentButton('resume').disabled, true, 'the job covers the résumé');
          assert.equal(documentButton('cover').disabled, true, 'and the letter');
          await act(async () => { documentButton('resume').click(); documentButton('cover').click(); });
          await card.settle(30);
          assert.equal(card.queued.length, 1, 'neither starts a second job');
          await card.unmount();
          card = await mount({ localApplication: { id: 'job-1', status: 'failed', message: 'Stopped.' } });
          assert.match(documentButton('both').textContent, /Retry résumé and cover letter/u, 'a failed job retries as what it was');
          assert.equal(documentButton('resume').disabled, false, 'the résumé alone is still a choice');
          await card.unmount();
          card = await mount({ localApplication: { id: 'job-1', status: 'saved', savedDir: '/synthetic/folder', savedDocuments: { resume: true, cover: true } } });
          assert.equal(documentButton('resume').textContent.trim(), 'Résumé');
          assert.equal(documentButton('cover').textContent.trim(), 'Cover letter');
          assert.equal(documentButton('cover').disabled, true, 'both saved, nothing left to generate');
          await card.unmount();

          // The résumé button starts only the résumé, and the second button then adds the letter.
          card = await mount({});
          assert.equal(documentButton('resume').disabled, false);
          assert.equal(documentButton('both').disabled, false);
          await act(async () => { documentButton('resume').click(); });
          await card.settle(60);
          assert.equal(card.queued.length, 1);
          assert.equal(card.queued[0].documentScope, 'resume');
          assert.equal(card.state.card.data.localApplication.documentScope, 'resume');
          assert.equal(documentButton('resume').disabled, true, 'its own run greys it out');
          assert.equal(documentButton('cover').disabled, false, 'the other document can still be pressed');

          await card.unmount();

          // A résumé saved earlier: the second button adds only its letter, never the résumé again.
          card = await mount({ localApplication: { id: 'job-1', status: 'saved', savedDir: '/synthetic/folder', savedDocuments: { resume: true, cover: false } } });
          assert.equal(documentButton('resume').textContent.trim(), 'Résumé', 'the saved résumé is not offered again');
          assert.equal(documentButton('resume').disabled, true, 'a saved résumé cannot be regenerated');
          assert.equal(documentButton('both'), null, 'the pair is never offered once the résumé exists');
          assert.ok(documentButton('cover'), 'the letter is still a choice');
          assert.equal(documentButton('cover').textContent.trim(), 'Generate cover letter');
          assert.equal(documentButton('cover').disabled, false, 'only the letter is left to generate');
          await act(async () => { documentButton('cover').click(); });
          await card.settle(60);
          assert.equal(card.queued.length, 1, 'one job, and it never regenerates the résumé');
          assert.equal(card.queued[0].documentScope, 'cover');
          await card.unmount();

          // Spam clicks in one tick, before anything could render: exactly one run, per document.
          for (const kind of ['resume', 'both']) {
            const scope = kind === 'resume' ? 'resume' : null;
            card = await mount({});
            const handler = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))].onClick;
            const onClick = handler(documentButton(kind));
            await act(async () => { const event = { stopPropagation() {} }; for (let i = 0; i < 5; i += 1) onClick(event); documentButton(kind).click(); });
            await card.settle(60);
            assert.equal(card.prepared.length, 1, `${kind}: one lookup`);
            assert.deepEqual(card.queued.map(row => row.documentScope ?? null), [scope], `${kind}: one job`);
            await card.unmount();

            // Both buttons spammed together: one job, and a résumé first means the letter waits once.
            card = await mount({});
            const first = handler(documentButton(kind)); const second = handler(documentButton(kind === 'resume' ? 'both' : 'resume'));
            await act(async () => { const event = { stopPropagation() {} }; for (let i = 0; i < 4; i += 1) { first(event); second(event); } });
            await card.settle(60);
            assert.deepEqual(card.queued.map(row => row.documentScope ?? null), [scope], `${kind} first: one job now`);
            assert.equal(card.state.card.data.queuedApplicationDocument ?? null, kind === 'resume' ? 'cover' : null);
            await act(async () => { card.state.card = { ...card.state.card, data: { ...card.state.card.data, queuedApplicationDocument: null } }; });
            await card.settle(1100);
            await card.unmount();

            // A refused or failed start releases the claim, and the button works again.
            card = await mount({}, { queueResults: [{ success: false, error: 'Synthetic refusal.', errorCode: 'LOCAL_AI_DOCUMENT_ALREADY_STARTED' }] });
            await act(async () => { documentButton(kind).click(); });
            await card.settle(60);
            assert.equal(card.queued.length, 1);
            assert.equal(documentButton(kind).disabled, false, `${kind}: a refusal frees the button`);
            await act(async () => { documentButton(kind).click(); });
            await card.settle(60);
            assert.equal(card.queued.length, 2, `${kind}: the button works again`);
            await card.unmount();
          }

          // Pressing the other one while the first runs waits, and is not a crash or a second job.
          card = await mount({});
          await act(async () => { documentButton('resume').click(); });
          await card.settle(60);
          await act(async () => { documentButton('cover').click(); });
          await card.settle(30);
          assert.equal(card.state.card.data.queuedApplicationDocument, 'cover');
          assert.equal(documentButton('cover').disabled, true);
          assert.match(documentButton('cover').textContent, /next/u);
          assert.equal(card.queued.length, 1, 'one job at a time');
          // Pressing it twice cannot queue it twice.
          await act(async () => { documentButton('cover').click(); });
          assert.equal(card.queued.length, 1);

          // The first ends: the second starts by itself and the saved one stays blocked.
          await card.setJob({ status: 'saved', savedDir: '/synthetic/folder', savedDocuments: { resume: true, cover: false } });
          await card.settle(1200);
          assert.equal(card.queued.length, 2);
          assert.equal(card.queued[1].documentScope, 'cover');
          assert.equal(card.queued[1].priorLocalApplicationId, 'job-1');
          assert.equal(card.state.card.data.queuedApplicationDocument, null);
          assert.equal(card.state.card.data.localApplication.id, 'job-2');
          assert.equal(card.state.card.data.priorSavedApplication.id, 'job-1', 'the saved résumé is kept beside the running letter');
          assert.equal(documentButton('resume').disabled, true);
          assert.equal(documentButton('cover').disabled, true);
          await card.unmount();

          // After a restart, the canvas alone says what is blocked.
          card = await mount({ localApplication: { id: 'job-2', status: 'queued', mode: 'paste', documentScope: 'cover' },
            priorSavedApplication: { id: 'job-1', status: 'saved', savedDir: '/synthetic/folder', documentScope: 'resume', savedDocuments: { resume: true, cover: false } } });
          assert.equal(documentButton('resume').disabled, true, 'saved résumé after restart');
          assert.equal(documentButton('cover').disabled, true, 'running letter after restart');
          await card.unmount();

          // A failed letter frees only its own button.
          card = await mount({ localApplication: { id: 'job-2', status: 'failed', documentScope: 'cover', message: 'Stopped.' },
            priorSavedApplication: { id: 'job-1', status: 'saved', savedDir: '/synthetic/folder', documentScope: 'resume', savedDocuments: { resume: true, cover: false } } });
          assert.equal(documentButton('cover').disabled, false);
          assert.match(documentButton('cover').textContent, /Retry cover letter/u);
          assert.equal(documentButton('resume').disabled, true);
          await act(async () => { documentButton('cover').click(); });
          await card.settle(60);
          assert.equal(card.queued.length, 1, 'the failed one can be pressed again');
          assert.equal(card.queued[0].documentScope, 'cover');
          assert.equal(card.state.card.data.priorSavedApplication.id, 'job-1');
          await card.unmount();

          // A saved application from before the split.
          card = await mount({ localApplication: { id: 'old', status: 'saved', savedDir: '/synthetic/old' } });
          assert.equal(documentButton('resume').disabled, true);
          assert.equal(documentButton('cover').disabled, true);
          await act(async () => { documentButton('resume').click(); documentButton('cover').click(); });
          assert.equal(card.queued.length, 0);
          await card.unmount();

          // A queued document on the canvas restarts by itself when the card mounts.
          // A waiter from the run above holds this card's slot for one more poll.
          await new Promise(resolve => setTimeout(resolve, 1100));
          card = await mount({ queuedApplicationDocument: 'cover' });
          await card.settle(1200);
          assert.equal(card.queued.length, 1);
          assert.equal(card.queued[0].documentScope, 'cover');
          assert.equal(card.state.card.data.queuedApplicationDocument, null);
          await card.unmount();
          } finally { await active?.unmount(); }
        }));
      } finally { await bundle?.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
    },
  },
];

function applicationBundleScope(html) {
  const dom = new JSDOM(html);
  try { return JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent).documentScope; }
  finally { dom.window.close(); }
}

function withoutLetter(html) {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const doc = dom.window.document;
  const edits = ['[data-ic-document-panel="cover"]', '[data-ic-document-tab="cover"]'].map(selector => dom.nodeLocation(doc.querySelector(selector)));
  const data = JSON.parse(doc.getElementById('ic-application-bundle-data').textContent);
  dom.window.close();
  let out = String(html);
  for (const edit of edits.sort((a, b) => b.startOffset - a.startOffset)) out = out.slice(0, edit.startOffset) + out.slice(edit.endOffset);
  return out.replace(/(<script\s+id="ic-application-bundle-data"[^>]*>)[\s\S]*?(<\/script>)/iu, (_m, open, close) => `${open}${JSON.stringify({ ...data, letterRemoved: true })}${close}`);
}
