// Two truthfulness guards of the cover-letter contract that the claim and relevance
// budgets would otherwise have loosened.
//
// 1. A prior employer introduced by a role noun (“<modifiers> role at X”) must be the
//    CANDIDATE's role. The branch that accepts a role noun in front of the employer had
//    no candidate anchor, so a third party's role satisfied it: “her role at X made …”,
//    “a former manager's tenure at X ended before I …”, “the open position at X
//    attracted applicants, and I …”. The gate exists to make the first mention of a
//    prior employer state the candidate's own part. Now the role phrase itself has to
//    be tied to the candidate: their possessive, a fronted phrase whose main clause is
//    theirs, a phrase that acts on them (“taught me”), or a relative clause in their
//    voice (“, where I …”), and a modifier that names another person vetoes it.
//
// 2. The tool-assisted-practice guard. A tool used in one's own process is real
//    experience, but it is not evidence of having shipped a product powered by that
//    tool. The guard learned the practice from the proof span and looked for the
//    promotion in the recorded claim, proof and relevance. Every proof-bearing
//    paragraph used to have to record a claim (the capability sentence), so the
//    promotion always sat in a span the guard read; now a later paragraph may leave
//    its claim and its relevance out, and the identical capability sentence passed
//    unread. The guard now learns the practice from the proof span and from every
//    sentence that carries a first-person proof verb, and looks for the promotion in
//    every sentence of the paragraph as well as in the recorded spans.
//
// Every fixture is SYNTHETIC (invented employers and invented tools in unrelated
// fields). Nothing in production names any of them. Each rule is proved by flipping
// ONE token of a temporary fixture and expecting the verdict to flip, then flipping it
// back (A / B / C).
import { assert } from './testHelpers.js';
import { checkParagraphArgumentLinks, checkPriorEmployerOpening } from '../../electron/ipc/coverLetterChecks.js';

const detailOf = check => `${check.id}: ${check.detail}`;

// ---------------------------------------------------------------------------
// 1. Prior employer, role-framed.
// ---------------------------------------------------------------------------
const EMPLOYERS = Object.freeze([
  { employer: 'Brightwater Dairy', role: 'internship', preposition: 'with', field: 'quality control', work: 'the intake sheet' },
  { employer: 'Corvina Print Works', role: 'position', preposition: 'at', field: 'press scheduling', work: 'the job ticket' },
  { employer: 'Halden Municipal Library', role: 'role', preposition: 'at', field: 'collections', work: 'the hold list' },
  { employer: 'Ostrava Valley Rail', role: 'tenure', preposition: 'with', field: 'track inspection', work: 'the defect log' },
]);

const openingVerdict = (sentence, employer) => checkPriorEmployerOpening([sentence], [employer]);
const OBSERVATION = employer => `first names “${employer}” without the candidate's role or relationship`;

