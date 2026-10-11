// Adaptability family: CANDIDATE-VS-NON-CANDIDATE RELATIONSHIPS.
//
// An employer technology, an evaluated product, a possible implementation
// option, an example, or a third-party integration is not automatically a
// candidate skill. This file drives only synthetic, unrelated career sources
// (a clinic nurse, a pastry chef, a structural engineer, a data analyst, a
// warehouse supervisor, a software engineer) through the REAL production path:
//
//   source text -> buildCareerSourceCorpus -> compileAuditedCareerSnapshot
//     -> validateCareerProfile / validateCurrentCareerSnapshot
//     -> vettedCareerSkillInventory / projectApprovedCareerSnapshotForApplication
//     -> approvedCareerEvidenceCatalog / buildApplicationCareerAuthority
//     -> snapshot skill evidence -> validateStructuredApplicationResume
//     (plus, in one isolated test, the interview-helper projection and extractor)
//
// THE ONE TEST-SIDE STAND-IN. Production deliberately leaves the *semantic*
// reading of a sentence ("evaluated" vs "operated", "owns" vs "uses") to the
// model that compiles the snapshot and to the independent auditor. A hermetic
// test has no model, so `standInShard` plays the compiling model: it reads each
// source line with a small sentence grammar and emits the ledger a competent
// model would (disposition, relationship, relationship group, literal
// relationship evidence, direct-evidence segments). It is a pure function of
// the source text; edit the sentence and its reading changes. Everything
// downstream of it is production code that must verify, reject, project, and
// enforce that ledger. No allow/deny list for a technology is stored in this
// file: each verdict is read back from what the production seams make of the
// CURRENT source. (KIND_SPECS states the project-level meaning of each
// SENTENCE kind, i.e. the invariant under test, never a production behavior.)
//
// WHAT THE DEFAULT EXPORT CAN AND CANNOT PROVE. Because the sentence reading
// belongs to the model, these tests prove that production (a) verifies the
// ledger the model emits against the literal source at two stages (the page
// handoff and the assembled profile), (b) never promotes a non-skill or
// relationship-qualified record into any application seam, (c) follows the
// CURRENT source text across recompiles (flip, add, remove, restore), (d)
// refuses to let later repair batches or post-approval edits undo a
// correction, and (e) refuses stale or forged ledgers. They do not and cannot
// prove that production itself reads "evaluated" as non-use; that is the
// model-and-audit lane (the deterministic cross-checks that were missing are the
// `[fixed defect]` tests). Every rejection below asserts the specific production
// reason, so a rejection for an unrelated cause cannot pass.
//
// Gaps found while writing this family were production defects; they have been
// fixed and their assertions are the tests tagged `[fixed defect]` (the comment above
// each describes the defect as it was before the fix). The named export
// `knownGaps` (not run by the registry) is empty.
import { assert } from './testHelpers.js';
import {
  CAREER_SNAPSHOT_TECHNOLOGY_RELATIONSHIPS,
  approvedCareerEvidenceCatalog,
  buildCareerProfileAuditPrompt,
  buildCareerSourceCorpus,
  careerSnapshotId,
  compileAuditedCareerSnapshot,
  isCareerSkillIndexEligible,
  partitionCareerSourcePages,
  projectApprovedCareerSnapshotForApplication,
  projectLegacyCareerProfile,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
  vettedCareerSkillInventory,
} from '../../electron/ipc/careerSnapshot.js';
import {
  buildApplicationCareerAuthority,
  resolveAuthoritySkill,
  validateAuthorityRoleEvidence,
  validateAuthoritySkillGroup,
} from '../../electron/ipc/applicationCareerAuthority.js';
import { validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { __snapshotCareerSkillEvidenceForTests } from '../../electron/ipc/localAiApplication.js';

// ---------------------------------------------------------------------------
// Synthetic candidates. Nothing here is real, and nothing in production may
// ever learn these strings. `label` is the technology under test, `other` a
// second, unrelated technology from the same domain, `extra` a third one used
// only as an untouched bystander, and `site` a place/feed/environment noun that
// occurs literally inside `condition` (a label a careless reader could wrongly
// promote to a skill).
// ---------------------------------------------------------------------------
const PROFILES = [
  {
    key: 'nurse', project: 'Marlowe', name: 'Maren Ostrowski', email: 'maren.ostrowski@example.test',
    title: 'Registered Nurse', employer: 'Larkspur Community Clinic', start: 'March 2019', end: 'Present',
    label: 'portable ultrasound unit', other: 'bedside glucose analyzer', extra: 'handheld pulse oximeter',
    purpose: 'scan patients under physician order', condition: 'the treatment room was booked', site: 'treatment room', cadence: 'each morning',
    duty: 'Taught new colleagues the ward handover checklist.',
    listing: 'Community clinic seeking a nurse with hands-on portable ultrasound unit experience.',
  },
  {
    key: 'chef', project: 'Tessera', name: 'Odalys Brennecke', email: 'odalys.brennecke@example.test',
    title: 'Pastry Chef', employer: 'Harrow Street Bakery', start: 'June 2017', end: 'August 2024',
    label: 'spiral dough mixer', other: 'sheeting roller', extra: 'blast chiller',
    purpose: 'mix laminated dough for the morning bake', condition: 'the proofing room was full', site: 'proofing room', cadence: 'every shift',
    duty: 'Trained apprentices on allergen labelling and bench hygiene.',
    listing: 'Artisan bakery hiring a pastry chef, spiral dough mixer experience required.',
  },
  {
    key: 'engineer', project: 'Quillwork', name: 'Teodor Lindqvist', email: 'teodor.lindqvist@example.test',
    title: 'Structural Engineer', employer: 'Tessellate Structural Group', start: 'January 2016', end: 'Present',
    label: 'finite element solver', other: 'frame analysis package', extra: 'load combination spreadsheet',
    purpose: 'check floor beam deflection', condition: 'the site office was offline', site: 'site office', cadence: 'at each design freeze',
    duty: 'Reviewed junior engineers calculation packages before client release.',
    listing: 'Structural consultancy needs an engineer who has run a finite element solver on steel frames.',
  },
  {
    key: 'analyst', project: 'Brindlewick', name: 'Priyanka Valdemar', email: 'priyanka.valdemar@example.test',
    title: 'Data Analyst', employer: 'Brindle Retail Analytics', start: 'September 2020', end: 'Present',
    label: 'cohort dashboard builder', other: 'survey panel portal', extra: 'query notebook',
    purpose: 'track weekly customer retention', condition: 'the warehouse export was late', site: 'warehouse export', cadence: 'every Monday',
    duty: 'Presented quarterly retention findings to the merchandising team.',
    listing: 'Retail analytics team looking for an analyst proficient with a cohort dashboard builder.',
  },
  {
    key: 'warehouse', project: 'Harborlight', name: 'Casimir Oyelaran', email: 'casimir.oyelaran@example.test',
    title: 'Warehouse Supervisor', employer: 'Quillfeather Distribution', start: 'April 2018', end: 'Present',
    label: 'pallet wrapping robot', other: 'voice pick headset', extra: 'label printer',
    purpose: 'wrap outbound pallets on the night shift', condition: 'the dock schedule slipped', site: 'dock schedule', cadence: 'before every dispatch',
    duty: 'Scheduled rotating shift coverage for a crew of twenty.',
    listing: 'Distribution centre supervisor wanted; pallet wrapping robot operation is a plus.',
  },
  {
    key: 'software', project: 'Foxglove', name: 'Ilse Marchetti', email: 'ilse.marchetti@example.test',
    title: 'Software Engineer', employer: 'Nordvane Payments', start: 'July 2019', end: 'Present',
    label: 'message broker', other: 'job scheduler', extra: 'log shipper',
    purpose: 'fan out settlement events', condition: 'the staging environment was frozen', site: 'staging environment', cadence: 'during every release',
    duty: 'Wrote the on-call runbook for the settlement service.',
    listing: 'Payments platform team seeking an engineer experienced with a message broker.',
  },
];

// ---------------------------------------------------------------------------
// Sentence grammar. `make` writes a source sentence; `read` is how the
// stand-in compiling model understands one. Each `read` returns ledger
// intents { label, disposition, relationship, slice, reason? }, where `slice`
// is the narrowest literal span that establishes the relationship.
// ---------------------------------------------------------------------------
const NON_SKILL_REASONS = {
  evaluated: 'An evaluated product the candidate did not adopt is not demonstrated candidate capability.',
  employer: 'A system the employer owns and others operate is organization-owned, not candidate capability.',
  option: 'An implementation option that was never selected was not used by the candidate.',
  example: 'An illustrative example of comparable equipment is not something the candidate used.',
  vendor: 'A vendor-supplied offering the candidate only connected to is an external object, not candidate capability.',
};

const SENTENCES = {
  operated: {
    make: (t, p) => `Operated the ${t} to ${p}.`,
    read: line => {
      const m = /^Operated the (.+?) to (.+)\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'skill', relationship: 'independent', slice: line }];
    },
  },
  evaluated: {
    make: (t, p) => `Evaluated the ${t} to ${p}, but the team did not adopt it.`,
    read: line => {
      const m = /^Evaluated the (.+?) to (.+), but the team did not adopt it\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'non-skill', relationship: 'independent', slice: line, reason: NON_SKILL_REASONS.evaluated }];
    },
  },
  employerOwned: {
    make: (t, org) => `The ${org} owns the ${t}, which other departments run.`,
    read: line => {
      const m = /^The (.+?) owns the (.+?), which other departments run\.$/u.exec(line);
      return m && [{ label: m[2], disposition: 'non-skill', relationship: 'independent', slice: line, reason: NON_SKILL_REASONS.employer }];
    },
  },
  employerUses: {
    make: (t, org, p) => `The ${org} uses the ${t} to ${p}.`,
    read: line => {
      const m = /^The (.+?) uses the (.+?) to (.+)\.$/u.exec(line);
      return m && [{ label: m[2], disposition: 'non-skill', relationship: 'independent', slice: line, reason: NON_SKILL_REASONS.employer }];
    },
  },
  option: {
    make: t => `A possible approach was the ${t}, which was never selected.`,
    read: line => {
      const m = /^A possible approach was the (.+?), which was never selected\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'non-skill', relationship: 'optional', slice: line, reason: NON_SKILL_REASONS.option }];
    },
  },
  example: {
    make: t => `Comparable sites use equipment such as the ${t}.`,
    read: line => {
      const m = /^Comparable sites use equipment such as the (.+?)\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'non-skill', relationship: 'independent', slice: line, reason: NON_SKILL_REASONS.example }];
    },
  },
  vendor: {
    // A third-party integration: the vendor object is not a skill, but the
    // thing the candidate connected to it is.
    make: (t, mine) => `Connected our ${mine} to the vendor-supplied ${t}.`,
    read: line => {
      const m = /^Connected our (.+?) to the vendor-supplied (.+?)\.$/u.exec(line);
      return m && [
        { label: m[1], disposition: 'skill', relationship: 'independent', slice: line },
        { label: m[2], disposition: 'non-skill', relationship: 'independent', slice: line, reason: NON_SKILL_REASONS.vendor },
      ];
    },
  },
  either: {
    make: (a, b, c) => `Used the ${a} or the ${b} depending on whether ${c}.`,
    read: line => {
      const m = /^Used the (.+?) or the (.+?) depending on whether (.+)\.$/u.exec(line);
      if (!m) return null;
      const slice = `the ${m[1]} or the ${m[2]}`;
      return [m[1], m[2]].map(label => ({ label, disposition: 'skill', relationship: 'alternative', slice }));
    },
  },
  whenAvailable: {
    make: t => `Used the ${t} when it was available.`,
    read: line => {
      const m = /^Used the (.+?) when it was available\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'skill', relationship: 'conditional', slice: `the ${m[1]} when it was available` }];
    },
  },
  optionalUse: {
    make: (t, p) => `Optionally used the ${t} to ${p}.`,
    read: line => {
      const m = /^Optionally used the (.+?) to (.+)\.$/u.exec(line);
      return m && [{ label: m[1], disposition: 'skill', relationship: 'optional', slice: `Optionally used the ${m[1]}` }];
    },
  },
  andOr: {
    make: (a, b) => `Worked with the ${a} and/or the ${b}.`,
    read: line => {
      const m = /^Worked with the (.+?) and\/or the (.+?)\.$/u.exec(line);
      if (!m) return null;
      const slice = `the ${m[1]} and/or the ${m[2]}`;
      return [m[1], m[2]].map(label => ({ label, disposition: 'skill', relationship: 'ambiguous', slice }));
    },
  },
  // A one-word minimal pair: the coordinator "or" makes a choice (nobody used both),
  // "and" states simultaneous use of both.
  orPair: {
    make: (a, b, p) => `Used the ${a} or the ${b} to ${p}.`,
    read: line => {
      const m = /^Used the (.+?) or the (.+?) to (.+)\.$/u.exec(line);
      if (!m) return null;
      const slice = `the ${m[1]} or the ${m[2]}`;
      return [m[1], m[2]].map(label => ({ label, disposition: 'skill', relationship: 'alternative', slice }));
    },
  },
  andPair: {
    make: (a, b, p) => `Used the ${a} and the ${b} to ${p}.`,
    read: line => {
      const m = /^Used the (.+?) and the (.+?) to (.+)\.$/u.exec(line);
      return m && [m[1], m[2]].map(label => ({ label, disposition: 'skill', relationship: 'independent', slice: line }));
    },
  },
  // One physical line states BOTH a direct use and a separate alternative.
  directPlusEither: {
    make: (a, b, cadence) => `Calibrated the ${a} (${cadence}); for overflow work, the ${a} or the ${b} was used.`,
    read: line => {
      const m = /^Calibrated the (.+?) \((.+?)\); for overflow work, the \1 or the (.+?) was used\.$/u.exec(line);
      if (!m) return null;
      const slice = `the ${m[1]} or the ${m[3]}`;
      return [m[1], m[3]].map(label => ({ label, disposition: 'skill', relationship: 'alternative', slice }));
    },
  },
  // The same alternative with the separate direct clause removed.
  overflowOnly: {
    make: (a, b) => `For overflow work, the ${a} or the ${b} was used.`,
    read: line => {
      const m = /^For overflow work, the (.+?) or the (.+?) was used\.$/u.exec(line);
      if (!m) return null;
      const slice = `the ${m[1]} or the ${m[2]}`;
      return [m[1], m[2]].map(label => ({ label, disposition: 'skill', relationship: 'alternative', slice }));
    },
  },
};

