// Claim-versus-evidence grounding of generated application prose.
//
// Every case here is SYNTHETIC: five unrelated invented careers (ward nursing,
// pastry kitchen, structural design, warehouse operations, data analytics).
// Nothing in production names any of them. Each rejection is proven with the
// mutation pattern the family uses:
//
//   A  the cited quotes do not state the claim            -> rejected, for its reason
//   B  A + one quote that states it (the source changed)  -> the SAME text accepted
//   C  B with that quote removed                          -> rejected again
//
// and each is paired with the faithful version of the same claim, which must
// stay accepted, so a rule cannot pass by rejecting everything.
import { assert } from './testHelpers.js';
import {
  __selectedSourceRolesForTests,
  assertSourceQuoteLinksFinalText,
  pasteAttributionScopeErrors,
} from '../../electron/ipc/localAiApplication.js';

const DOMAINS = Object.freeze([
  {
    key: 'ward nursing', work: "the unit's bedside shift-handoff huddles", otherWork: 'the quarterly supply-closet audit', extra: 'the night shift',
    team: 'nurses', crowd: 'patients', tool: 'ChartForge', altTool: 'LedgerLeaf', vendor: 'Marlowe Pharmacy Cooperative',
    title: 'Charge Nurse', employer: 'Quillfeather Memorial Hospital', foreignEmployer: 'Northgate Medical Group',
    inflatedTitle: 'Director of Nursing', priorTitle: 'Staff Nurse', priorEmployer: 'Thistledown Community Clinic', interval: 'shift',
  },
  {
    key: 'pastry kitchen', work: 'the weekend viennoiserie production schedule', otherWork: 'the walk-in freezer inventory', extra: 'the holiday rush',
    team: 'bakers', crowd: 'customers', tool: 'DoughSync', altTool: 'CrumbLedger', vendor: 'Fennimore Dairy Supply',
    title: 'Pastry Chef', employer: 'Maison Orrery Patisserie', foreignEmployer: 'Harrowgate Resort Kitchens',
    inflatedTitle: 'Executive Pastry Chef', priorTitle: 'Commis Pastry Cook', priorEmployer: 'Birchwater Grand Hotel', interval: 'service',
  },
  {
    key: 'structural design', work: 'the connection-detail peer review sessions', otherWork: 'the annual calculation archive cleanup', extra: 'the tower design team',
    team: 'designers', crowd: 'clients', tool: 'LatticePro', altTool: 'GirderMesh', vendor: 'Brightmoor Dairy Cooperative',
    title: 'Structural Engineer', employer: 'Halvorsen Tarn Structural Group', foreignEmployer: 'Ironbridge Consulting Engineers',
    inflatedTitle: 'Principal Structural Engineer', priorTitle: 'Junior Structural Designer', priorEmployer: 'Kestrel Civil Partners', interval: 'project',
  },
  {
    key: 'warehouse operations', work: 'the dock-door scheduling meetings', otherWork: 'the quarterly damaged-goods audit', extra: 'the peak season',
    team: 'pickers', crowd: 'employees', tool: 'SlotTrack', altTool: 'PalletPilot', vendor: 'Voltaic Forklift Rentals',
    title: 'Shift Supervisor', employer: 'Pelham Crossdock Logistics', foreignEmployer: 'Stonebridge Distribution Partners',
    inflatedTitle: 'Operations Director', priorTitle: 'Forklift Operator', priorEmployer: 'Ardent Cold Storage', interval: 'shift',
  },
  {
    key: 'data analytics', work: 'the weekly forecast refresh jobs', otherWork: 'the vendor invoice reconciliation', extra: 'the finance close',
    team: 'analysts', crowd: 'users', tool: 'QuillSheet', altTool: 'BrightGrid', vendor: 'Routecast Data Services',
    title: 'Data Analyst', employer: 'Northfield Analytics Cooperative', foreignEmployer: 'Cobblestone Mutual Insurance',
    inflatedTitle: 'Head of Analytics', priorTitle: 'Reporting Analyst', priorEmployer: 'Larkspur Retail Group', interval: 'quarter',
  },
]);

const catalogQuote = (text, id = 'ach-0001') => `- Achievement [${id}]: ${text}`;

/** The production verdict: '' when accepted, else the rejection message. */
function judge(text, quotes, { label = 'resumeBullets', identityTokens = [], ...options } = {}) {
  try {
    assertSourceQuoteLinksFinalText(text, quotes.map((quote, index) => catalogQuote(quote, `ach-${index + 1}`)), label, 0, { identityTokens, ...options });
    return '';
  } catch (error) { return String(error?.message || error); }
}
const accepted = (...args) => judge(...args) === '';

