// Adaptability family: METRICS / QUANTITIES / SCALE.
//
// Project rule: a number, percentage, currency amount, count, population, scale
// word ("millions", "enterprise-scale") or comparative ("reduced by half") in a
// generated application may only appear when the CURRENT approved career
// evidence states it, attached to the thing it was stated about. Nothing in
// production names a person, an employer, or a figure; the allowed set is
// whatever the approved snapshot says right now.
//
// This file proves that with the real production seams and no re-implemented
// logic:
//   * electron/ipc/careerSnapshot.js            validateCareerProfile (compiler gate),
//                                                validateCurrentCareerSnapshot (approval/read
//                                                gate), approvedCareerEvidenceCatalog (the
//                                                runtime fact boundary generation reads)
//   * electron/ipc/localAiApplication.js        assertSourceQuoteLinksFinalText (percent /
//                                                currency / multiplier / qualifier / scale
//                                                gate for a bullet or paragraph),
//                                                pasteAttributionScopeErrors (population gate)
//   * electron/ipc/coverLetterChecks.js         checkFigureDiscipline, findUnsupportedDurationClaim
//
// The synthetic candidates below are ordinary fiction in unrelated fields. The
// only thing the tests hand-write is SOURCE TEXT (and a faithful "transcription"
// of it into a profile, which is what the AI compiler does in production). Every
// verdict about what may be claimed comes from running production code over the
// snapshot compiled from that text. Each family follows the mutation pattern:
//   A  source without the quantity          -> claim rejected
//   B  A + one directly supporting line     -> recompiled (new snapshot id) -> accepted
//   C  B with that line removed (== A)      -> same id as A -> rejected again
// plus near-miss mutations of the supported quantity, run across every candidate.
//
// C is produced by REMOVING B's lines from B's source text and recompiling, so
// "removal revokes" and "the snapshot id follows the source text" are proven,
// not true by construction. A unit's population gate is handed the whole accepted
// plan and only the cited ids, the way production calls it. Every rejection asserts
// the production reason it is meant to isolate. Regressing any of these in a scratch
// copy of production fails at least one default test: figure kind / value /
// denomination / magnitude / sign, population count / noun / cited-ids binding,
// qualifier rules, duration gate, letter budget / anchors, metric grounding and
// parent binding, catalog metric lines, content-addressed snapshot id.
//
// Tests tagged `[fixed defect]` guard production gaps this sweep found and that
// have since been fixed (vague scale language, comparative magnitude, bare-count
// and bounded-count inflation, the "N+" population crash, population under a noun
// outside the closed list, a changed rate interval, spelled-out figures,
// metric/claim truncation at the profile gate, and the letter figure gate's blind
// spots). The one remaining gap, metric label/value association on a shared source
// line, is delegated by design to the independent metrics auditor and stays in the
// named export `knownGaps`, which the registry does not run. The comment above each
// `[fixed defect]` test describes the defect as it was before the fix.
import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_STATUS_APPROVED,
  approvedCareerEvidenceCatalog,
  buildCareerSourceCorpus,
  canonicalCareerProfileDigest,
  careerSnapshotId,
  emptyCareerReconciliationReceipt,
  partitionCareerSourcePages,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';
import { assertSourceQuoteLinksFinalText, pasteAttributionScopeErrors } from '../../electron/ipc/localAiApplication.js';
import { MAX_LETTER_FIGURES, checkFigureDiscipline, findUnsupportedDurationClaim } from '../../electron/ipc/coverLetterChecks.js';

// ---------------------------------------------------------------------------
// Synthetic candidates. Fiction only: invented people, employers and numbers.
// Templates use {F} (a figure), {P} (a population count) and {N} (a bare tally).
// ---------------------------------------------------------------------------
const CANDIDATES = [
  {
    key: 'nurse', name: 'Imani Okoro', email: 'imani.okoro@example.test',
    roles: [
      { id: 'role-lead', title: 'Charge Nurse', employer: 'Alderbrook Community Hospital', start: 'March 2018', end: 'June 2022' },
      { id: 'role-prior', title: 'Staff Nurse', employer: 'Fernhill Outpatient Clinic', start: 'May 2013', end: 'February 2018' },
    ],
    measure: {
      label: 'scan compliance', figure: '97%',
      bare: 'Kept medication barcode scan compliance on the emergency ward.',
      line: 'Kept medication barcode scan compliance at {F} on the emergency ward.',
      claim: 'Kept barcode scan compliance on the emergency ward at {F}.',
    },
    sibling: {
      figure: '88%',
      line: 'Kept medication barcode scan compliance at {F} in the outpatient clinic.',
      claim: 'Kept barcode scan compliance in the outpatient clinic at {F}.',
    },
    population: {
      count: 50, noun: 'patients',
      bare: 'Triaged patients per shift on the emergency ward.',
      line: 'Triaged {P} patients per shift on the emergency ward.',
      claim: 'Triaged {P} patients per shift in the emergency ward.',
    },
    tally: { count: 40, line: 'Closed {N} care-plan reviews per shift on the emergency ward.', claim: 'Closed {N} care-plan reviews per shift in the emergency ward.' },
    process: 'discharge checklist', years: { count: 6, field: 'ward' },
  },
  {
    key: 'pastry-chef', name: 'Theo Marchetti', email: 'theo.marchetti@example.test',
    roles: [
      { id: 'role-lead', title: 'Pastry Chef', employer: 'Maison Verdelle Patisserie', start: 'June 2016', end: 'August 2021' },
      { id: 'role-prior', title: 'Line Cook', employer: 'Copperkettle Bistro', start: 'April 2011', end: 'May 2016' },
    ],
    measure: {
      label: 'ingredient spend', figure: '$4,200',
      bare: 'Held pastry ingredient spend per order cycle for the patisserie.',
      line: 'Held pastry ingredient spend to {F} per order cycle for the patisserie.',
      claim: 'Held ingredient spend for the patisserie to {F} per order cycle.',
    },
    sibling: {
      figure: '$5,100',
      line: 'Held bistro ingredient spend to {F} per order cycle for the kitchen.',
      claim: 'Held ingredient spend for the bistro kitchen to {F} per order cycle.',
    },
    population: {
      count: 1200, noun: 'customers',
      bare: 'Plated desserts for customers per month at the patisserie.',
      line: 'Plated desserts for {P} customers per month at the patisserie.',
      claim: 'Plated desserts for {P} customers each month at the patisserie.',
    },
    tally: { count: 300, line: 'Baked {N} laminated tarts per service at the patisserie.', claim: 'Baked {N} laminated tarts per service in the patisserie.' },
    process: 'lamination schedule', years: { count: 8, field: 'pastry' },
  },
  {
    key: 'structural-engineer', name: 'Priya Nandakumar', email: 'priya.nandakumar@example.test',
    roles: [
      { id: 'role-lead', title: 'Structural Engineer', employer: 'Tessellate Structural Partners', start: 'January 2015', end: 'Present' },
      { id: 'role-prior', title: 'Junior Engineer', employer: 'Bridgewater Civil Works', start: 'July 2010', end: 'December 2014' },
    ],
    measure: {
      label: 'construction value', figure: '$2.4M',
      bare: 'Delivered the footbridge retrofit design.',
      line: 'Delivered the footbridge retrofit design for {F} in construction value.',
      claim: 'Delivered the footbridge retrofit design with {F} in construction value.',
    },
    sibling: {
      figure: '$890K',
      line: 'Delivered the culvert replacement design for {F} in construction value.',
      claim: 'Delivered the culvert replacement design with {F} in construction value.',
    },
    population: {
      count: 12000, noun: 'residents',
      bare: 'Sized the footbridge retrofit for the residents who cross it.',
      line: 'Sized the footbridge retrofit for the {P} residents who cross it.',
      claim: 'Sized the retrofit of the footbridge for the {P} residents who cross it.',
    },
    tally: { count: 12, line: 'Reviewed {N} connection details per project at the firm.', claim: 'Reviewed {N} connection details per project for the firm.' },
    process: 'load-path review', years: { count: 10, field: 'bridge design' },
  },
  {
    key: 'data-analyst', name: 'Walter Brzezinski', email: 'walter.brzezinski@example.test',
    roles: [
      { id: 'role-lead', title: 'Data Analyst', employer: 'Northfield Analytics Cooperative', start: 'September 2019', end: 'Present' },
      { id: 'role-prior', title: 'Reporting Analyst', employer: 'Cobblestone Mutual Insurance', start: 'August 2014', end: 'August 2019' },
    ],
    measure: {
      label: 'refresh jobs', figure: '3x',
      bare: 'Ran the sales dashboard refresh jobs for the analytics team.',
      line: 'Ran the sales dashboard refresh jobs {F} per day for the analytics team.',
      claim: 'Ran refresh jobs for the sales dashboard {F} per day.',
    },
    sibling: {
      figure: '2x',
      line: 'Ran the claims dashboard refresh jobs {F} per day for the finance team.',
      claim: 'Ran refresh jobs for the claims dashboard {F} per day.',
    },
    population: {
      count: 340, noun: 'employees',
      bare: 'Maintained dashboards used by employees across the finance group.',
      line: 'Maintained dashboards used by {P} employees across the finance group.',
      claim: 'Maintained dashboards for {P} employees across the finance group.',
    },
    tally: { count: 24, line: 'Published {N} reports per quarter for the analytics team.', claim: 'Published {N} reports per quarter to the analytics team.' },
    process: 'quarterly forecast model', years: { count: 7, field: 'analytics' },
  },
  {
    key: 'warehouse-supervisor', name: 'Dolores Quintanilla', email: 'dolores.quintanilla@example.test',
    roles: [
      { id: 'role-lead', title: 'Warehouse Supervisor', employer: 'Pinecrest Fulfillment Center', start: 'February 2017', end: 'Present' },
      { id: 'role-prior', title: 'Shift Lead', employer: 'Harborview Cold Storage', start: 'October 2009', end: 'January 2017' },
    ],
    measure: {
      label: 'pick accuracy', figure: '99.2%',
      bare: 'Held pick accuracy across the outbound dock.',
      line: 'Held pick accuracy at {F} across the outbound dock.',
      claim: 'Held outbound dock pick accuracy at {F}.',
    },
    sibling: {
      figure: '96.5%',
      line: 'Held pick accuracy at {F} across the cold storage aisles.',
      claim: 'Held cold storage aisle pick accuracy at {F}.',
    },
    population: {
      count: 85, noun: 'employees',
      bare: 'Scheduled shift coverage for employees on the outbound dock.',
      line: 'Scheduled shift coverage for {P} employees on the outbound dock.',
      claim: 'Scheduled shift coverage for {P} employees at the outbound dock.',
    },
    tally: { count: 600, line: 'Staged {N} pallets per shift on the outbound dock.', claim: 'Staged {N} pallets per shift at the outbound dock.' },
    process: 'cycle-count routine', years: { count: 12, field: 'warehouse' },
  },
  {
    key: 'software-engineer', name: 'Kenji Aldous', email: 'kenji.aldous@example.test',
    roles: [
      { id: 'role-lead', title: 'Software Engineer', employer: 'Lumenpath Software', start: 'April 2020', end: 'Present' },
      { id: 'role-prior', title: 'Junior Developer', employer: 'Marigold Web Studio', start: 'June 2016', end: 'March 2020' },
    ],
    measure: {
      label: 'test coverage', figure: '35%',
      bare: 'Kept test coverage on the billing service.',
      line: 'Kept test coverage on the billing service at {F}.',
      claim: 'Kept billing service test coverage at {F}.',
    },
    sibling: {
      figure: '12%',
      line: 'Kept test coverage on the signup widget at {F}.',
      claim: 'Kept signup widget test coverage at {F}.',
    },
    population: {
      count: 4000, noun: 'users',
      bare: 'Maintained the billing service used by users at the company.',
      line: 'Maintained the billing service used by {P} users at the company.',
      claim: 'Maintained the billing service for {P} users at the company.',
    },
    tally: { count: 18, line: 'Merged {N} pull requests per sprint on the billing service.', claim: 'Merged {N} pull requests per sprint in the billing service.' },
    process: 'release pipeline', years: { count: 9, field: 'backend' },
  },
];

