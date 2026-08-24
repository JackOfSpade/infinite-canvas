import { assert, calculateDatedTenure, validateAndNormalizeFitAssessment } from '../test-dependencies.js';

const jobText = `
We need an engineer to lead cloud platform architecture. Candidates must have
four years of software development and production experience with a cloud
platform. GraphQL experience is a preferred qualification.
`;
const candidateText = `
Built React and Django applications, maintained REST APIs, and migrated a
district operations portal. Evaluated AI-assisted engineering workflows.
`;
const roles = [
  { id: 'district', start: 'May 2023', end: 'June 2026' },
  { id: 'health', start: 'October 2022', end: 'January 2023' },
];

function requirement({ requirement, priority, status, jobEvidence, candidateEvidence }) {
  return { requirementText: requirement, priority, status, jobEvidence, candidateEvidence };
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
      assert(result.rawScore === 92 && result.adjustedScore === 69, 'two grounded critical documentation gaps must cap score at 69');
      assert(result.scoreInterpretation === 'hiring-fit-not-probability', 'the public score must not masquerade as a statistically calibrated hiring forecast');
      assert(result.requirementRows[0].effectiveStatus === 'unclear', 'unsupported direct candidate claim must downgrade to unclear');
      assert(result.materialGaps.length === 2, 'preferred-only gap must not become a material gap');
      assert(result.confidence.reported === 'high' && result.confidence.effective === 'low' && result.confidence.groundedRequirementCount === 3,
        'multiple critical not_documented requirements must reduce confidence to low while retaining the rejected-evidence audit value');
      assert(result.adjustments[0].code === 'multiple-critical-gaps', 'audit must state the exact calibration rule');
      assert(result.reasoning.includes('calibrated from 92 to 69') && !result.reasoning.includes('AWS deployments'),
        'user-facing reasoning must expose the calibration without repeating rejected claims');
      return { score: result.adjustedScore, gaps: result.materialGaps.length };
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
    name: 'Job fit assessment: every grounded material gap blocks 85+, with stronger ceilings for repeated important gaps',
    run: () => {
      const calibrationJob = 'Requires data modeling, incident response, and distributed systems operations.';
      const rows = [
        requirement({ requirement: 'Data modeling', priority: 'important', status: 'missing', jobEvidence: 'data modeling', candidateEvidence: '' }),
        requirement({ requirement: 'Incident response', priority: 'important', status: 'unclear', jobEvidence: 'incident response', candidateEvidence: '' }),
        requirement({ requirement: 'Distributed systems operations', priority: 'important', status: 'missing', jobEvidence: 'distributed systems operations', candidateEvidence: '' }),
      ];
      const one = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows.slice(0, 1) }, { jobText: calibrationJob, candidateText });
      const two = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows.slice(0, 2) }, { jobText: calibrationJob, candidateText });
      const three = validateAndNormalizeFitAssessment({ score: 96, requirementAssessments: rows }, { jobText: calibrationJob, candidateText });
      assert(one.adjustedScore === 84 && one.adjustments[0].code === 'material-gap', 'one grounded important gap must block 85+');
      assert(two.adjustedScore === 79 && two.adjustments[0].code === 'multiple-important-gaps', 'two grounded important gaps need a transparent 79 ceiling');
      assert(three.adjustedScore === 69 && three.adjustments[0].code === 'multiple-important-gaps', 'three grounded important gaps need a transparent 69 ceiling');
      return { one: one.adjustedScore, two: two.adjustedScore, three: three.adjustedScore };
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
      const exact = calculateDatedTenure([{ start: 'May 2023', end: 'June 2026' }]);
      assert(!exact.exact && exact.minMonths === 36 && exact.maxMonths === 38 && exact.minYears === 3,
        'month-precise tenure should preserve omitted day-of-month uncertainty');
      const uncertain = calculateDatedTenure([{ start: '2023', end: '2025' }]);
      assert(!uncertain.exact && uncertain.minMonths === 12 && uncertain.maxMonths === 36, 'year-only dates must retain a possible tenure range');
      const dateRange = calculateDatedTenure([{ dates: '2023-05-01 – 2026-06-30' }]);
      assert(dateRange.roleCount === 1 && dateRange.minMonths === 36 && dateRange.maxMonths === 38,
        'a parsable date-range field must contribute bounded tenure without assuming its days');
      const result = validateAndNormalizeFitAssessment({
        score: 70,
        experienceAssessment: {
          totalProfessionalExperience: { years: '3+ years', candidateEvidence: 'Built React and Django applications', explanation: 'Dated roles supplied.' },
          categorySpecificExperience: [
            {
              category: 'Software development', requiredMinimumYears: 3.5, roleIds: ['district'], years: '3.1 years',
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
            category: 'Software development', requiredMinimumYears: 4, roleIds: ['district'], years: '4 years',
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
      const absenceJob = 'Requires platform operations, release engineering, security review, and incident response.';
      const labels = ['missing', 'absent', 'no support', 'no supporting evidence', 'not supported', 'unsupported', 'not established', 'unmet'];
      const result = validateAndNormalizeFitAssessment({
        score: 96,
        confidence: 'high',
        requirementAssessments: labels.map((status, index) => requirement({
          requirement: `Requirement ${index + 1}`,
          priority: 'important',
          status,
          jobEvidence: ['platform operations', 'release engineering', 'security review', 'incident response'][index % 4],
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
];
