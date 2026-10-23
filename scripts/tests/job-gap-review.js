import { assert } from './testHelpers.js';
import {
  GAP_REVIEW_POLICY,
  JOB_GAP_REVIEW_VERSION,
  applyGapReview,
  buildGapReviewPrompt,
  gapReviewRowsForJob,
  selectGapReviewCandidates,
  summarizeGapReviews,
  validateGapReviewSubmission,
} from '../../electron/ipc/jobGapReview.js';
import { validateAndNormalizeFitAssessment } from '../../electron/ipc/jobFitAssessment.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { __registerJobsHandlersForTests, getJobsTelemetry, registerJobsHandlers } from '../../electron/ipc/jobs.js';
import { claimJobAnalysisOperationAuthority } from '../../electron/ipc/jobAnalysisOperationAuthorityStore.js';

// Drives the real score-jobs handler with an injected scorer and reviewer so
// the pipeline stage in jobs.js (candidate selection, one review handoff,
// apply, telemetry) is covered end to end. `reviewer` is the injected
// runGapReview; `scorerGaps` are the material gaps the injected scorer returns.
async function runHandlerWithGapReview({ reviewer, scorerGaps, rawScore = 86 }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-gap-review-live-'));
  const canvas = path.join(directory, 'canvas.json');
  const pin = 'b'.repeat(64);
  const postingClause = 'Alpha duty one is required, though equivalent experience is welcome. Beta duty two is required.';
  const job = {
    title: 'Synthetic role', company: 'Synthetic employer', url: 'https://example.test/gap-review',
    description: `${postingClause} ${'Further synthetic posting detail. '.repeat(20)}`,
  };
  const careerData = 'Candidate used alpha tool and beta tool in projects. Candidate worked on gamma duty daily.';
  const sender = { id: 7_801, isDestroyed: () => false, once: () => {}, on: () => {}, removeListener: () => {}, send: () => {} };
  const scorerCalls = [];
  const reviewerCalls = [];
  try {
    await fs.writeFile(canvas, '{}');
    const claim = await claimJobAnalysisOperationAuthority({ canvasFilePath: canvas, hubId: 'hub', operationId: 'score', semanticBase: { kind: 'search', careerSnapshotId: pin, runId: 'run-1' } });
    __registerJobsHandlersForTests({
      resolvePinnedScoringInput: async () => ({ profile: { workHistory: [] }, careerData, pinned: true }),
      runScoreBatch: async (prompt, options) => {
        scorerCalls.push(prompt);
        const response = { scores: [{
          index: 0, matchScore: rawScore, confidence: 'high', careerDirection: 'Engineering',
          reasoning: 'Synthetic scorer reasoning.', requirementAssessments: [], materialGaps: scorerGaps,
        }] };
        options.responseValidator(response);
        return response;
      },
      runGapReview: async (prompt, options) => {
        reviewerCalls.push({ prompt, options });
        const response = await reviewer(prompt, options);
        options.responseValidator(response);
        return response;
      },
    });
    const result = await ipcMain.__getInvokeHandler('score-jobs')({ sender }, {
      jobs: [job], careerSnapshotId: pin, nodeId: 'hub', operationAuthority: claim.receipt,
      snapshotContext: { canvasFilePath: canvas, runId: 'run-1' },
    });
    const telemetry = getJobsTelemetry();
    return { result, scorerCalls, reviewerCalls, telemetry: telemetry.scoring, heartbeat: telemetry.scoringHeartbeat, postingClause };
  } finally {
    registerJobsHandlers();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const scorerGap = (requirementText, jobEvidence) => ({
  requirementText, priority: 'required', jobEvidence, status: 'not_documented', candidateEvidence: '',
  impact: 'not documented in the supplied career data',
});
const twoRequiredGaps = [
  scorerGap('Alpha capability', 'Alpha duty one is required'),
  scorerGap('Beta capability', 'Beta duty two is required'),
];
const listedIdsIn = prompt => [...prompt.matchAll(/^ {2}- id: (\S+)$/gmu)].map(match => match[1]);

// Synthetic fixtures only: invented labels and short invented sentences.
const BAR = 70;
const JOB_TEXT = 'Alpha duty one is required, though equivalent experience is welcome. Beta duty two is required. Gamma duty is key.';
const CANDIDATE_TEXT = 'Candidate worked on gamma duty daily. Candidate used alpha tool and beta tool in projects.';
const PREFIX = 'Invalid job-gap-review response:';

const rawAssessment = () => ({
  rawScore: 86,
  confidence: 'high',
  requirements: [
    { id: 'r1', requirementText: 'Alpha capability', priority: 'required', evidenceStatus: 'not_documented', jobEvidence: 'Alpha duty one is required', candidateEvidence: '' },
    { id: 'r2', requirementText: 'Beta capability', priority: 'required', evidenceStatus: 'not_documented', jobEvidence: 'Beta duty two is required', candidateEvidence: '' },
    { id: 'r3', requirementText: 'Gamma capability', priority: 'important', evidenceStatus: 'direct', jobEvidence: 'Gamma duty is key', candidateEvidence: 'worked on gamma duty daily' },
  ],
});

// Maps a fit assessment onto a scored job the way calibratedScoreForJob does.
function scoredJob(raw = rawAssessment()) {
  const fit = validateAndNormalizeFitAssessment(raw, { jobText: JOB_TEXT, candidateText: CANDIDATE_TEXT });
  return {
    source: 'synthetic',
    title: 'Synthetic role',
    matchScore: fit.adjustedScore,
    rawScore: fit.rawScore,
    adjustedScore: fit.adjustedScore,
    reasoning: fit.reasoning,
    requirementAssessments: fit.requirementRows,
    materialGaps: fit.requirementRows.filter(row => row.materialGap),
    strengths: fit.strengths,
    experienceAssessment: fit.experience,
    confidence: fit.confidence,
    fitAssessment: { ...fit, rawModelReasoning: '' },
  };
}

const verdict = (id, fields = {}) => ({
  id,
  verdict: 'confirmed',
  priority: 'unchanged',
  status: 'unchanged',
  jobEvidence: '',
  candidateEvidence: '',
  duplicateOf: '',
  explanation: 'synthetic',
  ...fields,
});
const response = (rows, index = 0) => ({ reviews: [{ index, rows }] });
const batchFor = (job, index = 0) => ({ index, jobText: JOB_TEXT, rows: gapReviewRowsForJob(job) });

function rejects(fn, expectedMessage) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `expected an error: ${expectedMessage}`);
  assert(caught.message === expectedMessage, `expected "${expectedMessage}" but got "${caught.message}"`);
  if (expectedMessage.startsWith('Invalid job-gap-review response: ')) {
    assert(caught.code === 'VALIDATION_FAILED' && caught.correctionDetails.length >= 1
      && /^GAP_REVIEW_[A-Z_]+$/.test(caught.correctionRuleIds[0]), 'every rejection retains the exact local message and adds one typed correction');
  }
}

