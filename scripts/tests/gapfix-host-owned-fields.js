// Regression tests for host-owned résumé fields.
//
// A live run was rejected 44 times in a row at the résumé stage over ONE
// uncoded error: a project name the writer kept restating in another
// capitalization than the approved snapshot spells it, while the rejection never
// said what the approved spelling was.  The same exact-copy demand exists for a
// role's title/company/dates/location and for education and certification
// records, so those are one defect class and are fixed together:
//
//   1. the HOST writes these fields: a value that equals the approved one after
//      conservative normalization (case, Unicode form, whitespace, dash and quote
//      variants) is replaced with the approved text before any validator, hash,
//      renderer or later stage reads the response, and the Generation Log records
//      a typed event (field, hashes only);
//   2. a value that differs after normalization is still refused, and the refusal
//      states the exact approved text ("expected exactly: ...");
//   3. the entity is never chosen by the surface form: evidence that resolves to
//      two approved entities is not snapped.
//
// Every fixture is synthetic and the careers are unrelated (a freight analyst, a
// structural engineer, a pastry chef).  Their approved strings are deliberately
// awkward: all lowercase, ALL CAPS, and odd punctuation with en dashes and
// curly quotes.  No rule under test may be satisfied by a string it was written
// against; each verdict is a function of the approved record and of what the
// response says.
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { assert } from './testHelpers.js';
import { currentAuthorityFlowKit } from './local-ai-application.js';
import { getLocalApplicationHandoff, queueLocalApplicationJob, submitLocalApplicationHandoff } from '../test-dependencies.js';
import { __validateAuthorityResumeArtifactsForTests } from '../../electron/ipc/localAiApplication.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import {
  approvedCareerEvidenceCatalog, buildCareerSourceCorpus, careerSnapshotId, careerSnapshotStorageRoot,
  CAREER_SNAPSHOT_COMPILATION_CONTRACT, CAREER_SNAPSHOT_SCHEMA_VERSION, CAREER_SNAPSHOT_STATUS_APPROVED,
  emptyCareerReconciliationReceipt, partitionCareerSourcePages, verbatimCareerTranscriptionAuditReceipt,
  writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';
import { HOST_FIELD_CANONICALIZED_EVENT, canonicalizeHostOwnedResumeFields } from '../../electron/ipc/hostOwnedResumeFields.js';
import { HOST_OWNED_EXPECTED_VALUE_MAX_CHARS, boundedExpectedValue, hostOwnedSurfaceKey, hostOwnedValueSha256, sameHostOwnedValue } from '../../electron/ipc/hostOwnedText.js';

const kit = currentAuthorityFlowKit;

const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const MINUS = String.fromCharCode(0x2212);
const NB_HYPHEN = String.fromCharCode(0x2011);
const decompose = value => value.normalize('NFD');

// ---------------------------------------------------------------------------
// Synthetic careers.  `approved` is exactly what the snapshot spells; `variant`
// restates the same entity in another surface form; `different` is a genuinely
// different value for the same field.
// ---------------------------------------------------------------------------
export const CAREERS = Object.freeze([
  {
    id: 'freight', name: 'Imogen Farrow', email: 'imogen.farrow@example.test', tech: 'Excel',
    bullet: 'Built Excel pricing workbook used by 40 brokers.', skillId: 'skill-excel',
    role: { id: 'role-harbor', title: 'senior freight analyst', employer: 'harbor & sons logistics', start: 'March 2016', end: 'Present' },
    projects: [
      { id: 'project-lane-model', name: 'lane pricing model', description: 'Built and shipped a pricing model that quotes freight lanes for many brokers.', resumeDescription: 'Lane pricing model that gives many brokers reliable service delivery.' },
      { id: 'project-yard-map', name: 'yard slot map', description: 'Built and shipped a slot map that assigns dock doors for inbound trailers.', resumeDescription: 'Yard slot map that gives dock crews reliable service delivery.' },
    ],
    education: { id: 'edu-supply', credential: 'b.sc. supply chain management', institution: 'northfield polytechnic', dates: `2008 ${EN} 2012` },
    certification: { id: 'cert-broker', name: 'certified freight broker', issuer: 'continental freight council', dates: '2014' },
    variant: {
      title: 'Senior Freight Analyst', company: 'Harbor & Sons Logistics', dates: `March 2016 - Present`,
      project: 'Lane Pricing Model', credential: 'B.Sc. Supply Chain Management', institution: 'Northfield Polytechnic', eduDates: `2008 - 2012`,
      certName: 'Certified Freight Broker', certIssuer: 'Continental Freight Council',
    },
    different: { title: 'Senior Freight Analyst II', company: 'Harbor and Sons Logistics', dates: `March 2017 ${EN} Present`, project: 'Lane Pricing Model 2', credential: 'b.sc. logistics management', certName: 'certified freight broker level 2' },
  },
  {
    id: 'structural', name: 'Ingrid Valdemar', email: 'ingrid.valdemar@example.test', tech: 'AutoCAD',
    bullet: 'Built AutoCAD detail library used by 25 engineers.', skillId: 'skill-autocad',
    role: { id: 'role-granite', title: 'STRUCTURAL ENGINEER', employer: 'GRANITE RIDGE CONSULTANTS', start: '2015', end: '2022' },
    projects: [
      { id: 'project-bearing-check', name: 'BEARING CHECK TOOL', description: 'Built and shipped a checker that verifies bridge bearing loads for many engineers.', resumeDescription: 'Bearing check tool that gives many engineers reliable service delivery.' },
      { id: 'project-slab-sheet', name: 'SLAB DESIGN SHEET', description: 'Built and shipped a worksheet that sizes parking structure slabs for design teams.', resumeDescription: 'Slab design sheet that gives design teams reliable service delivery.' },
    ],
    education: { id: 'edu-civil', credential: 'M.ENG. CIVIL ENGINEERING', institution: 'CALDERA INSTITUTE OF TECHNOLOGY', dates: `2013 ${EN} 2015` },
    certification: { id: 'cert-license', name: 'PROFESSIONAL ENGINEER LICENSE', issuer: 'STATE BOARD OF ENGINEERS', dates: '2018' },
    variant: {
      title: 'structural  engineer', company: 'granite ridge consultants', dates: `2015 ${EM} 2022`,
      project: 'Bearing Check Tool', credential: 'M.Eng. Civil Engineering', institution: 'Caldera Institute Of Technology', eduDates: `2013 ${EM} 2015`,
      certName: 'Professional Engineer License', certIssuer: 'State Board Of Engineers',
    },
    different: { title: 'STRUCTURAL ENGINEER III', company: 'GRANITE RIDGE ASSOCIATES', dates: `2015 ${EN} 2023`, project: 'BEARING CHECK TOOL V2', credential: 'M.ENG. MECHANICAL ENGINEERING', certName: 'PROFESSIONAL ENGINEER LICENSE 2' },
  },
  {
    id: 'pastry', name: 'Teodoro Brightwater', email: 'teodoro.brightwater@example.test', tech: 'Airtable',
    bullet: 'Built Airtable production planner used by 12 bakers.', skillId: 'skill-airtable',
    role: { id: 'role-obriens', title: 'Pastry Chef (Retail/Events)', employer: 'O’Brien’s Bakery & Café (Downtown)', start: 'Apr 2019', end: 'Present' },
    projects: [
      { id: 'project-dough', name: 'Laminated Dough “Program”: Seasonal Rota', description: 'Built and shipped a dough program that schedules laminated bakes for retail counters.', resumeDescription: 'Laminated dough program that gives retail counters reliable service delivery.' },
      { id: 'project-rota', name: 'Counter Display Rota', description: 'Built and shipped a rota that assigns display duties for the counter staff.', resumeDescription: 'Counter display rota that gives counter staff reliable service delivery.' },
    ],
    education: { id: 'edu-patisserie', credential: 'Dipl. in Pâtisserie (Level-3)', institution: 'École Bellerive', dates: `2004 ${EN} 2006` },
    certification: { id: 'cert-safety', name: 'Food Safety Manager: “Level-2”', issuer: 'City Health Board', dates: '2020' },
    variant: {
      title: 'pastry chef (retail/events)', company: "O'Brien's Bakery & Café (Downtown)", dates: `Apr 2019 ${MINUS} Present`,
      project: 'Laminated Dough "Program": Seasonal Rota', credential: decompose(`Dipl. in Pâtisserie (Level${NB_HYPHEN}3)`), institution: 'ÉCOLE BELLERIVE', eduDates: `2004 ${NB_HYPHEN} 2006`,
      certName: `food safety manager: "level${NB_HYPHEN}2"`, certIssuer: 'CITY HEALTH BOARD',
    },
    different: { title: 'Pastry Chef (Retail and Events)', company: 'O’Brien’s Bakery & Café (Uptown)', dates: `Apr 2019 ${EN} Dec 2023`, project: 'Laminated Dough “Program”: Winter Rota', credential: 'Dipl. in Pâtisserie (Level-4)', certName: 'Food Safety Manager: “Level-3”' },
  },
]);