/** A rejects (naming `rule`), B = A + `support` accepts the identical text, C = B minus `support` rejects again. */
function lifecycle(where, { text, base, support, rule, label, ...options }) {
  const a = judge(text, base, { label, ...options });
  assert(a && rule.test(a), `${where}: A must reject ${JSON.stringify(text)} for ${rule} (got ${a || 'acceptance'})`);
  const b = judge(text, [...base, support], { label, ...options });
  assert(b === '', `${where}: B (the source now states it) must accept ${JSON.stringify(text)} (got ${b})`);
  const c = judge(text, base, { label, ...options });
  assert(c && rule.test(c), `${where}: C (the line removed again) must reject ${JSON.stringify(text)} (got ${c || 'acceptance'})`);
}

function attribution({ text, quotes, roles, careerData = '', targetCompany = '', projects = [] }) {
  return pasteAttributionScopeErrors({
    unitLabel: 'Bullet', unitId: 'b1', finalText: text,
    evidenceIds: quotes.map((_, index) => `e${index}`),
    // A legacy corpus scopes a quote by finding it verbatim inside an employer's section, so those quotes are cited as written.
    acceptedEvidence: quotes.map((quote, index) => ({ id: `e${index}`, sourceId: 'career-data', quote: careerData ? quote : catalogQuote(quote, `ach-${index + 1}`) })),
    sourceRoles: roles, careerData, authority: null, targetCompany, projects,
  });
}
const rolesOf = d => [
  { id: 'role-a', title: d.title, company: d.employer, dates: 'March 2019 – Present', location: '' },
  { id: 'role-b', title: d.priorTitle, company: d.priorEmployer, dates: 'June 2014 – February 2019', location: '' },
];
const careerDataOf = (d, lineA = 'Ran the daily work on the unit.', lineB = 'Kept a running log of supply requests.') => [
  'Alex Example', 'alex@example.test', '',
  `## ${d.employer}`, d.title, 'March 2019 – Present', `- ${lineA}`, '',
  `## ${d.priorEmployer}`, d.priorTitle, 'June 2014 – February 2019', `- ${lineB}`, '',
].join('\n');

// ---------------------------------------------------------------------------

const STRENGTH_CLASSES = Object.freeze([
  { name: 'leadership', rule: /unsupported leadership ownership/u, claims: ['Led', 'Spearheaded', 'Headed', 'Directed', 'Orchestrated'], support: 'Led', team: 'Assisted with' },
  { name: 'oversight', rule: /unsupported management ownership/u, claims: ['Managed', 'Supervised', 'Oversaw'], support: 'Managed', team: 'Supported colleagues on' },
  { name: 'ownership', rule: /unsupported direct ownership/u, claims: ['Owned'], support: 'Owned', team: 'Contributed to' },
  { name: 'authorship', rule: /unsupported implementation authorship/u, claims: ['Built', 'Created', 'Developed', 'Designed', 'Implemented', 'Established', 'Launched', 'Introduced', 'Initiated', 'Engineered', 'Architected'], support: 'Created', team: 'Contributed to' },
  { name: 'origination', rule: /unsupported implementation authorship/u, claims: ['Founded', 'Pioneered'], support: 'Pioneered', team: 'Created' },
]);

