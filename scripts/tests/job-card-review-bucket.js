import {
  assert,
  buildJobsPipelineSnapshot,
  buildScoredJob,
  CURRENT_SCHEMA_VERSION,
  getJobsTelemetry,
  hubCardFilter,
  isCappedAcrossThreshold,
  isJobCardVisible,
  isLegacyUnscoredPlaceholder,
  isUnscoredPlaceholderCard,
  jobCardReviewReason,
  LEGACY_UNSCORED_PLACEHOLDER_REASONS,
  LEGACY_UNSCORED_PLACEHOLDER_SCORE,
  migrateUnscoredPlaceholderStatus,
  runNodeMigrations,
  SCORER_UNSCORED_SCORE_STATUS,
  summarizeFitCalibration,
  UNSCORED_FALLBACK_SCORE,
  UNSCORED_PLACEHOLDER_REASONS,
  UNSCORED_SCORE_STATUS,
} from '../test-dependencies.js';

// Fixtures use only synthetic titles and numbers: no candidate or posting text.
const audited = (rawScore, adjustedScore, adjustments = []) => ({
  source: 'indeed',
  matchScore: adjustedScore,
  rawScore,
  adjustedScore,
  fitAssessment: { auditStatus: 'audited', rawScore, adjustedScore, adjustments },
});
const placeholder = (allNull = false) => buildScoredJob(
  { source: 'indeed', title: 'Synthetic role', index: 3, matchScore: 91, rawScore: 91, fitAssessment: { auditStatus: 'audited' } },
  null,
  { fallbackScore: UNSCORED_FALLBACK_SCORE, allNull },
);

