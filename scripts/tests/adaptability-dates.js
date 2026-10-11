// Adaptability family: DATES / TENURE / CHRONOLOGY.
//
// Three-way separation this file serves:
//   1. generic production invariants  - a date, range, "Present", or span of years
//      in any generated claim must be traceable to accepted career evidence and
//      can never exceed it;
//   2. dynamic runtime constraints    - what is claimable is derived from the CURRENT
//      approved snapshot, so a recompiled source that gains (or loses) a dated role
//      or a stated span moves the boundary automatically;
//   3. acceptance-only truth          - none here: every fixture is synthetic and the
//      expected verdicts are decided by the real production code, never by a list
//      in this file.
//
// Method. Each synthetic candidate is rendered to plain career-file text, built into
// a real corpus (buildCareerSourceCorpus), compiled into a profile by a small
// deterministic stand-in for the AI compiler (it only transcribes lines it finds and
// cites their segments), and then ADMITTED through the real gate
// (validateCurrentCareerSnapshot). Everything downstream reads that approved snapshot:
// approvedCareerEvidenceCatalog, buildApplicationCareerAuthority,
// projectLegacyCareerProfile, calculateDatedTenure, validateAndNormalizeFitAssessment,
// assertSourceQuoteLinksFinalText, pasteAttributionScopeErrors,
// validateStructuredResumeDraft, checkEndedRoleCurrentEmployment, and the role
// presentation order. Each family runs the A / B / C mutation:
//   A = source without the evidence, B = A plus directly supported evidence (a new
//   corpus and snapshot id), C = B with exactly that evidence removed again.
//
// Clock. Every production call that can read "today" receives an explicit clock
// (AS_OF / REFERENCE). One test additionally replaces the process clock with two
// different fake clocks to prove the explicit seams do not secretly read it.
//
// Oracles. Expected verdicts come from the real production code wherever the question
// is "what does the gate decide for this source". Where the question is "is the
// derived number right", the expectation is independent calendar arithmetic over the
// fixture's own dates (oracleTenure, endKey, the month sweeps), never a call back
// into the code under test. Each rejection asserts the specific check that raised it
// (the field named in a grounding error, the rule id, the attributed year and
// employer, the "claims an experience span" message), so a rejection for an unrelated
// reason cannot satisfy it.
//
// Fixtures. Five unrelated synthetic people write dates differently (long month names,
// ISO, short month names, bare years); three have an earlier role that began or ended
// in the 1990s. Besides roles and education each source may carry a certification, a
// stated span of experience, and two short nested engagements (chronology tests).
//
// Tests tagged `[fixed defect]` guard gaps this sweep found and production has since
// fixed. `knownGaps` (not run by the registry) holds the one assertion production still
// fails on purpose: a deliberate span policy (see its entry). The comment above each
// `[fixed defect]` test describes the defect as it was before the fix.
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
  projectLegacyCareerProfile,
  validateCareerProfile,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority, resolveAuthorityEvidence } from '../../electron/ipc/applicationCareerAuthority.js';
import { calculateDatedTenure, validateAndNormalizeFitAssessment } from '../../electron/ipc/jobFitAssessment.js';
import { checkEndedRoleCurrentEmployment, findUnsupportedDurationClaim } from '../../electron/ipc/coverLetterChecks.js';
import { formatRoleDateForPresentation, validateStructuredResumeDraft } from '../../electron/ipc/structuredResume.js';
import { __selectedSourceRolesForTests, assertSourceQuoteLinksFinalText, pasteAttributionScopeErrors } from '../../electron/ipc/localAiApplication.js';

// ---------------------------------------------------------------------------
// Clock: explicit everywhere. 15 June 2026 is only a fixed point to measure from.
// ---------------------------------------------------------------------------
const AS_OF = new Date(Date.UTC(2026, 5, 15));
const REFERENCE = '2026-06-15T00:00:00.000Z';

function withSystemClock(isoInstant, fn) {
  const RealDate = Date;
  const fixed = RealDate.parse(isoInstant);
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
    // Keep `x instanceof Date` true for real instances created outside the scope.
    static [Symbol.hasInstance](value) { return Object.prototype.isPrototypeOf.call(RealDate.prototype, value); }
  }
  globalThis.Date = FakeDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

// ---------------------------------------------------------------------------
// Synthetic candidates. Unrelated domains, formats, and job listings. No role
// below shares a calendar year with a different role of the same person, and each
// person has an employment gap, so "year belongs to the other role" is decidable.
// Three people have an earlier role that began or ended in the 1990s, so nothing
// here depends on every date sharing a century.
// ---------------------------------------------------------------------------
const PROFILES = [
  {
    key: 'nurse', fmt: 'long', name: 'Marisol Quenby', email: 'marisol.quenby@example.test',
    current: { id: 'role-charge', title: 'Charge Nurse', employer: 'Harbor Valley Medical Center', start: { y: 2017, m: 3 }, end: 'present', achievement: 'Coordinated bedside handoffs across a twenty eight bed cardiac unit.' },
    earlier: { id: 'role-staff', title: 'Staff Nurse', employer: 'Lantern Hill Hospital', start: { y: 2008, m: 6 }, end: { y: 2015, m: 11 }, achievement: 'Precepted new graduate nurses on a surgical ward.' },
    edu: { credential: 'Bachelor of Science in Nursing', institution: 'Riverbend State University', dates: '2003 – 2007' },
    cert: { name: 'Basic Life Support Provider', issuer: 'Cascade Resuscitation Council', date: { y: 2021, m: 5 } },
    span: { n: 14, domain: 'clinical nursing' },
    job: { title: 'Clinical Nurse Manager', company: 'Alder Point Health', domain: 'clinical nursing' },
  },
  {
    key: 'chef', fmt: 'iso', name: 'Teodoro Brightwater', email: 'teodoro.brightwater@example.test',
    current: { id: 'role-exec', title: 'Executive Pastry Chef', employer: 'Saffron and Salt Bakery', start: { y: 2019, m: 4 }, end: 'present', achievement: 'Designed the seasonal laminated dough program for three retail counters.' },
    earlier: { id: 'role-cook', title: 'Pastry Cook', employer: 'Maison Verdelle', start: { y: 1992, m: 9 }, end: { y: 1998, m: 6 }, achievement: 'Produced plated desserts for a ninety seat dining room.' },
    edu: { credential: 'Diploma in Pastry Arts', institution: 'Hartwell Culinary Institute', dates: '1988 – 1990' },
    cert: { name: 'Food Protection Manager Certificate', issuer: 'Pacific Food Safety Board', date: { y: 2020, m: 2 } },
    span: { n: 11, domain: 'professional pastry' },
    job: { title: 'Head of Pastry', company: 'Quince and Thistle Hospitality', domain: 'pastry production' },
  },
  {
    key: 'engineer', fmt: 'short', name: 'Ingrid Valdemar-Okoro', email: 'ingrid.valdemar@example.test',
    current: { id: 'role-project', title: 'Project Engineer', employer: 'Granite Ridge Consultants', start: { y: 2016, m: 8 }, end: { y: 2022, m: 12 }, achievement: 'Checked steel connection calculations for mid rise parking structures.' },
    earlier: { id: 'role-junior', title: 'Junior Engineer', employer: 'Cobalt Span Engineering', start: { y: 2010, m: 9 }, end: { y: 2015, m: 7 }, achievement: 'Drafted bridge bearing details under a licensed engineer.' },
    edu: { credential: 'Master of Science in Civil Engineering', institution: 'Ashford Institute of Technology', dates: '2006 – 2009' },
    cert: { name: 'Professional Engineer License', issuer: 'State Board of Engineering Examiners', date: { y: 2014, m: 4 } },
    span: { n: 11, domain: 'structural design' },
    job: { title: 'Senior Structural Engineer', company: 'Keystone Civil Group', domain: 'structural engineering' },
  },
  {
    key: 'warehouse', fmt: 'year', name: 'Bashir Tolliver', email: 'bashir.tolliver@example.test',
    current: { id: 'role-shift', title: 'Shift Supervisor', employer: 'Northgate Distribution', start: { y: 2020, m: 1 }, end: 'present', achievement: 'Scheduled dock crews for inbound and outbound trailers.' },
    earlier: { id: 'role-forklift', title: 'Forklift Operator', employer: 'Redline Freight', start: { y: 1997, m: 1 }, end: { y: 2003, m: 12 }, achievement: 'Staged pallets for next day delivery routes.' },
    edu: { credential: 'Certificate in Logistics Management', institution: 'Eastfield Community College', dates: '1993 – 1995' },
    cert: { name: 'Powered Industrial Truck Operator Card', issuer: 'Safe Handling Institute', date: { y: 2000, m: 3 } },
    span: { n: 11, domain: 'warehouse operations' },
    job: { title: 'Distribution Operations Lead', company: 'Fairwind Logistics', domain: 'distribution operations' },
  },
  {
    key: 'analyst', fmt: 'long', name: 'Priya Ashdown', email: 'priya.ashdown@example.test',
    current: { id: 'role-senior', title: 'Senior Data Analyst', employer: 'Tidewell Mutual', start: { y: 2018, m: 1 }, end: 'present', achievement: 'Built weekly claims dashboards for the underwriting team.' },
    earlier: { id: 'role-analyst', title: 'Reporting Analyst', employer: 'Corvid Logistics', start: { y: 1991, m: 2 }, end: { y: 1999, m: 9 }, achievement: 'Reconciled monthly freight invoices against carrier statements.' },
    edu: { credential: 'Bachelor of Arts in Economics', institution: 'Lakeshore University', dates: '1986 – 1990' },
    cert: { name: 'Certified Analytics Practitioner', issuer: 'Applied Statistics Society', date: { y: 2019, m: 10 } },
    span: { n: 13, domain: 'analytics' },
    job: { title: 'Lead Analytics Consultant', company: 'Brightmoor Retail', domain: 'analytics' },
  },
];
const MONTH_PRECISE = PROFILES.filter(profile => profile.fmt !== 'year');

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const pad2 = value => String(value).padStart(2, '0');
const capitalize = word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
const lowerFirst = text => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
const stripPeriod = text => text.replace(/\.$/u, '');

function formatDate(date, format) {
  if (date === 'present') return 'Present';
  if (format === 'long') return `${LONG_MONTHS[date.m - 1]} ${date.y}`;
  if (format === 'short') return `${SHORT_MONTHS[date.m - 1]} ${date.y}`;
  if (format === 'sept') return `${date.m === 9 ? 'Sept' : SHORT_MONTHS[date.m - 1]} ${date.y}`;
  if (format === 'iso') return `${date.y}-${pad2(date.m)}`;
  if (format === 'isoSlash') return `${date.y}/${pad2(date.m)}`;
  if (format === 'isoDay') return `${date.y}-${pad2(date.m)}-15`;
  if (format === 'longComma') return `${LONG_MONTHS[date.m - 1]}, ${date.y}`;
  if (format === 'upper') return `${LONG_MONTHS[date.m - 1].toUpperCase()} ${date.y}`;
  if (format === 'slashMonthFirst') return `${date.m}/${date.y}`;
  return String(date.y);
}

const spanLine = (spec, years = spec.span.n) => `${capitalize(NUMBER_WORDS[years])} years of ${spec.span.domain} experience`;
const datesLine = (role, format) => `${formatDate(role.start, format)} – ${formatDate(role.end, format)}`;
const headerLine = role => `${role.title}, ${role.employer}`;
const eduHeaderLine = spec => `${spec.edu.credential}, ${spec.edu.institution}`;
const certHeaderLine = spec => `${spec.cert.name}, ${spec.cert.issuer}`;
const certDateLine = spec => formatDate(spec.cert.date, spec.fmt);
const roleLines = (role, format) => [headerLine(role), datesLine(role, format), role.achievement];

// Two short side engagements used by the chronology tests, both wholly inside a longer
// role. Each STARTS later than the role that contains it but ENDS earlier, so ordering
// by start month and ordering by end month disagree for them. The one inside the
// earlier role ends in the same calendar year as that role, one month sooner (the same
// year, hence a tie, when the source writes bare years), so the month and the tie-break
// both matter.
function insideRoles(spec) {
  const surname = spec.name.split(' ').at(-1).split('-')[0];
  const employer = id => `${surname} Learning Collective ${id.slice(-1).toUpperCase()}`;
  return {
    insideCurrent: {
      id: 'role-side-a', title: 'Visiting Instructor', employer: employer('role-side-a'), achievement: 'Taught weekend certification classes to adult learners.',
      start: { y: spec.current.start.y + 1, m: spec.current.start.m }, end: { y: spec.current.start.y + 2, m: spec.current.start.m },
    },
    insideEarlier: {
      id: 'role-side-b', title: 'Evening Tutor', employer: employer('role-side-b'), achievement: 'Coached apprentices through their written examinations.',
      start: { y: spec.earlier.start.y + 1, m: spec.earlier.start.m }, end: { y: spec.earlier.end.y, m: spec.earlier.end.m - 1 },
    },
  };
}

