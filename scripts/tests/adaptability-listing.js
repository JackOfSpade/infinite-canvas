// Adaptability family: JOB-LISTING REQUIREMENTS VS CANDIDATE EXPERIENCE.
//
// A job listing states what an employer WANTS. It is never evidence of what
// the candidate DID. Requirements, responsibilities, the employer's own
// products and numbers, and domain keywords must therefore never turn into a
// claim about the candidate in the generated résumé or cover letter, and the
// only thing that may widen what the candidate can claim is the CURRENT
// approved career source. This file proves that with the real production
// seams, never with a re-implementation of them:
//
//   careerSnapshot.js          validateCareerProfile / validateCurrentCareerSnapshot
//                              (compile gate: a listing fact the source does not state
//                              is refused as ungrounded), careerSnapshotId and
//                              approvedCareerEvidenceCatalog (content-addressed
//                              snapshot and host evidence catalog)
//   applicationCareerAuthority buildApplicationCareerAuthority /
//                              resolveAuthorityEvidence (pinned authority)
//   pasteApplicationAssembly   assertFrozenEvidencePlan (a listing quote is
//                              never career evidence; listing evidence must come
//                              from the CURRENT listing), assemblePasteApplicationResult
//                              (listing evidence alone cannot support candidate
//                              copy), assertAuthorityDraftSelection
//   structuredResume           validateStructuredApplicationResume (skills must be
//                              approved snapshot skills cited to evidence that
//                              states them; bullets, skills, credentials and
//                              degrees need career evidence)
//   localAiApplication         assertSourceQuoteLinksFinalText and
//                              pasteAttributionScopeErrors (ownership, figures,
//                              durations, populations, employer-years, result and
//                              scope words, responsibilities in final prose),
//                              __blindReviewFactEvidenceForTests,
//                              validateLocalApplicationResult (completion gate)
//   coverLetterChecks          findUnsupportedDurationClaim, checkTargetCompanyBinding,
//                              checkParagraphArgumentLinks / evidence-grounding (reached
//                              through the completion gate: the need quote is from the
//                              current listing, the argument evidence is a résumé bullet)
//   applicationAuthorityWorkflow  requirement/catalog reduction (exhaustive coverage),
//                              selectDraftSkills / selectDraftEvidence, dispositions
//   applicationBlindReview     scope contexts (the fact channel never carries
//                              listing text)
//
// THREE-WAY SEPARATION. Everything under the "synthetic" banners is a SYNTHETIC
// FIXTURE: five unrelated invented careers (hospital nurse, pastry chef,
// structural engineer, data analyst, warehouse supervisor) and three unrelated
// invented job listings. None of it reaches production. No test hardcodes which
// claims production should allow: every verdict is produced by the production
// function, and the mutation pattern makes the verdict a function of the SOURCE
// TEXT alone:
//
//   A  the candidate source does not state the listing-derived claim
//                                              -> claim rejected, for ITS reason
//   B  A + one directly supporting source line -> recompiled (new snapshot id),
//                                                 the SAME claim text accepted
//   C  B with that line removed FROM ITS TEXT  -> byte-identical to A, rejected
//      (removeSourceLine asserts the stripped text IS source A)
//   N  near-miss source (changed number / year / ownership word / relationship /
//      employer / credential / object)         -> claim rejected
//
// Every claim is derived from a LISTING slot (its product, company, numbers,
// credential, degree, responsibility, metric, scale language) and bolted onto
// work the candidate really did, then judged for every candidate x listing pair.
// The claim-rotation test then crosses the two: the source that states listing
// i's fact supports no claim derived from listing j, so rotating the posting
// cannot change what the candidate may claim. Each rejection asserts the
// production reason (rule label or error text) it is meant to hit, so a claim
// that would also be refused for an unrelated reason cannot pass for the wrong one.
//
// The offline "compiler" (compileSpec) is a faithful TRANSCRIBER of the fixture,
// standing in for the AI compile step that cannot run in a unit test. It only
// points each profile entity at the literal source lines it was rendered from;
// production then judges the result. Unfaithful compiler output is modelled by
// mutating the PROFILE after transcription (see the compile-gate test), never by
// relaxing production. The AI matcher of the requirement workflow is likewise
// simulated by an honest whole-term matcher; every decision after it is
// production's (reduction, coverage, selection, dispositions).
//
// `gradeUnit` composes the two exported grounding functions that production's
// (unexported) pasteUnitGroundingErrors composes at the paste stage. The
// population and employer-year arms live there and not in
// validateLocalApplicationResult, so the end-to-end completion-gate tests use
// only the kinds the completion gate itself owns.
//
// Tests tagged `[fixed defect]` guard gaps this sweep found and production has since
// fixed (each is a deterministic-gate check only: the independent AI blind review is not
// modelled; the comment above each describes the defect as it was before the fix).
// `knownGaps` (named export, NOT run by the registry) is empty.
import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  approvedCareerEvidenceCatalog,
  buildCareerSourceCorpus,
  canonicalCareerProfileDigest,
  careerSnapshotId,
  emptyCareerReconciliationReceipt,
  partitionCareerSourcePages,
  projectApprovedCareerSnapshotForApplication,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority, resolveAuthorityEvidence } from '../../electron/ipc/applicationCareerAuthority.js';
import { assemblePasteApplicationResult, assertAuthorityDraftSelection, assertFrozenEvidencePlan } from '../../electron/ipc/pasteApplicationAssembly.js';
import { NEUTRAL_SKILL_GROUP_LABELS, projectTrustedIdentity, validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { checkTargetCompanyBinding, findUnsupportedDurationClaim } from '../../electron/ipc/coverLetterChecks.js';
import {
  APPLICATION_QUALITY_CHECKLIST_VERSION,
  APPLICATION_QUALITY_CRITERIA,
  LOCAL_AI_GENERATION_AUDIT_VERSION,
  __blindReviewBoundedTailoringPagesForTests,
  __blindReviewDocumentProjectionForTests,
  __blindReviewFactEvidenceForTests,
  __snapshotCareerSkillEvidenceForTests,
  assertSourceQuoteLinksFinalText,
  pasteAttributionScopeErrors,
  validateLocalApplicationResult,
} from '../../electron/ipc/localAiApplication.js';
import {
  authorityDigest,
  createAuthorityWorkflowRoot,
  createDispositionPlan,
  createMatchReceipt,
  enumerateRequirementCatalogPairs,
  reduceRequirementMatches,
  selectDraftEvidence,
  selectDraftSkills,
  validateDispositionResponse,
  validateMatchResponse,
} from '../../electron/ipc/applicationAuthorityWorkflow.js';
import {
  applicationBlindReviewDocumentPageIndex,
  applicationBlindReviewScopeAt,
  applicationBlindReviewScopeCount,
  applicationBlindReviewWorkAt,
  createApplicationBlindReviewPlan,
  createApplicationBlindReviewSourceAccessor,
} from '../../electron/ipc/applicationBlindReview.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const lcfirst = value => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
const ucfirst = value => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const attempt = fn => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, message: String(error?.message || error) }; } };

// ---------------------------------------------------------------------------
// Synthetic candidates (test-only source fixtures; every name is invented)
// ---------------------------------------------------------------------------

// Each candidate has two or three roles. `base` achievement (roles[0].achievements[0])
// is stated as `${verb} ${obj}.` and is the work the listing-derived claims are
// bolted onto. `letter.claim` / `letter.proof` are the two candidate-specific
// sentences of the baseline cover-letter paragraph (the third, the transfer
// sentence, is derived from the LISTING); the baseline is graded by the real
// completion gate, so these strings are fixture data that production accepts.
// Technology labels carry an explicit skill disposition, exactly as a compiled
// profile would.
const CANDIDATES = Object.freeze([
  {
    key: 'hospital-nurse', name: 'Marisol Quenby', email: 'marisol.quenby@example.test',
    roles: [
      { id: 'role-ward', title: 'Charge Nurse', employer: 'Lindenmere General Hospital', location: 'Duluth, MN', start: 'March 2017', end: 'Present',
        achievements: [
          { id: 'ach-base', verb: 'Coordinated', obj: 'bedside handoffs across a cardiac step-down unit' },
          { id: 'ach-own', line: 'Trained new graduate nurses on telemetry monitoring procedures.', tech: [{ name: 'telemetry monitoring', skillId: 'skill-own', kind: 'method' }] },
        ] },
      { id: 'role-clinic', title: 'Staff Nurse', employer: 'Cedar Ridge Community Clinic', location: 'Hibbing, MN', start: 'June 2013', end: 'February 2017',
        achievements: [{ id: 'ach-prior', line: 'Administered immunizations during seasonal outreach clinics.' }] },
    ],
    letter: {
      claim: 'The work was in keeping each bedside handoff clear for the whole unit.',
      proof: 'I supported bedside handoffs on a busy cardiac step-down unit.',
    },
  },
  {
    key: 'pastry-chef', name: 'Odalys Verhoeven', email: 'odalys.verhoeven@example.test',
    roles: [
      { id: 'role-pastry', title: 'Pastry Chef', employer: 'Maison Orchardine Bakery', location: 'Savannah, GA', start: 'April 2018', end: 'Present',
        achievements: [
          { id: 'ach-base', verb: 'Produced', obj: 'laminated dough for the morning croissant service' },
          { id: 'ach-own', line: 'Applied chocolate tempering to custom wedding cake decorations.', tech: [{ name: 'chocolate tempering', skillId: 'skill-own', kind: 'method' }] },
        ] },
      { id: 'role-cafe', title: 'Line Cook', employer: 'Harbor Street Cafe', location: 'Beaufort, SC', start: 'May 2014', end: 'March 2018',
        achievements: [{ id: 'ach-prior', line: 'Prepared breakfast pastries and soups for a small dining room.' }] },
    ],
    letter: {
      claim: 'The work was in keeping every laminated layer consistent from batch to batch.',
      proof: 'I delivered laminated dough for every croissant service.',
    },
  },
  {
    key: 'structural-engineer', name: 'Ilse Marrowby', email: 'ilse.marrowby@example.test',
    roles: [
      { id: 'role-struct', title: 'Structural Engineer', employer: 'Tallgrass Structural Partners', location: 'Denver, CO', start: 'July 2016', end: 'Present',
        achievements: [
          { id: 'ach-base', verb: 'Designed', obj: 'steel moment frames for mid-rise office buildings' },
          { id: 'ach-own', line: 'Verified seismic load calculations using BeamWorks modeling.', tech: [{ name: 'BeamWorks', skillId: 'skill-own', kind: 'tool' }] },
        ] },
      { id: 'role-civil', title: 'Junior Engineer', employer: 'Northfield Civil Group', location: 'Omaha, NE', start: 'August 2012', end: 'June 2016',
        achievements: [{ id: 'ach-prior', line: 'Prepared foundation drawings for municipal bridge rehabilitation.' }] },
    ],
    letter: {
      claim: 'The work was in checking every load path against the governing building code.',
      proof: 'I delivered moment frame designs for several mid-rise office buildings.',
    },
  },
  {
    key: 'data-analyst', name: 'Oluwaseun Brandt', email: 'oluwaseun.brandt@example.test',
    roles: [
      { id: 'role-analytics', title: 'Data Analyst', employer: 'Quillon Retail Analytics', location: 'Austin, TX', start: 'January 2019', end: 'Present',
        achievements: [
          { id: 'ach-base', verb: 'Built', obj: 'weekly sales dashboards for regional store managers' },
          { id: 'ach-own', line: 'Wrote SQL reports that reconciled store inventory counts.', tech: [{ name: 'SQL', skillId: 'skill-own', kind: 'language' }] },
        ] },
      { id: 'role-intern', title: 'Data Intern', employer: 'Brightmore Freight Services', location: 'Madison, WI', start: 'June 2017', end: 'December 2018',
        achievements: [{ id: 'ach-prior', line: 'Cleaned shipment records for monthly reporting.' }] },
    ],
    letter: {
      claim: 'The work was in turning the messy store data into clear weekly numbers.',
      proof: 'I built dashboards that regional store managers read each Monday.',
    },
  },
  {
    key: 'warehouse-supervisor', name: 'Cormac Ellery', email: 'cormac.ellery@example.test',
    roles: [
      { id: 'role-dock', title: 'Warehouse Supervisor', employer: 'Harlow Pike Distribution Center', location: 'Memphis, TN', start: 'September 2017', end: 'Present',
        achievements: [
          { id: 'ach-base', verb: 'Scheduled', obj: 'dock appointments for inbound carriers on every shift' },
          { id: 'ach-own', line: 'Maintained pallet location records in the SlotTrack system.', tech: [{ name: 'SlotTrack', skillId: 'skill-own', kind: 'tool' }] },
        ] },
      { id: 'role-cold', title: 'Forklift Operator', employer: 'Riverbend Cold Storage', location: 'Nashville, TN', start: 'March 2013', end: 'August 2017',
        achievements: [{ id: 'ach-prior', line: 'Loaded outbound refrigerated trailers within each dispatch window.' }] },
    ],
    letter: {
      claim: 'The work was in keeping every inbound carrier moving through the dock on time.',
      proof: 'I supported dock appointments for the carriers arriving on each shift.',
    },
  },
]);

// ---------------------------------------------------------------------------
// Synthetic job listings (test-only; every employer and product is invented)
// ---------------------------------------------------------------------------

// Every slot below is a fact ABOUT THE EMPLOYER OR ITS REQUIREMENTS. `*Near`
// values are the plausible-but-different number a faulty source could state.
// None of these values appears in any candidate's source (asserted below).
const LISTINGS = Object.freeze([
  {
    key: 'hospital', title: 'Nursing Operations Supervisor', company: 'Brinemarsh Health Alliance', field: 'acute-care nursing',
    tool: 'ChartForge EHR', altTool: 'LedgerLeaf', years: 6, yearsNear: 5, ownVerb: 'Led', ownBase: 'Lead',
    budget: '$2.5M', budgetNear: '$2.0M', pct: '30%', pctNear: '13%', population: '500,000 residents', populationNear: '5,000 residents',
    foundedYear: '2021', foundedNear: '2023', teamSize: 40, teamNear: 14, need: 'dependable bedside handoffs', metricNoun: 'patient falls',
    credential: 'an active registered nurse license', certName: 'Registered nurse license', certNameNear: 'Practical nurse license', certIssuer: 'State Board of Nursing', certYear: '2014', certYearNear: '2012',
    duty: 'staffing agency contracts', dutyNear: 'parking permits',
    outcomeWord: { claimed: 'reducing', stated: 'Cut', rule: /unsupported reduction outcome/u },
    scope: { claimed: 'organization-wide', stated: 'across the entire organization', rule: /unsupported organization-wide scope/u },
    degreeName: 'Bachelor of Science in Nursing', degreeNameNear: 'Associate of Science in Nursing', degreeInstitution: 'Northgate State University', degreeYear: '2012', degreeYearNear: '2010',
  },
  {
    key: 'bakery', title: 'Production Bakery Manager', company: 'Tidewater Provisions', field: 'commercial baking',
    tool: 'DoughSync scheduling', altTool: 'CrumbLedger', years: 8, yearsNear: 7, ownVerb: 'Managed', ownBase: 'Manage',
    budget: '$1.2M', budgetNear: '$1.0M', pct: '15%', pctNear: '51%', population: '200,000 customers', populationNear: '2,000 customers',
    foundedYear: '2020', foundedNear: '2022', teamSize: 25, teamNear: 12, need: 'consistent overnight bread production', metricNoun: 'ingredient waste',
    credential: 'a food safety manager certification', certName: 'Food safety manager certification', certNameNear: 'Food handler certification', certIssuer: 'National Food Safety Council', certYear: '2016', certYearNear: '2015',
    duty: 'flour supplier agreements', dutyNear: 'uniform allowances',
    outcomeWord: { claimed: 'improving', stated: 'Improved', rule: /unsupported improvement outcome/u },
    scope: { claimed: 'at scale', stated: 'at large scale', rule: /unsupported at-scale status/u },
    degreeName: 'Bachelor of Science in Food Science', degreeNameNear: 'Associate of Applied Science in Baking', degreeInstitution: 'Crestwater University', degreeYear: '2014', degreeYearNear: '2011',
  },
  {
    key: 'engineering', title: 'Senior Structural Engineer', company: 'Halcyon Structural Group', field: 'structural engineering',
    tool: 'LatticePro analysis', altTool: 'GirderMesh', years: 10, yearsNear: 9, ownVerb: 'Owned', ownBase: 'Own',
    budget: '$4.8M', budgetNear: '$4.1M', pct: '20%', pctNear: '2%', population: '75,000 residents', populationNear: '7,500 residents',
    foundedYear: '2022', foundedNear: '2020', teamSize: 12, teamNear: 9, need: 'accurate seismic load calculations', metricNoun: 'design rework',
    credential: 'a professional engineer license', certName: 'Professional engineer license', certNameNear: 'Engineer in training certificate', certIssuer: 'State Engineering Registry', certYear: '2018', certYearNear: '2017',
    duty: 'welding subcontracts', dutyNear: 'visitor badges',
    outcomeWord: { claimed: 'reducing', stated: 'Lowered', rule: /unsupported reduction outcome/u },
    scope: { claimed: 'company-wide', stated: 'for the whole company', rule: /unsupported organization-wide scope/u },
    degreeName: 'Master of Science in Structural Engineering', degreeNameNear: 'Bachelor of Science in Civil Engineering', degreeInstitution: 'Ridgeline Institute of Technology', degreeYear: '2015', degreeYearNear: '2013',
  },
]);