// Directions of change ("comparative outcome" claims). The production gate
// recognizes these by their literal word forms and binds each to the evidence
// the unit cites; the magnitude of the change ("by half") needs its own stated
// comparison (see the comparative-magnitude test).
const OUTCOME_DIRECTIONS = [
  { rule: /unsupported reduction outcome/u, line: process => `Reduced the effort of the ${process} for the team.`, claim: process => `Reduced the effort of the ${process}.` },
  { rule: /unsupported improvement outcome/u, line: process => `Improved the handoff of the ${process} for the team.`, claim: process => `Improved the handoff of the ${process}.` },
  { rule: /unsupported increase outcome/u, line: process => `Raised the adoption of the ${process} for the team.`, claim: process => `Raised the adoption of the ${process}.` },
];

// Synthetic job listings. Judging here is against career evidence, so a listing
// only matters as the place a flattering figure could be copied FROM: a listing
// requirement must never become candidate experience.
const LISTINGS = [
  'Seeking a clinical lead to run a 400-bed hospital network serving millions of patients with 99.99% uptime of every medication system. Requires 15 years of clinical experience.',
  'Head pastry role for a high-volume bakery chain feeding 100,000 guests a week with enterprise-scale purchasing and a $9.5M annual ingredient budget. Requires 11 years of pastry experience.',
  'Staff engineer for a platform handling 5 billion requests a day, enterprise-wide, with 12x year over year growth. Requires 13 years of platform experience.',
];

// ---------------------------------------------------------------------------
// Test scaffolding: a faithful, host-shaped "compiler" for the synthetic source.
// It is what the AI compiler does in production (one physical line per segment,
// each claim a verbatim transcription of its line). Production validators are
// the oracle for everything built from it.
// ---------------------------------------------------------------------------
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fmt = number => number.toLocaleString('en-US');
const fill = (template, value, token = '{F}') => template.split(token).join(String(value));
const lowerFirst = value => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
const attempt = run => { try { return { value: run(), threw: null }; } catch (error) { return { value: null, threw: error }; } };

