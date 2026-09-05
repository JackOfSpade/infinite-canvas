import crypto from 'node:crypto';
import { assert, assertCandidateDashPunctuation, assertSourceQuoteLinksFinalText, buildCoverLetterDocument, checkAnchorRelevance, checkDirectWelcomeClosing, checkPriorEmployerOpening, checkResumeBulletLength, evaluateResumeProseChecks, extractResumeEvidence, webFontFacesReadyExpression, canSaveImportedLocalApplication, discardLocalApplicationJob, discoverLocalApplicationJobs, ensureDirectoryWithinRoot, fs, JSDOM, os, path, LOCAL_AI_APPLICATION_VERSION, LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_FALLBACK_IDLE_STATUSES, collectNodesDeep, deepUpdateNode, importLocalApplicationJob, isJobCardMounted, localApplicationStatus, queueLocalApplicationJob, queuedLocalApplicationSettlement, readRegisteredApplicationArtifact, registerMountedJobCard, replacedLocalApplicationForCleanup, resolveLocalOutputBundleRoot, selectFallbackLocalAiJobs, selectOrphanedLocalAiJobs, unregisterMountedJobCard, validateLocalApplicationResult } from '../test-dependencies.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, boundedRejectionError } from '../../electron/ipc/localAiApplication.js';
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
        && localSource.includes('minimum 90%')
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
        && cardSource.includes('LOCAL_AI_RESULT_SETTLE_MS') && cardSource.includes('expectedResultSha256') && cardSource.includes('imported?.errorCode') && cardSource.includes('LOCAL_AI_RESULT_CHANGED') && cardSource.includes('waiting briefly for the final save'),
      'the card exposes repair for historical partial bundles, waits for a stable Local AI result before auto-importing, and retains fit, render, and validation recovery paths');
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
        assert(JSON.parse(manifest).status === 'queued' && parsedInput.jobId === queued.id
          && parsedInput.qualityChecklist?.version === APPLICATION_QUALITY_CHECKLIST_VERSION
          && JSON.stringify(parsedInput.qualityChecklist.criteria) === JSON.stringify(APPLICATION_QUALITY_CRITERIA),
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
          })
          && prompt.includes('execution handoff, not a request to explain')
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
        await fs.promises.writeFile(path.join(queued.folder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
        await fs.promises.writeFile(path.join(queued.folder, 'result.json'), JSON.stringify(legacyResult), 'utf8');
        const legacyStatus = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(legacyStatus.status === 'completed',
          'status accepts a v1 result only when this already queued app-owned input explicitly expects the supported legacy checklist version');
        const parsedManifest = JSON.parse(manifest);
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
        await queueLocalApplicationJob({
          job: { title: 'New Developer', company: 'Acme' }, careerData: TRUSTED_QUEUE_CAREER_DATA, canvasFilePath: project.canvasFilePath,
        });
        assert(fs.existsSync(stale.folder),
          'an old queued job remains available because an active authoring or revision session has no retention-based regeneration cap');
        assert(!fs.existsSync(staleImported.folder),
          'an old imported remnant with no active writer session is pruned before another job is accepted');
        return { activePreserved: true, staleImportedPruned: true };
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
        qualityReview: draftedQualityReview(),
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
      assert(JSON.stringify(selected) === JSON.stringify(['c-queued', 'c-completed', 'c-importing', 'c-revision', 'c-exhausted']),
        `the manager drives pending jobs on unmounted cards only — including an orphaned 'importing' (dead driver) and legacy exhausted job that must migrate — never terminal, manual-retry, mounted, or non-card nodes (got: ${selected.join(', ')})`);

      registerMountedJobCard('reg-1');
      assert(isJobCardMounted('reg-1'), 'a mounted card registers as the owner of its job');
      unregisterMountedJobCard('reg-1');
      assert(!isJobCardMounted('reg-1'), 'unmounting releases ownership to the fallback manager');
      assert(LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('importing') && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('importing'),
        "the card's own poll ignores 'importing' (it holds it mid-import) while the manager resumes an orphaned one");
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
    // session, so it must be emitted by save-application only after that
    // promotion and the private-workspace cleanup both succeed. Conversely, a
    // failed promotion must retain the Local AI job/result for retry.
    name: 'Local AI handoff: terminal receipt follows durable save and failed save retains the job',
    run: async () => {
      const localSource = await fs.promises.readFile(path.resolve('electron/ipc/localAiApplication.js'), 'utf8');
      const applicationSource = await fs.promises.readFile(path.resolve('electron/ipc/jobApplication.js'), 'utf8');
      const registrationAt = localSource.indexOf('const workDir = registerPendingApplicationWorkspace({');
      const receiptCalls = [...localSource.matchAll(/await writeLocalAiTerminalReceipt\(/g)].map(match => match.index);
      assert(registrationAt >= 0
        && /cleanupOnSaveFailure\s*:\s*false/.test(localSource.slice(registrationAt))
        && /onSuccessfulSave\s*:\s*(?:async\s*)?\(\)\s*=>[\s\S]{0,1200}(?:await\s+)?writeLocalAiTerminalReceipt\(/.test(localSource.slice(registrationAt)),
      'a Local AI import registers failure-retention plus a post-save receipt callback');
      assert(receiptCalls.length === 1 && receiptCalls[0] > registrationAt,
        'the terminal receipt is not emitted during measured import before save-application owns the workspace');

      const cleanupAt = applicationSource.indexOf("await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'successful save')");
      const finalizerAt = applicationSource.indexOf('await pending.onSuccessfulSave(');
      const saveReturnAt = applicationSource.indexOf('return {\n      saved: true,');
      assert(finalizerAt >= 0 && cleanupAt > finalizerAt && saveReturnAt > cleanupAt,
        'save-application publishes the registered terminal receipt after atomic promotion but before deleting the private Local AI job folder');
      const saveFailureAt = applicationSource.indexOf("discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'terminal save failure')");
      const failureWindow = applicationSource.slice(Math.max(0, saveFailureAt - 700), saveFailureAt + 250);
      assert(saveFailureAt >= 0 && /pending\.cleanupOnSaveFailure/.test(failureWindow),
        'the failed-save cleanup path honors a workspace-specific retention policy instead of unconditionally removing a Local AI job');

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
          status: 'imported',
          resultSha256: 'a'.repeat(64),
          importedAt: new Date().toISOString(),
          resume: { pageCount: 1, targetPageCount: 1, attempts: [{ density: 'default', pageCount: 1 }] },
          coverLetter: { pageCount: 1, targetPageCount: 1 },
          message: 'Both documents met their measured targets.',
        })}\n`, 'utf8');
        await fs.promises.rm(queued.folder, { recursive: true, force: true });
        const status = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert(status.status === 'saved' && status.receipt?.jobId === queued.id,
          `a valid terminal receipt must distinguish a completed-save cleanup from a failed/missing job, got ${JSON.stringify(status)}`);
        return { status: status.status, receipt: true };
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
      ]) {
        assert(routine.includes(needle), `the routine must state the enforced ${label}`);
      }
      const skill = fs.readFileSync(new URL('../../Job Application Design System/SKILL.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
      const style = fs.readFileSync(new URL('../../Job Application Design System/STYLE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
      assert(skill.includes('authorship clause') && style.includes('authorship clause'),
        'the design references must carry the same closing construction as the routine and the validator');
      return { documented: true };
    },
  },
];
