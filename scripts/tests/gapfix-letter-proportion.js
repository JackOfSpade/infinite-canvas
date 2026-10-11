// Cover-letter PROPORTION and impersonal-sentence grounding.
//
// The failure these tests pin: a letter of dozens of one-sentence paragraphs,
// each restating one detail of a project the resume already lists, used to pass
// every paragraph-level check. Nothing graded how the letter was CUT, and the
// per-sentence claim grounding only read sentences that name the candidate, so
// a modal, present or stative sentence about the cited work broadened it
// ("could load records daily", "is the sole destination") with no reading at all.
//
// Every case is SYNTHETIC: invented careers in unrelated fields (clinic data,
// logistics, school IT, cold-chain operations, nonprofit finance). Nothing in
// production names any of them, and no fixture carries a real candidate's
// employers, tools or dates. The pattern the family uses:
//
//   good letters   five hand-written letters that pass the WHOLE editorial
//                  battery and every paragraph's source grounding must keep
//                  passing, so a rule cannot pass by rejecting everything
//   variants       the same letters padded, interleaved, merged and exploded
//                  must fail with the check's own id, for the limits it names
//   isolation      one structural letter per limit, built to break that limit
//                  and only that one, with the boundary either side of it
//   mutation       the cited evidence (or a paragraph's citations) is flipped in
//                  a temporary fixture and admissibility flips with it, then
//                  flips back (A/B/C)
//
// A neutered gate fails the isolation and variant cases that name it.
import { assert } from './testHelpers.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  LETTER_PROPORTION_MIN_JUDGED_WORDS, LETTER_PROPORTION_RULE, MAX_LETTER_BODY_PARAGRAPHS, MAX_PARAGRAPH_SENTENCES,
  MAX_PARAGRAPHS_PER_CITED_QUOTE, MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE, MIN_FIRST_PERSON_SENTENCE_SHARE,
  MIN_MEAN_PARAGRAPH_WORDS, MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE, PROPORTION_ACTION_EXAMPLES, PROPORTION_ACTION_STATEMENT,
  PROPORTION_NON_ACTION_EXAMPLES, PROPORTION_NON_ACTION_WORDS, SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR, analyzeLetterProportion,
  checkCandidateAgency, checkEvidenceGrounding, checkLetterProportion, checkMappingNarrativeStructure, checkRoleThesis,
  evaluateCoverLetterChecks, letterFirstPersonActionParagraphFloor, letterSingleSentenceAllowance, paragraphStatesFirstPersonAction, sentences,
} from '../../electron/ipc/coverLetterChecks.js';
import {
  MIN_COVER_LETTER_UNDERFILL_WORDS, MIN_IMPERSONAL_RESTATEMENT_SHARED_TERMS, MIN_IMPERSONAL_RESTATEMENT_SOURCE_SHARE,
  PASTE_CHECK_PROSE_UNITS, __completedParagraphCitationsForTests, __localizedCoverLetterCorrectiveGuidanceForTests,
  __pasteCoverLetterUnderfillErrorsForTests, __pasteTwinParagraphCitationsForTests, assertSourceQuoteLinksFinalText, pasteReportableCheckIds, sentenceAddressesTarget,
} from '../../electron/ipc/localAiApplication.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_LETTERS = Object.freeze([
  {
    key: 'clinic data', company: 'Lumen Clinical Analytics',
    jobText: 'Data Platform Engineer, Clinical Analytics. You will build and run pipelines that load scheduling and billing data from clinic systems into a governed reporting warehouse. You will own data quality checks, access controls for protected health information, and the audit trail. Python, SQL, and orchestration experience required. Work with analysts and compliance staff to keep reports accurate and access appropriate.',
    roles: [
      { title: 'Data Engineer', company: 'Meridian Clinics', bullets: ['Merged appointment and billing records from three scheduling systems into a single reporting database with nightly Python and SQL pipelines.', 'Gave front-desk and finance staff separate views of the reporting database and logged each access request for audit.', 'Wrote validation checks that compared row counts and patient identifiers between the sources and the reporting database after each load.'] },
      { title: 'Reporting Analyst', company: 'Harbor Family Health', bullets: ['Automated the billing office weekly spreadsheet export as a scheduled SQL report.'] },
    ],
    quotes: {
      q1: 'Built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database, replacing manual spreadsheet exports.',
      q2: 'Added role-based access to the reporting database so front-desk staff saw schedules and finance staff saw billing, with each access request logged for audit.',
      q3: 'Wrote validation checks that compared row counts and patient identifiers between the source systems and the reporting database after each load and flagged mismatches to the on-call analyst.',
      q4: 'Replaced a weekly spreadsheet export with a scheduled SQL report for the billing office, which finance staff used for month-end close.',
    },
    paragraphs: [
      { id: 'opening', evidenceIds: ['q1'], text: 'Clinical reporting is only as trustworthy as the data pipeline behind it, and your warehouse depends on records arriving complete and on time. As a data engineer at Meridian Clinics, I built nightly Python and SQL pipelines that pulled appointment and billing records out of three scheduling systems and loaded them into one reporting database. I would apply that pipeline experience to the warehouse your analytics team relies on. Complete loads also leave analysts free to answer clinical questions instead of reconciling exports.' },
      { id: 'access', evidenceIds: ['q2'], text: 'Bringing those records together raised an access problem, because front-desk staff and finance staff should not see the same data. I added role-based access so each group saw its own view of the reporting database, and I logged every access request for audit. Sensitive patient records in your warehouse need this split of views, and an audit trail goes with it.' },
      { id: 'quality', evidenceIds: ['q3'], text: 'Access controls mean little if the numbers are wrong, so every load ended with a check. My validation code counted rows and compared patient identifiers between each source and the reporting database. Mismatches went to the on-call analyst before anyone built a report on them. That habit of checking each load is how I would keep your reports accurate for the analysts and compliance staff who depend on them.' },
      { id: 'close', evidenceIds: ['q4'], text: 'Earlier, as a reporting analyst at Harbor Family Health, I replaced a weekly spreadsheet export with a scheduled SQL report that finance staff used for month-end close. That work taught me what analysts need from a pipeline: a report they can trust and a schedule they can predict. My pipeline and access experience would support your clinical analytics team.' },
    ],
    // Impersonal detail sentences in this domain's vocabulary, for the variants.
    subjects: ['The nightly pipeline', 'The reporting database', 'The scheduling feed', 'The billing extract', 'The audit log', 'The validation step', 'The access view'],
    predicates: ['holds appointment records for each clinic', 'carries billing totals for each month', 'keeps one row per patient visit', 'stores the source system name for each load', 'records the time of each completed load', 'feeds the finance report for the billing office'],
    // Impersonal sentences that restate quote q1 and add one qualifier it does not state.
    impersonal: {
      quote: 'q1',
      restated: 'The nightly pipelines load appointment and billing records from three clinic scheduling systems into one reporting database.',
      broadened: {
        daily: 'The nightly pipelines could load appointment and billing records from three clinic scheduling systems into the reporting database daily.',
        'organization-wide': 'The pipelines load appointment and billing records from three clinic scheduling systems into one reporting database organization-wide.',
        always: 'Nightly Python and SQL pipelines always made appointment and billing records from clinic scheduling systems available in one reporting database.',
      },
      targetFacing: 'Your warehouse needs records that arrive complete every day, and a nightly load is how the reporting database stays current.',
    },
  },
  {
    key: 'logistics', company: 'Redline Distribution',
    jobText: 'Logistics Analyst, Regional Distribution. You will analyze carrier performance, dock scheduling and inbound freight delays across four distribution centers. You will build weekly reports for operations managers, recommend changes to carrier mix, and quantify the cost of detention and late deliveries. Strong spreadsheet and SQL skills required.',
    roles: [
      { title: 'Logistics Analyst', company: 'Northgate Freight', bullets: ['Ranked twelve carriers by on-time delivery over six months and recommended dropping the two slowest from the weekly rotation.', 'Created an Excel dock-appointment tracker for late inbound trucks, which the receiving supervisor used to reorder the unloading queue.', 'Audited carrier billing against shipping paperwork and recovered credits for repeated detention fees.'] },
    ],
    quotes: {
      q1: 'Compared on-time delivery rates for twelve carriers over six months and recommended dropping the two slowest carriers from the weekly rotation.',
      q2: 'Built a dock appointment tracker in Excel that listed inbound trucks waiting well past their appointment slot, which the receiving supervisor used to reorder the unloading queue.',
      q3: 'Reconciled carrier invoices against bills of lading and found duplicate detention charges that the carriers credited back.',
    },
    paragraphs: [
      { id: 'opening', evidenceIds: ['q1'], text: 'Carrier performance decides whether inbound freight arrives when the dock can handle it. As a logistics analyst at Northgate Freight, I compared the on-time delivery rates of twelve carriers across a half-year, and my recommendation was to drop the two slowest from the weekly rotation. That comparison is the kind of carrier analysis your four distribution centers need. It also gave operations managers a ranking they could take to a carrier review.' },
      { id: 'dock', evidenceIds: ['q2'], text: 'Delays also build at the dock itself, where one late truck blocks the next appointment. I built an Excel tracker that listed inbound trucks waiting well past their slot, and the receiving supervisor used it to reorder the unloading queue. I would use the same approach to surface waiting trucks across your sites, and to show operations managers where the dock schedule needs more room.' },
      { id: 'punch', evidenceIds: ['q3'], text: 'Detention charges are the third cost, and the least visible.' },
      { id: 'invoices', evidenceIds: ['q3'], text: 'I matched carrier invoices against bills of lading and found duplicate detention charges, which the carriers credited back. The same reconciliation would let your managers see what late deliveries cost each week, with the evidence to dispute a charge. Reports drawn from matched invoices give a recommendation on carrier mix a dollar figure that holds up in a meeting.' },
      // No cited quote states SQL (only the posting does), so the close names spreadsheet work alone: a first-person clause naming a tool is a claim.
      { id: 'close', evidenceIds: ['q1', 'q2', 'q3'], text: 'My carrier comparison and dock tracking experience would support your weekly operations reports. Spreadsheet work of this kind is where I do my best analysis.' },
    ],
    subjects: ['The carrier ranking', 'The dock tracker', 'The invoice match', 'The detention report', 'The weekly rotation', 'The unloading queue', 'The bill of lading file'],
    predicates: ['lists each carrier by delivery rate', 'shows every truck waiting past its slot', 'records one credit for each duplicate charge', 'covers six months of inbound freight', 'orders the dock appointments for the supervisor', 'ties each invoice line to its shipment'],
    impersonal: {
      quote: 'q1',
      restated: 'The on-time delivery rates for twelve carriers cover six months and feed the weekly rotation.',
      broadened: {
        daily: 'The comparison could rank on-time delivery rates for twelve carriers over six months daily.',
        'organization-wide': 'The on-time delivery rates for twelve carriers over six months guide the weekly rotation organization-wide.',
        always: 'The two slowest carriers always leave the weekly rotation after six months of on-time delivery rates.',
      },
      targetFacing: 'Your four distribution centers need a weekly view of carrier delivery rates, and a ranked list gives operations managers a place to start.',
    },
  },
  {
    key: 'school IT', company: 'Lakeside Charter Schools',
    jobText: 'IT Generalist, Lakeside Charter Schools. You will support students and staff across two buildings: laptops and tablets, the wireless network, accounts in the learning management system, and the help desk queue. You will document procedures and train teachers on new tools. Experience with Chromebooks and Google Workspace administration preferred.',
    roles: [
      { title: 'Technology Assistant', company: 'Cedar Valley School District', bullets: ['Ran the Chromebook and tablet fleet for two schools, from console enrollment and repairs to a student loaner program.', 'Authored guides covering password resets and projector setup that cut help desk calls from teachers.', 'Moved staff accounts to Google Workspace over one summer break and checked each mailbox afterward so that no mail was lost.'] },
    ],
    quotes: {
      q1: 'Managed a fleet of Chromebooks and tablets for two schools, including enrollment in the management console, repairs, and a loaner program for students.',
      q2: 'Wrote step-by-step guides for password resets and classroom projector setup that teachers followed without calling the help desk.',
      q3: 'Moved staff accounts to Google Workspace over one summer break and checked each mailbox afterward so that no mail was lost.',
    },
    paragraphs: [
      { id: 'opening', evidenceIds: ['q1', 'q3'], text: 'Schools need technology that works the moment students arrive, and that depends on steady device and account management. As a technology assistant at Cedar Valley School District, I looked after the Chromebooks and tablets at two schools, handling enrollment in the management console, repairs and a student loaner program. Over one summer break I also shifted every staff account to Google Workspace, and I opened each mailbox afterward to confirm that no mail was lost. Planning ahead of the calendar mattered in each case, because families and teachers notice a failure on the first morning. A device or account that works quietly is the goal of this kind of support.' },
      { id: 'documentation', evidenceIds: ['q2'], text: 'Teachers rarely have time to wait for a ticket, so I wrote step-by-step guides for password resets and classroom projector setup. Teachers followed them without calling the help desk. I would write the same kind of guide for the tools your staff use most, and test each one with a teacher before it goes out. A short guide also gives a new teacher a place to start in the first week.' },
      { id: 'close', evidenceIds: ['q1'], text: 'I gained my device and account experience over those years, and it carries directly to your two buildings, wireless network and help desk queue. My device management and documentation experience would support your students and teachers when the term begins. Teachers who know where the guide lives spend less time waiting and more time teaching.' },
    ],
    subjects: ['The device fleet', 'The management console', 'The loaner program', 'The repair queue', 'The password guide', 'The projector checklist', 'The account list'],
    predicates: ['covers each classroom in both schools', 'tracks every tablet handed to a student', 'keeps one entry for each enrolled device', 'lists the steps for a password reset', 'sits where a teacher can reach it quickly', 'records each mailbox checked after the move'],
    impersonal: {
      quote: 'q1',
      restated: 'The management console covers enrollment for the fleet of Chromebooks and tablets at two schools.',
      broadened: {
        daily: 'The management console could cover the fleet of Chromebooks and tablets for two schools daily.',
        'organization-wide': 'The management console covers the fleet of Chromebooks and tablets for two schools organization-wide.',
        always: 'Repairs and a loaner program for students always come with the fleet of Chromebooks and tablets for two schools.',
      },
      targetFacing: 'Your two buildings need devices that work on the first morning, and a wireless network that students and teachers can trust every day.',
    },
  },
  {
    key: 'cold-chain operations', company: 'Polar Route Software',
    jobText: 'Operations Engineer, Cold Chain Software. You will maintain the services that track temperature readings from refrigerated trucks and warehouses, respond to alerts, and improve deployment reliability. You will write scripts, review monitoring dashboards, and work with drivers and warehouse leads. Linux, Python, and monitoring experience preferred.',
    roles: [
      { title: 'Systems Administrator', company: 'Fieldstone Foods', bullets: ['Scripted a Python collector for freezer temperature logs from forty warehouse sensors, and a daily exception report for the shift lead.', 'Built the Linux servers behind warehouse scanning and wrote the restore runbook that the night shift used after a disk failure.'] },
      { title: 'Support Engineer', company: 'Brightwater Telematics', bullets: ['Diagnosed truck GPS unit failures from device logs and cut repeat service visits by documenting the most common causes for the field technicians.', 'Trained new support staff on the alerting dashboard.'] },
      { title: 'Help Desk Technician', company: 'Orchard Community College', bullets: ['Kept campus lab computers running and logged repeat faults for the department head monthly review.'] },
    ],
    quotes: {
      q1: 'Wrote Python scripts that collected freezer temperature logs from forty warehouse sensors and emailed a daily exception list to the shift lead.',
      q2: 'Set up Linux servers for the warehouse scanning system and documented the restore procedure that the night staff later used after a disk failure.',
      q3: 'Diagnosed truck GPS unit failures from device logs and cut repeat service visits by documenting the most common causes for the field technicians.',
      q4: 'Trained new support staff on the alerting dashboard during their first weeks on the team.',
      q5: 'Resolved lab computer outages and tracked recurring faults in a shared spreadsheet that the department head reviewed each month.',
    },
    paragraphs: [
      { id: 'opening', evidenceIds: ['q1'], text: 'Cold chain software succeeds when a temperature excursion reaches the right person before the product is lost. As a systems administrator at Fieldstone Foods, I wrote a Python collector that read the freezer temperature logs of forty warehouse sensors, and it emailed the shift lead a daily exception list. I would apply that alerting work to the readings your services track from trucks and warehouses, and I would keep the exception list short enough to act on. A list that a shift lead reads in a minute gets acted on, and a long one gets ignored.' },
      { id: 'servers', evidenceIds: ['q2'], text: 'Alerts are only useful when the servers behind them recover quickly. I set up the Linux servers for the warehouse scanning system and documented the restore procedure, and the night staff followed it after a disk failure. That documentation is the reliability practice I would carry into your deployments, where a slow restore leaves a truck without readings. I documented each restore step while the servers were fresh in my mind.' },
      { id: 'gps', evidenceIds: ['q3'], text: 'As a support engineer at Brightwater Telematics, I traced truck GPS unit failures back through the device logs. Documenting the most common causes cut repeat service visits for the field technicians, because they stopped guessing at the cause on each call. Your drivers and warehouse leads would see the same benefit from a short list of known causes. Fewer repeat visits also frees field time for new installations, which matters when a fleet grows faster than the technician roster.' },
      { id: 'training', evidenceIds: ['q4'], text: 'I also onboarded each new support hire onto the alerting dashboard.' },
      { id: 'college', evidenceIds: ['q5'], text: 'Earlier, as a help desk technician at Orchard Community College, I resolved lab computer outages and tracked recurring faults in a shared spreadsheet that the department head reviewed each month. Recording repeat faults is how I find the cause behind an alert that keeps returning. The same record can guide which monitoring dashboards your team reviews first, and which scripts need an owner. Small habits like that keep a monitoring setup from drifting away from what the operations team needs.' },
      { id: 'close', evidenceIds: ['q1', 'q2', 'q3', 'q4'], text: 'My alerting, server and diagnosis experience would support your operations team as it responds to alerts and keeps the refrigerated fleet reporting reliably. Across my different employers, the common thread was a person who needed a clear signal and a documented next step, and that is the signal I would help your services send.' },
    ],
    subjects: ['The freezer log', 'The exception list', 'The restore procedure', 'The alerting dashboard', 'The GPS unit record', 'The device log', 'The lab fault sheet'],
    predicates: ['covers each of the forty warehouse sensors', 'goes to the shift lead before each shift', 'names the steps for a disk failure', 'shows every open alert for the operations team', 'lists the common causes for the field technicians', 'keeps one line for each repeat fault'],
    impersonal: {
      quote: 'q2',
      restated: 'The restore procedure covers the Linux servers of the warehouse scanning system after a disk failure.',
      broadened: {
        daily: 'The Linux servers for the warehouse scanning system could restore daily from the restore procedure.',
        'organization-wide': 'The restore procedure for the Linux servers behind the warehouse scanning system applies organization-wide.',
        always: 'The night staff always follow the restore procedure for the Linux servers after a disk failure.',
      },
      targetFacing: 'Your refrigerated fleet needs readings that arrive without gaps, and a restore that takes minutes keeps the dashboards current every day.',
    },
  },
  {
    key: 'nonprofit finance', company: 'Community Housing Trust',
    jobText: 'Grants Finance Analyst, Community Housing Trust. You will track restricted grant budgets, prepare monthly spending reports for funders, reconcile program expenses and flag overspending early. You will work with program managers who submit expense reports. Experience with fund accounting and spreadsheet modeling required.',
    roles: [
      { title: 'Program Accountant', company: 'Eastbrook Youth Services', bullets: ['Kept eleven restricted grant budgets in a shared workbook and prepared a monthly spending report for each funder.', 'Caught a program overspending its grant in month four, so the director shifted two expenses to an unrestricted fund.', 'Created an expense report template that program managers used to submit receipts, which cut the number of returned reports.'] },
    ],
    quotes: {
      q1: 'Tracked eleven restricted grant budgets in one shared workbook and prepared monthly spending reports for each funder.',
      q2: 'Flagged a program that was spending ahead of its grant budget in month four, and the director moved two expenses to an unrestricted fund.',
      q3: 'Created an expense report template that program managers used to submit receipts, which cut the number of returned reports.',
    },
    paragraphs: [
      { id: 'opening', evidenceIds: ['q1'], text: 'Funders read spending reports closely, so the numbers have to be right every month. As a program accountant at Eastbrook Youth Services, I tracked eleven restricted grant budgets in one shared workbook and prepared the monthly spending report for each funder. That is the reporting cycle your trust runs. Each report reached its funder with figures that matched the ledger.' },
      { id: 'overspend', evidenceIds: ['q2'], text: 'The workbook also showed problems early. In month four, I flagged a program that was spending ahead of its grant budget, and the director moved two expenses to an unrestricted fund. I would watch each grant budget the same way and flag any program that overruns its plan.' },
      { id: 'template', evidenceIds: ['q3'], text: 'Program managers are the source of most reporting errors, so I created an expense report template they used to submit receipts. Fewer reports came back to them for correction, and the accounting office spent less time chasing receipts. A form that asks for the right detail at submission saves the finance team a second round of questions, and it gives the reconciliation a consistent starting point.' },
      { id: 'transfer', evidenceIds: ['q1', 'q3'], text: 'Tracking, early flags and a simple submission form are the approach I would bring to a housing trust with many funders and many program managers.' },
      { id: 'close', evidenceIds: ['q1'], text: 'My grant tracking experience would support your monthly funder reports, and my template experience would support the program managers who feed them. Each month closes with figures a funder can trust.' },
    ],
    subjects: ['The shared workbook', 'The grant ledger', 'The spending report', 'The expense template', 'The receipt log', 'The budget line', 'The funder summary'],
    predicates: ['lists each restricted grant by fund', 'shows the spending to date for every program', 'holds one row for each submitted receipt', 'carries the month end balance for the funder', 'marks each expense as restricted or unrestricted', 'goes to the director before each report'],
    impersonal: {
      quote: 'q1',
      restated: 'The shared workbook holds eleven grant budgets and spending reports for each funder.',
      broadened: {
        daily: 'The shared workbook could track eleven grant budgets and prepare spending reports for each funder daily.',
        'organization-wide': 'The shared workbook tracks eleven grant budgets and spending reports for each funder organization-wide.',
        always: 'Spending reports for each funder always come from the shared workbook of eleven grant budgets.',
      },
      targetFacing: 'Your trust reports to many funders every month, and each program manager needs a clear place to send receipts.',
    },
  },
]);

