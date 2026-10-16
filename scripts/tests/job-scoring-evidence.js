import crypto from 'node:crypto';
import { validateAndNormalizeFitAssessment, recalibrateAuditedFitAssessment, calibrateGroundedJobRequirements } from '../../electron/ipc/jobFitAssessment.js';
import { waitForJobRendererCommit } from '../../src/utils/jobRendererCommit.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { normalizeScoringInventory, validateScoringPageEvidence, reduceScoringEvidence, composeScoringSynthesis, scorePinnedJobEvidence, materializeScoringCareerEvidence } from '../../electron/ipc/jobScoringEvidence.js';
import { calibratedScoreForJob, __registerJobsHandlersForTests, registerJobsHandlers, buildJobAnalysisSnapshot, __formatJobAnalysisPromptForTests } from '../../electron/ipc/jobs.js';
import { buildScoredJob } from '../../electron/ipc/jobBatchReconcile.js';
import { taskMaxTokensFor } from '../../electron/ipc/llm.js';
import { hasLegacyPageScoring, JOB_SCORING_CONTRACT } from '../../src/utils/jobScoringContract.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';

function assert(value, message) { if (!value) throw new Error(message); }
function rejects(fn, message) { let rejected = false; try { fn(); } catch { rejected = true; } assert(rejected, message); }
const page = (id, text) => ({ id, text, digest: crypto.createHash('sha256').update(text).digest('hex') });
const job = { title: 'Engineer', snippet: 'Must use AI coding assistants. Must build React interfaces. Kubernetes is preferred.' };
const rawInventory = { requirements: [
  { requirementText: 'Use AI coding assistants', priority: 'required', jobEvidence: 'Must use AI coding assistants.' },
  { requirementText: 'Build React interfaces', priority: 'required', jobEvidence: 'Must build React interfaces.' },
  { requirementText: 'Kubernetes', priority: 'preferred', jobEvidence: 'Kubernetes is preferred.' },
] };
const inventory = () => normalizeScoringInventory(rawInventory, job.snippet);
const assessment = (requirement, status, candidateEvidence = '') => ({ requirementId: requirement.id, status, candidateEvidence, explanation: 'Grounded assessment.' });
const finalResult = (requirements, overrides = {}) => ({
  matchScore: 88, confidence: 'high', reasoning: 'Direct professional support across the whole career record.', careerDirection: 'Engineering',
  assessments: requirements.map((requirement, index) => assessment(requirement, index === 2 ? 'not_documented' : 'direct', index === 0 ? 'Daily AI coding assistants' : index === 1 ? 'Built React interfaces' : '')),
  ...overrides,
});

