import { assert, fs, getLocalApplicationHandoff, importLocalApplicationJob, ipcMain, os, path, queueLocalApplicationJob, registerJobApplicationHandlers, registerPendingApplicationWorkspace, submitLocalApplicationHandoff } from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION, __setLocalAiRenderPdfForTests, localApplicationStatus } from '../../electron/ipc/localAiApplication.js';
import { _resetPasteHandoffDiagnostics, getPasteHandoffDiagnosticsSnapshot } from '../../electron/ipc/pasteHandoffDiagnostics.js';
import { PDFDocument } from '../test-dependencies.js';

const careerData = 'Ada Lovelace\nada@example.test\nEngineer\nMaintained internal systems with supported delivery practices.\nMaintained reliable internal systems with supported delivery practices.\nMy experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.\nMy experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.';
const identity = { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' };
const criteria = () => APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
const checklist = () => APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` }));

function reply(handoff, fields) {
  return { protocol: 1, jobId: handoff.jobId, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields };
}

function audit(paragraph, thesis, proof) {
  return {
    version: LOCAL_AI_GENERATION_AUDIT_VERSION,
    jobPriorities: [{ requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both', justification: 'The selected systems evidence directly addresses the stated delivery requirement.' }],
    resumePlan: { strategy: 'Lead with the strongest supported systems evidence for the role.', selectionRationale: 'The retained role preserves direct factual support and concise relevance.' },
    coverLetterPlan: { controllingThesis: thesis, paragraphs: [{ paragraph, argumentativeJob: 'Establish the controlling evidence-to-need connection.', relationToThesis: 'Connect the source-supported proof to reliable system delivery.', relationToPreviousParagraph: 'opening', sentences: paragraph.split(/(?<=\.)\s+/u).map((sentence, index) => ({ sentence, function: index === 0 ? 'States the general candidate capability.' : index === 1 ? 'Supplies the source-supported candidate proof.' : 'Connects the proof to the target responsibility.', relationToPreviousSentence: index === 0 ? 'opening' : 'Develops the preceding argument step.' })), argumentMapping: { claim: proof.includes('reliable') ? 'My experience delivering reliable supported systems is a relevant capability.' : 'My experience delivering supported systems is a relevant capability.', proof, relevance: proof.includes('reliable') ? 'I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.' : 'I would apply my experience delivering supported systems to reliable system delivery this role requires.', jobNeedQuote: 'reliable system delivery' } }] },
    finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
  };
}

function review(handoff, { resume, coverLetter, decision = 'pass', findings = [], resumeRationale, finalDecisionSummary }) {
  const proof = coverLetter.paragraphs[0].text.split(/(?<=\.)\s+/u)[1];
  const finalAudit = audit(coverLetter.paragraphs[0].text, coverLetter.roleThesis, proof);
  return reply(handoff, {
    decision, findings, checklist: checklist(), resume: decision === 'revised' ? resume : undefined,
    coverLetter: decision === 'revised' ? coverLetter : undefined,
    qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: criteria(), resume: { decision: 'approved', rationale: resumeRationale || 'The résumé preserves direct source-supported systems evidence with clear relevance.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' } },
    generationAudit: finalDecisionSummary ? { ...finalAudit, finalDecisionSummary } : finalAudit,
  });
}

const measuredFitSaveTests = [{
  name: 'Paste application measured-fit revision reaches final save and retains every output log revision',
  async run() {
    const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-fit-save-')));
    const canvasFilePath = path.join(root, 'Canvas.json');
    let renderCount = 0;
    try {
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      const queued = await queueLocalApplicationJob({
        transport: 'paste', canvasFilePath, careerData,
        job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery.' },
        resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
      });
      let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const evidence = reply(handoff, {
        identity,
        evidence: [
          { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'revision-letter-proof', sourceId: 'career-data', quote: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
        ],
        requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
      });
      const evidenceAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
      assert(evidenceAccepted.accepted, `evidence plan must be accepted: ${(evidenceAccepted.validationErrors || []).join(' | ')}`);
      handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
      const resumeAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
      assert(resumeAccepted.accepted, `résumé must be accepted: ${(resumeAccepted.validationErrors || []).join(' | ')}`);
      handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
      const letterAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
      assert(letterAccepted.accepted, `cover letter must be accepted: ${(letterAccepted.validationErrors || []).join(' | ')}`);
      handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: firstResume, coverLetter: letter })) });
      assert(initialPass.accepted && initialPass.completed, `the initial final review is accepted before host PDF measurement: ${(initialPass.validationErrors || []).join(' | ')}`);
      const completedStatus = await localApplicationStatus(queued.id, canvasFilePath);
      assert(completedStatus.status === 'completed' && completedStatus.mode === 'paste',
        'the status poll preserves paste ownership after final review while the app prepares its measured import');

      const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
      const bytes = Buffer.from(await pdf.save());
      __setLocalAiRenderPdfForTests(async () => {
        renderCount += 1;
        const overflow = renderCount <= 2;
        return { bytes, pageCount: overflow ? 2 : 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } };
      });
      const firstImport = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
      assert(firstImport.status === 'revision-required' && firstImport.handoff?.stage === 'review' && firstImport.handoff?.prompt.includes('requiredChangeDocuments'), 'measured overflow reopens the paste review with a required résumé edit');

      handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const revisedResume = structuredClone(firstResume);
      revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
      const revisedLetter = structuredClone(letter);
      revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
      revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
      const revisedPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings: [{ id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'The measured page target requires a tighter supported bullet.', fix: 'Use the concise reliable-systems wording.' }, { id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' }] })) });
      assert(revisedPass.accepted && revisedPass.handoff?.stage === 'review', 'the same review response carries the material edit and produces the required follow-up review');
      handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
      const finalPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: revisedResume, coverLetter: revisedLetter })) });
      assert(finalPass.accepted && finalPass.completed, 'the subsequent clean review can complete the repaired package');
      const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
      assert(imported.status === 'imported' && renderCount >= 4, 'the revised package rerenders both documents and passes measured fit');

      registerJobApplicationHandlers();
      const save = ipcMain.__getInvokeHandler('save-application');
      const sender = { id: 9911, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {} };
      // The fit renderer test returns a deliberately minimal valid PDF.  The
      // save path independently rejects textless PDFs and would invoke an
      // Electron BrowserWindow in this plain-Node suite.  Re-register the
      // already staged HTML/audit/log capability without PDFs so this test
      // exercises the real final output transaction and log merge.
      const [resumeHtml, jobListing, stagedAudit, generationLog] = await Promise.all([
        fs.promises.readFile(imported.resumeHtmlPath, 'utf8'), fs.promises.readFile(imported.jobListingPath, 'utf8'),
        fs.promises.readFile(imported.generationAuditPath, 'utf8'), fs.promises.readFile(imported.generationLogPath, 'utf8'),
      ]);
      const auditObject = JSON.parse(stagedAudit);
      auditObject.finalArtifacts.resumePdfSha256 = null;
      auditObject.finalArtifacts.coverLetterPdfSha256 = null;
      const generationAudit = `${JSON.stringify(auditObject, null, 2)}\n`;
      await fs.promises.writeFile(imported.generationAuditPath, generationAudit, 'utf8');
      registerPendingApplicationWorkspace({
        workDir: imported.workDir, senderId: 9911, company: 'Acme', candidateName: identity.name,
        applicationRoot: path.join(root, 'Applied Jobs'), resumeHtmlPath: imported.resumeHtmlPath,
        resumePdfPath: null, coverLetterPdfPath: null, jobListingPath: imported.jobListingPath,
        generationAuditPath: imported.generationAuditPath, generationLogPath: imported.generationLogPath,
        generationAuditJobId: queued.id, generationAuditRequired: true, cleanupOnDiscard: false,
        artifactData: { resumeHtml, resumePdf: null, coverLetterPdf: null, jobListing, generationAudit, generationLog },
      });
      const saved = await save({ sender }, { resumeHtmlPath: imported.resumeHtmlPath, resumePdfPath: null, coverLetterPdfPath: null, jobListingPath: imported.jobListingPath, generationAuditPath: imported.generationAuditPath, generationLogPath: imported.generationLogPath, workDir: imported.workDir, jobTitle: 'Engineer', location: '', canvasFilePath, suppressReveal: true });
      const events = (await fs.promises.readFile(saved.generationLogFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(saved.success && events.some(event => event.type === 'host-fit-revision-requested')
        && events.filter(event => event.type === 'paste-accepted').length === 6
        && new Set(events.map(event => `${event.jobId}:${event.sequence}`)).size === events.length,
      'the final output Generation Log.jsonl retains every accepted handoff and the host fit revision without replacing prior revisions');
      return { renderCount, outputEvents: events.length, acceptedEvents: events.filter(event => event.type === 'paste-accepted').length };
    } finally {
      __setLocalAiRenderPdfForTests(null);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  },
}];

// --- DELTA REVIEW ROUND coverage (Task B2, electron/ipc/pasteReviewDelta.js) ---
//
// Shared by both tests below: walks a job to its FIRST clean review pass
// (which sets state.finalReview), then forces a measured-fit overflow so the
// review reopens with state.finalReview retained — the exact live shape the
// delta path exists for (localAiApplication.js's submitLocalApplicationHandoff,
// "DELTA REVIEW ROUND"). Returns the reopened handoff plus the two documents
// it was built from, so a caller can derive an equivalent delta from a
// hand-authored full revision.
async function buildReopenedReviewJob(canvasFilePath) {
  const queued = await queueLocalApplicationJob({
    transport: 'paste', canvasFilePath, careerData,
    job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery.' },
    resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
  });
  let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  const evidence = reply(handoff, {
    identity,
    evidence: [
      { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'revision-letter-proof', sourceId: 'career-data', quote: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
      { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
    ],
    requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
  });
  const evidenceAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
  assert(evidenceAccepted.accepted, `evidence plan must be accepted: ${(evidenceAccepted.validationErrors || []).join(' | ')}`);
  handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
  const resumeAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
  assert(resumeAccepted.accepted, `résumé must be accepted: ${(resumeAccepted.validationErrors || []).join(' | ')}`);
  handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
  const letterAccepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
  assert(letterAccepted.accepted, `cover letter must be accepted: ${(letterAccepted.validationErrors || []).join(' | ')}`);
  handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: firstResume, coverLetter: letter })) });
  assert(initialPass.accepted && initialPass.completed, `the initial final review must be accepted before host PDF measurement: ${(initialPass.validationErrors || []).join(' | ')}`);

  // Every render reports 2 pages — both documents measure over target — so
  // the reopened review requires BOTH resume:rendered and coverLetter:rendered
  // to change, which is what the second test below relies on.
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
  const bytes = Buffer.from(await pdf.save());
  __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 2, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: 760, typeAreaHeightPx: 800 } }));
  const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
  __setLocalAiRenderPdfForTests(null);
  assert(imported.status === 'revision-required' && imported.handoff?.stage === 'review', `measured overflow must reopen the review: ${JSON.stringify(imported)}`);

  handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
  return { queued, dir: queued.folder, handoff, firstResume, letter };
}

const deltaReviewTests = [
  {
    name: 'A delta review round and its equivalent full resend persist byte-identical accepted state',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-review-delta-invariant-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        // Two independently reopened jobs, walked through identical fixture
        // inputs, so their accepted state agrees on everything but the
        // per-round random handoffCode — one is fed the full resend, the
        // other its derived delta, and the two results are compared below.
        const jobA = await buildReopenedReviewJob(canvasFilePath);
        const jobB = await buildReopenedReviewJob(canvasFilePath);

        const revisedResume = structuredClone(jobA.firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const revisedLetter = structuredClone(jobA.letter);
        revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
        revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
        const findings = [
          { id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'The measured page target requires a tighter supported bullet.', fix: 'Use the concise reliable-systems wording.' },
          { id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' },
        ];

        // Both reopened handoffs printed the delta contract (Task B2 #1):
        // confirms the round under test is genuinely delta-eligible, not an
        // accident of this fixture.
        for (const op of ['"replace"', '"insert-after"', '"remove"']) {
          assert(jobB.handoff.prompt.includes(op), `the reopened review prompt must print the delta engine's own op vocabulary (${op}): ${jobB.handoff.prompt}`);
        }
        assert(jobB.handoff.prompt.includes('DELTA instead of a whole-document replacement'),
          'a reopened review prompt with an accepted prior review must print the delta patch contract');

        const fullResponse = review(jobA.handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const fullResult = await submitLocalApplicationHandoff({ jobId: jobA.queued.id, canvasFilePath, handoffCode: jobA.handoff.handoffCode, response: JSON.stringify(fullResponse) });
        assert(fullResult.accepted, `the full revised review must be accepted: ${(fullResult.validationErrors || []).join(' | ')}`);

        // The equivalent delta: literally the same response, minus the two
        // whole-document replacements, plus the patches that reconstruct them.
        // checklist/qualityReview/generationAudit are supplied here IN FULL
        // (rather than trimmed to only what requiredPasteReviewDeltaEntries
        // would insist on) precisely so this test isolates the one thing that
        // must still match exactly: the résumé and cover-letter reconstruction
        // the patch engine performs.
        const fullShaped = review(jobB.handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const { resume: _fullResume, coverLetter: _fullCoverLetter, ...deltaResponse } = fullShaped;
        deltaResponse.patches = [
          { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } },
          { op: 'replace', target: 'coverLetter:paragraph:paragraph-1', value: { text: revisedLetter.paragraphs[0].text, evidenceIds: revisedLetter.paragraphs[0].evidenceIds } },
          { op: 'replace', target: 'coverLetter:argument:primaryEvidence.evidence', value: revisedLetter.coverLetterArgument.primaryEvidence.evidence },
        ];
        const deltaResult = await submitLocalApplicationHandoff({ jobId: jobB.queued.id, canvasFilePath, handoffCode: jobB.handoff.handoffCode, response: JSON.stringify(deltaResponse) });
        assert(deltaResult.accepted, `the equivalent delta review must be accepted: ${(deltaResult.validationErrors || []).join(' | ')}`);

        // The measured defect this module exists to fix (pasteReviewDelta.js's
        // own header): a revision round's bookkeeping is retyped verbatim
        // every time, and the two whole-document replacements it carries are
        // only ~23% of it. Compare real byte counts measured from THIS
        // fixture's own documents and patches — never a guessed percentage —
        // against the one relationship the delta mechanism actually
        // guarantees: its patches weigh less than the whole documents they
        // reconstruct, because they carry only what changed (one bullet, one
        // paragraph, one argument field) instead of every unchanged field
        // (identity, salutation, closing, every other bullet and paragraph)
        // the accepted prior review already holds.
        const fullBytes = Buffer.byteLength(JSON.stringify(fullResponse), 'utf8');
        const deltaBytes = Buffer.byteLength(JSON.stringify(deltaResponse), 'utf8');
        const omittedDocumentBytes = Buffer.byteLength(JSON.stringify({ resume: revisedResume, coverLetter: revisedLetter }), 'utf8');
        const patchesBytes = Buffer.byteLength(JSON.stringify(deltaResponse.patches), 'utf8');
        assert(deltaBytes < fullBytes,
          `a delta round must be smaller than the equivalent full resend (full=${fullBytes} bytes, delta=${deltaBytes} bytes)`);
        assert(patchesBytes < omittedDocumentBytes,
          `a delta's patches must weigh less than the whole-document replacements they reconstruct — the entire mechanism this module exists for (patches=${patchesBytes} bytes, omittedDocuments=${omittedDocumentBytes} bytes)`);

        const [manifestA, manifestB] = await Promise.all([
          fs.promises.readFile(path.join(jobA.dir, 'manifest.json'), 'utf8').then(JSON.parse),
          fs.promises.readFile(path.join(jobB.dir, 'manifest.json'), 'utf8').then(JSON.parse),
        ]);
        // handoffCode/priorHandoffCodes are minted fresh per accepted round
        // (crypto.randomBytes, rotatePasteHandoffCode) and jobId is the two
        // jobs' own genuine identity — none of the three can ever match
        // across two independently queued, independently submitted jobs.
        // All three also ride inside evidencePlan and finalReview, which
        // store the WHOLE envelope of the response that produced them (see
        // the comment above submitLocalApplicationHandoff's stage-1 block),
        // so the strip has to be recursive, not top-level-only.
        //
        // baseHashes.evidencePlan (pasteBaseHashesFor) hashes that same
        // whole stored evidencePlan object, jobId included, so it can never
        // match between two independently queued jobs either — unlike
        // baseHashes.resume/coverLetter, which hash only the documents
        // themselves and carry no envelope. This is a property of jobId
        // hashing, not of the delta path, so it is stripped everywhere a
        // baseHashes object appears (top level and inside finalReview).
        // Every OTHER field of the accepted state — at any depth — is the
        // property under test.
        const strip = (value) => {
          if (Array.isArray(value)) return value.map(strip);
          if (!value || typeof value !== 'object') return value;
          const out = {};
          for (const [key, entry] of Object.entries(value)) {
            if (['jobId', 'handoffCode', 'priorHandoffCodes'].includes(key)) continue;
            if (key === 'baseHashes' && entry && typeof entry === 'object') {
              const { evidencePlan: _evidencePlanHash, ...restHashes } = entry;
              out[key] = strip(restHashes);
              continue;
            }
            out[key] = strip(entry);
          }
          return out;
        };
        const [strippedA, strippedB] = [strip(manifestA.paste), strip(manifestB.paste)];
        assert(JSON.stringify(strippedA) === JSON.stringify(strippedB),
          `a delta round and its equivalent full resend must persist byte-identical accepted state:\nA=${JSON.stringify(strippedA)}\nB=${JSON.stringify(strippedB)}`);
        assert(typeof manifestB.paste.handoffCode === 'string' && manifestB.paste.handoffCode.length > 0,
          'the accepted delta round still rotates its own fresh handoff code like any other accepted round');
        return { deltaAccepted: true, byteIdentical: true, fullBytes, deltaBytes, patchesBytes, omittedDocumentBytes };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'A delta review round cannot dodge a host-required change by leaving one required document unpatched',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-review-delta-dodge-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const job = await buildReopenedReviewJob(canvasFilePath);
        // Confirms the fixture actually requires BOTH documents to change, so
        // the rejection below is known to come from the untouched résumé
        // half specifically, not from a reopening that never required it.
        assert(job.handoff.prompt.includes('"requiredChangeTargets"')
          && job.handoff.prompt.includes('resume:rendered') && job.handoff.prompt.includes('coverLetter:rendered'),
        `the reopened review must require both documents to change: ${job.handoff.prompt}`);

        const revisedLetter = structuredClone(job.letter);
        revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
        revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
        const findings = [{ id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' }];

        // A full, valid response for "only the letter changed" — resume is
        // the CURRENT accepted one, unchanged — so this dodge is otherwise a
        // legitimate delta, not a malformed one.
        const fullShaped = review(job.handoff, { resume: job.firstResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const { resume: _r, coverLetter: _c, ...deltaResponse } = fullShaped;
        deltaResponse.patches = [
          { op: 'replace', target: 'coverLetter:paragraph:paragraph-1', value: { text: revisedLetter.paragraphs[0].text, evidenceIds: revisedLetter.paragraphs[0].evidenceIds } },
          { op: 'replace', target: 'coverLetter:argument:primaryEvidence.evidence', value: revisedLetter.coverLetterArgument.primaryEvidence.evidence },
          // Deliberately NO patch touching the résumé.
        ];
        const result = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: job.handoff.handoffCode, response: JSON.stringify(deltaResponse) });
        assert(!result.accepted, `a delta round must still be rejected while a required résumé change is outstanding: ${JSON.stringify(result)}`);
        assert(result.validationErrors.some(message => /resume/i.test(message) && /change materially/i.test(message)),
          `the rejection must name the still-outstanding résumé requirement: ${JSON.stringify(result.validationErrors)}`);
        // Confirms the round reached the material-change gate itself, rather
        // than being rejected earlier as a malformed patch or a missing
        // required entry — different code paths than the one under test.
        assert(!result.validationErrors.some(message => /patches\[/.test(message) || /invalidated/i.test(message)),
          `a patch-shape or missing-entry error would mean the round never reached the material-change gate: ${JSON.stringify(result.validationErrors)}`);
        return { rejected: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];

// --- THE DEADLOCK regression (rotatePasteHandoffCode's own header; the
// submitLocalApplicationHandoff completing branch fixed alongside it) ---
//
// MEASURED LIVE FAILURE: a review passed at 22:56:06 (stage -> 'completed',
// handoffCode null). At 22:56:16 the host rendered the PDF, measured a
// résumé page count over its target, and reopened stage 'review' with a
// NEWLY MINTED code — while baseHashes stayed identical, because a fit
// revision measures the rendered PDF and edits no document. The AI chat kept
// answering with the handoffCode from the round that had just been accepted,
// and every otherwise-correct paste was rejected as a handoff the job never
// issued: an unrecoverable deadlock, since the code the chat kept echoing was
// gone forever the moment the job completed. (The original live failure was
// actually a measured type-area underfill, back when utilization still gated
// shipping; a measured overflow reopens the same review path today and is
// what this regression now reproduces the deadlock against.)
const deadlockRegressionTests = [
  {
    name: 'THE DEADLOCK: a fit-revision reopening tolerates the just-finished review round\'s own echoed code, and still rejects a code this job never minted',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-deadlock-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        _resetPasteHandoffDiagnostics();
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath, careerData,
          job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
        });
        let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const evidence = reply(handoff, {
          identity,
          evidence: [
            { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
        });
        let r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
        assert(r.accepted, `evidence plan must be accepted: ${(r.validationErrors || []).join(' | ')}`);
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
        assert(r.accepted, `résumé must be accepted: ${(r.validationErrors || []).join(' | ')}`);
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
        assert(r.accepted, `cover letter must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        // Capture the review round's own code and baseHashes before the
        // 'pass' rotates them away — this is the code a chat still quoting
        // its own last turn would echo, and the baseHashes a fit revision
        // must leave untouched.
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const passingReviewHandoffCode = handoff.handoffCode;
        const preRevisionBaseHashes = handoff.baseHashes;
        const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: firstResume, coverLetter: letter })) });
        assert(initialPass.accepted && initialPass.completed, `the initial review must pass before host measurement: ${(initialPass.validationErrors || []).join(' | ')}`);

        const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        // 2 pages against a 1-page target for the résumé ONLY (the cover
        // letter reports 1 page) — a measured overflow, which (unlike the
        // underfill the original live deadlock measured) still reopens the
        // review today, and isolates the reopen to a pure résumé edit exactly
        // like the original repro.
        __setLocalAiRenderPdfForTests(async (html) => {
          const isResume = html.includes('Maintained internal systems with supported delivery practices.');
          return { bytes, pageCount: isResume ? 2 : 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: isResume ? 1080 : 400, typeAreaHeightPx: 800 } };
        });
        const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
        __setLocalAiRenderPdfForTests(null);
        assert(imported.status === 'revision-required' && imported.handoff?.stage === 'review',
          `the measured overflow must reopen the review: ${JSON.stringify(imported)}`);

        const reopened = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        assert(reopened.handoffCode !== passingReviewHandoffCode, 'the reopening must mint a fresh code rather than reuse the one that just passed');
        assert(JSON.stringify(reopened.baseHashes) === JSON.stringify(preRevisionBaseHashes),
          'a fit revision measures the rendered PDF only; it must not change baseHashes, because no document was edited');

        // The materially revised, otherwise-correct answer — echoing the
        // STALE pre-revision code instead of the freshly reopened one, the
        // measured failure mode.
        const revisedResume = structuredClone(firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const staleEcho = review(reopened, { resume: revisedResume, coverLetter: letter, decision: 'revised', findings: [{ id: 'fit-1', document: 'resume', targetId: 'document', issue: 'Measured 2 pages; target is 1.', fix: 'Edit the résumé to satisfy the measured page target while retaining supported evidence.' }] });
        delete staleEcho.coverLetter; // unchanged from the accepted letter; a "revised" response may omit an untouched document
        staleEcho.handoffCode = passingReviewHandoffCode;
        const toleratedResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: reopened.handoffCode, response: JSON.stringify(staleEcho) });
        assert(toleratedResult.accepted,
          `a stale-but-otherwise-correct echo of the just-finished round's own code must be ACCEPTED, not deadlocked (errors=${JSON.stringify(toleratedResult.validationErrors)})`);

        const manifestAfterTolerated = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        assert(manifestAfterTolerated.paste.handoffCode !== passingReviewHandoffCode
          && manifestAfterTolerated.paste.handoffCode === toleratedResult.handoff.handoffCode,
        'the persisted state must carry the CURRENT rotated code, never the stale one the response echoed');

        const diagnostics = getPasteHandoffDiagnosticsSnapshot().receipts;
        assert(diagnostics.some(receipt => receipt.outcome === 'accepted' && receipt.reason === 'STALE_ECHO_TOLERATED'),
          `the acceptance must record a STALE_ECHO_TOLERATED diagnostic so this silent repair stays observable (${JSON.stringify(diagnostics)})`);

        // A code this job never minted at all — not a rotation this job ever
        // issued — must still be rejected, and the rejection must name the
        // action that actually works.
        const currentHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const foreignEcho = review(currentHandoff, { resume: revisedResume, coverLetter: letter, decision: 'revised', findings: [] });
        delete foreignEcho.coverLetter;
        foreignEcho.handoffCode = 'this-code-was-never-issued-by-this-job';
        const foreignResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: currentHandoff.handoffCode, response: JSON.stringify(foreignEcho) });
        assert(!foreignResult.accepted, 'a handoffCode this job never issued at all must still be rejected');
        assert(foreignResult.validationErrors.some(message => /Start a fresh chat with the full prompt this handoff just printed/.test(message)),
          `the rejection must name the action that actually works (errors=${JSON.stringify(foreignResult.validationErrors)})`);
        return { tolerated: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];

// --- THE STALE BASELINE and THE UNVERIFIABLE SET (2026-09-22 adversarial
// review of pasteReviewDelta.js's own delta mechanism; see that file's
// header) — end-to-end coverage against the real submitLocalApplicationHandoff,
// the tier this file's own header reserves for delta-round coverage while
// paste-review-delta.js exercises the merge engine's pure functions in
// isolation.
const staleBaselineAndUnverifiableFieldTests = [
  {
    // FLAW 1 (pasteReviewDelta.js's header, "THE BASELINE CAN GO STALE"):
    // finalReview was written on decision:'pass' ONLY, so a 'revised'
    // round's own fresh, doc-accurate qualityReview.resume rationale was
    // discarded rather than becoming the NEXT round's baseline. A later
    // round that changed nothing of its OWN (patches:[]) then measured
    // staleness against whichever review the LAST PASS produced —
    // arbitrarily many rounds back — rather than against the
    // immediately-prior round, and shipped a rationale describing a résumé
    // bullet that no longer existed. Reproduced end to end against this same
    // submitLocalApplicationHandoff and confirmed by reading the final
    // manifest.json (scratchpad repro-stale-rationale.mjs, preserved for
    // this task); running that exact script against the PRE-FIX module
    // reaches "BUG CONFIRMED" (the ORIGINAL rationale ships) — verified by
    // running it before this fix landed — and against the FIXED module
    // reaches "SAFE" (round A's fresh rationale ships), which is what this
    // permanent test asserts below.
    //
    // A NOTE ON WHAT "REJECTED" MEANS HERE, worth stating plainly because it
    // is easy to expect the wrong round to be the one that fails closed:
    // once round A (the 'revised' round that patches the résumé) is
    // ACCEPTED, Part 1a's refresh makes state.reviewBaseline describe round
    // A's OWN output — the résumé exactly as round A left it. Round B's
    // empty patch list changes nothing further, so the résumé it is judged
    // against (round A's) is NOT stale relative to that now-current
    // baseline: staleSinceBaseline.resume is genuinely false for round B,
    // by construction, the same way it would be for any ordinary
    // no-op-patch pass. Carrying round A's ALREADY-FRESH, ALREADY-ACCURATE
    // rationale forward into round B is therefore the CORRECT behavior, not
    // a hole — it is exactly what fixes Flaw 1's stated defect ("the job
    // completes shipping a rationale that describes a document state that
    // no longer exists"): the rationale that ships (round A's) DOES
    // describe the current document. The round that fails closed in this
    // chain is round A itself, when IT tries to omit qualityReview.resume
    // while genuinely stale relative to R0 — asserted first, below — not
    // round B, which inherits an already-correct baseline. Rejecting round
    // B in addition would require NOT refreshing the baseline on a
    // 'revised' round, which is the exact overload of finalReview Part 1a
    // was written to stop doing.
    name: 'THE STALE BASELINE: a later empty-patch pass ships the immediately-prior round\'s fresh qualityReview.resume rationale, never an older round\'s superseded one',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-stale-baseline-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath, careerData,
          job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
        });
        let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const evidence = reply(handoff, {
          identity,
          evidence: [
            { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
        });
        let r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
        assert(r.accepted, `evidence plan must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
        assert(r.accepted, `résumé must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
        assert(r.accepted, `cover letter must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const originalRationale = 'ORIGINAL: the résumé bullet supports internal systems delivery with direct source evidence.';
        const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: firstResume, coverLetter: letter, resumeRationale: originalRationale })) });
        assert(initialPass.accepted && initialPass.completed, `the initial review must pass: ${(initialPass.validationErrors || []).join(' | ')}`);

        // Force a measured-fit reopen for the RÉSUMÉ ONLY (both renders
        // report 1 page, so only the résumé's measured overflow trips the
        // reopen) — isolating round A to a pure résumé edit, exactly like
        // the original repro.
        const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        __setLocalAiRenderPdfForTests(async (html) => {
          const isResume = html.includes('Maintained internal systems with supported delivery practices.');
          return { bytes, pageCount: isResume ? 2 : 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: isResume ? 760 : 380, typeAreaHeightPx: 800 } };
        });
        const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
        __setLocalAiRenderPdfForTests(null);
        assert(imported.status === 'revision-required' && imported.handoff?.stage === 'review', `the measured overflow must reopen the review: ${JSON.stringify(imported)}`);

        // ROUND A, first attempt: a delta that patches the résumé bullet
        // but OMITS qualityReview.resume. The résumé is genuinely stale
        // relative to R0 (the only baseline that exists so far), so this
        // must be REJECTED, naming the field — the "fails closed when
        // genuinely stale" half of this fix.
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const revisedResume = structuredClone(firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const roundAPatch = [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } }];
        const roundAFindings = [{ id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured type-area utilization is below the target.', fix: 'Add distinct, source-supported résumé evidence.' }];
        const { resume: _roundAResumeOmitted, coverLetter: _roundACoverLetterOmitted, qualityReview: fullRoundAQuality, ...roundAOmitted } = review(handoff, {
          resume: revisedResume, coverLetter: letter, decision: 'revised', findings: roundAFindings,
        });
        const { resume: _omittedResumeReview, ...qualityReviewWithoutResume } = fullRoundAQuality;
        roundAOmitted.qualityReview = qualityReviewWithoutResume;
        roundAOmitted.patches = roundAPatch;
        const roundAOmittedResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(roundAOmitted) });
        assert(!roundAOmittedResult.accepted, `round A must be REJECTED for omitting qualityReview.resume while genuinely stale relative to R0: ${JSON.stringify(roundAOmittedResult)}`);
        assert(roundAOmittedResult.validationErrors.some(message => /qualityReview\.resume/.test(message)),
          `the rejection must name qualityReview.resume: ${JSON.stringify(roundAOmittedResult.validationErrors)}`);

        // ROUND A, retry: same patch, qualityReview.resume supplied fresh —
        // accepted. The rejection above never rotated the handoff code, so
        // the same round is simply resubmitted fixed.
        const freshRationale = 'ROUND-A-FRESH: the résumé bullet now reads reliable internal systems, still source-supported by the same evidence.';
        const fullRoundA = review(handoff, {
          resume: revisedResume, coverLetter: letter, decision: 'revised', findings: roundAFindings, resumeRationale: freshRationale,
        });
        const { resume: _roundAResume, coverLetter: _roundACoverLetter, ...roundA } = fullRoundA;
        roundA.patches = roundAPatch;
        const roundAResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(roundA) });
        assert(roundAResult.accepted && !roundAResult.completed, `round A (revised), qualityReview.resume supplied fresh, must be accepted and stay in review: ${JSON.stringify(roundAResult.validationErrors)}`);

        // ROUND B: passes with an EMPTY patch list — changes NEITHER
        // document — and OMITS qualityReview.resume entirely. Before this
        // fix, `changed` (patch-level, both false for this round) demanded
        // nothing, and the merge carried forward whatever state.finalReview
        // held — which round A's decision:'revised' never wrote, so it was
        // still R0's ORIGINAL rationale (this is Flaw 1 exactly). After the
        // fix, round A's acceptance already refreshed state.reviewBaseline
        // to describe round A's own (current) résumé, so round B's
        // untouched résumé is correctly measured as NOT stale relative to
        // THAT baseline — see the header comment above this test for why
        // this is the fix, not a gap. This is accepted, and it is round A's
        // rationale, never R0's, that must ship.
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const roundBOmitted = reply(handoff, { decision: 'pass', findings: [], patches: [] });
        const roundBResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(roundBOmitted) });
        assert(roundBResult.accepted && roundBResult.completed, `round B (empty patches, omitting qualityReview.resume) must be accepted and complete once round A already refreshed the baseline: ${JSON.stringify(roundBResult.validationErrors)}`);

        const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        const finalRationale = manifest.paste.finalReview?.qualityReview?.resume?.rationale;
        assert(finalRationale === freshRationale,
          `the final accepted review must carry round A's fresh rationale — the immediately-prior round's baseline — never R0's original: got ${JSON.stringify(finalRationale)}`);
        assert(finalRationale !== originalRationale, 'the ORIGINAL (pre-round-A) rationale must never ship once the résumé it described has changed');
        assert(manifest.paste.resume.roles[0].bullets[0].text === revisedResume.roles[0].bullets[0].text,
          'the final résumé must be round A\'s revised bullet, which the rationale above describes');
        return { rejectedGenuineStaleness: true, safeCarryForwardFromFreshBaseline: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // FLAW 2a: generationAudit.jobPriorities cannot be merged per
    // requirement once either document is stale — a disposition may
    // address either document regardless of which one a patch touched — so
    // a resupply must cover every requirement the baseline already covered.
    // 'Cross-team collaboration' is backed by job-listing evidence only (no
    // career-data quote), so the accepted plan legitimately dispositions it
    // 'omitted-no-evidence' without touching either document — isolating
    // this test to the coverage gate alone, not a résumé/letter defect.
    name: 'A delta that patches the résumé and resupplies generationAudit.jobPriorities without covering a requirement the baseline covered is rejected naming it',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-job-priorities-coverage-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath, careerData,
          job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery and cross-team collaboration.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
        });
        let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const evidence = reply(handoff, {
          identity,
          evidence: [
            { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'job-proof-2', sourceId: 'job-listing', quote: 'cross-team collaboration', requirement: 'Cross-team collaboration', priority: 'supporting' },
          ],
          requirements: [
            { id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] },
            { id: 'need-2', text: 'Cross-team collaboration', priority: 'supporting', evidenceIds: ['job-proof-2'] },
          ],
        });
        let r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
        assert(r.accepted, `evidence plan must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
        assert(r.accepted, `résumé must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
        assert(r.accepted, `cover letter must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        // Two-requirement generationAudit — the shape a real writer sends
        // once the accepted plan carries more than one requirement; the
        // shared audit() helper above only ever carries one.
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const proof0 = letter.paragraphs[0].text.split(/(?<=\.)\s+/u)[1];
        const twoRequirementAudit = {
          ...audit(letter.paragraphs[0].text, letter.roleThesis, proof0),
          jobPriorities: [
            { requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both', justification: 'The selected systems evidence directly addresses the stated delivery requirement.' },
            { requirement: 'Cross-team collaboration', priority: 'supporting', disposition: 'omitted-no-evidence', justification: 'The accepted plan backs this requirement with job-listing evidence only; no career-data quote grounds it in either document.' },
          ],
        };
        const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, {
          decision: 'pass', findings: [], checklist: checklist(),
          qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: criteria(), resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' } },
          generationAudit: twoRequirementAudit,
        })) });
        assert(initialPass.accepted && initialPass.completed, `the initial review must pass: ${(initialPass.validationErrors || []).join(' | ')}`);

        // Force a measured-fit reopen for the résumé.
        const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        __setLocalAiRenderPdfForTests(async (html) => {
          const isResume = html.includes('Maintained internal systems with supported delivery practices.');
          return { bytes, pageCount: isResume ? 2 : 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: isResume ? 760 : 380, typeAreaHeightPx: 800 } };
        });
        const imported = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
        __setLocalAiRenderPdfForTests(null);
        assert(imported.status === 'revision-required' && imported.handoff?.stage === 'review', `the measured overflow must reopen the review: ${JSON.stringify(imported)}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const revisedResume = structuredClone(firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const baseRound = {
          decision: 'revised',
          findings: [{ id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured overflow.', fix: 'Tighten the bullet.' }],
          checklist: checklist(),
          qualityReview: { criteria: criteria(), resume: { decision: 'approved', rationale: 'Updated: the résumé still preserves direct source-supported systems evidence.' } },
          generationAudit: {
            resumePlan: { strategy: 'Updated strategy text.', selectionRationale: 'Updated selection rationale.' },
            finalDecisionSummary: 'Updated: the final documents still use the strongest supported evidence.',
          },
          patches: [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } }],
        };

        // Résumé changed, but the resupplied jobPriorities OMITS
        // 'Cross-team collaboration' — a requirement the accepted baseline
        // already covered — even though nothing about that requirement's
        // own (no-evidence) disposition could have been invalidated by this
        // patch. The coverage gate demands it anyway: jobPriorities is
        // resupplied whole or not at all, never per-requirement.
        const incomplete = reply(handoff, { ...baseRound, generationAudit: { ...baseRound.generationAudit, jobPriorities: [{ requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed against the tightened bullet.' }] } });
        const result = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(incomplete) });
        assert(!result.accepted, `a jobPriorities resupply that drops a requirement the baseline covered must be rejected: ${JSON.stringify(result)}`);
        assert(result.validationErrors.some(message => /jobPriorities/.test(message) && /Cross-team collaboration/.test(message)),
          `the rejection must name the uncovered requirement: ${JSON.stringify(result.validationErrors)}`);

        // Covering both requirements is accepted.
        const complete = reply(handoff, {
          ...baseRound,
          generationAudit: {
            ...baseRound.generationAudit,
            jobPriorities: [
              { requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both', justification: 'Re-confirmed against the tightened bullet.' },
              { requirement: 'Cross-team collaboration', priority: 'supporting', disposition: 'omitted-no-evidence', justification: 'The accepted plan backs this requirement with job-listing evidence only; still no career-data quote grounds it in either document.' },
            ],
          },
        });
        const fixedResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(complete) });
        assert(fixedResult.accepted, `covering every baseline requirement must be accepted: ${JSON.stringify(fixedResult.validationErrors)}`);
        return { rejectedIncompleteCoverage: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // FLAW 2b: generationAudit.finalDecisionSummary describes BOTH
    // documents and the overall decision, so a patch to either one
    // invalidates it, and no needs* field even asked for it before this fix.
    name: 'A delta that changes a document and omits generationAudit.finalDecisionSummary is rejected',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-final-decision-summary-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const job = await buildReopenedReviewJob(canvasFilePath);

        const revisedResume = structuredClone(job.firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const revisedLetter = structuredClone(job.letter);
        revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
        revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
        const findings = [
          { id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured overflow.', fix: 'Tighten the bullet.' },
          { id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' },
        ];
        const fullShaped = review(job.handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const { resume: _r, coverLetter: _c, generationAudit: fullGenerationAudit, ...deltaResponse } = fullShaped;
        const { finalDecisionSummary: _omitted, ...generationAuditWithoutSummary } = fullGenerationAudit;
        deltaResponse.generationAudit = generationAuditWithoutSummary;
        deltaResponse.patches = [
          { op: 'replace', target: 'resume:bullet:bullet-1', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } },
          { op: 'replace', target: 'coverLetter:paragraph:paragraph-1', value: { text: revisedLetter.paragraphs[0].text, evidenceIds: revisedLetter.paragraphs[0].evidenceIds } },
          { op: 'replace', target: 'coverLetter:argument:primaryEvidence.evidence', value: revisedLetter.coverLetterArgument.primaryEvidence.evidence },
        ];
        const result = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: job.handoff.handoffCode, response: JSON.stringify(deltaResponse) });
        assert(!result.accepted, `a delta omitting finalDecisionSummary once a document changed must be rejected: ${JSON.stringify(result)}`);
        assert(result.validationErrors.some(message => /finalDecisionSummary/.test(message)),
          `the rejection must name finalDecisionSummary: ${JSON.stringify(result.validationErrors)}`);

        // Supplying it is accepted — the rejection above never rotated the
        // handoff code, so the same round can simply be resubmitted fixed.
        const fixedDelta = { ...deltaResponse, generationAudit: { ...generationAuditWithoutSummary, finalDecisionSummary: 'Updated: the final documents still use the strongest supported evidence without introducing a second cover-letter argument.' } };
        const fixedResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: job.handoff.handoffCode, response: JSON.stringify(fixedDelta) });
        assert(fixedResult.accepted, `supplying finalDecisionSummary must be accepted: ${JSON.stringify(fixedResult.validationErrors)}`);
        return { rejectedMissingSummary: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // FINDING B (2026-09-22 adversarial review, MINOR): validatePasteResponse
    // requires generationAudit/qualityReview only for decision:'pass', so a
    // FULL (non-delta) 'revised' round is free to omit both entirely. The
    // baseline that round mints then has five slots (resumePlan,
    // jobPriorities, finalDecisionSummary, qualityReview.resume,
    // qualityReview.coverLetter) with no value at all, even though NEITHER
    // document is stale relative to that same baseline. Before this fix,
    // requiredPasteReviewDeltaEntries asked staleSinceBaseline alone, so the
    // NEXT round's printed contract said "omit it, nothing changed" for a
    // slot mergePasteReviewDelta's own null-check was always going to
    // refuse regardless — a round rejected for a field its own contract
    // never asked for, end to end against the real submitLocalApplicationHandoff.
    name: 'FINDING B: a full revised round that omits generationAudit/qualityReview leaves the next delta round told to resupply them, and rejects a delta that follows the stale-only rule instead',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-baseline-missing-audit-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const job = await buildReopenedReviewJob(canvasFilePath);

        // ROUND A: a FULL revised round (no `patches` field — the
        // non-delta path) that replaces both documents the reopen requires,
        // but supplies neither generationAudit nor qualityReview's own
        // resume/coverLetter rationales — legal per validatePasteResponse's
        // own review-stage branch, which gates every one of these fields on
        // decision:'pass' only. qualityReview.criteria/checklistVersion are
        // kept intact: that array is the SIXTH unverifiable field
        // (pasteReviewDelta.js's header) with its OWN, separately-scoped
        // backstop (mergeGradedCriteria, keyed on criterionIds/`changed`,
        // never on needs*) — orthogonal to FINDING B, which names only
        // resumePlan/jobPriorities/finalDecisionSummary/qualityReview.resume
        // /qualityReview.coverLetter, so this test omits exactly those five.
        const revisedResume = structuredClone(job.firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const revisedLetter = structuredClone(job.letter);
        revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
        revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
        const findings = [
          { id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured overflow.', fix: 'Tighten the bullet.' },
          { id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' },
        ];
        const fullShaped = review(job.handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const { generationAudit: _omittedAudit, qualityReview: fullQuality, ...roundAWithoutAudit } = fullShaped;
        const { resume: _omittedResumeReview, coverLetter: _omittedCoverReview, ...qualityReviewWithoutRationales } = fullQuality;
        const roundA = { ...roundAWithoutAudit, qualityReview: qualityReviewWithoutRationales };
        const roundAResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: job.handoff.handoffCode, response: JSON.stringify(roundA) });
        assert(roundAResult.accepted && !roundAResult.completed,
          `a full revised round omitting generationAudit/qualityReview must be legal and stay in review: ${JSON.stringify(roundAResult.validationErrors)}`);

        // Confirm the setup: the baseline this round minted really has none
        // of the five fields — proving the next round's demand below comes
        // from FINDING B's fix, not from ordinary staleness.
        const manifestAfterRoundA = JSON.parse(await fs.promises.readFile(path.join(job.dir, 'manifest.json'), 'utf8'));
        const baselineReview = manifestAfterRoundA.paste.reviewBaseline?.review;
        assert(baselineReview && baselineReview.generationAudit == null
          && baselineReview.qualityReview?.resume == null && baselineReview.qualityReview?.coverLetter == null,
          `round A's baseline must have none of the five FINDING-B fields: ${JSON.stringify(baselineReview)}`);

        // ROUND B's prompt: both fit findings are already answered by round
        // A's replacement documents, so nothing is textually stale or
        // patch-touched for round B. The prompt must still say every
        // UNVERIFIABLE-SET field must be resupplied — never "omit it,
        // nothing changed" — because the baseline has nothing to carry
        // forward for any of them.
        const handoffForRoundB = (await getLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath })).handoff;
        const prompt = handoffForRoundB.prompt;
        assert(prompt.includes('generationAudit.resumePlan must be resupplied'), 'the prompt must demand resumePlan even though nothing is stale');
        assert(prompt.includes('generationAudit.jobPriorities must be resupplied WHOLE'), 'the prompt must demand jobPriorities even though nothing is stale');
        assert(prompt.includes('generationAudit.finalDecisionSummary must be resupplied'), 'the prompt must demand finalDecisionSummary even though nothing is stale');
        assert(prompt.includes('qualityReview.resume and qualityReview.coverLetter must both be resupplied'), 'the prompt must demand both quality rationales even though nothing is stale');
        assert(!prompt.includes('Omit generationAudit.resumePlan unless a patch changes the résumé'),
          'the prompt must not tell a writer to omit resumePlan when the baseline has none to carry forward');

        // A delta that follows the OLD, stale-only rule — patches neither
        // document, supplies none of the five fields, since "nothing
        // changed" — must be REJECTED, and rejected by the SAME gate the
        // prompt above just warned about (missingPasteReviewDeltaEntries,
        // run before the expensive merge/validation battery), never by a
        // different, unrequested field.
        const staleOnlyDelta = { ...reply(handoffForRoundB, { decision: 'pass', findings: [] }), patches: [] };
        const staleOnlyResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: handoffForRoundB.handoffCode, response: JSON.stringify(staleOnlyDelta) });
        assert(!staleOnlyResult.accepted, `a delta that omits every field the prompt demanded must be rejected: ${JSON.stringify(staleOnlyResult)}`);
        for (const field of ['generationAudit.resumePlan', 'generationAudit.jobPriorities', 'generationAudit.finalDecisionSummary', 'qualityReview.resume', 'qualityReview.coverLetter']) {
          assert(staleOnlyResult.validationErrors.some(message => message.includes(field)),
            `the rejection must name ${field} — exactly what the prompt asked for, nothing else: ${JSON.stringify(staleOnlyResult.validationErrors)}`);
        }

        // Resupplying exactly what the prompt demanded — an empty patch
        // list, both documents untouched — is accepted and completes: the
        // prompt/gate agreement this fix exists for.
        // Note what this DOESN'T resupply: checklist and qualityReview.criteria
        // carry forward from round A's baseline byte for byte (they were
        // never omitted there), proving this fix costs nothing beyond the
        // five fields it actually names.
        const compliantDelta = {
          ...reply(handoffForRoundB, { decision: 'pass', findings: [] }),
          patches: [],
          qualityReview: {
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: audit(revisedLetter.paragraphs[0].text, revisedLetter.roleThesis, revisedLetter.paragraphs[0].text.split(/(?<=\.)\s+/u)[1]),
        };
        const compliantResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: handoffForRoundB.handoffCode, response: JSON.stringify(compliantDelta) });
        assert(compliantResult.accepted && compliantResult.completed,
          `supplying exactly what the prompt demanded must be accepted and complete: ${JSON.stringify(compliantResult.validationErrors)}`);
        return { promptDemandedResupply: true, rejectedStaleOnlyDelta: true, compliantDeltaCompleted: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    // THE DEFECT (found independently by two reviewers, confirmed by reading
    // the code; pasteReviewDelta.js's mergeGradedCriteria): unlike the five
    // FINDING-B fields directly above, qualityReview.criteria SHIPS in the
    // assembled result and has its OWN backstop — but that backstop sourced
    // its merged array's id list from the baseline's own (possibly totally
    // absent) qualityReview.criteria instead of the canonical catalog, so a
    // baseline minted by a 'revised' round that omitted qualityReview
    // ENTIRELY (unlike FINDING B's round A, which keeps criteria intact and
    // drops only the two rationale sub-fields) collapsed the merge to an
    // EMPTY array no matter what the next delta supplied — rejected by
    // validatePasteResponse's "every canonical criterion, in order" gate for
    // a shape nothing in the printed prompt contract ever named. Reproduced
    // end to end against the real submitLocalApplicationHandoff so the fix is
    // proven where it actually matters: a live handoff round is never
    // rejected by a rule it was never told.
    name: 'THE DEFECT: a full revised round that omits qualityReview entirely leaves the next delta round told to resupply every canonical criterion, and a compliant delta completes the job',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-baseline-missing-criteria-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const job = await buildReopenedReviewJob(canvasFilePath);

        // ROUND A: a FULL revised round that replaces both documents the
        // reopen requires, but drops qualityReview AND generationAudit
        // WHOLESALE — legal per validatePasteResponse's review-stage branch,
        // which gates the entire qualityReview object (criteria included) on
        // decision:'pass' only.
        const revisedResume = structuredClone(job.firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const revisedLetter = structuredClone(job.letter);
        revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated those systems for internal users and kept them reliable. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
        revisedLetter.coverLetterArgument.primaryEvidence.evidence = 'Maintained reliable internal systems with supported delivery practices.';
        const findings = [
          { id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured overflow.', fix: 'Tighten the bullet.' },
          { id: 'fit-2', document: 'coverLetter', targetId: 'paragraph-1', issue: 'Keep the letter evidence aligned with the revised résumé bullet.', fix: 'Use the same supported reliable-systems wording.' },
        ];
        const fullShaped = review(job.handoff, { resume: revisedResume, coverLetter: revisedLetter, decision: 'revised', findings });
        const { generationAudit: _omittedAudit, qualityReview: _omittedQuality, ...roundA } = fullShaped;
        const roundAResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: job.handoff.handoffCode, response: JSON.stringify(roundA) });
        assert(roundAResult.accepted && !roundAResult.completed,
          `a full revised round omitting qualityReview entirely must be legal and stay in review: ${JSON.stringify(roundAResult.validationErrors)}`);

        // Confirm the setup: round A's baseline carries no qualityReview at
        // all, so `criterionIds` below comes from THIS fix, not ordinary
        // staleness.
        const manifestAfterRoundA = JSON.parse(await fs.promises.readFile(path.join(job.dir, 'manifest.json'), 'utf8'));
        const baselineReview = manifestAfterRoundA.paste.reviewBaseline?.review;
        assert(baselineReview && baselineReview.qualityReview == null,
          `round A's baseline must carry no qualityReview at all: ${JSON.stringify(baselineReview?.qualityReview)}`);

        // ROUND B's prompt: both fit findings are already answered by round
        // A's replacement documents, so nothing is stale or patch-touched —
        // the exact shape that used to print "both may be omitted entirely"
        // for qualityReview.criteria too. The fixed prompt must instead
        // demand every canonical criterion id by name.
        const handoffForRoundB = (await getLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath })).handoff;
        const prompt = handoffForRoundB.prompt;
        assert(prompt.includes('qualityReview.criteria entries for exactly these ids'),
          'the prompt must demand qualityReview.criteria even though nothing is stale or patch-touched');
        for (const criterion of APPLICATION_QUALITY_CRITERIA) {
          assert(prompt.includes(JSON.stringify(criterion.id)), `the prompt must name canonical criterion ${JSON.stringify(criterion.id)} as required`);
        }
        assert(!prompt.includes('so both may be omitted entirely'),
          'the prompt must not tell a writer qualityReview.criteria may be omitted when the baseline has no entries at all to carry forward');

        // A delta that follows the OLD, buggy rule — omit qualityReview.criteria
        // because nothing changed — must be REJECTED, naming the missing ids,
        // never silently merged to an empty array.
        const staleOnlyDelta = { ...reply(handoffForRoundB, { decision: 'pass', findings: [] }), patches: [] };
        const staleOnlyResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: handoffForRoundB.handoffCode, response: JSON.stringify(staleOnlyDelta) });
        assert(!staleOnlyResult.accepted, `a delta that omits qualityReview.criteria entirely must be rejected: ${JSON.stringify(staleOnlyResult)}`);
        assert(staleOnlyResult.validationErrors.some(message => message.includes('qualityReview.criteria')),
          `the rejection must name qualityReview.criteria among its errors: ${JSON.stringify(staleOnlyResult.validationErrors)}`);

        // Resupplying exactly what the prompt demanded — the full canonical
        // criteria list, plus the rest of a normal passing review — is
        // accepted and completes the job: the round is never wasted.
        const compliantDelta = {
          ...reply(handoffForRoundB, { decision: 'pass', findings: [] }),
          patches: [],
          qualityReview: {
            checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
            criteria: criteria(),
            resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
            coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
          },
          generationAudit: audit(revisedLetter.paragraphs[0].text, revisedLetter.roleThesis, revisedLetter.paragraphs[0].text.split(/(?<=\.)\s+/u)[1]),
        };
        const compliantResult = await submitLocalApplicationHandoff({ jobId: job.queued.id, canvasFilePath, handoffCode: handoffForRoundB.handoffCode, response: JSON.stringify(compliantDelta) });
        assert(compliantResult.accepted && compliantResult.completed,
          `supplying exactly what the prompt demanded must be accepted and complete: ${JSON.stringify(compliantResult.validationErrors)}`);
        return { promptDemandedCriteria: true, rejectedStaleOnlyDelta: true, compliantDeltaCompleted: true };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];

// --- THE DOCUMENT IDENTITY HASH (2026-09-23 adversarial review of the delta
// work; MINOR but hard-erroring finding, reproduced live in
// scripts/repro-finding-a.mjs before this fix and preserved here as a
// permanent regression): stampPasteQualityReviewFromFit (run on a decision:
// 'pass') and assertLocalAiQualityReviewConsistency (run on the next import)
// answered "did this document change since the prior measured cycle" from
// TWO DIFFERENT REPRESENTATIONS of the SAME completed package.
// stampPasteQualityReviewFromFit hashed assemblePasteApplicationResult's raw,
// about-to-be-written coverLetter (flat: name/contact/salutation/…/paragraphs
// as plain strings); assertLocalAiQualityReviewConsistency hashed
// validateLocalApplicationResult's coverLetter, which
// authorLocalCoverLetterEnvelope rebuilds with today's date plus
// résumé/job-derived tagline/subtitleRole/credential/salutation/closing —
// keys the flat form never carries at all, so the two hashes could never
// agree even when the candidate's letter was byte-for-byte unchanged. The
// résumé side had the identical hazard one level down: raw resumeMainHtml vs
// sanitizeResumeMainHtml's JSDOM-reserialized copy, which does not reproduce
// a hand-built HTML string's void-element/attribute syntax byte-for-byte. A
// two-reopen chain that only ever touches the résumé exposes it: round 0
// passes, a measured overflow reopens review (reopen #1), a round that
// revises ONLY the résumé passes, and the NEXT import (reopen #2's own
// consistency check) rehashes the untouched cover letter correctly, finds
// the stamped 'changed_materially' decision its own (matching) hashes could
// not justify, and hard-throws — ending a job that needed nothing but a
// second résumé pass. The fix: both comparisons now hash the RAW completed
// package (parseCompletedPackage's output, the exact bytes stampPasteQuality
// ReviewFromFit already stamped and wrote to result.json) instead of either
// reprocessed form — see localAiApplication.js's assertLocalAiQualityReview
// Consistency comment.
const documentIdentityHashTests = [
  {
    name: 'THE DOCUMENT IDENTITY HASH: two measured-fit reopenings that change only the résumé stamp the untouched cover letter kept_diminishing_returns and never throw',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-document-identity-hash-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath, careerData,
          job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable system delivery.' },
          resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '' }] },
        });
        let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const evidence = reply(handoff, {
          identity,
          evidence: [
            { id: 'resume-proof', sourceId: 'career-data', quote: 'Maintained internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'revision-proof', sourceId: 'career-data', quote: 'Maintained reliable internal systems with supported delivery practices.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'letter-proof', sourceId: 'career-data', quote: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
            { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
          ],
          requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
        });
        let r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(evidence) });
        assert(r.accepted, `evidence plan must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const firstResume = { schemaVersion: 'structured-resume.v1', identity, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Maintained internal systems with supported delivery practices.', evidenceIds: ['resume-proof'] }] }] };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { resume: firstResume })) });
        assert(r.accepted, `résumé must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const letter = { name: identity.name, contact: identity.contact, paragraphs: [{ id: 'paragraph-1', text: 'My experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.', evidenceIds: ['letter-proof', 'job-proof'] }], roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.', coverLetterArgument: { primaryEvidence: { evidence: 'Maintained internal systems with supported delivery practices.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } } };
        r = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(reply(handoff, { coverLetter: letter })) });
        assert(r.accepted, `cover letter must be accepted: ${(r.validationErrors || []).join(' | ')}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const initialPass = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(review(handoff, { resume: firstResume, coverLetter: letter })) });
        assert(initialPass.accepted && initialPass.completed, `the initial review must pass: ${(initialPass.validationErrors || []).join(' | ')}`);

        // Every résumé bullet variant measures as 2-page overflow; the cover
        // letter always measures fine at 1 page. The résumé never "recovers"
        // in this test on purpose — the point is that a SECOND reopen driven
        // entirely by the résumé must never throw over the untouched letter.
        const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        __setLocalAiRenderPdfForTests(async html => {
          const isResume = html.includes('systems with supported delivery practices.');
          return { bytes, pageCount: isResume ? 2 : 1, fontsLoaded: true, missingFontFaces: [], layout: { contentHeightPx: isResume ? 760 : 380, typeAreaHeightPx: 800 } };
        });
        const imported1 = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
        assert(imported1.status === 'revision-required' && imported1.handoff?.stage === 'review',
          `the measured overflow must produce reopen #1: ${JSON.stringify(imported1)}`);

        // Round 1: a delta that patches ONLY the résumé bullet. The cover
        // letter is never touched by this round's patches, so it stays
        // byte-identical to the letter round 0's pass accepted.
        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const revisedResume = structuredClone(firstResume);
        revisedResume.roles[0].bullets[0] = { id: 'bullet-1', text: 'Maintained reliable internal systems with supported delivery practices.', evidenceIds: ['revision-proof'] };
        const fullRound1 = review(handoff, {
          resume: revisedResume, coverLetter: letter, decision: 'revised',
          findings: [{ id: 'fit-1', document: 'resume', targetId: 'bullet-1', issue: 'Measured overflow requires a tighter bullet.', fix: 'Use the reliable-systems wording.' }],
        });
        const { resume: _round1Resume, coverLetter: _round1CoverLetter, ...round1Revised } = fullRound1;
        round1Revised.patches = [{ op: 'replace', target: 'resume:bullet:bullet-1', value: { text: revisedResume.roles[0].bullets[0].text, evidenceIds: revisedResume.roles[0].bullets[0].evidenceIds } }];
        const round1RevisedResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(round1Revised) });
        assert(round1RevisedResult.accepted && !round1RevisedResult.completed,
          `the résumé-only delta must be accepted and stay in review: ${JSON.stringify(round1RevisedResult.validationErrors)}`);

        handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath })).handoff;
        const round1Pass = { ...reply(handoff, { decision: 'pass', findings: [] }), patches: [] };
        const round1PassResult = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath, handoffCode: handoff.handoffCode, response: JSON.stringify(round1Pass) });
        assert(round1PassResult.accepted && round1PassResult.completed,
          `the résumé-only round's confirming pass must complete: ${JSON.stringify(round1PassResult.validationErrors)}`);

        // Reopen #2's own consistency check (this import call) is exactly
        // where the pre-fix code threw: it rehashes the still-overflowing
        // résumé (genuinely changed, no throw there) and the untouched cover
        // letter (genuinely unchanged) against round 0's stamped decisions.
        const imported2 = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath, senderId: 9911 });
        assert(imported2.status === 'revision-required' && imported2.handoff?.stage === 'review',
          `reopen #2 must succeed (not throw) and reopen review again since the résumé still overflows: ${JSON.stringify(imported2)}`);

        const feedback = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'fit-feedback.json'), 'utf8'));
        assert(feedback.qualityReview?.coverLetter?.decision === 'kept_diminishing_returns',
          `the untouched cover letter must be stamped kept_diminishing_returns, not changed_materially: got ${JSON.stringify(feedback.qualityReview?.coverLetter)}`);
        assert(feedback.qualityReview?.resume?.decision === 'changed_materially',
          `the genuinely revised résumé must still be stamped changed_materially: got ${JSON.stringify(feedback.qualityReview?.resume)}`);
        return { reopenedTwice: true, coverLetterDecision: feedback.qualityReview.coverLetter.decision };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
];

export default [...measuredFitSaveTests, ...deltaReviewTests, ...deadlockRegressionTests, ...staleBaselineAndUnverifiableFieldTests, ...documentIdentityHashTests];