// Short letters in the shape checkDirectWelcomeClosing certifies: a one-line hook,
// two proof paragraphs and a one-line direct welcome, so two of the four
// paragraphs are a single sentence. Each passes the whole editorial battery and
// every paragraph's grounding. They sit near the lower bounds on purpose (110 to
// 131 words, a paragraph mean of 27 to 33) and are the shape the first
// proportion limits rejected: one standalone sentence allowed, a mean of 30.
const HOOK_CLOSE_LETTERS = Object.freeze([
  {
    key: 'hook and close, clinic data', company: 'Lumen Clinical Analytics', base: 0,
    jobText: GOOD_LETTERS[0].jobText,
    roles: [{ title: 'Data Engineer', company: 'Meridian Clinics', bullets: ['Merged appointment and billing records from three scheduling systems into a single reporting database with nightly Python and SQL pipelines.', 'Gave front-desk and finance staff separate views of the reporting database and logged each access request for audit.'] }],
    quotes: {
      q1: GOOD_LETTERS[0].quotes.q1,
      q2: GOOD_LETTERS[0].quotes.q2,
    },
    paragraphs: [
      { id: 'hook', evidenceIds: ['q1'], text: 'Clinical reporting is only as trustworthy as the data pipeline behind it, and I have built that pipeline across three clinic scheduling systems.' },
      { id: 'pipeline', evidenceIds: ['q1'], text: 'As a data engineer at Meridian Clinics, I built nightly Python and SQL pipelines that pulled appointment and billing records out of three scheduling systems and loaded them into one reporting database. I would apply that pipeline experience to the warehouse your analytics team relies on.' },
      { id: 'access', evidenceIds: ['q2'], text: 'Bringing those records together raised an access problem, because front-desk staff and finance staff should not see the same data. I added role-based access so each group saw its own view of the reporting database, and I logged every access request for audit.' },
      { id: 'close', evidenceIds: ['q1', 'q2'], text: 'I welcome the chance to talk about how my database and access work would support your clinical analytics team.' },
    ],
  },
  {
    key: 'hook and close, logistics', company: 'Redline Distribution', base: 1,
    jobText: GOOD_LETTERS[1].jobText,
    roles: [{ title: 'Logistics Analyst', company: 'Northgate Freight', bullets: ['Ranked twelve carriers by on-time delivery over six months and recommended dropping the two slowest from the weekly rotation.', 'Created an Excel dock-appointment tracker for late inbound trucks, which the receiving supervisor used to reorder the unloading queue.'] }],
    quotes: {
      q1: GOOD_LETTERS[1].quotes.q1,
      q2: GOOD_LETTERS[1].quotes.q2,
    },
    paragraphs: [
      { id: 'hook', evidenceIds: ['q1'], text: 'Carrier delivery rates decide whether freight reaches the dock when the crew can unload it.' },
      { id: 'compare', evidenceIds: ['q1'], text: 'As a logistics analyst at Northgate Freight, I compared the on-time delivery rates of twelve carriers across a half-year and advised dropping the two slowest carriers from the rotation. I would run that comparison across your four distribution centers.' },
      { id: 'dock', evidenceIds: ['q2'], text: 'Late trucks cost as much as slow carriers, so I built an Excel tracker that listed inbound trucks waiting well past their slot, and the receiving supervisor used it to reorder the unloading queue. I would use the same approach to surface waiting trucks across your sites.' },
      { id: 'close', evidenceIds: ['q1', 'q2'], text: 'I welcome the chance to talk about how my carrier and dock work would support your weekly operations reports.' },
    ],
  },
  {
    key: 'hook and close, school IT', company: 'Lakeside Charter Schools', base: 2,
    jobText: GOOD_LETTERS[2].jobText,
    roles: [{ title: 'Technology Assistant', company: 'Cedar Valley School District', bullets: ['Ran the Chromebook and tablet fleet for two schools, from console enrollment and repairs to a student loaner program.', 'Authored guides covering password resets and projector setup that cut help desk calls from teachers.'] }],
    quotes: {
      q1: GOOD_LETTERS[2].quotes.q1,
      q2: GOOD_LETTERS[2].quotes.q2,
    },
    paragraphs: [
      { id: 'hook', evidenceIds: ['q1'], text: 'Schools need devices that work the moment students arrive, and I have kept a fleet of Chromebooks and tablets running for two schools.' },
      { id: 'fleet', evidenceIds: ['q1'], text: 'As a technology assistant at Cedar Valley School District, I handled enrollment in the management console, repairs and a student loaner program for that fleet. I would bring the same routine to the laptops and tablets across your two buildings.' },
      { id: 'guides', evidenceIds: ['q2'], text: 'Teachers rarely have time to wait for a ticket, so I wrote step-by-step guides for password resets and classroom projector setup. Teachers followed them without calling the help desk.' },
      { id: 'close', evidenceIds: ['q1', 'q2'], text: 'I welcome the chance to talk about how my fleet management work would support your students and teachers.' },
    ],
  },
].map(letter => ({ ...letter, subjects: GOOD_LETTERS[letter.base].subjects, predicates: GOOD_LETTERS[letter.base].predicates })));

const textsOf = letter => letter.paragraphs.map(paragraph => paragraph.text);
const citationsOf = (letter, paragraphs = letter.paragraphs) => paragraphs.map(paragraph => paragraph.evidenceIds.map(id => letter.quotes[id]));

function evidenceOf(letter) {
  return {
    roles: letter.roles.map(role => ({
      title: role.title, company: role.company, dates: '', location: '', summary: '',
      bullets: role.bullets.map(bullet => ({ text: bullet, tradeoff: '', budgetText: bullet, achievementIds: [] })),
    })),
    projects: [], skills: [], education: [], bulletTexts: letter.roles.flatMap(role => role.bullets),
  };
}

function planOf(letter) {
  const [role] = letter.roles;
  return {
    roleThesis: 'Reliable operations depend on analysis that finds a problem before it spreads across the work.',
    mappings: [{ evidence: role.bullets[0], evidenceRole: `${role.title}, ${role.company}`, narrativeRole: 'primary', relationToPrevious: 'The work shows the capability the role needs in practice.' }],
    companyHook: { detail: '', source: '', whyItMattersToCandidate: '' },
    logistics: '',
  };
}

/** The whole production battery over one letter, the way the cover-letter twin and the completion gate run it. */
function battery(letter, paragraphs, citations = null) {
  const plan = planOf(letter);
  const evidence = evidenceOf(letter);
  return [
    checkRoleThesis(plan), checkMappingNarrativeStructure(plan), checkEvidenceGrounding(plan, evidence),
    ...evaluateCoverLetterChecks({
      plan, paragraphs, evidence, jobText: letter.jobText, researchText: '', companyName: letter.company, referenceDate: '2026-10-09',
      paragraphCitations: citations,
    }),
  ];
}
const failedIds = checks => checks.filter(check => !check.passed).map(check => check.id);
const gatesOf = (paragraphs, citations = null) => analyzeLetterProportion(paragraphs, { citations }).violations.map(violation => violation.gate);