// What each sentence kind MEANS for the candidate, independent of production:
// which of its labels a candidate may be said to have as a standalone skill.
const KIND_SPECS = {
  operated: { line: p => SENTENCES.operated.make(p.label, p.purpose), accepted: p => [p.label], refused: () => [] },
  orPair: { line: p => SENTENCES.orPair.make(p.label, p.other, p.purpose), accepted: () => [], refused: p => [p.label, p.other] },
  andPair: { line: p => SENTENCES.andPair.make(p.label, p.other, p.purpose), accepted: p => [p.label, p.other], refused: () => [] },
  directPlusEither: { line: p => SENTENCES.directPlusEither.make(p.label, p.other, p.cadence), accepted: p => [p.label], refused: p => [p.other] },
  overflowOnly: { line: p => SENTENCES.overflowOnly.make(p.label, p.other), accepted: () => [], refused: p => [p.label, p.other] },
  vendor: { line: p => SENTENCES.vendor.make(p.label, p.other), accepted: p => [p.other], refused: p => [p.label] },
  evaluated: { line: p => SENTENCES.evaluated.make(p.label, p.purpose), accepted: () => [], refused: p => [p.label] },
  employerOwned: { line: p => SENTENCES.employerOwned.make(p.label, p.employer), accepted: () => [], refused: p => [p.label] },
  employerUses: { line: p => SENTENCES.employerUses.make(p.label, p.employer, p.purpose), accepted: () => [], refused: p => [p.label] },
  option: { line: p => SENTENCES.option.make(p.label), accepted: () => [], refused: p => [p.label] },
  example: { line: p => SENTENCES.example.make(p.label), accepted: () => [], refused: p => [p.label] },
  either: { line: p => SENTENCES.either.make(p.label, p.other, p.condition), accepted: () => [], refused: p => [p.label, p.other] },
  whenAvailable: { line: p => SENTENCES.whenAvailable.make(p.label), accepted: () => [], refused: p => [p.label] },
  optionalUse: { line: p => SENTENCES.optionalUse.make(p.label, p.purpose), accepted: () => [], refused: p => [p.label] },
  andOr: { line: p => SENTENCES.andOr.make(p.label, p.other), accepted: () => [], refused: p => [p.label, p.other] },
};
const NON_CANDIDATE_KINDS = ['evaluated', 'employerOwned', 'employerUses', 'option', 'example', 'vendor'];
const QUALIFIED_KINDS = ['either', 'whenAvailable', 'optionalUse', 'andOr'];
// Non-candidate kinds whose subject is the technology under test itself, so a
// genuine direct sentence about the same label is a meaningful flip.
const FLIPPABLE_KINDS = ['evaluated', 'employerOwned', 'employerUses', 'option', 'example'];

// ---------------------------------------------------------------------------
// Source text builders and the stand-in compiling model.
// ---------------------------------------------------------------------------
const SECOND_ROLE = ['Site Lead at Second Employer Works', 'May 2012 to December 2015'];

function careerText(profile, achievementLines) {
  return [
    profile.name,
    `${profile.title} at ${profile.employer}`,
    `${profile.start} to ${profile.end}`,
    profile.duty,
    ...achievementLines,
    profile.email,
  ].map(line => `${line}\n`).join('');
}

// Two roles; with pageMaxSegments 5 each role lands on its own source page.
function twoRoleText(profile, firstRoleLine, secondRoleLine) {
  return [
    profile.name, `${profile.title} at ${profile.employer}`, `${profile.start} to ${profile.end}`, profile.duty, firstRoleLine,
    ...SECOND_ROLE, secondRoleLine, profile.email,
  ].map(line => `${line}\n`).join('');
}

