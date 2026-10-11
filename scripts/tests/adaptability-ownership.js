// Adaptability family: EMPLOYERS / TITLES / OWNERSHIP LEVEL.
//
// The pipeline must be generic: a claim about who employed the candidate, what
// title they held, or how much of a piece of work they owned has to follow the
// CURRENT approved career JSON, and nothing else. This file proves that with
// the real production seams, never with a re-implementation of them:
//
//   - validateCareerProfile / validateCurrentCareerSnapshot  (compile gate)
//   - careerSnapshotId / approvedCareerEvidenceCatalog       (content-addressed
//     snapshot id and the host evidence catalog derived from the profile)
//   - buildApplicationCareerAuthority / validateAuthorityRoleEvidence
//     (trusted roles and role-scoped evidence derived from the snapshot)
//   - validateStructuredApplicationResume                    (résumé role identity)
//   - assertSourceQuoteLinksFinalText / pasteAttributionScopeErrors
//     (ownership wording, employer attribution, headcount in final prose)
//   - checkEndedRoleCurrentEmployment                        (employment status)
//
// THREE-WAY SEPARATION. Everything below the "synthetic candidates" banner is a
// SYNTHETIC SOURCE FIXTURE: four unrelated invented careers (hospital nurse,
// pastry chef, structural engineer, warehouse supervisor) and four invented job
// listings. None of it reaches production. The tests never hardcode which
// claims production should allow; each verdict comes from the production
// function, and the mutation pattern below makes the verdict a function of the
// source text alone:
//
//   A  source with only team language           -> ownership claim rejected
//   B  A + one directly supporting source line  -> recompiled (new snapshot id),
//                                                  the supported claim accepted
//   C  B with that line removed                 -> byte-identical to A, rejected
//
// The offline "compiler" (compileSpec) is a faithful TRANSCRIBER of the
// fixture, standing in for the AI compile step that cannot run in a unit test.
// It only points each profile entity at the literal source lines it was
// rendered from; production then judges the result (validateCareerProfile,
// validateCurrentCareerSnapshot). Unfaithful compiler output is modelled by
// mutating the PROFILE after transcription, never by relaxing production.
//
// Three kinds of verdict are asserted, and each names the production reason:
//   - rejections quote the check that fired (the ownership qualifier word, the
//     "must exactly match its trusted source role" field, "is not grounded" at
//     the entity label, ...), so an unrelated failure cannot pass for the gate;
//   - the mutation pattern flips the verdict by changing ONLY the source text
//     (including judging one identical profile object against A, B and C);
//   - near misses (a seniority prefix, a corporate suffix, a different
//     ownership level, a changed number) stay rejected while the faithful
//     wording is accepted.
//
// Tests tagged `[fixed defect]` guard gaps this sweep found and production has since
// fixed (the comment above each describes the defect as it was before the fix).
// `knownGaps` (named export, NOT run by the registry) is empty.
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
  projectApprovedCareerSnapshotForApplication,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority, validateAuthorityRoleEvidence } from '../../electron/ipc/applicationCareerAuthority.js';