export default [
  {
    name: 'Strength classes: team language never carries an ownership, oversight, authorship or origination claim, and the same text is admitted once a quote states it (A/B/C, five domains)',
    run() {
      let verdicts = 0;
      for (const d of DOMAINS) {
        for (const klass of STRENGTH_CLASSES) {
          const base = [`${klass.team} ${d.work}.`];
          const support = `${klass.support} ${d.work} for ${d.extra}.`;
          for (const claim of klass.claims) {
            lifecycle(`${d.key}/${claim}`, { text: `${claim} ${d.work}.`, base, support, rule: klass.rule });
            verdicts += 3;
          }
          // Faithful: the team-language claim itself stays admissible from its own quote.
          assert(accepted(`${klass.team} ${d.work}.`, base), `${d.key}/${klass.name}: the faithful team-language sentence is accepted`);
        }
      }
      return { verdicts };
    },
  },
  {
    name: 'Strength classes: sole ownership, ownership nouns and sole-responsibility phrases need a quote that states them about the same work',
    run() {
      for (const d of DOMAINS) {
        const base = [`Assisted with ${d.work}.`];
        const cases = [
          [`Single-handedly handled ${d.work}.`, `Single-handedly handled ${d.work} for ${d.extra}.`, /unsupported sole ownership/u],
          [`Was the sole person handling ${d.work}.`, `Solely handled ${d.work} for ${d.extra}.`, /unsupported sole ownership/u],
          [`Independently handled ${d.work}.`, `Handled ${d.work} independently for ${d.extra}.`, /unsupported sole ownership/u],
          [`Solely responsible for ${d.work}.`, `Solely responsible for ${d.work} for ${d.extra}.`, /unsupported sole ownership/u],
          [`Served as the lead for ${d.work}.`, `Led ${d.work} for ${d.extra}.`, /unsupported leadership ownership/u],
          [`Team lead for ${d.work}.`, `Team lead for ${d.work} on ${d.extra}.`, /unsupported leadership ownership/u],
          [`Head of ${d.work}.`, `Directed ${d.work} for ${d.extra}.`, /unsupported leadership ownership/u],
          [`Acted as the owner of ${d.work}.`, `Owned ${d.work} for ${d.extra}.`, /unsupported direct ownership/u],
        ];
        for (const [text, support, rule] of cases) lifecycle(`${d.key}/${text}`, { text, base, support, rule });
      }
    },
  },
  {
    name: 'Strength classes: a shared or subordinate quote, another person\'s leadership, an unrelated quote, or an identifier cannot carry the unqualified claim; the lower claim stays admissible',
    run() {
      for (const d of DOMAINS) {
        const sharedSources = [
          [`Led ${d.work}.`, [`Co-led ${d.work} with the department head.`, `Helped lead ${d.work}.`, `Assisted in leading ${d.work}.`]],
          [`Managed ${d.work}.`, [`Co-managed ${d.work} with a supervisor.`, `Helped manage ${d.work}.`]],
          [`Owned ${d.work}.`, [`Shared ownership of ${d.work} with two colleagues.`, `Co-owned ${d.work} with a peer.`]],
          [`Built ${d.work}.`, [`Helped build ${d.work}.`, `Part of the team that built ${d.work}.`]],
        ];
        for (const [text, sources] of sharedSources) {
          for (const source of sources) assert(judge(text, [source]) !== '', `${d.key}: ${JSON.stringify(text)} must not ride on the shared level ${JSON.stringify(source)}`);
        }
        // Someone else's leadership in the quote is not the candidate's.
        for (const source of [`Supported the department head, who led ${d.work}.`, `Reported to the lead of ${d.work}.`, `${d.work.charAt(0).toUpperCase()}${d.work.slice(1)} were built by the infrastructure team.`]) {
          assert(judge(`Led ${d.work}.`, [source]) !== '' || /built by/u.test(source), `${d.key}: another person's leadership ${JSON.stringify(source)} supports no leadership claim`);
        }
        assert(judge(`Built ${d.work}.`, [`${d.work.charAt(0).toUpperCase()}${d.work.slice(1)} were built by the infrastructure team.`]) !== '', `${d.key}: work built by another team supports no authorship claim`);
        // A leadership word in a quote about OTHER work does not support leading THIS work.
        assert(judge(`Led ${d.work}.`, [`Assisted with ${d.work}.`, `Led ${d.otherWork}.`]) !== '', `${d.key}: a leadership word in another cited achievement does not carry the claim`);
        assert(accepted(`Led ${d.otherWork}.`, [`Assisted with ${d.work}.`, `Led ${d.otherWork}.`]), `${d.key}: the same quote carries the claim about its own work`);
        // An entity identifier is the host's, never evidence.
        const leaky = catalogQuote(`Assisted with ${d.work}.`, 'ach-led-owned-founded-0001');
        let leak = '';
        try { assertSourceQuoteLinksFinalText(`Led ${d.work}.`, [leaky], 'resumeBullets', 0, { identityTokens: [] }); } catch (error) { leak = String(error.message); }
        assert(/unsupported leadership ownership/u.test(leak), `${d.key}: an ownership word inside an entity id is not leadership evidence (got ${leak || 'acceptance'})`);
        // The lower claim and the stronger quote: admissible.
        assert(accepted(`Co-led ${d.work}.`, [`Led ${d.work}.`]), `${d.key}: a shared claim is admissible from a full statement`);
        assert(accepted(`Helped lead ${d.work}.`, [`Led ${d.work}.`]), `${d.key}: "helped lead" is admissible from "led"`);
        assert(accepted(`Built ${d.work}.`, [`Pioneered ${d.work}.`]), `${d.key}: a built claim is admissible from a founding statement`);
        assert(judge(`Founded ${d.work}.`, [`Created ${d.work}.`]) !== '', `${d.key}: a founding claim is not admissible from "created"`);
      }
    },
  },
  {
    name: 'Strength classes: an implicit-subject letter sentence meets the same gate as the first-person one, and a trusted role title is not a claim',
    run() {
      for (const d of DOMAINS) {
        const letter = { label: 'coverLetterParagraphs', identityTokens: [] };
        assert(judge(`Led ${d.work}.`, [`Assisted with ${d.work}.`], letter) !== '', `${d.key}: the implicit-subject sentence is judged`);
        assert(judge(`I led ${d.work}.`, [`Assisted with ${d.work}.`], letter) !== '', `${d.key}: the first-person sentence is judged`);
        assert(accepted(`Led ${d.work}.`, [`Led ${d.work} for ${d.extra}.`], letter), `${d.key}: the implicit-subject sentence is admitted from its quote`);
        // A role title the host already trusts ("Head of ...", "Team Lead") is metadata, not a leadership claim of its own.
        assert(accepted(`As ${d.title}, I assisted with ${d.work}.`, [`Assisted with ${d.work}.`], { ...letter, trustedNames: [d.title, d.employer] }), `${d.key}: the trusted title is accepted`);
      }
    },
  },
  {
    name: 'Counts: a changed team size, an inflated bare count and an open population noun are rejected in digits and in words; the stated count and its restatement stay admissible (A/B/C)',
    run() {
      for (const d of DOMAINS) {
        const base = [`Worked with a team of six ${d.team} on ${d.work}.`];
        lifecycle(`${d.key}/team words`, { text: `Worked with a team of twelve ${d.team} on ${d.work}.`, base, support: `Worked with a team of twelve ${d.team} on ${d.extra}.`, rule: /states the count/u });
        lifecycle(`${d.key}/team digits`, { text: `Managed 60 ${d.team} on ${d.work}.`, base: [`Managed 6 ${d.team} on ${d.work}.`], support: `Managed 60 ${d.team} on ${d.extra}.`, rule: /states the count/u });
        lifecycle(`${d.key}/bare count`, { text: `Closed 400 reviews per ${d.interval}.`, base: [`Closed 40 reviews per ${d.interval}.`], support: `Closed 400 reviews per ${d.interval} last year.`, rule: /states the count/u });
        lifecycle(`${d.key}/open noun`, { text: `Served 5,000 guests at ${d.extra}.`, base: [`Served 50 guests at ${d.extra}.`], support: `Served 5,000 guests at ${d.extra} each year.`, rule: /states the count/u });
        assert(accepted(`Worked with a team of 6 ${d.team} on ${d.work}.`, base), `${d.key}: digits restate the spelled count`);
        assert(accepted(`Managed six ${d.team} on ${d.work}.`, [`Managed 6 ${d.team} on ${d.work}.`]), `${d.key}: words restate the digit count`);
        assert(accepted(`Served 5,000 guests at ${d.extra}.`, [`Served 5000 guests at ${d.extra}.`]), `${d.key}: thousands separators are typographic`);
        // A lower bound needs a lower bound at least that large.
        assert(judge(`Served over 50 guests at ${d.extra}.`, [`Served 50 guests at ${d.extra}.`]) !== '', `${d.key}: "over 50" does not ride on an exact 50`);
        assert(accepted(`Served over 50 guests at ${d.extra}.`, [`Served 50+ guests at ${d.extra}.`]), `${d.key}: "over 50" is admissible from "50+"`);
        assert(accepted(`Served over 50 guests at ${d.extra}.`, [`Served 60 guests at ${d.extra}.`]), `${d.key}: "over 50" is true of a stated 60`);
        // An unmarked duration or a start year the quotes never state.
        assert(judge(`Worked on ${d.work} for 6 years.`, [`Worked on ${d.work}.`]) !== '', `${d.key}: "for 6 years" is a count`);
        assert(judge(`Worked on ${d.work} for over a decade.`, [`Worked on ${d.work}.`]) !== '', `${d.key}: "over a decade" is a count of years`);
        assert(accepted(`Worked on ${d.work} for 6 years.`, [`Spent 6 years working on ${d.work}.`]), `${d.key}: the stated duration is admissible`);
        // Dimensions, ordinals, labels and figures with their own gate are not counts.
        assert(accepted(`Built a 3 x 3 reporting matrix for ${d.work}.`, [`Built a reporting matrix for ${d.work}.`]), `${d.key}: a spaced dimension is not a count`);
      }
    },
  },
  {
    name: 'Rate intervals, scale words and comparative magnitudes are claims the quotes must state in their own terms (A/B/C)',
    run() {
      for (const d of DOMAINS) {
        const base = [`Ran ${d.work}.`];
        const cases = [
          [`Ran ${d.work} for millions of ${d.crowd}.`, `Ran ${d.work} for 2 million ${d.crowd}.`, /bulk-quantity scale/u],
          [`Ran ${d.work} for thousands of ${d.crowd}.`, `Ran ${d.work} for 4,000 ${d.crowd}.`, /bulk-quantity scale/u],
          [`Ran the enterprise-scale ${d.work}.`, `Ran ${d.work} at enterprise scale.`, /large-scale status/u],
          [`Ran the high-volume ${d.work}.`, `Ran ${d.work} as a high-volume process.`, /high-volume status/u],
          [`Rolled out ${d.work} nationwide.`, `Rolled out ${d.work} across the country.`, /geographic scope/u],
          [`Rolled out ${d.work} worldwide.`, `Rolled out ${d.work} globally.`, /geographic scope/u],
          [`Rolled out ${d.work} department-wide.`, `Rolled out ${d.work} across the entire department.`, /geographic scope/u],
          [`Ran ${d.work}, doubling the rate.`, `Ran ${d.work} at 2x the previous rate.`, /comparative magnitude/u],
          [`Ran ${d.work} twice as fast as before.`, `Ran ${d.work}; the rate doubled.`, /comparative magnitude/u],
          [`Ran ${d.work}, cutting effort by half.`, `Ran ${d.work}, cutting effort by 50%.`, /comparative magnitude/u],
        ];
        for (const [text, support, rule] of cases) lifecycle(`${d.key}/${text}`, { text, base, support, rule });
        // The rate keeps the interval the quote states it per.
        lifecycle(`${d.key}/interval`, { text: `Reviewed 20 cases per hour.`, base: [`Reviewed 20 cases per ${d.interval}.`], support: 'Reviewed 20 cases per hour in the pilot.', rule: /rate interval/u });
        assert(accepted(`Reviewed 20 cases each ${d.interval}.`, [`Reviewed 20 cases per ${d.interval}.`]), `${d.key}: "each" restates "per"`);
        assert(accepted(`Reviewed 20 cases per hour.`, [`Reviewed 20 cases hourly.`]), `${d.key}: "hourly" supports "per hour"`);
      }
    },
  },
  {
    name: 'Named terms: a tool, product, organization or title the quotes never state is rejected; evaluated-only and either-or tools cannot be claimed as used (A/B/C, five domains)',
    run() {
      for (const d of DOMAINS) {
        const base = [`Coordinated ${d.work}.`];
        // Absent from the quotes entirely.
        lifecycle(`${d.key}/tool`, { text: `Coordinated ${d.work} using ${d.tool}.`, base, support: `Used ${d.tool} to coordinate ${d.work}.`, rule: /names/u });
        lifecycle(`${d.key}/proficiency`, { text: `Proficient in ${d.tool}; coordinated ${d.work}.`, base, support: `Worked in ${d.tool} daily.`, rule: /names/u });
        lifecycle(`${d.key}/letter`, { text: `I coordinated ${d.work}, and I have hands-on experience with ${d.tool}.`, base, support: `Used ${d.tool} to coordinate ${d.work}.`, rule: /names/u, label: 'coverLetterParagraphs' });
        // Named, but only evaluated, or only one of several alternatives.
        const use = `Coordinated ${d.work} using ${d.tool}.`;
        const evaluated = judge(use, [...base, `Evaluated ${d.tool} as a replacement for paper records.`]);
        assert(/claims hands-on use of/u.test(evaluated), `${d.key}: an evaluated-only tool is not claimed as used (got ${evaluated || 'acceptance'})`);
        const either = judge(use, [...base, `Used ${d.tool} or ${d.altTool} to record ${d.work}.`]);
        assert(/claims hands-on use of/u.test(either), `${d.key}: one of several alternatives is not claimed as the tool used (got ${either || 'acceptance'})`);
        const owned = judge(use, [...base, `${d.tool} was selected by the regional office before I joined.`]);
        assert(/claims hands-on use of/u.test(owned), `${d.key}: a system someone else chose is not claimed as used (got ${owned || 'acceptance'})`);
        assert(accepted(`Coordinated ${d.work} using ${d.tool} or ${d.altTool}.`, [...base, `Used ${d.tool} or ${d.altTool} to record ${d.work}.`]), `${d.key}: naming both alternatives is faithful to an either-or quote`);
        assert(accepted(use, [...base, `Used ${d.tool} to record ${d.work}.`]), `${d.key}: a used tool is claimed as used`);
        // An unstated title or employer.
        assert(judge(`As ${d.inflatedTitle}, I assisted with ${d.work}.`, [`Assisted with ${d.work}.`], { label: 'coverLetterParagraphs' }) !== '', `${d.key}: an inflated title is a name no quote states`);
        assert(accepted(`As ${d.title} at ${d.employer}, I assisted with ${d.work}.`, [`Assisted with ${d.work}.`], { label: 'coverLetterParagraphs', trustedNames: [d.title, d.employer] }), `${d.key}: the trusted title and employer are not claims`);
        // An acronym is grounded by its expansion.
        assert(accepted('Reduced KPI reporting time.', ['Reduced key performance indicator reporting time.']), `${d.key}: an initialism of words the quote states is grounded`);
        // A currency code beside a figure is the figure gate's marker, not a name.
        assert(accepted(`Held spend to INR 4,200 on ${d.work}.`, [`Held spend to INR 4,200 on ${d.work}.`]), `${d.key}: a currency code with its figure is accepted`);
      }
    },
  },
  {
    name: 'Credential words, calendar years and appended clauses are claims the quotes must state; the faithful version stays admissible (A/B/C)',
    run() {
      for (const d of DOMAINS) {
        const base = [`Coordinated ${d.work}.`];
        lifecycle(`${d.key}/credential`, { text: `Coordinated ${d.work} while holding an active ${d.title.toLowerCase()} license.`, base, support: `Active ${d.title.toLowerCase()} license, State Board, 2014.`, rule: /licence, certification, accreditation, or degree/u });
        lifecycle(`${d.key}/degree`, { text: `Coordinated ${d.work} with a bachelor's degree in ${d.team}.`, base, support: `Bachelor of Science in ${d.team}, State University.`, rule: /licence, certification, accreditation, or degree/u });
        lifecycle(`${d.key}/year`, { text: `In 2009, coordinated ${d.work}.`, base, support: `Began coordinating ${d.work} in 2009.`, rule: /dates its work/u });
        lifecycle(`${d.key}/range`, { text: `Coordinated ${d.work} from 2009 to 2011.`, base, support: `Coordinated ${d.work} from 2009 to 2011 as a trainee.`, rule: /dates its work/u });
        assert(accepted(`In 2019, coordinated ${d.work}.`, base, { trustedYears: [2019, 2014] }), `${d.key}: a year an approved role's own dates state is admissible`);
        assert(judge(`In 2020, coordinated ${d.work}.`, base, { trustedYears: [2019, 2014] }) !== '', `${d.key}: another year is not`);
        // An appended responsibility or result clause shares nothing with the cited work.
        lifecycle(`${d.key}/clause`, { text: `Coordinated ${d.work} and negotiated staffing agency contracts.`, base, support: 'Negotiated staffing agency contracts during the busiest season.', rule: /adds the clause/u });
        lifecycle(`${d.key}/result clause`, { text: `Coordinated ${d.work}, reducing patient falls.`, base, support: 'Reduced patient falls through the revised routine.', rule: /adds the clause/u });
        assert(accepted(`Coordinated ${d.work} and documented ${d.work}.`, base), `${d.key}: a coordinated clause about the cited work is accepted`);
      }
    },
  },
  {
    name: 'Attribution: an employer, school or title the approved career does not give the candidate is rejected; roles sharing an employer, months, and lower bounds are judged on the evidence',
    run() {
      for (const d of DOMAINS) {
        const roles = rolesOf(d);
        const quote = 'Ran the daily work on the unit.';
        const careerData = careerDataOf(d);
        const base = { quotes: [quote], roles, careerData };
        // A name absent from the approved career, a client the quote only mentions, and the posting's company.
        const foreign = attribution({ ...base, text: `At ${d.foreignEmployer}, ${quote}` });
        assert(foreign.some(message => message.includes(`"${d.foreignEmployer}"`) && /employer/u.test(message)), `${d.key}: an employer outside the approved career is named (got ${JSON.stringify(foreign)})`);
        const vendor = attribution({ ...base, quotes: [`Attended vendor demonstrations from ${d.vendor} on shared equipment.`], text: `As a ${d.title} at ${d.vendor}, I attended vendor demonstrations from ${d.vendor} on shared equipment.` });
        assert(vendor.some(message => message.includes(`"${d.vendor}"`)), `${d.key}: a vendor the quote only mentions is not an employer (got ${JSON.stringify(vendor)})`);
        assert(attribution({ ...base, text: `At ${d.employer}, ${quote}` }).length === 0, `${d.key}: the approved employer is accepted`);
        assert(attribution({ ...base, text: `At ${d.employer.split(' ').slice(0, 2).join(' ')}, ${quote}` }).length === 0, `${d.key}: the leading words of the approved employer name it`);
        assert(attribution({ ...base, text: `At ${d.foreignEmployer}, ${quote}`, targetCompany: d.foreignEmployer }).length === 0, `${d.key}: the posting's own company is not a claim about an employer here`);
        // The same claims flip with the APPROVED CAREER: B adds the role, C removes it again.
        const employerClaim = `At ${d.foreignEmployer}, ran the daily work on the unit.`;
        const employerQuote = [`Ran the daily work on the unit with reports from ${d.foreignEmployer}.`];
        const withForeignRole = [...roles, { id: 'role-c', title: d.priorTitle, company: d.foreignEmployer, dates: 'June 2010 – May 2014', location: '' }];
        assert(attribution({ quotes: employerQuote, roles, text: employerClaim }).some(message => message.includes(`"${d.foreignEmployer}"`)), `${d.key}: A rejects an employer the approved career lacks, even when a quote mentions it`);
        assert(attribution({ quotes: employerQuote, roles: withForeignRole, text: employerClaim }).length === 0, `${d.key}: B admits it once the approved career has the role`);
        assert(attribution({ quotes: employerQuote, roles, text: employerClaim }).length > 0, `${d.key}: C rejects it again once the role is gone`);
        const titleClaim = `I was promoted to ${d.inflatedTitle} and ran the daily work on the unit.`;
        const withTitle = [{ ...roles[0], title: d.inflatedTitle }, roles[1]];
        assert(attribution({ ...base, text: titleClaim }).length > 0, `${d.key}: A rejects an unstated title`);
        assert(attribution({ ...base, roles: withTitle, text: titleClaim }).length === 0, `${d.key}: B admits the title once an approved role states it`);
        assert(attribution({ ...base, text: titleClaim }).length > 0, `${d.key}: C rejects it again`);
        // A title no approved role states.
        assert(attribution({ ...base, text: `I was promoted to ${d.inflatedTitle} and ${quote.toLowerCase()}` }).some(message => message.includes(d.inflatedTitle)), `${d.key}: an unstated title is rejected`);
        assert(attribution({ ...base, text: `I was promoted to ${d.title} and ${quote.toLowerCase()}` }).length === 0, `${d.key}: an approved title is accepted`);
        // Two roles at one employer (a promotion): the cited evidence belongs to the second, and the statement is true of that employer.
        const promoted = [{ ...roles[0] }, { ...roles[1], company: d.employer }];
        const promotedData = [
          'Alex Example', 'alex@example.test', '',
          `## ${d.employer} [Role ID: role-a]`, d.title, 'March 2019 – Present', '- Ran the daily work on the unit.', '',
          `## ${d.employer} [Role ID: role-b]`, d.priorTitle, 'June 2014 – February 2019', '- Kept a running log of supply requests.', '',
        ].join('\n');
        const promotion = attribution({ quotes: ['Kept a running log of supply requests.'], roles: promoted, careerData: promotedData, text: `At ${d.employer}, I kept a running log of supply requests.` });
        assert(promotion.length === 0, `${d.key}: roles sharing an employer do not make a true attribution fail (got ${JSON.stringify(promotion)})`);
        const misattributed = attribution({ quotes: ['Kept a running log of supply requests.'], roles: promoted, careerData: promotedData, text: `At ${d.priorEmployer}, I kept a running log of supply requests.` });
        assert(misattributed.length === 0 || !misattributed.some(message => message.includes(`"${d.employer}"`)), `${d.key}: the shared employer is not blamed for a sentence that does not name it`);
        // The month of an employer-attributed date.
        assert(attribution({ ...base, text: `At ${d.employer} since March 2019 I ran the daily work on the unit.` }).length === 0, `${d.key}: the role's own start month is accepted`);
        assert(attribution({ ...base, text: `At ${d.employer} since April 2019 I ran the daily work on the unit.` }).some(message => /employment month/u.test(message)), `${d.key}: another month of the right year is rejected`);
        const aprilRoles = [{ ...roles[0], dates: 'April 2019 – Present' }, roles[1]];
        assert(attribution({ ...base, roles: aprilRoles, text: `At ${d.employer} since April 2019 I ran the daily work on the unit.` }).length === 0, `${d.key}: B (the approved role now starts in April) admits April`);
        assert(attribution({ ...base, text: `At ${d.employer} since April 2019 I ran the daily work on the unit.` }).length > 0, `${d.key}: C (the original dates) rejects April again`);
        assert(attribution({ quotes: ['Ran the daily work on the unit since April 2019.'], roles, careerData: careerDataOf(d, 'Ran the daily work on the unit since April 2019.'), text: `At ${d.employer} since April 2019 I ran the daily work on the unit.` }).length === 0, `${d.key}: a month the quote states is accepted`);
        // Lower bounds in populations, with every separator form.
        const pop = (text, quoteText) => attribution({ quotes: [quoteText], roles: [], text });
        assert(pop(`Triaged 50+ ${d.crowd} each week.`, `Triaged 50 ${d.crowd} each week.`).length === 1, `${d.key}: "50+" does not ride on an exact 50`);
        assert(pop(`Triaged 50+ ${d.crowd} each week.`, `Triaged 50+ ${d.crowd} each week.`).length === 0, `${d.key}: "50+" is admissible from "50+"`);
        assert(pop(`Triaged 12,000+ ${d.crowd} each week.`, `Triaged 12,000+ ${d.crowd} each week.`).length === 0, `${d.key}: a thousands separator with a plus is judged, not skipped`);
        assert(pop(`Triaged 12,000+ ${d.crowd} each week.`, `Triaged 12,000 ${d.crowd} each week.`).length === 1, `${d.key}: "12,000+" does not ride on an exact 12,000`);
        assert(pop(`Triaged over 50 ${d.crowd} each week.`, `Triaged 50 ${d.crowd} each week.`).length === 1, `${d.key}: "over 50" does not ride on an exact 50`);
        assert(pop(`Triaged more than 50 ${d.crowd} each week.`, `Triaged 60 ${d.crowd} each week.`).length === 0, `${d.key}: "more than 50" is true of 60`);
        assert(pop(`Triaged 50 ${d.crowd} each week.`, `Triaged 50 ${d.crowd} each week.`).length === 0, `${d.key}: the exact count is admissible`);
      }
    },
  },
  {
    name: 'Spelled-out figures are held to the evidence like digit figures, and their faithful restatements are admitted',
    run() {
      for (const d of DOMAINS) {
        const base = [`Held ${d.work} compliance at 97% across the unit.`];
        assert(judge(`Held ${d.work} compliance at ninety-five percent across the unit.`, base) !== '', `${d.key}: an invented spelled-out percentage is rejected`);
        assert(accepted(`Held ${d.work} compliance at ninety-seven percent across the unit.`, base), `${d.key}: a faithful spelled-out percentage is admitted`);
        assert(judge(`Cut spend on ${d.work} by nine million dollars.`, [`Cut spend on ${d.work} by $4,200.`]) !== '', `${d.key}: an invented spelled-out amount is rejected`);
        assert(judge(`Ran ${d.work} nine times faster.`, [`Ran ${d.work} 3x faster.`]) !== '', `${d.key}: an invented spelled-out multiplier is rejected`);
      }
    },
  },
  {
    name: 'Résumé role order reads ISO months 10 to 12 as those months, in every spelling',
    run() {
      const order = (...roles) => __selectedSourceRolesForTests({}, { sourceRoles: roles.map(([id, dates]) => ({ id, dates })) }).map(role => role.id).join('>');
      assert(order(['a', '2018-01 – 2020-03'], ['b', '2017-02 – 2020-11']) === 'b>a', 'November after March (YYYY-MM)');
      assert(order(['a', '2018-01 – 2020-10'], ['b', '2017-02 – 2020-12']) === 'b>a', 'December after October (YYYY-MM)');
      assert(order(['a', '2018/01 – 2020/03'], ['b', '2017/02 – 2020/11']) === 'b>a', 'November after March (YYYY/MM)');
      assert(order(['a', '01/2018 – 03/2020'], ['b', '02/2017 – 11/2020']) === 'b>a', 'November after March (MM/YYYY)');
      assert(order(['a', 'Jan. 2018 – Mar. 2020'], ['b', 'Feb. 2017 – Nov. 2020']) === 'b>a', 'abbreviations with a period');
      assert(order(['a', '2018-01 – 2020-03'], ['b', '2017-02 – 2020-01']) === 'a>b', 'a later end month is presented first');
      assert(order(['a', '2018-01 – 2019-12'], ['b', '2017-02 – Ongoing']) === 'b>a', 'an ongoing role is presented first');
    },
  },
];
