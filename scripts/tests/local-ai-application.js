import crypto from 'node:crypto';
import { assert, assertCandidateDashPunctuation, assertSourceQuoteLinksFinalText, buildCoverLetterDocument, buildLocalGenerationAuditArtifact, buildResumeDocument, careerDataRoleLocation, sanitizeDocumentMainHtml, checkAnchorRelevance, checkDirectWelcomeClosing, checkPriorEmployerOpening, checkResumeBulletLength, evaluateResumeProseChecks, extractResumeEvidence, inspectApplicationExport, resumeProjectProvenanceFailures, resumeRoleBlockSample, resumeRoleLocationFailures, webFontFacesReadyExpression, canSaveImportedLocalApplication, discardLocalApplicationJob, discoverLocalApplicationJobs, ensureDirectoryWithinRoot, fs, ipcMain, isPendingApplicationWorkspaceSaveInFlight, JSDOM, os, path, PDFLib, LOCAL_AI_APPLICATION_VERSION, LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_FALLBACK_IDLE_STATUSES, collectNodesDeep, deepUpdateNode, importLocalApplicationJob, isJobCardMounted, localApplicationStatus, queueLocalApplicationJob, queuedLocalApplicationSettlement, readRegisteredApplicationArtifact, registerJobApplicationHandlers, registerMountedJobCard, registerPendingApplicationWorkspace, replacedLocalApplicationForCleanup, resolveLocalOutputBundleRoot, selectFallbackLocalAiJobs, selectOrphanedLocalAiJobs, unregisterMountedJobCard, validateLocalApplicationResult, withLocalAiJobPruneClaim, withUnregisteredApplicationWorkspacePruneClaim } from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION, __setLocalAiRenderPdfForTests, boundedRejectionError, localAiHandoffEvent, stageLocalApplicationWorkspaceArtifacts } from '../../electron/ipc/localAiApplication.js';
import { inspectLocalAiHandoff, waitForLocalAiHandoff } from '../../local_ai/wait-for-handoff.mjs';

async function createCanvasProject() {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-canvas-')));
  const canvasFilePath = path.join(root, 'My Canvas.json');
  await fs.promises.writeFile(canvasFilePath, '{"version":1}', 'utf8');
  return { root, canvasFilePath };
}

const QUALITY_NOTES = Object.freeze({
  'resume-source-grounding': 'Mapped every résumé claim to its supplied role, scope, attribution, and supporting career detail.',
  'resume-priority-alignment': 'Placed direct evidence for the role’s highest-priority engineering needs before supporting experience.',
  'resume-role-completeness': 'Retained each documented role with a factual highlight that preserves its distinct contribution.',
  'resume-evidence-quality': 'Selected concrete actions, decisions, outcomes, and differentiators instead of generic capability statements.',
  'resume-bullet-independence': 'Checked each bullet independently for an explicit system, actor, or other concrete referent.',
  'resume-concision': 'Removed redundant source wording while preserving the strongest job-relevant evidence and readable scanning order.',
  'resume-copy-editing': 'Reviewed grammar, compounds, parallel verbs, modifier attachment, and pronoun reference across résumé copy.',
  'resume-structure': 'Confirmed one bare page main plus valid peer sections, roles, and highlight-list structures.',
  'resume-ats-safety': 'Confirmed the final markup contains only parseable, visible, design-system-safe résumé content.',
  'cover-source-grounding': 'Traced every candidate claim in the letter to supplied evidence without expanding attribution or causality.',
  'cover-single-argument': 'Verified one delivery-focused throughline organizes the opening, proof, and closing without a second thesis.',
  'cover-minimum-evidence': 'Kept only the proof necessary to establish the argument and removed unrelated stack or background inventory.',
  'cover-priority-alignment': 'Connected the selected proof directly to an emphasized employer need rather than merely naming the job.',
  'cover-opening': 'Confirmed the first sentence adds a substantive evidence-to-need connection instead of application administration.',
  'cover-continuity': 'Checked that each paragraph advances the same claim with relevance stated before detail and that each within-paragraph responsibility shift names its shared responsibility, constraint, or outcome.',
  'cover-reference-clarity': 'Named employers, systems, actors, causal links, and time references, used a proximal target-position reference, and attached reporting verbs to source documents.',
  'cover-register': 'Used direct contemporary language, removed generic enthusiasm, bureaucratic phrasing, and advertisement-facing copy, and connected the final invitation to target work.',
  'cover-sentence-craft': 'Reviewed first-read literal clarity, concrete actors, artifacts, and actions, sentence length, grammar, parallel structure, and punctuation without semicolon or dash clause splices.',
  'cover-figure-discipline': 'Confirmed each retained figure is necessary and appears in the selected résumé evidence.',
  'cover-legal-status': 'Confirmed no application logistics or legal-work-status assertion appears in the letter.',
  'cover-envelope': 'Verified the host-owned name, contact, salutation, and closing fields contain no inferred envelope facts.',
  'cross-document-consistency': 'Compared résumé, letter, and argument contract for matching identity, terminology, scope, and factual claims.',
  'requirement-coverage': 'Accounted for each high-priority requirement with direct evidence or an honest evidence-bound omission.',
  'adversarial-final-review': 'Performed a final defect search for factual, relevance, clarity, structural, and compliance regressions.',
});

const passingApplicationQualityCriteria = () => APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({
  id,
  status: 'pass',
  evidence: QUALITY_NOTES[id],
}));

const draftedQualityReview = () => ({
  checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
  criteria: passingApplicationQualityCriteria(),
  resume: { decision: 'drafted', rationale: 'The fresh résumé passed a relevance, evidence, and factual-support review.' },
  coverLetter: { decision: 'drafted', rationale: 'The fresh cover letter preserves one controlling argument with minimum-sufficient evidence and passed factual-support review.' },
});

const validCoverLetterArgument = () => ({
  roleThesis: 'Reliable system delivery is the supported capability this engineering role needs.',
  primaryEvidence: {
    evidence: 'Built supported systems.',
    evidenceRole: 'Engineer at Acme',
    relationToThesis: 'The systems work establishes the delivery capability named in the thesis.',
  },
});

const coverLetterArgumentForResumeEvidence = (evidence, evidenceRole = 'Engineer at Acme') => ({
  ...validCoverLetterArgument(),
  primaryEvidence: {
    ...validCoverLetterArgument().primaryEvidence,
    evidence,
    evidenceRole,
  },
});

const normalizedCoverLetter = () => ({
  name: '', contact: [], salutation: '', recipient: '',
  paragraphs: ['A concise factual letter.'], closing: '', signatureTitle: '',
});

const auditSentences = (paragraph) => {
  const normalized = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(normalized)]
      .map(part => part.segment.replace(/\s+/g, ' ').trim()).filter(Boolean)
    : (normalized.match(/[^.!?]+(?:[.!?]+|$)/gu) || [normalized]).map(value => value.trim()).filter(Boolean);
};

const generationAuditFor = ({
  paragraphs = normalizedCoverLetter().paragraphs,
  controllingThesis = validCoverLetterArgument().roleThesis,
} = {}) => ({
  version: LOCAL_AI_GENERATION_AUDIT_VERSION,
  jobPriorities: [{
    requirement: 'Reliable delivery of supported systems',
    priority: 'highest',
    disposition: 'addressed-both',
    justification: 'The selected systems evidence is the strongest direct support for the emphasized delivery need.',
  }],
  resumePlan: {
    strategy: 'Lead with the strongest direct evidence and retain distinct support needed for credible breadth.',
    selectionRationale: 'The retained highlights prioritize interview value while preserving documented roles and source boundaries.',
  },
  coverLetterPlan: {
    controllingThesis,
    paragraphs: paragraphs.map((paragraph, paragraphIndex) => ({
      paragraph,
      argumentativeJob: paragraphIndex === 0
        ? 'Establish the controlling evidence-to-need connection.'
        : 'Develop the controlling argument with a distinct supported step.',
      relationToThesis: 'Connect this paragraph’s supported proof to the exact capability named in the thesis.',
      relationToPreviousParagraph: paragraphIndex === 0
        ? 'opening'
        : 'Develops the previous paragraph by adding a distinct supporting mechanism.',
      sentences: auditSentences(paragraph).map((sentence, sentenceIndex) => ({
        sentence,
        function: sentenceIndex === 0
          ? 'Establishes this paragraph’s argumentative direction.'
          : 'Adds the next concrete step in this paragraph’s proof.',
        relationToPreviousSentence: sentenceIndex === 0
          ? 'opening'
          : 'Develops the prior sentence by adding its next supported mechanism.',
      })),
    })),
  },
  finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
});

// The app validates these records only when it has the trusted queued career
// context. Keep fixture construction explicit so status/import tests exercise
// the same exact-text and exact-quote binding as production.
const sourceGroundingFor = ({
  resumeBullets = ['Built supported systems.'],
  coverLetterParagraphs = ['A concise factual letter.'],
  resumeQuotes = resumeBullets,
  coverLetterQuotes = coverLetterParagraphs,
} = {}) => ({
  resumeBullets: resumeBullets.map((bullet, index) => ({
    bullet,
    careerDataQuotes: [resumeQuotes[index] || resumeQuotes[0]],
  })),
  coverLetterParagraphs: coverLetterParagraphs.map((paragraph, index) => ({
    paragraph,
    careerDataQuotes: [coverLetterQuotes[index] || coverLetterQuotes[0]],
  })),
});

const groundedQualityReview = (sourceGrounding) => ({
  ...draftedQualityReview(),
  sourceGrounding,
});

const TRUSTED_QUEUE_CAREER_DATA = 'Built supported systems with clear outcomes, sustained ownership, and concrete engineering judgment.';

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

async function atomicReplaceJson(file, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(temporary, raw, 'utf8');
  await fs.promises.rename(temporary, file);
  return { raw, sha256: sha256(raw) };
}

const LOCAL_AI_TEST_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