export default [
  {
    name: 'Review bucket: scorer stamps a structural unscored marker and the renderer reads only that marker',
    run: () => {
      const lone = placeholder(false);
      const batchWide = placeholder(true);
      assert(lone.scoreStatus === SCORER_UNSCORED_SCORE_STATUS && batchWide.scoreStatus === SCORER_UNSCORED_SCORE_STATUS,
        'both placeholder shapes carry the unscored scoreStatus');
      assert(lone.matchScore === UNSCORED_FALLBACK_SCORE && !('rawScore' in lone) && !('fitAssessment' in lone),
        'a placeholder never inherits the prior row\'s score or audit');
      assert(SCORER_UNSCORED_SCORE_STATUS === UNSCORED_SCORE_STATUS,
        'the scorer and the renderer agree on the marker value');
      assert(UNSCORED_FALLBACK_SCORE === LEGACY_UNSCORED_PLACEHOLDER_SCORE
        && JSON.stringify([...UNSCORED_PLACEHOLDER_REASONS].sort()) === JSON.stringify([...LEGACY_UNSCORED_PLACEHOLDER_REASONS].sort())
        && [lone.reasoning, batchWide.reasoning].every(reason => UNSCORED_PLACEHOLDER_REASONS.includes(reason)),
      'the legacy-migration fingerprint (sentinel number + exact reasons) is pinned to what the scorer actually writes');

      assert(isUnscoredPlaceholderCard(lone) && isUnscoredPlaceholderCard({ scoreStatus: 'unscored-evidence-incomplete' }),
        'the marker and its more specific evidence-incomplete variant both read as unscored');
      assert(!isUnscoredPlaceholderCard(audited(50, 50)) && !isUnscoredPlaceholderCard({ matchScore: 50, reasoning: 'Unable to score' }),
        'an honest 50, and even a legacy-shaped row without the marker, is NOT detected as unscored by the live filter');
      return { reasons: UNSCORED_PLACEHOLDER_REASONS.length };
    },
  },
  {
    name: 'Review bucket: capped-across-threshold and unscored cards stay visible under the slider; honest low scores do not',
    run: () => {
      const capped = audited(86, 69, [{ code: 'multiple-critical-gaps', from: 86, to: 69 }]);
      const honestLow = audited(65, 65);
      const cappedButStillLow = audited(68, 60, [{ code: 'critical-gap', from: 68, to: 60 }]);
      const legacyLow = { source: 'indeed', matchScore: 65 };
      const unscored = placeholder();
      const at70 = { scoreThreshold: 70 };

      assert(isCappedAcrossThreshold(capped, 70) && jobCardReviewReason(capped, 70) === 'capped',
        'an 86 calibrated to 69 is a capped review card at a 70 bar');
      assert(!isCappedAcrossThreshold(cappedButStillLow, 70) && jobCardReviewReason(cappedButStillLow, 70) === null,
        'a cap that never crossed the bar (68→60) is an ordinary low score, not a review card');
      assert(!isCappedAcrossThreshold(honestLow, 70) && !isCappedAcrossThreshold(legacyLow, 70),
        'an uncapped audited score and a legacy score without rawScore are never "capped"');
      assert(jobCardReviewReason(unscored, 70) === 'unscored' && !isCappedAcrossThreshold(unscored, 70),
        'a placeholder reads as unscored, never as capped');

      assert(isJobCardVisible(capped, at70) && isJobCardVisible(unscored, at70),
        'review cards are visible under a 70 slider by default');
      assert(!isJobCardVisible(honestLow, at70) && !isJobCardVisible(cappedButStillLow, at70) && !isJobCardVisible(legacyLow, at70),
        'honest sub-70 cards stay hidden under a 70 slider');
      assert(!isJobCardVisible(capped, { ...at70, showReviewCards: false }) && !isJobCardVisible(unscored, { ...at70, showReviewCards: false }),
        'switching review cards off hides both kinds');
      assert(isJobCardVisible(capped, { scoreThreshold: 0, showReviewCards: false }) && isJobCardVisible(unscored, { scoreThreshold: 0, showReviewCards: false }),
        'with no slider threshold every card is visible regardless of the switch');
      assert(!isJobCardVisible(capped, { ...at70, sourceFilter: 'linkedin' }) && !isJobCardVisible(unscored, { ...at70, sourceFilter: 'linkedin' }),
        'the source pill still applies to review cards');
      assert(isJobCardVisible(capped, { scoreThreshold: 90 }) === false,
        'a capped card is a review card only at a bar its raw score reached: raw 86 is hidden at 90');

      const filter = hubCardFilter({ scoreThreshold: 70, sourceFilter: null });
      assert(filter.showReviewCards === true && hubCardFilter({ showReviewCards: false }).showReviewCards === false
        && hubCardFilter({ showReviewCards: 'no' }).showReviewCards === true,
      'hubCardFilter defaults review cards ON and only an explicit false turns them off');
      return { visibleAt70: 2, hiddenAt70: 3 };
    },
  },
  {
    name: 'migrateUnscoredPlaceholderStatus (v11): legacy placeholder cards and hub rows gain the marker; honest 50s are untouched',
    run: () => {
      const legacyCard = { id: 'c1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h1', matchScore: 50, reasoning: 'Unable to score', careerDirection: 'Other' } };
      const legacyFormatError = { id: 'c2', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h1', matchScore: 50, reasoning: 'AI format error' } };
      const honestFifty = { id: 'c3', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h1', matchScore: 50, reasoning: 'Unable to score', rawScore: 50, fitAssessment: { auditStatus: 'audited' } } };
      const otherFifty = { id: 'c4', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h1', matchScore: 50, reasoning: 'Partial overlap with the role' } };
      const alreadyStamped = { id: 'c5', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h1', matchScore: 50, reasoning: 'Unable to score', scoreStatus: 'unscored-evidence-incomplete' } };
      const hub = { id: 'h1', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', scoredJobs: [
        { title: 'Legacy placeholder row', matchScore: 50, reasoning: 'AI format error' },
        { title: 'Honest row', matchScore: 50, reasoning: 'AI format error', rawScore: 50, adjustedScore: 50 },
        { title: 'Scored row', matchScore: 83, rawScore: 83 },
      ] } };
      const untouchedHub = { id: 'h2', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'done', scoredJobs: [{ title: 'Scored', matchScore: 77 }] } };
      const nested = { id: 'group', type: 'group', position: { x: 0, y: 0 }, data: { canvasData: { nodes: [
        { id: 'inner', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'h3', matchScore: 50, reasoning: 'Unable to score' } },
      ], edges: [], drawings: [] } } };

      assert(isLegacyUnscoredPlaceholder(legacyCard.data) && isLegacyUnscoredPlaceholder(legacyFormatError.data)
        && !isLegacyUnscoredPlaceholder(honestFifty.data) && !isLegacyUnscoredPlaceholder(otherFifty.data)
        && !isLegacyUnscoredPlaceholder(alreadyStamped.data) && !isLegacyUnscoredPlaceholder({ matchScore: 51, reasoning: 'Unable to score' }),
      'the legacy fingerprint is exact: sentinel number, exact reason, no audit, no marker');

      const direct = migrateUnscoredPlaceholderStatus([legacyCard, legacyFormatError, honestFifty, otherFifty, alreadyStamped, hub, untouchedHub]);
      const byId = id => direct.find(n => n.id === id);
      assert(byId('c1').data.scoreStatus === UNSCORED_SCORE_STATUS && byId('c2').data.scoreStatus === UNSCORED_SCORE_STATUS,
        'v11 stamps both legacy placeholder shapes');
      assert(byId('c1').data.matchScore === 50 && byId('c1').data.reasoning === 'Unable to score',
        'v11 adds the marker without rewriting the stored number or explanation');
      assert(byId('c3') === honestFifty && byId('c4') === otherFifty && byId('c5') === alreadyStamped && byId('h2') === untouchedHub,
        'v11 leaves audited, differently-explained, already-stamped, and clean nodes untouched by reference');
      const rows = byId('h1').data.scoredJobs;
      assert(rows[0].scoreStatus === UNSCORED_SCORE_STATUS && !('scoreStatus' in rows[1]) && !('scoreStatus' in rows[2]) && rows[1] === hub.data.scoredJobs[1],
        'v11 stamps only the legacy placeholder row inside a hub\'s scoredJobs');

      const viaRunner = runNodeMigrations([nested], 10);
      assert(viaRunner[0].data.canvasData.nodes[0].data.scoreStatus === UNSCORED_SCORE_STATUS,
        'v11 runner applies the stamp recursively to group sub-canvases');
      assert(migrateUnscoredPlaceholderStatus(direct) === direct,
        'v11 is idempotent — a second pass is a same-ref no-op');
      assert(CURRENT_SCHEMA_VERSION >= 11 && runNodeMigrations(viaRunner, CURRENT_SCHEMA_VERSION) === viaRunner,
        'migration advances the schema and is a no-op for an already-current workspace');
      return { schema: CURRENT_SCHEMA_VERSION, stamped: 4 };
    },
  },
  {
    name: 'summarizeFitCalibration counts every applied cap by rule and the jobs capped across the application bar',
    run: () => {
      const jobs = [
        audited(86, 69, [{ code: 'multiple-critical-gaps', from: 86, to: 69 }]),
        audited(90, 79, [{ code: 'critical-gap', from: 90, to: 79 }]),
        audited(88, 69, [{ code: 'critical-gap', from: 88, to: 79 }, { code: 'multiple-important-gaps', from: 79, to: 69 }]),
        audited(72, 72),
        audited(68, 60, [{ code: 'critical-gap', from: 68, to: 60 }]),
        // A scored job whose cap list lives only at the top level (older shape).
        { source: 'dice', matchScore: 84, rawScore: 92, adjustedScore: 84, adjustments: [{ code: 'material-gap', from: 92, to: 84 }] },
        placeholder(),
        { source: 'dice', matchScore: 61 }, // legacy row, no audit: neither calibrated nor unscored
        null,
      ];
      const summary = summarizeFitCalibration(jobs, { threshold: 70 });
      assert(summary.threshold === 70 && summary.scored === 8 && summary.unscored === 1 && summary.calibrated === 6,
        'scored counts every row, unscored counts placeholders, calibrated counts rows with a raw and adjusted score');
      assert(summary.capped === 5, 'capped counts every job whose adjusted score is below its raw score');
      assert(summary.cappedAcrossThreshold === 2, 'only 86→69 and 88→69 crossed the 70 bar; 90→79, 92→84 and 68→60 did not');
      assert(JSON.stringify(summary.adjustmentCodes) === JSON.stringify({
        'multiple-critical-gaps': 1, 'critical-gap': 3, 'multiple-important-gaps': 1, 'material-gap': 1,
      }), 'adjustment codes are counted per applied cap, including two caps on one job');
      const noBar = summarizeFitCalibration(jobs);
      assert(noBar.threshold === null && noBar.cappedAcrossThreshold === 0 && noBar.capped === 5,
        'without a threshold the across-bar count is 0 and the rest is unchanged');
      const empty = summarizeFitCalibration(undefined, { threshold: 70 });
      assert(empty.scored === 0 && empty.capped === 0 && Object.keys(empty.adjustmentCodes).length === 0,
        'a missing job list summarizes to zeros');
      return { capped: summary.capped, across: summary.cappedAcrossThreshold };
    },
  },
  {
    name: 'Scoring report prints the calibration cap counts and the capped-across-bar review line',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, pipeline: telemetry.pipeline,
        search: telemetry.search, resolves: telemetry.resolves, scoring: telemetry.scoring,
        bucketing: telemetry.bucketing, history: telemetry.history,
      };
      const hubId = 'review-bucket-report-hub';
      const scoring = {
        ts: Date.now(), runId: null, input: 6, selectedForScoring: 6, scored: 6, placeholders: 1, ungroundedScores: 0,
        unscored: 0, batches: 1, failedBatches: 0, providerCalls: 1, cappedForBudget: 0, directions: 1, models: [], fallbacks: [],
      };
      try {
        Object.assign(telemetry, {
          nodeId: hubId, windowId: null, pipeline: null, search: null, resolves: {}, bucketing: null, history: null,
          scoring: {
            ...scoring,
            calibration: { threshold: 70, scored: 6, calibrated: 5, capped: 3, cappedAcrossThreshold: 2, unscored: 1, adjustmentCodes: { 'critical-gap': 2, 'multiple-critical-gaps': 1 } },
          },
        });
        const report = buildJobsPipelineSnapshot(new Set([hubId]), null, null);
        assert(report.includes('- Evidence-gap calibration: 3/5 audited score(s) lowered below the AI-assigned number (critical-gap=2, multiple-critical-gaps=1).'),
          'the report states how many audited scores the caps lowered and which rules fired, most frequent first');
        assert(report.includes('⚠️ **2 capped across the 70 bar** — AI-assigned ≥70, calibrated <70.'),
          'the report flags the across-bar count as a review population');

        telemetry.scoring = { ...scoring, calibration: { threshold: 70, scored: 6, calibrated: 5, capped: 0, cappedAcrossThreshold: 0, unscored: 1, adjustmentCodes: {} } };
        const clean = buildJobsPipelineSnapshot(new Set([hubId]), null, null);
        assert(clean.includes('- Evidence-gap calibration: 0/5 audited score(s) lowered below the AI-assigned number.')
          && clean.includes('  - 0 capped across the 70 bar.')
          && !clean.includes('capped across the 70 bar** —'),
        'a run with no caps prints zero counts without a warning');

        telemetry.scoring = { ...scoring };
        const legacy = buildJobsPipelineSnapshot(new Set([hubId]), null, null);
        assert(!legacy.includes('Evidence-gap calibration'),
          'telemetry recorded before calibration counts existed prints no calibration line rather than inventing zeros');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { lines: 2 };
    },
  },
];