// A clean six-lane page-audit history, exactly as the immutable approval record
// requires for a profile with no unresolved findings.
function cleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  const deterministicFailureDigest = sha256(canonicalJson([]));
  const audits = [
    ['coverage', 'career-profile-audit-completeness'],
    ['grounding', 'career-profile-audit-grounding'],
    ['attribution', 'career-profile-audit-attribution'],
    ['metrics', 'career-profile-audit-metrics'],
    ['skills', 'career-profile-audit-skills'],
    ['conflict', 'career-profile-audit-conflicts'],
  ].map(([category, task]) => {
    let chainDigest = sha256(canonicalJson({ category, task, seed: 'career-page-audit-v1' }));
    const pageAudits = pages.map(page => {
      const findingDigest = sha256(canonicalJson([]));
      chainDigest = sha256(canonicalJson({ prior: chainDigest, pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest }));
      return { pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest, chainDigest };
    });
    const receipt = pageAudits.map(({ pageId, pageIndex, findingCount, findingDigest, chainDigest: chain }) => ({ pageId, pageIndex, findingCount, findingDigest, chainDigest: chain }));
    return { category, task, findingCount: 0, findingDigest: sha256(canonicalJson(receipt)), findings: [], pageAudits };
  });
  const profileDigest = canonicalCareerProfileDigest(profile);
  const unresolvedFindingDigest = sha256(canonicalJson({
    deterministicFailureDigest,
    audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })),
  }));
  return [{
    round: 0, profileDigest, unresolvedFindingDigest,
    stateDigest: sha256(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

function approvedEnvelope(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  return {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: CAREER_SNAPSHOT_STATUS_APPROVED,
    snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint,
    compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: sha256(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z',
    sources: corpus.sources, segments: corpus.segments, profile, auditHistory: cleanAuditHistory(corpus, profile),
  };
}

// A feature is one additional source line the lead role gains. A feature may
// also be a literal { claim, metric? } object for one-off gap probes.
function featureLines(candidate, feature) {
  if (feature && typeof feature === 'object') return [feature];
  switch (feature) {
    case 'measure':
      return [{ claim: fill(candidate.measure.line, candidate.measure.figure), metric: { label: candidate.measure.label, value: candidate.measure.figure, unit: '' } }];
    case 'population':
      return [{ claim: fill(candidate.population.line, fmt(candidate.population.count), '{P}') }];
    case 'tally':
      return [{ claim: fill(candidate.tally.line, String(candidate.tally.count), '{N}') }];
    case 'scale':
      return [{ claim: `Ran the ${candidate.process} at regional scale.` }, { claim: `Rolled out the ${candidate.process} organization-wide.` }];
    case 'years':
      return [{ claim: `Brought ${candidate.years.count} years of hands-on ${candidate.years.field} experience to the team.` }];
    case 'outcome':
      return OUTCOME_DIRECTIONS.map(direction => ({ claim: direction.line(candidate.process) }));
    default:
      throw new Error(`Unknown fixture feature ${String(feature)}`);
  }
}

function sourceEntries(candidate, features) {
  const entries = [
    { kind: 'identity', text: candidate.name },
    { kind: 'identity', text: candidate.email },
    { kind: 'blank', text: '' },
  ];
  candidate.roles.forEach((role, roleIndex) => {
    entries.push(
      { kind: 'header', roleId: role.id, text: role.title },
      { kind: 'header', roleId: role.id, text: role.employer },
      { kind: 'header', roleId: role.id, text: `${role.start} to ${role.end}` },
    );
    const bullets = roleIndex === 0
      ? [
        { claim: candidate.measure.bare }, { claim: candidate.population.bare }, { claim: `Ran the ${candidate.process}.` },
        ...features.flatMap(feature => featureLines(candidate, feature)),
      ]
      : [
        // The sibling figure and process line exist in EVERY variant, so a
        // number "that appears in the source" is always present on the other role.
        { claim: fill(candidate.sibling.line, candidate.sibling.figure), metric: { label: candidate.measure.label, value: candidate.sibling.figure, unit: '' } },
        { claim: `Ran the ${candidate.process}.` },
      ];
    for (const bullet of bullets) entries.push({ kind: 'bullet', roleId: role.id, text: `- ${bullet.claim}`, claim: bullet.claim, metric: bullet.metric || null });
    entries.push({ kind: 'blank', text: '' });
  });
  return entries;
}

function buildProfile(candidate, entries, corpus) {
  entries.forEach((entry, index) => assert(corpus.segments[index]?.text === `${entry.text}\n`, `${candidate.key}: fixture line ${index + 1} is exactly one physical-line segment`));
  const segmentIds = corpus.segments.map(segment => segment.id);
  const coverage = [];
  const rolesById = new Map();
  const achievements = [];
  entries.forEach((entry, index) => {
    const segmentId = segmentIds[index];
    if (entry.kind === 'identity') { coverage.push({ segmentId, disposition: 'identity', entityIds: ['identity'] }); return; }
    if (entry.kind === 'blank') { coverage.push({ segmentId, disposition: 'non-career-content', entityIds: [] }); return; }
    const spec = candidate.roles.find(role => role.id === entry.roleId);
    if (!rolesById.has(spec.id)) {
      rolesById.set(spec.id, {
        id: spec.id, title: spec.title, employer: spec.employer, startDate: spec.start, endDate: spec.end, location: '',
        achievementIds: [], skillIds: [], evidenceSegmentIds: [],
      });
    }
    const role = rolesById.get(spec.id);
    if (entry.kind === 'header') {
      role.evidenceSegmentIds.push(segmentId);
      coverage.push({ segmentId, disposition: 'role-header', entityIds: [spec.id] });
      return;
    }
    const id = `ach-${sha256(`${spec.id}|${entry.claim}`).slice(0, 10)}`;
    role.achievementIds.push(id);
    achievements.push({
      id, roleId: spec.id, claim: entry.claim, technologies: [], technologyReferences: [],
      metrics: entry.metric ? [{ ...entry.metric, evidenceSegmentIds: [segmentId] }] : [],
      evidenceSegmentIds: [segmentId],
    });
    coverage.push({ segmentId, disposition: 'achievement', entityIds: [id] });
  });
  return {
    identity: { name: candidate.name, contacts: [candidate.email], evidenceSegmentIds: [segmentIds[0], segmentIds[1]] },
    roles: [...rolesById.values()], achievements, projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    segmentCoverage: coverage,
  };
}

/**
 * Compile source text + profile without approval, optionally letting a test tamper with the profile.
 * `entries` replaces the generated source with an already-edited line list (used to REMOVE evidence).
 */
function compileProfile(candidate, features = [], { tamper = null, entries: provided = null } = {}) {
  const entries = provided || sourceEntries(candidate, features);
  const text = `${entries.map(entry => entry.text).join('\n')}\n`;
  const corpus = buildCareerSourceCorpus([{
    name: `${candidate.key}-career.md`, contentHash: sha256(text), text, legacyText: text,
    transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
  }]);
  const profile = buildProfile(candidate, entries, corpus);
  if (tamper) tamper(profile, { entries, corpus });
  return { candidate, features, entries, text, corpus, profile, validation: validateCareerProfile(profile, corpus) };
}

/** The full production path: validated profile -> immutable approved snapshot -> evidence catalog. */
function compileApproved(candidate, features = [], options = {}) {
  const compiled = compileProfile(candidate, features, options);
  assert(compiled.validation.valid, `${candidate.key}: the faithful profile validates (${compiled.validation.errors.slice(0, 2).join(' | ')})`);
  const snapshot = approvedEnvelope(compiled.corpus, compiled.profile);
  const snapshotValidation = validateCurrentCareerSnapshot(snapshot);
  assert(snapshotValidation.valid, `${candidate.key}: the approved snapshot validates (${snapshotValidation.errors.slice(0, 2).join(' | ')})`);
  return { ...compiled, snapshot, snapshotId: snapshot.snapshotId, catalog: approvedCareerEvidenceCatalog(snapshot) };
}

/**
 * Delete from an already-compiled source exactly the lines `feature` contributed and recompile what is
 * left. This is a real removal (edit the line list, rebuild the corpus, re-validate, re-approve), not a
 * second compile of the original inputs.
 */
function withoutFeature(compiled, feature) {
  const dropped = new Set(featureLines(compiled.candidate, feature).map(line => line.claim));
  const entries = compiled.entries.filter(entry => !(entry.kind === 'bullet' && dropped.has(entry.claim)));
  assert(compiled.entries.length - entries.length === dropped.size, `${compiled.candidate.key}: removal deleted exactly the ${dropped.size} line(s) the feature contributed`);
  return compileApproved(compiled.candidate, [], { entries });
}

/**
 * A is the source without the quantity, B adds one supporting line, C is B with that line REMOVED again.
 * `needle` is the literal the supporting line puts into the approved evidence; the lifecycle proves it is
 * absent from A, present in B, and absent from C, and that the snapshot identity follows the source text.
 */
function lifecycle(candidate, feature, needle) {
  const A = compileApproved(candidate, []);
  const B = compileApproved(candidate, [feature]);
  const C = withoutFeature(B, feature);
  const key = candidate.key;
  assert(B.text !== A.text && B.snapshotId !== A.snapshotId, `${key}: adding the line changes the source text and recompilation issues a new snapshot id`);
  assert(C.text !== B.text && C.snapshotId !== B.snapshotId, `${key}: removing the line changes the source text and issues another new snapshot id`);
  assert(C.text === A.text && C.snapshotId === A.snapshotId, `${key}: the source with the line removed is the original source, so the snapshot id is the original one`);
  const states = compiled => quotesOf(compiled).some(quote => statesToken(quote, needle));
  assert(!states(A) && states(B) && !states(C), `${key}: the approved evidence states "${needle}" in B only`);
  return { A, B, C };
}

/** True when `quote` contains `token` as a whole token (hashed ids such as ach-3f50a9 must not satisfy "50"). */
function statesToken(quote, token) {
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}.,])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(quote);
}

const quotesOf = compiled => compiled.catalog.map(entry => entry.quote);

/** The catalog entries (claim line + metric line) of the single achievement whose claim is `claimText`. */
function evidenceFor(compiled, claimText) {
  const achievement = compiled.profile.achievements.find(item => item.claim === claimText);
  assert(achievement, `${compiled.candidate.key}: fixture states "${claimText}"`);
  return compiled.catalog.filter(entry => entry.id.startsWith(`host.career.achievement.${achievement.id}.`));
}

/** Every catalog entry belonging to the achievements of role `roleIndex`. */
function roleEvidence(compiled, roleIndex) {
  const ids = compiled.profile.roles[roleIndex].achievementIds;
  return compiled.catalog.filter(entry => ids.some(id => entry.id.startsWith(`host.career.achievement.${id}.`)));
}

// ---------------------------------------------------------------------------
// Production verdict wrappers (no logic of their own).
// ---------------------------------------------------------------------------
function bulletVerdict(claim, quotes) {
  const outcome = attempt(() => assertSourceQuoteLinksFinalText(claim, quotes, 'resumeBullets', 0, { identityTokens: [] }));
  return { accepted: !outcome.threw, message: outcome.threw ? String(outcome.threw.message || outcome.threw) : '' };
}

/**
 * `cited` is what the unit cites; `accepted` is the whole accepted evidence plan the unit's ids are
 * resolved against (production never hands the gate only the cited entries). Defaulting `accepted` to the
 * approved snapshot's whole catalog keeps the test honest about the gate reading CITED ids, not the plan.
 */
function populationVerdict(claim, cited, accepted = cited) {
  const outcome = attempt(() => pasteAttributionScopeErrors({
    unitLabel: 'résumé bullet', unitId: 'unit-1', finalText: claim, evidenceIds: cited.map(entry => entry.id),
    acceptedEvidence: accepted, sourceRoles: [], careerData: '', authority: null,
  }));
  return { accepted: !outcome.threw && outcome.value.length === 0, errors: outcome.value || [], threw: outcome.threw };
}
const POPULATION_REJECTION = /claims the user population/u;

/** The same gate for a cover-letter paragraph: figures are proven only for sentences that CLAIM candidate work. */
function paragraphVerdict(paragraph, quotes) {
  const outcome = attempt(() => assertSourceQuoteLinksFinalText(paragraph, quotes, 'coverLetterParagraphs', 0, { identityTokens: [] }));
  return { accepted: !outcome.threw, message: outcome.threw ? String(outcome.threw.message || outcome.threw) : '' };
}

/** The segment id of the physical source line a compiled fixture wrote for `claimText`. */
function segmentIdOf(compiled, claimText) {
  const index = compiled.entries.findIndex(entry => entry.claim === claimText);
  assert(index >= 0 && compiled.corpus.segments[index], `${compiled.candidate.key}: the source states "${claimText}"`);
  return compiled.corpus.segments[index].id;
}

const resumeBullets = compiled => compiled.profile.achievements.map(achievement => achievement.claim);
const letterVerdict = (paragraphs, bulletTexts, plan = null) => checkFigureDiscipline(paragraphs, { bulletTexts }, plan);
const letterOf = claim => [`In my last role I ${lowerFirst(claim)}`];

// ---------------------------------------------------------------------------
// Programmatic mutations of a supported figure token. They are derived from the
// token's own shape, never from a list of "what production should reject".
// ---------------------------------------------------------------------------
function parseFigure(token) {
  const match = /^([^\d]*)(\d[\d,]*(?:\.\d+)?)(.*)$/u.exec(token);
  assert(match, `figure token ${token} has a number`);
  return { prefix: match[1], number: match[2], suffix: match[3] };
}

function figureMutants(token) {
  const { prefix, number, suffix } = parseFigure(token);
  const plain = number.replace(/,/gu, '');
  const grouped = digits => (number.includes(',') ? Number(digits).toLocaleString('en-US') : digits);
  const mutants = [];
  // One more digit (or the decimal point moved): the 50 -> 500 class.
  mutants.push({ label: 'tenfold', text: `${prefix}${grouped(plain.includes('.') ? plain.replace('.', '') : `${plain}0`)}${suffix}` });
  // A single changed digit: the 15% -> 25% class.
  mutants.push({ label: 'changed-digit', text: `${prefix}${number.replace(/\d/u, digit => String((Number(digit) % 9) + 1))}${suffix}` });
  // Two adjacent distinct digits transposed: the 15% -> 51% class.
  const digits = [...number].map((char, index) => ({ char, index })).filter(item => /\d/u.test(item.char));
  const pair = digits.slice(0, -1).find((item, index) => item.char !== digits[index + 1].char);
  if (pair) {
    const next = digits[digits.indexOf(pair) + 1];
    const chars = [...number];
    chars[pair.index] = next.char;
    chars[next.index] = pair.char;
    mutants.push({ label: 'transposed', text: `${prefix}${chars.join('')}${suffix}` });
  }
  if (suffix === 'M') mutants.push({ label: 'magnitude-down', text: `${prefix}${number}K` }, { label: 'magnitude-up', text: `${prefix}${number}B` });
  if (suffix === 'K') mutants.push({ label: 'magnitude-up', text: `${prefix}${number}M` });
  if (prefix === '$') mutants.push({ label: 'denomination', text: `€${number}${suffix}` });
  if (suffix === '%') mutants.push({ label: 'kind', text: `${number} percentage points` });
  if (suffix === 'x') mutants.push({ label: 'kind', text: `${number}%` });
  if (suffix === '%' || prefix === '$') mutants.push({ label: 'sign', text: `-${token}` });
  return mutants.filter(mutant => mutant.text !== token);
}

function equivalentForms(token) {
  const { prefix, number, suffix } = parseFigure(token);
  const forms = [];
  if (suffix === '%') forms.push(`${number} percent`);
  if (suffix === 'x') forms.push(`${number} times`, `${number}X`);
  if (prefix && !suffix) forms.push(`${prefix}${number.replace(/,/gu, '')}`);
  if (prefix && (suffix === 'M' || suffix === 'K')) {
    const full = Math.round(Number(number.replace(/,/gu, '')) * (suffix === 'M' ? 1e6 : 1e3));
    forms.push(`${prefix}${fmt(full)}`, `${prefix}${number} ${suffix === 'M' ? 'million' : 'thousand'}`);
  }
  return forms;
}

/** The first percentage / currency / multiplier a listing states, read from the listing text itself. */
const listingFigure = listing => /[$€£]?\d[\d,]*(?:\.\d+)?(?:%|[KMB](?![\p{L}\p{N}])|x(?![\p{L}\p{N}]))/u.exec(listing)?.[0];
/** The years a listing requires, read from the listing text itself. */
const listingYears = listing => Number(/(\d{1,2})\+?\s+years/u.exec(listing)?.[1]);

const isMultiplier = candidate => candidate.measure.figure.endsWith('x');

/** True when the source text writes `number` as a whole numeric token (dates and other digits do not count). */
function sourceWritesNumber(text, number) {
  return (text.match(/\d[\d,]*(?:\.\d+)?/gu) || []).some(token => token.replace(/,/gu, '') === String(number));
}

// ---------------------------------------------------------------------------
// Default export: tests that pass today and would fail if the rule regressed.
// ---------------------------------------------------------------------------
export default [
  {
    name: 'Adaptability metrics: synthetic fixtures are domain-diverse and compile through the real approval path',
    run() {
      assert(CANDIDATES.length >= 3 && LISTINGS.length >= 3, 'at least three unrelated candidates and listings');
      assert(new Set(CANDIDATES.map(candidate => candidate.roles[0].employer)).size === CANDIDATES.length, 'every candidate has its own employer');
      assert(!/affirm|anthropic/iu.test(JSON.stringify([CANDIDATES, LISTINGS])), 'fixtures never use a real employer name');
      const kinds = new Set(CANDIDATES.map(candidate => { const { prefix, suffix } = parseFigure(candidate.measure.figure); return prefix || suffix; }));
      assert(kinds.size >= 3, `the candidates exercise at least three figure kinds (percent, currency, multiplier), saw ${[...kinds].join(' ')}`);
      for (const candidate of CANDIDATES) {
        for (const features of [[], ['measure'], ['population'], ['scale'], ['years'], ['tally'], ['measure', 'population', 'scale', 'years', 'tally']]) {
          const compiled = compileApproved(candidate, features);
          assert(compiled.catalog.length > 0 && compiled.snapshotId.length === 64, `${candidate.key}: ${features.join('+') || 'base'} yields an approved evidence catalog`);
        }
        // The runtime fact boundary carries a figure exactly when the source line states it.
        const base = compileApproved(candidate, []);
        const measured = compileApproved(candidate, ['measure']);
        assert(!quotesOf(base).some(quote => quote.includes(candidate.measure.figure)), `${candidate.key}: the base evidence states no measure figure`);
        const metricLine = quotesOf(measured).find(quote => /Metric \d+ \[Achievement ID: [^\]]+\]/u.test(quote) && quote.includes(candidate.measure.figure));
        assert(metricLine, `${candidate.key}: the approved catalog carries the typed metric once the source states it`);
      }
    },
  },
  {
    name: 'Adaptability metrics: the profile compiler gate rejects invented and near-miss quantities and admits the faithful transcription',
    run() {
      let rejections = 0;
      for (const candidate of CANDIDATES) {
        const figure = candidate.measure.figure;
        const faithful = compileProfile(candidate, ['measure']);
        assert(faithful.validation.valid, `${candidate.key}: faithful profile with metric is admitted (${faithful.validation.errors.join(' | ')})`);
        const mutants = figureMutants(figure);
        assert(mutants.length >= 3, `${candidate.key}: derived at least three near-miss mutants`);
        const measureAchievement = profile => profile.achievements.find(item => item.claim === fill(candidate.measure.line, figure));
        for (const mutant of mutants) {
          assert(!faithful.text.includes(mutant.text), `${candidate.key}: mutant ${mutant.text} is not written anywhere in the source`);
          // The metric's number changed.
          const wrongMetric = compileProfile(candidate, ['measure'], { tamper: profile => { measureAchievement(profile).metrics[0].value = mutant.text; } });
          assert(!wrongMetric.validation.valid && wrongMetric.validation.errors.some(error => /metric value is not grounded/u.test(error)),
            `${candidate.key}: metric value ${mutant.text} (${mutant.label}) is rejected as ungrounded, got ${wrongMetric.validation.errors.join(' | ') || 'acceptance'}`);
          // The claim text itself changed.
          const wrongClaim = compileProfile(candidate, ['measure'], { tamper: profile => { measureAchievement(profile).claim = fill(candidate.measure.line, mutant.text); } });
          assert(!wrongClaim.validation.valid && wrongClaim.validation.errors.some(error => /claim is not grounded/u.test(error)),
            `${candidate.key}: claim carrying ${mutant.text} (${mutant.label}) is rejected as ungrounded`);
          rejections += 2;
        }
        // A unit the source never states.
        const wrongUnit = compileProfile(candidate, ['measure'], { tamper: profile => { measureAchievement(profile).metrics[0].unit = 'hours'; } });
        assert(wrongUnit.validation.errors.some(error => /metric unit is not grounded/u.test(error)), `${candidate.key}: an unstated unit is rejected`);
        // A figure nowhere in the source, invented on a role that never states it.
        const invented = compileProfile(candidate, [], { tamper: profile => {
          const bare = profile.achievements.find(item => item.claim === candidate.measure.bare);
          bare.metrics = [{ label: candidate.measure.label, value: figure, unit: '', evidenceSegmentIds: [...bare.evidenceSegmentIds] }];
        } });
        assert(invented.validation.errors.some(error => /metric value is not grounded/u.test(error)), `${candidate.key}: an invented metric on a source that never states it is rejected`);
        // The same sentence presented as a claim of a source that lacks the line.
        const fabricatedClaim = compileProfile(candidate, [], { tamper: profile => {
          const bare = profile.achievements.find(item => item.claim === candidate.measure.bare);
          bare.claim = fill(candidate.measure.line, figure);
        } });
        assert(fabricatedClaim.validation.errors.some(error => /claim is not grounded/u.test(error)), `${candidate.key}: a claim stating a figure the source lacks is rejected`);
        rejections += 3;
      }
      return { rejections };
    },
  },
  {
    name: 'Adaptability metrics: a figure is unavailable until the source states it, admitted after recompilation, and revoked on removal',
    run() {
      for (const candidate of CANDIDATES) {
        const figure = candidate.measure.figure;
        const { A, B, C } = lifecycle(candidate, 'measure', figure);
        const claim = fill(candidate.measure.claim, figure);
        // The writer legitimately cites the achievement it is restating (bound) and
        // could cite anything at all (every approved quote): A and C never admit it.
        const boundBare = compiled => evidenceFor(compiled, candidate.measure.bare).map(entry => entry.quote);
        for (const [label, compiled] of [['A', A], ['C', C]]) {
          for (const [scope, quotes] of [['bound', boundBare(compiled)], ['whole-catalog', quotesOf(compiled)]]) {
            const verdict = bulletVerdict(claim, quotes);
            assert(!verdict.accepted && /unsupported figure/u.test(verdict.message), `${candidate.key} ${label}/${scope}: ${figure} is rejected as an unsupported figure, got ${verdict.message || 'acceptance'}`);
          }
        }
        const boundSupported = evidenceFor(B, fill(candidate.measure.line, figure)).map(entry => entry.quote);
        assert(boundSupported.length >= 2, `${candidate.key}: the supporting achievement contributes its claim and metric lines`);
        for (const [scope, quotes] of [['bound', boundSupported], ['whole-catalog', quotesOf(B)]]) {
          const verdict = bulletVerdict(claim, quotes);
          assert(verdict.accepted, `${candidate.key} B/${scope}: ${figure} is accepted once the source states it, got ${verdict.message}`);
        }
        // The prose gate is stateless: re-judging against A after B was compiled still rejects.
        assert(!bulletVerdict(claim, quotesOf(A)).accepted, `${candidate.key}: A still rejects after B was approved`);
      }
    },
  },
  {
    name: 'Adaptability metrics: near-miss figures are rejected while equivalent formatting of the supported figure is accepted',
    run() {
      let nearMisses = 0;
      let equivalents = 0;
      for (const candidate of CANDIDATES) {
        const B = compileApproved(candidate, ['measure']);
        const quotes = evidenceFor(B, fill(candidate.measure.line, candidate.measure.figure)).map(entry => entry.quote);
        assert(bulletVerdict(fill(candidate.measure.claim, candidate.measure.figure), quotes).accepted, `${candidate.key}: the faithful restatement is accepted`);
        for (const form of equivalentForms(candidate.measure.figure)) {
          const verdict = bulletVerdict(fill(candidate.measure.claim, form), quotes);
          assert(verdict.accepted, `${candidate.key}: equivalent formatting ${form} of ${candidate.measure.figure} is accepted, got ${verdict.message}`);
          equivalents += 1;
        }
        const mutants = figureMutants(candidate.measure.figure);
        assert(mutants.length >= 3, `${candidate.key}: at least three near-misses derived`);
        for (const mutant of mutants) {
          assert(!B.text.includes(mutant.text), `${candidate.key}: ${mutant.text} is genuinely absent from the source`);
          const verdict = bulletVerdict(fill(candidate.measure.claim, mutant.text), quotes);
          assert(!verdict.accepted && /unsupported figure/u.test(verdict.message), `${candidate.key}: ${mutant.label} mutant ${mutant.text} is rejected as an unsupported figure, got ${verdict.message || 'acceptance'}`);
          nearMisses += 1;
        }
        // The other role's figure is a near miss of a different kind: a real number from the source.
        const sibling = bulletVerdict(fill(candidate.measure.claim, candidate.sibling.figure), quotes);
        assert(!sibling.accepted && /unsupported figure/u.test(sibling.message), `${candidate.key}: a figure stated for the other role does not support this role's claim, got ${sibling.message || 'acceptance'}`);
        // The typed Metric line the snapshot projects is itself citable evidence of the figure.
        const metricOnly = evidenceFor(B, fill(candidate.measure.line, candidate.measure.figure)).filter(entry => /Metric \d+ \[Achievement ID/u.test(entry.quote)).map(entry => entry.quote);
        assert(metricOnly.length === 1, `${candidate.key}: the achievement projects exactly one typed metric line`);
        const viaMetric = bulletVerdict(fill(candidate.measure.claim, candidate.measure.figure), metricOnly);
        assert(viaMetric.accepted, `${candidate.key}: the typed metric line alone supports the figure, got ${viaMetric.message}`);
        const viaMetricMutant = bulletVerdict(fill(candidate.measure.claim, mutants[0].text), metricOnly);
        assert(!viaMetricMutant.accepted && /unsupported figure/u.test(viaMetricMutant.message), `${candidate.key}: the typed metric line does not support ${mutants[0].text}`);
      }
      assert(nearMisses >= 20 && equivalents >= 8, `mutation coverage was not vacuous (${nearMisses} near-misses, ${equivalents} equivalents)`);
    },
  },
  {
    name: 'Adaptability metrics: a population or extent claim follows the count the current evidence states',
    run() {
      for (const candidate of CANDIDATES) {
        const { count, noun } = candidate.population;
        const { A, B, C } = lifecycle(candidate, 'population', fmt(count));
        const claimWith = value => fill(candidate.population.claim, value, '{P}');
        const bareEvidence = compiled => evidenceFor(compiled, candidate.population.bare);
        const faithfulClaim = claimWith(fmt(count));
        for (const [label, compiled] of [['A', A], ['C', C]]) {
          // The unit cites its own achievement; the gate resolves the id against the whole accepted plan.
          const verdict = populationVerdict(faithfulClaim, bareEvidence(compiled), compiled.catalog);
          assert(!verdict.accepted && verdict.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key} ${label}: "${fmt(count)} ${noun}" is rejected while the source states no count, got ${verdict.errors.join(' | ') || 'acceptance'}`);
          const wholeCatalog = populationVerdict(faithfulClaim, compiled.catalog);
          assert(!wholeCatalog.accepted && wholeCatalog.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key} ${label}: no approved quote anywhere establishes the population`);
        }
        const supported = evidenceFor(B, fill(candidate.population.line, fmt(count), '{P}'));
        for (const written of [fmt(count), String(count)]) {
          const verdict = populationVerdict(claimWith(written), supported, B.catalog);
          assert(verdict.accepted, `${candidate.key} B: ${written} ${noun} is accepted (comma formatting is typographic), got ${verdict.errors.join(' | ') || verdict.threw}`);
        }
        const nearMisses = [count * 10, Math.max(1, Math.floor(count / 10)), count + 1, count * 2];
        for (const wrong of nearMisses) {
          assert(!sourceWritesNumber(B.text, wrong), `${candidate.key}: ${wrong} is not written in the source`);
          for (const written of [fmt(wrong), String(wrong)]) {
            const verdict = populationVerdict(claimWith(written), supported, B.catalog);
            assert(!verdict.accepted && verdict.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key} B: near-miss ${written} ${noun} is rejected, got ${verdict.errors.join(' | ') || 'acceptance'}`);
          }
        }
        // Unit changed: the stated number attached to a different population is a different claim.
        const otherNoun = CANDIDATES.map(item => item.population.noun).find(item => item !== noun && !new RegExp(`\\b${item}\\b`, 'iu').test(B.text));
        const swapped = populationVerdict(claimWith(fmt(count)).replace(noun, otherNoun), supported, B.catalog);
        assert(!swapped.accepted && swapped.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key} B: ${fmt(count)} ${otherNoun} is rejected when the source counts ${noun}, got ${swapped.errors.join(' | ') || 'acceptance'}`);
        // Universal quantifiers are a scale claim too: the source states a number, not "all".
        for (const word of ['all', 'every']) {
          const verdict = populationVerdict(claimWith(word), supported, B.catalog);
          assert(!verdict.accepted && verdict.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key} B: "${word} ${noun}" is rejected when the source states a specific count`);
        }
        // Removal revokes: the same cited achievement, resolved against C's plan, no longer carries the count.
        assert(!populationVerdict(faithfulClaim, bareEvidence(C), C.catalog).accepted, `${candidate.key} C: removing the line revokes the count`);
      }
    },
  },
  {
    name: 'Adaptability metrics: scale qualifiers the gate recognizes are bound to the current evidence',
    run() {
      for (const candidate of CANDIDATES) {
        const { A, B, C } = lifecycle(candidate, 'scale', 'regional scale');
        const atScale = `Ran the ${candidate.process} at scale.`;
        const orgWide = `Rolled out the ${candidate.process} organization-wide.`;
        const expectations = [[atScale, /unsupported at-scale status/u], [orgWide, /unsupported organization-wide scope/u]];
        for (const [claim, pattern] of expectations) {
          for (const [label, compiled] of [['A', A], ['C', C]]) {
            const verdict = bulletVerdict(claim, quotesOf(compiled));
            assert(!verdict.accepted && pattern.test(verdict.message), `${candidate.key} ${label}: "${claim}" is rejected while the source states no such scale, got ${verdict.message || 'acceptance'}`);
          }
          const supported = bulletVerdict(claim, quotesOf(B));
          assert(supported.accepted, `${candidate.key} B: "${claim}" is accepted once the source states it, got ${supported.message}`);
        }
        // The scale word is claimed by its own words, not by an unrelated figure elsewhere in the source.
        const withFigure = compileApproved(candidate, ['measure', 'population', 'tally']);
        for (const [claim, pattern] of expectations) {
          const verdict = bulletVerdict(claim, quotesOf(withFigure));
          assert(!verdict.accepted && pattern.test(verdict.message), `${candidate.key}: a stated figure, population or tally does not imply "${claim}", got ${verdict.message || 'acceptance'}`);
        }
        // The qualifier is bound to the cited unit: the scale feature's own achievements support it, an unrelated one does not.
        const scaled = compileApproved(candidate, ['scale', 'measure']);
        const scaledQuotes = evidenceFor(scaled, `Ran the ${candidate.process} at regional scale.`).map(entry => entry.quote);
        const unrelatedQuotes = evidenceFor(scaled, `Ran the ${candidate.process}.`).map(entry => entry.quote);
        assert(bulletVerdict(atScale, scaledQuotes).accepted, `${candidate.key}: "at scale" is accepted under the achievement that states regional scale`);
        const unrelated = bulletVerdict(atScale, unrelatedQuotes);
        assert(!unrelated.accepted && /unsupported at-scale status/u.test(unrelated.message), `${candidate.key}: "at scale" is rejected under the same-process achievement that does not state it, got ${unrelated.message || 'acceptance'}`);
      }
    },
  },
  {
    name: 'Adaptability metrics: a span of years is a claim only the current evidence can support',
    run() {
      for (const candidate of CANDIDATES) {
        const { count, field } = candidate.years;
        const { A, B, C } = lifecycle(candidate, 'years', `${count} years`);
        const prior = candidate.roles[1];
        const computed = Number(/\d{4}$/u.exec(prior.end)[0]) - Number(/\d{4}$/u.exec(prior.start)[0]);
        assert(computed !== count && computed > 0, `${candidate.key}: the span computable from dates (${computed}) differs from the stated span (${count})`);
        const claims = {
          exact: `${count} years of ${field} experience`,
          floor: `over ${count - 1} years of ${field} experience`,
          inflated: `over ${count + 1} years of ${field} experience`,
          off: `${count + 1} years of ${field} experience`,
          computed: `${computed} years of ${field} experience`,
        };
        const claimedYears = { exact: count, floor: count - 1, inflated: count + 1, off: count + 1, computed };
        for (const [label, compiled] of [['A', A], ['C', C]]) {
          for (const [kind, claim] of Object.entries(claims)) {
            const found = findUnsupportedDurationClaim(claim, quotesOf(compiled));
            assert(found && found.years === claimedYears[kind] && found.lowerBound === claim.startsWith('over') && found.statedYears.length === 0, `${candidate.key} ${label}: "${claim}" (${kind}) is unsupported because no source line states any span, got ${JSON.stringify(found)}`);
          }
        }
        assert(!findUnsupportedDurationClaim(claims.exact, quotesOf(B)), `${candidate.key} B: the stated span is accepted`);
        assert(!findUnsupportedDurationClaim(claims.floor, quotesOf(B)), `${candidate.key} B: a lower bound below the stated span is accepted`);
        for (const kind of ['inflated', 'off', 'computed']) {
          const found = findUnsupportedDurationClaim(claims[kind], quotesOf(B));
          assert(found && found.years === claimedYears[kind] && found.statedYears.length === 1 && found.statedYears[0] === count, `${candidate.key} B: "${claims[kind]}" (${kind}) is rejected and the rejection reports the stated ${count}, got ${JSON.stringify(found)}`);
        }
        // The same verdict, reached through the gate a résumé bullet and a cover-letter paragraph actually run.
        // The sentence also shares the process words with the cited achievement, so a rejection is the span's.
        const inBullet = text => `Ran the ${candidate.process} with ${text}.`;
        const bound = compiled => evidenceFor(compiled, `Ran the ${candidate.process}.`).map(entry => entry.quote);
        const supportedYears = evidenceFor(B, `Brought ${count} years of hands-on ${field} experience to the team.`).map(entry => entry.quote);
        for (const [label, compiled] of [['A', A], ['C', C]]) {
          const verdict = bulletVerdict(inBullet(claims.exact), quotesOf(compiled));
          assert(!verdict.accepted && /claims an experience span/u.test(verdict.message), `${candidate.key} ${label}: the bullet gate rejects the unstated span, got ${verdict.message || 'acceptance'}`);
        }
        for (const kind of ['exact', 'floor']) {
          const verdict = bulletVerdict(inBullet(claims[kind]), [...bound(B), ...supportedYears]);
          assert(verdict.accepted, `${candidate.key} B: the bullet gate accepts "${claims[kind]}" under the achievement that states it, got ${verdict.message}`);
        }
        for (const kind of ['inflated', 'off', 'computed']) {
          const verdict = bulletVerdict(inBullet(claims[kind]), [...bound(B), ...supportedYears]);
          assert(!verdict.accepted && /claims an experience span/u.test(verdict.message), `${candidate.key} B: the bullet gate rejects "${claims[kind]}", got ${verdict.message || 'acceptance'}`);
        }
        // A span stated for one achievement is not a span of the unit that cites only its sibling.
        const withoutSpan = bulletVerdict(inBullet(claims.exact), bound(B));
        assert(!withoutSpan.accepted && /claims an experience span/u.test(withoutSpan.message), `${candidate.key} B: the span is not carried to a unit that does not cite the line stating it, got ${withoutSpan.message || 'acceptance'}`);
      }
    },
  },
  {
    name: 'Adaptability metrics: cover-letter figure discipline follows the résumé evidence, the planned anchor, and the figure budget',
    run() {
      let measuredCandidates = 0;
      for (const candidate of CANDIDATES) {
        // Bare counts: every candidate, every digit class.
        const { A, B, C } = lifecycle(candidate, 'population', fmt(candidate.population.count));
        const faithful = letterOf(fill(candidate.population.claim, fmt(candidate.population.count), '{P}'));
        for (const [label, compiled] of [['A', A], ['C', C]]) {
          const verdict = letterVerdict(faithful, resumeBullets(compiled));
          assert(!verdict.passed && /absent from résumé evidence/u.test(verdict.detail), `${candidate.key} ${label}: a count the résumé does not state is flagged, got ${verdict.detail}`);
        }
        assert(letterVerdict(faithful, resumeBullets(B)).passed, `${candidate.key} B: the stated count passes`);
        for (const wrong of [candidate.population.count * 10, candidate.population.count + 1, Math.max(1, Math.floor(candidate.population.count / 10))]) {
          assert(!sourceWritesNumber(resumeBullets(B).join(' '), wrong), `${candidate.key}: ${wrong} is not written in any résumé bullet`);
          const verdict = letterVerdict(letterOf(fill(candidate.population.claim, fmt(wrong), '{P}')), resumeBullets(B));
          assert(!verdict.passed && /absent from résumé evidence/u.test(verdict.detail), `${candidate.key} B: near-miss count ${fmt(wrong)} is flagged as absent, got ${verdict.detail}`);
        }
        // The figure budget: a supported figure is still counted every time it appears. The sentence is
        // repeated MAX_LETTER_FIGURES times (within budget) and once more (over), whatever the maximum is.
        const repeated = times => [Array.from({ length: times }, () => faithful[0]).join(' ')];
        const budget = letterVerdict(repeated(MAX_LETTER_FIGURES + 1), resumeBullets(B));
        assert(!budget.passed && new RegExp(`maximum is ${MAX_LETTER_FIGURES}`, 'u').test(budget.detail), `${candidate.key}: more than ${MAX_LETTER_FIGURES} figures is flagged even when each is supported, got ${budget.detail}`);
        assert(!/absent from résumé evidence/u.test(budget.detail), `${candidate.key}: the over-budget letter is flagged for its count alone, not for an unsupported figure`);
        assert(letterVerdict(repeated(MAX_LETTER_FIGURES), resumeBullets(B)).passed, `${candidate.key}: ${MAX_LETTER_FIGURES} supported figures are within budget`);

        // Percent and currency measures; multiplier candidates are covered by the dedicated letter-gate multiplier test.
        if (isMultiplier(candidate)) continue;
        measuredCandidates += 1;
        const measured = lifecycle(candidate, 'measure', candidate.measure.figure);
        const letter = letterOf(fill(candidate.measure.claim, candidate.measure.figure));
        for (const [label, compiled] of [['A', measured.A], ['C', measured.C]]) {
          const verdict = letterVerdict(letter, resumeBullets(compiled));
          assert(!verdict.passed && /absent from résumé evidence/u.test(verdict.detail), `${candidate.key} ${label}: ${candidate.measure.figure} is flagged while no bullet states it, got ${verdict.detail}`);
        }
        assert(letterVerdict(letter, resumeBullets(measured.B)).passed, `${candidate.key} B: ${candidate.measure.figure} passes once a bullet states it`);
        const letterMutants = figureMutants(candidate.measure.figure).filter(item => item.label !== 'kind' && item.label !== 'sign');
        assert(letterMutants.length >= 3, `${candidate.key}: at least three letter near-misses derived`);
        for (const mutant of letterMutants) {
          assert(!resumeBullets(measured.B).join(' ').includes(mutant.text), `${candidate.key}: ${mutant.text} is not written in any résumé bullet`);
          const verdict = letterVerdict(letterOf(fill(candidate.measure.claim, mutant.text)), resumeBullets(measured.B));
          assert(!verdict.passed && /absent from résumé evidence/u.test(verdict.detail), `${candidate.key} B: letter near-miss ${mutant.text} (${mutant.label}) is flagged as absent, got ${verdict.detail}`);
        }
        // Planned anchors: the figure must come from the evidence the plan selected, not from
        // any other bullet that happens to state a number.
        const bullets = resumeBullets(measured.B);
        const leadBullet = fill(candidate.measure.line, candidate.measure.figure);
        const siblingBullet = fill(candidate.sibling.line, candidate.sibling.figure);
        assert(bullets.includes(leadBullet) && bullets.includes(siblingBullet), `${candidate.key}: both roles' figures are in the résumé`);
        const anchoredElsewhere = letterVerdict(letter, bullets, { mappings: [{ evidence: siblingBullet }] });
        assert(!anchoredElsewhere.passed && /absent from résumé evidence/u.test(anchoredElsewhere.detail), `${candidate.key}: a figure anchored to the other role's bullet is flagged, got ${anchoredElsewhere.detail}`);
        assert(letterVerdict(letter, bullets, { mappings: [{ evidence: leadBullet }] }).passed, `${candidate.key}: the same letter passes when planned against its own bullet`);
        const siblingLetter = letterOf(fill(candidate.sibling.claim, candidate.sibling.figure));
        const siblingUnderLead = letterVerdict(siblingLetter, bullets, { mappings: [{ evidence: leadBullet }] });
        assert(!siblingUnderLead.passed && /absent from résumé evidence/u.test(siblingUnderLead.detail), `${candidate.key}: the other role's figure is flagged under this role's anchor, got ${siblingUnderLead.detail}`);
        assert(letterVerdict(siblingLetter, bullets, { mappings: [{ evidence: siblingBullet }] }).passed, `${candidate.key}: the other role's figure passes under its own anchor`);
      }
      assert(measuredCandidates >= 4, `the percent / currency letter assertions covered at least four candidates (${measuredCandidates})`);
    },
  },
  {
    name: 'Adaptability metrics: a quantity stated for one role cannot support a claim bound to another role',
    run() {
      for (const candidate of CANDIDATES) {
        const B = compileApproved(candidate, ['measure', 'population', 'scale']);
        const leadEntries = roleEvidence(B, 0);
        const priorEntries = roleEvidence(B, 1);
        const lead = leadEntries.map(entry => entry.quote);
        const prior = priorEntries.map(entry => entry.quote);
        assert(prior.some(quote => quote.includes(candidate.sibling.figure)) && !prior.some(quote => quote.includes(candidate.measure.figure)), `${candidate.key}: each role states only its own figure`);
        const leadClaim = fill(candidate.measure.claim, candidate.measure.figure);
        const priorClaim = fill(candidate.sibling.claim, candidate.sibling.figure);
        assert(bulletVerdict(leadClaim, lead).accepted, `${candidate.key}: the lead claim is accepted against its own role's evidence`);
        assert(bulletVerdict(priorClaim, prior).accepted, `${candidate.key}: the prior-role claim is accepted against its own role's evidence`);
        const leadBorrowed = bulletVerdict(fill(candidate.measure.claim, candidate.sibling.figure), lead);
        assert(!leadBorrowed.accepted && /unsupported figure/u.test(leadBorrowed.message), `${candidate.key}: the other role's ${candidate.sibling.figure} cannot be used on the lead role, got ${leadBorrowed.message || 'acceptance'}`);
        const priorBorrowed = bulletVerdict(fill(candidate.sibling.claim, candidate.measure.figure), prior);
        assert(!priorBorrowed.accepted && /unsupported figure/u.test(priorBorrowed.message), `${candidate.key}: the lead role's ${candidate.measure.figure} cannot be used on the prior role, got ${priorBorrowed.message || 'acceptance'}`);
        // A scale qualifier stated for the lead role does not carry to the prior role.
        const priorScale = `Ran the ${candidate.process} at scale.`;
        const priorScaleVerdict = bulletVerdict(priorScale, prior);
        assert(!priorScaleVerdict.accepted && /unsupported at-scale status/u.test(priorScaleVerdict.message), `${candidate.key}: "at scale" is rejected under the prior role's evidence, got ${priorScaleVerdict.message || 'acceptance'}`);
        assert(bulletVerdict(priorScale, lead).accepted, `${candidate.key}: "at scale" holds where the cited role's evidence states it`);
        // Nor does a population count. The unit cites one role's entries; the plan holds both roles' evidence.
        const populationClaim = fill(candidate.population.claim, fmt(candidate.population.count), '{P}');
        const crossRolePopulation = populationVerdict(populationClaim, priorEntries, B.catalog);
        assert(!crossRolePopulation.accepted && crossRolePopulation.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key}: the lead role's population count is rejected under the prior role's cited evidence, got ${crossRolePopulation.errors.join(' | ') || 'acceptance'}`);
        assert(populationVerdict(populationClaim, evidenceFor(B, fill(candidate.population.line, fmt(candidate.population.count), '{P}')), B.catalog).accepted, `${candidate.key}: the same count is accepted under the evidence that states it`);
        // Binding is per cited unit, not just per role: a figure or count stated by ANOTHER achievement of the
        // same role is not evidence for a unit that cites only this one.
        const populationQuotes = evidenceFor(B, fill(candidate.population.line, fmt(candidate.population.count), '{P}')).map(entry => entry.quote);
        // One bullet states a supported count and then another achievement's figure: only the figure is unsupported.
        const stacked = `${populationClaim} ${fill(candidate.measure.claim, candidate.measure.figure)}`;
        assert(bulletVerdict(populationClaim, populationQuotes).accepted, `${candidate.key}: the population sentence alone is supported by its own achievement`);
        const figureUnderPopulation = bulletVerdict(stacked, populationQuotes);
        assert(!figureUnderPopulation.accepted && /unsupported figure/u.test(figureUnderPopulation.message), `${candidate.key}: ${candidate.measure.figure} is not carried to a unit that cites only the population achievement, got ${figureUnderPopulation.message || 'acceptance'}`);
        const countUnderMeasure = populationVerdict(populationClaim, evidenceFor(B, fill(candidate.measure.line, candidate.measure.figure)), B.catalog);
        assert(!countUnderMeasure.accepted && countUnderMeasure.errors.some(error => POPULATION_REJECTION.test(error)), `${candidate.key}: the population count is not carried to a unit that cites only the measurement achievement, got ${countUnderMeasure.errors.join(' | ') || 'acceptance'}`);
        // Candidate isolation: another candidate's figure is just a number this source never stated.
        const other = CANDIDATES[(CANDIDATES.indexOf(candidate) + 1) % CANDIDATES.length];
        const foreign = bulletVerdict(fill(candidate.measure.claim, other.measure.figure), lead);
        assert(!foreign.accepted && /unsupported figure/u.test(foreign.message), `${candidate.key}: ${other.key}'s figure ${other.measure.figure} is not evidence for this candidate`);
      }
    },
  },
  {
    name: 'Adaptability metrics: a comparative outcome (reduced, improved, raised) needs the current evidence to state that direction',
    run() {
      for (const candidate of CANDIDATES) {
        const { A, B, C } = lifecycle(candidate, 'outcome', 'Reduced the effort');
        for (const direction of OUTCOME_DIRECTIONS) {
          const claim = direction.claim(candidate.process);
          for (const [label, compiled] of [['A', A], ['C', C]]) {
            const verdict = bulletVerdict(claim, quotesOf(compiled));
            assert(!verdict.accepted && direction.rule.test(verdict.message), `${candidate.key} ${label}: "${claim}" is rejected while the source states no such change, got ${verdict.message || 'acceptance'}`);
          }
          const supported = bulletVerdict(claim, quotesOf(B));
          assert(supported.accepted, `${candidate.key} B: "${claim}" is accepted once the source states the change, got ${supported.message}`);
        }
        // One stated direction does not license another.
        const onlyReduced = compileApproved(candidate, [{ claim: OUTCOME_DIRECTIONS[0].line(candidate.process) }]);
        assert(bulletVerdict(OUTCOME_DIRECTIONS[0].claim(candidate.process), quotesOf(onlyReduced)).accepted, `${candidate.key}: the stated direction is accepted`);
        for (const other of OUTCOME_DIRECTIONS.slice(1)) {
          const verdict = bulletVerdict(other.claim(candidate.process), quotesOf(onlyReduced));
          assert(!verdict.accepted && other.rule.test(verdict.message), `${candidate.key}: a stated reduction does not license "${other.claim(candidate.process)}"`);
        }
      }
    },
  },
  {
    name: 'Adaptability metrics: a quantity in a job listing never becomes candidate experience until the career source states it',
    run() {
      let pairs = 0;
      for (const candidate of CANDIDATES) {
        const base = compileApproved(candidate, []);
        // Pair every candidate with every listing: the verdict must not depend on which posting asks.
        for (const listing of LISTINGS) {
          const figure = listingFigure(listing);
          const years = listingYears(listing);
          assert(figure && years > 0, `the listing states a figure and a span: ${listing.slice(0, 50)}`);
          assert(!quotesOf(base).some(quote => quote.includes(figure)), `${candidate.key}: the base career evidence does not contain the listing's ${figure}`);
          const figureClaim = fill(candidate.measure.claim, figure);
          const yearsClaim = `${years} years of ${candidate.years.field} experience`;
          const copied = bulletVerdict(figureClaim, quotesOf(base));
          assert(!copied.accepted && /unsupported figure/u.test(copied.message), `${candidate.key}: the listing's ${figure} is not accepted as this candidate's result, got ${copied.message || 'acceptance'}`);
          const copiedYears = findUnsupportedDurationClaim(yearsClaim, quotesOf(base));
          assert(copiedYears && copiedYears.years === years && copiedYears.statedYears.length === 0, `${candidate.key}: the listing's ${years}-year requirement is not accepted as this candidate's experience, got ${JSON.stringify(copiedYears)}`);
          // The same figure and span flip to admissible only when THIS candidate's own source states them,
          // and flip back when those lines are removed from the source again.
          const figureFeature = { claim: fill(candidate.measure.line, figure), metric: { label: candidate.measure.label, value: figure, unit: '' } };
          const yearsFeature = { claim: `Brought ${years} years of hands-on ${candidate.years.field} experience to the team.` };
          const adopted = compileApproved(candidate, [figureFeature, yearsFeature]);
          assert(adopted.snapshotId !== base.snapshotId, `${candidate.key}: recompiling issues a new snapshot id`);
          const adoptedVerdict = bulletVerdict(figureClaim, quotesOf(adopted));
          assert(adoptedVerdict.accepted, `${candidate.key}: ${figure} is admissible once the career source states it, got ${adoptedVerdict.message}`);
          assert(!findUnsupportedDurationClaim(yearsClaim, quotesOf(adopted)), `${candidate.key}: ${years} years is admissible once the career source states it`);
          const revoked = withoutFeature(withoutFeature(adopted, figureFeature), yearsFeature);
          assert(revoked.text === base.text && revoked.snapshotId === base.snapshotId, `${candidate.key}: removing both lines restores the original source and snapshot id`);
          const revokedFigure = bulletVerdict(figureClaim, quotesOf(revoked));
          assert(!revokedFigure.accepted && /unsupported figure/u.test(revokedFigure.message), `${candidate.key}: removing the line revokes ${figure}, got ${revokedFigure.message || 'acceptance'}`);
          assert(findUnsupportedDurationClaim(yearsClaim, quotesOf(revoked)), `${candidate.key}: removing the line revokes the ${years}-year span`);
          pairs += 1;
        }
      }
      assert(pairs === CANDIDATES.length * LISTINGS.length, `every candidate was judged against every listing (${pairs})`);
    },
  },
  {
    name: 'Adaptability metrics: an approved snapshot cannot carry an altered or invented quantity',
    run() {
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['measure']);
        const clone = () => structuredClone(approved.snapshot);
        const control = validateCurrentCareerSnapshot(clone());
        assert(control.valid, `${candidate.key}: an untouched copy still validates`);
        const measureOf = snapshot => snapshot.profile.achievements.find(item => item.claim === fill(candidate.measure.line, candidate.measure.figure));
        for (const mutant of figureMutants(candidate.measure.figure)) {
          const metricTampered = clone();
          measureOf(metricTampered).metrics[0].value = mutant.text;
          const metricResult = validateCurrentCareerSnapshot(metricTampered);
          assert(!metricResult.valid && metricResult.errors.some(error => /metric value is not grounded/u.test(error)), `${candidate.key}: approved snapshot with metric ${mutant.text} (${mutant.label}) is refused at read time`);
          const claimTampered = clone();
          measureOf(claimTampered).claim = fill(candidate.measure.line, mutant.text);
          const claimResult = validateCurrentCareerSnapshot(claimTampered);
          assert(!claimResult.valid && claimResult.errors.some(error => /claim is not grounded/u.test(error)), `${candidate.key}: approved snapshot whose claim states ${mutant.text} (${mutant.label}) is refused at read time`);
        }
        // An invented metric smuggled into a snapshot approved for source A.
        const base = compileApproved(candidate, []);
        const injected = structuredClone(base.snapshot);
        const bare = injected.profile.achievements.find(item => item.claim === candidate.measure.bare);
        bare.metrics = [{ label: candidate.measure.label, value: candidate.measure.figure, unit: '', evidenceSegmentIds: [...bare.evidenceSegmentIds] }];
        const injectedResult = validateCurrentCareerSnapshot(injected);
        assert(!injectedResult.valid && injectedResult.errors.some(error => /metric value is not grounded/u.test(error)), `${candidate.key}: a metric the source never states cannot be added to an approved snapshot`);
      }
    },
  },
  {
    name: 'Adaptability metrics: a profile metric cannot borrow a real number from another achievement, another role, or an invented label',
    run() {
      const PARENT_RULE = /is not also cited by its parent entity/u;
      const UNGROUNDED = /metric (?:label|value|unit) is not grounded/u;
      for (const candidate of CANDIDATES) {
        const measureLine = fill(candidate.measure.line, candidate.measure.figure);
        const populationLine = fill(candidate.population.line, fmt(candidate.population.count), '{P}');
        const siblingLine = fill(candidate.sibling.line, candidate.sibling.figure);
        const features = ['measure', 'population'];
        const base = compileProfile(candidate, features);
        assert(base.validation.valid, `${candidate.key}: the faithful profile is admitted`);
        const approved = compileApproved(candidate, features);
        const measureOf = profile => profile.achievements.find(item => item.claim === measureLine);
        // A real, fully grounded quantity taken from a different line: the line is cited by the metric but
        // not by the achievement the metric is attached to. Grounding alone cannot catch this.
        const borrowed = [
          { why: 'another role', metric: { label: candidate.measure.label, value: candidate.sibling.figure, unit: '', evidenceSegmentIds: [segmentIdOf(base, siblingLine)] } },
          { why: 'another achievement of the same role', metric: { label: candidate.population.noun, value: fmt(candidate.population.count), unit: '', evidenceSegmentIds: [segmentIdOf(base, populationLine)] } },
        ];
        for (const { why, metric } of borrowed) {
          const tampered = compileProfile(candidate, features, { tamper: profile => { measureOf(profile).metrics = [{ ...metric }]; } });
          assert(!tampered.validation.valid && tampered.validation.errors.some(error => PARENT_RULE.test(error)), `${candidate.key}: a metric whose evidence is a line of ${why} is refused, got ${tampered.validation.errors.join(' | ') || 'acceptance'}`);
          assert(!tampered.validation.errors.some(error => UNGROUNDED.test(error)), `${candidate.key}: the number from ${why} is genuinely stated on its own line, so only the binding rule can refuse it, got ${tampered.validation.errors.join(' | ')}`);
          // The approved, immutable snapshot is refused for the same reason at read time.
          const snapshot = structuredClone(approved.snapshot);
          measureOf(snapshot.profile).metrics = [{ ...metric }];
          const refused = validateCurrentCareerSnapshot(snapshot);
          assert(!refused.valid && refused.errors.some(error => PARENT_RULE.test(error)), `${candidate.key}: an approved snapshot carrying a metric borrowed from ${why} is refused at read time`);
        }
        // An invented label, borrowed from an unrelated candidate, is not what its own line says.
        const foreignLabel = CANDIDATES.map(item => item.measure.label).find(label => !new RegExp(label, 'iu').test(base.text));
        assert(foreignLabel, `${candidate.key}: another candidate's metric label is absent from this source`);
        const relabeled = compileProfile(candidate, features, { tamper: profile => { measureOf(profile).metrics[0].label = foreignLabel; } });
        assert(!relabeled.validation.valid && relabeled.validation.errors.some(error => /metric label is not grounded/u.test(error)), `${candidate.key}: metric label "${foreignLabel}" is refused as ungrounded, got ${relabeled.validation.errors.join(' | ') || 'acceptance'}`);
        // Control: the metric on its own line is admitted.
        assert(measureOf(base.profile).metrics.length === 1 && base.validation.valid, `${candidate.key}: the faithful metric is admitted`);
      }
    },
  },
  {
    name: 'Adaptability metrics: in a cover-letter paragraph a listing figure is tolerated as the posting\'s fact and refused as the candidate\'s',
    run() {
      for (const candidate of CANDIDATES) {
        for (const listing of LISTINGS) {
          const figure = listingFigure(listing);
          const posting = listing.split(/(?<=\.)\s+/u).find(sentence => sentence.includes(figure));
          assert(posting, `${candidate.key}: the listing sentence stating ${figure} is found in the listing text`);
          const own = `I ran the ${candidate.process} for the team.`;
          const adoptedLine = `Ran the ${candidate.process} at ${figure} for the team.`;
          const base = compileApproved(candidate, []);
          // The listing's own sentence, then ordinary candidate work the evidence states.
          const attributedToPosting = paragraphVerdict(`${posting} ${own}`, quotesOf(base));
          assert(attributedToPosting.accepted, `${candidate.key}: a sentence about the posting's own ${figure} is not graded as candidate experience, got ${attributedToPosting.message}`);
          // The same figure presented as the candidate's own result is a claim about the candidate.
          const claimed = `I ran the ${candidate.process} at ${figure} for the team.`;
          const claimedVerdict = paragraphVerdict(claimed, quotesOf(base));
          assert(!claimedVerdict.accepted && /unsupported figure/u.test(claimedVerdict.message), `${candidate.key}: the listing's ${figure} claimed as the candidate's own is refused, got ${claimedVerdict.message || 'acceptance'}`);
          // Recompilation with a source line that really states it admits the claim; removing the line refuses it again.
          const B = compileApproved(candidate, [{ claim: adoptedLine }]);
          const accepted = paragraphVerdict(claimed, quotesOf(B));
          assert(accepted.accepted, `${candidate.key}: ${figure} is admissible once the career source states it, got ${accepted.message}`);
          const C = withoutFeature(B, { claim: adoptedLine });
          assert(C.snapshotId === base.snapshotId, `${candidate.key}: removing the line restores the original snapshot id`);
          const revoked = paragraphVerdict(claimed, quotesOf(C));
          assert(!revoked.accepted && /unsupported figure/u.test(revoked.message), `${candidate.key}: removing the source line revokes ${figure} again, got ${revoked.message || 'acceptance'}`);
        }
      }
    },
  },
  {
    // electron/ipc/localAiApplication.js pasteAttributionScopeErrors: the lower-bound
    // branch builds its pattern from `escapedScope.slice(0, -1)`; escaping turned the
    // trailing "+" into "\+", so slicing leaves a dangling backslash and the RegExp
    // constructor throws. Any "<N>+ <population noun>" claim crashes the validator instead of
    // being judged, even when the source itself writes "<N>+".
    name: 'Adaptability metrics [fixed defect]: a lower-bound population claim "N+ users" is judged, not a thrown SyntaxError',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const { count, noun } = candidate.population;
        const plusClaim = fill(candidate.population.claim, `${count}+`, '{P}');
        const exact = compileApproved(candidate, ['population']);
        const stated = compileApproved(candidate, [{ claim: fill(candidate.population.line, `${count}+`, '{P}') }]);
        const unsupported = populationVerdict(plusClaim, evidenceFor(exact, fill(candidate.population.line, fmt(count), '{P}')));
        if (unsupported.threw) violations.push(`${candidate.key}: "${count}+ ${noun}" threw ${unsupported.threw.name}`);
        else if (unsupported.accepted) violations.push(`${candidate.key}: "${count}+ ${noun}" accepted from a source stating exactly ${count}`);
        const supported = populationVerdict(plusClaim, evidenceFor(stated, fill(candidate.population.line, `${count}+`, '{P}')));
        if (supported.threw) violations.push(`${candidate.key}: "${count}+ ${noun}" threw ${supported.threw.name} even though the source states "${count}+"`);
        else if (!supported.accepted) violations.push(`${candidate.key}: "${count}+ ${noun}" rejected although the source states it`);
      }
      assertNoViolations(violations, 'lower-bound population claims');
    },
  },
  {
    // electron/ipc/localAiApplication.js SOURCE_GROUNDING_QUALIFIER_RULES recognizes only a
    // closed set of scale words ("at scale", "<org>-wide"), and pasteAttributionScopeErrors only
    // counts "<digits> <noun>". "millions of users", "enterprise-scale", "high-volume" and
    // "thousands of ..." are scale claims with no digit and no recognized qualifier.
    name: 'Adaptability metrics [fixed defect]: vague scale language is rejected when the source states no scale',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const base = compileApproved(candidate, []);
        const bound = evidenceFor(base, `Ran the ${candidate.process}.`);
        const phrases = [
          `Ran the ${candidate.process} for millions of ${candidate.population.noun}.`,
          `Ran the ${candidate.process} for thousands of ${candidate.population.noun}.`,
          `Ran the enterprise-scale ${candidate.process}.`,
          `Ran the high-volume ${candidate.process}.`,
          `Ran the ${candidate.process} across a global network.`,
          // The same family as the guarded "<org>-wide", spelled with a scope word the closed list lacks.
          `Rolled out the ${candidate.process} nationwide.`,
          `Rolled out the ${candidate.process} worldwide.`,
          `Rolled out the ${candidate.process} department-wide.`,
          `Rolled out the ${candidate.process} facility-wide.`,
        ];
        // Scale language read straight out of the synthetic listings: a posting's scale is not the candidate's.
        for (const listing of LISTINGS) {
          for (const word of listing.match(/\b(?:millions of [a-z]+|high-volume|enterprise-scale|enterprise-wide|\d[\d,]* (?:million|billion) [a-z]+)/giu) || []) {
            phrases.push(/^(?:high-volume|enterprise-scale|enterprise-wide)$/iu.test(word) ? `Ran the ${word} ${candidate.process}.` : `Ran the ${candidate.process} for ${word}.`);
          }
        }
        for (const phrase of phrases) {
          if (bulletVerdict(phrase, bound.map(entry => entry.quote)).accepted && populationVerdict(phrase, bound).accepted) violations.push(`${candidate.key}: "${phrase}"`);
        }
      }
      assertNoViolations(violations, 'scale language without a stated scale');
    },
  },
  {
    // electron/ipc/localAiApplication.js SOURCE_GROUNDING_QUALIFIER_RULES has no
    // comparative-magnitude rule, and sourceGroundingFigures needs digits. "doubling",
    // "halving", "tripling" and "twice as" assert a quantified comparison with nothing to check.
    name: 'Adaptability metrics [fixed defect]: comparative magnitude claims need a stated comparison',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const base = compileApproved(candidate, []);
        const quotes = evidenceFor(base, `Ran the ${candidate.process}.`).map(entry => entry.quote);
        for (const tail of ['doubling the rate', 'halving the effort', 'tripling the output', 'twice as fast as before']) {
          const claim = `Ran the ${candidate.process}, ${tail}.`;
          if (bulletVerdict(claim, quotes).accepted) violations.push(`${candidate.key}: "${claim}"`);
        }
        // The direction is stated ("Reduced ..."), the magnitude ("by half") is not.
        const reduced = compileApproved(candidate, [{ claim: OUTCOME_DIRECTIONS[0].line(candidate.process) }]);
        const reducedQuotes = evidenceFor(reduced, OUTCOME_DIRECTIONS[0].line(candidate.process)).map(entry => entry.quote);
        assert(bulletVerdict(OUTCOME_DIRECTIONS[0].claim(candidate.process), reducedQuotes).accepted, `${candidate.key}: the stated direction alone is accepted (control)`);
        for (const magnitude of ['by half', 'by two thirds', 'to a tenth of its former cost']) {
          const claim = `${OUTCOME_DIRECTIONS[0].claim(candidate.process).replace(/\.$/u, '')} ${magnitude}.`;
          if (bulletVerdict(claim, reducedQuotes).accepted) violations.push(`${candidate.key}: "${claim}" (direction stated, magnitude not)`);
        }
      }
      assertNoViolations(violations, 'comparative magnitude without a stated comparison');
    },
  },
  {
    // electron/ipc/localAiApplication.js sourceGroundingFigures deliberately skips bare numerals
    // (kind "number"), and pasteAttributionScopeErrors only checks a closed noun list. A tenfold
    // inflation of "40 care-plan reviews" or "600 pallets" passes every deterministic gate in the
    // résumé path. (Faithful restatement is accepted, so the control below holds today.)
    name: 'Adaptability metrics [fixed defect]: an inflated bare count is rejected in a résumé bullet',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['tally']);
        const evidence = evidenceFor(approved, fill(candidate.tally.line, String(candidate.tally.count), '{N}'));
        const quotes = evidence.map(entry => entry.quote);
        assert(bulletVerdict(fill(candidate.tally.claim, String(candidate.tally.count), '{N}'), quotes).accepted, `${candidate.key}: the faithful tally restatement is accepted (control)`);
        for (const wrong of [candidate.tally.count * 10, candidate.tally.count + 1]) {
          const claim = fill(candidate.tally.claim, String(wrong), '{N}');
          if (bulletVerdict(claim, quotes).accepted && populationVerdict(claim, evidence).accepted) violations.push(`${candidate.key}: "${claim}" vs ${candidate.tally.count}`);
        }
      }
      assertNoViolations(violations, 'inflated bare count');
    },
  },
  {
    // electron/ipc/localAiApplication.js pasteAttributionScopeErrors: the population claim
    // requires the source to state "<digits> <noun>" but never reads the words before it. "over
    // 50 patients" and "more than 500 customers" are lower bounds that exceed the stated count.
    name: 'Adaptability metrics [fixed defect]: "over N" and "more than N" do not ride on an exact N',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['population']);
        const evidence = evidenceFor(approved, fill(candidate.population.line, fmt(candidate.population.count), '{P}'));
        for (const hedge of ['over', 'more than']) {
          const claim = fill(candidate.population.claim, `${hedge} ${fmt(candidate.population.count)}`, '{P}');
          if (populationVerdict(claim, evidence).accepted) violations.push(`${candidate.key}: "${claim}"`);
        }
      }
      assertNoViolations(violations, 'bounded population claim exceeding its evidence');
    },
  },
  {
    // electron/ipc/careerSnapshot.js validateMetric grounds each of label/value/unit with
    // scalarInEvidence, a case-insensitive SUBSTRING test. A truncation of the stated number is a
    // substring of it.
    name: 'Adaptability metrics [fixed defect]: a metric value that is a truncation of the stated number is rejected by the profile gate',
    run() {
      const violations = [];
      let probed = 0;
      for (const candidate of CANDIDATES) {
        const { number } = parseFigure(candidate.measure.figure);
        const truncated = number.slice(0, -1).replace(/[.,]$/u, '');
        if (!/\d/u.test(truncated)) continue;
        probed += 1;
        const result = compileProfile(candidate, ['measure'], { tamper: profile => {
          profile.achievements.find(item => item.claim === fill(candidate.measure.line, candidate.measure.figure)).metrics[0].value = truncated;
        } });
        if (result.validation.valid) violations.push(`${candidate.key}: metric value "${truncated}" grounded by "${number}"`);
      }
      assert(probed >= 4, 'the truncation probe covered at least four candidates');
      // The same substring grounding admits an ACHIEVEMENT CLAIM that stops in the middle of the stated number.
      let claimsProbed = 0;
      for (const candidate of CANDIDATES) {
        const line = fill(candidate.measure.line, candidate.measure.figure);
        const { number } = parseFigure(candidate.measure.figure);
        const cut = line.indexOf(number) + number.length - 1;
        const truncatedClaim = line.slice(0, cut).replace(/[.,]$/u, '').trimEnd();
        if (!/\d$/u.test(truncatedClaim) || truncatedClaim.endsWith(number)) continue;
        claimsProbed += 1;
        const result = compileProfile(candidate, ['measure'], { tamper: profile => {
          profile.achievements.find(item => item.claim === line).claim = truncatedClaim;
        } });
        if (result.validation.valid) violations.push(`${candidate.key}: claim "…${truncatedClaim.slice(-24)}" is grounded by the full "${number}"`);
      }
      assert(claimsProbed >= 4, 'the claim-truncation probe covered at least four candidates');
      assertNoViolations(violations, 'truncated metric value or claim');
    },
  },
  {
    // electron/ipc/coverLetterChecks.js figures()/normalizeFigure(): a multiplier ("30x"), a
    // spelled-out number above twenty ("forty percent") and a magnitude word ("2 million" vs
    // "2 thousand") are not figures to checkFigureDiscipline, so an invented or inflated one
    // passes the letter's figure gate.
    name: 'Adaptability metrics [fixed defect]: the letter figure gate sees multipliers, spelled-out percentages and magnitude words',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const stem = candidate.measure.bare.replace(/\.$/u, '');
        const noun = candidate.population.noun;
        const probes = [
          { why: 'multiplier 30x vs 3x', evidence: `${stem} at 3x speed.`, letter: `${stem} at 30x speed.` },
          { why: 'spelled-out percentage never stated', evidence: `${stem}.`, letter: `${stem} and lifted the rate by forty percent.` },
          { why: '2 million vs 2 thousand', evidence: `${stem} for 2 thousand ${noun}.`, letter: `${stem} for 2 million ${noun}.` },
        ];
        for (const probe of probes) {
          if (letterVerdict(letterOf(probe.letter), [probe.evidence]).passed) violations.push(`${candidate.key}: ${probe.why}`);
        }
      }
      assertNoViolations(violations, 'letter figure forms');
    },
  },
  {
    // electron/ipc/coverLetterChecks.js normalizeFigure(): "40 percent" is not normalized to
    // "40%" when the digit and the word are spelled apart from the evidence's "40%", so a
    // faithful restatement is flagged as an absent figure. Over-strict rather than unsafe.
    name: 'Adaptability metrics [fixed defect]: a faithful "N percent" restatement of an evidenced "N%" is accepted by the letter figure gate',
    run() {
      const percentCandidates = CANDIDATES.filter(candidate => candidate.measure.figure.endsWith('%'));
      assert(percentCandidates.length >= 3, 'three candidates state a percentage');
      const violations = [];
      for (const candidate of percentCandidates) {
        const { number } = parseFigure(candidate.measure.figure);
        const approved = compileApproved(candidate, ['measure']);
        const verdict = letterVerdict(letterOf(fill(candidate.measure.claim, `${number} percent`)), resumeBullets(approved));
        if (!verdict.passed) violations.push(`${candidate.key}: "${number} percent" vs ${candidate.measure.figure}: ${verdict.detail}`);
      }
      assertNoViolations(violations, 'faithful percent restatement');
    },
  },
  {
    // electron/ipc/localAiApplication.js sourceGroundingFigures only reads DIGIT figures, so a
    // spelled-out percentage / amount / multiplier ("ninety-five percent", "nine million dollars",
    // "nine times") is not a figure to the résumé gate. A spelled-out near-miss of an evidenced number
    // (and a spelled-out invention) passes, which is also the cheapest way around the figure gate.
    name: 'Adaptability metrics [fixed defect]: a spelled-out figure is held to the evidence like a digit figure',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['measure']);
        const quotes = evidenceFor(approved, fill(candidate.measure.line, candidate.measure.figure)).map(entry => entry.quote);
        const { prefix, suffix } = parseFigure(candidate.measure.figure);
        const spelled = suffix === '%' ? 'ninety-five percent' : prefix === '$' ? 'nine million dollars' : 'nine times';
        const claim = fill(candidate.measure.claim, spelled);
        assert(!approved.text.includes(spelled), `${candidate.key}: "${spelled}" is not written in the source`);
        if (bulletVerdict(claim, quotes).accepted) violations.push(`${candidate.key}: "${spelled}" vs ${candidate.measure.figure}`);
      }
      assertNoViolations(violations, 'spelled-out figure');
    },
  },
  {
    // electron/ipc/localAiApplication.js sourceGroundingFigures / pasteAttributionScopeErrors ground the
    // NUMBER (and its kind), never the unit or interval it is stated per. "50 patients per shift" and
    // "50 patients per hour" are very different rates and the second passes both deterministic gates.
    name: 'Adaptability metrics [fixed defect]: a rate keeps the interval the evidence states it per',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['measure', 'population', 'tally']);
        for (const [feature, claim, line, count] of [
          ['tally', candidate.tally.claim, candidate.tally.line, String(candidate.tally.count)],
          ['measure', candidate.measure.claim, candidate.measure.line, candidate.measure.figure],
          ['population', candidate.population.claim, candidate.population.line, fmt(candidate.population.count)],
        ]) {
          const token = feature === 'tally' ? '{N}' : feature === 'population' ? '{P}' : '{F}';
          const evidence = evidenceFor(approved, fill(line, count, token));
          const stated = fill(claim, count, token);
          const interval = /\b(per (?:shift|sprint|quarter|project|service|day|order cycle|month)|each month)\b/u.exec(stated)?.[0];
          if (!interval) continue;
          const changed = stated.replace(interval, 'per hour');
          assert(changed !== stated && !approved.text.includes('per hour'), `${candidate.key}: "per hour" is not written in the source`);
          if (bulletVerdict(changed, evidence.map(entry => entry.quote)).accepted && populationVerdict(changed, evidence, approved.catalog).accepted) violations.push(`${candidate.key}: "${interval}" -> "per hour" (${feature})`);
        }
      }
      assertNoViolations(violations, 'rate interval changed');
    },
  },
  {
    // electron/ipc/localAiApplication.js pasteAttributionScopeErrors only counts populations named by a
    // CLOSED noun list (users, students, patients, customers, ...). The same inflation with any other
    // noun ("guests", "members", "commuters") has no deterministic gate at all.
    name: 'Adaptability metrics [fixed defect]: an inflated population is rejected whatever noun names it',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const approved = compileApproved(candidate, ['population']);
        const evidence = evidenceFor(approved, fill(candidate.population.line, fmt(candidate.population.count), '{P}'));
        const inflated = fmt(candidate.population.count * 100);
        for (const noun of ['guests', 'members', 'commuters']) {
          assert(!new RegExp(`\\b${noun}\\b`, 'iu').test(approved.text), `${candidate.key}: "${noun}" is not written in the source`);
          const claim = fill(candidate.population.claim, inflated, '{P}').replace(candidate.population.noun, noun);
          if (bulletVerdict(claim, evidence.map(entry => entry.quote)).accepted && populationVerdict(claim, evidence, approved.catalog).accepted) violations.push(`${candidate.key}: "${inflated} ${noun}" vs ${fmt(candidate.population.count)} ${candidate.population.noun}`);
        }
      }
      assertNoViolations(violations, 'population under an open noun');
    },
  },
];