export default [
  {
    name: 'Local AI handoff wait: terminal evidence beats a late deadline without result.json metadata',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-wait-')));
      const resultSha256 = 'a'.repeat(64);
      const jobFolder = path.join(root, 'jobs', LOCAL_AI_TEST_JOB_ID);
      const receiptFile = path.join(root, 'handoff-receipts', `${LOCAL_AI_TEST_JOB_ID}.json`);
      try {
        await fs.promises.mkdir(path.dirname(receiptFile), { recursive: true });
        await fs.promises.writeFile(receiptFile, JSON.stringify({
          version: 1, jobId: LOCAL_AI_TEST_JOB_ID, status: 'imported', resultSha256,
        }), 'utf8');
        const imported = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256,
          deadlineMs: 1,
        });
        assert(imported.outcome === 'imported',
          'a matching receipt wins even when the helper starts after its test deadline and result.json has already been deleted');

        await fs.promises.unlink(receiptFile);
        const folderGone = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256,
          deadlineMs: 1,
        });
        assert(folderGone.outcome === 'job-folder-gone-unconfirmed',
          'folder removal without a matching receipt is terminal but never treated as accepted work');

        await fs.promises.mkdir(jobFolder, { recursive: true });
        const missingResult = await inspectLocalAiHandoff({ jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256 });
        assert(missingResult.outcome === 'waiting',
          'a result disappearing during an active-folder poll is retriable rather than a failed stat/deadline calculation');
        const timedOut = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256,
          deadlineMs: 1,
        });
        assert(timedOut.outcome === 'timeout',
          'only an extant job with no terminal evidence reaches timeout');

        const resultRaw = '{"completed":true}\n';
        await fs.promises.writeFile(path.join(jobFolder, 'result.json'), resultRaw, 'utf8');
        const currentSha = sha256(resultRaw);
        await fs.promises.writeFile(path.join(jobFolder, 'fit-feedback.json'), JSON.stringify({
          jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha, status: 'revision-required', measured: true,
        }), 'utf8');
        const feedback = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha,
          deadlineMs: 1,
        });
        assert(feedback.outcome === 'revision-required',
          'only feedback for the exact current result becomes a measured revision outcome');
        await fs.promises.writeFile(path.join(jobFolder, 'fit-feedback.json'), JSON.stringify({
          jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha, status: 'render-retry-required', measured: false,
        }), 'utf8');
        const renderRetry = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha,
          deadlineMs: 1,
        });
        assert(renderRetry.outcome === 'render-retry-required',
          'matching app render-retry feedback ends the unbounded writer wait without misclassifying it as an AI revision');
        await fs.promises.writeFile(path.join(jobFolder, 'fit-feedback.json'), JSON.stringify({
          jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha, status: 'invalid', measured: false,
        }), 'utf8');
        const invalid = await inspectLocalAiHandoff({ jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha });
        assert(invalid.outcome === 'invalid',
          'matching non-measured validation feedback is surfaced directly for correction');
        for (const pollMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          const pollError = await waitForLocalAiHandoff({
            jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha,
            deadlineMs: 1, pollMs,
          }).then(() => null, error => error);
          assert(pollError?.message === 'pollMs must be a finite positive number.',
            `invalid pollMs (${String(pollMs)}) is rejected before the helper can busy-loop`);
        }
        await fs.promises.writeFile(path.join(jobFolder, 'fit-feedback.json'), JSON.stringify({
          jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha, status: 'revision-required', measured: true,
        }), 'utf8');
        await fs.promises.writeFile(receiptFile, JSON.stringify({
          version: 1, jobId: LOCAL_AI_TEST_JOB_ID, status: 'imported', resultSha256: 'b'.repeat(64),
        }), 'utf8');
        const mismatchedReceipt = await waitForLocalAiHandoff({
          jobFolder, receiptFile, jobId: LOCAL_AI_TEST_JOB_ID, resultSha256: currentSha,
          deadlineMs: 1,
        });
        assert(mismatchedReceipt.outcome === 'revision-required',
          'a stale/mismatched receipt cannot masquerade as terminal success ahead of matching feedback');

        const helperSource = await fs.promises.readFile(path.resolve('local_ai/wait-for-handoff.mjs'), 'utf8');
        const routineSource = await fs.promises.readFile(path.resolve('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8');
        const ipcSource = await fs.promises.readFile(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
        assert(!helperSource.includes('LOCAL_AI_HANDOFF_WAIT_MS')
          && helperSource.includes('deadlineMs = null')
          && helperSource.includes('deadlineMs != null')
          && !helperSource.includes('mtime')
          && !/\bstat\b/.test(helperSource)
          && routineSource.includes('node local_ai/wait-for-handoff.mjs')
          && routineSource.includes('Do not substitute `stat`, file mtime,')
          && routineSource.includes('shell arithmetic')
          && !routineSource.includes('--deadline-ms')
          && !routineSource.includes('6 minutes')
          && !routineSource.includes('six-minute')
          && routineSource.includes('`revision-exhausted` feedback as a resumable measured revision request')
          && !routineSource.includes('If matching feedback says `revision-exhausted`, stop')
          && ipcSource.includes("'wait-for-handoff.mjs'")
          && ipcSource.includes('Local AI handoff wait helper'),
        'production handoff polling is unbounded without result-file mtime/stat arithmetic; an explicit deadline remains test-only, and standalone projects receive the shared helper beside the routine');
        return { receiptWinsLateStart: true, folderRemovalUnconfirmed: true, feedbackMatched: true, renderRetryMatched: true, invalidMatched: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: PDF import uses the same standalone résumé surface as API generation',
    run: () => {
      const localSource = fs.readFileSync(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const apiSource = fs.readFileSync(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
      const convergenceSource = fs.readFileSync(path.resolve('electron/ipc/applicationConvergence.js'), 'utf8');
      const cardSource = fs.readFileSync(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const fallbackSource = fs.readFileSync(path.resolve('src/hooks/useLocalAiFallbackManager.js'), 'utf8');
      const toastSource = fs.readFileSync(path.resolve('src/components/ToastProvider.jsx'), 'utf8');
      const routineSource = fs.readFileSync(path.resolve('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8');
      const styleSource = fs.readFileSync(path.resolve('Job Application Design System/STYLE.md'), 'utf8');
      const skillSource = fs.readFileSync(path.resolve('Job Application Design System/SKILL.md'), 'utf8');
      const normalizedRoutineSource = routineSource.replace(/\s+/g, ' ');
      const normalizedStyleSource = styleSource.replace(/\s+/g, ' ');
      const normalizedSkillSource = skillSource.replace(/\s+/g, ' ');
      assert(normalizedRoutineSource.includes('Treat concise career data as compressed evidence')
        && normalizedRoutineSource.includes('make the narrow inferences needed to express that work coherently')
        && normalizedRoutineSource.includes('Do not dress up familiarity or self-assessed knowledge')
        && normalizedRoutineSource.includes('Never add an unrecorded outcome, improvement, scale, duration, ownership level, production use, adoption, or causal result')
        && normalizedRoutineSource.includes('never move a fact between employers or projects'),
      'Local AI résumé generation must apply the same bounded compressed-evidence synthesis rule as API generation');
      const checklistBlock = new RegExp(`Canonical checklist, version ${APPLICATION_QUALITY_CHECKLIST_VERSION}:\\s*([\\s\\S]*?)\\n\\s*Use the full requirements`).exec(routineSource)?.[1] || '';
      const routineChecklistIds = [...checklistBlock.matchAll(/`([^`]+)`/g)].map(match => match[1]);
      const compactReviewStart = localSource.indexOf('function compactLocalAiQualityReview');
      const compactReviewEnd = localSource.indexOf('function localCoverLetterPlan', compactReviewStart);
      const compactReviewSource = compactReviewStart >= 0 && compactReviewEnd > compactReviewStart
        ? localSource.slice(compactReviewStart, compactReviewEnd)
        : '';
      assert(JSON.stringify(routineChecklistIds) === JSON.stringify(APPLICATION_QUALITY_CRITERIA.map(criterion => criterion.id))
        && /"sourceGrounding"|sourceGrounding/.test(routineSource)
        && routineSource.includes('careerDataQuotes')
        && normalizedRoutineSource.includes('final rendered text exactly after ordinary whitespace is normalized'),
      'the writer-facing routine publishes the app-owned canonical checklist and exact source-grounding contract without a divergent duplicate list');
      assert(normalizedRoutineSource.includes('grammatical parallelism')
        && normalizedRoutineSource.includes('faulty parallelism in coordinated forms such as `from X to/through Y`')
        && normalizedRoutineSource.includes('Pair noun phrases with noun phrases or actions with actions')
        && normalizedRoutineSource.includes('do not add bureaucratic padding to conceal a mismatch')
        && normalizedRoutineSource.includes('Do not compress a multi-step workflow into an opaque endpoint range'),
      'Local AI generation must critique and repair faulty parallelism without padding the sentence');
      assert(normalizedRoutineSource.includes('Every `.highlights li` must be understandable by itself')
        && normalizedRoutineSource.includes('Never use backward references such as `those platforms` or `that database`')
        && normalizedRoutineSource.includes('including `in-house`')
        && normalizedRoutineSource.includes('do not open abruptly with `At <employer>, ...`')
        && normalizedRoutineSource.includes('Never use a bare possessive industry label that can imply operational or domain experience broader'),
      'Local AI generation must keep résumé bullets standalone and frame unfamiliar employers and cross-domain evidence precisely');
      assert(normalizedRoutineSource.includes('detached synthesis that broadens one example into a role-wide or career-wide claim')
        && normalizedRoutineSource.includes('must name the concrete responsibility, system, decision, or process it synthesizes')
        && normalizedRoutineSource.includes('Treat phrases such as `most of my work` and `throughout my career` as factual breadth claims')
        && normalizedRoutineSource.includes('Across paragraph boundaries a demonstrative must find its referent in the immediately preceding paragraph')
        && normalizedRoutineSource.includes('never open a paragraph with `That <thing>` or `This <thing>` unless the previous paragraph is about that thing'),
      'Local AI must keep synthesis evidence-scoped and replace ambiguous cross-paragraph references');
      assert(normalizedRoutineSource.includes('Never state citizenship, work authorization, residency, visa, or any other legal work status anywhere in the letter')
        && normalizedRoutineSource.includes('legal work status belongs on the application form')
        && normalizedRoutineSource.includes('naming both the origin and destination')
        && normalizedRoutineSource.includes('Name the target role literally and in the singular')
        && localSource.includes('cover-legal-status')
        && localSource.includes('failed required checks'),
      'Local AI letters must never state legal work status, and the host rejects a completed result that does');
      assert(localSource.includes('renderLocalResumeWithFit')
        && localSource.includes('renderPdf(buildResumeDocument')
        && localSource.includes('targetPageCount')
        && localSource.includes('fit-feedback.json')
        && localSource.includes('render-retry-required')
        && localSource.includes("'kept_diminishing_returns'")
        && localSource.includes('documentSha256')
        && localSource.includes('there is no fixed revision limit')
        && localSource.includes('handoffHistory')
        && localSource.includes('handoff-receipts')
        && localSource.includes('writeLocalAiTerminalReceipt')
        && localSource.includes('result-imported')
        && localSource.includes('localAiCoverLetterTelemetry')
        && localSource.includes("status: 'revision-required'")
        && !localSource.includes('MAX_LOCAL_AI_UNFINISHED_JOBS')
        && localSource.includes('MAX_LOCAL_AI_HANDOFF_HISTORY')
        && localSource.includes('handoffEventCount')
        && localSource.includes('allEvents.slice(-MAX_LOCAL_AI_HANDOFF_HISTORY)')
        && localSource.includes('function compactLocalAiQualityReview')
        && localSource.includes('qualityReview: compactLocalAiQualityReview(result.qualityReview)')
        && !localSource.includes('qualityReview: result.qualityReview,\n      requestedAt')
        && !compactReviewSource.includes('sourceGrounding')
        && !compactReviewSource.includes('evidence: cleanText')
        && localSource.includes('LOCAL_AI_RESULT_CHANGED')
        && localSource.includes('resumeIsMateriallyUnderfilled')
        && localSource.includes('below the 90% minimum')
        && localSource.includes('For a cover letter that already fits, improve it')
        && localSource.includes('COVER_LETTER_COHESION_REVISION_RULE')
        && localSource.includes('one controlling throughline')
        && localSource.includes('minimum-sufficient evidence')
        && localSource.includes('résumé owns breadth')
        && localSource.includes('Give every paragraph one argumentative job')
        && localSource.includes('last sentence of each non-final paragraph')
        && localSource.includes('must not introduce a new decision frame or ask the employer to choose between initiatives')
        && localSource.includes('Cut or consolidate before introducing another employer, project, or tool merely to cover a different requirement')
        && localSource.includes('Each additional proof must have one explicit supporting role in the same argument')
        && localSource.includes('distinct systems or responsibilities side by side merely because they occurred in the same role or job')
        && localSource.includes('adjacency and “the same job” are not a bridge')
        && localSource.includes('do not make the letter narrate its own outline')
        && localSource.includes('Reject mirrored scaffolding')
        && localSource.includes('use neutral parallel framing that claims neither')
        && localSource.includes('Name actors and referents explicitly wherever pronouns would be ambiguous')
        && localSource.includes('keep general domain principles distinct from personal experience')
        && localSource.includes('listing’s description rather than independently verified fact')
        && localSource.includes('COVER_LETTER_COPY_PRECISION_RULE')
        && localSource.includes('Punctuate introductory phrases')
        && localSource.includes('recruiter seeing it for the first time')
        && localSource.includes('concrete actor, artifact, and action')
        && localSource.includes('distinguish metaphorical reference from visible on-screen indication')
        && localSource.includes('use direct present-tense language')
        && localSource.includes('connect the candidate’s relevant contribution to the specific target work')
        && localSource.includes('source document—not the target position—the grammatical subject')
        && localSource.includes('position attached to the application with a proximal determiner')
        && localSource.includes('communication verbs attached to an actual document or speaker')
        && localSource.includes('sanitizeCoverLetterArgument')
        && localSource.includes('assertCoverLetterReviewAttestsToArgument')
        && localSource.includes('primaryEvidence.relationToThesis')
        && localSource.includes('coverLetterArgument.secondaryEvidence.narrativeRole is invalid')
        && localSource.includes('layout: coverLetterFit.layout ? { ...coverLetterFit.layout, utilization: coverLetterFit.contentUtilization } : null')
        && localSource.includes("contentUtilization: resumeTypeAreaUtilization(rendered.layout || null)")
        && localSource.includes('type-area utilization is informational only')
        && localSource.includes('missingArtifacts.length === 0'),
      'Local AI measures both final documents, keeps revisions argument-led and fact-bounded, requests evidence-led revision for a materially underfilled one-page résumé, records every handoff event without a queue/history cap, keeps unresolved work revision-required, and never saves when layout verification is unavailable');
      assert(APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-reference-clarity')?.requirement.includes('selected position is referenced proximally')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-reference-clarity')?.requirement.includes('target scope is stated as this role or the work itself')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-reference-clarity')?.requirement.includes('source document—not the target position—as the reporting subject')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-register')?.requirement.includes('direct present tense')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-register')?.requirement.includes('never asks the employer to choose between initiatives')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-continuity')?.requirement.includes('restating a category')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-continuity')?.requirement.includes('shift between distinct systems or responsibilities')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-continuity')?.requirement.includes('shared role or job context alone is not a bridge')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-continuity')?.requirement.includes('one argumentative job')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-continuity')?.requirement.includes('identifies the branch it develops')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'resume-concision')?.requirement.includes('one principal achievement')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-sentence-craft')?.requirement.includes('word-boundary parse')
        && APPLICATION_QUALITY_CRITERIA.find(({ id }) => id === 'cover-sentence-craft')?.requirement.includes('role-accurate governing verb'),
      'Local AI version 2 keeps stable checklist IDs while making role-facing scope, direct closings, non-filler bridges, first-read parsing, and role-accurate technology verbs explicit');
      assert(localSource.includes('LEGACY_APPLICATION_QUALITY_CHECKLIST_VERSION = 1')
        && localSource.includes('expectedApplicationQualityChecklistVersion(input?.qualityChecklist?.version)')
        && localSource.includes('qualityChecklistVersion: input?.qualityChecklist?.version,')
        && localSource.includes('qualityChecklistVersion: expectedChecklistVersion,')
        && localSource.includes('version ${expectedChecklistVersion} quality checklist')
        && localSource.includes('checklistVersion: expectedChecklistVersion'),
      'new jobs use checklist v2 while status, import, normalized review, and measured revision guidance preserve only the queued app-owned supported version');
      assert(normalizedRoutineSource.includes("the listing's description, not as independently verified fact")
        && normalizedRoutineSource.includes('source document the grammatical')
        && normalizedRoutineSource.includes('position attached to this application with a proximal determiner')
        && normalizedRoutineSource.includes('Read every sentence once as a recruiter seeing')
        && normalizedRoutineSource.includes('adjacent words form a familiar compound or alternate parse')
        && normalizedRoutineSource.includes('governing verb that describes its actual role')
        && normalizedRoutineSource.includes('merely restates a category')
        && normalizedRoutineSource.includes('distinct systems or responsibilities do not become connected merely because')
        && normalizedRoutineSource.includes('adjacency and “the same job” are not a bridge')
        && normalizedRoutineSource.includes('Give every résumé highlight one principal achievement or action chain')
        && normalizedRoutineSource.includes('Delete conventional runtime-topology detail that merely proves implementation')
        && normalizedRoutineSource.includes('Give every paragraph one argumentative job')
        && normalizedRoutineSource.includes('make each evidence paragraph identify the branch it develops')
        && normalizedRoutineSource.includes('last sentence of every non-final paragraph')
        && normalizedRoutineSource.includes('must not introduce a new organizing frame')
        && normalizedRoutineSource.includes('ask the employer to choose between products, prototypes, or initiatives')
        && normalizedRoutineSource.includes('selected scope as `this role` or the work itself')
        && normalizedRoutineSource.includes('I welcome a conversation')
        && normalizedRoutineSource.includes('connect the candidate\'s relevant contribution to the specific')
        && normalizedSkillSource.includes("the listing's description, not as independently verified fact")
        && normalizedSkillSource.includes('source document, not the target position')
        && normalizedSkillSource.includes('proximal determiner unless explicitly contrasting')
        && normalizedSkillSource.includes('concrete actor, artifact, and')
        && normalizedSkillSource.includes('adjacent words form a familiar compound')
        && normalizedSkillSource.includes('governing verb that reflects its actual role')
        && normalizedSkillSource.includes('merely restates a category')
        && normalizedSkillSource.includes('Discuss target scope as `this role`')
        && normalizedSkillSource.includes('I welcome a conversation')
        && normalizedSkillSource.includes('final sentence as a role-facing invitation')
        && normalizedStyleSource.includes('Frame the source of employer context accurately')
        && normalizedStyleSource.includes('reporting verb belongs to the source document')
        && normalizedStyleSource.includes('position attached to the application with a proximal determiner')
        && normalizedStyleSource.includes('Read literally on the first pass')
        && normalizedStyleSource.includes('Read word boundaries literally too')
        && normalizedStyleSource.includes('Give each technology its actual operation')
        && normalizedStyleSource.includes('Delete category restatements')
        && normalizedStyleSource.includes('Discuss the target scope as *this role*')
        && normalizedStyleSource.includes('I welcome a conversation')
        && normalizedStyleSource.includes('Close by connecting contribution to work'),
      'the routine and design-system guidance carry the version 2 role-facing scope, source-framing, first-read parsing, technology-role, non-filler-bridge, and direct-closing contract');
      assert(localSource.includes('applicationConvergenceInstruction')
        && !apiSource.includes('createApplicationConvergenceTracker')
        && !apiSource.includes("from './llm.js'")
        && convergenceSource.includes('expectedApplicationQualityDecision')
        && convergenceSource.includes('repeated a previously measured document'),
      'Local AI alone consumes the shared no-limit convergence policy; retired API authoring is absent');
      assert(localSource.includes('Layout density is app-owned')
        && localSource.includes('let density = null;')
        && !localSource.includes("let density = /\\bdata-density\\s*=\\s*[\"']compact[\"']/i.test(resumeMainHtml)"),
      'Local AI ignores model-supplied compact density and measures default density before the app applies its compact retry');
      assert(cardSource.includes('Repair bundle') && cardSource.includes('missingArtifacts') && cardSource.includes('revision-required') && cardSource.includes('Retry layout check') && cardSource.includes('Retry import')
        && cardSource.includes('LOCAL_AI_RESULT_SETTLE_MS') && cardSource.includes('expectedResultSha256') && cardSource.includes('localApplication.id, localApplication.resultSha256')
        && cardSource.includes('imported?.errorCode') && cardSource.includes('LOCAL_AI_RESULT_CHANGED') && cardSource.includes('waiting briefly for the final save'),
      'the card exposes repair for historical partial bundles, waits for a stable Local AI result before auto-importing, and retains fit, render, and validation recovery paths');
      assert(fallbackSource.includes("next.status === 'render-retry-required'")
        && fallbackSource.includes("actionLabel: 'Retry layout check'")
        && fallbackSource.includes('await importJob(node, jobId, exactResultSha256, orphanJob)')
        && fallbackSource.includes('dedupeKey: `local-ai-retry:${jobId}:${exactResultSha256}`')
        && fallbackSource.includes('LOCAL_AI_RETRY_NOTICE_INTERVAL_MS')
        && toastSource.includes('normalizedDedupeKey')
        && toastSource.includes('toast.actionLabel') && toastSource.includes('toast.onAction'),
      'a hidden-card or orphaned hash-bound save failure exposes one explicit retry action instead of automatically repeating render/save or parking forever without UI');
      assert(routineSource.includes('resultSha256') && routineSource.includes('Preserve a verified one-page cover letter')
        && routineSource.includes('candidate location/contact')
        && routineSource.includes('page fit as a constraint')
        && routineSource.includes('never use `<b>` or')
        && routineSource.includes('front-load the most relevant')
        && routineSource.includes("Order each role's highlights by interview value")
        && normalizedRoutineSource.includes('colon-led evidence dumps')
        && normalizedRoutineSource.includes('unsolicited admissions of missing experience')
        && normalizedRoutineSource.includes('never repeat a metaphor across paragraphs')
        && routineSource.includes('<span data-achievement-id="ID">figure</span>')
        && routineSource.includes('Every top-level résumé category is a peer')
        && routineSource.includes('never use it as a peer category heading')
        && normalizedRoutineSource.includes("first sentence adds information beyond the application context")
        && normalizedRoutineSource.includes("Never announce that the candidate is applying")
        && normalizedRoutineSource.includes("Respect the recruiter's intelligence")
        && !normalizedRoutineSource.includes('Name the target company and role naturally in the opening sentence')
        && routineSource.includes('SAME local AI agent run active') && !routineSource.includes('6 minutes')
        && !routineSource.includes('six-minute')
        && routineSource.includes('There is no fixed round limit')
        && routineSource.includes('Infinite Canvas owns all root document variants')
        && routineSource.includes('handoff-receipts/<job-id>.json')
        && routineSource.includes('"coverLetterArgument"')
        && routineSource.includes('"relationToThesis"')
        && routineSource.includes('non-rendered argument contract')
        && routineSource.includes('one controlling argument')
        && routineSource.includes('minimum-sufficient evidence')
        && routineSource.includes('Never claim that the app "confirmed" bullet line counts'),
      'the Local AI routine can select a measured revision job, protect optional contact location from inference, require an argument-led cover-letter opening, distinguish measurements from diagnosis, observe final imported measurements after staging cleanup, and quality-check both documents until diminishing returns');
      assert(!apiSource.includes('_retiredRemoteApplicationGeneration')
        && !apiSource.includes('generate-application'),
      'the retired API cover-letter authoring path is absent from the application module');
      return { standalonePdfPath: true, fitRevision: true };
    },
  },
  {
    name: 'Local AI application: queued handoff is app-owned and supplies a strict routine',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const jobsRoot = path.join(project.root, '.local-ai', 'jobs');
        const sparseCareerError = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData: 'Experience.', canvasFilePath: project.canvasFilePath,
        }).then(() => null, error => error);
        const sparseJobEntries = await fs.promises.readdir(jobsRoot, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
        assert(sparseCareerError && sparseJobEntries.filter(entry => entry.isDirectory()).length === 0,
          'queue rejects career data too sparse for exact source grounding before creating an orphaned private job');
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme', snippet: 'Build reliable systems.' },
          careerData: 'Built reliable systems with measurable outcomes.', additionalNotes: 'Prefer a concise letter.',
          canvasFilePath: project.canvasFilePath,
        });
        assert(queued.status === 'queued' && /^[a-f0-9-]{36}$/i.test(queued.id), 'queue creates a UUID-backed Local AI job');
        const [manifest, input, prompt, jobListing, careerData] = await Promise.all([
          fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'),
          fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'),
          fs.promises.readFile(path.join(queued.folder, 'LOCAL_AI_PROMPT.md'), 'utf8'),
          fs.promises.readFile(path.join(queued.folder, 'context', 'job-listing.md'), 'utf8'),
          fs.promises.readFile(path.join(queued.folder, 'context', 'career-data.txt'), 'utf8'),
        ]);
        const parsedInput = JSON.parse(input);
        const parsedManifest = JSON.parse(manifest);
        assert(parsedManifest.status === 'queued' && parsedInput.jobId === queued.id
          && parsedInput.qualityChecklist?.version === APPLICATION_QUALITY_CHECKLIST_VERSION
          && JSON.stringify(parsedInput.qualityChecklist.criteria) === JSON.stringify(APPLICATION_QUALITY_CRITERIA)
          && parsedInput.generationAudit?.version === LOCAL_AI_GENERATION_AUDIT_VERSION
          && parsedInput.generationAudit?.required === true
          && JSON.stringify(parsedManifest.generationAudit) === JSON.stringify(parsedInput.generationAudit),
          'job manifest and input are tied to the exact queued job id');
        const expectedJobFolder = path.join(jobsRoot, queued.id);
        const expectedReceiptPath = path.join(project.root, '.local-ai', 'handoff-receipts', `${queued.id}.json`);
        const launchValuesMatch = /```json\n([\s\S]*?)\n```/.exec(prompt);
        const launchValues = launchValuesMatch ? JSON.parse(launchValuesMatch[1]) : null;
        assert(queued.folder.startsWith(`${project.root}${path.sep}.local-ai${path.sep}jobs${path.sep}`)
          && queued.canvasFilePath === project.canvasFilePath
          && queued.prompt === prompt
          && prompt.includes('LOCAL_AI_APPLICATION_ROUTINE.md')
          && JSON.stringify(launchValues) === JSON.stringify({
            WORKING_FOLDER: process.cwd(),
            ROOT_LOCATION: project.root,
            ROUTINE_PATH: path.join(process.cwd(), 'local_ai', 'LOCAL_AI_APPLICATION_ROUTINE.md'),
            INPUT_JOBS_ROOT: jobsRoot,
            JOB_FOLDER: expectedJobFolder,
            RESULT_PATH: path.join(expectedJobFolder, 'result.json'),
            HANDOFF_HELPER_PATH: path.join(process.cwd(), 'local_ai', 'wait-for-handoff.mjs'),
            RECEIPT_PATH: expectedReceiptPath,
            OUTPUT_BUNDLE_ROOT: 'Applied Jobs',
            OUTPUT_BUNDLE_PATH: path.join(project.root, 'Applied Jobs'),
            JOB_ID: queued.id,
            JOB_FORMAT_VERSION: LOCAL_AI_APPLICATION_VERSION,
            QUALITY_CHECKLIST_VERSION: APPLICATION_QUALITY_CHECKLIST_VERSION,
            GENERATION_AUDIT_VERSION: LOCAL_AI_GENERATION_AUDIT_VERSION,
          })
          && prompt.includes('execution handoff, not a request to explain')
          && prompt.includes('generation-audit versions')
          && prompt.includes('Matching `invalid`, `revision-required`, and legacy `revision-exhausted` feedback are nonterminal')
          && prompt.includes('Apart from RESULT_PATH, create no files'),
        'job is beside the saved canvas and gives a provider-neutral local agent an exact, versioned, execution-oriented handoff contract');
        assert(jobListing.includes('Developer') && jobListing.includes('Build reliable systems.')
          && careerData === 'Built reliable systems with measurable outcomes.',
        'Generate materializes the complete job-listing and career context the local coding agent needs');
        const legacyInput = {
          ...parsedInput,
          qualityChecklist: { ...parsedInput.qualityChecklist, version: 1 },
        };
        delete legacyInput.generationAudit;
        await fs.promises.writeFile(path.join(queued.folder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
        const mismatchedAuditContract = await localApplicationStatus(queued.id, project.canvasFilePath)
          .then(() => null, error => error);
        assert(/input and manifest generation-audit contracts do not match/u.test(String(mismatchedAuditContract?.message || mismatchedAuditContract)),
          'removing only one app-owned audit contract cannot downgrade a newly queued job to legacy behavior');
        const legacyManifest = { ...parsedManifest };
        delete legacyManifest.generationAudit;
        const legacyEvidence = 'Built reliable systems with measurable outcomes.';
        const legacyResult = {
          version: LOCAL_AI_APPLICATION_VERSION, jobId: queued.id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: `<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>${legacyEvidence}</li></ul></article></section></main>`,
          coverLetter: { ...normalizedCoverLetter(), paragraphs: [legacyEvidence] },
          coverLetterArgument: coverLetterArgumentForResumeEvidence(legacyEvidence, 'Developer at Acme'),
          qualityReview: {
            ...groundedQualityReview(sourceGroundingFor({
              resumeBullets: [legacyEvidence], coverLetterParagraphs: [legacyEvidence],
            })),
            checklistVersion: 1,
          },
        };
        await Promise.all([
          fs.promises.writeFile(path.join(queued.folder, 'manifest.json'), JSON.stringify(legacyManifest), 'utf8'),
          fs.promises.writeFile(path.join(queued.folder, 'result.json'), JSON.stringify(legacyResult), 'utf8'),
        ]);
        const legacyStatus = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(legacyStatus.status === 'completed',
          'status accepts a v1 result only when this already queued app-owned input explicitly expects the supported legacy checklist version');
        assert(parsedManifest.canvasFilePath === project.canvasFilePath && parsedInput.canvasRoot === project.root,
          'manifest and input bind the job to one canonical saved canvas and its folder');
        if (process.platform !== 'win32') {
          const jobMode = (await fs.promises.stat(queued.folder)).mode & 0o777;
          const privateFileModes = await Promise.all([
            'manifest.json', 'input.json', 'LOCAL_AI_PROMPT.md',
            path.join('context', 'job-listing.md'), path.join('context', 'career-data.txt'),
          ].map(async file => (await fs.promises.stat(path.join(queued.folder, file))).mode & 0o777));
          assert(jobMode === 0o700 && privateFileModes.every(mode => mode === 0o600),
            'Local AI candidate context must use owner-only directory and file permissions');
        }
        return { id: queued.id };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: editable output root stays canvas-relative',
    run: async () => {
      const projectRoot = path.join(os.tmpdir(), 'local-ai-project');
      const valid = resolveLocalOutputBundleRoot('Applications/2026', projectRoot);
      assert(valid.relative === path.join('Applications', '2026') && valid.resolved === path.join(projectRoot, 'Applications', '2026'),
        'nested canvas-relative bundle roots retain the configured hierarchy root');
      for (const unsafe of ['../outside', path.resolve(projectRoot, '..', 'outside'), '.']) {
        let rejected = false;
        try { resolveLocalOutputBundleRoot(unsafe, projectRoot); } catch { rejected = true; }
        assert(rejected, `unsafe bundle root is rejected: ${unsafe}`);
      }
      const containmentRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-containment-')));
      const outsideRoot = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-outside-')));
      const linkedOutput = path.join(containmentRoot, 'Applications');
      try {
        await fs.promises.symlink(outsideRoot, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir');
        let symlinkRejected = false;
        try {
          await ensureDirectoryWithinRoot(containmentRoot, path.join(linkedOutput, '2026'), {
            label: 'Local AI output bundle root',
          });
        } catch { symlinkRejected = true; }
        assert(symlinkRejected, 'a symlink inside the configured output hierarchy must be rejected before traversal');
        assert(!fs.existsSync(path.join(outsideRoot, '2026')),
          'rejecting a linked output root must not create even an intermediate directory outside the canvas');
      } finally {
        await fs.promises.rm(containmentRoot, { recursive: true, force: true });
        await fs.promises.rm(outsideRoot, { recursive: true, force: true });
      }
      return { root: valid.relative, symlinkTraversalBlocked: true };
    },
  },
  {
    name: 'Local AI application lifecycle: display deletion preserves active jobs and regeneration cleans only its replaced terminal handoff',
    run: async () => {
      const project = await createCanvasProject();
      const otherProject = await createCanvasProject();
      try {
        const localJob = { id: '123e4567-e89b-42d3-a456-426614174000', status: 'queued' };
        const hiddenCard = { id: 'card-hidden', type: 'jobcard', data: {} };
        const deletedCard = null;
        const replacementCard = { id: 'card-replaced', type: 'jobcard', data: { localApplication: { id: '123e4567-e89b-42d3-a456-426614174001' } } };
        assert(queuedLocalApplicationSettlement(hiddenCard, localJob).action === 'persist',
          'an unmounted-but-extant card keeps ownership of its queued handoff for the fallback manager');
        assert(queuedLocalApplicationSettlement(deletedCard, localJob).action === 'discard'
          && queuedLocalApplicationSettlement(replacementCard, localJob).action === 'discard',
        'a deleted card or a newer replacement handoff cannot be overwritten by a late queue response');
        for (const status of ['saved', 'invalid', 'failed', 'revision-exhausted']) {
          const prior = { id: `prior-${status}`, status };
          const terminalCard = { id: `card-${status}`, type: 'jobcard', data: { localApplication: prior } };
          assert(queuedLocalApplicationSettlement(terminalCard, localJob, prior).action === 'persist',
            `an intentional regeneration replaces the exact prior ${status} handoff`);
        }
        const pendingPrior = { id: 'prior-queued', status: 'queued' };
        const pendingCard = { id: 'card-pending', type: 'jobcard', data: { localApplication: pendingPrior } };
        assert(queuedLocalApplicationSettlement(pendingCard, localJob, pendingPrior).action === 'discard',
          'even an expected prior handoff cannot be replaced while it is still pending');
        const savedPrior = { id: 'prior-saved', status: 'saved', canvasFilePath: project.canvasFilePath };
        assert(replacedLocalApplicationForCleanup(savedPrior, localJob, true) === savedPrior,
          'an accepted regeneration selects the exact terminal handoff it replaced for cleanup');
        assert(replacedLocalApplicationForCleanup(savedPrior, localJob, false) === null
          && replacedLocalApplicationForCleanup(pendingPrior, localJob, true) === null
          && replacedLocalApplicationForCleanup(localJob, localJob, true) === null,
        'cleanup cannot run before replacement acceptance, against an active writer, or against the replacement itself');
        const changedCard = { id: 'card-changed', type: 'jobcard', data: { localApplication: { id: 'newer-job', status: 'saved' } } };
        assert(queuedLocalApplicationSettlement(changedCard, localJob, { id: 'older-job', status: 'saved' }).action === 'discard',
          'a terminal handoff that changed after the request began remains protected from a late response');
        assert(canSaveImportedLocalApplication({ type: 'jobcard', data: { localApplication: localJob } }, localJob.id)
          && !canSaveImportedLocalApplication(null, localJob.id)
          && !canSaveImportedLocalApplication({ type: 'jobcard', data: { localApplication: { id: 'other' } } }, localJob.id),
        'only the live card that still owns this exact job may promote an imported workspace');
        const cardSource = await fs.promises.readFile(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
        assert(/updateGlobal\(idRef\.current, \(node\) => \{[\s\S]{0,420}localApplication: queued\.localJob/.test(cardSource)
          && /if \(isMountedRef\.current\) \{\s*setLocalApplication\(queued\.localJob\)/.test(cardSource),
        'the queued pointer is committed to global node data before the mounted-only UI state update, so hidden cards remain discoverable');

        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const crossCanvas = await discardLocalApplicationJob(queued.id, otherProject.canvasFilePath);
        assert(crossCanvas.discarded && !crossCanvas.removedJob && fs.existsSync(queued.folder),
          'an idempotent discard request from a different canvas cannot remove the owning canvas job');
        const discarded = await discardLocalApplicationJob(queued.id, project.canvasFilePath);
        assert(discarded.discarded && discarded.removedJob && !fs.existsSync(queued.folder),
          'an explicit exact-id cleanup can remove a replaced trusted Local AI directory');
        const repeated = await discardLocalApplicationJob(queued.id, project.canvasFilePath);
        assert(repeated.discarded && !repeated.removedJob,
          'a duplicate deletion is idempotent after the exact job has already been removed');

        const controller = new AbortController();
        controller.abort(new Error('Node deleted'));
        let aborted = false;
        try {
          await queueLocalApplicationJob({
            job: { title: 'Cancelled', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
          }, controller.signal);
        } catch (error) { aborted = /Node deleted/.test(String(error?.message || error)); }
        assert(aborted, 'a cancelled queue task rejects before materializing a Local AI job folder');
        return { hiddenPersists: true, displayDeletionPreserves: true, replacementCleanupExact: true, cancellationCooperative: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
        await fs.promises.rm(otherProject.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'application save: registered artifacts cannot be linked or changed before promotion',
    run: async () => {
      const workDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'application-artifact-')));
      const outsideDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'application-artifact-outside-')));
      const artifactPath = path.join(workDir, 'Application.html');
      const outsidePath = path.join(outsideDir, 'outside.html');
      const original = '<!doctype html><main class="page">Trusted</main>';
      try {
        await fs.promises.writeFile(artifactPath, original, { mode: 0o600 });
        await fs.promises.writeFile(outsidePath, '<main>Outside</main>', { mode: 0o600 });
        const workspaceStat = await fs.promises.lstat(workDir);
        const workspaceIdentity = {
          realPath: await fs.promises.realpath(workDir),
          dev: workspaceStat.dev,
          ino: workspaceStat.ino,
        };
        const read = await readRegisteredApplicationArtifact(workDir, artifactPath, {
          encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
        });
        assert(read === original, 'the unchanged registered artifact remains readable');

        await fs.promises.writeFile(artifactPath, '<main class="page">Changed</main>', { mode: 0o600 });
        let changedRejected = false;
        try {
          await readRegisteredApplicationArtifact(workDir, artifactPath, {
            encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
          });
        } catch { changedRejected = true; }
        assert(changedRejected, 'a regular file modified after registration must fail its trusted-source fingerprint');

        await fs.promises.unlink(artifactPath);
        await fs.promises.symlink(outsidePath, artifactPath, process.platform === 'win32' ? 'file' : undefined);
        let linkedRejected = false;
        try {
          await readRegisteredApplicationArtifact(workDir, artifactPath, {
            encoding: 'utf8', workspaceIdentity, expectedSha256: sha256(original),
          });
        } catch { linkedRejected = true; }
        assert(linkedRejected, 'a registered source replaced by a symlink must be rejected');
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true });
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
      }
      return { fingerprintBound: true, symlinkBlocked: true };
    },
  },
  {
    name: 'Local AI import staging replaces a Generation Audit symlink without following it',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-audit-staging-')));
      const outDir = path.join(root, 'imported-workspace');
      const outsidePath = path.join(root, 'outside-sentinel.json');
      const generationAuditPath = path.join(outDir, 'Generation Audit.json');
      const outsideSentinel = '{"outside":"must remain unchanged"}\n';
      const generationAuditArtifact = `${JSON.stringify({
        version: LOCAL_AI_GENERATION_AUDIT_VERSION,
        schema: 'infinite-canvas-generation-audit',
      }, null, 2)}\n`;
      try {
        await fs.promises.mkdir(outDir);
        await Promise.all([
          fs.promises.writeFile(outsidePath, outsideSentinel),
          fs.promises.writeFile(path.join(outDir, 'Resume.pdf'), 'stale resume'),
          fs.promises.writeFile(path.join(outDir, 'Cover Letter.pdf'), 'stale cover letter'),
        ]);
        await fs.promises.symlink(outsidePath, generationAuditPath, process.platform === 'win32' ? 'file' : undefined);

        const staged = await stageLocalApplicationWorkspaceArtifacts({
          outDir,
          applicationHtml: '<!doctype html><main class="page">Application</main>',
          resumePdf: null,
          coverLetterPdf: null,
          jobListingMarkdown: '# Example role\n',
          generationAuditArtifact,
        });
        const auditStat = await fs.promises.lstat(generationAuditPath);
        assert(await fs.promises.readFile(outsidePath, 'utf8') === outsideSentinel,
          'staging must never follow Generation Audit.json to overwrite its outside target');
        assert(auditStat.isFile() && !auditStat.isSymbolicLink()
          && await fs.promises.readFile(generationAuditPath, 'utf8') === generationAuditArtifact,
        'the staged audit replaces the link itself with the exact app-authored regular file');
        assert(staged.generationAuditPath === generationAuditPath
          && staged.resumePdfPath === null && staged.coverLetterPdfPath === null
          && !fs.existsSync(path.join(outDir, 'Resume.pdf'))
          && !fs.existsSync(path.join(outDir, 'Cover Letter.pdf')),
        'the same atomic staging unit returns fixed paths and removes stale optional PDFs');
        return { outsideUnchanged: true, linkReplaced: true, stalePdfsRemoved: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: project routine cannot traverse a linked local_ai folder',
    run: async () => {
      const routineProject = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-routine-project-')));
      const outsideDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-routine-outside-')));
      const canvasProject = await createCanvasProject();
      const previousRoot = process.env.INFINITE_CANVAS_PROJECT_ROOT;
      try {
        await fs.promises.writeFile(path.join(routineProject, 'package.json'), '{"private":true}', 'utf8');
        await fs.promises.mkdir(path.join(routineProject, 'Job Application Design System'));
        await fs.promises.writeFile(path.join(outsideDir, 'LOCAL_AI_APPLICATION_ROUTINE.md'), '# untrusted linked routine', 'utf8');
        await fs.promises.symlink(outsideDir, path.join(routineProject, 'local_ai'), process.platform === 'win32' ? 'junction' : 'dir');
        process.env.INFINITE_CANVAS_PROJECT_ROOT = routineProject;
        let rejected = false;
        try {
          await queueLocalApplicationJob({
            job: { title: 'Developer', company: 'Acme' },
            careerData: TRUSTED_QUEUE_CAREER_DATA,
            canvasFilePath: canvasProject.canvasFilePath,
          });
        } catch (error) {
          rejected = /symbolic link|resolved outside|must not traverse/i.test(String(error?.message || error));
        }
        assert(rejected, 'a linked project routine folder must be rejected before discovery or copy');
      } finally {
        if (previousRoot === undefined) delete process.env.INFINITE_CANVAS_PROJECT_ROOT;
        else process.env.INFINITE_CANVAS_PROJECT_ROOT = previousRoot;
        await fs.promises.rm(routineProject, { recursive: true, force: true });
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
        await fs.promises.rm(canvasProject.root, { recursive: true, force: true });
      }
      return { linkedRoutineRejected: true };
    },
  },
  {
    name: 'Local AI application: stale active jobs are preserved while stale imported remnants are pruned',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const stale = await queueLocalApplicationJob({
          job: { title: 'Old Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const manifestPath = path.join(stale.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        manifest.createdAt = '2000-01-01T00:00:00.000Z';
        await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
        const staleImported = await queueLocalApplicationJob({
          job: { title: 'Imported Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const importedManifestPath = path.join(staleImported.folder, 'manifest.json');
        const importedManifest = JSON.parse(await fs.promises.readFile(importedManifestPath, 'utf8'));
        await fs.promises.writeFile(importedManifestPath, `${JSON.stringify({
          ...importedManifest, status: 'imported', createdAt: '2000-01-01T00:00:00.000Z',
        })}\n`, 'utf8');
        const settlingImported = await queueLocalApplicationJob({
          job: { title: 'Settling Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const settlingManifestPath = path.join(settlingImported.folder, 'manifest.json');
        const settlingManifest = JSON.parse(await fs.promises.readFile(settlingManifestPath, 'utf8'));
        await fs.promises.writeFile(settlingManifestPath, `${JSON.stringify({
          ...settlingManifest,
          status: 'imported',
          createdAt: '2000-01-01T00:00:00.000Z',
          importedAt: new Date().toISOString(),
        })}\n`, 'utf8');
        await queueLocalApplicationJob({
          job: { title: 'New Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        assert(fs.existsSync(stale.folder),
          'an old queued job remains available because an active authoring or revision session has no retention-based regeneration cap');
        assert(!fs.existsSync(staleImported.folder),
          'an old imported remnant with no active writer session is pruned before another job is accepted');
        assert(fs.existsSync(settlingImported.folder),
          'an old job with a fresh importedAt settling window is never pruned while its follow-up save may still consume staged artifacts');
        return { activePreserved: true, staleImportedPruned: true, settlingImportedPreserved: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: result contract rejects unsafe résumé markup',
    run: () => {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      const validResumeMain = '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
      const good = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: groundedQualityReview(sourceGroundingFor()),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(good.coverLetter.paragraphs.length === 1
        && good.coverLetterArgument.roleThesis === validCoverLetterArgument().roleThesis,
      'valid structured output preserves the non-rendered controlling-argument contract');
      const legacyV1Result = {
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: { ...draftedQualityReview(), checklistVersion: 1 },
      };
      let defaultV1Rejected = false;
      try { validateLocalApplicationResult(legacyV1Result, id, path.join(os.tmpdir(), 'local-ai-project')); }
      catch (error) { defaultV1Rejected = /checklistVersion must be 2/u.test(String(error?.message || error)); }
      const acceptedLegacyV1 = validateLocalApplicationResult(legacyV1Result, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
        qualityChecklistVersion: 1,
      });
      let unknownExpectedVersionRejected = false;
      try {
        validateLocalApplicationResult(legacyV1Result, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
          qualityChecklistVersion: 99,
        });
      } catch (error) { unknownExpectedVersionRejected = /unsupported quality checklist version/u.test(String(error?.message || error)); }
      assert(defaultV1Rejected && acceptedLegacyV1.qualityReview.checklistVersion === 1 && unknownExpectedVersionRejected
        && good.qualityReview.checklistVersion === APPLICATION_QUALITY_CHECKLIST_VERSION,
      'direct validation requires current v2, accepts v1 only with an explicit supported legacy job expectation, preserves that normalized version, and fails closed for unknown versions');
      assert(Array.isArray(APPLICATION_QUALITY_CRITERIA) && APPLICATION_QUALITY_CRITERIA.length > 0
        && APPLICATION_QUALITY_CRITERIA.every(criterion => criterion
          && typeof criterion.id === 'string' && criterion.id
          && typeof criterion.document === 'string' && criterion.document
          && typeof criterion.requirement === 'string' && criterion.requirement),
      'the app owns one non-empty, descriptive canonical application-quality checklist');
      const assertChecklistRejected = (label, qualityReview) => {
        let rejected = false;
        try {
          validateLocalApplicationResult({
            version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
            resumeMainHtml: validResumeMain,
            coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(), qualityReview,
          }, id, path.join(os.tmpdir(), 'local-ai-project'));
        } catch { rejected = true; }
        assert(rejected, `Local AI validation rejects a ${label} quality checklist instead of trusting a self-attestation`);
      };
      const missingOneCriterion = draftedQualityReview();
      missingOneCriterion.criteria.pop();
      assertChecklistRejected('incomplete', missingOneCriterion);
      const duplicateCriterion = draftedQualityReview();
      duplicateCriterion.criteria.push({ ...duplicateCriterion.criteria[0] });
      assertChecklistRejected('duplicate', duplicateCriterion);
      const unknownCriterion = draftedQualityReview();
      unknownCriterion.criteria[0] = { ...unknownCriterion.criteria[0], id: 'invented-quality-rule' };
      assertChecklistRejected('unknown', unknownCriterion);
      const reorderedChecklist = draftedQualityReview();
      [reorderedChecklist.criteria[0], reorderedChecklist.criteria[1]] = [reorderedChecklist.criteria[1], reorderedChecklist.criteria[0]];
      assertChecklistRejected('reordered', reorderedChecklist);
      const failingCriterion = draftedQualityReview();
      failingCriterion.criteria[0] = { ...failingCriterion.criteria[0], status: 'fail', evidence: 'This criterion did not pass.' };
      assertChecklistRejected('failing', failingCriterion);
      const repeatedChecklistNotes = draftedQualityReview();
      repeatedChecklistNotes.criteria = repeatedChecklistNotes.criteria.map(criterion => ({
        ...criterion,
        evidence: 'Reviewed the final application for factual relevance and clarity.',
      }));
      assertChecklistRejected('repeated verification-note', repeatedChecklistNotes);
      const boilerplateChecklistNotes = draftedQualityReview();
      boilerplateChecklistNotes.criteria = boilerplateChecklistNotes.criteria.map(criterion => ({
        ...criterion,
        evidence: `Verified the final ${criterion.id} criterion carefully.`,
      }));
      assertChecklistRejected('boilerplate verification-note', boilerplateChecklistNotes);
      const missingChecklistVersion = draftedQualityReview();
      delete missingChecklistVersion.checklistVersion;
      assertChecklistRejected('unversioned', missingChecklistVersion);
      const trustedCareerData = 'Built supported systems. A concise factual letter. I am available to start in June.';
      const sourceGrounding = sourceGroundingFor();
      const trustedResult = {
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: groundedQualityReview(sourceGrounding),
      };
      const trustedOptions = { careerData: trustedCareerData };
      const grounded = validateLocalApplicationResult(trustedResult, id, path.join(os.tmpdir(), 'local-ai-project'), {}, trustedOptions);
      assert(grounded.qualityReview.sourceGrounding.resumeBullets.length === 1
        && grounded.qualityReview.sourceGrounding.coverLetterParagraphs.length === 1,
      'trusted queued context requires exact source-grounding records for every final bullet and paragraph');
      const assertGroundingRejected = (label, value, expected) => {
        let rejected = false;
        try { validateLocalApplicationResult(value, id, path.join(os.tmpdir(), 'local-ai-project'), {}, trustedOptions); }
        catch (error) { rejected = String(error?.message || error).includes(expected); }
        assert(rejected, `trusted source-grounding rejects ${label}`);
      };
      const missingGrounding = { ...trustedResult, qualityReview: draftedQualityReview() };
      assertGroundingRejected('a missing coverage record', missingGrounding, 'sourceGrounding');
      const wrongQuote = structuredClone(trustedResult);
      wrongQuote.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes = ['Invented deployment record with no career source.'];
      assertGroundingRejected('a quote absent from career data', wrongQuote, 'not an exact quote');
      const careerWithUnrelatedQuote = `${trustedCareerData} Unrelated gardening volunteer event.`;
      const unrelatedBulletQuote = structuredClone(trustedResult);
      unrelatedBulletQuote.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes = ['Unrelated gardening volunteer event.'];
      let unrelatedBulletRejected = false;
      try { validateLocalApplicationResult(unrelatedBulletQuote, id, path.join(os.tmpdir(), 'local-ai-project'), {}, { careerData: careerWithUnrelatedQuote }); }
      catch { unrelatedBulletRejected = true; }
      assert(unrelatedBulletRejected,
        'an exact but lexically unrelated career quote cannot be used to ground a résumé bullet');
      const unrelatedParagraphQuote = structuredClone(trustedResult);
      unrelatedParagraphQuote.qualityReview.sourceGrounding.coverLetterParagraphs[0].careerDataQuotes = ['Unrelated gardening volunteer event.'];
      let unrelatedParagraphRejected = false;
      try { validateLocalApplicationResult(unrelatedParagraphQuote, id, path.join(os.tmpdir(), 'local-ai-project'), {}, { careerData: careerWithUnrelatedQuote }); }
      catch { unrelatedParagraphRejected = true; }
      assert(unrelatedParagraphRejected,
        'an exact but lexically unrelated career quote cannot be used to ground a cover-letter paragraph');
      const aiWorkflowQuote = 'At Thomson School District, I worked across AI-assisted development workflows with model delegation and appropriate use cases.';
      let unsupportedDailyRejected = false;
      try {
        assertSourceQuoteLinksFinalText(
          'At Thomson School District, I worked across AI-assisted development workflows. Deciding what a model should own was a daily call at the district.',
          [aiWorkflowQuote],
          'coverLetterParagraphs',
          0,
          { identityTokens: ['thomson', 'district'] },
        );
      } catch (error) {
        unsupportedDailyRejected = /unsupported daily frequency/u.test(String(error?.message || error));
      }
      assert(unsupportedDailyRejected,
        'a candidate career sentence cannot borrow daily frequency from unrelated career data outside its bound quote');
      let unsupportedSuperiorityRejected = false;
      try {
        assertSourceQuoteLinksFinalText(
          'Used model delegation while deciding where agentic coding beat traditional workflows.',
          ['Worked across agentic coding and traditional workflows with model delegation and appropriate use cases.'],
          'resumeBullets',
          0,
        );
      } catch (error) {
        unsupportedSuperiorityRejected = /unsupported comparative superiority/u.test(String(error?.message || error));
      }
      assert(unsupportedSuperiorityRejected,
        'a résumé bullet cannot turn supported workflow comparison into unsupported superiority');
      const unsupportedSuperiorityResult = {
        ...trustedResult,
        resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Used model delegation while deciding where agentic coding beat traditional workflows.</li></ul></article></section></main>',
        coverLetterArgument: coverLetterArgumentForResumeEvidence(
          'Used model delegation while deciding where agentic coding beat traditional workflows.',
        ),
        qualityReview: groundedQualityReview(sourceGroundingFor({
          resumeBullets: ['Used model delegation while deciding where agentic coding beat traditional workflows.'],
          resumeQuotes: ['Worked across agentic coding and traditional workflows with model delegation and appropriate use cases.'],
        })),
      };
      let importerSuperiorityRejected = false;
      try {
        validateLocalApplicationResult(unsupportedSuperiorityResult, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
          careerData: 'Worked across agentic coding and traditional workflows with model delegation and appropriate use cases. A concise factual letter.',
        });
      } catch (error) {
        importerSuperiorityRejected = /unsupported comparative superiority/u.test(String(error?.message || error));
      }
      assert(importerSuperiorityRejected,
        'the production Local AI importer invokes unit-bound qualifier validation before accepting a result');
      assertSourceQuoteLinksFinalText(
        'Maintained Bash cron jobs that synchronized daily FAA API data into the local database.',
        ['Maintained cron jobs that synced the FAA daily API data into the local database.'],
        'resumeBullets',
        0,
      );
      assertSourceQuoteLinksFinalText(
        'Outperformed the legacy routing process in controlled tests.',
        ['The revised routing process outperformed the legacy routing process in controlled tests.'],
        'resumeBullets',
        0,
      );
      let disconnectedSentenceRejected = false;
      try {
        assertSourceQuoteLinksFinalText(
          'I built supported systems with clear outcomes. I cultivated rare orchids for regional shows.',
          ['I built supported systems with clear outcomes.'],
          'coverLetterParagraphs',
          0,
        );
      } catch (error) {
        disconnectedSentenceRejected = /sentence 2/u.test(String(error?.message || error));
      }
      assert(disconnectedSentenceRejected,
        'each first-person career sentence in a cover-letter paragraph must link to that paragraph\'s bound quotes');
      assertSourceQuoteLinksFinalText(
        'I built supported systems with clear outcomes. Choosing what to build is the judgment I would bring to this role.',
        ['I built supported systems with clear outcomes.'],
        'coverLetterParagraphs',
        0,
      );
      const oversizedQuote = `${'Built supported systems with clear outcomes and engineering judgment. '.repeat(40)}End.`;
      const oversizedQuoteResult = structuredClone(trustedResult);
      oversizedQuoteResult.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes = [oversizedQuote];
      let oversizedQuoteRejected = false;
      try {
        validateLocalApplicationResult(oversizedQuoteResult, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
          careerData: `${oversizedQuote} A concise factual letter.`,
        });
      } catch (error) {
        oversizedQuoteRejected = /exceeds 2000 characters/u.test(String(error?.message || error));
      }
      assert(oversizedQuoteRejected,
        'source grounding rejects whole-document-sized quotes instead of letting them bypass unit-level attribution');
      const threeBulletTexts = [
        'Built alpha services with verified controls.',
        'Delivered beta dashboards through documented reviews.',
        'Migrated gamma data pipelines for operations.',
      ];
      const thirdBulletWrongQuote = {
        ...trustedResult,
        resumeMainHtml: `<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights">${threeBulletTexts.map(bullet => `<li>${bullet}</li>`).join('')}</ul></article></section></main>`,
        coverLetterArgument: coverLetterArgumentForResumeEvidence(threeBulletTexts[0]),
        qualityReview: groundedQualityReview(sourceGroundingFor({
          resumeBullets: threeBulletTexts,
          resumeQuotes: [threeBulletTexts[0], threeBulletTexts[1], 'Unrelated horticulture volunteer event.'],
        })),
      };
      let thirdBulletOrdinalRejected = false;
      try {
        validateLocalApplicationResult(thirdBulletWrongQuote, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
          careerData: `${threeBulletTexts.join(' ')} A concise factual letter. Unrelated horticulture volunteer event.`,
        });
      } catch (error) {
        thirdBulletOrdinalRejected = /sourceGrounding\.resumeBullets\[2\] \(résumé bullet 3\)/u.test(String(error?.message || error));
      }
      assert(thirdBulletOrdinalRejected,
        'source-grounding errors retain the zero-based path and add a one-based human résumé-bullet ordinal');
      const genericSharedQuote = 'Built internal dashboard for finance teams.';
      const genericSharedFinalText = 'Built internal security system for enterprise customers.';
      const genericTokenBypass = {
        ...trustedResult,
        resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built internal security system for enterprise customers.</li></ul></article></section></main>',
        coverLetter: { ...normalizedCoverLetter(), paragraphs: [genericSharedFinalText] },
        coverLetterArgument: coverLetterArgumentForResumeEvidence(genericSharedFinalText, 'Engineer at Acme'),
        qualityReview: groundedQualityReview(sourceGroundingFor({
          resumeBullets: [genericSharedFinalText],
          coverLetterParagraphs: [genericSharedFinalText],
          resumeQuotes: [genericSharedQuote],
          coverLetterQuotes: [genericSharedQuote],
        })),
      };
      let genericTokenBypassRejected = false;
      try { validateLocalApplicationResult(genericTokenBypass, id, path.join(os.tmpdir(), 'local-ai-project'), {}, { careerData: genericSharedQuote }); }
      catch (error) { genericTokenBypassRejected = /unrelated|shared meaningful token/i.test(String(error?.message || error)); }
      assert(genericTokenBypassRejected,
        'shared generic action words cannot make an internal-dashboard quote ground a distinct internal-security final claim');
      const staleBullet = structuredClone(trustedResult);
      staleBullet.qualityReview.sourceGrounding.resumeBullets[0].bullet = 'A stale prior résumé bullet.';
      assertGroundingRejected('a stale prior résumé bullet binding', staleBullet, 'exact normalized final text');
      const staleParagraph = structuredClone(trustedResult);
      staleParagraph.qualityReview.sourceGrounding.coverLetterParagraphs[0].paragraph = 'A stale prior cover-letter paragraph.';
      assertGroundingRejected('a stale prior cover-letter paragraph binding', staleParagraph, 'exact normalized final text');
      const wrongRole = structuredClone(trustedResult);
      wrongRole.coverLetterArgument.primaryEvidence.evidenceRole = 'Engineer at Other Company';
      assertGroundingRejected('an argument proof assigned to the wrong résumé role', wrongRole, 'evidenceRole 1');
      const projectWithoutCompany = {
        ...trustedResult,
        resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">AI-Chalkboard</span><ul class="highlights"><li>Built a native macOS overlay for precise on-screen guidance.</li></ul></article></section></main>',
        coverLetterArgument: coverLetterArgumentForResumeEvidence(
          'Built a native macOS overlay for precise on-screen guidance.',
          'AI-Chalkboard project',
        ),
        qualityReview: groundedQualityReview(sourceGroundingFor({
          resumeBullets: ['Built a native macOS overlay for precise on-screen guidance.'],
          resumeQuotes: ['Built a native macOS overlay for precise on-screen guidance.'],
        })),
      };
      const groundedProjectWithoutCompany = validateLocalApplicationResult(
        projectWithoutCompany,
        id,
        path.join(os.tmpdir(), 'local-ai-project'),
        {},
        { careerData: 'Built a native macOS overlay for precise on-screen guidance. A concise factual letter.' },
      );
      assert(groundedProjectWithoutCompany.coverLetterArgument.primaryEvidence.evidenceRole === 'AI-Chalkboard project',
        'argument evidence can identify a company-less project by its résumé title without inventing an employer label');
      const logisticsParagraph = 'A concise factual letter. I am available to start in June.';
      const logisticsResult = {
        ...trustedResult,
        coverLetter: { ...normalizedCoverLetter(), paragraphs: [logisticsParagraph] },
        coverLetterArgument: {
          ...validCoverLetterArgument(),
          logistics: {
            statement: 'I am available to start in June.',
            careerDataQuotes: ['I am available to start in June.'],
          },
        },
        qualityReview: groundedQualityReview(sourceGroundingFor({
          coverLetterParagraphs: [logisticsParagraph],
          coverLetterQuotes: ['I am available to start in June.'],
        })),
      };
      let declaredLogisticsRejected = false;
      try { validateLocalApplicationResult(logisticsResult, id, path.join(os.tmpdir(), 'local-ai-project'), {}, trustedOptions); }
      catch (error) { declaredLogisticsRejected = /logistics.*(?:empty|application fields)/i.test(String(error?.message || error)); }
      assert(declaredLogisticsRejected,
        'a legacy argument-contract logistics claim is rejected even when exact career data supports it');
      const undeclaredLogistics = structuredClone(logisticsResult);
      delete undeclaredLogistics.coverLetterArgument.logistics;
      let undeclaredLogisticsRejected = false;
      try { validateLocalApplicationResult(undeclaredLogistics, id, path.join(os.tmpdir(), 'local-ai-project'), {}, trustedOptions); }
      catch (error) { undeclaredLogisticsRejected = /logistics-exclusion/i.test(String(error?.message || error)); }
      assert(undeclaredLogisticsRejected, 'visible application logistics are rejected rather than admitted through the argument contract');
      for (const [label, bullet, expected] of [
        ['backward platform reference', 'Built Python ETL integrations between the district information system and those platforms.', 'resume-bullet-self-containment'],
        ['backward database reference', 'Exposed that database through Python REST APIs for controlled access.', 'resume-bullet-self-containment'],
        ['missing compound hyphen', 'Designed a React hub for tools kept in house.', 'compound-hyphenation'],
        ['noun-to-gerund process range', 'Evaluated products from the quote request through presenting findings.', 'parallel-structure'],
        ['opaque run-range process', 'Evaluated products, running each from the quote request through a findings presentation.', 'parallel-structure'],
        ['ambiguous data owner', 'Migrated ticketing across with their data.', 'reference-clarity'],
        ['ambiguous API owner', 'Synchronized FAA releases through their APIs.', 'reference-clarity'],
        ['detached temporal modifier', 'Modified A*, applying it to flight routing after testing candidate algorithms.', 'modifier-attachment'],
      ]) {
        let editorialRejected = false;
        try {
          validateLocalApplicationResult({
            version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
            resumeMainHtml: `<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>${bullet}</li></ul></article></main>`,
            coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
          }, id, path.join(os.tmpdir(), 'local-ai-project'));
        } catch (error) { editorialRejected = String(error?.message || error).includes(expected); }
        assert(editorialRejected, `Local AI validation rejects ${label} before rendering`);
      }
      const withinBulletReference = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built a medical-data database and exposed that database through Python REST APIs.</li></ul></article></main>',
        coverLetter: normalizedCoverLetter(), coverLetterArgument: coverLetterArgumentForResumeEvidence('Built a medical-data database and exposed that database through Python REST APIs.'), qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(withinBulletReference.resumeMainHtml.includes('exposed that database'),
        'the standalone-bullet guard permits a concrete referent introduced earlier in the same bullet');
      for (const [label, paragraph, expected] of [
        ['abrupt prior-employer opener', 'At Acme, I evaluated third-party products before adoption.', 'prior-employer-opening'],
        ['broad industry label', 'My aviation work extends this evidence with software design.', 'vague-domain-work-label'],
        ['noun-to-gerund cover-letter range', 'I evaluated products from the quote request through presenting findings.', 'parallel-structure'],
        ['stewardship process range', 'I ran the evaluations, carrying each one from the quote request through the final analysis for management.', 'parallel-structure'],
        ['prose span ending in through', 'I owned that work from the first scoping call through the final handoff.', 'parallel-structure'],
        ['entailed setup premise', 'Before those products were adopted, the district had to choose them, and I ran the evaluations.', 'entailed-premise'],
        ['ambiguous data consumer', 'The platforms produced data they used and data they returned.', 'reference-clarity'],
        ['missing workplace-introduction comma', 'At the district I delivered software through traditional and AI-assisted workflows.', 'introductory-workplace-comma'],
        ['metaphorically ambiguous UI pointing', 'An agent walking someone through an on-screen task cannot point at the control it means.', 'visual-reference-precision'],
        ['conditionally deferential closing', 'I would welcome the chance to talk about that work.', 'direct-welcome-closing'],
        ['opaque responsibility pivot', 'Keeping the district data consistent across its tools was a different problem. I solved it with Python integration jobs.', 'responsibility-transition'],
        ['same-job responsibility opener', 'The same job also included assessing software before adoption.', 'responsibility-transition'],
        ['employer-choice closing', 'I welcome a conversation about whether the voice assistant or browser agent should be the first prototype.', 'direct-welcome-closing'],
        ['literalized decision frame', 'Model delegation and a purchased platform are two answers to one build-or-buy call.', 'claimed-equivalence'],
      ]) {
        let editorialRejected = false;
        try {
          validateLocalApplicationResult({
            version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
            resumeMainHtml: validResumeMain,
            coverLetter: { ...normalizedCoverLetter(), paragraphs: [paragraph] }, coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
          }, id, path.join(os.tmpdir(), 'local-ai-project'));
        } catch (error) { editorialRejected = String(error?.message || error).includes(expected); }
        assert(editorialRejected, `Local AI validation rejects ${label} before rendering`);
      }
      let topologyTailRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Containerized the internal-tools hub with Docker Compose, running Django under Gunicorn behind Nginx.</li></ul></article></main>',
          coverLetter: normalizedCoverLetter(), coverLetterArgument: coverLetterArgumentForResumeEvidence('Containerized the internal-tools hub with Docker Compose, running Django under Gunicorn behind Nginx.'),
          qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { topologyTailRejected = /resume-bullet-focus/.test(String(error?.message || error)); }
      assert(topologyTailRejected,
        'Local AI validation rejects a runtime-topology tail appended to an already complete containerization highlight');
      const uniformHighlightText = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><section class="section"><h2><strong>Experience</strong></h2><article class="role"><ul class="highlights"><li>Cut latency <strong data-achievement-id="receipt-1">42%</strong> with <b>Python</b> services.</li></ul></article></section></main>',
        coverLetter: normalizedCoverLetter(), coverLetterArgument: coverLetterArgumentForResumeEvidence('Cut latency 42% with Python services.'), qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      const normalizedHighlight = /<ul\b[^>]*class="highlights"[^>]*>([\s\S]*?)<\/ul>/i.exec(uniformHighlightText.resumeMainHtml)?.[1] || '';
      assert(!/<(?:b|strong)\b/i.test(normalizedHighlight)
        && uniformHighlightText.resumeMainHtml.includes('<span data-achievement-id="receipt-1">42%</span>')
        && uniformHighlightText.resumeMainHtml.includes('<span>Python</span>')
        && uniformHighlightText.resumeMainHtml.includes('<h2><strong>Experience</strong></h2>'),
      'Local AI import neutralizes inline emphasis only inside highlight bullets, preserving receipt attributes, text, and structural heading emphasis');
      const unrestrictedParagraphs = ['First.', 'Second.', 'Third.', 'Fourth.', `${'word '.repeat(900)}Fifth.`];
      let runawaySentenceRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: { ...normalizedCoverLetter(), paragraphs: unrestrictedParagraphs }, coverLetterArgument: validCoverLetterArgument(),
          qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { runawaySentenceRejected = /sentence-length/.test(String(error?.message || error)); }
      assert(runawaySentenceRejected,
        'Local AI validation rejects a runaway sentence before layout fit can make an unchecked draft shippable');
      for (const opener of [
        'I am writing to apply for the Developer role at Acme.',
        "I'm writing to apply for the Developer role at Acme.",
        'I’m writing to apply for the Developer role at Acme.',
        'I am applying for the Developer role at Acme.',
        "I'm applying for the Developer role at Acme.",
        'I’m applying for the Developer role at Acme.',
        'Please accept my application for the Developer role at Acme.',
      ]) {
        let bannedOpenerRejected = false;
        try {
          validateLocalApplicationResult({
            version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
            outputBundleRoot: 'Applied Jobs',
            resumeMainHtml: validResumeMain,
            coverLetter: { ...normalizedCoverLetter(), paragraphs: [opener] }, coverLetterArgument: validCoverLetterArgument(),
            qualityReview: draftedQualityReview(),
          }, id, path.join(os.tmpdir(), 'local-ai-project'), { company: 'Acme', title: 'Developer' });
        } catch (error) {
          bannedOpenerRejected = /generic-phrases.*banned opener/i.test(String(error?.message || error));
        }
        assert(bannedOpenerRejected,
          `Local AI validation must reject application-announcement opener: ${opener}`);
      }
      const canonicalEnvelope = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: '<main class="page"><header class="resume-header"><h1 class="name">Maya Chen</h1><p class="tagline"><span class="subtitle-role">Senior Engineer</span><span class="sep" aria-hidden="true">·</span><span class="credential">B.S. Computer Science, Example University</span></p><p class="contact">maya@example.test · Toronto, ON</p></header><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></main>',
        coverLetter: {
          ...normalizedCoverLetter(), name: 'Wrong Name', contact: ['wrong@example.test'],
          salutation: 'Dear Acme Hiring Team,', recipient: 'Acme Hiring Team', closing: 'Regards,', signatureTitle: 'Engineer',
        },
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      }, id, path.join(os.tmpdir(), 'local-ai-project'), { company: 'Acme', title: 'Senior Platform Engineer' });
      assert(canonicalEnvelope.coverLetter.name === 'Maya Chen'
        && JSON.stringify(canonicalEnvelope.coverLetter.contact) === JSON.stringify(['maya@example.test', 'Toronto, ON'])
        && canonicalEnvelope.coverLetter.tagline === 'Senior Engineer · B.S. Computer Science, Example University'
        && canonicalEnvelope.coverLetter.subtitleRole === 'Senior Engineer'
        && canonicalEnvelope.coverLetter.credential === 'B.S. Computer Science, Example University'
        && /^[A-Z][a-z]+ \d{4}$/.test(canonicalEnvelope.coverLetter.date)
        && canonicalEnvelope.coverLetter.recipient === ''
        && canonicalEnvelope.coverLetter.salutation === 'Dear Acme Hiring Team,'
        && canonicalEnvelope.coverLetter.closing === 'Sincerely,'
        && canonicalEnvelope.coverLetter.signatureTitle === '',
      'Local AI derives the complete cover-letter envelope from the accepted résumé and selected job instead of trusting model-supplied fields');
      const renderedEnvelope = buildCoverLetterDocument({ letter: canonicalEnvelope.coverLetter });
      const resumeHeaderDom = new JSDOM(canonicalEnvelope.resumeMainHtml);
      const coverHeaderDom = new JSDOM(renderedEnvelope);
      const subtitleSequence = (doc) => [...doc.window.document.querySelectorAll('.tagline > *')]
        .map(node => `${node.className}:${node.textContent}:${node.getAttribute('aria-hidden') || ''}`);
      assert(JSON.stringify(subtitleSequence(resumeHeaderDom)) === JSON.stringify(subtitleSequence(coverHeaderDom)),
        'Local AI preserves the accepted résumé header role, separator, and credential nodes in the generated cover-letter letterhead');
      resumeHeaderDom.window.close();
      coverHeaderDom.window.close();
      const expectedDateTime = `${canonicalEnvelope.coverLetter.date.slice(-4)}-${String([
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ].indexOf(canonicalEnvelope.coverLetter.date.split(' ')[0]) + 1).padStart(2, '0')}`;
      assert(renderedEnvelope.includes(`<time datetime="${expectedDateTime}">${canonicalEnvelope.coverLetter.date}</time>`),
        'Local AI keeps the app-authored month-year date and its machine-readable value in the cover-letter document');
      let summaryOnlyRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Software Engineer</span><span class="company">FliteX</span><p class="role-summary">Built flight-routing automation.</p></article></main>',
          coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { summaryOnlyRejected = true; }
      assert(summaryOnlyRejected,
        'the Local AI import path must reject a summary-only role instead of copying raw notes into a bullet');
      let missingArgumentRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingArgumentRejected = /coverLetterArgument object/i.test(String(error?.message || error)); }
      assert(missingArgumentRejected,
        'Local AI import rejects a result without the non-rendered controlling-argument contract');
      let missingPrimaryRelationRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
          coverLetterArgument: {
            ...validCoverLetterArgument(),
            primaryEvidence: {
              evidence: validCoverLetterArgument().primaryEvidence.evidence,
              evidenceRole: validCoverLetterArgument().primaryEvidence.evidenceRole,
            },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingPrimaryRelationRejected = /primaryEvidence\.relationToThesis/i.test(String(error?.message || error)); }
      assert(missingPrimaryRelationRejected,
        'Local AI import requires the primary proof to state how it establishes the thesis');
      let invalidSecondaryRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), qualityReview: draftedQualityReview(),
          coverLetterArgument: {
            ...validCoverLetterArgument(),
            secondaryEvidence: {
              evidence: 'Another supported example with no declared relationship.',
              evidenceRole: 'Earlier engineering role',
              narrativeRole: 'primary',
              relationToPrimary: 'Unspecified',
            },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { invalidSecondaryRejected = /narrativeRole is invalid/i.test(String(error?.message || error)); }
      assert(invalidSecondaryRejected,
        'Local AI import rejects an optional secondary proof without a permitted narrative role');
      let missingArgumentAttestationRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(),
          qualityReview: {
            ...draftedQualityReview(),
            resume: draftedQualityReview().resume,
            coverLetter: { decision: 'drafted', rationale: 'The cover letter is relevant, factual, and concise.' },
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch (error) { missingArgumentAttestationRejected = /controlling argument and minimum-sufficient evidence/i.test(String(error?.message || error)); }
      assert(missingArgumentAttestationRejected,
        'Local AI import requires the cover-letter quality review to attest to the controlling argument and minimum-sufficient evidence');
      let rejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><script>alert(1)</script></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rejected = true; }
      assert(rejected, 'scripts in a Local AI result cannot enter the built application workspace');
      let emDashRejected = false;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Led the migration — reducing latency.</li></ul></article></main>' }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { emDashRejected = true; }
      assert(emDashRejected, 'an em dash in candidate copy cannot enter a Local AI application');
      let rangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Led a 3–5 engineer team from Mar 2022 – Present.</li></ul></article></main>', coverLetterArgument: coverLetterArgumentForResumeEvidence('Led a 3–5 engineer team from Mar 2022 – Present.') }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { rangeAccepted = false; }
      assert(rangeAccepted, 'date and numeric en-dash ranges remain valid candidate copy');
      let monthToMonthDateRangeAccepted = true;
      try {
        validateLocalApplicationResult({ ...good, version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs', resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Software Engineer, May 2023 – June 2026.</li></ul></article></main>', coverLetterArgument: coverLetterArgumentForResumeEvidence('Software Engineer, May 2023 – June 2026.') }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { monthToMonthDateRangeAccepted = false; }
      assert(monthToMonthDateRangeAccepted, 'month-to-month date ranges remain valid candidate copy');
      let missingReviewRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: validCoverLetterArgument(),
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { missingReviewRejected = true; }
      assert(missingReviewRejected, 'every Local AI result must record a quality disposition for both documents');
      let fitOnlyRationaleRejected = false;
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: validCoverLetterArgument(),
          qualityReview: {
            ...draftedQualityReview(),
            resume: { decision: 'drafted', rationale: 'The résumé fits on the required one-page target.' },
            coverLetter: draftedQualityReview().coverLetter,
          },
        }, id, path.join(os.tmpdir(), 'local-ai-project'));
      } catch { fitOnlyRationaleRejected = true; }
      assert(fitOnlyRationaleRejected, 'page fit alone cannot serve as a quality-completion rationale');
      const structuralOverflowReview = validateLocalApplicationResult({
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: {
          ...draftedQualityReview(),
          resume: { decision: 'drafted', rationale: 'Structural reduction after the résumé remained at 2 pages: dropped the weakest role and redundant bullets while retaining the most relevant backend evidence.' },
          coverLetter: draftedQualityReview().coverLetter,
        },
      }, id, path.join(os.tmpdir(), 'local-ai-project'));
      assert(structuralOverflowReview.qualityReview.resume.decision === 'drafted',
        'a concrete structural rationale remains valid when it truthfully mentions the measured overflow that prompted the revision');
      return { rejected, emDashRejected, rangeAccepted, monthToMonthDateRangeAccepted, missingReviewRejected, fitOnlyRationaleRejected, structuralOverflowAccepted: true, summaryOnlyRejected: true };
    },
  },
  {
    name: 'Local AI application: generation audit binds final thesis, paragraphs, and sentence relationships without exposing private fields',
    run: () => {
      const id = LOCAL_AI_TEST_JOB_ID;
      const resumeMainHtml = '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
      const paragraphs = [
        'Reliable system delivery connects my supported systems work to this role. The implementation evidence explains how I make those delivery decisions.',
        'Concrete implementation decisions extend the same delivery responsibility. Their role is to connect system choices to reliable operation.',
      ];
      const coverLetter = { ...normalizedCoverLetter(), paragraphs };
      const coverLetterArgument = validCoverLetterArgument();
      const base = {
        version: LOCAL_AI_APPLICATION_VERSION,
        jobId: id,
        status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml,
        coverLetter,
        coverLetterArgument,
        qualityReview: draftedQualityReview(),
        generationAudit: generationAuditFor({
          paragraphs,
          controllingThesis: coverLetterArgument.roleThesis,
        }),
      };
      const validate = result => validateLocalApplicationResult(
        result,
        id,
        path.join(os.tmpdir(), 'local-ai-project'),
        {},
        { generationAuditVersion: LOCAL_AI_GENERATION_AUDIT_VERSION },
      );
      const clone = value => JSON.parse(JSON.stringify(value));
      const accepted = validate(base);
      assert(accepted.generationAudit?.version === LOCAL_AI_GENERATION_AUDIT_VERSION
        && accepted.generationAudit.coverLetterPlan.paragraphs.length === paragraphs.length
        && accepted.generationAudit.coverLetterPlan.paragraphs[0].sentences.length === 2,
      'a new-job audit preserves bounded final-state decisions and exact paragraph/sentence bindings');
      const technicalCopy = clone(base);
      technicalCopy.coverLetter.paragraphs = ['I logged tool calls to trace supported system behavior.'];
      technicalCopy.generationAudit = generationAuditFor({
        paragraphs: technicalCopy.coverLetter.paragraphs,
        controllingThesis: coverLetterArgument.roleThesis,
      });
      assert(validate(technicalCopy).generationAudit.coverLetterPlan.paragraphs[0].paragraph.includes('tool calls'),
        'exact final document text may discuss technical tool calls without being mistaken for a private tool transcript');

      const expectRejected = (mutate, pattern, message) => {
        const candidate = clone(base);
        mutate(candidate);
        let errorText = '';
        try { validate(candidate); } catch (error) { errorText = String(error?.message || error); }
        assert(pattern.test(errorText), `${message}; got ${JSON.stringify(errorText)}`);
      };
      expectRejected(result => { delete result.generationAudit; }, /structured generationAudit object/u,
        'new app-owned contracts reject a missing generation audit');
      expectRejected(result => { result.generationAudit.version = 99; }, /generationAudit\.version must be 1/u,
        'new app-owned contracts reject an unsupported result audit version');
      expectRejected(result => { result.generationAudit.coverLetterPlan.controllingThesis = 'A different controlling thesis replaces the actual argument.'; }, /must exactly match coverLetterArgument\.roleThesis/u,
        'the audit cannot report a thesis different from the rendered argument contract');
      expectRejected(result => { result.generationAudit.coverLetterPlan.paragraphs[0].paragraph = 'Stale paragraph text from an earlier draft.'; }, /exact normalized final paragraph/u,
        'the audit cannot bind a stale paragraph');
      expectRejected(result => { result.generationAudit.coverLetterPlan.paragraphs[0].sentences[1].sentence = 'A stale sentence from an earlier draft.'; }, /exact normalized final sentence/u,
        'the audit cannot bind a stale sentence');
      expectRejected(result => { result.generationAudit.coverLetterPlan.paragraphs[1].relationToPreviousParagraph = 'opening'; }, /substantive relation to the previous paragraph/u,
        'every later paragraph must state how it follows the prior paragraph');
      expectRejected(result => { result.generationAudit.coverLetterPlan.paragraphs[0].sentences[1].relationToPreviousSentence = 'opening'; }, /substantive relation to the previous sentence/u,
        'every later sentence must state how it follows the prior sentence');
      expectRejected(result => { result.generationAudit.finalDecisionSummary = 'sync_token: abcdefghijklmnopqrstuvwxyz123456'; }, /must not contain a credential, secret, or access token/u,
        'a permitted audit field cannot carry a credential-like value');
      expectRejected(result => { result.generationAudit.finalDecisionSummary = 'Private reasoning: here is my step-by-step reasoning transcript.'; }, /bounded final-state conclusion/u,
        'a permitted audit field cannot carry private chain-of-thought or a transcript');

      const projected = clone(base);
      projected.generationAudit.privateReasoning = 'SECRET_SENTINEL private chain-of-thought';
      projected.generationAudit.toolTranscript = 'SECRET_SENTINEL tool transcript';
      projected.generationAudit.coverLetterPlan.syncToken = 'SECRET_SENTINEL sync token';
      projected.generationAudit.coverLetterPlan.paragraphs[0].discardedDraft = 'SECRET_SENTINEL discarded copy';
      const projectedAudit = validate(projected).generationAudit;
      assert(!JSON.stringify(projectedAudit).includes('SECRET_SENTINEL')
        && projectedAudit.privateReasoning === undefined
        && projectedAudit.toolTranscript === undefined,
      'validation projects only declared final-state conclusions and drops private/raw extra fields');

      const legacy = clone(base);
      delete legacy.generationAudit;
      const acceptedLegacy = validateLocalApplicationResult(
        legacy,
        id,
        path.join(os.tmpdir(), 'local-ai-project'),
      );
      assert(acceptedLegacy.generationAudit === null,
        'a legacy queued job with no app-owned audit contract remains compatible');
      let unsupportedExpected = '';
      try {
        validateLocalApplicationResult(base, id, path.join(os.tmpdir(), 'local-ai-project'), {}, {
          generationAuditVersion: 99,
        });
      } catch (error) { unsupportedExpected = String(error?.message || error); }
      assert(/unsupported generation-audit version/u.test(unsupportedExpected),
        'an unknown app-owned generation-audit version fails closed');
      return { boundParagraphs: paragraphs.length, projected: true, legacyCompatible: true };
    },
  },
  {
    name: 'Local AI application: durable generation audit composes projected decisions, grounding, host checks, fit, and handoff history',
    run: () => {
      const coverLetterArgument = validCoverLetterArgument();
      const paragraphs = ['A concise factual letter.'];
      const result = {
        resumeMainHtml: '<main class="page">Resume</main>',
        coverLetter: { ...normalizedCoverLetter(), paragraphs },
        coverLetterArgument,
        qualityReview: groundedQualityReview(sourceGroundingFor()),
        generationAudit: generationAuditFor({
          paragraphs,
          controllingThesis: coverLetterArgument.roleThesis,
        }),
        hostValidation: {
          resumeProse: [{ id: 'resume-copy', passed: true, detail: 'Host check passed.' }],
          coverLetter: [{ id: 'cover-continuity', passed: true, detail: 'Host check passed.' }],
        },
        undeclaredRawField: 'RAW_RESULT_OBJECT_SENTINEL',
      };
      result.generationAudit.privateReasoning = 'WRITER_PRIVATE_REASONING_SENTINEL';
      result.generationAudit.toolTranscript = 'WRITER_TOOL_TRANSCRIPT_SENTINEL';
      result.coverLetterArgument.primaryEvidence.privateReasoning = 'ARGUMENT_PRIVATE_REASONING_SENTINEL';
      result.qualityReview.resume.rationale = 'api_key: QUALITY_REVIEW_SECRET_SENTINEL_abcdefghijklmnopqrstuvwxyz';
      result.qualityReview.privateReasoning = 'QUALITY_PRIVATE_REASONING_SENTINEL';
      result.hostValidation.resumeProse[0].privateReasoning = 'HOST_PRIVATE_REASONING_SENTINEL';
      result.hostValidation.resumeProse[0].detail = '/Users/jack/SECRET_HOST_CHECK_PATH_SENTINEL.log';
      const careerData = 'CAREER_DATA_SENTINEL Built supported systems.';
      const listing = '# Developer\n\nA supported job listing.';
      const resultRaw = '{"undeclared":"RAW_RESULT_TEXT_SENTINEL"}';
      const resumePdf = Buffer.from('resume-pdf-bytes');
      const coverPdf = Buffer.from('cover-pdf-bytes');
      const handoffEvent = localAiHandoffEvent({
        type: 'result-imported', resultRaw,
        resumeFit: {
          targetPageCount: 1, pageCount: 1, compactApplied: true, fontsLoaded: true, contentUtilization: 0.925641,
          layout: { contentHeightPx: 925.641, typeAreaHeightPx: 1000 },
          attempts: [{
            attempt: 1, density: 'default', pageCount: 2, fontsLoaded: true, contentUtilization: 1.08,
            layout: { contentHeightPx: 1080, typeAreaHeightPx: 1000 },
          }, {
            attempt: 2, density: 'compact', pageCount: 1, fontsLoaded: true, contentUtilization: 0.925641,
            layout: { contentHeightPx: 925.641, typeAreaHeightPx: 1000 },
          }],
        },
        coverLetterFit: { targetPageCount: 1, pageCount: 1, fontsLoaded: true, contentUtilization: 0.48 },
      });
      assert(handoffEvent.resume?.compactApplied === true
        && handoffEvent.resume?.fontsLoaded === true
        && handoffEvent.resume?.contentUtilization === 0.925641
        && handoffEvent.resume?.attempts?.[0]?.contentUtilization === 1.08
        && handoffEvent.resume?.attempts?.[0]?.layout?.utilization === 1.08
        && handoffEvent.resume?.attempts?.[1]?.contentUtilization === 0.925641
        && handoffEvent.resume?.attempts?.[1]?.layout?.utilization === 0.925641
        && handoffEvent.coverLetter?.contentUtilization === 0.48,
      'handoff events retain verification and utilization fields consumed by the audit for both documents and every résumé attempt');
      const artifactText = buildLocalGenerationAuditArtifact({
        jobId: LOCAL_AI_TEST_JOB_ID,
        input: {
          createdAt: '2026-09-05T12:00:00.000Z',
          job: {
            title: 'Developer', company: 'Acme', location: 'Remote', source: 'test',
            url: 'https://SECRET_JOB_URL_SENTINEL.test',
          },
          canvasFilePath: '/SECRET_CANVAS_PATH_SENTINEL/canvas.json',
          matchScore: 88,
          reasoning: 'api_key: abcdefghijklmnopqrstuvwxyz123456',
          targetPageCount: 1,
          qualityChecklist: { version: APPLICATION_QUALITY_CHECKLIST_VERSION },
          additionalNotes: 'RAW_ADDITIONAL_NOTES_SENTINEL',
        },
        careerData,
        jobListingMarkdown: listing,
        result,
        resultRaw,
        applicationHtml: '<html>application</html>',
        resumePdf,
        coverPdf,
        resumeFit: {
          targetPageCount: 1, pageCount: 1, compactApplied: true, fontsLoaded: true,
          contentUtilization: 0.94, layout: { contentHeightPx: 940 },
          attempts: [{
            attempt: 1,
            density: 'default',
            pageCount: 2,
            error: '/Users/jack/SECRET_RENDER_PATH_SENTINEL.log',
            privateReasoning: 'FIT_PRIVATE_REASONING_SENTINEL',
          }, { attempt: 2, density: 'compact', pageCount: 1 }],
        },
        coverLetterFit: {
          targetPageCount: 1, pageCount: 1, fontsLoaded: true,
          contentUtilization: 0.48, layout: { contentHeightPx: 480 },
        },
        importedManifest: {
          handoffEventCount: 40,
          handoffHistory: [{
            ...handoffEvent,
            at: '2026-09-05T12:05:00.000Z',
            resultSha256: 'a'.repeat(64),
            detail: 'sync_token: EVENT_SECRET_SENTINEL_abcdefghijklmnopqrstuvwxyz',
            privateReasoning: 'HANDOFF_PRIVATE_REASONING_SENTINEL',
            toolTranscript: 'HANDOFF_TOOL_TRANSCRIPT_SENTINEL',
            resume: {
              ...handoffEvent.resume,
              attempts: handoffEvent.resume.attempts.map((attempt, index) => (
                index === 0 ? { ...attempt, error: '/private/tmp/SECRET_EVENT_RENDER_PATH_SENTINEL.log' } : attempt
              )),
              internalPath: '/Users/jack/SECRET_EVENT_INTERNAL_PATH_SENTINEL',
            },
          }],
        },
        generationAuditRequired: true,
        createdAt: '2026-09-05T12:06:00.000Z',
      });
      const artifact = JSON.parse(artifactText);
      assert(artifact.version === LOCAL_AI_GENERATION_AUDIT_VERSION
        && artifact.schema === 'infinite-canvas-generation-audit'
        && artifact.jobId === LOCAL_AI_TEST_JOB_ID
        && artifact.createdAt === '2026-09-05T12:06:00.000Z',
      'the app authors a stable, versioned durable audit envelope');
      assert(artifact.writerAudit.coverLetterPlan.controllingThesis === coverLetterArgument.roleThesis
        && artifact.writerQualityReview.criteria.length === APPLICATION_QUALITY_CRITERIA.length
        && artifact.writerQualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes[0] === 'Built supported systems.'
        && artifact.coverLetterArgument.roleThesis === coverLetterArgument.roleThesis
        && artifact.hostValidation.coverLetter[0].passed === true,
      'the durable file composes projected writer decisions, full validated review/grounding, argument contract, and host checks');
      assert(artifact.measuredFit.resume.pageCount === 1
        && artifact.measuredFit.resume.attempts.length === 2
        && artifact.measuredFit.coverLetter.pageCount === 1
        && artifact.handoff.events[0]?.resume?.compactApplied === true
        && artifact.handoff.events[0]?.resume?.fontsLoaded === true
        && artifact.handoff.events[0]?.resume?.contentUtilization === 0.925641
        && artifact.handoff.events[0]?.resume?.attempts[0]?.contentUtilization === 1.08
        && artifact.handoff.events[0]?.resume?.attempts[0]?.layout?.utilization === 1.08
        && artifact.handoff.events[0]?.resume?.attempts[1]?.contentUtilization === 0.925641
        && artifact.handoff.events[0]?.resume?.attempts[1]?.layout?.utilization === 0.925641
        && artifact.handoff.events[0]?.coverLetter?.contentUtilization === 0.48
        && artifact.handoff.eventCount === 40
        && artifact.handoff.retainedEventCount === 1
        && artifact.handoff.historyTruncated === true,
      'the audit preserves app-owned fit attempts and makes bounded handoff-history truncation explicit');
      assert(artifact.finalArtifacts.resultSha256 === sha256(resultRaw)
        && artifact.finalArtifacts.resumePdfSha256 === sha256(resumePdf)
        && artifact.finalArtifacts.coverLetterPdfSha256 === sha256(coverPdf)
        && artifact.inputSummary.inputDigests.careerDataSha256 === sha256(careerData),
      'the audit binds final and source inputs with full hashes without copying raw private corpora');
      assert(artifact.inputSummary.matchRationale.includes('omitted from durable audit')
        && !artifactText.includes('abcdefghijklmnopqrstuvwxyz123456')
        && !artifactText.includes('RAW_RESULT_OBJECT_SENTINEL')
        && !artifactText.includes('RAW_RESULT_TEXT_SENTINEL')
        && !artifactText.includes('CAREER_DATA_SENTINEL')
        && !artifactText.includes('RAW_ADDITIONAL_NOTES_SENTINEL')
        && !artifactText.includes('SECRET_JOB_URL_SENTINEL')
        && !artifactText.includes('SECRET_CANVAS_PATH_SENTINEL')
        && !artifactText.includes('PRIVATE_REASONING_SENTINEL')
        && !artifactText.includes('TOOL_TRANSCRIPT_SENTINEL')
        && !artifactText.includes('SECRET_SENTINEL_abcdefghijklmnopqrstuvwxyz')
        && !artifactText.includes('SECRET_RENDER_PATH_SENTINEL')
        && !artifactText.includes('SECRET_HOST_CHECK_PATH_SENTINEL')
        && !artifactText.includes('SECRET_EVENT_RENDER_PATH_SENTINEL')
        && !artifactText.includes('SECRET_EVENT_INTERNAL_PATH_SENTINEL')
        && !artifactText.includes('privateReasoning')
        && !artifactText.includes('toolTranscript'),
      'the durable projection omits credentials, undeclared raw/result/manifest fields, private reasoning, transcripts, corpora, notes, job URLs, and live filesystem paths');
      return { version: artifact.version, checks: artifact.writerQualityReview.criteria.length, attempts: artifact.measuredFit.resume.attempts.length };
    },
  },
  {
    name: 'Local AI application: durable audit requiredness preserves true legacy jobs without weakening new jobs',
    run: async () => {
      const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-ai-legacy-audit-')));
      const legacyPath = path.join(dir, 'legacy-audit.json');
      const requiredPath = path.join(dir, 'required-audit.json');
      const coverLetterArgument = validCoverLetterArgument();
      const result = {
        resumeMainHtml: '<main class="page">Resume</main>',
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument,
        qualityReview: groundedQualityReview(sourceGroundingFor()),
        hostValidation: {
          resumeProse: [{ id: 'resume-copy', passed: true, detail: 'Host check passed.' }],
          resumeRoleLocations: { id: 'resume-role-locations', passed: true, detail: 'Host check passed.' },
          resumeProjectProvenance: { id: 'resume-project-provenance', passed: true, detail: 'Host check passed.' },
          coverLetter: [{ id: 'cover-continuity', passed: true, detail: 'Host check passed.' }],
          dashPunctuation: { id: 'candidate-dash-punctuation', passed: true, detail: 'Host check passed.' },
        },
      };
      try {
        const build = generationAuditRequired => buildLocalGenerationAuditArtifact({
          jobId: LOCAL_AI_TEST_JOB_ID,
          input: { job: { title: 'Developer', company: 'Acme' } },
          result,
          generationAuditRequired,
          createdAt: '2026-09-05T12:06:00.000Z',
        });
        const legacyArtifact = build(false);
        const requiredArtifact = build(true);
        await Promise.all([
          fs.promises.writeFile(legacyPath, legacyArtifact, 'utf8'),
          fs.promises.writeFile(requiredPath, requiredArtifact, 'utf8'),
        ]);
        const legacyInspection = await inspectApplicationExport([{
          path: legacyPath,
          expectedData: legacyArtifact,
          kind: 'generation-audit',
          expectedJobId: LOCAL_AI_TEST_JOB_ID,
          expectedGenerationAuditRequired: false,
        }]);
        assert(legacyInspection[0]?.integrityVerified
          && legacyInspection[0].generationAuditRequirednessValid
          && legacyInspection[0].generationAuditStructureValid
          && JSON.parse(legacyArtifact).writerAudit === null,
        'a true legacy job emits a valid app-owned durable audit with explicit required=false and writerAudit=null');

        const requiredError = await inspectApplicationExport([{
          path: requiredPath,
          expectedData: requiredArtifact,
          kind: 'generation-audit',
          expectedJobId: LOCAL_AI_TEST_JOB_ID,
          expectedGenerationAuditRequired: true,
        }]).then(() => null, error => error);
        assert(/readback failed/u.test(String(requiredError?.message || requiredError)),
          'a new-job durable audit cannot claim required=true while omitting its writerAudit');
        return { legacyAccepted: true, requiredNullRejected: true };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: status treats malformed result.json as invalid without importing it',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const trustedCareerData = 'Built supported systems. More relevant evidence. A concise factual letter.';
        const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: trustedCareerData, canvasFilePath: project.canvasFilePath });
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), '{bad json', 'utf8');
        const status = await localApplicationStatus(queued.id, project.canvasFilePath);
        // A hard rejection must leave a trace in the ONE job-folder file the
        // waiting local-agent session is allowed to read. Without this the
        // session cannot tell a rejected result from an app that never ran, and
        // can only burn its wait (local_ai/LOCAL_AI_APPLICATION_ROUTINE.md §7).
        const rejection = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'fit-feedback.json'), 'utf8'));
        // REGRESSION GUARD. The rejection record's resultSha256 is, by
        // construction, the hash of the CURRENT result.json — so a consumer that
        // matches feedback on jobId+hash alone would treat it as a measured
        // verdict. importLocalApplicationJobUnlocked did exactly that, which let
        // a Retry-import click walk past assertLocalAiQualityReviewConsistency on
        // a result the status poll had just rejected. Both consumers must gate on
        // the measured-status allow-list, not on the hash match alone.
        const importSource = await fs.promises.readFile(path.join(process.cwd(), 'electron', 'ipc', 'localAiApplication.js'), 'utf8');
        assert(/const measuredPriorFeedback = matchingPriorFeedback\s*\n?\s*&& \['revision-required', 'revision-exhausted'\]\.includes\(priorFeedback\?\.status\)/.test(importSource)
          && /const documentSha256 = assertLocalAiQualityReviewConsistency\(result, priorFeedback\)/.test(importSource)
          && !/const documentSha256 = matchingPriorFeedback/.test(importSource),
          'the import path gates the quality-review assert on a MEASURED prior verdict, so an invalid rejection record cannot skip it');
        assert(rejection.status === 'invalid' && rejection.measured === false
          && rejection.jobId === queued.id
          && typeof rejection.resultSha256 === 'string' && rejection.resultSha256.length === 64
          // Assert the ERROR field, not `message`: `message` is fixed boilerplate
          // that contains the literal "result.json", so a /JSON/i test against it
          // passes even when the real reason was never recorded.
          && /JSON|Unexpected/i.test(String(rejection.error || ''))
          && rejection.error.length > 0 && rejection.error.length <= 500
          && rejection.resume === undefined && rejection.coverLetter === undefined,
          'a hard validation rejection writes a non-measured invalid record carrying the rejected bytes\' hash, and no page/layout data that could read as a measurement');
        const rejectionManifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        const rejectionEvent = rejectionManifest.handoffHistory?.at(-1);
        assert(rejectionEvent?.type === 'result-validation-rejected'
          && typeof rejectionEvent.resultSha256 === 'string' && rejectionEvent.resultSha256.length === 64
          && /JSON|Unexpected/i.test(String(rejectionEvent.detail || '')),
        'a distinct validation rejection also enters app-owned handoff history with its full result hash so the final durable audit retains the repair sequence');
        assert(status.status === 'invalid' && /JSON|Unexpected/i.test(status.message),
          'bad result JSON is surfaced as an actionable invalid state');
        const linkedResultTarget = path.join(project.root, 'outside-result.json');
        await fs.promises.writeFile(linkedResultTarget, '{}', 'utf8');
        await fs.promises.unlink(path.join(queued.folder, 'result.json'));
        await fs.promises.symlink(linkedResultTarget, path.join(queued.folder, 'result.json'), process.platform === 'win32' ? 'file' : undefined);
        const linkedStatus = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(linkedStatus.status === 'invalid' && /regular file|link/i.test(linkedStatus.message),
          'a result.json symlink is rejected at the no-follow read boundary');
        const otherProject = await createCanvasProject();
        try {
          let crossCanvasRejected = false;
          try { await localApplicationStatus(queued.id, otherProject.canvasFilePath); } catch { crossCanvasRejected = true; }
          assert(crossCanvasRejected, 'a job id cannot be reopened from a different canvas directory');
        } finally {
          await fs.promises.rm(otherProject.root, { recursive: true, force: true });
        }
        return { status: status.status, linkedStatus: linkedStatus.status };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: a cleaned-up job folder is a terminal polling state, not an IPC ENOENT',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath });
        await fs.promises.rm(queued.folder, { recursive: true, force: true });
        const status = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(status.status === 'failed' && /no longer available|cleaned up/i.test(status.message),
          'a removed private job folder produces a terminal, actionable status instead of propagating ENOENT through the IPC handler');
        const cardSource = await fs.promises.readFile(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
        assert(cardSource.includes("!['saved', 'failed'].includes(localApplication.status)"),
          'the card does not offer a folder-open action after the app reports that the folder is gone');
        return { status: status.status };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI application: invalid and transient status failures remain eligible for automatic recovery',
    run: async () => {
      const cardSource = await fs.promises.readFile(path.resolve('src/nodes/JobCardNode.jsx'), 'utf8');
      const fallbackSource = await fs.promises.readFile(path.resolve('src/hooks/useLocalAiFallbackManager.js'), 'utf8');
      assert(/LOCAL_AI_CARD_POLL_IDLE_STATUSES\.includes\(localApplication\.status\)\) return undefined;/.test(cardSource),
        "the card's poll gate consumes the shared idle-status constant — one source of truth with the fallback manager, so the two drivers' idle sets cannot silently diverge");
      assert(!LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('invalid'),
        'invalid results remain eligible for status polling after Local AI corrects result.json');
      assert(cardSource.includes("status: 'status-error'")
        && cardSource.includes('LOCAL_AI_STATUS_ERROR_STREAK_LIMIT')
        && fallbackSource.includes("status: 'status-error'")
        && fallbackSource.includes('LOCAL_AI_STATUS_ERROR_STREAK_LIMIT'),
      'both mounted and fallback pollers surface repeated transient status failures as retryable status-error, never terminal failed');
      assert(!LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('status-error')
        && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('status-error'),
      'neither poll driver idles on status-error, so the next successful status check reconnects automatically');
      return { invalidRecoveryPolling: true, transientFailureRecovery: true };
    },
  },
  {
    name: 'Local AI application: measured overflow waits for an AI revision, then accepts a changed result',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const trustedCareerData = 'Built supported systems. More relevant evidence. A concise factual letter.';
        const queued = await queueLocalApplicationJob({ job: { title: 'Developer', company: 'Acme' }, careerData: trustedCareerData, canvasFilePath: project.canvasFilePath });
        const validResumeMain = '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
        const result = {
          version: LOCAL_AI_APPLICATION_VERSION, jobId: queued.id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence('Built supported systems.', 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor()),
        };
        const resultText = `${JSON.stringify(result)}\n`;
        const canonicalResult = validateLocalApplicationResult(
          result,
          queued.id,
          project.root,
          { title: 'Developer', company: 'Acme' },
          { careerData: trustedCareerData },
        );
        const documentSha256 = {
          resume: sha256(canonicalResult.resumeMainHtml),
          coverLetter: sha256(JSON.stringify(canonicalResult.coverLetter)),
        };
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), resultText, 'utf8');
        const ready = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(ready.status === 'completed' && ready.resultSha256 === sha256(resultText),
          'a completed Local AI status supplies the exact result hash so the renderer can wait for a stable final write');
        await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), `${JSON.stringify({
          version: 1, jobId: queued.id, status: 'revision-required', revisionRound: 17,
          resultSha256: sha256(resultText), documentSha256,
          resume: { targetPageCount: 1, pageCount: 2 }, coverLetter: { targetPageCount: 1, pageCount: 1 },
          message: 'résumé is 2 pages (target: 1). Re-run the Local AI routine.',
        })}\n`, 'utf8');
        const revisionRequired = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(revisionRequired.status === 'revision-required' && /2 page/.test(revisionRequired.message),
          'matching app feedback holds the result for a content-aware Local AI revision even beyond the old fixed limit');

        const diminishingResult = {
          ...result,
          qualityReview: {
            ...groundedQualityReview(sourceGroundingFor()),
            resume: { decision: 'kept_diminishing_returns', rationale: 'No remaining cut preserves more priority evidence than it removes from the résumé.' },
            coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material improvement remains: one controlling argument still uses minimum-sufficient evidence.' },
          },
        };
        const diminishingText = `${JSON.stringify(diminishingResult)}\n`;
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), diminishingText, 'utf8');
        const reviewed = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(reviewed.status === 'invalid' && /must materially regenerate the résumé/i.test(reviewed.message),
          'an unchanged document cannot use diminishing returns to override an unsatisfied measured layout criterion');
        const invalidFeedback = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'fit-feedback.json'), 'utf8'));
        assert(invalidFeedback.status === 'invalid'
          && invalidFeedback.priorMeasured?.documentSha256?.resume === documentSha256.resume
          && invalidFeedback.priorMeasured?.resume?.pageCount === 2,
        'an intervening invalid result retains the complete prior measured snapshot instead of erasing the hard layout invariant');
        const stillUnchanged = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(stillUnchanged.status === 'invalid' && /must materially regenerate the résumé/i.test(stillUnchanged.message),
          'the preserved prior measurement rejects the unchanged failed résumé even after an intervening invalid result');
        await fs.promises.writeFile(path.join(queued.folder, 'fit-feedback.json'), `${JSON.stringify({
          version: 1, jobId: queued.id, status: 'revision-exhausted', revisionRound: 18,
          resultSha256: sha256(diminishingText), documentSha256,
          message: 'The overflowing résumé remained unchanged after an explicit diminishing-returns review.',
        })}\n`, 'utf8');
        const legacyExhausted = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(legacyExhausted.status === 'revision-required' && /diminishing-returns/.test(legacyExhausted.message),
          'legacy revision-exhausted feedback is resumed as nonterminal revision-required work rather than ending the AI regeneration loop');

        const changedResult = {
          ...result,
          resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>More relevant evidence.</li></ul></article></section></main>',
          coverLetterArgument: coverLetterArgumentForResumeEvidence('More relevant evidence.', 'Developer at Acme'),
          qualityReview: {
            ...groundedQualityReview(sourceGroundingFor({ resumeBullets: ['More relevant evidence.'] })),
            resume: { decision: 'changed_materially', rationale: 'Replaced weaker material with more relevant and specifically supported résumé evidence.' },
            coverLetter: { decision: 'kept_diminishing_returns', rationale: 'No material improvement remains: one controlling argument still uses minimum-sufficient evidence.' },
          },
        };
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), `${JSON.stringify(changedResult, null, 2)}\n`, 'utf8');
        const revised = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(revised.status === 'completed', 'a materially changed résumé and unchanged diminishing-returns cover letter clear stale feedback and return to import-ready state');
        return { held: revisionRequired.status, legacyResumed: legacyExhausted.status, revised: revised.status };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI handoff: invalid, measured, invalid, atomic correction receives one hash-bound response',
    run: async () => {
      const project = await createCanvasProject();
      let releaseDRender = () => {};
      let admittedImportPromiseD = null;
      const overlongBullet = 'Built supported systems with clear outcomes, sustained ownership, concrete engineering judgment, careful operational validation, reliable release controls, documented decisions, and durable support practices across the full delivery lifecycle.';
      const initialBullet = 'Built supported systems.';
      const revisedBullet = 'More relevant evidence.';
      const careerData = `${overlongBullet} ${initialBullet} ${revisedBullet} A concise factual letter.`;
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData,
          canvasFilePath: project.canvasFilePath,
        });
        const resultPath = path.join(queued.folder, 'result.json');
        const feedbackPath = path.join(queued.folder, 'fit-feedback.json');
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const receiptFile = path.join(project.root, '.local-ai', 'handoff-receipts', `${queued.id}.json`);
        const resumeMain = bullet => `<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>${bullet}</li></ul></article></section></main>`;
        const resultFor = (bullet, qualityReview) => ({
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: resumeMain(bullet),
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence(bullet, 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview,
        });

        // A: validation consumes the exact bytes and responds without rendering.
        const resultA = await atomicReplaceJson(resultPath, resultFor(
          overlongBullet,
          groundedQualityReview(sourceGroundingFor({ resumeBullets: [overlongBullet] })),
        ));
        const statusA = await localApplicationStatus(queued.id, project.canvasFilePath);
        const feedbackA = JSON.parse(await fs.promises.readFile(feedbackPath, 'utf8'));
        assert(statusA.status === 'invalid' && feedbackA.status === 'invalid'
          && feedbackA.measured === false && feedbackA.resultSha256 === resultA.sha256
          && /resume-bullet-length/i.test(`${statusA.message} ${feedbackA.error}`),
        `hash A must receive exact non-measured invalid feedback for the overlong résumé bullet, got ${JSON.stringify({ statusA, feedbackA })}`);

        // B: inject the measured renderer verdict at the unit boundary. Status
        // owns detection/validation here; the Electron render mechanics have
        // their own fixtures below and in application-pdf-reconcile.js.
        const resultBValue = resultFor(
          initialBullet,
          groundedQualityReview(sourceGroundingFor({ resumeBullets: [initialBullet] })),
        );
        const resultB = await atomicReplaceJson(resultPath, resultBValue);
        const statusB = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(statusB.status === 'completed' && statusB.resultSha256 === resultB.sha256,
          'corrected hash B must be detected after invalid feedback');
        const canonicalB = validateLocalApplicationResult(
          resultBValue, queued.id, project.root, { title: 'Developer', company: 'Acme' }, { careerData },
        );
        const documentSha256B = {
          resume: sha256(canonicalB.resumeMainHtml),
          coverLetter: sha256(JSON.stringify(canonicalB.coverLetter)),
        };
        await atomicReplaceJson(feedbackPath, {
          version: 1,
          jobId: queued.id,
          status: 'revision-required',
          measured: true,
          revisionRound: 1,
          resultSha256: resultB.sha256,
          documentSha256: documentSha256B,
          targetPageCount: 1,
          resume: { targetPageCount: 1, pageCount: 2 },
          coverLetter: { targetPageCount: 1, pageCount: 1 },
          message: 'The résumé is 2 pages (target: 1). Continue with measured revision 1.',
        });
        const measuredB = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(measuredB.status === 'revision-required',
          'hash B must remain bound to its measured revision-required response');

        // C: a material revision with an invalid attestation must preserve B's
        // measured snapshot, but its response is bound only to C.
        const revisedGrounding = groundedQualityReview(sourceGroundingFor({ resumeBullets: [revisedBullet] }));
        const resultCValue = resultFor(revisedBullet, {
          ...revisedGrounding,
          resume: {
            decision: 'changed_materially',
            rationale: 'Replaced weaker material with more relevant and specifically supported résumé evidence.',
          },
          coverLetter: {
            decision: 'kept_diminishing_returns',
            rationale: 'The unchanged cover letter remains factually supported and relevant to the role.',
          },
        });
        const resultC = await atomicReplaceJson(resultPath, resultCValue);
        const statusC = await localApplicationStatus(queued.id, project.canvasFilePath);
        const feedbackC = JSON.parse(await fs.promises.readFile(feedbackPath, 'utf8'));
        assert(statusC.status === 'invalid' && feedbackC.status === 'invalid'
          && feedbackC.resultSha256 === resultC.sha256
          && feedbackC.priorMeasured?.status === 'revision-required'
          && feedbackC.priorMeasured?.revisionRound === 1
          && feedbackC.priorMeasured?.documentSha256?.resume === documentSha256B.resume
          && /controlling argument|minimum-sufficient/i.test(`${statusC.message} ${feedbackC.error}`),
        'hash C must receive invalid feedback while retaining B\'s trusted measured revision state');

        // D: atomically replace C, then prove C's stale feedback cannot satisfy
        // either hash while the corrected bytes settle.
        const resultDValue = resultFor(revisedBullet, {
          ...revisedGrounding,
          resume: resultCValue.qualityReview.resume,
          coverLetter: {
            decision: 'kept_diminishing_returns',
            rationale: 'No material improvement remains: one controlling argument still uses minimum-sufficient evidence.',
          },
        });
        const resultD = await atomicReplaceJson(resultPath, resultDValue);
        const staleCBeforeConsume = await inspectLocalAiHandoff({
          jobFolder: queued.folder, receiptFile, jobId: queued.id, resultSha256: resultC.sha256,
        });
        const waitingD = await inspectLocalAiHandoff({
          jobFolder: queued.folder, receiptFile, jobId: queued.id, resultSha256: resultD.sha256,
        });
        assert(staleCBeforeConsume.outcome === 'waiting' && waitingD.outcome === 'waiting',
          'stale feedback for C cannot satisfy the helper for C after D replaces the file, or for D before its own response exists');
        const statusD = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(statusD.status === 'completed' && statusD.resultSha256 === resultD.sha256,
          'atomically replaced hash D must be detected after the invalid → measured → invalid sequence');

        // Drive D through the real main-process import. The plain-Node unit
        // runner has no Chromium BrowserWindow, so substitute only that leaf
        // dependency; hash admission, the per-job mutex, both fit loops,
        // staging, manifest persistence, and capability registration remain
        // production code. Hold the first document render to make the second
        // driver's overlap deterministic.
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        const renderedDocumentsD = [];
        let firstRenderStartedResolve;
        let releaseFirstRenderResolve;
        const firstRenderStarted = new Promise(resolve => { firstRenderStartedResolve = resolve; });
        const holdFirstRender = new Promise(resolve => { releaseFirstRenderResolve = resolve; });
        releaseDRender = () => releaseFirstRenderResolve?.();
        __setLocalAiRenderPdfForTests(async (html, { signal } = {}) => {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          renderedDocumentsD.push(String(html));
          if (renderedDocumentsD.length === 1) {
            firstRenderStartedResolve();
            await holdFirstRender;
          }
          return {
            bytes: Buffer.from(fixturePdfBytes),
            pageCount: 1,
            fontsLoaded: true,
            missingFontFaces: [],
            layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
          };
        });

        const senderId = 9107;
        const sender = {
          id: senderId,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };

        const staleImportError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId,
          expectedResultSha256: resultC.sha256,
        }).then(() => null, error => error);
        assert(staleImportError?.code === 'LOCAL_AI_RESULT_CHANGED' && renderedDocumentsD.length === 0,
          'a driver holding stale hash C must be rejected before any render after atomic D appears');

        admittedImportPromiseD = importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId,
          expectedResultSha256: resultD.sha256,
        });
        await Promise.race([
          firstRenderStarted,
          admittedImportPromiseD.then(
            () => { throw new Error('D import completed without entering its renderer.'); },
            error => { throw error; },
          ),
        ]);
        const duplicateImportError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId,
          expectedResultSha256: resultD.sha256,
        }).then(() => null, error => error);
        assert(duplicateImportError?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'a concurrent second production driver for D must lose the per-job import claim');
        releaseDRender();
        const importedD = await admittedImportPromiseD;
        assert(importedD.status === 'imported' && importedD.workDir === queued.folder
          && renderedDocumentsD.length === 2,
        `the admitted D import must stage one résumé and one cover-letter render, got ${renderedDocumentsD.length} render calls`);

        const settledDuplicateError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId,
          expectedResultSha256: resultD.sha256,
        }).then(() => null, error => error);
        assert(settledDuplicateError?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT'
          && renderedDocumentsD.length === 2,
        'the imported-manifest save window must reject a later duplicate D driver without another render');

        // Replace the already-materialized registered output root with a file.
        // The real save handler then fails deterministically before destination
        // mutation and publishes D's registered hash-bound failure callback.
        const blockedOutputRoot = path.join(project.root, 'Applied Jobs');
        await fs.promises.rm(blockedOutputRoot, { recursive: true, force: true });
        await fs.promises.writeFile(blockedOutputRoot, 'not a directory', 'utf8');
        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        const saveArgs = {
          resumeHtmlPath: importedD.resumeHtmlPath,
          resumePdfPath: importedD.resumePdfPath,
          coverLetterPdfPath: importedD.coverLetterPdfPath,
          jobListingPath: importedD.jobListingPath,
          generationAuditPath: importedD.generationAuditPath,
          workDir: importedD.workDir,
          jobTitle: 'Developer',
          location: '',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        };
        const admittedSavePromise = saveApplication({ sender }, saveArgs);
        const duplicateSavePromise = saveApplication({ sender }, saveArgs);
        const [failedSave, duplicateSave] = await Promise.all([admittedSavePromise, duplicateSavePromise]);
        assert(failedSave?.success === false
          && duplicateSave?.success === false
          && duplicateSave.errorCode === 'APPLICATION_SAVE_IN_FLIGHT',
        'only one concurrent D save may enter the production destination path');

        const afterFailure = await localApplicationStatus(queued.id, project.canvasFilePath);
        const feedbackD = JSON.parse(await fs.promises.readFile(feedbackPath, 'utf8'));
        const manifestD = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const importEventsD = (manifestD.handoffHistory || []).filter(event =>
          event?.type === 'result-imported' && event?.resultSha256 === resultD.sha256);
        const failureEventsD = (manifestD.handoffHistory || []).filter(event =>
          event?.type === 'bundle-save-retry-required' && event?.resultSha256 === resultD.sha256);
        const handoffD = await inspectLocalAiHandoff({
          jobFolder: queued.folder, receiptFile, jobId: queued.id, resultSha256: resultD.sha256,
        });
        const staleCAfterResponse = await inspectLocalAiHandoff({
          jobFolder: queued.folder, receiptFile, jobId: queued.id, resultSha256: resultC.sha256,
        });
        assert(afterFailure.status === 'render-retry-required'
          && afterFailure.resultSha256 === resultD.sha256
          && feedbackD.status === 'render-retry-required' && feedbackD.measured === false
          && feedbackD.resultSha256 === resultD.sha256
          && feedbackD.resume === undefined && feedbackD.coverLetter === undefined
          && feedbackD.priorMeasured?.revisionRound === 1
          && manifestD.status === 'render-retry-required'
          && manifestD.handoffHistory?.at(-1)?.type === 'bundle-save-retry-required'
          && manifestD.handoffHistory?.at(-1)?.resultSha256 === resultD.sha256
          && importEventsD.length === 1
          && failureEventsD.length === 1
          && !fs.existsSync(receiptFile)
          && handoffD.outcome === 'render-retry-required'
          && staleCAfterResponse.outcome === 'waiting'
          && LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes(afterFailure.status)
          && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes(afterFailure.status),
        'a consumed D must receive exact non-measured retry feedback that parks automatic import while keeping the fallback manager alive to expose explicit recovery; stale C remains nonterminal');
        assert(renderedDocumentsD.length === 2
          && await fs.promises.lstat(importedD.workDir).then(stat => stat.isDirectory()),
        'D must have exactly one admitted import (one render per document) and one admitted save; its retryable workspace remains recoverable');
        return {
          transitions: [statusA.status, measuredB.status, statusC.status, statusD.status, afterFailure.status],
          atomicHash: resultD.sha256,
          admittedImportsD: 1,
          renderedDocumentsD: renderedDocumentsD.length,
          admittedSavesD: 1,
          helperOutcome: handoffD.outcome,
        };
      } finally {
        releaseDRender();
        await admittedImportPromiseD?.catch(() => {});
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI import: a held stale rejection cannot roll back a newer imported manifest',
    run: async () => {
      const project = await createCanvasProject();
      const originalLstat = fs.promises.lstat;
      let releaseFeedbackRead = () => {};
      let statusPromise = null;
      let importPromise = null;
      let renderCalls = 0;
      try {
        const overlongBullet = 'Built supported systems with clear outcomes, sustained ownership, concrete engineering judgment, careful operational validation, reliable release controls, documented decisions, and durable support practices across the full delivery lifecycle.';
        const careerData = `${overlongBullet} Built supported systems. A concise factual letter.`;
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData,
          canvasFilePath: project.canvasFilePath,
        });
        const resultPath = path.join(queued.folder, 'result.json');
        const feedbackPath = path.join(queued.folder, 'fit-feedback.json');
        const resultFor = (bullet) => ({
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: `<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>${bullet}</li></ul></article></section></main>`,
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence(bullet, 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor({ resumeBullets: [bullet] })),
        });
        await atomicReplaceJson(resultPath, resultFor(overlongBullet));

        let feedbackReadStartedResolve;
        let releaseFeedbackReadResolve;
        const feedbackReadStarted = new Promise(resolve => { feedbackReadStartedResolve = resolve; });
        const heldFeedbackRead = new Promise(resolve => { releaseFeedbackReadResolve = resolve; });
        releaseFeedbackRead = () => releaseFeedbackReadResolve?.();
        let held = false;
        fs.promises.lstat = async function heldFeedbackLstat(target, ...args) {
          if (!held && path.resolve(String(target)) === path.resolve(feedbackPath)) {
            held = true;
            feedbackReadStartedResolve();
            await heldFeedbackRead;
          }
          return originalLstat.call(this, target, ...args);
        };

        statusPromise = localApplicationStatus(queued.id, project.canvasFilePath);
        await feedbackReadStarted;
        const currentResult = await atomicReplaceJson(resultPath, resultFor('Built supported systems.'));
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        __setLocalAiRenderPdfForTests(async () => {
          renderCalls += 1;
          return {
            bytes: Buffer.from(fixturePdfBytes),
            pageCount: 1,
            fontsLoaded: true,
            missingFontFaces: [],
            layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
          };
        });
        importPromise = importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9115,
          expectedResultSha256: currentResult.sha256,
        });
        releaseFeedbackRead();
        const [staleStatus, imported] = await Promise.all([statusPromise, importPromise]);
        statusPromise = null;
        importPromise = null;
        fs.promises.lstat = originalLstat;

        const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        const settled = await localApplicationStatus(queued.id, project.canvasFilePath);
        const duplicateError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9115,
          expectedResultSha256: currentResult.sha256,
        }).then(() => null, error => error);
        assert(staleStatus.status === 'invalid'
          && imported.status === 'imported'
          && manifest.status === 'imported'
          && manifest.importedResultSha256 === currentResult.sha256
          && settled.status === 'importing'
          && duplicateError?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT'
          && renderCalls === 2
          && !fs.existsSync(feedbackPath),
        `a stale rejection must yield to the serialized newer import without feedback or manifest rollback, got ${JSON.stringify({ staleStatus: staleStatus.status, imported: imported.status, manifest: manifest.status, settled: settled.status, duplicateCode: duplicateError?.code, renderCalls })}`);

        registerJobApplicationHandlers();
        const discardApplication = ipcMain.__getInvokeHandler('discard-application');
        const sender = {
          id: 9115,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };
        const discarded = await discardApplication({ sender }, { workDir: imported.workDir });
        assert(discarded?.success && discarded.discarded,
          'the exact imported fixture capability remains cleanly disposable after the race regression');
        return { manifestStatus: manifest.status, duplicateCode: duplicateError.code, renderCalls };
      } finally {
        releaseFeedbackRead();
        fs.promises.lstat = originalLstat;
        await Promise.allSettled([statusPromise, importPromise].filter(Boolean));
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI import: post-render workspace failures publish one exact retry response',
    run: async () => {
      const project = await createCanvasProject();
      let renderCalls = 0;
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData: 'Built supported systems. A concise factual letter.',
          canvasFilePath: project.canvasFilePath,
        });
        const blockedOutputRoot = path.join(project.root, 'Blocked');
        await fs.promises.writeFile(blockedOutputRoot, 'not a directory', 'utf8');
        const resultPath = path.join(queued.folder, 'result.json');
        const feedbackPath = path.join(queued.folder, 'fit-feedback.json');
        const receiptFile = path.join(project.root, '.local-ai', 'handoff-receipts', `${queued.id}.json`);
        const result = await atomicReplaceJson(resultPath, {
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Blocked',
          resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>',
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence('Built supported systems.', 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor()),
        });
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        __setLocalAiRenderPdfForTests(async () => {
          renderCalls += 1;
          return {
            bytes: Buffer.from(fixturePdfBytes),
            pageCount: 1,
            fontsLoaded: true,
            missingFontFaces: [],
            layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
          };
        });

        const ready = await localApplicationStatus(queued.id, project.canvasFilePath);
        const importError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9112,
          expectedResultSha256: result.sha256,
        }).then(() => null, error => error);
        const feedback = JSON.parse(await fs.promises.readFile(feedbackPath, 'utf8'));
        const afterFailure = await localApplicationStatus(queued.id, project.canvasFilePath);
        const afterAnotherPoll = await localApplicationStatus(queued.id, project.canvasFilePath);
        const handoff = await inspectLocalAiHandoff({
          jobFolder: queued.folder,
          receiptFile,
          jobId: queued.id,
          resultSha256: result.sha256,
        });
        assert(ready.status === 'completed'
          && importError
          && feedback.status === 'render-retry-required'
          && feedback.measured === false
          && feedback.resultSha256 === result.sha256
          && feedback.failurePhase === 'preparing application output'
          && afterFailure.status === 'render-retry-required'
          && afterFailure.resultSha256 === result.sha256
          && afterAnotherPoll.status === 'render-retry-required'
          && renderCalls === 2
          && handoff.outcome === 'render-retry-required'
          && !fs.existsSync(receiptFile)
          && LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes(afterFailure.status)
          && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes(afterFailure.status),
        `a failure after one render per document must park automatic import for the exact hash while leaving fallback polling active solely to offer explicit recovery, got ${JSON.stringify({ ready: ready.status, error: importError?.message, feedback, afterFailure: afterFailure.status, afterAnotherPoll: afterAnotherPoll.status, renderCalls, helper: handoff.outcome })}`);
        return { response: feedback.status, renderCalls, helperOutcome: handoff.outcome };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI import: a failed final manifest commit leaves no unreachable save capability',
    run: async () => {
      const project = await createCanvasProject();
      const originalRename = fs.promises.rename;
      let blockedImportedManifestWrites = 0;
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData: 'Built supported systems. A concise factual letter.',
          canvasFilePath: project.canvasFilePath,
        });
        const resultPath = path.join(queued.folder, 'result.json');
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const feedbackPath = path.join(queued.folder, 'fit-feedback.json');
        const result = await atomicReplaceJson(resultPath, {
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>',
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence('Built supported systems.', 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor()),
        });
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        __setLocalAiRenderPdfForTests(async () => ({
          bytes: Buffer.from(fixturePdfBytes),
          pageCount: 1,
          fontsLoaded: true,
          missingFontFaces: [],
          layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
        }));

        fs.promises.rename = async (from, to) => {
          if (path.resolve(String(to)) === path.resolve(manifestPath)) {
            const candidate = JSON.parse(await fs.promises.readFile(from, 'utf8'));
            if (candidate?.status === 'imported') {
              blockedImportedManifestWrites += 1;
              const error = new Error('simulated final imported-manifest write failure');
              error.code = 'EIO';
              throw error;
            }
          }
          return originalRename(from, to);
        };
        const importError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9116,
          expectedResultSha256: result.sha256,
        }).then(() => null, error => error);
        fs.promises.rename = originalRename;

        const feedback = JSON.parse(await fs.promises.readFile(feedbackPath, 'utf8'));
        const discarded = await discardLocalApplicationJob(queued.id, project.canvasFilePath);
        assert(importError?.code === 'EIO'
          && blockedImportedManifestWrites === 1
          && feedback.status === 'render-retry-required'
          && feedback.resultSha256 === result.sha256
          && feedback.failurePhase === 'recording pending bundle save'
          && discarded?.discarded === true
          && discarded.removedJob === true
          && !fs.existsSync(queued.folder),
        `a manifest failure before capability registration must remain hash-parked and explicitly discardable, got ${JSON.stringify({ importCode: importError?.code, blockedImportedManifestWrites, feedback, discarded })}`);
        return { importCode: importError.code, response: feedback.status, discardable: true };
      } finally {
        fs.promises.rename = originalRename;
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI import: a result replaced during rendering cannot stage or register the stale hash',
    run: async () => {
      const project = await createCanvasProject();
      let releaseRender = () => {};
      let importPromise = null;
      let renderCalls = 0;
      try {
        const careerData = 'Built supported systems. A concise factual letter.';
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData,
          canvasFilePath: project.canvasFilePath,
        });
        const resultPath = path.join(queued.folder, 'result.json');
        const feedbackPath = path.join(queued.folder, 'fit-feedback.json');
        const resultValue = {
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>',
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence('Built supported systems.', 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor()),
        };
        const firstResult = await atomicReplaceJson(resultPath, resultValue);
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        let firstRenderStartedResolve;
        let releaseRenderResolve;
        const firstRenderStarted = new Promise(resolve => { firstRenderStartedResolve = resolve; });
        const heldRender = new Promise(resolve => { releaseRenderResolve = resolve; });
        releaseRender = () => releaseRenderResolve?.();
        __setLocalAiRenderPdfForTests(async () => {
          renderCalls += 1;
          if (renderCalls === 1) {
            firstRenderStartedResolve();
            await heldRender;
          }
          return {
            bytes: Buffer.from(fixturePdfBytes),
            pageCount: 1,
            fontsLoaded: true,
            missingFontFaces: [],
            layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
          };
        });

        importPromise = importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9113,
          expectedResultSha256: firstResult.sha256,
        });
        await firstRenderStarted;
        const newerResult = await atomicReplaceJson(resultPath, {
          ...resultValue,
          outputBundleRoot: 'Applied Jobs/New Result',
        });
        releaseRender();
        const importError = await importPromise.then(() => null, error => error);
        importPromise = null;
        const current = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(importError?.code === 'LOCAL_AI_RESULT_CHANGED'
          && renderCalls === 2
          && current.status === 'completed'
          && current.resultSha256 === newerResult.sha256
          && fs.existsSync(queued.folder)
          && !fs.existsSync(path.join(queued.folder, 'imported-workspace'))
          && !fs.existsSync(feedbackPath),
        `a render-held replacement must reject the stale hash without staging, feedback, or cleanup, got ${JSON.stringify({ code: importError?.code, renderCalls, status: current.status, hash: current.resultSha256 })}`);
        return { rejectedHash: firstResult.sha256, currentHash: newerResult.sha256, renderCalls };
      } finally {
        releaseRender();
        await importPromise?.catch?.(() => {});
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI save: a newer result revokes the stale save capability before destination mutation',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const careerData = 'Built supported systems. A concise factual letter.';
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData,
          canvasFilePath: project.canvasFilePath,
        });
        const resultPath = path.join(queued.folder, 'result.json');
        const resultValue = {
          version: LOCAL_AI_APPLICATION_VERSION,
          jobId: queued.id,
          status: 'completed',
          outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><section class="section"><article class="role"><span class="title">Developer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>',
          coverLetter: normalizedCoverLetter(),
          coverLetterArgument: coverLetterArgumentForResumeEvidence('Built supported systems.', 'Developer at Acme'),
          generationAudit: generationAuditFor(),
          qualityReview: groundedQualityReview(sourceGroundingFor()),
        };
        const firstResult = await atomicReplaceJson(resultPath, resultValue);
        const fixturePdf = await PDFLib.PDFDocument.create();
        fixturePdf.addPage([612, 792]);
        const fixturePdfBytes = Buffer.from(await fixturePdf.save());
        __setLocalAiRenderPdfForTests(async () => ({
          bytes: Buffer.from(fixturePdfBytes),
          pageCount: 1,
          fontsLoaded: true,
          missingFontFaces: [],
          layout: { contentHeightPx: 760, typeAreaHeightPx: 800 },
        }));
        const imported = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9114,
          expectedResultSha256: firstResult.sha256,
        });
        const newerResult = await atomicReplaceJson(resultPath, {
          ...resultValue,
          outputBundleRoot: 'Applied Jobs/New Result',
        });

        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        const sender = {
          id: 9114,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };
        const saved = await saveApplication({ sender }, {
          resumeHtmlPath: imported.resumeHtmlPath,
          resumePdfPath: imported.resumePdfPath,
          coverLetterPdfPath: imported.coverLetterPdfPath,
          jobListingPath: imported.jobListingPath,
          generationAuditPath: imported.generationAuditPath,
          workDir: imported.workDir,
          jobTitle: 'Developer',
          location: '',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        });
        const current = await localApplicationStatus(queued.id, project.canvasFilePath);
        const receiptPath = path.join(project.root, '.local-ai', 'handoff-receipts', `${queued.id}.json`);
        assert(saved?.success === false
          && saved.errorCode === 'LOCAL_AI_RESULT_CHANGED'
          && current.status === 'completed'
          && current.resultSha256 === newerResult.sha256
          && fs.existsSync(queued.folder)
          && !fs.existsSync(receiptPath)
          && !fs.existsSync(path.join(project.root, 'Applied Jobs', 'Acme'))
          && !fs.existsSync(path.join(queued.folder, 'fit-feedback.json')),
        `a newer result must revoke the stale save before destination writes, receipt, feedback, or cleanup, got ${JSON.stringify({ saved, current })}`);

        const reimported = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9114,
          expectedResultSha256: newerResult.sha256,
        });
        const latestResult = await atomicReplaceJson(resultPath, {
          ...resultValue,
          outputBundleRoot: 'Applied Jobs/Latest Result',
        });
        const discardApplication = ipcMain.__getInvokeHandler('discard-application');
        const discarded = await discardApplication({ sender }, { workDir: reimported.workDir });
        const afterDiscard = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(discarded?.success === false
          && discarded.errorCode === 'LOCAL_AI_RESULT_CHANGED'
          && afterDiscard.status === 'completed'
          && afterDiscard.resultSha256 === latestResult.sha256
          && fs.existsSync(queued.folder),
        `a renderer discard must atomically restore a newer result and revoke only its stale capability, got ${JSON.stringify({ discarded, afterDiscard })}`);

        // Failure to establish the same-parent retirement must be normalized to
        // the same retain-and-retry outcome. In particular, it must not leave a
        // stale pending capability that blocks the job's trusted discard path.
        const latestImport = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          senderId: 9114,
          expectedResultSha256: latestResult.sha256,
        });
        const originalRenameSync = fs.renameSync;
        let retirementRenameAttempts = 0;
        fs.renameSync = (from, to) => {
          if (path.resolve(String(from)) === path.resolve(queued.folder)
            && path.dirname(path.resolve(String(to))) === path.dirname(path.resolve(queued.folder))) {
            retirementRenameAttempts += 1;
            const error = new Error('simulated retirement rename failure');
            error.code = 'EACCES';
            throw error;
          }
          return originalRenameSync(from, to);
        };
        let failedRetirement;
        try {
          failedRetirement = await discardApplication({ sender }, { workDir: latestImport.workDir });
        } finally {
          fs.renameSync = originalRenameSync;
        }
        const retainedAfterRenameFailure = fs.existsSync(queued.folder);
        const releasedDiscard = await discardLocalApplicationJob(queued.id, project.canvasFilePath);
        assert(failedRetirement?.success === false
          && failedRetirement.errorCode === 'LOCAL_AI_RESULT_CHANGED'
          && retirementRenameAttempts === 1
          && retainedAfterRenameFailure
          && releasedDiscard?.discarded === true
          && releasedDiscard.removedJob === true,
        `a failed atomic retirement must retain the job and release its stale capability, got ${JSON.stringify({ failedRetirement, retirementRenameAttempts, retainedAfterRenameFailure, releasedDiscard })}`);
        return {
          saveErrorCode: saved.errorCode,
          discardErrorCode: discarded.errorCode,
          retirementErrorCode: failedRetirement.errorCode,
          currentHash: latestResult.sha256,
          retained: true,
        };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application cleanup: a relocated workspace is restored and released when removal fails',
    run: async () => {
      const project = await createCanvasProject();
      const workDir = path.join(project.root, 'cleanup-recovery-workspace');
      const retiredDir = path.join(project.root, 'cleanup-recovery-workspace.retired');
      const resumeHtmlPath = path.join(workDir, 'Application.html');
      const jobListingPath = path.join(workDir, 'Original Job Listing.md');
      const resumeHtml = '<!doctype html><html data-print="ink-only"><body><section data-ic-document-panel="resume"><main class="page"><p>Resume</p></main></section><section data-ic-document-panel="cover"><main class="page"><p>Cover</p></main></section><script id="ic-application-bundle-data" type="application/json">{}</script></body></html>';
      const jobListing = '# Listing\n';
      const senderId = 9115;
      const sender = {
        id: senderId,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
      };
      const originalRm = fs.promises.rm;
      let successCallbacks = 0;
      let failureCallbacks = 0;
      let blockedRemovals = 0;
      try {
        await fs.promises.mkdir(workDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(resumeHtmlPath, resumeHtml, 'utf8'),
          fs.promises.writeFile(jobListingPath, jobListing, 'utf8'),
        ]);
        registerPendingApplicationWorkspace({
          workDir,
          senderId,
          company: 'Acme',
          resumeHtmlPath,
          jobListingPath,
          cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
          onSuccessfulSave: async () => { successCallbacks += 1; },
          onBeforeSuccessfulCleanup: () => {
            fs.renameSync(workDir, retiredDir);
            return { workDir: retiredDir };
          },
          onSaveFailure: async () => { failureCallbacks += 1; },
        });
        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        fs.promises.rm = async (target, options) => {
          if (path.resolve(String(target)) === path.resolve(retiredDir)) {
            blockedRemovals += 1;
            const error = new Error('simulated relocated cleanup failure');
            error.code = 'EBUSY';
            throw error;
          }
          return originalRm(target, options);
        };
        const saved = await saveApplication({ sender }, {
          resumeHtmlPath,
          resumePdfPath: null,
          coverLetterPdfPath: null,
          jobListingPath,
          generationAuditPath: null,
          workDir,
          jobTitle: 'Developer',
          location: 'Toronto',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        });
        fs.promises.rm = originalRm;
        const destinationHtml = path.join(project.root, 'Applied Jobs', 'Acme', 'Toronto', 'Developer', 'Application.html');
        let pruneOperationRan = false;
        const released = await withUnregisteredApplicationWorkspacePruneClaim(workDir, async () => {
          pruneOperationRan = true;
        });
        assert(saved?.success === false
          && saved.errorCode === 'APPLICATION_WORKSPACE_CLEANUP_FAILED'
          && successCallbacks === 1
          && failureCallbacks === 0
          && blockedRemovals === 1
          && fs.existsSync(destinationHtml)
          && fs.existsSync(workDir)
          && !fs.existsSync(retiredDir)
          && released === true
          && pruneOperationRan,
        `a failed relocated cleanup must restore its exact source path, surface the failure, and release the capability, got ${JSON.stringify({ saved, successCallbacks, failureCallbacks, blockedRemovals, released, pruneOperationRan })}`);
        return { cleanupErrorCode: saved.errorCode, restored: true, capabilityReleased: true };
      } finally {
        fs.promises.rm = originalRm;
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application save: terminal receipt callback failure retains retryable source state',
    run: async () => {
      const project = await createCanvasProject();
      const workDir = path.join(project.root, 'terminal-receipt-failure-workspace');
      const resumeHtmlPath = path.join(workDir, 'Application.html');
      const jobListingPath = path.join(workDir, 'Original Job Listing.md');
      const resumeHtml = '<!doctype html><html data-print="ink-only"><body><section data-ic-document-panel="resume"><main class="page"><p>Resume</p></main></section><section data-ic-document-panel="cover"><main class="page"><p>Cover</p></main></section><script id="ic-application-bundle-data" type="application/json">{}</script></body></html>';
      const jobListing = '# Listing\n';
      const senderId = 9111;
      const sender = {
        id: senderId,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
      };
      let successCallbacks = 0;
      let failureCallbacks = 0;
      let failurePhase = '';
      try {
        await fs.promises.mkdir(workDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(resumeHtmlPath, resumeHtml, 'utf8'),
          fs.promises.writeFile(jobListingPath, jobListing, 'utf8'),
        ]);
        registerPendingApplicationWorkspace({
          workDir,
          senderId,
          company: 'Acme',
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
          onSuccessfulSave: async () => {
            successCallbacks += 1;
            throw new Error('receipt write failed');
          },
          onSaveFailure: async ({ phase }) => {
            failureCallbacks += 1;
            failurePhase = phase;
          },
        });
        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        const saved = await saveApplication({ sender }, {
          resumeHtmlPath,
          resumePdfPath: null,
          coverLetterPdfPath: null,
          jobListingPath,
          generationAuditPath: null,
          workDir,
          jobTitle: 'Developer',
          location: 'Toronto',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        });
        const destinationHtml = path.join(project.root, 'Applied Jobs', 'Acme', 'Toronto', 'Developer', 'Application.html');
        assert(saved?.success === false
          && successCallbacks === 1
          && failureCallbacks === 1
          && failurePhase === 'publishing terminal handoff receipt'
          && fs.existsSync(destinationHtml)
          && fs.existsSync(workDir),
        `a failed terminal receipt must not return success or delete its only retryable source after the destination became durable, got ${JSON.stringify({ saved, successCallbacks, failureCallbacks, failurePhase })}`);

        // The failed one-shot capability must be released so the exact
        // retained workspace can be registered for an explicit retry.
        registerPendingApplicationWorkspace({
          workDir,
          senderId,
          company: 'Acme',
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          artifactData: { resumeHtml, jobListing },
        });
        const discardApplication = ipcMain.__getInvokeHandler('discard-application');
        const discarded = await discardApplication({ sender }, { workDir });
        assert(discarded?.success && discarded.discarded && fs.existsSync(workDir),
          'terminal-callback failure releases the consumed capability for a later explicit retry');
        return { durableDestination: true, receiptFailureSurfaced: true, retryRegistration: true };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Application save: concurrent invokes atomically claim one pending workspace',
    run: async () => {
      const project = await createCanvasProject();
      const workDir = path.join(project.root, 'concurrent-save-workspace');
      const resumeHtmlPath = path.join(workDir, 'Application.html');
      const jobListingPath = path.join(workDir, 'Original Job Listing.md');
      const blockedOutputRoot = path.join(project.root, 'blocked-concurrent-output');
      const resumeHtml = '<!doctype html><html data-print="ink-only"><body><section data-ic-document-panel="resume"><main class="page"><p>Fixture</p></main></section></body></html>';
      const jobListing = '# Fixture listing\n';
      const senderId = 9108;
      const sender = {
        id: senderId,
        isDestroyed: () => false,
        once: () => {},
        on: () => {},
        removeListener: () => {},
      };
      let failureCallbacks = 0;
      let successCallbacks = 0;
      try {
        await fs.promises.mkdir(workDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(resumeHtmlPath, resumeHtml, 'utf8'),
          fs.promises.writeFile(jobListingPath, jobListing, 'utf8'),
          // The admitted request fails deterministically at destination-root
          // validation, leaving enough asynchronous distance for the second
          // invoke to encounter the synchronous claim.
          fs.promises.writeFile(blockedOutputRoot, 'not a directory', 'utf8'),
        ]);
        registerPendingApplicationWorkspace({
          workDir,
          senderId,
          company: 'Acme',
          applicationRoot: blockedOutputRoot,
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
          onSuccessfulSave: async () => { successCallbacks += 1; },
          onSaveFailure: async () => { failureCallbacks += 1; },
        });
        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        const saveArgs = {
          resumeHtmlPath,
          resumePdfPath: null,
          coverLetterPdfPath: null,
          jobListingPath,
          generationAuditPath: null,
          workDir,
          jobTitle: 'Developer',
          location: '',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        };
        const results = await Promise.all([
          saveApplication({ sender }, saveArgs),
          saveApplication({ sender }, saveArgs),
        ]);
        const busy = results.filter(result => result?.errorCode === 'APPLICATION_SAVE_IN_FLIGHT');
        const admittedFailure = results.filter(result => result?.success === false
          && /regular directory/i.test(result?.error || ''));
        assert(busy.length === 1 && admittedFailure.length === 1
          && failureCallbacks === 1 && successCallbacks === 0,
        `exactly one concurrent save may consume the capability and publish a callback, got ${JSON.stringify({ results, failureCallbacks, successCallbacks })}`);

        // The admitted failure still releases the one-shot capability. A later
        // explicit retry may register the retained workspace normally.
        registerPendingApplicationWorkspace({
          workDir,
          senderId,
          company: 'Acme',
          applicationRoot: blockedOutputRoot,
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
        });
        const discardApplication = ipcMain.__getInvokeHandler('discard-application');
        const discarded = await discardApplication({ sender }, { workDir });
        assert(discarded?.success && discarded.discarded
          && await fs.promises.lstat(workDir).then(stat => stat.isDirectory()),
        'the failed claim is released for an explicit retry while its retained workspace remains recoverable');
        return { admitted: 1, duplicateRejected: 1, failureCallbacks };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI retention: prune claims serialize against workspace registration',
    run: async () => {
      const project = await createCanvasProject();
      let releasePrune = () => {};
      try {
        const workDir = path.join(project.root, 'prune-claim-workspace');
        const resumeHtmlPath = path.join(workDir, 'Application.html');
        const jobListingPath = path.join(workDir, 'Original Job Listing.md');
        const resumeHtml = '<!doctype html><html><body><main>Fixture</main></body></html>';
        const jobListing = '# Fixture listing\n';
        await fs.promises.mkdir(workDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(resumeHtmlPath, resumeHtml, 'utf8'),
          fs.promises.writeFile(jobListingPath, jobListing, 'utf8'),
        ]);

        let pruneEnteredResolve;
        let releasePruneResolve;
        const pruneEntered = new Promise(resolve => { pruneEnteredResolve = resolve; });
        const holdPrune = new Promise(resolve => { releasePruneResolve = resolve; });
        releasePrune = () => releasePruneResolve?.();
        const prunePromise = withUnregisteredApplicationWorkspacePruneClaim(workDir, async () => {
          pruneEnteredResolve();
          await holdPrune;
        });
        await pruneEntered;

        let registrationCode = '';
        try {
          registerPendingApplicationWorkspace({
            workDir,
            senderId: 9110,
            resumeHtmlPath,
            jobListingPath,
            cleanupOnDiscard: false,
            artifactData: { resumeHtml, jobListing },
          });
        } catch (error) {
          registrationCode = error?.code || '';
        }
        releasePrune();
        assert(await prunePromise && registrationCode === 'APPLICATION_WORKSPACE_PRUNING',
          'a prune claim that wins first must reject concurrent registration with a typed retry before deletion can race it');

        registerPendingApplicationWorkspace({
          workDir,
          senderId: 9110,
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          artifactData: { resumeHtml, jobListing },
        });
        let pruneRan = false;
        const declined = await withUnregisteredApplicationWorkspacePruneClaim(workDir, async () => { pruneRan = true; });
        assert(declined === false && pruneRan === false,
          'a registered capability that wins first must make retention pruning decline without touching the workspace');

        registerJobApplicationHandlers();
        const discardApplication = ipcMain.__getInvokeHandler('discard-application');
        const sender = { id: 9110, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {} };
        const discarded = await discardApplication({ sender }, { workDir });
        assert(discarded?.success && discarded.discarded && fs.existsSync(workDir),
          'the registration remains usable and can release its capability after the declined prune');
        return { registrationCode, pruneDeclinedForCapability: true };
      } finally {
        releasePrune();
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI retention: import and per-job pruning claims are mutually exclusive',
    run: async () => {
      const project = await createCanvasProject();
      let releasePrune = () => {};
      let heldPrunePromise = null;
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });

        // Import admission establishes its claim before its first await. Even
        // though this fixture eventually fails for lack of result.json, a
        // retention pass started in that interval must not touch the folder.
        const activeImport = importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
        });
        let pruneRanDuringImport = false;
        const declinedPrune = await withLocalAiJobPruneClaim(queued.id, queued.folder, async () => {
          pruneRanDuringImport = true;
        });
        const activeImportError = await activeImport.then(() => null, error => error);
        assert(declinedPrune === false && pruneRanDuringImport === false
          && activeImportError && activeImportError.code !== 'LOCAL_AI_IMPORT_IN_FLIGHT',
        'an import that wins admission must make per-job retention pruning decline until the import settles');

        // Exercise the inverse order with a held operation. The import must be
        // rejected before it reads from a directory the retention owner may be
        // deleting, and the shared retry code keeps the caller poll-safe.
        let pruneEnteredResolve;
        let releasePruneResolve;
        const pruneEntered = new Promise(resolve => { pruneEnteredResolve = resolve; });
        const holdPrune = new Promise(resolve => { releasePruneResolve = resolve; });
        releasePrune = () => releasePruneResolve?.();
        heldPrunePromise = withLocalAiJobPruneClaim(queued.id, queued.folder, async () => {
          pruneEnteredResolve();
          await holdPrune;
        });
        await pruneEntered;
        const blockedImportError = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
        }).then(() => null, error => error);
        assert(blockedImportError?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'a per-job retention claim that wins admission rejects import with the typed retriable code');

        releasePrune();
        assert(await heldPrunePromise === true,
          'the admitted retention operation completes after the held prune claim is released');
        heldPrunePromise = null;
        const importAfterPrune = await importLocalApplicationJob({
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
        }).then(() => null, error => error);
        assert(importAfterPrune && importAfterPrune.code !== 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'the per-job prune claim is released after completion so later imports can run normally');
        return {
          pruneDeclinedDuringImport: true,
          blockedImportCode: blockedImportError.code,
          importRecoveredAfterPrune: true,
        };
      } finally {
        releasePrune();
        await heldPrunePromise?.catch?.(() => {});
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI import: an active save extends a lapsed manifest settling window',
    run: async () => {
      const project = await createCanvasProject();
      let releaseFailureCallback = () => {};
      let admittedSavePromise = null;
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' },
          careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });
        const resumeHtmlPath = path.join(queued.folder, 'save-in-flight-Application.html');
        const jobListingPath = path.join(queued.folder, 'save-in-flight-Listing.md');
        const blockedOutputRoot = path.join(project.root, 'blocked-active-save-output');
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const resumeHtml = '<!doctype html><html data-print="ink-only"><body><section data-ic-document-panel="resume"><main class="page"><p>Fixture</p></main></section></body></html>';
        const jobListing = '# Fixture listing\n';
        await Promise.all([
          fs.promises.writeFile(resumeHtmlPath, resumeHtml, 'utf8'),
          fs.promises.writeFile(jobListingPath, jobListing, 'utf8'),
          fs.promises.writeFile(blockedOutputRoot, 'not a directory', 'utf8'),
        ]);
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        await atomicReplaceJson(manifestPath, {
          ...manifest,
          status: 'imported',
          importedAt: '2000-01-01T00:00:00.000Z',
        });

        let failureStartedResolve;
        let releaseFailureResolve;
        const failureStarted = new Promise(resolve => { failureStartedResolve = resolve; });
        const holdFailureCallback = new Promise(resolve => { releaseFailureResolve = resolve; });
        releaseFailureCallback = () => releaseFailureResolve?.();
        registerPendingApplicationWorkspace({
          workDir: queued.folder,
          senderId: 9109,
          company: 'Acme',
          applicationRoot: blockedOutputRoot,
          resumeHtmlPath,
          jobListingPath,
          cleanupOnDiscard: false,
          cleanupOnSaveFailure: false,
          artifactData: { resumeHtml, jobListing },
          onSaveFailure: async () => {
            failureStartedResolve();
            await holdFailureCallback;
          },
        });
        registerJobApplicationHandlers();
        const saveApplication = ipcMain.__getInvokeHandler('save-application');
        const sender = {
          id: 9109,
          isDestroyed: () => false,
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };
        admittedSavePromise = saveApplication({ sender }, {
          resumeHtmlPath,
          resumePdfPath: null,
          coverLetterPdfPath: null,
          jobListingPath,
          generationAuditPath: null,
          workDir: queued.folder,
          jobTitle: 'Developer',
          location: '',
          canvasFilePath: project.canvasFilePath,
          suppressReveal: true,
        });
        await failureStarted;
        assert(isPendingApplicationWorkspaceSaveInFlight(queued.folder),
          'the exact registered workspace reports its active save claim while its failure callback is settling');

        const receiptPath = path.join(project.root, '.local-ai', 'handoff-receipts', `${queued.id}.json`);
        await fs.promises.writeFile(receiptPath, '{}\n', 'utf8');
        const expiredReceiptTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
        await fs.promises.utimes(receiptPath, expiredReceiptTime, expiredReceiptTime);

        const queuedDuringSave = await queueLocalApplicationJob({
          job: { title: 'Parallel Developer', company: 'Acme' },
          careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });
        assert(fs.existsSync(queued.folder) && fs.existsSync(queuedDuringSave.folder)
          && fs.existsSync(receiptPath),
        'retention pruning for a new queue must not delete a lapsed imported job or even an expired receipt while its exact workspace is actively saving');

        const discardDuringSave = await discardLocalApplicationJob(queued.id, project.canvasFilePath)
          .then(() => null, error => error);
        assert(discardDuringSave?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT'
          && fs.existsSync(queued.folder),
        'direct Local AI discard must join the workspace claim and retain the source directory during an admitted save');

        let replacementRegistrationCode = '';
        try {
          registerPendingApplicationWorkspace({
            workDir: queued.folder,
            senderId: 9109,
            company: 'Acme',
            applicationRoot: blockedOutputRoot,
            resumeHtmlPath,
            jobListingPath,
            cleanupOnDiscard: false,
            cleanupOnSaveFailure: false,
            artifactData: { resumeHtml, jobListing },
          });
        } catch (error) {
          replacementRegistrationCode = error?.code || '';
        }

        const statusDuringSave = await localApplicationStatus(queued.id, project.canvasFilePath);
        let overlappingImportCode = '';
        try {
          await importLocalApplicationJob({
            jobId: queued.id,
            canvasFilePath: project.canvasFilePath,
            senderId: 9109,
          });
        } catch (error) {
          overlappingImportCode = error?.code || '';
        }
        assert(replacementRegistrationCode === 'APPLICATION_SAVE_IN_FLIGHT'
          && statusDuringSave.status === 'importing'
          && overlappingImportCode === 'LOCAL_AI_IMPORT_IN_FLIGHT',
        `a proven-active save must retain its capability and hold status/import past the timestamp window, got ${JSON.stringify({ replacementRegistrationCode, status: statusDuringSave.status, overlappingImportCode })}`);

        releaseFailureCallback();
        const admittedSave = await admittedSavePromise;
        admittedSavePromise = null;
        const afterFailure = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(admittedSave?.success === false
          && !isPendingApplicationWorkspaceSaveInFlight(queued.folder)
          && afterFailure.status === 'queued',
        'once the active save ends, its claim is released and the lapsed crash-recovery window resumes normal polling');
        return {
          replacementRegistrationCode,
          heldStatus: statusDuringSave.status,
          overlappingImportCode,
          discardDuringSaveCode: discardDuringSave.code,
          recoveredStatus: afterFailure.status,
          retainedDuringConcurrentQueue: true,
        };
      } finally {
        releaseFailureCallback();
        await admittedSavePromise?.catch?.(() => {});
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The canvas-level fallback manager and a just-remounted card can both
    // reach for the same completed result. The per-job lock makes the loser's
    // request a typed, retriable rejection instead of a double render racing
    // the winner's directory cleanup.
    name: 'Local AI import: concurrent imports of one job serialize behind the per-job lock',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });
        // No result.json exists, so the winning import fails on the missing
        // file — the point is WHICH error each concurrent caller receives.
        const first = importLocalApplicationJob({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const second = importLocalApplicationJob({ jobId: queued.id, canvasFilePath: project.canvasFilePath });
        const [firstErr, secondErr] = await Promise.all([
          first.then(() => null, (e) => e),
          second.then(() => null, (e) => e),
        ]);
        assert(firstErr && firstErr.code !== 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'the first import enters the job body and fails on the missing result.json, not on the lock');
        assert(secondErr?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'a concurrent second import of the same job is rejected by the per-job lock');
        const thirdErr = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath: project.canvasFilePath })
          .then(() => null, (e) => e);
        assert(thirdErr && thirdErr.code !== 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'the lock is released once the first import settles — later imports run normally');
        return { firstError: String(firstErr?.message || '').slice(0, 60), secondCode: secondErr?.code };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // 2026-08-21 regression: the Local AI poll lived only in JobCardNode, and
    // hidden cards unmount — a board hiding stale results killed the poll, so
    // A local coding agent's finished result.json was never imported. The fallback
    // manager's discovery is pure and covered here: deep traversal over the
    // whole graph plus the mounted-card ownership handoff.
    name: 'Local AI fallback: deep node discovery and unmounted-card job selection',
    run: async () => {
      const nested = { id: 'card-nested', type: 'jobcard', data: { localApplication: { id: 'job-n', status: 'queued' } } };
      const group = { id: 'group-1', type: 'group', data: { canvasData: { nodes: [nested] } } };
      const staleCopy = { id: 'card-active', type: 'jobcard', data: { localApplication: { id: 'job-a', status: 'saved' } } };
      const fresh = { id: 'card-active', type: 'jobcard', data: { localApplication: { id: 'job-a', status: 'completed' } } };
      const all = collectNodesDeep([fresh, group], []);
      collectNodesDeep([staleCopy], all, new Set(all.map((n) => n.id)));
      assert(all.some((n) => n.id === 'card-nested'), 'traversal reaches cards nested inside group canvasData');
      const activeCopies = all.filter((n) => n.id === 'card-active');
      assert(activeCopies.length === 1 && activeCopies[0].data.localApplication.status === 'completed',
        'duplicate ids keep the first (freshest) occurrence — a stale stack copy never shadows the live node');

      const cards = [
        { id: 'c-queued', type: 'jobcard', data: { localApplication: { id: 'j1', status: 'queued' } } },
        { id: 'c-completed', type: 'jobcard', data: { localApplication: { id: 'j2', status: 'completed' } } },
        { id: 'c-importing', type: 'jobcard', data: { localApplication: { id: 'j3', status: 'importing' } } },
        { id: 'c-revision', type: 'jobcard', data: { localApplication: { id: 'j4', status: 'revision-required' } } },
        { id: 'c-saved', type: 'jobcard', data: { localApplication: { id: 'j5', status: 'saved' } } },
        { id: 'c-failed', type: 'jobcard', data: { localApplication: { id: 'j6', status: 'failed' } } },
        { id: 'c-render-retry', type: 'jobcard', data: { localApplication: { id: 'j7', status: 'render-retry-required' } } },
        { id: 'c-exhausted', type: 'jobcard', data: { localApplication: { id: 'j8', status: 'revision-exhausted' } } },
        { id: 'c-no-job', type: 'jobcard', data: {} },
        { id: 'c-not-card', type: 'jobgroup', data: { localApplication: { id: 'j9', status: 'queued' } } },
        { id: 'c-mounted', type: 'jobcard', data: { localApplication: { id: 'j10', status: 'queued' } } },
      ];
      const selected = selectFallbackLocalAiJobs(cards, (id) => id === 'c-mounted').map((n) => n.id);
      assert(JSON.stringify(selected) === JSON.stringify(['c-queued', 'c-completed', 'c-importing', 'c-revision', 'c-render-retry', 'c-exhausted']),
        `the manager drives pending jobs on unmounted cards only — including an orphaned 'importing' (dead driver), manual render retry that needs persistent UI, and legacy exhausted job that must migrate — never terminal, mounted, or non-card nodes (got: ${selected.join(', ')})`);

      registerMountedJobCard('reg-1');
      assert(isJobCardMounted('reg-1'), 'a mounted card registers as the owner of its job');
      unregisterMountedJobCard('reg-1');
      assert(!isJobCardMounted('reg-1'), 'unmounting releases ownership to the fallback manager');
      assert(LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('importing') && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('importing'),
        "the card's own poll ignores 'importing' (it holds it mid-import) while the manager resumes an orphaned one");
      assert(LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('render-retry-required') && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('render-retry-required'),
        'the mounted card owns its visible render retry while the fallback manager keeps a hidden card pollable so it can surface a persistent retry action');
      assert(!LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('revision-exhausted') && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('revision-exhausted'),
        'legacy revision-exhausted cards remain pollable so app status can migrate them to revision-required');
      return { selected };
    },
  },
  {
    // Verification round-1 findings: (a) a stack level's dived-into group
    // embeds a stale canvasData snapshot — descending into it resurrected
    // dismissed cards as drivable ghosts; (b) deepUpdateNode marked nodes
    // updated even for guard-declined writes, so every 2.5s manager tick
    // dirtied the canvas and could starve autosave indefinitely.
    name: 'Local AI fallback: ghost branches are skipped and guarded no-op writes preserve identity',
    run: async () => {
      const dismissedGhost = { id: 'card-ghost', type: 'jobcard', data: { localApplication: { id: 'job-g', status: 'queued' } } };
      const stackLevelNodes = [
        { id: 'group-dived', type: 'group', data: { canvasData: { nodes: [dismissedGhost] } } },
        { id: 'group-other', type: 'group', data: { canvasData: { nodes: [{ id: 'card-live', type: 'jobcard', data: { localApplication: { id: 'job-l', status: 'queued' } } }] } } },
      ];
      const skipped = collectNodesDeep(stackLevelNodes, [], new Set(), new Set(['group-dived']));
      assert(skipped.some((n) => n.id === 'group-dived') && !skipped.some((n) => n.id === 'card-ghost'),
        'a dived-into group is listed but its stale embedded branch is never descended — a dismissed card cannot resurface as a drivable ghost');
      assert(skipped.some((n) => n.id === 'card-live'),
        'sibling groups that were never dived into still contribute their nested cards');

      const nodes = [{ id: 'card-1', type: 'jobcard', data: { localApplication: { id: 'j1', status: 'saved' }, other: 1 } }];
      const declined = deepUpdateNode(nodes, 'card-1', (node) =>
        node.data.localApplication.status === 'saved' ? null : { localApplication: { id: 'j1', status: 'failed' } });
      assert(declined.updated === false && declined.nodes[0] === nodes[0],
        'a guard-declined functional patch preserves node identity and reports nothing updated — no dirty flag, no autosave churn');
      const applied = deepUpdateNode(nodes, 'card-1', (node) =>
        node.data.localApplication.status === 'saved' ? { touched: true } : null);
      assert(applied.updated === true && applied.nodes[0] !== nodes[0] && applied.nodes[0].data.touched === true,
        'a returned patch still applies normally with a fresh identity');
      return { skippedGhost: true, identityPreserved: true };
    },
  },
  {
    name: 'Local AI fallback: deleted-card handoffs are discovered only from the current canvas and save without revealing Finder',
    run: async () => {
      const project = await createCanvasProject();
      const otherProject = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Platform Engineer', company: 'Acme', location: 'Austin, TX' },
          careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });
        // A UUID-looking but malformed sibling is not app-owned and must not
        // be offered to the automatic recovery path.
        const forged = path.join(project.root, '.local-ai', 'jobs', '11111111-1111-4111-8111-111111111111');
        await fs.promises.mkdir(forged, { recursive: true });
        await fs.promises.writeFile(path.join(forged, 'manifest.json'), '{}', 'utf8');

        const discovered = await discoverLocalApplicationJobs(project.canvasFilePath);
        assert(discovered.length === 1 && discovered[0].id === queued.id
          && discovered[0].canvasFilePath === queued.canvasFilePath
          && discovered[0].job.title === 'Platform Engineer',
        'discovery returns only a regular, manifest/input-verified Local AI job owned by this saved canvas');
        assert((await discoverLocalApplicationJobs(otherProject.canvasFilePath)).length === 0,
          'a different saved canvas cannot discover or import this handoff');

        assert(selectOrphanedLocalAiJobs(discovered, new Set([queued.id])).length === 0,
          'any job still represented anywhere in canvas state remains card-owned');
        const orphaned = selectOrphanedLocalAiJobs(discovered, new Set());
        assert(orphaned.length === 1 && orphaned[0].id === queued.id,
          'once its card has been deleted, the app-owned folder becomes an automatic recovery candidate without recreating the card');

        const fallbackSource = await fs.promises.readFile(path.resolve('src/hooks/useLocalAiFallbackManager.js'), 'utf8');
        const saveSource = await fs.promises.readFile(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
        assert(fallbackSource.includes('discoverLocalApplications')
          && fallbackSource.includes('selectOrphanedLocalAiJobs')
          && fallbackSource.includes('suppressReveal: isOrphan'),
        'the mounted canvas manager discovers deleted-card jobs and marks their automatic save as non-revealing');
        assert(saveSource.includes('if (!suppressReveal)') && saveSource.includes('await shell.openPath(dir)'),
          'save-application skips the Finder/Explorer reveal when recovery requests it, while preserving normal explicit-save reveals');
        return { discovered: discovered.map((job) => job.id), orphaned: orphaned.map((job) => job.id) };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
        await fs.promises.rm(otherProject.root, { recursive: true, force: true });
      }
    },
  },
  {
    // Verification round-1 finding: the per-job lock only covered the import
    // IPC, but the winner's job dir persists (manifest 'imported') until the
    // FOLLOW-UP save deletes it — a settled second driver could re-import in
    // full during that window. The manifest now gates both status and import,
    // time-bounded so a crashed save self-heals.
    name: 'Local AI import: a fresh manifest ‘imported’ holds pollers and rejects re-import until the save window lapses',
    run: async () => {
      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA,
          canvasFilePath: project.canvasFilePath,
        });
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'imported', importedAt: new Date().toISOString() }), 'utf8');
        const settling = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(settling.status === 'importing' && /bundle save to settle/.test(settling.message) && settling.resultSha256 === null,
          'a fresh imported manifest reports the save window instead of a completed, re-importable result');
        const reimportErr = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath: project.canvasFilePath })
          .then(() => null, (e) => e);
        assert(reimportErr?.code === 'LOCAL_AI_IMPORT_IN_FLIGHT',
          're-import during the save window is rejected with the typed retriable code');
        await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'imported', importedAt: new Date(Date.now() - 10 * 60_000).toISOString() }), 'utf8');
        const lapsed = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(lapsed.status === 'queued',
          'a lapsed save window falls through to normal status — a crashed save never permanently wedges the job');
        const lapsedImportErr = await importLocalApplicationJob({ jobId: queued.id, canvasFilePath: project.canvasFilePath })
          .then(() => null, (e) => e);
        assert(lapsedImportErr && lapsedImportErr.code !== 'LOCAL_AI_IMPORT_IN_FLIGHT',
          'after the window lapses, import proceeds into the job body again (fails only on the missing result.json)');
        return { settling: settling.status, lapsed: lapsed.status };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    // The measured import finishes before the renderer promotes its registered
    // workspace. A receipt is terminal evidence for the waiting local coding agent
    // session, so save-application emits it only after durable promotion and
    // before best-effort private-workspace cleanup. A retained folder must not
    // hide that receipt; conversely, a failed promotion retains the job/result
    // for retry and emits no terminal receipt.
    name: 'Local AI handoff: terminal receipt follows durable save and failed save retains the job',
    run: async () => {
      const localSource = await fs.promises.readFile(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const applicationSource = await fs.promises.readFile(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
      const registrationAt = localSource.indexOf('const workDir = registerPendingApplicationWorkspace({');
      const auditBuildAt = localSource.indexOf('const generationAuditArtifact = buildLocalGenerationAuditArtifact({');
      const artifactStageAt = localSource.indexOf('} = await stageLocalApplicationWorkspaceArtifacts({');
      const receiptCalls = [...localSource.matchAll(/await writeLocalAiTerminalReceipt\(/g)].map(match => match.index);
      assert(registrationAt >= 0
        && /cleanupOnSaveFailure\s*:\s*false/.test(localSource.slice(registrationAt))
        && /onSuccessfulSave\s*:\s*(?:async\s*)?\(\)\s*=>[\s\S]{0,1200}(?:await\s+)?writeLocalAiTerminalReceipt\(/.test(localSource.slice(registrationAt))
        && /onSaveFailure\s*:\s*async\s*\(\{\s*phase,\s*error\s*\}\)\s*=>[\s\S]{0,800}recordLocalAiSaveFailure\(/.test(localSource.slice(registrationAt)),
      'a Local AI import registers failure-retention plus hash-bound success and failure callbacks');
      assert(receiptCalls.length === 1 && receiptCalls[0] > registrationAt,
        'the terminal receipt is not emitted during measured import before save-application owns the workspace');
      assert(auditBuildAt >= 0 && artifactStageAt > auditBuildAt && registrationAt > artifactStageAt
        && /generationAuditPath[\s\S]{0,5000}generationAudit:\s*generationAuditArtifact/.test(localSource.slice(registrationAt, registrationAt + 7_000)),
      'the app composes and atomically stages the durable generation audit before registering its exact path and bytes for final-save promotion');

      const cleanupAt = applicationSource.indexOf("await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'successful save')");
      const finalizerAt = applicationSource.indexOf('await pending.onSuccessfulSave(');
      const saveReturnAt = applicationSource.indexOf('return {\n      saved: true,');
      assert(finalizerAt >= 0 && cleanupAt > finalizerAt && saveReturnAt > cleanupAt,
        'save-application publishes the registered terminal receipt after atomic promotion but before deleting the private Local AI job folder');
      const saveFailureAt = applicationSource.indexOf("discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'terminal save failure')");
      const failureCallbackAt = applicationSource.indexOf('await pending.onSaveFailure({ phase: exportPhase, error })');
      const failureWindow = applicationSource.slice(Math.max(0, saveFailureAt - 700), saveFailureAt + 250);
      assert(saveFailureAt >= 0 && failureCallbackAt >= 0 && failureCallbackAt < saveFailureAt
        && /pending\.cleanupOnSaveFailure/.test(failureWindow),
      'the failed-save path publishes retry evidence before honoring the workspace-specific retention policy');

      const project = await createCanvasProject();
      try {
        const queued = await queueLocalApplicationJob({
          job: { title: 'Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const receiptsRoot = path.join(project.root, '.local-ai', 'handoff-receipts');
        await fs.promises.mkdir(receiptsRoot, { recursive: true });
        await fs.promises.writeFile(path.join(receiptsRoot, `${queued.id}.json`), `${JSON.stringify({
          version: 1,
          jobId: queued.id,
          canvasFilePath: project.canvasFilePath,
          status: 'imported',
          resultSha256: 'a'.repeat(64),
          importedAt: new Date().toISOString(),
          resume: { pageCount: 1, targetPageCount: 1, attempts: [{ density: 'default', pageCount: 1 }] },
          coverLetter: { pageCount: 1, targetPageCount: 1 },
          message: 'Both documents met their measured targets.',
        })}\n`, 'utf8');
        await fs.promises.rm(queued.folder, { recursive: true, force: true });
        const siblingCanvasFilePath = path.join(project.root, 'sibling-canvas.json');
        await fs.promises.writeFile(siblingCanvasFilePath, '{}\n', 'utf8');
        const siblingStatus = await localApplicationStatus(queued.id, siblingCanvasFilePath);
        const siblingDiscard = await discardLocalApplicationJob(queued.id, siblingCanvasFilePath);
        assert(siblingStatus.status !== 'saved'
          && siblingDiscard.removedReceipt === false
          && fs.existsSync(path.join(receiptsRoot, `${queued.id}.json`)),
        'a sibling canvas in the same directory can neither inherit saved status nor discard another canvas\'s terminal receipt');
        const status = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(status.status === 'saved' && status.receipt?.jobId === queued.id,
          `a valid terminal receipt must distinguish a completed-save cleanup from a failed/missing job, got ${JSON.stringify(status)}`);

        const retained = await queueLocalApplicationJob({
          job: { title: 'Retained Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        const retainedResultRaw = '{"fixture":"durably saved"}\n';
        await fs.promises.writeFile(path.join(retained.folder, 'result.json'), retainedResultRaw, 'utf8');
        const retainedManifestPath = path.join(retained.folder, 'manifest.json');
        const retainedManifest = JSON.parse(await fs.promises.readFile(retainedManifestPath, 'utf8'));
        await fs.promises.writeFile(retainedManifestPath, `${JSON.stringify({
          ...retainedManifest,
          status: 'imported',
          importedAt: '2000-01-01T00:00:00.000Z',
        })}\n`, 'utf8');
        await fs.promises.writeFile(path.join(receiptsRoot, `${retained.id}.json`), `${JSON.stringify({
          version: 1,
          jobId: retained.id,
          canvasFilePath: project.canvasFilePath,
          status: 'imported',
          resultSha256: sha256(retainedResultRaw),
          importedAt: new Date().toISOString(),
          resume: { pageCount: 1, targetPageCount: 1, attempts: [{ density: 'default', pageCount: 1 }] },
          coverLetter: { pageCount: 1, targetPageCount: 1 },
          message: 'Both documents met their measured targets.',
        })}\n`, 'utf8');
        const retainedStatus = await localApplicationStatus(retained.id, project.canvasFilePath);
        assert(retainedStatus.status === 'saved' && retainedStatus.cleanupPending === true
          && retainedStatus.folder === retained.folder && retainedStatus.receipt?.resultSha256 === sha256(retainedResultRaw),
        `a matching terminal receipt must win when cleanup leaves the private folder behind, got ${JSON.stringify(retainedStatus)}`);

        await fs.promises.writeFile(path.join(retained.folder, 'result.json'), '{"fixture":"new bytes"}\n', 'utf8');
        const changedStatus = await localApplicationStatus(retained.id, project.canvasFilePath);
        assert(changedStatus.status !== 'saved',
          'a retained-folder receipt cannot terminate a different current result hash');

        // Recursive cleanup is not atomic: it may delete manifest/input/context
        // before failing on another entry. The durable receipt must remain
        // sufficient when the matching result survives that partial cleanup.
        await fs.promises.writeFile(path.join(retained.folder, 'result.json'), retainedResultRaw, 'utf8');
        await Promise.all([
          fs.promises.rm(path.join(retained.folder, 'manifest.json'), { force: true }),
          fs.promises.rm(path.join(retained.folder, 'input.json'), { force: true }),
          fs.promises.rm(path.join(retained.folder, 'context'), { recursive: true, force: true }),
        ]);
        const partialCleanupStatus = await localApplicationStatus(retained.id, project.canvasFilePath);
        assert(partialCleanupStatus.status === 'saved' && partialCleanupStatus.cleanupPending === true,
          `terminal receipt lookup must precede files that partial cleanup may already have removed, got ${JSON.stringify(partialCleanupStatus)}`);
        return {
          status: status.status,
          receipt: true,
          siblingReceiptIsolated: true,
          retainedFolderStatus: retainedStatus.status,
          partialCleanupStatus: partialCleanupStatus.status,
        };
      } finally {
        await fs.promises.rm(project.root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Local AI render: screen-only page guides cannot fail the print font-readiness gate',
    async run() {
      // Reproduces the exact failure that stranded a real job. renderPdf swaps
      // the ATS-safe families onto the root and inline-substitutes every
      // element that exists at that instant; renderGuides() then rewrites the
      // overlay's innerHTML from a rAF (document.fonts.ready / loadingdone /
      // ResizeObserver / a data-density MutationObserver), so the regenerated
      // folio carries its own stack and never received the substitution. The
      // overlay is display:none in print, so nothing in it reaches the PDF.
      const evaluatePredicate = (guideMarkup) => {
        const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
        const { window } = dom;
        const document = window.document;
        for (const [token, value] of [
          ['--ff-display', 'Georgia, "Times New Roman", serif'],
          ['--ff-body', 'Arial, "Helvetica Neue", sans-serif'],
          ['--ff-mono', 'Menlo, Consolas, "Courier New", monospace'],
        ]) document.documentElement.style.setProperty(token, value);
        document.body.innerHTML = '<section data-ic-document-panel="resume"><div class="ic-page-stage">'
          + '<main class="page"><p style="font-family: Arial, &quot;Helvetica Neue&quot;, sans-serif">Body copy</p></main>'
          + guideMarkup
          + '</div></section>';
        window.document.fonts = { check: () => true, ready: Promise.resolve() };
        return window.eval(webFontFacesReadyExpression({ details: true }));
      };
      const staleFolio = '<div class="ic-page-guides" data-ic-page-guides>'
        + '<span class="ic-page-folio" style="font-family: &quot;IBM Plex Mono&quot;, &quot;SF Mono&quot;, Menlo, monospace">Page 2</span></div>';
      const withGuides = evaluatePredicate(staleFolio);
      assert(withGuides.loaded === true && withGuides.missingFaces.length === 0,
        `a regenerated page-guide folio must not fail print font readiness, got ${JSON.stringify(withGuides)}`);
      // The exclusion must be scoped to the overlay, never to document text:
      // an unexpected face inside main.page still has to fail the gate.
      const inPageMarkup = '<div class="ic-page-guides" data-ic-page-guides></div>';
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
      dom.window.document.documentElement.style.setProperty('--ff-body', 'Arial, sans-serif');
      dom.window.document.body.innerHTML = '<section data-ic-document-panel="resume"><main class="page">'
        + '<p style="font-family: &quot;IBM Plex Mono&quot;, monospace">Body copy</p></main>' + inPageMarkup + '</section>';
      dom.window.document.fonts = { check: () => true, ready: Promise.resolve() };
      const inPage = dom.window.eval(webFontFacesReadyExpression({ details: true }));
      assert(inPage.loaded === false && inPage.missingFaces.some(face => face.includes('unexpected')),
        `an unexpected face inside the printed page must still fail the gate, got ${JSON.stringify(inPage)}`);
      const source = fs.readFileSync(new URL('../../electron/ipc/resumeHtml.js', import.meta.url), 'utf8');
      assert(/\.ic-page-folio \{[^}]*font: 8\.5px\/1\.3 var\(--ff-mono\)/.test(source)
        && !/\.ic-page-folio \{[^}]*IBM Plex Mono/.test(source),
      'the page-guide folio must read the mono token so the ATS-safe substitution reaches it, not a literal stack');
      return { guardedFaces: withGuides.missingFaces.length, unguardedDetected: inPage.missingFaces.length };
    },
  },
  {
    name: 'Local AI render: a transient font-readiness failure retries and never discards a verified measurement',
    async run() {
      const renderSource = fs.readFileSync(new URL('../../electron/ipc/resumeRender.js', import.meta.url), 'utf8');
      assert(renderSource.includes('renderPdfOnce')
        && /if \(first\.fontsLoaded !== false\) return first;/.test(renderSource)
        && renderSource.includes('missingFontFaces'),
      'renderPdf must retry a failed font-readiness verdict once and return the failing face descriptors');
      const localSource = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      // The compact retry only runs because the default attempt overflowed, so
      // its measurement is real. Reporting the unverifiable retry instead sent
      // "the AI draft does not need another rewrite" for a résumé measured at
      // two pages against a one-page target.
      assert(/let verified = null;/.test(localSource)
        && /verified = \{ density, compactApplied, bytes, pageCount, layout \};/.test(localSource)
        && /\(\(!fontsLoaded \|\| renderError \|\| !Number\.isFinite\(pageCount\)\) && verified\)/.test(localSource),
      'the résumé fit loop must fall back to the last attempt it actually verified');
      assert(!/web fonts were unavailable/.test(localSource)
        && localSource.includes('the render window reported unresolved font face(s)'),
      'render-retry feedback must report the observed faces rather than assert an unobserved network cause');
      const syncSource = fs.readFileSync(new URL('../../electron/ipc/applicationSync.js', import.meta.url), 'utf8');
      assert(!/Reconnect to the internet/.test(syncSource)
        && syncSource.includes('could not resolve the application fonts'),
      'Sync must not diagnose a font-readiness failure as a lost internet connection');
      return { retryPresent: true };
    },
  },
  {
    name: 'Local AI validation: independent families report every defect in one rejection',
    async run() {
      const id = crypto.randomUUID();
      const root = path.join(os.tmpdir(), 'local-ai-project');
      // One résumé-prose defect and one cover-letter defect in the same bytes.
      // Before aggregation the résumé family threw first and the cover-letter
      // failure stayed invisible until the next round, which is how a handoff
      // reaches four rounds for two defects.
      let message = '';
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Containerized the internal-tools hub with Docker Compose, running Django under Gunicorn behind Nginx.</li></ul></article></main>',
          coverLetter: { ...normalizedCoverLetter(), paragraphs: ['I would welcome the chance to talk about that work.'] },
          coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
        }, id, root);
      } catch (error) { message = String(error?.message || error); }
      assert(message.includes('independent validation failures'),
        `two independent families must be reported together, got ${JSON.stringify(message.slice(0, 400))}`);
      assert(message.includes('(1)') && message.includes('(2)'),
        'an aggregated rejection must number its defects so the revision addresses all of them');
      assert(message.includes('direct-welcome-closing'),
        `the cover-letter defect must survive aggregation, got ${JSON.stringify(message.slice(0, 400))}`);
      // The dash gate is a third aggregation depth: three independent dash
      // defects across both documents used to cost three rounds.
      let dashMessage = '';
      let dashFailures = null;
      try {
        assertCandidateDashPunctuation({
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built a pipeline \u2014 it worked.</li><li>Ran it daily - every day.</li></ul></article></main>',
          coverLetter: { name: 'A', contact: [], salutation: 'Dear Team,', recipient: '', paragraphs: ['A letter \u2014 with a dash.'], closing: 'Sincerely,', signatureTitle: '' },
        });
      } catch (error) { dashMessage = String(error?.message || error); dashFailures = error?.failures || null; }
      assert(Array.isArray(dashFailures) && dashFailures.length === 3,
        `every dash defect across both documents must be reported at once, got ${JSON.stringify(dashFailures)}`);
      assert(/Résumé copy contains an em dash/.test(dashMessage) && /Cover-letter copy contains an em dash/.test(dashMessage),
        'the aggregated dash message must name both surfaces');
      let singleDash = '';
      let singleFailures = 'unset';
      try {
        assertCandidateDashPunctuation({
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built a pipeline \u2014 it worked.</li></ul></article></main>',
        });
      } catch (error) { singleDash = String(error?.message || error); singleFailures = error?.failures; }
      assert(singleFailures === undefined
        && singleDash === 'Résumé copy contains an em dash. Use a comma, conjunction, colon, semicolon, parentheses, or separate sentences instead.',
      `a lone dash defect must keep its original message byte-for-byte, got ${JSON.stringify(singleDash)}`);
      const localSource = fs.readFileSync(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert(localSource.includes('function joinValidationFailures')
        && /const entryFailures = \[\];/.test(localSource),
      'source-grounding entries must be graded independently rather than failing on the first one');
      // Aggregation happens at three depths, so the record must still read as
      // ONE flat numbered list: a nested prefix produced two “(1)” markers.
      const trustedCareerData = 'Built supported systems. A concise factual letter.';
      const validResumeMain = '<main class="page"><section class="section"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section></main>';
      const fabricated = {
        version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: validResumeMain,
        coverLetter: normalizedCoverLetter(), coverLetterArgument: validCoverLetterArgument(),
        qualityReview: groundedQualityReview(sourceGroundingFor()),
      };
      // Two grounding families broken at once: a bullet quote and a paragraph
      // quote that appear nowhere in the trusted career data.
      fabricated.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes = ['Absent bullet provenance sentence.'];
      fabricated.qualityReview.sourceGrounding.coverLetterParagraphs[0].careerDataQuotes = ['Absent paragraph provenance sentence.'];
      let grounding = '';
      try {
        validateLocalApplicationResult(fabricated, id, root, {}, { careerData: trustedCareerData });
      } catch (error) { grounding = String(error?.message || error); }
      assert((grounding.match(/not an exact quote/g) || []).length === 2,
        `both grounding families must report together, got ${JSON.stringify(grounding.slice(0, 400))}`);
      // A bounded record must never cut a defect mid-sentence or drop one
      // without saying so — a report that hides findings is worse than one
      // that admits it truncated.
      const many = Array.from({ length: 40 }, (_, index) => `Defect ${index + 1}: ${'x'.repeat(400)}`);
      const bounded = boundedRejectionError(Object.assign(new Error('ignored'), { failures: many }));
      assert(bounded.length <= 12_000, `the bounded record must fit its cap, got ${bounded.length}`);
      assert(/more defect\(s\) omitted from this record/.test(bounded),
        'a bounded record must say how many defects it left out');
      assert(!/x{399}[^x]x/.test(bounded) && bounded.includes('Defect 1:'),
        'the bounded record must keep whole defects rather than cutting one mid-sentence');
      const small = boundedRejectionError(Object.assign(new Error('ignored'), { failures: ['Only defect.'] }));
      assert(small === 'Only defect.', `a record that fits must be unchanged, got ${JSON.stringify(small)}`);
      // One em dash is one defect: checkPunctuationStyle and the dash gate both
      // read the letter, and reporting both sent the writer hunting for a
      // second problem that did not exist.
      let dashCount = '';
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: validResumeMain,
          coverLetter: { ...normalizedCoverLetter(), paragraphs: ['A letter \u2014 with one dash.'] },
          coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
        }, id, root);
      } catch (error) { dashCount = String(error?.message || error); }
      assert(!/independent validation failures/.test(dashCount)
        && !/Cover-letter copy contains an em dash/.test(dashCount),
      `one em dash must be reported once, got ${JSON.stringify(dashCount.slice(0, 300))}`);
      // A structural failure must not discard a prose defect already measured.
      let structural = '';
      try {
        validateLocalApplicationResult({
          version: LOCAL_AI_APPLICATION_VERSION, jobId: id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          resumeMainHtml: '<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Containerized the internal-tools hub with Docker Compose, running Django under Gunicorn behind Nginx.</li></ul></article></main>',
          coverLetter: { ...normalizedCoverLetter(), paragraphs: [] },
          coverLetterArgument: validCoverLetterArgument(), qualityReview: draftedQualityReview(),
        }, id, root);
      } catch (error) { structural = String(error?.message || error); }
      assert(/failed editorial checks/.test(structural),
        `a structural throw must carry the already-measured résumé defect, got ${JSON.stringify(structural.slice(0, 300))}`);
      const markers = grounding.match(/\(\d+\)/g) || [];
      assert(!grounding || new Set(markers).size === markers.length,
        `an aggregated rejection must be one flat numbered list, got markers ${JSON.stringify(markers)}`);
      assert((grounding.match(/independent validation failures/g) || []).length <= 1,
        'the aggregate preamble must never nest inside itself');
      return { aggregated: true, markers: markers.length };
    },
  },
  {
    name: 'Local AI grounding: qualifier evidence is accepted in the word forms career data actually uses',
    async run() {
      // The real rejection: a bullet said "optimization" while its bound quote
      // said "flight route optimizations", and the source regex could not match
      // its own plural.
      const identityTokens = [];
      const accepted = [
        ['Researched and tested shortest path algorithms for flight route optimization.',
          ['Modified A* to account for the curvature of the Earth for flight route optimizations at Boeing.']],
        ['Decided the integration boundary for the district reporting pipeline.',
          ['Owned the architecture decisions for the district reporting pipeline at Thomson.']],
        ['Led the connector rollout across the reporting stack.',
          ['I lead the connector rollout across the reporting stack at Thomson.']],
        ['Managed the nightly extract schedule for student records.',
          ['Held management of the nightly extract schedule for student records at Thomson.']],
        // Fix A: plural "optimizations" in a bullet must now trigger the gate
        // AND be satisfied by a quote that also uses the plural.
        ['Built route optimizations for domestic flight legs using the district scheduler.',
          ['Modified A* to account for the curvature of the Earth for flight route optimizations at Boeing.']],
        // Fix B: a "never" claim must be grounded by "without ever" in the quote.
        ['Built a focus-preserving overlay that never interrupts the active workflow.',
          ['Built a status overlay without ever interrupting your focus or active workflow.']],
      ];
      // A widened source side must never cross a SENSE boundary: these are the
      // homographs an inflection sweep picks up, and every one of them is a
      // different word from the qualifier it would have grounded.
      const homographs = [
        ['Regularly parsed vendor logs with the shared parser library.',
          ['Wrote regular expressions for the vendor log parser library at Thomson.'], 'routine frequency'],
        ['Led the reporting migration into the district database.',
          ['Helped with the reporting migration after district leadership approved the database schedule.'], 'leadership ownership'],
        ['Cut reporting ingestion latency for the district database.',
          ['Used cutting-edge tooling to watch reporting ingestion latency on the district database.'], 'reduction outcome'],
        ['Saved the reporting team hours of manual database work.',
          ['Wrote the reporting job that keeps saving parsed database work to disk for the team.'], 'savings outcome'],
        // Bare "ever" without a negation word must not ground a "never" claim:
        // "better than ever" is a positive superlative, not a negation.
        ['Shipped a status bar widget that never blocked user focus.',
          ['The status bar widget felt better than ever after the focus work landed.'], 'absolute frequency'],
        // A plural bullet ("optimizations") with no optimization word in the
        // quote must still be rejected now that the claim gate fires on the plural.
        ['Built route optimizations for domestic flight legs using the district scheduler.',
          ['Researched shortest path algorithms for domestic flight routes and rendered them on a globe at Boeing.'], 'optimization outcome'],
      ];
      for (const [finalText, quotes, label] of homographs) {
        let rejected = '';
        try { assertSourceQuoteLinksFinalText(finalText, quotes, 'resumeBullets', 0, { identityTokens }); }
        catch (error) { rejected = String(error?.message || error); }
        assert(rejected.includes(`unsupported ${label}`),
          `a homograph must not ground a ${label} claim: ${finalText}`);
      }
      for (const [finalText, quotes] of accepted) {
        assertSourceQuoteLinksFinalText(finalText, quotes, 'resumeBullets', 0, { identityTokens });
      }
      let rejected = false;
      try {
        assertSourceQuoteLinksFinalText(
          'Researched shortest path algorithms for flight route optimization.',
          ['Researched shortest path algorithms and rendered flight routes on a globe at Boeing.'],
          'resumeBullets', 0, { identityTokens },
        );
      } catch (error) { rejected = /unsupported optimization outcome/.test(String(error?.message || error)); }
      assert(rejected, 'a qualifier the bound quotes never state must still be rejected');
      return { accepted: accepted.length };
    },
  },
  {
    name: 'Local AI cover letter: the closing check accepts every documented shape and says what would pass',
    async run() {
      const shouldPass = [
        'I welcome a conversation about how my release-workflow experience could support the team’s deployment process.',
        'I welcome a conversation about applying my MCP server experience to the agent integrations this role owns.',
        'I welcome a conversation about bringing my Python integration work to the data pipelines your agents draw on.',
        'I welcome a conversation about where the connector work I built at Thomson would fit the systems this team already runs.',
        'I welcome a conversation about how the MCP server I built could shorten the path to your first production agent.',
        'I welcome a conversation about how my pipeline experience supports your ingestion backlog.',
        // An anchored demonstrative names the asset; only a bare one does not.
        'I welcome a conversation about using that MCP server experience to connect agents with client systems.',
        // A hyphenated head modifier is a real descriptor, not a filler.
        'I welcome a conversation about how that same-day pipeline experience could support your backlog.',
      ];
      for (const paragraph of shouldPass) {
        const result = checkDirectWelcomeClosing([paragraph]);
        assert(result.passed, `a closing that names a candidate asset and its target work must pass: ${paragraph}`);
      }
      const shouldFail = [
        ['I welcome a conversation about applying that work.', 'a bare demonstrative is not a candidate asset'],
        ['I welcome a conversation about applying the engineering practice this team uses.', 'an employer-facing “the” phrase is not a candidate asset'],
        ['I welcome a conversation about connecting the data pipelines those agents draw on.', 'an employer artifact is not a candidate asset'],
        ['I welcome a conversation about using my experience.', 'an asset and a verb with no employer-facing target point nowhere'],
        ['I welcome a discussion about compensation, benefits, and how my experience applies to my salary expectations.', 'a candidate-facing target is not the target work'],
        ['I welcome a conversation about that kind of work and bringing more of it into my life.', 'a filler descriptor is still a bare demonstrative'],
        // The floor is on the HEAD modifier, not the first token: "broader"
        // does not rescue "kind of work", and a light-noun frame always puts
        // `of` or a light noun next to the asset noun.
        ['I welcome a conversation about how that broader kind of work could support your backlog.', 'a leading adjective does not rescue a light-noun frame'],
        ['I welcome a conversation about how that same work could support your backlog.', 'a light modifier names nothing'],
        ['I look forward to discussing this next phase of work and using it to grow.', 'a filler descriptor plus inward intent must not pass'],
        ['I would welcome a conversation about how that combination could support the WAVES rebuild.', 'conditional register'],
        ['I welcome a conversation about whether the voice assistant or browser agent should be the first prototype.', 'employer-choice close'],
        ['I look forward to learning more about the team.', 'inward-facing close'],
      ];
      for (const [paragraph, why] of shouldFail) {
        assert(!checkDirectWelcomeClosing([paragraph]).passed, `${why} must still be rejected: ${paragraph}`);
      }
      // The observation has to be executable: the same check failed twice in a
      // row on a real handoff because the message described the goal but never
      // the construction, so the revision missed it again.
      const detail = checkDirectWelcomeClosing(['I welcome a conversation about applying that work.']).detail;
      assert(detail.includes('possessive, an authorship clause, or a demonstrative that carries its own descriptor')
        && detail.includes('the connector I built')
        && detail.includes('never a bare demonstrative'),
      `the rejection must name the accepted construction, got ${JSON.stringify(detail)}`);
      return { passing: shouldPass.length, rejecting: shouldFail.length };
    },
  },
  {
    name: 'Local AI résumé: the 180-character bullet budget is enforced by the app, not only by an unreachable design-system script',
    async run() {
      const role = (li) => `<main class="page"><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights">${li}</ul></article></main>`;
      const within = 'Built the reporting pipeline that merged four district systems into one nightly extract.';
      const over = `${within} It also handled retries, backfills, schema drift, and a reconciliation report for every run and every source system involved.`;
      assert(checkResumeBulletLength(role(`<li>${within}</li>`)).passed,
        'a bullet inside the budget must pass');
      const rejected = checkResumeBulletLength(role(`<li>${over}</li>`));
      assert(!rejected.passed && /visible characters \(budget 180\)/.test(rejected.detail),
        `an over-budget bullet must be named with its measured length, got ${JSON.stringify(rejected.detail)}`);
      // The .tradeoff clause carries the tighter sub-budget, measured without
      // its label span — the label nests inside .tradeoff, and a naive
      // same-tag match would stop at the label's own closing tag.
      const longTradeoff = `<li>Short bullet body. <span class="tradeoff"><span class="annotation-label">Tradeoff</span> ${'x'.repeat(120)}</span></li>`;
      const tradeoffRejected = checkResumeBulletLength(role(longTradeoff));
      assert(!tradeoffRejected.passed && /tradeoff annotation \(budget 100\)/.test(tradeoffRejected.detail),
        `an over-budget tradeoff clause must be reported, got ${JSON.stringify(tradeoffRejected.detail)}`);
      assert(checkResumeBulletLength(role('<li>Short bullet body. <span class="tradeoff"><span class="annotation-label">Tradeoff</span> kept the nightly window under ten minutes</span></li>')).passed,
        'a tradeoff inside its sub-budget must pass');
      assert(evaluateResumeProseChecks(role(`<li>${over}</li>`)).some(check => check.id === 'resume-bullet-length' && !check.passed),
        'the budget check must run inside the shared pre-publication résumé prose checks');
      // `.tradeoff` legitimately nests the allowlisted `.nowrap` span, and a
      // lazy same-tag match stopped at the first nested close tag — measuring a
      // fragment and passing an over-budget clause.
      const clause = 'kept p99 under <span class="nowrap">10 ms</span> by trading write throughput for read latency across the entire nightly reconciliation window every run';
      const nested = checkResumeBulletLength(role(`<li>Chose a datastore.<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>${clause}</span></li>`));
      assert(!nested.passed && /123-character tradeoff annotation/.test(nested.detail),
        `a nested span must not truncate the measured tradeoff clause, got ${JSON.stringify(nested.detail)}`);
      // The budget counts visible characters the way the design system's own
      // gate does: tags strip to nothing, so a mid-token tag adds no character.
      const midToken = extractResumeEvidence(role('<li>Cut <b data-achievement-id="a1">p99</b>-latency on the district ingest path.</li>'));
      assert(midToken.roles[0].bullets[0].budgetText.includes('p99-latency'),
        'the budget measurement must not insert a space at a mid-token tag boundary');
      return { enforced: true };
    },
  },
  {
    // The shipped MGT/AI Solutions Architect résumé rendered three roles with a
    // `.role-header` and nothing else, dropping "Loveland, Colorado",
    // "Getzville, New York" and "Oshawa, Ontario" — all three stated in the
    // career data. Nothing asked for them and nothing measured their absence,
    // so the result imported clean. These are the two halves of that fix.
    name: 'Local AI résumé: a work location the career data states must reach the role, in either legal cell',
    async run() {
      const CAREER = [
        '### Software Engineer',
        '',
        '**Thomson School District — Loveland, Colorado**',
        '*May, 2023 – June, 2026*',
        '',
        '### Data Engineer',
        '**Horizon Health Alliance — Getzville, New York**',
        '',
        '### Software Engineer',
        '**FliteX (Plan de Vol International) — Oshawa, Ontario**',
        '',
        '### Analyst',
        '**Unlocated Systems — Consumer Robotics, Hardware**',
      ].join('\n');

      // The career-data side reads the employer's own heading line and is sure
      // or silent: a tail that is not a `City, Region` yields no requirement.
      const stated = careerDataRoleLocation(CAREER, 'Thomson School District');
      assert(stated && stated.city === 'Loveland' && stated.region === 'Colorado' && stated.code === 'CO',
        `the employer heading must yield its stated city and region, got ${JSON.stringify(stated)}`);
      assert(careerDataRoleLocation(CAREER, 'FliteX (Plan de Vol International)')?.code === 'ON',
        'a parenthesised employer name and a Canadian province must both resolve');
      assert(careerDataRoleLocation(CAREER, 'Unlocated Systems') === null,
        'a tail that is not a recognised region must state no location rather than invent one');
      assert(careerDataRoleLocation(CAREER, 'Nowhere Inc') === null,
        'an employer the corpus never names must state no location');

      const role = (company, meta, dates = '<p class="role-dates">May 2023 – Jun 2026</p>') =>
        `<article class="role"><div class="role-header meta-row"><p class="role-title-line">`
        + `<span class="title">Software Engineer</span><span class="company">${company}</span></p>${dates}</div>`
        + `${meta}<ul class="highlights"><li>Built the nightly district extract.</li></ul></article>`;
      const page = (...roles) => `<main class="page">${roles.join('')}</main>`;

      // 1. The defect: a header-only role drops a stated location silently.
      const dropped = extractResumeEvidence(page(role('Thomson School District', '')));
      assert(dropped.roles[0].location === '', 'the reproduction must render no location');
      const failures = resumeRoleLocationFailures(dropped.roles, CAREER);
      assert(failures.length === 1 && failures[0].includes('Thomson School District')
        && failures[0].includes('Loveland, Colorado') && failures[0].includes('role-location'),
        `the gate must name the role, the stated location, and where it belongs, got ${JSON.stringify(failures)}`);

      // 2. The design system's own cell satisfies it.
      const metaRow = page(role('Thomson School District',
        '<div class="role-meta meta-row"><p class="role-location">Loveland, CO</p></div>'));
      const viaMeta = extractResumeEvidence(metaRow);
      assert(viaMeta.roles[0].location === 'Loveland, CO', 'a .role-location cell must be read as the location');
      assert(resumeRoleLocationFailures(viaMeta.roles, CAREER).length === 0,
        'an abbreviated region must satisfy the stated location — shortening is formatting, not a new fact');

      // 3. So does the STYLE.md §5.2b fold, which is what a tight page uses.
      // The dates cell must still read back as the date range alone.
      const folded = extractResumeEvidence(page(role('Thomson School District', '',
        '<p class="role-dates"><time datetime="2023-05">May 2023</time> – <time datetime="2026-06">Jun 2026</time><span class="sep" aria-hidden="true">·</span>Loveland, CO</p>')));
      assert(folded.roles[0].location === 'Loveland, CO' && folded.roles[0].dates === 'May 2023 – Jun 2026',
        `a folded location must split back into dates + location, got ${JSON.stringify(folded.roles[0])}`);
      assert(resumeRoleLocationFailures(folded.roles, CAREER).length === 0,
        'the fold is a legal home for the location, not a missing one');

      // A plain date range must never be mistaken for a fold, and a role the
      // corpus never located must not be required to show anything.
      const plain = extractResumeEvidence(page(role('Unlocated Systems', '')));
      assert(plain.roles[0].dates === 'May 2023 – Jun 2026' && plain.roles[0].location === '',
        'an unfolded dates cell must stay entirely in dates');
      assert(resumeRoleLocationFailures(plain.roles, CAREER).length === 0,
        'a role with no stated location must raise no requirement');

      // 4. A location that contradicts the career data is its own defect.
      const wrong = extractResumeEvidence(page(role('Thomson School District',
        '<div class="role-meta meta-row"><p class="role-location">Denver, CO</p></div>')));
      const wrongFailures = resumeRoleLocationFailures(wrong.roles, CAREER);
      assert(wrongFailures.length === 1 && wrongFailures[0].includes('Denver, CO') && wrongFailures[0].includes('Loveland'),
        `a contradicted location must be reported distinctly from a missing one, got ${JSON.stringify(wrongFailures)}`);

      // 5. The bug report can finally see the role block. This sample renderer
      // has existed in jobsSnapshot.js with no producer, so the section that
      // shows "where the location ended up" was absent from every report.
      const sample = resumeRoleBlockSample(metaRow);
      assert(sample.found && sample.roleCount === 1 && sample.sample.includes('role-location') && !sample.truncated,
        `the role-block sample must carry the meta row, got ${JSON.stringify(sample).slice(0, 300)}`);
      assert(resumeRoleBlockSample('<main class="page"></main>').found === false,
        'a résumé with no role article must report the sample as not found, not fabricate one');
      assert(resumeRoleBlockSample(metaRow, 40).truncated === true,
        'an oversized role block must report itself truncated');
      const twoRoles = resumeRoleBlockSample(metaRow.replace('</main>', metaRow.slice(metaRow.indexOf('<article'), metaRow.indexOf('</main>')) + '</main>'));
      assert(twoRoles.roleCount === 2 && twoRoles.sample.split('<article').length === 2,
        `the sample must count every role but carry only the first, got roleCount ${twoRoles.roleCount}`);

      // 6. Production sanitizes the model's markup BEFORE any of this parses
      // it, so the fold has to survive that pass — the <time> elements and the
      // prescribed .sep span included. Testing only raw markup would not show it.
      const sanitized = sanitizeDocumentMainHtml(page(role('Thomson School District', '',
        '<p class="role-dates"><time datetime="2023-05">May 2023</time> – <time datetime="2026-06">Jun 2026</time><span class="sep" aria-hidden="true">·</span>Loveland, CO</p>')),
        { documentKind: 'resume' });
      const throughSanitizer = extractResumeEvidence(sanitized).roles[0];
      assert(throughSanitizer.location === 'Loveland, CO' && throughSanitizer.dates === 'May 2023 – Jun 2026',
        `the fold must survive the production sanitizer, got ${JSON.stringify(throughSanitizer)}`);
      assert(resumeRoleLocationFailures([throughSanitizer], CAREER).length === 0,
        'a sanitized folded location must clear the gate');

      // A place name may legitimately carry a number. The fold's guard exists to
      // reject a second DATE, so it tests for a year, not for any digit.
      const numbered = extractResumeEvidence(page(role('Thomson School District', '',
        '<p class="role-dates">May 2023 – Jun 2026<span class="sep" aria-hidden="true">·</span>Route 66, MO</p>')));
      assert(numbered.roles[0].location === 'Route 66, MO',
        `a digit in a place name must not discard the location, got ${JSON.stringify(numbered.roles[0])}`);
      const twoRanges = extractResumeEvidence(page(role('Thomson School District', '',
        '<p class="role-dates">May 2023 – Jun 2026<span class="sep" aria-hidden="true">·</span>Jan 2020 – Mar 2021</p>')));
      assert(twoRanges.roles[0].location === '', 'a second date range must not be read as a location');

      // 7. The fold split must be LINEAR. The obvious regex for it
      // (/^(.*\d.*?)\s*·\s*([^·]+)$/) backtracks quadratically on a
      // digit-bearing cell with no separator — 2.4s at 24k chars, per role,
      // inside a synchronous main-process import.
      const huge = page(role('Thomson School District', '',
        `<p class="role-dates">${'1 '.repeat(60000)}</p>`));
      const started = Date.now();
      assert(extractResumeEvidence(huge).roles[0].location === '',
        'a separator-less dates cell yields no location');
      const elapsed = Date.now() - started;
      assert(elapsed < 2000, `the fold split must not backtrack: 120k chars took ${elapsed}ms`);
      return { enforced: true };
    },
  },
  {
    // Three defects an adversarial pass reproduced against the real corpus
    // before this test existed. The first is the dangerous one: matching the
    // employer as a bare substring made a CORRECT résumé fail, with an
    // instruction to render the fabricated string "Alliance — Getzville".
    name: 'Local AI résumé: the work-location matcher survives short, long, colliding and ambiguous employer names',
    async run() {
      const CAREER = [
        '**Thomson School District — Loveland, Colorado**',
        '**Horizon Health Alliance — Getzville, New York**',
        '**FliteX (Plan de Vol International) — Oshawa, Ontario**',
      ].join('\n');
      const at = (company) => careerDataRoleLocation(CAREER, company);

      // The résumé may shorten or extend the corpus's own name for an employer.
      assert(at('Horizon Health Alliance')?.text === 'Getzville, NY', 'the exact name must resolve');
      assert(at('Horizon Health')?.text === 'Getzville, NY',
        `a shortened employer must resolve to its real city, got ${JSON.stringify(at('Horizon Health'))}`);
      assert(at('FliteX')?.text === 'Oshawa, ON',
        'dropping a parenthetical must not disable the requirement — fail-open here is the evasion path');
      assert(at('Thomson School District (K-12)')?.text === 'Loveland, CO',
        'a résumé name longer than the corpus name must still resolve');

      // ...but only on a whole-word boundary, and never past a real ambiguity.
      assert(at('Health') === null, 'a mid-name fragment must not match an employer');
      assert(careerDataRoleLocation('**Acmetrics — Buffalo, New York**', 'Acme') === null,
        'a prefix that is not a whole word must not match');
      assert(careerDataRoleLocation('**Acme Health — Buffalo, New York**\n**Acme Systems — Denver, Colorado**', 'Acme') === null,
        'two employers extending one name is a genuine ambiguity — guessing invents a requirement');
      assert(careerDataRoleLocation('**Acme Health — Buffalo, New York**\n**Acme — Denver, Colorado**', 'Acme')?.text === 'Denver, CO',
        'an exact heading must win over a longer neighbour that also matches');
      assert(careerDataRoleLocation('**Acme — Denver, Colorado**\n- Partnered with Globex - Austin, Texas', 'Globex') === null,
        'a company named inside a bullet is not an employer heading');
      assert(careerDataRoleLocation('**Acme, Denver, Colorado**', 'Acme') === null,
        'a heading with no employer/location separator states no location');
      assert(careerDataRoleLocation('**Foo-Bar Inc — Denver, Colorado**', 'Foo-Bar Inc')?.text === 'Denver, CO',
        'a hyphen inside the employer name must not be read as the heading separator');
      assert(careerDataRoleLocation('**Acme — Remote (US)**', 'Acme') === null,
        'a location the region set does not recognise states nothing rather than inventing a requirement');
      // The heading split is greedy because the LOCATION is the tail. A
      // non-greedy split cut at the first spaced dash, so an employer whose own
      // name contains one reported the city `Whitfield Consulting — Denver`
      // and rejected a correct résumé.
      assert(careerDataRoleLocation('**Baker - Whitfield Consulting — Denver, Colorado**', 'Baker - Whitfield Consulting')?.text === 'Denver, CO',
        'an employer name containing a spaced dash must keep all of its name');
      assert(resumeRoleLocationFailures(
        [{ title: 'SE', company: 'Baker - Whitfield Consulting', location: 'Denver, CO' }],
        '**Baker - Whitfield Consulting — Denver, Colorado**').length === 0,
        'a correct résumé for a two-part employer name must not be rejected');
      assert(careerDataRoleLocation('**Acme — Denver, Colorado**\n**Acme — Austin, Texas**', 'Acme') === null,
        'two stints at one employer in two cities is an ambiguity, not a first-wins guess');
      // A division suffix hit the same first-dash split, and because the left
      // half was still the bare company it matched EXACTLY — so the ambiguity
      // guard never ran and a correct résumé was rejected outright.
      assert(careerDataRoleLocation('**Thomson School District - IT Department — Loveland, Colorado**', 'Thomson School District')?.text === 'Loveland, CO',
        'a division suffix in the heading must not become part of the city');
      assert(resumeRoleLocationFailures(
        [{ title: 'SWE', company: 'Thomson School District', location: 'Loveland, CO' }],
        '**Thomson School District - IT Department — Loveland, Colorado**').length === 0,
        'a correct résumé must not be rejected because the heading names a division');

      // The city is matched by the same prefix relation as the employer, which
      // tolerates one name extending the other on purpose — see the comment in
      // resumeRoleLocationFailures. Pinned so the trade-off stays a decision.
      assert(resumeRoleLocationFailures([{ title: 'SE', company: 'Acme', location: 'New York' }],
        '**Acme — New York City, New York**').length === 0,
        'a résumé may write the shorter form of a longer stated city');

      // The region is compared when the résumé shows one, and never demanded
      // when it does not — supplying the missing half is the fabrication this
      // whole rule exists to prevent.
      const shownVerdict = (location) => resumeRoleLocationFailures(
        [{ title: 'SE', company: 'Thomson School District', location }], CAREER).length === 0;
      assert(shownVerdict('Loveland, CO'), 'an abbreviated region must pass');
      assert(shownVerdict('Loveland, Colorado'), 'the written-out region must pass');
      assert(shownVerdict('Loveland'), 'a city with no region must pass — the region is never demanded');
      assert(!shownVerdict('Loveland, TX'), 'a region that contradicts the career data must be rejected');
      assert(!shownVerdict('Denver, CO'), 'a different city must be rejected');
      assert(!shownVerdict('New Loveland, CO'), 'a city that merely contains the stated one must be rejected');
      return { enforced: true };
    },
  },
  {
    // resumeRoleBlockSample, resumeSkillsDlSample and resumeHtmlSample were all
    // RENDERED by the bug report and PRODUCED by nothing, so the section that
    // shows "where the location ended up" was permanently absent — which is why
    // a résumé that dropped every work location looked identical to a correct
    // one in every diagnostic. Pinning the producer/consumer pair is the only
    // thing that keeps this from silently reverting to a dead field.
    name: 'Local AI telemetry: the bug report\u2019s role-block sample has a producer on every terminal record',
    async run() {
      const localSource = await fs.promises.readFile(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const snapshotSource = await fs.promises.readFile(path.resolve('electron/ipc/bugReport/jobsSnapshot.js'), 'utf8');

      const produced = [...localSource.matchAll(/resumeRoleBlockSample: resumeRoleBlockSample\(result\.resumeMainHtml\)/g)];
      const telemetryCalls = [...localSource.matchAll(/recordApplicationTelemetry\(\{/g)];
      assert(telemetryCalls.length === 3 && produced.length === 3,
        `every Local AI telemetry record must carry the role-block sample, got ${produced.length} of ${telemetryCalls.length}`);
      assert(localSource.includes('resumeHtmlLen: result.resumeMainHtml.length'),
        'the report\u2019s "Résumé markup: N chars" line needs its producer too');

      // The consumer reads exactly the shape the producer emits.
      for (const field of ['found', 'roleCount', 'sample', 'truncated']) {
        assert(snapshotSource.includes(`a.resumeRoleBlockSample.${field}`),
          `the bug report reads resumeRoleBlockSample.${field}, so the producer must emit it`);
      }
      const emitted = resumeRoleBlockSample('<main class="page"><article class="role"><ul class="highlights"><li>x</li></ul></article></main>');
      assert(['found', 'roleCount', 'sample', 'truncated'].every(key => key in emitted),
        `the producer must emit every field the renderer reads, got ${Object.keys(emitted).join(', ')}`);
      return { enforced: true };
    },
  },
  {
    name: 'Local AI validation: personal-project provenance survives selection, markup variants, and rendering',
    run() {
      const careerData = [
        'Built supported systems.',
        'A concise factual letter.',
        '',
        '## Personal Projects',
        '',
        'AI-Chalkboard',
        'A native macOS MCP server for transparent on-screen annotation.',
        '',
        'Marketplace Hub',
        'Uses AI to draft and monitor resale listings.',
        '',
        'Infinite Canvas A spatial productivity app built on a pannable canvas.',
        '',
        '## Open Source',
        '',
        'Canvas Exporter',
        'A community-maintained exporter for spatial boards.',
        '',
        '## Professional Projects',
        '',
        'Acme Platform',
        'An employer-owned workflow platform.',
        '',
        '## Skills',
        'JavaScript',
      ].join('\n');
      const section = (heading, body = '<article class="project"><h3 class="project-name">AI-Chalkboard</h3><p class="project-desc">A native macOS MCP server.</p></article>') => `
        <section class="section" aria-labelledby="sec-projects">
          <div class="section-head"><h2 id="sec-projects">${heading}</h2><span class="rule"></span></div>
          ${body}
        </section>`;
      const experience = '<section class="section"><div class="section-head"><h2>Experience</h2></div><article class="role"><span class="title">Engineer</span><span class="company">Acme</span><ul class="highlights"><li>Built supported systems.</li></ul></article></section>';
      const resume = (heading, body) => `<main class="page">${experience}${section(heading, body)}</main>`;

      const selectedFailures = resumeProjectProvenanceFailures(resume('Selected Projects'), careerData);
      assert(selectedFailures.length === 1
        && selectedFailures[0].includes('AI-Chalkboard')
        && selectedFailures[0].includes('Personal Projects')
        && selectedFailures[0].includes('Selected Projects'),
      `a retained personal project under Selected Projects must report the lost provenance, got ${JSON.stringify(selectedFailures)}`);
      assert(resumeProjectProvenanceFailures(resume('Projects'), careerData).length === 1,
        'a generic Projects heading cannot erase explicit personal-project provenance');
      assert(resumeProjectProvenanceFailures(resume('Selected Personal Projects'), careerData).length === 1,
        'adding Selected is not an exact preservation of the source category');
      assert(resumeProjectProvenanceFailures(resume('Personal Projects'), careerData).length === 0,
        'the exact Personal Projects heading preserves the source attribution');
      assert(resumeProjectProvenanceFailures(resume('Personal Projects'), careerData.replace('## Personal Projects', 'Personal Projects')).length === 0
        && resumeProjectProvenanceFailures(resume('Selected Projects'), careerData.replace('## Personal Projects', 'Personal Projects')).length === 1,
      'both markdown and faithfully transcribed plain Personal Projects headings are recognized');

      for (const body of [
        '<div class="project"><h3 class="project-name">Marketplace Hub</h3></div>',
        '<div class="project"><span class="title">Infinite Canvas</span></div>',
        '<article class="role"><span class="title">AI-Chalkboard</span><ul class="highlights"><li>A native macOS MCP server.</li></ul></article>',
      ]) {
        assert(resumeProjectProvenanceFailures(resume('Selected Projects', body), careerData).length === 1,
          `project provenance must not depend on one generated component shape: ${body}`);
      }
      assert(resumeProjectProvenanceFailures(`<main class="page">${experience}</main>`, careerData).length === 0,
        'omitting an optional personal-project section remains valid');
      const ordinaryExperienceNameCollision = experience.replace('>Engineer<', '>AI-Chalkboard<');
      assert(resumeProjectProvenanceFailures(`<main class="page">${ordinaryExperienceNameCollision}</main>`, careerData).length === 0,
        'an ordinary Experience role title that happens to equal a personal project must not be relabelled as a project');
      const ambiguousCareerData = `${careerData}\n\n## Open Source\n\nAI-Chalkboard\nA separate community project with the same name.`;
      assert(resumeProjectProvenanceFailures(resume('Selected Projects'), ambiguousCareerData).length === 0,
        'a same-name project in two different source categories is ambiguous and must not trigger a guessed attribution');
      assert(resumeProjectProvenanceFailures(resume('Projects'), careerData.replace('## Personal Projects', '## Featured Work')).length === 0,
        'the targeted gate does not invent a project attribution when the source heading is generic');

      const openSourceBody = '<article class="project"><h3 class="project-name">Canvas Exporter</h3><p class="project-desc">A community-maintained exporter.</p></article>';
      const openSourceFailures = resumeProjectProvenanceFailures(resume('Selected Projects', openSourceBody), careerData);
      assert(openSourceFailures.length === 1
        && openSourceFailures[0].includes('Canvas Exporter')
        && openSourceFailures[0].includes('Open Source')
        && openSourceFailures[0].includes('Selected Projects'),
      `an explicit open-source project category must not be flattened either, got ${JSON.stringify(openSourceFailures)}`);
      assert(resumeProjectProvenanceFailures(resume('Open Source', openSourceBody), careerData).length === 0,
        'the source’s explicit Open Source heading preserves that project’s provenance');
      assert(resumeProjectProvenanceFailures(resume('Personal Projects', openSourceBody), careerData).length === 1,
        'a project cannot inherit a different provenance category merely because it is a project section');

      const professionalBody = '<article class="project"><h3 class="project-name">Acme Platform</h3><p class="project-desc">An employer-owned workflow platform.</p></article>';
      const professionalFailures = resumeProjectProvenanceFailures(resume('Selected Projects', professionalBody), careerData);
      assert(professionalFailures.length === 1
        && professionalFailures[0].includes('Acme Platform')
        && professionalFailures[0].includes('Professional Projects'),
      `an employer-affiliated project cannot be presented as attribution-free selected work, got ${JSON.stringify(professionalFailures)}`);
      assert(resumeProjectProvenanceFailures(resume('Professional Projects', professionalBody), careerData).length === 0,
        'the explicit Professional Projects heading preserves employer-affiliated project provenance');

      const result = (heading) => ({
        version: LOCAL_AI_APPLICATION_VERSION,
        jobId: LOCAL_AI_TEST_JOB_ID,
        status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: resume(heading),
        coverLetter: normalizedCoverLetter(),
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: groundedQualityReview(sourceGroundingFor()),
      });
      let mismatch = '';
      try {
        validateLocalApplicationResult(result('Selected Projects'), LOCAL_AI_TEST_JOB_ID, process.cwd(), {}, { careerData });
      } catch (error) { mismatch = String(error?.message || error); }
      assert(/provenance-bearing heading exactly as “Personal Projects”/u.test(mismatch),
        `the production trusted-context validator must reject the mismatch, got ${JSON.stringify(mismatch)}`);

      const valid = validateLocalApplicationResult(result('Personal Projects'), LOCAL_AI_TEST_JOB_ID, process.cwd(), {}, { careerData });
      const rendered = new JSDOM(buildResumeDocument({ resumeMainHtml: valid.resumeMainHtml }));
      try {
        const heading = rendered.window.document.querySelector('[data-ic-document-panel="resume"] #sec-projects')?.textContent;
        assert(heading === 'Personal Projects',
          `the accepted provenance heading must survive final document construction, got ${JSON.stringify(heading)}`);
      } finally {
        rendered.window.close();
      }
      return { enforced: true, variants: 3 };
    },
  },
  {
    name: 'Local AI validation: a dropped work location is rejected only when the career data actually states one',
    async run() {
      const CAREER = 'Jack Wu\n\n**Thomson School District — Loveland, Colorado**\n- Built the nightly district extract.\n';
      const resumeMainHtml = (meta) => `<main class="page"><article class="role">`
        + `<div class="role-header meta-row"><p class="role-title-line"><span class="title">Software Engineer</span>`
        + `<span class="company">Thomson School District</span></p><p class="role-dates">May 2023 – Jun 2026</p></div>`
        + `${meta}<ul class="highlights"><li>Built the nightly district extract.</li></ul></article></main>`;
      // The cover-letter envelope must be well-formed: it is validated before
      // the collected-failures block, so a malformed one would throw first and
      // the location gate would never run. Its own checks may still fail here —
      // every assertion below is scoped to the work-location wording alone.
      const result = (meta) => ({
        version: LOCAL_AI_APPLICATION_VERSION,
        jobId: 'job-1',
        status: 'completed',
        outputBundleRoot: 'Applied Jobs',
        resumeMainHtml: resumeMainHtml(meta),
        coverLetter: { ...normalizedCoverLetter(), paragraphs: ['I would welcome the chance to talk about that work.'] },
        coverLetterArgument: validCoverLetterArgument(),
        qualityReview: draftedQualityReview(),
      });

      // Without trusted career data there is no stated location, so the gate
      // must stay silent rather than demand one it cannot source.
      let untrustedError = null;
      try { validateLocalApplicationResult(result(''), 'job-1', process.cwd(), {}); } catch (error) { untrustedError = error; }
      assert(!untrustedError || !/work location/.test(String(untrustedError.message)),
        `a caller supplying no career data must never be told a location is missing, got ${untrustedError && untrustedError.message}`);

      let droppedError = null;
      try {
        validateLocalApplicationResult(result(''), 'job-1', process.cwd(), {}, { careerData: CAREER });
      } catch (error) { droppedError = error; }
      assert(droppedError && /work location/.test(String(droppedError.message))
        && /Thomson School District/.test(String(droppedError.message)),
        `a dropped stated location must reject the import by name, got ${droppedError && droppedError.message}`);

      let keptError = null;
      try {
        validateLocalApplicationResult(
          result('<div class="role-meta meta-row"><p class="role-location">Loveland, CO</p></div>'),
          'job-1', process.cwd(), {}, { careerData: CAREER },
        );
      } catch (error) { keptError = error; }
      assert(!keptError || !/work location/.test(String(keptError.message)),
        `a rendered location must clear the gate, got ${keptError && keptError.message}`);
      return { enforced: true };
    },
  },
  {
    name: 'Local AI contract: the writer is told a stated work location is required, and told it is not the privacy-gated one',
    async run() {
      const routineSource = await fs.promises.readFile(path.resolve('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8');
      const skillSource = await fs.promises.readFile(path.resolve('Job Application Design System/SKILL.md'), 'utf8');
      const styleSource = await fs.promises.readFile(path.resolve('Job Application Design System/STYLE.md'), 'utf8');

      // The routine declares itself the complete writer-facing contract, and it
      // never mentioned the role's location at all — while its only "location"
      // passages were prohibitions that read as covering employers.
      assert(routineSource.includes('the résumé must show')
        && routineSource.includes('role-location')
        && routineSource.includes('role-meta meta-row')
        && routineSource.includes('.role-dates'),
        'the routine states where a role location is rendered');
      assert(routineSource.includes('Three structural contracts'),
        'the routine counts the location contract among the ones that reject a result');
      assert(routineSource.includes('Never infer that contact location from an employer')
        && routineSource.includes('It does not reach the per-role employment locations'),
        'the routine scopes the contact-location privacy rule so it cannot be read as banning employment locations');
      assert(routineSource.includes("This bars them from the letter's prose only"),
        'the letter-scoped logistics ban says it is letter-scoped');
      // The privacy rule itself must survive intact.
      assert(routineSource.includes('candidate location/contact'),
        'the do-not-invent list still names candidate contact details');

      const flat = (text) => String(text).replace(/\s+/g, ' ');
      assert(/required\b[^.]{0,80}whenever the source data states a location for that role/.test(flat(skillSource)),
        'SKILL.md requires a stated per-role location');
      assert(skillSource.includes("A role's own stated work location is a") && skillSource.includes('required employment fact'),
        'SKILL.md negative-space list carves the employment fact out of the contact-location ban');
      assert(flat(styleSource).includes('**The location is required whenever the source data states one for that role**'),
        'STYLE.md §5.2 no longer grades the location optional');
      // The old wording is the regression that matters: a restored "optional
      // but recommended" would otherwise pass every additive assertion here.
      assert(!/The summary line and location are optional but recommended/.test(flat(styleSource)),
        'STYLE.md must not restore the wording that graded the location optional');
      assert(!/Per-role `\.role-location` values are\s+employment facts and may be used when supplied/.test(skillSource),
        'SKILL.md must not restore the permissive "may be used" wording');
      // The design system is shared and its fixtures are fictional; the real
      // candidate's employer city must not be pasted into it as an example.
      assert(!/Loveland/.test(styleSource) && !/Loveland/.test(skillSource),
        'design-system docs must not carry the real candidate\'s employment location');
      assert(styleSource.includes('### 5.2b Folding the location into the dates cell')
        && styleSource.includes('Fold only a lone location'),
        'STYLE.md documents the fold and its one precondition');
      return { enforced: true };
    },
  },
  {
    name: 'Local AI cover letter: employer introductions are accepted in every frame the contract describes',
    async run() {
      const employers = ['Thomson School District'];
      const shouldPass = [
        'My work as a data engineer at Thomson School District built the reporting pipeline.',
        'My work as a data engineer for Thomson School District built the reporting pipeline.',
        'At Thomson School District I served as the data engineer who built the reporting pipeline.',
        'Thomson School District hired me as a data engineer to build the reporting pipeline.',
        'At Thomson School District my role covered the reporting pipeline.',
      ];
      for (const paragraph of shouldPass) {
        assert(checkPriorEmployerOpening([paragraph], employers).passed,
          `a sentence that names the candidate's role or relationship must pass: ${paragraph}`);
      }
      for (const paragraph of [
        'Thomson School District runs a reporting pipeline that needed integration work.',
        'The reporting pipeline at Thomson School District needed integration work.',
        // The employer-first branches must assert a ROLE. "as" is also a
        // conjunction and "I am" is also a bare copula; admitting either made
        // the check fire on any first-person aside near the employer's name.
        'At Thomson School District, latency doubled as traffic grew.',
        'At Thomson School District the rollout stalled, as everyone predicted.',
        'A friend at Thomson School District mentioned the opening, so I am writing today.',
        'For Thomson School District the hiring bar is famously high, and I am glad it is.',
        'Thomson School District once ran a science fair that brought me to this field.',
      ]) {
        assert(!checkPriorEmployerOpening([paragraph], employers).passed,
          `an employer named with no candidate relationship must still be rejected: ${paragraph}`);
      }
      // The letter-wide off-posting budget is 2; the message used to quote the
      // per-paragraph budget of 1, so obeying it literally still failed.
      const tourParagraphs = ['I used Redis here.', 'I used Kafka here.', 'I used Terraform here.'];
      const tour = checkAnchorRelevance(tourParagraphs, 'a posting about data pipelines', '');
      if (!tour.passed) {
        assert(/keep at most 2 off-posting tool names in the whole letter/.test(tour.detail),
          `the letter-wide observation must quote the letter-wide budget, got ${JSON.stringify(tour.detail)}`);
      }
      return { frames: shouldPass.length };
    },
  },
  {
    name: 'Local AI contract: the routine states the rules the app actually enforces',
    async run() {
      // Markdown prose wraps, so every assertion below runs against a
      // whitespace-normalized copy — the same convention the version-2
      // contract assertions earlier in this file use.
      const routine = fs.readFileSync(new URL('../../local_ai/LOCAL_AI_APPLICATION_ROUTINE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
      // Every one of these was enforced by a hard reject while the contract
      // either omitted it or described something softer, so a writer obeying
      // the contract literally could still be rejected.
      for (const [label, needle] of [
        ['exact sentence-length threshold', 'keep every sentence to 40 words or fewer'],
        ['semicolon ban', 'Use no semicolon anywhere in the'],
        ['double hyphen', 'for a double hyphen between'],
        ['modifier-insertion stock phrases', 'more than basic presence'],
        ['primary line of defense', 'the primary line of defense'],
        ['exact foundation', 'exact foundation'],
        ['letter-wide off-posting budget', 'at most two tool names may be off-posting'],
        ['letter figure boundary', 'The letter carries at most three figures in total'],
        ['bullet character budget', '180 visible characters'],
        ['literal-form qualifier matching', 'The match is on the literal word form'],
        ['closing construction', 'authorship clause'],
        ['personal-project provenance', 'A source-stated project category is factual provenance'],
        ['generation audit input contract', '`manifest.json.generationAudit` both have `version: 1` and `required: true`'],
        ['legacy generation audit compatibility', 'A queued legacy job may have no `generationAudit` contract'],
        ['generation audit mismatch handling', 'If only one file has the contract or their values differ, stop and report the mismatch'],
        ['natural branch realization', 'do not make the cover letter narrate its own outline'],
        ['mirrored category scaffolding', 'Reject mirrored scaffolding such as `I handled <category> by ... I addressed <category> by ...`'],
        ['mechanism versus example wording', 'Use `by` when the action is the supported mechanism; use `such as` only'],
        ['scope-neutral parallel framing', 'use neutral parallel framing that claims neither'],
        ['exact audit paragraph binding', 'must bind every final cover-letter paragraph exactly once'],
        ['exact audit sentence binding', 'must do the same for every sentence in that paragraph'],
        ['audit chain-of-thought boundary', 'Do not add private reasoning, intermediate drafts, discarded alternatives, hidden chain-of-thought'],
        ['app-owned audit output', 'the app writes the durable file from the validated, projected fields'],
      ]) {
        assert(routine.includes(needle), `the routine must state the enforced ${label}`);
      }
      const skill = fs.readFileSync(new URL('../../Job Application Design System/SKILL.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
      const style = fs.readFileSync(new URL('../../Job Application Design System/STYLE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
      assert(skill.includes('authorship clause') && style.includes('authorship clause'),
        'the design references must carry the same closing construction as the routine and the validator');
      assert(skill.includes('Project-category provenance is binding too')
        && skill.includes('Personal Projects` must remain `Personal Projects')
        && style.includes('source-labelled "Personal Projects" stays exactly "Personal Projects"'),
      'the design references must preserve explicit personal-project provenance instead of steering the writer to a generic heading');
      return { documented: true };
    },
  },
];
