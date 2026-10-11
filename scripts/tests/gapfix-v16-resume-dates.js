// Regression tests for how a résumé PRINTS a host-owned date (v16, work package E).
//
// A live run's independent reviewers all read date ranges printed as
// "Month, YYYY – Month, YYYY": the stray comma a source leaves after a month,
// carried through to the page. Role dates were already tidied when rendered, but
// education and certification dates were not, a spelling such as "Sept., YYYY"
// was out of the tidy's reach, and a writer that tidied the comma itself was
// refused for not copying the approved text. Three properties are pinned here,
// for careers in unrelated fields that write their dates in unrelated styles:
//
//   1. DISPLAY. The printed date of a role, an education record and a
//      certification drops the comma after an English month name and reads a
//      spaced hyphen between two date endpoints as the en dash the design system
//      uses. Every other form (en dash, "Present", year-only, seasons, quarters,
//      ISO and numeric dates, non-English month names, a written day) prints
//      exactly as the source wrote it, and applying the tidy twice changes
//      nothing more. It can change a glyph, never a digit, a month or a word.
//   2. GROUNDING. The validated draft keeps the approved spelling byte for
//      byte; the tidy is a projection applied where the page is printed. Date
//      grounding is not loosened: a shifted month or year, a dropped end of a
//      range, a different joining word, or a date the cited evidence does not
//      state is refused whatever punctuation it wears, and the same draft flips
//      from admissible to refused when the evidence it cites changes.
//   3. TOLERANCE. A writer that restates a date the way it is printed has still
//      copied it: the host writes the approved spelling in its place (a typed
//      event carrying hashes only) before any validator reads the response.
//   4. SKILL SPELLING. The same host-written treatment covers a skill item: a
//      case or spacing variant of an approved skill name is stored as the
//      inventory spells it, so the stored draft, the reviewers' view of it and
//      the printed page agree. The host copies only what the authority's own
//      group gate returns; a group with anything the gate refuses is left
//      exactly as written.
//
// Every fixture is synthetic. The careers (freight dispatch, clinic scheduling,
// library cataloguing, civil site engineering, retail analytics) share no
// employer, school, date or wording with any real person or posting, and the
// expected printed form of each date is written out in the fixture, never
// computed by the code under test.
import { assert } from './testHelpers.js';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import { buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { canonicalizeHostOwnedResumeFields, HOST_FIELD_CANONICALIZED_EVENT } from '../../electron/ipc/hostOwnedResumeFields.js';
import { formatRoleDateForPresentation, renderStructuredApplicationResume, sameDatePresentation, validateStructuredResumeDraft } from '../../electron/ipc/structuredResume.js';
import { assertCandidateDashPunctuation } from '../../electron/ipc/resumeHtml.js';
import { checkEndedRoleCurrentEmployment } from '../../electron/ipc/coverLetterChecks.js';
import { calculateDatedTenure } from '../../electron/ipc/jobFitAssessment.js';
import { __selectedSourceRolesForTests, __validateAuthorityResumeArtifactsForTests } from '../../electron/ipc/localAiApplication.js';

const EN = '–';

// ---------------------------------------------------------------------------
// Synthetic careers. `dates` is the approved spelling; `shown` is the form the
// page must print. `alt` is a way a writer might restate the same date (every
// one prints identically to the approved spelling).
// ---------------------------------------------------------------------------
const CAREERS = [
  {
    key: 'freight', name: 'Imogen Farrow', email: 'imogen.farrow@example.test', bullet: 'Routed forty haulers through one depot every morning.',
    role: { id: 'role-cobalt', title: 'Dispatch Coordinator', employer: 'Cobalt Haul Partners', location: 'Duluth, MN', start: 'March, 2017', end: 'June, 2019' },
    edu: { id: 'edu-lake', credential: 'B.S. Logistics', institution: 'Lakeshore College', dates: `Sept., 2009 ${EN} June, 2013` },
    cert: { id: 'cert-plan', name: 'Certified Transport Planner', issuer: 'Freight Council', dates: 'November, 2019' },
    shown: { role: `March 2017 ${EN} June 2019`, edu: `Sept. 2009 ${EN} June 2013`, cert: 'November 2019' },
    alt: { role: `March 2017 ${EN} June 2019`, edu: `Sept. 2009 ${EN} June 2013`, cert: 'November 2019' },
    skills: [{ id: 'skill-sheet', name: 'Excel', written: 'excel' }, { id: 'skill-viz', name: 'Tableau', written: 'TABLEAU' }, { id: 'skill-stat', name: 'R', written: 'r' }],
  },
  {
    key: 'clinic', name: 'Teodoro Brightwater', email: 'teodoro.brightwater@example.test', bullet: 'Rebuilt the weekly appointment grid for six exam rooms.',
    role: { id: 'role-larkspur', title: 'Front Desk Scheduler', employer: 'Larkspur Family Clinic', location: 'Tacoma, WA', start: 'Oct 2018 - Jan 2021', end: '' },
    edu: { id: 'edu-health', credential: 'A.A.S. Health Administration', institution: 'Pinecrest Community College', dates: '2011 - 2015' },
    cert: { id: 'cert-hipaa', name: 'Medical Office Specialist', issuer: 'Allied Health Board', dates: 'Aug 2020' },
    shown: { role: `Oct 2018 ${EN} Jan 2021`, edu: `2011 ${EN} 2015`, cert: 'Aug 2020' },
    alt: { role: `Oct 2018 ${EN} Jan 2021`, edu: `2011 ${EN} 2015`, cert: 'Aug, 2020' },
    skills: [{ id: 'skill-msg', name: 'HL7', written: 'hl7' }, { id: 'skill-flow', name: 'Visio', written: 'viSIO' }, { id: 'skill-lang', name: 'Go', written: 'go' }],
  },
  {
    key: 'library', name: 'Marisol Quenby', email: 'marisol.quenby@example.test', bullet: 'Catalogued a donated map collection of nine hundred sheets.',
    role: { id: 'role-ashgrove', title: 'Cataloguing Assistant', employer: 'Ashgrove Public Library', location: 'Ottawa, ON', start: 'mai, 2012', end: 'juin, 2016' },
    edu: { id: 'edu-info', credential: 'M.L.I.S. Library Science', institution: 'Beaumont University', dates: `mars 2008 ${EN} 2010` },
    cert: { id: 'cert-meta', name: 'Metadata Standards Certificate', issuer: 'Archive Guild', dates: 'Summer, 2016' },
    shown: { role: `mai, 2012 ${EN} juin, 2016`, edu: `mars 2008 ${EN} 2010`, cert: 'Summer, 2016' },
    alt: { role: `mai, 2012 ${EN} juin, 2016`, edu: `mars 2008 ${EN} 2010`, cert: 'Summer, 2016' },
    skills: [{ id: 'skill-marc', name: 'MARC21', written: 'marc21' }, { id: 'skill-dc', name: 'Dublin Core', written: 'dublin   core' }, { id: 'skill-sharp', name: 'C#', written: 'c#' }],
  },
  {
    key: 'civil', name: 'Ingrid Valdemar', email: 'ingrid.valdemar@example.test', bullet: 'Checked rebar schedules for a four storey parking structure.',
    role: { id: 'role-tidewater', title: 'Site Engineer', employer: 'Tidewater Civil Works', location: 'Mobile, AL', start: 'Sept., 2012', end: 'Dec., 2016' },
    edu: { id: 'edu-civil', credential: 'B.Eng. Civil Engineering', institution: 'Caldera Institute', dates: 'Aug, 2005 - May, 2009' },
    cert: { id: 'cert-eit', name: 'Engineer in Training', issuer: 'State Licensing Board', dates: '2018' },
    shown: { role: `Sept. 2012 ${EN} Dec. 2016`, edu: `Aug 2005 ${EN} May 2009`, cert: '2018' },
    alt: { role: `Sept. 2012 ${EN} Dec. 2016`, edu: `Aug 2005 ${EN} May 2009`, cert: '2018' },
    skills: [{ id: 'skill-cad', name: 'AutoCAD', written: 'autocad' }, { id: 'skill-civ', name: 'Civil 3D', written: 'CIVIL 3D' }, { id: 'skill-c', name: 'C', written: 'c' }],
  },
  {
    key: 'retail', name: 'Anselm Okoro', email: 'anselm.okoro@example.test', bullet: 'Forecast weekly demand for two hundred shelf categories.',
    role: { id: 'role-fernhill', title: 'Merchandise Analyst', employer: 'Fernhill Stores', location: 'Dayton, OH', start: '2016-04', end: '2020-09' },
    edu: { id: 'edu-stats', credential: 'B.A. Statistics', institution: 'Whitlock College', dates: `2010 ${EN} 2014` },
    cert: { id: 'cert-sql', name: 'Data Analyst Credential', issuer: 'Analytics Society', dates: '2021-03' },
    shown: { role: `2016-04 ${EN} 2020-09`, edu: `2010 ${EN} 2014`, cert: '2021-03' },
    alt: { role: `2016-04 - 2020-09`, edu: `2010 ${EN} 2014`, cert: '2021-03' },
    skills: [{ id: 'skill-bi', name: 'Power BI', written: 'power bi' }, { id: 'skill-look', name: 'Looker', written: 'LOOKER' }, { id: 'skill-dee', name: 'D', written: 'd' }],
  },
];

const approvedRoleDates = career => [career.role.start, career.role.end].filter(Boolean).join(` ${EN} `);

// ---------------------------------------------------------------------------
// Builders: the approved snapshot, its authority, a writer's résumé and the
// corpus text a role region is read from.
// ---------------------------------------------------------------------------
function snapshotOf(career, overrides = {}) {
  const roleId = career.role.id; const achievementId = `achievement-${career.key}`;
  const edu = { ...career.edu, ...(overrides.edu || {}) }; const cert = { ...career.cert, ...(overrides.cert || {}) };
  const none = [];
  return {
    snapshotId: `dates-${career.key}`, status: CAREER_SNAPSHOT_STATUS_APPROVED,
    profile: {
      identity: { name: career.name, contacts: [career.email], evidenceSegmentIds: none },
      roles: [{ id: roleId, title: career.role.title, employer: career.role.employer, startDate: career.role.start, endDate: career.role.end, location: career.role.location, achievementIds: [achievementId], skillIds: career.skills.map(skill => skill.id), evidenceSegmentIds: none }],
      achievements: [{ id: achievementId, roleId, claim: career.bullet, technologies: career.skills.map(skill => skill.name),
        technologyReferences: career.skills.map(skill => ({ technology: skill.name, disposition: 'skill', skillId: skill.id, relationship: 'independent', relationshipGroup: '', relationshipEvidence: career.bullet, evidenceSegmentIds: none })),
        metrics: [], evidenceSegmentIds: none }],
      projects: [],
      skills: career.skills.map(skill => ({ id: skill.id, name: skill.name, category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: ['seg-1'], indexEligible: true, roleIds: [roleId], evidenceSegmentIds: ['seg-1'] })),
      education: [{ id: edu.id, credential: edu.credential, institution: edu.institution, dates: edu.dates, evidenceSegmentIds: none }],
      certifications: [{ id: cert.id, name: cert.name, issuer: cert.issuer, dates: cert.dates, evidenceSegmentIds: none }],
      otherEvidence: [], segmentCoverage: [],
    },
  };
}

function kitOf(career, overrides = {}) {
  const snapshot = snapshotOf(career, overrides);
  const authority = buildApplicationCareerAuthority(snapshot);
  const acceptedEvidence = approvedCareerEvidenceCatalog(snapshot);
  const [source] = authority.sourceRoles;
  const careerData = [`### ${source.title} — ${source.company} [Role ID: ${source.id}]`, `${source.company} — ${source.location}`, `Dates: ${source.dates}`, career.bullet].join('\n');
  return { snapshot, authority, acceptedEvidence, sourceRoles: authority.sourceRoles, careerData };
}

// The résumé a writer sends. `dates` overrides the three printed date fields.
function resumeOf(career, kit, dates = {}) {
  const [source] = kit.sourceRoles;
  return {
    schemaVersion: 'structured-resume.v1', identity: { name: career.name, contact: [career.email] },
    roles: [{ id: source.id, title: source.title, company: source.company, dates: dates.role ?? source.dates, location: source.location,
      bullets: [{ id: 'bullet-1', text: career.bullet, evidenceIds: [`host.career.achievement.achievement-${career.key}.1`] }] }],
    education: [{ id: 'education-1', credential: career.edu.credential, institution: career.edu.institution, dates: dates.edu ?? kit.snapshot.profile.education[0].dates,
      evidenceIds: [`host.career.education.${career.edu.id}.1`, `host.career.education.${career.edu.id}.3`] }],
    credentials: [{ id: 'credential-1', name: career.cert.name, issuer: career.cert.issuer, dates: dates.cert ?? kit.snapshot.profile.certifications[0].dates,
      evidenceIds: [`host.career.certification.${career.cert.id}.1`, `host.career.certification.${career.cert.id}.2`] }],
  };
}

const validationContext = kit => ({ sourceRoles: kit.sourceRoles, evidenceCatalog: kit.acceptedEvidence, careerData: kit.careerData, authorityMode: true, careerSkillEvidence: null });
const validate = (resume, kit) => validateStructuredResumeDraft(resume, validationContext(kit));
const render = (resume, kit) => renderStructuredApplicationResume(resume, validationContext(kit));
const canonicalize = (resume, kit) => canonicalizeHostOwnedResumeFields(resume, { authority: kit.authority, acceptedEvidence: kit.acceptedEvidence, sourceRoles: kit.sourceRoles });
const authorityErrors = (resume, kit) => __validateAuthorityResumeArtifactsForTests(resume, kit.acceptedEvidence, kit.authority, kit.sourceRoles);

function settle(fn) { try { return { value: fn() }; } catch (error) { return { error }; } }
const rejects = (fn, pattern) => { const { error } = settle(fn); return Boolean(error) && pattern.test(error.message); };

const roleCell = html => /<p class="role-dates">([^<]*)/u.exec(html)?.[1];
const educationCell = html => /<section class="section education"[\s\S]*?<dd>([^<]*)<\/dd>/u.exec(html)?.[1];
const certificationCell = html => /<section class="section certifications"[\s\S]*?<dd>([^<]*)<\/dd>/u.exec(html)?.[1];

// Independent mutators (test oracles, not production code).
const MONTH_NAMES = Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2001, month, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }));
const shiftLastYear = value => value.replace(/(\d{4})(?!.*\d{4})/u, year => String(Number(year) + 1));
const shiftFirstYear = value => value.replace(/\d{4}/u, year => String(Number(year) + 1));
function shiftFirstMonth(value) {
  const named = /(?<![\p{L}\p{N}])(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*/u.exec(value);
  if (named) {
    const next = { Jan: 'Feb', Feb: 'Mar', Mar: 'Apr', Apr: 'Jun', May: 'Jul', Jun: 'Aug', Jul: 'Sep', Aug: 'Oct', Sep: 'Nov', Sept: 'Nov', Oct: 'Dec', Nov: 'Jan', Dec: 'Mar' }[named[1]];
    return value.replace(named[0], next);
  }
  const iso = /(\d{4})-(\d{2})/u.exec(value);
  if (iso) return value.replace(iso[0], `${iso[1]}-${String((Number(iso[2]) % 12) + 1).padStart(2, '0')}`);
  return null;
}
const dropEnd = value => value.split(new RegExp(`\\s*[${EN}-]\\s*`, 'u'))[0];
const joinWithWord = value => value.replace(new RegExp(`\\s*[${EN}-]\\s*`, 'u'), ' to ');

// Strips only what the display tidy is allowed to touch.
const glyphFree = value => value.replace(new RegExp(`[\\s,\\-${EN}]`, 'gu'), '');

export default [
  {
    name: 'Résumé date display: drops the comma after an English month and tidies a spaced hyphen range, and prints every other form exactly as written',
    run() {
      const tidied = [
        ['August, 2014 – February, 2017', 'August 2014 – February 2017'], ['July, 2011 – April, 2013', 'July 2011 – April 2013'],
        ['Sept., 2018 – Present', 'Sept. 2018 – Present'], ['Sep. , 2019', 'Sep. 2019'], ['Nov,2015', 'Nov 2015'], ['JUNE , 2009', 'JUNE 2009'],
        ['Completed March, 2007', 'Completed March 2007'], ['Jan, 2020 – Mar, 2021', 'Jan 2020 – Mar 2021'],
        ['2016 - 2020', '2016 – 2020'], ['April 2012 - Present', 'April 2012 – Present'], ['Aug, 2005 - May, 2009', 'Aug 2005 – May 2009'],
        ['2019 - ongoing', '2019 – ongoing'], ['2020-03 - 2021-05', '2020-03 – 2021-05'], ['1/2020 - 5/2021', '1/2020 – 5/2021'],
      ];
      for (const [written, expected] of tidied) {
        const shown = formatRoleDateForPresentation(written);
        assert(shown === expected, `"${written}" prints as "${shown}", expected "${expected}"`);
        assert(formatRoleDateForPresentation(shown) === shown, `tidying "${written}" twice must change nothing more (got "${formatRoleDateForPresentation(shown)}")`);
        assert(glyphFree(shown) === glyphFree(written), `tidying "${written}" may change a glyph but never a digit, month or word (got "${shown}")`);
      }
      const asWritten = [
        `August 2014 ${EN} February 2017`, `2020 ${EN} 2024`, `2019 ${EN} Present`, 'Present', 'Q3 2021', 'Summer 2019', 'Fall, 2020', '2020-03', `2020-03 ${EN} 2021-05`, '03/2020',
        'mai, 2020', 'Mai, 2020', `mars 2019 ${EN} juin, 2021`, 'mars 2019 - juin, 2021', 'März, 2019', 'enero, 2020', 'Mayo, 2020', 'Juli, 2020', 'May 5, 2023', '2022, April', 'April 2022', 'Sept. 2023',
        'Completed 2007', 'Q2 ’20 - Q1 ’21', 'Spring 2020 - Fall 2021', 'A - B', '2016-2020', 'June, 20114', 'Decimal, 2020', 'Gemar, 2020', '',
      ];
      for (const value of asWritten) {
        assert(formatRoleDateForPresentation(value) === value, `"${value}" is already how it should print and must be returned unchanged (got "${formatRoleDateForPresentation(value)}")`);
      }
      assert(formatRoleDateForPresentation(null) === '' && formatRoleDateForPresentation(undefined) === '', 'a missing date prints as the empty string');
      // Every month, spelled in full and abbreviated, with and without the comma and period.
      const abbreviations = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec'];
      for (const month of [...MONTH_NAMES, ...abbreviations]) {
        for (const year of [1994, 2003, 2019, 2026]) {
          for (const period of ['', '.']) {
            const expected = `${month}${period} ${year}`;
            for (const raw of [`${month}${period}, ${year}`, `${month}${period},${year}`, `${month}${period} , ${year}`, expected]) {
              assert(formatRoleDateForPresentation(raw) === expected, `"${raw}" prints as "${formatRoleDateForPresentation(raw)}", expected "${expected}"`);
            }
          }
        }
      }
    },
  },
  {
    name: 'Résumé date display: the printed role, education and certification dates of five unrelated careers, with the draft keeping the approved spelling',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const [source] = kit.sourceRoles;
        assert(source.dates === approvedRoleDates(career), `${career.key}: fixture: the authority states the role dates as "${approvedRoleDates(career)}" (got "${source.dates}")`);
        const resume = resumeOf(career, kit);
        const draft = validate(resume, kit);
        assert(draft.roles[0].dates === source.dates && draft.education[0].dates === career.edu.dates && draft.credentials[0].dates === career.cert.dates,
          `${career.key}: the validated draft keeps every approved date spelling byte for byte`);
        const html = render(resume, kit);
        assert(roleCell(html) === career.shown.role, `${career.key}: role dates print as "${career.shown.role}" (got "${roleCell(html)}")`);
        assert(educationCell(html) === `${career.edu.institution} · ${career.shown.edu}`, `${career.key}: education prints "${career.shown.edu}" (got "${educationCell(html)}")`);
        assert(certificationCell(html) === `${career.cert.issuer} · ${career.shown.cert}`, `${career.key}: certification prints "${career.shown.cert}" (got "${certificationCell(html)}")`);
        assert(roleCell(html) === formatRoleDateForPresentation(source.dates), `${career.key}: the printed role cell is exactly the host's trusted display projection`);
        assert(resume.roles[0].dates === source.dates && resume.education[0].dates === career.edu.dates, `${career.key}: rendering leaves the response untouched`);
      }
    },
  },
  {
    name: 'Résumé date display: a source range written with a spaced hyphen reaches the candidate-copy dash gate as an en dash in every date cell',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const html = render(resumeOf(career, kit), kit);
        const trusted = [formatRoleDateForPresentation(kit.sourceRoles[0].dates)];
        const gate = markup => assertCandidateDashPunctuation({ resumeMainHtml: markup, trustedRenderedRoleDates: trusted });
        assert(!rejects(() => gate(html), /./u), `${career.key}: the printed résumé passes the dash gate`);
        const rawEdu = `${career.edu.institution} · ${career.edu.dates}`;
        if (/\s-\s/u.test(career.edu.dates)) {
          // What printing the source text verbatim would have done: the gate refuses a spaced hyphen in a date cell it does not mask.
          const verbatim = html.replace(`${career.edu.institution} · ${career.shown.edu}`, rawEdu);
          assert(verbatim !== html && rejects(() => gate(verbatim), /spaced hyphen/u),
            `${career.key}: fixture: a verbatim spaced-hyphen education range is what the dash gate refuses`);
        }
      }
    },
  },
  {
    name: 'Résumé date grounding: a role date is accepted in any spelling that prints like the approved one, and any change to a month, year or word is refused',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const [source] = kit.sourceRoles;
        for (const written of [source.dates, career.alt.role, career.shown.role]) {
          const draft = validate(resumeOf(career, kit, { role: written }), kit);
          assert(draft.roles[0].dates === source.dates, `${career.key}: "${written}" prints like the approved role date, so the draft carries the approved spelling (got "${draft.roles[0].dates}")`);
          assert(sameDatePresentation(written, source.dates), `${career.key}: "${written}" and the approved date print identically`);
        }
        const mutants = [
          ['year +1 (first)', shiftFirstYear(career.shown.role)], ['year +1 (last)', shiftLastYear(career.shown.role)], ['month shifted', shiftFirstMonth(career.shown.role)],
          ['one end of the range dropped', dropEnd(career.shown.role)], ['joined by a word', joinWithWord(career.shown.role)],
          ['year +1 on the approved spelling', shiftLastYear(source.dates)],
        ];
        const exact = `expected exactly: ${JSON.stringify(source.dates)}`;
        for (const [label, mutated] of mutants) {
          if (mutated === null) continue;
          assert(mutated !== source.dates && !sameDatePresentation(mutated, source.dates), `${career.key}: fixture: mutation "${label}" really changes the date ("${mutated}")`);
          assert(rejects(() => validate(resumeOf(career, kit, { role: mutated }), kit), new RegExp(`roles\\[0\\]\\.dates must exactly match its trusted source role; ${exact.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u')),
            `${career.key}: mutation "${label}" ("${mutated}") must be refused with the approved date`);
        }
      }
      // A comma a source STATES in a non-English month is the source's spelling: dropping it is a different string, not a tidy.
      const library = CAREERS.find(career => career.key === 'library');
      const kit = kitOf(library);
      assert(rejects(() => validate(resumeOf(library, kit, { role: `mai 2012 ${EN} juin 2016` }), kit), /roles\[0\]\.dates must exactly match/u),
        'a non-English month keeps its source comma, so a restatement without it is refused');
    },
  },
  {
    name: 'Résumé date grounding: an education or certification date is grounded in the evidence it cites, and the same draft flips when that evidence changes',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const eduRule = /education\.education-1\.dates must occur in its cited career-data evidence/u;
        const oneEndRule = /education\.education-1\.dates “[^”]*” is only one end of a date range/u;
        const certRule = /credentials\.credential-1\.dates must occur in its cited career-data evidence/u;
        validate(resumeOf(career, kit), kit);
        for (const [label, mutated, field, rule] of [
          ['education year +1', shiftLastYear(career.edu.dates), 'edu', eduRule], ['education one end dropped', dropEnd(career.edu.dates), 'edu', oneEndRule],
          ['education joined by a word', joinWithWord(career.edu.dates), 'edu', eduRule], ['certification year +1', shiftLastYear(career.cert.dates), 'cert', certRule],
          ['certification month shifted', shiftFirstMonth(career.cert.dates), 'cert', certRule], ['the education date on the certification', career.edu.dates, 'cert', certRule],
          ['the certification date on the education record', career.cert.dates, 'edu', eduRule],
        ]) {
          if (mutated === null) continue;
          const dates = { [field]: mutated };
          if (field === 'cert' && mutated === career.cert.dates) continue;
          if (field === 'edu' && mutated === career.edu.dates) continue;
          assert(rejects(() => validate(resumeOf(career, kit, dates), kit), rule), `${career.key}: ${label} ("${mutated}") must be refused: it is not what the cited evidence states`);
        }
        // The same restatement is admissible only against evidence that states it that way: flip the evidence, flip the verdict.
        const restated = { edu: career.shown.edu, cert: career.shown.cert };
        const changes = restated.edu !== career.edu.dates || restated.cert !== career.cert.dates;
        if (!changes) continue;
        assert(rejects(() => validate(resumeOf(career, kit, restated), kit), /must occur in its cited career-data evidence/u),
          `${career.key}: a display-form restatement is not what the original evidence states, so grounding does not accept it`);
        const flipped = kitOf(career, { edu: { dates: career.shown.edu }, cert: { dates: career.shown.cert } });
        const accepted = validate(resumeOf(career, flipped, restated), flipped);
        assert(accepted.education[0].dates === career.shown.edu && accepted.credentials[0].dates === career.shown.cert,
          `${career.key}: once the evidence itself states the printed form, the same dates are grounded`);
        assert(rejects(() => validate(resumeOf(career, flipped, { edu: career.edu.dates, cert: career.cert.dates }), flipped), /must occur in its cited career-data evidence/u),
          `${career.key}: and the former spelling is no longer what the evidence states`);
      }
    },
  },
  {
    name: 'Host canonicalization writes the approved spelling over a date the writer restated as it prints, and never over a different date',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const approved = resumeOf(career, kit);
        const restated = resumeOf(career, kit, { role: career.alt.role, edu: career.alt.edu, cert: career.alt.cert });
        const frozen = JSON.parse(JSON.stringify(restated));
        const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
        const out = canonicalize(deepFreeze(restated), kit);
        assert(JSON.stringify(out.resume) === JSON.stringify(approved), `${career.key}: every restated date is written as approved`);
        assert(JSON.stringify(restated) === JSON.stringify(frozen), `${career.key}: the response the writer sent is not mutated`);
        const rewritten = [
          ['role', career.alt.role !== approvedRoleDates(career)], ['education', career.alt.edu !== career.edu.dates], ['credential', career.alt.cert !== career.cert.dates],
        ].filter(([, changed]) => changed).map(([unit]) => unit);
        assert(JSON.stringify(out.events.map(event => event.unit).sort()) === JSON.stringify(rewritten.sort()), `${career.key}: one typed event per rewritten date (got ${out.events.map(event => event.unit)})`);
        for (const event of out.events) {
          assert(event.type === HOST_FIELD_CANONICALIZED_EVENT && event.field === 'dates' && /^[0-9a-f]{64}$/u.test(event.fromSha256) && /^[0-9a-f]{64}$/u.test(event.toSha256),
            `${career.key}: the ${event.unit} event is typed and carries hashes`);
        }
        const logged = JSON.stringify(out.events);
        for (const text of [career.role.start, career.edu.dates, career.cert.dates, career.shown.role, career.shown.edu, career.shown.cert]) {
          assert(!logged.includes(text), `${career.key}: the event record never contains the date text "${text}"`);
        }
        const again = canonicalize(out.resume, kit);
        assert(again.resume === out.resume && again.events.length === 0, `${career.key}: canonicalizing the result again changes nothing`);
        const untouched = canonicalize(approved, kit);
        assert(untouched.resume === approved && untouched.events.length === 0, `${career.key}: a response that already copied the approved dates comes back as the very same object`);
        // The real authority gate refuses the restated response and accepts the canonicalized one.
        if (rewritten.length) {
          assert(authorityErrors(restated, kit).length > 0, `${career.key}: fixture: the authority gate refuses a restated date before the host writes the approved one`);
        }
        assert(authorityErrors(out.resume, kit).length === 0, `${career.key}: the authority gate accepts the canonicalized response (${authorityErrors(out.resume, kit).join(' | ')})`);
        assert(validate(out.resume, kit).roles[0].dates === kit.sourceRoles[0].dates, `${career.key}: the structured validator accepts it and carries the approved role date`);
        // Mutations: a different date is left for the validators, whatever punctuation it wears.
        const mutants = [
          ['role', 'role', shiftLastYear(career.shown.role)], ['role', 'role', shiftFirstMonth(career.shown.role)], ['role', 'role', dropEnd(career.shown.role)], ['role', 'role', joinWithWord(career.shown.role)],
          ['education', 'edu', shiftFirstYear(career.shown.edu)], ['education', 'edu', joinWithWord(career.shown.edu)],
          ['credential', 'cert', shiftLastYear(career.shown.cert)], ['credential', 'cert', shiftFirstMonth(career.shown.cert)],
        ];
        for (const [unit, field, mutated] of mutants) {
          if (mutated === null) continue;
          const written = resumeOf(career, kit, { [field]: mutated });
          const result = canonicalize(written, kit);
          assert(result.events.length === 0 && result.resume === written, `${career.key}: the different ${unit} date "${mutated}" is never written over`);
          assert(authorityErrors(written, kit).length > 0, `${career.key}: and the authority gate still refuses "${mutated}"`);
        }
      }
    },
  },
  {
    name: 'Host canonicalization compares dates in the one direction that cannot merge two dates: the stray comma and the hyphen glyph, and nothing else',
    run() {
      for (const career of CAREERS) {
        const kit = kitOf(career);
        // The entity is never chosen by the surface form: with no authority, an education/certification date is left alone,
        // while a role date is still the one its id names.
        const restated = resumeOf(career, kit, { role: career.alt.role, edu: career.alt.edu, cert: career.alt.cert });
        const noAuthority = canonicalizeHostOwnedResumeFields(restated, { authority: null, acceptedEvidence: kit.acceptedEvidence, sourceRoles: kit.sourceRoles });
        assert(noAuthority.resume.education[0].dates === career.alt.edu && noAuthority.resume.credentials[0].dates === career.alt.cert,
          `${career.key}: without a resolvable approved record the education and certification dates are not rewritten`);
        assert(noAuthority.resume.roles[0].dates === kit.sourceRoles[0].dates, `${career.key}: a role date is the one its id names, so it is written as approved`);
        // Reverse direction: the source states a date without the tidy and the writer adds the stray comma.
        const plain = kitOf(career, { edu: { dates: career.shown.edu } });
        const withComma = resumeOf(career, plain, { edu: career.edu.dates });
        const snapped = canonicalize(withComma, plain);
        if (career.edu.dates !== career.shown.edu) {
          assert(snapped.resume.education[0].dates === career.shown.edu && snapped.events.length === 1,
            `${career.key}: a writer that adds the source's stray comma is written as the approved, comma-free date`);
        } else {
          assert(snapped.events.length === 0, `${career.key}: an education date with nothing to tidy needs no rewrite`);
        }
      }
    },
  },
  {
    name: 'Résumé date display: dates that print alike parse alike for every downstream reader, in all five careers',
    run() {
      const asOf = new Date(Date.UTC(2026, 5, 15));
      const referenceMonth = '2026-06-15T00:00:00.000Z';
      for (const career of CAREERS) {
        const raw = approvedRoleDates(career);
        const shown = formatRoleDateForPresentation(raw);
        const tenure = dates => JSON.stringify(calculateDatedTenure([{ id: career.role.id, dates }], { asOf }));
        assert(tenure(raw) === tenure(shown), `${career.key}: the tenure engine reads "${raw}" and "${shown}" identically`);
        const ended = dates => {
          const result = checkEndedRoleCurrentEmployment(
            [`As a ${career.role.title} at ${career.role.employer}, I manage the morning work.`],
            { roles: [{ title: career.role.title, company: career.role.employer, dates }] }, referenceMonth);
          return `${result.endedRoleCount}/${result.failureCount}`;
        };
        assert(ended(raw) === ended(shown) && ended(shown) === '1/1', `${career.key}: the ended-role gate reads both spellings alike (raw ${ended(raw)}, printed ${ended(shown)})`);
        const order = dates => __selectedSourceRolesForTests({ selectedRoleIds: ['a', 'b'] }, { sourceRoles: [
          { id: 'a', title: 'A', company: 'A', dates: `2001 ${EN} 2002` }, { id: 'b', title: 'B', company: 'B', dates }] }).map(role => role.id).join('');
        assert(order(raw) === order(shown), `${career.key}: résumé role order is the same for "${raw}" and "${shown}"`);
      }
    },
  },
  {
    name: 'Host canonicalization writes a skill item as the approved inventory spells it, only when the whole group is one the authority accepts',
    run() {
      const skillEvidence = skill => `host.career.skill.${skill.id}.1`;
      for (const career of CAREERS) {
        const kit = kitOf(career);
        const resolvable = career.skills.filter(skill => [...skill.name].length > 2);
        const short = career.skills.filter(skill => [...skill.name].length <= 2);
        assert(resolvable.length === 2 && short.length === 1, `${career.key}: fixture: two long skill names and one short one`);
        const group = (items, evidenceIds, id = 'skills-main') => ({ id, group: 'tools', items, evidenceIds });
        const withSkills = skills => ({ ...resumeOf(career, kit), skills });
        // Long names resolve whatever their case or spacing.
        const written = withSkills([group(resolvable.map(skill => skill.written), resolvable.map(skillEvidence))]);
        const out = canonicalize(written, kit);
        assert(JSON.stringify(out.resume.skills[0].items) === JSON.stringify(resolvable.map(skill => skill.name)),
          `${career.key}: the items are written as the inventory spells them (got ${JSON.stringify(out.resume.skills[0].items)})`);
        assert(out.resume.skills[0].id === 'skills-main' && out.resume.skills[0].group === 'tools' && JSON.stringify(out.resume.skills[0].evidenceIds) === JSON.stringify(resolvable.map(skillEvidence)),
          `${career.key}: only the items move`);
        assert(out.events.length === resolvable.length && out.events.every(event => event.type === HOST_FIELD_CANONICALIZED_EVENT && event.unit === 'skill' && event.unitId === 'skills-main' && event.field === 'items'
          && /^[0-9a-f]{64}$/u.test(event.fromSha256) && /^[0-9a-f]{64}$/u.test(event.toSha256)), `${career.key}: one typed event per respelled item`);
        const logged = JSON.stringify(out.events);
        for (const skill of resolvable) assert(!logged.includes(skill.name) && !logged.includes(skill.written), `${career.key}: the event record never contains the skill text`);
        const again = canonicalize(out.resume, kit);
        assert(again.resume === out.resume && again.events.length === 0, `${career.key}: canonicalizing the result again changes nothing`);
        assert(authorityErrors(out.resume, kit).length === 0, `${career.key}: the authority gate accepts the respelled response (${authorityErrors(out.resume, kit).join(' | ')})`);
        const exact = withSkills([group(resolvable.map(skill => skill.name), resolvable.map(skillEvidence))]);
        assert(canonicalize(exact, kit).resume === exact, `${career.key}: items already spelled as approved come back as the very same object`);
        // A name of at most two characters is case-sensitive: its lower-case form is no approved skill, so nothing is rewritten.
        const shortWritten = withSkills([group(short.map(skill => skill.written), short.map(skillEvidence))]);
        assert(short[0].written !== short[0].name && canonicalize(shortWritten, kit).resume === shortWritten, `${career.key}: a short name written in another case is left for the validators`);
        assert(authorityErrors(shortWritten, kit).length > 0, `${career.key}: and the authority gate refuses it`);
        // Mutations: each flips the group from respelled to untouched, so no partial or guessed rewrite is ever made.
        const [first, second] = resolvable;
        const untouched = [
          ['an item that is no approved skill', withSkills([group([first.written, `${second.name}x`], resolvable.map(skillEvidence))])],
          ['an alias of an approved skill', withSkills([group([first.written, `${second.name} Pro`], resolvable.map(skillEvidence))])],
          ['an approved skill the group cites no evidence for', withSkills([group([first.written, second.written], [skillEvidence(first)])])],
          ['evidence belonging to another skill', withSkills([group([first.written], [skillEvidence(second)])])],
          ['no career evidence', withSkills([group([first.written], [])])],
          ['the same skill twice', withSkills([group([first.written, first.name], [skillEvidence(first)])])],
          ['an empty group', withSkills([group([], [skillEvidence(first)])])],
          ['listing-only evidence', withSkills([group([first.written], ['p1-listing'])])],
        ];
        for (const [label, response] of untouched) {
          const result = canonicalize(response, kit);
          assert(result.resume === response && result.events.length === 0, `${career.key}: ${label} leaves the group exactly as written`);
        }
        // Without an authority there is no inventory to respell against.
        const noAuthority = canonicalizeHostOwnedResumeFields(written, { authority: null, acceptedEvidence: kit.acceptedEvidence, sourceRoles: kit.sourceRoles });
        assert(noAuthority.resume.skills === written.skills && noAuthority.events.length === 0, `${career.key}: with no authority the skills are not touched`);
        // Flip the evidence: the same written items are respelled against one inventory and not the other.
        const other = kitOf({ ...career, skills: career.skills.map((skill, index) => (index === 0 ? { ...skill, id: `${skill.id}-v2`, name: `${skill.name} Suite`, written: skill.written } : skill)) });
        const against = canonicalize(withSkills([group(resolvable.map(skill => skill.written), resolvable.map(skillEvidence))]), other);
        assert(against.resume.skills[0].items.join('|') === resolvable.map(skill => skill.written).join('|') && against.events.length === 0,
          `${career.key}: once the inventory no longer holds the skill, the same response is left alone`);
      }
    },
  },
];