// ---------------------------------------------------------------------------
// 2. The tool-assisted-practice guard reads the whole paragraph.
// ---------------------------------------------------------------------------
// Each domain: the practice the proof states, the product scope a promotion would claim, a posting, a fully compliant first
// proof-bearing paragraph (claim, proof, a sentence about the target), and a later paragraph's proof.
const TOOLS = Object.freeze([
  {
    key: 'drone survey', practice: 'drone-assisted surveys',
    posting: 'Inspect culvert crossings on county roads each spring. Brief the commissioners on repair priorities.',
    quote: 'Inspect culvert crossings on county roads each spring.',
    opening: 'County roads fail where water meets them, and this role inspects those places.',
    first: ['My crossing inspection experience began on a county road crew.', 'I built a checklist that crews used at every culvert.', 'Culvert crossings on county roads each spring depend on one checklist that every crew follows.'],
    proof: 'I tested drone-assisted surveys of the culverts on every route.',
    promotion: 'My experience shipping drone-powered inspection services began on a county crew.',
    ending: 'Survey notes reached the crew before the spring thaw.',
    direct: 'I built a drone-powered inspection service for the county crews.',
  },
  {
    key: 'AI drafting', practice: 'AI-assisted drafting',
    posting: 'Draft plain language benefit letters for residents. Reduce appeal rates through clearer wording.',
    quote: 'Draft plain language benefit letters for residents.',
    opening: 'A benefit letter is read once, at a kitchen table, and this role writes it.',
    first: ['My benefits writing background comes from a county services office.', 'I wrote a letter template that caseworkers used for every notice.', 'Plain language benefit letters for residents depend on one template that every caseworker trusts.'],
    proof: 'I tested AI-assisted drafting of the notices on every case file.',
    promotion: 'My experience shipping AI-powered survey products began on a caseworker team.',
    ending: 'Residents phoned the office less often about the notices.',
    direct: 'I developed an AI-powered survey product for the county office.',
  },
  {
    key: 'robot picking', practice: 'robot-assisted picking',
    posting: 'Maintain packing cells on the warehouse floor. Report weekly throughput to the shift managers.',
    quote: 'Maintain packing cells on the warehouse floor.',
    opening: 'A warehouse floor is a schedule made of boxes, and this role keeps the schedule.',
    first: ['My line maintenance practice began on a warehouse floor.', 'I created a service log that technicians filled in at every shift.', 'Packing cells on the warehouse floor depend on one log that every technician keeps.'],
    proof: 'I tested robot-assisted picking trials on the floor.',
    promotion: 'My experience developing robot-driven packing cells began on a night shift.',
    ending: 'Trial results reached the shift managers by the morning.',
    direct: 'I built a robot-driven packing cell for the night shift.',
  },
  {
    key: 'cloud runbooks', practice: 'cloud-assisted runbooks',
    posting: 'Operate appointment scheduling for a hospital network. Keep downtime inside the agreed window.',
    quote: 'Operate appointment scheduling for a hospital network.',
    opening: 'A hospital calendar is the first system a patient trusts, and this role keeps it running.',
    first: ['My release practice began at a regional hospital.', 'I configured a runbook that operators followed at every release.', 'Appointment scheduling for a hospital network depends on one runbook that every operator follows.'],
    proof: 'I migrated the clinic systems through cloud-assisted runbooks.',
    promotion: 'My experience building cloud-native scheduling applications began at a clinic network.',
    ending: 'Release weekends stopped running past midnight.',
    direct: 'I built a cloud-native scheduling application for a clinic network.',
  },
]);

// Opening, the compliant first paragraph, the paragraph under test, a closing.
function scopeLetter(kase, laterText, laterMapping, firstText = kase.first.join(' ')) {
  const [claim, proof, relevance] = kase.first;
  return {
    paragraphs: [kase.opening, firstText, laterText, 'I welcome a conversation about your work.'],
    plan: { paragraphs: [null, { claim, proof, relevance, jobNeedQuote: kase.quote }, laterMapping, null].map(mapping => ({ argumentMapping: mapping })) },
  };
}
const scopeGate = (kase, letter) => checkParagraphArgumentLinks({ plan: letter.plan, paragraphs: letter.paragraphs, jobText: kase.posting });

// A later paragraph binds its own posting requirement: two proof-bearing paragraphs bound to one span are reported by the gate (gapfix-v16c-letter-binding).
const laterQuoteOf = kase => kase.posting.split('. ').at(-1);

