// The sentence about the target: which paragraph owes one, how it is
// recognised, how often a stock frame may stand in for it, and what it may claim.
//
// The failure these tests pin: the argument gate demanded a transfer sentence in
// one of a closed set of stock frames ("I would apply that X to Y" and its few
// siblings) in EVERY proof-bearing paragraph, and then in the first two. A strong
// writer who can produce any natural sentence was therefore forced into those
// frames, independent reviewers read the resulting cadence as formulaic and as
// speculative scaffolding round after round, and the one place a writer is
// obliged to say what the work will do for the employer was also where benefits
// the proof never showed crept in. The model was never the limit; the host's
// closed list of accepted frames was.
//
// What changed, and what each group below proves:
//   owed      only the FIRST proof-bearing paragraph owes a sentence about why
//             its proof matters to the target (MAX_EXPLICIT_TRANSFER_PARAGRAPHS
//             is one), counted by one function the gate, the drafting-stage
//             reporter and the budget all read
//   natural   that sentence is recognised by the words it shares with the quote
//             the paragraph cites and by standing apart from the proof sentence,
//             in ANY wording: no stock frame, no would or can, no shared noun
//   refused   a generic label, a sentence that only restates the proof, and a
//             sentence that names nothing of the cited need are still refused,
//             with a message that says what to do
//   budget    transfer-carrier-budget counts stock frames only: at most one
//             paragraph carries one, and none is required
//   repeats   the same wording in neighbouring paragraphs is still reported,
//             without a closed list of forms to move to
//   benefit   transfer-benefit-support reads every sentence of a proof-bearing
//             paragraph that states no action of its own, so a natural-wording
//             relevance sentence that promises a benefit the proof never showed
//             is still rejected
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (clinic
// front office, freight dispatch, library cataloguing). Nothing in production
// names any of them. Each rule is proved by flipping ONE input in a temporary
// fixture and expecting the verdict to flip, then flipping it back (A / B / C).
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import {
  ARGUMENT_LATER_RELEVANCE_SPAN_RULE, ARGUMENT_RELEVANCE_SPAN_RULE, EXPLICIT_TRANSFER_BUDGET_RULE, MAX_EXPLICIT_TRANSFER_PARAGRAPHS,
  TRANSFER_BENEFIT_CLASSES, TRANSFER_BENEFIT_CLASS_NAMES, TRANSFER_BENEFIT_SUPPORT_RULE, checkParagraphArgumentLinks,
  checkRepeatedTransferCarrier, checkTransferBenefitSupport, checkTransferCarrierBudget, evaluateCoverLetterChecks, explicitTransferOwed,
  paragraphArgumentSpanGaps, sentences,
} from '../../electron/ipc/coverLetterChecks.js';
import { PASTE_CHECK_PROSE_UNITS, pasteReportableCheckIds } from '../../electron/ipc/localAiApplication.js';

// ---------------------------------------------------------------------------
// Fixtures: three unrelated careers. Each domain has an opening that makes no
// claim of its own, three proofs (each a capability claim, a completed action
// from the closed proof-verb list, then EITHER a sentence about the target in
// natural wording OR an ending on what the work did), a stock-frame version of
// the same sentence, and a direct closing. The posting is written so each
// proof's jobNeedQuote is a verbatim span of it. The natural sentences use no
// would, no can, and none of the stock frames: that is what they are for.
// ---------------------------------------------------------------------------
const DOMAINS = Object.freeze([
  {
    key: 'clinic front office',
    posting: 'Coordinate appointment scheduling across clinic locations. Maintain patient intake records with accurate data entry. Reduce wait times through shift planning. Keep the front desk calm on busy mornings.',
    opening: 'Several clinics share one front desk team, and this role keeps that team organized.',
    proofs: [
      {
        claim: 'My scheduling practice grew from the front desk.',
        proof: 'I built a shared appointment calendar that merged three clinic locations into one view.',
        natural: [
          'Coordinating appointment scheduling across clinic locations is the problem this role poses.',
          'Your clinics need appointment scheduling that holds across locations, and the calendar was built for that.',
          'Three clinic locations on one calendar is what appointment scheduling across sites asks for.',
        ],
        stock: 'I would apply that scheduling practice to the appointment scheduling across clinic locations that this role coordinates.',
        ending: 'The shared calendar replaced three paper books within a month.',
        quote: 'Coordinate appointment scheduling across clinic locations.',
      },
      {
        claim: 'My intake approach favors one record per patient.',
        proof: 'I wrote the intake checklist that front desk staff followed for every new patient record.',
        natural: [
          'Patient intake records stay maintained when every entry follows one checklist, and data entry is where that discipline shows.',
          'Accurate data entry in patient intake records starts with a checklist that every desk follows.',
        ],
        stock: 'That intake approach would support the patient intake records this role maintains.',
        ending: 'Staff finished the checklist in under a minute for each patient record.',
        quote: 'Maintain patient intake records with accurate data entry.',
      },
      {
        claim: 'My planning practice starts from the busiest hour.',
        proof: 'I reworked the shift planning sheet so wait times fell on busy mornings.',
        natural: [
          'Shorter wait times through shift planning is the outcome a front desk is judged on.',
          'Shift planning that reduces wait times is the job this role gives its coordinator.',
        ],
        stock: 'I can bring that planning practice to the shift planning behind shorter wait times.',
        ending: 'Waits fell once the new sheet went live.',
        quote: 'Reduce wait times through shift planning.',
      },
    ],
    closing: 'I welcome a conversation about your front-office work.',
    // benefit fixtures: a natural-wording sentence that promises a benefit, the word, the class it belongs to,
    // proofs that do and do not attest the class, and the posting's own two-word run that names the responsibility
    benefit: {
      sentence: 'The appointment calendar would stay available around the clock for every location.',
      word: 'available', className: 'availability',
      attestingProof: 'I built a shared appointment calendar with a failover copy that merged three clinic locations into one view.',
      otherClassProof: 'I built a shared appointment calendar with encrypted records that merged three clinic locations into one view.',
      quote: 'Built a shared appointment calendar that merged three clinic locations.',
      attestingQuote: 'Built a shared appointment calendar and kept its uptime steady across three clinic locations.',
      run: 'appointments available',
      echoSentence: 'Your clinics keep appointments available at every location, and the calendar was built for that.',
    },
  },
  {
    key: 'freight dispatch',
    posting: 'Plan delivery routes for regional depots. Track shipment exceptions with accurate manifests. Reduce late arrivals through dock scheduling. Support drivers during the evening shift.',
    opening: 'A dispatch role lives or dies by how its depots are served each morning.',
    proofs: [
      {
        claim: 'My routing practice grew out of depot dispatch.',
        proof: 'I built a route planner that grouped depot pickups by neighborhood.',
        natural: [
          'Delivery routes for regional depots depend on grouping stops sensibly, which the planner did by neighborhood.',
          'Regional depots need delivery routes that start from sensible groups of pickups.',
          'Whoever plans delivery routes across regional depots faces that grouping question daily.',
        ],
        stock: 'I would apply that routing practice to the delivery routes this role plans.',
        ending: 'The planner cut the morning sort at the loading bay to one pass.',
        quote: 'Plan delivery routes for regional depots.',
      },
      {
        claim: 'My exception handling approach keeps one manifest per shipment.',
        proof: 'I wrote the exception report that dispatchers reviewed before every manifest closed.',
        natural: [
          'Shipment exceptions are tracked well when every manifest is closed from one report.',
          'Tracking shipment exceptions with accurate manifests begins with a report that dispatchers read.',
        ],
        stock: 'That exception approach would support the shipment exceptions this role tracks.',
        ending: 'Dispatchers closed each manifest from that report without a second call.',
        quote: 'Track shipment exceptions with accurate manifests.',
      },
      {
        claim: 'My scheduling practice starts from the dock.',
        proof: 'I reworked the dock schedule so late arrivals dropped on heavy days.',
        natural: [
          'Fewer late arrivals through dock scheduling is the result this role is measured by.',
          'Dock scheduling that reduces late arrivals is the heart of this position.',
        ],
        stock: 'I can bring that scheduling practice to the dock scheduling behind fewer late arrivals.',
        ending: 'Trucks stopped queuing at the gate within two weeks.',
        quote: 'Reduce late arrivals through dock scheduling.',
      },
    ],
    closing: 'I welcome a conversation about your dispatch work.',
    benefit: {
      sentence: 'The route planner would keep depot handoffs secure on every shift.',
      word: 'secure', className: 'security',
      attestingProof: 'I built a route planner with signed handoff tokens that grouped depot pickups by neighborhood.',
      otherClassProof: 'I built a route planner with a replica copy that grouped depot pickups by neighborhood.',
      quote: 'Built a route planner that grouped depot pickups by neighborhood.',
      attestingQuote: 'Built a route planner and restricted who could open each depot handoff.',
      run: 'handoffs secure',
      echoSentence: 'Regional depots keep handoffs secure at every dock, and the planner was built around that.',
    },
  },
  {
    key: 'library cataloguing',
    posting: 'Catalog new acquisitions for the reference collection. Maintain accurate subject records across branches. Reduce hold wait times through shelving plans. Welcome visitors at the reading room desk.',
    opening: 'A cataloguing role is judged on the records it leaves behind.',
    proofs: [
      {
        claim: 'My cataloguing practice grew out of the acquisitions desk.',
        proof: 'I created a template that gave every new acquisition a complete catalog record.',
        natural: [
          'Cataloguing new acquisitions for the reference collection starts from a complete record, and a template supplies one.',
          'The reference collection grows by new acquisitions, each of which needs a record before it reaches a shelf.',
          'Every new acquisition for the reference collection passes through one catalog step, which is where a template matters.',
        ],
        stock: 'I would apply that cataloguing practice to the new acquisitions this role catalogs for the reference collection.',
        ending: 'Every new item left the desk with a complete record.',
        quote: 'Catalog new acquisitions for the reference collection.',
      },
      {
        claim: 'My records approach keeps one subject heading per topic.',
        proof: 'I updated the subject headings that branch staff used for every shared record.',
        natural: [
          'Subject records across branches line up when every branch reads one heading list.',
          'Accurate subject records across branches begin with headings that all branches share.',
        ],
        stock: 'That records approach would help the subject records this role maintains across branches.',
        ending: 'Branch staff searched one heading list instead of four local lists.',
        quote: 'Maintain accurate subject records across branches.',
      },
      {
        claim: 'My shelving practice starts from the longest hold queue.',
        proof: 'I reworked the shelving plan so hold wait times fell for popular titles.',
        natural: [
          'Shelving plans that reduce hold wait times are the lever this role controls.',
          'Shelving plans that shorten how long patrons wait for holds are measured at every branch.',
        ],
        stock: 'I can bring that shelving practice to the shelving plans behind shorter hold wait times.',
        ending: 'Popular titles reached patrons sooner once the new plan began.',
        quote: 'Reduce hold wait times through shelving plans.',
      },
    ],
    closing: 'I welcome a conversation about your cataloguing work.',
    benefit: {
      sentence: 'The template would cut the cost of every branch audit.',
      word: 'cost', className: 'cost',
      attestingProof: 'I created a template within a fixed budget that gave every new acquisition a complete catalog record.',
      otherClassProof: 'I created a template with checked entries that gave every new acquisition a complete catalog record.',
      quote: 'Created a template that gave every new acquisition a complete catalog record.',
      attestingQuote: 'Created a template and saved branch staff hours on every new acquisition record.',
      run: 'records cost',
      echoSentence: 'Subject records cost branches real attention today, and the template was built around that.',
    },
  },
]);

// The stock frames and the natural sentences are different sentences about the same proof.
const statementOf = (proof, { stock = false, form = 0 } = {}) => (stock ? proof.stock : proof.natural[form % proof.natural.length]);
const paragraphOf = (proof, { statement = null } = {}) => `${proof.claim} ${proof.proof} ${statement || proof.ending}`;

// The letter: opening, three proofs, closing. The FIRST proof states its relevance
// in the wording asked for; every later proof ends on what the work did.
function letterOf(domain, { stock = false, form = 0, owing = 1 } = {}) {
  return [
    domain.opening,
    ...domain.proofs.map((proof, index) => paragraphOf(proof, index < owing ? { statement: statementOf(proof, { stock, form }) } : {})),
    domain.closing,
  ];
}

// The audit's plan for that letter: one argumentMapping per proof paragraph. The
// paragraph that states its relevance maps relevance to that sentence; a paragraph
// that ends on its work maps relevance to the proof sentence, which names the
// responsibility.
function planOf(domain, { stock = false, form = 0, owing = 1, relevanceOf = null } = {}) {
  return {
    paragraphs: [null, ...domain.proofs.map((proof, index) => {
      const states = index < owing;
      const relevance = relevanceOf ? relevanceOf(proof, index) : (states ? statementOf(proof, { stock, form }) : proof.proof);
      return { claim: proof.claim, proof: proof.proof, relevance, jobNeedQuote: proof.quote };
    }), null].map(mapping => ({ argumentMapping: mapping })),
  };
}

const gate = (domain, paragraphs, plan) => checkParagraphArgumentLinks({ plan, paragraphs, jobText: domain.posting });
const detailOf = check => `${check.id}: ${check.detail}`;
const failedIds = checks => checks.filter(check => !check.passed).map(check => check.id);
const battery = (domain, paragraphs, extra = {}) => evaluateCoverLetterChecks({
  plan: { mappings: [{}], companyHook: { detail: '' } }, paragraphs, evidence: {}, jobText: domain.posting, researchText: '', companyName: '',
  paragraphCitations: paragraphs.map(() => []), ...extra,
});
const UNRELATED_POSTING = 'Teach weekend pottery classes to adult beginners in the community studio.';

export default [
  {
    name: 'Relevance owed: only the first proof-bearing paragraph owes a sentence about the target, counted by one function over the letter in order, and the count flips with the letter (A/B/C, three domains)',
    run() {
      assert(MAX_EXPLICIT_TRANSFER_PARAGRAPHS === 1, `the design names one paragraph (got ${MAX_EXPLICIT_TRANSFER_PARAGRAPHS})`);
      for (const domain of DOMAINS) {
        const letter = letterOf(domain);
        // A: opening and closing make no claim of their own; the first proof owes it, the next two do not.
        const owed = explicitTransferOwed(letter);
        assert(owed.join() === 'false,true,false,false,false', `${domain.key}/A: only the first proof-bearing paragraph owes it (${owed})`);
        // B: make the opening proof-bearing and the obligation moves onto it.
        const withProofOpening = [`${domain.proofs[0].proof} ${domain.opening}`, ...letter.slice(1)];
        assert(explicitTransferOwed(withProofOpening).join() === 'true,false,false,false,false', `${domain.key}/B: a proof-bearing opening takes the slot (${explicitTransferOwed(withProofOpening)})`);
        // C: take the proof out of the first proof paragraph (its verb leaves the closed list) and the obligation moves one paragraph later.
        const verbOutside = letter.map((paragraph, index) => (index === 1 ? paragraph.replace(/\bI (built|wrote|created)\b/u, 'I kept') : paragraph));
        assert(verbOutside[1] !== letter[1] && explicitTransferOwed(verbOutside).join() === 'false,false,true,false,false',
          `${domain.key}/C: a paragraph whose action is outside the closed list is not counted, so the next one owes (${explicitTransferOwed(verbOutside)})`);
        assert(explicitTransferOwed([]).length === 0 && explicitTransferOwed(null).length === 0, `${domain.key}: a missing letter owes nothing`);
      }
    },
  },
  {
    name: 'Relevance natural wording: a sentence apart from the proof that shares two content words with the cited quote satisfies the gate in any wording, no modal, no stock frame, no shared noun (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const first = domain.proofs[0];
        // A: every natural form passes, and none of them is a stock frame, so the budget reads them as nothing.
        first.natural.forEach((statement, form) => {
          assert(!/\b(?:would|can|could|will)\b/iu.test(statement), `${domain.key}: the fixture sentence ${form} uses no modal (${statement})`);
          const letter = letterOf(domain, { form });
          const verdict = gate(domain, letter, planOf(domain, { form }));
          assert(verdict.passed, `${domain.key}/A: natural form ${form} passes the gate (${detailOf(verdict)})`);
          const budget = checkTransferCarrierBudget(letter);
          assert(budget.passed && budget.detail.startsWith('0 of 5 paragraph(s) carry a stock transfer frame'), `${domain.key}/A: natural form ${form} is no stock frame (${detailOf(budget)})`);
          assert(!paragraphArgumentSpanGaps(letter[1], domain.posting, { owesTransfer: true }).length, `${domain.key}/A: the drafting-stage reporter sees a legal span in natural form ${form}`);
        });
        // The stock frame is accepted as well: it is one wording among all of them, not a requirement.
        const stockVerdict = gate(domain, letterOf(domain, { stock: true }), planOf(domain, { stock: true }));
        assert(stockVerdict.passed, `${domain.key}: a stock frame still passes (${detailOf(stockVerdict)})`);
        // B: flip the sentence to one that names nothing of the cited need (it shares no content word with the quote) and the gate refuses,
        // with the eligible terms listed so the repair is learnable.
        const aside = 'Staff birthdays were celebrated on the last Friday of each month.';
        const asideLetter = letterOf(domain).map((paragraph, index) => (index === 1 ? `${first.claim} ${first.proof} ${aside}` : paragraph));
        const unnamed = gate(domain, asideLetter, planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? aside : proof.proof) }));
        assert(!unnamed.passed && /paragraph 2 argumentMapping\.relevance does not name a concrete responsibility from its jobNeedQuote\./u.test(unnamed.detail)
          && unnamed.detail.includes('eligible responsibility terms') && /Include at least two distinct eligible terms/u.test(unnamed.detail),
        `${domain.key}/B: a sentence that names nothing of the need is refused with the terms to include (${detailOf(unnamed)})`);
        // C: one shared word is not enough, two are (flip a single word of the sentence).
        const shortWord = first.quote.toLowerCase().match(/[a-z]+/gu).find(word => word.length >= 5 && word.length <= 8 && word !== 'across');
        const oneWord = `Staff celebrated ${shortWord} on the last Friday of each month.`;
        const oneWordVerdict = gate(domain, letterOf(domain).map((paragraph, index) => (index === 1 ? `${first.claim} ${first.proof} ${oneWord}` : paragraph)),
          planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? oneWord : proof.proof) }));
        assert(!oneWordVerdict.passed && /paragraph 2 argumentMapping\.relevance does not name a concrete responsibility/u.test(oneWordVerdict.detail), `${domain.key}/C: one shared word is not a statement about the need (${detailOf(oneWordVerdict)})`);
        // The wording is free of the two things the old gate demanded: a relevance span that shares NO noun with the claim or the proof passes.
        const sharedWithProof = new Set(first.proof.toLowerCase().match(/[a-z]{5,}/gu));
        const natural = first.natural.find(statement => !(statement.toLowerCase().match(/[a-z]{5,}/gu) || []).some(word => sharedWithProof.has(word)));
        if (natural) {
          const form = first.natural.indexOf(natural);
          assert(gate(domain, letterOf(domain, { form }), planOf(domain, { form })).passed, `${domain.key}: a sentence sharing no long word with the proof passes (${natural})`);
        }
      }
    },
  },
  {
    name: 'Relevance apart from the proof: a relevance span that sits inside the proof sentence, or equals it, is refused with a message that says what to do, and reaching into a second sentence repairs it (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const first = domain.proofs[0];
        // The proof sentence of this fixture names the need on its own. That is what makes it a tempting relevance span, and it is not one.
        const paragraphFor = statement => `${first.claim} ${first.proof} ${statement}`;
        const letterWith = statement => letterOf(domain).map((paragraph, index) => (index === 1 ? paragraphFor(statement) : paragraph));
        // A: the relevance equals the proof sentence.
        const equal = gate(domain, letterWith(first.ending), planOf(domain, { relevanceOf: proof => proof.proof }));
        assert(!equal.passed && /paragraph 2 argumentMapping\.proof duplicates its relevance/u.test(equal.detail), `${domain.key}/A: the proof sentence is not its own relevance (${detailOf(equal)})`);
        // B: the relevance is a part of the proof sentence. It carries the need's words and still says nothing apart from the proof.
        const inside = first.proof.replace(/^I \w+ /u, '').replace(/\.$/u, '');
        const insideVerdict = gate(domain, letterWith(first.ending), planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? inside : proof.proof) }));
        assert(!insideVerdict.passed && /paragraph 2 argumentMapping\.relevance sits inside the sentence its proof span comes from, so it restates the proof/u.test(insideVerdict.detail)
          && /with no particular phrase required/u.test(insideVerdict.detail) && /Include at least two distinct eligible terms/u.test(insideVerdict.detail),
        `${domain.key}/B: a relevance inside the proof sentence restates it, and the message asks for one sentence in the writer's own words (${detailOf(insideVerdict)})`);
        // C: flip the relevance to a span that reaches into the next sentence of the paragraph and the same paragraph passes.
        const reaching = `${first.proof.slice(-24)} ${statementOf(first)}`;
        const reachingVerdict = gate(domain, letterWith(statementOf(first)), planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? reaching : proof.proof) }));
        assert(reachingVerdict.passed, `${domain.key}/C: a span that reaches from the proof into the next sentence is judged on the part outside the proof (${detailOf(reachingVerdict)})`);
        // D: the reach has to carry the need itself. A span that reaches into an ending that names nothing of the quote is still a restatement.
        const reachingEnding = `${first.proof} ${first.ending}`;
        const reachingNothing = gate(domain, letterWith(first.ending), planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? reachingEnding : proof.proof) }));
        assert(!reachingNothing.passed && /paragraph 2 argumentMapping\.relevance reaches outside its proof's sentence, but the part outside it names no concrete responsibility/u.test(reachingNothing.detail),
          `${domain.key}/D: the part outside the proof sentence must itself name the need (${detailOf(reachingNothing)})`);
        // E: the same restating span is accepted in a paragraph that does not owe the statement.
        const later = gate(domain, letterOf(domain), planOf(domain));
        assert(later.passed, `${domain.key}/E: a later paragraph may map its relevance to its proof sentence (${detailOf(later)})`);
      }
    },
  },
  {
    name: 'Relevance refused: a generic label stays refused in the owing paragraph and in a later one, a later paragraph still has to name its need, and a stock frame in the claim is not a capability (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const first = domain.proofs[0];
        const third = domain.proofs[2];
        // A: the sentence names the need in full and calls the experience relevant: a generic label, however well it shares words.
        const label = `My experience is relevant to ${first.quote.charAt(0).toLowerCase()}${first.quote.slice(1, -1)}.`;
        const labelled = gate(domain, letterOf(domain).map((paragraph, index) => (index === 1 ? `${first.claim} ${first.proof} ${label}` : paragraph)),
          planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? label : proof.proof) }));
        assert(!labelled.passed && /paragraph 2 argumentMapping\.relevance uses a generic relevance label/u.test(labelled.detail), `${domain.key}/A: a generic label is refused (${detailOf(labelled)})`);
        // B: flip one word of the label (relevant -> sits beside the need) and the same sentence passes.
        const plain = label.replace('is relevant to', 'sits beside');
        const plainVerdict = gate(domain, letterOf(domain).map((paragraph, index) => (index === 1 ? `${first.claim} ${first.proof} ${plain}` : paragraph)),
          planOf(domain, { relevanceOf: (proof, index) => (index === 0 ? plain : proof.proof) }));
        assert(plainVerdict.passed, `${domain.key}/B: without the label the sentence passes (${detailOf(plainVerdict)})`);
        // C: the same label in a LATER paragraph is refused too.
        const genericLater = `${third.claim} ${third.proof} My experience is relevant to ${third.quote.toLowerCase().slice(0, -1)}.`;
        const genericSpan = `My experience is relevant to ${third.quote.toLowerCase().slice(0, -1)}.`;
        const laterLetter = letterOf(domain).map((paragraph, index) => (index === 3 ? genericLater : paragraph));
        const laterGeneric = gate(domain, laterLetter, planOf(domain, { relevanceOf: (proof, index) => (index === 2 ? genericSpan : (index === 0 ? statementOf(proof) : proof.proof)) }));
        assert(!laterGeneric.passed && /paragraph 4 argumentMapping\.relevance uses a generic relevance label/u.test(laterGeneric.detail), `${domain.key}/C: ${detailOf(laterGeneric)}`);
        // D: a later paragraph owes the need and not the sentence: two shared content words, flipped to one.
        const tailOfClaim = proof => proof.claim.replace(/\.$/u, '').split(' ').slice(-3).join(' ');
        const nameless = gate(domain, letterOf(domain), planOf(domain, { relevanceOf: (proof, index) => (index === 2 ? tailOfClaim(proof) : (index === 0 ? statementOf(proof) : proof.proof)) }));
        assert(!nameless.passed && /paragraph 4 argumentMapping\.relevance does not name a concrete responsibility from its jobNeedQuote/u.test(nameless.detail)
          && !/paragraph 4 argumentMapping\.relevance (?:sits inside|reaches outside)/u.test(nameless.detail), `${domain.key}/D: a later paragraph owes the need and no separate sentence (${detailOf(nameless)})`);
        // E: a stock frame is not a candidate capability, so it cannot be the claim of the paragraph that states its relevance in natural wording either.
        const frameAsClaim = gate(domain, letterOf(domain), planOf(domain));
        assert(frameAsClaim.passed, `${domain.key}: the base fixture passes`);
        const stockClaim = gate(domain, letterOf(domain, { stock: true }), { ...planOf(domain, { stock: true }), paragraphs: planOf(domain, { stock: true }).paragraphs.map((entry, index) => (index === 1
          ? { argumentMapping: { ...entry.argumentMapping, claim: first.stock } } : entry)) });
        assert(!stockClaim.passed && /paragraph 2 argumentMapping\.claim/u.test(stockClaim.detail), `${domain.key}/E: a stock frame is not a capability claim (${detailOf(stockClaim)})`);
      }
    },
  },
  {
    name: 'Relevance drafting-stage reporter: reads the same count and the same rule as the gate, asks the owing paragraph for a sentence apart from its proof and a later one only for a responsibility, and stays a subset of the gate (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const first = domain.proofs[0];
        const letter = letterOf(domain);
        const owed = explicitTransferOwed(letter);
        // A: the owing paragraph with a natural sentence has no gap; stripped to its proof and an ending that names nothing, against an unrelated posting, it has one.
        assert(paragraphArgumentSpanGaps(letter[1], domain.posting, { owesTransfer: owed[1] }).length === 0, `${domain.key}/A: a natural sentence is a legal span`);
        const proofOnly = first.proof;
        const gapsProofOnly = paragraphArgumentSpanGaps(proofOnly, domain.posting, { owesTransfer: true }).filter(gap => gap.field === 'relevance');
        assert(gapsProofOnly.length === 1 && gapsProofOnly[0].rule === ARGUMENT_RELEVANCE_SPAN_RULE,
          `${domain.key}/A: a paragraph that owes the sentence and has nothing apart from its proof is reported under the owing rule (${JSON.stringify(gapsProofOnly.map(gap => gap.field))})`);
        // The same paragraph is NOT reported when it does not owe the sentence: its proof sentence names the need.
        assert(!paragraphArgumentSpanGaps(proofOnly, domain.posting, { owesTransfer: false }).some(gap => gap.field === 'relevance'), `${domain.key}/A: a later paragraph owes no sentence apart from its proof`);
        // Flip: add one sentence that names the need and the same paragraph owes nothing more.
        assert(!paragraphArgumentSpanGaps(`${proofOnly} ${statementOf(first)}`, domain.posting, { owesTransfer: true }).some(gap => gap.field === 'relevance'), `${domain.key}/A: a sentence apart from the proof clears it`);
        // Without a posting copy the reporter can only ask whether a sentence stands apart from the proof, the weaker verdict and still a
        // subset of the gate: a lone proof sentence is reported, a paragraph with a second sentence is not, and a later paragraph owes none.
        const relevanceGap = (paragraphText, options) => paragraphArgumentSpanGaps(paragraphText, '', options).some(gap => gap.field === 'relevance');
        assert(relevanceGap(proofOnly, { owesTransfer: true }) && !relevanceGap(`${proofOnly} ${first.ending}`, { owesTransfer: true }) && !relevanceGap(proofOnly, { owesTransfer: false }),
          `${domain.key}/A: with no posting the reporter still sees that a lone proof sentence has nothing apart from it`);
        // The part OUTSIDE the proof sentence is what is judged: here the proof sentence itself names the need, and the only other sentence
        // names nothing of it, so the owing paragraph is reported while a paragraph that does not owe the sentence is not.
        const quiet = `My quiet practice grew over many years. ${first.proof}`;
        assert(paragraphArgumentSpanGaps(quiet, domain.posting, { owesTransfer: true }).some(gap => gap.field === 'relevance')
          && !paragraphArgumentSpanGaps(quiet, domain.posting, { owesTransfer: false }).some(gap => gap.field === 'relevance'),
        `${domain.key}/A: words in the proof sentence do not stand for a sentence about the target`);
        // B: flip the posting to one that shares nothing with the paragraph and both are reported, each under its own rule.
        const owingNoNeed = paragraphArgumentSpanGaps(letter[1], UNRELATED_POSTING, { owesTransfer: true });
        const laterNoNeed = paragraphArgumentSpanGaps(letter[3], UNRELATED_POSTING, { owesTransfer: false });
        assert(owingNoNeed.length === 1 && owingNoNeed[0].rule === ARGUMENT_RELEVANCE_SPAN_RULE && laterNoNeed.length === 1 && laterNoNeed[0].rule === ARGUMENT_LATER_RELEVANCE_SPAN_RULE,
          `${domain.key}/B: with nothing in common with the posting each paragraph is reported under its own rule (${JSON.stringify([owingNoNeed, laterNoNeed].map(gaps => gaps.map(gap => gap.field)))})`);
        // C: the subset relation. Whenever the reporter says a paragraph has no relevance span, the gate, given the strongest mapping the
        // paragraph could offer (every word run as the relevance, the whole posting as the quote), reports the relevance field too.
        letter.forEach((paragraph, index) => {
          if (index === 0 || index === letter.length - 1) { assert(paragraphArgumentSpanGaps(paragraph, domain.posting).length === 0, `${domain.key}: an opening and a closing owe nothing`); return; }
          const proof = domain.proofs[index - 1];
          for (const postingText of [domain.posting, UNRELATED_POSTING]) {
            const quietClaim = 'My quiet practice grew over many years.';
            for (const { candidate, claim } of [
              { candidate: paragraph, claim: proof.claim },
              { candidate: `${proof.claim} ${proof.proof}`, claim: proof.claim },
              { candidate: `${proof.claim} ${proof.proof} ${proof.ending}`, claim: proof.claim },
              // the proof sentence names the need and nothing apart from it does
              { candidate: `${quietClaim} ${proof.proof}`, claim: quietClaim },
            ]) {
              const gaps = paragraphArgumentSpanGaps(candidate, postingText, { owesTransfer: owed[index] });
              if (!gaps.some(gap => gap.field === 'relevance')) continue;
              const words = candidate.split(/\s+/u);
              for (let start = 0; start < words.length; start += 1) {
                for (let end = start + 1; end <= words.length; end += 1) {
                  // The whole posting is the strongest quote there is: every content word of it is eligible.
                  const verdict = checkParagraphArgumentLinks({
                    plan: { paragraphs: [{ argumentMapping: { claim, proof: proof.proof, relevance: words.slice(start, end).join(' '), jobNeedQuote: postingText } }] },
                    paragraphs: [candidate], jobText: postingText,
                  });
                  assert(!verdict.passed, `${domain.key}/C: the reporter's relevance gap is real in the gate (owed=${owed[index]}, relevance=${words.slice(start, end).join(' ')}): ${detailOf(verdict)}`);
                }
              }
            }
          }
        });
        // And a paragraph the gate maps is not reported.
        assert(gate(domain, letter, planOf(domain)).passed && letter.slice(1, -1).every((paragraph, at) => !paragraphArgumentSpanGaps(paragraph, domain.posting, { owesTransfer: owed[at + 1] }).length),
          `${domain.key}: a paragraph the gate maps is not reported`);
      }
    },
  },
  {
    name: 'Transfer budget: transfer-carrier-budget counts stock frames only, allows one paragraph to carry one, names the paragraphs and the repair, and clears when one carrier goes (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        // A: one stock frame passes, and so does a letter with none.
        const within = checkTransferCarrierBudget(letterOf(domain, { stock: true }));
        assert(within.passed && within.id === 'transfer-carrier-budget' && within.detail.includes('1 of 5 paragraph(s) carry a stock transfer frame, within the budget of 1'), `${domain.key}/A: ${detailOf(within)}`);
        assert(checkTransferCarrierBudget(letterOf(domain)).passed, `${domain.key}/A: a letter with no frame passes`);
        // B: give the second proof a stock frame too and the letter is over the budget of ONE.
        const over = letterOf(domain, { stock: true, owing: 2 });
        const failed = checkTransferCarrierBudget(over);
        assert(!failed.passed && failed.detail.includes('paragraphs 2 and 3 carry a stock transfer frame')
          && failed.detail.includes('at most 1 paragraph,') && failed.detail.includes('end paragraph 3 on what the work did')
          && failed.detail.includes('paragraph 3 sentence 3') && failed.detail.includes('none is required'),
        `${domain.key}/B: the message names the paragraphs, the ceiling and where the carrier sits (${failed.detail})`);
        // The message names the repair, never a string to copy: no carrier verb, no example sentence, no em dash.
        const message = failed.detail.replace(/\bparagraphs? \d+(?:, \d+)*(?: and \d+)?(?: sentence \d+)?/gu, '');
        for (const copied of ['I would', 'I can', 'would support', 'would help', 'apply', 'bring', 'contribute', 'for example', 'e.g.', 'such as']) {
          assert(!message.includes(copied), `${domain.key}/B: the message hands over no wording (“${copied}” in ${failed.detail})`);
        }
        assert(!failed.detail.includes(String.fromCharCode(0x2014)), `${domain.key}: no em dash`);
        // C: the repair the message prescribes, applied mechanically (the named sentence removed), clears the check.
        const named = /paragraph (\d+) sentence (\d+)/u.exec(failed.detail);
        const repaired = over.map((paragraph, index) => (index + 1 === Number(named[1])
          ? sentences(paragraph).filter((_, position) => position + 1 !== Number(named[2])).join(' ') : paragraph));
        assert(repaired[Number(named[1]) - 1] !== over[Number(named[1]) - 1] && checkTransferCarrierBudget(repaired).passed, `${domain.key}/C: removing the named carrier clears it`);
        // The check is about how many paragraphs carry one, not which: the opening counts, and so does the closing.
        const openingCarries = [`${domain.opening} I would bring that approach to this work.`, ...letterOf(domain, { stock: true }).slice(1)];
        const opening = checkTransferCarrierBudget(openingCarries);
        assert(!opening.passed && opening.detail.includes('paragraph 1 sentence 2') && /end paragraphs? 1 on what the work did/u.test(opening.detail),
          `${domain.key}: a carrier in the opening counts against the budget (${opening.detail})`);
        const closingCarries = [...letterOf(domain, { stock: true }).slice(0, -1), `${domain.closing} That practice would help your team.`];
        const closing = checkTransferCarrierBudget(closingCarries);
        assert(!closing.passed && closing.detail.includes('paragraphs 2 and 5 carry a stock transfer frame') && closing.detail.includes('end paragraph 5 on what the work did'),
          `${domain.key}: a carrier in the closing counts too (${closing.detail})`);
        // The two cue shapes that end on the target alone are not transfer forms, so a letter full of them is inside the budget.
        const targetOnly = [domain.opening, ...domain.proofs.map(proof => `${proof.claim} ${proof.proof} Helping this role keep the work steady is the aim.`), domain.closing];
        assert(checkTransferCarrierBudget(targetOnly).passed, `${domain.key}: a target-only carrier costs nothing`);
        // Paragraphs are counted once however many carriers one holds.
        const twoInOne = [domain.opening, `${domain.proofs[0].claim} ${domain.proofs[0].proof} ${domain.proofs[0].stock} ${domain.proofs[1].stock}`, paragraphOf(domain.proofs[2]), domain.closing];
        assert(checkTransferCarrierBudget(twoInOne).passed, `${domain.key}: two carriers in one paragraph are one paragraph`);
        // Natural wording is never counted, however many paragraphs state their relevance that way (the repeats are policed by wording, below).
        assert(checkTransferCarrierBudget(letterOf(domain, { owing: 3 })).passed, `${domain.key}: natural sentences in every proof paragraph are no stock frame`);
      }
    },
  },
  {
    name: 'Repeated wording: one stock form in neighbouring paragraphs is still reported without a closed list to move to, and a natural sentence repeated across paragraphs is reported by the phrase and shape checks (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        // A: two stock frames in two paragraphs: the budget and the form check both report, and the message names no list.
        const letter = letterOf(domain, { stock: true, owing: 2 });
        const sameForm = letter.map((paragraph, index) => (index === 2 ? paragraph.replace(domain.proofs[1].stock, domain.proofs[0].stock.replace(/that [a-z]+ practice/u, 'that practice')) : paragraph));
        const repeated = checkRepeatedTransferCarrier(sameForm);
        assert(!repeated.passed && repeated.id === 'repeated-transfer-carrier' && checkTransferCarrierBudget(sameForm).passed === false,
          `${domain.key}/A: one form twice in a row is reported (${detailOf(repeated)})`);
        assert(repeated.detail.includes('in your own wording') && repeated.detail.includes('no stock transfer form is required')
          && !/the argument rule accepts|a different transfer form|rule accepts/u.test(repeated.detail),
        `${domain.key}/A: the repair is the writer's own wording, never a different member of a closed list (${repeated.detail})`);
        // B: put the second paragraph's relevance into natural wording and both reports go.
        const reworded = sameForm.map((paragraph, index) => (index === 2 ? paragraphOf(domain.proofs[1], { statement: domain.proofs[1].natural[0] }) : paragraph));
        assert(checkRepeatedTransferCarrier(reworded).passed && checkTransferCarrierBudget(reworded).passed,
          `${domain.key}/B: the writer's own wording clears the form check and the budget`);
        // C: the same NATURAL sentence in two paragraphs is not a stock frame, and the phrase check reports it anyway.
        const sentence = domain.proofs[0].natural[0];
        const echoed = [domain.opening, paragraphOf(domain.proofs[0], { statement: sentence }), paragraphOf(domain.proofs[1], { statement: sentence }), paragraphOf(domain.proofs[2]), domain.closing];
        const echoChecks = battery(domain, echoed);
        const phrase = echoChecks.find(check => check.id === 'repeated-phrase');
        assert(!phrase.passed && phrase.detail.includes('across paragraphs'), `${domain.key}/C: the same wording across paragraphs is reported (${detailOf(phrase)})`);
        // D: flip the second sentence to its own wording and the repeat is gone.
        const varied = echoed.map((paragraph, index) => (index === 2 ? paragraphOf(domain.proofs[1], { statement: domain.proofs[1].natural[0] }) : paragraph));
        assert(battery(domain, varied).find(check => check.id === 'repeated-phrase').passed, `${domain.key}/D: different wording is not a repeat`);
      }
    },
  },
  {
    name: 'Transfer benefit: a closed benefit word in ANY sentence of a proof-bearing paragraph that states no action of its own needs the proof sentences or the cited quotes to attest its class, so a natural-wording relevance sentence cannot smuggle a benefit in (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const { benefit } = domain;
        const proof = domain.proofs[0];
        const base = [domain.opening, `${proof.claim} ${proof.proof} ${benefit.sentence}`, domain.closing];
        const citations = [[], [benefit.quote], []];
        assert(!/\b(?:i would|i can)\b/iu.test(benefit.sentence), `${domain.key}: the benefit sentence is natural wording, with no stock frame`);
        // A: neither the proof sentence nor the quote states the benefit class, and the sentence carries no stock frame.
        const unsupported = checkTransferBenefitSupport(base, { citations, jobText: domain.posting });
        assert(!unsupported.passed && unsupported.id === 'transfer-benefit-support'
          && unsupported.detail.includes(`paragraph 2 sentence 3 puts “${benefit.word}” in a sentence that states no action of yours`)
          && unsupported.detail.includes(`a benefit of the ${benefit.className} class`)
          && unsupported.detail.includes('the proof’s own terms are'), `${domain.key}/A: ${unsupported.detail}`);
        // The proof's own terms, and nothing the writer could paste back as a replacement.
        const terms = (unsupported.detail.split('the proof’s own terms are ')[1] || '').match(/“[^”]+”/gu) || [];
        assert(terms.length >= 3 && terms.length <= 8, `${domain.key}: it lists a bounded set of the proof's own terms (${terms})`);
        assert(!/instead|replace|try|rephrase|such as/u.test(unsupported.detail), `${domain.key}: it offers no replacement wording (${unsupported.detail})`);
        // The same unsupported claim is also caught by the whole battery, so the sentence cannot reach a frozen letter.
        assert(failedIds(battery(domain, base, { paragraphCitations: citations })).includes('transfer-benefit-support'), `${domain.key}: the whole battery reports it`);
        // B: a related word of the same class in the proof sentence attests it ...
        const attestedByProof = checkTransferBenefitSupport([domain.opening, `${proof.claim} ${benefit.attestingProof} ${benefit.sentence}`, domain.closing], { citations, jobText: domain.posting });
        assert(attestedByProof.passed, `${domain.key}/B: the proof states the class (${detailOf(attestedByProof)})`);
        // ... and so does a cited quote.
        const attestedByQuote = checkTransferBenefitSupport(base, { citations: [[], [benefit.attestingQuote], []], jobText: domain.posting });
        assert(attestedByQuote.passed, `${domain.key}/B: a cited quote states the class (${detailOf(attestedByQuote)})`);
        // C: a proof that states a DIFFERENT class does not attest this one.
        const otherClass = checkTransferBenefitSupport([domain.opening, `${proof.claim} ${benefit.otherClassProof} ${benefit.sentence}`, domain.closing], { citations, jobText: domain.posting });
        assert(!otherClass.passed, `${domain.key}/C: another class does not attest it (${detailOf(otherClass)})`);
        // D: a quote cited by ANOTHER paragraph attests nothing here.
        const otherParagraphQuote = checkTransferBenefitSupport(base, { citations: [[benefit.attestingQuote], [benefit.quote], [benefit.attestingQuote]], jobText: domain.posting });
        assert(!otherParagraphQuote.passed, `${domain.key}/D: only the quotes this paragraph cites count`);
        // E: the sentence that carries the proof is not read, so the same word there is not reported.
        const inProof = checkTransferBenefitSupport([domain.opening, `${proof.claim} ${proof.proof.replace(/\.$/u, '')} and kept the calendar ${benefit.word} for staff. ${proof.natural[0]}`, domain.closing], { citations, jobText: domain.posting });
        assert(inProof.passed, `${domain.key}/E: a benefit word in a proof sentence attests and is not itself read (${detailOf(inProof)})`);
        // F: an opening and a closing carry no proof, so they are not read.
        const closingBenefit = checkTransferBenefitSupport([`${domain.opening} ${benefit.sentence}`, domain.closing], { citations: [[], []], jobText: domain.posting });
        assert(closingBenefit.passed, `${domain.key}/F: a paragraph with no proof of its own is not read`);
        // G: without the cited quotes the check cannot know what they attest, so it stays silent rather than guess.
        assert(checkTransferBenefitSupport(base, { jobText: domain.posting }).passed && checkTransferBenefitSupport(base, { citations: [[]], jobText: domain.posting }).passed,
          `${domain.key}/G: missing or misaligned citations are silent`);
        // H: a stock-frame sentence is read exactly as before.
        const stockClaim = `I would apply that practice so the work stays ${benefit.word}.`;
        const stock = checkTransferBenefitSupport([domain.opening, `${proof.claim} ${proof.proof} ${stockClaim}`, domain.closing], { citations, jobText: domain.posting });
        assert(!stock.passed && stock.detail.includes(`“${benefit.word}”`), `${domain.key}/H: a stock frame carrying the benefit is still reported (${detailOf(stock)})`);
      }
    },
  },
  {
    name: 'Transfer benefit: the posting\'s own name for a responsibility is not a claim, in the slot a stock frame applies the work to and in a two-word run the posting itself contains, and the same word anywhere else is a claim (A/B/C, three domains)',
    run() {
      for (const domain of DOMAINS) {
        const { benefit } = domain;
        const proof = domain.proofs[0];
        const citations = [[], [benefit.quote], []];
        // Natural wording. A: the sentence echoes a two-word run the posting contains, so the benefit word names the responsibility.
        const posting = `${domain.posting} The role keeps ${benefit.run}.`;
        const echoLetter = [domain.opening, `${proof.claim} ${proof.proof} ${benefit.echoSentence}`, domain.closing];
        assert(checkTransferBenefitSupport(echoLetter, { citations, jobText: posting }).passed, `${domain.key}/A: the posting's own run names a responsibility, it is not a claim`);
        // B: flip the posting (it no longer contains the run) and the same sentence is reported.
        const unstated = checkTransferBenefitSupport(echoLetter, { citations, jobText: domain.posting });
        assert(!unstated.passed && unstated.detail.includes(`“${benefit.word}”`), `${domain.key}/B: without the posting stating it, the word is a claim (${unstated.detail})`);
        // C: flip the position: the same word beside different neighbours is a claim even though the posting states the run elsewhere.
        const moved = [domain.opening, `${proof.claim} ${proof.proof} Your clinics need steady days, and the work will keep every desk ${benefit.word} for them.`, domain.closing];
        const movedCheck = checkTransferBenefitSupport(moved, { citations, jobText: posting });
        assert(!movedCheck.passed && movedCheck.detail.includes(`“${benefit.word}”`), `${domain.key}/C: beside other words it is a claim (${movedCheck.detail})`);
        // The stock-frame slot, unchanged: the word the posting states is free after "to", and a claim anywhere else in the frame.
        const slotPosting = `${domain.posting} The role needs ${benefit.word} work every shift.`;
        const slot = `I would apply that practice to the ${benefit.word} work this role needs.`;
        const slotLetter = [domain.opening, `${proof.claim} ${proof.proof} ${slot}`, domain.closing];
        assert(checkTransferBenefitSupport(slotLetter, { citations, jobText: slotPosting }).passed, `${domain.key}/slot A: the posting's own word for the responsibility is free in the slot`);
        const slotUnstated = checkTransferBenefitSupport(slotLetter, { citations, jobText: domain.posting });
        assert(!slotUnstated.passed && slotUnstated.detail.includes(`“${benefit.word}”`), `${domain.key}/slot B: without the posting stating it, the word is a claim (${slotUnstated.detail})`);
        const outside = [domain.opening, `${proof.claim} ${proof.proof} I would apply that practice to the work this role needs so it stays ${benefit.word}.`, domain.closing];
        const outsideCheck = checkTransferBenefitSupport(outside, { citations, jobText: slotPosting });
        assert(!outsideCheck.passed && outsideCheck.detail.includes(`“${benefit.word}”`), `${domain.key}/slot C: outside the responsibility slot it is a claim (${outsideCheck.detail})`);
      }
    },
  },
  {
    name: 'Transfer benefit: the lexicon is a closed set of whole words in named classes, claimed words are attested by their own class, and a hyphenated compound is read as its parts',
    run() {
      assert(TRANSFER_BENEFIT_CLASS_NAMES.join() === TRANSFER_BENEFIT_CLASSES.map(benefit => benefit.name).join()
        && ['availability', 'reliability', 'resilience', 'scalability', 'performance', 'cost', 'security', 'accuracy'].every(name => TRANSFER_BENEFIT_CLASS_NAMES.includes(name)),
      'the classes the design names are all present');
      const claimedOwner = new Map();
      for (const benefit of TRANSFER_BENEFIT_CLASSES) {
        assert(benefit.claimed.length >= 2 && benefit.claimed.every(word => /^[a-z]+$/u.test(word)), `${benefit.name}: claimed words are lowercase whole words`);
        for (const word of benefit.claimed) {
          assert(!claimedOwner.has(word), `“${word}” is claimed by two classes (${claimedOwner.get(word)}, ${benefit.name})`);
          claimedOwner.set(word, benefit.name);
        }
        assert(benefit.attested.every(word => /^[a-z]+$/u.test(word)), `${benefit.name}: attesting words are lowercase whole words`);
      }
      // A claimed word of every class is reported in a sentence with no attestation, and attested by itself in the proof.
      const proofSentence = 'I built a tracking sheet that grouped every request by owner.';
      for (const benefit of TRANSFER_BENEFIT_CLASSES) {
        const word = benefit.claimed[0];
        const letter = ['The role needs steady work.', `My tracking practice grew from the desk. ${proofSentence} Tracking at that level gives better ${word} across the team.`];
        const unsupported = checkTransferBenefitSupport(letter, { citations: [[], []], jobText: '' });
        assert(!unsupported.passed && unsupported.detail.includes(`“${word}”`) && unsupported.detail.includes(`${benefit.name} class`), `${benefit.name}: “${word}” is reported (${unsupported.detail})`);
        const attested = checkTransferBenefitSupport(letter, { citations: [[], [`Built a tracking sheet and watched ${benefit.attested[0] || word} for every request.`]], jobText: '' });
        assert(attested.passed, `${benefit.name}: a quote that states the class passes (${detailOf(attested)})`);
      }
      const compound = checkTransferBenefitSupport(['The role needs steady work.', `My tracking practice grew from the desk. ${proofSentence} Tracking at that level gives fault-tolerant request handling.`], { citations: [[], []], jobText: '' });
      assert(!compound.passed && compound.detail.includes('“tolerant”') && compound.detail.includes('resilience class'), `a hyphenated compound is read as its parts (${compound.detail})`);
      const plain = checkTransferBenefitSupport(['The role needs steady work.', `My tracking practice grew from the desk. ${proofSentence} Tracking at that level suits the request handling this role needs.`], { citations: [[], []], jobText: '' });
      assert(plain.passed, 'a sentence that names the responsibility and no benefit is not reported');
    },
  },
  {
    name: 'Transfer budget: both checks are in the battery and the prose-unit table, in the order they were appended, the budget of one is enforced by the whole battery, and the whole battery reports them (A/B/C)',
    run() {
      for (const domain of DOMAINS) {
        const twoFrames = letterOf(domain, { stock: true, owing: 2 });
        const checks = battery(domain, twoFrames);
        assert(checks.slice(-2).map(check => check.id).join() === 'transfer-carrier-budget,transfer-benefit-support', `${domain.key}: both are the last two checks (${checks.slice(-2).map(check => check.id)})`);
        assert(failedIds(checks).includes('transfer-carrier-budget'), `${domain.key}/A: a letter with two stock frames fails the budget of one in the whole battery`);
        const fixed = battery(domain, letterOf(domain, { stock: true }));
        assert(!failedIds(fixed).includes('transfer-carrier-budget'), `${domain.key}/B: the same letter with the second frame removed clears it`);
        const natural = battery(domain, letterOf(domain, { owing: 3 }));
        assert(!failedIds(natural).includes('transfer-carrier-budget') && !failedIds(natural).includes('transfer-benefit-support'), `${domain.key}/C: natural sentences are inside both`);
      }
      assert(PASTE_CHECK_PROSE_UNITS['transfer-carrier-budget'] === 'prose-unit' && PASTE_CHECK_PROSE_UNITS['transfer-benefit-support'] === 'prose-unit', 'both are scoped to the prose unit a repair rewrites');
      const reportable = pasteReportableCheckIds();
      assert(reportable.includes('transfer-carrier-budget') && reportable.includes('transfer-benefit-support'), 'both are reportable ids of the paste pipeline');
    },
  },
  {
    name: 'Relevance contract: every printed rule, prompt and document says the new thing and none still asks for a stock transfer in every proof paragraph (A/B/C)',
    run() {
      const read = relative => fs.readFileSync(path.resolve(relative), 'utf8').replace(/\s+/gu, ' ');
      // A: the printed rules read the budget from the constant and ask for no phrase.
      for (const rule of [ARGUMENT_RELEVANCE_SPAN_RULE, EXPLICIT_TRANSFER_BUDGET_RULE]) {
        assert(rule.includes('the first proof-bearing paragraph of the letter'), `the printed rule names the one paragraph that owes it (${rule.slice(0, 160)})`);
      }
      assert(/in the writer's own words/u.test(ARGUMENT_RELEVANCE_SPAN_RULE) && /other than the sentence the proof span sits in/u.test(ARGUMENT_RELEVANCE_SPAN_RULE)
        && /needs no stock phrase, no would or can/u.test(ARGUMENT_RELEVANCE_SPAN_RULE), 'the relevance rule asks for the writer\'s own words and demands no phrase');
      assert(!/I would apply|I can apply|apply, bring, use or contribute that/u.test(ARGUMENT_RELEVANCE_SPAN_RULE) && !/shared word|mechanism/u.test(ARGUMENT_RELEVANCE_SPAN_RULE),
        'the relevance rule no longer enumerates frames or asks for a shared word');
      assert(EXPLICIT_TRANSFER_BUDGET_RULE.includes('at most 1 of the letter\'s paragraphs') && /ends on what the work did/u.test(EXPLICIT_TRANSFER_BUDGET_RULE) && /no paragraph needs it/u.test(EXPLICIT_TRANSFER_BUDGET_RULE),
        'the budget rule states the ceiling, the ending and that no frame is required');
      assert(TRANSFER_BENEFIT_SUPPORT_RULE.includes('states no action of yours') && /posting’s own name for a responsibility is not a claim/u.test(TRANSFER_BENEFIT_SUPPORT_RULE), 'the benefit rule reads every sentence of the paragraph');
      // B: the documents say it in words.
      const routine = read('local_ai/LOCAL_AI_APPLICATION_ROUTINE.md');
      const pasteBack = read('local_ai/PASTE_BACK_APPLICATION.md');
      assert(/Pick the two or three strongest proofs/u.test(routine) && /first proof-bearing paragraph/u.test(routine) && /own natural wording/u.test(routine), 'the Local AI routine states the new contract');
      assert(/first proof-bearing paragraph/u.test(pasteBack) && /own (?:natural )?wording/u.test(pasteBack), 'the paste-back guide states the new contract');
      for (const doc of ['Job Application Design System/STYLE.md', 'Job Application Design System/SKILL.md']) {
        assert(/Pick the two or three strongest proofs/u.test(read(doc)) && /own natural wording/u.test(read(doc)) && /at most one paragraph of a letter/u.test(read(doc)), `${doc} states the new contract`);
      }
      // C: no document or printed rule still demands a transfer in the first two, or in every, proof paragraph, or an explicit bridge.
      const stale = /first two proof-bearing paragraphs|mandates a carrier|explicit transfer(?: sentence)? in (?:each|every)|(?:each|every) proof-bearing paragraph (?:can carry|carries|must carry|owes)|in an explicit transfer sentence|Explicit transfer to target responsibility|at most two paragraphs of a letter|accepts either shape/u;
      for (const [label, text] of [['routine', routine], ['paste-back', pasteBack], ['relevance rule', ARGUMENT_RELEVANCE_SPAN_RULE], ['budget rule', EXPLICIT_TRANSFER_BUDGET_RULE],
        ['STYLE', read('Job Application Design System/STYLE.md')], ['SKILL', read('Job Application Design System/SKILL.md')]]) {
        assert(!stale.test(text), `${label}: no text asks for the old transfer contract (${(stale.exec(text) || [''])[0]})`);
      }
    },
  },
];