function listingText(L) {
  return [
    L.title,
    L.company,
    '',
    `${L.company} serves ${L.population} and was founded in ${L.foundedYear}.`,
    'Requirements:',
    `- ${L.years}+ years of ${L.field} experience.`,
    `- ${L.ownBase} the work end to end for a team of ${L.teamSize}.`,
    `- Hands-on experience with ${L.tool}.`,
    `- Own an annual budget of ${L.budget}.`,
    `- Hold ${L.credential}.`,
    `- A ${L.degreeName} is required.`,
    `- Negotiate ${L.duty}.`,
    `- Support the rollout ${L.scope.claimed}.`,
    `- Improve ${L.metricNoun} by ${L.pct} year over year.`,
    `- Deliver ${L.need} on every shift.`,
  ].join('\n');
}
const listingToolSentence = L => `Hands-on experience with ${L.tool}.`;
const listingEvidence = L => [
  { id: 'job-need', sourceId: 'job-listing', quote: L.need, priority: 'highest' },
  { id: 'job-tool', sourceId: 'job-listing', quote: listingToolSentence(L), priority: 'high' },
];

// ---------------------------------------------------------------------------
// The offline transcriber: fixture spec -> source text -> corpus -> profile ->
// approved snapshot. Production validates every step.
// ---------------------------------------------------------------------------

const achievementLine = achievement => achievement.line || `${achievement.verb} ${achievement.obj}.`;
const baseOf = spec => ({ ...spec.roles[0].achievements[0], roleId: spec.roles[0].id });

function sourceModel(spec, extras) {
  const lines = [];
  const at = {};
  const push = (key, text) => { at[key] = lines.length; lines.push(text); };
  push('name', spec.name);
  push('email', spec.email);
  lines.push('');
  for (const role of spec.roles) {
    push(`${role.id}:title`, `${role.title} at ${role.employer}`);
    push(`${role.id}:location`, role.location);
    push(`${role.id}:dates`, `${role.start} to ${role.end}`);
    for (const achievement of [...role.achievements, ...extras.filter(extra => extra.roleId === role.id)]) push(`ach:${achievement.id}`, achievementLine(achievement));
    lines.push('');
  }
  for (const extra of extras.filter(item => item.cert || item.edu)) push(`${extra.cert ? 'cert' : 'edu'}:${extra.id}`, extra.line);
  return { lines, at, text: `${lines.join('\n')}\n` };
}