const validate = (value, job = scoredJob(), batch = [batchFor(job)]) => validateGapReviewSubmission(value, batch, { candidateText: CANDIDATE_TEXT });
const apply = (job, rows, threshold = BAR) => {
  const review = validate(response(rows), job).reviews[0];
  return applyGapReview(job, review, { candidateText: CANDIDATE_TEXT, jobText: JOB_TEXT, threshold, reviewedAt: 1234 });
};
const confirmAll = [verdict('r1'), verdict('r2')];
const idsOf = rows => rows.map(row => row.id);

export default [
  {
    name: 'W4 repro R3: an ungrounded advisory quote reaches per-row arbitration without raising the score',
    run: () => {
      const job = scoredJob();
      const review = validate(response([verdict('r1', { verdict: 'priority', priority: 'important', jobEvidence: 'a clause the posting never states' }), verdict('r2')]), job);
      const result = applyGapReview(job, review.reviews[0], { candidateText: CANDIDATE_TEXT, jobText: JOB_TEXT, threshold: BAR, reviewedAt: 1234 });
      assert(result.fitAssessment.gapReview.changes.some(change => change.kind === 'rejected') && result.adjustedScore === 69, 'an unsupported quote is ignored by the host without changing fit');
    },
  },
  {
    name: 'W3 gap review: every rejection family carries its own rule id',
    run: () => {
      const cases = [
        [{ reviews: null }, 'GAP_REVIEW_NOT_ARRAY'],
        [response(confirmAll, 9), 'GAP_REVIEW_INDEX_INVALID'],
        [{ reviews: [{ index: 0, rows: confirmAll }, { index: 0, rows: confirmAll }] }, 'GAP_REVIEW_INDEX_DUPLICATE'],
        [{ reviews: [] }, 'GAP_REVIEW_JOB_MISSING'],
        [response(null), 'GAP_REVIEW_ROWS_NOT_ARRAY'],
        [response([verdict('missing')]), 'GAP_REVIEW_ROW_ID_UNKNOWN'],
        [response([verdict('r1'), verdict('r1')]), 'GAP_REVIEW_ROW_ID_DUPLICATE'],
        [response([verdict('r1')]), 'GAP_REVIEW_ROW_MISSING'],
      ];
      for (const [value, expected] of cases) {
        let caught;
        try { validate(value); } catch (error) { caught = error; }
        assert(caught?.correctionRuleIds?.[0] === expected, `${expected}: ${caught?.message}`);
      }
    },
  },
  {
    name: 'Gap review: fixture job is an 86 pulled to 69 by two critical gaps',
    run: () => {
      const job = scoredJob();
      assert(job.rawScore === 86 && job.adjustedScore === 69 && job.matchScore === 69, `fixture score was ${job.rawScore}/${job.adjustedScore}`);
      assert(idsOf(job.materialGaps).join() === 'r1,r2', 'fixture has exactly the two critical gap rows');
      assert(GAP_REVIEW_POLICY.PRIORITY_RANK.critical > GAP_REVIEW_POLICY.PRIORITY_RANK.preferred, 'policy ranks are exposed');
    },
  },
  {
    name: 'Gap review: selectGapReviewCandidates picks only audited capped jobs with gap rows and no prior review',
    run: () => {
      const capped = scoredJob();
      const noGapRows = scoredJob();
      noGapRows.fitAssessment = {
        ...noGapRows.fitAssessment,
        requirementRows: noGapRows.fitAssessment.requirementRows.map(row => ({ ...row, materialGap: false })),
      };
      const uncapped = { ...scoredJob(), adjustedScore: 86, matchScore: 86 };
      const honestLow = { ...scoredJob(), rawScore: 60 };
      const unscored = { ...scoredJob(), scoreStatus: 'unscored' };
      const unscoredVariant = { ...scoredJob(), scoreStatus: 'unscored-evidence-incomplete' };
      const legacy = scoredJob();
      delete legacy.rawScore;
      const reviewed = apply(scoredJob(), confirmAll);
      const picked = selectGapReviewCandidates([capped, noGapRows, uncapped, honestLow, unscored, unscoredVariant, legacy, reviewed, null], { threshold: BAR });
      assert(JSON.stringify(picked) === '[0]', `picked ${JSON.stringify(picked)}`);
      rejects(() => selectGapReviewCandidates([capped], {}), 'selectGapReviewCandidates requires a numeric threshold.');
    },
  },
  {
    name: 'Gap review: gapReviewRowsForJob returns only material-gap rows in the review priority vocabulary',
    run: () => {
      const rows = gapReviewRowsForJob(scoredJob());
      assert(idsOf(rows).join() === 'r1,r2', `rows were ${idsOf(rows)}`);
      assert(rows.every(row => row.priority === 'required' && row.status === 'not_documented'), 'critical rows map to required');
      assert(rows[0].requirement === 'Alpha capability' && rows[0].jobEvidence[0] === 'Alpha duty one is required', 'row carries label and grounded quote');
      assert(rows[0].candidateEvidence.length === 0, 'a gap row has no candidate quote');
      assert(gapReviewRowsForJob({ fitAssessment: { auditStatus: 'legacy-unverified', requirementRows: [] } }).length === 0, 'unaudited jobs list nothing');
    },
  },
  {
    name: 'Gap review: buildGapReviewPrompt lists every row id, job index and the candidate block, and rejects an empty batch',
    run: () => {
      const job = scoredJob();
      const prompt = buildGapReviewPrompt({
        jobs: [batchFor(job, 0), batchFor(job, 1)],
        candidateText: CANDIDATE_TEXT,
      });
      assert(prompt.includes('JOB index 0') && prompt.includes('JOB index 1'), 'both job indexes appear');
      assert(prompt.split('  - id: r1').length === 3 && prompt.split('  - id: r2').length === 3, 'each row id is listed once per job');
      assert(!prompt.includes('  - id: r3'), 'a non-gap row is never listed');
      assert(prompt.includes('<<<UNTRUSTED_CANDIDATE_CAREER_EVIDENCE>>>\n' + CANDIDATE_TEXT + '\n<<<END UNTRUSTED_CANDIDATE_CAREER_EVIDENCE>>>'), 'candidate block wraps the career evidence');
      rejects(() => buildGapReviewPrompt({ jobs: [], candidateText: CANDIDATE_TEXT }), 'A gap review handoff needs at least one job.');
    },
  },
  {
    name: 'Gap review: validateGapReviewSubmission accepts a correct response (object or bare array) and normalizes it',
    run: () => {
      const rows = [
        verdict(' r2 ', { verdict: 'duplicate', duplicateOf: ' r1 ', jobEvidence: 'ignored filler', priority: 'preferred' }),
        verdict('r1', { verdict: 'priority', priority: ' preferred ', jobEvidence: ' equivalent experience is welcome ', candidateEvidence: 'filler' }),
      ];
      const result = validate(response(rows));
      assert(result.reviews.length === 1 && result.reviews[0].index === 0, 'one review for the job');
      const [first, second] = result.reviews[0].rows;
      assert(first.id === 'r1' && first.verdict === 'priority' && first.priority === 'preferred' && first.jobEvidence === 'equivalent experience is welcome',
        `priority row was ${JSON.stringify(first)}`);
      assert(first.status === 'unchanged' && first.candidateEvidence === '' && first.duplicateOf === '', 'unused fields are normalized to absent');
      assert(second.id === 'r2' && second.verdict === 'duplicate' && second.duplicateOf === 'r1', 'duplicate row trimmed');
      assert(second.priority === 'unchanged' && second.jobEvidence === '', 'a filled-in unused field is ignored, not rejected');
      const bare = validate([{ index: 0, rows: confirmAll }]);
      assert(bare.reviews[0].rows.length === 2 && bare.reviews[0].rows.every(row => row.verdict === 'confirmed'), 'bare array accepted');
      const evidence = validate(response([verdict('r1', { verdict: 'evidence', status: 'direct', candidateEvidence: 'USED alpha   tool' }), verdict('r2')]));
      assert(evidence.reviews[0].rows[0].status === 'direct', 'case and whitespace folded quote is grounded');
    },
  },
  {
    name: 'Gap review: validateGapReviewSubmission rejects structural defects, naming the job and the observation',
    run: () => {
      const job = scoredJob();
      rejects(() => validate({ reviews: 'nope' }), `${PREFIX} reviews is not an array.`);
      rejects(() => validate(null), `${PREFIX} reviews is not an array.`);
      rejects(() => validate({ reviews: [{ index: 1, rows: confirmAll }] }), `${PREFIX} review index 1 is not an integer in [0, 1).`);
      rejects(() => validate({ reviews: [{ index: 0.5, rows: confirmAll }] }), `${PREFIX} review index 0.5 is not an integer in [0, 1).`);
      rejects(() => validate({ reviews: [{ index: -1, rows: confirmAll }] }), `${PREFIX} review index -1 is not an integer in [0, 1).`);
      rejects(() => validate({ reviews: [{ index: 0, rows: confirmAll }, { index: 0, rows: confirmAll }] }),
        `${PREFIX} job 0: a second review for this job index was returned`);
      const twoJobs = [batchFor(job, 0), batchFor(job, 1)];
      rejects(() => validate(response(confirmAll, 0), job, twoJobs), `${PREFIX} job 1: no review was returned for this job`);
      rejects(() => validate(response([verdict('r1'), verdict('r2'), verdict('r3')])),
        `${PREFIX} job 0, row r3: this id is not among the listed gap row ids for this job`);
      rejects(() => validate(response([verdict('r1'), verdict('r1'), verdict('r2')])),
        `${PREFIX} job 0, row r1: this id appears more than once in the review`);
      rejects(() => validate(response([verdict('r1')])),
        `${PREFIX} job 0, row r2: this listed row id is missing from the review`);
    },
  },
  {
    name: 'Gap review: advisory content defects are rejected per row without changing the score',
    run: () => {
      const cases = [{ verdict: 'maybe' }, { verdict: '' }, { verdict: 'priority', priority: 'unchanged', jobEvidence: 'equivalent experience is welcome' }, { verdict: 'priority', priority: 'critical', jobEvidence: 'equivalent experience is welcome' }, { verdict: 'priority', priority: 'required', jobEvidence: 'equivalent experience is welcome' }, { verdict: 'priority', priority: 'important', jobEvidence: '' }, { verdict: 'priority', priority: 'important', jobEvidence: 'invented quote' }, { verdict: 'evidence', status: 'unchanged', candidateEvidence: 'used alpha tool' }, { verdict: 'evidence', status: 'contradicted', candidateEvidence: 'used alpha tool' }, { verdict: 'evidence', status: 'direct', candidateEvidence: '' }, { verdict: 'evidence', status: 'direct', candidateEvidence: 'invented quote' }, ...['', 'r1', 'r3', 'r9'].map(duplicateOf => ({ verdict: 'duplicate', duplicateOf }))];
      for (const fields of cases) {
        const job = scoredJob();
        const result = apply(job, [verdict('r1', fields), verdict('r2')]);
        assert(result.adjustedScore === job.adjustedScore && result.fitAssessment.gapReview.changes.some(change => change.id === 'r1' && change.kind === 'rejected'), `host refused ${JSON.stringify(fields)}`);
        assert(JSON.stringify(result.requirementAssessments.find(row => row.id === 'r1')) === JSON.stringify(job.requirementAssessments.find(row => row.id === 'r1')), 'rejected row unchanged');
      }
    },
  },
  {
    name: 'Gap review: a grounded priority downgrade of one of two critical gaps turns a 69 into a 79',
    run: () => {
      const job = scoredJob();
      const result = apply(job, [
        verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'equivalent experience is welcome' }),
        verdict('r2'),
      ]);
      assert(job.adjustedScore === 69 && result.adjustedScore === 79 && result.matchScore === 79, `score was ${result.matchScore}`);
      assert(result.matchScore === result.fitAssessment.adjustedScore && result.matchScore <= result.rawScore && result.rawScore === 86, 'matchScore mirrors the audit and never exceeds raw');
      const row = result.requirementAssessments.find(item => item.id === 'r1');
      assert(row.priority === 'preferred' && row.materialGap === false, 'row lowered and no longer a gap');
      assert(JSON.stringify(row.reviewedPriority) === JSON.stringify({ from: 'critical', to: 'preferred', jobEvidence: 'equivalent experience is welcome' }), 'reviewedPriority recorded');
      assert(idsOf(result.materialGaps).join() === 'r2', 'displayed gaps mirror the audit');
      assert(result.requirementAssessments === result.fitAssessment.requirementRows, 'displayed rows are the audit rows');
      assert(result.strengths === result.fitAssessment.strengths && result.confidence === result.fitAssessment.confidence && result.reasoning === result.fitAssessment.reasoning, 'displayed fields mirror the audit');
      const review = result.fitAssessment.gapReview;
      assert(review.version === JOB_GAP_REVIEW_VERSION && review.reviewedAt === 1234 && review.threshold === BAR, 'review metadata recorded');
      assert(review.before.adjustedScore === 69 && review.after.adjustedScore === 79 && review.outcome === 'raised-above-threshold', `outcome ${review.outcome}`);
      assert(JSON.stringify(review.changes) === JSON.stringify([{ id: 'r1', kind: 'priority', from: 'critical', to: 'preferred' }, { id: 'r2', kind: 'confirmed' }]),
        `changes ${JSON.stringify(review.changes)}`);
      assert(result.fitAssessment.adjustments.length === 1 && result.fitAssessment.adjustments[0].code === 'critical-gap', 'the remaining critical gap still caps at 79');
      // Threshold above the new score: raised, but not above the bar.
      const belowBar = apply(job, [
        verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'equivalent experience is welcome' }),
        verdict('r2'),
      ], 80);
      assert(belowBar.fitAssessment.gapReview.outcome === 'raised', `outcome ${belowBar.fitAssessment.gapReview.outcome}`);
    },
  },
  {
    name: 'Gap review: grounded evidence verdicts remove gaps, grow support and recompute confidence',
    run: () => {
      const job = scoredJob();
      assert(job.confidence.effective === 'low' && job.strengths.length === 1, 'fixture starts with low confidence and one strength');
      const adjacent = apply(job, [verdict('r1', { verdict: 'evidence', status: 'adjacent', candidateEvidence: 'used alpha tool' }), verdict('r2')]);
      assert(adjacent.materialGaps.length === 1 && adjacent.fitAssessment.adjacentMatches.length === 1, 'one gap became adjacent support');
      assert(adjacent.fitAssessment.adjacentMatches[0].id === 'r1' && adjacent.strengths.length === 1, 'adjacent is not counted as a strength');
      const row = adjacent.requirementAssessments.find(item => item.id === 'r1');
      assert(row.effectiveStatus === 'adjacent' && row.candidateEvidence[0] === 'used alpha tool' && row.grounding.candidateClaimGrounded === true
        && row.reviewedStatus.from === 'not_documented' && row.reviewedStatus.to === 'adjacent', 'row rewritten');
      assert(adjacent.adjustedScore === 79, `adjacent score ${adjacent.adjustedScore}`);

      const both = apply(job, [
        verdict('r1', { verdict: 'evidence', status: 'direct', candidateEvidence: 'used alpha tool' }),
        verdict('r2', { verdict: 'evidence', status: 'direct', candidateEvidence: 'beta tool in projects' }),
      ]);
      assert(both.materialGaps.length === 0 && both.strengths.length === 3, 'no gaps remain and strengths grew');
      assert(both.confidence.effective === 'high', `confidence ${both.confidence.effective}`);
      assert(both.fitAssessment.statusCounts.direct === 3 && both.fitAssessment.statusCounts.not_documented === 0, 'status counts rebuilt');
      assert(both.adjustedScore === 86 && both.matchScore === 86 && both.matchScore <= both.rawScore, 'score restored to, never above, raw');
      assert(both.fitAssessment.gapReview.outcome === 'raised-above-threshold', both.fitAssessment.gapReview.outcome);
      assert(JSON.stringify(both.fitAssessment.gapReview.changes.map(change => [change.id, change.kind, change.from, change.to]))
        === JSON.stringify([['r1', 'evidence', 'not_documented', 'direct'], ['r2', 'evidence', 'not_documented', 'direct']]), 'evidence changes recorded');
    },
  },
  {
    name: 'Gap review: a duplicate verdict makes two rows count once',
    run: () => {
      const job = scoredJob();
      const result = apply(job, [verdict('r1'), verdict('r2', { verdict: 'duplicate', duplicateOf: 'r1' })]);
      const clusters = result.fitAssessment.mergedGapClusters;
      assert(clusters.length === 1 && [...clusters[0].ids].sort().join() === 'r1,r2', `clusters ${JSON.stringify(clusters)}`);
      assert(result.adjustedScore === 79 && result.fitAssessment.adjustments[0].code === 'critical-gap', `score ${result.adjustedScore}`);
      assert(result.materialGaps.length === 2, 'both rows remain in the audit');
      assert(result.requirementAssessments.find(item => item.id === 'r2').duplicateOf === 'r1', 'duplicateOf recorded on the row');
      assert(result.fitAssessment.gapReview.changes[1].kind === 'duplicate' && result.fitAssessment.gapReview.changes[1].duplicateOf === 'r1', 'change recorded');
      assert(job.fitAssessment.mergedGapClusters.length === 0, 'the original had no merged clusters');
    },
  },
  {
    name: 'Gap review: an ungrounded or disallowed verdict is recorded as rejected and leaves the score unchanged',
    run: () => {
      const job = scoredJob();
      const before = JSON.stringify(job);
      const review = {
        index: 0,
        rows: [
          verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'text the posting never contains' }),
          verdict('r2', { verdict: 'evidence', status: 'direct', candidateEvidence: 'text the career evidence never contains' }),
        ],
      };
      const result = applyGapReview(job, review, { candidateText: CANDIDATE_TEXT, jobText: JOB_TEXT, threshold: BAR, reviewedAt: 5 });
      assert(result.adjustedScore === 69 && result.matchScore === 69, `score ${result.matchScore}`);
      assert(result.fitAssessment.gapReview.changes.every(change => change.kind === 'rejected' && typeof change.reason === 'string' && change.reason.length > 0), 'both recorded as rejected with a reason');
      assert(result.fitAssessment.gapReview.outcome === 'unchanged', 'unchanged outcome');
      assert(result.requirementAssessments.filter(row => row.id !== 'r3').every(row => row.priority === 'critical' && row.effectiveStatus === 'not_documented' && row.materialGap && !row.reviewedPriority && !row.reviewedStatus), 'rows untouched');
      const other = applyGapReview(job, {
        index: 0,
        rows: [
          verdict('r1', { verdict: 'priority', priority: 'required', jobEvidence: 'equivalent experience is welcome' }),
          verdict('r2', { verdict: 'duplicate', duplicateOf: 'r2' }),
          verdict('zz', { verdict: 'duplicate', duplicateOf: 'r1' }),
        ],
      }, { candidateText: CANDIDATE_TEXT, jobText: JOB_TEXT, threshold: BAR, reviewedAt: 5 });
      assert(other.fitAssessment.gapReview.changes.map(change => change.kind).join() === 'rejected,rejected,rejected', 'not-lower priority, self duplicate and unknown row are all rejected');
      assert(other.adjustedScore === 69, 'score unchanged');
      assert(JSON.stringify(job) === before, 'input not mutated');
    },
  },
  {
    name: 'Gap review: applyGapReview never mutates its input and returns fresh nested objects',
    run: () => {
      const job = scoredJob();
      const before = JSON.stringify(job);
      const result = apply(job, [
        verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'equivalent experience is welcome' }),
        verdict('r2', { verdict: 'evidence', status: 'adjacent', candidateEvidence: 'beta tool in projects' }),
      ]);
      assert(JSON.stringify(job) === before, 'input JSON unchanged');
      assert(result !== job && result.fitAssessment !== job.fitAssessment, 'a new job and audit');
      assert(!('gapReview' in job.fitAssessment), 'input audit gained no gapReview');
      assert(job.requirementAssessments[0].priority === 'critical' && job.fitAssessment.requirementRows[1].effectiveStatus === 'not_documented', 'input rows untouched');
      assert(result.requirementAssessments[0] !== job.requirementAssessments[0] && result.requirementAssessments[1] !== job.requirementAssessments[1], 'changed rows are copies');
      assert(result.rawScore === job.rawScore && result.matchScore <= result.rawScore, 'raw score untouched and not exceeded');
    },
  },
  {
    name: 'Gap review: outcome reports unchanged and, honestly, lowered',
    run: () => {
      const unchanged = apply(scoredJob(), confirmAll);
      assert(unchanged.fitAssessment.gapReview.outcome === 'unchanged' && unchanged.adjustedScore === 69, 'confirmed rows leave the score');
      const stale = scoredJob();
      stale.adjustedScore = 85;
      stale.matchScore = 85;
      stale.fitAssessment = { ...stale.fitAssessment, adjustedScore: 85 };
      const lowered = apply(stale, confirmAll);
      assert(lowered.fitAssessment.gapReview.outcome === 'lowered' && lowered.adjustedScore === 69 && lowered.fitAssessment.gapReview.before.adjustedScore === 85, 'a lower recomputed score is reported as lowered');
    },
  },
  {
    name: 'Gap review: a reviewed job is no longer a candidate',
    run: () => {
      const job = scoredJob();
      assert(JSON.stringify(selectGapReviewCandidates([job], { threshold: BAR })) === '[0]', 'before review the job is a candidate');
      const reviewed = apply(job, confirmAll);
      assert(reviewed.adjustedScore < BAR && reviewed.rawScore >= BAR, 'still below the bar after review');
      assert(selectGapReviewCandidates([reviewed], { threshold: BAR }).length === 0, 'a job carrying gapReview is skipped');
    },
  },
  {
    name: 'Gap review: summarizeGapReviews returns counts only and skips unreviewed jobs',
    run: () => {
      const raised = apply(scoredJob(), [
        verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'equivalent experience is welcome' }),
        verdict('r2'),
      ]);
      const unchanged = apply(scoredJob(), confirmAll);
      const rejected = applyGapReview(scoredJob(), {
        index: 0,
        rows: [verdict('r1', { verdict: 'priority', priority: 'preferred', jobEvidence: 'never stated anywhere' }), verdict('r2')],
      }, { candidateText: CANDIDATE_TEXT, jobText: JOB_TEXT, threshold: BAR, reviewedAt: 9 });
      const duplicated = apply(scoredJob(), [verdict('r1'), verdict('r2', { verdict: 'duplicate', duplicateOf: 'r1' })], 80);
      const evidenced = apply(scoredJob(), [
        verdict('r1', { verdict: 'evidence', status: 'direct', candidateEvidence: 'used alpha tool' }),
        verdict('r2'),
      ], 80);
      const summary = summarizeGapReviews([raised, scoredJob(), unchanged, null, rejected, duplicated, evidenced, { matchScore: 50 }], { threshold: BAR });
      assert(JSON.stringify(summary) === JSON.stringify({
        threshold: 70,
        reviewed: 5,
        raisedAboveThreshold: 1,
        raised: 2,
        unchanged: 2,
        lowered: 0,
        // confirmed: raised 1 + unchanged 2 + rejected 1 + duplicated 1 + evidenced 1
        changes: { confirmed: 6, priority: 1, evidence: 1, duplicate: 1, rejected: 1 },
      }), `summary ${JSON.stringify(summary)}`);
      const empty = summarizeGapReviews([], { threshold: BAR });
      assert(empty.reviewed === 0 && empty.changes.rejected === 0 && empty.threshold === 70, 'empty summary');
      const serialized = JSON.stringify(summary);
      assert(!/Alpha|Beta|Gamma|capability|r1|r2/u.test(serialized), 'no row or job text leaks into the summary');
    },
  },
  {
    name: 'Gap review pipeline: the real score-jobs handler reviews a capped job once and publishes the recalibrated score',
    run: async () => {
      const { result, scorerCalls, reviewerCalls, telemetry, heartbeat } = await runHandlerWithGapReview({
        scorerGaps: twoRequiredGaps,
        reviewer: async (prompt, options) => {
          const ids = listedIdsIn(prompt);
          assert(ids.length === 2, `the review prompt must list exactly the two gap rows (got ${ids.length})`);
          assert(options.task === 'job-gap-review' && options.hints.itemCount === 1 && options.hints.reviewRowCount === 2
            && options.hints.batch === 1 && options.hints.batchTotal === 1, `review handoff options were ${JSON.stringify({ task: options.task, hints: options.hints })}`);
          assert(prompt.includes('JOB index 0') && prompt.includes('Candidate used alpha tool'), 'the prompt carries the job block and the pinned career evidence');
          return { reviews: [{ index: 0, rows: [
            verdict(ids[0], { verdict: 'priority', priority: 'preferred', jobEvidence: 'equivalent experience is welcome' }),
            verdict(ids[1]),
          ] }] };
        },
      });
      assert(result.success && result.scoredJobs?.length === 1, `handler result ${JSON.stringify({ success: result.success, error: result.error })}`);
      const [scored] = result.scoredJobs;
      assert(scorerCalls.length === 1 && reviewerCalls.length === 1, `expected one scoring and one review handoff (got ${scorerCalls.length}/${reviewerCalls.length})`);
      assert(scored.rawScore === 86 && scored.matchScore === 79 && scored.adjustedScore === 79, `published score was ${scored.rawScore}/${scored.matchScore}`);
      assert(scored.fitAssessment.gapReview.outcome === 'raised-above-threshold'
        && scored.fitAssessment.gapReview.before.adjustedScore === 69 && scored.fitAssessment.gapReview.after.adjustedScore === 79
        && scored.fitAssessment.gapReview.threshold === 70, `gapReview was ${JSON.stringify(scored.fitAssessment.gapReview)}`);
      assert(scored.materialGaps.length === 1 && scored.requirementAssessments.some(row => row.reviewedPriority?.to === 'preferred'), 'the published rows carry the review correction');
      assert(telemetry.gapReview.candidates === 1 && telemetry.gapReview.batches === 1 && telemetry.gapReview.reviewedJobs === 1
        && telemetry.gapReview.reviewed === 1 && telemetry.gapReview.raisedAboveThreshold === 1 && telemetry.gapReview.failed === null
        && telemetry.gapReview.changes.priority === 1 && telemetry.gapReview.changes.confirmed === 1, `scoring telemetry gapReview was ${JSON.stringify(telemetry.gapReview)}`);
      assert(heartbeat?.active === false && heartbeat.phase === 'completed' && heartbeat.scored === 1, 'gap review must finish before closing the live scoring heartbeat');
      assert(telemetry.calibration.cappedAcrossThreshold === 0 && telemetry.calibration.capped === 1, 'after the review the job is no longer capped across the bar but is still counted as capped');
    },
  },
  {
    name: 'Gap review pipeline: a failed review handoff leaves the calibrated score and records the failure',
    run: async () => {
      const { result, reviewerCalls, telemetry, heartbeat } = await runHandlerWithGapReview({
        scorerGaps: twoRequiredGaps,
        reviewer: async () => { throw new Error('synthetic review transport failure'); },
      });
      assert(result.success && result.scoredJobs?.length === 1, 'scoring still completes');
      const [scored] = result.scoredJobs;
      assert(reviewerCalls.length === 1, 'the review handoff was attempted once');
      assert(scored.matchScore === 69 && scored.rawScore === 86 && !scored.fitAssessment.gapReview, `the calibrated score must stand (got ${scored.matchScore}, gapReview ${JSON.stringify(scored.fitAssessment.gapReview)})`);
      assert(telemetry.gapReview.candidates === 1 && telemetry.gapReview.reviewedJobs === 0 && telemetry.gapReview.reviewed === 0
        && telemetry.gapReview.failed === 'synthetic review transport failure', `telemetry gapReview was ${JSON.stringify(telemetry.gapReview)}`);
      assert(heartbeat?.active === false && heartbeat.phase === 'completed', 'a failed optional review must not leave the scorer live');
      assert(telemetry.calibration.cappedAcrossThreshold === 1, 'the unreviewed job still counts as capped across the bar');
    },
  },
  {
    name: 'Gap review pipeline: a job the ceilings did not pull below the bar gets no review handoff',
    run: async () => {
      const { result, reviewerCalls, telemetry } = await runHandlerWithGapReview({
        scorerGaps: [scorerGap('Alpha capability', 'Alpha duty one is required')],
        reviewer: async () => { throw new Error('must not be called'); },
      });
      assert(result.success && result.scoredJobs?.[0]?.matchScore === 79, `one critical gap caps at 79 (got ${result.scoredJobs?.[0]?.matchScore})`);
      assert(reviewerCalls.length === 0, 'no review handoff is spent on a job still at or above the bar');
      assert(telemetry.gapReview.candidates === 0 && telemetry.gapReview.batches === 0 && telemetry.gapReview.reviewed === 0, `telemetry gapReview was ${JSON.stringify(telemetry.gapReview)}`);
    },
  },
];