function sourceFiles(text) {
  return [{ name: 'Career Notes.md', text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
}

const DATE_LINE = /^[A-Z][a-z]+ \d{4} to (?:[A-Z][a-z]+ \d{4}|Present)$/u;
const EMAIL_LINE = /^\S+@example\.test$/u;
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
const wholeTerm = (text, term) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);

const PROJECT_LINE = /^Project ([A-Z][a-z]+): (.+)\.$/u;
const PROJECT_PATCH_LINE = /^The ([A-Z][a-z]+) project (.+)$/u;

// The stand-in compiling model. Pure function of one page of source segments
// (plus the host ids of projects opened on earlier pages, which a real model
// is handed as active context).
function standInShard(pageSegments, { projectIds = {} } = {}) {
  const lines = pageSegments.map(segment => ({ id: segment.id, text: segment.text.replace(/\r?\n$/u, '') }));
  const identity = { name: '', contacts: [], evidenceSegmentIds: [] };
  const roles = [];
  const achievements = [];
  const projects = [];
  const projectPatches = [];
  const skills = new Map();
  const coverage = [];
  let role = null;
  let groupSerial = 0;
  const readIntents = text => Object.values(SENTENCES).map(sentence => sentence.read(text)).find(Boolean) || [];
  // Turn ledger intents for one source line into technologies, technologyReferences, and skill rows.
  const applyIntents = (intents, line) => {
    const technologies = [];
    const technologyReferences = [];
    const sharedGroup = intents.length > 1 && intents.every(intent => intent.relationship !== 'independent') ? `choice-${++groupSerial}` : '';
    for (const intent of intents) {
      const relationshipGroup = intent.relationship === 'independent' ? '' : (sharedGroup || `${intent.relationship}-${++groupSerial}`);
      technologies.push(intent.label);
      technologyReferences.push({
        technology: intent.label, disposition: intent.disposition, relationship: intent.relationship, relationshipGroup,
        relationshipEvidence: intent.slice, evidenceSegmentIds: [line.id],
        ...(intent.disposition === 'non-skill' ? { nonSkillReason: intent.reason } : {}),
      });
      if (intent.disposition !== 'skill') continue;
      const key = slug(intent.label);
      const skill = skills.get(key) || {
        id: `skill-${key}`, name: intent.label, category: 'equipment', capabilityKind: 'tool', supportMode: 'relationship-qualified',
        directEvidenceSegmentIds: [], indexEligible: false, roleIds: [], evidenceSegmentIds: [],
      };
      skills.set(key, skill);
      if (role && !skill.roleIds.includes(role.id)) skill.roleIds.push(role.id);
      if (!skill.evidenceSegmentIds.includes(line.id)) skill.evidenceSegmentIds.push(line.id);
      // Direct support = an unqualified use, or an occurrence of the label
      // that lies OUTSIDE the narrow relationship slice on the same line.
      const outsideSlice = line.text.split(intent.slice).join(' ');
      if ((intent.relationship === 'independent' || wholeTerm(outsideSlice, intent.label)) && !skill.directEvidenceSegmentIds.includes(line.id)) {
        skill.directEvidenceSegmentIds.push(line.id);
      }
    }
    return { technologies, technologyReferences };
  };
  lines.forEach((line, index) => {
    const next = lines[index + 1]?.text;
    if (EMAIL_LINE.test(line.text)) {
      identity.contacts.push(line.text);
      identity.evidenceSegmentIds.push(line.id);
      coverage.push({ segmentId: line.id, disposition: 'identity', entityIds: [] });
    } else if (line.id === 'segment-0001') {
      identity.name = line.text;
      identity.evidenceSegmentIds.push(line.id);
      coverage.push({ segmentId: line.id, disposition: 'identity', entityIds: [] });
    } else if (!line.text.endsWith('.') && next && DATE_LINE.test(next)) {
      const [title, employer] = line.text.split(' at ');
      role = { id: `role-${roles.length + 1}`, title, employer, startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [line.id] };
      roles.push(role);
      coverage.push({ segmentId: line.id, disposition: 'role-header', entityIds: [] });
    } else if (DATE_LINE.test(line.text)) {
      [role.startDate, role.endDate] = line.text.split(' to ');
      role.evidenceSegmentIds.push(line.id);
      coverage.push({ segmentId: line.id, disposition: 'role-header', entityIds: [] });
    } else if (PROJECT_LINE.test(line.text)) {
      const [, name, description] = PROJECT_LINE.exec(line.text);
      // A project description is read like any other sentence: its technologies carry their own ledger.
      const project = { id: `project-${projects.length + 1}`, name, description, roleId: role?.id || '', technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: [line.id] };
      Object.assign(project, applyIntents(readIntents(`${description}.`), line));
      projects.push(project);
      coverage.push({ segmentId: line.id, disposition: 'project', entityIds: [] });
    } else if (PROJECT_PATCH_LINE.test(line.text) && projectIds[PROJECT_PATCH_LINE.exec(line.text)[1]]) {
      // A later page adds technologies to a project opened on an earlier page.
      const [, name, rest] = PROJECT_PATCH_LINE.exec(line.text);
      const sentence = `${rest[0].toUpperCase()}${rest.slice(1)}`;
      const intents = readIntents(sentence).map(intent => (intent.slice === sentence ? { ...intent, slice: rest } : intent));
      const updates = applyIntents(intents, line);
      projectPatches.push({ targetId: projectIds[name], evidenceSegmentIds: [line.id], updates });
      coverage.push({ segmentId: line.id, disposition: 'project', entityIds: [] });
    } else {
      // An ordinary duty or accomplishment line is always an achievement.
      const achievement = {
        id: `achievement-${achievements.length + 1}`, roleId: role.id, claim: line.text,
        technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: [line.id],
      };
      Object.assign(achievement, applyIntents(readIntents(line.text), line));
      role.achievementIds.push(achievement.id);
      achievements.push(achievement);
      coverage.push({ segmentId: line.id, disposition: 'achievement', entityIds: [] });
    }
  });
  for (const skill of skills.values()) {
    skill.supportMode = skill.directEvidenceSegmentIds.length ? 'direct' : 'relationship-qualified';
    skill.indexEligible = skill.supportMode === 'direct';
    for (const owner of roles) if (skill.roleIds.includes(owner.id)) owner.skillIds.push(skill.id);
  }
  return {
    identity, roles, achievements, projects, skills: [...skills.values()], education: [], certifications: [], otherEvidence: [],
    segmentCoverage: coverage, rolePatches: [], projectPatches,
    continuationState: {
      roles: { mode: roles.length ? 'replace' : 'inherit', ids: roles.map(item => item.id) },
      projects: { mode: projects.length ? 'replace' : 'inherit', ids: projects.map(item => item.id) },
    },
  };
}

// Compile source text through the real audited pipeline with the stand-in as
// the compiling model and clean independent audits. Deliberately uncached: a
// recompile of changed (or restored) text must be a genuine recompile.
async function compile(text, { pageMaxSegments, repair, probeShard } = {}) {
  const files = sourceFiles(text);
  const corpus = buildCareerSourceCorpus(files);
  const pages = partitionCareerSourcePages(corpus, pageMaxSegments ? { maxSegments: pageMaxSegments } : undefined);
  const projectIds = {};
  const result = await compileAuditedCareerSnapshot({
    sourceFiles: files,
    ...(pageMaxSegments ? { pageMaxSegments } : {}),
    callText: async (prompt, options) => {
      if (options.task === 'career-profile-compile') {
        const shard = standInShard(pages[options.hints.pageIndex].segments, { projectIds });
        for (const project of shard.projects) projectIds[project.name] = `p${String(options.hints.pageIndex + 1).padStart(4, '0')}-${project.id}`;
        // Lets a test hand a mutated copy of this page to the production page validator.
        if (probeShard) probeShard({ shard, options, pageIndex: options.hints.pageIndex });
        return shard;
      }
      if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
      if (options.task === 'career-profile-repair' && repair) return repair({ prompt, options, pages });
      throw new Error(`Unexpected compile task ${options.task}`);
    },
  });
  return { ...result, corpus, files, text };
}

// ---------------------------------------------------------------------------
// Production-backed verdict readers. Each one asks a production seam; none
// consults the fixture for the answer.
// ---------------------------------------------------------------------------
function skillCatalogIds(catalog, profile, label) {
  const ids = profile.skills.filter(skill => skill.name.toLowerCase() === label.toLowerCase()).map(skill => skill.id);
  return catalog.filter(item => ids.some(id => item.id.startsWith(`host.career.skill.${id}.`))).map(item => item.id);
}

function mentionCatalogIds(catalog, label) {
  return catalog.filter(item => item.quote.toLowerCase().includes(label.toLowerCase())).map(item => item.id);
}

function readDownstream(compiled) {
  const { snapshot, profile } = compiled;
  return {
    snapshot, profile,
    catalog: approvedCareerEvidenceCatalog(snapshot),
    authority: buildApplicationCareerAuthority(snapshot),
    projection: projectApprovedCareerSnapshotForApplication(snapshot),
    inventory: vettedCareerSkillInventory(profile).map(skill => skill.name),
    legacySkills: projectLegacyCareerProfile(profile).skills,
    skillEvidence: __snapshotCareerSkillEvidenceForTests(snapshot),
  };
}

function authorityVerdict(d, label) {
  const own = skillCatalogIds(d.catalog, d.profile, label);
  const evidenceIds = own.length ? own : mentionCatalogIds(d.catalog, label);
  assert(evidenceIds.length > 0, `fixture invariant: "${label}" must be citable by some catalog row so a refusal cannot be an empty-evidence artifact`);
  try { validateAuthoritySkillGroup(d.authority, [label], evidenceIds); return { accepted: true }; } catch (error) { return { accepted: false, message: String(error?.message || error) }; }
}

// A minimal, otherwise-valid current-authority résumé whose only variable is
// the skills block (and, optionally, one accepted job-listing quote).
function resumeFor(d, skillItems, { listing = null } = {}) {
  const roles = d.authority.sourceRoles.map(role => {
    const achievement = d.profile.achievements.find(item => item.roleId === role.id);
    const evidence = d.catalog.filter(item => item.id.startsWith(`host.career.achievement.${achievement.id}.`)).slice(0, 1);
    return { id: role.id, title: role.title, company: role.company, dates: role.dates, location: role.location, bullets: [{ id: `bullet-${role.id}`, text: achievement.claim, evidenceIds: evidence.map(item => item.id) }] };
  });
  const evidenceCatalog = [...d.catalog, ...(listing ? [{ id: 'listing-1', sourceId: 'job-listing', quote: listing, priority: 'highest' }] : [])];
  const skills = skillItems.length ? [{
    id: 'skills-1', group: 'Tools', items: skillItems,
    evidenceIds: [...new Set(skillItems.flatMap(item => {
      const own = skillCatalogIds(d.catalog, d.profile, item);
      return own.length ? own : mentionCatalogIds(d.catalog, item).slice(0, 1);
    }))],
  }] : undefined;
  return {
    resume: { schemaVersion: 'structured-resume.v1', identity: d.authority.identity, roles, ...(skills ? { skills } : {}) },
    context: {
      sourceRoles: d.authority.sourceRoles, evidenceCatalog, trustedIdentity: d.authority.identity,
      careerData: d.projection, careerSkillEvidence: d.skillEvidence, authorityMode: true,
    },
  };
}

function resumeVerdict(d, skillItems, options) {
  const { resume, context } = resumeFor(d, skillItems, options);
  try { validateStructuredApplicationResume(resume, context); return { accepted: true }; } catch (error) { return { accepted: false, message: String(error?.message || error) }; }
}

const hasName = (names, label) => names.some(name => name.toLowerCase() === label.toLowerCase());

// Every production seam's answer to "may the candidate be said to have
// `label` as a standalone skill?". The seams must agree.
function seamVerdict(d, label) {
  const authority = authorityVerdict(d, label);
  const resume = resumeVerdict(d, [label]);
  const skillRowQuote = `- ${label.toLowerCase()} [skill id:`;
  return {
    inventory: hasName(d.inventory, label),
    legacySkills: hasName(d.legacySkills, label),
    skillEvidence: hasName(d.skillEvidence.skills.map(skill => skill.name), label),
    catalogSkillRow: d.catalog.some(item => /^host\.career\.skill\./u.test(item.id) && item.quote.toLowerCase().includes(skillRowQuote)),
    projectionSkillRow: d.projection.toLowerCase().includes(skillRowQuote),
    authority: authority.accepted,
    resume: resume.accepted,
    authorityMessage: authority.message, resumeMessage: resume.message,
  };
}

const SEAM_KEYS = ['inventory', 'legacySkills', 'skillEvidence', 'catalogSkillRow', 'projectionSkillRow', 'authority', 'resume'];

function assertAccepted(d, label, context) {
  const verdict = seamVerdict(d, label);
  const bad = SEAM_KEYS.filter(key => verdict[key] !== true);
  assert(!bad.length, `${context}: "${label}" must be accepted as a candidate skill by every seam, but ${bad.join(', ')} refused (${verdict.authorityMessage || verdict.resumeMessage || 'no message'})`);
}

function assertRefused(d, label, context) {
  const verdict = seamVerdict(d, label);
  const bad = SEAM_KEYS.filter(key => verdict[key] !== false);
  assert(!bad.length, `${context}: "${label}" must be refused as a candidate skill by every seam, but ${bad.join(', ')} accepted it`);
  assert(NOT_APPROVED_SKILL_AUTHORITY.test(verdict.authorityMessage || '') && NOT_APPROVED_SKILL_RESUME.test(verdict.resumeMessage || ''),
    `${context}: "${label}" must be refused for the right reason, not an incidental failure (${verdict.authorityMessage} | ${verdict.resumeMessage})`);
}

// The message a production call throws, or null when it returns normally.
function thrownMessage(call) {
  try { call(); return null; } catch (error) { return String(error?.message || error); }
}

const NOT_APPROVED_SKILL_AUTHORITY = /not an exact index-eligible approved skill/u;
const NOT_APPROVED_SKILL_RESUME = /not an exact, index-eligible approved snapshot skill/u;

function ledgerOf(profile, label) {
  return [...profile.achievements, ...profile.projects]
    .flatMap(achievement => achievement.technologyReferences.map(reference => ({ achievement, reference })))
    .filter(({ reference }) => reference.technology.toLowerCase() === label.toLowerCase());
}

function assertSnapshotApproved(compiled, context) {
  const validation = validateCurrentCareerSnapshot(compiled.snapshot);
  assert(validation.valid && compiled.snapshot.status === 'approved', `${context}: compiled snapshot must validate (${(validation.errors || []).slice(0, 2).join(' | ')})`);
}

function replaceLine(text, from, to) {
  assert(text.includes(`${from}\n`), `fixture invariant: source must contain the sentence being replaced: ${from}`);
  return text.replace(`${from}\n`, to === null ? '' : `${to}\n`);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------
const nonCandidateKindTests = NON_CANDIDATE_KINDS.map(kind => ({
  name: `adaptability/relationships: ${kind} technology is an explicit non-skill, refused by every seam, in every domain (while direct use stays accepted)`,
  async run() {
    for (const profile of PROFILES) {
      const spec = KIND_SPECS[kind];
      const compiled = await compile(careerText(profile, [spec.line(profile)]));
      assertSnapshotApproved(compiled, `${profile.key}/${kind}`);
      const d = readDownstream(compiled);
      for (const label of spec.refused(profile)) {
        assertRefused(d, label, `${profile.key}/${kind}`);
        const entries = ledgerOf(d.profile, label);
        assert(entries.length === 1 && entries[0].reference.disposition === 'non-skill' && entries[0].reference.nonSkillReason,
          `${profile.key}/${kind}: "${label}" must be an explicit, reasoned non-skill in the approved ledger`);
        // The generation prompt can still see the label, but only as a non-skill.
        const achievementId = entries[0].achievement.id;
        assert(d.projection.includes(`- Non-skill label [Achievement ID: ${achievementId}]: ${label}`)
          && d.projection.includes(`- Non-skill disposition [Achievement ID: ${achievementId}]: ${entries[0].reference.nonSkillReason}`),
        `${profile.key}/${kind}: projection must label "${label}" a non-skill with its reason`);
        assert(!d.profile.skills.some(skill => skill.name.toLowerCase() === label.toLowerCase()), `${profile.key}/${kind}: no skill row may exist for non-skill "${label}"`);
      }
      for (const label of spec.accepted(profile)) assertAccepted(d, label, `${profile.key}/${kind}`);
      // Positive control on the very same candidate: a genuine direct use is accepted by every seam.
      const control = readDownstream(await compile(careerText(profile, [KIND_SPECS.operated.line(profile)])));
      assertAccepted(control, profile.label, `${profile.key}/control`);
    }
  },
}));

const qualifiedKindTests = QUALIFIED_KINDS.map(kind => ({
  name: `adaptability/relationships: ${kind} use is relation-aware evidence only, never a bare skill, in every domain`,
  async run() {
    for (const profile of PROFILES) {
      const spec = KIND_SPECS[kind];
      const compiled = await compile(careerText(profile, [spec.line(profile)]));
      assertSnapshotApproved(compiled, `${profile.key}/${kind}`);
      const d = readDownstream(compiled);
      for (const label of spec.refused(profile)) {
        assertRefused(d, label, `${profile.key}/${kind}`);
        const [entry] = ledgerOf(d.profile, label);
        const { relationship } = entry.reference;
        assert(relationship !== 'independent' && entry.reference.relationshipGroup && entry.reference.disposition === 'skill', `${profile.key}/${kind}: "${label}" must keep a qualified relationship and group`);
        // The skill row exists but is a relationship-qualified, non-indexable record.
        const row = d.profile.skills.find(skill => skill.name.toLowerCase() === label.toLowerCase());
        assert(row?.supportMode === 'relationship-qualified' && row.indexEligible === false && row.directEvidenceSegmentIds.length === 0
          && !isCareerSkillIndexEligible(row), `${profile.key}/${kind}: "${label}" must be a relationship-qualified non-indexable row`);
        // The relationship survives into the text the generator reads.
        assert(d.projection.includes(`- Usage relationship [Achievement ID: ${entry.achievement.id}]: ${relationship}`)
          && d.projection.includes(`- Relationship group [Achievement ID: ${entry.achievement.id}]: ${entry.reference.relationshipGroup}`)
          && d.projection.includes(`- Relationship evidence [Achievement ID: ${entry.achievement.id}]: ${entry.reference.relationshipEvidence}`),
        `${profile.key}/${kind}: projection must preserve the ${relationship} relationship, group, and literal evidence`);
        assert(!d.catalog.some(item => item.id.startsWith(`host.career.skill.${row.id}.`)), `${profile.key}/${kind}: a qualified row must not enter the catalog as a selectable skill`);
      }
    }
  },
}));

export default [
  ...nonCandidateKindTests,
  ...qualifiedKindTests,
  {
    name: 'adaptability/relationships: one line may state a direct use and a separate alternative; only the direct use is a skill',
    async run() {
      for (const profile of PROFILES) {
        const spec = KIND_SPECS.directPlusEither;
        const d = readDownstream(await compile(careerText(profile, [spec.line(profile)])));
        for (const label of spec.accepted(profile)) assertAccepted(d, label, `${profile.key}/directPlusEither`);
        for (const label of spec.refused(profile)) assertRefused(d, label, `${profile.key}/directPlusEither`);
        // Near miss: delete the separate direct clause. The alternative alone supports neither label.
        const relationOnly = KIND_SPECS.overflowOnly;
        const stripped = readDownstream(await compile(careerText(profile, [relationOnly.line(profile)])));
        for (const label of relationOnly.refused(profile)) assertRefused(stripped, label, `${profile.key}/overflowOnly`);
      }
    },
  },
  {
    name: 'adaptability/relationships: the literal relationship slice decides what counts as direct; a slice widened over the direct clause leaves no direct evidence',
    async run() {
      const DIRECT_OUTSIDE_SLICE = /shares relationship-qualified evidence but has no whole-term skill occurrence outside every literal relationshipEvidence slice/u;
      for (const profile of PROFILES) {
        const compiled = await compile(careerText(profile, [KIND_SPECS.directPlusEither.line(profile)]));
        assert(validateCareerProfile(compiled.profile, compiled.corpus).valid, `${profile.key}: faithful narrow-slice ledger must validate`);
        const claim = compiled.profile.achievements.find(item => item.technologyReferences.length).claim;
        // Same sentence, same direct-claiming skill row; only the ledger's slice grows to the whole line.
        const widened = structuredClone(compiled.profile);
        for (const reference of widened.achievements.find(item => item.technologyReferences.length).technologyReferences) reference.relationshipEvidence = claim;
        const result = validateCareerProfile(widened, compiled.corpus);
        assert(!result.valid && result.errors.some(error => DIRECT_OUTSIDE_SLICE.test(error)) && result.errors.some(error => error.includes(compiled.profile.skills.find(skill => skill.name === profile.label).id)),
          `${profile.key}: a slice covering the whole line must leave "${profile.label}" without a separate direct occurrence (${JSON.stringify(result.errors.slice(0, 3))})`);
        // A faithful relation-only line cannot be promoted to a direct claim either.
        const relationOnly = await compile(careerText(profile, [KIND_SPECS.overflowOnly.line(profile)]));
        const promoted = structuredClone(relationOnly.profile);
        for (const skill of promoted.skills) Object.assign(skill, { supportMode: 'direct', directEvidenceSegmentIds: [...skill.evidenceSegmentIds], indexEligible: true });
        const promotedResult = validateCareerProfile(promoted, relationOnly.corpus);
        assert(!promotedResult.valid && promotedResult.errors.filter(error => DIRECT_OUTSIDE_SLICE.test(error)).length === promoted.skills.length,
          `${profile.key}: every label of a relation-only line must be refused as direct (${JSON.stringify(promotedResult.errors.slice(0, 3))})`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a vendor integration keeps the external object a non-skill while the candidate-operated side stays a skill',
    async run() {
      for (const profile of PROFILES) {
        const d = readDownstream(await compile(careerText(profile, [KIND_SPECS.vendor.line(profile)])));
        const [achievement] = d.profile.achievements.filter(item => item.technologies.length);
        assert(achievement.technologyReferences.length === 2
          && ledgerOf(d.profile, profile.label)[0].reference.disposition === 'non-skill'
          && ledgerOf(d.profile, profile.other)[0].reference.disposition === 'skill',
        `${profile.key}: one sentence must carry two different dispositions for its two labels`);
        assertRefused(d, profile.label, `${profile.key}/vendor`);
        assertAccepted(d, profile.other, `${profile.key}/vendor`);
        // Mutation: if the same candidate instead operates the vendor offering itself, it is a skill.
        const operated = readDownstream(await compile(careerText(profile, [SENTENCES.operated.make(profile.label, profile.purpose)])));
        assertAccepted(operated, profile.label, `${profile.key}/vendor-flip`);
      }
    },
  },
  {
    name: 'adaptability/relationships: flipping the source sentence (non-candidate -> operated -> non-candidate) flips the outcome on every recompile, for every kind in every domain',
    async run() {
      for (const [index, profile] of PROFILES.entries()) {
        for (const kind of FLIPPABLE_KINDS) {
          const nonCandidate = KIND_SPECS[kind].line(profile);
          const operated = KIND_SPECS.operated.line(profile);
          const base = careerText(profile, [nonCandidate]);
          const A = await compile(base);
          const B = await compile(replaceLine(base, nonCandidate, operated));
          const C = await compile(replaceLine(replaceLine(base, nonCandidate, operated), operated, nonCandidate));
          const context = `${profile.key}/${kind}`;
          const [dA, dB, dC] = [A, B, C].map(readDownstream);
          assertRefused(dA, profile.label, `${context} A`);
          assertAccepted(dB, profile.label, `${context} B (flipped to operated)`);
          assertRefused(dC, profile.label, `${context} C (flipped back)`);
          // Snapshot identity is content addressed: a flip is a new snapshot, restoring is the old one.
          assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId && B.snapshotId !== C.snapshotId
            && A.snapshotId === careerSnapshotId(A.corpus) && B.snapshotId === careerSnapshotId(B.corpus),
          `${context}: snapshot ids must follow the source text`);
          assert(JSON.stringify(A.profile) === JSON.stringify(C.profile), `${context}: restoring the source must restore the compiled profile exactly`);
          // The job-requirement side is derived from the same current ledger: a posting that names
          // the technology REQUIRES it in the skills block only once the candidate genuinely has it.
          const requiredA = resumeVerdict(dA, [], { listing: profile.listing });
          const requiredB = resumeVerdict(dB, [], { listing: profile.listing });
          const requiredC = resumeVerdict(dC, [], { listing: profile.listing });
          assert(requiredA.accepted && !requiredB.accepted && /skills omits/u.test(requiredB.message) && requiredB.message.includes(profile.label) && requiredC.accepted,
            `${context}: the posting-named skill requirement must appear and disappear with the source evidence (${requiredA.message}|${requiredB.message}|${requiredC.message})`);
          const claimedWithPosting = [dA, dB].map(item => resumeVerdict(item, [profile.label], { listing: profile.listing }));
          assert(claimedWithPosting[1].accepted && !claimedWithPosting[0].accepted && NOT_APPROVED_SKILL_RESUME.test(claimedWithPosting[0].message),
            `${context}: with the posting present the skill is accepted only after the flip, and a refusal names the approved-skill gate (${claimedWithPosting[0].message})`);
          // Near miss: an unrelated posting (some other domain's equipment) never makes a NON-candidate
          // technology required, whereas the genuine skill is still part of the required career index.
          const unrelated = PROFILES[(index + 1) % PROFILES.length];
          assert(!unrelated.listing.toLowerCase().includes(profile.label.toLowerCase()), 'fixture invariant: the unrelated posting must not name the technology');
          const unrelatedA = resumeVerdict(dA, [], { listing: unrelated.listing });
          const unrelatedB = resumeVerdict(dB, [], { listing: unrelated.listing });
          assert(unrelatedA.accepted && !unrelatedB.accepted && /from the bounded career-attested index/u.test(unrelatedB.message) && unrelatedB.message.includes(profile.label),
            `${context}: with any posting the career index must require the genuine skill (after the flip) and never the non-candidate one (${unrelatedA.message}|${unrelatedB.message})`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: adding directly supporting evidence recompiles into an accepted skill, and removing it makes the claim unavailable again',
    async run() {
      for (const profile of PROFILES) {
        for (const kind of FLIPPABLE_KINDS) {
          const nonCandidate = KIND_SPECS[kind].line(profile);
          const direct = SENTENCES.operated.make(profile.label, profile.purpose);
          const wrongTechnology = SENTENCES.operated.make(profile.other, profile.purpose);
          const A = await compile(careerText(profile, [nonCandidate]));
          const B = await compile(careerText(profile, [nonCandidate, direct]));
          const C = await compile(replaceLine(careerText(profile, [nonCandidate, direct]), direct, null));
          const W = await compile(careerText(profile, [nonCandidate, wrongTechnology]));
          const context = `${profile.key}/${kind}`;
          assertRefused(readDownstream(A), profile.label, `${context} A`);
          const dB = readDownstream(B);
          assertAccepted(dB, profile.label, `${context} B`);
          assertRefused(readDownstream(C), profile.label, `${context} C`);
          assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId, `${context}: ids must track the source`);
          // The earlier non-candidate sentence is not erased by the later direct one: both coexist.
          assert(ledgerOf(dB.profile, profile.label).map(entry => entry.reference.disposition).sort().join() === 'non-skill,skill', `${context}: ledger must carry both records`);
          const nonCandidateAchievement = dB.profile.achievements.find(item => item.claim === nonCandidate);
          assert(dB.projection.includes(`- Non-skill label [Achievement ID: ${nonCandidateAchievement.id}]: ${profile.label}`),
            `${context}: the non-candidate sentence must remain a non-skill beside the later direct use`);
          const skill = dB.profile.skills.find(item => item.name === profile.label);
          const directSegment = B.corpus.segments.find(segment => segment.text.startsWith(direct));
          assert(skill.directEvidenceSegmentIds.length === 1 && skill.directEvidenceSegmentIds[0] === directSegment.id,
            `${context}: direct support must come only from the added sentence, not the non-candidate one`);
          // Near miss: evidence for a DIFFERENT technology never licenses this one.
          const dW = readDownstream(W);
          assertRefused(dW, profile.label, `${context} W`);
          assertAccepted(dW, profile.other, `${context} W`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: a qualified use becomes an accepted skill only once a separate direct sentence is added, and unavailable again when it is removed',
    async run() {
      for (const profile of PROFILES) {
        for (const kind of QUALIFIED_KINDS) {
          const spec = KIND_SPECS[kind];
          const qualified = spec.line(profile);
          const direct = SENTENCES.operated.make(profile.label, profile.purpose);
          const A = await compile(careerText(profile, [qualified]));
          const B = await compile(careerText(profile, [qualified, direct]));
          const C = await compile(replaceLine(careerText(profile, [qualified, direct]), direct, null));
          const context = `${profile.key}/${kind}`;
          const [dA, dB, dC] = [A, B, C].map(readDownstream);
          assertRefused(dA, profile.label, `${context} A`);
          assertAccepted(dB, profile.label, `${context} B`);
          assertRefused(dC, profile.label, `${context} C`);
          assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId && JSON.stringify(A.profile) === JSON.stringify(C.profile), `${context}: ids and the compiled profile must follow the source`);
          // Both records survive: the qualifier is kept on its own sentence, the direct use is its own record.
          const relationships = ledgerOf(dB.profile, profile.label).map(entry => entry.reference.relationship);
          assert(relationships.length === 2 && relationships.includes('independent') && relationships.some(item => item !== 'independent'), `${context}: B must keep a qualified record beside the direct one (${relationships})`);
          const skill = dB.profile.skills.find(item => item.name === profile.label);
          const directSegment = B.corpus.segments.find(segment => segment.text.trim() === direct);
          assert(skill.supportMode === 'direct' && skill.directEvidenceSegmentIds.join() === directSegment.id, `${context}: direct support must come only from the added sentence`);
          // A sibling that shares the qualifier but received no direct sentence stays refused.
          for (const sibling of spec.refused(profile).filter(label => label !== profile.label)) assertRefused(dB, sibling, `${context} B sibling`);
          // A posting that names the technology demands it from the résumé only once the candidate truly has it directly.
          const [requiredA, requiredB, requiredC] = [dA, dB, dC].map(item => resumeVerdict(item, [], { listing: profile.listing }));
          assert(requiredA.accepted && requiredC.accepted && !requiredB.accepted && /skills omits/u.test(requiredB.message) && requiredB.message.includes(profile.label),
            `${context}: the posting-named requirement must exist only in B (${requiredA.message}|${requiredB.message}|${requiredC.message})`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: one coordinating word turns a choice into simultaneous use (or -> and -> or) and the outcome follows on every recompile',
    async run() {
      for (const profile of PROFILES) {
        const orLine = KIND_SPECS.orPair.line(profile);
        const andLine = KIND_SPECS.andPair.line(profile);
        const A = await compile(careerText(profile, [orLine]));
        const B = await compile(replaceLine(careerText(profile, [orLine]), orLine, andLine));
        const C = await compile(replaceLine(replaceLine(careerText(profile, [orLine]), orLine, andLine), andLine, orLine));
        const context = `${profile.key}/or-and`;
        const [dA, dB, dC] = [A, B, C].map(readDownstream);
        for (const label of [profile.label, profile.other]) {
          assertRefused(dA, label, `${context} A (choice)`);
          assertAccepted(dB, label, `${context} B (both used)`);
          assertRefused(dC, label, `${context} C (choice again)`);
        }
        assert(new Set(ledgerOf(dA.profile, profile.label).concat(ledgerOf(dA.profile, profile.other)).map(entry => entry.reference.relationshipGroup)).size === 1
          && ledgerOf(dB.profile, profile.label)[0].reference.relationship === 'independent' && !ledgerOf(dB.profile, profile.label)[0].reference.relationshipGroup,
        `${context}: the choice shares one group; simultaneous use carries none`);
        assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId && JSON.stringify(A.profile) === JSON.stringify(C.profile), `${context}: ids and the compiled profile must follow the source`);
        // Resume side: both labels become required career-index terms only in B.
        const requiredA = resumeVerdict(dA, [], { listing: profile.listing });
        const requiredB = resumeVerdict(dB, [], { listing: profile.listing });
        assert(requiredA.accepted && !requiredB.accepted && requiredB.message.includes(profile.label) && requiredB.message.includes(profile.other),
          `${context}: simultaneous use must require both labels in the index and the choice neither (${requiredA.message}|${requiredB.message})`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a project carries the same ledger as an achievement, for every sentence kind in every domain, and flips with its source',
    async run() {
      const projectSource = (profile, sentence) => [
        profile.name, `${profile.title} at ${profile.employer}`, `${profile.start} to ${profile.end}`, profile.duty, `Project ${profile.project}: ${sentence}`, profile.email,
      ].map(line => `${line}\n`).join('');
      for (const profile of PROFILES) {
        for (const [kind, spec] of Object.entries(KIND_SPECS)) {
          const compiled = await compile(projectSource(profile, spec.line(profile)));
          assertSnapshotApproved(compiled, `${profile.key}/project/${kind}`);
          const d = readDownstream(compiled);
          const [project] = d.profile.projects;
          assert(d.profile.projects.length === 1 && project.technologyReferences.length > 0 && d.profile.achievements.every(item => !item.technologyReferences.length),
            `${profile.key}/project/${kind}: the ledger must live on the project, not on an achievement`);
          for (const label of spec.accepted(profile)) assertAccepted(d, label, `${profile.key}/project/${kind}`);
          for (const label of spec.refused(profile)) {
            assertRefused(d, label, `${profile.key}/project/${kind}`);
            const [{ reference }] = ledgerOf(d.profile, label);
            if (reference.disposition === 'non-skill') {
              assert(d.projection.includes(`- Non-skill label [Project ID: ${project.id}]: ${label}`) && d.projection.includes(`- Non-skill disposition [Project ID: ${project.id}]: ${reference.nonSkillReason}`),
                `${profile.key}/project/${kind}: the project projection must label "${label}" a non-skill with its reason`);
            } else {
              assert(d.projection.includes(`- Usage relationship [Project ID: ${project.id}]: ${reference.relationship}`) && d.projection.includes(`- Relationship evidence [Project ID: ${project.id}]: ${reference.relationshipEvidence}`),
                `${profile.key}/project/${kind}: the project projection must keep the ${reference.relationship} relationship and its literal evidence for "${label}"`);
            }
          }
        }
        // Flip: the same project description reads differently once its sentence changes.
        const evaluated = projectSource(profile, SENTENCES.evaluated.make(profile.label, profile.purpose));
        const operated = projectSource(profile, SENTENCES.operated.make(profile.label, profile.purpose));
        const [A, B, C] = [await compile(evaluated), await compile(operated), await compile(evaluated)];
        assertRefused(readDownstream(A), profile.label, `${profile.key}/project A`);
        assertAccepted(readDownstream(B), profile.label, `${profile.key}/project B`);
        assertRefused(readDownstream(C), profile.label, `${profile.key}/project C`);
        assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId, `${profile.key}: ids must follow the project sentence`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a stored approved snapshot cannot be re-pointed at a different relationship by editing its profile after approval',
    async run() {
      const AUDIT_BINDING = /final convergence receipt does not match the approved profile/u;
      for (const profile of PROFILES) {
        // (1) A non-skill promoted to a direct, index-eligible skill row.
        const evaluated = await compile(careerText(profile, [KIND_SPECS.evaluated.line(profile)]));
        assertSnapshotApproved(evaluated, `${profile.key}/evaluated control`);
        const promoted = structuredClone(evaluated.snapshot);
        const segmentId = promoted.profile.achievements.find(item => item.technologies.length).evidenceSegmentIds[0];
        promoted.profile.skills.push({
          id: 'skill-forged', name: profile.label, category: 'equipment', capabilityKind: 'tool', supportMode: 'direct',
          directEvidenceSegmentIds: [segmentId], indexEligible: true, roleIds: [promoted.profile.roles[0].id], evidenceSegmentIds: [segmentId],
        });
        promoted.profile.roles[0].skillIds.push('skill-forged');
        promoted.profile.segmentCoverage.find(entry => entry.segmentId === segmentId).entityIds.push('skill-forged');
        const promotedValidation = validateCurrentCareerSnapshot(promoted);
        assert(!promotedValidation.valid && promotedValidation.errors.some(error => AUDIT_BINDING.test(error)), `${profile.key}: a skill row added to a stored snapshot must break its audit binding (${JSON.stringify(promotedValidation.errors.slice(0, 2))})`);
        // (2) A choice flattened into simultaneous direct use, consistently, in every record.
        const choice = await compile(careerText(profile, [KIND_SPECS.either.line(profile)]));
        const flattened = structuredClone(choice.snapshot);
        for (const reference of flattened.profile.achievements.find(item => item.technologyReferences.length).technologyReferences) Object.assign(reference, { relationship: 'independent', relationshipGroup: '' });
        for (const skill of flattened.profile.skills) Object.assign(skill, { supportMode: 'direct', indexEligible: true, directEvidenceSegmentIds: [...skill.evidenceSegmentIds] });
        const flattenedValidation = validateCurrentCareerSnapshot(flattened);
        assert(!flattenedValidation.valid && flattenedValidation.errors.some(error => AUDIT_BINDING.test(error)), `${profile.key}: a consistently flattened choice in a stored snapshot must break its audit binding (${JSON.stringify(flattenedValidation.errors.slice(0, 2))})`);
        // (3) A bare eligibility flag on a qualified row is rejected by the profile rules and the audit binding alike.
        const flagged = structuredClone(choice.snapshot);
        flagged.profile.skills.find(skill => skill.name === profile.label).indexEligible = true;
        const flaggedValidation = validateCurrentCareerSnapshot(flagged);
        assert(!flaggedValidation.valid && flaggedValidation.errors.some(error => /relationship-qualified cannot be indexEligible/u.test(error)) && flaggedValidation.errors.some(error => AUDIT_BINDING.test(error)),
          `${profile.key}: a forged eligibility flag must be rejected twice over (${JSON.stringify(flaggedValidation.errors.slice(0, 3))})`);
        // (4) Control: the untouched snapshots validate, so every rejection above is caused by its edit.
        assertSnapshotApproved(choice, `${profile.key}/choice control`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a job-listing requirement is never candidate experience, even for a technology the candidate genuinely has',
    async run() {
      const LISTING_ONLY = /job-listing evidence alone cannot support rendered candidate content/u;
      for (const profile of PROFILES) {
        for (const [name, line] of [['evaluated', KIND_SPECS.evaluated.line(profile)], ['operated', KIND_SPECS.operated.line(profile)]]) {
          const d = readDownstream(await compile(careerText(profile, [line])));
          const { resume, context } = resumeFor(d, [profile.label], { listing: profile.listing });
          const listingOnly = structuredClone(resume);
          listingOnly.skills[0].evidenceIds = ['listing-1'];
          const message = thrownMessage(() => validateStructuredApplicationResume(listingOnly, context));
          assert(message && LISTING_ONLY.test(message), `${profile.key}/${name}: a skills item that cites only the posting must be refused as listing-only (${message})`);
          // Control: citing the candidate's own evidence is what separates the two outcomes.
          const careerCited = resumeVerdict(d, [profile.label], { listing: profile.listing });
          assert(name === 'operated' ? careerCited.accepted : (!careerCited.accepted && NOT_APPROVED_SKILL_RESUME.test(careerCited.message)),
            `${profile.key}/${name}: with career evidence cited the item must follow the ledger (${careerCited.message})`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: an organization that uses or owns an instrument is not a person who operates it, in every domain',
    async run() {
      for (const profile of PROFILES) {
        for (const kind of ['employerUses', 'employerOwned']) {
          const organization = KIND_SPECS[kind].line(profile);
          const operates = SENTENCES.operated.make(profile.label, profile.purpose);
          const organizationOnly = readDownstream(await compile(careerText(profile, [organization])));
          const candidateOnly = readDownstream(await compile(careerText(profile, [operates])));
          const both = readDownstream(await compile(careerText(profile, [organization, operates])));
          assertRefused(organizationOnly, profile.label, `${profile.key} ${kind}`);
          assertAccepted(candidateOnly, profile.label, `${profile.key} candidate operates`);
          assertAccepted(both, profile.label, `${profile.key} ${kind} + candidate operates`);
          // The subject of the sentence is the only difference in the ledger decision.
          assert(ledgerOf(organizationOnly.profile, profile.label)[0].reference.disposition === 'non-skill'
            && ledgerOf(candidateOnly.profile, profile.label)[0].reference.disposition === 'skill', `${profile.key}/${kind}: subject flip must flip the disposition`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: a stale relationship ledger cannot survive a change to its source text',
    async run() {
      const SLICE_NOT_LITERAL = /relationshipEvidence must be a literal source slice/u;
      for (const profile of PROFILES) {
        for (const kind of FLIPPABLE_KINDS) {
          const nonCandidate = KIND_SPECS[kind].line(profile);
          const operated = KIND_SPECS.operated.line(profile);
          const A = await compile(careerText(profile, [nonCandidate]));
          const B = await compile(careerText(profile, [nonCandidate, operated]));
          const flipped = await compile(replaceLine(careerText(profile, [nonCandidate]), nonCandidate, operated));
          const context = `${profile.key}/${kind}`;
          assert(validateCareerProfile(A.profile, A.corpus).valid && validateCareerProfile(B.profile, B.corpus).valid, `${context}: control profiles validate against their own source`);
          // Non-skill ledger replayed over text where the sentence now says "operated".
          const staleNonSkill = validateCareerProfile(A.profile, flipped.corpus);
          assert(!staleNonSkill.valid && staleNonSkill.errors.some(error => SLICE_NOT_LITERAL.test(error)), `${context}: stale non-skill ledger must be rejected against flipped source (${JSON.stringify(staleNonSkill.errors.slice(0, 2))})`);
          // Skill ledger replayed over text where the sentence reverted to non-candidate.
          const staleSkill = validateCareerProfile(flipped.profile, A.corpus);
          assert(!staleSkill.valid && staleSkill.errors.some(error => SLICE_NOT_LITERAL.test(error)), `${context}: stale skill ledger must be rejected against reverted source (${JSON.stringify(staleSkill.errors.slice(0, 2))})`);
          // The supporting sentence was removed but the skill row and its ledger were kept: the cited
          // segment is gone, so the claim, the technology label and the skill are no longer grounded.
          const staleAfterRemoval = validateCareerProfile(B.profile, A.corpus);
          assert(!staleAfterRemoval.valid
            && staleAfterRemoval.errors.some(error => /cites unknown segment/u.test(error))
            && staleAfterRemoval.errors.some(error => new RegExp(`technology "${profile.label}" is not grounded|skills\\[[^\\]]+\\]\\.name is not grounded`, 'u').test(error)),
          `${context}: a skill whose supporting sentence disappeared must not validate (${JSON.stringify(staleAfterRemoval.errors.slice(0, 3))})`);
          // The same replay at the approved-snapshot boundary: a stored profile cannot be re-pointed at other source.
          const repointed = structuredClone(B.snapshot);
          repointed.sources = structuredClone(A.snapshot.sources);
          const repointedValidation = validateCurrentCareerSnapshot(repointed);
          assert(!repointedValidation.valid && repointedValidation.errors.some(error => /snapshot id does not match|source fingerprint|input fingerprint|segments are not the canonical/u.test(error)),
            `${context}: a snapshot whose source text no longer matches its id/fingerprints must be rejected (${JSON.stringify(repointedValidation.errors.slice(0, 2))})`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: the relationship ledger is a closed contract; every malformed or flattened relationship is rejected with its own reason',
    async run() {
      const vocabulary = [...CAREER_SNAPSHOT_TECHNOLOGY_RELATIONSHIPS];
      assert(vocabulary.includes('independent') && vocabulary.filter(item => item !== 'independent').length >= 1
        && vocabulary.every(item => /^[a-z]+$/u.test(item)), 'relationship vocabulary must be generic relationship classes with an independent baseline');
      // Coverage tripwire: every relationship class production recognises must be reached by a sentence
      // kind in this file, so a newly added class cannot silently go untested.
      const reached = new Set();
      for (const spec of Object.values(KIND_SPECS)) {
        const compiled = await compile(careerText(PROFILES[0], [spec.line(PROFILES[0])]));
        for (const { reference } of compiled.profile.achievements.flatMap(entity => entity.technologyReferences.map(item => ({ reference: item })))) reached.add(reference.relationship);
      }
      const unreached = vocabulary.filter(item => !reached.has(item));
      assert(!unreached.length, `relationship classes recognised by production but not exercised by any sentence kind: ${unreached.join(', ')}`);
      const FORGERIES = [
        { name: 'unknown relationship word', base: 'either', pattern: /relationship is not a recognized source relationship/u, mutate: ({ refs }) => { refs[0].relationship = 'evaluated'; } },
        { name: 'alternative flattened to independent', base: 'either', pattern: /relationship-qualified needs a linked alternative, conditional, optional, or ambiguous technology reference/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationship = 'independent'; ref.relationshipGroup = ''; }) },
        { name: 'qualified use promoted to direct', base: 'either', pattern: /outside every literal relationshipEvidence slice/u, mutate: ({ skills }) => skills.forEach(skill => { skill.supportMode = 'direct'; skill.directEvidenceSegmentIds = [...skill.evidenceSegmentIds]; skill.indexEligible = true; }) },
        { name: 'qualified row marked index eligible', base: 'either', pattern: /relationship-qualified cannot be indexEligible/u, mutate: ({ skills }) => { skills[0].indexEligible = true; } },
        { name: 'qualified row with direct evidence', base: 'either', pattern: /relationship-qualified must not carry directEvidenceSegmentIds/u, mutate: ({ skills }) => { skills[0].directEvidenceSegmentIds = [...skills[0].evidenceSegmentIds]; } },
        { name: 'alternative with one member', base: 'either', pattern: /alternative group .* needs at least two labels/u, mutate: ({ achievement, refs }) => { achievement.technologyReferences = [refs[0]]; achievement.technologies = [achievement.technologies[0]]; } },
        { name: 'group mixing relationship classes', base: 'either', pattern: /mixes incompatible relationship classes/u, mutate: ({ refs }) => { refs[1].relationship = 'conditional'; } },
        { name: 'group members with different evidence slices', base: 'either', pattern: /must retain one shared literal relationship evidence slice/u, mutate: ({ refs, achievement }) => { refs[1].relationshipEvidence = achievement.claim; } },
        { name: 'group evidence that omits its member', base: 'either', pattern: /does not literally include its grouped technology label/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationshipEvidence = 'depending on whether'; }) },
        { name: 'paraphrased relationship evidence', base: 'either', pattern: /relationshipEvidence must be a literal source slice/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationshipEvidence = 'either one of the two'; }) },
        { name: 'qualified relationship without a group', base: 'either', pattern: /relationshipGroup is required for alternative, conditional, optional, or ambiguous/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationshipGroup = ''; }) },
        { name: 'non-skill that binds a skill id', base: 'evaluated', pattern: /must not bind skillId for a non-skill disposition/u, mutate: ({ refs }) => { refs[0].skillId = 'skill-anything'; } },
        { name: 'non-skill without a reason', base: 'evaluated', pattern: /nonSkillReason is required for an explicit non-skill disposition/u, mutate: ({ refs }) => { delete refs[0].nonSkillReason; } },
        { name: 'unrecognized disposition', base: 'evaluated', pattern: /disposition must be skill or non-skill/u, mutate: ({ refs }) => { refs[0].disposition = 'candidate'; } },
        { name: 'technology label with no disposition', base: 'evaluated', pattern: /has no source-linked skill or non-skill disposition/u, mutate: ({ achievement }) => { achievement.technologyReferences = []; } },
        { name: 'ledger record for an unlisted technology', base: 'evaluated', pattern: /does not identify one of/u, mutate: ({ achievement, refs, profile }) => { achievement.technologyReferences.push({ ...structuredClone(refs[0]), technology: profile.other }); } },
        { name: 'skill disposition carrying a non-skill reason', base: 'operated', pattern: /cannot carry nonSkillReason when its disposition is skill/u, mutate: ({ refs }) => { refs[0].nonSkillReason = 'not a skill'; } },
        { name: 'skill disposition with a dangling skill id', base: 'operated', pattern: /skillId must resolve to one exact source-linked approved skill/u, mutate: ({ refs }) => { refs[0].skillId = 'skill-missing'; } },
        { name: 'independent technology with a group', base: 'operated', pattern: /relationshipGroup must be empty for an independent technology/u, mutate: ({ refs }) => { refs[0].relationshipGroup = 'invented-group'; } },
        { name: 'direct skill without direct evidence', base: 'operated', pattern: /direct requires one or more separate literal directEvidenceSegmentIds/u, mutate: ({ skills }) => { skills[0].directEvidenceSegmentIds = []; } },
        { name: 'skill renamed away from its ledger label', base: 'operated', pattern: /does not have the same normalized label as its technology/u, mutate: ({ skills, profile }) => { skills[0].name = profile.other; } },
        { name: 'ledger label absent from its cited sentence', base: 'evaluated', pattern: /technologyReferences\[\d+\]\.technology is not literally grounded in its cited source segment/u, mutate: ({ achievement, refs, profile }) => { achievement.technologies = [profile.other]; refs[0].technology = profile.other; } },
        { name: 'two dispositions for one label in one claim', base: 'evaluated', pattern: /has more than one disposition for/u, mutate: ({ refs }) => { const skillRecord = structuredClone(refs[0]); skillRecord.disposition = 'skill'; delete skillRecord.nonSkillReason; refs.push(skillRecord); } },
        { name: 'ledger evidence the claim does not cite', base: 'operated', pattern: /evidence segment-\d+ is not also cited by/u, mutate: ({ refs, corpus, profile }) => { refs[0].evidenceSegmentIds = [corpus.segments.find(segment => segment.text.trim() === profile.duty).id]; } },
        { name: 'relation-only alternative promoted to direct', base: 'overflowOnly', pattern: /outside every literal relationshipEvidence slice/u, mutate: ({ skills }) => skills.forEach(skill => { skill.supportMode = 'direct'; skill.directEvidenceSegmentIds = [...skill.evidenceSegmentIds]; skill.indexEligible = true; }) },
        { name: 'direct evidence segment that never names the skill', base: 'operated', pattern: /directEvidenceSegmentIds do not literally demonstrate the skill name/u, mutate: ({ skills, corpus, profile }) => { const dutySegment = corpus.segments.find(segment => segment.text.trim() === profile.duty).id; skills[0].evidenceSegmentIds.push(dutySegment); skills[0].directEvidenceSegmentIds = [dutySegment]; } },
        { name: 'unknown support mode', base: 'operated', pattern: /supportMode must be direct or relationship-qualified/u, mutate: ({ skills }) => { skills[0].supportMode = 'inferred'; } },
        { name: 'capability kind outside the controlled taxonomy', base: 'operated', pattern: /capabilityKind must be one controlled candidate-capability taxonomy value/u, mutate: ({ skills }) => { skills[0].capabilityKind = 'artifact'; } },
        { name: 'index eligibility that is not a boolean', base: 'operated', pattern: /indexEligible must be a boolean/u, mutate: ({ skills }) => { skills[0].indexEligible = 'yes'; } },
      ];
      for (const profile of PROFILES) {
        const bases = {
          either: await compile(careerText(profile, [KIND_SPECS.either.line(profile)])),
          evaluated: await compile(careerText(profile, [KIND_SPECS.evaluated.line(profile)])),
          operated: await compile(careerText(profile, [KIND_SPECS.operated.line(profile)])),
          overflowOnly: await compile(careerText(profile, [KIND_SPECS.overflowOnly.line(profile)])),
        };
        for (const [name, compiled] of Object.entries(bases)) {
          assert(validateCareerProfile(compiled.profile, compiled.corpus).valid, `${profile.key}/${name}: unmutated control must validate`);
        }
        for (const forgery of FORGERIES) {
          const compiled = bases[forgery.base];
          const forged = structuredClone(compiled.profile);
          const achievement = forged.achievements.find(item => item.technologyReferences.length);
          forgery.mutate({ profile, corpus: compiled.corpus, achievement, refs: achievement.technologyReferences, skills: forged.skills });
          const result = validateCareerProfile(forged, compiled.corpus);
          assert(!result.valid && result.errors.some(error => forgery.pattern.test(error)),
            `${profile.key}: forgery "${forgery.name}" must be rejected with ${forgery.pattern}, got ${JSON.stringify(result.errors.slice(0, 3))}`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: the compile handoff refuses a model response that mislabels a relationship before it can reach the merge',
    async run() {
      // Page-stage rules are enforced in the handoff validator (a second, earlier seam than validateCareerProfile).
      const PAGE_FORGERIES = [
        { name: 'responder supplies a host-bound skill id', base: 'operated', pattern: /skillId is host-bound after full skill reconciliation and must not be supplied by a responder/u, mutate: ({ refs }) => { refs[0].skillId = 'skill-anything'; } },
        { name: 'qualified skill marked index eligible', base: 'either', pattern: /supportMode relationship-qualified cannot be indexEligible/u, mutate: ({ skills }) => { skills[0].indexEligible = true; } },
        { name: 'qualified skill carrying direct evidence', base: 'either', pattern: /supportMode relationship-qualified must not carry directEvidenceSegmentIds/u, mutate: ({ skills }) => { skills[0].directEvidenceSegmentIds = [...skills[0].evidenceSegmentIds]; } },
        { name: 'direct skill without direct evidence', base: 'operated', pattern: /supportMode direct requires separate literal directEvidenceSegmentIds/u, mutate: ({ skills }) => { skills[0].directEvidenceSegmentIds = []; } },
        { name: 'capability kind outside the taxonomy', base: 'operated', pattern: /capabilityKind must be one controlled candidate-capability taxonomy value/u, mutate: ({ skills }) => { skills[0].capabilityKind = 'artifact'; } },
        { name: 'unknown support mode', base: 'operated', pattern: /supportMode must be direct or relationship-qualified/u, mutate: ({ skills }) => { skills[0].supportMode = 'inferred'; } },
        { name: 'choice split to a single member', base: 'either', pattern: /alternative group .* needs at least two labels/u, mutate: ({ achievement, refs }) => { achievement.technologyReferences = [refs[0]]; achievement.technologies = [achievement.technologies[0]]; } },
        { name: 'choice relabelled independent while keeping its group', base: 'either', pattern: /relationshipGroup must be empty for an independent technology/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationship = 'independent'; }) },
        { name: 'non-skill without a reason', base: 'evaluated', pattern: /nonSkillReason is required for an explicit non-skill disposition/u, mutate: ({ refs }) => { delete refs[0].nonSkillReason; } },
        { name: 'non-skill label with no ledger record', base: 'evaluated', pattern: /has no source-linked skill or non-skill disposition/u, mutate: ({ achievement }) => { achievement.technologyReferences = []; } },
        { name: 'paraphrased relationship slice', base: 'either', pattern: /relationshipEvidence must be a literal source slice/u, mutate: ({ refs }) => refs.forEach(ref => { ref.relationshipEvidence = 'one of the two'; }) },
      ];
      for (const profile of PROFILES) {
        const outcomes = [];
        for (const base of new Set(PAGE_FORGERIES.map(forgery => forgery.base))) {
          await compile(careerText(profile, [KIND_SPECS[base].line(profile)]), {
            probeShard: ({ shard, options }) => {
              const attempt = candidate => { try { options.responseValidator(candidate); return null; } catch (error) { return error; } };
              outcomes.push({ name: `${base} control`, error: attempt(structuredClone(shard)), control: true });
              for (const forgery of PAGE_FORGERIES.filter(item => item.base === base)) {
                const forged = structuredClone(shard);
                const achievement = forged.achievements.find(item => item.technologyReferences.length);
                forgery.mutate({ achievement, refs: achievement.technologyReferences, skills: forged.skills });
                outcomes.push({ name: forgery.name, error: attempt(forged), pattern: forgery.pattern });
              }
            },
          });
        }
        assert(outcomes.filter(item => item.control).length === 3 && outcomes.filter(item => item.control).every(item => item.error === null), `${profile.key}: the unmutated page responses must pass their own handoff`);
        for (const outcome of outcomes.filter(item => !item.control)) {
          assert(outcome.error?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && outcome.pattern.test(outcome.error.message),
            `${profile.key}: page forgery "${outcome.name}" must be refused at the handoff with ${outcome.pattern} (${outcome.error?.code} ${String(outcome.error?.message).slice(0, 200)})`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: a forged flag or a known opaque skill id cannot promote a qualified technology past the application authority',
    async run() {
      for (const profile of PROFILES) {
        const compiled = await compile(careerText(profile, [KIND_SPECS.either.line(profile)]));
        assertRefused(readDownstream(compiled), profile.label, `${profile.key}/control`);
        const forgedSnapshot = structuredClone(compiled.snapshot);
        const row = forgedSnapshot.profile.skills.find(skill => skill.name === profile.label);
        assert(row.supportMode === 'relationship-qualified', `${profile.key}: fixture must start as a qualified row`);
        row.indexEligible = true; // forged eligibility flag on a relationship-qualified row
        const forged = readDownstream({ snapshot: forgedSnapshot, profile: forgedSnapshot.profile });
        assert(!isCareerSkillIndexEligible(row) && !hasName(forged.inventory, profile.label) && !hasName(forged.legacySkills, profile.label)
          && !hasName(forged.skillEvidence.skills.map(skill => skill.name), profile.label),
        `${profile.key}: a forged indexEligible flag must not admit a relationship-qualified row to any inventory`);
        const resolveMessage = thrownMessage(() => resolveAuthoritySkill(forged.authority, row.id));
        assert(resolveMessage && /Unknown authority skill/u.test(resolveMessage), `${profile.key}: the opaque id of a qualified row must not resolve in the application authority (${resolveMessage})`);
        const forgedAuthority = authorityVerdict(forged, profile.label);
        const forgedResume = resumeVerdict(forged, [profile.label]);
        assert(!forgedAuthority.accepted && NOT_APPROVED_SKILL_AUTHORITY.test(forgedAuthority.message) && !forgedResume.accepted && NOT_APPROVED_SKILL_RESUME.test(forgedResume.message),
          `${profile.key}: forged flag must not pass authority or résumé validation, and must be refused by the approved-skill gate (${forgedAuthority.message} | ${forgedResume.message})`);
        // A direct claim stripped of its separate direct evidence is equally inert.
        const direct = await compile(careerText(profile, [KIND_SPECS.operated.line(profile)]));
        assertAccepted(readDownstream(direct), profile.label, `${profile.key}/direct control`);
        const stripped = structuredClone(direct.snapshot);
        stripped.profile.skills.find(skill => skill.name === profile.label).directEvidenceSegmentIds = [];
        const dStripped = readDownstream({ snapshot: stripped, profile: stripped.profile });
        const strippedAuthority = authorityVerdict(dStripped, profile.label);
        const strippedResume = resumeVerdict(dStripped, [profile.label]);
        assert(!hasName(dStripped.inventory, profile.label) && !strippedAuthority.accepted && NOT_APPROVED_SKILL_AUTHORITY.test(strippedAuthority.message)
          && !strippedResume.accepted && NOT_APPROVED_SKILL_RESUME.test(strippedResume.message),
        `${profile.key}: direct support without separate direct evidence must not reach inventory, authority, or résumé`);
        // And a qualified mode with a forged eligible flag over a genuinely direct sentence is inert too.
        const downgraded = structuredClone(direct.snapshot);
        Object.assign(downgraded.profile.skills.find(skill => skill.name === profile.label), { supportMode: 'relationship-qualified', indexEligible: true });
        const dDowngraded = readDownstream({ snapshot: downgraded, profile: downgraded.profile });
        const downgradedAuthority = authorityVerdict(dDowngraded, profile.label);
        assert(!hasName(dDowngraded.inventory, profile.label) && !downgradedAuthority.accepted && NOT_APPROVED_SKILL_AUTHORITY.test(downgradedAuthority.message),
          `${profile.key}: a relationship-qualified mode cannot be bare inventory even with an eligible flag`);
      }
    },
  },
  {
    name: 'adaptability/relationships: across pages, the same technology is a non-skill in one role and a skill only in the role that operated it',
    async run() {
      for (const profile of PROFILES) {
        const evaluated = SENTENCES.evaluated.make(profile.label, profile.purpose);
        const operated = SENTENCES.operated.make(profile.label, profile.purpose);
        const swap = sentence => (sentence === operated ? evaluated : sentence);
        for (const [order, first, later, operatedRole] of [['evaluated-then-operated', evaluated, operated, 1], ['operated-then-evaluated', operated, evaluated, 0]]) {
          const compiled = await compile(twoRoleText(profile, first, later), { pageMaxSegments: 5 });
          assert(compiled.snapshot.pagePlan.pageCount === 2 && compiled.profile.roles.map(role => role.id.slice(0, 6)).join() === 'p0001-,p0002-', `${profile.key}: the compile itself must have paged the roles onto separate source pages`);
          assertSnapshotApproved(compiled, `${profile.key}/${order}`);
          const d = readDownstream(compiled);
          assertAccepted(d, profile.label, `${profile.key}/${order}`);
          const [skill] = d.profile.skills;
          const operatedRoleId = d.profile.roles[operatedRole].id;
          const evaluatedRoleId = d.profile.roles[1 - operatedRole].id;
          assert(d.profile.skills.length === 1 && skill.roleIds.length === 1 && skill.roleIds[0] === operatedRoleId
            && !d.profile.roles.find(role => role.id === evaluatedRoleId).skillIds.includes(skill.id), `${profile.key}/${order}: the skill must be scoped to the operating role only`);
          // The role-scoped authority agrees: the skill's evidence belongs to the operating role, not the evaluating one.
          const skillEvidence = skillCatalogIds(d.catalog, d.profile, profile.label);
          validateAuthorityRoleEvidence(d.authority, operatedRoleId, skillEvidence);
          const crossRoleMessage = thrownMessage(() => validateAuthorityRoleEvidence(d.authority, evaluatedRoleId, skillEvidence));
          assert(crossRoleMessage && /does not belong to role/u.test(crossRoleMessage), `${profile.key}/${order}: skill evidence must not be accepted for the role that only evaluated the technology (${crossRoleMessage})`);
          const nonSkillOwner = d.profile.achievements.find(item => item.roleId === evaluatedRoleId && item.technologies.length);
          assert(d.projection.includes(`- Non-skill label [Achievement ID: ${nonSkillOwner.id}]: ${profile.label}`), `${profile.key}/${order}: the evaluating role must still show a non-skill label`);
          // Replacing the operating role's sentence recompiles to a candidate without the skill.
          const without = await compile(twoRoleText(profile, swap(first), swap(later)), { pageMaxSegments: 5 });
          assertRefused(readDownstream(without), profile.label, `${profile.key}/${order} removed`);
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: the same technology on two pages reconciles to one skill, direct or qualified, linked to every role that used it that way',
    async run() {
      for (const profile of PROFILES) {
        const operated = SENTENCES.operated.make(profile.label, profile.purpose);
        const operatedAgain = SENTENCES.operated.make(profile.label, 'monitor day-to-day throughput');
        const compiled = await compile(twoRoleText(profile, operated, operatedAgain), { pageMaxSegments: 5 });
        const d = readDownstream(compiled);
        assertAccepted(d, profile.label, profile.key);
        assert(d.profile.skills.length === 1 && d.profile.skills[0].roleIds.length === 2 && d.profile.skills[0].directEvidenceSegmentIds.length === 2
          && compiled.snapshot.reconciliation.skillMerges.length === 1, `${profile.key}: compatible rows must merge, unioning roles and direct evidence`);
        // Both qualified: also merges, and stays qualified (never silently upgraded to direct).
        const qualifiedLine = SENTENCES.whenAvailable.make(profile.label);
        const qualified = readDownstream(await compile(twoRoleText(profile, qualifiedLine, SENTENCES.optionalUse.make(profile.label, profile.purpose)), { pageMaxSegments: 5 }));
        assertRefused(qualified, profile.label, `${profile.key}/qualified-both`);
        assert(qualified.profile.skills.length === 1 && qualified.profile.skills[0].supportMode === 'relationship-qualified' && qualified.profile.skills[0].roleIds.length === 2,
          `${profile.key}: two qualified uses merge into one qualified row`);
      }
    },
  },
  {
    // Isolated on purpose: the interview helper is a separate feature, and its modules are loaded
    // dynamically so that a problem there fails only this test, never the whole family.
    name: 'adaptability/relationships: interview-helper evidence never offers a non-candidate or relationship-qualified technology as the candidate\'s skill',
    async run() {
      const { projectInterviewHelperCareerSnapshot } = await import('../../electron/ipc/interviewHelper.js');
      const { extractInterviewProfileEvidence } = await import('../../src/utils/interviewHelper.js');
      for (const profile of PROFILES) {
        for (const kind of ['operated', 'directPlusEither', 'evaluated', 'employerUses', 'vendor', 'either', 'optionalUse']) {
          const spec = KIND_SPECS[kind];
          const compiled = await compile(careerText(profile, [spec.line(profile)]));
          const skillCues = input => extractInterviewProfileEvidence(input).filter(item => item.entityType === 'skill').map(item => item.cue);
          // Two independent layers: the main-process projection (central inventory) and the renderer
          // extractor, which is also handed the unfiltered approved profile and must refuse on its own.
          const projection = projectInterviewHelperCareerSnapshot(compiled.snapshot);
          for (const label of spec.refused(profile)) assert(!hasName(projection.profile.skills.map(skill => skill.name), label), `${profile.key}/${kind}/projection: "${label}" must not cross the renderer boundary as a skill row`);
          for (const [layer, cues] of [['projection', skillCues(projection)], ['extractor', skillCues(compiled.snapshot)]]) {
            for (const label of spec.accepted(profile)) assert(hasName(cues, label), `${profile.key}/${kind}/${layer}: "${label}" is a direct skill and must be retrievable`);
            for (const label of spec.refused(profile)) assert(!hasName(cues, label), `${profile.key}/${kind}/${layer}: "${label}" must not be offered as a skill cue`);
          }
        }
      }
    },
  },
  {
    name: 'adaptability/relationships: the independent skills audit is shown the current sentence beside the current ledger it must verify',
    async run() {
      const REASON_KEY = { employerOwned: 'employer', employerUses: 'employer' };
      for (const profile of PROFILES) {
        for (const kind of FLIPPABLE_KINDS) {
          const nonCandidate = KIND_SPECS[kind].line(profile);
          const operated = KIND_SPECS.operated.line(profile);
          const A = await compile(careerText(profile, [nonCandidate]));
          const B = await compile(replaceLine(careerText(profile, [nonCandidate]), nonCandidate, operated));
          const promptA = buildCareerProfileAuditPrompt(A.corpus, A.profile, 'skills');
          const promptB = buildCareerProfileAuditPrompt(B.corpus, B.profile, 'skills');
          const context = `${profile.key}/${kind}`;
          assert(promptA.includes(nonCandidate) && promptA.includes('"disposition":"non-skill"') && !promptA.includes('"disposition":"skill"')
            && promptA.includes(`"nonSkillReason":"${NON_SKILL_REASONS[REASON_KEY[kind] || kind]}"`),
          `${context}: the audit of the non-candidate source must show its sentence and its non-skill record`);
          assert(promptB.includes(operated) && !promptB.includes(nonCandidate) && promptB.includes('"disposition":"skill"') && !promptB.includes('"disposition":"non-skill"')
            && promptB.includes(`"supportMode":"direct"`), `${context}: after the flip the audit must see the new sentence and the new skill record, not the old ones`);
        }
        // A qualified relationship is shown to the auditor with its group and literal slice, never as plain use.
        const qualified = await compile(careerText(profile, [KIND_SPECS.either.line(profile)]));
        const promptQ = buildCareerProfileAuditPrompt(qualified.corpus, qualified.profile, 'skills');
        assert(promptQ.includes('"relationship":"alternative"') && !promptQ.includes('"relationship":"independent"') && promptQ.includes(`"relationshipEvidence":"the ${profile.label} or the ${profile.other}"`)
          && promptQ.includes('"supportMode":"relationship-qualified"') && !promptQ.includes('"supportMode":"direct"'),
        `${profile.key}: the audit of an alternative must show the alternative relationship, its literal slice, and a non-direct support mode`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a relationship added to an earlier page\'s project by a patch must be self-contained, and is enforced like any other ledger',
    async run() {
      const patchSource = (profile, sentence) => [
        profile.name, `${profile.title} at ${profile.employer}`, `${profile.start} to ${profile.end}`, profile.duty,
        `Project ${profile.project}: an internal pilot at ${profile.employer}.`,
        `The ${profile.project} project ${sentence[0].toLowerCase()}${sentence.slice(1)}`, profile.email,
      ].map(line => `${line}\n`).join('');
      for (const profile of PROFILES) {
        // 1. A choice between two labels, stated on a later page, patched into the earlier project.
        let splitRejection = null;
        const either = SENTENCES.either.make(profile.label, profile.other, profile.condition);
        const compiled = await compile(patchSource(profile, either), {
          pageMaxSegments: 5,
          probeShard: ({ shard, options, pageIndex }) => {
            if (pageIndex !== 1) return;
            // The same patch with one member of the choice dropped: a qualifier split across batches.
            const split = structuredClone(shard);
            const { updates } = split.projectPatches[0];
            updates.technologies = updates.technologies.slice(0, 1);
            updates.technologyReferences = updates.technologyReferences.slice(0, 1);
            split.skills = split.skills.slice(0, 1);
            try { options.responseValidator(split); } catch (error) { splitRejection = error; }
          },
        });
        assert(splitRejection?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && /alternative group .* needs at least two labels/u.test(splitRejection.message),
          `${profile.key}: a patch that splits an alternative group must be rejected inside its own handoff (${splitRejection?.message})`);
        assertSnapshotApproved(compiled, `${profile.key}/patch-either`);
        const d = readDownstream(compiled);
        const [project] = d.profile.projects;
        assert(d.profile.projects.length === 1 && project.technologyReferences.length === 2
          && new Set(project.technologyReferences.map(reference => reference.relationshipGroup)).size === 1
          && project.technologyReferences.every(reference => reference.relationship === 'alternative' && reference.disposition === 'skill'),
        `${profile.key}: the patched choice must arrive whole, as one alternative group on the earlier project`);
        assert(d.projection.includes(`- Usage relationship [Project ID: ${project.id}]: alternative`), `${profile.key}: the patched relationship must reach the projection`);
        assertRefused(d, profile.label, `${profile.key}/patch-either`);
        assertRefused(d, profile.other, `${profile.key}/patch-either`);

        // 2. The same patch position flips with the sentence, on every recompile.
        const evaluated = patchSource(profile, SENTENCES.evaluated.make(profile.label, profile.purpose));
        const operated = patchSource(profile, SENTENCES.operated.make(profile.label, profile.purpose));
        const A = await compile(evaluated, { pageMaxSegments: 5 });
        const B = await compile(operated, { pageMaxSegments: 5 });
        const C = await compile(evaluated, { pageMaxSegments: 5 });
        const [dA, dB, dC] = [A, B, C].map(readDownstream);
        assert(dA.projection.includes(`- Non-skill label [Project ID: ${dA.profile.projects[0].id}]: ${profile.label}`), `${profile.key}: an evaluated technology patched into a project must be a non-skill label`);
        assertRefused(dA, profile.label, `${profile.key}/patch A`);
        assertAccepted(dB, profile.label, `${profile.key}/patch B`);
        assertRefused(dC, profile.label, `${profile.key}/patch C`);
        assert(A.snapshotId !== B.snapshotId && A.snapshotId === C.snapshotId, `${profile.key}: ids must follow the patched source`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a repair batch cannot silently resurrect a non-candidate skill that an earlier batch removed',
    async run() {
      for (const profile of PROFILES) {
        const run = await repairScenario(profile, REPAIR_SCENARIOS.evaluatedMisread);
        assertRepairRegression(run.regressions.rePromote, [/reintroduces an earlier removed capability skill/u, /regresses an earlier corrected technology ledger record/u], `${profile.key}/evaluated`);
        assertSnapshotApproved(run.result, `${profile.key}/evaluated`);
        const d = readDownstream(run.result);
        assertRefused(d, profile.label, `${profile.key}/evaluated after repair`);
        assertAccepted(d, profile.other, `${profile.key}/evaluated after repair`);
        assert(ledgerOf(d.profile, profile.label)[0].reference.disposition === 'non-skill', `${profile.key}: the corrected ledger must remain non-skill`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a repair batch cannot silently flatten or erase an alternative that an earlier batch corrected',
    async run() {
      for (const profile of PROFILES) {
        const run = await repairScenario(profile, REPAIR_SCENARIOS.flattenedAlternative);
        assertRepairRegression(run.regressions.reflatten, [/regresses an earlier corrected capability skill/u, /regresses an earlier corrected technology ledger record/u], `${profile.key}/flattened`);
        assertRepairRegression(run.regressions.erase, [/deletes an earlier corrected capability skill/u, /deletes an earlier corrected technology ledger record/u], `${profile.key}/erased`);
        assertSnapshotApproved(run.result, `${profile.key}/flattened`);
        const d = readDownstream(run.result);
        for (const label of [profile.label, profile.other]) {
          assertRefused(d, label, `${profile.key}/flattened after repair`);
          assert(ledgerOf(d.profile, label)[0].reference.relationship === 'alternative', `${profile.key}: the corrected relationship for "${label}" must stay an alternative`);
        }
        assertAccepted(d, profile.extra, `${profile.key}/flattened after repair`);
      }
    },
  },
  {
    name: 'adaptability/relationships: a repair batch cannot silently re-promote an environment or data-feed label that an earlier batch removed from the skills',
    async run() {
      for (const profile of PROFILES) {
        const run = await repairScenario(profile, REPAIR_SCENARIOS.phantomEnvironment);
        assertRepairRegression(run.regressions.restore, [/reintroduces an earlier removed capability skill/u, /reintroduces an earlier removed technology ledger record for/u], `${profile.key}/phantom`);
        assertSnapshotApproved(run.result, `${profile.key}/phantom`);
        const d = readDownstream(run.result);
        assertRefused(d, profile.site, `${profile.key}/phantom after repair`);
        assert(!ledgerOf(d.profile, profile.site).length && !d.profile.skills.some(skill => skill.name === profile.site), `${profile.key}: the removed label must not return in the ledger or the skills`);
        assertRefused(d, profile.label, `${profile.key}/phantom after repair`);
        assertAccepted(d, profile.extra, `${profile.key}/phantom after repair`);
      }
    },
  },
  {
    name: 'adaptability/relationships [fixed defect]: validateCareerProfile: a direct skill whose only direct evidence is a non-skill ledger sentence is accepted',
    async run() {
      for (const profile of PROFILES) {
        const compiled = await compile(careerText(profile, [KIND_SPECS.evaluated.line(profile)]));
        const forged = structuredClone(compiled.profile);
        const segmentId = forged.achievements.find(item => item.technologies.length).evidenceSegmentIds[0];
        forged.skills.push({
          id: 'skill-forged', name: profile.label, category: 'equipment', capabilityKind: 'tool', supportMode: 'direct',
          directEvidenceSegmentIds: [segmentId], indexEligible: true, roleIds: [forged.roles[0].id], evidenceSegmentIds: [segmentId],
        });
        forged.roles[0].skillIds.push('skill-forged');
        forged.segmentCoverage.find(entry => entry.segmentId === segmentId).entityIds.push('skill-forged');
        const result = validateCareerProfile(forged, compiled.corpus);
        assert(!result.valid, `${profile.key}: the host ledger says "${profile.label}" is a non-skill in the only sentence that mentions it, yet validateCareerProfile accepted a direct, index-eligible skill row (inventory: ${vettedCareerSkillInventory(forged).map(skill => skill.name)})`);
      }
    },
  },
  {
    name: 'adaptability/relationships [fixed defect]: validateCareerProfile: a skill can be attributed to a role whose only ledger record for it is a non-skill',
    async run() {
      for (const profile of PROFILES) {
        const text = twoRoleText(profile, SENTENCES.evaluated.make(profile.label, profile.purpose), SENTENCES.operated.make(profile.label, profile.purpose));
        const compiled = await compile(text, { pageMaxSegments: 5 });
        const forged = structuredClone(compiled.profile);
        const skill = forged.skills.find(item => item.name === profile.label);
        const evaluatingRole = forged.roles[0];
        const evaluatedSegment = forged.achievements.find(item => item.roleId === evaluatingRole.id && item.technologies.length).evidenceSegmentIds[0];
        skill.roleIds.push(evaluatingRole.id);
        evaluatingRole.skillIds.push(skill.id);
        skill.evidenceSegmentIds.push(evaluatedSegment);
        forged.segmentCoverage.find(entry => entry.segmentId === evaluatedSegment).entityIds.push(skill.id);
        const result = validateCareerProfile(forged, compiled.corpus);
        assert(!result.valid, `${profile.key}: "${profile.label}" was only evaluated in role ${evaluatingRole.id}, yet the profile validates with that role claiming it as a skill`);
      }
    },
  },
  {
    name: 'adaptability/relationships [fixed defect]: structuredResume authority mode: a non-skill label is accepted as a skills item whenever careerSkillEvidence is omitted',
    async run() {
      const profile = PROFILES[0];
      const d = readDownstream(await compile(careerText(profile, [KIND_SPECS.evaluated.line(profile)])));
      const titleCased = profile.label.replace(/\b\p{L}/gu, letter => letter.toUpperCase());
      const { resume, context } = resumeFor(d, []);
      resume.skills = [{ id: 'skills-1', group: 'Tools', items: [titleCased], evidenceIds: mentionCatalogIds(d.catalog, profile.label).slice(0, 1) }];
      let accepted = true;
      try { validateStructuredApplicationResume(resume, { ...context, careerSkillEvidence: null }); } catch { accepted = false; }
      assert(!accepted, 'authority mode must fail closed on a missing approved skill inventory instead of treating a cited non-skill label as an ATS skill');
    },
  },
  {
    name: 'adaptability/relationships [fixed defect]: compileAuditedCareerSnapshot: one technology that is direct on one page and relationship-qualified on another cannot converge without a spurious edit',
    async run() {
      const profile = PROFILES[4];
      for (const order of ['direct-first', 'qualified-first']) {
        const direct = SENTENCES.operated.make(profile.label, profile.purpose);
        const qualified = SENTENCES.whenAvailable.make(profile.label);
        const [first, later] = order === 'direct-first' ? [direct, qualified] : [qualified, direct];
        const qualifiedPage = order === 'direct-first' ? 1 : 0;
        const compiled = await compile(twoRoleText(profile, first, later), {
          pageMaxSegments: 5,
          repair: faithfulDuplicateRepair(qualifiedPage),
        });
        assertAccepted(readDownstream(compiled), profile.label, `${profile.key}/${order}`);
      }
    },
  },
  {
    name: 'adaptability/relationships [fixed defect]: compileAuditedCareerSnapshot: the same direct technology on two pages with differently worded skill categories cannot converge without a spurious edit',
    async run() {
      const profile = PROFILES[1];
      const compiled = await compile(twoRoleText(profile, SENTENCES.operated.make(profile.label, profile.purpose), SENTENCES.operated.make(profile.label, 'monitor day-to-day throughput')), {
        pageMaxSegments: 5,
        // The two pages' compiling models word the free-text category differently.
        probeShard: ({ shard, pageIndex }) => { if (pageIndex === 1) shard.skills.forEach(skill => { skill.category = 'instrument'; }); },
        repair: faithfulDuplicateRepair(1),
      });
      assertAccepted(readDownstream(compiled), profile.label, `${profile.key}/category-drift`);
    },
  },
];

// ---------------------------------------------------------------------------
// Repair scenarios. A first compile makes a semantic misreading that the
// deterministic gates cannot see (the stand-in model is wrong in a way that is
// still structurally consistent); the independent skills audit reports it; two
// finding batches then repair the page. While the SECOND batch is in flight,
// each "careless" candidate replacement is handed to the real handoff validator
// to prove that production refuses to undo what the first batch corrected.
// ---------------------------------------------------------------------------
const FINDING_FILLER = 'evidence '.repeat(110);
const REPAIR_SCENARIOS = {
  // An evaluated product is misread as a used skill; a later batch re-promotes it.
  evaluatedMisread: {
    text: p => careerText(p, [SENTENCES.evaluated.make(p.label, p.purpose), SENTENCES.operated.make(p.other, p.purpose)]),
    misread: ({ profile, correct, segment }) => {
      const shard = correct();
      const reference = shard.achievements.flatMap(item => item.technologyReferences).find(item => item.technology === profile.label);
      reference.disposition = 'skill'; delete reference.nonSkillReason;
      addSkillRow(shard, { name: profile.label, segmentId: segment('Evaluated') });
      return shard;
    },
    findings: ({ profile, segment }) => [
      { segmentIds: [segment('Evaluated')], entityIds: [`p0001-skill-${slug(profile.label)}`], detail: 'The evaluated product is not a candidate capability; remove the skill row and keep the non-skill ledger.' },
      { segmentIds: [segment('Operated')], entityIds: [`p0001-skill-${slug(profile.other)}`], detail: 'Reclassify the operated equipment category.' },
    ],
    fixOther: (shard, profile) => { shard.skills.find(skill => skill.name === profile.other).category = 'instrument'; return shard; },
    careless: ({ profile, build, fixOther }) => ({ rePromote: () => fixOther(build.misread(), profile) }),
  },
  // "A or B" is misread as simultaneous direct use of both; a later batch flattens it again or drops it.
  flattenedAlternative: {
    text: p => careerText(p, [SENTENCES.either.make(p.label, p.other, p.condition), SENTENCES.operated.make(p.extra, p.purpose)]),
    misread: ({ profile, correct }) => flattenChoice(correct(), profile),
    findings: ({ profile, segment }) => [
      { segmentIds: [segment('Used the')], entityIds: [`p0001-skill-${slug(profile.label)}`, `p0001-skill-${slug(profile.other)}`], detail: 'The two labels were a choice, not simultaneous use; keep the alternative relationship and make them non-direct.' },
      { segmentIds: [segment('Operated')], entityIds: [`p0001-skill-${slug(profile.extra)}`], detail: 'Reclassify the operated equipment category.' },
    ],
    fixOther: (shard, profile) => { shard.skills.find(skill => skill.name === profile.extra).category = 'instrument'; return shard; },
    careless: ({ profile, build, fixOther }) => ({
      reflatten: () => flattenChoice(fixOther(build.correct(), profile), profile),
      erase: () => {
        const shard = fixOther(build.correct(), profile);
        const gone = new Set([profile.label, profile.other]);
        const choice = shard.achievements.find(item => item.technologies.includes(profile.label));
        choice.technologies = []; choice.technologyReferences = [];
        const removedIds = shard.skills.filter(skill => gone.has(skill.name)).map(skill => skill.id);
        shard.skills = shard.skills.filter(skill => !gone.has(skill.name));
        for (const role of shard.roles) role.skillIds = role.skillIds.filter(id => !removedIds.includes(id));
        return shard;
      },
    }),
  },
  // An environment/data-feed noun that sits inside a sentence is misread as a used tool.
  phantomEnvironment: {
    text: p => careerText(p, [SENTENCES.either.make(p.label, p.other, p.condition), SENTENCES.operated.make(p.extra, p.purpose)]),
    misread: ({ profile, correct, segment }) => {
      const shard = correct();
      const choice = shard.achievements.find(item => item.technologies.includes(profile.label));
      choice.technologies.push(profile.site);
      choice.technologyReferences.push({
        technology: profile.site, disposition: 'skill', relationship: 'independent', relationshipGroup: '', relationshipEvidence: profile.site, evidenceSegmentIds: [segment('Used the')],
      });
      addSkillRow(shard, { name: profile.site, segmentId: segment('Used the'), category: 'environment' });
      return shard;
    },
    findings: ({ profile, segment }) => [
      { segmentIds: [segment('Used the')], entityIds: [`p0001-skill-${slug(profile.site)}`], detail: 'An environment or data feed named inside a sentence is not a candidate capability; remove the skill and its ledger record.' },
      { segmentIds: [segment('Operated')], entityIds: [`p0001-skill-${slug(profile.extra)}`], detail: 'Reclassify the operated equipment category.' },
    ],
    fixOther: (shard, profile) => { shard.skills.find(skill => skill.name === profile.extra).category = 'instrument'; return shard; },
    careless: ({ profile, build, fixOther }) => ({ restore: () => fixOther(build.misread(), profile) }),
  },
};

function addSkillRow(shard, { name, segmentId, category = 'equipment' }) {
  const id = `skill-${slug(name)}`;
  shard.skills.push({
    id, name, category, capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: [segmentId],
    indexEligible: true, roleIds: [shard.roles[0].id], evidenceSegmentIds: [segmentId],
  });
  shard.roles[0].skillIds.push(id);
}

// Turn the correct (alternative) reading of the choice sentence into simultaneous direct use.
function flattenChoice(shard, profile) {
  const choice = shard.achievements.find(item => item.technologies.includes(profile.label));
  for (const reference of choice.technologyReferences) Object.assign(reference, { relationship: 'independent', relationshipGroup: '' });
  for (const skill of shard.skills.filter(item => [profile.label, profile.other].includes(item.name))) {
    Object.assign(skill, { supportMode: 'direct', indexEligible: true, directEvidenceSegmentIds: [...skill.evidenceSegmentIds] });
  }
  return shard;
}

function assertRepairRegression(error, patterns, context) {
  assert(error?.code === 'CAREER_SNAPSHOT_PAGE_INVALID' && error.validationDiagnostic?.reason === 'CAREER_PAGE_REPAIR_REGRESSION' && patterns.every(pattern => pattern.test(error.message)),
    `${context}: a later batch that undoes the earlier correction must be rejected as a repair regression matching ${patterns.join(' & ')} (${error?.code} ${error?.validationDiagnostic?.reason} ${error?.message})`);
}

async function repairScenario(profile, scenario) {
  const files = sourceFiles(scenario.text(profile));
  const corpus = buildCareerSourceCorpus(files);
  const [page] = partitionCareerSourcePages(corpus);
  const segment = prefix => corpus.segments.find(item => item.text.startsWith(prefix)).id;
  const correct = () => standInShard(page.segments);
  const context = { profile, correct, segment };
  const build = { correct, misread: () => scenario.misread(context) };
  const findings = scenario.findings(context).map((finding, index) => ({
    id: `finding-${index + 1}`, severity: 'warning', category: 'skills', ...finding, detail: `${finding.detail} ${FINDING_FILLER}`.slice(0, 1_200),
  }));
  const careless = scenario.careless({ profile, build, fixOther: scenario.fixOther });
  // Finding batches are sized by the prompt budget; search for the budget that
  // splits these two findings rather than hard-coding a production number.
  for (let maxPromptChars = 9_000; maxPromptChars <= 16_000; maxPromptChars += 250) {
    let auditPass = 0;
    let repairCalls = 0;
    const regressions = {};
    try {
      const result = await compileAuditedCareerSnapshot({
        sourceFiles: files, maxPromptChars,
        callText: async (_prompt, options) => {
          if (options.task === 'career-profile-compile') return build.misread();
          if (options.task === 'career-profile-audit-skills') return auditPass++ === 0 ? { findings } : { findings: [] };
          if (options.task?.startsWith('career-profile-audit-')) return { findings: [] };
          if (options.task === 'career-profile-repair') {
            if (repairCalls++ === 0) return correct();
            // Careless second batches: each is judged by the real handoff validator.
            for (const [name, candidate] of Object.entries(careless)) {
              try { options.responseValidator(candidate()); regressions[name] = null; } catch (error) { regressions[name] = error; }
            }
            return scenario.fixOther(correct(), profile);
          }
          throw new Error(`Unexpected task ${options.task}`);
        },
      });
      if (repairCalls === 2) return { result: { ...result, corpus }, repairCalls, regressions, maxPromptChars };
      if (repairCalls < 2) break;
    } catch (error) {
      if (error?.code !== 'CAREER_SNAPSHOT_PROMPT_TOO_LARGE') throw error;
    }
  }
  throw new Error(`${profile.key}: no prompt budget split the two findings into two repair batches`);
}

// ---------------------------------------------------------------------------
// Known production gaps: none. Every gap recorded here was fixed and its assertion
// moved into the default export as a `[fixed defect]` test. An unfixed gap goes in
// `knownGaps`; the registry does not run it, so each entry must throw today.
// ---------------------------------------------------------------------------
export const knownGaps = [];

// A faithful repair model for a duplicate skill row: it fixes only the page that
// owns the redundant row and returns the already-correct page as it is.
function faithfulDuplicateRepair(redundantPage) {
  return ({ options, pages }) => {
    const shard = standInShard(pages[options.hints.pageIndex].segments);
    if (options.hints.pageIndex === redundantPage) { shard.skills = []; shard.roles.forEach(role => { role.skillIds = []; }); }
    options.responseValidator(shard);
    return shard;
  };
}
