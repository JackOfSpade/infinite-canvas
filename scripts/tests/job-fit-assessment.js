import { assert, calculateDatedTenure, calibratedScoreForJob, validateAndNormalizeFitAssessment } from '../test-dependencies.js';
import { calibrateGroundedJobRequirements, recalibrateAuditedFitAssessment } from '../../electron/ipc/jobFitAssessment.js';

const jobText = `
We need an engineer to lead cloud platform architecture. Candidates must have
four years of software development and production experience with a cloud
platform. GraphQL experience is a preferred qualification.
`;
const candidateText = `
Built React and Django applications, maintained REST APIs, and migrated a
regional dispatch portal. Evaluated code-generation tooling for engineering workflows.
`;
const roles = [
  { id: 'primary', start: 'March 2021', end: 'April 2024' },
  { id: 'earlier', start: 'August 2020', end: 'November 2020' },
];

function requirement({ requirement, priority, status, jobEvidence, candidateEvidence }) {
  return { requirementText: requirement, priority, status, jobEvidence, candidateEvidence };
}

// Synthetic posting for the calibration-policy regression tests: each clause is
// a separate, non-overlapping requirement quote.
const gapJobText = `
Requires alpha ledger reconciliation, bravo queue tuning, charlie fleet routing,
and delta kiosk calibration. Also echo dock planning and foxtrot badge printing.
`;
const tenureJobText = `
Requires three years of ledger reconciliation experience and five years of kiosk
calibration experience. Also bravo queue tuning.
`;
const NOW = new Date(Date.UTC(2026, 7, 1));

function gapRow(label, priority, status, quote) {
  return requirement({ requirement: label, priority, status, jobEvidence: quote, candidateEvidence: '' });
}

function auditGaps(rows, score = 95, options = {}) {
  return validateAndNormalizeFitAssessment({ score, requirementAssessments: rows }, { jobText: gapJobText, candidateText, ...options });
}

function handRow(id, requirementLabel, priority, effectiveStatus, quote) {
  return {
    id,
    requirement: requirementLabel,
    priority,
    effectiveStatus,
    reportedStatus: effectiveStatus,
    jobEvidence: [quote],
    candidateEvidence: [],
    scoreImpact: 'scored',
    materialGap: priority !== 'preferred' && ['not_documented', 'contradicted', 'unclear'].includes(effectiveStatus),
    grounding: { requirementGrounded: true, candidateClaimGrounded: true, rejectedJobEvidence: [], rejectedCandidateEvidence: [] },
  };
}