/** The roles one rendering lists, in source order (`reverse` flips the whole list). */
function rolesFor(spec, { earlier = false, inside = false, reverse = false } = {}) {
  const { insideCurrent, insideEarlier } = insideRoles(spec);
  const roles = [spec.current, ...(inside ? [insideCurrent] : []), ...(earlier ? [spec.earlier] : []), ...(inside ? [insideEarlier] : [])];
  return reverse ? roles.reverse() : roles;
}

/** Plain career-file lines for one rendering. `reverse` lists the earlier role first. */
function sourceLines(spec, flags = {}) {
  const lines = [spec.name, spec.email];
  if (flags.spanYears != null) lines.push(spanLine(spec, flags.spanYears));
  for (const role of rolesFor(spec, flags)) lines.push(...roleLines(role, spec.fmt));
  lines.push(eduHeaderLine(spec), spec.edu.dates);
  if (flags.cert) lines.push(certHeaderLine(spec), certDateLine(spec));
  return lines;
}
const linesToText = lines => `${lines.join('\n')}\n`;
const removeLines = (text, lines) => linesToText(text.split('\n').filter(Boolean).filter(line => !lines.includes(line)));

// ---------------------------------------------------------------------------
// Compile + approve (deterministic stand-in for the AI compiler; the real gate
// below decides whether it is acceptable).
// ---------------------------------------------------------------------------
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function corpusFromText(text) {
  return buildCareerSourceCorpus([{ name: 'Career History.md', contentHash: sha256(text), text, legacyText: text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
}

function segmentIdFor(corpus, line) {
  const segment = corpus.segments.find(item => item.text.trim() === line);
  if (!segment) throw new Error(`fixture source has no line ${JSON.stringify(line)}`);
  return segment.id;
}

function profileFromCorpus(corpus, spec, flags) {
  const owners = new Map();
  const cite = (entityId, segmentIds) => { for (const id of segmentIds) owners.set(id, [...(owners.get(id) || []), entityId]); return segmentIds; };
  const roles = rolesFor(spec, flags);
  const profile = {
    identity: { name: spec.name, contacts: [spec.email], evidenceSegmentIds: cite('identity', [segmentIdFor(corpus, spec.name), segmentIdFor(corpus, spec.email)]) },
    roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
  for (const role of roles) {
    const achievementId = `ach-${role.id}`;
    const ownLines = roleLines(role, spec.fmt);
    profile.roles.push({
      id: role.id, title: role.title, employer: role.employer, startDate: formatDate(role.start, spec.fmt), endDate: formatDate(role.end, spec.fmt), location: '',
      achievementIds: [achievementId], skillIds: [], evidenceSegmentIds: cite(role.id, ownLines.map(line => segmentIdFor(corpus, line))),
    });
    profile.achievements.push({
      id: achievementId, roleId: role.id, claim: role.achievement, technologies: [], technologyReferences: [], metrics: [],
      evidenceSegmentIds: cite(achievementId, [segmentIdFor(corpus, role.achievement)]),
    });
  }
  profile.education.push({
    id: 'edu-1', institution: spec.edu.institution, credential: spec.edu.credential, dates: spec.edu.dates,
    evidenceSegmentIds: cite('edu-1', [segmentIdFor(corpus, eduHeaderLine(spec)), segmentIdFor(corpus, spec.edu.dates)]),
  });
  if (flags.cert) {
    profile.certifications.push({
      id: 'cert-1', name: spec.cert.name, issuer: spec.cert.issuer, dates: certDateLine(spec),
      evidenceSegmentIds: cite('cert-1', [segmentIdFor(corpus, certHeaderLine(spec)), segmentIdFor(corpus, certDateLine(spec))]),
    });
  }
  if (flags.spanYears != null) {
    profile.otherEvidence.push({
      id: 'other-span', kind: 'summary', label: 'experience', text: spanLine(spec, flags.spanYears),
      evidenceSegmentIds: cite('other-span', [segmentIdFor(corpus, spanLine(spec, flags.spanYears))]),
    });
  }
  profile.segmentCoverage = corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'context', entityIds: owners.get(segment.id) || [] }));
  return profile;
}

function cleanAuditHistory(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  const deterministicFailureDigest = sha256(canonicalJson([]));
  const audits = [
    ['coverage', 'career-profile-audit-completeness'], ['grounding', 'career-profile-audit-grounding'],
    ['attribution', 'career-profile-audit-attribution'], ['metrics', 'career-profile-audit-metrics'],
    ['skills', 'career-profile-audit-skills'], ['conflict', 'career-profile-audit-conflicts'],
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
  const unresolvedFindingDigest = sha256(canonicalJson({ deterministicFailureDigest, audits: audits.map(audit => ({ category: audit.category, findingCount: audit.findingCount, findingDigest: audit.findingDigest })) }));
  return [{
    round: 0, profileDigest, unresolvedFindingDigest, stateDigest: sha256(canonicalJson({ profileDigest, unresolvedFindingDigest })),
    deterministicFailureCount: 0, deterministicFailureDigest, deterministicFailures: [], audits, unresolvedCount: 0,
  }];
}

function approvedSnapshotEnvelope(corpus, profile) {
  const pages = partitionCareerSourcePages(corpus);
  return {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION, status: 'approved', snapshotId: careerSnapshotId(corpus), inputFingerprint: corpus.inputFingerprint,
    sourceFingerprint: corpus.sourceFingerprint, compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    pagePlan: { maxSegments: 32, maxSourceChars: 48_000, pageCount: pages.length, pageDigest: sha256(canonicalJson(pages.map(page => ({ id: page.id, index: page.index, segmentIds: page.segmentIds })))) },
    reconciliation: emptyCareerReconciliationReceipt(), approvedAt: '2026-10-07T00:00:00.000Z', sources: corpus.sources, segments: corpus.segments,
    profile, auditHistory: cleanAuditHistory(corpus, profile),
  };
}

const compiled = new Map();
/** Build, ADMIT through the real snapshot gate, and cache one source rendering. */
function compile(spec, flags = {}, textOverride = null) {
  const text = textOverride ?? linesToText(sourceLines(spec, flags));
  const cacheKey = `${spec.key}\u0001${canonicalJson(flags)}\u0001${spec.current.start.y}\u0001${canonicalJson(spec.current.end)}\u0001${text}`;
  if (compiled.has(cacheKey)) return compiled.get(cacheKey);
  const corpus = corpusFromText(text);
  const profile = profileFromCorpus(corpus, spec, flags);
  const snapshot = approvedSnapshotEnvelope(corpus, profile);
  const verdict = validateCurrentCareerSnapshot(snapshot);
  assert(verdict.valid, `${spec.key}: fixture snapshot must pass the production admission gate: ${verdict.errors.slice(0, 3).join(' | ')}`);
  const result = { spec, flags, text, corpus, profile, snapshot, catalog: approvedCareerEvidenceCatalog(snapshot), authority: buildApplicationCareerAuthority(snapshot) };
  compiled.set(cacheKey, result);
  return result;
}

/** A, B (= A plus an earlier role), C (= B with exactly that role's lines removed, recompiled). */
function mutationTriple(spec) {
  const a = compile(spec, {});
  const b = compile(spec, { earlier: true });
  const removedText = removeLines(b.text, roleLines(spec.earlier, spec.fmt));
  assert(removedText === a.text, `${spec.key}: removing the added role's lines from B must reproduce A's source byte for byte`);
  const c = compile(spec, {}, removedText);
  return { a, b, c };
}

// A faithful structured résumé draft built from one approved snapshot: every trusted role with its own achievement
// cited, plus (when the source has them) the education and certification records citing all of their own evidence.
function resumeDraft(item, { mutateRoles = null, mutate = null } = {}) {
  const roles = item.authority.sourceRoles.map(role => ({
    id: role.id, title: role.title, company: role.company, dates: role.dates, location: role.location,
    bullets: [{ id: `bullet-${role.id}`, text: item.profile.achievements.find(achievement => achievement.roleId === role.id).claim, evidenceIds: [evidenceIds(item.catalog, `host.career.achievement.ach-${role.id}.`)[0]] }],
  }));
  if (mutateRoles) mutateRoles(roles);
  const draft = {
    schemaVersion: 'structured-resume.v1', identity: { name: item.authority.identity.name, contact: [...item.authority.identity.contact] }, roles,
    education: item.profile.education.map(entry => ({ id: entry.id, credential: entry.credential, institution: entry.institution, dates: entry.dates, evidenceIds: evidenceIds(item.catalog, `host.career.education.${entry.id}.`) })),
    credentials: item.profile.certifications.map(entry => ({ id: entry.id, name: entry.name, issuer: entry.issuer, dates: entry.dates, evidenceIds: evidenceIds(item.catalog, `host.career.certification.${entry.id}.`) })),
  };
  if (mutate) mutate(draft);
  return draft;
}
const validateResume = (item, draft) => validateStructuredResumeDraft(draft, {
  sourceRoles: item.authority.sourceRoles, evidenceCatalog: item.catalog, trustedIdentity: item.authority.identity,
  careerData: projectApprovedCareerSnapshotForApplication(item.snapshot), authorityMode: true,
});

const settle = fn => { try { return { value: fn(), error: null }; } catch (error) { return { value: null, error }; } };
const rejects = (fn, pattern = null) => { const { error } = settle(fn); return Boolean(error) && (!pattern || pattern.test(String(error?.message || error))); };
// Known-gap assertions report EVERY profile that violates the invariant, so a partial fix cannot hide the rest.
function assertNoViolations(invariant, items, violates) {
  const violations = items.map(item => violates(item)).filter(Boolean);
  assert(violations.length === 0, `${invariant}; violated for ${violations.length}/${items.length}: ${violations.join(' || ')}`);
}
const isGroundingError = (error, label, field) => error.includes(`${label}.${field}`) && /not grounded/u.test(error);
const careerQuotes = (catalog, prefix) => catalog.filter(entry => entry.id.startsWith(prefix)).map(entry => entry.quote);
const evidenceIds = (catalog, prefix) => catalog.filter(entry => entry.id.startsWith(prefix)).map(entry => entry.id);
const roleDatesEntry = (catalog, roleId) => catalog.find(entry => entry.id.startsWith(`host.career.role.${roleId}.`) && entry.quote.startsWith('Dates: '));
const legacyHistory = (snapshot, referenceDate = AS_OF) => projectLegacyCareerProfile(snapshot.profile, { referenceDate });
const tenureOf = (snapshot, asOf = AS_OF) => calculateDatedTenure(legacyHistory(snapshot, asOf).workHistory, { asOf });

// A calendar bound derived from first principles, not from the tenure code: a role set
// can never span more months than lie between its earliest start and the clock.
const calendarBoundMonths = (earliestStart, asOf = AS_OF) => (asOf.getUTCFullYear() - earliestStart.y) * 12 + (asOf.getUTCMonth() + 1 - earliestStart.m) + 1;

// An independent oracle for dated tenure: calendar arithmetic over the fixture's own
// numbers, never a call into the tenure code. A date is known only to the precision
// the source wrote it: a month pins the month but not the day, a bare year pins only
// the year, and "Present" is the explicit clock's month. A role from a start somewhere
// in [startLow, startHigh] to an end somewhere in [endLow, endHigh] (calendar months)
// therefore lasted at least endLow - startHigh - 1 and at most endHigh - startLow + 1
// months. Every fixture person has an employment gap, so the roles handed to this
// oracle are disjoint and the union is the sum.
const monthNumber = ({ y, m }) => y * 12 + m;
function oracleTenure(spec, roles, asOf = AS_OF) {
  const asOfMonth = monthNumber({ y: asOf.getUTCFullYear(), m: asOf.getUTCMonth() + 1 });
  const range = date => {
    if (date === 'present') return [asOfMonth, asOfMonth];
    return spec.fmt === 'year' ? [monthNumber({ y: date.y, m: 1 }), monthNumber({ y: date.y, m: 12 })] : [monthNumber(date), monthNumber(date)];
  };
  let minMonths = 0;
  let maxMonths = 0;
  for (const role of roles) {
    const [startLow, startHigh] = range(role.start);
    const [endLow, endHigh] = range(role.end);
    minMonths += Math.max(0, endLow - startHigh - 1);
    maxMonths += endHigh - startLow + 1;
  }
  const years = months => Math.round((months / 12) * 100) / 100;
  return { minMonths, maxMonths, minYears: years(minMonths), maxYears: years(maxMonths) };
}
const sameBounds = (tenure, oracle) => tenure.minMonths === oracle.minMonths && tenure.maxMonths === oracle.maxMonths
  && tenure.minYears === oracle.minYears && tenure.maxYears === oracle.maxYears;
const describeBounds = tenure => `${tenure.minMonths}-${tenure.maxMonths} months`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
export default [
  {
    name: 'Dates adaptability: a recompiled source with a dated role moves the approved evidence, and removing it restores the original snapshot exactly',
    run() {
      for (const spec of PROFILES) {
        const { a, b, c } = mutationTriple(spec);
        const withSpan = compile(spec, { earlier: true, spanYears: spec.span.n });
        const earlierDates = roleDatesEntry(b.catalog, spec.earlier.id);
        assert(earlierDates && earlierDates.quote.includes(formatDate(spec.earlier.start, spec.fmt)) && earlierDates.quote.includes(formatDate(spec.earlier.end, spec.fmt)),
          `${spec.key}: B's catalog states the earlier role's dates as the source wrote them`);
        // Every projection of the same dates (the range line and the separate start / end lines) states what the source wrote.
        for (const [role, label] of [[spec.current, 'current'], [spec.earlier, 'earlier']]) {
          const roleQuotes = new Set(careerQuotes(b.catalog, `host.career.role.${role.id}.`));
          for (const line of [`Dates: ${formatDate(role.start, spec.fmt)} — ${formatDate(role.end, spec.fmt)}`, `- Start date: ${formatDate(role.start, spec.fmt)}`, `- End date: ${formatDate(role.end, spec.fmt)}`]) {
            assert(roleQuotes.has(line), `${spec.key}: B's catalog carries "${line}" for the ${label} role`);
          }
        }
        // New corpus => new immutable snapshot identity; identical corpus => identical identity.
        assert(a.snapshot.snapshotId !== b.snapshot.snapshotId && b.snapshot.snapshotId !== withSpan.snapshot.snapshotId && a.snapshot.snapshotId !== withSpan.snapshot.snapshotId,
          `${spec.key}: every distinct source rendering recompiles to its own snapshot id`);
        assert(c.snapshot.snapshotId === a.snapshot.snapshotId && canonicalJson(c.snapshot) === canonicalJson(a.snapshot),
          `${spec.key}: removing the evidence returns the exact original snapshot, not a lookalike`);
        // (a) absent in A, (b) resolvable in B, (c) absent again in C.
        assert(rejects(() => resolveAuthorityEvidence(a.authority, earlierDates.id), /Unknown authority evidence id/),
          `${spec.key}: A cannot resolve evidence for a role its source never stated`);
        assert(resolveAuthorityEvidence(b.authority, earlierDates.id).quote === earlierDates.quote,
          `${spec.key}: B resolves the new role's date evidence by the same reserved id`);
        assert(rejects(() => resolveAuthorityEvidence(c.authority, earlierDates.id), /Unknown authority evidence id/),
          `${spec.key}: C is unable to resolve it again`);
        const aQuotes = new Set(a.catalog.map(entry => entry.quote));
        const bQuotes = new Set(b.catalog.map(entry => entry.quote));
        assert([...aQuotes].every(quote => bQuotes.has(quote)) && bQuotes.size > aQuotes.size,
          `${spec.key}: adding a role widens the approved evidence and drops nothing`);
        assert(canonicalJson(c.catalog) === canonicalJson(a.catalog) && canonicalJson(c.authority.sourceRoles) === canonicalJson(a.authority.sourceRoles),
          `${spec.key}: C's catalog and trusted roles equal A's`);
        assert(a.authority.sourceRoles.length === 1 && b.authority.sourceRoles.length === 2
          && b.authority.sourceRoles.find(role => role.id === spec.earlier.id)?.dates === `${formatDate(spec.earlier.start, spec.fmt)} – ${formatDate(spec.earlier.end, spec.fmt)}`,
        `${spec.key}: the trusted role list gains exactly the dated role`);
        // The education dates are separate evidence and survive every mutation untouched.
        const eduDates = `  - Dates: ${spec.edu.dates}`;
        assert([a, b, c, withSpan].every(item => item.catalog.some(entry => entry.quote === eduDates)), `${spec.key}: education dates persist in every rendering`);
        // Fixture self-consistency: a stated span never exceeds what the dated roles could span.
        assert(spec.span.n <= tenureOf(withSpan.snapshot).maxYears, `${spec.key}: the fixture's stated span is consistent with its own dated roles`);
      }
    },
  },
  {
    name: 'Dates adaptability: profile compilation rejects invented dates, accepts them once the source states them, and rejects them again when removed',
    run() {
      for (const spec of PROFILES) {
        const { a, b, c } = mutationTriple(spec);
        const earlierFaithful = b.profile.roles.find(role => role.id === spec.earlier.id);
        // The claim under test: "this person held role X from S to E". A hallucinating compiler cites
        // segments that exist (the current role's) while asserting the earlier role's fields.
        const hallucinated = corpusProfile => {
          const profile = structuredClone(a.profile);
          const cited = [...profile.roles[0].evidenceSegmentIds];
          profile.roles.push({ ...structuredClone(earlierFaithful), achievementIds: [], evidenceSegmentIds: cited });
          for (const entry of profile.segmentCoverage) if (cited.includes(entry.segmentId)) entry.entityIds.push(earlierFaithful.id);
          return validateCareerProfile(profile, corpusProfile);
        };
        const errorsA = hallucinated(a.corpus).errors;
        for (const field of ['title', 'employer', 'startDate', 'endDate']) {
          assert(errorsA.some(error => isGroundingError(error, `roles[${earlierFaithful.id}]`, field)),
            `${spec.key}: A rejects the earlier role's ${field} as ungrounded`);
        }
        assert(!errorsA.some(error => error.includes(`roles[${spec.current.id}]`)), `${spec.key}: the genuine role is untouched by the rejection`);
        // Invented DATES on a real, otherwise grounded role are rejected on the date fields alone.
        const redated = structuredClone(a.profile);
        redated.roles[0].startDate = earlierFaithful.startDate;
        redated.roles[0].endDate = earlierFaithful.endDate;
        const redatedErrors = validateCareerProfile(redated, a.corpus).errors;
        assert(redatedErrors.length === 2
          && redatedErrors.some(error => isGroundingError(error, `roles[${spec.current.id}]`, 'startDate'))
          && redatedErrors.some(error => isGroundingError(error, `roles[${spec.current.id}]`, 'endDate')),
        `${spec.key}: borrowing another period's dates fails on exactly the two date fields (${redatedErrors.join(' | ')})`);
        // (b) the recompiled source states them: the faithful profile is admitted.
        assert(validateCareerProfile(b.profile, b.corpus).valid && earlierFaithful.startDate === formatDate(spec.earlier.start, spec.fmt),
          `${spec.key}: B admits the role once its source states the dates`);
        // (c) evidence removed: the identical assertion is rejected identically.
        assert(canonicalJson(hallucinated(c.corpus).errors) === canonicalJson(errorsA), `${spec.key}: C rejects the claim exactly as A did`);
      }
    },
  },
  {
    name: 'Dates adaptability: near-miss date mutations are each rejected while the faithful profile is accepted',
    run() {
      let mutationCount = 0;
      for (const spec of PROFILES) {
        const { b } = mutationTriple(spec);
        assert(validateCareerProfile(b.profile, b.corpus).valid, `${spec.key}: the faithful profile is accepted`);
        const role = b.profile.roles.find(item => item.id === spec.earlier.id);
        const roleIndex = b.profile.roles.indexOf(role);
        const ownText = b.corpus.segments.filter(segment => role.evidenceSegmentIds.includes(segment.id)).map(segment => segment.text).join(' ');
        assert(!/present/iu.test(ownText), `${spec.key}: control fixture: the ended role's own evidence never contains the word Present`);
        const shiftYear = (value, year, delta) => value.replace(String(year), String(year + delta));
        const mutations = [
          ['startDate', 'start year +1', shiftYear(role.startDate, spec.earlier.start.y, 1)],
          ['startDate', 'start year -1', shiftYear(role.startDate, spec.earlier.start.y, -1)],
          ['endDate', 'end year +1', shiftYear(role.endDate, spec.earlier.end.y, 1)],
          ['endDate', 'end year -1', shiftYear(role.endDate, spec.earlier.end.y, -1)],
          ['startDate', 'the other role\'s start', formatDate(spec.current.start, spec.fmt)],
          ['endDate', 'the other role\'s end (Present)', formatDate(spec.current.end, spec.fmt)],
          ['endDate', 'an invented open end', 'Present'],
        ];
        if (spec.fmt !== 'year') {
          const nextMonth = { y: spec.earlier.start.y, m: (spec.earlier.start.m % 12) + 1 };
          mutations.push(['startDate', 'start month +1', formatDate(nextMonth, spec.fmt)]);
        }
        for (const [field, label, mutated] of mutations) {
          assert(mutated !== role[field], `${spec.key}: ${label} actually changes the value`);
          const profile = structuredClone(b.profile);
          profile.roles[roleIndex][field] = mutated;
          const errors = validateCareerProfile(profile, b.corpus).errors;
          assert(errors.length === 1 && isGroundingError(errors[0], `roles[${role.id}]`, field),
            `${spec.key}: mutation "${label}" is rejected on ${field} alone (${errors.join(' | ') || 'accepted'})`);
          mutationCount += 1;
        }
        const eduStart = Number(spec.edu.dates.slice(0, 4));
        const eduEnd = Number(spec.edu.dates.slice(-4));
        const eduVariants = [
          ['education start year +1', `${eduStart + 1}${spec.edu.dates.slice(4)}`],
          ['education end year +1', `${spec.edu.dates.slice(0, -4)}${eduEnd + 1}`],
          ['education end year -1', `${spec.edu.dates.slice(0, -4)}${eduEnd - 1}`],
          ['education range reversed', `${eduEnd}${spec.edu.dates.slice(4, -4)}${eduStart}`],
          ['the current role\'s start as the education date', formatDate(spec.current.start, spec.fmt)],
        ];
        for (const [label, mutated] of eduVariants) {
          assert(mutated !== spec.edu.dates, `${spec.key}: ${label} actually changes the value`);
          const education = structuredClone(b.profile);
          education.education[0].dates = mutated;
          const eduErrors = validateCareerProfile(education, b.corpus).errors;
          assert(eduErrors.length === 1 && isGroundingError(eduErrors[0], 'education[edu-1]', 'dates'),
            `${spec.key}: mutation "${label}" is rejected on the education dates alone (${eduErrors.join(' | ') || 'accepted'})`);
          mutationCount += 1;
        }
      }
      assert(mutationCount >= 5 * 12, 'every profile exercised its full mutation set');
    },
  },
  {
    name: 'Dates adaptability: the same date written in different formats yields one tenure, and coarser precision can only widen the range',
    run() {
      const MONTH_FORMATS = ['long', 'short', 'sept', 'iso', 'isoSlash', 'isoDay', 'longComma', 'upper'];
      const CURRENT_MARKERS = ['Present', 'present', 'CURRENT', 'Now'];
      // Every calendar month in every spelling lands on the right month. The sweep varies the START month against a fixed
      // end, then the END month against a fixed start, so a wrong entry in a month-name table cannot cancel itself out.
      // A month-precise role from month S to month E lasted between (E - S - 1) and (E - S + 1) calendar months.
      for (let month = 1; month <= 12; month += 1) {
        for (const formatName of MONTH_FORMATS) {
          const startSweep = calculateDatedTenure([{ startDate: formatDate({ y: 2010, m: month }, formatName), endDate: formatDate({ y: 2012, m: 6 }, formatName) }], { asOf: AS_OF });
          const endSweep = calculateDatedTenure([{ startDate: formatDate({ y: 2010, m: 1 }, formatName), endDate: formatDate({ y: 2012, m: month }, formatName) }], { asOf: AS_OF });
          const startSpan = (2012 * 12 + 6) - (2010 * 12 + month);
          const endSpan = (2012 * 12 + month) - (2010 * 12 + 1);
          assert(startSweep.minMonths === startSpan - 1 && startSweep.maxMonths === startSpan + 1,
            `start month ${formatDate({ y: 2010, m: month }, formatName)} (${formatName}) yields ${describeBounds(startSweep)}, expected ${startSpan - 1}-${startSpan + 1} months`);
          assert(endSweep.minMonths === endSpan - 1 && endSweep.maxMonths === endSpan + 1,
            `end month ${formatDate({ y: 2012, m: month }, formatName)} (${formatName}) yields ${describeBounds(endSweep)}, expected ${endSpan - 1}-${endSpan + 1} months`);
        }
      }
      for (const spec of MONTH_PRECISE) {
        const roleSet = formatName => [spec.current, spec.earlier].map(role => ({
          id: role.id, startDate: formatDate(role.start, formatName), endDate: role.end === 'present' ? CURRENT_MARKERS[0] : formatDate(role.end, formatName),
        }));
        const baseline = calculateDatedTenure(roleSet('long'), { asOf: AS_OF });
        assert(baseline.basis === 'dated-role-periods' && baseline.roleCount === 2, `${spec.key}: baseline tenure is derived from both dated roles`);
        for (const formatName of MONTH_FORMATS) {
          assert(canonicalJson(calculateDatedTenure(roleSet(formatName), { asOf: AS_OF })) === canonicalJson(baseline),
            `${spec.key}: ${formatName} spelling of every date yields the identical tenure`);
        }
        if (spec.current.end === 'present') {
          for (const marker of CURRENT_MARKERS) {
            const roles = roleSet('long').map(role => (role.id === spec.current.id ? { ...role, endDate: marker } : role));
            assert(canonicalJson(calculateDatedTenure(roles, { asOf: AS_OF })) === canonicalJson(baseline), `${spec.key}: the open end spelled "${marker}" is the same open end`);
          }
        }
        // The same ranges collapsed to years are less precise, so they may widen but never narrow or overstate.
        const yearOnly = [spec.current, spec.earlier].map(role => ({ id: role.id, startDate: String(role.start.y), endDate: role.end === 'present' ? 'Present' : String(role.end.y) }));
        const coarse = calculateDatedTenure(yearOnly, { asOf: AS_OF });
        assert(coarse.minYears <= baseline.minYears && coarse.maxYears >= baseline.maxYears && coarse.maxYears - coarse.minYears > baseline.maxYears - baseline.minYears,
          `${spec.key}: year-only dates bracket the month-precise tenure with a strictly wider uncertainty`);
        assert(formatRoleDateForPresentation(formatDate(spec.earlier.start, 'longComma')) === formatDate(spec.earlier.start, 'long'),
          `${spec.key}: the presentation formatter treats "Month, YYYY" as "Month YYYY"`);
        // The display projection may tidy a comma but can never change a date: every digit survives in order, and a
        // range already in a conventional form is displayed exactly as the source wrote it.
        for (const formatName of [...MONTH_FORMATS, 'slashMonthFirst', 'year']) {
          for (const role of [spec.current, spec.earlier]) {
            const written = datesLine(role, formatName);
            const shown = formatRoleDateForPresentation(written);
            assert(shown.replace(/\D/gu, '') === written.replace(/\D/gu, ''), `${spec.key}: presenting "${written}" as "${shown}" must not change a digit`);
            if (formatName !== 'longComma') assert(shown === written, `${spec.key}: "${written}" is displayed unchanged`);
          }
        }
      }
    },
  },
  {
    name: 'Dates adaptability: derived tenure never exceeds the evidenced span, widens when a role is added, narrows when it is removed, and never double counts',
    run() {
      for (const spec of PROFILES) {
        const { a, b, c } = mutationTriple(spec);
        const tenureA = tenureOf(a.snapshot);
        const tenureB = tenureOf(b.snapshot);
        const tenureC = tenureOf(c.snapshot);
        assert(tenureA.basis === 'dated-role-periods' && tenureB.roleCount === 2, `${spec.key}: tenure comes from the approved snapshot's dated roles`);
        // Never more than the calendar between the earliest evidenced start and the clock.
        assert(tenureA.maxMonths <= calendarBoundMonths(spec.current.start), `${spec.key}: A's tenure ${tenureA.maxMonths} cannot exceed its evidenced calendar span`);
        assert(tenureB.maxMonths < calendarBoundMonths(spec.earlier.start),
          `${spec.key}: B's tenure ${tenureB.maxMonths} stays strictly below the full calendar span because the employment gap is not counted`);
        // ...and exactly what the evidenced dates allow, no more and no less: an upper bound alone
        // would pass a derivation that lost a month, a year, or a whole role.
        const oracleA = oracleTenure(spec, [spec.current]);
        const oracleB = oracleTenure(spec, [spec.current, spec.earlier]);
        assert(sameBounds(tenureA, oracleA), `${spec.key}: A's tenure ${describeBounds(tenureA)} equals the calendar arithmetic of its one dated role (${describeBounds(oracleA)})`);
        assert(sameBounds(tenureB, oracleB), `${spec.key}: B's tenure ${describeBounds(tenureB)} equals the calendar arithmetic of its two dated roles (${describeBounds(oracleB)})`);
        assert(sameBounds(tenureC, oracleA) && tenureC.minYears === oracleA.minYears && tenureC.maxYears === oracleA.maxYears,
          `${spec.key}: C's tenure equals A's calendar arithmetic again`);
        // (b) widening, (c) narrowing back to exactly A.
        assert(tenureB.minMonths > tenureA.minMonths && tenureB.maxMonths > tenureA.maxMonths, `${spec.key}: adding the earlier role widens tenure`);
        assert(canonicalJson(tenureC) === canonicalJson(tenureA), `${spec.key}: removing it restores exactly the original tenure`);
        assert(legacyHistory(b.snapshot).experience_years === tenureB.minYears && legacyHistory(a.snapshot).experience_years === tenureA.minYears,
          `${spec.key}: the legacy experience_years projection is the conservative lower bound of the same derivation`);
        // Concurrent employment inside an existing period adds nothing.
        const workHistory = legacyHistory(a.snapshot).workHistory;
        const concurrent = {
          id: 'concurrent', startDate: formatDate({ y: spec.current.start.y + 2, m: spec.current.start.m }, spec.fmt),
          endDate: spec.current.end === 'present' ? 'Present' : formatDate(spec.current.end, spec.fmt),
        };
        const withConcurrent = calculateDatedTenure([...workHistory, concurrent], { asOf: AS_OF });
        assert(withConcurrent.roleCount === tenureA.roleCount + 1
          && withConcurrent.minMonths === tenureA.minMonths && withConcurrent.maxMonths === tenureA.maxMonths,
        `${spec.key}: a concurrent role wholly inside an existing period is counted as a role but adds no time`);
        // Dates that cannot describe a real period contribute nothing and are not even counted as a role, so a garbled,
        // reversed, or open-STARTED entry can never inflate tenure.
        const reversedRole = { id: 'reversed', startDate: formatDate(spec.earlier.end, spec.fmt), endDate: formatDate(spec.earlier.start, spec.fmt) };
        const unusable = [reversedRole, { id: 'open-start', startDate: 'Present', endDate: 'Present' }, { id: 'unparseable', startDate: 'sometime', endDate: 'later' }, { id: 'blank', startDate: '', endDate: '' }];
        for (const role of unusable) {
          assert(canonicalJson(calculateDatedTenure([...legacyHistory(b.snapshot).workHistory, role], { asOf: AS_OF })) === canonicalJson(tenureB),
            `${spec.key}: the "${role.id}" entry (${role.startDate || '(blank)'} to ${role.endDate || '(blank)'}) adds neither time nor a counted role`);
        }
        assert(calculateDatedTenure(unusable, { asOf: AS_OF }).basis === 'no-usable-dates', `${spec.key}: only unusable dates yield no usable tenure`);
        // A role that only touches the edge extends the union by the extra months only.
        const touching = { id: 'touching', startDate: formatDate({ y: spec.earlier.start.y - 3, m: spec.earlier.start.m }, spec.fmt), endDate: formatDate(spec.earlier.start, spec.fmt) };
        const extended = calculateDatedTenure([...legacyHistory(b.snapshot).workHistory, touching], { asOf: AS_OF });
        assert(extended.maxMonths > tenureB.maxMonths && extended.maxMonths - tenureB.maxMonths <= 3 * 12 + 1, `${spec.key}: an adjacent earlier period extends tenure by no more than its own length`);
        // Open-ended roles move 1:1 with the explicit clock; ended roles ignore it.
        const later = new Date(Date.UTC(2027, 5, 15));
        const laterB = tenureOf(b.snapshot, later);
        assert(sameBounds(laterB, oracleTenure(spec, [spec.current, spec.earlier], later)), `${spec.key}: under a later explicit clock the tenure still equals the calendar arithmetic`);
        const hasOpenRole = spec.current.end === 'present';
        assert(hasOpenRole
          ? laterB.minMonths - tenureB.minMonths === 12 && laterB.maxMonths - tenureB.maxMonths === 12
          : canonicalJson(laterB) === canonicalJson(tenureB),
        `${spec.key}: ${hasOpenRole ? 'a Present role grows by exactly the clock delta' : 'fully ended roles do not depend on the clock'}`);
      }
    },
  },
  {
    name: 'Dates adaptability: no explicit-clock seam reads the real or a different system clock',
    run() {
      for (const spec of PROFILES) {
        const { b } = mutationTriple(spec);
        const framing = role => `As a ${role.title} at ${role.company}, I lead the daily work of the team.`;
        const endedRole = b.authority.sourceRoles.find(role => role.id === spec.earlier.id);
        const runAll = () => ({
          legacy: legacyHistory(b.snapshot),
          tenure: tenureOf(b.snapshot),
          endedRoleDate: checkEndedRoleCurrentEmployment([framing(endedRole)], { roles: b.authority.sourceRoles }, new Date(Date.UTC(2026, 5, 15))),
          endedRoleIso: checkEndedRoleCurrentEmployment([framing(endedRole)], { roles: b.authority.sourceRoles }, REFERENCE),
          fit: validateAndNormalizeFitAssessment({
            requirements: [{ id: 'exp', requirement: 'Ten years of care', priority: 'critical', evidenceStatus: 'direct', jobEvidence: ['ten years of care'], candidateEvidence: [roleDatesEntry(b.catalog, spec.current.id).quote] }],
            experienceAssessment: { categorySpecificExperience: [{ id: 'cat', category: 'Ten years of care', requiredMinimumYears: 10, roleIds: b.profile.roles.map(role => role.id), jobEvidence: ['ten years of care'] }] },
          }, { jobText: 'The posting expects ten years of care.', candidateText: projectApprovedCareerSnapshotForApplication(b.snapshot), candidateRoles: legacyHistory(b.snapshot).workHistory, asOf: AS_OF }),
        });
        const realClock = runAll();
        // The seams must actually be doing date work for the comparison below to mean anything.
        // (Year-only end dates have their own ended-role test, so this comparison skips that spelling.)
        assert(spec.fmt === 'year' || (realClock.endedRoleDate.endedRoleCount >= 1 && !realClock.endedRoleDate.passed),
          `${spec.key}: fixture: the ended-role gate engages`);
        assert(realClock.tenure.basis === 'dated-role-periods', `${spec.key}: fixture: the tenure derivation engages`);
        const baseline = canonicalJson(realClock);
        const distantPast = canonicalJson(withSystemClock('2001-01-01T00:00:00.000Z', runAll));
        const distantFuture = canonicalJson(withSystemClock('2099-12-31T00:00:00.000Z', runAll));
        assert(distantPast === baseline && distantFuture === baseline, `${spec.key}: results with an explicit clock are independent of the process clock`);
        // The ONLY clock input is the explicit one: the default path follows the process clock, nothing else does.
        const roles = legacyHistory(b.snapshot).workHistory;
        const defaulted = withSystemClock('2031-03-15T00:00:00.000Z', () => calculateDatedTenure(roles));
        assert(canonicalJson(defaulted) === canonicalJson(calculateDatedTenure(roles, { asOf: new Date(Date.UTC(2031, 2, 15)) })),
          `${spec.key}: omitting the clock is exactly equivalent to passing the process clock`);
        if (spec.current.end === 'present') {
          assert(canonicalJson(defaulted) !== canonicalJson(calculateDatedTenure(roles, { asOf: AS_OF })), `${spec.key}: the fixture is sensitive to the clock, so the independence above is meaningful`);
        }
      }
    },
  },
  {
    name: 'Dates adaptability: a claimed years-of-experience requirement is confirmed only by dated tenure the approved roles can reach',
    run() {
      let uncertainCases = 0;
      for (const spec of PROFILES) {
        const { a, b, c } = mutationTriple(spec);
        // Thresholds come from the calendar arithmetic of the fixture's own dates, so a wrong
        // production derivation cannot move the test's idea of what is reachable.
        const oracleCurrent = oracleTenure(spec, [spec.current]);
        const oracleEarlier = oracleTenure(spec, [spec.earlier]);
        const oracleB = oracleTenure(spec, [spec.current, spec.earlier]);
        const fit = (item, requiredYears, { status = 'direct', roleIds = item.profile.roles.map(role => role.id) } = {}) => {
          const postingQuote = `${requiredYears} years of direct ${spec.job.domain} experience`;
          const result = validateAndNormalizeFitAssessment({
            requirements: [{
              id: 'experience', requirement: postingQuote, priority: 'critical', evidenceStatus: status, jobEvidence: [postingQuote],
              candidateEvidence: [roleDatesEntry(item.catalog, spec.current.id).quote],
            }],
            experienceAssessment: { categorySpecificExperience: [{ id: 'category', category: postingQuote, requiredMinimumYears: requiredYears, roleIds, jobEvidence: [postingQuote] }] },
          }, {
            jobText: `${spec.job.title} at ${spec.job.company}. The posting requires ${postingQuote}.`,
            candidateText: projectApprovedCareerSnapshotForApplication(item.snapshot), candidateRoles: legacyHistory(item.snapshot).workHistory, asOf: AS_OF,
          });
          return result.requirementRows[0];
        };
        const withinA = Math.max(1, Math.floor(oracleCurrent.minYears));
        const beyondA = Math.floor(oracleCurrent.maxYears) + 2;
        const beyondB = Math.floor(oracleB.maxYears) + 2;
        assert(beyondA <= oracleB.minYears, `${spec.key}: fixture: the added role is long enough to cover the requirement that A cannot`);
        // Faithful: a requirement inside the evidenced tenure keeps its direct claim.
        for (const item of [a, b, c]) {
          const row = fit(item, withinA);
          assert(row.effectiveStatus === 'direct' && row.datedTenure?.disposition === 'confirmed', `${spec.key}: ${withinA} years within the dated tenure stays direct`);
        }
        // (a) an inflated claim is downgraded, (b) the recompiled source with the earlier role confirms it, (c) removing it downgrades again.
        const rowA = fit(a, beyondA);
        const rowB = fit(b, beyondA);
        const rowC = fit(c, beyondA);
        assert(rowA.reportedStatus === 'direct' && rowA.effectiveStatus === 'not_documented' && rowA.datedTenure.disposition === 'shortfall',
          `${spec.key}: A cannot confirm ${beyondA} years (calendar bound ${oracleCurrent.minYears}-${oracleCurrent.maxYears})`);
        assert(rowB.effectiveStatus === 'direct' && rowB.datedTenure.disposition === 'confirmed', `${spec.key}: B confirms ${beyondA} years (calendar bound ${oracleB.minYears}-${oracleB.maxYears})`);
        assert(rowC.effectiveStatus === 'not_documented' && rowC.datedTenure.disposition === 'shortfall', `${spec.key}: C downgrades again`);
        // (d) near miss: one requirement beyond even B's evidence.
        const rowBeyondB = fit(b, beyondB);
        assert(rowBeyondB.effectiveStatus !== 'direct' && rowBeyondB.datedTenure.minYears < beyondB, `${spec.key}: ${beyondB} years exceeds even B's tenure and is not confirmed`);
        // The boundaries of the tenure band, from the calendar arithmetic: at or below the guaranteed minimum the claim is
        // confirmed; a short miss beyond the maximum is only "adjacent"; a clear miss is undocumented.
        const justOver = Math.round((oracleB.maxYears + 0.3) * 100) / 100;
        const wayOver = Math.round((oracleB.maxYears + 0.7) * 100) / 100;
        const atMinimum = fit(b, oracleB.minYears);
        assert(atMinimum.effectiveStatus === 'direct' && atMinimum.datedTenure.disposition === 'confirmed', `${spec.key}: exactly the guaranteed minimum (${oracleB.minYears} years) is confirmed`);
        const nearMiss = fit(b, justOver);
        assert(nearMiss.effectiveStatus === 'adjacent' && nearMiss.datedTenure.disposition === 'near-shortfall', `${spec.key}: ${justOver} years is a near shortfall of ${oracleB.maxYears}, so adjacent rather than direct`);
        const clearMiss = fit(b, wayOver);
        assert(clearMiss.effectiveStatus === 'not_documented' && clearMiss.datedTenure.disposition === 'shortfall', `${spec.key}: ${wayOver} years is a clear shortfall of ${oracleB.maxYears}`);
        // One role's dates cannot be spent on a category that names the other role: with the same
        // snapshot, a requirement only the SUM of both roles reaches is a shortfall for either alone.
        for (const [label, role, oracle] of [['the current role', spec.current, oracleCurrent], ['the earlier role', spec.earlier, oracleEarlier]]) {
          const needed = Math.floor(oracle.maxYears) + 2;
          assert(needed <= oracleB.minYears, `${spec.key}: fixture: both roles together reach ${needed} years`);
          const together = fit(b, needed);
          const alone = fit(b, needed, { roleIds: [role.id] });
          assert(together.effectiveStatus === 'direct' && together.datedTenure.disposition === 'confirmed', `${spec.key}: both roles together confirm ${needed} years`);
          assert(alone.reportedStatus === 'direct' && alone.effectiveStatus === 'not_documented' && alone.datedTenure.disposition === 'shortfall',
            `${spec.key}: a category naming only ${label} cannot borrow the other role's dates for ${needed} years`);
        }
        // Imprecise (year-only) dates can neither prove nor refute a threshold they straddle.
        for (const [item, oracle] of [[a, oracleCurrent], [b, oracleB]]) {
          const straddled = Math.floor(oracle.maxYears);
          if (straddled > oracle.minYears) {
            const row = fit(item, straddled);
            assert(row.datedTenure.disposition === 'threshold-uncertain' && row.effectiveStatus === 'unclear', `${spec.key}: a threshold inside the date-precision band is unclear, not direct`);
            uncertainCases += 1;
          }
        }
      }
      assert(uncertainCases >= 1, 'at least one imprecise-date profile exercised the straddled-threshold rule');
    },
  },
  {
    name: 'Dates adaptability: a stated span of years is claimable only when the cited evidence states it, and the boundary follows the recompiled source',
    run() {
      for (const spec of PROFILES) {
        const n = spec.span.n;
        const { b: noSpan } = mutationTriple(spec);
        const stated = compile(spec, { earlier: true, spanYears: n });
        const wider = compile(spec, { earlier: true, spanYears: n + 3 });
        const restoredText = removeLines(wider.text, [spanLine(spec, n + 3)]);
        assert(restoredText === noSpan.text, `${spec.key}: fixture: removing the span line returns the span-free source`);
        const restoredSpanless = compile(spec, { earlier: true }, restoredText);
        const restoredStatedText = wider.text.replace(spanLine(spec, n + 3), spanLine(spec, n));
        assert(restoredStatedText === stated.text, `${spec.key}: fixture: restoring the original statement returns the original source`);
        const restoredStated = compile(spec, { earlier: true, spanYears: n }, restoredStatedText);
        const citedFor = (item, includeSpan = true) => [
          ...careerQuotes(item.catalog, `host.career.achievement.ach-${spec.current.id}.`),
          ...careerQuotes(item.catalog, `host.career.role.${spec.current.id}.`),
          ...(includeSpan ? careerQuotes(item.catalog, 'host.career.other.other-span.') : []),
        ];
        const base = stripPeriod(spec.current.achievement);
        const verdict = (claim, quotes, label) => {
          const text = label === 'resumeBullets' ? `${base}, drawing on ${claim}.` : `I ${lowerFirst(base)}, drawing on ${claim}.`;
          const { error } = settle(() => assertSourceQuoteLinksFinalText(text, quotes, label, 0, { identityTokens: [] }));
          const direct = findUnsupportedDurationClaim(text, quotes);
          assert(Boolean(direct) === Boolean(error) && (!error || /claims an experience span/u.test(error.message)),
            `${spec.key}: the shared duration decision and the completion-time gate agree on "${claim}" (${label})`);
          return !error;
        };
        // Claim shapes: a bound ("N+", "over N") is a floor any equal-or-longer stated span supports; a hedge
        // ("nearly N") and a bare "N years of experience" assert the number itself; "N+ years" with no noun is
        // still a bounded claim.
        const supportedBySpan = [`${n}+ years of experience`, `${NUMBER_WORDS[n]} years of experience`, `${n - 3}+ years of experience`, `at least ${n - 1} years of experience`, `over ${NUMBER_WORDS[n - 2]} years of experience`,
          `nearly ${NUMBER_WORDS[n]} years of experience`, `about ${n} years of experience`, `${n}+ years`, `roughly ${NUMBER_WORDS[n]} years`];
        const notSupportedBySpan = [`${n + 1}+ years of experience`, `${NUMBER_WORDS[n + 1]} years of experience`, `${n - 1} years of experience`, `${n + 3}+ years of experience`,
          `nearly ${NUMBER_WORDS[n + 1]} years of experience`, `roughly ${n + 2} years of experience`, `almost ${n - 1} years of experience`, `${n + 1}+ years`,
          `nearly ${NUMBER_WORDS[n + 1]} years`, `approximately ${n + 2} years`];
        for (const label of ['resumeBullets', 'coverLetter']) {
          // (a) A: nothing states a span, and every claim here is longer than the cited current role's dates could ever
          // support, so it is rejected whatever the policy on spans derived from dates (that policy question is the
          // "faithful derivation" entry in knownGaps).
          const citedRoleOnly = oracleTenure(spec, [spec.current]);
          for (const claim of [...supportedBySpan, ...notSupportedBySpan, `${Math.floor(citedRoleOnly.maxYears) + 1}+ years of experience`]) {
            const claimedYears = Number((claim.match(/\d+/u) || [])[0] ?? NUMBER_WORDS.indexOf(claim.split(' ').find(word => NUMBER_WORDS.includes(word))));
            assert(claimedYears > citedRoleOnly.maxYears, `${spec.key}: fixture: "${claim}" is longer than the cited role's ${citedRoleOnly.maxYears} years`);
            assert(!verdict(claim, citedFor(noSpan, false), label), `${spec.key}: without a stated span, "${claim}" is rejected (${label})`);
          }
          // (b) B: the span the source states, and exactly what it supports, becomes claimable.
          for (const claim of supportedBySpan) assert(verdict(claim, citedFor(stated), label), `${spec.key}: with "${spanLine(spec)}" cited, "${claim}" is accepted (${label})`);
          // (d) near misses around the stated number stay rejected.
          for (const claim of notSupportedBySpan) assert(!verdict(claim, citedFor(stated), label), `${spec.key}: "${claim}" exceeds or misstates the stated ${n} (${label})`);
          // Support is per cited unit: the same snapshot, but the statement is not cited.
          assert(!verdict(`${n}+ years of experience`, citedFor(stated, false), label), `${spec.key}: a span stated elsewhere does not support a unit that does not cite it (${label})`);
          // Recompiled to state more, the boundary moves up; the old ceiling no longer binds.
          assert(verdict(`${n + 3}+ years of experience`, citedFor(wider), label) && !verdict(`${n + 4}+ years of experience`, citedFor(wider), label),
            `${spec.key}: a source stating ${n + 3} years supports exactly up to ${n + 3} (${label})`);
          // (c) Removing the statement narrows it back.
          assert(!verdict(`${n}+ years of experience`, citedFor(restoredSpanless, false), label), `${spec.key}: C rejects the claim again once the statement is gone (${label})`);
          assert(verdict(`${n}+ years of experience`, citedFor(restoredStated), label) && !verdict(`${n + 3}+ years of experience`, citedFor(restoredStated), label),
            `${spec.key}: restoring the original statement restores the original boundary (${label})`);
        }
      }
    },
  },
  {
    name: 'Dates adaptability: a year attributed to an employer must belong to that employer\'s role, and a recompiled source that extends the role moves the boundary',
    run() {
      for (const spec of PROFILES) {
        const { b } = mutationTriple(spec);
        const asked = (item, text, achievementRoleId) => pasteAttributionScopeErrors({
          unitLabel: 'Resume bullet', unitId: 'b1', finalText: text,
          evidenceIds: evidenceIds(item.catalog, `host.career.achievement.ach-${achievementRoleId}.`), acceptedEvidence: item.catalog,
          sourceRoles: item.authority.sourceRoles, careerData: projectApprovedCareerSnapshotForApplication(item.snapshot), authority: item.authority, projects: [],
        });
        const cur = spec.current;
        const ear = spec.earlier;
        const curYears = new Set(String(datesLine(cur, spec.fmt)).match(/\d{4}/gu));
        const earYears = new Set(String(datesLine(ear, spec.fmt)).match(/\d{4}/gu));
        assert([...curYears].every(year => !earYears.has(year)), `${spec.key}: fixture: the two roles share no calendar year`);
        // Faithful dates at the right employer are accepted.
        assert(asked(b, `At ${cur.employer} since ${cur.start.y} I ran the daily work.`, cur.id).length === 0, `${spec.key}: the current role's own start year is accepted`);
        assert(asked(b, `At ${ear.employer} from ${ear.start.y} to ${ear.end.y} I ran the daily work.`, ear.id).length === 0, `${spec.key}: the earlier role's own years are accepted`);
        // Shifted, borrowed, and mis-cited dates are rejected, naming the year and the employer.
        const rejected = [
          [`At ${cur.employer} since ${cur.start.y - 3} I ran the daily work.`, cur.id, String(cur.start.y - 3), cur.employer],
          [`At ${cur.employer} since ${cur.start.y + 1} I ran the daily work.`, cur.id, String(cur.start.y + 1), cur.employer],
          [`At ${cur.employer} since ${ear.start.y} I ran the daily work.`, cur.id, String(ear.start.y), cur.employer],
          [`At ${ear.employer} from ${cur.start.y} I ran the daily work.`, ear.id, String(cur.start.y), ear.employer],
          [`At ${ear.employer} from ${ear.start.y - 1} to ${ear.end.y} I ran the daily work.`, ear.id, String(ear.start.y - 1), ear.employer],
        ];
        for (const [text, roleId, year, employer] of rejected) {
          const errors = asked(b, text, roleId);
          assert(errors.length === 1 && errors[0].includes(`attributes ${year} to ${JSON.stringify(employer)}`), `${spec.key}: "${text}" is rejected as an unestablished employment date (${errors.join(' | ') || 'accepted'})`);
        }
        const miscited = asked(b, `At ${ear.employer} from ${ear.start.y} to ${ear.end.y} I ran the daily work.`, cur.id);
        assert(miscited.length === 1 && miscited[0].includes(`attributes work to ${JSON.stringify(ear.employer)}`), `${spec.key}: correct years cited from the other role's evidence are rejected`);
        // Dynamic boundary: the person later documents an earlier start for the SAME role.
        const extended = structuredClone(spec);
        extended.current.start = { y: spec.current.start.y - 4, m: spec.current.start.m };
        const claimYear = spec.current.start.y - 4;
        const claim = `At ${cur.employer} since ${claimYear} I ran the daily work.`;
        const a0 = compile(spec, {});
        const b0 = compile(extended, {});
        const restoredText = b0.text.replace(datesLine(extended.current, spec.fmt), datesLine(spec.current, spec.fmt));
        assert(restoredText === a0.text && b0.text !== a0.text, `${spec.key}: fixture: restoring the original date line returns the original source`);
        const c0 = compile(spec, {}, restoredText);
        assert(asked(a0, claim, cur.id).length === 1, `${spec.key}: A rejects ${claimYear} for ${cur.employer}`);
        assert(asked(b0, claim, cur.id).length === 0, `${spec.key}: B, whose source now dates the role from ${claimYear}, accepts it`);
        assert(asked(c0, claim, cur.id).length === 1, `${spec.key}: C rejects it again`);
        // Dynamic: a year that falls INSIDE the role's range is not in its date string, so it is established only
        // when the cited quote itself states it. The recompiled source that dates the achievement moves the boundary.
        const interiorYear = spec.current.start.y + 2;
        const interiorClaim = `At ${cur.employer} in ${interiorYear} I ran the daily work.`;
        const dated = structuredClone(spec);
        dated.current.achievement = `${stripPeriod(spec.current.achievement)} in ${interiorYear}.`;
        const a1 = a0;
        const b1 = compile(dated, {});
        const restoredDatedText = b1.text.replace(dated.current.achievement, spec.current.achievement);
        assert(restoredDatedText === a1.text && b1.text !== a1.text, `${spec.key}: fixture: removing the year from the achievement returns the original source`);
        const c1 = compile(spec, {}, restoredDatedText);
        const interiorErrors = asked(a1, interiorClaim, cur.id);
        assert(interiorErrors.length === 1 && interiorErrors[0].includes(`attributes ${interiorYear} to ${JSON.stringify(cur.employer)}`),
          `${spec.key}: A, whose role dates and quote never state ${interiorYear}, rejects it (${interiorErrors.join(' | ') || 'accepted'})`);
        assert(asked(b1, interiorClaim, cur.id).length === 0, `${spec.key}: B, whose cited achievement states ${interiorYear}, accepts it`);
        assert(asked(b1, `At ${cur.employer} in ${interiorYear + 1} I ran the daily work.`, cur.id).length === 1, `${spec.key}: B still rejects the neighbouring year ${interiorYear + 1}`);
        assert(asked(c1, interiorClaim, cur.id).length === 1, `${spec.key}: C rejects ${interiorYear} again`);
        // At the profile gate the same year is a claim of its own: the achievement may state it only when its cited line does.
        const claimErrors = (profile, corpus) => validateCareerProfile(profile, corpus).errors;
        const isClaimError = errors => errors.length === 1 && isGroundingError(errors[0], `achievements[ach-${cur.id}]`, 'claim');
        assert(validateCareerProfile(b1.profile, b1.corpus).valid, `${spec.key}: B admits the achievement that states ${interiorYear}`);
        const shiftedClaim = structuredClone(b1.profile);
        shiftedClaim.achievements[0].claim = dated.current.achievement.replace(String(interiorYear), String(interiorYear + 1));
        assert(isClaimError(claimErrors(shiftedClaim, b1.corpus)), `${spec.key}: B rejects the same achievement dated ${interiorYear + 1}`);
        const inventedClaim = structuredClone(a1.profile);
        inventedClaim.achievements[0].claim = dated.current.achievement;
        assert(isClaimError(claimErrors(inventedClaim, a1.corpus)) && isClaimError(claimErrors(inventedClaim, c1.corpus)),
          `${spec.key}: A and C reject an achievement that adds ${interiorYear} to a line that does not state it`);
      }
    },
  },
  {
    name: 'Dates adaptability: résumé role dates are locked to the trusted source role, so shifted, borrowed, or invented dates cannot be rendered',
    run() {
      for (const spec of PROFILES) {
        const { a, b, c } = mutationTriple(spec);
        const draftFor = (item, mutate = null) => resumeDraft(item, { mutateRoles: mutate });
        const validate = validateResume;
        // Faithful, including whitespace the normalizer is documented to fold.
        assert(validate(b, draftFor(b)).roles.length === 2, `${spec.key}: the faithful draft is accepted`);
        assert(validate(b, draftFor(b, roles => { roles[0].dates = roles[0].dates.replace(' – ', '   –  '); })).roles[0].dates === b.authority.sourceRoles[0].dates,
          `${spec.key}: spacing around the range is normalized, not treated as a different date`);
        const datesError = /roles\[(\d)\]\.dates must exactly match its trusted source role/u;
        const attempts = [
          ['shifted start year', roles => { roles[0].dates = roles[0].dates.replace(String(spec.current.start.y), String(spec.current.start.y - 1)); }],
          ['the other role\'s dates on this role', roles => { roles[1].dates = roles[0].dates; }],
          ['an open end on an ended role', roles => { roles[1].dates = `${formatDate(spec.earlier.start, spec.fmt)} – Present`; }],
          ['a closed end on a current role', roles => { roles[0].dates = roles[0].dates.replace('Present', formatDate(spec.earlier.end, spec.fmt)); }],
          ['a dropped end date', roles => { roles[1].dates = formatDate(spec.earlier.start, spec.fmt); }],
        ];
        for (const [label, mutate] of attempts) {
          if (label === 'a closed end on a current role' && spec.current.end !== 'present') continue;
          const { error } = settle(() => validate(b, draftFor(b, mutate)));
          assert(error && datesError.test(error.message), `${spec.key}: ${label} is rejected (${error?.message || 'accepted'})`);
        }
        // Dynamic: the draft naming the earlier role needs the source to have it.
        const draftWithEarlier = draftFor(b);
        assert(rejects(() => validate(a, draftWithEarlier), /roles must retain every trusted source role exactly once/u), `${spec.key}: A rejects a draft containing a role its source never dated`);
        assert(validate(b, draftWithEarlier).roles.length === 2, `${spec.key}: B accepts the same draft`);
        assert(rejects(() => validate(c, draftWithEarlier), /roles must retain every trusted source role exactly once/u), `${spec.key}: C rejects it again`);
      }
    },
  },
  {
    name: 'Dates adaptability: an ended role cannot be framed as current employment, formats are equivalent, and the verdict depends only on the passed reference date',
    run() {
      const framing = role => `As a ${role.title} at ${role.company}, I lead the daily work of the team.`;
      const verdict = (roles, role, reference) => checkEndedRoleCurrentEmployment([framing(role)], { roles }, reference);
      for (const spec of MONTH_PRECISE) {
        // A: the current role is open. B: the source now states an end month before the reference. C: restored.
        const open = structuredClone(spec);
        open.current.end = 'present';
        const ended = structuredClone(open);
        ended.current.end = { y: 2025, m: 9 };
        const a = compile(open, {});
        const b = compile(ended, {});
        const restoredText = b.text.replace(datesLine(ended.current, ended.fmt), datesLine(open.current, open.fmt));
        assert(restoredText === a.text && b.text !== a.text, `${spec.key}: fixture: restoring the open end returns the original source`);
        const c = compile(open, {}, restoredText);
        const forRole = item => item.authority.sourceRoles[0];
        const asCheck = item => ({ title: forRole(item).title, company: forRole(item).company, dates: forRole(item).dates });
        const resultA = verdict([asCheck(a)], asCheck(a), REFERENCE);
        const resultB = verdict([asCheck(b)], asCheck(b), REFERENCE);
        const resultC = verdict([asCheck(c)], asCheck(c), REFERENCE);
        assert(resultA.passed && resultA.failureCount === 0, `${spec.key}: A presents an open role as current without objection`);
        assert(!resultB.passed && resultB.failureCount === 1 && resultB.detail.includes(asCheck(b).company) && resultB.detail.includes('Sep 2025'),
          `${spec.key}: B, whose source states the role ended September 2025, rejects present-tense employment (${resultB.detail})`);
        assert(resultC.passed && resultC.failureCount === 0, `${spec.key}: C is clear again`);
        // The same recompiled source moves the DERIVED tenure too: the open role keeps growing with the explicit
        // clock, the role the source says ended in September 2025 stops and counts less than the open one.
        const laterClock = new Date(Date.UTC(2027, 5, 15));
        const tenureAt = (item, asOf = AS_OF) => tenureOf(item.snapshot, asOf);
        assert(sameBounds(tenureAt(a), oracleTenure(open, [open.current])) && sameBounds(tenureAt(b), oracleTenure(ended, [ended.current])),
          `${spec.key}: A's and B's tenure equal the calendar arithmetic of an open and an ended role`);
        assert(tenureAt(b).maxMonths < tenureAt(a).maxMonths, `${spec.key}: the role that ended before the clock counts for less than the open one`);
        assert(canonicalJson(tenureAt(b, laterClock)) === canonicalJson(tenureAt(b)) && tenureAt(a, laterClock).maxMonths === tenureAt(a).maxMonths + 12,
          `${spec.key}: the ended role ignores a later clock; the open role gains exactly the clock delta`);
        assert(canonicalJson(tenureAt(c)) === canonicalJson(tenureAt(a)), `${spec.key}: C's tenure equals A's again`);
        // Equivalent spellings of the same end month give the same verdict; the month itself is not yet "ended".
        for (const format of ['long', 'short', 'iso', 'isoSlash', 'slashMonthFirst', 'upper']) {
          const dates = `${formatDate(ended.current.start, ended.fmt)} – ${formatDate(ended.current.end, format)}`;
          const role = { title: ended.current.title, company: ended.current.employer, dates };
          assert(!verdict([role], role, '2026-06-15').passed, `${spec.key}: end month written as ${formatDate(ended.current.end, format)} is recognised as ended`);
          assert(verdict([role], role, '2025-09-30').passed, `${spec.key}: on the end month itself the role may still be current (${format})`);
          assert(!verdict([role], role, '2025-10-01').passed, `${spec.key}: the following month it is ended (${format})`);
          assert(verdict([role], role, '2020-01-01').passed, `${spec.key}: judged against an earlier reference the role is not yet ended (${format})`);
        }
        assert(canonicalJson(verdict([asCheck(b)], asCheck(b), new Date(Date.UTC(2026, 5, 15)))) === canonicalJson(resultB), `${spec.key}: a Date and its ISO text are the same reference`);
        // Every end month is read as that month: the role may still be current during it and is ended from the next month on.
        for (let month = 1; month <= 12; month += 1) {
          for (const format of ['long', 'short', 'sept', 'upper', 'iso', 'isoSlash', 'slashMonthFirst']) {
            const sweepRole = { title: ended.current.title, company: ended.current.employer, dates: `${formatDate(ended.current.start, ended.fmt)} – ${formatDate({ y: 2025, m: month }, format)}` };
            const during = `2025-${pad2(month)}-28`;
            const after = month === 12 ? '2026-01-01' : `2025-${pad2(month + 1)}-01`;
            assert(verdict([sweepRole], sweepRole, during).passed && !verdict([sweepRole], sweepRole, after).passed,
              `${spec.key}: a role ending ${formatDate({ y: 2025, m: month }, format)} may be current on ${during} and is ended on ${after}`);
          }
        }
        // Dates belonging to ANOTHER role do not condemn this one.
        const both = compile(open, { earlier: true });
        const [currentRole, earlierRole] = both.authority.sourceRoles.map(role => ({ title: role.title, company: role.company, dates: role.dates }));
        const clear = verdict([currentRole, earlierRole], currentRole, REFERENCE);
        assert(clear.passed && clear.endedRoleCount === 1, `${spec.key}: framing the open role as current is fine although the other role ended`);
        const flagged = verdict([currentRole, earlierRole], earlierRole, REFERENCE);
        assert(!flagged.passed && flagged.detail.includes(earlierRole.company), `${spec.key}: framing the ended earlier role as current is rejected`);
      }
    },
  },
  {
    name: 'Dates adaptability: résumé role order is chronological (open first, then latest end) whatever order the source lists them, and follows the recompiled source',
    run() {
      // Every end month ranks against every other end month of the same year, in every month-bearing spelling. (ISO months 10
      // to 12 have their own [fixed defect] test, so the ISO spellings here sweep months 1 to 9.)
      for (const formatName of ['long', 'short', 'sept', 'upper', 'longComma', 'iso', 'isoSlash']) {
        const isoSpelling = formatName === 'iso' || formatName === 'isoSlash';
        for (let later = 2; later <= (isoSpelling ? 9 : 12); later += 1) {
          for (let sooner = 1; sooner < later; sooner += 1) {
            const roles = [
              { id: 'ends-sooner', dates: `${formatDate({ y: 2010, m: 1 }, formatName)} – ${formatDate({ y: 2020, m: sooner }, formatName)}` },
              { id: 'ends-later', dates: `${formatDate({ y: 2011, m: 1 }, formatName)} – ${formatDate({ y: 2020, m: later }, formatName)}` },
            ];
            for (const input of [roles, [...roles].reverse()]) {
              const shown = __selectedSourceRolesForTests({}, { sourceRoles: input }).map(role => role.id).join('>');
              assert(shown === 'ends-later>ends-sooner', `${formatName}: ending month ${later} is presented before ending month ${sooner} of the same year (got ${shown} for ${input.map(role => role.dates).join(' | ')})`);
            }
          }
        }
      }
      for (const spec of PROFILES) {
        const forward = compile(spec, { earlier: true });
        const reversed = compile(spec, { earlier: true, reverse: true });
        const alone = compile(spec, {});
        assert(forward.authority.sourceRoles[0].id === spec.current.id && reversed.authority.sourceRoles[0].id === spec.earlier.id,
          `${spec.key}: fixture: the two sources list the roles in opposite orders`);
        const presentation = item => __selectedSourceRolesForTests({}, { sourceRoles: item.authority.sourceRoles }).map(role => role.id);
        assert(presentation(forward).join() === [spec.current.id, spec.earlier.id].join() && presentation(reversed).join() === [spec.current.id, spec.earlier.id].join(),
          `${spec.key}: the later-ending role is presented first for either source order`);
        assert(presentation(alone).join() === spec.current.id, `${spec.key}: a source without the earlier role presents only the one role`);
        // Input order never matters.
        const roles = forward.authority.sourceRoles;
        assert(presentation({ authority: { sourceRoles: [roles[1], roles[0]] } }).join() === presentation(forward).join(), `${spec.key}: presentation does not depend on input order`);

        // Overlap and nesting. Two short engagements sit wholly inside the longer roles: they START later than the
        // role that contains them but END earlier. Neither "latest start first" nor "source order" nor "ignore
        // Present" gives the right answer. The expected order is derived here from the fixture's own dates:
        // a role still open first, then the later end first.
        const { insideCurrent, insideEarlier } = insideRoles(spec);
        const endKey = role => (role.end === 'present' ? Number.POSITIVE_INFINITY : role.end.y * 12 + (spec.fmt === 'year' ? 1 : role.end.m));
        // Equal ends keep the source's own order (a stable sort); only the bare-year source writes two roles with equal ends.
        const expectedFor = flags => [...rolesFor(spec, flags)].sort((left, right) => endKey(right) - endKey(left)).map(role => role.id);
        const forwardFlags = { earlier: true, inside: true };
        const reversedFlags = { earlier: true, inside: true, reverse: true };
        const ties = rolesFor(spec, forwardFlags).filter((role, index, list) => list.findIndex(other => endKey(other) === endKey(role)) !== index).length;
        assert(ties === (spec.fmt === 'year' ? 1 : 0), `${spec.key}: fixture: exactly the bare-year source has two roles ending in the same period`);
        const nestedForward = compile(spec, forwardFlags);
        const nestedReversed = compile(spec, reversedFlags);
        assert(nestedForward.authority.sourceRoles.map(role => role.id).join() !== nestedReversed.authority.sourceRoles.map(role => role.id).join(),
          `${spec.key}: fixture: the nested sources list the roles in opposite orders`);
        assert(presentation(nestedForward).join() === expectedFor(forwardFlags).join() && presentation(nestedReversed).join() === expectedFor(reversedFlags).join(),
          `${spec.key}: nested and overlapping roles are presented latest end first, open first (expected ${expectedFor(forwardFlags).join(' > ')} / ${expectedFor(reversedFlags).join(' > ')}, got ${presentation(nestedForward).join(' > ')} / ${presentation(nestedReversed).join(' > ')})`);
        const withoutNested = compile(spec, { earlier: true }, removeLines(nestedForward.text, [...roleLines(insideCurrent, spec.fmt), ...roleLines(insideEarlier, spec.fmt)]));
        assert(withoutNested.text === forward.text && presentation(withoutNested).join() === presentation(forward).join(),
          `${spec.key}: removing the nested engagements from the source returns the two-role presentation`);
      }
    },
  },
  {
    name: 'Dates adaptability: education and certification dates are grounded, projected, and rendered only as the current source states them',
    run() {
      for (const spec of PROFILES) {
        // --- certification: A = no certification line, B = the source states one, C = B with those lines removed.
        const a = compile(spec, {});
        const b = compile(spec, { cert: true });
        const removedText = removeLines(b.text, [certHeaderLine(spec), certDateLine(spec)]);
        assert(removedText === a.text, `${spec.key}: fixture: removing the certification lines from B returns A's source`);
        const c = compile(spec, {}, removedText);
        const certDatesQuote = catalog => catalog.find(entry => entry.id.startsWith('host.career.certification.cert-1.') && entry.quote.startsWith('  - Dates: '))?.quote;
        assert(certDatesQuote(a.catalog) === undefined && certDatesQuote(b.catalog) === `  - Dates: ${certDateLine(spec)}` && certDatesQuote(c.catalog) === undefined,
          `${spec.key}: the approved evidence states the certification date exactly when the source does`);
        // Profile gate. A hallucinating compiler cites segments that exist (the education lines) while asserting a certification.
        const hallucinated = corpus => {
          const profile = structuredClone(a.profile);
          const cited = [...profile.education[0].evidenceSegmentIds];
          profile.certifications.push({ ...structuredClone(b.profile.certifications[0]), evidenceSegmentIds: cited });
          for (const entry of profile.segmentCoverage) if (cited.includes(entry.segmentId)) entry.entityIds.push('cert-1');
          return validateCareerProfile(profile, corpus);
        };
        const errorsA = hallucinated(a.corpus).errors;
        for (const field of ['name', 'issuer', 'dates']) {
          assert(errorsA.some(error => isGroundingError(error, 'certifications[cert-1]', field)), `${spec.key}: A rejects the certification ${field} as ungrounded`);
        }
        assert(validateCareerProfile(b.profile, b.corpus).valid, `${spec.key}: B admits the certification once its source states it`);
        assert(canonicalJson(hallucinated(c.corpus).errors) === canonicalJson(errorsA), `${spec.key}: C rejects the certification exactly as A did`);
        const certYear = spec.cert.date.y;
        const nearMisses = [
          ['certification year +1', formatDate({ ...spec.cert.date, y: certYear + 1 }, spec.fmt)],
          ['certification year -1', formatDate({ ...spec.cert.date, y: certYear - 1 }, spec.fmt)],
          ['the education dates as the certification date', spec.edu.dates],
          ['the current role\'s start as the certification date', formatDate(spec.current.start, spec.fmt)],
          ...(spec.fmt === 'year' ? [] : [['certification month +1', formatDate({ y: certYear, m: (spec.cert.date.m % 12) + 1 }, spec.fmt)]]),
        ];
        for (const [label, mutated] of nearMisses) {
          assert(mutated !== certDateLine(spec), `${spec.key}: ${label} actually changes the value`);
          const profile = structuredClone(b.profile);
          profile.certifications[0].dates = mutated;
          const errors = validateCareerProfile(profile, b.corpus).errors;
          assert(errors.length === 1 && isGroundingError(errors[0], 'certifications[cert-1]', 'dates'), `${spec.key}: mutation "${label}" is rejected on the certification dates alone (${errors.join(' | ') || 'accepted'})`);
        }

        // --- the résumé renders education and certification dates only when its cited evidence states them.
        const faithful = resumeDraft(b);
        const rendered = validateResume(b, faithful);
        assert(rendered.education[0].dates === spec.edu.dates && rendered.credentials[0].dates === certDateLine(spec), `${spec.key}: the faithful draft keeps both dates`);
        const eduStart = Number(spec.edu.dates.slice(0, 4));
        const eduEnd = Number(spec.edu.dates.slice(-4));
        const resumeAttempts = [
          ['education start year +1', draft => { draft.education[0].dates = `${eduStart + 1}${spec.edu.dates.slice(4)}`; }, /education\.edu-1\.dates must occur in its cited career-data evidence/u],
          ['education end year +1', draft => { draft.education[0].dates = `${spec.edu.dates.slice(0, -4)}${eduEnd + 1}`; }, /education\.edu-1\.dates must occur in its cited career-data evidence/u],
          ['education dates with the date line not cited', draft => { draft.education[0].evidenceIds = [draft.education[0].evidenceIds[0]]; }, /education\.edu-1\.dates must occur in its cited career-data evidence/u],
          ['certification year +1', draft => { draft.credentials[0].dates = formatDate({ ...spec.cert.date, y: certYear + 1 }, spec.fmt); }, /credentials\.cert-1\.dates must occur in its cited career-data evidence/u],
          ['the education dates on the certification', draft => { draft.credentials[0].dates = spec.edu.dates; }, /credentials\.cert-1\.dates must occur in its cited career-data evidence/u],
        ];
        for (const [label, mutate, pattern] of resumeAttempts) {
          const { error } = settle(() => validateResume(b, resumeDraft(b, { mutate })));
          assert(error && pattern.test(error.message), `${spec.key}: résumé ${label} is rejected (${error?.message || 'accepted'})`);
        }
        // The draft that cites a certification the source never stated cannot cite it at all.
        assert(rejects(() => validateResume(a, faithful), /unknown evidence ID "host\.career\.certification\.cert-1\.1"/u), `${spec.key}: A rejects a draft citing a certification its source never stated`);
        assert(validateResume(b, faithful).credentials.length === 1, `${spec.key}: B accepts the same draft`);
        assert(rejects(() => validateResume(c, faithful), /unknown evidence ID "host\.career\.certification\.cert-1\.1"/u), `${spec.key}: C rejects it again`);

        // --- education: the recompiled source RESTATES the dates; the boundary moves to them and away from the old ones.
        const restated = structuredClone(spec);
        restated.edu.dates = `${eduStart - 1}${spec.edu.dates.slice(4)}`;
        const eduA = a;
        const eduB = compile(restated, {});
        const eduRestoredText = eduB.text.replace(restated.edu.dates, spec.edu.dates);
        assert(eduRestoredText === eduA.text && eduB.text !== eduA.text, `${spec.key}: fixture: restoring the education date line returns the original source`);
        const eduC = compile(spec, {}, eduRestoredText);
        const claim = dates => resumeDraft(eduA, { mutate: draft => { draft.education[0].dates = dates; } });
        const eduRule = /education\.edu-1\.dates must occur in its cited career-data evidence/u;
        assert(rejects(() => validateResume(eduA, claim(restated.edu.dates)), eduRule) && !rejects(() => validateResume(eduA, claim(spec.edu.dates))),
          `${spec.key}: A accepts ${spec.edu.dates} and rejects ${restated.edu.dates}`);
        assert(!rejects(() => validateResume(eduB, claim(restated.edu.dates))) && rejects(() => validateResume(eduB, claim(spec.edu.dates)), eduRule),
          `${spec.key}: B, whose source restates the dates, accepts ${restated.edu.dates} and rejects the old ${spec.edu.dates}`);
        assert(rejects(() => validateResume(eduC, claim(restated.edu.dates)), eduRule) && !rejects(() => validateResume(eduC, claim(spec.edu.dates))),
          `${spec.key}: C is back to A's boundary`);
      }
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: profile gate: start and end dates swapped (a chronologically impossible role) are accepted',
    run() {
      assertNoViolations('a role whose start is after its end must be rejected', PROFILES, spec => {
        const { b } = mutationTriple(spec);
        const profile = structuredClone(b.profile);
        const role = profile.roles.find(item => item.id === spec.earlier.id);
        [role.startDate, role.endDate] = [role.endDate, role.startDate];
        return validateCareerProfile(profile, b.corpus).valid ? `${spec.key}: accepted ${role.startDate} to ${role.endDate}` : '';
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: profile gate: an ended role is accepted as open ("Present") because "Presented" contains the letters',
    run() {
      assertNoViolations('"Present" must not be grounded by the word "Presented" in a cited achievement', PROFILES, spec => {
        const variant = structuredClone(spec);
        variant.earlier.achievement = 'Presented quarterly findings to the leadership committee.';
        const b = compile(variant, { earlier: true });
        const profile = structuredClone(b.profile);
        profile.roles.find(item => item.id === spec.earlier.id).endDate = 'Present';
        return validateCareerProfile(profile, b.corpus).valid ? `${spec.key}: ended ${formatDate(spec.earlier.end, spec.fmt)} accepted as Present` : '';
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: profile gate: a year-only end date is grounded by an unrelated count that happens to equal the year',
    run() {
      assertNoViolations('a year-only date must be stated as a date, not borrowed from a count', PROFILES.filter(item => item.fmt === 'year'), spec => {
        const variant = structuredClone(spec);
        const invented = spec.earlier.end.y - 3;
        variant.earlier.achievement = `Cleared a backlog of ${invented} open items.`;
        const b = compile(variant, { earlier: true });
        const profile = structuredClone(b.profile);
        profile.roles.find(item => item.id === spec.earlier.id).endDate = String(invented);
        return validateCareerProfile(profile, b.corpus).valid ? `${spec.key}: end year ${invented} accepted (true end ${spec.earlier.end.y})` : '';
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: final text: an invented calendar year or range that names no employer passes both deterministic date gates',
    run() {
      const cases = PROFILES.flatMap(spec => {
        const invented = spec.current.start.y - 8;
        const base = stripPeriod(spec.current.achievement);
        return [`In ${invented}, ${lowerFirst(base)}.`, `${base} from ${invented} to ${invented + 2}.`].map(text => ({ spec, text }));
      });
      assertNoViolations('a year or range the cited evidence never dates must be rejected', cases, ({ spec, text }) => {
        const { b } = mutationTriple(spec);
        const quotes = careerQuotes(b.catalog, `host.career.achievement.ach-${spec.current.id}.`);
        const completion = settle(() => assertSourceQuoteLinksFinalText(text, quotes, 'resumeBullets', 0, { identityTokens: [] }));
        const attribution = pasteAttributionScopeErrors({
          unitLabel: 'Resume bullet', unitId: 'b1', finalText: text, evidenceIds: evidenceIds(b.catalog, `host.career.achievement.ach-${spec.current.id}.`), acceptedEvidence: b.catalog,
          sourceRoles: b.authority.sourceRoles, careerData: projectApprovedCareerSnapshotForApplication(b.snapshot), authority: b.authority, projects: [],
        });
        return completion.error || attribution.length ? '' : `${spec.key}: accepted "${text}"`;
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: final text: a wrong month on a correct employer-attributed year is accepted (only the year is compared)',
    run() {
      assertNoViolations('the month of an employer-attributed date must also be established', MONTH_PRECISE, spec => {
        const { b } = mutationTriple(spec);
        const wrongMonth = { y: spec.current.start.y, m: (spec.current.start.m % 12) + 1 };
        const errors = pasteAttributionScopeErrors({
          unitLabel: 'Resume bullet', unitId: 'b1', finalText: `At ${spec.current.employer} since ${LONG_MONTHS[wrongMonth.m - 1]} ${wrongMonth.y} I ran the daily work.`,
          evidenceIds: evidenceIds(b.catalog, `host.career.achievement.ach-${spec.current.id}.`), acceptedEvidence: b.catalog,
          sourceRoles: b.authority.sourceRoles, careerData: projectApprovedCareerSnapshotForApplication(b.snapshot), authority: b.authority, projects: [],
        });
        return errors.length ? '' : `${spec.key}: accepted ${LONG_MONTHS[wrongMonth.m - 1]} ${wrongMonth.y}; the role began ${LONG_MONTHS[spec.current.start.m - 1]} ${spec.current.start.y}`;
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: ended-role gate: a year-only ended role framed as current employment is not flagged',
    run() {
      assertNoViolations('a role whose year-only end is years before the reference must not be framed as current', PROFILES.filter(item => item.fmt === 'year'), spec => {
        const { b } = mutationTriple(spec);
        const role = b.authority.sourceRoles.find(item => item.id === spec.earlier.id);
        const result = checkEndedRoleCurrentEmployment([`As a ${role.title} at ${role.company}, I lead the daily work of the team.`], { roles: [role] }, REFERENCE);
        return result.passed ? `${spec.key}: "${role.dates}" not flagged against ${REFERENCE.slice(0, 7)}` : '';
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: date parsers: equivalent spellings of a date are usable by the ended-role gate but dropped by the tenure engine',
    run() {
      const equivalents = [
        [{ startDate: '03/2017', endDate: 'Present' }, { startDate: 'March 2017', endDate: 'Present' }],
        [{ startDate: 'Mar. 2017', endDate: 'Present' }, { startDate: 'March 2017', endDate: 'Present' }],
        [{ startDate: 'Sept. 2016', endDate: 'Present' }, { startDate: 'September 2016', endDate: 'Present' }],
        [{ startDate: 'March 2017', endDate: '03/2026' }, { startDate: 'March 2017', endDate: 'March 2026' }],
        [{ startDate: 'March 2017', endDate: 'Ongoing' }, { startDate: 'March 2017', endDate: 'Present' }],
      ];
      assertNoViolations('the same period in an equivalent spelling must give the same tenure', equivalents, ([spelled, canonical]) => (
        canonicalJson(calculateDatedTenure([spelled], { asOf: AS_OF })) === canonicalJson(calculateDatedTenure([canonical], { asOf: AS_OF }))
          ? '' : `${JSON.stringify(spelled)} -> ${calculateDatedTenure([spelled], { asOf: AS_OF }).basis}`));
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: duration gate: unnumbered or compound experience spans ("a decade", "two decades", "seven-plus", "thirty years") are not read as claims',
    run() {
      const cases = PROFILES.flatMap(spec => ['over a decade of experience', 'two decades of experience', 'seven-plus years of experience', 'thirty years of experience'].map(claim => ({ spec, claim })));
      assertNoViolations('a span of experience no cited quote states must be rejected', cases, ({ spec, claim }) => {
        const { b } = mutationTriple(spec);
        const quotes = [...careerQuotes(b.catalog, `host.career.achievement.ach-${spec.current.id}.`), ...careerQuotes(b.catalog, `host.career.role.${spec.current.id}.`)];
        return findUnsupportedDurationClaim(`I bring ${claim} to the work.`, quotes) ? '' : `${spec.key}: accepted "${claim}"`;
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: duration gate: a number of years in an unrelated cited sentence supports an equal-number experience claim',
    run() {
      assertNoViolations('a backlog age quoted from the source is not the candidate\'s tenure', PROFILES, spec => {
        const variant = structuredClone(spec);
        variant.current.achievement = `Cut the ${spec.span.domain} backlog from six years of accumulated files to a same-day queue.`;
        const b = compile(variant, { earlier: true });
        const quotes = careerQuotes(b.catalog, `host.career.achievement.ach-${spec.current.id}.`);
        return findUnsupportedDurationClaim('I bring six years of experience to the work.', quotes) ? '' : `${spec.key}: "six years of experience" accepted from a backlog quote`;
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: duration gate: "more than N years" is supported by a quote stating exactly N years',
    run() {
      assertNoViolations('a strict lower bound needs a strictly larger stated span', PROFILES, spec => {
        const stated = compile(spec, { earlier: true, spanYears: spec.span.n });
        const quotes = careerQuotes(stated.catalog, 'host.career.other.other-span.');
        return findUnsupportedDurationClaim(`I bring more than ${NUMBER_WORDS[spec.span.n]} years of experience to the work.`, quotes)
          ? '' : `${spec.key}: "more than ${NUMBER_WORDS[spec.span.n]} years" accepted from "${spanLine(spec)}"`;
      });
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: résumé role order: ISO months 10 to 12 are read as month 1, so roles ending in the same year are ordered by source position',
    run() {
      const order = (...roles) => __selectedSourceRolesForTests({}, { sourceRoles: roles.map(([id, dates]) => ({ id, dates })) }).map(role => role.id).join('>');
      const cases = [
        // [expected latest-end-first order, the same roles listed in the wrong order, spelling]
        ['b>a', order(['a', '2018-01 – 2020-03'], ['b', '2017-02 – 2020-11']), 'YYYY-MM, Nov after Mar'],
        ['b>a', order(['a', '2018-01 – 2020-10'], ['b', '2017-02 – 2020-12']), 'YYYY-MM, Dec after Oct'],
        ['b>a', order(['a', '2018/01 – 2020/03'], ['b', '2017/02 – 2020/11']), 'YYYY/MM, Nov after Mar'],
        ['b>a', order(['a', 'January 2018 – March 2020'], ['b', 'February 2017 – November 2020']), 'month names (control)'],
      ];
      assertNoViolations('a later end month in the same year must be presented first whatever the spelling', cases, ([expected, got, label]) => (got === expected ? '' : `${label}: presented ${got}, expected ${expected}`));
    },
  },
  {
    name: 'Dates adaptability [fixed defect]: fit assessment: a direct years requirement is never checked against dated tenure when its category names no role, or only roles that do not exist',
    run() {
      assertNoViolations('a direct claim of more years than every dated role can reach must not stay direct', PROFILES, spec => {
        const { b } = mutationTriple(spec);
        const impossible = Math.floor(oracleTenure(spec, [spec.current, spec.earlier]).maxYears) + 10;
        const postingQuote = `${impossible} years of direct ${spec.job.domain} experience`;
        const stays = [undefined, [], ['role-that-does-not-exist']].filter(roleIds => {
          const row = validateAndNormalizeFitAssessment({
            requirements: [{ id: 'experience', requirement: postingQuote, priority: 'critical', evidenceStatus: 'direct', jobEvidence: [postingQuote], candidateEvidence: [roleDatesEntry(b.catalog, spec.current.id).quote] }],
            experienceAssessment: { categorySpecificExperience: [{ id: 'category', category: postingQuote, requiredMinimumYears: impossible, ...(roleIds ? { roleIds } : {}), jobEvidence: [postingQuote] }] },
          }, {
            jobText: `${spec.job.title} at ${spec.job.company}. The posting requires ${postingQuote}.`,
            candidateText: projectApprovedCareerSnapshotForApplication(b.snapshot), candidateRoles: legacyHistory(b.snapshot).workHistory, asOf: AS_OF,
          }).requirementRows[0];
          return row.effectiveStatus === 'direct';
        });
        return stays.length ? `${spec.key}: ${impossible} years stays direct for roleIds ${stays.map(ids => JSON.stringify(ids ?? 'omitted')).join(', ')}` : '';
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Known gaps: the function below asserts a span-gate policy that production
// deliberately does not follow today, so it FAILS. Not run by the registry. Every
// other gap recorded here was fixed and moved up as a `[fixed defect]` test.
// ---------------------------------------------------------------------------
export const knownGaps = [
  {
    name: 'GAP (policy) span gate: a span faithfully derived from the cited role dates (a conservative lower bound) is rejected like a computed total',
    run() {
      assertNoViolations('a lower-bound span that the cited dated roles guarantee, and that stays within them, must be admissible', PROFILES, spec => {
        const { b } = mutationTriple(spec);
        const guaranteed = Math.floor(oracleTenure(spec, [spec.current, spec.earlier]).minYears);
        const datedRoles = [spec.current, spec.earlier].map(role => roleDatesEntry(b.catalog, role.id).quote);
        const claim = `${guaranteed}+ years of experience`;
        return findUnsupportedDurationClaim(`I bring ${claim} to the work.`, datedRoles)
          ? `${spec.key}: "${claim}" rejected although the two cited dated roles guarantee at least ${guaranteed} years` : '';
      });
    },
  },
];