const SCOPE_TEST = {
  name: 'Tool-assisted scope: a capability sentence the mapping does not record, in a later paragraph that records neither claim nor relevance, is read for the promotion of a tool-assisted practice to a shipped product (A/B/C/D, four domains)',
  run() {
    for (const kase of TOOLS) {
      const mapping = { proof: kase.proof, jobNeedQuote: laterQuoteOf(kase) };
      const later = text => scopeGate(kase, scopeLetter(kase, text, mapping));
      // A: a later paragraph that records only its proof and states the practice passes.
      const clean = later(`${kase.proof} ${kase.ending}`);
      assert(clean.passed, `${kase.key}/A: a later paragraph that records only its proof and states the practice passes (${detailOf(clean)})`);
      // B: put the promotion into the paragraph as a sentence no span records, and the guard reads it.
      const promoted = later(`${kase.promotion} ${kase.proof} ${kase.ending}`);
      assert(!promoted.passed && promoted.detail.includes('paragraph 3 treats a tool-assisted practice (\u201c') && promoted.detail.includes('as evidence of shipping a product powered by that tool'),
        `${kase.key}/B: an unrecorded capability sentence that promotes the practice is rejected (${detailOf(promoted)})`);
      assert(promoted.detail.toLowerCase().includes(kase.practice.split(' ')[0].toLowerCase()), `${kase.key}/B: and the message names the practice learned from the proof (${promoted.detail})`);
      // C: take the promotion out again and it passes; the verdict is the sentence, not the paragraph.
      assert(later(`${kase.proof} ${kase.ending}`).passed, `${kase.key}/C: without the promotion the paragraph passes again`);
      // Position inside the paragraph does not matter.
      const after = later(`${kase.proof} ${kase.promotion} ${kase.ending}`);
      assert(!after.passed && after.detail.includes('treats a tool-assisted practice'), `${kase.key}/B: a promotion after the proof is read too (${detailOf(after)})`);
      // D: a direct build in a proof sentence of the paragraph answers the guard, exactly as it answered it in the proof span.
      const direct = later(`${kase.promotion} ${kase.direct} ${kase.proof} ${kase.ending}`);
      assert(direct.passed, `${kase.key}/D: a first-person proof sentence that builds the product itself licenses the sentence (${detailOf(direct)})`);
      // Recording the promotion as the claim is still rejected, as it always was.
      const recorded = scopeGate(kase, scopeLetter(kase, `${kase.promotion} ${kase.proof} ${kase.ending}`, { ...mapping, claim: kase.promotion }));
      assert(!recorded.passed && recorded.detail.includes('treats a tool-assisted practice'), `${kase.key}: recording the promotion as the claim is rejected as before (${detailOf(recorded)})`);
      // The first proof-bearing paragraph is read the same way: its practice and a promotion in a sentence no span records.
      const [claim, proof, relevance] = kase.first;
      const practiceProof = `${proof} I also tested ${kase.practice} there.`;
      const firstText = `${claim} ${practiceProof} ${kase.promotion} ${relevance}`;
      const firstVerdict = scopeGate(kase, scopeLetter(kase, `${kase.proof} ${kase.ending}`, mapping, firstText));
      assert(!firstVerdict.passed && firstVerdict.detail.includes('paragraph 2 treats a tool-assisted practice'), `${kase.key}: the first proof-bearing paragraph is read for an unrecorded promotion too (${detailOf(firstVerdict)})`);
      assert(scopeGate(kase, scopeLetter(kase, `${kase.proof} ${kase.ending}`, mapping, `${claim} ${practiceProof} ${relevance}`)).passed, `${kase.key}: and passes without it`);
      // With no tool-assisted practice anywhere there is nothing to compare the promotion with: the guard is silent, as it always was.
      const plainProof = 'I tested the notices on every route.';
      const noPractice = scopeGate(kase, scopeLetter(kase, `${kase.promotion} ${plainProof}`, { proof: plainProof, jobNeedQuote: laterQuoteOf(kase) }));
      assert(!/treats a tool-assisted practice/u.test(noPractice.detail), `${kase.key}: with no practice learned the guard has nothing to say (${detailOf(noPractice)})`);
    }
  },
};