const listing = career => `Reliable ${career.tech} service delivery is required.`;
const approvedDates = career => `${career.role.start} ${EN} ${career.role.end}`;

// ---------------------------------------------------------------------------
// Snapshot builders.  `snapshotOf` builds the in-memory approved snapshot the
// authority is built from; `createResumeStageFlow` writes it to disk and drives
// the real current-authority protocol (queue, requirements, audit, match) up to
// the résumé stage.  Only the model is scripted.
// ---------------------------------------------------------------------------
function profileLines(career) {
  const [first, second] = career.projects;
  return [
    career.name, career.email, `${career.role.title} at ${career.role.employer}`,
    `${career.role.start} to ${career.role.end}`, career.bullet,
    first.name, first.description, second.name, second.description,
    `${career.education.credential}, ${career.education.institution}`, career.education.dates,
    `${career.certification.name} - ${career.certification.issuer}`, career.certification.dates,
  ];
}

function profileOf(career, corpus) {
  const evidence = corpus.segments.map(segment => segment.id);
  const roleId = career.role.id; const achievementId = `achievement-${career.id}`;
  const entityIds = ['identity', roleId, achievementId, career.skillId, ...career.projects.map(project => project.id), career.education.id, career.certification.id];
  return {
    identity: { name: career.name, contacts: [career.email], evidenceSegmentIds: evidence },
    roles: [{ id: roleId, title: career.role.title, employer: career.role.employer, startDate: career.role.start, endDate: career.role.end, location: '', achievementIds: [achievementId], skillIds: [career.skillId], evidenceSegmentIds: evidence }],
    achievements: [{ id: achievementId, roleId, claim: career.bullet, technologies: [career.tech],
      technologyReferences: [{ technology: career.tech, disposition: 'skill', skillId: career.skillId, relationship: 'independent', relationshipGroup: '', relationshipEvidence: career.bullet, evidenceSegmentIds: evidence }],
      metrics: [], evidenceSegmentIds: evidence }],
    projects: career.projects.map(project => ({ id: project.id, name: project.name, description: project.description, roleId: '', technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: evidence })),
    skills: [{ id: career.skillId, name: career.tech, category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: [roleId], evidenceSegmentIds: evidence }],
    education: [{ id: career.education.id, credential: career.education.credential, institution: career.education.institution, dates: career.education.dates, evidenceSegmentIds: evidence }],
    certifications: [{ id: career.certification.id, name: career.certification.name, issuer: career.certification.issuer, dates: career.certification.dates, evidenceSegmentIds: evidence }],
    otherEvidence: [],
    segmentCoverage: corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'achievement', entityIds })),
  };
}

// The approved snapshot as the authority consumes it, with no disk involved.
function snapshotOf(career) {
  const profile = profileOf(career, { segments: [] });
  return { snapshotId: `host-owned-${career.id}`, status: CAREER_SNAPSHOT_STATUS_APPROVED, profile };
}

