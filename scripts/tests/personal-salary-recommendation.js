import assert from 'node:assert/strict';
import {
  buildPersonalSalaryEvidence,
  normalizePersonalSalaryRecommendation,
  personalSalaryEvidenceFingerprint,
  PERSONAL_SALARY_GUIDANCE_PROMPT,
  validatePersonalSalaryRecommendation,
} from '../../electron/ipc/personalSalaryRecommendation.js';

const SNAPSHOT = 'a'.repeat(64);
const CAREER = `Built production cloud APIs and reduced support incidents by 30%.
Led a migration of a cloud platform. Created documentation for internal tools.
Engineer, January 2021 to December 2023. Engineer, January 2022 to December 2023.
Earlier accounting role, January 2010 to December 2020.
Citizen of Canada; willing to relocate. Age 35.`;
const POSTING = 'Requires three years of cloud platform experience. Build production cloud APIs. Lead a platform migration. Preferred GraphQL experience. Work authorization required. Age 30 preferred.';
const PROFILE = {
  workHistory: [
    { id: 'cloud-one', title: 'Engineer', start: 'January 2021', end: 'December 2023' },
    { id: 'cloud-overlap', title: 'Engineer', start: 'January 2022', end: 'December 2023' },
    { id: 'unrelated', title: 'Accountant', start: 'January 2010', end: 'December 2020' },
  ],
};
const MARKET = { min: 100000, max: 200000, currency: 'CAD', period: 'annual' };

function row(overrides = {}) {
  return {
    id: 'api', requirement: 'Production APIs', effectiveStatus: 'direct', scoreImpact: 'scored',
    jobEvidence: ['Build production cloud APIs'],
    candidateEvidence: ['Built production cloud APIs and reduced support incidents by 30%.'],
    grounding: { requirementGrounded: true, candidateClaimGrounded: true },
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    snippet: POSTING,
    fitAssessment: {
      schemaVersion: 1,
      auditStatus: 'audited',
      requirementRows: [row()],
      experience: {
        categorySpecificExperience: [{
          category: 'Cloud platform experience',
          requiredMinimumYears: 3,
          roleIds: ['cloud-one', 'cloud-overlap'],
          candidateEvidence: ['Led a migration of a cloud platform.'],
          jobEvidence: ['Requires three years of cloud platform experience'],
          candidateEvidenceGrounded: true,
          jobEvidenceGrounded: true,
          tenure: { minYears: 99, maxYears: 99 },
          reportedYears: '99 years',
        }],
      },
    },
    ...overrides,
  };
}

function packet(jobValue = job(), options = {}) {
  return buildPersonalSalaryEvidence(jobValue, { careerData: CAREER, profile: PROFILE, careerSnapshotId: SNAPSHOT, ...options });
}

function answer(overrides = {}) {
  return {
    status: 'personalized', min: 110000, max: 130000, desiredSalary: 125000,
    currency: 'CAD', confidence: 'medium',
    explanation: 'The documented cloud APIs and migration work support this suggested application range.',
    limitations: ['Salary data remains broad across employers.'], evidenceIds: ['requirement-1'],
    ...overrides,
  };
}