/** Impersonal one-sentence details: `count` distinct sentences with no first-person word. */
function details(letter, count) {
  const out = [];
  for (const predicate of letter.predicates) {
    for (const subject of letter.subjects) {
      if (out.length < count) out.push(`${subject} ${predicate}.`);
    }
  }
  assert(out.length === count, `${letter.key}: the detail generator supplies ${count} sentences (has ${out.length})`);
  return out;
}

const variantsOf = letter => {
  const good = textsOf(letter);
  return {
    'three impersonal paragraphs appended': [...good, ...details(letter, 3)],
    'twelve impersonal paragraphs appended': [...good, ...details(letter, 12)],
    'forty impersonal paragraphs appended': [...good, ...details(letter, 40)],
    // One filler after each real paragraph: the real paragraphs are still first person.
    'a filler interleaved after every paragraph': good.flatMap((paragraph, index) => [paragraph, details(letter, good.length)[index]]),
    // The same 40 sentences poured into the real paragraphs, so the paragraph count never moves.
    'forty impersonal sentences merged into the real paragraphs': (() => {
      const extra = details(letter, 40);
      return good.map((paragraph, index) => `${paragraph} ${extra.filter((_, at) => at % good.length === index).join(' ')}`);
    })(),
    // Every sentence of the real letter on a line of its own.
    'every sentence its own paragraph': good.flatMap(paragraph => sentences(paragraph)),
  };
};

// ---------------------------------------------------------------------------
// Structural letter builder for the one-limit-at-a-time cases
// ---------------------------------------------------------------------------

// Sentences with an exact word count and a known voice. `tag` makes each one
// distinct; the padding words carry no meaning because the check reads only
// counts, who is speaking, and whether a completed action is stated.
const pad = (head, words, tag) => {
  const headWords = head.split(' ').length;
  assert(words >= headWords, `a ${words}-word sentence cannot start with “${head}”`);
  const filler = Array.from({ length: words - headWords }, (_, index) => `${tag}x${index}`).join(' ');
  return `${head}${filler ? ` ${filler}` : ''}.`;
};
const action = (words, tag) => pad(`I built the ${tag}`, words, tag); // first person, completed action
const voice = (words, tag) => pad(`My ${tag} work would help`, words, tag); // first person, no completed action
const impersonal = (words, tag) => pad(`The ${tag} holds`, words, tag); // no first person

// A paragraph of the baseline shape: one action sentence and two impersonal.
const baselineParagraph = tag => [action(15, tag), impersonal(10, `${tag}b`), impersonal(10, `${tag}c`)].join(' ');
const baseline = count => Array.from({ length: count }, (_, index) => baselineParagraph(`p${index}`));

const countWords = value => (String(value).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || []).length;

/** An informative failure for a structural expectation. */
function expectGates(where, paragraphs, expected, citations = null) {
  const found = gatesOf(paragraphs, citations);
  assert(JSON.stringify(found) === JSON.stringify(expected),
    `${where}: expected exactly [${expected}] but the check reports [${found}] (P=${paragraphs.length}, W=${paragraphs.reduce((sum, value) => sum + countWords(value), 0)})`);
}

// ---------------------------------------------------------------------------
// Grounding helpers (impersonal sentences)
// ---------------------------------------------------------------------------