async function writeSnapshot(career) {
  const text = `${profileLines(career).join('\n')}\n`;
  const corpus = buildCareerSourceCorpus([{ name: `${career.id} career.md`, contentHash: kit.sha256(text), text, legacyText: text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
  const profile = profileOf(career, corpus);
  const snapshotId = careerSnapshotId(corpus); const snapshotRoot = careerSnapshotStorageRoot(electronPkg.app.getPath('userData'));
  await fs.promises.mkdir(path.dirname(snapshotRoot), { recursive: true, mode: 0o700 });
  const pages = partitionCareerSourcePages(corpus);
  await writeCareerSnapshotAtomically(snapshotRoot, { schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: CAREER_SNAPSHOT_STATUS_APPROVED, snapshotId,
    inputFingerprint: corpus.inputFingerprint, sourceFingerprint: corpus.sourceFingerprint, compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: kit.sha256(kit.canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-10T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments, profile, auditHistory: kit.cleanCareerSnapshotAuditHistory(corpus, profile) });
  return snapshotId;
}

/** Drives one job to its résumé-stage handoff; returns the scripted-flow handle. */
export async function createResumeStageFlow(career, snapshotId) {
  const project = await kit.createCanvasProject();
  const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: project.canvasFilePath, careerSnapshotId: snapshotId,
    job: { title: career.role.title, company: career.role.employer, snippet: listing(career) } });
  const flow = { career, project, queued, manifestPath: path.join(queued.folder, 'manifest.json'), logPath: path.join(queued.folder, 'Generation Log.jsonl') };
  flow.current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
  flow.submit = (handoff, fields) => submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
    response: JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields }) });
  flow.contextOf = handoff => JSON.parse(handoff.prompt.slice(handoff.prompt.lastIndexOf('\n\nAuthoritative context:\n') + '\n\nAuthoritative context:\n'.length));
  flow.manifest = async () => JSON.parse(await fs.promises.readFile(flow.manifestPath, 'utf8'));
  flow.logEvents = async () => (await fs.promises.readFile(flow.logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  flow.logText = () => fs.promises.readFile(flow.logPath, 'utf8');
  flow.cleanup = () => fs.promises.rm(project.root, { recursive: true, force: true });

  let handoff = await flow.current(); const requirementContext = flow.contextOf(handoff);
  const requirementEvidence = [
    { id: 'p1-listing', sourceId: 'job-listing', quote: listing(career), requirement: `Reliable ${career.tech} service delivery`, priority: 'highest' },
    { id: 'p1-listing-detail', sourceId: 'job-listing', quote: `Reliable ${career.tech} service delivery`, requirement: `Production reliability for ${career.tech} work`, priority: 'high' },
  ];
  const requirementRecords = [
    { id: 'p1-requirement', text: `Reliable ${career.tech} service delivery`, priority: 'highest', evidenceIds: ['p1-listing', 'p1-listing-detail'] },
    { id: 'p1-requirement-reliability', text: `Production reliability for ${career.tech} work`, priority: 'high', evidenceIds: ['p1-listing'] },
  ];
  let accepted = await flow.submit(handoff, { storeDigest: requirementContext.authorityStore.digest, complete: true, identity: requirementContext.trustedIdentity,
    evidence: requirementEvidence, requirements: requirementRecords, ...kit.listingCoverageFields(requirementContext, requirementEvidence, requirementRecords) });
  assert(accepted.accepted && accepted.handoff.stage === 'requirements-audit', `[${career.id}] requirements must reach the audit (${JSON.stringify(accepted.validationErrors || [])})`);
  handoff = await flow.current();
  accepted = await flow.submit(handoff, kit.listingSemanticAuditFields(flow.contextOf(handoff), requirementEvidence, requirementRecords));
  assert(accepted.accepted && accepted.handoff.stage === 'career-match', `[${career.id}] the audit must reach matching (${JSON.stringify(accepted.validationErrors || [])})`);
  // The catalog is paged: every page is matched in turn, and the exact evidence
  // ids the résumé may cite are collected across all of them.
  const catalog = [];
  handoff = await flow.current();
  for (let guard = 0; handoff.stage === 'career-match'; guard += 1) {
    assert(guard < 30, `[${career.id}] matching must converge`);
    const matchContext = flow.contextOf(handoff);
    catalog.push(...matchContext.catalog);
    accepted = await flow.submit(handoff, { version: 1, rootDigest: matchContext.pair.rootDigest, pairDigest: matchContext.pair.digest,
      rows: matchContext.requirements.map(requirement => ({ requirementId: requirement.id, localStatus: 'matched', candidateEvidenceIds: matchContext.catalog.map(item => item.id) })) });
    assert(accepted.accepted, `[${career.id}] the match must be accepted (${JSON.stringify(accepted.validationErrors || [])})`);
    handoff = await flow.current();
  }
  assert(handoff.stage === 'resume', `[${career.id}] matching must reach the résumé stage, found ${handoff.stage}`);
  flow.resumeHandoff = handoff;
  // The résumé may cite only the evidence the host selected into its plan.
  const planIds = flow.contextOf(handoff).evidencePlan.evidence.map(item => item.id);
  const idsFor = prefix => planIds.filter(id => id.startsWith(prefix));
  flow.evidence = {
    achievement: idsFor('host.career.achievement.')[0],
    skill: idsFor(`host.career.skill.${career.skillId}.`)[0],
    projects: Object.fromEntries(career.projects.map(item => [item.id, idsFor(`host.career.project.${item.id}.`)])),
    education: idsFor(`host.career.education.${career.education.id}.`),
    certification: idsFor(`host.career.certification.${career.certification.id}.`),
  };
  flow.obligation = flow.contextOf(handoff).resumeProjectObligation || null;
  return flow;
}

export { snapshotOf, writeSnapshot, listing, approvedDates };

/** The résumé a writer would send; every host-owned field can be restated. */
export function resumeFor(flow, forms = {}) {
  const { career, evidence } = flow;
  return {
    schemaVersion: 'structured-resume.v1', identity: { name: career.name, contact: [career.email] },
    roles: [{ id: career.role.id, title: forms.title ?? career.role.title, company: forms.company ?? career.role.employer, dates: forms.dates ?? approvedDates(career), location: '',
      bullets: [{ id: 'bullet-1', text: career.bullet, evidenceIds: [evidence.achievement] }] }],
    projects: [{ id: 'project-1', name: forms.project ?? career.projects[0].name, description: career.projects[0].resumeDescription, evidenceIds: forms.projectEvidenceIds ?? [flow.obligation.evidenceId, 'p1-listing'] }],
    education: [{ id: 'education-1', credential: forms.credential ?? career.education.credential, institution: forms.institution ?? career.education.institution, evidenceIds: [evidence.education[0]] }],
    credentials: [{ id: 'credential-1', name: forms.certName ?? career.certification.name, issuer: forms.certIssuer ?? career.certification.issuer, evidenceIds: [evidence.certification[0]] }],
    skills: [{ id: 'skills-main', group: 'Tools', items: [career.tech], evidenceIds: [evidence.skill] }],
  };
}


// ---------------------------------------------------------------------------
// Shared helpers for the tests below.
// ---------------------------------------------------------------------------
const J = value => JSON.stringify(value);
const expectedClause = (label, value) => `${label} expected exactly: ${J(value)}`;
const variantForms = career => ({
  title: career.variant.title, company: career.variant.company, dates: career.variant.dates, project: career.variant.project,
  credential: career.variant.credential, institution: career.variant.institution, certName: career.variant.certName, certIssuer: career.variant.certIssuer,
});

// The (unit, field, written form, approved form) rows a variant résumé restates.
function fieldRows(career) {
  return [
    ['role', 'title', career.variant.title, career.role.title], ['role', 'company', career.variant.company, career.role.employer],
    ['role', 'dates', career.variant.dates, approvedDates(career)], ['project', 'name', career.variant.project, career.projects[0].name],
    ['education', 'credential', career.variant.credential, career.education.credential], ['education', 'institution', career.variant.institution, career.education.institution],
    ['credential', 'name', career.variant.certName, career.certification.name], ['credential', 'issuer', career.variant.certIssuer, career.certification.issuer],
  ];
}

// A résumé over the authority's own catalog ids, for tests that do not run a flow.
function unitResume(career, forms = {}) {
  const id = prefix => `host.career.${prefix}`;
  return {
    schemaVersion: 'structured-resume.v1', identity: { name: career.name, contact: [career.email] },
    roles: [{ id: career.role.id, title: forms.title ?? career.role.title, company: forms.company ?? career.role.employer, dates: forms.dates ?? approvedDates(career), location: '',
      bullets: [{ id: 'bullet-1', text: career.bullet, evidenceIds: [`${id('achievement')}.achievement-${career.id}.1`] }] }],
    projects: [{ id: 'project-1', name: forms.project ?? career.projects[0].name, description: career.projects[0].resumeDescription,
      evidenceIds: forms.projectEvidenceIds ?? [`${id('project')}.${career.projects[0].id}.1`, 'p1-listing'] }],
    education: [{ id: 'education-1', credential: forms.credential ?? career.education.credential, institution: forms.institution ?? career.education.institution,
      dates: forms.eduDates ?? career.education.dates, evidenceIds: [`${id('education')}.${career.education.id}.1`, `${id('education')}.${career.education.id}.3`] }],
    credentials: [{ id: 'credential-1', name: forms.certName ?? career.certification.name, issuer: forms.certIssuer ?? career.certification.issuer,
      dates: career.certification.dates, evidenceIds: [`${id('certification')}.${career.certification.id}.1`, `${id('certification')}.${career.certification.id}.2`] }],
  };
}

function authorityKit(career) {
  const snapshot = snapshotOf(career);
  const authority = buildApplicationCareerAuthority(snapshot);
  const acceptedEvidence = [...approvedCareerEvidenceCatalog(snapshot), { id: 'p1-listing', sourceId: 'job-listing', quote: listing(career) }];
  return { authority, acceptedEvidence, sourceRoles: authority.sourceRoles };
}

const canonicalize = (career, resume, kit = authorityKit(career)) => canonicalizeHostOwnedResumeFields(resume, {
  authority: kit.authority, acceptedEvidence: kit.acceptedEvidence, sourceRoles: kit.sourceRoles,
});

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

async function refuse(flow, forms) {
  const handoff = await flow.current();
  const result = await flow.submit(handoff, { resume: resumeFor(flow, forms) });
  return { accepted: result.accepted, errors: (result.validationErrors || []).join(' | '), correction: result.handoff?.correctionPrompt || '' };
}

export default [
  {
    name: 'Host-owned surface key: case, Unicode form, spacing, dash and quote variants are one value, and nothing else is',
    run: () => {
      for (const career of CAREERS) {
        for (const [unit, field, written, approved] of fieldRows(career)) {
          assert(sameHostOwnedValue(written, approved), `[${career.id}] ${unit}.${field}: ${J(written)} restates ${J(approved)} in another surface form`);
          assert(written !== approved, `[${career.id}] ${unit}.${field}: the variant must actually differ in bytes, or the test proves nothing`);
        }
        assert(sameHostOwnedValue(career.variant.eduDates, career.education.dates), `[${career.id}] a date range written with another dash is the same range`);
        for (const [field, different, approved] of [
          ['title', career.different.title, career.role.title], ['company', career.different.company, career.role.employer],
          ['dates', career.different.dates, approvedDates(career)], ['project', career.different.project, career.projects[0].name],
          ['credential', career.different.credential, career.education.credential], ['certification', career.different.certName, career.certification.name],
        ]) {
          assert(!sameHostOwnedValue(different, approved), `[${career.id}] ${field}: ${J(different)} is a different value from ${J(approved)}`);
        }
        const approved = career.projects[0].name;
        const lossy = [
          ['a dropped word', approved.split(' ').slice(1).join(' ')], ['an added word', `${approved} Plus`], ['a changed digit', `${approved} 2`],
          ['spacing inserted inside a word', approved.replace(/^(\S{3})/u, '$1 ')], ['reordered words', approved.split(' ').reverse().join(' ')],
          ['a hyphen where the approved text has a space', approved.replace(' ', '-')],
        ];
        for (const [what, value] of lossy) {
          assert(value !== approved && !sameHostOwnedValue(value, approved), `[${career.id}] ${what} (${J(value)}) is a different value from ${J(approved)}`);
        }
      }
      const accented = 'Dipl. in P\u00e2tisserie (Level-3)'; const plain = 'Dipl. in Patisserie (Level-3)';
      assert(!sameHostOwnedValue(plain, accented) && sameHostOwnedValue(accented.normalize('NFD'), accented), 'a missing accent is a different value, while a decomposed accent is the same character');
      assert(sameHostOwnedValue('  A   B  ', 'a b') && !sameHostOwnedValue('', 'a') && !sameHostOwnedValue(undefined, ''), 'empty and absent values never equal a non-empty or a missing one');
      assert(sameHostOwnedValue('2019 - 2021', `2019 ${EN} 2021`) && sameHostOwnedValue('x', 'x') && !sameHostOwnedValue('2019 - 2021', `2019-2021`), 'dash variants fold; spacing around a dash is not erased');
      assert(hostOwnedSurfaceKey(`a${String.fromCharCode(0x2019)}b`) === "a'b" && hostOwnedSurfaceKey(`${String.fromCharCode(0x201C)}q${String.fromCharCode(0x201D)}`) === '"q"', 'typographic quotes fold to straight quotes');
    },
  },
  {
    name: 'Host canonicalization writes the approved text of every host-owned field, for three unrelated careers, without touching the response it was given',
    run: () => {
      for (const career of CAREERS) {
        const kit = authorityKit(career);
        const written = deepFreeze(unitResume(career, { ...variantForms(career), eduDates: career.variant.eduDates }));
        const { resume, events } = canonicalize(career, written, kit);
        const approved = unitResume(career);
        assert(J(resume) === J(approved), `[${career.id}] every host-owned field is the approved text:\n${J(resume)}\n${J(approved)}`);
        assert(resume !== written && written.roles[0].title === career.variant.title, `[${career.id}] the response is copied, never mutated`);
        assert(resume.roles[0].bullets === written.roles[0].bullets && resume.skills === written.skills, `[${career.id}] untouched parts are shared, not rebuilt`);
        const expectedFields = new Set(['role.title', 'role.company', 'role.dates', 'project.name', 'education.credential', 'education.institution', 'education.dates', 'credential.name', 'credential.issuer']);
        assert(events.length === expectedFields.size && events.every(event => expectedFields.has(`${event.unit}.${event.field}`)), `[${career.id}] exactly the restated fields are rewritten (${events.map(event => `${event.unit}.${event.field}`)})`);
        const again = canonicalize(career, resume, kit);
        assert(again.resume === resume && again.events.length === 0, `[${career.id}] canonicalization is idempotent`);
        const untouched = canonicalize(career, approved, kit);
        assert(untouched.resume === approved && untouched.events.length === 0, `[${career.id}] an already-approved résumé is returned as is, with nothing recorded`);
        // A single restated field rewrites that field only.
        for (const [unit, field, form, approvedValue] of fieldRows(career)) {
          const key = unit === 'role' ? field : unit === 'project' ? 'project' : unit === 'education' ? field : field === 'name' ? 'certName' : 'certIssuer';
          const one = canonicalize(career, unitResume(career, { [key]: form }), kit);
          assert(one.events.length === 1 && one.events[0].unit === unit && one.events[0].field === field, `[${career.id}] ${unit}.${field} alone yields one event`);
          assert(J(one.resume) === J(approved), `[${career.id}] ${unit}.${field}: ${J(form)} became ${J(approvedValue)}`);
        }
      }
    },
  },
  {
    name: 'Host canonicalization records a typed event per rewritten field carrying hashes only, never text',
    run: () => {
      for (const career of CAREERS) {
        const written = unitResume(career, { ...variantForms(career), eduDates: career.variant.eduDates });
        const { events } = canonicalize(career, written);
        assert(events.length === 9, `[${career.id}] nine fields were restated`);
        for (const event of events) {
          assert(event.type === HOST_FIELD_CANONICALIZED_EVENT && event.document === 'resume'
            && ['role', 'project', 'education', 'credential'].includes(event.unit) && typeof event.unitId === 'string' && typeof event.field === 'string'
            && /^[a-f0-9]{64}$/u.test(event.fromSha256) && /^[a-f0-9]{64}$/u.test(event.toSha256) && event.fromSha256 !== event.toSha256
            && Object.keys(event).sort().join(',') === 'document,field,fromSha256,toSha256,type,unit,unitId', `[${career.id}] a typed, closed-shape event: ${J(event)}`);
        }
        const byField = Object.fromEntries(events.map(event => [`${event.unit}.${event.field}`, event]));
        for (const [unit, field, form, approved] of fieldRows(career)) {
          const event = byField[`${unit}.${field}`];
          assert(event.fromSha256 === hostOwnedValueSha256(form) && event.toSha256 === hostOwnedValueSha256(approved), `[${career.id}] ${unit}.${field}: the event hashes the written form and the approved form`);
        }
        const logged = J(events);
        for (const [, , form, approved] of fieldRows(career)) {
          assert(!logged.includes(J(form).slice(1, -1)) && !logged.includes(J(approved).slice(1, -1)), `[${career.id}] the event carries no text of either form`);
        }
      }
    },
  },
  {
    name: 'Host canonicalization never decides the entity: ambiguous, wrongly typed, unknown, listing-only and repeated references are left alone',
    run: () => {
      for (const career of CAREERS) {
        const kit = authorityKit(career);
        const [first, second] = career.projects;
        const projectEvidence = project => `host.career.project.${project.id}.1`;
        const untouched = (resume, why) => {
          const result = canonicalize(career, resume, kit);
          assert(result.resume === resume && result.events.length === 0, `[${career.id}] ${why}: nothing is rewritten`);
        };
        // Whichever project the writer names and whichever order it cites them in, two projects are never one entity.
        for (const named of [first, second]) {
          const nameVariant = named === first ? career.variant.project : second.name.toUpperCase();
          untouched(unitResume(career, { project: nameVariant, projectEvidenceIds: [projectEvidence(first), projectEvidence(second), 'p1-listing'] }), `evidence resolving to two projects (${named.id}, first cited first)`);
          untouched(unitResume(career, { project: nameVariant, projectEvidenceIds: [projectEvidence(second), projectEvidence(first), 'p1-listing'] }), `evidence resolving to two projects (${named.id}, second cited first)`);
        }
        untouched(unitResume(career, { project: career.variant.project, projectEvidenceIds: [projectEvidence(first), `host.career.achievement.achievement-${career.id}.1`] }), 'a project citing an achievement as well');
        untouched(unitResume(career, { project: career.variant.project, projectEvidenceIds: [`host.career.education.${career.education.id}.1`] }), 'a project citing an education record');
        untouched(unitResume(career, { project: career.variant.project, projectEvidenceIds: ['host.career.project.not-a-project.1'] }), 'a project citing an evidence id the authority does not know');
        untouched(unitResume(career, { project: career.variant.project, projectEvidenceIds: ['p1-listing'] }), 'a project citing the posting only');
        untouched(unitResume(career, { project: career.variant.project, projectEvidenceIds: [] }), 'a project citing nothing');
        // The cited evidence decides which approved project this is, whatever the name says: a name that restates a
        // DIFFERENT project is a different value for the cited one, so it is neither rewritten nor used to pick the entity.
        untouched(unitResume(career, { project: second.name.toUpperCase(), projectEvidenceIds: [projectEvidence(first), 'p1-listing'] }), 'a name that restates another project');
        const reversed = canonicalize(career, unitResume(career, { project: first.name.toUpperCase(), projectEvidenceIds: [projectEvidence(second), 'p1-listing'] }), kit);
        assert(reversed.events.length === 0 && reversed.resume.projects[0].name === first.name.toUpperCase(), `[${career.id}] the first project's name on the second project's evidence is left for the validator`);
        const education = unitResume(career, { credential: career.variant.credential });
        education.education[0].evidenceIds = [`host.career.education.${career.education.id}.1`, `host.career.certification.${career.certification.id}.1`];
        untouched(education, 'an education item citing a certification');
        const duplicated = unitResume(career, { title: career.variant.title });
        duplicated.roles = [duplicated.roles[0], { ...duplicated.roles[0], bullets: [] }];
        untouched(duplicated, 'a role id the response repeats');
        const unknownRole = unitResume(career, { title: career.variant.title });
        unknownRole.roles[0] = { ...unknownRole.roles[0], id: 'role-the-snapshot-never-had' };
        untouched(unknownRole, 'a role id the snapshot does not hold');
        untouched(unitResume(career, { title: 7, project: null }), 'non-string values');
        // An authority-less job has only the role catalog to snap against.
        const roleOnly = canonicalizeHostOwnedResumeFields(unitResume(career, variantForms(career)), { authority: null, acceptedEvidence: kit.acceptedEvidence, sourceRoles: kit.sourceRoles });
        assert(roleOnly.events.every(event => event.unit === 'role') && roleOnly.events.length === 3 && roleOnly.resume.projects[0].name === career.variant.project,
          `[${career.id}] without an authority only role title/company/dates are written; project and credential text is left as the writer sent it`);
      }
    },
  },
  {
    name: 'Host canonicalization leaves a genuinely different value for the validators, and a different value never becomes the approved one',
    run: () => {
      for (const career of CAREERS) {
        const kit = authorityKit(career);
        const different = career.different;
        for (const forms of [{ title: different.title }, { company: different.company }, { dates: different.dates }, { project: different.project }, { credential: different.credential }, { certName: different.certName }]) {
          const resume = unitResume(career, forms);
          const result = canonicalize(career, resume, kit);
          assert(result.resume === resume && result.events.length === 0, `[${career.id}] ${J(forms)}: a different value is not rewritten`);
        }
        // Restating most fields in another surface form does not launder one different field.
        const mixed = canonicalize(career, unitResume(career, { ...variantForms(career), project: different.project }), kit);
        assert(mixed.resume.projects[0].name === different.project && mixed.resume.roles[0].title === career.role.title && mixed.events.length === 7,
          `[${career.id}] the seven restated fields are written and the different project name is left to be refused`);
      }
      const empty = canonicalizeHostOwnedResumeFields({ roles: [{ id: 'r', title: 'Analyst', dates: '2020 - 2021' }] }, { sourceRoles: [{ id: 'r', title: 'Analyst', company: '', dates: `2020 ${EN} 2021`, location: '' }] });
      assert(empty.resume.roles[0].company === '' && empty.resume.roles[0].dates === `2020 ${EN} 2021` && empty.events.length === 2
        && empty.events.find(event => event.field === 'company').fromSha256 === null, 'an omitted company the approved role leaves empty is written empty (recorded without a from-hash), and the dash is written');
      const located = canonicalizeHostOwnedResumeFields({ roles: [{ id: 'r', title: 'Analyst', company: 'Acme', dates: '2020', location: 'austin, tx' }] }, { sourceRoles: [{ id: 'r', title: 'Analyst', company: 'Acme', dates: '2020', location: 'Austin, TX' }] });
      const invented = canonicalizeHostOwnedResumeFields({ roles: [{ id: 'r', title: 'Analyst', company: 'Acme', dates: '2020', location: 'Austin' }] }, { sourceRoles: [{ id: 'r', title: 'Analyst', company: 'Acme', dates: '2020', location: '' }] });
      assert(located.resume.roles[0].location === 'Austin, TX' && invented.events.length === 0 && invented.resume.roles[0].location === 'Austin',
        'a restated location is written as approved; a location the approved role does not carry is never written or removed here');
    },
  },
  {
    name: 'The authority gate still demands the exact text, and its refusal names the approved text for role, project, education and credential',
    run: () => {
      for (const career of CAREERS) {
        const kit = authorityKit(career);
        const validate = resume => __validateAuthorityResumeArtifactsForTests(resume, kit.acceptedEvidence, kit.authority, kit.sourceRoles);
        assert(validate(unitResume(career)).length === 0, `[${career.id}] the approved forms pass the gate`);
        assert(validate(unitResume(career, variantForms(career))).length > 0, `[${career.id}] the gate itself stays exact: it is the host's canonicalization, not a looser gate, that admits another surface form`);
        const cases = [
          [{ title: career.different.title }, expectedClause('title', career.role.title)],
          [{ company: career.different.company }, expectedClause('company', career.role.employer)],
          [{ dates: career.different.dates }, expectedClause('dates', approvedDates(career))],
          [{ project: career.different.project }, expectedClause('name', career.projects[0].name)],
          [{ credential: career.different.credential }, expectedClause('credential', career.education.credential)],
          [{ certName: career.different.certName }, expectedClause('name', career.certification.name)],
        ];
        for (const [forms, clause] of cases) {
          const errors = validate(unitResume(career, forms));
          assert(errors.length === 1 && errors[0].includes(clause), `[${career.id}] ${J(forms)} is refused and says ${clause} (got ${J(errors)})`);
        }
        const several = validate(unitResume(career, { title: career.different.title, dates: career.different.dates })).join(' ');
        assert(several.includes(expectedClause('title', career.role.title)) && several.includes(expectedClause('dates', approvedDates(career))) && !several.includes('company expected'),
          `[${career.id}] one role refusal names every differing field and only those`);
        // The existing leniency stays: a field that occurs in its cited record is not required to equal the whole record field.
        const partial = unitResume(career, { credential: career.education.credential.split(' ').slice(0, 2).join(' ') });
        assert(validate(partial).length === 0, `[${career.id}] an education field that still occurs in its cited evidence is accepted as before`);
        assert(boundedExpectedValue('x'.repeat(HOST_OWNED_EXPECTED_VALUE_MAX_CHARS + 50)).length <= HOST_OWNED_EXPECTED_VALUE_MAX_CHARS + 3
          && boundedExpectedValue('x'.repeat(HOST_OWNED_EXPECTED_VALUE_MAX_CHARS + 50)).endsWith(`${String.fromCharCode(0x2026)}"`), 'an over-long approved value is cut at a fixed bound');
      }
    },
  },
  {
    name: 'A role location is host-owned too: a restated location is written as approved and a different one is refused with the approved text',
    run: () => {
      const places = { freight: ['Port Alder, WA', 'Port Alder, OR'], structural: ['KESTREL FALLS, CO', 'KESTREL FALLS, UT'], pastry: ['Saint-Émile (Old Town)', 'Saint-Émile (New Town)'] };
      for (const career of CAREERS) {
        const [approvedPlace, otherPlace] = places[career.id];
        const snapshot = snapshotOf(career); snapshot.profile.roles[0].location = approvedPlace;
        const authority = buildApplicationCareerAuthority(snapshot);
        const acceptedEvidence = [...approvedCareerEvidenceCatalog(snapshot), { id: 'p1-listing', sourceId: 'job-listing', quote: listing(career) }];
        const withLocation = location => ({ ...unitResume(career), roles: [{ ...unitResume(career).roles[0], location }] });
        const restated = canonicalizeHostOwnedResumeFields(withLocation(approvedPlace.toLowerCase().replace('-', String.fromCharCode(0x2010))), { authority, acceptedEvidence, sourceRoles: authority.sourceRoles });
        assert(restated.resume.roles[0].location === approvedPlace && restated.events.length === 1 && restated.events[0].field === 'location', `[${career.id}] a restated location is written as approved`);
        const validate = resume => __validateAuthorityResumeArtifactsForTests(resume, acceptedEvidence, authority, authority.sourceRoles);
        assert(validate(withLocation(approvedPlace)).length === 0, `[${career.id}] the approved location passes the gate`);
        const refused = validate(withLocation(otherPlace));
        assert(refused.length === 1 && refused[0].includes(expectedClause('location', approvedPlace)), `[${career.id}] a different location is refused with the approved location (got ${J(refused)})`);
      }
    },
  },
  {
    name: 'The host canonicalizes a parsed résumé at the résumé and review stages only, and only when the response carries one',
    run: async () => {
      const { __canonicalizeParsedResumeForHostForTests } = await import('../../electron/ipc/localAiApplication.js');
      for (const career of CAREERS) {
        const kit = authorityKit(career);
        const input = { sourceRoles: kit.sourceRoles, careerAuthority: { snapshotDigest: 'digest' }, __careerAuthorityIndex: kit.authority };
        const parsed = { protocol: 1, stage: 'resume', resume: unitResume(career, variantForms(career)) };
        const stateOf = stage => ({ stage, evidencePlan: { evidence: kit.acceptedEvidence } });
        const resumeStage = __canonicalizeParsedResumeForHostForTests(parsed, stateOf('resume'), input);
        const reviewStage = __canonicalizeParsedResumeForHostForTests({ ...parsed, stage: 'review' }, stateOf('review'), input);
        assert(resumeStage.events.length === 8 && J(resumeStage.parsed.resume) === J(unitResume(career)), `[${career.id}] the résumé stage rewrites the response to the approved text`);
        assert(resumeStage.parsed !== parsed && parsed.resume.roles[0].title === career.variant.title && resumeStage.parsed.protocol === 1 && resumeStage.parsed.stage === 'resume',
          `[${career.id}] the rest of the envelope is carried over and the writer's object is untouched`);
        assert(/^[a-f0-9]{64}$/u.test(resumeStage.originalSha256), `[${career.id}] the writer's own response is hashed for the log`);
        assert(reviewStage.events.length === 8 && reviewStage.parsed.resume.roles[0].title === career.role.title, `[${career.id}] a review replacement résumé is canonicalized the same way`);
        for (const stage of ['cover-letter', 'evidence-plan', 'requirements', 'blind-review']) {
          const other = __canonicalizeParsedResumeForHostForTests({ ...parsed, stage }, stateOf(stage), input);
          assert(other.parsed.resume === parsed.resume && other.events.length === 0, `[${career.id}] stage ${stage} is not canonicalized`);
        }
        const noResume = __canonicalizeParsedResumeForHostForTests({ protocol: 1, stage: 'review', decision: 'pass' }, stateOf('review'), input);
        assert(noResume.events.length === 0 && noResume.parsed.decision === 'pass', `[${career.id}] a passing review carries no résumé and is untouched`);
      }
    },
  },

  ...CAREERS.map(career => ({
    name: `Real résumé stage [${career.id}]: a different value is refused with the approved text, the entity follows the evidence, and a restated surface form is written as approved`,
    run: async () => {
      const snapshotId = await writeSnapshot(career);
      const flow = await createResumeStageFlow(career, snapshotId);
      const control = await createResumeStageFlow(career, snapshotId);
      try {
        assert(flow.obligation?.projectId === career.projects[0].id, `[${career.id}] the first project is the host-required project (${J(flow.obligation)})`);
        assert(/app writes them itself/u.test(flow.resumeHandoff.prompt) && /states the exact approved text/u.test(flow.resumeHandoff.prompt),
          `[${career.id}] the résumé contract tells the writer the host writes these fields and what a refusal contains`);
        // 1. Genuinely different values: refused, and the refusal that reaches the writer states the approved text.
        const refusals = [
          ['title', { title: career.different.title }, expectedClause('title', career.role.title)],
          ['company', { company: career.different.company }, expectedClause('company', career.role.employer)],
          ['dates', { dates: career.different.dates }, expectedClause('dates', approvedDates(career))],
          ['project name', { project: career.different.project }, expectedClause('name', career.projects[0].name)],
          ['education credential', { credential: career.different.credential }, expectedClause('credential', career.education.credential)],
          ['credential name', { certName: career.different.certName }, expectedClause('name', career.certification.name)],
        ];
        for (const [label, forms, clause] of refusals) {
          const result = await refuse(flow, forms);
          assert(!result.accepted && result.errors.includes(clause), `[${career.id}] a different ${label} is refused with ${clause} (got ${result.errors})`);
          assert(result.correction.includes(clause), `[${career.id}] the correction the writer reads for a different ${label} states the approved text`);
        }
        // 2. Other fields restated in another surface form are written by the host, so they are not what the refusal is about.
        const mixed = await refuse(flow, { ...variantForms(career), project: career.different.project });
        assert(!mixed.accepted && mixed.errors.includes(expectedClause('name', career.projects[0].name))
          && !mixed.errors.includes(expectedClause('title', career.role.title)) && !mixed.errors.includes('trusted authority role')
          && !mixed.errors.includes(expectedClause('credential', career.education.credential)),
        `[${career.id}] only the genuinely different field is refused (got ${mixed.errors})`);
        // 3. The cited evidence decides the entity, never the name.
        const second = career.projects[1]; const secondEvidence = flow.evidence.projects[second.id][0];
        assert(secondEvidence, `[${career.id}] the second project is selectable evidence`);
        const ambiguous = await refuse(flow, { project: career.variant.project, projectEvidenceIds: [flow.obligation.evidenceId, secondEvidence, 'p1-listing'] });
        assert(!ambiguous.accepted && ambiguous.errors.includes('Project evidence must resolve to one exact approved project.') && !ambiguous.errors.includes('expected exactly'),
          `[${career.id}] evidence resolving to two projects is refused as ambiguous and nothing is snapped (got ${ambiguous.errors})`);
        const otherEntity = await refuse(flow, { project: career.variant.project, projectEvidenceIds: [secondEvidence, 'p1-listing'] });
        assert(!otherEntity.accepted && otherEntity.errors.includes(expectedClause('name', second.name)),
          `[${career.id}] a name that restates the FIRST project, on the SECOND project's evidence, is refused with the second project's name (got ${otherEntity.errors})`);
        const midManifest = await flow.manifest();
        assert(midManifest.paste.stage === 'resume' && !midManifest.paste.resume
          && !(await flow.logEvents()).some(event => event.stage === 'resume' && event.type === 'paste-accepted'),
        `[${career.id}] no refusal advanced the job or logged an acceptance`);

        // 4. The restated surface forms are accepted and stored as the approved text.
        const written = resumeFor(flow, variantForms(career));
        const accepted = await flow.submit(await flow.current(), { resume: written });
        assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter', `[${career.id}] the restated forms are accepted (${J(accepted.validationErrors || [])})`);
        const manifest = await flow.manifest(); const stored = manifest.paste.resume;
        const approvedResume = resumeFor(flow);
        assert(J(stored) === J(approvedResume), `[${career.id}] the stored résumé is the approved text end to end:\n${J(stored)}\n${J(approvedResume)}`);
        const draft = JSON.parse(await fs.promises.readFile(path.join(flow.queued.folder, 'drafts', `${String(manifest.paste.revision).padStart(5, '0')}-resume.json`), 'utf8'));
        assert(J(draft.resume) === J(approvedResume), `[${career.id}] the persisted draft is the approved text, not the writer's form`);

        // 5. The Generation Log records the rewrite as typed events carrying hashes only.
        const events = await flow.logEvents(); const last = events[events.length - 1];
        assert(last.type === 'paste-accepted' && last.stage === 'resume' && Array.isArray(last.hostCanonicalizations) && last.hostCanonicalizations.length === 8, `[${career.id}] the accepted resume event carries eight typed canonicalizations (${J(last.hostCanonicalizations)})`);
        const logged = new Map(last.hostCanonicalizations.map(event => [`${event.unit}.${event.field}`, event]));
        for (const [unit, field, form, approved] of fieldRows(career)) {
          const event = logged.get(`${unit}.${field}`);
          assert(event?.type === HOST_FIELD_CANONICALIZED_EVENT && event.fromSha256 === hostOwnedValueSha256(form) && event.toSha256 === hostOwnedValueSha256(approved),
            `[${career.id}] ${unit}.${field} is recorded with the hashes of the form written and the form stored`);
        }
        assert(/^[a-f0-9]{64}$/u.test(last.originalResponseSha256) && last.originalResponseSha256 !== last.responseSha256, `[${career.id}] the writer's own response hash is kept beside the stored response hash`);
        const text = await flow.logText();
        for (const [, , form, approved] of fieldRows(career)) {
          const literal = J(form).slice(1, -1);
          assert(!text.includes(literal) || J(approved).includes(literal), `[${career.id}] the log never carries the written form ${J(form)} as text`);
        }
        assert(!JSON.stringify(last.hostCanonicalizations).includes(career.role.title), `[${career.id}] the events name no approved text either`);

        // 6. Control: the very same job answered with the approved text from the start is indistinguishable downstream.
        const controlAccepted = await control.submit(control.resumeHandoff, { resume: resumeFor(control) });
        assert(controlAccepted.accepted, `[${career.id}] the control résumé is accepted (${J(controlAccepted.validationErrors || [])})`);
        const controlLast = (await control.logEvents()).at(-1);
        assert(controlLast.type === 'paste-accepted' && !('hostCanonicalizations' in controlLast) && !('originalResponseSha256' in controlLast), `[${career.id}] a response that needed no rewrite logs none`);
        const [nextA, nextB] = [await flow.current(), await control.current()];
        const [resumeA, resumeB] = [flow.contextOf(nextA).resume, control.contextOf(nextB).resume];
        assert(J(resumeA) === J(resumeB), `[${career.id}] the next stage reads the same résumé in both jobs`);
        assert(nextA.baseHashes.resume && nextA.baseHashes.resume === nextB.baseHashes.resume, `[${career.id}] the document hash every later stage binds is the hash of the canonical text (${nextA.baseHashes.resume} vs ${nextB.baseHashes.resume})`);
        assert(J((await control.manifest()).paste.resume) === J(stored), `[${career.id}] stored résumés are identical`);
      } finally {
        await flow.cleanup(); await control.cleanup();
      }
    },
  })),
  {
    name: 'Real résumé stage with no career authority (legacy source roles): a restated role title, company and dates are written as approved, and a different one is refused with the approved text',
    run: async () => {
      for (const career of CAREERS) {
        const project = await kit.createCanvasProject();
        try {
          const careerData = `${career.name}\n${career.email}\n${career.role.title} profile\n\n## ${career.role.employer}\n${career.role.title}\n${approvedDates(career)}\n\n${career.bullet}`;
          const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: project.canvasFilePath, careerData,
            job: { title: 'Reporting Engineer', company: 'Acme' },
            resumeProfile: { workHistory: [{ id: career.role.id, title: career.role.title, employer: career.role.employer, startDate: career.role.start, endDate: career.role.end }] } });
          const current = async () => (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath })).handoff;
          const submit = (handoff, fields) => submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: project.canvasFilePath, handoffCode: handoff.handoffCode,
            response: JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields }) });
          const plan = await submit(await current(), {
            identity: { name: career.name, contact: [career.email] },
            evidence: [
              { id: 'career-proof', sourceId: 'career-data', quote: career.bullet, requirement: 'Reporting systems', priority: 'highest' },
              { id: 'job-proof', sourceId: 'job-listing', quote: '# Reporting Engineer', requirement: 'Reporting systems', priority: 'highest' },
            ],
            requirements: [{ id: 'need-1', text: 'Reporting systems', priority: 'highest', evidenceIds: ['career-proof', 'job-proof'] }],
          });
          assert(plan.accepted && plan.handoff?.stage === 'resume', `[${career.id}] the legacy evidence plan opens the résumé stage (${J(plan.validationErrors || [])})`);
          const resumeOf = forms => ({ schemaVersion: 'structured-resume.v1', identity: { name: career.name, contact: [career.email] },
            roles: [{ id: career.role.id, title: forms.title ?? career.role.title, company: forms.company ?? career.role.employer, dates: forms.dates ?? approvedDates(career), location: '',
              bullets: [{ id: 'bullet-1', text: career.bullet, evidenceIds: ['career-proof'] }] }] });
          const refused = await submit(await current(), { resume: resumeOf({ ...variantForms(career), title: career.different.title }) });
          assert(!refused.accepted && refused.validationErrors.join(' | ').includes(`roles[0].title must exactly match its trusted source role; expected exactly: ${J(career.role.title)}`),
            `[${career.id}] a different title is refused with the approved title (got ${J(refused.validationErrors)})`);
          const accepted = await submit(await current(), { resume: resumeOf(variantForms(career)) });
          assert(accepted.accepted && accepted.handoff?.stage === 'cover-letter', `[${career.id}] the restated role fields are accepted (${J(accepted.validationErrors || [])})`);
          const stored = (JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'))).paste.resume.roles[0];
          assert(stored.title === career.role.title && stored.company === career.role.employer && stored.dates === approvedDates(career), `[${career.id}] the stored role is the approved text (${J(stored)})`);
          const events = (await fs.promises.readFile(path.join(queued.folder, 'Generation Log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
          assert(events.at(-1).hostCanonicalizations?.length === 3 && events.at(-1).hostCanonicalizations.every(event => event.unit === 'role'), `[${career.id}] three role fields are recorded`);
        } finally {
          await fs.promises.rm(project.root, { recursive: true, force: true });
        }
      }
    },
  },
];