export default [
  {
    name: 'Personal salary evidence requires audited rows and rechecks host career and job quotes',
    run: () => {
      assert.equal(packet().evidence.length, 1);
      assert.deepEqual(packet(job(), { careerData: undefined }).evidence, []);
      assert.deepEqual(packet({ ...job(), fitAssessment: { ...job().fitAssessment, auditStatus: 'legacy-unverified' } }).evidence, []);
      const fabricated = job();
      fabricated.fitAssessment.requirementRows = [
        row({ candidateEvidence: ['Led a team of 50 engineers.'] }),
        row({ jobEvidence: ['Requires a doctorate in cloud computing'] }),
        row({ candidateEvidence: ['Built production cloud APIs and reduced support incidents by 30%.', 'Invented accomplishment'] }),
      ];
      fabricated.fitAssessment.experience = {};
      assert.deepEqual(packet(fabricated).evidence, [], 'renderer grounding flags must never authorize invented quotes');
      assert.deepEqual(packet(fabricated).experience, []);
      const current = packet();
      assert.equal(current.careerSnapshotId, SNAPSHOT);
      assert.equal(current.evidence[0].candidateQuote, 'Built production cloud APIs and reduced support incidents by 30%.');
      assert.ok(!JSON.stringify(current).includes('Earlier accounting role'), 'raw career/profile fields must not leak into the evidence packet');
    },
  },
  {
    name: 'Personal salary tenure recomputes relevant mapped roles without overlap or total-career substitution',
    run: () => {
      const current = packet();
      assert.equal(current.experience.length, 1);
      const experience = current.experience[0];
      assert.ok(experience.tenure.maxYears <= 3, 'overlapping engineering roles must not double count tenure');
      assert.ok(experience.tenure.minYears > 2.5);
      assert.equal(experience.tenure.roleCount, 2);
      assert.equal(experience.requiredMinimumYears, 3, 'the stated three-year requirement is retained only when verified in the job quote');
      assert.equal(experience.tenure.basis, 'host-recomputed-selected-role-periods');
      assert.ok(!experience.roleIds.includes('unrelated'), 'unrelated decade of work must not become relevant experience');
      assert.ok(!JSON.stringify(experience).includes('99'), 'persisted reported/model-calculated years must not become facts');
      const unknownRole = job();
      unknownRole.fitAssessment.experience.categorySpecificExperience[0].roleIds.push('invented-id');
      assert.deepEqual(packet(unknownRole).experience, [], 'partially resolved role mappings must be withheld');
      const noDates = { workHistory: PROFILE.workHistory.map(role => ({ id: role.id })) };
      assert.deepEqual(packet(job(), { profile: noDates }).experience, [], 'undated profiles must not manufacture tenure');
      const inflatedRequirement = job();
      inflatedRequirement.fitAssessment.experience.categorySpecificExperience[0].requiredMinimumYears = 8;
      assert.equal(packet(inflatedRequirement).experience[0].requiredMinimumYears, null, 'an invented requirement number cannot enter the salary packet');
    },
  },
  {
    name: 'Personal salary evidence excludes logistics and sensitive proxies and preserves documentation gaps honestly',
    run: () => {
      const currentJob = job();
      currentJob.fitAssessment.requirementRows = [
        row({ requirement: 'Authorization', jobEvidence: ['Work authorization required'], candidateEvidence: ['Citizen of Canada'] }),
        row({ requirement: 'Applicant age', jobEvidence: ['Age 30 preferred'], candidateEvidence: ['Age 35'] }),
        row({ requirement: 'GraphQL experience', effectiveStatus: 'not_documented', jobEvidence: ['Preferred GraphQL experience'], candidateEvidence: [] }),
        row({ scoreImpact: 'informational' }),
      ];
      currentJob.fitAssessment.experience = {};
      const current = packet(currentJob);
      assert.equal(current.evidence.length, 1);
      assert.equal(current.evidence[0].status, 'not_documented');
      assert.equal(current.evidence[0].candidateQuote, '');
      assert.match(current.evidence[0].limitation, /does not establish absence/);
      const fallback = normalizePersonalSalaryRecommendation(undefined, { marketRange: MARKET, evidence: current });
      assert.equal(fallback.status, 'market_estimate', 'a documentation gap alone is not a personal career fact');
      assert.throws(() => validatePersonalSalaryRecommendation(answer(), { marketRange: MARKET, evidence: current }), /host-verified career fact/);
      for (const status of ['not_documented', 'unclear']) {
        const uncertainJob = job();
        uncertainJob.fitAssessment.requirementRows = [row({ effectiveStatus: status })];
        uncertainJob.fitAssessment.experience = {};
        const uncertain = packet(uncertainJob);
        assert.ok(uncertain.evidence[0].candidateQuote, 'this fixture has a real verified quotation but an unresolved relationship');
        assert.equal(normalizePersonalSalaryRecommendation(undefined, { marketRange: MARKET, evidence: uncertain }).status, 'market_estimate');
        assert.throws(() => validatePersonalSalaryRecommendation(answer(), { marketRange: MARKET, evidence: uncertain }), /host-verified career fact/);
      }
      const mixed = { ...packet(), evidence: [...packet().evidence, { ...current.evidence[0], id: 'documentation-gap' }] };
      assert.equal(normalizePersonalSalaryRecommendation(answer({ evidenceIds: ['requirement-1', 'documentation-gap'] }), { marketRange: MARKET, evidence: mixed }).status, 'personalized', 'a gap can be cited alongside an actual supported career fact');
    },
  },
  {
    name: 'Personal salary output validates market bounds, currency, cited evidence and desired salary',
    run: () => {
      const options = { marketRange: MARKET, evidence: packet(), researchedAt: '2026-10-24T00:00:00.000Z' };
      const normalized = normalizePersonalSalaryRecommendation(answer(), options);
      assert.equal(normalized.status, 'personalized');
      assert.deepEqual(normalized.range, { min: 110000, max: 130000, currency: 'CAD', period: 'annual' });
      assert.equal(normalized.desiredSalary, 125000);
      assert.equal(normalized.careerSnapshotId, SNAPSHOT);
      assert.equal(normalized.methodologyVersion, 3, 'the advertised-midpoint ceiling is a new methodology version');
      assert.equal(normalized.researchedAt, options.researchedAt);
      assert.equal(normalizePersonalSalaryRecommendation(answer({ evidenceIds: ['experience-1'] }), options).status, 'personalized', 'host-recomputed category tenure can independently support positioning');
      for (const invalid of [
        { min: 140000, max: 130000 },
        { desiredSalary: 150000 }, { desiredSalary: Number.NaN }, { desiredSalary: '125000' },
        { currency: 'USD' }, { min: Number.POSITIVE_INFINITY },
        { evidenceIds: [] }, { evidenceIds: ['invented-evidence'] },
        { evidenceIds: ['requirement-1', 'invented-evidence'] }, { evidenceIds: ['requirement-1', 'requirement-1'] },
      ]) {
        const raw = answer(invalid);
        assert.throws(() => validatePersonalSalaryRecommendation(raw, options), error => error.code === 'PERSONAL_SALARY_RECOMMENDATION_INVALID');
        assert.equal(normalizePersonalSalaryRecommendation(raw, options).status, 'unavailable', JSON.stringify(invalid));
        assert.equal(normalizePersonalSalaryRecommendation(raw, options).desiredSalary, null);
      }
      // The host owns the bounds, so a range that oversteps them is fitted
      // instead of being thrown away.
      const belowFloor = answer({ min: 90000 });
      assert.doesNotThrow(() => validatePersonalSalaryRecommendation(belowFloor, options));
      const fittedMin = normalizePersonalSalaryRecommendation(belowFloor, options);
      assert.equal(fittedMin.status, 'personalized');
      assert.deepEqual(fittedMin.range, { min: 100000, max: 130000, currency: 'CAD', period: 'annual' },
        'a floor below the bounds is raised to the bounds minimum');
      assert.equal(fittedMin.desiredSalary, 125000, 'an in-range desired salary is not moved by fitting the floor');
      assert.ok(fittedMin.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      assert.equal('boundsAdjusted' in fittedMin, false, 'the saved answer does not expose the fitting flag');
      const aboveCeiling = answer({ max: 210000 });
      assert.doesNotThrow(() => validatePersonalSalaryRecommendation(aboveCeiling, options));
      const fittedMax = normalizePersonalSalaryRecommendation(aboveCeiling, options);
      assert.equal(fittedMax.status, 'personalized');
      assert.deepEqual(fittedMax.range, { min: 110000, max: 200000, currency: 'CAD', period: 'annual' },
        'a ceiling above the bounds is lowered to the bounds maximum');
      assert.equal(fittedMax.desiredSalary, 125000);
      assert.ok(fittedMax.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      assert.equal(validatePersonalSalaryRecommendation(answer(), options).boundsAdjusted, undefined,
        'an answer already inside the bounds is unchanged');
      const whollyAbove = normalizePersonalSalaryRecommendation(answer({ min: 210000, max: 230000, desiredSalary: 220000 }), options);
      assert.equal(whollyAbove.status, 'personalized');
      assert.deepEqual(whollyAbove.range, { min: MARKET.max, max: MARKET.max, currency: 'CAD', period: 'annual' },
        'a range wholly above the bounds collapses onto the bounds maximum');
      assert.equal(whollyAbove.desiredSalary, MARKET.max);
      assert.ok(whollyAbove.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      assert.throws(() => validatePersonalSalaryRecommendation(answer(), { ...options, marketRange: { ...MARKET, period: 'hourly' } }), /annual researched market range/);
      assert.throws(() => validatePersonalSalaryRecommendation(answer(), { ...options, evidence: { ...packet(), careerSnapshotId: '' } }), /pinned approved career snapshot/);
    },
  },
  {
    name: 'Personal salary fallback gives a rounded midpoint only for an honest full-market estimate',
    run: () => {
      const empty = packet(job(), { careerData: '' });
      const options = { marketRange: MARKET, evidence: empty, offered: { usable: true, min: 60000, max: 90000, currency: 'CAD', period: 'annual' } };
      const fallback = normalizePersonalSalaryRecommendation(undefined, options);
      assert.equal(fallback.status, 'market_estimate');
      assert.equal(fallback.confidence, 'low');
      assert.deepEqual(fallback.range, MARKET);
      assert.equal(fallback.desiredSalary, 150000, 'a low advertised band must not lower the desired market salary');
      assert.match(fallback.explanation, /market midpoint/);
      assert.ok(fallback.limitations.some(value => /advertised salary is below/.test(value)));
      const declared = answer({ status: 'market_estimate', ...MARKET, desiredSalary: 100000, evidenceIds: [], confidence: 'low' });
      assert.equal(normalizePersonalSalaryRecommendation(declared, options).desiredSalary, 150000, 'market-only answers use a deterministic midpoint');
      const narrowed = normalizePersonalSalaryRecommendation({ ...declared, max: 130000 }, options);
      assert.equal(narrowed.status, 'market_estimate', 'a model range narrower than the bounds is rebuilt, not rejected');
      assert.deepEqual(narrowed.range, MARKET);
      assert.equal(narrowed.desiredSalary, 150000);
      assert.throws(() => validatePersonalSalaryRecommendation({ ...declared, evidenceIds: ['requirement-1'] }, { ...options, evidence: packet() }), /market estimate/,
        'a market estimate must still refuse personal citations');
      assert.throws(() => validatePersonalSalaryRecommendation({ ...declared, confidence: 'medium' }, options), /market estimate/,
        'a market estimate keeps low confidence');
      assert.equal(normalizePersonalSalaryRecommendation(undefined, { ...options, evidence: packet() }).status, 'unavailable', 'existing career evidence requires a fresh personal assessment');
      assert.equal(normalizePersonalSalaryRecommendation(undefined, { evidence: empty }).status, 'unavailable');
      assert.equal(normalizePersonalSalaryRecommendation(undefined, { ...options, marketRange: { ...MARKET, min: 102100, max: 102300 } }).desiredSalary, 102200, 'narrow published bands must not be rounded outside their bounds');
      assert.equal(normalizePersonalSalaryRecommendation(undefined, { ...options, marketRange: { ...MARKET, min: 107500, max: 107500 } }).desiredSalary, 107500);
    },
  },
  {
    name: 'Personal salary targets respect the advertised minimum without capping justified asks at its maximum',
    run: () => {
      const offered = { usable: true, min: 160000, max: 190000, currency: 'CAD', period: 'annual' };
      const options = { marketRange: MARKET, evidence: packet(), offered };
      const raisedFloor = normalizePersonalSalaryRecommendation(answer({ min: 140000, max: 180000, desiredSalary: 150000 }), options);
      assert.equal(raisedFloor.status, 'personalized');
      assert.deepEqual(raisedFloor.range, { min: 160000, max: 180000, currency: 'CAD', period: 'annual' },
        'the advertised floor raises a suggested minimum below it');
      assert.equal(raisedFloor.desiredSalary, 160000, 'a desired salary below the fitted floor is raised with it');
      assert.ok(raisedFloor.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      assert.equal(normalizePersonalSalaryRecommendation(answer({ min: 160000, max: 180000, desiredSalary: 170000 }), options).status, 'personalized');
      const general = normalizePersonalSalaryRecommendation(undefined, { ...options, evidence: packet(job(), { careerData: '' }) });
      assert.deepEqual(general.range, { ...MARKET, min: 160000 }, 'the estimate range starts at the employer floor; the researched market range is kept separately on the assessment');
      assert.equal(general.desiredSalary, 180000, 'the market estimate uses the market interval above the employer floor');
      assert.match(general.explanation, /employer’s advertised minimum/);
      const limitedBudget = { ...offered, min: 100000, max: 120000 };
      const higherAsk = normalizePersonalSalaryRecommendation(answer({ min: 140000, max: 165000, desiredSalary: 150000, limitations: ['One', 'Two', 'Three'] }), { ...options, offered: limitedBudget });
      assert.equal(higherAsk.status, 'personalized');
      assert.equal(higherAsk.desiredSalary, 150000, 'the employer maximum cannot silently lower a supported personal target');
      assert.equal(higherAsk.limitations.length, 3);
      assert.ok(higherAsk.limitations.some(value => /exceeds the advertised maximum/.test(value)));
      const foreignCurrency = normalizePersonalSalaryRecommendation(answer(), { ...options, offered: { ...offered, currency: 'USD' } });
      assert.equal(foreignCurrency.status, 'personalized');
      assert.equal(foreignCurrency.desiredSalary, 125000, 'unrelated currencies cannot establish an advertised floor');
      const foreignGeneral = normalizePersonalSalaryRecommendation(undefined, { ...options, offered: { ...offered, currency: 'USD' }, evidence: packet(job(), { careerData: '' }) });
      assert.equal(foreignGeneral.desiredSalary, 150000);
      assert.equal(normalizePersonalSalaryRecommendation(answer(), { ...options, offered: { ...offered, usable: false } }).status, 'personalized', 'an unusable salary must not constrain the application target');
    },
  },
  {
    name: 'Personal salary evidence fingerprints change with grounded career facts and snapshot identity',
    run: () => {
      const current = packet();
      assert.equal(personalSalaryEvidenceFingerprint(current), personalSalaryEvidenceFingerprint(packet()));
      assert.notEqual(personalSalaryEvidenceFingerprint(current), personalSalaryEvidenceFingerprint({ ...current, careerSnapshotId: 'b'.repeat(64) }));
      assert.notEqual(personalSalaryEvidenceFingerprint(current), personalSalaryEvidenceFingerprint({ ...current, evidence: [] }));
    },
  },
  {
    name: 'Personal salary answers cannot stop below the midpoint of the employer’s own advertised band',
    run: () => {
      assert.match(PERSONAL_SALARY_GUIDANCE_PROMPT, /the upper bound is at least the advertised midpoint/,
        'the model must be told the advertised midpoint raises the ceiling');
      assert.match(PERSONAL_SALARY_GUIDANCE_PROMPT, /below the employer's advertised midpoint needs a stated evidence-based reason/,
        'the model must justify an ask under the advertised midpoint');
      const market = { min: 25000, max: 55000, currency: 'CAD', period: 'annual' };
      const options = { marketRange: market, evidence: packet(), offered: { usable: true, min: 48000, max: 72000, currency: 'CAD', period: 'annual' } };
      // The advertised midpoint (CAD 60,000) is above the researched maximum
      // (CAD 55,000), so the ceiling rises to the advertisement.
      const fittedCeiling = normalizePersonalSalaryRecommendation(answer({ min: 50000, max: 64000, desiredSalary: 62000 }), options);
      assert.equal(fittedCeiling.status, 'personalized');
      assert.deepEqual(fittedCeiling.range, { min: 50000, max: 60000, currency: 'CAD', period: 'annual' },
        'the fitted ceiling stops at the advertised midpoint');
      assert.equal(fittedCeiling.desiredSalary, 60000, 'the desired salary is fitted with the range');
      assert.ok(fittedCeiling.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      const fittedFloor = normalizePersonalSalaryRecommendation(answer({ min: 40000, max: 54000, desiredSalary: 54000 }), options);
      assert.equal(fittedFloor.status, 'personalized');
      assert.deepEqual(fittedFloor.range, { min: 48000, max: 54000, currency: 'CAD', period: 'annual' },
        'the advertised minimum still raises the floor');
      assert.equal(fittedFloor.desiredSalary, 54000);
      assert.ok(fittedFloor.limitations.some(value => /fitted to the recommendation bounds/.test(value)));
      const belowMidpoint = normalizePersonalSalaryRecommendation(answer({ min: 48000, max: 54000, desiredSalary: 54000 }), options);
      assert.equal(belowMidpoint.status, 'personalized');
      assert.equal(belowMidpoint.desiredSalary, 54000);
      assert.ok(belowMidpoint.limitations.includes('The desired amount is below the employer’s advertised midpoint (CAD 60,000).'),
        'an ask under the employer’s own midpoint must be disclosed');
      const capped = normalizePersonalSalaryRecommendation(answer({ min: 48000, max: 54000, desiredSalary: 54000, limitations: ['One', 'Two', 'Three'] }), options);
      assert.equal(capped.limitations.length, 3, 'the below-midpoint note still respects the three-note cap');
      assert.equal(capped.limitations.at(-1), 'The desired amount is below the employer’s advertised midpoint (CAD 60,000).');
      // A higher advertisement raises the ceiling further: CAD 62,000 is then
      // valid, and an ask at that midpoint needs no warning.
      const higher = { ...options, offered: { ...options.offered, max: 76000 } };
      const atMidpoint = normalizePersonalSalaryRecommendation(answer({ min: 50000, max: 62000, desiredSalary: 62000 }), higher);
      assert.equal(atMidpoint.status, 'personalized');
      assert.equal(atMidpoint.range.max, 62000, 'the ceiling is the advertised midpoint when it exceeds the research');
      assert.equal(atMidpoint.limitations.some(value => /advertised midpoint/.test(value)), false, 'an ask at the advertised midpoint needs no warning');
      // The host's own market estimate sits mid-bounds by definition, so it
      // does not warn about itself.
      const estimate = normalizePersonalSalaryRecommendation(undefined, { marketRange: { min: 80000, max: 120000, currency: 'CAD', period: 'annual' }, offered: { usable: true, min: 100000, max: 160000, currency: 'CAD', period: 'annual' } });
      assert.equal(estimate.status, 'market_estimate');
      assert.equal(estimate.limitations.some(value => /advertised midpoint/.test(value)), false, 'a host market estimate is not flagged against its own midpoint');
      // Without a comparable band nothing is raised.
      const marketOnly = normalizePersonalSalaryRecommendation(answer({ min: 30000, max: 40000, desiredSalary: 35000 }), { marketRange: market, evidence: packet() });
      assert.equal(marketOnly.status, 'personalized');
      assert.equal(marketOnly.limitations.some(value => /advertised midpoint/.test(value)), false);
    },
  },
];