export default [
  {
    name: 'Prior employer, role-framed: a role noun counts only when the role is the candidate’s, and flipping one token to another person flips the verdict (A/B/C, four employers)',
    run() {
      for (const { employer, role, preposition, field, work } of EMPLOYERS) {
        // The four ways a role phrase is tied to the candidate, each with the one token that would hand the role to somebody else.
        const pairs = [
          ['a fronted role phrase and the candidate’s own main clause', `In an earlier ${field} ${role} ${preposition} ${employer}, I built ${work}.`, `In an earlier ${field} ${role} ${preposition} ${employer}, she built ${work}.`],
          ['the candidate’s own possessive', `My first ${role} ${preposition} ${employer} was in ${field}, and I created ${work}.`, `Her first ${role} ${preposition} ${employer} was in ${field}, and I created ${work}.`],
          ['a role phrase that acts on the candidate', `A short ${field} ${role} ${preposition} ${employer} taught me the routine, and I wrote ${work}.`, `A short ${field} ${role} ${preposition} ${employer} taught her the routine, and I wrote ${work}.`],
          ['a relative clause in the candidate’s voice', `I held a ${field} ${role} ${preposition} ${employer}, where I developed ${work}.`, `I held a ${field} ${role} ${preposition} ${employer}, where she developed ${work}.`],
        ];
        for (const [how, anchored, handed] of pairs) {
          // A: anchored to the candidate, accepted.
          const accepted = openingVerdict(anchored, employer);
          assert(accepted.passed, `${employer}/A: ${how} introduces the employer (${detailOf(accepted)})`);
          // B: one token hands the role to somebody else, and the verdict flips.
          const rejected = openingVerdict(handed, employer);
          assert(!rejected.passed && rejected.detail.includes(OBSERVATION(employer)), `${employer}/B: with ${how} given to another person the employer is not introduced (${detailOf(rejected)})`);
          // C: flipping it back flips it back.
          assert(openingVerdict(anchored, employer).passed, `${employer}/C: and restoring the candidate restores the verdict`);
        }
        // A third party's role stays rejected, wherever an “I” happens to sit in the sentence.
        const thirdParty = [
          `The open ${role} ${preposition} ${employer} attracted forty applicants, and I rebuilt ${work}.`,
          `A former manager’s ${role} ${preposition} ${employer} ended before I rebuilt ${work}.`,
          `I met a driver whose ${role} ${preposition} ${employer} involved ${work}.`,
          `The ${field} ${role} ${preposition} ${employer} was filled by a contractor before I rebuilt ${work}.`,
          `In her ${role} ${preposition} ${employer}, I watched ${work} fail and I rebuilt it.`,
          `In the manager’s ${role} ${preposition} ${employer}, I built ${work}.`,
          `Their ${role} ${preposition} ${employer} gave me nothing to build on, so I created ${work}.`,
        ];
        for (const sentence of thirdParty) {
          const verdict = openingVerdict(sentence, employer);
          assert(!verdict.passed && verdict.detail.includes(OBSERVATION(employer)), `${employer}: a role that is not the candidate’s does not introduce the employer (${sentence}): ${detailOf(verdict)}`);
        }
        // The frames that never needed the branch are untouched, and so is the rejection of a bare opener.
        for (const sentence of [
          `As a ${field} analyst ${preposition} ${employer}, I built ${work}.`,
          `I worked ${preposition} ${employer}, where I built ${work}.`,
          `My ${field} ${role} ${preposition} ${employer} covered ${work}, which I built.`,
        ]) assert(openingVerdict(sentence, employer).passed, `${employer}: an earlier frame still passes (${sentence})`);
        assert(!openingVerdict(`At ${employer}, I built ${work}.`, employer).passed, `${employer}: a bare opener is still rejected`);
        // Without the role noun there is nothing to anchor: the possessive alone does not turn a place into a relationship.
        assert(!openingVerdict(`In an earlier ${field} setting ${preposition} ${employer}, I built ${work}.`, employer).passed, `${employer}: a setting is no role`);
      }
    },
  },
  {
    name: 'Prior employer, role-framed: the first sentence that names the employer decides, and a later candidate-anchored mention cannot repair a third-party first mention (A/B/C)',
    run() {
      const { employer, role, preposition, work } = EMPLOYERS[0];
      const third = `The open ${role} ${preposition} ${employer} drew many applicants.`;
      const own = `My ${role} ${preposition} ${employer} covered ${work}, which I built.`;
      assert(!checkPriorEmployerOpening([third, own], [employer]).passed, 'a third party’s first mention is not repaired by the candidate’s second');
      assert(checkPriorEmployerOpening([own, third], [employer]).passed, 'and the candidate’s first mention is not undone by a later third-party one');
      assert(checkPriorEmployerOpening([`${own} ${third}`], [employer]).passed, 'within one paragraph the sentence that names the employer first decides');
    },
  },
  SCOPE_TEST,
];