// ---------------------------------------------------------------------------
// Known gaps: the entry below asserts the rule and currently FAILS against
// production (it is deliberately not in the default export, which the registry
// runs). Every other gap recorded here was fixed and moved up as a
// `[fixed defect]` test. Every entry checks all candidates before failing so the
// message states how widespread the violation is.
// ---------------------------------------------------------------------------
function assertNoViolations(violations, rule) {
  assert(violations.length === 0, `${rule}: ${violations.length} violation(s), e.g. ${violations.slice(0, 3).join(' || ')}`);
}

export const knownGaps = [
  {
    // electron/ipc/careerSnapshot.js validateMetric grounds label, value and unit independently
    // against the same physical line, so a real number can be attached to a different quantity.
    // (Association is delegated to the independent metrics auditor by design; recorded here
    // because no deterministic check backs it.)
    name: 'Adaptability metrics (known gap): a number cannot be attached to a different quantity on the same source line',
    run() {
      const violations = [];
      for (const candidate of CANDIDATES) {
        const measureLine = fill(candidate.measure.line, candidate.measure.figure).replace(/\.$/u, '');
        const combined = `${measureLine}; roster of ${fmt(candidate.population.count)} ${candidate.population.noun}.`;
        const result = compileProfile(candidate, [{ claim: combined, metric: { label: candidate.population.noun, value: candidate.measure.figure, unit: '' } }]);
        if (result.validation.valid) violations.push(`${candidate.key}: "${candidate.population.noun}: ${candidate.measure.figure}"`);
      }
      assertNoViolations(violations, 'metric label/value association');
    },
  },
];