const catalogQuote = (text, index) => `- Achievement [ach-${index}]: ${text}`;
function groundingVerdict(text, quotes, identityTokens = [], options = {}) {
  try {
    assertSourceQuoteLinksFinalText(text, quotes.map((quote, index) => catalogQuote(quote, index + 1)), 'coverLetterParagraphs', 0, { identityTokens, ...options });
    return '';
  } catch (error) { return String(error?.message || error); }
}
const identityTokensOf = letter => [...new Set(letter.roles.flatMap(role => `${role.title} ${role.company}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].filter(token => token.length > 2);

// A quote about the SAME work that states each qualifier in one of the forms the qualifier table accepts. A claim is
// judged against the quotes about the clause that makes it, so a quote that states a qualifier about other work does
// not support a sentence about this one: the support is the sentence's own source, whole, with the qualifier added.
const SUPPORT_TAIL = Object.freeze({
  daily: 'and ran it every day for the team.',
  'organization-wide': 'and rolled it out across the organization.',
  always: 'and always kept it running.',
});
const firstWords = (value, count) => value.split(/\s+/u).slice(0, count).join(' ').replace(/[,.;]$/u, '');
const supportFor = (letter, qualifier, tail = SUPPORT_TAIL[qualifier], count = 200) => `${firstWords(letter.quotes[letter.impersonal.quote], count)}, ${tail}`;
// The cues the per-sentence grounding read before it learned to read an impersonal restatement: a first-person
// word, or a career-action verb (the closed list, or a regular past tense of five letters or more). Copied here
// so the fixtures can prove they sit outside it; a change to the production cue only loosens this guard.
const OLDER_READINGS = /\b(?:i|we|my|our|am|was|were|had|worked|built|created|developed|delivered|implemented|used|applied|evaluated|handled|ran|wrote|designed|maintained|migrated|automated|researched|tested|modified|packaged|containerized|integrated|led|managed|owned|decided|approved|authorized|improved|reduced|increased|saved|accelerated|optimized|ensured)\b|\b[\p{L}]{5,}(?:ed|ized|ised|ated)\b/iu;
const FIXED_RULE = Object.freeze({
  daily: /unsupported daily frequency/u,
  'organization-wide': /unsupported organization-wide scope/u,
  always: /unsupported absolute frequency/u,
});

// ---------------------------------------------------------------------------

export default [
  {
    name: 'Letter proportion: five good letters in unrelated fields pass the whole editorial battery, every paragraph\'s grounding, and every proportion limit with room to spare',
    run() {
      for (const letter of GOOD_LETTERS) {
        const paragraphs = textsOf(letter);
        const checks = battery(letter, paragraphs, citationsOf(letter));
        assert(checks.length === 55, `${letter.key}: the whole battery ran (checks=${checks.length})`);
        assert(!failedIds(checks).length, `${letter.key}: a good letter fails nothing (failed=${failedIds(checks).map(id => `${id}: ${checks.find(check => check.id === id).detail}`).join(' | ')})`);
        const proportion = checks.find(check => check.id === 'letter-proportion');
        assert(proportion && proportion.passed && /within the letter proportion limits/u.test(proportion.detail),
          `${letter.key}: the letter is JUDGED and within the limits, not skipped (detail=${proportion?.detail})`);
        // Room to spare on every measure, so the limits are not tuned to the edge of a fixture.
        const { metrics } = analyzeLetterProportion(paragraphs, { citations: citationsOf(letter) });
        const perParagraph = paragraphs.map(paragraph => sentences(paragraph).length);
        assert(metrics.quoteLimitJudged, `${letter.key}: the quote limit was judged`);
        assert(metrics.paragraphCount <= MAX_LETTER_BODY_PARAGRAPHS - 1, `${letter.key}: at least one paragraph under the ceiling`);
        assert(metrics.meanParagraphWords >= MIN_MEAN_PARAGRAPH_WORDS + 10, `${letter.key}: mean paragraph length ${metrics.meanParagraphWords.toFixed(1)} is well over the floor`);
        assert(Math.max(...perParagraph) <= MAX_PARAGRAPH_SENTENCES - 1, `${letter.key}: no paragraph runs to the sentence ceiling`);
        assert(perParagraph.filter(count => count === 1).length <= 1, `${letter.key}: at most one standalone sentence`);
        assert(metrics.firstPersonSentences / metrics.totalSentences >= MIN_FIRST_PERSON_SENTENCE_SHARE + 0.15, `${letter.key}: the first-person share is well over the floor`);
        assert(metrics.actionParagraphs / metrics.paragraphCount >= MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE + 0.15, `${letter.key}: the first-person action share is well over the floor`);
        const idTokens = identityTokensOf(letter);
        for (const paragraph of letter.paragraphs) {
          const verdict = groundingVerdict(paragraph.text, paragraph.evidenceIds.map(id => letter.quotes[id]), idTokens);
          assert(verdict === '', `${letter.key}/${paragraph.id}: a grounded paragraph is accepted by the extended per-sentence grounding (got ${verdict})`);
        }
      }
    },
  },
  {
    name: 'Letter proportion: padded, interleaved, merged and exploded variants of every good letter fail with letter-proportion, for the limits they break',
    run() {
      const expected = {
        'three impersonal paragraphs appended': ['single-sentence-paragraphs'],
        'twelve impersonal paragraphs appended': ['paragraph-count', 'single-sentence-paragraphs'],
        'forty impersonal paragraphs appended': ['paragraph-count', 'single-sentence-paragraphs', 'paragraph-length', 'first-person-action-paragraphs', 'first-person-voice'],
        'a filler interleaved after every paragraph': ['single-sentence-paragraphs'],
        'forty impersonal sentences merged into the real paragraphs': ['paragraph-sentences', 'first-person-voice'],
        'every sentence its own paragraph': ['paragraph-count', 'single-sentence-paragraphs', 'paragraph-length', 'first-person-action-paragraphs'],
      };
      let verdicts = 0;
      for (const letter of GOOD_LETTERS) {
        for (const [variant, paragraphs] of Object.entries(variantsOf(letter))) {
          const checks = battery(letter, paragraphs);
          assert(failedIds(checks).includes('letter-proportion'), `${letter.key} / ${variant}: the battery reports letter-proportion (failed=${failedIds(checks)})`);
          const gates = gatesOf(paragraphs);
          for (const gate of expected[variant]) {
            assert(gates.includes(gate), `${letter.key} / ${variant}: breaks the ${gate} limit (reported=[${gates}])`);
          }
          const failing = checkLetterProportion(paragraphs);
          assert(!failing.passed && failing.id === 'letter-proportion', `${letter.key} / ${variant}: checkLetterProportion rejects it`);
          verdicts += 1;
        }
      }
      assert(verdicts === GOOD_LETTERS.length * 6, `every variant of every letter was judged (verdicts=${verdicts})`);
      // The smallest padding the issue named: three extra detail paragraphs on a letter that otherwise fits the ceiling.
      const clinic = GOOD_LETTERS[0];
      assert(variantsOf(clinic)['three impersonal paragraphs appended'].length === MAX_LETTER_BODY_PARAGRAPHS,
        'three appended paragraphs bring the clinic letter exactly to the paragraph ceiling, so only the standalone-sentence limit can reject it');
    },
  },
  {
    name: 'Letter proportion: every limit is broken ALONE by a structural letter, and the boundary either side of it passes (isolation of each gate)',
    run() {
      // The baseline: five paragraphs, each one action sentence and two impersonal ones.
      expectGates('baseline', baseline(5), []);

      // paragraph-count
      expectGates('7 paragraphs sit at the ceiling', baseline(MAX_LETTER_BODY_PARAGRAPHS), []);
      expectGates('8 paragraphs pass the ceiling', baseline(MAX_LETTER_BODY_PARAGRAPHS + 1), ['paragraph-count']);

      // single-sentence-paragraphs: the allowance is max(2, floor(P / divisor)): a hook and a closing line are always allowed
      assert(MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE === 2 && SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR === 3,
        'the allowance the fixtures sit either side of is two standalone sentences, then one more per three paragraphs');
      for (const [paragraphCount, allowed] of [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 3], [11, 3], [12, 4], [42, 14]]) {
        assert(letterSingleSentenceAllowance(paragraphCount) === allowed, `${paragraphCount} paragraphs allow ${allowed} standalone sentences (got ${letterSingleSentenceAllowance(paragraphCount)})`);
      }
      const single = tag => action(34, tag); // a long first-person single sentence, so only the count of singles is in play
      const withSingles = (total, singles) => [...baseline(total - singles), ...Array.from({ length: singles }, (_, index) => single(`s${index}`))];
      expectGates('7 paragraphs with 2 standalone sentences', withSingles(7, 2), []);
      expectGates('7 paragraphs with 3 standalone sentences', withSingles(7, 3), ['single-sentence-paragraphs']);
      expectGates('6 paragraphs with 2 standalone sentences', withSingles(6, 2), []);
      expectGates('6 paragraphs with 3 standalone sentences', withSingles(6, 3), ['single-sentence-paragraphs']);
      // The four-paragraph letter with a one-line hook and a one-line closing is within the allowance; a third one-liner is not.
      expectGates('4 paragraphs with 2 standalone sentences (a hook and a closing)', withSingles(4, 2), []);
      expectGates('4 paragraphs with 3 standalone sentences', withSingles(4, 3), ['single-sentence-paragraphs']);
      expectGates('3 paragraphs with 1 standalone sentence', withSingles(3, 1), []);
      expectGates('3 paragraphs with 2 standalone sentences', withSingles(3, 2), []);
      expectGates('3 paragraphs that are all standalone sentences', withSingles(3, 3), ['single-sentence-paragraphs']);

      // paragraph-length: the mean, at exactly the floor and one word under it
      const paragraphOfWords = (words, tag) => [action(Math.ceil(words / 2), tag), impersonal(words - Math.ceil(words / 2), `${tag}b`)].join(' ');
      const four = counts => counts.map((words, index) => paragraphOfWords(words, `m${index}`));
      expectGates('mean exactly at the floor', four([25, 25, 25, 25]), []);
      expectGates('mean one word under the floor', four([25, 25, 25, 24]), ['paragraph-length']);
      expectGates('mean at the floor with a hook and a closing line of different lengths', four([13, 37, 37, 13]), []);
      expectGates('the same four paragraphs a word shorter', four([13, 37, 37, 12]), ['paragraph-length']);
      assert(MIN_MEAN_PARAGRAPH_WORDS === 25, 'the length floor the fixtures sit either side of is 25');

      // paragraph-sentences: one paragraph past the sentence ceiling
      const longParagraph = sentenceCount => [action(8, 'long'), ...Array.from({ length: sentenceCount - 1 }, (_, index) => voice(8, `long${index}`))].join(' ');
      expectGates('a paragraph at the sentence ceiling', [...baseline(3), longParagraph(MAX_PARAGRAPH_SENTENCES)], []);
      expectGates('a paragraph one sentence past the ceiling', [...baseline(3), longParagraph(MAX_PARAGRAPH_SENTENCES + 1)], ['paragraph-sentences']);
      // The ceiling's value, stated as a number: sizing the fixtures from the constant cannot notice the constant moving.
      assert(MAX_PARAGRAPH_SENTENCES === 6, 'the sentence ceiling the fixtures sit either side of is six');
      expectGates('a paragraph of exactly six sentences', [...baseline(3), longParagraph(6)], []);
      expectGates('a paragraph of exactly seven sentences', [...baseline(3), longParagraph(7)], ['paragraph-sentences']);

      // first-person-action-paragraphs: voice without a completed action does not count
      const voiceOnly = tag => [voice(16, tag), voice(16, `${tag}b`)].join(' ');
      const withActions = (total, actions) => [...baseline(actions), ...Array.from({ length: total - actions }, (_, index) => voiceOnly(`v${index}`))];
      assert(MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE === 0.4 && letterFirstPersonActionParagraphFloor(5) === 2
        && letterFirstPersonActionParagraphFloor(10) === 4 && letterFirstPersonActionParagraphFloor(15) === 6 && letterFirstPersonActionParagraphFloor(3) === 2,
      'the action floor is 40% of the paragraphs, rounded up, without a float artifact');
      expectGates('5 paragraphs with 2 stating an action', withActions(5, 2), []);
      expectGates('5 paragraphs with 1 stating an action', withActions(5, 1), ['first-person-action-paragraphs']);
      expectGates('3 paragraphs with 2 stating an action', withActions(3, 2), []);
      expectGates('3 paragraphs with 1 stating an action', withActions(3, 1), ['first-person-action-paragraphs']);
      // “I've built” is the same claim as “I have built”
      assert(analyzeLetterProportion([...withActions(5, 1).slice(0, 4), 'I’ve built the contraction worksheet and I’ve kept it current for every review cycle that followed it this year.'].map(value => value)).metrics.actionParagraphs === 2,
      'a contraction states a completed action as an expanded verb does');

      // first-person-voice: the share of sentences in the writer's own voice
      const twoParagraphs = firstPersonSentences => {
        const make = (tag, fp) => [
          action(10, `${tag}a`),
          ...Array.from({ length: 4 }, (_, index) => (index < fp - 1 ? voice(10, `${tag}v${index}`) : impersonal(10, `${tag}i${index}`))),
        ].join(' ');
        return [make('q', Math.ceil(firstPersonSentences / 2)), make('r', Math.floor(firstPersonSentences / 2))];
      };
      const sharedVoice = paragraphs => analyzeLetterProportion(paragraphs).metrics.firstPersonSentences;
      assert(sharedVoice(twoParagraphs(3)) === 3 && sharedVoice(twoParagraphs(2)) === 2, 'the voice fixtures carry the first-person sentence counts they name');
      expectGates('3 of 10 sentences in the writer\'s voice', twoParagraphs(3), []);
      expectGates('2 of 10 sentences in the writer\'s voice', twoParagraphs(2), ['first-person-voice']);
      assert(MIN_FIRST_PERSON_SENTENCE_SHARE === 0.3, 'the voice floor the fixtures sit either side of is 30%');

      // Under the judged-from floor nothing is judged, even a letter that would break every limit.
      const stub = Array.from({ length: 8 }, (_, index) => `The stub${index} holds.`);
      assert(!analyzeLetterProportion(stub).judged && checkLetterProportion(stub).passed && /skipped/u.test(checkLetterProportion(stub).detail),
        'a stub letter is not judged for proportion (the underfill rule speaks for it)');
      // Eight one-sentence paragraphs that break the ceiling and the standalone limit, one word either side of the floor.
      const stubOfWords = total => Array.from({ length: 8 }, (_, index) => impersonal(Math.floor(total / 8) + (index < total % 8 ? 1 : 0), `n${index}`));
      const eightyNine = stubOfWords(LETTER_PROPORTION_MIN_JUDGED_WORDS - 1);
      assert(eightyNine.join(' ').split(/\s+/u).length === LETTER_PROPORTION_MIN_JUDGED_WORDS - 1 && !analyzeLetterProportion(eightyNine).judged && checkLetterProportion(eightyNine).passed,
        'one word under the floor is not judged');
      const ninety = stubOfWords(LETTER_PROPORTION_MIN_JUDGED_WORDS);
      assert(ninety.join(' ').split(/\s+/u).length === LETTER_PROPORTION_MIN_JUDGED_WORDS && analyzeLetterProportion(ninety).judged && gatesOf(ninety).includes('paragraph-count') && !checkLetterProportion(ninety).passed,
        'exactly the floor is judged');
      assert(LETTER_PROPORTION_MIN_JUDGED_WORDS === MIN_COVER_LETTER_UNDERFILL_WORDS,
        'the proportion check judges from the same word floor the underfill rule uses, so the two never leave a gap or an overlap');
    },
  },
  {
    name: 'Letter proportion: paragraphs per cited quote is judged from the citations, and re-pointing one citation flips admissibility (A/B/C, five domains)',
    run() {
      for (const letter of GOOD_LETTERS) {
        const paragraphs = textsOf(letter);
        const count = paragraphs.length;
        // Only a letter with more paragraphs than the quote limit can break it.
        const reusable = count > MAX_PARAGRAPHS_PER_CITED_QUOTE;
        const [first, second] = Object.keys(letter.quotes).map(id => letter.quotes[id]);
        const allOnFirst = Array.from({ length: count }, () => [first]);
        if (!reusable) {
          expectGates(`${letter.key}: ${count} paragraphs cannot exceed the quote limit`, paragraphs, [], allOnFirst);
          continue;
        }
        // A: every paragraph leans on one quote
        expectGates(`${letter.key}/A`, paragraphs, ['quote-reuse'], allOnFirst);
        // B: re-point enough paragraphs at a second quote that no quote has more than the limit
        const repointed = allOnFirst.map((cited, index) => (index >= MAX_PARAGRAPHS_PER_CITED_QUOTE ? [second] : cited));
        expectGates(`${letter.key}/B`, paragraphs, [], repointed);
        // C: and back
        expectGates(`${letter.key}/C`, paragraphs, ['quote-reuse'], allOnFirst);
        // The same quote written with different case and spacing is still the same quote.
        const respelled = allOnFirst.map((cited, index) => (index % 2 ? [` ${first.toUpperCase().replace(/ /gu, '  ')} `] : cited));
        expectGates(`${letter.key}/respelled`, paragraphs, ['quote-reuse'], respelled);
        // The limit counts a paragraph once per quote, however often it cites it.
        const doubled = allOnFirst.map(cited => [...cited, ...cited]);
        expectGates(`${letter.key}/doubled`, paragraphs, ['quote-reuse'], doubled);
        const limitCitations = allOnFirst.map((cited, index) => (index >= MAX_PARAGRAPHS_PER_CITED_QUOTE ? [second] : [first, first]));
        expectGates(`${letter.key}/at the limit`, paragraphs, [], limitCitations);
      }
      // Not judged, rather than guessed, when the citations are absent or do not line up with the paragraphs.
      const logistics = GOOD_LETTERS[1];
      const paragraphs = textsOf(logistics);
      const reuse = paragraphs.map(() => [logistics.quotes.q1]);
      assert(analyzeLetterProportion(paragraphs, { citations: reuse }).metrics.quoteLimitJudged, 'aligned citations are judged');
      for (const [label, citations] of [['absent', null], ['short', reuse.slice(1)], ['long', [...reuse, [logistics.quotes.q1]]], ['not an array', 'q1']]) {
        const analysis = analyzeLetterProportion(paragraphs, { citations });
        assert(!analysis.metrics.quoteLimitJudged && !analysis.violations.some(violation => violation.gate === 'quote-reuse'),
          `${label} citations are not judged (violations=${analysis.violations.map(violation => violation.gate)})`);
      }
      // Citations stay aligned with the paragraphs when a blank one is dropped from the body.
      const withBlank = [paragraphs[0], '   ', ...paragraphs.slice(1)];
      const blankCitations = [reuse[0], [], ...reuse.slice(1)];
      assert(analyzeLetterProportion(withBlank, { citations: blankCitations }).violations.some(violation => violation.gate === 'quote-reuse'),
        'a blank paragraph does not shift the citations of the paragraphs after it');
    },
  },
  {
    name: 'Letter proportion: the message names the operation for each limit that failed, only those, copies nothing from the letter, and fits one correction item',
    run() {
      const operation = /\b(?:merge|append|delete|combine|rewrite|keep|fold)\b/u;
      const clauseOf = {
        'paragraph-count': /body paragraphs against a ceiling of \d+: merge at least/u,
        'single-sentence-paragraphs': /are single sentences against an allowance of \d+: append/u,
        'paragraph-length': /average [\d.]+ words against a minimum of \d+: combine/u,
        'paragraph-sentences': /sentences against a ceiling of \d+: keep/u,
        'first-person-action-paragraphs': /state an action of your own \(I or we, then a verb for what you did or do, even after an adverb: .*? state none\) against a minimum of \d+/u,
        'first-person-voice': /sentences speak in your own voice \(I, we, my or our\) against a minimum of \d+%/u,
        'quote-reuse': /cite the same career-data quote against a maximum of \d+: merge/u,
      };
      const everyGate = Object.keys(clauseOf);
      // Each isolation fixture produces exactly its own clause.
      const alone = {
        'paragraph-count': baseline(MAX_LETTER_BODY_PARAGRAPHS + 1),
        'single-sentence-paragraphs': [...baseline(3), action(34, 's0'), action(34, 's1'), action(34, 's2')],
        'paragraph-length': [25, 25, 25, 24].map((words, index) => [action(Math.ceil(words / 2), `m${index}`), impersonal(words - Math.ceil(words / 2), `m${index}b`)].join(' ')),
        'paragraph-sentences': [...baseline(3), [action(8, 'long'), ...Array.from({ length: MAX_PARAGRAPH_SENTENCES }, (_, index) => voice(8, `long${index}`))].join(' ')],
        'first-person-action-paragraphs': [...baseline(1), ...Array.from({ length: 4 }, (_, index) => [voice(16, `v${index}`), voice(16, `v${index}b`)].join(' '))],
        'first-person-voice': [0, 1].map(index => [action(10, `q${index}`), ...Array.from({ length: 4 }, (_, at) => impersonal(10, `q${index}i${at}`))].join(' ')),
      };
      for (const [gate, paragraphs] of Object.entries(alone)) {
        const result = checkLetterProportion(paragraphs);
        assert(!result.passed, `${gate}: rejected`);
        const printed = everyGate.filter(candidate => clauseOf[candidate].test(result.detail));
        assert(JSON.stringify(printed) === JSON.stringify([gate]), `${gate}: the message states only the limit that failed (printed=[${printed}], detail=${result.detail})`);
        assert(operation.test(result.detail), `${gate}: the message names the edit that repairs it`);
      }
      const reuse = checkLetterProportion(baseline(5), { citations: baseline(5).map(() => ['one quote']) });
      assert(!reuse.passed && clauseOf['quote-reuse'].test(reuse.detail) && everyGate.filter(gate => clauseOf[gate].test(reuse.detail)).length === 1,
        `quote-reuse: the message states only its own limit (detail=${reuse.detail})`);

      // Worst case: every limit broken at once, on a real letter's words.
      const letter = GOOD_LETTERS[3];
      const wall = details(letter, 8).join(' ');
      const worst = [wall, ...details(letter, 40)];
      const worstCitations = worst.map(() => [letter.quotes.q1]);
      const message = checkLetterProportion(worst, { citations: worstCitations }).detail;
      assert(everyGate.every(gate => clauseOf[gate].test(message)), `all seven limits are stated when all seven fail (detail=${message})`);
      assert(message.length < 1500, `the worst case fits one correction item (${message.length} characters, ceiling 1500)`);
      assert(!/\bsplit\b/iu.test(message), 'the message never offers splitting as a repair, which is the defect');
      // Nothing in the message is copied out of the letter: no run of five of its words appears.
      const letterWords = worst.join(' ').toLowerCase().match(/[\p{L}\p{N}']+/gu);
      const messageText = ` ${message.toLowerCase().match(/[\p{L}\p{N}']+/gu).join(' ')} `;
      for (let at = 0; at + 5 <= letterWords.length; at += 1) {
        assert(!messageText.includes(` ${letterWords.slice(at, at + 5).join(' ')} `), `the message copies five words of the letter (“${letterWords.slice(at, at + 5).join(' ')}”)`);
      }
      // The merge advice carries its own counter-pressure: merged paragraphs are read as one by the repeat checks.
      assert(/repeated-phrase and sentence-shape/u.test(message), 'the message names the checks that a merge can trip');
    },
  },
  {
    name: 'Letter proportion: the check is wired into the battery, the reportable-id table, the contracts and the corrective rules, from one set of constants',
    run() {
      const checks = evaluateCoverLetterChecks({ plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs: ['I built it.', 'It ran.'], evidence: {}, jobText: '', researchText: '' });
      const ids = checks.map(check => check.id);
      assert(ids.includes('letter-proportion') && ids.indexOf('letter-proportion') === ids.indexOf('candidate-agency') + 1,
        'letter-proportion runs in the battery right after the agency check it tightens');
      assert(pasteReportableCheckIds().includes('letter-proportion') && PASTE_CHECK_PROSE_UNITS['letter-proportion'] === 'prose-unit',
        'the check is reportable and scoped to the letter\'s prose unit, so a correction brief is printed for it');

      const root = path.resolve('.');
      const localSource = fs.readFileSync(path.join(root, 'electron/ipc/localAiApplication.js'), 'utf8');
      const checksSource = fs.readFileSync(path.join(root, 'electron/ipc/coverLetterChecks.js'), 'utf8');
      // The drafting contract and the review contract are asserted on the prompts the flow builds (paste-application-flow.js); the
      // corrective rule is asserted on the guidance a failed check prints (below). Neither is read from this file's source text.
      // The printed rule states every number the gate reads.
      for (const printed of [
        `${LETTER_PROPORTION_MIN_JUDGED_WORDS} words`, `at most ${MAX_LETTER_BODY_PARAGRAPHS} body paragraphs`, `at least ${MIN_MEAN_PARAGRAPH_WORDS} words per paragraph`,
        `past ${MAX_PARAGRAPH_SENTENCES} sentences`, `at most ${MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE} standalone one-sentence paragraphs`,
        `${Math.round(MIN_FIRST_PERSON_ACTION_PARAGRAPH_SHARE * 100)}% of paragraphs stating an action of your own (${PROPORTION_ACTION_STATEMENT})`,
        `${Math.round(MIN_FIRST_PERSON_SENTENCE_SHARE * 100)}% of all sentences`, `more than ${MAX_PARAGRAPHS_PER_CITED_QUOTE} paragraphs`,
      ]) assert(LETTER_PROPORTION_RULE.includes(printed), `the rule prints “${printed}”`);
      assert(!LETTER_PROPORTION_RULE.includes('every 3 paragraphs') && !LETTER_PROPORTION_RULE.includes('completed action'),
        'the rule no longer states the superseded one-per-three allowance or the past-tense-only action');
      // One allowance, said once everywhere it is printed: the FLEXIBILITY rule used to tell the writer a one-sentence
      // paragraph "appears at most once" while the proportion rule allowed more, so a letter written to the stricter
      // sentence was cut for a hook the gate permits.
      const flexibility = /const COVER_LETTER_SENTENCE_FLEXIBILITY_RULE = ([^\n]+);\n/u.exec(localSource)?.[1] || '';
      assert(flexibility.includes("a letter has at most ' + MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE + ' of them") && !/appears at most once|at most once/u.test(flexibility),
        'the FLEXIBILITY rule states the standalone-sentence allowance from the constant the gate reads');
      const sources = fs.readdirSync(path.join(root, 'electron/ipc')).filter(name => name.endsWith('.js'))
        .map(name => [name, fs.readFileSync(path.join(root, 'electron/ipc', name), 'utf8')]);
      for (const [name, source] of sources) {
        assert(!/one-sentence paragraph[^.]{0,80}appears at most once/u.test(source), `${name}: no prompt tells the writer a one-sentence paragraph appears at most once`);
      }
      // The docs a writer or maintainer reads state the same allowance, floor and action reading.
      for (const doc of ['local_ai/LOCAL_AI_APPLICATION_ROUTINE.md', 'Job Application Design System/SKILL.md', 'Job Application Design System/STYLE.md']) {
        const body = fs.readFileSync(path.join(root, doc), 'utf8').replace(/\s+/gu, ' ');
        assert(/one-sentence paragraph is for emphasis, a one-line hook or a one-line closing, and a letter has at most two of them/u.test(body) && !/appears at most once/u.test(body),
          `${doc}: states the two-hook-and-closing allowance, not “at most once”`);
        assert(!/at least 30 words per paragraph/u.test(body) && (doc.includes('SKILL') || /at least 25 words per paragraph/u.test(body)), `${doc}: states the 25-word paragraph mean`);
      }
      const routine = fs.readFileSync(path.join(root, 'local_ai/LOCAL_AI_APPLICATION_ROUTINE.md'), 'utf8').replace(/\s+/gu, ' ');
      assert(routine.includes('states an action of your own in at least 40% of its paragraphs') && routine.includes('even after an adverb') && routine.includes('"I\'d", would, can, am, want, hope, believe, look and welcome state none'),
        'the routine states what counts as an action of your own, in the words the check prints');
      // The wording that made splitting the cheap repair is gone from the prompts and the check messages.
      for (const gone of ['split the paragraph or omit the weaker proof', 'Use as many sentences as the paragraph needs', 'use it when the thesis otherwise remains under-proved', 'Each paragraph uses as many sentences as clarity requires']) {
        assert(!localSource.includes(gone), `the prompt no longer says “${gone}”`);
      }
      assert(!checksSource.includes('split or remove') && !checksSource.includes('split or remove the weaker proof'), 'the check messages no longer offer splitting a paragraph');
      // The prompts say to move weaker proof to the résumé or omit it: asserted on the guidance a failed redundancy check prints.
      const cohesion = __localizedCoverLetterCorrectiveGuidanceForTests([{ id: 'resume-redundancy', passed: false, detail: 'x' }]);
      assert(cohesion.includes('[CL-COHESION]') && cohesion.includes('Evidence beyond those proofs stays in the résumé'), `a correction round for a redundancy defect says where the weaker proof goes (got ${cohesion.slice(0, 200)})`);
    },
  },
  {
    name: 'Letter proportion: the drafting twin and the completion gate derive the same per-paragraph quote bindings, so the twin is never stricter than the gate',
    run() {
      const letter = GOOD_LETTERS[1];
      const acceptedEvidence = [
        ...Object.entries(letter.quotes).map(([id, quote]) => ({ id, sourceId: 'career-data', quote })),
        { id: 'job-proof', sourceId: 'job-listing', quote: 'Strong spreadsheet and SQL skills required.' },
      ];
      // The twin reads the ids the response chose; a job-listing id and an unknown id bind no career-data quote.
      const rawParagraphs = letter.paragraphs.map(paragraph => ({ ...paragraph, evidenceIds: [...paragraph.evidenceIds, 'job-proof', 'no-such-id'] }));
      const twin = __pasteTwinParagraphCitationsForTests(rawParagraphs, acceptedEvidence);
      assert(JSON.stringify(twin) === JSON.stringify(citationsOf(letter)), 'the twin binds each paragraph to the career-data quotes its ids name, and to nothing else');
      // The gate reads the quotes assembly bound from those same ids.
      const raw = { qualityReview: { sourceGrounding: { coverLetterParagraphs: letter.paragraphs.map((paragraph, index) => ({ paragraph: paragraph.text, careerDataQuotes: citationsOf(letter)[index] })) } } };
      const completed = __completedParagraphCitationsForTests(raw, textsOf(letter));
      assert(JSON.stringify(completed) === JSON.stringify(twin), 'the gate derives the identical bindings from the assembled record');
      // And therefore the identical verdict, for a letter that leans on one quote and for one that does not.
      const leaning = letter.paragraphs.map(paragraph => ({ ...paragraph, evidenceIds: ['q1'] }));
      const leaningRaw = { qualityReview: { sourceGrounding: { coverLetterParagraphs: leaning.map(paragraph => ({ paragraph: paragraph.text, careerDataQuotes: [letter.quotes.q1] })) } } };
      for (const [label, twinCitations, gateCitations, expected] of [
        ['aligned', twin, completed, []],
        ['leaning on one quote', __pasteTwinParagraphCitationsForTests(leaning, acceptedEvidence), __completedParagraphCitationsForTests(leaningRaw, textsOf(letter)), ['quote-reuse']],
      ]) {
        assert(JSON.stringify(gatesOf(textsOf(letter), twinCitations)) === JSON.stringify(expected) && JSON.stringify(gatesOf(textsOf(letter), gateCitations)) === JSON.stringify(expected),
          `${label}: twin and gate report the same limits`);
      }
      // Anything that does not line up yields no bindings, which the check reads as "do not judge", never as a pass or a fail.
      assert(__completedParagraphCitationsForTests({}, textsOf(letter)) === null
        && __completedParagraphCitationsForTests(raw, textsOf(letter).slice(1)) === null
        && __completedParagraphCitationsForTests({ qualityReview: { sourceGrounding: { coverLetterParagraphs: 'x' } } }, textsOf(letter)) === null,
      'absent or misaligned grounding records yield null');
      const garbled = { qualityReview: { sourceGrounding: { coverLetterParagraphs: textsOf(letter).map(() => ({ careerDataQuotes: [7, null, 'kept quote'] })) } } };
      assert(JSON.stringify(__completedParagraphCitationsForTests(garbled, textsOf(letter))[0]) === JSON.stringify(['kept quote']), 'a non-string quote is ignored, not counted');
    },
  },
  {
    // The measured root of the atomised letter: the underfill rule joined the paragraph OBJECTS, so every paragraph
    // read as the two words “[object Object]”, whatever it said. Four real paragraphs measured 8 words and were rejected
    // for it, with a message that counted paragraphs, and the only reply that could satisfy it was more paragraphs.
    name: 'Letter underfill: the rule counts the words of each paragraph\'s text, so a real letter is not told it has two words per paragraph (and a run of tiny paragraphs is not the way to reach the floor)',
    run() {
      const proofOf = (words, tag) => ({ id: `proof-${tag}`, sourceId: 'career-data', quote: Array.from({ length: words }, (_, index) => `${tag}w${index}`).join(' ') });
      const rich = [proofOf(60, 'a'), proofOf(60, 'b'), proofOf(60, 'c')]; // 180 words of career proof: the rule applies
      const paragraphOf = (words, tag) => ({ id: tag, text: Array.from({ length: words }, (_, index) => `${tag}x${index}`).join(' '), evidenceIds: ['proof-a'] });
      const verdict = (paragraphs, evidence = rich) => __pasteCoverLetterUnderfillErrorsForTests({ paragraphs }, evidence);
      // Four real paragraphs of 60 words are a 240-word letter, whatever the objects print as.
      assert(verdict([0, 1, 2, 3].map(index => paragraphOf(60, `p${index}`))).length === 0, 'four 60-word paragraphs are not underfilled');
      // Two paragraphs are enough when their words are: the boundary is on words, not on paragraphs.
      assert(verdict([paragraphOf(45, 'x'), paragraphOf(45, 'y')]).length === 0, 'two paragraphs of 45 words reach the 90-word floor');
      const short = verdict([paragraphOf(45, 'x'), paragraphOf(44, 'y')]);
      assert(short.length === 1 && /has 2 body paragraph\(s\) and 89 words/u.test(short[0]),
        `89 words are reported as 89 words (got ${JSON.stringify(short)})`);
      // The count in the message is the letter's own: a one-paragraph letter of 30 words says 30, not 2.
      const one = verdict([paragraphOf(30, 'z')]);
      assert(one.length === 1 && /has 1 body paragraph\(s\) and 30 words/u.test(one[0]), `one paragraph of 30 words reports 30 words (got ${JSON.stringify(one)})`);
      // A run of one-word paragraphs is not a letter either: at two counted words per paragraph it would have reached the floor at half of it.
      const dust = count => verdict(Array.from({ length: count }, (_, index) => paragraphOf(1, `d${index}`)));
      const half = LETTER_PROPORTION_MIN_JUDGED_WORDS / 2;
      assert(dust(half - 1).length === 1 && dust(half).length === 1 && new RegExp(`has ${half} body paragraph\\(s\\) and ${half} words`, 'u').test(dust(half)[0]),
        `${half} one-word paragraphs are ${half} words: the paragraph that used to reach the floor by arithmetic no longer satisfies the rule`);
      // Mutation of the evidence: with a thin career (one item) the same short letter is not asked for more proof than exists.
      assert(verdict([paragraphOf(30, 'z')], [proofOf(60, 'a')]).length === 0,
        'a one-item career is not asked for more proof than it holds');
      assert(verdict([paragraphOf(30, 'z')], rich).length === 1 && verdict([paragraphOf(30, 'z')], [proofOf(10, 'a'), proofOf(10, 'b')]).length === 0,
        'the same letter is rejected against 180 words of career proof and accepted against 20: the rule only asks for what the career can support');
      // A caller that already flattened the letter to strings is read as itself.
      assert(__pasteCoverLetterUnderfillErrorsForTests({ paragraphs: [paragraphOf(45, 'x').text, paragraphOf(45, 'y').text] }, rich).length === 0, 'string paragraphs are read as their own words');
    },
  },
  {
    name: 'Impersonal sentences: a modal, present or irregular-verb sentence that broadens its cited work is rejected, and the same text is admitted once a quote states it (A/B/C, five domains)',
    run() {
      for (const letter of GOOD_LETTERS) {
        const tokens = identityTokensOf(letter);
        const base = [letter.quotes[letter.impersonal.quote]];
        for (const [qualifier, sentence] of Object.entries(letter.impersonal.broadened)) {
          const where = `${letter.key}/${qualifier}`;
          // Outside every reading that existed before the extension: no first-person word, no career-action verb.
          // Without this a fixture could be rejected by an older rule and say nothing about the new one.
          assert(!OLDER_READINGS.test(sentence), `${where}: the fixture avoids the older first-person and career-action cues (${sentence})`);
          const a = groundingVerdict(sentence, base, tokens);
          assert(a && FIXED_RULE[qualifier].test(a), `${where}: A rejects ${JSON.stringify(sentence)} for its qualifier (got ${a || 'acceptance'})`);
          const b = groundingVerdict(sentence, [...base, supportFor(letter, qualifier)], tokens);
          assert(b === '', `${where}: B (a quote now states it) admits the identical sentence (got ${b})`);
          const c = groundingVerdict(sentence, base, tokens);
          assert(c && FIXED_RULE[qualifier].test(c), `${where}: C (the quote removed again) rejects it again (got ${c || 'acceptance'})`);
        }
        // The grounded restatement of the same quote stays admissible: nothing is rejected merely for being impersonal.
        assert(!OLDER_READINGS.test(letter.impersonal.restated), `${letter.key}: the restatement fixture avoids the older cues`);
        const restated = groundingVerdict(letter.impersonal.restated, base, tokens);
        assert(restated === '', `${letter.key}: the grounded impersonal restatement is accepted (got ${restated})`);
      }
    },
  },
  {
    name: 'Impersonal sentences: a count, a name and a trailing clause the quote does not state are rejected in an impersonal sentence, and are admitted once the quote states them',
    run() {
      // Built from the clinic and logistics quotes: a changed count, a tool the quote never names, an appended clause.
      const [clinic, logistics] = GOOD_LETTERS;
      const cases = [
        { where: 'count', base: [logistics.quotes.q1], text: 'The on-time delivery rates for fifty carriers cover six months and feed the weekly rotation.', support: 'Compared on-time delivery rates for fifty carriers.', rule: /states the count/u },
        { where: 'name', base: [clinic.quotes.q1], text: 'The nightly pipelines in Python and SQL load appointment and billing records from three clinic scheduling systems into one reporting database in Snowflake.', support: 'Loaded the reporting database in Snowflake.', rule: /Snowflake/u },
      ];
      for (const entry of cases) {
        const a = groundingVerdict(entry.text, entry.base);
        assert(a && entry.rule.test(a), `${entry.where}: A rejects the impersonal sentence (got ${a || 'acceptance'})`);
        const b = groundingVerdict(entry.text, [...entry.base, entry.support]);
        assert(b === '', `${entry.where}: B admits it once a quote states the claim (got ${b})`);
        const c = groundingVerdict(entry.text, entry.base);
        assert(c && entry.rule.test(c), `${entry.where}: C rejects it again (got ${c || 'acceptance'})`);
      }
      // A percentage, a currency amount and a multiplier are figures: an impersonal restatement may not add one the
      // quotes do not state, and a quote that states it (same value, same kind) admits the identical sentence. Five domains.
      for (const letter of GOOD_LETTERS) {
        const tokens = identityTokensOf(letter);
        const base = [letter.quotes[letter.impersonal.quote]];
        for (const [figure, tail] of [['40%', 'and finished in 40% less time.'], ['$2M', 'and saved $2M across the year.'], ['3x', 'and ran at 3x the old speed.']]) {
          const support = supportFor(letter, null, tail);
          assert(!OLDER_READINGS.test(`${letter.impersonal.restated.slice(0, -1)} at ${figure} the usual pace.`), `${letter.key}/${figure}: the fixture avoids the older cues`);
          const sentence = `${letter.impersonal.restated.slice(0, -1)} at ${figure} the usual pace.`;
          const a = groundingVerdict(sentence, base, tokens);
          assert(/unsupported figure/u.test(a), `${letter.key}/${figure}: A rejects the impersonal sentence for its figure (got ${a || 'acceptance'})`);
          assert(groundingVerdict(sentence, [...base, support], tokens) === '', `${letter.key}/${figure}: B admits it once a quote states the figure`);
          assert(/unsupported figure/u.test(groundingVerdict(sentence, base, tokens)), `${letter.key}/${figure}: C rejects it again`);
        }
      }
    },
  },
  {
    name: 'Impersonal sentences: target-facing sentences that name posting terms, short sentences and sentences that are mostly new words are not pulled in (no false positives)',
    run() {
      assert(MIN_IMPERSONAL_RESTATEMENT_SHARED_TERMS === 4 && MIN_IMPERSONAL_RESTATEMENT_SOURCE_SHARE === 0.5, 'the restatement floors the fixtures sit either side of are 4 terms and half the sentence');
      for (const letter of GOOD_LETTERS) {
        const tokens = identityTokensOf(letter);
        const base = [letter.quotes[letter.impersonal.quote]];
        // A sentence about the employer's needs uses posting vocabulary, including words that would be
        // unsupported qualifiers if it were a claim about the cited work ("every day"), and stays outside.
        const facing = groundingVerdict(`${letter.impersonal.restated} ${letter.impersonal.targetFacing}`, base, tokens);
        assert(facing === '', `${letter.key}: a target-facing sentence naming posting terms is accepted beside a grounded restatement (got ${facing})`);
        // Mutation of the structural predicate: dilute a broadened restatement with enough new words that less
        // than half of it is the quote's, and it is no longer read as a claim about the cited work. Removing the
        // dilution reads it again.
        const broadened = letter.impersonal.broadened.daily;
        const diluted = `${broadened.slice(0, -1)} while your analysts, managers, auditors, supervisors and partners review outcomes elsewhere.`;
        assert(groundingVerdict(broadened, base, tokens) !== '', `${letter.key}: undiluted, the broadened sentence is read`);
        assert(groundingVerdict(diluted, base, tokens) === '', `${letter.key}: diluted below half of the sentence, it is not read as a restatement (the sentence's own terms are mostly new)`);
        assert(groundingVerdict(broadened, base, tokens) !== '', `${letter.key}: undiluted again, it is read again`);
        // The floor on shared terms: three of the quote's own nouns beside an unsupported qualifier are not a
        // restatement; a fourth makes it one, and the qualifier is read. (The nouns are the quote's last distinct
        // long words, which are none of them a career-action verb, so the older first-person and action readings
        // stay out of the way.)
        const nouns = [...new Set(base[0].toLowerCase().match(/[a-z]{5,}/gu))].slice(-4);
        const threeNouns = `The ${nouns.slice(1).join(' ')} stay daily.`;
        const fourNouns = `The ${nouns.join(' ')} stay daily.`;
        assert(groundingVerdict(`${letter.impersonal.restated} ${threeNouns}`, base, tokens) === '', `${letter.key}: a sentence sharing only three terms with the quote is not read as a restatement (${threeNouns})`);
        assert(/unsupported daily frequency/u.test(groundingVerdict(`${letter.impersonal.restated} ${fourNouns}`, base, tokens)),
          `${letter.key}: the fourth shared term makes it a restatement, and the qualifier is read (${fourNouns})`);
        assert(groundingVerdict(`${letter.impersonal.restated} ${fourNouns}`, [...base, supportFor(letter, 'daily', undefined, 60)], tokens) === '',
          `${letter.key}: and a quote that states the qualifier admits it`);
      }
      // The first-person gates the extension sits beside are unchanged.
      const clinic = GOOD_LETTERS[0];
      const quote = [clinic.quotes.q1];
      assert(groundingVerdict('I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database daily.', quote) !== '',
        'a first-person broadening is still rejected');
      assert(groundingVerdict('I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database.', quote) === '',
        'a grounded first-person sentence is still accepted');
    },
  },
  {
    // The shape checkDirectWelcomeClosing certifies (a one-line hook, two proofs, a one-line direct welcome) was rejected by
    // the first limits for two reasons at once: two standalone sentences against an allowance of one, and a paragraph mean
    // just under 30. Both limits moved; every inventory shape must still fail.
    name: 'Letter proportion: a one-line hook and a one-line direct welcome around two proofs pass the whole battery in three domains, and every cut of them into an inventory still fails (A/B/C)',
    run() {
      const earlierAllowance = Math.max(1, Math.floor(4 / SINGLE_SENTENCE_PARAGRAPH_SHARE_DIVISOR)); // the first limits' allowance for four paragraphs
      let belowEarlierMean = 0;
      for (const letter of HOOK_CLOSE_LETTERS) {
        const paragraphs = textsOf(letter);
        const citations = citationsOf(letter);
        const checks = battery(letter, paragraphs, citations);
        assert(checks.length === 55 && !failedIds(checks).length,
          `${letter.key}: the letter passes the whole editorial battery (failed=${failedIds(checks).map(id => `${id}: ${checks.find(check => check.id === id).detail}`).join(' | ')})`);
        const perParagraph = paragraphs.map(paragraph => sentences(paragraph).length);
        assert(perParagraph[0] === 1 && perParagraph.at(-1) === 1 && perParagraph.slice(1, -1).every(count => count >= 2), `${letter.key}: the shape is a one-line hook, proofs and a one-line closing (${perParagraph})`);
        const { metrics, violations } = analyzeLetterProportion(paragraphs, { citations });
        assert(!violations.length && metrics.quoteLimitJudged, `${letter.key}: within every proportion limit (${violations.map(violation => violation.gate)})`);
        assert(metrics.meanParagraphWords >= MIN_MEAN_PARAGRAPH_WORDS && metrics.meanParagraphWords < MIN_MEAN_PARAGRAPH_WORDS + 10,
          `${letter.key}: sits near the paragraph floor, not far above it (${metrics.meanParagraphWords.toFixed(1)})`);
        assert(perParagraph.filter(count => count === 1).length > earlierAllowance, `${letter.key}: two standalone sentences are more than the first limits allowed for four paragraphs`);
        if (metrics.meanParagraphWords < 30) belowEarlierMean += 1;
        for (const paragraph of letter.paragraphs) {
          const verdict = groundingVerdict(paragraph.text, paragraph.evidenceIds.map(id => letter.quotes[id]), identityTokensOf(letter));
          assert(verdict === '', `${letter.key}/${paragraph.id}: grounded (got ${verdict})`);
        }

        // A: a third standalone sentence (one more detail of the work, given its own line) is past the allowance.
        // B: the same sentence appended to the paragraph it belongs to is within it. C: split out again, it fails again.
        const extra = impersonal(24, `extra${letter.base}`); // long enough that only the standalone-sentence count is in play
        const withThird = [...paragraphs.slice(0, -1), extra, paragraphs.at(-1)];
        const appended = [...paragraphs.slice(0, -2), `${paragraphs.at(-2)} ${extra}`, paragraphs.at(-1)];
        expectGates(`${letter.key}/A`, withThird, ['single-sentence-paragraphs']);
        expectGates(`${letter.key}/B`, appended, []);
        expectGates(`${letter.key}/C`, withThird, ['single-sentence-paragraphs']);
        // The hook and the closing may be the standalone pair, but not a hook, a closing and a second hook.
        expectGates(`${letter.key}/second hook`, [paragraphs[0], impersonal(24, `second${letter.base}`), ...paragraphs.slice(1)], ['single-sentence-paragraphs']);

        // Every inventory cut of the same letter is still refused, whatever its allowance.
        for (const [variant, cut] of Object.entries(variantsOf(letter))) {
          const failed = failedIds(battery(letter, cut));
          assert(failed.includes('letter-proportion') && !checkLetterProportion(cut).passed, `${letter.key} / ${variant}: refused by letter-proportion (failed=${failed})`);
        }
      }
      assert(belowEarlierMean >= 1, 'at least one of the letters averages under the first limits\' floor of 30 words, so the lowered floor is what admits it');
    },
  },
  {
    // The action floor counts what the message promises, and the message says so. The three failures the first cue had were
    // all of one kind: the paragraph named by the message already satisfied the message's wording.
    name: 'Letter proportion: an adverb after I, a present tense and a verb outside the old list count as an action; would, can, am, want, hope, believe, look, welcome and “I’d” do not; the message names exactly this (A/B/C, three domains)',
    run() {
      const counts = [
        'I carefully fixed the form.', 'I quickly rebuilt the page.', 'We independently wrote the guide.', 'I closely reviewed the logs and rewrote the plan.', 'I also reviewed the claims.', 'I then led the effort.',
        'I review the weekly reports.', 'I lead a team of six.', 'We run the nightly job.', 'As the lead, I manage the team.', 'We currently operate two sites.', 'I apply the method every week.',
        'I cut the load time.', 'I rewrote the parser.', 'I caught the defect.', 'I co-led the rollout.', 'I often review the queue.',
        'I’ve built three tools.', 'We have kept the service up.', 'I had led the team.', 'I have written the runbook.', 'Last year I shipped the feature and we cut costs.',
      ];
      const doesNotCount = [
        'I would build it.', 'I can build it.', 'I will build it.', 'I could not attend.', 'I am a nurse.', 'We are a small team.', 'I was a lead.', 'I want to build it.', 'I hope to build it.',
        'I believe in the work.', 'I look forward to talking.', 'I welcome the chance to talk.', 'I really want this role.', 'I strongly believe it.', 'I very much appreciate your time.',
        'I’d built it.', 'We’d like to talk.', 'I’m excited.', 'I’ll bring the same care.', 'I don’t know yet.', 'I cannot attend.', 'I have experience with SQL.', 'I have a degree.',
        'I also want the role.', 'I just hope to talk.', 'I still believe in the work.', 'I truly welcome the chance.', 'I very much want to talk.', 'I quite like the product.', 'I often think about it.',
        'We have the skills.', 'I am writing to apply.', 'I thank you for your time.', 'I bring five years of practice.', 'I think it fits.', 'The tool built it.', 'My work built it.',
      ];
      for (const sentence of counts) assert(paragraphStatesFirstPersonAction(sentence), `counts as an action: ${sentence}`);
      for (const sentence of doesNotCount) assert(!paragraphStatesFirstPersonAction(sentence), `names no action: ${sentence}`);
      // The window: the verb may be the fourth word after the subject (three adverbs between), and no later.
      assert(paragraphStatesFirstPersonAction('I also really built the guide.') && paragraphStatesFirstPersonAction('I also really quickly built the guide.'),
        'a verb after two or three adverbs still counts');
      assert(!paragraphStatesFirstPersonAction('I also really quickly often built the guide.'), 'a verb after four adverbs is past the window');
      assert(paragraphStatesFirstPersonAction('I have also really built the guide.') && !paragraphStatesFirstPersonAction('I have also really quickly built the guide.'),
        'a helper uses one place of the same window');
      // After "have" or "had" only a participle states work done: a noun that ends in -ed is not one, an -ed participle is.
      for (const word of ['speed', 'exceed', 'proceed', 'succeed', 'need']) {
        assert(!paragraphStatesFirstPersonAction(`I have ${word} the weekly report.`) && !paragraphStatesFirstPersonAction(`We had ${word} the weekly report.`), `“I have ${word}” states no work done`);
      }
      for (const sentence of ['I have managed the dock.', 'I had trained eight new staff.', 'We have deployed the service.', 'I have exceeded the target.', 'I had succeeded in the pilot.', 'We have proceeded to the audit.', 'I have also rewritten the guide.']) {
        assert(paragraphStatesFirstPersonAction(sentence), `a participle after have/had counts: ${sentence}`);
      }
      assert(!paragraphStatesFirstPersonAction('I have experience managing the dock.') && !paragraphStatesFirstPersonAction('We have a team that trained staff.'), 'a holding after have/had is not an action, though a participle follows later');
      // Every example the message gives is true of the cue, and every word it names is on the closed list.
      for (const example of PROPORTION_ACTION_EXAMPLES) assert(paragraphStatesFirstPersonAction(`${example} the weekly report.`), `the message's example “${example}” counts`);
      for (const word of PROPORTION_NON_ACTION_EXAMPLES) {
        assert(PROPORTION_NON_ACTION_WORDS.has(word) && !paragraphStatesFirstPersonAction(`I ${word} the weekly report.`), `the message's non-example “${word}” names no action`);
      }
      assert(PROPORTION_ACTION_STATEMENT.includes('“I’d”') && !paragraphStatesFirstPersonAction('I’d built the weekly report.'), 'the message says “I’d” names none, and it does not');
      // The whole closed list: none of its words, after I, is an action (and the perfect "have" before a non-participle is not one).
      assert(PROPORTION_NON_ACTION_WORDS.size >= 150, `the closed list is the whole list (size ${PROPORTION_NON_ACTION_WORDS.size})`);
      for (const word of PROPORTION_NON_ACTION_WORDS) assert(!paragraphStatesFirstPersonAction(`I ${word} the weekly report.`), `“I ${word}” names no action`);
      // A word that is not a helper, a function word or an attitude verb is read as the verb of the sentence.
      for (const verb of ['audit', 'audited', 'draft', 'drafted', 'steward', 'wrangled', 'shipped', 'oversee', 'taught', 'mentor']) {
        assert(paragraphStatesFirstPersonAction(`I ${verb} the weekly report.`), `“I ${verb}” counts`);
      }
      // Only the subject starts a statement: an artifact's verb does not count, and neither does a verb two clauses later.
      assert(!paragraphStatesFirstPersonAction('The pipeline built the report that my team reads.'), 'a sentence about an artifact names no action of yours');

      // A/B/C in three domains: a three-paragraph letter needs two paragraphs that state an action.
      const domains = [
        { key: 'clinic data', object: 'the nightly import of appointment records' },
        { key: 'logistics', object: 'the weekly carrier ranking' },
        { key: 'school IT', object: 'the classroom projector guide' },
      ];
      for (const domain of domains) {
        const build = statements => statements.map((statement, index) => `${statement} ${impersonal(24, `${domain.key.replace(/\W/gu, '')}${index}`)}`);
        const noAction = [`I would build ${domain.object} and I can keep it current for you.`, `I want to build ${domain.object}, and I hope to keep it current.`, `I believe in ${domain.object} and I welcome the chance to talk about it.`];
        const withAction = [`I carefully rebuilt ${domain.object} and kept it current for the team.`, `I review ${domain.object} every week and lead the changes to it.`, noAction[2]];
        const aLetter = build(noAction);
        const bLetter = build(withAction);
        expectGates(`${domain.key}/A`, aLetter, ['first-person-action-paragraphs']);
        expectGates(`${domain.key}/B`, bLetter, []);
        expectGates(`${domain.key}/C`, aLetter, ['first-person-action-paragraphs']);
        // The agency check keeps its own, narrower cue: a letter whose only actions are an adverb form and a present tense
        // passes the proportion floor and is still told by candidate-agency that no paragraph states a completed action.
        assert(!checkCandidateAgency(bLetter).passed, `${domain.key}: candidate-agency still reads only its own past-tense cue`);
        // The message for the A letter names the exact forms that would satisfy it, and the B letter's own forms are among them.
        const message = checkLetterProportion(aLetter).detail;
        assert(message.includes(PROPORTION_ACTION_STATEMENT) && message.includes('“I carefully fixed”') && message.includes('“I review”'), `${domain.key}: the message states what counts (${message})`);
      }
    },
  },
  {
    name: 'Sentence counting: a title, an initialism, a degree, a place and a section number do not end a sentence, and a real sentence end after an abbreviation still does (A/B/C, three domains)',
    run() {
      const one = [
        // healthcare
        'I reported to Dr. Rao and Mr. Chen at Al Noor Clinics L.L.C. in Dubai, U.A.E. for two years.',
        'I ran the outpatient unit in St. Louis with Prof. Okafor and the clinic board.',
        // finance
        'I earned a B.Com. (Hons.) from the University of Delhi and qualified as a Chartered Accountant (C.A.) in 2015.',
        'I audited the U.S. Treasury filings for three clients of Granite Peak Inc. in Toronto.',
        'I applied the rule in Sec. 4.2 of the policy to every invoice.',
        // engineering
        'I earned a Ph.D. in Civil Engineering from E.T.H. Zurich, and I worked as a P.E. in St. Louis for two employers.',
        'I completed an M.Sc. at the London School of Economics (L.S.E.) and then worked at Deloitte & Touche LLP, Inc. in Toronto, Ont. for two years.',
        'I led the No. 2 plant, which employed 1,200 people at 4.5 Ave. and ran 3 shifts.',
        'I started on Aug. 14 and finished the audit by Oct. 2.',
        'I met J. Smith at the review and agreed the scope with the client.',
      ];
      for (const text of one) assert(sentences(text).length === 1, `one sentence, not ${sentences(text).length}: ${JSON.stringify(sentences(text))}`);
      // A: the abbreviation continues into a name (one sentence). B: the same abbreviation followed by a word that opens a sentence is a sentence end (two). C: restored.
      const triples = [
        ['healthcare', 'I worked with the clinic board in the U.S. Navy hospital system.', 'I worked with the clinic board in the U.S. We then closed the books.'],
        // A company suffix closes the name it ends (abbreviationBoundary): what continues the sentence is lowercase, a figure, a bracket or another suffix, never a capitalized word.
        ['finance', 'I audited the books of Northgate Co. Ltd. for three clients.', 'I audited the books of Northgate Inc. Our team shipped weekly.'],
        ['engineering', 'I trained at E.T.H. Zurich before joining the lab.', 'I trained at E.T.H. Then I joined the lab.'],
        ['civil', 'I answered to Dr. Rao across the whole project.', 'I answered to the director, Dr. I then left the project.'],
      ];
      for (const [domain, joined, split] of triples) {
        assert(sentences(joined).length === 1, `${domain}/A: ${JSON.stringify(sentences(joined))}`);
        assert(sentences(split).length === 2, `${domain}/B: ${JSON.stringify(sentences(split))}`);
        assert(sentences(joined).length === 1, `${domain}/C: ${JSON.stringify(sentences(joined))}`);
      }
      // An ordinary full stop is a sentence end whatever the next word is, and a month abbreviation joins only a number.
      assert(sentences('I finished the audit. Rao signed it. Chen filed it.').length === 3, 'a name after a full stop that is not an abbreviation starts a sentence');
      assert(sentences('I started in Aug. Then I left. It was J. Smith who hired me.').length === 3, 'a month with a word after it, and an initial before a name, are read for what they are');
      assert(sentences('Plan B. We never needed it.').length === 2, 'an initial before an opener is a sentence end');
      assert(sentences('I joined Acme Inc. In that role I ran two teams.').length === 2, 'a company suffix before an opener is a sentence end');
      assert(sentences('I joined Acme Inc. Previously, I ran two teams.').length === 2, 'a company suffix before “Previously” is a sentence end');
      // A currency symbol is part of the amount after it, so an abbreviation before an amount continues; a title after a company suffix opens a new name.
      assert(sentences('I saved approx. $2M across the year. It mattered.').length === 2 && sentences('We spent approx. $40k on tools and licences.').length === 1,
        'an abbreviation before a dollar amount does not end a sentence');
      assert(sentences('I managed a budget of approx. €3M for the team.').length === 1 && sentences('I managed a budget of approx. £3M for the team.').length === 1, 'nor before a euro or pound amount');
      assert(sentences('I worked at Acme Corp. Mr. Singh hired me.').length === 2 && sentences('I worked at Acme Corp. Singh hired me.').length === 2
        && sentences('I worked at Acme Corp. Ltd. in Toronto.').length === 1 && sentences('I worked at Acme Corp. (Toronto) for two years.').length === 1,
      'a title or a capitalized word after a company suffix opens a new sentence (the boundary is inferred); another suffix or a bracket continues the name');
      assert(sentences('I worked with Mr. Singh at Acme Corp. Dr. Rao hired me.').length === 2, 'the same holds for “Dr.”');
      // The merge is symmetrical for the ICU-less fallback: the same guard runs over its segments.
      const credentialParagraph = 'I earned a B.Com. (Hons.) from the University of Delhi. I qualified as a Chartered Accountant (C.A.) with the Institute of Chartered Accountants of India. I reported to Dr. Rao and Mr. Chen at Al Noor Trading L.L.C. in Dubai, U.A.E. We closed the books on the 3rd working day. I worked in St. Louis for two employers.';
      const naive = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(credentialParagraph)).length;
      assert(sentences(credentialParagraph).length === 5 && naive > MAX_PARAGRAPH_SENTENCES, `the raw segmenter over-counts this paragraph (${naive}) and the guarded count does not (${sentences(credentialParagraph).length})`);
      // The count is what the proportion check reads: five real sentences are within the six-sentence ceiling, nine invented ones are not.
      const withCredentials = [...baseline(3), credentialParagraph];
      assert(!gatesOf(withCredentials).includes('paragraph-sentences'), `an abbreviation-heavy paragraph of five sentences is within the ceiling (gates=${gatesOf(withCredentials)})`);
      const overSplit = credentialParagraph.replace(/B\.Com\. \(Hons\.\)/u, 'degree. (Hons)').replace(/Dr\. Rao and Mr\. Chen/u, 'Dr. Rao. Mr. Chen').replace(/St\. Louis/u, 'Saint. Louis');
      assert(gatesOf([...baseline(3), overSplit]).includes('paragraph-sentences'), 'the same paragraph with its periods made real sentence ends is over the ceiling');
    },
  },
  {
    // A fact the posting states is the posting's, not the candidate's. A sentence about the candidate's own cited work that carries a
    // posting name, count or figure attributes it to the candidate, so only a sentence ADDRESSED TO THE TARGET (second person, the
    // employer's name, "this role") may use the posting's names, and its counts only for the same counted noun and never against a
    // quote that counts that noun differently. A figure is never free. A sentence about the candidate gets nothing.
    name: 'Impersonal sentences: a posting name or count is free only in a sentence addressed to the target, a count only for the same noun and never against a cited quote, a figure never, and a sentence about the candidate gets none (A/B/C, three domains)',
    run() {
      const [clinic, logistics, , , nonprofit] = GOOD_LETTERS;
      const cases = [
        {
          letter: clinic, name: 'Lumen Clinical Analytics', otherName: 'Harbor Data Group',
          stem: 'The nightly pipelines load appointment and billing records from three clinic scheduling systems into one reporting database',
          employer: name => `Data Platform Engineer at ${name}. You will own the reporting warehouse.`,
          tool: { name: 'Snowflake', otherName: 'Teradata', posting: tool => `You will run our ${tool} warehouse.` },
          count: { phrase: 'for the four regions your team serves', bare: 'for the four regions', posting: (count, noun) => `The platform serves ${count} ${noun} and the finance team.`, noun: 'regions', otherNoun: 'offices', otherCount: 'seven' },
          conflict: { sentence: 'The nightly pipelines load appointment and billing records from four clinic scheduling systems into one reporting database, the setup your team runs', posting: 'Your team runs four clinic scheduling systems.' },
          figure: { sentence: 'at 99.9% reliability, the standard your team sets', figureText: '99.9%', otherFigure: '98%', posting: figure => `Reports must meet ${figure} availability.` },
        },
        {
          letter: logistics, name: 'Redline Distribution', otherName: 'Summit Freight',
          stem: 'The on-time delivery rates for twelve carriers cover six months and feed the weekly rotation',
          employer: name => `Logistics Analyst, ${name}. You will analyze carrier performance.`,
          tool: { name: 'Tableau', otherName: 'Looker', posting: tool => `Our analysts present carrier scorecards in ${tool}.` },
          count: { phrase: 'across the five centers your team runs', bare: 'across the five centers', posting: (count, noun) => `The work spans ${count} distribution ${noun} and the carriers that serve them.`, noun: 'centers', otherNoun: 'crews', otherCount: 'nine' },
          conflict: { sentence: 'The on-time delivery rates for fifteen carriers cover six months and feed the weekly rotation your team runs', posting: 'Your team works with fifteen carriers.' },
          figure: { sentence: 'at 95% accuracy, the level your team expects', figureText: '95%', otherFigure: '90%', posting: figure => `Reports must reach ${figure} accuracy.` },
        },
        {
          letter: nonprofit, name: 'Community Housing Trust', otherName: 'Riverbend Foundation',
          stem: 'The shared workbook holds eleven grant budgets and spending reports for each funder',
          employer: name => `Grants Finance Analyst, ${name}. You will track restricted grant budgets.`,
          tool: { name: 'Airtable', otherName: 'Notion', posting: tool => `Program managers submit receipts in ${tool}.` },
          count: { phrase: 'across the six programs your team runs', bare: 'across the six programs', posting: (count, noun) => `The trust runs ${count} ${noun} and reports to many funders.`, noun: 'programs', otherNoun: 'buildings', otherCount: 'eight' },
          conflict: { sentence: 'The shared workbook holds twelve grant budgets and spending reports for each funder your team serves', posting: 'Your team manages twelve grant budgets.' },
          figure: { sentence: 'with 100% receipts, the coverage your team requires', figureText: '100%', otherFigure: '80%', posting: figure => `Every program must show ${figure} receipt coverage.` },
        },
      ];
      for (const entry of cases) {
        const tokens = identityTokensOf(entry.letter);
        const base = [entry.letter.quotes[entry.letter.impersonal.quote]];
        const verdict = (text, posting = '') => groundingVerdict(text, base, tokens, { postingText: posting, targetCompany: entry.name });
        const where = entry.letter.key;
        // The fixtures sit outside every older reading, so the posting exemption is the only thing under test.
        for (const text of [entry.stem, entry.count.phrase, entry.conflict.sentence, entry.figure.sentence]) {
          assert(!OLDER_READINGS.test(text), `${where}: the fixtures avoid the older first-person and career-action cues (${text})`);
        }

        // NAME, by the employer's name. A: no posting names it. B: the posting names it. C: the posting names another employer.
        const employed = `${entry.stem} at ${entry.name}.`;
        assert(/names “/u.test(verdict(employed)) && /names “/u.test(verdict(employed, entry.employer(entry.otherName))), `${where}/employer A: rejected without the posting`);
        assert(verdict(employed, entry.employer(entry.name)) === '', `${where}/employer B: admitted once the posting names it (got ${verdict(employed, entry.employer(entry.name))})`);
        assert(/names “/u.test(verdict(employed, entry.employer(entry.otherName))), `${where}/employer C: rejected again`);

        // NAME, a tool the posting uses. The marker decides: with "your team", "this role" or the employer's name it is free; without one it is not.
        const withTool = marker => `${entry.stem} in ${entry.tool.name}${marker}.`;
        const targeted = [withTool(' for your team'), withTool(' for this role'), withTool(` at ${entry.name}`)];
        const untargeted = withTool('');
        assert(targeted.every(text => !OLDER_READINGS.test(text)) && !OLDER_READINGS.test(untargeted), `${where}: the tool fixtures avoid the older cues`);
        const toolPosting = `${entry.employer(entry.name)} ${entry.tool.posting(entry.tool.name)}`;
        assert(/names “/u.test(verdict(untargeted)) && /names “/u.test(verdict(untargeted, toolPosting)),
          `${where}/tool A: a posting name in a sentence that addresses nobody is rejected even though the posting states it (got ${verdict(untargeted, toolPosting) || 'acceptance'})`);
        for (const text of targeted) {
          assert(verdict(text, toolPosting) === '', `${where}/tool B: admitted once the posting names it and the sentence addresses the target (${text}; got ${verdict(text, toolPosting)})`);
          assert(/names “/u.test(verdict(text, `${entry.employer(entry.name)} ${entry.tool.posting(entry.tool.otherName)}`)), `${where}/tool C: rejected when the posting does not name it (${text})`);
        }

        // COUNT. Same noun: free in a sentence addressed to the target. A different noun, a different value, and a sentence that addresses nobody: not.
        const counted = `${entry.stem} ${entry.count.phrase}.`;
        const { count } = entry;
        assert(/states the count “/u.test(verdict(counted)) && /states the count “/u.test(verdict(counted, count.posting(count.otherCount, count.noun))), `${where}/count A: rejected without a posting count for it`);
        assert(verdict(counted, count.posting(count.bare.match(/the (\w+)/u)[1], count.noun)) === '', `${where}/count B: admitted once the posting counts the same noun (got ${verdict(counted, count.posting(count.bare.match(/the (\w+)/u)[1], count.noun))})`);
        assert(/states the count “/u.test(verdict(counted, count.posting(count.bare.match(/the (\w+)/u)[1], count.otherNoun))), `${where}/count C: a posting count for another noun does not support it`);
        assert(/states the count “/u.test(verdict(`${entry.stem} ${count.bare}.`, count.posting(count.bare.match(/the (\w+)/u)[1], count.noun))), `${where}/count D: a sentence that addresses nobody gets no posting count`);
        // The cited work wins: a quote that counts that noun differently is never overruled by the posting.
        assert(/states the count “/u.test(verdict(`${entry.conflict.sentence}.`, entry.conflict.posting)), `${where}/count E: the posting cannot override a count the cited quote states for that noun (got ${verdict(`${entry.conflict.sentence}.`, entry.conflict.posting) || 'acceptance'})`);

        // FIGURE: never free, whoever the sentence addresses and whatever the posting states.
        const figured = `${entry.stem} ${entry.figure.sentence}.`;
        assert(/unsupported figure/u.test(verdict(figured, entry.figure.posting(entry.figure.figureText))) && /unsupported figure/u.test(verdict(figured, entry.figure.posting(entry.figure.otherFigure))),
          `${where}/figure: a figure the posting states is the posting's, so it is rejected (got ${verdict(figured, entry.figure.posting(entry.figure.figureText)) || 'acceptance'})`);

        // A name neither the quote nor the posting states is rejected beside a posting that names others.
        assert(/names “/u.test(verdict(`${entry.stem} at Zephyr Dynamics.`, entry.employer(entry.name))), `${where}: a name neither the quote nor the posting states is rejected`);
        // The posting never supports a qualifier: only a quote does.
        const broadened = entry.letter.impersonal.broadened.daily;
        assert(/unsupported daily frequency/u.test(verdict(broadened, `${entry.employer(entry.name)} The work runs daily.`)), `${where}: a qualifier the posting states still has to be stated by a quote`);
        // A sentence about the candidate keeps exactly the support it had: the posting does not free its names or counts, whoever it addresses.
        const candidate = `I built ${entry.stem.replace(/^The /u, 'the ')} in ${entry.tool.name}, the way your team does.`;
        assert(/names “/u.test(verdict(candidate, toolPosting)), `${where}: a first-person sentence naming a posting-only name is still rejected (${candidate})`);
        const implicit = `Built ${entry.stem.replace(/^The /u, 'the ')} in ${entry.tool.name} for your team.`;
        assert(/names “/u.test(verdict(implicit, toolPosting)), `${where}: an implicit-subject career action naming a posting-only name is still rejected (${implicit})`);
      }
      // The three markers, directly: second person, the employer's name (with or without its legal suffix) and "this role".
      for (const text of ['Your team runs the warehouse.', 'It is the role this role fills.', 'The pipelines suit this position well.']) {
        assert(sentenceAddressesTarget(text, ''), `a sentence that says “you”, “your” or “this role/position” addresses the target (${text})`);
      }
      assert(sentenceAddressesTarget('The pipelines load records at Lumen Clinical Analytics.', 'Lumen Clinical Analytics, Inc.') && sentenceAddressesTarget('The pipelines load records at Lumen Clinical Analytics.', 'Lumen Clinical Analytics'),
        'the employer\'s name addresses the target, with or without its legal suffix');
      assert(!sentenceAddressesTarget('The pipelines load records at Harbor Data Group.', 'Lumen Clinical Analytics') && !sentenceAddressesTarget('The pipelines load records into one database.', 'Lumen Clinical Analytics')
        && !sentenceAddressesTarget('The pipelines load records at Lumen Clinical Analytics.', ''), 'another employer, no marker, and no known employer address nobody');
    },
  },
  {
    // A paragraph cites up to four quotes. Judging every sentence against all of them let a sentence borrow a qualifier, a count
    // or a name from a quote cited beside it for other work, which the proportion repair (merge paragraphs) makes more likely.
    name: 'Cover-letter grounding: each sentence is judged against the cited quotes that are about its own work, so a quote cited beside it cannot lend it a qualifier, count or name (A/B/C, four domains)',
    run() {
      const cases = [
        {
          key: 'clinic qualifier', own: GOOD_LETTERS[0].quotes.q1,
          sentence: 'I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database organization-wide.',
          other: 'Rolled the patient survey dashboard out across the organization for the front office.',
          about: 'Built nightly pipelines in Python and SQL that loaded appointment and billing records, and rolled them out across the organization for the front office.',
          rule: /unsupported organization-wide scope/u,
        },
        {
          key: 'logistics qualifier', own: GOOD_LETTERS[1].quotes.q1,
          sentence: 'I compared on-time delivery rates for twelve carriers over six months and recommended dropping the two slowest carriers from the weekly rotation daily.',
          other: 'Reviewed the dock schedule every day for the receiving supervisor.',
          about: 'Compared on-time delivery rates for twelve carriers over six months, and recommended dropping the two slowest carriers from the weekly rotation every day.',
          rule: /unsupported daily frequency/u,
        },
        {
          key: 'nonprofit qualifier', own: GOOD_LETTERS[4].quotes.q1,
          sentence: 'I tracked eleven restricted grant budgets in one shared workbook and prepared monthly spending reports for each funder weekly.',
          other: 'Closed the books each week for the program managers.',
          about: 'Tracked eleven restricted grant budgets in one shared workbook and reported on them each week.',
          rule: /unsupported weekly frequency/u,
        },
        {
          key: 'school count', own: GOOD_LETTERS[2].quotes.q1,
          sentence: 'I managed a fleet of Chromebooks and tablets for two schools, including enrollment in the management console, repairs, and a loaner program for 400 devices.',
          other: 'Handled the help desk queue for 400 devices across the district.',
          about: 'Managed a fleet of Chromebooks and tablets for two schools, and a loaner program of 400 devices.',
          rule: /states the count “400”/u,
        },
        {
          key: 'clinic name', own: GOOD_LETTERS[0].quotes.q1,
          sentence: 'I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database in Snowflake.',
          other: 'Administered the Snowflake warehouse for the analytics team.',
          about: 'Built nightly pipelines in Python and SQL that loaded appointment and billing records into the Snowflake warehouse.',
          rule: /Snowflake/u,
        },
        {
          // Two words of a name are two shared terms; they are the claim, not evidence that the quote is about the same work.
          key: 'clinic two-word name', own: GOOD_LETTERS[0].quotes.q1,
          sentence: 'I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database on the Northwind Platform.',
          other: 'Administered the Northwind Platform for the analytics team.',
          about: 'Built nightly pipelines in Python and SQL that loaded appointment and billing records into the Northwind Platform.',
          rule: /Northwind Platform/u,
        },
        {
          // Two words of a scale term likewise: "enterprise-scale" is two terms in a quote about a different warehouse.
          key: 'clinic scale', own: GOOD_LETTERS[0].quotes.q1,
          sentence: 'I loaded appointment and billing records from three clinic scheduling systems into one enterprise-scale reporting database.',
          other: 'Maintained an enterprise-scale finance warehouse for the audit team.',
          about: 'Loaded appointment and billing records from three clinic scheduling systems into one enterprise-scale reporting database.',
          rule: /unsupported large-scale status/u,
        },
        {
          // A figure's digits are two shared terms (99 and 9), and a quote about another site shares them.
          key: 'clinic figure', own: GOOD_LETTERS[0].quotes.q1,
          sentence: 'I built nightly pipelines in Python and SQL that loaded appointment and billing records from three clinic scheduling systems into one reporting database at 99.9% availability.',
          other: 'Kept the patient portal at 99.9% availability for the front office.',
          about: 'Built nightly pipelines in Python and SQL that loaded appointment and billing records into the reporting database at 99.9% availability.',
          rule: /unsupported figure/u,
        },
      ];
      for (const entry of cases) {
        const tokens = [];
        // A: the quote it is about does not state the claim.
        const a = groundingVerdict(entry.sentence, [entry.own], tokens);
        assert(a && entry.rule.test(a), `${entry.key}/A: rejected against its own quote (got ${a || 'acceptance'})`);
        // B: a quote cited beside it for OTHER work states the claim; it is no longer borrowed.
        const b = groundingVerdict(entry.sentence, [entry.own, entry.other], tokens);
        assert(b && entry.rule.test(b), `${entry.key}/B: a quote about other work cannot support it (got ${b || 'acceptance'})`);
        // C: a quote about the SAME work states it: admitted.
        const c = groundingVerdict(entry.sentence, [entry.own, entry.about], tokens);
        assert(c === '', `${entry.key}/C: a quote about the same work supports it (got ${c})`);
        // D: that quote removed again: rejected again.
        const d = groundingVerdict(entry.sentence, [entry.own, entry.other], tokens);
        assert(d && entry.rule.test(d), `${entry.key}/D: rejected again (got ${d || 'acceptance'})`);
        // The order the quotes are cited in changes nothing.
        assert(groundingVerdict(entry.sentence, [entry.about, entry.own], tokens) === '', `${entry.key}: citation order does not matter`);
      }
      // The reviewer's probe, verbatim: the second quote states the qualifier in the sentence's own words, and is about other work.
      const probeOwn = 'Built a nightly import job that loads clinic appointment records into the reporting database.';
      const probeOther = 'Led an organization-wide rollout of the shared scheduling dashboard to all regional offices.';
      const probeSentence = 'I built a nightly import job that loads clinic appointment records into the reporting database organization-wide.';
      assert(/unsupported organization-wide scope/u.test(groundingVerdict(probeSentence, [probeOwn], [])) && /unsupported organization-wide scope/u.test(groundingVerdict(probeSentence, [probeOwn, probeOther], [])),
        'a quote cited beside the sentence for other work, stating the qualifier in the sentence\'s own words, lends it nothing');
      assert(groundingVerdict(`${probeSentence.replace(' organization-wide', '')} I also led the scheduling dashboard rollout.`, [probeOwn, probeOther], []) === '',
        'the same two quotes merged into one paragraph, each sentence about its own work, are accepted');
      // A sentence made only of its claim words has nothing else to be about, so it is judged as before, against every cited quote;
      // a qualifier no cited quote states is still rejected.
      const bare = 'I ran the nightly import job for the clinic office. I led it organization-wide.';
      assert(groundingVerdict(bare, ['Ran the nightly import job for the clinic office.', 'Led an organization-wide rollout of the shared scheduling dashboard.'], []) === '',
        'a sentence of only claim words is judged against every cited quote, and one of them states the qualifier');
      assert(groundingVerdict(bare, ['Ran the nightly import job for the clinic office.', 'Rolled out the shared scheduling dashboard.'], []) !== '',
        'and is rejected when none does');
      // The matrix of letters that merge two proofs legitimately: each sentence is supported by the quote it is about, and the merged
      // paragraph is accepted. Eight letters (the five good ones and the three hook-and-close ones), the first two proof paragraphs of each.
      let merged = 0;
      for (const letter of [...GOOD_LETTERS, ...HOOK_CLOSE_LETTERS]) {
        const proofs = letter.paragraphs.filter(paragraph => paragraph.evidenceIds.length === 1 && sentences(paragraph.text).length >= 2);
        const [first, second] = proofs.filter((paragraph, index, all) => index === 0 || paragraph.evidenceIds[0] !== all[0].evidenceIds[0]);
        if (!first || !second) continue;
        const text = `${first.text} ${second.text}`;
        const quotes = [letter.quotes[first.evidenceIds[0]], letter.quotes[second.evidenceIds[0]]];
        const verdict = groundingVerdict(text, quotes, identityTokensOf(letter));
        assert(verdict === '', `${letter.key}: two proofs merged into one paragraph, each supported by its own quote, are accepted (got ${verdict})`);
        // And the same merge with the quotes swapped between the proofs' qualifiers is a pooling the new reading refuses only where a claim needs it.
        merged += 1;
      }
      assert(merged >= 6, `at least six letters were merged (${merged})`);
      // A sentence whose terms are spread one per quote reaches no quote's floor: the quotes it shares the most with stand in,
      // and a quote it shares nothing with still cannot lend it a qualifier.
      const spread = 'I tracked and prepared them weekly.';
      const first = 'Tracked eleven restricted grant budgets in one shared workbook.';
      const second = 'Prepared monthly spending reports for the funders.';
      const unrelated = 'Closed the books each week for the program managers.';
      assert(groundingVerdict(spread, [first, second], []) !== '' && /unsupported weekly frequency/u.test(groundingVerdict(spread, [first, second], [])), 'a qualifier no quote states is rejected for a sentence spread across two quotes');
      assert(/unsupported weekly frequency/u.test(groundingVerdict(spread, [first, second, unrelated], [])),
        'a third quote the sentence shares nothing with cannot lend it the qualifier, though the sentence reaches no single quote\'s floor');
      assert(groundingVerdict(spread, [first, second, 'Tracked the weekly close each week for the program managers.'], []) === '',
        'a quote the sentence shares a term with, and that states the qualifier, does');
      // Pooling that is still legitimate: one quote that states the work and a second that states the same work again.
      const clinic = GOOD_LETTERS[0];
      assert(groundingVerdict(clinic.paragraphs[0].text, [clinic.quotes.q1, clinic.quotes.q1.replace('Built', 'Rebuilt')], identityTokensOf(clinic)) === '', 'two quotes about the same work both support a sentence about it');
    },
  },
  {
    // The corrective rows were checked by grepping the source for the row's id. A row whose pattern never matches its check, or whose
    // rule text is empty, passed that.
    name: 'Letter proportion: a correction round for a failed letter-proportion check prints the proportion rule with its numbers, only that check pulls it in, and a passing check prints none',
    run() {
      const letter = GOOD_LETTERS[0];
      const atomised = variantsOf(letter)['forty impersonal paragraphs appended'];
      const checks = battery(letter, atomised);
      assert(failedIds(checks).includes('letter-proportion'), 'the atomised letter fails the check');
      const guidance = __localizedCoverLetterCorrectiveGuidanceForTests(checks);
      assert(guidance.startsWith('Repair only these failed cover-letter rules:') && guidance.includes(`[CL-PROPORTION] For the cover letter, ${LETTER_PROPORTION_RULE}.`),
        `a correction round prints the proportion rule from the constants (got ${guidance.slice(0, 200)})`);
      assert(guidance.includes('Repair a proportion defect by merging, appending or deleting paragraphs, never by splitting one'), 'and the operation that repairs it');
      assert(guidance.includes(`at most ${MAX_LETTER_BODY_PARAGRAPHS} body paragraphs`) && guidance.includes(`at least ${MIN_MEAN_PARAGRAPH_WORDS} words per paragraph`)
        && guidance.includes(`at most ${MIN_STANDALONE_SENTENCE_PARAGRAPH_ALLOWANCE} standalone one-sentence paragraphs`), 'with the limits the gate reads');
      // Alone, the check selects exactly its own row.
      const alone = __localizedCoverLetterCorrectiveGuidanceForTests([{ id: 'letter-proportion', passed: false, detail: 'x' }]);
      assert(alone.startsWith('Repair only these failed cover-letter rules: [CL-PROPORTION] ') && (alone.match(/\[CL-/gu) || []).length === 1, `only its own row is printed (got ${alone.slice(0, 160)})`);
      assert(!alone.includes('Repair only the reported cover-letter check IDs'), 'the generic fallback for an unmatched check id is not what a failed proportion check gets');
      // A neighbouring check selects its own row and not this one; a check that passed selects nothing.
      const agency = __localizedCoverLetterCorrectiveGuidanceForTests([{ id: 'candidate-agency', passed: false, detail: 'x' }]);
      assert(agency.includes('[CL-AGENCY]') && !agency.includes('[CL-PROPORTION]'), 'a failed agency check prints the agency row alone');
      const passing = __localizedCoverLetterCorrectiveGuidanceForTests([{ id: 'letter-proportion', passed: true, detail: 'x' }]);
      assert(passing.startsWith('No cover-letter editorial rule failed host validation') && !passing.includes('[CL-PROPORTION]'), 'a passing proportion check prints no corrective rule');
      const both = __localizedCoverLetterCorrectiveGuidanceForTests([{ id: 'letter-proportion', passed: false, detail: 'x' }, { id: 'candidate-agency', passed: false, detail: 'x' }]);
      assert(both.includes('[CL-PROPORTION]') && both.includes('[CL-AGENCY]'), 'two failures print both rows');
    },
  },
];