function compileSpec(spec, extras, model, corpus) {
  const seg = key => {
    const segment = corpus.segments[model.at[key]];
    assert(segment && segment.text.trim() === model.lines[model.at[key]].trim(), `fixture line ${key} maps to its physical segment`);
    return segment.id;
  };
  const profile = {
    identity: { name: spec.name, contacts: [spec.email], evidenceSegmentIds: [seg('name'), seg('email')] },
    roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
  for (const role of spec.roles) {
    const record = {
      id: role.id, title: role.title, employer: role.employer, startDate: role.start, endDate: role.end, location: role.location,
      achievementIds: [], skillIds: [], evidenceSegmentIds: [seg(`${role.id}:title`), seg(`${role.id}:location`), seg(`${role.id}:dates`)],
    };
    for (const achievement of [...role.achievements, ...extras.filter(extra => extra.roleId === role.id)]) {
      const segmentId = seg(`ach:${achievement.id}`);
      const line = achievementLine(achievement);
      const entity = { id: achievement.id, roleId: role.id, claim: line, technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: [segmentId] };
      for (const tech of achievement.tech || []) {
        entity.technologies.push(tech.name);
        if (tech.nonSkill) {
          entity.technologyReferences.push({ technology: tech.name, disposition: 'non-skill', nonSkillReason: tech.nonSkill, relationship: 'independent', relationshipGroup: '', relationshipEvidence: line, evidenceSegmentIds: [segmentId] });
          continue;
        }
        const qualified = Boolean(tech.group);
        entity.technologyReferences.push({
          technology: tech.name, disposition: 'skill', skillId: tech.skillId, relationship: qualified ? 'alternative' : 'independent',
          relationshipGroup: qualified ? tech.group : '', relationshipEvidence: line, evidenceSegmentIds: [segmentId],
        });
        profile.skills.push({
          id: tech.skillId, name: tech.name, category: tech.kind, capabilityKind: tech.kind, supportMode: qualified ? 'relationship-qualified' : 'direct',
          directEvidenceSegmentIds: qualified ? [] : [segmentId], indexEligible: !qualified, roleIds: [role.id], evidenceSegmentIds: [segmentId],
        });
        record.skillIds.push(tech.skillId);
      }
      record.achievementIds.push(achievement.id);
      record.evidenceSegmentIds.push(segmentId);
      profile.achievements.push(entity);
    }
    record.evidenceSegmentIds = [...new Set(record.evidenceSegmentIds)];
    profile.roles.push(record);
  }
  for (const extra of extras.filter(item => item.cert)) {
    profile.certifications.push({ id: extra.id, name: extra.cert.name, issuer: extra.cert.issuer, dates: extra.cert.dates, evidenceSegmentIds: [seg(`cert:${extra.id}`)] });
  }
  for (const extra of extras.filter(item => item.edu)) {
    profile.education.push({ id: extra.id, credential: extra.edu.credential, institution: extra.edu.institution, dates: extra.edu.dates, evidenceSegmentIds: [seg(`edu:${extra.id}`)] });
  }
  const owners = [['identity', profile.identity], ...['roles', 'achievements', 'skills', 'certifications', 'education'].flatMap(group => profile[group].map(entity => [entity.id, entity]))];
  profile.segmentCoverage = corpus.segments.map(segment => {
    const entityIds = owners.filter(([, entity]) => entity.evidenceSegmentIds.includes(segment.id)).map(([id]) => id);
    const key = Object.keys(model.at).find(candidate => corpus.segments[model.at[candidate]].id === segment.id) || '';
    const disposition = !entityIds.length ? 'non-career-content' : key === 'name' || key === 'email' ? 'identity' : key.startsWith('ach:') ? 'achievement' : key.startsWith('cert:') ? 'certification' : key.startsWith('edu:') ? 'education' : 'role-header';
    return { segmentId: segment.id, disposition, entityIds };
  });
  return profile;
}

function cleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  const audits = [
    ['coverage', 'career-profile-audit-completeness'], ['grounding', 'career-profile-audit-grounding'], ['attribution', 'career-profile-audit-attribution'],
    ['metrics', 'career-profile-audit-metrics'], ['skills', 'career-profile-audit-skills'], ['conflict', 'career-profile-audit-conflicts'],
  ].map(([category, task]) => {
    let chainDigest = digest(canonicalJson({ category, task, seed: 'career-page-audit-v1' }));
    const pageAudits = pages.map(page => {
      const findingDigest = digest(canonicalJson([]));
      chainDigest = digest(canonicalJson({ prior: chainDigest, pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest }));
      return { pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest, chainDigest };
    });
    const receipt = pageAudits.map(({ pageId, pageIndex, findingCount, findingDigest, chainDigest: link }) => ({ pageId, pageIndex, findingCount, findingDigest, chainDigest: link }));
    return { category, task, findingCount: 0, findingDigest: digest(canonicalJson(receipt)), findings: [], pageAudits };
  });
  const deterministicFailureDigest = digest(canonicalJson([]));
  const profileDigest = canonicalCareerProfileDigest(profile);
  const unresolvedFindingDigest = digest(canonicalJson({
    deterministicFailureDigest, audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })),
  }));
  return [{
    round: 0, profileDigest, unresolvedFindingDigest, stateDigest: digest(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

function approvedSnapshot(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  return {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint,
    sourceFingerprint: corpus.sourceFingerprint, compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: digest(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
    profile, auditHistory: cleanAuditHistory(corpus, profile),
  };
}

const contextCache = new Map();
/**
 * Build the complete production-derived application context for one source.
 * `fresh` bypasses the memo so a "removed the evidence" source is recompiled
 * from scratch rather than recalled.
 */
function build(spec, extras = [], { fresh = false } = {}) {
  const cacheKey = `${spec.key}|${canonicalJson(extras)}`;
  if (!fresh && contextCache.has(cacheKey)) return contextCache.get(cacheKey);
  const model = sourceModel(spec, extras);
  const corpus = buildCareerSourceCorpus([{
    name: 'Career File.md', contentHash: digest(model.text), text: model.text, legacyText: model.text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
  }]);
  assert(corpus.segments.length === model.lines.length, `${spec.key}: one physical segment per fixture line`);
  const profile = compileSpec(spec, extras, model, corpus);
  const profileVerdict = validateCareerProfile(profile, corpus);
  assert(profileVerdict.valid, `${spec.key}: production accepts the transcribed profile: ${profileVerdict.errors.slice(0, 4).join('; ')}`);
  const snapshot = approvedSnapshot(corpus, profile);
  const snapshotVerdict = validateCurrentCareerSnapshot(snapshot);
  assert(snapshotVerdict.valid, `${spec.key}: production accepts the approved snapshot: ${(snapshotVerdict.errors || []).slice(0, 4).join('; ')}`);
  const authority = buildApplicationCareerAuthority(snapshot);
  const context = {
    spec, extras, text: model.text, corpus, profile, snapshot, snapshotId: snapshot.snapshotId,
    catalog: approvedCareerEvidenceCatalog(snapshot), authority,
    careerData: projectApprovedCareerSnapshotForApplication(snapshot),
    skillEvidence: __snapshotCareerSkillEvidenceForTests(snapshot),
    sourceRoles: authority.sourceRoles, trustedIdentity: projectTrustedIdentity(authority.identity),
  };
  if (!fresh) contextCache.set(cacheKey, context);
  return context;
}

const evidenceId = (achievementId, line = 1) => `host.career.achievement.${achievementId}.${line}`;
const catalogItem = (context, id) => context.catalog.find(item => item.id === id);
const hasEvidence = (context, id) => Boolean(catalogItem(context, id));
const inventoryNames = context => context.skillEvidence.skills.map(skill => skill.name);
const identityTokens = context => [...new Set(context.sourceRoles.flatMap(role => `${role.title} ${role.company}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(token => token.length > 2))];

// ---------------------------------------------------------------------------
// Listing-derived claims. Each kind states something the LISTING says, bolted
// onto work the candidate really did; `support` is a differently-worded source
// line that genuinely states it; `near` states a different value.
// ---------------------------------------------------------------------------

const CLAIM_KINDS = Object.freeze([
  {
    id: 'ownership', forms: ['bullet', 'paragraph'], rule: /unsupported (?:leadership|management|direct) ownership/u,
    claim: (b, L) => `${L.ownVerb} ${b.obj}.`,
    support: (b, L) => `${L.ownVerb} the ${b.obj}.`,
    near: (b) => `Supported the ${b.obj}.`,
  },
  {
    id: 'currency', forms: ['bullet', 'paragraph'], rule: /unsupported figure[^]*currency/u,
    claim: (b, L) => `${b.verb} ${b.obj} on a ${L.budget} annual budget.`,
    support: (b, L) => `The annual budget for ${b.obj} was ${L.budget}.`,
    near: (b, L) => `The annual budget for ${b.obj} was ${L.budgetNear}.`,
  },
  {
    id: 'percent', forms: ['bullet', 'paragraph'], rule: /unsupported figure[^]*percentage/u,
    claim: (b, L) => `${b.verb} ${b.obj} for ${L.pct} of annual volume.`,
    support: (b, L) => `${ucfirst(b.obj)} accounted for ${L.pct} of annual volume.`,
    near: (b, L) => `${ucfirst(b.obj)} accounted for ${L.pctNear} of annual volume.`,
  },
  {
    id: 'duration', forms: ['bullet', 'paragraph'], rule: /experience span/u,
    claim: (b, L) => `${b.verb} ${b.obj}, drawing on ${L.years} years of experience.`,
    support: (b, L) => `Spent ${L.years} years working on ${b.obj}.`,
    near: (b, L) => `Spent ${L.yearsNear} years working on ${b.obj}.`,
  },
  {
    id: 'population', forms: ['bullet', 'paragraph'], rule: /user population/u,
    claim: (b, L) => `${b.verb} ${b.obj} for ${L.population}.`,
    support: (b, L) => `Served ${L.population} through ${b.obj}.`,
    near: (b, L) => `Served ${L.populationNear} through ${b.obj}.`,
  },
  {
    // The listing says when the EMPLOYER was founded; the claim presents that
    // year as when the candidate's own work at their employer began.
    id: 'employer-year', forms: ['paragraph'], rule: /attributes \d{4} to/u,
    claim: (b, L, spec) => `At ${spec.roles[0].employer}, I ${lcfirst(b.verb)} ${b.obj} since ${L.foundedYear}.`,
    support: (b, L) => `Began the ${b.obj} in ${L.foundedYear}.`,
    near: (b, L) => `Began the ${b.obj} in ${L.foundedNear}.`,
  },
  {
    // The listing says what it wants IMPROVED by how much; the claim presents a result on that metric as the candidate's own.
    // The result-word qualifier table is a different production rule from ownership, and each listing exercises a different row
    // of it (or a different synonym of the same row).
    id: 'outcome', forms: ['bullet', 'paragraph'], rule: L => L.outcomeWord.rule, rotates: false,
    claim: (b, L) => `${b.verb} ${b.obj}, ${L.outcomeWord.claimed} ${L.metricNoun}.`,
    support: (b, L) => `${L.outcomeWord.stated} ${L.metricNoun} through the ${b.obj}.`,
    near: (b, L) => `Tracked ${L.metricNoun} through the ${b.obj}.`,
  },
  {
    // The listing's scale language ("at scale", "organization-wide") presented as the scale of the candidate's own work. Each listing
    // exercises a different row of the scope-qualifier table.
    id: 'scope', forms: ['bullet', 'paragraph'], rule: L => L.scope.rule, rotates: false,
    claim: (b, L) => `${b.verb} ${b.obj} ${L.scope.claimed}.`,
    support: (b, L) => `Ran the ${b.obj} ${L.scope.stated}.`,
    near: (b) => `Ran the ${b.obj} within a single team.`,
  },
  {
    // The listing names a RESPONSIBILITY. Asserted as past work that shares no
    // terms with the cited career quote, it is unrelated to that quote (as a
    // bullet, as a separate letter sentence beside a grounded one). The
    // recompiled source that states the work admits the identical text.
    id: 'duty', forms: ['bullet', 'paragraph'], rule: /unrelated/u,
    claim: (b, L) => `Negotiated ${L.duty}.`,
    compose: (text, context) => `${context.spec.letter.proof} I ${lcfirst(text)}`,
    support: (b, L) => `Negotiated ${L.duty} throughout the busiest season.`,
    near: (b, L) => `Negotiated ${L.dutyNear} throughout the busiest season.`,
  },
]);

// The claim as it would read in the requested document form. A paragraph form
// is first person; the employer-year claim is already written that way, and a
// duty claim sits in its own sentence beside the candidate's grounded proof.
const formText = (kind, form, context, L) => {
  const text = kind.claim(baseOf(context.spec), L, context.spec);
  if (form === 'bullet' || kind.id === 'employer-year') return text;
  return kind.compose ? kind.compose(text, context) : `I ${lcfirst(text)}`;
};

/**
 * Grade one résumé bullet or cover-letter paragraph the way the paste pipeline
 * does: every cited ID must resolve in the pinned authority, and the two
 * exported grounding functions production composes in pasteUnitGroundingErrors
 * judge the text against ONLY the cited career-data quotes.
 */
function gradeUnit(context, { form, text, evidenceIds }) {
  const errors = [];
  const quotes = [];
  for (const id of evidenceIds) {
    const resolved = attempt(() => resolveAuthorityEvidence(context.authority, id));
    if (!resolved.ok) { errors.push(resolved.message); continue; }
    quotes.push(catalogItem(context, id).quote);
  }
  if (!errors.length) {
    const label = form === 'bullet' ? 'resumeBullets' : 'coverLetterParagraphs';
    const grounding = attempt(() => assertSourceQuoteLinksFinalText(text, quotes, label, 0, { identityTokens: identityTokens(context) }));
    if (!grounding.ok) errors.push(grounding.message);
    errors.push(...pasteAttributionScopeErrors({
      unitLabel: form === 'bullet' ? 'Résumé bullet' : 'Cover-letter paragraph', unitId: 'unit-1', finalText: text, evidenceIds,
      acceptedEvidence: context.catalog, sourceRoles: context.sourceRoles, careerData: '', authority: context.authority,
    }));
  }
  return { ok: errors.length === 0, errors, reason: errors.join(' | ') };
}

/** The one extra source achievement a claim kind needs, attached to the base role. */
const extraFor = (spec, line, id = 'ach-listing', tech = undefined) => ({ roleId: spec.roles[0].id, id, line, ...(tech ? { tech } : {}) });

// ---------------------------------------------------------------------------
// Application drafts, built from the production-derived context
// ---------------------------------------------------------------------------

const SKILL_GROUP = NEUTRAL_SKILL_GROUP_LABELS.includes('tools') ? 'tools' : NEUTRAL_SKILL_GROUP_LABELS[0];
const skillRowId = skillId => `host.career.skill.${skillId}.1`;
const roleRecord = (context, roleId) => context.sourceRoles.find(role => role.id === roleId);

/** The bounded skills index production requires for this snapshot: every approved direct skill. */
function defaultSkillGroups(context) {
  const skills = context.skillEvidence.skills;
  return skills.length ? [{ id: 'skills-1', group: SKILL_GROUP, items: skills.map(skill => skill.name), evidenceIds: skills.map(skill => skillRowId(skill.id)) }] : [];
}

function resumeDraft(context, skillGroups = defaultSkillGroups(context), credentials = undefined, education = undefined) {
  return {
    ...(credentials ? { credentials } : {}),
    ...(education ? { education } : {}),
    schemaVersion: 'structured-resume.v1', identity: context.trustedIdentity,
    roles: context.spec.roles.map(role => ({
      ...roleRecord(context, role.id),
      bullets: [{ id: `bullet-${role.id}`, text: achievementLine(role.achievements[0]), evidenceIds: [evidenceId(role.achievements[0].id)] }],
    })),
    skills: skillGroups,
  };
}

function gradeResume(context, L, draft, overrides = {}) {
  return attempt(() => validateStructuredApplicationResume(draft, {
    sourceRoles: context.sourceRoles, evidenceCatalog: [...context.catalog, ...listingEvidence(L)], trustedIdentity: context.trustedIdentity,
    careerData: context.careerData, careerSkillEvidence: context.skillEvidence, authorityMode: true, ...overrides,
  }));
}

/** A source in which the candidate really holds the credential the listing asks for. */
const certExtra = (L, { name = L.certName, issuer = L.certIssuer, dates = L.certYear } = {}) => ({
  id: 'cert-listing', line: `${name}, ${issuer}, ${dates}`, cert: { name, issuer, dates },
});
const certificationRowIds = id => [1, 2].map(line => `host.career.certification.${id}.${line}`);

/** A source in which the candidate really holds the degree the listing asks for. */
const eduExtra = (L, { credential = L.degreeName, institution = L.degreeInstitution, dates = L.degreeYear } = {}) => ({
  id: 'edu-listing', line: `${credential}, ${institution}, ${dates}`, edu: { credential, institution, dates },
});
const educationRowIds = id => [1, 2, 3].map(line => `host.career.education.${id}.${line}`);

/**
 * "C = B with that line removed". The removal is done on B's SOURCE TEXT (not by
 * rebuilding from a spec that happens never to have had the line), and the
 * result must be exactly the text of source A before it is recompiled.
 */
function removeSourceLine(context, line, original) {
  const lines = context.text.split('\n');
  assert(lines.filter(candidate => candidate === line).length === 1, `the source states ${JSON.stringify(line)} exactly once`);
  const stripped = lines.filter(candidate => candidate !== line).join('\n');
  assert(stripped === original.text, 'B minus its supporting line is byte-identical to source A');
  return stripped;
}

/** A source in which the candidate really used the listing's product. */
const toolExtra = (spec, L) => extraFor(spec, `Used ${L.tool} to record ${baseOf(spec).obj}.`, 'ach-listing', [{ name: L.tool, skillId: 'skill-listing', kind: 'tool' }]);
/** A source in which the candidate really worked in the listing's domain. */
const domainExtra = (spec, L) => extraFor(spec, `Applied ${L.field} practices to ${baseOf(spec).obj}.`, 'ach-listing', [{ name: L.field, skillId: 'skill-domain', kind: 'domain' }]);

// ---------------------------------------------------------------------------
// A complete application package, judged by the real assembler and the real
// completion gate. The cover letter is a three-sentence argument: a candidate
// claim, a candidate proof, and a transfer sentence derived from the LISTING.
// ---------------------------------------------------------------------------

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const jobRecord = L => ({ title: L.title, company: L.company, snippet: listingText(L) });

function packageFor(context, L, options = {}) {
  const base = baseOf(context.spec);
  const bullet = options.bullet ?? `${base.verb} ${base.obj}.`;
  const baseEvidence = evidenceId(base.id);
  const claim = context.spec.letter.claim;
  const proof = options.proof ?? context.spec.letter.proof;
  const relevance = `I would apply that work to the ${L.need} this role needs.`;
  const paragraph = [claim, proof, relevance].join(' ');
  const audit = {
    version: LOCAL_AI_GENERATION_AUDIT_VERSION,
    jobPriorities: [{ requirement: ucfirst(L.need), priority: 'highest', disposition: 'addressed-both', justification: 'The selected evidence directly addresses the stated first requirement.' }],
    resumePlan: { strategy: 'Lead with the strongest supported evidence for the role.', selectionRationale: 'The retained roles preserve direct factual support and concise relevance.' },
    coverLetterPlan: {
      controllingThesis: `${ucfirst(L.need)} are the supported capability this role needs.`,
      paragraphs: [{
        paragraph, argumentativeJob: 'Establish the controlling evidence-to-need connection.', relationToThesis: 'Connect the source-supported proof to the stated need.', relationToPreviousParagraph: 'opening',
        sentences: [
          { sentence: claim, function: 'Establishes this paragraph’s argumentative direction.', relationToPreviousSentence: 'opening' },
          { sentence: proof, function: 'Grounds the capability in completed work.', relationToPreviousSentence: 'Supports the stated capability with one completed action.' },
          { sentence: relevance, function: 'States the transfer to the responsibility this posting names.', relationToPreviousSentence: 'Applies the completed work to the target responsibility.' },
        ],
        argumentMapping: { claim, proof, relevance, jobNeedQuote: options.jobNeedQuote ?? L.need },
      }],
    },
    finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
  };
  const criteria = APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
  return {
    input: {
      version: 1, jobId: JOB_ID, sourceRoles: context.sourceRoles, careerSkillEvidence: context.skillEvidence,
      qualityChecklist: { version: APPLICATION_QUALITY_CHECKLIST_VERSION }, generationAudit: { version: LOCAL_AI_GENERATION_AUDIT_VERSION, required: true }, job: jobRecord(L),
    },
    authority: context.authority, careerData: '', jobListing: listingText(L),
    paste: {
      trustedIdentity: context.trustedIdentity,
      evidencePlan: { evidence: [...context.catalog.map(({ id, sourceId, quote }) => ({ id, sourceId, quote })), { id: 'job-need', sourceId: 'job-listing', quote: L.need }] },
      resume: {
        schemaVersion: 'structured-resume.v1', identity: context.trustedIdentity,
        roles: context.sourceRoles.map((role, index) => {
          const first = context.spec.roles[index].achievements[0];
          return { ...role, bullets: [{
            id: `bullet-${role.id}`, text: index === 0 ? bullet : achievementLine(first),
            evidenceIds: index === 0 ? (options.bulletEvidenceIds ?? [baseEvidence]) : [evidenceId(first.id)],
          }] };
        }),
        skills: defaultSkillGroups(context),
      },
      coverLetter: {
        name: context.trustedIdentity.name, contact: context.trustedIdentity.contact,
        paragraphs: [{ id: 'paragraph-1', text: paragraph, evidenceIds: options.paragraphEvidenceIds ?? [baseEvidence, 'job-need'] }],
        roleThesis: audit.coverLetterPlan.controllingThesis,
        coverLetterArgument: { primaryEvidence: { evidence: options.argumentEvidence ?? bullet, evidenceRole: `${context.sourceRoles[0].title} at ${context.sourceRoles[0].company}`, relationToThesis: 'The completed work establishes the capability named in the thesis.' } },
        generationAudit: audit,
      },
      finalReview: {
        decision: 'pass', findings: [],
        checklist: APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` })),
        qualityReview: {
          checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria,
          resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported evidence with clear relevance.' },
          coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for the target need.' },
        },
        generationAudit: audit,
      },
    },
  };
}

/** Assemble, then run the completion gate; the stage that refused is reported. */
function completePackage(context, L, options) {
  const assembled = attempt(() => assemblePasteApplicationResult(packageFor(context, L, options)));
  if (!assembled.ok) return { ok: false, stage: 'assemble', message: assembled.message };
  const validated = attempt(() => validateLocalApplicationResult(assembled.value, assembled.value.jobId, '/tmp', jobRecord(L), {
    careerData: context.careerData, evidencePlan: null,
    qualityChecklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, generationAuditVersion: LOCAL_AI_GENERATION_AUDIT_VERSION,
  }));
  return validated.ok ? { ok: true, stage: 'complete', message: '' } : { ok: false, stage: 'validate', message: validated.message };
}

// ---------------------------------------------------------------------------
// Requirement / catalog workflow. The listing contributes REQUIREMENTS; the
// candidate contributes the CATALOG. The AI matcher is simulated by an honest
// whole-term matcher that can only name catalog rows it was shown; every
// admission decision after that (coverage, reduction, selection, disposition)
// is the production code under test.
// ---------------------------------------------------------------------------

const wholeTerm = (text, term) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);

function workflowFor(context, L) {
  const base = baseOf(context.spec);
  const requirements = [
    { id: 'req-tool', text: listingToolSentence(L), term: L.tool, priority: 'highest' },
    { id: 'req-work', text: `Deliver ${L.need} on every shift.`, term: base.verb, priority: 'high' },
  ];
  const catalog = context.catalog.map(({ id, sourceId, quote }) => ({ id, sourceId, quote }));
  const skills = context.skillEvidence.skills.map(skill => ({
    id: skill.id, name: skill.name, evidenceIds: context.catalog.filter(item => item.id.startsWith(`host.career.skill.${skill.id}.`)).map(item => item.id),
  }));
  const root = createAuthorityWorkflowRoot({ requirements, catalog, roles: context.sourceRoles, skills, requirementPageSize: 2, catalogPageSize: 8 });
  const quoteOf = id => catalog.find(row => row.id === id).quote;
  const honestResponse = pair => ({
    version: root.version, rootDigest: root.digest, pairDigest: pair.digest,
    rows: pair.requirementIds.map(requirementId => {
      const term = requirements.find(row => row.id === requirementId).term;
      const candidateEvidenceIds = pair.catalogEvidenceIds.filter(id => wholeTerm(quoteOf(id), term));
      return { requirementId, candidateEvidenceIds, localStatus: candidateEvidenceIds.length ? 'matched' : 'no-match' };
    }),
  });
  const pairs = [...enumerateRequirementCatalogPairs(root)];
  const receipts = pairs.map(pair => createMatchReceipt({ root, pair, response: honestResponse(pair) }));
  const reduction = reduceRequirementMatches(root, receipts);
  const status = id => reduction.aggregates.find(row => row.requirementId === id).finalStatus;
  return { requirements, catalog, skills, root, pairs, honestResponse, receipts, reduction, status, skillSelection: selectDraftSkills({ skills, reduction }) };
}

// ---------------------------------------------------------------------------
// Blind-review fact channel (the exact production sequence, minus the store)
// ---------------------------------------------------------------------------

function roleIdOfEvidence(context, id) {
  const match = /^host\.career\.(achievement|skill|role)\.([^.]+)\./u.exec(id);
  if (!match) return undefined;
  if (match[1] === 'role') return match[2];
  return context.profile.roles.find(role => (match[1] === 'achievement' ? role.achievementIds : role.skillIds).includes(match[2]))?.id;
}

function blindState(context, L, { bullet, bulletEvidenceIds, paragraph, paragraphEvidenceIds, extraEvidence = [] }) {
  return {
    evidencePlan: {
      evidence: [
        ...context.catalog.map(item => ({ id: item.id, sourceId: item.sourceId, quote: item.quote, roleId: roleIdOfEvidence(context, item.id) })),
        ...listingEvidence(L), ...extraEvidence,
      ],
    },
    resume: {
      identity: context.trustedIdentity,
      roles: context.sourceRoles.map((role, index) => ({
        ...role,
        bullets: [{
          id: `bullet-${role.id}`, text: index === 0 ? bullet : achievementLine(context.spec.roles[index].achievements[0]),
          evidenceIds: index === 0 ? bulletEvidenceIds : [evidenceId(context.spec.roles[index].achievements[0].id)],
        }],
      })),
    },
    coverLetter: { name: context.trustedIdentity.name, contact: context.trustedIdentity.contact, paragraphs: [{ id: 'paragraph-1', text: paragraph, evidenceIds: paragraphEvidenceIds }] },
  };
}