export default [
  {
    name: 'Job fit assessment: grounded critical gaps cap an inflated model score',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        matchScore: 92,
        confidence: 'high',
        requirementAssessments: [
          requirement({
            requirement: 'Cloud platform experience', priority: 'critical', status: 'direct',
            jobEvidence: 'production experience with a cloud platform', candidateEvidence: 'AWS deployments',
          }),
          requirement({
            requirement: 'Four years of development', priority: 'critical', status: 'missing',
            jobEvidence: 'four years of software development', candidateEvidence: '',
          }),
          requirement({
            requirement: 'GraphQL', priority: 'preferred', status: 'missing',
            jobEvidence: 'GraphQL experience', candidateEvidence: '',
          }),
        ],
      }, { jobText, candidateText, candidateRoles: roles, asOf: new Date(Date.UTC(2026, 7, 1)) });
      // Row 0's direct claim quotes evidence that is not in the career text, so
      // it becomes `unclear` (inconclusive); row 1 is a hard documentation
      // gap. One hard critical gap plus one inconclusive one reach the 79
      // ceiling; the 69 ceiling needs two HARD critical gaps (below).
      assert(result.rawScore === 92 && result.adjustedScore === 79, 'one hard critical gap plus one inconclusive critical gap must cap score at 79');
      assert(result.scoreInterpretation === 'hiring-fit-not-probability', 'the public score must not masquerade as a statistically calibrated hiring forecast');
      assert(result.requirementRows[0].effectiveStatus === 'unclear', 'unsupported direct candidate claim must downgrade to unclear');
      assert(result.materialGaps.length === 2, 'preferred-only gap must not become a material gap');
      assert(result.confidence.reported === 'high' && result.confidence.effective === 'low' && result.confidence.groundedRequirementCount === 3,
        'a critical not_documented requirement must reduce confidence to low while retaining the rejected-evidence audit value');
      assert(result.adjustments[0].code === 'critical-gap' && result.adjustments[0].reason.includes('counts toward the 79 ceiling but not the 69 ceiling'),
        'audit must state the exact calibration rule and why the inconclusive gap did not reach 69');
      assert(result.reasoning.includes('calibrated from 92 to 79') && !result.reasoning.includes('AWS deployments'),
        'user-facing reasoning must expose the calibration without repeating rejected claims');
      const bothHard = validateAndNormalizeFitAssessment({
        matchScore: 92,
        confidence: 'high',
        requirementAssessments: [
          requirement({
            requirement: 'Cloud platform experience', priority: 'critical', status: 'not_documented',
            jobEvidence: 'production experience with a cloud platform', candidateEvidence: '',
          }),
          requirement({
            requirement: 'Four years of development', priority: 'critical', status: 'missing',
            jobEvidence: 'four years of software development', candidateEvidence: '',
          }),
        ],
      }, { jobText, candidateText, candidateRoles: roles, asOf: new Date(Date.UTC(2026, 7, 1)) });
      assert(bothHard.adjustedScore === 69 && bothHard.adjustments[0].code === 'multiple-critical-gaps'
        && bothHard.reasoning.includes('calibrated from 92 to 69'),
      'two hard grounded critical documentation gaps must cap score at 69');
      return { score: result.adjustedScore, hard: bothHard.adjustedScore, gaps: result.materialGaps.length };
    },
  },
  {
    name: 'Job fit assessment: grounded adjacent critical experience caps at 84 and evidence is verbatim',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        score: 91,
        requirementRows: [
          requirement({
            requirement: 'Cloud platform experience', priority: 'critical', status: 'adjacent',
            jobEvidence: 'production experience with a cloud platform', candidateEvidence: 'maintained REST APIs',
          }),
          requirement({
            requirement: 'API implementation', priority: 'important', status: 'direct',
            jobEvidence: 'engineer', candidateEvidence: 'maintained REST APIs',
          }),
        ],
      }, { jobText, candidateText });
      assert(result.adjustedScore === 84, 'a grounded critical adjacent match must keep a high score below 85');
      assert(result.strengths.length === 1 && result.strengths[0].requirement === 'API implementation', 'direct grounded rows should be audit strengths');
      assert(result.requirementRows[0].jobEvidence[0] === 'production experience with a cloud platform', 'stored job evidence must retain the supplied verbatim quote');
      return { score: result.adjustedScore };
    },
  },
  {
    name: 'Job fit assessment: public reasoning explains an unchanged AI score with adjacent matches and safe audit limitations',
    run: () => {
      const assessedJob = [
        'Candidates use AI coding agents as part of daily engineering.',
        'Maintain a shared internal platform with internal APIs and reusable services.',
        'Design clear APIs with deliberate service boundaries and data models.',
        'Implement CI/CD workflows with cloud infrastructure and infrastructure as code.',
        'Build observability and evaluation systems with security controls and auditability.',
      ].join(' ');
      const assessedCandidate = [
        'Regular pairing with code-generation tools.',
        'Built a portal that gives several departments one entry point to shared utilities.',
        'Maintained REST APIs with token-scoped access.',
      ].join(' ');
      const result = validateAndNormalizeFitAssessment({
        score: 70,
        confidence: 'high',
        reasoning: 'Provider prose must never be used in the public explanation.',
        requirementAssessments: [
          requirement({ requirement: 'Agentic engineering workflow', priority: 'required', status: 'adjacent', jobEvidence: 'use AI coding agents', candidateEvidence: 'pairing with code-generation tools' }),
          requirement({ requirement: 'Shared internal platform', priority: 'important', status: 'adjacent', jobEvidence: 'shared internal platform', candidateEvidence: 'portal that gives several departments one entry point to shared utilities' }),
          requirement({ requirement: 'APIs and integrations', priority: 'important', status: 'adjacent', jobEvidence: 'internal APIs and reusable services', candidateEvidence: 'REST APIs with token-scoped access' }),
        ],
        materialGaps: [
          requirement({ requirement: 'AI platform architecture and gateways', priority: 'important', status: 'not_documented', jobEvidence: 'clear APIs\nservice boundaries and data models', candidateEvidence: '' }),
          requirement({ requirement: 'CI/CD, cloud, and infrastructure as code', priority: 'important', status: 'not_documented', jobEvidence: 'CI/CD workflows', candidateEvidence: '' }),
          requirement({ requirement: 'AI observability, evaluation, security, and auditability', priority: 'important', status: 'not_documented', jobEvidence: 'observability and evaluation systems\nsecurity controls and auditability', candidateEvidence: '' }),
        ],
      }, { jobText: assessedJob, candidateText: assessedCandidate });

      assert(result.rawScore === 70 && result.adjustedScore === 70 && result.adjustments.length === 0,
        'an AI score already below the verified-gap ceiling must remain unchanged');
      assert(result.adjacentMatches.length === 3 && result.strengths.length === 0 && result.materialGaps.length === 1,
        'the audit must retain transferable matches separately from direct strengths and verified gaps');
      assert(result.rejectedRequirementRows.length === 2
        && result.confidence.effective === 'medium'
        && result.confidence.groundedRequirementCount === 4
        && result.confidence.requirementCount === 6,
      'unverifiable posting citations must remain visible as limitations and reduce evidence confidence');
      assert(result.reasoning.includes('Adjacent, transferable support—not equivalent evidence')
        && result.reasoning.includes('Agentic engineering workflow')
        && result.reasoning.includes('CI/CD, cloud, and infrastructure as code')
        && result.reasoning.includes('Assessment limitation')
        && result.reasoning.includes('AI platform architecture and gateways')
        && result.reasoning.includes('AI observability, evaluation, security, and auditability')
        && result.reasoning.includes('Effective confidence is medium')
        && result.reasoning.includes('evidence coverage is 4/6'),
      'public reasoning must explain the score using matches, verified gaps, safe limitation labels, confidence, and coverage');
      assert(!result.reasoning.includes('Provider prose')
        && !result.reasoning.includes('clear APIs\nservice boundaries')
        && !result.reasoning.toLowerCase().includes('candidate lacks'),
      'public reasoning must never expose raw model prose, rejected evidence quotes, or categorical deficit language');
      return { score: result.adjustedScore, adjacent: result.adjacentMatches.length, coverage: '4/6' };
    },
  },
  {
    name: 'Job fit assessment: fabricated requirements are flagged but cannot penalize the candidate',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        fitScore: 88,
        requirements: [
          requirement({
            requirement: 'Unlisted certification', priority: 'critical', status: 'missing',
            jobEvidence: 'requires a formal safety certification', candidateEvidence: '',
          }),
          requirement({
            requirement: 'GraphQL', priority: 'preferred', status: 'missing',
            jobEvidence: 'GraphQL experience', candidateEvidence: '',
          }),
          requirement({
            requirement: 'Role framing', priority: 'contextual', status: 'missing',
            jobEvidence: 'engineer', candidateEvidence: '',
          }),
        ],
      }, { jobText, candidateText });
      assert(result.adjustedScore === 88, 'an ungrounded invented requirement must not trigger a cap');
      assert(result.rejectedRequirementRows.length === 1 && result.warnings.some(warning => warning.includes('Unlisted certification')),
        'the invented requirement must remain visible to an auditor');
      assert(result.materialGaps.length === 0, 'preferred, contextual, and ungrounded gaps must not be material');
      const contextual = result.requirementRows.find(row => row.reportedPriority === 'contextual');
      assert(contextual.priority === 'preferred' && !contextual.materialGap, 'contextual priority must remain visible but non-penalizing');
      return { rejected: result.rejectedRequirementRows.length };
    },
  },
  {
    name: 'Job fit assessment: work authorization and location constraints are informational and never penalize fit',
    run: () => {
      const logisticsJob = 'Based in the United States. Willing to work on-site in Austin, TX. You must be authorized to work for any employer in the US. Requires production API design.';
      const result = validateAndNormalizeFitAssessment({
        score: 92,
        confidence: 'high',
        requirementAssessments: [
          requirement({ requirement: 'Production API design', priority: 'required', status: 'direct', jobEvidence: 'production API design', candidateEvidence: 'maintained REST APIs' }),
        ],
        materialGaps: [
          requirement({ requirement: 'Current U.S. base', priority: 'required', status: 'not_documented', jobEvidence: 'Based in the United States', candidateEvidence: '' }),
          requirement({ requirement: 'On-site availability in Austin', priority: 'required', status: 'not_documented', jobEvidence: 'Willing to work on-site in Austin, TX', candidateEvidence: '' }),
          requirement({ requirement: 'US work authorization', priority: 'required', status: 'not_documented', jobEvidence: 'authorized to work for any employer in the US', candidateEvidence: '' }),
        ],
      }, { jobText: logisticsJob, candidateText });
      const informational = result.requirementRows.filter(row => row.scoreImpact === 'informational');
      assert(result.adjustedScore === 92 && result.materialGaps.length === 0 && result.adjustments.length === 0,
        'non-scoring logistics must not cap or otherwise lower the model professional-fit score');
      assert(informational.length === 3
        && informational.some(row => row.scoreExclusionReason === 'work-authorization')
        && informational.filter(row => row.scoreExclusionReason === 'location').length === 2,
      'the audit must retain a transparent reason for excluding each logistical constraint');
      assert(!/United States|Austin|authori[sz]ed to work/i.test(result.reasoning),
        'user-facing score reasoning must not present logistics as professional fit gaps');
      assert(result.confidence.effective === 'high',
        'unknown logistics must not reduce confidence in the professional-fit assessment');
      const rejectedLiveScore = calibratedScoreForJob({
        matchScore: 67,
        confidence: 'high',
        requirementAssessments: [
          requirement({ requirement: 'Production API design', priority: 'required', status: 'direct', jobEvidence: 'production API design', candidateEvidence: 'maintained REST APIs' }),
        ],
        materialGaps: [
          requirement({ requirement: 'On-site availability in Austin', priority: 'required', status: 'not_documented', jobEvidence: 'Willing to work on-site in Austin, TX', candidateEvidence: '' }),
        ],
      }, { title: 'AI Platform Architect', snippet: logisticsJob }, { candidateText });
      assert(rejectedLiveScore === null,
        'a fresh response that may have embedded a logistics penalty in its raw number must be retried, not silently accepted');
      return { score: result.adjustedScore, informational: informational.length };
    },
  },
  {
    name: 'Job fit assessment: every grounded material gap blocks 85+, with stronger ceilings for repeated important gaps',
    run: () => {
      const calibrationJob = 'Requires data modeling, incident response, distributed systems operations, and schema migrations.';
      const rows = [
        requirement({ requirement: 'Data modeling', priority: 'important', status: 'missing', jobEvidence: 'data modeling', candidateEvidence: '' }),
        requirement({ requirement: 'Incident response', priority: 'important', status: 'unclear', jobEvidence: 'incident response', candidateEvidence: '' }),
        requirement({ requirement: 'Distributed systems operations', priority: 'important', status: 'missing', jobEvidence: 'distributed systems operations', candidateEvidence: '' }),
        requirement({ requirement: 'Schema migrations', priority: 'important', status: 'missing', jobEvidence: 'schema migrations', candidateEvidence: '' }),
      ];
      const one = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows.slice(0, 1) }, { jobText: calibrationJob, candidateText });
      const two = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows.slice(0, 2) }, { jobText: calibrationJob, candidateText });
      const threeOneUnclear = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows.slice(0, 3) }, { jobText: calibrationJob, candidateText });
      const threeHard = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: [rows[0], rows[2], rows[3]] }, { jobText: calibrationJob, candidateText });
      assert(one.adjustedScore === 84 && one.adjustments[0].code === 'material-gap', 'one grounded important gap must block 85+');
      assert(two.adjustedScore === 79 && two.adjustments[0].code === 'multiple-important-gaps', 'two grounded important gaps need a transparent 79 ceiling');
      // An `unclear` gap is inconclusive evidence, not a finding about the
      // record. It still blocks 85+ and counts toward the 79 ceiling, but a
      // 69 (below the user's application bar) needs three HARD gaps.
      assert(threeOneUnclear.adjustedScore === 79 && threeOneUnclear.adjustments[0].code === 'multiple-important-gaps'
        && threeOneUnclear.adjustments[0].reason.includes('counts toward the 79 ceiling but not the 69 ceiling'),
      'two hard important gaps plus one unclear gap stop at 79 and say why');
      assert(threeHard.adjustedScore === 69 && threeHard.adjustments[0].code === 'multiple-important-gaps', 'three hard grounded important gaps need a transparent 69 ceiling');
      assert(threeHard.mergedGapClusters.length === 0 && threeHard.materialGaps.length === 3, 'distinct gap rows are neither merged nor dropped');
      return { one: one.adjustedScore, two: two.adjustedScore, three: threeOneUnclear.adjustedScore, hard: threeHard.adjustedScore };
    },
  },
  {
    name: 'Job fit assessment: separately disclosed grounded gaps join the audit and cannot evade calibration',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        score: 95,
        requirementAssessments: [requirement({
          requirement: 'API implementation', priority: 'important', status: 'direct',
          jobEvidence: 'engineer', candidateEvidence: 'maintained REST APIs',
        })],
        materialGaps: [
          { requirementText: 'Cloud platform experience', priority: 'required', status: 'missing', jobEvidence: 'production experience with a cloud platform', impact: 'Core platform exposure is not documented.' },
          { requirementText: 'Cloud deployment history', priority: 'required', status: 'missing', jobEvidence: 'production experience with a cloud platform', impact: 'Duplicate evidence must not count twice.' },
          { requirementText: 'GraphQL', priority: 'preferred', status: 'missing', jobEvidence: 'GraphQL experience', impact: 'Optional tooling.' },
          { requirementText: 'Invented license', priority: 'required', status: 'missing', jobEvidence: 'requires an airworthiness license', impact: 'Not in the posting.' },
        ],
      }, { jobText, candidateText });
      assert(result.adjustedScore === 79 && result.adjustments[0].code === 'critical-gap',
        'a separately reported grounded required gap must receive the same calibration as a main-row gap');
      assert(result.requirementRows.filter(row => row.jobEvidence[0] === 'production experience with a cloud platform').length === 1,
        'gap rows must deduplicate by normalized job evidence before requirement text');
      assert(result.materialGaps.length === 1 && result.rejectedRequirementRows.length === 1,
        'preferred and ungrounded separately disclosed gaps must not become penalties');
      return { score: result.adjustedScore, rows: result.requirementRows.length };
    },
  },
  {
    name: 'Job fit assessment: effective confidence follows evidence coverage, not the model’s optimistic label',
    run: () => {
      const confidenceJob = 'Requires service ownership, observability, and release engineering.';
      const grounded = [
        requirement({ requirement: 'Service ownership', priority: 'important', status: 'direct', jobEvidence: 'service ownership', candidateEvidence: 'maintained REST APIs' }),
        requirement({ requirement: 'Observability', priority: 'important', status: 'direct', jobEvidence: 'observability', candidateEvidence: 'maintained REST APIs' }),
        requirement({ requirement: 'Release engineering', priority: 'important', status: 'direct', jobEvidence: 'release engineering', candidateEvidence: 'maintained REST APIs' }),
      ];
      const full = validateAndNormalizeFitAssessment({ score: 70, confidence: 'high', requirementAssessments: grounded }, { jobText: confidenceJob, candidateText });
      const partial = validateAndNormalizeFitAssessment({
        score: 70, confidence: 'high', requirementAssessments: [...grounded.slice(0, 2), requirement({ requirement: 'Fabricated process', priority: 'important', status: 'missing', jobEvidence: 'requires a formal process certificate', candidateEvidence: '' })],
      }, { jobText: confidenceJob, candidateText });
      const low = validateAndNormalizeFitAssessment({
        score: 70, confidence: 'high', requirementAssessments: [grounded[0], requirement({ requirement: 'Fabricated process', priority: 'important', status: 'missing', jobEvidence: 'requires a formal process certificate', candidateEvidence: '' }), requirement({ requirement: 'Invented clearance', priority: 'important', status: 'missing', jobEvidence: 'requires a government clearance', candidateEvidence: '' })],
      }, { jobText: confidenceJob, candidateText });
      assert(full.confidence.effective === 'high', 'fully grounded rows may retain reported high confidence');
      assert(partial.confidence.effective === 'medium' && partial.confidence.groundedRequirementRatio > 0.5,
        'incomplete but substantial grounding must reduce reported high confidence to medium');
      assert(low.confidence.effective === 'low' && low.confidence.groundedRequirementRatio <= 0.5,
        'zero or low grounding coverage must force low effective confidence');
      return { full: full.confidence.effective, partial: partial.confidence.effective, low: low.confidence.effective };
    },
  },
  {
    name: 'Job fit assessment: dated tenure preserves month/year uncertainty and separates selected experience',
    run: () => {
      const exact = calculateDatedTenure([{ start: 'March 2021', end: 'April 2024' }]);
      assert(!exact.exact && exact.minMonths === 36 && exact.maxMonths === 38 && exact.minYears === 3,
        'month-precise tenure should preserve omitted day-of-month uncertainty');
      const uncertain = calculateDatedTenure([{ start: '2023', end: '2025' }]);
      assert(!uncertain.exact && uncertain.minMonths === 12 && uncertain.maxMonths === 36, 'year-only dates must retain a possible tenure range');
      const dateRange = calculateDatedTenure([{ dates: '2021-03-01 – 2024-04-30' }]);
      assert(dateRange.roleCount === 1 && dateRange.minMonths === 36 && dateRange.maxMonths === 38,
        'a parsable date-range field must contribute bounded tenure without assuming its days');
      const result = validateAndNormalizeFitAssessment({
        score: 70,
        experienceAssessment: {
          totalProfessionalExperience: { years: '3+ years', candidateEvidence: 'Built React and Django applications', explanation: 'Dated roles supplied.' },
          categorySpecificExperience: [
            {
              category: 'Software development', requiredMinimumYears: 3.5, roleIds: ['primary'], years: '3.1 years',
              candidateEvidence: 'Built React and Django applications', jobEvidence: 'four years of software development', explanation: 'Selected implementation role only.',
            },
            {
              category: 'Cloud architecture', requiredMinimumYears: 0, roleIds: [], years: 'not established',
              candidateEvidence: '', jobEvidence: 'production experience with a cloud platform', explanation: 'No dated category role is claimed.',
            },
          ],
        },
        requirements: [requirement({
          requirement: 'Four years of software development', priority: 'critical', status: 'direct',
          jobEvidence: 'four years of software development', candidateEvidence: 'Built React and Django applications',
        })],
      }, { jobText, candidateText, candidateRoles: roles });
      const [softwareDevelopment, cloudArchitecture] = result.experience.categorySpecificExperience;
      assert(result.experience.totalProfessionalTenure.maxYears > softwareDevelopment.tenure.maxYears,
        'total tenure must not silently stand in for requirement-specific tenure');
      assert(softwareDevelopment.nearMinimum && softwareDevelopment.shortfallYears > 0,
        'a short documented shortfall should be identified as near, not rounded into a meet');
      assert(result.requirementRows[0].effectiveStatus === 'adjacent' && result.requirementRows[0].datedTenure?.disposition === 'near-shortfall',
        'dated role tenure must downgrade an optimistic direct claim to adjacent when it falls just short');
      assert(cloudArchitecture.requiredMinimumYears === null && cloudArchitecture.tenure === null,
        'a zero sentinel and empty role ids must not invent a category-specific tenure threshold');
      return { total: result.experience.totalProfessionalTenure.maxYears, specific: softwareDevelopment.tenure.maxYears };
    },
  },
  {
    name: 'Job fit assessment: larger dated tenure shortfall overrides a direct model claim and calibrates the score',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        score: 94,
        requirementAssessments: [requirement({
          requirement: 'Four years of software development', priority: 'required', status: 'direct',
          jobEvidence: 'four years of software development', candidateEvidence: 'Built React and Django applications',
        })],
        experienceAssessment: {
          totalProfessionalExperience: { years: '3+ years', candidateEvidence: 'Built React and Django applications', explanation: '' },
          categorySpecificExperience: [{
            category: 'Software development', requiredMinimumYears: 4, roleIds: ['primary'], years: '4 years',
            candidateEvidence: 'Built React and Django applications', jobEvidence: 'four years of software development', explanation: '',
          }],
        },
      }, { jobText, candidateText, candidateRoles: roles });
      assert(result.requirementRows[0].effectiveStatus === 'not_documented' && result.requirementRows[0].datedTenure?.disposition === 'shortfall',
        'a substantial documented duration shortfall must override a direct label without claiming the candidate lacks other experience');
      assert(result.adjustedScore === 79 && result.adjustments[0].code === 'critical-gap',
        'the tenure-derived critical gap must enter score calibration');
      return { score: result.adjustedScore };
    },
  },
  {
    name: 'Job fit assessment: legacy absence labels normalize to not_documented without asserting candidate absence',
    run: () => {
      const clauses = ['platform operations', 'release engineering', 'security review', 'incident response', 'production logging', 'build pipelines', 'quality review', 'database operations'];
      const absenceJob = `Requires ${clauses.join(', ')}.`;
      const labels = ['missing', 'absent', 'no support', 'no supporting evidence', 'not supported', 'unsupported', 'not established', 'unmet'];
      const result = validateAndNormalizeFitAssessment({
        score: 96,
        confidence: 'high',
        requirementAssessments: labels.map((status, index) => requirement({
          requirement: `Requirement ${index + 1}`,
          priority: 'important',
          status,
          jobEvidence: clauses[index],
          candidateEvidence: '',
        })),
      }, { jobText: absenceJob, candidateText });
      assert(result.requirementRows.every(row => row.reportedStatus === 'not_documented' && row.effectiveStatus === 'not_documented'),
        'legacy absence labels must expose only the canonical not_documented status');
      assert(result.statusCounts.not_documented === labels.length && result.materialGaps.every(gap => gap.status === 'not_documented'),
        'the returned audit must make the canonical status available without interpreting it as factual absence');
      const publicText = [result.reasoning, ...result.adjustments.map(item => item.reason), ...result.warnings].join(' ').toLowerCase();
      assert(publicText.includes('supplied career data') && !publicText.includes('candidate lacks') && !publicText.includes(' is missing'),
        'public audit wording must describe supplied-record documentation, never say the candidate lacks a qualification');
      assert(result.confidence.effective === 'low', 'multiple material not_documented rows must lower effective confidence to low');
      return { score: result.adjustedScore, status: result.requirementRows[0].effectiveStatus };
    },
  },
  {
    name: 'Job fit assessment: grounded contradiction is distinct from not_documented and can retain high confidence',
    run: () => {
      const contradictionJob = 'Requires daytime coverage and unrestricted work authorization.';
      const contradictionCandidate = 'Available only evenings and requires employer sponsorship.';
      const result = validateAndNormalizeFitAssessment({
        score: 90,
        confidence: 'high',
        requirementAssessments: [requirement({
          requirement: 'Daytime coverage', priority: 'important', status: 'contradicted',
          jobEvidence: 'daytime coverage', candidateEvidence: 'Available only evenings',
        })],
      }, { jobText: contradictionJob, candidateText: contradictionCandidate });
      assert(result.requirementRows[0].effectiveStatus === 'contradicted' && result.materialGaps[0].status === 'contradicted',
        'a grounded explicit conflict must remain contradicted throughout the returned audit');
      assert(result.adjustedScore === 84 && result.confidence.effective === 'high',
        'a fully grounded contradiction keeps normal score ceilings and may retain high evidence confidence');
      assert(result.reasoning.includes('conflicts with') && !result.reasoning.toLowerCase().includes('candidate lacks'),
        'contradiction reasoning must state the evidence conflict without translating it into a categorical absence claim');
      const ungrounded = validateAndNormalizeFitAssessment({
        score: 70,
        requirementAssessments: [requirement({
          requirement: 'Work authorization', priority: 'important', status: 'contradicted',
          jobEvidence: 'unrestricted work authorization', candidateEvidence: 'No sponsorship is needed',
        })],
      }, { jobText: contradictionJob, candidateText: contradictionCandidate });
      assert(ungrounded.requirementRows[0].effectiveStatus === 'unclear' && ungrounded.statusCounts.contradicted === 0,
        'an ungrounded contradicted claim must become unclear rather than manufacture a conflict');
      const disclosed = validateAndNormalizeFitAssessment({
        score: 90,
        confidence: 'high',
        requirementAssessments: [requirement({
          requirement: 'Role framing', priority: 'contextual', status: 'direct',
          jobEvidence: 'Requires', candidateEvidence: 'Available only evenings',
        })],
        materialGaps: [{
          requirementText: 'Daytime coverage', priority: 'important', status: 'contradicted',
          jobEvidence: 'daytime coverage', candidateEvidence: 'Available only evenings', impact: 'Schedule conflict.',
        }],
      }, { jobText: contradictionJob, candidateText: contradictionCandidate });
      assert(disclosed.materialGaps.length === 1 && disclosed.materialGaps[0].status === 'contradicted'
        && disclosed.requirementRows.find(row => row.requirement === 'Daytime coverage')?.candidateEvidence[0] === 'Available only evenings',
      'a separately disclosed contradiction must merge only when its candidate evidence is grounded');
      return { score: result.adjustedScore, confidence: result.confidence.effective };
    },
  },
  {
    name: 'Job fit assessment: one important not_documented requirement lowers confidence to medium',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        score: 70,
        confidence: 'high',
        requirementAssessments: [
          requirement({ requirement: 'API implementation', priority: 'important', status: 'direct', jobEvidence: 'engineer', candidateEvidence: 'maintained REST APIs' }),
          requirement({ requirement: 'Cloud platform', priority: 'important', status: 'not_documented', jobEvidence: 'production experience with a cloud platform', candidateEvidence: '' }),
        ],
      }, { jobText, candidateText });
      assert(result.confidence.effective === 'medium',
        'one grounded important not_documented requirement must lower otherwise high confidence to medium');
      return { confidence: result.confidence.effective };
    },
  },
  {
    name: 'Job fit assessment: malformed and legacy results stay compatible and visibly uncalibrated',
    run: () => {
      const legacy = validateAndNormalizeFitAssessment({ matchScore: 83, reasoning: 'Older result shape.' }, { jobText, candidateText });
      assert(legacy.rawScore === 83 && legacy.adjustedScore === 83 && legacy.auditStatus === 'legacy-unverified',
        'a legacy score must remain readable without pretending it has evidence coverage');
      assert(legacy.confidence.effective === 'unknown', 'legacy results must not inherit an unverified confidence label');
      const malformed = validateAndNormalizeFitAssessment(null, { jobText, candidateText });
      assert(malformed.rawScore === 0 && malformed.auditStatus === 'legacy-unverified' && malformed.warnings.length > 0,
        'malformed results must fail safely into a visible uncalibrated state');
      const clamped = validateAndNormalizeFitAssessment({ score: 999, requirements: [] }, { jobText, candidateText });
      assert(clamped.rawScore === 100 && clamped.adjustedScore === 100, 'scores must be clamped to the public 0-100 range');
      return { legacy: legacy.adjustedScore, malformed: malformed.adjustedScore };
    },
  },
  {
    name: 'Job fit calibration: two unclear critical gaps stop at 79 while the same two not_documented gaps reach 69',
    run: () => {
      const build = status => auditGaps([
        gapRow('Alpha ledger', 'critical', status, 'alpha ledger reconciliation'),
        gapRow('Bravo queue', 'critical', status, 'bravo queue tuning'),
      ]);
      const unclear = build('unclear');
      assert(unclear.requirementRows.every(row => row.effectiveStatus === 'unclear' && row.materialGap),
        'both rows must be grounded unclear material gaps for this case to be meaningful');
      assert(unclear.adjustedScore === 79, 'two unclear critical gaps must cap at 79, not 69');
      assert(unclear.adjustments[0].code === 'critical-gap', 'unclear-only critical gaps must use the critical-gap rule');
      assert(unclear.adjustments[0].reason.includes('counts toward the 79 ceiling but not the 69 ceiling'),
        'the reason must explain that inconclusive requirements do not reach the 69 ceiling');
      const hard = build('not_documented');
      assert(hard.adjustedScore === 69 && hard.adjustments[0].code === 'multiple-critical-gaps',
        'two distinct hard critical gaps must cap at 69 under multiple-critical-gaps');
      assert(!hard.adjustments[0].reason.includes('counts toward the 79 ceiling'),
        'hard-only gaps must not carry the inconclusive-requirement note');
    },
  },
  {
    name: 'Job fit calibration: nested posting quotes count once but both rows stay in the audit',
    run: () => {
      const result = auditGaps([
        gapRow('Ledger work', 'critical', 'not_documented', 'alpha ledger reconciliation'),
        gapRow('Reconciliation duty', 'critical', 'not_documented', 'ledger reconciliation'),
      ]);
      assert(result.requirementRows.every(row => row.grounding.requirementGrounded), 'both nested quotes must be grounded in the posting');
      assert(result.adjustedScore === 79 && result.adjustedScore !== 69, 'nested quotes are one requirement and must cap at 79, not 69');
      assert(result.adjustments[0].code === 'critical-gap', 'a single merged critical cluster must use the critical-gap rule');
      assert(result.mergedGapClusters.length === 1, 'exactly one merged cluster must be reported');
      assert(result.mergedGapClusters[0].ids.length === 2
        && result.mergedGapClusters[0].ids.includes('requirement-1') && result.mergedGapClusters[0].ids.includes('requirement-2'),
      'the merged cluster must contain both row ids');
      assert(result.reasoning.includes('counted once for calibration'),
        'reasoning must disclose that overlapping rows with different labels were counted once');
      assert(result.materialGaps.length === 2, 'merging must not drop either row from materialGaps');
      const distinct = auditGaps([
        gapRow('Ledger work', 'critical', 'not_documented', 'alpha ledger reconciliation'),
        gapRow('Queue work', 'critical', 'not_documented', 'bravo queue tuning'),
      ]);
      assert(distinct.mergedGapClusters.length === 0 && !distinct.reasoning.includes('counted once'),
        'unrelated rows must produce no merged clusters and no dedup clause');
    },
  },
  {
    name: 'Job fit calibration: label containment merges gap rows while unrelated labels stay distinct',
    run: () => {
      const merged = auditGaps([
        gapRow('Queue tuning', 'critical', 'not_documented', 'bravo queue tuning'),
        gapRow('Queue tuning experience', 'critical', 'not_documented', 'charlie fleet routing'),
      ]);
      assert(merged.adjustedScore === 79, 'rows whose labels nest must be counted once and cap at 79');
      assert(merged.mergedGapClusters.length === 1 && merged.mergedGapClusters[0].ids.length === 2,
        'the label-contained rows must form one two-row cluster');
      assert(merged.mergedGapClusters[0].requirements.length === 2, 'the cluster must list both distinct labels');
      const separate = auditGaps([
        gapRow('Queue tuning', 'critical', 'not_documented', 'bravo queue tuning'),
        gapRow('Fleet routing', 'critical', 'not_documented', 'charlie fleet routing'),
      ]);
      assert(separate.adjustedScore === 69 && separate.adjustments[0].code === 'multiple-critical-gaps',
        'rows with unrelated labels and non-nested quotes must count twice and cap at 69');
      assert(separate.mergedGapClusters.length === 0, 'unrelated rows must not be reported as merged');
    },
  },
  {
    name: 'Job fit calibration: duplicateOf links two gap rows when recalibrating an audit',
    run: () => {
      const audit = auditGaps([
        gapRow('Alpha ledger', 'critical', 'not_documented', 'alpha ledger reconciliation'),
        gapRow('Bravo queue', 'critical', 'not_documented', 'bravo queue tuning'),
      ]);
      assert(audit.adjustedScore === 69, 'precondition: two distinct hard critical gaps score 69');
      const [first, second] = audit.requirementRows;
      const linked = { ...audit, requirementRows: [first, { ...second, duplicateOf: first.id }] };
      const result = recalibrateAuditedFitAssessment(linked);
      assert(result !== null, 'a valid audited result must recalibrate');
      assert(result.adjustedScore === 79 && result.adjustments[0].code === 'critical-gap',
        'a duplicateOf link must make the two rows count once (79)');
      assert(result.mergedGapClusters.length === 1
        && result.mergedGapClusters[0].ids.length === 2
        && result.mergedGapClusters[0].ids.includes(first.id) && result.mergedGapClusters[0].ids.includes(second.id),
      'mergedGapClusters must list both linked row ids');
      assert(result.materialGaps.length === 2, 'duplicateOf linking must not remove either gap row');
      assert(audit.requirementRows[1].duplicateOf === undefined, 'the original audit must not be mutated');
    },
  },
  {
    name: 'Job fit calibration: adding gap rows of any kind never raises the adjusted score',
    run: () => {
      const base = () => [
        handRow('a', 'Alpha ledger', 'critical', 'not_documented', 'alpha ledger reconciliation'),
        handRow('b', 'Bravo queue', 'critical', 'unclear', 'bravo queue tuning'),
        handRow('c', 'Charlie fleet', 'important', 'not_documented', 'charlie fleet routing'),
        handRow('d', 'Delta kiosk', 'important', 'unclear', 'delta kiosk calibration'),
      ];
      const extras = [
        { name: 'distinct hard critical', rows: [handRow('e', 'Echo dock', 'critical', 'not_documented', 'echo dock planning')], expected: raw => Math.min(raw, 69) },
        { name: 'distinct unclear critical', rows: [handRow('e', 'Echo dock', 'critical', 'unclear', 'echo dock planning')], expected: raw => Math.min(raw, 79) },
        { name: 'exact duplicate quote', rows: [handRow('e', 'Ledger recheck', 'critical', 'not_documented', 'alpha ledger reconciliation')], expected: raw => Math.min(raw, 79) },
        { name: 'nested quote', rows: [handRow('e', 'Reconciliation', 'critical', 'not_documented', 'ledger reconciliation')], expected: raw => Math.min(raw, 79) },
        {
          name: 'two more hard important',
          rows: [
            handRow('e', 'Echo dock', 'important', 'not_documented', 'echo dock planning'),
            handRow('f', 'Foxtrot badge', 'important', 'not_documented', 'foxtrot badge printing'),
          ],
          expected: raw => Math.min(raw, 69),
        },
      ];
      let strictlyLowered = 0;
      for (const raw of [69, 70, 79, 80, 85, 100]) {
        const baseScore = calibrateGroundedJobRequirements(raw, base()).adjustedScore;
        assert(baseScore === Math.min(raw, 79), `base set at raw ${raw} must score ${Math.min(raw, 79)} (got ${baseScore})`);
        for (const extra of extras) {
          const score = calibrateGroundedJobRequirements(raw, [...base(), ...extra.rows]).adjustedScore;
          assert(score <= baseScore, `adding ${extra.name} at raw ${raw} must not raise ${baseScore} (got ${score})`);
          assert(score === extra.expected(raw), `adding ${extra.name} at raw ${raw} must give ${extra.expected(raw)} (got ${score})`);
          if (score < baseScore) strictlyLowered += 1;
        }
      }
      assert(strictlyLowered > 0, 'at least one added distinct hard row must strictly lower a score, proving the comparison is not vacuous');
    },
  },
  {
    name: 'Job fit calibration: recalibrating an audit rebuilds every derived view from corrected rows',
    run: () => {
      const audit = auditGaps([
        gapRow('Alpha ledger', 'critical', 'not_documented', 'alpha ledger reconciliation'),
        gapRow('Bravo queue', 'critical', 'not_documented', 'bravo queue tuning'),
      ]);
      assert(audit.adjustedScore === 69 && audit.statusCounts.direct === 0, 'precondition: two hard critical gaps and no direct rows');
      const [first, second] = audit.requirementRows;
      const corrected = {
        ...audit,
        requirementRows: [first, {
          ...second,
          effectiveStatus: 'direct',
          candidateEvidence: ['maintained REST APIs'],
          grounding: { ...second.grounding, candidateClaimGrounded: true },
        }],
      };
      const result = recalibrateAuditedFitAssessment(corrected);
      assert(result.adjustedScore === 79 && result.adjustments[0].code === 'critical-gap', 'one remaining critical gap must cap at 79');
      assert(result.materialGaps.length === 1 && result.materialGaps[0].id === first.id, 'only the uncorrected row may remain a material gap');
      assert(result.requirementRows[1].materialGap === false, 'the corrected row must no longer be flagged as a gap');
      assert(result.strengths.some(row => row.id === second.id), 'the corrected direct row must appear in strengths');
      assert(result.statusCounts.direct === audit.statusCounts.direct + 1
        && result.statusCounts.not_documented === audit.statusCounts.not_documented - 1,
      'statusCounts must move one row from not_documented to direct');
      assert(result.calibrationVersion === 3, 'recalibrated audits must carry calibration version 3');
      assert(result.rawScore === audit.rawScore, 'the raw score must not be touched');
      assert(audit.requirementRows[1].effectiveStatus === 'not_documented', 'the original audit must not be mutated');
      const untouched = recalibrateAuditedFitAssessment(audit);
      assert(untouched.requirementRows === audit.requirementRows, 'an unchanged audit must keep its requirementRows reference');
      assert(untouched.confidence === audit.confidence, 'an unchanged audit must keep its confidence reference');
      assert(untouched.adjustedScore === 69, 'an unchanged audit must recalibrate to the same score');
      const legacy = validateAndNormalizeFitAssessment({ matchScore: 83 }, { jobText: gapJobText, candidateText });
      assert(legacy.auditStatus === 'legacy-unverified' && recalibrateAuditedFitAssessment(legacy) === null,
        'a legacy-unverified audit must not be recalibrated');
      assert(recalibrateAuditedFitAssessment({ ...audit, requirementRows: [] }) === null, 'an audit without rows is malformed and must return null');
      assert(recalibrateAuditedFitAssessment(null) === null, 'a missing audit must return null');
    },
  },
  {
    name: 'Job fit tenure: year-only dates make a threshold-meeting claim unclear and the score stops at 79',
    run: () => {
      const tenureRoles = [{ id: 'y', start: '2019', end: '2021' }];
      const build = extraRows => validateAndNormalizeFitAssessment({
        score: 95,
        requirementAssessments: [
          requirement({
            requirement: 'Three years of ledger work', priority: 'critical', status: 'direct',
            jobEvidence: 'three years of ledger reconciliation', candidateEvidence: 'maintained REST APIs',
          }),
          ...extraRows,
        ],
        experienceAssessment: {
          categorySpecificExperience: [{
            category: 'Ledger work', requiredMinimumYears: 3, roleIds: ['y'], years: '3 years',
            candidateEvidence: 'maintained REST APIs', jobEvidence: 'three years of ledger reconciliation', explanation: '',
          }],
        },
      }, { jobText: tenureJobText, candidateText, candidateRoles: tenureRoles, asOf: NOW });
      const result = build([]);
      const tenure = result.experience.categorySpecificExperience[0].tenure;
      assert(tenure.maxYears === 3 && tenure.minYears === 1, `year-only 2019-2021 must measure 1-3 years (got ${tenure.minYears}-${tenure.maxYears})`);
      const row = result.requirementRows[0];
      assert(row.effectiveStatus === 'unclear' && row.reportedStatus === 'direct', 'a direct claim that only the upper bound proves must become unclear');
      assert(row.datedTenure.disposition === 'threshold-uncertain' && row.datedTenure.basis === 'selected-roles',
        'the disposition must be threshold-uncertain on selected roles');
      assert(row.materialGap === true, 'the unclear row must be a material gap');
      const withHard = build([requirement({
        requirement: 'Bravo queue tuning', priority: 'critical', status: 'not_documented',
        jobEvidence: 'bravo queue tuning', candidateEvidence: '',
      })]);
      assert(withHard.adjustedScore === 79 && withHard.adjustedScore !== 69,
        'one unclear plus one hard critical cluster must stop at 79, not 69');
      assert(withHard.adjustments[0].code === 'critical-gap'
        && withHard.adjustments[0].reason.includes('counts toward the 79 ceiling but not the 69 ceiling'),
      'the critical-gap reason must note the unclear cluster');
    },
  },
  {
    name: 'Job fit tenure: a shortfall of at most half a year is adjacent, not a gap, and applies the 84 critical-adjacent cap',
    run: () => {
      const result = validateAndNormalizeFitAssessment({
        score: 95,
        requirementAssessments: [requirement({
          requirement: 'Four years of software development', priority: 'critical', status: 'direct',
          jobEvidence: 'four years of software development', candidateEvidence: 'Built React and Django applications',
        })],
        experienceAssessment: {
          categorySpecificExperience: [{
            category: 'Software development', requiredMinimumYears: 3.5, roleIds: ['n'], years: '3.5 years',
            candidateEvidence: 'Built React and Django applications', jobEvidence: 'four years of software development', explanation: '',
          }],
        },
      }, { jobText, candidateText, candidateRoles: [{ id: 'n', start: 'March 2021', end: 'April 2024' }], asOf: NOW });
      const category = result.experience.categorySpecificExperience[0];
      assert(category.shortfallYears > 0 && category.shortfallYears <= 0.5,
        `the measured shortfall must be positive and at most 0.5 years (got ${category.shortfallYears})`);
      const row = result.requirementRows[0];
      assert(row.effectiveStatus === 'adjacent' && row.datedTenure.disposition === 'near-shortfall',
        'a near shortfall must become adjacent with disposition near-shortfall');
      assert(row.materialGap === false && result.materialGaps.length === 0, 'a near shortfall must not be a material gap');
      assert(result.adjustedScore === 84, 'the critical-adjacent ceiling must cap at 84');
      assert(result.adjustments.some(item => item.code === 'critical-adjacent'), 'adjustments must record the critical-adjacent code');
      assert(!result.adjustments.some(item => item.code === 'material-gap'), 'no material-gap cap may apply to an adjacent row');
    },
  },
  {
    name: 'Job fit tenure: an unscoped whole-career ceiling refutes an unreachable minimum but never confirms a reachable one',
    run: () => {
      const tenureRoles = [{ id: 'y', start: '2019', end: '2021' }];
      const build = (minimum, quote, label) => validateAndNormalizeFitAssessment({
        score: 95,
        requirementAssessments: [requirement({
          requirement: label, priority: 'critical', status: 'direct',
          jobEvidence: quote, candidateEvidence: 'maintained REST APIs',
        })],
        experienceAssessment: {
          categorySpecificExperience: [{
            category: label, requiredMinimumYears: minimum, roleIds: ['ghost'], years: `${minimum} years`,
            candidateEvidence: 'maintained REST APIs', jobEvidence: quote, explanation: '',
          }],
        },
      }, { jobText: tenureJobText, candidateText, candidateRoles: tenureRoles, asOf: NOW });
      const refuted = build(5, 'five years of kiosk calibration', 'Kiosk calibration');
      const refutedRow = refuted.requirementRows[0];
      assert(refutedRow.effectiveStatus === 'not_documented' && refutedRow.datedTenure.disposition === 'shortfall',
        'a minimum above the whole dated career must demote the row to not_documented');
      assert(refutedRow.datedTenure.basis === 'all-dated-roles', 'the basis must show the whole-career ceiling was used');
      assert(refutedRow.materialGap === true, 'the refuted row must be a material gap');
      const reachable = build(3, 'three years of ledger reconciliation', 'Ledger reconciliation');
      const reachableRow = reachable.requirementRows[0];
      assert(reachableRow.datedTenure === undefined, 'a reachable minimum under an unscoped ceiling must add no datedTenure field');
      assert(reachableRow.effectiveStatus === 'direct' && reachableRow.materialGap === false,
        'a reachable unscoped minimum must leave the direct row unchanged');
      assert(reachable.adjustedScore === 95 && reachable.adjustments.length === 0, 'an unchanged direct row must not trigger any cap');
    },
  },
  {
    name: 'Job fit tenure: overlapping roles are unioned and an open end runs to asOf',
    run: () => {
      const overlapping = calculateDatedTenure([
        { id: 'one', start: 'January 2020', end: 'December 2021' },
        { id: 'two', start: 'June 2021', end: 'June 2023' },
      ], { asOf: NOW });
      assert(overlapping.roleCount === 2, 'both roles must be counted as usable');
      assert(overlapping.maxMonths === 42, `the union of the two roles must span 42 months at most, not the 49-month sum (got ${overlapping.maxMonths})`);
      assert(overlapping.minMonths === 40, `the union must span at least 40 months, not the 45-month sum (got ${overlapping.minMonths})`);
      const open = calculateDatedTenure([{ id: 'now', start: 'January 2024', end: 'Present' }], { asOf: NOW });
      assert(open.minMonths === 30 && open.maxMonths === 32, `an open role to 2026-08-01 must be 30-32 months (got ${open.minMonths}-${open.maxMonths})`);
      assert(open.minMonths < open.maxMonths && open.exact === false, 'an open end must stay a bounded range, not an exact value');
      const later = calculateDatedTenure([{ id: 'now', start: 'January 2024', end: 'Present' }], { asOf: new Date(Date.UTC(2027, 7, 1)) });
      assert(later.maxMonths === open.maxMonths + 12, 'moving asOf by twelve months must extend the open role by twelve months');
      const yearOnly = calculateDatedTenure([{ id: 'y', start: '2023', end: '2025' }], { asOf: NOW });
      assert(yearOnly.minMonths === 12 && yearOnly.maxMonths === 36, `year-only 2023-2025 must be 12-36 months (got ${yearOnly.minMonths}-${yearOnly.maxMonths})`);
      const monthPrecise = calculateDatedTenure([{ id: 'm', start: 'March 2021', end: 'April 2024' }], { asOf: NOW });
      assert(monthPrecise.minMonths === 36 && monthPrecise.maxMonths === 38, `March 2021-April 2024 must be 36-38 months (got ${monthPrecise.minMonths}-${monthPrecise.maxMonths})`);
    },
  },
];