export default [
  {
    name: 'scoring calibration: adding a critical gap never hides the lower ceiling for important gaps',
    run: () => {
      const texts = ['Data modeling', 'Incident response', 'Distributed operations', 'Professional license'];
      const rows = texts.map((requirementText, index) => ({ requirementText, priority: index === 3 ? 'required' : 'important', status: 'not_documented', jobEvidence: requirementText, candidateEvidence: '' }));
      const options = { jobText: texts.join('. '), candidateText: '' };
      const before = validateAndNormalizeFitAssessment({ matchScore: 96, materialGaps: rows.slice(0, 3), confidence: 'high' }, options);
      const after = validateAndNormalizeFitAssessment({ matchScore: 96, materialGaps: rows, confidence: 'high' }, options);
      assert(before.adjustedScore === 69 && after.adjustedScore === 69, 'adding a critical gap must not raise the important-gap ceiling from 69 to 79');
      for (const raw of [0, 68, 69, 70, 79, 80, 84, 85, 100]) {
        for (let critical = 0; critical < 4; critical++) for (let important = 0; important < 5; important++) {
          const gap = priority => ({ priority, materialGap: true, scoreImpact: 'scored', effectiveStatus: 'not_documented', grounding: { requirementGrounded: true } });
          const evidence = [...Array.from({ length: critical }, () => gap('critical')), ...Array.from({ length: important }, () => gap('important'))];
          const baseline = calibrateGroundedJobRequirements(raw, evidence).adjustedScore;
          for (const priority of ['critical', 'important']) assert(calibrateGroundedJobRequirements(raw, [...evidence, gap(priority)]).adjustedScore <= baseline, 'additional grounded gaps must never improve any boundary score');
        }
      }
      const retained = { ...after, calibrationVersion: 1, adjustedScore: 79, adjustments: [], reasoning: 'Prior calibration' };
      const repaired = recalibrateAuditedFitAssessment(retained);
      assert(repaired.adjustedScore === 69 && repaired.rawScore === 96 && repaired.calibrationVersion === 2 && repaired.reasoning.includes('96 to 69'), 'saved audited scores must receive the same transparent deterministic correction');
      assert(repaired.requirementRows === retained.requirementRows && repaired.confidence === retained.confidence && repaired.experience === retained.experience && retained.adjustedScore === 79, 'recalibration must preserve all AI evidence, confidence and tenure without mutating the retained result');
      assert(recalibrateAuditedFitAssessment({ ...retained, auditStatus: 'legacy-unverified' }) === null, 'unverified legacy numbers are not authority for deterministic repair');
    },
  },
  {
    name: 'renderer scoring commits: await delayed publication and refuse stale or missing writes',
    run: async () => {
      let frames = 0;
      const waitForFrame = async () => { frames++; };
      assert(await waitForJobRendererCommit({ isCurrent: () => true, isCommitted: () => frames === 3, waitForFrame }), 'delayed React commits must be observed');
      frames = 0;
      assert(!await waitForJobRendererCommit({ isCurrent: () => frames < 2, isCommitted: () => frames === 3, waitForFrame }), 'superseded operations must stop before publication');
      frames = 0;
      assert(!await waitForJobRendererCommit({ isCurrent: () => true, isCommitted: () => false, waitForFrame, maxFrames: 2 }) && frames === 2, 'missing commits must fail within the bound');
      const literal = "salary $& and $` and $'";
      assert(materializeScoringCareerEvidence('__HOST_PINNED_SCORING_EVIDENCE__', literal).endsWith(literal), 'career evidence must preserve literal replacement tokens');
    },
  },
  {
    name: 'scoring evidence: repair detection is limited to legacy page audits bound to the current career snapshot',
    run: () => {
      const pin = 'a'.repeat(64);
      const old = { careerSnapshotId: pin, fitAssessment: { confidence: { reported: 'unknown' }, requirementRows: Array(6).fill({}) } };
      const data = { careerSnapshotId: pin, scoredJobs: [old] };
      assert(hasLegacyPageScoring(data), 'the reported merger shape must offer repair');
      for (const changed of [
        { ...old, careerSnapshotId: 'b'.repeat(64) },
        { ...old, scoringEvidenceReceipt: { contract: JOB_SCORING_CONTRACT } },
        { ...old, fitAssessment: { ...old.fitAssessment, confidence: { reported: 'high' } } },
        { ...old, fitAssessment: { ...old.fitAssessment, requirementRows: [{}] } },
      ]) assert(!hasLegacyPageScoring({ ...data, scoredJobs: [changed] }), 'ordinary historical, repaired, or foreign-career scores must not be silently migrated');
      assert(!hasLegacyPageScoring({ ...data, savedJobsRescore: { careerSnapshotId: 'b'.repeat(64) } }), 'an explicit replacement-career re-score takes precedence over scoring-only repair');
    },
  },
  {
    name: 'scoring evidence: FULL Board diagnostics expose version and cap counts without private assessment content',
    run: async () => {
      const { buildJobBoardDiagnostics } = await import('../../electron/ipc/bugReport/jobsSnapshot.js');
      const { redactNodeForIssueReport } = await import('../../src/utils/issueReportRedaction.js');
      const report = buildJobBoardDiagnostics([
        { id: 'board', type: 'jobboard', data: {} },
        { id: 'search', type: 'jobhub', data: { hubState: 'done', scoredJobs: [
          { title: 'PRIVATE_TITLE', reasoning: 'PRIVATE_CAREER_EVIDENCE', matchScore: 69, rawScore: 82, fitAssessment: { confidence: { reported: 'unknown' }, requirementRows: Array(5).fill({ candidateEvidence: 'PRIVATE_QUOTE' }) } },
          { matchScore: 85, rawScore: 85, scoringEvidenceReceipt: { contract: 'whole-record-v3' } },
        ] } },
      ].map(redactNodeForIssueReport), [{ source: 'search', target: 'board' }]);
      assert(report.includes('current-contract=1') && report.includes('score-at-least-70=1') && report.includes('raw-at-least-70-capped-below=1') && report.includes('possible-legacy-page-merge=1'), 'restart-safe diagnostics must distinguish completed scoring from a suspect page merger');
      assert(!/PRIVATE_TITLE|PRIVATE_CAREER_EVIDENCE|PRIVATE_QUOTE/.test(report), 'metadata diagnostics must not disclose job or candidate evidence');
    },
  },
  {
    name: 'scoring evidence: fresh score bounds and conflicting requirement aliases cannot be silently normalized into a result',
    run: () => {
      const raw = { matchScore: 82, rawScore: 99, requirementAssessments: [{ requirementText: 'AI coding assistants', priority: 'required', status: 'direct', jobEvidence: 'Must use AI coding assistants.', candidateEvidence: 'Daily AI coding assistants' }], materialGaps: [], confidence: 'high' };
      const options = { candidateText: 'Daily AI coding assistants' };
      const result = calibratedScoreForJob(raw, job, options);
      assert(result?.matchScore === 82 && result.rawScore === 82, 'unexpected rawScore metadata must not override the schema-authorized matchScore');
      assert(taskMaxTokensFor('job-scoring', { itemCount: 1, scoringRequirementCount: 30 }) > taskMaxTokensFor('job-scoring', { itemCount: 1 }), 'a one-job inventory needs output guidance for its complete requirement count without claiming thirty jobs');
      for (const matchScore of [-1, 101, NaN, '82', 82.5, null]) assert(calibratedScoreForJob({ ...raw, matchScore }, job, options) === null, 'a malformed live score must be retried rather than clamped or coerced');
      assert(calibratedScoreForJob({ ...raw, materialGaps: [{ requirementText: 'Actively use coding assistants', priority: 'required', status: 'not_documented', jobEvidence: 'Must use AI coding assistants.', candidateEvidence: '' }] }, job, options) === null, 'a direct row cannot hide a contradictory alias gap through compatibility deduplication');
      const gap = { requirementText: 'AI coding assistants', priority: 'required', status: 'not_documented', jobEvidence: 'Must use AI coding assistants.', candidateEvidence: '' };
      const duplicateGap = calibratedScoreForJob({ matchScore: 90, requirementAssessments: [], materialGaps: [gap, { ...gap, requirementText: 'Actively use AI assistants' }], confidence: 'high' }, job, options);
      assert(duplicateGap === null, 'fresh aliases sharing one source span must be corrected rather than silently merged');
      const legacyDuplicate = validateAndNormalizeFitAssessment({ matchScore: 90, materialGaps: [gap, { ...gap, requirementText: 'Actively use AI assistants' }] }, { jobText: job.snippet, candidateText: options.candidateText });
      assert(legacyDuplicate.adjustedScore === 79 && legacyDuplicate.materialGaps.length === 1, 'a retained legacy alias still counts once instead of falsely triggering two-gap calibration');
      const compound = { ...job, snippet: 'Must know Git and responsive web design.' };
      const compoundGaps = ['Git proficiency', 'Responsive design'].map(requirementText => ({ requirementText, priority: 'required', status: 'not_documented', jobEvidence: compound.snippet, candidateEvidence: '' }));
      assert(calibratedScoreForJob({ matchScore: 90, materialGaps: compoundGaps, confidence: 'high' }, compound, options) === null, 'distinct skills sharing a compound quote must not be silently collapsed into one gap');
      const distinctSpans = compoundGaps.map((row, index) => ({ ...row, jobEvidence: index === 0 ? 'Git' : 'responsive web design' }));
      assert(calibratedScoreForJob({ matchScore: 90, materialGaps: distinctSpans, confidence: 'high' }, compound, options)?.matchScore === 69, 'separate exact source spans preserve both real professional gaps');
    },
  },
  {
    name: 'scoring evidence: failed and successful rescoring both remove stale score audits and failure markers',
    run: () => {
      const prior = { ...job, matchScore: 90, rawScore: 93, confidence: 'high', fitAssessment: { adjustedScore: 90 }, scoreStatus: 'unscored-evidence-incomplete', scoringCoverageReceipt: { failedLeaves: ['old'] }, compensationContext: { roleFamily: 'old' }, scoringEvidenceReceipt: { version: 2 } };
      const failed = buildScoredJob(prior, null, { fallbackScore: -1, allNull: true });
      assert(failed.matchScore === -1 && !failed.fitAssessment && !failed.rawScore && !failed.confidence && !failed.scoringCoverageReceipt, 'an unscored retry must not carry a prior confident score audit');
      const succeeded = buildScoredJob(prior, { matchScore: 82, confidence: 'medium' }, { fallbackScore: -1, allNull: false });
      assert(succeeded.matchScore === 82 && succeeded.confidence === 'medium' && !succeeded.scoreStatus && !succeeded.compensationContext && !succeeded.scoringEvidenceReceipt, 'a successful retry must not retain old failure/context/coverage metadata');
      assert(prior.matchScore === 90 && prior.fitAssessment.adjustedScore === 90, 'constructing the new result must preserve the input comparison snapshot');
    },
  },
  {
    name: 'scoring evidence: exported scoring prompts contain actual complete approved evidence rather than an internal placeholder',
    run: () => {
      const careerData = 'EARLY_APPROVED_EVIDENCE\nLATE_APPROVED_EVIDENCE';
      const planned = buildJobAnalysisSnapshot({ jobs: [job], profile: { workHistory: [] }, careerData, approvedScoringSnapshot: true });
      const exported = __formatJobAnalysisPromptForTests(planned.snapshot);
      assert(exported.includes(careerData) && !exported.includes('__HOST_PINNED_SCORING_EVIDENCE__'), 'the saved prompt must include the same full evidence available to the live scorer');
      assert(materializeScoringCareerEvidence('A legacy prompt without a marker', careerData) === 'A legacy prompt without a marker', 'legacy prompt verification must remain byte-identical');
    },
  },
  {
    name: 'scoring evidence: page-local absence cannot survive support elsewhere or multiply a paraphrased requirement',
    run: () => {
      const requirements = inventory();
      const pages = [page('first', 'Daily AI coding assistants'), page('second', 'Built React interfaces')];
      const results = [
        requirements.map((requirement, index) => assessment(requirement, index === 0 ? 'direct' : 'not_documented', index === 0 ? pages[0].text : '')),
        requirements.map((requirement, index) => assessment(requirement, index === 1 ? 'direct' : 'not_documented', index === 1 ? pages[1].text : '')),
      ];
      const ledger = reduceScoringEvidence(requirements, pages, results);
      const composed = composeScoringSynthesis(finalResult(requirements), requirements, ledger);
      const calibrated = calibratedScoreForJob(composed, job, { candidateText: pages.map(page => page.text).join('\n') });
      assert(calibrated?.matchScore === 88 && calibrated.fitAssessment.adjustments.length === 0, 'complementary approved pages must not create two false critical gaps or cap the global score');
      assert(composed.requirementAssessments.length === 2 && composed.materialGaps.length === 1 && ledger.every(row => row.searchedPages === 2), 'one fixed requirement receives a whole-record status, including a non-scoring preferred absence');
      rejects(() => validateScoringPageEvidence({ assessments: [...results[0], { ...results[0][0], requirementId: 'Actively use AI coding assistants' }] }, requirements, pages[0]), 'a page cannot append a differently worded duplicate gap');
      rejects(() => composeScoringSynthesis(finalResult(requirements, { assessments: requirements.map(requirement => assessment(requirement, 'not_documented')) }), requirements, ledger), 'global absence must fail when another page documented support');
    },
  },
  {
    name: 'scoring evidence: every immutable id and literal source citation is required at each stage',
    run: () => {
      const requirements = inventory();
      const approved = page('approved', 'Daily AI coding assistants');
      const rows = requirements.map(requirement => assessment(requirement, 'not_documented'));
      for (const invalid of [rows.slice(1), [...rows, rows[0]], [rows[0], rows[0], rows[2]], [{ ...rows[0], requirementId: 'other' }, ...rows.slice(1)], [{ ...rows[0], status: 'direct', candidateEvidence: 'Invented coding experience' }, ...rows.slice(1)]]) {
        rejects(() => validateScoringPageEvidence({ assessments: invalid }, requirements, approved), 'missing, duplicate, foreign or ungrounded page rows must be rejected');
      }
      rejects(() => normalizeScoringInventory({ requirements: [rawInventory.requirements[0], { ...rawInventory.requirements[0], requirementText: 'Actively use coding assistants' }] }, job.snippet), 'aliases sharing one listing clause must not multiply requirement count');
      rejects(() => normalizeScoringInventory({ requirements: [{ ...rawInventory.requirements[0], jobEvidence: 'Invented requirement' }] }, job.snippet), 'inventory must be grounded in this exact listing');
      rejects(() => normalizeScoringInventory({ requirements: [{ requirementText: 'Work authorization', priority: 'required', jobEvidence: 'Must be authorized to work in the USA.' }] }, 'Must be authorized to work in the USA.'), 'logistics cannot enter professional scoring');
      rejects(() => reduceScoringEvidence(requirements, [approved, page('missing', 'Other approved evidence')], [rows]), 'a successful first page cannot authorize missing later evidence');
      rejects(() => reduceScoringEvidence(requirements, [{ ...approved, digest: '0'.repeat(64) }], [rows]), 'changed page bytes must invalidate reduction');
    },
  },
  {
    name: 'scoring evidence: genuine whole-record gaps retain calibration and contradictory evidence is never discarded',
    run: () => {
      const requirements = inventory();
      const pages = [page('positive', 'Daily AI coding assistants'), page('conflict', 'Never used AI coding assistants')];
      const results = pages.map((page, index) => requirements.map((requirement, rowIndex) => assessment(requirement, rowIndex === 0 ? index === 0 ? 'direct' : 'contradicted' : 'not_documented', rowIndex === 0 ? page.text : '')));
      const ledger = reduceScoringEvidence(requirements, pages, results);
      assert(ledger[0].observations.length === 2 && ledger[0].observations.some(row => row.status === 'contradicted'), 'a positive observation cannot erase a real conflicting quote');
      const composed = composeScoringSynthesis(finalResult(requirements, { assessments: requirements.map((requirement, index) => assessment(requirement, index === 0 ? 'unclear' : 'not_documented', index === 0 ? pages[1].text : '')) }), requirements, ledger);
      const calibrated = calibratedScoreForJob(composed, job, { candidateText: pages.map(page => page.text).join('\n') });
      assert(calibrated?.matchScore === 69 && calibrated.fitAssessment.adjustments[0]?.code === 'multiple-critical-gaps', 'two genuine unresolved global requirements still cap an inflated score');
    },
  },
  {
    name: 'scoring evidence: one global synthesis replaces page scores and retains confidence, context and experience',
    run: async () => {
      const pages = [page('early', 'Daily AI coding assistants'), page('late', 'Built React interfaces')];
      const stages = [];
      let checks = 0;
      const experience = { totalProfessionalExperience: { years: 'not established', candidateEvidence: '', explanation: 'No dated tenure supplied.' }, categorySpecificExperience: [] };
      const compensationContext = { roleFamily: 'Frontend engineering', seniority: 'mid' };
      let requirements;
      const result = await scorePinnedJobEvidence({
        job, jobText: job.snippet, pages, assertCurrent: async () => { checks++; },
        request: async request => {
          stages.push(request.stage);
          let response;
          if (request.stage === 'requirements') {
            requirements = inventory(); response = rawInventory;
          } else if (request.stage === 'evidence') {
            response = { assessments: requirements.map((requirement, index) => assessment(requirement, index === (request.page.id === 'early' ? 0 : 1) ? 'direct' : 'not_documented', index === (request.page.id === 'early' ? 0 : 1) ? request.page.text : '')) };
            assert(!request.schema.properties.matchScore, 'page retrieval must not author a local fit score');
          } else {
            assert(request.prompt.includes(pages[0].text) && request.prompt.includes(pages[1].text), 'final assessment must receive complementary evidence from every approved page');
            response = finalResult(requirements, { experienceAssessment: experience, compensationContext });
          }
          request.validate(response); return response;
        },
      });
      assert(stages.join(',') === 'requirements,evidence,evidence,synthesis' && checks >= 5, 'inventory precedes every page and exactly one whole-record scoring call follows complete evidence coverage');
      assert(result.matchScore === 88 && result.confidence === 'high' && result.experienceAssessment === experience && result.compensationContext === compensationContext && result.scoringEvidenceReceipt.pageCount === 2, 'the reducer must preserve final confidence, experience, compensation and verifiable coverage');
    },
  },
  {
    name: 'scoring evidence: cancellation after a page prevents later pages and final scoring',
    run: async () => {
      let cancelled = false;
      const stages = [];
      let failure;
      try {
        await scorePinnedJobEvidence({ job, jobText: job.snippet, pages: [page('early', 'Some evidence'), page('late', 'Other evidence')],
          assertCurrent: async () => { if (cancelled) throw new Error('operation-superseded'); },
          request: async request => {
            stages.push(request.stage);
            if (request.stage === 'requirements') return rawInventory;
            cancelled = true;
            return { assessments: inventory().map(requirement => assessment(requirement, 'not_documented')) };
          },
        });
      } catch (error) { failure = error; }
      assert(failure?.message === 'operation-superseded' && stages.join(',') === 'requirements,evidence', 'supersession must stop dispatch without a partial-page score');
    },
  },
  ...[false, true].map(large => ({
    name: `scoring evidence: real score-jobs handler uses ${large ? 'immutable requirements and one global synthesis for a large record' : 'one complete career record when it fits'}`,
    run: async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-score-evidence-live-'));
      const canvas = path.join(directory, 'canvas.json');
      const pin = 'a'.repeat(64);
      const careerData = `Daily AI coding assistants\n${large ? 'x'.repeat(170_000) : 'Approved ordinary career record'}\nBuilt React interfaces`;
      const calls = [];
      const requirements = inventory();
      const sender = { id: 7_794, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => {} };
      try {
        await fs.writeFile(canvas, '{}');
        const claim = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: 'hub', operationId: 'score', semanticBase: { kind: 'search', careerSnapshotId: pin, runId: 'run-1' } });
        __registerJobsHandlersForTests({
          resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData, pinned: true }),
          runScoreBatch: async (prompt, options) => {
            const properties = options.responseSchema.properties;
            const stage = properties.requirements ? 'requirements' : properties.scores ? 'complete-record' : properties.matchScore ? 'synthesis' : 'evidence';
            const call = { stage, prompt }; calls.push(call);
            let response;
            if (stage === 'complete-record') {
              assert(prompt.includes('Daily AI coding assistants') && prompt.includes('Built React interfaces'), 'the live full-record request must include early and late approved evidence together');
              response = { scores: [{ index: 0, ...composeScoringSynthesis(finalResult(requirements), requirements, reduceScoringEvidence(requirements,
                [page('whole', careerData)], [requirements.map((requirement, index) => assessment(requirement, index === 2 ? 'not_documented' : 'direct', index === 0 ? 'Daily AI coding assistants' : index === 1 ? 'Built React interfaces' : ''))])) }] };
            } else if (stage === 'requirements') response = rawInventory;
            else if (stage === 'synthesis') response = finalResult(requirements);
            else response = { assessments: requirements.map((requirement, index) => {
              const quote = index === 0 ? 'Daily AI coding assistants' : index === 1 ? 'Built React interfaces' : '';
              return assessment(requirement, quote && prompt.includes(quote) ? 'direct' : 'not_documented', quote && prompt.includes(quote) ? quote : '');
            }) };
            options.responseValidator(response);
            call.progress = options.measureProgressUnits(response);
            if (large) assert(options.hints.itemCount === 1, 'requirement count must not inflate the displayed job count');
            return response;
          },
        });
        const result = await ipcMain.__getInvokeHandler('score-jobs')({ sender }, {
          jobs: [job], careerSnapshotId: pin, nodeId: 'hub', operationAuthority: claim.receipt,
          snapshotContext: { canvasFilePath: canvas, runId: 'run-1' },
        });
        assert(result.success && result.scoredJobs?.length === 1 && result.scoredJobs[0].matchScore === 88 && result.scoredJobs[0].confidence.reported === 'high', `the production handler must publish an audited whole-record score: ${JSON.stringify({ success: result.success, error: result.error, score: result.scoredJobs?.[0]?.matchScore })}`);
        if (large) assert(calls[0].stage === 'requirements' && calls.at(-1).stage === 'synthesis' && calls.filter(call => call.stage === 'synthesis').length === 1 && calls.filter(call => call.stage === 'evidence').length > 1 && !calls.some(call => call.stage === 'complete-record'), 'oversized whole records must use fixed requirements, all pages, and one synthesis');
        else assert(calls.length === 1 && calls[0].stage === 'complete-record', 'ordinary records must not be fragmented into independent page scores');
        assert(calls.reduce((total, call) => total + call.progress, 0) === 1, 'accepted progress counts one globally validated score, never the inventory or page searches');
      } finally {
        registerJobsHandlers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  })),
];
