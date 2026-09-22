import { assert, fs, getLocalApplicationHandoff, importLocalApplicationJob, ipcMain, os, path, queueLocalApplicationJob, registerJobApplicationHandlers, registerPendingApplicationWorkspace, submitLocalApplicationHandoff } from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION, __setLocalAiRenderPdfForTests, localApplicationStatus } from '../../electron/ipc/localAiApplication.js';
import { PDFDocument } from '../test-dependencies.js';

const careerData = 'Ada Lovelace\nada@example.test\nEngineer\nMaintained internal systems with supported delivery practices.\nMaintained reliable internal systems with supported delivery practices.\nMy experience delivering supported systems is a relevant capability. In my engineering role at Acme, I updated supported systems for internal users. I would apply my experience delivering supported systems to reliable system delivery this role requires.\nMy experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated reliable supported systems for internal users. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.';
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

function review(handoff, { resume, coverLetter, decision = 'pass', findings = [] }) {
  const proof = coverLetter.paragraphs[0].text.split(/(?<=\.)\s+/u)[1];
  const finalAudit = audit(coverLetter.paragraphs[0].text, coverLetter.roleThesis, proof);
  return reply(handoff, {
    decision, findings, checklist: checklist(), resume: decision === 'revised' ? resume : undefined,
    coverLetter: decision === 'revised' ? coverLetter : undefined,
    qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: criteria(), resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' } },
    generationAudit: finalAudit,
  });
}

export default [{
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
          { id: 'revision-letter-proof', sourceId: 'career-data', quote: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated reliable supported systems for internal users. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', requirement: 'Reliable system delivery', priority: 'highest' },
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
      revisedLetter.paragraphs[0] = { id: 'paragraph-1', text: 'My experience delivering reliable supported systems is a relevant capability. In my engineering role at Acme, I updated reliable supported systems for internal users. I would apply my experience delivering reliable supported systems to reliable system delivery this role requires.', evidenceIds: ['revision-letter-proof', 'job-proof'] };
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