/** Build the blind-review plan and read back every scope's host-projected context. */
function blindScopes(context, L, state) {
  const input = { sourceRoles: context.sourceRoles };
  const projection = __blindReviewDocumentProjectionForTests(state);
  const fact = __blindReviewFactEvidenceForTests(state, input);
  const requirements = [
    { id: 'req-tool', text: listingToolSentence(L), priority: 'highest' },
    { id: 'req-need', text: `Deliver ${L.need} on every shift.`, priority: 'high' },
  ];
  const tailoringPages = __blindReviewBoundedTailoringPagesForTests(requirements, requirements.map(row => ({
    requirementId: row.id, disposition: 'omitted-no-evidence', justification: 'No candidate evidence states this requirement.', proofs: [],
  })), 'req');
  const sourceAccessor = createApplicationBlindReviewSourceAccessor({
    resume: projection.resume, coverLetter: projection.coverLetter, citedEvidencePages: fact.pages, tailoringPages,
    factClaims: fact.factClaims.map(claim => ({ ...claim, pageIndex: applicationBlindReviewDocumentPageIndex(claim.document === 'resume' ? projection.resume : projection.coverLetter, claim.text) })),
  });
  const plan = createApplicationBlindReviewPlan({ sourceAccessor });
  const scopes = [];
  for (let ordinal = 0; ordinal < applicationBlindReviewScopeCount(plan); ordinal += 1) {
    const work = applicationBlindReviewWorkAt(plan, { scopeOrdinal: ordinal, sourceAccessor });
    scopes.push({ track: work.track, json: JSON.stringify(applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor }).context) });
  }
  return { fact, scopes };
}

const factScopeText = scopes => scopes.filter(scope => scope.track === 'fact-fidelity').map(scope => scope.json).join('\n');
const tailoringScopeText = scopes => scopes.filter(scope => scope.track === 'tailoring-ats').map(scope => scope.json).join('\n');
// A JSON-escaped dollar/percent/etc. string compares equal to its plain form.
const jsonHas = (json, value) => json.includes(JSON.stringify(String(value)).slice(1, -1));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PAIRS = CANDIDATES.flatMap(spec => LISTINGS.map(L => ({ spec, L })));
const claimKind = id => CLAIM_KINDS.find(kind => kind.id === id);
// A separate unrelated letter sentence is reported by its own sentence position; a whole unrelated bullet is not.
const ruleFor = (kind, form, L) => {
  if (kind.id === 'duty' && form === 'paragraph') return /sentence 2\)? is unrelated/u;
  return typeof kind.rule === 'function' ? kind.rule(L) : kind.rule;
};