import { assertSourceQuoteLinksFinalText, pasteAttributionScopeErrors } from '../../electron/ipc/localAiApplication.js';
import { checkEndedRoleCurrentEmployment } from '../../electron/ipc/coverLetterChecks.js';
import { validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';

// ---------------------------------------------------------------------------
// Synthetic candidates (test-only source fixtures; every name is invented)
// ---------------------------------------------------------------------------

// `claimVerb` is the ownership word an application writer might use; `sourceVerb`
// is how a career file would honestly state the same level of ownership;
// `teamPrefix` is team-language for the same work.
const MARKERS = Object.freeze([
  { id: 'led', claimVerb: 'Led', sourceVerb: 'Led', teamPrefix: 'Assisted with' },
  { id: 'owned', claimVerb: 'Owned', sourceVerb: 'Owned', teamPrefix: 'Contributed to' },
  { id: 'managed', claimVerb: 'Managed', sourceVerb: 'Managed', teamPrefix: 'Supported colleagues on' },
  { id: 'architected', claimVerb: 'Architected', sourceVerb: 'Created', teamPrefix: 'Contributed to' },
]);

const PEOPLE = Object.freeze([
  {
    id: 'hospital-nurse',
    name: 'Priya Nambiar', contact: 'priya.nambiar@example.test',
    current: { title: 'Charge Nurse', employer: 'Quillfeather Memorial Hospital', dates: 'March 2019 to Present' },
    prior: { title: 'Staff Nurse', employer: 'Thistledown Community Clinic', dates: 'June 2014 to February 2019' },
    currentBullets: [
      { key: 'team', text: 'Worked with a team of six nurses to document patient fall incidents.' },
      { key: 'census', text: 'Coordinated daily care for 24 patients per shift.' },
      { key: 'outsider', text: 'Attended vendor demonstrations from Marlowe Pharmacy Cooperative on infusion pumps.' },
    ],
    priorBullets: [
      { key: 'triage', text: 'Took part in weekend triage at the walk-in desk and trained four new nurses.' },
      { key: 'prior-log', text: 'Kept a running log of supply requests for the clinic.' },
    ],
    census: {
      faithful: 'Coordinated care for 24 patients per shift.',
      inflated: 'Coordinated care for 42 patients per shift.',
      added: 'Coordinated care for 42 patients on the weekend float team.',
    },
    outsider: 'Marlowe Pharmacy Cooperative',
    bystanders: [
      { kind: 'published example', org: 'Larkspur Regional Medical Center', text: 'Modeled the discharge handoff checklist on practices published by Larkspur Regional Medical Center.' },
      { kind: 'mentor history', org: 'Dunmore Pediatric Associates', text: 'Learned triage basics from a mentor formerly employed by Dunmore Pediatric Associates.' },
    ],
    unrelatedLead: 'the quarterly supply-closet audit',
    extraRole: { key: 'ext', title: 'Per Diem Nurse', employer: 'Rosewater Home Care Agency', dates: 'January 2013 to May 2014', bullet: { key: 'visits', text: 'Made home visits for post-surgical patients.' } },
    foreignEmployer: 'Northgate Medical Group',
    inflatedTitle: 'Director of Nursing',
    teamNear: 'Worked with a team of twelve nurses to document patient fall incidents.',
    markers: {
      led: ["the unit's bedside shift-handoff huddles", 'the night shift'],
      owned: ["the unit's discharge-checklist process", 'patients leaving on weekends'],
      managed: ["the unit's overnight float-staffing roster", 'the winter holiday period'],
      architected: ['a medication-reconciliation worksheet', 'the cardiac step-down unit'],
    },
  },
  {
    id: 'pastry-chef',
    name: 'Odalys Fontaine-Reyes', contact: 'odalys.fontaine@example.test',
    current: { title: 'Pastry Chef', employer: 'Maison Orrery Patisserie', dates: 'April 2020 to Present' },
    prior: { title: 'Commis Pastry Cook', employer: 'Birchwater Grand Hotel', dates: 'September 2015 to March 2020' },
    currentBullets: [
      { key: 'team', text: 'Worked with a team of five bakers to prepare laminated doughs before service.' },
      { key: 'census', text: 'Served 300 customers per weekend at the dessert counter.' },
      { key: 'outsider', text: 'Tasted butter samples from Fennimore Dairy Supply for the seasonal menu.' },
    ],
    priorBullets: [
      { key: 'banquet', text: 'Took part in banquet dessert service for hotel events.' },
      { key: 'prior-plating', text: 'Plated desserts for the hotel restaurant.' },
    ],
    census: {
      faithful: 'Served 300 customers per weekend at the dessert counter.',
      inflated: 'Served 450 customers per weekend at the dessert counter.',
      added: 'Served 450 customers per weekend during the holiday season.',
    },
    outsider: 'Fennimore Dairy Supply',
    bystanders: [
      { kind: 'published example', org: 'Verdigris Culinary Institute', text: 'Followed the plating standards published by Verdigris Culinary Institute for the dessert menu.' },
      { kind: 'mentor history', org: 'Tamarack Bistro Collective', text: 'Learned lamination technique from a mentor formerly employed by Tamarack Bistro Collective.' },
    ],
    unrelatedLead: 'the quarterly walk-in freezer inventory',
    extraRole: { key: 'ext', title: 'Pastry Intern', employer: 'Saltmarsh Culinary Kitchen', dates: 'January 2015 to August 2015', bullet: { key: 'prep', text: 'Prepared mise en place for pastry classes.' } },
    foreignEmployer: 'Harrowgate Resort Kitchens',
    inflatedTitle: 'Executive Pastry Chef',
    teamNear: 'Worked with a team of fifteen bakers to prepare laminated doughs before service.',
    markers: {
      led: ['the weekend viennoiserie production schedule', 'the holiday rush'],
      owned: ["the pastry station's allergen labeling process", 'the dessert counter'],
      managed: ["the pastry station's dry-goods ordering", 'the winter holiday season'],
      architected: ['a laminated-dough production schedule', 'the weekend bakery team'],
    },
  },
  {
    id: 'structural-engineer',
    name: 'Ingrid Halloran-Voss', contact: 'ingrid.halloran@example.test',
    current: { title: 'Structural Engineer', employer: 'Halvorsen-Tarn Structural Group', dates: 'August 2018 to Present' },
    prior: { title: 'Junior Structural Designer', employer: 'Kestrel Civil Partners', dates: 'July 2013 to July 2018' },
    currentBullets: [
      { key: 'team', text: 'Worked with a team of four designers on steel connection details for a mid-rise office tower.' },
      { key: 'census', text: 'Coordinated drawing reviews with 15 clients per quarter.' },
      { key: 'outsider', text: 'Consulted for Brightmoor Dairy Cooperative on a cold-storage slab design.' },
    ],
    priorBullets: [
      { key: 'loads', text: 'Took part in load calculations for pedestrian bridge retrofits.' },
      { key: 'prior-drawings', text: 'Prepared drawing sets for plan checking.' },
    ],
    census: {
      faithful: 'Coordinated drawing reviews with 15 clients per quarter.',
      inflated: 'Coordinated drawing reviews with 51 clients per quarter.',
      added: 'Coordinated drawing reviews with 51 clients during the tower campus program.',
    },
    outsider: 'Brightmoor Dairy Cooperative',
    bystanders: [
      { kind: 'published example', org: 'Wexcombe Bridge Authority', text: 'Followed the detailing guides published by Wexcombe Bridge Authority for connection design.' },
      { kind: 'mentor history', org: 'Orsini Geotechnical Partners', text: 'Learned foundation sizing from a mentor formerly employed by Orsini Geotechnical Partners.' },
    ],
    unrelatedLead: 'the annual calculation archive cleanup',
    extraRole: { key: 'ext', title: 'Structural Technician', employer: 'Fernhollow Surveying', dates: 'June 2011 to June 2013', bullet: { key: 'survey', text: 'Recorded field measurements for building condition surveys.' } },
    foreignEmployer: 'Ironbridge Consulting Engineers',
    inflatedTitle: 'Principal Structural Engineer',
    teamNear: 'Worked with a team of fourteen designers on steel connection details for a mid-rise office tower.',
    markers: {
      led: ['the connection-detail peer review sessions', 'the tower design team'],
      owned: ['the shop-drawing review log', 'the office tower project'],
      managed: ['the drawing issue register', 'the tower construction phase'],
      architected: ['a beam-sizing spreadsheet', 'the steel framing group'],
    },
  },
  {
    id: 'warehouse-supervisor',
    name: 'Deshawn Okafor-Lindqvist', contact: 'deshawn.okafor@example.test',
    current: { title: 'Shift Supervisor', employer: 'Pelham Crossdock Logistics', dates: 'February 2021 to Present' },
    prior: { title: 'Forklift Operator', employer: 'Ardent Cold Storage', dates: 'May 2016 to January 2021' },
    currentBullets: [
      { key: 'team', text: 'Worked with a team of eight pickers to process outbound pallets.' },
      { key: 'census', text: 'Scheduled 12 employees per shift.' },
      { key: 'outsider', text: 'Evaluated demonstration units from Voltaic Forklift Rentals.' },
    ],
    priorBullets: [
      { key: 'counts', text: 'Took part in nightly cycle counts of frozen inventory.' },
      { key: 'prior-floor', text: 'Operated sit-down forklifts on the cold-storage floor.' },
    ],
    census: {
      faithful: 'Scheduled 12 employees per shift.',
      inflated: 'Scheduled 21 employees per shift.',
      added: 'Scheduled 21 employees per shift during the peak season.',
    },
    outsider: 'Voltaic Forklift Rentals',
    bystanders: [
      { kind: 'published example', org: 'Ambergate Supply Chain Institute', text: 'Followed the slotting guidelines published by Ambergate Supply Chain Institute for aisle layout.' },
      { kind: 'mentor history', org: 'Tidewell Freight Brokers', text: 'Learned carrier scheduling from a mentor formerly employed by Tidewell Freight Brokers.' },
    ],
    unrelatedLead: 'the quarterly damaged-goods audit',
    extraRole: { key: 'ext', title: 'Dock Associate', employer: 'Greywether Freight Terminal', dates: 'March 2014 to April 2016', bullet: { key: 'dock', text: 'Loaded and unloaded trailers at the dock.' } },
    foreignEmployer: 'Stonebridge Distribution Partners',
    inflatedTitle: 'Operations Director',
    teamNear: 'Worked with a team of eighteen pickers to process outbound pallets.',
    markers: {
      led: ['the dock-door scheduling meetings', 'the peak season'],
      owned: ['the returns-processing procedure', 'the east dock'],
      managed: ['the inbound trailer appointment calendar', 'the holiday peak'],
      architected: ['a slotting map for the pick aisles', 'the east warehouse'],
    },
  },
]);

// Four unrelated invented postings. Their leadership language and headcounts
// are listing requirements, never candidate experience.
const LISTINGS = Object.freeze([
  { id: 'nurse-manager', quote: 'Nurse Manager at Cedarbrook Health: lead a team of 14 staff on a medical-surgical floor and own the unit staffing budget.', count: 14, noun: 'staff' },
  { id: 'executive-pastry', quote: 'Executive Pastry Chef at Lanternfish Hotel: manage 22 employees across pastry, bakery and banquets and own food-cost targets.', count: 22, noun: 'employees' },
  { id: 'principal-engineer', quote: 'Principal Engineer at Tallow and Crane Consulting: lead the structural group and a portfolio serving 40 clients.', count: 40, noun: 'clients' },
  { id: 'operations-manager', quote: 'Operations Manager at Brickworks Fulfillment: manage 60 employees across three shifts and own the safety program.', count: 60, noun: 'employees' },
]);

// ---------------------------------------------------------------------------
// Source rendering and the offline transcribing compiler
// ---------------------------------------------------------------------------

const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

const bulletsOf = (person, which) => person[which].map(bullet => ({ ...bullet }));

function baseSpec(person) {
  return {
    name: person.name,
    contact: person.contact,
    roles: [
      {
        key: 'cur', ...person.current,
        bullets: [
          ...bulletsOf(person, 'currentBullets'),
          ...MARKERS.map(marker => ({ key: `team-${marker.id}`, text: `${marker.teamPrefix} ${person.markers[marker.id][0]}.` })),
        ],
      },
      { key: 'pri', ...person.prior, bullets: bulletsOf(person, 'priorBullets') },
    ],
  };
}

const withRoleBullet = (spec, roleKey, bullet) => {
  const next = structuredClone(spec);
  next.roles.find(role => role.key === roleKey).bullets.push({ ...bullet });
  return next;
};
const withoutBullet = (spec, bulletKey) => {
  const next = structuredClone(spec);
  for (const role of next.roles) role.bullets = role.bullets.filter(bullet => bullet.key !== bulletKey);
  return next;
};
const withRole = (spec, role) => {
  const next = structuredClone(spec);
  next.roles.push({ key: role.key, title: role.title, employer: role.employer, dates: role.dates, bullets: [{ ...role.bullet }] });
  return next;
};
const withoutRole = (spec, roleKey) => {
  const next = structuredClone(spec);
  next.roles = next.roles.filter(role => role.key !== roleKey);
  return next;
};
const withRoleField = (spec, roleKey, field, value) => {
  const next = structuredClone(spec);
  next.roles.find(role => role.key === roleKey)[field] = value;
  return next;
};
const withMovedBullet = (spec, bulletKey, toRoleKey) => {
  const next = structuredClone(spec);
  let moved = null;
  for (const role of next.roles) {
    const found = role.bullets.find(bullet => bullet.key === bulletKey);
    if (found) { moved = found; role.bullets = role.bullets.filter(bullet => bullet !== found); }
  }
  next.roles.find(role => role.key === toRoleKey).bullets.push(moved);
  return next;
};

// Rewrites a source line IN PLACE, so every segment id of the rendered file is
// unchanged and one profile object can be judged against both source versions.
const withBulletText = (spec, bulletKey, text) => {
  const next = structuredClone(spec);
  let found = false;
  for (const role of next.roles) for (const bullet of role.bullets) if (bullet.key === bulletKey) { bullet.text = text; found = true; }
  if (!found) throw new Error(`fixture bug: no bullet ${bulletKey}`);
  return next;
};
// Source lines that merely MENTION an organization (a published example, a
// mentor's former workplace). The candidate never worked there.
const withBystanders = (spec, person) => person.bystanders.reduce((acc, bystander, index) => withRoleBullet(acc, 'cur', { key: `bystander-${index}`, text: bystander.text }), spec);
const outsiderOrgs = person => [person.outsider, ...person.bystanders.map(bystander => bystander.org)];

function renderSource(spec) {
  const lines = [spec.name, spec.contact, ''];
  for (const role of spec.roles) {
    lines.push(`${role.title}, ${role.employer}`, role.dates, ...role.bullets.map(bullet => `- ${bullet.text}`), '');
  }
  return lines.join('\n');
}

function cleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  const deterministicFailureDigest = digest(canonicalJson([]));
  const audits = [
    ['coverage', 'career-profile-audit-completeness'], ['grounding', 'career-profile-audit-grounding'],
    ['attribution', 'career-profile-audit-attribution'], ['metrics', 'career-profile-audit-metrics'],
    ['skills', 'career-profile-audit-skills'], ['conflict', 'career-profile-audit-conflicts'],
  ].map(([category, task]) => {
    let chainDigest = digest(canonicalJson({ category, task, seed: 'career-page-audit-v1' }));
    const pageAudits = pages.map(page => {
      const findingDigest = digest(canonicalJson([]));
      chainDigest = digest(canonicalJson({ prior: chainDigest, pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest }));
      return { pageId: page.id, pageIndex: page.index, findingCount: 0, findingDigest, chainDigest };
    });
    const receipt = pageAudits.map(({ pageId, pageIndex, findingCount, findingDigest, chainDigest: chain }) => ({ pageId, pageIndex, findingCount, findingDigest, chainDigest: chain }));
    return { category, task, findingCount: 0, findingDigest: digest(canonicalJson(receipt)), findings: [], pageAudits };
  });
  const profileDigest = canonicalCareerProfileDigest(profile);
  const unresolvedFindingDigest = digest(canonicalJson({
    deterministicFailureDigest,
    audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })),
  }));
  return [{
    round: 0, profileDigest, unresolvedFindingDigest,
    stateDigest: digest(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

const roleIdOf = key => `role-${key}`;
const achievementIdOf = key => `ach-${digest(`achievement:${key}`).slice(0, 10)}`;

// Transcribes a rendered fixture into profile entities that cite the literal
// source lines they came from. Every judgement about the result is production's.
function compileSpec(spec, { achievementId = achievementIdOf } = {}) {
  const text = renderSource(spec);
  const corpus = buildCareerSourceCorpus([{
    name: 'Career File.md', text, legacyText: text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
  }]);
  const segmentsContaining = needle => {
    const hits = corpus.segments.filter(segment => segment.text.includes(needle)).map(segment => segment.id);
    if (!hits.length) throw new Error(`fixture bug: no source segment contains ${JSON.stringify(needle)}`);
    return hits;
  };
  const coverage = new Map();
  const cover = (segmentIds, disposition, entityIds) => {
    for (const segmentId of segmentIds) {
      const entry = coverage.get(segmentId) || { segmentId, disposition, entityIds: new Set() };
      entityIds.forEach(id => entry.entityIds.add(id));
      coverage.set(segmentId, entry);
    }
  };
  const identitySegments = [...new Set([...segmentsContaining(spec.name), ...segmentsContaining(spec.contact)])];
  cover(identitySegments, 'identity', ['identity']);
  const roles = [];
  const achievements = [];
  for (const role of spec.roles) {
    const roleId = roleIdOf(role.key);
    const headerSegments = [...new Set([...segmentsContaining(`${role.title}, ${role.employer}`), ...segmentsContaining(role.dates)])];
    const achievementIds = [];
    for (const bullet of role.bullets) {
      const id = achievementId(bullet.key);
      const evidenceSegmentIds = segmentsContaining(bullet.text);
      achievements.push({ id, roleId, claim: bullet.text, technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds });
      achievementIds.push(id);
      cover(evidenceSegmentIds, 'achievement', [id]);
    }
    const [startDate, endDate = ''] = role.dates.split(' to ');
    roles.push({ id: roleId, title: role.title, employer: role.employer, startDate, endDate, location: '', achievementIds, skillIds: [], evidenceSegmentIds: headerSegments });
    cover(headerSegments, 'role-header', [roleId]);
  }
  for (const segment of corpus.segments) if (!coverage.has(segment.id)) cover([segment.id], 'context', []);
  const profile = {
    identity: { name: spec.name, contacts: [spec.contact], evidenceSegmentIds: identitySegments },
    roles, achievements, projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    segmentCoverage: [...coverage.values()].map(entry => ({ ...entry, entityIds: [...entry.entityIds] })),
  };
  const pages = partitionCareerSourcePages(corpus);
  const snapshot = {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: CAREER_SNAPSHOT_STATUS_APPROVED,
    snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint,
    compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: digest(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z',
    sources: corpus.sources, segments: corpus.segments, profile, auditHistory: cleanAuditHistory(corpus, profile),
  };
  return { spec, text, corpus, profile, snapshot, achievementId };
}

/**
 * Compile, then require production to approve the fixture as a current
 * snapshot. Deliberately uncached: A, B and C are three independent
 * recompilations, so equal content addresses are production's doing.
 */
function build(spec, options = {}) {
  const compiled = compileSpec(spec, options);
  const profileCheck = validateCareerProfile(compiled.profile, compiled.corpus);
  assert(profileCheck.valid, `fixture bug: transcribed profile must pass validateCareerProfile: ${profileCheck.errors.slice(0, 3).join(' | ')}`);
  const snapshotCheck = validateCurrentCareerSnapshot(compiled.snapshot);
  assert(snapshotCheck.valid, `fixture bug: transcribed snapshot must pass validateCurrentCareerSnapshot: ${snapshotCheck.errors.slice(0, 3).join(' | ')}`);
  const catalog = approvedCareerEvidenceCatalog(compiled.snapshot);
  const authority = buildApplicationCareerAuthority(compiled.snapshot);
  return { ...compiled, snapshotId: compiled.snapshot.snapshotId, catalog, authority };
}

const evidenceOf = (built, bulletKey, idOf = built.achievementId) => built.catalog.filter(item => item.id.startsWith(`host.career.achievement.${idOf(bulletKey)}.`));
const quotesOf = (built, ...bulletKeys) => bulletKeys.flatMap(key => evidenceOf(built, key).map(item => item.quote));
const evidenceIdsOf = (built, ...bulletKeys) => bulletKeys.flatMap(key => evidenceOf(built, key).map(item => item.id));
const hasEvidence = (built, bulletKey) => evidenceOf(built, bulletKey).length > 0;
const sourceRoleByKey = (built, roleKey) => built.authority.sourceRoles.find(role => role.id === roleIdOf(roleKey));

function verdict(fn) {
  try { return { ok: true, message: '', value: fn() }; }
  catch (error) { return { ok: false, message: String(error?.message || error), value: undefined }; }
}
const ownershipVerdict = (text, quotes, label = 'resumeBullets') => verdict(() => assertSourceQuoteLinksFinalText(text, quotes, label, 0, { identityTokens: [] }));
// A rejection counts only when production names the ownership word it refused,
// so an unrelated failure (e.g. missing term overlap) cannot pass for the gate.
const rejectedForWord = (result, word) => !result.ok && new RegExp(`unsupported[^“]*“${word}”`, 'iu').test(result.message);
const firstPerson = claim => `I ${claim.charAt(0).toLowerCase()}${claim.slice(1)}`;

function markerCase(person, marker) {
  const [subject, extra] = person.markers[marker.id];
  return {
    teamKey: `team-${marker.id}`,
    addedKey: `added-${marker.id}`,
    faithful: `${marker.teamPrefix} ${subject}.`,
    inflated: `${marker.claimVerb} ${subject}.`,
    addedText: `${marker.sourceVerb} ${subject} for ${extra}.`,
    supported: `${marker.claimVerb} ${subject} for ${extra}.`,
  };
}

function resumeFor(built, mutate = null) {
  const roles = built.authority.sourceRoles.map(role => {
    const specRole = built.spec.roles.find(candidate => roleIdOf(candidate.key) === role.id);
    const bullet = specRole.bullets[0];
    return {
      id: role.id, title: role.title, company: role.company, dates: role.dates, location: '',
      bullets: [{ id: `bullet-${role.id}`, text: bullet.text, evidenceIds: [evidenceOf(built, bullet.key)[0].id] }],
    };
  });
  const resume = { schemaVersion: 'structured-resume.v1', identity: { name: built.authority.identity.name, contact: [...built.authority.identity.contact] }, roles };
  if (mutate) mutate(resume);
  return resume;
}
const validateResume = (built, resume, extraCatalog = []) => verdict(() => validateStructuredApplicationResume(resume, {
  sourceRoles: built.authority.sourceRoles, evidenceCatalog: [...built.catalog, ...extraCatalog],
  trustedIdentity: built.authority.identity, careerData: built.text, authorityMode: true,
}));

const attributionErrors = (built, { text, evidenceIds, extraEvidence = [] }) => pasteAttributionScopeErrors({
  unitLabel: 'Bullet', unitId: 'unit-1', finalText: text, evidenceIds,
  acceptedEvidence: [...built.catalog, ...extraEvidence], sourceRoles: built.authority.sourceRoles, careerData: '', authority: built.authority,
});

const cloneProfile = profile => structuredClone(profile);

// ---------------------------------------------------------------------------
// Default export: invariants that currently hold
// ---------------------------------------------------------------------------

const markerTests = MARKERS.map(marker => ({
  name: `adaptability ownership: "${marker.claimVerb}" wording follows the cited source evidence across recompilation (A rejects, B admits, C revokes) for every profile`,
  run() {
    for (const person of PEOPLE) {
      const c = markerCase(person, marker);
      const specA = baseSpec(person);
      const specB = withRoleBullet(specA, 'cur', { key: c.addedKey, text: c.addedText });
      const specC = withoutBullet(specB, c.addedKey);
      const A = build(specA);
      const B = build(specB);
      const C = build(specC);
      const where = `${person.id}/${marker.id}`;

      // The team-language evidence in A supports the team-language claim ...
      assert(ownershipVerdict(c.faithful, quotesOf(A, c.teamKey)).ok,
        `${where}: a faithful team-language bullet must be accepted from its own evidence`);
      // ... but not the same work restated at a higher ownership level.
      const inflatedA = ownershipVerdict(c.inflated, quotesOf(A, c.teamKey));
      assert(rejectedForWord(inflatedA, marker.claimVerb), `${where}: "${c.inflated}" must be rejected on ${marker.claimVerb} when A only states team work (got: ${inflatedA.message || 'accepted'})`);
      // The evidence that would justify the claim does not exist yet, so the
      // writer's nearest honest citation is the team line, in either document form.
      assert(!hasEvidence(A, c.addedKey), `${where}: A must not contain the supporting evidence`);
      const supportedA = ownershipVerdict(c.supported, quotesOf(A, c.teamKey));
      assert(rejectedForWord(supportedA, marker.claimVerb), `${where}: the not-yet-sourced claim must be rejected in A (got: ${supportedA.message || 'accepted'})`);
      assert(rejectedForWord(ownershipVerdict(firstPerson(c.supported), quotesOf(A, c.teamKey), 'coverLetterParagraphs'), marker.claimVerb),
        `${where}: the cover-letter form of the claim must be rejected in A`);

      // B: the source gains a directly supporting line; recompilation is a new snapshot.
      assert(B.snapshotId !== A.snapshotId && B.authority.digests.catalog !== A.authority.digests.catalog && B.authority.digests.snapshot !== A.authority.digests.snapshot,
        `${where}: adding source evidence must produce a new snapshot id and catalog`);
      assert(hasEvidence(B, c.addedKey), `${where}: B's catalog must expose the newly sourced evidence`);
      const supportedB = ownershipVerdict(c.supported, quotesOf(B, c.addedKey));
      assert(supportedB.ok, `${where}: the supported claim must be accepted from B's new evidence (got: ${supportedB.message})`);
      assert(ownershipVerdict(firstPerson(c.supported), quotesOf(B, c.addedKey), 'coverLetterParagraphs').ok,
        `${where}: the supported cover-letter sentence must be accepted from B's new evidence`);
      // New evidence widens only what it supports: the old team line still cannot carry the claim ...
      const stillInflated = ownershipVerdict(c.inflated, quotesOf(B, c.teamKey));
      assert(rejectedForWord(stillInflated, marker.claimVerb), `${where}: unrelated pre-existing team evidence must still reject the claim in B`);
      // ... a writer who cites the old team line next to the new line is admitted by the new line ...
      assert(ownershipVerdict(c.supported, [...quotesOf(B, c.teamKey), ...quotesOf(B, c.addedKey)]).ok,
        `${where}: citing the team line beside the newly sourced line must be admitted by the new line`);
      // ... and the new line supports exactly the ownership level it states, not every other one.
      for (const other of MARKERS) {
        if (other.id === marker.id) continue;
        const crossed = ownershipVerdict(`${other.claimVerb} ${person.markers[marker.id][0]}.`, quotesOf(B, c.addedKey));
        assert(rejectedForWord(crossed, other.claimVerb), `${where}: B's ${marker.sourceVerb} line must not also support "${other.claimVerb}" (got: ${crossed.message || 'accepted'})`);
      }

      // C: removing the evidence restores the original approved state exactly.
      assert(C.snapshotId === A.snapshotId && C.authority.digests.catalog === A.authority.digests.catalog && C.authority.digests.snapshot === A.authority.digests.snapshot,
        `${where}: removing the evidence must restore the original content-addressed snapshot and catalog`);
      assert(!hasEvidence(C, c.addedKey), `${where}: C must no longer expose the removed evidence`);
      const revoked = ownershipVerdict(c.supported, quotesOf(C, c.teamKey));
      assert(rejectedForWord(revoked, marker.claimVerb), `${where}: the claim must be unavailable again in C (got: ${revoked.message || 'accepted'})`);
      assert(ownershipVerdict(c.faithful, quotesOf(C, c.teamKey)).ok, `${where}: the faithful claim must remain available in C`);
    }
  },
}));

export default [
  {
    name: 'adaptability ownership: every synthetic career compiles to an approvable snapshot whose trusted roles and catalog come only from its own source',
    run() {
      const employers = PEOPLE.flatMap(person => [person.current.employer, person.prior.employer, person.extraRole.employer, person.foreignEmployer, ...outsiderOrgs(person)]);
      assert(new Set(employers).size === employers.length && PEOPLE.length >= 3, 'fixture bug: the synthetic careers must be unrelated to each other');
      for (const person of PEOPLE) {
        const built = build(withBystanders(baseSpec(person), person));
        const own = [person.current.employer, person.prior.employer];
        assert(JSON.stringify(built.authority.sourceRoles.map(role => role.company)) === JSON.stringify(own),
          `${person.id}: trusted roles must be exactly the source's two employers`);
        assert(built.authority.sourceRoles.map(role => role.title).join('|') === [person.current.title, person.prior.title].join('|'), `${person.id}: trusted titles must be the source titles`);
        const catalogText = built.catalog.map(item => item.quote).join('\n');
        for (const other of PEOPLE) {
          if (other.id === person.id) continue;
          for (const name of [other.current.employer, other.prior.employer, other.extraRole.employer, other.current.title, other.name]) {
            assert(!catalogText.includes(name), `${person.id}: catalog must not contain another candidate's fact ${JSON.stringify(name)}`);
          }
        }
        assert(!built.authority.sourceRoles.some(role => role.company === person.outsider || role.company === person.foreignEmployer || role.company === person.extraRole.employer),
          `${person.id}: a vendor/client, an absent name, or a not-yet-sourced employer is not a trusted role`);
        assert(built.catalog.some(item => item.quote.includes(person.outsider)), `${person.id}: the vendor/client is evidence text but not a role`);
      }
    },
  },

  {
    name: 'adaptability ownership: the compile gate rejects a title, employer, date or ownership claim the source text does not state, for every profile',
    run() {
      for (const person of PEOPLE) {
        const A = build(withBystanders(baseSpec(person), person));
        const faithful = validateCareerProfile(A.profile, A.corpus);
        assert(faithful.valid, `${person.id}: the faithful transcription must be valid`);
        const roleOf = profile => profile.roles.find(role => role.id === roleIdOf('cur'));
        const mutations = [
          ['title inflated', 'roles[role-cur].title', profile => { roleOf(profile).title = person.inflatedTitle; }],
          ['title with a seniority prefix', 'roles[role-cur].title', profile => { roleOf(profile).title = `Senior ${person.current.title}`; }],
          ['title with a level suffix', 'roles[role-cur].title', profile => { roleOf(profile).title = `${person.current.title} II`; }],
          ['title borrowed from another role', 'roles[role-cur].title', profile => { roleOf(profile).title = person.prior.title; }],
          ['employer absent from source', 'roles[role-cur].employer', profile => { roleOf(profile).employer = person.foreignEmployer; }],
          ['employer borrowed from another role', 'roles[role-cur].employer', profile => { roleOf(profile).employer = person.prior.employer; }],
          ['employer with a corporate suffix', 'roles[role-cur].employer', profile => { roleOf(profile).employer = `${person.current.employer} Group`; }],
          ['employer with a prefix', 'roles[role-cur].employer', profile => { roleOf(profile).employer = `Global ${person.current.employer}`; }],
          // An organization the source only MENTIONS (vendor, client, published example, mentor history) is not the employer named in the header.
          ...outsiderOrgs(person).map(org => [`organization ${org} that the source only mentions, named as employer (header cited)`, 'roles[role-cur].employer', profile => { roleOf(profile).employer = org; }]),
          ['start date pushed earlier', 'roles[role-cur].startDate', profile => { roleOf(profile).startDate = roleOf(profile).startDate.replace(/\d{4}/u, year => String(Number(year) - 9)); }],
          ['end date invented', 'roles[role-pri].endDate', profile => { profile.roles.find(role => role.id === roleIdOf('pri')).endDate = 'Present'; }],
        ];
        for (const marker of MARKERS) {
          const c = markerCase(person, marker);
          mutations.push([`team claim rewritten as ${marker.claimVerb}`, `achievements[${A.achievementId(c.teamKey)}].claim`, profile => {
            profile.achievements.find(item => item.id === A.achievementId(c.teamKey)).claim = c.inflated;
          }]);
        }
        mutations.push(['headcount changed', `achievements[${A.achievementId('census')}].claim`, profile => {
          profile.achievements.find(item => item.id === A.achievementId('census')).claim = person.census.inflated;
        }]);
        for (const [name, label, mutate] of mutations) {
          const profile = cloneProfile(A.profile);
          mutate(profile);
          const result = validateCareerProfile(profile, A.corpus);
          assert(!result.valid && result.errors.some(error => error.includes(label) && error.includes('is not grounded')),
            `${person.id}: ${name} must be rejected at ${label} (got ${JSON.stringify(result.errors)})`);
          assert(result.errors.every(error => error.includes(label.split('.')[0])), `${person.id}: ${name} must not disturb unrelated entities (got ${JSON.stringify(result.errors)})`);
        }
      }
    },
  },

  {
    name: 'adaptability ownership: the SAME profile claim is rejected, admitted and rejected again by the compile gate as the source text changes (A/B/C), and a near miss stays rejected, for every profile',
    run() {
      for (const person of PEOPLE) {
        const specA = baseSpec(person);
        const A = build(specA);
        const roleOf = profile => profile.roles.find(role => role.id === roleIdOf('cur'));
        const earlierStart = delta => person.current.dates.replace(/\d{4}/u, year => String(Number(year) - delta));
        const achievementOf = (profile, key) => profile.achievements.find(item => item.id === A.achievementId(key));
        // `edit(spec, stated)` rewrites ONE source line in place, so segment ids never move and the identical profile object can be judged against every source version.
        const cases = [
          {
            name: 'promoted title', label: 'roles[role-cur].title',
            claim: profile => { roleOf(profile).title = person.inflatedTitle; },
            nearMiss: profile => { roleOf(profile).title = `${person.inflatedTitle} II`; },
            edit: (spec, stated) => withRoleField(spec, 'cur', 'title', stated ? person.inflatedTitle : person.current.title),
          },
          {
            name: 'different employer', label: 'roles[role-cur].employer',
            claim: profile => { roleOf(profile).employer = person.foreignEmployer; },
            nearMiss: profile => { roleOf(profile).employer = `${person.foreignEmployer} Group`; },
            edit: (spec, stated) => withRoleField(spec, 'cur', 'employer', stated ? person.foreignEmployer : person.current.employer),
          },
          {
            name: 'earlier start date', label: 'roles[role-cur].startDate',
            claim: profile => { roleOf(profile).startDate = earlierStart(9).split(' to ')[0]; },
            nearMiss: profile => { roleOf(profile).startDate = earlierStart(8).split(' to ')[0]; },
            edit: (spec, stated) => withRoleField(spec, 'cur', 'dates', stated ? earlierStart(9) : person.current.dates),
          },
          {
            name: 'different headcount', label: `achievements[${A.achievementId('census')}].claim`,
            claim: profile => { achievementOf(profile, 'census').claim = person.census.inflated; },
            nearMiss: profile => { achievementOf(profile, 'census').claim = person.census.inflated.replace(/\d+/u, number => String(Number(number) + 1)); },
            edit: (spec, stated) => withBulletText(spec, 'census', stated ? person.census.inflated : person.currentBullets.find(bullet => bullet.key === 'census').text),
          },
          ...MARKERS.map((marker, index) => {
            const c = markerCase(person, marker);
            const other = MARKERS[(index + 1) % MARKERS.length];
            return {
              name: `${marker.claimVerb} ownership of work the source calls team work`, label: `achievements[${A.achievementId(c.teamKey)}].claim`,
              claim: profile => { achievementOf(profile, c.teamKey).claim = c.inflated; },
              nearMiss: profile => { achievementOf(profile, c.teamKey).claim = `${other.claimVerb} ${person.markers[marker.id][0]}.`; },
              edit: (spec, stated) => withBulletText(spec, c.teamKey, stated ? c.inflated : c.faithful),
            };
          }),
        ];
        for (const c of cases) {
          const where = `${person.id} / ${c.name}`;
          const claimProfile = cloneProfile(A.profile);
          c.claim(claimProfile);
          const inA = validateCareerProfile(claimProfile, A.corpus);
          assert(!inA.valid && inA.errors.some(error => error.includes(c.label) && error.includes('is not grounded')), `${where}: A must reject the claim at ${c.label} (got ${JSON.stringify(inA.errors)})`);

          const statedSpec = c.edit(specA, true);
          const B = build(statedSpec);
          assert(B.corpus.segments.map(segment => segment.id).join() === A.corpus.segments.map(segment => segment.id).join(), `${where}: fixture bug: an in-place edit must not move segments`);
          assert(B.snapshotId !== A.snapshotId && B.corpus.inputFingerprint !== A.corpus.inputFingerprint, `${where}: stating the fact in the source must be a new snapshot`);
          const inB = validateCareerProfile(claimProfile, B.corpus);
          assert(inB.valid, `${where}: the very same claim must be admitted once the source states it (got ${JSON.stringify(inB.errors)})`);

          const nearProfile = cloneProfile(claimProfile);
          c.nearMiss(nearProfile);
          const nearB = validateCareerProfile(nearProfile, B.corpus);
          assert(!nearB.valid && nearB.errors.some(error => error.includes(c.label) && error.includes('is not grounded')), `${where}: a near miss of the now-sourced claim must still be rejected in B (got ${JSON.stringify(nearB.errors)})`);

          const C = build(c.edit(statedSpec, false));
          assert(C.snapshotId === A.snapshotId && C.corpus.inputFingerprint === A.corpus.inputFingerprint, `${where}: reverting the line must restore the original content address`);
          const inC = validateCareerProfile(claimProfile, C.corpus);
          assert(!inC.valid && inC.errors.some(error => error.includes(c.label) && error.includes('is not grounded')), `${where}: the claim must be rejected again after the evidence is removed (got ${JSON.stringify(inC.errors)})`);
        }
      }
    },
  },

  {
    name: 'adaptability ownership: the compile gate rejects evidence attached to an inconsistent or non-existent role, and a role at an employer the source never states, for every profile',
    run() {
      for (const person of PEOPLE) {
        const A = build(baseSpec(person));
        const achievementId = A.achievementId(person.priorBullets[0].key);
        const rolesOf = profile => ({ current: profile.roles.find(role => role.id === roleIdOf('cur')), prior: profile.roles.find(role => role.id === roleIdOf('pri')) });
        const errorsOf = mutate => {
          const profile = cloneProfile(A.profile);
          mutate(profile, rolesOf(profile));
          return validateCareerProfile(profile, A.corpus);
        };
        // The employer's evidence re-pointed at the current role from one side only.
        const achievementOnly = errorsOf(profile => { profile.achievements.find(item => item.id === achievementId).roleId = roleIdOf('cur'); });
        assert(!achievementOnly.valid && achievementOnly.errors.some(error => error.includes(`achievements[${achievementId}] is not linked from role ${roleIdOf('cur')}.achievementIds`)),
          `${person.id}: an achievement claiming a role that does not list it must be rejected (got ${JSON.stringify(achievementOnly.errors)})`);
        const roleOnly = errorsOf((profile, roles) => { roles.current.achievementIds.push(achievementId); });
        assert(!roleOnly.valid && roleOnly.errors.some(error => error.includes(`roles[${roleIdOf('cur')}].achievementIds links achievement ${achievementId} whose roleId is not ${roleIdOf('cur')}`)),
          `${person.id}: a role listing an achievement that names another role must be rejected (got ${JSON.stringify(roleOnly.errors)})`);
        const ghostRoleId = errorsOf(profile => { profile.achievements.find(item => item.id === achievementId).roleId = 'role-not-in-the-profile'; });
        assert(!ghostRoleId.valid && ghostRoleId.errors.some(error => error.includes(`achievements[${achievementId}].roleId does not identify a role`)),
          `${person.id}: an achievement attached to a role the profile does not contain must be rejected (got ${JSON.stringify(ghostRoleId.errors)})`);
        // A whole extra role whose employer the source never states: it can borrow header lines, but not the employer name.
        const ghostRole = errorsOf((profile, roles) => {
          profile.roles.push({ ...cloneProfile(roles.current), id: 'role-not-in-the-source', employer: person.foreignEmployer, achievementIds: [], skillIds: [] });
          for (const entry of profile.segmentCoverage) if (roles.current.evidenceSegmentIds.includes(entry.segmentId)) entry.entityIds.push('role-not-in-the-source');
        });
        assert(!ghostRole.valid && ghostRole.errors.some(error => error.includes('roles[role-not-in-the-source].employer is not grounded')) && ghostRole.errors.every(error => error.includes('role-not-in-the-source')),
          `${person.id}: a role at an employer absent from the source must be rejected on its employer alone (got ${JSON.stringify(ghostRole.errors)})`);
      }
    },
  },

  ...markerTests,

  {
    name: 'adaptability ownership: a résumé cannot inflate a role title, employer or dates, or add a tagline title; a genuine promotion or employer change in the source moves the permission (A/B/C)',
    run() {
      for (const person of PEOPLE) {
        const A = build(baseSpec(person));
        assert(validateResume(A, resumeFor(A)).ok, `${person.id}: the faithful résumé must validate`);
        const exactMatch = field => new RegExp(`roles\\[0\\]\\.${field} must exactly match its trusted source role`, 'u');
        const tagline = resume => { resume.identity.subtitleRole = person.inflatedTitle; };
        const credential = resume => { resume.identity.credential = person.inflatedTitle; };
        const setRoleField = (field, value) => resume => { resume.roles[0][field] = value; };
        const dates = resume => { resume.roles[0].dates = resume.roles[0].dates.replace(/\d{4}/u, year => String(Number(year) - 9)); };
        // Each mutation changes exactly one rendered field of the current role, and production must name that field.
        const rejectedInA = [
          ['inflated title', 'title', setRoleField('title', person.inflatedTitle)],
          ['seniority-prefixed title', 'title', setRoleField('title', `Senior ${person.current.title}`)],
          ['title borrowed from another role', 'title', setRoleField('title', person.prior.title)],
          ['employer absent from the source', 'company', setRoleField('company', person.foreignEmployer)],
          ['employer with a corporate suffix', 'company', setRoleField('company', `${person.current.employer} Group`)],
          ['employer borrowed from another role', 'company', setRoleField('company', person.prior.employer)],
          ['earlier start date', 'dates', dates],
        ];
        for (const [name, field, mutate] of rejectedInA) {
          const result = validateResume(A, resumeFor(A, mutate));
          assert(!result.ok && exactMatch(field).test(result.message), `${person.id}: A must reject a résumé with an ${name} on roles[0].${field} (got: ${result.message || 'accepted'})`);
        }
        const summary = validateResume(A, resumeFor(A, resume => { resume.roles[0].summary = `${person.inflatedTitle} for ${person.current.employer}`; }));
        assert(!summary.ok && /roles\[0\]\.summary is unsupported/u.test(summary.message), `${person.id}: A must reject a free-text role summary that could carry an unsourced title (got: ${summary.message || 'accepted'})`);
        for (const [name, mutate, field] of [['tagline', tagline, 'subtitleRole'], ['credential line', credential, 'credential']]) {
          const result = validateResume(A, resumeFor(A, mutate));
          assert(!result.ok && new RegExp(`identity\\.${field} must be omitted`, 'u').test(result.message), `${person.id}: A must reject an invented ${name} (got: ${result.message || 'accepted'})`);
        }

        // The same résumé flips with the source: the source later states a higher title, or a different employer.
        for (const [field, key, original, changed] of [
          ['title', 'title', person.current.title, person.inflatedTitle],
          ['employer', 'company', person.current.employer, person.foreignEmployer],
        ]) {
          const B = build(withRoleField(baseSpec(person), 'cur', field, changed));
          const C = build(withRoleField(withRoleField(baseSpec(person), 'cur', field, changed), 'cur', field, original));
          const trustedKey = key === 'company' ? 'company' : 'title';
          assert(B.snapshotId !== A.snapshotId && B.authority.digests.snapshot !== A.authority.digests.snapshot && sourceRoleByKey(B, 'cur')[trustedKey] === changed,
            `${person.id}: B's trusted role must carry the sourced ${field}`);
          assert(validateResume(B, resumeFor(B)).ok, `${person.id}: B must accept its sourced ${field}`);
          // The resume that was faithful to A is now the stale one.
          const superseded = validateResume(B, resumeFor(B, setRoleField(key, original)));
          assert(!superseded.ok && exactMatch(key).test(superseded.message), `${person.id}: B must reject the superseded ${field} (got: ${superseded.message || 'accepted'})`);
          // Sourcing one field authorizes that field only.
          const otherKey = key === 'title' ? 'company' : 'title';
          const otherValue = otherKey === 'title' ? person.inflatedTitle : person.foreignEmployer;
          const crossed = validateResume(B, resumeFor(B, setRoleField(otherKey, otherValue)));
          assert(!crossed.ok && exactMatch(otherKey).test(crossed.message), `${person.id}: B sourced the ${field} only, so it must still reject an unsourced ${otherKey} (got: ${crossed.message || 'accepted'})`);
          const taglineB = validateResume(B, resumeFor(B, tagline));
          assert(!taglineB.ok && /identity\.subtitleRole must be omitted/u.test(taglineB.message), `${person.id}: B still has no tagline authority (got: ${taglineB.message || 'accepted'})`);
          // C: the evidence is removed; the sourced value is unavailable again.
          assert(C.snapshotId === A.snapshotId && C.authority.digests.snapshot === A.authority.digests.snapshot, `${person.id}: C must be the original content address`);
          const changedC = validateResume(C, resumeFor(C, setRoleField(key, changed)));
          assert(!changedC.ok && exactMatch(key).test(changedC.message) && validateResume(C, resumeFor(C)).ok,
            `${person.id}: C must reject the previously sourced ${field} again and accept the original (got: ${changedC.message || 'accepted'})`);
        }
      }
    },
  },

  {
    name: 'adaptability ownership: a résumé role at an employer the source never mentions is rejected; sourcing the employer admits it and removing it rejects again (A/B/C)',
    run() {
      for (const person of PEOPLE) {
        const A = build(baseSpec(person));
        const B = build(withRole(baseSpec(person), person.extraRole));
        const C = build(withoutRole(withRole(baseSpec(person), person.extraRole), person.extraRole.key));
        const extraRoleId = roleIdOf(person.extraRole.key);
        const unsourcedRole = {
          id: extraRoleId, title: person.extraRole.title, company: person.extraRole.employer, dates: person.extraRole.dates.replace(' to ', ' – '), location: '',
          bullets: [{ id: 'bullet-extra', text: person.extraRole.bullet.text, evidenceIds: [A.catalog[0].id] }],
        };
        const appendUnsourcedRole = resume => { resume.roles.push(structuredClone(unsourcedRole)); };
        const replaceWithUnsourcedRole = resume => { resume.roles[1] = structuredClone(unsourcedRole); };
        // A: the employer is nowhere in the approved JSON.
        assert(!A.authority.sourceRoles.some(role => role.company === person.extraRole.employer) && !A.text.includes(person.extraRole.employer),
          `${person.id}: A must not contain the not-yet-sourced employer`);
        const inventedA = validateResume(A, resumeFor(A, appendUnsourcedRole));
        assert(!inventedA.ok && /roles must retain every trusted source role exactly once/u.test(inventedA.message), `${person.id}: A must reject an extra role at an unsourced employer (got: ${inventedA.message || 'accepted'})`);
        // Keeping the role count equal isolates the identity check from the count check.
        const replacedA = validateResume(A, resumeFor(A, replaceWithUnsourcedRole));
        assert(!replacedA.ok && /roles\[1\]\.id does not identify a trusted source role/u.test(replacedA.message), `${person.id}: A must reject a role that is not one of the trusted roles (got: ${replacedA.message || 'accepted'})`);
        const swapped = validateResume(A, resumeFor(A, resume => { resume.roles[1].company = person.extraRole.employer; }));
        assert(!swapped.ok && /roles\[1\]\.company must exactly match/u.test(swapped.message), `${person.id}: A must reject swapping a real role's employer for an unsourced one`);
        const foreign = validateResume(A, resumeFor(A, resume => { resume.roles[1].company = person.foreignEmployer; }));
        assert(!foreign.ok && /roles\[1\]\.company must exactly match/u.test(foreign.message), `${person.id}: A must reject an employer that is absent from the whole source (got: ${foreign.message || 'accepted'})`);

        // B: the source gains a role at that employer (new snapshot, new trusted roles).
        assert(B.snapshotId !== A.snapshotId && B.authority.counts.roles === A.authority.counts.roles + 1, `${person.id}: B must add exactly one trusted role`);
        assert(sourceRoleByKey(B, person.extraRole.key)?.company === person.extraRole.employer, `${person.id}: B's authority must derive the new employer from the source`);
        const resumeB = resumeFor(B);
        assert(resumeB.roles.length === 3 && validateResume(B, resumeB).ok, `${person.id}: B must accept a résumé that includes its newly sourced role`);
        // The permission is per role: B does not make the new name valid on a different role.
        const crossed = validateResume(B, resumeFor(B, resume => { resume.roles[1].company = person.extraRole.employer; }));
        assert(!crossed.ok && /roles\[1\]\.company must exactly match/u.test(crossed.message), `${person.id}: B must still reject the new employer on a role that is not theirs`);
        // The A-shaped résumé (which omits the new role) is no longer complete either.
        const droppedB = validateResume(B, resumeFor(A));
        assert(!droppedB.ok && /every trusted source role/u.test(droppedB.message), `${person.id}: B must reject a résumé that drops a trusted role (got: ${droppedB.message || 'accepted'})`);

        // C: evidence removed; same content address as A and the unsourced role is rejected again.
        assert(C.snapshotId === A.snapshotId && C.authority.counts.roles === A.authority.counts.roles, `${person.id}: C must match A`);
        const inventedC = validateResume(C, resumeFor(C, appendUnsourcedRole));
        assert(!inventedC.ok && /roles must retain every trusted source role exactly once/u.test(inventedC.message), `${person.id}: C must reject the extra role again (got: ${inventedC.message || 'accepted'})`);
        const replacedC = validateResume(C, resumeFor(C, replaceWithUnsourcedRole));
        assert(!replacedC.ok && /roles\[1\]\.id does not identify a trusted source role/u.test(replacedC.message), `${person.id}: C must reject the replacement role again (got: ${replacedC.message || 'accepted'})`);
      }
    },
  },

  {
    name: 'adaptability ownership: an organization the source only mentions (client, vendor, published example, mentor history) is not an employer of the candidate until the source says so (A/B/C)',
    run() {
      for (const person of PEOPLE) {
        const specA = withBystanders(baseSpec(person), person);
        const A = build(specA);
        const orgs = outsiderOrgs(person);
        assert(orgs.length >= 3, 'fixture bug: each candidate needs several kinds of mention-only organizations');
        for (const org of orgs) {
          const where = `${person.id} / ${org}`;
          const orgRole = { key: 'cli', title: person.extraRole.title, employer: org, dates: person.extraRole.dates, bullet: person.extraRole.bullet };
          const B = build(withRole(specA, orgRole));
          const C = build(withoutRole(withRole(specA, orgRole), 'cli'));
          // A: the organization appears in an evidence line, but not as an employer anywhere.
          assert(A.text.includes(org) && !A.authority.sourceRoles.some(role => role.company === org), `${where}: A names the organization only inside an evidence line`);
          assert(A.catalog.some(item => item.quote.includes(org)), `${where}: the mention is citable evidence text, which is what must not make it an employer`);
          const asEmployer = validateResume(A, resumeFor(A, resume => { resume.roles[0].company = org; }));
          assert(!asEmployer.ok && /roles\[0\]\.company must exactly match its trusted source role/u.test(asEmployer.message), `${where}: A must reject the organization as the company of a real role (got: ${asEmployer.message || 'accepted'})`);
          const orgResumeRole = { id: roleIdOf('cli'), title: orgRole.title, company: org, dates: orgRole.dates.replace(' to ', ' – '), location: '', bullets: [{ id: 'bullet-cli', text: orgRole.bullet.text, evidenceIds: [A.catalog[0].id] }] };
          const asExtraRole = validateResume(A, resumeFor(A, resume => { resume.roles.push(structuredClone(orgResumeRole)); }));
          assert(!asExtraRole.ok && /roles must retain every trusted source role exactly once/u.test(asExtraRole.message), `${where}: A must reject an extra role at the organization (got: ${asExtraRole.message || 'accepted'})`);
          const asReplacement = validateResume(A, resumeFor(A, resume => { resume.roles[1] = structuredClone(orgResumeRole); }));
          assert(!asReplacement.ok && /roles\[1\]\.id does not identify a trusted source role/u.test(asReplacement.message), `${where}: A must reject a whole role at the organization (got: ${asReplacement.message || 'accepted'})`);
          // The compile gate agrees: citing only the header lines cannot make the mention an employer.
          const profile = cloneProfile(A.profile);
          profile.roles.find(role => role.id === roleIdOf('cur')).employer = org;
          const compiled = validateCareerProfile(profile, A.corpus);
          assert(!compiled.valid && compiled.errors.some(error => error.includes('roles[role-cur].employer is not grounded')), `${where}: the compile gate must reject the mention as an employer (got ${JSON.stringify(compiled.errors)})`);
          // B: the person genuinely worked for that organization later; the name is now an employer.
          assert(B.snapshotId !== A.snapshotId && sourceRoleByKey(B, 'cli')?.company === org, `${where}: B must derive the employer from the new role line`);
          assert(validateResume(B, resumeFor(B)).ok, `${where}: B must accept the sourced employment`);
          // C: removal returns to the original content address and rejection.
          assert(C.snapshotId === A.snapshotId && !C.authority.sourceRoles.some(role => role.company === org), `${where}: C must be the original again`);
          const asEmployerC = validateResume(C, resumeFor(C, resume => { resume.roles[0].company = org; }));
          assert(!asEmployerC.ok && /roles\[0\]\.company must exactly match its trusted source role/u.test(asEmployerC.message), `${where}: C must reject the organization as employer again (got: ${asEmployerC.message || 'accepted'})`);
        }
      }
    },
  },

  {
    name: "adaptability ownership: authority binds every achievement to the role the source placed it under, so moving a source line moves the permission (and the employer it may be attributed to)",
    run() {
      for (const person of PEOPLE) {
        const bulletKey = person.priorBullets[0].key;
        const bulletText = person.priorBullets[0].text;
        const A = build(baseSpec(person));
        const B = build(withMovedBullet(baseSpec(person), bulletKey, 'cur'));
        const forPrior = built => evidenceIdsOf(built, bulletKey);
        // A: the line sits under the prior employer.
        assert(verdict(() => validateAuthorityRoleEvidence(A.authority, roleIdOf('pri'), forPrior(A))).ok, `${person.id}: A attaches the line to the prior role`);
        const crossA = verdict(() => validateAuthorityRoleEvidence(A.authority, roleIdOf('cur'), forPrior(A)));
        assert(!crossA.ok && /does not belong to role/u.test(crossA.message), `${person.id}: A must refuse to attach the prior employer's work to the current role`);
        const priorText = `At ${person.prior.employer}, ${bulletText}`;
        const currentText = `At ${person.current.employer}, ${bulletText}`;
        assert(attributionErrors(A, { text: priorText, evidenceIds: forPrior(A) }).length === 0, `${person.id}: A permits naming the prior employer for its own work`);
        const wrongEmployerA = attributionErrors(A, { text: currentText, evidenceIds: forPrior(A) });
        assert(wrongEmployerA.length === 1 && wrongEmployerA[0].includes(person.current.employer), `${person.id}: A must reject naming the current employer for the prior role's work (got ${JSON.stringify(wrongEmployerA)})`);
        // B: the same sentence of source now sits under the current employer.
        assert(B.snapshotId !== A.snapshotId, `${person.id}: moving a source line is a new snapshot`);
        assert(verdict(() => validateAuthorityRoleEvidence(B.authority, roleIdOf('cur'), forPrior(B))).ok, `${person.id}: B attaches the line to the current role`);
        const crossB = verdict(() => validateAuthorityRoleEvidence(B.authority, roleIdOf('pri'), forPrior(B)));
        assert(!crossB.ok && /does not belong to role/u.test(crossB.message), `${person.id}: B must refuse the old placement`);
        assert(attributionErrors(B, { text: currentText, evidenceIds: forPrior(B) }).length === 0, `${person.id}: B permits naming the current employer`);
        const wrongEmployerB = attributionErrors(B, { text: priorText, evidenceIds: forPrior(B) });
        assert(wrongEmployerB.length === 1 && wrongEmployerB[0].includes(person.prior.employer), `${person.id}: B must reject naming the old employer for work now sourced elsewhere`);
      }
    },
  },

  {
    name: "adaptability ownership: the frozen-projection résumé gate scopes a bullet to its own employer's section, so moving a source line moves where it may be cited (A/B)",
    run() {
      for (const person of PEOPLE) {
        const bulletKey = person.priorBullets[0].key;
        const bulletText = person.priorBullets[0].text;
        const gate = (built, roleIndex) => {
          const careerData = projectApprovedCareerSnapshotForApplication(built.snapshot);
          const resume = resumeFor(built, draft => {
            draft.roles[roleIndex].bullets[0] = { id: 'bullet-under-test', text: bulletText, evidenceIds: evidenceIdsOf(built, bulletKey) };
          });
          return verdict(() => validateStructuredApplicationResume(resume, {
            sourceRoles: built.authority.sourceRoles, evidenceCatalog: built.catalog,
            trustedIdentity: built.authority.identity, careerData, authorityMode: false,
          }));
        };
        const A = build(baseSpec(person));
        const B = build(withMovedBullet(baseSpec(person), bulletKey, 'cur'));
        // The projection is derived from the approved profile, so the section a line sits in is the source's placement.
        assert(projectApprovedCareerSnapshotForApplication(A.snapshot).indexOf(bulletText) > projectApprovedCareerSnapshotForApplication(A.snapshot).indexOf(person.prior.employer),
          `${person.id}: A's projection must place the line in the prior employer's section`);
        assert(gate(A, 1).ok, `${person.id}: A must accept the line under its own employer`);
        const wrongA = gate(A, 0);
        assert(!wrongA.ok && /only from the trusted role's career-data section/u.test(wrongA.message), `${person.id}: A must reject citing the prior employer's line under the current role (got: ${wrongA.message || 'accepted'})`);
        assert(gate(B, 0).ok, `${person.id}: B must accept the line under the employer whose section now holds it`);
        const wrongB = gate(B, 1);
        assert(!wrongB.ok && /only from the trusted role's career-data section/u.test(wrongB.message), `${person.id}: B must reject the old placement (got: ${wrongB.message || 'accepted'})`);
      }
    },
  },

  {
    name: 'adaptability ownership: a headcount stated in final prose must be the headcount the cited evidence states; a newly sourced headcount admits it and removal revokes it (A/B/C)',
    run() {
      for (const person of PEOPLE) {
        const A = build(baseSpec(person));
        const B = build(withRoleBullet(baseSpec(person), 'cur', { key: 'census-added', text: person.census.added }));
        const C = build(withoutBullet(withRoleBullet(baseSpec(person), 'cur', { key: 'census-added', text: person.census.added }), 'census-added'));
        const faithfulA = attributionErrors(A, { text: person.census.faithful, evidenceIds: evidenceIdsOf(A, 'census') });
        assert(faithfulA.length === 0, `${person.id}: the sourced headcount must be accepted (got ${JSON.stringify(faithfulA)})`);
        const inflatedA = attributionErrors(A, { text: person.census.inflated, evidenceIds: evidenceIdsOf(A, 'census') });
        assert(inflatedA.length === 1 && /claims the user population/u.test(inflatedA[0]), `${person.id}: a changed headcount must be rejected in A (got ${JSON.stringify(inflatedA)})`);
        const unlocked = attributionErrors(B, { text: person.census.added, evidenceIds: evidenceIdsOf(B, 'census-added') });
        assert(unlocked.length === 0, `${person.id}: the newly sourced headcount must be accepted in B (got ${JSON.stringify(unlocked)})`);
        // The old line still states the old number.
        const staleCitation = attributionErrors(B, { text: person.census.inflated, evidenceIds: evidenceIdsOf(B, 'census') });
        assert(staleCitation.length === 1, `${person.id}: B must keep rejecting the new number against the old citation`);
        assert(C.snapshotId === A.snapshotId, `${person.id}: C must be the original content address`);
        const revoked = attributionErrors(C, { text: person.census.inflated, evidenceIds: evidenceIdsOf(C, 'census') });
        assert(revoked.length === 1 && /claims the user population/u.test(revoked[0]), `${person.id}: the headcount must be unavailable again in C`);
      }
    },
  },

  {
    name: 'adaptability ownership: listing leadership language and headcounts are never candidate evidence, for every candidate and listing',
    // pasteUnitGroundingErrors (not exported) reads its quotes through the same pasteUnitCareerQuotes call that
    // pasteAttributionScopeErrors uses, so the listing quote exclusion proven here is also the one applied to ownership wording.
    run() {
      for (const person of PEOPLE) {
        const A = build(baseSpec(person));
        for (const listing of LISTINGS) {
          const where = `${person.id} x ${listing.id}`;
          const listingEvidence = { id: `listing-${listing.id}`, sourceId: 'job-listing', quote: listing.quote };
          const claim = `Coordinated ${listing.count} ${listing.noun} across the department.`;
          // A bullet that cites only the posting has no candidate evidence at all.
          const listingOnly = validateResume(A, resumeFor(A, resume => {
            resume.roles[0].bullets[0] = { id: 'bullet-listing', text: claim, evidenceIds: [listingEvidence.id] };
          }), [listingEvidence]);
          assert(!listingOnly.ok && /career-data evidence ID/u.test(listingOnly.message), `${where}: a listing-only citation must be rejected for candidate content (got: ${listingOnly.message || 'accepted'})`);
          // Pairing posting evidence with candidate evidence does not let the posting's headcount through.
          const mixed = attributionErrors(A, { text: claim, evidenceIds: [...evidenceIdsOf(A, 'census'), listingEvidence.id], extraEvidence: [listingEvidence] });
          assert(mixed.length === 1 && mixed[0].includes(`${listing.count} ${listing.noun}`), `${where}: the posting's headcount must not be borrowed (got ${JSON.stringify(mixed)})`);
          // B: the candidate's source later states that headcount; it is now a supported claim.
          const B = build(withRoleBullet(baseSpec(person), 'cur', { key: 'listing-headcount', text: claim }));
          const supported = attributionErrors(B, { text: claim, evidenceIds: [...evidenceIdsOf(B, 'listing-headcount'), listingEvidence.id], extraEvidence: [listingEvidence] });
          assert(supported.length === 0, `${where}: a headcount the source states is supported (got ${JSON.stringify(supported)})`);
          // C: removed again.
          const C = build(withoutBullet(withRoleBullet(baseSpec(person), 'cur', { key: 'listing-headcount', text: claim }), 'listing-headcount'));
          const revoked = attributionErrors(C, { text: claim, evidenceIds: [...evidenceIdsOf(C, 'census'), listingEvidence.id], extraEvidence: [listingEvidence] });
          assert(C.snapshotId === A.snapshotId && revoked.length === 1, `${where}: removal must revoke the claim (got ${JSON.stringify(revoked)})`);
        }
      }
    },
  },

  {
    name: 'adaptability ownership: an employment year attributed to a named employer must be a year of that role in the current approved dates (A/B/C)',
    run() {
      for (const person of PEOPLE) {
        const lateYear = '2023';
        const priorWithLateEnd = person.prior.dates.replace(/\d{4}$/u, lateYear);
        const A = build(baseSpec(person));
        const B = build(withRoleField(baseSpec(person), 'pri', 'dates', priorWithLateEnd));
        const C = build(withRoleField(baseSpec(person), 'pri', 'dates', person.prior.dates));
        const text = `At ${person.prior.employer}, ${person.priorBullets[0].text.replace(/\.$/u, '')} in ${lateYear}.`;
        const cite = built => evidenceIdsOf(built, person.priorBullets[0].key);
        const endYear = person.prior.dates.match(/\d{4}$/u)[0];
        const endedText = `At ${person.prior.employer}, ${person.priorBullets[0].text.replace(/\.$/u, '')} in ${endYear}.`;
        assert(attributionErrors(A, { text: endedText, evidenceIds: cite(A) }).length === 0, `${person.id}: a stated year of the role must be accepted`);
        const lateA = attributionErrors(A, { text, evidenceIds: cite(A) });
        assert(lateA.length === 1 && lateA[0].includes(lateYear) && lateA[0].includes('employment date'), `${person.id}: A must reject a year outside the role dates (got ${JSON.stringify(lateA)})`);
        assert(B.snapshotId !== A.snapshotId && attributionErrors(B, { text, evidenceIds: cite(B) }).length === 0, `${person.id}: B (source dates extended) must accept the year`);
        assert(C.snapshotId === A.snapshotId && attributionErrors(C, { text, evidenceIds: cite(C) }).length === 1, `${person.id}: C must reject the year again`);
      }
    },
  },

  {
    name: 'adaptability ownership: every present-tense framing of an ended employer is rejected and the verdict follows the approved end date relative to the reference month (A/B/C)',
    run() {
      const reference = new Date(Date.UTC(2026, 9, 9));
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const monthOffset = delta => {
        const index = reference.getUTCMonth() + delta;
        return `${monthNames[((index % 12) + 12) % 12]} ${reference.getUTCFullYear() + Math.floor(index / 12)}`;
      };
      for (const person of PEOPLE) {
        const priorStart = person.prior.dates.split(' to ')[0];
        const priorWithEnd = end => withRoleField(baseSpec(person), 'pri', 'dates', `${priorStart} to ${end}`);
        const A = build(baseSpec(person));
        const B = build(priorWithEnd('Present'));
        const C = build(withRoleField(priorWithEnd('Present'), 'pri', 'dates', person.prior.dates));
        const endedBeforeReference = build(priorWithEnd(monthOffset(-1)));
        const endsAfterReference = build(priorWithEnd(monthOffset(1)));
        const rolesOf = built => built.authority.sourceRoles.map(role => ({ title: role.title, company: role.company, dates: role.dates }));
        const run = (built, paragraph) => checkEndedRoleCurrentEmployment([paragraph], { roles: rolesOf(built) }, reference);
        const { title, employer } = { title: person.prior.title, employer: person.prior.employer };
        const currentWork = [
          `As a ${title} at ${employer}, I support the weekend float roster.`,
          `I am currently a ${title} at ${employer}.`,
          `I am a ${title} with ${employer}.`,
          `My current role at ${employer} keeps me close to this work.`,
          `I currently work at ${employer}.`,
          `I am employed at ${employer}.`,
          `At ${employer}, I lead the weekend float roster.`,
        ];
        const pastWork = [
          `As a ${title} at ${employer}, I supported the weekend float roster.`,
          `I worked at ${employer}.`,
          `At ${employer}, I led the weekend float roster.`,
        ];
        for (const paragraph of currentWork) {
          const rejected = run(A, paragraph);
          assert(!rejected.passed && rejected.detail.includes(employer), `${person.id}: A must reject ${JSON.stringify(paragraph)} (got ${JSON.stringify(rejected)})`);
          assert(!run(endedBeforeReference, paragraph).passed, `${person.id}: a role that ended the month before the reference month is ended: ${JSON.stringify(paragraph)}`);
          assert(run(B, paragraph).passed, `${person.id}: B (source says the role is ongoing) must accept ${JSON.stringify(paragraph)}`);
          assert(run(endsAfterReference, paragraph).passed, `${person.id}: a role whose approved end month is still ahead is not ended: ${JSON.stringify(paragraph)}`);
          assert(!run(C, paragraph).passed, `${person.id}: C must reject ${JSON.stringify(paragraph)} again`);
        }
        for (const paragraph of pastWork) assert(run(A, paragraph).passed, `${person.id}: past-tense work at an ended employer is fine: ${JSON.stringify(paragraph)}`);
        // The employment that really is current is never flagged, whichever phrasing is used.
        assert(run(A, `As a ${person.current.title} at ${person.current.employer}, I support the weekend float roster.`).passed, `${person.id}: the genuinely current employer must remain acceptable`);
        assert(B.snapshotId !== A.snapshotId && C.snapshotId === A.snapshotId, `${person.id}: B is a recompile of changed dates and C restores the original content address`);
      }
    },
  },

  {
    name: 'adaptability ownership: faithful team-language prose keeps passing in every form, and recompiling with unrelated evidence never loosens or tightens it',
    run() {
      for (const person of PEOPLE) {
        const spec = baseSpec(person);
        const withNoise = withRoleBullet(spec, 'pri', { key: 'noise', text: `Kept the ${person.prior.employer} shift notes tidy and current.` });
        // Leadership wording about UNRELATED work, in the same role, must not leak into claims about the team work.
        const unrelatedLead = `Led ${person.unrelatedLead}.`;
        const withLeadNoise = withRoleBullet(spec, 'cur', { key: 'noise-lead', text: unrelatedLead });
        const builds = [build(spec), build(withNoise), build(withRole(spec, person.extraRole)), build(withLeadNoise)];
        assert(new Set(builds.map(built => built.snapshotId)).size === builds.length, `${person.id}: each recompilation must be a distinct snapshot`);
        const leadBuild = builds[3];
        assert(ownershipVerdict(unrelatedLead, quotesOf(leadBuild, 'noise-lead')).ok, `${person.id}: the sourced leadership line must support its own claim`);
        assert(rejectedForWord(ownershipVerdict(`Led ${person.markers.led[0]}.`, quotesOf(leadBuild, 'team-led')), 'Led'),
          `${person.id}: a leadership line about other work must not make the team-language evidence carry a leadership claim`);
        assert(!ownershipVerdict(`Led ${person.markers.led[0]}.`, quotesOf(leadBuild, 'noise-lead')).ok,
          `${person.id}: the unrelated leadership line must not be able to carry a claim about the team work either`);
        for (const marker of MARKERS) {
          const c = markerCase(person, marker);
          for (const built of builds) {
            assert(ownershipVerdict(c.faithful, quotesOf(built, c.teamKey)).ok, `${person.id}/${marker.id}: faithful bullet must pass in every recompilation`);
            assert(ownershipVerdict(firstPerson(c.faithful), quotesOf(built, c.teamKey), 'coverLetterParagraphs').ok, `${person.id}/${marker.id}: faithful letter sentence must pass in every recompilation`);
            assert(rejectedForWord(ownershipVerdict(c.inflated, quotesOf(built, c.teamKey)), marker.claimVerb), `${person.id}/${marker.id}: inflation must stay rejected in every recompilation`);
          }
        }
        // The team size in the source still reads as team language.
        const team = quotesOf(builds[0], 'team');
        assert(ownershipVerdict(person.currentBullets[0].text, team).ok, `${person.id}: the sourced team sentence must pass`);
      }
    },
  },
  {
    // assertSourceQuoteLinksFinalText / SOURCE_GROUNDING_QUALIFIER_RULES gate only "led", "own(ed)", "managed", "engineered/architected", "decided/approved/authorized".
    name: 'adaptability ownership [fixed defect]: sole-ownership wording ("single-handedly", "the sole ...") is accepted from team-language evidence',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.led[0];
        const quotes = quotesOf(A, 'team-led');
        assert(rejectedForWord(ownershipVerdict(`Owned ${subject}.`, quotes), 'Owned'), `control failed: "Owned" must be rejected for ${person.id}`);
        const accepted = acceptedClaims([`Single-handedly handled ${subject}.`, `Was the sole person handling ${subject}.`], quotes);
        return accepted.length ? `team work "${quotes[0]}" became sole ownership: ${JSON.stringify(accepted)}` : '';
      }), 'team language must not be turned into sole ownership');
    },
  },
  {
    // Same rule list: a leadership synonym is not a gated word.
    name: 'adaptability ownership [fixed defect]: leadership synonyms ("spearheaded", "headed", "directed", "orchestrated") are accepted from team-language evidence',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.led[0];
        const quotes = quotesOf(A, 'team-led');
        assert(rejectedForWord(ownershipVerdict(`Led ${subject}.`, quotes), 'Led'), `control failed: "Led" must be rejected for ${person.id}`);
        const accepted = acceptedClaims(['Spearheaded', 'Headed', 'Directed', 'Orchestrated'].map(word => `${word} ${subject}.`), quotes);
        return accepted.length ? `leadership wording absent from the source was accepted: ${JSON.stringify(accepted)}` : '';
      }), 'a leadership claim must be supported by the source whichever verb states it');
    },
  },
  {
    // Same rule list: "managed" is gated, "supervised"/"oversaw" are not.
    name: 'adaptability ownership [fixed defect]: oversight verbs ("supervised", "oversaw") are accepted where the source says only "supported colleagues"',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.managed[0];
        const quotes = quotesOf(A, 'team-managed');
        assert(rejectedForWord(ownershipVerdict(`Managed ${subject}.`, quotes), 'Managed'), `control failed: "Managed" must be rejected for ${person.id}`);
        const accepted = acceptedClaims(['Supervised', 'Oversaw'].map(word => `${word} ${subject}.`), quotes);
        return accepted.length ? `oversight wording absent from the source was accepted: ${JSON.stringify(accepted)}` : '';
      }), 'a management claim must be supported by the source whichever verb states it');
    },
  },
  {
    // Same rule list: "owned" is gated, founding verbs are not.
    name: 'adaptability ownership [fixed defect]: founding wording ("founded", "pioneered") is accepted where the source says only "contributed to"',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.owned[0];
        const quotes = quotesOf(A, 'team-owned');
        assert(rejectedForWord(ownershipVerdict(`Owned ${subject}.`, quotes), 'Owned'), `control failed: "Owned" must be rejected for ${person.id}`);
        const accepted = acceptedClaims(['Founded', 'Pioneered'].map(word => `${word} ${subject}.`), quotes);
        return accepted.length ? `founding wording absent from the source was accepted: ${JSON.stringify(accepted)}` : '';
      }), 'an origination claim must be supported by the source');
    },
  },
  {
    // assertSourceQuoteLinksFinalText compares figures only as %, currency and multipliers; pasteAttributionScopeErrors compares only digit counts of a fixed noun list (users, students, patients, employees, staff, ...).
    name: 'adaptability ownership [fixed defect]: a changed team size ("team of twelve" for "team of six") is accepted in final prose',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const quotes = quotesOf(A, 'team');
        const scopeFor = text => attributionErrors(A, { text, evidenceIds: evidenceIdsOf(A, 'team') });
        assert(attributionErrors(A, { text: person.census.inflated, evidenceIds: evidenceIdsOf(A, 'census') }).length === 1, `control failed: a changed headcount of a listed noun must be rejected for ${person.id}`);
        const rejected = !ownershipVerdict(person.teamNear, quotes).ok || scopeFor(person.teamNear).length > 0;
        return rejected ? '' : `"${person.teamNear}" changes the size stated by "${person.currentBullets[0].text}" yet was accepted`;
      }), 'a team size must equal the team size the cited evidence states');
    },
  },
  {
    // The qualifier regexes read the whole quote; the subject of the verb is never checked.
    name: 'adaptability ownership [fixed defect]: an ownership verb the source attributes to someone else ("who led ...", "the lead ...") supports the candidate leading it',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const subject = person.markers.led[0];
        const control = ownershipVerdict(`Led ${subject}.`, [`- Achievement [a-1]: Supported the department head on ${subject}.`]);
        assert(rejectedForWord(control, 'Led'), `control failed: "Led" must be rejected when no leadership word is present for ${person.id}`);
        const accepted = [
          `Supported the department head, who led ${subject}.`,
          `Reported to the lead of ${subject}.`,
        ].filter(quote => ownershipVerdict(`Led ${subject}.`, [`- Achievement [a-1]: ${quote}`]).ok);
        return accepted.length ? `"Led ${subject}." was accepted from ${JSON.stringify(accepted)}` : '';
      }), 'leadership attributed to another person must not support the candidate leading');
    },
  },
  {
    // The catalog quote embeds the host entity id and the qualifier regexes match inside it.
    name: 'adaptability ownership [fixed defect]: a model-chosen entity id containing an ownership word ("ach-led-...") satisfies the ownership gate for team-language evidence',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const subject = person.markers.led[0];
        const neutral = build(baseSpec(person));
        assert(rejectedForWord(ownershipVerdict(`Led ${subject}.`, quotesOf(neutral, 'team-led')), 'Led'), `control failed: an opaque id must reject "Led" for ${person.id}`);
        const leaky = build(baseSpec(person), { achievementId: key => `ach-led-${digest(key).slice(0, 8)}` });
        const result = ownershipVerdict(`Led ${subject}.`, quotesOf(leaky, 'team-led'));
        return result.ok ? `"Led ${subject}." was accepted from team evidence "${leaky.catalog.find(item => item.id.includes(leaky.achievementId('team-led'))).quote}"` : '';
      }), 'an identifier is not source evidence of leadership');
    },
  },
  {
    // pasteAttributionScopeErrors iterates only the approved roles' companies, so a name outside them is never examined.
    name: 'adaptability ownership [fixed defect]: final prose may name an employer that appears nowhere in the approved career',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const cite = evidenceIdsOf(A, person.priorBullets[0].key);
        const control = attributionErrors(A, { text: `At ${person.current.employer}, ${person.priorBullets[0].text}`, evidenceIds: cite });
        assert(control.length === 1, `control failed: a known employer cited against the wrong role must be flagged for ${person.id}`);
        const errors = attributionErrors(A, { text: `At ${person.foreignEmployer}, ${person.priorBullets[0].text}`, evidenceIds: cite });
        return errors.length ? '' : `"${person.foreignEmployer}" is absent from the source but "At ${person.foreignEmployer}, ${person.priorBullets[0].text}" raised no attribution error`;
      }), 'an employer attribution must name an employer in the approved career');
    },
  },
  {
    // Neither checker compares a claimed title with the approved titles.
    name: 'adaptability ownership [fixed defect]: final prose may assert a title ("As Director of Nursing", "I was promoted to ...") the source never states',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.led[0];
        const quotes = quotesOf(A, 'team-led');
        const cite = evidenceIdsOf(A, 'team-led');
        assert(rejectedForWord(ownershipVerdict(firstPerson(`Led ${subject}.`), quotes, 'coverLetterParagraphs'), 'Led'), `control failed: a letter-form "led" must be rejected for ${person.id}`);
        const unflagged = [
          `As ${person.inflatedTitle}, I assisted with ${subject}.`,
          `I was promoted to ${person.inflatedTitle} and assisted with ${subject}.`,
        ].filter(claim => ownershipVerdict(claim, quotes, 'coverLetterParagraphs').ok && attributionErrors(A, { text: claim, evidenceIds: cite }).length === 0);
        return unflagged.length ? `unsourced title accepted in ${JSON.stringify(unflagged)}` : '';
      }), 'a title in final prose must be a title the source states');
    },
  },
  {
    // pasteAttributionScopeErrors: an organization the source mentions only as client/vendor is never compared with the roles.
    name: "adaptability ownership [fixed defect]: a client or vendor named in the source can be presented as the candidate's employer in final prose",
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const cite = evidenceIdsOf(A, 'outsider');
        const lowered = `${person.currentBullets[2].text.charAt(0).toLowerCase()}${person.currentBullets[2].text.slice(1)}`;
        const control = attributionErrors(A, { text: `As a ${person.prior.title} at ${person.prior.employer}, I ${lowered}`, evidenceIds: cite });
        assert(control.length === 1, `control failed: an approved employer cited against another role's evidence must be flagged for ${person.id}`);
        const text = `As a ${person.current.title} at ${person.outsider}, I ${lowered}`;
        const errors = attributionErrors(A, { text, evidenceIds: cite });
        return errors.length ? '' : `"${text}" raised no attribution error although "${person.outsider}" is only a client/vendor`;
      }), 'an organization the source names only as client/vendor must not pass as the candidate\'s employer');
    },
  },
  {
    // validateCareerProfile checks roleId/achievementIds links for consistency, never that the cited line sits inside the role's own source block.
    name: 'adaptability ownership [fixed defect]: the compile gate accepts an achievement attached to a role whose source block does not contain the cited line',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const achievementId = A.achievementId(person.priorBullets[0].key);
        const moved = cloneProfile(A.profile);
        const prior = moved.roles.find(role => role.id === roleIdOf('pri'));
        const current = moved.roles.find(role => role.id === roleIdOf('cur'));
        const half = cloneProfile(A.profile);
        half.achievements.find(item => item.id === achievementId).roleId = roleIdOf('cur');
        assert(!validateCareerProfile(half, A.corpus).valid, `control failed: an inconsistent role link must be rejected for ${person.id}`);
        prior.achievementIds = prior.achievementIds.filter(id => id !== achievementId);
        current.achievementIds.push(achievementId);
        moved.achievements.find(item => item.id === achievementId).roleId = current.id;
        const result = validateCareerProfile(moved, A.corpus);
        return result.valid ? `"${person.priorBullets[0].text}" sits under ${person.prior.employer} in the source yet validated under ${person.current.employer}` : '';
      }), 'an achievement must belong to the role whose source block states it');
    },
  },
  {
    // validateCareerProfile grounds the employer by substring over ALL segments the role cites.
    name: 'adaptability ownership [fixed defect]: the compile gate accepts a client or vendor as a role employer when the role also cites the line that mentions it',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const headerOnly = cloneProfile(A.profile);
        headerOnly.roles.find(role => role.id === roleIdOf('cur')).employer = person.outsider;
        assert(!validateCareerProfile(headerOnly, A.corpus).valid, `control failed: an outsider employer citing only the header must be rejected for ${person.id}`);
        const profile = cloneProfile(A.profile);
        const outsiderSegments = A.corpus.segments.filter(segment => segment.text.includes(person.outsider)).map(segment => segment.id);
        const current = profile.roles.find(role => role.id === roleIdOf('cur'));
        current.employer = person.outsider;
        current.evidenceSegmentIds.push(...outsiderSegments);
        for (const entry of profile.segmentCoverage) if (outsiderSegments.includes(entry.segmentId)) entry.entityIds.push(current.id);
        return validateCareerProfile(profile, A.corpus).valid ? `"${person.outsider}" (client/vendor) validated as the employer of ${person.current.title}` : '';
      }), 'a role employer must be stated as the employer, not merely mentioned, in the role\'s evidence');
    },
  },
  {
    // "Co-led", "Helped lead" and "Shared ownership of" contain a gated word, and the qualifier gate reads the whole quote for that word without asking at what level it was done.
    name: 'adaptability ownership [fixed defect]: shared or subordinate ownership in the source ("co-led", "helped lead", "shared ownership of", "co-managed") supports the unqualified claim ("Led", "Owned", "Managed")',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const cases = [
          { marker: MARKERS[0], subject: person.markers.led[0], sources: s => [`Co-led ${s} with the department head.`, `Helped lead ${s}.`, `Assisted in leading ${s}.`] },
          { marker: MARKERS[1], subject: person.markers.owned[0], sources: s => [`Shared ownership of ${s} with two colleagues.`, `Co-owned ${s} with a peer.`] },
          { marker: MARKERS[2], subject: person.markers.managed[0], sources: s => [`Co-managed ${s} with a supervisor.`, `Helped manage ${s}.`] },
        ];
        const accepted = [];
        for (const { marker, subject, sources } of cases) {
          assert(rejectedForWord(ownershipVerdict(`${marker.claimVerb} ${subject}.`, quotesOf(A, `team-${marker.id}`)), marker.claimVerb),
            `control failed: "${marker.claimVerb}" must be rejected from plain team language for ${person.id}`);
          for (const source of sources(subject)) {
            if (ownershipVerdict(`${marker.claimVerb} ${subject}.`, [`- Achievement [a-1]: ${source}`]).ok) accepted.push(`"${marker.claimVerb} ${subject}." from "${source}"`);
          }
        }
        return accepted.length ? `shared ownership became sole ownership: ${JSON.stringify(accepted)}` : '';
      }), 'a claim must not drop the shared or subordinate level the source states');
    },
  },
  {
    // SOURCE_GROUNDING_QUALIFIER_RULES gates only engineered/architected among authorship verbs; every other authorship verb is checked for topic overlap alone.
    name: 'adaptability ownership [fixed defect]: authorship verbs ("built", "created", "developed", "designed", "implemented", "established", "launched", "introduced", "initiated") are accepted where the source says only "contributed to"',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.architected[0];
        const quotes = quotesOf(A, 'team-architected');
        assert(rejectedForWord(ownershipVerdict(`Architected ${subject}.`, quotes), 'Architected'), `control failed: "Architected" must be rejected from "${quotes[0]}" for ${person.id}`);
        const verbs = ['Built', 'Created', 'Developed', 'Designed', 'Implemented', 'Established', 'Launched', 'Introduced', 'Initiated'];
        const accepted = acceptedClaims(verbs.map(verb => `${verb} ${subject}.`), quotes);
        return accepted.length ? `authorship absent from the source was accepted: ${JSON.stringify(accepted)}` : '';
      }), 'an authorship claim must be supported by an authorship statement in the source');
    },
  },
  {
    // The claim side of the leadership/ownership rules matches the verb forms only ("led", "owned"), never the noun forms or sole-responsibility phrases.
    name: 'adaptability ownership [fixed defect]: ownership stated as a noun or a sole-responsibility phrase ("served as the lead", "team lead for", "head of", "owner of", "solely responsible for", "independently handled") is accepted from team-language evidence',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const ledSubject = person.markers.led[0];
        const ownedSubject = person.markers.owned[0];
        const ledQuotes = quotesOf(A, 'team-led');
        const ownedQuotes = quotesOf(A, 'team-owned');
        assert(rejectedForWord(ownershipVerdict(`Led ${ledSubject}.`, ledQuotes), 'Led') && rejectedForWord(ownershipVerdict(`Owned ${ownedSubject}.`, ownedQuotes), 'Owned'),
          `control failed: the verb forms must be rejected for ${person.id}`);
        const accepted = [
          ...acceptedClaims([`Served as the lead for ${ledSubject}.`, `Team lead for ${ledSubject}.`, `Head of ${ledSubject}.`], ledQuotes),
          ...acceptedClaims([`Acted as the owner of ${ownedSubject}.`, `Solely responsible for ${ownedSubject}.`, `Independently handled ${ownedSubject}.`], ownedQuotes),
        ];
        return accepted.length ? `ownership absent from the source was accepted: ${JSON.stringify(accepted)}` : '';
      }), 'ownership must be supported by the source whether it is written as a verb, a noun, or a sole-responsibility phrase');
    },
  },
  {
    // pasteAttributionScopeErrors' populationClaims only compares counts followed by a fixed noun list, and assertSupportedSourceFigures skips bare numbers.
    name: 'adaptability ownership [fixed defect]: a changed team size in digits ("Managed 60 people" for "Managed 6 people") is accepted for nouns outside the fixed population list',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const subject = person.markers.managed[0];
        const judge = (noun, sourceCount, claimCount) => {
          const quote = `- Achievement [a-1]: Managed ${sourceCount} ${noun} on ${subject}.`;
          const text = `Managed ${claimCount} ${noun} on ${subject}.`;
          const scope = attributionErrors(A, { text, evidenceIds: ['probe-evidence'], extraEvidence: [{ id: 'probe-evidence', sourceId: 'career-data', quote }] });
          return ownershipVerdict(text, [quote]).ok && scope.length === 0 ? 'accepted' : 'rejected';
        };
        assert(judge('employees', 6, 60) === 'rejected', `control failed: a changed count of a listed noun must be rejected for ${person.id}`);
        assert(judge('people', 6, 6) === 'accepted', `control failed: an unchanged team size must be accepted for ${person.id}`);
        const accepted = ['people', 'direct reports', 'team members', 'technicians'].filter(noun => judge(noun, 6, 60) === 'accepted');
        return accepted.length ? `"Managed 60 <noun>" was accepted from "Managed 6 <noun>" for nouns ${JSON.stringify(accepted)}` : '';
      }), 'a team size must equal the team size the cited evidence states, whatever the people are called');
    },
  },
  {
    // assertSourceQuoteLinksFinalText runs the qualifier rules only on sentences isCandidateCareerSentence() selects: first person, or one that contains a token of a résumé role title/employer.
    name: 'adaptability ownership [fixed defect]: an implicit-subject cover-letter sentence ("Led the ...", "Owned the ...") escapes the ownership gate that the same sentence with "I" or an employer name meets',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        // Approximation of the identity tokens the pipeline derives from the résumé's role titles and employers.
        const identityTokens = [...new Set(A.authority.sourceRoles.flatMap(role => `${role.title} ${role.company}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].filter(token => token.length > 2);
        const judge = (text, quotes) => verdict(() => assertSourceQuoteLinksFinalText(text, quotes, 'coverLetterParagraphs', 0, { identityTokens }));
        const subjects = { Led: person.markers.led[0], Owned: person.markers.owned[0], Managed: person.markers.managed[0] };
        const quotesFor = { Led: quotesOf(A, 'team-led'), Owned: quotesOf(A, 'team-owned'), Managed: quotesOf(A, 'team-managed') };
        for (const [verb, subject] of Object.entries(subjects)) {
          assert(rejectedForWord(judge(`I ${verb.toLowerCase()} ${subject}.`, quotesFor[verb]), verb), `control failed: "I ${verb.toLowerCase()} ..." must be rejected for ${person.id}`);
          assert(rejectedForWord(judge(`At ${person.current.employer}, ${verb.toLowerCase()} ${subject}.`, quotesFor[verb]), verb), `control failed: the employer-named form must be rejected for ${person.id}`);
        }
        const accepted = Object.entries(subjects).filter(([verb, subject]) => judge(`${verb} ${subject}.`, quotesFor[verb]).ok).map(([verb, subject]) => `${verb} ${subject}.`);
        return accepted.length ? `implicit-subject letter sentences passed the ownership gate: ${JSON.stringify(accepted)}` : '';
      }), 'a letter sentence must meet the ownership gate however its subject is written');
    },
  },
  {
    // validateCareerProfile grounds title and employer each by substring over the same cited header segments, so exchanging them is invisible.
    name: 'adaptability ownership [fixed defect]: the compile gate accepts a role title and employer exchanged with each other',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(baseSpec(person));
        const foreign = cloneProfile(A.profile);
        foreign.roles.find(role => role.id === roleIdOf('cur')).employer = person.foreignEmployer;
        assert(!validateCareerProfile(foreign, A.corpus).valid, `control failed: an employer absent from the source must be rejected for ${person.id}`);
        const swapped = cloneProfile(A.profile);
        const current = swapped.roles.find(role => role.id === roleIdOf('cur'));
        [current.title, current.employer] = [person.current.employer, person.current.title];
        return validateCareerProfile(swapped, A.corpus).valid ? `title "${current.title}" and employer "${current.employer}" were accepted for the header "${person.current.title}, ${person.current.employer}"` : '';
      }), 'the title and the employer must each be the part of the header that plays that role');
    },
  },
  {
    // The qualifier rules read sourceQuotes.join(' '): a leadership word in ANY cited quote supports the claim, wherever in the unit it sits.
    name: 'adaptability ownership [fixed defect]: a leadership word in one cited achievement supports a leadership claim about a different cited achievement',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const A = build(withRoleBullet(baseSpec(person), 'cur', { key: 'noise-lead', text: `Led ${person.unrelatedLead}.` }));
        const subject = person.markers.led[0];
        assert(rejectedForWord(ownershipVerdict(`Led ${subject}.`, quotesOf(A, 'team-led')), 'Led'), `control failed: the team evidence alone must reject "Led" for ${person.id}`);
        const pooled = ownershipVerdict(`Led ${subject}.`, [...quotesOf(A, 'team-led'), ...quotesOf(A, 'noise-lead')]);
        return pooled.ok ? `"Led ${subject}." was accepted because another cited achievement says "Led ${person.unrelatedLead}."` : '';
      }), 'an ownership word must be supported by the evidence about the same work');
    },
  },
  {
    // pasteAttributionScopeErrors iterates every approved role and requires EACH role carrying the named employer to be scoped by the evidence, so a second role at the same employer fails a statement that is true.
    name: 'adaptability ownership [fixed defect]: a faithful employer attribution is rejected when two approved roles share one employer (a promotion within a company)',
    run() {
      assertNoViolations(violationsAcrossProfiles(person => {
        const spec = baseSpec(person);
        spec.roles[1].employer = person.current.employer;
        const A = build(spec);
        const bullet = person.priorBullets[0].text;
        const withoutEmployer = attributionErrors(A, { text: bullet, evidenceIds: evidenceIdsOf(A, person.priorBullets[0].key) });
        assert(withoutEmployer.length === 0, `control failed: the same sentence without an employer name must be accepted for ${person.id}`);
        const errors = attributionErrors(A, { text: `At ${person.current.employer}, ${bullet}`, evidenceIds: evidenceIdsOf(A, person.priorBullets[0].key) });
        return errors.length ? `"At ${person.current.employer}, ..." is true of both roles yet raised: ${errors[0].slice(0, 120)}` : '';
      }), 'an employer attribution that is true of the cited role must be accepted even when another role shares the employer');
    },
  },
];

// ---------------------------------------------------------------------------
// Shared helpers of the `[fixed defect]` tests above (each first asserts a CONTROL, the
// nearest case production always handled, so a failure can only mean the defect itself
// came back), and `knownGaps`: none. A production behaviour that violates an invariant
// but is not yet fixed goes there; the registry does not run it, so each entry must throw today.
// ---------------------------------------------------------------------------

/** Run `probe` for every profile; it returns a string describing a violation, or ''. */
function violationsAcrossProfiles(probe) {
  return PEOPLE.map(person => {
    const note = probe(person);
    return note ? `${person.id}: ${note}` : '';
  }).filter(Boolean);
}
const assertNoViolations = (violations, expectation) => assert(violations.length === 0, `${expectation} -- violated for ${violations.length} of ${PEOPLE.length} profiles: ${violations.join(' || ')}`);
const acceptedClaims = (claims, quotes, label = 'resumeBullets') => claims.filter(claim => ownershipVerdict(claim, quotes, label).ok);

export const knownGaps = [];
