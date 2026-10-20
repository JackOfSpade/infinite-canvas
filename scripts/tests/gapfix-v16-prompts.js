// The opening of a cover letter, run through the whole deterministic battery.
//
// A letter that names the role and the employer from the job record and states the
// closest capability from the candidate's side must pass every check
// (evaluateCoverLetterChecks), so no writer is sent into a rejection by following
// that shape; an opening that merely announces the application is still rejected.
// The writer guidance this file used to pin (cover-letter rules, résumé guidance,
// the unsupported-needs context) was deleted with the staged writer prompts.
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields. Nothing in
// production names any of them.
import { assert } from './testHelpers.js';
import { evaluateCoverLetterChecks } from '../../electron/ipc/coverLetterChecks.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
// Each domain is an employer, a title, a posting, and a letter written to the shape above.
const DOMAINS = Object.freeze([
  {
    key: 'freight dispatch', employer: 'Meridian Freight', title: 'Dispatch Planner',
    listing: ['Dispatch planner role focused on reliable pallet routing.',
      'The team schedules loading docks and supports drivers who depend on those schedules every working day.',
      'We value careful judgement, clear written handoffs, steady planning habits, and a willingness to learn the depot network in depth.',
      'You will work with warehouse partners to keep the delivery network dependable for the customers who rely on it each week.'].join(' '),
    // A letter written to the guidance: the opening names role and employer, two proofs add the reason or outcome, the close ties one item to the role.
    guided: [
      'For the Dispatch Planner role at Meridian Freight, the closest capability my work shows is keeping depot loading schedules dependable for the drivers who read them.',
      'I rebuilt the dock schedule at a regional depot after drivers lost hours waiting at full bays. The change moved morning arrivals into staggered slots, and waiting time dropped within a month.',
      'I wrote the handoff sheet that night supervisors used when a route changed. Because the sheet listed the reason for each change, drivers stopped phoning the office for clarification.',
    ],
    closing: 'My dock scheduling work could support your depot network and the customers who rely on it.',
  },
  {
    key: 'clinic scheduling', employer: 'Harborview Clinic', title: 'Scheduling Coordinator',
    listing: ['Scheduling coordinator role focused on reliable appointment booking.',
      'The team manages exam rooms and supports nurses who depend on those bookings every working day.',
      'We value careful judgement, clear written messages, steady booking habits, and a willingness to learn the patient flow in depth.',
      'You will work with front desk partners to keep the appointment calendar dependable for the patients who rely on it each week.'].join(' '),
    guided: [
      'For the Scheduling Coordinator role at Harborview Clinic, the closest capability my work shows is keeping exam room calendars dependable for the nurses who rely on them.',
      'I rebuilt the Monday booking template after double bookings filled the waiting room. The template reserved the first hour for urgent visits, and walk-in waits shortened within a month.',
      'I wrote the reminder script that front desk staff read before every call. Because the script gave the reason for each rescheduling, patients stopped calling back to ask why.',
    ],
    closing: 'My calendar management work could support your front desk and the patients who rely on it.',
  },
  {
    key: 'library cataloguing', employer: 'Eastgate Library', title: 'Collections Cataloguer',
    listing: ['Collections cataloguer role focused on reliable record keeping.',
      'The team organises shelving sections and supports readers who depend on those records every working day.',
      'We value careful judgement, clear written notes, steady cataloguing habits, and a willingness to learn the collection in depth.',
      'You will work with branch partners to keep the catalogue dependable for the readers who rely on it each week.'].join(' '),
    guided: [
      'For the Collections Cataloguer role at Eastgate Library, the closest capability my work shows is keeping shelving records dependable for the readers who search them.',
      'I rebuilt the subject headings for the local history shelves after readers could not find maps. The new headings grouped maps by parish, and requests for staff help fell within a term.',
      'I wrote the accession checklist that volunteers used for every donated box. Because the checklist recorded where each item came from, later questions about a donor took minutes.',
    ],
    closing: 'My cataloguing work could support your branch teams and the readers who rely on the collection.',
  },
]);

export default [ {
    name: 'Opening: an opening that names the role and the employer from the job record and states the closest capability passes the whole battery, and one that announces the application does not (A / B, 3 domains)',
    run() {
      for (const domain of DOMAINS) {
        const battery = paragraphs => evaluateCoverLetterChecks({
          plan: {}, paragraphs, evidence: { roles: [{ company: 'Regional Haulage' }], projects: [], bullets: [] },
          jobText: domain.listing, researchText: '', companyName: domain.employer,
        });
        const failed = paragraphs => battery(paragraphs).filter(check => !check.passed).map(check => check.id);
        const rest = [...domain.guided.slice(1), domain.closing];
        assert(domain.guided[0].includes(domain.title) && domain.guided[0].includes(domain.employer), `${domain.key}: the guided opening names the title and the employer`);
        assert(failed([domain.guided[0], ...rest]).length === 0, `${domain.key}/A: a named, candidate-side opening passes (${failed([domain.guided[0], ...rest])})`);
        // B: the announcement the rule says this is not.
        const announced = `I am applying for the ${domain.title} role at ${domain.employer}.`;
        assert(failed([announced, ...rest]).length > 0, `${domain.key}/B: an announcement of the application is still rejected by the battery (${failed([announced, ...rest])})`);
      }
    },
  },
];