export default [
  {
    name: 'Listing fixtures: every synthetic career is a production-valid approved snapshot, and no listing fact is present in any candidate source',
    run() {
      assert(CANDIDATES.length >= 5 && LISTINGS.length >= 3, 'at least five unrelated candidates and three unrelated listings');
      assert(new Set(CANDIDATES.map(spec => spec.roles[0].title)).size === CANDIDATES.length, 'the candidates are in unrelated occupations');
      assert(new Set(LISTINGS.map(L => L.company)).size === LISTINGS.length && new Set(LISTINGS.map(L => L.tool)).size === LISTINGS.length, 'the listings name different employers and products');
      for (const spec of CANDIDATES) {
        const A = build(spec);
        assert(A.catalog.length > 10 && A.skillEvidence.skills.length === 1 && A.skillEvidence.skills[0].name === spec.roles[0].achievements[1].tech[0].name,
          `${spec.key}: production derives a catalog and a one-skill direct inventory from the source`);
        for (const L of LISTINGS) {
          const body = listingText(L);
          const stated = [L.tool, L.budget, L.pct, L.population, L.foundedYear, `${L.years}+ years`, `team of ${L.teamSize}`, L.company, L.need, L.credential, L.field, L.degreeName, L.duty, L.metricNoun, L.scope.claimed];
          for (const fact of stated) assert(body.includes(fact), `the listing text states ${fact}`);
          for (const fact of [...stated, L.altTool, `${L.years} years`, L.certName, L.certIssuer, L.degreeInstitution, L.dutyNear]) {
            const lower = fact.toLowerCase();
            assert(!A.text.toLowerCase().includes(lower) && !A.careerData.toLowerCase().includes(lower) && !A.catalog.some(item => item.quote.toLowerCase().includes(lower)),
              `${spec.key}/${L.key}: listing fact ${JSON.stringify(fact)} is absent from the candidate source, projection and every evidence quote`);
          }
          assert(!new RegExp(`\\b${L.ownVerb}\\b`, 'iu').test(A.text), `${spec.key}: the source does not already use the ownership word ${L.ownVerb}`);
          // The responsibility must share no TERM with any candidate's source, or the term-overlap gate would be fed by the source itself.
          for (const word of `${L.duty} ${L.dutyNear} negotiated`.split(/\s+/u)) {
            assert(!new RegExp(`\\b${escapeRegExp(word)}\\b`, 'iu').test(A.text), `${spec.key}/${L.key}: the responsibility term ${JSON.stringify(word)} is absent from the candidate source`);
          }
        }
      }
      return { candidates: CANDIDATES.length, listings: LISTINGS.length };
    },
  },
  {
    name: 'Listing-derived claims: rejected from source A, the SAME text accepted from recompiled source B, rejected again from C and from near-miss sources',
    run() {
      let verdicts = 0;
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const baseIds = [evidenceId(base.id)];
        const withSupport = [...baseIds, evidenceId('ach-listing')];
        // Control: the faithful base claim is grounded in both forms, so each rejection below is the listing-derived addition.
        assert(gradeUnit(A, { form: 'bullet', text: `${base.verb} ${base.obj}.`, evidenceIds: baseIds }).ok
          && gradeUnit(A, { form: 'paragraph', text: `I ${lcfirst(base.verb)} ${base.obj}.`, evidenceIds: baseIds }).ok,
        `${spec.key}: the faithful base claim is accepted from source A`);
        for (const kind of CLAIM_KINDS) {
          for (const form of kind.forms) {
            const text = formText(kind, form, A, L);
            const label = `${spec.key}/${L.key}/${kind.id}/${form}`;
            const rule = ruleFor(kind, form, L);
            const a = gradeUnit(A, { form, text, evidenceIds: baseIds });
            assert(!a.ok && rule.test(a.reason), `${label}: the listing-derived claim ${JSON.stringify(text)} is rejected for its own reason from source A (${a.reason})`);
            // B = A + one directly supporting, differently worded source line, recompiled.
            const supportLine = achievementLine(extraFor(spec, kind.support(base, L)));
            const B = build(spec, [extraFor(spec, kind.support(base, L))]);
            assert(B.snapshotId !== A.snapshotId && B.catalog.length > A.catalog.length, `${label}: recompiling the extended source yields a new snapshot and a larger catalog`);
            const b = gradeUnit(B, { form, text, evidenceIds: withSupport });
            assert(b.ok, `${label}: the identical claim is accepted once the source states it (${b.reason})`);
            // C = B with that line removed FROM ITS TEXT, recompiled from scratch: byte-identical to A.
            assert(removeSourceLine(B, supportLine, A) === A.text, `${label}: C is B's text minus the supporting line`);
            const C = build(spec, [], { fresh: true });
            assert(C.snapshotId === A.snapshotId && C.careerData === A.careerData && canonicalJson(C.catalog) === canonicalJson(A.catalog), `${label}: removing the line restores the exact source A state`);
            const cGone = gradeUnit(C, { form, text, evidenceIds: withSupport });
            assert(!cGone.ok && /Unknown authority evidence id/u.test(cGone.reason), `${label}: the support citation no longer resolves once the evidence is removed (${cGone.reason})`);
            const c = gradeUnit(C, { form, text, evidenceIds: baseIds });
            assert(!c.ok && rule.test(c.reason), `${label}: the claim is rejected again from source C (${c.reason})`);
            // N = near-miss source (changed number / year / ownership word / object): still rejected for the same reason.
            const N = build(spec, [extraFor(spec, kind.near(base, L))]);
            const n = gradeUnit(N, { form, text, evidenceIds: withSupport });
            assert(!n.ok && rule.test(n.reason), `${label}: a source stating ${JSON.stringify(kind.near(base, L))} does not support the claim (${n.reason})`);
            verdicts += 4;
          }
        }
        // Employer near-miss: the same work, attributed to the candidate's OTHER employer. The cited evidence belongs to the
        // first role, so the attribution is refused; once the recompiled source states the work under the second role it is not.
        const other = spec.roles[1];
        const swapped = `At ${other.employer}, I ${lcfirst(base.verb)} ${base.obj}.`;
        const swappedA = gradeUnit(A, { form: 'paragraph', text: swapped, evidenceIds: baseIds });
        assert(!swappedA.ok && /attributes work to/u.test(swappedA.reason), `${spec.key}/${L.key}: attributing the first role's work to ${other.employer} is refused (${swappedA.reason})`);
        const secondRoleLine = { roleId: other.id, id: 'ach-listing', line: `${base.verb} ${base.obj} during the final year.` };
        const secondRole = build(spec, [secondRoleLine]);
        assert(gradeUnit(secondRole, { form: 'paragraph', text: swapped, evidenceIds: [...baseIds, evidenceId('ach-listing')] }).ok, `${spec.key}/${L.key}: the identical sentence is accepted once the second role's own evidence states the work`);
        removeSourceLine(secondRole, secondRoleLine.line, A);
        assert(!gradeUnit(build(spec, [], { fresh: true }), { form: 'paragraph', text: swapped, evidenceIds: baseIds }).ok, `${spec.key}/${L.key}: and refused again after removal`);
      }
      return { verdicts };
    },
  },
  {
    name: 'Evidence plan: a listing requirement is never career evidence; the recompiled source makes the supported fact admissible and removal undoes it',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const listing = listingText(L);
        const requirement = listingToolSentence(L);
        const planOf = (id, quote, sourceId = 'career-data') => ({ evidence: [{ id, sourceId, quote }] });
        const admit = (context, plan, jobListing = listing) => attempt(() => assertFrozenEvidencePlan(plan, '', jobListing, { authority: context.authority }));
        const refused = (verdict, pattern, what) => assert(!verdict.ok && pattern.test(verdict.message), `${label}: ${what} (${verdict.message})`);
        const label = `${spec.key}/${L.key}`;
        const unknownId = /Unknown authority evidence id/u;
        const quoteMismatch = /quote does not exactly match its approved catalog entry/u;
        // The listing sentence, offered as career evidence under an invented ID or under a real catalog ID.
        refused(admit(A, planOf(evidenceId('ach-listing'), requirement)), unknownId, 'a listing sentence under an unknown career ID is rejected');
        refused(admit(A, planOf(evidenceId(base.id), requirement)), quoteMismatch, 'a listing sentence under a real career ID is rejected (quote mismatch)');
        refused(admit(A, planOf(evidenceId(base.id), `${base.verb} ${base.obj} using ${L.tool}.`)), quoteMismatch, 'a real career ID with a listing-embellished quote is rejected');
        // As what it is, the same sentence is legitimate listing evidence.
        assert(admit(A, planOf('job-tool', requirement, 'job-listing')).ok, `${label}: the listing sentence is admissible as job-listing evidence`);
        // Listing evidence must come from the CURRENT listing: an employer claim the listing never made, or the sentence of
        // another posting, is not evidence of anything (it would otherwise launder an invented employer fact into the plan).
        refused(admit(A, planOf('job-invented', `${L.company} was named the regional leader in ${L.field}.`, 'job-listing')), /no longer occurs in its frozen job-listing source/u,
          'an employer claim the listing never made is not listing evidence');
        for (const other of LISTINGS.filter(candidate => candidate.key !== L.key)) {
          refused(admit(A, planOf('job-other', listingToolSentence(other), 'job-listing')), /no longer occurs in its frozen job-listing source/u,
            `the ${other.key} posting's sentence is not evidence for the ${L.key} posting`);
          assert(admit(A, planOf('job-other', listingToolSentence(other), 'job-listing'), listingText(other)).ok, `${label}: the same item is admissible against the posting that states it`);
        }
        // B: the candidate really used the product; the plan item is the catalog's own row.
        const B = build(spec, [toolExtra(spec, L)]);
        const row = catalogItem(B, evidenceId('ach-listing'));
        const supported = planOf(row.id, row.quote);
        assert(admit(B, supported).ok, `${label}: the recompiled source admits its own catalog row`);
        refused(admit(A, supported), unknownId, 'the same plan item is unknown to source A');
        // C: removed again (B's text minus its line, recompiled).
        removeSourceLine(B, achievementLine(toolExtra(spec, L)), A);
        const C = build(spec, [], { fresh: true });
        assert(C.snapshotId === A.snapshotId, `${label}: removal restores the original snapshot`);
        refused(admit(C, supported), unknownId, 'the same plan item is unknown again after the evidence is removed');
        // Near misses against B: the listing sentence under B's real ID, and B's quote with a different product.
        refused(admit(B, planOf(row.id, requirement)), quoteMismatch, 'even where the ID exists, the listing sentence is not its quote');
        refused(admit(B, planOf(row.id, row.quote.replace(L.tool, L.altTool))), quoteMismatch, 'a changed product name is not the approved quote');
      }
    },
  },
  {
    name: 'Skills: a listing-named product or domain keyword is no candidate skill from A, evaluated-only or either-or sources; it is admitted (then required) only once the recompiled source states it',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const notApproved = /not an exact, index-eligible approved snapshot skill/u;
        // Control and the absence of a phantom requirement: the listing names these terms, yet source A needs none of them.
        assert(gradeResume(A, L, resumeDraft(A)).ok, `${spec.key}/${L.key}: the faithful skills block is accepted from source A`);
        for (const { tag, term, extra, skillId } of [
          { tag: 'product', term: L.tool, extra: toolExtra(spec, L), skillId: 'skill-listing' },
          { tag: 'domain keyword', term: L.field, extra: domainExtra(spec, L), skillId: 'skill-domain' },
        ]) {
          const label = `${spec.key}/${L.key}/${tag}`;
          // The candidate's own approved skills plus the listing's term, cited to `evidence`.
          const withTerm = (context, evidence) => resumeDraft(context, [{
            id: 'skills-1', group: SKILL_GROUP, items: [...inventoryNames(A), term],
            evidenceIds: [...A.skillEvidence.skills.map(skill => skillRowId(skill.id)), ...evidence],
          }]);
          // A1: the term slipped into the candidate's skills group; A2: cited to listing evidence only.
          const a1 = gradeResume(A, L, withTerm(A, []));
          assert(!a1.ok && a1.message.includes(term) && notApproved.test(a1.message), `${label}: the listing term in a skills group is not an approved snapshot skill (${a1.message})`);
          const a2 = gradeResume(A, L, resumeDraft(A, [...defaultSkillGroups(A), { id: 'skills-2', group: SKILL_GROUP, items: [term], evidenceIds: ['job-tool'] }]));
          assert(!a2.ok && /needs at least one career-data evidence ID/u.test(a2.message), `${label}: a skills group cited to the listing alone is rejected (${a2.message})`);
          // B: the candidate used it. The recompiled inventory contains it and the draft that names it is accepted.
          const B = build(spec, [extra]);
          assert(inventoryNames(B).includes(term) && !inventoryNames(A).includes(term), `${label}: only the recompiled source puts the term in the approved inventory`);
          const row = skillRowId(skillId);
          assert(hasEvidence(B, row) && !hasEvidence(A, row), `${label}: the skill row exists only in the recompiled catalog`);
          const b = gradeResume(B, L, resumeDraft(B));
          assert(b.ok, `${label}: the recompiled skills block naming the term is accepted (${b.message})`);
          const bSame = gradeResume(B, L, withTerm(B, [row]));
          assert(bSame.ok, `${label}: the identical draft that source A rejected is accepted once the recompiled skill row is cited (${bSame.message})`);
          // The approved term still has to be CITED to evidence that states it: another skill's row does not carry it.
          const miscited = gradeResume(B, L, resumeDraft(B, [
            { id: 'skills-1', group: SKILL_GROUP, items: inventoryNames(A), evidenceIds: A.skillEvidence.skills.map(skill => skillRowId(skill.id)) },
            { id: 'skills-2', group: SKILL_GROUP, items: [term], evidenceIds: [skillRowId('skill-own')] },
          ]));
          assert(!miscited.ok && /must occur in its cited career-data evidence/u.test(miscited.message) && !notApproved.test(miscited.message),
            `${label}: an approved term cited to another skill's evidence is refused for the citation alone (${miscited.message})`);
          // Once the posting names a term the candidate has, the bounded index must carry it; omitting it is rejected by name.
          const omitted = gradeResume(B, L, resumeDraft(B, [{ id: 'skills-1', group: SKILL_GROUP, items: inventoryNames(A), evidenceIds: A.skillEvidence.skills.map(skill => skillRowId(skill.id)) }]));
          assert(!omitted.ok && omitted.message.includes(term), `${label}: omitting the now-supported term is rejected by name (${omitted.message})`);
          // C: B's text minus its line, recompiled: back to A.
          removeSourceLine(B, achievementLine(extra), A);
          const C = build(spec, [], { fresh: true });
          assert(C.snapshotId === A.snapshotId && !inventoryNames(C).includes(term), `${label}: removal restores the original inventory`);
          const c = gradeResume(C, L, withTerm(C, []));
          assert(!c.ok && notApproved.test(c.message), `${label}: the term is rejected again from source C (${c.message})`);
          const cCited = gradeResume(C, L, withTerm(C, [row]));
          assert(!cCited.ok && /unknown evidence ID/u.test(cCited.message), `${label}: and its removed skill row is an unknown evidence ID (${cCited.message})`);
        }
        const label = `${spec.key}/${L.key}`;
        const withTool = (context, evidence) => resumeDraft(context, [{
          id: 'skills-1', group: SKILL_GROUP, items: [...inventoryNames(A), L.tool],
          evidenceIds: [...A.skillEvidence.skills.map(skill => skillRowId(skill.id)), ...evidence],
        }]);
        // N1: the source only evaluated the product (an explicit non-skill disposition). N2: an either-or choice (relationship-qualified).
        const evaluated = build(spec, [extraFor(spec, `Evaluated ${L.tool} as a replacement for paper records.`, 'ach-listing', [{ name: L.tool, nonSkill: 'evaluated only; never used by the candidate' }])]);
        assert(!inventoryNames(evaluated).includes(L.tool), `${label}: an evaluated-only product is not in the approved inventory`);
        const n1 = gradeResume(evaluated, L, withTool(evaluated, [evidenceId('ach-listing')]));
        assert(!n1.ok && notApproved.test(n1.message) && !/must occur in its cited career-data evidence/u.test(n1.message),
          `${label}: an evaluated-only product is rejected as a skill although its name occurs in the cited evidence (${n1.message})`);
        const either = build(spec, [extraFor(spec, `Used ${L.tool} or ${L.altTool} to record ${base.obj}.`, 'ach-listing', [
          { name: L.tool, skillId: 'skill-listing', kind: 'tool', group: 'tool-choice' }, { name: L.altTool, skillId: 'skill-alt', kind: 'tool', group: 'tool-choice' },
        ])]);
        assert(!inventoryNames(either).includes(L.tool) && !inventoryNames(either).includes(L.altTool), `${label}: an either-or product is not a standalone inventory skill`);
        const n2 = gradeResume(either, L, withTool(either, [evidenceId('ach-listing')]));
        assert(!n2.ok && notApproved.test(n2.message) && !/must occur in its cited career-data evidence/u.test(n2.message),
          `${label}: an either-or product is rejected as a skill although its name occurs in the cited evidence (${n2.message})`);
        // A hand-built inventory that flattens the either-or relation into a standalone skill is not an approved projection at all.
        const flattened = {
          ...either.skillEvidence,
          skills: [...either.skillEvidence.skills, { id: 'skill-listing', name: L.tool, indexEligible: false, evidenceSegmentIds: [either.profile.achievements.at(-1).evidenceSegmentIds[0]], capabilityKind: 'tool', supportMode: 'relationship-qualified', directEvidenceSegmentIds: [] }],
        };
        const forged = gradeResume(either, L, withTool(either, [evidenceId('ach-listing')]), { careerSkillEvidence: flattened });
        assert(!forged.ok && /must be a direct, index-eligible v2 inventory skill/u.test(forged.message), `${label}: an inventory carrying the either-or product as a skill is refused as a configuration fault (${forged.message})`);
      }
    },
  },
  {
    name: 'Credentials: a degree, license or certification the listing requires is no candidate credential from A or from a near-miss record; the recompiled source admits it and removal undoes it',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const occurs = /must occur in its cited career-data evidence/u;
        for (const record of [
          {
            tag: 'license', section: 'credentials', extra: certExtra(L), rowIds: certificationRowIds('cert-listing'),
            item: (ids, overrides = {}) => ({ id: 'credential-1', name: L.certName, issuer: L.certIssuer, dates: L.certYear, evidenceIds: ids, ...overrides }),
            nears: [['name', certExtra(L, { name: L.certNameNear }), 'name'], ['issuer', certExtra(L, { issuer: 'Regional Skills Board' }), 'issuer'], ['year', certExtra(L, { dates: L.certYearNear }), 'dates']],
          },
          {
            tag: 'degree', section: 'education', extra: eduExtra(L), rowIds: educationRowIds('edu-listing'),
            item: (ids, overrides = {}) => ({ id: 'education-1', credential: L.degreeName, institution: L.degreeInstitution, dates: L.degreeYear, evidenceIds: ids, ...overrides }),
            nears: [['credential', eduExtra(L, { credential: L.degreeNameNear }), 'credential'], ['institution', eduExtra(L, { institution: 'Westmark Community College' }), 'institution'], ['year', eduExtra(L, { dates: L.degreeYearNear }), 'dates']],
          },
        ]) {
          const label = `${spec.key}/${L.key}/${record.tag}`;
          const draft = (context, item) => (record.section === 'credentials' ? resumeDraft(context, undefined, [item]) : resumeDraft(context, undefined, undefined, [item]));
          // A: the listing's credential, cited to career evidence that does not state it, or to the listing alone.
          const asserted = gradeResume(A, L, draft(A, record.item([evidenceId(base.id)])));
          assert(!asserted.ok && occurs.test(asserted.message), `${label}: a credential the career evidence does not state is refused (${asserted.message})`);
          const listingOnly = gradeResume(A, L, draft(A, record.item(['job-need'])));
          assert(!listingOnly.ok && /needs at least one career-data evidence ID/u.test(listingOnly.message), `${label}: a credential cited to the listing alone is refused (${listingOnly.message})`);
          assert(gradeResume(A, L, resumeDraft(A)).ok, `${label}: control: the same résumé without the credential is accepted`);
          // B: the source states the record; the identical item is admitted.
          const B = build(spec, [record.extra]);
          assert(B.snapshotId !== A.snapshotId && B.profile[record.section === 'credentials' ? 'certifications' : 'education'].length === 1, `${label}: recompiling the extended source yields the record`);
          assert(record.rowIds.every(id => hasEvidence(B, id)) && !record.rowIds.some(id => hasEvidence(A, id)), `${label}: its catalog rows exist only in the recompiled source`);
          const b = gradeResume(B, L, draft(B, record.item(record.rowIds)));
          assert(b.ok, `${label}: the identical credential item is accepted once the source states it (${b.message})`);
          // C: B's text minus its record, recompiled: refused again, and the removed rows are unknown evidence.
          removeSourceLine(B, record.extra.line, A);
          const C = build(spec, [], { fresh: true });
          const c = gradeResume(C, L, draft(C, record.item(record.rowIds)));
          assert(C.snapshotId === A.snapshotId && !c.ok && /unknown evidence ID/u.test(c.message), `${label}: and refused again after removal (${c.message})`);
          // N: near-miss records (a different credential, issuer or year) do not support the listing's.
          for (const [tag, extra, field] of record.nears) {
            const N = build(spec, [extra]);
            const n = gradeResume(N, L, draft(N, record.item(record.rowIds)));
            assert(!n.ok && occurs.test(n.message) && n.message.includes(`.${field} must occur`), `${label}: a source with a different ${tag} does not support the item, and the refusal names ${field} (${n.message})`);
          }
        }
      }
    },
  },
  {
    name: 'Role identity: the listing\'s job title and employer cannot replace, join or decorate the candidate\'s roles, and become admissible only as a role the recompiled source states',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const label = `${spec.key}/${L.key}`;
        const refuse = (what, mutate, pattern) => {
          const draft = resumeDraft(A);
          mutate(draft);
          const verdict = gradeResume(A, L, draft);
          assert(!verdict.ok && pattern.test(verdict.message), `${label}: ${what} is refused (${verdict.message})`);
        };
        refuse('the listing title as the candidate\'s role title', draft => { draft.roles[0].title = L.title; }, /roles\[0\]\.title must exactly match its trusted source role/u);
        refuse('the listing employer as the candidate\'s employer', draft => { draft.roles[0].company = L.company; }, /roles\[0\]\.company must exactly match its trusted source role/u);
        refuse('the listing title as the identity subtitle', draft => { draft.identity = { ...draft.identity, subtitleRole: L.title }; }, /identity\.subtitleRole must be omitted/u);
        refuse('an extra role at the listing employer', draft => {
          draft.roles.unshift({ ...draft.roles[0], id: 'role-listing', title: L.title, company: L.company, bullets: draft.roles[0].bullets.map(bullet => ({ ...bullet, id: 'bullet-listing-role' })) });
        }, /roles must retain every trusted source role exactly once/u);
        // B: the candidate really held that role. The recompiled source adds it as a trusted role, and the identical draft is accepted.
        const extraRole = {
          id: 'role-listing', title: L.title, employer: L.company, location: 'Remote', start: 'January 2011', end: 'December 2012',
          achievements: [{ id: 'ach-listing-role', line: 'Reviewed weekly operations reports for the regional office.' }],
        };
        const withRole = { ...spec, key: `${spec.key}+${L.key}-role`, roles: [...spec.roles, extraRole] };
        const B = build(withRole);
        const block = `${L.title} at ${L.company}\n${extraRole.location}\n${extraRole.start} to ${extraRole.end}\n${extraRole.achievements[0].line}\n\n`;
        assert(B.text.startsWith(A.text) && B.text.slice(A.text.length) === block, `${label}: B is source A plus exactly the role block`);
        assert(B.sourceRoles.length === A.sourceRoles.length + 1 && B.sourceRoles.some(role => role.title === L.title && role.company === L.company), `${label}: only the recompiled source has the role as a trusted source role`);
        const draftB = resumeDraft(B);
        assert(draftB.roles.some(role => role.title === L.title && role.company === L.company), `${label}: the draft for B carries the role`);
        const b = gradeResume(B, L, draftB);
        assert(b.ok, `${label}: the identical role is accepted once the source states it (${b.message})`);
        // C: the block removed from B's text is source A again; the draft that carries the role is refused again.
        const C = build(spec, [], { fresh: true });
        assert(B.text.slice(0, A.text.length) === C.text && C.snapshotId === A.snapshotId, `${label}: removing the block restores source A`);
        const c = gradeResume(C, L, draftB);
        assert(!c.ok && /roles must retain every trusted source role exactly once/u.test(c.message), `${label}: and the role is refused again after removal (${c.message})`);
      }
    },
  },
  {
    name: 'Listing-only citations: bullets and paragraphs that cite only job-listing evidence are refused by the structured-résumé gate and the assembler',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const label = `${spec.key}/${L.key}`;
        // The listing's own requirement sentence, verbatim, as if it were the candidate's accomplishment.
        const requirementAsBullet = `${L.ownBase} the work end to end for a team of ${L.teamSize}.`;
        const draftWithBullet = evidenceIds => {
          const draft = resumeDraft(A);
          draft.roles[0].bullets = [{ id: 'bullet-listing', text: requirementAsBullet, evidenceIds }];
          return draft;
        };
        const listingOnly = gradeResume(A, L, draftWithBullet(['job-need']));
        assert(!listingOnly.ok && /needs at least one career-data evidence ID; job-listing evidence alone cannot support rendered candidate content/u.test(listingOnly.message),
          `${label}: a bullet citing only listing evidence is refused (${listingOnly.message})`);
        assert(!gradeResume(A, L, draftWithBullet(['job-need', 'job-tool'])).ok, `${label}: two listing citations are no better than one`);
        assert(gradeResume(A, L, draftWithBullet(['job-need', evidenceId(base.id)])).ok, `${label}: the structured gate admits the citation shape once a career-data item is present (text truth is the grounding gate's job)`);
        const pasted = gradeUnit(A, { form: 'bullet', text: requirementAsBullet, evidenceIds: [evidenceId(base.id)] });
        assert(!pasted.ok && /unrelated/u.test(pasted.reason), `${label}: and the grounding gate then refuses the pasted requirement sentence as unrelated to the cited career quote (${pasted.reason})`);
        // The assembler is the second, independent holder of the same rule.
        const assembledBullet = attempt(() => assemblePasteApplicationResult(packageFor(A, L, { bullet: requirementAsBullet, bulletEvidenceIds: ['job-need'] })));
        assert(!assembledBullet.ok && /career-data evidence ID; job-listing evidence alone cannot support/u.test(assembledBullet.message), `${label}: assembly refuses a listing-only bullet (${assembledBullet.message})`);
        const assembledLetter = attempt(() => assemblePasteApplicationResult(packageFor(A, L, { paragraphEvidenceIds: ['job-need'] })));
        assert(!assembledLetter.ok && /job-listing evidence alone cannot support candidate copy/u.test(assembledLetter.message), `${label}: assembly refuses a listing-only cover-letter paragraph (${assembledLetter.message})`);
        assert(attempt(() => assemblePasteApplicationResult(packageFor(A, L))).ok, `${label}: the same package assembles when the paragraph also cites career evidence`);
      }
    },
  },
  {
    name: 'Durations: a listing\'s years-of-experience requirement is not the candidate\'s unless the cited source states that span, and the floor semantics follow the source, not the listing',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const exact = `I bring ${L.years} years of experience in ${L.field}.`;
        const floor = `I bring ${L.years}+ years of experience in ${L.field}.`;
        const quotesOf = (context, ids) => ids.map(id => catalogItem(context, id).quote);
        const verdict = (context, ids, text) => findUnsupportedDurationClaim(text, quotesOf(context, ids));
        const label = `${spec.key}/${L.key}`;
        const baseIds = [evidenceId(base.id)];
        assert(verdict(A, baseIds, exact)?.years === L.years && verdict(A, baseIds, floor)?.lowerBound === true, `${label}: neither the exact nor the floor span is supported by source A`);
        const stated = (line) => build(spec, [extraFor(spec, line)]);
        const B = stated(`Spent ${L.years} years working on ${base.obj}.`);
        assert(verdict(B, [...baseIds, evidenceId('ach-listing')], exact) === null && verdict(B, [...baseIds, evidenceId('ach-listing')], floor) === null,
          `${label}: a source stating exactly ${L.years} years supports both the exact and the floor claim`);
        const longer = stated(`Spent ${L.years + 3} years working on ${base.obj}.`);
        const longerIds = [...baseIds, evidenceId('ach-listing')];
        assert(verdict(longer, longerIds, floor) === null, `${label}: a longer stated span supports a floor claim`);
        const exactVsLonger = verdict(longer, longerIds, exact);
        assert(exactVsLonger && exactVsLonger.statedYears.includes(L.years + 3) && !exactVsLonger.statedYears.includes(L.years), `${label}: but an exact claim is not supported by a different stated span (${JSON.stringify(exactVsLonger)})`);
        const shorter = stated(`Spent ${L.yearsNear} years working on ${base.obj}.`);
        const shorterIds = [...baseIds, evidenceId('ach-listing')];
        assert(verdict(shorter, shorterIds, floor)?.lowerBound === true && verdict(shorter, shorterIds, exact) !== null, `${label}: a shorter stated span supports neither claim`);
        const C = build(spec, [], { fresh: true });
        assert(C.snapshotId === A.snapshotId && verdict(C, baseIds, exact) !== null, `${label}: removing the evidence restores the rejection`);
      }
    },
  },
  {
    name: 'Requirement workflow: a listing requirement without candidate evidence reduces to unsupported and selects nothing; recompiling flips it, removal flips it back',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const B = build(spec, [toolExtra(spec, L)]);
        const C = build(spec, [], { fresh: true });
        const wa = workflowFor(A, L);
        const wb = workflowFor(B, L);
        const wc = workflowFor(C, L);
        const label = `${spec.key}/${L.key}`;
        assert(wa.status('req-tool') === 'unsupported' && wa.status('req-work') === 'supported', `${label}: source A supports the work requirement and not the product requirement`);
        assert(wb.status('req-tool') === 'supported' && wb.status('req-work') === 'supported', `${label}: recompiled source B supports both`);
        assert(wc.status('req-tool') === 'unsupported' && wc.root.digest === wa.root.digest, `${label}: removal restores both the verdict and the exact workflow root`);
        assert(wa.root.digest !== wb.root.digest, `${label}: a different catalog is a different frozen root`);
        // Selection: "a short inventory is not evidence". The listing product is selected only when requirement evidence names it.
        assert(!wa.skillSelection.selectedSkillIds.includes('skill-listing') && wb.skillSelection.selectedSkillIds.includes('skill-listing'), `${label}: the product skill is selected only from the recompiled source`);
        assert(wa.skillSelection.selectedSkillIds.length === 0, `${label}: unmatched own skills are not selected merely because the inventory is short`);
        // Dispositions: omitted-no-evidence is legal exactly for requirements the exhaustive reduction left unsupported.
        const finalReferences = { documents: ['resume', 'cover-letter'], evidenceIds: ['job-need'] };
        const disposition = (workflow, choices, refs = {}) => {
          const plan = createDispositionPlan(workflow.requirements, 2);
          const response = {
            version: plan.version, planDigest: plan.digest, pageDigest: plan.pages[0].digest, reductionDigest: workflow.reduction.digest, finalReferencesDigest: authorityDigest(finalReferences),
            rows: workflow.requirements.map(row => ({
              requirementId: row.id, priority: row.priority, disposition: choices[row.id], justification: 'Reviewed against the exhaustive match reduction.',
              documentRefs: refs[row.id] ?? (choices[row.id] === 'omitted-no-evidence' ? [] : ['resume']),
            })),
          };
          return attempt(() => validateDispositionResponse({ plan, requirements: workflow.requirements, pageIndex: 0, response, reduction: workflow.reduction, finalReferences }));
        };
        assert(disposition(wa, { 'req-tool': 'omitted-no-evidence', 'req-work': 'addressed-resume' }).ok, `${label}: omitting the unsupported product requirement is legal from source A`);
        const omitSupported = disposition(wa, { 'req-tool': 'omitted-no-evidence', 'req-work': 'omitted-no-evidence' });
        assert(!omitSupported.ok && /omitted-no-evidence is legal only/u.test(omitSupported.message), `${label}: omitting a supported requirement is illegal (${omitSupported.message})`);
        const omitNowSupported = disposition(wb, { 'req-tool': 'omitted-no-evidence', 'req-work': 'addressed-resume' });
        assert(!omitNowSupported.ok && /omitted-no-evidence is legal only/u.test(omitNowSupported.message), `${label}: after recompiling, omitting the product requirement is illegal (${omitNowSupported.message})`);
        assert(disposition(wc, { 'req-tool': 'omitted-no-evidence', 'req-work': 'addressed-resume' }).ok, `${label}: after removal the omission is legal again`);
        // A requirement can be called addressed only by pointing at a final document, and only at one that exists.
        const unreferenced = disposition(wa, { 'req-tool': 'omitted-no-evidence', 'req-work': 'addressed-resume' }, { 'req-work': [] });
        assert(!unreferenced.ok && /addressed disposition must reference each final document/u.test(unreferenced.message), `${label}: an addressed disposition with no document reference is refused (${unreferenced.message})`);
        const phantom = disposition(wa, { 'req-tool': 'omitted-no-evidence', 'req-work': 'addressed-resume' }, { 'req-work': ['resume', 'job-phantom'] });
        assert(!phantom.ok && /outside the final frozen artifact/u.test(phantom.message), `${label}: a reference outside the final artifacts is refused (${phantom.message})`);
        // "Unsupported" is only ever concluded from the whole catalog: a reduction missing any page's match receipt is refused.
        const partial = attempt(() => reduceRequirementMatches(wa.root, wa.receipts.slice(1)));
        assert(!partial.ok && /match coverage is incomplete/u.test(partial.message), `${label}: a requirement cannot be reduced to unsupported after reading only part of the catalog (${partial.message})`);
        // Evidence selection is requirement-driven: nothing the reduction did not match is selected, and the product's row is selected only
        // from the recompiled source that has it.
        const picked = workflow => selectDraftEvidence({ catalog: workflow.catalog, requirements: workflow.requirements, reduction: workflow.reduction, maxEvidence: 64 }).selectedEvidenceIds;
        const matchedIds = workflow => new Set(workflow.reduction.aggregates.flatMap(row => row.matchedEvidenceIds));
        for (const [name, workflow] of [['A', wa], ['B', wb], ['C', wc]]) {
          assert(picked(workflow).length === matchedIds(workflow).size && picked(workflow).every(id => matchedIds(workflow).has(id)), `${label}: source ${name} selects exactly the evidence its requirements matched`);
        }
        assert(picked(wb).includes(evidenceId('ach-listing')) && !picked(wa).includes(evidenceId('ach-listing')) && JSON.stringify(picked(wc)) === JSON.stringify(picked(wa)), `${label}: the product's row is selectable only from the recompiled source`);
        // The matcher can only name catalog rows it was shown: a requirement or listing ID is not evidence.
        const pair = wa.pairs[0];
        const honest = wa.honestResponse(pair);
        const listingAsEvidence = structuredClone(honest);
        listingAsEvidence.rows[0] = { requirementId: 'req-tool', candidateEvidenceIds: ['req-tool'], localStatus: 'matched' };
        const forged = attempt(() => validateMatchResponse({ root: wa.root, pair, response: listingAsEvidence }));
        assert(!forged.ok && /outside its displayed catalog page/u.test(forged.message), `${label}: citing the listing requirement as match evidence is refused (${forged.message})`);
        const unevidenced = structuredClone(honest);
        unevidenced.rows[0] = { requirementId: 'req-tool', candidateEvidenceIds: [], localStatus: 'matched' };
        assert(!attempt(() => validateMatchResponse({ root: wa.root, pair, response: unevidenced })).ok, `${label}: a claimed match with no evidence is refused`);
      }
    },
  },
  {
    name: 'Draft selection: a listing-named skill or unselected evidence cannot appear in a draft; the skill is selectable only after the recompiled source supports it',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const B = build(spec, [toolExtra(spec, L)]);
        const C = build(spec, [], { fresh: true });
        const label = `${spec.key}/${L.key}`;
        const selectionFor = context => {
          const workflow = workflowFor(context, L);
          const selectedSkillIds = workflow.skillSelection.selectedSkillIds;
          const selectedNames = context.skillEvidence.skills.filter(skill => selectedSkillIds.includes(skill.id)).map(skill => skill.name);
          return {
            selectedSkillIds, selectedNames,
            selection: {
              selectedRoleIds: context.sourceRoles.map(role => role.id), selectedProjectIds: [], selectedEducationIds: [], selectedCertificationIds: [], selectedSkillIds,
              selectedEvidenceIds: [...context.spec.roles.map(role => evidenceId(role.achievements[0].id)), ...selectedSkillIds.map(skillRowId)],
            },
          };
        };
        const grade = (context, items, evidenceIds, selector = selectionFor(context)) => attempt(() => assertAuthorityDraftSelection({
          fullAuthority: { catalog: context.catalog, skills: context.skillEvidence.skills }, selection: selector.selection, acceptedNonAuthorityEvidenceIds: ['job-need', 'job-tool'],
          resume: resumeDraft(context, items.length ? [{ id: 'skills-1', group: SKILL_GROUP, items, evidenceIds }] : []), coverLetter: { paragraphs: [] },
        }));
        const forA = selectionFor(A);
        assert(grade(A, [], [], forA).ok, `${label}: an empty skill selection truthfully omits the skills block`);
        const aTool = grade(A, [L.tool], ['job-tool'], forA);
        assert(!aTool.ok && /unselected skill term/u.test(aTool.message), `${label}: the listing product in a draft is an unselected skill term from source A (${aTool.message})`);
        const forB = selectionFor(B);
        assert(forB.selectedNames.includes(L.tool), `${label}: the recompiled source selects the product`);
        assert(grade(B, forB.selectedNames, forB.selectedSkillIds.map(skillRowId), forB).ok, `${label}: the same draft naming the product is accepted after recompilation`);
        const bOther = grade(B, [...forB.selectedNames, 'An Unselected Term'], forB.selectedSkillIds.map(skillRowId), forB);
        assert(!bOther.ok && /unselected skill term/u.test(bOther.message), `${label}: terms outside the selection stay refused`);
        const forC = selectionFor(C);
        assert(!forC.selectedNames.includes(L.tool) && !grade(C, [L.tool], ['job-tool'], forC).ok, `${label}: after removal the product is unselectable and refused again`);
        // Citations outside the host selection are refused even when the ID is real.
        const unselected = attempt(() => assertAuthorityDraftSelection({
          fullAuthority: { catalog: A.catalog, skills: A.skillEvidence.skills }, selection: { ...forA.selection, selectedEvidenceIds: [] }, acceptedNonAuthorityEvidenceIds: ['job-need', 'job-tool'],
          resume: resumeDraft(A, []), coverLetter: { paragraphs: [] },
        }));
        assert(!unselected.ok && /unselected authority evidence/u.test(unselected.message), `${label}: a real but unselected career citation is refused (${unselected.message})`);
      }
    },
  },
  {
    name: 'Blind review: the fact channel carries a claim and its cited CAREER evidence only, never the listing, and follows the recompiled source',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const baseId = evidenceId(base.id);
        const label = `${spec.key}/${L.key}`;
        const kind = claimKind('ownership');
        const claim = kind.claim(base, L);
        const state = (context, bulletEvidenceIds) => blindState(context, L, { bullet: claim, bulletEvidenceIds, paragraph: `I ${lcfirst(base.verb)} ${base.obj}.`, paragraphEvidenceIds: [baseId, 'job-need'] });
        const listingFacts = [L.tool, L.company, L.need, L.population, L.budget, listingToolSentence(L)];
        const a = blindScopes(A, L, state(A, ['job-need', baseId]));
        const aFact = factScopeText(a.scopes);
        assert(a.fact.factClaims.every(item => !item.citedEvidenceIds.includes('job-need') && !item.citedEvidenceIds.includes('job-tool')), `${label}: listing citations are stripped from every fact claim`);
        assert(jsonHas(aFact, catalogItem(A, baseId).quote) && jsonHas(aFact, claim), `${label}: the fact reviewer sees the claim and the cited career quote`);
        assert(listingFacts.every(fact => !jsonHas(aFact, fact)), `${label}: no listing fact reaches the fact reviewer`);
        assert(jsonHas(tailoringScopeText(a.scopes), L.need) && jsonHas(tailoringScopeText(a.scopes), listingToolSentence(L)), `${label}: the listing is confined to the tailoring track`);
        assert(!jsonHas(tailoringScopeText(a.scopes), catalogItem(A, baseId).quote), `${label}: and the tailoring track does not carry career quotes as facts`);
        // A claim whose only citation is listing evidence has nothing to be reviewed against.
        const noCareer = attempt(() => __blindReviewFactEvidenceForTests(state(A, ['job-need']), { sourceRoles: A.sourceRoles }));
        assert(!noCareer.ok && /no cited career-data evidence/u.test(noCareer.message), `${label}: a listing-only claim is refused before review (${noCareer.message})`);
        // B: the recompiled evidence appears on the reviewer's page; C: it is gone again.
        const B = build(spec, [extraFor(spec, kind.support(base, L))]);
        const supportId = evidenceId('ach-listing');
        const b = blindScopes(B, L, state(B, [baseId, supportId]));
        assert(jsonHas(factScopeText(b.scopes), catalogItem(B, supportId).quote), `${label}: the reviewer is shown the line the recompiled source adds`);
        const C = build(spec, [], { fresh: true });
        const c = blindScopes(C, L, state(C, [baseId, supportId]));
        assert(!jsonHas(factScopeText(c.scopes), catalogItem(B, supportId).quote) && c.fact.factClaims[0].citedEvidenceIds.join() === baseId,
          `${label}: after removal the unresolved citation is dropped and the reviewer sees the base quote only`);
        // Employer attribution in prose needs evidence scoped to that employer's role.
        const second = A.sourceRoles[1];
        const crossRole = attempt(() => __blindReviewFactEvidenceForTests(blindState(A, L, {
          bullet: claim, bulletEvidenceIds: [baseId], paragraph: `I supported colleagues at ${second.company}.`, paragraphEvidenceIds: [baseId],
        }), { sourceRoles: A.sourceRoles }));
        assert(!crossRole.ok && /without career evidence deterministically scoped/u.test(crossRole.message), `${label}: naming an employer without role-scoped evidence is refused (${crossRole.message})`);
        const scoped = attempt(() => __blindReviewFactEvidenceForTests(blindState(A, L, {
          bullet: claim, bulletEvidenceIds: [baseId], paragraph: `I supported colleagues at ${second.company}.`, paragraphEvidenceIds: [evidenceId(spec.roles[1].achievements[0].id)],
        }), { sourceRoles: A.sourceRoles }));
        assert(scoped.ok, `${label}: the same sentence is accepted with that role's own evidence (${scoped.message})`);
      }
    },
  },
  {
    name: 'Target company: a named prospective employer is bound to the CURRENT listing, so the identical sentence flips verdict as the listing rotates',
    run() {
      for (const spec of CANDIDATES) {
        const A = build(spec);
        const prior = A.sourceRoles.map(role => role.company);
        assert(prior.length === spec.roles.length && prior.every(Boolean), `${spec.key}: the prior employers are the authority's trusted roles`);
        for (const target of LISTINGS) {
          for (const named of LISTINGS) {
            const sentence = [`I would bring this work to the team at ${named.company} on day one.`];
            const result = checkTargetCompanyBinding(sentence, target.company, prior);
            assert(result.passed === (named.key === target.key), `${spec.key}: naming ${named.company} while applying to ${target.company} is ${named.key === target.key ? 'accepted' : 'rejected'} (${result.detail})`);
            // The refusal is the binding rule, it names the company that was wrongly bound, and it is not the prior-employer arm.
            if (!result.passed) assert(result.detail.includes(named.company) && /bind future-facing work to this job/u.test(result.detail) && !/a prior employer/u.test(result.detail), `${spec.key}: the refusal names ${named.company} and is the target-binding rule (${result.detail})`);
          }
          for (const employer of prior) {
            const result = checkTargetCompanyBinding([`I would bring this work to the team at ${employer} on day one.`], target.company, prior);
            assert(!result.passed && /a prior employer/u.test(result.detail), `${spec.key}: a prospective sentence aimed at the prior employer ${employer} is refused`);
          }
        }
      }
    },
  },
  {
    name: 'Recompilation: snapshot, catalog and authority are content-addressed, and a citation to removed evidence stops resolving at every layer',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const extra = toolExtra(spec, L);
        const B = build(spec, [extra]);
        removeSourceLine(B, achievementLine(extra), A);
        const C = build(spec, [], { fresh: true });
        const label = `${spec.key}/${L.key}`;
        assert(A.snapshotId !== B.snapshotId && A.authority.digests.catalog !== B.authority.digests.catalog && A.authority.digests.snapshot !== B.authority.digests.snapshot,
          `${label}: a new source line is a new snapshot id, catalog digest and authority`);
        assert(C.snapshotId === A.snapshotId && C.authority.digests.catalog === A.authority.digests.catalog && C.authority.digests.snapshot === A.authority.digests.snapshot,
          `${label}: removing it returns every digest to the original`);
        // The B profile cannot be smuggled onto A's source: production refuses claims the source does not state.
        const stale = validateCareerProfile(B.profile, A.corpus);
        assert(!stale.valid && stale.errors.some(error => error.includes(`technology ${JSON.stringify(L.tool)} is not grounded`)),
          `${label}: B's profile does not validate against A's source because it names ${L.tool} (${stale.errors.slice(0, 2).join('; ')})`);
        // The evidence ID exists only in the authority compiled from the source that states it.
        const id = evidenceId('ach-listing');
        assert(attempt(() => resolveAuthorityEvidence(B.authority, id)).ok, `${label}: the evidence ID resolves in the authority compiled from B`);
        for (const [name, context] of [['A', A], ['C', C]]) {
          const gone = attempt(() => resolveAuthorityEvidence(context.authority, id));
          assert(!gone.ok && /Unknown authority evidence id/u.test(gone.message), `${label}: the evidence ID does not resolve in the authority compiled from ${name} (${gone.message})`);
        }
        // The structured-résumé layer: a bullet citing the line resolves from B and is an unknown ID from A and C.
        const bulletDraft = (context, evidenceIds) => {
          const draft = resumeDraft(context);
          draft.roles[0].bullets = [{ id: 'bullet-extra', text: achievementLine(extra), evidenceIds }];
          return draft;
        };
        assert(gradeResume(B, L, bulletDraft(B, [id])).ok, `${label}: the structured gate admits a bullet citing B's own line`);
        for (const [name, context] of [['A', A], ['C', C]]) {
          const gone = gradeResume(context, L, bulletDraft(context, [id]));
          assert(!gone.ok && /references unknown evidence ID/u.test(gone.message), `${label}: the same bullet cites an unknown evidence ID under ${name} (${gone.message})`);
        }
        // ...and so does a bullet that cites an ID that never existed (a requirement or a made-up row), not just a removed one.
        const invented = gradeResume(A, L, bulletDraft(A, [evidenceId(base.id), 'job-listing-requirement']));
        assert(!invented.ok && /references unknown evidence ID "job-listing-requirement"/u.test(invented.message), `${label}: an ID the plan never held is unknown (${invented.message})`);
      }
    },
  },
  {
    name: 'Compile gate: unfaithful compiler output that carries a listing fact absent from the source is refused as ungrounded, naming the unsupported field',
    run() {
      // The offline compiler is a faithful transcriber, so the unfaithful case is modelled by mutating the PROFILE after
      // transcription: every field below takes a value the LISTING states and the candidate's source does not. Each tamper must
      // be rejected for the grounding reason alone (no schema or linkage error stands in for it), and the same fact compiled
      // from a source that states it is a valid profile.
      const groundingOnly = /not grounded|not literally grounded|do not literally demonstrate the skill name|without reciprocal coverage|has no source-linked skill or non-skill disposition/u;
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const base = baseOf(spec);
        const label = `${spec.key}/${L.key}`;
        const segmentId = A.profile.achievements[0].evidenceSegmentIds[0];
        const tamper = (fn) => { const profile = structuredClone(A.profile); fn(profile); return validateCareerProfile(profile, A.corpus); };
        const refused = (what, verdict, expected) => {
          assert(!verdict.valid, `${label}: ${what} is refused`);
          for (const pattern of expected) assert(verdict.errors.some(error => pattern.test(error)), `${label}: ${what}: expected ${pattern} in ${JSON.stringify(verdict.errors)}`);
          assert(verdict.errors.every(error => groundingOnly.test(error)), `${label}: ${what}: every refusal is a grounding refusal (${verdict.errors.join('; ')})`);
        };
        assert(tamper(() => {}).valid, `${label}: control: the untouched transcription is a valid profile`);
        refused('a listing product added as an ungrounded skill', tamper(profile => {
          profile.achievements[0].technologies.push(L.tool);
          profile.achievements[0].technologyReferences.push({ technology: L.tool, disposition: 'skill', skillId: 'skill-listing', relationship: 'independent', relationshipGroup: '', relationshipEvidence: achievementLine(base), evidenceSegmentIds: [segmentId] });
          profile.skills.push({ id: 'skill-listing', name: L.tool, category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: [segmentId], indexEligible: true, roleIds: [profile.roles[0].id], evidenceSegmentIds: [segmentId] });
          profile.roles[0].skillIds.push('skill-listing');
        }), [new RegExp(`technology ${escapeRegExp(JSON.stringify(L.tool))} is not grounded`, 'u'), /skills\[skill-listing\]\.name is not grounded/u, /do not literally demonstrate the skill name/u]);
        refused('a listing product embellishing a real claim', tamper(profile => { profile.achievements[0].claim = `${achievementLine(base).replace(/\.$/u, '')} using ${L.tool}.`; }), [/achievements\[ach-base\]\.claim is not grounded/u]);
        refused('a listing metric attached to a real achievement', tamper(profile => { profile.achievements[0].metrics.push({ label: L.metricNoun, value: L.pct, unit: '%', evidenceSegmentIds: [segmentId] }); }),
          [/metric label is not grounded/u, /metric value is not grounded/u]);
        refused('the listing employer replacing the real one', tamper(profile => { profile.roles[0].employer = L.company; }), [/roles\[role-[a-z]+\]\.employer is not grounded/u]);
        refused('the employer\'s founding year as the candidate\'s start date', tamper(profile => { profile.roles[0].startDate = `January ${L.foundedYear}`; }), [/roles\[role-[a-z]+\]\.startDate is not grounded/u]);
        refused('a listing credential invented as a certification', tamper(profile => {
          profile.certifications.push({ id: 'cert-listing', name: L.certName, issuer: L.certIssuer, dates: L.certYear, evidenceSegmentIds: [segmentId] });
        }), [/certifications\[cert-listing\]\.name is not grounded/u, /certifications\[cert-listing\]\.issuer is not grounded/u, /certifications\[cert-listing\]\.dates is not grounded/u]);
        refused('a listing degree invented as an education record', tamper(profile => {
          profile.education.push({ id: 'edu-listing', credential: L.degreeName, institution: L.degreeInstitution, dates: L.degreeYear, evidenceSegmentIds: [segmentId] });
        }), [/education\[edu-listing\]\.credential is not grounded/u, /education\[edu-listing\]\.institution is not grounded/u]);
        // The same facts compiled from a source that states them are valid profiles (build() asserts the verdict), so the refusals above
        // are about the source, not about the shape.
        assert(build(spec, [toolExtra(spec, L)]).profile.skills.some(skill => skill.name === L.tool), `${label}: the product is a skill of the profile compiled from a source that states using it`);
        assert(build(spec, [certExtra(L)]).profile.certifications.length === 1 && build(spec, [eduExtra(L)]).profile.education.length === 1, `${label}: the credential and degree are records of the profiles compiled from sources that state them`);
      }
    },
  },
  {
    name: 'Rotation invariance: what a candidate may claim depends on the approved source alone; the identical draft gets the same verdict under every listing',
    run() {
      for (const spec of CANDIDATES) {
        const A = build(spec);
        const sources = [{ label: 'A', context: A, supported: null }, ...LISTINGS.map(Lj => ({ label: `B(${Lj.key})`, context: build(spec, [toolExtra(spec, Lj)]), supported: Lj }))];
        for (const { label, context, supported } of sources) {
          for (const Li of LISTINGS) {           // the listing being applied to
            for (const Lk of LISTINGS) {         // the product the draft claims
              const expected = Boolean(supported && supported.key === Lk.key);
              // The faithful block always carries every approved skill (the supported product included), so any
              // refusal is attributable to the extra claimed product alone.
              const groups = defaultSkillGroups(context);
              if (!expected) groups.push({ id: 'skills-2', group: 'platforms', items: [Lk.tool], evidenceIds: [skillRowId('skill-own')] });
              const verdict = gradeResume(context, Li, resumeDraft(context, groups));
              assert(verdict.ok === expected, `${spec.key} ${label}: applying to ${Li.key}, claiming ${Lk.tool} is ${expected ? 'accepted' : 'rejected'} regardless of the listing (${verdict.message})`);
              if (!expected) assert(verdict.message.includes(Lk.tool) && /not an exact, index-eligible approved snapshot skill/u.test(verdict.message), `${spec.key} ${label}: the refusal names the claimed product (${verdict.message})`);
            }
            // The unrelated-listing case is explicit: a supported product is accepted even where this listing never mentions it.
            if (supported && supported.key !== Li.key) assert(!listingText(Li).includes(supported.tool), `${spec.key}: ${Li.key} never mentions ${supported.tool}`);
          }
        }
      }
    },
  },
  {
    // A claim's verdict is a function of the approved source alone. The same recompiled source B_i that supports the claim derived
    // from listing i supports NO claim derived from another listing j: rotating the posting must not widen what the candidate may say.
    // (The outcome kind is excluded: its production rule is on the result WORD, not on what the result is about, so a source that states
    // any reduction supports "reducing X" for every X; that is the outcome variant of the appended-clause [fixed defect] test.)
    name: 'Claim rotation: a source that states the claim derived from listing i supports no claim derived from any other listing',
    run() {
      let verdicts = 0;
      for (const spec of CANDIDATES) {
        const A = build(spec);
        const base = baseOf(spec);
        for (const kind of CLAIM_KINDS.filter(candidate => candidate.rotates !== false)) {
          for (const form of kind.forms) {
            for (const Li of LISTINGS) {
              const supportedSource = build(spec, [extraFor(spec, kind.support(base, Li))]);
              for (const Lj of LISTINGS) {
                const label = `${spec.key}/${kind.id}/${form}: source states listing ${Li.key}'s fact, claim is listing ${Lj.key}'s`;
                const text = formText(kind, form, A, Lj);
                const verdict = gradeUnit(supportedSource, { form, text, evidenceIds: [evidenceId(base.id), evidenceId('ach-listing')] });
                if (Li.key === Lj.key) assert(verdict.ok, `${label}: accepted (${verdict.reason})`);
                else assert(!verdict.ok && ruleFor(kind, form, Lj).test(verdict.reason), `${label}: ${JSON.stringify(text)} refused for its own reason (${verdict.reason})`);
                verdicts += 1;
              }
            }
          }
        }
      }
      return { verdicts };
    },
  },
  {
    // The population and employer-year arms of pasteAttributionScopeErrors run in the paste-stage validator
    // (pasteUnitGroundingErrors), not in validateLocalApplicationResult, so this end-to-end test exercises exactly
    // the kinds the completion gate itself owns; the unit-level test above covers the rest.
    name: 'Completion gate: the full assembled package is accepted from every faithful source for every listing',
    run() {
      for (const { spec, L } of PAIRS) {
        const outcome = completePackage(build(spec), L);
        assert(outcome.ok, `${spec.key}/${L.key}: the faithful package completes (${outcome.stage}: ${outcome.message})`);
      }
    },
  },
  {
    name: 'Completion gate: the evidence a letter argues from must be a final résumé bullet (never a listing sentence), and the need it answers must be quoted from the CURRENT listing',
    run() {
      for (const { spec, L } of PAIRS) {
        const A = build(spec);
        const label = `${spec.key}/${L.key}`;
        assert(completePackage(A, L).ok, `${label}: control: the faithful package completes`);
        // The argument's evidence is offered as the candidate's proof. A listing requirement, or the listing's own need, is not a bullet.
        // The bullet binding refuses all three. The second, independent holder (token grounding in the bullets) is asserted where the text
        // cannot legitimately overlap the candidate's work; a short listing need may share terms with a candidate whose work is the same.
        for (const [what, argumentEvidence, alsoUngrounded] of [
          ['the listing requirement sentence', listingToolSentence(L), true], ['the listing need', L.need, false], ['the employer line', `${L.company} serves ${L.population}.`, true],
        ]) {
          const outcome = completePackage(A, L, { argumentEvidence });
          assert(!outcome.ok && outcome.stage === 'validate' && /coverLetterArgument evidence 1 does not match a final résumé bullet/u.test(outcome.message),
            `${label}: argument evidence that is ${what} is refused (${outcome.stage}: ${outcome.message})`);
          if (alsoUngrounded) assert(/evidence-grounding/u.test(outcome.message), `${label}: and ${what} is also ungrounded in the final bullets (${outcome.message})`);
        }
        // The need the paragraph answers is quoted from the posting being applied to: another posting's need is refused, however real it is.
        for (const other of LISTINGS.filter(candidate => candidate.key !== L.key)) {
          const outcome = completePackage(A, L, { jobNeedQuote: other.need });
          assert(!outcome.ok && outcome.stage === 'validate' && /argumentMapping\.jobNeedQuote does not occur in context\.jobListing/u.test(outcome.message),
            `${label}: a need quoted from the ${other.key} posting is refused when applying to the ${L.key} posting (${outcome.stage}: ${outcome.message})`);
          assert(completePackage(A, other, { jobNeedQuote: other.need }).ok, `${label}: and the same quote is accepted when applying to the posting that states it`);
        }
      }
    },
  },
  {
    name: 'Completion gate: a listing-derived ownership, figure, duration, outcome or scope claim in an assembled package is refused unless the recompiled source states it, and a pasted requirement sentence is never a bullet',
    run() {
      const kinds = ['ownership', 'currency', 'percent', 'duration', 'outcome', 'scope'].map(claimKind);
      let verdicts = 0;
      // One rotating listing per candidate keeps the matrix small while every listing is exercised.
      for (const [index, spec] of CANDIDATES.entries()) {
        const L = LISTINGS[index % LISTINGS.length];
        const A = build(spec);
        const base = baseOf(spec);
        const baseIds = [evidenceId(base.id)];
        for (const kind of kinds) {
          const claim = kind.claim(base, L, spec);
          const label = `${spec.key}/${L.key}/${kind.id}`;
          const a = completePackage(A, L, { bullet: claim, bulletEvidenceIds: baseIds });
          assert(!a.ok && a.stage === 'validate' && ruleFor(kind, 'bullet', L).test(a.message), `${label}: the completion gate refuses the unsupported claim for its own reason (${a.stage}: ${a.message})`);
          const B = build(spec, [extraFor(spec, kind.support(base, L))]);
          const b = completePackage(B, L, { bullet: claim, bulletEvidenceIds: [...baseIds, evidenceId('ach-listing')] });
          assert(b.ok, `${label}: the identical bullet completes from the recompiled source (${b.stage}: ${b.message})`);
          removeSourceLine(B, achievementLine(extraFor(spec, kind.support(base, L))), A);
          const C = build(spec, [], { fresh: true });
          const c = completePackage(C, L, { bullet: claim, bulletEvidenceIds: baseIds });
          assert(!c.ok && c.stage === 'validate' && ruleFor(kind, 'bullet', L).test(c.message), `${label}: and is refused again after removal (${c.stage}: ${c.message})`);
          const N = build(spec, [extraFor(spec, kind.near(base, L))]);
          const n = completePackage(N, L, { bullet: claim, bulletEvidenceIds: [...baseIds, evidenceId('ach-listing')] });
          assert(!n.ok && ruleFor(kind, 'bullet', L).test(n.message), `${label}: a near-miss source does not complete it (${n.stage}: ${n.message})`);
          verdicts += 4;
        }
        // Rotation: the verdict on a fixed claim text does not depend on which listing the package is for.
        if (index === 0) {
          const claim = claimKind('ownership').claim(base, LISTINGS[0]);
          const supported = build(spec, [extraFor(spec, claimKind('ownership').support(base, LISTINGS[0]))]);
          for (const Lr of LISTINGS) {
            const refused = completePackage(A, Lr, { bullet: claim, bulletEvidenceIds: baseIds });
            assert(!refused.ok && claimKind('ownership').rule.test(refused.message), `${spec.key}: ${JSON.stringify(claim)} is refused when applying to ${Lr.key} (${refused.message})`);
            const admitted = completePackage(supported, Lr, { bullet: claim, bulletEvidenceIds: [...baseIds, evidenceId('ach-listing')] });
            assert(admitted.ok, `${spec.key}: and accepted when applying to ${Lr.key} once the source states it (${admitted.message})`);
          }
        }
        // The listing's own requirement sentence, pasted as an accomplishment under a real citation, shares nothing with it.
        const pasted = completePackage(A, L, { bullet: `${L.ownBase} the work end to end for a team of ${L.teamSize}.`, bulletEvidenceIds: baseIds });
        assert(!pasted.ok && pasted.stage === 'validate' && /unrelated/u.test(pasted.message), `${spec.key}/${L.key}: a pasted requirement sentence is unrelated to the cited career quote (${pasted.stage}: ${pasted.message})`);
      }
      return { verdicts };
    },
  },
  {
    // localAiApplication.js assertSourceQuoteLinksFinalText (bullet path: token overlap + qualifier/figure/duration only) and
    // isCandidateCareerSentence (a present-tense "I have hands-on experience with X" is not graded at all). The same product in a
    // skills group IS refused (structuredResume.js normalizeSkills + the approved snapshot inventory).
    name: 'Listing-derived claims [fixed defect]: a listing-named product asserted as use, hands-on experience or proficiency in a bullet or letter sentence is accepted from evidence that never states using it',
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const sources = [
          { tag: 'absent', context: build(spec) },
          { tag: 'evaluated-only', context: build(spec, [extraFor(spec, `Evaluated ${L.tool} as a replacement for paper records.`, 'ach-listing', [{ name: L.tool, nonSkill: 'evaluated only; never used by the candidate' }])]) },
          { tag: 'either-or', context: build(spec, [extraFor(spec, `Used ${L.tool} or ${L.altTool} to record ${base.obj}.`, 'ach-listing', [
            { name: L.tool, skillId: 'skill-listing', kind: 'tool', group: 'tool-choice' }, { name: L.altTool, skillId: 'skill-alt', kind: 'tool', group: 'tool-choice' },
          ])]) },
        ];
        for (const { tag, context } of sources) {
          const evidenceIds = [evidenceId(base.id), ...(hasEvidence(context, evidenceId('ach-listing')) ? [evidenceId('ach-listing')] : [])];
          const label = `${spec.key}/${L.key}/${tag}`;
          for (const bullet of [`${base.verb} ${base.obj} using ${L.tool}.`, `Proficient in ${L.tool}; ${lcfirst(base.verb)} ${base.obj}.`]) {
            claims.push({ label, context, L, form: 'bullet', text: bullet, evidenceIds, bullet });
          }
          const proof = `${spec.letter.proof.replace(/\.$/u, '')} and I have hands-on experience with ${L.tool}.`;
          claims.push({ label, context, L, form: 'paragraph', text: proof, evidenceIds, proof });
        }
      }
      // Control: the same product as a SKILLS item is refused from every one of these sources.
      for (const { spec, L } of PAIRS) {
        const context = build(spec);
        const groups = [...defaultSkillGroups(context), { id: 'skills-2', group: 'platforms', items: [L.tool], evidenceIds: [skillRowId('skill-own')] }];
        assert(!gradeResume(context, L, resumeDraft(context, groups)).ok, `${spec.key}/${L.key}: control: the skills block refuses the product`);
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} product claims reached the candidate unsupported, e.g. ${accepted.slice(0, 3).join(' || ')}`);
    },
  },
  {
    // localAiApplication.js pasteAttributionScopeErrors (only the candidate's own approved role employers are attribution-checked)
    // and coverLetterChecks.js checkTargetCompanyBinding (only prospective "I would ... at X" frames are checked).
    name: "Listing-derived claims [fixed defect]: past work attributed to the LISTING'S employer, which is not one of the candidate's approved roles, is accepted",
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const context = build(spec);
        const text = `At ${L.company}, I ${lcfirst(base.verb)} ${base.obj}.`;
        claims.push({ label: `${spec.key}/${L.key}`, context, L, form: 'paragraph', text, evidenceIds: [evidenceId(base.id)], proof: `At ${L.company}, ${spec.letter.proof}` });
        // Control: attributing to a candidate employer the evidence does not name IS refused.
        const wrong = gradeUnit(context, { form: 'paragraph', text: `At ${spec.roles[1].employer}, I ${lcfirst(base.verb)} ${base.obj}.`, evidenceIds: [evidenceId(base.id)] });
        assert(!wrong.ok, `${spec.key}/${L.key}: control: a wrong candidate employer is refused`);
        assert(checkTargetCompanyBinding([`I would bring this work to the team at ${spec.roles[1].employer}.`], L.company, spec.roles.map(role => role.employer)).passed === false, 'control: prospective misdirection is refused');
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} attributions of the candidate's work to the listing employer were accepted, e.g. ${accepted.slice(0, 2).join(' || ')}`);
    },
  },
  {
    // The credentials/education sections are evidence-gated (structuredResume.js normalizeCredentialItems), but a credential asserted
    // in bullet or letter PROSE has no counterpart: assertSourceQuoteLinksFinalText compares only qualifiers, figures, durations and token
    // overlap, and a present-tense "I hold ..." sentence is not graded at all.
    name: 'Listing-derived claims [fixed defect]: a degree, license or certification the listing requires is asserted as held in bullet or letter prose when the source has no such record',
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const context = build(spec);
        const evidenceIds = [evidenceId(base.id)];
        const bullet = `${base.verb} ${base.obj} while holding ${L.credential}.`;
        claims.push({ label: `${spec.key}/${L.key}`, context, L, form: 'bullet', text: bullet, evidenceIds, bullet });
        const proof = `${spec.letter.proof.replace(/\.$/u, '')} while holding ${L.credential}.`;
        claims.push({ label: `${spec.key}/${L.key}`, context, L, form: 'paragraph', text: proof, evidenceIds, proof });
        // Control: the same credential as a credentials ITEM is refused.
        const asItem = gradeResume(context, L, resumeDraft(context, undefined, [{ id: 'credential-1', name: L.certName, issuer: L.certIssuer, dates: L.certYear, evidenceIds }]));
        assert(!asItem.ok, `${spec.key}/${L.key}: control: the credentials section refuses the record`);
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} credential claims were accepted without a certification record, e.g. ${accepted.slice(0, 2).join(' || ')}`);
    },
  },
  {
    // localAiApplication.js sourceGroundingFigures ("Bare numerals are too ambiguous for a factual gate") and the closed noun list in
    // pasteAttributionScopeErrors (users/students/customers/residents/patients/...): a headcount or a count of anything else is never compared.
    name: 'Listing-derived claims [fixed defect]: a bare headcount from the listing ("a team of 40") is accepted from evidence that states no count or a different one',
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const text = `${base.verb} ${base.obj} for a team of ${L.teamSize}.`;
        const sources = [
          { tag: 'no count', context: build(spec) },
          { tag: `states ${L.teamNear}`, context: build(spec, [extraFor(spec, `Worked with a team of ${L.teamNear} on ${base.obj}.`)]) },
        ];
        for (const { tag, context } of sources) {
          const evidenceIds = [evidenceId(base.id), ...(hasEvidence(context, evidenceId('ach-listing')) ? [evidenceId('ach-listing')] : [])];
          claims.push({ label: `${spec.key}/${L.key}/${tag}`, context, L, form: 'bullet', text, evidenceIds, bullet: text });
        }
        // Control: the same shape with a currency amount IS compared against the evidence.
        assert(!gradeUnit(build(spec), { form: 'bullet', text: `${base.verb} ${base.obj} on a ${L.budget} budget.`, evidenceIds: [evidenceId(base.id)] }).ok, `${spec.key}/${L.key}: control: an unsupported currency figure is refused`);
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} headcount claims were accepted, e.g. ${accepted.slice(0, 2).join(' || ')}`);
    },
  },
  {
    // coverLetterChecks.js DURATION_CLAIM_RE: a span is read as a claim only with a bound, a hedge, or the word "experience" nearby
    // (a documented precision trade-off), and localAiApplication.js pasteAttributionScopeErrors reads a year only beside a named employer.
    name: 'Listing-derived claims [fixed defect]: a duration or start year from the listing phrased without the "years of experience" shape ("for 6 years", "over a decade", "since 2021") is accepted',
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const context = build(spec);
        const wrong = build(spec, [extraFor(spec, `Spent ${L.yearsNear} years working on ${base.obj}.`)]);
        for (const text of [`${base.verb} ${base.obj} for ${L.years} years.`, `${base.verb} ${base.obj} for over a decade.`, `${base.verb} ${base.obj} since ${L.foundedYear}.`]) {
          claims.push({ label: `${spec.key}/${L.key}/absent`, context, L, form: 'bullet', text, evidenceIds: [evidenceId(base.id)], bullet: text });
        }
        claims.push({ label: `${spec.key}/${L.key}/states ${L.yearsNear}`, context: wrong, L, form: 'bullet', text: `${base.verb} ${base.obj} for ${L.years} years.`, evidenceIds: [evidenceId(base.id), evidenceId('ach-listing')], bullet: `${base.verb} ${base.obj} for ${L.years} years.` });
        // Control: the "experience" shape of the same span IS refused.
        assert(!gradeUnit(context, { form: 'bullet', text: `${base.verb} ${base.obj}, drawing on ${L.years} years of experience.`, evidenceIds: [evidenceId(base.id)] }).ok, `${spec.key}/${L.key}: control: the marked span is refused`);
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} unmarked durations or start years were accepted, e.g. ${accepted.slice(0, 2).join(' || ')}`);
    },
  },
  {
    // localAiApplication.js assertSourceQuoteLinksFinalText: a bullet is compared to its quotes as ONE bag of terms (two shared terms
    // pass the whole bullet) and a letter sentence likewise, so a listing responsibility appended to supported work as a trailing clause
    // rides on the supported words. The same responsibility as its own bullet or its own sentence IS refused (controls below), and the
    // result-word qualifier (reducing, improving) is compared as a word, not for what it is about.
    name: 'Listing-derived claims [fixed defect]: a listing responsibility or metric appended as a clause to supported work is accepted, though the same words as their own bullet or sentence are refused',
    run() {
      const claims = [];
      for (const { spec, L } of PAIRS) {
        const base = baseOf(spec);
        const context = build(spec);
        const evidenceIds = [evidenceId(base.id)];
        // Control: the responsibility on its own is unrelated to the cited quote, as a bullet and as a letter sentence beside a grounded one.
        assert(!gradeUnit(context, { form: 'bullet', text: `Negotiated ${L.duty}.`, evidenceIds }).ok, `${spec.key}/${L.key}: control: the responsibility as its own bullet is refused`);
        assert(!gradeUnit(context, { form: 'paragraph', text: `${spec.letter.proof} I negotiated ${L.duty}.`, evidenceIds }).ok, `${spec.key}/${L.key}: control: the responsibility as its own letter sentence is refused`);
        const bullet = `${base.verb} ${base.obj} and negotiated ${L.duty}.`;
        claims.push({ label: `${spec.key}/${L.key}/duty-clause`, context, L, form: 'bullet', text: bullet, evidenceIds, bullet });
        const proof = `${spec.letter.proof.replace(/\.$/u, '')} and I negotiated ${L.duty}.`;
        claims.push({ label: `${spec.key}/${L.key}/duty-clause`, context, L, form: 'paragraph', text: proof, evidenceIds, proof });
        // A reduction the source states about something ELSE supports "reducing <the listing's metric>": the word is compared, not its object.
        const other = LISTINGS.find(candidate => candidate.metricNoun !== L.metricNoun && candidate.outcomeWord.claimed === L.outcomeWord.claimed) || LISTINGS.find(candidate => candidate.metricNoun !== L.metricNoun);
        const elsewhere = build(spec, [extraFor(spec, `${other.outcomeWord.stated} ${other.metricNoun} through the ${base.obj}.`)]);
        const outcome = `${base.verb} ${base.obj}, ${other.outcomeWord.claimed} ${L.metricNoun}.`;
        claims.push({ label: `${spec.key}/${L.key}/outcome-of-another-metric`, context: elsewhere, L, form: 'bullet', text: outcome, evidenceIds: [...evidenceIds, evidenceId('ach-listing')], bullet: outcome });
      }
      const accepted = acceptedByPipeline(claims);
      assert(accepted.length === 0, `${accepted.length} appended responsibility or metric claims were accepted, e.g. ${accepted.slice(0, 2).join(' || ')}`);
    },
  },
];

// ---------------------------------------------------------------------------
// Helper of the `[fixed defect]` tests above, and `knownGaps`: none. Every claim those
// tests probe is derived from the LISTING (its product, company, numbers) and bolted
// onto work the candidate really did; every source used is one that does not support
// it. A production behaviour that violates an invariant but is not yet fixed goes in
// `knownGaps`; the registry does not run it, so each entry must throw today.
// ---------------------------------------------------------------------------

/** Run every (source, claim) pair through the unit grounding composition and the completion gate. */
function acceptedByPipeline(claims) {
  const accepted = [];
  for (const { label, context, L, form, text, evidenceIds, bullet, proof } of claims) {
    if (gradeUnit(context, { form, text, evidenceIds }).ok) accepted.push(`${label} [unit grounding] ${JSON.stringify(text)}`);
    const complete = completePackage(context, L, bullet !== undefined ? { bullet, bulletEvidenceIds: evidenceIds } : { proof });
    if (complete.ok) accepted.push(`${label} [completion gate] ${JSON.stringify(text)}`);
  }
  return accepted;
}

export const knownGaps = [];
