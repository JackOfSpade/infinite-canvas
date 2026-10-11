// Regression tests for the deterministic career-profile validators in
// electron/ipc/careerSnapshot.js (validateCareerProfile and the helpers it
// uses). Every fixture is synthetic and unrelated across domains (a ward nurse,
// a pastry chef, a structural engineer, a warehouse supervisor); nothing here is
// known to production, and no rule below may be satisfied by a name, a date or a
// technology it was written against: each verdict is a function of the source
// text and of what the profile itself cites.
//
// Method. For every rule the tests prove four things:
//   1. the defective profile is refused, and for the rule's own reason;
//   2. the faithful form of the same claim is still accepted, including source
//      layouts that look similar but leave the question open (one-line role
//      entries, mixed separators, skills sections, bullets above headers);
//   3. A / B / C: a source without the supporting evidence refuses the claim, a
//      recompiled source (a NEW corpus) that states it admits the very same
//      profile, and removing that evidence again refuses it identically;
//   4. historical pins keep the original validator (the stricter rules apply
//      only to the current contract).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './testHelpers.js';
import {
  buildCareerSourceCorpus,
  validateCareerProfile,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';

// ---------------------------------------------------------------------------
// Harness: synthetic source text -> corpus -> a transcribing "compiler" -> the
// real validator. The transcription only points entities at the literal lines
// they were rendered from; production judges the result.
// ---------------------------------------------------------------------------
function corpusOf(lines) {
  const text = `${lines.join('\n')}\n`;
  return buildCareerSourceCorpus([{ name: 'Career Notes.md', text, legacyText: text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }]);
}

function segmentFor(corpus, line) {
  const found = corpus.segments.filter(segment => segment.text.trim() === line);
  assert(found.length === 1, `fixture: exactly one source line must read ${JSON.stringify(line)} (found ${found.length})`);
  return found[0].id;
}

/** Recompute the reciprocal coverage index from the entities' own citations. */
function withCoverage(input, corpus) {
  const profile = structuredClone(input);
  const owners = new Map();
  const own = (entityId, ids) => { for (const id of ids || []) owners.set(id, [...(owners.get(id) || []), entityId]); };
  own('identity', profile.identity.evidenceSegmentIds);
  for (const group of ['roles', 'achievements', 'projects', 'skills', 'education', 'certifications', 'otherEvidence']) {
    for (const entity of profile[group]) own(entity.id, entity.evidenceSegmentIds);
  }
  profile.segmentCoverage = corpus.segments.map(segment => ({ segmentId: segment.id, disposition: 'context', entityIds: [...new Set(owners.get(segment.id) || [])] }));
  return profile;
}

/**
 * spec = { name, contact, roles: [{ id, title, employer, startDate, endDate,
 *   headerLines: [lines the role cites], bullets: [lines, each an achievement] }] }
 */
function profileOf(corpus, spec) {
  const profile = {
    identity: { name: spec.name, contacts: [spec.contact], evidenceSegmentIds: [segmentFor(corpus, spec.name), segmentFor(corpus, spec.contact)] },
    roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
  spec.roles.forEach((role, index) => {
    const id = role.id || `role-${index + 1}`;
    const achievementIds = [];
    (role.bullets || []).forEach((text, bulletIndex) => {
      const achievementId = `${id}-ach-${bulletIndex + 1}`;
      achievementIds.push(achievementId);
      profile.achievements.push({ id: achievementId, roleId: id, claim: text, technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: [segmentFor(corpus, text)] });
    });
    profile.roles.push({
      id, title: role.title, employer: role.employer, startDate: role.startDate, endDate: role.endDate, location: '',
      achievementIds, skillIds: [], evidenceSegmentIds: role.headerLines.map(line => segmentFor(corpus, line)),
    });
  });
  return withCoverage(profile, corpus);
}

const errorsOf = (profile, corpus) => validateCareerProfile(withCoverage(profile, corpus), corpus).errors;
const accepts = (profile, corpus) => errorsOf(profile, corpus).length === 0;
const roleOf = (profile, id) => profile.roles.find(role => role.id === id);
const achievementOf = (profile, id) => profile.achievements.find(item => item.id === id);

// ---------------------------------------------------------------------------
// Synthetic candidates. `fmt` is how this person writes dates.
// ---------------------------------------------------------------------------
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(fmt, { y, m }) {
  if (fmt === 'long') return `${LONG[m - 1]} ${y}`;
  if (fmt === 'short') return `${SHORT[m - 1]} ${y}`;
  if (fmt === 'iso') return `${y}-${String(m).padStart(2, '0')}`;
  return String(y);
}

const DOMAINS = [
  {
    key: 'nurse', fmt: 'long', name: 'Marisol Quenby', contact: 'marisol.quenby@example.test',
    roles: [
      { title: 'Charge Nurse', employer: 'Harbor Valley Medical Center', start: { y: 2017, m: 3 }, end: { y: 2019, m: 11 }, bullets: ['Coordinated bedside handoffs across a twenty eight bed cardiac unit.', 'Precepted new graduate nurses on a surgical ward.'] },
      { title: 'Staff Nurse', employer: 'Lantern Hill Hospital', start: { y: 2008, m: 6 }, end: { y: 2015, m: 2 }, bullets: ['Rotated through the surgical and pediatric wards.', 'Kept the supply request log for the unit.'] },
    ],
    vendor: { org: 'Marlowe Pharmacy Cooperative', line: 'Attended infusion pump demonstrations hosted by Marlowe Pharmacy Cooperative.' },
    tool: { label: 'portable ultrasound unit', operated: 'Operated the portable ultrasound unit to scan patients under physician order.', evaluated: 'Evaluated the portable ultrasound unit to scan patients, but the team did not adopt it.' },
    figure: { line: 'Kept medication barcode scan compliance at 97% on the emergency ward.', joined: 'Kept medication barcode scan compliance at 97% across 9 audits.', number: '97', cut: '9', decimalLine: 'Kept medication barcode scan compliance at 97.5% on the emergency ward.' },
  },
  {
    key: 'chef', fmt: 'iso', name: 'Teodoro Brightwater', contact: 'teodoro.brightwater@example.test',
    roles: [
      { title: 'Executive Pastry Chef', employer: 'Saffron and Salt Bakery', start: { y: 2019, m: 4 }, end: { y: 2023, m: 9 }, bullets: ['Designed the seasonal laminated dough program for three retail counters.', 'Trained apprentices on allergen labelling and bench hygiene.'] },
      { title: 'Pastry Cook', employer: 'Maison Verdelle', start: { y: 1992, m: 9 }, end: { y: 1998, m: 6 }, bullets: ['Produced plated desserts for a ninety seat dining room.', 'Ordered dry goods for the pastry station.'] },
    ],
    vendor: { org: 'Fennimore Dairy Supply', line: 'Tasted butter samples supplied by Fennimore Dairy Supply for the seasonal menu.' },
    tool: { label: 'spiral dough mixer', operated: 'Operated the spiral dough mixer to mix laminated dough for the morning bake.', evaluated: 'Evaluated the spiral dough mixer to mix laminated dough, but the team did not adopt it.' },
    figure: { line: 'Held pastry ingredient spend at $4,200 per order cycle for the bakery.', joined: 'Held pastry ingredient spend at $4,200 across 4 order cycles for the bakery.', number: '$4,200', cut: '4', decimalLine: 'Held pastry ingredient spend at $4,200.50 per order cycle for the bakery.' },
  },
  {
    key: 'engineer', fmt: 'short', name: 'Ingrid Valdemar-Okoro', contact: 'ingrid.valdemar@example.test',
    roles: [
      { title: 'Project Engineer', employer: 'Granite Ridge Consultants', start: { y: 2016, m: 8 }, end: { y: 2022, m: 12 }, bullets: ['Checked steel connection calculations for mid rise parking structures.', 'Reviewed shop drawings against the structural drawings.'] },
      { title: 'Junior Engineer', employer: 'Cobalt Span Engineering', start: { y: 2010, m: 9 }, end: { y: 2015, m: 7 }, bullets: ['Drafted bridge bearing details under a licensed engineer.', 'Logged site inspection photographs for the project file.'] },
    ],
    vendor: { org: 'Brightmoor Dairy Cooperative', line: 'Consulted for Brightmoor Dairy Cooperative on a cold storage slab design.' },
    tool: { label: 'finite element solver', operated: 'Operated the finite element solver to check floor beam deflection.', evaluated: 'Evaluated the finite element solver to check floor beam deflection, but the team did not adopt it.' },
    figure: { line: 'Cut drawing turnaround to 15 days for the structural group.', joined: 'Cut drawing turnaround to 15 days across 5 projects for the structural group.', number: '15', cut: '5', decimalLine: 'Cut drawing turnaround to 15.5 days for the structural group.' },
  },
  {
    key: 'warehouse', fmt: 'year', name: 'Bashir Tolliver', contact: 'bashir.tolliver@example.test',
    roles: [
      { title: 'Shift Supervisor', employer: 'Northgate Distribution', start: { y: 2020, m: 1 }, end: { y: 2024, m: 5 }, bullets: ['Scheduled dock crews for inbound and outbound trailers.', 'Audited cycle counts for frozen inventory.'] },
      { title: 'Forklift Operator', employer: 'Redline Freight', start: { y: 1997, m: 1 }, end: { y: 2003, m: 12 }, bullets: ['Staged pallets for next day delivery routes.', 'Loaded trailers at the east dock.'] },
    ],
    vendor: { org: 'Voltaic Forklift Rentals', line: 'Evaluated demonstration units from Voltaic Forklift Rentals.' },
    tool: { label: 'pallet wrapping robot', operated: 'Operated the pallet wrapping robot to wrap outbound pallets on the night shift.', evaluated: 'Evaluated the pallet wrapping robot to wrap outbound pallets, but the team did not adopt it.' },
    figure: { line: 'Scheduled 12 employees per shift at the east dock.', joined: 'Scheduled 12 employees per shift across 2 docks.', number: '12', cut: '2', decimalLine: 'Scheduled 12.5 employees per shift at the east dock.' },
  },
];

const dateLine = (domain, role, { start = role.start, end = role.end, endText = null } = {}) => `${formatDate(domain.fmt, start)} – ${endText ?? formatDate(domain.fmt, end)}`;
const headerLine = role => `${role.title}, ${role.employer}`;

/** Source lines for the whole candidate; `tweak` can replace or extend one role's block. */
function linesOf(domain, { tweak = {}, roles = domain.roles } = {}) {
  const lines = [domain.name, domain.contact];
  roles.forEach((role, index) => {
    const t = tweak[index] || {};
    lines.push(t.header ?? headerLine(role));
    if (!t.noDates) lines.push(t.dates ?? dateLine(domain, role));
    lines.push(...(t.bullets ?? role.bullets), ...(t.extra || []));
  });
  return lines;
}

function specOf(domain, { tweak = {}, roles = domain.roles } = {}) {
  return {
    name: domain.name, contact: domain.contact,
    roles: roles.map((role, index) => {
      const t = tweak[index] || {};
      const header = t.header ?? headerLine(role);
      const dates = t.noDates ? [] : [t.dates ?? dateLine(domain, role)];
      return {
        id: `role-${index + 1}`, title: role.title, employer: role.employer,
        startDate: t.startDate ?? formatDate(domain.fmt, role.start), endDate: t.endDate ?? formatDate(domain.fmt, role.end),
        headerLines: [header, ...dates], bullets: t.bullets ?? role.bullets,
      };
    }),
  };
}

function build(domain, options = {}) {
  const corpus = corpusOf(linesOf(domain, options));
  return { corpus, profile: profileOf(corpus, specOf(domain, options)) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
export default [
  {
    name: 'career validators: a role that starts after it ends is refused in every date spelling, while ordered, equal-year and unreadable dates are untouched',
    run() {
      for (const domain of DOMAINS) {
        const { corpus, profile } = build(domain);
        assert(accepts(profile, corpus), `${domain.key}: control: the faithful profile is accepted (${errorsOf(profile, corpus).join(' | ')})`);
        // Exchanging start and end is a chronologically impossible role. Both values are still grounded in the dates line, so
        // the order check is the only reason to refuse.
        const swapped = structuredClone(profile);
        const first = roleOf(swapped, 'role-1');
        [first.startDate, first.endDate] = [first.endDate, first.startDate];
        const swappedErrors = errorsOf(swapped, corpus);
        assert(swappedErrors.length === 1 && /roles\[role-1\] starts after it ends/u.test(swappedErrors[0]), `${domain.key}: swapped dates are refused for their own reason (${swappedErrors.join(' | ') || 'accepted'})`);
        // An open role, equal dates and a single-field range are never "out of order".
        const open = structuredClone(profile);
        roleOf(open, 'role-1').endDate = 'Present';
        const openCorpus = corpusOf(linesOf(domain, { tweak: { 0: { dates: dateLine(domain, domain.roles[0], { endText: 'Present' }) } } }));
        assert(accepts(profileOf(openCorpus, specOf(domain, { tweak: { 0: { dates: dateLine(domain, domain.roles[0], { endText: 'Present' }), endDate: 'Present' } } })), openCorpus), `${domain.key}: an open "Present" end is accepted`);
        // Same year, descending months: refused where the source states months, undecidable (accepted) for bare years.
        const sameYear = { start: { y: 2014, m: 6 }, end: { y: 2014, m: 3 } };
        const roles = [{ ...domain.roles[0], ...sameYear }, domain.roles[1]];
        const sameYearBuild = build(domain, { roles });
        const sameYearErrors = errorsOf(sameYearBuild.profile, sameYearBuild.corpus);
        if (domain.fmt === 'year') assert(sameYearErrors.length === 0, `${domain.key}: bare years in one year cannot be ordered and are accepted (${sameYearErrors.join(' | ')})`);
        else assert(sameYearErrors.length === 1 && /starts after it ends/u.test(sameYearErrors[0]), `${domain.key}: a later start month than end month in one year is refused (${sameYearErrors.join(' | ') || 'accepted'})`);
        const equal = build(domain, { roles: [{ ...domain.roles[0], start: domain.roles[0].end }, domain.roles[1]] });
        assert(accepts(equal.profile, equal.corpus), `${domain.key}: a role that starts and ends in the same period is accepted`);
        // A day-first numeric date and another language's month names are not interpreted (only the shared year is), so they are never refused for order.
        const oddCorpus = corpusOf([domain.name, domain.contact, 'Operations Lead, Atelier Nord', '31/12/2017 – mars 2017']);
        const oddProfile = profileOf(oddCorpus, { name: domain.name, contact: domain.contact, roles: [{ id: 'role-1', title: 'Operations Lead', employer: 'Atelier Nord', startDate: '31/12/2017', endDate: 'mars 2017', headerLines: ['Operations Lead, Atelier Nord', '31/12/2017 – mars 2017'], bullets: [] }] });
        assert(accepts(oddProfile, oddCorpus), `${domain.key}: dates the validator cannot read are left alone (${errorsOf(oddProfile, oddCorpus).join(' | ')})`);

        // A / B / C: the dates exist only once the recompiled source states them.
        const a = build(domain, { tweak: { 0: { noDates: true } } });
        const claim = structuredClone(profile);
        roleOf(claim, 'role-1').evidenceSegmentIds = roleOf(profile, 'role-1').evidenceSegmentIds.slice(0, 1).map(() => segmentFor(a.corpus, headerLine(domain.roles[0])));
        const aErrors = errorsOf(claim, a.corpus);
        assert(aErrors.some(error => /roles\[role-1\]\.startDate is not grounded/u.test(error)) && aErrors.some(error => /roles\[role-1\]\.endDate is not grounded/u.test(error)),
          `${domain.key}: A: without a dates line the dates are ungrounded (${aErrors.join(' | ')})`);
        const b = build(domain);
        assert(accepts(profile, b.corpus), `${domain.key}: B: the recompiled source that states the dates admits the profile`);
        const c = build(domain, { tweak: { 0: { noDates: true } } });
        assert(JSON.stringify(errorsOf(claim, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: removing the dates line refuses the claim exactly as A did`);
      }
    },
  },
  {
    name: 'career validators: "Present" is not grounded by the word "Presented", while punctuated and bracketed "Present" is',
    run() {
      for (const domain of DOMAINS) {
        const presented = 'Presented quarterly findings to the leadership committee.';
        const ended = domain.roles[1];
        const endedClaim = tweak => ({ tweak: { 1: { bullets: [...ended.bullets, presented], ...tweak } } });
        // A: the second role ended, and its only "present…" text is the word "Presented".
        const a = build(domain, endedClaim({}));
        const claim = structuredClone(a.profile);
        roleOf(claim, 'role-2').endDate = 'Present';
        const aErrors = errorsOf(claim, a.corpus);
        assert(aErrors.length === 1 && /roles\[role-2\]\.endDate is not grounded/u.test(aErrors[0]), `${domain.key}: A: an ended role is not open because a duty says "Presented" (${aErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled source says the role is open; the same profile is admitted.
        const openDates = dateLine(domain, ended, { endText: 'Present' });
        const b = build(domain, endedClaim({ dates: openDates }));
        assert(accepts(claim, b.corpus), `${domain.key}: B: a source that states "Present" admits the open role (${errorsOf(claim, b.corpus).join(' | ')})`);
        // Punctuation around the word is not part of it.
        for (const decorated of [`(${dateLine(domain, ended, { endText: 'Present' })})`, `${dateLine(domain, ended, { endText: 'Present' })}.`, dateLine(domain, ended, { endText: 'Present' }).replace(' – ', ' - ')]) {
          const decoratedBuild = build(domain, endedClaim({ dates: decorated }));
          assert(accepts(claim, decoratedBuild.corpus), `${domain.key}: "${decorated}" still states Present`);
        }
        // C: the open role is withdrawn again and the claim is refused identically.
        const c = build(domain, endedClaim({}));
        assert(JSON.stringify(errorsOf(claim, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: removing "Present" refuses the claim exactly as A did`);
        // A year is not grounded by a longer number that merely contains it.
        const longer = build(domain, { tweak: { 1: { dates: `${ended.start.y} – ${ended.end.y}0` } } });
        const yearClaim = structuredClone(longer.profile);
        roleOf(yearClaim, 'role-2').startDate = String(ended.start.y);
        roleOf(yearClaim, 'role-2').endDate = String(ended.end.y);
        const yearErrors = errorsOf(yearClaim, longer.corpus);
        assert(yearErrors.length === 1 && /roles\[role-2\]\.endDate is not grounded/u.test(yearErrors[0]), `${domain.key}: "${ended.end.y}" is not grounded by "${ended.end.y}0" (${yearErrors.join(' | ') || 'accepted'})`);
      }
    },
  },
  {
    name: 'career validators: a year or a name stated only by a duty line the role shares with its achievement is not the role\'s date, title or employer',
    run() {
      for (const domain of DOMAINS) {
        const role = domain.roles[1];
        const yearsLine = (startYear, endYear) => `${startYear} – ${endYear}`;
        const borrowed = role.end.y - 3;
        const backlog = `Cleared a backlog of ${borrowed} open items.`;
        // A: the header dates say another end year; the duty line merely contains a number equal to the claimed year.
        const aTweak = { 1: { dates: yearsLine(role.start.y, role.end.y), bullets: [...role.bullets, backlog] } };
        const a = build(domain, { tweak: aTweak });
        const claim = structuredClone(a.profile);
        roleOf(claim, 'role-2').startDate = String(role.start.y);
        roleOf(claim, 'role-2').endDate = String(borrowed);
        // The role cites its own duty line too, as the transcribing compilers in the field do.
        roleOf(claim, 'role-2').evidenceSegmentIds.push(segmentFor(a.corpus, backlog));
        const aErrors = errorsOf(claim, a.corpus);
        assert(aErrors.length === 1 && /roles\[role-2\]\.endDate is stated only by narrative line/u.test(aErrors[0]), `${domain.key}: A: a count inside a duty is not the end year (${aErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled header states that very year; the profile is admitted.
        const b = build(domain, { tweak: { 1: { dates: yearsLine(role.start.y, borrowed), bullets: [...role.bullets, backlog] } } });
        assert(accepts(claim, b.corpus), `${domain.key}: B: a header that states ${borrowed} admits it (${errorsOf(claim, b.corpus).join(' | ')})`);
        // C: restored.
        const c = build(domain, { tweak: aTweak });
        assert(JSON.stringify(errorsOf(claim, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: restoring the header refuses the claim exactly as A did`);

        // Faithful one-line entry: the role and its achievement share a line that states the dates (and more). Accepted.
        const entry = `${role.start.y}–${role.end.y}: ${role.bullets[0]}`;
        const oneLine = corpusOf([domain.name, domain.contact, headerLine(role), entry]);
        const oneLineProfile = profileOf(oneLine, { name: domain.name, contact: domain.contact, roles: [{ id: 'role-1', title: role.title, employer: role.employer, startDate: String(role.start.y), endDate: String(role.end.y), headerLines: [headerLine(role), entry], bullets: [entry] }] });
        assert(accepts(oneLineProfile, oneLine), `${domain.key}: a dated duty line shared with the achievement still states the dates (${errorsOf(oneLineProfile, oneLine).join(' | ')})`);
        // Faithful single-line role: title, employer and dates all on the shared line, nothing else cited.
        const single = `${role.title}, ${role.employer}, ${role.start.y}–${role.end.y}: ${role.bullets[0]}`;
        const singleCorpus = corpusOf([domain.name, domain.contact, single]);
        const singleProfile = profileOf(singleCorpus, { name: domain.name, contact: domain.contact, roles: [{ id: 'role-1', title: role.title, employer: role.employer, startDate: String(role.start.y), endDate: String(role.end.y), headerLines: [single], bullets: [single] }] });
        assert(accepts(singleProfile, singleCorpus), `${domain.key}: a one-line role entry is accepted (${errorsOf(singleProfile, singleCorpus).join(' | ')})`);

        // A client named only inside a duty is not the employer; named in the header it is (A / B / C).
        const dutyA = build(domain, { tweak: { 0: { bullets: [domain.vendor.line, ...domain.roles[0].bullets] } } });
        const vendorClaim = structuredClone(dutyA.profile);
        roleOf(vendorClaim, 'role-1').employer = domain.vendor.org;
        roleOf(vendorClaim, 'role-1').evidenceSegmentIds.push(segmentFor(dutyA.corpus, domain.vendor.line));
        const vendorErrors = errorsOf(vendorClaim, dutyA.corpus);
        assert(vendorErrors.length === 1 && /roles\[role-1\]\.employer is stated only by narrative line/u.test(vendorErrors[0]), `${domain.key}: A: a vendor mentioned in a duty is not the employer (${vendorErrors.join(' | ') || 'accepted'})`);
        const vendorHeader = `${domain.roles[0].title}, ${domain.vendor.org}`;
        const vendorB = build(domain, { tweak: { 0: { header: vendorHeader, bullets: [domain.vendor.line, ...domain.roles[0].bullets] } } });
        const vendorClaimB = structuredClone(vendorB.profile);
        roleOf(vendorClaimB, 'role-1').employer = domain.vendor.org;
        roleOf(vendorClaimB, 'role-1').evidenceSegmentIds.push(segmentFor(vendorB.corpus, domain.vendor.line));
        assert(accepts(vendorClaimB, vendorB.corpus), `${domain.key}: B: a header that states the organisation as the employer admits it (${errorsOf(vendorClaimB, vendorB.corpus).join(' | ')})`);
        const vendorC = build(domain, { tweak: { 0: { bullets: [domain.vendor.line, ...domain.roles[0].bullets] } } });
        const vendorClaimC = structuredClone(vendorClaim);
        roleOf(vendorClaimC, 'role-1').evidenceSegmentIds = roleOf(vendorClaim, 'role-1').evidenceSegmentIds.map(id => segmentFor(vendorC.corpus, dutyA.corpus.segments.find(segment => segment.id === id).text.trim()));
        assert(JSON.stringify(errorsOf(vendorClaimC, vendorC.corpus)) === JSON.stringify(vendorErrors), `${domain.key}: C: removing the header evidence refuses the claim exactly as A did`);
      }
    },
  },
  {
    name: 'career validators: a metric value or claim that stops inside a stated number is refused; the whole number, decimals and sentence punctuation are not',
    run() {
      for (const domain of DOMAINS) {
        const { figure } = domain;
        const build1 = line => {
          const role = { ...domain.roles[0], bullets: [line] };
          const options = { roles: [role, domain.roles[1]] };
          const corpus = corpusOf(linesOf(domain, options));
          const profile = profileOf(corpus, specOf(domain, options));
          achievementOf(profile, 'role-1-ach-1').metrics = [{ label: '', value: figure.number, unit: '', evidenceSegmentIds: [...achievementOf(profile, 'role-1-ach-1').evidenceSegmentIds] }];
          return { corpus, profile };
        };
        const a = build1(figure.line);
        assert(accepts(a.profile, a.corpus), `${domain.key}: control: the whole stated figure ${figure.number} is accepted (${errorsOf(a.profile, a.corpus).join(' | ')})`);
        const truncated = structuredClone(a.profile);
        achievementOf(truncated, 'role-1-ach-1').metrics[0].value = figure.cut;
        const truncatedErrors = errorsOf(truncated, a.corpus);
        assert(truncatedErrors.length === 1 && /metric value is not grounded/u.test(truncatedErrors[0]), `${domain.key}: A: "${figure.cut}" is not a restatement of "${figure.number}" (${truncatedErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled line states the shorter figure as its own number; the same profile is admitted.
        const b = build1(figure.joined);
        const bClaim = structuredClone(b.profile);
        achievementOf(bClaim, 'role-1-ach-1').metrics[0].value = figure.cut;
        assert(accepts(bClaim, b.corpus), `${domain.key}: B: a source that also states "${figure.cut}" admits it (${errorsOf(bClaim, b.corpus).join(' | ')})`);
        // C: removed again.
        const c = build1(figure.line);
        const cClaim = structuredClone(c.profile);
        achievementOf(cClaim, 'role-1-ach-1').metrics[0].value = figure.cut;
        assert(JSON.stringify(errorsOf(cClaim, c.corpus)) === JSON.stringify(truncatedErrors), `${domain.key}: C: removing the line refuses the claim exactly as A did`);

        // A claim that stops in the middle of the number is not grounded either.
        const cutAt = figure.line.indexOf(figure.number) + figure.number.length - 1;
        const cutClaim = structuredClone(a.profile);
        achievementOf(cutClaim, 'role-1-ach-1').claim = figure.line.slice(0, cutAt).replace(/[.,]$/u, '');
        const cutErrors = errorsOf(cutClaim, a.corpus);
        assert(cutErrors.length === 1 && /claim is not grounded/u.test(cutErrors[0]), `${domain.key}: a claim that ends inside "${figure.number}" is refused (${cutErrors.join(' | ') || 'accepted'})`);

        // The whole number followed by sentence punctuation or a unit is still the whole number.
        const decimal = build1(figure.decimalLine);
        const decimalClaim = structuredClone(decimal.profile);
        achievementOf(decimalClaim, 'role-1-ach-1').metrics[0].value = figure.number;
        assert(errorsOf(decimalClaim, decimal.corpus).some(error => /metric value is not grounded/u.test(error)), `${domain.key}: "${figure.number}" is not a restatement of a longer decimal figure`);
        const sentenceEnd = build1(figure.line.replace(/\.$/u, `${figure.line.endsWith('.') ? '.' : ''}`));
        assert(accepts(sentenceEnd.profile, sentenceEnd.corpus), `${domain.key}: a figure followed by sentence punctuation is accepted`);
      }
    },
  },
  {
    name: 'career validators: a title and employer exchanged with each other are refused when the same source writes the other roles\' headers the other way, and mixed styles are left alone',
    run() {
      for (const domain of DOMAINS) {
        const { corpus, profile } = build(domain);
        assert(accepts(profile, corpus), `${domain.key}: control: the faithful profile is accepted`);
        // Two roles, one exchanged: no majority, so both roles are named as suspects.
        const exchanged = structuredClone(profile);
        const target = roleOf(exchanged, 'role-1');
        [target.title, target.employer] = [target.employer, target.title];
        const tie = errorsOf(exchanged, corpus);
        assert(tie.length === 2 && tie.every(error => /gives its title and employer in the opposite order/u.test(error)) && tie.some(error => error.includes('roles[role-1]')),
          `${domain.key}: an exchanged title and employer is refused (${tie.join(' | ') || 'accepted'})`);
        // Three roles, one exchanged: the minority role is the suspect.
        const third = { title: 'Seasonal Assistant', employer: 'Cedar Row Associates', start: { y: 1990, m: 3 }, end: { y: 1991, m: 8 }, bullets: ['Filed correspondence for the front office.'] };
        const three = build(domain, { roles: [...domain.roles, third] });
        const threeExchanged = structuredClone(three.profile);
        const swappedRole = roleOf(threeExchanged, 'role-2');
        [swappedRole.title, swappedRole.employer] = [swappedRole.employer, swappedRole.title];
        const minority = errorsOf(threeExchanged, three.corpus);
        assert(minority.length === 1 && minority[0].startsWith('roles[role-2]'), `${domain.key}: only the exchanged role is named when the others agree (${minority.join(' | ') || 'accepted'})`);

        // Several roles on each side is a document that mixes the two orders, not one exchanged pair: no verdict is possible.
        const extraRoles = [
          { title: 'Seasonal Assistant', employer: 'Cedar Row Associates', start: { y: 1990, m: 3 }, end: { y: 1991, m: 8 }, bullets: ['Filed correspondence for the front office.'] },
          { title: 'Weekend Clerk', employer: 'Alder Point Traders', start: { y: 1988, m: 2 }, end: { y: 1989, m: 9 }, bullets: ['Counted stock for the weekend rota.'] },
        ];
        const evenMix = build(domain, { roles: [...domain.roles, ...extraRoles], tweak: {
          1: { header: `${domain.roles[1].employer}, ${domain.roles[1].title}` }, 3: { header: `${extraRoles[1].employer}, ${extraRoles[1].title}` },
        } });
        assert(accepts(evenMix.profile, evenMix.corpus), `${domain.key}: two roles on each side of the order are accepted (${errorsOf(evenMix.profile, evenMix.corpus).join(' | ')})`);
        const twoOfFive = build(domain, { roles: [...domain.roles, ...extraRoles, { ...third, employer: 'Willow Bend Cooperative', start: { y: 1986, m: 5 }, end: { y: 1987, m: 4 }, bullets: ['Sorted the incoming parcels for the yard.'] }], tweak: {
          1: { header: `${domain.roles[1].employer}, ${domain.roles[1].title}` }, 3: { header: `${extraRoles[1].employer}, ${extraRoles[1].title}` },
        } });
        assert(accepts(twoOfFive.profile, twoOfFive.corpus), `${domain.key}: two reversed headers among five are accepted (${errorsOf(twoOfFive.profile, twoOfFive.corpus).join(' | ')})`);

        // A source that writes every header employer-first is faithful with employer-first values.
        const reversed = roles => roles.map(role => ({ ...role }));
        const employerFirst = tweakFor => ({ 0: { header: `${domain.roles[0].employer}, ${domain.roles[0].title}`, ...tweakFor }, 1: { header: `${domain.roles[1].employer}, ${domain.roles[1].title}` } });
        const consistent = build(domain, { roles: reversed(domain.roles), tweak: employerFirst({}) });
        assert(accepts(consistent.profile, consistent.corpus), `${domain.key}: employer-first headers throughout are accepted`);
        // A document that mixes styles under DIFFERENT separators is not judged.
        const mixed = build(domain, { tweak: { 1: { header: `${domain.roles[1].employer} | ${domain.roles[1].title}` } } });
        assert(accepts(mixed.profile, mixed.corpus), `${domain.key}: different separators in one file are accepted (${errorsOf(mixed.profile, mixed.corpus).join(' | ')})`);

        // A / B / C: the source is the evidence. A reads "Y, X" for a claim "title X / employer Y"; B recompiles the header as "X — Y" which
        // states the claim in a different style; C writes it "Y, X" again.
        const role = domain.roles[1];
        const claimTitle = role.employer;
        const claimEmployer = role.title;
        const claim = structuredClone(profile);
        roleOf(claim, 'role-2').title = claimTitle;
        roleOf(claim, 'role-2').employer = claimEmployer;
        const aErrors = errorsOf(claim, corpus);
        assert(aErrors.length === 2, `${domain.key}: A: the exchanged claim is refused (${aErrors.join(' | ') || 'accepted'})`);
        const bTweak = { 1: { header: `${claimTitle} — ${claimEmployer}` } };
        const bCorpus = corpusOf(linesOf(domain, { tweak: bTweak }));
        const bClaim = structuredClone(claim);
        roleOf(bClaim, 'role-2').evidenceSegmentIds = [segmentFor(bCorpus, bTweak[1].header), segmentFor(bCorpus, dateLine(domain, role))];
        assert(accepts(bClaim, bCorpus), `${domain.key}: B: a source that states "${claimTitle} — ${claimEmployer}" admits the claim (${errorsOf(bClaim, bCorpus).join(' | ')})`);
        // Multi-line headers are judged by line order.
        const multiLines = [domain.name, domain.contact];
        const multiSpec = { name: domain.name, contact: domain.contact, roles: [] };
        domain.roles.forEach((r, index) => {
          multiLines.push(r.title, r.employer, dateLine(domain, r), ...r.bullets);
          multiSpec.roles.push({ id: `role-${index + 1}`, title: r.title, employer: r.employer, startDate: formatDate(domain.fmt, r.start), endDate: formatDate(domain.fmt, r.end), headerLines: [r.title, r.employer, dateLine(domain, r)], bullets: r.bullets });
        });
        const multiCorpus = corpusOf(multiLines);
        const multiProfile = profileOf(multiCorpus, multiSpec);
        assert(accepts(multiProfile, multiCorpus), `${domain.key}: title and employer on separate lines are accepted`);
        const multiExchanged = structuredClone(multiProfile);
        const multiTarget = roleOf(multiExchanged, 'role-1');
        [multiTarget.title, multiTarget.employer] = [multiTarget.employer, multiTarget.title];
        assert(errorsOf(multiExchanged, multiCorpus).length === 2, `${domain.key}: exchanged title and employer on separate lines are refused`);
      }
    },
  },
  {
    name: 'career validators: an achievement belongs to the role whose source block states it; skills sections, bullets above headers, one-line entries and employer-naming lines are not misjudged',
    run() {
      for (const domain of DOMAINS) {
        const [recent, prior] = domain.roles;
        const moved = prior.bullets[0];
        const attach = (profile, roleId, achievementId) => {
          const copy = structuredClone(profile);
          const achievement = achievementOf(copy, achievementId);
          const from = copy.roles.find(role => role.id === achievement.roleId);
          from.achievementIds = from.achievementIds.filter(id => id !== achievementId);
          roleOf(copy, roleId).achievementIds.push(achievementId);
          achievement.roleId = roleId;
          return copy;
        };
        // A: the bullet sits under the prior role's header but the profile files it under the recent role.
        const a = build(domain);
        const claim = attach(a.profile, 'role-1', 'role-2-ach-1');
        const aErrors = errorsOf(claim, a.corpus);
        assert(aErrors.length === 1 && /achievements\[role-2-ach-1\] is attached to role role-1.*lie inside the source block of role\(s\) role-2/u.test(aErrors[0]),
          `${domain.key}: A: "${moved}" is not the recent role's achievement (${aErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled source lists that bullet under the recent role: the same claim is admitted.
        const bTweak = { 0: { bullets: [...recent.bullets, moved] }, 1: { bullets: prior.bullets.slice(1) } };
        const b = build(domain, { tweak: bTweak });
        const bClaim = withCoverage(attach(profileOf(b.corpus, specOf(domain, { tweak: bTweak })), 'role-1', 'role-1-ach-1'), b.corpus);
        assert(accepts(bClaim, b.corpus) && achievementOf(bClaim, 'role-1-ach-1').claim === recent.bullets[0], `${domain.key}: B: a source that lists the bullet under the recent role admits it`);
        const bFaithful = profileOf(b.corpus, specOf(domain, { tweak: bTweak }));
        assert(accepts(bFaithful, b.corpus), `${domain.key}: B: the faithful profile of the recompiled source is accepted`);
        // C: moved back; the identical claim is refused identically.
        const c = build(domain);
        assert(JSON.stringify(errorsOf(claim, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: restoring the source refuses the claim exactly as A did`);

        // Bullets written ABOVE their role header: no role's own block is demonstrated, so nothing is judged.
        const aboveLines = [domain.name, domain.contact, ...recent.bullets, headerLine(recent), dateLine(domain, recent), ...prior.bullets, headerLine(prior), dateLine(domain, prior)];
        const above = corpusOf(aboveLines);
        const aboveProfile = profileOf(above, specOf(domain));
        assert(accepts(aboveProfile, above), `${domain.key}: bullets above their headers are accepted (${errorsOf(aboveProfile, above).join(' | ')})`);

        // One-line role entries.
        const entries = domain.roles.map(role => `${role.title}, ${role.employer}, ${formatDate(domain.fmt, role.start)} – ${formatDate(domain.fmt, role.end)}: ${role.bullets[0]}`);
        const entryCorpus = corpusOf([domain.name, domain.contact, ...entries]);
        const entryProfile = profileOf(entryCorpus, {
          name: domain.name, contact: domain.contact,
          roles: domain.roles.map((role, index) => ({ id: `role-${index + 1}`, title: role.title, employer: role.employer, startDate: formatDate(domain.fmt, role.start), endDate: formatDate(domain.fmt, role.end), headerLines: [entries[index]], bullets: [entries[index]] })),
        });
        assert(accepts(entryProfile, entryCorpus), `${domain.key}: one-line role entries are accepted (${errorsOf(entryProfile, entryCorpus).join(' | ')})`);

        // A closing "key achievements" section lies in the last role's block. Attached to an earlier role it is refused unless the
        // line itself names that role's employer.
        const naming = `Cut turnaround by a third while at ${recent.employer}.`;
        const anonymous = 'Cut turnaround by a third across the whole programme.';
        for (const [line, expectedValid] of [[naming, true], [anonymous, false]]) {
          const tail = corpusOf([...linesOf(domain), 'Key achievements', line]);
          const tailSpec = specOf(domain);
          tailSpec.roles[0].bullets = [...tailSpec.roles[0].bullets, line];
          const tailProfile = profileOf(tail, tailSpec);
          const verdict = accepts(tailProfile, tail);
          assert(verdict === expectedValid, `${domain.key}: a closing-section line ${expectedValid ? 'that names the role\'s employer is accepted' : 'that names nothing about the role it is filed under is refused'} (${errorsOf(tailProfile, tail).join(' | ') || 'accepted'})`);
        }

        // A summary table followed by per-employer detail sections: the detail heading is a second header line of the same role.
        const tableLines = [domain.name, domain.contact, 'Experience summary',
          `${recent.title} | ${recent.employer} | ${formatDate(domain.fmt, recent.start)} – ${formatDate(domain.fmt, recent.end)}`,
          `${prior.title} | ${prior.employer} | ${formatDate(domain.fmt, prior.start)} – ${formatDate(domain.fmt, prior.end)}`,
          'Details', `At ${recent.employer}`, ...recent.bullets, `At ${prior.employer}`, ...prior.bullets];
        const table = corpusOf(tableLines);
        const tableSpec = specOf(domain);
        tableSpec.roles[0].headerLines = [tableLines[3], `At ${recent.employer}`];
        tableSpec.roles[1].headerLines = [tableLines[4], `At ${prior.employer}`];
        const tableProfile = profileOf(table, tableSpec);
        assert(accepts(tableProfile, table), `${domain.key}: a summary table with per-employer detail sections is accepted (${errorsOf(tableProfile, table).join(' | ')})`);
      }
    },
  },
  {
    name: 'career validators: a direct skill needs direct evidence beyond a non-skill ledger sentence, and a role link needs a role whose own ledger and evidence support it',
    run() {
      for (const domain of DOMAINS) {
        const { tool } = domain;
        const [recent, prior] = domain.roles;
        const key = tool.label.replace(/\s+/gu, '-');
        const ledger = (kind, line, segmentId) => ({
          technology: tool.label, disposition: kind, relationship: 'independent', relationshipGroup: '', relationshipEvidence: line, evidenceSegmentIds: [segmentId],
          ...(kind === 'skill' ? { skillId: `skill-${key}` } : { nonSkillReason: 'An evaluated product the candidate did not adopt is not demonstrated capability.' }),
        });
        const withLedger = (profile, corpus, achievementId, kind, line) => {
          const copy = structuredClone(profile);
          const achievement = achievementOf(copy, achievementId);
          achievement.technologies = [tool.label];
          achievement.technologyReferences = [ledger(kind, line, segmentFor(corpus, line))];
          return copy;
        };
        const skillRow = (corpus, { direct, evidence, roleIds }) => ({
          id: `skill-${key}`, name: tool.label, category: 'equipment', capabilityKind: 'tool', supportMode: 'direct',
          directEvidenceSegmentIds: direct.map(line => segmentFor(corpus, line)), indexEligible: true, roleIds, evidenceSegmentIds: evidence.map(line => segmentFor(corpus, line)),
        });
        const link = (profile, skill) => {
          const copy = structuredClone(profile);
          copy.skills = [skill];
          for (const role of copy.roles) role.skillIds = skill.roleIds.includes(role.id) ? [skill.id] : [];
          return copy;
        };
        const tweakFor = (index, extra) => ({ [index]: { bullets: [...domain.roles[index].bullets, ...extra] } });

        // --- direct evidence -------------------------------------------------------------------------------------------------
        // A: the only line that mentions the tool is the one the ledger calls a non-skill; a direct skill row cites it.
        const aOptions = { tweak: tweakFor(0, [tool.evaluated]) };
        const a = build(domain, aOptions);
        const evaluatedAchievement = `role-1-ach-${recent.bullets.length + 1}`;
        let forged = withLedger(a.profile, a.corpus, evaluatedAchievement, 'non-skill', tool.evaluated);
        forged = link(forged, skillRow(a.corpus, { direct: [tool.evaluated], evidence: [tool.evaluated], roleIds: [] }));
        const aErrors = errorsOf(forged, a.corpus);
        assert(aErrors.length === 1 && /only cite source line\(s\) in which the technology ledger classifies/u.test(aErrors[0]), `${domain.key}: A: a direct skill whose only evidence is its non-skill sentence is refused (${aErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled source also states a separate operating sentence the skill cites as direct evidence.
        const bOptions = { tweak: tweakFor(0, [tool.evaluated, tool.operated]) };
        const b = build(domain, bOptions);
        let bProfile = withLedger(b.profile, b.corpus, evaluatedAchievement, 'non-skill', tool.evaluated);
        bProfile = withLedger(bProfile, b.corpus, `role-1-ach-${recent.bullets.length + 2}`, 'skill', tool.operated);
        bProfile = link(bProfile, skillRow(b.corpus, { direct: [tool.operated], evidence: [tool.evaluated, tool.operated], roleIds: [] }));
        assert(accepts(bProfile, b.corpus), `${domain.key}: B: a separate operating sentence makes the skill admissible (${errorsOf(bProfile, b.corpus).join(' | ')})`);
        // C: the operating sentence removed again: the same forged profile is refused identically.
        const c = build(domain, aOptions);
        assert(JSON.stringify(errorsOf(forged, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: removing the operating sentence refuses the claim exactly as A did`);

        // --- role links ------------------------------------------------------------------------------------------------------
        // The prior role only evaluated the tool; the recent role operated it.
        const linkOptions = { tweak: { ...tweakFor(0, [tool.operated]), ...tweakFor(1, [tool.evaluated]) } };
        const l = build(domain, linkOptions);
        const operatedId = `role-1-ach-${recent.bullets.length + 1}`;
        const evaluatedId = `role-2-ach-${prior.bullets.length + 1}`;
        let linkProfile = withLedger(l.profile, l.corpus, operatedId, 'skill', tool.operated);
        linkProfile = withLedger(linkProfile, l.corpus, evaluatedId, 'non-skill', tool.evaluated);
        const faithful = link(linkProfile, skillRow(l.corpus, { direct: [tool.operated], evidence: [tool.operated], roleIds: ['role-1'] }));
        assert(accepts(faithful, l.corpus), `${domain.key}: control: a skill linked to the role that operated it is accepted (${errorsOf(faithful, l.corpus).join(' | ')})`);
        const wrongRole = link(linkProfile, skillRow(l.corpus, { direct: [tool.operated], evidence: [tool.operated, tool.evaluated], roleIds: ['role-1', 'role-2'] }));
        const wrongRoleErrors = errorsOf(wrongRole, l.corpus);
        assert(wrongRoleErrors.length === 1 && /roleIds links role role-2, whose only technology-ledger record/u.test(wrongRoleErrors[0]), `${domain.key}: A: the role that only evaluated the tool may not claim it (${wrongRoleErrors.join(' | ') || 'accepted'})`);
        // B: the prior role's recompiled source also operates it.
        const operatedAgain = `Operated the ${tool.label} to train new colleagues.`;
        const operatedBoth = { tweak: { ...tweakFor(0, [tool.operated]), ...tweakFor(1, [tool.evaluated, operatedAgain]) } };
        const lb = build(domain, operatedBoth);
        let bothProfile = withLedger(lb.profile, lb.corpus, operatedId, 'skill', tool.operated);
        bothProfile = withLedger(bothProfile, lb.corpus, evaluatedId, 'non-skill', tool.evaluated);
        bothProfile = withLedger(bothProfile, lb.corpus, `role-2-ach-${prior.bullets.length + 2}`, 'skill', operatedAgain);
        const both = link(bothProfile, skillRow(lb.corpus, { direct: [tool.operated, operatedAgain], evidence: [tool.operated, tool.evaluated, operatedAgain], roleIds: ['role-1', 'role-2'] }));
        assert(accepts(both, lb.corpus), `${domain.key}: B: once the prior role also operates it the link is admitted (${errorsOf(both, lb.corpus).join(' | ')})`);
        const lc = build(domain, linkOptions);
        const wrongRoleC = link(linkProfile, skillRow(lc.corpus, { direct: [tool.operated], evidence: [tool.operated, tool.evaluated], roleIds: ['role-1', 'role-2'] }));
        assert(JSON.stringify(errorsOf(wrongRoleC, lc.corpus)) === JSON.stringify(wrongRoleErrors), `${domain.key}: C: removing it refuses the link exactly as A did`);

        // A skill whose every cited line is another role's evidence cannot be attributed to this role.
        const foreign = link(linkProfile, skillRow(l.corpus, { direct: [tool.operated], evidence: [tool.operated], roleIds: ['role-2'] }));
        const foreignErrors = errorsOf(foreign, l.corpus);
        assert(foreignErrors.some(error => /roleIds links role role-2, but every source line the skill cites/u.test(error)), `${domain.key}: a skill evidenced only under another role cannot be linked to this one (${foreignErrors.join(' | ') || 'accepted'})`);
        // A skills-section line belongs to no role, so linking the skill to roles is not contradicted by it.
        const sectionLine = `Core competencies: ${tool.label}.`;
        const sectionCorpus = corpusOf([...linesOf(domain), sectionLine]);
        const sectionProfile = profileOf(sectionCorpus, specOf(domain));
        const sectionSkill = link(sectionProfile, skillRow(sectionCorpus, { direct: [sectionLine], evidence: [sectionLine], roleIds: ['role-1', 'role-2'] }));
        assert(accepts(sectionSkill, sectionCorpus), `${domain.key}: a skill listed in an unattributed skills section keeps its role links (${errorsOf(sectionSkill, sectionCorpus).join(' | ')})`);
      }
    },
  },
  {
    name: 'career validators: a shorter skill name is not stated by a longer symbol-joined name, while separators and spaced forms still state it',
    run() {
      const oneSkill = (domain, name, line) => {
        const role = { ...domain.roles[0], bullets: [line] };
        const options = { roles: [role, domain.roles[1]] };
        const corpus = corpusOf(linesOf(domain, options));
        const profile = profileOf(corpus, specOf(domain, options));
        const segment = segmentFor(corpus, line);
        profile.skills = [{ id: 'skill-claimed', name, category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: [segment], indexEligible: true, roleIds: ['role-1'], evidenceSegmentIds: [segment] }];
        roleOf(profile, 'role-1').skillIds = ['skill-claimed'];
        return { corpus, profile };
      };
      const cases = [
        [DOMAINS[0], 'R', 'R&D', 'Reported to the R&D committee on ward trials.', 'Reported to the R&D committee and R users on ward trials.'],
        [DOMAINS[1], 'C', 'C++', 'Scripted the oven controller firmware in C++.', 'Scripted the oven controller firmware in C++ and C.'],
        [DOMAINS[2], 'F', 'F#', 'Prototyped load models in F#.', 'Prototyped load models in F# and F.'],
        [DOMAINS[3], 'C', 'C#', 'Maintained the dock scheduler in C#.', 'Maintained the dock scheduler in C# and C.'],
      ];
      for (const [domain, claim, longer, line, lineWithClaim] of cases) {
        // The longer name is stated; the shorter one is a different skill.
        const faithful = oneSkill(domain, longer, line);
        assert(accepts(faithful.profile, faithful.corpus), `${domain.key}: control: ${longer} is stated by its own line (${errorsOf(faithful.profile, faithful.corpus).join(' | ')})`);
        const a = oneSkill(domain, claim, line);
        const aErrors = errorsOf(a.profile, a.corpus);
        assert(aErrors.some(error => /skills\[skill-claimed\]\.name is not grounded/u.test(error)), `${domain.key}: A: "${claim}" is not stated by "${longer}" (${aErrors.join(' | ') || 'accepted'})`);
        // B: the recompiled source also uses the shorter name on its own.
        const b = oneSkill(domain, claim, lineWithClaim);
        assert(accepts(b.profile, b.corpus), `${domain.key}: B: a source that also states "${claim}" admits it (${errorsOf(b.profile, b.corpus).join(' | ')})`);
        // C: removed again.
        const c = oneSkill(domain, claim, line);
        assert(JSON.stringify(errorsOf(c.profile, c.corpus)) === JSON.stringify(aErrors), `${domain.key}: C: removing it refuses the claim exactly as A did`);
      }
      // Separators and spacing do not continue a name.
      for (const [name, line] of [
        ['Java', 'Built services with Java+Spring for the portal.'],
        ['Spring', 'Built services with Java+Spring for the portal.'],
        ['C', 'Wrote drivers in C, C++ and Rust.'],
        ['R', 'Reported to the R & D committee as an R user.'],
        ['Excel', 'Kept the roster in Excel.'],
        ['C++', 'Wrote drivers in C++.'],
      ]) {
        const built = oneSkill(DOMAINS[0], name, line);
        assert(accepts(built.profile, built.corpus), `"${name}" is stated by "${line}" (${errorsOf(built.profile, built.corpus).join(' | ')})`);
      }
    },
  },
  {
    name: 'career validators: a person, an employer or a place is not a skill unless something other than that label states it',
    run() {
      const places = { nurse: 'Duluth, Minnesota', chef: 'Portland, Oregon', engineer: 'Calgary, Alberta', warehouse: 'Savannah, Georgia' };
      for (const domain of DOMAINS) {
        const place = places[domain.key];
        const [recent, prior] = domain.roles;
        const header = `${recent.title}, ${recent.employer}, ${place}`;
        const dates = dateLine(domain, recent);
        const sourceFor = extra => [domain.name, domain.contact, header, dates, ...recent.bullets, ...extra, headerLine(prior), dateLine(domain, prior), ...prior.bullets];
        const specFor = () => ({
          name: domain.name, contact: domain.contact,
          roles: [
            { id: 'role-1', title: recent.title, employer: recent.employer, startDate: formatDate(domain.fmt, recent.start), endDate: formatDate(domain.fmt, recent.end), headerLines: [header, dates], bullets: recent.bullets },
            { id: 'role-2', title: prior.title, employer: prior.employer, startDate: formatDate(domain.fmt, prior.start), endDate: formatDate(domain.fmt, prior.end), headerLines: [headerLine(prior), dateLine(domain, prior)], bullets: prior.bullets },
          ],
        });
        const withSkill = (corpus, name, citedLine, { evidenceLines = [citedLine] } = {}) => {
          const profile = profileOf(corpus, specFor());
          profile.roles[0].location = place;
          const segment = segmentFor(corpus, citedLine);
          profile.skills = [{ id: 'skill-claimed', name, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct', directEvidenceSegmentIds: [segment], indexEligible: true, roleIds: [], evidenceSegmentIds: evidenceLines.map(line => segmentFor(corpus, line)) }];
          return profile;
        };
        for (const [kind, label, line] of [
          ['employer', recent.employer, header],
          ['person', domain.name, domain.name],
          ['place', place, header],
        ]) {
          // A: the only line that holds the label is an identity or header line.
          const a = corpusOf(sourceFor([]));
          const claim = withSkill(a, label, line);
          const aErrors = errorsOf(claim, a);
          assert(aErrors.length === 1 && /skills\[skill-claimed\]\.name .* is stated only inside the candidate's name or contact details or an employer\/location label/u.test(aErrors[0]),
            `${domain.key}: A: the ${kind} "${label}" is not a skill (${aErrors.join(' | ') || 'accepted'})`);
          // B: a recompiled source that states it elsewhere (a skills line) admits the same name.
          const skillsLine = `Core competencies: ${label}.`;
          const bSource = corpusOf(sourceFor([skillsLine]));
          const admitted = withSkill(bSource, label, line, { evidenceLines: [line, skillsLine] });
          admitted.skills[0].directEvidenceSegmentIds = [segmentFor(bSource, skillsLine)];
          assert(accepts(admitted, bSource), `${domain.key}: B: a line that states "${label}" outside its label admits it (${errorsOf(admitted, bSource).join(' | ')})`);
          // C: removed again.
          const c = corpusOf(sourceFor([]));
          assert(JSON.stringify(errorsOf(withSkill(c, label, line), c)) === JSON.stringify(aErrors), `${domain.key}: C: removing it refuses the claim exactly as A did`);
        }
        // A title that contains the word is not the employer label: the skill is stated by the title.
        const titled = { ...recent, title: `${recent.employer.split(' ')[0]} Coordinator` };
        const titleHeader = `${titled.title}, ${titled.employer}, ${place}`;
        const titleCorpus = corpusOf([domain.name, domain.contact, titleHeader, dates, ...recent.bullets]);
        const titleProfile = profileOf(titleCorpus, { name: domain.name, contact: domain.contact, roles: [{ id: 'role-1', title: titled.title, employer: titled.employer, startDate: formatDate(domain.fmt, recent.start), endDate: formatDate(domain.fmt, recent.end), headerLines: [titleHeader, dates], bullets: recent.bullets }] });
        titleProfile.roles[0].location = place;
        const titleSegment = segmentFor(titleCorpus, titleHeader);
        const firstWord = recent.employer.split(' ')[0];
        titleProfile.skills = [{ id: 'skill-claimed', name: firstWord, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct', directEvidenceSegmentIds: [titleSegment], indexEligible: true, roleIds: [], evidenceSegmentIds: [titleSegment] }];
        assert(accepts(titleProfile, titleCorpus), `${domain.key}: "${firstWord}" in a job title is stated by the title, not only by the employer label (${errorsOf(titleProfile, titleCorpus).join(' | ')})`);
        // Technology and employer sharing a name: a duty that uses the technology states it.
        const sameName = domain.tool.label.split(' ')[0];
        const nameSake = { ...recent, employer: `${sameName[0].toUpperCase()}${sameName.slice(1)} Works` };
        const dutyLine = `Administered the ${sameName} programme for the team.`;
        const sameNameCorpus = corpusOf([domain.name, domain.contact, `${nameSake.title}, ${nameSake.employer}`, dates, dutyLine]);
        const sameNameProfile = profileOf(sameNameCorpus, { name: domain.name, contact: domain.contact, roles: [{ id: 'role-1', title: nameSake.title, employer: nameSake.employer, startDate: formatDate(domain.fmt, recent.start), endDate: formatDate(domain.fmt, recent.end), headerLines: [`${nameSake.title}, ${nameSake.employer}`, dates], bullets: [dutyLine] }] });
        const dutySegment = segmentFor(sameNameCorpus, dutyLine);
        sameNameProfile.skills = [{ id: 'skill-claimed', name: sameName, category: 'claimed', capabilityKind: 'capability', supportMode: 'direct', directEvidenceSegmentIds: [dutySegment], indexEligible: true, roleIds: [], evidenceSegmentIds: [dutySegment] }];
        assert(accepts(sameNameProfile, sameNameCorpus), `${domain.key}: a skill that shares its name with the employer is stated by a duty that uses it (${errorsOf(sameNameProfile, sameNameCorpus).join(' | ')})`);
      }
    },
  },
  {
    name: 'career validators: retained historical pins keep the original validator (the stricter rules apply to the current contract only)',
    run() {
      const domain = DOMAINS[0];
      const { corpus, profile } = build(domain);
      const swapped = structuredClone(profile);
      [roleOf(swapped, 'role-1').startDate, roleOf(swapped, 'role-1').endDate] = [roleOf(swapped, 'role-1').endDate, roleOf(swapped, 'role-1').startDate];
      const truncated = structuredClone(profile);
      achievementOf(truncated, 'role-1-ach-1').claim = 'Coordinated bedside handoffs across a twenty eight bed cardiac unit.';
      const historical = { allowHistoricalSkillNameDuplicates: true, allowHistoricalTechnologySemantics: true };
      assert(!validateCareerProfile(withCoverage(swapped, corpus), corpus).valid, 'the current contract refuses swapped dates');
      assert(validateCareerProfile(withCoverage(swapped, corpus), corpus, historical).valid, 'a retained historical pin is judged by the validator it was approved under');
      assert(validateCareerProfile(withCoverage(truncated, corpus), corpus, historical).valid, 'control: an unchanged claim stays valid under both validators');
    },
  },
  {
    name: 'career validators: skill normalisation and grounding give the same verdicts under every host locale',
    run() {
      const reference = localeProbe();
      assert(reference.duplicateReported && reference.nonDuplicateKept, `the probe must exercise the duplicate-name rule (${JSON.stringify(reference)})`);
      const here = fileURLToPath(import.meta.url);
      const register = path.resolve(path.dirname(here), '../test-stubs/register.mjs');
      for (const locale of ['tr_TR.UTF-8', 'az_AZ.UTF-8', 'lt_LT.UTF-8', 'en_US.UTF-8', 'C']) {
        const env = { ...process.env, LC_ALL: locale, LANG: locale, LANGUAGE: locale };
        const child = spawnSync(process.execPath, [
          '--import', register, '--input-type=module', '-e',
          `import(${JSON.stringify(new URL(import.meta.url).href)}).then(module => { process.stdout.write(JSON.stringify(module.localeProbe())); });`,
        ], { env, encoding: 'utf8' });
        assert(child.status === 0, `locale ${locale}: the probe ran (${child.stderr.slice(0, 300)})`);
        assert(child.stdout === JSON.stringify(reference), `locale ${locale}: verdicts match the reference (${child.stdout} vs ${JSON.stringify(reference)})`);
      }
    },
  },
];

/**
 * Two skill rows whose names differ only in a case-fold that is locale sensitive
 * ("İ" lower-cases to "i" under tr/az but to "i" + combining dot everywhere
 * else), plus a pair that really differs. Reports which duplicates are found.
 */
export function localeProbe() {
  const upper = 'İSTANBUL';
  const lower = 'i̇stanbul';
  const other = 'Ankara';
  const line = `Operated ${upper} and ${lower} and ${other} tooling.`;
  const corpus = corpusOf(['Ayşe Yılmaz', 'ayse.yilmaz@example.test', 'Planner, Bosporus Works', 'January 2020 – Present', line]);
  const spec = { name: 'Ayşe Yılmaz', contact: 'ayse.yilmaz@example.test', roles: [{ id: 'role-1', title: 'Planner', employer: 'Bosporus Works', startDate: 'January 2020', endDate: 'Present', headerLines: ['Planner, Bosporus Works', 'January 2020 – Present'], bullets: [line] }] };
  const profile = profileOf(corpus, spec);
  const segment = segmentFor(corpus, line);
  const row = (id, name) => ({ id, name, category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: [segment], indexEligible: true, roleIds: ['role-1'], evidenceSegmentIds: [segment] });
  profile.skills = [row('skill-upper', upper), row('skill-lower', lower), row('skill-other', other)];
  profile.roles[0].skillIds = profile.skills.map(skill => skill.id);
  const errors = validateCareerProfile(withCoverage(profile, corpus), corpus).errors;
  return {
    duplicateReported: errors.some(error => error.includes('skills[skill-lower].name duplicates the Unicode/case-insensitive skill name used by skills[skill-upper]')),
    nonDuplicateKept: !errors.some(error => error.includes('skills[skill-other].name duplicates')),
  };
}
