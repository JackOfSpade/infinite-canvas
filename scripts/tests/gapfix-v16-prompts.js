// Writer guidance for the cover letter and the résumé, and the one fact a writer
// was never told: which posting requirements the approved evidence does not
// support.
//
// The failure these tests pin. A live run ended in a human stop after five
// blind-review rounds, and an independent panel scored the stopped documents
// barely above the first accepted drafts. What the panel kept finding was never
// a rule the host could enforce without naming a string for the writer to copy:
// the letter restated the résumé bullets one for one, opened on an abstract
// assertion about the employer's domain, echoed the posting's vocabulary as
// filler, closed on a sentence that tied nothing to the role, bound two
// paragraphs to one posting phrase, and padded a third proof the evidence did
// not need; the résumé promoted maintenance work into work the candidate built;
// and the writer was never told which highest-priority requirements had no
// support at all. The lever is GUIDANCE in the writer's contract, not a new gate
// (an honest, wide-gap letter passes every existing gate), so nothing below
// asserts that a gate rejects anything; each test proves the guidance is there,
// is built from the code that owns the rule, is generic, and cannot be
// satisfied by a name, phrase or technology it was written against.
//
// What each group proves:
//   rules      each rule is its own generic sentence set, composed once, and no
//              rule carries a quotation, a number, or a word of any fixture
//   closing    the closing grammar printed in the stage contract is the check's
//              own wording (read from the check), and a closing written to it is
//              accepted by the whole deterministic battery while the same
//              closing missing its employer half is not (A / B / C)
//   opening    an opening that names the role and the employer from the job
//              record and speaks from the candidate's side passes the whole
//              battery (three domains), so the guidance sends no writer into a
//              rejection
//   mutation   changing a constant in a temporary copy of the module that owns
//              it changes what the guidance prints, and the real modules stay
//              untouched
//   bounded    the unsupported-requirement context is bounded, ordered, de-
//              duplicated, filtered by priority, and absent when empty
//   store      it is derived from the store's reduction receipt, and flipping
//              one match or one priority flips the verdict
//   flow       through the real current-authority protocol it reaches the
//              résumé, the letter and the review, with its rule, and is absent
//              when every requirement is supported
//   prompts    the stage contracts print the guidance once, in the stages that
//              write the document it governs, and no stage prints a string from
//              any fixture
//   builder    a temporary copy of the prompt builder, wired to a temporary copy
//              of the guidance module whose every rule is marked, prints each
//              mark where it belongs and nowhere else, correction rounds included
//   brief      the correction round restates only what a rewrite is invited to
//              forget, last, so the byte ceiling gives it up first
//   wiring     the blind repair brief carries the typed fields and the rule
//              sentences, and unitRaisedCycles reads the signed tally across
//              real cycles
//   docs       the documents say what the code does
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (freight
// dispatch, clinic scheduling, library cataloguing, civil site inspection, retail
// analytics). Nothing in production names any of them.
import { assert } from './testHelpers.js';
import * as guidance from '../../electron/ipc/applicationWriterGuidance.js';
import {
  APPLICATION_QUALITY_CRITERIA,
} from '../../electron/ipc/localAiApplication.js';
import {
  OWING_CLAIM_PARAGRAPHS, evaluateCoverLetterChecks,
} from '../../electron/ipc/coverLetterChecks.js';
import { BLIND_REPAIR_RAISED_CYCLES_RULE, BLIND_REPAIR_TRUNCATION_RULE } from '../../electron/ipc/applicationRepairConvergence.js';
import { CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import { APPLICATION_COVER_LETTER_SCHEMA, APPLICATION_DIRECT_COVER_LETTER_SCHEMA } from '../../electron/ipc/aiSchemas.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
// Each domain is a candidate, a posting, a bullet, and the paragraph the legacy
// walker submits as the letter. `vocabulary` is what no production sentence may
// contain.
const DOMAINS = Object.freeze([
  {
    key: 'freight dispatch', name: 'Dara Okafor', email: 'dara@example.test', employer: 'Meridian Freight', title: 'Dispatch Planner',
    vocabulary: ['freight', 'pallet', 'depot', 'dock', 'dispatch', 'drivers', 'meridian', 'okafor'],
    listing: ['Dispatch planner role focused on reliable pallet routing.',
      'The team schedules loading docks and supports drivers who depend on those schedules every working day.',
      'We value careful judgement, clear written handoffs, steady planning habits, and a willingness to learn the depot network in depth.',
      'You will work with warehouse partners to keep the delivery network dependable for the customers who rely on it each week.'].join(' '),
    bullet: 'Maintained pallet routing schedules with supported dispatch practices.',
    lead: 'Reliable pallet routing is the capability this dispatch role needs, and my planning experience supports it.',
    body: 'In my planning role at Meridian Freight, I kept the depot loading schedule dependable for daily drivers through shared route sheets.',
    thesis: 'Reliable pallet routing is the supported capability this dispatch role needs.',
    // A letter written to the guidance: the opening names role and employer, two proofs add the reason or outcome, the close ties one item to the role.
    guided: [
      'For the Dispatch Planner role at Meridian Freight, the closest capability my work shows is keeping depot loading schedules dependable for the drivers who read them.',
      'I rebuilt the dock schedule at a regional depot after drivers lost hours waiting at full bays. The change moved morning arrivals into staggered slots, and waiting time dropped within a month.',
      'I wrote the handoff sheet that night supervisors used when a route changed. Because the sheet listed the reason for each change, drivers stopped phoning the office for clarification.',
    ],
    asset: 'dock scheduling', employerSide: 'your depot network',
    closing: 'My dock scheduling work could support your depot network and the customers who rely on it.',
  },
  {
    key: 'clinic scheduling', name: 'Imani Rahman', email: 'imani@example.test', employer: 'Harborview Clinic', title: 'Scheduling Coordinator',
    vocabulary: ['clinic', 'nurse', 'nurses', 'appointment', 'appointments', 'patients', 'patient', 'harborview', 'rahman', 'exam'],
    listing: ['Scheduling coordinator role focused on reliable appointment booking.',
      'The team manages exam rooms and supports nurses who depend on those bookings every working day.',
      'We value careful judgement, clear written messages, steady booking habits, and a willingness to learn the patient flow in depth.',
      'You will work with front desk partners to keep the appointment calendar dependable for the patients who rely on it each week.'].join(' '),
    bullet: 'Maintained appointment calendars with supported booking practices.',
    lead: 'Reliable appointment booking is the capability this coordinator role needs, and my scheduling experience supports it.',
    body: 'In my scheduling role at Harborview Clinic, I kept the exam room calendar dependable for daily nurses through shared booking sheets.',
    thesis: 'Reliable appointment booking is the supported capability this coordinator role needs.',
    guided: [
      'For the Scheduling Coordinator role at Harborview Clinic, the closest capability my work shows is keeping exam room calendars dependable for the nurses who rely on them.',
      'I rebuilt the Monday booking template after double bookings filled the waiting room. The template reserved the first hour for urgent visits, and walk-in waits shortened within a month.',
      'I wrote the reminder script that front desk staff read before every call. Because the script gave the reason for each rescheduling, patients stopped calling back to ask why.',
    ],
    asset: 'calendar management', employerSide: 'your front desk',
    closing: 'My calendar management work could support your front desk and the patients who rely on it.',
  },
  {
    key: 'library cataloguing', name: 'Tomas Lindqvist', email: 'tomas@example.test', employer: 'Eastgate Library', title: 'Collections Cataloguer',
    vocabulary: ['library', 'cataloguer', 'shelving', 'readers', 'eastgate', 'lindqvist', 'accession'],
    listing: ['Collections cataloguer role focused on reliable record keeping.',
      'The team organises shelving sections and supports readers who depend on those records every working day.',
      'We value careful judgement, clear written notes, steady cataloguing habits, and a willingness to learn the collection in depth.',
      'You will work with branch partners to keep the catalogue dependable for the readers who rely on it each week.'].join(' '),
    bullet: 'Maintained catalogue records with supported cataloguing practices.',
    lead: 'Reliable record keeping is the capability this cataloguer role needs, and my cataloguing experience supports it.',
    body: 'In my cataloguing role at Eastgate Library, I kept the shelving records dependable for daily readers through shared index cards.',
    thesis: 'Reliable record keeping is the supported capability this cataloguer role needs.',
    guided: [
      'For the Collections Cataloguer role at Eastgate Library, the closest capability my work shows is keeping shelving records dependable for the readers who search them.',
      'I rebuilt the subject headings for the local history shelves after readers could not find maps. The new headings grouped maps by parish, and requests for staff help fell within a term.',
      'I wrote the accession checklist that volunteers used for every donated box. Because the checklist recorded where each item came from, later questions about a donor took minutes.',
    ],
    asset: 'cataloguing', employerSide: 'your branch teams',
    closing: 'My cataloguing work could support your branch teams and the readers who rely on the collection.',
  },
]);

// Two further careers for the pure functions: a requirement list is not a letter.
const REQUIREMENT_SETS = Object.freeze([
  { key: 'civil site inspection', rows: [
    { id: 'r-1', text: 'Inspect concrete pours against the engineer’s drawings', priority: 'highest' },
    { id: 'r-2', text: 'Hold a current confined space entry permit', priority: 'high' },
    { id: 'r-3', text: 'Report weekly progress to the owner’s representative', priority: 'supporting' },
    { id: 'r-4', text: 'Operate a total station', priority: 'highest' },
  ] },
  { key: 'retail analytics', rows: [
    { id: 'q-1', text: 'Forecast weekly basket size by store format', priority: 'high' },
    { id: 'q-2', text: 'Build dashboards for regional managers', priority: 'supporting' },
    { id: 'q-3', text: 'Negotiate vendor rebates', priority: 'highest' },
  ] },
  { key: 'freight dispatch', rows: [
    { id: 'p-1', text: 'Hold a hazardous materials endorsement', priority: 'highest' },
    { id: 'p-2', text: 'Plan backhaul loads for regional carriers', priority: 'high' },
  ] },
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
  },  {
    name: 'Unsupported needs, bounded: only the highest and high priorities, in priority then arrival order, de-duplicated, clipped on a word boundary, capped with the remainder counted, and absent when empty (3 careers, A / B / C)',
    run() {
      for (const set of REQUIREMENT_SETS) {
        const rows = set.rows.map(({ id, text, priority }) => ({ id, text, priority, candidateSupport: 'unsupported' }));
        const fromPlan = guidance.unsupportedNeedsFromPlan(rows);
        assert(fromPlan.length === rows.length && fromPlan.every(row => Object.keys(row).sort().join() === 'id,priority,text'), `${set.key}/A: the plan adapter keeps id, text and priority of what the plan marked unsupported`);
        const bounded = guidance.boundedUnsupportedNeeds(fromPlan);
        const expected = set.rows.filter(row => row.priority !== 'supporting');
        const order = expected.filter(row => row.priority === 'highest').concat(expected.filter(row => row.priority === 'high'));
        assert(JSON.stringify(bounded.requirements.map(row => row.id)) === JSON.stringify(order.map(row => row.id)) && bounded.omitted === 0,
          `${set.key}/A: highest before high, arrival order within a priority, supporting never listed (${JSON.stringify(bounded)})`);
        // B: flipping the plan's mark removes the row; an absent mark lists nothing.
        const supported = rows.map(row => (row.id === order[0].id ? { ...row, candidateSupport: 'supported' } : row));
        assert(!guidance.unsupportedNeedsFromPlan(supported).some(row => row.id === order[0].id), `${set.key}/B: a requirement the plan marks supported is not listed`);
        assert(guidance.unsupportedNeedsFromPlan(set.rows).length === 0 && guidance.boundedUnsupportedNeeds([]) === null && guidance.boundedUnsupportedNeeds(null) === null && guidance.boundedUnsupportedNeeds(undefined) === null,
          `${set.key}/B: with no mark, an empty list or no list, nothing is printed`);
        assert(guidance.boundedUnsupportedNeeds(set.rows.map(row => ({ ...row, priority: 'supporting' }))) === null, `${set.key}/B: a list of only supporting priorities prints nothing`);
        // C: de-duplicated by id, malformed rows ignored, and the flip back restores the verdict.
        const messy = [...fromPlan, { ...fromPlan[0], text: 'a duplicate id with other text' }, null, { id: '', text: 'no id', priority: 'high' }, { id: 'x', text: '   ', priority: 'high' }, { id: 'y', text: 'bad priority', priority: 'urgent' }];
        assert(guidance.boundedUnsupportedNeeds(messy).requirements.length === order.length, `${set.key}/C: duplicates and malformed rows are ignored`);
        assert(guidance.boundedUnsupportedNeeds(guidance.unsupportedNeedsFromPlan(rows)).requirements.some(row => row.id === order[0].id), `${set.key}/C: restoring the mark restores the row`);
      }
      // The cap and the clip.
      const many = Array.from({ length: guidance.UNSUPPORTED_NEEDS_MAX_ROWS + 5 }, (_unused, index) => ({ id: `n-${index}`, text: `Requirement number ${index}`, priority: index % 2 ? 'high' : 'highest' }));
      const capped = guidance.boundedUnsupportedNeeds(many);
      assert(capped.requirements.length === guidance.UNSUPPORTED_NEEDS_MAX_ROWS && capped.omitted === 5, `at most ${guidance.UNSUPPORTED_NEEDS_MAX_ROWS} print and the rest are counted (${capped.requirements.length}/${capped.omitted})`);
      assert(capped.requirements.every((row, index, list) => index === 0 || list[index - 1].priority === 'highest' || row.priority === 'high'), 'the cap keeps the highest priorities first');
      const long = guidance.boundedUnsupportedNeeds([{ id: 'l', priority: 'high', text: `${'word '.repeat(200)}tail` }]).requirements[0].text;
      assert(long.length <= guidance.UNSUPPORTED_NEED_TEXT_CHARS && long.endsWith('…') && !long.includes('wor…') && /word…$/u.test(long), `a long requirement is clipped on a word boundary (${long.length})`);
      assert(guidance.boundedUnsupportedNeeds([{ id: 's', priority: 'high', text: 'two\n   lines\tand   spaces' }]).requirements[0].text === 'two lines and spaces', 'whitespace is flattened');
    },
  },
];
